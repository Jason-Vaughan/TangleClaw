'use strict';

/**
 * The release-candidate soak schedule (#2020): a deterministic, auditable mix
 * of load and faults for an isolated soak run.
 *
 * The same seed and parameters always produce the same events and the same
 * digest. That lets a finished soak's evidence name exactly what it was put
 * through, and a rerun reproduce it. Nothing here performs I/O; executing a
 * schedule is `lib/soak/driver.js`'s job.
 *
 * Two phases exist because an owned-ttyd restart changes the ttyd generation,
 * which the release-certification judge treats as a hard failure. Such a
 * fault can therefore only be exercised in a separate `destructive` phase,
 * never in the `certifying` one. `validateSchedule` enforces that on any
 * schedule, including one read from disk or edited by hand, so the rule does
 * not depend on the generator having been used.
 *
 * The schema version names the catalogue a digest was drawn from. Adding a
 * kind changes what a given seed draws, so a schedule written under an older
 * catalogue is refused rather than read as if it meant the same run.
 *
 * @module lib/soak/schedule
 */

const crypto = require('node:crypto');

const SCHEMA = 'tc.soak-schedule/v2';

const PHASES = Object.freeze(['certifying', 'destructive']);

const CLASSES = Object.freeze(['api', 'engine', 'browser', 'fault']);

/**
 * Load tasks. `weight` sets how often a kind is drawn relative to the others
 * in the classes a schedule includes.
 *
 * The plans, switchboard and wrap kinds carry low weights. Each does several
 * requests, and the two engine ones launch sessions and run a wrap pipeline,
 * so at a higher weight they would crowd out the light calls whose steady
 * stream is what shows a slow leak. The switchboard cycle needs two projects;
 * a schedule with fewer never draws it.
 */
const TASKS = Object.freeze([
  Object.freeze({ kind: 'api.health', class: 'api', weight: 6 }),
  Object.freeze({ kind: 'api.server-info', class: 'api', weight: 3 }),
  Object.freeze({ kind: 'api.projects.list', class: 'api', weight: 4 }),
  Object.freeze({ kind: 'api.ports.list', class: 'api', weight: 3 }),
  Object.freeze({ kind: 'api.ports.lease-release', class: 'api', weight: 2 }),
  Object.freeze({ kind: 'api.plans.read', class: 'api', weight: 1 }),
  Object.freeze({ kind: 'api.medusa.reads', class: 'api', weight: 1 }),
  Object.freeze({ kind: 'engine.session.cycle', class: 'engine', weight: 3 }),
  Object.freeze({ kind: 'engine.session.medusa-cycle', class: 'engine', weight: 1 }),
  Object.freeze({ kind: 'engine.session.wrap-cycle', class: 'engine', weight: 1 }),
  Object.freeze({ kind: 'browser.dashboard.load', class: 'browser', weight: 2 }),
  Object.freeze({ kind: 'browser.terminal.attach', class: 'browser', weight: 1 })
]);

/**
 * Faults, and the phases each may run in. An owned-ttyd restart is
 * destructive-only: it changes the ttyd generation, which fails a
 * certification outright.
 */
const FAULTS = Object.freeze([
  Object.freeze({ kind: 'fault.server.restart', class: 'fault', phases: Object.freeze(['certifying', 'destructive']) }),
  Object.freeze({ kind: 'fault.tmux.session-kill', class: 'fault', phases: Object.freeze(['certifying', 'destructive']) }),
  Object.freeze({ kind: 'fault.client.abort', class: 'fault', phases: Object.freeze(['certifying', 'destructive']) }),
  Object.freeze({ kind: 'fault.db.lock-contention', class: 'fault', phases: Object.freeze(['certifying', 'destructive']) }),
  Object.freeze({ kind: 'fault.disk.pressure', class: 'fault', phases: Object.freeze(['certifying', 'destructive']) }),
  Object.freeze({ kind: 'fault.ttyd.restart', class: 'fault', phases: Object.freeze(['destructive']) })
]);

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Placeholder defaults; whatever a run used is recorded in its params and digest. */
const DEFAULTS = Object.freeze({
  loadMeanMs: 30 * 1000,
  faultMeanMs: 45 * MINUTE_MS,
  faultQuietMs: 10 * MINUTE_MS,
  projects: Object.freeze(['soak-a', 'soak-b', 'soak-c']),
  leasePortRange: Object.freeze([5500, 5599]),
  commandsPerCycle: 3
});

/** The longest schedule accepted: a 72-hour soak plus room for its extensions. */
const MAX_DURATION_MS = 7 * 24 * HOUR_MS;

/**
 * Absolute bounds on the params, so validation does not depend on the
 * schedule's own params being honest. A hand edit can change the params and
 * the events together and recompute the digest, so the params are checked
 * against these fixed limits, not against themselves.
 *
 * - Projects must look synthetic. The load launches and kills sessions, and
 *   this keeps it off any real project name even if the target has one.
 * - Lease ports stay in the ad hoc range (5000+), never in TangleClaw's own
 *   3100-3999 infrastructure and project ranges.
 * - Caps on commands per cycle and a floor on the gaps bound how hard one
 *   schedule can hit the server, and how many events it holds in memory.
 */
const LIMITS = Object.freeze({
  projectPattern: /^soak-[a-z0-9-]{1,40}$/,
  maxProjects: 20,
  minLeasePort: 5000,
  maxCommandsPerCycle: 20,
  minLoadMeanMs: 1000,
  minFaultMeanMs: 60 * 1000,
  // A certifying run must leave the system time to recover between faults,
  // or a fault storm would be judged as ordinary instability.
  minCertifyingFaultQuietMs: 60 * 1000,
  // A 72-hour soak at the one-second load floor is 259,200 events. The cap
  // leaves room above that and bounds memory, the schedule file, and the log.
  maxEvents: 300000
});

/** Closed set of reasons a schedule fails validation. */
const VIOLATION = Object.freeze({
  SCHEMA: 'SCHEMA',
  PARAMS: 'PARAMS',
  UNKNOWN_KIND: 'UNKNOWN_KIND',
  CLASS_EXCLUDED: 'CLASS_EXCLUDED',
  FAULT_NOT_PERMITTED_IN_PHASE: 'FAULT_NOT_PERMITTED_IN_PHASE',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  NOT_ORDERED: 'NOT_ORDERED',
  INDEX: 'INDEX',
  FAULT_IN_QUIET_WINDOW: 'FAULT_IN_QUIET_WINDOW',
  EVENT_PARAMS: 'EVENT_PARAMS',
  EVENT_CAP: 'EVENT_CAP',
  DIGEST_MISMATCH: 'DIGEST_MISMATCH'
});

const KIND_INDEX = new Map([...TASKS, ...FAULTS].map((k) => [k.kind, k]));

/** The kind that sends a switchboard message between two distinct projects. */
const PAIR_KIND = 'engine.session.medusa-cycle';

/** Kinds whose params name a single schedule project and nothing else. */
const PROJECT_KINDS = new Set(['browser.terminal.attach', 'fault.tmux.session-kill', 'api.plans.read', 'engine.session.wrap-cycle']);

/**
 * A 32-bit seed from any string, so an operator can use a readable seed such as
 * a candidate SHA or a date.
 * @param {string} seed - Seed text
 * @returns {number} Unsigned 32-bit integer
 */
function seedToUint32(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest().readUInt32BE(0);
}

/**
 * mulberry32: a small, fast PRNG whose whole state is one 32-bit integer.
 * It is not cryptographic and does not need to be; the only requirement is
 * that the same seed gives the same sequence on every platform, which
 * integer-only arithmetic guarantees.
 * @param {number} a - 32-bit seed
 * @returns {() => number} A function returning floats in [0, 1)
 */
function mulberry32(a) {
  let s = a >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick one item by weight.
 * @param {object[]} items - Items with a positive `weight`
 * @param {() => number} rand - PRNG
 * @returns {object} The chosen item
 */
function _weightedPick(items, rand) {
  const total = items.reduce((n, i) => n + i.weight, 0);
  let r = rand() * total;
  for (const item of items) {
    r -= item.weight;
    if (r < 0) return item;
  }
  return items[items.length - 1];
}

/**
 * The next gap, uniformly jittered between half and one-and-a-half times the
 * mean, and always at least 1 ms, so two events of one stream never share a
 * time.
 * @param {number} meanMs - Mean gap
 * @param {() => number} rand - PRNG
 * @returns {number} Gap in whole milliseconds
 */
function _gap(meanMs, rand) {
  return Math.max(1, Math.round(meanMs * (0.5 + rand())));
}

/**
 * Parameters for one load event. They are drawn here rather than at run time,
 * so the schedule alone says which project and port each event touches.
 * @param {string} kind - Task kind
 * @param {object} p - Normalized schedule params
 * @param {() => number} rand - PRNG
 * @returns {object} Event params (empty for kinds that take none)
 */
function _taskParams(kind, p, rand) {
  if (kind === 'api.ports.lease-release') {
    const [lo, hi] = p.leasePortRange;
    return { port: lo + Math.floor(rand() * (hi - lo + 1)) };
  }
  if (kind === 'engine.session.cycle' || PROJECT_KINDS.has(kind)) {
    return { project: p.projects[Math.floor(rand() * p.projects.length)], ...(kind === 'engine.session.cycle' ? { commands: p.commandsPerCycle } : {}) };
  }
  if (kind === PAIR_KIND) {
    // The recipient is drawn from the other projects only, so the two are
    // always distinct without a retry loop that would make the draw count vary.
    const from = Math.floor(rand() * p.projects.length);
    let to = Math.floor(rand() * (p.projects.length - 1));
    if (to >= from) to++;
    return { from: p.projects[from], to: p.projects[to] };
  }
  return {};
}

/**
 * Why an event's params break the rules `_taskParams` generates them by, or
 * null when they follow them. A hand-edited schedule can otherwise point the
 * load at a port outside its range, a project that is not synthetic, or a
 * session cycle with an arbitrary number of commands, and still validate.
 * @param {string} kind - Event kind
 * @param {*} params - Event params
 * @param {object} p - Normalized schedule params
 * @returns {string|null} The problem, or null
 */
function _paramsProblem(kind, params, p) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'params must be an object';
  const keys = Object.keys(params).sort();
  const expectKeys = (want) => (keys.join(',') === [...want].sort().join(',') ? null : `params must have exactly: ${want.join(', ') || 'no keys'}`);
  const projectOk = () => (p.projects.includes(params.project) ? null : `project ${JSON.stringify(params.project)} is not one of the schedule's projects`);
  if (kind === 'api.ports.lease-release') {
    const [lo, hi] = p.leasePortRange;
    return expectKeys(['port']) || (Number.isInteger(params.port) && params.port >= lo && params.port <= hi ? null : `port ${params.port} is outside ${lo}-${hi}`);
  }
  if (kind === 'engine.session.cycle') {
    return expectKeys(['commands', 'project']) || projectOk() || (params.commands === p.commandsPerCycle ? null : `commands must be ${p.commandsPerCycle}`);
  }
  if (PROJECT_KINDS.has(kind)) return expectKeys(['project']) || projectOk();
  if (kind === PAIR_KIND) {
    if (p.projects.length < 2) return 'needs at least two schedule projects';
    return expectKeys(['from', 'to'])
      || (p.projects.includes(params.from) ? null : `from ${JSON.stringify(params.from)} is not one of the schedule's projects`)
      || (p.projects.includes(params.to) ? null : `to ${JSON.stringify(params.to)} is not one of the schedule's projects`)
      || (params.from !== params.to ? null : 'from and to must be different projects');
  }
  return expectKeys([]);
}

/**
 * Normalize and check schedule options. Throws on anything that would make
 * the schedule meaningless, rather than quietly substituting a default for a
 * value the caller did give.
 * @param {object} opts - See `buildSchedule`
 * @returns {object} Normalized params, in canonical key order
 */
function normalizeParams(opts) {
  const o = opts || {};
  const fail = (msg) => { const e = new Error(msg); e.code = VIOLATION.PARAMS; throw e; };
  if (typeof o.seed !== 'string' || o.seed.length === 0) fail('seed must be a non-empty string');
  if (!PHASES.includes(o.phase)) fail(`phase must be one of ${PHASES.join(', ')}`);
  if (!Number.isInteger(o.durationMs) || o.durationMs <= 0 || o.durationMs > MAX_DURATION_MS) {
    fail(`durationMs must be a whole number of ms in (0, ${MAX_DURATION_MS}]`);
  }
  const pick = (name) => (o[name] === undefined ? DEFAULTS[name] : o[name]);
  const loadMeanMs = pick('loadMeanMs');
  const faultMeanMs = pick('faultMeanMs');
  const faultQuietMs = pick('faultQuietMs');
  const commandsPerCycle = pick('commandsPerCycle');
  for (const [name, v] of [['loadMeanMs', loadMeanMs], ['faultMeanMs', faultMeanMs], ['commandsPerCycle', commandsPerCycle]]) {
    if (!Number.isInteger(v) || v <= 0) fail(`${name} must be a positive whole number`);
  }
  if (loadMeanMs < LIMITS.minLoadMeanMs) fail(`loadMeanMs must be at least ${LIMITS.minLoadMeanMs}`);
  if (faultMeanMs < LIMITS.minFaultMeanMs) fail(`faultMeanMs must be at least ${LIMITS.minFaultMeanMs}`);
  if (commandsPerCycle > LIMITS.maxCommandsPerCycle) fail(`commandsPerCycle must be at most ${LIMITS.maxCommandsPerCycle}`);
  if (!Number.isInteger(faultQuietMs) || faultQuietMs < 0) fail('faultQuietMs must be a whole number of ms, zero or more');
  if (o.phase === 'certifying' && faultQuietMs < LIMITS.minCertifyingFaultQuietMs) {
    fail(`faultQuietMs must be at least ${LIMITS.minCertifyingFaultQuietMs} in a certifying schedule`);
  }
  const projects = pick('projects');
  if (!Array.isArray(projects) || projects.length === 0 || projects.length > LIMITS.maxProjects
    || !projects.every((n) => typeof n === 'string' && LIMITS.projectPattern.test(n)) || new Set(projects).size !== projects.length) {
    fail(`projects must be 1-${LIMITS.maxProjects} distinct synthetic names matching ${LIMITS.projectPattern}`);
  }
  const range = pick('leasePortRange');
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger) || range[0] < LIMITS.minLeasePort || range[1] > 65535 || range[0] > range[1]) {
    fail(`leasePortRange must be [lo, hi] with ${LIMITS.minLeasePort} <= lo <= hi <= 65535`);
  }
  const classes = o.classes === undefined ? [...CLASSES] : o.classes;
  if (!Array.isArray(classes) || classes.length === 0 || !classes.every((c) => CLASSES.includes(c)) || new Set(classes).size !== classes.length) {
    fail(`classes must be a non-empty subset of ${CLASSES.join(', ')} without repeats`);
  }
  if (!classes.some((c) => c !== 'fault')) fail('classes must include at least one load class');
  return {
    seed: o.seed,
    phase: o.phase,
    durationMs: o.durationMs,
    classes: CLASSES.filter((c) => classes.includes(c)),
    loadMeanMs,
    faultMeanMs,
    faultQuietMs,
    projects: [...projects],
    leasePortRange: [range[0], range[1]],
    commandsPerCycle
  };
}

/**
 * The digest a schedule is known by: sha256 over its schema, params and
 * events. The digest field itself is excluded, so it can be recomputed and
 * compared.
 * @param {{schema: string, params: object, events: object[]}} schedule - Schedule
 * @returns {string} Hex sha256
 */
function scheduleDigest(schedule) {
  const canonical = JSON.stringify({ schema: schedule.schema, params: schedule.params, events: schedule.events });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Build a schedule.
 *
 * Load events and faults are drawn from two independent streams of one
 * seeded PRNG, then merged by time. Faults are spaced by at least
 * `faultQuietMs` after the previous fault, so the system has a window to
 * recover before the next one lands.
 *
 * @param {object} opts - Options
 * @param {string} opts.seed - Any non-empty string
 * @param {'certifying'|'destructive'} opts.phase - Which fault catalogue applies
 * @param {number} opts.durationMs - Length of the schedule
 * @param {string[]} [opts.classes] - Classes to include (default: all)
 * @param {number} [opts.loadMeanMs] - Mean gap between load events
 * @param {number} [opts.faultMeanMs] - Mean gap between faults
 * @param {number} [opts.faultQuietMs] - Minimum gap after a fault before the next fault
 * @param {string[]} [opts.projects] - Synthetic project names the load may target; the switchboard cycle is drawn only when there are two or more
 * @param {number[]} [opts.leasePortRange] - `[lo, hi]` for the lease/release task
 * @param {number} [opts.commandsPerCycle] - Commands injected per engine session cycle
 * @returns {{schema: string, params: object, events: object[], digest: string}} The schedule
 * @throws {Error} With `code: 'PARAMS'` on invalid options
 */
function buildSchedule(opts) {
  const p = normalizeParams(opts);
  const root = seedToUint32(p.seed);
  // Separate streams, so turning the fault class off does not shift the load
  // events that a run with faults would have had.
  const loadRand = mulberry32(root);
  const faultRand = mulberry32(root ^ 0x9E3779B9);

  const loadKinds = TASKS.filter((t) => p.classes.includes(t.class) && (t.kind !== PAIR_KIND || p.projects.length >= 2));
  const raw = [];
  const tooMany = () => {
    const e = new Error(`the schedule would exceed ${LIMITS.maxEvents} events; raise the gaps or shorten the duration`);
    e.code = VIOLATION.PARAMS;
    return e;
  };
  for (let at = _gap(p.loadMeanMs, loadRand); at < p.durationMs; at += _gap(p.loadMeanMs, loadRand)) {
    // Checked while generating, so an oversized request fails before it
    // allocates the events it asked for.
    if (raw.length >= LIMITS.maxEvents) throw tooMany();
    const task = _weightedPick(loadKinds, loadRand);
    raw.push({ atMs: at, kind: task.kind, class: task.class, params: _taskParams(task.kind, p, loadRand) });
  }

  if (p.classes.includes('fault')) {
    const faultKinds = FAULTS.filter((f) => f.phases.includes(p.phase)).map((f) => ({ ...f, weight: 1 }));
    for (let at = _gap(p.faultMeanMs, faultRand); at < p.durationMs; at += Math.max(p.faultQuietMs, _gap(p.faultMeanMs, faultRand))) {
      if (raw.length >= LIMITS.maxEvents) throw tooMany();
      const fault = _weightedPick(faultKinds, faultRand);
      raw.push({ atMs: at, kind: fault.kind, class: 'fault', params: _taskParams(fault.kind, p, faultRand) });
    }
  }

  // A stable sort keeps a load event ahead of a fault at the same millisecond,
  // which is deterministic because the load events were pushed first.
  raw.sort((a, b) => a.atMs - b.atMs);
  const events = raw.map((e, index) => ({ index, ...e }));
  const schedule = { schema: SCHEMA, params: p, events };
  return { ...schedule, digest: scheduleDigest(schedule) };
}

/**
 * Check a schedule against every rule, whoever produced it.
 * @param {object} schedule - A schedule, e.g. parsed from disk
 * @returns {{code: string, index?: number, detail: string}[]} Violations; empty when valid
 */
function validateSchedule(schedule) {
  const out = [];
  const add = (code, detail, index) => out.push(index === undefined ? { code, detail } : { code, index, detail });
  if (!schedule || schedule.schema !== SCHEMA) {
    add(VIOLATION.SCHEMA, `schema must be ${SCHEMA}`);
    return out;
  }
  let p;
  try {
    p = normalizeParams(schedule.params);
  } catch (err) {
    if (err.code !== VIOLATION.PARAMS) throw err;
    add(VIOLATION.PARAMS, err.message);
    return out;
  }
  // The params must be written out in full, exactly as the generator writes
  // them. A key left out would be filled with its default here, while
  // anything reading the file directly would see it missing: a deleted
  // faultQuietMs must not switch the quiet window off at run time.
  if (JSON.stringify(p) !== JSON.stringify(schedule.params)) {
    add(VIOLATION.PARAMS, 'params must be written out in full canonical form, as the generator writes them');
    return out;
  }
  if (!Array.isArray(schedule.events)) {
    add(VIOLATION.SCHEMA, 'events must be a list');
    return out;
  }
  if (schedule.events.length > LIMITS.maxEvents) {
    add(VIOLATION.EVENT_CAP, `${schedule.events.length} events exceed the cap of ${LIMITS.maxEvents}`);
    return out;
  }
  let prevAt = -1;
  let prevFaultAt = null;
  schedule.events.forEach((e, i) => {
    if (!e || e.index !== i) add(VIOLATION.INDEX, `event ${i} carries index ${e && e.index}`, i);
    const known = e && KIND_INDEX.get(e.kind);
    if (!known || known.class !== e.class) {
      add(VIOLATION.UNKNOWN_KIND, `unknown kind ${e && e.kind}`, i);
      return;
    }
    if (!p.classes.includes(known.class)) add(VIOLATION.CLASS_EXCLUDED, `${e.kind} is in class ${known.class}, which the params exclude`, i);
    if (known.phases && !known.phases.includes(p.phase)) {
      add(VIOLATION.FAULT_NOT_PERMITTED_IN_PHASE, `${e.kind} is not permitted in a ${p.phase} schedule`, i);
    }
    const paramsProblem = _paramsProblem(e.kind, e.params, p);
    if (paramsProblem) add(VIOLATION.EVENT_PARAMS, `${e.kind}: ${paramsProblem}`, i);
    if (!Number.isInteger(e.atMs) || e.atMs <= 0 || e.atMs >= p.durationMs) add(VIOLATION.OUT_OF_RANGE, `atMs ${e.atMs} outside (0, ${p.durationMs})`, i);
    else if (e.atMs < prevAt) add(VIOLATION.NOT_ORDERED, `atMs ${e.atMs} precedes the previous event's ${prevAt}`, i);
    if (Number.isInteger(e.atMs)) prevAt = Math.max(prevAt, e.atMs);
    if (known.class === 'fault' && Number.isInteger(e.atMs)) {
      if (prevFaultAt !== null && e.atMs - prevFaultAt < p.faultQuietMs) {
        add(VIOLATION.FAULT_IN_QUIET_WINDOW, `fault at ${e.atMs} is within ${p.faultQuietMs} ms of the fault at ${prevFaultAt}`, i);
      }
      prevFaultAt = e.atMs;
    }
  });
  if (schedule.digest !== scheduleDigest(schedule)) add(VIOLATION.DIGEST_MISMATCH, 'digest does not match the schedule content');
  return out;
}

/**
 * Count events by kind, for a human summary of a schedule.
 * @param {{events: object[]}} schedule - Schedule
 * @returns {Object<string, number>} Kind to count, in catalogue order
 */
function summarize(schedule) {
  const counts = {};
  for (const k of KIND_INDEX.keys()) counts[k] = 0;
  for (const e of schedule.events) counts[e.kind] = (counts[e.kind] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

module.exports = {
  SCHEMA,
  PHASES,
  CLASSES,
  TASKS,
  FAULTS,
  DEFAULTS,
  MAX_DURATION_MS,
  LIMITS,
  VIOLATION,
  buildSchedule,
  validateSchedule,
  scheduleDigest,
  normalizeParams,
  summarize,
  seedToUint32,
  mulberry32
};
