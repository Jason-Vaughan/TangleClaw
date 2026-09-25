'use strict';

/**
 * Where each uncommitted file stands against the upstream default branch (#1868).
 *
 * `./_file-safety` says what KIND of file a path is and `./_file-ownership` says
 * WHO changed it. Neither says whether the change already landed upstream, so a
 * session checkout left behind after its worktree PR merged was offered its own
 * merged plan, and a regenerated carrier byte-identical to upstream, as fresh
 * work to commit. This module supplies that missing fact from git content alone:
 * no GitHub call and no wrap ledger, so the answer does not depend on either
 * being reachable.
 *
 * **One upstream commit per wrap run.** `capture` runs in `session-files`. It
 * makes at most one bounded refresh of the default branch's remote-tracking ref
 * and records the commit that ref then names. `recheck` runs in every later step
 * that classifies files. It makes no network call, re-reads the work tree, and
 * compares against that same recorded commit. It also reads the local ref again:
 * if something else fetched in between, the newer commit is compared too, and the
 * tighter of the two answers wins, so newer evidence can only withhold a file,
 * never admit one.
 *
 * **Read-only apart from one ref.** Every call is plumbing: `rev-parse`,
 * `ls-tree`, `hash-object` without `-w`, `merge-base`, `rev-list` and
 * `cat-file`. The refresh fetches exactly one branch into its ordinary
 * remote-tracking ref, with no tags and no prune. Nothing here touches the work
 * tree, the index or HEAD.
 *
 * **Unknown is never evidence.** A failed read is `unknown`, never `absent`, and
 * a ref that was not refreshed this run is `stale`. Under either, only a
 * byte-for-byte match, which a stale ref still proves, changes what is committed.
 * Everything else only stops an Include from being recommended.
 *
 * @module lib/wrap-steps/_upstream-provenance
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileArgs } = require('../exec');
const gitProbe = require('../git-probe');

/** Bound on each local git call. */
const LOCAL_TIMEOUT_MS = gitProbe.LOCAL_TIMEOUT_MS;

/** Bound on the one refresh; the same bound every TangleClaw fetch uses. */
const NETWORK_TIMEOUT_MS = gitProbe.NETWORK_TIMEOUT_MS;

/** Output cap for one call; an `ls-tree` over many paths stays well inside it. */
const MAX_BUFFER = 8 * 1024 * 1024;

/** Paths per argv, so a very dirty tree never exceeds the OS argument limit. */
const ARGV_CHUNK = 200;

/** Upper bound on the paths whose line counts are read for the explanation. */
const LINE_COUNT_LIMIT = 50;

/** Branch names tried, in order, when the remote does not name its default. */
const DEFAULT_BRANCH_FALLBACKS = Object.freeze(['main', 'master']);

/**
 * How sure the whole answer is. `no-remote` is not a failure: a repository with
 * no remote has no upstream whose work it could duplicate, so it carries no
 * per-path facts and every existing rule applies unchanged.
 */
const STATES = Object.freeze({ ESTABLISHED: 'established', STALE: 'stale', UNAVAILABLE: 'unavailable', NO_REMOTE: 'no-remote' });

/** What upstream holds for one path. */
const FACTS = Object.freeze({ EQUAL: 'equal', DIFFERENT: 'different', ABSENT: 'absent', UNKNOWN: 'unknown' });

/**
 * What the wrap should conclude about one path, weakest first. A later answer
 * with a higher rank is a TIGHTENING: it can only take a path out of a commit.
 * - `none`: upstream has nothing to say (absent, or unchanged since the
 *   checkout forked). The existing rules decide.
 * - `unverified`: upstream could not be checked well enough to back an Include.
 * - `upstream-owns`: upstream tracks this path with other content that this
 *   checkout never had. Committing from here would duplicate or revert it.
 * - `already-upstream`: upstream holds exactly this content. There is nothing
 *   to commit.
 */
const VERDICTS = Object.freeze({
  NONE: 'none',
  UNVERIFIED: 'unverified',
  UPSTREAM_OWNS: 'upstream-owns',
  ALREADY_UPSTREAM: 'already-upstream'
});

/**
 * Rank of each verdict, for "did this tighten?". `unverified` ranks above
 * `none`: an Include given while upstream said nothing is not carried forward
 * once upstream can no longer be checked.
 */
const VERDICT_RANK = Object.freeze({ none: 0, unverified: 1, 'upstream-owns': 2, 'already-upstream': 3 });

/**
 * Run git read-only in `cwd`.
 *
 * @param {Function} exec - `execFileArgs`-compatible runner.
 * @param {string} cwd
 * @param {string[]} args
 * @param {object} [opts]
 * @param {boolean} [opts.network=false]
 * @returns {Promise<{ok:boolean, stdout:string, detail:string}>}
 */
async function _git(exec, cwd, args, opts = {}) {
  const network = opts.network === true;
  const res = await exec('git', ['--no-optional-locks', ...args], {
    cwd,
    timeoutMs: network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
    maxBufferBytes: MAX_BUFFER,
    env: gitProbe.callEnv(network)
  });
  const ok = res && res.exitCode === 0 && !res.timedOut;
  const detail = ok ? '' : (res && res.timedOut ? 'timed out' : String((res && (res.stderr || res.error)) || `exit ${res && res.exitCode}`).trim().split('\n')[0]);
  return { ok, stdout: String((res && res.stdout) || ''), detail };
}

/**
 * The remote whose default branch is upstream: the current branch's configured
 * remote, else `origin`, else the only remote. Null when none applies.
 *
 * @param {Function} exec
 * @param {string} toplevel
 * @returns {Promise<string|null>}
 */
async function _remoteOf(exec, toplevel) {
  const list = await _git(exec, toplevel, ['remote']);
  if (!list.ok) return null;
  const remotes = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (remotes.length === 0) return null;
  const branch = await _git(exec, toplevel, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (branch.ok && branch.stdout.trim()) {
    const configured = await _git(exec, toplevel, ['config', '--get', `branch.${branch.stdout.trim()}.remote`]);
    const name = configured.ok ? configured.stdout.trim() : '';
    if (name && remotes.includes(name)) return name;
  }
  if (remotes.includes('origin')) return 'origin';
  return remotes.length === 1 ? remotes[0] : null;
}

/**
 * The default branch of `remote` as a remote-tracking ref (`origin/main`), read
 * from what the clone already knows. `<remote>/HEAD` names it when the clone
 * recorded it. Otherwise the first fallback name that exists.
 *
 * @param {Function} exec
 * @param {string} toplevel
 * @param {string} remote
 * @returns {Promise<{ref:string, branch:string}|null>}
 */
async function _defaultRefOf(exec, toplevel, remote) {
  const head = await _git(exec, toplevel, ['symbolic-ref', '-q', '--short', `refs/remotes/${remote}/HEAD`]);
  const named = head.ok ? head.stdout.trim() : '';
  if (named.startsWith(`${remote}/`) && named.length > remote.length + 1) {
    return { ref: named, branch: named.slice(remote.length + 1) };
  }
  for (const branch of DEFAULT_BRANCH_FALLBACKS) {
    const probe = await _git(exec, toplevel, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}^{commit}`]);
    if (probe.ok && probe.stdout.trim()) return { ref: `${remote}/${branch}`, branch };
  }
  return null;
}

/**
 * The commit a remote-tracking ref names now, or null.
 *
 * @param {Function} exec
 * @param {string} toplevel
 * @param {string} ref - `remote/branch`.
 * @returns {Promise<string|null>}
 */
async function _refSha(exec, toplevel, ref) {
  const r = await _git(exec, toplevel, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}^{commit}`]);
  const sha = r.ok ? r.stdout.trim() : '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * When a remote-tracking ref last changed: its reflog entry, else the time
 * FETCH_HEAD was written. Null when neither can be read.
 *
 * @param {Function} exec
 * @param {string} toplevel
 * @param {string} ref
 * @returns {Promise<string|null>} ISO time.
 */
async function _observedAtOf(exec, toplevel, ref) {
  const log = await _git(exec, toplevel, ['log', '-g', '-1', '--date=unix', '--format=%gd', `refs/remotes/${ref}`]);
  const m = log.ok ? /@\{(\d+)\}/.exec(log.stdout) : null;
  if (m) return new Date(Number(m[1]) * 1000).toISOString();
  const fetchHead = await _git(exec, toplevel, ['rev-parse', '--git-path', 'FETCH_HEAD']);
  if (fetchHead.ok && fetchHead.stdout.trim()) {
    try {
      return fs.statSync(path.resolve(toplevel, fetchHead.stdout.trim())).mtime.toISOString();
    } catch {
      // Never fetched in this clone, or the file is unreadable: no time to report.
    }
  }
  return null;
}

/**
 * Blob ids for `paths` in a commit, as a map. A path missing from the map is
 * absent from that commit. Null when git could not answer.
 *
 * @param {Function} exec
 * @param {string} toplevel
 * @param {string} sha
 * @param {string[]} paths
 * @returns {Promise<Map<string,string>|null>}
 */
async function _treeBlobs(exec, toplevel, sha, paths) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += ARGV_CHUNK) {
    const chunk = paths.slice(i, i + ARGV_CHUNK);
    const r = await _git(exec, toplevel, ['ls-tree', '-z', '--full-tree', sha, '--', ...chunk.map(_literalPathspec)]);
    if (!r.ok) return null;
    for (const rec of r.stdout.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [, type, oid] = rec.slice(0, tab).split(' ');
      if (type === 'blob') out.set(rec.slice(tab + 1), oid);
    }
  }
  return out;
}

/**
 * Blob ids of the work-tree copies of `paths`, as git would store them. Null
 * when git could not answer. A path that is not a readable regular file or link
 * gets no entry.
 *
 * @param {Function} exec
 * @param {string} toplevel
 * @param {string[]} paths - Paths present in the work tree.
 * @returns {Promise<Map<string,string>|null>}
 */
async function _localBlobs(exec, toplevel, paths) {
  const out = new Map();
  const present = paths.filter((p) => {
    try {
      const st = fs.lstatSync(path.join(toplevel, p));
      // A symbolic link is committed as its link text, which `hash-object <path>`
      // would not hash (it follows the link), so it is left unknown.
      return st.isFile();
    } catch {
      return false;
    }
  });
  for (let i = 0; i < present.length; i += ARGV_CHUNK) {
    const chunk = present.slice(i, i + ARGV_CHUNK);
    // No `-w`: the object is hashed, never written.
    const r = await _git(exec, toplevel, ['hash-object', '--', ...chunk]);
    if (!r.ok) return null;
    const ids = r.stdout.trim().split('\n');
    if (ids.length !== chunk.length) return null;
    chunk.forEach((p, idx) => out.set(p, ids[idx].trim()));
  }
  return out;
}

/**
 * A pathspec git reads as exactly this one literal path.
 *
 * @param {string} p
 * @returns {string}
 */
function _literalPathspec(p) {
  return `:(literal)${p}`;
}

/**
 * The number of lines in a blob, or null.
 *
 * @param {Function} exec
 * @param {string} toplevel
 * @param {string} oid
 * @returns {Promise<number|null>}
 */
async function _blobLines(exec, toplevel, oid) {
  const r = await _git(exec, toplevel, ['cat-file', 'blob', oid]);
  return r.ok ? _countLines(r.stdout) : null;
}

/**
 * Line count of a text, counting a final line with no newline.
 *
 * @param {string} text
 * @returns {number}
 */
function _countLines(text) {
  if (!text) return 0;
  const n = (text.match(/\n/g) || []).length;
  return text.endsWith('\n') ? n : n + 1;
}

/**
 * The number of lines in a work-tree file, or null.
 *
 * @param {string} toplevel
 * @param {string} p
 * @returns {number|null}
 */
function _fileLines(toplevel, p) {
  try {
    return _countLines(fs.readFileSync(path.join(toplevel, p), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Commits HEAD is ahead of and behind `sha`, or nulls.
 *
 * @param {Function} exec
 * @param {string} toplevel
 * @param {string} sha
 * @returns {Promise<{ahead:(number|null), behind:(number|null)}>}
 */
async function _position(exec, toplevel, sha) {
  const r = await _git(exec, toplevel, ['rev-list', '--left-right', '--count', `HEAD...${sha}`]);
  const m = r.ok ? /^(\d+)\s+(\d+)/.exec(r.stdout.trim()) : null;
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : { ahead: null, behind: null };
}

/**
 * Per-path facts and verdicts against one upstream commit.
 *
 * @param {Function} exec
 * @param {string} toplevel
 * @param {Array<{path:string, deleted:boolean, newToRepo?:boolean}>} dirty
 * @param {string} sha - Upstream commit.
 * @param {string} state - One of {@link STATES}, for the verdict.
 * @param {object} [opts]
 * @param {boolean} [opts.lineCounts=false] - Read line counts for the explanation.
 * @returns {Promise<{paths:Object<string,object>, problem:(string|null)}>}
 */
async function _factsAgainst(exec, toplevel, dirty, sha, state, opts = {}) {
  const all = dirty.map((f) => f.path);
  const upstream = await _treeBlobs(exec, toplevel, sha, all);
  const present = dirty.filter((f) => !f.deleted).map((f) => f.path);
  const local = upstream ? await _localBlobs(exec, toplevel, present) : null;
  const base = upstream ? await _git(exec, toplevel, ['merge-base', 'HEAD', sha]) : null;
  const baseSha = base && base.ok ? base.stdout.trim() : '';
  const baseBlobs = baseSha ? await _treeBlobs(exec, toplevel, baseSha, all) : null;
  const headBlobs = baseBlobs ? await _treeBlobs(exec, toplevel, 'HEAD', all) : null;
  const paths = {};
  let lineBudget = LINE_COUNT_LIMIT;
  for (const f of dirty) {
    const p = f.path;
    if (!upstream || !local) {
      paths[p] = { upstream: FACTS.UNKNOWN, upstreamChanged: null, verdict: VERDICTS.UNVERIFIED, localLines: null, upstreamLines: null };
      continue;
    }
    const up = upstream.get(p) || null;
    const mine = f.deleted ? null : (local.get(p) || null);
    let fact;
    if (!f.deleted && !mine) fact = FACTS.UNKNOWN;
    else if (up === mine) fact = up === null ? FACTS.ABSENT : FACTS.EQUAL;
    else fact = up === null ? FACTS.ABSENT : FACTS.DIFFERENT;
    // A deletion that upstream has also made is already upstream: `up === mine === null`
    // above reads as ABSENT, so it is promoted here.
    if (f.deleted && up === null) fact = FACTS.EQUAL;
    const upstreamChanged = baseBlobs ? (baseBlobs.get(p) || null) !== up : null;
    // This branch's own commits changed the path since it forked. Then an
    // uncommitted edit is the branch's own line of work, not a stale copy of
    // upstream's, and the branch's merge is where the two meet.
    const branchChanged = baseBlobs && headBlobs ? (baseBlobs.get(p) || null) !== (headBlobs.get(p) || null) : false;
    const entry = {
      upstream: fact,
      upstreamChanged,
      verdict: _verdict(fact, upstreamChanged, f, state, branchChanged),
      localLines: null,
      upstreamLines: null
    };
    if (opts.lineCounts && entry.verdict === VERDICTS.UPSTREAM_OWNS && lineBudget > 0) {
      lineBudget -= 1;
      entry.upstreamLines = up ? await _blobLines(exec, toplevel, up) : null;
      entry.localLines = f.deleted ? 0 : _fileLines(toplevel, p);
    }
    paths[p] = entry;
  }
  const problem = !upstream ? `could not list ${sha.slice(0, 12)}'s files` : (!local ? 'could not read the local files' : null);
  return { paths, problem };
}

/**
 * The verdict for one path's fact.
 *
 * @param {string} fact - One of {@link FACTS}.
 * @param {boolean|null} upstreamChanged - Upstream's blob differs from the merge-base's.
 * @param {{deleted:boolean, newToRepo?:boolean}} entry - The status entry.
 * @param {string} state - One of {@link STATES}.
 * @param {boolean} [branchChanged=false] - This branch's commits changed the path since it forked.
 * @returns {string} One of {@link VERDICTS}.
 */
function _verdict(fact, upstreamChanged, entry, state, branchChanged = false) {
  if (fact === FACTS.EQUAL) {
    // A branch that changed this file itself and now matches upstream again is
    // undoing its own change: a real edit, not a copy of upstream's. Otherwise
    // identical content is proof whether or not the ref was refreshed, since
    // upstream held exactly this content at least as recently as the ref says.
    return branchChanged ? VERDICTS.NONE : VERDICTS.ALREADY_UPSTREAM;
  }
  if (fact === FACTS.UNKNOWN) return VERDICTS.UNVERIFIED;
  if (fact === FACTS.DIFFERENT) {
    // Upstream tracks a path this checkout never committed, or changed it after
    // a checkout that has not touched it forked: the content upstream holds is
    // not this checkout's to overwrite.
    if (entry.newToRepo) return VERDICTS.UPSTREAM_OWNS;
    if (upstreamChanged === true && !branchChanged) return VERDICTS.UPSTREAM_OWNS;
    if (upstreamChanged === true && branchChanged) return VERDICTS.NONE;
    if (upstreamChanged === null) return VERDICTS.UNVERIFIED;
  }
  // Absent upstream, or an edit to a file upstream has left alone. A ref that
  // was not refreshed cannot rule out that upstream has since taken the path.
  return state === STATES.ESTABLISHED ? VERDICTS.NONE : VERDICTS.UNVERIFIED;
}

/**
 * A provenance answer where upstream could not be read at all.
 *
 * @param {Array<{path:string}>} dirty
 * @param {object} base - Fields already known (remote, ref, refresh...).
 * @param {string} problem - Operator words.
 * @returns {object}
 */
function _unavailable(dirty, base, problem) {
  const paths = {};
  for (const f of dirty) {
    paths[f.path] = { upstream: FACTS.UNKNOWN, upstreamChanged: null, verdict: VERDICTS.UNVERIFIED, localLines: null, upstreamLines: null };
  }
  return {
    state: STATES.UNAVAILABLE,
    remote: null, ref: null, refSha: null, currentRefSha: null, refMoved: false,
    refresh: 'skipped', refreshProblem: null, observedAt: null,
    ahead: null, behind: null,
    ...base,
    problem,
    paths
  };
}

/**
 * The answer for a repository with no remote: nothing upstream, no facts.
 *
 * @returns {object}
 */
function _noRemote() {
  return {
    state: STATES.NO_REMOTE,
    remote: null, ref: null, refSha: null, currentRefSha: null, refMoved: false,
    refresh: 'skipped', refreshProblem: null, observedAt: null,
    ahead: null, behind: null, problem: null,
    paths: {}
  };
}

/**
 * Capture provenance for this wrap run: resolve the default branch, refresh it
 * once when allowed, record the commit it names, and judge every dirty path.
 *
 * @param {string} toplevel - Repository root of the tree being wrapped.
 * @param {Array<{path:string, deleted:boolean, newToRepo?:boolean}>} dirty - From `ownership.parseStatus`.
 * @param {object} [opts]
 * @param {boolean} [opts.refresh=true] - Whether the one network refresh may run.
 * @param {Function} [opts.exec] - Test seam; `execFileArgs`-compatible.
 * @param {() => number} [opts.now] - Test seam for the observation time.
 * @returns {Promise<object>} The provenance object (see the plan's A2 model).
 */
async function capture(toplevel, dirty, opts = {}) {
  const exec = opts.exec || execFileArgs;
  const now = opts.now || Date.now;
  const list = Array.isArray(dirty) ? dirty : [];
  const remotes = await _git(exec, toplevel, ['remote']);
  if (remotes.ok && !remotes.stdout.trim()) return _noRemote();
  const remote = remotes.ok ? await _remoteOf(exec, toplevel) : null;
  if (!remote) {
    return _unavailable(list, {}, remotes.ok ? 'there are several remotes and none is the upstream' : 'the list of remotes could not be read');
  }
  let target = await _defaultRefOf(exec, toplevel, remote);
  let refresh = 'skipped';
  let refreshProblem = opts.refresh === false ? 'upstream refresh is turned off on this install' : null;
  let refreshedAt = null;
  if (opts.refresh !== false) {
    // With no local ref to name the branch, a fallback name is still worth one
    // try: a fresh clone that never recorded `<remote>/HEAD` usually has `main`.
    const branch = target ? target.branch : DEFAULT_BRANCH_FALLBACKS[0];
    const fetched = await _git(exec, toplevel, [
      'fetch', '--quiet', '--no-tags', '--no-prune', remote,
      `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`
    ], { network: true });
    if (fetched.ok) {
      refresh = 'refreshed';
      refreshedAt = new Date(now()).toISOString();
      if (!target) target = { ref: `${remote}/${branch}`, branch };
    } else {
      refresh = 'failed';
      refreshProblem = fetched.detail || 'the fetch failed';
    }
  }
  if (!target) {
    return _unavailable(list, { remote, refresh, refreshProblem }, `couldn't find ${remote}'s default branch`);
  }
  const refSha = await _refSha(exec, toplevel, target.ref);
  if (!refSha) {
    return _unavailable(list, { remote, ref: target.ref, refresh, refreshProblem }, `${target.ref} could not be read`);
  }
  const state = refresh === 'refreshed' ? STATES.ESTABLISHED : STATES.STALE;
  const observedAt = refreshedAt || await _observedAtOf(exec, toplevel, target.ref);
  const position = await _position(exec, toplevel, refSha);
  const facts = await _factsAgainst(exec, toplevel, list, refSha, state, { lineCounts: true });
  return {
    state: facts.problem ? STATES.UNAVAILABLE : state,
    remote,
    ref: target.ref,
    refSha,
    currentRefSha: refSha,
    refMoved: false,
    refresh,
    refreshProblem,
    observedAt,
    ahead: position.ahead,
    behind: position.behind,
    problem: facts.problem || (state === STATES.STALE ? `${target.ref} was not refreshed this wrap${refreshProblem ? ` (${refreshProblem})` : ''}` : null),
    paths: facts.paths
  };
}

/**
 * Recheck provenance at a later step, with no network call. Re-reads the work
 * tree and compares against the commit `captured` recorded. When the local ref
 * has since moved, the newer commit is judged too and each path keeps the
 * tighter verdict.
 *
 * @param {string} toplevel
 * @param {Array<{path:string, deleted:boolean, newToRepo?:boolean}>} dirty - Re-read now.
 * @param {object|null} captured - `session-files`' provenance, or null when
 *   there is none (a commit-only replay). Then the local ref is used as a stale capture.
 * @param {object} [opts]
 * @param {Function} [opts.exec]
 * @returns {Promise<object>}
 */
async function recheck(toplevel, dirty, captured, opts = {}) {
  const exec = opts.exec || execFileArgs;
  const list = Array.isArray(dirty) ? dirty : [];
  if (!captured || !captured.refSha || !captured.ref) {
    if (captured && captured.state === STATES.NO_REMOTE) return _noRemote();
    if (captured && captured.state === STATES.UNAVAILABLE) {
      return _unavailable(list, { remote: captured.remote || null, ref: captured.ref || null, refresh: captured.refresh || 'skipped', refreshProblem: captured.refreshProblem || null }, captured.problem || 'upstream could not be read');
    }
    return capture(toplevel, list, { exec, refresh: false });
  }
  const base = await _factsAgainst(exec, toplevel, list, captured.refSha, captured.state, { lineCounts: true });
  const currentRefSha = await _refSha(exec, toplevel, captured.ref);
  const refMoved = Boolean(currentRefSha && currentRefSha !== captured.refSha);
  let paths = base.paths;
  if (refMoved) {
    // Something fetched after `session-files` captured. The newer commit is
    // newer evidence; it may only tighten.
    const newer = await _factsAgainst(exec, toplevel, list, currentRefSha, captured.state, { lineCounts: true });
    paths = {};
    for (const f of list) {
      const a = base.paths[f.path];
      const b = newer.paths[f.path];
      paths[f.path] = b && VERDICT_RANK[b.verdict] > VERDICT_RANK[a.verdict] ? { ...b, fromNewerRef: true } : a;
    }
  }
  const position = await _position(exec, toplevel, captured.refSha);
  return {
    ...captured,
    state: base.problem ? STATES.UNAVAILABLE : captured.state,
    currentRefSha,
    refMoved,
    ahead: position.ahead,
    behind: position.behind,
    problem: base.problem || captured.problem || null,
    paths
  };
}

/**
 * The provenance summary the drawer and the step outputs carry: every field
 * but the per-path map, which travels on each path's own entry instead.
 *
 * @param {object|null} provenance
 * @returns {object|null}
 */
function summaryOf(provenance) {
  if (!provenance) return null;
  const { paths, ...rest } = provenance;
  return rest;
}

/**
 * Whether a later verdict tightened an earlier one.
 *
 * @param {string|null|undefined} before - The verdict the operator answered against.
 * @param {string} after - The verdict now.
 * @returns {boolean}
 */
function tightened(before, after) {
  const was = Object.prototype.hasOwnProperty.call(VERDICT_RANK, before) ? VERDICT_RANK[before] : 0;
  return (VERDICT_RANK[after] || 0) > was;
}

/**
 * "N lines there, M here", or '' when either count is unknown.
 *
 * @param {{upstreamLines:(number|null), localLines:(number|null)}} entry
 * @returns {string}
 */
function _lines(entry) {
  if (!Number.isInteger(entry.upstreamLines) || !Number.isInteger(entry.localLines)) return '';
  const word = (n) => `${n} line${n === 1 ? '' : 's'}`;
  return ` (${word(entry.upstreamLines)} there, ${word(entry.localLines)} here)`;
}

/**
 * Why a path got its verdict, in words an operator can act on without knowing
 * about blobs, refs or worktrees. '' when upstream has nothing to add.
 *
 * @param {object|null} entry - One path's provenance entry.
 * @param {object|null} summary - {@link summaryOf} of the same provenance.
 * @param {{newToRepo?:boolean}} [status] - The path's status entry.
 * @returns {string}
 */
function explain(entry, summary, status = {}) {
  if (!entry || !summary) return '';
  const ref = summary.ref || 'upstream';
  switch (entry.verdict) {
    case VERDICTS.ALREADY_UPSTREAM:
      return `${ref} already has exactly this content, so committing it would only repeat a change that is already merged`;
    case VERDICTS.UPSTREAM_OWNS:
      if (status.newToRepo || entry.upstreamChanged !== true) {
        return `${ref} already tracks this path with different content${_lines(entry)}. Committing it from here would duplicate or overwrite merged work. Your file is kept as it is`;
      }
      return `${ref} changed this file after your checkout${Number.isInteger(summary.behind) && summary.behind > 0 ? ` (you are ${summary.behind} commit${summary.behind === 1 ? '' : 's'} behind)` : ''}. Committing it from here risks reverting that change. Your file is kept as it is`;
    case VERDICTS.UNVERIFIED:
      return `couldn't confirm what ${ref} holds for this file (${summary.problem || entry.upstream}), so it isn't recommended for the commit`;
    default:
      return entry.upstream === FACTS.ABSENT ? `not on ${ref} yet` : '';
  }
}

/**
 * One sentence on where this checkout stands, for the top of the file list.
 *
 * @param {object|null} summary - {@link summaryOf}.
 * @returns {string}
 */
function headline(summary) {
  if (!summary) return '';
  if (summary.state === STATES.NO_REMOTE) return '';
  if (summary.state === STATES.UNAVAILABLE || !summary.ref) {
    return `Couldn't compare these files with upstream: ${summary.problem || 'upstream could not be read'}. No file is recommended for the commit on that basis, and nothing is changed on disk.`;
  }
  const where = Number.isInteger(summary.behind) && Number.isInteger(summary.ahead)
    ? `This checkout is ${summary.behind} behind and ${summary.ahead} ahead of ${summary.ref}`
    : `This checkout's position against ${summary.ref} couldn't be counted`;
  if (summary.state === STATES.ESTABLISHED) return `${where} (checked just now).`;
  const when = summary.observedAt ? ` of ${summary.observedAt.slice(0, 16).replace('T', ' ')} UTC` : '';
  const why = summary.refreshProblem ? `: ${summary.refreshProblem}` : '';
  return `${where}, as of the last fetch${when}. It was not refreshed this wrap${why}, so only exact matches count as already upstream.`;
}

/**
 * The provenance `session-files` captured earlier in this wrap run, or null.
 *
 * @param {Array<object>} previousResults - The pipeline's results so far.
 * @returns {object|null}
 */
function capturedFrom(previousResults) {
  const r = (previousResults || []).find((x) => x && x.stepId === 'session-files' && x.output && x.output.provenance);
  return r ? r.output.provenance : null;
}

/**
 * The per-path verdicts of a provenance answer that change anything, as a
 * compact map a step output can carry (`none` is left out).
 *
 * @param {object|null} provenance
 * @returns {Object<string, string>}
 */
function verdictsOf(provenance) {
  const out = {};
  for (const [p, e] of Object.entries((provenance && provenance.paths) || {})) {
    if (e && e.verdict && e.verdict !== VERDICTS.NONE) out[p] = e.verdict;
  }
  return out;
}

/**
 * Rebuild a provenance answer from a step output's summary and verdict map,
 * for a step that classifies only to count (the changelog check). It carries
 * verdicts, not facts, so it explains nothing.
 *
 * @param {Array<object>} previousResults
 * @returns {object|null}
 */
function fromPreviousResults(previousResults) {
  const r = (previousResults || []).find((x) => x && x.stepId === 'session-files' && x.output && x.output.provenance);
  if (!r) return null;
  const paths = {};
  for (const [p, verdict] of Object.entries(r.output.provenanceVerdicts || {})) {
    if (Object.prototype.hasOwnProperty.call(VERDICT_RANK, verdict)) {
      paths[p] = { upstream: FACTS.UNKNOWN, upstreamChanged: null, verdict, localLines: null, upstreamLines: null };
    }
  }
  return { ...r.output.provenance, paths };
}

module.exports = {
  capture,
  recheck,
  capturedFrom,
  verdictsOf,
  fromPreviousResults,
  summaryOf,
  tightened,
  explain,
  headline,
  STATES,
  FACTS,
  VERDICTS,
  VERDICT_RANK,
  _internal: { _verdict, _countLines, _literalPathspec }
};
