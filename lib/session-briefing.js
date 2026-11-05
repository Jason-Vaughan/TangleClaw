'use strict';

/**
 * Session-start briefing assembly (#2864, #1370 follow-up).
 *
 * `lib/workspace-rename-check.js#findOrphanedSibling`/`#orphanedSiblingWarningFor`
 * (#1370 Slice 1) are the "At Session Start" check the issue itself names --
 * built, tested, and called by nothing in production. This module is that
 * caller: one function that reads the install's own tracked project names,
 * runs the sibling check for a given workspace, and returns the briefing
 * line (or `null`) ready for whatever actually assembles a session's start
 * text to include.
 *
 * Wiring this INTO the real briefing text itself is a later slice --
 * wherever that assembly genuinely lives (`lib/tc-verbs.js` and/or the
 * launch-sequence rendering path) is not in this car's envelope. This
 * module is self-contained and callable today, by a test or an in-process
 * tool, without that wiring existing yet -- the same split #2830/#2837/
 * #2838/#2836/#2844 each used for their own primitives.
 *
 * @module lib/session-briefing
 */

const path = require('node:path');
const store = require('./store');
const workspaceRenameCheck = require('./workspace-rename-check');

/**
 * Every OTHER project this install still tracks, by directory name --
 * exactly the shape `findOrphanedSibling`'s own `stillTrackedNames`
 * parameter wants (a sibling matching one of these is in active use, never
 * reported as an orphan's origin).
 * @param {string} workspacePath - Excluded from the result (it is the workspace being checked, not a sibling of itself)
 * @returns {string[]}
 */
function _trackedSiblingNames(workspacePath) {
  return store.projects.list({ archived: false })
    .filter((p) => p.path && path.resolve(p.path) !== path.resolve(workspacePath))
    .map((p) => path.basename(p.path));
}

/**
 * The "At Session Start" briefing line for a newly-booted workspace: whether
 * it looks like it was recently renamed from a same-parent sibling that
 * still holds the old path's engine state. `null` when there is nothing to
 * warn about -- the common case, and the only answer for a workspace that
 * already has its own engine state (not "newly set up").
 * @param {string} workspacePath - The booting session's absolute workspace path
 * @param {object} [options] - Forwarded to `findOrphanedSibling` verbatim (`claudeHome`/`codexHome`/`previousWorkspacePaths` overrides)
 * @returns {string|null}
 */
function orphanedSiblingBriefingLine(workspacePath, options = {}) {
  const found = workspaceRenameCheck.findOrphanedSibling(workspacePath, _trackedSiblingNames(workspacePath), options);
  return workspaceRenameCheck.orphanedSiblingWarningFor(found, workspacePath);
}

module.exports = { orphanedSiblingBriefingLine, _trackedSiblingNames };
