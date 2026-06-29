'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createLogger } = require('./logger');

const log = createLogger('store');

const CURRENT_SCHEMA_VERSION = 22;

const TANGLECLAW_DIR = path.join(process.env.HOME || '', '.tangleclaw');
const CONFIG_FILE = path.join(TANGLECLAW_DIR, 'config.json');
const DB_FILE = path.join(TANGLECLAW_DIR, 'tangleclaw.db');
const ENGINES_DIR = path.join(TANGLECLAW_DIR, 'engines');
const TEMPLATES_DIR = path.join(TANGLECLAW_DIR, 'templates');
const ORCH_PROFILES_FILE = path.join(TANGLECLAW_DIR, 'orchestration-profiles.json');
const BUNDLED_ENGINES_DIR = path.join(__dirname, '..', 'data', 'engines');
const BUNDLED_TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');
// TB-1 (#357) — bundled orchestration-profiles template; seeded once into
// ~/.tangleclaw/orchestration-profiles.json then operator-owned (see
// `_seedOrchestrationProfiles`).
const BUNDLED_ORCH_PROFILES = path.join(__dirname, '..', 'data', 'orchestration-profiles.json');
// #240 — global rules are now tracked in git at data/global-rules.md
// (renamed from data/default-global-rules.md in the same PR). This is the
// canonical source for both UI/API edits AND PR-driven edits — there is no
// per-install copy at ~/.tangleclaw/global-rules.md anymore. Migration
// from old installs is handled by `globalRulesApi._maybeWarnLegacyFile`
// at first load. Tests use `_setBundledGlobalRulesPath` to redirect.
let BUNDLED_GLOBAL_RULES = path.join(__dirname, '..', 'data', 'global-rules.md');

/**
 * Custom error class for store operations.
 */
class StoreError extends Error {
  /**
   * @param {string} message - Error description
   * @param {string} code - Machine-readable error code
   * @param {Error} [cause] - Underlying error
   */
  constructor(message, code, cause) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.detail = message;
    if (cause) this.cause = cause;
  }
}

const DEFAULT_CONFIG = {
  serverPort: 3101,
  ttydPort: 3100,
  defaultEngine: 'claude',
  defaultMethodology: 'minimal',
  projectsDir: '~/Documents/Projects',
  deletePassword: null,
  quickCommands: [
    { label: 'git status', command: 'git status' },
    { label: 'git log', command: 'git log --oneline -5' },
    { label: 'ls', command: 'ls -la' }
  ],
  theme: 'dark',
  chimeEnabled: true,
  chimeMuted: false,
  peekMode: 'drawer',
  portScannerEnabled: true,
  portScannerIntervalMs: 60000,
  setupComplete: false,
  httpsEnabled: true,
  httpsCertPath: null,
  httpsKeyPath: null,
  // AUTH-1 (#395) — ingress topology. 'direct' (default) = today's behavior:
  // TC terminates its own HTTPS via https-setup/mkcert and binds all interfaces.
  // 'caddy' = TC binds localhost plain-HTTP behind a Caddy reverse proxy that
  // terminates TLS (mkcert cert for localhost; ACME for `publicDomain`) and is
  // the single ingress. The flag is the reversibility spine — flipping back to
  // 'direct' + re-running the cutover restores direct-HTTPS exactly. The live
  // cutover is an explicit operator step (scripts/ingress-cutover.js), not a
  // runtime side effect of changing this value. See lib/caddy.js.
  ingressMode: 'direct',
  // Public domain for the Caddy ACME (Let's Encrypt) site block; null = local
  // only. Consumed solely by Caddyfile generation in caddy mode.
  publicDomain: null,
  // Ports Caddy listens on in caddy mode. Default to non-privileged ports so
  // Caddy runs as a user LaunchAgent with NO sudo (matches the ttyd pattern);
  // local URL becomes https://localhost:8443. Set these to 443/80 (and switch
  // Caddy to a root LaunchDaemon — documented in deploy/INGRESS.md) only for a
  // real public domain with ACME. The Caddyfile global block sets
  // `https_port`/`http_port` from these so Caddy never touches privileged ports.
  caddyHttpsPort: 8443,
  caddyHttpPort: 8080,
  // AUTH-2 (Path A) — Caddy `basic_auth` gate over the ingress. The gate lives at
  // Caddy, so these only take effect in caddy ingress mode, and only when the
  // cutover regenerates the Caddyfile (scripts/ingress-cutover.js). `authEnabled`
  // is the master switch; when true the generated Caddyfile gates every path
  // except /api/health with `basicAuthHash` — a BCRYPT hash, never a plaintext
  // password (the first-run wizard hashes via `caddy hash-password`). Default OFF
  // so the AUTH-1 ingress is byte-identical. Enabling requires both a user and a
  // hash — enforced at the API (PATCH /api/config) and again at generation time.
  authEnabled: false,
  basicAuthUser: null,
  basicAuthHash: null,
  // AUTH-4 (#1) — M2M fleet service token gating the direct-localhost PortHub
  // (`/api/ports*`) and shared-docs (`/api/shared-docs*` + group `/sync`) APIs,
  // which AUTH-2's Caddy basic_auth can't cover (local callers bypass Caddy).
  // `serviceTokenEnabled` is the master switch (default OFF so existing local
  // callers keep working — the gate is opt-in + reversible). `serviceToken` is
  // the raw fleet token, stored at rest (like auditSecret/bridgeToken) so TC can
  // auto-inject it into each project's config guide; it is REDACTED from the
  // config API (a `serviceTokenConfigured` boolean is surfaced instead) and is
  // auto-generated on first enable. See lib/service-token.js.
  serviceTokenEnabled: false,
  serviceToken: null,
  // #247 — install a commit-msg git hook in TC-managed projects that
  // strips AI-vendor `Co-Authored-By:` trailers from new commits. Forward
  // only; historical commits are untouched. Default ON; set false to
  // uninstall on next project sync. See lib/git-hooks.js.
  stripAiCoauthors: true
};

let _db = null;
let _basePath = TANGLECLAW_DIR;
let _configFile = CONFIG_FILE;
let _dbFile = DB_FILE;
let _enginesDir = ENGINES_DIR;
let _templatesDir = TEMPLATES_DIR;
let _orchProfilesFile = ORCH_PROFILES_FILE;

/**
 * Override base paths (for testing).
 * @param {string} basePath - Root directory for TangleClaw data
 */
function _setBasePath(basePath) {
  _basePath = basePath;
  _configFile = path.join(basePath, 'config.json');
  _dbFile = path.join(basePath, 'tangleclaw.db');
  _enginesDir = path.join(basePath, 'engines');
  _templatesDir = path.join(basePath, 'templates');
  _orchProfilesFile = path.join(basePath, 'orchestration-profiles.json');
}

/**
 * Get the current base path.
 * @returns {string}
 */
function _getBasePath() {
  return _basePath;
}

// ── Initialization ──

/**
 * Initialize the store: create directories, SQLite database, default config, bundled data.
 */
function init() {
  log.debug('Initializing store', { path: _basePath });

  // Create directory structure
  for (const dir of [_basePath, _enginesDir, _templatesDir, path.join(_basePath, 'logs')]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  // Write default config if missing
  if (!fs.existsSync(_configFile)) {
    fs.writeFileSync(_configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { mode: 0o600 });
    log.info('Created default config', { path: _configFile });
  }

  // Check permissions on config directory and files
  _checkPermissions();

  // Sync bundled engine profiles into the user-local dir on every startup.
  // Canonical-source semantics (#251) — the tracked file in `data/engines/`
  // wins; on-disk drift gets a `log.warn` then is overwritten. Same shape
  // as #240's `writeEngineConfig` for CLAUDE.md regeneration.
  _syncBundledEngines(BUNDLED_ENGINES_DIR, _enginesDir);

  // TB-1 (#357) — seed the orchestration-profiles file once, then leave it
  // operator-owned (unlike engines, profiles carry operator-edited endpoints +
  // key references, so seed-if-missing — never canonical-overwrite).
  _seedOrchestrationProfiles(BUNDLED_ORCH_PROFILES, _orchProfilesFile);

  // Copy bundled methodology templates if templates dir is empty
  _copyBundledTemplates(BUNDLED_TEMPLATES_DIR, _templatesDir);

  // Initialize SQLite
  _db = new DatabaseSync(_dbFile);
  _createTables();
  _runMigrations();
  // Post-migration indexes (columns may not exist until after migration)
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_port_leases_host ON port_leases(host)'); } catch { /* already exists or handled by migration */ }

  log.info('Store initialized', { db: _dbFile });
}

/**
 * Close the SQLite database connection.
 */
function close() {
  if (_db) {
    _db.close();
    _db = null;
    log.debug('Store closed');
  }
}

// ── Global Config ──

const configApi = {
  /**
   * Load global config, merged with defaults.
   * @returns {object}
   */
  load() {
    try {
      if (!fs.existsSync(_configFile)) {
        log.warn('Config file not found, using defaults', { path: _configFile });
        return { ...DEFAULT_CONFIG };
      }
      const raw = fs.readFileSync(_configFile, 'utf8');
      const parsed = JSON.parse(raw);
      // Existing installs without setupComplete field are already configured
      if (!parsed.hasOwnProperty('setupComplete')) {
        parsed.setupComplete = true;
      }
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
      throw new StoreError(`Failed to load config: ${err.message}`, 'CONFIG_LOAD_FAILED', err);
    }
  },

  /**
   * Save global config to disk.
   * @param {object} config - Full config object
   */
  save(config) {
    try {
      fs.writeFileSync(_configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      log.debug('Config saved', { path: _configFile });
    } catch (err) {
      throw new StoreError(`Failed to save config: ${err.message}`, 'CONFIG_SAVE_FAILED', err);
    }
  },

  /**
   * Get a single config value by key (supports dot notation).
   * @param {string} key - Config key (e.g. 'serverPort' or 'quickCommands.0.label')
   * @returns {*}
   */
  get(key) {
    const config = configApi.load();
    return _getNestedValue(config, key);
  },

  /**
   * Set a single config value by key, and save.
   * @param {string} key - Config key
   * @param {*} value - Value to set
   */
  set(key, value) {
    const config = configApi.load();
    _setNestedValue(config, key, value);
    configApi.save(config);
  }
};

// ── Engine Profiles ──

const enginesApi = {
  /**
   * List all engine profiles from the engines directory.
   * @returns {object[]}
   */
  list() {
    if (!fs.existsSync(_enginesDir)) return [];
    const files = fs.readdirSync(_enginesDir).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      const raw = fs.readFileSync(path.join(_enginesDir, f), 'utf8');
      return JSON.parse(raw);
    });
  },

  /**
   * Get a single engine profile by id.
   * @param {string} id - Engine profile id
   * @returns {object|null}
   */
  get(id) {
    const filePath = path.join(_enginesDir, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  },

  /**
   * Save an engine profile.
   * @param {object} profile - Engine profile object (must have id)
   */
  save(profile) {
    if (!profile || !profile.id) {
      throw new StoreError('Engine profile must have an id', 'BAD_REQUEST');
    }
    const filePath = path.join(_enginesDir, `${profile.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
  },

  /**
   * Delete an engine profile by id.
   * @param {string} id - Engine profile id
   */
  delete(id) {
    const filePath = path.join(_enginesDir, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      throw new StoreError(`Engine profile "${id}" not found`, 'NOT_FOUND');
    }
    // Check if engine is in use by any project
    if (_db) {
      const stmt = _db.prepare('SELECT COUNT(*) as count FROM projects WHERE engine_id = ?');
      const row = stmt.get(id);
      if (row && row.count > 0) {
        throw new StoreError(`Engine "${id}" is in use by ${row.count} project(s)`, 'FK_VIOLATION');
      }
    }
    fs.unlinkSync(filePath);
  }
};

// ── Methodology Templates ──

const templatesApi = {
  /**
   * List all methodology templates.
   * @returns {object[]}
   */
  list() {
    if (!fs.existsSync(_templatesDir)) return [];
    const dirs = fs.readdirSync(_templatesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    const templates = [];
    for (const dir of dirs) {
      const templateFile = path.join(_templatesDir, dir.name, 'template.json');
      if (fs.existsSync(templateFile)) {
        const raw = fs.readFileSync(templateFile, 'utf8');
        const tmpl = JSON.parse(raw);
        templates.push({
          id: tmpl.id,
          name: tmpl.name,
          description: tmpl.description,
          type: tmpl.type,
          version: tmpl.version
        });
      }
    }
    return templates;
  },

  /**
   * Get a full methodology template by id.
   * @param {string} id - Template id
   * @returns {object|null}
   */
  get(id) {
    const templateFile = path.join(_templatesDir, id, 'template.json');
    if (!fs.existsSync(templateFile)) return null;
    const raw = fs.readFileSync(templateFile, 'utf8');
    return JSON.parse(raw);
  },

  /**
   * Save a methodology template.
   * @param {object} template - Template object (must have id)
   */
  save(template) {
    if (!template || !template.id) {
      throw new StoreError('Template must have an id', 'BAD_REQUEST');
    }
    const templateDir = path.join(_templatesDir, template.id);
    if (!fs.existsSync(templateDir)) {
      fs.mkdirSync(templateDir, { recursive: true, mode: 0o700 });
    }
    const templateFile = path.join(templateDir, 'template.json');
    fs.writeFileSync(templateFile, JSON.stringify(template, null, 2) + '\n', { mode: 0o600 });
  },

  /**
   * Get the playbook content for a methodology template.
   * @param {string} id - Template id
   * @returns {string|null} Markdown content or null if no playbook exists
   */
  getPlaybook(id) {
    const userPlaybook = path.join(_templatesDir, id, 'playbook.md');
    if (fs.existsSync(userPlaybook)) {
      return fs.readFileSync(userPlaybook, 'utf8').trim();
    }
    // Fall back to bundled templates for reliability
    const bundledPlaybook = path.join(BUNDLED_TEMPLATES_DIR, id, 'playbook.md');
    if (fs.existsSync(bundledPlaybook)) {
      return fs.readFileSync(bundledPlaybook, 'utf8').trim();
    }
    return null;
  },

  /**
   * Delete a methodology template.
   * @param {string} id - Template id
   */
  delete(id) {
    const templateDir = path.join(_templatesDir, id);
    if (!fs.existsSync(templateDir)) {
      throw new StoreError(`Template "${id}" not found`, 'NOT_FOUND');
    }
    // Check if template is in use
    if (_db) {
      const stmt = _db.prepare('SELECT COUNT(*) as count FROM projects WHERE methodology = ?');
      const row = stmt.get(id);
      if (row && row.count > 0) {
        throw new StoreError(`Template "${id}" is in use by ${row.count} project(s)`, 'FK_VIOLATION');
      }
    }
    fs.rmSync(templateDir, { recursive: true });
  }
};

// ── Per-Project Config ──

const DEFAULT_PROJECT_CONFIG = {
  engine: null,
  methodology: 'minimal',
  methodologyPhase: null,
  // Silent prime is the cleaner-scrollback default (#129). Projects that
  // explicitly persist `silentPrime: false` continue to get the typed-prime
  // path; non-Claude engines fall through via the capability gate
  // (`engineProfile.capabilities.supportsSilentPrime`) regardless of this default.
  silentPrime: true,
  // Feature Index (#207, chunk 1) — opt-in per-project. When true, a
  // FEATURES.md is seeded at project root on first toggle-on (idempotent;
  // never overwrites an existing file). Chunk 2 injects the contents into
  // the SessionStart prime prompt (gated additionally by silentPrime + the
  // engine's `supportsSilentPrime` capability). Chunk 3 adds a
  // `features-toc` wrap-step handler that auto-appends stubs for PR-touched
  // files not represented in FEATURES.md. The file itself is engine-agnostic
  // so the toggle is not engine-gated.
  featureIndexEnabled: false,
  // #318: opt-out for the `version-bump` wrap step. Default true (existing
  // behavior). Projects that manage their own versioning (e.g. a non-semver
  // scheme via their own tooling) set this false so TC doesn't try to bump.
  versionBumpEnabled: true,
  // CC-6 (#381): which of continuity's 8 wrap-summary sections render for this
  // project. null = the deep default (all 8). An override is an array of enabled
  // section names (subset of continuity.WRAP_SECTIONS); `Next action` always
  // renders regardless (the keystone). Per-methodology depth presets (software=8,
  // grant-proposal=3) are CC-8; CC-6 ships the per-project override only.
  wrapSections: null,
  // TB-1 (#357): optional per-(project,profile) key-ref override. NULL = use
  // the bound profile's default keyRef from orchestration-profiles.json. Set
  // to `file:<path>` or `env:<NAME>` when a project needs isolated metering /
  // budget / revocation with its own key. The binding itself (which profile)
  // lives in the projects.orchestration_profile column, not here.
  orchestrationKeyRef: null,
  rules: {
    core: {
      changelogPerChange: true,
      jsdocAllFunctions: true,
      unitTestRequirements: true,
      sessionWrapProtocol: true,
      porthubRegistration: true
    },
    extensions: {
      identitySentry: false,
      docsParity: false,
      decisionFramework: false,
      loggingLevel: 'info',
      zeroDebtProtocol: false,
      independentCritic: false,
      adversarialTesting: false
    }
  },
  ports: {},
  quickCommands: [],
  actions: [],
  tags: [],
  evalAuditMode: {
    enabled: false,
    judgeModel: 'claude-haiku-4-5',
    gateCascade: true,
    sampling: {
      enabled: true,
      routineInterval: 3,
      alwaysScoreFirst: 5,
      alwaysScoreLast: 3,
      alwaysScoreDisagreement: true,
      alwaysScoreLongResponses: true,
      longResponseThreshold: 500
    },
    thinkingBlockAnalysis: true,
    bidirectionalScoring: false,
    wrapQualityScoring: true,
    costCapPerSession: 1.00,
    heartbeatInterval: 300000,
    baselineWindowDays: 14,
    retentionDays: 90
  },
  // #139 Chunk 11c — `wrapV2` defaults `true`. `lib/sessions.js:triggerWrap`
  // routes through `lib/wrap-pipeline.js:runWrapPipeline` for new projects.
  // Existing projects with an explicit `wrapV2: false` in their on-disk
  // `<project>/.tangleclaw/project.json` continue on the legacy
  // NL-prompt-via-tmux flow — the deep-merge in `projectConfigApi.load`
  // preserves the explicit override. To opt back to legacy on a per-project
  // basis, set `wrapV2: false` in the project config file. The legacy code
  // in `triggerWrap` remains for one release cycle, then a follow-up PR
  // strips it along with the back-compat shim in `lib/skills.js`.
  // Chunks 3–10 ran the V2 path behind this flag at `false` for a soak; the
  // flip in 11c arrives only after 11a (V2 session-lifecycle transition)
  // and 11b (`invoke-critic` action producer) have shipped the pre-flip
  // plumbing that makes V2 a quality default.
  wrapV2: true,
  // Test/lint commands the wrap pipeline shells out to in Chunks 4–5.
  // Explicit declaration avoids auto-detection's monorepo / multi-stack
  // failure modes (Notse-class projects with `cd helper && pytest && cd
  // ../app && npm test`). `null` means "this project has no command to
  // run"; the relevant step kind logs and skips when the command is null.
  testCommand: null,
  lintCommand: null,
  // #139 Chunk 9 — last successful wrap commit SHA. Stamped by the
  // `commit` step (`lib/wrap-steps/commit.js`) after a successful
  // single-transaction commit. Lets Chunk 4 (lint scope) and Chunk 7
  // (critic-check range detection) replace their `HEAD~10..HEAD`
  // fallback with a true `<lastWrapSha>..HEAD` range in a future
  // chunk. `null` means "this project has never been wrapped" — the
  // fallback path is still authoritative for that case.
  lastWrapSha: null
};

const projectConfigApi = {
  /**
   * Load per-project config from <projectPath>/.tangleclaw/project.json.
   * Merges with defaults. Returns defaults if file doesn't exist.
   * @param {string} projectPath - Absolute path to project root
   * @returns {object}
   */
  load(projectPath) {
    const configPath = path.join(projectPath, '.tangleclaw', 'project.json');
    try {
      if (!fs.existsSync(configPath)) {
        return JSON.parse(JSON.stringify(DEFAULT_PROJECT_CONFIG));
      }
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      // Migrate legacy engine ID
      if (parsed.engine === 'claude-code') {
        parsed.engine = 'claude';
      }

      // Deep merge with defaults
      const merged = JSON.parse(JSON.stringify(DEFAULT_PROJECT_CONFIG));
      for (const [key, value] of Object.entries(parsed)) {
        if (key === 'rules' && typeof value === 'object') {
          if (value.core) {
            // Core rules are always true — ignore any attempt to disable
            merged.rules.core = { ...merged.rules.core };
          }
          if (value.extensions) {
            merged.rules.extensions = { ...merged.rules.extensions, ...value.extensions };
          }
        } else {
          merged[key] = value;
        }
      }
      // #151 migration: existing on-disk project.json files written before
      // DEFAULT_PROJECT_CONFIG.methodology flipped from null to 'minimal' may
      // carry an explicit `methodology: null` that the merge loop above
      // would otherwise propagate. Coerce to 'minimal' here so the rest of
      // the codebase can rely on a non-null projConfig.methodology.
      if (merged.methodology === null) {
        merged.methodology = 'minimal';
      }
      return merged;
    } catch (err) {
      log.warn('Failed to load project config, using defaults', { path: configPath, error: err.message });
      return JSON.parse(JSON.stringify(DEFAULT_PROJECT_CONFIG));
    }
  },

  /**
   * Save per-project config to <projectPath>/.tangleclaw/project.json.
   * Creates .tangleclaw/ directory if needed.
   * @param {string} projectPath - Absolute path to project root
   * @param {object} config - Project config object
   */
  save(projectPath, config) {
    const tangleclawDir = path.join(projectPath, '.tangleclaw');
    if (!fs.existsSync(tangleclawDir)) {
      fs.mkdirSync(tangleclawDir, { recursive: true });
    }
    const configPath = path.join(tangleclawDir, 'project.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    log.debug('Project config saved', { path: configPath });
  }
};

// ── Private Helpers ──

/**
 * Check permissions on the TangleClaw data directory and config file.
 * Warns if permissions are more open than recommended (0700 for dirs, 0600 for files).
 */
function _checkPermissions() {
  try {
    if (!fs.existsSync(_basePath)) return;

    const dirStats = fs.statSync(_basePath);
    const dirMode = dirStats.mode & 0o777;
    if (dirMode !== 0o700 && dirMode !== 0o755) {
      log.warn('Data directory permissions are too open', {
        path: _basePath,
        mode: '0' + dirMode.toString(8),
        recommended: '0700'
      });
    }

    if (fs.existsSync(_configFile)) {
      const fileStats = fs.statSync(_configFile);
      const fileMode = fileStats.mode & 0o777;
      if (fileMode !== 0o600 && fileMode !== 0o644) {
        log.warn('Config file permissions are too open', {
          path: _configFile,
          mode: '0' + fileMode.toString(8),
          recommended: '0600'
        });
      }
    }
  } catch (err) {
    log.debug('Could not check permissions', { error: err.message });
  }
}

/**
 * Create all SQLite tables.
 */
function _createTables() {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL UNIQUE,
      path          TEXT    NOT NULL UNIQUE,
      engine_id     TEXT    NOT NULL DEFAULT 'claude',
      methodology   TEXT    NOT NULL DEFAULT 'minimal',
      tags          TEXT    DEFAULT '[]',
      ports         TEXT    DEFAULT '{}',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      archived      INTEGER NOT NULL DEFAULT 0,
      migration_status TEXT,
      orchestration_profile TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_projects_engine ON projects(engine_id);
    CREATE INDEX IF NOT EXISTS idx_projects_methodology ON projects(methodology);

    CREATE TABLE IF NOT EXISTS sessions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      engine_id       TEXT    NOT NULL,
      tmux_session    TEXT,
      started_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      ended_at        TEXT,
      status          TEXT    NOT NULL DEFAULT 'active',
      wrap_summary    TEXT,
      prime_prompt    TEXT,
      methodology_phase TEXT,
      duration_seconds INTEGER,
      session_mode     TEXT NOT NULL DEFAULT 'tmux',
      launch_mode      TEXT,
      wrap_started_at  TEXT,
      owner            TEXT                                                  -- AUTH-3: proxy-authenticated user (NULL = unauthenticated/direct mode)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

    CREATE TABLE IF NOT EXISTS learnings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      content         TEXT    NOT NULL,
      tier            TEXT    NOT NULL DEFAULT 'provisional',
      source_session  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      confirmed_count INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project_id);
    CREATE INDEX IF NOT EXISTS idx_learnings_tier ON learnings(tier);

    CREATE TABLE IF NOT EXISTS session_rules (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id        INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global (all projects)
      content           TEXT    NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      created_by        TEXT    NOT NULL DEFAULT 'operator',                -- 'operator' | 'ai'
      kind              TEXT    NOT NULL DEFAULT 'startup',                 -- CC-6: 'startup' (launch-injected) | 'wrap' | 'mode'
      owner             TEXT,                                               -- nullable auth-ready seam (AUTH/#347)
      source_learning_id INTEGER REFERENCES learnings(id) ON DELETE SET NULL, -- provenance for promoted rules (D1b)
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_session_rules_project ON session_rules(project_id);
    CREATE INDEX IF NOT EXISTS idx_session_rules_enabled ON session_rules(enabled);

    -- D1b: version history for session_rules. Snapshots the full rule state after
    -- every mutation (create/update/delete/restore) so any autonomous edit is
    -- reversible. rule_id is a LOGICAL reference (no FK cascade) so history
    -- survives a rule's deletion for audit.
    CREATE TABLE IF NOT EXISTS session_rule_versions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id       INTEGER NOT NULL,
      version_no    INTEGER NOT NULL,                                    -- monotonic per rule_id (1,2,3…)
      op            TEXT    NOT NULL,                                    -- 'create' | 'update' | 'delete' | 'restore'
      content       TEXT    NOT NULL,
      enabled       INTEGER NOT NULL,
      created_by    TEXT    NOT NULL,
      owner         TEXT,
      changed_by    TEXT    NOT NULL DEFAULT 'operator',                -- who made THIS change ('operator' | 'ai')
      change_reason TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_session_rule_versions_rule ON session_rule_versions(rule_id);

    CREATE TABLE IF NOT EXISTS activity_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      session_id  INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      event_type  TEXT    NOT NULL,
      detail      TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_activity_project ON activity_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);

    CREATE TABLE IF NOT EXISTS port_leases (
      host        TEXT NOT NULL DEFAULT 'localhost',
      port        INTEGER NOT NULL,
      project     TEXT NOT NULL,
      service     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                  CHECK(status IN ('active','expired','permanent')),
      permanent   INTEGER NOT NULL DEFAULT 0,
      ttl_ms      INTEGER,
      expires_at  TEXT,
      last_heartbeat TEXT,
      description TEXT,
      auto_renew  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (host, port)
    );

    CREATE INDEX IF NOT EXISTS idx_port_leases_project ON port_leases(project);
    CREATE INDEX IF NOT EXISTS idx_port_leases_status ON port_leases(status);

    CREATE TABLE IF NOT EXISTS project_groups (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      shared_dir  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_group_members (
      group_id    TEXT NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      added_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, project_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pgm_project ON project_group_members(project_id);

    CREATE TABLE IF NOT EXISTS shared_documents (
      id                TEXT PRIMARY KEY,
      group_id          TEXT NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      file_path         TEXT NOT NULL,
      inject_into_config INTEGER NOT NULL DEFAULT 0,
      inject_mode       TEXT NOT NULL DEFAULT 'reference'
                        CHECK(inject_mode IN ('reference','inline')),
      description       TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(group_id, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_shared_docs_group ON shared_documents(group_id);

    CREATE TABLE IF NOT EXISTS document_locks (
      document_id       TEXT PRIMARY KEY REFERENCES shared_documents(id) ON DELETE CASCADE,
      locked_by_session INTEGER NOT NULL,
      locked_by_project TEXT NOT NULL,
      locked_at         TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS openclaw_connections (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL UNIQUE,
      host              TEXT NOT NULL,
      port              INTEGER NOT NULL DEFAULT 18789,
      ssh_user          TEXT NOT NULL,
      ssh_key_path      TEXT NOT NULL,
      gateway_token     TEXT,
      cli_command       TEXT DEFAULT 'openclaw-cli',
      local_port        INTEGER NOT NULL DEFAULT 18789,
      available_as_engine INTEGER NOT NULL DEFAULT 0,
      default_mode      TEXT NOT NULL DEFAULT 'ssh',
      audit_secret      TEXT,
      bridge_port       INTEGER,
      bridge_token      TEXT,
      instance_dir      TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_openclaw_conn_name ON openclaw_connections(name);

    CREATE TABLE IF NOT EXISTS eval_exchanges (
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL,
      connection_id     TEXT,
      project           TEXT NOT NULL,
      agent_model       TEXT,
      timestamp         TEXT NOT NULL,
      turn_number       INTEGER,
      user_message      TEXT NOT NULL,
      agent_response    TEXT NOT NULL,
      agent_thinking    TEXT,
      usage_input_tokens  INTEGER,
      usage_output_tokens INTEGER,
      scored            INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_eval_exchanges_session ON eval_exchanges(session_id);
    CREATE INDEX IF NOT EXISTS idx_eval_exchanges_project ON eval_exchanges(project, timestamp);
    CREATE INDEX IF NOT EXISTS idx_eval_exchanges_scored ON eval_exchanges(scored);

    CREATE TABLE IF NOT EXISTS eval_scores (
      id                    TEXT PRIMARY KEY,
      exchange_id           TEXT NOT NULL REFERENCES eval_exchanges(id),
      schema_version        TEXT NOT NULL,
      judge_model           TEXT NOT NULL,
      scored_at             TEXT NOT NULL,
      methodology           TEXT,
      tier_1_structural_score REAL,
      tier_1_flags          TEXT,
      tier_2_semantic_score REAL,
      tier_2_reasoning      TEXT,
      tier_2_skipped        INTEGER NOT NULL DEFAULT 0,
      tier_2_5_alignment_score REAL,
      tier_2_5_reasoning    TEXT,
      tier_2_5_skipped      INTEGER NOT NULL DEFAULT 0,
      tier_3_behavioral_score REAL,
      tier_3_dimension_scores TEXT,
      tier_3_skipped        INTEGER NOT NULL DEFAULT 0,
      anomaly_flag          INTEGER NOT NULL DEFAULT 0,
      anomaly_reason        TEXT,
      cost_usd              REAL,
      human_score           REAL,
      human_comment         TEXT,
      human_scored_at       TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_eval_scores_exchange ON eval_scores(exchange_id);
    CREATE INDEX IF NOT EXISTS idx_eval_scores_project_time ON eval_scores(methodology, scored_at);

    CREATE TABLE IF NOT EXISTS eval_baselines (
      id                  TEXT PRIMARY KEY,
      project             TEXT NOT NULL,
      methodology         TEXT,
      computed_at         TEXT NOT NULL,
      window_start        TEXT NOT NULL,
      window_end          TEXT NOT NULL,
      dimension_averages  TEXT NOT NULL,
      exchange_count      INTEGER NOT NULL,
      schema_version      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_incidents (
      id            TEXT PRIMARY KEY,
      project       TEXT NOT NULL,
      type          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open',
      severity      TEXT NOT NULL DEFAULT 'warning',
      title         TEXT NOT NULL,
      description   TEXT NOT NULL,
      metadata      TEXT,
      detected_at   TEXT NOT NULL,
      resolved_at   TEXT,
      resolved_by   TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_eval_incidents_project ON eval_incidents(project, status);
  `);

  // Seed schema version if empty
  const row = _db.prepare('SELECT COUNT(*) as count FROM schema_version').get();
  if (row.count === 0) {
    _db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
  }
}

/**
 * Run any pending migrations.
 */
function _runMigrations() {
  const row = _db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
  const currentVersion = row ? row.version : 0;

  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    log.info('Running migrations', { from: currentVersion, to: CURRENT_SCHEMA_VERSION });

    if (currentVersion < 2) {
      // v1→v2: add port_leases table (CREATE IF NOT EXISTS in _createTables handles the DDL)
      log.info('Migration v1→v2: port_leases table added');
    }

    if (currentVersion < 3) {
      // v2→v3: add project_groups, project_group_members, shared_documents, document_locks
      // (CREATE IF NOT EXISTS in _createTables handles the DDL)
      log.info('Migration v2→v3: shared documents tables added');
    }

    if (currentVersion < 4) {
      // v3→v4: add shared_dir column to project_groups
      try {
        _db.exec('ALTER TABLE project_groups ADD COLUMN shared_dir TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v3→v4: shared_dir column added to project_groups');
    }

    if (currentVersion < 5) {
      // v4→v5: add openclaw_connections table
      // (CREATE IF NOT EXISTS in _createTables handles the DDL)
      log.info('Migration v4→v5: openclaw_connections table added');
    }

    if (currentVersion < 6) {
      // v5→v6: add session_mode column to sessions table
      try {
        _db.exec("ALTER TABLE sessions ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'tmux'");
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v5→v6: session_mode column added to sessions');
    }

    if (currentVersion < 7) {
      // v6→v7: add default_mode column to openclaw_connections table
      try {
        _db.exec("ALTER TABLE openclaw_connections ADD COLUMN default_mode TEXT NOT NULL DEFAULT 'ssh'");
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v6→v7: default_mode column added to openclaw_connections');
    }

    if (currentVersion < 8) {
      // v7→v8: add host column to port_leases, change PK from port to (host, port)
      // SQLite doesn't support ALTER TABLE to change PK, so we recreate the table.
      try {
        _db.exec(`
          ALTER TABLE port_leases RENAME TO port_leases_old;
          CREATE TABLE port_leases (
            host        TEXT NOT NULL DEFAULT 'localhost',
            port        INTEGER NOT NULL,
            project     TEXT NOT NULL,
            service     TEXT NOT NULL,
            status      TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','expired','permanent')),
            permanent   INTEGER NOT NULL DEFAULT 0,
            ttl_ms      INTEGER,
            expires_at  TEXT,
            last_heartbeat TEXT,
            description TEXT,
            auto_renew  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (host, port)
          );
          INSERT INTO port_leases (host, port, project, service, status, permanent, ttl_ms, expires_at, last_heartbeat, description, auto_renew, created_at, updated_at)
            SELECT 'localhost', port, project, service, status, permanent, ttl_ms, expires_at, last_heartbeat, description, auto_renew, created_at, updated_at
            FROM port_leases_old;
          DROP TABLE port_leases_old;
          CREATE INDEX IF NOT EXISTS idx_port_leases_project ON port_leases(project);
          CREATE INDEX IF NOT EXISTS idx_port_leases_status ON port_leases(status);
          CREATE INDEX IF NOT EXISTS idx_port_leases_host ON port_leases(host);
        `);
      } catch (err) {
        // Table may already have the new schema from a fresh _createTables
        log.debug('Migration v7→v8 skipped (table may already have host column)', { error: err.message });
      }
      log.info('Migration v7→v8: host column added to port_leases, PK is now (host, port)');
    }

    if (currentVersion < 9) {
      // v8→v9: add eval audit tables (CREATE IF NOT EXISTS in _createTables handles DDL)
      // Add audit_secret column to openclaw_connections
      try {
        _db.exec('ALTER TABLE openclaw_connections ADD COLUMN audit_secret TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v8→v9: eval audit tables + audit_secret column added');
    }

    if (currentVersion < 10) {
      // v9→v10: add human scoring columns to eval_scores, retention support
      const alterCols = [
        'ALTER TABLE eval_scores ADD COLUMN human_score REAL',
        'ALTER TABLE eval_scores ADD COLUMN human_comment TEXT',
        'ALTER TABLE eval_scores ADD COLUMN human_scored_at TEXT'
      ];
      for (const sql of alterCols) {
        try { _db.exec(sql); } catch { /* column may already exist */ }
      }
      log.info('Migration v9→v10: human scoring columns added to eval_scores');
    }

    if (currentVersion < 11) {
      // v10→v11: add bridge_port column to openclaw_connections (ClawBridge direct port)
      try {
        _db.exec("ALTER TABLE openclaw_connections ADD COLUMN bridge_port INTEGER NOT NULL DEFAULT 3201");
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v10→v11: bridge_port column added to openclaw_connections');
    }

    if (currentVersion < 12) {
      // v11→v12: add bridge_token column to openclaw_connections (ClawBridge auth token)
      try {
        _db.exec('ALTER TABLE openclaw_connections ADD COLUMN bridge_token TEXT');
      } catch {
        // Column may already exist
      }
      log.info('Migration v11→v12: bridge_token column added to openclaw_connections');
    }

    if (currentVersion < 13) {
      // v12→v13: add launch_mode column to sessions
      try {
        _db.exec('ALTER TABLE sessions ADD COLUMN launch_mode TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v12→v13: launch_mode column added to sessions');
    }

    if (currentVersion < 14) {
      // v13→v14: add wrap_started_at column so launch-guard can distinguish
      // a long-lived session that just wrapped from a stale wrapping row (#105).
      try {
        _db.exec('ALTER TABLE sessions ADD COLUMN wrap_started_at TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v13→v14: wrap_started_at column added to sessions');
    }

    if (currentVersion < 15) {
      // v14→v15: drop the NOT NULL constraint on openclaw_connections.bridge_port
      // and remove its `DEFAULT 3201` (#160). Pre-#160 the column was
      // `INTEGER NOT NULL DEFAULT 3201`, which silently filled in 3201 for every
      // non-ClawBridge connection — that bogus value then drove a stray local
      // `-L 3201:127.0.0.1:3201` SSH forward and killed the entire tunnel via
      // `ExitOnForwardFailure=yes`. SQLite can't ALTER COLUMN to drop NOT NULL,
      // so we recreate the table preserving every existing row's data verbatim
      // (rows that already have 3201 keep 3201 — that's intentional; the
      // migration only changes the column constraint, not the existing data).
      try {
        // node:sqlite's DatabaseSync does not expose a `.transaction()`
        // wrapper the way better-sqlite3 does, so wrap the recreate sequence
        // with explicit BEGIN/COMMIT inside the SQL itself — if any
        // intermediate statement fails, the surrounding catch sees the throw
        // and the postcondition check rejects schema_version advancement.
        _db.exec(`
          BEGIN;
          CREATE TABLE openclaw_connections_new (
            id                TEXT PRIMARY KEY,
            name              TEXT NOT NULL UNIQUE,
            host              TEXT NOT NULL,
            port              INTEGER NOT NULL DEFAULT 18789,
            ssh_user          TEXT NOT NULL,
            ssh_key_path      TEXT NOT NULL,
            gateway_token     TEXT,
            cli_command       TEXT DEFAULT 'openclaw-cli',
            local_port        INTEGER NOT NULL DEFAULT 18789,
            available_as_engine INTEGER NOT NULL DEFAULT 0,
            default_mode      TEXT NOT NULL DEFAULT 'ssh',
            audit_secret      TEXT,
            bridge_port       INTEGER,
            bridge_token      TEXT,
            created_at        TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO openclaw_connections_new
            (id, name, host, port, ssh_user, ssh_key_path, gateway_token,
             cli_command, local_port, available_as_engine, default_mode,
             audit_secret, bridge_port, bridge_token, created_at)
            SELECT id, name, host, port, ssh_user, ssh_key_path, gateway_token,
                   cli_command, local_port, available_as_engine, default_mode,
                   audit_secret, bridge_port, bridge_token, created_at
            FROM openclaw_connections;
          DROP TABLE openclaw_connections;
          ALTER TABLE openclaw_connections_new RENAME TO openclaw_connections;
          CREATE INDEX IF NOT EXISTS idx_openclaw_conn_name ON openclaw_connections(name);
          COMMIT;
        `);
      } catch (err) {
        // Attempt to roll back if a BEGIN landed but COMMIT didn't. Best-effort:
        // if no transaction is open this throws and we ignore.
        try { _db.exec('ROLLBACK'); } catch { /* no transaction in progress */ }
        // Table may already have the post-#160 nullable schema on a fresh
        // install (the `CREATE TABLE IF NOT EXISTS openclaw_connections` block
        // above declares `bridge_port INTEGER` without NOT NULL, so a brand-new
        // DB created by this version doesn't need the recreate step). Defer
        // the decision to the postcondition check below.
        log.debug('Migration v14→v15 recreate skipped (table may already match target schema)', { error: err.message });
      }

      // Postcondition: verify bridge_port is actually nullable before advancing
      // schema_version (Critic MAJOR-3). Pre-#160 the silent-skip pattern from
      // older migrations would mark the DB v15 with a v14 schema still in
      // place — subsequent `bridgePort: null` inserts would then fail with
      // SQLITE_CONSTRAINT_NOTNULL. Fail loudly so the user sees the breakage
      // at boot rather than at first save.
      const colInfo = _db.prepare("PRAGMA table_info(openclaw_connections)").all();
      const bridgeCol = colInfo.find((c) => c.name === 'bridge_port');
      if (!bridgeCol || bridgeCol.notnull !== 0) {
        throw new Error(
          `v14→v15 migration did not produce a nullable bridge_port column ` +
          `(notnull=${bridgeCol ? bridgeCol.notnull : 'column missing'}, dflt_value=${bridgeCol ? bridgeCol.dflt_value : 'n/a'}). ` +
          `Aborting — schema_version will NOT advance to 15 until this is resolved. See #160.`
        );
      }
      log.info('Migration v14→v15: bridge_port is now nullable on openclaw_connections (#160)');
    }

    if (currentVersion < 16) {
      // v15→v16: add instance_dir to openclaw_connections (#296). The host path
      // of the instance's compose/.env dir, used to read the OpenClaw image-tag
      // version (`OPENCLAW_IMAGE=...:<tag>`) over SSH for per-connection display.
      try {
        _db.exec('ALTER TABLE openclaw_connections ADD COLUMN instance_dir TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v15→v16: instance_dir column added to openclaw_connections (#296)');
    }

    if (currentVersion < 17) {
      // v16→v17: add migration_status to projects (#262/#354, C1). Tracks a
      // project's V2-plugin migration state for operator follow-up + the C2
      // drift indicator: NULL (untouched) | 'migrated' | 'pending-activation'
      // (ref written, plugin not yet installed on this machine) | 'declined' |
      // 'not-applicable' (non-Claude — the Claude-only plugin can't serve it).
      try {
        _db.exec('ALTER TABLE projects ADD COLUMN migration_status TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v16→v17: migration_status column added to projects (#262)');
    }

    if (currentVersion < 18) {
      // v17→v18: add session_rules table (#347/D1a). Durable operator-authored
      // behavioral directives injected cross-model at session launch, alongside
      // global-rules. NULL project_id = global; the nullable owner column is an
      // auth-ready seam for AUTH/#347. CREATE IF NOT EXISTS in _createTables
      // handles the DDL; this step is a no-op on a fresh schema.
      try {
        _db.exec(`
          CREATE TABLE IF NOT EXISTS session_rules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
            content     TEXT    NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_by  TEXT    NOT NULL DEFAULT 'operator',
            owner       TEXT,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_session_rules_project ON session_rules(project_id);
          CREATE INDEX IF NOT EXISTS idx_session_rules_enabled ON session_rules(enabled);
        `);
      } catch (err) {
        // Table may already exist if _createTables ran with the new schema
        log.debug('Migration v17→v18 skipped (session_rules may already exist)', { error: err.message });
      }
      log.info('Migration v17→v18: session_rules table added (#347/D1a)');
    }

    if (currentVersion < 19) {
      // v18→v19: D1b self-improvement. (1) session_rule_versions table —
      // version history so any autonomous rule edit is reversible (rollback).
      // (2) source_learning_id column on session_rules — provenance for rules
      // promoted from a learning. CREATE IF NOT EXISTS handles a fresh schema;
      // the ALTER backfills an existing v18 session_rules table.
      try {
        _db.exec(`
          CREATE TABLE IF NOT EXISTS session_rule_versions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id       INTEGER NOT NULL,
            version_no    INTEGER NOT NULL,
            op            TEXT    NOT NULL,
            content       TEXT    NOT NULL,
            enabled       INTEGER NOT NULL,
            created_by    TEXT    NOT NULL,
            owner         TEXT,
            changed_by    TEXT    NOT NULL DEFAULT 'operator',
            change_reason TEXT,
            created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_session_rule_versions_rule ON session_rule_versions(rule_id);
        `);
      } catch (err) {
        log.debug('Migration v18→v19 versions table skipped (may already exist)', { error: err.message });
      }
      try {
        _db.exec('ALTER TABLE session_rules ADD COLUMN source_learning_id INTEGER REFERENCES learnings(id) ON DELETE SET NULL');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v18→v19: session_rule_versions table + source_learning_id column added (D1b)');
    }

    if (currentVersion < 20) {
      // v19→v20: CC-6 (#381). Add a `kind` discriminator to session_rules so the
      // per-project Project Rules modal can host three rule kinds — 'startup'
      // (launch-injected, the existing behavior), 'wrap' (read at wrap time / the
      // self-learning sink), and 'mode' (harness posture; runtime = A3). Existing
      // rows backfill to 'startup' so the launch-injection query (which now filters
      // to kind='startup') keeps injecting every pre-existing rule — no regression.
      // CREATE IF NOT EXISTS handles a fresh schema; the ALTER backfills a v19 table.
      try {
        _db.exec("ALTER TABLE session_rules ADD COLUMN kind TEXT NOT NULL DEFAULT 'startup'");
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v19→v20: kind column added to session_rules (CC-6/#381)');
    }

    if (currentVersion < 21) {
      // v20→v21: AUTH-3 (#1). Add a nullable `owner` column to sessions so a
      // session launched behind the Caddy basic_auth gate is stamped with the
      // proxy-authenticated user (from the X-Auth-User header). NULL for every
      // pre-AUTH-3 session and for any session launched in direct mode (no gate),
      // so existing rows need no backfill — unauthenticated == NULL is correct.
      try {
        _db.exec('ALTER TABLE sessions ADD COLUMN owner TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v20→v21: owner column added to sessions (AUTH-3/#1)');
    }

    if (currentVersion < 22) {
      // v21→v22: TB-1 (#357). Add a nullable `orchestration_profile` column to
      // projects — the launch-binder binding. NULL = unbound = today's behavior
      // (zero injection at launch), so existing rows need no backfill. When set,
      // it names a profile in ~/.tangleclaw/orchestration-profiles.json and TC
      // injects that profile's (base_url, key, model) at session launch.
      try {
        _db.exec('ALTER TABLE projects ADD COLUMN orchestration_profile TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v21→v22: orchestration_profile column added to projects (TB-1/#357)');
    }

    _db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
  }

  log.debug('Schema version', { version: CURRENT_SCHEMA_VERSION });
}

/**
 * Sync bundled engine profiles into the user-local engines directory using
 * canonical-source semantics (#251). The tracked file in `data/engines/` is
 * authoritative — on-disk drift is overwritten after a `log.warn`, matching
 * the same shape as `engines.writeEngineConfig` for CLAUDE.md regeneration
 * (#240's drift-aware contract).
 *
 * Rationale for canonical-source: engine profiles have no UI/API edit
 * surface (the `store.engines.save` primitive is unused anywhere outside
 * tests). Any drift on disk is either (a) a stale value from a TC version
 * predating #251 — exactly the case this fix exists to resolve — or (b) a
 * hand-edit to a JSON file in `~/.tangleclaw/engines/`. The pre-#251 merge
 * behaviour preserved (b) but silently stranded (a), which the #250 fallout
 * surfaced: when bundled `openclaw.json#launchModes.*.disabled` flipped
 * from `true` to `false`, the new value never reached existing installs.
 * Canonical-source resolves the ambiguity: bundled wins, drift is logged so
 * an operator with intentional hand-edits gets a breadcrumb pointing at the
 * overwrite.
 *
 * Files present in user-local but NOT in bundled (e.g. a custom engine
 * profile an operator wrote and dropped into `~/.tangleclaw/engines/`) are
 * left alone — the directory is a union of bundled + operator-added.
 *
 * @param {string} srcDir - Bundled engines dir (`data/engines/`).
 * @param {string} destDir - User-local engines dir (`~/.tangleclaw/engines/`).
 */
function _syncBundledEngines(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  }

  const bundledFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.json'));
  for (const file of bundledFiles) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);

    let bundledContent;
    try {
      bundledContent = fs.readFileSync(srcPath, 'utf8');
    } catch (err) {
      log.warn('Could not read bundled engine profile', { file, error: err.message });
      continue;
    }

    // Seed path — first time we see this engine on this install.
    if (!fs.existsSync(destPath)) {
      fs.writeFileSync(destPath, bundledContent, { mode: 0o600 });
      log.debug('Seeded engine profile from bundle (#251)', { file });
      continue;
    }

    // Sync path — compare structurally. JSON whitespace, key order, and
    // trailing newlines are NOT signals; only the parsed shape matters.
    // This avoids spurious drift warnings on installs whose profile was
    // written by an older TC version with different formatting.
    let liveContent;
    try {
      liveContent = fs.readFileSync(destPath, 'utf8');
    } catch (err) {
      log.warn('Could not read live engine profile; overwriting from bundle', { file, error: err.message });
      fs.writeFileSync(destPath, bundledContent, { mode: 0o600 });
      continue;
    }

    if (_engineProfileEquivalent(bundledContent, liveContent)) continue;

    log.warn(
      'Engine profile drifted from bundled; overwriting (canonical-source — #251)',
      {
        file,
        howToInvestigate: 'Engine profiles have no operator-edit UI surface — drift is normally a stale value from a TC version pre-#251. If you intentionally hand-edited ~/.tangleclaw/engines/' + file + ' and want to preserve it, copy the file aside before next restart; the change must land in data/engines/' + file + ' to persist.'
      }
    );
    fs.writeFileSync(destPath, bundledContent, { mode: 0o600 });
  }
}

/**
 * Seed the orchestration-profiles file once from the bundled template, then
 * leave it operator-owned (TB-1/#357). Unlike engine profiles (no operator-edit
 * surface → canonical-source-overwrite is correct there), orchestration
 * profiles carry operator-specific endpoints + key references, so overwriting
 * on every boot would clobber real edits. Seed-if-missing mirrors the
 * `DEFAULT_CONFIG` seed: the bundled file is a template, the operator owns the
 * copy thereafter. New bundled profiles do NOT auto-propagate to an existing
 * install — the operator adds them (or deletes the file to re-seed).
 * @param {string} srcPath - Bundled template (`data/orchestration-profiles.json`).
 * @param {string} destPath - User-local file (`~/.tangleclaw/orchestration-profiles.json`).
 */
function _seedOrchestrationProfiles(srcPath, destPath) {
  if (fs.existsSync(destPath)) return;
  if (!fs.existsSync(srcPath)) return;
  try {
    fs.writeFileSync(destPath, fs.readFileSync(srcPath, 'utf8'), { mode: 0o600 });
    log.info('Seeded orchestration profiles from bundle (TB-1/#357)', { path: destPath });
  } catch (err) {
    log.warn('Could not seed orchestration profiles', { error: err.message });
  }
}

/**
 * Compare two engine-profile JSON strings structurally. Whitespace, key
 * order, and trailing-newline differences are ignored — only the parsed
 * shape matters. Malformed JSON on either side returns false (forces a
 * re-sync), so a corrupted on-disk profile self-heals on next startup.
 *
 * Key-order insensitivity is load-bearing: `JSON.stringify(JSON.parse(x))`
 * alone preserves V8's insertion order, so two profiles with the same
 * keys in different orders would compare unequal and produce a spurious
 * "drifted; overwriting" warn on every restart. The Critic on PR #251
 * caught the false claim in this docstring; `_canonicalize` walks the
 * value and emits sorted-key output so the comparison is truly shape-
 * structural. Arrays preserve order (engine profiles' array fields like
 * `launch.args` are order-significant).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function _engineProfileEquivalent(a, b) {
  try {
    return _canonicalize(JSON.parse(a)) === _canonicalize(JSON.parse(b));
  } catch {
    return false;
  }
}

/**
 * Recursively canonicalize a JSON value to a key-sorted string form.
 * Used only by `_engineProfileEquivalent`; not exported.
 * @param {*} value
 * @returns {string}
 */
function _canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(_canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + _canonicalize(value[k])).join(',') + '}';
}

/**
 * Test whether `needle` appears in `haystack` as an ordered subset — every
 * element of `needle` appears in `haystack` in the same relative order,
 * possibly with intervening elements. Used by `_reconcileOrderedSubset` to
 * decide whether a runtime ordered-list array is a stale-older-version of
 * the bundled array (subset) versus user-customized (not a subset).
 *
 * @param {Array} needle
 * @param {Array} haystack
 * @returns {boolean}
 */
function _isOrderedSubset(needle, haystack) {
  if (!Array.isArray(needle) || !Array.isArray(haystack)) return false;
  let j = 0;
  for (let i = 0; i < needle.length; i++) {
    while (j < haystack.length && haystack[j] !== needle[i]) j++;
    if (j >= haystack.length) return false;
    j++;
  }
  return true;
}

/**
 * Resolve `dotPath` (e.g. `'wrap.steps'`, `'init.directories'`) against
 * `obj` and return the value, or `undefined` if any segment is missing or
 * not an object. Pure read; never mutates.
 *
 * @param {object} obj
 * @param {string} dotPath
 * @returns {*}
 */
function _getAtPath(obj, dotPath) {
  if (!obj || typeof obj !== 'object') return undefined;
  const segs = dotPath.split('.');
  let cur = obj;
  for (const seg of segs) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Assign `value` at `dotPath` in `obj`, mutating `obj`. Intermediate path
 * segments must already exist and be objects (the array path was already
 * confirmed reachable by `_getAtPath` upstream).
 *
 * @param {object} obj
 * @param {string} dotPath
 * @param {*} value
 */
function _setAtPath(obj, dotPath, value) {
  const segs = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]];
  cur[segs[segs.length - 1]] = value;
}

/**
 * Reconcile an ordered-list array. If `live` is a strict ordered subset of
 * `bundled` (stale-older), return a copy of `bundled`. Otherwise (live has
 * elements not in bundled, reordered, or identical) return `null` meaning
 * "leave alone". Mirrors the original #136 `wrap.steps` policy verbatim;
 * the only change is extraction into a pure function so a single driver
 * can dispatch to it across multiple array paths.
 *
 * Acknowledged limitation (carried from #136): a user-removed entry that
 * leaves the array as a strict subset of bundled is indistinguishable from
 * "user is on an older version missing that entry" — both produce the same
 * subset shape, so this policy re-adds. Documented in the #136 CHANGELOG
 * entry and now applies to every array path wired to this policy.
 *
 * @param {Array} live
 * @param {Array} bundled
 * @returns {Array|null} New array to assign, or null to leave alone.
 */
function _reconcileOrderedSubset(live, bundled) {
  if (!Array.isArray(live) || !Array.isArray(bundled)) return null;
  if (live.length < bundled.length && _isOrderedSubset(live, bundled)) {
    return [...bundled];
  }
  return null;
}

/**
 * Reconcile an unordered-set array (string elements). Append bundled
 * entries that are not present in `live`, preserving `live`'s order at
 * the front and appending new entries in their bundled-iteration order.
 * Returns `null` when `live` already contains every bundled entry (no
 * change needed).
 *
 * Strict equality (`===`) is the membership check, so this policy is for
 * primitive-element arrays — string sets like `wrap.captureFields` and
 * `init.directories`. Object-keyed arrays go through `_reconcileMergeBy`.
 *
 * @param {Array} live
 * @param {Array} bundled
 * @returns {Array|null}
 */
function _reconcileSetUnion(live, bundled) {
  if (!Array.isArray(live) || !Array.isArray(bundled)) return null;
  const missing = bundled.filter((entry) => !live.includes(entry));
  if (missing.length === 0) return null;
  return [...live, ...missing];
}

/**
 * Reconcile an object-keyed array. Append bundled entries whose
 * `entry[idKey]` value is not present in any live entry's `idKey`
 * field. Live order is preserved at the front; new bundled entries
 * are appended in bundled-iteration order. Each appended entry is
 * deep-cloned so subsequent mutations on `bundled` (or test reuse)
 * cannot leak into `live`.
 *
 * Match policy: strict equality on `entry[idKey]`. Entries on either
 * side lacking a string-valued `idKey` are skipped for matching
 * purposes — bundled entries without an idKey value cannot be
 * appended (no way to dedupe against live), and live entries without
 * an idKey value are preserved but cannot match against bundled.
 *
 * Acknowledged limitation (symmetric with `_reconcileOrderedSubset`):
 * a user-removed entry whose id no longer appears in `live` is
 * indistinguishable from "user is on an older version that never had
 * this id" — both produce a `live` whose id-set is a subset of
 * `bundled`'s id-set, so this policy re-adds. Documented in ADR 0001
 * alongside the existing orderedSubsetReplace limitation. Tombstones
 * (e.g. a `_removed: [...]` array in `live`) would solve it but are
 * out of scope for this chunk.
 *
 * @param {Array} live
 * @param {Array} bundled
 * @param {string} idKey - Key whose value identifies a logical entry (e.g. 'id' or 'label')
 * @returns {Array|null}
 */
function _reconcileMergeBy(live, bundled, idKey) {
  if (!Array.isArray(live) || !Array.isArray(bundled)) return null;
  if (typeof idKey !== 'string' || idKey.length === 0) return null;
  const liveIds = new Set();
  for (const entry of live) {
    if (entry && typeof entry === 'object' && typeof entry[idKey] === 'string') {
      liveIds.add(entry[idKey]);
    }
  }
  const missing = [];
  for (const entry of bundled) {
    if (!entry || typeof entry !== 'object') continue;
    const id = entry[idKey];
    if (typeof id !== 'string') continue; // bundled entry has no usable key — can't dedupe, skip
    if (liveIds.has(id)) continue;
    missing.push(JSON.parse(JSON.stringify(entry)));
    liveIds.add(id); // protect against bundled duplicates within this pass
  }
  if (missing.length === 0) return null;
  return [...live, ...missing];
}

/**
 * Framework-owned subtree paths (#275). On a `schemaRevision` bump (see
 * `_reconcileFrameworkSubtrees`) these subtrees are replaced wholesale from
 * the bundled template. They encode framework methodology policy that the
 * additive reconcile (`addMissing` / `_reconcileMergeBy` / `_reconcileSetUnion`)
 * structurally cannot propagate when a bundled change is a value-update,
 * step reorder, or entry rename rather than a pure key/entry ADDITION:
 *   - `wrap_pipeline.steps` — step order + each step's `blocker`/`kind`
 *     (e.g. #264 flipped critic-check `blocker: false`→`"errors-only"` and
 *     moved `commit` last; merge-by-id never updates a matched step).
 *   - `actions` — the methodology action buttons + their wording (e.g. #230
 *     renamed "Mark Critic Run"→"Run Critic"; merge-by-label appended the
 *     new label and left the old one as a vestigial duplicate — #266).
 *
 * These subtrees are framework-OWNED: the supported customization path is
 * forking a new methodology `id` via `templates.save`, NOT hand-editing the
 * canonical bundled template's steps/actions in place (the settings UI edits
 * project config — engine, methodology, rules — never these arrays). The
 * accepted trade-off vs the additive policy's anti-clobber stance (ADR 0001)
 * is that an in-place edit to these specific subtrees is overwritten on a
 * schemaRevision bump.
 *
 * @type {string[]}
 */
const FRAMEWORK_OWNED_PATHS = ['wrap_pipeline.steps', 'actions'];

/**
 * Replace framework-owned subtrees (`FRAMEWORK_OWNED_PATHS`) in `live` with
 * deep clones from `bundled`, gated by a monotonic integer `schemaRevision`
 * on the bundled template (#275). Mutates `live` in place.
 *
 * The gate fires only when `bundled.schemaRevision > live.schemaRevision`
 * (a missing / non-integer revision reads as 0). Consequences:
 *   - Templates that never opt in (no bundled `schemaRevision`) are left
 *     entirely to the additive policy — exact pre-#275 behavior, so e.g.
 *     `minimal` and any other un-revisioned bundled template are untouched.
 *   - A bundled bump propagates the value-updates / reorders / renames the
 *     additive passes cannot reach.
 *   - It fires exactly ONCE per bump: `live.schemaRevision` is stamped to the
 *     bundled value, so the next reconcile is a no-op until the next bundled
 *     bump. This bounds clobbering to one event per revision and leaves an
 *     auditable stamp on the live template.
 *
 * Only paths present (non-null) in `bundled` are synced; a path absent from
 * bundled is skipped — this never DELETES a subtree from live. A subtree that
 * already deep-equals bundled is skipped to avoid needless mtime churn.
 *
 * @param {object} bundled - Parsed bundled template
 * @param {object} live - Parsed live template (mutated in place)
 * @param {number} [liveRevOverride] - The live revision captured BEFORE the
 *   additive `addMissing` pass ran. `_mergeBundledTemplate` MUST pass this:
 *   `addMissing` copies `schemaRevision` from bundled into live as a "missing
 *   key", which would otherwise pre-satisfy the gate (`live.schemaRevision`
 *   reads as the bundled value) and suppress the sync. When omitted (direct
 *   unit calls) the live object's own `schemaRevision` is used.
 * @returns {boolean} Whether anything (a subtree or the revision stamp) changed
 */
function _reconcileFrameworkSubtrees(bundled, live, liveRevOverride) {
  const bundledRev = Number.isInteger(bundled.schemaRevision) ? bundled.schemaRevision : 0;
  const liveRev = Number.isInteger(liveRevOverride)
    ? liveRevOverride
    : (Number.isInteger(live.schemaRevision) ? live.schemaRevision : 0);
  if (bundledRev <= liveRev) return false;

  for (const dotPath of FRAMEWORK_OWNED_PATHS) {
    const bundledVal = _getAtPath(bundled, dotPath);
    if (bundledVal === undefined || bundledVal === null) continue;

    // The leaf's parent must be an object to assign into. `addMissing` ran
    // before this and copies any wholly-absent parent from bundled, so the
    // only live state reaching here is "parent present"; guard defensively
    // against a non-object parent (malformed live template) by skipping.
    const segs = dotPath.split('.');
    if (segs.length > 1) {
      const parent = _getAtPath(live, segs.slice(0, -1).join('.'));
      if (!parent || typeof parent !== 'object') continue;
    }

    const cloned = JSON.parse(JSON.stringify(bundledVal));
    if (JSON.stringify(_getAtPath(live, dotPath)) === JSON.stringify(cloned)) continue;
    _setAtPath(live, dotPath, cloned);
  }

  // Stamp the revision whenever bundled is ahead — even if every subtree
  // already matched (e.g. addMissing copied a wholly-absent parent in) — so
  // the gate doesn't re-evaluate the subtrees every boot. The stamp is itself
  // a persisted change, so this pass always reports `true` once the gate opens.
  live.schemaRevision = bundledRev;
  return true;
}

/**
 * Policy table mapping a dot-path in the methodology template to the
 * reconciler function that handles that array. Adding a new path here
 * is the entire wiring step for a newly-tracked array; no driver change
 * needed.
 *
 * Policies (#155):
 *   - `_reconcileOrderedSubset` (Chunk 1) — ordered string lists;
 *     bundled wins only when live is a stale-older strict subset.
 *   - `_reconcileSetUnion` (Chunk 1) — unordered string sets; bundled
 *     adds are appended, live order is preserved.
 *   - `_reconcileMergeBy` (Chunk 2) — object-keyed arrays; bundled
 *     entries with a new `idKey` value are appended, matched by string
 *     equality on the key. Configured per-path via the `idKey` field.
 *
 * Hook arrays (`hooks.<engine>.<event>[]`) are NOT in this table — they
 * have match-by-matcher semantics handled separately by
 * `_mergeBundledHookEntries` (#158).
 *
 * `wrap_pipeline.steps` (#139 Chunk 2) joins via `mergeBy:id` — the new
 * schema's typed step objects each carry an `id` field. The legacy
 * `wrap.steps` / `wrap.captureFields` entries remain in the table as
 * inert safety nets during the migration window: bundled templates no
 * longer ship those paths, so the reconciler short-circuits on missing
 * bundled arrays. They stay until the legacy `wrap` block is excised
 * project-wide.
 *
 * Limitations are documented in ADR 0001 — both `orderedSubsetReplace`
 * and `mergeBy` policies treat a user-removed entry as stale-older and
 * re-add it on reconcile. Tombstones would solve it but are out of
 * scope for #155.
 *
 * @type {Array<{path: string, reconcile: Function, label: string, idKey?: string}>}
 */
const ARRAY_RECONCILERS = [
  { path: 'wrap.steps',           reconcile: _reconcileOrderedSubset, label: 'orderedSubsetReplace' },
  { path: 'prime.sections',       reconcile: _reconcileOrderedSubset, label: 'orderedSubsetReplace' },
  { path: 'wrap.captureFields',   reconcile: _reconcileSetUnion,      label: 'setUnion' },
  { path: 'init.directories',     reconcile: _reconcileSetUnion,      label: 'setUnion' },
  { path: 'phases',               reconcile: _reconcileMergeBy,       label: 'mergeBy', idKey: 'id' },
  { path: 'evalDimensions.tier1', reconcile: _reconcileMergeBy,       label: 'mergeBy', idKey: 'id' },
  { path: 'evalDimensions.tier2', reconcile: _reconcileMergeBy,       label: 'mergeBy', idKey: 'id' },
  { path: 'evalDimensions.tier3', reconcile: _reconcileMergeBy,       label: 'mergeBy', idKey: 'id' },
  { path: 'actions',              reconcile: _reconcileMergeBy,       label: 'mergeBy', idKey: 'label' },
  { path: 'wrap_pipeline.steps',  reconcile: _reconcileMergeBy,       label: 'mergeBy', idKey: 'id' },
];

/**
 * Additively backfill missing keys from bundled hook entries into matched live
 * hook entries. Closes the chunk-1 protection gap (#145 chunk 1) on installs
 * whose runtime methodology template predates the `requires` field — without
 * `requires`, `engines._filterHookEntriesByRequires` is a no-op and orphan
 * hooks still get injected on every session-launch sync.
 *
 * Walks `bundled.hooks.<engine>.<event>[]` and matches each bundled entry to a
 * live entry primarily by `matcher` string (the natural join key). Index
 * fallback applies when matchers collide (duplicate matchers on the live side)
 * or when both sides lack a string matcher.
 *
 * Policy:
 *   - Additive only — backfill keys missing from live; never overwrite an
 *     existing live value; never delete user-added keys; never reorder live
 *     entries; never insert bundled-only entries that have no live match.
 *   - **Entry-level keys only** — backfill operates on hook ENTRY top-level
 *     keys (e.g. `requires`). It does NOT recurse into `entry.hooks[]` inner
 *     command objects, so a missing `statusMessage` on an inner command stays
 *     missing. The chunk-1 protection only needs entry-level `requires`; the
 *     inner-array semantics belong with #155's broader per-array policy work.
 *   - Iterate `bundled.hooks` engines (never trust live alone — we only know
 *     what to backfill from bundled). If live is missing an engine entry
 *     that bundled defines, the helper SKIPS that engine — auto-adding the
 *     engine block is `addMissing`'s job upstream in `_mergeBundledTemplate`.
 *   - Deep-clone backfilled values so subsequent mutations on `bundled` (or
 *     test-suite reuse) can't leak into `live`.
 *
 * Acknowledged limitation: when live has two entries with the same matcher
 * (e.g. a user-added entry sharing a matcher with a bundled entry), matching
 * falls through to bundled-iteration-order index. The first bundled entry
 * with that matcher backfills into the first live entry with that matcher in
 * appearance order. This is documented in the #158 CHANGELOG entry alongside
 * the broader "use one matcher per event" guidance.
 *
 * @param {object} bundled - Parsed bundled template
 * @param {object} live - Parsed live template (mutated in place)
 * @returns {boolean} Whether any keys were added
 */
function _mergeBundledHookEntries(bundled, live) {
  if (!bundled || !live || typeof bundled !== 'object' || typeof live !== 'object') return false;
  const bundledHooks = bundled.hooks;
  const liveHooks = live.hooks;
  if (!bundledHooks || typeof bundledHooks !== 'object' || Array.isArray(bundledHooks)) return false;
  if (!liveHooks || typeof liveHooks !== 'object' || Array.isArray(liveHooks)) return false;

  let changed = false;
  for (const engine of Object.keys(bundledHooks)) {
    const bundledEngine = bundledHooks[engine];
    const liveEngine = liveHooks[engine];
    if (!bundledEngine || typeof bundledEngine !== 'object' || Array.isArray(bundledEngine)) continue;
    if (!liveEngine || typeof liveEngine !== 'object' || Array.isArray(liveEngine)) continue;

    for (const event of Object.keys(bundledEngine)) {
      const bundledEntries = bundledEngine[event];
      const liveEntries = liveEngine[event];
      if (!Array.isArray(bundledEntries) || !Array.isArray(liveEntries)) continue;

      // Per-matcher FIFO queue of live indices — supports duplicate matchers
      // via order-of-appearance fallback. Entries without a string matcher
      // are not put in the queue; they match by absolute index only.
      const liveByMatcher = new Map();
      liveEntries.forEach((entry, idx) => {
        if (entry && typeof entry === 'object' && typeof entry.matcher === 'string') {
          if (!liveByMatcher.has(entry.matcher)) liveByMatcher.set(entry.matcher, []);
          liveByMatcher.get(entry.matcher).push(idx);
        }
      });

      bundledEntries.forEach((bundledEntry, bIdx) => {
        if (!bundledEntry || typeof bundledEntry !== 'object') return;
        const bMatcher = typeof bundledEntry.matcher === 'string' ? bundledEntry.matcher : null;
        let targetIdx = -1;

        if (bMatcher !== null) {
          const queue = liveByMatcher.get(bMatcher);
          if (queue && queue.length > 0) targetIdx = queue.shift();
        } else {
          // Index fallback only when both sides lack a string matcher at the
          // bundled iteration position.
          const liveEntry = liveEntries[bIdx];
          if (liveEntry && typeof liveEntry === 'object' && typeof liveEntry.matcher !== 'string') {
            targetIdx = bIdx;
          }
        }

        if (targetIdx < 0) return;
        const liveEntry = liveEntries[targetIdx];
        if (!liveEntry || typeof liveEntry !== 'object') return;
        for (const key of Object.keys(bundledEntry)) {
          if (!(key in liveEntry)) {
            liveEntry[key] = JSON.parse(JSON.stringify(bundledEntry[key]));
            changed = true;
          }
        }
      });
    }
  }
  return changed;
}

/**
 * Reconcile a single bundled template into a live runtime template.
 *
 * Methodology templates use an add-missing-plus-array-reconcile shape
 * because operators customize methodology surfaces (rules, phases,
 * actions). Engine profiles intentionally use a different shape since
 * #251 — canonical-source overwrite via `_syncBundledEngines` — because
 * they have no operator-edit surface.
 *
 * Reconciliation policies:
 *   1. **Object fields**: recursively add missing keys from bundled into live
 *      (never overwrite, never delete) — same `addMissing` pattern as engine
 *      profiles. Picks up brand-new top-level template fields (e.g. a future
 *      `eval` block) without disturbing user customizations to existing fields.
 *   2. **Plain arrays via `ARRAY_RECONCILERS` table (#155 Chunk 1)**: each
 *      registered array path is reconciled by the policy function bound to
 *      it (`_reconcileOrderedSubset` or `_reconcileSetUnion`). The driver is
 *      table-driven so adding a newly-tracked array path is a one-line
 *      registry entry. `wrap.steps` was the original #136 path and now flows
 *      through the same driver; `prime.sections`, `wrap.captureFields`, and
 *      `init.directories` join in #155 Chunk 1.
 *   3. **Hook entries**: handled separately by `_mergeBundledHookEntries`
 *      (#158) because they have match-by-matcher semantics that don't fit
 *      the plain-array driver.
 *
 * The #136 incident shape — v3.13.7 added `memory-update` to bundled
 * `wrap.steps` but existing installs' runtime copies stayed stale because
 * the one-shot copy in `_copyBundledTemplates` only ran on missing files —
 * is the canonical case for the subset-replace policy.
 *
 * @param {string} bundledPath - Path to bundled template.json
 * @param {string} livePath - Path to live runtime template.json
 */
function _mergeBundledTemplate(bundledPath, livePath) {
  let bundled, live;
  try {
    bundled = JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
    live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  } catch {
    return; // Skip malformed files — same fail-open policy as #119
  }
  if (!bundled || !live || typeof bundled !== 'object' || typeof live !== 'object') return;

  let changed = false;

  // Capture the live schemaRevision BEFORE addMissing runs — addMissing copies
  // `schemaRevision` from bundled into live as a missing key, which would
  // otherwise close the framework-subtree gate before it can fire (#275).
  const liveSchemaRevBefore = Number.isInteger(live.schemaRevision) ? live.schemaRevision : 0;

  /**
   * Recursively add missing keys from src into target.
   * @param {object} target
   * @param {object} src
   * @returns {boolean} Whether any keys were added
   */
  function addMissing(target, src) {
    let added = false;
    for (const key of Object.keys(src)) {
      if (!(key in target)) {
        target[key] = src[key];
        added = true;
      } else if (
        src[key] && typeof src[key] === 'object' && !Array.isArray(src[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
      ) {
        if (addMissing(target[key], src[key])) added = true;
      }
    }
    return added;
  }

  if (addMissing(live, bundled)) changed = true;

  // Array reconciliation via the policy table (#155). `wrap.steps`
  // (originally inline #136) and the three string-array paths added in
  // Chunk 1 flow through the same loop, alongside the object-keyed paths
  // (`phases`, `evalDimensions.tier1/2/3`, `actions`) added in Chunk 2.
  for (const entry of ARRAY_RECONCILERS) {
    const liveArr = _getAtPath(live, entry.path);
    const bundledArr = _getAtPath(bundled, entry.path);
    if (!Array.isArray(liveArr) || !Array.isArray(bundledArr)) continue;
    const reconciled = entry.reconcile(liveArr, bundledArr, entry.idKey);
    if (reconciled === null) {
      if (liveArr.length > 0 && !_isOrderedSubset(liveArr, bundledArr) && entry.label === 'orderedSubsetReplace') {
        log.debug('template array customized; leaving runtime as-is (#155)', {
          file: path.basename(livePath),
          path: entry.path,
        });
      }
      continue;
    }
    _setAtPath(live, entry.path, reconciled);
    changed = true;
    log.info('Reconciled template array from bundled (#155)', {
      file: path.basename(livePath),
      path: entry.path,
      policy: entry.label,
      idKey: entry.idKey,
      addedCount: reconciled.length - liveArr.length,
    });
  }

  // Hook-entry reconciliation (#158). Closes the chunk-1 protection gap on
  // pre-#146 runtime templates by additively backfilling `requires` (and any
  // future additive metadata) into matched live hook entries. See helper
  // header for the match policy + acknowledged limitations.
  if (_mergeBundledHookEntries(bundled, live)) {
    changed = true;
    log.info('Backfilled hook entry fields from bundled template (#158)', {
      file: path.basename(livePath)
    });
  }

  // Framework-owned subtree sync (#275). The additive passes above cannot
  // propagate value-updates, step reorders, or entry renames to an existing
  // install — they only ADD absent keys/entries. This schemaRevision-gated
  // pass replaces the framework-owned subtrees (wrap-pipeline steps + actions)
  // wholesale when the bundled template's `schemaRevision` is ahead of the
  // live copy's. Runs LAST so it wins over any additive append the array
  // reconcilers made to the same paths this pass.
  if (_reconcileFrameworkSubtrees(bundled, live, liveSchemaRevBefore)) {
    changed = true;
    log.info('Synced framework-owned template subtrees on schemaRevision bump (#275)', {
      file: path.basename(livePath),
      schemaRevision: live.schemaRevision
    });
  }

  if (changed) {
    fs.writeFileSync(livePath, JSON.stringify(live, null, 2) + '\n', { mode: 0o600 });
    log.info('Merged new bundled fields into methodology template (#136)', {
      file: path.basename(livePath)
    });
  }
}

/**
 * Copy bundled methodology templates to target directory if target has no
 * templates. For directories that already exist, also reconcile each
 * template.json against its bundled counterpart so post-release additive
 * changes (new wrap.steps entries, new top-level fields) reach existing
 * installs on next server start (#136).
 *
 * @param {string} srcDir - Source directory with bundled templates
 * @param {string} destDir - Destination directory
 */
function _copyBundledTemplates(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  }

  const dirs = fs.readdirSync(srcDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const dir of dirs) {
    const src = path.join(srcDir, dir.name);
    const dest = path.join(destDir, dir.name);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    }
    const srcFiles = fs.readdirSync(src);
    let copied = 0;
    for (const file of srcFiles) {
      const destFile = path.join(dest, file);
      if (!fs.existsSync(destFile)) {
        fs.copyFileSync(path.join(src, file), destFile);
        copied++;
      } else if (file === 'template.json') {
        // Reconcile bundled additive changes into the existing runtime
        // template — #136. Other files (e.g. methodology scripts, README)
        // are left alone; the user owns those after first copy.
        _mergeBundledTemplate(path.join(src, file), destFile);
      }
    }
    if (copied > 0) {
      log.debug('Synced bundled methodology template files', { id: dir.name, copied });
    }
  }
}

/**
 * Get a nested value from an object using dot notation.
 * @param {object} obj - Source object
 * @param {string} key - Dot-separated key path
 * @returns {*}
 */
function _getNestedValue(obj, key) {
  const parts = key.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Set a nested value on an object using dot notation.
 * @param {object} obj - Target object
 * @param {string} key - Dot-separated key path
 * @param {*} value - Value to set
 */
function _setNestedValue(obj, key, value) {
  const parts = key.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

// ── Projects ──

const PROJECT_NAME_REGEX = /^[a-zA-Z0-9 _-]+$/;

const projectsApi = {
  /**
   * List projects from SQLite, filtered by options.
   * @param {object} [options] - Filter options
   * @param {boolean} [options.archived] - Include archived (default false)
   * @param {string} [options.tag] - Filter by tag
   * @param {string} [options.methodology] - Filter by methodology
   * @param {string} [options.engine] - Filter by engine
   * @returns {object[]}
   */
  list(options = {}) {
    _ensureDb();
    const conditions = [];
    const params = [];

    if (!options.archived) {
      conditions.push('archived = 0');
    }
    if (options.methodology) {
      conditions.push('methodology = ?');
      params.push(options.methodology);
    }
    if (options.engine) {
      conditions.push('engine_id = ?');
      params.push(options.engine);
    }

    let sql = 'SELECT * FROM projects';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY name ASC';

    const rows = _db.prepare(sql).all(...params);
    let results = rows.map(_rowToProject);

    // Tag filtering done in JS (JSON column)
    if (options.tag) {
      results = results.filter((p) => p.tags.includes(options.tag));
    }

    return results;
  },

  /**
   * Get a project by id.
   * @param {number} id - Project id
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return row ? _rowToProject(row) : null;
  },

  /**
   * Get a project by name.
   * @param {string} name - Project directory name
   * @returns {object|null}
   */
  getByName(name) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
    return row ? _rowToProject(row) : null;
  },

  /**
   * Case-insensitive lookup by name — used by create / rename validators
   * to detect case-collision duplicates (#221, sibling to #188). Returns
   * the FIRST matching project; on a healthy DB at most one row matches
   * (case-collision creation is rejected by callers, and existing
   * mixed-case names are preserved for display).
   *
   * Distinct from `getByName` so existing callers retain exact-case
   * semantics — only identity-check sites opt into the looser match.
   *
   * @param {string} name
   * @returns {object|null}
   */
  getByNameCaseInsensitive(name) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM projects WHERE name = ? COLLATE NOCASE').get(name);
    return row ? _rowToProject(row) : null;
  },

  /**
   * Create a new project in SQLite.
   * @param {object} data - Project data
   * @param {string} data.name - Project directory name
   * @param {string} data.path - Absolute path
   * @param {string} [data.engine] - Engine profile id
   * @param {string} [data.methodology] - Methodology template id
   * @param {string[]} [data.tags] - Tags
   * @param {object} [data.ports] - Port assignments
   * @returns {object} - Created project with id
   */
  create(data) {
    _ensureDb();
    if (!data.name || !PROJECT_NAME_REGEX.test(data.name)) {
      throw new StoreError(`Invalid project name: "${data.name}". May only contain letters, numbers, spaces, hyphens, and underscores`, 'BAD_REQUEST');
    }
    if (!data.path) {
      throw new StoreError('Project path is required', 'BAD_REQUEST');
    }

    const tags = JSON.stringify(data.tags || []);
    const ports = JSON.stringify(data.ports || {});
    const engineId = data.engine || 'claude';
    const methodology = data.methodology || 'minimal';

    try {
      const stmt = _db.prepare(
        `INSERT INTO projects (name, path, engine_id, methodology, tags, ports)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      stmt.run(data.name, data.path, engineId, methodology, tags, ports);

      const project = projectsApi.getByName(data.name);
      activityApi.log({
        projectId: project.id,
        eventType: 'project.created',
        detail: { name: data.name, engine: engineId, methodology }
      });

      return project;
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        throw new StoreError(`Project "${data.name}" already exists`, 'DUPLICATE_NAME', err);
      }
      throw new StoreError(`Failed to create project: ${err.message}`, 'DB_ERROR', err);
    }
  },

  /**
   * Update a project's metadata.
   * @param {number} id - Project id
   * @param {object} data - Fields to update
   * @returns {object} - Updated project
   */
  update(id, data) {
    _ensureDb();
    const existing = projectsApi.get(id);
    if (!existing) {
      throw new StoreError(`Project id ${id} not found`, 'NOT_FOUND');
    }

    const sets = [];
    const params = [];

    if (data.name !== undefined) {
      sets.push('name = ?');
      params.push(data.name);
      if (existing.name !== data.name) {
        activityApi.log({
          projectId: id,
          eventType: 'project.renamed',
          detail: { from: existing.name, to: data.name }
        });
      }
    }
    if (data.engine_id !== undefined) {
      sets.push('engine_id = ?');
      params.push(data.engine_id);
      if (existing.engineId !== data.engine_id) {
        activityApi.log({
          projectId: id,
          eventType: 'project.engine_changed',
          detail: { from: existing.engineId, to: data.engine_id }
        });
      }
    }
    if (data.methodology !== undefined) {
      sets.push('methodology = ?');
      params.push(data.methodology);
      if (existing.methodology !== data.methodology) {
        activityApi.log({
          projectId: id,
          eventType: 'project.methodology_changed',
          detail: { from: existing.methodology, to: data.methodology }
        });
      }
    }
    if (data.path !== undefined) {
      sets.push('path = ?');
      params.push(data.path);
    }
    if (data.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(data.tags));
    }
    if (data.ports !== undefined) {
      sets.push('ports = ?');
      params.push(JSON.stringify(data.ports));
    }
    if (data.migration_status !== undefined) {
      sets.push('migration_status = ?');
      params.push(data.migration_status);
    }
    if (data.orchestration_profile !== undefined) {
      sets.push('orchestration_profile = ?');
      params.push(data.orchestration_profile);
    }

    if (sets.length === 0) return existing;

    sets.push("updated_at = datetime('now')");
    params.push(id);

    _db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return projectsApi.get(id);
  },

  /**
   * Soft-delete a project (set archived=1).
   * @param {number} id - Project id
   */
  archive(id) {
    _ensureDb();
    _db.prepare("UPDATE projects SET archived = 1, updated_at = datetime('now') WHERE id = ?").run(id);
  },

  /**
   * Restore an archived project (set archived=0).
   * @param {number} id - Project id
   */
  unarchive(id) {
    _ensureDb();
    _db.prepare("UPDATE projects SET archived = 0, updated_at = datetime('now') WHERE id = ?").run(id);
  },

  /**
   * Hard-delete a project from SQLite (cascades to sessions, learnings).
   * Does NOT delete filesystem data.
   * @param {number} id - Project id
   */
  delete(id) {
    _ensureDb();
    const existing = projectsApi.get(id);
    if (existing) {
      activityApi.log({
        projectId: id,
        eventType: 'project.deleted',
        detail: { name: existing.name }
      });
    }
    _db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
};

// ── Sessions (store layer only — lifecycle in lib/sessions.js) ──

const sessionsApi = {
  /**
   * Get the active session for a project.
   * @param {number} projectId - Project id
   * @returns {object|null}
   */
  getActive(projectId) {
    _ensureDb();
    const row = _db.prepare(
      "SELECT * FROM sessions WHERE project_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
    ).get(projectId);
    return row ? _rowToSession(row) : null;
  },

  /**
   * Get a session by its globally-unique id (any status, any project).
   * Public wrapper over the internal id lookup — added for the
   * session-ownership primitive (#347), which resolves a session from a
   * handle even after it has ended (e.g. routing to a known address).
   * @param {number} id - Session id
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    return _getSessionById(id);
  },

  /**
   * List every live session across all projects (status 'active' or
   * 'wrapping'), most-recently-started first. The getActive/list helpers
   * above are project-scoped; this is the fleet-wide view the
   * session-ownership primitive's (#347) listLive() consumer needs.
   * 'wrapping' counts as live: the agent is still running during wrap.
   * @returns {object[]}
   */
  listLiveAll() {
    _ensureDb();
    return _db.prepare(
      "SELECT * FROM sessions WHERE status IN ('active', 'wrapping') ORDER BY started_at DESC"
    ).all().map(_rowToSession);
  },

  /**
   * List sessions for a project.
   * @param {number} projectId - Project id
   * @param {object} [options]
   * @param {string} [options.status] - Filter by status
   * @param {number} [options.limit] - Max results (default 20)
   * @returns {object[]}
   */
  list(projectId, options = {}) {
    _ensureDb();
    let sql = 'SELECT * FROM sessions WHERE project_id = ?';
    const params = [projectId];

    if (options.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    sql += ' ORDER BY started_at DESC';
    sql += ` LIMIT ${options.limit || 20}`;

    return _db.prepare(sql).all(...params).map(_rowToSession);
  },

  /**
   * Get the most recent session for a project (any status).
   * @param {number} projectId - Project id
   * @returns {object|null}
   */
  getLatest(projectId) {
    _ensureDb();
    const row = _db.prepare(
      'SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(projectId);
    return row ? _rowToSession(row) : null;
  },

  /**
   * Count sessions for a project.
   * @param {number} projectId - Project id
   * @param {object} [options]
   * @param {string} [options.status] - Filter by status
   * @returns {number}
   */
  count(projectId, options = {}) {
    _ensureDb();
    let sql = 'SELECT COUNT(*) as count FROM sessions WHERE project_id = ?';
    const params = [projectId];
    if (options.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    const row = _db.prepare(sql).get(...params);
    return row ? row.count : 0;
  },

  /**
   * Start a new session.
   * @param {object} data
   * @param {number} data.projectId - Project id
   * @param {string} data.engineId - Engine profile id
   * @param {string} [data.tmuxSession] - tmux session name
   * @param {string} [data.primePrompt] - Prime prompt text
   * @param {string} [data.methodologyPhase] - Methodology phase at start
   * @param {string} [data.sessionMode='tmux'] - Session mode ('tmux' or 'webui')
   * @returns {object} - Created session
   */
  start(data) {
    _ensureDb();
    if (!data.projectId || !data.engineId) {
      throw new StoreError('projectId and engineId are required', 'BAD_REQUEST');
    }
    const stmt = _db.prepare(
      `INSERT INTO sessions (project_id, engine_id, tmux_session, prime_prompt, methodology_phase, session_mode, launch_mode, owner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      data.projectId,
      data.engineId,
      data.tmuxSession || null,
      data.primePrompt || null,
      data.methodologyPhase || null,
      data.sessionMode || 'tmux',
      data.launchMode || null,
      data.owner || null
    );
    const row = _db.prepare('SELECT * FROM sessions WHERE id = last_insert_rowid()').get();
    const session = _rowToSession(row);
    activityApi.log({
      projectId: data.projectId,
      sessionId: session.id,
      eventType: 'session.started',
      detail: { engine: data.engineId, primeLength: (data.primePrompt || '').length }
    });
    return session;
  },

  /**
   * Set a session to 'wrapping' status (intermediate state before wrapped).
   * Records wrap_started_at so the launch-guard can detect stale wrapping rows.
   * @param {number} id - Session id
   * @returns {object|null} - Updated session, or null if not active
   */
  setWrapping(id) {
    _ensureDb();
    const changed = _db.prepare(
      `UPDATE sessions SET status = 'wrapping', wrap_started_at = datetime('now') WHERE id = ? AND status = 'active'`
    ).run(id);
    if (changed.changes === 0) return null;
    const session = _getSessionById(id);
    if (session) {
      activityApi.log({
        projectId: session.projectId,
        sessionId: id,
        eventType: 'session.wrapping',
        detail: {}
      });
    }
    return session;
  },

  /**
   * Get the wrapping session for a project.
   * @param {number} projectId - Project id
   * @returns {object|null}
   */
  getWrapping(projectId) {
    _ensureDb();
    const row = _db.prepare(
      "SELECT * FROM sessions WHERE project_id = ? AND status = 'wrapping' ORDER BY started_at DESC LIMIT 1"
    ).get(projectId);
    return row ? _rowToSession(row) : null;
  },

  /**
   * Wrap a session (set status='wrapped', capture summary).
   * @param {number} id - Session id
   * @param {string} [summary] - Wrap summary markdown
   * @returns {object} - Updated session
   */
  wrap(id, summary) {
    _ensureDb();
    _db.prepare(
      `UPDATE sessions SET
         status = 'wrapped',
         ended_at = datetime('now'),
         wrap_summary = ?,
         duration_seconds = CAST((julianday(datetime('now')) - julianday(started_at)) * 86400 AS INTEGER)
       WHERE id = ?`
    ).run(summary || null, id);
    const session = _getSessionById(id);
    if (session) {
      activityApi.log({
        projectId: session.projectId,
        sessionId: id,
        eventType: 'session.wrapped',
        detail: { durationSeconds: session.durationSeconds, summaryLength: (summary || '').length }
      });
    }
    return session;
  },

  /**
   * Kill a session (set status='killed').
   * @param {number} id - Session id
   * @param {string} [reason] - Kill reason
   * @returns {object} - Updated session
   */
  kill(id, reason) {
    _ensureDb();
    _db.prepare(
      `UPDATE sessions SET
         status = 'killed',
         ended_at = datetime('now'),
         duration_seconds = CAST((julianday(datetime('now')) - julianday(started_at)) * 86400 AS INTEGER)
       WHERE id = ?`
    ).run(id);
    const session = _getSessionById(id);
    if (session) {
      activityApi.log({
        projectId: session.projectId,
        sessionId: id,
        eventType: 'session.killed',
        detail: { reason: reason || 'Manual kill' }
      });
    }
    return session;
  },

  /**
   * Mark a session as crashed.
   * @param {number} id - Session id
   * @param {string} [error] - Error description
   * @returns {object} - Updated session
   */
  markCrashed(id, error) {
    _ensureDb();
    _db.prepare(
      `UPDATE sessions SET
         status = 'crashed',
         ended_at = datetime('now'),
         duration_seconds = CAST((julianday(datetime('now')) - julianday(started_at)) * 86400 AS INTEGER)
       WHERE id = ?`
    ).run(id);
    const session = _getSessionById(id);
    if (session) {
      activityApi.log({
        projectId: session.projectId,
        sessionId: id,
        eventType: 'session.crashed',
        detail: { error: error || 'Unknown' }
      });
    }
    return session;
  }
};

/**
 * Get a session by id (internal helper).
 * @param {number} id - Session id
 * @returns {object|null}
 */
function _getSessionById(id) {
  const row = _db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return row ? _rowToSession(row) : null;
}

// ── Learnings ──

const learningsApi = {
  /**
   * List learnings for a project.
   * @param {number} projectId - Project id
   * @param {object} [options]
   * @param {string} [options.tier] - Filter by tier
   * @returns {object[]}
   */
  list(projectId, options = {}) {
    _ensureDb();
    let sql = 'SELECT * FROM learnings WHERE project_id = ?';
    const params = [projectId];
    if (options.tier) {
      sql += ' AND tier = ?';
      params.push(options.tier);
    }
    sql += ' ORDER BY created_at DESC';
    return _db.prepare(sql).all(...params).map(_rowToLearning);
  },

  /**
   * Get active learnings for a project (tier='active').
   * @param {number} projectId - Project id
   * @returns {object[]}
   */
  getActive(projectId) {
    _ensureDb();
    return _db.prepare(
      "SELECT * FROM learnings WHERE project_id = ? AND tier = 'active' ORDER BY created_at DESC"
    ).all(projectId).map(_rowToLearning);
  },

  /**
   * Create a new learning.
   * @param {object} data
   * @param {number} data.projectId - Project id
   * @param {string} data.content - Learning content
   * @param {string} [data.tier] - Tier (default 'provisional')
   * @param {number} [data.sourceSession] - Source session id
   * @returns {object}
   */
  create(data) {
    _ensureDb();
    if (!data.projectId || !data.content) {
      throw new StoreError('projectId and content are required', 'BAD_REQUEST');
    }
    _db.prepare(
      'INSERT INTO learnings (project_id, content, tier, source_session) VALUES (?, ?, ?, ?)'
    ).run(data.projectId, data.content, data.tier || 'provisional', data.sourceSession || null);
    const row = _db.prepare('SELECT * FROM learnings WHERE id = last_insert_rowid()').get();
    const learning = _rowToLearning(row);
    activityApi.log({
      projectId: data.projectId,
      eventType: 'learning.captured',
      detail: { tier: learning.tier, contentPreview: data.content.slice(0, 80) }
    });
    return learning;
  },

  /**
   * Confirm a learning (increment count, auto-promote at 2+).
   * @param {number} id - Learning id
   * @returns {object}
   */
  confirm(id) {
    _ensureDb();
    _db.prepare(
      "UPDATE learnings SET confirmed_count = confirmed_count + 1, updated_at = datetime('now') WHERE id = ?"
    ).run(id);

    const row = _db.prepare('SELECT * FROM learnings WHERE id = ?').get(id);
    if (!row) throw new StoreError(`Learning ${id} not found`, 'NOT_FOUND');

    // Auto-promote to active at 2+ confirmations
    if (row.tier === 'provisional' && row.confirmed_count >= 2) {
      _db.prepare(
        "UPDATE learnings SET tier = 'active', updated_at = datetime('now') WHERE id = ?"
      ).run(id);
      activityApi.log({
        projectId: row.project_id,
        eventType: 'learning.promoted',
        detail: { from: 'provisional', to: 'active' }
      });
      const updated = _db.prepare('SELECT * FROM learnings WHERE id = ?').get(id);
      return _rowToLearning(updated);
    }

    return _rowToLearning(row);
  },

  /**
   * Set a learning's tier directly.
   * @param {number} id - Learning id
   * @param {string} tier - New tier
   * @returns {object}
   */
  setTier(id, tier) {
    _ensureDb();
    const validTiers = ['provisional', 'active', 'reference', 'archived'];
    if (!validTiers.includes(tier)) {
      throw new StoreError(`Invalid tier: "${tier}". Must be one of: ${validTiers.join(', ')}`, 'BAD_REQUEST');
    }
    const row = _db.prepare('SELECT * FROM learnings WHERE id = ?').get(id);
    if (!row) throw new StoreError(`Learning ${id} not found`, 'NOT_FOUND');

    const oldTier = row.tier;
    _db.prepare(
      "UPDATE learnings SET tier = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(tier, id);

    if (oldTier !== tier) {
      activityApi.log({
        projectId: row.project_id,
        eventType: 'learning.promoted',
        detail: { from: oldTier, to: tier }
      });
    }

    const updated = _db.prepare('SELECT * FROM learnings WHERE id = ?').get(id);
    return _rowToLearning(updated);
  },

  /**
   * Hard-delete a learning.
   * @param {number} id - Learning id
   */
  delete(id) {
    _ensureDb();
    _db.prepare('DELETE FROM learnings WHERE id = ?').run(id);
  }
};

// ── Session Rules (#347/D1a; self-improvement D1b) ──

/**
 * Append a version snapshot of a session rule's full state (D1b). Called inside
 * create/update/delete/restore so every mutation is reversible. `version_no` is
 * monotonic per `rule_id`. Never throws on a missing row — callers pass the row
 * they already hold.
 * @param {object} ruleRow - Raw session_rules row (the post-mutation state, or
 *   the final state for a delete)
 * @param {string} op - 'create' | 'update' | 'delete' | 'restore'
 * @param {string} [changedBy] - Who made this change ('operator' default | 'ai')
 * @param {string} [changeReason] - Optional human-readable reason
 */
function _snapshotSessionRule(ruleRow, op, changedBy = 'operator', changeReason = null) {
  const next = _db.prepare(
    'SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM session_rule_versions WHERE rule_id = ?'
  ).get(ruleRow.id).n;
  _db.prepare(
    `INSERT INTO session_rule_versions
       (rule_id, version_no, op, content, enabled, created_by, owner, changed_by, change_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ruleRow.id, next, op, ruleRow.content, ruleRow.enabled,
    ruleRow.created_by, ruleRow.owner, changedBy, changeReason
  );
}

/**
 * Valid `session_rules.kind` values (CC-6, #381). 'startup' rules inject into
 * the engine config at launch; 'wrap' rules are read at wrap time (and are the
 * self-learning sink); 'mode' rules carry harness posture (runtime = A3).
 * @type {string[]}
 */
const SESSION_RULE_KINDS = ['startup', 'wrap', 'mode'];

const sessionRulesApi = {
  /**
   * The launch-injection query: active **startup** rules that apply to a project
   * — global rules (project_id IS NULL) plus that project's own rules. Used by
   * `engines._getRulesContent` to build the cross-model `## Session Rules`
   * section at session launch. CC-6 (#381): only `kind='startup'` injects;
   * 'wrap'/'mode' rules are stored + surfaced but not launch-injected. Existing
   * pre-CC-6 rows default to 'startup', so this preserves prior behavior.
   * @param {number|null} projectId - Project id (null/undefined → global only)
   * @returns {object[]}
   */
  listActiveForProject(projectId) {
    _ensureDb();
    return _db.prepare(
      `SELECT * FROM session_rules
       WHERE enabled = 1 AND kind = 'startup' AND (project_id IS NULL OR project_id = ?)
       ORDER BY created_at`
    ).all(projectId ?? null).map(_rowToSessionRule);
  },

  /**
   * List session rules with optional filters (for the UI/API).
   * @param {object} [options]
   * @param {number} [options.enabled] - Filter by enabled (1 or 0)
   * @param {number} [options.projectId] - Filter by exact project id
   * @param {string} [options.scope] - 'global' → only project_id IS NULL
   * @param {string} [options.kind] - CC-6: filter by rule kind ('startup'|'wrap'|'mode')
   * @returns {object[]}
   */
  list(options = {}) {
    _ensureDb();
    const conditions = [];
    const params = [];
    if (options.enabled !== undefined) {
      conditions.push('enabled = ?');
      params.push(options.enabled ? 1 : 0);
    }
    if (options.scope === 'global') {
      conditions.push('project_id IS NULL');
    } else if (options.projectId !== undefined) {
      conditions.push('project_id = ?');
      params.push(options.projectId);
    }
    if (options.kind !== undefined) {
      conditions.push('kind = ?');
      params.push(options.kind);
    }
    let sql = 'SELECT * FROM session_rules';
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC';
    return _db.prepare(sql).all(...params).map(_rowToSessionRule);
  },

  /**
   * Get a single session rule by id.
   * @param {number} id - Rule id
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    return row ? _rowToSessionRule(row) : null;
  },

  /**
   * Create a new session rule.
   * @param {object} data
   * @param {string} data.content - Rule content (required, non-empty)
   * @param {number|null} [data.projectId] - Project id (null = global)
   * @param {string} [data.createdBy] - 'operator' (default) | 'ai'
   * @param {string} [data.kind] - CC-6: 'startup' (default) | 'wrap' | 'mode'
   * @param {string} [data.owner] - Owner identity (auth seam, nullable)
   * @param {number} [data.sourceLearningId] - Provenance: the learning this rule
   *   was promoted from (D1b), nullable
   * @param {string} [data.changeReason] - Optional reason recorded on the v1 snapshot
   * @returns {object}
   */
  create(data) {
    _ensureDb();
    if (!data || !data.content || !data.content.trim()) {
      throw new StoreError('content is required', 'BAD_REQUEST');
    }
    const createdBy = data.createdBy || 'operator';
    const kind = data.kind || 'startup';
    if (!SESSION_RULE_KINDS.includes(kind)) {
      throw new StoreError(`kind must be one of ${SESSION_RULE_KINDS.join(', ')}`, 'BAD_REQUEST');
    }
    _db.prepare(
      'INSERT INTO session_rules (project_id, content, created_by, kind, owner, source_learning_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      data.projectId ?? null,
      data.content.trim(),
      createdBy,
      kind,
      data.owner ?? null,
      data.sourceLearningId ?? null
    );
    const row = _db.prepare('SELECT * FROM session_rules WHERE id = last_insert_rowid()').get();
    _snapshotSessionRule(row, 'create', createdBy, data.changeReason ?? null);
    const rule = _rowToSessionRule(row);
    activityApi.log({
      projectId: rule.projectId,
      eventType: 'session_rule.created',
      detail: { scope: rule.projectId ? 'project' : 'global', kind: rule.kind, createdBy: rule.createdBy, contentPreview: rule.content.slice(0, 80) }
    });
    return rule;
  },

  /**
   * Update a session rule's content and/or enabled flag.
   * @param {number} id - Rule id
   * @param {object} updates
   * @param {string} [updates.content] - New content (non-empty if provided)
   * @param {boolean|number} [updates.enabled] - New enabled state
   * @param {string} [updates.changedBy] - Who made this change ('operator' default | 'ai')
   * @param {string} [updates.changeReason] - Optional reason recorded on the snapshot
   * @returns {object}
   */
  update(id, updates = {}) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    if (!row) throw new StoreError(`Session rule ${id} not found`, 'NOT_FOUND');

    const sets = [];
    const params = [];
    if (updates.content !== undefined) {
      if (!updates.content || !updates.content.trim()) {
        throw new StoreError('content cannot be empty', 'BAD_REQUEST');
      }
      sets.push('content = ?');
      params.push(updates.content.trim());
    }
    if (updates.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(updates.enabled ? 1 : 0);
    }
    if (sets.length === 0) return _rowToSessionRule(row);

    sets.push("updated_at = datetime('now')");
    params.push(id);
    _db.prepare(`UPDATE session_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const updated = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    _snapshotSessionRule(updated, 'update', updates.changedBy || 'operator', updates.changeReason ?? null);
    const rule = _rowToSessionRule(updated);
    activityApi.log({
      projectId: rule.projectId,
      eventType: 'session_rule.updated',
      detail: { enabled: rule.enabled, changedBy: updates.changedBy || 'operator' }
    });
    return rule;
  },

  /**
   * List the version history of a session rule, newest first (D1b).
   * @param {number} ruleId - Rule id
   * @returns {object[]}
   */
  listVersions(ruleId) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM session_rule_versions WHERE rule_id = ? ORDER BY version_no DESC'
    ).all(ruleId).map(_rowToSessionRuleVersion);
  },

  /**
   * Roll a session rule back to a prior version's content + enabled state (D1b).
   * Records a new `op='restore'` snapshot so the rollback itself is in the
   * history. Only restores an EXISTING rule (restoring a deleted rule is out of
   * scope for D1b).
   * @param {number} id - Rule id
   * @param {number} versionNo - Target version number to restore
   * @param {object} [opts]
   * @param {string} [opts.changedBy] - Who triggered the restore ('operator' default | 'ai')
   * @returns {object} - The restored rule
   */
  restore(id, versionNo, opts = {}) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    if (!row) throw new StoreError(`Session rule ${id} not found`, 'NOT_FOUND');
    const version = _db.prepare(
      'SELECT * FROM session_rule_versions WHERE rule_id = ? AND version_no = ?'
    ).get(id, versionNo);
    if (!version) throw new StoreError(`Version ${versionNo} not found for rule ${id}`, 'NOT_FOUND');

    _db.prepare(
      "UPDATE session_rules SET content = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(version.content, version.enabled, id);
    const updated = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    _snapshotSessionRule(updated, 'restore', opts.changedBy || 'operator', `restored to version ${versionNo}`);
    const rule = _rowToSessionRule(updated);
    activityApi.log({
      projectId: rule.projectId,
      eventType: 'session_rule.restored',
      detail: { restoredToVersion: versionNo, changedBy: opts.changedBy || 'operator' }
    });
    return rule;
  },

  /**
   * Promote a learning into a session rule (D1b). Operator-confirmed — the
   * caller (API/agent) is the explicit confirmation; this never auto-runs.
   * Defaults `createdBy='ai'` (the AI proposed it) and records provenance via
   * `source_learning_id`. Content defaults to the learning's text unless
   * overridden.
   * @param {number} learningId - The learning to promote
   * @param {object} [overrides]
   * @param {string} [overrides.content] - Rule content (defaults to learning text)
   * @param {number|null} [overrides.projectId] - Scope (null = global)
   * @param {string} [overrides.createdBy] - Defaults 'ai'
   * @param {string} [overrides.kind] - CC-6: target kind (defaults 'startup'). The
   *   wrap-time self-critique loop promotes into 'wrap'.
   * @returns {object} - The created rule
   */
  promoteFromLearning(learningId, overrides = {}) {
    _ensureDb();
    const learning = _db.prepare('SELECT * FROM learnings WHERE id = ?').get(learningId);
    if (!learning) throw new StoreError(`Learning ${learningId} not found`, 'NOT_FOUND');
    const content = (overrides.content ?? learning.content ?? '').trim();
    if (!content) throw new StoreError('content is required', 'BAD_REQUEST');
    return this.create({
      content,
      projectId: overrides.projectId ?? null,
      createdBy: overrides.createdBy || 'ai',
      kind: overrides.kind || 'startup',
      sourceLearningId: learningId,
      changeReason: `promoted from learning ${learningId}`
    });
  },

  /**
   * Surface CANDIDATE conflicts for a proposed rule (D1b) — active in-scope
   * rules (global + the given project) sharing significant token overlap with
   * the proposed content. This is a NON-AUTHORITATIVE signal for the AI/operator
   * to judge; per the ratified design it does NOT auto-resolve and does NOT
   * decide a conflict — it only narrows what to compare before a Critic-gated
   * review. Returns matches sorted by overlap (most first).
   * @param {string} content - Proposed rule content
   * @param {number|null} [projectId] - Scope to compare within (null = global only)
   * @param {object} [opts]
   * @param {number} [opts.minOverlap] - Minimum shared significant tokens (default 2)
   * @param {string} [opts.kind] - CC-6: only compare against rules of this kind
   *   (a proposed 'wrap' rule shouldn't surface 'startup' rules as conflicts)
   * @returns {Array<{rule: object, overlap: string[]}>}
   */
  findConflictCandidates(content, projectId = null, opts = {}) {
    _ensureDb();
    const minOverlap = opts.minOverlap ?? 2;
    const proposed = _significantTokens(content);
    if (proposed.size === 0) return [];
    const kindClause = opts.kind ? ' AND kind = ?' : '';
    const kindParams = opts.kind ? [opts.kind] : [];
    const active = _db.prepare(
      `SELECT * FROM session_rules
       WHERE enabled = 1 AND (project_id IS NULL OR project_id = ?)${kindClause}
       ORDER BY created_at`
    ).all(projectId ?? null, ...kindParams);
    const matches = [];
    for (const row of active) {
      const tokens = _significantTokens(row.content);
      const overlap = [...proposed].filter((t) => tokens.has(t));
      if (overlap.length >= minOverlap) {
        matches.push({ rule: _rowToSessionRule(row), overlap });
      }
    }
    matches.sort((a, b) => b.overlap.length - a.overlap.length);
    return matches;
  },

  /**
   * Hard-delete a session rule (D1b: snapshots a tombstone first so history
   * survives the delete).
   * @param {number} id - Rule id
   * @param {object} [opts]
   * @param {string} [opts.changedBy] - Who deleted it ('operator' default | 'ai')
   * @param {string} [opts.changeReason] - Optional reason
   */
  delete(id, opts = {}) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    if (!row) throw new StoreError(`Session rule ${id} not found`, 'NOT_FOUND');
    _snapshotSessionRule(row, 'delete', opts.changedBy || 'operator', opts.changeReason ?? null);
    _db.prepare('DELETE FROM session_rules WHERE id = ?').run(id);
    activityApi.log({
      projectId: row.project_id,
      eventType: 'session_rule.deleted',
      detail: { id, changedBy: opts.changedBy || 'operator' }
    });
  }
};

/**
 * Tokenize text into a set of significant lowercased tokens for the
 * conflict-candidate signal (D1b) — words >3 chars, minus a small stopword set.
 * Deliberately simple: this feeds a non-authoritative "rules to compare" hint,
 * not a semantic conflict decision.
 * @param {string} text
 * @returns {Set<string>}
 */
function _significantTokens(text) {
  const STOP = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'over', 'than',
    'then', 'when', 'must', 'always', 'never', 'should', 'before', 'after', 'each',
    'every', 'your', 'will', 'have', 'just', 'only', 'also', 'them', 'they'
  ]);
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 3 && !STOP.has(raw)) out.add(raw);
  }
  return out;
}

// ── Port Leases ──

const portLeasesApi = {
  /**
   * List all port leases, with optional filtering.
   * @param {object} [options]
   * @param {string} [options.project] - Filter by project name
   * @param {string} [options.status] - Filter by status
   * @param {string} [options.host] - Filter by host
   * @returns {object[]}
   */
  list(options = {}) {
    _ensureDb();
    const conditions = [];
    const params = [];

    if (options.project) {
      conditions.push('project = ?');
      params.push(options.project);
    }
    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options.host) {
      conditions.push('host = ?');
      params.push(options.host);
    }

    let sql = 'SELECT * FROM port_leases';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY host ASC, port ASC';

    return _db.prepare(sql).all(...params).map(_rowToLease);
  },

  /**
   * Get a single lease by host and port.
   * @param {number} port
   * @param {string} [host='localhost'] - Host identifier
   * @returns {object|null}
   */
  get(port, host = 'localhost') {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM port_leases WHERE host = ? AND port = ?').get(host, port);
    return row ? _rowToLease(row) : null;
  },

  /**
   * Get all leases for a project.
   * @param {string} project - Project name
   * @returns {object[]}
   */
  getByProject(project) {
    _ensureDb();
    return _db.prepare('SELECT * FROM port_leases WHERE project = ? ORDER BY port ASC')
      .all(project).map(_rowToLease);
  },

  /**
   * Create or update a port lease (upsert by host+port).
   * @param {object} data
   * @param {number} data.port
   * @param {string} data.project
   * @param {string} data.service
   * @param {string} [data.host='localhost'] - Host identifier
   * @param {boolean} [data.permanent]
   * @param {number} [data.ttlMs]
   * @param {string} [data.description]
   * @param {boolean} [data.autoRenew]
   * @returns {object}
   */
  lease(data) {
    _ensureDb();
    if (!data.port || !data.project || !data.service) {
      throw new StoreError('port, project, and service are required', 'BAD_REQUEST');
    }

    const host = data.host || 'localhost';
    const permanent = data.permanent ? 1 : 0;
    const status = data.permanent ? 'permanent' : 'active';
    const ttlMs = data.ttlMs || null;
    const autoRenew = data.autoRenew ? 1 : 0;
    const description = data.description || null;

    let expiresAt = null;
    if (!data.permanent && ttlMs) {
      expiresAt = new Date(Date.now() + ttlMs).toISOString().replace('T', ' ').replace('Z', '');
    }

    _db.prepare(`
      INSERT INTO port_leases (host, port, project, service, status, permanent, ttl_ms, expires_at, last_heartbeat, description, auto_renew)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
      ON CONFLICT(host, port) DO UPDATE SET
        project = excluded.project,
        service = excluded.service,
        status = excluded.status,
        permanent = excluded.permanent,
        ttl_ms = excluded.ttl_ms,
        expires_at = excluded.expires_at,
        last_heartbeat = datetime('now'),
        description = excluded.description,
        auto_renew = excluded.auto_renew,
        updated_at = datetime('now')
    `).run(host, data.port, data.project, data.service, status, permanent, ttlMs, expiresAt, description, autoRenew);

    const lease = portLeasesApi.get(data.port, host);
    activityApi.log({
      eventType: 'port.leased',
      detail: { host, port: data.port, project: data.project, service: data.service, permanent: !!data.permanent }
    });
    return lease;
  },

  /**
   * Release (delete) a lease by host and port.
   * @param {number} port
   * @param {string} [host='localhost'] - Host identifier
   */
  release(port, host = 'localhost') {
    _ensureDb();
    const existing = portLeasesApi.get(port, host);
    _db.prepare('DELETE FROM port_leases WHERE host = ? AND port = ?').run(host, port);
    if (existing) {
      activityApi.log({
        eventType: 'port.released',
        detail: { host, port, project: existing.project, service: existing.service }
      });
    }
  },

  /**
   * Release all leases for a project.
   * @param {string} project
   * @returns {number} - Count of released leases
   */
  releaseByProject(project) {
    _ensureDb();
    const leases = portLeasesApi.getByProject(project);
    _db.prepare('DELETE FROM port_leases WHERE project = ?').run(project);
    for (const lease of leases) {
      activityApi.log({
        eventType: 'port.released',
        detail: { port: lease.port, project, service: lease.service }
      });
    }
    return leases.length;
  },

  /**
   * Rename all leases from one project name to another.
   * @param {string} oldName - Current project name
   * @param {string} newName - New project name
   * @returns {number} - Count of updated leases
   */
  renameProject(oldName, newName) {
    _ensureDb();
    const result = _db.prepare('UPDATE port_leases SET project = ? WHERE project = ?').run(newName, oldName);
    if (result.changes > 0) {
      activityApi.log({
        eventType: 'port.project_renamed',
        detail: { oldName, newName, count: result.changes }
      });
    }
    return result.changes;
  },

  /**
   * Update heartbeat for a port lease, extending expiry if TTL-based.
   * @param {number} port
   * @param {string} [host='localhost'] - Host identifier
   * @returns {object|null}
   */
  heartbeat(port, host = 'localhost') {
    _ensureDb();
    const existing = portLeasesApi.get(port, host);
    if (!existing) return null;

    if (existing.ttlMs && !existing.permanent) {
      const newExpiry = new Date(Date.now() + existing.ttlMs).toISOString().replace('T', ' ').replace('Z', '');
      _db.prepare(`
        UPDATE port_leases SET last_heartbeat = datetime('now'), expires_at = ?, updated_at = datetime('now')
        WHERE host = ? AND port = ?
      `).run(newExpiry, host, port);
    } else {
      _db.prepare(`
        UPDATE port_leases SET last_heartbeat = datetime('now'), updated_at = datetime('now')
        WHERE host = ? AND port = ?
      `).run(host, port);
    }

    return portLeasesApi.get(port, host);
  },

  /**
   * Expire stale non-permanent leases past their expires_at.
   * @returns {number} - Count of expired leases
   */
  expireStale() {
    _ensureDb();
    const stale = _db.prepare(`
      SELECT * FROM port_leases
      WHERE permanent = 0 AND expires_at IS NOT NULL AND expires_at < datetime('now')
        AND status = 'active'
    `).all();

    if (stale.length === 0) return 0;

    _db.prepare(`
      DELETE FROM port_leases
      WHERE permanent = 0 AND expires_at IS NOT NULL AND expires_at < datetime('now')
        AND status = 'active'
    `).run();

    for (const row of stale) {
      activityApi.log({
        eventType: 'port.expired',
        detail: { host: row.host, port: row.port, project: row.project, service: row.service }
      });
    }

    return stale.length;
  },

  /**
   * Check if a port is already leased on a given host.
   * @param {number} port
   * @param {string} [host='localhost'] - Host identifier
   * @returns {object|null} - Existing lease or null
   */
  checkConflict(port, host = 'localhost') {
    _ensureDb();
    const row = _db.prepare(
      "SELECT * FROM port_leases WHERE host = ? AND port = ? AND status IN ('active','permanent')"
    ).get(host, port);
    return row ? _rowToLease(row) : null;
  },

  /**
   * Suggest an alternative free port near the preferred port on a given host.
   * @param {number} preferredPort
   * @param {string} [host='localhost'] - Host identifier
   * @returns {number}
   */
  suggestAlternative(preferredPort, host = 'localhost') {
    _ensureDb();
    const existing = portLeasesApi.get(preferredPort, host);
    if (!existing) return preferredPort;

    // Search upward from preferred port on the same host
    const usedPorts = new Set(
      _db.prepare('SELECT port FROM port_leases WHERE host = ?').all(host).map((r) => r.port)
    );

    for (let p = preferredPort + 1; p < preferredPort + 100; p++) {
      if (!usedPorts.has(p)) return p;
    }

    return preferredPort + 100;
  }
};

// ── Global Rules ──

/**
 * Legacy per-install global-rules path (#240). Prior to the canonical-
 * source migration, this was the live file. Now it's only checked once
 * per process at startup to warn operators upgrading from a pre-#240
 * install that their per-install customizations are no longer read.
 * Recovery instructions are in the warning message + #240's body.
 * @returns {string}
 */
function _legacyGlobalRulesPath() {
  return path.join(_basePath || TANGLECLAW_DIR, 'global-rules.md');
}

let _legacyGlobalRulesWarned = false;
function _maybeWarnLegacyGlobalRulesFile() {
  if (_legacyGlobalRulesWarned) return;
  const legacyPath = _legacyGlobalRulesPath();
  if (!fs.existsSync(legacyPath)) {
    // No legacy file → mark as warned-or-skipped so subsequent loads
    // don't re-stat. The flag means "we've considered this," not
    // "we've emitted." Critic-noted: previously the flag was set
    // before the existence check; now it's set after the work is
    // genuinely done so a future retry-on-load refactor is correct.
    _legacyGlobalRulesWarned = true;
    return;
  }
  try {
    const legacy = fs.readFileSync(legacyPath, 'utf8');
    const canonical = fs.existsSync(BUNDLED_GLOBAL_RULES)
      ? fs.readFileSync(BUNDLED_GLOBAL_RULES, 'utf8')
      : '';
    if (legacy.trim() === canonical.trim()) {
      // Legacy matches canonical → operator is safe; nothing to warn.
      _legacyGlobalRulesWarned = true;
      return;
    }
    // Auto-backup the legacy file ONCE to make recovery trivial even
    // if the operator misses the log warning. Critic-noted MEDIUM:
    // long-running TC server emits the warn only at init, before the
    // UI is connected — the backup is the durable recovery surface.
    // Path is sibling to the legacy file with a versioned suffix so
    // we never overwrite a prior backup.
    const backupPath = legacyPath + '.pre-240-backup';
    let backupCreated = false;
    if (!fs.existsSync(backupPath)) {
      try {
        fs.writeFileSync(backupPath, legacy, 'utf8');
        backupCreated = true;
      } catch (err) {
        log.warn('failed to write legacy global-rules backup', { backupPath, error: err.message });
      }
    }
    log.warn(
      'legacy global-rules file detected and IGNORED (#240); content differs from the tracked canonical source',
      {
        legacyPath,
        canonicalPath: BUNDLED_GLOBAL_RULES,
        backupPath: backupCreated ? backupPath : (fs.existsSync(backupPath) ? backupPath : null),
        legacyBytes: legacy.length,
        canonicalBytes: canonical.length,
        howToRecover: backupCreated || fs.existsSync(backupPath)
          ? `legacy content preserved at ${backupPath}; diff against ${BUNDLED_GLOBAL_RULES} and merge wanted sections via the landing-page Global Rules editor or by editing data/global-rules.md directly and committing`
          : 'review the diff and re-apply intended changes via the landing-page Global Rules editor or by editing data/global-rules.md directly and committing'
      }
    );
    _legacyGlobalRulesWarned = true;
  } catch (err) {
    log.warn('failed to compare legacy global-rules file', { legacyPath, error: err.message });
    _legacyGlobalRulesWarned = true; // don't retry on every load if the file is broken
  }
}

/**
 * Normalize global-rules markdown so cosmetic whitespace doesn't propagate
 * into every regenerated CLAUDE.md (#100). Normalizes CRLF→LF, strips trailing
 * per-line whitespace (skipping lines inside fenced code blocks where trailing
 * whitespace can be semantic), detects and removes a uniform leading indent
 * (skipping a leading H1 since markdown convention puts the H1 at column 0
 * even when the body is indented), collapses runs of 3+ blank lines, and
 * trims leading/trailing blank lines. Idempotent. Non-string input is
 * returned unchanged.
 *
 * @param {string} raw
 * @returns {string}
 */
function _normalizeRulesContent(raw) {
  if (typeof raw !== 'string') return raw;
  if (raw.length === 0) return raw;

  // Normalize line endings first (CRLF/CR → LF). Any \r that survives below
  // is exotic enough to leave alone.
  const lf = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Strip trailing whitespace per line, but only outside fenced code blocks
  // where trailing whitespace can be semantic.
  const fenceRe = /^[ \t]*(```|~~~)/;
  let inFence = false;
  let lines = lf.split('\n').map((l) => {
    if (fenceRe.test(l)) {
      inFence = !inFence;
      return l.replace(/[ \t]+$/, '');
    }
    return inFence ? l : l.replace(/[ \t]+$/, '');
  });

  // H1 convention: if the first non-blank line is `# Heading`, it sits at col 0
  // even when the rest of the doc was uniformly indented. Skip it when scanning
  // for the body's leading indent.
  let firstNonBlank = 0;
  while (firstNonBlank < lines.length && lines[firstNonBlank] === '') firstNonBlank++;
  let scanFrom = firstNonBlank;
  if (firstNonBlank < lines.length && /^#\s/.test(lines[firstNonBlank])) {
    scanFrom = firstNonBlank + 1;
  }

  let minIndent = Infinity;
  for (let i = scanFrom; i < lines.length; i++) {
    if (lines[i].length === 0) continue;
    const m = lines[i].match(/^[ \t]*/);
    const w = m ? m[0].length : 0;
    if (w < minIndent) minIndent = w;
    if (minIndent === 0) break;
  }
  // Uniform dedent applies to all non-blank lines including those inside
  // code fences — relative indent within the fence is preserved by the
  // uniform shift, so semantic structure is intact.
  if (minIndent !== Infinity && minIndent > 0) {
    for (let i = scanFrom; i < lines.length; i++) {
      if (lines[i].length === 0) continue;
      lines[i] = lines[i].slice(minIndent);
    }
  }

  // Collapse 3+ consecutive blank lines to a single blank line.
  const collapsed = [];
  let blanks = 0;
  for (const l of lines) {
    if (l === '') {
      blanks++;
      if (blanks <= 1) collapsed.push(l);
    } else {
      blanks = 0;
      collapsed.push(l);
    }
  }

  // Trim leading/trailing blank lines.
  while (collapsed.length && collapsed[0] === '') collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1] === '') collapsed.pop();

  if (collapsed.length === 0) return '';
  return collapsed.join('\n') + '\n';
}

const globalRulesApi = {
  _normalize: _normalizeRulesContent,

  /**
   * Load global rules from the tracked canonical source (#240).
   *
   * The file is `data/global-rules.md`, git-tracked in the TC repo.
   * UI/API edits AND PR-driven edits both land here — there is no
   * per-install copy anymore. Auto-heals normalization-only diffs by
   * rewriting in-place (#100 behavior preserved).
   *
   * On first call per process, warns if the legacy per-install file
   * still exists with different content (operators upgrading from
   * pre-#240 installs).
   *
   * @returns {string}
   */
  load() {
    _maybeWarnLegacyGlobalRulesFile();
    try {
      if (!fs.existsSync(BUNDLED_GLOBAL_RULES)) {
        log.warn('canonical global-rules file missing', { path: BUNDLED_GLOBAL_RULES });
        return '';
      }
      const raw = fs.readFileSync(BUNDLED_GLOBAL_RULES, 'utf8');
      const normalized = _normalizeRulesContent(raw);
      if (normalized !== raw) {
        try {
          fs.writeFileSync(BUNDLED_GLOBAL_RULES, normalized, 'utf8');
        } catch (err) {
          log.warn('Failed to auto-heal global rules', { path: BUNDLED_GLOBAL_RULES, error: err.message });
        }
      }
      return normalized;
    } catch (err) {
      log.warn('Failed to read global rules', { path: BUNDLED_GLOBAL_RULES, error: err.message });
      return '';
    }
  },

  /**
   * Save updated global rules content to the tracked canonical source (#240).
   * Normalized before persisting (#100). UI/API saves and PR-driven
   * file edits write to the same place — no divergence possible.
   *
   * @param {string} content - New global rules markdown
   */
  save(content) {
    const normalized = _normalizeRulesContent(content);
    fs.mkdirSync(path.dirname(BUNDLED_GLOBAL_RULES), { recursive: true });
    fs.writeFileSync(BUNDLED_GLOBAL_RULES, normalized, 'utf8');
    activityApi.log({ eventType: 'rules.global_updated', detail: { length: normalized.length, path: BUNDLED_GLOBAL_RULES } });
  },

  /**
   * Reset is a no-op under the #240 canonical-source model.
   *
   * Pre-#240 this restored the per-install file from bundled defaults.
   * Under the new model there's no separate "default" — the tracked
   * file at `data/global-rules.md` IS the canonical version. To revert
   * unwanted edits, use `git checkout data/global-rules.md` (or your
   * git workflow's equivalent). Returns the current loaded content
   * unchanged so existing callers don't break.
   *
   * @returns {string} - The current (unchanged) content
   */
  reset() {
    log.warn(
      'store.globalRules.reset() is a no-op under the #240 canonical-source model; use `git checkout data/global-rules.md` to revert',
      { canonicalPath: BUNDLED_GLOBAL_RULES }
    );
    return this.load();
  },

  /**
   * Test-only: redirect the canonical global-rules file path.
   *
   * Production code reads/writes `data/global-rules.md` in TC's repo,
   * which would cause tests to clobber the live file. Tests call this
   * to redirect to a tmp file in their before()/beforeEach() and restore
   * via `_resetBundledGlobalRulesPath` in their after()/afterEach().
   *
   * @param {string} newPath - Absolute path to a writable file
   */
  _setBundledGlobalRulesPath(newPath) {
    BUNDLED_GLOBAL_RULES = newPath;
    _legacyGlobalRulesWarned = false; // reset warn state for tests
  },

  /**
   * Test-only: restore BUNDLED_GLOBAL_RULES to the canonical repo path.
   */
  _resetBundledGlobalRulesPath() {
    BUNDLED_GLOBAL_RULES = path.join(__dirname, '..', 'data', 'global-rules.md');
    _legacyGlobalRulesWarned = false;
  }
};

// ── Activity Log ──

const activityApi = {
  /**
   * Log an activity event. Never throws — failures go to stderr.
   * @param {object} event
   * @param {number} [event.projectId] - Project id
   * @param {number} [event.sessionId] - Session id
   * @param {string} event.eventType - Event type
   * @param {*} [event.detail] - Event detail (will be JSON-stringified)
   */
  log(event) {
    try {
      if (!_db) return;
      const detail = event.detail ? JSON.stringify(event.detail) : null;
      _db.prepare(
        'INSERT INTO activity_log (project_id, session_id, event_type, detail) VALUES (?, ?, ?, ?)'
      ).run(event.projectId || null, event.sessionId || null, event.eventType, detail);
    } catch (err) {
      process.stderr.write(`[activity.log] Failed: ${err.message}\n`);
    }
  },

  /**
   * Query activity log entries.
   * @param {object} [options]
   * @param {number} [options.projectId] - Filter by project
   * @param {number} [options.sessionId] - Filter by session
   * @param {string} [options.eventType] - Filter by event type
   * @param {string} [options.since] - ISO 8601 timestamp
   * @param {number} [options.limit] - Max results (default 50)
   * @returns {object[]}
   */
  query(options = {}) {
    _ensureDb();
    const conditions = [];
    const params = [];

    if (options.projectId) {
      conditions.push('project_id = ?');
      params.push(options.projectId);
    }
    if (options.sessionId) {
      conditions.push('session_id = ?');
      params.push(options.sessionId);
    }
    if (options.eventType) {
      conditions.push('event_type = ?');
      params.push(options.eventType);
    }
    if (options.since) {
      conditions.push('created_at > ?');
      params.push(options.since);
    }

    let sql = 'SELECT * FROM activity_log';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC';
    sql += ` LIMIT ${options.limit || 50}`;

    return _db.prepare(sql).all(...params).map(_rowToActivity);
  }
};

// ── Project Groups ──

const projectGroupsApi = {
  /**
   * List all project groups.
   * @returns {object[]}
   */
  list() {
    _ensureDb();
    return _db.prepare('SELECT * FROM project_groups ORDER BY name ASC').all().map(_rowToGroup);
  },

  /**
   * Get a single group by id.
   * @param {string} id - Group id
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM project_groups WHERE id = ?').get(id);
    return row ? _rowToGroup(row) : null;
  },

  /**
   * Create a new project group.
   * @param {object} data
   * @param {string} data.name - Unique group name
   * @param {string} [data.description] - Group description
   * @returns {object}
   */
  create(data) {
    _ensureDb();
    if (!data.name || !data.name.trim()) {
      throw new StoreError('Group name is required', 'BAD_REQUEST');
    }
    const id = crypto.randomUUID();
    const name = data.name.trim();
    const description = data.description || null;
    const sharedDir = data.sharedDir || null;

    try {
      _db.prepare('INSERT INTO project_groups (id, name, description, shared_dir) VALUES (?, ?, ?, ?)')
        .run(id, name, description, sharedDir);
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        throw new StoreError(`Group name "${name}" already exists`, 'CONFLICT');
      }
      throw err;
    }

    activityApi.log({ eventType: 'group.created', detail: { id, name } });
    return projectGroupsApi.get(id);
  },

  /**
   * Update a project group.
   * @param {string} id - Group id
   * @param {object} data
   * @param {string} [data.name] - New name
   * @param {string} [data.description] - New description
   * @returns {object}
   */
  update(id, data) {
    _ensureDb();
    const existing = projectGroupsApi.get(id);
    if (!existing) {
      throw new StoreError(`Group "${id}" not found`, 'NOT_FOUND');
    }

    const fields = [];
    const params = [];

    if (data.name !== undefined) {
      fields.push('name = ?');
      params.push(data.name.trim());
    }
    if (data.description !== undefined) {
      fields.push('description = ?');
      params.push(data.description);
    }
    if (data.sharedDir !== undefined) {
      fields.push('shared_dir = ?');
      params.push(data.sharedDir || null);
    }

    if (fields.length === 0) return existing;

    params.push(id);
    try {
      _db.prepare(`UPDATE project_groups SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        throw new StoreError(`Group name "${data.name}" already exists`, 'CONFLICT');
      }
      throw err;
    }

    activityApi.log({ eventType: 'group.updated', detail: { id } });
    return projectGroupsApi.get(id);
  },

  /**
   * Delete a project group (cascades to members, docs, locks).
   * @param {string} id - Group id
   */
  delete(id) {
    _ensureDb();
    const existing = projectGroupsApi.get(id);
    if (!existing) {
      throw new StoreError(`Group "${id}" not found`, 'NOT_FOUND');
    }
    _db.prepare('DELETE FROM project_groups WHERE id = ?').run(id);
    activityApi.log({ eventType: 'group.deleted', detail: { id, name: existing.name } });
  },

  /**
   * Add a project to a group.
   * @param {string} groupId - Group id
   * @param {number} projectId - Project id
   */
  addMember(groupId, projectId) {
    _ensureDb();
    try {
      _db.prepare('INSERT INTO project_group_members (group_id, project_id) VALUES (?, ?)')
        .run(groupId, projectId);
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        return; // Already a member — idempotent
      }
      throw err;
    }
    activityApi.log({ eventType: 'group.member_added', detail: { groupId, projectId } });
  },

  /**
   * Remove a project from a group.
   * @param {string} groupId - Group id
   * @param {number} projectId - Project id
   */
  removeMember(groupId, projectId) {
    _ensureDb();
    _db.prepare('DELETE FROM project_group_members WHERE group_id = ? AND project_id = ?')
      .run(groupId, projectId);
    activityApi.log({ eventType: 'group.member_removed', detail: { groupId, projectId } });
  },

  /**
   * List all project ids in a group.
   * @param {string} groupId - Group id
   * @returns {number[]}
   */
  listMembers(groupId) {
    _ensureDb();
    return _db.prepare('SELECT project_id FROM project_group_members WHERE group_id = ? ORDER BY added_at ASC')
      .all(groupId).map(r => r.project_id);
  },

  /**
   * Get all groups a project belongs to.
   * @param {number} projectId - Project id
   * @returns {object[]}
   */
  getByProject(projectId) {
    _ensureDb();
    return _db.prepare(
      `SELECT g.* FROM project_groups g
       INNER JOIN project_group_members m ON g.id = m.group_id
       WHERE m.project_id = ?
       ORDER BY g.name ASC`
    ).all(projectId).map(_rowToGroup);
  }
};

// ── Shared Documents ──

const sharedDocsApi = {
  /**
   * List shared documents, optionally filtered by group.
   * @param {object} [options]
   * @param {string} [options.groupId] - Filter by group id
   * @returns {object[]}
   */
  list(options = {}) {
    _ensureDb();
    let sql = 'SELECT * FROM shared_documents';
    const params = [];

    if (options.groupId) {
      sql += ' WHERE group_id = ?';
      params.push(options.groupId);
    }
    sql += ' ORDER BY name ASC';

    return _db.prepare(sql).all(...params).map(_rowToSharedDoc);
  },

  /**
   * Get a single shared document by id.
   * @param {string} id - Document id
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM shared_documents WHERE id = ?').get(id);
    return row ? _rowToSharedDoc(row) : null;
  },

  /**
   * Register a new shared document.
   * @param {object} data
   * @param {string} data.groupId - Group id
   * @param {string} data.name - Display name
   * @param {string} data.filePath - Absolute path to the shared file
   * @param {boolean} [data.injectIntoConfig] - Whether to inject into engine config
   * @param {string} [data.injectMode] - 'reference' or 'inline'
   * @param {string} [data.description] - What this doc covers
   * @returns {object}
   */
  create(data) {
    _ensureDb();
    if (!data.groupId || !data.name || !data.filePath) {
      throw new StoreError('groupId, name, and filePath are required', 'BAD_REQUEST');
    }

    const id = crypto.randomUUID();
    const injectIntoConfig = data.injectIntoConfig ? 1 : 0;
    const injectMode = data.injectMode || 'reference';

    if (injectMode !== 'reference' && injectMode !== 'inline') {
      throw new StoreError('injectMode must be "reference" or "inline"', 'BAD_REQUEST');
    }

    try {
      _db.prepare(
        `INSERT INTO shared_documents (id, group_id, name, file_path, inject_into_config, inject_mode, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, data.groupId, data.name.trim(), data.filePath, injectIntoConfig, injectMode, data.description || null);
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        throw new StoreError(`Document with path "${data.filePath}" already exists in this group`, 'CONFLICT');
      }
      if (err.message && err.message.includes('FOREIGN KEY')) {
        throw new StoreError(`Group "${data.groupId}" not found`, 'NOT_FOUND');
      }
      throw err;
    }

    activityApi.log({ eventType: 'shared_doc.created', detail: { id, name: data.name, groupId: data.groupId } });
    return sharedDocsApi.get(id);
  },

  /**
   * Update a shared document's metadata.
   * @param {string} id - Document id
   * @param {object} data - Fields to update
   * @returns {object}
   */
  update(id, data) {
    _ensureDb();
    const existing = sharedDocsApi.get(id);
    if (!existing) {
      throw new StoreError(`Shared document "${id}" not found`, 'NOT_FOUND');
    }

    const fields = [];
    const params = [];

    if (data.name !== undefined) {
      fields.push('name = ?');
      params.push(data.name.trim());
    }
    if (data.filePath !== undefined) {
      fields.push('file_path = ?');
      params.push(data.filePath);
    }
    if (data.injectIntoConfig !== undefined) {
      fields.push('inject_into_config = ?');
      params.push(data.injectIntoConfig ? 1 : 0);
    }
    if (data.injectMode !== undefined) {
      if (data.injectMode !== 'reference' && data.injectMode !== 'inline') {
        throw new StoreError('injectMode must be "reference" or "inline"', 'BAD_REQUEST');
      }
      fields.push('inject_mode = ?');
      params.push(data.injectMode);
    }
    if (data.description !== undefined) {
      fields.push('description = ?');
      params.push(data.description);
    }

    if (fields.length === 0) return existing;

    params.push(id);
    _db.prepare(`UPDATE shared_documents SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    activityApi.log({ eventType: 'shared_doc.updated', detail: { id } });
    return sharedDocsApi.get(id);
  },

  /**
   * Unregister a shared document (does NOT delete the file).
   * @param {string} id - Document id
   */
  delete(id) {
    _ensureDb();
    const existing = sharedDocsApi.get(id);
    if (!existing) {
      throw new StoreError(`Shared document "${id}" not found`, 'NOT_FOUND');
    }
    _db.prepare('DELETE FROM shared_documents WHERE id = ?').run(id);
    activityApi.log({ eventType: 'shared_doc.deleted', detail: { id, name: existing.name } });
  },

  /**
   * Get all shared documents for a group.
   * @param {string} groupId - Group id
   * @returns {object[]}
   */
  getByGroup(groupId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM shared_documents WHERE group_id = ? ORDER BY name ASC')
      .all(groupId).map(_rowToSharedDoc);
  },

  /**
   * Sync shared documents from a directory. Scans for .md files and registers
   * new ones, skips already-registered files. Idempotent.
   * @param {string} groupId - Group id
   * @param {string} dirPath - Absolute path to the shared directory
   * @returns {{ added: string[], skipped: string[], errors: string[] }}
   */
  syncFromDirectory(groupId, dirPath) {
    _ensureDb();
    const added = [];
    const skipped = [];
    const errors = [];

    if (!dirPath) {
      errors.push('No directory path provided');
      return { added, skipped, errors };
    }

    if (!fs.existsSync(dirPath)) {
      errors.push(`Directory not found: ${dirPath}`);
      return { added, skipped, errors };
    }

    let stat;
    try {
      stat = fs.statSync(dirPath);
    } catch (err) {
      errors.push(`Cannot access directory: ${err.message}`);
      return { added, skipped, errors };
    }
    if (!stat.isDirectory()) {
      errors.push(`Path is not a directory: ${dirPath}`);
      return { added, skipped, errors };
    }

    // Get existing docs for this group to check by file_path
    const existingDocs = sharedDocsApi.getByGroup(groupId);
    const existingPaths = new Set(existingDocs.map(d => d.filePath));

    // Scan for .md files
    let entries;
    try {
      entries = fs.readdirSync(dirPath);
    } catch (err) {
      errors.push(`Failed to read directory: ${err.message}`);
      return { added, skipped, errors };
    }

    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;

      const filePath = path.join(dirPath, entry);
      try {
        const fileStat = fs.statSync(filePath);
        if (!fileStat.isFile()) continue;
      } catch {
        continue;
      }

      if (existingPaths.has(filePath)) {
        skipped.push(entry);
        continue;
      }

      // Derive name from filename (strip extension)
      const name = path.basename(entry, '.md');

      try {
        sharedDocsApi.create({
          groupId,
          name,
          filePath,
          injectIntoConfig: true,
          injectMode: 'reference'
        });
        added.push(entry);
      } catch (err) {
        errors.push(`Failed to register ${entry}: ${err.message}`);
      }
    }

    if (added.length > 0) {
      activityApi.log({
        eventType: 'shared_docs.synced',
        detail: { groupId, dirPath, added: added.length, skipped: skipped.length }
      });
    }

    return { added, skipped, errors };
  },

  /**
   * Get all injectable shared documents for a project (via group membership).
   * Deduplicates by file_path when a project is in multiple groups with the same file.
   * @param {number} projectId - Project id
   * @returns {object[]} - Each with additional groupName field
   */
  getInjectableForProject(projectId) {
    _ensureDb();
    const rows = _db.prepare(
      `SELECT sd.*, g.name AS group_name
       FROM shared_documents sd
       INNER JOIN project_groups g ON sd.group_id = g.id
       INNER JOIN project_group_members m ON g.id = m.group_id
       WHERE m.project_id = ? AND sd.inject_into_config = 1
       ORDER BY g.name ASC, sd.name ASC`
    ).all(projectId);

    // Deduplicate by file_path — first occurrence wins
    const seen = new Set();
    const results = [];
    for (const row of rows) {
      if (!seen.has(row.file_path)) {
        seen.add(row.file_path);
        const doc = _rowToSharedDoc(row);
        doc.groupName = row.group_name;
        results.push(doc);
      }
    }
    return results;
  }
};

// ── Document Locks ──

const documentLocksApi = {
  /**
   * Acquire an edit lock on a shared document.
   * @param {string} docId - Document id
   * @param {number} sessionId - Session id acquiring the lock
   * @param {string} projectName - Project name for display
   * @param {number} [ttlMinutes] - Lock TTL in minutes (default: 30)
   * @returns {object}
   */
  acquire(docId, sessionId, projectName, ttlMinutes = 30) {
    _ensureDb();

    // Verify document exists
    const doc = sharedDocsApi.get(docId);
    if (!doc) {
      throw new StoreError(`Shared document "${docId}" not found`, 'NOT_FOUND');
    }

    // Check for existing lock
    const existing = documentLocksApi.check(docId);
    if (existing) {
      // Check if expired
      if (existing.expiresAt && new Date(existing.expiresAt) < new Date()) {
        // Expired — remove and allow acquire
        _db.prepare('DELETE FROM document_locks WHERE document_id = ?').run(docId);
      } else {
        throw new StoreError(
          `Document locked by ${existing.lockedByProject} session`,
          'LOCK_CONFLICT'
        );
      }
    }

    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
    _db.prepare(
      `INSERT INTO document_locks (document_id, locked_by_session, locked_by_project, expires_at)
       VALUES (?, ?, ?, ?)`
    ).run(docId, sessionId, projectName, expiresAt);

    activityApi.log({
      eventType: 'doc_lock.acquired',
      sessionId,
      detail: { docId, projectName, expiresAt }
    });

    return documentLocksApi.check(docId);
  },

  /**
   * Release a lock on a shared document.
   * @param {string} docId - Document id
   */
  release(docId) {
    _ensureDb();
    _db.prepare('DELETE FROM document_locks WHERE document_id = ?').run(docId);
    activityApi.log({ eventType: 'doc_lock.released', detail: { docId } });
  },

  /**
   * Release all locks held by a session.
   * @param {number} sessionId - Session id
   * @returns {number} - Number of locks released
   */
  releaseBySession(sessionId) {
    _ensureDb();
    const locks = _db.prepare('SELECT document_id FROM document_locks WHERE locked_by_session = ?')
      .all(sessionId);
    if (locks.length > 0) {
      _db.prepare('DELETE FROM document_locks WHERE locked_by_session = ?').run(sessionId);
      activityApi.log({
        eventType: 'doc_lock.session_released',
        sessionId,
        detail: { count: locks.length }
      });
    }
    return locks.length;
  },

  /**
   * Check lock status for a document.
   * @param {string} docId - Document id
   * @returns {object|null}
   */
  check(docId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM document_locks WHERE document_id = ?').get(docId);
    return row ? _rowToLock(row) : null;
  },

  /**
   * Remove all expired locks.
   * @returns {number} - Number of locks expired
   */
  expireStale() {
    _ensureDb();
    const now = new Date().toISOString();
    const expired = _db.prepare(
      'SELECT document_id FROM document_locks WHERE expires_at IS NOT NULL AND expires_at < ?'
    ).all(now);

    if (expired.length > 0) {
      _db.prepare(
        'DELETE FROM document_locks WHERE expires_at IS NOT NULL AND expires_at < ?'
      ).run(now);
      log.info('Expired stale document locks', { count: expired.length });
      activityApi.log({ eventType: 'doc_lock.expired', detail: { count: expired.length } });
    }
    return expired.length;
  },

  /**
   * Get all locks held by a session.
   * @param {number} sessionId - Session id
   * @returns {object[]}
   */
  getBySession(sessionId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM document_locks WHERE locked_by_session = ?')
      .all(sessionId).map(_rowToLock);
  }
};

// ── OpenClaw Connections ──

const CONNECTION_NAME_REGEX = /^[a-zA-Z0-9 _-]+$/;

const openclawConnectionsApi = {
  /**
   * List all OpenClaw connections.
   * @param {object} [options]
   * @param {boolean} [options.availableAsEngine] - Filter to engine-available only
   * @returns {object[]}
   */
  list(options = {}) {
    _ensureDb();
    let sql = 'SELECT * FROM openclaw_connections';
    const params = [];

    if (options.availableAsEngine !== undefined) {
      sql += ' WHERE available_as_engine = ?';
      params.push(options.availableAsEngine ? 1 : 0);
    }

    sql += ' ORDER BY name ASC';
    return _db.prepare(sql).all(...params).map(_rowToConnection);
  },

  /**
   * Get a single connection by id.
   * @param {string} id - Connection id
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM openclaw_connections WHERE id = ?').get(id);
    return row ? _rowToConnection(row) : null;
  },

  /**
   * Create a new OpenClaw connection.
   * @param {object} data
   * @param {string} data.name - Unique display name
   * @param {string} data.host - Hostname or IP
   * @param {string} data.sshUser - SSH username
   * @param {string} data.sshKeyPath - Path to SSH key
   * @param {number} [data.port] - Remote gateway port (default 18789)
   * @param {string} [data.gatewayToken] - Gateway auth token
   * @param {string} [data.cliCommand] - CLI command (default openclaw-cli)
   * @param {number} [data.localPort] - Local tunnel port (default 18789)
   * @param {boolean} [data.availableAsEngine] - Show in engine dropdown
   * @param {string} [data.defaultMode='ssh'] - Default session mode ('ssh' or 'webui')
   * @returns {object}
   */
  create(data) {
    _ensureDb();
    if (!data.name || !data.name.trim()) {
      throw new StoreError('Connection name is required', 'BAD_REQUEST');
    }
    if (!CONNECTION_NAME_REGEX.test(data.name.trim())) {
      throw new StoreError(
        `Invalid connection name: "${data.name}". May only contain letters, numbers, spaces, hyphens, and underscores`,
        'BAD_REQUEST'
      );
    }
    if (!data.host || !data.host.trim()) {
      throw new StoreError('Host is required', 'BAD_REQUEST');
    }
    if (!data.sshUser || !data.sshUser.trim()) {
      throw new StoreError('SSH user is required', 'BAD_REQUEST');
    }
    if (!data.sshKeyPath || !data.sshKeyPath.trim()) {
      throw new StoreError('SSH key path is required', 'BAD_REQUEST');
    }

    const id = crypto.randomUUID();
    const name = data.name.trim();
    const host = data.host.trim();
    const port = data.port || 18789;
    const sshUser = data.sshUser.trim();
    const sshKeyPath = data.sshKeyPath.trim();
    const gatewayToken = data.gatewayToken || null;
    const cliCommand = data.cliCommand || 'openclaw-cli';
    const localPort = data.localPort || 18789;
    const availableAsEngine = data.availableAsEngine ? 1 : 0;
    const defaultMode = (data.defaultMode === 'webui') ? 'webui' : 'ssh';
    const auditSecret = data.auditSecret || null;
    // bridgePort is optional. Most non-ClawBridge OpenClaw deployments don't
    // expose a Bridge port; persist null so `server.js` skips the extra `-L`
    // SSH forward (avoiding the local-bind conflicts documented in #160).
    const bridgePort = (data.bridgePort === undefined || data.bridgePort === null || data.bridgePort === '')
      ? null
      : data.bridgePort;
    const bridgeToken = data.bridgeToken || null;
    // instanceDir (#296): host path of the OpenClaw instance dir (its compose/.env),
    // used to read the image-tag version over SSH. Optional; null when unset.
    const instanceDir = data.instanceDir ? String(data.instanceDir).trim() : null;

    try {
      _db.prepare(
        `INSERT INTO openclaw_connections (id, name, host, port, ssh_user, ssh_key_path, gateway_token, cli_command, local_port, available_as_engine, default_mode, audit_secret, bridge_port, bridge_token, instance_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, name, host, port, sshUser, sshKeyPath, gatewayToken, cliCommand, localPort, availableAsEngine, defaultMode, auditSecret, bridgePort, bridgeToken, instanceDir);
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        throw new StoreError(`Connection name "${name}" already exists`, 'CONFLICT');
      }
      throw new StoreError(`Failed to create connection: ${err.message}`, 'DB_ERROR', err);
    }

    activityApi.log({ eventType: 'openclaw.connection_created', detail: { id, name, host } });
    return openclawConnectionsApi.get(id);
  },

  /**
   * Update an OpenClaw connection.
   * @param {string} id - Connection id
   * @param {object} data - Fields to update
   * @returns {object}
   */
  update(id, data) {
    _ensureDb();
    const existing = openclawConnectionsApi.get(id);
    if (!existing) {
      throw new StoreError(`Connection "${id}" not found`, 'NOT_FOUND');
    }

    const fields = [];
    const params = [];

    if (data.name !== undefined) {
      const name = data.name.trim();
      if (!name) throw new StoreError('Connection name cannot be empty', 'BAD_REQUEST');
      if (!CONNECTION_NAME_REGEX.test(name)) {
        throw new StoreError(
          `Invalid connection name: "${data.name}". May only contain letters, numbers, spaces, hyphens, and underscores`,
          'BAD_REQUEST'
        );
      }
      fields.push('name = ?');
      params.push(name);
    }
    if (data.host !== undefined) {
      fields.push('host = ?');
      params.push(data.host.trim());
    }
    if (data.port !== undefined) {
      fields.push('port = ?');
      params.push(data.port);
    }
    if (data.sshUser !== undefined) {
      fields.push('ssh_user = ?');
      params.push(data.sshUser.trim());
    }
    if (data.sshKeyPath !== undefined) {
      fields.push('ssh_key_path = ?');
      params.push(data.sshKeyPath.trim());
    }
    if (data.gatewayToken !== undefined) {
      fields.push('gateway_token = ?');
      params.push(data.gatewayToken || null);
    }
    if (data.cliCommand !== undefined) {
      fields.push('cli_command = ?');
      params.push(data.cliCommand || 'openclaw-cli');
    }
    if (data.localPort !== undefined) {
      fields.push('local_port = ?');
      params.push(data.localPort);
    }
    if (data.availableAsEngine !== undefined) {
      fields.push('available_as_engine = ?');
      params.push(data.availableAsEngine ? 1 : 0);
    }
    if (data.defaultMode !== undefined) {
      fields.push('default_mode = ?');
      params.push((data.defaultMode === 'webui') ? 'webui' : 'ssh');
    }
    if (data.auditSecret !== undefined) {
      fields.push('audit_secret = ?');
      params.push(data.auditSecret || null);
    }
    if (data.bridgePort !== undefined) {
      fields.push('bridge_port = ?');
      // Empty-string sentinel from form serialization is coerced to null —
      // same policy as create() so PATCH-to-clear actually clears (#160).
      params.push(data.bridgePort === '' ? null : data.bridgePort);
    }
    if (data.bridgeToken !== undefined) {
      fields.push('bridge_token = ?');
      params.push(data.bridgeToken || null);
    }
    if (data.instanceDir !== undefined) {
      fields.push('instance_dir = ?');
      params.push(data.instanceDir ? String(data.instanceDir).trim() : null);
    }

    if (fields.length === 0) return existing;

    params.push(id);
    try {
      _db.prepare(`UPDATE openclaw_connections SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE')) {
        throw new StoreError(`Connection name "${data.name}" already exists`, 'CONFLICT');
      }
      throw err;
    }

    activityApi.log({ eventType: 'openclaw.connection_updated', detail: { id } });
    return openclawConnectionsApi.get(id);
  },

  /**
   * Delete an OpenClaw connection.
   * @param {string} id - Connection id
   */
  delete(id) {
    _ensureDb();
    const existing = openclawConnectionsApi.get(id);
    if (!existing) {
      throw new StoreError(`Connection "${id}" not found`, 'NOT_FOUND');
    }
    _db.prepare('DELETE FROM openclaw_connections WHERE id = ?').run(id);
    activityApi.log({ eventType: 'openclaw.connection_deleted', detail: { id, name: existing.name } });
  }
};

// ── Eval Audit: Exchanges ──

const evalExchangesApi = {
  /**
   * Insert a new exchange record.
   * @param {object} data - Exchange data
   * @returns {object}
   */
  insert(data) {
    _ensureDb();
    const id = data.id || crypto.randomUUID();
    _db.prepare(
      `INSERT INTO eval_exchanges (id, session_id, connection_id, project, agent_model, timestamp, turn_number, user_message, agent_response, agent_thinking, usage_input_tokens, usage_output_tokens, scored)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.sessionId,
      data.connectionId || null,
      data.project,
      data.agentModel || null,
      data.timestamp,
      data.turnNumber || null,
      data.userMessage,
      data.agentResponse,
      data.agentThinking || null,
      data.usageInputTokens || null,
      data.usageOutputTokens || null,
      data.scored || 0
    );
    return evalExchangesApi.get(id);
  },

  /**
   * Get a single exchange by id.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM eval_exchanges WHERE id = ?').get(id);
    return row ? _rowToEvalExchange(row) : null;
  },

  /**
   * List exchanges with optional filters.
   * @param {object} [options]
   * @param {string} [options.sessionId]
   * @param {string} [options.project]
   * @param {number} [options.scored] - 0=pending, 1=scored, 2=skipped(sampling), 3=skipped(cost cap)
   * @param {string} [options.from] - ISO date lower bound
   * @param {string} [options.to] - ISO date upper bound
   * @param {number} [options.limit]
   * @returns {object[]}
   */
  list(options = {}) {
    _ensureDb();
    const clauses = [];
    const params = [];

    if (options.sessionId) { clauses.push('session_id = ?'); params.push(options.sessionId); }
    if (options.project) { clauses.push('project = ?'); params.push(options.project); }
    if (options.scored !== undefined) { clauses.push('scored = ?'); params.push(options.scored); }
    if (options.from) { clauses.push('timestamp >= ?'); params.push(options.from); }
    if (options.to) { clauses.push('timestamp <= ?'); params.push(options.to); }

    let sql = 'SELECT * FROM eval_exchanges';
    if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY timestamp ASC';
    if (options.limit) { sql += ' LIMIT ?'; params.push(options.limit); }

    return _db.prepare(sql).all(...params).map(_rowToEvalExchange);
  },

  /**
   * Update the scored status of an exchange.
   * @param {string} id
   * @param {number} scored - 0=pending, 1=scored, 2=skipped(sampling), 3=skipped(cost cap)
   */
  updateScored(id, scored) {
    _ensureDb();
    _db.prepare('UPDATE eval_exchanges SET scored = ? WHERE id = ?').run(scored, id);
  },

  /**
   * Count exchanges matching filters.
   * @param {object} [options]
   * @param {string} [options.project]
   * @param {string} [options.sessionId]
   * @returns {number}
   */
  count(options = {}) {
    _ensureDb();
    const clauses = [];
    const params = [];
    if (options.project) { clauses.push('project = ?'); params.push(options.project); }
    if (options.sessionId) { clauses.push('session_id = ?'); params.push(options.sessionId); }

    let sql = 'SELECT COUNT(*) as count FROM eval_exchanges';
    if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ');

    return _db.prepare(sql).get(...params).count;
  },

  /**
   * List distinct sessions for a project with exchange counts and timestamps.
   * @param {string} project
   * @param {object} [options]
   * @param {number} [options.limit=10]
   * @returns {object[]}
   */
  listSessions(project, options = {}) {
    _ensureDb();
    const limit = options.limit || 10;
    const rows = _db.prepare(`
      SELECT session_id,
             COUNT(*) as exchange_count,
             MIN(timestamp) as first_timestamp,
             MAX(timestamp) as last_timestamp
      FROM eval_exchanges
      WHERE project = ?
      GROUP BY session_id
      ORDER BY MAX(timestamp) DESC
      LIMIT ?
    `).all(project, limit);

    return rows.map(row => ({
      sessionId: row.session_id,
      exchangeCount: row.exchange_count,
      firstTimestamp: row.first_timestamp,
      lastTimestamp: row.last_timestamp
    }));
  },

  /**
   * Purge exchanges (and their scores) older than a cutoff date.
   * @param {string} cutoffDate - ISO date string; exchanges with timestamp < this are deleted
   * @returns {{ exchangesPurged: number, scoresPurged: number }}
   */
  purgeOlderThan(cutoffDate) {
    _ensureDb();
    // Delete scores first (FK dependency)
    const scoreResult = _db.prepare(
      'DELETE FROM eval_scores WHERE exchange_id IN (SELECT id FROM eval_exchanges WHERE timestamp < ?)'
    ).run(cutoffDate);
    const scoresPurged = scoreResult.changes;

    const exchResult = _db.prepare(
      'DELETE FROM eval_exchanges WHERE timestamp < ?'
    ).run(cutoffDate);
    const exchangesPurged = exchResult.changes;

    return { exchangesPurged, scoresPurged };
  }
};

// ── Eval Audit: Scores ──

const evalScoresApi = {
  /**
   * Insert a score record for an exchange.
   * @param {object} data - Score data
   * @returns {object}
   */
  insert(data) {
    _ensureDb();
    const id = data.id || crypto.randomUUID();
    _db.prepare(
      `INSERT INTO eval_scores (id, exchange_id, schema_version, judge_model, scored_at, methodology,
        tier_1_structural_score, tier_1_flags,
        tier_2_semantic_score, tier_2_reasoning, tier_2_skipped,
        tier_2_5_alignment_score, tier_2_5_reasoning, tier_2_5_skipped,
        tier_3_behavioral_score, tier_3_dimension_scores, tier_3_skipped,
        anomaly_flag, anomaly_reason, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.exchangeId,
      data.schemaVersion,
      data.judgeModel,
      data.scoredAt,
      data.methodology || null,
      data.tier1StructuralScore ?? null,
      data.tier1Flags ? JSON.stringify(data.tier1Flags) : null,
      data.tier2SemanticScore ?? null,
      data.tier2Reasoning || null,
      data.tier2Skipped ? 1 : 0,
      data.tier2_5AlignmentScore ?? null,
      data.tier2_5Reasoning || null,
      data.tier2_5Skipped ? 1 : 0,
      data.tier3BehavioralScore ?? null,
      data.tier3DimensionScores ? JSON.stringify(data.tier3DimensionScores) : null,
      data.tier3Skipped ? 1 : 0,
      data.anomalyFlag ? 1 : 0,
      data.anomalyReason || null,
      data.costUsd ?? null
    );
    return evalScoresApi.get(id);
  },

  /**
   * Update Tier 2/3 scoring fields on an existing score record.
   * @param {string} id - Score record id
   * @param {object} data - Fields to update (tier2*, tier3*, tier2_5*, anomaly*, costUsd, judgeModel)
   * @returns {object|null}
   */
  update(id, data) {
    _ensureDb();
    const sets = [];
    const params = [];

    if (data.judgeModel !== undefined) { sets.push('judge_model = ?'); params.push(data.judgeModel); }
    if (data.tier2SemanticScore !== undefined) { sets.push('tier_2_semantic_score = ?'); params.push(data.tier2SemanticScore); }
    if (data.tier2Reasoning !== undefined) { sets.push('tier_2_reasoning = ?'); params.push(data.tier2Reasoning); }
    if (data.tier2Skipped !== undefined) { sets.push('tier_2_skipped = ?'); params.push(data.tier2Skipped ? 1 : 0); }
    if (data.tier2_5AlignmentScore !== undefined) { sets.push('tier_2_5_alignment_score = ?'); params.push(data.tier2_5AlignmentScore); }
    if (data.tier2_5Reasoning !== undefined) { sets.push('tier_2_5_reasoning = ?'); params.push(data.tier2_5Reasoning); }
    if (data.tier2_5Skipped !== undefined) { sets.push('tier_2_5_skipped = ?'); params.push(data.tier2_5Skipped ? 1 : 0); }
    if (data.tier3BehavioralScore !== undefined) { sets.push('tier_3_behavioral_score = ?'); params.push(data.tier3BehavioralScore); }
    if (data.tier3DimensionScores !== undefined) { sets.push('tier_3_dimension_scores = ?'); params.push(data.tier3DimensionScores ? JSON.stringify(data.tier3DimensionScores) : null); }
    if (data.tier3Skipped !== undefined) { sets.push('tier_3_skipped = ?'); params.push(data.tier3Skipped ? 1 : 0); }
    if (data.anomalyFlag !== undefined) { sets.push('anomaly_flag = ?'); params.push(data.anomalyFlag ? 1 : 0); }
    if (data.anomalyReason !== undefined) { sets.push('anomaly_reason = ?'); params.push(data.anomalyReason); }
    if (data.costUsd !== undefined) { sets.push('cost_usd = ?'); params.push(data.costUsd); }

    if (sets.length === 0) return evalScoresApi.get(id);

    params.push(id);
    _db.prepare(`UPDATE eval_scores SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return evalScoresApi.get(id);
  },

  /**
   * Get a single score by id.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM eval_scores WHERE id = ?').get(id);
    return row ? _rowToEvalScore(row) : null;
  },

  /**
   * Get score for a specific exchange.
   * @param {string} exchangeId
   * @returns {object|null}
   */
  getByExchange(exchangeId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM eval_scores WHERE exchange_id = ?').get(exchangeId);
    return row ? _rowToEvalScore(row) : null;
  },

  /**
   * List scores with optional filters.
   * @param {object} [options]
   * @param {string} [options.methodology]
   * @param {string} [options.from] - ISO date lower bound on scored_at
   * @param {string} [options.to] - ISO date upper bound on scored_at
   * @param {boolean} [options.anomaliesOnly] - Only return flagged anomalies
   * @param {number} [options.limit]
   * @returns {object[]}
   */
  list(options = {}) {
    _ensureDb();
    const clauses = [];
    const params = [];

    if (options.methodology) { clauses.push('methodology = ?'); params.push(options.methodology); }
    if (options.from) { clauses.push('scored_at >= ?'); params.push(options.from); }
    if (options.to) { clauses.push('scored_at <= ?'); params.push(options.to); }
    if (options.anomaliesOnly) { clauses.push('anomaly_flag = 1'); }

    let sql = 'SELECT * FROM eval_scores';
    if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY scored_at DESC';
    if (options.limit) { sql += ' LIMIT ?'; params.push(options.limit); }

    return _db.prepare(sql).all(...params).map(_rowToEvalScore);
  },

  /**
   * List scores joined with exchange data for a project.
   * @param {string} project
   * @param {object} [options]
   * @param {string} [options.from]
   * @param {string} [options.to]
   * @param {boolean} [options.anomaliesOnly]
   * @param {number} [options.limit]
   * @returns {object[]}
   */
  listByProject(project, options = {}) {
    _ensureDb();
    const clauses = ['e.project = ?'];
    const params = [project];

    if (options.from) { clauses.push('s.scored_at >= ?'); params.push(options.from); }
    if (options.to) { clauses.push('s.scored_at <= ?'); params.push(options.to); }
    if (options.anomaliesOnly) { clauses.push('s.anomaly_flag = 1'); }

    let sql = `SELECT s.*, e.project, e.session_id, e.turn_number, e.timestamp as exchange_timestamp
               FROM eval_scores s JOIN eval_exchanges e ON s.exchange_id = e.id
               WHERE ${clauses.join(' AND ')}
               ORDER BY s.scored_at DESC`;
    if (options.limit) { sql += ' LIMIT ?'; params.push(options.limit); }

    return _db.prepare(sql).all(...params).map(row => ({
      ..._rowToEvalScore(row),
      project: row.project,
      sessionId: row.session_id,
      turnNumber: row.turn_number,
      exchangeTimestamp: row.exchange_timestamp
    }));
  },

  /**
   * Update human scoring fields on an existing score record.
   * @param {string} id - Score record id
   * @param {object} data - { score: 1-5, comment?: string }
   * @returns {object|null}
   */
  updateHumanScore(id, data) {
    _ensureDb();
    _db.prepare(
      'UPDATE eval_scores SET human_score = ?, human_comment = ?, human_scored_at = ? WHERE id = ?'
    ).run(data.score, data.comment || null, new Date().toISOString(), id);
    return evalScoresApi.get(id);
  },

  /**
   * Get total accumulated cost for a session.
   * @param {string} sessionId
   * @returns {number}
   */
  getSessionCost(sessionId) {
    _ensureDb();
    const row = _db.prepare(
      'SELECT COALESCE(SUM(s.cost_usd), 0) as total FROM eval_scores s JOIN eval_exchanges e ON s.exchange_id = e.id WHERE e.session_id = ?'
    ).get(sessionId);
    return row ? row.total : 0;
  }
};

// ── Eval Audit: Baselines ──

const evalBaselinesApi = {
  /**
   * Insert a baseline record.
   * @param {object} data
   * @returns {object}
   */
  insert(data) {
    _ensureDb();
    const id = data.id || crypto.randomUUID();
    _db.prepare(
      `INSERT INTO eval_baselines (id, project, methodology, computed_at, window_start, window_end, dimension_averages, exchange_count, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.project,
      data.methodology || null,
      data.computedAt,
      data.windowStart,
      data.windowEnd,
      JSON.stringify(data.dimensionAverages),
      data.exchangeCount,
      data.schemaVersion
    );
    return evalBaselinesApi.get(id);
  },

  /**
   * Get a single baseline by id.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM eval_baselines WHERE id = ?').get(id);
    return row ? _rowToEvalBaseline(row) : null;
  },

  /**
   * Get the latest baseline for a project.
   * @param {string} project
   * @param {string} [methodology]
   * @returns {object|null}
   */
  getLatest(project, methodology) {
    _ensureDb();
    let sql = 'SELECT * FROM eval_baselines WHERE project = ?';
    const params = [project];
    if (methodology) { sql += ' AND methodology = ?'; params.push(methodology); }
    sql += ' ORDER BY computed_at DESC LIMIT 1';
    const row = _db.prepare(sql).get(...params);
    return row ? _rowToEvalBaseline(row) : null;
  },

  /**
   * List baselines for a project.
   * @param {string} project
   * @returns {object[]}
   */
  list(project) {
    _ensureDb();
    return _db.prepare('SELECT * FROM eval_baselines WHERE project = ? ORDER BY computed_at DESC')
      .all(project).map(_rowToEvalBaseline);
  }
};

// ── Eval Incidents ──

const evalIncidentsApi = {
  /**
   * Insert an incident record.
   * @param {object} data
   * @returns {object}
   */
  insert(data) {
    _ensureDb();
    const id = data.id || crypto.randomUUID();
    _db.prepare(
      `INSERT INTO eval_incidents (id, project, type, status, severity, title, description, metadata, detected_at, resolved_at, resolved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.project,
      data.type,
      data.status || 'open',
      data.severity || 'warning',
      data.title,
      data.description,
      data.metadata ? JSON.stringify(data.metadata) : null,
      data.detectedAt,
      data.resolvedAt || null,
      data.resolvedBy || null
    );
    return evalIncidentsApi.get(id);
  },

  /**
   * Get a single incident by id.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM eval_incidents WHERE id = ?').get(id);
    return row ? _rowToEvalIncident(row) : null;
  },

  /**
   * List incidents for a project with optional filtering.
   * @param {string} project
   * @param {object} [options]
   * @param {string} [options.status] - Filter by status ('open', 'accepted', 'dismissed')
   * @param {string} [options.type] - Filter by type ('drift', 'anomaly_spike', 'tier1_cluster')
   * @param {number} [options.limit] - Max results (default 50)
   * @returns {object[]}
   */
  list(project, options) {
    _ensureDb();
    const opts = options || {};
    let sql = 'SELECT * FROM eval_incidents WHERE project = ?';
    const params = [project];
    if (opts.status) { sql += ' AND status = ?'; params.push(opts.status); }
    if (opts.type) { sql += ' AND type = ?'; params.push(opts.type); }
    sql += ' ORDER BY detected_at DESC';
    sql += ` LIMIT ${opts.limit || 50}`;
    return _db.prepare(sql).all(...params).map(_rowToEvalIncident);
  },

  /**
   * Update an incident (status, resolved_at, resolved_by).
   * @param {string} id
   * @param {object} data
   * @returns {object|null}
   */
  update(id, data) {
    _ensureDb();
    const sets = [];
    const params = [];
    if (data.status !== undefined) { sets.push('status = ?'); params.push(data.status); }
    if (data.resolvedAt !== undefined) { sets.push('resolved_at = ?'); params.push(data.resolvedAt); }
    if (data.resolvedBy !== undefined) { sets.push('resolved_by = ?'); params.push(data.resolvedBy); }
    if (sets.length === 0) return evalIncidentsApi.get(id);
    params.push(id);
    _db.prepare(`UPDATE eval_incidents SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return evalIncidentsApi.get(id);
  },

  /**
   * Count incidents by status for a project.
   * @param {string} project
   * @returns {{ open: number, accepted: number, dismissed: number }}
   */
  countByStatus(project) {
    _ensureDb();
    const rows = _db.prepare(
      'SELECT status, COUNT(*) as count FROM eval_incidents WHERE project = ? GROUP BY status'
    ).all(project);
    const counts = { open: 0, accepted: 0, dismissed: 0 };
    for (const row of rows) {
      if (row.status in counts) counts[row.status] = row.count;
    }
    return counts;
  }
};

// ── Row Mappers ──

/**
 * Convert a SQLite project row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToProject(row) {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    engineId: row.engine_id,
    methodology: row.methodology,
    tags: _jsonParse(row.tags, []),
    ports: _jsonParse(row.ports, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: !!row.archived,
    migrationStatus: row.migration_status || null,
    orchestrationProfile: row.orchestration_profile || null
  };
}

/**
 * Convert a SQLite session row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToSession(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    engineId: row.engine_id,
    tmuxSession: row.tmux_session,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    wrapSummary: row.wrap_summary,
    primePrompt: row.prime_prompt,
    methodologyPhase: row.methodology_phase,
    durationSeconds: row.duration_seconds,
    sessionMode: row.session_mode || 'tmux',
    launchMode: row.launch_mode || null,
    wrapStartedAt: row.wrap_started_at || null,
    owner: row.owner || null
  };
}

/**
 * Convert a SQLite learning row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToLearning(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    content: row.content,
    tier: row.tier,
    sourceSession: row.source_session,
    confirmedCount: row.confirmed_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Convert a SQLite session_rules row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToSessionRule(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    content: row.content,
    enabled: !!row.enabled,
    createdBy: row.created_by,
    // CC-6 (#381): 'startup' (launch-injected) | 'wrap' | 'mode'. Older rows
    // predating the column read back as 'startup' via the schema default.
    kind: row.kind || 'startup',
    owner: row.owner,
    sourceLearningId: row.source_learning_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Convert a SQLite session_rule_versions row to an app-level object (D1b).
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToSessionRuleVersion(row) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    versionNo: row.version_no,
    op: row.op,
    content: row.content,
    enabled: !!row.enabled,
    createdBy: row.created_by,
    owner: row.owner,
    changedBy: row.changed_by,
    changeReason: row.change_reason,
    createdAt: row.created_at
  };
}

/**
 * Convert a SQLite port_leases row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToLease(row) {
  return {
    host: row.host || 'localhost',
    port: row.port,
    project: row.project,
    service: row.service,
    status: row.status,
    permanent: !!row.permanent,
    ttlMs: row.ttl_ms,
    expiresAt: row.expires_at,
    lastHeartbeat: row.last_heartbeat,
    description: row.description,
    autoRenew: !!row.auto_renew,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Convert a SQLite activity_log row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToActivity(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    eventType: row.event_type,
    detail: _jsonParse(row.detail, null),
    createdAt: row.created_at
  };
}

/**
 * Convert a SQLite project_groups row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToGroup(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sharedDir: row.shared_dir || null,
    createdAt: row.created_at
  };
}

/**
 * Convert a SQLite openclaw_connections row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToConnection(row) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    sshUser: row.ssh_user,
    sshKeyPath: row.ssh_key_path,
    gatewayToken: row.gateway_token || null,
    cliCommand: row.cli_command || 'openclaw-cli',
    localPort: row.local_port,
    availableAsEngine: !!row.available_as_engine,
    defaultMode: row.default_mode || 'ssh',
    auditSecret: row.audit_secret || null,
    // Preserve null literally — pre-#160 the read-back coerced null to 3201,
    // which leaked the ClawBridge-default into non-ClawBridge connection
    // records (and added a stray local `-L 3201:127.0.0.1:3201` forward that
    // killed the tunnel via ExitOnForwardFailure=yes).
    bridgePort: row.bridge_port != null ? row.bridge_port : null,
    bridgeToken: row.bridge_token || null,
    instanceDir: row.instance_dir || null,
    createdAt: row.created_at
  };
}

/**
 * Convert a SQLite shared_documents row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToSharedDoc(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    filePath: row.file_path,
    injectIntoConfig: !!row.inject_into_config,
    injectMode: row.inject_mode,
    description: row.description,
    createdAt: row.created_at
  };
}

/**
 * Convert a SQLite document_locks row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToLock(row) {
  return {
    documentId: row.document_id,
    lockedBySession: row.locked_by_session,
    lockedByProject: row.locked_by_project,
    lockedAt: row.locked_at,
    expiresAt: row.expires_at
  };
}

/**
 * Convert a SQLite eval_exchanges row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToEvalExchange(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    connectionId: row.connection_id || null,
    project: row.project,
    agentModel: row.agent_model || null,
    timestamp: row.timestamp,
    turnNumber: row.turn_number,
    userMessage: row.user_message,
    agentResponse: row.agent_response,
    agentThinking: row.agent_thinking || null,
    usageInputTokens: row.usage_input_tokens,
    usageOutputTokens: row.usage_output_tokens,
    scored: row.scored,
    createdAt: row.created_at
  };
}

/**
 * Convert a SQLite eval_scores row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToEvalScore(row) {
  return {
    id: row.id,
    exchangeId: row.exchange_id,
    schemaVersion: row.schema_version,
    judgeModel: row.judge_model,
    scoredAt: row.scored_at,
    methodology: row.methodology,
    tier1StructuralScore: row.tier_1_structural_score,
    tier1Flags: _jsonParse(row.tier_1_flags, []),
    tier2SemanticScore: row.tier_2_semantic_score,
    tier2Reasoning: row.tier_2_reasoning,
    tier2Skipped: !!row.tier_2_skipped,
    tier2_5AlignmentScore: row.tier_2_5_alignment_score,
    tier2_5Reasoning: row.tier_2_5_reasoning,
    tier2_5Skipped: !!row.tier_2_5_skipped,
    tier3BehavioralScore: row.tier_3_behavioral_score,
    tier3DimensionScores: _jsonParse(row.tier_3_dimension_scores, {}),
    tier3Skipped: !!row.tier_3_skipped,
    anomalyFlag: !!row.anomaly_flag,
    anomalyReason: row.anomaly_reason,
    costUsd: row.cost_usd,
    humanScore: row.human_score ?? null,
    humanComment: row.human_comment || null,
    humanScoredAt: row.human_scored_at || null,
    createdAt: row.created_at
  };
}

/**
 * Convert a SQLite eval_baselines row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToEvalBaseline(row) {
  return {
    id: row.id,
    project: row.project,
    methodology: row.methodology,
    computedAt: row.computed_at,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    dimensionAverages: _jsonParse(row.dimension_averages, {}),
    exchangeCount: row.exchange_count,
    schemaVersion: row.schema_version
  };
}

/**
 * Convert a SQLite eval_incidents row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToEvalIncident(row) {
  return {
    id: row.id,
    project: row.project,
    type: row.type,
    status: row.status,
    severity: row.severity,
    title: row.title,
    description: row.description,
    metadata: _jsonParse(row.metadata, null),
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at
  };
}

/**
 * Safely parse a JSON string.
 * @param {string} str - JSON string
 * @param {*} fallback - Fallback value on parse failure
 * @returns {*}
 */
function _jsonParse(str, fallback) {
  if (str == null) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Ensure the database is initialized.
 */
function _ensureDb() {
  if (!_db) {
    throw new StoreError('Store not initialized. Call store.init() first.', 'NOT_INITIALIZED');
  }
}

/**
 * Get the SQLite database instance (for health checks).
 * @returns {DatabaseSync|null}
 */
function getDb() {
  return _db;
}

/**
 * TB-1 (#357) — orchestration profiles accessor. Reads the operator-owned
 * `~/.tangleclaw/orchestration-profiles.json` (seeded from bundle at init).
 * Read-per-call (NOT cached) — mirrors `engines.get()` and ensures an operator
 * edit to this file is picked up at the next session launch with no server
 * restart. The file is read only at launch (not a hot path), so per-call disk
 * read is cheap.
 */
const orchestrationProfilesApi = {
  /**
   * Load the parsed orchestration-profiles config. Missing or malformed file
   * resolves to an empty `{ profiles: {} }` (so a launch with a binding simply
   * refuses to inject rather than throwing — honest degradation).
   * @returns {{ profiles: object }}
   */
  load() {
    try {
      const raw = fs.readFileSync(_orchProfilesFile, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && parsed.profiles
        ? parsed
        : { profiles: {} };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn('Could not read orchestration profiles; treating as empty', { error: err.message });
      }
      return { profiles: {} };
    }
  }
};

module.exports = {
  init,
  close,
  config: configApi,
  engines: enginesApi,
  orchestrationProfiles: orchestrationProfilesApi,
  templates: templatesApi,
  projectConfig: projectConfigApi,
  projects: projectsApi,
  sessions: sessionsApi,
  learnings: learningsApi,
  sessionRules: sessionRulesApi,
  SESSION_RULE_KINDS,
  portLeases: portLeasesApi,
  globalRules: globalRulesApi,
  activity: activityApi,
  projectGroups: projectGroupsApi,
  sharedDocs: sharedDocsApi,
  documentLocks: documentLocksApi,
  openclawConnections: openclawConnectionsApi,
  evalExchanges: evalExchangesApi,
  evalScores: evalScoresApi,
  evalBaselines: evalBaselinesApi,
  evalIncidents: evalIncidentsApi,
  StoreError,
  getDb,
  _setBasePath,
  _getBasePath,
  _mergeBundledTemplate,
  _mergeBundledHookEntries,
  _reconcileFrameworkSubtrees,
  FRAMEWORK_OWNED_PATHS,
  _isOrderedSubset,
  _reconcileOrderedSubset,
  _reconcileSetUnion,
  _reconcileMergeBy,
  _getAtPath,
  ARRAY_RECONCILERS,
  DEFAULT_CONFIG,
  DEFAULT_PROJECT_CONFIG
};
