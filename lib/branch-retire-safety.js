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
 * Count dirt in `git status --porcelain=v2 -z --untracked-files=all` output:
 * staged changes, unstaged changes, unmerged paths and untracked files are
 * each counted separately, so the report can say which kind is at risk.
 *
 * @param {string} out
 * @returns {{staged: number, unstaged: number, unmerged: number, untracked: number}}
 */
function parseDirt(out) {
  const d = { staged: 0, unstaged: 0, unmerged: 0, untracked: 0 };
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
    }
  }
  return d;
}

/**
 * Whether a dirt count holds anything at all.
 *
 * @param {{staged: number, unstaged: number, unmerged: number, untracked: number}} d
 * @returns {boolean}
 */
function _isDirty(d) {
  return d.staged + d.unstaged + d.unmerged + d.untracked > 0;
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
      const st = await gitProbe.runGit(execFile, t.path, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
      if (!st.ok) {
        add(REASONS.WORKTREE_STATUS_FAILED, gitProbe.failureReason(`status of ${t.path}`, st.err));
        continue;
      }
      entry.dirt = parseDirt(st.stdout);
      if (_isDirty(entry.dirt)) {
        const d = entry.dirt;
        add(REASONS.WORKTREE_DIRTY, `worktree at ${t.path} has ${d.staged} staged, ${d.unstaged} unstaged, `
          + `${d.unmerged} unmerged and ${d.untracked} untracked path(s)`);
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

module.exports = {
  assess,
  render,
  safeNextAction,
  parseWorktreeList,
  parseDirt,
  VERDICTS,
  REASONS,
  REASON_VERDICT
};
