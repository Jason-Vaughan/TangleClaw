'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const git = require('./git');
const engines = require('./engines');
const gitHooks = require('./git-hooks');
const gitTemplate = require('./git-template');
const projectPaths = require('./project-paths');
const wrapStepOverrides = require('./wrap-step-overrides');
const wrapDefaultPipeline = require('./wrap-default-pipeline');
const actions = require('./actions');
const tmux = require('./tmux');
const sessions = require('./sessions');
const sessionOwnership = require('./session-ownership');
const continuity = require('./continuity');
const dirScanner = require('./dir-scanner');
const { readProjectFacts } = require('./project-facts');
const { DEFAULT_PROJECT_CONFIG } = require('./project-config');
const { createLogger } = require('./logger');

const log = createLogger('projects');

// How long a projects-directory read may take before this server stops waiting.
// Not a performance budget — a local readdir is sub-millisecond. It exists because
// a TCC-protected path on macOS does not fail, it never returns, and a request
// that hangs forever is indistinguishable to the operator from a dead server.
// Generous enough that a slow network mount still succeeds.
const PROJECT_SCAN_TIMEOUT_MS = 5000;

// How much earlier a WALK gives up than the request that raced it. The two
// bounds are not redundant: the race can only answer the request, while the walk
// can stop itself and hand back what it found. Give them the same instant and
// the race wins the tie — the caller gets "this path did not respond" for a
// directory that was responding, just slowly, and the partial results the walk
// had already gathered are thrown away. The inner bound therefore fires first,
// leaving the race as what it is for: the backstop for a call that never returns
// at all, where there is nothing to hand back and nobody to hand it to.
const PROJECT_SCAN_WALK_MARGIN_MS = 250;

// What the CHILD is actually given, derived once so the two request sites and the
// log that reports it cannot disagree. They already did: the truncation warning
// printed the full 5000 while the walk had been handed 4750, so an operator
// reading the log was told a budget nothing was ever measured against.
const PROJECT_WALK_BUDGET_MS = PROJECT_SCAN_TIMEOUT_MS - PROJECT_SCAN_WALK_MARGIN_MS;

const PROJECT_NAME_REGEX = /^[a-zA-Z0-9 _-]+$/;

// ── Password Hashing ──

/**
 * Hash a password using scrypt with a random salt.
 * @param {string} password - Plaintext password
 * @returns {string} - Format: salt:hash (both hex-encoded)
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a stored hash.
 * @param {string} password - Plaintext password to verify
 * @param {string} stored - Stored hash in salt:hash format
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
}

/**
 * Check the delete password. Returns true if allowed (no password set, or password matches).
 * @param {string|undefined} providedPassword - Password from request body
 * @returns {{ allowed: boolean, error: string|null }}
 */
function checkDeletePassword(providedPassword) {
  const config = store.config.load();
  if (!config.deletePassword) {
    return { allowed: true, error: null };
  }
  if (!providedPassword) {
    return { allowed: false, error: 'Password required for this operation' };
  }
  // Support both hashed and plain text passwords (migration path)
  if (config.deletePassword.includes(':')) {
    // Hashed format
    if (verifyPassword(providedPassword, config.deletePassword)) {
      return { allowed: true, error: null };
    }
  } else {
    // Legacy plaintext — verify then upgrade to hash
    if (providedPassword === config.deletePassword) {
      // Upgrade to hashed format
      config.deletePassword = hashPassword(providedPassword);
      store.config.save(config);
      log.info('Upgraded deletePassword to hashed format');
      return { allowed: true, error: null };
    }
  }
  log.warn('Delete password verification failed');
  return { allowed: false, error: 'Incorrect password' };
}

// ── Feature Index (#207) ──

const FEATURE_INDEX_FILENAME = 'FEATURES.md';

const FEATURE_INDEX_TEMPLATE = `# Feature Index

<!--
Maintained automatically: the wrap-step handler appends
stubs when PRs touch new files. Fill in descriptions before
next wrap.

Format: - **Name** — short description. \`file.js\` plus stable anchors:
\`file.js#symbolName\` for a function/const, or a literal route string
for server routes. NO :line pointers — nothing re-verifies them, so
they rot.
-->

## UI / Web

## Server / API

## Governance / Engines

## CLI / Tooling
`;

/**
 * Seed a FEATURES.md template at the project root if one does not already
 * exist. Idempotent — never overwrites an existing file (preserves any
 * hand-authored content). Called from `updateProject` whenever
 * `featureIndexEnabled` is set to true.
 *
 * Non-throwing: a failed write is logged and swallowed. A missing file is
 * benign for the rest of the system (Chunk 2 injection treats absence as
 * "skip"; Chunk 3 wrap-step treats absence as "skip").
 *
 * @param {string} projectPath - Absolute path to the project directory
 * @returns {boolean} true if a file was created, false if pre-existing or failed
 */
function _seedFeatureIndexFile(projectPath) {
  try {
    const filePath = path.join(projectPath, FEATURE_INDEX_FILENAME);
    if (fs.existsSync(filePath)) {
      return false;
    }
    fs.writeFileSync(filePath, FEATURE_INDEX_TEMPLATE);
    log.info('Seeded FEATURES.md from template', { projectPath });
    return true;
  } catch (err) {
    log.warn('Failed to seed FEATURES.md', { projectPath, error: err.message });
    return false;
  }
}

// ── Project Map (PIDX #360, #356) ──

const PROJECT_MAP_FILENAME = 'PROJECT-MAP.md';

// Top-level directory names that are never useful in a "where things live" map.
// Mirrors the features-toc EXCLUDED_PREFIXES set; leading-dot directories are
// filtered separately (hidden content).
const PROJECT_MAP_EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', 'coverage', 'build', '.git'
]);

const PROJECT_MAP_HEADER = `# Project Map

<!--
A "where things live" map: the structural table-of-contents the agent consults
FIRST before grepping or filesystem search. The top-level-directory skeleton is
auto-generated (seeded on toggle-on, refreshed by the project-map wrap-step);
fill in the descriptions. Distinct from FEATURES.md (#207), which maps features
to file paths — this maps the layout itself.
-->
`;

// The two auto-maintained section headings. The seed writer + the slice-3
// freshness wrap-step both key off these exact strings, so they live as
// constants (one source of truth — a heading rename can't desync the two).
const PROJECT_MAP_STRUCTURE_HEADING = '## Structure';
const PROJECT_MAP_SHARED_HEADING = '## Shared directories / doc groups';

// Matches a Structure-section directory bullet, e.g.
// "- `lib/` — <!-- describe -->". Captures the directory name (no slash).
// The em-dash (U+2014) separates the path from its curated description; the
// whole line is preserved verbatim on refresh so descriptions survive.
const PROJECT_MAP_DIR_LINE_RE = /^- `(.+?)\/`\s+—/;

// Placeholder body emitted when a project has no indexable top-level dirs.
const PROJECT_MAP_NO_DIRS_PLACEHOLDER = '<!-- no top-level directories detected -->';

/**
 * List the project's top-level directories worth putting in the map, sorted.
 * Excludes vendored/build dirs and any hidden (leading-dot) directory.
 *
 * Non-throwing: an unreadable project root yields an empty list (the caller
 * still seeds a valid file with an empty skeleton).
 *
 * @param {string} projectPath - Absolute path to the project directory
 * @returns {string[]} Sorted top-level directory names (no trailing slash)
 */
function _listTopLevelDirs(projectPath) {
  let entries;
  try {
    entries = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch (err) {
    log.warn('Failed to read project root for PROJECT-MAP skeleton', { projectPath, error: err.message });
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith('.') && !PROJECT_MAP_EXCLUDED_DIRS.has(name))
    .sort();
}

/**
 * Build the full PROJECT-MAP.md seed content: header + an auto-generated
 * top-level-directory skeleton (each dir a describe-stub) + a placeholder
 * Shared-directories section (populated by slice 2 / the wrap-step).
 *
 * @param {string} projectPath - Absolute path to the project directory
 * @returns {string}
 */
function _buildProjectMapContent(projectPath, groups = []) {
  const dirs = _listTopLevelDirs(projectPath);
  const structureLines = dirs.length > 0
    ? dirs.map((d) => `- \`${d}/\` — <!-- describe -->`).join('\n')
    : PROJECT_MAP_NO_DIRS_PLACEHOLDER;
  return `${PROJECT_MAP_HEADER}
${PROJECT_MAP_STRUCTURE_HEADING}

${structureLines}

${PROJECT_MAP_SHARED_HEADING}

${_buildSharedDirsSection(groups)}
`;
}


/**
 * Render the "Shared directories / doc groups" section body — a pointer, plus a
 * non-identifying count. Pure; takes the already-collected `groups` shape.
 *
 * **This deliberately publishes no names and no paths.** `PROJECT-MAP.md` is a
 * tracked file that managed projects commit and routinely push to public
 * remotes, but shared-doc group membership is *this install's* configuration:
 * two clones of the same project on different machines legitimately disagree
 * about it. Rendering it wrote the operator's other project names — and, before
 * the paths were made `~`-relative, their home directory — into a public repo,
 * and re-wrote them on every wrap, so hand-scrubbing the file never held.
 *
 * The count is real data and still comes from the live store, which is what ADR
 * 0007 records this step as reading; only the identifying detail is withheld.
 * The operator reads the actual membership in the TangleClaw UI, where it is
 * per-install state rather than committed content.
 *
 * This is the opposite call from `engines._buildSharedDocsSection`, which DOES
 * name shared docs — those opted in per-doc via `injectIntoConfig` and are
 * unusable without their names. The distinction is written out at `tildeHomePath`
 * in `lib/project-paths.js`; do not generalize either one without reading it.
 *
 * @param {Array<{name:string, sharedDir:string|null, docs:Array<{name:string}>}>} groups
 * @returns {string} Markdown for the section body — never any group name or path.
 */
function _buildSharedDirsSection(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return '<!-- This project is not a member of any shared-doc group. -->';
  }
  const n = groups.length;
  return `_This project belongs to ${n} shared-doc group${n === 1 ? '' : 's'}. `
    + 'Membership is machine-local state, not project structure, so it is not '
    + 'published here — see the TangleClaw UI for this install\'s groups._';
}

/**
 * Collect a project's shared-doc group membership into the shape
 * `_buildSharedDirsSection` consumes: each group's name, absolute sharedDir, and
 * registered docs. Non-throwing — a store error yields `[]` (the map still seeds
 * with the "not a member" note).
 *
 * @param {number} projectId - Project id
 * @param {object} [deps] - Injected for testability
 * @param {object} [deps.store] - Store module (defaults to this module's store)
 * @returns {Array<{name:string, sharedDir:string|null, docs:Array<{name:string}>}>}
 */
function _collectProjectGroups(projectId, deps = {}) {
  const st = deps.store || store;
  try {
    const groups = st.projectGroups.getByProject(projectId) || [];
    return groups.map((g) => ({
      name: g.name,
      sharedDir: g.sharedDir || null,
      docs: (st.sharedDocs.getByGroup(g.id) || []).map((d) => ({ name: d.name }))
    }));
  } catch (err) {
    log.warn('Failed to collect shared-doc groups for PROJECT-MAP', { projectId, error: err.message });
    return [];
  }
}

/**
 * Seed a PROJECT-MAP.md at the project root if one does not already exist.
 * Idempotent — never overwrites an existing file (preserves curated content).
 * Called from `updateProject` whenever `projectMapEnabled` is set to true.
 *
 * Non-throwing: a failed write is logged and swallowed. A missing file is benign
 * (the prime pointer treats absence as "skip"; the wrap-step treats it as "skip").
 *
 * @param {string} projectPath - Absolute path to the project directory
 * @param {Array<{name:string, sharedDir:string|null, docs:Array<{name:string}>}>} [groups] - Shared-doc group membership (PIDX slice 2)
 * @returns {boolean} true if a file was created, false if pre-existing or failed
 */
function _seedProjectMapFile(projectPath, groups = []) {
  try {
    const filePath = path.join(projectPath, PROJECT_MAP_FILENAME);
    if (fs.existsSync(filePath)) {
      return false;
    }
    fs.writeFileSync(filePath, _buildProjectMapContent(projectPath, groups));
    log.info('Seeded PROJECT-MAP.md from template', { projectPath });
    return true;
  } catch (err) {
    log.warn('Failed to seed PROJECT-MAP.md', { projectPath, error: err.message });
    return false;
  }
}

// ── Project Map freshness (PIDX slice 3, #360, #356) ──
//
// The slice-3 wrap-step (`lib/wrap-steps/project-map.js`) keeps the two
// auto-maintained sections current on every wrap. Refresh is section-scoped,
// not a full regenerate: only the bodies of `## Structure` and
// `## Shared directories / doc groups` are rewritten — the header comment,
// curated per-directory descriptions, and any operator-added sections survive
// verbatim. The merge is byte-exact-idempotent (refreshing already-fresh
// content returns it unchanged), which is what lets the wrap-step use a plain
// `newContent === existing` equality as its drift signal.

/**
 * Parse the directory names currently listed in the `## Structure` section.
 * Used by the wrap-step to compute added/removed dirs for the audit body line.
 * Returns `[]` when the section is absent.
 *
 * @param {string} content - Full PROJECT-MAP.md content
 * @returns {string[]} Directory names (no trailing slash), in file order
 */
function _parseStructureDirs(content) {
  const lines = String(content || '').split('\n');
  const start = lines.findIndex((l) => l.trim() === PROJECT_MAP_STRUCTURE_HEADING);
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    const m = lines[i].match(PROJECT_MAP_DIR_LINE_RE);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Replace the body of a `## ` section (everything after the heading up to the
 * next `## ` heading or EOF) with `newBody`, preserving the heading, the
 * canonical blank-line padding, and ALL content outside the section. Returns
 * the content unchanged when the heading is absent — an operator who deleted
 * the section owns that choice; the refresh never re-adds it.
 *
 * @param {string} content
 * @param {string} heading - Exact heading text, e.g. '## Structure'
 * @param {string} newBody - Replacement body (no surrounding blank lines)
 * @returns {string}
 */
function _replaceSectionBody(content, heading, newBody) {
  const lines = String(content || '').split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return content;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  const before = lines.slice(0, start + 1);
  const after = lines.slice(end);
  return [...before, '', ...newBody.split('\n'), '', ...after].join('\n');
}

/**
 * Build a refreshed `## Structure` body from the live directory list,
 * preserving curated descriptions on surviving directories (each one's
 * existing bullet line is kept verbatim), adding `<!-- describe -->` stubs for
 * new directories, and dropping bullets for directories that no longer exist.
 * Output order follows `currentDirs` (sorted by the caller) — matching the seed.
 *
 * Only recognized dir-bullet lines carry across. Free-form prose inside the
 * Structure section is intentionally NOT preserved — a one-line description
 * belongs on the dir bullet (the seed format), and longer notes belong in an
 * operator-owned section (which the section-scoped refresh leaves untouched).
 *
 * @param {string} existingContent - The full current PROJECT-MAP.md
 * @param {string[]} currentDirs - Live top-level dir names (no slash), sorted
 * @returns {string}
 */
function _mergeStructureBody(existingContent, currentDirs) {
  const lines = String(existingContent || '').split('\n');
  const start = lines.findIndex((l) => l.trim() === PROJECT_MAP_STRUCTURE_HEADING);
  const existingByDir = {};
  if (start !== -1) {
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) break;
      const m = lines[i].match(PROJECT_MAP_DIR_LINE_RE);
      if (m) existingByDir[m[1]] = lines[i];
    }
  }
  if (!Array.isArray(currentDirs) || currentDirs.length === 0) {
    return PROJECT_MAP_NO_DIRS_PLACEHOLDER;
  }
  return currentDirs
    .map((d) => existingByDir[d] || `- \`${d}/\` — <!-- describe -->`)
    .join('\n');
}

/**
 * Refresh a PROJECT-MAP.md's auto-maintained sections against live project
 * state: the Structure skeleton (`currentDirs`, curated descriptions preserved)
 * and the Shared-directories snapshot (`groups`). Everything else — the header
 * and any operator-added sections — is preserved verbatim. Pure: no filesystem
 * or store access (the caller supplies dirs + groups). Idempotent: refreshing
 * already-fresh content returns it byte-for-byte (the wrap-step's drift signal).
 *
 * @param {string} existingContent - Current PROJECT-MAP.md content
 * @param {string[]} currentDirs - From `_listTopLevelDirs`
 * @param {Array<{name:string, sharedDir:string|null, docs:Array<{name:string}>}>} [groups] - From `_collectProjectGroups`
 * @returns {string} Refreshed content
 */
function _refreshProjectMapContent(existingContent, currentDirs, groups = []) {
  // Merge against the ORIGINAL content (reads curated descriptions) BEFORE the
  // structure splice replaces them; the two sections are disjoint so the
  // shared-section splice can chain off the result.
  const structureBody = _mergeStructureBody(existingContent, currentDirs);
  let content = _replaceSectionBody(existingContent, PROJECT_MAP_STRUCTURE_HEADING, structureBody);
  content = _replaceSectionBody(content, PROJECT_MAP_SHARED_HEADING, _buildSharedDirsSection(groups));
  return content;
}

// ── Validation ──

/**
 * Validate a project name.
 * @param {string} name - Project name to validate
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Project name is required' };
  }
  if (name.length > 64) {
    return { valid: false, error: 'Project name must be 64 characters or fewer' };
  }
  if (!PROJECT_NAME_REGEX.test(name)) {
    return { valid: false, error: 'Project name may only contain letters, numbers, spaces, hyphens, and underscores' };
  }
  return { valid: true, error: null };
}

// ── Project Creation ──

/**
 * Create a new project: validate → create directory → scaffold →
 * register ports → generate engine config → persist to SQLite.
 * @param {object} data - Project creation data
 * @param {string} data.name - Project directory name
 * @param {string} [data.engine] - Engine profile id
 * @param {string[]} [data.tags] - Tags
 * @param {boolean} [data.gitInit] - Initialize git repo (default true)
 * @returns {{ project: object, errors: string[] }}
 */
function createProject(data) {
  const errors = [];

  // Validate name
  const nameCheck = validateName(data.name);
  if (!nameCheck.valid) {
    return { project: null, errors: [nameCheck.error] };
  }

  // Check for duplicate. Case-insensitive so a request for `Foo-1` is
  // rejected when `foo-1` already exists (#221, sibling to #188). Error
  // message reflects the existing project's actual casing so the operator
  // sees exactly what conflicts. Case-insensitive filesystems would catch
  // this at the `fs.existsSync` line below anyway, but rejecting earlier
  // gives a cleaner error and protects case-sensitive filesystems too.
  const existing = store.projects.getByNameCaseInsensitive(data.name);
  if (existing) {
    const msg = existing.name === data.name
      ? `Project "${data.name}" already exists`
      : `Project "${existing.name}" already exists (case-insensitive match for "${data.name}")`;
    return { project: null, errors: [msg] };
  }

  // Resolve project path
  const config = store.config.load();
  const projectsDir = resolveProjectsDir(config.projectsDir);
  const projectPath = path.join(projectsDir, data.name);

  // Check if directory already exists
  if (fs.existsSync(projectPath)) {
    return { project: null, errors: [`Directory "${data.name}" already exists in ${projectsDir}`] };
  }

  // Validate engine exists. Resolve the default against what is installed, so a
  // new project doesn't get tagged with an engine that isn't on the machine while
  // an installed one sits unused (the failure would otherwise surface at first
  // launch, far from its cause).
  //
  // With NOTHING installed there is no better answer, and creating a project is
  // bookkeeping — it does not run an engine — so this records the configured
  // intent rather than refusing. Launch-time detection is what reports the truth.
  const engineId = data.engine
    || engines.resolveDefaultEngine(config)
    || (config && config.defaultEngine)
    || store.DEFAULT_CONFIG.defaultEngine;
  const engineProfile = store.engines.get(engineId);
  if (!engineProfile) {
    return { project: null, errors: [`Engine "${engineId}" not found`] };
  }

  // Create directory
  try {
    fs.mkdirSync(projectPath, { recursive: true });
  } catch (err) {
    return { project: null, errors: [`Failed to create directory: ${err.message}`] };
  }

  // Git init
  if (data.gitInit !== false) {
    try {
      require('node:child_process').execSync('git init', {
        cwd: projectPath,
        timeout: 5000,
        stdio: 'pipe'
      });
    } catch (err) {
      errors.push(`Git init failed: ${err.message}`);
    }
  }

  // Scaffold CHANGELOG.md if not present
  const changelogPath = path.join(projectPath, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    try {
      fs.writeFileSync(changelogPath, `# Changelog\n\nAll notable changes to ${data.name} are documented in this file.\n\n## [Unreleased]\n`);
    } catch (err) {
      errors.push(`Failed to create CHANGELOG.md: ${err.message}`);
    }
  }

  // Write per-project config
  const projectConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
  projectConfig.engine = engineId;
  if (data.tags) projectConfig.tags = data.tags;
  if (data.defaultLaunchMode) projectConfig.defaultLaunchMode = data.defaultLaunchMode;
  if (data.silentPrime !== undefined) projectConfig.silentPrime = data.silentPrime;

  store.projectConfig.save(projectPath, projectConfig);

  // Create session memory directory and seed file
  try {
    const memoriesDir = path.join(projectPath, '.tangleclaw', 'memories');
    fs.mkdirSync(memoriesDir, { recursive: true });
    const memoryFile = path.join(memoriesDir, 'MEMORY.md');
    if (!fs.existsSync(memoryFile)) {
      fs.writeFileSync(memoryFile, '# Session Memory\n\nThis file persists context across AI sessions. Update it with key decisions, progress, and open questions.\n');
    }
  } catch (err) {
    errors.push(`Failed to create session memory directory: ${err.message}`);
  }

  // Generate + write engine config via the #240 drift-aware helper.
  // The helper logs a warning if the existing on-disk file differs
  // from what we're about to write (surfaces silent-clobber bugs).
  // For createProject the project directory is fresh, so drift should
  // never fire here — but we route through the helper for uniformity
  // with the other three write sites and so a future caller that
  // writes into an existing directory automatically benefits.
  //
  // `skipped: true` is a deliberate no-op (engine has no config file —
  // openclaw). Only surface real `error` strings.
  const writeResult = engines.writeEngineConfig(engineId, projectPath, projectConfig, engineProfile);
  if (writeResult.error && !writeResult.written && !writeResult.skipped) {
    errors.push(`Failed to write engine config: ${writeResult.error}`);
  }

  // Engine passed explicitly — the DB row is inserted below, after this call,
  // so a DB-first resolution inside syncEngineHooks would find nothing yet.
  try {
    engines.syncEngineHooks(projectPath, engineId);
  } catch (err) {
    log.warn('Failed to sync engine hooks during project creation', { error: err.message });
  }

  // #247 — install commit-msg git hook based on global config. Default ON.
  try {
    gitHooks.syncGitHooks(projectPath, store.config.load());
  } catch (err) {
    log.warn('Failed to sync git hooks during project creation', { error: err.message });
  }

  // Persist to SQLite
  const project = store.projects.create({
    name: data.name,
    path: projectPath,
    engine: engineId,
    tags: data.tags || [],
    ports: {}
  });

  log.info('Project created', { name: data.name, path: projectPath, engine: engineId });
  return { project, errors };
}

// ── Project Version Detection (#55) ──

/**
 * The version readers, the live-detection ladder and the cache writer all live
 * in `lib/project-version-files.js` now, and are re-exported from this module
 * under their original names so existing callers and tests keep addressing them
 * here.
 *
 * THEY MOVED BECAUSE A THIRD PROCESS NEEDED THEM. Reading a registered project's
 * version means reading files at a path the operator chose, and on macOS a
 * TCC-protected directory does not fail that read — it never answers it, on this
 * process's event loop, for the life of the process (#884). The scanner child
 * performs the read instead, so `enrichProject` below takes the answer from the
 * child's reply rather than going to disk itself. A module the child requires may
 * not reach the database, which rules out this one; and the readers previously
 * sat on a `projects.js` ↔ `project-version.js` require cycle that a third
 * consumer could not join. Extracting them dissolved the cycle.
 */
const {
  readVersionCacheFile: _readVersionCacheFile,
  readChangelogVersion: _readChangelogVersion,
  readVersionJsonVersion: _readVersionJsonVersion,
  readPackageJsonVersion: _readPackageJsonVersion,
  detectLiveVersion: _detectLiveVersion,
  writeVersionCacheFile: _writeVersionCacheFile,
  detectProjectVersion: _detectProjectVersion
} = require('./project-version-files');

// ── Project Enrichment ──

/**
 * The session payload for a pane tmux confirmed is there.
 *
 * `incomplete` and `cause` are present on the healthy object too, empty and
 * null. A field that appears only on failure makes every consumer probe for its
 * existence instead of reading its value — the same rule `unreadable` follows a
 * few lines below.
 *
 * @param {object} row - Session row from the store.
 * @param {string} status - Status to report (`row.status`, or `'wrapping'`).
 * @returns {{active: true, status: string, startedAt: string, tmuxSession: string,
 *   incomplete: string[], cause: null}}
 */
function _liveSession(row, status) {
  return {
    active: true,
    status,
    startedAt: row.startedAt,
    tmuxSession: row.tmuxSession,
    incomplete: [],
    cause: null
  };
}

/**
 * The session payload for a pane whose liveness could not be established.
 *
 * `active: null` rather than `false`: the read did not happen, so there is no
 * negative to report. Falsy, so every consumer that tests `session.active`
 * behaves as it did before this state existed; distinguishable, so a consumer
 * that wants to say "unknown" can.
 *
 * @param {object} row - Session row from the store.
 * @param {string} status - Status to report (`row.status`, or `'wrapping'`).
 * @param {string|null} cause - Why the read established nothing, e.g. `read-timed-out`.
 * @returns {{active: null, status: string, startedAt: string, tmuxSession: string,
 *   incomplete: string[], cause: string|null}}
 */
function _unknownSession(row, status, cause) {
  return {
    active: null,
    status,
    startedAt: row.startedAt,
    tmuxSession: row.tmuxSession,
    incomplete: ['active'],
    cause: cause || null
  };
}

/**
 * Enrich a project record with git info, session status, and engine info.
 *
 * Facts about the project's OWN directory come from `readProjectFacts`
 * (`lib/project-facts.js`), which reads them in a child process a deadline can
 * kill — reading them on this process's event loop is what let one unreadable
 * folder stop the server answering anything (#884). That is why this function is
 * async. Existence, governance, git, config and version all arrive that way; this
 * function opens nothing under `project.path`.
 *
 * NOTHING HERE SPAWNS A SUBPROCESS SYNCHRONOUSLY, which is worth stating because
 * the two calls that used to both looked harmless. `tmux.hasSession` and
 * `engines.detectEngine` each ran on this thread once PER PROJECT, with their own
 * 5s and 2s caps, on the route the dashboard polls every ten seconds — so a
 * fleet's honest worst case was its project count times those caps, for two
 * questions whose answers are properties of the MACHINE and identical for every
 * project asking. Neither reads an operator-chosen directory, so neither belonged
 * in the scanner child; what they needed was to be asked once instead of N times.
 * Session liveness now comes from one shared `tmux list-sessions` snapshot, and
 * engine availability from the cache in `lib/engines.js`, both awaited.
 *
 * One synchronous filesystem call survives, and only for a profile using the
 * `path` detection strategy: `fs.existsSync` on the path that profile configures
 * (`lib/engines.js` `_detectPath`, which explains why making it async would move
 * the hazard rather than remove it). No shipped engine profile uses that
 * strategy — all four detect with `command -v`.
 *
 * `facts` is an optional injection for the ONE caller that has already gathered
 * them: `listProjects` reads its projects' facts one at a time, so a list costs
 * the sum of those reads rather than the slowest of them — see that function for
 * why sequential is a correctness requirement here. That caller is also the only
 * one that reads on the POLLED scanner; an omitted
 * `facts` means an operator-pressed path, which reads interactively so a person
 * who just fixed a permission is not answered from the backoff. It is
 * deliberately NOT defaulted to a plausible-looking value — an omitted argument
 * makes this function do the read itself, so a call site that forgets is slower,
 * never silently wrong. An earlier draft defaulted it to the shape a missing
 * directory produces, and eight call sites then reported every project as
 * governance-less with nothing failing; the tests caught it, but only because
 * they asserted on governance rather than on shape.
 *
 * @param {object} project - Project record from store
 * @param {{exists: boolean, governanceState: string, git: object|null,
 *   config: object|null, version: string|null, unreadable: string|null,
 *   unreadableHint: string|null}} [facts] - Pre-gathered directory facts, from the
 *   polled scanner. Read here interactively when omitted.
 * @param {object} [context] - Work shared across one list of projects.
 * @param {{get: () => Promise<{names: Set<string>, answered: boolean, cause: string|null}>}}
 *   [context.tmuxSessionNames] - Live session names AND whether tmux answered at
 *   all, from `tmux.createSessionNameSnapshot()`. One snapshot serves a whole
 *   list; omitting it makes this call create its own, so a caller that forgets
 *   pays for an extra invocation and is never answered wrongly.
 * @returns {Promise<object>} - Enriched project
 */
async function enrichProject(project, facts, context) {
  if (!facts) facts = await readProjectFacts(project);
  // Engine info — openclaw:<connId> resolves via connection registry
  let engine = null;
  if (project.engineId && project.engineId.startsWith('openclaw:')) {
    const connId = project.engineId.slice('openclaw:'.length);
    const conn = store.openclawConnections.get(connId);
    const baseProfile = store.engines.get('openclaw');
    if (conn) {
      engine = {
        id: project.engineId,
        name: `${conn.name} (OpenClaw)`,
        available: true,
        capabilities: baseProfile ? (baseProfile.capabilities || {}) : {}
      };
    }
  } else {
    const engineProfile = store.engines.get(project.engineId);
    if (engineProfile) {
      // Awaited, not blocking. This ran `command -v <name>` on the event loop
      // once per project on the ten-second poll, to learn a fact about the
      // MACHINE that is identical for every project using the engine; the cache
      // behind it now answers all of them from one probe.
      const det = await engines.detectEngineAsync(engineProfile);
      engine = {
        id: project.engineId,
        name: engineProfile.name,
        available: det.available,
        capabilities: engineProfile.capabilities || {}
      };
    }
  }

  // Session info — active and wrapping sessions alike, reported as live only
  // when tmux confirmed the pane, and as unknown when it could not be asked.
  //
  // Liveness comes from ONE `tmux list-sessions` shared across the whole list,
  // not a `tmux has-session` per project: the latter ran on the event loop with
  // its own 5s cap each, so a fleet's worst case scaled with the project count
  // for an answer that fits in a single invocation. The snapshot spawns nothing
  // until something below actually asks, so a project with no session in the
  // database still costs nothing at all.
  //
  // THREE outcomes, not two. A tmux server that did not answer establishes
  // nothing, so a session it could not confirm is reported as UNKNOWN rather
  // than quietly dropped — dropping it told the operator "nothing is running"
  // for a machine where everything was (#900). `active: null` is the same
  // answer `git.dirty` gives for a field its read could not establish (#891),
  // and it is what makes this safe for existing consumers: every one of them
  // tests `session && session.active`, so a null reads exactly as today's
  // not-active until something is taught to look for it.
  let session = null;
  const sessionNames = (context && context.tmuxSessionNames) || tmux.createSessionNameSnapshot();
  const activeSession = store.sessions.getActive(project.id);
  if (activeSession) {
    // Short-circuited so a session with no tmux handle still spawns nothing —
    // the snapshot's laziness is only worth having if the callers preserve it.
    const verdict = activeSession.tmuxSession ? await sessionNames.get() : null;
    if (!verdict || verdict.names.has(activeSession.tmuxSession)) {
      session = _liveSession(activeSession, activeSession.status);
    } else if (!verdict.answered) {
      session = _unknownSession(activeSession, activeSession.status, verdict.cause);
    }
    // tmux answered and this pane is gone: don't report — getSessionStatus()
    // will clean up the DB state.
  } else {
    const wrappingSession = store.sessions.getWrapping(project.id);
    if (wrappingSession) {
      // Asymmetric with the active branch above, and deliberately so: an active
      // session with no tmux name counts as live, a wrapping one does not.
      const verdict = wrappingSession.tmuxSession ? await sessionNames.get() : null;
      if (verdict && verdict.names.has(wrappingSession.tmuxSession)) {
        session = _liveSession(wrappingSession, 'wrapping');
      } else if (verdict && !verdict.answered) {
        session = _unknownSession(wrappingSession, 'wrapping', verdict.cause);
      }
      // If tmux is dead, don't report as active — let launch/status clean up
    }
  }

  // Git info, read in the scanner child. `git.getInfo` shells out with
  // `execSync`, so running it here blocked the event loop by construction —
  // before TCC was even involved, and for as long as several git commands take
  // on a stalled repo. Its two-minute cache now lives in the child, which means
  // a child killed for a hang starts cold: a few repeated git calls after a
  // kill, in exchange for never blocking the server.
  const gitInfo = facts.git || null;

  // Groups membership
  let groups = [];
  try {
    const projectGroups = store.projectGroups.getByProject(project.id);
    groups = projectGroups.map(g => {
      const docs = store.sharedDocs.getByGroup(g.id);
      return { id: g.id, name: g.name, docCount: docs.length };
    });
  } catch {
    // Ignore group lookup errors
  }

  // Project version — universal detection chain (see #55), run in the scanner
  // child. It reads up to four files at the operator's path and, when the live
  // value has moved, WRITES the cache back (#165) — so on a TCC-protected
  // directory it was the last thing here that could stall the server outright.
  // The write is atomic in the child because that process gets SIGKILLed; see
  // `lib/project-version-files.js:writeVersionCacheFile`.
  //
  // Null, never a fallback, when the child could not say: a degraded read
  // carries `version: null`, which is the same answer the in-process chain gave
  // for a directory it could not read. `|| null` also normalises the `undefined`
  // a caller passing partial facts would supply, so a forgetful call site
  // renders a project without a version rather than `undefined` on the card.
  const version = facts.version || null;

  // Eval Audit status + silentPrime (per-project Claude SessionStart hook opt-in, #103)
  // + featureIndexEnabled (#207, chunk 1)
  let evalAudit = null;
  let silentPrime = false;
  let featureIndexEnabled = false;
  let projectMapEnabled = false;
  // #318: default true — only an explicit `false` disables version-bump.
  let versionBumpEnabled = true;
  // Explicit version-file path (relative to project root). null = the built-in
  // `version.json` → `package.json` probe order.
  let versionFilePath = null;
  // MED-2K9P Chunk 02: per-project Medusa session-comms auto-enable. Default OFF —
  // only an explicit `true` opts the project into auto-starting its listener.
  let medusaEnabled = false;
  // MED-2K9P v2 T2: per-project idle-gated wake nudge. Default OFF — a wake spends
  // a real turn on inbound mail, so only an explicit `true` opts in.
  let medusaWake = false;
  // CC-6 (#381): per-project wrap-section selection. null = deep default (all 8).
  let wrapSections = null;
  // Per-step wrap overrides, keyed by step id. `{}` = run the default
  // pipeline unmodified.
  let stepOverrides = {};
  // Launch-mode posture (Phase A settings retask): engine launch-mode KEY the
  // project launches in by default, and whether the landing picker is shown.
  let defaultLaunchMode = 'default';
  let showLaunchModePicker = true;
  try {
    // Read in the scanner child, not here. `config` is null only when the
    // directory was missing or would not answer, and in THAT case the fallback
    // must not be `store.projectConfig.load(project.path)` — a read of an
    // unreadable path is precisely what this work exists to keep off the event
    // loop, and it would hang here for the same reason it hung in the child.
    // The defaults are what that reader returns for an absent file anyway, so
    // this is the same value by a route that cannot block.
    const projConfig = facts.config || JSON.parse(JSON.stringify(DEFAULT_PROJECT_CONFIG));
    if (projConfig.evalAuditMode && projConfig.evalAuditMode.enabled) {
      evalAudit = {
        enabled: true,
        openIncidents: store.evalIncidents.countByStatus(project.name, 'open')
      };
    }
    silentPrime = projConfig.silentPrime === true;
    featureIndexEnabled = projConfig.featureIndexEnabled === true;
    projectMapEnabled = projConfig.projectMapEnabled === true;
    versionBumpEnabled = projConfig.versionBumpEnabled !== false;
    versionFilePath = projectPaths.normalizeConfiguredPath(projConfig.versionFilePath);
    medusaEnabled = projConfig.medusaEnabled === true;
    medusaWake = projConfig.medusaWake === true;
    wrapSections = Array.isArray(projConfig.wrapSections) ? projConfig.wrapSections : null;
    stepOverrides = (projConfig.wrapStepOverrides && typeof projConfig.wrapStepOverrides === 'object'
      && !Array.isArray(projConfig.wrapStepOverrides))
      ? projConfig.wrapStepOverrides
      : {};
    if (typeof projConfig.defaultLaunchMode === 'string' && projConfig.defaultLaunchMode.trim()) {
      defaultLaunchMode = projConfig.defaultLaunchMode;
    }
    showLaunchModePicker = projConfig.showLaunchModePicker !== false;
  } catch {
    // Project config might not be available — skip
  }

  return {
    id: project.id,
    name: project.name,
    path: project.path,
    engine,
    // Server-actionable buttons available to this project, gated on its live
    // governance state — see lib/actions.js `availableActions`.
    actions: actions.availableActions(project, facts.governanceState),
    version,
    tags: project.tags,
    ports: project.ports,
    session,
    git: gitInfo,
    groups,
    evalAudit,
    silentPrime,
    featureIndexEnabled,
    projectMapEnabled,
    versionBumpEnabled,
    versionFilePath,
    medusaEnabled,
    medusaWake,
    wrapSections,
    wrapStepOverrides: stepOverrides,
    defaultLaunchMode,
    showLaunchModePicker,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archived: project.archived,
    // V2-plugin migration state (#262, C1) — surfaced so the operator and the
    // C2 drift indicator can see per-project status.
    migrationStatus: project.migrationStatus || null,
    // Governance state (#353). Derived live from on-disk config (engine from
    // the canonical DB row), so it self-clears the moment a project migrates.
    // A directory that isn't there — or won't answer — can't be inspected, so
    // both read as not-applicable; `unreadable` is what distinguishes them.
    governanceState: facts.governanceState,
    // Whether the directory is THERE. Additive (#950), because the pair above
    // cannot answer it: `governanceState: 'not-applicable'` is also what a
    // present-but-ungoverned project reports — eight of them on this machine at
    // the time of writing — so deriving absence from it would declare live
    // projects gone. Carried through so a consumer can tell "this project's
    // directory has been deleted" from "this project is idle", which read
    // identically before. `false` with `unreadable` set means the scan failed
    // rather than the directory being absent; `unreadable` is what separates
    // those two, exactly as the governanceState comment above describes.
    exists: facts.exists !== false,
    // Why this project's directory could not be read, and what to do about it.
    // Always present, `null` on the healthy path — a field that appeared only on
    // failure would make every consumer probe for its existence rather than read
    // its value. `unreadableHint` carries the Full Disk Access remedy only when
    // the failure is the shape that remedy fits: a collateral abort says nothing
    // about this directory, and telling someone to change permissions because of
    // it is the misdiagnosis the scanner exists to remove. Nothing renders these
    // yet — that is #885.
    unreadable: facts.unreadable || null,
    unreadableHint: facts.unreadableHint || null,
    // Machine-readable cause for #885, so the UI never parses prose:
    unreadableCode: facts.unreadableCode || null,
    continuityIndex: facts.continuityIndex || null
  };
}

/**
 * List all projects, enriched with metadata.
 *
 * Facts are gathered ONE PROJECT AT A TIME — see the comment at the loop for why
 * that is a correctness requirement and not a throttle. The route's cost is
 * therefore the SUM of the per-project reads, not the slowest of them; on a
 * healthy fleet that is about a millisecond each (measured; see
 * `architecture.md`'s Scaling Model), and an unreadable directory costs its
 * deadline once before the backoff takes over. Callers MUST await — this
 * returned an array directly before #884.
 *
 * @param {object} [options] - Filter options passed to store.projects.list
 * @returns {Promise<object[]>}
 */
async function listProjects(options = {}) {
  const projects = store.projects.list(options);
  // The ten-second poll — the one caller that opts into the failure backoff.
  //
  // ISSUED ONE AT A TIME, and that is a correctness requirement rather than a
  // throttle. The child is single-threaded and each `projectFacts` now performs
  // `git.getInfo` — several `execSync` spawns under one shared budget — plus a
  // governance read and a config parse, all synchronous in that process. Firing N requests in one tick
  // put N deadlines on a SERIAL queue, and `dir-scanner.js` starts each timer
  // when the request is ISSUED, not when the child picks it up. The tail of a
  // large fleet therefore spent its whole deadline waiting its turn, and when it
  // expired the supervisor killed the shared child: healthy-but-queued paths came
  // back `tcAborted`, one of them earned the "grant Full Disk Access" hint this
  // module exists to prevent, they entered the 30s→5min backoff, and the kill
  // discarded `git.getInfo`'s in-child cache so the retry was equally cold. The
  // failure scaled with project count and nothing bounded it.
  //
  // Sequential issue makes each deadline honest — the timer starts when the work
  // does — and means a hung directory cannot take a sibling with it, because no
  // sibling is in flight to abort. Concurrency bought nothing against a worker
  // that was serial anyway.
  const facts = [];
  for (const p of projects) {
    facts.push(await readProjectFacts(p, { interactive: false }));
  }
  // ONE tmux invocation for the whole list, shared by every enrichment below.
  // Built here rather than inside `enrichProject` so the projects that DO have
  // sessions share a single answer instead of each asking for their own; it
  // spawns nothing if none of them has a session to ask about.
  const tmuxSessionNames = tmux.createSessionNameSnapshot();
  return Promise.all(projects.map((p, i) => enrichProject(p, facts[i], { tmuxSessionNames })));
}

/**
 * Sync all registered projects: ensure scaffolding and regenerate engine configs.
 * Called on server startup to bring all projects up to date with current code.
 * @returns {{ synced: number, errors: string[] }}
 */
function syncAllProjects() {
  const allProjects = store.projects.list();
  const errors = [];
  let synced = 0;

  // Hoist global config load outside the loop (#247 hardening). Reading
  // ~/.tangleclaw/config.json N times during boot is wasteful, but the
  // more important fix is the concurrency guard: if a PATCH /api/config
  // fires mid-loop and flips stripAiCoauthors, per-project reloads would
  // produce a half-on/half-off end state across the project list. A
  // single hoisted snapshot pins behaviour for the duration of the sync.
  let snapshotConfig = null;
  try {
    snapshotConfig = store.config.load();
  } catch (err) {
    errors.push(`config load failed: ${err.message}`);
    // syncGitHooks defaults to ON for a null config — see git-hooks.js:317
    // — which keeps the failure mode safe (install attempted, foreign
    // hooks preserved by the install-time guard).
  }

  // Hoisted for the same reason as the config snapshot above, plus one specific
  // to engines: `listWithAvailability()` shells out a detection probe per engine
  // profile, so resolving per project would multiply that across the whole list
  // on every boot. `null` means nothing is installed — see the per-project use.
  let defaultEngineId = null;
  try {
    defaultEngineId = engines.resolveDefaultEngine(snapshotConfig);
  } catch (err) {
    errors.push(`engine detection failed: ${err.message}`);
  }

  for (const project of allProjects) {
    try {
      if (!project.path || !fs.existsSync(project.path)) continue;

      // Ensure session memory directory exists
      const memoriesDir = path.join(project.path, '.tangleclaw', 'memories');
      if (!fs.existsSync(memoriesDir)) {
        fs.mkdirSync(memoriesDir, { recursive: true });
      }
      const memoryFile = path.join(memoriesDir, 'MEMORY.md');
      if (!fs.existsSync(memoryFile)) {
        fs.writeFileSync(memoryFile, '# Session Memory\n\nThis file persists context across AI sessions. Update it with key decisions, progress, and open questions.\n');
      }

      // Regenerate engine config via the #240 drift-aware helper. This is
      // the startup-sync path that, per the original #240 bug, silently
      // clobbers PR-driven CLAUDE.md edits — the helper's warn fires here
      // first, giving operators visibility BEFORE the overwrite lands.
      const projConfig = store.projectConfig.load(project.path);

      // DB is the single source of truth for the engine, same as the
      // session-launch path (sessions.js — #320). The old
      // `projConfig.engine || project.engine` chain was doubly broken: store
      // rows expose `engineId` (so `project.engine` was always undefined),
      // and any project whose project.json lacked an `engine` key silently
      // fell back to claude — boot regenerated a CLAUDE.md while the true
      // engine's config (e.g. .codex.yaml) went stale forever.
      // A row with no engine falls back to the resolved default rather than a
      // hardcoded 'claude', which on a machine without Claude Code regenerated a
      // CLAUDE.md for an engine that isn't installed. No engine at all → skip
      // this project's config rather than generate one for a guess.
      // No engine at all → skip only the engine-config write, not the rest of
      // the iteration. `continue` here also skipped the #247 git-hooks sync,
      // whose own comment says it is deliberately NOT gated on engine state,
      // and skipped `synced++`, under-reporting the sync. The fallback to the
      // resolved default is defensive: `engine_id` is NOT NULL DEFAULT 'claude',
      // so a row's engine is normally always set, but `projects.update` writes
      // `engine_id` without coalescing and an empty string would reach here.
      const engineId = project.engineId || defaultEngineId;
      const engineProfile = engineId ? store.engines.get(engineId) : null;
      if (engineProfile && engineProfile.configFormat) {
        // The return value is read, not discarded. A managed-block merge can be
        // REFUSED (malformed markers, a marker literal in an injected shared
        // doc), and a refusal means this project silently has no generated
        // config — the same shape as the defect this write path was just fixed
        // for, where a guide nobody could read was reported as delivered.
        const cfgResult = engines.writeEngineConfig(engineId, project.path, projConfig, engineProfile);
        if (cfgResult.error) {
          log.warn('engine config not written at boot sync — project has no generated config', {
            project: project.name,
            engineId,
            configFilePath: cfgResult.configFilePath,
            error: cfgResult.error
          });
        }
        // #330 — for a plugin-governed project, also strip any stale TC-generated
        // `.hooks` block at boot, so the deferral is complete on the first
        // post-onboard restart rather than waiting for the next session
        // launch/create/PATCH (the other `syncEngineHooks` call sites). Gated to
        // governed projects so non-governed boot behavior is unchanged — their
        // hooks are still synced only at launch/create/PATCH, as before. Keeps
        // the two config writers symmetric for governed projects at boot
        // (feedback_symmetric_capability_gates).
        if (engines.isPluginGoverned(project.path)) {
          engines.syncEngineHooks(project.path);
        }
      }

      // #247 — sync the commit-msg git hook on each TC restart so projects
      // that existed before the feature shipped pick up the hook on first
      // boot after upgrade, and so toggle-OFF state is reapplied to any
      // project that may have been mutated externally between restarts.
      // `snapshotConfig` (hoisted above) pins the toggle value for the
      // whole sync — avoids the half-on/half-off race if a PATCH fires
      // mid-loop.
      //
      // Decision (#330): deliberately NOT gated by `isPluginGoverned`. The
      // commit-msg git hook enforces TC's own commit conventions and is
      // orthogonal to Prawduct governance — the V2 plugin owns CLAUDE.md +
      // session (SessionStart/Stop) hooks, not git hooks. A plugin-governed
      // project still wants TC's commit-msg hook, so this stays unconditional.
      try {
        gitHooks.syncGitHooks(project.path, snapshotConfig);
      } catch (err) {
        errors.push(`${project.name} (git hooks): ${err.message}`);
      }

      synced++;
    } catch (err) {
      errors.push(`${project.name}: ${err.message}`);
    }
  }

  // #252 — sync the global git template once per startup, using the
  // same hoisted config snapshot the per-project loop ran under so the
  // toggle value is identical across both surfaces. This catches the
  // case where TC was installed BEFORE #252 shipped and the operator
  // never toggled the field since (default-ON means we want the
  // template directory populated). Failures here don't fail the rest
  // of the sync — the per-project hook installs above are still the
  // primary enforcement layer.
  try {
    gitTemplate.syncGlobalTemplate(snapshotConfig);
  } catch (err) {
    errors.push(`global git template: ${err.message}`);
  }

  return { synced, errors };
}

// ── Orphan Hook Scan + Repair (#145, chunk 2) ──
//
// Bulk-repair pathway for projects whose .claude/settings.json has hook entries
// referencing $CLAUDE_PROJECT_DIR/<path> targets that no longer exist on disk.
// The chunk-1 `requires` filter (engines.js) prevents NEW orphans from being
// injected by syncEngineHooks. This pathway cleans up EXISTING orphans without
// waiting for each project's next session-launch sync — important because an
// orphan Stop hook triggers an infinite hook-failure → synthetic-user-message
// loop in Claude Code, so users need a non-launch escape hatch.
//
// Scope decisions:
// - Only `$CLAUDE_PROJECT_DIR/...` references are classified. Absolute paths
//   (e.g. the silentPrime hook's `/Users/.../sessionstart-prime-claude.sh`) are not
//   probed: in command strings they're ambiguous with CLI flags / URLs, and
//   the known incident shapes all involve $CLAUDE_PROJECT_DIR.
// - Path traversal (`..`) and absolute path entries are treated as not-orphan
//   (skipped from the check). The requires-filter rejects them; here we just
//   don't touch them — the existence question is meaningless for traversal.
// - Archived projects are skipped — they aren't candidates for live sessions.
// - The scan never mutates; only `repairOrphanHooks` writes. Atomic write via
//   tmp-file + rename so a crash mid-write can't corrupt settings.json.

const CLAUDE_PROJECT_DIR_PATTERNS = [
  /\$CLAUDE_PROJECT_DIR\/([^\s"'$]+)/g,
  /\$\{CLAUDE_PROJECT_DIR\}\/([^\s"'$]+)/g
];

/**
 * Extract `$CLAUDE_PROJECT_DIR/<path>` references from a shell command string.
 * Returns the captured relative paths (without the env-var prefix).
 *
 * The module-level `CLAUDE_PROJECT_DIR_PATTERNS` carry the `/g` flag, which
 * means a shared `lastIndex` would bleed across calls and skip matches on
 * repeated invocations. Per-call `new RegExp(src.source, src.flags)` gives
 * each call its own stateful clone (Critic N1).
 *
 * Out of scope: `~/path`, `$HOME/path`, or any other prefix shape — the known
 * incident shape uses `$CLAUDE_PROJECT_DIR` exclusively, and broadening the
 * matcher risks false-positive auto-strips (Critic T5).
 *
 * @param {string} command
 * @returns {string[]}
 */
function _extractClaudeProjectDirPaths(command) {
  if (typeof command !== 'string' || !command) return [];
  const results = [];
  for (const src of CLAUDE_PROJECT_DIR_PATTERNS) {
    const re = new RegExp(src.source, src.flags);
    let m;
    while ((m = re.exec(command)) !== null) {
      // Strip trailing punctuation that often appears after a path on the
      // command line (closing quote handled by the char-class, but a stray `,`
      // or `;` could trail in compound commands).
      let rel = m[1].replace(/[,;]+$/, '');
      if (rel) results.push(rel);
    }
  }
  return results;
}

/**
 * Return the list of `$CLAUDE_PROJECT_DIR/<path>` references in a hook entry's
 * inner-command strings that don't exist on disk under projectPath. Path
 * traversal and absolute paths inside captured groups are skipped (treated as
 * not-orphan) so this function only ever flags well-formed project-relative
 * references — same conservative posture as `_filterHookEntriesByRequires`
 * but inverted: that one fails-closed (treats traversal as missing/skip),
 * this one fails-open (treats traversal as unknown/ignore) because the
 * consequence of a false positive here is data loss (auto-stripping a hook
 * that the user wants).
 * @param {object} entry - Hook entry like `{ matcher, hooks: [...] }`
 * @param {string} projectPath - Absolute project root
 * @returns {string[]} Missing relative paths
 */
function _hookEntryOrphanMissing(entry, projectPath) {
  if (!entry || !Array.isArray(entry.hooks)) return [];
  const missing = [];
  for (const inner of entry.hooks) {
    if (!inner || typeof inner.command !== 'string') continue;
    const refs = _extractClaudeProjectDirPaths(inner.command);
    for (const rel of refs) {
      // Defensive: skip traversal / absolute. Don't auto-strip on these.
      if (rel.startsWith('/') || rel.split(/[/\\]/).includes('..')) continue;
      if (!fs.existsSync(path.join(projectPath, rel))) {
        missing.push(rel);
      }
    }
  }
  return missing;
}

/**
 * Scan all non-archived registered projects for hook entries in their
 * `.claude/settings.json` that reference `$CLAUDE_PROJECT_DIR/<path>` targets
 * that don't exist. Read-only: does not write. Returns inventory.
 *
 * @returns {{
 *   scanned: number,
 *   projectsWithOrphans: Array<{
 *     name: string,
 *     path: string,
 *     orphans: Array<{ event: string, index: number, matcher: string|undefined, missing: string[], commands: string[] }>
 *   }>,
 *   errors: Array<{ name: string, error: string }>
 * }}
 */
function scanForOrphanHooks() {
  const result = { scanned: 0, projectsWithOrphans: [], errors: [] };
  const allProjects = store.projects.list({ archived: false });
  for (const project of allProjects) {
    try {
      if (!project.path || !fs.existsSync(project.path)) continue;
      result.scanned++;
      const settingsPath = path.join(project.path, '.claude', 'settings.json');
      if (!fs.existsSync(settingsPath)) continue;
      let settings;
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (err) {
        result.errors.push({ name: project.name, error: `Failed to parse .claude/settings.json: ${err.message}` });
        continue;
      }
      if (!settings || !settings.hooks || typeof settings.hooks !== 'object') continue;
      const orphans = [];
      for (const [eventName, entries] of Object.entries(settings.hooks)) {
        if (!Array.isArray(entries)) continue;
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const missing = _hookEntryOrphanMissing(entry, project.path);
          if (missing.length > 0) {
            orphans.push({
              event: eventName,
              index: i,
              matcher: entry.matcher,
              missing,
              commands: (entry.hooks || []).map((h) => h && h.command).filter(Boolean)
            });
          }
        }
      }
      if (orphans.length > 0) {
        result.projectsWithOrphans.push({ name: project.name, path: project.path, orphans });
      }
    } catch (err) {
      result.errors.push({ name: project.name, error: err.message });
    }
  }
  return result;
}

/**
 * Repair orphan hook entries in `.claude/settings.json`. Iterates the same
 * candidate set as `scanForOrphanHooks` (or a single named project), strips
 * entries whose inner-command `$CLAUDE_PROJECT_DIR/<path>` references are
 * missing, and writes the file back atomically (tmp + rename). All non-hook
 * keys and all kept hook entries are preserved.
 *
 * Idempotent: a second call on a freshly-repaired project finds nothing to
 * remove and is a no-op (file not rewritten).
 *
 * Atomicity caveat: same-directory `rename(2)` is atomic on POSIX. TC targets
 * macOS / Linux, so the contract holds — but a hypothetical Windows port
 * would need a different strategy (Critic T3).
 *
 * Formatting caveat: the rewritten file uses 2-space indent + trailing
 * newline. A project's settings.json that previously used tabs / 4-space /
 * no trailing newline will incur unrelated diff churn on first repair
 * (Critic N2). Acceptable since this is a one-time hygiene operation.
 *
 * @param {string|null} [projectName] - Optional single-project target
 * @returns {{
 *   repaired: Array<{ name: string, path: string, removed: object[] }>,
 *   skipped: Array<{ name: string, reason: string }>,
 *   errors: Array<{ name: string, error: string }>
 * }}
 */
function repairOrphanHooks(projectName = null) {
  const result = { repaired: [], skipped: [], errors: [] };
  let candidates;
  if (projectName) {
    const single = store.projects.getByName(projectName);
    if (!single) {
      result.errors.push({ name: projectName, error: 'Project not found' });
      return result;
    }
    candidates = [single];
  } else {
    candidates = store.projects.list({ archived: false });
  }
  for (const project of candidates) {
    try {
      if (!project.path || !fs.existsSync(project.path)) {
        result.skipped.push({ name: project.name, reason: 'project path missing' });
        continue;
      }
      const settingsPath = path.join(project.path, '.claude', 'settings.json');
      if (!fs.existsSync(settingsPath)) {
        result.skipped.push({ name: project.name, reason: 'no .claude/settings.json' });
        continue;
      }
      let settings;
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (err) {
        result.errors.push({ name: project.name, error: `parse failed: ${err.message}` });
        continue;
      }
      if (!settings || !settings.hooks || typeof settings.hooks !== 'object') {
        result.skipped.push({ name: project.name, reason: 'no hooks block' });
        continue;
      }
      const removed = [];
      const newHooks = {};
      for (const [eventName, entries] of Object.entries(settings.hooks)) {
        if (!Array.isArray(entries)) {
          newHooks[eventName] = entries;
          continue;
        }
        const kept = [];
        for (const entry of entries) {
          const missing = _hookEntryOrphanMissing(entry, project.path);
          if (missing.length > 0) {
            removed.push({
              event: eventName,
              matcher: entry.matcher,
              missing,
              commands: (entry.hooks || []).map((h) => h && h.command).filter(Boolean)
            });
          } else {
            kept.push(entry);
          }
        }
        if (kept.length > 0) newHooks[eventName] = kept;
      }
      if (removed.length === 0) {
        result.skipped.push({ name: project.name, reason: 'no orphan hooks' });
        continue;
      }
      if (Object.keys(newHooks).length > 0) {
        settings.hooks = newHooks;
      } else {
        delete settings.hooks;
      }
      // Atomic write: tmp + rename. Same-directory rename is atomic on POSIX.
      const tmpPath = settingsPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n');
      fs.renameSync(tmpPath, settingsPath);
      result.repaired.push({ name: project.name, path: project.path, removed });
      log.info('Repaired orphan hooks (#145)', {
        projectName: project.name,
        removedCount: removed.length
      });
    } catch (err) {
      result.errors.push({ name: project.name, error: err.message });
    }
  }
  return result;
}

// ── Stranded Ancestor Configs (#592) ──
//
// When a project's registration moves deeper into its own directory tree
// (old root archived/deleted, new project created at a subdirectory — the
// TiLT v2 shape), the engine configs TC generated at the old root are never
// pruned: `deleteProject` without `deleteFiles` and `archiveProject` leave
// every generated file in place. Claude Code walks UP the directory tree
// loading every CLAUDE.md it finds, so a stale ancestor file silently
// re-injects retired governance into every session of the nested project —
// the #536 dual-playbook hazard, resurrected from outside the repo.
//
// Design mirrors the orphan-hooks pair (#145) with one deliberate
// difference: there is NO auto-repair. A stranded CLAUDE.md can contain
// hand-written operator content alongside generated prose, so deletion is
// an operator decision — the guard's job is detection and surfacing
// (boot-time WARN + read-only API inventory), never destruction.

/** Governance files whose presence in an unregistered ancestor dir is a finding. */
const STRANDED_CONFIG_FILES = ['CLAUDE.md', path.join('.claude', 'settings.json')];

/**
 * Find governance config files in ancestor directories of a project path
 * that no registered project owns.
 *
 * Walks from `projectPath`'s parent up to (and excluding) `projectsRoot`,
 * flagging any directory that holds a governance file (`CLAUDE.md` or
 * `.claude/settings.json`) and is not itself a registered project root.
 * Presence-based by design: whether or not TC generated the file, an
 * unowned ancestor CLAUDE.md injects into the nested project's sessions,
 * so it is drift worth surfacing either way.
 *
 * Registered roots include ARCHIVED projects: an archived parent still owns
 * its config (it returns on unarchive), so it is never reported as
 * stranded. The narrower hazard of an archived parent's config injecting
 * into a live nested project is deliberately out of scope here — flagging
 * a real project's files as strays would invite deleting them.
 *
 * Directories outside `projectsRoot` (and the root itself) are never
 * scanned — above the root sits user-personal territory (`~/.claude/`,
 * home-level CLAUDE.md) where files are presumed intentional.
 *
 * @param {string} projectPath - Absolute project root path
 * @param {Set<string>} registeredPaths - Resolved absolute paths of ALL registered projects (archived included)
 * @param {string} projectsRoot - Resolved absolute projects directory
 * @returns {Array<{ dir: string, files: string[] }>} Stranded dirs, nearest first
 */
function _findStrandedAncestorConfigs(projectPath, registeredPaths, projectsRoot) {
  const findings = [];
  if (!projectPath || !projectsRoot) return findings;
  const root = path.resolve(projectsRoot);
  let dir = path.dirname(path.resolve(projectPath));
  while (dir !== root && dir.startsWith(root + path.sep)) {
    if (!registeredPaths.has(dir)) {
      const files = STRANDED_CONFIG_FILES.filter((rel) => fs.existsSync(path.join(dir, rel)));
      if (files.length > 0) findings.push({ dir, files });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root — cannot ascend further
    dir = parent;
  }
  return findings;
}

/**
 * Scan all non-archived registered projects for stranded governance configs
 * in their ancestor directories (#592). Read-only: does not write.
 *
 * Findings are deduplicated by directory — a stranded dir sitting above
 * several nested projects is reported once, with every affected project
 * listed. See `_findStrandedAncestorConfigs` for what counts as stranded.
 *
 * @returns {{
 *   scanned: number,
 *   stranded: Array<{ dir: string, files: string[], affectedProjects: string[] }>,
 *   errors: Array<{ name: string, error: string }>
 * }}
 */
function scanForStrandedConfigs() {
  const result = { scanned: 0, stranded: [], errors: [] };
  let projectsRoot;
  try {
    projectsRoot = resolveProjectsDir(store.config.load().projectsDir);
  } catch (err) {
    result.errors.push({ name: '(config)', error: `projectsDir resolve failed: ${err.message}` });
    return result;
  }
  const allRegistered = store.projects.list({ archived: true });
  const registeredPaths = new Set(
    allRegistered.map((p) => p.path && path.resolve(p.path)).filter(Boolean)
  );
  const byDir = new Map();
  for (const project of allRegistered.filter((p) => !p.archived)) {
    try {
      if (!project.path) continue;
      result.scanned++;
      for (const finding of _findStrandedAncestorConfigs(project.path, registeredPaths, projectsRoot)) {
        const existing = byDir.get(finding.dir);
        if (existing) {
          existing.affectedProjects.push(project.name);
        } else {
          byDir.set(finding.dir, { ...finding, affectedProjects: [project.name] });
        }
      }
    } catch (err) {
      result.errors.push({ name: project.name, error: err.message });
    }
  }
  result.stranded = [...byDir.values()];
  return result;
}

/**
 * The operator-facing explanation for a failed projects scan, or undefined when
 * there is nothing useful to add.
 *
 * Extracted so it can be tested. Inline, this string had no coverage at all —
 * deleting it left every test green — and it is the entire operator-facing value
 * of degrading instead of hanging: without it the dashboard simply shows fewer
 * projects and nobody learns why.
 *
 * Only a DEADLINE failure earns the hint. An ordinary `EACCES`/`ENOTDIR` already
 * says what it is; "the path never answered" is the one that looks like nothing
 * at all and has a specific macOS cause worth naming.
 *
 * Says "a protected folder", not "TCC": this is the one message a stranded
 * non-expert reads, and it is the worst moment to introduce an acronym. The
 * other two surfaces naming this condition — the wizard's pre-choice caution and
 * the truncated-walk error — already avoid it, so plain wording is the house
 * style here, not a preference.
 *
 * Scoped to what the browser shows an operator, which is what `doesNotMatch`
 * pins. `deploy/install.sh` still prints "TCC-protected folder" in its terminal
 * output, deliberately: someone running a shell installer by hand has a
 * different tolerance for the term than someone stranded in a setup wizard. So
 * the rule is about THIS audience, not a repo-wide ban — and comments and JSDoc
 * stay free to be precise.
 *
 * @param {Error & {tcTimedOut?: boolean}} err - The failure from the scan.
 * @returns {string|undefined}
 */
function _scanFailureHint(err) {
  if (!err || !err.tcTimedOut) return undefined;
  return 'the directory did not respond. On macOS that is what a protected folder does when '
    + 'node has no Full Disk Access. Grant it, or choose a projects directory outside '
    + '~/Documents, ~/Desktop and ~/Downloads';
}

/**
 * The `scan` block every projects listing carries.
 *
 * Called with no failure for the healthy path, so the healthy answer is built by
 * the same function as the degraded one and the two cannot drift into different
 * shapes. `complete` is derived from whether a code was given rather than passed
 * separately — a caller cannot report a failure and a complete list at once.
 *
 * @param {string} dir - The directory the scan was for.
 * @param {object} [failure] - Omitted on the healthy path.
 * @param {string} [failure.code] - Machine-readable cause; see `dirScanner.failureCode`.
 * @param {string} [failure.reason] - One sentence for a human.
 * @param {string} [failure.hint] - The remedy, where one fits the failure.
 * @param {number} [failure.listed] - Entries reported before a cut-off.
 * @returns {{dir: string, complete: boolean, code: string|null, reason: string|null,
 *   hint: string|null, listed: number|null}}
 */
function _scanState(dir, failure) {
  return {
    dir,
    complete: !failure,
    code: (failure && failure.code) || null,
    reason: (failure && failure.reason) || null,
    hint: (failure && failure.hint) || null,
    listed: failure && Number.isFinite(failure.listed) ? failure.listed : null
  };
}

/**
 * List all projects: merge SQLite-registered projects with ALL filesystem directories.
 * Unregistered dirs get { registered: false } entries with basic git info.
 * ASYNC (#859): the filesystem scan runs off the main thread and is bounded, so a
 * projects directory that never answers costs this request instead of the whole
 * server. Callers MUST await — the previous signature returned an array directly,
 * and dropping the await now yields a Promise that silently renders as nothing.
 *
 * Never rejects on a scan failure: a directory that is missing, unreadable or
 * unresponsive degrades to the registered projects and logs why. Callers get a
 * SHORT list, never an error, so absence of unregistered entries is not proof
 * there are none.
 *
 * `enrichProject` no longer touches a registered project's directory at all —
 * existence, governance, git, config and version detection all come from the
 * scanner child, so a TCC-protected project directory can no longer block this
 * process's event loop through this path (#884).
 *
 * THAT IS A CLAIM ABOUT THIS PATH, NOT ABOUT THE SERVER. Other routes still read
 * operator-chosen paths synchronously — `lib/uploads.js` and
 * `detectExistingProjects` are the known remainder — so "the dashboard list
 * cannot hang" does not generalise to "the server cannot hang".
 *
 * Note that the family is NOT well described by grepping
 * `existsSync|readdirSync|statSync`: of the five synchronous reads this function
 * originally performed per project, that pattern matched only one. The project's
 * learnings entry says fix the family, not the call site, after #859's first fix
 * landed on `listAllProjects` and missed `POST /api/setup/scan`.
 *
 * RETURNS THE LIST AND WHETHER IT IS THE WHOLE LIST. Degrading silently was the
 * remaining half of the defect: the browser got a 200 and a well-formed array,
 * and nothing distinguished "these are all your projects" from "these are the
 * ones we could still see" (#885). `scan` is always present and always the same
 * shape, so a consumer reads its fields rather than probing for them.
 *
 * @param {object} [options] - Filter options passed to store.projects.list for registered projects
 * @returns {Promise<{projects: object[], scan: {dir: string, complete: boolean,
 *   code: string|null, reason: string|null, hint: string|null, listed: number|null}}>}
 */
async function listAllProjects(options = {}) {
  const registered = await listProjects(options);
  const registeredNames = new Set(registered.map(p => p.name));

  // Also track archived project names so they don't appear as unregistered filesystem dirs
  const allRegistered = store.projects.list({ archived: true });
  const allRegisteredNames = new Set(allRegistered.map(p => p.name));

  const config = store.config.load();
  const projectsDir = resolveProjectsDir(config.projectsDir);

  // IN ANOTHER PROCESS, AND BOUNDED. This scan reads a directory the operator
  // chooses, and the shipped default (`~/Documents/Projects`) is TCC-protected
  // on macOS. A launchd-spawned node without Full Disk Access does not get
  // `EPERM` there — the `open()` never returns at all.
  //
  // Two earlier shapes of this call both failed, and the second is why the walk
  // is no longer here at all. Synchronous, it blocked the event loop, so ONE
  // request to `GET /api/projects` took down every route in the server.
  // Asynchronous with a deadline, it stopped blocking the loop but still lost a
  // libuv threadpool thread per hung read — abandoning a promise does not cancel
  // a syscall — and the pool is four threads shared by the whole process, so
  // four such reads left the server unable to touch the filesystem at all while
  // `/api/health` kept answering 200 (#883). Only killing the process that owns
  // a thread blocked in the kernel reclaims it, so the walk happens in a child
  // this deadline can kill.
  //
  // Degrading to the registered list is honest: those come from SQLite and are
  // unaffected; only the discovery of not-yet-registered directories is lost,
  // and it is reported. The child's own budget is SHORTER than this request's
  // deadline (see PROJECT_SCAN_WALK_MARGIN_MS) so a walk that is merely slow
  // truncates and hands back what it found, instead of being killed with it.
  let walk;
  try {
    walk = await dirScanner.request(
      'listUnregistered',
      {
        dir: projectsDir,
        skipNames: [...allRegisteredNames],
        budgetMs: PROJECT_WALK_BUDGET_MS
      },
      {
        timeoutMs: PROJECT_SCAN_TIMEOUT_MS,
        what: `reading ${projectsDir}`,
        // The reason the backoff exists. It is opted into here and by the
        // per-project reads behind `listProjects` — both are this same
        // ten-second poll. Every operator-pressed path reads interactively
        // instead; see `lib/project-facts.js`.
        // The dashboard polls this route every ten seconds for as long as a tab
        // is open. Without a backoff an unreadable projects directory costs a
        // five-second stall and a killed child on every tick, forever — and a
        // child blocked in the kernel may never leave the process table, so that
        // is a process accumulating every ten seconds, not a cost that settles.
        // Nobody asked for each of those reads; they are a poll. The wizard's
        // scan and create-directory deliberately do NOT opt in, because a person
        // who just changed a permission and pressed the button again must get a
        // real answer rather than a remembered one.
        pathKey: projectsDir
      }
    );
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Not a failure to read — there is nothing there to read. Still incomplete,
      // and still worth saying: an operator whose configured projects directory
      // does not exist sees only registered projects forever, and the remedy is
      // creating or re-pointing the directory rather than granting a permission.
      return {
        projects: registered.map(p => ({ ...p, registered: true })),
        scan: _scanState(projectsDir, {
          code: 'DIR_MISSING',
          reason: `The projects directory does not exist: ${projectsDir}`
        })
      };
    }
    // A remembered refusal is not news. The scanner already logged a WARN naming
    // this path when it really failed, and it logs another each time the backoff
    // escalates — so warning again on every poll would bury those behind six
    // identical lines a minute and turn one broken directory into a log flood.
    // The condition is unchanged and still degrades the list; only its novelty
    // has gone, so it drops to debug rather than disappearing.
    const say = (err && err.tcCached) ? log.debug : log.warn;
    say('Could not scan the projects directory — registered projects are unaffected, '
      + 'but unregistered folders will not be listed', {
      projectsDir,
      error: err && err.message,
      hint: _scanFailureHint(err)
    });
    return {
      projects: registered.map(p => ({ ...p, registered: true })),
      scan: _scanState(projectsDir, {
        code: dirScanner.failureCode(err),
        reason: 'Could not read the projects directory, so folders that are not registered '
          + 'are missing from this list. Registered projects are unaffected.',
        hint: _scanFailureHint(err)
      })
    };
  }

  if (walk.truncated) {
    log.warn('Projects scan ran out of time — the list is SHORT, not empty. Directories after '
      + 'the cut-off were not checked', {
      projectsDir,
      listed: walk.unregistered.length,
      budgetMs: PROJECT_WALK_BUDGET_MS
    });
  }

  const result = registered.map(p => ({ ...p, registered: true }));
  return {
    projects: [...result, ...walk.unregistered].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    ),
    // A truncated walk is the OPPOSITE failure and must not be described as the
    // same one: nothing is broken, the directory is just bigger or slower than
    // the budget. It gets no remedy, because there is nothing to fix — telling
    // someone to grant Full Disk Access for a folder that answered perfectly
    // well is the misdiagnosis this whole area exists to remove.
    scan: walk.truncated
      ? _scanState(projectsDir, {
        code: 'SCAN_TRUNCATED',
        reason: 'The projects directory has more folders than one scan could check in time, '
          + 'so this list is short rather than complete. Nothing is wrong with it.',
        listed: walk.unregistered.length
      })
      : _scanState(projectsDir)
  };
}

// The realpath of the checkout this server runs from, resolved ONCE at module
// load. Per-request synchronous filesystem calls on the event loop are exactly
// what wedged the scan route on a TCC-protected directory (#859), so the
// request path below compares data the scanner CHILD computed under its budget
// and never touches the filesystem itself. Load-time is safe here: requiring
// this module already read this same tree.
const OWN_INSTALL_REALPATH = (() => {
  const root = path.join(__dirname, '..');
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
})();

/**
 * Scan an operator-supplied directory for candidate projects, bounded in time
 * and off the main thread.
 *
 * OFF THE MAIN THREAD, AND BOUNDED — for the same reason `listAllProjects` is,
 * and this is the more dangerous of the two. It backs step 2 of the first-run
 * wizard, and the directory it scans defaults to `~/Documents/Projects`, which
 * is TCC-protected on macOS. A launchd-spawned node without Full Disk Access
 * does not get `EPERM` there: the `open()` never returns. Done synchronously
 * that blocked the event loop, so one wizard click took down every route in the
 * server — `/api/health` answered 200 seconds earlier and then nothing, no
 * error, no log line, no recovery, while launchd still reported the process
 * alive. It needed a `launchctl kickstart`. Measured on a clean macOS guest:
 * scanning an ordinary directory returned 200 and left the server healthy;
 * scanning `~/Documents/Projects` never answered and killed the process.
 *
 * Unlike the projects list there is nothing to degrade to here — the operator
 * asked about one specific directory, and is about to tick boxes from the
 * answer — so a failure is REPORTED rather than silently shortened, and it
 * carries a remedy matched to which failure it was.
 *
 * @param {string} directory - Operator-supplied path, `~` allowed.
 * @returns {Promise<{ok: true, projects: object[]}|{ok: false, code: string, error: string}>}
 */
async function scanDirectoryForProjects(directory) {
  const dir = resolveProjectsDir(directory);

  try {
    const { projects } = await dirScanner.interactiveRequest(
      'scanEntries',
      { dir, budgetMs: PROJECT_WALK_BUDGET_MS, ownInstallRealPath: OWN_INSTALL_REALPATH },
      { timeoutMs: PROJECT_SCAN_TIMEOUT_MS, what: `scanning ${dir}` }
    );
    // The running TangleClaw checkout never offers itself (#708). The README's
    // install steps put the clone wherever the operator happens to be, which is
    // routinely the folder they then name as their projects directory — and the
    // clone carries both detection markers (a git branch and project files), so
    // the wizard pre-checked it and attached the tool as the operator's first
    // "project", writing per-project config into the clone. Filtered here,
    // server-side, so a client that forgets cannot re-introduce it — on the
    // child's realpath verdict, so this process compares data, not the
    // filesystem. Attaching this checkout DELIBERATELY (developing TangleClaw
    // with TangleClaw) stays possible through the normal attach flow, which
    // does not pass through this scan.
    const dropped = projects.filter((p) => p.isOwnInstall);
    for (const p of dropped) {
      log.debug('Setup scan excluded the running install from candidates', {
        path: p.path, scannedDir: dir
      });
    }
    return { ok: true, projects: projects.filter((p) => !p.isOwnInstall) };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Its own code, not BAD_REQUEST. The browser offers to CREATE this one,
      // and it decided which failure it was by regex-matching the prose — so a
      // reworded sentence silently removed the button. The condition travels as
      // a value; the sentence is for the human.
      return { ok: false, code: 'DIR_MISSING', error: `Directory does not exist: ${directory}` };
    }
    if (err && err.code === 'ENOTDIR') {
      return { ok: false, code: 'BAD_REQUEST', error: `Path is not a directory: ${directory}` };
    }
    // Collateral: this scan never got to run, because a concurrent request in
    // the same scanner process stopped responding and the process had to be
    // killed. It says NOTHING about the directory the operator chose, so it must
    // not reach `_scanFailureHint` below — telling someone to grant Full Disk
    // Access for a folder that was never read is the misdiagnosis this whole
    // change exists to remove. The honest answer is "we did not get to look;
    // try again", and trying again is genuinely likely to work, since the
    // scanner forks a fresh child for the next request.
    if (err && err.tcAborted) {
      return {
        ok: false,
        code: 'SCAN_INTERRUPTED',
        error: `Could not finish reading ${directory} — another directory being read at the `
          + 'same time stopped responding, and this scan was interrupted with it. Nothing is '
          + 'known to be wrong with this folder; try again.'
      };
    }
    // 4xx rather than 5xx: nothing is wrong with the server, and the operator
    // is the only one who can act — by granting Full Disk Access or choosing a
    // different directory. The hint is the whole point of answering at all; an
    // unexplained failure here is barely better than the hang it replaced.
    const hint = _scanFailureHint(err);
    log.warn('Could not scan the requested directory', {
      directory: dir, error: err && err.message, hint
    });
    // The hint REPLACES the raw message rather than following it. The raw
    // message for the case that matters is "timed out after 5000ms scanning
    // <path>" — which restates the path the sentence already opens with, and
    // leads with a number nobody can act on. What is left is one sentence that
    // names the directory, what happened, and what to do about it.
    //
    // A truncated walk gets its own sentence. It is the one failure here that a
    // perfectly healthy machine can produce — a very large directory, a slow
    // disk — and offering Full Disk Access as the remedy for that would send the
    // operator to change a setting that was never the problem. It names the
    // possibility last, as a possibility.
    if (err && err.tcTruncated) {
      return {
        ok: false,
        code: 'SCAN_FAILED',
        error: `Could not finish reading ${directory} — ${err.message}. A very large projects `
          + 'directory or a slow disk can do this; on macOS so can a directory node cannot read '
          + 'without Full Disk Access (~/Documents, ~/Desktop and ~/Downloads).'
      };
    }
    return {
      ok: false,
      code: 'SCAN_FAILED',
      error: `Could not read ${directory} — ${hint || (err && err.message)}`
    };
  }
}

/**
 * Create the projects directory the operator named, if it is somewhere they
 * could reasonably have meant.
 *
 * WHY THIS EXISTS. `~/Documents/Projects` is the shipped default and the value
 * the wizard pre-fills — and a stock macOS install does not have it. macOS
 * creates `Documents`; nothing creates `Projects`. Nothing in TangleClaw
 * created it either, so the first action of a brand-new install — accept the
 * default, press Next — answered "Directory does not exist" and offered no way
 * forward inside the product. Accurate, and useless: the operator had to leave,
 * make a folder in Finder, and come back.
 *
 * WHY THE CONSTRAINT IS THE SECURITY BOUNDARY. This runs during first-run
 * setup, before any credential exists, so it cannot be protected by one. It
 * therefore refuses to be a general-purpose mkdir: the path must resolve inside
 * the operator's own home directory, and only the final segment may be created,
 * so it can add `~/Documents/Projects` and cannot walk out to `/etc` or lay
 * down a deep tree somewhere it was never pointed. `path.resolve` collapses
 * `..` before the check, so traversal is normalised away rather than
 * pattern-matched.
 *
 * @param {string} directory - Operator-supplied path, `~` allowed.
 * @returns {Promise<{ok: true, path: string, created: boolean}|{ok: false, code: string, error: string}>}
 */
async function createProjectsDir(directory) {
  const dir = resolveProjectsDir(directory);
  const home = process.env.HOME || '';

  if (!home) {
    return { ok: false, code: 'BAD_REQUEST', error: 'No home directory is set for this server.' };
  }
  // Inside HOME, and not HOME itself — which already exists, and asking to
  // "create" it means the request was not what it looked like.
  if (dir === home || !dir.startsWith(home + path.sep)) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      error: `TangleClaw will only create a folder inside your home directory (${home}).`
    };
  }

  // IN THE SCANNER CHILD, for the reason the rest of this file is. The path this
  // exists to create is `~/Documents/Projects`, so the parent probe lands on
  // `~/Documents` — TCC-protected, where a launchd-spawned node gets no EPERM and
  // no answer at all. Written with `existsSync`/`mkdirSync` this button was the
  // #859 wedge; written with `fs.promises` and a deadline it was the #883 thread
  // leak, in the one place most certain to touch a protected directory.
  //
  // The home-directory constraint above stays HERE and is not repeated in the
  // child: it is the security boundary for a route reachable before any
  // credential exists, and a boundary stated in two places is a boundary in
  // neither. The child does as it is told; this function is what decides what it
  // may be told.
  let outcome;
  try {
    outcome = await dirScanner.interactiveRequest(
      'createDir',
      { dir },
      { timeoutMs: PROJECT_SCAN_TIMEOUT_MS, what: `creating ${dir}` }
    );
  } catch (err) {
    // Same reasoning as the scan above: collateral means this never ran, so it
    // is not evidence about the path and must not earn the Full Disk Access
    // remedy. Nothing was created, so retrying is safe as well as sensible.
    if (err && err.tcAborted) {
      return {
        ok: false,
        code: 'CREATE_INTERRUPTED',
        error: `Could not create ${directory} — another directory being read at the same time `
          + 'stopped responding, and this was interrupted with it. Nothing was created; try again.'
      };
    }
    const hint = _scanFailureHint(err);
    return {
      ok: false,
      code: 'CREATE_FAILED',
      error: `Could not create ${directory}: ${hint || (err && err.message)}`
    };
  }
  if (outcome.status === 'exists') {
    // Already there. Not an error — two clicks on the same button, or a folder
    // made in Finder while this screen was open, should both end well.
    return { ok: true, path: dir, created: false };
  }
  if (outcome.status === 'parent-missing') {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      error: `The folder above it does not exist either (${outcome.parent}) — create that first, `
        + 'or choose a different path.'
    };
  }

  log.info('Created the projects directory at the operator\'s request', { path: dir });
  return { ok: true, path: dir, created: true };
}

/**
 * Attach an existing filesystem directory as a registered project.
 * Reads an existing .tangleclaw/project.json if present.
 * @param {string} name - Directory name in projectsDir
 * @returns {Promise<{ project: object|null, errors: string[] }>}
 */
async function attachProject(name) {
  const errors = [];

  const nameCheck = validateName(name);
  if (!nameCheck.valid) {
    return { project: null, errors: [nameCheck.error] };
  }

  // Identity check is case-insensitive (#221, sibling to #188) — mirrors the
  // `createProject` gate so attach can't introduce a case-collision the
  // create path would reject. `feedback_symmetric_capability_gates` —
  // gates around the same conceptual flag (project-name identity) must
  // check the same predicate.
  const existing = store.projects.getByNameCaseInsensitive(name);
  if (existing) {
    const msg = existing.name === name
      ? `Project "${name}" already registered`
      : `Project "${existing.name}" already registered (case-insensitive match for "${name}")`;
    return { project: null, errors: [msg] };
  }

  const config = store.config.load();
  const projectsDir = resolveProjectsDir(config.projectsDir);
  const projPath = path.join(projectsDir, name);

  if (!fs.existsSync(projPath) || !fs.statSync(projPath).isDirectory()) {
    return { project: null, errors: [`Directory "${name}" not found in ${projectsDir}`] };
  }

  // Read existing project config if present
  const projConfigPath = path.join(projPath, '.tangleclaw', 'project.json');
  // An existing project.json wins, so read it FIRST and resolve only if it
  // didn't answer. Resolving unconditionally ran a detection probe per engine
  // profile on every attach, and then discarded the result for any project that
  // already recorded its own engine — which is the common case for a directory
  // TangleClaw previously managed.
  let engineId = null;
  if (fs.existsSync(projConfigPath)) {
    try {
      const existingConfig = JSON.parse(fs.readFileSync(projConfigPath, 'utf8'));
      if (existingConfig.engine) engineId = existingConfig.engine;
    } catch (err) {
      errors.push(`Failed to read existing project.json: ${err.message}`);
    }
  }

  // Resolve against installed engines; an attached project shouldn't inherit a
  // default naming a binary this machine doesn't have while an installed engine
  // sits unused. With nothing installed, record the configured intent — attaching
  // is bookkeeping and must not require an engine binary to be present.
  if (!engineId) {
    engineId = engines.resolveDefaultEngine(config)
      || (config && config.defaultEngine)
      || store.DEFAULT_CONFIG.defaultEngine;
  }

  // Register in SQLite
  const project = store.projects.create({
    name,
    path: projPath,
    engine: engineId,
    tags: [],
    ports: {}
  });

  // Scaffold CHANGELOG.md if not present
  const changelogPath = path.join(projPath, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    try {
      fs.writeFileSync(changelogPath, `# Changelog\n\nAll notable changes to ${name} are documented in this file.\n\n## [Unreleased]\n`);
    } catch (err) {
      errors.push(`Failed to create CHANGELOG.md: ${err.message}`);
    }
  }

  // Write per-project config if none exists
  if (!fs.existsSync(projConfigPath)) {
    const projConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
    projConfig.engine = engineId;
    store.projectConfig.save(projPath, projConfig);
  }

  try {
    engines.syncEngineHooks(projPath);
  } catch (err) {
    log.warn('Failed to sync engine hooks during project attach', { error: err.message });
  }

  // #247 — install commit-msg git hook on attach (same gate as create).
  try {
    gitHooks.syncGitHooks(projPath, store.config.load());
  } catch (err) {
    log.warn('Failed to sync git hooks during project attach', { error: err.message });
  }

  log.info('Project attached', { name, path: projPath, engine: engineId });
  return { project: await enrichProject(project), errors };
}

/**
 * Get a single project by name, enriched.
 * @param {string} name - Project directory name
 * @returns {Promise<object|null>}
 */
async function getProject(name) {
  const project = store.projects.getByName(name);
  if (!project) return null;
  return enrichProject(project);
}

/**
 * A project's canonical database row, with no enrichment and no filesystem read.
 *
 * For the many callers that only need to know the project EXISTS and where it
 * lives. `getProject` enriches, and since #884 enrichment means a round trip to
 * the scanner child — a whole cross-process exchange to answer a question those
 * callers never ask. Eight routes were paying it: the four continuity readers,
 * both upload routes, delete, and session launch, every one of which uses the
 * result only as a 404 guard plus `path` (and, in one case, `id`).
 *
 * Returns the row verbatim, so `path`, `id`, `name` and `engineId` are present
 * and the enriched-only fields (`git`, `governanceState`, `actions`, `version`,
 * `unreadable`) are not. A caller that needs any of those wants `getProject`.
 *
 * @param {string} name - Project name.
 * @returns {object|null} The DB row, or null when no such project exists.
 */
function getProjectRow(name) {
  return store.projects.getByName(name) || null;
}

// ── Project Update ──

/**
 * Apply a `medusaEnabled` flip to the project's LIVE session, if any (TC#549,
 * MED-2K9P v2 T3). Before this, the pref only took effect at the next launch, so
 * an already-running session stayed unregistered — invisible in every other
 * session's switchboard roster — with no signal why. ON starts the listener
 * (registers the workspace with the Bridge); OFF stops it (deregisters).
 *
 * Non-throwing: a listener failure must never fail the project update — the
 * pref is already persisted, and the listener's own honest status surfaces any
 * Bridge trouble. No active session is a clean no-op (next launch reads the
 * pref). `medusa` is required lazily to keep this module free of a startup
 * dependency on the listener stack.
 * @param {object} project - Project record (needs `id`, `path`, `name`).
 * @param {boolean} enabled - The new `medusaEnabled` value.
 * @returns {void}
 */
function _syncLiveMedusaListener(project, enabled) {
  try {
    const active = store.sessions.getActive(project.id);
    if (!active) return;
    const medusa = require('./medusa');
    if (enabled) {
      medusa.startSession({ projectPath: project.path, sessionId: active.id, name: project.name });
    } else {
      medusa.stopSession(active.id);
    }
    log.info('Synced Medusa listener to live session on pref change', {
      project: project.name, session: active.id, enabled
    });
  } catch (err) {
    log.warn('Failed to sync Medusa listener on pref change', { project: project.name, error: err.message });
  }
}

/**
 * The launch mode an engine will actually keep: a mode the engine cannot honor
 * (absent from its `launchModes`, or present-but-disabled) reconciles to
 * `'default'` — the universally-valid, warning-free interactive mode every
 * engine defines. Used both to persist a reconciled mode after an engine switch
 * and to judge the eyes-open guard against the value that will really be stored,
 * so a stranded mode can neither slip a hidden picker past the guard nor
 * false-block a switch that reconciliation makes harmless.
 * @param {string} mode - The requested/stored `defaultLaunchMode`.
 * @param {object|null} engineProfile - The engine whose modes gate validity.
 * @returns {string} `mode` if the engine honors it, else `'default'`.
 */
function reconcileLaunchMode(mode, engineProfile) {
  // Delegates to the single definition in `engines` — session launch and
  // launch-command assembly ask the same question, and the three copies had
  // drifted (one omitted the `disabled` check entirely). Kept as an export
  // here because callers and tests already reach for it at this name.
  return engines.reconcileLaunchMode(mode, engineProfile);
}

/**
 * Update project configuration (engine, tags, rules).
 * @param {string} name - Project name
 * @param {object} updates - Fields to update
 * @returns {Promise<{ project: object|null, errors: string[] }>}
 */
async function updateProject(name, updates) {
  const project = store.projects.getByName(name);
  if (!project) {
    return { project: null, errors: [`Project "${name}" not found`] };
  }

  const errors = [];
  const storeUpdates = {};

  // Pre-validate silentPrime (#103) against the *intended* post-update engine before
  // any side-effecting mutations run. The Critic on chunk 2 caught a partial-update
  // bug where engine→gemini + silentPrime=true in the same PATCH would write disk
  // (engine config + projConfig.engine) and then reject silentPrime, leaving DB and
  // disk inconsistent. By validating up here, a rejection drops cleanly without
  // mutating any state.
  if (updates.silentPrime !== undefined) {
    if (typeof updates.silentPrime !== 'boolean') {
      return { project: null, errors: ['silentPrime must be a boolean'] };
    }
    if (updates.silentPrime === true) {
      const intendedEngineId = updates.engine
        || store.projectConfig.load(project.path).engine
        || project.engineId;
      const intendedProfile = intendedEngineId ? store.engines.get(intendedEngineId) : null;
      const supports = intendedProfile
        && intendedProfile.capabilities
        && intendedProfile.capabilities.supportsSilentPrime === true;
      if (!supports) {
        return { project: null, errors: ['Engine does not support silentPrime'] };
      }
    }
  }

  // Feature Index toggle (#207) — type-validate up here for the same
  // reason as silentPrime: a rejection drops cleanly without mutating any
  // state. Unlike silentPrime, no engine capability check is needed at this
  // layer because the FEATURES.md file and wrap-step parity are
  // engine-agnostic; the engine capability gate lives at the SessionStart
  // injection site (Chunk 2) where it actually matters.
  if (updates.featureIndexEnabled !== undefined && typeof updates.featureIndexEnabled !== 'boolean') {
    return { project: null, errors: ['featureIndexEnabled must be a boolean'] };
  }
  // PIDX (#360, #356): per-project Project Map opt-in (engine-agnostic).
  if (updates.projectMapEnabled !== undefined && typeof updates.projectMapEnabled !== 'boolean') {
    return { project: null, errors: ['projectMapEnabled must be a boolean'] };
  }
  // #318: per-project version-bump opt-out (engine-agnostic).
  if (updates.versionBumpEnabled !== undefined && typeof updates.versionBumpEnabled !== 'boolean') {
    return { project: null, errors: ['versionBumpEnabled must be a boolean'] };
  }
  // Explicit version-file path. Must stay inside the project: the wrap's commit
  // step flushes whatever this resolves to, so an absolute or `..`-escaping value
  // would turn a settings field into an arbitrary-file write.
  if (updates.versionFilePath !== undefined && updates.versionFilePath !== null) {
    if (typeof updates.versionFilePath !== 'string') {
      return { project: null, errors: ['versionFilePath must be a string or null'] };
    }
    // Normalized and resolved through the same helpers the readers use, so the
    // validator can never accept what the write site later refuses (a setting
    // that saves cleanly and then silently does nothing). This is an incoming
    // update rather than a loaded config, so it normalizes the value first and
    // then resolves, instead of taking the combined config-read path.
    const v = projectPaths.normalizeConfiguredPath(updates.versionFilePath);
    if (v !== null) {
      const contained = projectPaths.resolveWithinProject(project.path, v);
      if (!contained.ok) {
        return { project: null, errors: [`versionFilePath ${contained.reason}`] };
      }
    }
  }
  // MED-2K9P Chunk 02: per-project Medusa session-comms auto-enable (engine-agnostic;
  // the listener is TC-server-side and works regardless of engine). Type-validate up
  // here so a rejection drops cleanly without mutating state, matching the gates above.
  if (updates.medusaEnabled !== undefined && typeof updates.medusaEnabled !== 'boolean') {
    return { project: null, errors: ['medusaEnabled must be a boolean'] };
  }
  // MED-2K9P v2 T2: per-project idle-gated wake opt-in (same shape as medusaEnabled).
  if (updates.medusaWake !== undefined && typeof updates.medusaWake !== 'boolean') {
    return { project: null, errors: ['medusaWake must be a boolean'] };
  }
  // CC-6 (#381): per-project wrap-section selection. null clears the override
  // (deep default = all 8); otherwise it must be an array of valid section
  // names (subset of continuity.WRAP_SECTIONS). Validate up here so a rejection
  // drops cleanly without mutating state, matching the silentPrime gate.
  if (updates.wrapSections !== undefined && updates.wrapSections !== null) {
    if (!Array.isArray(updates.wrapSections)
        || updates.wrapSections.some((s) => !continuity.WRAP_SECTIONS.includes(s))) {
      return {
        project: null,
        errors: [`wrapSections must be null or an array of valid section names (${continuity.WRAP_SECTIONS.join(', ')})`]
      };
    }
  }

  // Per-step wrap overrides. Rejected up here so a bad map drops cleanly
  // without mutating state, matching the gates above. The runner re-checks
  // every field at the point of use — a hand-edited `.tangleclaw/project.json`
  // never passes through this validator, so this is the friendly error, not
  // the safety guarantee.
  if (updates.wrapStepOverrides !== undefined) {
    // Resolve against the code-owned pipeline so a step that must not be
    // disabled is refused here rather than only at wrap time.
    const verdict = wrapStepOverrides.validateOverrides(updates.wrapStepOverrides, wrapDefaultPipeline.steps());
    if (!verdict.ok) {
      return { project: null, errors: [verdict.error] };
    }
  }

  // Launch-mode posture (Phase A settings retask). Validate both fields AND the
  // eyes-open guard up here so a rejection drops cleanly without mutating state,
  // matching the silentPrime gate above.
  if (updates.showLaunchModePicker !== undefined && typeof updates.showLaunchModePicker !== 'boolean') {
    return { project: null, errors: ['showLaunchModePicker must be a boolean'] };
  }
  if (updates.defaultLaunchMode !== undefined) {
    if (typeof updates.defaultLaunchMode !== 'string' || !updates.defaultLaunchMode.trim()) {
      return { project: null, errors: ['defaultLaunchMode must be a non-empty string (an engine launch-mode key)'] };
    }
    // Validate against the *intended* post-update engine (same reasoning as the
    // silentPrime gate: engine + defaultLaunchMode may arrive in one PATCH).
    const intendedEngineId = updates.engine
      || store.projectConfig.load(project.path).engine
      || project.engineId;
    const intendedProfile = intendedEngineId ? store.engines.get(intendedEngineId) : null;
    const modes = intendedProfile && intendedProfile.launchModes;
    if (modes) {
      if (!Object.prototype.hasOwnProperty.call(modes, updates.defaultLaunchMode)) {
        return { project: null, errors: [`defaultLaunchMode "${updates.defaultLaunchMode}" is not a launch mode of engine "${intendedEngineId}" (valid: ${Object.keys(modes).join(', ')})`] };
      }
      // Disabled modes are filtered from every picker/settings surface, so the
      // API must reject them too (symmetric gates) — otherwise a raw PATCH
      // persists a default the launch path then refuses to apply.
      if (modes[updates.defaultLaunchMode].disabled === true) {
        return { project: null, errors: [`defaultLaunchMode "${updates.defaultLaunchMode}" is disabled for engine "${intendedEngineId}"`] };
      }
    } else if (updates.defaultLaunchMode !== 'default') {
      return { project: null, errors: [`engine "${intendedEngineId}" defines no launch modes — defaultLaunchMode can only be 'default'`] };
    }
  }
  // Eyes-open guard: a hidden picker combined with a warning-carrying default
  // mode (bypassPermissions / fullAuto / yesAlways) removes the red
  // isolated-environments warning from the launch flow entirely, so the
  // combination must be confirmed explicitly. Evaluate the POST-update
  // combination — either field alone can create it against the other's stored
  // value — but only when this PATCH touches one of the two fields (a stored
  // combination never blocks unrelated updates; it was confirmed when set).
  if (updates.defaultLaunchMode !== undefined || updates.showLaunchModePicker !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    const effectiveShow = updates.showLaunchModePicker !== undefined
      ? updates.showLaunchModePicker
      : projConfig.showLaunchModePicker !== false;
    const guardEngineId = updates.engine || projConfig.engine || project.engineId;
    const guardProfile = guardEngineId ? store.engines.get(guardEngineId) : null;
    // Judge the mode the engine will actually keep. An explicit update already
    // passed the membership check above, so it reconciles to itself; a stored
    // mode the (possibly newly switched) engine can't honor reconciles to
    // 'default' — matching what the engine-change block persists — so the guard
    // neither lets a stranded mode carry a hidden picker through nor blocks a
    // switch-to-safe that reconciliation renders harmless.
    const requestedMode = updates.defaultLaunchMode !== undefined
      ? updates.defaultLaunchMode
      : (typeof projConfig.defaultLaunchMode === 'string' && projConfig.defaultLaunchMode.trim() ? projConfig.defaultLaunchMode : 'default');
    const effectiveMode = reconcileLaunchMode(requestedMode, guardProfile);
    const modeConfig = guardProfile && guardProfile.launchModes && guardProfile.launchModes[effectiveMode];
    if (effectiveShow === false && modeConfig && modeConfig.warning && updates.confirmBypassHidden !== true) {
      return { project: null, errors: [`hiding the launch-mode picker with default mode "${effectiveMode}" removes its warning from the launch flow — resend with confirmBypassHidden: true to confirm`] };
    }
  }

  // #428: per-project active-plan pick (the priming-roll escape hatch, set by
  // the wrap drawer's inline plan-picker). `null`/`''` clears it; otherwise it
  // must be a BARE `.md` filename that exists under `<project>/.claude/plans/`.
  // Path separators are rejected outright — traversal-safe by construction and
  // matches the picker's contract (candidates are always bare filenames); power
  // users can still hand-edit any form into project.json (read by
  // priming-roll._readActivePlan). Validate up here so a rejection drops
  // cleanly without mutating state, matching the gates above.
  if (updates.activePlan !== undefined
      && updates.activePlan !== null && updates.activePlan !== '') {
    const ap = updates.activePlan;
    if (typeof ap !== 'string') {
      return { project: null, errors: ['activePlan must be a string, null, or ""'] };
    }
    if (ap.includes('/') || ap.includes(path.sep) || path.isAbsolute(ap)) {
      return { project: null, errors: ['activePlan must be a bare plan filename in the project\'s plans directory (no path separators)'] };
    }
    // Validate against the SAME directory the wrap step will resolve, not a
    // hardcoded one. Plans moved out of the engine-owned `.claude/` directory;
    // pinning this validator to the old location would make the operator's
    // escape hatch unsettable for any project following the current rule — the
    // drawer would offer plan candidates whose save is guaranteed to fail.
    const plansDir = require('./wrap-steps/priming-roll')._resolvePlansDir(project.path);
    if (!ap.endsWith('.md') || !plansDir || !fs.existsSync(path.join(plansDir.dir, ap))) {
      const where = plansDir ? plansDir.relative : '.tangleclaw/plans/';
      return { project: null, errors: [`activePlan "${ap}" not found under ${where}`] };
    }
  }

  // Name change — rename directory, DB record, and port leases
  if (updates.name && updates.name !== name) {
    // Block rename if session is active
    const activeSession = store.sessions.getActive(project.id);
    if (activeSession) {
      return { project: null, errors: ['Cannot rename while a session is active'] };
    }
    // Rename collision check is case-insensitive (#221, sibling to #188) —
    // skip the match when the existing row IS the project being renamed
    // (case-only rename like `foo-1` → `Foo-1` is a legitimate operation,
    // even though it case-collides with itself).
    const existing = store.projects.getByNameCaseInsensitive(updates.name);
    if (existing && existing.id !== project.id) {
      const msg = existing.name === updates.name
        ? `Project "${updates.name}" already exists`
        : `Project "${existing.name}" already exists (case-insensitive match for "${updates.name}")`;
      return { project: null, errors: [msg] };
    }
    // Rename directory on disk
    const oldPath = project.path;
    const newPath = path.join(path.dirname(oldPath), updates.name);
    if (fs.existsSync(newPath)) {
      return { project: null, errors: [`Directory "${updates.name}" already exists on disk`] };
    }
    try {
      fs.renameSync(oldPath, newPath);
    } catch (err) {
      return { project: null, errors: [`Failed to rename directory: ${err.message}`] };
    }
    storeUpdates.name = updates.name;
    storeUpdates.path = newPath;
    // Update project.path for subsequent operations in this function
    project.path = newPath;
    const renamed = store.portLeases.renameProject(name, updates.name);
    if (renamed > 0) {
      log.info('Port leases renamed with project', { from: name, to: updates.name, count: renamed });
    }
    log.info('Project directory renamed', { from: oldPath, to: newPath });
  }

  // Engine change
  if (updates.engine && updates.engine !== project.engineId) {
    const engineProfile = store.engines.get(updates.engine);
    if (!engineProfile) {
      return { project: null, errors: [`Engine "${updates.engine}" not found`] };
    }
    storeUpdates.engine_id = updates.engine;

    // Regenerate engine config
    const projConfig = store.projectConfig.load(project.path);
    projConfig.engine = updates.engine;
    // Reconcile a stored defaultLaunchMode the new engine can't honor (e.g.
    // claude's bypassPermissions on a codex project). Left stranded, the launch
    // path later resolves a mode the engine never defined; reset it to the
    // universally-valid interactive default instead. 'default' carries no launch
    // warning, so this can never leave an unconfirmed bypass-hidden posture.
    const reconciled = reconcileLaunchMode(projConfig.defaultLaunchMode, engineProfile);
    if (reconciled !== projConfig.defaultLaunchMode) {
      log.info('Reset stranded defaultLaunchMode on engine switch', {
        project: project.name, engine: updates.engine,
        from: projConfig.defaultLaunchMode, to: reconciled
      });
      projConfig.defaultLaunchMode = reconciled;
    }
    store.projectConfig.save(project.path, projConfig);

    // #240 drift-aware write — surfaces a warning when the on-disk
    // engine config differs from what we're about to write. Catches
    // operator hand-edits being lost during engine switches. `skipped`
    // (deliberate no-op for engines without config files) is NOT an
    // error and must not be pushed.
    const writeResult = engines.writeEngineConfig(updates.engine, project.path, projConfig, engineProfile);
    if (writeResult.error && !writeResult.written && !writeResult.skipped) {
      errors.push(`Failed to write engine config: ${writeResult.error}`);
    }

    // #858 — the previous engine's config file is orphan canon after the
    // switch: unmarked, read by convention, and never regenerated again. Mark
    // it inactive (or say why it was left alone); the same shape the hooks
    // re-sync below applies to a stale hooks block.
    try {
      const retire = engines.retireInactiveEngineConfig(project.path, project.engineId, updates.engine);
      log.info(retire.retired ? 'Previous engine config marked inactive' : 'Previous engine config left alone', {
        project: project.name, from: project.engineId, to: updates.engine, file: retire.file, reason: retire.reason
      });
    } catch (err) {
      log.warn('Failed to retire the previous engine config', { project: project.name, error: err.message });
    }

    // Re-sync hooks so an engine flip away from claude clears any orphan
    // .claude/settings.json SessionStart entry, and a flip onto claude (with
    // silentPrime already true on the project) materializes the correct hook
    // immediately rather than waiting for the next launchSession (#140).
    // Mirrors the silentPrime branch and the project-create /
    // project-attach paths — all hook-affecting mutations call syncEngineHooks
    // on completion (symmetric-capability-gates principle from #103 / #137).
    try {
      // Pass the incoming engine explicitly — the DB row still holds the
      // pre-PATCH engine until the batched store update at the end of this
      // function, so syncEngineHooks' DB-first resolution would act on the
      // old engine (regressing the #140 orphan-hook cleanup).
      engines.syncEngineHooks(project.path, updates.engine);
    } catch (err) {
      log.warn('Failed to sync engine hooks during engine update', { project: project.name, error: err.message });
    }
    // #247 — engine PATCH is a hook-affecting mutation per the Critic's
    // symmetric-capability-gates audit. Re-sync git hooks here too so the
    // PATCH-time gate matches the engine-hooks gate symmetry.
    try {
      gitHooks.syncGitHooks(project.path, store.config.load());
    } catch (err) {
      log.warn('Failed to sync git hooks during engine update', { project: project.name, error: err.message });
    }
  }

  // Tags
  if (updates.tags !== undefined) {
    storeUpdates.tags = updates.tags;
  }

  // Rules update (extensions only — core cannot be disabled)
  if (updates.rules) {
    if (updates.rules.core) {
      // Reject attempt to modify core rules
      const coreDisabled = Object.entries(updates.rules.core).some(([, v]) => v === false);
      if (coreDisabled) {
        return { project: null, errors: ['Core rules cannot be disabled'] };
      }
    }

    const projConfig = store.projectConfig.load(project.path);
    if (updates.rules.extensions) {
      for (const [rule, value] of Object.entries(updates.rules.extensions)) {
        if (projConfig.rules.extensions.hasOwnProperty(rule)) {
          projConfig.rules.extensions[rule] = value;
        }
      }
    }
    store.projectConfig.save(project.path, projConfig);
  }

  // Quick commands
  if (updates.quickCommands !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.quickCommands = updates.quickCommands;
    store.projectConfig.save(project.path, projConfig);
  }

  // Silent prime opt-in (#103) — capability/type validation already happened at the
  // top of this function so we know the value is safe to persist here. Re-sync
  // .claude/settings.json hooks immediately so the SessionStart entry materializes
  // (or disappears) on PATCH rather than waiting until the next session launch
  // (#137). Mirrors the engine branch's pattern.
  if (updates.silentPrime !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.silentPrime = updates.silentPrime;
    store.projectConfig.save(project.path, projConfig);

    try {
      engines.syncEngineHooks(project.path);
    } catch (err) {
      log.warn('Failed to sync engine hooks during silentPrime update', { project: project.name, error: err.message });
    }
    // #247 — silentPrime PATCH is a hook-affecting mutation; re-sync git
    // hooks here too for symmetric-capability-gates parity.
    try {
      gitHooks.syncGitHooks(project.path, store.config.load());
    } catch (err) {
      log.warn('Failed to sync git hooks during silentPrime update', { project: project.name, error: err.message });
    }

    // On silent→typed transition, clear any stale .tangleclaw/session-prime.md so
    // a future relaunch (with silentPrime back on) doesn't replay the old file.
    // Mirrors launchSession's OFF-branch self-heal at lib/sessions.js:171. The
    // helper is a no-op when the file is absent, so unconditional on the false
    // branch is safe.
    if (updates.silentPrime === false) {
      sessions._removePrimeFile(project.path);
    }
  }

  // Feature Index toggle (#207) — type-validated at the top of the function.
  // Persist the flag and, on first toggle-on (any save where new value is true),
  // seed FEATURES.md if the file is absent. The seed helper is idempotent so
  // repeated true-saves do not overwrite hand-authored content; turning the
  // toggle off intentionally does NOT delete FEATURES.md (it remains a
  // git-tracked artifact the user owns).
  if (updates.featureIndexEnabled !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.featureIndexEnabled = updates.featureIndexEnabled;
    store.projectConfig.save(project.path, projConfig);

    if (updates.featureIndexEnabled === true) {
      _seedFeatureIndexFile(project.path);
    }
  }

  // PIDX (#360, #356) — Project Map toggle. Mirrors the Feature Index path:
  // persist the flag, and on toggle-on seed PROJECT-MAP.md if absent (idempotent;
  // turning off does NOT delete the file — it's a git-tracked artifact the user owns).
  if (updates.projectMapEnabled !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.projectMapEnabled = updates.projectMapEnabled;
    store.projectConfig.save(project.path, projConfig);

    if (updates.projectMapEnabled === true) {
      // Slice 2 (#356): seed with the project's current shared-doc group
      // membership. The skeleton + membership are a point-in-time snapshot; the
      // freshness wrap-step (slice 3) keeps them current as membership changes.
      _seedProjectMapFile(project.path, _collectProjectGroups(project.id));
    }
  }

  // #318: persist the version-bump opt-out.
  if (updates.versionBumpEnabled !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.versionBumpEnabled = updates.versionBumpEnabled;
    store.projectConfig.save(project.path, projConfig);
  }

  // Persist the explicit version-file path (validated above). An empty string
  // clears it back to the built-in probe order.
  if (updates.versionFilePath !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    const v = updates.versionFilePath === null ? null : String(updates.versionFilePath).trim();
    projConfig.versionFilePath = v === '' ? null : v;
    store.projectConfig.save(project.path, projConfig);
  }

  // MED-2K9P Chunk 02: persist the Medusa auto-enable pref (validated above). Read
  // at session launch (lib/sessions.js) to auto-start the listener. TC#549 (v2 T3):
  // the toggle also takes effect LIVE — a running session's listener is started/
  // stopped immediately, so the session doesn't stay invisible in every roster
  // until relaunch. The banner control remains the per-session override.
  if (updates.medusaEnabled !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.medusaEnabled = updates.medusaEnabled;
    store.projectConfig.save(project.path, projConfig);
    _syncLiveMedusaListener(project, updates.medusaEnabled);
  }

  // MED-2K9P v2 T2: persist the idle-gated wake opt-in (validated above). Read
  // each monitor tick (lib/medusa-wake.js), so the flag takes effect live — no
  // relaunch needed.
  if (updates.medusaWake !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.medusaWake = updates.medusaWake;
    store.projectConfig.save(project.path, projConfig);
  }

  // Launch-mode posture (validated + guard-checked above). Read by the landing
  // page (picker gate) and by sessions.launchSession (default-mode resolution),
  // so the setting takes effect on the next launch — no regen needed.
  if (updates.defaultLaunchMode !== undefined || updates.showLaunchModePicker !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    if (updates.defaultLaunchMode !== undefined) projConfig.defaultLaunchMode = updates.defaultLaunchMode;
    if (updates.showLaunchModePicker !== undefined) projConfig.showLaunchModePicker = updates.showLaunchModePicker;
    store.projectConfig.save(project.path, projConfig);
  }

  // CC-6 (#381): persist the per-project wrap-section selection (validated above).
  // null clears the override back to the deep default (all 8 sections).
  if (updates.wrapSections !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.wrapSections = updates.wrapSections;
    store.projectConfig.save(project.path, projConfig);
  }

  // Per-step wrap overrides (validated above). `{}` clears every override and
  // returns the project to the default pipeline.
  if (updates.wrapStepOverrides !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.wrapStepOverrides = updates.wrapStepOverrides || {};
    store.projectConfig.save(project.path, projConfig);
  }

  // #428: persist the active-plan pick (validated above). null/'' clears the
  // escape hatch; priming-roll._readActivePlan reads it back next wrap.
  if (updates.activePlan !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    if (updates.activePlan === null || updates.activePlan === '') {
      delete projConfig.activePlan;
    } else {
      projConfig.activePlan = updates.activePlan;
    }
    store.projectConfig.save(project.path, projConfig);
  }

  // Persist store updates
  if (Object.keys(storeUpdates).length > 0) {
    store.projects.update(project.id, storeUpdates);
  }

  const finalName = storeUpdates.name || name;
  const updated = await enrichProject(store.projects.getByName(finalName));
  return { project: updated, errors };
}

// ── Project Deletion ──

/**
 * Delete or archive a project.
 * @param {string} name - Project name
 * @param {object} [options]
 * @param {boolean} [options.deleteFiles] - Delete project directory (default false, archive only)
 * @returns {{ success: boolean, filesDeleted: boolean, errors: string[] }}
 */
function deleteProject(name, options = {}) {
  const project = store.projects.getByName(name);
  if (!project) {
    return { success: false, filesDeleted: false, errors: [`Project "${name}" not found`] };
  }

  const errors = [];

  // Kill any active tmux session
  const tmuxName = tmux.toSessionName(name);
  if (tmux.hasSession(tmuxName)) {
    try {
      tmux.killSession(tmuxName);
    } catch (err) {
      errors.push(`Failed to kill tmux session: ${err.message}`);
    }
  }

  // Release ALL ports registered to this project (not just project.ports)
  try {
    const released = store.portLeases.releaseByProject(name);
    if (released > 0) {
      log.info('Released ports on project delete', { project: name, count: released });
    }
  } catch (err) {
    errors.push(`Failed to release ports: ${err.message}`);
  }

  let filesDeleted = false;
  if (options.deleteFiles && fs.existsSync(project.path)) {
    try {
      // The consolidated per-project continuity store (CC-4) lives under
      // `project.path/.tangleclaw/`, so this recursive remove cascade-deletes
      // the whole store (uploads, wraps, index, changelog) by construction —
      // project delete is the only automated store delete, per the Continuity
      // Contract. When deleteFiles is false the store is deliberately preserved
      // alongside the kept files (it's gitignored local continuity state).
      fs.rmSync(project.path, { recursive: true, force: true });
      filesDeleted = true;
    } catch (err) {
      errors.push(`Failed to delete project files: ${err.message}`);
    }
  }

  // Remove from SQLite (cascades sessions, learnings)
  store.projects.delete(project.id);

  log.info('Project deleted', { name, filesDeleted });
  return { success: true, filesDeleted, errors };
}

// ── Auto-Detection ──

/**
 * Scan the projects directory for candidate projects that aren't registered.
 * Detects TangleClaw and Prawduct markers and REPORTS what it finds.
 *
 * It reports; it does not register. The previous sentence here said
 * "auto-registers what it finds", which was wrong and outlived whatever it
 * once described — this returns `{detected, errors}`, writes nothing, and has
 * no production caller today.
 *
 * The running TangleClaw checkout is excluded (#920) — see the exclusion
 * comment inline.
 *
 * NOTE (#859): this scans the same operator-chosen projects directory with a
 * SYNCHRONOUS readdir — the defect fixed in `listAllProjects`. A TCC-protected
 * path on macOS does not error, it never returns, and on the event loop that
 * stops the whole server. Left as-is only because every caller today is a test;
 * wiring this to a route without converting it to the bounded async form above
 * reintroduces the wedge silently.
 *
 * @param {object} [options] - Options.
 * @param {string} [options.ownInstallRealPath] - Realpath of the checkout to
 *   exclude. Defaults to this process's own. Injectable for the same reason
 *   `scanDirectoryForProjects` passes it to its child: the exclusion is only
 *   testable against a directory a test is allowed to create, and pointing a
 *   synchronous readdir at the real install's parent to exercise it would walk
 *   the operator's actual projects directory — the TCC-protected path this
 *   function's own note says never returns.
 * @returns {{ detected: object[], errors: string[] }}
 */
function detectExistingProjects(options = {}) {
  const ownInstallRealPath = options.ownInstallRealPath || OWN_INSTALL_REALPATH;
  const config = store.config.load();
  const projectsDir = resolveProjectsDir(config.projectsDir);

  if (!fs.existsSync(projectsDir)) {
    return { detected: [], errors: [] };
  }

  const detected = [];
  const errors = [];

  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (err) {
    return { detected: [], errors: [`Failed to read projects directory: ${err.message}`] };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const dirPath = path.join(projectsDir, entry.name);

    // Skip if already registered — case-insensitive so the filesystem-scan
    // doesn't surface a `Web-API` directory as "unregistered" when DB has
    // `web-api` registered (#221).
    const existing = store.projects.getByNameCaseInsensitive(entry.name);
    if (existing) continue;

    // Two markers say "this directory is a managed project": TangleClaw's own
    // config, and a Prawduct governance directory (a repo can be governed
    // before TC ever registers it).
    const hasTangleclawConfig = fs.existsSync(path.join(dirPath, '.tangleclaw', 'project.json'));
    const hasPrawductDir = fs.existsSync(path.join(dirPath, '.prawduct'));

    if (hasTangleclawConfig || hasPrawductDir) {
      // The running TangleClaw checkout never offers itself (#920 — the other
      // member of the #708 family). The README's install steps put the clone
      // wherever the operator happens to be, which is routinely the folder
      // they then name as their projects directory, and the clone carries both
      // markers — so a scan would hand the tool itself back as a candidate.
      //
      // The harm is what a CALLER would then do with it. #708's own scan fed
      // a pre-checked wizard box that attached the clone as the operator's
      // first project, writing per-project config into it — which dirties the
      // checkout and strands the self-updater behind its dirty-tree guard.
      // This function only reports, and today only tests call it; excluding
      // here means the next caller wired to it cannot reintroduce that, rather
      // than describing damage this function does on its own.
      //
      // Compared by realpath so a symlinked projects directory cannot smuggle
      // the install past a string compare, and done only for entries that
      // already matched a marker — this function is synchronous (see the note
      // above), so the per-entry cost stays off the common path.
      //
      // Attaching this checkout DELIBERATELY (developing TangleClaw with
      // TangleClaw) stays possible through the normal attach flow, which does
      // not pass through detection.
      let realDirPath;
      try {
        realDirPath = fs.realpathSync(dirPath);
      } catch {
        realDirPath = dirPath;
      }
      if (realDirPath === ownInstallRealPath) {
        log.debug('Detection excluded the running install from candidates', {
          path: dirPath, scannedDir: projectsDir
        });
        continue;
      }

      detected.push({
        name: entry.name,
        path: dirPath,
        hasTangleclawConfig
      });
    }
  }

  return { detected, errors };
}

// ── Helpers ──

/**
 * Resolve the projects directory path, expanding ~ to home dir.
 * @param {string} dir - Projects directory (may start with ~)
 * @returns {string}
 */
function resolveProjectsDir(dir) {
  if (dir.startsWith('~')) {
    return path.join(process.env.HOME || '', dir.slice(1));
  }
  return path.resolve(dir);
}

/**
 * Archive a project (soft-delete). Blocks future sync and session launch.
 * @param {string} name - Project name
 * @returns {{ success: boolean, errors: string[] }}
 */
function archiveProject(name) {
  const project = store.projects.getByName(name);
  if (!project) {
    return { success: false, errors: [`Project "${name}" not found`] };
  }
  if (project.archived) {
    return { success: false, errors: [`Project "${name}" is already archived`] };
  }
  // Block if session is active
  const activeSession = store.sessions.getActive(project.id);
  if (activeSession) {
    return { success: false, errors: ['Cannot archive while a session is active'] };
  }
  store.projects.archive(project.id);
  log.info('Project archived', { name, id: project.id });
  return { success: true, errors: [] };
}

/**
 * Unarchive (restore) an archived project.
 * @param {string} name - Project name
 * @returns {{ success: boolean, errors: string[] }}
 */
function unarchiveProject(name) {
  const project = store.projects.getByName(name);
  if (!project) {
    // Archived projects are excluded from default list — search with archived flag
    const allProjects = store.projects.list({ archived: true });
    const found = allProjects.find(p => p.name === name);
    if (!found) {
      return { success: false, errors: [`Project "${name}" not found`] };
    }
    store.projects.unarchive(found.id);
    log.info('Project unarchived', { name, id: found.id });
    return { success: true, errors: [] };
  }
  if (!project.archived) {
    return { success: false, errors: [`Project "${name}" is not archived`] };
  }
  store.projects.unarchive(project.id);
  log.info('Project unarchived', { name, id: project.id });
  return { success: true, errors: [] };
}

/**
 * Migrate a project to V2-plugin governance (#262, C1) — the cohort-aware,
 * session-safe orchestrator over `engines.migrateToPlugin`.
 *
 * - **Cohort C (non-Claude):** the Claude-only plugin cannot serve it →
 *   `migrationStatus = 'not-applicable'`, no settings mutation.
 * - **Session-safety:** if the project has a live session (`active`/`wrapping`,
 *   via the #347 ownership primitive) the migration **defers** — no mutation,
 *   no status change. Never auto-close a session; explicit operator action only.
 * - **Idempotent:** an already-governed project is recorded `migrated`, no write.
 * - **Activation honesty:** on success the status is `migrated` only if the
 *   plugin is installed at machine scope; otherwise `pending-activation` (the
 *   reference is written but a fresh machine still needs `/plugin install`).
 *
 * @param {string} name - Project name
 * @returns {Promise<{ project: object|null, status: string|null, migrated: boolean,
 *   deferred?: boolean, alreadyGoverned?: boolean, reason?: string, error?: string }>}
 */
async function migrateProjectToPlugin(name) {
  const project = store.projects.getByName(name);
  if (!project) {
    return { project: null, status: null, migrated: false, error: `Project "${name}" not found` };
  }

  // Cohort C — non-Claude engines can't run the Claude-only plugin.
  if (project.engineId !== 'claude') {
    if (project.migrationStatus !== 'not-applicable') {
      store.projects.update(project.id, { migration_status: 'not-applicable' });
    }
    return {
      project: await enrichProject(store.projects.get(project.id)),
      status: 'not-applicable',
      migrated: false,
      reason: `engine "${project.engineId}" cannot run the Claude-only V2 plugin`
    };
  }

  // Session-safety — never mutate governance config under a session that
  // might be live. `resolveByProject` returns an ownership object for any
  // active/wrapping DB row, so gate on its computed `.live` flag (a real tmux
  // pane probe for local; db-status for remote) — a stale row whose pane is
  // CONFIRMED gone must NOT falsely defer the migration (same phantom-tab
  // class as #340).
  //
  // `live === null` means the probe could not establish anything, and this is
  // a caller about to ACT, so it takes the opposite branch from the read-only
  // consumers: rewriting governance config out from under a running agent is
  // real damage, while deferring costs a retry. An unknown defers.
  const owner = sessionOwnership.resolveByProject(project.name);
  if (owner && owner.live !== false) {
    const established = owner.live === true;
    // The unknown branch is logged at WARN because it is not the same event as
    // a normal defer: the migration did not run, `migration_status` is left
    // untouched by design, and the only other trace is a response body a
    // caller may discard. Without this line the operator sees a migration that
    // silently never happened, with the cause (a wedged tmux) recorded only as
    // an unrelated-looking timeout somewhere further up the log.
    if (established) {
      log.debug('Migration deferred — project has a live session', { project: project.name });
    } else {
      log.warn('Migration deferred — could not establish whether the project has a live session', {
        project: project.name,
        cause: owner.livenessCause || 'unknown',
        incomplete: owner.incomplete || []
      });
    }
    return {
      project: await enrichProject(project),
      status: project.migrationStatus || null,
      migrated: false,
      deferred: true,
      reason: established
        ? 'project has a live session — migrate after it ends (never auto-closed)'
        : `could not establish whether this project has a live session (${owner.livenessCause || 'tmux did not answer'}) — not migrating under a session that might be running`
    };
  }

  // Idempotent — already governed.
  if (engines.isPluginGoverned(project.path)) {
    if (project.migrationStatus !== 'migrated') {
      store.projects.update(project.id, { migration_status: 'migrated' });
    }
    return {
      project: await enrichProject(store.projects.get(project.id)),
      status: 'migrated',
      migrated: false,
      alreadyGoverned: true
    };
  }

  const result = engines.migrateToPlugin(project.path);
  if (result.error) {
    return {
      project: await enrichProject(project),
      status: project.migrationStatus || null,
      migrated: false,
      error: result.error
    };
  }

  const status = engines.pluginInstalledAtMachineScope() ? 'migrated' : 'pending-activation';
  store.projects.update(project.id, { migration_status: status });
  log.info('Project migrated to V2 plugin (#262)', { project: project.name, status });
  return {
    project: await enrichProject(store.projects.get(project.id)),
    status,
    migrated: true
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  checkDeletePassword,
  migrateProjectToPlugin,
  validateName,
  createProject,
  enrichProject,
  listProjects,
  syncAllProjects,
  listAllProjects,
  // Exported for tests: the deadline is what turns a path that never answers
  // into an answered request, and `tcTimedOut` is what lets the caller name the
  // real cause. Both need pinning directly.
  _scanFailureHint,
  scanDirectoryForProjects,
  createProjectsDir,
  attachProject,
  getProject,
  getProjectRow,
  updateProject,
  deleteProject,
  archiveProject,
  unarchiveProject,
  detectExistingProjects,
  resolveProjectsDir,
  scanForOrphanHooks,
  repairOrphanHooks,
  scanForStrandedConfigs,
  // Stranded-config helper (#592) — exposed for direct unit testing
  _findStrandedAncestorConfigs,
  // Version detection helpers (#55) — exposed for direct unit testing
  _detectProjectVersion,
  _detectLiveVersion,
  _writeVersionCacheFile,
  _readVersionCacheFile,
  _readChangelogVersion,
  _readVersionJsonVersion,
  _readPackageJsonVersion,
  // Orphan-hook helpers (#145, chunk 2) — exposed for direct unit testing
  _extractClaudeProjectDirPaths,
  _hookEntryOrphanMissing,
  // Feature Index (#207, chunk 1) — exposed for direct unit testing
  _seedFeatureIndexFile,
  FEATURE_INDEX_FILENAME,
  FEATURE_INDEX_TEMPLATE,
  // Project Map (PIDX #360, #356) — exposed for direct unit testing
  _seedProjectMapFile,
  _listTopLevelDirs,
  _buildProjectMapContent,
  _buildSharedDirsSection,
  _collectProjectGroups,
  // Project Map freshness (PIDX slice 3, #360, #356) — exposed for the
  // wrap-step + direct unit testing
  _refreshProjectMapContent,
  _parseStructureDirs,
  _replaceSectionBody,
  _mergeStructureBody,
  PROJECT_MAP_FILENAME
};
