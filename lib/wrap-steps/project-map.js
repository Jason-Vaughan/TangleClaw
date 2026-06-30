'use strict';

/**
 * `project-map` wrap step (PIDX slice 3, #360, #356) — keeps the
 * auto-maintained sections of `<projectPath>/PROJECT-MAP.md` fresh on each
 * wrap: the **Structure** skeleton (current top-level directories) and the
 * **Shared directories / doc groups** snapshot (current shared-doc group
 * membership). Curated per-directory descriptions and any operator-added
 * sections are preserved verbatim — the refresh is section-scoped, not a
 * full regenerate (see `lib/projects.js:_refreshProjectMapContent`).
 *
 * **Contract (mirrors features-toc + ADR 0002 step-kind philosophy — never blocks):**
 *
 *   - Skip when there is no project path.
 *   - Skip when `projConfig.projectMapEnabled !== true` (the same per-project
 *     toggle the slice-1 prime pointer + seed gate on).
 *   - Skip when `PROJECT-MAP.md` is missing at the project root (toggle-on
 *     seeds it; absence means the operator never enabled the toggle or deleted
 *     the file deliberately).
 *   - Skip when the refreshed content is byte-identical to disk — the refresh
 *     is idempotent, so "no drift" produces an exact-equal string.
 *   - Otherwise stage `{primingPath, newContent, changed:true, mapRefresh:true,
 *     addedDirs, removedDirs}` under `staged['project-map:refresh']`.
 *     `lib/wrap-steps/commit.js:_flushStagedWrites` duck-types the
 *     `{primingPath, newContent, changed}` trio and writes the file during the
 *     commit step's single-transaction flush — never here. The commit body line
 *     is emitted from `_buildBodyLines` against `{mapRefresh, addedDirs, removedDirs}`.
 *
 * **Why no git (unlike features-toc).** features-toc keys off the branch diff
 * (`git diff <base>...HEAD`) because it indexes *files touched this session*.
 * The project map's freshness is structural: it reflects the live filesystem
 * (`_listTopLevelDirs`) and the live store (`_collectProjectGroups`), neither of
 * which is a branch-scoped notion — a directory added directly on disk should
 * surface even if no tracked file in it changed. So this step reads the world,
 * not the diff, and needs no base-branch resolution.
 *
 * @module lib/wrap-steps/project-map
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logger');
const store = require('../store');

const log = createLogger('wrap-step-project-map');

// `../projects` is required LAZILY inside `run()` rather than at module top.
// The wrap pipeline is reached via `projects → sessions → wrap-pipeline →
// wrap-steps/project-map`, so a top-level `require('../projects')` here closes
// a cycle and captures projects.js's *partial* exports (its `module.exports`
// is reassigned at the end of the file) — leaving `projects.PROJECT_MAP_FILENAME`
// et al. undefined. By call time (a live wrap) projects.js is fully evaluated,
// so the lazy require resolves the complete module. (`features-toc` sidesteps
// this by never requiring `../projects` at all.)

/**
 * Step handler. See module docstring for the full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (`{id, name, path}`)
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:boolean, status:string, output:object, blockers:string[]}>}
 */
async function run(context) {
  const projects = require('../projects'); // lazy — breaks the require cycle (see module head)
  const { project, staged } = context;
  if (!project || !project.path) {
    return _skipped('no project path');
  }

  let projConfig;
  try {
    projConfig = store.projectConfig.load(project.path);
  } catch (err) {
    return _skipped(`projectConfig.load threw: ${err.message}`);
  }
  if (!projConfig || projConfig.projectMapEnabled !== true) {
    return _skipped('projectMapEnabled is not true');
  }

  const mapPath = path.join(project.path, projects.PROJECT_MAP_FILENAME);
  if (!_internal.existsSync(mapPath)) {
    return _skipped(`${projects.PROJECT_MAP_FILENAME} not found at project root`);
  }

  let existing;
  try {
    existing = _internal.readFileSync(mapPath, 'utf8');
  } catch (err) {
    return _skipped(`${projects.PROJECT_MAP_FILENAME} unreadable: ${err.message}`);
  }

  const currentDirs = projects._listTopLevelDirs(project.path);
  // `project.id` is the DB id; the live wrap context always carries it, but
  // guard so a hand-built context (tests, future callers) degrades to a
  // structure-only refresh rather than throwing.
  const groups = project.id != null ? projects._collectProjectGroups(project.id) : [];
  const newContent = projects._refreshProjectMapContent(existing, currentDirs, groups);

  if (newContent === existing) {
    return _skipped(`no drift — ${projects.PROJECT_MAP_FILENAME} already current`);
  }

  const existingDirs = projects._parseStructureDirs(existing);
  const addedDirs = currentDirs.filter((d) => !existingDirs.includes(d));
  const removedDirs = existingDirs.filter((d) => !currentDirs.includes(d));

  staged['project-map:refresh'] = {
    primingPath: mapPath,
    newContent,
    changed: true,
    mapRefresh: true,
    addedDirs,
    removedDirs
  };

  log.info('project-map staged refresh', {
    project: project.name,
    addedDirs: addedDirs.length,
    removedDirs: removedDirs.length
  });

  return {
    ok: true,
    status: 'done',
    output: {
      mapPath,
      addedDirs,
      removedDirs,
      detail: `${projects.PROJECT_MAP_FILENAME} refreshed (+${addedDirs.length}/-${removedDirs.length} dir(s))`
    },
    blockers: []
  };
}

function _skipped(reason) {
  // Canonical skip signal is `status: 'skipped'` (#204); the drawer derives
  // skip detail from status + reason/detail.
  return {
    ok: true,
    status: 'skipped',
    output: { reason, detail: reason },
    blockers: []
  };
}

const _internal = {
  existsSync: fs.existsSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs)
};

module.exports = {
  run,
  _skipped,
  _internal
};
