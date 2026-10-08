'use strict';

/**
 * Startup dialogs: a screen an engine draws before its prompt, that a launch
 * must not type into.
 *
 * Claude Code asks "do you trust this folder?" the first time it opens a
 * repository, and the option under its cursor is "No, exit". A launch that
 * pastes its prime, or sends any line ending in Enter, while that is on screen
 * confirms the default: the engine exits, the pane dies, and the session reads
 * `crashed` with nothing to say why (#2128).
 *
 * This module is the seeing half. An engine profile declares the dialogs it can
 * show (`capabilities.startupDialogs`), each with the text that identifies it
 * and the code a blocker is recorded under. `watch` reads the pane during boot
 * and answers one of four things: a declared dialog is up, the engine reached
 * its prompt, the pane is gone, or the window passed without either. What a
 * launch does with the answer is the caller's.
 *
 * What it deliberately does not do:
 * - **It never types.** Answering a trust dialog is accepting the folder's
 *   hooks, MCP servers and permission rules on the operator's behalf. That is
 *   the operator's decision, so the dialog is reported and left alone.
 * - **It never guesses a dialog.** Only declared text matches, and only when
 *   every marker of an entry is on screen. A screen it does not recognise is
 *   "undecided", and at the end of the window the launch proceeds as it did
 *   before this module existed, so an unknown screen cannot fail a healthy
 *   launch. One unknown screen is the exception: a row led by the engine's
 *   prompt glyph that is not its composer at rest. That is a menu's selected
 *   option, or typed text, and a launch's own sends are withheld from it under
 *   a code that names no dialog (`withholdFor`).
 * - **It never takes a glyph for a prompt.** A selector draws its selected
 *   option with the engine's prompt glyph. Only the composer at rest is
 *   positive evidence (`_promptRow`).
 * - **It reads no engine state file.** The pane is the one source.
 *
 * @module lib/startup-dialog
 */

const { createLogger } = require('./logger');

const log = createLogger('startup-dialog');

/**
 * How long the boot watch looks for a dialog or a prompt before letting the
 * launch proceed unobserved. Claude Code drew its trust dialog 6 to 9 seconds
 * after launch on a loaded host; the bound leaves room for a much slower boot,
 * and its cost is paid only by a launch whose prompt is never recognised. It is
 * a bound on looking, not a gate on a positive at-rest reading: when it passes,
 * the launch types as it did before boot was watched, and each send takes one
 * last look of its own (`check`).
 * @type {number}
 */
const BOOT_WINDOW_MS = 45_000;

/** How often the boot watch reads the pane. @type {number} */
const BOOT_POLL_MS = 500;

/**
 * How long a dialog that is up is waited on for the operator to answer it.
 * Past this the launch's typed sends stay withheld for good and the blocker
 * stays on the session; the operator can still answer the dialog and type.
 * @type {number}
 */
const ANSWER_WINDOW_MS = 15 * 60_000;

/** How often a dialog that is up is re-read. @type {number} */
const ANSWER_POLL_MS = 2000;

/** How many pane rows each read covers: a dialog is drawn at the top of a fresh pane. @type {number} */
const CAPTURE_LINES = 80;

/**
 * The code a launch send is refused under when the pane's last glyph-led row
 * is not the engine's composer at rest. It names no dialog, because none was
 * recognised.
 * @type {string}
 */
const NOT_AT_PROMPT = 'pane_not_at_prompt';

/**
 * The code a launch send is refused under when the startup-dialog declaration
 * that applies to its engine profile could not be read.
 * @type {string}
 */
const DECLARATION_UNREADABLE = 'startup_dialogs_unreadable';

/** Consecutive identical readings of a prompt with no dialog text before boot counts as clear. @type {number} */
const CLEAR_TICKS_REQUIRED = 2;

/**
 * What each `watch` outcome means, keyed by the code it returns.
 * @type {Record<string, string>}
 */
const OUTCOME_MEANINGS = Object.freeze({
  'undeclared': 'the engine declares no startup dialogs, so its pane was not watched',
  'unreadable': 'the engine\'s startup-dialog declaration could not be read, so a dialog it was written for cannot be recognised and its pane was not watched',
  'unprofiled': 'startup dialogs are declared for this engine but no measured prompt signature exists for its profile or its command, so a finished boot cannot be told from a dialog and its pane was not watched',
  'clear': 'the engine reached its prompt with no declared dialog on screen',
  'answered': 'a declared dialog was up, and the engine then reached its prompt',
  'unanswered': 'a declared dialog was still up when the wait for an answer ended',
  'pane-gone': 'the pane ended while it was being watched',
  'timeout': 'neither a declared dialog nor the engine\'s prompt was recognised within the boot window'
});

/**
 * Whether a value is a non-empty string.
 * @param {*} value - Anything
 * @returns {boolean}
 */
function _isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Why a declared dialog entry is unusable, or an empty list when it is sound.
 * @param {*} entry - One element of `capabilities.startupDialogs`
 * @returns {string[]}
 */
function entryErrors(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['is not an object'];
  const errors = [];
  if (!_isText(entry.code) || !/^[a-z][a-z0-9_]*$/.test(entry.code)) errors.push('`code` must be a lower_snake_case string');
  if (!_isText(entry.label)) errors.push('`label` must be a non-empty string');
  if (!_isText(entry.meaning)) errors.push('`meaning` must be a non-empty string');
  if (!Array.isArray(entry.markers) || entry.markers.length === 0 || !entry.markers.every(_isText)) {
    errors.push('`markers` must be a non-empty list of non-empty strings');
  }
  return errors;
}

/**
 * The sound entries of one profile's own `startupDialogs` list.
 * @param {object} engineProfile - Engine profile whose own list is read
 * @param {Array<*>} list - Its `capabilities.startupDialogs`
 * @returns {Array<{code: string, label: string, meaning: string, markers: string[]}>}
 */
function _sound(engineProfile, list) {
  const sound = [];
  for (const entry of list) {
    const errors = entryErrors(entry);
    if (errors.length) {
      // Not matched on, and not forgotten either: `unreadable` reports the
      // same entry, and a launch types nothing while one stands.
      log.warn('An engine declares a startup dialog that cannot be read; a launch on this profile types nothing until it is fixed', {
        engine: engineProfile.id || null, code: (entry && entry.code) || null, errors
      });
      continue;
    }
    sound.push({ code: entry.code, label: entry.label, meaning: entry.meaning, markers: entry.markers.slice() });
  }
  return sound;
}

/**
 * What is wrong with one profile's OWN `startupDialogs` declaration.
 *
 * A declaration that is present and cannot be read is not the same as one that
 * is absent, and it is the opposite of an empty one. `[]` is how a profile
 * says its program shows no dialogs; a list with a mistyped entry was written
 * to name a dialog this module can now no longer see. Reading the second as
 * the first would launch unwatched into exactly the screen the entry was for.
 * @param {object|null} profile - An engine profile
 * @returns {Array<{profile: (string|null), entry: (number|null), errors: string[]}>}
 *   One element per unreadable entry (`entry` is its position, from 1), or one
 *   with `entry: null` when the value is present and not a list; empty when
 *   the declaration is absent, empty, or sound
 */
function _ownProblems(profile) {
  const caps = profile && profile.capabilities;
  if (!caps || caps.startupDialogs === undefined) return [];
  const id = profile.id || null;
  if (!Array.isArray(caps.startupDialogs)) return [{ profile: id, entry: null, errors: ['`startupDialogs` must be a list (use [] to declare none)'] }];
  const problems = [];
  caps.startupDialogs.forEach((entry, i) => {
    const errors = entryErrors(entry);
    if (errors.length) problems.push({ profile: id, entry: i + 1, errors });
  });
  return problems;
}

/** @type {Map<string, {dialogs: Array<object>, sourceId: string, problems: Array<object>}>|null} Declared dialogs, the profile that declares them, and what in its declaration could not be read, keyed by engine command. Only a table built from a list that was read is kept here. */
let _byCommand = null;

/**
 * The dialogs declared for each engine COMMAND, from every installed profile.
 *
 * A dialog belongs to the program that draws it, not to the profile that
 * launches it. An operator's own profile for the same program (a second Claude
 * Code profile pinned to another model, say) is a copy made before this field
 * existed, and the bundled-profile sync never touches it, so read by profile
 * alone it would launch into the same dialog unprotected. The first failures
 * this module answers were on exactly such a profile.
 *
 * Built lazily and memoised like the wake table, for the same reason: the
 * store is initialised after every module is loaded, so an empty list means
 * "not ready yet" and is not cached.
 * @returns {Map<string, {dialogs: Array<object>, sourceId: string, problems: Array<object>}>}
 */
function _declaredByCommand() {
  if (_byCommand) return _byCommand;
  let profiles;
  try {
    profiles = _internal.engineProfiles();
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- the launch must not fail on the lookup; the failure is carried in the answer, and every reader of an inherited declaration treats it as unreadable
    log.warn('Engine profiles could not be read while resolving startup dialogs by command', { error: err.message });
    return _unresolved(`the installed engine profiles could not be read (${err.message || 'no reason given'})`);
  }
  // A caller only asks on behalf of a profile, so at least one is installed.
  // An empty list is therefore a store that is not ready or did not answer,
  // not a host with no profiles, and it is not cached.
  if (!profiles || !profiles.length) return _unresolved('the installed engine profiles came back empty');
  const table = new Map();
  // The profile named after its command first, so the program's canonical
  // profile wins over a variant that happens to sort ahead of it.
  const ordered = profiles.slice().sort((x, y) => Number(y.id === y.command) - Number(x.id === x.command));
  for (const profile of ordered) {
    const own = profile && profile.capabilities && profile.capabilities.startupDialogs;
    if (!profile.command || own === undefined || table.has(profile.command)) continue;
    const sound = Array.isArray(own) ? _sound(profile, own) : [];
    // A declaration that could not be read stands for the command as much as
    // a sound one does: a profile that inherits it inherits the refusal.
    const problems = _ownProblems(profile);
    if (sound.length || problems.length) table.set(profile.command, { dialogs: sound, sourceId: profile.id, problems });
  }
  table.fault = null;
  _byCommand = table;
  return table;
}

/**
 * The by-command table for a lookup that failed: no entries, and the reason.
 *
 * Not cached, so the next asker tries again and a store that recovers is
 * believed at once. **It is not an empty table.** "Nothing is declared for this
 * command" and "what is declared could not be found out" are different
 * answers, and `resolve` turns the second into an unreadable declaration:
 * a profile that takes its dialogs from its program has lost them, and a
 * launch on it must type nothing until they can be read again.
 * @param {string} fault - Why the installed profiles could not be consulted
 * @returns {Map<string, object>} An empty map carrying `fault`
 */
function _unresolved(fault) {
  const table = new Map();
  table.fault = fault;
  return table;
}

/**
 * Everything this module knows about one engine profile, found out ONCE.
 *
 * The answer to "what applies to this profile" has three parts: the dialogs,
 * what in the declaration could not be read, and the prompt signature. They
 * come from the same lookup, and that lookup can fail and then recover between
 * two calls. Asked separately, one part can come from the failed lookup and
 * the next from the recovered one: `declared` empty and `unreadable` empty
 * together, which reads as "nothing declared, nothing wrong" and lets a launch
 * type. So an operation that decides anything (one `check`, one `watch`, one
 * launch deciding whether to watch) takes ONE of these and reads every part
 * from it. `declared`, `unreadable` and `promptSignatureFor` each return one
 * part of a snapshot of their own, for callers that need only that part.
 *
 * - A profile's own `capabilities.startupDialogs` is the answer when it has
 *   one, an empty list included: that is how a profile says its program shows
 *   none. Its unreadable entries are its problems.
 * - A profile with none of its own takes what is declared for the command it
 *   runs (see `_declaredByCommand`), problems included.
 * - When that lookup failed, a profile that inherits has ONE problem, the
 *   failure, and no dialogs: what it inherits could not be found out, which is
 *   not the same as nothing. A profile with a declaration of its own does not
 *   depend on the lookup for its dialogs.
 *
 * @param {object|null} engineProfile - Engine profile
 * @returns {{dialogs: Array<{code: string, label: string, meaning: string, markers: string[]}>,
 *   problems: Array<{profile: (string|null), entry: (number|null), errors: string[]}>,
 *   wake: (object|null)}} `wake` is the prompt signature (see `promptSignatureFor`)
 */
function resolve(engineProfile) {
  if (!engineProfile) return { dialogs: [], problems: [], wake: null };
  const caps = engineProfile.capabilities;
  const own = caps ? caps.startupDialogs : undefined;
  const command = engineProfile.command || null;
  // The one lookup. Every part below is read from this table and no other.
  const table = command ? _declaredByCommand() : null;
  const forCommand = table && !table.fault ? (table.get(command) || null) : null;
  const copy = (list) => list.map((d) => ({ ...d, markers: d.markers.slice() }));

  let dialogs = [];
  let problems = [];
  if (own !== undefined) {
    problems = _ownProblems(engineProfile);
    // A value that is not a list protects later sends with its program's
    // dialogs where those are known; the launch is refused either way.
    dialogs = Array.isArray(own) ? _sound(engineProfile, own) : copy((forCommand && forCommand.dialogs) || []);
  } else if (command && table.fault) {
    problems = [{
      profile: engineProfile.id || null,
      entry: null,
      errors: [`the startup dialogs declared for its command "${command}" could not be looked up: ${table.fault}`]
    }];
  } else if (forCommand) {
    dialogs = copy(forCommand.dialogs);
    problems = forCommand.problems.map((x) => ({ ...x, errors: x.errors.slice() }));
  }

  const wakeTable = _internal.wakeProfiles() || {};
  const usable = (wake) => !!(wake && wake.promptRe instanceof RegExp && wake.promptGlyph);
  const ownWake = wakeTable[engineProfile.id];
  const sharedWake = forCommand ? wakeTable[forCommand.sourceId] : null;
  const wake = usable(ownWake) ? ownWake : (usable(sharedWake) ? sharedWake : null);
  return { dialogs, problems, wake };
}

/**
 * The startup dialogs that apply to an engine profile, malformed entries dropped.
 *
 * A profile's own `capabilities.startupDialogs` list is the answer when it has
 * one, an empty list included: that is how a profile says its program shows
 * none. A profile with no list of its own takes the dialogs declared for the
 * command it runs (see `_declaredByCommand`).
 *
 * A malformed entry is dropped rather than repaired: a dialog matched on
 * guessed text is the hazard this module exists to avoid.
 * @param {object|null} engineProfile - Engine profile
 * @returns {Array<{code: string, label: string, meaning: string, markers: string[]}>}
 */
function declared(engineProfile) {
  return resolve(engineProfile).dialogs;
}

/**
 * What in the startup-dialog declaration that applies to a profile could not
 * be read: the profile's own when it has one, else the one declared for the
 * command it runs.
 *
 * While this is not empty a launch on the profile types nothing (`watch`
 * answers `unreadable`, and `withholdFor` refuses a launch send), whatever the
 * pane shows. Only a literal `[]` opts a profile out.
 *
 * A profile that inherits is also reported here when the installed profiles
 * could not be consulted at all (the list threw, or came back empty): what it
 * inherits could not be found out, which is not the same as nothing. That
 * answer is not remembered, so it clears by itself when the list reads again.
 * A profile with a declaration of its own, `[]` included, does not depend on
 * the list and is unaffected.
 * @param {object|null} engineProfile - Engine profile
 * @returns {Array<{profile: (string|null), entry: (number|null), errors: string[]}>}
 */
function unreadable(engineProfile) {
  return resolve(engineProfile).problems;
}

/**
 * One sentence naming the profile and each entry of an unreadable declaration.
 * @param {Array<{profile: (string|null), entry: (number|null), errors: string[]}>} problems - From `unreadable`
 * @returns {string}
 */
function describeUnreadable(problems) {
  const where = (x) => (x.entry === null ? 'its declaration' : `entry ${x.entry}`);
  const parts = problems.map((x) => `${where(x)}: ${x.errors.join('; ')}`);
  const profile = (problems[0] && problems[0].profile) || 'this engine';
  return `engine profile "${profile}" declares startup dialogs TangleClaw could not read (${parts.join(' | ')}). `
    + 'Fix the declaration in the engine profile, or set "startupDialogs": [] to declare none';
}

/**
 * The prompt signature a profile's pane can be read against: its wake profile,
 * with the measured pattern for the engine's BARE composer row.
 *
 * A profile's own measured `wake` block is the answer when it has one. A
 * profile without one takes the wake profile of the profile that declares the
 * dialogs for the command it runs: the prompt, like the dialog, belongs to the
 * program, and that profile's signature is measured, with evidence. What is
 * inherited is the whole signature (the composer pattern, the glyph, the pad
 * and the suggestion styling), never the glyph alone. This is what lets an
 * operator's second profile for the same program be watched through its boot
 * and positively cleared afterwards.
 *
 * It is never guessed. With no measured composer pattern for the profile or
 * its command, this answers null, and nothing can then be read as a prompt:
 * a glyph alone is not one, because a selector draws its selected option with
 * the same glyph.
 * @param {object|null} engineProfile - Engine profile
 * @returns {object|null} A wake profile carrying `promptRe`, or null
 */
function promptSignatureFor(engineProfile) {
  return resolve(engineProfile).wake;
}

/**
 * Forget the by-command table, so the next read rebuilds it. For tests, and for
 * a store that has been pointed somewhere else.
 * @returns {void}
 */
function reset() {
  _byCommand = null;
}

/**
 * Pane rows as one plain string: styling removed, runs of blanks collapsed.
 *
 * An engine colours a dialog word by word, so a marker is only findable once
 * the escape sequences between its words are gone. Blanks are collapsed because
 * a non-breaking space or a doubled space between two words is a rendering
 * detail, not a different dialog.
 * @param {string[]} lines - Captured pane rows
 * @returns {string}
 */
function _plain(lines) {
  const strip = require('./medusa-wake')._strip;
  return strip((lines || []).join('\n')).replace(/[ \t ]+/g, ' ');
}

/**
 * A marker with its blanks collapsed the way `_plain` collapses the pane's.
 * @param {string} marker - Declared marker text
 * @returns {string}
 */
function _norm(marker) {
  return marker.replace(/[ \t\u00a0]+/g, ' ');
}

/**
 * Where the engine's prompt glyph leads a captured row, and whether the LAST
 * such row is the engine's composer at rest: the only thing this module
 * accepts as positive evidence that a pane is at its prompt.
 *
 * **A row led by the prompt glyph is NOT that.** A selector, in a dialog or a
 * menu, draws its SELECTED option with the same glyph. Counting any glyph-led
 * row as a prompt read "❯ 2. Yes, I accept" as the composer, and a send's
 * Enter could then have confirmed that option.
 *
 * **Only the last glyph-led row is judged**, and every piece of evidence must
 * be about that one row. A session's transcript shows earlier turns under the
 * same glyph, and an old composer can sit above a menu drawn later, so an
 * earlier row that happens to be bare proves nothing about what is at the
 * bottom now. The other way round is the answered case: a menu left in the
 * history above a fresh composer is history.
 *
 * Two readings of that row count:
 *
 * 1. **Bare.** It matches the engine's measured bare-composer pattern
 *    (`promptRe`: the glyph and at most its one pad cell), and the row
 *    directly beneath it is not text. That second half is for an option whose
 *    label wrapped onto the next row, leaving the glyph alone on its own.
 *
 * 2. **Empty, showing the engine's suggestion.** A fresh composer draws a
 *    faint suggestion after the glyph, so it is not bare, and its text alone
 *    cannot be told from typed input or from an option label. It counts only
 *    when ALL of these hold:
 *    - the terminal cursor is on this row (its row is matched by text, because
 *      a capture can start in the scrollback or lose blank rows at its top,
 *      so the cursor's row number has no origin in common with these indices);
 *    - the cursor is SHOWN (`cursor.visible === true`, tmux's `cursor_flag`):
 *      an engine shows it in its input line and hides it while a selector is
 *      up. A flag tmux did not report is not "shown";
 *    - `medusa-wake`'s `_composerEmpty` says so from the cursor's own styled
 *      row: the cursor rests at the first input column after the glyph and
 *      everything to its right is drawn in the engine's suggestion styling;
 *    - the row is inside the composer's box: a border row directly above it
 *      and one directly below. `_composerEmpty` alone would pass an option
 *      label that happened to be painted faint; a row of a list of two or
 *      more options cannot have a border on both sides.
 *    With no cursor reading, no visibility flag, no styling, or no box, this
 *    reading does not apply and only the bare one can.
 *
 *    Measured on Claude Code 2.1.283 (2026-10-07): the fresh composer sits
 *    between two border rows with the cursor shown at the glyph's column plus
 *    two; on the folder trust dialog and on the `/model` selector the cursor
 *    is hidden and parked ON the selected row's glyph, no border adjoins the
 *    row, and no option text is faint.
 *
 * A composer holding typed text is neither reading, and is deliberately not
 * counted: its text cannot be told from an option row's.
 *
 * @param {string[]} lines - Captured pane rows
 * @param {object|null} wake - From `promptSignatureFor`; null means no reading
 * @param {{x: number, line: string, visible: (boolean|null)}|null} [cursor] - `tmux.cursorInfo` result, when the caller has one
 * @returns {{last: number, composer: boolean, draft: boolean, key: string}} `last` is the
 *   index of the last glyph-led row, -1 when there is none or no signature to
 *   read by; `composer` is whether that row is the composer at rest; `draft`
 *   is whether it is positively the composer HOLDING TYPED TEXT (the same
 *   shown cursor, same row and same box, with the cursor reading saying
 *   "input", which is never positive evidence that the pane is at rest); `key`
 *   holds everything the answer rested on (the row, its neighbours, the
 *   cursor), so two readings can be compared for "nothing moved"
 */
function _promptRow(lines, wake, cursor = null) {
  if (!wake || !(wake.promptRe instanceof RegExp) || !wake.promptGlyph) return { last: -1, composer: false, draft: false, key: '' };
  const medusaWake = require('./medusa-wake');
  const rows = (lines || []).map((row) => medusaWake._strip(String(row)));
  let last = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].trimStart().startsWith(wake.promptGlyph)) { last = i; break; }
  }
  if (last === -1) return { last, composer: false, draft: false, key: '' };
  const above = last > 0 ? rows[last - 1] : null;
  const below = last + 1 < rows.length ? rows[last + 1] : null;
  const key = JSON.stringify([above, rows[last], below, cursor ? [cursor.x, cursor.line, cursor.visible] : null]);
  if (wake.promptRe.test(rows[last])) {
    const textBelow = below !== null && below.trim() !== '' && !medusaWake._isDivider(below);
    return { last, composer: !textBelow, draft: false, key };
  }
  const onCursorRow = !!cursor && typeof cursor.line === 'string'
    && medusaWake._strip(cursor.line).trimEnd() === rows[last].trimEnd();
  const boxed = above !== null && below !== null && medusaWake._isDivider(above) && medusaWake._isDivider(below);
  const shown = !!cursor && cursor.visible === true;
  const located = onCursorRow && shown && boxed;
  const empty = located ? _internal.composerEmpty(cursor, wake) : null;
  return { last, composer: empty === true, draft: empty === false, key };
}

/**
 * The index of the last captured row carrying any marker of the given dialogs,
 * or -1 when none does.
 * @param {string[]} plainRows - Rows from `_plain(lines).split('\n')`
 * @param {Array<{markers: string[]}>} dialogs - Declared dialogs
 * @returns {number}
 */
function _lastMarkerRow(plainRows, dialogs) {
  for (let i = plainRows.length - 1; i >= 0; i--) {
    if (dialogs.some((d) => d.markers.some((m) => plainRows[i].includes(_norm(m))))) return i;
  }
  return -1;
}

/**
 * Which declared dialog is on screen, if any.
 *
 * Two conditions, both required:
 *
 * 1. EVERY marker of the entry is present. One marker alone can be ordinary
 *    text ("No, exit" is also an option of a different dialog), and a
 *    half-drawn frame must not read as a match.
 * 2. No row led by the prompt glyph sits below the dialog's last marker. A
 *    session that is merely TALKING about a dialog (a transcript quoting it, a
 *    tool printing it), or that answered one whose text is still in the
 *    captured history, has its composer drawn underneath; the dialog itself is
 *    the last thing on screen, and its selected option, the only glyph-led row
 *    it draws, is one of its markers. This says only "not this dialog now": it
 *    is NOT a finding that the pane is safe, which is `classify`'s to make,
 *    and a glyph-led row that is not the composer at rest still withholds
 *    every sender there. Without a measured prompt signature this condition
 *    cannot be tested and the answer rests on the markers alone.
 *
 * @param {string[]} lines - Captured pane rows
 * @param {Array<{code: string, label: string, meaning: string, markers: string[]}>} dialogs - From `declared`
 * @param {object|null} [wake] - From `promptSignatureFor`
 * @param {object|null} [cursor] - `tmux.cursorInfo` result, when the caller has one
 * @returns {{code: string, label: string, meaning: string}|null}
 */
function detect(lines, dialogs, wake = null, cursor = null) {
  if (!dialogs || !dialogs.length) return null;
  const rows = _plain(lines).split('\n');
  const text = rows.join('\n');
  const prompt = _promptRow(lines, wake, cursor);
  for (const d of dialogs) {
    const markers = d.markers.map(_norm);
    if (!markers.every((m) => text.includes(m))) continue;
    if (prompt.last > _lastMarkerRow(rows, [d])) continue;
    return { code: d.code, label: d.label, meaning: d.meaning };
  }
  return null;
}

/**
 * One reading of a booting pane.
 *
 * - `dialog`: a declared dialog is on screen (see `detect`).
 * - `clear`: the engine's composer is on screen (see `_promptRow`) and NO
 *   marker of any declared dialog is. "No marker at all" is stricter than "no
 *   dialog" on purpose: before any dialog has been seen, dialog text on a
 *   fresh pane is a dialog on its way, and a fresh pane has no transcript to
 *   quote one from, so the strictness costs a booting session nothing.
 * - `undecided`: anything else, including a pane that has drawn nothing yet,
 *   and a selector or menu, whose selected option is led by the prompt glyph
 *   but is not the composer.
 *
 * @param {string[]} lines - Captured pane rows
 * @param {Array<object>} dialogs - From `declared`
 * @param {object|null} wake - From `promptSignatureFor`
 * @param {object|null} [cursor] - `tmux.cursorInfo` result, when the caller has one
 * @returns {{state: 'dialog'|'clear'|'undecided', dialog?: object, key?: string}} `key` is
 *   what a `clear` rested on (see `_promptRow`)
 */
function assessBoot(lines, dialogs, wake, cursor = null) {
  const hit = detect(lines, dialogs, wake, cursor);
  if (hit) return { state: 'dialog', dialog: hit };
  const prompt = _promptRow(lines, wake, cursor);
  if (_lastMarkerRow(_plain(lines).split('\n'), dialogs) !== -1) return { state: 'undecided', key: prompt.key };
  return { state: prompt.composer ? 'clear' : 'undecided', key: prompt.key };
}

/**
 * What one captured frame shows, by the rule every look AFTER boot uses.
 *
 * - `dialog`: a declared dialog is on screen (see `detect`).
 * - `clear`: the engine's composer at rest (see `_promptRow`) is the last
 *   glyph-led row and sits BELOW the last row carrying a declared marker, or
 *   anywhere when no marker is on screen. It is positive evidence only there:
 *   a composer left ABOVE a dialog that is being drawn says nothing about the
 *   dialog, while the composer of a session that is merely quoting one, or has
 *   answered one whose text is still in the captured history, sits underneath
 *   it. With no measured prompt signature nothing is positive evidence and
 *   this is never `clear`.
 * - `noncomposer`: the last glyph-led row is NOT the composer at rest, and
 *   either no declared marker is on screen, or the row is below every marker
 *   and is positively the composer holding typed text (shown cursor on it,
 *   between its two border rows). The first is a selected option of a menu
 *   this module has no declaration for, or typed text; the two cannot be told
 *   apart by their text. The second is a transcript quoting a dialog above an
 *   operator's draft. It names no dialog.
 * - `partial`: a declared marker is on screen with neither the composer at
 *   rest nor a located draft below it, short of a full dialog. A dialog
 *   half-drawn is this, and so is another screen that shares one of its
 *   option texts with a row of its own selected below it (`1. No, exit` above
 *   `❯ 2. Yes, I accept`). It names the entry the marker belongs to, and it
 *   withholds EVERY sender.
 * - `unknown`: no dialog, no marker and no glyph-led row at all.
 * - `empty`: the capture holds no text at all.
 *
 * The one-read `check` and the watch's answer stage both judge by this, so a
 * frame cannot be clear to one and not to the other.
 * @param {string[]} lines - Captured pane rows
 * @param {Array<{code: string, label: string, meaning: string, markers: string[]}>} dialogs - From `declared`
 * @param {object|null} wake - From `promptSignatureFor`, or null when none is measured
 * @param {object|null} [cursor] - `tmux.cursorInfo` result, when the caller has one
 * @returns {{state: 'dialog'|'clear'|'noncomposer'|'partial'|'unknown'|'empty', dialog?: object, partial?: object, key?: string}}
 *   `key` is what a `clear` or `noncomposer` rested on (see `_promptRow`)
 */
function classify(lines, dialogs, wake, cursor = null) {
  const text = _plain(lines);
  if (!text.trim()) return { state: 'empty' };
  const dialog = detect(lines, dialogs, wake, cursor);
  if (dialog) return { state: 'dialog', dialog };
  const lastMarker = _lastMarkerRow(text.split('\n'), dialogs);
  const prompt = _promptRow(lines, wake, cursor);
  if (prompt.composer && prompt.last > lastMarker) return { state: 'clear', key: prompt.key };
  if (lastMarker === -1) return prompt.last === -1 ? { state: 'unknown' } : { state: 'noncomposer', key: prompt.key };
  // Marker words above a composer that is positively located and holds typed
  // text are a transcript, not a live dialog: the selected option of a screen
  // that shares a marker has no shown cursor and no box.
  if (prompt.draft && prompt.last > lastMarker) return { state: 'noncomposer', key: prompt.key };
  const owner = dialogs.find((d) => d.markers.some((m) => text.includes(_norm(m))));
  return { state: 'partial', partial: { code: owner.code, label: owner.label, meaning: owner.meaning } };
}

/**
 * Is a declared startup dialog on this pane right now?
 *
 * The question a sender asks immediately before it types, and the one the
 * stored blocker is checked against: the boot watch covers a launch's own
 * first sends, and this covers every later look, whoever makes it.
 *
 * Four answers, because "no dialog was matched" is not "the dialog is gone":
 *
 * - `dialog`: a declared dialog is on screen.
 * - `clear: true`: the pane was read, it shows the engine's prompt, and it
 *   shows no dialog. Only this is evidence that a dialog has been answered.
 * - `noncomposer: true`: the last row led by the prompt glyph is not the
 *   composer at rest. A menu this module has no declaration for draws its
 *   selected option that way, and so does a composer holding typed text.
 * - none of those: the pane says nothing either way. It could not be read
 *   (`unread` carries why, and a read that came back EMPTY counts: tmux's
 *   reader answers a failed capture with no lines rather than an error), or it
 *   shows neither a dialog nor a prompt.
 *
 * A frame caught while a dialog is being drawn shows some of its text and not
 * all of it. That is read once more after a short settle rather than taken as
 * "no dialog": the caller is about to type an Enter into it. A frame that still
 * carries a declared marker with no prompt beneath it after that re-read is
 * reported as `suspect`, naming the entry the marker belongs to. It is not a
 * confirmed dialog, so it is not recorded as one, but a sender must not type
 * into it: the cost of withholding one send is small, and the cost of
 * confirming "No, exit" is the session.
 *
 * @param {string} tmuxName - The tmux session to read
 * @param {object|null} engineProfile - The engine's profile
 * @returns {{declared: boolean, dialog: (object|null), suspect: (object|null), clear: boolean, noncomposer: boolean, unread: (string|null), promptKnown: boolean, unreadable: (string|null)}}
 *   `unreadable` is the sentence from `describeUnreadable` when the declaration
 *   that applies to the profile could not be read, else null.
 *   `promptKnown` is false when no measured prompt signature exists for the
 *   profile or its command, in which case `clear` can never be true.
 */
function check(tmuxName, engineProfile) {
  // One snapshot for this look: the dialogs, the problems and the prompt
  // signature are never mixed from two lookups (see `resolve`).
  const { dialogs, problems, wake } = resolve(engineProfile);
  const undeclarable = problems.length ? describeUnreadable(problems) : null;
  if (!dialogs.length) return { declared: false, dialog: null, suspect: null, clear: false, noncomposer: false, unread: null, promptKnown: false, unreadable: undeclarable };
  const promptKnown = wake !== null;

  /**
   * One read of the pane.
   * @returns {{unread: (string|null), dialog: (object|null), clear: boolean, noncomposer: boolean, partial: (object|null)}}
   */
  const look = () => {
    let lines;
    try {
      lines = (_internal.capturePaneSync(tmuxName, { lines: CAPTURE_LINES }) || {}).lines || [];
    } catch (err) {
      // prawduct:allow prawduct/broad-except -- the caller is about to type and must be told the pane was not read, not stopped by the read
      return { unread: err.message, dialog: null, clear: false, noncomposer: false, partial: null };
    }
    let seen = classify(lines, dialogs, wake, null);
    // The cursor is read only when it can change the answer: a glyph-led row
    // that is not the bare composer may be the composer showing its faint
    // suggestion, or holding a draft under quoted dialog text, which only the
    // cursor can tell from a selected option. A cursor
    // that cannot be read leaves the answer as it stood, which is the less
    // clear one.
    if (wake && (seen.state === 'noncomposer' || seen.state === 'dialog' || seen.state === 'partial')) {
      let cursor = null;
      try {
        cursor = _internal.cursorInfoSync(tmuxName);
      } catch {
        // prawduct:allow prawduct/broad-except -- an unreadable cursor is "no cursor reading", which can only leave the answer less clear, never more
        cursor = null;
      }
      if (cursor) seen = classify(lines, dialogs, wake, cursor);
    }
    if (seen.state === 'empty') return { unread: 'the pane read came back empty', dialog: null, clear: false, noncomposer: false, partial: null };
    return {
      unread: null, dialog: seen.dialog || null, clear: seen.state === 'clear',
      noncomposer: seen.state === 'noncomposer', partial: seen.partial || null
    };
  };

  const first = look();
  if (!first.partial) {
    return { declared: true, dialog: first.dialog, suspect: null, clear: first.clear, noncomposer: first.noncomposer, unread: first.unread, promptKnown, unreadable: undeclarable };
  }
  _internal.settleSync();
  const second = look();
  // The re-read decides only when it could see the pane. One that came back
  // unread or empty resolves nothing, and the first frame's marker is still the
  // last thing known about the pane, so it goes on withholding.
  const suspect = second.partial || (second.unread ? first.partial : null);
  return { declared: true, dialog: second.dialog, suspect, clear: second.clear, noncomposer: second.noncomposer, unread: second.unread, promptKnown, unreadable: undeclarable };
}

/**
 * What, if anything, a send must not be typed over, from one `check` answer and
 * the blocker already stored for the session.
 *
 * THE one statement of this decision. Every sender asks it: the injection path
 * through the session's reconcile, and the pane writer underneath it. Written
 * out separately in each of those, the same table drifted, and each drift was
 * a way to type into a dialog.
 *
 * The rule: **a send goes ahead only on positive evidence, or when nothing
 * stands against it.**
 * - A dialog on the pane withholds.
 * - A startup-dialog declaration that could not be read withholds a LAUNCH
 *   send, whatever the pane shows: the entry that was lost names a dialog
 *   nothing can recognise now. Later injections are judged by the entries
 *   that could be read.
 * - A positive reading (the prompt, below any dialog text) withholds nothing.
 * - Otherwise a stored blocker withholds, whatever the reason the read fell
 *   short: the pane could not be checked or read, it shows neither the dialog
 *   nor the prompt, or the engine's profile no longer declares the dialog (in
 *   which case nothing can positively clear it, and it stands until the
 *   session ends or the declaration returns).
 * - With no blocker stored, a suspect frame (part of a declared dialog, no
 *   prompt beneath it) still withholds.
 * - With no blocker stored, a pane whose last glyph-led row is not the
 *   composer at rest (`seen.noncomposer`) withholds a LAUNCH send
 *   (`opts.launchSend`), under a code that names no dialog. That row is the
 *   selected option of a menu nothing declares, or typed text, and a launch
 *   has no business typing over either: the boot watch gives up on a menu it
 *   cannot name, and without this its sends would follow. A later injection is
 *   not withheld on this reading alone: it keeps an operator's draft and then
 *   clears it (`tmux._clearPromptLine`), which is how a stranded nudge is
 *   recovered, and refusing here would end that.
 * - A screen with no dialog text and no glyph-led row at all withholds
 *   nothing: an unrecognised screen must not cost a healthy launch its prime.
 * - When the stored blocker could not be READ, it is not assumed absent: only a
 *   positive reading lets the send through.
 *
 * @param {{declared: boolean, dialog: (object|null), suspect: (object|null), clear: boolean, unread: (string|null)}|null} seen -
 *   A `check` answer, or null when the check itself could not be made
 * @param {{code: string, label: string, meaning: string}|null} stored - The session's stored launch blocker
 * @param {{storedUnknown?: (string|null), launchSend?: boolean}} [opts] - `storedUnknown` is the reason the
 *   stored blocker could not be READ (a store error). It is a different fact from
 *   a successful read that found none, which is `stored: null` with no option.
 *   `launchSend` marks one of a launch's own sends (pre-keys, prime, kickoff).
 * @returns {{code: string, label: (string|null), meaning: string, why: string}|null}
 *   `label` is null for `launch_blocker_unreadable`, `pane_not_at_prompt` and `startup_dialogs_unreadable`, which name no dialog.
 */
function withholdFor(seen, stored, opts = {}) {
  if (seen && seen.dialog) return { code: seen.dialog.code, label: seen.dialog.label, meaning: seen.dialog.meaning, why: 'it is on screen' };
  // Ahead of a clear reading, on purpose: the pane may look at rest and the
  // dialog the unreadable entry was written for may still be about to draw.
  if (seen && seen.unreadable && opts.launchSend) {
    return {
      code: DECLARATION_UNREADABLE,
      label: null,
      meaning: 'The launch\'s own text was not sent and is not retried; start the session by typing in its pane.',
      why: `The ${seen.unreadable}`
    };
  }
  if (seen && seen.clear) return null;
  if (stored) {
    let why = 'its pane shows neither that dialog nor the engine\'s prompt';
    if (!seen) why = 'its pane could not be checked';
    else if (!seen.declared) why = 'the engine\'s profile declares no such dialog now, so its pane cannot be confirmed clear';
    else if (seen.unread) why = 'its pane could not be read';
    else if (seen.noncomposer) why = 'its pane shows a selected menu option or typed text where the engine\'s empty input line would be';
    else if (seen.promptKnown === false) {
      why = 'this engine profile has no verified prompt signature, so TangleClaw cannot confirm the dialog was answered; '
        + 'relaunch the session after approving it, or add a measured wake declaration to the profile';
    }
    return { code: stored.code, label: stored.label, meaning: stored.meaning, why };
  }
  if (seen && seen.suspect) {
    return { code: seen.suspect.code, label: seen.suspect.label, meaning: seen.suspect.meaning, why: 'part of it is on screen and it may still be drawing' };
  }
  if (seen && seen.noncomposer && opts.launchSend) {
    return {
      code: NOT_AT_PROMPT,
      label: null,
      meaning: 'Answer or dismiss what is on the pane, or empty its input line; the launch\'s own text was not sent and is not retried.',
      why: 'The last line led by the engine\'s prompt mark is not its empty input line: it is a selected menu option, or text already typed there'
    };
  }
  // Whether a blocker is stored could not be read. That is not "none stored":
  // the record is the floor under exactly the readings that fall short here,
  // so without it only a positive reading (handled above) lets a send through.
  // The refusal says what is true, that the record could not be read, and
  // claims no dialog.
  if (opts.storedUnknown) {
    return {
      code: 'launch_blocker_unreadable',
      label: null,
      meaning: 'Retry the send. If it keeps happening, the server log names the store error.',
      why: `TangleClaw could not read whether a launch blocker is recorded for this session (${opts.storedUnknown}), `
        + 'and its pane does not positively show the engine\'s prompt'
    };
  }
  return null;
}

/**
 * The sentence a refused send carries, from a `withholdFor` answer.
 * @param {{code: string, label: (string|null), meaning: string, why: string}} withhold - What withholds the send
 * @returns {string}
 */
function refusalText(withhold) {
  if (!withhold.label) return `${withhold.code}: nothing was typed into the session. ${withhold.why}. ${withhold.meaning}`.trim();
  return `${withhold.code}: nothing was typed into the session, because of its engine's ${withhold.label} (${withhold.why}). ${withhold.meaning}`;
}

/** Seams a test replaces; production reads tmux and the wall clock. */
const _internal = {
  // The watch reads a pane twice a second for a whole boot, so it uses the
  // non-blocking reader: on a loaded host one synchronous read was measured at
  // 120 to 170 ms, which would hold the server's event loop for a quarter of
  // every launch. A sender's single look (`check`) is one read and stays
  // synchronous, because the send it guards is.
  // Resolves to the capture with the cursor read alongside it, when there is one.
  capturePane: async (name, opts) => {
    const read = await require('./tmux').readPaneAsync(name, opts);
    return { ...read.cap, cursor: read.cursor || null };
  },
  capturePaneSync: (name, opts) => require('./tmux').capturePane(name, opts),
  cursorInfoSync: (name) => require('./tmux').cursorInfo(name),
  composerEmpty: (cursor, wake) => require('./medusa-wake')._composerEmpty(cursor, wake),
  // How long a half-drawn dialog is given to finish drawing before the one re-read.
  settleSync: () => require('node:child_process').execSync('sleep 0.25'),
  probeSession: (name) => require('./tmux').probeSession(name),
  engineProfiles: () => require('./store').engines.list(),
  wakeProfiles: () => require('./medusa-wake').ENGINE_WAKE_PROFILES,
  paneDigest: (lines, wake) => require('./medusa-wake')._paneDigest(lines, wake),
  now: () => Date.now(),
  // Unref'd: a watch can run for the whole answer window, and a pending poll
  // must never be what keeps a stopping server (or a finished test) alive.
  sleep: (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t && typeof t.unref === 'function') t.unref(); })
};

/**
 * Watch a freshly launched pane until it is safe to type into, or known not to be.
 *
 * Two bounded stages. The boot stage reads the pane until a declared dialog is
 * up, the prompt is up, the pane is gone, or `bootWindowMs` passes. If a dialog
 * was seen, `onDialog` is called once and the answer stage keeps reading, more
 * slowly, until the prompt appears (the operator answered), the pane is gone
 * (they declined, or something typed), or `answerWindowMs` passes.
 *
 * Never throws and never rejects: a launch must not fail on its watch.
 *
 * @param {object} args
 * @param {string} args.tmuxName - The tmux session to read
 * @param {object} args.engineProfile - The engine's profile, for its declared dialogs
 * @param {{dialogs: Array<object>, problems: Array<object>, wake: (object|null)}} [args.resolved] - A
 *   `resolve` snapshot the caller already took for this profile; taken here when absent
 * @param {function(object): void} [args.onDialog] - Called once, when a declared
 *   dialog is first seen, with `{code, label, meaning}`
 * @param {number} [args.bootWindowMs] - Boot stage bound
 * @param {number} [args.answerWindowMs] - Answer stage bound
 * @returns {Promise<{outcome: string, meaning: string, dialog: (object|null), waitedMs: number, unreadable?: string}>}
 *   `outcome` is a key of `OUTCOME_MEANINGS`. `unreadable` names the profile
 *   and entries on that outcome. `dialog` is the dialog that was
 *   seen, on `answered`, `unanswered`, and a `pane-gone` that followed one.
 */
async function watch(args) {
  const { tmuxName, engineProfile, onDialog } = args;
  const started = _internal.now();
  const done = (outcome, dialog = null) => ({
    outcome, meaning: OUTCOME_MEANINGS[outcome], dialog, waitedMs: _internal.now() - started
  });

  // One snapshot for the whole watch, the caller's when it already took one
  // to decide to watch at all: the decision and the watch then cannot rest on
  // two different lookups (see `resolve`).
  const { dialogs, problems, wake } = args.resolved || resolve(engineProfile);
  if (problems.length) return { ...done('unreadable'), unreadable: describeUnreadable(problems) };
  if (!dialogs.length) return done('undeclared');
  if (!wake) return done('unprofiled');

  /**
   * One reading: the pane's state, or `gone` when tmux says the session ended.
   * A read that fails while the session is still there is `undecided`.
   * @returns {Promise<{state: string, dialog?: object, digest?: string}>}
   */
  const read = async (stage) => {
    let lines;
    let cursor = null;
    try {
      const cap = (await _internal.capturePane(tmuxName, { lines: CAPTURE_LINES })) || {};
      lines = cap.lines || [];
      cursor = cap.cursor || null;
    } catch {
      // prawduct:allow prawduct/broad-except -- a pane that cannot be read is asked about below, never assumed gone
      let probe = null;
      try { probe = _internal.probeSession(tmuxName); } catch { /* an unanswered probe is not a death */ }
      if (probe && probe.answered && !probe.live) return { state: 'gone' };
      return { state: 'undecided' };
    }
    // The wake monitor's digest, so "held still" means here what it means to
    // every other gate that types into a pane. That digest leaves out the
    // last glyph-led row and everything under it, and knows nothing of the
    // cursor, which is exactly what a clear reading rests on. So the reading's
    // own evidence is added (`stable`): two clear readings count as one held
    // still only if the row, its neighbours and the cursor did too.
    const digest = _internal.paneDigest(lines, wake);
    const stable = (reading) => `${digest}\u0000${reading.key || ''}`;
    // The two stages ask different questions of the same frame, on purpose.
    //
    // BOOT asks whether a dialog might still be coming. A fresh pane has no
    // history to quote a dialog from, so ANY marker text is taken as a dialog
    // on its way (`assessBoot`), and a prompt counts only with none on screen.
    //
    // ANSWER asks whether a dialog that was seen has been answered. Its text
    // can stay in the captured history after the engine moves on, so that
    // stricter rule would never see the prompt again and the launch would
    // never resume. Here the frame is judged as every later look judges it
    // (`classify`): a prompt below the last marker is the answer.
    if (stage === 'boot') {
      const boot = assessBoot(lines, dialogs, wake, cursor);
      return { ...boot, digest: stable(boot) };
    }
    const seenNow = classify(lines, dialogs, wake, cursor);
    if (seenNow.state === 'dialog') return { state: 'dialog', dialog: seenNow.dialog, digest };
    return { state: seenNow.state === 'clear' ? 'clear' : 'undecided', digest: stable(seenNow) };
  };

  // Boot stage.
  const bootDeadline = started + (args.bootWindowMs ?? BOOT_WINDOW_MS);
  let seen = null;
  let clearTicks = 0;
  let prevDigest;
  while (_internal.now() < bootDeadline) {
    const r = await read('boot');
    if (r.state === 'gone') return done('pane-gone');
    if (r.state === 'dialog') { seen = r.dialog; break; }
    // A prompt counts once it has held still: the first frame with a glyph row
    // can be one the engine is about to replace with a dialog.
    clearTicks = r.state === 'clear' ? (r.digest === prevDigest ? clearTicks + 1 : 1) : 0;
    prevDigest = r.digest;
    if (clearTicks >= CLEAR_TICKS_REQUIRED) return done('clear');
    await _internal.sleep(BOOT_POLL_MS);
  }
  if (!seen) return done('timeout');

  if (typeof onDialog === 'function') {
    try {
      onDialog(seen);
    } catch (err) {
      // prawduct:allow prawduct/broad-except -- recording the blocker must not end the watch that keeps input out of the dialog
      log.warn('Recording a startup dialog failed', { session: tmuxName, code: seen.code, error: err.message });
    }
  }

  // Answer stage.
  const answerDeadline = _internal.now() + (args.answerWindowMs ?? ANSWER_WINDOW_MS);
  clearTicks = 0;
  prevDigest = undefined;
  while (_internal.now() < answerDeadline) {
    await _internal.sleep(ANSWER_POLL_MS);
    const r = await read('answer');
    if (r.state === 'gone') return done('pane-gone', seen);
    clearTicks = r.state === 'clear' ? (r.digest === prevDigest ? clearTicks + 1 : 1) : 0;
    prevDigest = r.digest;
    if (clearTicks >= CLEAR_TICKS_REQUIRED) return done('answered', seen);
  }
  return done('unanswered', seen);
}

module.exports = {
  BOOT_WINDOW_MS,
  ANSWER_WINDOW_MS,
  OUTCOME_MEANINGS,
  NOT_AT_PROMPT,
  DECLARATION_UNREADABLE,
  resolve,
  declared,
  unreadable,
  describeUnreadable,
  reset,
  entryErrors,
  detect,
  assessBoot,
  classify,
  check,
  withholdFor,
  refusalText,
  promptSignatureFor,
  watch,
  _internal
};
