'use strict';

/**
 * Scoped `projectsDir` Default Inside a Scratch `TANGLECLAW_HOME` (#2604
 * Slice 1, v5.61.0 Car 61-C, Architect Ruling A2604).
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
 * **What counts as "scratch"**: `TANGLECLAW_HOME` resolves (via
 * `tangleclawHome.baseDir()`) to anything OTHER than the operator's
 * canonical `<home>/.tangleclaw` -- the Ruling's own framing. An operator
 * who explicitly sets `TANGLECLAW_HOME` to literally reproduce that
 * canonical path is not scratch; every other resolved base directory is.
 *
 * **Vetoable Slice 1 scoping assumption** (the Architect Ruling comment
 * truncates after this contract's first numbered item; this module's own
 * doc comment states the gap and how it was filled, the same discipline
 * already applied to a truncated ruling elsewhere -- #1350, #1370, #1677):
 * this module is pure and answers ONE question -- what should `projectsDir`
 * default to, given the resolved `TANGLECLAW_HOME` base directory and the
 * operator's real home. It does not read `TANGLECLAW_HOME` itself, does not
 * touch `lib/store.js`'s `DEFAULT_CONFIG` or its `load()` fallback, and does
 * not create the scoped directory on disk. Wiring a real caller (`store.js`'s
 * own default resolution) through it is a later slice, exactly as #1350 and
 * #1677 built their own primitives without touching their eventual callers.
 * The second, lower-severity gap #2604 also names (an unscoped tmux
 * session-status reconciliation sweep at boot) is out of this module
 * entirely -- a different mechanism, named here only so it is not mistaken
 * for solved by this one.
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
 * one, or a scratch/temporary override.
 * @param {string} tangleclawHomeBaseDir - As `tangleclawHome.baseDir()` returns it.
 * @param {string} userHome - As `tangleclawHome.userHome()` returns it.
 * @returns {boolean}
 */
function isScratchHome(tangleclawHomeBaseDir, userHome) {
  if (typeof tangleclawHomeBaseDir !== 'string' || !tangleclawHomeBaseDir) return false;
  if (typeof userHome !== 'string' || !userHome) return false;
  const canonical = path.resolve(path.join(userHome, '.tangleclaw'));
  return path.resolve(tangleclawHomeBaseDir) !== canonical;
}

/**
 * The `projectsDir` default a server should use, given its resolved
 * `TANGLECLAW_HOME` base directory and the operator's real home. A scratch
 * base directory scopes the default inside itself (`<TANGLECLAW_HOME>/projects`)
 * so a server started only with `TANGLECLAW_HOME` + a leased port can no
 * longer scaffold real projects under the operator's real `~/Projects` by
 * default. The canonical case is unchanged from today's behavior.
 * @param {string} tangleclawHomeBaseDir - As `tangleclawHome.baseDir()` returns it.
 * @param {string} userHome - As `tangleclawHome.userHome()` returns it.
 * @returns {{isScratch: boolean, defaultProjectsDir: string}}
 */
function resolveDefaultProjectsDir(tangleclawHomeBaseDir, userHome) {
  const scratch = isScratchHome(tangleclawHomeBaseDir, userHome);
  return {
    isScratch: scratch,
    defaultProjectsDir: scratch
      ? path.join(tangleclawHomeBaseDir, SCRATCH_PROJECTS_SUBDIR)
      : CANONICAL_PROJECTS_DIR_DEFAULT
  };
}

module.exports = {
  CANONICAL_PROJECTS_DIR_DEFAULT,
  isScratchHome,
  resolveDefaultProjectsDir
};
