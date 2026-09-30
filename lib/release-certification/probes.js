'use strict';

/**
 * The probes a certification runner samples with.
 *
 * Each probe turns one source into the structured observation the state
 * machine judges (`lib/release-certification/state-machine.js` documents the
 * shapes). A probe never throws and never guesses: a source it cannot reach
 * is `null`, and a field it cannot read is `null`, both of which extend the
 * run rather than count as healthy. Nothing here parses prose: every value
 * comes from a structured field of an API response or of git.
 *
 * A probe that returns nothing says why, as a closed code in the sample's
 * `diagnostics` (`http-401`, `timeout`, `connect-failed`, `bad-json`,
 * `gh-failed`, `worktree-<state>` ...), so an operator can tell a refused
 * token from a server that is down without guessing.
 *
 * Sources:
 * - the candidate worktree, through `lib/checkout-state.js#measure`;
 * - the server under test: `GET /api/server-info`, `GET /api/system/health`
 *   (the `ttyd-leak` condition's reading) and `GET /api/system/pty-activity`;
 * - GitHub, through the `gh` CLI: the check runs of each required check,
 *   asked for by name so no page limit can hide one, and the candidate's
 *   combined commit status, judged only for the checks the manifest pinned.
 *
 * @module lib/release-certification/probes
 */

const http = require('node:http');
const https = require('node:https');
const { execFile } = require('node:child_process');
const checkoutState = require('../checkout-state');
const { isCount: _isCount } = require('./formats');
const hostChecks = require('./host-checks');
const isolation = require('./isolation');

const REQUEST_TIMEOUT_MS = 10 * 1000;
const GH_TIMEOUT_MS = 20 * 1000;

/** Check-run conclusions GitHub reports as passing a required check. */
const PASSING = Object.freeze(['success', 'neutral', 'skipped']);
/**
 * Conclusions that are a confirmed failure. `cancelled` and `stale` are not:
 * the check never finished judging the commit, so it is still pending.
 */
const FAILING = Object.freeze(['failure', 'timed_out', 'startup_failure', 'action_required']);

/**
 * GET a JSON document from the server under test.
 * @param {object} opts - `{apiBase, token, ca}`
 * @param {string} route - Path beginning with /
 * @returns {Promise<{body: object|null, error: string|null}>} The body on 200, else why not
 */
function fetchJson(opts, route) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(route, opts.apiBase);
    } catch {
      resolve({ body: null, error: 'bad-url' });
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const headers = { accept: 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let timedOut = false;
    const req = client.get(url, { headers, timeout: REQUEST_TIMEOUT_MS, ca: opts.ca || undefined }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ body: null, error: `http-${res.statusCode}` });
        try {
          resolve({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')), error: null });
        } catch {
          resolve({ body: null, error: 'bad-json' });
        }
      });
      res.on('error', () => resolve({ body: null, error: 'connect-failed' }));
    });
    req.on('timeout', () => {
      timedOut = true;
      req.destroy();
    });
    req.on('error', () => resolve({ body: null, error: timedOut ? 'timeout' : 'connect-failed' }));
  });
}

/**
 * Run `gh` and parse its JSON output.
 * @param {string[]} args - Arguments
 * @param {string} [cwd] - Working directory
 * @returns {Promise<{body: object|null, error: string|null}>} Parsed output, else why not
 */
function ghJson(args, cwd) {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ body: null, error: err.killed ? 'gh-timeout' : 'gh-failed' });
      try {
        resolve({ body: JSON.parse(stdout), error: null });
      } catch {
        resolve({ body: null, error: 'bad-json' });
      }
    });
  });
}

/**
 * Parse an ISO timestamp or pass through epoch ms.
 * @param {*} v - Value
 * @returns {number|null} Epoch ms
 */
function _epoch(v) {
  if (_isCount(v)) return v;
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The worktree observation from a checkout measurement. Untracked files count
 * as dirty: a certified tree is exactly the commit.
 * @param {object} m - `checkout-state.measure` result
 * @returns {object|null} `{headSha, detached, dirty}`
 */
function worktreeObservation(m) {
  if (!m || m.state !== 'measured') return null;
  const counts = [m.dirtyTracked, m.untracked];
  const dirty = counts.some((c) => c === null || c === undefined) ? null : counts.some((c) => c > 0);
  return {
    headSha: typeof m.headSha === 'string' ? m.headSha : null,
    detached: typeof m.detached === 'boolean' ? m.detached : null,
    dirty
  };
}

/**
 * The server observation from `/api/server-info`.
 * @param {object|null} info - Response body
 * @returns {object|null} `{checkoutId, startupSha, shaBaselineSource, currentDiskSha, isStale, runningVersion, startedAt}`
 */
function serverObservation(info) {
  if (!info || typeof info !== 'object') return null;
  return {
    checkoutId: typeof info.checkoutId === 'string' ? info.checkoutId : null,
    currentDiskSha: typeof info.currentDiskSha === 'string' ? info.currentDiskSha : null,
    isStale: typeof info.isStale === 'boolean' ? info.isStale : null,
    startupSha: typeof info.startupSha === 'string' ? info.startupSha : null,
    shaBaselineSource: typeof info.shaBaselineSource === 'string' ? info.shaBaselineSource : null,
    runningVersion: typeof info.runningVersion === 'string' ? info.runningVersion : null,
    startedAt: _epoch(info.startedAt)
  };
}

/**
 * The owned-ttyd observation from `/api/system/health`.
 *
 * The server caches its ttyd reading, so a reading can be older than the
 * sample. An old reading cannot vouch that the ttyd is healthy now, so its
 * healthy values read unknown. Its failing values stand: a leak that fired, a
 * wedged child, a tripped orphan gate or a binary that is not the owned one
 * happened whenever the reading was taken.
 *
 * @param {object|null} health - Response body
 * @param {number} now - Epoch ms of the sample
 * @param {number} maxAgeMs - Oldest reading that may vouch for health
 * @returns {object|null} `{applicable, managed, generation, leakState, wedgedCount, orphanGate, poolUsed}`
 */
function ttydObservation(health, now, maxAgeMs) {
  if (!health || !Array.isArray(health.conditions)) return null;
  const cond = health.conditions.find((c) => c && c.id === 'ttyd-leak');
  if (!cond) return null;
  if (cond.applicable === false) return { applicable: false };
  const r = cond.reading || {};
  const sampledAt = _epoch(r.sampledAt);
  const fresh = sampledAt !== null && now - sampledAt <= maxAgeMs;
  let leakState = 'unknown';
  if (cond.state === 'fired') leakState = 'fired';
  else if (cond.state === 'clear' && fresh) leakState = 'clear';
  return {
    applicable: true,
    managed: r.managed === false ? false : (fresh && r.managed === true ? true : null),
    generation: fresh && typeof r.generation === 'string' ? r.generation : null,
    leakState,
    wedgedCount: _isCount(r.wedged) && (r.wedged > 0 || fresh) ? r.wedged : null,
    orphanGate: r.orphanGate === true ? true : (fresh && r.orphanGate === false ? false : null),
    poolUsed: fresh && r.pool && _isCount(r.pool.used) ? r.pool.used : null
  };
}

/**
 * The PTY-activity observation from `/api/system/pty-activity`.
 * @param {object|null} body - Response body
 * @returns {object|null} `{instance, attaches, detaches, lastAt}`
 */
function ptyObservation(body) {
  if (!body || typeof body !== 'object') return null;
  return {
    instance: typeof body.instance === 'string' ? body.instance : null,
    attaches: _isCount(body.attaches) ? body.attaches : null,
    detaches: _isCount(body.detaches) ? body.detaches : null,
    lastAt: body.lastAt === null ? null : _epoch(body.lastAt)
  };
}

/**
 * The state of one check run.
 * @param {object} run - A GitHub check run
 * @returns {string} success | failure | pending
 */
function _checkRunState(run) {
  if (run.status !== 'completed') return 'pending';
  if (PASSING.includes(run.conclusion)) return 'success';
  if (FAILING.includes(run.conclusion)) return 'failure';
  return 'pending';
}

/**
 * The state of one commit status.
 * @param {object} status - A GitHub commit status
 * @returns {string} success | failure | pending
 */
function _statusState(status) {
  if (status.state === 'success') return 'success';
  if (status.state === 'failure' || status.state === 'error') return 'failure';
  return 'pending';
}

/**
 * The GitHub observation from the candidate's check runs and commit status.
 * A required check is judged by its newest run (a re-run supersedes the one
 * before it); one with no run or status at all is `missing`.
 * @param {Object<string, object|null>} runsByName - For each required check, its `check-runs?check_name=` body
 * @param {object|null} statuses - `GET commits/<sha>/status` body
 * @param {string[]} required - Required check names
 * @returns {object} `{state, checks}`
 */
function githubObservation(runsByName, statuses, required) {
  const answered = required.every((n) => runsByName[n] && Array.isArray(runsByName[n].check_runs));
  if (!answered || !statuses || !Array.isArray(statuses.statuses)) return { state: 'unavailable', checks: null };
  const checks = {};
  for (const name of required) {
    const runs = runsByName[name].check_runs.filter((r) => r && r.name === name);
    const newestRun = runs.sort((a, b) => (b.id || 0) - (a.id || 0))[0];
    const status = statuses.statuses.find((s) => s && s.context === name);
    if (newestRun) checks[name] = _checkRunState(newestRun);
    else if (status) checks[name] = _statusState(status);
    else checks[name] = 'missing';
  }
  return { state: 'ok', checks };
}

/**
 * The checks main's branch protection requires, pinned into a manifest at admission.
 * @param {string} repo - `owner/name`
 * @param {function} [gh] - `ghJson` seam
 * @returns {Promise<string[]|null>} Check names, or null when they cannot be read
 */
async function requiredChecks(repo, gh = ghJson) {
  const { body } = await gh(['api', `repos/${repo}/branches/main/protection/required_status_checks`]);
  if (!body) return null;
  const names = new Set(Array.isArray(body.contexts) ? body.contexts : []);
  for (const c of Array.isArray(body.checks) ? body.checks : []) if (c && typeof c.context === 'string') names.add(c.context);
  return [...names].sort();
}

/**
 * The `owner/name` of the repository a worktree belongs to.
 * @param {string} worktreePath - Worktree
 * @param {function} [gh] - `ghJson` seam
 * @returns {Promise<string|null>} Repository, or null
 */
async function repository(worktreePath, gh = ghJson) {
  const { body } = await gh(['repo', 'view', '--json', 'nameWithOwner'], worktreePath);
  return body && typeof body.nameWithOwner === 'string' ? body.nameWithOwner : null;
}

/**
 * Read the candidate's required checks from GitHub and reduce them to the
 * observation the state machine judges. The runner calls this for each
 * sample in `gh` mode, and a host control plane calls it to answer a guest's
 * sample in `host-attested` mode, so both judge GitHub the same way.
 * @param {{repo: string, candidateSha: string, requiredChecks: string[]}} ctx - What to ask about
 * @param {function} [gh] - `ghJson` seam
 * @returns {Promise<{observation: object, error: string|null}>} The observation, and why GitHub gave nothing if it did not
 */
async function observeGithub(ctx, gh = ghJson) {
  const commit = `repos/${ctx.repo}/commits/${ctx.candidateSha}`;
  const [statuses, ...runs] = await Promise.all([
    gh(['api', `${commit}/status?per_page=100`]),
    ...ctx.requiredChecks.map((name) => gh(['api', `${commit}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`]))
  ]);
  const runsByName = Object.fromEntries(ctx.requiredChecks.map((name, i) => [name, runs[i].body]));
  const failed = [statuses, ...runs].find((r) => r.error);
  return { observation: githubObservation(runsByName, statuses.body, ctx.requiredChecks), error: failed ? failed.error : null };
}

/**
 * Build the probe set for one run.
 * @param {object} ctx
 * @param {string} ctx.apiBase - The server under test
 * @param {string} [ctx.token] - Bearer token, when the install gates its API
 * @param {Buffer|string} [ctx.ca] - CA for an https API
 * @param {string} ctx.worktreePath - Candidate worktree
 * @param {string} ctx.candidateSha - Candidate SHA
 * @param {string} ctx.repo - `owner/name`
 * @param {string[]} ctx.requiredChecks - Required check names
 * @param {number} ctx.maxReadingAgeMs - Oldest ttyd reading that may vouch for health
 * @param {string} [ctx.checksSource] - `gh` (default) or `host-attested`, where each sample's checks come from the host (`lib/release-certification/host-checks.js`)
 * @param {string} [ctx.exchangeDir] - Host-attested: the directory requests and verdicts are exchanged through
 * @param {string} [ctx.runId] - Host-attested: the run id the host minted
 * @param {number} [ctx.hostVerdictWaitMs] - Host-attested: how long a sample waits for its verdict
 * @param {string} [ctx.isolation] - `attested` when each sample must attest the guest's network isolation
 * @param {function(object): Promise<object>} [ctx.verifyNetwork] - The isolation producer (Chunk 1)
 * @param {object} [deps] - `{fetchJson, ghJson, measure, attest, verifyNetwork}` seams
 * @returns {{collect: function(number, object=): Promise<{observations: object, diagnostics: object, checks?: object}>}} `collect(now, binding)` gathers every observation and why any source gave none; host-attested, `binding` is `{seq, manifestDigest}` and a verified verdict's `checks` binding comes back with the sample
 */
function createProbes(ctx, deps = {}) {
  const get = deps.fetchJson || fetchJson;
  const gh = deps.ghJson || ghJson;
  const measure = deps.measure || checkoutState.measure;
  const api = { apiBase: ctx.apiBase, token: ctx.token, ca: ctx.ca };
  const hostAttested = ctx.checksSource === 'host-attested';
  return {
    async collect(now, binding) {
      // A guest's isolation is attested for this exact sample, alongside its
      // checks: the same binding, so neither can be replayed into another.
      const isoBinding = binding ? { candidateSha: ctx.candidateSha, runId: ctx.runId, manifestDigest: binding.manifestDigest, sampleSeq: binding.seq } : null;
      const [wt, info, health, pty, checks, iso] = await Promise.all([
        measure(ctx.worktreePath).catch(() => null),
        get(api, '/api/server-info'),
        get(api, '/api/system/health'),
        get(api, '/api/system/pty-activity'),
        // A host-attested runner never reads GitHub: the guest it runs in has
        // no route there. Its checks come from the host, bound to this sample.
        hostAttested
          ? (deps.attest || hostChecks.attest)(ctx, binding)
          : observeGithub({ repo: ctx.repo, candidateSha: ctx.candidateSha, requiredChecks: ctx.requiredChecks }, gh),
        ctx.isolation === 'attested' ? isolation.attest(deps.verifyNetwork || ctx.verifyNetwork, isoBinding) : null
      ]);
      const diagnostics = {};
      if (!wt || wt.state !== 'measured') diagnostics.worktree = `worktree-${wt ? wt.state : 'failed'}`;
      if (info.error) diagnostics.server = info.error;
      if (health.error) diagnostics.ttyd = health.error;
      if (pty.error) diagnostics.pty = pty.error;
      if (checks.error) diagnostics.github = checks.error;
      if (iso && iso.error) diagnostics.isolation = iso.error;
      // Why the producer failed, bounded and sanitized: private evidence in
      // the sample record, never published.
      if (iso && iso.detail) diagnostics.isolationDetail = iso.detail;
      const o = iso ? iso.observation : null;
      return {
        observations: {
          worktree: worktreeObservation(wt),
          server: serverObservation(info.body),
          ttyd: ttydObservation(health.body, now, ctx.maxReadingAgeMs),
          github: checks.observation,
          pty: ptyObservation(pty.body),
          ...(iso ? { isolation: o } : {})
        },
        diagnostics,
        ...(checks.binding ? { checks: checks.binding } : {}),
        ...(o && o.state !== 'unavailable' ? { isolation: o.state === 'breached' && o.breachDigest
          ? { sampleSeq: isoBinding.sampleSeq, bootId: o.bootId, breachDigest: o.breachDigest }
          : { sampleSeq: isoBinding.sampleSeq, bootId: o.bootId, adminDigest: o.adminDigest, workloadDigest: o.workloadDigest } } : {})
      };
    }
  };
}

module.exports = {
  fetchJson,
  ghJson,
  worktreeObservation,
  serverObservation,
  ttydObservation,
  ptyObservation,
  githubObservation,
  observeGithub,
  requiredChecks,
  repository,
  createProbes
};
