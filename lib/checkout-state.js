'use strict';

/**
 * What a git checkout is actually on, and whether a range of commits changes
 * anything a running process loads (#993, #1678).
 *
 * TangleClaw's own clone is the running install: launchd runs `server.js` from
 * it and serves `public/` straight off its working tree. So "which branch is
 * checked out, with what uncommitted or untracked files" is a production fact
 * there, and the operator — almost never at this machine — cannot see it
 * without a shell. This module measures those facts so the dashboard can say
 * them.
 *
 * **Unknown is never green.** Every fact is a value or `null`, and a `null`
 * carries its reason in `incomplete`. A failed git call is never read as zero
 * uncommitted files, zero commits behind, or "on main" — those are the claims
 * an operator acts on, so a probe that could not make them must say so. The
 * one designed opt-out is `state: 'no-git'` (git missing, or the directory is
 * not a repository), which is a fact about the install rather than a failure.
 *
 * **Never synchronous, never on the request path.** Every git call goes
 * through `execFile` (argv form, no shell). `snapshot()` answers from a
 * per-directory cache at once and starts at most one background measurement
 * when the cache has expired, so N dashboard tabs polling cannot become N
 * `git status` runs, and the first poll after boot reads `state: 'pending'`.
 *
 * **Read-only.** Nothing here fetches, checks out, stashes or writes the
 * index: `git status` is run with `--no-optional-locks` so a poll never takes
 * the index lock from a session committing in the same checkout. The
 * `origin/main` SHA is whatever the local ref holds; how recently that ref was
 * fetched is the caller's knowledge (see `withUpstreamObservation`), not this
 * module's.
 *
 * **Restart impact.** `classifyRange(from, to)` answers "does a restart load
 * anything new?" for the commits between the SHA a process started on and the
 * SHA now on disk. A path is `records` only when it is on an explicit list of
 * paths no running process loads; every other path — including any new
 * top-level directory — is `executable`. The list errs toward a needless
 * restart rather than a missed one, and any failure is `unknown`, which the
 * dashboard never presents as records-only.
 *
 * @module lib/checkout-state
 */

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const gitProbe = require('./git-probe');

/** How long one measurement of a directory is served before it is re-measured. */
const CACHE_TTL_MS = 30 * 1000;

/** Upper bound on each local git call. */
const GIT_TIMEOUT_MS = gitProbe.LOCAL_TIMEOUT_MS;

/** The shared upstream target every checkout is compared against. */
const UPSTREAM_REF = 'origin/main';

/** The branch a live install is expected to be on. */
const DEFAULT_BRANCH = 'main';

/**
 * Path prefixes no running TangleClaw process loads. Changes confined to these
 * make a restart pointless. Deliberately short: `data/`, `.claude/`, `hooks/`,
 * `deploy/`, `bin/` and every unlisted directory count as executable, because
 * each is read by something live (the server, an engine hook, launchd).
 */
const RECORDS_PREFIXES = Object.freeze([
  'docs/',
  'test/',
  '.tangleclaw/plans/',
  '.prawduct/',
  '.github/'
]);

// dir -> { value, at } — the last completed measurement of each directory.
const _cache = new Map();
// dir -> Promise — the one in-flight measurement of each directory.
const _inFlight = new Map();
// range key -> the last completed classification. A known answer never
// changes and is served as is; an `unknown` one is served while a retry runs,
// so a failing range reports its failure instead of `pending` forever.
const _impactResults = new Map();
// range key -> Promise of the one in-flight classification.
const _impactInFlight = new Map();
/** Ranges remembered at once; each new on-disk HEAD adds one, so the oldest go. */
const IMPACT_RESULTS_MAX = 32;
// comparison key -> the last completed comparison against an observed SHA,
// and the one in-flight comparison. Same retention as the impact cache.
const _compareResults = new Map();
const _compareInFlight = new Map();

/**
 * Why the default git seam must not spawn, or null when it may.
 *
 * @returns {string|null}
 */
function _spawnBlockedReason() {
  return gitProbe.spawnBlockedReason();
}

/** Seam for tests. */
const _internal = {
  execFile: gitProbe.defaultExecFile,
  now: () => Date.now(),
  realpath: (p) => _canonical(p)
};

/**
 * Run one local git command in `cwd`. Resolves — never rejects.
 *
 * @param {Function} execFile - `child_process.execFile`-compatible.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ok: boolean, stdout: string, err: Error|null}>}
 */
function _git(execFile, cwd, args) {
  return gitProbe.runGit(execFile, cwd, args, { timeoutMs: GIT_TIMEOUT_MS });
}

const _isNoGit = gitProbe.isNoGit;
const _reason = gitProbe.failureReason;

/** Default port of each URL scheme a remote may use; a default port is not part of the identity. */
const DEFAULT_PORTS = Object.freeze({ ssh: '22', https: '443', http: '80', git: '9418' });

/**
 * A repository's identity from its origin URL, so two clones of one
 * repository compare equal however each was cloned.
 *
 * The host is lowercased; scp-style (`git@host:owner/repo`), `ssh://`,
 * `git://` and `http(s)://` forms of one repository give one identity; the
 * userinfo is removed (a token in a URL never reaches the identity or any
 * payload built from it), as are a default port, a `.git` suffix and trailing
 * slashes. The path keeps its case. A local path remote becomes
 * `file:<sha256 of its path>` — an opaque identity, because a payload built
 * from it may reach a caller who is not to learn where a repository lives.
 * The caller canonicalizes the path first ({@link _repository} resolves it
 * against the clone and through symlinks), so two clones naming one local
 * repository differently still agree.
 *
 * @param {string|null|undefined} url - The origin URL as git reports it.
 * @param {string} [baseDir] - The clone the URL was read from, for a relative path remote.
 * @returns {string|null} The identity, or null when the URL is unreadable.
 */
function normalizeRemoteUrl(url, baseDir) {
  const local = localRemotePath(url, baseDir);
  if (local) return localIdentity(local);
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (!u) return null;
  const tidy = (p) => p.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const full = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)(?::(\d+))?(\/.*)?$/i.exec(u);
  if (full) {
    const scheme = full[1].toLowerCase();
    const host = full[2].toLowerCase();
    const port = full[3] && full[3] !== DEFAULT_PORTS[scheme.replace(/^git\+/, '')] ? `:${full[3]}` : '';
    const p = tidy((full[4] || '').replace(/^\/+/, ''));
    if (!p) return null;
    return `${host}${port}/${p}`;
  }
  // scp-like: [user@]host:path — but not a Windows drive or a local path.
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u);
  if (scp && scp[1].length > 1) {
    const p = tidy(scp[2].replace(/^\/+/, ''));
    if (!p) return null;
    return `${scp[1].toLowerCase()}/${p}`;
  }
  return null;
}

/**
 * The filesystem path a local remote names — an absolute path, a path
 * relative to the clone, or a `file://` URL — resolved but not canonicalized;
 * null for a network remote.
 *
 * @param {string|null|undefined} url
 * @param {string} [baseDir]
 * @returns {string|null}
 */
function localRemotePath(url, baseDir) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  const tidy = (p) => p.replace(/\/+$/, '');
  const fileUrl = /^file:\/\/[^/]*(\/.*)$/i.exec(u);
  if (fileUrl) return path.resolve(decodeURIComponent(tidy(fileUrl[1])));
  if (u.startsWith('/')) return path.resolve(tidy(u));
  if (u.startsWith('.') && baseDir) return path.resolve(baseDir, tidy(u));
  return null;
}

/**
 * The opaque identity of a local repository path.
 *
 * @param {string} p - Canonical path.
 * @returns {string}
 */
function localIdentity(p) {
  return `file:${crypto.createHash('sha256').update(p.replace(/\.git$/i, '')).digest('hex')}`;
}

/** Upper bound on canonicalizing a local remote's path. */
const REALPATH_TIMEOUT_MS = 2000;

/**
 * Canonicalize a local remote's path through symlinks, bounded, falling back
 * to the resolved path when it cannot be read (the remote may be gone; its
 * identity is still the path the clone names).
 *
 * @param {string} p
 * @returns {Promise<string>}
 */
async function _canonical(p) {
  let timer;
  const bound = new Promise((resolve) => { timer = setTimeout(() => resolve(p), REALPATH_TIMEOUT_MS); });
  try {
    return await Promise.race([fs.promises.realpath(p).catch(() => p), bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the checkout's repository identity. No origin remote is a fact, not a
 * failure, and a failure never becomes "no remote".
 *
 * @param {Function} execFile
 * @param {string} dir
 * @returns {Promise<{identity: string|null, reason: string|null}>}
 */
async function _repository(execFile, dir) {
  const r = await _git(execFile, dir, ['remote', 'get-url', 'origin']);
  if (!r.ok) {
    const text = `${(r.err && r.err.message) || ''} ${(r.err && r.err.stderr) || ''}`;
    if (/no such remote/i.test(text) || (r.err && r.err.code === 2)) return { identity: null, reason: 'no origin remote' };
    return { identity: null, reason: _reason('origin url', r.err) };
  }
  const local = localRemotePath(r.stdout, dir);
  if (local) return { identity: localIdentity(await _internal.realpath(local)), reason: null };
  const identity = normalizeRemoteUrl(r.stdout, dir);
  return identity ? { identity, reason: null } : { identity: null, reason: 'origin url is not a form this reader knows' };
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 *
 * NUL-separated records. Headers are `# branch.*`; entries start with `1`
 * (ordinary change), `2` (rename or copy — followed by one more NUL-separated
 * field, the original path), `u` (unmerged), `?` (untracked) or `!` (ignored,
 * only when asked for, and never counted).
 *
 * @param {string} out
 * @returns {{oid: string|null, head: string|null, detached: boolean, upstream: string|null,
 *   upstreamAhead: number|null, upstreamBehind: number|null, dirtyTracked: number, untracked: number}}
 */
function parseStatusV2(out) {
  const result = {
    oid: null, head: null, detached: false, upstream: null,
    upstreamAhead: null, upstreamBehind: null, dirtyTracked: 0, untracked: 0
  };
  const fields = String(out || '').split('\0');
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec) continue;
    if (rec.startsWith('# ')) {
      const sp = rec.indexOf(' ', 2);
      const key = sp === -1 ? rec.slice(2) : rec.slice(2, sp);
      const val = sp === -1 ? '' : rec.slice(sp + 1);
      if (key === 'branch.oid') result.oid = /^[0-9a-f]{7,64}$/.test(val) ? val : null;
      else if (key === 'branch.head') {
        if (val === '(detached)') result.detached = true;
        else result.head = val || null;
      } else if (key === 'branch.upstream') result.upstream = val || null;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) { result.upstreamAhead = Number(m[1]); result.upstreamBehind = Number(m[2]); }
      }
      continue;
    }
    const kind = rec[0];
    if (kind === '1' || kind === 'u') result.dirtyTracked++;
    else if (kind === '2') { result.dirtyTracked++; i++; } // skip the original-path field
    else if (kind === '?') result.untracked++;
  }
  return result;
}

/**
 * Parse `git rev-list --left-right --count A...B` output ("<left>\t<right>").
 *
 * @param {string} out
 * @returns {{left: number, right: number}|null}
 */
function _parseLeftRight(out) {
  const m = /^(\d+)\s+(\d+)\s*$/.exec(String(out || '').trim());
  return m ? { left: Number(m[1]), right: Number(m[2]) } : null;
}

/**
 * Parse a single non-negative count.
 *
 * @param {string} out
 * @returns {number|null}
 */
function _parseCount(out) {
  const s = String(out || '').trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/**
 * Name the relation between HEAD and the upstream target.
 *
 * @param {number|null} ahead
 * @param {number|null} behind
 * @returns {'equal'|'ahead'|'behind'|'diverged'|'unknown'}
 */
function _relation(ahead, behind) {
  if (ahead === null || behind === null) return 'unknown';
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'ahead';
  if (behind > 0) return 'behind';
  return 'equal';
}

/**
 * Measure one checkout now. Resolves — never rejects.
 *
 * @param {string} dir - Absolute path to the checkout.
 * @param {object} [opts]
 * @param {Function} [opts.execFile] - Override the git seam (tests that need real git).
 * @returns {Promise<object>} The checkout payload, documented as `liveCheckout` under
 *   `GET /api/server-info` in `.prawduct/artifacts/api-contract.md`.
 */
async function measure(dir, opts = {}) {
  const execFile = opts.execFile || _internal.execFile;
  const measuredAt = new Date(_internal.now()).toISOString();
  const base = {
    state: 'unknown', reason: null, measuredAt,
    branch: null, detached: null, tag: null, onDefaultBranch: null, headSha: null,
    upstream: { ref: UPSTREAM_REF, sha: null },
    ahead: null, behind: null, relation: 'unknown',
    unpushed: { count: null, against: null },
    dirtyTracked: null, untracked: null,
    repository: { identity: null, reason: 'not read' },
    incomplete: []
  };

  const status = await _git(execFile, dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']);
  if (!status.ok) {
    if (_isNoGit(status.err)) {
      return { ...base, state: 'no-git', reason: 'not a git checkout', repository: { identity: null, reason: 'not a git checkout' } };
    }
    return {
      ...base, reason: _reason('git status', status.err), incomplete: ['status'],
      repository: { identity: null, reason: 'checkout unreadable' }
    };
  }
  const st = parseStatusV2(status.stdout);
  const out = {
    ...base,
    state: 'measured',
    headSha: st.oid,
    detached: st.detached,
    branch: st.detached ? null : st.head,
    onDefaultBranch: st.detached ? false : (st.head ? st.head === DEFAULT_BRANCH : null),
    dirtyTracked: st.dirtyTracked,
    untracked: st.untracked
  };
  const incomplete = [];
  if (!st.oid) incomplete.push('headSha: no commit yet or unreadable');

  if (st.detached) {
    // Exit 128 with "no tag exactly matches" is the ordinary answer for a
    // detached HEAD that is not a release; any failure reads as "no tag",
    // which errs toward the warning, never away from it.
    const tag = await _git(execFile, dir, ['describe', '--tags', '--exact-match', 'HEAD']);
    out.tag = tag.ok ? (tag.stdout.trim() || null) : null;
  }

  const up = await _git(execFile, dir, ['rev-parse', '--verify', '--quiet', `${UPSTREAM_REF}^{commit}`]);
  const upSha = up.ok ? up.stdout.trim() : '';
  if (/^[0-9a-f]{7,64}$/.test(upSha)) {
    out.upstream = { ref: UPSTREAM_REF, sha: upSha };
    const lr = await _git(execFile, dir, ['rev-list', '--left-right', '--count', `HEAD...${UPSTREAM_REF}`]);
    const parsed = lr.ok ? _parseLeftRight(lr.stdout) : null;
    if (parsed) {
      out.ahead = parsed.left;
      out.behind = parsed.right;
    } else {
      incomplete.push(lr.ok ? 'ahead/behind: unparseable rev-list output' : _reason('ahead/behind', lr.err));
    }
  } else {
    incomplete.push(`upstream: ${UPSTREAM_REF} is not present in this clone`);
  }
  out.relation = _relation(out.ahead, out.behind);

  // Unpushed: commits on HEAD its own upstream branch lacks. With no upstream
  // branch (a local-only branch, or detached), the honest comparison is the
  // shared target — anything not on origin/main has not been pushed to it.
  if (!st.detached && st.upstream && st.upstreamAhead !== null) {
    out.unpushed = { count: st.upstreamAhead, against: st.upstream };
  } else if (out.ahead !== null) {
    out.unpushed = { count: out.ahead, against: UPSTREAM_REF };
  } else {
    incomplete.push('unpushed: no upstream to compare against');
  }

  // Which repository this is, for relating sessions on other clones of it.
  // Kept out of `incomplete`: that list is about this checkout's own facts,
  // and a clone with no remote is complete without one.
  out.repository = await _repository(execFile, dir);

  out.incomplete = incomplete;
  return out;
}

/**
 * Measure now, coalescing concurrent callers for the same directory.
 *
 * @param {string} dir
 * @returns {Promise<object>}
 */
function refresh(dir) {
  const pending = _inFlight.get(dir);
  if (pending) return pending;
  const p = measure(dir).then((value) => {
    _cache.set(dir, { value, at: _internal.now() });
    _inFlight.delete(dir);
    return value;
  });
  _inFlight.set(dir, p);
  return p;
}

/**
 * The cached checkout payload for `dir`, returned at once. When the cache is
 * missing or older than {@link CACHE_TTL_MS}, one background measurement is
 * started for the next caller. Before the first measurement completes the
 * answer is `state: 'pending'` — a fact about the probe, never about the
 * checkout.
 *
 * @param {string} dir
 * @returns {object}
 */
function snapshot(dir) {
  const hit = _cache.get(dir);
  if (!hit || (_internal.now() - hit.at) >= CACHE_TTL_MS) refresh(dir);
  if (!hit) {
    return {
      state: 'pending', reason: 'first measurement in progress', measuredAt: null,
      branch: null, detached: null, tag: null, onDefaultBranch: null, headSha: null,
      upstream: { ref: UPSTREAM_REF, sha: null },
      ahead: null, behind: null, relation: 'unknown',
      unpushed: { count: null, against: null },
      dirtyTracked: null, untracked: null,
      repository: { identity: null, reason: 'not read' }, incomplete: []
    };
  }
  return hit.value;
}

/**
 * Attach how fresh the `origin/main` ref is. This module never fetches, so a
 * local ref is only as current as the last fetch; the behind-origin check is
 * the one thing that fetches, and only its successful fetch makes the ref a
 * fresh remote observation.
 *
 * @param {object} checkout - A payload from `snapshot`/`measure`.
 * @param {{state?: string, checkedAt?: string|null}|null} behindOriginSnap - `behindOrigin.snapshot()`.
 *   Its `checkedAt` is compared with the checkout's `measuredAt`.
 * @returns {object} A copy with `upstream.observation` and `upstream.observedAt`.
 */
function withUpstreamObservation(checkout, behindOriginSnap) {
  // The two caches refresh on their own clocks. The SHA shown is the ref as
  // it stood when the checkout was measured, so it is a fetched observation
  // only when that measurement came after the successful fetch; a checkout
  // measured before the fetch shows the pre-fetch ref, and a later failed
  // attempt leaves the last success's freshness unproven.
  const fetchedAt = behindOriginSnap && behindOriginSnap.state === 'measured' ? Date.parse(behindOriginSnap.checkedAt) : NaN;
  const measuredAt = checkout ? Date.parse(checkout.measuredAt) : NaN;
  const fetched = Number.isFinite(fetchedAt) && Number.isFinite(measuredAt) && measuredAt >= fetchedAt;
  const hasSha = !!(checkout && checkout.upstream && checkout.upstream.sha);
  return {
    ...checkout,
    upstream: {
      ...(checkout && checkout.upstream),
      observation: !hasSha ? 'unknown' : (fetched ? 'fetched' : 'local-ref'),
      observedAt: hasSha && fetched ? behindOriginSnap.checkedAt : null
    }
  };
}

/**
 * Whether a repository-relative path is one no running process loads.
 *
 * @param {string} p - Path as git prints it (forward slashes, repo-relative).
 * @returns {boolean}
 */
function isRecordsPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (!p.includes('/') && p.toLowerCase().endsWith('.md')) return true;
  return RECORDS_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Parse `git diff --name-status -z` output into the list of paths touched.
 * Renames and copies (`R<score>`, `C<score>`) carry two paths; both count,
 * because moving a file out of `lib/` changes what the server loads as much
 * as moving one in.
 *
 * @param {string} out
 * @returns {string[]|null} Paths, or null when the output is malformed.
 */
function parseNameStatus(out) {
  const fields = String(out || '').split('\0');
  if (fields.length && fields[fields.length - 1] === '') fields.pop();
  const paths = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i++];
    if (!/^[ACDMRTUXB]\d*$/.test(status)) return null;
    const n = (status[0] === 'R' || status[0] === 'C') ? 2 : 1;
    for (let k = 0; k < n; k++) {
      if (i >= fields.length) return null;
      paths.push(fields[i++]);
    }
  }
  return paths;
}

/**
 * Classify a list of changed paths.
 *
 * @param {string[]} paths
 * @returns {{impact: 'executable'|'records-only'|'mixed', executablePaths: string[], recordsPaths: string[]}}
 */
function classifyPaths(paths) {
  const executablePaths = [];
  const recordsPaths = [];
  for (const p of paths) (isRecordsPath(p) ? recordsPaths : executablePaths).push(p);
  let impact;
  if (executablePaths.length === 0) impact = 'records-only';
  else if (recordsPaths.length === 0) impact = 'executable';
  else impact = 'mixed';
  return { impact, executablePaths, recordsPaths };
}

/** Most paths of each class echoed back — the payload rides a polled route. */
const IMPACT_PATH_LIMIT = 20;

/**
 * Classify the commits between `fromSha` and `toSha` by what a restart would
 * load. Resolves — never rejects.
 *
 * @param {string} dir - The checkout both SHAs belong to.
 * @param {string|null} fromSha - What the running process started on.
 * @param {string|null} toSha - What is on disk now.
 * @param {object} [opts]
 * @param {Function} [opts.execFile]
 * @returns {Promise<{impact: 'executable'|'records-only'|'mixed'|'unknown', reason: string|null,
 *   fromSha: string|null, toSha: string|null, executablePaths: string[], recordsPaths: string[], truncated: boolean}>}
 */
async function classifyRange(dir, fromSha, toSha, opts = {}) {
  const execFile = opts.execFile || _internal.execFile;
  const unknown = (reason) => ({
    impact: 'unknown', reason, fromSha: fromSha || null, toSha: toSha || null,
    executablePaths: [], recordsPaths: [], truncated: false
  });
  const shaRe = /^[0-9a-f]{7,64}$/;
  if (!shaRe.test(String(fromSha || '')) || !shaRe.test(String(toSha || ''))) {
    return unknown('the running or on-disk commit is not known');
  }
  // An empty diff would read as records-only, but equal SHAs mean the
  // staleness came from somewhere a commit range cannot see (the version
  // signal), so there is nothing here to classify.
  if (fromSha === toSha) return unknown('the running and on-disk commits are the same');
  const diff = await _git(execFile, dir, ['diff', '--name-status', '-z', '-M', '--no-color', fromSha, toSha, '--']);
  if (!diff.ok) return unknown(_reason('git diff', diff.err));
  const paths = parseNameStatus(diff.stdout);
  if (paths === null) return unknown('git diff: unparseable output');
  const c = classifyPaths(paths);
  const truncated = c.executablePaths.length > IMPACT_PATH_LIMIT || c.recordsPaths.length > IMPACT_PATH_LIMIT;
  return {
    impact: c.impact, reason: null, fromSha, toSha,
    executablePaths: c.executablePaths.slice(0, IMPACT_PATH_LIMIT),
    recordsPaths: c.recordsPaths.slice(0, IMPACT_PATH_LIMIT),
    truncated
  };
}

/**
 * Cached restart impact for a range, returned at once. A range's answer never
 * changes, so a known classification is served without re-running git; an
 * `unknown` one is served while a retry runs, so a transient git error
 * clears itself. The newest {@link IMPACT_RESULTS_MAX} ranges are kept.
 * Before the first answer the result is `impact: 'pending'`.
 *
 * @param {string} dir
 * @param {string|null} fromSha
 * @param {string|null} toSha
 * @returns {object}
 */
function impactSnapshot(dir, fromSha, toSha) {
  const key = `${dir}\0${fromSha}..${toSha}`;
  const last = _impactResults.get(key);
  if (last && last.impact !== 'unknown') return last;
  if (!_impactInFlight.has(key)) {
    const p = classifyRange(dir, fromSha, toSha).then((value) => {
      _impactResults.delete(key); // re-insert so the newest range is kept longest
      _impactResults.set(key, value);
      while (_impactResults.size > IMPACT_RESULTS_MAX) _impactResults.delete(_impactResults.keys().next().value);
      _impactInFlight.delete(key);
      return value;
    });
    _impactInFlight.set(key, p);
  }
  if (last) return last;
  return {
    impact: 'pending', reason: 'classification in progress', fromSha: fromSha || null, toSha: toSha || null,
    executablePaths: [], recordsPaths: [], truncated: false
  };
}

/**
 * Compare HEAD with an upstream SHA observed from the remote, using only this
 * clone's own objects. Resolves — never rejects.
 *
 * When the observed commit is not in this clone (it has not fetched since
 * upstream moved), HEAD is behind by an unknown count: the answer is
 * `behind-unknown`, never a count and never `equal`. Nothing is fetched to
 * find out — the clone belongs to whoever is working in it.
 *
 * @param {string} dir
 * @param {string|null} headSha
 * @param {string|null} upstreamSha
 * @param {object} [opts]
 * @param {Function} [opts.execFile]
 * @returns {Promise<{ahead: number|null, behind: number|null,
 *   relation: 'equal'|'ahead'|'behind'|'diverged'|'behind-unknown'|'unknown', reason: string|null}>}
 */
async function compareToUpstream(dir, headSha, upstreamSha, opts = {}) {
  const execFile = opts.execFile || _internal.execFile;
  const unknown = (reason) => ({ ahead: null, behind: null, relation: 'unknown', reason });
  const shaRe = /^[0-9a-f]{7,64}$/;
  if (!shaRe.test(String(headSha || '')) || !shaRe.test(String(upstreamSha || ''))) {
    return unknown('HEAD or the upstream commit is not known');
  }
  if (headSha === upstreamSha) return { ahead: 0, behind: 0, relation: 'equal', reason: null };
  const has = await _git(execFile, dir, ['rev-parse', '--verify', '--quiet', `${upstreamSha}^{commit}`]);
  if (!has.ok) {
    // `rev-parse --verify --quiet` exits 1, silently, for a commit this clone
    // does not have; anything else (a timeout, a corrupt repository) is a
    // check that did not run.
    const missing = has.err && has.err.code === 1 && !has.err.killed;
    if (missing) return { ahead: null, behind: null, relation: 'behind-unknown', reason: 'upstream commit not fetched here' };
    return unknown(_reason('upstream commit lookup', has.err));
  }
  const lr = await _git(execFile, dir, ['rev-list', '--left-right', '--count', `${headSha}...${upstreamSha}`]);
  const parsed = lr.ok ? _parseLeftRight(lr.stdout) : null;
  if (!parsed) return unknown(lr.ok ? 'ahead/behind: unparseable rev-list output' : _reason('ahead/behind', lr.err));
  return { ahead: parsed.left, behind: parsed.right, relation: _relation(parsed.left, parsed.right), reason: null };
}

/**
 * Compare now, coalescing concurrent callers for the same (dir, head,
 * upstream) triple, and remember the answer. A definite answer never changes
 * for that triple; `behind-unknown` and `unknown` are retried on the next
 * read, because a fetch in that clone can turn either into a count.
 *
 * @param {string} dir
 * @param {string} headSha
 * @param {string} upstreamSha
 * @returns {Promise<object>}
 */
function compareRefresh(dir, headSha, upstreamSha) {
  const key = `${dir}\0${headSha}...${upstreamSha}`;
  const pending = _compareInFlight.get(key);
  if (pending) return pending;
  const p = compareToUpstream(dir, headSha, upstreamSha).then((value) => {
    _compareResults.delete(key);
    _compareResults.set(key, value);
    while (_compareResults.size > IMPACT_RESULTS_MAX) _compareResults.delete(_compareResults.keys().next().value);
    _compareInFlight.delete(key);
    return value;
  });
  _compareInFlight.set(key, p);
  return p;
}

/**
 * The cached comparison, returned at once; starts one comparison when there
 * is none, or when the last one could not give a count. Before the first
 * answer the relation is `pending`.
 *
 * @param {string} dir
 * @param {string} headSha
 * @param {string} upstreamSha
 * @returns {object}
 */
function compareSnapshot(dir, headSha, upstreamSha) {
  const key = `${dir}\0${headSha}...${upstreamSha}`;
  const last = _compareResults.get(key);
  const definite = last && last.relation !== 'unknown' && last.relation !== 'behind-unknown';
  if (!definite) compareRefresh(dir, headSha, upstreamSha);
  if (last) return last;
  return { ahead: null, behind: null, relation: 'pending', reason: 'comparison in progress' };
}

/** Reset module state (tests only). */
function _reset() {
  _cache.clear();
  _inFlight.clear();
  _impactResults.clear();
  _impactInFlight.clear();
  _compareResults.clear();
  _compareInFlight.clear();
}

module.exports = {
  measure,
  refresh,
  snapshot,
  withUpstreamObservation,
  classifyRange,
  impactSnapshot,
  compareToUpstream,
  compareRefresh,
  compareSnapshot,
  normalizeRemoteUrl,
  localRemotePath,
  localIdentity,
  classifyPaths,
  isRecordsPath,
  parseStatusV2,
  parseNameStatus,
  CACHE_TTL_MS,
  GIT_TIMEOUT_MS,
  UPSTREAM_REF,
  DEFAULT_BRANCH,
  RECORDS_PREFIXES,
  IMPACT_PATH_LIMIT,
  IMPACT_RESULTS_MAX,
  _internal,
  _spawnBlockedReason,
  _reset
};
