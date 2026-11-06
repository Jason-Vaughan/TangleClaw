'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const tccFolders = require('./tcc-folders');

/**
 * Guided migration of the projects workspace root out from under a
 * macOS-TCC-protected folder (#2626) — `~/Documents/Projects` by default — to
 * an unprotected one, `~/Projects` by default. `DEFAULT_CONFIG.projectsDir`
 * in `lib/store.js` already points a BRAND NEW install at `~/Projects`
 * (#880/#2604); this module is for an EXISTING install still configured for
 * the older, protected default, which gets no read error and no prompt under
 * a launchd-spawned node with no Full Disk Access — the read simply never
 * answers (#859). `lib/tcc-folders.js` stays dependency-free (only
 * `node:path`) on purpose, so the filesystem/store/git planning and execution
 * this module needs lives here instead.
 *
 * Two halves, deliberately split: `planWorkspaceMigration` is pure and safe
 * to call freely (a dry run, never touching disk, the database, or config);
 * `executeWorkspaceMigration` is the only half that moves anything, and only
 * ever acts on a plan it is handed, never re-deriving one of its own.
 *
 * @module lib/tcc-workspace-migration
 */

/**
 * One project this plan would move, or the reason it would not.
 * @typedef {{id: number, name: string, fromPath: string, toPath: string}} WorkspaceMove
 * @typedef {{id: number, name: string, reason: string}} WorkspaceSkip
 */

/**
 * Dry-run plan: which projects under `sourceRoot` would move to `targetRoot`,
 * and why any would not. Never touches the filesystem, the database, or
 * config — `fsImpl.existsSync` is the only filesystem read, injectable so a
 * test never depends on the real disk.
 *
 * @param {object} opts
 * @param {string} opts.home - The operator's home directory.
 * @param {string} [opts.sourceRoot] - Defaults to `<home>/Documents/Projects`.
 * @param {string} [opts.targetRoot] - Defaults to `<home>/Projects`.
 * @param {{id: number, name: string, path: string}[]} [opts.projects] - Every
 *   known project (`store.projects.list()`'s own shape).
 * @param {{projectId: number}[]} [opts.activeSessions] - Every currently
 *   active session (`store.sessions.listActive()`'s own shape) — a project
 *   with one is a blocker, never silently skipped.
 * @param {{projectsDir?: string}} [opts.config] - The current global config
 *   (`store.config.load()`'s own shape), to decide whether `config.json`
 *   itself needs updating.
 * @param {{existsSync: Function}} [opts.fsImpl] - Injected `fs` (tests).
 * @returns {{ok: boolean, dryRun: true, sourceRoot: string, targetRoot: string,
 *   moves: WorkspaceMove[], skipped: WorkspaceSkip[], blockers: WorkspaceSkip[],
 *   configUpdate: ({fromProjectsDir: string, toProjectsDir: string}|null),
 *   error?: string}}
 */
function planWorkspaceMigration({
  home, sourceRoot, targetRoot, projects, activeSessions, config, fsImpl
} = {}) {
  const fsx = fsImpl || fs;
  const resolvedSource = sourceRoot || path.join(home, 'Documents', 'Projects');
  const resolvedTarget = targetRoot || path.join(home, 'Projects');
  const emptyPlan = { sourceRoot: resolvedSource, targetRoot: resolvedTarget, moves: [], skipped: [], blockers: [], configUpdate: null };

  if (!tccFolders.projectPathIsProtected(resolvedSource, home)) {
    return { ok: false, dryRun: true, ...emptyPlan, error: `${resolvedSource} is not a TCC-protected folder under ${home} — nothing to migrate away from` };
  }
  if (tccFolders.projectPathIsProtected(resolvedTarget, home)) {
    return { ok: false, dryRun: true, ...emptyPlan, error: `${resolvedTarget} is itself TCC-protected under ${home} — refusing to migrate into another protected folder` };
  }

  const activeProjectIds = new Set((activeSessions || []).map((s) => s.projectId));
  const moves = [];
  const skipped = [];
  const blockers = [];
  const seenTargets = new Set();

  for (const project of projects || []) {
    const projPath = project.path;
    const underSource = projPath === resolvedSource || (typeof projPath === 'string' && projPath.startsWith(resolvedSource + path.sep));
    if (!projPath || !underSource) continue;

    const rel = path.relative(resolvedSource, projPath);
    const toPath = path.join(resolvedTarget, rel);

    if (activeProjectIds.has(project.id)) {
      blockers.push({ id: project.id, name: project.name, reason: 'has an active session — stop or end it before migrating' });
      continue;
    }
    if (!fsx.existsSync(projPath)) {
      skipped.push({ id: project.id, name: project.name, reason: `source path does not exist on disk: ${projPath}` });
      continue;
    }
    if (fsx.existsSync(toPath) || seenTargets.has(toPath)) {
      blockers.push({ id: project.id, name: project.name, reason: `target path already exists or collides with another move: ${toPath}` });
      continue;
    }
    seenTargets.add(toPath);
    moves.push({ id: project.id, name: project.name, fromPath: projPath, toPath });
  }

  const configUpdate = (config && config.projectsDir === resolvedSource)
    ? { fromProjectsDir: resolvedSource, toProjectsDir: resolvedTarget }
    : null;

  return { ok: true, dryRun: true, sourceRoot: resolvedSource, targetRoot: resolvedTarget, moves, skipped, blockers, configUpdate };
}

/**
 * Whether a project directory is itself a linked git worktree, or the main
 * checkout of one or more linked worktrees — either way, `git worktree
 * repair` needs to run there after the directory moves, since a worktree's
 * administrative files (on both sides of the link) store absolute paths that
 * a plain `fs.renameSync` cannot update (#2626).
 * @param {string} projectPath - The project's (new) path.
 * @param {{existsSync: Function, readdirSync: Function, statSync: Function}} fsx - `fs` or an injected stand-in.
 * @returns {boolean}
 */
function _hasWorktreeLink(projectPath, fsx) {
  const gitPath = path.join(projectPath, '.git');
  if (!fsx.existsSync(gitPath)) return false;
  let st;
  try {
    st = fsx.statSync(gitPath);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return true; // a FILE .git means this IS a linked worktree
  try {
    const worktreesDir = path.join(gitPath, 'worktrees');
    return fsx.existsSync(worktreesDir) && fsx.readdirSync(worktreesDir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Revert one already-migrated (or half-migrated) move: the directory back to
 * `fromPath` if it is at `toPath` and `fromPath` is clear, and the store's
 * record back to `fromPath` regardless — best-effort on the store half, so
 * one already-gone row never blocks reverting the rest.
 * @param {WorkspaceMove} move - The move to revert.
 * @param {object} storeApi - `store` (or an isolated instance) — only `.projects.update` is used.
 * @param {{existsSync: Function, renameSync: Function}} fsx - `fs` or an injected stand-in.
 * @returns {void}
 */
function _revertOneMove(move, storeApi, fsx) {
  try {
    if (fsx.existsSync(move.toPath) && !fsx.existsSync(move.fromPath)) {
      fsx.renameSync(move.toPath, move.fromPath);
    }
  } catch {
    // Best-effort: surfaced to the operator via the outer refusal already;
    // a failed revert here must not mask the ORIGINAL failure by throwing.
  }
  try {
    storeApi.projects.update(move.id, { path: move.fromPath });
  } catch {
    // Same reasoning — the store row may already be gone or unreachable.
  }
}

/**
 * Execute a plan `planWorkspaceMigration` already produced: move each
 * project directory, update its `store.projects` row, update `config.json`
 * if the plan calls for it, and repair any git worktree links the moves
 * disturbed. Any failure at any step rolls the WHOLE attempt back — every
 * directory already moved goes back to `fromPath`, every store row back to
 * its original path — rather than leaving a partial migration in place.
 *
 * Never re-validates or re-derives the plan; a stale or tampered plan is the
 * caller's mistake to avoid, not this function's to detect twice.
 *
 * @param {ReturnType<typeof planWorkspaceMigration>} plan - A plan this
 *   function trusts as given.
 * @param {object} opts
 * @param {object} [opts.store] - `store` (or an isolated instance for tests)
 *   — only `.projects.update` is used.
 * @param {string} [opts.configPath] - Absolute path to `config.json`, read
 *   and rewritten only when `plan.configUpdate` is set.
 * @param {object} [opts.fsImpl] - Injected `fs` (tests): `existsSync`,
 *   `mkdirSync`, `renameSync`, `readFileSync`, `writeFileSync`, `statSync`,
 *   `readdirSync`.
 * @param {Function} [opts.execFileSyncImpl] - Injected `execFileSync` (tests).
 * @returns {{ok: true, migrated: WorkspaceMove[], configUpdated: boolean,
 *   worktreesRepaired: number[]}|{ok: false, error: string, rolledBack: boolean}}
 */
function executeWorkspaceMigration(plan, { store: storeApi, configPath, fsImpl, execFileSyncImpl } = {}) {
  if (!plan || !plan.ok || (plan.blockers && plan.blockers.length > 0)) {
    return {
      ok: false,
      error: !plan
        ? 'No plan was given.'
        : (!plan.ok ? (plan.error || 'The plan itself is not ok.') : 'The plan still carries unresolved blockers.'),
      rolledBack: false
    };
  }
  const fsx = fsImpl || fs;
  const exec = execFileSyncImpl || execFileSync;
  const migrated = [];
  let inProgress = null;
  let configUpdated = false;
  const worktreesRepaired = [];

  try {
    for (const move of plan.moves) {
      inProgress = move;
      fsx.mkdirSync(path.dirname(move.toPath), { recursive: true });
      fsx.renameSync(move.fromPath, move.toPath);
      storeApi.projects.update(move.id, { path: move.toPath });
      migrated.push(move);
      inProgress = null;
    }

    if (plan.configUpdate) {
      const raw = fsx.readFileSync(configPath, 'utf8');
      const cfg = JSON.parse(raw);
      cfg.projectsDir = plan.configUpdate.toProjectsDir;
      fsx.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
      configUpdated = true;
    }

    for (const move of migrated) {
      if (_hasWorktreeLink(move.toPath, fsx)) {
        exec('git', ['-C', move.toPath, 'worktree', 'repair'], { encoding: 'utf8' });
        worktreesRepaired.push(move.id);
      }
    }

    return { ok: true, migrated, configUpdated, worktreesRepaired };
  } catch (err) {
    for (const move of migrated.slice().reverse()) _revertOneMove(move, storeApi, fsx);
    if (inProgress) _revertOneMove(inProgress, storeApi, fsx);
    return { ok: false, error: err.message, rolledBack: true };
  }
}

module.exports = { planWorkspaceMigration, executeWorkspaceMigration };
