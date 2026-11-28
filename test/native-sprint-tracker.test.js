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

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
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

  it('with lsFilesScope "car" (lsFiles already scoped to this car), reports scope drift both ways', () => {
    const cars = [{ id: 'car-a', files: ['lib/declared-only.js', 'lib/both.js'] }];
    const result = tracker.validateWaveDisjointness(cars, {
      lsFilesScope: 'car',
      lsFiles: () => ['lib/both.js', 'lib/actual-only.js']
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.scopeDrift, [{
      carId: 'car-a', declaredOnly: ['lib/declared-only.js'], actualOnly: ['lib/actual-only.js']
    }]);
  });

  it('with the default lsFilesScope "repo" (lsFiles answers the WHOLE worktree), only declaredOnly is ever reported -- never the rest of the repo as actualOnly', () => {
    const cars = [{ id: 'car-a', files: ['lib/declared-only.js', 'lib/both.js'] }];
    const result = tracker.validateWaveDisjointness(cars, {
      // A repo-wide listing: car-a's own files plus 1,000+ unrelated paths,
      // standing in for a real `git ls-files` across an entire worktree.
      lsFiles: () => ['lib/both.js', ...Array.from({ length: 1000 }, (_, i) => `lib/unrelated-${i}.js`)]
    });
    assert.equal(result.ok, false, 'declaredOnly alone still fails the check');
    assert.deepEqual(result.scopeDrift, [{
      carId: 'car-a', declaredOnly: ['lib/declared-only.js'], actualOnly: []
    }]);
  });

  it('skips the scope-drift check for a car whose lsFiles cannot verify (returns null)', () => {
    const cars = [{ id: 'car-a', files: ['lib/a.js'] }];
    const result = tracker.validateWaveDisjointness(cars, { lsFiles: () => null });
    assert.deepEqual(result.scopeDrift, []);
    assert.equal(result.ok, true);
  });

  it('REAL CHECKOUT (I-Gate Round 1): gitLsFilesAt(process.cwd()) as lsFiles, repo scope, a valid multi-car wave passes ok:true', () => {
    const actualFiles = tracker.gitLsFilesAt(process.cwd());
    assert.ok(Array.isArray(actualFiles) && actualFiles.length > 100,
      'this test must run inside the real repo checkout for the assertion below to mean anything');
    const cars = [
      { id: 'car-68-a', issues: ['#2644'], files: ['lib/native-sprint-tracker.js', 'lib/routes/sprint-wave-routes.js', 'public/sprint-wave-ui.js'] },
      { id: 'car-68-b', issues: ['#2821', '#748'], files: ['lib/coordinator-rotation.js', 'lib/wrap-steps/features-toc.js', 'lib/wrap-steps/index-describe.js'] }
    ];
    const result = tracker.validateWaveDisjointness(cars, { lsFiles: () => actualFiles });
    assert.deepEqual(result, { ok: true, collisions: [], oversizedCars: [], scopeDrift: [] });
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

describe('native-sprint-tracker: validateVersionPlanParallelism (#3138)', () => {
  it('passes a plan declaring capacity, with its issues partitioned across disjoint parallel trains', () => {
    const result = tracker.validateVersionPlanParallelism({
      maxParallelLanes: 4,
      trains: [
        { wave: 1, cars: [1, 2], files: ['a.js'] },
        { wave: 1, cars: [3, 4], files: ['b.js'] }
      ]
    });
    assert.deepEqual(result, { ok: true, violations: [] });
  });

  it('flags a missing/invalid maxParallelLanes, checking against the 4-lane default instead of skipping', () => {
    for (const bad of [{}, { maxParallelLanes: 0 }, { maxParallelLanes: 1.5 }, { maxParallelLanes: -1 }]) {
      const result = tracker.validateVersionPlanParallelism({ ...bad, trains: [] });
      assert.deepEqual(result.violations.map((v) => v.code), ['MISSING_PARALLEL_LANE_CAPACITY']);
    }
  });

  it('refuses a single-bucket train with >= 4 issues against a >= 2 lane plan (UNPARALLELIZED_VERSION_PLAN)', () => {
    const result = tracker.validateVersionPlanParallelism({ maxParallelLanes: 4, trains: [{ cars: [1, 2, 3, 4] }] });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.code === 'UNPARALLELIZED_VERSION_PLAN'));
  });

  it('does not flag a single train under 4 issues, under 2 lanes, or marked runs_alone', () => {
    assert.equal(tracker.validateVersionPlanParallelism({ maxParallelLanes: 4, trains: [{ cars: [1, 2, 3] }] }).ok, true);
    assert.equal(tracker.validateVersionPlanParallelism({ maxParallelLanes: 1, trains: [{ cars: [1, 2, 3, 4] }] }).ok, true);
    assert.equal(tracker.validateVersionPlanParallelism({
      maxParallelLanes: 4, trains: [{ cars: [1, 2, 3, 4], runs_alone: true }]
    }).ok, true);
  });

  it('refuses two parallel trains in the same wave sharing a file (WAVE_FILE_COLLISION), naming the wave and both trains', () => {
    const result = tracker.validateVersionPlanParallelism({
      maxParallelLanes: 4,
      trains: [
        { id: 'train-x', wave: 1, cars: [1], files: ['shared.js'] },
        { id: 'train-y', wave: 1, cars: [2], files: ['shared.js'] },
        { id: 'train-z', wave: 2, cars: [3], files: ['shared.js'] }
      ]
    });
    assert.deepEqual(result.violations, [{
      code: 'WAVE_FILE_COLLISION', wave: 1, carA: 'train-x', carB: 'train-y', files: ['shared.js'],
      message: 'Wave 1: train-x and train-y are both parallel trains that share files: shared.js'
    }]);
  });

  it('never checks disjointness across different waves, or against a single train with no sibling', () => {
    const result = tracker.validateVersionPlanParallelism({
      maxParallelLanes: 4,
      trains: [{ wave: 1, cars: [1], files: ['x.js'] }, { wave: 2, cars: [2], files: ['x.js'] }]
    });
    assert.equal(result.ok, true);
  });

  it('exports every code it can report', () => {
    assert.deepEqual([...tracker.PARALLELISM_VIOLATION_CODES],
      ['UNPARALLELIZED_VERSION_PLAN', 'MISSING_PARALLEL_LANE_CAPACITY', 'WAVE_FILE_COLLISION']);
  });
});

describe('native-sprint-tracker: buildRoadmapDataFromFallbackSources (#3134)', () => {
  it('builds a release with no trains from a bare docs/releases version', () => {
    assert.deepEqual(tracker.buildRoadmapDataFromFallbackSources({ docsReleaseVersions: ['6.5.0'] }),
      { releases: [{ version: '6.5.0', trains: [] }] });
  });

  it('ignores a malformed docs/releases version rather than guessing', () => {
    assert.deepEqual(tracker.buildRoadmapDataFromFallbackSources({ docsReleaseVersions: ['index', 'not-a-version'] }),
      { releases: [] });
  });

  it('recovers the current sprint\'s real cars from LANE_QUEUE.md\'s Train headers and Closes rows', () => {
    const laneQueueText = [
      '## Train 0 — `Sprint v6.5.1` (Milestone `#84`)',
      '',
      '| **`W1-A`** | `Closes #3130`, `Closes #3137` | ... |',
      '| **`W1-B`** | `Closes #3132` | ... |',
      '',
      '## Train 1 — `Sprint v6.4.1` (SHIPPED)',
      '| **`W1-C`** | `Closes #3108` | ... |'
    ].join('\n');
    assert.deepEqual(tracker.buildRoadmapDataFromFallbackSources({ laneQueueText }), {
      releases: [
        { version: '6.5.1', trains: [{ cars: [3130, 3137, 3132] }] },
        { version: '6.4.1', trains: [{ cars: [3108] }] }
      ]
    });
  });

  it('merges docs/releases and LANE_QUEUE.md onto the same release when both name it, never a duplicate entry', () => {
    const result = tracker.buildRoadmapDataFromFallbackSources({
      docsReleaseVersions: ['6.5.1'],
      laneQueueText: '## Train 0 — `Sprint v6.5.1`\n| **`W1-A`** | `Closes #1` | ... |'
    });
    assert.deepEqual(result.releases, [{ version: '6.5.1', trains: [{ cars: [1] }] }]);
  });

  it('answers an empty releases list with no sources at all, never throwing', () => {
    assert.deepEqual(tracker.buildRoadmapDataFromFallbackSources(), { releases: [] });
    assert.deepEqual(tracker.buildRoadmapDataFromFallbackSources({}), { releases: [] });
  });

  it('also recovers cars named "Part of #N" / "Fixes #N", case-insensitively, de-duplicating repeats (#3138, PRR-A Warning 1)', () => {
    const laneQueueText = [
      '## Train 0 — `Sprint v6.5.1`',
      '| **`W1-B`** | `Part of #3115`, `part of #3115` | ... |',
      '| **`W1-D`** | `Fixes #3107` | ... |',
      '| **`W1-A`** | `Closes #3130` | ... |'
    ].join('\n');
    assert.deepEqual(tracker.buildRoadmapDataFromFallbackSources({ laneQueueText }),
      { releases: [{ version: '6.5.1', trains: [{ cars: [3115, 3107, 3130] }] }] });
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

  it('always carries a 6-stage pill, computed from stage alone (#3112, PRR-B I-Gate R1 BLOCKING 2)', () => {
    const result = tracker.syncWaveDispatchState({ cars: baseCars });
    assert.deepEqual(result['car-a'].pill, { code: 'open', label: 'Not started' });
  });

  it('a bare car (no files/reviewers/headSha/issues) produces exactly {stage, laneName, openPrNumber, pill} -- no extra keys', () => {
    const result = tracker.syncWaveDispatchState({ cars: [{ id: 'car-a' }] });
    assert.deepEqual(Object.keys(result['car-a']).sort(), ['laneName', 'openPrNumber', 'pill', 'stage']);
  });

  it('passes through files, reviewers and headSha only when the car carries them', () => {
    const result = tracker.syncWaveDispatchState({
      cars: [{ id: 'car-a', files: ['lib/a.js'], reviewers: { oGate: 'TC-Lane-Obsr' }, headSha: 'abcdef1' }]
    });
    assert.deepEqual(result['car-a'].files, ['lib/a.js']);
    assert.deepEqual(result['car-a'].reviewers, { oGate: 'TC-Lane-Obsr' });
    assert.equal(result['car-a'].headSha, 'abcdef1');
  });

  it('gives each issue its own pill, inheriting the car\'s stage unless the issue itself is closed', () => {
    const result = tracker.syncWaveDispatchState({
      cars: [{ id: 'car-a', issues: [{ id: 1, state: 'open' }, { id: 2, state: 'closed' }] }],
      lanes: [{ carId: 'car-a', status: 'committed' }]
    });
    assert.deepEqual(result['car-a'].issues, [
      { id: 1, pill: { code: 'in-progress', label: 'In progress' } },
      { id: 2, pill: { code: 'closed', label: 'Completed' } }
    ]);
  });

  it('a closed car marked deployedNotConfirmed reads "Deployed, awaiting a check" in its pill', () => {
    const result = tracker.syncWaveDispatchState({
      cars: [{ id: 'car-a', deployedNotConfirmed: true, issues: [{ id: 1, state: 'closed' }] }]
    });
    assert.deepEqual(result['car-a'].pill, { code: 'deployed', label: 'Deployed, awaiting a check' });
  });

  it('marks a closed row merged on a real merged PR, OR on confirmedComplete alone, never on "all issues closed" by itself (#3138, PRR-A R1)', () => {
    const mergedPr = tracker.syncWaveDispatchState({
      cars: baseCars, pullRequests: [{ carId: 'car-a', number: 42, state: 'merged' }]
    });
    assert.equal(mergedPr['car-a'].merged, true);

    const confirmed = tracker.syncWaveDispatchState({
      cars: [{ id: 'car-a', confirmedComplete: true, issues: [{ id: 1, state: 'closed' }] }]
    });
    assert.equal(confirmed['car-a'].merged, true);

    const neither = tracker.syncWaveDispatchState({
      cars: [{ id: 'car-a', issues: [{ id: 1, state: 'closed' }] }]
    });
    assert.equal(neither['car-a'].stage, 'closed');
    assert.equal(neither['car-a'].merged, false);

    // Never set at all for a non-closed stage.
    assert.equal('merged' in tracker.syncWaveDispatchState({ cars: baseCars })['car-a'], false);
  });

  it('builds a PR link only with a repo slug AND a PR number, validating the slug shape', () => {
    const withRepo = tracker.syncWaveDispatchState({
      cars: baseCars, pullRequests: [{ carId: 'car-a', number: 42, state: 'open' }], repo: 'Jason-Vaughan/TangleClaw'
    });
    assert.equal(withRepo['car-a'].prUrl, 'https://github.com/Jason-Vaughan/TangleClaw/pull/42');

    const noRepo = tracker.syncWaveDispatchState({
      cars: baseCars, pullRequests: [{ carId: 'car-a', number: 42, state: 'open' }]
    });
    assert.equal('prUrl' in noRepo['car-a'], false);

    const badRepo = tracker.syncWaveDispatchState({
      cars: baseCars, pullRequests: [{ carId: 'car-a', number: 42, state: 'open' }], repo: 'not a slug'
    });
    assert.equal('prUrl' in badRepo['car-a'], false);
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
    assert.deepEqual(summary.reports, []);
  });

  it('normalizes a reports catalog when the caller supplies one (#3112, PRR-B I-Gate R1 BLOCKING 2)', () => {
    const summary = tracker.buildNativeSprintReportSummary({
      reports: [{ id: 'v6.4.0', version: 'v6.4.0', title: 'v6.4.0 live report', url: 'https://example.test/v6.4.0' }]
    });
    assert.deepEqual(summary.reports, [
      { id: 'v6.4.0', version: 'v6.4.0', title: 'v6.4.0 live report', url: 'https://example.test/v6.4.0', kind: 'report' }
    ]);
  });
});

describe('native-sprint-tracker: sixStagePill (#3112)', () => {
  it('maps unassigned and claimed to the same open/"Not started" pill', () => {
    assert.deepEqual(tracker.sixStagePill('unassigned'), { code: 'open', label: 'Not started' });
    assert.deepEqual(tracker.sixStagePill('claimed'), { code: 'open', label: 'Not started' });
  });

  it('maps in-progress, in-review and blocked straight through', () => {
    assert.deepEqual(tracker.sixStagePill('in-progress'), { code: 'in-progress', label: 'In progress' });
    assert.deepEqual(tracker.sixStagePill('in-review'), { code: 'in-review', label: 'In review' });
    assert.deepEqual(tracker.sixStagePill('blocked'), { code: 'blocked', label: 'Blocked' });
  });

  it('maps closed to "Completed" by default, and to "Deployed, awaiting a check" when not yet confirmed', () => {
    assert.deepEqual(tracker.sixStagePill('closed'), { code: 'closed', label: 'Completed' });
    assert.deepEqual(tracker.sixStagePill('closed', true), { code: 'deployed', label: 'Deployed, awaiting a check' });
    assert.deepEqual(tracker.sixStagePill('closed', false), { code: 'closed', label: 'Completed' });
  });

  it('falls back to open/"Not started" for an unrecognized stage', () => {
    assert.deepEqual(tracker.sixStagePill('nonsense'), { code: 'open', label: 'Not started' });
  });

  it('exports the same 6-stage label vocabulary the issue names', () => {
    assert.deepEqual(tracker.SIX_STAGE_PILL_LABELS, {
      open: 'Not started',
      'in-progress': 'In progress',
      'in-review': 'In review',
      blocked: 'Blocked',
      deployed: 'Deployed, awaiting a check',
      closed: 'Completed'
    });
  });
});

describe('native-sprint-tracker: buildSprintWaveSnapshot (#3112)', () => {
  const baseInput = {
    currentVersion: 'v6.4.1',
    shippedVersions: ['6.4.0', 'v6.3.0', '6.2.10', '6.2.9'],
    roadmapData: {
      releases: [
        { version: '6.4.0', trains: [{ cars: [1, 2] }] },
        { version: '6.4.1', trains: [{ cars: [3, 4, 5] }] },
        { version: '6.5.0', trains: [{ cars: [6] }] }
      ]
    },
    cars: [
      {
        id: 'W1-A', version: 'v6.4.1', lane: 'TC-Lane-A', reviewers: { oGate: 'TC-Lane-Obsr', prr: 'TC-Lane-PRR-A' },
        files: ['public/v6-shell.js'],
        issues: [{ id: 3105, state: 'closed' }, { id: 3106, state: 'closed' }]
      },
      {
        id: 'W1-B', version: 'v6.4.1', reviewers: { oGate: 'TC-Lane-Obsr', prr: 'TC-Lane-PRR-B' },
        files: ['lib/usage-windows.js'],
        issues: [{ id: 3109, state: 'open' }, { id: 3110, state: 'open' }]
      }
    ],
    lanes: [
      { carId: 'W1-A', name: 'TC-Lane-A', status: 'committed' },
      { carId: 'W1-B', name: 'TC-Lane-B', status: 'committed' }
    ],
    pullRequests: [
      { carId: 'W1-A', number: 3200, state: 'merged' },
      { carId: 'W1-B', number: 3201, state: 'open' }
    ],
    reports: [
      { id: 'v6.4.0', version: 'v6.4.0', title: 'v6.4.0 live report', url: 'https://example.test/v6.4.0' },
      { id: 'v6.2.2-v6.4.0-retrospective', version: null, title: 'v6.2.2-v6.4.0 Retrospective', kind: 'retrospective' }
    ]
  };

  it('classifies releases into active, planned and shipped', () => {
    const snapshot = tracker.buildSprintWaveSnapshot(baseInput);
    assert.deepEqual(snapshot.releases.active, [{ version: 'v6.4.1', status: 'active', carCount: 3 }]);
    assert.deepEqual(snapshot.releases.planned, [{ version: 'v6.5.0', status: 'planned', carCount: 1 }]);
    assert.deepEqual(snapshot.releases.shipped, [{ version: 'v6.4.0', status: 'shipped', carCount: 2 }]);
  });

  it('#3162 (PRR-B R-Gate REVISE, BLOCKING 2): classifies the current version as shipped, not active, once it is in shippedVersions AND every one of its own cars is closed', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({
      currentVersion: 'v6.5.2',
      shippedVersions: ['6.5.2'],
      roadmapData: { releases: [{ version: '6.5.2', trains: [{ cars: [1] }] }] },
      cars: [{ id: 'W1-B', version: 'v6.5.2', issues: [{ id: 1, state: 'closed' }], confirmedComplete: true }]
    });
    assert.deepEqual(snapshot.releases.shipped, [{ version: 'v6.5.2', status: 'shipped', carCount: 1 }]);
    assert.deepEqual(snapshot.releases.active, []);
  });

  it('#3162 BLOCKING 2: keeps the current version active while it still has an open car, even though it is already in shippedVersions', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({
      currentVersion: 'v6.5.3',
      shippedVersions: ['6.5.3'],
      roadmapData: { releases: [{ version: '6.5.3', trains: [{ cars: [1, 2] }] }] },
      cars: [
        { id: 'W1-A', version: 'v6.5.3', issues: [{ id: 1, state: 'closed' }], confirmedComplete: true },
        { id: 'W1-B', version: 'v6.5.3', issues: [{ id: 2, state: 'open' }] }
      ]
    });
    assert.deepEqual(snapshot.releases.active, [{ version: 'v6.5.3', status: 'active', carCount: 2 }]);
    assert.deepEqual(snapshot.releases.shipped, []);
  });

  it('#3162 BLOCKING 2: a current version with no cars at all and shipped stays shipped, not stuck active forever', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({
      currentVersion: 'v6.5.2',
      shippedVersions: ['6.5.2'],
      roadmapData: { releases: [{ version: '6.5.2', trains: [{ cars: [1] }] }] },
      cars: []
    });
    assert.deepEqual(snapshot.releases.shipped, [{ version: 'v6.5.2', status: 'shipped', carCount: 1 }]);
  });

  it('enriches every car with its lane, reviewers, files, PR number and 6-stage pill', () => {
    const snapshot = tracker.buildSprintWaveSnapshot(baseInput);
    const carA = snapshot.cars.find((c) => c.id === 'W1-A');
    const carB = snapshot.cars.find((c) => c.id === 'W1-B');
    // W1-A: both issues closed and a merged PR -> dispatch stage 'closed' -> pill 'closed'.
    assert.equal(carA.lane, 'TC-Lane-A');
    assert.deepEqual(carA.reviewers, { oGate: 'TC-Lane-Obsr', prr: 'TC-Lane-PRR-A' });
    assert.deepEqual(carA.files, ['public/v6-shell.js']);
    assert.equal(carA.prNumber, 3200);
    assert.deepEqual(carA.pill, { code: 'closed', label: 'Completed' });
    // #3138 (PRR-A R1): merged carries through for renderSprintCarCards' own carGates() call.
    assert.equal(carA.merged, true);
    assert.equal(carA.headSha, null);
    // W1-B: an open PR -> dispatch stage 'in-review' -> pill 'in-review'; no explicit
    // car.lane given, so it falls back to the lane row's own name.
    assert.equal(carB.lane, 'TC-Lane-B');
    assert.equal(carB.prNumber, 3201);
    assert.deepEqual(carB.pill, { code: 'in-review', label: 'In review' });
    // W1-B is not closed, so merged is deliberately false, not absent -- a
    // stable boolean field every car carries, never a sometimes-present key.
    assert.equal(carB.merged, false);
  });

  it('gives each issue its own pill: closed when the issue itself is closed, else the car\'s current stage', () => {
    const snapshot = tracker.buildSprintWaveSnapshot(baseInput);
    const carB = snapshot.cars.find((c) => c.id === 'W1-B');
    assert.deepEqual(carB.issues, [
      { id: 3109, title: null, summary: null, dependsOn: [], pill: { code: 'in-review', label: 'In review' } },
      { id: 3110, title: null, summary: null, dependsOn: [], pill: { code: 'in-review', label: 'In review' } }
    ]);
  });

  it('passes through an issue\'s title, summary and dependsOn (prerequisites) when given', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({
      cars: [{
        id: 'W1-X',
        issues: [{ id: 1, state: 'open', title: 'Fix the thing', summary: 'A short summary', dependsOn: ['#2'] }]
      }]
    });
    assert.deepEqual(snapshot.cars[0].issues, [
      { id: 1, title: 'Fix the thing', summary: 'A short summary', dependsOn: ['#2'], pill: { code: 'open', label: 'Not started' } }
    ]);
  });

  it('computes the active sprint progress and scheduled-item summary', () => {
    const snapshot = tracker.buildSprintWaveSnapshot(baseInput);
    assert.deepEqual(snapshot.summary, {
      plannedVersions: 1,
      releasedVersions: 1,
      activeSprintProgress: { closed: 2, total: 4, pct: 50 },
      scheduledItems: 3 + 1 // active car count + planned car count
    });
  });

  it('normalizes the reports catalog, defaulting title to id and kind to "report"', () => {
    const snapshot = tracker.buildSprintWaveSnapshot(baseInput);
    assert.deepEqual(snapshot.reports, [
      { id: 'v6.4.0', version: 'v6.4.0', title: 'v6.4.0 live report', url: 'https://example.test/v6.4.0', kind: 'report' },
      { id: 'v6.2.2-v6.4.0-retrospective', version: null, title: 'v6.2.2-v6.4.0 Retrospective', url: null, kind: 'retrospective' }
    ]);
  });

  it('a closed car marked deployedNotConfirmed reads "Deployed, awaiting a check" rather than "Completed"', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({
      cars: [{ id: 'W-REL', deployedNotConfirmed: true, issues: [{ id: 1, state: 'closed' }] }],
      pullRequests: [{ carId: 'W-REL', number: 1, state: 'merged' }]
    });
    assert.deepEqual(snapshot.cars[0].pill, { code: 'deployed', label: 'Deployed, awaiting a check' });
  });

  it('defaults every field on an empty input rather than throwing', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({});
    assert.deepEqual(snapshot.releases, { active: [], planned: [], shipped: [] });
    assert.deepEqual(snapshot.cars, []);
    assert.deepEqual(snapshot.reports, []);
    assert.deepEqual(snapshot.summary, {
      plannedVersions: 0, releasedVersions: 0,
      activeSprintProgress: { closed: 0, total: 0, pct: 0 },
      scheduledItems: 0
    });
  });

  it('drops a reports entry with no string id rather than throwing', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({ reports: [{ title: 'no id' }, null, { id: 'ok', title: 'Fine' }] });
    assert.deepEqual(snapshot.reports, [{ id: 'ok', version: null, title: 'Fine', url: null, kind: 'report' }]);
  });

  it('passes through a car\'s version, defaulting to null, so the UI layer can group cars by release', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({ cars: [{ id: 'a', version: 'v6.4.1' }, { id: 'b' }] });
    assert.equal(snapshot.cars[0].version, 'v6.4.1');
    assert.equal(snapshot.cars[1].version, null);
  });

  it('sorts shipped releases newest-first and planned releases soonest-first', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({
      currentVersion: 'v6.4.1',
      shippedVersions: ['6.2.9', '6.2.10', '6.3.0', '6.4.0'],
      roadmapData: {
        releases: [
          { version: '6.2.9', trains: [] }, { version: '6.4.0', trains: [] },
          { version: '6.2.10', trains: [] }, { version: '6.3.0', trains: [] },
          { version: '6.6.0', trains: [] }, { version: '6.5.0', trains: [] }
        ]
      }
    });
    assert.deepEqual(snapshot.releases.shipped.map((r) => r.version), ['v6.4.0', 'v6.3.0', 'v6.2.10', 'v6.2.9']);
    assert.deepEqual(snapshot.releases.planned.map((r) => r.version), ['v6.5.0', 'v6.6.0']);
  });

  it('synthesizes a fallback car row from roadmap trains for a release with no matching input car (#3112, PRR-B I-Gate R1 WARNING 1; pill fixed for a shipped release by #3162)', () => {
    const snapshot = tracker.buildSprintWaveSnapshot(baseInput);
    // v6.4.0 (shipped) and v6.5.0 (planned) have no car in baseInput.cars -- both must still
    // show their roadmap-placed issues, not an empty table.
    const shipped = snapshot.cars.find((c) => c.version === 'v6.4.0');
    const planned = snapshot.cars.find((c) => c.version === 'v6.5.0');
    assert.deepEqual(shipped.issues.map((i) => i.id), [1, 2]);
    // #3162: a shipped release's fallback row (no dispatched car for it)
    // must read closed/"Completed" -- the release itself is already
    // classified `shipped` above, and a fallback row reading "Not started"
    // underneath a release card that says it shipped is exactly the bug.
    assert.deepEqual(shipped.pill, { code: 'closed', label: 'Completed' });
    assert.deepEqual(shipped.issues.map((i) => i.pill), [{ code: 'closed', label: 'Completed' }, { code: 'closed', label: 'Completed' }]);
    assert.deepEqual(planned.issues.map((i) => i.id), [6]);
    assert.deepEqual(planned.pill, { code: 'open', label: 'Not started' });
    // v6.4.1 (active) DOES have matching cars (W1-A, W1-B) -- no fallback row for it.
    assert.equal(snapshot.cars.filter((c) => c.version === 'v6.4.1').length, 2);
  });

  it('does not count a fallback car\'s placeholder issues toward activeSprintProgress', () => {
    const snapshot = tracker.buildSprintWaveSnapshot(baseInput);
    // Only W1-A's 2 closed + W1-B's 2 open issues (4 total, 2 closed) -- not the 3 extra
    // placeholder issues the v6.4.0/v6.5.0 fallback rows carry.
    assert.deepEqual(snapshot.summary.activeSprintProgress, { closed: 2, total: 4, pct: 50 });
  });

  it('synthesizes one fallback row per train, and skips a train with no cars', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({
      roadmapData: { releases: [{ version: '6.5.0', trains: [{ cars: [1] }, { cars: [] }, { cars: [2, 3] }] }] }
    });
    const rows = snapshot.cars.filter((c) => c.version === 'v6.5.0');
    assert.deepEqual(rows.map((r) => r.issues.map((i) => i.id)), [[1], [2, 3]]);
  });

  it('#3163: enriches every car with carId, branch, title and a bare status string alongside the existing fields', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({
      ...baseInput,
      cars: baseInput.cars.map((c) => ({ ...c, branch: `feat/${c.id}`, title: `Car ${c.id}` }))
    });
    const carA = snapshot.cars.find((c) => c.id === 'W1-A');
    assert.equal(carA.carId, 'W1-A');
    assert.equal(carA.branch, 'feat/W1-A');
    assert.equal(carA.title, 'Car W1-A');
    assert.equal(carA.status, 'closed');
    const carB = snapshot.cars.find((c) => c.id === 'W1-B');
    assert.equal(carB.status, 'in-review');
  });

  it('#3163: a fallback row also carries carId, branch, title and status (null/unassigned for a planned release)', () => {
    const snapshot = tracker.buildSprintWaveSnapshot(baseInput);
    const shipped = snapshot.cars.find((c) => c.version === 'v6.4.0');
    const planned = snapshot.cars.find((c) => c.version === 'v6.5.0');
    assert.equal(shipped.carId, shipped.id);
    assert.equal(shipped.branch, null);
    assert.equal(shipped.title, null);
    assert.equal(shipped.status, 'closed');
    assert.equal(planned.status, 'unassigned');
  });

  it('#3164: a done car\'s recorded PR reads merged (not open), and pullRequests carries lane/title/status', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({
      currentVersion: 'v6.4.1',
      cars: [{ id: 'W1-C', version: 'v6.4.1', lane: 'TC-Lane-C', title: 'Shipped car', issues: [{ id: 1, state: 'closed' }] }],
      pullRequests: [{ carId: 'W1-C', number: 3300, state: 'merged', title: 'Shipped car', lane: 'TC-Lane-C', status: 'complete' }]
    });
    const car = snapshot.cars.find((c) => c.id === 'W1-C');
    assert.equal(car.prNumber, 3300);
    assert.equal(car.merged, true);
  });

  it('#3166: roadmapSyncStatus is absent when input.syncStatus is never mentioned, and present (ok) when it is', () => {
    const noMention = tracker.buildSprintWaveSnapshot(baseInput);
    assert.equal('roadmapSyncStatus' in noMention, false);
    const mentioned = tracker.buildSprintWaveSnapshot({ ...baseInput, syncStatus: { state: 'ok' } });
    assert.deepEqual(mentioned.roadmapSyncStatus, { state: 'ok', message: null });
  });

  it('#3166: roadmapSyncStatus reads degraded when the hub has no link for the current version, even though syncStatus says ok', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({
      ...baseInput,
      syncStatus: { state: 'ok' },
      hubHtml: '<a href="./v6.3.0/">v6.3.0</a>'
    });
    assert.equal(snapshot.roadmapSyncStatus.state, 'degraded');
    assert.match(snapshot.roadmapSyncStatus.message, /v6\.4\.1/);
  });

  it('#3175: forwards reportHtml into roadmapSyncStatus only when the caller actually mentions it', () => {
    const withReport = tracker.buildSprintWaveSnapshot({
      ...baseInput,
      syncStatus: { state: 'ok' },
      hubHtml: '<a href="./v6.4.1/">v6.4.1</a>',
      reportHtml: null
    });
    assert.equal(withReport.roadmapSyncStatus.state, 'degraded');
    assert.match(withReport.roadmapSyncStatus.message, /missing/);

    const withoutReport = tracker.buildSprintWaveSnapshot({
      ...baseInput,
      syncStatus: { state: 'ok' },
      hubHtml: '<a href="./v6.4.1/">v6.4.1</a>'
    });
    assert.deepEqual(withoutReport.roadmapSyncStatus, { state: 'ok', message: null });
  });
});

describe('native-sprint-tracker: parseShippedVersionsFromChangelog (#3162)', () => {
  it('reads every bracketed released heading, newest first as the file already orders them', () => {
    const text = '# Changelog\n\n## [Unreleased]\n\n## [6.5.2] - 2026-11-20\n\n### Added\n- x\n\n## [6.5.1] - 2026-11-16\n\n### Fixed\n- y\n';
    assert.deepEqual(tracker.parseShippedVersionsFromChangelog(text), ['6.5.2', '6.5.1']);
  });

  it('reads a bare (non-bracketed) heading style too', () => {
    const text = '## 1.4.2 - 2026-01-01\n\n### Fixed\n- y\n';
    assert.deepEqual(tracker.parseShippedVersionsFromChangelog(text), ['1.4.2']);
  });

  it('never matches [Unreleased] -- it has no digits to match', () => {
    assert.deepEqual(tracker.parseShippedVersionsFromChangelog('## [Unreleased]\n\nNothing yet.\n'), []);
  });

  it('returns an empty array for a non-string or empty input, never throws', () => {
    assert.deepEqual(tracker.parseShippedVersionsFromChangelog(null), []);
    assert.deepEqual(tracker.parseShippedVersionsFromChangelog(''), []);
    assert.deepEqual(tracker.parseShippedVersionsFromChangelog(undefined), []);
  });
});

describe('native-sprint-tracker: validateRoadmapSyncStatus (#3166)', () => {
  it('reads ok when syncStatus is healthy and the hub links the current version', () => {
    const result = tracker.validateRoadmapSyncStatus({
      currentVersion: 'v6.5.2', syncStatus: { state: 'ok' }, hubHtml: '<a href="./v6.5.2/">v6.5.2</a>'
    });
    assert.deepEqual(result, { state: 'ok', message: null });
  });

  it('fails closed when syncStatus itself is missing, malformed or not ok, before ever looking at the hub', () => {
    assert.equal(tracker.validateRoadmapSyncStatus({ currentVersion: 'v6.5.2', syncStatus: null }).state, 'degraded');
    assert.equal(tracker.validateRoadmapSyncStatus({ currentVersion: 'v6.5.2', syncStatus: { state: 'error' } }).state, 'degraded');
    assert.equal(tracker.validateRoadmapSyncStatus({ currentVersion: 'v6.5.2', syncStatus: { ok: false } }).state, 'degraded');
  });

  it('fails closed when syncStatus says ok but the hub has no link for the current shipped version -- the exact #3166 gap', () => {
    const result = tracker.validateRoadmapSyncStatus({
      currentVersion: 'v6.5.2', syncStatus: { state: 'ok' }, hubHtml: '<a href="./v6.5.1/">v6.5.1</a>'
    });
    assert.equal(result.state, 'degraded');
    assert.match(result.message, /v6\.5\.2/);
  });

  it('skips the hub check entirely when hubHtml or currentVersion is not supplied, and still reads ok from syncStatus alone', () => {
    assert.deepEqual(tracker.validateRoadmapSyncStatus({ syncStatus: { state: 'ok' } }), { state: 'ok', message: null });
    assert.deepEqual(tracker.validateRoadmapSyncStatus({ currentVersion: 'v6.5.2', syncStatus: { state: 'ok' } }), { state: 'ok', message: null });
  });

  it('#3175: reads ok when syncStatus, the hub link and the report HTML are all healthy', () => {
    const result = tracker.validateRoadmapSyncStatus({
      currentVersion: 'v6.5.4',
      syncStatus: { state: 'ok' },
      hubHtml: '<a href="./v6.5.4/">v6.5.4</a>',
      reportHtml: '<section id="postmortem">settled</section>'
    });
    assert.deepEqual(result, { state: 'ok', message: null });
  });

  it('#3175: fails closed when the report is missing from disk (reportHtml resolved null), even though syncStatus and the hub link both say ok', () => {
    const result = tracker.validateRoadmapSyncStatus({
      currentVersion: 'v6.5.4',
      syncStatus: { state: 'ok' },
      hubHtml: '<a href="./v6.5.4/">v6.5.4</a>',
      reportHtml: null
    });
    assert.equal(result.state, 'degraded');
    assert.match(result.message, /v6\.5\.4/);
    assert.match(result.message, /missing/);
  });

  it('#3175: fails closed when the report still carries the auto-generated live-tracker marker', () => {
    const withComment = tracker.validateRoadmapSyncStatus({
      currentVersion: 'v6.5.4',
      syncStatus: { state: 'ok' },
      hubHtml: '<a href="./v6.5.4/">v6.5.4</a>',
      reportHtml: '<!-- AUTO_GENERATED_LIVE_SPRINT_REPORT --><section id="postmortem"></section>'
    });
    assert.equal(withComment.state, 'degraded');
    assert.match(withComment.message, /not been settled/);

    const withLiveTracking = tracker.validateRoadmapSyncStatus({
      currentVersion: 'v6.5.4',
      syncStatus: { state: 'ok' },
      hubHtml: '<a href="./v6.5.4/">v6.5.4</a>',
      reportHtml: '<table id="postmortem-rule-283"><tr>LIVE TRACKING</tr></table>'
    });
    assert.equal(withLiveTracking.state, 'degraded');
  });

  it('#3175: skips the report-settlement check entirely when reportHtml is never mentioned, unchanged from before #3175', () => {
    const result = tracker.validateRoadmapSyncStatus({
      currentVersion: 'v6.5.4', syncStatus: { state: 'ok' }, hubHtml: '<a href="./v6.5.4/">v6.5.4</a>'
    });
    assert.deepEqual(result, { state: 'ok', message: null });
  });
});

describe('native-sprint-tracker: parseSprintReportSettlement (#3175)', () => {
  it('reads settled: false with empty post-mortem fields for a non-string/empty report', () => {
    assert.deepEqual(tracker.parseSprintReportSettlement(null), {
      settled: false,
      postMortem: { whatWorked: [], whatDidnt: [], rule283PassCount: 0 }
    });
    assert.deepEqual(tracker.parseSprintReportSettlement(''), {
      settled: false,
      postMortem: { whatWorked: [], whatDidnt: [], rule283PassCount: 0 }
    });
  });

  it('reads settled: false while either unsettled marker is present, regardless of post-mortem content', () => {
    const html = '<!-- AUTO_GENERATED_LIVE_SPRINT_REPORT --><section id="postmortem">'
      + '<ul id="postmortem-what-worked"><li>Parallel lanes</li></ul></section>';
    assert.equal(tracker.parseSprintReportSettlement(html).settled, false);
  });

  it('parses whatWorked/whatDidnt list points and the Rule #283 pass count from a settled report', () => {
    const html = '<section id="postmortem">'
      + '<ul id="postmortem-what-worked"><li>Disjoint file envelopes</li><li>Fast CI</li></ul>'
      + '<ul id="postmortem-what-didnt"><li>Report settlement drifted</li></ul>'
      + '<table id="postmortem-rule-283">'
      + '<tr data-status="pass"><td>1</td></tr><tr data-status="pass"><td>2</td></tr>'
      + '<tr data-status="fail"><td>3</td></tr>'
      + '</table>'
      + '</section>';
    const result = tracker.parseSprintReportSettlement(html);
    assert.equal(result.settled, true);
    assert.deepEqual(result.postMortem.whatWorked, ['Disjoint file envelopes', 'Fast CI']);
    assert.deepEqual(result.postMortem.whatDidnt, ['Report settlement drifted']);
    assert.equal(result.postMortem.rule283PassCount, 2);
  });

  it('reads empty post-mortem fields, never throws, when the settled report has no postmortem section at all', () => {
    const result = tracker.parseSprintReportSettlement('<section id="overview">shipped</section>');
    assert.equal(result.settled, true);
    assert.deepEqual(result.postMortem, { whatWorked: [], whatDidnt: [], rule283PassCount: 0 });
  });

  it('#3175 (real shape): parses the real sprint-reports generator\'s pm-item/Rule #283 table markup, with no synthetic ids at all', () => {
    const rows = Array.from({ length: 16 }, (_, i) => {
      const n = i + 1;
      const status = n <= 14
        ? '<span class="badge badge-green">PASS</span>'
        : '<span class="badge badge-red">FAIL</span>';
      return `<tr><td>${n}</td><td>Measure ${n}</td><td>${status}</td><td>detail</td></tr>`;
    }).join('');
    const html = '<section class="section" id="postmortem">'
      + '<div class="pm-item"><h4>Disjoint lanes</h4><p>Zero file collisions across the wave.</p></div>'
      + '<div class="pm-item warn"><h4>Report settlement drifted</h4><p>v6.5.3 shipped with a live placeholder.</p></div>'
      + `<table><thead><tr><th>#</th><th>Rule #283 Audit Dimension</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table>`
      + '</section>';
    const result = tracker.parseSprintReportSettlement(html);
    assert.equal(result.settled, true);
    assert.deepEqual(result.postMortem.whatWorked, ['Disjoint lanes: Zero file collisions across the wave.']);
    assert.deepEqual(result.postMortem.whatDidnt, ['Report settlement drifted: v6.5.3 shipped with a live placeholder.']);
    assert.equal(result.postMortem.rule283PassCount, 14);
  });

  it('#3175 (real shape, verified against the real sprint-reports/v6.5.3/index.html): does not overcount from an unrelated badge-green table, and tolerates an annotated PASS cell', () => {
    // The real #postmortem holds TWO tables: a "4-Gate Matrix" (4 data rows,
    // each also PASS/badge-green) and the Rule #283 table (16 rows) -- a
    // whole-section badge scan over-counts by the first table's own rows,
    // and 2 of the real 16 rows read "PASS (Recovered)"/"PASS (0 Red Runs)",
    // not bare "PASS" -- both reproduced here from the real bytes.
    const gateMatrix = '<table><thead><tr><th>Gate</th><th>Owner</th><th>Status</th></tr></thead><tbody>'
      + Array.from({ length: 4 }, (_, i) => `<tr><td>Gate ${i + 1}</td><td>TC-Lane-Arc</td><td><span class="badge badge-green">PASS</span></td></tr>`).join('')
      + '</tbody></table>';
    const rule283Rows = Array.from({ length: 16 }, (_, i) => {
      const n = i + 1;
      const status = n === 6 ? '<span class="badge badge-green">PASS (0 Red Runs)</span>'
        : n === 9 ? '<span class="badge badge-green">PASS (Recovered)</span>'
          : '<span class="badge badge-green">PASS</span>';
      return `<tr><td>${n}</td><td>Measure ${n}</td><td>${status}</td></tr>`;
    }).join('');
    const rule283Table = `<table><thead><tr><th>#</th><th>Rule #283 Audit Dimension</th><th>Verdict</th></tr></thead><tbody>${rule283Rows}</tbody></table>`;
    const html = `<section class="section" id="postmortem">${gateMatrix}${rule283Table}</section>`;
    assert.equal(tracker.parseSprintReportSettlement(html).postMortem.rule283PassCount, 16);
  });

  it('#3175: the synthetic ul/table convention wins over the real pm-item/badge shape when BOTH are present in the same section', () => {
    const html = '<section id="postmortem">'
      + '<ul id="postmortem-what-worked"><li>Synthetic point</li></ul>'
      + '<table id="postmortem-rule-283"><tr data-status="pass"><td>1</td></tr></table>'
      + '<div class="pm-item"><h4>Real point</h4><p>should be ignored</p></div>'
      + '<span class="badge badge-green">PASS</span><span class="badge badge-green">PASS</span>'
      + '</section>';
    const result = tracker.parseSprintReportSettlement(html);
    assert.deepEqual(result.postMortem.whatWorked, ['Synthetic point']);
    assert.equal(result.postMortem.rule283PassCount, 1);
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
  it('lists its own five routes', () => {
    const router = createSprintWaveRouter({});
    assert.deepEqual(router.routes, [
      { method: 'GET', pattern: '/api/sprint-waves' },
      { method: 'POST', pattern: '/api/sprint-waves/validate-disjointness' },
      { method: 'GET', pattern: '/api/sprint-reports/:version' },
      { method: 'POST', pattern: '/api/sprint-waves/sync' },
      { method: 'GET', pattern: '/api/sprint-waves/github-activity' }
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
    // #3112: the same cars/lanes/pullRequests feed buildSprintWaveSnapshot too,
    // so the v6 PM Workspace tabs render this car without a second round-trip.
    assert.equal(json().snapshot.cars.length, 1);
    assert.equal(json().snapshot.cars[0].id, 'car-a');
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
    // A well-formed version nothing knows. A malformed one ('vNope', a path)
    // is refused 400 before the lookup since #3087 (Ruling A774), pinned below.
    const router = createSprintWaveRouter({ getSprintDataForVersion: async () => null });
    const { req } = fakeReq('GET', '/api/sprint-reports/v9.9.9');
    const { res, status, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(status(), 404);
    assert.equal(json().code, 'NOT_FOUND');
  });

  it('GET /api/sprint-reports/:version refuses a malformed version 400 without calling the lookup (#3087)', async () => {
    let asked = 0;
    const router = createSprintWaveRouter({ getSprintDataForVersion: async () => { asked++; return null; } });
    const { req } = fakeReq('GET', '/api/sprint-reports/vNope');
    const { res, status, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(status(), 400);
    assert.equal(json().code, 'BAD_REQUEST');
    assert.equal(asked, 0);
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

  it('GET /api/sprint-waves threads a loaded roadmap into the dispatch PR link and the snapshot release grouping (#3134)', async () => {
    const router = createSprintWaveRouter({
      getSprintData: async () => ({
        version: 'v6.5.1',
        waves: [],
        cars: [{ id: 'car-a', issues: [], version: 'v6.5.1' }],
        lanes: [],
        pullRequests: [{ carId: 'car-a', number: 42, state: 'open' }]
      }),
      getRoadmapData: () => ({
        data: { releases: [{ version: '6.5.1', trains: [{ cars: [1] }] }] },
        repo: 'Jason-Vaughan/TangleClaw',
        source: 'roadmap2-data.json'
      })
    });
    const { req } = fakeReq('GET', '/api/sprint-waves');
    const { res, status, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(status(), 200);
    assert.equal(json().roadmapSource, 'roadmap2-data.json');
    assert.equal(json().dispatch['car-a'].prUrl, 'https://github.com/Jason-Vaughan/TangleClaw/pull/42');
    assert.equal(json().snapshot.releases.active[0].version, 'v6.5.1');
  });

  it('GET /api/sprint-waves answers roadmapSource "unconfigured" with no getRoadmapData, unaffected otherwise (#3134)', async () => {
    const router = createSprintWaveRouter({
      getSprintData: async () => ({ waves: [], cars: [{ id: 'car-a', issues: [] }], lanes: [], pullRequests: [] })
    });
    const { req } = fakeReq('GET', '/api/sprint-waves');
    const { res, status, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(status(), 200);
    assert.equal(json().roadmapSource, 'unconfigured');
    assert.equal(json().dispatch['car-a'].prUrl, undefined);
  });

  it('GET /api/sprint-waves/github-activity passes through the live activity (#3134)', async () => {
    const router = createSprintWaveRouter({ getGithubActivity: async () => ({ ok: true, repo: 'a/b', pullRequests: [] }) });
    const { req } = fakeReq('GET', '/api/sprint-waves/github-activity');
    const { res, status, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(status(), 200);
    assert.equal(json().repo, 'a/b');
  });

  it('GET /api/sprint-waves/github-activity answers 503 when not configured, and 502 when the activity call itself failed', async () => {
    const unconfigured = createSprintWaveRouter({});
    const { req: req1 } = fakeReq('GET', '/api/sprint-waves/github-activity');
    const { res: res1, status: status1, json: json1 } = fakeRes();
    await unconfigured.handle(req1, res1);
    assert.equal(status1(), 503);
    assert.equal(json1().code, 'NOT_CONFIGURED');

    const failing = createSprintWaveRouter({ getGithubActivity: async () => ({ ok: false, error: 'no repo configured' }) });
    const { req: req2 } = fakeReq('GET', '/api/sprint-waves/github-activity');
    const { res: res2, status: status2 } = fakeRes();
    await failing.handle(req2, res2);
    assert.equal(status2(), 502);
  });

  it('#3162: GET /api/sprint-waves threads getShippedVersions into the snapshot\'s release classification', async () => {
    const router = createSprintWaveRouter({
      getSprintData: async () => ({ version: 'v6.4.1', waves: [], cars: [], lanes: [], pullRequests: [] }),
      getRoadmapData: () => ({ data: { releases: [{ version: '6.4.0', trains: [{ cars: [1] }] }] }, repo: null, source: 'fallback' }),
      getShippedVersions: async () => ['6.4.0']
    });
    const { req } = fakeReq('GET', '/api/sprint-waves');
    const { res, status, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(status(), 200);
    assert.deepEqual(json().snapshot.releases.shipped, [{ version: 'v6.4.0', status: 'shipped', carCount: 1 }]);
    // #3162: the fallback row synthesized for it must read closed/"Completed" too.
    assert.deepEqual(json().snapshot.cars[0].pill, { code: 'closed', label: 'Completed' });
  });

  it('#3162: GET /api/sprint-waves classifies nothing as shipped with no getShippedVersions, unchanged from before #3162', async () => {
    const router = createSprintWaveRouter({
      getSprintData: async () => ({ version: 'v6.4.1', waves: [], cars: [], lanes: [], pullRequests: [] }),
      getRoadmapData: () => ({ data: { releases: [{ version: '6.4.0', trains: [{ cars: [1] }] }] }, repo: null, source: 'fallback' })
    });
    const { req } = fakeReq('GET', '/api/sprint-waves');
    const { res, json } = fakeRes();
    await router.handle(req, res);
    assert.deepEqual(json().snapshot.releases.shipped, []);
    assert.deepEqual(json().snapshot.releases.planned, [{ version: 'v6.4.0', status: 'planned', carCount: 1 }]);
  });

  it('#3164: GET /api/sprint-waves and GET /api/sprint-reports/:version both carry getReports into their reports catalog', async () => {
    const reports = [{ id: 'v6.5.1', version: 'v6.5.1', title: 'v6.5.1 report', url: 'docs/releases/v6.5.1.md' }];
    const normalized = reports.map((r) => ({ ...r, kind: 'report' }));
    const router = createSprintWaveRouter({
      getSprintData: async () => ({ version: 'v6.5.1', waves: [], cars: [], lanes: [], pullRequests: [] }),
      getSprintDataForVersion: async (version) => ({ version, cars: [], pullRequests: [] }),
      getReports: async () => reports
    });
    const { req: req1 } = fakeReq('GET', '/api/sprint-waves');
    const { res: res1, json: json1 } = fakeRes();
    await router.handle(req1, res1);
    assert.deepEqual(json1().snapshot.reports, normalized);

    const { req: req2 } = fakeReq('GET', '/api/sprint-reports/v6.5.1');
    const { res: res2, json: json2 } = fakeRes();
    await router.handle(req2, res2);
    assert.deepEqual(json2().report.reports, normalized);
  });

  it('#3164: GET /api/sprint-reports/:version carries getReleaseCommit into heroKpis.releaseCommit', async () => {
    const router = createSprintWaveRouter({
      getSprintDataForVersion: async (version) => ({ version, cars: [], pullRequests: [] }),
      getReleaseCommit: async (version) => (version === 'v6.5.1' ? 'abc123deadbeef' : null)
    });
    const { req } = fakeReq('GET', '/api/sprint-reports/v6.5.1');
    const { res, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(json().report.heroKpis.releaseCommit, 'abc123deadbeef');
  });

  it('#3164 (PRR-B R-Gate REVISE, BLOCKING 1d): GET /api/sprint-reports/current calls getReleaseCommit with the RESOLVED version, never the literal "current"', async () => {
    const seen = [];
    const router = createSprintWaveRouter({
      getSprintDataForVersion: async () => ({ version: 'v6.5.3', cars: [], pullRequests: [] }),
      getReleaseCommit: async (version) => { seen.push(version); return null; }
    });
    const { req } = fakeReq('GET', '/api/sprint-reports/current');
    const { res } = fakeRes();
    await router.handle(req, res);
    assert.deepEqual(seen, ['v6.5.3'], 'getReleaseCommit must never be asked to resolve a tag literally named "current"');
  });

  it('#3164 (Architect Ruling A859, R2): a null getReleaseCommit never stomps out a releaseCommit getSprintDataForVersion already resolved', async () => {
    const router = createSprintWaveRouter({
      // The run's own real releaseCommit, same as sprintDataFromWaveRuns now resolves from v6.5.2's real row.
      getSprintDataForVersion: async (version) => ({ version, cars: [], pullRequests: [], releaseCommit: 'd173f071c9c71c3758fa4112966fdd88bed96457' }),
      getReleaseCommit: async () => null
    });
    const { req } = fakeReq('GET', '/api/sprint-reports/v6.5.2');
    const { res, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(json().report.heroKpis.releaseCommit, 'd173f071c9c71c3758fa4112966fdd88bed96457');
  });

  it('#3164: getReports/getReleaseCommit never mutate the object getSprintDataForVersion returned', async () => {
    const shared = { version: 'v6.5.1', cars: [], pullRequests: [] };
    const router = createSprintWaveRouter({
      getSprintDataForVersion: async () => shared,
      getReports: async () => [{ id: 'x', version: null, title: 'x' }],
      getReleaseCommit: async () => 'sha123'
    });
    const { req } = fakeReq('GET', '/api/sprint-reports/v6.5.1');
    const { res } = fakeRes();
    await router.handle(req, res);
    assert.equal('reports' in shared, false);
    assert.equal('releaseCommit' in shared, false);
  });

  it('#3166: GET /api/sprint-waves attaches roadmapSyncStatus from getSyncStatus/getReportsHubHtml', async () => {
    const router = createSprintWaveRouter({
      getSprintData: async () => ({ version: 'v6.5.2', waves: [], cars: [], lanes: [], pullRequests: [] }),
      getSyncStatus: async () => ({ state: 'ok' }),
      getReportsHubHtml: async () => '<a href="./v6.5.1/">v6.5.1</a>'
    });
    const { req } = fakeReq('GET', '/api/sprint-waves');
    const { res, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(json().snapshot.roadmapSyncStatus.state, 'degraded');
  });

  it('#3166: GET /api/sprint-waves omits roadmapSyncStatus entirely with no getSyncStatus, unchanged from before #3166', async () => {
    const router = createSprintWaveRouter({
      getSprintData: async () => ({ version: 'v6.5.2', waves: [], cars: [], lanes: [], pullRequests: [] })
    });
    const { req } = fakeReq('GET', '/api/sprint-waves');
    const { res, json } = fakeRes();
    await router.handle(req, res);
    assert.equal('roadmapSyncStatus' in json().snapshot, false);
  });

  it('#3175: GET /api/sprint-waves threads getSprintReportHtml into roadmapSyncStatus, degraded when the report is missing', async () => {
    let askedFor = null;
    const router = createSprintWaveRouter({
      getSprintData: async () => ({ version: 'v6.5.4', waves: [], cars: [], lanes: [], pullRequests: [] }),
      getSyncStatus: async () => ({ state: 'ok' }),
      getReportsHubHtml: async () => '<a href="./v6.5.4/">v6.5.4</a>',
      getSprintReportHtml: async (version) => { askedFor = version; return null; }
    });
    const { req } = fakeReq('GET', '/api/sprint-waves');
    const { res, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(askedFor, 'v6.5.4');
    assert.equal(json().snapshot.roadmapSyncStatus.state, 'degraded');
    assert.match(json().snapshot.roadmapSyncStatus.message, /missing/);
  });

  it('#3175: GET /api/sprint-waves reads roadmapSyncStatus ok when getSprintReportHtml resolves a settled report', async () => {
    const router = createSprintWaveRouter({
      getSprintData: async () => ({ version: 'v6.5.4', waves: [], cars: [], lanes: [], pullRequests: [] }),
      getSyncStatus: async () => ({ state: 'ok' }),
      getReportsHubHtml: async () => '<a href="./v6.5.4/">v6.5.4</a>',
      getSprintReportHtml: async () => '<section id="postmortem">settled</section>'
    });
    const { req } = fakeReq('GET', '/api/sprint-waves');
    const { res, json } = fakeRes();
    await router.handle(req, res);
    assert.deepEqual(json().snapshot.roadmapSyncStatus, { state: 'ok', message: null });
  });

  it('#3175: GET /api/sprint-reports/:version surfaces settled/postMortem from getSprintReportHtml', async () => {
    const router = createSprintWaveRouter({
      getSprintDataForVersion: async (version) => ({ version, cars: [], pullRequests: [] }),
      getSprintReportHtml: async (version) => (version === 'v6.5.1'
        ? '<section id="postmortem">'
          + '<ul id="postmortem-what-worked"><li>Disjoint lanes</li></ul>'
          + '<ul id="postmortem-what-didnt"><li>Slow CI</li></ul>'
          + '<table id="postmortem-rule-283"><tr data-status="pass"><td>1</td></tr></table>'
          + '</section>'
        : null)
    });
    const { req } = fakeReq('GET', '/api/sprint-reports/v6.5.1');
    const { res, status, json } = fakeRes();
    await router.handle(req, res);
    assert.equal(status(), 200);
    assert.equal(json().report.settled, true);
    assert.deepEqual(json().report.postMortem, { whatWorked: ['Disjoint lanes'], whatDidnt: ['Slow CI'], rule283PassCount: 1 });
  });

  it('#3175: GET /api/sprint-reports/:version omits settled/postMortem entirely with no getSprintReportHtml, unchanged from before #3175', async () => {
    const router = createSprintWaveRouter({
      getSprintDataForVersion: async (version) => ({ version, cars: [], pullRequests: [] })
    });
    const { req } = fakeReq('GET', '/api/sprint-reports/v6.5.1');
    const { res, json } = fakeRes();
    await router.handle(req, res);
    assert.equal('settled' in json().report, false);
    assert.equal('postMortem' in json().report, false);
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

  it('renders a pill badge inside a card only when the row carries one (#3112, PRR-B I-Gate R1 BLOCKING 2)', () => {
    const withPill = sprintWaveUi.renderSprintWaveBoard(null, {
      dispatch: { 'car-a': { stage: 'claimed', laneName: null, openPrNumber: null, pill: { code: 'open', label: 'Not started' } } }
    });
    assert.match(withPill, /sprint-stage-pill is-open">Not started</);
    const withoutPill = sprintWaveUi.renderSprintWaveBoard(null, { dispatch: { 'car-a': { stage: 'claimed', laneName: null, openPrNumber: null } } });
    assert.doesNotMatch(withoutPill, /sprint-stage-pill/);
  });

  it('never composes enriched car cards inside the board, even when a row carries files, reviewers or issues (#3138: one fewer duplicate car listing)', () => {
    // #3138's root-cause report: the same cars appeared on one screen as the
    // stage columns, the gate matrix, AND a third `renderSprintCarCards`
    // listing. The matrix's exact markup is locked by other in-flight tests
    // this module cannot touch, so the fix removes this third listing
    // specifically -- `renderSprintCarCards` stays available as its own
    // standalone builder (see its own describe block) for a caller that
    // wants the richer per-car detail view, just never auto-composed here.
    const enriched = sprintWaveUi.renderSprintWaveBoard(null, {
      dispatch: {
        'car-a': {
          stage: 'in-review', laneName: 'TC-Lane-A', openPrNumber: 42,
          pill: { code: 'in-review', label: 'In review' },
          files: ['lib/a.js'], reviewers: { oGate: 'TC-Lane-Obsr' }
        }
      }
    });
    assert.doesNotMatch(enriched, /sprint-car-cards/);
    assert.doesNotMatch(enriched, /Builder: TC-Lane-A/);
  });

  it('separates adjacent fields in a stage-column card with a visible, literal separator (#3138: no more mashed "V650-W1-ATC-Lane-DCompleted")', () => {
    const html = sprintWaveUi.renderSprintWaveBoard(null, {
      dispatch: {
        'car-a': { stage: 'closed', laneName: 'TC-Lane-D', openPrNumber: 3107, pill: { code: 'closed', label: 'Completed' } }
      }
    });
    assert.match(html, /<span class="sprint-wave-car-id">car-a<\/span> · <span class="sprint-wave-lane">TC-Lane-D<\/span> · <span class="sprint-wave-pr">#3107<\/span> <span class="sprint-stage-pill is-closed">Completed<\/span>/);
  });

  it('renders the gate-matrix PR cell as a link only when the row carries prUrl, else the exact original plain text (#3138, PRR-A R1)', () => {
    const withUrl = sprintWaveUi.renderSprintWaveBoard(null, {
      dispatch: { 'car-a': { stage: 'closed', laneName: 'TC-Lane-A', openPrNumber: 3200, prUrl: 'https://github.com/a/b/pull/3200' } }
    });
    assert.match(withUrl, /<td class="sprint-gate-pr"><a href="https:\/\/github\.com\/a\/b\/pull\/3200" target="_blank" rel="noopener noreferrer">#3200<\/a><\/td>/);

    // No prUrl -- byte-identical to the pre-#3134 format test/v6-b1-ui-shell.test.js locks in.
    const withoutUrl = sprintWaveUi.renderSprintWaveBoard(null, {
      dispatch: { 'car-a': { stage: 'closed', laneName: 'TC-Lane-A', openPrNumber: 3200 } }
    });
    assert.match(withoutUrl, /<td class="sprint-gate-pr">#3200<\/td>/);
  });

  it('merged + headSha carried into carGates by renderSprintCarCards, reading all-pass once merged, and a stale SHA correctly (#3138, PRR-A R1)', () => {
    const merged = sprintWaveUi.renderSprintCarCards({
      cars: [{ id: 'car-a', pill: { code: 'closed', label: 'Completed' }, merged: true, headSha: 'abcdef1234567890' }]
    });
    assert.doesNotMatch(merged, /is-unknown/);
    assert.equal((merged.match(/sprint-gate-pill is-pass is-inferred/g) || []).length, 6);

    const notMerged = sprintWaveUi.renderSprintCarCards({
      cars: [{ id: 'car-a', pill: { code: 'closed', label: 'Completed' }, merged: false }]
    });
    assert.match(notMerged, /is-unknown/);
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

describe('public/sprint-wave-ui: Charter & Kaizen panels (#3087, Rulings A760/A761)', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>';
  /** No raw tag from the hostile string survives; its escaped form does. */
  const inert = (html, where) => {
    assert.ok(!html.includes('<img'), `${where}: a raw <img> tag reached the HTML`);
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), `${where}: the hostile text is not shown escaped`);
  };

  it('escapes hostile markup in EVERY charter text field', () => {
    const fields = {
      'charter.title': { charter: { title: HOSTILE } },
      'charter.status': { charter: { status: HOSTILE } },
      'startupSummary.title': { startupSummary: { title: HOSTILE } },
      'startupSummary.mission': { startupSummary: { mission: HOSTILE } },
      'startupSummary.activeConstraints': { startupSummary: { activeConstraints: HOSTILE } },
      'startupSummary.versionNumber': { startupSummary: { versionNumber: HOSTILE } },
      'activeVersion.version_number': { activeVersion: { version_number: HOSTILE } },
      'approvals[].approver_role': { approvals: [{ approver_role: HOSTILE, approver_actor: 'op' }] },
      'approvals[].approver_actor': { approvals: [{ approver_role: 'pm', approver_actor: HOSTILE }] }
    };
    for (const [where, data] of Object.entries(fields)) inert(sprintWaveUi.renderCharterReadinessPanel(data), where);
  });

  it('escapes hostile markup in EVERY Kaizen text field, and renders a report link for http(s) only', () => {
    const fields = {
      'items[].defect_category': { items: [{ defect_category: HOSTILE }] },
      'items[].root_cause': { items: [{ root_cause: HOSTILE }] },
      'items[].corrective_action_spec': { items: [{ corrective_action_spec: HOSTILE }] },
      'items[].lifecycle_state': { items: [{ lifecycle_state: HOSTILE }] },
      'gate0Feed[].title': { gate0Feed: [{ title: HOSTILE }] },
      'gate0Feed[].gate0_disposition': { gate0Feed: [{ title: 't', gate0_disposition: HOSTILE }] },
      'reportSummary.title': { reportSummary: { title: HOSTILE } }
    };
    for (const [where, data] of Object.entries(fields)) inert(sprintWaveUi.renderKaizenLedgerPanel(data), where);
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', '//evil.example/x', '/relative', 'https://x.example/"onmouseover=1']) {
      const html = sprintWaveUi.renderKaizenLedgerPanel({ reportSummary: { title: 'r', reportUrl: bad } });
      assert.ok(!html.includes('<a '), `no link for ${bad}`);
    }
    const ok = sprintWaveUi.renderKaizenLedgerPanel({ reportSummary: { title: 'v6.3.0', reportUrl: 'https://x.example/r?a=1&b=2' } });
    assert.match(ok, /<a href="https:\/\/x\.example\/r\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">v6\.3\.0<\/a>/);
  });

  it('reads camelCase view-models as well as raw snake_case rows, and writes into a container when given one', () => {
    const container = { innerHTML: '' };
    const html = sprintWaveUi.renderKaizenLedgerPanel({ items: [{ rootCause: 'missing guard', lifecycleState: 'Verified' }] }, container);
    assert.equal(container.innerHTML, html);
    assert.match(html, /missing guard/);
    assert.match(html, /data-state="Verified"/);
    const charter = sprintWaveUi.renderCharterReadinessPanel({ approvals: [{ approverRole: 'sponsor', approverActor: 'op', revokedAt: 'x' }] });
    assert.match(charter, /sponsor: op \(revoked\)/);
  });

  it('exports the A774 alias names for the same two builders', () => {
    assert.equal(sprintWaveUi.renderSprintCharterRoadmapPanel, sprintWaveUi.renderCharterReadinessPanel);
    assert.equal(sprintWaveUi.renderSprintKaizenReportsPanel, sprintWaveUi.renderKaizenLedgerPanel);
  });

  it('every field is optional: an empty call renders a calm empty panel', () => {
    assert.match(sprintWaveUi.renderCharterReadinessPanel(), /No active charter/);
    assert.match(sprintWaveUi.renderKaizenLedgerPanel(), /No Kaizen items/);
  });

  it('refuses a container passed first, so a swapped call fails loudly instead of rendering an empty panel', () => {
    assert.throws(() => sprintWaveUi.renderCharterReadinessPanel({ innerHTML: '' }), /data comes first/);
    assert.throws(() => sprintWaveUi.renderKaizenLedgerPanel({ innerHTML: '' }, {}), /data comes first/);
  });

  it('renderKaizenLedgerPanel composes the hero KPI cards and reports catalog when given heroKpis/reports (#3112, PRR-B I-Gate R1 BLOCKING 2)', () => {
    // The exact shape `GET /api/sprint-reports/:version` -> `data.report || data` already
    // passes straight through to this function (buildNativeSprintReportSummary's own return).
    const html = sprintWaveUi.renderKaizenLedgerPanel({
      heroKpis: { issuesClosed: 3, builderPRs: 1 },
      reports: [{ id: 'v6.4.0', title: 'v6.4.0 live report', url: 'https://x.example/r' }]
    });
    assert.match(html, /Issues Closed/);
    assert.match(html, /<a href="https:\/\/x\.example\/r"[^>]*>v6\.4\.0 live report<\/a>/);
  });

  it('renderKaizenLedgerPanel renders neither when heroKpis/reports are absent, unchanged from before #3112', () => {
    const html = sprintWaveUi.renderKaizenLedgerPanel({ items: [{ rootCause: 'x' }] });
    assert.doesNotMatch(html, /sprint-kpi-row/);
    assert.doesNotMatch(html, /sprint-report-cards/);
  });

  it('renderCharterReadinessPanel composes the Release-First Roadmap only when given a roadmapSnapshot (#3112, PRR-B I-Gate R1 BLOCKING 2)', () => {
    const snapshot = tracker.buildSprintWaveSnapshot({
      roadmapData: { releases: [{ version: '6.4.1', trains: [{ cars: [1] }] }] }, currentVersion: 'v6.4.1'
    });
    const html = sprintWaveUi.renderCharterReadinessPanel({ charter: { title: 'T' }, roadmapSnapshot: snapshot });
    assert.match(html, /sprint-roadmap-panel/);
    const without = sprintWaveUi.renderCharterReadinessPanel({ charter: { title: 'T' } });
    assert.doesNotMatch(without, /sprint-roadmap-panel/);
  });
});

describe('public/sprint-wave-ui: Release-First Roadmap, Sprint Car cards & Reports catalog (#3112)', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>';

  const snapshot = () => tracker.buildSprintWaveSnapshot({
    currentVersion: 'v6.4.1',
    shippedVersions: ['6.4.0'],
    roadmapData: {
      releases: [
        { version: '6.4.0', trains: [{ cars: [1] }] },
        { version: '6.4.1', trains: [{ cars: [2, 3] }] },
        { version: '6.5.0', trains: [{ cars: [4] }] }
      ]
    },
    cars: [
      {
        id: 'W1-A', version: 'v6.4.1', lane: 'TC-Lane-A',
        reviewers: { oGate: 'TC-Lane-Obsr', prr: 'TC-Lane-PRR-A' },
        files: ['public/v6-shell.js'],
        issues: [{ id: 3105, state: 'open', summary: 'Waiting-On panel', dependsOn: ['#3100'] }]
      }
    ],
    lanes: [{ carId: 'W1-A', name: 'TC-Lane-A', status: 'committed' }],
    pullRequests: [{ carId: 'W1-A', number: 3200, state: 'open' }],
    reports: [{ id: 'v6.4.0', version: 'v6.4.0', title: 'v6.4.0 live report', url: 'https://x.example/r' }]
  });

  describe('renderReleaseRoadmap', () => {
    it('renders no roadmap link at all when the producer supplies no roadmapUrl (#3345, #3325 fast-follow — never defaults to TangleClaw\'s own hardcoded SSOT page for an unresolved project/fleet)', () => {
      const html = sprintWaveUi.renderReleaseRoadmap(snapshot());
      assert.doesNotMatch(html, /sprint-roadmap-public-ssot/);
      assert.doesNotMatch(html, /jason-vaughan\.github\.io/);
    });

    it('links out to the producer-supplied roadmapUrl, labeled with groupName when given (#3345, #3325 fast-follow)', () => {
      const html = sprintWaveUi.renderReleaseRoadmap(Object.assign({}, snapshot(), {
        roadmapUrl: 'https://github.com/SomeOwner/SomeFleetRepo', groupName: 'TiLT-Fleet', projectName: 'TiLT-PM'
      }));
      assert.match(html, /<a href="https:\/\/github\.com\/SomeOwner\/SomeFleetRepo" target="_blank" rel="noopener noreferrer">🌐 TiLT-Fleet Roadmap ↗<\/a>/);
      assert.match(html, /Release-First Roadmap — TiLT-Fleet/);
    });

    it('falls back to projectName for the label when no groupName is given', () => {
      const html = sprintWaveUi.renderReleaseRoadmap(Object.assign({}, snapshot(), {
        roadmapUrl: 'https://github.com/SomeOwner/SomeRepo', projectName: 'Solo-Project'
      }));
      assert.match(html, /🌐 Solo-Project Roadmap ↗/);
      assert.match(html, /Release-First Roadmap — Solo-Project/);
    });

    it('labels the link generically when roadmapUrl is given but neither groupName nor projectName is', () => {
      const html = sprintWaveUi.renderReleaseRoadmap(Object.assign({}, snapshot(), {
        roadmapUrl: 'https://github.com/SomeOwner/SomeRepo'
      }));
      assert.match(html, /🌐 Project Roadmap ↗/);
      assert.doesNotMatch(html, /Release-First Roadmap — /);
    });

    it('escapes an untrusted groupName/projectName rather than injecting it raw', () => {
      const html = sprintWaveUi.renderReleaseRoadmap(Object.assign({}, snapshot(), {
        roadmapUrl: 'https://github.com/x/y', groupName: HOSTILE
      }));
      assert.doesNotMatch(html, /<img/);
    });

    it('PUBLIC_SSOT_URL is still exported, for any external caller that still wants it, even though renderReleaseRoadmap no longer defaults to it', () => {
      assert.equal(sprintWaveUi.PUBLIC_SSOT_URL, 'https://jason-vaughan.github.io/TangleClaw/');
    });

    it('renders the summary metrics bar', () => {
      const html = sprintWaveUi.renderReleaseRoadmap(snapshot());
      assert.match(html, /Planned versions[\s\S]*>1</);
      assert.match(html, /Released versions[\s\S]*>1</);
      assert.match(html, /Active sprint progress/);
      assert.match(html, /Scheduled items/);
    });

    it('renders one expandable release card per group, active open by default', () => {
      const html = sprintWaveUi.renderReleaseRoadmap(snapshot());
      assert.match(html, /<details class="sprint-roadmap-release" open data-version="v6\.4\.1">/);
      assert.match(html, /<details class="sprint-roadmap-release" data-version="v6\.5\.0">/);
      assert.match(html, /<details class="sprint-roadmap-release" data-version="v6\.4\.0">/);
      assert.doesNotMatch(html, /<details class="sprint-roadmap-release" open data-version="v6\.5\.0">/);
    });

    it('renders the active release\'s car/issue table with its 6-stage pill, prerequisites and summary', () => {
      const html = sprintWaveUi.renderReleaseRoadmap(snapshot());
      assert.match(html, /data-car-id="W1-A"/);
      assert.match(html, /<td class="sprint-roadmap-car-lane">TC-Lane-A<\/td>/);
      assert.match(html, /data-issue-id="3105"/);
      assert.match(html, /sprint-stage-pill is-in-review">In review</);
      assert.match(html, /<code>#3100<\/code>/);
      assert.match(html, /Waiting-On panel/);
    });

    it('escapes hostile markup in a release version, car id, lane and issue fields', () => {
      const html = sprintWaveUi.renderReleaseRoadmap(tracker.buildSprintWaveSnapshot({
        currentVersion: HOSTILE,
        roadmapData: { releases: [{ version: HOSTILE, trains: [] }] },
        cars: [{ id: HOSTILE, version: `v${HOSTILE}`, lane: HOSTILE, issues: [{ id: HOSTILE, summary: HOSTILE, dependsOn: [HOSTILE] }] }]
      }));
      assert.ok(!html.includes('<img'), 'a raw <img> tag reached the roadmap HTML');
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the hostile text is not shown escaped');
    });

    it('refuses a container passed first', () => {
      assert.throws(() => sprintWaveUi.renderReleaseRoadmap({ innerHTML: '' }), /data comes first/);
    });

    it('every field is optional: an empty call renders a calm empty panel', () => {
      assert.match(sprintWaveUi.renderReleaseRoadmap(), /No releases to show yet/);
    });

    it('writes into a container that has an innerHTML property', () => {
      const container = {};
      const html = sprintWaveUi.renderReleaseRoadmap(snapshot(), container);
      assert.equal(container.innerHTML, html);
    });
  });

  describe('renderSprintCarCards', () => {
    it('renders one card per car with its lane, reviewers, PR, 6-stage pill, gates and file scope', () => {
      const html = sprintWaveUi.renderSprintCarCards(snapshot());
      assert.match(html, /data-car-id="W1-A"/);
      assert.match(html, /Builder: TC-Lane-A/);
      assert.match(html, /O-Gate: TC-Lane-Obsr/);
      assert.match(html, /PRR: TC-Lane-PRR-A/);
      assert.match(html, /#3200/);
      assert.match(html, /sprint-stage-pill is-in-review">In review</);
      assert.match(html, /sprint-gate-pill/);
      assert.match(html, /<code>public\/v6-shell\.js<\/code>/);
    });

    it('escapes hostile markup in every car and issue field', () => {
      const html = sprintWaveUi.renderSprintCarCards({
        cars: [{ id: HOSTILE, lane: HOSTILE, reviewers: { oGate: HOSTILE, prr: HOSTILE }, files: [HOSTILE],
          pill: { code: 'open', label: HOSTILE }, issues: [{ id: HOSTILE, pill: { code: 'open', label: HOSTILE } }] }]
      });
      assert.ok(!html.includes('<img'), 'a raw <img> tag reached the car card HTML');
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the hostile text is not shown escaped');
    });

    it('refuses a container passed first', () => {
      assert.throws(() => sprintWaveUi.renderSprintCarCards({ innerHTML: '' }), /data comes first/);
    });

    it('renders a calm empty state with no cars', () => {
      assert.match(sprintWaveUi.renderSprintCarCards({}), /No cars dispatched yet/);
    });

    it('writes into a container that has an innerHTML property', () => {
      const container = {};
      const html = sprintWaveUi.renderSprintCarCards(snapshot(), container);
      assert.equal(container.innerHTML, html);
    });
  });

  describe('renderSprintReportsCatalog', () => {
    it('renders one card per report, linking only an http(s) url', () => {
      const html = sprintWaveUi.renderSprintReportsCatalog(snapshot());
      assert.match(html, /<a href="https:\/\/x\.example\/r" target="_blank" rel="noopener noreferrer">v6\.4\.0 live report<\/a>/);
      assert.match(html, /<span class="sprint-report-version">v6\.4\.0<\/span>/);
    });

    it('renders plain text, not a link, for a report with no safe url', () => {
      const html = sprintWaveUi.renderSprintReportsCatalog({ reports: [{ id: 'r1', title: 'Report One', url: 'javascript:alert(1)' }] });
      assert.doesNotMatch(html, /<a /);
      assert.match(html, /<span>Report One<\/span>/);
    });

    it('marks a retrospective with data-kind="retrospective"', () => {
      const html = sprintWaveUi.renderSprintReportsCatalog({ reports: [{ id: 'r1', title: 'Retro', kind: 'retrospective' }] });
      assert.match(html, /data-kind="retrospective"/);
    });

    it('escapes hostile markup in every report field', () => {
      const html = sprintWaveUi.renderSprintReportsCatalog({ reports: [{ id: HOSTILE, title: HOSTILE, version: HOSTILE }] });
      assert.ok(!html.includes('<img'), 'a raw <img> tag reached the reports catalog HTML');
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the hostile text is not shown escaped');
    });

    it('refuses a container passed first', () => {
      assert.throws(() => sprintWaveUi.renderSprintReportsCatalog({ innerHTML: '' }), /data comes first/);
    });

    it('renders a calm empty state with no reports', () => {
      assert.match(sprintWaveUi.renderSprintReportsCatalog({}), /No sprint reports yet/);
    });

    it('writes into a container that has an innerHTML property', () => {
      const container = {};
      const html = sprintWaveUi.renderSprintReportsCatalog(snapshot(), container);
      assert.equal(container.innerHTML, html);
    });
  });

  describe('renderGithubPanel (#3134)', () => {
    it('renders open pull requests, issues, milestones and the latest release', () => {
      const html = sprintWaveUi.renderGithubPanel({
        ok: true, repo: 'Jason-Vaughan/TangleClaw',
        pullRequests: [{ number: 10, title: 'Add X', url: 'https://github.com/a/b/pull/10', draft: true }],
        issues: [{ number: 20, title: 'Fix Y', url: 'https://github.com/a/b/issues/20' }],
        milestones: [{ title: 'v6.5.1', openIssues: 2, closedIssues: 8, url: 'https://github.com/a/b/milestone/1' }],
        latestRelease: { tagName: 'v6.5.0', name: 'v6.5.0', url: 'https://github.com/a/b/releases/tag/v6.5.0' }
      });
      assert.match(html, /🐙 GitHub — Jason-Vaughan\/TangleClaw/);
      assert.match(html, /<a href="https:\/\/github\.com\/a\/b\/pull\/10"[^>]*>#10 Add X<\/a>/);
      assert.match(html, /is-pending">Draft<\/span>/);
      assert.match(html, /<a href="https:\/\/github\.com\/a\/b\/issues\/20"[^>]*>#20 Fix Y<\/a>/);
      assert.match(html, /2 open \/ 8 closed/);
      assert.match(html, /<a href="https:\/\/github\.com\/a\/b\/releases\/tag\/v6\.5\.0"[^>]*>v6\.5\.0<\/a>/);
    });

    it('renders calm empty states for each section with no data', () => {
      const html = sprintWaveUi.renderGithubPanel({ ok: true, repo: 'a/b' });
      assert.match(html, /No open pull requests\./);
      assert.match(html, /No open issues\./);
      assert.match(html, /No open milestones\./);
      assert.match(html, /No published release yet\./);
    });

    it('renders the error when the activity call itself failed, never crashing on it', () => {
      const html = sprintWaveUi.renderGithubPanel({ ok: false, error: 'rate limited' });
      assert.match(html, /GitHub activity is unavailable: rate limited/);
    });

    it('escapes hostile markup in every field, and never links an unsafe url', () => {
      const html = sprintWaveUi.renderGithubPanel({
        ok: true, repo: HOSTILE,
        pullRequests: [{ number: 1, title: HOSTILE, url: 'javascript:alert(1)' }]
      });
      assert.ok(!html.includes('<img'), 'a raw <img> tag reached the GitHub panel HTML');
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the hostile text is not shown escaped');
      assert.doesNotMatch(html, /<a href="javascript:/);
    });

    it('writes into a container, and refuses one passed first', () => {
      const container = {};
      const html = sprintWaveUi.renderGithubPanel({ ok: true, repo: 'a/b' }, container);
      assert.equal(container.innerHTML, html);
      assert.throws(() => sprintWaveUi.renderGithubPanel({ innerHTML: '' }), /data comes first/);
    });
  });
});

describe('native-sprint-tracker: sprintDataFromWaveRuns (#3087, Ruling A774)', () => {
  const run = (id, createdAt, status, cars, metadata = {}) => ({
    id, fleetId: 'f', status, createdAt, metadata, waves: [Object.keys(cars)],
    cars: Object.fromEntries(Object.entries(cars).map(([cid, c]) => [cid, { id: cid, status: 'pending', payload: {}, startedAt: null, completedAt: null, ...c }]))
  });

  it('answers an empty sprint for "current" when no run is persisted, and null for an unknown version', () => {
    assert.deepEqual(tracker.sprintDataFromWaveRuns({}, 'current'),
      { version: null, cars: [], lanes: [], pullRequests: [], waves: [], learnings: [], releaseCommit: null });
    assert.equal(tracker.sprintDataFromWaveRuns({}, '9.9.9'), null);
  });

  it('resolves the sprint version from metadata.version, falling back to the run id (#3112, PRR-B I-Gate R1 BLOCKING 2)', () => {
    const runs = {
      old: run('old', 1, 'active', { a: {} }, { version: '6.3.0' }),
      v640: run('v6.4.0', 4, 'complete', { d: {} })
    };
    assert.equal(tracker.sprintDataFromWaveRuns(runs, 'v6.3.0').version, 'v6.3.0');
    assert.equal(tracker.sprintDataFromWaveRuns(runs, '6.4.0').version, 'v6.4.0');
  });

  it('carries forward a car\'s fileScope, reviewers, headSha and lane, and synthesizes an open PR from openPrNumber (#3112, PRR-B I-Gate R1 BLOCKING 2)', () => {
    const data = tracker.sprintDataFromWaveRuns({
      r: run('r', 1, 'active', {
        rich: {
          status: 'running',
          fileScope: ['lib/a.js', 'lib/b.js'],
          payload: {
            lane: 'TC-Lane-A', reviewers: { oGate: 'TC-Lane-Obsr', prr: 'TC-Lane-PRR-A' },
            headSha: 'abcdef1234567890', openPrNumber: 42
          }
        }
      })
    }, 'current');
    const car = data.cars.find((c) => c.id === 'rich');
    assert.deepEqual(car.files, ['lib/a.js', 'lib/b.js']);
    assert.deepEqual(car.reviewers, { oGate: 'TC-Lane-Obsr', prr: 'TC-Lane-PRR-A' });
    assert.equal(car.headSha, 'abcdef1234567890');
    assert.equal(car.lane, 'TC-Lane-A');
    // #3164: lane/title/status now ride along on every synthesized PR entry
    // (title null here -- the fixture's payload sets no `title`).
    assert.deepEqual(data.pullRequests, [{ carId: 'rich', number: 42, state: 'open', title: null, lane: 'TC-Lane-A', status: 'running' }]);
    const dispatch = tracker.syncWaveDispatchState({ cars: data.cars, lanes: data.lanes, pullRequests: data.pullRequests });
    assert.equal(dispatch.rich.openPrNumber, 42);
    assert.equal(dispatch.rich.stage, 'in-review');
  });

  it('marks confirmedComplete only for a genuinely complete car, never a cancelled one, even with no PR number recorded (#3138, PRR-A R1)', () => {
    const data = tracker.sprintDataFromWaveRuns({
      r: run('r', 1, 'active', {
        done: { status: 'complete' },
        cancelled: { status: 'cancelled' },
        running: { status: 'running' }
      })
    }, 'current');
    assert.equal(data.cars.find((c) => c.id === 'done').confirmedComplete, true);
    assert.equal(data.cars.find((c) => c.id === 'cancelled').confirmedComplete, undefined);
    assert.equal(data.cars.find((c) => c.id === 'running').confirmedComplete, undefined);

    // Feeding this through syncWaveDispatchState: both read `closed` (via the
    // "all issues closed" marker both completion paths synthesize), but ONLY
    // the genuinely complete one reads `merged: true` -- the gate-pill fix
    // this car exists for, now covering a car with no PR info at all.
    const dispatch = tracker.syncWaveDispatchState({ cars: data.cars, lanes: [], pullRequests: [] });
    assert.equal(dispatch.done.stage, 'closed');
    assert.equal(dispatch.done.merged, true);
    assert.equal(dispatch.cancelled.stage, 'closed');
    assert.equal(dispatch.cancelled.merged, false);
  });

  it('reads the newest ACTIVE run as current, and a version by metadata.version or id', () => {
    const runs = {
      old: run('old', 1, 'active', { a: {} }, { version: '6.3.0' }),
      newer: run('newer', 3, 'complete', { b: {} }),
      mid: run('mid', 2, 'active', { c: {} }),
      v640: run('v6.4.0', 4, 'complete', { d: {} })
    };
    assert.deepEqual(tracker.sprintDataFromWaveRuns(runs, 'current').cars.map((c) => c.id), ['c'], 'newest active, not newest overall');
    assert.deepEqual(tracker.sprintDataFromWaveRuns(runs, 'v6.3.0').cars.map((c) => c.id), ['a']);
    assert.deepEqual(tracker.sprintDataFromWaveRuns(runs, '6.4.0').cars.map((c) => c.id), ['d'], 'by run id, v-prefix ignored');
    assert.deepEqual(tracker.sprintDataFromWaveRuns({ x: run('x', 1, 'complete', { e: {} }) }, 'current').cars.map((c) => c.id), ['e'],
      'with no active run, the newest run');
  });

  it('maps assignees to lanes, running work to committed, held or stalled work to a hold, and finished cars to closed', () => {
    const data = tracker.sprintDataFromWaveRuns({
      r: run('r', 1, 'active', {
        idle: {},
        run: { status: 'running', payload: { lane: 'TC-Lane-B' }, startedAt: Date.UTC(2026, 10, 15) },
        gate: { status: 'awaiting-gate', payload: { assignee: 'TC-Lane-A' } },
        held: { status: 'gate-held', payload: { laneName: 'TC-Lane-C' } },
        done: { status: 'complete', payload: { lane: 'TC-Lane-B' }, completedAt: Date.UTC(2026, 10, 16) },
        issues: { status: 'complete', payload: { issues: [{ id: '#1', state: 'open' }] } }
      })
    }, 'current');
    const dispatch = tracker.syncWaveDispatchState({ cars: data.cars, lanes: data.lanes, pullRequests: data.pullRequests });
    assert.equal(dispatch.idle.stage, 'unassigned');
    assert.equal(dispatch.run.stage, 'in-progress');
    assert.equal(dispatch.run.laneName, 'TC-Lane-B');
    assert.equal(dispatch.gate.stage, 'in-progress');
    assert.equal(dispatch.held.stage, 'blocked');
    assert.equal(dispatch.done.stage, 'closed');
    // #3164 (Architect Ruling A859, R2): a car confirmed done (here,
    // `status: 'complete'`) now normalizes every one of its own issues to
    // 'closed', overriding a stale 'open' the payload kept from dispatch
    // time -- exactly v6.5.1's real rows (`status: 'merged'`, `payload.issues`
    // still reading 'open'). Before this ruling, a stale real issue state
    // was trusted over the car's own confirmed-done signal; the ruling
    // reverses that precedence for a car isMergedCar already confirms done.
    assert.equal(dispatch.issues.stage, 'closed', 'a confirmed-done car closes its own issues, overriding a stale open state');
    assert.equal(data.cars.find((c) => c.id === 'run').dispatchedAt, '2026-11-15T00:00:00.000Z');
    assert.deepEqual(data.pullRequests, []);
    assert.equal(data.releaseCommit, null);
  });

  it('SPRINT_VERSION_RE admits current and X.Y.Z only', () => {
    for (const ok of ['current', '6.3.0', 'v6.2.10']) assert.ok(tracker.SPRINT_VERSION_RE.test(ok), ok);
    for (const bad of ['..', '../etc', '6.3', 'v6.3.0/x', 'latest', '6.3.0 ', '']) assert.ok(!tracker.SPRINT_VERSION_RE.test(bad), JSON.stringify(bad));
  });

  // #3164, Architect Ruling A859 (R2): the live `v6_wave_runs` table in
  // `~/.tangleclaw/tangleclaw.db` was inspected directly before writing
  // these -- each fixture below mirrors a real row's exact shape (v6.5.0
  // through v6.5.3), not an invented one, because this table has rows
  // written by more than one code path and the scheduler's own source is
  // not a complete picture of what is actually persisted.
  describe('real v6_wave_runs shapes (Architect Ruling A859, R2)', () => {
    it('reads a run-level "running" status as current, same as "active" (the real v6.5.3 row)', () => {
      const runs = {
        old: run('old', 1, 'complete', { a: {} }),
        live: run('live', 2, 'running', { b: {} })
      };
      assert.deepEqual(tracker.sprintDataFromWaveRuns(runs, 'current').cars.map((c) => c.id), ['b']);
    });

    it('confirms a car done via status "merged" alone (the real v6.5.1 shape), not just "complete"', () => {
      const data = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', { m: { status: 'merged' } })
      }, 'current');
      assert.equal(data.cars[0].confirmedComplete, true);
    });

    it('confirms a car done via a top-level or payload mergeSha/mergeCommit, even with no recognized status word', () => {
      const shapes = [
        { status: 'unknown', mergeSha: '64428741' },
        { status: 'unknown', mergeCommit: 'd8b145d6' },
        { status: 'unknown', payload: { mergeSha: 'abc123' } },
        { status: 'unknown', payload: { mergeCommit: 'def456' } }
      ];
      for (const [i, shape] of shapes.entries()) {
        const data = tracker.sprintDataFromWaveRuns({ r: run('r', 1, 'active', { m: shape }) }, 'current');
        assert.equal(data.cars[0].confirmedComplete, true, `shape ${i}: ${JSON.stringify(shape)}`);
      }
    });

    it('normalizes a top-level car.issues list (bare numbers and "#NNNN" strings) into {id, state} objects', () => {
      const data = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', { c: { status: 'complete', issues: [3148, '#3149'] } })
      }, 'current');
      assert.deepEqual(data.cars[0].issues, [{ id: 3148, state: 'closed' }, { id: 3149, state: 'closed' }]);
    });

    it('leaves a non-merged car\'s bare issue entries reading "open", never forcing closed', () => {
      const data = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', { c: { status: 'running', issues: [3148] } })
      }, 'current');
      assert.deepEqual(data.cars[0].issues, [{ id: 3148, state: 'open' }]);
    });

    it('prefers payload.issues over a top-level car.issues list when both are present, never both at once', () => {
      const data = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', {
          c: { status: 'complete', issues: [9999], payload: { issues: [{ id: 1, state: 'open', title: 'real' }] } }
        })
      }, 'current');
      assert.deepEqual(data.cars[0].issues, [{ id: 1, state: 'closed', title: 'real' }]);
    });

    it('reads a car\'s PR number from payload.prNumber, car.openPrNumber or car.prNumber when payload.openPrNumber is absent (the real v6.5.0-v6.5.3 shape)', () => {
      const viaPayloadPrNumber = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', { c: { status: 'running', payload: { openPrNumber: null, prNumber: 3200 } } })
      }, 'current');
      assert.deepEqual(viaPayloadPrNumber.pullRequests, [{ carId: 'c', number: 3200, state: 'open', title: null, lane: null, status: 'running' }]);

      const viaCarPrNumber = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', { c: { status: 'complete', prNumber: 3159, payload: { openPrNumber: null } } })
      }, 'current');
      assert.deepEqual(viaCarPrNumber.pullRequests, [{ carId: 'c', number: 3159, state: 'merged', title: null, lane: null, status: 'complete' }]);

      const viaCarOpenPrNumber = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', { c: { status: 'running', openPrNumber: 3169 } })
      }, 'current');
      assert.deepEqual(viaCarOpenPrNumber.pullRequests, [{ carId: 'c', number: 3169, state: 'open', title: null, lane: null, status: 'running' }]);
    });

    it('falls back to car.lane, car.headSha, car.branch and car.title when payload carries none of them (the real v6.5.2/v6.5.3 shape)', () => {
      const data = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', {
          c: { status: 'running', lane: 'TC-Lane-A', headSha: '5137820b', branch: 'feat/v653-w1a', title: 'Car title' }
        })
      }, 'current');
      const car = data.cars[0];
      assert.equal(car.lane, 'TC-Lane-A');
      assert.equal(car.headSha, '5137820b');
      assert.equal(car.branch, 'feat/v653-w1a');
      assert.equal(car.title, 'Car title');
    });

    it('folds a bare car.reviewer string into {prr: car.reviewer} when neither payload.reviewers nor car.reviewers is an object (the real v6.5.2 shape)', () => {
      const data = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', { c: { status: 'complete', reviewer: 'TC-Lane-PRR-A' } })
      }, 'current');
      assert.deepEqual(data.cars[0].reviewers, { prr: 'TC-Lane-PRR-A' });
    });

    it('prefers payload.reviewers, then car.reviewers, over a bare car.reviewer string', () => {
      const viaPayload = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', { c: { reviewer: 'ignored', payload: { reviewers: { oGate: 'A', prr: 'B' } } } })
      }, 'current');
      assert.deepEqual(viaPayload.cars[0].reviewers, { oGate: 'A', prr: 'B' });

      const viaCarObject = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', { c: { reviewer: 'ignored', reviewers: { oGate: 'C' } } })
      }, 'current');
      assert.deepEqual(viaCarObject.cars[0].reviewers, { oGate: 'C' });
    });

    it('passes through the run\'s own top-level releaseCommit (the real v6.5.2 shape), instead of always null', () => {
      const runs = { r: run('r', 1, 'active', { c: {} }) };
      runs.r.releaseCommit = 'd173f071c9c71c3758fa4112966fdd88bed96457';
      assert.equal(tracker.sprintDataFromWaveRuns(runs, 'current').releaseCommit, 'd173f071c9c71c3758fa4112966fdd88bed96457');
    });

    it('falls back to run.metadata.releaseCommit when the run carries no top-level one', () => {
      const data = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', { c: {} }, { releaseCommit: 'abc123' })
      }, 'current');
      assert.equal(data.releaseCommit, 'abc123');
    });

    it('reads releaseCommit null when neither the run nor its metadata carries one, unchanged from before this ruling', () => {
      assert.equal(tracker.sprintDataFromWaveRuns({ r: run('r', 1, 'active', { c: {} }) }, 'current').releaseCommit, null);
    });

    // PRR-B R-Gate REVISE, BLOCKING 1 (beyond Ruling A859's own R2 ask).
    it('falls back to car.mergeSha/car.mergeCommit for headSha when neither payload.headSha nor car.headSha is present (the real v6.5.0/v6.5.1 shape)', () => {
      const viaMergeSha = tracker.sprintDataFromWaveRuns({ r: run('r', 1, 'active', { c: { mergeSha: '43ce8724' } }) }, 'current');
      assert.equal(viaMergeSha.cars[0].headSha, '43ce8724');
      const viaMergeCommit = tracker.sprintDataFromWaveRuns({ r: run('r', 1, 'active', { c: { mergeCommit: 'd8b145d6' } }) }, 'current');
      assert.equal(viaMergeCommit.cars[0].headSha, 'd8b145d6');
    });

    it('prefers a real headSha over mergeSha/mergeCommit when both are present', () => {
      const data = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', { c: { headSha: 'realhead123', mergeSha: 'ignored' } })
      }, 'current');
      assert.equal(data.cars[0].headSha, 'realhead123');
    });

    it('falls back to the release car\'s (id ending "-REL") mergeCommit for releaseCommit when neither the run nor its metadata carries one (the real v6.5.0 shape)', () => {
      const data = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', {
          'V650-W1-A': { status: 'complete' },
          'V650-W-REL': { status: 'complete', mergeCommit: '63933a52' }
        })
      }, 'current');
      assert.equal(data.releaseCommit, '63933a52');
    });

    it('prefers the run\'s own releaseCommit over the release car\'s mergeCommit when both are present', () => {
      const runs = { r: run('r', 1, 'active', { 'X-W-REL': { mergeCommit: 'ignored' } }) };
      runs.r.releaseCommit = 'real-release-sha';
      assert.equal(tracker.sprintDataFromWaveRuns(runs, 'current').releaseCommit, 'real-release-sha');
    });

    it('finds no release car and reads releaseCommit null when no car id ends in "-REL" and the run itself carries none', () => {
      const data = tracker.sprintDataFromWaveRuns({
        r: run('r', 1, 'active', { 'W1-A': { mergeCommit: 'not-a-release-car' } })
      }, 'current');
      assert.equal(data.releaseCommit, null);
    });
  });
});

describe('the live server mounts the sprint wave routes (#3087, Ruling A774)', () => {
  const http = require('node:http');
  let tmpDir;
  let store;
  let server;
  let operatorHeaders;
  let openInstallToken;

  /**
   * @param {string} method
   * @param {string} urlPath
   * @param {object} [body]
   * @param {Record<string, string>} [headers]
   * @returns {Promise<{status: number, data: *}>}
   */
  function request(method, urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : null;
      const h = { 'Content-Type': 'application/json', ...headers };
      if (payload) h['Content-Length'] = Buffer.byteLength(payload);
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const ROADMAP_ENV_KEYS = [
    'TANGLECLAW_ROADMAP2_DATA_PATH', 'TANGLECLAW_LANE_QUEUE_PATH', 'TANGLECLAW_DOCS_RELEASES_DIR',
    // #3166: this operator's own machine genuinely has a real Sprint Reports
    // Hub checkout (confirmed live at its guessed default path) -- isolated
    // the same way the three roadmap sources above already are, or this
    // describe block's "empty board" fixture would pick up this machine's
    // real hub/status file and read a real `roadmapSyncStatus` on a board
    // that is supposed to have nothing to report.
    'TANGLECLAW_ROADMAP_SYNC_STATUS_PATH', 'TANGLECLAW_SPRINT_REPORTS_HUB_PATH'
  ];
  let prevRoadmapEnv;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sprint-mount-'));
    store = require('../lib/store');
    store._setBasePath(tmpDir);
    store.init();
    ({ operatorHeaders } = require('./_shared-docs-callers'));
    openInstallToken = require('../lib/open-install-token');
    // #3134/#3166: this operator's own machine (and this checkout's own
    // docs/releases/) can genuinely have real roadmap sources -- point every
    // one at a path inside this test's own throwaway tmpDir (never read) so
    // this describe block's "empty board" fixture stays genuinely empty on
    // every machine, not just one with none of these present.
    prevRoadmapEnv = Object.fromEntries(ROADMAP_ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.TANGLECLAW_ROADMAP2_DATA_PATH = path.join(tmpDir, 'no-roadmap2-data.json');
    process.env.TANGLECLAW_LANE_QUEUE_PATH = path.join(tmpDir, 'no-lane-queue.md');
    process.env.TANGLECLAW_DOCS_RELEASES_DIR = path.join(tmpDir, 'no-docs-releases');
    process.env.TANGLECLAW_ROADMAP_SYNC_STATUS_PATH = path.join(tmpDir, 'no-roadmap-sync-status.json');
    process.env.TANGLECLAW_SPRINT_REPORTS_HUB_PATH = path.join(tmpDir, 'no-sprint-reports-hub.html');
    server = require('../server').createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ROADMAP_ENV_KEYS) {
      if (prevRoadmapEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevRoadmapEnv[k];
    }
  });

  it('GET /api/sprint-waves answers an empty board with no run, and the scheduler\'s run once one exists', async () => {
    const empty = await request('GET', '/api/sprint-waves');
    assert.equal(empty.status, 200, JSON.stringify(empty.data));
    // #3134: this describe block's beforeEach points every roadmap source
    // env var at a path inside its own throwaway tmpDir, so this always
    // reads the deterministic "fallback" answer regardless of what this
    // machine's real shared roadmap-board checkout or docs/releases holds.
    const { roadmapSource, ...emptyRest } = empty.data;
    assert.equal(roadmapSource, 'fallback');
    assert.deepEqual(emptyRest, {
      ok: true, waves: [], dispatch: {},
      snapshot: {
        releases: { active: [], planned: [], shipped: [] },
        summary: { plannedVersions: 0, releasedVersions: 0, activeSprintProgress: { closed: 0, total: 0, pct: 0 }, scheduledItems: 0 },
        cars: [], reports: []
      },
      // #3345 (#3325 fast-follow): null for every field here, since this
      // unbound request names no projectId/groupId to resolve any of them
      // from, and the fallback roadmap this describe block forces has no
      // real repo for roadmapUrl to derive from either.
      projectName: null, groupName: null, roadmapUrl: null
    });
    const c3 = require('../lib/v6/c3-wave-scheduler');
    new c3.WaveScheduler({ store: new c3.SqliteSchedulerStore(store.getDb()) }).createRun({
      id: 'run1', fleetId: 'f', cars: [{ id: 'car-a', fileScope: ['lib/a.js'], payload: { lane: 'TC-Lane-B' } }, { id: 'car-b', fileScope: ['lib/b.js'] }]
    });
    const live = await request('GET', '/api/sprint-waves');
    assert.equal(live.status, 200);
    assert.deepEqual(live.data.waves, [['car-a', 'car-b']]);
    assert.equal(live.data.dispatch['car-a'].stage, 'claimed');
    assert.equal(live.data.dispatch['car-a'].laneName, 'TC-Lane-B');
    assert.equal(live.data.dispatch['car-b'].stage, 'unassigned');
    // #3112: a real run's cars are enriched into the snapshot too, not just dispatch.
    assert.equal(live.data.snapshot.cars.length, 2);
    assert.deepEqual(live.data.snapshot.cars.map((c) => c.id).sort(), ['car-a', 'car-b']);
  });

  it('#3162/#3164: GET /api/sprint-waves surfaces real shippedVersions and reports once this install\'s sources exist', async () => {
    // docs/releases/ with one real file, for a version DIFFERENT from the
    // run's own current version, so classifying it 'shipped' is actually
    // shippedVersions' doing, not the separate 'active' precedence rule.
    // (getShippedVersions/getReports are called fresh per request, unlike
    // #3166's getSyncStatus/getReportsHubHtml, which this describe block's
    // own `createSprintWaveRouter` tests already cover directly -- those two
    // are wired once at server MOUNT time based on whether this install can
    // reach a sync source at all, which this already-running `beforeEach`
    // server decided before this test's fixtures existed on disk.)
    const docsReleasesDir = path.join(tmpDir, 'docs-releases');
    fs.mkdirSync(docsReleasesDir);
    fs.writeFileSync(path.join(docsReleasesDir, 'v9.9.0.md'), '# v9.9.0 — A fixture release\n\nBody.\n');
    process.env.TANGLECLAW_DOCS_RELEASES_DIR = docsReleasesDir;
    // roadmap2-data.json naming that shipped version as a release with no
    // matching car, so its fallback row's pill is the signal shippedVersions
    // actually reached buildSprintWaveSnapshot.
    fs.writeFileSync(process.env.TANGLECLAW_ROADMAP2_DATA_PATH, JSON.stringify({
      releases: [{ version: '9.9.0', trains: [{ cars: [1] }] }]
    }));
    const c3 = require('../lib/v6/c3-wave-scheduler');
    new c3.WaveScheduler({ store: new c3.SqliteSchedulerStore(store.getDb()) }).createRun({
      id: 'run1', fleetId: 'f', cars: [{ id: 'car-a', fileScope: ['lib/a.js'] }], metadata: { version: '9.9.1' }
    });

    const live = await request('GET', '/api/sprint-waves');
    assert.equal(live.status, 200, JSON.stringify(live.data));
    assert.deepEqual(live.data.snapshot.releases.shipped, [{ version: 'v9.9.0', status: 'shipped', carCount: 1 }]);
    // #3162: the fallback row synthesized for it (no real car named v9.9.0,
    // only the run's own "car-a" at v9.9.1) must read closed/"Completed",
    // not the old hardcoded "Not started".
    const fallback = live.data.snapshot.cars.find((c) => c.version === 'v9.9.0');
    assert.deepEqual(fallback.pill, { code: 'closed', label: 'Completed' });
    assert.deepEqual(live.data.snapshot.reports, [{ id: 'v9.9.0', version: 'v9.9.0', title: 'v9.9.0 — A fixture release', url: 'docs/releases/v9.9.0.md', kind: 'report' }]);
  });

  it('GET /api/sprint-reports/:version: current answers, an unknown version 404s, anything else 400s before any lookup', async () => {
    const current = await request('GET', '/api/sprint-reports/current');
    assert.equal(current.status, 200, JSON.stringify(current.data));
    assert.equal(current.data.ok, true);
    assert.equal((await request('GET', '/api/sprint-reports/9.9.9')).status, 404);
    for (const bad of ['..%2F..%2Fetc', 'latest', '6.3']) {
      const r = await request('GET', `/api/sprint-reports/${bad}`);
      assert.equal(r.status, 400, `${bad}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.code, 'BAD_REQUEST');
    }
  });

  it('POST /api/sprint-waves/sync is the operator\'s only: refused without the proof, admitted with it (then NOT_CONFIGURED)', async () => {
    const noToken = await request('POST', '/api/sprint-waves/sync', {}, operatorHeaders(server));
    assert.equal(noToken.status, 403, JSON.stringify(noToken.data));
    assert.equal(noToken.data.code, 'OPEN_INSTALL_TOKEN_INVALID');
    const admitted = await request('POST', '/api/sprint-waves/sync', {}, { ...operatorHeaders(server), 'X-TC-Open-Token': openInstallToken.mint() });
    assert.equal(admitted.status, 503);
    assert.equal(admitted.data.code, 'NOT_CONFIGURED');
  });

  it('POST /api/sprint-waves/validate-disjointness computes over the posted cars', async () => {
    const r = await request('POST', '/api/sprint-waves/validate-disjointness',
      { cars: [{ id: 'a', files: ['x.js'] }, { id: 'b', files: ['x.js'] }] }, { ...operatorHeaders(server), 'X-TC-Open-Token': openInstallToken.mint() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ok, true);
    assert.equal(r.data.result.ok, false, 'two cars sharing x.js are not disjoint');
  });
});

describe('#3093 verifySprintSetupAndRoadmapSync (Ruling A766-1, A786)', () => {
  const HUB = '<!-- LIVE_SPRINT_CARD_START --><a href="./v6.4.0/">live</a><!-- LIVE_SPRINT_CARD_END --><a href="./v6.3.0/">x</a>';

  /**
   * A setup that passes every check; each test breaks one piece.
   * @param {object} [over] - Fields replacing the clean input's.
   * @returns {object}
   */
  function clean(over = {}) {
    return {
      milestones: [
        { title: 'v6.4.0: v6 Autonomous Overnight Train', state: 'OPEN' },
        { title: 'v6.3.0: shipped', state: 'CLOSED' },
        { title: 'Someday', state: 'open' }
      ],
      roadmapData: {
        releases: [
          { version: '6.3.0', trains: [{ cars: [3086, 3087] }] },
          { version: '6.4.0', trains: [{ cars: [3088, 3089] }, { cars: [3093] }] },
          { version: '6.5.0', trains: [{ cars: [3200] }] }
        ],
        unversioned_trains: [{ id: 35, cars: [2642] }],
        backlog: [{ name: 'V6 research', cars: [1886], issues: [{ number: 1900 }] }]
      },
      syncStatus: { state: 'ok', component: 'all' },
      reportDirs: ['v6.3.0', 'v6.4.0', 'assets'],
      hubHtml: HUB,
      ...over
    };
  }

  it('passes a clean setup, reporting as its own runtime guardrail, never as a P-row', () => {
    const r = tracker.verifySprintSetupAndRoadmapSync(clean());
    assert.deepEqual(r.violations, []);
    assert.equal(r.ok, true);
    assert.equal(r.guardrail, 'setup_and_roadmap_sync');
    assert.equal(tracker.SETUP_GUARDRAIL_ID, r.guardrail);
    assert.deepEqual(tracker.RUNTIME_GUARDRAIL_IDS, ['setup_and_roadmap_sync']);
    assert.ok(!tracker.GUARDRAIL_IDS.includes(r.guardrail), 'the post-mortem ledger stays P0..P11');
    assert.deepEqual(r.checked, { milestones: 1, placedIssues: 9, reportDirs: 2 }, 'only the open versioned milestone, and only report directories');
  });

  it('flags an open milestone with no roadmap release, but not a forecast release with no milestone', () => {
    const r = tracker.verifySprintSetupAndRoadmapSync(clean({
      milestones: [{ title: 'v6.4.1 follow-ups', state: 'open' }, { title: 'v6.4.0: train', state: 'open' }]
    }));
    assert.deepEqual(r.violations.map((v) => [v.code, v.version]), [['MISSING_MILESTONE_RELEASE', 'v6.4.1']]);
    assert.equal(r.ok, false);
  });

  it('matches a roadmap release written with a leading v', () => {
    const roadmapData = clean().roadmapData;
    roadmapData.releases[1].version = 'v6.4.0';
    assert.deepEqual(tracker.verifySprintSetupAndRoadmapSync(clean({ roadmapData })).violations, []);
  });

  it('flags an issue placed twice, across buckets and within one, naming every placement', () => {
    const roadmapData = clean().roadmapData;
    roadmapData.backlog[0].cars.push(3089);
    roadmapData.releases[0].trains[0].cars.push(3086);
    const r = tracker.verifySprintSetupAndRoadmapSync(clean({ roadmapData }));
    const dupes = r.violations.filter((v) => v.code === 'DUPLICATE_ROADMAP_PLACEMENT');
    assert.deepEqual(dupes.map((v) => [v.issue, v.placements]), [
      [3086, ['releases[6.3.0]', 'releases[6.3.0]']],
      [3089, ['releases[6.4.0]', 'backlog[V6 research]']]
    ]);
  });

  it('counts a backlog issue given as an object, and an unversioned train', () => {
    const roadmapData = clean().roadmapData;
    roadmapData.unversioned_trains[0].cars.push(1900);
    const r = tracker.verifySprintSetupAndRoadmapSync(clean({ roadmapData }));
    assert.deepEqual(r.violations.map((v) => [v.code, v.issue]), [['DUPLICATE_ROADMAP_PLACEMENT', 1900]]);
  });

  for (const [label, syncStatus, reason] of [
    ['missing', null, 'missing'],
    ['not an object', 'ok', 'missing'],
    ['an array', [], 'missing'],
    ['state error', { state: 'error' }, 'state is "error"'],
    ['state failed', { state: 'failed' }, 'state is "failed"'],
    ['status error', { status: 'error' }, 'status is "error"'],
    ['ok false', { state: 'ok', ok: false }, 'ok is false'],
    ['an unknown state', { state: 'stale' }, 'state is "stale"'],
    ['status not ok beside an ok state', { state: 'ok', status: 'degraded' }, 'status is "degraded"']
  ]) {
    it(`fails closed on a sync status that is ${label}`, () => {
      const r = tracker.verifySprintSetupAndRoadmapSync(clean({ syncStatus }));
      assert.deepEqual(r.violations.map((v) => [v.code, v.reason]), [['ROADMAP_SYNC_ERROR', reason]]);
      assert.equal(r.ok, false);
    });
  }

  it('accepts a status that says ok in either field', () => {
    assert.equal(tracker.verifySprintSetupAndRoadmapSync(clean({ syncStatus: { status: 'ok' } })).ok, true);
    assert.equal(tracker.verifySprintSetupAndRoadmapSync(clean({ syncStatus: { state: 'ok', status: 'ok', ok: true } })).ok, true);
  });

  it('flags a report directory the hub does not link', () => {
    const r = tracker.verifySprintSetupAndRoadmapSync(clean({ reportDirs: ['v6.2.10', 'v6.3.0', 'v6.4.0'] }));
    assert.deepEqual(r.violations.map((v) => [v.code, v.dir]), [['UNLINKED_REPORT_DIR', 'v6.2.10']]);
  });

  it('every code it emits is one it declares', () => {
    const roadmapData = clean().roadmapData;
    roadmapData.backlog[0].cars.push(3089);
    const r = tracker.verifySprintSetupAndRoadmapSync(clean({
      roadmapData, syncStatus: null, reportDirs: ['v6.2.10', 'v6.4.0'],
      milestones: [{ title: 'v9.9.9', state: 'open' }],
      // #3138: a single-train bucket with >= 4 issues and no declared
      // maxParallelLanes trips both MISSING_PARALLEL_LANE_CAPACITY (checked
      // against the 4-lane default) and UNPARALLELIZED_VERSION_PLAN in one
      // plan; a second plan's two same-wave trains sharing a file trips
      // WAVE_FILE_COLLISION.
      versionPlans: [
        { trains: [{ cars: [101, 102, 103, 104] }] },
        { maxParallelLanes: 4, trains: [
          { id: 'train-x', wave: 1, cars: [201], files: ['shared.js'] },
          { id: 'train-y', wave: 1, cars: [202], files: ['shared.js'] }
        ] }
      ]
    }));
    assert.deepEqual([...new Set(r.violations.map((v) => v.code))].sort(), [...tracker.SETUP_VIOLATION_CODES].sort());
  });

  it('refuses inputs it cannot check rather than passing them', () => {
    assert.throws(() => tracker.verifySprintSetupAndRoadmapSync(clean({ milestones: null })), TypeError);
    assert.throws(() => tracker.verifySprintSetupAndRoadmapSync(clean({ roadmapData: null })), TypeError);
    assert.throws(() => tracker.verifySprintSetupAndRoadmapSync(clean({ hubHtml: undefined })), TypeError);
    assert.throws(() => tracker.verifySprintSetupAndRoadmapSync(clean({ reportDirs: undefined })), TypeError);
  });
});

describe('#3089 buildConsolidatedTrainReportSummary', () => {
  const econ = (m, e, s, a) => ({ measured_tokens: m, estimated_tokens: e, subscription_allocated_cost_usd: s, api_shadow_cost_usd: a });
  const closed = (n) => Array.from({ length: n }, (_, i) => ({ id: i, state: 'closed' }));

  /**
   * A three-version train's sprint data, each with PRs, closed issues, economics and fast-follow entries.
   * @returns {Object<string, object>}
   */
  function train() {
    return {
      'v6.2.10': {
        cars: [{ id: 'c1', issues: closed(2) }], pullRequests: [{ number: 1 }, { number: 2 }],
        economics: econ(100, 10, 0.1, 1.25),
        fastFollowSubversions: [{ version: 'v6.2.10', summary_remark: 'ten' }]
      },
      'v6.2.9': {
        cars: [{ id: 'c2', issues: [...closed(1), { id: 9, state: 'open' }] }], pullRequests: [{ number: 3 }],
        economics: econ(200, 20, 0.2, 2.5),
        fastFollowSubversions: [{ version: 'v6.2.9', summary_remark: 'nine' }]
      },
      'v6.3.0': {
        cars: [{ id: 'c3', issues: closed(3) }], pullRequests: [{ number: 4 }, { number: 5 }, { number: 6 }],
        economics: econ(300, 30, 0.3, 3)
      }
    };
  }

  it('orders versions numerically and makes every total the sum of the rows it shows', () => {
    const s = tracker.buildConsolidatedTrainReportSummary(['v6.3.0', 'v6.2.10', 'v6.2.9'], train());
    assert.deepEqual(s.versions, ['v6.2.9', 'v6.2.10', 'v6.3.0']);
    assert.deepEqual(s.perVersion.map((r) => [r.version, r.prCount, r.issuesClosed]), [
      ['v6.2.9', 1, 1], ['v6.2.10', 2, 2], ['v6.3.0', 3, 3]
    ]);
    assert.equal(s.totals.prCount, s.perVersion.reduce((a, r) => a + r.prCount, 0));
    assert.equal(s.totals.prCount, 6);
    assert.equal(s.totals.issuesClosed, 6);
    assert.deepEqual(s.totals.economics, econ(600, 60, 0.6, 6.75), 'cents, not 0.6000000000000001');
    assert.deepEqual(s.missingVersions, []);
    assert.deepEqual(s.economicsIncomplete, []);
  });

  it('collects every version\'s fast-follow remarks into one table, oldest first, tagged with its train version', () => {
    const s = tracker.buildConsolidatedTrainReportSummary(['v6.2.10', 'v6.2.9', 'v6.3.0'], train());
    assert.deepEqual(s.fastFollowSubversions.map((e) => [e.version, e.train_version]), [['v6.2.9', 'v6.2.9'], ['v6.2.10', 'v6.2.10']]);
  });

  it('sorts remarks by their own version even when one train version lists them out of order', () => {
    const data = train();
    data['v6.3.0'].fastFollowSubversions = [{ version: 'v6.3.2' }, { version: 'v6.3.1' }];
    const s = tracker.buildConsolidatedTrainReportSummary(['v6.3.0'], data);
    assert.deepEqual(s.fastFollowSubversions.map((e) => e.version), ['v6.3.1', 'v6.3.2']);
  });

  it('lists a version with no data instead of counting it as zero', () => {
    const s = tracker.buildConsolidatedTrainReportSummary(['v6.2.9', 'v6.2.8'], train());
    assert.deepEqual(s.missingVersions, ['v6.2.8']);
    assert.deepEqual(s.perVersion.map((r) => r.version), ['v6.2.9']);
  });

  it('states no total for an economics field some version lacks, and names that version', () => {
    const data = train();
    delete data['v6.2.9'].economics.api_shadow_cost_usd;
    data['v6.3.0'].economics.measured_tokens = -1;
    const s = tracker.buildConsolidatedTrainReportSummary(['v6.2.9', 'v6.2.10', 'v6.3.0'], data);
    assert.equal(s.totals.economics.api_shadow_cost_usd, null);
    assert.equal(s.totals.economics.measured_tokens, null, 'a negative figure is not a figure');
    assert.equal(s.totals.economics.estimated_tokens, 60);
    assert.deepEqual(s.economicsIncomplete, ['v6.2.9', 'v6.3.0']);
  });

  it('a train with no data at all totals nothing rather than zero economics', () => {
    const s = tracker.buildConsolidatedTrainReportSummary(['v6.4.0'], {});
    assert.equal(s.totals.prCount, 0);
    assert.equal(s.totals.economics.measured_tokens, null);
  });

  it('refuses a version list it cannot read', () => {
    assert.throws(() => tracker.buildConsolidatedTrainReportSummary('v6.3.0', {}), TypeError);
    assert.throws(() => tracker.buildConsolidatedTrainReportSummary(['v6.3.0', ''], {}), TypeError);
  });
});

// ── #3089: the consolidated train report's render helpers (lib/v6/e4) and the
// Kaizen link check for fast-follow major learnings (lib/v6/e5), including that
// a rendered remark table satisfies the validator's Rule 11. ──

const e4Presentation = require('../lib/v6/e4-rich-report-presentation');
const e5Kaizen = require('../lib/v6/e5-kaizen-ledger');
const reportValidator = require('../lib/v6/sprint-report-validator-v3');
const kaizenStore = require('../lib/store');

const ROUTINE = { version: 'v6.2.2', milestone: 69, prs: [3047], issues: [3046], release_tag: 'v6.2.2', summary_remark: 'Chat polish.', major_learning: false };
const MAJOR = {
  version: 'v6.2.9', milestone: 76, prs: [3080], issues: [3077], release_tag: 'v6.2.9',
  summary_remark: 'Fleet isolation.', major_learning: true, kaizen_id: 'kz', postmortem_ref: 'pm-fleet'
};

describe('#3089 renderFastFollowRemarkTable', () => {
  it('renders one row per entry that Rule 11 accepts when placed in #overview', () => {
    const table = e4Presentation.renderFastFollowRemarkTable([ROUTINE, MAJOR]);
    const metrics = {
      schema_version: '3.1.0', version: 'v6.3.0',
      diff: { feature_prs_merged: 1, release_prs_merged: 1, total_repo_prs_merged: 2 },
      durations: { total_run_time_display: '1h 00m 00s' },
      scope_taxonomy: { github_feature_issues_closed: 1, chartered_execution_cars_completed: 1, milestone_issues_deferred_external_gated: 0 },
      release_state: ['code_merged_on_main'],
      economics: { measured_tokens: 1, estimated_tokens: 1, subscription_allocated_cost_usd: 1, api_shadow_cost_usd: 1 },
      provenance: { generated_at: 'x', verified_at: 'x', canonical_source_sha256: 'x', git_main_head_sha: 'x', validator_version: '3.1.0' },
      fast_follow_subversions: [ROUTINE, MAJOR]
    };
    const sections = reportValidator.CANONICAL_SECTIONS.map((id) => {
      if (id === 'overview') return `<section id="overview">${table}</section>`;
      if (id === 'postmortem') return '<section id="postmortem"><h3 id="pm-fleet">Fleet isolation</h3></section>';
      return `<section id="${id}"><p>x</p></section>`;
    }).join('');
    const html = `<html><body><script type="application/json" id="tc-canonical-metrics">${JSON.stringify(metrics)}</script>${sections}</body></html>`;
    assert.deepEqual(reportValidator.validateReport(html).findings.filter((f) => f.rule === 11), []);
    assert.match(table, /<a href="#pm-fleet">Major learning<\/a>/);
    assert.match(table, /<td>#3047<\/td>/);
  });

  it('escapes every value, and never links an unsafe postmortem_ref', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const table = e4Presentation.renderFastFollowRemarkTable([{
      version: hostile, release_tag: hostile, prs: [hostile], issues: [], summary_remark: `"${hostile}"`,
      major_learning: true, postmortem_ref: '" onmouseover="x'
    }]);
    assert.ok(!table.includes('<img'), 'no markup from data');
    assert.ok(!table.includes('onmouseover="'), 'no attribute breakout');
    assert.match(table, /<td>Major learning<\/td>/, 'an unsafe ref is shown unlinked');
    assert.match(table, /&quot;&lt;img/, 'quotes are escaped too');
  });

  it('refuses a non-array', () => {
    assert.throws(() => e4Presentation.renderFastFollowRemarkTable(null), TypeError);
  });
});

describe('#3089 renderConsolidatedTrainSummary', () => {
  const econ = (m) => ({ measured_tokens: m, estimated_tokens: 1, subscription_allocated_cost_usd: 0.5, api_shadow_cost_usd: 2 });

  it('renders the rows and the totals the summary computed, plus the fast-follow table', () => {
    const summary = tracker.buildConsolidatedTrainReportSummary(['v6.2.9', 'v6.3.0'], {
      'v6.2.9': { pullRequests: [{}], economics: econ(10), fastFollowSubversions: [ROUTINE] },
      'v6.3.0': { pullRequests: [{}, {}], economics: econ(20) }
    });
    const html = e4Presentation.renderConsolidatedTrainSummary(summary);
    assert.match(html, /<tr><td><code>v6\.2\.9<\/code><\/td><td>1<\/td><td>0<\/td><td>10<\/td>/);
    assert.match(html, /<tr class="train-total"><th>Total<\/th><td>3<\/td><td>0<\/td><td>30<\/td><td>2<\/td><td>1<\/td><td>4<\/td><\/tr>/);
    assert.match(html, /class="fast-follow-subversions"/);
  });

  it('says what it could not count, and shows an unknown total as a dash, never 0', () => {
    const summary = tracker.buildConsolidatedTrainReportSummary(['v6.2.8', 'v6.2.9'], { 'v6.2.9': { pullRequests: [] } });
    const html = e4Presentation.renderConsolidatedTrainSummary(summary);
    assert.match(html, /No sprint data for <code>v6\.2\.8<\/code>; not counted\./);
    assert.match(html, /Token economics incomplete for <code>v6\.2\.9<\/code>/);
    assert.match(html, /<th>Total<\/th><td>0<\/td><td>0<\/td><td>—<\/td><td>—<\/td><td>—<\/td><td>—<\/td>/);
    assert.ok(!html.includes('fast-follow-subversions'), 'no empty remark table');
  });

  it('refuses something that is not a consolidated summary', () => {
    assert.throws(() => e4Presentation.renderConsolidatedTrainSummary({}), TypeError);
  });
});

describe('#3089 verifyFastFollowKaizenLinks', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-3089-kaizen-'));
    kaizenStore._setBasePath(tmpDir);
    kaizenStore.init();
    db = kaizenStore.getDb();
  });

  afterEach(() => {
    kaizenStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** @returns {string} A real ledger item's id. */
  function seed() {
    const r = e5Kaizen.detectItem(db, {
      originSprint: 'v6.2.9', findingId: 'f-1', defectCategory: 'fleet-isolation', rootCause: 'unread registry read as empty',
      correctiveActionSpec: 'fail closed', ownerRole: 'builder', verificationClass: 'A_DETERMINISTIC', targetMetric: 'cross-fleet sends'
    });
    assert.equal(r.ok, true);
    return r.id;
  }

  it('passes a major learning linked to a real ledger item, and skips routine entries', () => {
    const id = seed();
    assert.deepEqual(e5Kaizen.verifyFastFollowKaizenLinks(db, [ROUTINE, { ...MAJOR, kaizen_id: id }]), { ok: true, checked: 1, missing: [] });
  });

  it('names a major learning whose Kaizen item does not exist, or that names none', () => {
    seed();
    const r = e5Kaizen.verifyFastFollowKaizenLinks(db, [{ ...MAJOR, kaizen_id: 'no-such-item' }, { ...MAJOR, version: 'v6.2.10', kaizen_id: ' ' }]);
    assert.equal(r.ok, false);
    assert.equal(r.checked, 2);
    assert.deepEqual(r.missing, [{ version: 'v6.2.9', kaizen_id: 'no-such-item' }, { version: 'v6.2.10', kaizen_id: null }]);
  });

  it('refuses a non-array', () => {
    assert.throws(() => e5Kaizen.verifyFastFollowKaizenLinks(db, null), TypeError);
  });
});

describe('native-sprint-tracker: sprintDataFromWaveRuns scope filtering (#3325 Fleet/Workspace Document & Wave Isolation)', () => {
  const run = (id, createdAt, status, cars, metadata = {}, fleetId = 'f') => ({
    id, fleetId, status, createdAt, metadata, waves: [Object.keys(cars)],
    cars: Object.fromEntries(Object.entries(cars).map(([cid, c]) => [cid, { id: cid, status: 'pending', payload: {}, startedAt: null, completedAt: null, ...c }]))
  });

  it('with no scope given, behaves exactly as before #3325 (every run eligible)', () => {
    const runs = {
      a: run('a', 1, 'active', { carA: {} }, { projectId: 1 }),
      b: run('b', 2, 'complete', { carB: {} }, { projectId: 2 })
    };
    assert.deepEqual(tracker.sprintDataFromWaveRuns(runs, 'current').cars.map((c) => c.id), ['carA']);
    assert.deepEqual(tracker.sprintDataFromWaveRuns(runs, 'current', {}).cars.map((c) => c.id), ['carA']);
  });

  it('a scoped projectId excludes a same-version run belonging to a different project -- the #3325 cross-fleet leak', () => {
    // Both runs resolve 'current' to their own newest active run, and both
    // happen to tag the same metadata.version -- exactly the collision a
    // request scoped by projectId must not let the OTHER project answer.
    const runs = {
      mine: run('mine', 1, 'active', { carMine: {} }, { projectId: 1, version: '1.0.0' }),
      theirs: run('theirs', 2, 'active', { carTheirs: {} }, { projectId: 2, version: '1.0.0' })
    };
    assert.deepEqual(
      tracker.sprintDataFromWaveRuns(runs, 'current', { projectId: 1 }).cars.map((c) => c.id), ['carMine']
    );
    assert.deepEqual(
      tracker.sprintDataFromWaveRuns(runs, 'current', { projectId: 2 }).cars.map((c) => c.id), ['carTheirs']
    );
    assert.deepEqual(
      tracker.sprintDataFromWaveRuns(runs, '1.0.0', { projectId: 1 }).cars.map((c) => c.id), ['carMine']
    );
  });

  it('a run with no metadata.projectId at all is excluded once a projectId scope is given', () => {
    const runs = { untagged: run('untagged', 1, 'active', { carA: {} }) };
    // 'current' with nothing eligible answers the empty sprint (never a
    // thrown error or the untagged run); a NAMED version with nothing
    // eligible answers null, same as an unknown version always has.
    assert.deepEqual(tracker.sprintDataFromWaveRuns(runs, 'current', { projectId: 1 }),
      tracker.sprintDataFromWaveRuns({}, 'current', { projectId: 1 }));
    assert.equal(tracker.sprintDataFromWaveRuns(
      { untagged: run('untagged', 1, 'active', { carA: {} }, { version: '1.0.0' }) }, '1.0.0', { projectId: 1 }
    ), null);
  });

  it('a scoped fleetId excludes a run tagged for a different fleet, independent of projectId', () => {
    const runs = {
      tiltA: run('tiltA', 1, 'active', { carA: {} }, {}, 'TiLT-Fleet'),
      tiltB: run('tiltB', 2, 'active', { carB: {} }, {}, 'TangleClaw-Shared')
    };
    assert.deepEqual(
      tracker.sprintDataFromWaveRuns(runs, 'current', { fleetId: 'TiLT-Fleet' }).cars.map((c) => c.id), ['carA']
    );
    assert.deepEqual(
      tracker.sprintDataFromWaveRuns(runs, 'current', { fleetId: 'TangleClaw-Shared' }).cars.map((c) => c.id), ['carB']
    );
  });

  it('projectId and fleetId both narrow together -- a run must match both when both are given', () => {
    const runs = {
      match: run('match', 1, 'active', { carA: {} }, { projectId: 1 }, 'TiLT-Fleet'),
      wrongFleet: run('wrongFleet', 2, 'active', { carB: {} }, { projectId: 1 }, 'TangleClaw-Shared'),
      wrongProject: run('wrongProject', 3, 'active', { carC: {} }, { projectId: 2 }, 'TiLT-Fleet')
    };
    assert.deepEqual(
      tracker.sprintDataFromWaveRuns(runs, 'current', { projectId: 1, fleetId: 'TiLT-Fleet' }).cars.map((c) => c.id),
      ['carA']
    );
  });

  it('an empty runs map scoped to a projectId answers the empty "current" sprint, not an unscoped run', () => {
    assert.deepEqual(tracker.sprintDataFromWaveRuns({}, 'current', { projectId: 1 }),
      { version: null, cars: [], lanes: [], pullRequests: [], waves: [], learnings: [], releaseCommit: null });
  });

  describe('memberProjectIds (#3345, #3325 fast-follow: fleet-wide member-seat resolution)', () => {
    it('finds a run recorded under a DIFFERENT fleet seat than the one clicked', () => {
      // The operator launched the train from seat 1 (e.g. TiLT-PM); clicking
      // into sibling seat 2 (TiLT-Builder) must still see it, not an empty sprint.
      const runs = { launchedBySeat1: run('launchedBySeat1', 1, 'active', { carA: {} }, { projectId: 1 }) };
      assert.deepEqual(
        tracker.sprintDataFromWaveRuns(runs, 'current', { projectId: 2, memberProjectIds: [1, 2, 3] }).cars.map((c) => c.id),
        ['carA']
      );
    });

    it('still excludes a run belonging to a project outside the fleet group entirely', () => {
      const runs = {
        inFleet: run('inFleet', 1, 'active', { carA: {} }, { projectId: 1 }),
        outsideFleet: run('outsideFleet', 2, 'active', { carB: {} }, { projectId: 99 })
      };
      assert.deepEqual(
        tracker.sprintDataFromWaveRuns(runs, 'current', { projectId: 2, memberProjectIds: [1, 2, 3] }).cars.map((c) => c.id),
        ['carA']
      );
    });

    it('a lone project (no fleet group) passes memberProjectIds as its own single id, same as the old exact match', () => {
      const runs = {
        mine: run('mine', 1, 'active', { carMine: {} }, { projectId: 1 }),
        theirs: run('theirs', 2, 'active', { carTheirs: {} }, { projectId: 2 })
      };
      assert.deepEqual(
        tracker.sprintDataFromWaveRuns(runs, 'current', { projectId: 1, memberProjectIds: [1] }).cars.map((c) => c.id),
        ['carMine']
      );
    });

    it('memberProjectIds still combines with fleetId — both must match when both are given', () => {
      const runs = {
        match: run('match', 1, 'active', { carA: {} }, { projectId: 1 }, 'TiLT-Fleet'),
        wrongFleet: run('wrongFleet', 2, 'active', { carB: {} }, { projectId: 1 }, 'TangleClaw-Shared')
      };
      assert.deepEqual(
        tracker.sprintDataFromWaveRuns(
          runs, 'current', { projectId: 2, memberProjectIds: [1, 2], fleetId: 'TiLT-Fleet' }
        ).cars.map((c) => c.id),
        ['carA']
      );
    });

    it('a null/omitted memberProjectIds falls back to the pre-#3345 exact scope.projectId match, unchanged', () => {
      const runs = {
        mine: run('mine', 1, 'active', { carMine: {} }, { projectId: 1 }),
        theirs: run('theirs', 2, 'active', { carTheirs: {} }, { projectId: 2 })
      };
      assert.deepEqual(
        tracker.sprintDataFromWaveRuns(runs, 'current', { projectId: 1 }).cars.map((c) => c.id), ['carMine']
      );
      assert.deepEqual(
        tracker.sprintDataFromWaveRuns(runs, 'current', { projectId: 1, memberProjectIds: null }).cars.map((c) => c.id),
        ['carMine']
      );
    });

    it('an empty memberProjectIds array excludes every run, even the clicked seat\'s own', () => {
      const runs = { mine: run('mine', 1, 'active', { carMine: {} }, { projectId: 1 }) };
      assert.deepEqual(
        tracker.sprintDataFromWaveRuns(runs, 'current', { projectId: 1, memberProjectIds: [] }),
        tracker.sprintDataFromWaveRuns({}, 'current', { projectId: 1 })
      );
    });
  });
});

describe('native-sprint-tracker: parseSprintDataFromLaneQueue (#3356)', () => {
  const EMPTY = { version: null, cars: [], lanes: [], pullRequests: [], waves: [], learnings: [], releaseCommit: null };

  // The real TangleClaw-style layout: Version + PRR columns present, two
  // tables (Wave 1 + Wave 2) both tagged `v6.6.9` via their own Version
  // column — mirrors /Users/jasonvaughan/Documents/Projects/Shared/TangleClaw-Shared/LANE_QUEUE.md as read on 2026-11-28.
  const TC_STYLE = [
    '# TangleClaw Fleet: Live Lane Queue (`Sprint v6.6.9`)',
    '',
    '**Owner:** `TC-Lane-PM` (#74).',
    '**Target Version:** `v6.6.9` · **Milestone:** [`#119`](https://x/milestone/119)',
    '',
    '## Wave 1: Parallel Feature Cars (`0` Shared Files)',
    '',
    '| Version | Car ID | Lane | PRR | Issues | Branch | Exclusive File Envelope (`0` Overlap) | Status |',
    '|---|---|---|---|---|---|---|---|',
    '| `v6.6.9` | `Car V669-W1-A` | `TC-Lane-A` (#111) | `TC-Lane-PRR-A` (#83) | [`#3355`](https://x/3355), [`#3352`](https://x/3352) | `fix/v669-w1-a` | `public/v6-shell.js`, `test/v6-b1-ui-shell.test.js` | **DISPATCHED (Gate 0 Ruling A1297)** |',
    '| `v6.6.9` | `Car V669-W1-B` | `TC-Lane-B` (#112) | `TC-Lane-PRR-B` (#143) | [`#3356`](https://x/3356) | `feat/v669-w1-b` | `lib/native-sprint-tracker.js`, `server.js` | **DISPATCHED (Gate 0 Ruling A1297)** |',
    '',
    '## Wave 2: Release Cut (`v6.6.9`)',
    '',
    '| Version | Car ID | Lane | PRR | Issues | Branch | Exclusive File Envelope | Status |',
    '|---|---|---|---|---|---|---|---|',
    '| `v6.6.9` | `Car V669-W2-REL` | `TC-Lane-INT` (#113) | `TC-Lane-PRR-A` (#83) | Milestone `#119` (`#3352`, `#3355`, `#3356`) | `chore/release-v6.6.9` | `version.json`, `CHANGELOG.md` | **WAITS FOR WAVE 1** |'
  ].join('\n');

  // The TiLT-Fleet-style layout the dispatch names but no real example of
  // this repo carries: no Version/PRR columns, version read from the
  // section heading's own inline tag.
  const TILT_STYLE = [
    '# TiLT Fleet: Live Lane Queue',
    '',
    '**Fleet state:** **ACTIVE — Sprint `v0.2.0`**',
    '',
    '## Track B (`v0.2.0` · Fast Follow)',
    '',
    '| Car | Lane | Branch | Issue | Exclusive File Envelope | Status |',
    '|---|---|---|---|---|---|',
    '| `B1` | `TiLT-B1` (#191) | `feat/b1` | [`#42`](http://x) | `a.js`, `b.js` | **MERGED (PR #55)** |',
    '| `B2` | `TiLT-B2` (#192) | `feat/b2` | `#43` | `c.js` | **BLOCKED** |'
  ].join('\n');

  it('returns the empty sprint for non-string/empty input', () => {
    assert.deepEqual(tracker.parseSprintDataFromLaneQueue(''), EMPTY);
    assert.deepEqual(tracker.parseSprintDataFromLaneQueue(null), EMPTY);
    assert.deepEqual(tracker.parseSprintDataFromLaneQueue(undefined), EMPTY);
  });

  describe('TangleClaw-style layout (Version + PRR columns, two tables)', () => {
    it('merges both tables\' cars for the resolved version, in table order', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current');
      assert.equal(data.version, 'v6.6.9');
      assert.deepEqual(data.cars.map((c) => c.id), ['V669-W1-A', 'V669-W1-B', 'V669-W2-REL']);
    });

    it('resolves "current" from **Target Version:** when no **Fleet state:** declaration exists', () => {
      assert.equal(tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current').version, 'v6.6.9');
    });

    it('strips the "Car " prefix and backticks from the car id', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current');
      assert.ok(data.cars.every((c) => !c.id.includes('`') && !c.id.startsWith('Car ')));
    });

    it('strips the trailing seat id from lane and PRR, keeping only the canonical name', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current');
      const carA = data.cars.find((c) => c.id === 'V669-W1-A');
      assert.equal(carA.lane, 'TC-Lane-A');
      assert.deepEqual(carA.reviewers, { prr: 'TC-Lane-PRR-A' });
    });

    it('extracts every #NNNN issue number from a markdown-linked Issues cell, open by default', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current');
      const carA = data.cars.find((c) => c.id === 'V669-W1-A');
      assert.deepEqual(carA.issues, [{ id: 3355, state: 'open' }, { id: 3352, state: 'open' }]);
    });

    it('never reads a "Milestone `#NNN`" reference as an issue number', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current');
      const rel = data.cars.find((c) => c.id === 'V669-W2-REL');
      assert.deepEqual(rel.issues.map((i) => i.id), [3352, 3355, 3356]);
      assert.ok(!rel.issues.some((i) => i.id === 119), 'the Milestone number must never appear as an issue');
    });

    it('splits a comma-separated, backticked Exclusive File Envelope cell into a files array', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current');
      const carB = data.cars.find((c) => c.id === 'V669-W1-B');
      assert.deepEqual(carB.files, ['lib/native-sprint-tracker.js', 'server.js']);
    });

    it('strips backticks from the branch cell', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current');
      assert.equal(data.cars.find((c) => c.id === 'V669-W1-B').branch, 'feat/v669-w1-b');
    });

    it('maps every DISPATCHED car to a committed lane entry, not complete or assigned', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current');
      for (const carId of ['V669-W1-A', 'V669-W1-B']) {
        const lane = data.lanes.find((l) => l.carId === carId);
        assert.equal(lane.status, 'committed');
        assert.equal(lane.hold, false);
      }
    });

    it('WAITS FOR WAVE 1 (no DISPATCH/ACTIVE/etc. keyword) reads assigned, not committed', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current');
      const rel = data.lanes.find((l) => l.carId === 'V669-W2-REL');
      assert.equal(rel.status, 'assigned');
    });

    it('no car in this fixture is confirmed complete and no PR is open, so pullRequests is empty', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current');
      assert.deepEqual(data.pullRequests, []);
      assert.ok(data.cars.every((c) => !c.confirmedComplete));
    });

    it('waves is a single array of every matched car id, in order', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current');
      assert.deepEqual(data.waves, [['V669-W1-A', 'V669-W1-B', 'V669-W2-REL']]);
    });

    it('learnings is always empty and releaseCommit is always null, as documented', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'current');
      assert.deepEqual(data.learnings, []);
      assert.equal(data.releaseCommit, null);
    });

    it('an explicit targetVersion filters to just that version, v-prefixed or bare', () => {
      assert.equal(tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'v6.6.9').cars.length, 3);
      assert.equal(tracker.parseSprintDataFromLaneQueue(TC_STYLE, '6.6.9').cars.length, 3);
    });

    it('an explicit targetVersion with no matching car returns the empty sprint', () => {
      assert.deepEqual(tracker.parseSprintDataFromLaneQueue(TC_STYLE, 'v9.9.9'), EMPTY);
    });
  });

  describe('TiLT-Fleet-style layout (no Version/PRR columns, heading-tagged version)', () => {
    it('resolves "current" from **Fleet state:** **ACTIVE — Sprint `vX.Y.Z`**', () => {
      assert.equal(tracker.parseSprintDataFromLaneQueue(TILT_STYLE, 'current').version, 'v0.2.0');
    });

    it('reads every row\'s version from the nearest preceding heading\'s own tag', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TILT_STYLE, 'current');
      assert.ok(data.cars.every((c) => c.version === 'v0.2.0'));
    });

    it('a bare (non-linked, non-backticked) Issue cell still yields its issue number', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TILT_STYLE, 'current');
      assert.deepEqual(data.cars.find((c) => c.id === 'B2').issues, [{ id: 43, state: 'open' }]);
    });

    it('MERGED marks the car confirmedComplete and every one of its issues closed', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TILT_STYLE, 'current');
      const b1 = data.cars.find((c) => c.id === 'B1');
      assert.equal(b1.confirmedComplete, true);
      assert.deepEqual(b1.issues, [{ id: 42, state: 'closed' }]);
    });

    it('extracts "PR #NNN" from Status text into a pullRequests entry, merged once confirmedComplete', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TILT_STYLE, 'current');
      assert.deepEqual(data.pullRequests, [
        { carId: 'B1', number: 55, state: 'merged', title: null, lane: 'TiLT-B1', status: '**MERGED (PR #55)**' }
      ]);
    });

    it('BLOCKED marks the lane on hold, and not confirmedComplete', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TILT_STYLE, 'current');
      const b2 = data.lanes.find((l) => l.carId === 'B2');
      assert.equal(b2.hold, true);
      assert.equal(data.cars.find((c) => c.id === 'B2').confirmedComplete, undefined);
    });

    it('a car table with no PRR column at all carries no reviewers field', () => {
      const data = tracker.parseSprintDataFromLaneQueue(TILT_STYLE, 'current');
      assert.ok(data.cars.every((c) => !('reviewers' in c)));
    });

    // PRR-B R-Gate R1 BLOCKING, #3356: a section heading with NO inline
    // version tag of its own (just "## Wave 1: ..."), under a file that
    // only ever declares its version once at the top level, must still
    // resolve its rows to that file-level version -- not null.
    it('a row under a section heading with no inline version tag still resolves via the file-level declaration', () => {
      const text = [
        '**Target Version:** `v6.6.9`',
        '',
        '## Wave 1: Parallel Feature Cars (`0` Shared Files)',
        '',
        '| Car | Lane | Branch | Issue | Exclusive File Envelope | Status |',
        '|---|---|---|---|---|---|',
        '| `X` | `L1` | `b1` | `#1` | `a.js` | **DISPATCHED** |'
      ].join('\n');
      const data = tracker.parseSprintDataFromLaneQueue(text, 'current');
      assert.equal(data.version, 'v6.6.9');
      assert.deepEqual(data.cars.map((c) => c.id), ['X']);
    });

    it('with neither a row/heading version nor a file-level declaration, the row stays unversioned and never matches any target', () => {
      const text = [
        '## Wave 1: Parallel Feature Cars (`0` Shared Files)',
        '',
        '| Car | Lane | Branch | Issue | Exclusive File Envelope | Status |',
        '|---|---|---|---|---|---|',
        '| `X` | `L1` | `b1` | `#1` | `a.js` | **DISPATCHED** |'
      ].join('\n');
      assert.deepEqual(tracker.parseSprintDataFromLaneQueue(text, 'current'), EMPTY);
      assert.deepEqual(tracker.parseSprintDataFromLaneQueue(text, 'v6.6.9'), EMPTY);
    });
  });

  describe('"current" version resolution fallback order', () => {
    it('falls back to the first in-progress/dispatched/active car\'s version when neither file-level declaration exists', () => {
      const text = [
        '## Track A (`v0.1.0`)',
        '| Car | Lane | Branch | Issue | Exclusive File Envelope | Status |',
        '|---|---|---|---|---|---|',
        '| `A1` | `L1` | `b1` | `#1` | `x.js` | **MERGED** |',
        '',
        '## Track B (`v0.2.0`)',
        '| Car | Lane | Branch | Issue | Exclusive File Envelope | Status |',
        '|---|---|---|---|---|---|',
        '| `B1` | `L2` | `b2` | `#2` | `y.js` | **IN PROGRESS** |'
      ].join('\n');
      assert.equal(tracker.parseSprintDataFromLaneQueue(text, 'current').version, 'v0.2.0');
    });

    it('falls back to the highest version with any car at all when nothing is in progress and no declaration exists', () => {
      const text = [
        '## Track A (`v0.1.0`)',
        '| Car | Lane | Branch | Issue | Exclusive File Envelope | Status |',
        '|---|---|---|---|---|---|',
        '| `A1` | `L1` | `b1` | `#1` | `x.js` | **MERGED** |',
        '',
        '## Track B (`v0.3.0`)',
        '| Car | Lane | Branch | Issue | Exclusive File Envelope | Status |',
        '|---|---|---|---|---|---|',
        '| `B1` | `L2` | `b2` | `#2` | `y.js` | **MERGED** |',
        '',
        '## Track C (`v0.2.0`)',
        '| Car | Lane | Branch | Issue | Exclusive File Envelope | Status |',
        '|---|---|---|---|---|---|',
        '| `C1` | `L3` | `b3` | `#3` | `z.js` | **MERGED** |'
      ].join('\n');
      assert.equal(tracker.parseSprintDataFromLaneQueue(text, 'current').version, 'v0.3.0');
    });
  });

  it('ignores a non-car markdown table entirely (no Car/Car ID column)', () => {
    const text = [
      '**Target Version:** `v1.0.0`',
      '| Setting | Value |',
      '|---|---|',
      '| foo | bar |'
    ].join('\n');
    assert.deepEqual(tracker.parseSprintDataFromLaneQueue(text, 'current'), EMPTY);
  });
});

describe('native-sprint-tracker: buildRoadmapDataFromFallbackSources — LANE_QUEUE.md car-table fallback (#3356)', () => {
  it('still uses the ## Train N — `Sprint vX.Y.Z` path unchanged when those headers are present (no regression)', () => {
    const laneQueueText = [
      '## Train 7 — `Sprint v1.2.3`',
      'Car A: Closes #10, Part of #11'
    ].join('\n');
    const result = tracker.buildRoadmapDataFromFallbackSources({ laneQueueText });
    assert.deepEqual(result.releases, [{ version: '1.2.3', trains: [{ cars: [10, 11] }] }]);
  });

  it('falls back to car-table rows, grouped by resolved version, when no ## Train N headers exist at all', () => {
    const laneQueueText = [
      '**Target Version:** `v6.6.9`',
      '',
      '| Version | Car ID | Lane | Issues | Branch | Exclusive File Envelope | Status |',
      '|---|---|---|---|---|---|---|',
      '| `v6.6.9` | `Car X` | `L1` | [`#100`](http://x), [`#101`](http://x) | `b1` | `a.js` | **DISPATCHED** |',
      '| `v6.6.9` | `Car Y` | `L2` | [`#102`](http://x) | `b2` | `b.js` | **DISPATCHED** |'
    ].join('\n');
    const result = tracker.buildRoadmapDataFromFallbackSources({ laneQueueText });
    assert.equal(result.releases.length, 1);
    assert.equal(result.releases[0].version, '6.6.9');
    assert.equal(result.releases[0].trains.length, 1);
    assert.deepEqual([...result.releases[0].trains[0].cars].sort((a, b) => a - b), [100, 101, 102]);
  });

  it('never reads a release car\'s own Milestone reference as one of its issues', () => {
    const laneQueueText = [
      '**Target Version:** `v6.6.9`',
      '| Version | Car ID | Lane | Issues | Branch | Exclusive File Envelope | Status |',
      '|---|---|---|---|---|---|---|',
      '| `v6.6.9` | `Car REL` | `L1` | Milestone `#119` (`#3352`) | `b1` | `a.js` | **WAITS** |'
    ].join('\n');
    const result = tracker.buildRoadmapDataFromFallbackSources({ laneQueueText });
    assert.deepEqual(result.releases[0].trains[0].cars, [3352]);
  });

  it('a row with no issue numbers at all contributes no train', () => {
    const laneQueueText = [
      '**Target Version:** `v6.6.9`',
      '| Version | Car ID | Lane | Issues | Branch | Exclusive File Envelope | Status |',
      '|---|---|---|---|---|---|---|',
      '| `v6.6.9` | `Car X` | `L1` |  | `b1` | `a.js` | **DISPATCHED** |'
    ].join('\n');
    assert.deepEqual(tracker.buildRoadmapDataFromFallbackSources({ laneQueueText }), { releases: [] });
  });

  it('with neither Train headers nor any car table, returns an empty releases array', () => {
    assert.deepEqual(tracker.buildRoadmapDataFromFallbackSources({ laneQueueText: '# Just a heading\n' }), { releases: [] });
  });
});

describe('server.js: LANE_QUEUE.md sprint-data wiring (#3356)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  // Deferred to a `before()` hook, not required at describe-body scope: a
  // bare `require('../server')` here would run the moment this file is
  // LOADED (every describe body executes synchronously during test
  // collection, before any test or hook actually runs) -- including before
  // "the live server mounts the sprint wave routes" describe block's own
  // `beforeEach` ever points server.js's roadmap-sync-status env vars at
  // its throwaway tmpDir. `require()` caches the module, so that
  // describe's own later `require('../server')` would just reuse this
  // already-cached module, whose own module-scope `fs.existsSync(...)`
  // mount-time gate (server.js's `getSyncStatus` dep wiring) would have
  // already run against this operator's REAL roadmap-sync-status.json/
  // sprint-reports/ paths and cached its decision — surfacing a real
  // roadmapSyncStatus where that describe block's fixture expects none at
  // all. A `before()` hook instead runs once test collection is done, in
  // declaration order, after every earlier describe block's own tests have
  // already finished.
  let srv;
  before(() => { srv = require('../server'); });

  describe('_v6IsNewerSemver', () => {
    it('is true only when a is strictly greater than b, across major/minor/patch', () => {
      assert.equal(srv._v6IsNewerSemver('v6.6.9', 'v6.6.8'), true);
      assert.equal(srv._v6IsNewerSemver('v6.7.0', 'v6.6.9'), true);
      assert.equal(srv._v6IsNewerSemver('v7.0.0', 'v6.9.9'), true);
      assert.equal(srv._v6IsNewerSemver('v6.6.8', 'v6.6.9'), false);
      assert.equal(srv._v6IsNewerSemver('v6.6.9', 'v6.6.9'), false);
    });

    it('tolerates a missing v-prefix on either side, and a missing patch segment', () => {
      assert.equal(srv._v6IsNewerSemver('6.6.9', 'v6.6.8'), true);
      assert.equal(srv._v6IsNewerSemver('v1.2', 'v1.1.9'), true);
    });
  });

  describe('_v6ChooseSprintDataSource', () => {
    const waveRunsData = { version: 'v6.6.8', cars: [{ id: 'A' }] };
    const laneQueueDataNewer = { version: 'v6.6.9', cars: [{ id: 'B' }] };
    const laneQueueDataOlder = { version: 'v6.6.7', cars: [{ id: 'C' }] };
    const laneQueueEmpty = { version: null, cars: [] };

    it('falls back to laneQueueData whenever waveRunsData has 0 cars, current or not', () => {
      assert.equal(srv._v6ChooseSprintDataSource({ version: 'v1.0.0', cars: [] }, laneQueueDataNewer, true), laneQueueDataNewer);
      assert.equal(srv._v6ChooseSprintDataSource(null, laneQueueDataNewer, false), laneQueueDataNewer);
    });

    it('for "current", prefers laneQueueData when it has cars AND is strictly newer', () => {
      assert.equal(srv._v6ChooseSprintDataSource(waveRunsData, laneQueueDataNewer, true), laneQueueDataNewer);
    });

    it('for "current", keeps waveRunsData when laneQueueData is not newer, or carries no cars', () => {
      assert.equal(srv._v6ChooseSprintDataSource(waveRunsData, laneQueueDataOlder, true), waveRunsData);
      assert.equal(srv._v6ChooseSprintDataSource(waveRunsData, laneQueueEmpty, true), waveRunsData);
    });

    it('for an explicit (non-"current") version, never prefers laneQueueData just for being newer', () => {
      assert.equal(srv._v6ChooseSprintDataSource(waveRunsData, laneQueueDataNewer, false), waveRunsData);
    });
  });

  describe('_v6LaneQueuePath', () => {
    it('joins scope.sharedDir when given', () => {
      assert.equal(srv._v6LaneQueuePath({ sharedDir: '/fleet/shared' }), path.join('/fleet/shared', 'LANE_QUEUE.md'));
    });

    it('returns null for a project-scoped-but-ungrouped scope (#3345 cross-project guard)', () => {
      assert.equal(srv._v6LaneQueuePath({ projectId: 42 }), null);
    });

    it('falls back to this install\'s own default path for an unscoped/bare request', () => {
      assert.ok(typeof srv._v6LaneQueuePath({}) === 'string' && srv._v6LaneQueuePath({}).endsWith('LANE_QUEUE.md'));
    });
  });

  describe('_v6LoadLaneQueueSprintData', () => {
    let tmpDir;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lane-queue-sprint-'));
      fs.writeFileSync(path.join(tmpDir, 'LANE_QUEUE.md'), [
        '**Target Version:** `v9.0.0`',
        '| Version | Car ID | Lane | Issues | Branch | Exclusive File Envelope | Status |',
        '|---|---|---|---|---|---|---|',
        '| `v9.0.0` | `Car X` | `L1` | `#1` | `b1` | `a.js` | **DISPATCHED** |'
      ].join('\n'));
    });

    after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads a real LANE_QUEUE.md from scope.sharedDir and returns the parsed sprint data', () => {
      const data = srv._v6LoadLaneQueueSprintData('current', { sharedDir: tmpDir });
      assert.equal(data.version, 'v9.0.0');
      assert.deepEqual(data.cars.map((c) => c.id), ['X']);
    });

    it('degrades to the empty sprint shape, never throwing, when the file cannot be read at all', () => {
      const data = srv._v6LoadLaneQueueSprintData('current', { sharedDir: path.join(tmpDir, 'does-not-exist') });
      assert.deepEqual(data, { version: null, cars: [], lanes: [], pullRequests: [], waves: [], learnings: [], releaseCommit: null });
    });

    it('degrades to the empty sprint shape for a project-scoped-but-ungrouped scope (no path resolves at all)', () => {
      const data = srv._v6LoadLaneQueueSprintData('current', { projectId: 42 });
      assert.deepEqual(data, { version: null, cars: [], lanes: [], pullRequests: [], waves: [], learnings: [], releaseCommit: null });
    });
  });
});
