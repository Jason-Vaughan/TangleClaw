'use strict';

/**
 * `lib/native-sprint-tracker.js` (#2644, Car 68-A): wave-matrix disjointness,
 * the live lane/PR dispatch tracker, the sprint report/O-Gate summary
 * builder, and the resilient roadmap sync helper — plus the thin HTTP
 * adapter over it, `lib/routes/sprint-wave-routes.js`, and the browser view
 * helpers in `public/sprint-wave-ui.js`.
 *
 * `gitLsFilesAt` is exercised only as a smoke test (it is a function) rather
 * than for real: it shells out to `git`, and a test file in the `small` tier
 * starts no subprocess. Its scope-check LOGIC is covered through
 * `validateWaveDisjointness`'s injected `lsFiles` stub instead, which
 * exercises the exact same comparison without spawning anything.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tracker = require('../lib/native-sprint-tracker');
const { createSprintWaveRouter } = require('../lib/routes/sprint-wave-routes');
const sprintWaveUi = require('../public/sprint-wave-ui');

// ── Fake HTTP req/res, for the route adapter's own tests ──

/**
 * A minimal fake `http.ServerResponse`: captures what was written so a test
 * can assert on it without a real socket.
 * @returns {{res: object, status: () => (number|null), json: () => (*|null)}}
 */
function fakeRes() {
  const state = { status: null, body: null };
  const res = {
    writeHead(status) { state.status = status; },
    end(body) { state.body = body; }
  };
  return {
    res,
    status: () => state.status,
    json: () => (state.body ? JSON.parse(state.body) : null)
  };
}

/**
 * A minimal fake `http.IncomingMessage`: a real `EventEmitter` (so
 * `parseBody`'s `req.on('data'|'end'|'error', ...)` works) plus the three
 * properties the kernel's helpers read (`method`, `url`, `headers`).
 * @param {string} method
 * @param {string} url
 * @param {*} [jsonBody]
 * @returns {{req: EventEmitter, send: () => void}}
 */
function fakeReq(method, url, jsonBody) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost' };
  return {
    req,
    // Emit AFTER the handler has started (and so has attached its
    // listeners) but before awaiting it — see the module doc of
    // `lib/routes/_kernel.js#parseBody` for why this ordering works.
    send() {
      if (jsonBody !== undefined) req.emit('data', Buffer.from(JSON.stringify(jsonBody)));
      req.emit('end');
    }
  };
}

describe('native-sprint-tracker: validateWaveDisjointness', () => {
  it('reports ok with no collisions, no oversized cars, no drift', () => {
    const result = tracker.validateWaveDisjointness([
      { id: 'car-a', issues: ['#1'], files: ['lib/a.js'] },
      { id: 'car-b', issues: ['#2'], files: ['lib/b.js'] }
    ]);
    assert.deepEqual(result, { ok: true, collisions: [], oversizedCars: [], scopeDrift: [] });
  });

  it('reports a pairwise file collision, sorted', () => {
    const result = tracker.validateWaveDisjointness([
      { id: 'car-a', files: ['lib/shared.js', 'lib/b-only.js'] },
      { id: 'car-b', files: ['lib/shared.js'] },
      { id: 'car-c', files: ['lib/c-only.js'] }
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.collisions, [{ carA: 'car-a', carB: 'car-b', files: ['lib/shared.js'] }]);
  });

  it('flags a car over the default 3-issue bundle cap', () => {
    const result = tracker.validateWaveDisjointness([
      { id: 'car-a', issues: ['#1', '#2', '#3', '#4'], files: [] }
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.oversizedCars, [{ carId: 'car-a', issueCount: 4 }]);
  });

  it('honors a custom maxIssuesPerCar', () => {
    const cars = [{ id: 'car-a', issues: ['#1', '#2'], files: [] }];
    assert.equal(tracker.validateWaveDisjointness(cars, { maxIssuesPerCar: 1 }).ok, false);
    assert.equal(tracker.validateWaveDisjointness(cars, { maxIssuesPerCar: 2 }).ok, true);
  });

  it('reports scope drift from an injected lsFiles both ways', () => {
    const cars = [{ id: 'car-a', files: ['lib/declared-only.js', 'lib/both.js'] }];
    const result = tracker.validateWaveDisjointness(cars, {
      lsFiles: () => ['lib/both.js', 'lib/actual-only.js']
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.scopeDrift, [{
      carId: 'car-a', declaredOnly: ['lib/declared-only.js'], actualOnly: ['lib/actual-only.js']
    }]);
  });

  it('skips the scope-drift check for a car whose lsFiles cannot verify (returns null)', () => {
    const cars = [{ id: 'car-a', files: ['lib/a.js'] }];
    const result = tracker.validateWaveDisjointness(cars, { lsFiles: () => null });
    assert.deepEqual(result.scopeDrift, []);
    assert.equal(result.ok, true);
  });

  it('throws on a non-array input', () => {
    assert.throws(() => tracker.validateWaveDisjointness(null), TypeError);
  });

  it('throws on a car with no string id', () => {
    assert.throws(() => tracker.validateWaveDisjointness([{ files: [] }]), TypeError);
  });

  it('exports gitLsFilesAt as a function (smoke only — see file header)', () => {
    assert.equal(typeof tracker.gitLsFilesAt, 'function');
  });
});

describe('native-sprint-tracker: exported constants', () => {
  it('GUARDRAIL_IDS is exactly P0..P11, matching the Hero report\'s ledger', () => {
    assert.deepEqual(tracker.GUARDRAIL_IDS, Array.from({ length: 12 }, (_, i) => `P${i}`));
  });

  it('DISPATCH_STAGES names the same stage set the UI module\'s STAGE_ORDER renders — the two are independent lists (the browser file cannot require the lib one) and would silently drift apart if a stage were ever added to just one', () => {
    assert.deepEqual([...tracker.DISPATCH_STAGES].sort(), [...sprintWaveUi.STAGE_ORDER].sort());
  });
});

describe('native-sprint-tracker: syncWaveDispatchState', () => {
  const baseCars = [{ id: 'car-a', issues: [{ id: '#1', state: 'open' }] }];

  it('reports unassigned when no lane holds the car', () => {
    const result = tracker.syncWaveDispatchState({ cars: baseCars });
    assert.equal(result['car-a'].stage, 'unassigned');
    assert.equal(result['car-a'].laneName, null);
  });

  it('reports claimed for a lane with no committed work yet', () => {
    const result = tracker.syncWaveDispatchState({
      cars: baseCars, lanes: [{ carId: 'car-a', name: 'TC-Lane-B', status: 'claimed' }]
    });
    assert.equal(result['car-a'].stage, 'claimed');
    assert.equal(result['car-a'].laneName, 'TC-Lane-B');
  });

  it('reports in-progress once the lane has committed work pushed', () => {
    const result = tracker.syncWaveDispatchState({
      cars: baseCars, lanes: [{ carId: 'car-a', status: 'committed' }]
    });
    assert.equal(result['car-a'].stage, 'in-progress');
  });

  it('reports in-review with an open PR', () => {
    const result = tracker.syncWaveDispatchState({
      cars: baseCars,
      lanes: [{ carId: 'car-a', status: 'committed' }],
      pullRequests: [{ carId: 'car-a', number: 42, state: 'open' }]
    });
    assert.equal(result['car-a'].stage, 'in-review');
    assert.equal(result['car-a'].openPrNumber, 42);
  });

  it('reports blocked for an open PR with changes requested', () => {
    const result = tracker.syncWaveDispatchState({
      cars: baseCars,
      pullRequests: [{ carId: 'car-a', number: 42, state: 'open', reviewDecision: 'changes_requested' }]
    });
    assert.equal(result['car-a'].stage, 'blocked');
  });

  it('reports blocked for an explicit lane hold, even with an open PR otherwise clean', () => {
    const result = tracker.syncWaveDispatchState({
      cars: baseCars,
      lanes: [{ carId: 'car-a', hold: true }],
      pullRequests: [{ carId: 'car-a', number: 42, state: 'open' }]
    });
    assert.equal(result['car-a'].stage, 'blocked');
  });

  it('reports closed on a merged PR', () => {
    const result = tracker.syncWaveDispatchState({
      cars: baseCars, pullRequests: [{ carId: 'car-a', number: 42, state: 'merged' }]
    });
    assert.equal(result['car-a'].stage, 'closed');
    assert.equal(result['car-a'].openPrNumber, 42);
  });

  it('reports closed when every issue is closed, with no PR at all', () => {
    const result = tracker.syncWaveDispatchState({
      cars: [{ id: 'car-a', issues: [{ id: '#1', state: 'closed' }, { id: '#2', state: 'closed' }] }]
    });
    assert.equal(result['car-a'].stage, 'closed');
  });

  it('throws without an input.cars array', () => {
    assert.throws(() => tracker.syncWaveDispatchState({}), TypeError);
  });
});

describe('native-sprint-tracker: buildNativeSprintReportSummary', () => {
  const sprintData = {
    version: 'v5.68.0',
    releaseCommit: 'abc1234',
    waves: [{ id: 'W1', startedAt: '2026-11-01T00:00:00Z', endedAt: '2026-11-03T00:00:00Z', cars: ['car-a', 'car-b'] }],
    cars: [
      {
        id: 'car-a', category: 'feature', lane: 'TC-Lane-A',
        issues: [{ id: '#1', state: 'closed' }], files: ['lib/a.js'],
        dispatchedAt: '2026-11-01T00:00:00Z', closedAt: '2026-11-01T12:00:00Z'
      },
      {
        id: 'car-b', category: 'fix', lane: 'TC-Lane-B',
        issues: [{ id: '#2', state: 'open' }], files: ['lib/a.js']
      }
    ],
    pullRequests: [
      { carId: 'car-a', number: 1, state: 'merged', reviewRounds: 2, additions: 100, deletions: 20 }
    ],
    learnings: [{ guardrail: 'P3' }, { guardrail: 'P3' }]
  };

  it('computes the 8 Hero KPIs', () => {
    const summary = tracker.buildNativeSprintReportSummary(sprintData);
    assert.deepEqual(summary.heroKpis, {
      issuesClosed: 1,
      builderPRs: 1,
      waves: 1,
      fileCollisions: 1, // car-a and car-b both declare lib/a.js
      reviewRounds: 2,
      cycleTimeHours: 12,
      netLOC: 80,
      releaseCommit: 'abc1234'
    });
  });

  it('builds the three chart data series', () => {
    const summary = tracker.buildNativeSprintReportSummary(sprintData);
    assert.deepEqual(summary.charts.waveTimeline, [
      { waveId: 'W1', startedAt: '2026-11-01T00:00:00Z', endedAt: '2026-11-03T00:00:00Z', carCount: 2 }
    ]);
    assert.deepEqual(summary.charts.categoryBreakdown, { feature: 1, fix: 1 });
    assert.deepEqual(summary.charts.laneVelocity, {
      'TC-Lane-A': { carsCompleted: 1, avgCycleHours: 12 },
      'TC-Lane-B': { carsCompleted: 0, avgCycleHours: null }
    });
  });

  it('marks only the guardrails learnings actually cite as triggered, across P0..P11', () => {
    const summary = tracker.buildNativeSprintReportSummary(sprintData);
    assert.equal(summary.guardrailLedger.length, 12);
    const p3 = summary.guardrailLedger.find((g) => g.guardrail === 'P3');
    const p0 = summary.guardrailLedger.find((g) => g.guardrail === 'P0');
    assert.deepEqual(p3, { guardrail: 'P3', triggered: true, count: 2 });
    assert.deepEqual(p0, { guardrail: 'P0', triggered: false, count: 0 });
  });

  it('reports a null cycleTimeHours when no car has a usable timestamp pair', () => {
    const summary = tracker.buildNativeSprintReportSummary({ cars: [{ id: 'car-a' }] });
    assert.equal(summary.heroKpis.cycleTimeHours, null);
  });

  it('defaults every field on an empty input rather than throwing', () => {
    const summary = tracker.buildNativeSprintReportSummary({});
    assert.equal(summary.version, null);
    assert.equal(summary.heroKpis.builderPRs, 0);
    assert.equal(summary.guardrailLedger.length, 12);
  });
});

describe('native-sprint-tracker: syncRoadmapWithBackoff', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sprint-snapshot-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /** A no-op sleep so a backoff test never actually waits. */
  const noSleep = async () => {};

  it('succeeds on the first try and saves the fresh snapshot', async () => {
    const store = tracker.createFileSnapshotStore(path.join(tmpDir, 'snap.json'));
    const result = await tracker.syncRoadmapWithBackoff(
      async () => ({ status: 200, body: { items: [1, 2] } }),
      { sleepFn: noSleep, snapshotStore: store }
    );
    assert.deepEqual(result, { ok: true, data: { items: [1, 2] }, attempts: 1, usedSnapshot: false });
    assert.deepEqual(store.read(), { items: [1, 2] });
  });

  it('retries a transient 429 then succeeds, honoring exponential backoff delays', async () => {
    let calls = 0;
    const delays = [];
    const result = await tracker.syncRoadmapWithBackoff(
      async () => {
        calls += 1;
        if (calls < 3) return { status: 429, body: null };
        return { status: 200, body: { ok: 'finally' } };
      },
      {
        baseDelayMs: 100, maxDelayMs: 10000,
        sleepFn: async (ms) => { delays.push(ms); }
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.deepEqual(delays, [100, 200]);
  });

  it('exhausts retries and falls back to the last-good snapshot', async () => {
    const snapshotPath = path.join(tmpDir, 'snap.json');
    const store = tracker.createFileSnapshotStore(snapshotPath);
    store.write({ items: ['stale-but-good'] });

    const result = await tracker.syncRoadmapWithBackoff(
      async () => ({ status: 503, body: null }),
      { maxRetries: 2, sleepFn: noSleep, snapshotStore: store }
    );
    assert.equal(result.ok, false);
    assert.equal(result.usedSnapshot, true);
    assert.deepEqual(result.data, { items: ['stale-but-good'] });
    assert.equal(result.attempts, 3); // the first try + 2 retries
  });

  it('exhausts retries with no snapshot available and reports that honestly', async () => {
    const result = await tracker.syncRoadmapWithBackoff(
      async () => ({ status: 500, body: null }),
      { maxRetries: 1, sleepFn: noSleep }
    );
    assert.equal(result.ok, false);
    assert.equal(result.usedSnapshot, false);
    assert.equal(result.data, null);
  });

  it('fails fast on a non-retryable status with no retry attempted', async () => {
    let calls = 0;
    const result = await tracker.syncRoadmapWithBackoff(
      async () => { calls += 1; return { status: 404, body: null }; },
      { maxRetries: 5, sleepFn: noSleep }
    );
    assert.equal(calls, 1);
    assert.equal(result.attempts, 1);
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 404);
  });

  it('treats a thrown fetchFn rejection as a retryable transport failure', async () => {
    let calls = 0;
    const result = await tracker.syncRoadmapWithBackoff(
      async () => { calls += 1; throw new Error('ECONNRESET'); },
      { maxRetries: 2, sleepFn: noSleep }
    );
    assert.equal(calls, 3);
    assert.equal(result.ok, false);
    assert.match(result.error.message, /ECONNRESET/);
  });

  it('throws a TypeError when fetchFn is not a function', async () => {
    await assert.rejects(() => tracker.syncRoadmapWithBackoff(null), TypeError);
  });
});

describe('native-sprint-tracker: createFileSnapshotStore', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sprint-snapshot-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('round-trips a write through an atomic rename', () => {
    const store = tracker.createFileSnapshotStore(path.join(tmpDir, 'snap.json'));
    store.write({ hello: 'world' });
    assert.deepEqual(store.read(), { hello: 'world' });
  });

  it('reads null when the file does not exist yet', () => {
    const store = tracker.createFileSnapshotStore(path.join(tmpDir, 'missing.json'));
    assert.equal(store.read(), null);
  });

  it('reads null when the file is not valid JSON', () => {
    const file = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(file, 'not json {{{');
    const store = tracker.createFileSnapshotStore(file);
    assert.equal(store.read(), null);
  });
});

describe('sprint-wave-routes: createSprintWaveRouter', () => {
  it('lists its own four routes', () => {
    const router = createSprintWaveRouter({});
    assert.deepEqual(router.routes, [
      { method: 'GET', pattern: '/api/sprint-waves' },
      { method: 'POST', pattern: '/api/sprint-waves/validate-disjointness' },
      { method: 'GET', pattern: '/api/sprint-reports/:version' },
      { method: 'POST', pattern: '/api/sprint-waves/sync' }
    ]);
  });

  it('does not handle a request matching no route', async () => {
    const router = createSprintWaveRouter({});
    const { req } = fakeReq('GET', '/api/not-a-sprint-route');
    const { res } = fakeRes();
    assert.equal(await router.handle(req, res), false);
  });

  it('GET /api/sprint-waves returns the live dispatch state', async () => {
    const router = createSprintWaveRouter({
      getSprintData: async () => ({
        waves: [{ id: 'W1' }],
        cars: [{ id: 'car-a', issues: [] }],
        lanes: [{ carId: 'car-a', status: 'committed' }],
        pullRequests: []
      })
    });
    const { req } = fakeReq('GET', '/api/sprint-waves');
    const { res, status, json } = fakeRes();
    assert.equal(await router.handle(req, res), true);
    assert.equal(status(), 200);
    assert.equal(json().dispatch['car-a'].stage, 'in-progress');
  });

  it('POST /api/sprint-waves/validate-disjointness runs the real validator', async () => {
    const router = createSprintWaveRouter({});
    const { req, send } = fakeReq('POST', '/api/sprint-waves/validate-disjointness', {
      cars: [{ id: 'car-a', files: ['lib/x.js'] }, { id: 'car-b', files: ['lib/x.js'] }]
    });
    const { res, status, json } = fakeRes();
    const handled = router.handle(req, res);
    send();
    await handled;
    assert.equal(status(), 200);
    assert.equal(json().result.ok, false);
    assert.equal(json().result.collisions.length, 1);
  });

  it('POST /api/sprint-waves/validate-disjointness refuses a body with no cars array', async () => {
    const router = createSprintWaveRouter({});
    const { req, send } = fakeReq('POST', '/api/sprint-waves/validate-disjointness', {});
    const { res, status, json } = fakeRes();
    const handled = router.handle(req, res);
    send();
    await handled;
    assert.equal(status(), 400);
    assert.equal(json().code, 'BAD_REQUEST');
  });

  it('GET /api/sprint-reports/:version builds the report summary for that version', async () => {
    const router = createSprintWaveRouter({
      getSprintDataForVersion: async (version) => (version === 'v5.68.0' ? { version, cars: [], pullRequests: [] } : null)
    });
    const { req } = fakeReq('GET', '/api/sprint-reports/v5.68.0');
    const { res, status, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(status(), 200);
    assert.equal(json().report.version, 'v5.68.0');
  });

  it('GET /api/sprint-reports/:version 404s an unknown version', async () => {
    const router = createSprintWaveRouter({ getSprintDataForVersion: async () => null });
    const { req } = fakeReq('GET', '/api/sprint-reports/vNope');
    const { res, status, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(status(), 404);
    assert.equal(json().code, 'NOT_FOUND');
  });

  it('POST /api/sprint-waves/sync runs the backoff helper and saves the snapshot', async () => {
    const written = [];
    const router = createSprintWaveRouter({
      fetchRoadmap: async () => ({ status: 200, body: { roadmap: true } }),
      snapshotStore: { read: () => null, write: (data) => written.push(data) },
      backoffOptions: { sleepFn: async () => {} }
    });
    const { req, send } = fakeReq('POST', '/api/sprint-waves/sync', {});
    const { res, status, json } = fakeRes();
    const handled = router.handle(req, res);
    send();
    await handled;
    assert.equal(status(), 200);
    assert.equal(json().ok, true);
    assert.deepEqual(written, [{ roadmap: true }]);
  });

  it('POST /api/sprint-waves/sync answers 503 when no fetchRoadmap is configured', async () => {
    const router = createSprintWaveRouter({});
    const { req, send } = fakeReq('POST', '/api/sprint-waves/sync', {});
    const { res, status, json } = fakeRes();
    const handled = router.handle(req, res);
    send();
    await handled;
    assert.equal(status(), 503);
    assert.equal(json().code, 'NOT_CONFIGURED');
  });
});

describe('public/sprint-wave-ui', () => {
  it('renders all 8 KPI cards with an em-dash placeholder for a missing value', () => {
    const html = sprintWaveUi.renderSprintKpiCards(null, { issuesClosed: 3, builderPRs: 1 });
    assert.match(html, /Issues Closed/);
    assert.match(html, />3</);
    assert.match(html, /Release Commit/);
    assert.match(html, /—/); // releaseCommit was not supplied
  });

  it('writes into a container that has an innerHTML property', () => {
    const container = {};
    const html = sprintWaveUi.renderSprintKpiCards(container, {});
    assert.equal(container.innerHTML, html);
  });

  it('renders one board column per dispatch stage, with cars sorted into their stage', () => {
    const html = sprintWaveUi.renderSprintWaveBoard(null, {
      dispatch: {
        'car-a': { stage: 'claimed', laneName: 'TC-Lane-A', openPrNumber: null },
        'car-b': { stage: 'closed', laneName: 'TC-Lane-B', openPrNumber: 7 }
      }
    });
    assert.match(html, /data-stage="claimed"[^]*data-car-id="car-a"/);
    assert.match(html, /data-stage="closed"[^]*data-car-id="car-b"/);
    assert.match(html, /#7/);
  });

  it('escapes car ids and lane names so a hostile value cannot break out of the markup', () => {
    const html = sprintWaveUi.renderSprintWaveBoard(null, {
      dispatch: { '<img onerror=alert(1)>': { stage: 'claimed', laneName: '</ul><script>' } }
    });
    assert.doesNotMatch(html, /<img onerror/);
    assert.doesNotMatch(html, /<script>/);
  });

  it('filterSprintWaveRows filters by stage, lane name and case-insensitive search', () => {
    const rows = [
      { carId: 'car-a', stage: 'claimed', laneName: 'TC-Lane-A' },
      { carId: 'car-b', stage: 'closed', laneName: 'TC-Lane-B' }
    ];
    assert.deepEqual(sprintWaveUi.filterSprintWaveRows(rows, { stage: 'closed' }), [rows[1]]);
    assert.deepEqual(sprintWaveUi.filterSprintWaveRows(rows, { laneName: 'TC-Lane-A' }), [rows[0]]);
    assert.deepEqual(sprintWaveUi.filterSprintWaveRows(rows, { search: 'car-b' }), [rows[1]]);
    assert.deepEqual(sprintWaveUi.filterSprintWaveRows(rows, {}), rows);
  });

  it('filterSprintWaveRows never mutates its input', () => {
    const rows = [{ carId: 'car-a', stage: 'claimed' }];
    const copy = JSON.parse(JSON.stringify(rows));
    sprintWaveUi.filterSprintWaveRows(rows, { stage: 'closed' });
    assert.deepEqual(rows, copy);
  });
});
