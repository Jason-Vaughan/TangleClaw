'use strict';

/**
 * Scoped `projectsDir` Default Inside a Scratch `TANGLECLAW_HOME` (#2604
 * Slice 1, v5.61.0 Car 61-C, Architect Ruling A2604 + its Completion
 * Addendum, `#issuecomment-6611205754`).
 *
 * The Builder Role Overlay (`LANE_QUEUE.md` Rule #271.3) requires an
 * isolated scratch server for UI-change browser verification:
 * `TANGLECLAW_HOME` pointed at a temp dir, a leased port. `TANGLECLAW_HOME`
 * already scopes the server's own sqlite db, certs, and git templates
 * (`lib/tangleclaw-home.js#baseDir`). It does NOT scope `config.projectsDir`
 * -- `lib/store.js`'s `DEFAULT_CONFIG.projectsDir` is the fixed string
 * `'~/Projects'` regardless of `TANGLECLAW_HOME`, so `POST /api/projects` on
 * a "scratch" server still scaffolds real directories under the operator's
 * real, shared `~/Projects` -- the exact gap #2604 reports, caught live
 * during W1-A browser verification (#2122/#2123/#2124).
 *
 * **What counts as "scratch"**: `tangleclawHome` resolves to anything OTHER
 * than the operator's canonical `<osHomedir>/.tangleclaw` -- the Ruling's
 * own framing. An operator who explicitly sets it to literally reproduce
 * that canonical path is not scratch; every other resolved base directory
 * is.
 *
 * **Two call shapes, by design.** The completion addendum prescribes a
 * richer object-input contract (`isScratchTangleclawHome({tangleclawHome,
 * osHomedir})`, `resolveDefaultProjectsDir({configuredProjectsDir,
 * tangleclawHome, osHomedir})`); the original Slice 1 build (before the
 * addendum landed) shipped narrower positional-argument ones
 * (`isScratchHome(tangleclawHomeBaseDir, userHome)`,
 * `resolveDefaultProjectsDir(tangleclawHomeBaseDir, userHome)`), already
 * covered by their own tests. Both stay callable, under the SAME exported
 * names, detected by argument shape -- an object with the addendum's own
 * keys dispatches to the new contract, two plain string arguments dispatch
 * to the original one.
 *
 * **Vetoable interpretive choice**: the canonical (non-scratch) default is
 * returned as the tilde-relative string `'~/Projects'`, not an
 * already-expanded `path.join(osHomedir, 'Projects')`. The addendum's own
 * `Done-When` example writes it as `~/Projects` too, and `lib/store.js`'s
 * real, verified `DEFAULT_CONFIG.projectsDir` already stores exactly that
 * tilde string (expanded later by `lib/projects.js#resolveProjectsDir`) --
 * returning the already-expanded form here would describe a DIFFERENT
 * shape than what this repository's own config actually stores for every
 * install not running scratch.
 *
 * **Scoping notes carried over from the original build**: this module is
 * pure -- it does not read `TANGLECLAW_HOME`/`os.homedir()` itself, does
 * not touch `lib/store.js`'s `DEFAULT_CONFIG` or its `load()` fallback, and
 * does not create the scoped directory on disk. Wiring a real caller
 * (`lib/projects.js#resolveProjectsDir`, `lib/store.js`) through it is
 * explicitly a later slice (the addendum's own "Slice 2 Follow-Up",
 * Milestone #51). The second, lower-severity gap #2604 also names (an
 * unscoped tmux session-status reconciliation sweep at boot) is out of this
 * module entirely -- a different mechanism, named here only so it is not
 * mistaken for solved by this one.
 *
 * @module lib/scratch-home-defaults
 */

const path = require('node:path');

/**
 * The relative subdirectory a scratch `TANGLECLAW_HOME` scopes its default
 * `projectsDir` to.
 * @type {string}
 */
const SCRATCH_PROJECTS_SUBDIR = 'projects';

/**
 * The canonical, non-scratch `projectsDir` default, in the same tilde-relative
 * shape `lib/store.js`'s own `DEFAULT_CONFIG.projectsDir` already ships
 * (expanded later by `lib/projects.js#resolveProjectsDir`). Returned verbatim,
 * never re-derived, so the two stay the same string by construction rather
 * than by two authors agreeing.
 * @type {string}
 */
const CANONICAL_PROJECTS_DIR_DEFAULT = '~/Projects';

/**
 * Whether a resolved TangleClaw base directory is the operator's canonical
 * one, or a scratch/temporary override. The original (pre-addendum)
 * positional contract, kept verbatim for its existing callers/tests.
 * @param {string} tangleclawHomeBaseDir
 * @param {string} userHome
 * @returns {boolean}
 */
function isScratchHome(tangleclawHomeBaseDir, userHome) {
  if (typeof tangleclawHomeBaseDir !== 'string' || !tangleclawHomeBaseDir) return false;
  if (typeof userHome !== 'string' || !userHome) return false;
  const canonical = path.resolve(path.join(userHome, '.tangleclaw'));
  return path.resolve(tangleclawHomeBaseDir) !== canonical;
}

/**
 * The addendum-prescribed contract (`#issuecomment-6611205754`): the same
 * question `isScratchHome` answers, as an object-input call.
 * @param {object} [params]
 * @param {string} [params.tangleclawHome] - As `tangleclawHome.baseDir()` returns it.
 * @param {string} [params.osHomedir] - As `os.homedir()`/`tangleclawHome.userHome()` returns it.
 * @returns {boolean}
 */
function isScratchTangleclawHome({ tangleclawHome, osHomedir } = {}) {
  return isScratchHome(tangleclawHome, osHomedir);
}

/**
 * The original (pre-addendum) positional contract, kept verbatim for its
 * existing callers/tests.
 * @param {string} tangleclawHomeBaseDir
 * @param {string} userHome
 * @returns {{isScratch: boolean, defaultProjectsDir: string}}
 */
function _resolveDefaultProjectsDirV1(tangleclawHomeBaseDir, userHome) {
  const scratch = isScratchHome(tangleclawHomeBaseDir, userHome);
  return {
    isScratch: scratch,
    defaultProjectsDir: scratch
      ? path.join(tangleclawHomeBaseDir, SCRATCH_PROJECTS_SUBDIR)
      : CANONICAL_PROJECTS_DIR_DEFAULT
  };
}

/**
 * The addendum-prescribed contract (`#issuecomment-6611205754`): additionally
 * honors an explicit operator override for `projectsDir`, so a caller's
 * actual configured value is never silently replaced by a scratch-scoped or
 * canonical default.
 * @param {object} [params]
 * @param {string} [params.configuredProjectsDir] - The config's own `projectsDir`,
 *   as already loaded by the caller (`undefined`/the stock default both read
 *   as "not actually customized").
 * @param {string} [params.tangleclawHome]
 * @param {string} [params.osHomedir]
 * @returns {{isScratch: boolean, defaultProjectsDir: string}}
 */
function _resolveDefaultProjectsDirV2({ configuredProjectsDir, tangleclawHome, osHomedir } = {}) {
  const scratch = isScratchTangleclawHome({ tangleclawHome, osHomedir });
  const hasCustomOverride = typeof configuredProjectsDir === 'string'
    && configuredProjectsDir.trim() !== ''
    && configuredProjectsDir !== CANONICAL_PROJECTS_DIR_DEFAULT;
  if (hasCustomOverride) {
    return { isScratch: scratch, defaultProjectsDir: configuredProjectsDir };
  }
  return {
    isScratch: scratch,
    defaultProjectsDir: scratch
      ? path.join(tangleclawHome, SCRATCH_PROJECTS_SUBDIR)
      : CANONICAL_PROJECTS_DIR_DEFAULT
  };
}

/**
 * The `projectsDir` default a server should use. Accepts either call shape
 * (see the module doc comment); dispatches on whether the first argument is
 * a single object carrying the addendum's own keys, or two plain strings.
 * @param {...*} args
 * @returns {{isScratch: boolean, defaultProjectsDir: string}}
 */
function resolveDefaultProjectsDir(...args) {
  const [first, second] = args;
  if (first && typeof first === 'object'
    && ('configuredProjectsDir' in first || 'tangleclawHome' in first || 'osHomedir' in first)) {
    return _resolveDefaultProjectsDirV2(first);
  }
  return _resolveDefaultProjectsDirV1(first, second);
}

module.exports = {
  CANONICAL_PROJECTS_DIR_DEFAULT,
  isScratchHome,
  isScratchTangleclawHome,
  resolveDefaultProjectsDir
};
