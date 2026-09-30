'use strict';

/**
 * Release-candidate certification: the pure state machine.
 *
 * A release candidate is certified by watching the exact commit run for 72
 * hours of healthy time. This module decides what each observation means and
 * does no I/O: the runner gathers structured observations, the store persists
 * what this module returns, and every rule about what counts lives here, so the
 * rules can be tested without a clock, a server or a disk.
 *
 * The model:
 * - A run is keyed to one 40-character candidate SHA, recorded in a manifest
 *   at admission. Nothing reads main, so later commits are never certified.
 * - Time is earned per interval between consecutive samples. An interval earns
 *   its monotonic duration only when both of its samples are healthy, the same
 *   runner process took them, it is no longer than the manifest's maximum
 *   interval, the server did not restart between them, and wall and
 *   monotonic time agree. A sleeping machine, a stopped runner, a server that
 *   restarted between samples or an unreachable probe therefore extends the
 *   run and never earns time.
 * - Unknown never counts as healthy. A probe that cannot say is an extension,
 *   not a pass.
 * - A hard-fail condition in any sample ends the run in `failed`.
 * - `extended` is not terminal: the next qualifying interval returns the run
 *   to `running`, and earned time is kept. The exception is a run that has
 *   earned its target without meeting the PTY-use target: it stays extended
 *   until that target is met, because more healthy time cannot fix it.
 * - Reaching the target leads to `awaiting-review`, never to `passed`. Only an
 *   operator's acceptance passes a run, because the PTY pool trend is judged by
 *   a person.
 *
 * @module lib/release-certification/state-machine
 */

const {
  SCHEMA, STATES, EXTEND, HARD_FAIL, TRANSITION, REFUSAL,
  CHECK_STATES, CertificationError, isTerminal, priority, transitionAllowed
} = require('./codes');

/**
 * The thresholds a certification is judged by. A manifest may carry different
 * values so a smoke test can compress 72 hours into minutes; `summarize`
 * reports whether a run used these, and only such a run certifies a release.
 * @type {Readonly<Record<string, number>>}
 */
const DEFAULT_THRESHOLDS = Object.freeze({
  targetQualifiedMs: 72 * 60 * 60 * 1000,
  maxIntervalMs: 150 * 1000,
  clockToleranceMs: 5 * 1000,
  ptyMinAttaches: 25,
  ptyMinDetaches: 25,
  ptyMinSpanMs: 6 * 60 * 60 * 1000,
  trendBucketMs: 60 * 60 * 1000
});

/** Pool-use trend points kept in state; an hourly trend fills this in about 83 days. */
const MAX_TREND_POINTS = 2000;

const { SHA_RE, ACTOR_RE, DIGEST_RE, RUN_ID_RE, CHECKS_SOURCES, REPO_RE, TEXT_RE, REQUIRED_CHECKS_SOURCES, isCount: _isCount, validRequiredChecks } = require('./formats');

/**
 * Throw a refusal.
 * @param {string} code - A REFUSAL code
 * @param {string} message - Why
 * @param {object} [details] - Bounded facts
 * @returns {never}
 */
function _refuse(code, message, details) {
  throw new CertificationError(code, message, details);
}

/**
 * Merge and validate manifest thresholds over the defaults.
 * @param {object} [overrides] - Threshold overrides
 * @returns {Record<string, number>} Complete thresholds
 */
function _thresholds(overrides = {}) {
  const out = { ...DEFAULT_THRESHOLDS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULT_THRESHOLDS)) _refuse(REFUSAL.INVALID_MANIFEST, `unknown threshold ${key}`, { field: key });
    if (!Number.isSafeInteger(value) || value <= 0) _refuse(REFUSAL.INVALID_MANIFEST, `threshold ${key} must be a positive integer`, { field: key });
    out[key] = value;
  }
  return out;
}

/**
 * Validate the required-check names a manifest pins.
 * @param {*} checks - Candidate list
 * @returns {string[]} A copy of the list
 */
function _requiredChecks(checks) {
  // An empty list would make the GitHub judgement pass vacuously: a candidate
  // with no required check has nothing that could fail it.
  if (!validRequiredChecks(checks)) _refuse(REFUSAL.INVALID_MANIFEST, 'requiredChecks must name 1 to 64 unique checks', { field: 'requiredChecks' });
  return [...checks];
}

/**
 * Build a manifest: the immutable record of what is being certified and how.
 *
 * Fields a public reader must never see (paths, host, the ttyd pid inside its
 * generation) sit under `private`. Published documents are still built field
 * by field from an allowlist in `scorecard.js`, never by copying this record
 * and dropping that key (ADR 0021).
 *
 * @param {object} input
 * @param {string} input.candidateSha - Exact 40-character lowercase SHA
 * @param {string} input.version - The version.json version the candidate carries
 * @param {string} input.repository - `owner/name` whose checks are judged
 * @param {string[]} input.requiredChecks - Required check names on the candidate
 * @param {string} input.requiredChecksSource - `branch-protection` or `operator`: where they came from
 * @param {number} input.createdAt - Epoch ms
 * @param {string} input.worktreePath - Absolute path of the detached worktree
 * @param {string} input.worktreeId - sha256 of the worktree's real path, which the server reports as its `checkoutId`
 * @param {string} input.ttydGeneration - Owned ttyd generation when the manifest was built (provenance; the run's baseline is the admission sample's, kept in its state)
 * @param {string} input.runId - 32 hex characters the host minted for this run; every host verdict is bound to it
 * @param {string} [input.checksSource] - `gh` (the runner reads GitHub itself) or `host-attested` (a host control plane answers each sample; the runner has no GitHub access)
 * @param {string|null} [input.checksExchange] - Host-attested: the absolute directory requests and verdicts pass through; pinned so a later `run` cannot point elsewhere
 * @param {string|null} [input.isolationProducer] - Host-attested: the absolute path of the program that attests the guest's network isolation (Chunk 1's `guest-setup.sh`); pinned for the same reason
 * @param {string} [input.host] - Host name the run is on
 * @param {boolean} [input.publishActor] - Whether operator ids appear publicly (default true)
 * @param {string|null} [input.publishRemote] - Where this run publishes; pinned so it can never move
 * @param {object} [input.thresholds] - Threshold overrides (smoke tests only)
 * @returns {object} The manifest
 */
function buildManifest(input) {
  const { candidateSha, version, repository, requiredChecks, requiredChecksSource, createdAt, worktreePath, worktreeId, ttydGeneration, runId, checksSource = 'gh', checksExchange = null, isolationProducer = null, host = null, thresholds, publishActor = true, publishRemote = null } = input || {};
  if (typeof candidateSha !== 'string' || !SHA_RE.test(candidateSha)) _refuse(REFUSAL.INVALID_MANIFEST, 'candidateSha must be 40 lowercase hex characters', { field: 'candidateSha' });
  if (typeof version !== 'string' || !TEXT_RE.test(version)) _refuse(REFUSAL.INVALID_MANIFEST, 'version is required', { field: 'version' });
  if (typeof repository !== 'string' || !REPO_RE.test(repository)) _refuse(REFUSAL.INVALID_MANIFEST, 'repository must be owner/name', { field: 'repository' });
  if (!REQUIRED_CHECKS_SOURCES.includes(requiredChecksSource)) _refuse(REFUSAL.INVALID_MANIFEST, 'requiredChecksSource must be branch-protection or operator', { field: 'requiredChecksSource' });
  if (!_isCount(createdAt)) _refuse(REFUSAL.INVALID_MANIFEST, 'createdAt must be epoch ms', { field: 'createdAt' });
  if (typeof worktreePath !== 'string' || !worktreePath.startsWith('/')) _refuse(REFUSAL.INVALID_MANIFEST, 'worktreePath must be absolute', { field: 'worktreePath' });
  if (typeof worktreeId !== 'string' || !DIGEST_RE.test(worktreeId)) _refuse(REFUSAL.INVALID_MANIFEST, 'worktreeId must be a sha256 hex digest', { field: 'worktreeId' });
  if (typeof ttydGeneration !== 'string' || !TEXT_RE.test(ttydGeneration)) _refuse(REFUSAL.INVALID_MANIFEST, 'ttydGeneration is required', { field: 'ttydGeneration' });
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) _refuse(REFUSAL.INVALID_MANIFEST, 'runId must be 32 lowercase hex characters minted by the host', { field: 'runId' });
  if (!CHECKS_SOURCES.includes(checksSource)) _refuse(REFUSAL.INVALID_MANIFEST, `checksSource must be one of ${CHECKS_SOURCES.join(', ')}`, { field: 'checksSource' });
  const exchangeValid = typeof checksExchange === 'string' && checksExchange.startsWith('/') && TEXT_RE.test(checksExchange);
  // A guest (a host-attested run) publishes only to a local bare repository;
  // the host relays what it published. An absolute path is the only form git
  // cannot turn into a network transport: a URL, `file://` and `host:path`
  // are all refused.
  // A guest's isolation is attested at admission and at every sample (A43,
  // A44); a run on a host has no such boundary to attest.
  const isolation = checksSource === 'host-attested' ? 'attested' : 'none';
  const producerValid = typeof isolationProducer === 'string' && isolationProducer.startsWith('/') && TEXT_RE.test(isolationProducer);
  if (isolation === 'attested' ? !producerValid : isolationProducer !== null) {
    _refuse(REFUSAL.INVALID_MANIFEST, 'isolationProducer is an absolute path for a host-attested run, and absent otherwise', { field: 'isolationProducer' });
  }
  if (checksSource === 'host-attested' && !(typeof publishRemote === 'string' && publishRemote.startsWith('/') && TEXT_RE.test(publishRemote))) {
    _refuse(REFUSAL.INVALID_MANIFEST, 'a host-attested run publishes only to a local bare repository, named by an absolute path', { field: 'publishRemote' });
  }
  if (checksSource === 'host-attested' ? !exchangeValid : checksExchange !== null) {
    _refuse(REFUSAL.INVALID_MANIFEST, 'checksExchange is an absolute directory for a host-attested run, and absent otherwise', { field: 'checksExchange' });
  }
  if (host !== null && (typeof host !== 'string' || !TEXT_RE.test(host))) _refuse(REFUSAL.INVALID_MANIFEST, 'host must be a name', { field: 'host' });
  if (typeof publishActor !== 'boolean') _refuse(REFUSAL.INVALID_MANIFEST, 'publishActor must be true or false', { field: 'publishActor' });
  if (publishRemote !== null && (typeof publishRemote !== 'string' || !/^[^\u0000-\u001f]{1,2048}$/.test(publishRemote))) _refuse(REFUSAL.INVALID_MANIFEST, 'publishRemote must be a URL or path', { field: 'publishRemote' });
  return {
    schema: SCHEMA,
    candidateSha,
    version,
    repository,
    requiredChecks: _requiredChecks(requiredChecks),
    requiredChecksSource,
    runId,
    checksSource,
    isolation,
    // The run's baseline (ttyd generation, and in a guest its boot identity
    // and isolation attestations) is what the admission sample observes,
    // recorded in the run's state. What `private.baseline` holds is only what
    // was seen when this manifest was staged.
    baselineSource: 'admission',
    thresholds: _thresholds(thresholds),
    publishActor,
    createdAt,
    private: { worktreePath, worktreeId, host, publishRemote, checksExchange, isolationProducer, baseline: { ttydGeneration } }
  };
}

/**
 * Whether a manifest judges by the default thresholds, and so can certify a release.
 * @param {object} manifest - A manifest
 * @returns {boolean} True when every threshold equals its default
 */
function isCanonical(manifest) {
  return Object.entries(DEFAULT_THRESHOLDS).every(([k, v]) => manifest.thresholds[k] === v);
}

/**
 * Validate a sample's envelope. Observation contents are judged by `classify`,
 * where a malformed field is an unknown, not an error: probes fail in the field.
 * @param {*} sample - Candidate sample
 * @returns {void}
 */
function _validateSample(sample) {
  if (!sample || typeof sample !== 'object') _refuse(REFUSAL.INVALID_SAMPLE, 'sample must be an object');
  if (!_isCount(sample.wallAt)) _refuse(REFUSAL.INVALID_SAMPLE, 'wallAt must be epoch ms', { field: 'wallAt' });
  if (typeof sample.monoAt !== 'number' || !Number.isFinite(sample.monoAt) || sample.monoAt < 0) _refuse(REFUSAL.INVALID_SAMPLE, 'monoAt must be a monotonic ms reading', { field: 'monoAt' });
  if (typeof sample.runnerInstance !== 'string' || !TEXT_RE.test(sample.runnerInstance)) _refuse(REFUSAL.INVALID_SAMPLE, 'runnerInstance is required', { field: 'runnerInstance' });
  if (!sample.observations || typeof sample.observations !== 'object') _refuse(REFUSAL.INVALID_SAMPLE, 'observations must be an object', { field: 'observations' });
}

/**
 * A reason record.
 * @param {string} code - An EXTEND or HARD_FAIL code
 * @param {string} probe - The probe it came from
 * @param {object} [extra] - Bounded detail (`field` or `check`)
 * @returns {{code: string, probe: string}} The reason
 */
function _reason(code, probe, extra = {}) {
  return { code, probe, ...extra };
}

/**
 * Judge the worktree observation: the candidate itself.
 * @param {object|null} o - `{headSha, detached, dirty}`
 * @param {object} manifest - The manifest
 * @param {object} out - `{hardFails, extends}` accumulator
 * @returns {void}
 */
function _judgeWorktree(o, manifest, out) {
  const unknown = (field) => out.extends.push(_reason(EXTEND.PROBE_UNKNOWN, 'worktree', { field }));
  if (!o) return unknown('*');
  if (typeof o.headSha !== 'string') unknown('headSha');
  else if (o.headSha !== manifest.candidateSha) out.hardFails.push(_reason(HARD_FAIL.HEAD_DRIFT, 'worktree'));
  if (o.detached === false) out.hardFails.push(_reason(HARD_FAIL.WORKTREE_NOT_DETACHED, 'worktree'));
  else if (o.detached !== true) unknown('detached');
  if (o.dirty === true) out.hardFails.push(_reason(HARD_FAIL.WORKTREE_DIRTY, 'worktree'));
  else if (o.dirty !== false) unknown('dirty');
}

/**
 * Judge the server observation: the runtime claiming to be the candidate.
 *
 * The server must be running out of the certified worktree itself, which it
 * proves by reporting the same `checkoutId` (sha256 of its checkout's real
 * path) that admission recorded; otherwise the worktree's checks describe a
 * tree the server is not using. Only a SHA the server captured at boot proves
 * what it runs; one it adopted later is unproven, whatever its value. And the
 * server's checkout on disk must still be the candidate: a stale server is
 * running code its own checkout no longer holds, and would load something
 * else on its next restart.
 *
 * @param {object|null} o - `{checkoutId, startupSha, shaBaselineSource, currentDiskSha, isStale, runningVersion, startedAt}`
 * @param {object} manifest - The manifest
 * @param {object} out - Accumulator
 * @returns {void}
 */
function _judgeServer(o, manifest, out) {
  const unknown = (field) => out.extends.push(_reason(EXTEND.PROBE_UNKNOWN, 'server', { field }));
  if (!o) return unknown('*');
  if (typeof o.checkoutId !== 'string') unknown('checkoutId');
  else if (o.checkoutId !== manifest.private.worktreeId) out.hardFails.push(_reason(HARD_FAIL.SERVER_NOT_IN_WORKTREE, 'server'));
  if (o.isStale === true || (typeof o.currentDiskSha === 'string' && o.currentDiskSha !== manifest.candidateSha)) {
    out.hardFails.push(_reason(HARD_FAIL.RUNTIME_CHECKOUT_DRIFT, 'server'));
  } else if (o.isStale !== false) unknown('isStale');
  else if (typeof o.currentDiskSha !== 'string') unknown('currentDiskSha');
  if (o.shaBaselineSource !== 'startup') out.extends.push(_reason(EXTEND.RUNTIME_UNPROVEN, 'server'));
  else if (typeof o.startupSha !== 'string') unknown('startupSha');
  else if (o.startupSha !== manifest.candidateSha) out.hardFails.push(_reason(HARD_FAIL.RUNTIME_SHA_MISMATCH, 'server'));
  if (typeof o.runningVersion !== 'string') unknown('runningVersion');
  else if (o.runningVersion !== manifest.version) out.hardFails.push(_reason(HARD_FAIL.VERSION_MISMATCH, 'server'));
  if (!_isCount(o.startedAt)) unknown('startedAt');
}

/**
 * The server process a sample observed, identified by its start time.
 * @param {object} sample - A sample
 * @returns {number|null} Server start epoch ms, or null when not observed
 */
function _serverInstance(sample) {
  const server = sample.observations.server;
  return server && _isCount(server.startedAt) ? server.startedAt : null;
}

/**
 * Judge the owned-ttyd observation.
 * @param {object|null} o - `{applicable, managed, generation, leakState, wedgedCount, orphanGate}`; `applicable: false` means this platform has no owned ttyd to certify
 * @param {string} baseline - The run's ttyd generation baseline
 * @param {object} out - Accumulator
 * @returns {void}
 */
function _judgeTtyd(o, baseline, out) {
  const unknown = (field) => out.extends.push(_reason(EXTEND.PROBE_UNKNOWN, 'ttyd', { field }));
  const fail = (code) => out.hardFails.push(_reason(code, 'ttyd'));
  if (!o) return unknown('*');
  if (o.applicable === false) return fail(HARD_FAIL.TTYD_NOT_APPLICABLE);
  if (o.managed === false) fail(HARD_FAIL.TTYD_NOT_OWNED);
  else if (o.managed !== true) unknown('managed');
  if (typeof o.generation !== 'string') unknown('generation');
  else if (o.generation !== baseline) fail(HARD_FAIL.TTYD_GENERATION_CHANGED);
  if (o.leakState === 'fired') fail(HARD_FAIL.LEAK_FIRED);
  else if (o.leakState !== 'clear') unknown('leakState');
  if (!_isCount(o.wedgedCount)) unknown('wedgedCount');
  else if (o.wedgedCount > 0) fail(HARD_FAIL.WEDGED_CHILD);
  if (o.orphanGate === true) fail(HARD_FAIL.ORPHAN_GATE);
  else if (o.orphanGate !== false) unknown('orphanGate');
}

/**
 * Judge the GitHub observation. Only the checks the manifest pinned as
 * required matter, and only on the candidate SHA the probe was asked about.
 * @param {object|null} o - `{state: 'ok'|'unavailable', checks: {[name]: CHECK_STATES}}`
 * @param {object} manifest - The manifest
 * @param {object} out - Accumulator
 * @returns {void}
 */
function _judgeGithub(o, manifest, out) {
  if (!o || o.state !== 'ok' || !o.checks || typeof o.checks !== 'object') {
    out.extends.push(_reason(EXTEND.GITHUB_UNAVAILABLE, 'github'));
    return;
  }
  for (const check of manifest.requiredChecks) {
    const state = CHECK_STATES.includes(o.checks[check]) ? o.checks[check] : 'missing';
    if (state === 'failure') out.hardFails.push(_reason(HARD_FAIL.REQUIRED_CHECK_FAILED, 'github', { check }));
    else if (state !== 'success') out.extends.push(_reason(EXTEND.CHECKS_PENDING, 'github', { check }));
  }
}

/**
 * Whether a PTY-activity observation is well formed.
 * @param {*} o - `{instance, attaches, detaches, lastAt}`
 * @returns {boolean} True when usable
 */
function _ptyObservationValid(o) {
  return Boolean(o) && typeof o.instance === 'string' && TEXT_RE.test(o.instance)
    && _isCount(o.attaches) && _isCount(o.detaches)
    && (o.lastAt === null || _isCount(o.lastAt));
}

/**
 * Judge the guest's isolation, when the manifest requires it attested. An
 * unattested sample earns nothing; a breach, a reboot (a boot identity other
 * than the admission's) or a packet filter that changed ends the run, since
 * none of them can be undone in place (A43, A44, A47).
 * @param {object|null} o - `{state, bootId, rulesetSha256, adminDigest, workloadDigest}`
 * @param {object} manifest - The manifest
 * @param {object} baseline - The run's baseline
 * @param {object} out - Accumulator
 * @returns {void}
 */
function _judgeIsolation(o, manifest, baseline, out) {
  if (manifest.isolation !== 'attested') return;
  if (!o || o.state === 'unavailable' || (o.state !== 'ok' && o.state !== 'breached')) {
    out.extends.push(_reason(EXTEND.ISOLATION_UNATTESTED, 'isolation'));
    return;
  }
  if (o.state === 'breached') out.hardFails.push(_reason(HARD_FAIL.ISOLATION_BREACHED, 'isolation'));
  if (typeof baseline.bootId === 'string' && o.bootId !== baseline.bootId) out.hardFails.push(_reason(HARD_FAIL.BOOT_CHANGED, 'isolation'));
  // A measured-breach envelope carries no ruleset, so only a healthy or
  // breached pair is compared with the baseline's.
  if (typeof baseline.rulesetSha256 === 'string' && typeof o.rulesetSha256 === 'string' && o.rulesetSha256 !== baseline.rulesetSha256) {
    out.hardFails.push(_reason(HARD_FAIL.ISOLATION_CHANGED, 'isolation'));
  }
}

/**
 * Judge every observation in a sample against the manifest.
 * @param {object} manifest - The manifest
 * @param {object} observations - `{worktree, server, ttyd, github, pty}`
 * @param {object|string} [baseline] - The run's baseline (`{ttydGeneration, bootId, rulesetSha256}`), or just its ttyd generation (default: the manifest's)
 * @returns {{hardFails: object[], extends: object[]}} Reasons, each list in priority order
 */
function classify(manifest, observations, baseline = manifest.private.baseline.ttydGeneration) {
  const b = typeof baseline === 'string' || baseline === null ? { ttydGeneration: baseline } : baseline;
  const ttydBaseline = b.ttydGeneration;
  const out = { hardFails: [], extends: [] };
  _judgeIsolation(observations.isolation, manifest, b, out);
  _judgeWorktree(observations.worktree, manifest, out);
  _judgeServer(observations.server, manifest, out);
  _judgeTtyd(observations.ttyd, ttydBaseline, out);
  _judgeGithub(observations.github, manifest, out);
  if (!_ptyObservationValid(observations.pty)) out.extends.push(_reason(EXTEND.PROBE_UNKNOWN, 'pty', { field: '*' }));
  out.hardFails.sort((a, b) => priority(HARD_FAIL, a.code) - priority(HARD_FAIL, b.code));
  out.extends.sort((a, b) => priority(EXTEND, a.code) - priority(EXTEND, b.code));
  return out;
}

/**
 * Start PTY accounting at admission. Events the server counted before the
 * run began are the baseline, not evidence.
 * @param {object} o - A valid PTY observation
 * @returns {object} PTY state
 */
function _initPty(o) {
  return {
    instance: o.instance,
    baseAttaches: o.attaches,
    baseDetaches: o.detaches,
    rawAttaches: o.attaches,
    rawDetaches: o.detaches,
    carriedAttaches: 0,
    carriedDetaches: 0,
    attaches: 0,
    detaches: 0,
    firstEventAt: null,
    lastEventAt: null
  };
}

/**
 * Fold a PTY observation into PTY state.
 *
 * The server's counters live in memory and restart from zero with it, so a new
 * server instance carries the totals already seen and counts from zero. A
 * counter that goes backwards within one instance is not believed.
 *
 * Event times are conservative: the first event is dated by the server's
 * latest event when an increase is first seen, which is no earlier than the
 * real first event, so the measured span never exceeds the true one.
 *
 * @param {object} p - PTY state (mutated)
 * @param {object} o - A PTY observation
 * @param {number} wallAt - The sample's wall time
 * @returns {void}
 */
function _foldPty(p, o, wallAt) {
  if (!_ptyObservationValid(o)) return;
  if (o.instance !== p.instance) {
    p.instance = o.instance;
    p.carriedAttaches = p.attaches;
    p.carriedDetaches = p.detaches;
    p.baseAttaches = 0;
    p.baseDetaches = 0;
  } else if (o.attaches < p.rawAttaches || o.detaches < p.rawDetaches) {
    return;
  }
  p.rawAttaches = o.attaches;
  p.rawDetaches = o.detaches;
  const attaches = p.carriedAttaches + o.attaches - p.baseAttaches;
  const detaches = p.carriedDetaches + o.detaches - p.baseDetaches;
  if (attaches + detaches > p.attaches + p.detaches) {
    const eventAt = o.lastAt === null ? wallAt : Math.min(o.lastAt, wallAt);
    if (p.firstEventAt === null) p.firstEventAt = eventAt;
    p.lastEventAt = Math.max(p.lastEventAt ?? eventAt, eventAt);
  }
  p.attaches = attaches;
  p.detaches = detaches;
}

/**
 * Whether the PTY-use target is met.
 * @param {object} p - PTY state
 * @param {object} t - Thresholds
 * @returns {boolean} True when attaches, detaches and span all reach their minimums
 */
function ptyTargetMet(p, t) {
  return p.attaches >= t.ptyMinAttaches && p.detaches >= t.ptyMinDetaches
    && p.firstEventAt !== null && p.lastEventAt - p.firstEventAt >= t.ptyMinSpanMs;
}

/**
 * Add a pool-use trend point when a bucket has passed since the last one.
 * @param {object[]} trend - Trend points (mutated)
 * @param {object|null} ttyd - The ttyd observation
 * @param {number} wallAt - Sample wall time
 * @param {object} t - Thresholds
 * @returns {void}
 */
function _foldTrend(trend, ttyd, wallAt, t) {
  if (!ttyd || !_isCount(ttyd.poolUsed)) return;
  const last = trend[trend.length - 1];
  if (last && wallAt - last.at < t.trendBucketMs) return;
  trend.push({ at: wallAt, used: ttyd.poolUsed });
  if (trend.length > MAX_TREND_POINTS) trend.shift();
}

/**
 * Judge the interval between the previous sample and this one.
 *
 * Monotonic time is only comparable within one runner process, so a new
 * runner is a gap whatever the clocks say. Within one runner, wall time
 * running ahead of monotonic time means the machine slept; behind it means the
 * wall clock was stepped. A server whose start time changed restarted inside
 * the interval, however quickly it came back, so the interval earns nothing.
 *
 * @param {object} prev - `state.lastSample`
 * @param {object} sample - The new sample
 * @param {object[]} sampleExtends - The new sample's own extend reasons
 * @param {object} t - Thresholds
 * @returns {{qualifies: boolean, reasons: object[], wallDelta: number, monoDelta: number|null}} Verdict
 */
function assessInterval(prev, sample, sampleExtends, t) {
  const reasons = [];
  const wallDelta = sample.wallAt - prev.wallAt;
  let monoDelta = null;
  if (prev.runnerInstance !== sample.runnerInstance) {
    reasons.push(_reason(EXTEND.MONITOR_GAP, 'runner'));
  } else {
    monoDelta = sample.monoAt - prev.monoAt;
    if (monoDelta <= 0) _refuse(REFUSAL.INVALID_SAMPLE, 'monotonic time did not advance', { field: 'monoAt' });
    const skew = wallDelta - monoDelta;
    if (skew > t.clockToleranceMs) reasons.push(_reason(EXTEND.SLEEP_DETECTED, 'clock'));
    else if (skew < -t.clockToleranceMs) reasons.push(_reason(EXTEND.CLOCK_SKEW, 'clock'));
    if (monoDelta > t.maxIntervalMs) reasons.push(_reason(EXTEND.INTERVAL_TOO_LONG, 'clock'));
  }
  const serverNow = _serverInstance(sample);
  if (prev.serverInstance !== null && serverNow !== null && serverNow !== prev.serverInstance) {
    reasons.push(_reason(EXTEND.SERVER_RESTARTED, 'server'));
  }
  reasons.push(...sampleExtends);
  if (reasons.length === 0 && prev.extendCodes.length > 0) reasons.push(_reason(prev.extendCodes[0], 'prior-sample'));
  reasons.sort((a, b) => priority(EXTEND, a.code) - priority(EXTEND, b.code));
  return { qualifies: reasons.length === 0, reasons, wallDelta, monoDelta };
}

/**
 * The last-sample record kept in state.
 * @param {number} seq - Sample sequence number
 * @param {object} sample - The sample
 * @param {object[]} sampleExtends - Its extend reasons
 * @returns {object} Record
 */
function _lastSample(seq, sample, sampleExtends) {
  return {
    seq,
    wallAt: sample.wallAt,
    monoAt: sample.monoAt,
    runnerInstance: sample.runnerInstance,
    serverInstance: _serverInstance(sample),
    extendCodes: sampleExtends.map((r) => r.code)
  };
}

/**
 * A transition event.
 * @param {string} from - Previous state
 * @param {string} to - New state
 * @param {string} code - Why
 * @param {number} at - Epoch ms
 * @param {number|null} sampleSeq - The sample that caused it, if any
 * @returns {object} Event
 */
function _transition(from, to, code, at, sampleSeq) {
  // The table in codes.js is what published history is verified against; a
  // transition it does not allow is a bug here, and must never be recorded.
  if (!transitionAllowed(from, to, code)) throw new Error(`illegal transition ${from} -> ${to} (${code})`);
  return { type: 'transition', from, to, code, at, sampleSeq };
}

/**
 * Admit a candidate: the first sample must be fully healthy. A hard-fail
 * condition, an unproven runtime, a required check not yet green, or any
 * unknown refuses admission, and nothing about the run exists yet.
 * @param {object} manifest - The manifest
 * @param {object} sample - The admission sample
 * @returns {{state: object, events: object[]}} Initial running state and its event
 */
function admit(manifest, sample) {
  _validateSample(sample);
  // The admission record publishes `createdAt` as `admittedAt`, and a run
  // cannot have started before it was admitted.
  if (sample.wallAt < manifest.createdAt) _refuse(REFUSAL.INVALID_SAMPLE, 'admission sample predates the manifest', { field: 'wallAt' });
  // The run's ttyd baseline is the generation this sample observes, not the
  // one recorded when the manifest was staged: a retry after a crash (or a
  // reboot) between publishing the admission and committing the run reuses
  // that public manifest, and must not be refused for a ttyd that changed
  // before the run existed (ADR 0021 point 3). A generation that is not
  // known still refuses, as unknown.
  const observed = sample.observations.ttyd && typeof sample.observations.ttyd.generation === 'string' ? sample.observations.ttyd.generation : null;
  const iso = sample.observations.isolation;
  const isolated = manifest.isolation === 'attested' && iso && iso.state === 'ok';
  // Written once, with the run, from this sample alone (A47): the ttyd
  // generation and, in a guest, the boot identity and the two isolation
  // attestations. Nothing later rewrites it; a change fails the run.
  const baseline = {
    source: 'admission',
    ttydGeneration: observed,
    bootId: isolated ? iso.bootId : null,
    rulesetSha256: isolated ? iso.rulesetSha256 : null,
    adminDigest: isolated ? iso.adminDigest : null,
    workloadDigest: isolated ? iso.workloadDigest : null
  };
  const verdict = classify(manifest, sample.observations, { ...baseline, ttydGeneration: observed ?? manifest.private.baseline.ttydGeneration });
  const codes = [...verdict.hardFails, ...verdict.extends];
  if (codes.length > 0) {
    _refuse(REFUSAL.ADMISSION_REFUSED, `admission refused: ${codes[0].code}`, { reasons: codes });
  }
  const state = {
    schema: SCHEMA,
    candidateSha: manifest.candidateSha,
    state: STATES.RUNNING,
    startedAt: sample.wallAt,
    updatedAt: sample.wallAt,
    sampleCount: 1,
    lastSample: _lastSample(1, sample, []),
    baseline,
    qualifiedMs: 0,
    extensions: {},
    failure: null,
    pty: _initPty(sample.observations.pty),
    poolUsedTrend: [],
    acceptance: null,
    cancellation: null
  };
  _foldTrend(state.poolUsedTrend, sample.observations.ttyd, sample.wallAt, manifest.thresholds);
  return { state, events: [_transition(STATES.NOT_STARTED, STATES.RUNNING, TRANSITION.ADMITTED, sample.wallAt, 1)] };
}

/**
 * Record wall time an interval did not earn.
 * @param {object} extensions - `state.extensions` (mutated)
 * @param {string} code - The interval's primary reason
 * @param {number} lostMs - Wall time the interval spent without earning it
 * @returns {void}
 */
function _recordExtension(extensions, code, lostMs) {
  const entry = extensions[code] || (extensions[code] = { intervals: 0, lostMs: 0 });
  entry.intervals += 1;
  entry.lostMs += Math.max(0, lostMs);
}

/**
 * Decide the live state after an interval, and account its time.
 *
 * Earned time stops at the target. Past it, a healthy interval spent waiting
 * for the PTY-use target is recorded as extension time instead, so qualified
 * and extension time together never exceed the time that passed. Review
 * begins only on a qualifying interval: a sample that cannot vouch for the
 * candidate never hands it to a person.
 *
 * @param {object} next - State being built (mutated)
 * @param {object} interval - `assessInterval` verdict
 * @param {object} t - Thresholds
 * @param {number} wallGain - How far this interval moved `updatedAt`
 * @returns {{to: string, code: string}} Target state and why
 */
function _advanceLive(next, interval, t, wallGain) {
  if (!interval.qualifies) {
    _recordExtension(next.extensions, interval.reasons[0].code, interval.wallDelta);
    return { to: STATES.EXTENDED, code: interval.reasons[0].code };
  }
  // Earned time is also bounded by how far the published time moved, so
  // qualified time can never exceed `updatedAt - startedAt`. Monotonic time
  // may run ahead of the wall clock within the skew tolerance, and a wall
  // clock stepped back re-covers time already counted; either way the
  // verifier would rightly read the excess as time that never passed.
  const earned = Math.min(interval.monoDelta, wallGain, t.targetQualifiedMs - next.qualifiedMs);
  next.qualifiedMs += earned;
  if (next.qualifiedMs < t.targetQualifiedMs) return { to: STATES.RUNNING, code: TRANSITION.RECOVERED };
  if (ptyTargetMet(next.pty, t)) return { to: STATES.AWAITING_REVIEW, code: TRANSITION.TARGET_REACHED };
  _recordExtension(next.extensions, EXTEND.PTY_TARGET_UNMET, interval.wallDelta - earned);
  return { to: STATES.EXTENDED, code: EXTEND.PTY_TARGET_UNMET };
}

/**
 * Fold one sample into a certification.
 * @param {object} state - Current state (not mutated)
 * @param {object} manifest - The manifest
 * @param {object} sample - The new sample
 * @returns {{state: object, events: object[], verdict: object, interval: object}} Next state, transition events, and what was judged
 */
function reduce(state, manifest, sample) {
  _validateSample(sample);
  if (isTerminal(state.state)) _refuse(REFUSAL.ALREADY_TERMINAL, `run is ${state.state}`, { state: state.state });
  if (state.state === STATES.NOT_STARTED) _refuse(REFUSAL.INVALID_SAMPLE, 'admit the candidate first', { state: state.state });
  const t = manifest.thresholds;
  const seq = state.sampleCount + 1;
  const verdict = classify(manifest, sample.observations, state.baseline);
  const interval = assessInterval(state.lastSample, sample, verdict.extends, t);
  const next = structuredClone(state);
  next.sampleCount = seq;
  // Never backwards: a stepped wall clock is judged as CLOCK_SKEW and the run
  // goes on, but the time it publishes must not regress, or the history of
  // its public scorecard would carry a regression nothing could remove.
  next.updatedAt = Math.max(state.updatedAt, sample.wallAt);
  next.lastSample = _lastSample(seq, sample, verdict.extends);
  _foldPty(next.pty, sample.observations.pty, sample.wallAt);
  _foldTrend(next.poolUsedTrend, sample.observations.ttyd, sample.wallAt, t);

  let move = null;
  if (verdict.hardFails.length > 0) {
    next.failure = { code: verdict.hardFails[0].code, reasons: verdict.hardFails, at: next.updatedAt, sampleSeq: seq };
    move = { to: STATES.FAILED, code: verdict.hardFails[0].code };
  } else if (state.state !== STATES.AWAITING_REVIEW) {
    move = _advanceLive(next, interval, t, next.updatedAt - state.updatedAt);
  }
  const events = [];
  if (move && move.to !== state.state) {
    next.state = move.to;
    // Stamped with the clamped time, so the published log never goes back
    // either, and every line falls within `[startedAt, updatedAt]`.
    events.push(_transition(state.state, move.to, move.code, next.updatedAt, seq));
  }
  return { state: next, events, verdict, interval };
}

/**
 * Validate an operator identity.
 * @param {*} actor - Candidate actor
 * @returns {void}
 */
function _validateActor(actor) {
  if (typeof actor !== 'string' || !ACTOR_RE.test(actor)) _refuse(REFUSAL.INVALID_ACTOR, 'actor must be an identifier');
}

/**
 * Accept a run that reached its target: the only way to `passed`. A run
 * judged by thresholds other than the canonical ones (a compressed smoke run)
 * can reach review but never pass, so `passed` always means a real
 * certification.
 * @param {object} state - Current state (not mutated)
 * @param {string} actor - Who accepted it
 * @param {number} at - Epoch ms
 * @param {object} manifest - The run's manifest
 * @returns {{state: object, events: object[]}} Passed state and its event
 */
function accept(state, actor, at, manifest) {
  _validateActor(actor);
  if (isTerminal(state.state)) _refuse(REFUSAL.ALREADY_TERMINAL, `run is ${state.state}`, { state: state.state });
  if (state.state !== STATES.AWAITING_REVIEW) _refuse(REFUSAL.NOT_AWAITING_REVIEW, `run is ${state.state}`, { state: state.state });
  if (!manifest || !isCanonical(manifest)) _refuse(REFUSAL.NOT_CANONICAL, 'a run judged by non-canonical thresholds cannot pass', { state: state.state });
  const next = structuredClone(state);
  next.state = STATES.PASSED;
  next.updatedAt = Math.max(state.updatedAt, at);
  // A decision is never recorded before the history it decides on: a clock
  // behind the last sample stamps it at the run's time instead.
  next.acceptance = { actor, at: next.updatedAt };
  return { state: next, events: [_transition(state.state, STATES.PASSED, TRANSITION.OPERATOR_ACCEPTED, next.updatedAt, null)] };
}

/**
 * Cancel a live run.
 * @param {object} state - Current state (not mutated)
 * @param {string} actor - Who cancelled it
 * @param {number} at - Epoch ms
 * @returns {{state: object, events: object[]}} Cancelled state and its event
 */
function cancel(state, actor, at) {
  _validateActor(actor);
  if (isTerminal(state.state)) _refuse(REFUSAL.ALREADY_TERMINAL, `run is ${state.state}`, { state: state.state });
  const next = structuredClone(state);
  next.state = STATES.CANCELLED;
  next.updatedAt = Math.max(state.updatedAt, at);
  next.cancellation = { actor, at: next.updatedAt };
  return { state: next, events: [_transition(state.state, STATES.CANCELLED, TRANSITION.OPERATOR_CANCELLED, next.updatedAt, null)] };
}

/**
 * The structured health of a run: what the CLI prints and the scorecard and
 * registry cards read. Times are epoch ms in UTC; rendering them in a time
 * zone is the reader's job.
 * @param {object} state - Current state
 * @param {object} manifest - The manifest
 * @param {number} now - Epoch ms
 * @returns {object} Summary
 */
function summarize(state, manifest, now) {
  const t = manifest.thresholds;
  const live = !isTerminal(state.state);
  return {
    schema: SCHEMA,
    candidateSha: manifest.candidateSha,
    version: manifest.version,
    state: state.state,
    canonicalThresholds: isCanonical(manifest),
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    lastSampleAt: state.lastSample.wallAt,
    monitorStale: live && now - state.lastSample.wallAt > t.maxIntervalMs,
    // A clock behind the last sample must not publish less time than has
    // already been recorded.
    elapsedMs: (live ? Math.max(now, state.updatedAt) : state.updatedAt) - state.startedAt,
    qualifiedMs: state.qualifiedMs,
    targetMs: t.targetQualifiedMs,
    remainingMs: Math.max(0, t.targetQualifiedMs - state.qualifiedMs),
    extensions: structuredClone(state.extensions),
    pty: {
      attaches: state.pty.attaches,
      detaches: state.pty.detaches,
      firstEventAt: state.pty.firstEventAt,
      lastEventAt: state.pty.lastEventAt,
      spanMs: state.pty.firstEventAt === null ? 0 : state.pty.lastEventAt - state.pty.firstEventAt,
      met: ptyTargetMet(state.pty, t),
      target: { attaches: t.ptyMinAttaches, detaches: t.ptyMinDetaches, spanMs: t.ptyMinSpanMs }
    },
    poolUsedTrend: structuredClone(state.poolUsedTrend),
    failure: structuredClone(state.failure),
    acceptance: structuredClone(state.acceptance),
    cancellation: structuredClone(state.cancellation)
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  buildManifest,
  isCanonical,
  classify,
  assessInterval,
  ptyTargetMet,
  admit,
  reduce,
  accept,
  cancel,
  summarize
};
