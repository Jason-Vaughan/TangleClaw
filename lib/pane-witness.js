'use strict';

/**
 * A witness for one question: is this pane, right now, positively showing an
 * empty ordinary composer?
 *
 * Asked by a native startup fire that is about to send into a folder the
 * engine's config holds no trust entry for (#2186). The protocol cannot say
 * what the pane shows, and the one thing that must never happen is a send
 * while the engine is asking the operator something. So this reads the pane
 * and answers `shown: true` only on positive evidence, twice, a second apart.
 * Everything short of that is `shown: false`, with the dialog named when one
 * was actually read.
 *
 * It only reads. It never sends a key and never answers a prompt.
 *
 * @module lib/pane-witness
 */

const launchDialogGuard = require('./launch-dialog-guard');
const { createLogger } = require('./logger');

const log = createLogger('pane-witness');

/** How far apart the two reads are. One read can catch a screen mid-draw. */
const READ_GAP_MS = 1000;

/** Strips ANSI control sequences. */
const _ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * A pane row as plain text: no styling, no trailing space.
 * @param {string} row - A row as tmux returned it.
 * @returns {string}
 */
function _plain(row) {
  return String(row).replace(_ANSI_RE, '').replace(/\s+$/, '');
}

/**
 * One read of the pane, judged.
 *
 * The read is the visible pane and its cursor together, every row in place
 * (`tmux.visiblePane`), so a row's index is its position and the row under the
 * cursor is `rows[y]` by construction: nothing here compares a separately
 * read cursor row against the capture by what it says.
 *
 * `composer` needs all of:
 * - a declared guarded dialog is not the live screen;
 * - a bare composer row is on screen, and the cursor is ON the last one, by
 *   position, with nothing typed. An earlier composer row that reads the same
 *   is a different row;
 * - every row below it is blank or a status row the adapter recognises, there
 *   are no more of those than it allows, and none of them names a key the way
 *   a dialog footer does. A menu the profile does not
 *   declare, however it marks its selected row, is content below the composer
 *   that nothing recognises;
 * - no header row still shows its starting value as the newest one (a pane
 *   whose header has scrolled away passes this);
 * - no busy marker is drawn.
 *
 * @param {object} t - The target.
 * @param {string} t.tmuxName - tmux session name.
 * @param {object} t.engineProfile - Resolved engine profile (its declared guarded dialogs).
 * @param {object} t.wakeProfile - The engine's wake profile (`promptRe`, `promptGlyph`, `busyMarker`).
 * @param {RegExp|null} t.startingRe - Matches the newest header row while the engine is still starting, or null.
 * @param {RegExp|null} t.headerRe - Matches any header row that `startingRe` could apply to, or null.
 * @param {RegExp|null} t.statusRe - Matches a status row the engine draws below its composer, or null when it draws none.
 * @param {number} [t.maxStatusRows=1] - How many such rows may follow the composer.
 * @param {RegExp|null} [t.keyHintRe] - Matches a whole token that names a key (`enter`, `esc`, an arrow); a
 *   status-shaped row holding one is a dialog footer and is refused.
 * @param {object} seams - `read(name, paneId)` returning `{paneId, height, x, y, rows}`, and `composerEmpty(cursor, profile)`.
 * @param {string} paneId - The pane pinned for this witness; a frame from any other is refused.
 * @returns {{state: 'composer', frame: string} | {state: 'prompt', prompt: {id: string, humanAction: string}} | {state: 'unproven', why: string}}
 */
function _readOnce(t, seams, paneId) {
  let pane;
  try {
    pane = seams.read(t.tmuxName, paneId);
  } catch (err) {
    // The answer reaches a fire row the operator reads; the fault's own text
    // (a path, a tmux message) stays in the server log.
    log.warn('The pane witness could not read the pane', { session: t.tmuxName, error: err.message });
    return { state: 'unproven', why: 'the pane could not be read' };
  }
  // The read is already aimed at the pinned pane and checked there; this is
  // the witness refusing to take a frame from anywhere else on its own account.
  if (!pane || pane.paneId !== paneId) return { state: 'unproven', why: 'the pane that was read is not the pane that was pinned' };
  const aligned = Array.isArray(pane.rows) && Number.isInteger(pane.height) && pane.height > 0
    && pane.rows.length === pane.height && Number.isInteger(pane.x) && Number.isInteger(pane.y)
    && pane.y >= 0 && pane.y < pane.height && typeof pane.rows[pane.y] === 'string';
  if (!aligned) return { state: 'unproven', why: 'the pane and its cursor could not be read row for row' };

  const declared = launchDialogGuard.read(t.engineProfile);
  if (declared.unreadable > 0) return { state: 'unproven', why: 'the engine profile declares a guarded dialog that could not be read, so a dialog could not be ruled out' };
  const promptRe = t.wakeProfile.promptRe;
  const rows = pane.rows.map(_plain);
  // A declared dialog wins over everything else on screen.
  const seen = launchDialogGuard.assess(rows, declared.prompts, promptRe);
  if (seen.state === 'prompt') return { state: 'prompt', prompt: seen.prompt };
  if (seen.state !== 'composer') return { state: 'unproven', why: 'no empty composer row is on screen' };

  let composerAt = -1;
  rows.forEach((row, i) => { if (promptRe.test(row)) composerAt = i; });
  if (pane.y !== composerAt) return { state: 'unproven', why: 'the cursor is not on the composer row' };

  const below = rows.slice(composerAt + 1).filter((row) => row !== '');
  const glyph = t.wakeProfile.promptGlyph;
  if (glyph && below.some((row) => row.trimStart().startsWith(glyph))) {
    return { state: 'unproven', why: 'a selector row is drawn below the composer' };
  }
  const allowed = Number.isInteger(t.maxStatusRows) ? t.maxStatusRows : 1;
  if (below.length > (t.statusRe ? allowed : 0) || below.some((row) => !t.statusRe.test(row))) {
    return { state: 'unproven', why: 'something other than a status row is drawn below the composer' };
  }
  // A row can have a status row's shape and still be a dialog's footer: the
  // footer is the one that names keys. Judged token by token, so a model name
  // or a path that merely contains such a word is not caught.
  if (t.keyHintRe && below.some((row) => row.split(/[\s·]+/).some((token) => t.keyHintRe.test(token)))) {
    return { state: 'unproven', why: 'a row below the composer names keys, as a dialog footer does' };
  }

  const empty = seams.composerEmpty({ x: pane.x, y: pane.y, line: pane.rows[pane.y] }, t.wakeProfile);
  if (empty === false) return { state: 'unproven', why: 'the composer holds typed text' };
  if (empty !== true) return { state: 'unproven', why: 'the cursor is not on the composer row' };

  if (t.wakeProfile.busyMarker && rows.join('\n').includes(t.wakeProfile.busyMarker)) {
    return { state: 'unproven', why: 'a turn is running' };
  }
  if (t.startingRe && t.headerRe) {
    let newest = null;
    for (const row of rows) if (t.headerRe.test(row)) newest = row;
    if (newest !== null && t.startingRe.test(newest)) return { state: 'unproven', why: 'the engine is still starting' };
  }
  // What two reads must agree on: every row as drawn, with the engine's own
  // animated decoration blanked, and where the cursor is.
  const decorative = t.wakeProfile.decorativeRe || null;
  const still = rows.map((row) => (decorative ? Array.from(row).map((ch) => (decorative.test(ch) ? ' ' : ch)).join('').replace(/\s+$/, '') : row));
  return { state: 'composer', frame: `${pane.x},${pane.y}\n${still.join('\n')}` };
}

/**
 * Whether the pane positively shows an empty composer, on two reads a second
 * apart that agree.
 *
 * @param {object} target - See `_readOnce`.
 * @param {object} [deps] - Seams: `pin`, `read`, `composerEmpty`, `sleep`, `gapMs`.
 * @returns {Promise<{shown: true} | {shown: false, dialog: ({id: string, humanAction: string}|null), why: string}>}
 */
async function composerShown(target, deps = {}) {
  const seams = {
    pin: deps.pin || ((name) => require('./tmux').solePaneId(name)),
    read: deps.read || ((name, paneId) => require('./tmux').visiblePane(name, paneId)),
    composerEmpty: deps.composerEmpty || ((cursor, profile) => require('./medusa-wake')._composerEmpty(cursor, profile))
  };
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (!target || !target.tmuxName || !target.wakeProfile || !target.wakeProfile.promptRe) {
    return { shown: false, dialog: null, why: 'this session has no pane, or its engine no composer pattern, to read' };
  }
  const fail = (read) => (read.state === 'prompt'
    ? { shown: false, dialog: read.prompt, why: `the pane is showing the engine's ${read.prompt.id} prompt` }
    : { shown: false, dialog: null, why: read.why });

  // One pane is pinned for the whole witness. `=session:` follows whichever
  // pane is current, so without this the two reads, or the two halves of one
  // read, could be of different panes. A session with more than one pane has
  // no pane this can vouch for, and is refused.
  let paneId;
  try {
    paneId = seams.pin(target.tmuxName);
  } catch (err) {
    log.warn('The pane witness could not pin the session\'s pane', { session: target.tmuxName, error: err.message });
    return { shown: false, dialog: null, why: 'the session does not have exactly one pane to read' };
  }
  if (typeof paneId !== 'string' || paneId === '') return { shown: false, dialog: null, why: 'the session does not have exactly one pane to read' };

  const first = _readOnce(target, seams, paneId);
  if (first.state !== 'composer') return fail(first);
  await sleep(Number.isInteger(deps.gapMs) ? deps.gapMs : READ_GAP_MS);
  const second = _readOnce(target, seams, paneId);
  if (second.state !== 'composer') return fail(second);
  if (second.frame !== first.frame) {
    return { shown: false, dialog: null, why: 'the pane changed between two reads a second apart' };
  }
  return { shown: true };
}

module.exports = { composerShown, READ_GAP_MS };
