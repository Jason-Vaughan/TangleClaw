'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createLogger } = require('./logger');

const log = createLogger('store');

const CURRENT_SCHEMA_VERSION = 2;

const TANGLECLAW_DIR = path.join(process.env.HOME || '', '.tangleclaw');
const CONFIG_FILE = path.join(TANGLECLAW_DIR, 'config.json');
const DB_FILE = path.join(TANGLECLAW_DIR, 'tangleclaw.db');
const ENGINES_DIR = path.join(TANGLECLAW_DIR, 'engines');
const TEMPLATES_DIR = path.join(TANGLECLAW_DIR, 'templates');
const BUNDLED_ENGINES_DIR = path.join(__dirname, '..', 'data', 'engines');
const BUNDLED_TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');
const BUNDLED_GLOBAL_RULES = path.join(__dirname, '..', 'data', 'default-global-rules.md');

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
  peekMode: 'drawer',
  setupComplete: false
};

let _db = null;
let _basePath = TANGLECLAW_DIR;
let _configFile = CONFIG_FILE;
let _dbFile = DB_FILE;
let _enginesDir = ENGINES_DIR;
let _templatesDir = TEMPLATES_DIR;

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

  // Copy bundled engine profiles if engines dir is empty
  _copyBundledFiles(BUNDLED_ENGINES_DIR, _enginesDir, '*.json');

  // Copy bundled methodology templates if templates dir is empty
  _copyBundledTemplates(BUNDLED_TEMPLATES_DIR, _templatesDir);

  // Initialize SQLite
  _db = new DatabaseSync(_dbFile);
  _createTables();
  _runMigrations();

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
  methodology: null,
  methodologyPhase: null,
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
  tags: []
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
      archived      INTEGER NOT NULL DEFAULT 0
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
      duration_seconds INTEGER
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
      port        INTEGER PRIMARY KEY,
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
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_port_leases_project ON port_leases(project);
    CREATE INDEX IF NOT EXISTS idx_port_leases_status ON port_leases(status);
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

    _db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
  }

  log.debug('Schema version', { version: CURRENT_SCHEMA_VERSION });
}

/**
 * Copy bundled JSON files to target directory if target is empty.
 * @param {string} srcDir - Source directory with bundled files
 * @param {string} destDir - Destination directory
 * @param {string} _pattern - Unused, kept for API compatibility
 */
function _copyBundledFiles(srcDir, destDir, _pattern) {
  if (!fs.existsSync(srcDir)) return;

  const existing = new Set(
    fs.existsSync(destDir)
      ? fs.readdirSync(destDir).filter((f) => f.endsWith('.json'))
      : []
  );

  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    if (!existing.has(file)) {
      fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
      log.debug('Copied bundled engine profile', { file });
    }
  }
}

/**
 * Copy bundled methodology templates to target directory if target has no templates.
 * @param {string} srcDir - Source directory with bundled templates
 * @param {string} destDir - Destination directory
 */
function _copyBundledTemplates(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  }

  const existing = new Set(
    fs.readdirSync(destDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  );

  const dirs = fs.readdirSync(srcDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const dir of dirs) {
    if (existing.has(dir.name)) continue;
    const src = path.join(srcDir, dir.name);
    const dest = path.join(destDir, dir.name);
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    const files = fs.readdirSync(src);
    for (const file of files) {
      fs.copyFileSync(path.join(src, file), path.join(dest, file));
    }
    log.debug('Copied bundled methodology template', { id: dir.name });
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

const PROJECT_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

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
      throw new StoreError(`Invalid project name: "${data.name}". Must match [a-zA-Z0-9_-]+`, 'BAD_REQUEST');
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
    if (data.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(data.tags));
    }
    if (data.ports !== undefined) {
      sets.push('ports = ?');
      params.push(JSON.stringify(data.ports));
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
   * @returns {object} - Created session
   */
  start(data) {
    _ensureDb();
    if (!data.projectId || !data.engineId) {
      throw new StoreError('projectId and engineId are required', 'BAD_REQUEST');
    }
    const stmt = _db.prepare(
      `INSERT INTO sessions (project_id, engine_id, tmux_session, prime_prompt, methodology_phase)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(
      data.projectId,
      data.engineId,
      data.tmuxSession || null,
      data.primePrompt || null,
      data.methodologyPhase || null
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

// ── Port Leases ──

const portLeasesApi = {
  /**
   * List all port leases, with optional filtering.
   * @param {object} [options]
   * @param {string} [options.project] - Filter by project name
   * @param {string} [options.status] - Filter by status
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

    let sql = 'SELECT * FROM port_leases';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY port ASC';

    return _db.prepare(sql).all(...params).map(_rowToLease);
  },

  /**
   * Get a single lease by port number.
   * @param {number} port
   * @returns {object|null}
   */
  get(port) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM port_leases WHERE port = ?').get(port);
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
   * Create or update a port lease (upsert by port).
   * @param {object} data
   * @param {number} data.port
   * @param {string} data.project
   * @param {string} data.service
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
      INSERT INTO port_leases (port, project, service, status, permanent, ttl_ms, expires_at, last_heartbeat, description, auto_renew)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
      ON CONFLICT(port) DO UPDATE SET
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
    `).run(data.port, data.project, data.service, status, permanent, ttlMs, expiresAt, description, autoRenew);

    const lease = portLeasesApi.get(data.port);
    activityApi.log({
      eventType: 'port.leased',
      detail: { port: data.port, project: data.project, service: data.service, permanent: !!data.permanent }
    });
    return lease;
  },

  /**
   * Release (delete) a lease by port.
   * @param {number} port
   */
  release(port) {
    _ensureDb();
    const existing = portLeasesApi.get(port);
    _db.prepare('DELETE FROM port_leases WHERE port = ?').run(port);
    if (existing) {
      activityApi.log({
        eventType: 'port.released',
        detail: { port, project: existing.project, service: existing.service }
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
   * Update heartbeat for a port lease, extending expiry if TTL-based.
   * @param {number} port
   * @returns {object|null}
   */
  heartbeat(port) {
    _ensureDb();
    const existing = portLeasesApi.get(port);
    if (!existing) return null;

    if (existing.ttlMs && !existing.permanent) {
      const newExpiry = new Date(Date.now() + existing.ttlMs).toISOString().replace('T', ' ').replace('Z', '');
      _db.prepare(`
        UPDATE port_leases SET last_heartbeat = datetime('now'), expires_at = ?, updated_at = datetime('now')
        WHERE port = ?
      `).run(newExpiry, port);
    } else {
      _db.prepare(`
        UPDATE port_leases SET last_heartbeat = datetime('now'), updated_at = datetime('now')
        WHERE port = ?
      `).run(port);
    }

    return portLeasesApi.get(port);
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
        detail: { port: row.port, project: row.project, service: row.service }
      });
    }

    return stale.length;
  },

  /**
   * Check if a port has a conflict (existing active/permanent lease).
   * @param {number} port
   * @returns {object|null} - Existing lease or null
   */
  checkConflict(port) {
    _ensureDb();
    const row = _db.prepare(
      "SELECT * FROM port_leases WHERE port = ? AND status IN ('active','permanent')"
    ).get(port);
    return row ? _rowToLease(row) : null;
  },

  /**
   * Suggest an alternative free port near the preferred port.
   * @param {number} preferredPort
   * @returns {number}
   */
  suggestAlternative(preferredPort) {
    _ensureDb();
    const existing = portLeasesApi.get(preferredPort);
    if (!existing) return preferredPort;

    // Search upward from preferred port
    const usedPorts = new Set(
      _db.prepare('SELECT port FROM port_leases').all().map((r) => r.port)
    );

    for (let p = preferredPort + 1; p < preferredPort + 100; p++) {
      if (!usedPorts.has(p)) return p;
    }

    return preferredPort + 100;
  }
};

// ── Global Rules ──

/**
 * Get the path to the user's global rules file.
 * @returns {string}
 */
function _globalRulesPath() {
  return path.join(_basePath || TANGLECLAW_DIR, 'global-rules.md');
}

const globalRulesApi = {
  /**
   * Load the user's global rules content.
   * Creates from defaults if missing.
   * @returns {string}
   */
  load() {
    const userFile = _globalRulesPath();
    try {
      if (fs.existsSync(userFile)) {
        return fs.readFileSync(userFile, 'utf8');
      }
    } catch (err) {
      log.warn('Failed to read global rules', { path: userFile, error: err.message });
    }
    // Create from bundled defaults
    try {
      const defaults = fs.readFileSync(BUNDLED_GLOBAL_RULES, 'utf8');
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.writeFileSync(userFile, defaults, 'utf8');
      return defaults;
    } catch (err) {
      log.warn('Failed to create global rules from defaults', { error: err.message });
      return '';
    }
  },

  /**
   * Save updated global rules content.
   * @param {string} content - New global rules markdown
   */
  save(content) {
    const userFile = _globalRulesPath();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, content, 'utf8');
    activityApi.log({ eventType: 'rules.global_updated', detail: { length: content.length } });
  },

  /**
   * Reset global rules to bundled defaults.
   * @returns {string} - The default content
   */
  reset() {
    const defaults = fs.readFileSync(BUNDLED_GLOBAL_RULES, 'utf8');
    const userFile = _globalRulesPath();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, defaults, 'utf8');
    activityApi.log({ eventType: 'rules.global_reset' });
    return defaults;
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
    archived: !!row.archived
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
    durationSeconds: row.duration_seconds
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
 * Convert a SQLite port_leases row to an app-level object.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToLease(row) {
  return {
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

module.exports = {
  init,
  close,
  config: configApi,
  engines: enginesApi,
  templates: templatesApi,
  projectConfig: projectConfigApi,
  projects: projectsApi,
  sessions: sessionsApi,
  learnings: learningsApi,
  portLeases: portLeasesApi,
  globalRules: globalRulesApi,
  activity: activityApi,
  StoreError,
  getDb,
  _setBasePath,
  _getBasePath,
  DEFAULT_CONFIG,
  DEFAULT_PROJECT_CONFIG
};
