#!/usr/bin/env node
'use strict';

/**
 * Release-candidate certification CLI (#1949).
 *
 *   rc-cert start  --sha <40> --worktree <abs> [--required-check <name>]... [--repo owner/name]
 *   rc-cert run    --sha <40> [--interval <ms>]   (the repository and checks come from the manifest)
 *   rc-cert status --sha <40> [--json]
 *   rc-cert accept --sha <40> --actor <id>
 *   rc-cert cancel --sha <40> --actor <id>
 *   rc-cert publish --sha <40>   (publish the run's standing to the metrics branch now)
 *   rc-cert list
 *
 * Common flags: `--base <abs>` (evidence base; else config.json
 * `releaseCertification.baseDir`, else `<tangleclawHome>/release-certification/v1`),
 * `--api <url>` (the server under test; else `TANGLECLAW_API`), `--ca <file>`
 * (for an https API). A gated API's token is read from `TANGLECLAW_SERVICE_TOKEN`
 * only, never a flag, so it cannot show up in `ps`.
 *
 * `--thresholds <json>` on start overrides the judging thresholds for a smoke
 * run. Such a run reports `canonicalThresholds: false` and never certifies a
 * release.
 *
 * Exit codes: 0 done, 2 usage error, 3 refused (the refusal code is printed as
 * JSON on stderr).
 *
 * @module scripts/rc-cert
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tangleclawHome = require('../lib/tangleclaw-home');
const store = require('../lib/release-certification/store');
const sm = require('../lib/release-certification/state-machine');
const probesLib = require('../lib/release-certification/probes');
const runnerLib = require('../lib/release-certification/runner');
const publisherLib = require('../lib/release-certification/publisher');
const publicationLib = require('../lib/release-certification/publication');
const hostChecks = require('../lib/release-certification/host-checks');
const hostPublish = require('../lib/release-certification/host-publish');
const soakJudge = require('../lib/soak/judge');
const isolationLib = require('../lib/release-certification/isolation');
const { RUN_ID_RE } = require('../lib/release-certification/formats');
const { REFUSAL, CertificationError } = require('../lib/release-certification/codes');

const USAGE = [
  'usage: rc-cert start  --sha <40> --worktree <abs> [--repo owner/name] [--required-check <name>]... [--thresholds <json>] [--no-publish-actor]',
  '                      [--metrics-remote <abs>] [--checks-source host-attested --run-id <32 hex> --exchange <abs> --isolation-producer <abs>]   (host-attested needs --repo, --required-check and --metrics-remote)',
  '       rc-cert run    --sha <40> [--interval <ms 15000-120000>]',
  '       rc-cert status --sha <40> [--json]',
  '       rc-cert accept --sha <40> --actor <id>',
  '       rc-cert cancel --sha <40> --actor <id>',
  '       rc-cert publish --sha <40>',
  '       rc-cert list',
  'host:  rc-cert host-mint     --sha <40> --repo owner/name --required-check <name>... --host-base <abs>',
  '       rc-cert host-checks   --sha <40> --exchange <abs> --host-base <abs> [--watch --interval <ms>]',
  '       rc-cert host-finalize --sha <40> --host-base <abs> --soak-bundle <abs> [--soak-acceptance <abs json>] [--base <abs>]',
  '       rc-cert host-publish  --sha <40> --guest-metrics <abs> --remote <url> --host-base <abs>',
  'common: [--base <abs>] [--api <url>] [--ca <file>]; a gated API reads its token from TANGLECLAW_SERVICE_TOKEN'
].join('\n');
const REPEATABLE = new Set(['required-check']);

/** A malformed or incomplete command line: exit 2 with the usage text. */
class UsageError extends Error {}
const BOOLEAN = new Set(['json', 'no-publish-actor', 'watch']);

/**
 * Parse `--flag value` arguments.
 * @param {string[]} argv - Arguments after the command
 * @returns {object} Flags; repeatable flags are arrays
 */
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (name === 'token') throw new UsageError('--token is not accepted, because a flag is visible in `ps`; set TANGLECLAW_SERVICE_TOKEN');
    if (BOOLEAN.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    if (REPEATABLE.has(name)) (flags[name] = flags[name] || []).push(value);
    else flags[name] = value;
  }
  return flags;
}

/**
 * The evidence base: the flag, else the configured override, else the default.
 * A missing config.json means no override; one that cannot be parsed, or a
 * configured value that is not an absolute path, is refused, not ignored.
 * @param {object} flags - Parsed flags
 * @param {string} [configFile] - config.json path
 * @returns {string} Absolute base
 */
function resolveBase(flags, configFile = path.join(tangleclawHome.baseDir(), 'config.json')) {
  if (flags.base) return _absolute(flags.base, '--base');
  let text;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return store.defaultBase();
    throw new CertificationError(REFUSAL.STORE_UNSAFE, `config.json could not be read (${e.code || 'error'}), so releaseCertification.baseDir cannot be read`);
  }
  let configured;
  try {
    configured = JSON.parse(text).releaseCertification?.baseDir;
  } catch {
    // An unreadable config must not silently send evidence to the default
    // location while the operator believes it goes elsewhere.
    throw new CertificationError(REFUSAL.STORE_UNSAFE, 'config.json is not valid JSON, so releaseCertification.baseDir cannot be read');
  }
  if (configured === undefined || configured === null) return store.defaultBase();
  return _absolute(configured, 'releaseCertification.baseDir');
}

/**
 * Require an absolute path.
 * @param {*} p - Candidate
 * @param {string} what - Where it came from
 * @returns {string} The path
 */
function _absolute(p, what) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new CertificationError(REFUSAL.STORE_UNSAFE, `${what} must be an absolute path`);
  return p;
}

/**
 * Parse a flag that must be a JSON object.
 * @param {string} text - Flag value
 * @param {string} what - Flag name
 * @returns {object} Parsed object
 */
function _jsonObject(text, what) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError(`${what} must be a JSON object`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UsageError(`${what} must be a JSON object`);
  return value;
}

/**
 * Parse an optional integer flag.
 * @param {string|undefined} text - Flag value
 * @param {string} what - Flag name
 * @returns {number|undefined} The integer, or undefined when absent
 */
function _int(text, what) {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) throw new UsageError(`${what} must be a whole number`);
  return Number(text);
}

/**
 * Require a flag.
 * @param {object} flags - Parsed flags
 * @param {string} name - Flag name
 * @returns {string} Its value
 */
function _need(flags, name) {
  if (!flags[name]) throw new UsageError(`--${name} is required`);
  return flags[name];
}

/**
 * Probe context for a run.
 * @param {object} flags - Parsed flags
 * @param {object} env - Environment
 * @param {object} spec - `{sha, worktreePath, repo, requiredChecks, maxReadingAgeMs, checksSource?, runId?, exchangeDir?}`
 * @returns {object} Probe context
 */
function _probeCtx(flags, env, spec) {
  const apiBase = flags.api || env.TANGLECLAW_API;
  if (!apiBase) throw new UsageError('--api or TANGLECLAW_API is required');
  return {
    apiBase,
    // Environment only: a token on the command line is visible to every user in `ps`.
    token: env.TANGLECLAW_SERVICE_TOKEN || null,
    ca: flags.ca ? fs.readFileSync(flags.ca) : null,
    worktreePath: spec.worktreePath,
    candidateSha: spec.sha,
    repo: spec.repo,
    requiredChecks: spec.requiredChecks,
    maxReadingAgeMs: spec.maxReadingAgeMs,
    checksSource: spec.checksSource || 'gh',
    runId: spec.runId ?? null,
    exchangeDir: spec.exchangeDir ?? null,
    isolation: spec.isolationProducer ? 'attested' : 'none',
    verifyNetwork: spec.isolationProducer ? isolationLib.producer(spec.isolationProducer) : null
  };
}

/**
 * The commit identity used when a run withholds the operator's id: the
 * public branch's history must not name them either.
 */
const NEUTRAL_IDENTITY = Object.freeze({ name: 'TangleClaw release certification', email: 'release-certification@users.noreply.github.com' });

/**
 * The publication for a candidate. It publishes to the remote the run's
 * manifest pinned (or, at start, the worktree's origin), as the operator's
 * git identity unless the run withholds the operator's id.
 * @param {object} c - Command context
 * @param {string} sha - Candidate SHA
 * @param {{worktreePath: string, remoteUrl: string|null, publishActor: boolean}} where - Worktree, pinned remote, actor setting
 * @returns {Promise<object>} Publication
 */
async function _publication(c, sha, where) {
  if (c.deps.publication) return c.deps.publication;
  // Each git fact is read only when needed: the origin when no remote is
  // pinned, the identity only when the operator's id is published. A pinned
  // remote with the actor withheld needs no git config at all, as a guest may
  // have none.
  const remoteUrl = where.remoteUrl || await _repoRemote(c, where.worktreePath);
  const publisher = publisherLib.createPublisher({
    dir: path.join(c.base, '_metrics'),
    remoteUrl,
    identity: where.publishActor ? await _repoIdentity(c, where.worktreePath) : NEUTRAL_IDENTITY,
    onRecover: (fact) => c.emit({ event: 'recovered', ...fact })
  });
  return publicationLib.createPublication({ base: c.base, candidateSha: sha, publisher });
}

/**
 * The worktree's origin (`deps.repoFacts` stands in for both facts in tests).
 * @param {object} c - Command context
 * @param {string} worktreePath - Worktree
 * @returns {Promise<string>} Remote URL
 */
async function _repoRemote(c, worktreePath) {
  return c.deps.repoFacts ? (await c.deps.repoFacts(worktreePath)).remoteUrl : publisherLib.repoRemote(worktreePath);
}

/**
 * The operator's git identity (`deps.repoFacts` stands in for both facts in tests).
 * @param {object} c - Command context
 * @param {string} worktreePath - Worktree
 * @returns {Promise<{name: string, email: string}>} Identity
 */
async function _repoIdentity(c, worktreePath) {
  return c.deps.repoFacts ? (await c.deps.repoFacts(worktreePath)).identity : publisherLib.repoIdentity(worktreePath);
}

/**
 * The publication for a committed run, built on first use from the settings
 * its manifest pinned. The library owns the guarantee that a publisher which
 * cannot be built (no git identity or origin under launchd or cron) is
 * recorded and backed off, never stopping sampling (ADR 0021 point 4).
 * @param {object} c - Command context
 * @param {string} sha - Candidate SHA
 * @param {object} manifest - The run's manifest
 * @returns {object} `{publishCurrent, due, recordFailure, readStatus}`
 */
function _runPublication(c, sha, manifest) {
  return publicationLib.createDeferredPublication({ base: c.base, candidateSha: sha, build: () => _publication(c, sha, _pinned(manifest)) });
}

/**
 * Where a committed run publishes, from its manifest.
 * @param {object} manifest - The run's manifest
 * @returns {{worktreePath: string, remoteUrl: string|null, publishActor: boolean}} Publishing settings
 */
function _pinned(manifest) {
  return { worktreePath: manifest.private.worktreePath, remoteUrl: manifest.private.publishRemote || null, publishActor: manifest.publishActor !== false };
}

/**
 * `publish`: publish a run's standing now (also how a failed publish is retried by hand).
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code: 0 published, 3 not
 */
async function cmdPublish(c) {
  const sha = _need(c.flags, 'sha');
  const { manifest } = store.readRun(c.base, sha);
  const { published } = await _runPublication(c, sha, manifest).publishCurrent(c.emit);
  c.out.write(`${JSON.stringify({ published })}\n`);
  return published ? 0 : 3;
}

/**
 * `list`: the candidates with runs.
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code
 */
async function cmdList(c) {
  c.out.write(`${JSON.stringify(store.listRuns(c.base))}\n`);
  return 0;
}

/**
 * `status`: a run's structured health.
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code
 */
async function cmdStatus(c) {
  const sha = _need(c.flags, 'sha');
  const { manifest, state } = store.readRun(c.base, sha);
  const p = publicationLib.readStatus(c.base, sha);
  const publication = {
    admissionVerifiedAt: p.admission ? p.admission.verifiedAt : null,
    lastPublishedSeq: p.lastPublishedSeq, lastPublishedAt: p.lastPublishedAt,
    failures: p.failures, lastError: p.lastError, lastMessage: p.lastMessage ?? null, nextAttemptAt: p.nextAttemptAt
  };
  const summary = { ...sm.summarize(state, manifest, Date.now()), publication };
  c.out.write(c.flags.json ? `${JSON.stringify(summary)}\n` : _human(summary));
  return 0;
}

/**
 * `accept` / `cancel`: an operator decision, recorded with the actor.
 * @param {object} c - Command context
 * @param {function(object, string, number): object} op - `sm.accept` or `sm.cancel`
 * @returns {Promise<number>} Exit code
 */
async function cmdDecide(c, op) {
  const sha = _need(c.flags, 'sha');
  const actor = _need(c.flags, 'actor');
  const state = store.updateRun(c.base, sha, (s, manifest) => op(s, actor, Date.now(), manifest), { onRecover: (f) => c.emit({ event: 'recovered', ...f }) });
  // The decision is committed; publishing it is best effort and a failure is
  // recorded for retry (`rc-cert publish`), never undoing the decision.
  const { manifest } = store.readRun(c.base, sha);
  const { published } = await _runPublication(c, sha, manifest).publishCurrent(c.emit);
  c.out.write(`${JSON.stringify({ state: state.state, published })}\n`);
  return 0;
}

/**
 * The required checks for `start`, with where they came from: the flags
 * (`operator`), else main's branch protection. None at all is refused, since
 * GitHub could then never fail the candidate.
 * @param {object} c - Command context
 * @param {string} repo - `owner/name`
 * @returns {Promise<{checks: string[], source: string}>} Check names and their provenance
 */
async function _startChecks(c, repo) {
  if (c.flags['required-check']) return { checks: c.flags['required-check'], source: 'operator' };
  const checks = await (c.deps.requiredChecks || probesLib.requiredChecks)(repo);
  if (!checks) throw new UsageError('could not read main\'s required checks; pass --required-check <name> for each');
  if (checks.length === 0) throw new UsageError('main\'s branch protection requires no checks, so GitHub could never fail this candidate; pass --required-check <name>');
  return { checks, source: 'branch-protection' };
}

/**
 * `start`: admit a candidate.
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code
 */
async function cmdStart(c) {
  const sha = _need(c.flags, 'sha');
  const thresholds = c.flags.thresholds ? _jsonObject(c.flags.thresholds, '--thresholds') : undefined;
  const worktreePath = _absolute(_need(c.flags, 'worktree'), '--worktree');
  const checksSource = c.flags['checks-source'] || 'gh';
  if (!['gh', 'host-attested'].includes(checksSource)) throw new UsageError('--checks-source must be gh or host-attested');
  const hostAttested = checksSource === 'host-attested';
  // A host-attested runner has no route to GitHub, so everything it would
  // otherwise look up there comes from the host that minted its run id.
  if (hostAttested && (!c.flags.repo || !c.flags['required-check'] || !c.flags['run-id'] || !c.flags.exchange || !c.flags['isolation-producer'])) {
    throw new UsageError('--checks-source host-attested needs --repo, --required-check, --run-id and --exchange from the host, and --isolation-producer');
  }
  const isolationProducer = hostAttested ? _absolute(c.flags['isolation-producer'], '--isolation-producer') : null;
  if (c.flags['run-id'] !== undefined && !RUN_ID_RE.test(c.flags['run-id'])) throw new UsageError('--run-id must be 32 lowercase hex characters');
  // With `gh` checks this process is the host, so it mints the run id itself.
  const runId = c.flags['run-id'] || crypto.randomBytes(16).toString('hex');
  const exchangeDir = hostAttested ? _absolute(c.flags.exchange, '--exchange') : null;
  const repo = c.flags.repo || await (c.deps.repository || probesLib.repository)(worktreePath);
  if (!repo) throw new UsageError('could not determine the repository; pass --repo owner/name');
  const { checks: requiredChecks, source: requiredChecksSource } = await _startChecks(c, repo);
  const version = runnerLib.worktreeVersion(worktreePath);
  if (!version) throw new UsageError('the worktree has no readable version.json');
  const maxReadingAgeMs = { ...sm.DEFAULT_THRESHOLDS, ...thresholds }.maxIntervalMs;
  const probes = (c.deps.probes || probesLib.createProbes)(_probeCtx(c.flags, c.env, { sha, worktreePath, repo, requiredChecks, maxReadingAgeMs, checksSource, runId, exchangeDir, isolationProducer }));
  const publishActor = !c.flags['no-publish-actor'];
  // A guest publishes only to the local bare repository the host relays from.
  if (hostAttested && !c.flags['metrics-remote']) throw new UsageError('--checks-source host-attested needs --metrics-remote <abs>, the local bare repository the host relays from');
  let remoteUrl = null;
  if (c.flags['metrics-remote']) remoteUrl = _absolute(c.flags['metrics-remote'], '--metrics-remote');
  else if (!c.deps.publication) remoteUrl = await _repoRemote(c, worktreePath);
  const publication = await _publication(c, sha, { worktreePath, remoteUrl, publishActor });
  const runner = (c.deps.runner || runnerLib.createRunner)({ base: c.base, candidateSha: sha, probes, publication, log: c.emit });
  const state = await runner.start({
    version, repository: repo, worktreePath, requiredChecks, requiredChecksSource, thresholds,
    publishActor, remoteUrl, runId, checksSource, checksExchange: exchangeDir, isolationProducer
  });
  c.out.write(`${JSON.stringify({ state: state.state, candidateSha: sha })}\n`);
  return 0;
}

/**
 * `run`: sample until terminal or signalled. The repository, required checks
 * and reading age come from the manifest, never from a fresh lookup.
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code
 */
async function cmdRun(c) {
  const sha = _need(c.flags, 'sha');
  const intervalMs = _int(c.flags.interval, '--interval');
  if (intervalMs !== undefined) {
    try {
      runnerLib.resolveInterval(intervalMs);
    } catch (e) {
      throw new UsageError(e.message);
    }
  }
  const { manifest } = store.readRun(c.base, sha);
  const probes = (c.deps.probes || probesLib.createProbes)(_probeCtx(c.flags, c.env, {
    sha, worktreePath: manifest.private.worktreePath, repo: manifest.repository,
    requiredChecks: manifest.requiredChecks, maxReadingAgeMs: manifest.thresholds.maxIntervalMs,
    checksSource: manifest.checksSource, runId: manifest.runId, exchangeDir: manifest.private.checksExchange,
    isolationProducer: manifest.private.isolationProducer
  }));
  const publication = c.deps.publication || _runPublication(c, sha, manifest);
  const runner = (c.deps.runner || runnerLib.createRunner)({ base: c.base, candidateSha: sha, probes, publication, log: c.emit });
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (c.signal) c.signal.addEventListener('abort', stop, { once: true });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const state = await runner.run({ intervalMs, signal: controller.signal });
    c.out.write(`${JSON.stringify({ state: state.state })}\n`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (c.signal) c.signal.removeEventListener('abort', stop);
  }
  return 0;
}

/**
 * `host-mint`: mint a run id for a host-attested run, recording the
 * repository and checks the host will judge it by. Run on the host; the
 * printed id is passed to the guest's `start --run-id`.
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code
 */
async function cmdHostMint(c) {
  const sha = _need(c.flags, 'sha');
  const hostBase = _absolute(_need(c.flags, 'host-base'), '--host-base');
  const { runId } = hostChecks.mintRun(hostBase, { candidateSha: sha, repository: _need(c.flags, 'repo'), requiredChecks: _need(c.flags, 'required-check') });
  c.out.write(`${JSON.stringify({ runId })}\n`);
  return 0;
}

/**
 * `host-checks`: answer the guest's pending check requests from GitHub. Once
 * by default; with `--watch`, every `--interval` ms until signalled.
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code
 */
async function cmdHostChecks(c) {
  const sha = _need(c.flags, 'sha');
  const opts = {
    hostBase: _absolute(_need(c.flags, 'host-base'), '--host-base'),
    exchangeDir: _absolute(_need(c.flags, 'exchange'), '--exchange'),
    candidateSha: sha,
    observe: c.deps.observeGithub || ((ctx) => probesLib.observeGithub(ctx))
  };
  const once = async () => {
    const r = await hostChecks.answerRequests(opts);
    if (r.answered.length > 0 || r.skipped.length > 0) c.emit({ event: 'host-checks', ...r });
    // Reported on its own line, so a lapsed GitHub login is seen on the host,
    // not only in the guest's samples.
    for (const u of r.unavailable) c.emit({ event: 'host-github-unavailable', ...u });
  };
  if (!c.flags.watch) {
    await once();
    return 0;
  }
  const intervalMs = _int(c.flags.interval, '--interval') ?? 2000;
  while (!(c.signal && c.signal.aborted)) {
    try {
      await once();
    } catch (err) { // prawduct:allow prawduct/broad-except -- a supervisor loop: one failed pass is reported and the next still runs, or every later sample would read host-verdict-missing for the rest of the soak
      c.emit({ event: 'host-checks-failed', code: (err && err.code) || null, message: String((err && err.message) || '').slice(0, 300) });
    }
    await (c.deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(intervalMs);
  }
  return 0;
}

/**
 * Read the Operator's acceptance of an ownership-unverified soak log.
 * @param {string|undefined} file - `--soak-acceptance`, an absolute path to a JSON object
 * @returns {object|null} The acceptance, or null when none was given
 */
function _soakAcceptance(file) {
  if (file === undefined) return null;
  let text;
  try {
    text = fs.readFileSync(_absolute(file, '--soak-acceptance'), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'EISDIR') throw err;
    throw new UsageError(`--soak-acceptance ${file} is not a readable file`);
  }
  return _jsonObject(text, '--soak-acceptance');
}

/**
 * Judge the soak's evidence bundle for this run. A run with no host-minted
 * run id has no identity to bind a judgement to, so it gets none, and its
 * finalization fails for that as well as for not being host-attested.
 * @param {object} c - Command context
 * @param {object} manifest - The run's manifest
 * @param {object} state - The run's committed state
 * @returns {object|null} The judgement
 */
function _judgeSoak(c, manifest, state) {
  const bundleDir = _absolute(_need(c.flags, 'soak-bundle'), '--soak-bundle');
  const acceptance = _soakAcceptance(c.flags['soak-acceptance']);
  if (typeof manifest.runId !== 'string' || !RUN_ID_RE.test(manifest.runId)) return null;
  const judgeBundle = c.deps.judgeSoak || soakJudge.judgeBundle;
  return judgeBundle({
    bundleDir,
    run: { candidateSha: manifest.candidateSha, runId: manifest.runId, manifestDigest: state.manifestDigest, startedAt: state.startedAt, updatedAt: state.updatedAt },
    acceptance
  });
}

/**
 * `host-finalize`: join a finished host-attested run's exported evidence
 * against the host's ledger, read the checks once more, and judge the soak's
 * evidence bundle for this exact run. Exit 0 when the run's checks were
 * vouched for throughout and the soak passed, 3 otherwise.
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code
 */
async function cmdHostFinalize(c) {
  const sha = _need(c.flags, 'sha');
  const hostBase = _absolute(_need(c.flags, 'host-base'), '--host-base');
  const { manifest, state } = store.readRun(c.base, sha);
  const soakJudgement = _judgeSoak(c, manifest, state);
  const outcome = await hostChecks.finalize({
    hostBase,
    manifest,
    manifestDigest: state.manifestDigest,
    state,
    samples: store.readSamples(c.base, sha),
    observe: c.deps.observeGithub || ((ctx) => probesLib.observeGithub(ctx)),
    soakJudgement
  });
  c.out.write(`${JSON.stringify({ ...outcome, soak: soakJudgement })}\n`);
  return outcome.ok ? 0 : 3;
}

/**
 * `host-publish`: relay a finalized host-attested run's `metrics` branch from
 * the guest's local repository to the public remote, read it back, and record
 * whether it is a certification of record. Exit 0 relayed, 3 refused.
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code
 */
async function cmdHostPublish(c) {
  const record = await hostPublish.relay({
    hostBase: _absolute(_need(c.flags, 'host-base'), '--host-base'),
    candidateSha: _need(c.flags, 'sha'),
    guestMetrics: _absolute(_need(c.flags, 'guest-metrics'), '--guest-metrics'),
    remoteUrl: _need(c.flags, 'remote')
  });
  c.out.write(`${JSON.stringify(record)}\n`);
  return 0;
}

/** Each command's handler. */
const COMMANDS = Object.freeze({
  list: cmdList,
  status: cmdStatus,
  accept: (c) => cmdDecide(c, sm.accept),
  cancel: (c) => cmdDecide(c, sm.cancel),
  start: cmdStart,
  run: cmdRun,
  publish: cmdPublish,
  'host-mint': cmdHostMint,
  'host-checks': cmdHostChecks,
  'host-finalize': cmdHostFinalize,
  'host-publish': cmdHostPublish
});

/**
 * Run a command: parse, resolve the evidence base, dispatch, and turn a
 * refusal into exit 3 and a usage error into exit 2.
 * @param {string[]} argv - Command and flags
 * @param {object} [io] - `{stdout, stderr, env, configFile, signal, deps: {probes, runner, repository, requiredChecks}}`
 * @returns {Promise<number>} Exit code
 */
async function main(argv, io = {}) {
  const err = io.stderr || process.stderr;
  const [command, ...rest] = argv;
  try {
    const flags = parseFlags(rest);
    const handler = Object.prototype.hasOwnProperty.call(COMMANDS, command) ? COMMANDS[command] : null;
    if (!handler) throw new UsageError(`unknown command ${command || ''}`.trim());
    return await handler({
      flags,
      base: resolveBase(flags, io.configFile),
      out: io.stdout || process.stdout,
      env: io.env || process.env,
      deps: io.deps || {},
      signal: io.signal,
      emit: (obj) => err.write(`${JSON.stringify(obj)}\n`)
    });
  } catch (e) {
    if (e instanceof CertificationError) {
      err.write(`${JSON.stringify({ error: e.code, message: e.message, details: e.details })}\n`);
      return 3;
    }
    if (e instanceof UsageError) {
      err.write(`${e.message}\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }
}

/**
 * A short human summary.
 * @param {object} s - `summarize` result
 * @returns {string} Text
 */
function _human(s) {
  const h = (ms) => (ms / 3_600_000).toFixed(2);
  const lines = [
    `${s.candidateSha} ${s.version}: ${s.state}${s.canonicalThresholds ? '' : ' (non-canonical thresholds: cannot certify)'}`,
    `qualified ${h(s.qualifiedMs)}h of ${h(s.targetMs)}h, remaining ${h(s.remainingMs)}h, elapsed ${h(s.elapsedMs)}h${s.monitorStale ? ', MONITOR STALE' : ''}`,
    `pty ${s.pty.attaches}/${s.pty.target.attaches} attaches, ${s.pty.detaches}/${s.pty.target.detaches} detaches, span ${h(s.pty.spanMs)}h${s.pty.met ? ' (met)' : ''}`
  ];
  for (const [code, e] of Object.entries(s.extensions)) lines.push(`extended ${code}: ${e.intervals} interval(s), ${h(e.lostMs)}h`);
  if (s.failure) lines.push(`failed ${s.failure.code} at sample ${s.failure.sampleSeq}`);
  if (s.acceptance) lines.push(`accepted by ${s.acceptance.actor}`);
  if (s.cancellation) lines.push(`cancelled by ${s.cancellation.actor}`);
  const p = s.publication;
  if (p) lines.push(p.lastError ? `publishing FAILING: ${p.lastError} (${p.failures} in a row), next attempt ${p.nextAttemptAt}` : `published #${p.lastPublishedSeq} at ${p.lastPublishedAt}`);
  return `${lines.join('\n')}\n`;
}

module.exports = { main, parseFlags, resolveBase };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exitCode = 1;
  });
}
