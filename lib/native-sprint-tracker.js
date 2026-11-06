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

/** Guardrail ledger ids this sprint's post-mortem tracks (#2644: "P0..P11"). */
const GUARDRAIL_IDS = Array.from({ length: 12 }, (_, i) => `P${i}`);

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
 * @param {object} input
 * @param {Array<{id: string, issues?: Array<{id, state}>}>} input.cars
 * @param {Array<{carId: string, name?: string, status?: string, hold?: boolean}>} [input.lanes]
 * @param {Array<{carId: string, number: number, state: 'open'|'merged'|'closed',
 *   reviewDecision?: string}>} [input.pullRequests]
 * @returns {Object<string, {stage: string, laneName: (string|null), openPrNumber: (number|null)}>}
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

    result[carId] = {
      stage,
      laneName: lane && typeof lane.name === 'string' ? lane.name : null,
      openPrNumber: openPr ? openPr.number : (mergedPr ? mergedPr.number : null)
    };
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
    disjointness
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

module.exports = {
  GUARDRAIL_IDS,
  DISPATCH_STAGES,
  gitLsFilesAt,
  validateWaveDisjointness,
  syncWaveDispatchState,
  buildNativeSprintReportSummary,
  createFileSnapshotStore,
  syncRoadmapWithBackoff
};
