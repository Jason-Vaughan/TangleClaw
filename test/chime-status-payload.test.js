'use strict';

/*
 * #1180 — the parts of the chime fix that only exist once `getSessionStatus`
 * runs. The unit tests exercise the gate; these pin that the gate is what the
 * status endpoint actually asks, and that its provenance survives the trip.
 *
 * Both were green mutations first: flipping the chime back to the paste-safe
 * gate, and dropping `idleReason` on the floor, changed nothing any test could
 * see because every guard stopped at the helper's return value.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const tmux = require('../lib/tmux');
const medusaWake = require('../lib/medusa-wake');

let tmpDir;
let sessions;
let projectId;
let unprofiledProjectId;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-chime-payload-'));
  store._setBasePath(tmpDir);
  store.init();
  sessions = require('../lib/sessions');
  const projDir = path.join(tmpDir, 'projects', 'chime-payload');
  fs.mkdirSync(projDir, { recursive: true });
  projectId = store.projects.create({ name: 'chime-payload', path: projDir, engine: 'claude' }).id;
  // A project of its own, so an active session left by another case cannot be
  // the one `getSessionStatus` resolves here.
  const unprofiledDir = path.join(tmpDir, 'projects', 'chime-payload-unprofiled');
  fs.mkdirSync(unprofiledDir, { recursive: true });
  unprofiledProjectId = store.projects.create({ name: 'chime-payload-unprofiled', path: unprofiledDir, engine: 'aider' }).id;
});

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ALIVE = { live: true, answered: true, cause: null };

/** Run `fn` with the pane probe, capture and cursor all stubbed. */
function withPane(lines, engineId, fn, pid) {
  const realProbe = tmux.probeSession;
  const realCapture = tmux.capturePane;
  const realCursor = tmux.cursorInfo;
  tmux.probeSession = () => ALIVE;
  tmux.capturePane = () => ({ lines });
  tmux.cursorInfo = () => null;
  const session = store.sessions.start({
    projectId: pid || projectId, engineId, tmuxSession: `tc-chime-${Math.random().toString(36).slice(2)}`
  });
  sessions.clearIdleCache(session.tmuxSession);
  try {
    return fn(session);
  } finally {
    tmux.probeSession = realProbe;
    tmux.capturePane = realCapture;
    tmux.cursorInfo = realCursor;
    sessions.clearIdleCache(session.tmuxSession);
    try { store.sessions.end(session.id); } catch { /* fixture teardown */ }
  }
}

describe('#1180 the status payload carries which gate answered', () => {
  it('names the strong gate on a profiled engine', () => {
    withPane(['transcript', '', '❯ '], 'claude', () => {
      const status = sessions.getSessionStatus('chime-payload');
      assert.equal(typeof status.idleReason, 'string',
        'idleReason must reach the payload — an operator cannot otherwise tell which gate ran');
      assert.doesNotMatch(status.idleReason, /^staleness:/);
    });
  });

  it('names the FALLBACK on an engine with no wake profile', () => {
    // This is the case that would otherwise re-report #1180 against code that
    // never ran for them.
    // aider: codex gained a measured wake profile in #1344, so it is no longer
    // an engine with no wake profile.
    withPane(['transcript', '', '> '], 'aider', () => {
      const status = sessions.getSessionStatus('chime-payload-unprofiled');
      assert.match(status.idleReason, /^staleness:no-wake-profile:aider$/);
    }, unprofiledProjectId);
  });
});

describe('#1180 the chime asks the notifier question, end to end', () => {
  it('a permission dialog does not read as "not at a prompt"', () => {
    // The regression this pins: asking the INJECTOR's question here silences
    // the chime on a blocked session, which is the case it exists for. The
    // paste-safe gate refuses a selector row as `no-prompt` (or, with a cursor
    // parked on a glyph-led row, `composer-has-input`). Both codes are pinned,
    // and pinned against what the injector gate really returns for this pane,
    // so a future rename cannot leave this assertion comparing to a dead string.
    const pane = ['Do you want to proceed?', '❯ 1. Yes', '  2. No'];
    const INJECTOR_REFUSALS = ['no-prompt', 'composer-has-input'];
    assert.ok(INJECTOR_REFUSALS.includes(
      medusaWake._assessPane(pane, medusaWake.ENGINE_WAKE_PROFILES.claude, null).reason),
    'precondition: the injector gate refuses this pane with one of the pinned codes');
    withPane(pane, 'claude', () => {
      const status = sessions.getSessionStatus('chime-payload');
      assert.ok(!INJECTOR_REFUSALS.includes(status.idleReason),
        'the chime must not adopt the injector paste-safety gate');
    });
  });

  it('a turn in flight still reads as working', () => {
    withPane(['output', 'esc to interrupt', '❯ '], 'claude', () => {
      const status = sessions.getSessionStatus('chime-payload');
      assert.equal(status.idle, false);
      assert.equal(status.idleReason, 'turn-in-flight');
    });
  });
});

describe('#1180 clearIdleCache owns every per-pane cache', () => {
  it('drops the at-prompt state, not just the output cache', () => {
    // tmux names key on the PROJECT, so a leftover entry hands the next
    // session of a project the dead one's streak and stillness clock. Asserted
    // on the map itself: a timing-based check passes by accident inside a
    // single second.
    const realCapture = tmux.capturePane;
    const realCursor = tmux.cursorInfo;
    tmux.capturePane = () => ({ lines: ['a', '', '❯ '] });
    tmux.cursorInfo = () => null;
    try {
      sessions.detectAtPrompt('tc-cache-owner-1180', 'claude');
      assert.ok(sessions._atPromptState.has('tc-cache-owner-1180'), 'precondition: state was recorded');
      sessions.clearIdleCache('tc-cache-owner-1180');
      assert.equal(sessions._atPromptState.has('tc-cache-owner-1180'), false,
        'clearIdleCache must reset the at-prompt state too');
    } finally {
      tmux.capturePane = realCapture;
      tmux.cursorInfo = realCursor;
    }
  });
});
