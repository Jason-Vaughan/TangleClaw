'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createLogger } = require('./logger');
// Not `password`: every call site here sits beside a parameter of that name, and
// the shadowing would be silent. Named for what it does instead.
const passwordHashing = require('./password');
const authSession = require('./auth-session');
const recoveryCodes = require('./recovery-codes');
const tangleclawHome = require('./tangleclaw-home');
const bridgeSchema = require('./bridge-schema');
// The store is split by area (#2248): the shared handle and its helpers, the
// schema with its migration chain, and each extracted domain live under
// `lib/store/`. This file is the facade. It owns `init()`, `close()` and the
// export object, binds every module to the one database handle, and re-exports
// what moved under the names it always exported, so nothing that requires the
// store changes.
const dbHandle = require('./store/_db');
const { StoreError, _ensureDb, _jsonParse, getDb, _withSavepoint, _startupControlTransaction } = dbHandle;
const schema = require('./store/_schema');
const {
  _createTables,
  _runMigrations,
  CURRENT_SCHEMA_VERSION,
  LAUNCH_ISOLATION_OVERRIDE_SCOPES,
  STARTUP_PROMPT_SEED,
  _startupPromptDigest,
  _startupPolicyDigest,
  STARTUP_FIRE_OUTCOMES,
  STARTUP_FIRE_ACTIVE,
  STARTUP_FIRE_REASON_CODES,
  STARTUP_FIRE_CALLER_KINDS,
  STARTUP_FIRE_CLEARANCES,
  STARTUP_DELIVERIES,
  STARTUP_FIRE_ACTIVE_SQL,
  STARTUP_FIRE_DISPATCH_NOTE_MAX,
  RECOVERY_BATCH_OUTCOMES,
  WORKLOAD_NUDGE_FACT_KINDS,
  WORKLOAD_NUDGE_ROUTES,
  HANDOFF_BASELINES,
  HANDOFF_BASELINE_VALUES,
  EPOCH_UNKNOWN_FROM_V41,
  LEASE_REACHES,
  LEASE_OWNER_KINDS,
  SHARED_DOC_EVENT_SOURCES,
  SHARED_DOC_NOTICE_SETTINGS,
  SHARED_DOC_DELIVERY_OUTCOMES
} = schema;
const activity = require('./store/activity');
const { activityApi, ACTIVITY_LOG_RETENTION, ACTIVITY_PRUNE_EVENT, _setActivityLogRetention } = activity;
const sessions = require('./store/sessions');
const {
  sessionsApi,
  SESSION_STATUS,
  SESSION_STATUSES,
  SESSION_STATUS_TRANSITIONS,
  canTransition,
  _transitionSession,
  LAUNCH_BLOCKER_WARN_CAP
} = sessions;
const sessionRules = require('./store/session-rules');
const {
  sessionRulesApi,
  SESSION_RULE_KINDS,
  SESSION_RULE_STATUSES,
  SESSION_RULE_TRANSITIONS,
  SESSION_RULE_VERSION_RETENTION,
  _setSessionRuleVersionRetention,
  sessionRuleDeliveriesApi,
  SESSION_RULE_DELIVERY_CHANNELS,
  SESSION_RULE_DELIVERY_OUTCOMES,
  RULES_SERVED_BY_LAUNCH_SEQUENCE,
  _setSessionRuleDeliveryRetention
} = sessionRules;
const launch = require('./store/launch');
const {
  launchSequencesApi,
  LAUNCH_STEP_IDS,
  projectRecoveryStateApi,
  recoveryClearancesApi,
  recoveryClearBatchesApi
} = launch;
const handoffs = require('./store/handoffs');
const { handoffsApi, handoffEpochApi, EPOCH_ROW_MISSING } = handoffs;

const log = createLogger('store');

/** The outcomes a fire never leaves. @type {string[]} */
const STARTUP_FIRE_TERMINAL = Object.freeze(['applied', 'blocked', 'failed', 'interrupted', 'unsupported', 'denied']);

/**
 * Which outcome may follow which. A fire is an intent that moves forward
 * through what the engine reports; nothing moves it back, and a terminal
 * outcome is final. `dispatching` may reach a terminal outcome directly,
 * because the read-back that follows a send can find the turn already over.
 * `indeterminate` is left only by a reconcile that read the engine's own
 * record. A same-outcome update (a new reason while `accepted`, for an
 * approval the operator is being asked for) is always allowed.
 * @type {Object<string, string[]>}
 */
const STARTUP_FIRE_TRANSITIONS = Object.freeze({
  pending: ['dispatching', 'blocked', 'failed', 'indeterminate'],
  dispatching: ['accepted', 'applied', 'failed', 'interrupted', 'indeterminate'],
  accepted: ['applied', 'failed', 'interrupted', 'indeterminate'],
  indeterminate: ['accepted', 'applied', 'failed', 'interrupted'],
  applied: [], blocked: [], failed: [], interrupted: [], unsupported: [], denied: []
});

// One derivation for every site that needs it — see lib/tangleclaw-home.js for
// why splitting it between `$HOME` and the passwd entry half-relocated an
// install, and for the `TANGLECLAW_HOME` override this reads.
const TANGLECLAW_DIR = tangleclawHome.baseDir();
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
 * The projects directory every install shipped with before #880. `load()`
 * gives it to a config file that exists but has no `projectsDir` key: that
 * install has been using this directory all along, and merging the new default
 * over it would move the install to an empty `~/Projects` on upgrade, with its
 * projects still on disk and none of them listed. Mirrored by hand in
 * `deploy/install.sh`, which reads the same file before the server starts.
 * @type {string}
 */
const LEGACY_PROJECTS_DIR = '~/Documents/Projects';

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
  // Outside ~/Documents, ~/Desktop and ~/Downloads (#880): the wizard cautions
  // on those by path shape, and a default under one of them drew that caution
  // on every fresh Mac. Mirrored by hand in deploy/install.sh (held to this
  // value by test/install-sh.test.js) and in the browser's fallbacks (held by
  // test/tcc-folders.test.js).
  projectsDir: '~/Projects',
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
  // #227 — the dashboard's "N new commit(s) upstream on origin/main" banner.
  // On by default; the check is a `git fetch` against GitHub at most every 15
  // minutes while a dashboard is open, so an operator on a metered or
  // privacy-conscious connection can turn it off. Only a literal `false`
  // disables it (lib/behind-origin.js#isCheckEnabled).
  behindOriginCheckEnabled: true,
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
  // `authEnabled` means "a TangleClaw session is required" (ADR 0016 OQ3): on,
  // TangleClaw's own login (`lib/auth-gate.js`) enforces on every ingress mode.
  // `basicAuthUser`/`basicAuthHash` are the Caddy copy of the login — a BCRYPT
  // hash, never a plaintext (setup hashes via `caddy hash-password`, and only
  // where Caddy is installed) — which a generated Caddyfile carries while
  // TangleClaw's own login does not guard the door, and which the fallback
  // rebuild puts back. None of the three is settable through PATCH /api/config.
  authEnabled: false,
  basicAuthUser: null,
  basicAuthHash: null,
  // When the operator chose, in first-run setup, to finish with no login (ADR
  // 0009's opt-out): an ISO timestamp, or null. Recorded so the deliberate
  // choice is never confused with a config that was simply never asked —
  // `authEnabled: false` alone says both. Never saved beside `authEnabled: true`
  // (`config.save` clears it); `reset-admin.js --store` also clears it when its
  // account arms a gate that `authEnabled` alone does not show.
  loginOptOutAt: null,
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
  // #846 — absolute path for a per-site `log { output file … }` block in the
  // generated Caddyfile. Adopted automatically at boot/cutover when the live
  // Caddyfile names one; before this existed the generator could not emit a log
  // under any option, so a cutover silently ended the only access logging on
  // the remote-facing site. null = no access log emitted.
  caddyAccessLogPath: null,
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
// Every extracted domain module that needs nothing but the handle, bound by
// `init()` and unbound by `close()`. One line per module: a domain the facade
// forgets to bind fails loudly with NOT_INITIALIZED at its first call that
// guards, never silently with a stale handle (a lenient reader such as the
// activity log's `log()` does nothing instead). A domain that also receives
// what it still calls in the facade is bound by name beside the schema.
const BOUND_MODULES = [activity, sessions, handoffs];
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

/**
 * Absolute path of the config file this store reads and writes.
 *
 * Exported so a caller that needs to `stat` it — `server.js`'s auth-gate config
 * cache keys on its mtime and size — asks the store rather than re-deriving
 * `join(basePath, 'config.json')`. Two copies of a path is how one of them
 * survives a relocation the other does not.
 *
 * @returns {string}
 */
function _getConfigPath() {
  return _configFile;
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
  _tightenDbPermissions();
  // Bind the one handle into every module that keeps a copy of it, before the
  // schema runs: the chain's own `_db` is what `_createTables` writes through.
  dbHandle._bind(_db);
  schema._bind({ db: _db, dbFile: _dbFile, projectConfigApi, SESSION_STATUS });
  // A domain that still calls into the facade, or into a domain that requires
  // it, receives what it calls beside the handle, as the schema does: the
  // launch domain filters on the sessions vocabulary while the sessions
  // domain requires the launch domain for its insert.
  launch._bind({ db: _db, SESSION_STATUS });
  // The session-rules domain checks a new rule's project through the
  // projects api, which leaves with the projects domain.
  sessionRules._bind({ db: _db, projectsApi });
  for (const m of BOUND_MODULES) m._bind(_db);
  _createTables();
  _runMigrations();
  // Every boot, after the migrations: creates the operator bridge's storage on
  // a fresh install, and holds a store that reached this version by any route
  // to the shape the bridge rests on.
  bridgeSchema.createBridgeSchema(_db);
  // Post-migration indexes (columns may not exist until after migration)
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_port_leases_host ON port_leases(host)'); } catch { /* already exists or handled by migration */ }
  _reconcileAccountsEstablished();

  log.info('Store initialized', { db: _dbFile });
}

/**
 * Path of the marker recording that this install has had an account.
 *
 * A file beside the database, not a row in it and not a config key, because
 * what it must survive is losing the database: a corrupt `tangleclaw.db`
 * deleted and recreated empty, or an old copy restored. Once an install's
 * login guards the door, the Caddyfile carries no password of its own, so an
 * account store emptied that way would otherwise offer the first-account page —
 * the install's only key — to any machine that reaches it.
 *
 * @returns {string}
 */
function _accountsEstablishedPath() {
  return path.join(_basePath, 'accounts-established');
}

/**
 * Write the marker if it is not there. Never throws: an account that was just
 * created must not be reported as failed because the marker could not be
 * written, so a failure is logged at error instead.
 */
function _recordAccountsEstablished() {
  try {
    fs.writeFileSync(_accountsEstablishedPath(), `${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') return;
    log.error('Could not record that this install has an account. If its account store is ever lost, '
      + 'the first-account page will accept any caller that reaches it.', { error: err.message });
  }
}

/**
 * At startup: backfill the marker for an install whose accounts predate it,
 * and say so when the marker names accounts the store no longer has.
 */
function _reconcileAccountsEstablished() {
  const hasAccount = !!_db.prepare('SELECT 1 AS present FROM users LIMIT 1').get();
  if (hasAccount) {
    _recordAccountsEstablished();
    return;
  }
  let established;
  try {
    established = usersApi.accountsEstablished();
  } catch (err) {
    log.error('Could not check whether this install has had an account', { error: err.message });
    return;
  }
  if (established) {
    log.warn('The account store has no accounts, but this install has had one. Only this machine can '
      + 'create the first account again: node scripts/reset-admin.js --store --user <name>',
    { marker: _accountsEstablishedPath(), db: _dbFile });
  }
}

/**
 * Close the SQLite database connection.
 */
function close() {
  if (_db) {
    _db.close();
    _db = null;
    dbHandle._bind(null);
    schema._bind(null);
    launch._bind(null);
    sessionRules._bind(null);
    // Unbinding the sessions module (through BOUND_MODULES) also makes it
    // forget the launch-blocker values it warned about: those keys name rows
    // of the database just closed, and another one opened in this process
    // reuses session ids for different rows (`_bind` in lib/store/sessions.js).
    for (const m of BOUND_MODULES) m._bind(null);
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
      // An existing file with no projectsDir predates the #880 default and has
      // been running on the old one. Keep it there; only a missing file (a new
      // install) gets the new default. The next save writes the key out.
      if (!Object.prototype.hasOwnProperty.call(parsed, 'projectsDir')) {
        parsed.projectsDir = LEGACY_PROJECTS_DIR;
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
   *
   * A config whose login is on never carries `loginOptOutAt`: the record says the
   * operator chose no login, and once `authEnabled` is on that is false. Cleared
   * HERE, the one write every config writer goes through, so a path that turns a
   * login on cannot leave the two disagreeing by forgetting to clear it — setup,
   * Add a login, `reset-admin.js --create-gate` and Caddyfile adoption all set
   * `authEnabled`, and a list of call sites is what missed some of them. The
   * caller's object is corrected too, so what it holds matches what was written.
   * @param {object} config - Full config object
   */
  save(config) {
    if (config && config.authEnabled === true && config.loginOptOutAt != null) {
      config.loginOptOutAt = null;
    }
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
const wrapState = require('./wrap-state');
const { DEFAULT_PROJECT_CONFIG } = projectConfig;

const projectConfigApi = {
  /**
   * Load per-project config from <projectPath>/.tangleclaw/project.json.
   * Merges with defaults. Returns defaults if file doesn't exist.
   *
   * Delegates to `lib/project-config.js` so the scanner child and this module
   * share one reader rather than a copy that drifts.
   *
   * A caller's `onError` runs ALONGSIDE this module's warn rather than instead of
   * it. The reader answers with defaults for an unreadable or malformed file, so
   * the return value cannot distinguish "no config" from "config we could not
   * read" — and a caller that ACTS on that difference has no other way to learn
   * it. Dropping the callback silently gave such a caller a guard that could
   * never fire (#797).
   *
   * @param {string} projectPath - Absolute path to project root
   * @param {object} [options] - Reader options.
   * @param {(err: Error, configPath: string) => void} [options.onError] - Called,
   *   after this module logs, when the file exists but cannot be read or parsed.
   * @returns {object}
   */
  load(projectPath, options = {}) {
    return projectConfig.load(projectPath, {
      onError: (err, configPath) => {
        log.warn('Failed to load project config, using defaults', { path: configPath, error: err.message });
        if (typeof options.onError === 'function') options.onError(err, configPath);
      }
    });
  },

  /**
   * Save per-project config to <projectPath>/.tangleclaw/project.json.
   * Creates .tangleclaw/ directory if needed. A legacy `lastWrapSha` is moved to
   * the wrap state file (`lib/wrap-state.js`) rather than written back.
   * @param {string} projectPath - Absolute path to project root
   * @param {object} config - Project config object
   */
  save(projectPath, config) {
    // A config loaded from a project not yet migrated still carries the wrap
    // boundary. It is moved into the untracked state file first, so dropping it
    // from project.json can never lose it; if that move fails, the key stays.
    if (config && Object.prototype.hasOwnProperty.call(config, wrapState.LEGACY_KEY)) {
      try {
        const adopted = wrapState.adoptLegacyLastWrapSha(projectPath, config[wrapState.LEGACY_KEY]);
        if (adopted.safeToDrop) {
          config = { ...config };
          delete config[wrapState.LEGACY_KEY];
        } else {
          log.warn('lastWrapSha stays in project.json for now', { projectPath, reason: adopted.reason });
        }
      } catch (err) {
        log.warn('Could not move lastWrapSha out of project.json; it stays there for now', { projectPath, error: err.message });
      }
    }
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
 * Narrow the database file to owner-only, and report only if that fails.
 *
 * `new DatabaseSync` creates the file at the process umask — 0644 on a default
 * macOS account, i.e. readable by every local account. Survivable while the file
 * held project metadata; not once it holds password hashes (ADR 0015). Salted
 * scrypt and local-only reach are why this is worth fixing quietly rather than
 * refusing to start.
 *
 * The check and the fix live together on purpose: `init` calls
 * `_checkPermissions` before the database is even opened, so a report placed
 * there would fire on a condition this same `init` is about to repair — and a
 * warning the caller repairs teaches the operator to ignore it.
 *
 * Runs on every `init`, not only on create, so an install predating this gets
 * narrowed on its next boot. Best-effort on the chmod — a filesystem that
 * cannot represent the mode (a network mount, a container volume) must not stop
 * the server starting — but then the warning is real and says so.
 * @returns {void}
 */
function _tightenDbPermissions() {
  try {
    if (!fs.existsSync(_dbFile)) return;
    if ((fs.statSync(_dbFile).mode & 0o777) !== 0o600) {
      fs.chmodSync(_dbFile, 0o600);
    }
    const mode = fs.statSync(_dbFile).mode & 0o777;
    if (mode !== 0o600) {
      log.warn('Database file permissions could not be narrowed', {
        path: _dbFile, mode: '0' + mode.toString(8), recommended: '0600'
      });
    }
  } catch (err) {
    log.warn('Could not secure database file permissions', {
      path: _dbFile, error: err.message
    });
  }
}

/**
 * Retention for the startupControl audit tables (#1825 B3, Architect F6).
 *
 * Quotas are defined over ENDED-session history, per TARGET project: the
 * newest `fires` fire rows and the newest `channels` closed channel rows whose
 * session is no longer active are kept, older ones deleted. Every row of an
 * active session is exempt, additively, so the one-active-fire and
 * applied-once guarantees never lose a row they rest on. Partitioned by the
 * row's own `project_id` (the target), never by who fired: a cross-project
 * firer must not distort another project's history.
 * @type {{fires: number, channels: number}}
 */
const STARTUP_CONTROL_RETENTION = { fires: 200, channels: 100 };

/**
 * Override the retention quotas. Test seam only, mirroring
 * `_setSessionRuleDeliveryRetention`.
 * @param {{fires?: number, channels?: number}} quotas - New per-project caps.
 * @returns {void}
 */
function _setStartupControlRetention(quotas) {
  if (quotas && Number.isInteger(quotas.fires) && quotas.fires >= 0) STARTUP_CONTROL_RETENTION.fires = quotas.fires;
  if (quotas && Number.isInteger(quotas.channels) && quotas.channels >= 0) STARTUP_CONTROL_RETENTION.channels = quotas.channels;
}

/**
 * Trim one project's fire history to the quota (the caller holds the transaction).
 * Only rows whose session has ended are candidates, newest kept, id order.
 * @param {number} projectId - The target project.
 * @returns {number} Rows deleted.
 */
function _trimStartupFires(projectId) {
  return _db.prepare(
    `DELETE FROM startup_prompt_fires WHERE id IN (
       SELECT f.id FROM startup_prompt_fires f
         JOIN sessions s ON s.id = f.session_id
        WHERE f.project_id = ? AND s.status != ?
        ORDER BY f.id DESC LIMIT -1 OFFSET ?)`
  ).run(projectId, SESSION_STATUS.ACTIVE, STARTUP_CONTROL_RETENTION.fires).changes;
}

/**
 * Trim one project's closed-channel history to the quota (the caller holds the
 * transaction). Channels carry no project column, so the target project is the
 * session's; only closed rows of ended sessions are candidates, newest kept.
 * @param {number} projectId - The target project.
 * @returns {number} Rows deleted.
 */
function _trimStartupChannels(projectId) {
  return _db.prepare(
    `DELETE FROM startup_control_channels WHERE id IN (
       SELECT c.id FROM startup_control_channels c
         JOIN sessions s ON s.id = c.session_id
        WHERE s.project_id = ? AND s.status != ? AND c.state = 'closed'
        ORDER BY c.id DESC LIMIT -1 OFFSET ?)`
  ).run(projectId, SESSION_STATUS.ACTIVE, STARTUP_CONTROL_RETENTION.channels).changes;
}

const startupPromptsApi = {
  /**
   * Run `fn` inside one `BEGIN IMMEDIATE` transaction; see {@link _startupControlTransaction}.
   * @param {() => *} fn - Synchronous work.
   * @returns {*} Whatever `fn` returns.
   */
  transaction: _startupControlTransaction,

  /**
   * The current (highest) revision.
   * @returns {object}
   */
  current() {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM startup_prompt_revisions ORDER BY revision DESC LIMIT 1').get();
    return _startupPromptRow(row);
  },

  /**
   * One revision by number, or null.
   * @param {number} revision - Revision number.
   * @returns {object|null}
   */
  get(revision) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM startup_prompt_revisions WHERE revision = ?').get(revision);
    return row ? _startupPromptRow(row) : null;
  },

  /**
   * Write a new revision, only if `expectedRevision` is still current. The
   * firer ids are stored sorted and unique, with their canonical digest.
   * @param {{text: string, firerProjectIds: number[], expectedRevision: number, byKind: string, byName: (string|null)}} input
   * @returns {{ok: true, prompt: object} | {ok: false, currentRevision: number}}
   */
  update({ text, firerProjectIds, expectedRevision, byKind, byName }) {
    const ids = [...new Set(firerProjectIds || [])].sort((a, b) => a - b);
    return this.transaction(() => {
      const { revision } = _db.prepare('SELECT MAX(revision) AS revision FROM startup_prompt_revisions').get();
      if (revision !== expectedRevision) return { ok: false, currentRevision: revision };
      _db.prepare(
        'INSERT INTO startup_prompt_revisions '
        + '(revision, text, text_digest, firer_project_ids, policy_digest, created_by_kind, created_by) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(revision + 1, text, _startupPromptDigest(text), JSON.stringify(ids), _startupPolicyDigest(ids),
        byKind, byName || null);
      return { ok: true, prompt: this.current() };
    });
  },

  /**
   * Insert a fire row. Callers check idempotency, the active slot and the
   * applied key first, inside {@link startupPromptsApi.transaction}; the
   * UNIQUE constraints are the backstop, and a violation throws.
   * @param {object} fire - Fields in camelCase, matching the table.
   * @returns {object} The stored row.
   */
  insertFire(fire) {
    _ensureDb();
    const reason = typeof fire.reason === 'string' ? fire.reason.slice(0, 500) : null;
    const info = _db.prepare(
      'INSERT INTO startup_prompt_fires (idempotency_key, project_id, session_id, sequence_id, prompt_revision, '
      + 'prompt_text_digest, policy_digest, caller_kind, caller_clearance, caller_project_id, outcome, reason_code, reason, '
      + 'payload, payload_digest, engine_thread_id) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(fire.idempotencyKey, fire.projectId, fire.sessionId, fire.sequenceId, fire.promptRevision,
      fire.promptTextDigest, fire.policyDigest, fire.callerKind, fire.callerClearance,
      fire.callerProjectId === undefined ? null : fire.callerProjectId, fire.outcome, fire.reasonCode || null, reason,
      fire.payload === undefined || fire.payload === null ? null : JSON.stringify(fire.payload),
      fire.payloadDigest || null, fire.engineThreadId || null);
    // Written and trimmed together: the caller's transaction (the fire service
    // always holds one) makes the new row and the retention one change.
    _withSavepoint(() => _trimStartupFires(fire.projectId));
    return this.getFireById(Number(info.lastInsertRowid));
  },

  /**
   * Move a fire to its next outcome, or refresh the reason of its current
   * one, as the engine reports. The transition map is enforced here so no
   * caller can move a fire backwards or out of a terminal outcome, whatever
   * order the engine's notifications and a read-back arrive in.
   *
   * @param {number} id - Fire row id.
   * @param {object} patch - `outcome` (required), and optionally `reasonCode`,
   *   `reason`, `engineThreadId`, `engineTurnId`, `dispatchNote`. A dispatch
   *   note is written once and kept: a later transition that carries none
   *   leaves it as it was, unlike `reason`. Timestamps are stamped from
   *   the outcome: `dispatching` sets `dispatched_at`, `accepted` sets
   *   `accepted_at`, a terminal outcome sets `settled_at`.
   * @returns {{ok: true, fire: object} | {ok: false, reason: string, fire: (object|null)}}
   */
  updateFire(id, patch) {
    _ensureDb();
    return this.transaction(() => {
      const current = this.getFireById(id);
      if (!current) return { ok: false, reason: `no fire ${id}`, fire: null };
      const next = patch.outcome;
      if (!STARTUP_FIRE_OUTCOMES.includes(next)) return { ok: false, reason: `unknown outcome ${next}`, fire: current };
      const allowed = STARTUP_FIRE_TRANSITIONS[current.outcome] || [];
      const sameNonTerminal = next === current.outcome && !STARTUP_FIRE_TERMINAL.includes(next);
      if (!allowed.includes(next) && !sameNonTerminal) {
        return { ok: false, reason: `a ${current.outcome} fire cannot become ${next}`, fire: current };
      }
      const reason = typeof patch.reason === 'string' ? patch.reason.slice(0, 500) : null;
      const reasonCode = patch.reasonCode === undefined ? null : patch.reasonCode;
      const dispatchNote = typeof patch.dispatchNote === 'string' && patch.dispatchNote
        ? patch.dispatchNote.slice(0, STARTUP_FIRE_DISPATCH_NOTE_MAX) : null;
      const terminal = STARTUP_FIRE_TERMINAL.includes(next);
      _db.prepare(
        `UPDATE startup_prompt_fires
            SET outcome = ?, reason_code = ?, reason = ?,
                engine_thread_id = COALESCE(?, engine_thread_id),
                engine_turn_id = COALESCE(?, engine_turn_id),
                dispatch_note = COALESCE(dispatch_note, ?),
                dispatched_at = CASE WHEN ? = 'dispatching' THEN COALESCE(dispatched_at, datetime('now')) ELSE dispatched_at END,
                accepted_at = CASE WHEN ? = 'accepted' THEN COALESCE(accepted_at, datetime('now')) ELSE accepted_at END,
                settled_at = CASE WHEN ? THEN COALESCE(settled_at, datetime('now')) ELSE settled_at END,
                updated_at = datetime('now')
          WHERE id = ?`
      ).run(next, reasonCode, reason, patch.engineThreadId || null, patch.engineTurnId || null, dispatchNote,
        next, next, terminal ? 1 : 0, id);
      return { ok: true, fire: this.getFireById(id) };
    });
  },

  /**
   * One fire by row id, or null.
   * @param {number} id - Row id.
   * @returns {object|null}
   */
  getFireById(id) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM startup_prompt_fires WHERE id = ?').get(id);
    return row ? _startupPromptFireRow(row) : null;
  },

  /**
   * The fire recorded under an idempotency key, or null.
   * @param {string} key - Idempotency key.
   * @returns {object|null}
   */
  getFireByKey(key) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM startup_prompt_fires WHERE idempotency_key = ?').get(key);
    return row ? _startupPromptFireRow(row) : null;
  },

  /**
   * The launch's active fire (pending, dispatching, indeterminate or accepted), or null.
   * @param {number} sequenceId - launch_sequences row id.
   * @returns {object|null}
   */
  activeFire(sequenceId) {
    _ensureDb();
    const row = _db.prepare(
      `SELECT * FROM startup_prompt_fires WHERE sequence_id = ? AND outcome IN (${STARTUP_FIRE_ACTIVE_SQL})`
    ).get(sequenceId);
    return row ? _startupPromptFireRow(row) : null;
  },

  /**
   * The fire that applied `promptRevision` to this launch, or null.
   * @param {number} sequenceId - launch_sequences row id.
   * @param {number} promptRevision - Prompt revision.
   * @returns {object|null}
   */
  appliedFire(sequenceId, promptRevision) {
    _ensureDb();
    const row = _db.prepare(
      "SELECT * FROM startup_prompt_fires WHERE sequence_id = ? AND prompt_revision = ? AND outcome = 'applied'"
    ).get(sequenceId, promptRevision);
    return row ? _startupPromptFireRow(row) : null;
  },

  /**
   * Every fire still in flight (pending, dispatching, indeterminate or
   * accepted), oldest first: what a restarted TangleClaw must recover.
   * @returns {object[]}
   */
  listActiveFires() {
    _ensureDb();
    return _db.prepare(`SELECT * FROM startup_prompt_fires WHERE outcome IN (${STARTUP_FIRE_ACTIVE_SQL}) ORDER BY id`)
      .all().map(_startupPromptFireRow);
  },

  /**
   * Fires recorded against one session, newest first.
   * @param {number} sessionId - Session id.
   * @returns {object[]}
   */
  firesForSession(sessionId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM startup_prompt_fires WHERE session_id = ? ORDER BY id DESC')
      .all(sessionId).map(_startupPromptFireRow);
  }
};

/**
 * Shape a startup_prompt_revisions row.
 * @param {object} row - Raw row.
 * @returns {object}
 */
function _startupPromptRow(row) {
  // Fail closed: an unreadable list authorizes no agent, rather than throwing
  // on every read of the prompt.
  let firerProjectIds = [];
  try {
    const parsed = JSON.parse(row.firer_project_ids);
    if (Array.isArray(parsed) && parsed.every(Number.isInteger)) firerProjectIds = parsed;
    else log.warn('startup_prompt_revisions.firer_project_ids is not an integer list', { revision: row.revision });
  } catch {
    log.warn('startup_prompt_revisions.firer_project_ids is not valid JSON', { revision: row.revision });
  }
  return {
    revision: row.revision,
    text: row.text,
    textDigest: row.text_digest,
    firerProjectIds,
    policyDigest: row.policy_digest,
    createdByKind: row.created_by_kind,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

/**
 * Shape a startup_prompt_fires row.
 * @param {object} row - Raw row.
 * @returns {object}
 */
function _startupPromptFireRow(row) {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    projectId: row.project_id,
    sessionId: row.session_id,
    sequenceId: row.sequence_id,
    promptRevision: row.prompt_revision,
    promptTextDigest: row.prompt_text_digest,
    policyDigest: row.policy_digest,
    callerKind: row.caller_kind,
    callerClearance: row.caller_clearance,
    callerProjectId: row.caller_project_id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    reason: row.reason,
    payload: _jsonParse(row.payload, null),
    payloadDigest: row.payload_digest || null,
    engineThreadId: row.engine_thread_id || null,
    engineTurnId: row.engine_turn_id || null,
    dispatchNote: row.dispatch_note || null,
    dispatchedAt: row.dispatched_at || null,
    acceptedAt: row.accepted_at || null,
    settledAt: row.settled_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * @param {object} row - A `coordinator_rotations` row.
 * @returns {object} The camel-cased rotation, JSON columns parsed.
 */
function _coordinatorRotationRow(row) {
  const parse = (text) => (text == null ? null : JSON.parse(text));
  return {
    rotationId: row.rotation_id,
    attemptKey: row.attempt_key,
    projectId: row.project_id,
    sessionId: row.session_id,
    launchId: row.launch_id,
    engineId: row.engine_id,
    channelId: row.channel_id,
    sequenceId: row.sequence_id,
    state: row.state,
    mode: row.mode,
    generation: row.generation,
    priorThreadId: row.prior_thread_id,
    priorThreads: parse(row.prior_threads_json),
    clearAttempts: row.clear_attempts,
    lastClearAttemptAt: row.last_clear_attempt_at,
    replacementThreadId: row.replacement_thread_id,
    reentryDigest: row.reentry_digest,
    resumeNonceHash: row.resume_nonce_hash,
    checkpointSchema: row.checkpoint_schema,
    checkpointDigest: row.checkpoint_digest,
    checkpoint: parse(row.checkpoint_json),
    inboxIds: parse(row.inbox_ids_json),
    roleId: row.role_id,
    authorityVersion: row.authority_version,
    checkout: parse(row.checkout_json),
    github: parse(row.github_json),
    reconcilingAt: row.reconciling_at,
    drift: parse(row.drift_json),
    readiness: parse(row.readiness_json),
    receipt: parse(row.receipt_json),
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

/** Rotation columns a transition may write, camelCase → column. */
const COORDINATOR_ROTATION_PATCHABLE = {
  state: 'state',
  sessionId: 'session_id',
  launchId: 'launch_id',
  channelId: 'channel_id',
  sequenceId: 'sequence_id',
  priorThreads: 'prior_threads_json',
  clearAttempts: 'clear_attempts',
  lastClearAttemptAt: 'last_clear_attempt_at',
  replacementThreadId: 'replacement_thread_id',
  reentryDigest: 'reentry_digest',
  resumeNonceHash: 'resume_nonce_hash',
  receipt: 'receipt_json',
  failureCode: 'failure_code',
  failureDetail: 'failure_detail',
  completedAt: 'completed_at',
  drift: 'drift_json',
  checkout: 'checkout_json',
  readiness: 'readiness_json',
  reconcilingAt: 'reconciling_at'
};

/** JSON-valued patchable fields, stored as text. */
const COORDINATOR_ROTATION_JSON = new Set(['priorThreads', 'receipt', 'drift', 'readiness', 'checkout']);

/**
 * Coordinator context rotations (#2032). The module that owns the transition
 * rules is `lib/coordinator-rotation.js`; this API only stores rows and makes
 * every transition a compare-and-set, so two retries of one step cannot both
 * move it.
 */
const coordinatorRotationsApi = {
  /**
   * Insert a new rotation. Throws on the attempt-key uniqueness or on the
   * one-open-rotation-per-project index.
   * @param {object} r - `rotationId, attemptKey, projectId, sessionId, launchId, engineId, channelId,
   *   sequenceId, generation, priorThreadId, checkpointSchema, checkpointDigest, checkpoint, inboxIds,
   *   roleId, authorityVersion, checkout, github, mode, now`.
   * @returns {object} The stored rotation.
   */
  insert(r) {
    _ensureDb();
    _db.prepare(
      'INSERT INTO coordinator_rotations (rotation_id, attempt_key, project_id, session_id, launch_id, engine_id, channel_id, '
      + 'sequence_id, state, mode, generation, prior_thread_id, checkpoint_schema, checkpoint_digest, checkpoint_json, inbox_ids_json, '
      + "role_id, authority_version, checkout_json, github_json, created_at, updated_at) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fenced', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(r.rotationId, r.attemptKey, r.projectId, r.sessionId, r.launchId, r.engineId, r.channelId, r.sequenceId,
      r.mode || 'clear', r.generation, r.priorThreadId, r.checkpointSchema, r.checkpointDigest, JSON.stringify(r.checkpoint),
      JSON.stringify(r.inboxIds), r.roleId, r.authorityVersion, JSON.stringify(r.checkout), JSON.stringify(r.github || []), r.now, r.now);
    return this.get(r.rotationId);
  },

  /**
   * One rotation by id, or null.
   * @param {string} rotationId - Rotation id.
   * @returns {object|null}
   */
  get(rotationId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM coordinator_rotations WHERE rotation_id = ?').get(rotationId);
    return row ? _coordinatorRotationRow(row) : null;
  },

  /**
   * The rotation an attempt key names, or null.
   * @param {string} attemptKey - The caller's idempotency key.
   * @returns {object|null}
   */
  getByAttemptKey(attemptKey) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM coordinator_rotations WHERE attempt_key = ?').get(attemptKey);
    return row ? _coordinatorRotationRow(row) : null;
  },

  /**
   * The project's rotation still in progress (fenced, rebinding or
   * reconciling), or null. At most one exists.
   * @param {number} projectId - Project id.
   * @returns {object|null}
   */
  getOpenForProject(projectId) {
    _ensureDb();
    const row = _db.prepare(
      "SELECT * FROM coordinator_rotations WHERE project_id = ? AND state IN ('fenced','rebinding','reconciling')"
    ).get(projectId);
    return row ? _coordinatorRotationRow(row) : null;
  },

  /**
   * The most recent rotations of every project, newest first, for the
   * operator's read surface.
   * @param {number} [limit=50] - How many.
   * @returns {object[]}
   */
  listRecent(limit = 50) {
    _ensureDb();
    return _db.prepare('SELECT * FROM coordinator_rotations ORDER BY updated_at DESC, rotation_id LIMIT ?').all(limit)
      .map(_coordinatorRotationRow);
  },

  /**
   * Every rotation still in progress, oldest first.
   * @returns {object[]}
   */
  listOpen() {
    _ensureDb();
    return _db.prepare(
      "SELECT * FROM coordinator_rotations WHERE state IN ('fenced','rebinding','reconciling') ORDER BY created_at, rotation_id"
    ).all().map(_coordinatorRotationRow);
  },

  /**
   * The project's rotation with the highest generation, whatever its state,
   * or null. It decides the project's coordinator epoch: an open or active
   * one binds, an abandoned one means the operator released the binding.
   * @param {number} projectId - Project id.
   * @returns {object|null}
   */
  latestForProject(projectId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM coordinator_rotations WHERE project_id = ? ORDER BY generation DESC LIMIT 1').get(projectId);
    return row ? _coordinatorRotationRow(row) : null;
  },

  /**
   * The highest generation any rotation of the project reached `active` with,
   * or 0 when none has.
   * @param {number} projectId - Project id.
   * @returns {number}
   */
  currentGeneration(projectId) {
    _ensureDb();
    const row = _db.prepare(
      "SELECT MAX(generation) AS g FROM coordinator_rotations WHERE project_id = ? AND state = 'active'"
    ).get(projectId);
    return row && row.g ? row.g : 0;
  },

  /**
   * The highest generation any rotation of the project was ever assigned,
   * whatever became of it, or 0. A new rotation takes the next one, so an
   * abandoned generation is never reused.
   * @param {number} projectId - Project id.
   * @returns {number}
   */
  maxGeneration(projectId) {
    _ensureDb();
    const row = _db.prepare('SELECT MAX(generation) AS g FROM coordinator_rotations WHERE project_id = ?').get(projectId);
    return row && row.g ? row.g : 0;
  },

  /**
   * Apply `patch` only if the rotation is still in `expectedState` and
   * `test` (when given) still holds, read and written in one `BEGIN
   * IMMEDIATE` transaction.
   * @param {string} rotationId - Rotation id.
   * @param {string} expectedState - The state the caller read.
   * @param {object} patch - Fields from {@link COORDINATOR_ROTATION_PATCHABLE}.
   * @param {object} [opts]
   * @param {(r: object) => boolean} [opts.test] - Extra precondition on the current row.
   * @param {string} opts.now - ISO time for `updated_at`.
   * @returns {{written: boolean, rotation: (object|null)}}
   */
  updateIf(rotationId, expectedState, patch, opts) {
    _ensureDb();
    return _startupControlTransaction(() => {
      const current = this.get(rotationId);
      if (!current || current.state !== expectedState || (opts.test && !opts.test(current))) {
        return { written: false, rotation: current };
      }
      const sets = [];
      const values = [];
      for (const [key, value] of Object.entries(patch)) {
        const column = COORDINATOR_ROTATION_PATCHABLE[key];
        if (!column) throw new Error(`coordinator_rotations: ${key} is not patchable`);
        sets.push(`${column} = ?`);
        values.push(COORDINATOR_ROTATION_JSON.has(key) && value != null ? JSON.stringify(value) : value);
      }
      sets.push('updated_at = ?');
      values.push(opts.now);
      _db.prepare(`UPDATE coordinator_rotations SET ${sets.join(', ')} WHERE rotation_id = ?`).run(...values, rotationId);
      return { written: true, rotation: this.get(rotationId) };
    });
  },

  /**
   * Run `fn` inside one `BEGIN IMMEDIATE` transaction.
   * @param {() => *} fn - Synchronous work.
   * @returns {*}
   */
  transaction: _startupControlTransaction
};

/**
 * @param {object} row - A `coordinator_roles` row.
 * @returns {object}
 */
function _coordinatorRoleRow(row) {
  return {
    roleId: row.role_id,
    projectId: row.project_id,
    role: row.role,
    status: row.status,
    authorityVersion: row.authority_version,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at
  };
}

/**
 * The operator's coordinator-role contracts (#2032, ruling A6a). Written only
 * by operator routes; read by the rotation's prepare and resume.
 */
const coordinatorRolesApi = {
  /**
   * Grant a project a coordinator role, replacing its active one if any. The
   * replacement revokes the old row and carries the next authority version, in
   * one transaction.
   * @param {{roleId: string, projectId: number, role: string, note: (string|null), now: string}} r - The grant.
   * @returns {object} The new active role.
   */
  grant(r) {
    _ensureDb();
    return _startupControlTransaction(() => {
      const prior = this.getActiveForProject(r.projectId);
      const last = _db.prepare('SELECT MAX(authority_version) AS v FROM coordinator_roles WHERE project_id = ?').get(r.projectId);
      if (prior) {
        _db.prepare("UPDATE coordinator_roles SET status = 'revoked', revoked_at = ? WHERE role_id = ?").run(r.now, prior.roleId);
      }
      _db.prepare(
        'INSERT INTO coordinator_roles (role_id, project_id, role, status, authority_version, note, created_by, created_at) '
        + "VALUES (?, ?, ?, 'active', ?, ?, 'operator', ?)"
      ).run(r.roleId, r.projectId, r.role, ((last && last.v) || 0) + 1, r.note || null, r.now);
      return this.get(r.roleId);
    });
  },

  /**
   * Revoke a project's active role.
   * @param {number} projectId - Project id.
   * @param {string} now - ISO time.
   * @returns {object|null} The revoked role, or null when none was active.
   */
  revoke(projectId, now) {
    _ensureDb();
    return _startupControlTransaction(() => {
      const prior = this.getActiveForProject(projectId);
      if (!prior) return null;
      _db.prepare("UPDATE coordinator_roles SET status = 'revoked', revoked_at = ? WHERE role_id = ?").run(now, prior.roleId);
      return this.get(prior.roleId);
    });
  },

  /**
   * One role by id, or null.
   * @param {string} roleId - Role id.
   * @returns {object|null}
   */
  get(roleId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM coordinator_roles WHERE role_id = ?').get(roleId);
    return row ? _coordinatorRoleRow(row) : null;
  },

  /**
   * The project's active role, or null.
   * @param {number} projectId - Project id.
   * @returns {object|null}
   */
  getActiveForProject(projectId) {
    _ensureDb();
    const row = _db.prepare("SELECT * FROM coordinator_roles WHERE project_id = ? AND status = 'active'").get(projectId);
    return row ? _coordinatorRoleRow(row) : null;
  },

  /**
   * Every role, newest first.
   * @returns {object[]}
   */
  list() {
    _ensureDb();
    return _db.prepare('SELECT * FROM coordinator_roles ORDER BY created_at DESC, role_id').all().map(_coordinatorRoleRow);
  }
};

/**
 * The native channels TangleClaw opened for launches. The adapter
 * that started a channel is the only writer of its `adapterState`; the
 * generic header is what the launch path, the fire path and any UI read.
 */
const startupControlChannelsApi = {
  /**
   * Record a channel that has just been started for a session. Refused (throws
   * on the unique index) when the session already has an open one.
   * @param {object} channel - `sessionId, sequenceId, engineId, adapter, adapterState`.
   * @returns {object} The stored row.
   */
  open(channel) {
    _ensureDb();
    const info = _db.prepare(
      'INSERT INTO startup_control_channels (session_id, sequence_id, engine_id, adapter, adapter_state) VALUES (?, ?, ?, ?, ?)'
    ).run(channel.sessionId, channel.sequenceId, channel.engineId, channel.adapter, JSON.stringify(channel.adapterState || {}));
    return this.get(Number(info.lastInsertRowid));
  },

  /**
   * One channel by id, or null.
   * @param {number} id - Row id.
   * @returns {object|null}
   */
  get(id) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM startup_control_channels WHERE id = ?').get(id);
    return row ? _startupControlChannelRow(row) : null;
  },

  /**
   * The open channel of a session, or null.
   * @param {number} sessionId - Session id.
   * @returns {object|null}
   */
  getOpenBySession(sessionId) {
    _ensureDb();
    const row = _db.prepare("SELECT * FROM startup_control_channels WHERE session_id = ? AND state = 'open'").get(sessionId);
    return row ? _startupControlChannelRow(row) : null;
  },

  /**
   * Every open channel, oldest first.
   * @returns {object[]}
   */
  listOpen() {
    _ensureDb();
    return _db.prepare("SELECT * FROM startup_control_channels WHERE state = 'open' ORDER BY id").all()
      .map(_startupControlChannelRow);
  },

  /**
   * Merge fields into a channel's adapter-owned state.
   * @param {number} id - Row id.
   * @param {object} patch - Fields to merge.
   * @returns {object|null} The updated row.
   */
  setAdapterState(id, patch) {
    _ensureDb();
    return this.transaction(() => {
      const current = this.get(id);
      if (!current) return null;
      _db.prepare('UPDATE startup_control_channels SET adapter_state = ? WHERE id = ?')
        .run(JSON.stringify({ ...current.adapterState, ...patch }), id);
      return this.get(id);
    });
  },

  /**
   * Merge `patch` into a channel's adapter state only if `test` still holds
   * for the row as it stands, both read and written in one `BEGIN IMMEDIATE`
   * transaction. A compare-and-set for a writer racing another over the same
   * field — the adapter decides what "still holds" means; the store only
   * guarantees nothing changed between the test and the write.
   * @param {number} id - Channel id.
   * @param {(channel: object) => boolean} test - Judged against the current row.
   * @param {object} patch - Keys to merge.
   * @returns {{written: boolean, channel: (object|null)}} The row after the attempt.
   */
  updateAdapterStateIf(id, test, patch) {
    _ensureDb();
    return this.transaction(() => {
      const current = this.get(id);
      if (!current || !test(current)) return { written: false, channel: current };
      _db.prepare('UPDATE startup_control_channels SET adapter_state = ? WHERE id = ?')
        .run(JSON.stringify({ ...current.adapterState, ...patch }), id);
      return { written: true, channel: this.get(id) };
    });
  },

  /**
   * Run `fn` inside one `BEGIN IMMEDIATE` transaction; see {@link _startupControlTransaction}.
   * @param {() => *} fn - Synchronous work.
   * @returns {*}
   */
  transaction: _startupControlTransaction,

  /**
   * The newest channel row of a session, open or closed, or null. A closed
   * row can be the record of why a launch got no channel.
   * @param {number} sessionId - Session id.
   * @returns {object|null}
   */
  getLatestBySession(sessionId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM startup_control_channels WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId);
    return row ? _startupControlChannelRow(row) : null;
  },

  /**
   * Record that a launch got NO channel, and why, as a closed row with no
   * adapter state, so the reason outlives the log line and a later fire can
   * cite it.
   * @param {object} channel - `sessionId, sequenceId, engineId, adapter, reason`.
   * @returns {object} The stored row.
   */
  recordUnavailable(channel) {
    _ensureDb();
    const info = _db.prepare(
      "INSERT INTO startup_control_channels (session_id, sequence_id, engine_id, adapter, state, adapter_state, closed_at, close_reason, teardown) "
      + "VALUES (?, ?, ?, ?, 'closed', '{}', datetime('now'), ?, 'skipped')"
    ).run(channel.sessionId, channel.sequenceId, channel.engineId, channel.adapter, String(channel.reason || 'no channel').slice(0, 200));
    this._trimForSession(channel.sessionId);
    return this.get(Number(info.lastInsertRowid));
  },

  /**
   * Trim the closed-channel history of the project that owns `sessionId`
   * (#1825 B3, F6). A session row that cannot be found trims nothing: with no
   * project to partition by there is no quota to apply.
   * @param {number} sessionId - Any session of the target project.
   * @returns {number} Rows deleted.
   */
  _trimForSession(sessionId) {
    const session = _db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return 0;
    return _withSavepoint(() => _trimStartupChannels(session.project_id));
  },

  /**
   * Close a channel with the reason it ended and how its teardown went.
   * Idempotent: the first close's reason stands.
   * @param {number} id - Row id.
   * @param {string} reason - Why (bounded to 200 characters).
   * @param {string} [teardown] - 'ok', 'skipped', or the error text.
   * @returns {object|null} The updated row.
   */
  close(id, reason, teardown) {
    _ensureDb();
    _db.prepare(
      "UPDATE startup_control_channels SET state = 'closed', closed_at = COALESCE(closed_at, datetime('now')), "
      + "close_reason = COALESCE(close_reason, ?), teardown = COALESCE(teardown, ?) WHERE id = ? AND state = 'open'"
    ).run(typeof reason === 'string' ? reason.slice(0, 200) : null, typeof teardown === 'string' ? teardown.slice(0, 200) : null, id);
    const closed = this.get(id);
    if (closed) this._trimForSession(closed.sessionId);
    return closed;
  }
};

/**
 * Shape a startup_control_channels row.
 * @param {object} row - Raw row.
 * @returns {object}
 */
function _startupControlChannelRow(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequenceId: row.sequence_id,
    engineId: row.engine_id,
    adapter: row.adapter,
    state: row.state,
    adapterState: _jsonParse(row.adapter_state, {}) || {},
    openedAt: row.opened_at,
    closedAt: row.closed_at || null,
    closeReason: row.close_reason || null,
    teardown: row.teardown || null
  };
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
      // The project row and its handoff epoch are written together. A project
      // that exists without a boundary would be read by the launch preflight as
      // one whose epoch was lost — and the answer to a lost epoch is never to
      // derive one later, so the only safe moment to record it is before the
      // project can have any history at all.
      _db.exec('BEGIN IMMEDIATE');
      let project;
      try {
        const stmt = _db.prepare(
          `INSERT INTO projects (name, path, engine_id, tags, ports)
           VALUES (?, ?, ?, ?, ?)`
        );
        stmt.run(data.name, data.path, engineId, tags, ports);
        project = projectsApi.getByName(data.name);
        handoffEpochApi.ensureEmpty(project.id);
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }

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
    // Its launch-isolation override goes with it: ids are never reused, so
    // the row could never apply again, and would sit in the operator's list
    // naming a project that is gone.
    _db.prepare("DELETE FROM launch_isolation_overrides WHERE scope = 'project' AND project_id = ?").run(id);
    _db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
};

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
    // `id DESC` is the tiebreak, not decoration. `created_at` is
    // `datetime('now')` — one-second resolution — so two learnings written in
    // the same second tie, and SQLite is then free to return them in any order.
    // It does: the pushed prime's Active Learnings section rendered in one order
    // on one machine and the other order on another, which failed the
    // byte-identity fixture on CI while passing locally. `id DESC` agrees with
    // `created_at DESC` (both mean newest first) and is unique, so the order is
    // total.
    sql += ' ORDER BY created_at DESC, id DESC';
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
      "SELECT * FROM learnings WHERE project_id = ? AND tier = 'active' ORDER BY created_at DESC, id DESC"
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

// ── Awareness Receipts ──

/**
 * Map an `awareness_receipts` row to its API shape.
 * @param {object} row - Raw SQLite row.
 * @returns {object} The receipt record.
 */
function _rowToAwarenessReceipt(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    verb: row.verb,
    source: row.source,
    role: row.role,
    createdAt: row.created_at
  };
}

/** @type {string[]} Where an awareness receipt can come from. */
const AWARENESS_RECEIPT_SOURCES = ['tc-cli', 'http'];

/** @type {number} Rows retained per project before the oldest are pruned.
 * Same lifecycle decision as SESSION_RULE_DELIVERY_RETENTION and for the same
 * reason: the ledger's questions are about RECENT state ("did this session
 * become aware", "is the floor being discovered"), deep history has no
 * consumer, and Chunk 03's verb roster multiplies the write rate. Recorded
 * here rather than left as an accidental keep-forever. */
let AWARENESS_RECEIPT_RETENTION = 200;

/**
 * Override the receipt-retention cap. Test seam only, mirroring
 * `_setSessionRuleDeliveryRetention`.
 * @param {number} n - New per-project retention cap
 * @returns {void}
 */
function _setAwarenessReceiptRetention(n) {
  AWARENESS_RECEIPT_RETENTION = n;
}

/**
 * Trim one retention bucket of receipts to the cap, oldest first. The
 * unresolved-project rows (`project_id IS NULL`) are their own bucket with the
 * same cap: they are recorded by design (an invocation with a wrong id still
 * proves discovery), so without pruning they would be the one bucket that
 * grows forever.
 * @param {number|null} projectId - Project bucket, or null for the unresolved bucket
 * @returns {void}
 */
function _pruneAwarenessReceipts(projectId) {
  if (projectId === null) {
    _db.prepare(
      `DELETE FROM awareness_receipts
        WHERE project_id IS NULL AND id NOT IN (
          SELECT id FROM awareness_receipts
           WHERE project_id IS NULL ORDER BY id DESC LIMIT ?)`
    ).run(AWARENESS_RECEIPT_RETENTION);
    return;
  }
  _db.prepare(
    `DELETE FROM awareness_receipts
      WHERE project_id = ? AND id NOT IN (
        SELECT id FROM awareness_receipts
         WHERE project_id = ? ORDER BY id DESC LIMIT ?)`
  ).run(projectId, projectId, AWARENESS_RECEIPT_RETENTION);
}

const awarenessReceiptsApi = {
  /**
   * Record one observed `tc` invocation (ambient-awareness Chunk 02).
   *
   * Nullable ids are deliberate: an invocation whose project could not be
   * resolved still proves the CLI was discovered and run, which is the fact
   * this ledger measures — the HIGH-impact assumption the plan tests is "does
   * an agent invoke a PATH-present CLI at all", and that signal must not
   * depend on the ids being right.
   *
   * @param {object} entry
   * @param {number|null} [entry.projectId] - Project the caller claimed (resolved or null)
   * @param {number|null} [entry.sessionId] - Active session resolved server-side (best-effort)
   * @param {string|null} [entry.workspaceId] - Switchboard workspace id the pane carried
   * @param {string} entry.verb - The CLI verb invoked (e.g. 'whoami')
   * @param {string} [entry.source='http'] - Provenance: 'tc-cli' only when the
   *   caller identified itself as the tc client; anything else stays 'http' so
   *   a browser preview cannot fabricate the awareness fact
   * @param {string|null} [entry.role] - Non-project actor: 'master' for the
   *   Project Master (#1141); NULL for every project session
   * @returns {object} The recorded receipt
   * @throws {StoreError} BAD_REQUEST on a missing verb or unknown source
   */
  record(entry = {}) {
    _ensureDb();
    if (!entry.verb || typeof entry.verb !== 'string') {
      throw new StoreError('verb is required', 'BAD_REQUEST');
    }
    const source = entry.source ?? 'http';
    if (!AWARENESS_RECEIPT_SOURCES.includes(source)) {
      throw new StoreError(`source must be one of ${AWARENESS_RECEIPT_SOURCES.join(', ')}`, 'BAD_REQUEST');
    }
    const info = _db.prepare(
      `INSERT INTO awareness_receipts (project_id, session_id, workspace_id, verb, source, role)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      entry.projectId ?? null,
      entry.sessionId ?? null,
      entry.workspaceId ?? null,
      entry.verb,
      source,
      entry.role ?? null
    );
    _pruneAwarenessReceipts(entry.projectId ?? null);
    return _rowToAwarenessReceipt(
      _db.prepare('SELECT * FROM awareness_receipts WHERE id = ?').get(info.lastInsertRowid)
    );
  },

  /**
   * A session's receipts, oldest first — "did session X ever become aware".
   * @param {number} sessionId
   * @returns {object[]}
   */
  listForSession(sessionId) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM awareness_receipts WHERE session_id = ? ORDER BY id'
    ).all(sessionId).map(_rowToAwarenessReceipt);
  },

  /**
   * A project's receipts, newest first — the launch-level view Chunk 05's
   * "sessions that never became aware" surface reads.
   * @param {number} projectId
   * @param {object} [options]
   * @param {number} [options.limit=20] - Max rows
   * @returns {object[]}
   */
  listForProject(projectId, options = {}) {
    _ensureDb();
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
    return _db.prepare(
      'SELECT * FROM awareness_receipts WHERE project_id = ? ORDER BY id DESC LIMIT ?'
    ).all(projectId, limit).map(_rowToAwarenessReceipt);
  },

  /**
   * The Project Master's receipts since a moment, newest first (#1141) —
   * scoped so a receipt from a PREVIOUS master run cannot confirm the current
   * one. `since` null means all master receipts (caller has no start time).
   * @param {string|null} sinceUtc - 'YYYY-MM-DD HH:MM:SS' UTC floor, or null
   * @returns {object[]}
   */
  listForMaster(sinceUtc = null) {
    _ensureDb();
    if (sinceUtc) {
      return _db.prepare(
        "SELECT * FROM awareness_receipts WHERE role = 'master' AND created_at >= ? ORDER BY id DESC"
      ).all(sinceUtc).map(_rowToAwarenessReceipt);
    }
    return _db.prepare(
      "SELECT * FROM awareness_receipts WHERE role = 'master' ORDER BY id DESC"
    ).all().map(_rowToAwarenessReceipt);
  },

  /**
   * One session's awareness state, composed at read time from the two ledgers
   * that already exist — receipts (what the session demonstrated) and the
   * delivery ledger (what a channel was observed to do). No persisted state
   * column: it would be a second source of truth that drifts.
   *
   * The vocabulary is Direction §4's, plus the red state this view exists for:
   *   - `confirmed`  — ≥1 receipt: the session invoked `tc` itself.
   *   - `sent`       — no receipt, but a delivery row recorded `delivered`:
   *                    a channel was observed to land; nothing was demonstrated.
   *   - `unverified` — no receipt; the best delivery row is `unverified` or
   *                    `written`: something was put on the channel and nothing
   *                    confirmed the far side. A `written` row still standing
   *                    is #759's shape — shards on disk, hook never ran.
   *   - `no-rules`   — no receipt, no delivery; a `no-rules` row proves the
   *                    launch path ran and the project had no active rules to
   *                    deliver. Not the red state: nothing was owed, so
   *                    non-delivery is not evidence of a severed carrier
   *                    (#1139 — 23 rule-less projects sat permanently red).
   *   - `unaware`    — no receipt, no delivered/unverified row, and either a
   *                    `skipped` row or nothing at all. Precisely: no EVIDENCE
   *                    awareness arrived — the state that hid for 12 days in
   *                    August 2026 and must not be able to again. A `skipped`
   *                    row deliberately reads red and outranks a coexisting
   *                    `no-rules` row: a skip says the carrier demonstrably
   *                    failed to reach the session (see the acceptance test).
   *
   * Known bounded blind spot (accepted at the Chunk 03 review as R-2): a
   * message-verb invocation that fails identity resolution client-side leaves
   * zero receipts — and could not be attributed to a session even if it left
   * one, so this view cannot and does not claim to see it.
   *
   * @param {number} sessionId - Session id (any status)
   * @returns {{state: string, basis: string, receiptCount: number,
   *   lastVerb: string|null, lastReceiptAt: string|null}}
   */
  sessionAwareness(sessionId) {
    _ensureDb();
    const receipts = _db.prepare(
      'SELECT verb, created_at FROM awareness_receipts WHERE session_id = ? ORDER BY id DESC'
    ).all(sessionId);
    if (receipts.length > 0) {
      return {
        state: 'confirmed',
        basis: `the session invoked tc itself (${receipts.length} receipt${receipts.length === 1 ? '' : 's'}, last verb '${receipts[0].verb}')`,
        receiptCount: receipts.length,
        lastVerb: receipts[0].verb,
        lastReceiptAt: receipts[0].created_at
      };
    }
    const none = { receiptCount: 0, lastVerb: null, lastReceiptAt: null };
    const delivered = _db.prepare(
      "SELECT channel FROM session_rule_deliveries WHERE session_id = ? AND outcome = 'delivered' ORDER BY id DESC LIMIT 1"
    ).get(sessionId);
    if (delivered) {
      return {
        state: 'sent',
        basis: `a channel delivered (${delivered.channel}) but the session never demonstrated awareness`,
        ...none
      };
    }
    // `written` joins `unverified` here rather than earning a state of its own
    // (#1063): both mean the same thing to a reader — something was put on the
    // channel and nothing confirmed the far side — so they share the state and
    // differ only in the basis, which names the cause the operator has to act
    // on. A `written` row standing after launch is the #759 shape exactly: the
    // shards are on disk and the engine's hook never posted its receipt.
    const unconfirmed = _db.prepare(
      "SELECT channel, outcome, skip_reason FROM session_rule_deliveries WHERE session_id = ? AND outcome IN ('unverified','written') ORDER BY id DESC LIMIT 1"
    ).get(sessionId);
    if (unconfirmed) {
      return {
        state: 'unverified',
        basis: unconfirmed.outcome === 'written'
          ? `the rule shards were written for ${unconfirmed.channel} but the engine's hook never confirmed reading them, and no tc invocation was observed`
          : `a blind send through ${unconfirmed.channel} (${unconfirmed.skip_reason || 'no reason recorded'}) and no tc invocation`,
        ...none
      };
    }
    // A skipped row outranks a no-rules row (Critic R-2): a rule-less launch
    // records no-rules AND still schedules the prime paste, so a session can
    // carry both. The skip says the awareness carrier demonstrably failed to
    // reach the pane — severed-carrier evidence that must stay red, not be
    // soothed by "nothing was owed".
    const skipped = _db.prepare(
      "SELECT channel, skip_reason FROM session_rule_deliveries WHERE session_id = ? AND outcome = 'skipped' ORDER BY id DESC LIMIT 1"
    ).get(sessionId);
    if (skipped) {
      return {
        state: 'unaware',
        basis: `a channel explicitly skipped (${skipped.channel}: ${skipped.skip_reason || 'no reason recorded'}) and no tc invocation was observed — there is no evidence awareness ever arrived`,
        ...none
      };
    }
    const noRules = _db.prepare(
      "SELECT id FROM session_rule_deliveries WHERE session_id = ? AND outcome = 'no-rules' LIMIT 1"
    ).get(sessionId);
    if (noRules) {
      return {
        state: 'no-rules',
        basis: 'the launch path ran and the project had no active rules to deliver — nothing was owed, so non-delivery is not evidence of a severed carrier',
        ...none
      };
    }
    return {
      state: 'unaware',
      basis: 'no channel recorded a delivery and no tc invocation was observed — there is no evidence awareness ever arrived',
      ...none
    };
  },

  /**
   * The fleet-wide awareness view — "sessions that never became aware" as a
   * queryable state (the surface the 2026-08-18 regression lacked: eight
   * projects launched sessions for 12 days with a severed carrier and nothing
   * anywhere turned red). Per project: its most recent sessions, each with the
   * composed state above; projects with no sessions yet are omitted (nothing
   * launched means nothing to be aware).
   *
   * @param {object} [options]
   * @param {number} [options.sessionsPerProject=3] - Recent sessions per project (1..20)
   * @returns {object[]} One entry per project with sessions, newest session first
   */
  fleetAwareness(options = {}) {
    _ensureDb();
    const per = Number.isInteger(options.sessionsPerProject)
      && options.sessionsPerProject > 0 && options.sessionsPerProject <= 20
      ? options.sessionsPerProject : 3;
    const projects = _db.prepare(
      'SELECT id, name, engine_id FROM projects WHERE archived = 0 ORDER BY name'
    ).all();
    const out = [];
    for (const p of projects) {
      const sessions = _db.prepare(
        'SELECT id, engine_id, status, started_at, ended_at FROM sessions WHERE project_id = ? ORDER BY id DESC LIMIT ?'
      ).all(p.id, per);
      if (sessions.length === 0) continue;
      out.push({
        projectId: p.id,
        name: p.name,
        engineId: p.engine_id,
        sessions: sessions.map((s) => ({
          id: s.id,
          engineId: s.engine_id,
          status: s.status,
          startedAt: s.started_at,
          endedAt: s.ended_at,
          ...this.sessionAwareness(s.id)
        }))
      });
    }
    return out;
  }
};

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
   * @param {'loopback'|'tailnet'|'lan'} [data.reach='loopback'] - How far the
   *   service behind this port is MEANT to be reachable. Replace semantics, like
   *   every sibling field: an omitted value means `loopback`, so a renewal that
   *   does not restate a wider reach narrows the record back to the weakest
   *   claim. That direction is deliberate — the Caddyfile divergence check
   *   (#1394) reads this field, and a stale-wide value would hide a real
   *   exposure while a stale-narrow one only over-reports.
   * @param {boolean} [data.force] - Take over a live lease held by a different
   *   project. Without it, such a request throws `PORT_CONFLICT` (the error
   *   carries the current lease on `.owner`). Re-leasing a port this same
   *   project already holds is a renewal and never needs it.
   * @param {'project'|'external'} [data.ownerKind] - Whether the owner is a
   *   TangleClaw project (#1381). KEEP semantics, unlike `reach`: omitting it
   *   on a renewal preserves the stored value, and a new lease defaults to
   *   `project`. The asymmetry is deliberate — a renewal that forgot the field
   *   must not turn an external owner back into a project, because that
   *   re-arms the boot orphan sweep against a lease it has no business deleting.
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
    // Validate here rather than letting the CHECK constraint throw: a caller
    // that sends a typo deserves to be told which values exist, and a raw
    // SQLite constraint message names neither the field's purpose nor them.
    const reach = data.reach == null ? 'loopback' : data.reach;
    if (!LEASE_REACHES.includes(reach)) {
      throw new StoreError(
        `reach must be one of ${LEASE_REACHES.join(', ')} (got ${JSON.stringify(data.reach)})`,
        'BAD_REQUEST'
      );
    }

    const ownerKind = data.ownerKind == null ? null : data.ownerKind;
    if (ownerKind !== null && !LEASE_OWNER_KINDS.includes(ownerKind)) {
      throw new StoreError(
        `ownerKind must be one of ${LEASE_OWNER_KINDS.join(', ')} (got ${JSON.stringify(data.ownerKind)})`,
        'BAD_REQUEST'
      );
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
      INSERT INTO port_leases (host, port, project, service, status, permanent, ttl_ms, expires_at, last_heartbeat, description, auto_renew, reach, owner_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, COALESCE(?, 'project'))
      ON CONFLICT(host, port) DO UPDATE SET
        reach = excluded.reach,
        -- An omitted ownerKind keeps the stored one only for the SAME owner;
        -- a forced takeover is a different owner, whose kind was never stated.
        -- (SET expressions read the row as it was before this update.)
        owner_kind = COALESCE(?, CASE WHEN port_leases.project = excluded.project
                                      THEN port_leases.owner_kind ELSE 'project' END),
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
    `).run(host, data.port, data.project, data.service, status, permanent, ttlMs, expiresAt, description, autoRenew, reach, ownerKind, ownerKind);

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
   * The audit row names who decided: an ordinary release is `port.released`, a
   * forced cross-project one is `port.force_released` carrying both the
   * displaced owner and the caller who took it.
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
    let forced = false;

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
      forced = true;
    }

    _db.prepare('DELETE FROM port_leases WHERE host = ? AND port = ?').run(host, port);
    if (existing) {
      // `port.released` names the project that gave the port back. When someone
      // ELSE forced the release, that project did not give anything back — it
      // was displaced, and a row spelling the two the same way cannot answer
      // who decided the lease should go. `port.force_released` names both
      // sides, the way `port.takeover` does for the mirror act of seizing one.
      activityApi.log({
        eventType: forced ? 'port.force_released' : 'port.released',
        detail: forced
          ? {
            host,
            port,
            displacedProject: existing.project,
            displacedService: existing.service,
            byProject: options.project
          }
          : { host, port, project: existing.project, service: existing.service }
      });
    }
  },

  /**
   * Release all leases for a project.
   *
   * `options.reason` names who decided, and that decides the audit event type.
   * A project being deleted releases its own ports and is recorded as
   * `port.released`; the boot orphan sweep releases the ports of a project it
   * classified as gone, and is recorded as `port.orphan_swept`. The two need
   * separate types for the reason a forced takeover has its own: the displaced
   * project may still be running against the port, so the only question worth
   * asking of the trail afterwards is who decided the lease should go — and a
   * sweep wearing the owner's label cannot answer it. Reasons other than
   * `orphan-sweep` (including none) record an owner-initiated release, so a
   * caller that adds a new automated deleter has to name it here rather than
   * inherit a label that would be wrong.
   *
   * @param {string} project
   * @param {object} [options]
   * @param {string} [options.reason] - `'orphan-sweep'` when an automated sweep displaced the leases
   * @param {'project'|'external'} [options.ownerKind] - Release only leases of
   *   this owner kind. The orphan sweep passes `project` so a name that holds
   *   both kinds keeps its external leases (#1381).
   * @returns {number} - Count of released leases
   */
  releaseByProject(project, options = {}) {
    _ensureDb();
    const swept = options.reason === 'orphan-sweep';
    const leases = portLeasesApi.getByProject(project)
      .filter((l) => !options.ownerKind || l.ownerKind === options.ownerKind);
    if (options.ownerKind) {
      _db.prepare('DELETE FROM port_leases WHERE project = ? AND owner_kind = ?').run(project, options.ownerKind);
    } else {
      _db.prepare('DELETE FROM port_leases WHERE project = ?').run(project);
    }
    for (const lease of leases) {
      if (swept) {
        // An unattended deletion must never be quiet. If the classifier that
        // called this is wrong about the project being gone, the service is
        // still listening and the next claimant collides with it — this line
        // and its activity row are the only trace of who held the port.
        log.warn('Orphan sweep released a port lease', {
          host: lease.host,
          port: lease.port,
          project,
          service: lease.service
        });
      }
      activityApi.log({
        eventType: swept ? 'port.orphan_swept' : 'port.released',
        detail: { host: lease.host, port: lease.port, project, service: lease.service }
      });
    }
    return leases.length;
  },

  /**
   * Set the owner kind on every lease held under one owner name (#1381).
   *
   * The dashboard's "Not a project" control calls this through
   * `POST /api/ports/owner-kind`: an owner name the operator knows is a
   * `brew services` database or a system daemon is recorded as `external`, which
   * the boot orphan sweep and the import banner both read. It changes no other
   * field, so a permanent lease stays permanent and its reach is untouched.
   *
   * @param {string} project - Owner name as it appears on the leases
   * @param {'project'|'external'} ownerKind
   * @param {object} [options]
   * @param {string} [options.host] - Limit to one host; every host when omitted
   * @returns {number} Count of leases updated
   * @throws {StoreError} `BAD_REQUEST` for a missing name or an unknown kind
   */
  setOwnerKind(project, ownerKind, options = {}) {
    _ensureDb();
    if (!project) {
      throw new StoreError('project is required', 'BAD_REQUEST');
    }
    if (!LEASE_OWNER_KINDS.includes(ownerKind)) {
      throw new StoreError(
        `ownerKind must be one of ${LEASE_OWNER_KINDS.join(', ')} (got ${JSON.stringify(ownerKind)})`,
        'BAD_REQUEST'
      );
    }
    const result = options.host
      ? _db.prepare("UPDATE port_leases SET owner_kind = ?, updated_at = datetime('now') WHERE project = ? AND host = ?")
        .run(ownerKind, project, options.host)
      : _db.prepare("UPDATE port_leases SET owner_kind = ?, updated_at = datetime('now') WHERE project = ?")
        .run(ownerKind, project);
    const count = Number(result.changes);
    if (count > 0) {
      activityApi.log({
        eventType: 'port.owner_kind',
        detail: { project, host: options.host || null, ownerKind, count }
      });
    }
    return count;
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
   * Whether a lease still holds its port — the same rule the lease path's
   * conflict check applies, exposed so a caller deciding what a lease means
   * (PortHub's listener check) cannot drift into a looser copy of it.
   * @param {object} lease - A lease as returned by `get`/`list`
   * @returns {boolean}
   */
  isLive(lease) {
    _ensureDb();
    return _isLeaseLive(lease);
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

// ── Users (ADR 0015, tier 1) ──
//
// The store half of TangleClaw's own front door, landed before anything gates on
// it. Two callers are coming: the session gate, and the break-glass reset tool
// that has to work when the gate is what is broken. Both need the same
// operations, so they live here rather than in whichever one is written first.
//
// Nothing in this API decides access. It answers "is this the right password for
// this account, and is the account active" — the route above it decides what
// that means. ADR 0015's tier split depends on that staying true: a resource
// default must never be readable as a security answer, and the cheapest way to
// hold that line is for the identity layer to have no vocabulary for it.

// A throwaway scrypt hash that `verify` compares against when there is no
// account to compare against. Its VALUE is irrelevant and nothing may ever
// match it — its only job is to cost what a real comparison costs, so a missing
// or disabled account takes the same time as a wrong password.
//
// Derived on first use, not at module load. `lib/store.js` is required by
// almost everything here — the server, every `tc` verb, every test process —
// and a module-load derivation charged all of them ~30ms for a value only the
// login path reads.
let _absentUserHash = null;

/**
 * The dummy hash the no-account paths compare against, derived once per process.
 * @returns {string} A scrypt hash in salt:hash form that nothing can match
 */
function _absentUserHashValue() {
  if (_absentUserHash === null) {
    _absentUserHash = passwordHashing.hashPassword(crypto.randomBytes(32).toString('hex'));
  }
  return _absentUserHash;
}

/**
 * Validate a first-account submission's two fields, returning the trimmed name.
 * @param {string} username
 * @param {string} password
 * @returns {string}
 * @throws {Error} If either is empty
 */
function _firstAccountName(username, password) {
  const name = typeof username === 'string' ? username.trim() : '';
  if (!name) throw new Error('username is required');
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password is required');
  }
  return name;
}

/**
 * Insert a first account under the write lock, refusing if any account exists.
 * See `usersApi.createFirst` for why the check and the insert share a transaction.
 * @param {string} name - Trimmed account name
 * @param {string} hash - scrypt `salt:hash`
 * @returns {{ id: number, username: string }}
 * @throws {Error} `code: 'ACCOUNT_EXISTS'` if any account row exists
 */
function _insertFirstAccount(name, hash) {
  _db.exec('BEGIN IMMEDIATE');
  let info;
  try {
    const existing = _db.prepare('SELECT 1 AS present FROM users LIMIT 1').get();
    if (existing) {
      const err = new Error('an account already exists');
      err.code = 'ACCOUNT_EXISTS';
      throw err;
    }
    info = _db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(name, hash);
    _db.exec('COMMIT');
  } catch (err) {
    _db.exec('ROLLBACK');
    throw err;
  }
  _recordAccountsEstablished();
  log.info('First account created', { username: name });
  return { id: Number(info.lastInsertRowid), username: name };
}

const usersApi = {
  /**
   * Create a user with a scrypt-hashed password.
   * @param {string} username - Unique account name
   * @param {string} password - Plaintext; hashed here, never stored raw
   * @returns {{ id: number, username: string }}
   * @throws {Error} If the username is taken, empty, or the password is empty
   */
  create(username, password) {
    const name = typeof username === 'string' ? username.trim() : '';
    if (!name) throw new Error('username is required');
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('password is required');
    }
    const hash = passwordHashing.hashPassword(password);
    try {
      const info = _db.prepare(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)'
      ).run(name, hash);
      _recordAccountsEstablished();
      log.info('User created', { username: name });
      return { id: Number(info.lastInsertRowid), username: name };
    } catch (err) {
      // Narrow on the constraint rather than catching broadly: any other
      // failure here is a real fault and must not be reported as "name taken".
      if (/UNIQUE constraint failed: users.username/.test(err.message)) {
        throw new Error(`username already exists: ${name}`);
      }
      throw err;
    }
  },

  /**
   * Create an install's FIRST account, refusing if any account already exists.
   *
   * The only writer of a first account. `create` alone cannot serve it: the gate
   * offers the first-account page while no row exists, and a "check the table,
   * then create" at the route lets two submissions that both saw an empty table
   * each create an account — and a second process (`scripts/reset-admin.js`)
   * can land between the check and the insert however the route is written. So
   * the check and the insert share one `BEGIN IMMEDIATE` transaction, which
   * takes SQLite's write lock before the check reads.
   *
   * Synchronous hashing, for the first-run wizard, which runs once. The
   * unauthenticated page uses {@link usersApi.createFirstAsync}.
   *
   * @param {string} username - Account name
   * @param {string} password - Plaintext; hashed here, never stored raw
   * @returns {{ id: number, username: string }}
   * @throws {Error} `code: 'ACCOUNT_EXISTS'` if any account row exists; a plain
   *   Error if the username or password is empty
   */
  createFirst(username, password) {
    const name = _firstAccountName(username, password);
    return _insertFirstAccount(name, passwordHashing.hashPassword(password));
  },

  /**
   * {@link usersApi.createFirst}, with the password hashed off the event loop.
   *
   * The hash is computed BEFORE the transaction opens, so SQLite's write lock is
   * never held across a scrypt derivation, and the existence check still runs
   * under that lock afterwards.
   *
   * @param {string} username - Account name
   * @param {string} password - Plaintext; hashed here, never stored raw
   * @returns {Promise<{ id: number, username: string }>}
   * @throws {Error} as {@link usersApi.createFirst}
   */
  async createFirstAsync(username, password) {
    const name = _firstAccountName(username, password);
    const hash = await passwordHashing.hashPasswordAsync(password);
    return _insertFirstAccount(name, hash);
  },

  /**
   * Look a user up by name, including disabled ones.
   *
   * Returns the row with its hash, because the only caller that needs a user by
   * name is the one about to verify a password against it. A caller that only
   * wants to know whether a name is taken should call `create` and catch its
   * refusal — the UNIQUE constraint is race-free where a check-then-act is not.
   *
   * @param {string} username
   * @returns {{ id: number, username: string, password_hash: string,
   *   created_at: string, disabled_at: string|null }|null}
   */
  getByName(username) {
    if (typeof username !== 'string' || !username.trim()) return null;
    return _db.prepare('SELECT * FROM users WHERE username = ?')
      .get(username.trim()) || null;
  },

  /**
   * Replace a user's password.
   *
   * Destroys the account's live sessions as part of the change. The caller that
   * matters is `scripts/reset-admin.js`, the break-glass tool: someone running
   * it because they believe the credential is compromised would otherwise leave
   * every session issued under the old password valid for up to 30 more days,
   * and a reset that does not end the attacker's session has not recovered
   * anything. The cost is that an operator changing their own password is
   * signed out and signs back in, which is the behaviour they expect anyway.
   *
   * @param {string} username
   * @param {string} password - New plaintext password
   * @returns {boolean} - false if no such user
   */
  setPassword(username, password) {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('password is required');
    }
    const name = typeof username === 'string' ? username.trim() : '';
    if (!name) return false;
    const info = _db.prepare('UPDATE users SET password_hash = ? WHERE username = ?')
      .run(passwordHashing.hashPassword(password), name);
    if (info.changes > 0) {
      const killed = authSessionsApi.destroyForUser(name);
      log.info('User password changed', { username: name, sessionsDestroyed: killed });
    }
    return info.changes > 0;
  },

  /**
   * Change a signed-in account's password from the session it is signed in with:
   * verify the current password, set the new one, end the account's other
   * sessions, and replace this session with a fresh one — the writes atomically.
   *
   * The dashboard's own password change. {@link usersApi.setPassword} ends every
   * session, which is right for the terminal break-glass tool and wrong here: the
   * person changing the password is the one holding this session, and signing
   * them out of the page they just used is a surprise, not a protection. Every
   * other session is ended, because the reason to change a password is often
   * that someone else may know the old one — and THIS session's token is
   * replaced too, so a copied cookie for this browser does not survive the
   * change either. The caller sets the returned session's cookies.
   *
   * Both derivations (verify, hash) run BEFORE the transaction, so SQLite's write
   * lock is never held across scrypt. That leaves a window, closed under the
   * lock by two re-checks:
   *   - the stored hash is still the one the current password was verified
   *     against. Otherwise two sessions changing the password at once would
   *     both succeed, the second overwriting the first, and the first person
   *     would be left not knowing the password they were told they set;
   *   - the session the change is made from still exists (and so the account is
   *     still enabled: disabling deletes its sessions). A sign-out-everywhere, a
   *     recovery code or a disable that lands in between must win.
   * Either failing is `stale`, and nothing is written.
   *
   * Recovery codes are not touched — they reset a forgotten password, and a
   * change made by someone who knows the current one does not revoke them.
   *
   * @param {{ id: number, userId: number, username: string }} session - The live session
   * @param {string} currentPassword - Plaintext, verified here
   * @param {string} newPassword - Plaintext, already policy-checked by the caller
   * @returns {Promise<{ status: 'changed', sessionsEnded: number, session: { token: string, csrfToken: string, expiresAt: number } }
   *   | { status: 'bad-password' } | { status: 'stale' }>}
   */
  async changePasswordFromSession(session, currentPassword, newPassword) {
    if (!session || typeof session.id !== 'number' || typeof session.userId !== 'number') {
      throw new Error('a live session is required');
    }
    if (typeof newPassword !== 'string' || !newPassword) throw new Error('newPassword is required');
    const before = _db.prepare('SELECT username, password_hash FROM users WHERE id = ? AND disabled_at IS NULL')
      .get(session.userId);
    if (!before) return { status: 'stale' };
    const candidate = typeof currentPassword === 'string' ? currentPassword : '';
    if (!await passwordHashing.verifyPasswordAsync(candidate, before.password_hash)) {
      return { status: 'bad-password' };
    }
    const hash = await passwordHashing.hashPasswordAsync(newPassword);

    _db.exec('BEGIN IMMEDIATE');
    let ended;
    let fresh;
    try {
      const still = _db.prepare(
        'SELECT 1 AS ok FROM users u JOIN auth_sessions s ON s.user_id = u.id '
        + 'WHERE u.id = ? AND u.disabled_at IS NULL AND u.password_hash = ? AND s.id = ?'
      ).get(session.userId, before.password_hash, session.id);
      if (!still) {
        _db.exec('ROLLBACK');
        return { status: 'stale' };
      }
      _db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, session.userId);
      // Every session the account holds, this one included; this one is
      // replaced below, so "other sessions ended" is the count less one.
      const deleted = Number(_db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(session.userId).changes);
      ended = deleted - 1;
      fresh = authSessionsApi.create({ id: session.userId, username: before.username });
      _db.exec('COMMIT');
    } catch (err) {
      _db.exec('ROLLBACK');
      throw err;
    }
    log.warn('User password changed from the dashboard', {
      username: before.username, otherSessionsEnded: ended
    });
    return { status: 'changed', sessionsEnded: ended, session: fresh };
  },

  /**
   * Verify a username/password pair.
   *
   * Returns the user on success and null on every failure — wrong password,
   * unknown account, disabled account — and spends the same scrypt work on all
   * three, so neither the return value nor the response time distinguishes them.
   * An early return on the no-row path is the classic username oracle: the value
   * is identical, the timing is not, and a login route is exactly where that
   * gets sampled. `_absentUserHashValue()` exists only to be the thing those
   * paths compare against.
   *
   * The reason is logged at warn, not returned. Warn because the default log
   * level is info, so a debug line would mean a remote operator — who reads the
   * log file, not a terminal — could not answer "why can't Rosie log in" or see
   * repeated failures against a door that fronts a writable shell. Same level
   * this repo already uses for a denied service token.
   *
   * A disabled account fails here rather than at the route, because "revoke one
   * person" is the capability ADR 0015 exists to provide and it must not depend
   * on every future caller remembering to check a column.
   *
   * @param {string} username
   * @param {string} password - Plaintext
   * @returns {{ id: number, username: string }|null}
   */
  verify(username, password) {
    const row = usersApi.getByName(username);
    if (!row || row.disabled_at) {
      // Burn the same work the real path pays, then fail. The result is
      // discarded on purpose — it is the cost that matters, not the answer.
      passwordHashing.verifyPassword(
        typeof password === 'string' ? password : '', _absentUserHashValue()
      );
      // No name on the unknown-account branch, deliberately: the string was
      // typed into a username field and a person who mistypes their password
      // into it should not have it land in the log. `reason` still tells the
      // operator which of the two happened.
      log.warn('User verify failed', {
        username: row ? row.username : null,
        reason: row ? 'disabled' : 'no such user'
      });
      return null;
    }
    if (!passwordHashing.verifyPassword(password, row.password_hash)) {
      log.warn('User verify failed', { username: row.username, reason: 'bad password' });
      return null;
    }
    return { id: row.id, username: row.username };
  },

  /**
   * Verify a username/password pair without blocking the event loop.
   *
   * The async sibling of {@link usersApi.verify}, and the one the login route
   * uses. Everything the sync version documents applies unchanged — same
   * return shape, same equal scrypt cost on all three failure modes, same
   * `_absentUserHashValue()` as the thing the no-account path compares against,
   * same warn-level logging.
   *
   * It exists because `crypto.scryptSync` costs tens of milliseconds on a
   * single-threaded server (ADR 0016). That was irrelevant guarding a rare
   * project deletion; on a login route a burst of attempts stalls every other
   * request, including the dashboard the operator is trying to reach.
   *
   * The equalisation is kept, NOT optimised away: the equal cost IS the
   * anti-timing-oracle fix, so the answer to blocking is to stop blocking and
   * never to stop paying. It is also not re-implemented at the route — ADR 0016
   * says that explicitly, and this method is where the one owner lives.
   *
   * @param {string} username
   * @param {string} password - Plaintext
   * @returns {Promise<{ id: number, username: string }|null>}
   */
  async verifyAsync(username, password) {
    const row = usersApi.getByName(username);
    const candidate = typeof password === 'string' ? password : '';
    if (!row || row.disabled_at) {
      await passwordHashing.verifyPasswordAsync(candidate, _absentUserHashValue());
      log.warn('User verify failed', {
        username: row ? row.username : null,
        reason: row ? 'disabled' : 'no such user'
      });
      return null;
    }
    if (!await passwordHashing.verifyPasswordAsync(candidate, row.password_hash)) {
      log.warn('User verify failed', { username: row.username, reason: 'bad password' });
      return null;
    }
    return { id: row.id, username: row.username };
  },

  /**
   * Disable a user, revoking their login without deleting the account.
   *
   * Also destroys every live session the account holds. Without that, "revoke
   * one person" — the capability ADR 0015 exists to provide — would not take
   * effect until their cookie expired up to 30 days later, because an issued
   * session never calls `verify` again. The sibling guard is in
   * `authSessionsApi.resolve`, which re-checks `disabled_at` on every request;
   * both are kept because this one makes revocation immediate and that one
   * makes it impossible to forget.
   *
   * Deletes the account's recovery codes too, for the same reason. A disabled
   * account's code already redeems nothing, but it is a key the revoked person
   * may hold, and it would work again the day the account is re-enabled.
   *
   * @param {string} username
   * @returns {boolean} - false if no such user, or already disabled
   */
  disable(username) {
    const name = typeof username === 'string' ? username.trim() : '';
    if (!name) return false;
    const info = _db.prepare(
      "UPDATE users SET disabled_at = datetime('now') "
      + 'WHERE username = ? AND disabled_at IS NULL'
    ).run(name);
    if (info.changes > 0) {
      const killed = authSessionsApi.destroyForUser(name);
      const codesDeleted = recoveryCodesApi.deleteForUsername(name);
      log.info('User disabled', { username: name, sessionsDestroyed: killed, recoveryCodesDeleted: codesDeleted });
    }
    return info.changes > 0;
  },

  /**
   * Re-enable a disabled user.
   *
   * Deletes any recovery codes the account still holds. {@link usersApi.disable}
   * already did, so this finds none unless `disabled_at` was set some other way
   * (a hand edit of the database) — and an account coming back must not bring a
   * set the person it was taken from may still hold. The operator generates a
   * new set in Settings once signed in.
   *
   * @param {string} username
   * @returns {boolean} - false if no such user, or already active
   */
  enable(username) {
    const name = typeof username === 'string' ? username.trim() : '';
    if (!name) return false;
    const info = _db.prepare(
      'UPDATE users SET disabled_at = NULL WHERE username = ? AND disabled_at IS NOT NULL'
    ).run(name);
    if (info.changes > 0) {
      const codesDeleted = recoveryCodesApi.deleteForUsername(name);
      log.info('User enabled', { username: name, recoveryCodesDeleted: codesDeleted });
    }
    return info.changes > 0;
  },

  /**
   * List every account, oldest first. Never returns password hashes — no
   * caller that lists users needs one, and a listing is the surface most likely
   * to reach a log or an API response.
   * @returns {Array<{ id: number, username: string, created_at: string,
   *   disabled_at: string|null }>}
   */
  list() {
    return _db.prepare(
      'SELECT id, username, created_at, disabled_at FROM users ORDER BY id ASC'
    ).all();
  },

  /**
   * Whether this install has ever had an account, whatever the store holds now
   * (see `_accountsEstablishedPath`). Every account insert records it, and
   * `init` backfills it for accounts that predate the marker.
   *
   * @returns {boolean}
   * @throws {Error} If the marker cannot be checked for a reason other than
   *   not existing — a caller deciding who may create the first account must not
   *   read that as "never had one".
   */
  accountsEstablished() {
    try {
      fs.statSync(_accountsEstablishedPath());
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }
};

// Logged-in browser sessions for TangleClaw's own front door (#1418, ADR 0016).
//
// The token never reaches this table: every verb here takes or returns a RAW
// token and stores only `authSession.hashToken()` of it. That is what keeps a
// database backup from being a bag of live credentials.
const authSessionsApi = {
  /**
   * Create a session for a user and return its raw token.
   *
   * Minting is the ONLY way a session id enters the system — there is no verb
   * that adopts a caller-supplied one — so session fixation is closed by
   * construction rather than by a check that could be forgotten. The login
   * route additionally destroys whatever session the request arrived carrying.
   *
   * @param {{ id: number, username: string }} user - A verified user
   * @param {number} [now] - Epoch ms; injectable so expiry is testable
   * @returns {{ token: string, csrfToken: string, expiresAt: number }}
   */
  create(user, now) {
    if (!user || typeof user.id !== 'number' || typeof user.username !== 'string') {
      throw new Error('a verified user is required');
    }
    const token = authSession.mintToken();
    const csrfToken = authSession.mintToken();
    const expiresAt = authSession.expiryFrom(now);
    _db.prepare(
      'INSERT INTO auth_sessions (token_hash, user_id, username, csrf_token, expires_at) '
      + 'VALUES (?, ?, ?, ?, ?)'
    ).run(authSession.hashToken(token), user.id, user.username, csrfToken, expiresAt);
    log.info('Session created', { username: user.username });
    return { token, csrfToken, expiresAt };
  },

  /**
   * Resolve a raw token to its live session, or null.
   *
   * Three things make a session not-live and all three are checked HERE rather
   * than at the call site, because this is the one function every gated request
   * passes through and a check that lives anywhere else can be skipped by a
   * future route: the row must exist, it must not have expired, and the account
   * must not have been disabled since the session was issued. The join is what
   * makes revocation impossible to forget — `users.disable` also deletes
   * sessions, which makes it immediate, but a direct database edit or a future
   * disable path that forgets would still be caught here.
   *
   * An expired row is deleted as it is found rather than merely refused, so an
   * abandoned browser's row does not sit in the table until a sweep runs.
   *
   * @param {string} token - The raw token from the cookie
   * @param {number} [now] - Epoch ms; injectable for tests
   * @returns {{ id: number, userId: number, username: string, csrfToken: string,
   *   expiresAt: number }|null}
   */
  resolve(token, now) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const at = typeof now === 'number' ? now : Date.now();
    const row = _db.prepare(
      'SELECT s.id, s.user_id, s.username, s.csrf_token, s.expires_at, u.disabled_at '
      + 'FROM auth_sessions s JOIN users u ON u.id = s.user_id '
      + 'WHERE s.token_hash = ?'
    ).get(authSession.hashToken(token));
    if (!row) return null;
    if (row.expires_at <= at) {
      _db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(row.id);
      log.debug('Session expired', { username: row.username });
      return null;
    }
    if (row.disabled_at) {
      // Belt to disable()'s braces. Deleted here too: a session whose account
      // is disabled is never becoming valid again.
      _db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(row.id);
      log.warn('Session refused — account disabled', { username: row.username });
      return null;
    }
    return {
      id: row.id,
      userId: row.user_id,
      username: row.username,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at
    };
  },

  /**
   * Destroy the session a raw token names.
   * @param {string} token - The raw token from the cookie
   * @returns {boolean} - false when the token named no session
   */
  destroy(token) {
    if (typeof token !== 'string' || token.length === 0) return false;
    const info = _db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
      .run(authSession.hashToken(token));
    return info.changes > 0;
  },

  /**
   * Destroy every session belonging to a username.
   * @param {string} username
   * @returns {number} - How many sessions were destroyed
   */
  destroyForUser(username) {
    const name = typeof username === 'string' ? username.trim() : '';
    if (!name) return 0;
    const info = _db.prepare('DELETE FROM auth_sessions WHERE username = ?').run(name);
    return Number(info.changes);
  },

  /**
   * Delete expired sessions.
   *
   * `resolve` already deletes an expired row when it meets one, so this exists
   * only for the rows nobody comes back for — a browser closed for good leaves a
   * row that is never resolved again. Called at boot rather than on a timer
   * because those two facts are sufficient: the reaping that matters happens on
   * the read path, and what is left is a handful of rows in a tiny table. An
   * always-on install that never restarts accumulates them slowly; if that ever
   * matters, a periodic sweep is the ordinary answer and nothing here forbids
   * one.
   *
   * @param {number} [now] - Epoch ms; injectable for tests
   * @returns {number} - How many were removed
   */
  sweepExpired(now) {
    const at = typeof now === 'number' ? now : Date.now();
    const info = _db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(at);
    const n = Number(info.changes);
    if (n > 0) log.info('Expired sessions swept', { count: n });
    return n;
  },


  /**
   * Whether any account exists, and whether any can be logged into — the two
   * facts the gate's state classifier needs, in one query.
   *
   * Two facts, because they lead to opposite doors: no account at all offers
   * the first-account screen, while accounts that are all disabled must NOT
   * offer it — creating a new account there would be a way around the ones that
   * exist. "Loginable" means ENABLED: an install whose only account is disabled
   * has no key to its own door, and `lib/auth-gate.js` calls that `locked`.
   *
   * @returns {{ exists: boolean, loginable: boolean }}
   */
  accountPresence() {
    const row = _db.prepare(
      'SELECT EXISTS(SELECT 1 FROM users) AS present, '
      + 'EXISTS(SELECT 1 FROM users WHERE disabled_at IS NULL) AS enabled'
    ).get();
    return { exists: row.present === 1, loginable: row.enabled === 1 };
  }
};

// One-time recovery codes (#1420, ADR 0016 "The ruling").
//
// Like `auth_sessions`, the code never reaches the table: every verb takes a
// code as typed, normalises it (`lib/recovery-codes.js#normalizeCode`) and
// works only with its digest. A code that cannot be one is refused before any
// query runs.
//
// Nothing here decides who may redeem — the route does. What this layer
// guarantees is that a code is worth one password reset for one ENABLED
// account, exactly once, even against a concurrent redemption of the same code.

/**
 * The unused code row a typed code names, for an enabled account, or null.
 *
 * ONE query for every failure: an unknown code, a used code and a disabled
 * account's code all find no row, so none of them can be told apart by answer
 * or by the work done to reach it.
 *
 * @param {string} canonical - A normalised code
 * @returns {{ id: number, user_id: number, username: string }|null}
 */
function _unusedCodeRow(canonical) {
  return _db.prepare(
    'SELECT rc.id, rc.user_id, u.username FROM recovery_codes rc '
    + 'JOIN users u ON u.id = rc.user_id '
    + 'WHERE rc.code_hash = ? AND rc.used_at IS NULL AND u.disabled_at IS NULL'
  ).get(recoveryCodes.hashCode(canonical)) || null;
}

const recoveryCodesApi = {
  /**
   * Replace an account's recovery codes with a fresh set, and return the codes.
   *
   * The old set — used and unused — is deleted in the same transaction, so there
   * is no moment when both sets work, and no moment when neither exists for a
   * caller that then fails. The returned codes are the only copy that will ever
   * exist; the caller shows them once.
   *
   * Refuses a disabled or unknown account: codes for an account that cannot sign
   * in would be a key to nothing, until the day it is re-enabled.
   *
   * @param {number} userId
   * @param {number} [now] - Epoch ms; injectable for tests
   * @returns {string[]} Canonical codes
   * @throws {Error} `code: 'NO_SUCH_ACCOUNT'` for an unknown or disabled account
   */
  replaceForUser(userId, now) {
    const at = typeof now === 'number' ? now : Date.now();
    const codes = recoveryCodes.generateSet();
    _db.exec('BEGIN IMMEDIATE');
    let username;
    try {
      const user = _db.prepare('SELECT username FROM users WHERE id = ? AND disabled_at IS NULL')
        .get(userId);
      if (!user) {
        const err = new Error('no enabled account with that id');
        err.code = 'NO_SUCH_ACCOUNT';
        throw err;
      }
      username = user.username;
      _db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
      const insert = _db.prepare(
        'INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)'
      );
      for (const code of codes) insert.run(userId, recoveryCodes.hashCode(code), at);
      _db.exec('COMMIT');
    } catch (err) {
      _db.exec('ROLLBACK');
      throw err;
    }
    // Warn: a new set is a new way past this account's password, and the
    // operator reading the log must be able to see when one was minted.
    log.warn('Recovery codes generated', { username, count: codes.length });
    return codes;
  },

  /**
   * Which account an unused code belongs to, WITHOUT using it.
   *
   * The route needs the username before it can apply the password policy (which
   * refuses a password containing it) and before it hashes the new password,
   * which must happen outside the write transaction. {@link recoveryCodesApi.redeem}
   * re-checks under the lock, so a code used in between still fails there.
   *
   * @param {string} typed - The code as the person typed it
   * @returns {{ userId: number, username: string }|null}
   */
  peek(typed) {
    const canonical = recoveryCodes.normalizeCode(typed);
    if (!canonical) return null;
    const row = _unusedCodeRow(canonical);
    return row ? { userId: row.user_id, username: row.username } : null;
  },

  /**
   * Use a code: mark it used, replace the account's password, and end every
   * session the account holds — atomically.
   *
   * The password arrives already HASHED so no scrypt derivation runs while
   * SQLite's write lock is held. Under the lock the code is looked up again, so
   * two concurrent redemptions of one code cannot both succeed: the second finds
   * it used and gets null, the same answer as a wrong code.
   *
   * Sessions are destroyed for the reason `users.setPassword` gives: a reset that
   * leaves a thief's session alive has recovered nothing.
   *
   * @param {string} typed - The code as the person typed it
   * @param {string} passwordHash - scrypt `salt:hash` of the new password
   * @param {string} from - Where the redemption came from, for the notice and log
   * @param {number} [now] - Epoch ms; injectable for tests
   * @returns {{ id: number, username: string, remaining: number }|null}
   */
  redeem(typed, passwordHash, from, now) {
    const canonical = recoveryCodes.normalizeCode(typed);
    if (!canonical) return null;
    if (typeof passwordHash !== 'string' || !passwordHash) throw new Error('passwordHash is required');
    const at = typeof now === 'number' ? now : Date.now();
    _db.exec('BEGIN IMMEDIATE');
    let row;
    let killed;
    let remaining;
    try {
      row = _unusedCodeRow(canonical);
      if (!row) {
        _db.exec('ROLLBACK');
        return null;
      }
      _db.prepare('UPDATE recovery_codes SET used_at = ?, used_from = ? WHERE id = ?')
        .run(at, typeof from === 'string' ? from.slice(0, 200) : null, row.id);
      _db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, row.user_id);
      killed = Number(_db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(row.user_id).changes);
      remaining = _db.prepare(
        'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL'
      ).get(row.user_id).n;
      _db.exec('COMMIT');
    } catch (err) {
      _db.exec('ROLLBACK');
      throw err;
    }
    log.warn('Recovery code used — password reset', {
      username: row.username, from, sessionsDestroyed: killed, remaining
    });
    return { id: row.user_id, username: row.username, remaining };
  },

  /**
   * Delete every recovery code an account holds, used rows included.
   *
   * The revocation half of {@link recoveryCodesApi.replaceForUser}: for an
   * account that is being disabled, re-enabled, or reset from the terminal,
   * where no new set should exist until the account's owner signs in and asks
   * for one.
   *
   * @param {string} username
   * @returns {number} How many rows were deleted (0 for an unknown account)
   */
  deleteForUsername(username) {
    const name = typeof username === 'string' ? username.trim() : '';
    if (!name) return 0;
    const deleted = Number(_db.prepare(
      'DELETE FROM recovery_codes WHERE user_id = (SELECT id FROM users WHERE username = ?)'
    ).run(name).changes);
    if (deleted > 0) log.warn('Recovery codes deleted', { username: name, count: deleted });
    return deleted;
  },

  /**
   * How many unused codes an account holds, and when its set was generated.
   * @param {number} userId
   * @returns {{ remaining: number, total: number, generatedAt: number|null }}
   */
  status(userId) {
    const row = _db.prepare(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS remaining, '
      + 'MAX(created_at) AS generatedAt FROM recovery_codes WHERE user_id = ?'
    ).get(userId);
    return {
      remaining: Number(row.remaining || 0),
      total: Number(row.total || 0),
      generatedAt: row.generatedAt === null || row.generatedAt === undefined ? null : Number(row.generatedAt)
    };
  },

  /**
   * The redemptions an account has not acknowledged yet, newest first, or null.
   * @param {number} userId
   * @returns {{ redemptions: Array<{ usedAt: number, from: string|null }>, remaining: number }|null}
   */
  pendingNotice(userId) {
    const rows = _db.prepare(
      'SELECT used_at, used_from FROM recovery_codes '
      + 'WHERE user_id = ? AND used_at IS NOT NULL AND notice_cleared_at IS NULL '
      + 'ORDER BY used_at DESC'
    ).all(userId);
    if (rows.length === 0) return null;
    return {
      redemptions: rows.map((r) => ({ usedAt: Number(r.used_at), from: r.used_from })),
      remaining: recoveryCodesApi.status(userId).remaining
    };
  },

  /**
   * Acknowledge every pending redemption notice for an account.
   * @param {number} userId
   * @param {number} [now] - Epoch ms; injectable for tests
   * @returns {number} How many were cleared
   */
  clearNotice(userId, now) {
    const at = typeof now === 'number' ? now : Date.now();
    return Number(_db.prepare(
      'UPDATE recovery_codes SET notice_cleared_at = ? '
      + 'WHERE user_id = ? AND used_at IS NOT NULL AND notice_cleared_at IS NULL'
    ).run(at, userId).changes);
  }
};

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
   * Answers `''` for a document that is missing, unreadable or genuinely
   * empty alike. A caller that must tell those apart — anything that hashes
   * the result — wants `loadMeasured()` instead.
   *
   * @returns {string}
   */
  load() {
    return this.loadMeasured().text;
  },

  /**
   * Load the global rules, saying whether the document could actually be read.
   *
   * `load()` answers `''` for a document that is missing, unreadable AND
   * genuinely empty, because a string has nowhere to put that distinction. A
   * caller that HASHES the result cannot afford the conflation: hashing `''`
   * mints a real-looking hash for a measurement nobody took, so an unreadable
   * file compares equal to itself across two launches and is reported as
   * unchanged, while an unreadable file on ONE side reports a change nobody
   * made. This is the same treatment `_fileHash` already gives shared
   * documents — null is not a hash — expressed where the path lives so no
   * caller has to know it.
   *
   * One read, not a readability probe followed by a load: two reads can
   * disagree, and the second would be the one whose result is kept.
   *
   * @returns {{text: string, measured: boolean}} `measured` is false when the
   *   document could not be read; `text` is then `''` and must not be hashed.
   */
  loadMeasured() {
    _maybeWarnLegacyGlobalRulesFile();
    try {
      if (!fs.existsSync(BUNDLED_GLOBAL_RULES)) {
        log.warn('canonical global-rules file missing', { path: BUNDLED_GLOBAL_RULES });
        return { text: '', measured: false };
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
      return { text: normalized, measured: true };
    } catch (err) {
      log.warn('Failed to read global rules', { path: BUNDLED_GLOBAL_RULES, error: err.message });
      return { text: '', measured: false };
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
    _startupControlTransaction(() => {
      _db.prepare('DELETE FROM project_group_members WHERE group_id = ? AND project_id = ?')
        .run(groupId, projectId);
      // A project that leaves a group leaves its notice settings there too,
      // for the group and for every doc in it (#2389).
      _db.prepare(
        `DELETE FROM shared_doc_notice_prefs WHERE project_id = ?
           AND (group_id = ? OR doc_id IN (SELECT id FROM shared_documents WHERE group_id = ?))`
      ).run(projectId, groupId, groupId);
    });
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
   * Every shared document reachable from a project, through its groups.
   *
   * One traversal, because two readers must agree: the launch's source manifest
   * hashes this set, and the governance launch step lists it. A manifest that
   * hashed a different set than the step served could not answer the question
   * it exists for — did a source change under this snapshot.
   * @param {number} projectId - Project id
   * @returns {object[]} Documents, in group order then name order
   */
  listForProject(projectId) {
    _ensureDb();
    return projectGroupsApi.getByProject(projectId)
      .flatMap((group) => sharedDocsApi.list({ groupId: group.id }));
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
   * Release a lock on behalf of a session, only when that session holds it
   * or the lock has expired. The condition and the delete are one statement,
   * so a lock taken by another session between a check and a delete can
   * never be removed by this call.
   * @param {string} docId - Document id
   * @param {number} sessionId - The caller's verified session id
   * @returns {{released: boolean, holder: object|null}} - `holder` is the
   *   live lock left standing when the release was refused, else null
   */
  releaseHeld(docId, sessionId) {
    _ensureDb();
    const now = new Date().toISOString();
    const result = _db.prepare(
      `DELETE FROM document_locks
        WHERE document_id = ?
          AND (locked_by_session = ? OR (expires_at IS NOT NULL AND expires_at <= ?))`
    ).run(docId, sessionId, now);
    if (result.changes > 0) {
      activityApi.log({ eventType: 'doc_lock.released', sessionId, detail: { docId } });
      return { released: true, holder: null };
    }
    return { released: false, holder: documentLocksApi.check(docId) };
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
 * Coerce a stored `tags` value to `string[]`. Rows written before the create
 * route validated the shape can hold a JSON string, and every consumer (card,
 * settings modal, tag filter, API) assumes an array. A string is split on
 * commas the way the create form's field is; anything else keeps only its
 * string members, or is empty.
 * @param {*} tags - The parsed column value
 * @returns {string[]}
 */
function _normalizeTags(tags) {
  if (typeof tags === 'string') {
    return tags.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (!Array.isArray(tags)) return [];
  return tags.filter((t) => typeof t === 'string');
}

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
    tags: _normalizeTags(_jsonParse(row.tags, [])),
    ports: _jsonParse(row.ports, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: !!row.archived,
    migrationStatus: row.migration_status || null,
    orchestrationProfile: row.orchestration_profile || null
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
    reach: row.reach || 'loopback',
    ownerKind: row.owner_kind || 'project',
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
 * Whether this install shows any sign it has been used: a project (archived
 * included), a session or a user account exists, or a project was ever deleted.
 * The last matters because deleting a project also deletes its sessions, so an
 * install whose operator removed every project would otherwise look unused; the
 * `project.deleted` activity row is written only by that delete, never at boot.
 *
 * lib/bind-policy.js asks this to tell a legacy install that was bound to every
 * interface — whose operator may be reaching it remotely right now — from a fresh
 * install whose config was written by hand before the first boot. Only the first
 * is held in the wide grace state. Port leases are deliberately not evidence:
 * boot records leases for TangleClaw's own ports before this is asked.
 *
 * @returns {boolean} True when any such row exists, and also when the store
 *   cannot answer — a wrong "unused" would close the door on a remote operator,
 *   so an unanswerable question keeps the legacy behavior.
 */
function hasPriorUse() {
  try {
    _ensureDb();
    const row = _db.prepare(
      'SELECT EXISTS (SELECT 1 FROM projects) OR EXISTS (SELECT 1 FROM sessions) '
      + 'OR EXISTS (SELECT 1 FROM users) '
      + "OR EXISTS (SELECT 1 FROM activity_log WHERE event_type = 'project.deleted') AS used"
    ).get();
    return row.used === 1;
  } catch (err) { // prawduct:allow prawduct/broad-except -- any failure (uninitialized store, SQLite error) must fail toward "used", never strand an operator
    log.warn('Could not tell whether this install has been used; treating it as used', { error: err.message });
    return true;
  }
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

/** Projection columns `medusaExchanges.writeProjection` may set. */
const _MEDUSA_EXCHANGE_PROJECTION_COLUMNS = Object.freeze([
  'hub_id', 'recipient_workspace_id', 'state', 'wake_code', 'esc_level', 'rearm_count', 'next_eligible_at',
  'terminal_at', 'terminal_by', 'terminal_code', 'replacement_hub_id', 'updated_at'
]);

/**
 * Medusa delivery watchdog exchanges (#1839): row access only. The rules —
 * validation, projection, guarded terminal transitions — live in
 * `lib/medusa-exchanges.js`, which calls these inside
 * {@link medusaExchangesApi.transaction}.
 */
const medusaExchangesApi = {
  /**
   * Run `fn` inside one `BEGIN IMMEDIATE` transaction and return its result.
   * A fact and the projection it moves are written together, and a terminal
   * transition reads and writes as one decision, so a read and a retract that
   * race cannot both win.
   * @param {() => *} fn - Synchronous work
   * @returns {*} Whatever `fn` returns
   */
  transaction(fn) {
    return _startupControlTransaction(fn);
  },

  /**
   * Insert an exchange row.
   * @param {object} x - Row values (snake_case column names)
   * @returns {void}
   */
  insert(x) {
    _ensureDb();
    _db.prepare(
      'INSERT INTO medusa_exchanges (exchange_id, request_id, hub_id, origin, tracking, sender_project_id, '
      + 'sender_session_id, sender_workspace_id, sender_verified, sender_proof, recipient_workspace_id, '
      + 'recipient_project_id, recipient_session_id, priority, reply_required, escalate_after_ms, reason_code, '
      + 'in_reply_to, created_at, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(x.exchange_id, x.request_id, x.hub_id ?? null, x.origin, x.tracking, x.sender_project_id ?? null,
      x.sender_session_id ?? null, x.sender_workspace_id ?? null, x.sender_verified ? 1 : 0, x.sender_proof ?? null,
      x.recipient_workspace_id, x.recipient_project_id ?? null, x.recipient_session_id ?? null, x.priority,
      x.reply_required ? 1 : 0, x.escalate_after_ms ?? null, x.reason_code ?? null, x.in_reply_to ?? null,
      x.created_at, x.state, x.created_at);
  },

  /**
   * One exchange by id.
   * @param {string} exchangeId - Exchange id
   * @returns {object|null} The raw row
   */
  get(exchangeId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM medusa_exchanges WHERE exchange_id = ?').get(exchangeId) || null;
  },

  /**
   * The exchange of one origin a Hub message id names, if any.
   * @param {string} hubId - Hub message id
   * @param {'send'|'arrival'} origin - Which side recorded it
   * @returns {object|null} The raw row
   */
  getByHubId(hubId, origin) {
    _ensureDb();
    return _db.prepare('SELECT * FROM medusa_exchanges WHERE hub_id = ? AND origin = ?').get(hubId, origin) || null;
  },

  /**
   * The exchange a send's idempotency key created, if any.
   * @param {string} requestId - Request id
   * @returns {object|null} The raw row
   */
  getByRequestId(requestId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM medusa_exchanges WHERE request_id = ?').get(requestId) || null;
  },

  /**
   * Append one fact.
   * @param {{exchange_id: string, fact: string, code?: string|null, actor?: string|null, proof?: string|null, detail_json?: string|null, at: string}} f
   * @returns {number} The fact's `fact_seq`
   */
  appendFact(f) {
    _ensureDb();
    const info = _db.prepare(
      'INSERT INTO medusa_exchange_facts (exchange_id, fact, code, actor, proof, detail_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(f.exchange_id, f.fact, f.code ?? null, f.actor ?? null, f.proof ?? null, f.detail_json ?? null, f.at);
    return Number(info.lastInsertRowid);
  },

  /**
   * Every fact of an exchange, oldest first.
   * @param {string} exchangeId - Exchange id
   * @returns {object[]} Raw fact rows
   */
  facts(exchangeId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM medusa_exchange_facts WHERE exchange_id = ? ORDER BY fact_seq').all(exchangeId);
  },

  /**
   * Rewrite an exchange's projection columns.
   * @param {string} exchangeId - Exchange id
   * @param {object} proj - Projection values keyed by column name
   * @returns {void}
   * @throws {Error} When `proj` names a column that is not part of the projection.
   */
  writeProjection(exchangeId, proj) {
    _ensureDb();
    const cols = Object.keys(proj);
    for (const c of cols) {
      if (!_MEDUSA_EXCHANGE_PROJECTION_COLUMNS.includes(c)) throw new Error(`not a projection column: ${c}`);
    }
    if (cols.length === 0) return;
    _db.prepare(`UPDATE medusa_exchanges SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE exchange_id = ?`)
      .run(...cols.map((c) => proj[c] ?? null), exchangeId);
  },

  /**
   * Tracked exchanges with no terminal outcome, oldest first: the watchdog's
   * whole working set.
   * @returns {object[]} Raw rows
   */
  listOpen() {
    _ensureDb();
    return _db.prepare(
      "SELECT * FROM medusa_exchanges WHERE terminal_at IS NULL AND tracking = 'tracked' ORDER BY created_at, exchange_id"
    ).all();
  },

  /**
   * Open tracked exchanges addressed to a recipient workspace.
   *
   * `hubBoundOnly` leaves out a send whose Hub outcome was never bound: one
   * still `send_pending` or `send_unknown`. Its message id never reached this
   * host, so the recipient can never read or acknowledge it (acknowledgement
   * binds by Hub id), and a reader asking what the recipient owes wants it
   * excluded. The state is read rather than `hub_id`, because the projection
   * re-derives `hub_id` from the facts. The default keeps such rows, because
   * the retired-recipient sweep must still end them.
   * @param {string} workspaceId - Recipient workspace id
   * @param {{hubBoundOnly?: boolean}} [opts]
   * @returns {object[]} Raw rows
   */
  listOpenForRecipient(workspaceId, { hubBoundOnly = false } = {}) {
    _ensureDb();
    return _db.prepare(
      "SELECT * FROM medusa_exchanges WHERE recipient_workspace_id = ? AND terminal_at IS NULL AND tracking = 'tracked' "
      + (hubBoundOnly ? "AND state NOT IN ('send_pending', 'send_unknown') " : '')
      + 'ORDER BY created_at, exchange_id'
    ).all(workspaceId);
  },

  /**
   * Open tracked exchanges one session started. A project can have several
   * sessions over time, so the project-level listing cannot say which of them is
   * still waiting on an answer; finalization needs exactly this session's.
   * @param {number|string} sessionId - Sender session id
   * @returns {object[]} Raw rows, oldest first
   */
  listOpenForSenderSession(sessionId) {
    _ensureDb();
    return _db.prepare(
      "SELECT * FROM medusa_exchanges WHERE sender_session_id = ? AND terminal_at IS NULL AND tracking = 'tracked' "
      + 'ORDER BY created_at, exchange_id'
    ).all(String(sessionId));
  },

  /**
   * A sender project's exchanges, newest first.
   * @param {number} projectId - Sender project id
   * @param {{openOnly?: boolean, limit?: number}} [opts]
   * @returns {object[]} Raw rows
   */
  listForSender(projectId, opts = {}) {
    _ensureDb();
    const open = opts.openOnly ? ' AND terminal_at IS NULL' : '';
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 200) : 50;
    return _db.prepare(
      `SELECT * FROM medusa_exchanges WHERE sender_project_id = ? AND origin = 'send'${open} ORDER BY created_at DESC, exchange_id LIMIT ?`
    ).all(projectId, limit);
  },

  /**
   * A recipient workspace's exchanges, newest first.
   * @param {string} workspaceId - Recipient workspace id
   * @param {{openOnly?: boolean, limit?: number}} [opts]
   * @returns {object[]} Raw rows
   */
  listForRecipient(workspaceId, opts = {}) {
    _ensureDb();
    const open = opts.openOnly ? ' AND terminal_at IS NULL' : '';
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 200) : 50;
    return _db.prepare(
      `SELECT * FROM medusa_exchanges WHERE recipient_workspace_id = ?${open} ORDER BY created_at DESC, exchange_id LIMIT ?`
    ).all(workspaceId, limit);
  },

  /**
   * Open tracked exchanges that have climbed the escalation ladder, oldest first.
   * @returns {object[]} Raw rows
   */
  listEscalated() {
    _ensureDb();
    return _db.prepare(
      "SELECT * FROM medusa_exchanges WHERE terminal_at IS NULL AND tracking = 'tracked' AND esc_level != 'none' "
      + 'ORDER BY created_at, exchange_id'
    ).all();
  },

  /**
   * How many open blocking exchanges a sender project has.
   * @param {number} projectId - Sender project id
   * @returns {number}
   */
  countOpenBlockingForSender(projectId) {
    _ensureDb();
    return _db.prepare(
      "SELECT COUNT(*) AS n FROM medusa_exchanges WHERE sender_project_id = ? AND priority = 'blocking' "
      + "AND terminal_at IS NULL AND tracking = 'tracked'"
    ).get(projectId).n;
  }
};

/** How long a workload append waits before its one retry. */
const WORKLOAD_RETRY_WAIT_MS = 50;

/**
 * Whether a workload append failed in a way one retry can fix: the database
 * was locked by another connection, or another writer took the same
 * `(launch_id, seq)` first.
 * @param {Error} err - What the attempt threw
 * @returns {boolean}
 */
function _isWorkloadRetryable(err) {
  const msg = String(err && err.message);
  return /database is locked|SQLITE_BUSY/i.test(msg)
    || /UNIQUE constraint failed: workload_receipts\.launch_id, workload_receipts\.seq/.test(msg);
}

/**
 * Workload receipts (#1912, ADR 0020). Rows are appended by
 * `lib/workload.js` only, after it has verified the caller's launch and
 * stamped every identity and time field; nothing here trusts a caller.
 */
const workloadReceiptsApi = {
  /**
   * Append one receipt for a launch, allocating its `seq` inside the same
   * `BEGIN IMMEDIATE` transaction as the insert, so two concurrent writes can
   * never share or reorder a number. The rate limit is checked in the same
   * transaction against the launch's newest receipt.
   * @param {object} row - Stamped values (snake_case), without `seq`
   * @param {{minIntervalMs: number, nowMs: number}} limit - The per-lane rate limit and the server clock
   * @returns {{row: object}|{rateLimited: true, retryAfterMs: number}|{busy: true}} `busy` when the
   *   write lost a lock or seq race twice
   */
  append(row, limit) {
    _ensureDb();
    try {
      return this._appendOnce(row, limit);
    } catch (err) {
      if (!_isWorkloadRetryable(err)) throw err;
      // Another connection held the write lock, or took this seq between our
      // read and insert. Wait briefly and retry once (ADR 0020 §2); a second
      // failure is surfaced as busy rather than guessed around.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WORKLOAD_RETRY_WAIT_MS);
      try {
        return this._appendOnce(row, limit);
      } catch (again) {
        if (_isWorkloadRetryable(again)) return { busy: true };
        throw again;
      }
    }
  },

  /**
   * One attempt of {@link workloadReceiptsApi.append}: the rate check, the seq
   * allocation and the insert in one `BEGIN IMMEDIATE` transaction.
   * @param {object} row - Stamped values (snake_case), without `seq`
   * @param {{minIntervalMs: number, nowMs: number}} limit - The rate limit and the server clock
   * @returns {{row: object}|{rateLimited: true, retryAfterMs: number}}
   */
  _appendOnce(row, limit) {
    return _startupControlTransaction(() => {
      const last = _db.prepare(
        'SELECT seq, received_at FROM workload_receipts WHERE launch_id = ? ORDER BY seq DESC LIMIT 1'
      ).get(row.launch_id);
      if (last) {
        const elapsed = limit.nowMs - Date.parse(last.received_at);
        // A negative interval means the clock stepped back since the last
        // receipt. That is not a burst, and treating it as one would lock the
        // lane out for as long as the step, so it is let through.
        if (elapsed >= 0 && elapsed < limit.minIntervalMs) {
          return { rateLimited: true, retryAfterMs: limit.minIntervalMs - elapsed };
        }
      }
      const seq = last ? last.seq + 1 : 1;
      const info = _db.prepare(
        'INSERT INTO workload_receipts (project_id, session_id, launch_id, assignment_id, seq, state, clearance, '
        + 'summary, wait_kind, wait_detail, refs_json, branch, head_sha, source, received_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(row.project_id, row.session_id, row.launch_id, row.assignment_id ?? null, seq, row.state,
        row.clearance, row.summary, row.wait_kind ?? null, row.wait_detail ?? null, row.refs_json,
        row.branch ?? null, row.head_sha ?? null, row.source, row.received_at);
      return { row: _db.prepare('SELECT * FROM workload_receipts WHERE receipt_id = ?').get(info.lastInsertRowid) };
    });
  },

  /**
   * The newest receipt a launch wrote, whether or not it is still current.
   * @param {string} launchId - The launch
   * @returns {object|null}
   */
  latestForLaunch(launchId) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM workload_receipts WHERE launch_id = ? ORDER BY seq DESC LIMIT 1'
    ).get(launchId) || null;
  },

  /**
   * Every receipt a launch wrote, oldest first.
   * @param {string} launchId - The launch
   * @returns {object[]}
   */
  listForLaunch(launchId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM workload_receipts WHERE launch_id = ? ORDER BY seq').all(launchId);
  },

  /**
   * Append an operator narrowing or clear for a launch (ADR 0020 §7).
   * @param {object} row - `project_id`, `session_id`, `launch_id`, `action`, `cap_clearance`,
   *   `force_unknown`, `reason`, `operator_proof`, `created_at`
   * @returns {object} The stored row
   */
  appendNarrowing(row) {
    _ensureDb();
    const info = _db.prepare(
      'INSERT INTO workload_narrowings (project_id, session_id, launch_id, action, cap_clearance, force_unknown, '
      + 'reason, operator_proof, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(row.project_id, row.session_id, row.launch_id, row.action, row.cap_clearance ? 1 : 0,
      row.force_unknown ? 1 : 0, row.reason, row.operator_proof, row.created_at);
    return _db.prepare('SELECT * FROM workload_narrowings WHERE narrowing_id = ?').get(info.lastInsertRowid);
  },

  /**
   * The narrowing in force for a launch: its newest row, unless that row is a clear.
   * @param {string} launchId - The launch
   * @returns {object|null}
   */
  activeNarrowing(launchId) {
    _ensureDb();
    const row = _db.prepare(
      'SELECT * FROM workload_narrowings WHERE launch_id = ? ORDER BY narrowing_id DESC LIMIT 1'
    ).get(launchId);
    return row && row.action === 'narrow' ? row : null;
  }
};

/**
 * Workload nudge facts (#2262): row access only. What counts as a nudge or an
 * escalation, and when one is due, is the monitor's to decide; this records
 * what it reports and reads it back.
 */
const workloadNudgeFactsApi = {
  /**
   * Record one fact about an expired receipt, once. A fact already on record
   * for the same receipt, kind and route is left as it is and returned, so a
   * second tick or a second server process can ask without checking first.
   * Any other refusal by the table (an unknown kind, a route on a `nudged`
   * fact) throws: only the uniqueness conflict is the expected answer.
   * @param {object} row - `project_id`, `session_id`, `launch_id`, `receipt_id`, `kind`, `code`,
   *   `created_at`, and optionally `route`, `target_project_id`, `engine_activity`,
   *   `engine_reason`, `detail_json`
   * @returns {{recorded: boolean, row: object}} `recorded` is whether this call wrote the row
   */
  record(row) {
    return _startupControlTransaction(() => {
      const info = _db.prepare(
        'INSERT INTO workload_nudge_facts (project_id, session_id, launch_id, receipt_id, kind, route, '
        + 'target_project_id, code, engine_activity, engine_reason, detail_json, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
      ).run(row.project_id, row.session_id, row.launch_id, row.receipt_id, row.kind, row.route ?? null,
        row.target_project_id ?? null, row.code, row.engine_activity ?? null, row.engine_reason ?? null,
        row.detail_json ?? null, row.created_at);
      if (Number(info.changes) === 1) {
        return {
          recorded: true,
          row: _db.prepare('SELECT * FROM workload_nudge_facts WHERE fact_id = ?').get(info.lastInsertRowid)
        };
      }
      return {
        recorded: false,
        row: _db.prepare(
          "SELECT * FROM workload_nudge_facts WHERE receipt_id = ? AND kind = ? AND COALESCE(route, '') = ?"
        ).get(row.receipt_id, row.kind, row.route ?? '')
      };
    });
  },

  /**
   * Every fact recorded against one receipt, oldest first.
   * @param {number} receiptId - The expired receipt
   * @returns {object[]}
   */
  listForReceipt(receiptId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM workload_nudge_facts WHERE receipt_id = ? ORDER BY fact_id').all(receiptId);
  },

  /**
   * One page of the escalations recorded on the operator route since a time,
   * oldest first by `(created_at, fact_id)`. A page never hides that it was
   * cut short: `more` says rows remain, and passing the last row back as
   * `after` reads on from it, so a caller that wants them all can have them.
   * @param {object} query
   * @param {string} query.since - Earliest `created_at` returned (inclusive)
   * @param {{createdAt: string, factId: number}} [query.after] - The last row of the page before
   * @param {number} [query.limit] - Most rows in one page, 1 to 500
   * @returns {{rows: object[], more: boolean}}
   */
  listOperatorEscalations({ since, after = null, limit = 200 }) {
    _ensureDb();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error(`limit must be an integer from 1 to 500, got ${limit}`);
    const from = after
      ? 'AND (created_at > ? OR (created_at = ? AND fact_id > ?)) '
      : '';
    const args = after ? [since, after.createdAt, after.createdAt, after.factId] : [since];
    const rows = _db.prepare(
      "SELECT * FROM workload_nudge_facts WHERE kind = 'escalated' AND route = 'operator' AND created_at >= ? "
      + `${from}ORDER BY created_at, fact_id LIMIT ?`
    ).all(...args, limit + 1);
    return { rows: rows.slice(0, limit), more: rows.length > limit };
  }
};

/**
 * Durable HOLD/STOP control state (#1861): row access only. The rules — who
 * may do what, generations, idempotency — live in `lib/control-state.js`,
 * which calls these inside {@link controlApi.transaction}.
 */
const controlApi = {
  /**
   * Run `fn` inside one `BEGIN IMMEDIATE` transaction and return its result.
   * Every control command reads the current generation and writes the next
   * one as one decision; this is what keeps two issuers from both believing
   * they are newest. Shares the startupControl tables' wrapper.
   * @param {() => *} fn - Synchronous work
   * @returns {*} Whatever `fn` returns
   */
  transaction(fn) {
    return _startupControlTransaction(fn);
  },

  /**
   * Insert an assignment row.
   * @param {object} a - Row values (snake_case column names)
   * @returns {void}
   */
  insertAssignment(a) {
    _ensureDb();
    _db.prepare(
      'INSERT INTO control_assignments (assignment_id, project_id, issue_ref, authority_json, bound_session_id, '
      + 'bound_launch_id, state, state_generation, created_by_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(a.assignment_id, a.project_id, a.issue_ref ?? null, a.authority_json, a.bound_session_id ?? null,
      a.bound_launch_id ?? null, a.state, a.state_generation, a.created_by_kind);
  },

  /**
   * One assignment by id.
   * @param {string} assignmentId - Assignment id
   * @returns {object|null} The raw row
   */
  getAssignment(assignmentId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM control_assignments WHERE assignment_id = ?').get(assignmentId) || null;
  },

  /**
   * The project's open (not closed) assignment, if any.
   * @param {number} projectId - Project id
   * @returns {object|null} The raw row
   */
  getOpenForProject(projectId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM control_assignments WHERE project_id = ? AND closed_at IS NULL').get(projectId) || null;
  },

  /**
   * Every open assignment.
   * @returns {object[]} Raw rows
   */
  listOpen() {
    _ensureDb();
    return _db.prepare('SELECT * FROM control_assignments WHERE closed_at IS NULL ORDER BY created_at').all();
  },

  /**
   * Whether any open assignment is held or stopped.
   * @returns {boolean}
   */
  anyRestricted() {
    _ensureDb();
    return !!_db.prepare("SELECT 1 FROM control_assignments WHERE closed_at IS NULL AND state IN ('held','stopped') LIMIT 1").get();
  },

  /**
   * Rewrite an assignment's state cache.
   * @param {string} assignmentId - Assignment id
   * @param {{state: string, state_generation: number, stopped_at?: string|null, closed_at?: string|null, superseded_by?: string|null}} fields
   * @returns {void}
   */
  setAssignmentState(assignmentId, fields) {
    _ensureDb();
    _db.prepare(
      'UPDATE control_assignments SET state = ?, state_generation = ?, '
      + "stopped_at = COALESCE(stopped_at, CASE WHEN ? = 'stopped' THEN datetime('now') END), "
      + "closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE closed_at END, "
      + 'superseded_by = COALESCE(?, superseded_by) WHERE assignment_id = ?'
    ).run(fields.state, fields.state_generation, fields.state, fields.state, fields.superseded_by ?? null, assignmentId);
  },

  /**
   * Move an assignment's binding to a session and launch.
   * @param {string} assignmentId - Assignment id
   * @param {number|null} sessionId - Session id
   * @param {string|null} launchId - Launch id
   * @returns {void}
   */
  setBinding(assignmentId, sessionId, launchId) {
    _ensureDb();
    _db.prepare('UPDATE control_assignments SET bound_session_id = ?, bound_launch_id = ? WHERE assignment_id = ?')
      .run(sessionId, launchId, assignmentId);
  },

  /**
   * Append a state event.
   * @param {object} e - Row values (snake_case column names)
   * @returns {number} The event's audit `seq`
   */
  insertEvent(e) {
    _ensureDb();
    const r = _db.prepare(
      'INSERT INTO control_events (event_id, assignment_id, kind, state_generation, issuer_principal, operator_proof, '
      + 'reason_code, request_id, expected_generation, target_hold_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(e.event_id, e.assignment_id, e.kind, e.state_generation, e.issuer_principal, e.operator_proof ?? null,
      e.reason_code, e.request_id, e.expected_generation ?? null, e.target_hold_ids_json ?? null);
    return Number(r.lastInsertRowid);
  },

  /**
   * The event a request id already produced on an assignment, if any.
   * @param {string} assignmentId - Assignment id
   * @param {string} requestId - Idempotency key
   * @returns {object|null} The raw row
   */
  getEventByRequest(assignmentId, requestId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM control_events WHERE assignment_id = ? AND request_id = ?').get(assignmentId, requestId) || null;
  },

  /**
   * The create event a request id already produced, if any.
   * @param {string} requestId - Idempotency key
   * @returns {object|null} The raw row
   */
  getCreateByRequest(requestId) {
    _ensureDb();
    return _db.prepare("SELECT * FROM control_events WHERE kind = 'create' AND request_id = ?").get(requestId) || null;
  },

  /**
   * One event by id.
   * @param {string} eventId - Event id
   * @returns {object|null} The raw row
   */
  getEvent(eventId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM control_events WHERE event_id = ?').get(eventId) || null;
  },

  /**
   * An assignment's events in audit order.
   * @param {string} assignmentId - Assignment id
   * @returns {object[]} Raw rows
   */
  listEvents(assignmentId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM control_events WHERE assignment_id = ? ORDER BY seq').all(assignmentId);
  },

  /**
   * The newest state-changing event (create, hold, release, stop) of an assignment.
   * @param {string} assignmentId - Assignment id
   * @returns {object|null} The raw row
   */
  latestStateEvent(assignmentId) {
    _ensureDb();
    return _db.prepare(
      "SELECT * FROM control_events WHERE assignment_id = ? AND kind IN ('create','hold','release','stop') ORDER BY seq DESC LIMIT 1"
    ).get(assignmentId) || null;
  },

  /**
   * Open a hold.
   * @param {{hold_id: string, assignment_id: string, issuer_principal: string, opened_generation: number}} h
   * @returns {void}
   */
  insertHold(h) {
    _ensureDb();
    _db.prepare('INSERT INTO control_holds (hold_id, assignment_id, issuer_principal, opened_generation) VALUES (?, ?, ?, ?)')
      .run(h.hold_id, h.assignment_id, h.issuer_principal, h.opened_generation);
  },

  /**
   * Mark holds released.
   * @param {string[]} holdIds - Hold ids
   * @param {number} generation - The generation the release produced
   * @param {string} eventId - The release event
   * @returns {void}
   */
  releaseHolds(holdIds, generation, eventId) {
    _ensureDb();
    const stmt = _db.prepare('UPDATE control_holds SET released_generation = ?, released_by_event_id = ? WHERE hold_id = ? AND released_generation IS NULL');
    for (const id of holdIds) stmt.run(generation, eventId, id);
  },

  /**
   * An assignment's holds, active first.
   * @param {string} assignmentId - Assignment id
   * @param {{activeOnly?: boolean}} [opts]
   * @returns {object[]} Raw rows
   */
  listHolds(assignmentId, opts = {}) {
    _ensureDb();
    const where = opts.activeOnly ? ' AND released_generation IS NULL' : '';
    return _db.prepare(`SELECT * FROM control_holds WHERE assignment_id = ?${where} ORDER BY opened_generation`).all(assignmentId);
  },

  /**
   * Append a delivery/acknowledgement receipt.
   * @param {{event_id: string, fact: string, outcome_code?: string|null, actor_principal?: string|null, notice_ref?: string|null}} r
   * @returns {number} The receipt's `receipt_seq`
   */
  insertReceipt(r) {
    _ensureDb();
    const out = _db.prepare('INSERT INTO control_receipts (event_id, fact, outcome_code, actor_principal, notice_ref) VALUES (?, ?, ?, ?, ?)')
      .run(r.event_id, r.fact, r.outcome_code ?? null, r.actor_principal ?? null, r.notice_ref ?? null);
    return Number(out.lastInsertRowid);
  },

  /**
   * The notify_attempted receipt that sent a given Medusa notice, if any.
   * @param {string} noticeRef - Medusa message id
   * @returns {object|null} The raw row
   */
  getReceiptByNotice(noticeRef) {
    _ensureDb();
    return _db.prepare("SELECT * FROM control_receipts WHERE notice_ref = ? AND fact = 'notify_attempted' LIMIT 1").get(noticeRef) || null;
  },

  /**
   * The receipts of a set of events, in receipt order.
   * @param {string[]} eventIds - Event ids
   * @returns {object[]} Raw rows
   */
  listReceipts(eventIds) {
    _ensureDb();
    if (!eventIds.length) return [];
    const marks = eventIds.map(() => '?').join(',');
    return _db.prepare(`SELECT * FROM control_receipts WHERE event_id IN (${marks}) ORDER BY receipt_seq`).all(...eventIds);
  },

  /**
   * Whether an event already carries a receipt of this fact.
   * @param {string} eventId - Event id
   * @param {string} fact - Receipt fact
   * @returns {boolean}
   */
  hasReceipt(eventId, fact) {
    _ensureDb();
    return !!_db.prepare('SELECT 1 FROM control_receipts WHERE event_id = ? AND fact = ? LIMIT 1').get(eventId, fact);
  }
};

/**
 * Revisions kept per shared doc: the newest this many, or every revision
 * observed within {@link SHARED_DOC_EVENTS_KEEP_DAYS}, whichever keeps more.
 * @type {number}
 */
const SHARED_DOC_EVENTS_KEEP = 1000;

/** @type {number} Days of shared-doc revisions kept regardless of count. */
const SHARED_DOC_EVENTS_KEEP_DAYS = 30;

/**
 * Convert a `shared_doc_events` row to an app-level revision.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToSharedDocEvent(row) {
  return {
    id: row.id,
    docId: row.doc_id,
    seq: row.seq,
    observedAt: row.observed_at,
    sha256: row.sha256,
    priorSha256: row.prior_sha256,
    authorProjectId: row.author_project_id,
    authorSessionId: row.author_session_id,
    authorSource: row.author_source,
    attestedAt: row.attested_at,
    lockHolderHint: row.lock_holder_hint ? JSON.parse(row.lock_holder_hint) : null,
    classes: JSON.parse(row.classes),
    attribution: row.attribution,
    baseline: row.baseline,
    changedProjectIds: JSON.parse(row.changed_project_ids),
    changedRowCount: row.changed_row_count,
    excerpt: row.excerpt,
    excerptTruncated: row.excerpt_truncated === 1,
    source: row.source,
    routing: row.routing,
    duplicateObservations: row.duplicate_observations,
    shadowWouldSelect: JSON.parse(row.shadow_would_select)
  };
}

/**
 * The shared-document revision record and its baselines (#2389). Every write
 * is synchronous: the caller (`lib/shared-docs.js`) serializes a doc's
 * observations and calls these only after its file read has completed, so the
 * diff, the seq and the record are one step per revision.
 */
const sharedDocEventsApi = {
  /**
   * The baseline a doc's next observation is classified against.
   * @param {string} docId - Shared doc id
   * @returns {{docId: string, sha256: string, content: (string|null), byteLength: number, complete: boolean, observedAt: string}|null}
   */
  getBaseline(docId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM shared_doc_baselines WHERE doc_id = ?').get(docId);
    if (!row) return null;
    return {
      docId: row.doc_id,
      sha256: row.sha256,
      content: row.content,
      byteLength: row.byte_length,
      complete: row.complete === 1,
      observedAt: row.observed_at
    };
  },

  /**
   * A doc's newest revision.
   * @param {string} docId - Shared doc id
   * @returns {object|null}
   */
  latest(docId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM shared_doc_events WHERE doc_id = ? ORDER BY seq DESC LIMIT 1').get(docId);
    return row ? _rowToSharedDocEvent(row) : null;
  },

  /**
   * Record a new revision and make its content the doc's baseline, in one
   * transaction, then apply retention. The seq is allocated here, one past
   * the doc's newest, so it is monotonic per doc whatever the caller passes.
   * @param {object} revision - Fields of the revision (camelCase, as returned)
   * @param {{content: (string|null), byteLength: number}} baseline - The observed content;
   *   `content` null when it is over the baseline cap and only its digest is kept
   * @param {{route?: function(object): Array<object>, onRouted?: function(number[]): void}} [opts] -
   *   `route` is given the recorded revision inside the same transaction and
   *   returns the deliveries it intends (see {@link _applySharedDocRoute}), so a
   *   revision, its author binding (`revision.binding`) and its routing claim
   *   commit together or not at all; `onRouted` receives the ids of the pending
   *   deliveries this call inserted
   * @returns {object} The recorded revision, as routed.
   */
  recordRevision(revision, baseline, opts = {}) {
    return _startupControlTransaction(() => {
      // The baseline carries the last seq allocated, so a seq is never reused
      // even when every revision of the doc has been pruned or removed.
      const top = _db.prepare(
        `SELECT MAX(COALESCE((SELECT MAX(seq) FROM shared_doc_events WHERE doc_id = ?), 0),
                COALESCE((SELECT last_seq FROM shared_doc_baselines WHERE doc_id = ?), 0)) AS seq`
      ).get(revision.docId, revision.docId);
      const seq = top.seq + 1;
      const info = _db.prepare(
        `INSERT INTO shared_doc_events (doc_id, seq, observed_at, sha256, prior_sha256, lock_holder_hint,
           classes, attribution, baseline, changed_project_ids, changed_row_count, excerpt, excerpt_truncated,
           source, shadow_would_select)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        revision.docId, seq, revision.observedAt, revision.sha256, revision.priorSha256 || null,
        revision.lockHolderHint ? JSON.stringify(revision.lockHolderHint) : null,
        JSON.stringify(revision.classes), revision.attribution, revision.baseline,
        JSON.stringify(revision.changedProjectIds), revision.changedRowCount,
        revision.excerpt == null ? null : revision.excerpt, revision.excerptTruncated ? 1 : 0,
        revision.source, JSON.stringify(revision.shadowWouldSelect || [])
      );
      _db.prepare(
        `INSERT INTO shared_doc_baselines (doc_id, sha256, content, byte_length, complete, observed_at, last_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET sha256 = excluded.sha256, content = excluded.content,
           byte_length = excluded.byte_length, complete = excluded.complete, observed_at = excluded.observed_at,
           last_seq = excluded.last_seq`
      ).run(revision.docId, revision.sha256, baseline.content, baseline.byteLength,
        baseline.content == null ? 0 : 1, revision.observedAt, seq);
      _pruneSharedDocEvents(revision.docId, seq, new Date());
      const id = Number(info.lastInsertRowid);
      if (revision.binding) _bindSharedDocAuthor(id, revision.binding);
      if (opts.route) {
        const ids = _applySharedDocRoute(_rowToSharedDocEvent(_db.prepare('SELECT * FROM shared_doc_events WHERE id = ?').get(id)), opts.route);
        if (opts.onRouted) opts.onRouted(ids);
      }
      return _rowToSharedDocEvent(_db.prepare('SELECT * FROM shared_doc_events WHERE id = ?').get(id));
    });
  },

  /**
   * Count one more observation of bytes already recorded as a revision.
   * @param {number} eventId - Revision row id
   * @returns {void}
   */
  recordDuplicate(eventId) {
    _ensureDb();
    _db.prepare('UPDATE shared_doc_events SET duplicate_observations = duplicate_observations + 1 WHERE id = ?')
      .run(eventId);
  },

  /**
   * Bind a revision to the session and project that attested it, only while
   * the revision is still `unknown`, so two attestations can never both bind
   * it. The binding and the routing claim `route` returns commit in one
   * transaction: a bound author never lacks the recipients it selected, and
   * an unbound one never has them.
   * @param {number} eventId - Revision row id
   * @param {{projectId: number, sessionId: number, attestedAt: string, shadowWouldSelect: number[]}} binding
   * @param {{route?: function(object): Array<object>, onRouted?: function(number[]): void}} [opts] -
   *   `route` is given the bound revision; `onRouted` the ids of the pending deliveries it inserted
   * @returns {boolean} Whether this call bound it.
   */
  attest(eventId, binding, opts = {}) {
    return _startupControlTransaction(() => {
      if (!_bindSharedDocAuthor(eventId, binding)) return false;
      if (opts.route) {
        const ids = _applySharedDocRoute(_rowToSharedDocEvent(_db.prepare('SELECT * FROM shared_doc_events WHERE id = ?').get(eventId)), opts.route);
        if (opts.onRouted) opts.onRouted(ids);
      }
      return true;
    });
  },

  /**
   * One revision by row id.
   * @param {number} eventId - Revision row id
   * @returns {object|null}
   */
  get(eventId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM shared_doc_events WHERE id = ?').get(eventId);
    return row ? _rowToSharedDocEvent(row) : null;
  },

  /**
   * A doc's retained revisions after `sinceSeq`, oldest first, with what a
   * reader needs to know it has the whole story: the newest revision, the
   * oldest one still retained, and whether revisions after `sinceSeq` were
   * pruned before it asked.
   * @param {string} docId - Shared doc id
   * @param {{sinceSeq?: number, limit?: number}} [opts]
   * @returns {{latest: ({seq: number, sha256: string, observedAt: string}|null), oldestRetainedSeq: (number|null), gap: boolean, events: object[]}}
   */
  list(docId, opts = {}) {
    _ensureDb();
    const sinceSeq = Number.isInteger(opts.sinceSeq) && opts.sinceSeq >= 0 ? opts.sinceSeq : 0;
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 100;
    const bounds = _db.prepare('SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM shared_doc_events WHERE doc_id = ?').get(docId);
    const newest = bounds && bounds.hi
      ? _db.prepare('SELECT seq, sha256, observed_at FROM shared_doc_events WHERE doc_id = ? AND seq = ?').get(docId, bounds.hi)
      : null;
    const oldestRetainedSeq = bounds && bounds.lo ? bounds.lo : null;
    const events = _db.prepare('SELECT * FROM shared_doc_events WHERE doc_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(docId, sinceSeq, limit).map(_rowToSharedDocEvent);
    for (const event of events) event.deliveries = sharedDocDeliveriesApi.summary(event.id);
    return {
      latest: newest ? { seq: newest.seq, sha256: newest.sha256, observedAt: newest.observed_at } : null,
      oldestRetainedSeq,
      // A revision numbered after `sinceSeq` that is no longer retained.
      gap: oldestRetainedSeq != null && oldestRetainedSeq > sinceSeq + 1,
      events
    };
  }
};

/**
 * Persist the deliveries a revision's routing step intends, inside the
 * caller's transaction, and move its `routing` state: `pending` while any
 * row awaits its send, otherwise `done` once anything was intended. A row
 * for a (project, session) already resolved for the revision is ignored, so
 * no recipient is resolved twice.
 * @param {object} revision - The revision as recorded
 * @param {function(object): Array<{projectId: number, sessionId?: number, reason: string, outcome: string, error?: string}>} route
 * @returns {number[]} Ids of the pending deliveries this call inserted: the only
 *   ones its caller may send.
 */
function _applySharedDocRoute(revision, route) {
  const pendingIds = [];
  // An interrupted delivery is never extended or resent, whoever asks.
  if (revision.routing === 'interrupted') return pendingIds;
  const rows = route(revision) || [];
  if (rows.length === 0) return pendingIds;
  const at = new Date().toISOString();
  const insert = _db.prepare(
    `INSERT OR IGNORE INTO shared_doc_deliveries (event_id, project_id, session_id, reason, outcome, error, resolved_at, outcome_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let anyPending = false;
  for (const r of rows) {
    const info = insert.run(revision.id, r.projectId, r.sessionId || 0, r.reason, r.outcome, r.error || null, at,
      r.outcome === 'pending' ? null : at);
    if (info.changes === 1 && r.outcome === 'pending') {
      anyPending = true;
      pendingIds.push(Number(info.lastInsertRowid));
    }
  }
  if (anyPending) {
    _db.prepare("UPDATE shared_doc_events SET routing = 'pending' WHERE id = ?").run(revision.id);
  } else {
    _db.prepare("UPDATE shared_doc_events SET routing = 'done' WHERE id = ? AND routing = 'none'").run(revision.id);
  }
  return pendingIds;
}

/**
 * Bind a still-`unknown` revision to its attesting session and project. The
 * one statement of the binding, shared by a revision recorded already bound
 * and one bound later; the `unknown` guard means two binds can never both
 * succeed. Called inside the caller's transaction.
 * @param {number} eventId - Revision row id
 * @param {{projectId: number, sessionId: number, attestedAt: string, shadowWouldSelect?: number[]}} binding
 * @returns {boolean} Whether this call bound it.
 */
function _bindSharedDocAuthor(eventId, binding) {
  const info = _db.prepare(
    `UPDATE shared_doc_events SET author_source = 'attested', author_project_id = ?, author_session_id = ?,
       attested_at = ?, shadow_would_select = ?
     WHERE id = ? AND author_source = 'unknown'`
  ).run(binding.projectId, binding.sessionId, binding.attestedAt,
    JSON.stringify(binding.shadowWouldSelect || []), eventId);
  return info.changes === 1;
}

/**
 * Convert a `shared_doc_deliveries` row to an app-level delivery.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToSharedDocDelivery(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    projectId: row.project_id,
    sessionId: row.session_id === 0 ? null : row.session_id,
    reason: row.reason,
    outcome: row.outcome,
    error: row.error,
    resolvedAt: row.resolved_at,
    outcomeAt: row.outcome_at
  };
}

/**
 * The outcome of every notice a shared-doc revision intended (#2389). Rows
 * are written by the routing step inside the revision's own transaction
 * (`recordRevision` / `attest` with `route`) as `pending`, and each is then
 * settled once by its send.
 */
const sharedDocDeliveriesApi = {
  /**
   * One delivery by row id.
   * @param {number} deliveryId - Delivery row id
   * @returns {object|null} null once its revision (or doc) is gone
   */
  get(deliveryId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM shared_doc_deliveries WHERE id = ?').get(deliveryId);
    return row ? _rowToSharedDocDelivery(row) : null;
  },

  /**
   * Every delivery of a revision.
   * @param {number} eventId - Revision row id
   * @returns {object[]}
   */
  listForEvent(eventId) {
    _ensureDb();
    return _db.prepare('SELECT * FROM shared_doc_deliveries WHERE event_id = ? ORDER BY id ASC')
      .all(eventId).map(_rowToSharedDocDelivery);
  },

  /**
   * The projects already resolved for a revision, whatever their outcome.
   * @param {number} eventId - Revision row id
   * @returns {Set<number>}
   */
  resolvedProjectIds(eventId) {
    _ensureDb();
    return new Set(_db.prepare('SELECT DISTINCT project_id FROM shared_doc_deliveries WHERE event_id = ?')
      .all(eventId).map((r) => r.project_id));
  },

  /**
   * Record a pending delivery's outcome. Only a `pending` row is settled, so
   * a row the startup sweep already marked `unknown` keeps that.
   * @param {number} deliveryId - Delivery row id
   * @param {string} outcome - `sent`, `coalesced`, `offline`, `failed`, `muted` or `withdrawn`
   * @param {string} [error] - Why it failed
   * @returns {boolean} Whether the row was settled by this call.
   */
  settle(deliveryId, outcome, error) {
    _ensureDb();
    const info = _db.prepare(
      "UPDATE shared_doc_deliveries SET outcome = ?, error = ?, outcome_at = ? WHERE id = ? AND outcome = 'pending'"
    ).run(outcome, error || null, new Date().toISOString(), deliveryId);
    return info.changes === 1;
  },

  /**
   * Mark a revision `done` once none of its deliveries is pending.
   * @param {number} eventId - Revision row id
   * @returns {void}
   */
  finish(eventId) {
    _ensureDb();
    _db.prepare(
      `UPDATE shared_doc_events SET routing = 'done' WHERE id = ? AND routing = 'pending'
         AND NOT EXISTS (SELECT 1 FROM shared_doc_deliveries WHERE event_id = ? AND outcome = 'pending')`
    ).run(eventId, eventId);
  },

  /**
   * At startup: every revision still `pending` becomes `interrupted`, and its
   * pending deliveries `unknown`. Nothing is resent: a send that may or may
   * not have left before the stop cannot be told apart from none.
   * @returns {{revisions: number, deliveries: number}}
   */
  interruptPending() {
    return _startupControlTransaction(() => {
      const deliveries = _db.prepare(
        "UPDATE shared_doc_deliveries SET outcome = 'unknown', outcome_at = ? WHERE outcome = 'pending'"
      ).run(new Date().toISOString()).changes;
      const revisions = _db.prepare("UPDATE shared_doc_events SET routing = 'interrupted' WHERE routing = 'pending'").run().changes;
      return { revisions, deliveries };
    });
  },

  /**
   * A revision's deliveries counted per outcome. A project with several live
   * sessions contributes one count per session, never a single word.
   * @param {number} eventId - Revision row id
   * @returns {Object<string, number>}
   */
  summary(eventId) {
    _ensureDb();
    const out = {};
    for (const r of _db.prepare('SELECT outcome, COUNT(*) AS n FROM shared_doc_deliveries WHERE event_id = ? GROUP BY outcome').all(eventId)) {
      out[r.outcome] = r.n;
    }
    return out;
  }
};

/**
 * Convert a `shared_doc_notice_prefs` row to an app-level setting.
 * @param {object} row - Raw SQLite row
 * @returns {{projectId: number, scope: string, groupId: (string|null), docId: (string|null), setting: string, setAt: string, setBy: (string|null)}}
 */
function _rowToSharedDocNoticePref(row) {
  return {
    projectId: row.project_id,
    scope: row.doc_id ? 'doc' : 'group',
    groupId: row.group_id,
    docId: row.doc_id,
    setting: row.setting,
    setAt: row.set_at,
    setBy: row.set_by
  };
}

/**
 * Each project's notice settings for shared docs (#2389): `mute` or
 * `subscribe`, per doc or per group; no row is the default. Who may set what
 * is the route's to decide; this only stores it.
 */
const sharedDocNoticePrefsApi = {
  /**
   * Set, or clear with `default`, one project's setting at one scope.
   * @param {{projectId: number, groupId?: string, docId?: string, setting: string, setBy?: string}} opts -
   *   exactly one of `groupId` or `docId`
   * @returns {object|null} The setting now held, or null after `default`.
   * @throws {StoreError} BAD_REQUEST for a bad scope or setting.
   */
  set({ projectId, groupId, docId, setting, setBy }) {
    _ensureDb();
    if (!!groupId === !!docId) throw new StoreError('Exactly one of groupId or docId is required', 'BAD_REQUEST');
    if (setting !== 'default' && !SHARED_DOC_NOTICE_SETTINGS.includes(setting)) {
      throw new StoreError(`setting must be one of ${[...SHARED_DOC_NOTICE_SETTINGS, 'default'].join(', ')}`, 'BAD_REQUEST');
    }
    const column = docId ? 'doc_id' : 'group_id';
    const scopeId = docId || groupId;
    return _startupControlTransaction(() => {
      _db.prepare(`DELETE FROM shared_doc_notice_prefs WHERE project_id = ? AND ${column} = ?`).run(projectId, scopeId);
      if (setting === 'default') return null;
      _db.prepare(`INSERT INTO shared_doc_notice_prefs (project_id, ${column}, setting, set_at, set_by) VALUES (?, ?, ?, ?, ?)`)
        .run(projectId, scopeId, setting, new Date().toISOString(), setBy || null);
      return _rowToSharedDocNoticePref(
        _db.prepare(`SELECT * FROM shared_doc_notice_prefs WHERE project_id = ? AND ${column} = ?`).get(projectId, scopeId)
      );
    });
  },

  /**
   * Every setting that bears on a group: its group-scope settings and those
   * of every doc registered in it.
   * @param {string} groupId - Group id
   * @returns {object[]}
   */
  listForGroup(groupId) {
    _ensureDb();
    return _db.prepare(
      `SELECT * FROM shared_doc_notice_prefs
       WHERE group_id = ? OR doc_id IN (SELECT id FROM shared_documents WHERE group_id = ?)
       ORDER BY project_id ASC, id ASC`
    ).all(groupId, groupId).map(_rowToSharedDocNoticePref);
  }
};

/**
 * Drop a doc's revisions that are BOTH outside the newest
 * {@link SHARED_DOC_EVENTS_KEEP} and older than {@link SHARED_DOC_EVENTS_KEEP_DAYS}
 * days, so whichever rule keeps more wins. Called inside the recording
 * transaction.
 * @param {string} docId - Shared doc id
 * @param {number} newestSeq - The seq just recorded
 * @param {Date} now - The time retention is measured from
 * @returns {void}
 */
function _pruneSharedDocEvents(docId, newestSeq, now) {
  const cutoff = new Date(now.getTime() - SHARED_DOC_EVENTS_KEEP_DAYS * 86400000).toISOString();
  _db.prepare('DELETE FROM shared_doc_events WHERE doc_id = ? AND seq <= ? AND observed_at < ?')
    .run(docId, newestSeq - SHARED_DOC_EVENTS_KEEP, cutoff);
}

/**
 * The operator's launch-isolation overrides (#2229). An override that is on is
 * a row; off is no row. Only an operator-only route writes here: a session
 * that could set its own override would be granting itself the launch the
 * refusal exists to stop.
 */
const launchIsolationOverridesApi = {
  /**
   * Every override that is on.
   * @returns {{install: ({setAt: string, setBy: (string|null)}|null), projects: Array<{projectId: number, setAt: string, setBy: (string|null)}>}}
   */
  list() {
    _ensureDb();
    const rows = _db.prepare(
      'SELECT scope, project_id, set_at, set_by FROM launch_isolation_overrides ORDER BY project_id'
    ).all();
    const install = rows.find((row) => row.scope === 'install') || null;
    return {
      install: install ? { setAt: install.set_at, setBy: install.set_by } : null,
      projects: rows.filter((row) => row.scope === 'project')
        .map((row) => ({ projectId: row.project_id, setAt: row.set_at, setBy: row.set_by }))
    };
  },

  /**
   * Turn an override on. One that is already on is left as it was, with the
   * time and name of whoever turned it on, and nothing is logged.
   * @param {object} override
   * @param {number|null} override.projectId - The project, or null for the install-wide override
   * @param {string|null} [override.setBy] - The operator's account name; null when the install has no login gate
   * @param {string} [override.at] - ISO time; defaults to now
   * @returns {{changed: boolean}} Whether this call turned it on
   * @throws {StoreError} `BAD_REQUEST` for an id that is neither null nor a positive integer; `NOT_FOUND` for no such project
   */
  set({ projectId, setBy = null, at = new Date().toISOString() }) {
    const scope = _launchIsolationOverrideScope(projectId);
    return _startupControlTransaction(() => {
      if (scope === 'project' && !_db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
        throw new StoreError(`No project has the id ${projectId}.`, 'NOT_FOUND');
      }
      const info = _db.prepare(
        'INSERT INTO launch_isolation_overrides (scope, project_id, set_at, set_by) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'
      ).run(scope, projectId, at, setBy);
      const changed = Number(info.changes) === 1;
      if (changed) {
        activityApi.logOrThrow({
          projectId: projectId || undefined,
          eventType: 'launch.isolation_override_set',
          detail: { scope, setBy }
        });
      }
      return { changed };
    });
  },

  /**
   * Turn an override off. One that is already off stays off, and nothing is
   * logged.
   * @param {object} override
   * @param {number|null} override.projectId - The project, or null for the install-wide override
   * @param {string|null} [override.clearedBy] - The operator's account name, for the activity log
   * @returns {{changed: boolean}} Whether this call turned it off
   * @throws {StoreError} `BAD_REQUEST` for an id that is neither null nor a positive integer
   */
  clear({ projectId, clearedBy = null }) {
    const scope = _launchIsolationOverrideScope(projectId);
    return _startupControlTransaction(() => {
      const info = scope === 'install'
        ? _db.prepare("DELETE FROM launch_isolation_overrides WHERE scope = 'install'").run()
        : _db.prepare("DELETE FROM launch_isolation_overrides WHERE scope = 'project' AND project_id = ?").run(projectId);
      const changed = Number(info.changes) > 0;
      if (changed) {
        activityApi.logOrThrow({
          projectId: projectId || undefined,
          eventType: 'launch.isolation_override_cleared',
          detail: { scope, clearedBy }
        });
      }
      return { changed };
    });
  },

  /**
   * Whether an override applies to a launch: the install-wide one, or the
   * project's. The one question the launch path asks, and it fails closed:
   * this never throws, and anything it cannot read is "not allowed". It does
   * not know why a launch was refused; the caller asks only for a refusal an
   * override may cover.
   * @param {number|null} projectId - A project's numeric id; null for the
   *   Project Master, which belongs to no project and gets the install-wide
   *   override only
   * @returns {Readonly<{allowed: boolean, scope: ('install'|'project'|null), setAt: (string|null), setBy: (string|null), reason: (string|null)}>}
   *   `scope` is `install` whenever the install-wide override is on, also when
   *   the project's is too. When not allowed, `reason` is `not_set`,
   *   `unreadable` or `bad_project_id`, and the other fields are null.
   */
  effectiveFor(projectId) {
    const refused = (reason) => Object.freeze({ allowed: false, scope: null, setAt: null, setBy: null, reason });
    if (projectId !== null && !(Number.isInteger(projectId) && projectId > 0)) return refused('bad_project_id');
    try {
      _ensureDb();
      const row = _db.prepare(
        'SELECT scope, set_at, set_by FROM launch_isolation_overrides '
        + "WHERE scope = 'install' OR (scope = 'project' AND project_id = ?) "
        + "ORDER BY (scope = 'install') DESC LIMIT 1"
      ).get(projectId);
      if (!row) return refused('not_set');
      if (!LAUNCH_ISOLATION_OVERRIDE_SCOPES.includes(row.scope) || typeof row.set_at !== 'string' || row.set_at === '') {
        throw new Error('the override row read back is not of the stored shape');
      }
      return Object.freeze({ allowed: true, scope: row.scope, setAt: row.set_at, setBy: row.set_by ?? null, reason: null });
    } catch (err) { // prawduct:allow prawduct/broad-except -- fail closed: whatever stops the read, the launch is treated as not allowed and the caller is never thrown at
      log.error('The launch-isolation override could not be read; the launch is treated as not allowed', {
        projectId, error: err.message, hint: 'Check that the store is open and the launch_isolation_overrides table exists; the override applies again once it can be read'
      });
      return refused('unreadable');
    }
  }
};

/**
 * Which override a project id names, refusing anything that is neither.
 * @param {number|null} projectId - A project's id, or null for the install
 * @returns {('install'|'project')}
 * @throws {StoreError} `BAD_REQUEST` when it is neither null nor a positive integer
 */
function _launchIsolationOverrideScope(projectId) {
  if (projectId === null) return 'install';
  if (Number.isInteger(projectId) && projectId > 0) return 'project';
  throw new StoreError('A launch-isolation override names a project by its numeric id, or null for the install.', 'BAD_REQUEST');
}

module.exports = {
  init,
  close,
  hasPriorUse,
  config: configApi,
  engines: enginesApi,
  orchestrationProfiles: orchestrationProfilesApi,
  control: controlApi,
  launchIsolationOverrides: launchIsolationOverridesApi,
  sharedDocEvents: sharedDocEventsApi,
  sharedDocDeliveries: sharedDocDeliveriesApi,
  sharedDocNoticePrefs: sharedDocNoticePrefsApi,
  SHARED_DOC_NOTICE_SETTINGS,
  SHARED_DOC_DELIVERY_OUTCOMES,
  SHARED_DOC_EVENTS_KEEP,
  SHARED_DOC_EVENTS_KEEP_DAYS,
  SHARED_DOC_EVENT_SOURCES,
  LAUNCH_ISOLATION_OVERRIDE_SCOPES,
  workloadReceipts: workloadReceiptsApi,
  workloadNudgeFacts: workloadNudgeFactsApi,
  medusaExchanges: medusaExchangesApi,
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
  STARTUP_FIRE_DISPATCH_NOTE_MAX,
  sessionRuleDeliveries: sessionRuleDeliveriesApi,
  launchSequences: launchSequencesApi,
  recoveryClearances: recoveryClearancesApi,
  recoveryClearBatches: recoveryClearBatchesApi,
  RECOVERY_BATCH_OUTCOMES,
  WORKLOAD_NUDGE_FACT_KINDS,
  WORKLOAD_NUDGE_ROUTES,
  projectRecoveryState: projectRecoveryStateApi,
  startupPrompts: startupPromptsApi,
  startupControlChannels: startupControlChannelsApi,
  coordinatorRotations: coordinatorRotationsApi,
  coordinatorRoles: coordinatorRolesApi,
  STARTUP_PROMPT_SEED,
  STARTUP_FIRE_OUTCOMES,
  STARTUP_FIRE_ACTIVE,
  STARTUP_FIRE_TERMINAL,
  STARTUP_FIRE_TRANSITIONS,
  STARTUP_FIRE_REASON_CODES,
  STARTUP_FIRE_CALLER_KINDS,
  STARTUP_FIRE_CLEARANCES,
  STARTUP_DELIVERIES,
  STARTUP_CONTROL_RETENTION,
  _setStartupControlRetention,
  handoffs: handoffsApi,
  handoffEpoch: handoffEpochApi,
  HANDOFF_BASELINES,
  HANDOFF_BASELINE_VALUES,
  EPOCH_UNKNOWN_FROM_V41,
  EPOCH_ROW_MISSING,
  LAUNCH_STEP_IDS,
  medusaDeliveries: medusaDeliveriesApi,
  awarenessReceipts: awarenessReceiptsApi,
  SESSION_RULE_DELIVERY_CHANNELS,
  SESSION_RULE_DELIVERY_OUTCOMES,
  RULES_SERVED_BY_LAUNCH_SEQUENCE,
  _setSessionRuleDeliveryRetention,
  ACTIVITY_LOG_RETENTION,
  ACTIVITY_PRUNE_EVENT,
  _setActivityLogRetention,
  _setAwarenessReceiptRetention,
  SESSION_STATUS,
  SESSION_STATUSES,
  // Exported so the unreachable-target refusal is reachable from a test; no
  // production caller targets a status the public writers cannot.
  _transitionSession,
  SESSION_STATUS_TRANSITIONS,
  canTransition,
  SESSION_RULE_KINDS,
  SESSION_RULE_STATUSES,
  SESSION_RULE_TRANSITIONS,
  SESSION_RULE_VERSION_RETENTION,
  _setSessionRuleVersionRetention,
  portLeases: portLeasesApi,
  LEASE_REACHES,
  LEASE_OWNER_KINDS,
  users: usersApi,
  authSessions: authSessionsApi,
  recoveryCodes: recoveryCodesApi,
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
  _LAUNCH_BLOCKER_WARN_CAP: LAUNCH_BLOCKER_WARN_CAP,
  _setBasePath,
  _getBasePath,
  _getConfigPath,
  DEFAULT_CONFIG,
  LEGACY_PROJECTS_DIR,
  DEFAULT_PROJECT_CONFIG
};
