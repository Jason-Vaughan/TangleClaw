'use strict';

/**
 * The GitHub check for stranded wraps (#1542), and the record of every attempt,
 * including the ones that could not run (#1543).
 *
 * `lib/stranded-wraps.js` knows only what this machine recorded: a wrap branch
 * pushed with no pull request. It cannot see that the branch has since merged
 * or gone, that a wrap PR's CI went red, or that another machine left a `wrap/*`
 * branch with no PR. This module asks GitHub and does two things with the answer:
 *
 * - **Clears** a local item whose branch has a merged PR, is gone from `origin`
 *   with no open PR, or has an open PR whose checks all passed. A clear is a
 *   `wrap.strand_cleared` row; the item leaves the list and stops holding the
 *   launch.
 * - **Reports findings** that never hold anything: an open `wrap/*` PR with a
 *   failed check (`red-ci`), and a `wrap/*` branch on `origin` with no PR and no
 *   local record (`no-pr`). They are kept only inside the check row.
 *
 * Every attempt writes one `wrap.strand_check` row with an `outcome`:
 * - `ok` — every read answered; clears and findings are from this check.
 * - `failed` — a read could not run (`gh` or `git` missing, not signed in,
 *   offline, a timeout, output that could not be parsed). Nothing is cleared
 *   and nothing is reported: a branch missing from a read that failed part-way
 *   would look deleted and clear an item that still exists.
 * - `none` — there is nothing to check: no `origin` remote, or an `origin` that
 *   is not on github.com. A local-only project is not a failure, and saying
 *   "couldn't check" on every launch of one would teach the reader to ignore it.
 *
 * Every `gh` call names the repository (`--repo`) from `origin`: left to itself,
 * `gh` picks among remotes and prefers one named `upstream`, which is not where
 * this project's wrap branches are pushed.
 *
 * Checks run after a launch (skipped within five minutes of a definite answer)
 * and when the operator asks. There is no timer. The spawns run off the event
 * loop; nothing here blocks a request.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const store = require('./store');
const strandedWraps = require('./stranded-wraps');
const { hasFailingCheck, allChecksPassed } = require('./wrap-pr-status');
const { redactRemoteOutput, stripRemoteCredentials, REDACTED_PREFIX } = require('./remote-output');
const { createLogger } = require('./logger');

const log = createLogger('stranded-check');

const EVENT_CHECK = 'wrap.strand_check';
const WRAP_PREFIX = 'wrap/';
const EXEC_TIMEOUT_MS = 15000;
/** Parallel `gh` reads per check: quick enough, few enough not to trip a rate limit. */
const CONCURRENCY = 4;
/** Open wrap PRs read in one call. */
const OPEN_PR_LIMIT = 100;
/** How recent a definite answer lets a launch skip its check. */
const LAUNCH_SKIP_MS = 5 * 60 * 1000;
/** Rows read to find the latest attempts; above the store's per-type retention. */
const QUERY_LIMIT = 1000;
const PR_FIELDS = 'number,state,headRefName,headRefOid,url,statusCheckRollup';

/**
 * Thin `execFile` wrapper — resolves to `{exitCode, stdout, stderr, error}`,
 * never rejects. Prompts are disabled: a check that waits on a password prompt
 * only ever ends in its timeout.
 * @param {string} file - Executable
 * @param {string[]} args - Arguments
 * @param {{cwd: string}} options - Working directory
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, error: (Error|null)}>}
 */
function defaultExec(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: options && options.cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
    }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ exitCode, stdout: (stdout || '').toString(), stderr: (stderr || '').toString(), error: err || null });
    });
  });
}

const _internal = {
  exec: defaultExec,
  now: () => Date.now(),
  /**
   * Whether a directory exists; swappable for tests.
   * @param {string} dir
   * @returns {boolean}
   */
  dirExists: (dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
  /**
   * Read activity rows; swappable so a test can make the read fail.
   * @param {object} options - `store.activity.query` options
   * @returns {object[]}
   */
  query: (options) => store.activity.query(options),
  /**
   * Write an activity row. The store swallows its own failures.
   * @param {object} event - `store.activity.log` event
   */
  log: (event) => store.activity.log(event),
  FINDINGS_CAP: 20,
  /** Unrecorded wrap branches looked up per check; the rest are counted as unchecked. */
  NO_PR_LOOKUP_CAP: 30
};

/** @type {Map<number, Promise<object>>} */
const _running = new Map();

/**
 * A failed read, carried to the top of the check.
 */
class ReadFailed extends Error {}

/**
 * A one-line, redacted reason from a failed exec.
 * @param {{exitCode: number, stderr: string, stdout: string, error: (Error|null)}} r
 * @param {string} what - The command, e.g. `gh pr list`
 * @returns {string}
 */
function _reasonFrom(r, what) {
  const bin = what.split(' ')[0];
  if (r.error && r.error.code === 'ENOENT') return `${bin} is not installed`;
  if (r.error && (r.error.killed || r.error.signal === 'SIGTERM')) return `${what} timed out after ${EXEC_TIMEOUT_MS}ms`;
  const line = `${r.stderr || ''}\n${r.stdout || ''}`.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  // Both commands reach a remote, so their output can echo a tokenised URL, and
  // this reason is stored and shown to the operator.
  const safe = redactRemoteOutput(line);
  if (safe && safe.startsWith(REDACTED_PREFIX)) return `${what} failed (exit ${r.exitCode}): ${safe}`;
  return safe ? `${what} failed: ${safe}` : `${what} failed (exit ${r.exitCode})`;
}

/**
 * The `gh --repo` value for a remote URL, or null when the URL is not a
 * github.com repository. Reads https, ssh and scp-style URLs, with or without
 * credentials, a port or a `.git` suffix.
 * @param {string|null|undefined} url
 * @returns {string|null} e.g. `github.com/owner/repo`
 */
function repoOf(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const u = url.trim();
  let host;
  let pathPart;
  const scp = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(u);
  const full = /^(?:https?|ssh|git):\/\/(?:[^@/\s]*@)?([^/:\s]+)(?::\d+)?\/(.+)$/.exec(u);
  if (full) {
    host = full[1];
    pathPart = full[2];
  } else if (scp) {
    host = scp[1];
    pathPart = scp[2];
  } else {
    return null;
  }
  host = host.toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com') return null;
  const parts = pathPart.replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (parts.length !== 2) return null;
  const valid = (s) => /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(s) && s !== '.' && s !== '..';
  if (!parts.every(valid)) return null;
  return `${host}/${parts[0]}/${parts[1]}`;
}

/**
 * Run one read and parse its JSON, or throw {@link ReadFailed}.
 * @param {string} cwd
 * @param {string[]} args - `gh` arguments
 * @param {string} what - For the reason
 * @returns {Promise<object[]>}
 */
async function _ghJson(cwd, args, what) {
  const r = await _internal.exec('gh', args, { cwd });
  if (r.exitCode !== 0 || r.error) throw new ReadFailed(_reasonFrom(r, what));
  let data;
  try {
    data = JSON.parse(r.stdout || '');
  } catch (err) {
    throw new ReadFailed(`could not parse ${what} output: ${err.message}`);
  }
  if (!Array.isArray(data)) throw new ReadFailed(`could not parse ${what} output: expected a list`);
  return data.filter((p) => p && typeof p === 'object' && typeof p.headRefName === 'string');
}

/**
 * Every PR whose head is `branch`, in any state.
 * @param {string} cwd
 * @param {string} repo
 * @param {string} branch
 * @returns {Promise<object[]>}
 */
function _prsForBranch(cwd, repo, branch) {
  return _ghJson(cwd, [
    'pr', 'list', '--repo', repo, '--state', 'all', `--head=${branch}`, '--limit', '20', '--json', PR_FIELDS
  ], 'gh pr list --head').then((prs) => prs.filter((p) => p.headRefName === branch));
}

/**
 * Map over items with at most {@link CONCURRENCY} running at once. Rejects with
 * the first failure.
 * @template T, R
 * @param {T[]} items
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function _mapLimited(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    out.push(...await Promise.all(items.slice(i, i + CONCURRENCY).map(fn)));
  }
  return out;
}

/**
 * The `wrap/*` branches on origin, as `{branch: sha}`.
 * @param {string} cwd
 * @returns {Promise<Map<string, string>>}
 */
async function _remoteBranches(cwd) {
  const r = await _internal.exec('git', ['ls-remote', '--heads', 'origin', `refs/heads/${WRAP_PREFIX}*`], { cwd });
  if (r.exitCode !== 0 || r.error) throw new ReadFailed(_reasonFrom(r, 'git ls-remote'));
  const branches = new Map();
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/.exec(line.trim());
    if (!m) throw new ReadFailed(`could not parse git ls-remote output: ${JSON.stringify(line.slice(0, 80))}`);
    branches.set(m[2], m[1]);
  }
  return branches;
}

/**
 * Why a local item is dealt with, or null when it is not.
 * @param {object[]} prs - Every PR for the item's branch
 * @param {boolean} onRemote - Whether the branch is on origin now
 * @returns {{reason: 'merged'|'deleted'|'green', prUrl: string|null}|null}
 */
function _clearReason(prs, onRemote) {
  const merged = prs.find((p) => String(p.state).toUpperCase() === 'MERGED');
  if (merged) return { reason: 'merged', prUrl: merged.url || null };
  const open = prs.filter((p) => String(p.state).toUpperCase() === 'OPEN');
  const green = open.find((p) => allChecksPassed(p.statusCheckRollup));
  if (green) return { reason: 'green', prUrl: green.url || null };
  if (open.length === 0 && !onRemote) return { reason: 'deleted', prUrl: null };
  return null;
}

/**
 * The reads and decisions of one check. Throws {@link ReadFailed} when a read
 * could not run, and whatever the store throws.
 * @param {object} project
 * @param {string} at - ISO time of the check
 * @returns {Promise<object>} The result, without the row bookkeeping
 */
async function _examine(project, at) {
  const cwd = project.path;
  // execFile reports a missing cwd as ENOENT too, so say which one it was.
  if (!cwd || !_internal.dirExists(cwd)) throw new ReadFailed(`the project folder is missing (${cwd || 'no path'})`);
  const origin = await _internal.exec('git', ['remote', 'get-url', 'origin'], { cwd });
  if (origin.error && (origin.error.code === 'ENOENT' || origin.error.killed || origin.error.signal
      || typeof origin.error.code === 'string')) {
    // Could not run, or did not finish: that is not an answer about the remote.
    throw new ReadFailed(_reasonFrom(origin, 'git remote get-url'));
  }
  // `git remote get-url` exits 2 for "no such remote"; anything else (not a
  // repository, a broken config) is also a definite "nothing to check here".
  if (origin.exitCode !== 0 || !origin.stdout.trim()) {
    return { state: 'none', remote: null, reason: 'no origin remote' };
  }
  const originUrl = origin.stdout.trim();
  const remote = stripRemoteCredentials(originUrl);
  const repo = repoOf(originUrl);
  if (!repo) return { state: 'none', remote, reason: 'origin is not a GitHub remote' };

  try {
    return await _examineRepo(project, at, cwd, remote, repo);
  } catch (err) {
    // A failed check still says which remote it was checking.
    if (err instanceof ReadFailed) err.remote = remote;
    throw err;
  }
}

/**
 * The GitHub reads and decisions for a project whose origin is on github.com.
 * @param {object} project
 * @param {string} at - ISO time of the check
 * @param {string} cwd - Project directory
 * @param {string} remote - `origin` without credentials
 * @param {string} repo - `gh --repo` value
 * @returns {Promise<object>}
 */
async function _examineRepo(project, at, cwd, remote, repo) {
  // Every read happens before anything is decided, so a failure leaves nothing half-done.
  const branches = await _remoteBranches(cwd);
  const openPrs = (await _ghJson(cwd, [
    'pr', 'list', '--repo', repo, '--state', 'open', '--search', `head:${WRAP_PREFIX}`,
    '--limit', String(OPEN_PR_LIMIT), '--json', PR_FIELDS
  ], 'gh pr list')).filter((p) => p.headRefName.startsWith(WRAP_PREFIX));

  const items = strandedWraps.list(project).items
    .filter((i) => i.remote === remote || (i.grandfathered && i.remote === null));
  const itemPrs = await _mapLimited(items, (i) => _prsForBranch(cwd, repo, i.branch));

  const recorded = new Set(strandedWraps.list(project).items.map((i) => i.branch));
  const openBranches = new Set(openPrs.map((p) => p.headRefName));
  const candidates = [...branches.keys()].filter((b) => !recorded.has(b) && !openBranches.has(b)).sort();
  const lookedUp = candidates.slice(0, _internal.NO_PR_LOOKUP_CAP);
  const candidatePrs = await _mapLimited(lookedUp, (b) => _prsForBranch(cwd, repo, b));

  const toClear = [];
  items.forEach((item, n) => {
    const why = _clearReason(itemPrs[n], branches.has(item.branch));
    if (why) toClear.push({ remote: item.remote, branch: item.branch, headSha: item.headSha, ...why });
  });

  const findings = [
    ...openPrs.filter((p) => hasFailingCheck(p.statusCheckRollup)).map((p) => ({
      kind: 'red-ci', scope: 'repo', branch: p.headRefName, headSha: p.headRefOid || null,
      prNumber: p.number ?? null, prUrl: p.url || null
    })),
    ...lookedUp.filter((b, n) => candidatePrs[n].length === 0).map((b) => ({
      kind: 'no-pr', scope: 'repo', branch: b, headSha: branches.get(b) || null, prNumber: null, prUrl: null
    }))
  ];

  const saved = _applyClears(project, toClear, at);
  return {
    state: saved.ok ? 'ok' : 'failed',
    remote,
    reason: saved.ok ? null : saved.reason,
    checked: items.length,
    cleared: saved.cleared,
    findings: saved.ok ? findings : [],
    unchecked: candidates.length - lookedUp.length
  };
}

/**
 * Write the clears and confirm them by listing again: the store swallows write
 * failures, and a clear reported but not saved would say an item is gone while
 * it still holds the launch.
 * @param {object} project
 * @param {object[]} toClear
 * @param {string} at
 * @returns {{ok: boolean, cleared: object[], reason?: string}}
 */
function _applyClears(project, toClear, at) {
  if (toClear.length === 0) return { ok: true, cleared: [] };
  for (const c of toClear) strandedWraps.clear(project, { ...c, at });
  const still = new Set(strandedWraps.list(project).items.map((i) => JSON.stringify([i.remote, i.branch, i.headSha])));
  const cleared = toClear.filter((c) => !still.has(JSON.stringify([c.remote, c.branch, c.headSha])));
  if (cleared.length < toClear.length) {
    log.error('Stranded-wrap clear was not saved', { project: project.name, branches: toClear.map((c) => c.branch) });
    return { ok: false, cleared, reason: `${toClear.length - cleared.length} clear(s) could not be saved` };
  }
  return { ok: true, cleared };
}

/**
 * Run a check now and record it. Joins a check already running for the
 * project. Never rejects.
 *
 * @param {object} project - Project with `id`, `name` and `path`
 * @returns {Promise<{ok: boolean, state: 'ok'|'failed'|'none', reason: string|null, at: string,
 *   remote: string|null, cleared: object[], findings: object[], unchecked: number}>}
 */
function check(project) {
  const running = _running.get(project.id);
  if (running) return running;
  const p = _run(project).finally(() => _running.delete(project.id));
  _running.set(project.id, p);
  return p;
}

/**
 * One check, start to row.
 * @param {object} project
 * @returns {Promise<object>}
 */
async function _run(project) {
  const started = _internal.now();
  const at = new Date(started).toISOString();
  let result;
  try {
    result = await _examine(project, at);
  } catch (err) { // prawduct:allow prawduct/broad-except -- the check must record whatever went wrong as a failed attempt and never reject into the launch
    const reason = err instanceof ReadFailed ? err.message : `internal error: ${err && err.message ? err.message : String(err)}`;
    result = { state: 'failed', remote: (err && err.remote) || null, reason, checked: 0, cleared: [], findings: [], unchecked: 0 };
  }
  result = { checked: 0, cleared: [], findings: [], unchecked: 0, ...result };
  const detail = {
    remote: result.remote,
    outcome: result.state,
    ok: result.state === 'ok',
    reason: result.reason,
    at,
    durationMs: Math.max(0, _internal.now() - started),
    checked: result.checked || 0,
    cleared: result.cleared.length,
    findings: result.findings.slice(0, _internal.FINDINGS_CAP),
    findingsTotal: result.findings.length,
    // Per kind, so the card's counts stay right past the stored cap.
    redCiTotal: result.findings.filter((f) => f.kind === 'red-ci').length,
    noPrTotal: result.findings.filter((f) => f.kind === 'no-pr').length,
    unchecked: result.unchecked || 0
  };
  try {
    _internal.log({ projectId: project.id, eventType: EVENT_CHECK, detail });
  } catch (err) { // prawduct:allow prawduct/broad-except -- a row that could not be written must not turn the check into a rejection; it is logged
    log.error('Stranded-wrap check row could not be written', { project: project.name, error: err.message });
  }
  if (result.state === 'failed') {
    log.warn('Stranded-wrap GitHub check could not run', { project: project.name, reason: result.reason });
  } else if (result.cleared.length || result.findings.length) {
    log.info('Stranded-wrap GitHub check', {
      project: project.name, cleared: result.cleared.map((c) => [c.branch, c.reason]), findings: result.findings.length
    });
  }
  return {
    ok: result.state === 'ok',
    state: result.state,
    reason: result.reason,
    at,
    remote: result.remote,
    cleared: result.cleared,
    findings: result.findings,
    unchecked: result.unchecked || 0
  };
}

/**
 * This project's check rows, newest first.
 * @param {object} project
 * @returns {object[]}
 */
function _checkRows(project) {
  return _internal.query({ projectId: project.id, eventType: EVENT_CHECK, limit: QUERY_LIMIT })
    .filter((r) => r && r.detail && typeof r.detail.outcome === 'string')
    .sort((a, b) => b.id - a.id);
}

/**
 * The check a launch starts. Skipped (null) when a definite answer — `ok` or
 * `none` — is under five minutes old. Never rejects.
 * @param {object} project
 * @returns {Promise<object|null>}
 */
async function checkAfterLaunch(project) {
  try {
    const newest = _checkRows(project)[0];
    if (newest && newest.detail.outcome !== 'failed') {
      const age = _internal.now() - Date.parse(newest.detail.at);
      if (age >= 0 && age < LAUNCH_SKIP_MS) return null;
    }
  } catch (err) { // prawduct:allow prawduct/broad-except -- an unreadable store means no recent answer is known; the check runs and records its own failure
    log.warn('Could not read the last stranded-wrap check; checking anyway', { project: project.name, error: err.message });
  }
  return check(project);
}

/**
 * What the latest checks say, for the list route, the project list and the
 * prime. Findings come only from the latest `ok` check, with its time. Throws
 * when the store cannot be read.
 * @param {object} project - Project with `id`
 * @returns {{state: 'ok'|'failed'|'none'|'never', lastOkAt: string|null, lastAttemptAt: string|null,
 *   reason: string|null, findings: object[], findingsTotal: number, redCiTotal: number, noPrTotal: number,
 *   unchecked: number}}
 */
function status(project) {
  const rows = _checkRows(project);
  const newest = rows[0];
  if (!newest) {
    return {
      state: 'never', lastOkAt: null, lastAttemptAt: null, reason: null,
      findings: [], findingsTotal: 0, redCiTotal: 0, noPrTotal: 0, unchecked: 0
    };
  }
  const lastOk = rows.find((r) => r.detail.outcome === 'ok') || null;
  const d = lastOk ? lastOk.detail : null;
  return {
    state: newest.detail.outcome,
    lastOkAt: d ? d.at : null,
    lastAttemptAt: newest.detail.at || null,
    reason: newest.detail.outcome === 'ok' ? null : (newest.detail.reason || null),
    findings: d && Array.isArray(d.findings) ? d.findings : [],
    findingsTotal: d ? (Number(d.findingsTotal) || 0) : 0,
    redCiTotal: d ? (Number(d.redCiTotal) || 0) : 0,
    noPrTotal: d ? (Number(d.noPrTotal) || 0) : 0,
    unchecked: d ? (Number(d.unchecked) || 0) : 0
  };
}

/**
 * The counts the project list carries for the card.
 * @param {ReturnType<typeof status>} s
 * @returns {{state: string, lastOkAt: string|null, lastAttemptAt: string|null, reason: string|null,
 *   redCi: number, noPr: number, unchecked: number}}
 */
function summary(s) {
  return {
    state: s.state,
    lastOkAt: s.lastOkAt,
    lastAttemptAt: s.lastAttemptAt,
    reason: s.reason,
    redCi: s.redCiTotal || 0,
    noPr: s.noPrTotal || 0,
    unchecked: s.unchecked || 0
  };
}

/** PR opens in flight, by project id and branch, so a double press opens one. */
const _opening = new Set();

/**
 * A refusal from {@link openPr}.
 * @param {string} code
 * @param {string} error
 * @param {object} [extra]
 * @returns {{ok: false, code: string, error: string}}
 */
function _refuse(code, error, extra) {
  return { ok: false, code, error, ...(extra || {}) };
}

/**
 * The body of a PR opened from the cleanup path.
 * @param {string} branch
 * @param {string|null} by
 * @returns {string}
 */
function _cleanupPrBody(branch, by) {
  return [
    `A session wrap pushed \`${branch}\` but no pull request was opened for it at the time.`,
    '',
    `Opened from TangleClaw's stranded-wrap cleanup${by ? ` by ${by}` : ''}. Review it before merging:`,
    'the branch carries that wrap\'s version bump, CHANGELOG promotion and index files.'
  ].join('\n');
}

/**
 * Open a pull request for one listed stranded wrap (#1545), after checking
 * that GitHub still shows the branch as the list recorded it. The PR targets
 * the repository's default branch: the wrap's original base is not recorded.
 *
 * Every read happens before `gh pr create`, and any refusal or failure records
 * nothing. A PR that was opened is recorded as `wrap.strand_pr_opened` with who
 * opened it; the item stays listed until the GitHub check sees it merged or
 * green. Rejects only when the store cannot be read.
 *
 * @param {object} project - Project with `id`, `name` and `path`
 * @param {{branch?: string, headSha?: string|null, remote?: string|null, confirm?: boolean}} request
 * @param {string|null} by - Signed-in username, or null when not known
 * @returns {Promise<{ok: true, prUrl: string, item: object} |
 *   {ok: false, code: string, error: string, prUrl?: string}>}
 *   Codes: BAD_REQUEST, NOT_FOUND, IN_PROGRESS, NOT_GITHUB, REMOTE_MISMATCH, BRANCH_GONE,
 *   BRANCH_MOVED, PR_EXISTS, READ_FAILED, CREATE_FAILED, WRITE_FAILED.
 */
async function openPr(project, request, by) {
  const body = request || {};
  if (body.confirm !== true) {
    return _refuse('BAD_REQUEST', 'confirm: true is required: opening a pull request is visible on GitHub');
  }
  if (typeof body.branch !== 'string' || !body.branch) {
    return _refuse('BAD_REQUEST', 'branch (non-empty string) is required');
  }
  if (!(typeof body.headSha === 'string' || body.headSha === null)) {
    return _refuse('BAD_REQUEST', 'headSha is required: the SHA the item is listed at, or null for an older record with none');
  }
  if (body.remote !== undefined && body.remote !== null && typeof body.remote !== 'string') {
    return _refuse('BAD_REQUEST', 'remote, when given, must be a string, or null for an item listed with none');
  }
  const headSha = body.headSha || null;
  const wantRemote = body.remote === undefined ? undefined : stripRemoteCredentials(body.remote);
  const item = strandedWraps.list(project).items.find((i) => i.branch === body.branch
    && i.headSha === headSha && (wantRemote === undefined || i.remote === wantRemote));
  if (!item) {
    return _refuse('NOT_FOUND', `No stranded wrap is listed for branch "${body.branch}" at ${headSha ? `head ${headSha}` : 'no head SHA'}`);
  }

  const key = JSON.stringify([project.id, item.branch]);
  if (_opening.has(key)) return _refuse('IN_PROGRESS', `A pull request for ${item.branch} is already being opened`);
  _opening.add(key);
  try {
    return await _openPr(project, item, by);
  } finally {
    _opening.delete(key);
  }
}

/**
 * The reads, the create and the record for {@link openPr}.
 * @param {object} project
 * @param {object} item - The listed item
 * @param {string|null} by
 * @returns {Promise<object>}
 */
async function _openPr(project, item, by) {
  const cwd = project.path;
  const branch = item.branch;
  if (!cwd || !_internal.dirExists(cwd)) {
    return _refuse('READ_FAILED', `the project folder is missing (${cwd || 'no path'})`);
  }
  const origin = await _internal.exec('git', ['remote', 'get-url', 'origin'], { cwd });
  if (origin.error && (origin.error.code === 'ENOENT' || origin.error.killed || origin.error.signal
      || typeof origin.error.code === 'string')) {
    return _refuse('READ_FAILED', _reasonFrom(origin, 'git remote get-url'));
  }
  if (origin.exitCode !== 0 || !origin.stdout.trim()) {
    return _refuse('NOT_GITHUB', 'the project has no origin remote, so there is nowhere to open a pull request');
  }
  const originUrl = origin.stdout.trim();
  const remote = stripRemoteCredentials(originUrl);
  const repo = repoOf(originUrl);
  if (!repo) return _refuse('NOT_GITHUB', `origin is not a GitHub repository (${remote})`);
  if (item.remote && item.remote !== remote) {
    return _refuse('REMOTE_MISMATCH', `${branch} was recorded on ${item.remote}, but origin is now ${remote}`);
  }

  const ls = await _internal.exec('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { cwd });
  if (ls.exitCode !== 0 || ls.error) return _refuse('READ_FAILED', _reasonFrom(ls, 'git ls-remote'));
  const line = ls.stdout.split('\n').map((l) => l.trim()).find((l) => l.endsWith(`\trefs/heads/${branch}`));
  if (!line) {
    return _refuse('BRANCH_GONE', `${branch} is no longer on origin, so there is nothing to open a pull request for`);
  }
  const remoteSha = line.split('\t')[0];
  if (item.headSha && remoteSha !== item.headSha) {
    return _refuse('BRANCH_MOVED', `${branch} is at ${remoteSha} on origin, not ${item.headSha} as recorded; check the branch before opening a pull request`);
  }

  let open;
  try {
    open = (await _ghJson(cwd, [
      'pr', 'list', '--repo', repo, '--state', 'open', `--head=${branch}`, '--limit', '5', '--json', 'number,url,headRefName'
    ], 'gh pr list --head')).filter((p) => p.headRefName === branch);
  } catch (err) {
    if (err instanceof ReadFailed) return _refuse('READ_FAILED', err.message);
    throw err;
  }
  if (open.length > 0) {
    return _refuse('PR_EXISTS', `${branch} already has an open pull request: ${open[0].url || `#${open[0].number}`}`,
      { prUrl: open[0].url || null });
  }

  // Loaded here, not at the top: the wrap's commit step is large and only its
  // title builder is wanted, so a PR opened from here is titled like one the wrap opened.
  const { _buildSubject } = require('./wrap-steps/commit');
  const created = await _internal.exec('gh', [
    'pr', 'create', '--repo', repo, `--head=${branch}`,
    '--title', _buildSubject(branch), '--body', _cleanupPrBody(branch, by)
  ], { cwd });
  if (created.exitCode !== 0 || created.error) {
    const reason = _reasonFrom(created, 'gh pr create');
    const stopped = created.error && (created.error.killed || created.error.signal);
    return _refuse('CREATE_FAILED', stopped
      ? `${reason}. The request may have reached GitHub, so check for a pull request on ${branch} before trying again.`
      : reason);
  }
  const match = /https:\/\/\S+\/pull\/\d+/.exec(created.stdout || '');
  if (!match) {
    return _refuse('CREATE_FAILED', `gh pr create printed no pull request URL; check GitHub for a pull request on ${branch} before trying again`);
  }
  const prUrl = match[0];
  const at = new Date(_internal.now()).toISOString();
  strandedWraps.recordPrOpened(project, { remote: item.remote, branch, headSha: item.headSha, prUrl, by, at });
  const saved = strandedWraps.list(project).items.find((i) => i.branch === branch
    && i.headSha === item.headSha && i.remote === item.remote);
  if (!saved || !saved.prOpened || saved.prOpened.url !== prUrl) {
    log.error('Stranded-wrap PR was opened but not recorded', { project: project.name, branch, prUrl });
    return _refuse('WRITE_FAILED', `The pull request was opened (${prUrl}) but TangleClaw could not record it.`, { prUrl });
  }
  log.info('Opened a PR for a stranded wrap', { project: project.name, branch, prUrl, by });
  return { ok: true, prUrl, item: saved };
}

module.exports = {
  EVENT_CHECK,
  exec: defaultExec,
  openPr,
  check,
  checkAfterLaunch,
  status,
  summary,
  repoOf,
  _internal
};
