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
const { createLogger } = require('./logger');

const log = createLogger('projects');

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
 * Render the "Shared directories / doc groups" section body from a project's
 * shared-doc group membership (PIDX slice 2, #356). Pure — takes the already-
 * collected `groups` shape, no store access.
 *
 * @param {Array<{name:string, sharedDir:string|null, docs:Array<{name:string}>}>} groups
 * @returns {string} Markdown for the section body.
 */
function _buildSharedDirsSection(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return '<!-- This project is not a member of any shared-doc group. -->';
  }
  return groups.map((g) => {
    const dir = g.sharedDir ? `\`${g.sharedDir}\`` : '_(no shared directory)_';
    const docs = Array.isArray(g.docs) && g.docs.length > 0
      ? g.docs.map((d) => `  - \`${d.name}\``).join('\n')
      : '  - _(no docs registered)_';
    return `- **${g.name}** → ${dir}\n${docs}`;
  }).join('\n');
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

  // Validate engine exists
  const engineId = data.engine || config.defaultEngine || 'claude';
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
 * Read a UTF-8 text file and normalize it: strip any leading byte order
 * mark (files produced on Windows or exported from some editors begin
 * with U+FEFF, which breaks anchored regexes and `JSON.parse`), and
 * convert CRLF line endings to LF so per-line regexes don't have to
 * account for trailing `\r`.
 * We normalize at the read boundary so every helper can assume clean content.
 * @param {string} filePath - Absolute path to the file
 * @returns {string|null} - Normalized file contents, or null if missing
 */
function _readTextFileNoBom(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
}

/**
 * Read the project's version cache file (`.tangleclaw/project-version.txt`).
 * Format is plain key:value lines:
 *   version: 3.12.7
 *   recorded_at: 2026-04-10T20:34:12Z
 *   source: CHANGELOG.md
 * Only the `version` line is required; others are advisory.
 *
 * Written by two TC-side writers, both producing identical key:value output:
 *   - `lib/project-version.js:recordVersion` — fires at session launch/wrap
 *     (#101). Has a richer detection chain that includes git-tag fallback.
 *   - `lib/projects.js:_writeVersionCacheFile` — fires from
 *     `_detectProjectVersion`'s read-time self-heal when live disagrees with
 *     cached (#165). Chain is CHANGELOG.md → a configured `versionFilePath` →
 *     version.json → package.json; the git-tag fallback is the one rung it
 *     deliberately lacks, which is why a null live read preserves the cache.
 *
 * @param {string} projectPath - Absolute project root path
 * @returns {string|null} - Cached version string, or null if missing/invalid
 */
function _readVersionCacheFile(projectPath) {
  try {
    const cachePath = path.join(projectPath, '.tangleclaw', 'project-version.txt');
    const content = _readTextFileNoBom(cachePath);
    if (content === null) return null;
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*version\s*:\s*(.*)$/i);
      if (!m) continue;
      const value = m[1].trim();
      if (value) return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the project's first released version from CHANGELOG.md.
 * Looks for the first `## [X.Y.Z]` header that is NOT `[Unreleased]` and
 * matches a version-ish format (optional `v` prefix, then `digit.digit`
 * minimum). This rejects date-style headers (`## [2026-03-31]`) which some
 * projects use — those are not versions.
 * Handles Keep-a-Changelog format used across TangleClaw projects.
 * Accepted examples: `3.12.7`, `0.3.0`, `0.6.9-beta`, `v1.0.0`, `2.0.0-rc1`
 * Rejected examples: `Unreleased`, `2026-03-31`, `March 2026`, `TBD`
 * @param {string} projectPath - Absolute project root path
 * @returns {string|null} - Released version string, or null if no released entries
 */
function _readChangelogVersion(projectPath) {
  try {
    const changelogPath = path.join(projectPath, 'CHANGELOG.md');
    const content = _readTextFileNoBom(changelogPath);
    if (content === null) return null;
    // Version must start with optional `v`, then `digit.digit` at minimum.
    // This rejects date headers like `2026-03-31` (no dot after year segment).
    const VERSION_SHAPE = /^v?\d+\.\d+/;
    for (const line of content.split('\n')) {
      const m = line.match(/^##\s*\[([^\]]+)\]/);
      if (!m || !m[1]) continue;
      const candidate = m[1].trim();
      if (candidate.toLowerCase() === 'unreleased') continue;
      if (!VERSION_SHAPE.test(candidate)) continue;
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the project's version from a `version.json` file at the project root.
 * Convention used by TangleClaw itself. Only accepts a string `version` field
 * — non-string values (numbers, objects, arrays) are rejected defensively.
 * @param {string} projectPath - Absolute project root path
 * @returns {string|null}
 */
function _readVersionJsonVersion(projectPath) {
  try {
    const verPath = path.join(projectPath, 'version.json');
    const content = _readTextFileNoBom(verPath);
    if (content === null) return null;
    const data = JSON.parse(content);
    return data && typeof data.version === 'string' && data.version.trim()
      ? data.version
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the project's version from a `package.json` at the project root.
 * Convention used by Node projects. Only accepts a string `version` field.
 * @param {string} projectPath - Absolute project root path
 * @returns {string|null}
 */
function _readPackageJsonVersion(projectPath) {
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    const content = _readTextFileNoBom(pkgPath);
    if (content === null) return null;
    const pkg = JSON.parse(content);
    return pkg && typeof pkg.version === 'string' && pkg.version.trim()
      ? pkg.version
      : null;
  } catch {
    return null;
  }
}

/**
 * Detect a project's current version from on-disk sources only (no cache).
 * Walks CHANGELOG.md → a configured `versionFilePath` → version.json →
 * package.json in priority order and returns `{ version, source }` from the
 * first hit, or null if none match. `source` is the reader that hit, which for
 * the configured rung is that file's basename rather than a fixed label.
 *
 * Mirrors the live half of `_detectProjectVersion`'s chain; extracted so the
 * self-heal path (#165) can compare cached vs live values and know which
 * source the live read came from for the `source:` label.
 *
 * Note: does NOT include git-tag detection. `lib/project-version.js:recordVersion`
 * adds git-tag as a fallback in its own chain; the cache file may carry a
 * git-tag-derived value that the live readers here cannot reproduce — which
 * is exactly why `_detectProjectVersion` preserves the cache when live is null.
 *
 * @param {string} projectPath - Absolute project root path
 * @returns {{ version: string, source: string }|null}
 */
function _detectLiveVersion(projectPath) {
  const fromChangelog = _readChangelogVersion(projectPath);
  if (fromChangelog) return { version: fromChangelog, source: 'CHANGELOG.md' };

  // Delegated, not re-implemented: this ladder and `project-version.js`'s must
  // agree on where a project says its version lives, or the #165 self-heal here
  // overwrites the cache that one wrote from the configured file and stamps a
  // false `source`. They still differ in their tail — that one falls back to a
  // git tag, this one deliberately does not — which is why this is a shared
  // rung rather than a shared ladder.
  const projectVersion = require('./project-version'); // lazy — sibling reads projects.js
  const fromConfigured = projectVersion._readConfiguredVersion(projectPath);
  if (fromConfigured) return fromConfigured;

  const fromVersionJson = _readVersionJsonVersion(projectPath);
  if (fromVersionJson) return { version: fromVersionJson, source: 'version.json' };

  const fromPackageJson = _readPackageJsonVersion(projectPath);
  if (fromPackageJson) return { version: fromPackageJson, source: 'package.json' };

  return null;
}

/**
 * Best-effort write of `.tangleclaw/project-version.txt`. Mirrors the file
 * format produced by `lib/project-version.js:_formatCacheFile` so the same
 * cache reader (`_readVersionCacheFile`) parses both writers' output without
 * ambiguity. Creates `.tangleclaw/` if missing.
 *
 * Used by `_detectProjectVersion`'s #165 self-heal path. Never throws —
 * logs at warn on failure and returns false so the caller can continue to
 * serve the live value without crashing enrichment for read-only-filesystem
 * or permission-denied scenarios.
 *
 * @param {string} projectPath - Absolute project root path
 * @param {string} version - Detected live version string to record
 * @param {string} source - Source label (e.g. `'CHANGELOG.md'`, `'version.json'`)
 * @returns {boolean} - True on success, false on any write failure
 */
function _writeVersionCacheFile(projectPath, version, source) {
  try {
    const dir = path.join(projectPath, '.tangleclaw');
    const file = path.join(dir, 'project-version.txt');
    const recordedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const body = `version: ${version}\nrecorded_at: ${recordedAt}\nsource: ${source}\n`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
    return true;
  } catch (err) {
    log.warn('Failed to self-heal project-version cache', { projectPath, error: err.message });
    return false;
  }
}

/**
 * Detect a project's current version using the universal detection chain
 * with read-time self-heal (#165).
 *
 * Strategy:
 *   1. Read the cached value (`.tangleclaw/project-version.txt`).
 *   2. Read the live value from on-disk sources (CHANGELOG → a configured
 *      `versionFilePath` → version.json → package.json).
 *   3. If live is present AND differs from cached, rewrite the cache and return live.
 *   4. If live is present AND matches cached, return cached (no rewrite).
 *   5. If live is null (no source files match), return cached — preserves
 *      git-tag-derived or fallback values that `recordVersion` may have written
 *      via the richer chain in `lib/project-version.js`. Accepted trade-off
 *      (Critic N2): a project whose live sources all vanished — CHANGELOG.md,
 *      a configured version file, version.json, package.json — keeps showing
 *      the pre-deletion value until the next
 *      session launch's `recordVersion` rewrites the cache with the fallback
 *      source. The alternative (clobber-on-null-live) would regress every
 *      git-tag-only project on each enrichment, which is worse.
 *   6. If both are null, return null.
 *
 * Pre-#165 behavior was cache-first with no self-heal — external version bumps
 * (release-PR merges via `gh`, `git pull`, manual `version.json` edits) left
 * the dashboard label stuck on the pre-bump value until the next session
 * launch/wrap (the only triggers that called `recordVersion`). The self-heal
 * closes that gap on every enrichment without introducing extra triggers.
 *
 * See issue #55 for the original cache design, #165 for the self-heal addition.
 *
 * @param {string} projectPath - Absolute project root path
 * @returns {string|null}
 */
function _detectProjectVersion(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return null;

  const cached = _readVersionCacheFile(projectPath);
  const live = _detectLiveVersion(projectPath);

  if (live) {
    if (live.version !== cached) {
      _writeVersionCacheFile(projectPath, live.version, live.source);
    }
    return live.version;
  }

  return cached;
}

// ── Project Enrichment ──

/**
 * Enrich a project record with git info, session status, and engine info.
 * @param {object} project - Project record from store
 * @returns {object} - Enriched project
 */
function enrichProject(project) {
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
      const det = engines.detectEngine(engineProfile);
      engine = {
        id: project.engineId,
        name: engineProfile.name,
        available: det.available,
        capabilities: engineProfile.capabilities || {}
      };
    }
  }

  // Session info — include both active and wrapping sessions (only if tmux is alive)
  let session = null;
  const activeSession = store.sessions.getActive(project.id);
  if (activeSession) {
    // Only report as active if tmux session is actually alive
    const tmuxAlive = !activeSession.tmuxSession || tmux.hasSession(activeSession.tmuxSession);
    if (tmuxAlive) {
      session = {
        active: true,
        status: activeSession.status,
        startedAt: activeSession.startedAt,
        tmuxSession: activeSession.tmuxSession
      };
    }
    // If tmux is dead, don't report — getSessionStatus() will clean up the DB state
  } else {
    const wrappingSession = store.sessions.getWrapping(project.id);
    if (wrappingSession) {
      const tmuxAlive = wrappingSession.tmuxSession && tmux.hasSession(wrappingSession.tmuxSession);
      if (tmuxAlive) {
        session = {
          active: true,
          status: 'wrapping',
          startedAt: wrappingSession.startedAt,
          tmuxSession: wrappingSession.tmuxSession
        };
      }
      // If tmux is dead, don't report as active — let launch/status clean up
    }
  }

  // Git info
  let gitInfo = null;
  if (fs.existsSync(project.path)) {
    gitInfo = git.getInfo(project.path);
  }

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

  // Project version — universal detection chain (see #55)
  const version = _detectProjectVersion(project.path);

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
    const projConfig = store.projectConfig.load(project.path);
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
    actions: actions.availableActions(project),
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
    // A directory that isn't there can't be inspected → not-applicable.
    governanceState: fs.existsSync(project.path)
      ? engines.governanceState(project.path, { engineId: project.engineId })
      : 'not-applicable'
  };
}

/**
 * List all projects, enriched with metadata.
 * @param {object} [options] - Filter options passed to store.projects.list
 * @returns {object[]}
 */
function listProjects(options = {}) {
  const projects = store.projects.list(options);
  return projects.map(enrichProject);
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
      const engineId = project.engineId || 'claude';
      const engineProfile = store.engines.get(engineId);
      if (engineProfile && engineProfile.configFormat) {
        engines.writeEngineConfig(engineId, project.path, projConfig, engineProfile);
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
//   (e.g. the silentPrime hook's `/Users/.../sessionstart-prime.sh`) are not
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
 * List all projects: merge SQLite-registered projects with ALL filesystem directories.
 * Unregistered dirs get { registered: false } entries with basic git info.
 * @param {object} [options] - Filter options passed to store.projects.list for registered projects
 * @returns {object[]}
 */
function listAllProjects(options = {}) {
  const registered = listProjects(options);
  const registeredNames = new Set(registered.map(p => p.name));

  // Also track archived project names so they don't appear as unregistered filesystem dirs
  const allRegistered = store.projects.list({ archived: true });
  const allRegisteredNames = new Set(allRegistered.map(p => p.name));

  const config = store.config.load();
  const projectsDir = resolveProjectsDir(config.projectsDir);

  if (!fs.existsSync(projectsDir)) {
    return registered.map(p => ({ ...p, registered: true }));
  }

  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return registered.map(p => ({ ...p, registered: true }));
  }

  const unregistered = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (allRegisteredNames.has(entry.name)) continue;

    const dirPath = path.join(projectsDir, entry.name);

    // Basic git info
    let gitInfo = null;
    try {
      gitInfo = git.getInfo(dirPath);
    } catch {
      // Not a git repo or git not available
    }

    // Check for TangleClaw config
    const hasTangleclawConfig = fs.existsSync(path.join(dirPath, '.tangleclaw', 'project.json'));

    unregistered.push({
      id: null,
      name: entry.name,
      path: dirPath,
      registered: false,
      engine: null,
      tags: [],
      ports: {},
      session: null,
      git: gitInfo,
      status: null,
      hasTangleclawConfig,
      createdAt: null,
      updatedAt: null,
      archived: false
    });
  }

  const result = registered.map(p => ({ ...p, registered: true }));
  return [...result, ...unregistered].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}

/**
 * Attach an existing filesystem directory as a registered project.
 * Reads an existing .tangleclaw/project.json if present.
 * @param {string} name - Directory name in projectsDir
 * @returns {{ project: object|null, errors: string[] }}
 */
function attachProject(name) {
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
  let engineId = config.defaultEngine || 'claude';

  if (fs.existsSync(projConfigPath)) {
    try {
      const existingConfig = JSON.parse(fs.readFileSync(projConfigPath, 'utf8'));
      if (existingConfig.engine) engineId = existingConfig.engine;
    } catch (err) {
      errors.push(`Failed to read existing project.json: ${err.message}`);
    }
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
  return { project: enrichProject(project), errors };
}

/**
 * Get a single project by name, enriched.
 * @param {string} name - Project directory name
 * @returns {object|null}
 */
function getProject(name) {
  const project = store.projects.getByName(name);
  if (!project) return null;
  return enrichProject(project);
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
 * Update project configuration (engine, tags, rules).
 * @param {string} name - Project name
 * @param {object} updates - Fields to update
 * @returns {{ project: object|null, errors: string[] }}
 */
function updateProject(name, updates) {
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
    const effectiveMode = updates.defaultLaunchMode !== undefined
      ? updates.defaultLaunchMode
      : (typeof projConfig.defaultLaunchMode === 'string' && projConfig.defaultLaunchMode.trim() ? projConfig.defaultLaunchMode : 'default');
    const effectiveShow = updates.showLaunchModePicker !== undefined
      ? updates.showLaunchModePicker
      : projConfig.showLaunchModePicker !== false;
    const guardEngineId = updates.engine || projConfig.engine || project.engineId;
    const guardProfile = guardEngineId ? store.engines.get(guardEngineId) : null;
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
  const updated = enrichProject(store.projects.getByName(finalName));
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
 * Scan the projects directory for existing projects that aren't registered.
 * Detects TangleClaw and Prawduct markers and auto-registers what it finds.
 * @returns {{ detected: object[], errors: string[] }}
 */
function detectExistingProjects() {
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
    // doesn't surface a `Monad-1` directory as "unregistered" when DB has
    // `monad-1` registered (#221).
    const existing = store.projects.getByNameCaseInsensitive(entry.name);
    if (existing) continue;

    // Two markers say "this directory is a managed project": TangleClaw's own
    // config, and a Prawduct governance directory (a repo can be governed
    // before TC ever registers it).
    const hasTangleclawConfig = fs.existsSync(path.join(dirPath, '.tangleclaw', 'project.json'));
    const hasPrawductDir = fs.existsSync(path.join(dirPath, '.prawduct'));

    if (hasTangleclawConfig || hasPrawductDir) {
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
 * @returns {{ project: object|null, status: string|null, migrated: boolean,
 *   deferred?: boolean, alreadyGoverned?: boolean, reason?: string, error?: string }}
 */
function migrateProjectToPlugin(name) {
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
      project: enrichProject(store.projects.get(project.id)),
      status: 'not-applicable',
      migrated: false,
      reason: `engine "${project.engineId}" cannot run the Claude-only V2 plugin`
    };
  }

  // Session-safety — never mutate governance config under a CONFIRMED-live
  // session. `resolveByProject` returns an ownership object for any active/
  // wrapping DB row, so gate on its computed `.live` flag (a real tmux pane
  // probe for local; db-status for remote) — a stale row whose pane is gone
  // must NOT falsely defer the migration (same phantom-tab class as #340).
  const owner = sessionOwnership.resolveByProject(project.name);
  if (owner && owner.live) {
    return {
      project: enrichProject(project),
      status: project.migrationStatus || null,
      migrated: false,
      deferred: true,
      reason: 'project has a live session — migrate after it ends (never auto-closed)'
    };
  }

  // Idempotent — already governed.
  if (engines.isPluginGoverned(project.path)) {
    if (project.migrationStatus !== 'migrated') {
      store.projects.update(project.id, { migration_status: 'migrated' });
    }
    return {
      project: enrichProject(store.projects.get(project.id)),
      status: 'migrated',
      migrated: false,
      alreadyGoverned: true
    };
  }

  const result = engines.migrateToPlugin(project.path);
  if (result.error) {
    return {
      project: enrichProject(project),
      status: project.migrationStatus || null,
      migrated: false,
      error: result.error
    };
  }

  const status = engines.pluginInstalledAtMachineScope() ? 'migrated' : 'pending-activation';
  store.projects.update(project.id, { migration_status: status });
  log.info('Project migrated to V2 plugin (#262)', { project: project.name, status });
  return {
    project: enrichProject(store.projects.get(project.id)),
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
  attachProject,
  getProject,
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
