'use strict';

/*
 * #185 — the client half of live wrap progress.
 *
 * Three layers, each executed. The pure event-folding helpers in
 * `public/wrap-drawer.js` (`applyWrapStreamEvent`, `summarizeLiveStatus`,
 * `liveWrapAsPipelineResult`, `wrapStreamUrl`) load into a vm sandbox and are
 * driven directly, the way test/wrap-drawer.test.js drives their siblings.
 * `startWrapStream` and `renderLiveWrapDrawer` are lifted out of
 * `public/session.js` and run here on their own (#1219): the stream client
 * against a fake `EventSource` with a recording `dispatchWrapRun`, the live
 * drawer against the shared mini-DOM with its paint primitives recorded. How
 * the two meet the wrap-run controller — the POST, `run-done` closing the
 * stream and handing off to `openWrapDrawer`, the status fallback — is
 * executed end to end in test/wrap-run-session-wiring.test.js. The source pins
 * left here guard text and styles, not behaviour.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');
const { liftDeclaration, liftBody } = require('./helpers/lift');

const PUBLIC = path.join(__dirname, '..', 'public');

/**
 * Load `public/wrap-drawer.js` into a sandbox and return its helper namespace.
 * @returns {object}
 */
function loadHelpers() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'wrap-drawer.js'), 'utf8'), sandbox);
  return sandbox.window.tcWrapDrawerHelpers;
}

/**
 * Strip vm-context prototype identity so deepEqual compares structurally.
 * @template T
 * @param {T} v
 * @returns {T}
 */
function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

const RUN_START = {
  type: 'run-start',
  steps: [
    { stepId: 'open-pr-check', kind: 'pr-check' },
    { stepId: 'changelog-update', kind: 'ai-content' },
    { stepId: 'commit', kind: 'commit' }
  ]
};

describe('wrap-drawer helpers — applyWrapStreamEvent (#185)', () => {
  const H = loadHelpers();

  it('run-start paints every announced step as a pending row, in order', () => {
    const live = H.applyWrapStreamEvent(null, RUN_START);
    assert.equal(live.started, true);
    assert.deepEqual(plain(live.results), [
      { stepId: 'open-pr-check', kind: 'pr-check', status: 'pending', output: null, blockers: [] },
      { stepId: 'changelog-update', kind: 'ai-content', status: 'pending', output: null, blockers: [] },
      { stepId: 'commit', kind: 'commit', status: 'pending', output: null, blockers: [] }
    ]);
    assert.equal(live.blockedAt, null);
    assert.equal(live.done, false);
  });

  it('step-start turns the row running — the tone the drawer reserved and nothing produced before', () => {
    let live = H.applyWrapStreamEvent(null, RUN_START);
    live = H.applyWrapStreamEvent(live, { type: 'step-start', stepId: 'open-pr-check', kind: 'pr-check' });
    assert.equal(live.results[0].status, 'running');
    assert.equal(live.currentStepId, 'open-pr-check');
    const row = H.buildStepRow(live.results[0], { blockedAt: live.blockedAt });
    assert.equal(row.statusTone, 'running');
    assert.equal(row.statusLabel, 'Running');
  });

  it('step-done settles the row with the runner\'s status, output and blockers, and clears the pointer', () => {
    let live = H.applyWrapStreamEvent(null, RUN_START);
    live = H.applyWrapStreamEvent(live, { type: 'step-start', stepId: 'open-pr-check', kind: 'pr-check' });
    live = H.applyWrapStreamEvent(live, {
      type: 'step-done', stepId: 'open-pr-check', kind: 'pr-check', status: 'done',
      output: { counts: { sessionScoped: 0, otherOpen: 2 } }, blockers: [], halted: false
    });
    assert.equal(live.results[0].status, 'done');
    assert.equal(live.currentStepId, null);
    assert.equal(live.blockedAt, null);
    // The live row renders through the same detail derivation as the final one.
    assert.equal(H.buildStepRow(live.results[0], {}).detail, '2 other open');
    // A skipped step arrives as step-done with the skip status, and reads as such.
    live = H.applyWrapStreamEvent(live, {
      type: 'step-done', stepId: 'changelog-update', kind: 'ai-content', status: 'skipped',
      output: { reason: 'disabled for this project' }, blockers: [], halted: false
    });
    assert.equal(H.buildStepRow(live.results[1], {}).detail, 'disabled for this project');
  });

  it('step-blocked with halted:true marks the run stopped there, and the row is THE blocker', () => {
    let live = H.applyWrapStreamEvent(null, RUN_START);
    live = H.applyWrapStreamEvent(live, { type: 'step-start', stepId: 'changelog-update', kind: 'ai-content' });
    live = H.applyWrapStreamEvent(live, {
      type: 'step-blocked', stepId: 'changelog-update', kind: 'ai-content', status: 'blocked',
      output: null, blockers: ['no CHANGELOG entry'], halted: true
    });
    assert.equal(live.blockedAt, 'changelog-update');
    const row = H.buildStepRow(live.results[1], { blockedAt: live.blockedAt });
    assert.equal(row.isBlocker, true);
    assert.deepEqual(plain(row.blockers), ['no CHANGELOG entry']);
    // Later rows stay pending: the stream sends nothing for steps that never run.
    assert.equal(live.results[2].status, 'pending');
  });

  it('step-blocked with halted:false records the failure without stopping the run', () => {
    let live = H.applyWrapStreamEvent(null, RUN_START);
    live = H.applyWrapStreamEvent(live, {
      type: 'step-blocked', stepId: 'open-pr-check', kind: 'pr-check', status: 'blocked',
      output: null, blockers: ['gh unreachable'], halted: false
    });
    assert.equal(live.results[0].status, 'blocked');
    assert.equal(live.blockedAt, null, 'a non-halting failure must not read as the pipeline stopping');
    assert.equal(H.buildStepRow(live.results[0], { blockedAt: live.blockedAt }).isBlocker, false);
  });

  it('run-done marks the run over and keeps the result payload the caller renders', () => {
    let live = H.applyWrapStreamEvent(null, RUN_START);
    const result = { ok: true, status: 'wrapping', pipelineResult: { ok: true, results: [] } };
    live = H.applyWrapStreamEvent(live, { type: 'run-done', result });
    assert.equal(live.done, true);
    assert.deepEqual(plain(live.result), result);
  });

  it('is pure — the prior state is never mutated', () => {
    const first = H.applyWrapStreamEvent(null, RUN_START);
    const snapshot = plain(first);
    H.applyWrapStreamEvent(first, { type: 'step-start', stepId: 'commit', kind: 'commit' });
    assert.deepEqual(plain(first), snapshot);
  });

  it('tolerates a step the run never announced, a null state, an unknown type and a malformed event', () => {
    let live = H.applyWrapStreamEvent(null, { type: 'step-start', stepId: 'surprise', kind: 'test' });
    assert.equal(live.results.length, 1, 'an unannounced step gets a row rather than a dropped event');
    assert.equal(live.results[0].status, 'running');
    const before = plain(live);
    live = H.applyWrapStreamEvent(live, { type: 'not-a-thing' });
    assert.deepEqual(plain(live), before);
    live = H.applyWrapStreamEvent(live, null);
    assert.deepEqual(plain(live), before);
    live = H.applyWrapStreamEvent(live, { type: 'step-done' }); // no stepId
    assert.deepEqual(plain(live), before);
  });
});

describe('wrap-drawer helpers — live banner + report (#185)', () => {
  const H = loadHelpers();

  it('says starting before the run announces itself, then which step of how many', () => {
    assert.deepEqual(plain(H.summarizeLiveStatus(null)), { label: 'Wrapping — starting…', tone: 'running', detail: null });
    let live = H.applyWrapStreamEvent(null, RUN_START);
    live = H.applyWrapStreamEvent(live, { type: 'step-start', stepId: 'changelog-update', kind: 'ai-content' });
    const status = H.summarizeLiveStatus(live);
    assert.equal(status.label, 'Wrapping — step 2 of 3');
    assert.equal(status.detail, 'AI content (changelog-update)');
    assert.equal(status.tone, 'running', 'a live wrap has no verdict; it never paints success or failure');
  });

  it('names a mid-stream halt without pronouncing on it, and counts settled steps between steps', () => {
    let live = H.applyWrapStreamEvent(null, RUN_START);
    live = H.applyWrapStreamEvent(live, { type: 'step-done', stepId: 'open-pr-check', kind: 'pr-check', status: 'done', output: null, blockers: [], halted: false });
    assert.equal(H.summarizeLiveStatus(live).label, 'Wrapping — 1 of 3 steps settled');
    live = H.applyWrapStreamEvent(live, { type: 'step-blocked', stepId: 'changelog-update', kind: 'ai-content', status: 'blocked', output: null, blockers: ['x'], halted: true });
    const halted = H.summarizeLiveStatus(live);
    assert.equal(halted.label, 'Wrapping — stopped at "changelog-update"');
    assert.equal(halted.tone, 'running');
  });

  it('a Retry\'s run says Retrying at every stage, so it is not mistaken for the report it replaced', () => {
    assert.equal(H.summarizeLiveStatus(null, { retry: true }).label, 'Retrying — starting…');
    let live = H.applyWrapStreamEvent(null, RUN_START);
    live = H.applyWrapStreamEvent(live, { type: 'step-start', stepId: 'changelog-update', kind: 'ai-content' });
    assert.equal(H.summarizeLiveStatus(live, { retry: true }).label, 'Retrying — step 2 of 3');
    assert.equal(H.summarizeLiveStatus(live, { retry: true }).tone, 'running');
    assert.equal(H.summarizeLiveStatus(live).label, 'Wrapping — step 2 of 3', 'and a first wrap still says Wrapping');
  });

  it('the unavailable banner keeps the running tone and says the report still arrives', () => {
    const s = H.streamUnavailableStatus();
    assert.equal(s.tone, 'running');
    assert.match(s.detail, /still running/);
  });

  it('the live view renders as a pipelineResult, so Copy report serialises the run so far', () => {
    let live = H.applyWrapStreamEvent(null, RUN_START);
    live = H.applyWrapStreamEvent(live, { type: 'step-done', stepId: 'open-pr-check', kind: 'pr-check', status: 'done', output: null, blockers: [], halted: false });
    live = H.applyWrapStreamEvent(live, { type: 'step-start', stepId: 'changelog-update', kind: 'ai-content' });
    const asResult = H.liveWrapAsPipelineResult(live);
    assert.equal(asResult.ok, true);
    assert.equal(asResult.commitSha, null, 'nothing has committed until the final result says so');
    const report = H.buildReportText(asResult, H.summarizeLiveStatus(live));
    assert.match(report, /^Session Wrap — Wrapping — step 2 of 3/);
    assert.match(report, /\[Done\] Check open PRs — open-pr-check/);
    assert.match(report, /\[Running\] AI content — changelog-update/);
    assert.match(report, /\[Pending\] Commit — commit/);
  });

  it('builds the stream URL the way the other wrap routes are addressed', () => {
    assert.equal(H.wrapStreamUrl('my project', 'abc123'), '/api/sessions/my%20project/wrap/stream/abc123');
  });
});

describe('wrap-drawer helpers — a Retry that reuses steps does not read as a restart (#1515)', () => {
  const H = loadHelpers();
  const RETRY_START = {
    type: 'run-start',
    steps: [
      { stepId: 'open-pr-check', kind: 'pr-check' },
      { stepId: 'changelog-update', kind: 'ai-content', reused: true },
      { stepId: 'version-bump', kind: 'version-bump' }
    ]
  };

  it('run-start marks the announced reused rows, and only those', () => {
    const live = H.applyWrapStreamEvent(null, RETRY_START);
    assert.equal(live.results[1].reused, true);
    assert.ok(!('reused' in live.results[0]));
    assert.ok(!('reused' in live.results[2]));
    const rows = H.liveWrapAsPipelineResult(live).results.map((r) => H.buildStepRow(r, {}));
    assert.equal(rows[1].statusLabel, 'Will reuse');
    assert.equal(rows[1].statusTone, 'reused');
    assert.equal(rows[1].reused, true);
    assert.match(rows[1].detail, /reused from the halted attempt/);
    assert.equal(rows[0].statusLabel, 'Pending', 'a step the Retry actually runs still reads pending');
    assert.equal(rows[0].reused, false);
  });

  it('the reused step keeps its mark while it runs and settles as Reused, driven by the resumed flag', () => {
    // The producer's sequence for a reused step: step-start, then step-done
    // carrying output.resumed — no other frame.
    let live = H.applyWrapStreamEvent(null, RETRY_START);
    live = H.applyWrapStreamEvent(live, { type: 'step-start', stepId: 'changelog-update', kind: 'ai-content' });
    const running = H.buildStepRow(H.liveWrapAsPipelineResult(live).results[1], {});
    assert.equal(running.statusLabel, 'Running', 'no badge gets ahead of the server');
    live = H.applyWrapStreamEvent(live, {
      type: 'step-done', stepId: 'changelog-update', kind: 'ai-content', status: 'done',
      output: { capturedText: 'x', parsedFields: { entry: 'e' }, resumed: true, capturedAt: 1 }, blockers: [], halted: false
    });
    const row = H.buildStepRow(H.liveWrapAsPipelineResult(live).results[1], {});
    assert.equal(row.statusLabel, 'Reused');
    assert.equal(row.statusTone, 'reused');
    assert.equal(row.detail, 'captured 1 field · reused from the halted attempt, not re-asked');
    const report = H.buildReportText(H.liveWrapAsPipelineResult(live), H.summarizeLiveStatus(live, { retry: true }));
    assert.match(report, /\[Reused\] AI content — changelog-update/);
  });

  it('the final report renders a reused step as Reused from its output alone', () => {
    const row = H.buildStepRow({ stepId: 'memory-update', kind: 'ai-content', status: 'done', output: { capturedText: 'm', resumed: true }, blockers: [] }, {});
    assert.equal(row.statusLabel, 'Reused');
    assert.equal(row.reused, true);
  });

  it('a Retry with nothing to reuse renders exactly as before', () => {
    const plainStart = { type: 'run-start', steps: RETRY_START.steps.map(({ stepId, kind }) => ({ stepId, kind })) };
    const live = H.applyWrapStreamEvent(null, plainStart);
    for (const r of H.liveWrapAsPipelineResult(live).results) {
      const row = H.buildStepRow(r, {});
      assert.equal(row.statusLabel, 'Pending');
      assert.equal(row.statusTone, 'pending');
      assert.equal(row.reused, false);
      assert.equal(row.detail, null);
    }
    const fresh = H.buildStepRow({ stepId: 'memory-update', kind: 'ai-content', status: 'done', output: { capturedText: 'm' }, blockers: [] }, {});
    assert.equal(fresh.statusLabel, 'Done');
    assert.equal(fresh.detail, 'captured');
  });

  it('the reused tone and row are styled, and session.js marks the row', () => {
    const css = fs.readFileSync(path.join(PUBLIC, 'session.css'), 'utf8');
    assert.ok(css.includes('.wrap-step-status--reused {'));
    assert.ok(css.includes('.wrap-step-row--reused'));
    const body = liftBody(fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8'), 'function renderStepRow(');
    assert.ok(body.includes("classList.add('wrap-step-row--reused')"));
  });
});

describe('session.js wiring (#185)', () => {
  let src;

  before(() => {
    src = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');
  });

  it('the stale "no client was ever written" record is gone, with the phantom call it described', () => {
    assert.ok(!src.includes('startWrapSse'), 'the undefined call must not return');
    assert.ok(!src.includes('no client was ever written'));
    assert.ok(!src.includes('removed in the #990 review'), 'the comment describing the removed server half is stale now that both halves exist');
  });

  it('the running tone the live rows use is styled', () => {
    const css = fs.readFileSync(path.join(PUBLIC, 'session.css'), 'utf8');
    assert.ok(css.includes('.wrap-step-status--running {'));
    assert.ok(css.includes('.wrap-drawer-status--running'));
  });
});

const SESSION_SRC = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');

/**
 * Stand-in for the browser's `EventSource`: records its URL and listeners, and
 * lets a test deliver a named frame or move `readyState` the way a dropped or
 * closed connection would.
 */
class FakeEventSource {
  /** @param {string} url - The stream URL the client opened. */
  constructor(url) {
    this.url = url;
    this.readyState = FakeEventSource.CONNECTING;
    this.listeners = {};
    this.onerror = null;
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  /**
   * @param {string} type - Event name.
   * @param {Function} fn - Listener.
   */
  addEventListener(type, fn) {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  }

  /**
   * Deliver one frame to the listeners for `type`, as the browser would.
   * @param {string} type - Event name.
   * @param {string} data - The frame's raw `data`.
   */
  emit(type, data) {
    for (const fn of this.listeners[type] || []) fn({ data });
  }

  /** Close the connection. */
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}
FakeEventSource.CONNECTING = 0;
FakeEventSource.OPEN = 1;
FakeEventSource.CLOSED = 2;
FakeEventSource.instances = [];

/**
 * Run the real `startWrapStream` / `stopWrapStream` on their own, with the
 * shipped event vocabulary and helpers, a recording `dispatchWrapRun` and a
 * recording `console.warn`.
 *
 * @param {{eventSource?: boolean}} [opts] - `eventSource: false` models a
 *   browser that has no `EventSource`.
 * @returns {{sandbox: object, signals: object[], warns: Array<Array<*>>, streams: FakeEventSource[], state: () => {stream: *, runId: *}}}
 */
function loadStreamClient({ eventSource = true } = {}) {
  FakeEventSource.instances = [];
  const signals = [];
  const warns = [];
  const sandbox = {
    projectName: 'my project',
    dispatchWrapRun: (signal) => { signals.push(signal); },
    console: { warn: (...args) => { warns.push(args); } }
  };
  sandbox.window = sandbox;
  if (eventSource) sandbox.EventSource = FakeEventSource;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'wrap-stream-events.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'wrap-drawer.js'), 'utf8'), sandbox);
  vm.runInContext([
    'let currentWrapStream = null;',
    'let currentWrapStreamRunId = null;',
    liftDeclaration(SESSION_SRC, 'function startWrapStream('),
    liftDeclaration(SESSION_SRC, 'function stopWrapStream('),
    'globalThis.__state = () => ({ stream: currentWrapStream, runId: currentWrapStreamRunId });'
  ].join('\n'), sandbox);
  return { sandbox, signals, warns, streams: FakeEventSource.instances, state: () => sandbox.__state() };
}

describe('startWrapStream, executed (#1219)', () => {
  it('opens the run\'s stream URL and subscribes exactly one listener per declared event type', () => {
    const h = loadStreamClient();
    h.sandbox.startWrapStream('run-1');
    assert.equal(h.streams.length, 1);
    const [es] = h.streams;
    assert.equal(es.url, h.sandbox.tcWrapDrawerHelpers.wrapStreamUrl('my project', 'run-1'));
    const declared = [...h.sandbox.tcWrapStreamEvents.WRAP_STREAM_EVENT_TYPES];
    assert.deepEqual(Object.keys(es.listeners).sort(), [...declared].sort());
    for (const type of declared) assert.equal(es.listeners[type].length, 1, `one listener for ${type}`);
    assert.equal(h.state().stream, es);
    assert.equal(h.state().runId, 'run-1');
  });

  it('every declared type dispatches exactly one event signal with the frame, its type and a numeric receivedAt', () => {
    const h = loadStreamClient();
    h.sandbox.startWrapStream('run-1');
    const [es] = h.streams;
    for (const type of h.sandbox.tcWrapStreamEvents.WRAP_STREAM_EVENT_TYPES) {
      h.signals.length = 0;
      // The listener's name is the frame's type: a `type` inside the data never overrides it.
      es.emit(type, JSON.stringify({ stepId: 'commit', sentAt: 5, type: 'spoofed' }));
      assert.equal(h.signals.length, 1, `${type} dispatches once`);
      const [signal] = plain(h.signals);
      assert.equal(typeof h.signals[0].event.receivedAt, 'number');
      assert.deepEqual(signal, {
        type: 'event',
        runId: 'run-1',
        event: { stepId: 'commit', sentAt: 5, type, receivedAt: h.signals[0].event.receivedAt }
      });
    }
    assert.equal(h.warns.length, 0);
  });

  it('a superseded stream is ignored on every handler and on onerror; the current one still dispatches', () => {
    const h = loadStreamClient();
    h.sandbox.startWrapStream('run-1');
    const [stale] = h.streams;
    h.sandbox.startWrapStream('run-2');
    assert.equal(stale.closed, true, 'starting a new stream closes the old one');
    const current = h.streams[1];
    for (const type of h.sandbox.tcWrapStreamEvents.WRAP_STREAM_EVENT_TYPES) {
      stale.emit(type, JSON.stringify({ stepId: 'commit' }));
    }
    stale.readyState = FakeEventSource.CLOSED;
    stale.onerror();
    assert.equal(h.signals.length, 0, 'nothing from the superseded stream reaches the controller');
    assert.equal(h.warns.length, 0);
    current.emit('run-start', JSON.stringify({ steps: [] }));
    assert.equal(h.signals.length, 1);
    assert.equal(h.signals[0].runId, 'run-2');
  });

  it('onerror while reconnecting dispatches nothing and keeps the stream; CLOSED dispatches stream-lost once', () => {
    const h = loadStreamClient();
    h.sandbox.startWrapStream('run-1');
    const [es] = h.streams;
    for (const state of [FakeEventSource.CONNECTING, FakeEventSource.OPEN]) {
      es.readyState = state;
      es.onerror();
    }
    assert.equal(h.signals.length, 0);
    assert.equal(es.closed, false);
    assert.equal(h.state().stream, es, 'the client keeps the source the browser is reconnecting');
    es.readyState = FakeEventSource.CLOSED;
    es.onerror();
    assert.deepEqual(plain(h.signals), [{ type: 'stream-lost', runId: 'run-1' }]);
    assert.equal(h.warns.length, 1, 'a closed stream says so once');
  });

  it('a malformed frame is warned about and dropped, and later frames still dispatch', () => {
    const h = loadStreamClient();
    h.sandbox.startWrapStream('run-1');
    const [es] = h.streams;
    es.emit('step-start', '{not json');
    assert.equal(h.signals.length, 0);
    assert.equal(h.warns.length, 1);
    assert.match(h.warns[0][0], /malformed frame/);
    assert.deepEqual(plain(h.warns[0][1]), { type: 'step-start' });
    es.emit('step-start', JSON.stringify({ stepId: 'commit' }));
    assert.equal(h.signals.length, 1);
    assert.equal(h.signals[0].event.stepId, 'commit');
  });

  it('stopWrapStream closes the stream, forgets the run, and is idempotent', () => {
    const h = loadStreamClient();
    h.sandbox.startWrapStream('run-1');
    const [es] = h.streams;
    h.sandbox.stopWrapStream();
    assert.equal(es.closed, true);
    assert.deepEqual(plain(h.state()), { stream: null, runId: null });
    h.sandbox.stopWrapStream();
    assert.deepEqual(plain(h.state()), { stream: null, runId: null });
    es.emit('step-start', JSON.stringify({ stepId: 'commit' }));
    assert.equal(h.signals.length, 0, 'a stopped stream reaches nobody');
  });

  it('with no EventSource it opens nothing and dispatches stream-lost after a microtask', async () => {
    const h = loadStreamClient({ eventSource: false });
    h.sandbox.startWrapStream('run-1');
    assert.equal(h.streams.length, 0);
    assert.equal(h.signals.length, 0, 'not synchronously: the caller finishes starting the run first');
    await Promise.resolve();
    assert.deepEqual(plain(h.signals), [{ type: 'stream-lost', runId: 'run-1' }]);
    assert.deepEqual(plain(h.state()), { stream: null, runId: 'run-1' });
  });
});

const LIVE_DRAWER_IDS = [
  'wrapDrawerSkipRoll', 'wrapStepList', 'wrapDrawerDecision', 'wrapDrawerRetryBtn', 'wrapDrawerDoneBtn',
  'wrapDrawerCancelBtn', 'wrapDrawerPlanned', 'wrapDrawerAbortBtn', 'wrapDrawerCancelNote'
];

/**
 * Run the real `renderLiveWrapDrawer` and `paintLiveSessionControls` against
 * the mini-DOM, with the shipped helpers and recorders for the paint
 * primitives they call, so a test pins what the render itself decides.
 *
 * @param {{runId?: (string|null)}} [opts] - The run `wrapRunState()` reports.
 * @returns {{sandbox: object, ids: object, calls: Array<[string, Array<*>]>, H: object, state: () => object}}
 */
function loadLiveDrawer({ runId = 'run-1' } = {}) {
  const { doc, ids } = makeDocument(LIVE_DRAWER_IDS);
  // The three containers the render clears: a real repaint must empty them.
  for (const id of ['wrapDrawerSkipRoll', 'wrapStepList', 'wrapDrawerDecision']) withIdParsingInnerHTML(ids[id], doc);
  const calls = [];
  const record = (name, ret) => (...args) => { calls.push([name, args]); return ret ? ret(...args) : undefined; };
  const sandbox = {
    document: doc,
    sessionState: { wrapDrawerOpen: false },
    wrapRunState: () => ({ runId }),
    closeWrapModal: record('closeWrapModal'),
    paintWrapStatus: record('paintWrapStatus'),
    cancelEndedCountdown: record('cancelEndedCountdown'),
    paintLiveTiming: record('paintLiveTiming'),
    expandWrapDrawer: record('expandWrapDrawer'),
    renderStepRow: record('renderStepRow', (row) => {
      const el = doc.createElement('div');
      el.row = row;
      return el;
    })
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'wrap-drawer.js'), 'utf8'), sandbox);
  vm.runInContext([
    'let currentWrapPipelineResult = null;',
    "let currentWrapBaseStatus = 'a settled report';",
    'let wrapCancelState = { runId: null, requested: false, finishingStepId: null };',
    liftDeclaration(SESSION_SRC, 'function renderLiveWrapDrawer('),
    liftDeclaration(SESSION_SRC, 'function paintLiveSessionControls('),
    'globalThis.__state = () => ({ currentWrapPipelineResult, currentWrapBaseStatus, wrapCancelState });',
    'globalThis.__setCancel = (v) => { wrapCancelState = v; };'
  ].join('\n'), sandbox);
  return { sandbox, ids, calls, H: sandbox.tcWrapDrawerHelpers, state: () => sandbox.__state() };
}

/**
 * The live view after `run-start` and a `step-start` on the second step.
 * @param {object} H - `tcWrapDrawerHelpers`.
 * @param {object} [extra] - Extra `run-start` fields.
 * @returns {object}
 */
function runningLive(H, extra = {}) {
  const live = H.applyWrapStreamEvent(null, { ...RUN_START, ...extra });
  return H.applyWrapStreamEvent(live, { type: 'step-start', stepId: 'changelog-update', kind: 'ai-content' });
}

/**
 * The recorded calls to one primitive.
 * @param {Array<[string, Array<*>]>} calls - The recorder's log.
 * @param {string} name - Primitive name.
 * @returns {Array<Array<*>>} Each call's arguments.
 */
function callsTo(calls, name) {
  return calls.filter(([n]) => n === name).map(([, args]) => args);
}

describe('renderLiveWrapDrawer, executed (#1219)', () => {
  it('paints the live view: modal closed, banner, one row per step in order, and the drawer opened', () => {
    const h = loadLiveDrawer();
    const live = runningLive(h.H);
    h.sandbox.renderLiveWrapDrawer(live, { retry: false, streamLost: false });

    assert.deepEqual(callsTo(h.calls, 'closeWrapModal'), [[true]]);
    assert.deepEqual(plain(callsTo(h.calls, 'paintWrapStatus')), [[plain(h.H.summarizeLiveStatus(live, { retry: false })), null, null]]);
    const asResult = h.H.liveWrapAsPipelineResult(live);
    const rows = callsTo(h.calls, 'renderStepRow').map(([row]) => row);
    assert.deepEqual(plain(rows), plain(asResult.results.map((r) => h.H.buildStepRow(r, { blockedAt: asResult.blockedAt }))));
    assert.deepEqual(h.ids.wrapStepList.childNodes.map((el) => el.row), rows, 'the list holds exactly the rendered rows, in order');
    assert.deepEqual(plain(h.state().currentWrapPipelineResult), plain(asResult), 'Copy report serialises the run so far');
    assert.equal(h.state().currentWrapBaseStatus, null);
    assert.equal(h.sandbox.sessionState.wrapDrawerOpen, true);
    assert.equal(callsTo(h.calls, 'cancelEndedCountdown').length, 1);
    assert.deepEqual(h.calls.slice(-2).map(([n]) => n), ['paintLiveTiming', 'expandWrapDrawer']);
  });

  it('offers no decision while the run is live: Retry, Done, the decision and the skip roll are hidden, and Cancel reads Hide', () => {
    const h = loadLiveDrawer();
    h.ids.wrapDrawerDecision.innerHTML = '<div id="wrapDecisionPrompt"></div>';
    h.ids.wrapDrawerSkipRoll.innerHTML = '<div id="wrapSkipRollItem"></div>';
    h.sandbox.renderLiveWrapDrawer(runningLive(h.H), { retry: false, streamLost: false });

    for (const id of ['wrapDrawerRetryBtn', 'wrapDrawerDoneBtn', 'wrapDrawerDecision', 'wrapDrawerSkipRoll']) {
      assert.equal(h.ids[id].classList.contains('hidden'), true, `${id} hidden`);
    }
    for (const id of ['wrapDrawerDecision', 'wrapDrawerSkipRoll']) {
      assert.equal(h.ids[id].innerHTML, '');
      assert.equal(h.ids[id].childNodes.length, 0, `${id} emptied`);
    }
    assert.equal(h.ids.wrapDrawerCancelBtn.textContent, 'Hide');
    assert.equal(h.ids.wrapDrawerCancelBtn.title, 'Hide this panel. The wrap keeps running; the Wrap button reopens it.');
  });

  it('says Retrying for a Retry\'s run, and the unavailable banner once the stream is lost', () => {
    const h = loadLiveDrawer();
    const live = runningLive(h.H);
    h.sandbox.renderLiveWrapDrawer(live, { retry: true, streamLost: false });
    h.sandbox.renderLiveWrapDrawer(live, { retry: false, streamLost: true });
    h.sandbox.renderLiveWrapDrawer(live, { retry: true, streamLost: true });
    const banners = callsTo(h.calls, 'paintWrapStatus').map(([status]) => plain(status));
    assert.deepEqual(banners[0], plain(h.H.summarizeLiveStatus(live, { retry: true })));
    assert.equal(banners[0].label, 'Retrying — step 2 of 3');
    assert.deepEqual(banners[1], plain(h.H.streamUnavailableStatus()));
    assert.deepEqual(banners[2], plain(h.H.streamUnavailableStatus()), 'a lost stream outranks the Retry wording');
  });

  it('a second paint replaces the rows rather than appending to them', () => {
    const h = loadLiveDrawer();
    h.sandbox.renderLiveWrapDrawer(runningLive(h.H), { retry: false, streamLost: false });
    assert.equal(h.ids.wrapStepList.childNodes.length, 3);
    const twoSteps = h.H.applyWrapStreamEvent(null, { type: 'run-start', steps: RUN_START.steps.slice(0, 2) });
    h.sandbox.renderLiveWrapDrawer(twoSteps, { retry: false, streamLost: false });
    const secondRows = callsTo(h.calls, 'renderStepRow').slice(3).map(([row]) => row);
    assert.equal(secondRows.length, 2);
    assert.deepEqual(h.ids.wrapStepList.childNodes.map((el) => el.row), secondRows);
  });

  it('before run-start it paints the starting banner and no rows', () => {
    const h = loadLiveDrawer();
    h.sandbox.renderLiveWrapDrawer(null, { retry: false, streamLost: false });
    assert.deepEqual(plain(callsTo(h.calls, 'paintWrapStatus')[0][0]), plain(h.H.summarizeLiveStatus(null)));
    assert.equal(callsTo(h.calls, 'renderStepRow').length, 0);
    assert.equal(h.ids.wrapStepList.childNodes.length, 0);
    assert.deepEqual(plain(h.state().currentWrapPipelineResult.results), []);
  });

  it('the planned-session line and Abort control follow the helpers, and Abort is disabled with no run', () => {
    const h = loadLiveDrawer();
    const planned = runningLive(h.H, { sessionOutcomePlanned: 'keep', keepSource: 'request' });
    h.sandbox.renderLiveWrapDrawer(planned, { retry: false, streamLost: false });
    assert.equal(h.ids.wrapDrawerPlanned.textContent, h.H.plannedSessionLine(planned));
    assert.equal(h.ids.wrapDrawerPlanned.classList.contains('hidden'), false);
    const control = h.H.liveCancelControl(planned, { requested: false });
    assert.equal(h.ids.wrapDrawerAbortBtn.textContent, control.label);
    assert.equal(h.ids.wrapDrawerAbortBtn.disabled, false);
    assert.equal(h.ids.wrapDrawerAbortBtn.classList.contains('hidden'), false);
    assert.equal(h.ids.wrapDrawerCancelNote.classList.contains('hidden'), true);

    // A cancel this page sent for an earlier run is not this run's.
    h.sandbox.__setCancel({ runId: 'run-0', requested: true, finishingStepId: 'commit' });
    h.sandbox.renderLiveWrapDrawer(planned, { retry: false, streamLost: false });
    assert.equal(h.ids.wrapDrawerAbortBtn.textContent, 'Cancel wrap');
    assert.deepEqual(plain(h.state().wrapCancelState), { runId: 'run-1', requested: false, finishingStepId: null });
    // One it sent for this run disables the control and says what is finishing.
    h.sandbox.__setCancel({ runId: 'run-1', requested: true, finishingStepId: 'changelog-update' });
    h.sandbox.renderLiveWrapDrawer(planned, { retry: false, streamLost: false });
    assert.equal(h.ids.wrapDrawerAbortBtn.textContent, 'Cancelling…');
    assert.equal(h.ids.wrapDrawerAbortBtn.disabled, true);
    assert.equal(h.ids.wrapDrawerCancelNote.classList.contains('hidden'), false);
    assert.match(h.ids.wrapDrawerCancelNote.textContent, /"changelog-update" is finishing/);

    const noRun = loadLiveDrawer({ runId: null });
    noRun.sandbox.renderLiveWrapDrawer(null, { retry: false, streamLost: false });
    assert.equal(noRun.ids.wrapDrawerPlanned.classList.contains('hidden'), true);
    assert.equal(noRun.ids.wrapDrawerPlanned.textContent, '');
    assert.equal(noRun.ids.wrapDrawerAbortBtn.disabled, true, 'nothing to cancel without a run id');
  });
});
