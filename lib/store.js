'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createLogger } = require('./logger');

const log = createLogger('store');

const CURRENT_SCHEMA_VERSION = 31;

const TANGLECLAW_DIR = path.join(process.env.HOME || '', '.tangleclaw');
const CONFIG_FILE = path.join(TANGLECLAW_DIR, 'config.json');
const DB_FILE = path.join(TANGLECLAW_DIR, 'tangleclaw.db');
const ENGINES_DIR = path.join(TANGLECLAW_DIR, 'engines');
const ORCH_PROFILES_FILE = path.join(TANGLECLAW_DIR, 'orchestration-profiles.json');
const BUNDLED_ENGINES_DIR = path.join(__dirname, '..', 'data', 'engines');
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
  // Project Master settings (the brain-icon singleton, lib/master.js).
  // `accessLevel`: 'read-only' | 'suggest' | 'write'. All three are accepted
  // since #755 gave each real enforcement — the write guard reads the level per
  // tool call. The rule that gated them has not relaxed: a tier ships only WITH
  // its enforcement, never as a prose-only boundary.
  // `engine`: engine id override; null = follow `defaultEngine`.
  // `scope`: 'all' or { type: 'group', groupId } — a focus control rendered
  // into the master's identity, NOT a security boundary (API stays open on
  // localhost; auth-scoped visibility is a later concern).
  // `autoStart`: launch the master session at server boot (default: on-demand
  // via the brain icon). Config-file merge is shallow, so writers must always
  // persist the WHOLE object (PATCH /api/config validates the full shape).
  master: {
    accessLevel: 'read-only',
    engine: null,
    // #756. Present here, not only in `masterSettings`, so `GET /api/config`
    // and `GET /api/master/status` agree on an install nobody has PATCHed —
    // otherwise the field is absent from one and 'default' in the other.
    launchMode: 'default',
    scope: 'all',
    autoStart: false
  },
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
  // AUTH-1 (#395) — ingress topology. 'direct' (default): TC terminates its own
  // HTTPS via https-setup/mkcert and serves the socket itself.
  // 'caddy' = TC binds localhost plain-HTTP behind a Caddy reverse proxy that
  // terminates TLS (mkcert cert for localhost; ACME for `publicDomain`) and is
  // the single ingress. The flag is the reversibility spine — flipping back to
  // 'direct' + re-running the cutover restores direct-HTTPS exactly. The live
  // cutover is an explicit operator step (scripts/ingress-cutover.js), not a
  // runtime side effect of changing this value. See lib/caddy.js.
  // Which interfaces either mode binds is NOT decided here — see
  // `bindAllInterfaces` below and lib/bind-policy.js.
  ingressMode: 'direct',
  // Bind every network interface instead of loopback only. Default OFF: TC
  // launches AI sessions with shell access, so a dashboard reachable from the
  // network without a password is arbitrary code execution as the operator.
  // Turning this on is the deliberate opt-out from that protection, and it is
  // the ONLY route to a wide bind — caddy mode refuses it, because Caddy holds
  // the credential gate and a wide Node socket would sit beside that gate
  // rather than behind it. Prefer enabling the login gate over setting this.
  // Resolution and the upgrade notice live in lib/bind-policy.js.
  bindAllInterfaces: false,
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
  // #397 credential durability — emit a Basic-Auth-gated plain-HTTP catch-all
  // site (`http:// { ... }` + `auto_https disable_redirects`) in the generated
  // Caddyfile, for remote access over a WireGuard-encrypted tailnet. Adopted
  // automatically at boot/cutover when the live Caddyfile carries the shape;
  // the generator refuses to emit it without a credential (open-door guard).
  caddyRemoteHttp: false,
  // #434 — tailnet FQDN (e.g. `your-host.tailnet-name.ts.net`) for a gated HTTPS
  // site + http→https redirect in the generated Caddyfile (OpenClaw 2026.6.11+
  // Control UI requires a secure context, so remote access must be HTTPS).
  // Adopted automatically at boot/cutover when the live Caddyfile carries a
  // TLS site for a non-local FQDN; the generator refuses to emit it without a
  // credential (open-door guard). The local mkcert cert's SAN must include
  // this host (re-minted with the .ts.net SAN 2026-07-04).
  caddyTailnetHost: null,
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
  for (const dir of [_basePath, _enginesDir, path.join(_basePath, 'logs')]) {
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
   * Absolute path to the global config file.
   *
   * Exposed because the Project Master's generated write guard has to REFUSE
   * writes to it (#755): the file holds `master.accessLevel`, and every ensure
   * copies that value into the master's own `.access-level`. Without this the
   * guard denied its own control surface inside the master home while the
   * authoritative copy sat one directory up, reachable with a single `suggest`
   * confirmation — the permanent escalation that deny exists to prevent, with
   * one extra step.
   *
   * An accessor rather than a second `path.join` at the call site, for the same
   * reason `masterAccessLevelPath` is one: the writer and the refuser must not
   * be able to disagree about where the file is, and `_setBasePath` moves it.
   *
   * @returns {string} Absolute path to `config.json`.
   */
  file() {
    return _configFile;
  },

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
   * Whether a key is actually present in the config FILE, as opposed to being
   * supplied by `DEFAULT_CONFIG` during `load()`.
   *
   * `load()` merges defaults, so it can never distinguish "the operator chose
   * this value" from "this key did not exist when the file was written". That
   * distinction is what identifies an install whose config predates a key —
   * used by lib/bind-policy.js to recognize the installs whose network binding
   * narrowed under them, and tell only those.
   *
   * @param {string} key - Top-level config key.
   * @returns {boolean} False when the file is missing, unreadable, or lacks the key.
   */
  isKeyPersisted(key) {
    try {
      if (!fs.existsSync(_configFile)) return false;
      const parsed = JSON.parse(fs.readFileSync(_configFile, 'utf8'));
      return Object.prototype.hasOwnProperty.call(parsed, key);
    } catch {
      // An unreadable or malformed config file is not evidence that the operator
      // set the key, so fail toward telling them rather than staying silent.
      return false;
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



// Per-project defaults and the config READER live in `lib/project-config.js` and
// are re-exported here unchanged, so `store.projectConfig.load` and this constant
// remain this module's public surface for every existing caller. The split exists
// because the killable scanner child reads project config on the dashboard poll
// (#884) and must not import this module, which opens SQLite at require time. The
// WRITER stays here: nothing on the poll path writes config, and a process built
// to be SIGKILLed has no business owning a write the operator's settings depend on.
// Required as a MODULE, not destructured. A destructured `load` is captured at
// require time, which would give this module and `lib/project-version.js` two
// different seams for the same reader — one reachable by a test stub and one not,
// which is precisely the asymmetry that makes a stubbed test pass while the code
// it names goes unexercised. Calling through the module object resolves at call
// time, so there is one seam.
const projectConfig = require('./project-config');
const { DEFAULT_PROJECT_CONFIG } = projectConfig;

const projectConfigApi = {
  /**
   * Load per-project config from <projectPath>/.tangleclaw/project.json.
   * Merges with defaults. Returns defaults if file doesn't exist.
   *
   * Delegates to `lib/project-config.js` so the scanner child and this module
   * share one reader rather than a copy that drifts.
   *
   * @param {string} projectPath - Absolute path to project root
   * @returns {object}
   */
  load(projectPath) {
    return projectConfig.load(projectPath, {
      onError: (err, configPath) => {
        log.warn('Failed to load project config, using defaults', { path: configPath, error: err.message });
      }
    });
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
      tags          TEXT    DEFAULT '[]',
      ports         TEXT    DEFAULT '{}',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      archived      INTEGER NOT NULL DEFAULT 0,
      migration_status TEXT,
      orchestration_profile TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_projects_engine ON projects(engine_id);

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
      kind              TEXT    NOT NULL DEFAULT 'startup',                 -- CC-6: 'startup' (launch-injected) | 'wrap' (wrap-prompt-injected)
      owner             TEXT,                                               -- nullable auth-ready seam (AUTH/#347)
      source_learning_id INTEGER REFERENCES learnings(id) ON DELETE SET NULL, -- provenance for promoted rules (D1b)
      -- Review state, orthogonal to enabled. enabled is the operator's on/off
      -- switch for a rule they own; status is how far a rule has got through
      -- review. Keeping them separate is what lets a rule the operator REJECTED
      -- stay distinguishable from one never reviewed — collapse them and the wrap
      -- re-proposes rejected rules forever. Only 'active' is ever injected.
      status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','rejected')),
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
      op            TEXT    NOT NULL CHECK (op IN ('create','update','delete','restore')),  -- SR-3MW8: enum-pinned
      content       TEXT    NOT NULL,
      enabled       INTEGER NOT NULL,
      created_by    TEXT    NOT NULL,
      owner         TEXT,
      changed_by    TEXT    NOT NULL DEFAULT 'operator',                -- who made THIS change ('operator' | 'ai')
      change_reason TEXT,
      critic_gate   TEXT    NOT NULL DEFAULT 'unknown' CHECK (critic_gate IN ('passed','not-required','unknown')),  -- SR-7K2P: attested Critic-gate provenance
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_session_rule_versions_rule ON session_rule_versions(rule_id);

    -- Delivery ledger for session rules (#595). Answers "did session X receive
    -- rule set Y at version Z" — previously unanswerable, and in fact untrue on
    -- every plugin-governed project, because the only injection path ran inside
    -- config-file generation, which those projects skip entirely.
    --
    -- Rows record a delivery ATTEMPT, not only a success. The outcome column is
    -- the single source of truth for what happened, deliberately an enum
    -- rather than a delivered boolean: with a boolean, a project that has no
    -- rules and a project whose rules were delivered both read as "true", which
    -- is the exact conflation this ledger exists to end.
    --
    --   delivered  — the rule block reached the engine, and the writer OBSERVED
    --                the channel ready to receive it (a marker-confirmed pane,
    --                or a channel whose consumption is otherwise evidenced)
    --   no-rules   — the launch path ran and the project had no active rules
    --   skipped    — rules existed and did NOT arrive; skip_reason says why
    --   unverified — the block was SENT and nothing observed the far side;
    --                skip_reason says what made it unobservable. A blind paste
    --                is this row, never 'delivered': a channel that is 100%
    --                broken must not produce a clean ledger.
    --
    -- "Which projects never received their rules" is then a real query
    -- (no row with outcome='delivered'), and a severed channel is
    -- distinguishable from an empty one.
    --
    -- digest is a sha256 over the rule CONTENT (id:text per rule) and is the
    -- version identity of a rule SET; session_rule_versions.version_no is
    -- per-rule and cannot identify a set. Hashing the rendered block instead
    -- would make the digest change when the wording around the rules changed,
    -- which is not a change to the rules.
    --
    -- session_id / project_id are LOGICAL references (no FK, no cascade), same
    -- rationale as session_rule_versions.rule_id above: the audit trail must
    -- outlive the session or project it describes.
    CREATE TABLE IF NOT EXISTS session_rule_deliveries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   INTEGER,
      project_id   INTEGER,
      engine_id    TEXT    NOT NULL,
      kind         TEXT    NOT NULL DEFAULT 'startup',
      -- 'rules-hook' is the dedicated startup channel rules ride since #749.
      -- 'prime-file' remains for the prime itself and for pre-#749 rows.
      channel      TEXT    NOT NULL CHECK (channel IN ('prime-file','prime-paste','rules-hook','none')),
      outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped','unverified')),
      skip_reason  TEXT,
      rule_ids     TEXT    NOT NULL DEFAULT '[]',
      rule_count   INTEGER NOT NULL DEFAULT 0,
      digest       TEXT    NOT NULL,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      -- Structurally impossible states, rejected by the database rather than
      -- only by the writer: nothing can be sent through no channel, and a
      -- skip or an unverified send with no reason records a failure while
      -- discarding what it was.
      CHECK (outcome NOT IN ('delivered','unverified') OR channel != 'none'),
      CHECK (outcome NOT IN ('skipped','unverified')   OR skip_reason IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_session ON session_rule_deliveries(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_project ON session_rule_deliveries(project_id);

    -- Switchboard nudge ledger (#792), the same shape and for the same reason as
    -- session_rule_deliveries above: a session that was never told about its mail
    -- and a session with no mail are indistinguishable from outside, so the
    -- operator becomes the transport. message_key is the inbox edge the nudge
    -- was about, so a row answers "was anyone told about THIS mail", not merely
    -- "did the monitor run".
    --
    -- session_id / project_id are LOGICAL references, same rationale as above.
    CREATE TABLE IF NOT EXISTS medusa_deliveries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      -- TEXT, not INTEGER: the Project Master is a participant too and its
      -- session key is the literal string 'master', so an integer column would
      -- either coerce it or push it into a null bucket where every Master row
      -- collapses together.
      session_id   TEXT,
      project_id   INTEGER,
      workspace_id TEXT,
      message_key  TEXT    NOT NULL,
      unread       INTEGER NOT NULL DEFAULT 0,
      channel      TEXT    NOT NULL CHECK (channel IN ('tmux-inject','master-inject','none')),
      outcome      TEXT    NOT NULL CHECK (outcome IN ('nudged','skipped','failed')),
      skip_reason  TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      -- The same impossible states the rules ledger rejects: nothing is nudged
      -- through no channel, and a non-delivery with no reason records that
      -- something went wrong while discarding what it was.
      CHECK (outcome != 'nudged' OR channel != 'none'),
      CHECK (outcome  = 'nudged' OR skip_reason IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_medusa_deliveries_session ON medusa_deliveries(session_id);
    CREATE INDEX IF NOT EXISTS idx_medusa_deliveries_project ON medusa_deliveries(project_id);

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
    CREATE INDEX IF NOT EXISTS idx_eval_scores_project_time ON eval_scores(scored_at);

    CREATE TABLE IF NOT EXISTS eval_baselines (
      id                  TEXT PRIMARY KEY,
      project             TEXT NOT NULL,
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

    if (currentVersion < 23) {
      // v22→v23: SR-3MW8. Pin session_rule_versions.op to the enum its writer
      // already uses ('create'|'update'|'delete'|'restore'). Every insert goes
      // through `_snapshotSessionRule`, whose only four callers pass exactly those
      // literals — so no existing row can violate the constraint — but nothing
      // enforced it at the storage layer. Without it, a future writer bug or a
      // manual edit could land a garbage op and silently corrupt the reversible
      // audit history the table exists to guarantee. SQLite cannot add a CHECK via
      // ALTER TABLE, so recreate the table with the constraint, preserving every
      // existing row (id, version_no, and all columns) verbatim. A fresh DB gets
      // the CHECK directly from the _createTables DDL above and stamps v23 without
      // entering this block, so this only fires for a pre-v23 DB whose table
      // already exists without the constraint. Mirrors the v14→v15 rebuild pattern.
      let recreateErr = null;
      try {
        // node:sqlite's DatabaseSync has no `.transaction()` wrapper, so bracket
        // the recreate with explicit BEGIN/COMMIT in the SQL — any intermediate
        // failure throws, the catch rolls back, and the postcondition below blocks
        // schema_version from advancing.
        _db.exec(`
          BEGIN;
          CREATE TABLE session_rule_versions_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id       INTEGER NOT NULL,
            version_no    INTEGER NOT NULL,
            op            TEXT    NOT NULL CHECK (op IN ('create','update','delete','restore')),
            content       TEXT    NOT NULL,
            enabled       INTEGER NOT NULL,
            created_by    TEXT    NOT NULL,
            owner         TEXT,
            changed_by    TEXT    NOT NULL DEFAULT 'operator',
            change_reason TEXT,
            created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO session_rule_versions_new
            (id, rule_id, version_no, op, content, enabled, created_by, owner, changed_by, change_reason, created_at)
            SELECT id, rule_id, version_no, op, content, enabled, created_by, owner, changed_by, change_reason, created_at
            FROM session_rule_versions;
          DROP TABLE session_rule_versions;
          ALTER TABLE session_rule_versions_new RENAME TO session_rule_versions;
          CREATE INDEX IF NOT EXISTS idx_session_rule_versions_rule ON session_rule_versions(rule_id);
          COMMIT;
        `);
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* no transaction in progress */ }
        // This block only runs for a pre-v23 DB whose table exists WITHOUT the
        // CHECK, so the rebuild should succeed — a failure is a genuine problem,
        // most likely a pre-existing out-of-enum `op` value that the new CHECK
        // (correctly) rejects during the INSERT...SELECT copy. Preserve the real
        // error and surface it at warn level so the postcondition below can
        // attribute the root cause instead of misreporting "CHECK not produced".
        recreateErr = err;
        log.warn('Migration v22→v23 recreate failed — see postcondition', { error: err.message });
      }

      // Postcondition: verify the CHECK is actually present before advancing
      // schema_version. PRAGMA table_info does not surface CHECK clauses, so read
      // the table's DDL from sqlite_master and assert the enum guard is there.
      // Fail loudly (as v14→v15 does) so a botched rebuild surfaces at boot rather
      // than as a silent no-op that marks the DB v23 with a v22 schema in place.
      const ddl = _db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rule_versions'"
      ).get();
      if (!ddl || !/CHECK\s*\(\s*op\s+IN/i.test(ddl.sql)) {
        // Attribute the root cause: if the rebuild threw (e.g. a pre-existing
        // out-of-enum op that the copy rejected), name that; otherwise report the
        // constraint-absent state directly.
        const cause = recreateErr
          ? `the table rebuild failed — likely a pre-existing out-of-enum op value: ${recreateErr.message}`
          : `found: ${ddl ? ddl.sql : 'table missing'}`;
        throw new Error(
          `v22→v23 migration did not produce a CHECK constraint on session_rule_versions.op ` +
          `(${cause}). Aborting — schema_version will NOT advance to 23 until this is resolved. See SR-3MW8.`
        );
      }
      log.info('Migration v22→v23: CHECK constraint added to session_rule_versions.op (SR-3MW8)');
    }

    if (currentVersion < 24) {
      // v23→v24: SR-7K2P. Add `critic_gate` to session_rule_versions — a
      // per-mutation attestation of whether the edit passed the in-session Critic
      // gate ('passed' | 'not-required' | 'unknown'). The server can neither
      // summon nor verify the Critic, so this RECORDS the AI's apply-time
      // attestation; it does not enforce it. Existing rows predate the column and
      // carry no attestation, so they default to 'unknown' (an honest "we don't
      // know", never a presumed 'passed'). SQLite cannot add a CHECK via ALTER
      // TABLE, so recreate the table with both the op CHECK (from v23) and the new
      // critic_gate CHECK, preserving every existing row verbatim. A fresh DB gets
      // both CHECKs directly from the _createTables DDL above and stamps v24
      // without entering this block. Mirrors SR-3MW8's v22→v23 rebuild.
      let recreateErr = null;
      try {
        // node:sqlite's DatabaseSync has no `.transaction()` wrapper, so bracket
        // the recreate with explicit BEGIN/COMMIT — any intermediate failure
        // throws, the catch rolls back, and the postcondition blocks the version
        // bump.
        _db.exec(`
          BEGIN;
          CREATE TABLE session_rule_versions_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id       INTEGER NOT NULL,
            version_no    INTEGER NOT NULL,
            op            TEXT    NOT NULL CHECK (op IN ('create','update','delete','restore')),
            content       TEXT    NOT NULL,
            enabled       INTEGER NOT NULL,
            created_by    TEXT    NOT NULL,
            owner         TEXT,
            changed_by    TEXT    NOT NULL DEFAULT 'operator',
            change_reason TEXT,
            critic_gate   TEXT    NOT NULL DEFAULT 'unknown' CHECK (critic_gate IN ('passed','not-required','unknown')),
            created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO session_rule_versions_new
            (id, rule_id, version_no, op, content, enabled, created_by, owner, changed_by, change_reason, created_at)
            SELECT id, rule_id, version_no, op, content, enabled, created_by, owner, changed_by, change_reason, created_at
            FROM session_rule_versions;
          DROP TABLE session_rule_versions;
          ALTER TABLE session_rule_versions_new RENAME TO session_rule_versions;
          CREATE INDEX IF NOT EXISTS idx_session_rule_versions_rule ON session_rule_versions(rule_id);
          COMMIT;
        `);
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* no transaction in progress */ }
        // critic_gate is a NEW column with no pre-existing values to violate the
        // CHECK, so the INSERT...SELECT (which omits critic_gate → takes DEFAULT
        // 'unknown') should never be rejected. A failure is therefore a genuine
        // problem; preserve the real error so the postcondition can attribute it
        // rather than misreporting "CHECK not produced".
        recreateErr = err;
        log.warn('Migration v23→v24 recreate failed — see postcondition', { error: err.message });
      }

      // Postcondition: verify the critic_gate CHECK is actually present before
      // advancing schema_version. PRAGMA table_info does not surface CHECK clauses,
      // so read the table's DDL from sqlite_master. Fail loudly (as v22→v23 does)
      // so a botched rebuild surfaces at boot rather than as a silent no-op that
      // marks the DB v24 with a v23 schema in place.
      const ddl = _db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rule_versions'"
      ).get();
      if (!ddl || !/CHECK\s*\(\s*critic_gate\s+IN/i.test(ddl.sql)) {
        const cause = recreateErr
          ? `the table rebuild failed: ${recreateErr.message}`
          : `found: ${ddl ? ddl.sql : 'table missing'}`;
        throw new Error(
          `v23→v24 migration did not produce a CHECK constraint on session_rule_versions.critic_gate ` +
          `(${cause}). Aborting — schema_version will NOT advance to 24 until this is resolved. See SR-7K2P.`
        );
      }
      log.info('Migration v23→v24: critic_gate provenance column added to session_rule_versions (SR-7K2P)');
    }

    if (currentVersion < 25) {
      // v24→v25: two session-rules tiers retired. `kind='mode'` rules (harness
      // posture became the structured `defaultLaunchMode`/`showLaunchModePicker`
      // project settings, never had a runtime consumer) and the hidden global
      // tier (project_id IS NULL rows — cross-project directives belong in the
      // Global rules document). The 2026-07-17 fleet audit found ZERO rows in
      // either tier, so this is defensive cleanup: any row that slipped in
      // since would be invisible dead weight (no list surface, no injection
      // path) if left behind. Version-history rows are kept — provenance
      // outlives the rule, matching soft-delete semantics elsewhere.
      const purged = _db.prepare(
        "DELETE FROM session_rules WHERE kind = 'mode' OR project_id IS NULL"
      ).run();
      log.info('Migration v24→v25: retired mode-kind and global-tier session rules purged', { rows: purged.changes });
    }

    if (currentVersion < 26) {
      // v25→v26: session_rule_deliveries (#595). Startup rules were structurally
      // undeliverable on every plugin-governed project and nothing recorded that
      // fact, so the severed channel looked identical to "no rules configured".
      // This ledger makes delivery answerable. CREATE IF NOT EXISTS handles a
      // fresh schema built by _createTables; this backfills an existing db.
      //
      // Deliberately NOT wrapped in a try/catch. Every statement here is
      // IF NOT EXISTS, so "already exists" cannot throw — the only thing a
      // catch could swallow is a genuine failure, and swallowing it would stamp
      // the schema as v26 over a database with no such table. The ledger would
      // then fail every write, and `_recordRuleDelivery` logs and continues, so
      // the failure would surface as a permanently empty ledger: the same
      // silent-severance shape as the bug this table exists to detect.
      _db.exec(`
        CREATE TABLE IF NOT EXISTS session_rule_deliveries (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   INTEGER,
          project_id   INTEGER,
          engine_id    TEXT    NOT NULL,
          kind         TEXT    NOT NULL DEFAULT 'startup',
          channel      TEXT    NOT NULL CHECK (channel IN ('prime-file','prime-paste','none')),
          outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped')),
          skip_reason  TEXT,
          rule_ids     TEXT    NOT NULL DEFAULT '[]',
          rule_count   INTEGER NOT NULL DEFAULT 0,
          digest       TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (outcome != 'delivered' OR channel != 'none'),
          CHECK (outcome != 'skipped'   OR skip_reason IS NOT NULL)
        );
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_session ON session_rule_deliveries(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_project ON session_rule_deliveries(project_id);
      `);
      log.info('Migration v25→v26: session_rule_deliveries ledger added (#595)');
    }

    if (currentVersion < 27) {
      // v26→v27: `status` on session_rules (#569). The wrap can now PROPOSE a
      // rule, which needs a state between "does not exist" and "governs every
      // future session". `enabled` could not carry it: that flag means "the
      // operator switched this rule off", so storing proposals as enabled=0 makes
      // a REJECTED rule indistinguishable from an unreviewed one, and the wrap
      // would re-propose everything the operator already declined, forever.
      //
      // Every pre-existing row is a rule that already governs sessions, so they
      // backfill to 'active' — the column default. That is the honest reading:
      // they were never proposals, and back-dating them into review would
      // silently switch off working rules on upgrade.
      //
      // SQLite cannot add a CHECK via ALTER TABLE, so recreate the table
      // preserving every row verbatim. Mirrors the v23→v24 rebuild.
      let statusRecreateErr = null;
      try {
        // SQLite's documented procedure for a table rebuild: foreign-key
        // enforcement OFF around it, and it must be set OUTSIDE the transaction
        // (the pragma is a no-op inside one). This matters beyond ceremony here
        // — `session_rules` references `projects` and `learnings`, and a
        // database can legitimately contain a row whose referent is already
        // gone. Re-inserting under enforcement would abort the whole migration
        // on such a row, so a pre-existing orphan would block the upgrade
        // instead of surviving it. A migration preserves what it finds; it is
        // not the place to start deleting the operator's data.
        _db.exec('PRAGMA foreign_keys = OFF');
        _db.exec(`
          BEGIN;
          CREATE TABLE session_rules_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id        INTEGER REFERENCES projects(id) ON DELETE CASCADE,
            content           TEXT    NOT NULL,
            enabled           INTEGER NOT NULL DEFAULT 1,
            created_by        TEXT    NOT NULL DEFAULT 'operator',
            kind              TEXT    NOT NULL DEFAULT 'startup',
            owner             TEXT,
            source_learning_id INTEGER REFERENCES learnings(id) ON DELETE SET NULL,
            status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','rejected')),
            created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO session_rules_new
            (id, project_id, content, enabled, created_by, kind, owner, source_learning_id, created_at, updated_at)
            SELECT id, project_id, content, enabled, created_by, kind, owner, source_learning_id, created_at, updated_at
            FROM session_rules;
          DROP TABLE session_rules;
          ALTER TABLE session_rules_new RENAME TO session_rules;
          CREATE INDEX IF NOT EXISTS idx_session_rules_project ON session_rules(project_id);
          CREATE INDEX IF NOT EXISTS idx_session_rules_enabled ON session_rules(enabled);
          CREATE INDEX IF NOT EXISTS idx_session_rules_status ON session_rules(status);
          COMMIT;
        `);
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* no transaction in progress */ }
        // `status` is a new column taking its DEFAULT on the INSERT...SELECT, so
        // no pre-existing value can violate the CHECK. A failure here is real.
        statusRecreateErr = err;
        log.warn('Migration v26→v27 recreate failed — see postcondition', { error: err.message });
      } finally {
        // Restore enforcement whatever happened, including on the rollback path
        // — leaving it off would silently disable FK checking for the rest of
        // the process's life, long after this migration is forgotten.
        try { _db.exec('PRAGMA foreign_keys = ON'); } catch { /* connection already gone */ }
      }

      // Postcondition: refuse to advance the version unless the CHECK is really
      // present. A silent no-op here would stamp the DB v27 with a v26 schema, and
      // every proposal would then be written as an ordinary active rule — the
      // exact silent self-modification this chunk exists to prevent.
      const srDdl = _db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rules'"
      ).get();
      if (!srDdl || !/CHECK\s*\(\s*status\s+IN/i.test(srDdl.sql)) {
        const cause = statusRecreateErr
          ? `the table rebuild failed: ${statusRecreateErr.message}`
          : `found: ${srDdl ? srDdl.sql : 'table missing'}`;
        throw new Error(
          `v26→v27 migration did not produce a CHECK constraint on session_rules.status ` +
          `(${cause}). Aborting — schema_version will NOT advance to 27 until this is resolved. See #569.`
        );
      }
      log.info('Migration v26→v27: status column added to session_rules (#569)');
    }

    if (currentVersion < 28) {
      _migrateDropMethodology();
    }

    if (currentVersion < 29) {
      // v28→v29 (#749): rules moved off the prime file onto their own startup
      // hook, so the ledger needs a channel value that names where they
      // actually went. Without it the only representable answer was
      // 'prime-file' — a row asserting delivery through a file that now carries
      // a manifest, not the rules. SQLite cannot alter a CHECK in place, so the
      // table is rebuilt; existing rows are preserved verbatim because the
      // audit trail's whole value is outliving what it describes.
      // Transactional, like every sibling table rebuild here. Without it a
      // failure between DROP and RENAME leaves schema_version at 28, so the
      // next boot re-enters this branch and dies on "table already exists" —
      // an unbootable server, from a migration whose whole promise is that the
      // audit trail survives.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _db.exec(`
        CREATE TABLE session_rule_deliveries_v29 (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   INTEGER,
          project_id   INTEGER,
          engine_id    TEXT    NOT NULL,
          kind         TEXT    NOT NULL DEFAULT 'startup',
          channel      TEXT    NOT NULL CHECK (channel IN ('prime-file','prime-paste','rules-hook','none')),
          outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped')),
          skip_reason  TEXT,
          rule_ids     TEXT    NOT NULL DEFAULT '[]',
          rule_count   INTEGER NOT NULL DEFAULT 0,
          digest       TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (outcome != 'delivered' OR channel != 'none'),
          CHECK (outcome != 'skipped'   OR skip_reason IS NOT NULL)
        );
        INSERT INTO session_rule_deliveries_v29
          SELECT id, session_id, project_id, engine_id, kind, channel, outcome,
                 skip_reason, rule_ids, rule_count, digest, created_at
          FROM session_rule_deliveries;
        DROP TABLE session_rule_deliveries;
        ALTER TABLE session_rule_deliveries_v29 RENAME TO session_rule_deliveries;
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_session ON session_rule_deliveries(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_project ON session_rule_deliveries(project_id);
        `);
        // Postcondition: the rebuilt table must accept the value the rebuild
        // exists to allow. PRAGMA table_info does not surface CHECK clauses —
        // it would report `channel` present on the v28 table too — so read the
        // DDL from sqlite_master, exactly as the v22→v23 rebuild above does.
        // Probing the column instead would pass against a rebuild that copied
        // the OLD constraint forward, which is the only failure this guard
        // exists to catch.
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rule_deliveries'"
        ).get();
        if (!ddl || !ddl.sql || !ddl.sql.includes('rules-hook')) {
          throw new Error(
            'v28→v29 rebuild did not widen the channel CHECK — session_rule_deliveries '
            + 'still rejects rules-hook. Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v28→v29: rules-hook delivery channel added (#749)');
    }

    if (currentVersion < 30) {
      // v29→v30: medusa_deliveries (#792). A Switchboard message could land in
      // the inbox with the session never told, and nothing anywhere recorded the
      // miss — so an unread inbox and a severed nudge channel looked identical,
      // and a human relaying badges by hand was the only thing keeping an
      // exchange alive. This is the same ledger #595 built for startup rules,
      // for the same reason: an empty-looking session and a severed channel must
      // be distinguishable.
      //
      // Deliberately NOT wrapped in a try/catch, for the reason spelled out at
      // v25→v26: every statement is IF NOT EXISTS, so the only thing a catch
      // could swallow is a real failure — and swallowing it would stamp the
      // schema as v30 over a database with no such table, leaving a permanently
      // empty ledger. That is the same silent-severance shape this table exists
      // to detect.
      _db.exec(`
        CREATE TABLE IF NOT EXISTS medusa_deliveries (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   TEXT,
          project_id   INTEGER,
          workspace_id TEXT,
          message_key  TEXT    NOT NULL,
          unread       INTEGER NOT NULL DEFAULT 0,
          channel      TEXT    NOT NULL CHECK (channel IN ('tmux-inject','master-inject','none')),
          outcome      TEXT    NOT NULL CHECK (outcome IN ('nudged','skipped','failed')),
          skip_reason  TEXT,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (outcome != 'nudged' OR channel != 'none'),
          CHECK (outcome  = 'nudged' OR skip_reason IS NOT NULL)
        );
        CREATE INDEX IF NOT EXISTS idx_medusa_deliveries_session ON medusa_deliveries(session_id);
        CREATE INDEX IF NOT EXISTS idx_medusa_deliveries_project ON medusa_deliveries(project_id);
      `);
      log.info('Migration v29→v30: medusa_deliveries ledger added (#792)');
    }

    if (currentVersion < 31) {
      // v30→v31 (#1063): the outcome enum gains 'unverified'. Until now the
      // paste path recorded 'delivered' on the strength of tmux send-keys not
      // throwing — a fact about the local tmux server, not about what any
      // engine received — so a channel that was 100% broken produced a clean
      // ledger. 'unverified' is the honest row for a send nobody observed
      // landing. SQLite cannot alter a CHECK in place, so the table is rebuilt
      // exactly as v28→v29 did; rows are preserved verbatim because the audit
      // trail's whole value is outliving what it describes.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _db.exec(`
        CREATE TABLE session_rule_deliveries_v31 (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   INTEGER,
          project_id   INTEGER,
          engine_id    TEXT    NOT NULL,
          kind         TEXT    NOT NULL DEFAULT 'startup',
          channel      TEXT    NOT NULL CHECK (channel IN ('prime-file','prime-paste','rules-hook','none')),
          outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped','unverified')),
          skip_reason  TEXT,
          rule_ids     TEXT    NOT NULL DEFAULT '[]',
          rule_count   INTEGER NOT NULL DEFAULT 0,
          digest       TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (outcome NOT IN ('delivered','unverified') OR channel != 'none'),
          CHECK (outcome NOT IN ('skipped','unverified')   OR skip_reason IS NOT NULL)
        );
        INSERT INTO session_rule_deliveries_v31
          SELECT id, session_id, project_id, engine_id, kind, channel, outcome,
                 skip_reason, rule_ids, rule_count, digest, created_at
          FROM session_rule_deliveries;
        DROP TABLE session_rule_deliveries;
        ALTER TABLE session_rule_deliveries_v31 RENAME TO session_rule_deliveries;
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_session ON session_rule_deliveries(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_project ON session_rule_deliveries(project_id);
        `);
        // Postcondition, same rationale and mechanism as v28→v29 above: PRAGMA
        // table_info cannot surface CHECK clauses, so read the DDL and confirm
        // the rebuilt table actually accepts the value the rebuild exists to
        // allow.
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rule_deliveries'"
        ).get();
        if (!ddl || !ddl.sql || !ddl.sql.includes('unverified')) {
          throw new Error(
            'v30→v31 rebuild did not widen the outcome CHECK — session_rule_deliveries '
            + 'still rejects unverified. Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v30→v31: unverified delivery outcome added (#1063)');
    }

    _db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
  }

  log.debug('Schema version', { version: CURRENT_SCHEMA_VERSION });
}

/**
 * v27→v28: retire the methodology layer.
 *
 * Two steps that MUST stay in this order, in this one function: a terminal
 * wrap-config seed, then the column drops. Before this migration a project
 * labeled `minimal` ran an effectively commit-only wrap (its template's only
 * non-commit steps shipped empty prompts, which self-skip). The wrap pipeline
 * is now code-owned and full-featured, so the label was the last thing that
 * could identify those projects — once the column is gone, an unseeded one
 * silently flips from a commit-only wrap to the full pipeline, running
 * changelog/memory/PR steps it was never configured for.
 *
 * So every `minimal` row gets `wrapStepOverrides` disabling every disableable
 * step, plus the one-shot `wrapOverridesSeeded` marker, and only then does the
 * column drop. Coupling them here (rather than in a boot sweep) means no
 * install can reach the post-drop schema without having been seeded first —
 * including installs that never ran the version that introduced the sweep.
 *
 * Rows already carrying the marker are left untouched (the operator may have
 * since opted into the full pipeline by clearing the map). Rows whose path is
 * gone cannot be written and are logged individually: nothing on disk can be
 * seeded, so the warning is the record, and the project will adopt the default
 * pipeline if its directory ever returns.
 *
 * @returns {void}
 */
function _migrateDropMethodology() {
  const wrapDefaultPipeline = require('./wrap-default-pipeline');
  const wrapStepOverrides = require('./wrap-step-overrides');

  let seeded = 0;
  let unreachable = 0;
  // An old DB always has the column, but a partially-applied run of this
  // migration would not — re-querying it unguarded would abort the whole
  // ladder on retry.
  const hasColumn = _db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'methodology');
  const minimalRows = hasColumn
    ? _db.prepare("SELECT name, path FROM projects WHERE methodology = 'minimal'").all()
    : [];

  for (const row of minimalRows) {
    if (!row.path || !fs.existsSync(row.path)) {
      unreachable++;
      log.warn('Cannot seed commit-only wrap overrides — project path is gone', {
        project: row.name,
        path: row.path,
        howToInvestigate: 'This project ran a commit-only wrap. Its directory no longer exists, so nothing could be written. If it returns, it will run the full default wrap pipeline; disable the steps it should not run in Project Settings → Wrap steps.'
      });
      continue;
    }

    const configPath = path.join(row.path, '.tangleclaw', 'project.json');
    let onDisk = {};
    if (fs.existsSync(configPath)) {
      // Raw read, NOT projectConfigApi.load: that helper returns defaults for
      // an unreadable file, which would read as "not yet seeded" and let this
      // migration overwrite a config it could not actually parse.
      try {
        onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (err) {
        unreachable++;
        log.warn('Cannot seed commit-only wrap overrides — project.json is unreadable', {
          project: row.name,
          path: configPath,
          error: err.message,
          howToInvestigate: 'Fix the JSON syntax, then disable the unwanted wrap steps in Project Settings → Wrap steps. Left as-is, this project will run the full default wrap pipeline.'
        });
        continue;
      }
    }
    if (onDisk.wrapOverridesSeeded) continue;

    const config = projectConfigApi.load(row.path);
    const existing = config.wrapStepOverrides || {};
    if (Object.keys(existing).length === 0) {
      const overrides = {};
      for (const step of wrapDefaultPipeline.steps()) {
        if (wrapStepOverrides.UNDISABLEABLE_KINDS.has(step.kind)) continue;
        overrides[step.id] = { enabled: false };
      }
      config.wrapStepOverrides = overrides;
    }
    config.wrapOverridesSeeded = true;
    try {
      projectConfigApi.save(row.path, config);
      seeded++;
    } catch (err) {
      // Match the two skip paths above: an unwritable project.json is that
      // project's problem, not a reason to abort startup for every project.
      // Throwing here would leave the server dead on every restart with no
      // indication of which project caused it.
      unreachable++;
      log.warn('Cannot seed commit-only wrap overrides — project.json is unwritable', {
        project: row.name,
        path: configPath,
        error: err.message,
        howToInvestigate: 'Fix the file permissions, then disable the unwanted wrap steps in Project Settings → Wrap steps. Left as-is, this project will run the full default wrap pipeline.'
      });
    }
  }

  // Snapshot before the first destructive migration TangleClaw has shipped.
  // Every prior migration added; this one DROPs four columns, so a downgrade to
  // an older TangleClaw cannot read the result and the dropped values are
  // unrecoverable from the live file. Same seed-once shape as the #240 legacy
  // rules backup: never overwrite an existing snapshot, and never fail the
  // migration over it — a missing backup is worse than no backup only if it
  // stops the upgrade.
  const backupPath = _dbFile + '.pre-v28-backup';
  try {
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(_dbFile, backupPath);
      log.info('Backed up the database before dropping methodology columns (#538)', {
        path: backupPath,
        howToInvestigate: 'This is a one-time snapshot of the pre-v28 schema. Delete it once you are satisfied with the upgrade; TangleClaw never reads it.'
      });
    }
  } catch (err) {
    log.warn('Could not back up the database before the v27→v28 column drops', {
      path: backupPath,
      error: err.message
    });
  }

  // Indexes must go before the columns they cover — SQLite refuses to drop an
  // indexed column.
  _db.exec('DROP INDEX IF EXISTS idx_projects_methodology');
  _db.exec('DROP INDEX IF EXISTS idx_eval_scores_project_time');
  for (const [table, column] of [
    ['projects', 'methodology'],
    ['sessions', 'methodology_phase'],
    ['eval_scores', 'methodology'],
    ['eval_baselines', 'methodology']
  ]) {
    try {
      _db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    } catch (err) {
      // A fresh DB created by _createTables never had the column.
      log.debug('Migration v27→v28: column already absent', { table, column, error: err.message });
    }
  }
  _db.exec('CREATE INDEX IF NOT EXISTS idx_eval_scores_project_time ON eval_scores(scored_at)');

  // Postcondition: refuse to advance the version while the column survives.
  // Stamping v28 over a live `methodology` column would leave the codebase
  // reading a field the schema still enforces NOT NULL on, and every
  // subsequent project insert would fail.
  const cols = _db.prepare('PRAGMA table_info(projects)').all();
  if (cols.some((c) => c.name === 'methodology')) {
    throw new Error(
      'v27→v28 migration did not drop projects.methodology. Aborting — schema_version '
      + 'will NOT advance to 28 until this is resolved. See #538.'
    );
  }

  log.info('Migration v27→v28: methodology layer retired (#538)', {
    seeded,
    unreachable,
    minimalProjects: minimalRows.length
  });
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
 * The one exception is RETIRED_ENGINE_IDS (#457/#458): the union semantics
 * mean deleting a bundled profile would silently promote the previously
 * synced user-local copy to an immortal "operator profile". Retired ids are
 * tombstoned explicitly — their user-local file is removed on boot, with a
 * warn breadcrumb, so retirement actually reaches existing installs.
 *
 * @param {string} srcDir - Bundled engines dir (`data/engines/`).
 * @param {string} destDir - User-local engines dir (`~/.tangleclaw/engines/`).
 */

// Bundled engines TC has retired. gemini: Google sunset Gemini CLI for
// individual accounts 2026-06-18 (Antigravity is the successor, #457).
// genesis: non-functional placeholder profile removed from the picker (#458).
const RETIRED_ENGINE_IDS = ['gemini', 'genesis'];

function _syncBundledEngines(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  }

  // Tombstone pass — remove user-local copies of retired bundled engines
  // (#457/#458). Without this, the union semantics below keep the stale
  // synced copy alive forever after the bundled file is deleted.
  for (const id of RETIRED_ENGINE_IDS) {
    const stalePath = path.join(destDir, `${id}.json`);
    if (!fs.existsSync(stalePath)) continue;
    try {
      fs.unlinkSync(stalePath);
      log.warn('Removed retired engine profile (#457/#458)', {
        engine: id,
        path: stalePath,
        howToInvestigate: 'This engine was retired from TangleClaw. If you need a custom profile with this behavior, re-create it under a DIFFERENT id in ~/.tangleclaw/engines/ — this id is tombstoned and will be removed again on every boot.'
      });
    } catch (err) {
      log.warn('Could not remove retired engine profile', { engine: id, error: err.message });
    }
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
   * Get a project by its absolute path. Lets path-keyed consumers (e.g.
   * engine-hook sync) resolve DB-backed fields like `engineId` without
   * threading the row through every caller.
   * @param {string} projectPath - Absolute project path
   * @returns {object|null}
   */
  getByPath(projectPath) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM projects WHERE path = ?').get(projectPath);
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

    try {
      const stmt = _db.prepare(
        `INSERT INTO projects (name, path, engine_id, tags, ports)
         VALUES (?, ?, ?, ?, ?)`
      );
      stmt.run(data.name, data.path, engineId, tags, ports);

      const project = projectsApi.getByName(data.name);
      activityApi.log({
        projectId: project.id,
        eventType: 'project.created',
        detail: { name: data.name, engine: engineId }
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
   * @param {string} [data.sessionMode='tmux'] - Session mode ('tmux' or 'webui')
   * @returns {object} - Created session
   */
  start(data) {
    _ensureDb();
    if (!data.projectId || !data.engineId) {
      throw new StoreError('projectId and engineId are required', 'BAD_REQUEST');
    }
    const stmt = _db.prepare(
      `INSERT INTO sessions (project_id, engine_id, tmux_session, prime_prompt, session_mode, launch_mode, owner)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      data.projectId,
      data.engineId,
      data.tmuxSession || null,
      data.primePrompt || null,
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
 * @param {string} [criticGate] - SR-7K2P: attested Critic-gate status
 *   ('passed' | 'not-required' | 'unknown'). Absent an explicit attestation it is
 *   derived from the author — an operator edit legitimately skips the gate
 *   ('not-required'); an AI edit with no attestation is honestly 'unknown' (a
 *   landed AI edit *should* be 'passed', but the writer never assumes it).
 *   Callers must validate an explicit value via `_validateCriticGate` before any
 *   mutation, so this writer trusts the value it receives.
 */
function _snapshotSessionRule(ruleRow, op, changedBy = 'operator', changeReason = null, criticGate = undefined) {
  const gate = (criticGate === undefined || criticGate === null)
    ? (changedBy === 'ai' ? 'unknown' : 'not-required')
    : criticGate;
  const next = _db.prepare(
    'SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM session_rule_versions WHERE rule_id = ?'
  ).get(ruleRow.id).n;
  _db.prepare(
    `INSERT INTO session_rule_versions
       (rule_id, version_no, op, content, enabled, created_by, owner, changed_by, change_reason, critic_gate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ruleRow.id, next, op, ruleRow.content, ruleRow.enabled,
    ruleRow.created_by, ruleRow.owner, changedBy, changeReason, gate
  );
  _pruneSessionRuleVersions(ruleRow.id, _sessionRuleVersionRetention);
}

/**
 * Default per-rule retention for `session_rule_versions` (SR-5T1J). Each snapshot
 * write trims a rule's history to the newest this-many versions, bounding the
 * unbounded-growth failure mode under high autonomous (AI) edit volume. The
 * newest versions are always kept, so every restore target within the window,
 * the rule's current state (its latest version), and a deleted rule's tombstone
 * (`op='delete'`, that rule's latest version) survive — pruning only drops the
 * oldest, no-longer-restorable snapshots. `version_no` stays monotonic
 * (`MAX+1`); pruning leaves harmless gaps because `restore` looks a version up by
 * exact `version_no`, never by position. A value <= 0 disables pruning (keep all).
 * @type {number}
 */
const SESSION_RULE_VERSION_RETENTION = 200;

/** Live retention, defaulting to the constant; overridable via the test seam. */
let _sessionRuleVersionRetention = SESSION_RULE_VERSION_RETENTION;

/**
 * Test/embedder seam to override the per-rule version retention (SR-5T1J),
 * mirroring `_setBasePath`/`_setBundledGlobalRulesPath`.
 * @param {number} n - Versions to keep per rule; <= 0 keeps all (unbounded)
 */
function _setSessionRuleVersionRetention(n) {
  _sessionRuleVersionRetention = n;
}

/**
 * Trim a rule's version history to the newest `keep` snapshots (SR-5T1J). No-op
 * when `keep <= 0` (unbounded) or the rule already has <= `keep` versions.
 * Deletes only versions strictly older (by `version_no`) than the `keep`-th
 * newest, so the retained window is always the most recent — see
 * `SESSION_RULE_VERSION_RETENTION` for the preserved-invariants rationale.
 * @param {number} ruleId - rule_id whose history to prune
 * @param {number} keep - Newest versions to retain
 */
function _pruneSessionRuleVersions(ruleId, keep) {
  if (!keep || keep <= 0) return;
  _db.prepare(
    `DELETE FROM session_rule_versions
      WHERE rule_id = @ruleId
        AND version_no < (
          SELECT MIN(version_no) FROM (
            SELECT version_no FROM session_rule_versions
             WHERE rule_id = @ruleId
             ORDER BY version_no DESC
             LIMIT @keep
          )
        )`
  ).run({ ruleId, keep });
}

/**
 * Valid `session_rules.status` values (#569) — a rule's review state, distinct
 * from `enabled` (the operator's on/off switch for a rule they own).
 * @type {string[]}
 */
const SESSION_RULE_STATUSES = ['proposed', 'active', 'rejected'];

/**
 * Decide the status a newly-created rule gets.
 *
 * **AI-authored content cannot become a governing rule on the AI's own say-so.**
 * That is the safety property of the self-improvement loop: the wrap may
 * propose, never apply. It is enforced here rather than only at the HTTP
 * boundary because this is the write site — `promoteFromLearning` and any
 * future internal caller reach the table through `create()` without passing
 * through a route.
 *
 * `createdBy` alone cannot decide this, because it records **authorship**, not
 * **authority**: a rule promoted from a learning is genuinely AI-authored, yet
 * the operator clicking Promote is a human decision and must produce a live
 * rule. Collapsing the two would either mislabel provenance (recording an
 * operator as the author of text they did not write) or make the operator's own
 * approval land as another proposal. So authority is carried separately and
 * explicitly by `approvedByOperator`, which only a human-initiated path sets.
 *
 * An explicit `'rejected'` is honored for either author — it records a decision
 * and governs nothing. Operator-authored rules default to `'active'`, which
 * preserves pre-#569 behavior for every existing caller.
 *
 * @param {string} createdBy - 'operator' | 'ai' | 'system' (authorship)
 * @param {string} [requested] - Caller-supplied status, if any
 * @param {boolean} [approvedByOperator] - True only on a path a human initiated
 * @returns {string} The status to persist
 */
function _resolveNewRuleStatus(createdBy, requested, approvedByOperator) {
  if (requested !== undefined && requested !== null) {
    if (!SESSION_RULE_STATUSES.includes(requested)) {
      throw new StoreError(`status must be one of ${SESSION_RULE_STATUSES.join(', ')}`, 'BAD_REQUEST');
    }
    // AI authorship asking for 'active' without a human behind it is exactly
    // the request that must not be granted.
    if (createdBy === 'ai' && requested === 'active' && approvedByOperator !== true) return 'proposed';
    return requested;
  }
  if (createdBy !== 'ai') return 'active';
  return approvedByOperator === true ? 'active' : 'proposed';
}

/**
 * Valid `session_rules.kind` values (CC-6, #381). 'startup' rules inject into
 * the engine config at launch; 'wrap' rules inject into the wrap pipeline's
 * ai-content prompt (and are the self-learning sink). The former 'mode' kind
 * was retired — harness posture is now the structured per-project
 * `defaultLaunchMode`/`showLaunchModePicker` settings, not free-text rules.
 * 'master' rules are the Project Master's editable Hard-rules block
 * (lib/master.js): singleton-scoped (project_id NULL — the master is not a
 * project), rendered into the master's generated CLAUDE.md identity.
 * @type {string[]}
 */
const SESSION_RULE_KINDS = ['startup', 'wrap', 'master'];

/**
 * Valid `session_rule_versions.critic_gate` values (SR-7K2P). Attests whether an
 * edit passed the in-session Critic gate: `passed` (AI edit attested through the
 * gate), `not-required` (operator/trivial edit that legitimately skips it), or
 * `unknown` (backfilled legacy row, or an AI edit applied with no attestation).
 * @type {string[]}
 */
const SESSION_RULE_CRITIC_GATES = ['passed', 'not-required', 'unknown'];

/**
 * Reject an explicit-but-invalid `criticGate` before any mutation runs, so a bad
 * value never leaves a rule row without its version snapshot. `undefined`/`null`
 * mean "no attestation" and pass (the writer derives from the author).
 * @param {string} [criticGate] - Caller-supplied Critic-gate attestation
 * @throws {StoreError} BAD_REQUEST if a non-null value is out of enum
 */
function _validateCriticGate(criticGate) {
  if (criticGate !== undefined && criticGate !== null && !SESSION_RULE_CRITIC_GATES.includes(criticGate)) {
    throw new StoreError(`criticGate must be one of ${SESSION_RULE_CRITIC_GATES.join(', ')}`, 'BAD_REQUEST');
  }
}

const sessionRulesApi = {
  /**
   * The launch-injection query: a project's active **startup** rules. Used by
   * `engines._getRulesContent` to build the cross-model `## Session Rules`
   * section at session launch. CC-6 (#381): only `kind='startup'` injects;
   * 'wrap' rules inject at wrap time instead. The former global tier
   * (project_id IS NULL rows) was retired — cross-project directives belong in
   * the Global rules document (`data/global-rules.md`), not per-row session rules.
   * @param {number|null} projectId - Project id (null/undefined → no rules)
   * @returns {object[]}
   */
  listActiveForProject(projectId) {
    _ensureDb();
    if (projectId === null || projectId === undefined) return [];
    // `id` is a required tiebreaker, not decoration: created_at comes from
    // SQLite's datetime('now'), which has SECOND resolution, so rules added in
    // the same second share a timestamp and their relative order would be
    // unspecified. That matters here beyond presentation — the delivery ledger
    // hashes this block to identify a rule set, and an unstable order would
    // produce a different digest for an unchanged set. Matches listActiveForMaster.
    return _db.prepare(
      `SELECT * FROM session_rules
       WHERE enabled = 1 AND status = 'active' AND kind = 'startup' AND project_id = ?
       ORDER BY created_at, id`
    ).all(projectId).map(_rowToSessionRule);
  },

  /**
   * The master-identity query: the Project Master's active Hard rules, oldest
   * first (stable render order in the generated CLAUDE.md). Master rules are
   * singleton rows — kind 'master', project_id NULL (lib/master.js).
   * @returns {object[]}
   */
  listActiveForMaster() {
    _ensureDb();
    return _db.prepare(
      `SELECT * FROM session_rules
       WHERE enabled = 1 AND status = 'active' AND kind = 'master' AND project_id IS NULL
       ORDER BY created_at, id`
    ).all().map(_rowToSessionRule);
  },

  /**
   * List session rules with optional filters (for the UI/API).
   * @param {object} [options]
   * @param {number} [options.enabled] - Filter by enabled (1 or 0)
   * @param {number} [options.projectId] - Filter by exact project id
   * @param {string} [options.kind] - CC-6: filter by rule kind ('startup'|'wrap'|'master')
   * @param {string} [options.status] - Filter by review state ('proposed'|'active'|'rejected').
   *   Unfiltered by default, because the UI needs to SEE proposals. Any caller
   *   using this list to inject rules into a session or prompt must pass
   *   `status: 'active'` — an unreviewed proposal reaching a live session is the
   *   failure this state exists to prevent (#569).
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
    if (options.projectId !== undefined) {
      conditions.push('project_id = ?');
      params.push(options.projectId);
    }
    if (options.kind !== undefined) {
      conditions.push('kind = ?');
      params.push(options.kind);
    }
    if (options.status !== undefined) {
      conditions.push('status = ?');
      params.push(options.status);
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
   * Create a new session rule. Rules are project-scoped — the former global
   * tier (projectId null) was retired in favor of the Global rules document;
   * cross-project directives belong there. The one exception is the 'master'
   * kind: the Project Master is a singleton above all projects, so its rules
   * carry project_id NULL and a projectId here is rejected.
   * @param {object} data
   * @param {string} data.content - Rule content (required, non-empty)
   * @param {number} [data.projectId] - Project id (required for every kind
   *   except 'master', where it is forbidden)
   * @param {string} [data.createdBy] - 'operator' (default) | 'ai' | 'system'
   *   ('system' marks rows seeded from a shipped baseline)
   * @param {string} [data.kind] - CC-6: 'startup' (default) | 'wrap' | 'master'
   * @param {string} [data.owner] - Owner identity (auth seam, nullable)
   * @param {number} [data.sourceLearningId] - Provenance: the learning this rule
   *   was promoted from (D1b), nullable
   * @param {string} [data.changeReason] - Optional reason recorded on the v1 snapshot
   * @param {string} [data.criticGate] - SR-7K2P: attested Critic-gate status recorded
   *   on the v1 snapshot ('passed' | 'not-required' | 'unknown'); derived from author if omitted
   * @returns {object}
   * @throws {StoreError} BAD_REQUEST on missing/invalid fields; INVALID_PROJECT_ID
   *   when projectId names no existing project (#1121 — e.g. a project name
   *   passed where the numeric id belongs)
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
    if (kind === 'master') {
      if (data.projectId !== undefined && data.projectId !== null) {
        throw new StoreError('master rules are singleton-scoped — projectId must not be set', 'BAD_REQUEST');
      }
    } else if (data.projectId === undefined || data.projectId === null) {
      throw new StoreError('projectId is required — the global session-rules tier was retired; put cross-project directives in the Global rules document', 'BAD_REQUEST');
    } else if (!projectsApi.get(data.projectId)) {
      // #1121: without this check the insert dies on the FK constraint and
      // surfaces as a bare 500. The likeliest caller mistake is passing the
      // project's NAME — every /api/sessions/:project route addresses by name,
      // so the error must say which identifier this API wants.
      throw new StoreError(
        `unknown projectId ${JSON.stringify(data.projectId)} — pass the project's numeric id (see GET /api/projects), not its name`,
        'INVALID_PROJECT_ID'
      );
    }
    _validateCriticGate(data.criticGate);
    const status = _resolveNewRuleStatus(createdBy, data.status, data.approvedByOperator);
    _db.prepare(
      'INSERT INTO session_rules (project_id, content, created_by, kind, owner, source_learning_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      data.projectId ?? null,
      data.content.trim(),
      createdBy,
      kind,
      data.owner ?? null,
      data.sourceLearningId ?? null,
      status
    );
    const row = _db.prepare('SELECT * FROM session_rules WHERE id = last_insert_rowid()').get();
    _snapshotSessionRule(row, 'create', createdBy, data.changeReason ?? null, data.criticGate);
    const rule = _rowToSessionRule(row);
    activityApi.log({
      projectId: rule.projectId,
      eventType: 'session_rule.created',
      // `status` belongs here: this is the write site enforcing "AI authorship
      // cannot mint a governing rule", and without it the audit trail cannot
      // tell a proposal from a live rule — which is the one distinction an
      // auditor of this event would be looking for.
      detail: {
        kind: rule.kind, createdBy: rule.createdBy, status: rule.status,
        contentPreview: rule.content.slice(0, 80)
      }
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
   * @param {string} [updates.criticGate] - SR-7K2P: attested Critic-gate status recorded
   *   on the snapshot ('passed' | 'not-required' | 'unknown'); derived from author if omitted
   * @returns {object}
   */
  update(id, updates = {}) {
    _ensureDb();
    _validateCriticGate(updates.criticGate);
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
    _snapshotSessionRule(updated, 'update', updates.changedBy || 'operator', updates.changeReason ?? null, updates.criticGate);
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
   * @param {string} [opts.criticGate] - SR-7K2P: attested Critic-gate status recorded
   *   on the restore snapshot ('passed' | 'not-required' | 'unknown'); derived from author if omitted
   * @returns {object} - The restored rule
   */
  restore(id, versionNo, opts = {}) {
    _ensureDb();
    _validateCriticGate(opts.criticGate);
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
    _snapshotSessionRule(updated, 'restore', opts.changedBy || 'operator', `restored to version ${versionNo}`, opts.criticGate);
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
   * @param {number} [overrides.projectId] - Scope (defaults to the learning's
   *   own project — rules are always project-scoped since the global tier retired)
   * @param {string} [overrides.createdBy] - Defaults 'ai'
   * @param {string} [overrides.kind] - CC-6: target kind (defaults 'startup'). The
   *   wrap-time self-critique loop promotes into 'wrap'.
   * @param {string} [overrides.criticGate] - SR-7K2P: attested Critic-gate status. A
   *   promotion is AI-authored, so absent an attestation the v1 snapshot records 'unknown'.
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
      projectId: overrides.projectId ?? learning.project_id,
      createdBy: overrides.createdBy || 'ai',
      kind: overrides.kind || 'startup',
      sourceLearningId: learningId,
      changeReason: `promoted from learning ${learningId}`,
      criticGate: overrides.criticGate,
      status: overrides.status,
      // The existing `/promote` route is the operator pressing Promote, so it
      // passes this and gets a live rule. The wrap's proposal step calls the
      // same method without it and gets a proposal — one code path, and which
      // one you get depends on whether a human decided.
      approvedByOperator: overrides.approvedByOperator
    });
  },

  /**
   * Resolve a proposal: approve it into a governing rule, or reject it (#569).
   *
   * Rejection is recorded rather than deleted, and that is the point: the wrap
   * proposes from recurring learnings, so a deleted rejection would simply be
   * re-proposed at the next wrap that saw the same learning. A `'rejected'` row
   * is the memory of the operator's answer.
   *
   * Snapshots a version like every other mutation, so the decision appears in
   * the rule's history rather than only in an activity log. Note the limit:
   * `session_rule_versions` has no `status` column, so the snapshot records the
   * transition in free-text `change_reason` plus `changed_by`, not as queryable
   * state. Two adjacent versions differing only by status therefore look
   * near-identical in the history UI. Adding the column is a table rebuild
   * (SQLite cannot ALTER in a CHECK) and is deliberately deferred.
   *
   * @param {number} id - Rule id
   * @param {string} status - 'proposed' | 'active' | 'rejected'
   * @param {object} [opts]
   * @param {string} [opts.changedBy] - 'operator' (default) | 'ai'
   * @param {string} [opts.changeReason] - Recorded on the snapshot
   * @returns {object} The updated rule
   */
  setStatus(id, status, opts = {}) {
    _ensureDb();
    if (!SESSION_RULE_STATUSES.includes(status)) {
      throw new StoreError(`status must be one of ${SESSION_RULE_STATUSES.join(', ')}`, 'BAD_REQUEST');
    }
    const row = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    if (!row) throw new StoreError(`Session rule ${id} not found`, 'NOT_FOUND');

    const changedBy = opts.changedBy || 'operator';
    // An AI cannot approve its own proposal. Same property as `create()`, at the
    // other door into 'active' — a gate on one entrance is not a gate.
    if (changedBy === 'ai' && status === 'active') {
      throw new StoreError(
        'an AI cannot approve a proposed rule into an active one — approval is an operator decision',
        'FORBIDDEN'
      );
    }

    _db.prepare("UPDATE session_rules SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
    const updated = _db.prepare('SELECT * FROM session_rules WHERE id = ?').get(id);
    _snapshotSessionRule(updated, 'update', changedBy,
      opts.changeReason ?? `status ${row.status || 'active'} → ${status}`, opts.criticGate);
    activityApi.log({
      projectId: updated.project_id,
      eventType: 'session_rule.updated',
      detail: { id, from: row.status || 'active', to: status }
    });
    return _rowToSessionRule(updated);
  },

  /**
   * Surface CANDIDATE conflicts for a proposed rule (D1b) — the given project's
   * active rules sharing significant token overlap with the proposed content.
   * This is a NON-AUTHORITATIVE signal for the AI/operator to judge; per the
   * ratified design it does NOT auto-resolve and does NOT decide a conflict —
   * it only narrows what to compare before a Critic-gated review. Returns
   * matches sorted by overlap (most first).
   * @param {string} content - Proposed rule content
   * @param {number|null} [projectId] - Project to compare within (null → no matches)
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
    if (projectId === null || projectId === undefined) return [];
    const active = _db.prepare(
      // `status = 'active'` matters here as the proposal queue grows: this
      // answers "what might a new rule conflict with", and an unreviewed
      // proposal or a rule the operator already declined is not something to
      // reconcile against. Without it, every accumulated proposal would start
      // surfacing as a conflict candidate against the next one.
      `SELECT * FROM session_rules
       WHERE enabled = 1 AND status = 'active' AND project_id = ?${kindClause}
       ORDER BY created_at`
    ).all(projectId, ...kindParams);
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
 * The channels a session-rule block can travel to an engine (#595). Pinned as an
 * enum because the CHECK constraint on `session_rule_deliveries.channel` rejects
 * anything else — a typo would otherwise surface as an opaque SQLite error at
 * launch, on the path whose whole purpose is to make delivery observable.
 *
 * - `rules-hook`  — written to `.tangleclaw/session-rules-<n>.json` and read by
 *   a dedicated SessionStart hook, one per shard (#749). This is where startup
 *   rules go on a silent-prime engine. They rode `prime-file` until the engine's
 *   output cap started replacing that payload wholesale and taking them with it.
 * - `prime-file`  — written to `.tangleclaw/session-prime.md`, read by the
 *   engine's SessionStart hook as hidden context. Still the prime's own channel,
 *   and the value pre-#749 rows carry.
 * - `prime-paste` — pasted into the TUI via tmux send-keys at startup.
 * - `none`        — no channel exists for this engine; paired with a skipReason.
 * @type {string[]}
 */
const SESSION_RULE_DELIVERY_CHANNELS = ['prime-file', 'prime-paste', 'rules-hook', 'none'];

/**
 * The outcomes a delivery attempt can have (#595) — the ledger's source of
 * truth, deliberately an enum rather than a delivered boolean. Under a
 * boolean, "the project has no rules" and "the rules arrived" are the same
 * value, which is the conflation the ledger exists to end.
 *
 * - `delivered`  — the rule block reached the engine, and the writer observed
 *                  the channel ready to receive it.
 * - `no-rules`   — the launch path ran; the project had no active startup rules.
 * - `skipped`    — rules existed and did not arrive; `skipReason` says why.
 * - `unverified` — the block was sent and nothing observed the far side (#1063);
 *                  `skipReason` says what made it unobservable. A blind paste
 *                  records this, never `delivered` — a fully broken channel
 *                  must not produce a clean ledger.
 * @type {string[]}
 */
const SESSION_RULE_DELIVERY_OUTCOMES = ['delivered', 'no-rules', 'skipped', 'unverified'];

/**
 * Rows kept per project in the delivery ledger before the oldest are pruned.
 *
 * The ledger is written once or twice per launch and would otherwise grow
 * without bound for the life of the install. Its questions are all about
 * *recent* state ("is this project receiving its rules?"), so deep history has
 * no consumer — matching the retention precedent already set by
 * `SESSION_RULE_VERSION_RETENTION` in this same subsystem.
 * @type {number}
 */
let SESSION_RULE_DELIVERY_RETENTION = 100;

/**
 * Override the delivery-retention cap. Test seam only, mirroring
 * `_setSessionRuleVersionRetention`.
 * @param {number} n - New per-project retention cap
 * @returns {void}
 */
function _setSessionRuleDeliveryRetention(n) {
  SESSION_RULE_DELIVERY_RETENTION = n;
}

/**
 * Map a `session_rule_deliveries` row to the camelCase shape the API/UI consume.
 * `ruleIds` is stored as a JSON array and parsed here so no caller has to know
 * the encoding; a corrupt value degrades to `[]` rather than throwing, because a
 * malformed audit row must never break the launch path that writes the next one.
 * @param {object} row - Raw SQLite row
 * @returns {{id: number, sessionId: number|null, projectId: number|null, engineId: string, kind: string, channel: string, outcome: string, delivered: boolean, skipReason: string|null, ruleIds: number[], ruleCount: number, digest: string, createdAt: string}}
 */
function _rowToSessionRuleDelivery(row) {
  let ruleIds = [];
  try {
    const parsed = JSON.parse(row.rule_ids);
    if (Array.isArray(parsed)) ruleIds = parsed;
  } catch {
    // Corrupt JSON in an audit column — report an empty set rather than throw.
    log.warn('session_rule_deliveries.rule_ids is not valid JSON', { id: row.id });
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    engineId: row.engine_id,
    kind: row.kind,
    channel: row.channel,
    outcome: row.outcome,
    // Derived from `outcome`, never stored independently — a convenience for
    // consumers that only care "did it arrive", with no second source of truth
    // that could disagree.
    delivered: row.outcome === 'delivered',
    skipReason: row.skip_reason,
    ruleIds,
    ruleCount: row.rule_count,
    digest: row.digest,
    createdAt: row.created_at
  };
}

/**
 * Trim a project's delivery history to the retention cap, oldest first.
 * Runs after each insert so the ledger stays bounded without a sweeper.
 *
 * Scoped per project, so rows with a NULL `project_id` are never pruned. That
 * is deliberate rather than an oversight: no production path writes one (both
 * launch paths always carry a project), so such rows can only arrive via a
 * direct store call, and a global sweeper would be machinery for a case the
 * product does not produce.
 * @param {number} projectId - Project whose history to prune
 * @returns {number} Rows deleted
 */
function _pruneSessionRuleDeliveries(projectId) {
  const info = _db.prepare(
    `DELETE FROM session_rule_deliveries
      WHERE project_id = ?
        AND id NOT IN (
          SELECT id FROM session_rule_deliveries
           WHERE project_id = ? ORDER BY id DESC LIMIT ?
        )`
  ).run(projectId, projectId, SESSION_RULE_DELIVERY_RETENTION);
  return info.changes;
}

const sessionRuleDeliveriesApi = {
  /**
   * Record one delivery attempt of a session-rule block (#595).
   *
   * Every outcome is recorded deliberately. `outcome` is the discriminator that
   * keeps "this engine has no channel" (`skipped`, with a reason) separate from
   * "this project has no rules" (`no-rules`) and from a real delivery — three
   * states that a single boolean collapses into two, which is how startup rules
   * stayed severed on 13 projects without anyone noticing.
   *
   * @param {object} entry
   * @param {number|null} [entry.sessionId] - Session this delivery belongs to
   * @param {number|null} [entry.projectId] - Project whose rules were delivered
   * @param {string} entry.engineId - Engine that received (or could not receive) the block
   * @param {string} [entry.kind] - Rule tier delivered (default 'startup')
   * @param {string} entry.channel - One of SESSION_RULE_DELIVERY_CHANNELS
   * @param {string} entry.outcome - One of SESSION_RULE_DELIVERY_OUTCOMES
   * @param {string} [entry.skipReason] - Why not; required when outcome is 'skipped'
   * @param {number[]} [entry.ruleIds] - Rule ids in delivery order
   * @param {string} [entry.digest] - sha256 of the rule content ('' when no rules)
   * @returns {object} The recorded delivery
   * @throws {StoreError} BAD_REQUEST on a missing engineId, a bad channel or
   *   outcome, a skip with no reason, or a delivery claimed through no channel
   */
  record(entry = {}) {
    _ensureDb();
    if (!entry.engineId) throw new StoreError('engineId is required', 'BAD_REQUEST');
    if (!SESSION_RULE_DELIVERY_CHANNELS.includes(entry.channel)) {
      throw new StoreError(`channel must be one of ${SESSION_RULE_DELIVERY_CHANNELS.join(', ')}`, 'BAD_REQUEST');
    }
    if (!SESSION_RULE_DELIVERY_OUTCOMES.includes(entry.outcome)) {
      throw new StoreError(`outcome must be one of ${SESSION_RULE_DELIVERY_OUTCOMES.join(', ')}`, 'BAD_REQUEST');
    }
    // A skip or an unverified send with no reason is the useless row: it
    // records that something went wrong while discarding the only field that
    // says what.
    if ((entry.outcome === 'skipped' || entry.outcome === 'unverified') && !entry.skipReason) {
      throw new StoreError(`skipReason is required when outcome is '${entry.outcome}'`, 'BAD_REQUEST');
    }
    // "Delivered through no channel" is self-contradictory, and so is an
    // unverified SEND through no channel. This ledger's only value is that its
    // rows can be trusted as evidence of what reached an engine, so a state
    // that cannot be true must not be storable.
    if ((entry.outcome === 'delivered' || entry.outcome === 'unverified') && entry.channel === 'none') {
      throw new StoreError(`channel 'none' cannot be ${entry.outcome}`, 'BAD_REQUEST');
    }
    const ruleIds = Array.isArray(entry.ruleIds) ? entry.ruleIds : [];
    const info = _db.prepare(
      `INSERT INTO session_rule_deliveries
         (session_id, project_id, engine_id, kind, channel, outcome, skip_reason, rule_ids, rule_count, digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.sessionId ?? null,
      entry.projectId ?? null,
      entry.engineId,
      entry.kind || 'startup',
      entry.channel,
      entry.outcome,
      (entry.outcome === 'skipped' || entry.outcome === 'unverified') ? entry.skipReason : null,
      JSON.stringify(ruleIds),
      ruleIds.length,
      entry.digest || ''
    );
    if (entry.projectId !== null && entry.projectId !== undefined) {
      _pruneSessionRuleDeliveries(entry.projectId);
    }
    return _rowToSessionRuleDelivery(
      _db.prepare('SELECT * FROM session_rule_deliveries WHERE id = ?').get(info.lastInsertRowid)
    );
  },

  /**
   * Every delivery recorded for one session, oldest first — the direct answer to
   * "did session X receive rule set Y at version Z" (compare `digest`).
   * @param {number} sessionId
   * @returns {object[]}
   */
  listForSession(sessionId) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM session_rule_deliveries WHERE session_id = ? ORDER BY id'
    ).all(sessionId).map(_rowToSessionRuleDelivery);
  },

  /**
   * A project's delivery history, newest first, for the operator-facing
   * "is this project actually receiving its rules" view.
   * @param {number} projectId
   * @param {object} [options]
   * @param {number} [options.limit=20] - Max rows
   * @returns {object[]}
   */
  listForProject(projectId, options = {}) {
    _ensureDb();
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
    return _db.prepare(
      'SELECT * FROM session_rule_deliveries WHERE project_id = ? ORDER BY id DESC LIMIT ?'
    ).all(projectId, limit).map(_rowToSessionRuleDelivery);
  },

  /**
   * The most recent delivery attempt for a project, or null if it has never had
   * one. A null here on a project that has been launched means the launch path
   * never reached the ledger — itself a finding.
   * @param {number} projectId
   * @returns {object|null}
   */
  latestForProject(projectId) {
    _ensureDb();
    const row = _db.prepare(
      'SELECT * FROM session_rule_deliveries WHERE project_id = ? ORDER BY id DESC LIMIT 1'
    ).get(projectId);
    return row ? _rowToSessionRuleDelivery(row) : null;
  },

  /**
   * The fleet-wide health question #595 was filed to answer: which projects
   * that HAVE startup rules are not currently receiving them.
   *
   * Judged on the MOST RECENT delivery attempt, not on whether any `delivered`
   * row exists in history (#1063). History-wide NOT EXISTS was the poisoned
   * form: the paste path recorded fabricated `delivered` rows for 12 days, the
   * migration preserves them verbatim (the audit trail is not rewritten), and
   * under NOT EXISTS those rows would have hidden the exact 8 projects this
   * view exists to surface — forever. The latest attempt is also the honest
   * health signal: a channel that delivered last month and skips today is
   * broken today.
   *
   * Scoped to projects with rules on purpose — a project with none has nothing
   * to deliver and is not a finding. `lastOutcome` distinguishes the ways of
   * failing: `skipped` (a channel exists and the block did not arrive),
   * `unverified` (the block was sent and nothing confirmed it landed — #1063),
   * and `null` (no launch ever reached the ledger at all). Only a latest
   * outcome of `delivered` counts as delivered: an unverified-latest project
   * surfaces, which is the point.
   *
   * @returns {Array<{projectId: number, projectName: string, ruleCount: number, lastOutcome: string|null, lastSkipReason: string|null}>}
   */
  projectsWithUndeliveredRules() {
    _ensureDb();
    return _db.prepare(
      `SELECT p.id   AS projectId,
              p.name AS projectName,
              (SELECT COUNT(*) FROM session_rules r
                WHERE r.project_id = p.id AND r.enabled = 1 AND r.kind = 'startup') AS ruleCount,
              (SELECT d.outcome FROM session_rule_deliveries d
                WHERE d.project_id = p.id ORDER BY d.id DESC LIMIT 1) AS lastOutcome,
              (SELECT d.skip_reason FROM session_rule_deliveries d
                WHERE d.project_id = p.id ORDER BY d.id DESC LIMIT 1) AS lastSkipReason
         FROM projects p
        WHERE ruleCount > 0
          AND (lastOutcome IS NULL OR lastOutcome != 'delivered')
        ORDER BY p.name`
    ).all();
  }
};

/** @type {string[]} Channels a Switchboard nudge can ride (#792). */
const MEDUSA_DELIVERY_CHANNELS = ['tmux-inject', 'master-inject', 'none'];

/**
 * @type {string[]} What became of a nudge for one inbox edge (#792).
 * `nudged` reached the pane, `failed` was attempted and did not, `skipped` was
 * never attempted and says why. Two of the three are misses, and keeping them
 * apart is the point: an injection that failed is a broken channel, while a
 * skip is usually a gate doing its job — collapsing them into "not delivered"
 * loses the distinction the ledger exists to make.
 */
const MEDUSA_DELIVERY_OUTCOMES = ['nudged', 'skipped', 'failed'];

/** @type {number} Rows retained per session before the oldest are pruned. */
let MEDUSA_DELIVERY_RETENTION = 100;

/**
 * Map a `medusa_deliveries` row to its API shape.
 * @param {object} row - Raw SQLite row.
 * @returns {object} The delivery record.
 */
function _rowToMedusaDelivery(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    messageKey: row.message_key,
    unread: row.unread,
    channel: row.channel,
    outcome: row.outcome,
    // Derived from `outcome`, never stored separately — a convenience for
    // consumers that only care "was anyone told", with no second source of
    // truth that could disagree with the column it is derived from.
    nudged: row.outcome === 'nudged',
    skipReason: row.skip_reason,
    createdAt: row.created_at
  };
}

/**
 * Keep a session's ledger bounded. The monitor observes continuously, so
 * without a cap a long-lived session's history grows without end.
 * @param {string|number} sessionId
 * @returns {number} Rows deleted.
 */
function _pruneMedusaDeliveries(sessionId) {
  const info = _db.prepare(
    `DELETE FROM medusa_deliveries
      WHERE session_id = ?
        AND id NOT IN (
          SELECT id FROM medusa_deliveries
           WHERE session_id = ? ORDER BY id DESC LIMIT ?
        )`
  ).run(sessionId, sessionId, MEDUSA_DELIVERY_RETENTION);
  return info.changes;
}

const medusaDeliveriesApi = {
  /**
   * Record what became of one Switchboard nudge for one inbox edge (#792).
   *
   * The caller is expected to record a TRANSITION, not a poll: the wake monitor
   * runs on a timer, so writing a row per tick would bury the one event that
   * matters under thousands of identical rows and defeat retention. See
   * `lib/medusa-wake.js` for the de-duplication that decides when to call this.
   *
   * @param {object} entry
   * @param {string|number|null} [entry.sessionId] - Session the mail was addressed to ('master' for the Project Master)
   * @param {number|null} [entry.projectId] - Its project (null for the Master)
   * @param {string} [entry.workspaceId] - The Medusa workspace id
   * @param {string} entry.messageKey - The inbox edge this nudge was about
   * @param {number} [entry.unread] - Unread count at the time
   * @param {string} entry.channel - One of MEDUSA_DELIVERY_CHANNELS
   * @param {string} entry.outcome - One of MEDUSA_DELIVERY_OUTCOMES
   * @param {string} [entry.skipReason] - Why not; required unless nudged
   * @returns {object} The recorded delivery
   * @throws {StoreError} BAD_REQUEST on a missing key, a bad channel or outcome,
   *   a non-delivery with no reason, or a nudge claimed through no channel
   */
  record(entry = {}) {
    _ensureDb();
    if (!entry.messageKey) throw new StoreError('messageKey is required', 'BAD_REQUEST');
    if (!MEDUSA_DELIVERY_CHANNELS.includes(entry.channel)) {
      throw new StoreError(`channel must be one of ${MEDUSA_DELIVERY_CHANNELS.join(', ')}`, 'BAD_REQUEST');
    }
    if (!MEDUSA_DELIVERY_OUTCOMES.includes(entry.outcome)) {
      throw new StoreError(`outcome must be one of ${MEDUSA_DELIVERY_OUTCOMES.join(', ')}`, 'BAD_REQUEST');
    }
    // A miss with no reason is the useless row: it records that the message did
    // not land while discarding the only field that says why not.
    if (entry.outcome !== 'nudged' && !entry.skipReason) {
      throw new StoreError("skipReason is required unless outcome is 'nudged'", 'BAD_REQUEST');
    }
    // "Nudged through no channel" is self-contradictory, and this ledger's only
    // value is that its rows can be trusted as evidence of what reached a pane.
    if (entry.outcome === 'nudged' && entry.channel === 'none') {
      throw new StoreError("channel 'none' cannot be nudged", 'BAD_REQUEST');
    }
    const info = _db.prepare(
      `INSERT INTO medusa_deliveries
         (session_id, project_id, workspace_id, message_key, unread, channel, outcome, skip_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.sessionId == null ? null : String(entry.sessionId),
      entry.projectId ?? null,
      entry.workspaceId ?? null,
      String(entry.messageKey),
      Number.isInteger(entry.unread) ? entry.unread : 0,
      entry.channel,
      entry.outcome,
      entry.outcome === 'nudged' ? null : entry.skipReason
    );
    if (entry.sessionId !== null && entry.sessionId !== undefined) {
      _pruneMedusaDeliveries(entry.sessionId);
    }
    return _rowToMedusaDelivery(
      _db.prepare('SELECT * FROM medusa_deliveries WHERE id = ?').get(info.lastInsertRowid)
    );
  },

  /**
   * One session's nudge history, newest first — the direct answer to "was this
   * session ever told about the mail sitting in its inbox".
   * @param {number} sessionId
   * @param {object} [options]
   * @param {number} [options.limit=20] - Max rows
   * @returns {object[]}
   */
  listForSession(sessionId, options = {}) {
    _ensureDb();
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
    return _db.prepare(
      'SELECT * FROM medusa_deliveries WHERE session_id = ? ORDER BY id DESC LIMIT ?'
    ).all(String(sessionId), limit).map(_rowToMedusaDelivery);
  },

  /**
   * The most recent nudge outcome for a session, or null if it has never had
   * one. A null on a session with unread mail means nobody has been told.
   * @param {string|number} sessionId
   * @returns {object|null}
   */
  latestForSession(sessionId) {
    _ensureDb();
    const row = _db.prepare(
      'SELECT * FROM medusa_deliveries WHERE session_id = ? ORDER BY id DESC LIMIT 1'
    ).get(String(sessionId));
    return row ? _rowToMedusaDelivery(row) : null;
  },

  /**
   * Every session whose most recent recorded outcome for its newest inbox edge
   * was a MISS — the fleet-wide answer #792 asks for: which sessions have mail
   * nobody has been told about. Ordered oldest-miss-first, so the longest-
   * standing silence reads at the top.
   * @returns {object[]}
   */
  sessionsWithUndeliveredMail() {
    _ensureDb();
    return _db.prepare(
      `SELECT d.session_id  AS sessionId,
              d.project_id  AS projectId,
              d.workspace_id AS workspaceId,
              d.message_key AS messageKey,
              d.unread      AS unread,
              d.outcome     AS outcome,
              d.skip_reason AS skipReason,
              d.created_at  AS createdAt
         FROM medusa_deliveries d
         JOIN (SELECT session_id, MAX(id) AS id
                 FROM medusa_deliveries GROUP BY session_id) newest
           ON newest.id = d.id
        WHERE d.outcome != 'nudged'
        ORDER BY d.created_at, d.session_id`
    ).all();
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
   * @param {boolean} [data.force] - Take over a live lease held by a different
   *   project. Without it, such a request throws `PORT_CONFLICT` (the error
   *   carries the current lease on `.owner`). Re-leasing a port this same
   *   project already holds is a renewal and never needs it.
   * @returns {object}
   * @throws {StoreError} `PORT_CONFLICT` when another project holds a live
   *   lease on the port and `force` was not set
   */
  lease(data) {
    _ensureDb();
    if (!data.port || !data.project || !data.service) {
      throw new StoreError('port, project, and service are required', 'BAD_REQUEST');
    }

    const host = data.host || 'localhost';

    // Ownership check BEFORE the upsert. PortHub's entire purpose is conflict
    // prevention, and until now that guarantee rested on every client choosing
    // to check first — which failed live: a session leased a port that a
    // running project already owned, the previous owner's row was overwritten
    // with no error and no record, and recovery meant digging the old row out
    // of a Time Machine snapshot. Enforcing it here rather than in the route
    // means no caller can bypass it, including the in-process ones.
    //
    // Only a LIVE lease blocks. An expired one is already garbage awaiting the
    // sweep, so taking its port is not a conflict.
    const existing = portLeasesApi.get(data.port, host);
    if (existing && existing.project !== data.project && _isLeaseLive(existing)) {
      if (!data.force) {
        // Log the refusal, not just the takeover. A project failing to claim
        // its port is the FAR more common outcome and may repeat every boot;
        // without this the only trace is whatever the caller chooses to
        // report, which for a raw API client is nothing.
        log.warn('Refused port lease — another project holds it', {
          host,
          port: data.port,
          owner: existing.project,
          ownerService: existing.service,
          requestedBy: data.project,
          requestedService: data.service
        });
        const err = new StoreError(
          `Port ${data.port} on ${host} is leased by "${existing.project}" (${existing.service}). ` +
          'Release it first, pick another port, or repeat with force to take it over.',
          'PORT_CONFLICT'
        );
        err.owner = existing;
        throw err;
      }
      // A forced takeover is legitimate but must never be quiet — the displaced
      // owner keeps running against a port the registry no longer says is
      // theirs, and this log is the only trace of who held it.
      log.warn('Forced takeover of another project\'s port lease', {
        host,
        port: data.port,
        displacedProject: existing.project,
        displacedService: existing.service,
        newProject: data.project,
        newService: data.service
      });
      activityApi.log({
        eventType: 'port.takeover',
        detail: {
          host,
          port: data.port,
          displacedProject: existing.project,
          displacedService: existing.service,
          project: data.project,
          service: data.service
        }
      });
    }
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
   *
   * Ownership is verified only when the caller names its project (#656). A release
   * is a silent DELETE — if a caller releases a port a DIFFERENT project still runs
   * against, that project keeps running with no registry record and the next
   * claimant collides. When `options.project` is given, a LIVE lease held by another
   * project is refused with `PORT_CONFLICT` (mirroring the lease path, #613), and
   * `options.force` overrides with an audit log. Omitting `project` preserves the
   * prior unverified behavior for trusted internal teardown paths (e.g. tunnel
   * shutdown) that release ports they own without carrying a project name. An
   * expired lease is garbage awaiting the sweep, so releasing it is never a conflict.
   *
   * @param {number} port
   * @param {string} [host='localhost'] - Host identifier
   * @param {object} [options] - Ownership options
   * @param {string|null} [options.project] - Verify the lease belongs to this project
   * @param {boolean} [options.force] - Release another project's live lease anyway
   * @throws {StoreError} `PORT_CONFLICT` when `options.project` is given but a live
   *   lease is held by a different project and `force` was not set
   */
  release(port, host = 'localhost', options = {}) {
    _ensureDb();
    const existing = portLeasesApi.get(port, host);

    if (existing && options.project && existing.project !== options.project && _isLeaseLive(existing)) {
      if (!options.force) {
        log.warn('Refused port release — another project holds it', {
          host,
          port,
          owner: existing.project,
          ownerService: existing.service,
          requestedBy: options.project
        });
        const err = new StoreError(
          `Port ${port} on ${host} is leased by "${existing.project}" (${existing.service}). ` +
          'Release it from that project, or repeat with force to release it anyway.',
          'PORT_CONFLICT'
        );
        err.owner = existing;
        throw err;
      }
      // A forced cross-project release must never be quiet — the displaced owner
      // keeps running against a port the registry no longer says is theirs.
      log.warn('Forced release of another project\'s port lease', {
        host,
        port,
        displacedProject: existing.project,
        displacedService: existing.service,
        byProject: options.project
      });
    }

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
   *
   * Ownership is verified only when the caller names its project (#656). A heartbeat
   * renews a lease; renewing ANOTHER project's lease keeps a port nobody-you-own
   * alive indefinitely. When `options.project` is given and mismatches the lease
   * owner, it is refused with `PORT_CONFLICT`. Unlike release there is no `force` —
   * there is no legitimate reason to renew another project's lease. Omitting
   * `project` preserves the prior unverified behavior.
   *
   * @param {number} port
   * @param {string} [host='localhost'] - Host identifier
   * @param {object} [options] - Ownership options
   * @param {string|null} [options.project] - Verify the lease belongs to this project
   * @returns {object|null}
   * @throws {StoreError} `PORT_CONFLICT` when `options.project` is given but the lease
   *   is held by a different project
   */
  heartbeat(port, host = 'localhost', options = {}) {
    _ensureDb();
    const existing = portLeasesApi.get(port, host);
    if (!existing) return null;

    if (options.project && existing.project !== options.project) {
      log.warn('Refused port heartbeat — another project holds it', {
        host,
        port,
        owner: existing.project,
        ownerService: existing.service,
        requestedBy: options.project
      });
      const err = new StoreError(
        `Port ${port} on ${host} is leased by "${existing.project}" (${existing.service}).`,
        'PORT_CONFLICT'
      );
      err.owner = existing;
      throw err;
    }

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
      `INSERT INTO eval_scores (id, exchange_id, schema_version, judge_model, scored_at,
        tier_1_structural_score, tier_1_flags,
        tier_2_semantic_score, tier_2_reasoning, tier_2_skipped,
        tier_2_5_alignment_score, tier_2_5_reasoning, tier_2_5_skipped,
        tier_3_behavioral_score, tier_3_dimension_scores, tier_3_skipped,
        anomaly_flag, anomaly_reason, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.exchangeId,
      data.schemaVersion,
      data.judgeModel,
      data.scoredAt,
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
      `INSERT INTO eval_baselines (id, project, computed_at, window_start, window_end, dimension_averages, exchange_count, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.project,
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
   * @returns {object|null}
   */
  getLatest(project) {
    _ensureDb();
    const sql = 'SELECT * FROM eval_baselines WHERE project = ? ORDER BY computed_at DESC LIMIT 1';
    const params = [project];
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
    // CC-6 (#381): 'startup' (launch-injected) | 'wrap' (wrap-prompt-injected).
    // Older rows predating the column read back as 'startup' via the schema default.
    kind: row.kind || 'startup',
    owner: row.owner,
    sourceLearningId: row.source_learning_id ?? null,
    // #569 review state. Rows predating the column read back as 'active' via the
    // schema default — they already governed sessions and were never proposals.
    status: row.status || 'active',
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
    criticGate: row.critic_gate,
    createdAt: row.created_at
  };
}

/**
 * Is this lease still live, i.e. would the expiry sweep leave it alone?
 *
 * Defined as the exact inverse of `expireStale`'s predicate so the two can
 * never disagree about what "expired" means — a lease the sweep is about to
 * delete must not be able to block a new claim on its port.
 *
 * The comparison runs in SQLite deliberately: `expires_at` is written as UTC in
 * SQLite's `YYYY-MM-DD HH:MM:SS` form with no zone suffix, so `new Date()`
 * would parse it as LOCAL time and shift liveness by the machine's UTC offset —
 * silently treating expired leases as live (or the reverse) everywhere outside
 * UTC.
 *
 * @param {object} lease - A lease as returned by `_rowToLease`
 * @returns {boolean} True when the lease still holds its port
 */
function _isLeaseLive(lease) {
  if (lease.permanent) return true;
  if (!lease.expiresAt) return true;
  if (lease.status !== 'active') return true;
  const row = _db.prepare("SELECT (? >= datetime('now')) AS live").get(lease.expiresAt);
  return !!(row && row.live);
}

/**
 * Convert a SQLite port_leases row to an app-level lease object.
 * @param {object} row - Raw SQLite row
 * @returns {object} App-level lease
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
  projectConfig: projectConfigApi,
  projects: projectsApi,
  sessions: sessionsApi,
  learnings: learningsApi,
  sessionRules: sessionRulesApi,
  // Exported so tests can assert "this database migrated all the way to HEAD"
  // instead of copying the number. Thirteen tests held a literal, so every
  // migration silently owed a thirteen-line edit and a red suite until it was
  // paid — and the literal was never the thing any of them meant to pin.
  CURRENT_SCHEMA_VERSION,
  sessionRuleDeliveries: sessionRuleDeliveriesApi,
  medusaDeliveries: medusaDeliveriesApi,
  SESSION_RULE_DELIVERY_CHANNELS,
  SESSION_RULE_DELIVERY_OUTCOMES,
  _setSessionRuleDeliveryRetention,
  SESSION_RULE_KINDS,
  SESSION_RULE_STATUSES,
  SESSION_RULE_VERSION_RETENTION,
  _setSessionRuleVersionRetention,
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
  DEFAULT_CONFIG,
  DEFAULT_PROJECT_CONFIG
};
