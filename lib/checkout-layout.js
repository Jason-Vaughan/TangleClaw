'use strict';
/**
 * Where the primary checkout is, and which of its worktrees a path belongs to.
 *
 * This repo's primary checkout is the running install: launchd serves `public/`
 * straight off that working tree. Chunk work happens in git worktrees, so
 * "which checkout does this path land in" is a question two callers ask — the
 * PreToolUse guard that refuses writes landing in the primary (#798) and the
 * installer that wires it. They ask it identically, so it is answered once here
 * rather than twice in two files that can drift apart.
 *
 * Read from git's own bookkeeping on disk rather than by spawning git: the
 * guard runs ahead of every matched tool call, and a subprocess per keystroke is
 * a cost the answer does not need.
 *
 * That is a claim about the LAYOUT questions only, and it is worth bounding
 * because the guard does spawn git elsewhere. `isTracked` shells out to
 * `git ls-files`, deliberately: there is no on-disk index format this module
 * could read as cheaply or as correctly, and the call is reached only on the
 * file-write arm, only after these functions have already answered that the
 * write lands in the primary, and only when it is not the live surface — a path
 * that is rare by construction. The layout questions are asked on EVERY matched
 * call, which is why they must stay subprocess-free.
 *
 * Deliberately a leaf module — node built-ins plus `lib/project-paths.js`, the
 * repo's sole containment predicate — so a hook script outside `lib/` can
 * require it without pulling in the server.
 *
 * @module lib/checkout-layout
 */

const fs = require('node:fs');
const path = require('node:path');

const { checkContainment } = require('./project-paths');

/**
 * Resolve a path through symlinks, final component included, tolerating a
 * target that does not exist yet.
 *
 * `realpathSync` throws on a missing path, and the guard's targets are
 * routinely about to be created — so resolve the deepest EXISTING ancestor and
 * re-attach the un-created tail. A missing intermediate directory cannot be a
 * symlink, so nothing is skipped by walking up.
 *
 * When resolution is impossible the LEXICAL path is returned. Said plainly
 * because the direction matters: for a containment test that fallback is
 * permissive, and it is chosen to match the guard's deliberate fail-open posture
 * rather than by accident.
 *
 * @param {string} p - Absolute or relative path.
 * @returns {string} Absolute, symlink-resolved path.
 */
function realOrSelf(p) {
  const lexical = path.resolve(p);
  let dir = lexical;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...tail);
    } catch (err) {
      const parent = path.dirname(dir);
      if (parent === dir) return lexical;
      tail.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * Locate the primary checkout from any checkout of the same repository.
 *
 * A linked worktree's `.git` is a FILE holding
 * `gitdir: <primary>/.git/worktrees/<name>`; the primary's `.git` is a
 * directory. Any other layout — a submodule, a bare repo, a `.git` that is
 * neither — is reported as unknown rather than guessed at, because a guard that
 * invents a primary would refuse writes against a path nobody serves.
 *
 * @param {string} checkoutRoot - Absolute path to a checkout of the repository.
 * @returns {{primary:string, isWorktree:boolean}|null} Null when the layout
 *   could not be established.
 */
function locateCheckouts(checkoutRoot) {
  const root = realOrSelf(checkoutRoot);
  const dotGit = path.join(root, '.git');
  let st;
  try {
    st = fs.lstatSync(dotGit);
  } catch (err) {
    return null;
  }
  if (st.isDirectory()) return { primary: root, isWorktree: false };
  if (!st.isFile()) return null;

  let gitdir;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    gitdir = path.resolve(root, m[1].trim());
  } catch (err) {
    return null;
  }
  // `<primary>/.git/worktrees/<name>` — three components up is the primary root.
  // Anchored on the `.git/worktrees` PAIR rather than on the last `worktrees`
  // segment alone, so a repository that happens to contain a directory called
  // `worktrees` cannot be read as a git worktree record.
  const parts = gitdir.split(path.sep);
  const at = parts.lastIndexOf('worktrees');
  if (at < 2 || parts[at - 1] !== '.git') return null;
  const primary = parts.slice(0, at - 1).join(path.sep) || path.sep;
  return { primary: realOrSelf(primary), isWorktree: true };
}

/**
 * Every linked worktree root the primary knows about.
 *
 * Enumerated from `.git/worktrees/*&#47;gitdir` rather than assumed to live under
 * `.claude/worktrees/`. The convention puts them there, and that is exactly why
 * they must be enumerated: a worktree NESTED inside the primary is lexically
 * inside it, so without subtracting these roots every write inside every
 * worktree would read as a write to the primary.
 *
 * An empty answer and an UNKNOWN answer are reported differently, and the
 * distinction is the whole safety property. `ENOENT` genuinely means "there are
 * no worktrees". `EACCES`, `EIO`, `ENOTDIR` mean the subtraction list could not
 * be established — and a caller handed an empty list reads every path inside
 * every nested worktree as belonging to the primary, so it refuses all of them.
 * Collapsing the two into `{roots: []}` is therefore a fail-CLOSED hole inside a
 * fail-open guard, and it is silent: `unreadable` would be empty too, so nothing
 * would print.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {{roots:string[], unreadable:string[], failed:string|null}} Resolved
 *   roots; the names of individual records that could not be read; and, when the
 *   directory itself could not be listed for a reason other than absence, the
 *   errno that stopped it.
 */
function linkedWorktreeRoots(primary) {
  const base = path.join(primary, '.git', 'worktrees');
  let names;
  try {
    names = fs.readdirSync(base);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { roots: [], unreadable: [], failed: null };
    return { roots: [], unreadable: [], failed: (err && err.code) || 'unknown' };
  }
  const roots = [];
  const unreadable = [];
  for (const name of names) {
    try {
      const gitdir = fs.readFileSync(path.join(base, name, 'gitdir'), 'utf8').trim();
      if (gitdir) roots.push(realOrSelf(path.dirname(gitdir)));
      else unreadable.push(name);
    } catch (err) {
      unreadable.push(name);
    }
  }
  return { roots, unreadable, failed: null };
}

/**
 * Does this path ultimately land in the primary checkout proper, rather than
 * inside one of its worktrees?
 *
 * Evaluated on the symlink-RESOLVED path, which is what makes a worktree's
 * symlinked governance state answer correctly: `.prawduct/learnings.md` inside a
 * worktree is a link into the primary and genuinely does land there. Whether
 * that matters is a separate question (it is untracked, so it does not); this
 * function answers only where the bytes go.
 *
 * `allowRoot` is passed to BOTH containment questions or the answer is
 * incoherent. A caller asking about a DIRECTORY — "does this git command act on
 * the primary?" — needs the primary root to count as inside itself, and needs a
 * worktree root to count as inside its own worktree so the subtraction below
 * fires. Setting it on one side only would refuse every command run in a
 * worktree root while missing every command run in the primary root: both
 * failures at once, in opposite directions.
 *
 * @param {string} realTarget - Absolute, symlink-resolved target path.
 * @param {string} primary - Absolute primary checkout root.
 * @param {string[]} worktreeRoots - Absolute, symlink-resolved worktree roots.
 * @param {object} [options]
 * @param {boolean} [options.allowRoot=false] - Treat a checkout root as being
 *   inside itself. For directory questions; leave off for file targets.
 * @returns {boolean} True when the path lands in the primary checkout proper.
 */
function landsInPrimary(realTarget, primary, worktreeRoots, options = {}) {
  const opts = { allowRoot: options.allowRoot === true };
  if (!checkContainment(primary, realTarget, opts).inside) return false;
  return !worktreeRoots.some((wt) => checkContainment(wt, realTarget, opts).inside);
}

module.exports = {
  realOrSelf,
  locateCheckouts,
  linkedWorktreeRoots,
  landsInPrimary
};
