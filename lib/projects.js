'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const git = require('./git');
const engines = require('./engines');
const methodologies = require('./methodologies');
const tmux = require('./tmux');
const sessions = require('./sessions');
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

Format: - **Name** — short description. file.js:line, file2.js:line.
-->

## UI / Web

## Server / API

## Methodologies / Engines

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
 * Create a new project: validate → create directory → scaffold → init methodology →
 * register ports → generate engine config → persist to SQLite.
 * @param {object} data - Project creation data
 * @param {string} data.name - Project directory name
 * @param {string} [data.engine] - Engine profile id
 * @param {string} [data.methodology] - Methodology template id
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

  // Every project has a methodology — `minimal` is the no-workflow methodology
  // per docs/methodology-guide.md. Previously a `data.methodology === null`
  // branch propagated null into projConfig, but the DB schema (NOT NULL DEFAULT
  // 'minimal') always wrote 'minimal' anyway, leaving a split-brain. #151
  // resolved this in favor of 'minimal' across both sources of truth. See
  // ADR 0001 (`docs/adr/0001-symmetric-capability-gates.md`).
  const methodologyId = data.methodology || config.defaultMethodology || 'minimal';
  const methodologyTemplate = store.templates.get(methodologyId);
  if (!methodologyTemplate) {
    return { project: null, errors: [`Methodology "${methodologyId}" not found`] };
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

  // Initialize methodology — every project has one (#151)
  log.debug('Initializing methodology', { template: methodologyId, project: data.name, path: projectPath });
  const initResult = methodologies.initialize(projectPath, methodologyId, {
    projectName: data.name
  });
  log.debug('Methodology init result', { success: initResult.success, created: initResult.created, errors: initResult.errors });
  if (!initResult.success) {
    errors.push(...initResult.errors);
  }

  // Write per-project config
  const projectConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
  projectConfig.engine = engineId;
  projectConfig.methodology = methodologyId;
  if (data.tags) projectConfig.tags = data.tags;

  // Apply methodology default rules (normalize object form to boolean for project config)
  if (methodologyTemplate && methodologyTemplate.defaultRules) {
    for (const [rule, value] of Object.entries(methodologyTemplate.defaultRules)) {
      if (projectConfig.rules.extensions.hasOwnProperty(rule)) {
        projectConfig.rules.extensions[rule] = (typeof value === 'object' && value !== null) ? !!value.enabled : !!value;
      }
    }
  }

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
  // openclaw, genesis). Only surface real `error` strings.
  const writeResult = engines.writeEngineConfig(engineId, projectPath, projectConfig, engineProfile, methodologyTemplate);
  if (writeResult.error && !writeResult.written && !writeResult.skipped) {
    errors.push(`Failed to write engine config: ${writeResult.error}`);
  }

  // Sync engine hooks to match methodology
  try {
    engines.syncEngineHooks(projectPath, methodologyTemplate);
  } catch (err) {
    log.warn('Failed to sync engine hooks during project creation', { error: err.message });
  }

  // Persist to SQLite
  const project = store.projects.create({
    name: data.name,
    path: projectPath,
    engine: engineId,
    methodology: methodologyId,
    tags: data.tags || [],
    ports: {}
  });

  log.info('Project created', { name: data.name, path: projectPath, engine: engineId, methodology: methodologyId });
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
 *     cached (#165). Chain is CHANGELOG.md → version.json → package.json only.
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
 * Walks CHANGELOG.md → version.json → package.json in priority order and
 * returns `{ version, source }` from the first hit, or null if none match.
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
 *   2. Read the live value from on-disk sources (CHANGELOG → version.json → package.json).
 *   3. If live is present AND differs from cached, rewrite the cache and return live.
 *   4. If live is present AND matches cached, return cached (no rewrite).
 *   5. If live is null (no source files match), return cached — preserves
 *      git-tag-derived or fallback values that `recordVersion` may have written
 *      via the richer chain in `lib/project-version.js`. Accepted trade-off
 *      (Critic N2): a project whose CHANGELOG.md / version.json / package.json
 *      was deleted will keep showing the pre-deletion value until the next
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
 * Enrich a project record with git info, session status, methodology status, engine info.
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

  // Methodology info
  let methodology = null;
  const methodologyTemplate = store.templates.get(project.methodology);
  if (methodologyTemplate) {
    const projConfig = store.projectConfig.load(project.path);
    methodology = {
      id: project.methodology,
      name: methodologyTemplate.name,
      phase: projConfig.methodologyPhase || null,
      // #139 Chunk 11b — surface methodology-declared action buttons
      // (e.g. prawduct's `Mark Critic Run`) so the frontend can render
      // them in the session banner. Server-side dispatch is gated by
      // the template's `actions[]`, so leaking only the whitelisted
      // fields is safe (the methodology authoritatively decides what's
      // dispatchable).
      //
      // #230 — `confirmMessage` and `successToast` are optional
      // per-action wording overrides used by the frontend's
      // `invokeMethodologyAction` handler when present. Omitted when
      // missing or empty so the handler's `typeof === 'string' && length > 0`
      // fallback to the generic wording keeps working.
      actions: Array.isArray(methodologyTemplate.actions)
        ? methodologyTemplate.actions
            .filter((a) => a && typeof a.label === 'string' && typeof a.command === 'string')
            .map((a) => {
              const out = {
                label: a.label,
                command: a.command,
                confirm: a.confirm === true
              };
              if (typeof a.confirmMessage === 'string' && a.confirmMessage.length > 0) {
                out.confirmMessage = a.confirmMessage;
              }
              if (typeof a.successToast === 'string' && a.successToast.length > 0) {
                out.successToast = a.successToast;
              }
              return out;
            })
        : []
    };
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

  // Methodology status (badge/color/detail)
  let status = null;
  if (methodologyTemplate && methodologyTemplate.statusContract && fs.existsSync(project.path)) {
    status = methodologies.executeStatusContract(project.path, methodologyTemplate.statusContract);
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
  } catch {
    // Project config might not be available — skip
  }

  return {
    id: project.id,
    name: project.name,
    path: project.path,
    engine,
    methodology,
    version,
    tags: project.tags,
    ports: project.ports,
    session,
    git: gitInfo,
    status,
    groups,
    evalAudit,
    silentPrime,
    featureIndexEnabled,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archived: project.archived
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

  for (const project of allProjects) {
    try {
      if (!project.path || !fs.existsSync(project.path)) continue;
      if (project.archived) continue;

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
      const engineId = projConfig.engine || project.engine || 'claude';
      const engineProfile = store.engines.get(engineId);
      if (engineProfile && engineProfile.configFormat) {
        const methodologyTemplate = store.templates.get(projConfig.methodology || project.methodology);
        engines.writeEngineConfig(engineId, project.path, projConfig, engineProfile, methodologyTemplate);
      }

      synced++;
    } catch (err) {
      errors.push(`${project.name}: ${err.message}`);
    }
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

    // Detect methodology
    const detectedMethodology = methodologies.detect(dirPath);

    // Check for TangleClaw config
    const hasTangleclawConfig = fs.existsSync(path.join(dirPath, '.tangleclaw', 'project.json'));

    unregistered.push({
      id: null,
      name: entry.name,
      path: dirPath,
      registered: false,
      engine: null,
      methodology: detectedMethodology ? { id: detectedMethodology.id, name: detectedMethodology.name, phase: null } : null,
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
 * Detects methodology, reads existing .tangleclaw/project.json if present.
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
  let methodologyId = null;

  if (fs.existsSync(projConfigPath)) {
    try {
      const existingConfig = JSON.parse(fs.readFileSync(projConfigPath, 'utf8'));
      if (existingConfig.engine) engineId = existingConfig.engine;
      if (existingConfig.methodology) methodologyId = existingConfig.methodology;
    } catch (err) {
      errors.push(`Failed to read existing project.json: ${err.message}`);
    }
  }

  // Detect methodology if not set
  if (!methodologyId) {
    const detected = methodologies.detect(projPath);
    if (detected) methodologyId = detected.id;
  }

  if (!methodologyId) {
    methodologyId = config.defaultMethodology || 'minimal';
  }

  // Register in SQLite
  const project = store.projects.create({
    name,
    path: projPath,
    engine: engineId,
    methodology: methodologyId,
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
    projConfig.methodology = methodologyId;
    store.projectConfig.save(projPath, projConfig);
  }

  // Sync engine hooks to match methodology — every project has one (#151)
  const methTemplate = store.templates.get(methodologyId);
  try {
    engines.syncEngineHooks(projPath, methTemplate);
  } catch (err) {
    log.warn('Failed to sync engine hooks during project attach', { error: err.message });
  }

  log.info('Project attached', { name, path: projPath, engine: engineId, methodology: methodologyId });
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
 * Update project configuration (engine, methodology, tags, rules).
 * @param {string} name - Project name
 * @param {object} updates - Fields to update
 * @returns {{ project: object|null, methodologySwitch: object|null, errors: string[] }}
 */
function updateProject(name, updates) {
  const project = store.projects.getByName(name);
  if (!project) {
    return { project: null, methodologySwitch: null, errors: [`Project "${name}" not found`] };
  }

  const errors = [];
  let methodologySwitch = null;
  const storeUpdates = {};

  // Pre-validate silentPrime (#103) against the *intended* post-update engine before
  // any side-effecting mutations run. The Critic on chunk 2 caught a partial-update
  // bug where engine→gemini + silentPrime=true in the same PATCH would write disk
  // (engine config + projConfig.engine) and then reject silentPrime, leaving DB and
  // disk inconsistent. By validating up here, a rejection drops cleanly without
  // mutating any state.
  if (updates.silentPrime !== undefined) {
    if (typeof updates.silentPrime !== 'boolean') {
      return { project: null, methodologySwitch: null, errors: ['silentPrime must be a boolean'] };
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
        return { project: null, methodologySwitch: null, errors: ['Engine does not support silentPrime'] };
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
    return { project: null, methodologySwitch: null, errors: ['featureIndexEnabled must be a boolean'] };
  }

  // Validate methodology up here too — same reason as the silentPrime gate above
  // (don't mutate name/engine first and then reject). Every project has a methodology
  // per #151; null is rejected with a pointer to `'minimal'`.
  if (updates.hasOwnProperty('methodology') && updates.methodology === null) {
    return { project: null, methodologySwitch: null, errors: ["methodology cannot be null — to clear methodology-specific workflow, PATCH methodology to 'minimal'"] };
  }

  // Name change — rename directory, DB record, and port leases
  if (updates.name && updates.name !== name) {
    // Block rename if session is active
    const activeSession = store.sessions.getActive(project.id);
    if (activeSession) {
      return { project: null, methodologySwitch: null, errors: ['Cannot rename while a session is active'] };
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
      return { project: null, methodologySwitch: null, errors: [msg] };
    }
    // Rename directory on disk
    const oldPath = project.path;
    const newPath = path.join(path.dirname(oldPath), updates.name);
    if (fs.existsSync(newPath)) {
      return { project: null, methodologySwitch: null, errors: [`Directory "${updates.name}" already exists on disk`] };
    }
    try {
      fs.renameSync(oldPath, newPath);
    } catch (err) {
      return { project: null, methodologySwitch: null, errors: [`Failed to rename directory: ${err.message}`] };
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
      return { project: null, methodologySwitch: null, errors: [`Engine "${updates.engine}" not found`] };
    }
    storeUpdates.engine_id = updates.engine;

    // Regenerate engine config
    const projConfig = store.projectConfig.load(project.path);
    projConfig.engine = updates.engine;
    store.projectConfig.save(project.path, projConfig);

    const methodologyTemplate = store.templates.get(project.methodology);
    // #240 drift-aware write — surfaces a warning when the on-disk
    // engine config differs from what we're about to write. Catches
    // operator hand-edits being lost during engine switches. `skipped`
    // (deliberate no-op for engines without config files) is NOT an
    // error and must not be pushed.
    const writeResult = engines.writeEngineConfig(updates.engine, project.path, projConfig, engineProfile, methodologyTemplate);
    if (writeResult.error && !writeResult.written && !writeResult.skipped) {
      errors.push(`Failed to write engine config: ${writeResult.error}`);
    }

    // Re-sync hooks so an engine flip away from claude clears any orphan
    // .claude/settings.json SessionStart entry, and a flip onto claude (with
    // silentPrime already true on the project) materializes the correct hook
    // immediately rather than waiting for the next launchSession (#140).
    // Mirrors the methodology/silentPrime branches and the project-create /
    // project-attach paths — all hook-affecting mutations call syncEngineHooks
    // on completion (symmetric-capability-gates principle from #103 / #137).
    try {
      engines.syncEngineHooks(project.path, methodologyTemplate);
    } catch (err) {
      log.warn('Failed to sync engine hooks during engine update', { project: project.name, error: err.message });
    }
  }

  // Methodology change — every project has one (#151). The previous null
  // branch was unreachable: it stacked a `ReferenceError` (fixed in #145
  // chunk 3) on top of an SQL NOT NULL constraint violation that no decision
  // path resolved. Per docs/methodology-guide.md *"Each project gets one
  // methodology"* — `'minimal'` is the no-workflow methodology, the canonical
  // way to clear methodology-specific behavior. The null-rejection is in the
  // pre-mutation validation phase above; here we only handle the real switch.
  // See ADR 0001.
  if (updates.hasOwnProperty('methodology') && updates.methodology !== project.methodology) {
    const newTemplate = store.templates.get(updates.methodology);
    if (!newTemplate) {
      return { project: null, methodologySwitch: null, errors: [`Methodology "${updates.methodology}" not found`] };
    }

    const switchResult = methodologies.switchMethodology(
      project.path,
      project.methodology,
      updates.methodology,
      { projectName: project.name }
    );

    if (!switchResult.success) {
      errors.push(...switchResult.errors);
    } else {
      storeUpdates.methodology = updates.methodology;
      methodologySwitch = {
        from: project.methodology,
        to: updates.methodology,
        archivePath: switchResult.archivePath
      };

      // Update project config
      const projConfig = store.projectConfig.load(project.path);
      projConfig.methodology = updates.methodology;
      projConfig.methodologyPhase = null;

      // Reset extension rules from old methodology before applying new ones
      const oldTemplate = store.templates.get(project.methodology);
      if (oldTemplate && oldTemplate.defaultRules) {
        for (const [rule, value] of Object.entries(oldTemplate.defaultRules)) {
          const enabled = (typeof value === 'object' && value !== null) ? !!value.enabled : !!value;
          if (enabled && projConfig.rules.extensions.hasOwnProperty(rule)) {
            projConfig.rules.extensions[rule] = false;
          }
        }
      }

      // Apply new methodology default rules (normalize object form to boolean)
      if (newTemplate.defaultRules) {
        for (const [rule, value] of Object.entries(newTemplate.defaultRules)) {
          if (projConfig.rules.extensions.hasOwnProperty(rule)) {
            projConfig.rules.extensions[rule] = (typeof value === 'object' && value !== null) ? !!value.enabled : !!value;
          }
        }
      }

      // Track archive in project config
      if (switchResult.archivePath) {
        if (!projConfig.methodologyArchives) projConfig.methodologyArchives = [];
        projConfig.methodologyArchives.push({
          methodology: project.methodology,
          archivePath: switchResult.archivePath,
          archivedAt: new Date().toISOString()
        });
      }

      store.projectConfig.save(project.path, projConfig);

      // Sync hooks to match new methodology
      try {
        engines.syncEngineHooks(project.path, newTemplate);
      } catch (err) {
        log.warn('Failed to sync engine hooks after methodology switch', { error: err.message });
      }
    }
  }

  // Phase update
  if (updates.phase !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    const methTemplate = store.templates.get(projConfig.methodology || project.methodology);
    if (updates.phase === null) {
      projConfig.methodologyPhase = null;
      store.projectConfig.save(project.path, projConfig);
    } else if (methTemplate) {
      const result = methodologies.setPhase(project.path, updates.phase, methTemplate.id);
      if (!result.success) {
        errors.push(result.error);
      }
    } else {
      errors.push('Cannot set phase: no methodology assigned');
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
        return { project: null, methodologySwitch: null, errors: ['Core rules cannot be disabled'] };
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

  // Actions
  if (updates.actions !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.actions = updates.actions;
    store.projectConfig.save(project.path, projConfig);
  }

  // Silent prime opt-in (#103) — capability/type validation already happened at the
  // top of this function so we know the value is safe to persist here. Re-sync
  // .claude/settings.json hooks immediately so the SessionStart entry materializes
  // (or disappears) on PATCH rather than waiting until the next session launch
  // (#137). Mirrors the methodology/engine branches' pattern at :237, :760, :990.
  if (updates.silentPrime !== undefined) {
    const projConfig = store.projectConfig.load(project.path);
    projConfig.silentPrime = updates.silentPrime;
    store.projectConfig.save(project.path, projConfig);

    try {
      const methTemplate = project.methodology ? store.templates.get(project.methodology) : null;
      engines.syncEngineHooks(project.path, methTemplate);
    } catch (err) {
      log.warn('Failed to sync engine hooks during silentPrime update', { project: project.name, error: err.message });
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

  // Persist store updates
  if (Object.keys(storeUpdates).length > 0) {
    store.projects.update(project.id, storeUpdates);
  }

  const finalName = storeUpdates.name || name;
  const updated = enrichProject(store.projects.getByName(finalName));
  return { project: updated, methodologySwitch, errors };
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
 * Detects methodology markers and auto-registers discovered projects.
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

    // Check for TangleClaw config
    const hasTangleclawConfig = fs.existsSync(path.join(dirPath, '.tangleclaw', 'project.json'));

    // Detect methodology
    const detectedMethodology = methodologies.detect(dirPath);

    if (hasTangleclawConfig || detectedMethodology) {
      detected.push({
        name: entry.name,
        path: dirPath,
        methodology: detectedMethodology ? detectedMethodology.id : null,
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

module.exports = {
  hashPassword,
  verifyPassword,
  checkDeletePassword,
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
  FEATURE_INDEX_TEMPLATE
};
