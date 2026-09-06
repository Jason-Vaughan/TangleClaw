'use strict';

/**
 * Containment rules for operator-supplied paths that are interpreted relative
 * to a project root.
 *
 * A settings field that names a file the server later reads or writes is an
 * arbitrary-file primitive unless something constrains it. The constraint has
 * to hold at every site independently — the API validator can't be the only
 * guard, because a hand-edited `.tangleclaw/project.json` never passes through
 * it — so the rule lives here once for the callers that need *a file strictly
 * inside the project*.
 *
 * **Scope of that claim.** Every PROJECT-root containment check in a module that
 * can require this one lands on the single predicate below — both public
 * entry points here, and the wrap pipeline's three plan pointers. A caller
 * meaning something different asks for it here with an option rather than
 * hand-rolling a check; exactly one does (`PLAN_POINTER_CONTAINMENT` in
 * `lib/wrap-steps/priming-roll.js` does not follow symlinks, because worktree
 * governance state is symlinked out of the worktree by convention).
 *
 * Two containment checks in the repo are deliberately NOT here, and neither is
 * about a project root: `lib/master.js`'s Project Master write guard is
 * generated into a hook script inside a template literal and so cannot require
 * any module, and `lib/projects.js`'s `createProjectsDir` bounds against `$HOME`
 * on a pre-auth surface. Both fail closed. The claim is bounded to what this
 * module can govern rather than kept as a universal, because a universal that
 * is wrong tells the next maintainer to stop looking — which is the failure this
 * module exists to fix.
 *
 * Deliberately a leaf module: node built-ins only, no project requires, so any
 * consumer (including `lib/wrap-steps/*`, which sits inside the
 * `projects → sessions → wrap-pipeline → wrap-steps` require cycle) can pull it
 * in at module top without risking a partially-initialized import.
 *
 * @module lib/project-paths
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * The containment rule itself — the one place that decides whether an absolute
 * path lies inside a project root, and the only place either public predicate
 * gets its answer.
 *
 * Resolution-based rather than a lexical `..` scan, because a lexical check
 * disagrees in both directions: it rejects `a/../b.json` (which resolves safely
 * inside) and accepts `.` (which resolves to the root, a directory nothing can
 * write as a file). A validator that accepts what the write site later refuses
 * produces a setting that saves cleanly and then silently does nothing.
 *
 * The root is never inside: every caller here names a FILE, and the root is a
 * directory. That was the disagreement this function exists to end — one
 * caller's hand-rolled check counted the root as inside, long read as a
 * deliberate difference for a caller validating directories. No such caller
 * exists (see `PLAN_POINTER_CONTAINMENT` in `lib/wrap-steps/priming-roll.js`),
 * so this is one rule rather than a policy option nothing selects.
 *
 * @param {string} projectRoot - Project root (need not be pre-resolved)
 * @param {string} absolutePath - Path to test (need not be pre-resolved)
 * @param {object} [options]
 * @param {boolean} [options.followSymlinks=true] - Also require containment
 *   after symlinks are resolved.
 * @returns {{inside:true}|{inside:false, reason:string}} `reason` is a sentence
 *   FRAGMENT ("resolves outside the project root") so callers can compose it
 *   after the field name they are validating — the operator reads
 *   "versionFilePath resolves outside the project root", not "versionFilePath
 *   path resolves outside…".
 */
function _containsPath(projectRoot, absolutePath, options = {}) {
  const followSymlinks = options.followSymlinks !== false;

  const root = path.resolve(projectRoot);
  const resolved = path.resolve(absolutePath);
  const rel = path.relative(root, resolved);

  if (rel === '') {
    return { inside: false, reason: 'resolves to the project root itself, not a file inside it' };
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { inside: false, reason: 'resolves outside the project root' };
  }

  if (!followSymlinks) return { inside: true };

  // Lexical resolution alone is not containment: `linkdir/VERSION.json`, where
  // `linkdir` is a symlink pointing out of the project, passes every check above
  // and the commit step then writes through it. Resolve symlinks too.
  //
  // The target itself may legitimately not exist yet (the operator can name a
  // file before creating it), and `realpathSync` throws on a missing path — so
  // `_realpathOrSelf` resolves the deepest ANCESTOR that does exist and re-tests
  // containment with the un-created tail appended. A missing intermediate
  // directory can't be a symlink, so nothing is skipped by walking up.
  //
  // Resolved WHOLE, final component included. An earlier shape resolved only
  // the dirname and appended the basename unresolved, which left the file
  // itself — `VERSION.json` as a symlink to `/etc/passwd` — outside the check
  // that exists to stop exactly that write. When the target does not exist,
  // this is identical: the walk-up lands on the dirname anyway.
  const realRoot = _realpathOrSelf(root);
  const realResolved = _realpathOrSelf(resolved);
  if (realRoot === null || realResolved === null) {
    return { inside: false, reason: 'cannot be resolved to a location inside the project root' };
  }
  const realRel = path.relative(realRoot, realResolved);
  if (realRel === '' || realRel.startsWith('..') || path.isAbsolute(realRel)) {
    return { inside: false, reason: 'resolves outside the project root once symlinks are followed' };
  }

  return { inside: true };
}

/**
 * Resolve a project-relative path, refusing anything that escapes the project,
 * names the root itself, or cannot be resolved.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {string} relativePath - Operator-supplied path, relative to the root
 * @param {object} [options] - Containment policy; see {@link _containsPath}.
 * @param {boolean} [options.followSymlinks=true]
 * @returns {{ok:true, path:string}|{ok:false, reason:string}} `path` is absolute
 *   and lexically resolved (symlinks are a containment test, not a rewrite: the
 *   caller gets back the path it named, so an error message quotes what the
 *   operator wrote). `reason` is a sentence fragment — see {@link _containsPath}.
 */
function resolveWithinProject(projectRoot, relativePath, options = {}) {
  const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
  if (raw === '') {
    return { ok: false, reason: 'is empty' };
  }
  if (path.isAbsolute(raw)) {
    return { ok: false, reason: 'must be relative to the project root, not absolute' };
  }

  const resolved = path.resolve(path.resolve(projectRoot), raw);
  const contained = _containsPath(projectRoot, resolved, options);
  return contained.inside ? { ok: true, path: resolved } : { ok: false, reason: contained.reason };
}

/**
 * Containment with the REASON, for a caller composing its own error message
 * about an already-absolute path.
 *
 * `isInsideProject` collapses this to a boolean, which is what most callers
 * want; a caller that reports the failure to an operator needs the fragment,
 * because "resolves outside the project root" sends someone hunting for an
 * escape when what they wrote resolved to the root, or could not be resolved at
 * all. Same rule, same options — this is the shape, and the boolean is the
 * convenience over it.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {string} absolutePath - Absolute path to test
 * @param {object} [options] - Containment policy; see {@link _containsPath}.
 * @param {boolean} [options.followSymlinks=true]
 * @returns {{inside:true}|{inside:false, reason:string}} `reason` is a sentence
 *   fragment — see {@link _containsPath}.
 */
function checkContainment(projectRoot, absolutePath, options = {}) {
  if (typeof projectRoot !== 'string' || typeof absolutePath !== 'string'
      || projectRoot.trim() === '' || absolutePath.trim() === '') {
    return { inside: false, reason: 'cannot be resolved to a location inside the project root' };
  }
  return _containsPath(projectRoot, absolutePath, options);
}

/**
 * Does an ALREADY-ABSOLUTE path live inside a project?
 *
 * The sibling of `resolveWithinProject`, which validates operator-supplied
 * RELATIVE paths and refuses absolute ones on purpose. This answers the other
 * question: given a path the system already holds — a registered shared
 * document's location, say — whose project owns it? Same symlink-aware
 * containment rule, so the two cannot disagree about what "inside" means.
 *
 * Never throws and never fails open: a caller using this to decide whom NOT to
 * notify must degrade to "not inside" on bad input rather than failing the
 * broadcast.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {string} absolutePath - Absolute path to test
 * @param {object} [options] - Containment policy; see {@link _containsPath}.
 * @param {boolean} [options.followSymlinks=true]
 * @returns {boolean} True only when the path resolves inside the root under the
 *   requested policy.
 */
function isInsideProject(projectRoot, absolutePath, options = {}) {
  return checkContainment(projectRoot, absolutePath, options).inside;
}

/**
 * Maximum symlink hops followed while resolving a DANGLING link.
 *
 * `fs.realpathSync` enforces its own limit and reports `ELOOP`, but it refuses
 * a link whose target does not exist, so the dangling case is resolved by hand
 * below and needs its own bound. The value only has to exceed any legitimate
 * chain; a cycle is what it is really there to stop.
 *
 * Exhausting it is UNRESOLVABLE, not "inside". Linux follows up to 40 nested
 * links, so a budget that fell back to the lexical answer would hand hops 33-40
 * to a caller as contained while the kernel still followed them at the write.
 * The same holds for a component that cannot be read at all: a boundary that
 * could not be established must refuse, which is what this repo's other
 * containment guard (the Project Master write guard in `lib/master.js`) already
 * does on the identical question.
 */
const MAX_DANGLING_LINK_HOPS = 32;

/**
 * `fs.realpathSync` for a path that may not exist: resolve the deepest existing
 * ancestor and re-append the un-created tail.
 *
 * **Dangling symlinks are resolved by hand**, because `realpathSync` refuses
 * them and the walk-up would otherwise discard the link entirely — reporting
 * the link's own location, inside the project, for a path that writes outside
 * it. `fs.writeFileSync` follows a dangling link and creates its target, so
 * that is a real escape and not a theoretical one.
 *
 * Returns `null` when resolution cannot be completed — a hop budget exhausted,
 * or a component that exists and cannot be read. That is a third state on
 * purpose: composing a lexical answer for a path the filesystem would resolve
 * differently is how a containment check reports "inside" about a write that
 * lands outside, and the caller can only refuse if it is told.
 *
 * @param {string} target - Absolute path, which may not exist
 * @returns {string|null} Absolute and symlink-resolved, or `null` if
 *   containment cannot be established from it.
 */
function _realpathOrSelf(target) {
  let current = path.resolve(target);
  const tail = [];
  for (let hops = 0; ; ) {
    let failure;
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch (err) {
      failure = err;
    }

    // A dangling link resolves nowhere and still says exactly where a write
    // would land, so follow it rather than walking past it.
    let linkTarget = null;
    try {
      linkTarget = fs.readlinkSync(current);
    } catch {  // prawduct:allow prawduct/broad-except -- any failure here means "treat it as not a symlink"; the errno check below decides whether that is absence or opacity
      linkTarget = null;
    }
    if (linkTarget !== null) {
      if (hops >= MAX_DANGLING_LINK_HOPS) return null; // budget spent — unresolvable, not "inside"
      hops += 1;
      current = path.resolve(path.dirname(current), linkTarget);
      continue;
    }

    // Only "it is not there" justifies walking up to the parent — the whole
    // reason this walk exists is a file the operator has not created yet. Any
    // other errno (EACCES, ELOOP, ENAMETOOLONG) means we could not LOOK, which
    // is not the same as absent: stepping over the component that stopped us
    // would report containment about a location nobody established.
    if (failure.code !== 'ENOENT' && failure.code !== 'ENOTDIR') return null;

    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target); // hit the filesystem root
    tail.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Normalize a configured path value out of a project config: a non-blank string
 * becomes its trimmed self, anything else becomes null.
 *
 * Trivial, and shared anyway — the `typeof === 'string' && trim() !== ''` dance
 * was being re-derived at every read site, which is how two of them came to
 * disagree about whether `"  "` means "configured" or "not configured".
 *
 * @param {*} value
 * @returns {string|null}
 */
function normalizeConfiguredPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Read a project-relative path setting out of a project config and resolve it,
 * in one step — the whole recipe, so callers don't reassemble it.
 *
 * Callers differ in what they DO on failure (the wrap step refuses outright; the
 * version reader degrades to its probe), and that stays their decision. What
 * they must not differ on is what "configured" means and where it is allowed to
 * point, which is what this returns.
 *
 * For a value arriving as an incoming update rather than out of a loaded config
 * — an API validator, say — use {@link normalizeConfiguredPath} then
 * {@link resolveWithinProject} directly; this helper's config-read half doesn't
 * apply, but the other two must still be the shared ones.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {object|null} projConfig - Loaded project config (may be null)
 * @param {string} key - Config key holding the path (e.g. `'versionFilePath'`)
 * @returns {{configured:false}
 *   |{configured:true, ok:true, raw:string, path:string}
 *   |{configured:true, ok:false, raw:string, reason:string}}
 */
function resolveConfiguredFile(projectRoot, projConfig, key) {
  const raw = normalizeConfiguredPath(projConfig ? projConfig[key] : null);
  if (raw === null) return { configured: false };

  const contained = resolveWithinProject(projectRoot, raw);
  return contained.ok
    ? { configured: true, ok: true, raw, path: contained.path }
    : { configured: true, ok: false, raw, reason: contained.reason };
}

/**
 * Collapse a `$HOME`-prefixed absolute path to `~/…` for display in a file that
 * gets COMMITTED.
 *
 * TangleClaw generates several artifacts that land in a managed project's repo
 * and are routinely pushed to public remotes — `PROJECT-MAP.md`'s shared-dir
 * section and the shared-docs block of each engine's generated `CLAUDE.md`.
 * Writing an absolute path into any of them publishes the operator's OS username
 * and the layout of their private work to everyone who clones that project.
 *
 * This lives here, rather than in either generator, because both write the same
 * data class and a per-generator copy is how the second call site gets missed:
 * the first fix sanitized the project-map renderer only, and the engine-config
 * renderer kept emitting raw paths. Sanitize at the shared render boundary and
 * every generator inherits it.
 *
 * `~` is already this codebase's display convention for machine-local paths (the
 * orchestration profiles' `keyRef: file:~/…`), and the readers that consume such
 * paths expand it back, so nothing loses resolvability on the machine that wrote
 * it.
 *
 * Only a prefix ending at a path boundary collapses: with `$HOME` of
 * `/Users/jane`, `/Users/jane-old/x` is left alone rather than becoming the
 * unresolvable `~-old/x`. An empty or `/` home never sanitizes — leaving the path
 * intact is the safe failure, since collapsing against `/` would rewrite every
 * absolute path on the system.
 *
 * **Scope: this is about PATHS, not names — do not generalize it.** A path
 * carries the operator's username incidentally, and `~` preserves everything the
 * reader needed, so sanitizing costs nothing. A *name* is different, and the two
 * generators land differently on purpose. The engine config keeps shared-doc and
 * group names (`lib/engines.js`): a doc is listed there only because its group
 * opted in per-doc via `injectIntoConfig`, and the name is the whole point — an
 * agent cannot use a doc it cannot refer to. `PROJECT-MAP.md` withholds them
 * (`lib/projects.js:_buildSharedDirsSection`): nothing opted in, membership is
 * per-install configuration rather than project structure, and the names there
 * were of *other* projects. The test is whether the name was deliberately
 * published and is load-bearing for the reader — not whether it is a name.
 *
 * @param {string} p - Path to display; may already be relative or `~`-prefixed.
 * @returns {string} `~/…` when `p` is under `$HOME`, otherwise `p` unchanged.
 */
function tildeHomePath(p) {
  if (typeof p !== 'string' || p === '') return p;
  const home = os.homedir() || process.env.HOME || '';
  if (!home || home === '/' || !p.startsWith(home)) return p;
  const rest = p.slice(home.length);
  if (rest === '') return '~';
  return rest.startsWith('/') ? `~${rest}` : p;
}

module.exports = {
  resolveWithinProject,
  isInsideProject,
  checkContainment,
  normalizeConfiguredPath,
  resolveConfiguredFile,
  tildeHomePath
};
