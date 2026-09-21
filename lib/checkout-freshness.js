'use strict';

/**
 * Checkout freshness (#993, #1678) — what the live install is actually serving.
 *
 * TangleClaw's install is a git checkout that the server runs and serves
 * straight from its working tree. In that checkout "which branch is checked
 * out" is a production fact: an unreviewed branch, a detached HEAD, uncommitted
 * edits or untracked scratch files are all live to the operator. Before this
 * module, none of that was visible without a shell on the machine.
 *
 * This module reads the **local** half of that picture for any repo root —
 * branch or detached, HEAD, release tag, upstream ahead/behind, tracked changes,
 * untracked paths — and joins it with the **origin observation** that
 * `lib/behind-origin.js` takes. The result is one assessment: a list of
 * findings, each with a plain-text sentence. Every surface (the dashboard
 * banner, the session prime, `tc whoami`) renders those same sentences rather
 * than working freshness out for itself, so they cannot disagree.
 *
 * **Honest by construction.** A read that fails reports its reason and makes
 * the status `unknown`, never `ok`. An origin that was not observed, could not
 * be reached, or was observed against a HEAD that has since moved is said as
 * such. Nothing here reports "up to date" without a fresh observation behind it.
 *
 * **Reports only.** Nothing here pulls, checks out, stashes, restarts or
 * refuses to serve. #993 rules out enforcement at the server; blocking a
 * mutating workflow on these facts is a separate, later decision.
 *
 * **The root is a parameter.** The server passes its own directory today. When
 * the runtime moves out of an agent's checkout (#1672), only that argument
 * changes.
 *
 * **Cache + single-flight.** Local reads are cheap but not free (three short
 * git calls), so each root keeps one result for `LOCAL_TTL_MS` and concurrent
 * callers share one read. `readCached`, `snapshot` and `primeLines` never wait
 * on git — a stale entry only starts a background read — so the synchronous
 * prime generator can call them.
 *
 * @module lib/checkout-freshness
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileArgs, describeFailure } = require('./exec');
const { createLogger } = require('./logger');

const log = createLogger('checkout-freshness');

/** How long one local read is served before it is taken again. */
const LOCAL_TTL_MS = 30 * 1000;
/** Upper bound on each local git call. */
const LOCAL_GIT_TIMEOUT_MS = 5000;
/** The branch the live install is expected to be on. */
const EXPECTED_BRANCH = 'main';
/**
 * The checkout this server process runs from — the same fixed location
 * `lib/server-info.js` and `lib/behind-origin.js` read. The one place a moved
 * runtime (#1672) would change it.
 */
const LIVE_INSTALL_ROOT = path.resolve(__dirname, '..');

/** @type {Map<string, {at: number, result: object}>} */
const _cache = new Map();
/** @type {Map<string, Promise<object>>} */
const _inFlight = new Map();

/**
 * Run git in `cwd`. Never rejects; resolves to the shared exec result.
 *
 * `GIT_OPTIONAL_LOCKS=0` stops `git status` from taking the index lock to
 * refresh stat data: the live checkout is shared with working agent sessions,
 * and a read taken for a banner must never make their `git commit` fail on
 * `index.lock`.
 *
 * Under Node's test runner nothing is spawned — a route test must not run git
 * in the developer's checkout. Tests that want a real repository install their
 * own runner through `_internal.git`.
 *
 * @param {string[]} args - git arguments (argv form).
 * @param {string} cwd - Repo root.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, error: (string|null),
 *   errorCode: (string|null), signal: (string|null), timedOut: boolean}>}
 */
function defaultGit(args, cwd) {
  if (process.env.NODE_TEST_CONTEXT) {
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: '', error: 'git spawn blocked: node test runner',
      errorCode: 'BLOCKED', signal: null, timedOut: false });
  }
  return runGit(args, cwd);
}

/**
 * The real git runner, unguarded — `defaultGit` without the test-runner block.
 * @param {string[]} args - git arguments (argv form).
 * @param {string} cwd - Repo root.
 * @returns {Promise<object>} The shared exec result.
 */
function runGit(args, cwd) {
  return execFileArgs('git', args, {
    cwd, timeoutMs: LOCAL_GIT_TIMEOUT_MS, maxBufferBytes: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  });
}

/** Seams for tests: the git runner and the clock. */
const _internal = { git: defaultGit, now: () => Date.now() };

/**
 * Parse the `## ` header line of `git status --porcelain=v1 --branch`.
 *
 * Shapes git prints: `## main...origin/main [ahead 1, behind 2]`, `## main`
 * (no upstream), `## HEAD (no branch)` (detached), `## No commits yet on main`.
 * A `[gone]` upstream is reported as an upstream with unknown counts.
 *
 * @param {string} header - The line, with or without the leading `## `.
 * @returns {{branch: (string|null), detached: boolean, upstream: (string|null), ahead: (number|null),
 *   behind: (number|null), upstreamGone: boolean}}
 */
function parseBranchHeader(header) {
  const h = String(header || '').replace(/^## /, '').trim();
  const out = { branch: null, detached: false, upstream: null, ahead: null, behind: null, upstreamGone: false };
  if (/^HEAD \(no branch\)/.test(h)) {
    out.detached = true;
    return out;
  }
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(h);
  if (unborn) {
    out.branch = unborn[1];
    return out;
  }
  const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(h);
  if (!m) return out;
  out.branch = m[1];
  if (m[2]) {
    out.upstream = m[2];
    const track = m[3] || '';
    if (track === 'gone') {
      out.upstreamGone = true;
    } else {
      const a = /ahead (\d+)/.exec(track);
      const b = /behind (\d+)/.exec(track);
      out.ahead = a ? Number(a[1]) : 0;
      out.behind = b ? Number(b[1]) : 0;
    }
  }
  return out;
}

/**
 * Count tracked changes and untracked paths in porcelain v1 entries.
 * `??` is untracked; `!!` (ignored) never appears without `--ignored`; every
 * other entry is a tracked change (modified, added, deleted, renamed, conflicted).
 *
 * @param {string[]} entries - Status lines after the `## ` header.
 * @returns {{trackedChanges: number, untracked: number}}
 */
function countEntries(entries) {
  let trackedChanges = 0;
  let untracked = 0;
  for (const line of entries) {
    if (!line) continue;
    if (line.startsWith('??')) untracked++;
    else if (!line.startsWith('!!')) trackedChanges++;
  }
  return { trackedChanges, untracked };
}

/**
 * Read one checkout's local facts. Resolves — never rejects — to a record whose
 * `ok: false` names why; `notGit: true` marks the designed case of a directory
 * that is not a git checkout (a tarball install), which is not a fault.
 *
 * @param {string} repoRoot - The checkout to read.
 * @returns {Promise<object>} The local record.
 */
async function readLocal(repoRoot) {
  const readAt = new Date(_internal.now()).toISOString();
  const base = {
    repoRoot, ok: false, notGit: false, reason: null, headSha: null, branch: null, detached: false,
    releaseTag: null, upstream: null, ahead: null, behind: null, upstreamGone: false,
    trackedChanges: null, untracked: null, readAt
  };
  const status = await _internal.git(['status', '--porcelain=v1', '--branch', '--untracked-files=normal'], repoRoot);
  if (status.exitCode !== 0) {
    if (/not a git repository/i.test(status.stderr || '')) {
      return { ...base, notGit: true, reason: 'not a git checkout' };
    }
    return { ...base, reason: describeFailure(status, 'git status') };
  }
  const lines = String(status.stdout || '').split('\n');
  const header = parseBranchHeader(lines[0] || '');
  const counts = countEntries(lines.slice(1));

  const head = await _internal.git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], repoRoot);
  const headSha = head.exitCode === 0 ? String(head.stdout || '').trim() || null : null;

  let releaseTag = null;
  if (header.detached && headSha) {
    const tag = await _internal.git(['describe', '--tags', '--exact-match', 'HEAD'], repoRoot);
    if (tag.exitCode === 0) releaseTag = String(tag.stdout || '').trim() || null;
  }
  return { ...base, ok: true, ...header, ...counts, headSha, releaseTag };
}

/**
 * Take a fresh local read for `repoRoot` and cache it. Concurrent callers for
 * the same root share one read.
 *
 * @param {string} repoRoot
 * @returns {Promise<object>} The local record.
 */
function refresh(repoRoot) {
  const pending = _inFlight.get(repoRoot);
  if (pending) return pending;
  const p = readLocal(repoRoot).then((result) => {
    _cache.set(repoRoot, { at: _internal.now(), result });
    _inFlight.delete(repoRoot);
    if (!result.ok && !result.notGit) {
      log.warn('Checkout could not be read — freshness will say unknown, not current', {
        repoRoot, reason: result.reason
      });
    }
    return result;
  });
  _inFlight.set(repoRoot, p);
  return p;
}

/**
 * The cached local record, synchronously, or null when there is none yet. A
 * record older than the TTL is still returned (a stale read beats none) and
 * starts one background refresh.
 *
 * @param {string} repoRoot
 * @returns {object|null}
 */
function readCached(repoRoot) {
  const hit = _cache.get(repoRoot);
  if (!hit || _internal.now() - hit.at >= LOCAL_TTL_MS) {
    // Fire-and-forget: `refresh` never rejects.
    refresh(repoRoot);
  }
  return hit ? hit.result : null;
}

/**
 * Seven-character form of a SHA for sentences, or `unknown`.
 * @param {string|null|undefined} sha
 * @returns {string}
 */
function short(sha) {
  return sha ? String(sha).slice(0, 7) : 'unknown';
}

/**
 * Pluralise a count with its noun.
 * @param {number} n
 * @param {string} noun - Singular.
 * @returns {string}
 */
function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Findings about the checkout itself: where HEAD is and what is uncommitted.
 * @param {object} local - From `readLocal`.
 * @returns {Array<{code: string, severity: ('warn'|'unknown'|'info'), text: string}>}
 */
function _localFindings(local) {
  const f = [];
  if (local.detached) {
    if (!local.releaseTag) {
      f.push({ code: 'detached', severity: 'warn',
        text: `HEAD is detached at ${short(local.headSha)}, not on ${EXPECTED_BRANCH}, and that commit is not a release tag.` });
    }
  } else if (local.branch && local.branch !== EXPECTED_BRANCH) {
    f.push({ code: 'not-on-main', severity: 'warn',
      text: `The checkout is on branch "${local.branch}", not ${EXPECTED_BRANCH} — that branch is what is being served.` });
  }
  if (local.branch && !local.detached) {
    if (local.upstreamGone) {
      f.push({ code: 'upstream-gone', severity: 'unknown',
        text: `"${local.branch}" tracks ${local.upstream}, which no longer exists, so whether its commits are pushed is unknown.` });
    } else if (!local.upstream && local.branch !== EXPECTED_BRANCH) {
      f.push({ code: 'no-upstream', severity: 'unknown',
        text: `"${local.branch}" has no upstream, so whether its commits are pushed is unknown.` });
    } else if (local.ahead > 0) {
      f.push({ code: 'unpushed', severity: 'warn',
        text: `${plural(local.ahead, 'commit')} on "${local.branch}" ${local.ahead === 1 ? 'is' : 'are'} not pushed to ${local.upstream} — served, but never seen by CI.` });
    }
  }
  if (local.trackedChanges > 0) {
    f.push({ code: 'tracked-changes', severity: 'warn',
      text: `${plural(local.trackedChanges, 'tracked file')} ${local.trackedChanges === 1 ? 'has' : 'have'} uncommitted changes.` });
  }
  if (local.untracked > 0) {
    f.push({ code: 'untracked', severity: 'warn',
      text: `${plural(local.untracked, 'untracked path')} ${local.untracked === 1 ? 'is' : 'are'} in the checkout.` });
  }
  return f;
}

/**
 * Findings about the checkout's relation to origin/main, from the observation.
 * The relation is only stated when it was measured against the HEAD the
 * checkout has now; otherwise the finding says why it cannot be.
 *
 * @param {object} local - From `readLocal`.
 * @param {object} origin - From `behindOrigin.observation`.
 * @returns {Array<{code: string, severity: ('warn'|'unknown'|'info'), text: string}>}
 */
function _originFindings(local, origin) {
  const ref = (origin && origin.upstreamRef) || 'origin/main';
  if (!origin) return [{ code: 'origin-pending', severity: 'unknown', text: `${ref} has not been observed.` }];
  switch (origin.evidence) {
    case 'skipped':
      return [];
    case 'disabled':
      return [{ code: 'origin-disabled', severity: 'info',
        text: `The origin check is turned off for this install, so the relation to ${ref} is not measured.` }];
    case 'pending':
      return [{ code: 'origin-pending', severity: 'unknown',
        text: `${ref} has not been observed since the server started — the relation is unknown, not current.` }];
    case 'unavailable':
      return [{ code: 'origin-unavailable', severity: 'unknown',
        text: `${ref} could not be observed (${origin.reason}) — the relation is unknown, not current.` }];
    default:
      break;
  }
  if (origin.headSha && local.headSha && origin.headSha !== local.headSha) {
    return [{ code: 'origin-outdated', severity: 'unknown',
      text: `HEAD has moved since ${ref} was last compared (${short(origin.headSha)} → ${short(local.headSha)}); the relation is being re-measured.` }];
  }
  const f = [];
  const at = `${ref} is ${short(origin.originMainSha)}`;
  if (origin.relation === 'behind') {
    f.push({ code: 'behind-origin', severity: 'warn', text: `${plural(origin.behind, 'commit')} behind ${ref} (${at}).` });
  } else if (origin.relation === 'diverged') {
    f.push({ code: 'diverged', severity: 'warn',
      text: `Diverged from ${ref}: ${origin.ahead} ahead, ${origin.behind} behind (${at}).` });
  } else if (origin.relation === 'ahead') {
    f.push({ code: 'ahead-of-origin', severity: 'warn',
      text: `${plural(origin.ahead, 'commit')} ahead of ${ref} (${at}) — served, but not on ${ref}.` });
  }
  if (origin.evidence === 'stale') {
    f.push({ code: 'origin-stale', severity: 'unknown', text: `The ${ref} observation is stale: ${origin.reason}.` });
  }
  return f;
}

/**
 * Assess a checkout from its local record and origin observation.
 *
 * `status` is `attention` when any finding is a warning, `unknown` when nothing
 * warns but something could not be established, `ok` only when both halves were
 * read and nothing is wrong, and `not-a-checkout` for the designed no-git case.
 *
 * @param {object|null} local - From `readLocal`/`readCached`; null when not read yet.
 * @param {object|null} origin - From `behindOrigin.observation`.
 * @returns {{status: ('ok'|'attention'|'unknown'|'not-a-checkout'),
 *   findings: Array<{code: string, severity: string, text: string}>}}
 */
function assess(local, origin) {
  if (!local) {
    return { status: 'unknown', findings: [{ code: 'unread', severity: 'unknown',
      text: 'The checkout has not been read yet since the server started.' }] };
  }
  if (local.notGit) return { status: 'not-a-checkout', findings: [] };
  if (!local.ok) {
    return { status: 'unknown', findings: [{ code: 'unreadable', severity: 'unknown',
      text: `The checkout could not be read: ${local.reason}.` }] };
  }
  const findings = [..._localFindings(local), ..._originFindings(local, origin)];
  let status = 'ok';
  if (findings.some((f) => f.severity === 'warn')) status = 'attention';
  else if (findings.some((f) => f.severity === 'unknown')) status = 'unknown';
  return { status, findings };
}

/**
 * One line naming what is checked out and what origin/main was observed as —
 * the identity every surface prints above the findings.
 *
 * @param {object|null} local
 * @param {object|null} origin
 * @returns {string}
 */
function identityLine(local, origin) {
  if (!local || !local.ok) return `Checkout: ${local ? local.repoRoot : 'unread'}`;
  const where = local.detached
    ? `detached at ${short(local.headSha)}${local.releaseTag ? ` (release ${local.releaseTag})` : ''}`
    : `${local.branch} @ ${short(local.headSha)}`;
  let upstream = '';
  if (origin && origin.originMainSha) {
    upstream = `; ${origin.upstreamRef} ${short(origin.originMainSha)} (${origin.evidence}, observed ${origin.checkedAt})`;
  } else if (origin) {
    upstream = `; ${origin.upstreamRef} ${origin.evidence}`;
  }
  return `Checkout: ${local.repoRoot} — ${where}${upstream}`;
}

/**
 * The full snapshot for a checkout: the local record, the origin observation,
 * the assessment and the identity line. Synchronous and spawn-free (it may
 * start a background local refresh); the server-info route and the prime both
 * read it.
 *
 * @param {string} repoRoot
 * @param {object|null} origin - From `behindOrigin.observation`.
 * @returns {{repoRoot: string, local: (object|null), origin: (object|null), identity: string,
 *   status: string, findings: object[]}}
 */
function snapshot(repoRoot, origin) {
  const local = readCached(repoRoot);
  const { status, findings } = assess(local, origin);
  return { repoRoot, local, origin: origin || null, identity: identityLine(local, origin), status, findings };
}

/**
 * Prime / `tc` lines for a snapshot. An `ok` checkout gets one quiet line so
 * "checked and fine" is said rather than implied; a no-git install gets none.
 *
 * @param {object} snap - From `snapshot`.
 * @returns {string[]}
 */
function primeLines(snap) {
  if (!snap || snap.status === 'not-a-checkout') return [];
  if (snap.status === 'ok') {
    return [`_Live install checkout: current — ${snap.identity.replace(/^Checkout: /, '')}._`, ''];
  }
  const label = snap.status === 'attention' ? 'NEEDS ATTENTION' : 'UNKNOWN';
  return [
    `## Live install checkout: **${label}**`,
    snap.identity,
    ...snap.findings.map((f) => `- ${f.text}`),
    'This checkout is what the TangleClaw server runs and serves. These are facts to report, not a '
    + 'licence to act: do not pull, check out, stash or restart it without the authority your rules require.',
    ''
  ];
}

/**
 * Whether `projectPath` is the live install's checkout — the same directory once
 * symlinks are resolved. A path that cannot be resolved is not the live install.
 *
 * @param {string|null|undefined} projectPath
 * @param {string} repoRoot - The live install's root.
 * @returns {boolean}
 */
function isLiveInstall(projectPath, repoRoot) {
  if (!projectPath || !repoRoot) return false;
  try {
    return fs.realpathSync(path.resolve(projectPath)) === fs.realpathSync(path.resolve(repoRoot));
  } catch {
    return false;
  }
}

/**
 * The live install's snapshot, joined with the origin observation this process
 * takes for it. The one call every live-install surface makes.
 *
 * @param {object|null|undefined} config - Loaded global config (the origin
 *   check's opt-out lives there).
 * @returns {object} From `snapshot`.
 */
function liveInstallSnapshot(config) {
  return snapshot(LIVE_INSTALL_ROOT, require('./behind-origin').observation(config));
}

/**
 * Reset module state (tests only).
 */
function _reset() {
  _cache.clear();
  _inFlight.clear();
}

module.exports = {
  readLocal,
  refresh,
  readCached,
  assess,
  identityLine,
  snapshot,
  liveInstallSnapshot,
  primeLines,
  isLiveInstall,
  parseBranchHeader,
  countEntries,
  LOCAL_TTL_MS,
  EXPECTED_BRANCH,
  LIVE_INSTALL_ROOT,
  runGit,
  _internal,
  _reset
};
