'use strict';

/*
 * #185 — the client half of live wrap progress.
 *
 * Two layers, tested two ways. The pure event-folding helpers in
 * `public/wrap-drawer.js` (`applyWrapStreamEvent`, `summarizeLiveStatus`,
 * `liveWrapAsPipelineResult`, `wrapStreamUrl`) load into a vm sandbox and are
 * driven directly, the way test/wrap-drawer.test.js drives their siblings.
 * The wiring in `public/session.js` is browser DOM code that cannot be
 * require()d, so — per the test/wrap-run-reattach.test.js convention — those
 * are source-level pins over function bodies: the stream is attached beside
 * the POST rather than after it, every event type is subscribed, a CLOSED
 * source is the fallback and a CONNECTING one is left to reconnect, the final
 * render always closes the stream, and the blocking render the POST delivers
 * is untouched.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

/**
 * Slice out a top-level function body by brace-matching from its declaration.
 * @param {string} src - Full source text
 * @param {string} decl - The declaration to find
 * @returns {string} The body including its braces
 */
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${decl}`);
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

  it('run-done marks the run over and keeps the payload the caller renders as a POST return', () => {
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

  it('confirmWrap attaches the stream beside the POST — not after it — and still renders the POST\'s result', () => {
    const body = functionBody(src, 'async function confirmWrap()');
    const attachAt = body.indexOf('attachWrapStream(');
    const awaitAt = body.indexOf('await postPromise');
    assert.ok(attachAt !== -1 && awaitAt !== -1);
    assert.ok(attachAt < awaitAt, 'attaching after the POST resolves would watch a run that has already ended');
    // The freshness gate is the prior run id, snapshotted BEFORE the POST fires.
    assert.ok(body.indexOf('priorRunId') < body.indexOf('apiMutate('));
    // Fallback: the blocking render is untouched.
    const resultBranch = body.slice(body.indexOf('if (data.pipelineResult)'));
    assert.ok(resultBranch.includes('openWrapDrawer(data.pipelineResult'), 'the POST return still opens the drawer');
  });

  it('attachWrapStream is bounded, stops once the POST settled, and ignores a run that predates the POST', () => {
    const body = functionBody(src, 'async function attachWrapStream(');
    assert.ok(body.includes('WRAP_STREAM_DISCOVERY_ATTEMPTS'), 'a refused POST never claims a run — the probe must give up');
    assert.ok(body.includes('&& wrapInFlight'), 'no point probing after the POST returned');
    assert.ok(body.includes('status.runId !== priorRunId'), 'a wrap already running before this POST is the 409 path, not this wrap');
  });

  it('startWrapStream subscribes to every event type the server emits and folds each through the helper', () => {
    const body = functionBody(src, 'function startWrapStream(');
    for (const type of ['run-start', 'step-start', 'step-done', 'step-blocked', 'run-done']) {
      assert.ok(body.includes(`'${type}'`), `event type ${type} must be subscribed — EventSource delivers named events only to named listeners`);
    }
    assert.ok(body.includes('applyWrapStreamEvent('));
    assert.ok(body.includes('renderLiveWrapDrawer('));
    assert.ok(body.includes('new EventSource('));
  });

  it('run-done renders the stream\'s result exactly as a POST return, and a CLOSED source is the fallback', () => {
    const body = functionBody(src, 'function startWrapStream(');
    const doneBranch = body.slice(body.indexOf("type === 'run-done'"));
    assert.ok(doneBranch.includes('openWrapDrawer(result.pipelineResult'));
    const onError = body.slice(body.indexOf('es.onerror'));
    assert.ok(onError.includes('EventSource.CLOSED'), 'only a CLOSED source is terminal — CONNECTING reconnects with Last-Event-ID');
    assert.ok(onError.includes('streamUnavailableStatus()'), 'the fallback says so instead of freezing a stale step count');
    assert.ok(onError.includes('stopWrapStream()'));
  });

  it('every final render and the drawer close stop the stream; the reattach watch starts one', () => {
    assert.ok(functionBody(src, 'function openWrapDrawer(').includes('stopWrapStream()'),
      'the final render supersedes the live feed');
    assert.ok(functionBody(src, 'function closeWrapDrawer()').includes('stopWrapStream()'));
    const watch = functionBody(src, 'async function watchWrapRun(');
    assert.ok(watch.includes('startWrapStream(status.runId'), 'a reattached page gets live rows too');
    assert.ok(watch.indexOf('startWrapStream(') > watch.indexOf('closeWrapDrawer()'),
      'the watch closes any prior drawer (and stream) before subscribing');
  });

  it('the live drawer offers no decision: Retry and Done stay hidden until the run is over', () => {
    const body = functionBody(src, 'function renderLiveWrapDrawer(');
    assert.ok(body.includes("getElementById('wrapDrawerRetryBtn').classList.add('hidden')"));
    assert.ok(body.includes("getElementById('wrapDrawerDoneBtn').classList.add('hidden')"));
    assert.ok(body.includes('renderStepRow('), 'rows render through the same builder as the final drawer');
    assert.ok(body.includes('summarizeLiveStatus('));
  });

  it('the running tone the live rows use is styled', () => {
    const css = fs.readFileSync(path.join(PUBLIC, 'session.css'), 'utf8');
    assert.ok(css.includes('.wrap-step-status--running {'));
    assert.ok(css.includes('.wrap-drawer-status--running'));
  });
});
