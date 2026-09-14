'use strict';

/*
 * A wrap scope for tests that drive a wrap step directly, without the pipeline
 * that resolves one.
 *
 * The commit step stages only files the session changed (#1406). With no scope it
 * has no record of the session's start, so it treats every uncommitted file as
 * not the session's and asks the operator about it. A test that is about some
 * OTHER part of the commit (the message, the auto-branch, a killed command) hands
 * it this scope instead, which records a launch on a clean tree: every
 * uncommitted file is the session's own.
 */

const fs = require('node:fs');

/**
 * A scope recording a session that launched on a clean tree at `toplevel`.
 *
 * @param {string} toplevel - The repository's toplevel (resolved through symlinks).
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} A `lib/wrap-scope.js`-shaped scope.
 */
function cleanLaunchScope(toplevel, overrides = {}) {
  let real = toplevel;
  try {
    real = fs.realpathSync(toplevel);
  } catch {
    // A path that does not exist (a stubbed-git test) is used as given.
  }
  return {
    workTree: toplevel,
    configRoot: toplevel,
    worktreeTarget: false,
    paneCwd: null,
    workTreeReason: 'test fixture',
    workToplevel: real,
    baseline: { sha: null, toplevel: real, dirty: { paths: [], truncated: false } },
    snapshotApplies: true,
    startedAtMs: 0,
    lastWrapSha: null,
    lastWrapShaRead: 'absent',
    trunk: { onTrunk: false, branch: null, trunkRefs: [] },
    ...overrides
  };
}

module.exports = { cleanLaunchScope };
