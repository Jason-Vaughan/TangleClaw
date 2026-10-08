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

/** How far apart the two reads are. One read can catch a screen mid-draw. */
const READ_GAP_MS = 1000;

/** Pane tail depth for each read: the composer, the status rows, and the header above them. */
const CAPTURE_LINES = 15;

/** Strips ANSI control sequences. */
const _ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * One read of the pane, judged.
 *
 * `composer` needs all of: a declared guarded dialog is not the live screen;
 * a bare composer row is; the cursor sits on an empty composer row; the newest
 * header row is past its starting value; no busy marker is drawn. A stale
 * composer left above a dialog fails the first test, and fails the cursor test
 * independently, because the cursor is on the dialog.
 *
 * @param {object} t - The target.
 * @param {string} t.tmuxName - tmux session name.
 * @param {object} t.engineProfile - Resolved engine profile (its declared guarded dialogs).
 * @param {object} t.wakeProfile - The engine's wake profile (`promptRe`, `promptGlyph`, `busyMarker`).
 * @param {RegExp|null} t.startingRe - Matches the newest header row while the engine is still starting, or null.
 * @param {RegExp|null} t.headerRe - Matches any header row that `startingRe` could apply to, or null.
 * @param {object} seams - `capture(name, {lines})`, `cursorInfo(name)`, `composerEmpty(cursor, profile)`, `digest(lines, profile)`.
 * @returns {{state: 'composer', digest: string, cursor: string} | {state: 'prompt', prompt: {id: string, humanAction: string}} | {state: 'unproven', why: string}}
 */
function _readOnce(t, seams) {
  let lines;
  let cursor;
  try {
    lines = (seams.capture(t.tmuxName, { lines: CAPTURE_LINES }) || {}).lines || [];
    cursor = seams.cursorInfo(t.tmuxName);
  } catch (err) {
    return { state: 'unproven', why: `the pane could not be read (${err.message})` };
  }
  if (lines.length === 0) return { state: 'unproven', why: 'the pane could not be read (the capture came back empty)' };

  const declared = launchDialogGuard.read(t.engineProfile);
  if (declared.unreadable > 0) return { state: 'unproven', why: 'the engine profile declares a guarded dialog that could not be read, so a dialog could not be ruled out' };
  const promptRe = (t.wakeProfile && t.wakeProfile.promptRe) || null;
  // A declared dialog wins over everything else on screen.
  const seen = launchDialogGuard.assess(lines, declared.prompts, promptRe);
  if (seen.state === 'prompt') return { state: 'prompt', prompt: seen.prompt };
  if (seen.state !== 'composer') return { state: 'unproven', why: 'no empty composer row is on screen' };

  if (!cursor) return { state: 'unproven', why: 'the cursor position could not be read' };
  const empty = seams.composerEmpty(cursor, t.wakeProfile);
  if (empty === false) return { state: 'unproven', why: 'the composer holds typed text' };
  if (empty !== true) return { state: 'unproven', why: 'the cursor is not on the composer row' };

  const rows = lines.map((l) => String(l).replace(_ANSI_RE, ''));
  if (t.wakeProfile.busyMarker && rows.join('\n').includes(t.wakeProfile.busyMarker)) {
    return { state: 'unproven', why: 'a turn is running' };
  }
  if (t.startingRe && t.headerRe) {
    let newest = null;
    for (const row of rows) if (t.headerRe.test(row)) newest = row;
    if (newest !== null && t.startingRe.test(newest)) return { state: 'unproven', why: 'the engine is still starting' };
  }
  return { state: 'composer', digest: seams.digest(lines, t.wakeProfile), cursor: `${cursor.x},${cursor.y}` };
}

/**
 * Whether the pane positively shows an empty composer, on two reads a second
 * apart that agree.
 *
 * @param {object} target - See `_readOnce`.
 * @param {object} [deps] - Seams: `capture`, `cursorInfo`, `composerEmpty`, `digest`, `sleep`, `gapMs`.
 * @returns {Promise<{shown: true} | {shown: false, dialog: ({id: string, humanAction: string}|null), why: string}>}
 */
async function composerShown(target, deps = {}) {
  const seams = {
    capture: deps.capture || ((name, o) => require('./tmux').capturePane(name, o)),
    cursorInfo: deps.cursorInfo || ((name) => require('./tmux').cursorInfo(name)),
    composerEmpty: deps.composerEmpty || ((cursor, profile) => require('./medusa-wake')._composerEmpty(cursor, profile)),
    digest: deps.digest || ((lines, profile) => require('./medusa-wake')._paneDigest(lines, profile))
  };
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (!target || !target.tmuxName || !target.wakeProfile || !target.wakeProfile.promptRe) {
    return { shown: false, dialog: null, why: 'this session has no pane, or its engine no composer pattern, to read' };
  }
  const fail = (read) => (read.state === 'prompt'
    ? { shown: false, dialog: read.prompt, why: `the pane is showing the engine's ${read.prompt.id} prompt` }
    : { shown: false, dialog: null, why: read.why });

  const first = _readOnce(target, seams);
  if (first.state !== 'composer') return fail(first);
  await sleep(Number.isInteger(deps.gapMs) ? deps.gapMs : READ_GAP_MS);
  const second = _readOnce(target, seams);
  if (second.state !== 'composer') return fail(second);
  if (second.digest !== first.digest || second.cursor !== first.cursor) {
    return { shown: false, dialog: null, why: 'the pane changed between two reads a second apart' };
  }
  return { shown: true };
}

module.exports = { composerShown, READ_GAP_MS };
