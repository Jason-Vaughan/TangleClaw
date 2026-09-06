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
 * **Scope of that claim.** Every containment check in the repo now lands on the
 * one predicate below. Callers that mean something different say so with an
 * option rather than hand-rolling: the wrap pipeline's plan-pointer validation
 * counts the project root as inside (it is validating directories, not a target
 * file) and stays lexical, and both departures are named at its call sites. The
 * point is not that every caller wants the same answer — it is that a caller
 * wanting a different one must ask for it here, where the difference is visible.
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
 * Both options exist because a caller legitimately meant something else and
 * used to express it by writing its own check — which is how two predicates in
 * one codebase came to disagree about the root case without anyone deciding
 * they should. Asking here makes the difference reviewable.
 *
 * @param {string} projectRoot - Project root (need not be pre-resolved)
 * @param {string} absolutePath - Path to test (need not be pre-resolved)
 * @param {object} [options]
 * @param {boolean} [options.allowRoot=false] - Count the root itself as inside.
 *   For callers validating a DIRECTORY, where the root is a legitimate answer;
 *   off for callers naming a file, which the root can never be.
 * @param {boolean} [options.followSymlinks=true] - Also require containment
 *   after symlinks are resolved.
 * @returns {{inside:true}|{inside:false, reason:string}} `reason` is a sentence
 *   FRAGMENT ("resolves outside the project root") so callers can compose it
 *   after the field name they are validating — the operator reads
 *   "versionFilePath resolves outside the project root", not "versionFilePath
 *   path resolves outside…".
 */
function _containsPath(projectRoot, absolutePath, options = {}) {
  const allowRoot = options.allowRoot === true;
  const followSymlinks = options.followSymlinks !== false;

  const root = path.resolve(projectRoot);
  const resolved = path.resolve(absolutePath);
  const rel = path.relative(root, resolved);

  if (rel === '') {
    if (!allowRoot) {
      return { inside: false, reason: 'resolves to the project root itself, not a file inside it' };
    }
  } else if (rel.startsWith('..') || path.isAbsolute(rel)) {
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
  const realRel = path.relative(realRoot, realResolved);
  if (realRel === '') {
    return allowRoot
      ? { inside: true }
      : { inside: false, reason: 'resolves outside the project root once symlinks are followed' };
  }
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    return { inside: false, reason: 'resolves outside the project root once symlinks are followed' };
  }

  return { inside: true };
}

/**
 * Resolve a project-relative path, refusing anything that escapes the project
 * or (by default) names the root itself.
 *
 * @param {string} projectRoot - Absolute project root
 * @param {string} relativePath - Operator-supplied path, relative to the root
 * @param {object} [options] - Containment policy; see {@link _containsPath}.
 * @param {boolean} [options.allowRoot=false]
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
 * @param {boolean} [options.allowRoot=false]
 * @param {boolean} [options.followSymlinks=true]
 * @returns {boolean} True only when the path resolves inside the root under the
 *   requested policy.
 */
function isInsideProject(projectRoot, absolutePath, options = {}) {
  if (typeof projectRoot !== 'string' || typeof absolutePath !== 'string') return false;
  if (projectRoot.trim() === '' || absolutePath.trim() === '') return false;

  return _containsPath(projectRoot, absolutePath, options).inside;
}

/**
 * Maximum symlink hops followed while resolving a DANGLING link.
 *
 * `fs.realpathSync` enforces its own limit and reports `ELOOP`, but it refuses
 * a link whose target does not exist, so the dangling case is resolved by hand
 * below and needs its own bound. The value only has to exceed any legitimate
 * chain; a cycle is what it is really there to stop.
 *
 * Exhausting the budget falls back to the lexical path, which reports a deep
 * chain as INSIDE — fail-open, stated plainly rather than left to be discovered.
 * It is the right trade here because the bound is not what makes containment
 * safe: a one-hop link out of the project is caught, and anyone able to plant a
 * 32-deep chain could plant that instead. The bound exists so a cycle
 * terminates.
 */
const MAX_DANGLING_LINK_HOPS = 32;

/**
 * `fs.realpathSync` for a path that may not exist: resolve the deepest existing
 * ancestor and re-append the un-created tail, falling back to the lexical path
 * when nothing along it resolves.
 *
 * **Dangling symlinks are resolved by hand**, because `realpathSync` refuses
 * them and the walk-up would then discard the link entirely — reporting the
 * link's own location, inside the project, for a path that writes outside it.
 * `fs.writeFileSync` follows a dangling link and creates its target, so that is
 * a real escape and not a theoretical one.
 *
 * @param {string} target - Absolute path, which may not exist
 * @returns {string} Absolute, symlink-resolved where resolvable
 */
function _realpathOrSelf(target) {
  let current = path.resolve(target);
  const tail = [];
  for (let hops = 0; ; ) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {  // prawduct:allow prawduct/broad-except -- any failure to resolve (ENOENT, EACCES, loop) means try the dangling-link case, then walk up; the lexical fallback below is the floor
      // Not resolvable as a whole. If this component is itself a symlink, its
      // target is where a write would land — follow it rather than walking past.
      if (hops < MAX_DANGLING_LINK_HOPS) {
        let linkTarget = null;
        try {
          linkTarget = fs.readlinkSync(current);
        } catch {  // prawduct:allow prawduct/broad-except -- not a symlink, or unreadable; either way fall through to the walk-up
          linkTarget = null;
        }
        if (linkTarget !== null) {
          hops += 1;
          current = path.resolve(path.dirname(current), linkTarget);
          continue;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target); // hit the filesystem root
      tail.unshift(path.basename(current));
      current = parent;
    }
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
 * @param {object} [options] - Containment policy, passed through to
 *   {@link resolveWithinProject}.
 * @returns {{configured:false}
 *   |{configured:true, ok:true, raw:string, path:string}
 *   |{configured:true, ok:false, raw:string, reason:string}}
 */
function resolveConfiguredFile(projectRoot, projConfig, key, options = {}) {
  const raw = normalizeConfiguredPath(projConfig ? projConfig[key] : null);
  if (raw === null) return { configured: false };

  const contained = resolveWithinProject(projectRoot, raw, options);
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

module.exports = { resolveWithinProject, isInsideProject, normalizeConfiguredPath, resolveConfiguredFile, tildeHomePath };
