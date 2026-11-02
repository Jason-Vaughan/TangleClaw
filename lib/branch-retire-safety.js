'use strict';

/**
 * Is it safe to retire a local branch — delete it, reset it, remove its
 * worktree, or "normalize" the checkout away from it — without losing work?
 *
 * The question exists because the only durable record of a local commit is a
 * named ref. A merged PR is not proof that every later local commit is
 * upstream (a wrap commit lands after the merge), a remote-tracking ref is
 * only as current as the last fetch, and a reflog is not a safety contract:
 * it expires, and it does not travel with a fresh clone.
 *
 * So the answer is fail-closed. There are exactly three verdicts:
 *
 * - `safe`     — every one of these was proven: the configured remote was
 *                fetched and pruned just now; the target resolves to the
 *                reported OID before and after the check; no commit of the
 *                target is unique against every OTHER local branch, every
 *                tag, and that freshly refreshed remote; the target is not
 *                checked out in any worktree, nor sitting under one mid-rebase
 *                or detached at its tip; and nothing along the way was
 *                ambiguous.
 * - `preserve` — the check ran and found work that retiring would lose or a
 *                live tree it would disrupt.
 * - `unknown`  — something could not be proven. Every error and every
 *                ambiguity lands here, never in `safe`.
 *
 * Callers treat `preserve` and `unknown` alike: keep the branch. This module
 * never deletes, resets or removes anything; the one write it makes is the
 * fetch/prune of the remote, which is what makes a remote ref evidence.
 *
 * Engine-neutral by construction — plain git through an injected `execFile`
 * seam ({@link module:lib/git-probe}) and an injected `readFile`, so the same
 * oracle serves `tc branch check`, any engine's session, and a future
 * governance runtime, and every failure path can be driven in a test.
 *
 * @module lib/branch-retire-safety
 */

const fs = require('node:fs');
const path = require('node:path');
const gitProbe = require('./git-probe');

/** The three verdicts. Nothing else is ever returned. */
const VERDICTS = Object.freeze({ SAFE: 'safe', PRESERVE: 'preserve', UNKNOWN: 'unknown' });

/**
 * Stable reason codes, grouped by the verdict each one forces. A consumer
 * branches on these, never on the prose beside them.
 */
const REASONS = Object.freeze({
  // safe
  ALL_REACHABLE: 'ALL_REACHABLE',
  // preserve
  UNIQUE_COMMITS: 'UNIQUE_COMMITS',
  CHECKED_OUT: 'CHECKED_OUT',
  WORKTREE_DIRTY: 'WORKTREE_DIRTY',
  DETACHED_AT_TARGET: 'DETACHED_AT_TARGET',
  OPERATION_IN_PROGRESS: 'OPERATION_IN_PROGRESS',
  // unknown
  INVALID_BRANCH_NAME: 'INVALID_BRANCH_NAME',
  NOT_A_REPOSITORY: 'NOT_A_REPOSITORY',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  NO_REMOTE: 'NO_REMOTE',
  REMOTE_AMBIGUOUS: 'REMOTE_AMBIGUOUS',
  REMOTE_INVALID: 'REMOTE_INVALID',
  FETCH_FAILED: 'FETCH_FAILED',
  REACHABILITY_FAILED: 'REACHABILITY_FAILED',
  WORKTREE_LIST_FAILED: 'WORKTREE_LIST_FAILED',
  WORKTREE_MISSING: 'WORKTREE_MISSING',
  WORKTREE_STATUS_FAILED: 'WORKTREE_STATUS_FAILED',
  TARGET_MOVED: 'TARGET_MOVED'
});

/** Which verdict each reason forces. */
const REASON_VERDICT = Object.freeze({
  ALL_REACHABLE: VERDICTS.SAFE,
  UNIQUE_COMMITS: VERDICTS.PRESERVE,
  CHECKED_OUT: VERDICTS.PRESERVE,
  WORKTREE_DIRTY: VERDICTS.PRESERVE,
  DETACHED_AT_TARGET: VERDICTS.PRESERVE,
  OPERATION_IN_PROGRESS: VERDICTS.PRESERVE,
  INVALID_BRANCH_NAME: VERDICTS.UNKNOWN,
  NOT_A_REPOSITORY: VERDICTS.UNKNOWN,
  TARGET_NOT_FOUND: VERDICTS.UNKNOWN,
  NO_REMOTE: VERDICTS.UNKNOWN,
  REMOTE_AMBIGUOUS: VERDICTS.UNKNOWN,
  REMOTE_INVALID: VERDICTS.UNKNOWN,
  FETCH_FAILED: VERDICTS.UNKNOWN,
  REACHABILITY_FAILED: VERDICTS.UNKNOWN,
  WORKTREE_LIST_FAILED: VERDICTS.UNKNOWN,
  WORKTREE_MISSING: VERDICTS.UNKNOWN,
  WORKTREE_STATUS_FAILED: VERDICTS.UNKNOWN,
  TARGET_MOVED: VERDICTS.UNKNOWN
});

/** A remote name this module will pass to git as a pattern and a refspec source. */
const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolve a path to its realpath, or itself (lexically resolved) if that fails — the path may
 * not exist, or a component may not be readable; this is a "best effort to compare with",
 * never a claim the path is valid.
 *
 * @param {string} p
 * @returns {string}
 */
function _realpathOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Is `child` the same location as `root`, or somewhere inside it — resolved to realpath FIRST,
 * then compared, never the other way around.
 *
 * `lib/project-paths.js`'s containment check does the opposite order on purpose (lexical
 * containment first, symlink-resolution as an additional restriction on top) — right for an
 * operator-supplied path relative to an already-trusted root, wrong here: `git worktree list`
 * reports an already realpath-resolved path (on macOS, `/private/var/...`), while a caller's
 * `process.cwd()` or a tmux pane's reported directory is typically NOT resolved
 * (`/var/...`) — two lexically unrelated strings for the exact same location, which a
 * lexical-first check rejects before symlink-resolution ever gets a chance to prove them equal.
 * Resolving first is what makes that case work.
 *
 * @param {string} child
 * @param {string} root
 * @returns {boolean}
 */
function isSameOrSubpath(child, root) {
  const realChild = _realpathOrResolve(child);
  const realRoot = _realpathOrResolve(root);
  const rel = path.relative(realRoot, realChild);
  // Not `!rel.startsWith('..')`: a real subdirectory literally named `..notes`
  // relative()s to the string `'..notes'`, which also starts with the two
  // characters `..` without being a traversal token. Only `..` itself, or
  // `..` followed by the path separator, means "climbed above the root".
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The files git leaves while a rebase is in progress, naming the branch being
 * rebased. The worktree is detached meanwhile, so `worktree list` alone cannot
 * see that the branch is in use.
 */
const REBASE_HEAD_NAME_FILES = ['rebase-merge/head-name', 'rebase-apply/head-name'];

/**
 * Validate a branch name before it reaches any git argv: no option-looking
 * name, nothing git itself would reject as a branch name.
 *
 * @param {Function} execFile
 * @param {string} cwd
 * @param {unknown} branch
 * @returns {Promise<boolean>}
 */
async function _validBranchName(execFile, cwd, branch) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-')) return false;
  const r = await gitProbe.runGit(execFile, cwd, ['check-ref-format', '--branch', branch]);
  return r.ok && r.stdout.trim() === branch;
}

/**
 * Pick the remote whose refs count as evidence: the target's configured
 * upstream remote, else the repository's only remote. Two or more remotes
 * with no upstream is ambiguous — which one "has" the work cannot be assumed.
 *
 * @param {Function} execFile
 * @param {string} cwd
 * @param {string} branch
 * @returns {Promise<{remote: string|null, upstream: string|null, reason: string|null, detail: string|null}>}
 */
async function _resolveRemote(execFile, cwd, branch) {
  const configured = await gitProbe.runGit(execFile, cwd, ['config', '--get', `branch.${branch}.remote`]);
  const merge = await gitProbe.runGit(execFile, cwd, ['config', '--get', `branch.${branch}.merge`]);
  const mergeRef = merge.ok ? merge.stdout.trim() : '';
  let remote = configured.ok ? configured.stdout.trim() : '';
  // `.` is git's spelling for "upstream is a local branch" — no remote at all.
  if (remote === '.') remote = '';

  const list = await gitProbe.runGit(execFile, cwd, ['remote']);
  if (!list.ok) {
    return { remote: null, upstream: null, reason: REASONS.NO_REMOTE, detail: gitProbe.failureReason('remote list', list.err) };
  }
  const remotes = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  if (remote) {
    if (!remotes.includes(remote) || !REMOTE_NAME_RE.test(remote)) {
      return { remote: null, upstream: null, reason: REASONS.REMOTE_INVALID, detail: `upstream remote '${remote}' is not a usable configured remote` };
    }
  } else if (remotes.length === 0) {
    return { remote: null, upstream: null, reason: REASONS.NO_REMOTE, detail: 'the repository has no remote, so no commit can be proven upstream' };
  } else if (remotes.length > 1) {
    return {
      remote: null,
      upstream: null,
      reason: REASONS.REMOTE_AMBIGUOUS,
      detail: `branch has no upstream and the repository has ${remotes.length} remotes (${remotes.join(', ')}) — which one holds the work cannot be assumed`
    };
  } else {
    remote = remotes[0];
    if (!REMOTE_NAME_RE.test(remote)) {
      return { remote: null, upstream: null, reason: REASONS.REMOTE_INVALID, detail: `remote '${remote}' has a name this check will not pass to git` };
    }
  }
  const upstream = remote && mergeRef.startsWith('refs/heads/') ? `${remote}/${mergeRef.slice('refs/heads/'.length)}` : null;
  return { remote, upstream, reason: null, detail: null };
}

/**
 * Parse `git worktree list --porcelain` output.
 *
 * @param {string} out
 * @returns {Array<{path: string, head: string|null, branch: string|null, detached: boolean, bare: boolean, prunable: boolean}>}
 */
function parseWorktreeList(out) {
  const trees = [];
  let cur = null;
  for (const line of String(out || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, bare: false, prunable: false };
      trees.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim() || null;
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim() || null;
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      cur.prunable = true;
    }
  }
  return trees;
}

/**
 * Count dirt in `git status --porcelain=v2 -z --untracked-files=all --ignored`
 * output: staged changes, unstaged changes, unmerged paths, untracked files
 * and ignored files are each counted separately, so the report can say which
 * kind is at risk. Ignored files count as dirt here (unlike plain `git
 * status`) because `git worktree remove` deletes them with the tree, with no
 * refusal and no `--force` needed — the one case this module's own
 * `--untracked-files=all`-only status call used to miss.
 *
 * @param {string} out
 * @returns {{staged: number, unstaged: number, unmerged: number, untracked: number, ignored: number}}
 */
function parseDirt(out) {
  const d = { staged: 0, unstaged: 0, unmerged: 0, untracked: 0, ignored: 0 };
  const fields = String(out || '').split('\0');
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec || rec.startsWith('# ')) continue;
    const kind = rec[0];
    if (kind === '1' || kind === '2') {
      const xy = rec.slice(2, 4);
      if (xy[0] && xy[0] !== '.') d.staged++;
      if (xy[1] && xy[1] !== '.') d.unstaged++;
      if (kind === '2') i++; // a rename carries its original path as the next field
    } else if (kind === 'u') {
      d.unmerged++;
    } else if (kind === '?') {
      d.untracked++;
    } else if (kind === '!') {
      d.ignored++;
    }
  }
  return d;
}

/**
 * Whether a dirt count holds anything at all, ignored files included.
 *
 * @param {{staged: number, unstaged: number, unmerged: number, untracked: number, ignored: number}} d
 * @returns {boolean}
 */
function _isDirty(d) {
  return d.staged + d.unstaged + d.unmerged + d.untracked + d.ignored > 0;
}

/**
 * The branch a worktree is rebasing, read from the rebase state files, or
 * null when no rebase is in progress there.
 *
 * @param {Function} execFile
 * @param {Function} readFile
 * @param {string} treePath
 * @returns {Promise<{branch: string|null, failed: boolean}>}
 */
async function _rebasingBranch(execFile, readFile, treePath) {
  for (const rel of REBASE_HEAD_NAME_FILES) {
    const r = await gitProbe.runGit(execFile, treePath, ['rev-parse', '--git-path', rel]);
    if (!r.ok) return { branch: null, failed: true };
    const file = path.resolve(treePath, r.stdout.trim());
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      return { branch: null, failed: true };
    }
    return { branch: String(text).trim() || null, failed: false };
  }
  return { branch: null, failed: false };
}

/**
 * The recommended next action for a verdict. Never a reflog recovery, never a
 * deletion unless the verdict is `safe`.
 *
 * @param {string} verdict
 * @param {{branch: string, remote: string|null, baseRef: string|null, heldBy?: string[]}} ctx
 *   `heldBy` — paths of worktrees that hold the branch (checked out, detached
 *   at its tip, or rebasing it). Retiring one of those is a separate, ordered
 *   step, so the advice names it rather than forbidding it outright.
 * @returns {string}
 */
function safeNextAction(verdict, { branch, remote, baseRef, heldBy = [] }) {
  if (verdict === VERDICTS.SAFE) {
    return `Every commit on '${branch}' is reachable from another ref. It may be deleted with \`git branch -d ${branch}\` — `
      + 'run `tc branch check` again immediately before if anything has changed since this check.';
  }
  const keep = `Do not delete or reset '${branch}'. `;
  const noReflog = 'Do not rely on the reflog to recover anything.';
  const trees = heldBy.length === 0 ? '' : ` To retire the worktree holding it (${heldBy.join(', ')}), first confirm `
    + '`git -C <tree> status --porcelain --untracked-files=all --ignored` shows nothing you need, then run plain '
    + '`git worktree remove <tree>` (never `--force`), then run `tc branch check` again.';
  let fresh;
  if (!remote) {
    // No remote could be named, so there is no freshly verified main to
    // start from; saying `origin/main` here would invent one.
    fresh = 'No remote could be verified for this branch, so resolve that first; then continue in a separate '
      + 'clean worktree created from the freshly fetched main line (`git worktree add <new-path> <remote>/main`).';
  } else {
    const base = baseRef || `${remote}/main`;
    fresh = `To continue on fresh code, create a separate clean worktree: \`git fetch --prune ${remote}\` then `
      + `\`git worktree add <new-path> ${base}\` (verify the fetch succeeded before using ${base}).`;
  }
  return `${keep}${fresh}${trees} ${noReflog}`;
}

/**
 * Assess whether a local branch can be retired without losing work.
 *
 * Never throws; every failure is folded into an `unknown` verdict with a
 * reason code. The only write it makes is `git fetch --prune <remote>`.
 *
 * @param {object} opts
 * @param {string} opts.repo - Any directory inside the repository.
 * @param {string} opts.branch - Local branch name (without `refs/heads/`).
 * @param {Function} [opts.execFile] - `child_process.execFile`-compatible git seam.
 * @param {Function} [opts.readFile] - `fs.promises.readFile`-compatible seam.
 * @param {Function} [opts.now] - Clock seam for the fetch timestamp.
 * @returns {Promise<object>} The assessment: `verdict`, `reasons[]` ({code, verdict, detail}),
 *   `branch`, `ref`, `oid`, `remote`, `upstream`, `fetch`, `unique` ({count, shas}), `worktrees[]`
 *   and `safeNextAction` — the shape `tc branch check --json` prints.
 */
async function assess(opts) {
  const execFile = opts.execFile || gitProbe.defaultExecFile;
  const readFile = opts.readFile || fs.promises.readFile;
  const now = opts.now || (() => new Date());
  const branch = opts.branch;
  const cwd = opts.repo;

  const result = {
    verdict: VERDICTS.UNKNOWN,
    reasons: [],
    branch: typeof branch === 'string' ? branch : null,
    ref: null,
    oid: null,
    remote: null,
    upstream: null,
    fetch: { attempted: false, ok: false, remote: null, at: null, detail: null },
    unique: { count: null, shas: [] },
    worktrees: [],
    safeNextAction: null
  };
  const add = (code, detail) => result.reasons.push({ code, verdict: REASON_VERDICT[code], detail });
  let baseRef = null;

  const finish = () => {
    if (result.reasons.some((r) => r.verdict === VERDICTS.UNKNOWN)) result.verdict = VERDICTS.UNKNOWN;
    else if (result.reasons.some((r) => r.verdict === VERDICTS.PRESERVE)) result.verdict = VERDICTS.PRESERVE;
    else {
      add(REASONS.ALL_REACHABLE, 'every commit is reachable from another local branch, a tag, or the freshly fetched remote');
      result.verdict = VERDICTS.SAFE;
    }
    result.safeNextAction = safeNextAction(result.verdict, {
      branch: result.branch || String(branch),
      remote: result.remote,
      baseRef,
      heldBy: result.worktrees.filter((w) => w.holdsTarget).map((w) => w.path)
    });
    return result;
  };

  const top = await gitProbe.runGit(execFile, cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    add(REASONS.NOT_A_REPOSITORY, gitProbe.failureReason('repository', top.err));
    return finish();
  }

  if (!(await _validBranchName(execFile, cwd, branch))) {
    add(REASONS.INVALID_BRANCH_NAME, `'${String(branch)}' is not a valid local branch name`);
    return finish();
  }
  result.ref = `refs/heads/${branch}`;

  const resolved = await gitProbe.runGit(execFile, cwd, ['rev-parse', '--verify', '--quiet', `${result.ref}^{commit}`]);
  const oid = resolved.ok ? resolved.stdout.trim() : '';
  if (!/^[0-9a-f]{40,64}$/.test(oid)) {
    add(REASONS.TARGET_NOT_FOUND, `no local branch '${branch}'`);
    return finish();
  }
  result.oid = oid;

  // --- remote: identity, then a fresh fetch, or nothing remote counts -------
  const rem = await _resolveRemote(execFile, cwd, branch);
  if (rem.reason) {
    add(rem.reason, rem.detail);
  } else {
    result.remote = rem.remote;
    result.upstream = rem.upstream;
    result.fetch.attempted = true;
    result.fetch.remote = rem.remote;
    const fetched = await gitProbe.runGit(execFile, cwd, ['fetch', '--prune', '--quiet', rem.remote], { network: true });
    result.fetch.at = now().toISOString();
    if (fetched.ok) {
      result.fetch.ok = true;
    } else {
      result.fetch.detail = gitProbe.failureReason('fetch', fetched.err);
      add(REASONS.FETCH_FAILED, `${result.fetch.detail} — cached remote-tracking refs are not evidence`);
    }
    const head = await gitProbe.runGit(execFile, cwd, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${rem.remote}/HEAD`]);
    baseRef = head.ok && head.stdout.trim() ? head.stdout.trim() : `${rem.remote}/main`;
  }

  // --- reachability: against every other branch, every tag, and the remote
  //     only when that remote was refreshed just now -----------------------
  const revArgs = ['rev-list', oid, '--not', `--exclude=${branch}`, '--branches', '--tags'];
  if (result.fetch.ok) revArgs.push(`--remotes=${result.remote}`);
  const rl = await gitProbe.runGit(execFile, cwd, revArgs);
  if (!rl.ok) {
    add(REASONS.REACHABILITY_FAILED, gitProbe.failureReason('reachability', rl.err));
  } else {
    const shas = rl.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    result.unique = { count: shas.length, shas };
    if (shas.length > 0) {
      add(REASONS.UNIQUE_COMMITS, result.fetch.ok
        ? `${shas.length} commit(s) exist only on '${branch}'`
        : `${shas.length} commit(s) are on no other local branch or tag (the remote could not be checked)`);
    }
  }

  // --- worktrees: a live tree holding the branch, or dirt beside it --------
  const wl = await gitProbe.runGit(execFile, cwd, ['worktree', 'list', '--porcelain']);
  const trees = wl.ok ? parseWorktreeList(wl.stdout) : [];
  if (!wl.ok) {
    add(REASONS.WORKTREE_LIST_FAILED, gitProbe.failureReason('worktree list', wl.err));
  } else if (trees.length === 0) {
    // Git always lists the main worktree, so an empty list is a read that
    // went wrong — not proof that no tree holds the branch.
    add(REASONS.WORKTREE_LIST_FAILED, 'worktree list returned no worktrees at all');
  } else {
    for (const t of trees) {
      const entry = { path: t.path, head: t.head, branch: t.branch, detached: t.detached, holdsTarget: false, dirt: null, rebasing: null };
      result.worktrees.push(entry);
      if (t.bare) continue;
      const holds = t.branch === result.ref;
      const detachedAtTip = t.detached && t.head === oid;
      let rebasing = null;
      if (t.prunable) {
        if (holds) add(REASONS.WORKTREE_MISSING, `worktree registered for '${branch}' at ${t.path} is missing on disk`);
        continue;
      }
      if (t.detached) {
        const rb = await _rebasingBranch(execFile, readFile, t.path);
        if (rb.failed) {
          add(REASONS.WORKTREE_STATUS_FAILED, `could not read rebase state of the detached worktree at ${t.path}`);
          continue;
        }
        rebasing = rb.branch;
        entry.rebasing = rebasing;
      }
      const rebasingTarget = rebasing === result.ref;
      if (!holds && !detachedAtTip && !rebasingTarget) continue;
      entry.holdsTarget = true;
      if (holds) add(REASONS.CHECKED_OUT, `'${branch}' is checked out in the worktree at ${t.path}`);
      if (rebasingTarget) add(REASONS.OPERATION_IN_PROGRESS, `a rebase of '${branch}' is in progress in the worktree at ${t.path}`);
      if (detachedAtTip && !rebasingTarget) add(REASONS.DETACHED_AT_TARGET, `the worktree at ${t.path} is detached at the tip of '${branch}'`);
      const st = await gitProbe.runGit(execFile, t.path, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored']);
      if (!st.ok) {
        add(REASONS.WORKTREE_STATUS_FAILED, gitProbe.failureReason(`status of ${t.path}`, st.err));
        continue;
      }
      entry.dirt = parseDirt(st.stdout);
      if (_isDirty(entry.dirt)) {
        const d = entry.dirt;
        add(REASONS.WORKTREE_DIRTY, `worktree at ${t.path} has ${d.staged} staged, ${d.unstaged} unstaged, `
          + `${d.unmerged} unmerged, ${d.untracked} untracked and ${d.ignored} ignored path(s)`);
      }
    }
  }

  // --- the target must not have moved while we looked ----------------------
  const again = await gitProbe.runGit(execFile, cwd, ['rev-parse', '--verify', '--quiet', `${result.ref}^{commit}`]);
  if (!again.ok || again.stdout.trim() !== oid) {
    add(REASONS.TARGET_MOVED, `'${branch}' changed during the check (was ${oid.slice(0, 12)})`);
  }

  return finish();
}

/**
 * Render an assessment for a person reading a terminal: the verdict first,
 * then the evidence behind it, then what to do.
 *
 * @param {object} a - An {@link assess} result.
 * @param {object} [opts]
 * @param {number} [opts.maxShas=20] - Unique SHAs listed before the list is cut (the JSON keeps all).
 * @returns {string}
 */
function render(a, opts = {}) {
  const maxShas = Number.isFinite(opts.maxShas) ? opts.maxShas : 20;
  const lines = [];
  const label = a.verdict === VERDICTS.SAFE ? 'SAFE to retire' : (a.verdict === VERDICTS.PRESERVE ? 'PRESERVE — do not retire' : 'UNKNOWN — treat as PRESERVE');
  lines.push(`branch ${a.branch ?? '(none)'}: ${label}`);
  lines.push(`  ref:       ${a.ref ?? '(unresolved)'}${a.oid ? ` @ ${a.oid}` : ''}`);
  lines.push(`  upstream:  ${a.upstream ?? '(none configured)'}`);
  if (a.fetch.attempted) {
    lines.push(`  fetch:     ${a.fetch.remote} ${a.fetch.ok ? 'refreshed' : 'FAILED'} at ${a.fetch.at}${a.fetch.detail ? ` — ${a.fetch.detail}` : ''}`);
  } else {
    lines.push('  fetch:     not attempted (no usable remote)');
  }
  if (a.unique.count === null) {
    lines.push('  unique:    could not be computed');
  } else {
    lines.push(`  unique:    ${a.unique.count} commit(s) on no other ref${a.fetch.ok ? '' : ' checked (remote excluded)'}`);
    for (const sha of a.unique.shas.slice(0, maxShas)) lines.push(`             ${sha}`);
    if (a.unique.shas.length > maxShas) lines.push(`             … ${a.unique.shas.length - maxShas} more (--json lists all)`);
  }
  const held = a.worktrees.filter((w) => w.holdsTarget);
  if (held.length === 0) {
    lines.push(`  worktrees: ${a.worktrees.length} listed; none holds this branch`);
  } else {
    lines.push(`  worktrees: ${a.worktrees.length} listed; ${held.length} hold this branch:`);
    for (const w of held) {
      const dirt = w.dirt
        ? `${w.dirt.staged} staged, ${w.dirt.unstaged} unstaged, ${w.dirt.unmerged} unmerged, ${w.dirt.untracked} untracked`
        : 'dirt unknown';
      lines.push(`             ${w.path} (${w.detached ? 'detached' : 'checked out'}; ${dirt})`);
    }
  }
  lines.push('  reasons:');
  for (const r of a.reasons) lines.push(`    [${r.code}] ${r.detail}`);
  lines.push(`  next:      ${a.safeNextAction}`);
  return lines.join('\n') + '\n';
}

/**
 * Worktree-retirement skip reasons: never retire, always say why.
 */
const WT_SKIP = Object.freeze({
  ACTIVE_CWD: 'active-cwd',
  DIRTY: 'dirty',
  DETACHED_UNMERGED: 'detached-unmerged',
  FETCH_FAILED: 'fetch-failed',
  LIVE_SESSION: 'live-session',
  LOOKUP_FAILED: 'lookup-failed',
  NO_LOOKUP_SESSION: 'no-lookup-session',
  UNKNOWN: 'unknown'
});

/**
 * Worktree-retirement eligible classes — the three ways #1267 lets a
 * worktree's branch/HEAD count as already landed.
 */
const WT_CLASS = Object.freeze({
  GONE_UPSTREAM: 'gone-upstream',
  ANCESTOR_OF_MAIN: 'ancestor-of-main',
  IDENTICAL_TO_MAIN: 'identical-to-main'
});

/**
 * Whether `ref` is an ancestor of `baseRef` — `true`/`false`, both ordinary
 * outcomes, or `null` when the question could not be answered at all.
 *
 * @param {Function} execFile
 * @param {string} cwd
 * @param {string} ref
 * @param {string} baseRef
 * @returns {Promise<boolean|null>}
 */
async function _isAncestorOf(execFile, cwd, ref, baseRef) {
  const r = await gitProbe.runGit(execFile, cwd, ['merge-base', '--is-ancestor', ref, baseRef]);
  if (r.ok) return true;
  // execFile reports a non-zero exit as an error; exit code 1 is git's plain
  // "no" for --is-ancestor, not a failure. Anything else is inconclusive.
  if (r.err && Number(r.err.code) === 1) return false;
  return null;
}

/**
 * Whether `ref` and `baseRef` point at content-identical trees (the
 * squash-merge case) — `true`/`false`, or `null` if the diff could not be run.
 *
 * @param {Function} execFile
 * @param {string} cwd
 * @param {string} ref
 * @param {string} baseRef
 * @returns {Promise<boolean|null>}
 */
async function _isIdenticalTo(execFile, cwd, ref, baseRef) {
  const r = await gitProbe.runGit(execFile, cwd, ['diff', '--stat', ref, baseRef]);
  if (!r.ok) return null;
  return r.stdout.trim() === '';
}

/**
 * Whether a branch's configured upstream remote-tracking ref no longer
 * exists — git's own "[gone]" condition — after the caller has fetched and
 * pruned. `false` (not gone) covers both "no upstream configured" and
 * "upstream still resolves"; `null` means the check itself could not run.
 *
 * @param {Function} execFile
 * @param {string} cwd
 * @param {string} branch
 * @returns {Promise<boolean|null>}
 */
async function _upstreamGone(execFile, cwd, branch) {
  const rem = await _resolveRemote(execFile, cwd, branch);
  if (rem.reason || !rem.upstream) return false;
  const r = await gitProbe.runGit(execFile, cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${rem.upstream}`]);
  if (r.ok) return false;
  // `rev-parse --verify --quiet` exits 1 for "no such ref" and anything else
  // for a real failure (bad revision syntax, repository trouble).
  if (r.err && Number(r.err.code) === 1) return true;
  return null;
}

/**
 * Classify one non-primary, non-cwd worktree against #1267's eligibility
 * rule. Never throws; an inconclusive git call lands the tree in `skipped`
 * with reason `unknown` rather than guessing.
 *
 * @param {Function} execFile
 * @param {string} cwd - The repository root `git worktree list` ran in.
 * @param {object} t - One parsed entry from {@link parseWorktreeList}.
 * @param {string} baseRef - e.g. `origin/main`.
 * @returns {Promise<object>} `{path, branch, oid, eligible, class, reason, detail}`
 */
async function _classifyWorktree(execFile, cwd, t, baseRef) {
  const base = { path: t.path, branch: t.branch ? t.branch.replace(/^refs\/heads\//, '') : null, oid: t.head, detached: t.detached };
  const st = await gitProbe.runGit(execFile, t.path, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored']);
  if (!st.ok) return { ...base, eligible: false, class: null, reason: WT_SKIP.UNKNOWN, detail: gitProbe.failureReason(`status of ${t.path}`, st.err) };
  if (_isDirty(parseDirt(st.stdout))) return { ...base, eligible: false, class: null, reason: WT_SKIP.DIRTY, detail: `worktree at ${t.path} has uncommitted, untracked or ignored changes — \`git worktree remove\` deletes ignored files too` };

  const target = t.head;
  if (t.detached) {
    const ancestor = target ? await _isAncestorOf(execFile, cwd, target, baseRef) : null;
    if (ancestor === true) return { ...base, eligible: true, class: WT_CLASS.ANCESTOR_OF_MAIN, reason: null, detail: `detached at ${target}, an ancestor of ${baseRef}` };
    const identical = target ? await _isIdenticalTo(execFile, cwd, target, baseRef) : null;
    if (identical === true) return { ...base, eligible: true, class: WT_CLASS.IDENTICAL_TO_MAIN, reason: null, detail: `detached at ${target}, content-identical to ${baseRef}` };
    if (ancestor === null || identical === null) {
      return { ...base, eligible: false, class: null, reason: WT_SKIP.UNKNOWN, detail: `could not compare the detached commit at ${t.path} against ${baseRef}` };
    }
    return { ...base, eligible: false, class: null, reason: WT_SKIP.DETACHED_UNMERGED, detail: `detached at ${target}, not reachable from and not identical to ${baseRef} — refusing to prune possible unmerged work` };
  }

  const branch = base.branch;
  const gone = await _upstreamGone(execFile, t.path, branch);
  if (gone === true) return { ...base, eligible: true, class: WT_CLASS.GONE_UPSTREAM, reason: null, detail: `'${branch}'s upstream no longer exists on the remote` };

  const ancestor = target ? await _isAncestorOf(execFile, cwd, `refs/heads/${branch}`, baseRef) : null;
  if (ancestor === true) return { ...base, eligible: true, class: WT_CLASS.ANCESTOR_OF_MAIN, reason: null, detail: `'${branch}' is an ancestor of ${baseRef}` };
  const identical = target ? await _isIdenticalTo(execFile, cwd, `refs/heads/${branch}`, baseRef) : null;
  if (identical === true) return { ...base, eligible: true, class: WT_CLASS.IDENTICAL_TO_MAIN, reason: null, detail: `'${branch}' is content-identical to ${baseRef} (squash-merged)` };

  if (gone === null || ancestor === null || identical === null) {
    return { ...base, eligible: false, class: null, reason: WT_SKIP.UNKNOWN, detail: `could not fully evaluate '${branch}' against ${baseRef}` };
  }
  return { ...base, eligible: false, class: null, reason: WT_SKIP.UNKNOWN, detail: `'${branch}' has no upstream-gone, ancestor or content-identical evidence against ${baseRef} — treating as unmerged work` };
}

/**
 * Plan which non-primary, non-cwd worktrees can be retired without losing
 * work. Makes exactly one write: `git fetch --prune <remote>`, needed so a
 * `[gone]` upstream reflects reality. Never removes anything itself.
 *
 * @param {object} opts
 * @param {string} opts.repo - Any directory inside the repository (the primary checkout).
 * @param {Function} [opts.execFile]
 * @param {string} [opts.cwd] - The running process's cwd, compared against each worktree's
 *   path to detect `active-cwd`. Defaults to `process.cwd()`.
 * @param {string} [opts.remote='origin']
 * @param {string} [opts.baseBranch='main']
 * @param {string} [opts.baseRef] - Overrides `${remote}/${baseBranch}` outright.
 * @param {Function} [opts.lookupSession] - `(worktreePath) => Promise<{sessionId}|null>`,
 *   passed through to {@link describeProvenance} for every candidate AND consulted directly
 *   to gate eligibility: a worktree a live session is using is always held, reason
 *   `live-session`, whether or not its directory name parses. If it THROWS, the candidate is
 *   held too, reason `lookup-failed` — a lookup that could not answer is never read as "no
 *   session".
 * @returns {Promise<{eligible: object[], skipped: object[], baseRef: string, fetch: object}>}
 *   Every entry (eligible or skipped) also carries `provenance`
 *   ({@link describeProvenance}'s result for that path). Fails closed on the fetch: if
 *   `git fetch --prune` did not succeed, every candidate lands in `skipped` with reason
 *   `fetch-failed` rather than being classified against possibly-stale remote-tracking refs —
 *   classification (`gone-upstream`, `ancestor-of-main`, `identical-to-main`) all rest on
 *   remote-tracking refs or `baseRef` being current.
 */
async function planWorktreeRetirement(opts) {
  const execFile = opts.execFile || gitProbe.defaultExecFile;
  const cwd = opts.repo;
  const procCwd = opts.cwd || process.cwd();
  const remote = opts.remote || 'origin';
  const baseRef = opts.baseRef || `${remote}/${opts.baseBranch || 'main'}`;
  const lookupSession = typeof opts.lookupSession === 'function' ? opts.lookupSession : null;

  const fetch = { attempted: true, ok: false, remote, detail: null };
  const fetched = await gitProbe.runGit(execFile, cwd, ['fetch', '--prune', '--quiet', remote], { network: true });
  fetch.ok = fetched.ok;
  if (!fetched.ok) fetch.detail = gitProbe.failureReason('fetch', fetched.err);

  const wl = await gitProbe.runGit(execFile, cwd, ['worktree', 'list', '--porcelain']);
  if (!wl.ok) {
    return { eligible: [], skipped: [], baseRef, fetch, error: gitProbe.failureReason('worktree list', wl.err) };
  }
  const trees = parseWorktreeList(wl.stdout);
  const primaryPath = trees.length > 0 ? trees[0].path : null;

  const eligible = [];
  const skipped = [];
  for (const t of trees) {
    if (t.bare || t.path === primaryPath) continue;
    if (t.prunable) {
      skipped.push({ path: t.path, branch: t.branch, oid: t.head, detached: t.detached, eligible: false, class: null, reason: WT_SKIP.UNKNOWN, detail: 'worktree is registered but missing on disk' });
      continue;
    }
    // Realpath-aware containment, not exact equality: a process working in a
    // SUBDIRECTORY of the worktree (`t.path`/src) is still actively using it,
    // and an exact-equality check would miss that entirely.
    if (isSameOrSubpath(procCwd, t.path)) {
      skipped.push({ path: t.path, branch: t.branch, oid: t.head, detached: t.detached, eligible: false, class: null, reason: WT_SKIP.ACTIVE_CWD, detail: 'this is the running process\'s current directory, or a subdirectory of it' });
      continue;
    }
    const provenance = await describeProvenance(t.path, { lookupSession });
    if (provenance.lookupError) {
      skipped.push({
        path: t.path, branch: t.branch, oid: t.head, detached: t.detached, eligible: false, class: null,
        reason: WT_SKIP.LOOKUP_FAILED,
        detail: `live-session lookup failed (${provenance.lookupError}) — holding fail-closed rather than assuming no live session`,
        provenance
      });
      continue;
    }
    if (provenance.sessionId) {
      skipped.push({
        path: t.path, branch: t.branch, oid: t.head, detached: t.detached, eligible: false, class: null,
        reason: WT_SKIP.LIVE_SESSION,
        detail: `worktree is bound to live session '${provenance.sessionId}' — never retiring a tree a live session may still be using`,
        provenance
      });
      continue;
    }
    const c = fetch.ok
      ? await _classifyWorktree(execFile, cwd, t, baseRef)
      : {
        path: t.path, branch: t.branch, oid: t.head, detached: t.detached, eligible: false, class: null,
        reason: WT_SKIP.FETCH_FAILED,
        detail: `the ${remote} fetch failed (${fetch.detail}) — refusing to classify against possibly stale remote-tracking refs`
      };
    c.provenance = provenance;
    (c.eligible ? eligible : skipped).push(c);
  }
  return { eligible, skipped, baseRef, fetch };
}

/**
 * Execute (or preview) a {@link planWorktreeRetirement} result.
 *
 * `--apply` re-verifies each entry immediately before removing it — the plan
 * may be stale by the time apply runs — demoting a now-ineligible entry to
 * `skipped` rather than removing it. Never passes `--force` to
 * `git worktree remove`.
 *
 * Applying REQUIRES a callable `opts.lookupSession`: a plan can be minutes old, and a live
 * session can attach to a worktree in that gap. A missing or non-function `lookupSession`
 * holds every entry rather than assuming "no caller supplied one" means "nothing is live" —
 * that assumption is exactly the gap this exists to close. `lookupSession` is re-invoked for
 * each entry immediately before `git worktree remove` runs (not just reused from the plan);
 * a thrown lookup or a session that now resolves holds that entry too.
 *
 * @param {object} plan - A {@link planWorktreeRetirement} result (or `{eligible: [...]}`).
 * @param {object} opts
 * @param {Function} [opts.execFile]
 * @param {string} opts.repo - The primary checkout, used to run `worktree remove`.
 * @param {boolean} [opts.apply=false]
 * @param {Function} [opts.lookupSession] - Required when `apply` is true; see above.
 * @param {string} [opts.baseRef] - Re-passed to the re-verify step; defaults to `plan.baseRef`.
 * @returns {Promise<{dryRun: boolean, removed: object[], skipped: object[]}>}
 */
async function retireWorktrees(plan, opts) {
  const execFile = opts.execFile || gitProbe.defaultExecFile;
  const apply = opts.apply === true;
  const baseRef = opts.baseRef || plan.baseRef;
  const lookupSession = opts.lookupSession;
  const removed = [];
  const skipped = [];
  for (const entry of plan.eligible || []) {
    if (!apply) {
      removed.push({ ...entry, action: 'would-remove' });
      continue;
    }
    if (typeof lookupSession !== 'function') {
      skipped.push({ ...entry, action: 'skipped-at-apply', reason: WT_SKIP.NO_LOOKUP_SESSION, detail: 'refusing to remove: no lookupSession was supplied to verify no live session is using this worktree' });
      continue;
    }
    const wl = await gitProbe.runGit(execFile, opts.repo, ['worktree', 'list', '--porcelain']);
    const trees = wl.ok ? parseWorktreeList(wl.stdout) : [];
    const fresh = trees.find((t) => t.path === entry.path);
    if (!fresh || fresh.bare) {
      skipped.push({ ...entry, action: 'skipped-at-apply', detail: 'worktree no longer exists' });
      continue;
    }
    const recheck = await _classifyWorktree(execFile, opts.repo, fresh, baseRef);
    if (!recheck.eligible) {
      skipped.push({ ...entry, action: 'skipped-at-apply', detail: `no longer eligible: ${recheck.detail}` });
      continue;
    }
    // Re-invoked here, as the LAST check before the removal itself: every git
    // call above (list, reclassify) takes real wall-clock time, and the
    // narrower the window between this check and `worktree remove`, the less
    // of it is spent unprotected. An OS exec window between this check
    // passing and the `worktree remove` process actually starting is
    // unavoidable without an OS-level lock this module does not take.
    let liveSession;
    try {
      liveSession = await lookupSession(entry.path);
    } catch (err) {
      skipped.push({ ...entry, action: 'skipped-at-apply', reason: WT_SKIP.LOOKUP_FAILED, detail: `live-session lookup failed immediately before removal (${err && err.message ? err.message : 'error'}) — holding fail-closed` });
      continue;
    }
    if (liveSession && liveSession.sessionId) {
      skipped.push({ ...entry, action: 'skipped-at-apply', reason: WT_SKIP.LIVE_SESSION, detail: `worktree is now bound to live session '${liveSession.sessionId}' — holding, never removing` });
      continue;
    }
    const rm = await gitProbe.runGit(execFile, opts.repo, ['worktree', 'remove', entry.path]);
    if (rm.ok) removed.push({ ...entry, action: 'removed' });
    else skipped.push({ ...entry, action: 'skipped-at-apply', detail: gitProbe.failureReason('worktree remove', rm.err) });
  }
  return { dryRun: !apply, removed, skipped };
}

/**
 * Plan which local branches, no longer held by any worktree, can be retired.
 * Must run *after* worktree retirement — a worktree pins its branch. Reuses
 * {@link assess} as the single verdict oracle; a branch is eligible only if
 * its upstream reads `[gone]` *and* `assess()` says `safe`. Makes one write
 * of its own, `git fetch --prune <remote>`, so a branch's `[gone]` status
 * reflects reality rather than a stale cached remote-tracking ref.
 *
 * @param {object} opts
 * @param {string} opts.repo
 * @param {Function} [opts.execFile]
 * @param {Function} [opts.readFile]
 * @param {Function} [opts.now]
 * @param {string} [opts.remote='origin']
 * @param {Set<string>|string[]} [opts.activeBranches] - Branch names a live session holds
 *   independent of any worktree (a session mid-dispatch, a lease not yet reflected in a
 *   checkout). Checked before `assess()` runs; a listed branch is always held, never consulted
 *   further — this is a caller-supplied cross-reference, the same contract as
 *   {@link planWorktreeRetirement}'s `lookupSession`, not something this module can derive on
 *   its own.
 * @returns {Promise<{eligible: object[], skipped: object[]}>}
 */
async function planBranchRetirement(opts) {
  const execFile = opts.execFile || gitProbe.defaultExecFile;
  const readFile = opts.readFile || fs.promises.readFile;
  const now = opts.now || (() => new Date());
  const repo = opts.repo;
  const remote = opts.remote || 'origin';
  const activeBranches = opts.activeBranches instanceof Set ? opts.activeBranches : new Set(opts.activeBranches || []);

  // A branch's upstream reads `[gone]` only once the stale remote-tracking
  // ref itself has been pruned — without this, a branch deleted on the
  // remote minutes ago still resolves locally and never looks gone. A
  // failed fetch just leaves the stale ref in place, which only ever
  // produces a false "not gone" (skip), never a false "gone" (fail-closed).
  await gitProbe.runGit(execFile, repo, ['fetch', '--prune', '--quiet', remote], { network: true });

  const br = await gitProbe.runGit(execFile, repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const branches = br.ok ? br.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];

  const eligible = [];
  const skipped = [];
  for (const branch of branches) {
    if (activeBranches.has(branch)) {
      skipped.push({ branch, verdict: null, reasons: [], detail: `bound to a live session — never retiring '${branch}'` });
      continue;
    }
    const gone = await _upstreamGone(execFile, repo, branch);
    if (gone !== true) {
      skipped.push({ branch, verdict: null, reasons: [], detail: gone === null ? 'could not determine upstream status' : 'upstream is not gone' });
      continue;
    }
    const a = await assess({ repo, branch, execFile, readFile, now });
    if (a.verdict === VERDICTS.SAFE) eligible.push({ branch, oid: a.oid, assessment: a });
    else skipped.push({ branch, verdict: a.verdict, reasons: a.reasons, detail: a.safeNextAction });
  }
  return { eligible, skipped };
}

/**
 * Execute (or preview) a {@link planBranchRetirement} result.
 *
 * `--apply` re-runs {@link assess} immediately before each deletion (the
 * same TOCTOU guard as {@link retireWorktrees}) and deletes only an entry
 * still verified `safe`, via plain `git branch -d`.
 *
 * @param {object} plan - A {@link planBranchRetirement} result (or `{eligible: [...]}`).
 * @param {object} opts
 * @param {Function} [opts.execFile]
 * @param {Function} [opts.readFile]
 * @param {Function} [opts.now]
 * @param {string} opts.repo
 * @param {boolean} [opts.apply=false]
 * @returns {Promise<{dryRun: boolean, removed: object[], skipped: object[]}>}
 */
async function retireBranches(plan, opts) {
  const execFile = opts.execFile || gitProbe.defaultExecFile;
  const readFile = opts.readFile || fs.promises.readFile;
  const now = opts.now || (() => new Date());
  const apply = opts.apply === true;
  const removed = [];
  const skipped = [];
  for (const entry of plan.eligible || []) {
    if (!apply) {
      removed.push({ ...entry, action: 'would-delete' });
      continue;
    }
    const a = await assess({ repo: opts.repo, branch: entry.branch, execFile, readFile, now });
    if (a.verdict !== VERDICTS.SAFE) {
      skipped.push({ ...entry, action: 'skipped-at-apply', detail: `no longer safe: ${a.safeNextAction}` });
      continue;
    }
    const del = await gitProbe.runGit(execFile, opts.repo, ['branch', '-d', entry.branch]);
    if (del.ok) removed.push({ ...entry, action: 'deleted' });
    else skipped.push({ ...entry, action: 'skipped-at-apply', detail: gitProbe.failureReason('branch -d', del.err) });
  }
  return { dryRun: !apply, removed, skipped };
}

/** Matches this install's generated worktree directory names, e.g. `agent-3f9a1c2b`. */
const AGENT_WORKTREE_NAME_RE = /^agent-([0-9a-f]{4,64})(?:-(\d+))?$/;

/**
 * Best-effort provenance for an `agent-<hash>`-style worktree, so a stale
 * install's inventory is triageable without opening each one.
 *
 * No durable per-worktree provenance record exists anywhere in this
 * codebase today (`workTree`/`scope.workTree`, e.g. in `lib/wrap-scope.js`,
 * describes a *live* session's current worktree, not a retired one's
 * history) — so this is name-parse-first, with an optional, best-effort
 * cross-reference into a live session store. The cross-reference is tried
 * for ANY worktree path, not only one whose name parses — a worktree a live
 * session is using is not necessarily named `agent-<hash>`, and a caller
 * relying on `sessionId` to decide liveness must not miss one just because
 * the name didn't match. It never throws itself and never invents a value
 * it could not derive — but a thrown `lookupSession` is reported via
 * `lookupError`, never swallowed into a false "no session": a caller gating
 * retirement on `sessionId` alone would otherwise read a lookup failure as
 * "proven safe" when it is really "unproven", exactly backwards for a
 * fail-closed gate.
 *
 * @param {string} worktreePath
 * @param {object} [opts]
 * @param {Function} [opts.stat] - `fs.promises.stat`-compatible seam.
 * @param {Function} [opts.lookupSession] - `(worktreePath) => Promise<{sessionId}|null>`,
 *   a caller-supplied cross-reference into whatever live session store it has.
 * @returns {Promise<{worktreePath: string, issueNumber: (number|null), createdAt: (string|null),
 *   sessionId: (string|null), source: ('name-parse'|'name-parse+store'|'store'|'unknown'),
 *   lookupError: (string|null)}>}
 */
async function describeProvenance(worktreePath, opts = {}) {
  const stat = opts.stat || fs.promises.stat;
  const base = path.basename(worktreePath);
  const m = AGENT_WORKTREE_NAME_RE.exec(base);
  const result = { worktreePath, issueNumber: null, createdAt: null, sessionId: null, source: 'unknown', lookupError: null };
  if (m) {
    result.issueNumber = m[2] ? Number(m[2]) : null;
    result.source = 'name-parse';
    try {
      const s = await stat(worktreePath);
      result.createdAt = (s.birthtime && s.birthtime.getTime() > 0 ? s.birthtime : s.mtime).toISOString();
    } catch {
      // Directory unreadable — leave createdAt null rather than guess.
    }
  }
  if (typeof opts.lookupSession === 'function') {
    try {
      const session = await opts.lookupSession(worktreePath);
      if (session && session.sessionId) {
        result.sessionId = session.sessionId;
        result.source = result.source === 'name-parse' ? 'name-parse+store' : 'store';
      }
    } catch (err) {
      // Unlike a missing name-match, a THROWN lookup means liveness could
      // not be answered at all — keep that distinguishable from "answered,
      // and the answer was no" (a null `sessionId`).
      result.lookupError = err && err.message ? err.message : 'lookupSession failed';
    }
  }
  return result;
}

module.exports = {
  assess,
  render,
  safeNextAction,
  parseWorktreeList,
  parseDirt,
  isSameOrSubpath,
  planWorktreeRetirement,
  retireWorktrees,
  planBranchRetirement,
  retireBranches,
  describeProvenance,
  VERDICTS,
  REASONS,
  REASON_VERDICT,
  WT_SKIP,
  WT_CLASS
};
