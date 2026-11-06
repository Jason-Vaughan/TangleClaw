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
 * Expand a leading `~` against `home`, the same way `lib/projects.js#
 * resolveProjectsDir` does — `config.projectsDir` (from `store.config.load()`)
 * carries the legacy default in exactly this tilde form (#2626 I-Gate Round
 * 1 C1-a), and comparing it against an absolute `sourceRoot` without
 * expanding it first never matches. Deliberately its own copy rather than
 * importing `resolveProjectsDir`: that function reads the global
 * `tangleclaw-home` module, while this one must expand against the SAME
 * `home` the caller already passed in (test-injectable, and the one
 * `planWorkspaceMigration`'s own sourceRoot/targetRoot defaults use).
 * @param {string} dir - A config-style path, tilde-relative or absolute.
 * @param {string} home - The home directory to expand `~` against.
 * @returns {string}
 */
function _expandHome(dir, home) {
  if (typeof dir !== 'string' || !dir.startsWith('~')) return dir;
  return path.join(home, dir.slice(1));
}

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

  // I-Gate Round 1 C1-a: `config.projectsDir` (from `store.config.load()`)
  // names the legacy default in its TILDE form (`lib/store.js`'s
  // LEGACY_PROJECTS_DIR, '~/Documents/Projects') — including for a keyless
  // or blank legacy config, which `load()` already resolves to that same
  // string — while `resolvedSource` here is always absolute. Comparing them
  // raw left `configUpdate` null for every real legacy install.
  const configUpdate = (config && _expandHome(config.projectsDir, home) === resolvedSource)
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
 * its original path, `config.json` back to its original bytes, and any
 * worktree already repaired gets a compensating `git worktree repair` back
 * at `fromPath` — rather than leaving a partial migration in place.
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
  // I-Gate Round 1 C1-b: the config write happens BEFORE worktree repair, so
  // a repair failure must still be able to put it back — snapshot the exact
  // original bytes (never a re-serialized copy) before writing, and restore
  // them verbatim in the catch block whenever the write actually happened.
  let originalConfigRaw = null;
  const worktreesRepaired = [];
  // I-Gate Round 2 C1: track each move whose `git worktree repair` actually
  // SUCCEEDED (not just attempted) — a later move's repair can still throw,
  // and the rollback then needs to know which earlier repairs must be
  // compensated back, not just which directories must be.
  const repairedWorktrees = [];

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
      originalConfigRaw = fsx.readFileSync(configPath, 'utf8');
      const cfg = JSON.parse(originalConfigRaw);
      cfg.projectsDir = plan.configUpdate.toProjectsDir;
      fsx.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
      configUpdated = true;
    }

    for (const move of migrated) {
      if (_hasWorktreeLink(move.toPath, fsx)) {
        exec('git', ['-C', move.toPath, 'worktree', 'repair'], { encoding: 'utf8' });
        worktreesRepaired.push(move.id);
        repairedWorktrees.push(move);
      }
    }

    return { ok: true, migrated, configUpdated, worktreesRepaired };
  } catch (err) {
    for (const move of migrated.slice().reverse()) _revertOneMove(move, storeApi, fsx);
    if (inProgress) _revertOneMove(inProgress, storeApi, fsx);
    // I-Gate Round 2 C1: a worktree whose repair already succeeded, before a
    // LATER worktree's repair threw, has the main repository's own
    // `.git/worktrees/<name>/gitdir` record pointing at the now-reverted-away
    // `toPath`. The directory move-back above does not fix that record —
    // only `git worktree repair` does — so compensate by re-running it at
    // the just-restored `fromPath` for each worktree repair that actually
    // succeeded, in reverse order, best-effort: the same reasoning as
    // `_revertOneMove` applies, a failed compensating repair here must not
    // mask the ORIGINAL failure by throwing in its place.
    for (const move of repairedWorktrees.slice().reverse()) {
      try {
        exec('git', ['-C', move.fromPath, 'worktree', 'repair'], { encoding: 'utf8' });
      } catch {
        // Best-effort.
      }
    }
    if (configUpdated && originalConfigRaw !== null) {
      try {
        fsx.writeFileSync(configPath, originalConfigRaw);
      } catch {
        // Best-effort, same reasoning as _revertOneMove: the ORIGINAL
        // failure is what gets surfaced; a failed restore here must not
        // mask it by throwing in its place.
      }
    }
    return { ok: false, error: err.message, rolledBack: true };
  }
}

module.exports = { planWorkspaceMigration, executeWorkspaceMigration };
