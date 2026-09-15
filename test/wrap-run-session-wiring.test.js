'use strict';

/*
 * The wrap-run wiring in `public/session.js`, EXECUTED.
 *
 * session.js touches the DOM at load and cannot be required, so the functions
 * that follow a wrap run — the POST, the controller's dispatch and effects, the
 * stream, the status poll, the page-load restore — are sliced out of the real
 * file and run in a vm sandbox. The paint primitives they call
 * (`renderLiveWrapDrawer`, `openWrapDrawer`, …) are recorders, `EventSource` and
 * the timers are fakes the test drives, and the controller and drawer helpers
 * are the real modules.
 *
 * Source pins over these functions were how the previous wiring was guarded, and
 * they passed on code that reads correctly and behaves wrongly. What matters
 * here is behaviour an operator sees: after Retry the drawer resets and follows
 * the new run (#1312), a lost stream still delivers the report, a closed drawer
 * re-opens with the report, and a reload restores the run this tab followed.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_SRC = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');

/**
 * The full source of one top-level function in session.js, declaration included.
 * @param {string} name - Function name
 * @returns {string}
 */
function functionSource(name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
  const m = re.exec(SESSION_SRC);
  assert.ok(m, `session.js must define ${name}`);
  const bodyStart = SESSION_SRC.indexOf('{', SESSION_SRC.indexOf(')', m.index));
  let depth = 0;
  for (let i = bodyStart; i < SESSION_SRC.length; i += 1) {
    if (SESSION_SRC[i] === '{') depth += 1;
    else if (SESSION_SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return SESSION_SRC.slice(m.index, i + 1);
    }
  }
  return assert.fail(`unbalanced braces in ${name}`);
}

const WIRING = [
  'wrapStartInFlight', 'postWrap', 'retryWrap', 'closeWrapDrawer',
  'wrapRunState', 'wrapStatusUrl', 'dispatchWrapRun', 'syncWrapRunEffects', 'paintWrapRun',
  'followedWrapRunKey', 'rememberFollowedWrapRun', 'recallFollowedWrapRun', 'restoreWrapRunOnLoad',
  '_probeWrapStatus', 'startWrapStream', 'stopWrapStream', 'scheduleWrapStatusPoll', 'cancelWrapStatusPoll',
  'collapseWrapPopover', 'onWrapButtonClick', 'wrapButtonContext',
  'syncHandbackEffects', 'startHandbackStream', 'stopHandbackStream', 'scheduleHandbackStatusPoll',
  'syncWrapClock', 'wrapClockTick'
];

/** A controllable `EventSource`. */
class FakeEventSource {
  /** @param {string} url */
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  /** @param {string} type @param {Function} fn */
  addEventListener(type, fn) { this.listeners[type] = fn; }

  /** Close, as the browser does. */
  close() { this.closed = true; this.readyState = 2; }

  /** @param {string} type @param {object} data */
  emit(type, data) { this.listeners[type]({ data: JSON.stringify(data) }); }

  /** Terminal failure: CLOSED, then onerror. */
  fail() { this.readyState = 2; this.onerror(); }
}
FakeEventSource.CLOSED = 2;
FakeEventSource.instances = [];

/**
 * Build a sandbox holding the real wiring plus recorders and fakes.
 * @returns {object} Handles the tests drive and read
 */
function harness() {
  FakeEventSource.instances = [];
  const calls = [];
  const record = (name) => (...args) => { calls.push({ name, args }); };
  const timers = [];
  const intervals = [];
  const storage = new Map();
  const net = { post: null, status: null, lastError: null };

  const sandbox = {
    console: { warn: () => {}, log: console.log },
    JSON, Promise, Date, Map, Set, Object, Array, String, Number, Boolean, Error,
    encodeURIComponent,
    EventSource: FakeEventSource,
    projectName: 'demo',
    sessionState: { wrapDrawerOpen: false },
    wrapSkippedAiSteps: {},
    wrapPathDecisions: {},
    wrapSkipPreflight: false,
    wrapBumpLevel: '',
    currentWrapPassword: '',
    sessionStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false, interval: true }; intervals.push(t); return t; },
    clearInterval: (t) => { if (t) t.cleared = true; },
    apiMutate: async (url, method, body) => { calls.push({ name: 'apiMutate', args: [url, method, body] }); return net.post; },
    api: {},
    tcFetch: async () => ({ ok: true, headers: { get: () => null }, json: async () => net.status }),
    document: {
      getElementById: () => ({ disabled: false, classList: { add() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => [] })
    },
    renderLiveWrapDrawer: record('renderLiveWrapDrawer'),
    openWrapDrawer: record('openWrapDrawer'),
    openWrapDrawerNotice: record('openWrapDrawerNotice'),
    renderWrapDrawerError: record('renderWrapDrawerError'),
    hideWrapDrawer: record('hideWrapDrawer'),
    collapseWrapDrawer: record('collapseWrapDrawer'),
    expandWrapDrawer: record('expandWrapDrawer'),
    openWrapModal: record('openWrapModal'),
    paintWrapButton: record('paintWrapButton'),
    paintHandback: record('paintHandback'),
    paintLiveTiming: record('paintLiveTiming'),
    showWrappingState: record('showWrappingState'),
    clearWrappingState: record('clearWrappingState')
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'wrap-stream-events.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'wrap-drawer.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'wrap-run-controller.js'), 'utf8'), sandbox);
  const globals = [
    'let wrapRun = null;', 'let currentWrapStream = null;', 'let currentWrapStreamRunId = null;',
    'let wrapStatusPollTimer = null;', 'const WRAP_STATUS_POLL_MS = 4000;',
    'let currentHandbackStream = null;', 'let currentHandbackStreamId = null;', 'let handbackStatusPollTimer = null;',
    'let wrapClockTimer = null;'
  ].join('\n');
  vm.runInContext(`${globals}\n${WIRING.map(functionSource).join('\n\n')}\n`
    + 'this.__wiring = { postWrap, retryWrap, closeWrapDrawer, collapseWrapPopover, onWrapButtonClick, wrapClockTick, dispatchWrapRun, wrapRunState, restoreWrapRunOnLoad, getPassword: () => currentWrapPassword, setPassword: (p) => { currentWrapPassword = p; } };', sandbox);
  sandbox.api.lastError = null;

  return {
    w: sandbox.__wiring,
    sandbox,
    net,
    storage,
    timers,
    intervals,
    calls,
    count: (name) => calls.filter((c) => c.name === name).length,
    last: (name) => { const hits = calls.filter((c) => c.name === name); return hits.length ? hits[hits.length - 1].args : null; },
    streams: () => FakeEventSource.instances,
    /** Run every pending, uncleared timer once. */
    async flushTimers() {
      const due = timers.splice(0).filter((t) => !t.cleared);
      for (const t of due) await t.fn();
    },
    tick: () => new Promise((resolve) => setImmediate(resolve))
  };
}

const RUN = 'a'.repeat(32);
const RETRY_RUN = 'b'.repeat(32);
const BLOCKED_RESULT = {
  ok: false,
  runId: RUN,
  status: 'blocked',
  pipelineResult: {
    ok: false,
    blockedAt: 'test',
    results: [
      { stepId: 'preflight', kind: 'preflight', status: 'done', output: null, blockers: [] },
      { stepId: 'test', kind: 'test', status: 'blocked', output: null, blockers: ['Test suite failed'] },
      { stepId: 'commit', kind: 'commit', status: 'pending', output: null, blockers: [] }
    ]
  }
};

/**
 * Drive a first wrap to a blocked report: POST 202, stream, run-done.
 * @param {object} h - A harness
 */
async function wrapToBlocked(h) {
  h.w.dispatchWrapRun({ type: 'start', retry: false });
  h.net.post = { ok: true, runId: RUN, status: 'wrapping' };
  assert.equal(await h.w.postWrap({}), true);
  const es = h.streams()[0];
  es.emit('run-start', { steps: [{ stepId: 'preflight', kind: 'preflight' }, { stepId: 'test', kind: 'test' }, { stepId: 'commit', kind: 'commit' }] });
  es.emit('step-blocked', { stepId: 'test', kind: 'test', status: 'blocked', output: null, blockers: ['Test suite failed'], halted: true });
  es.emit('run-done', { result: BLOCKED_RESULT });
}

describe('wrap-run wiring in session.js — executed', () => {
  let h;
  beforeEach(() => { h = harness(); });

  it('a first wrap follows the run the 202 names, live, then paints its report once', async () => {
    h.w.dispatchWrapRun({ type: 'start', retry: false });
    assert.equal(h.count('showWrappingState'), 1, 'the session reads as wrapping as soon as the POST goes out');
    h.net.post = { ok: true, runId: RUN, status: 'wrapping' };
    await h.w.postWrap({});

    assert.equal(h.streams().length, 1);
    const es = h.streams()[0];
    assert.equal(es.url, `/api/sessions/demo/wrap/stream/${RUN}`, 'the stream is the run the POST claimed — no discovery probe');
    assert.deepEqual(Object.keys(es.listeners).sort(), [...h.sandbox.tcWrapStreamEvents.WRAP_STREAM_EVENT_TYPES].sort(),
      'subscribed by the declared vocabulary');
    assert.equal(h.count('renderLiveWrapDrawer'), 1, 'the drawer opens on acceptance');

    es.emit('run-start', { steps: [{ stepId: 'preflight', kind: 'preflight' }] });
    es.emit('step-start', { stepId: 'preflight', kind: 'preflight' });
    assert.equal(h.count('renderLiveWrapDrawer'), 3, 'every frame repaints the live rows');
    assert.equal(h.last('renderLiveWrapDrawer')[0].results[0].status, 'running');

    es.emit('run-done', { result: BLOCKED_RESULT });
    assert.equal(h.count('openWrapDrawer'), 1);
    assert.equal(h.last('openWrapDrawer')[0].blockedAt, 'test');
    assert.equal(es.closed, true, 'the stream closes on the terminal frame');
    assert.equal(h.count('clearWrappingState'), 1, 'a blocked run gives the operator their buttons back');
    assert.equal(h.storage.get('tc.wrap.followedRun.demo'), RUN, 'the tab remembers the run whose report is open');

    // A duplicate terminal signal must not redraw the report: that would wipe
    // the decision widget's inputs under the operator.
    h.w.dispatchWrapRun({ type: 'status', runId: RUN, status: { runId: RUN, running: false, result: BLOCKED_RESULT } });
    assert.equal(h.count('openWrapDrawer'), 1);
  });

  it('#1312 — Retry resets the drawer to pending rows under "Retrying" and follows the NEW run', async () => {
    await wrapToBlocked(h);
    h.w.setPassword('pw');
    const paintsBefore = h.count('renderLiveWrapDrawer');

    let resolvePost;
    h.sandbox.apiMutate = (url, method, body) => {
      h.calls.push({ name: 'apiMutate', args: [url, method, body] });
      return new Promise((resolve) => { resolvePost = resolve; });
    };
    const retrying = h.w.retryWrap();
    await h.tick();
    assert.equal(h.last('apiMutate')[2].password, 'pw', 'the password replays on retry (M1)');
    assert.equal(h.count('renderLiveWrapDrawer'), paintsBefore, 'while only the request is out, the report stays');

    resolvePost({ ok: true, runId: RETRY_RUN, status: 'wrapping' });
    await retrying;

    const [live, opts] = h.last('renderLiveWrapDrawer');
    assert.equal(opts.retry, true, 'the banner says Retrying');
    assert.deepEqual(live.results.map((r) => [r.stepId, r.status]),
      [['preflight', 'pending'], ['test', 'pending'], ['commit', 'pending']],
      'the red verdict is gone and every step is back to pending — nothing claims to be running yet');
    assert.equal(h.sandbox.tcWrapDrawerHelpers.summarizeLiveStatus(live, opts).label, 'Retrying — starting…');

    const streams = h.streams();
    assert.equal(streams.length, 2);
    assert.equal(streams[1].url, `/api/sessions/demo/wrap/stream/${RETRY_RUN}`);

    streams[1].emit('run-start', { steps: [{ stepId: 'preflight', kind: 'preflight' }, { stepId: 'test', kind: 'test' }, { stepId: 'commit', kind: 'commit' }] });
    streams[1].emit('step-start', { stepId: 'preflight', kind: 'preflight' });
    const moving = h.last('renderLiveWrapDrawer')[0];
    assert.equal(moving.results[0].status, 'running', 'and the rows move as the new run streams');
    assert.equal(h.sandbox.tcWrapDrawerHelpers.summarizeLiveStatus(moving, h.last('renderLiveWrapDrawer')[1]).label,
      'Retrying — step 1 of 3');
  });

  it('a late frame from the previous run cannot repaint the one being followed', async () => {
    await wrapToBlocked(h);
    const old = h.streams()[0];
    h.net.post = { ok: true, runId: RETRY_RUN };
    await h.w.retryWrap();
    const paints = h.count('renderLiveWrapDrawer');
    old.listeners['step-start']({ data: JSON.stringify({ stepId: 'test', kind: 'test' }) });
    assert.equal(h.count('renderLiveWrapDrawer'), paints);
  });

  it('a refused Retry paints the server\'s reason on the report and follows nothing', async () => {
    await wrapToBlocked(h);
    h.net.post = null;
    h.sandbox.api.lastError = 'Incorrect password';
    h.net.status = { runId: RUN, running: false, finishedAt: 1, result: BLOCKED_RESULT };
    await h.w.retryWrap();
    assert.deepEqual(h.last('renderWrapDrawerError'), ['Incorrect password']);
    assert.equal(h.streams().length, 1, 'no stream opened for a run that was never claimed');
    assert.equal(h.w.wrapRunState().phase, 'refused');
    assert.equal(h.count('clearWrappingState'), 2, 'the wrapping chrome clears again');

    // …and Retry is still available from there.
    h.net.post = { ok: true, runId: RETRY_RUN };
    await h.w.retryWrap();
    assert.equal(h.w.wrapRunState().phase, 'following');
    assert.equal(h.last('renderLiveWrapDrawer')[1].retry, true);
  });

  it('#1406 — Retry sends the Include / Leave choices and keeps an earlier answer the list no longer shows', async () => {
    await wrapToBlocked(h);
    // An answer from a previous retry, for a file the drawer is no longer asking about.
    h.sandbox.wrapPathDecisions['earlier.js'] = 'include';
    const radios = [
      { dataset: { path: 'shared.js' }, value: 'leave' },
      { dataset: { path: 'notes.md' }, value: 'include' }
    ];
    h.sandbox.document.getElementById = () => ({
      disabled: false,
      classList: { add() {}, remove() {} },
      querySelector: () => null,
      querySelectorAll: (sel) => (sel.includes('wrap-decision-pathlist') ? radios : [])
    });
    h.net.post = { ok: true, runId: RETRY_RUN, status: 'wrapping' };
    await h.w.retryWrap();
    // Through JSON: the object was built inside the vm context, so its prototype
    // is that realm's and a strict deep-equal against this realm's literal fails.
    assert.deepEqual(JSON.parse(JSON.stringify(h.last('apiMutate')[2].options.pathDecisions)),
      { 'earlier.js': 'include', 'shared.js': 'leave', 'notes.md': 'include' });
  });

  it('#1229 — Retry sends "Wrap anyway", and a later retry keeps it', async () => {
    await wrapToBlocked(h);
    const ticked = { checked: true, dataset: {} };
    h.sandbox.document.getElementById = () => ({
      disabled: false,
      classList: { add() {}, remove() {} },
      querySelector: (sel) => (sel.includes('skipPreflight') ? ticked : null),
      querySelectorAll: () => []
    });
    h.net.post = { ok: true, runId: RETRY_RUN, status: 'wrapping' };
    await h.w.retryWrap();
    assert.equal(h.last('apiMutate')[2].options.skipPreflight, true, 'the ticked box reaches the server');

    // The retried run blocks at a later step; the box is no longer on screen.
    const es = h.streams().find((s) => s.url.endsWith(RETRY_RUN));
    es.emit('run-done', { result: { ...BLOCKED_RESULT, runId: RETRY_RUN } });
    h.sandbox.document.getElementById = () => ({
      disabled: false, classList: { add() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => []
    });
    h.net.post = { ok: true, runId: 'c'.repeat(32), status: 'wrapping' };
    await h.w.retryWrap();
    assert.equal(h.last('apiMutate')[2].options.skipPreflight, true, 'a retry re-runs preflight, so the choice must hold');
  });

  it('a 409 follows the run already in progress instead of reporting a failure', async () => {
    h.w.dispatchWrapRun({ type: 'start', retry: false });
    h.net.post = null;
    h.sandbox.api.lastError = 'A wrap is already running';
    h.net.status = { runId: RUN, running: true, result: null };
    assert.equal(await h.w.postWrap({}), true);
    assert.equal(h.w.wrapRunState().phase, 'following');
    assert.equal(h.streams()[0].url, `/api/sessions/demo/wrap/stream/${RUN}`);
    assert.equal(h.count('renderWrapDrawerError'), 0);
  });

  it('a stream that dies falls back to the status poll, which delivers the report', async () => {
    h.w.dispatchWrapRun({ type: 'start', retry: false });
    h.net.post = { ok: true, runId: RUN };
    await h.w.postWrap({});
    h.streams()[0].fail();
    assert.equal(h.last('renderLiveWrapDrawer')[1].streamLost, true, 'the banner says live progress is unavailable');
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 0, 'the first poll asks at once');

    h.net.status = { runId: RUN, running: true, result: null };
    await h.flushTimers();
    assert.equal(h.timers.length, 1, 'still running — polls again');
    assert.equal(h.timers[0].ms, 4000);

    h.net.status = { runId: RUN, running: false, finishedAt: 2, result: BLOCKED_RESULT };
    await h.flushTimers();
    assert.equal(h.count('openWrapDrawer'), 1, 'the report arrives without the stream');
    assert.equal(h.timers.filter((t) => !t.cleared).length, 0, 'and polling stops');
  });

  it('a poll that finds another run (or none) reports the followed run as lost, not as failed', async () => {
    h.w.dispatchWrapRun({ type: 'follow', runId: RUN });
    h.streams()[0].fail();
    h.net.status = { runId: null, running: false, result: null };
    await h.flushTimers();
    assert.match(h.last('openWrapDrawerNotice')[0], /did not survive a server restart/);
  });

  it('a wedged run is reported as stalled, never as dead', async () => {
    h.w.dispatchWrapRun({ type: 'follow', runId: RUN });
    h.streams()[0].emit('run-done', { stale: true, result: null });
    assert.equal(h.last('openWrapDrawerNotice')[0], 'Wrap stopped reporting');
  });

  it('closing the drawer mid-run keeps following; the report re-opens it', async () => {
    h.w.dispatchWrapRun({ type: 'follow', runId: RUN });
    h.w.closeWrapDrawer();
    assert.equal(h.count('hideWrapDrawer'), 1);
    assert.equal(h.streams()[0].closed, false, 'hiding is not stopping');
    h.streams()[0].emit('step-start', { stepId: 'preflight', kind: 'preflight' });
    assert.equal(h.count('renderLiveWrapDrawer'), 1, 'a hidden live drawer is not repainted open');
    h.streams()[0].emit('run-done', { result: BLOCKED_RESULT });
    assert.equal(h.count('openWrapDrawer'), 1, 'the report re-opens the drawer');
  });

  it('closing a finished report lets it go: idle, password and remembered run cleared', async () => {
    await wrapToBlocked(h);
    h.w.setPassword('pw');
    h.w.closeWrapDrawer();
    assert.equal(h.w.wrapRunState().phase, 'idle');
    assert.equal(h.w.getPassword(), '');
    assert.equal(h.storage.has('tc.wrap.followedRun.demo'), false);
  });

  describe('page-load restore', () => {
    it('follows a running run', async () => {
      h.net.status = { runId: RUN, running: true, result: null };
      await h.w.restoreWrapRunOnLoad();
      assert.equal(h.w.wrapRunState().phase, 'following');
    });

    it('follows a finished run only when this tab was following it', async () => {
      h.net.status = { runId: RUN, running: false, result: BLOCKED_RESULT };
      await h.w.restoreWrapRunOnLoad();
      assert.equal(h.w.wrapRunState().phase, 'idle', 'another page\'s old report is not resurfaced');

      h.storage.set('tc.wrap.followedRun.demo', RUN);
      await h.w.restoreWrapRunOnLoad();
      assert.equal(h.w.wrapRunState().phase, 'following');
      assert.equal(h.streams()[0].url, `/api/sessions/demo/wrap/stream/${RUN}`,
        'the stream replays the finished run, ending in its report');
    });

    it('forgets a remembered run the server no longer holds', async () => {
      h.storage.set('tc.wrap.followedRun.demo', RUN);
      h.net.status = { runId: null, running: false, result: null };
      await h.w.restoreWrapRunOnLoad();
      assert.equal(h.w.wrapRunState().phase, 'idle');
      assert.equal(h.storage.has('tc.wrap.followedRun.demo'), false);
    });
  });
});

describe('the Wrap popover — toggle, handback and clock (#1312)', () => {
  let h;
  beforeEach(() => { h = harness(); });

  it('with no run, the Wrap button opens the wrap modal', () => {
    h.w.onWrapButtonClick();
    assert.equal(h.count('openWrapModal'), 1);
  });

  it('toggling a blocked report closed keeps it; the Wrap button re-opens it without re-rendering', async () => {
    await wrapToBlocked(h);
    assert.equal(h.count('openWrapDrawer'), 1);
    h.w.onWrapButtonClick();
    assert.equal(h.w.wrapRunState().phase, 'settled');
    assert.equal(h.w.wrapRunState().visible, false);
    assert.equal(h.count('collapseWrapDrawer'), 1);
    assert.equal(h.count('hideWrapDrawer'), 0, 'the report is kept, not cleared');
    assert.equal(h.storage.get('tc.wrap.followedRun.demo'), RUN, 'a reload still restores it');
    h.w.onWrapButtonClick();
    assert.equal(h.w.wrapRunState().visible, true);
    assert.equal(h.count('expandWrapDrawer'), 1);
    assert.equal(h.count('openWrapDrawer'), 1, 'not re-rendered: the widgets keep the operator\'s choices');
    assert.equal(h.count('openWrapModal'), 0, 'never a second wrap while a report is held');
  });

  it('the × (collapseWrapPopover) during a live run keeps following, and the button shows it again', async () => {
    h.w.dispatchWrapRun({ type: 'follow', runId: RUN });
    h.w.collapseWrapPopover();
    assert.equal(h.w.wrapRunState().phase, 'following');
    assert.equal(h.streams()[0].closed, false);
    h.w.onWrapButtonClick();
    assert.equal(h.w.wrapRunState().visible, true);
  });

  it('a blocked run settling reads the handback from /wrap/status, watches its stream, and stops when it is ready', async () => {
    h.net.status = { runId: RUN, running: false, result: BLOCKED_RESULT, handback: { handbackId: 'hb1', stepId: 'test', state: 'working', startedAt: 1 } };
    await wrapToBlocked(h);
    await h.tick();
    assert.equal(h.w.wrapRunState().handback.state, 'working');
    const hbStream = h.streams().find((es) => es.url.endsWith('/wrap/handback/stream/hb1'));
    assert.ok(hbStream, 'the handback stream is opened');
    hbStream.emit('handback-done', { handbackId: 'hb1', stepId: 'test', state: 'ready', completedVia: 'marker', startedAt: 1, finishedAt: 2 });
    assert.equal(h.w.wrapRunState().handback.state, 'ready');
    assert.equal(hbStream.closed, true, 'nothing left to watch');
    assert.ok(h.count('paintHandback') > 0);
  });

  it('a handback stream that dies while working falls back to /wrap/status', async () => {
    h.net.status = { runId: RUN, running: false, result: BLOCKED_RESULT, handback: { handbackId: 'hb2', stepId: 'test', state: 'working', startedAt: 1 } };
    await wrapToBlocked(h);
    await h.tick();
    const hbStream = h.streams().find((es) => es.url.endsWith('/hb2'));
    hbStream.fail();
    h.net.status = { ...h.net.status, handback: { ...h.net.status.handback, state: 'timed-out', error: 'no line' } };
    await h.flushTimers();
    assert.equal(h.w.wrapRunState().handback.state, 'timed-out');
  });

  it('dismissing the run stops watching its handback', async () => {
    h.net.status = { runId: RUN, running: false, result: BLOCKED_RESULT, handback: { handbackId: 'hb3', stepId: 'test', state: 'working', startedAt: 1 } };
    await wrapToBlocked(h);
    await h.tick();
    const hbStream = h.streams().find((es) => es.url.endsWith('/hb3'));
    h.w.closeWrapDrawer();
    assert.equal(hbStream.closed, true);
  });

  it('stream frames are stamped on arrival, so the live view measures the page clock against the server', async () => {
    h.w.dispatchWrapRun({ type: 'follow', runId: RUN });
    const es = h.streams()[0];
    const sentAt = Date.now() - 5_000; // the page's clock runs 5s ahead of the server's
    es.emit('run-start', { steps: [{ stepId: 'test', kind: 'test' }], at: sentAt, sentAt });
    const skew = h.w.wrapRunState().live.skewMs;
    assert.ok(Number.isFinite(skew), 'skew is estimated through the real subscription, not a fixture');
    assert.ok(skew >= 5_000 && skew < 6_000, `skew ${skew}`);
  });

  it('a quiet handback keeps its stream open; the server forgetting it clears it', async () => {
    h.net.status = { runId: RUN, running: false, result: BLOCKED_RESULT, handback: { handbackId: 'hb4', stepId: 'test', state: 'working', startedAt: 1 } };
    await wrapToBlocked(h);
    await h.tick();
    const hbStream = h.streams().find((es) => es.url.endsWith('/hb4'));
    hbStream.emit('handback-update', { handbackId: 'hb4', stepId: 'test', state: 'quiet', completedVia: 'quiet', startedAt: 1 });
    assert.equal(h.w.wrapRunState().handback.state, 'quiet');
    assert.equal(hbStream.closed, false, 'a quiet session may still print its line');

    // A server restart: the stream dies, and the status route no longer holds the handback.
    hbStream.fail();
    h.net.status = { runId: RUN, running: false, result: BLOCKED_RESULT, handback: null };
    await h.flushTimers();
    assert.equal(h.w.wrapRunState().handback, null, 'no "Fixing" for a watch nobody runs');
    await h.flushTimers();
    assert.equal(h.timers.filter((t) => !t.cleared).length, 0, 'and no poll left running for the life of the tab');
  });

  it('the clock runs only while a step or a fix is timed, and its tick only paints', async () => {
    h.w.dispatchWrapRun({ type: 'follow', runId: RUN });
    assert.equal(h.intervals.length, 0, 'no clock before a step has a start time');
    const es = h.streams()[0];
    es.emit('run-start', { steps: [{ stepId: 'test', kind: 'test' }], at: 1, sentAt: 1 });
    es.emit('step-start', { stepId: 'test', kind: 'test', at: 2, sentAt: 2 });
    assert.equal(h.intervals.filter((t) => !t.cleared).length, 1);
    es.emit('step-start', { stepId: 'test', kind: 'test', at: 3, sentAt: 3 });
    assert.equal(h.intervals.filter((t) => !t.cleared).length, 1, 'one clock, not one per frame');

    const before = h.w.wrapRunState();
    const callsBefore = h.calls.length;
    h.intervals[0].fn();
    const tickCalls = h.calls.slice(callsBefore).map((c) => c.name);
    assert.deepEqual([...new Set(tickCalls)].sort(), ['paintHandback', 'paintLiveTiming', 'paintWrapButton']);
    assert.equal(h.w.wrapRunState(), before, 'a tick sends the controller nothing');

    es.emit('run-done', { result: BLOCKED_RESULT });
    assert.equal(h.intervals.filter((t) => !t.cleared).length, 0, 'the clock stops when nothing is timed');
  });
});
