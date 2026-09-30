#!/usr/bin/env node
'use strict';

/**
 * Release-candidate soak CLI (#2020): build, check and execute a
 * deterministic load-and-fault schedule.
 *
 *   soak plan     --seed <s> --phase certifying|destructive --duration-hours <h> --out <file>
 *                 [--classes api,engine,browser,fault] [--projects a,b,c]
 *                 [--load-mean-ms <n>] [--fault-mean-ms <n>] [--fault-quiet-ms <n>]
 *   soak validate --schedule <file>
 *   soak run      --schedule <file> --api <url> --log <file> [--allow-unverified-live] [--no-live-install]
 *                 [--home <dir>] [--webdriver <url>]
 *   soak repos    --root <dir> --origins <dir> [--projects a,b,c]
 *   soak sample   --home <dir> --api <url> --out <file> --no-live-install
 *                 [--interval-ms <n>] [--count <n>] [--full-every <n>]
 *   soak bundle   --out <dir> --schedule <file> --log <file> [--samples <file>]
 *                 [--attestations <file,file>] [--home <dir> --no-live-install]
 *
 * `sample` appends integrity and resource samples of the guest TangleClaw
 * (its database, process and disk) to an ndjson file, and `bundle` gathers a
 * run's evidence into one directory with a manifest binding every file
 * (`lib/soak/integrity`, `lib/soak/bundle`). Both read a TangleClaw home
 * directly, so both run only inside the soak guest.
 *
 * `repos` creates the synthetic `soak-*` repos the load targets, each with a
 * local bare origin, or confirms they already exist exactly as it would create
 * them. It refuses any path it does not own (`lib/soak/repos`).
 *
 * `run` executes against the server named by `--api` and nothing else. There
 * is deliberately no fallback to `TANGLECLAW_API`. Because a soak's load
 * writes (port leases, sessions), it refuses the pane's own TangleClaw by
 * spelling, by address (with a live install to protect, `--api` must be an
 * IP literal, so nothing is resolved between the check and the connection),
 * and by server identity.
 * When the live install's identity cannot be read, it refuses unless
 * `--allow-unverified-live` is given. With no `TANGLECLAW_API` at all there is
 * nothing to guard against, and it refuses unless `--no-live-install` says so:
 * that is the soak guest's case. Every run segment records the overrides it
 * ran under: the first in the log header, each resumed one in a `resume` record.
 * Neither is ever passed on the operator's behalf. The service token is read from `TANGLECLAW_SERVICE_TOKEN` only,
 * never from a flag that would put it in shell history and process listings.
 *
 * A schedule with `fault` or `browser` events also needs `--home` (and
 * `--webdriver` for browser events), and runs only inside the soak guest:
 * those events act on this machine, not only through `--api`
 * (`lib/soak/local.js`). The local context admitted is recorded with the
 * run's guards.
 *
 * Interrupting `run` (SIGINT/SIGTERM) stops before the next event. Running it
 * again with the same log resumes where it stopped.
 *
 * Exit codes: 0 done (completed, or the log had already completed), 2 usage
 * error, 3 refused (the code is printed as JSON on stderr), 4 stopped before
 * the end, 5 done but a segment's lock ownership could not be verified
 * (`*-ownership-unverified`), which is not an automatic certification pass.
 *
 * @module scripts/soak
 */

const fs = require('node:fs');

const scheduleLib = require('../lib/soak/schedule');
const driver = require('../lib/soak/driver');
const { EXECUTORS } = require('../lib/soak/executors');
const { FAULT_EXECUTORS } = require('../lib/soak/faults');
const { BROWSER_EXECUTORS } = require('../lib/soak/browser');
const localLib = require('../lib/soak/local');
const integrityLib = require('../lib/soak/integrity');
const bundleLib = require('../lib/soak/bundle');
const reposLib = require('../lib/soak/repos');

/** Every executor `run` can use, by event kind. */
const RUN_EXECUTORS = Object.freeze({ ...EXECUTORS, ...FAULT_EXECUTORS, ...BROWSER_EXECUTORS });

const USAGE = [
  'usage: soak plan     --seed <s> --phase certifying|destructive --duration-hours <h> --out <file>',
  '                     [--classes api,engine,browser,fault] [--projects a,b,c]',
  '                     [--load-mean-ms <n>] [--fault-mean-ms <n>] [--fault-quiet-ms <n>]',
  '       soak validate --schedule <file>',
  '       soak run      --schedule <file> --api <url> --log <file> [--allow-unverified-live] [--no-live-install]',
  '                     [--home <dir>] [--webdriver <url>]',
  '       soak repos    --root <dir> --origins <dir> [--projects a,b,c]',
  '       soak sample   --home <dir> --api <url> --out <file> --no-live-install',
  '                     [--interval-ms <n>] [--count <n>] [--full-every <n>]',
  '       soak bundle   --out <dir> --schedule <file> --log <file> [--samples <file>]',
  '                     [--attestations <file,file>] [--home <dir> --no-live-install]'
].join('\n');

const HOUR_MS = 60 * 60 * 1000;

/** Flags that take no value. */
const BOOLEAN = new Set(['allow-unverified-live', 'no-live-install']);

/** A malformed or incomplete command line: exit 2 with the usage text. */
class UsageError extends Error {}

/**
 * Parse `--flag value` pairs. A flag in `BOOLEAN` takes no value and reads as `true`.
 * @param {string[]} argv - Arguments after the command
 * @returns {Object<string, string|boolean>} Flags
 * @throws {UsageError} On a stray argument, a missing value or a repeated flag
 */
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument: ${a}`);
    const name = a.slice(2);
    if (BOOLEAN.has(name)) {
      if (Object.prototype.hasOwnProperty.call(flags, name)) throw new UsageError(`--${name} given twice`);
      flags[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    if (Object.prototype.hasOwnProperty.call(flags, name)) throw new UsageError(`--${name} given twice`);
    flags[name] = value;
    i++;
  }
  return flags;
}

/**
 * Require the named flags, and refuse any flag not in `allowed`.
 * @param {Object<string, string>} flags - Parsed flags
 * @param {string[]} required - Flags that must be present
 * @param {string[]} [optional=[]] - Flags that may be present
 * @throws {UsageError} On a missing or unknown flag
 */
function expectFlags(flags, required, optional = []) {
  if (Object.prototype.hasOwnProperty.call(flags, 'token')) {
    throw new UsageError('--token is not accepted; set TANGLECLAW_SERVICE_TOKEN instead');
  }
  for (const f of required) if (flags[f] === undefined) throw new UsageError(`--${f} is required`);
  const known = new Set([...required, ...optional]);
  for (const f of Object.keys(flags)) if (!known.has(f)) throw new UsageError(`unknown flag --${f}`);
}

/**
 * A whole-number flag value.
 * @param {string} name - Flag name
 * @param {string|undefined} v - Raw value
 * @returns {number|undefined} The number, or undefined when absent
 * @throws {UsageError} When present but not a whole number
 */
function intFlag(name, v) {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a whole number`);
  return Number(v);
}

/**
 * Read and parse a schedule file.
 * @param {string} file - Path
 * @returns {object} The parsed schedule
 * @throws {UsageError} When it cannot be read or is not JSON
 */
function readSchedule(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${file}: ${err.code || err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new UsageError(`${file} is not JSON`);
  }
}

/**
 * `plan`: build a schedule and write it to a file.
 * @param {Object<string, string>} flags - Flags
 * @param {object} io - `{stderr}`
 * @returns {number} Exit code
 */
function cmdPlan(flags, io) {
  expectFlags(flags, ['seed', 'phase', 'duration-hours', 'out'], ['classes', 'projects', 'load-mean-ms', 'fault-mean-ms', 'fault-quiet-ms']);
  const hours = Number(flags['duration-hours']);
  if (!Number.isFinite(hours) || hours <= 0) throw new UsageError('--duration-hours must be a positive number');
  const list = (v) => (v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean));
  let schedule;
  try {
    schedule = scheduleLib.buildSchedule({
      seed: flags.seed,
      phase: flags.phase,
      durationMs: Math.round(hours * HOUR_MS),
      classes: list(flags.classes),
      projects: list(flags.projects),
      loadMeanMs: intFlag('load-mean-ms', flags['load-mean-ms']),
      faultMeanMs: intFlag('fault-mean-ms', flags['fault-mean-ms']),
      faultQuietMs: intFlag('fault-quiet-ms', flags['fault-quiet-ms'])
    });
  } catch (err) {
    if (err.code === scheduleLib.VIOLATION.PARAMS) throw new UsageError(err.message);
    throw err;
  }
  // `wx`: never overwrite a schedule that a run may already be logged against.
  try {
    fs.writeFileSync(flags.out, `${JSON.stringify(schedule, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code === 'EEXIST') throw new UsageError(`${flags.out} already exists; a schedule is never overwritten`);
    throw err;
  }
  io.stderr.write(`${JSON.stringify({ out: flags.out, digest: schedule.digest, phase: schedule.params.phase, events: schedule.events.length, byKind: scheduleLib.summarize(schedule) })}\n`);
  return 0;
}

/**
 * `validate`: check a schedule file against every rule.
 * @param {Object<string, string>} flags - Flags
 * @param {object} io - `{stdout, stderr}`
 * @returns {number} Exit code: 0 valid, 3 invalid
 */
function cmdValidate(flags, io) {
  expectFlags(flags, ['schedule']);
  const schedule = readSchedule(flags.schedule);
  const violations = scheduleLib.validateSchedule(schedule);
  if (violations.length > 0) {
    io.stderr.write(`${JSON.stringify({ code: driver.REFUSAL.INVALID_SCHEDULE, violations })}\n`);
    return 3;
  }
  io.stdout.write(`${JSON.stringify({ valid: true, digest: schedule.digest, events: schedule.events.length })}\n`);
  return 0;
}

/**
 * `run`: execute a schedule against the named server.
 * @param {Object<string, string>} flags - Flags
 * @param {object} io - `{stdout, stderr}`
 * @param {object} deps - `{env, fetch, lookup, clock, onStopSignal}`
 * @returns {Promise<number>} Exit code
 */
async function cmdRun(flags, io, deps) {
  expectFlags(flags, ['schedule', 'api', 'log'], ['allow-unverified-live', 'no-live-install', 'home', 'webdriver']);
  let api;
  try {
    api = new URL(flags.api);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    throw new UsageError(`--api is not a URL: ${flags.api}`);
  }
  if (api.protocol !== 'http:' && api.protocol !== 'https:') throw new UsageError('--api must be http or https');
  const liveApi = deps.env.TANGLECLAW_API;
  if (liveApi) {
    try {
      new URL(liveApi); // eslint-disable-line no-new
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      // A guard context that cannot be read is no guard context.
      throw new driver.DriverRefusal(driver.REFUSAL.GUARD_CONTEXT_ABSENT, `refusing to run: TANGLECLAW_API is set but is not a URL (${liveApi})`);
    }
  }
  const noLiveInstall = driver.requireGuardContext(liveApi, flags['no-live-install'] === true);
  if (liveApi && flags['no-live-install'] === true) throw new UsageError('--no-live-install contradicts TANGLECLAW_API being set');
  driver.refuseLiveTarget(api.href, liveApi);
  const address = await driver.refuseLiveAddress({ apiBase: api.href, liveApi, lookup: deps.lookup });
  const schedule = readSchedule(flags.schedule);
  const localCtx = await localLib.requireLocalControl({ schedule, noLiveInstall, apiBase: api.href, home: flags.home, webdriver: flags.webdriver }, deps.local);
  const token = deps.env.TANGLECLAW_SERVICE_TOKEN || null;
  const identity = await driver.refuseSameInstall({ apiBase: api.href, liveApi, fetch: deps.fetch, token, allowUnverifiedLive: flags['allow-unverified-live'] === true });
  if (!identity.checked) io.stderr.write(`${JSON.stringify({ warning: 'IDENTITY_UNCHECKED', reason: identity.reason, liveUnverified: identity.liveUnverified })}\n`);
  let stop = false;
  deps.onStopSignal(() => {
    if (!stop) io.stderr.write(`${JSON.stringify({ stopping: 'before the next event; the log resumes from here' })}\n`);
    stop = true;
  });
  const result = await driver.runSchedule({
    schedule,
    executors: RUN_EXECUTORS,
    ctx: { apiBase: api.href, token, fetch: deps.fetch, ...(localCtx ? { local: localCtx } : {}) },
    logPath: flags.log,
    clock: deps.clock,
    shouldStop: () => stop,
    // An override of the live-identity check is part of the run's record,
    // not just a line on a terminal.
    // Each run segment records what its guards established and which
    // overrides it ran under, in the header or in a resume record, so the
    // evidence shows how every segment was protected.
    headerExtra: {
      guard: {
        liveApi: liveApi ? new URL(liveApi).origin : null,
        target: api.origin,
        targetAddress: address ? address.targetAddress : null,
        identity: { checked: identity.checked, reason: identity.reason },
        ...(localCtx ? { local: { home: localCtx.home, webdriver: localCtx.webdriver, uid: localCtx.uid } } : {})
      },
      ...(identity.liveUnverified ? { liveIdentityOverride: { reason: identity.reason } } : {}),
      ...(noLiveInstall ? { guardContextOverride: 'no-live-install' } : {})
    }
  });
  io.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'stopped') return 4;
  // Finished, but not cleanly: the default disposition is fail and reset.
  return result.ownershipUnverified ? 5 : 0;
}

/**
 * `repos`: create or confirm the synthetic repos and their local bare origins.
 * @param {Object<string, string>} flags - Flags
 * @param {object} io - `{stdout, stderr}`
 * @returns {number} Exit code: 0 done, 3 refused
 */
function cmdRepos(flags, io) {
  expectFlags(flags, ['root', 'origins'], ['projects']);
  const projects = flags.projects === undefined ? undefined : flags.projects.split(',').map((s) => s.trim()).filter(Boolean);
  let result;
  try {
    result = reposLib.ensureRepos({ root: flags.root, origins: flags.origins, projects });
  } catch (err) {
    if (!(err instanceof reposLib.RepoRefusal)) throw err;
    if (err.code === reposLib.REFUSAL.BAD_ROOTS || err.code === reposLib.REFUSAL.BAD_PROJECTS) throw new UsageError(err.message);
    io.stderr.write(`${JSON.stringify({ code: err.code, message: err.message, details: err.details })}\n`);
    return 3;
  }
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

/**
 * `--no-live-install` for a command that reads the guest home: required, and
 * a contradiction where `TANGLECLAW_API` is set.
 * @param {Object<string, string|boolean>} flags - Flags
 * @param {object} deps - `{env}`
 * @returns {boolean} Whether it was given
 * @throws {UsageError} When it contradicts `TANGLECLAW_API`
 */
function noLiveInstallFlag(flags, deps) {
  const given = flags['no-live-install'] === true;
  if (given && deps.env.TANGLECLAW_API) throw new UsageError('--no-live-install contradicts TANGLECLAW_API being set');
  return given;
}

/**
 * `sample`: append integrity and resource samples of the guest TangleClaw.
 * @param {Object<string, string|boolean>} flags - Flags
 * @param {object} io - `{stdout, stderr}`
 * @param {object} deps - `{env, fetch, clock, onStopSignal, local}`
 * @returns {Promise<number>} Exit code: 0 done or stopped, 3 refused
 */
async function cmdSample(flags, io, deps) {
  expectFlags(flags, ['home', 'api', 'out'], ['no-live-install', 'interval-ms', 'count', 'full-every']);
  const intervalMs = intFlag('interval-ms', flags['interval-ms']);
  const count = intFlag('count', flags.count);
  const fullEvery = intFlag('full-every', flags['full-every']);
  if (intervalMs !== undefined && intervalMs < 1000) throw new UsageError('--interval-ms must be at least 1000');
  if (count === 0 || fullEvery === 0) throw new UsageError('--count and --full-every must be at least 1');
  const admitted = await localLib.admitGuestReader({ noLiveInstall: noLiveInstallFlag(flags, deps), home: flags.home, apiBase: flags.api }, deps.local);
  let stop = false;
  deps.onStopSignal(() => { stop = true; });
  try {
    const result = await integrityLib.runSampler({
      file: flags.out,
      home: admitted.home,
      apiBase: new URL(flags.api).href,
      token: deps.env.TANGLECLAW_SERVICE_TOKEN || null,
      fetch: deps.fetch,
      intervalMs: intervalMs || integrityLib.INTERVAL_MS,
      count,
      fullEvery,
      clock: deps.clock,
      shouldStop: () => stop,
      run: admitted.run
    });
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    if (!['SAMPLER_LOCKED', 'SAMPLES_MISMATCH', 'SAMPLES_TORN', 'SAMPLES_UNREADABLE'].includes(err.code)) throw err;
    io.stderr.write(`${JSON.stringify({ code: err.code, message: err.message })}\n`);
    return 3;
  }
}

/**
 * `bundle`: gather a run's evidence into a new directory with a manifest.
 * @param {Object<string, string|boolean>} flags - Flags
 * @param {object} io - `{stdout, stderr}`
 * @param {object} deps - `{env, clock, local}`
 * @returns {Promise<number>} Exit code: 0 written, 3 refused
 */
async function cmdBundle(flags, io, deps) {
  expectFlags(flags, ['out', 'schedule', 'log'], ['samples', 'attestations', 'home', 'no-live-install']);
  const noLiveInstall = noLiveInstallFlag(flags, deps);
  if (noLiveInstall && flags.home === undefined) throw new UsageError('--no-live-install is only for a bundle with --home');
  let home;
  if (flags.home !== undefined) home = (await localLib.admitGuestReader({ noLiveInstall, home: flags.home }, deps.local)).home;
  const attestations = flags.attestations === undefined ? [] : flags.attestations.split(',').map((x) => x.trim()).filter(Boolean);
  try {
    const r = bundleLib.buildBundle({ out: flags.out, schedule: flags.schedule, log: flags.log, samples: flags.samples, home, attestations, now: deps.clock.now });
    io.stdout.write(`${JSON.stringify({ out: r.out, manifest: r.manifest, manifestSha256: r.manifestSha256 })}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof bundleLib.BundleRefusal)) throw err;
    io.stderr.write(`${JSON.stringify({ code: err.code, message: err.message })}\n`);
    return 3;
  }
}

/**
 * Entry point, with every side effect injectable for tests.
 * @param {string[]} argv - Arguments after the script name
 * @param {object} [deps] - `{stdout, stderr, env, fetch, lookup, clock, onStopSignal, local}`; `local` reaches `requireLocalControl` (`{fs, run, uid}`)
 * @returns {Promise<number>} Exit code
 */
async function main(argv, deps = {}) {
  const io = { stdout: deps.stdout || process.stdout, stderr: deps.stderr || process.stderr };
  const full = {
    env: deps.env || process.env,
    fetch: deps.fetch || globalThis.fetch,
    lookup: deps.lookup,
    clock: deps.clock || { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    onStopSignal: deps.onStopSignal || ((fn) => { process.once('SIGINT', fn); process.once('SIGTERM', fn); }),
    local: deps.local
  };
  const [command, ...rest] = argv;
  try {
    const flags = parseFlags(rest);
    if (command === 'plan') return cmdPlan(flags, io);
    if (command === 'validate') return cmdValidate(flags, io);
    if (command === 'run') return await cmdRun(flags, io, full);
    if (command === 'repos') return cmdRepos(flags, io);
    if (command === 'sample') return await cmdSample(flags, io, full);
    if (command === 'bundle') return await cmdBundle(flags, io, full);
    throw new UsageError(command ? `unknown command: ${command}` : 'a command is required');
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`${err.message}\n${USAGE}\n`);
      return 2;
    }
    if (err instanceof driver.DriverRefusal) {
      // A lock lost during a run that also failed rides along as a secondary
      // fact; the primary refusal stays the headline.
      io.stderr.write(`${JSON.stringify({ code: err.code, message: err.message, details: err.details, ...(err.lockLost ? { lockLost: err.lockLost } : {}), ...(err.ownershipUnverified ? { ownershipUnverified: err.ownershipUnverified } : {}), ...(err.recoveryPending ? { recoveryPending: err.recoveryPending } : {}), ...(err.lockReleaseFailed ? { lockReleaseFailed: err.lockReleaseFailed } : {}), ...(err.segmentCloseFailed ? { segmentCloseFailed: err.segmentCloseFailed } : {}), ...(err.lockRelease ? { lockRelease: err.lockRelease } : {}) })}\n`);
      return 3;
    }
    throw err;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { main, parseFlags, USAGE, RUN_EXECUTORS };
