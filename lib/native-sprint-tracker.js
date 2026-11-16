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
const { validateHubReportLinks, ECONOMICS_FIELDS } = require('./v6/sprint-report-validator-v3');

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
 * @returns {Object<string, {stage: string, laneName: (string|null), openPrNumber: (number|null),
 *   pill: {code: string, label: string}, files?: string[], reviewers?: object,
 *   headSha?: string, issues?: Array<{id, pill: object}>}>}
 */
function syncWaveDispatchState(input) {
  const data = input || {};
  const cars = Array.isArray(data.cars) ? data.cars : null;
  if (!cars) throw new TypeError('syncWaveDispatchState: input.cars must be an array');

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

    const row = {
      stage,
      laneName: lane && typeof lane.name === 'string' ? lane.name : null,
      openPrNumber: openPr ? openPr.number : (mergedPr ? mergedPr.number : null),
      pill: sixStagePill(stage, Boolean(car.deployedNotConfirmed))
    };
    if (Array.isArray(car.files)) row.files = car.files;
    if (car.reviewers && typeof car.reviewers === 'object') row.reviewers = car.reviewers;
    if (typeof car.headSha === 'string' && car.headSha) row.headSha = car.headSha;
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

/** Every violation code {@link verifySprintSetupAndRoadmapSync} can report. */
const SETUP_VIOLATION_CODES = Object.freeze([
  'MISSING_MILESTONE_RELEASE', 'DUPLICATE_ROADMAP_PLACEMENT', 'ROADMAP_SYNC_ERROR', 'UNLINKED_REPORT_DIR'
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
 * runs (#3087, Ruling A774). For `'current'` it reads the most recent active
 * run, else the most recent run, and with no run at all it answers an empty
 * sprint rather than nothing. For a version it reads the run whose
 * `metadata.version` (or id) names it, and answers null when none does, so the
 * route can say 404.
 *
 * Each car keeps its id, waves come from the run, and a lane is the car's
 * assignee (`payload.lane`, `payload.assignee` or `payload.laneName`):
 * `running` and `awaiting-gate` read as committed work, and `gate-held` or
 * `stalled` as a hold. The tracker closes a car only through a merged PR or
 * closed issues, and there is no PR source, so a `complete` or `cancelled`
 * car carries one closed marker issue (its own id) unless its payload lists
 * real issues. Learnings are empty, and releaseCommit is null.
 *
 * Also carries forward (#3112, PRR-B I-Gate R1 BLOCKING 2) every optional
 * field the real `v6_wave_runs` car state and payload can already carry
 * that this function used to silently drop: the run's own resolved
 * `version` (top level, and per car); each car's `fileScope`
 * (`lib/v6/c3-wave-scheduler.js#createRun`'s own top-level field — not
 * nested under `payload`) or `payload.files`; `payload.reviewers`;
 * `payload.headSha`; and `payload.openPrNumber`, synthesized into a
 * `{carId, number, state: 'open'}` `pullRequests` entry so
 * {@link syncWaveDispatchState}'s existing PR-matching logic computes the
 * right stage from it, rather than adding a second, parallel way to say
 * "this car has an open PR."
 * @param {Object<string, object>} runs - `SqliteSchedulerStore#read().runs`.
 * @param {string} version - `'current'` or a version.
 * @returns {object|null}
 */
function sprintDataFromWaveRuns(runs, version) {
  const all = Object.values(runs || {}).filter((r) => r && typeof r === 'object' && r.cars);
  const byNewest = [...all].sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  let run;
  if (version === 'current') {
    run = byNewest.find((r) => r.status === 'active') || byNewest[0];
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
    const done = car.status === 'complete' || car.status === 'cancelled';
    const issues = Array.isArray(payload.issues) ? payload.issues : (done ? [{ id: car.id, state: 'closed' }] : []);
    const entry = { id: car.id, version: resolvedVersion, issues, dispatchedAt: iso(car.startedAt), closedAt: iso(car.completedAt) };
    const name = payload.lane || payload.assignee || payload.laneName;
    if (typeof name === 'string' && name) entry.lane = name;
    const files = Array.isArray(car.fileScope) ? car.fileScope : (Array.isArray(payload.files) ? payload.files : null);
    if (files) entry.files = files;
    if (payload.reviewers && typeof payload.reviewers === 'object') entry.reviewers = payload.reviewers;
    if (typeof payload.headSha === 'string' && payload.headSha) entry.headSha = payload.headSha;
    cars.push(entry);
    if (Number.isInteger(payload.openPrNumber)) pullRequests.push({ carId: car.id, number: payload.openPrNumber, state: 'open' });
    if (typeof name === 'string' && name) {
      lanes.push({
        carId: car.id, name,
        status: car.status === 'running' || car.status === 'awaiting-gate' ? 'committed' : car.status,
        hold: car.status === 'gate-held' || car.status === 'stalled'
      });
    }
  }
  return {
    version: resolvedVersion,
    cars, lanes, pullRequests,
    waves: Array.isArray(run.waves) ? run.waves : [],
    learnings: [], releaseCommit: null
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

/**
 * Classify one roadmap release's version against the sprint's own current
 * version and already-shipped history (#3112): `active` when it names the
 * current sprint, `shipped` when it is already listed among shipped
 * versions, otherwise `planned` — a forecast with no run yet.
 * @param {string|number} version
 * @param {string|null} currentVersion
 * @param {Set<string>} shippedVersions - Bare (no leading `v`) version strings.
 * @returns {'active'|'shipped'|'planned'}
 */
function _releaseStatus(version, currentVersion, shippedVersions) {
  const bare = String(version).replace(/^v/, '');
  if (currentVersion && bare === String(currentVersion).replace(/^v/, '')) return 'active';
  if (shippedVersions.has(bare)) return 'shipped';
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
    cars: cars.map((c) => ({ id: c.id, issues: c.issues })),
    lanes: data.lanes,
    pullRequests: data.pullRequests
  });

  const releaseEntries = (Array.isArray(roadmapData.releases) ? roadmapData.releases : [])
    .filter((r) => r && (typeof r.version === 'string' || typeof r.version === 'number'))
    .map((r) => {
      const trains = Array.isArray(r.trains) ? r.trains : [];
      const carCount = trains.reduce((sum, t) => sum + (Array.isArray(t && t.cars) ? t.cars.length : 0), 0);
      return {
        version: `v${String(r.version).replace(/^v/, '')}`,
        status: _releaseStatus(r.version, currentVersion, shippedVersions),
        carCount
      };
    });

  const releases = { active: [], planned: [], shipped: [] };
  for (const entry of releaseEntries) releases[entry.status].push(entry);
  releases.shipped.sort((a, b) => _compareVersions(b.version, a.version));
  releases.planned.sort((a, b) => _compareVersions(a.version, b.version));
  releases.active.sort((a, b) => _compareVersions(a.version, b.version));

  const enrichedCars = cars.map((car) => {
    const row = dispatch[car.id] || { stage: 'unassigned', laneName: null, openPrNumber: null };
    const issues = Array.isArray(car.issues) ? car.issues : [];
    return {
      id: car.id,
      version: typeof car.version === 'string' && car.version ? car.version : null,
      lane: typeof car.lane === 'string' && car.lane ? car.lane : row.laneName,
      reviewers: car.reviewers && typeof car.reviewers === 'object' ? car.reviewers : {},
      files: Array.isArray(car.files) ? car.files : [],
      prNumber: row.openPrNumber,
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
    trains.forEach((train, i) => {
      const trainCars = Array.isArray(train && train.cars) ? train.cars : [];
      if (!trainCars.length) return;
      fallbackCars.push({
        id: `${version}-train-${i + 1}`,
        version,
        lane: null,
        reviewers: {},
        files: [],
        prNumber: null,
        pill: { code: 'open', label: 'Not started' },
        issues: trainCars.map((issue) => ({
          id: issue && typeof issue === 'object' ? issue.number : issue,
          title: null, summary: null, dependsOn: [],
          pill: { code: 'open', label: 'Not started' }
        }))
      });
    });
  }

  const reports = _normalizeReportsCatalog(data.reports);

  return {
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
}

module.exports = {
  GUARDRAIL_IDS,
  SETUP_GUARDRAIL_ID,
  RUNTIME_GUARDRAIL_IDS,
  SETUP_VIOLATION_CODES,
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
  buildSprintWaveSnapshot
};
