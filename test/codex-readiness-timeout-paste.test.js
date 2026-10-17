'use strict';

// #2223: the bundled Codex profile through the real launch path when its
// folder-trust dialog is on screen. Codex declares no startup dialogs, so no
// boot watch runs and `_deferEngineInit` goes straight to the readiness gate,
// which never sees `· Ready ·` and times out. The paste that follows must type
// nothing into the dialog (an Enter would take its highlighted default) and
// record why. The gate runs at its PRODUCTION timing — 750 ms polls, 90 s
// horizon — with `setTimeout` and `Date` mocked, so the test proves the
// constants the server ships rather than ones a test chose.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const tmux = require('../lib/tmux');
const { CODEX_VISIBLE_PANES } = require('./_codex-visible-pane-fixtures');

const CODEX_PROFILE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
const GUARDED_DIALOG_WARNING = 'Engine is waiting at a guarded dialog that TangleClaw does not answer';
// The gate's shipped timing, written out rather than read back from the
// module, so a change to either constant fails here instead of moving the
// expectation with it.
const PRODUCTION_TIMEOUT_MS = 90_000;
const PRODUCTION_POLL_MS = 750;

let sessions;
let storeDir;

/**
 * Launch the bundled Codex profile through `_deferEngineInit` against a pane
 * that shows `first` for `switchAt` captures and `then` after, and tick the
 * mocked clock until the launch writes its ledger row.
 * @param {import('node:test').TestContext} t - Test context (its mocks restore themselves)
 * @param {{first: object, then: object, switchAt: number}} panes - Pane fixtures and the capture index that switches them
 * @returns {Promise<{rows: object[], pastes: string[], keys: string[], captures: number, startedAt: number, firstCaptureAt: number|null, rowAt: number|null, warnings: Array<{line: string, capture: number, at: number}>}>}
 */
async function launchCodex(t, panes) {
  const rows = [];
  const pastes = [];
  const keys = [];
  const warnings = [];
  let captures = 0;
  let firstCaptureAt = null;
  let rowAt = null;
  t.mock.method(tmux, 'capturePane', () => {
    captures += 1;
    if (firstCaptureAt === null) firstCaptureAt = Date.now();
    return { lines: [...(captures <= panes.switchAt ? panes.first : panes.then).rows] };
  });
  t.mock.method(tmux, 'sendKeys', (_name, text) => { pastes.push(text); return true; });
  t.mock.method(tmux, 'sendRawKey', (_name, key) => { keys.push(key); return true; });
  t.mock.method(tmux, 'hasSession', () => true);
  t.mock.method(tmux, 'probeSession', () => ({ live: true, answered: true, cause: null }));
  t.mock.method(store.sessionRuleDeliveries, 'record', (entry) => {
    rows.push(entry);
    if (rowAt === null) rowAt = Date.now();
    return entry;
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  setConsoleStream({ write: (line) => { if (line.includes(GUARDED_DIALOG_WARNING)) warnings.push({ line, capture: captures, at: Date.now() }); } });
  setLevel('warn');
  const startedAt = Date.now();
  try {
    sessions._deferEngineInit('tc-codex-2223', 'codex-2223', 'codex', CODEX_PROFILE, 'the prime', null, false,
      { sessionId: 2223, projectId: 2223, engineId: 'codex', kind: 'startup', ruleIds: [1], digest: 'd2223' },
      { sessionId: 2223, projectId: 2223, hasSequence: true, startupDelivery: 'legacy' });
    // One production poll interval per tick, so the row's fake time is known
    // to within one poll of when the gate gave up.
    for (let i = 0; i < 400 && rows.length === 0; i++) {
      t.mock.timers.tick(PRODUCTION_POLL_MS);
      for (let j = 0; j < 6; j++) await Promise.resolve();
    }
  } finally {
    setLevel('error');
    setConsoleStream(null);
  }
  return { rows, pastes, keys, captures, startedAt, firstCaptureAt, rowAt, warnings };
}

describe('Codex readiness-timeout paste on the folder-trust dialog (#2223)', () => {
  before(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codex-2223-'));
    store._setBasePath(storeDir);
    store.init();
    sessions = require('../lib/sessions');
  });

  after(() => {
    store.close();
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it('runs the gate at its shipped timing: 750 ms polls, a 90 s horizon', () => {
    // The launch path passes no timing, so these defaults are what it uses.
    assert.equal(sessions.PANE_READY_TIMEOUT_MS, PRODUCTION_TIMEOUT_MS);
    assert.equal(sessions.PANE_READY_POLL_MS, PRODUCTION_POLL_MS);
  });

  it('takes the route this file drives: Codex declares no startup dialogs, but guards its folder-trust prompt', () => {
    // The boot watch (#2128) runs only for a profile that declares startup
    // dialogs. Were Codex to declare one, the launch would take that route and
    // this file would be testing the wrong one.
    assert.equal((CODEX_PROFILE.capabilities || {}).startupDialogs, undefined);
    assert.ok(require('../lib/launch-dialog-guard').declared(CODEX_PROFILE).some((p) => p.id === 'folder-trust'));
  });

  it('a folder-trust dialog for the whole wait: nothing is typed, and one skipped row says why, at the 90 s horizon', async (t) => {
    const r = await launchCodex(t, { first: CODEX_VISIBLE_PANES.trustPrompt, then: CODEX_VISIBLE_PANES.trustPrompt, switchAt: Infinity });

    assert.deepEqual(r.pastes, [], 'no prime was typed into the dialog');
    assert.deepEqual(r.keys, [], 'no raw key was sent to the dialog');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].channel, 'prime-paste');
    assert.equal(r.rows[0].outcome, 'skipped');
    assert.match(r.rows[0].skipReason, /folder-trust prompt/);
    assert.match(r.rows[0].skipReason, /TangleClaw does not answer/);

    // The row is written when the PRODUCTION gate gives up: not before its
    // horizon, and within one poll (plus this loop's one-poll tick) after it.
    const elapsed = r.rowAt - r.startedAt;
    assert.ok(elapsed >= PRODUCTION_TIMEOUT_MS, `row written at ${elapsed} ms, before the ${PRODUCTION_TIMEOUT_MS} ms horizon`);
    assert.ok(elapsed < PRODUCTION_TIMEOUT_MS + 2 * PRODUCTION_POLL_MS, `row written at ${elapsed} ms, long after the horizon`);
    // Supporting only: the gate kept polling for the whole wait.
    assert.ok(r.captures >= PRODUCTION_TIMEOUT_MS / PRODUCTION_POLL_MS, `${r.captures} captures`);

    // The dialog is logged when the wait FIRST sees it, once — not when the
    // wait ends, and not on every poll.
    assert.equal(r.warnings.length, 1, r.warnings.map((w) => w.line).join(''));
    assert.match(r.warnings[0].line, /folder-trust/);
    assert.equal(r.warnings[0].capture, 1, 'logged at the first capture');
    assert.equal(r.warnings[0].at, r.firstCaptureAt, 'logged at the fake time of the first capture');
    assert.ok(r.warnings[0].at - r.startedAt <= PRODUCTION_POLL_MS, `logged at ${r.warnings[0].at - r.startedAt} ms, not at the start of the wait`);
  });

  it('a folder-trust dialog that is answered: the prime is pasted once at the composer, and the dialog was logged once', async (t) => {
    const r = await launchCodex(t, { first: CODEX_VISIBLE_PANES.trustPrompt, then: CODEX_VISIBLE_PANES.composerOperatorStatus, switchAt: 5 });

    assert.equal(r.pastes.length, 1);
    assert.match(r.pastes[0], /the prime/);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].channel, 'prime-paste');
    assert.equal(r.rows[0].outcome, 'delivered');
    assert.ok(r.rowAt - r.startedAt < PRODUCTION_TIMEOUT_MS, 'delivered before the horizon, not by timing out');
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].capture, 1, 'logged at the first capture');
  });
});
