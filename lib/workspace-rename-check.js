'use strict';

/**
 * Workspace Rename Orphaned Engine State Detector & Warning (#1370 Slice 1,
 * v5.61.0 Car 61-D, Architect Ruling A1370).
 *
 * TangleClaw is engine-neutral: a workspace is just a directory, and renaming
 * or moving it is an ordinary filesystem operation TangleClaw itself never
 * blocks. The problem is that most AI engines key their OWN session state by
 * the workspace's ABSOLUTE PATH, not by any project identity TangleClaw
 * tracks -- so a rename that TangleClaw sees as harmless silently orphans
 * that engine's memory, and the next session in the renamed directory boots
 * with total amnesia (#1370's own words).
 *
 * **Verified, not guessed, engine mechanics** (read from the real,
 * already-shipped adapters in `lib/transcript.js` before writing this
 * module, per this project's own "verify a claim before building on it"
 * discipline):
 * - **Claude Code**: `~/.claude/projects/<path with every `/` and `.`
 *   replaced by `-`>/<session-uuid>.jsonl` (`lib/transcript.js#_encodeDir`,
 *   reused here rather than re-derived). A rename changes the encoded
 *   directory NAME itself, so the old directory becomes unreachable at the
 *   OS level the instant the workspace is renamed -- the engine state does
 *   not move with it.
 * - **Codex**: a flat `~/.codex/sessions/**\/*.jsonl` tree; each rollout
 *   records its OWN `cwd` as content on its first line
 *   (`lib/transcript.js#_codexResolve`), never as a directory name. A
 *   rename does not move or rename any Codex file -- it orphans a rollout
 *   by making its recorded `cwd` stale, so no later lookup by the NEW path
 *   will ever find it again.
 *
 * **Deliberately out of Slice 1** (documented here rather than guessed at):
 * live tmux pane cwd and git worktree pointers, both named in the issue's
 * own sketch. Neither has an existing, verified read path in this codebase
 * (`lib/tmux.js` has no pane-cwd listing today), and inventing one for a
 * narrow Slice 1 risks reporting a false orphan risk. A later slice that
 * adds a verified reader for either should extend {@link detectOrphanedEngineState}
 * -- the `affectedEngines` shape already has room for more entries.
 * Gemini is a documented stub for the same reason: no verified path-keying
 * mechanism for it exists in this codebase yet (`lib/transcript.js`'s own
 * `UNSUPPORTED_HARNESSES` treats it the same way).
 *
 * @module lib/workspace-rename-check
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const transcript = require('./transcript');
const { shellWord } = require('./shell-word');

/** Engines this module can actually detect orphaned state for, today. */
const SUPPORTED_ENGINES = Object.freeze(['claude', 'codex']);

/** Injectable seams so tests never touch the real `~/.claude`/`~/.codex`. */
const _internal = {
  claudeHome: () => path.join(os.homedir(), '.claude'),
  codexHome: () => path.join(os.homedir(), '.codex')
};

/**
 * Every `.jsonl` file directly inside `dir`, or `[]` when `dir` does not
 * exist or is not a directory. Never throws.
 * @param {string} dir
 * @returns {string[]} Absolute file paths.
 */
function _jsonlFilesIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => path.join(dir, e.name));
}

/**
 * Every `.jsonl` file under `root`, recursively, bounded to a sane depth so
 * a pathological home directory cannot make this walk unbounded. Never
 * throws; a directory this process cannot read is silently skipped.
 * @param {string} root
 * @param {number} [maxDepth]
 * @returns {string[]}
 */
function _walkJsonlFiles(root, maxDepth = 6) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

/**
 * Read a rollout/transcript file's own recorded `cwd`, from whichever of its
 * first few JSONL lines carries one. Bounded read (first 64 KiB); never
 * throws.
 * @param {string} file
 * @returns {string|null}
 */
function _recordedCwd(file) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString('utf8', 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const cwd = parsed && (parsed.cwd || (parsed.payload && parsed.payload.cwd));
      if (typeof cwd === 'string' && cwd) return cwd;
    } catch {
      // Not a parseable line (truncated mid-write, or not JSON this early) -- try the next.
    }
  }
  return null;
}

/**
 * Claude Code's own transcript state for exactly `workspacePath`, if any.
 * @param {string} workspacePath
 * @param {object} [options]
 * @param {string} [options.claudeHome]
 * @returns {{engine: 'claude', path: string, fileCount: number}|null}
 */
function _claudeStateFor(workspacePath, options = {}) {
  const home = options.claudeHome || _internal.claudeHome();
  const dir = path.join(home, 'projects', transcript._encodeDir(workspacePath));
  const files = _jsonlFilesIn(dir);
  return files.length > 0 ? { engine: 'claude', path: dir, fileCount: files.length } : null;
}

/**
 * Codex's own rollout files whose RECORDED `cwd` equals exactly
 * `workspacePath`, if any. Unlike Claude, these files are not themselves
 * misplaced by a rename -- they are orphaned in the sense that nothing will
 * ever look them up again under the new path.
 * @param {string} workspacePath
 * @param {object} [options]
 * @param {string} [options.codexHome]
 * @returns {{engine: 'codex', path: string, fileCount: number}|null}
 */
function _codexStateFor(workspacePath, options = {}) {
  const home = options.codexHome || _internal.codexHome();
  const root = path.join(home, 'sessions');
  const matches = _walkJsonlFiles(root).filter((f) => _recordedCwd(f) === workspacePath);
  return matches.length > 0 ? { engine: 'codex', path: root, fileCount: matches.length } : null;
}

/**
 * The manual terminal command(s) that migrate one engine's state from
 * `fromPath` to `toPath`. Claude's is a real, safe `mv` of its encoded
 * directory; Codex's rollouts cannot be usefully "moved" (nothing reads
 * them by directory name), so its step says so and points at the content
 * fix instead -- never a command that would silently do nothing.
 * @param {{engine: string, path: string}} state
 * @param {string} fromPath
 * @param {string} toPath
 * @param {object} [options]
 * @param {string} [options.claudeHome]
 * @returns {string}
 */
function _migrationStepFor(state, fromPath, toPath, options = {}) {
  if (state.engine === 'claude') {
    const home = options.claudeHome || _internal.claudeHome();
    const target = path.join(home, 'projects', transcript._encodeDir(toPath));
    // Naive double-quoting breaks (and can inject commands) on a path
    // containing a `"`, `$`, backtick or backslash -- all legal in a macOS
    // directory name. `shellWord` is this repo's one total escape
    // (lib/shell-word.js); reuse it rather than re-deriving one (I-Gate R1).
    return `mv ${shellWord(state.path)} ${shellWord(target)}`;
  }
  return `Codex rollout state at ${state.path} is keyed by its own recorded cwd ("${fromPath}"), `
    + 'not a directory name -- it cannot be relocated by moving a file. It stays readable under the OLD path; '
    + 'a Codex session started fresh in the renamed workspace begins new, unlinked history.';
}

/**
 * Inventory every SUPPORTED engine's own state keyed by exactly
 * `workspacePath` -- what WOULD be left behind (Claude) or made unfindable
 * (Codex) if this exact path were renamed or moved.
 * @param {string} workspacePath - Absolute path.
 * @param {object} [options]
 * @param {string} [options.claudeHome] - Override for tests.
 * @param {string} [options.codexHome] - Override for tests.
 * @returns {{hasOrphanRisk: boolean, affectedEngines: string[], orphanedPaths: Array<{engine: string, path: string, fileCount: number}>}}
 */
function detectOrphanedEngineState(workspacePath, options = {}) {
  if (typeof workspacePath !== 'string' || !workspacePath || !path.isAbsolute(workspacePath)) {
    return { hasOrphanRisk: false, affectedEngines: [], orphanedPaths: [] };
  }
  const found = [_claudeStateFor(workspacePath, options), _codexStateFor(workspacePath, options)].filter(Boolean);
  return {
    hasOrphanRisk: found.length > 0,
    affectedEngines: found.map((f) => f.engine),
    orphanedPaths: found
  };
}

/**
 * The full pre-rename impact report: what {@link detectOrphanedEngineState}
 * finds for the CURRENT (pre-rename) path, plus the manual migration step
 * for each affected engine, naming the planned NEW path. Call this before
 * executing a rename; a caller that gets `hasOrphanRisk: true` back is
 * expected to warn loudly and require explicit confirmation before
 * proceeding (the issue's own "At Rename Time" requirement) -- this
 * function itself never blocks or performs the rename.
 * @param {string} oldPath - The workspace's current absolute path.
 * @param {string} newPath - The absolute path it would become.
 * @param {object} [options]
 * @param {string} [options.claudeHome] - Override for tests.
 * @param {string} [options.codexHome] - Override for tests.
 * @returns {{hasOrphanRisk: boolean, affectedEngines: string[], orphanedPaths: Array<{engine: string, path: string, fileCount: number}>, migrationSteps: string[]}}
 */
function inspectWorkspaceRenameImpact(oldPath, newPath, options = {}) {
  const detected = detectOrphanedEngineState(oldPath, options);
  const migrationSteps = detected.orphanedPaths.map((state) => _migrationStepFor(state, oldPath, newPath, options));
  return { ...detected, migrationSteps };
}

/**
 * The loud, human-readable warning for a rename `inspectWorkspaceRenameImpact`
 * found orphan risk for -- the issue's own "At Rename Time" requirement.
 * Pure text; callers decide where it is shown (CLI prompt, dashboard modal).
 * @param {{hasOrphanRisk: boolean, affectedEngines: string[], migrationSteps: string[]}} impact
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {string|null} `null` when there is nothing to warn about.
 */
function renameWarningFor(impact, oldPath, newPath) {
  if (!impact || !impact.hasOrphanRisk) return null;
  const engines = impact.affectedEngines.join(', ');
  const steps = impact.migrationSteps.map((s) => `  ${s}`).join('\n');
  return `WARNING: renaming "${oldPath}" to "${newPath}" will orphan ${engines} engine state keyed by the old path.\n`
    + 'TangleClaw does not migrate engine state itself (it stays engine-neutral); run this manually if you want to keep it:\n'
    + `${steps}\n`;
}

/**
 * The "At Session Start" check (#1370's own requirement): whether a nearly
 * empty workspace sits beside an "orphaned sibling" -- a directory with the
 * SAME parent whose own engine state looks substantial, as if this
 * workspace were recently renamed from it.
 *
 * **A vetoable heuristic, named here explicitly** (Ruling A1370's own
 * comment does not specify one): a sibling counts as the likely origin
 * only when (a) `workspacePath` itself has NO engine state of its own yet
 * (a genuinely fresh or just-renamed-into workspace) and (b) exactly ONE
 * candidate -- a same-parent sibling directory, OR an explicitly-named prior
 * path (`previousWorkspacePaths`, when the caller actually knows its own
 * rename history rather than making this module guess at it) -- has state
 * for ITS OWN path and is no longer a project TangleClaw's caller still
 * tracks under its own name (`stillTrackedNames`; applied to sibling names
 * only -- an explicitly-named previous path is never filtered by it, since
 * the caller already knows it is the one being renamed FROM). More than one
 * candidate total is reported as ambiguous (`sibling: null`, `candidates`
 * lists every one) rather than guessed at -- the same fail-closed-on-
 * ambiguity discipline `lib/transcript.js#_codexResolve` already applies to
 * a structurally identical problem.
 * @param {string} workspacePath - The newly booted workspace's absolute path.
 * @param {string[]} [stillTrackedNames] - Directory names (not full paths) of every
 *   OTHER project this install still tracks under its own name -- a sibling matching
 *   one of these is still in active use, never reported as an orphan's origin.
 * @param {object} [options]
 * @param {string} [options.claudeHome] - Override for tests.
 * @param {string} [options.codexHome] - Override for tests.
 * @param {string[]} [options.previousWorkspacePaths] - Absolute paths this exact
 *   workspace is known (by the caller's own record, e.g. a launch/rename history)
 *   to have previously lived at -- checked directly, never guessed at by directory
 *   listing, and never filtered by `stillTrackedNames` (#1370 A1370 addendum).
 * @returns {{hasOrphanedSibling: boolean, sibling: string|null, candidates: string[], impact: object|null}}
 */
function findOrphanedSibling(workspacePath, stillTrackedNames = [], options = {}) {
  const own = detectOrphanedEngineState(workspacePath, options);
  if (own.hasOrphanRisk) return { hasOrphanedSibling: false, sibling: null, candidates: [], impact: null };

  const parent = path.dirname(workspacePath);
  const ownName = path.basename(workspacePath);
  const tracked = new Set(stillTrackedNames);
  let siblingNames = [];
  try {
    siblingNames = fs.readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== ownName && !tracked.has(e.name))
      .map((e) => e.name);
  } catch {
    siblingNames = [];
  }

  const candidateSet = new Set();
  for (const name of siblingNames) {
    const siblingPath = path.join(parent, name);
    if (detectOrphanedEngineState(siblingPath, options).hasOrphanRisk) candidateSet.add(siblingPath);
  }
  for (const previousPath of Array.isArray(options.previousWorkspacePaths) ? options.previousWorkspacePaths : []) {
    if (typeof previousPath === 'string' && previousPath && previousPath !== workspacePath
      && detectOrphanedEngineState(previousPath, options).hasOrphanRisk) candidateSet.add(previousPath);
  }
  const candidates = [...candidateSet];

  if (candidates.length !== 1) return { hasOrphanedSibling: false, sibling: null, candidates, impact: null };
  const impact = detectOrphanedEngineState(candidates[0], options);
  return { hasOrphanedSibling: true, sibling: candidates[0], candidates, impact };
}

/**
 * The Rename-Time Guard (#1370, A1370 addendum §1.3): the bounded decision a
 * caller enforces BEFORE actually renaming a workspace on disk.
 * `inspectWorkspaceRenameImpact` and `renameWarningFor` only ever REPORT risk
 * and text; neither blocks anything, so a caller that skipped inspection
 * and went straight to its own rename call would silently drop the "warn and
 * require confirmation" half of the Slice 1 contract. This function is the
 * one place that turns the report into a decision: refuse when there is
 * orphan risk and no explicit confirmation, allow otherwise.
 *
 * **I-Gate Round 2 (#2863, review `5756902464`)**: an earlier version took a
 * caller-supplied `impact` and trusted it outright -- a caller that omitted
 * inspection (passing `null`) or passed a report for an unrelated workspace
 * got `allowed: true` with no confirmation check at all, exactly the "warn
 * and require confirmation" guarantee this function exists to enforce.
 * Fixed by removing the parameter: this function now ALWAYS computes its
 * own authoritative impact via {@link inspectWorkspaceRenameImpact} for the
 * exact `oldPath`/`newPath` given, so there is no caller-reachable path that
 * skips inspection or binds it to the wrong workspace.
 * @param {string} oldPath - The workspace's current absolute path.
 * @param {string} newPath - The absolute path it would become.
 * @param {object} [options]
 * @param {boolean} [options.confirmOrphanRisk] - Explicit operator confirmation to
 *   proceed despite known orphan risk. Never defaulted to `true` implicitly.
 * @param {string} [options.claudeHome] - Override for tests, forwarded to the inspection.
 * @param {string} [options.codexHome] - Override for tests, forwarded to the inspection.
 * @returns {{allowed: boolean, requiresConfirmation: boolean, warning: string|null}}
 */
function decideWorkspaceRename(oldPath, newPath, options = {}) {
  const impact = inspectWorkspaceRenameImpact(oldPath, newPath, options);
  if (!impact.hasOrphanRisk) {
    return { allowed: true, requiresConfirmation: false, warning: null };
  }
  const warning = renameWarningFor(impact, oldPath, newPath);
  if (options.confirmOrphanRisk === true) {
    return { allowed: true, requiresConfirmation: true, warning };
  }
  return { allowed: false, requiresConfirmation: true, warning };
}

/**
 * The "At Session Start" briefing line (#1370's own requirement): the
 * human-readable warning for a workspace {@link findOrphanedSibling} found a
 * single likely origin for.
 * @param {{hasOrphanedSibling: boolean, sibling: string|null, impact: object|null}} found
 * @param {string} workspacePath
 * @returns {string|null} `null` when there is nothing to warn about.
 */
function orphanedSiblingWarningFor(found, workspacePath) {
  if (!found || !found.hasOrphanedSibling || !found.sibling) return null;
  const engines = found.impact ? found.impact.affectedEngines.join(', ') : '';
  return `NOTE: "${workspacePath}" looks newly set up, and a sibling directory ("${found.sibling}") still holds `
    + `${engines} engine state -- if this workspace was renamed from it, that history was left behind. `
    + 'TangleClaw does not migrate it automatically; see `tc workspace-rename-check` for the manual steps.';
}

module.exports = {
  SUPPORTED_ENGINES,
  detectOrphanedEngineState,
  inspectWorkspaceRenameImpact,
  renameWarningFor,
  decideWorkspaceRename,
  findOrphanedSibling,
  orphanedSiblingWarningFor
};
