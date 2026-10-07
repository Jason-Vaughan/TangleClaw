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
 *   "undecided", and at the end of the window the launch proceeds exactly as it
 *   did before this module existed, so an unknown screen cannot fail a healthy
 *   launch.
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

/** Consecutive identical readings of a prompt with no dialog text before boot counts as clear. @type {number} */
const CLEAR_TICKS_REQUIRED = 2;

/**
 * What each `watch` outcome means, keyed by the code it returns.
 * @type {Record<string, string>}
 */
const OUTCOME_MEANINGS = Object.freeze({
  'undeclared': 'the engine declares no startup dialogs, so its pane was not watched',
  'unprofiled': 'the engine declares startup dialogs but no prompt glyph to tell a finished boot by, so its pane was not watched',
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
      log.warn('An engine declares a malformed startup dialog; it is ignored', {
        engine: engineProfile.id || null, code: (entry && entry.code) || null, errors
      });
      continue;
    }
    sound.push({ code: entry.code, label: entry.label, meaning: entry.meaning, markers: entry.markers.slice() });
  }
  return sound;
}

/** @type {Map<string, Array<object>>|null} Declared dialogs keyed by engine command, once the store has profiles. */
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
 * @returns {Map<string, Array<object>>}
 */
function _declaredByCommand() {
  if (_byCommand) return _byCommand;
  let profiles;
  try {
    profiles = _internal.engineProfiles();
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- unreadable profiles leave a profile with its own declaration only; the launch must not fail on the lookup
    log.warn('Engine profiles could not be read while resolving startup dialogs by command', { error: err.message });
    return new Map();
  }
  if (!profiles || !profiles.length) return new Map();
  const table = new Map();
  // The profile named after its command first, so the program's canonical
  // profile wins over a variant that happens to sort ahead of it.
  const ordered = profiles.slice().sort((x, y) => Number(y.id === y.command) - Number(x.id === x.command));
  for (const profile of ordered) {
    const own = profile && profile.capabilities && profile.capabilities.startupDialogs;
    if (!profile.command || !Array.isArray(own) || table.has(profile.command)) continue;
    const sound = _sound(profile, own);
    if (sound.length) table.set(profile.command, sound);
  }
  _byCommand = table;
  return table;
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
  if (!engineProfile) return [];
  const list = engineProfile.capabilities && engineProfile.capabilities.startupDialogs;
  if (Array.isArray(list)) return _sound(engineProfile, list);
  if (!engineProfile.command) return [];
  return (_declaredByCommand().get(engineProfile.command) || []).map((d) => ({ ...d, markers: d.markers.slice() }));
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
 * Which declared dialog is on screen, if any.
 *
 * Two conditions, both required:
 *
 * 1. EVERY marker of the entry is present. One marker alone can be ordinary
 *    text ("No, exit" is also an option of a different dialog), and a
 *    half-drawn frame must not read as a match.
 * 2. No prompt row sits below the dialog. A session that is merely TALKING
 *    about a dialog (a transcript quoting it, a tool printing it) has its
 *    composer drawn underneath; the dialog itself is the last thing on screen.
 *    A row led by the prompt glyph that carries a marker is the dialog's own
 *    selected option, so only a glyph row with no marker counts as a prompt.
 *    Without a glyph to look for, this condition cannot be tested and the
 *    answer rests on the markers alone.
 *
 * @param {string[]} lines - Captured pane rows
 * @param {Array<{code: string, label: string, meaning: string, markers: string[]}>} dialogs - From `declared`
 * @param {string|null} [promptGlyph] - The glyph the engine leads its prompt row with
 * @returns {{code: string, label: string, meaning: string}|null}
 */
function detect(lines, dialogs, promptGlyph = null) {
  if (!dialogs || !dialogs.length) return null;
  const rows = _plain(lines).split('\n');
  const text = rows.join('\n');
  for (const d of dialogs) {
    const markers = d.markers.map(_norm);
    if (!markers.every((m) => text.includes(m))) continue;
    let last = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (markers.some((m) => rows[i].includes(m))) { last = i; break; }
    }
    const promptBelow = !!promptGlyph && rows.slice(last + 1).some((row) => row.trimStart().startsWith(promptGlyph));
    if (promptBelow) continue;
    return { code: d.code, label: d.label, meaning: d.meaning };
  }
  return null;
}

/**
 * One reading of a booting pane.
 *
 * - `dialog`: a declared dialog is on screen (see `detect`).
 * - `clear`: a row led by the engine's prompt glyph is on screen and NO marker
 *   of any declared dialog is. "No marker at all" is stricter than "no dialog"
 *   on purpose: a dialog's selected option is drawn with the same glyph as the
 *   prompt, so a frame caught half-drawn would otherwise read as a prompt. A
 *   fresh pane has no transcript to quote a dialog from, so the strictness
 *   costs a booting session nothing.
 * - `undecided`: anything else, including a pane that has drawn nothing yet.
 *
 * @param {string[]} lines - Captured pane rows
 * @param {Array<object>} dialogs - From `declared`
 * @param {string} promptGlyph - The glyph the engine leads its prompt row with
 * @returns {{state: 'dialog'|'clear'|'undecided', dialog?: object}}
 */
function assessBoot(lines, dialogs, promptGlyph) {
  const hit = detect(lines, dialogs, promptGlyph);
  if (hit) return { state: 'dialog', dialog: hit };
  const text = _plain(lines);
  const anyMarker = dialogs.some((d) => d.markers.some((m) => text.includes(_norm(m))));
  if (anyMarker) return { state: 'undecided' };
  const glyphRow = text.split('\n').some((row) => row.trimStart().startsWith(promptGlyph));
  return glyphRow ? { state: 'clear' } : { state: 'undecided' };
}

/**
 * Is a declared startup dialog on this pane right now?
 *
 * The question a sender asks immediately before it types, and the one the
 * stored blocker is checked against: the boot watch covers a launch's own
 * first sends, and this covers every later look, whoever makes it.
 *
 * Three answers, because "no dialog was matched" is not "the dialog is gone":
 *
 * - `dialog`: a declared dialog is on screen.
 * - `clear: true`: the pane was read, it shows the engine's prompt, and it
 *   shows no dialog. Only this is evidence that a dialog has been answered.
 * - neither: the pane says nothing either way. It could not be read
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
 * @returns {{declared: boolean, dialog: (object|null), suspect: (object|null), clear: boolean, unread: (string|null)}}
 */
function check(tmuxName, engineProfile) {
  const dialogs = declared(engineProfile);
  if (!dialogs.length) return { declared: false, dialog: null, suspect: null, clear: false, unread: null };
  const wake = _internal.wakeProfiles()[engineProfile.id];
  const glyph = (wake && wake.promptGlyph) || null;

  /**
   * One read of the pane.
   * @returns {{unread: (string|null), dialog: (object|null), clear: boolean, partial: (object|null)}}
   */
  const look = () => {
    let lines;
    try {
      lines = (_internal.capturePaneSync(tmuxName, { lines: CAPTURE_LINES }) || {}).lines || [];
    } catch (err) {
      // prawduct:allow prawduct/broad-except -- the caller is about to type and must be told the pane was not read, not stopped by the read
      return { unread: err.message, dialog: null, clear: false, partial: null };
    }
    const text = _plain(lines);
    if (!text.trim()) return { unread: 'the pane read came back empty', dialog: null, clear: false, partial: null };
    const dialog = detect(lines, dialogs, glyph);
    if (dialog) return { unread: null, dialog, clear: false, partial: null };
    // With no glyph to find a prompt by, the absence of every marker is the
    // most this profile can say, and it is taken as clear.
    const state = glyph ? assessBoot(lines, dialogs, glyph).state : 'undecided';
    const anyMarker = dialogs.some((d) => d.markers.some((m) => text.includes(_norm(m))));
    // Markers on screen with a prompt row below them is a session quoting the
    // dialog: its prompt is the evidence, so that is clear, not partial.
    const promptRow = !!glyph && text.split('\n').some((row) => {
      const led = row.trimStart().startsWith(glyph);
      return led && !dialogs.some((d) => d.markers.some((m) => row.includes(_norm(m))));
    });
    const clear = glyph ? (state === 'clear' || (anyMarker && promptRow)) : !anyMarker;
    if (!anyMarker || clear) return { unread: null, dialog: null, clear, partial: null };
    const owner = dialogs.find((d) => d.markers.some((m) => text.includes(_norm(m))));
    return { unread: null, dialog: null, clear: false, partial: { code: owner.code, label: owner.label, meaning: owner.meaning } };
  };

  let seen = look();
  if (seen.partial) {
    _internal.settleSync();
    seen = look();
  }
  return { declared: true, dialog: seen.dialog, suspect: seen.partial, clear: seen.clear, unread: seen.unread };
}

/** Seams a test replaces; production reads tmux and the wall clock. */
const _internal = {
  // The watch reads a pane twice a second for a whole boot, so it uses the
  // non-blocking reader: on a loaded host one synchronous read was measured at
  // 120 to 170 ms, which would hold the server's event loop for a quarter of
  // every launch. A sender's single look (`check`) is one read and stays
  // synchronous, because the send it guards is.
  capturePane: async (name, opts) => (await require('./tmux').readPaneAsync(name, opts)).cap,
  capturePaneSync: (name, opts) => require('./tmux').capturePane(name, opts),
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
 * @param {function(object): void} [args.onDialog] - Called once, when a declared
 *   dialog is first seen, with `{code, label, meaning}`
 * @param {number} [args.bootWindowMs] - Boot stage bound
 * @param {number} [args.answerWindowMs] - Answer stage bound
 * @returns {Promise<{outcome: string, meaning: string, dialog: (object|null), waitedMs: number}>}
 *   `outcome` is a key of `OUTCOME_MEANINGS`. `dialog` is the dialog that was
 *   seen, on `answered`, `unanswered`, and a `pane-gone` that followed one.
 */
async function watch(args) {
  const { tmuxName, engineProfile, onDialog } = args;
  const started = _internal.now();
  const done = (outcome, dialog = null) => ({
    outcome, meaning: OUTCOME_MEANINGS[outcome], dialog, waitedMs: _internal.now() - started
  });

  const dialogs = declared(engineProfile);
  if (!dialogs.length) return done('undeclared');
  const wake = _internal.wakeProfiles()[engineProfile.id];
  if (!wake || !wake.promptGlyph) return done('unprofiled');

  /**
   * One reading: the pane's state, or `gone` when tmux says the session ended.
   * A read that fails while the session is still there is `undecided`.
   * @returns {Promise<{state: string, dialog?: object, digest?: string}>}
   */
  const read = async () => {
    let lines;
    try {
      lines = ((await _internal.capturePane(tmuxName, { lines: CAPTURE_LINES })) || {}).lines || [];
    } catch {
      // prawduct:allow prawduct/broad-except -- a pane that cannot be read is asked about below, never assumed gone
      let probe = null;
      try { probe = _internal.probeSession(tmuxName); } catch { /* an unanswered probe is not a death */ }
      if (probe && probe.answered && !probe.live) return { state: 'gone' };
      return { state: 'undecided' };
    }
    // The wake monitor's digest, so "held still" means here what it means to
    // every other gate that types into a pane.
    return { ...assessBoot(lines, dialogs, wake.promptGlyph), digest: _internal.paneDigest(lines, wake) };
  };

  // Boot stage.
  const bootDeadline = started + (args.bootWindowMs ?? BOOT_WINDOW_MS);
  let seen = null;
  let clearTicks = 0;
  let prevDigest;
  while (_internal.now() < bootDeadline) {
    const r = await read();
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
    const r = await read();
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
  declared,
  reset,
  entryErrors,
  detect,
  assessBoot,
  check,
  watch,
  _internal
};
