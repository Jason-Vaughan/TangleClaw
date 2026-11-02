'use strict';
/**
 * Where the primary checkout is, and which of its worktrees a path belongs to.
 *
 * This repo's primary checkout is the running install: launchd serves `public/`
 * straight off that working tree. Chunk work happens in git worktrees, so
 * "which checkout does this path land in" is a question three callers ask — the
 * PreToolUse guard that refuses writes landing in the primary (#798), the
 * installer that wires it, and `lib/server-info.js` (#1672), which must not
 * silently adopt an active Builder/agent checkout's branch state or worktree
 * coupling as its own when it resolves which checkout the background server
 * runs from (`resolveServerCheckoutRoot`, `describeServerRootCoupling`). They
 * ask it identically, so it is answered once here rather than in several files
 * that can drift apart.
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
 * The guard's sentinel override, relative to the primary checkout.
 *
 * It lives here rather than in either script because BOTH need it and neither
 * can import the other: the guard attaches stdin handlers at load, so requiring
 * it from the installer would hang. Spelled twice, a rename in the guard would
 * leave `--self-test` telling the operator to delete a path that no longer
 * exists — advice that reads authoritative and does nothing. This module is the
 * one thing both files already require.
 */
const OVERRIDE_FILE = path.join('.prawduct', '.allow-primary-write');

/** Env var that waives the guard for one command; can be set inline, so it is not sticky. */
const OVERRIDE_ENV = 'TANGLECLAW_ALLOW_PRIMARY_WRITE';

/**
 * Env var naming a dedicated server-install checkout root (#1672), independent
 * of wherever the running process's own module files happen to resolve from.
 * Set it when the background server (`com.tangleclaw.server` / the systemd
 * user unit) is installed to a canonical, dedicated checkout rather than
 * started from whatever checkout happened to be active — the case
 * `describeServerRootCoupling` below exists to detect when this is NOT set
 * and the fallback root turns out to be an active Builder/agent checkout or a
 * linked git worktree.
 */
const SERVER_ROOT_ENV = 'TANGLECLAW_SERVER_ROOT';

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

/**
 * Whether `root` looks like a real TangleClaw checkout: it exists, is a
 * directory, contains `server.js` at its top level, and is a recognizable
 * git checkout (`locateCheckouts` resolves it) (#1672 Round 2).
 *
 * Checked before `resolveServerCheckoutRoot` ever treats a `${SERVER_ROOT_ENV}`
 * value as authoritative: an unchecked override pointing at a typo'd, deleted,
 * or unrelated path would otherwise turn every git/disk probe into "no-git" or
 * "unknown" while the server is live — worse than the coupling problem the
 * override exists to solve, since the server would go dark on staleness
 * detection entirely rather than merely reading the wrong (but real) checkout.
 *
 * @param {string} root - Absolute, already symlink-resolved path.
 * @returns {{ ok: boolean, reason: string|null }}
 */
function _validateServerCheckoutRoot(root) {
  let exists;
  try {
    exists = fs.existsSync(root);
  } catch (err) {
    return { ok: false, reason: `could not check whether the path exists: ${(err && err.message) || err}` };
  }
  if (!exists) return { ok: false, reason: 'path does not exist' };

  let stat;
  try {
    stat = fs.statSync(root);
  } catch (err) {
    return { ok: false, reason: `could not stat the path: ${(err && err.message) || err}` };
  }
  if (!stat.isDirectory()) return { ok: false, reason: 'path is not a directory' };

  if (!fs.existsSync(path.join(root, 'server.js'))) {
    return { ok: false, reason: 'no server.js at the path — not a recognizable TangleClaw checkout' };
  }

  if (!locateCheckouts(root)) {
    return { ok: false, reason: 'no recognizable git checkout (.git) at the path' };
  }

  return { ok: true, reason: null };
}

/**
 * Resolve the checkout root the background server should treat as its own,
 * without mutating anything on disk (#1672).
 *
 * Precedence: an explicit `${SERVER_ROOT_ENV}` override — a dedicated,
 * canonical server install, the clean-repointing case a smoke test or a
 * dedicated install wants — wins ONLY when it validates
 * (`_validateServerCheckoutRoot`, Round 2): it must exist, be a directory,
 * contain `server.js`, and be a recognizable git checkout. An override that
 * fails validation is never used as the resolved root — it falls back to
 * `defaultRoot` exactly as if unset, and the failure is reported in
 * `invalidServerRootOverride` so a caller can surface it rather than resolve
 * silently onto the wrong checkout. `defaultRoot` (normally wherever the
 * running process's own module resolved from, e.g. `path.resolve(__dirname,
 * '..')`) is otherwise used as-is, with no validation of its own — it is
 * the process's own checkout, not a caller-supplied path. Either way the
 * result is symlink-resolved (`realOrSelf`), and `source` says which path
 * was actually taken, so a caller never has to re-derive that itself.
 *
 * @param {string} defaultRoot - Absolute fallback root to use when no
 *   override is set, or when a set override fails validation.
 * @param {{ env?: NodeJS.ProcessEnv }} [options] - `env` defaults to
 *   `process.env`; a caller injects a fake one for determinism in tests.
 * @returns {{
 *   root: string,
 *   source: 'override'|'default',
 *   invalidServerRootOverride?: { requested: string, resolved: string, reason: string }
 * }} `invalidServerRootOverride` is present only when `${SERVER_ROOT_ENV}`
 *   was set but failed validation (and therefore was NOT used).
 */
function resolveServerCheckoutRoot(defaultRoot, options = {}) {
  const env = options.env || process.env;
  const override = env[SERVER_ROOT_ENV];
  if (typeof override === 'string' && override.trim().length > 0) {
    const requested = override.trim();
    const resolved = realOrSelf(requested);
    const validity = _validateServerCheckoutRoot(resolved);
    if (validity.ok) {
      return { root: resolved, source: 'override' };
    }
    return {
      root: realOrSelf(defaultRoot),
      source: 'default',
      invalidServerRootOverride: { requested, resolved, reason: validity.reason }
    };
  }
  return { root: realOrSelf(defaultRoot), source: 'default' };
}

/**
 * Describe how a resolved checkout root relates to the primary/worktree
 * layout around it (#1672), for a caller — the background server — that must
 * not silently inherit an active Builder/agent checkout's coupling as if it
 * were its own, isolated install.
 *
 * Two independent facts, because they are different risks:
 * - `isLinkedWorktree`: the resolved root ITSELF is a linked worktree, not a
 *   primary checkout — a server running from here is coupled to whatever
 *   primary that worktree hangs off, and that primary's own lifecycle
 *   (removed, rebased, pruned) can pull the rug out from under the server.
 * - `hasLinkedWorktrees`: the resolved root IS a primary checkout, but one or
 *   more Builder/agent worktrees are linked off it right now — an active
 *   Builder checkout sharing the same primary the server reads its own
 *   branch/freshness from. This does not misreport the server's own
 *   `currentDiskSha`/branch state (it is still reading the primary's own
 *   HEAD, which is correct for the primary itself, and a linked worktree's
 *   own HEAD never desyncs what this reports); the flag is purely
 *   informational, so an operator can tell the server isn't running from an
 *   otherwise-isolated, dedicated-only checkout.
 *
 * Read-only: calls only `locateCheckouts`/`linkedWorktreeRoots`, neither of
 * which touches anything outside `.git`, and mutates nothing.
 *
 * @param {string} resolvedRoot - Normally `resolveServerCheckoutRoot(...).root`.
 * @returns {{
 *   checkout: {primary: string, isWorktree: boolean}|null,
 *   isLinkedWorktree: boolean,
 *   hasLinkedWorktrees: boolean,
 *   linkedWorktreeCount: number,
 *   coupled: boolean
 * }} `checkout` is `null` when the root is not inside a recognizable git
 *   layout at all (e.g. a tarball install with no `.git`) — not itself a
 *   coupling risk, so `coupled` stays `false` in that case. Otherwise
 *   `coupled` is `isLinkedWorktree || hasLinkedWorktrees`: true whenever the
 *   resolved root shares a lifecycle with some other active checkout.
 */
function describeServerRootCoupling(resolvedRoot) {
  const checkout = locateCheckouts(resolvedRoot);
  if (!checkout) {
    return { checkout: null, isLinkedWorktree: false, hasLinkedWorktrees: false, linkedWorktreeCount: 0, coupled: false };
  }
  if (checkout.isWorktree) {
    return { checkout, isLinkedWorktree: true, hasLinkedWorktrees: false, linkedWorktreeCount: 0, coupled: true };
  }
  const { roots } = linkedWorktreeRoots(checkout.primary);
  return {
    checkout,
    isLinkedWorktree: false,
    hasLinkedWorktrees: roots.length > 0,
    linkedWorktreeCount: roots.length,
    coupled: roots.length > 0
  };
}

module.exports = {
  realOrSelf,
  locateCheckouts,
  linkedWorktreeRoots,
  landsInPrimary,
  resolveServerCheckoutRoot,
  describeServerRootCoupling,
  validateServerCheckoutRoot: _validateServerCheckoutRoot,
  OVERRIDE_FILE,
  OVERRIDE_ENV,
  SERVER_ROOT_ENV
};
