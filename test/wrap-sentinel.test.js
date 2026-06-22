'use strict';

// Tests for lib/wrap-sentinel.js (CC-7 Slice C) — the typed-wrap trigger-parity
// monitor. Drives `_internal.tick()` deterministically with stubbed transport
// reads; `stop()` between tests clears the module-level state maps.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const ws = require('../lib/wrap-sentinel');

const TOKEN = ws.SENTINEL_TOKEN; // 'TANGLECLAW_WRAP'

/** A tmux session record. */
function tmuxSession(id = 1) {
  return { id, projectId: id * 10, sessionMode: 'tmux', tmuxSession: `tc-${id}`, engineId: 'claude' };
}
/** A webui/gateway session record. */
function webuiSession(id = 1) {
  return { id, projectId: id * 10, sessionMode: 'webui', tmuxSession: null, engineId: 'openclaw:conn-1' };
}

describe('wrap-sentinel — _hasSentinel detection + false-positive guards', () => {
  it('matches a bare standalone token (incl. ANSI-wrapped, gateway-reflow-spaced)', () => {
    assert.equal(ws._hasSentinel(`output\n${TOKEN}\nmore`), true);
    assert.equal(ws._hasSentinel(`foo   ${TOKEN}   bar`), true);
    assert.equal(ws._hasSentinel(`[32m${TOKEN}[0m`), true);
  });
  it('does NOT match a mere mention — the prime phrases it backticked / period-terminated', () => {
    assert.equal(ws._hasSentinel(`emit the marker \`${TOKEN}\` on a line`), false);
    assert.equal(ws._hasSentinel(`the marker is ${TOKEN}.`), false);
    assert.equal(ws._hasSentinel(`MY${TOKEN}PER`), false);
    assert.equal(ws._hasSentinel('[INFO] nothing here'), false);
    assert.equal(ws._hasSentinel(''), false);
  });
});

describe('wrap-sentinel — tmux transport', () => {
  let saved;
  beforeEach(() => {
    ws.stop(); // reset module state
    saved = { ...ws._internal };
    ws._internal.getProjectName = (pid) => `proj-${pid}`;
    ws._internal.now = () => 1000;
  });
  afterEach(() => { Object.assign(ws._internal, saved); ws.stop(); });

  it('baselines on first sight, then flags a fresh absent→present emission', async () => {
    const s = tmuxSession(1);
    ws._internal.listLiveAll = () => [s];
    let pane = ['working...', 'no marker yet'];
    ws._internal.capturePane = () => ({ lines: pane });

    await ws._internal.tick(); // baseline — no token present
    assert.equal(ws.isWrapRequested('proj-10'), false, 'baseline tick never flags');

    pane = ['done', TOKEN]; // user typed "wrap" → AI emitted the marker
    await ws._internal.tick();
    assert.equal(ws.isWrapRequested('proj-10'), true, 'fresh emission flags');
  });

  it('never flags the prime echo present at baseline (no absent→present transition)', async () => {
    const s = tmuxSession(2);
    ws._internal.listLiveAll = () => [s];
    // Token already in the pane when the monitor first sees the session.
    ws._internal.capturePane = () => ({ lines: ['prime says emit', TOKEN] });

    await ws._internal.tick(); // baseline records token already present
    await ws._internal.tick(); // still present — NOT a transition
    assert.equal(ws.isWrapRequested('proj-20'), false);
  });

  it('flags at most once per session; ack clears the flag and it does not re-fire', async () => {
    const s = tmuxSession(3);
    ws._internal.listLiveAll = () => [s];
    let pane = ['idle'];
    ws._internal.capturePane = () => ({ lines: pane });

    await ws._internal.tick();        // baseline (no token)
    pane = [TOKEN];
    await ws._internal.tick();        // flags
    assert.equal(ws.isWrapRequested('proj-30'), true);

    assert.equal(ws.ackWrapRequest('proj-30'), true);
    assert.equal(ws.isWrapRequested('proj-30'), false, 'ack clears the pending flag');

    // Token still sitting in the pane — must NOT re-fire (session latched).
    await ws._internal.tick();
    assert.equal(ws.isWrapRequested('proj-30'), false, 'latched session never re-flags');
  });

  it('isolates the variable: identical state, only the token FORM differs', async () => {
    const s = tmuxSession(4);
    ws._internal.listLiveAll = () => [s];
    let pane = ['boot'];
    ws._internal.capturePane = () => ({ lines: pane });
    await ws._internal.tick(); // baseline

    // A mere mention (backticked) must not flag...
    pane = ['boot', `please emit \`${TOKEN}\` now`];
    await ws._internal.tick();
    assert.equal(ws.isWrapRequested('proj-40'), false, 'mention form does not flag');

    // ...a bare emission must.
    pane = ['boot', `please emit \`${TOKEN}\` now`, TOKEN];
    await ws._internal.tick();
    assert.equal(ws.isWrapRequested('proj-40'), true, 'bare emission flags');
  });

  it('survives a vanished pane mid-poll (capturePane throws) without flagging or crashing', async () => {
    const s = tmuxSession(5);
    ws._internal.listLiveAll = () => [s];
    ws._internal.capturePane = () => { throw new Error('no such session'); };
    await ws._internal.tick();
    await ws._internal.tick();
    assert.equal(ws.isWrapRequested('proj-50'), false);
  });

  it('prunes session state + a stale pending flag when the session ends', async () => {
    const s = tmuxSession(6);
    let live = [s];
    ws._internal.listLiveAll = () => live;
    let pane = ['x'];
    ws._internal.capturePane = () => ({ lines: pane });
    await ws._internal.tick();      // baseline
    pane = [TOKEN];
    await ws._internal.tick();      // flag
    assert.equal(ws.isWrapRequested('proj-60'), true);

    live = []; // session ended before the operator acked
    await ws._internal.tick();
    assert.equal(ws.isWrapRequested('proj-60'), false, 'pending flag dropped when its session ends');
  });
});

describe('wrap-sentinel — gateway transport', () => {
  let saved;
  beforeEach(() => {
    ws.stop();
    saved = { ...ws._internal };
    ws._internal.getProjectName = (pid) => `proj-${pid}`;
    ws._internal.getBridgeContext = () => ({ localPort: 4567, token: 'tok', project: 'proj-10' });
    ws._internal.now = () => 1000;
  });
  afterEach(() => { Object.assign(ws._internal, saved); ws.stop(); });

  it('baselines at the live cursor edge (skips backlog), then flags fresh output', async () => {
    const s = webuiSession(1);
    ws._internal.listLiveAll = () => [s];
    let statusCalls = 0;
    ws._internal.getStatus = async () => { statusCalls++; return { ok: true, cursor: 10 }; };
    const outCalls = [];
    ws._internal.getOutput = async (opts) => {
      outCalls.push(opts.cursor);
      return { ok: true, events: [{ kind: 'text', text: `here is ${TOKEN}` }], cursorEnd: 14 };
    };

    await ws._internal.tick(); // first sight → getStatus baseline, no getOutput, no flag
    assert.equal(statusCalls, 1);
    assert.equal(outCalls.length, 0, 'baseline never scans the backlog');
    assert.equal(ws.isWrapRequested('proj-10'), false);

    await ws._internal.tick(); // reads new events from cursor 10 → token → flag
    assert.equal(outCalls[0], 10, 'reads from the baselined cursor');
    assert.equal(ws.isWrapRequested('proj-10'), true);
  });

  it('when the baseline cursor is unknowable, stays un-armed and never scans the backlog', async () => {
    const s = webuiSession(4);
    ws._internal.getBridgeContext = () => ({ localPort: 1, token: null, project: 'proj-40' });
    ws._internal.listLiveAll = () => [s];
    // First two ticks: getStatus can't report a cursor → must NOT baseline at 0.
    let statusOk = false;
    ws._internal.getStatus = async () => (statusOk ? { ok: true, cursor: 20 } : { ok: false, error: 'down' });
    let outCalls = 0;
    // A bare token sits in the backlog — a cursor-0 baseline would scan + flag it.
    ws._internal.getOutput = async () => { outCalls++; return { ok: true, events: [{ kind: 'text', text: TOKEN }], cursorEnd: 99 }; };

    await ws._internal.tick(); // getStatus fails → not armed, no scan
    await ws._internal.tick(); // still failing → still not armed, still no scan
    assert.equal(outCalls, 0, 'never scans the backlog without a real baseline cursor');
    assert.equal(ws.isWrapRequested('proj-40'), false, 'a backlog token must not spuriously flag');

    statusOk = true;
    await ws._internal.tick(); // now baselines at cursor 20 (still no scan)
    assert.equal(outCalls, 0);
    await ws._internal.tick(); // fresh output from cursor 20 → token → flag
    assert.equal(outCalls, 1);
    assert.equal(ws.isWrapRequested('proj-40'), true);
  });

  it('a transient bridge error leaves the cursor unchanged and does not flag', async () => {
    const s = webuiSession(2);
    ws._internal.getBridgeContext = () => ({ localPort: 1, token: null, project: 'proj-20' });
    ws._internal.listLiveAll = () => [s];
    ws._internal.getStatus = async () => ({ ok: true, cursor: 5 });
    ws._internal.getOutput = async () => ({ ok: false, error: 'unreachable', events: [] });
    await ws._internal.tick(); // baseline
    await ws._internal.tick(); // bridge error
    assert.equal(ws.isWrapRequested('proj-20'), false);
  });

  it('a webui session with no ClawBridge sidecar is armed and never flags', async () => {
    const s = webuiSession(3);
    ws._internal.getBridgeContext = () => null;
    ws._internal.listLiveAll = () => [s];
    let statusCalled = false;
    ws._internal.getStatus = async () => { statusCalled = true; return { ok: true, cursor: 0 }; };
    await ws._internal.tick();
    await ws._internal.tick();
    assert.equal(statusCalled, false, 'no sidecar → never talks to a bridge');
    assert.equal(ws.isWrapRequested('proj-30'), false);
  });
});

describe('wrap-sentinel — lifecycle', () => {
  afterEach(() => ws.stop());
  it('start is idempotent and stop clears pending state', async () => {
    const saved = { ...ws._internal };
    ws._internal.listLiveAll = () => [tmuxSession(9)];
    ws._internal.getProjectName = () => 'proj-90';
    let pane = ['x'];
    ws._internal.capturePane = () => ({ lines: pane });
    await ws._internal.tick();
    pane = [TOKEN];
    await ws._internal.tick();
    assert.equal(ws.isWrapRequested('proj-90'), true);

    ws.start(); ws.start(); // idempotent — no throw
    ws.stop();
    assert.equal(ws.isWrapRequested('proj-90'), false, 'stop clears all pending flags');
    Object.assign(ws._internal, saved);
  });
});
