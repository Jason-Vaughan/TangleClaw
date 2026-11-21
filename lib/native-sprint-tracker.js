'use strict';

/**
 * Native sprint wave tracking — the pure model behind #2644 (Train 35): wave
 * matrices and file-disjoint car bundles, a live lane/PR dispatch-state
 * tracker, an interactive sprint report/O-Gate summary builder, and a
 * resilient roadmap sync helper with exponential backoff and an atomic
 * last-good snapshot.
 *
 * Everything here is pure or takes its I/O as an injected function
 * (`lsFiles`, `fetchFn`, `snapshotStore`), so it runs and is tested without a
 * live `server.js` mount or a real git/network call — `lib/routes/sprint-wave-routes.js`
 * is the thin HTTP adapter over it; mounting that adapter behind real routes
 * is separately tracked work.
 *
 * @module lib/native-sprint-tracker
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { writeAtomic } = require('./staged-write');
const {
  validateHubReportLinks, ECONOMICS_FIELDS, extractSection, toPlainText
} = require('./v6/sprint-report-validator-v3');

/** Guardrail ledger ids this sprint's post-mortem tracks (#2644: "P0..P11"). */
const GUARDRAIL_IDS = Array.from({ length: 12 }, (_, i) => `P${i}`);

/**
 * The runtime setup gate {@link verifySprintSetupAndRoadmapSync} reports as
 * (#3093). It is not one of the post-mortem's P0..P11 rows, which the Hero
 * report's ledger renders one per id, so it lives in its own list (Ruling A786 Q1).
 */
const SETUP_GUARDRAIL_ID = 'setup_and_roadmap_sync';

/** Guardrails checked at runtime at Gate 0 and Sprint Exit, as opposed to the post-mortem ledger's. */
const RUNTIME_GUARDRAIL_IDS = Object.freeze([SETUP_GUARDRAIL_ID]);

/** HTTP statuses `syncRoadmapWithBackoff` treats as transient by default. */
const DEFAULT_RETRYABLE_STATUSES = [408, 429, 499, 500, 502, 503, 504];

// ── Wave Matrices & File-Disjoint Car Bundles ──

/**
 * Tracked files for a path, via a real `git ls-files` — the default
 * `lsFiles` a caller gets when it does not inject its own. Returns `null`
 * rather than throwing when the path is not a git worktree (a car's branch
 * may not exist yet), so a caller treats "could not verify" as "nothing to
 * compare," never as a crash.
 * @param {string} cwd - Directory to run `git ls-files` in.
 * @returns {string[]|null} Tracked file paths, or `null` if the check could not run.
 */
function gitLsFilesAt(cwd) {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch (_err) {
    return null;
  }
}

/**
 * Validate a wave's car bundles: each car holds at most `maxIssuesPerCar`
 * issues, and no two cars' exclusive file envelopes share a file. Optionally
 * cross-checks each car's declared envelope against an injected `lsFiles(car)`
 * (defaults to no cross-check), in one of two scopes:
 *
 *   - `options.lsFilesScope` **`'repo'`** (the default): `lsFiles(car)` returns
 *     every file TRACKED IN THE WHOLE WORKTREE — what {@link gitLsFilesAt}
 *     itself answers, with no notion of which car touched what. Against a
 *     repo-wide listing, the only sound check is one-directional:
 *     `declaredOnly` — a declared path this car's envelope names that is not
 *     tracked at all (a typo, a file that was never added). Computing
 *     `actualOnly` the naive way ("every tracked file this one car didn't
 *     declare") would flag nearly the entire repository as this car's own
 *     scope drift, which is nonsense for a single car's envelope.
 *   - `options.lsFilesScope` **`'car'`**: `lsFiles(car)` returns ONLY the
 *     files this specific car actually touched (e.g. `git diff --name-only
 *     <base>..<head>` on that car's own branch) — a genuinely car-scoped
 *     list, against which the full two-way diff is sound: `declaredOnly`
 *     (declared but never touched) AND `actualOnly` (touched but never
 *     declared, a real envelope-vs-reality drift).
 * @param {Array<{id: string, issues?: Array, files?: string[]}>} cars - The wave's car bundles.
 * @param {object} [options]
 * @param {number} [options.maxIssuesPerCar] - Bundle size cap (default 3).
 * @param {(car: object) => (string[]|null)} [options.lsFiles] - A car's
 *   comparison file list, in whichever scope `options.lsFilesScope` names;
 *   `null`/omit to skip the scope check for that car.
 * @param {('repo'|'car')} [options.lsFilesScope] - Which scope `lsFiles`
 *   answers in (default `'repo'`).
 * @returns {{ok: boolean, collisions: Array<{carA: string, carB: string, files: string[]}>,
 *   oversizedCars: Array<{carId: string, issueCount: number}>,
 *   scopeDrift: Array<{carId: string, declaredOnly: string[], actualOnly: string[]}>}}
 */
function validateWaveDisjointness(cars, options) {
  if (!Array.isArray(cars)) throw new TypeError('validateWaveDisjointness: cars must be an array');
  const opts = options || {};
  const maxIssuesPerCar = Number.isInteger(opts.maxIssuesPerCar) ? opts.maxIssuesPerCar : 3;
  const lsFiles = typeof opts.lsFiles === 'function' ? opts.lsFiles : null;
  const lsFilesScope = opts.lsFilesScope === 'car' ? 'car' : 'repo';

  const oversizedCars = [];
  const scopeDrift = [];
  const fileSetsByCarId = new Map();
  const ids = [];

  for (const car of cars) {
    if (!car || typeof car.id !== 'string' || !car.id) {
      throw new TypeError('validateWaveDisjointness: every car needs a non-empty string id');
    }
    ids.push(car.id);
    const issues = Array.isArray(car.issues) ? car.issues : [];
    if (issues.length > maxIssuesPerCar) {
      oversizedCars.push({ carId: car.id, issueCount: issues.length });
    }
    const declared = Array.isArray(car.files) ? car.files.slice() : [];
    fileSetsByCarId.set(car.id, new Set(declared));

    if (lsFiles) {
      const actual = lsFiles(car);
      if (Array.isArray(actual)) {
        const actualSet = new Set(actual);
        const declaredOnly = declared.filter((f) => !actualSet.has(f));
        // `actualOnly` only means anything against a CAR-scoped comparison
        // list -- against a repo-wide tracked-files listing, every file the
        // repo holds that this one car didn't declare is normal, not drift.
        const actualOnly = lsFilesScope === 'car'
          ? actual.filter((f) => !fileSetsByCarId.get(car.id).has(f))
          : [];
        if (declaredOnly.length || actualOnly.length) {
          scopeDrift.push({ carId: car.id, declaredOnly, actualOnly });
        }
      }
    }
  }

  const collisions = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i];
      const b = ids[j];
      const bFiles = fileSetsByCarId.get(b);
      const shared = [...fileSetsByCarId.get(a)].filter((f) => bFiles.has(f)).sort();
      if (shared.length) collisions.push({ carA: a, carB: b, files: shared });
    }
  }

  return {
    ok: collisions.length === 0 && oversizedCars.length === 0 && scopeDrift.length === 0,
    collisions,
    oversizedCars,
    scopeDrift
  };
}

/** Every violation code {@link validateVersionPlanParallelism} can report. */
const PARALLELISM_VIOLATION_CODES = Object.freeze([
  'UNPARALLELIZED_VERSION_PLAN', 'MISSING_PARALLEL_LANE_CAPACITY', 'WAVE_FILE_COLLISION'
]);

/**
 * Refuse a version plan that dumps a parallelizable issue set into a single
 * un-parallelized bucket, or that lets two parallel trains in the same wave
 * share a file (#3138, Operator-mandated scope addition). Pure, like
 * {@link validateWaveDisjointness}, which this reuses per wave.
 * @param {object} plan - One `roadmapData.releases[]` entry (or an
 *   equivalent in-flight `v6_wave_runs` run), extended with:
 * @param {number} [plan.maxParallelLanes] - Declared fleet capacity; missing
 *   or `< 1` is itself a violation, defaulted to 4 (`TC-Lane-A..D`) for the
 *   rest of this check so a plan with no declaration still gets checked
 *   against something, rather than trivially passing.
 * @param {Array<{wave?: (number|string), cars?: Array, files?: string[],
 *   runs_alone?: boolean, id?: string}>} [plan.trains] - Each train's cars
 *   (an issue-number array, same shape {@link _roadmapPlacements} reads),
 *   declared file envelope, and which wave it belongs to (trains sharing a
 *   `wave` value, or all trains when none declare one, are checked against
 *   each other for file collisions).
 * @param {object} [options]
 * @param {number} [options.maxIssuesPerCar] - Forwarded to
 *   {@link validateWaveDisjointness} per wave (default 3).
 * @returns {{ok: boolean, violations: Array<{code: string, message: string}>}}
 */
function validateVersionPlanParallelism(plan, options) {
  const p = plan && typeof plan === 'object' ? plan : {};
  const opts = options || {};
  const violations = [];

  const declaredCapacity = Number.isInteger(p.maxParallelLanes) && p.maxParallelLanes >= 1;
  if (!declaredCapacity) {
    violations.push({
      code: 'MISSING_PARALLEL_LANE_CAPACITY',
      message: 'Version plan does not declare a valid maxParallelLanes (integer >= 1); checking against the 4-lane fleet default'
    });
  }
  const maxParallelLanes = declaredCapacity ? p.maxParallelLanes : 4;

  const trains = Array.isArray(p.trains) ? p.trains : [];
  const totalIssues = trains.reduce((sum, t) => sum + (Array.isArray(t && t.cars) ? t.cars.length : 0), 0);
  if (trains.length === 1 && !trains[0].runs_alone && totalIssues >= 4 && maxParallelLanes >= 2) {
    violations.push({
      code: 'UNPARALLELIZED_VERSION_PLAN',
      message: `Version plan bundles ${totalIssues} issues into a single un-parallelized train despite maxParallelLanes=${maxParallelLanes}; `
        + `partition it across up to ${Math.min(totalIssues, maxParallelLanes)} parallel trains, or set runs_alone:true with justification`
    });
  }

  const byWave = new Map();
  trains.forEach((t, i) => {
    const wave = (t && t.wave !== undefined && t.wave !== null) ? t.wave : '_ungrouped';
    if (!byWave.has(wave)) byWave.set(wave, []);
    byWave.get(wave).push({ train: t, index: i });
  });
  for (const [wave, entries] of byWave) {
    if (entries.length < 2) continue;
    const cars = entries.map(({ train, index }) => ({
      id: typeof train.id === 'string' && train.id ? train.id : `train-${index}`,
      issues: Array.isArray(train.cars) ? train.cars : [],
      files: Array.isArray(train.files) ? train.files : []
    }));
    const result = validateWaveDisjointness(cars, { maxIssuesPerCar: opts.maxIssuesPerCar });
    for (const collision of result.collisions) {
      violations.push({
        code: 'WAVE_FILE_COLLISION', wave, carA: collision.carA, carB: collision.carB, files: collision.files,
        message: `Wave ${wave}: ${collision.carA} and ${collision.carB} are both parallel trains that share files: ${collision.files.join(', ')}`
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// ── Live Lane Dispatch & PR State Tracker ──

/** Every stage {@link syncWaveDispatchState} can report for a car. */
const DISPATCH_STAGES = ['unassigned', 'claimed', 'in-progress', 'in-review', 'blocked', 'closed'];

/**
 * Map each car to its live dispatch stage from the lanes currently holding
 * it and the pull requests open against it — `claimed`, `in-progress`,
 * `in-review`, `blocked` or `closed` (#2644), plus `unassigned` for a car no
 * lane has picked up yet. Precedence, most severe first: an explicit lane
 * hold or a PR with changes requested blocks the car outright; a merged PR
 * or every issue already closed closes it; an open PR puts it in review; a
 * lane reporting committed work is in progress; any other claimed lane is
 * just claimed.
 * Every car's row also always carries its canonical 6-stage `pill` (#3112,
 * PRR-B I-Gate R1 BLOCKING 2) — a pure function of `stage` alone, via
 * {@link sixStagePill} — and, ONLY when the caller's own car object supplies
 * them, passes through `files`, `reviewers`, `headSha` and per-issue pills:
 * a car with none of that extra data produces exactly `{stage, laneName,
 * openPrNumber, pill}`, so every existing consumer of the bare three-field
 * shape is unaffected.
 * @param {object} input
 * @param {Array<{id: string, issues?: Array<{id, state}>, files?: string[],
 *   reviewers?: {oGate?: string, prr?: string}, headSha?: string,
 *   deployedNotConfirmed?: boolean}>} input.cars
 * @param {Array<{carId: string, name?: string, status?: string, hold?: boolean}>} [input.lanes]
 * @param {Array<{carId: string, number: number, state: 'open'|'merged'|'closed',
 *   reviewDecision?: string}>} [input.pullRequests]
 * @param {string} [input.repo] - `owner/name`, when known (#3138) -- enables
 *   `row.prUrl` for a car with an open or merged PR number. Omit/null when
 *   unknown; nothing downstream requires it.
 * @returns {Object<string, {stage: string, laneName: (string|null), openPrNumber: (number|null),
 *   pill: {code: string, label: string}, files?: string[], reviewers?: object,
 *   headSha?: string, issues?: Array<{id, pill: object}>, merged?: boolean, prUrl?: string}>}
 */
function syncWaveDispatchState(input) {
  const data = input || {};
  const cars = Array.isArray(data.cars) ? data.cars : null;
  if (!cars) throw new TypeError('syncWaveDispatchState: input.cars must be an array');
  const repo = typeof data.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(data.repo) ? data.repo : null;

  const laneByCarId = new Map();
  for (const lane of Array.isArray(data.lanes) ? data.lanes : []) {
    if (lane && lane.carId) laneByCarId.set(lane.carId, lane);
  }
  const prsByCarId = new Map();
  for (const pr of Array.isArray(data.pullRequests) ? data.pullRequests : []) {
    if (!pr || !pr.carId) continue;
    if (!prsByCarId.has(pr.carId)) prsByCarId.set(pr.carId, []);
    prsByCarId.get(pr.carId).push(pr);
  }

  const result = {};
  for (const car of cars) {
    const carId = car.id;
    const lane = laneByCarId.get(carId) || null;
    const prs = prsByCarId.get(carId) || [];
    const issues = Array.isArray(car.issues) ? car.issues : [];
    const allIssuesClosed = issues.length > 0 && issues.every((i) => i && i.state === 'closed');
    const mergedPr = prs.find((pr) => pr.state === 'merged') || null;
    const openBlockedPr = prs.find((pr) => pr.state === 'open' && pr.reviewDecision === 'changes_requested') || null;
    const openPr = prs.find((pr) => pr.state === 'open') || null;

    let stage;
    if (lane && lane.hold === true) stage = 'blocked';
    else if (openBlockedPr) stage = 'blocked';
    else if (mergedPr || allIssuesClosed) stage = 'closed';
    else if (openPr) stage = 'in-review';
    else if (lane && lane.status === 'committed') stage = 'in-progress';
    else if (lane) stage = 'claimed';
    else stage = 'unassigned';

    const prNumber = openPr ? openPr.number : (mergedPr ? mergedPr.number : null);
    const row = {
      stage,
      laneName: lane && typeof lane.name === 'string' ? lane.name : null,
      openPrNumber: prNumber,
      pill: sixStagePill(stage, Boolean(car.deployedNotConfirmed))
    };
    // #3138: a `closed` row the tracker can positively confirm was merged
    // (never set for "all issues closed" alone, which could equally be a
    // cancelled car) -- `public/sprint-wave-ui.js#carGates` reads this to
    // infer gate pills as `merged` (all pass) instead of the deliberately
    // pessimistic bare `closed`, with no change to the `stage` value itself.
    // Confirmed either by a real merged PR, or by the wave scheduler's own
    // `confirmedComplete` signal (#3138 PRR-A R1: a completed car can reach
    // `closed` via `allIssuesClosed` alone with NO PR number ever recorded,
    // which this covers) -- never by `allIssuesClosed` alone, since that is
    // also true for a cancelled car.
    if (stage === 'closed') row.merged = Boolean(mergedPr) || Boolean(car.confirmedComplete);
    if (Array.isArray(car.files)) row.files = car.files;
    if (car.reviewers && typeof car.reviewers === 'object') row.reviewers = car.reviewers;
    if (typeof car.headSha === 'string' && car.headSha) row.headSha = car.headSha;
    // #3138: a clickable PR link needs a repo slug, which only a caller that
    // knows it (e.g. server.js, from the loaded roadmap data's own `repo`
    // field) can supply -- never guessed or built from untrusted input.
    if (repo && Number.isInteger(prNumber)) row.prUrl = `https://github.com/${repo}/pull/${prNumber}`;
    if (issues.length) {
      row.issues = issues.map((issue) => ({
        id: issue && issue.id,
        pill: sixStagePill(issue && issue.state === 'closed' ? 'closed' : stage, Boolean(issue && issue.deployedNotConfirmed))
      }));
    }
    result[carId] = row;
  }
  return result;
}

// ── Interactive Sprint Report & O-Gate Summary ──

/**
 * Average cycle time, in hours, across every car with a usable
 * `dispatchedAt`/`closedAt` pair. A car missing either timestamp, or whose
 * pair is out of order, contributes nothing rather than skewing the average
 * with a negative or NaN duration.
 * @param {Array<{dispatchedAt?: string, closedAt?: string}>} cars
 * @returns {number|null} Hours, rounded to 2 decimals, or `null` with no usable pair.
 */
function _averageCycleHours(cars) {
  const hours = [];
  for (const car of cars) {
    if (!car.dispatchedAt || !car.closedAt) continue;
    const start = new Date(car.dispatchedAt).getTime();
    const end = new Date(car.closedAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      hours.push((end - start) / 3600000);
    }
  }
  if (!hours.length) return null;
  return Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 100) / 100;
}

/**
 * Build the interactive sprint report / O-Gate summary model for one
 * release: the 8 Hero KPIs, the three SVG chart data series, and the
 * post-mortem guardrail ledger (#2644).
 * @param {object} sprintData
 * @param {string} [sprintData.version]
 * @param {Array<{id: string, cars?: Array, startedAt?: string, endedAt?: string}>} [sprintData.waves]
 * @param {Array<{id: string, issues?: Array<{state}>, category?: string, lane?: string,
 *   dispatchedAt?: string, closedAt?: string}>} [sprintData.cars]
 * @param {Array<{reviewRounds?: number, additions?: number, deletions?: number}>} [sprintData.pullRequests]
 * @param {Array<{guardrail?: string}>} [sprintData.learnings]
 * @param {string|null} [sprintData.releaseCommit]
 * @param {Array<{id: string, version?: string, title?: string, url?: string, kind?: string}>} [sprintData.reports] -
 *   The Sprint Reports Hub's catalog (#3112), normalized the same way {@link buildSprintWaveSnapshot} does.
 * @returns {object} The report summary model.
 */
function buildNativeSprintReportSummary(sprintData) {
  const data = sprintData || {};
  const cars = Array.isArray(data.cars) ? data.cars : [];
  const waves = Array.isArray(data.waves) ? data.waves : [];
  const pullRequests = Array.isArray(data.pullRequests) ? data.pullRequests : [];
  const learnings = Array.isArray(data.learnings) ? data.learnings : [];

  const issuesClosed = cars.reduce((sum, car) => sum
    + (Array.isArray(car.issues) ? car.issues.filter((i) => i && i.state === 'closed').length : 0), 0);

  const disjointness = validateWaveDisjointness(cars.map((car) => ({
    id: car.id, issues: car.issues, files: car.files
  })));

  const reviewRounds = pullRequests.reduce((sum, pr) => sum
    + (Number.isInteger(pr.reviewRounds) ? pr.reviewRounds : 0), 0);

  const netLOC = pullRequests.reduce((sum, pr) => {
    const additions = Number.isInteger(pr.additions) ? pr.additions : 0;
    const deletions = Number.isInteger(pr.deletions) ? pr.deletions : 0;
    return sum + (additions - deletions);
  }, 0);

  const heroKpis = {
    issuesClosed,
    builderPRs: pullRequests.length,
    waves: waves.length,
    fileCollisions: disjointness.collisions.length,
    reviewRounds,
    cycleTimeHours: _averageCycleHours(cars),
    netLOC,
    releaseCommit: typeof data.releaseCommit === 'string' ? data.releaseCommit : null
  };

  const waveTimeline = waves.map((wave) => ({
    waveId: wave.id,
    startedAt: wave.startedAt || null,
    endedAt: wave.endedAt || null,
    carCount: Array.isArray(wave.cars) ? wave.cars.length : 0
  }));

  const categoryBreakdown = {};
  for (const car of cars) {
    const category = typeof car.category === 'string' && car.category ? car.category : 'uncategorized';
    categoryBreakdown[category] = (categoryBreakdown[category] || 0) + 1;
  }

  const laneVelocity = {};
  for (const car of cars) {
    const laneName = typeof car.lane === 'string' && car.lane ? car.lane : 'unassigned';
    if (!laneVelocity[laneName]) {
      laneVelocity[laneName] = { carsCompleted: 0, _totalHours: 0, _samples: 0 };
    }
    const bucket = laneVelocity[laneName];
    const closedAllIssues = Array.isArray(car.issues) && car.issues.length > 0
      && car.issues.every((i) => i && i.state === 'closed');
    if (closedAllIssues) bucket.carsCompleted += 1;
    const avg = _averageCycleHours([car]);
    if (avg !== null) {
      bucket._totalHours += avg;
      bucket._samples += 1;
    }
  }
  for (const laneName of Object.keys(laneVelocity)) {
    const bucket = laneVelocity[laneName];
    laneVelocity[laneName] = {
      carsCompleted: bucket.carsCompleted,
      avgCycleHours: bucket._samples
        ? Math.round((bucket._totalHours / bucket._samples) * 100) / 100
        : null
    };
  }

  const guardrailLedger = GUARDRAIL_IDS.map((id) => {
    const matches = learnings.filter((entry) => entry && entry.guardrail === id);
    return { guardrail: id, triggered: matches.length > 0, count: matches.length };
  });

  return {
    version: data.version || null,
    heroKpis,
    charts: { waveTimeline, categoryBreakdown, laneVelocity },
    guardrailLedger,
    disjointness,
    // #3112 (PRR-B I-Gate R1 BLOCKING 2): carried through so a caller that
    // has a reports/retrospectives catalog to supply (`sprintData.reports`)
    // reaches `renderKaizenLedgerPanel` via the already-live
    // `GET /api/sprint-reports/:version` -> `data.report || data` pipe,
    // with no change needed to the route or the shell. Empty until a real
    // caller populates `sprintData.reports`.
    reports: _normalizeReportsCatalog(data.reports)
  };
}

// ── Consolidated Multi-Version Train Report (#3089) ──

/**
 * Round a dollar figure to cents, so a total of many versions' costs does
 * not carry floating-point noise into a report (0.1 + 0.2).
 * @param {number} usd
 * @returns {number}
 */
function _cents(usd) {
  return Math.round(usd * 100) / 100;
}

/**
 * Compare two `vX.Y.Z` versions numerically.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/**
 * One summary across a multi-version train (`v6.2.0`–`v6.2.10`, or
 * `v6.3.0`–`v6.4.0`): each version's PR count, issues closed and token
 * economics, their totals, and every version's fast-follow remark entries
 * in one table (#3089). Every total is computed here from the same
 * per-version figures the rows show, so a consolidated report never states
 * a total its own rows disagree with.
 *
 * A version with no sprint data is listed in `missingVersions` rather than
 * counted as zero. A total of an economics field some version does not
 * carry is `null`, with those versions in `economicsIncomplete`, rather
 * than a sum that looks complete and is not.
 * @param {string[]} versions - The train's versions, in any order.
 * @param {Object<string, object>} sprintDataByVersion - Each version's sprint data, as
 *   {@link buildNativeSprintReportSummary} takes it, plus optional `economics`
 *   and `fastFollowSubversions` (the report contract's `fast_follow_subversions` entries).
 * @returns {{versions: string[], missingVersions: string[], perVersion: Array<object>,
 *   totals: {prCount: number, issuesClosed: number, economics: object}, economicsIncomplete: string[],
 *   fastFollowSubversions: Array<object>}}
 */
function buildConsolidatedTrainReportSummary(versions, sprintDataByVersion) {
  if (!Array.isArray(versions) || versions.some((v) => typeof v !== 'string' || !v)) {
    throw new TypeError('buildConsolidatedTrainReportSummary: versions must be an array of version strings');
  }
  const byVersion = sprintDataByVersion && typeof sprintDataByVersion === 'object' ? sprintDataByVersion : {};
  const ordered = [...new Set(versions)].sort(_compareVersions);
  const missingVersions = [];
  const perVersion = [];
  const fastFollowSubversions = [];
  for (const version of ordered) {
    const data = byVersion[version];
    if (!data || typeof data !== 'object') {
      missingVersions.push(version);
      continue;
    }
    const summary = buildNativeSprintReportSummary({ ...data, version });
    const econ = data.economics && typeof data.economics === 'object' ? data.economics : {};
    const economics = {};
    for (const field of ECONOMICS_FIELDS) {
      const v = econ[field];
      economics[field] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
    }
    perVersion.push({
      version,
      prCount: summary.heroKpis.builderPRs,
      issuesClosed: summary.heroKpis.issuesClosed,
      economics
    });
    for (const entry of Array.isArray(data.fastFollowSubversions) ? data.fastFollowSubversions : []) {
      if (entry && typeof entry === 'object') fastFollowSubversions.push({ ...entry, train_version: version });
    }
  }
  const economicsIncomplete = perVersion.filter((row) => ECONOMICS_FIELDS.some((f) => row.economics[f] === null))
    .map((row) => row.version);
  const totalEconomics = {};
  for (const field of ECONOMICS_FIELDS) {
    if (perVersion.length === 0 || perVersion.some((row) => row.economics[field] === null)) {
      totalEconomics[field] = null;
      continue;
    }
    const sum = perVersion.reduce((acc, row) => acc + row.economics[field], 0);
    totalEconomics[field] = field.endsWith('_usd') ? _cents(sum) : sum;
  }
  fastFollowSubversions.sort((a, b) => _compareVersions(a.version, b.version));
  return {
    versions: ordered,
    missingVersions,
    perVersion,
    totals: {
      prCount: perVersion.reduce((acc, row) => acc + row.prCount, 0),
      issuesClosed: perVersion.reduce((acc, row) => acc + row.issuesClosed, 0),
      economics: totalEconomics
    },
    economicsIncomplete,
    fastFollowSubversions
  };
}

// ── Resilient Roadmap Sync (Exponential Backoff + Atomic Last-Good Snapshot) ──

/**
 * A `snapshotStore` backed by one file, written atomically through
 * {@link module:lib/staged-write.writeAtomic} so a crash mid-write never
 * leaves a half-written snapshot for the next read to trip over.
 * @param {string} filePath - Absolute path to the snapshot file.
 * @returns {{read: () => (*|null), write: (data: *) => void}}
 */
function createFileSnapshotStore(filePath) {
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (_err) {
        return null;
      }
    },
    write(data) {
      writeAtomic(filePath, JSON.stringify(data), 'sprint-roadmap-snapshot');
    }
  };
}

/**
 * Sleep helper the default backoff uses between retries; a test injects its
 * own `sleepFn` so a retry schedule never actually waits in real time.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Sync the roadmap through `fetchFn`, retrying a transient failure with
 * exponential backoff and falling back to the last-good snapshot once
 * retries are exhausted — never throwing the sync's own transport failure
 * at a caller that can show stale data instead (#2644).
 *
 * `fetchFn()` resolves `{status, body}` or rejects; both are treated as a
 * single attempt. A status in `retryableStatuses` (default: `408 429 499
 * 500 502 503 504`) retries; any other non-2xx status fails fast with no
 * retry, since a 4xx shape error will not fix itself on a timer. On every
 * successful 2xx, the fresh body is saved to `snapshotStore` before it is
 * returned, so the NEXT failure has something recent to fall back to.
 * @param {() => Promise<{status: number, body: *}>} fetchFn
 * @param {object} [options]
 * @param {number} [options.maxRetries] - Retry attempts after the first try (default 4).
 * @param {number} [options.baseDelayMs] - First retry's delay (default 250).
 * @param {number} [options.maxDelayMs] - Delay ceiling (default 8000).
 * @param {number[]} [options.retryableStatuses] - Statuses worth retrying.
 * @param {(ms: number) => Promise<void>} [options.sleepFn] - Injectable sleep, for tests.
 * @param {{read: () => (*|null), write: (data: *) => void}} [options.snapshotStore] -
 *   Where the last-good body is kept; omit to run with no fallback.
 * @returns {Promise<{ok: boolean, data: *, attempts: number, usedSnapshot: boolean, error?: object}>}
 */
async function syncRoadmapWithBackoff(fetchFn, options) {
  if (typeof fetchFn !== 'function') throw new TypeError('syncRoadmapWithBackoff: fetchFn must be a function');
  const opts = options || {};
  const maxRetries = Number.isInteger(opts.maxRetries) ? opts.maxRetries : 4;
  const baseDelayMs = Number.isInteger(opts.baseDelayMs) ? opts.baseDelayMs : 250;
  const maxDelayMs = Number.isInteger(opts.maxDelayMs) ? opts.maxDelayMs : 8000;
  const retryableStatuses = Array.isArray(opts.retryableStatuses) ? opts.retryableStatuses : DEFAULT_RETRYABLE_STATUSES;
  const sleepFn = typeof opts.sleepFn === 'function' ? opts.sleepFn : _defaultSleep;
  const snapshotStore = opts.snapshotStore
    && typeof opts.snapshotStore.read === 'function'
    && typeof opts.snapshotStore.write === 'function'
    ? opts.snapshotStore : null;

  let attempt = 0;
  let lastError = null;

  while (attempt <= maxRetries) {
    attempt += 1;
    try {
      const response = await fetchFn();
      const status = response && typeof response.status === 'number' ? response.status : 200;
      if (status >= 200 && status < 300) {
        if (snapshotStore) {
          try {
            snapshotStore.write(response.body);
          } catch (_err) {
            // Best-effort: the sync itself already succeeded, so a snapshot
            // write failure degrades only the NEXT failure's fallback, not this one.
          }
        }
        return { ok: true, data: response.body, attempts: attempt, usedSnapshot: false };
      }
      if (!retryableStatuses.includes(status)) {
        const snapshot = snapshotStore ? snapshotStore.read() : null;
        return {
          ok: false,
          data: snapshot,
          usedSnapshot: snapshot !== null,
          attempts: attempt,
          error: { status, message: `Non-retryable status ${status}` }
        };
      }
      lastError = { status, message: `Transient status ${status}` };
    } catch (err) {
      lastError = { message: err && err.message ? err.message : String(err) };
    }
    if (attempt > maxRetries) break;
    await sleepFn(Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1))));
  }

  const snapshot = snapshotStore ? snapshotStore.read() : null;
  return {
    ok: false,
    data: snapshot,
    usedSnapshot: snapshot !== null,
    attempts: attempt,
    error: lastError || { message: 'Exhausted retries with no response' }
  };
}

// ── Runtime Setup & Roadmap Sync Gate (#3093, Ruling A766-1) ──

/**
 * Every violation code {@link verifySprintSetupAndRoadmapSync} can report —
 * including, when a caller passes `input.versionPlans` (#3138), every code
 * {@link validateVersionPlanParallelism} can report too, since those
 * violations are merged into the same gate's output.
 */
const SETUP_VIOLATION_CODES = Object.freeze([
  'MISSING_MILESTONE_RELEASE', 'DUPLICATE_ROADMAP_PLACEMENT', 'ROADMAP_SYNC_ERROR', 'UNLINKED_REPORT_DIR',
  ...PARALLELISM_VIOLATION_CODES
]);

/**
 * Why a roadmap sync status cannot be vouched for, or null when it reads
 * healthy. The status file carries `state` today (`roadmap-sync-status.json`);
 * `status` and `ok` are read too (Ruling A786 I1). An unread or malformed status
 * fails closed: this gate cannot say the roadmap is in sync without it.
 * @param {*} syncStatus
 * @returns {string|null}
 */
function _syncProblem(syncStatus) {
  if (!syncStatus || typeof syncStatus !== 'object' || Array.isArray(syncStatus)) return 'missing';
  if (syncStatus.ok === false) return 'ok is false';
  for (const field of ['state', 'status']) {
    if (!(field in syncStatus)) continue;
    const value = syncStatus[field];
    if (value !== 'ok') return `${field} is ${JSON.stringify(value)}`;
  }
  return null;
}

/**
 * Every issue number the roadmap places, with where it is placed: a
 * release's trains, an unversioned train, or a backlog bucket's `cars` or
 * `issues` (a number, or an object carrying `number`).
 * @param {object} roadmapData
 * @returns {Map<number, string[]>} Issue number → placements, one per occurrence.
 */
function _roadmapPlacements(roadmapData) {
  const placements = new Map();
  const place = (issue, where) => {
    const n = issue && typeof issue === 'object' ? issue.number : issue;
    if (!Number.isInteger(n)) return;
    if (!placements.has(n)) placements.set(n, []);
    placements.get(n).push(where);
  };
  const list = (value) => (Array.isArray(value) ? value : []);
  for (const release of list(roadmapData.releases)) {
    for (const train of list(release && release.trains)) {
      for (const car of list(train && train.cars)) place(car, `releases[${release.version}]`);
    }
  }
  for (const train of list(roadmapData.unversioned_trains)) {
    for (const car of list(train && train.cars)) place(car, `unversioned_trains[${train.id != null ? train.id : train.name}]`);
  }
  for (const bucket of list(roadmapData.backlog)) {
    for (const key of ['cars', 'issues']) {
      for (const car of list(bucket && bucket[key])) place(car, `backlog[${bucket.name}]`);
    }
  }
  return placements;
}

/**
 * Build a minimal roadmapData from what THIS checkout can see on disk, for
 * when the real `roadmap2-data.json` (an external, read-only-to-this-
 * checkout file per ADR 0024) is not reachable — e.g. CI, or a machine
 * without the shared roadmap-board checkout (#3134). Deliberately degrades
 * gracefully rather than leaving the Charter & Roadmap panel showing
 * nothing: every source here comes from files already inside this
 * checkout or its documented shared-infra home, never invented.
 * @param {object} sources
 * @param {string[]} [sources.docsReleaseVersions] - Bare `X.Y.Z` versions
 *   this checkout's own `docs/releases/*.md` files name (shipped; no car
 *   detail is available from a status doc alone, so each becomes a
 *   release with no trains).
 * @param {string|null} [sources.laneQueueText] - `LANE_QUEUE.md`'s raw
 *   text, when readable — parsed for `## Train N — \`Sprint vX.Y.Z\`` train
 *   headers and every `Closes #NNNN` / `Part of #NNNN` / `Fixes #NNNN`
 *   issue number under each (#3138 PRR-A Warning 1: a multi-car train's
 *   non-closing cars are named `Part of #N` in this file's own real rows),
 *   to recover the CURRENT sprint's real cars even with no roadmap2-data.json
 *   at all.
 * @returns {{releases: Array<{version: string, trains: Array<{cars: number[]}>}>}}
 */
function buildRoadmapDataFromFallbackSources(sources) {
  const s = sources || {};
  const releasesByVersion = new Map();
  const ensure = (version) => {
    if (!releasesByVersion.has(version)) releasesByVersion.set(version, { version, trains: [] });
    return releasesByVersion.get(version);
  };

  for (const version of Array.isArray(s.docsReleaseVersions) ? s.docsReleaseVersions : []) {
    if (typeof version === 'string' && /^\d+\.\d+(\.\d+)?$/.test(version)) ensure(version);
  }

  if (typeof s.laneQueueText === 'string' && s.laneQueueText) {
    const trainHeaderRe = /^##\s+Train\s+\d+\s+—\s+`Sprint\s+v?(\d+\.\d+\.\d+)`/gm;
    const headers = [...s.laneQueueText.matchAll(trainHeaderRe)];
    for (let i = 0; i < headers.length; i += 1) {
      const version = headers[i][1];
      const start = headers[i].index;
      const end = i + 1 < headers.length ? headers[i + 1].index : s.laneQueueText.length;
      const block = s.laneQueueText.slice(start, end);
      const cars = [...new Set([...block.matchAll(/(?:Closes|Part of|Fixes)\s+#(\d+)/gi)].map((m) => Number(m[1])))];
      if (!cars.length) continue;
      ensure(version).trains.push({ cars });
    }
  }

  return { releases: [...releasesByVersion.values()] };
}

/**
 * The runtime readiness check Gate 0 and Sprint Exit certify against
 * (#3093, Ruling A766-1, interpretations I1-I2 co-signed in A786). It holds
 * certification while any of these is true:
 *
 *   - an open GitHub milestone whose title leads with `vX.Y.Z` has no
 *     `roadmapData.releases[]` entry of that version (MISSING_MILESTONE_RELEASE).
 *     A roadmap release with no milestone yet is a forecast, not a gap.
 *   - an issue number is placed more than once anywhere across releases,
 *     unversioned trains and the backlog, within one bucket or across them
 *     (DUPLICATE_ROADMAP_PLACEMENT).
 *   - the roadmap sync status is missing, `ok: false`, or has a `state` or
 *     `status` other than `'ok'` (ROADMAP_SYNC_ERROR).
 *   - a report directory is not linked from the Sprint Reports Hub
 *     (UNLINKED_REPORT_DIR); `ensureHubReportLinks` repairs that.
 *
 * Pure: the caller reads the milestones, the roadmap, the status file, the
 * hub and its directory listing, and passes them in.
 * @param {object} input
 * @param {Array<{title: string, state: string}>} input.milestones - GitHub milestones (any state).
 * @param {object} input.roadmapData - Parsed `roadmap2-data.json`.
 * @param {*} input.syncStatus - Parsed `roadmap-sync-status.json`, or null when it could not be read.
 * @param {string[]} input.reportDirs - Directory names in `sprint-reports/`.
 * @param {string} input.hubHtml - `sprint-reports/index.html`.
 * @param {object[]} [input.versionPlans] - Version plans to check for
 *   parallel-lane capacity (#3138), each passed to
 *   {@link validateVersionPlanParallelism} — omit/empty to skip this check
 *   entirely (every existing caller that doesn't know about it yet).
 * @returns {{ok: boolean, guardrail: string, violations: Array<{code: string, message: string}>,
 *   checked: {milestones: number, placedIssues: number, reportDirs: number}}}
 */
function verifySprintSetupAndRoadmapSync(input) {
  const data = input || {};
  if (!Array.isArray(data.milestones)) throw new TypeError('verifySprintSetupAndRoadmapSync: input.milestones must be an array');
  if (!data.roadmapData || typeof data.roadmapData !== 'object') {
    throw new TypeError('verifySprintSetupAndRoadmapSync: input.roadmapData must be an object');
  }
  const violations = [];

  for (const plan of Array.isArray(data.versionPlans) ? data.versionPlans : []) {
    violations.push(...validateVersionPlanParallelism(plan).violations);
  }

  const releaseVersions = new Set((Array.isArray(data.roadmapData.releases) ? data.roadmapData.releases : [])
    .map((r) => (r && typeof r.version === 'string' ? r.version.replace(/^v/, '') : null))
    .filter(Boolean));
  let milestonesChecked = 0;
  for (const milestone of data.milestones) {
    if (!milestone || String(milestone.state).toLowerCase() !== 'open') continue;
    const m = /^v?(\d+\.\d+\.\d+)\b/.exec(typeof milestone.title === 'string' ? milestone.title.trim() : '');
    if (!m) continue;
    milestonesChecked += 1;
    if (!releaseVersions.has(m[1])) {
      violations.push({
        code: 'MISSING_MILESTONE_RELEASE', version: `v${m[1]}`,
        message: `Milestone "${milestone.title}" has no v${m[1]} release in the roadmap`
      });
    }
  }

  const placements = _roadmapPlacements(data.roadmapData);
  for (const [issue, where] of [...placements].sort((a, b) => a[0] - b[0])) {
    if (where.length > 1) {
      violations.push({
        code: 'DUPLICATE_ROADMAP_PLACEMENT', issue, placements: where,
        message: `#${issue} is placed ${where.length} times: ${where.join(', ')}`
      });
    }
  }

  const syncProblem = _syncProblem(data.syncStatus);
  if (syncProblem) {
    violations.push({ code: 'ROADMAP_SYNC_ERROR', reason: syncProblem, message: `Roadmap sync status cannot be vouched for: ${syncProblem}` });
  }

  const links = validateHubReportLinks(data.hubHtml, data.reportDirs);
  for (const dir of links.unlinked) {
    violations.push({ code: 'UNLINKED_REPORT_DIR', dir, message: `Report directory ${dir} is not linked from the Sprint Reports Hub` });
  }

  return {
    ok: violations.length === 0,
    guardrail: SETUP_GUARDRAIL_ID,
    violations,
    checked: { milestones: milestonesChecked, placedIssues: placements.size, reportDirs: links.linked.length + links.unlinked.length }
  };
}

/**
 * A sprint version as a route may name it: `current`, or `X.Y.Z` with an
 * optional leading `v` (#3087, Ruling A774). Anything else, including any
 * path segment, is refused before it reaches a lookup.
 * @type {RegExp}
 */
const SPRINT_VERSION_RE = /^(?:current|v?\d{1,4}\.\d{1,4}\.\d{1,4})$/;

/** The empty sprint, for a current sprint with no persisted run yet (#3087). */
function _emptySprintData() {
  return { version: null, cars: [], lanes: [], pullRequests: [], waves: [], learnings: [], releaseCommit: null };
}

/**
 * The tracker's sprint data, built from the v6 wave scheduler's persisted
 * runs (#3087, Ruling A774). For `'current'` it reads the most recent run
 * whose own `status` is `'active'` or `'running'`, else the most recent run,
 * and with no run at all it answers an empty sprint rather than nothing. For
 * a version it reads the run whose `metadata.version` (or id) names it, and
 * answers null when none does, so the route can say 404.
 *
 * Each car keeps its id, waves come from the run, and a lane is the car's
 * assignee (`payload.lane`/`payload.assignee`/`payload.laneName`, falling
 * back to the same fields at the car's own top level): `running` and
 * `awaiting-gate` read as committed work, and `gate-held` or `stalled` as a
 * hold. A car is confirmed done (`entry.confirmedComplete`) when its own
 * `status` is `'complete'`/`'merged'`, or it carries a merge SHA under
 * `mergeSha`/`mergeCommit` (car or payload level) — the live `v6_wave_runs`
 * table carries all of these across different writers (Architect Ruling
 * A859, #3164), not just this module's own `WaveScheduler`'s `'complete'`.
 * A done car carries one closed marker issue (its own id) when its payload
 * lists no real issues at all; when it DOES list issues, every one of them
 * normalizes to `state: 'closed'` once the car itself is confirmed done,
 * since a dispatch-time 'open' snapshot on an issue is not updated when the
 * car finishes later. Learnings are empty.
 *
 * Also carries forward (#3112, PRR-B I-Gate R1 BLOCKING 2; extended by #3164,
 * Ruling A859) every optional field the real `v6_wave_runs` car/run state and
 * payload can carry that this function used to silently drop or read from
 * only one of several real shapes: the run's own resolved `version` (top
 * level, and per car); each car's `fileScope`
 * (`lib/v6/c3-wave-scheduler.js#createRun`'s own top-level field — not
 * nested under `payload`) or `payload.files`; `reviewers` (`payload.reviewers`/
 * `car.reviewers` as an object, or a bare `car.reviewer` string folded into
 * `{prr: car.reviewer}`); `headSha`/`branch`/`title` (`payload.*` or the same
 * field at the car's own top level); `headSha`, additionally falling back to
 * `mergeSha`/`mergeCommit` (car level) when no bare head SHA was ever
 * recorded at all; the PR number, read from whichever of
 * `payload.openPrNumber`/`payload.prNumber`/`car.openPrNumber`/`car.prNumber`
 * is actually an integer, synthesized into a `{carId, number, title, lane,
 * status, state: ('merged'|'open')}` `pullRequests` entry so
 * {@link syncWaveDispatchState}'s existing PR-matching logic computes the
 * right stage from it; and the run's own `releaseCommit` (top level, or
 * `metadata.releaseCommit`, or — when neither exists at all — the one car
 * whose id ends in `-REL`'s own mergeSha/mergeCommit/headSha, the release
 * cut's own merge identity), returned as this sprint's `releaseCommit`
 * instead of always null.
 * @param {Object<string, object>} runs - `SqliteSchedulerStore#read().runs`.
 * @param {string} version - `'current'` or a version.
 * @returns {object|null}
 */
function sprintDataFromWaveRuns(runs, version) {
  const all = Object.values(runs || {}).filter((r) => r && typeof r === 'object' && r.cars);
  const byNewest = [...all].sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  let run;
  if (version === 'current') {
    // #3163 (Architect Ruling A859, R2): the live `v6_wave_runs` table holds
    // rows this module's own `WaveScheduler` class never wrote -- R1's check
    // against `lib/v6/c3-wave-scheduler.js`'s source (which only ever sets
    // `run.status` to 'active'/'complete'/'blocked') missed that the real
    // v6.5.3 row has run-level `status: "running"`, written by a different
    // dispatch path this module doesn't own. The code tells you what ONE
    // writer produces; the table tells you what every writer actually did --
    // checked directly against `~/.tangleclaw/tangleclaw.db` before this fix.
    run = byNewest.find((r) => r.status === 'active' || r.status === 'running') || byNewest[0];
    if (!run) return _emptySprintData();
  } else {
    const bare = String(version).replace(/^v/, '');
    run = byNewest.find((r) => {
      const v = r.metadata && typeof r.metadata.version === 'string' ? r.metadata.version.replace(/^v/, '') : null;
      return v === bare || String(r.id).replace(/^v/, '') === bare;
    });
    if (!run) return null;
  }
  const resolvedVersion = `v${String((run.metadata && typeof run.metadata.version === 'string' && run.metadata.version)
    || run.id).replace(/^v/, '')}`;
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);
  const cars = [];
  const lanes = [];
  const pullRequests = [];
  for (const car of Object.values(run.cars)) {
    const payload = car.payload && typeof car.payload === 'object' ? car.payload : {};
    // #3164 (Architect Ruling A859, R2): a car this module's own
    // `WaveScheduler` marks 'complete' is one real signal; the live table
    // also has rows a DIFFERENT writer marked 'merged' directly, or that
    // carry a merge SHA with no matching status word at all (`car.mergeSha`/
    // `car.mergeCommit`/`payload.mergeSha`/`payload.mergeCommit` across
    // v6.5.0-v6.5.2's real rows) -- any one of these means the car is
    // genuinely done, independent of which writer recorded it that way.
    const isMergedCar = car.status === 'complete' || car.status === 'merged'
      || Boolean(car.mergeSha || car.mergeCommit || payload.mergeSha || payload.mergeCommit);
    const done = isMergedCar || car.status === 'cancelled';
    // #3164: `payload.issues` is the shape this module's own writer uses;
    // the real table also has `car.issues` (bare numbers/strings, e.g.
    // '#3148', or already-shaped objects) from other writers -- read
    // whichever one actually has something, never both.
    const rawIssues = Array.isArray(payload.issues) ? payload.issues : (Array.isArray(car.issues) ? car.issues : null);
    const normalizeIssue = (issue) => {
      if (issue && typeof issue === 'object') {
        // A merged car's own issue list can still carry a stale 'open' from
        // dispatch time (v6.5.1's real rows do) -- the car itself finishing
        // is the more authoritative signal once it is true.
        return { ...issue, state: isMergedCar ? 'closed' : issue.state };
      }
      const bare = String(issue).replace(/^#/, '');
      const id = Number(bare) || issue;
      return { id, state: isMergedCar ? 'closed' : 'open' };
    };
    const issues = rawIssues ? rawIssues.map(normalizeIssue) : (done ? [{ id: car.id, state: 'closed' }] : []);
    const entry = { id: car.id, version: resolvedVersion, issues, dispatchedAt: iso(car.startedAt), closedAt: iso(car.completedAt) };
    const name = payload.lane || payload.assignee || payload.laneName || car.lane || car.assignee || car.laneName;
    if (typeof name === 'string' && name) entry.lane = name;
    const files = Array.isArray(car.fileScope) ? car.fileScope : (Array.isArray(payload.files) ? payload.files : null);
    if (files) entry.files = files;
    // #3164: reviewers as the real table's other writers recorded them --
    // `payload.reviewers`/`car.reviewers` (an object), or a bare
    // `car.reviewer` string (v6.5.2's real rows), folded into the one
    // `{prr: ...}` shape downstream reviewer-rendering already expects.
    const reviewers = (payload.reviewers && typeof payload.reviewers === 'object') ? payload.reviewers
      : (car.reviewers && typeof car.reviewers === 'object') ? car.reviewers
        : (typeof car.reviewer === 'string' && car.reviewer) ? { prr: car.reviewer } : null;
    if (reviewers) entry.reviewers = reviewers;
    // #3164 (PRR-B R-Gate REVISE, BLOCKING 1b): a real row that never
    // recorded a bare `headSha` at all still names the commit its work
    // landed as via `mergeSha`/`mergeCommit` (v6.5.0/v6.5.1's real rows) --
    // a fallback of last resort, after the two real `headSha` locations.
    const headSha = (typeof payload.headSha === 'string' && payload.headSha) || (typeof car.headSha === 'string' && car.headSha)
      || (typeof car.mergeSha === 'string' && car.mergeSha) || (typeof car.mergeCommit === 'string' && car.mergeCommit) || null;
    if (headSha) entry.headSha = headSha;
    // #3163/#3164: the same optional-field carry-forward #3138 established
    // for headSha/reviewers, extended to the car's branch and a human title
    // -- real rows carry these at `car.branch`/`car.title` (top level, not
    // nested in `payload`) as often as under `payload.branch`/`payload.title`.
    const branch = (typeof payload.branch === 'string' && payload.branch) || (typeof car.branch === 'string' && car.branch) || null;
    if (branch) entry.branch = branch;
    const title = (typeof payload.title === 'string' && payload.title) || (typeof car.title === 'string' && car.title) || null;
    if (title) entry.title = title;
    // #3138 (PRR-A R1), extended by #3164 to `isMergedCar`: a positive,
    // independently-confirmed completion signal, used below even when no PR
    // number was ever recorded for this car.
    if (isMergedCar) entry.confirmedComplete = true;
    cars.push(entry);
    // #3164: the PR number the real table actually stores -- this module's
    // own writer used `payload.openPrNumber`; the other writers that
    // populate v6.5.0-v6.5.3's real rows store it as `payload.prNumber` or,
    // most commonly, at the car's own top level (`car.prNumber`/
    // `car.openPrNumber`), never inside `payload` at all. The first
    // candidate that is actually an integer wins.
    const prNumber = [payload.openPrNumber, payload.prNumber, car.openPrNumber, car.prNumber]
      .find((n) => Number.isInteger(n));
    if (Number.isInteger(prNumber)) {
      // #3164: once the car is actually done, the PR that number names has
      // necessarily merged (or the car would not read `complete`/`merged`/
      // carry a merge SHA), so reporting it as still 'open' is what left the
      // Kaizen/Charter panels crediting a shipped sprint with 0 merged PRs.
      // `title`/`status` ride along so `pullRequests` entries carry more
      // than a bare id for a caller that renders them directly (the Kaizen
      // Reports catalog).
      pullRequests.push({
        carId: car.id, number: prNumber, state: done ? 'merged' : 'open',
        title: entry.title || null, lane: entry.lane || null, status: car.status
      });
    }
    if (typeof name === 'string' && name) {
      lanes.push({
        carId: car.id, name,
        status: car.status === 'running' || car.status === 'awaiting-gate' ? 'committed' : car.status,
        hold: car.status === 'gate-held' || car.status === 'stalled'
      });
    }
  }
  // #3164 (Architect Ruling A859, R2; extended by PRR-B R-Gate REVISE
  // BLOCKING 1d): the real `v6_wave_runs` rows carry the release commit at
  // the run's own top level (`run.releaseCommit`, v6.5.2's real row) or,
  // for an older writer, under `run.metadata.releaseCommit` -- this
  // module's own writer never set either, which is why it was always
  // hardcoded null before. Neither field exists at all on some real rows
  // (v6.5.0's run carries no releaseCommit anywhere), so the last resort is
  // the run's own release car's own merge identity: a car whose id ends in
  // `-REL` (`V650-W-REL`, `V652-W2-REL`, ...) is this sprint's release cut,
  // and its mergeSha/mergeCommit/headSha (car or payload level) names the
  // commit that actually shipped the release once that car is done.
  let releaseCommit = (typeof run.releaseCommit === 'string' && run.releaseCommit)
    || (run.metadata && typeof run.metadata.releaseCommit === 'string' && run.metadata.releaseCommit) || null;
  if (!releaseCommit) {
    const releaseCar = Object.values(run.cars).find((c) => typeof c.id === 'string' && /-REL$/i.test(c.id));
    if (releaseCar) {
      const rp = releaseCar.payload && typeof releaseCar.payload === 'object' ? releaseCar.payload : {};
      releaseCommit = (typeof releaseCar.mergeSha === 'string' && releaseCar.mergeSha)
        || (typeof releaseCar.mergeCommit === 'string' && releaseCar.mergeCommit)
        || (typeof releaseCar.headSha === 'string' && releaseCar.headSha)
        || (typeof rp.mergeSha === 'string' && rp.mergeSha) || (typeof rp.mergeCommit === 'string' && rp.mergeCommit)
        || (typeof rp.headSha === 'string' && rp.headSha) || null;
    }
  }
  return {
    version: resolvedVersion,
    cars, lanes, pullRequests,
    waves: Array.isArray(run.waves) ? run.waves : [],
    learnings: [], releaseCommit
  };
}

// ── Release-First Roadmap, 6-Stage Pills & Sprint/Kaizen Reports Snapshot (#3112) ──

/**
 * The canonical 6-stage pill vocabulary the v6 PM Workspace renders a Car's
 * or Issue's status with (#3112) — distinct from {@link DISPATCH_STAGES},
 * which is this module's own internal dispatch-state vocabulary (no
 * `deployed` stage, and `unassigned`/`claimed` where this one has a single
 * `open`). {@link sixStagePill} is the one place that translates between them.
 */
const SIX_STAGE_PILL_LABELS = Object.freeze({
  open: 'Not started',
  'in-progress': 'In progress',
  'in-review': 'In review',
  blocked: 'Blocked',
  deployed: 'Deployed, awaiting a check',
  closed: 'Completed'
});

/**
 * Map a {@link DISPATCH_STAGES} value onto the canonical 6-stage pill
 * (#3112). `unassigned`/`claimed` both collapse to `open` ("Not started") —
 * the 6-stage vocabulary has no separate "claimed but not yet started"
 * stage. A `closed` car/issue reads `deployed` ("Deployed, awaiting a
 * check") rather than `closed` ("Completed") when the caller marks it
 * merged/shipped but not yet confirmed by a release check — `closed` alone
 * cannot distinguish "merged, awaiting confirmation" from "fully done",
 * since {@link syncWaveDispatchState} folds both into the same stage.
 * @param {string} dispatchStage - One of {@link DISPATCH_STAGES}.
 * @param {boolean} [deployedNotConfirmed] - True when merged/closed but not
 *   yet confirmed by a release check.
 * @returns {{code: string, label: string}}
 */
function sixStagePill(dispatchStage, deployedNotConfirmed) {
  let code;
  if (dispatchStage === 'unassigned' || dispatchStage === 'claimed') code = 'open';
  else if (dispatchStage === 'closed' && deployedNotConfirmed) code = 'deployed';
  else if (Object.prototype.hasOwnProperty.call(SIX_STAGE_PILL_LABELS, dispatchStage)) code = dispatchStage;
  else code = 'open';
  return { code, label: SIX_STAGE_PILL_LABELS[code] };
}

/** Matches `## [X.Y.Z] - ` and `## X.Y.Z - ` released-section headings, never `## [Unreleased]` (no digits to match). */
const CHANGELOG_RELEASED_HEADING_RE = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?\s+-\s+/gm;

/**
 * Every version `CHANGELOG.md` already records as released (#3162): every
 * `## [X.Y.Z] - <date>` / `## X.Y.Z - <date>` heading, bare (no leading `v`).
 * Pure text parsing, no filesystem access — the caller reads the file
 * (`docs/release-process.md`'s own "Files a release needs" convention: this
 * repo's released history lives in `CHANGELOG.md`, not a second source of
 * truth this module would have to keep in sync with it).
 * @param {string} changelogText - `CHANGELOG.md`'s raw contents.
 * @returns {string[]} Bare versions, in the order their headings appear
 *   (newest first, matching the file's own convention) — not deduplicated,
 *   since a well-formed changelog never repeats a version heading.
 */
function parseShippedVersionsFromChangelog(changelogText) {
  if (typeof changelogText !== 'string' || !changelogText) return [];
  return [...changelogText.matchAll(CHANGELOG_RELEASED_HEADING_RE)].map((m) => m[1]);
}

/**
 * Classify one roadmap release's version against the sprint's own current
 * version and already-shipped history (#3112): `active` when it names the
 * current sprint AND still has an open (not-yet-closed) car among the
 * caller's own dispatched cars; `shipped` when it is already listed among
 * shipped versions (checked ahead of "is it the current one" once there is
 * no open car left to call active — PRR-B R-Gate REVISE, #3162 BLOCKING 2:
 * the un-conditioned `currentVersion` check used to force an already-shipped
 * current version, e.g. `v6.5.2` once `version.json` had moved on to it with
 * every car closed, into `releases.active` forever, never `releases.shipped`);
 * otherwise `planned` — a forecast with no run yet.
 * @param {string|number} version
 * @param {string|null} currentVersion
 * @param {Set<string>} shippedVersions - Bare (no leading `v`) version strings.
 * @param {boolean} hasOpenCar - Whether this release (when it is the current
 *   one) still has a dispatched car that is not yet closed.
 * @returns {'active'|'shipped'|'planned'}
 */
function _releaseStatus(version, currentVersion, shippedVersions, hasOpenCar) {
  const bare = String(version).replace(/^v/, '');
  const isCurrent = !!currentVersion && bare === String(currentVersion).replace(/^v/, '');
  if (isCurrent && hasOpenCar) return 'active';
  if (shippedVersions.has(bare)) return 'shipped';
  if (isCurrent) return 'active';
  return 'planned';
}

/**
 * Normalize a Sprint Reports Hub catalog list (#3112): used by both
 * {@link buildSprintWaveSnapshot} and {@link buildNativeSprintReportSummary}
 * (#3112, PRR-B I-Gate R1 BLOCKING 2 — the summary a sprint report route
 * already serves through `renderKaizenLedgerPanel`'s `data.report || data`
 * passthrough gains the same catalog, rather than this module growing two
 * slightly different ways to shape one list).
 * @param {Array<{id: string, version?: string, title?: string, url?: string,
 *   kind?: string}>} [reports]
 * @returns {Array<{id: string, version: (string|null), title: string, url: (string|null), kind: string}>}
 */
function _normalizeReportsCatalog(reports) {
  return (Array.isArray(reports) ? reports : [])
    .filter((r) => r && typeof r.id === 'string' && r.id)
    .map((r) => ({
      id: r.id,
      version: typeof r.version === 'string' ? r.version : null,
      title: typeof r.title === 'string' && r.title ? r.title : r.id,
      url: typeof r.url === 'string' ? r.url : null,
      kind: r.kind === 'retrospective' ? 'retrospective' : 'report'
    }));
}

/**
 * The marker strings a Gate 4 post-sprint report has not yet settled past
 * (#3175): the live-in-progress auto-generator's own HTML comment, and the
 * `LIVE TRACKING` placeholder text it leaves in every one of the 16 Rule
 * #283 rows until the empirical post-mortem replaces them. Either one
 * anywhere in the report means it is still the auto-generated tracker, not
 * the settled report Gate 4 requires.
 */
const UNSETTLED_REPORT_MARKERS = Object.freeze(['<!-- AUTO_GENERATED_LIVE_SPRINT_REPORT -->', 'LIVE TRACKING']);

/**
 * Whether a Sprint Report's rendered HTML still carries the live-tracker
 * placeholder (#3175) rather than a settled post-mortem.
 * @param {string} html
 * @returns {boolean}
 */
function _reportIsUnsettled(html) {
  return UNSETTLED_REPORT_MARKERS.some((marker) => html.includes(marker));
}

/**
 * Every `<li>` inside the first `<ul id="{listId}">...</ul>` in `html`, as
 * plain text, in document order. Empty when the list is absent -- a report
 * with no post-mortem yet is read as having nothing to say, never thrown.
 * @param {string} html
 * @param {string} listId
 * @returns {string[]}
 */
function _extractListPoints(html, listId) {
  const m = html.match(new RegExp(`<ul[^>]+id="${listId}"[^>]*>([\\s\\S]*?)<\\/ul>`));
  if (!m) return [];
  return [...m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((li) => toPlainText(li[1]))
    .filter(Boolean);
}

/**
 * How many of the 16 Rule #283 table rows (`<table id="postmortem-rule-283">`)
 * are marked `data-status="pass"`. 0 when the table is absent.
 * @param {string} html
 * @returns {number}
 */
function _extractRule283PassCount(html) {
  const m = html.match(/<table[^>]+id="postmortem-rule-283"[^>]*>([\s\S]*?)<\/table>/);
  if (!m) return 0;
  return [...m[1].matchAll(/<tr\b[^>]*\bdata-status="pass"[^>]*>/gi)].length;
}

/**
 * Gate 4's post-sprint report settlement for one version's rendered
 * `sprint-reports/vX.Y.Z/index.html` (#3175): whether it has moved past the
 * auto-generated live-tracker placeholder, plus its post-mortem's own
 * summary fields when the settled report carries them.
 *
 * Markup convention (hand-authored/generated reports are expected to follow
 * this; a report that doesn't simply reads as having no post-mortem fields,
 * never thrown): inside `<section id="postmortem">`, a `<ul
 * id="postmortem-what-worked">` and a `<ul id="postmortem-what-didnt">` (one
 * `<li>` per point), and a `<table id="postmortem-rule-283">` with one `<tr
 * data-status="pass"|"fail">` per Rule #283 point (16 total in a settled
 * report).
 * @param {string} html - `sprint-reports/vX.Y.Z/index.html`'s content.
 * @returns {{settled: boolean, postMortem: {whatWorked: string[], whatDidnt: string[], rule283PassCount: number}}}
 */
function parseSprintReportSettlement(html) {
  const text = typeof html === 'string' ? html : '';
  const settled = text.length > 0 && !_reportIsUnsettled(text);
  const postmortemSection = text ? extractSection(text, 'postmortem') : '';
  return {
    settled,
    postMortem: {
      whatWorked: _extractListPoints(postmortemSection, 'postmortem-what-worked'),
      whatDidnt: _extractListPoints(postmortemSection, 'postmortem-what-didnt'),
      rule283PassCount: _extractRule283PassCount(postmortemSection)
    }
  };
}

/**
 * Whether a shipped version's Sprint Report is actually reachable from the
 * public Sprint Reports Hub (#3166) and has settled past the auto-generated
 * live-tracker placeholder (#3175), rather than trusting
 * `roadmap-sync-status.json`'s own `state` at face value. The file can read
 * `state: 'ok'` from an hours-old snapshot taken before the hub was last
 * published or the report settled, exactly the gaps #3166 and #3175 report:
 * a sprint ships, its report directory never gets a permanent
 * `href="./vX.Y.Z/"` link in the hub (or is missing on disk entirely, or
 * still reads as the live tracker), and nothing downstream notices because
 * the status file itself was never told.
 *
 * Fails closed on each signal independently, so a caller cannot get a false
 * "ok" from one check masking a real problem another would have caught:
 * `_syncProblem` for a missing/malformed/non-`'ok'` status file,
 * {@link module:lib/v6/sprint-report-validator-v3.validateHubReportLinks}
 * for the current version's own directory missing from the hub `hubHtml`
 * actually supplies, and (#3175) the report's own HTML for whether it
 * exists on disk at all and has settled -- none of which
 * `roadmap-sync-status.json` can vouch for about ITSELF, since it is the
 * artifact that may be stale, not an independent witness to its own
 * staleness.
 * @param {object} input
 * @param {string|null} [input.currentVersion] - The active/just-shipped
 *   version (e.g. `v6.5.2`) whose report directory must be linked and
 *   settled. No hub or report check runs when omitted -- there is no
 *   version to look for.
 * @param {*} input.syncStatus - Parsed `roadmap-sync-status.json`, or null.
 * @param {string} [input.hubHtml] - The Sprint Reports Hub's `index.html`,
 *   when this call site can read it. No hub check runs when omitted; the
 *   verdict then rests on `syncStatus` (and `reportHtml`, if given) alone,
 *   same as `_syncProblem`.
 * @param {string|null} [input.reportHtml] - The current version's own
 *   `sprint-reports/vX.Y.Z/index.html`, when this call site read it; `null`
 *   when it tried and the file does not exist. No report-settlement check
 *   runs when this key is omitted entirely (#3175) -- a caller that never
 *   mentions it behaves exactly as it did before this field existed.
 * @returns {{state: 'ok'|'degraded', message: (string|null)}}
 */
function validateRoadmapSyncStatus(input) {
  const data = input || {};
  const problem = _syncProblem(data.syncStatus);
  if (problem) {
    return { state: 'degraded', message: `roadmap-sync-status.json ${problem}` };
  }
  if (typeof data.currentVersion === 'string' && data.currentVersion && typeof data.hubHtml === 'string') {
    const dir = `v${data.currentVersion.replace(/^v/, '')}`;
    const linkCheck = validateHubReportLinks(data.hubHtml, [dir]);
    if (!linkCheck.ok) {
      return {
        state: 'degraded',
        message: `roadmap-sync-status.json reports "ok", but the Sprint Reports Hub has no link to ${dir}/ -- `
          + 'the shipped version\'s report is unreachable from the hub despite the status file saying sync is fine'
      };
    }
  }
  if (typeof data.currentVersion === 'string' && data.currentVersion && 'reportHtml' in data) {
    const dir = `v${data.currentVersion.replace(/^v/, '')}`;
    if (typeof data.reportHtml !== 'string') {
      return {
        state: 'degraded',
        message: `roadmap-sync-status.json reports "ok", but sprint-reports/${dir}/index.html is missing -- `
          + 'the shipped version has no Gate 4 post-sprint report on disk at all'
      };
    }
    if (_reportIsUnsettled(data.reportHtml)) {
      return {
        state: 'degraded',
        message: `roadmap-sync-status.json reports "ok", but sprint-reports/${dir}/index.html still carries the `
          + 'auto-generated live-tracker placeholder (AUTO_GENERATED_LIVE_SPRINT_REPORT / LIVE TRACKING) -- '
          + `Gate 4's post-sprint report for ${dir} has not been settled`
      };
    }
  }
  return { state: 'ok', message: null };
}

/**
 * Build the unified Release-First Roadmap / 6-Stage Pill / Sprint & Kaizen
 * Reports snapshot the v6 PM Workspace's `📜 Charter & Roadmap`, `🚂 Sprint &
 * Cars` and `📈 Kaizen & Reports` tabs render natively (#3112), instead of
 * each tab showing bare `v6_wave_runs` rows. Pure, like every other builder
 * in this module: every input is already-resolved data — the roadmap, the
 * active sprint's cars/lanes/PRs, which versions have already shipped, and
 * the reports catalog — assembled by the caller from `roadmap2-data.json`,
 * `.tangleclaw/plans/TangleClaw-Roadmap-2.md`, `LANE_QUEUE.md` and
 * `v6_wave_runs`, never read by this function itself.
 * @param {object} input
 * @param {object} [input.roadmapData] - `{releases: [{version, trains: [{cars}]}],
 *   unversioned_trains, backlog}` — the same shape {@link verifySprintSetupAndRoadmapSync}
 *   and {@link _roadmapPlacements} already read.
 * @param {string} [input.repo] - `owner/name`, when known (#3138) — read from
 *   `roadmapData.repo` by a caller that loaded `roadmap2-data.json`; forwarded
 *   to {@link syncWaveDispatchState} so each car's `prUrl` can be built.
 * @param {string} [input.currentVersion] - The active sprint's version (e.g. `v6.4.1`).
 * @param {string[]} [input.shippedVersions] - Versions already released (e.g. `v6.4.0`, `v6.3.0`).
 * @param {Array<{id: string, version?: string, lane?: string, reviewers?: {oGate?: string, prr?: string},
 *   files?: string[], issues?: Array<{id, state, title?: string, summary?: string,
 *   dependsOn?: string[], deployedNotConfirmed?: boolean}>, deployedNotConfirmed?: boolean}>} [input.cars] -
 *   `version` (e.g. `v6.4.1`) groups a car under its roadmap release in {@link module:public/sprint-wave-ui};
 *   a car with none is still enriched, just not shown under any release's workstream table.
 * @param {Array<{carId: string, name?: string, status?: string, hold?: boolean}>} [input.lanes] -
 *   Passed straight through to {@link syncWaveDispatchState}.
 * @param {Array<{carId: string, number: number, state: string, reviewDecision?: string}>} [input.pullRequests] -
 *   Passed straight through to {@link syncWaveDispatchState}.
 * @param {Array<{id: string, version?: string, title?: string, url?: string,
 *   kind?: ('report'|'retrospective')}>} [input.reports] - The Sprint Reports Hub's catalog.
 * @param {string|null} [input.reportHtml] - Forwarded straight through to
 *   {@link validateRoadmapSyncStatus} (#3175) alongside `hubHtml`; see that
 *   function's own JSDoc for the omitted-vs-`null` distinction.
 * @returns {{releases: {active: object[], planned: object[], shipped: object[]},
 *   summary: {plannedVersions: number, releasedVersions: number,
 *   activeSprintProgress: {closed: number, total: number, pct: number}, scheduledItems: number},
 *   cars: Array<object>, reports: Array<object>}}
 */
function buildSprintWaveSnapshot(input) {
  const data = input || {};
  const roadmapData = data.roadmapData && typeof data.roadmapData === 'object' ? data.roadmapData : { releases: [] };
  const currentVersion = typeof data.currentVersion === 'string' ? data.currentVersion : null;
  const shippedVersions = new Set((Array.isArray(data.shippedVersions) ? data.shippedVersions : [])
    .map((v) => String(v).replace(/^v/, '')));
  const cars = Array.isArray(data.cars) ? data.cars : [];

  const dispatch = syncWaveDispatchState({
    // #3138 (PRR-A R1): confirmedComplete/headSha forwarded too, so a car
    // completed with no PR number recorded still reads merged, and its real
    // head SHA (not just the one on its own enriched-car entry) reaches the
    // gate-staleness check.
    cars: cars.map((c) => ({ id: c.id, issues: c.issues, confirmedComplete: c.confirmedComplete, headSha: c.headSha })),
    lanes: data.lanes,
    pullRequests: data.pullRequests,
    repo: data.repo
  });

  // #3162 (PRR-B R-Gate REVISE, BLOCKING 2): which release versions still
  // have a dispatched car that is not yet closed -- the signal `_releaseStatus`
  // needs to tell a current sprint genuinely still in flight from one that
  // has already shipped (every one of its own cars closed) while
  // `version.json`/`currentVersion` simply hasn't been re-pointed at the
  // next sprint yet.
  const openCarVersions = new Set(
    cars
      .filter((c) => {
        const row = dispatch[c.id];
        return !row || row.stage !== 'closed';
      })
      .map((c) => (typeof c.version === 'string' && c.version ? `v${c.version.replace(/^v/, '')}` : null))
      .filter(Boolean)
  );

  const releaseEntries = (Array.isArray(roadmapData.releases) ? roadmapData.releases : [])
    .filter((r) => r && (typeof r.version === 'string' || typeof r.version === 'number'))
    .map((r) => {
      const trains = Array.isArray(r.trains) ? r.trains : [];
      const carCount = trains.reduce((sum, t) => sum + (Array.isArray(t && t.cars) ? t.cars.length : 0), 0);
      const version = `v${String(r.version).replace(/^v/, '')}`;
      return {
        version,
        status: _releaseStatus(r.version, currentVersion, shippedVersions, openCarVersions.has(version)),
        carCount
      };
    });

  const releases = { active: [], planned: [], shipped: [] };
  for (const entry of releaseEntries) releases[entry.status].push(entry);
  releases.shipped.sort((a, b) => _compareVersions(b.version, a.version));
  releases.planned.sort((a, b) => _compareVersions(a.version, b.version));
  releases.active.sort((a, b) => _compareVersions(a.version, b.version));

  // #3162: a release's own classification (computed above, once, from the
  // same `currentVersion`/`shippedVersions` every real car already uses)
  // is what the FALLBACK rows below must agree with too -- otherwise a
  // shipped version with no dispatched car still renders its synthesized
  // placeholder as "Not started" even though `releases.shipped` already
  // correctly lists the release itself as shipped.
  const releaseStatusByVersion = new Map(releaseEntries.map((r) => [r.version, r.status]));

  const enrichedCars = cars.map((car) => {
    const row = dispatch[car.id] || { stage: 'unassigned', laneName: null, openPrNumber: null };
    const issues = Array.isArray(car.issues) ? car.issues : [];
    return {
      id: car.id,
      // #3163: `carId` alongside `id` -- some consumers key cars by `id`
      // today, a caller following the dispatch's own normalization recipe
      // expects `carId`; both now name the same car rather than making a
      // caller guess which one a given response carries.
      carId: car.id,
      version: typeof car.version === 'string' && car.version ? car.version : null,
      lane: typeof car.lane === 'string' && car.lane ? car.lane : row.laneName,
      branch: typeof car.branch === 'string' && car.branch ? car.branch : null,
      title: typeof car.title === 'string' && car.title ? car.title : null,
      // #3163: the dispatch stage as a bare string, alongside the existing
      // `pill` object -- a caller that wants `car.status` directly (rather
      // than unpacking `pill.code`) is not forced to invent its own mapping.
      status: row.stage,
      reviewers: car.reviewers && typeof car.reviewers === 'object' ? car.reviewers : {},
      files: Array.isArray(car.files) ? car.files : [],
      prNumber: row.openPrNumber,
      prUrl: row.prUrl || null,
      // #3138 (PRR-A R1): carried through so renderSprintCarCards' own
      // carGates(...) call can infer the same merged-aware gate pills the
      // stage board/gate matrix already do, instead of dropping this signal.
      merged: Boolean(row.merged),
      headSha: row.headSha || null,
      pill: sixStagePill(row.stage, Boolean(car.deployedNotConfirmed)),
      // An issue's own pill: `closed` when THIS issue is individually closed
      // (the one per-issue signal this module has), otherwise it inherits
      // its car's current non-closed stage — `syncWaveDispatchState` only
      // ever computes dispatch stage at the car level, never per issue.
      issues: issues.map((issue) => ({
        id: issue && issue.id,
        title: issue && typeof issue.title === 'string' ? issue.title : null,
        summary: issue && typeof issue.summary === 'string' ? issue.summary : null,
        dependsOn: issue && Array.isArray(issue.dependsOn) ? issue.dependsOn : [],
        pill: sixStagePill(
          issue && issue.state === 'closed' ? 'closed' : row.stage,
          Boolean(issue && issue.deployedNotConfirmed)
        )
      }))
    };
  });

  // Active sprint progress counts only the REAL cars a caller supplied, not
  // the fallback rows synthesized below for a release with no matching
  // input car -- a planned/shipped release's placeholder issues are not
  // "the active sprint's own progress."
  const totalIssues = enrichedCars.reduce((sum, c) => sum + c.issues.length, 0);
  const closedIssues = enrichedCars.reduce((sum, c) => sum
    + c.issues.filter((i) => i.pill.code === 'closed' || i.pill.code === 'deployed').length, 0);

  // A release workstream table must not read empty just because the caller
  // supplied no `input.cars` for that version (#3112, PRR-B I-Gate R1
  // WARNING 1): synthesize one fallback row per train that lists real
  // roadmap-placed issues, so a planned/shipped release still shows what
  // the roadmap itself already names, even before any car is dispatched.
  const versionsWithCars = new Set(enrichedCars.map((c) => c.version).filter(Boolean));
  const fallbackCars = [];
  for (const r of Array.isArray(roadmapData.releases) ? roadmapData.releases : []) {
    if (!r || (typeof r.version !== 'string' && typeof r.version !== 'number')) continue;
    const version = `v${String(r.version).replace(/^v/, '')}`;
    if (versionsWithCars.has(version)) continue;
    const trains = Array.isArray(r.trains) ? r.trains : [];
    // #3162: a shipped release with no dispatched car (every car for it was
    // real, but none happened to be in THIS call's `input.cars`, or the
    // version shipped before this tracker ever ran) must synthesize its
    // fallback rows as `closed`/"Completed", never the hardcoded
    // `open`/"Not started" every fallback used to get regardless of the
    // release's own already-correct `releases.shipped` classification --
    // that mismatch (the release card says shipped, every row under it
    // says "Not started") is the exact bug #3162 reports.
    const fallbackPill = releaseStatusByVersion.get(version) === 'shipped'
      ? { code: 'closed', label: 'Completed' }
      : { code: 'open', label: 'Not started' };
    trains.forEach((train, i) => {
      const trainCars = Array.isArray(train && train.cars) ? train.cars : [];
      if (!trainCars.length) return;
      fallbackCars.push({
        id: `${version}-train-${i + 1}`,
        carId: `${version}-train-${i + 1}`,
        version,
        lane: null,
        branch: null,
        title: null,
        status: fallbackPill.code === 'closed' ? 'closed' : 'unassigned',
        reviewers: {},
        files: [],
        prNumber: null,
        pill: fallbackPill,
        issues: trainCars.map((issue) => ({
          id: issue && typeof issue === 'object' ? issue.number : issue,
          title: null, summary: null, dependsOn: [],
          pill: fallbackPill
        }))
      });
    });
  }

  const reports = _normalizeReportsCatalog(data.reports);

  const snapshot = {
    releases,
    summary: {
      plannedVersions: releases.planned.length,
      releasedVersions: releases.shipped.length,
      activeSprintProgress: {
        closed: closedIssues,
        total: totalIssues,
        pct: totalIssues ? Math.round((closedIssues / totalIssues) * 100) : 0
      },
      scheduledItems: releases.active.reduce((sum, r) => sum + r.carCount, 0)
        + releases.planned.reduce((sum, r) => sum + r.carCount, 0)
    },
    cars: enrichedCars.concat(fallbackCars),
    reports
  };
  // #3166: exposed "on ... snapshot" only when a caller actually supplied
  // something to validate -- `input.syncStatus` is the signal (even an
  // explicit `null`, read as "the status file could not be read," counts;
  // only a caller that never mentions it at all gets no field, same as
  // every other optional passthrough in this function).
  if ('syncStatus' in data) {
    const syncInput = { currentVersion, syncStatus: data.syncStatus, hubHtml: data.hubHtml };
    // #3175: forwarded only when the caller actually mentions it, same
    // omitted-vs-`null` convention `reportHtml` itself documents -- a
    // caller that never supplies it gets no report-settlement check, as
    // before #3175 (`validateRoadmapSyncStatus` gates on `'reportHtml' in
    // data`, so passing the key through unconditionally here would be wrong
    // whenever it is `undefined`).
    if ('reportHtml' in data) syncInput.reportHtml = data.reportHtml;
    snapshot.roadmapSyncStatus = validateRoadmapSyncStatus(syncInput);
  }
  return snapshot;
}

module.exports = {
  GUARDRAIL_IDS,
  SETUP_GUARDRAIL_ID,
  RUNTIME_GUARDRAIL_IDS,
  SETUP_VIOLATION_CODES,
  PARALLELISM_VIOLATION_CODES,
  validateVersionPlanParallelism,
  buildRoadmapDataFromFallbackSources,
  verifySprintSetupAndRoadmapSync,
  DISPATCH_STAGES,
  gitLsFilesAt,
  validateWaveDisjointness,
  syncWaveDispatchState,
  buildNativeSprintReportSummary,
  buildConsolidatedTrainReportSummary,
  createFileSnapshotStore,
  syncRoadmapWithBackoff,
  SPRINT_VERSION_RE,
  sprintDataFromWaveRuns,
  SIX_STAGE_PILL_LABELS,
  sixStagePill,
  buildSprintWaveSnapshot,
  parseShippedVersionsFromChangelog,
  validateRoadmapSyncStatus,
  parseSprintReportSettlement
};
