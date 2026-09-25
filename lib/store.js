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

const log = createLogger('store');

const CURRENT_SCHEMA_VERSION = 49;

/**
 * Revision 1 of the startup prompt (#1825). It only asks the engine to read its
 * launch context and never dispatches project work, which is the one thing an
 * automatic bootstrap may do.
 * @type {string}
 */
const STARTUP_PROMPT_SEED = 'read your launch context: run tc start next';

/**
 * Content digest of a startup prompt revision: sha256 hex of its text. Stored
 * with the revision so a fire can record exactly which bytes it named.
 * @param {string} text - Prompt text.
 * @returns {string} 64-char hex digest.
 */
function _startupPromptDigest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Canonical digest of a firer policy: sha256 hex of `{"firerProjectIds":[...]}`
 * with the ids sorted ascending, so the same list always digests the same.
 * @param {number[]} ids - Project ids.
 * @returns {string} 64-char hex digest.
 */
function _startupPolicyDigest(ids) {
  const canonical = JSON.stringify({ firerProjectIds: [...ids].sort((a, b) => a - b) });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Every state a startup prompt fire can be in (#1825). `pending`,
 * `dispatching`, `indeterminate` and `accepted` are ACTIVE: a launch holds at
 * most one of those at a time. `indeterminate` means a send may have happened
 * with no receipt; it is never retried automatically. `denied` records an
 * out-of-scope attempt, which the caller was told was not found.
 * @type {string[]}
 */
const STARTUP_FIRE_OUTCOMES = Object.freeze([
  'pending', 'dispatching', 'indeterminate', 'accepted',
  'applied', 'blocked', 'failed', 'interrupted', 'unsupported', 'denied'
]);

/** The outcomes that occupy a launch's single active slot. @type {string[]} */
const STARTUP_FIRE_ACTIVE = Object.freeze(['pending', 'dispatching', 'indeterminate', 'accepted']);

/**
 * Bounded, typed reasons a fire records. Free text rides beside the code,
 * capped at 500 characters, but readers key on the code.
 * @type {string[]}
 */
const STARTUP_FIRE_REASON_CODES = Object.freeze([
  'engine_declares_none', 'engine_profile_unreadable', 'profile_block_malformed', 'adapter_not_registered',
  'version_unverified', 'dispatch_unavailable', 'fire_scope_denied',
  // The Codex adapter's codes: what stopped a fire before a send, what an
  // engine reported about the turn, and what the channel itself did.
  'trust_required', 'auth_required', 'quota_exhausted', 'engine_not_ready', 'version_mismatch',
  'readiness_unknown', 'approval_pending', 'user_input_pending', 'turn_failed', 'turn_rejected',
  'turn_interrupted', 'send_unconfirmed', 'restart_before_dispatch', 'channel_lost', 'channel_unavailable',
  // The automatic bootstrap's own pre-send gate (B3): the pane never became
  // ready within the launch window, so the adapter was never asked. A fact
  // about the pane as TangleClaw observed it, never a claim about the engine.
  'pane_not_ready'
]);

/**
 * Who asked for a fire. `operator` and `project` are HTTP callers the routes
 * prove; `launch` is TangleClaw's own automatic bootstrap at launch (#1825 B3),
 * an internal caller no request can produce.
 * @type {string[]}
 */
const STARTUP_FIRE_CALLER_KINDS = Object.freeze(['operator', 'project', 'launch']);

/**
 * How well a fire's caller was proven. `launch-automatic` is the bootstrap's:
 * the launch that fires is the launch being fired at, proven inside the fire
 * transaction rather than by any credential.
 * @type {string[]}
 */
const STARTUP_FIRE_CLEARANCES = Object.freeze(['operator-verified', 'open-install-unverified', 'project-binding', 'launch-automatic']);

/** How a launch's startup context is first put in front of the engine. @type {string[]} */
const STARTUP_DELIVERIES = Object.freeze(['legacy', 'native']);

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

/**
 * A string list as a SQL `IN (...)` body, for CHECK constraints built from the
 * same constants readers use.
 * @param {string[]} list - Values.
 * @returns {string}
 */
function _sqlList(list) {
  return list.map((v) => `'${v}'`).join(',');
}

const STARTUP_FIRE_OUTCOMES_SQL = _sqlList(STARTUP_FIRE_OUTCOMES);
const STARTUP_FIRE_ACTIVE_SQL = _sqlList(STARTUP_FIRE_ACTIVE);
const STARTUP_FIRE_REASON_CODES_SQL = _sqlList(STARTUP_FIRE_REASON_CODES);
const STARTUP_FIRE_CALLER_KINDS_SQL = _sqlList(STARTUP_FIRE_CALLER_KINDS);
const STARTUP_FIRE_CLEARANCES_SQL = _sqlList(STARTUP_FIRE_CLEARANCES);
const STARTUP_DELIVERIES_SQL = _sqlList(STARTUP_DELIVERIES);

/**
 * The baseline a project's history was classified as at the handoff-epoch
 * boundary. Only `clean` earns the legacy exception in `lib/launch-preflight.js`;
 * the other two reach recovery. Exported so a caller matches on a constant
 * rather than a spelling, and so the CHECK constraint below is written from
 * this one list instead of a second copy of it.
 * @type {Readonly<{CLEAN: string, UNCLEAN: string, EMPTY: string}>}
 */
const HANDOFF_BASELINES = Object.freeze({
  CLEAN: 'clean',
  UNCLEAN: 'unclean',
  EMPTY: 'empty'
});

/** Every allowed `project_handoff_epoch.baseline` value. @type {readonly string[]} */
const HANDOFF_BASELINE_VALUES = Object.freeze(Object.values(HANDOFF_BASELINES));

/**
 * Why a cutoff recorded on a store that had already taken v41 cannot be trusted
 * as the real boundary. v41 shipped handoff publication without recording where
 * handoffs began, so on such a store the instant is simply not knowable — and a
 * cutoff taken later sweeps post-epoch sessions into the legacy window, turning
 * a lost handoff into "this project predates handoffs". The reason travels with
 * the row so an operator is told the boundary is unknown rather than that a
 * failure was proven.
 */
const EPOCH_UNKNOWN_FROM_V41 = 'epoch-boundary-unknown-from-v41';

/**
 * Why a boundary read found no row at all on a store that claims to carry them.
 * Read by the launch path, never written to the table: a missing row is an
 * integrity condition to report, never a licence to take today's `MAX(id)` and
 * call the result a recovered boundary.
 */
const EPOCH_ROW_MISSING = 'epoch-row-missing';

// How far a leased service is MEANT to be reachable (#1394). One owner for the
// vocabulary, stated precisely because a comment that overclaims is worse than
// none — it is what stops the next reader from checking. Three surfaces read
// THIS array: the CHECK constraint (via REACH_CHECK_SQL below), the lease
// validator, and `lib/caddy-drift.js`, which imports it as its reach ordering
// rather than restating it. The HTTP route reads it only indirectly, by
// surfacing the validator's error text verbatim instead of listing the values
// again. So widening the set is a single-line change here that cannot leave a
// surface still answering for the old vocabulary.
// Order is widening — index 0 is the weakest claim and the default.
const LEASE_REACHES = ['loopback', 'tailnet', 'lan'];

// The CHECK clause built from that one array, so the fresh-install DDL, the
// v34→v35 migration and its postcondition cannot drift apart. Built from
// module-local literals; nothing caller-supplied reaches it.
const REACH_CHECK_SQL = `reach IN (${LEASE_REACHES.map((r) => `'${r}'`).join(',')})`;

// Who owns a leased port (#1381). `project` is a TangleClaw project (or
// TangleClaw itself); `external` is a process no project started — a
// `brew services` database, a system daemon. Every reader that decides a lease
// is an orphan (the boot sweep, the dashboard's import banner) asks this field
// instead of inferring "not a project" from a missing directory, which is what
// deleted correct leases before. `project` is first because it is the default
// and what every row written before the field existed meant.
const LEASE_OWNER_KINDS = ['project', 'external'];

// The CHECK clause from that one array, shared by the fresh-install DDL, the
// v43→v44 migration and its postcondition. Module-local literals only.
const OWNER_KIND_CHECK_SQL = `owner_kind IN (${LEASE_OWNER_KINDS.map((k) => `'${k}'`).join(',')})`;

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
  _createTables();
  _runMigrations();
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
      wrap_started_at  TEXT,                                                -- historical: written by no current code path (#1034)
      owner            TEXT,                                                 -- signed-in TangleClaw user who launched it (NULL = no one signed in)
      launch_sha       TEXT,                                                 -- HEAD when the session launched (NULL = not a repo, or launched before v39)
      launch_toplevel  TEXT,                                                 -- repo toplevel that sha and launch_dirty describe
      launch_dirty     TEXT                                                  -- JSON {paths, truncated}: paths already dirty at launch (NULL = not captured)
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
      outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped','unverified','written')),
      skip_reason  TEXT,
      rule_ids     TEXT    NOT NULL DEFAULT '[]',
      rule_count   INTEGER NOT NULL DEFAULT 0,
      digest       TEXT    NOT NULL,
      -- #1063 — when the engine's hook confirmed it, NULL until then. The
      -- ratified direction refused to let a later observation destroy the
      -- record of what was known when; this is the column that keeps both
      -- facts on one row (see the amendment in prime-delivery-direction.md).
      confirmed_at TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      -- Structurally impossible states, rejected by the database rather than
      -- only by the writer: nothing can be sent through no channel, and a
      -- skip or an unverified send with no reason records a failure while
      -- discarding what it was.
      CHECK (outcome NOT IN ('delivered','unverified','written') OR channel != 'none'),
      CHECK (outcome NOT IN ('skipped','unverified')   OR skip_reason IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_session ON session_rule_deliveries(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_project ON session_rule_deliveries(project_id);

    -- Launch sequences (Train 21). A session's context is served in four
    -- acknowledged steps over 'tc start'; these two tables are the whole
    -- record of that exchange. The step content is FROZEN at creation and
    -- served verbatim, so a restart or a rule edit can never change what an
    -- advertised digest covers. session_id / project_id are LOGICAL
    -- references (no FK), like session_rule_deliveries: the record outlives
    -- the session or project it describes.
    CREATE TABLE IF NOT EXISTS launch_sequences (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      launch_id       TEXT    NOT NULL UNIQUE,
      session_id      INTEGER NOT NULL,
      project_id      INTEGER NOT NULL,
      engine_id       TEXT    NOT NULL,
      revision        INTEGER NOT NULL DEFAULT 1,
      cursor          INTEGER NOT NULL DEFAULT 0,
      page_budget     INTEGER NOT NULL,
      applicability   TEXT    NOT NULL CHECK (applicability IN ('applicable','not-applicable')),
      not_applicable_reason TEXT,
      preflight       TEXT    NOT NULL,
      source_manifest TEXT    NOT NULL,
      ready_at        TEXT,
      ready_artifact  TEXT,
      ready_digest    TEXT,
      unready_at      TEXT,
      nudge_count     INTEGER NOT NULL DEFAULT 0,
      last_nudged_at  TEXT,
      -- Recovery (Train 21, #1587). recovery is decided at launch from the
      -- preflight's requiresRecovery and gates step 4 and READY; recovery_mode
      -- is the project's setting frozen with the launch, so a setting edited
      -- mid-launch cannot change the rules the pane is already playing by.
      -- recovery_revision is what a clear is bound to: a snapshot revision
      -- re-renders the verdict the operator read before deciding, so a clear
      -- granted against the old one must not apply to the new one.
      recovery        TEXT    NOT NULL DEFAULT 'none' CHECK (recovery IN ('none','required','cleared')),
      recovery_mode   TEXT    NOT NULL DEFAULT 'operator' CHECK (recovery_mode IN ('operator','advisory')),
      recovery_revision INTEGER NOT NULL DEFAULT 1,
      recovery_cleared_at TEXT,
      recovery_cleared_by TEXT,
      recovery_clearance  TEXT CHECK (recovery_clearance IN ('operator-verified','open-install-unverified','agent-reconciled')),
      -- How this launch's startup context is first put in front of the engine
      -- (#1825 B3). 'native' means the launch selected its engine's
      -- startupControl channel: no prime paste, no kickoff, no unready nudge —
      -- nothing is ever typed into that pane by TangleClaw. Decided at launch
      -- and frozen here so a restart cannot turn a native launch back into a
      -- keystroke path.
      startup_delivery TEXT NOT NULL DEFAULT 'legacy' CHECK (startup_delivery IN (${STARTUP_DELIVERIES_SQL})),
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      CHECK (applicability = 'applicable' OR not_applicable_reason IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_sequences_session ON launch_sequences(session_id);

    CREATE TABLE IF NOT EXISTS launch_sequence_steps (
      sequence_id   INTEGER NOT NULL,
      revision      INTEGER NOT NULL,
      step_index    INTEGER NOT NULL CHECK (step_index BETWEEN 0 AND 3),
      step_id       TEXT    NOT NULL CHECK (step_id IN ('identity','governance','state','task')),
      content       TEXT    NOT NULL,
      digest        TEXT    NOT NULL,
      page_count    INTEGER NOT NULL,
      page_offsets  TEXT    NOT NULL,
      carried_from_revision INTEGER,
      pages_served  TEXT    NOT NULL DEFAULT '[]',
      served_at     TEXT,
      acked_at      TEXT,
      PRIMARY KEY (sequence_id, revision, step_index)
    );

    -- Handoff publications (Train 21, #1585). One row per wrap ATTEMPT, never
    -- per session: a kept session publishes checkpoint → checkpoint → final,
    -- and each is its own immutable publication. project_id / session_id are
    -- LOGICAL references (no FK), like launch_sequences above — the record
    -- outlives the session or project it describes, which is the whole point
    -- of a forensic handoff trail.
    --
    -- eligible_at is the attempt-exact proof that this attempt COMPLETED. It is
    -- written only by the lifecycle-wrap transaction or by
    -- markCheckpointComplete, never inferred from session status: a failed
    -- attempt must never borrow a later attempt's success.
    CREATE TABLE IF NOT EXISTS handoff_publications (
      publication_id  TEXT    PRIMARY KEY,
      seq             INTEGER NOT NULL UNIQUE,
      project_id      INTEGER NOT NULL,
      session_id      INTEGER NOT NULL,
      wrap_run_id     TEXT    NOT NULL,
      kind            TEXT    NOT NULL CHECK (kind IN ('final','checkpoint')),
      state           TEXT    NOT NULL CHECK (state IN ('staged','published','superseded','abandoned')),
      file_digest     TEXT    NOT NULL,
      eligible_at     TEXT,
      eligible_via    TEXT    CHECK (eligible_via IN ('lifecycle-wrap','checkpoint-complete')),
      staged_at       TEXT    NOT NULL,
      published_at    TEXT,
      superseded_at   TEXT,
      superseded_by   TEXT,
      abandoned_at    TEXT,
      abandoned_reason TEXT,
      UNIQUE (session_id, wrap_run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_handoff_pub_project ON handoff_publications(project_id, seq);
    -- At most one FINAL attempt per session can ever be eligible: the one that
    -- completed the lifecycle transition.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_pub_final_eligible
      ON handoff_publications(session_id) WHERE kind = 'final' AND eligible_at IS NOT NULL;

    -- Where handoffs began, per project (Train 21, #1586). One row per project,
    -- written once and never recomputed.
    --
    -- The launch preflight needs to tell a project whose whole history predates
    -- handoffs (nothing was lost) from one that ran a session after handoffs
    -- existed and published nothing (something was). Session ids are the only
    -- recorded ordering that answers that: epoch_session_id is MAX(sessions.id)
    -- at the instant the project crossed into handoff support, so "every session
    -- id <= the epoch" IS "this project predates handoffs".
    --
    -- Which is exactly why it is never recomputed. Taking today's maximum later
    -- draws the line too late and sweeps post-epoch sessions into the legacy
    -- window, downgrading a lost handoff to "predates handoffs" — in the unsafe
    -- direction. A boundary that was never recorded stays unknown: see
    -- baseline_reason.
    --
    -- project_id is a LOGICAL reference, matching handoff_publications above.
    CREATE TABLE IF NOT EXISTS project_handoff_epoch (
      project_id       INTEGER PRIMARY KEY,
      epoch_session_id INTEGER NOT NULL,
      baseline         TEXT    NOT NULL CHECK (baseline IN (${HANDOFF_BASELINE_VALUES.map((b) => "'" + b + "'").join(',')})),
      baseline_reason  TEXT,
      recorded_at      TEXT    NOT NULL
    );

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

    -- Awareness receipts (ambient-awareness Chunk 02). One row per tc-CLI
    -- invocation the server observed. A session that invokes the CLI proved it
    -- discovered the capability TangleClaw put on its PATH; a session that
    -- never does is a DETECTABLE state instead of a silent one — the missing
    -- signal that let the prime channel stay severed for 12 days in August.
    -- project_id/session_id are LOGICAL references and nullable ON PURPOSE: an
    -- invocation with a wrong or missing id still proves the CLI was invoked,
    -- which is the fact this ledger measures.
    CREATE TABLE IF NOT EXISTS awareness_receipts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   INTEGER,
      session_id   INTEGER,
      workspace_id TEXT,
      verb         TEXT    NOT NULL,
      -- Provenance: 'tc-cli' when the tc client identified itself, 'http' for
      -- any other GET (browser preview, health check). Without it, an operator
      -- opening the endpoint in a browser would fabricate the "this session
      -- became aware" fact the awareness view keys on.
      source       TEXT    NOT NULL DEFAULT 'http' CHECK (source IN ('tc-cli','http')),
      -- Non-project actor attribution (#1141): 'master' for the Project
      -- Master's invocations, NULL for every project session. A dedicated
      -- column, not workspace-id reuse — a medusa-disabled Master has no
      -- workspace id, and attribution must not couple to messaging opt-in.
      role         TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_awareness_receipts_project ON awareness_receipts(project_id);
    CREATE INDEX IF NOT EXISTS idx_awareness_receipts_session ON awareness_receipts(session_id);

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
      reach       TEXT NOT NULL DEFAULT 'loopback'
                  CHECK(${REACH_CHECK_SQL}),
      owner_kind  TEXT NOT NULL DEFAULT 'project'
                  CHECK(${OWNER_KIND_CHECK_SQL}),
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

    -- TangleClaw's own front door (ADR 0015). The principal a session
    -- authenticates AS, and the thing basic_auth structurally cannot provide:
    -- one shared credential in a generated Caddyfile has no per-person account
    -- to revoke, expire, or attribute a request to.
    --
    -- password_hash holds the scrypt salt:hash that lib/password.js produces.
    -- The salt lives inside that value, so there is no separate column; the
    -- format is the one already persisted for the delete guard.
    --
    -- disabled_at NULL means active. Revocation is a timestamp rather than a
    -- row delete so an account that once existed stays explicable.
    --
    -- username is CASE-SENSITIVE, deliberately: Rosie and rosie are two
    -- accounts. That matches the Caddy basic_auth credential this replaces, so
    -- the cutover changes no operator's login. COLLATE NOCASE was the
    -- alternative and was declined because SQLite folds ASCII only, which would
    -- make the rule silently different for a non-ASCII name.
    --
    -- Deliberately no role column. ADR 0015 is explicit that the only genuine
    -- tier-1 distinction is authenticated or not, and that admin is the
    -- operator's word for a tier-2 preferences concept. A role column added
    -- before anything reads it would be a security-shaped field that gates
    -- nothing, which is the drift the tier split exists to prevent.
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      disabled_at   TEXT
    );

    -- Logged-in browser sessions for TangleClaw's own front door (#1418).
    --
    -- NAMED auth_sessions, not sessions, because sessions above is already
    -- TangleClaw's core domain table — the tmux/AI sessions the whole product
    -- is about. Two unrelated concepts under one word in one schema is how a
    -- later reader deletes the wrong rows.
    --
    -- token_hash stores a SHA-256 of the cookie token and the token itself is
    -- never written down. A session token is a bearer credential while it
    -- lives, so a database read — a backup, a .dump pasted into an issue — must
    -- not hand anyone a live session. UNIQUE because it is the lookup key.
    --
    -- csrf_token IS stored in the clear, and that asymmetry is deliberate: it
    -- is not a credential. It is a value the client must echo back to prove the
    -- request came from our own page, and it is useless to anyone who cannot
    -- already present the session cookie.
    --
    -- expires_at is epoch MILLISECONDS as an INTEGER, not a datetime() string
    -- like the columns above it. Expiry is compared on every gated request, and
    -- an integer comparison in the index beats parsing a string; the surrounding
    -- tables use datetime() because they are read by people, and this one is
    -- read by the gate.
    --
    -- username is denormalised onto the session ON PURPOSE. ADR 0016 records
    -- that users.getByName returns the password hash, so GET /api/auth/me
    -- must build its answer from the session and never from the user row; that
    -- is only possible if the session carries the name. Tier 1 has no rename,
    -- so there is nothing for the copy to drift from.
    --
    -- The REFERENCES clause states intent and is NOT relied on: SQLite disables
    -- foreign-key enforcement by default and this store never turns it on at
    -- open time, so ON DELETE CASCADE may or may not fire depending on which
    -- migrations a given install has run. Revocation is therefore enforced
    -- twice in code instead — users.disable deletes the account's sessions,
    -- and authSessions.resolve joins users and refuses a disabled one. A
    -- guarantee that rests on a pragma nobody sets is not a guarantee.
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash   TEXT NOT NULL UNIQUE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username     TEXT NOT NULL,
      csrf_token   TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

    -- One-time recovery codes (#1420): each resets one account's password once,
    -- from off the machine, for whoever holds it.
    --
    -- code_hash is a SHA-256 of the canonical code and the code itself is never
    -- written down, for the reason token_hash above gives. UNIQUE because it is
    -- the lookup key, and a lookup that could match two rows could consume the
    -- wrong one.
    --
    -- A used code is KEPT, with used_at and used_from, rather than deleted: the
    -- dashboard tells the account a code was used, and from where, until the
    -- account acknowledges it (notice_cleared_at). Regeneration deletes the
    -- account's whole set, used rows included, because it is the remedy the
    -- notice asks for.
    --
    -- Times are epoch milliseconds, like auth_sessions.expires_at.
    --
    -- The REFERENCES clause is intent only, as on auth_sessions. Nothing relies
    -- on the cascade: redemption joins users and refuses a disabled account, and
    -- no code path deletes a user row.
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash         TEXT NOT NULL UNIQUE,
      created_at        INTEGER NOT NULL,
      used_at           INTEGER,
      used_from         TEXT,
      notice_cleared_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);

    -- The startup prompt (#1825): the instruction a launch fires through an
    -- engine's native channel. Append-only, so every revision a fire named
    -- stays readable; the current prompt is the highest revision. A write is
    -- a compare-and-set on that revision (startupPromptsApi.update).
    -- firer_project_ids is the operator's list of projects whose sessions may
    -- fire the prompt. It lives HERE, not in config.json, because PATCH
    -- /api/config is reachable by agent sessions on loopback: a list stored
    -- there would let an agent authorize itself. Here it is written only with
    -- the prompt, by the strict operator write, as a new revision.
    --
    -- Two digests, because they vouch for different things: text_digest is
    -- the exact prompt bytes a fire delivers; policy_digest is the canonical
    -- firer list, which is authorization evidence for who could fire it.
    -- created_by_kind records how well the author was proven, never merely
    -- that "an operator" wrote it.
    CREATE TABLE IF NOT EXISTS startup_prompt_revisions (
      revision          INTEGER PRIMARY KEY CHECK (revision >= 1),
      text              TEXT    NOT NULL,
      text_digest       TEXT    NOT NULL,
      firer_project_ids TEXT    NOT NULL DEFAULT '[]',
      policy_digest     TEXT    NOT NULL,
      created_by_kind   TEXT    NOT NULL CHECK (created_by_kind IN ('seed','operator-verified','open-install-unverified')),
      created_by        TEXT,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Every fire of the startup prompt, and what came of it. A durable table
    -- rather than activity_log, which is pruned. The row is written as an
    -- INTENT before any external effect, so a crash between a send and its
    -- receipt leaves a row in 'dispatching' or 'indeterminate', which is
    -- never retried automatically and never reads as unsent. It names the
    -- target by session and launch-sequence ROW id, never by launch id: a
    -- launch id is a bearer credential.
    ${_startupPromptFiresDdl('startup_prompt_fires')}
    ${_startupPromptFiresIndexesSql()}

    -- The native channel a launch's engine was given: the
    -- per-launch server TangleClaw started for it, so a restarted TangleClaw
    -- can find it again and a session's end can end it. The header is
    -- generic: which session and launch, which engine and adapter, and its
    -- lifecycle. Everything engine-specific (a socket, a pid, an engine
    -- thread) is adapter_state, a bounded JSON blob only the named adapter
    -- reads or writes, so neither this table nor any generic reader carries a
    -- Codex contract. One open channel per session; sequence_id names
    -- the launch generation it belongs to.
    CREATE TABLE IF NOT EXISTS startup_control_channels (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     INTEGER NOT NULL,
      sequence_id    INTEGER NOT NULL,
      engine_id      TEXT    NOT NULL,
      adapter        TEXT    NOT NULL,
      state          TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
      adapter_state  TEXT    NOT NULL DEFAULT '{}' CHECK (length(adapter_state) <= 8192),
      opened_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      closed_at      TEXT,
      close_reason   TEXT    CHECK (close_reason IS NULL OR length(close_reason) <= 200),
      -- How the teardown went: 'ok', 'skipped' (nothing to signal), or the
      -- error, recorded rather than hidden.
      teardown       TEXT    CHECK (teardown IS NULL OR length(teardown) <= 200)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_startup_control_channels_open
      ON startup_control_channels(session_id) WHERE state = 'open';

    ${_controlTablesDdl()}

    ${_medusaExchangeTablesDdl()}
  `);

  // Seed revision 1 of the startup prompt, with an EMPTY firer list: until the
  // operator says otherwise, only the operator may fire it. Here rather than in
  // the v45 migration because a fresh install stamps the current schema
  // version below without running any migration, and would otherwise start
  // with no prompt. A no-op on every later boot.
  _db.prepare(
    'INSERT INTO startup_prompt_revisions (revision, text, text_digest, firer_project_ids, policy_digest, created_by_kind) '
    + "SELECT 1, ?, ?, '[]', ?, 'seed' WHERE NOT EXISTS (SELECT 1 FROM startup_prompt_revisions)"
  ).run(STARTUP_PROMPT_SEED, _startupPromptDigest(STARTUP_PROMPT_SEED), _startupPolicyDigest([]));

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
      // v13→v14: add wrap_started_at column so the launch-guard could tell a
      // long-lived session that just wrapped from a stale wrapping row (#105).
      // The status it timed no longer exists (#1034); the column is historical.
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
      // v20→v21: AUTH-3 (#1). Add a nullable `owner` column to sessions: the
      // user a session was launched by. It is stamped from the signed-in
      // TangleClaw session (it was first filled from Caddy's X-Auth-User header,
      // which is no longer read). NULL for a session launched with no login
      // required, so existing rows need no backfill — unauthenticated == NULL.
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

    if (currentVersion < 32) {
      // v31→v32: awareness_receipts (ambient-awareness Chunk 02). A session
      // that invokes `tc` proves it discovered the CLI TangleClaw put on its
      // PATH; a session that never does is a DETECTABLE state — the signal
      // that was missing when the prime channel regressed on 2026-08-18 and
      // nothing noticed for 12 days. Same additive shape and same no-catch
      // rationale as v29→v30: every statement is IF NOT EXISTS, and swallowing
      // a real failure would stamp v32 over a database with no table — a
      // permanently empty ledger is the exact silent state this table exists
      // to end.
      _db.exec(`
        CREATE TABLE IF NOT EXISTS awareness_receipts (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id   INTEGER,
          session_id   INTEGER,
          workspace_id TEXT,
          verb         TEXT    NOT NULL,
          -- Provenance: 'tc-cli' when the tc client identified itself,
          -- 'http' for any other GET (browser preview, health check). Without
          -- it, an operator opening the endpoint in a browser would fabricate
          -- the "this session became aware" fact the awareness view keys on.
          source       TEXT    NOT NULL DEFAULT 'http' CHECK (source IN ('tc-cli','http')),
          created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_awareness_receipts_project ON awareness_receipts(project_id);
        CREATE INDEX IF NOT EXISTS idx_awareness_receipts_session ON awareness_receipts(session_id);
      `);
      log.info('Migration v31→v32: awareness_receipts ledger added (ambient-awareness Chunk 02)');
    }

    if (currentVersion < 33) {
      // v32→v33: role column on awareness_receipts (#1141). The Project
      // Master joins the awareness system; its receipts attribute by role
      // because it has no project id and (when medusa is off) no workspace id.
      try {
        _db.exec('ALTER TABLE awareness_receipts ADD COLUMN role TEXT');
      } catch {
        // Column may already exist if _createTables ran with the new schema
      }
      log.info('Migration v32→v33: role column added to awareness_receipts (#1141)');
    }

    if (currentVersion < 34) {
      // v33→v34 (#1063): the outcome enum gains 'written'. The `rules-hook`
      // channel recorded 'delivered' the moment the shards hit disk — a fact
      // about the filesystem, not about any engine reading them — so the #759
      // outage, in which every Claude SessionStart hook failed and sessions
      // booted with no rules at all, produced a clean ledger across multiple
      // sessions and two projects for as long as it lasted. 'written' is the
      // honest write-time row; the hook upgrades it to 'delivered' when it
      // actually runs, so a hook that never runs leaves 'written' standing and
      // the outage becomes visible on every surface that reads the ledger.
      //
      // Existing 'delivered' rows on the rules-hook channel are NOT rewritten:
      // they attest what the writer of the day believed, and rewriting history
      // to match a new semantic is how an audit trail stops being evidence.
      // They age out under the existing retention cap.
      //
      // SQLite cannot alter a CHECK in place, so the table is rebuilt exactly
      // as v28→v29 and v30→v31 did.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _db.exec(`
        CREATE TABLE session_rule_deliveries_v34 (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   INTEGER,
          project_id   INTEGER,
          engine_id    TEXT    NOT NULL,
          kind         TEXT    NOT NULL DEFAULT 'startup',
          channel      TEXT    NOT NULL CHECK (channel IN ('prime-file','prime-paste','rules-hook','none')),
          outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped','unverified','written')),
          skip_reason  TEXT,
          rule_ids     TEXT    NOT NULL DEFAULT '[]',
          rule_count   INTEGER NOT NULL DEFAULT 0,
          digest       TEXT    NOT NULL,
          confirmed_at TEXT,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (outcome NOT IN ('delivered','unverified','written') OR channel != 'none'),
          CHECK (outcome NOT IN ('skipped','unverified')   OR skip_reason IS NOT NULL)
        );
        INSERT INTO session_rule_deliveries_v34
          SELECT id, session_id, project_id, engine_id, kind, channel, outcome,
                 skip_reason, rule_ids, rule_count, digest, NULL, created_at
          FROM session_rule_deliveries;
        DROP TABLE session_rule_deliveries;
        ALTER TABLE session_rule_deliveries_v34 RENAME TO session_rule_deliveries;
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_session ON session_rule_deliveries(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_rule_deliveries_project ON session_rule_deliveries(project_id);
        `);
        // Postcondition, same rationale and mechanism as the two rebuilds
        // above: PRAGMA table_info cannot surface CHECK clauses, so read the
        // DDL back and confirm the rebuilt table accepts the value the rebuild
        // exists to allow.
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_rule_deliveries'"
        ).get();
        if (!ddl || !ddl.sql || !ddl.sql.includes('written')) {
          throw new Error(
            'v33→v34 rebuild did not widen the outcome CHECK — session_rule_deliveries '
            + 'still rejects written. Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v33→v34: written delivery outcome added (#1063)');
    }

    if (currentVersion < 35) {
      // v34→v35 (#1394): a lease records the reach its service INTENDS.
      //
      // A service that binds 127.0.0.1 is already stating that intent; nothing
      // wrote it down anywhere another process could read. The Caddyfile
      // divergence check needs exactly that fact to answer its fourth
      // property — a site fronting a port whose owner meant it to stay on
      // loopback is an exposure, and no amount of reading the Caddyfile alone
      // can tell the two apart.
      //
      // 'loopback' is the default because it is the weakest claim: a lease
      // that never said otherwise must not be read as permission to expose it.
      // Existing rows backfill to it for the same reason.
      //
      // Plain ADD COLUMN, not the rename-and-copy the CHECK-widening
      // migrations above needed: SQLite allows a CHECK on an added column, and
      // a constant NOT NULL default backfills every existing row in place.
      //
      // The ALTER is conditional because `_createTables` runs BEFORE migrations
      // and its CREATE TABLE IF NOT EXISTS already carries `reach`. An install
      // old enough to predate the port_leases table itself therefore arrives
      // here with the column already present, and an unconditional ALTER fails
      // the whole upgrade with "duplicate column name". The postcondition below
      // runs on BOTH paths, so the skip can never mean the constraint is
      // missing — which is the only reason skipping is safe.
      _db.exec('BEGIN IMMEDIATE');
      try {
        const hasReach = _db.prepare('PRAGMA table_info(port_leases)')
          .all().some((c) => c.name === 'reach');
        if (!hasReach) {
          _db.exec(
            "ALTER TABLE port_leases ADD COLUMN reach TEXT NOT NULL DEFAULT 'loopback' "
            + `CHECK(${REACH_CHECK_SQL})`
          );
        }
        // Postcondition, same rationale as the rebuilds above: PRAGMA
        // table_info cannot surface a CHECK clause, so read the DDL back and
        // confirm the constraint this migration exists to add is really there.
        // Without it a column added with no CHECK would accept any string and
        // the check would silently trust a value it cannot interpret.
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='port_leases'"
        ).get();
        if (!ddl || !ddl.sql || !ddl.sql.includes(REACH_CHECK_SQL)) {
          throw new Error(
            'v34→v35 did not add the reach CHECK to port_leases. '
            + 'Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v34→v35: reach column added to port_leases (#1394)');
    }

    if (currentVersion < 36) {
      // v35→36 (#1417): the users table — TangleClaw's own front door (ADR 0015).
      //
      // Read this before assuming the CREATE below is what makes the table
      // appear: it is not, on any path. `_createTables` runs BEFORE migrations
      // and its DDL already carries this table, so by the time this block is
      // reached the table exists whether the install is fresh or upgrading.
      // That is exactly why a NEW table needs no ALTER-style migration at all
      // — unlike v34→35 above, which added a column to a table older installs
      // already had.
      //
      // So what this block is FOR is the postcondition, and its reach is
      // narrower than it looks: `_createTables` seeds schema_version at CURRENT
      // on a fresh DB, so this never runs on a new install, and it never runs
      // again once an install is at 36. It protects exactly one population —
      // installs still below v36, which is where an already-present users table
      // of the wrong shape can actually be found. A fresh install's DDL is
      // guarded instead by the duplicate-username test, which reds if the
      // CREATE ever loses its UNIQUE. The CREATE stays, idempotent, so the
      // block is still correct in isolation if `_createTables` ever stops
      // carrying it.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _db.exec(
          'CREATE TABLE IF NOT EXISTS users ('
          + '  id            INTEGER PRIMARY KEY AUTOINCREMENT,'
          + '  username      TEXT NOT NULL UNIQUE,'
          + '  password_hash TEXT NOT NULL,'
          + "  created_at    TEXT NOT NULL DEFAULT (datetime('now')),"
          + '  disabled_at   TEXT'
          + ')'
        );
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
        ).get();
        // The UNIQUE on username is the part worth reading back. Without it two
        // rows can share a name and every lookup answers with whichever one
        // SQLite reaches first — on the login path that is an authentication
        // bug, not a data-tidiness one.
        //
        // Both spellings count. SQLite accepts the constraint on the column
        // (`username TEXT NOT NULL UNIQUE`) or on the table (`UNIQUE(username)`),
        // and a check that saw only the first would refuse a table that is
        // actually correct — failing safe, but failing a legitimate upgrade.
        const ddlSql = ddl && ddl.sql ? ddl.sql : '';
        const hasUnique = /username[^,]*UNIQUE/i.test(ddlSql)
          || /UNIQUE\s*\(\s*username\s*\)/i.test(ddlSql);
        if (!hasUnique) {
          throw new Error(
            'v35→36 did not create the users table with a UNIQUE username. '
            + 'Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v35→36: users table added (#1417)');
    }

    if (currentVersion < 37) {
      // v36→37 (#1418): auth_sessions — logged-in browser sessions for
      // TangleClaw's own gate.
      //
      // Same shape and same reasoning as v35→36 above: `_createTables` runs
      // first and already carries this DDL, so on every path the table exists
      // before this block is reached, and a fresh install never enters here at
      // all (its schema_version is seeded at CURRENT). What this block is for is
      // the postcondition — and the population it protects is installs still
      // below v37, the only place a wrongly-shaped auth_sessions can be found.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _db.exec(
          'CREATE TABLE IF NOT EXISTS auth_sessions ('
          + '  id         INTEGER PRIMARY KEY AUTOINCREMENT,'
          + '  token_hash TEXT NOT NULL UNIQUE,'
          + '  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,'
          + '  username   TEXT NOT NULL,'
          + '  csrf_token TEXT NOT NULL,'
          + "  created_at TEXT NOT NULL DEFAULT (datetime('now')),"
          + '  expires_at INTEGER NOT NULL'
          + ')'
        );
        _db.exec(
          'CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at)'
        );
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='auth_sessions'"
        ).get();
        // The UNIQUE on token_hash is what is read back, for the same reason
        // v35→36 reads back the UNIQUE on username: without it two rows can
        // share a token and a lookup answers with whichever SQLite reaches
        // first. On the session path that is an authentication bug.
        //
        // Both spellings count — SQLite accepts the constraint on the column or
        // on the table — so a check that saw only one would refuse a table that
        // is in fact correct.
        const ddlSql = ddl && ddl.sql ? ddl.sql : '';
        const hasUnique = /token_hash[^,]*UNIQUE/i.test(ddlSql)
          || /UNIQUE\s*\(\s*token_hash\s*\)/i.test(ddlSql);
        if (!hasUnique) {
          throw new Error(
            'v36→37 did not create the auth_sessions table with a UNIQUE token_hash. '
            + 'Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v36→37: auth_sessions table added (#1418)');
    }

    if (currentVersion < 38) {
      // v37→38 (#1420): recovery_codes. Same shape as v36→37: `_createTables`
      // already created it, so this block is the postcondition — refuse to
      // advance over a table whose code_hash is not UNIQUE, because a lookup
      // that can match two rows can consume the wrong account's code.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _db.exec(
          'CREATE TABLE IF NOT EXISTS recovery_codes ('
          + '  id                INTEGER PRIMARY KEY AUTOINCREMENT,'
          + '  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,'
          + '  code_hash         TEXT NOT NULL UNIQUE,'
          + '  created_at        INTEGER NOT NULL,'
          + '  used_at           INTEGER,'
          + '  used_from         TEXT,'
          + '  notice_cleared_at INTEGER'
          + ')'
        );
        _db.exec('CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id)');
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='recovery_codes'"
        ).get();
        const ddlSql = ddl && ddl.sql ? ddl.sql : '';
        const hasUnique = /code_hash[^,]*UNIQUE/i.test(ddlSql)
          || /UNIQUE\s*\(\s*code_hash\s*\)/i.test(ddlSql);
        if (!hasUnique) {
          throw new Error(
            'v37→38 did not create the recovery_codes table with a UNIQUE code_hash. '
            + 'Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v37→38: recovery_codes table added (#1420)');
    }

    if (currentVersion < 39) {
      // v38→39 (#1309, #1406): the launch baseline. A wrap needs to know where its
      // session started — the commit it measures "this session" from, and the files
      // that were already dirty and so belong to someone else. `_createTables` runs
      // first and already builds a fresh `sessions` at today's shape, so each column
      // is added only when table_info says it is missing; a try/catch around ALTER
      // would also swallow a real failure. Existing rows stay NULL: a session
      // launched before this has no baseline, and the wrap falls back for it.
      const have = new Set(_db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
      for (const col of ['launch_sha', 'launch_toplevel', 'launch_dirty']) {
        if (!have.has(col)) _db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
      }
      const after = new Set(_db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
      for (const col of ['launch_sha', 'launch_toplevel', 'launch_dirty']) {
        if (!after.has(col)) {
          throw new Error(`v38→39 did not add sessions.${col}. Refusing to advance schema_version.`);
        }
      }
      log.info('Migration v38→39: launch baseline columns added to sessions (#1309, #1406)');
    }

    if (currentVersion < 40) {
      // v39→40 (Train 21, #1579): the launch-sequence tables. `_createTables`
      // already built them, so this block is the postcondition, in the shape of
      // v36→37: refuse to advance over a launch_sequences table whose launch_id
      // is not UNIQUE, because the launch-id lookup must never answer with
      // another session's sequence.
      _db.exec('BEGIN IMMEDIATE');
      try {
        const ddlSql = (name) => {
          const row = _db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
          return row && row.sql ? row.sql : '';
        };
        const seqSql = ddlSql('launch_sequences');
        if (!/launch_id[^,]*UNIQUE/i.test(seqSql) && !/UNIQUE\s*\(\s*launch_id\s*\)/i.test(seqSql)) {
          throw new Error('v39→40 did not create launch_sequences with a UNIQUE launch_id. Refusing to advance schema_version.');
        }
        if (!/PRIMARY KEY\s*\(\s*sequence_id\s*,\s*revision\s*,\s*step_index\s*\)/i.test(ddlSql('launch_sequence_steps'))) {
          throw new Error('v39→40 did not create launch_sequence_steps keyed by (sequence_id, revision, step_index). Refusing to advance schema_version.');
        }
        const idx = _db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_launch_sequences_session'").get();
        if (!idx || !/UNIQUE/i.test(idx.sql || '')) {
          throw new Error('v39→40 did not create the unique session index on launch_sequences. Refusing to advance schema_version.');
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v39→40: launch sequence tables added (#1579)');
    }

    if (currentVersion < 41) {
      // v40→41 (Train 21, #1585): handoff_publications. `_createTables` already
      // built it, so this block is the postcondition, in the shape of v39→40:
      // refuse to advance over a table that cannot enforce attempt-exact
      // eligibility, because every guarantee the handoff makes rests on it.
      _db.exec('BEGIN IMMEDIATE');
      try {
        _assertHandoffPublicationSchema('v40→41');
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v40→41: handoff publication table added (#1585)');
    }

    if (currentVersion < 42) {
      _migrateHandoffEpoch(currentVersion);
    }

    if (currentVersion < 43) {
      _migrateLaunchRecovery();
    }

    if (currentVersion < 44) {
      // v43→v44 (#1381): a lease records whether its owner is a TangleClaw
      // project at all. Same shape and reasoning as v34→v35: a plain ADD
      // COLUMN (SQLite allows a CHECK on an added column, and the constant
      // default backfills in place), conditional because `_createTables` has
      // already created a missing table at the current shape, and a
      // postcondition that runs on both paths so the skip can never mean the
      // constraint is absent. Existing rows become 'project', which is what
      // every reader assumed of them before the field existed.
      _db.exec('BEGIN IMMEDIATE');
      try {
        const hasOwnerKind = _db.prepare('PRAGMA table_info(port_leases)')
          .all().some((c) => c.name === 'owner_kind');
        if (!hasOwnerKind) {
          _db.exec(
            "ALTER TABLE port_leases ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'project' "
            + `CHECK(${OWNER_KIND_CHECK_SQL})`
          );
        }
        const ddl = _db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='port_leases'"
        ).get();
        if (!ddl || !ddl.sql || !ddl.sql.includes(OWNER_KIND_CHECK_SQL)) {
          throw new Error(
            'v43→v44 did not add the owner_kind CHECK to port_leases. '
            + 'Refusing to advance schema_version.'
          );
        }
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
      log.info('Migration v43→v44: owner_kind column added to port_leases (#1381)');
    }

    if (currentVersion < 45) {
      _verifyStartupPromptTables();
      log.info('Migration v44→v45: startup prompt revisions and fires tables added (#1825)');
    }

    if (currentVersion < 46) {
      _migrateStartupControlV46();
      log.info('Migration v45→v46: fire receipts and the startupControl channels table (#1825 B2)');
    }

    if (currentVersion < 47) {
      _migrateStartupControlV47();
      log.info('Migration v46→v47: the automatic bootstrap\'s actor on fires and launch_sequences.startup_delivery (#1825 B3)');
    }

    if (currentVersion < 48) {
      _migrateControlStateV48();
      log.info('Migration v47→v48: durable HOLD/STOP control state (#1861)');
    }

    if (currentVersion < 49) {
      _migrateMedusaExchangesV49();
      log.info('Migration v48→v49: Medusa exchange state and facts for the delivery watchdog (#1839)');
    }

    // The version stamp, once. `_migrateHandoffEpoch` writes its own 42 inside
    // the transaction that initializes the epoch rows, because the marker and
    // the rows have to land or not land together — so this asks what is already
    // recorded rather than stamping unconditionally, which would put a second
    // row down for a version already stamped. A migration that only adds columns
    // has no such pairing and leaves the stamp to this line.
    const stamped = _db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
    if (!stamped || !(stamped.v >= CURRENT_SCHEMA_VERSION)) {
      _db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
    }
  }

  log.debug('Schema version', { version: CURRENT_SCHEMA_VERSION });
}

/**
 * Assert the handoff-publication table can still enforce attempt-exact
 * eligibility, and throw naming `label` if it cannot.
 *
 * Two migrations need this and neither may assume the other ran. v40→41 added
 * the table, so it checks what it just created; v41→42 depends on it but runs
 * on stores that entered ALREADY at 41 and therefore never passed through the
 * v40→41 gate at all. Sharing one function is what keeps the second check from
 * drifting into a weaker copy of the first — and it adds no new work to the old
 * gate, which runs exactly the assertions it always ran.
 *
 * @param {string} label - The migration saying so, for the error text
 * @returns {void}
 */
function _assertHandoffPublicationSchema(label) {
  const pubRow = _db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='handoff_publications'").get();
  const pubSql = (pubRow && pubRow.sql) || '';
  if (!pubSql) {
    throw new Error(`${label} did not create handoff_publications. Refusing to advance schema_version.`);
  }
  // A replayed stage within ONE run must collide rather than mint a second
  // publication for the same attempt.
  if (!/UNIQUE\s*\(\s*session_id\s*,\s*wrap_run_id\s*\)/i.test(pubSql)) {
    throw new Error(`${label} did not create handoff_publications with UNIQUE (session_id, wrap_run_id). Refusing to advance schema_version.`);
  }
  // seq orders attempts across the install; a duplicate would make
  // "no higher seq is published" unanswerable at finalize.
  if (!/seq[^,]*UNIQUE/i.test(pubSql)) {
    throw new Error(`${label} did not create handoff_publications with a UNIQUE seq. Refusing to advance schema_version.`);
  }
  const finalIdx = _db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_handoff_pub_final_eligible'").get();
  const finalSql = (finalIdx && finalIdx.sql) || '';
  if (!/UNIQUE/i.test(finalSql) || !/eligible_at IS NOT NULL/i.test(finalSql)) {
    throw new Error(`${label} did not create the partial unique index that keeps one eligible final per session. Refusing to advance schema_version.`);
  }
}

/**
 * Assert `project_handoff_epoch` carries the constraints the boundary rests on.
 *
 * The primary key is the load-bearing one: without it a project can hold two
 * boundaries, and "every session predates the epoch" has two answers. The CHECK
 * is read back because a baseline outside the vocabulary would be read by the
 * preflight as "not clean, not unclean" and fall out of both branches silently.
 *
 * @returns {void}
 */
function _assertHandoffEpochSchema() {
  const row = _db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_handoff_epoch'").get();
  const sql = (row && row.sql) || '';
  if (!sql) {
    throw new Error('v41→42 did not create project_handoff_epoch. Refusing to advance schema_version.');
  }
  // SQLite accepts the key on the column or on the table; a check that saw only
  // one spelling would refuse a table that is in fact correct.
  if (!/project_id[^,]*PRIMARY KEY/i.test(sql) && !/PRIMARY KEY\s*\(\s*project_id\s*\)/i.test(sql)) {
    throw new Error('v41→42 did not create project_handoff_epoch keyed by project_id. Refusing to advance schema_version.');
  }
  if (!/epoch_session_id[^,]*NOT NULL/i.test(sql)) {
    throw new Error('v41→42 did not create project_handoff_epoch with a NOT NULL epoch_session_id. Refusing to advance schema_version.');
  }
  if (!/recorded_at[^,]*NOT NULL/i.test(sql)) {
    throw new Error('v41→42 did not create project_handoff_epoch with a NOT NULL recorded_at. Refusing to advance schema_version.');
  }
  const check = /baseline\s+TEXT[^,]*CHECK\s*\(([^)]*)\)/i.exec(sql);
  const checkBody = check ? check[1] : '';
  for (const value of HANDOFF_BASELINE_VALUES) {
    if (!checkBody.includes(`'${value}'`)) {
      throw new Error(`v41→42 did not constrain project_handoff_epoch.baseline to include '${value}'. Refusing to advance schema_version.`);
    }
  }
}

/**
 * Assert one persisted epoch row is usable, and throw if it is not.
 *
 * A row that fails here is never quietly replaced. Replacing it would recompute
 * the boundary from today's sessions, which is the one thing the epoch exists to
 * prevent; refusing leaves the install visibly broken instead of silently
 * misclassified.
 *
 * @param {object} row - A `project_handoff_epoch` row, snake_case as stored
 * @returns {void}
 */
function _assertEpochRowValid(row) {
  const where = `project_handoff_epoch row for project ${row.project_id}`;
  if (!Number.isInteger(row.project_id)) {
    throw new Error(`Invalid ${where}: project_id is not an integer. Refusing to advance schema_version.`);
  }
  if (!Number.isInteger(row.epoch_session_id) || row.epoch_session_id < 0) {
    throw new Error(`Invalid ${where}: epoch_session_id is ${row.epoch_session_id}. Refusing to advance schema_version.`);
  }
  if (!HANDOFF_BASELINE_VALUES.includes(row.baseline)) {
    throw new Error(`Invalid ${where}: baseline is "${row.baseline}". Refusing to advance schema_version.`);
  }
  if (typeof row.recorded_at !== 'string' || row.recorded_at.length === 0) {
    throw new Error(`Invalid ${where}: recorded_at is empty. Refusing to advance schema_version.`);
  }
}

/**
 * Classify one project's handoff boundary, for a project that has none yet.
 *
 * @param {{id: number, path: string}} project - The project row
 * @param {boolean} boundaryIsReal - Whether THIS startup is the one crossing
 *   into handoff support. False for a store that was already at v41, where the
 *   instant handoffs began is simply not recorded anywhere.
 * @param {object} continuity - `lib/continuity`, passed in so the migration
 *   resolves it once rather than per project
 * @returns {{epochSessionId: number, baseline: string, baselineReason: string|null}}
 */
function _classifyHandoffBaseline(project, boundaryIsReal, continuity) {
  const history = _db.prepare(
    'SELECT COUNT(*) AS n, MAX(id) AS maxId FROM sessions WHERE project_id = ?'
  ).get(project.id);

  // No history: there is nothing to misclassify and nothing to be uncertain
  // about, on either entry version. Cutoff 0 means no session can ever be
  // "pre-epoch", which is what makes the legacy exception unreachable here.
  if (!history || history.n === 0) {
    return { epochSessionId: 0, baseline: HANDOFF_BASELINES.EMPTY, baselineReason: null };
  }

  const epochSessionId = history.maxId;

  // Already at v41: the cutoff below is TODAY's maximum, not the instant
  // handoffs began, and nothing on disk can recover that instant — session
  // timestamps, `schema_version.applied_at` and the absence of publication rows
  // are all consistent with several different boundaries. So it is recorded as
  // an observation and marked untrustworthy, which withholds the clean-legacy
  // exception without touching any other verdict.
  if (!boundaryIsReal) {
    return {
      epochSessionId,
      baseline: HANDOFF_BASELINES.UNCLEAN,
      baselineReason: EPOCH_UNKNOWN_FROM_V41
    };
  }

  const newest = _db.prepare(
    'SELECT status FROM sessions WHERE project_id = ? ORDER BY id DESC LIMIT 1'
  ).get(project.id);
  const indexPresent = Boolean(project.path)
    && fs.existsSync(continuity.indexPath(project.path));

  // Both conditions are named when they fail, because "unclean" on its own tells
  // an operator nothing about which half of the baseline was missing.
  const failures = [];
  if (!newest || newest.status !== SESSION_STATUS.WRAPPED) {
    failures.push(`newest pre-epoch session ended '${newest ? newest.status : 'unknown'}'`);
  }
  if (!indexPresent) failures.push('no continuity index on disk');

  if (failures.length > 0) {
    return {
      epochSessionId,
      baseline: HANDOFF_BASELINES.UNCLEAN,
      baselineReason: failures.join('; ')
    };
  }
  return { epochSessionId, baseline: HANDOFF_BASELINES.CLEAN, baselineReason: null };
}

/**
 * v41→42 (Train 21, #1586): record where handoffs began, per project.
 *
 * This is its own version rather than part of v40→41 because v41 has shipped.
 * The v40→41 gate runs only for `currentVersion < 41`, so initialization added
 * inside it would never reach a store that already took 41 — which is every
 * install that has run the shipped build. A new version fixes that reachability.
 * What it cannot do is reconstruct the boundary such a store never recorded;
 * `_classifyHandoffBaseline` handles that by recording uncertainty instead of
 * inventing a cutoff.
 *
 * **Everything here is one transaction, including the version stamp.** A store
 * that advertised 42 with the rows half-written would admit sessions against a
 * boundary that does not exist, and the launch path would read a missing row as
 * a project with no history. Rows, validation and marker land together or not at
 * all; on failure nothing is stamped and startup stops.
 *
 * `_createTables` runs before this and stamps a FRESH database at the current
 * version, so a new install never enters here. Its projects get their epoch from
 * `projects.create` instead, which is also the path every project created after
 * this migration takes.
 *
 * @param {number} currentVersion - The version the store entered this startup at
 * @returns {void}
 */
function _migrateHandoffEpoch(currentVersion) {
  const continuity = require('./continuity');
  const recordedAt = new Date().toISOString();
  // Below 41, THIS startup is the one crossing into handoff support, so the
  // maximum session id taken right now really is the boundary.
  const boundaryIsReal = currentVersion < 41;

  _db.exec('BEGIN IMMEDIATE');
  try {
    // The epoch draws a line in front of the publication table, so a store whose
    // publication schema cannot enforce attempt-exact eligibility has nothing
    // worth drawing a line in front of. A store that entered at 41 skipped the
    // gate that checked this, which is exactly why it is re-checked here.
    _assertHandoffPublicationSchema('v41→42');
    _assertHandoffEpochSchema();

    // A partial or retried upgrade may have left rows behind. They are preserved
    // exactly — cutoff, baseline and recorded_at — and validated rather than
    // recomputed.
    const existing = _db.prepare('SELECT * FROM project_handoff_epoch').all();
    for (const row of existing) _assertEpochRowValid(row);
    const haveEpoch = new Set(existing.map((r) => r.project_id));

    const insert = _db.prepare(
      'INSERT INTO project_handoff_epoch '
      + '(project_id, epoch_session_id, baseline, baseline_reason, recorded_at) VALUES (?, ?, ?, ?, ?)'
    );
    let initialized = 0;
    for (const project of _db.prepare('SELECT id, path FROM projects').all()) {
      if (haveEpoch.has(project.id)) continue;
      const boundary = _classifyHandoffBaseline(project, boundaryIsReal, continuity);
      insert.run(project.id, boundary.epochSessionId, boundary.baseline, boundary.baselineReason, recordedAt);
      initialized++;
    }

    // Coverage, read back from the database rather than counted in the loop: a
    // project the launch path finds without an epoch is the case this migration
    // exists to make impossible.
    const uncovered = _db.prepare(
      'SELECT COUNT(*) AS n FROM projects p '
      + 'WHERE NOT EXISTS (SELECT 1 FROM project_handoff_epoch e WHERE e.project_id = p.id)'
    ).get();
    if (uncovered.n > 0) {
      throw new Error(
        `v41→42 left ${uncovered.n} project(s) without a handoff epoch. Refusing to advance schema_version.`
      );
    }
    for (const row of _db.prepare('SELECT * FROM project_handoff_epoch').all()) _assertEpochRowValid(row);

    _db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(42);
    _db.exec('COMMIT');
    log.info('Migration v41→42: handoff epoch recorded (#1586)', {
      initialized,
      preserved: existing.length,
      boundaryIsReal
    });
  } catch (err) {
    try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  }
}

/**
 * The recovery columns a launch sequence must carry for the step-4 and READY
 * gates to have anything to read.
 *
 * Kept as data rather than written twice, because the fresh-database path
 * (`_createTables`) and the upgrade path below have to agree exactly: a store
 * created today and a store upgraded today differ in nothing a later reader can
 * see, and a column added to one and forgotten in the other is a difference no
 * test of either path alone can find.
 */
const LAUNCH_RECOVERY_COLUMNS = Object.freeze([
  ['recovery', "TEXT NOT NULL DEFAULT 'none' CHECK (recovery IN ('none','required','cleared'))"],
  ['recovery_mode', "TEXT NOT NULL DEFAULT 'operator' CHECK (recovery_mode IN ('operator','advisory'))"],
  ['recovery_revision', 'INTEGER NOT NULL DEFAULT 1'],
  ['recovery_cleared_at', 'TEXT'],
  ['recovery_cleared_by', 'TEXT'],
  ['recovery_clearance',
    "TEXT CHECK (recovery_clearance IN ('operator-verified','open-install-unverified','agent-reconciled'))"]
]);

/**
 * The `startup_prompt_fires` DDL, for the boot-time create and for the v46
 * rebuild, so the two cannot drift. `payload` is the launch-start payload a
 * fire was bound to, WITHOUT the launch bearer; `payload_digest` is what the
 * engine echoes back as the receipt's binding.
 * @param {string} table - Table name to create.
 * @returns {string} A CREATE TABLE statement.
 */
function _startupPromptFiresDdl(table) {
  return `CREATE TABLE IF NOT EXISTS ${table} (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Transport idempotency: a repeat of the same key returns this row.
      idempotency_key    TEXT    NOT NULL UNIQUE,
      project_id         INTEGER NOT NULL,
      session_id         INTEGER NOT NULL,
      sequence_id        INTEGER NOT NULL,
      prompt_revision    INTEGER NOT NULL,
      prompt_text_digest TEXT    NOT NULL,
      policy_digest      TEXT    NOT NULL,
      caller_kind        TEXT    NOT NULL CHECK (caller_kind IN (${STARTUP_FIRE_CALLER_KINDS_SQL})),
      caller_clearance   TEXT    NOT NULL CHECK (caller_clearance IN (${STARTUP_FIRE_CLEARANCES_SQL})),
      caller_project_id  INTEGER,
      outcome            TEXT    NOT NULL CHECK (outcome IN (${STARTUP_FIRE_OUTCOMES_SQL})),
      reason_code        TEXT    CHECK (reason_code IS NULL OR reason_code IN (${STARTUP_FIRE_REASON_CODES_SQL})),
      reason             TEXT    CHECK (reason IS NULL OR length(reason) <= 500),
      payload            TEXT,
      payload_digest     TEXT,
      engine_thread_id   TEXT,
      engine_turn_id     TEXT,
      dispatched_at      TEXT,
      accepted_at        TEXT,
      settled_at         TEXT,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
    );`;
}

/**
 * The indexes on `startup_prompt_fires`, shared by the boot-time create and
 * the v46 rebuild.
 * @returns {string} CREATE INDEX statements.
 */
function _startupPromptFiresIndexesSql() {
  return `CREATE INDEX IF NOT EXISTS idx_startup_prompt_fires_session ON startup_prompt_fires(session_id);
    -- At most one fire ACTIVE per launch, whatever revision it carries.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_startup_prompt_fires_active
      ON startup_prompt_fires(sequence_id) WHERE outcome IN (${STARTUP_FIRE_ACTIVE_SQL});
    -- A revision APPLIED to a launch is never injected into it again. Other
    -- outcomes (unsupported, failed, ...) do not hold this key: whether they
    -- may be retried is an explicit decision the dispatching adapter makes.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_startup_prompt_fires_applied
      ON startup_prompt_fires(sequence_id, prompt_revision) WHERE outcome = 'applied';`;
}

/** The columns v45 gave `startup_prompt_fires`, copied verbatim by the v46 rebuild. */
const _STARTUP_FIRES_V45_COLUMNS = 'id, idempotency_key, project_id, session_id, sequence_id, prompt_revision, '
  + 'prompt_text_digest, policy_digest, caller_kind, caller_clearance, caller_project_id, outcome, reason_code, reason, '
  + 'created_at, updated_at';

/**
 * The CREATE statement SQLite holds for a table or index, or '' when there is
 * none. The migrations and their postconditions read shapes from this rather
 * than from what they believe they wrote.
 * @param {string} name - Table or index name.
 * @returns {string}
 */
function _tableDdl(name) {
  const row = _db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name);
  return row && row.sql ? row.sql : '';
}

/**
 * DDL for the durable HOLD/STOP control state (#1861).
 *
 * Two mutable caches and two append-only logs. `control_assignments` and
 * `control_holds` are rewritten only inside the transaction that appends the
 * `control_events` row changing them, so replaying the events in `seq` order
 * rebuilds both. `control_events` is the state history and `control_receipts`
 * the delivery/acknowledgement history; triggers make both refuse UPDATE and
 * DELETE, because an audit row that can be edited after the fact audits
 * nothing. Receipts never move `state_generation`: delivery is a fact about a
 * state, not a change to it.
 *
 * Idempotent (`IF NOT EXISTS` throughout), so `_createTables` and the v48
 * migration share it.
 * @returns {string}
 */
function _controlTablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS control_assignments (
      assignment_id     TEXT    PRIMARY KEY,
      project_id        INTEGER NOT NULL,
      issue_ref         TEXT    CHECK (issue_ref IS NULL OR length(issue_ref) <= 64),
      authority_json    TEXT    NOT NULL CHECK (length(authority_json) <= 4096),
      bound_session_id  INTEGER,
      bound_launch_id   TEXT,
      state             TEXT    NOT NULL CHECK (state IN ('active','held','stopped','closed')),
      state_generation  INTEGER NOT NULL CHECK (state_generation >= 1),
      created_by_kind   TEXT    NOT NULL,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      stopped_at        TEXT,
      closed_at         TEXT,
      superseded_by     TEXT,
      CHECK ((state = 'closed') = (closed_at IS NOT NULL))
    );
    -- One open assignment per project: a stopped one stays open (it still
    -- governs) until an operator successor supersedes it.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_assignments_open
      ON control_assignments(project_id) WHERE closed_at IS NULL;

    CREATE TABLE IF NOT EXISTS control_holds (
      hold_id               TEXT    PRIMARY KEY,
      assignment_id         TEXT    NOT NULL,
      issuer_principal      TEXT    NOT NULL,
      opened_generation     INTEGER NOT NULL,
      released_generation   INTEGER,
      released_by_event_id  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_control_holds_assignment ON control_holds(assignment_id);

    CREATE TABLE IF NOT EXISTS control_events (
      seq                   INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id              TEXT    NOT NULL UNIQUE,
      assignment_id         TEXT    NOT NULL,
      kind                  TEXT    NOT NULL CHECK (kind IN ('create','hold','release','stop','close','rebind')),
      state_generation      INTEGER NOT NULL,
      issuer_principal      TEXT    NOT NULL,
      operator_proof        TEXT    CHECK (operator_proof IS NULL OR operator_proof IN ('verified-session','ambient-open')),
      reason_code           TEXT    NOT NULL CHECK (length(reason_code) <= 40),
      request_id            TEXT    NOT NULL CHECK (length(request_id) <= 128),
      expected_generation   INTEGER,
      target_hold_ids_json  TEXT    CHECK (target_hold_ids_json IS NULL OR length(target_hold_ids_json) <= 4096),
      created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (assignment_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_control_events_assignment ON control_events(assignment_id, seq);
    -- A create's request id has no assignment yet to scope it, so it is unique
    -- across creates: a replayed create returns the assignment it made.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_control_events_create_request
      ON control_events(request_id) WHERE kind = 'create';

    CREATE TABLE IF NOT EXISTS control_receipts (
      receipt_seq      INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         TEXT    NOT NULL,
      fact             TEXT    NOT NULL CHECK (fact IN ('notify_pending','notify_attempted','observed','acknowledged','exchange_closed')),
      outcome_code     TEXT    CHECK (outcome_code IS NULL OR length(outcome_code) <= 40),
      actor_principal  TEXT,
      -- The Medusa message id of the notice a notify_attempted receipt sent,
      -- so the target marking that message handled can be recorded as the
      -- target having observed the state.
      notice_ref       TEXT    CHECK (notice_ref IS NULL OR length(notice_ref) <= 128),
      at               TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_control_receipts_event ON control_receipts(event_id, receipt_seq);
    CREATE INDEX IF NOT EXISTS idx_control_receipts_notice ON control_receipts(notice_ref) WHERE notice_ref IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS control_events_append_only_update
      BEFORE UPDATE ON control_events
      BEGIN SELECT RAISE(ABORT, 'control_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS control_events_append_only_delete
      BEFORE DELETE ON control_events
      BEGIN SELECT RAISE(ABORT, 'control_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS control_receipts_append_only_update
      BEFORE UPDATE ON control_receipts
      BEGIN SELECT RAISE(ABORT, 'control_receipts is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS control_receipts_append_only_delete
      BEFORE DELETE ON control_receipts
      BEGIN SELECT RAISE(ABORT, 'control_receipts is append-only'); END;
  `;
}

/**
 * v47→v48: add the control-state tables (#1861), then prove they carry the
 * constraints the control plane rests on before the version advances.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateControlStateV48() {
  _startupControlTransaction(() => _db.exec(_controlTablesDdl()));
  _verifyControlTablesV48();
}

/**
 * The v48 postcondition: all four tables, the one-open-per-project index, the
 * create idempotency index and the four append-only triggers exist.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyControlTablesV48() {
  const refuse = (what) => {
    throw new Error(`v47→v48 left ${what}. Refusing to advance schema_version.`);
  };
  for (const table of ['control_assignments', 'control_holds', 'control_events', 'control_receipts']) {
    if (!_tableDdl(table)) refuse(`no ${table} table`);
  }
  if (!/UNIQUE/i.test(_tableDdl('idx_control_assignments_open'))) refuse('no one-open-assignment-per-project index');
  if (!/UNIQUE/i.test(_tableDdl('idx_control_events_create_request'))) refuse('no create idempotency index');
  for (const trigger of [
    'control_events_append_only_update', 'control_events_append_only_delete',
    'control_receipts_append_only_update', 'control_receipts_append_only_delete'
  ]) {
    if (!/RAISE\s*\(\s*ABORT/i.test(_tableDdl(trigger))) refuse(`no ${trigger} trigger`);
  }
}

/**
 * DDL for the Medusa delivery watchdog's durable exchange state (#1839).
 *
 * An exchange is one ordinary Medusa message to one recipient, tracked from
 * the sender's intent to its terminal outcome. The Hub keeps the body; these
 * tables keep what happened to it, keyed by the Hub's message id once the Hub
 * has returned one.
 *
 * `medusa_exchange_facts` is the truth and is append-only (triggers refuse
 * UPDATE and DELETE). `medusa_exchanges` is a projection of those facts plus
 * the fixed send-time metadata: arrival, wake, read, ack and reply facts can
 * race or land out of order, so the projection is recomputed from the facts
 * rather than stepped through a fixed sequence, and `replay` must reproduce
 * it exactly. Only terminal outcomes (closed, retracted, undeliverable,
 * recipient_retired) are guarded transitions with a single winner.
 *
 * Control notices and escalation notices never get a row here. That is what
 * keeps HOLD/STOP/RELEASE out of reach of anything that acts on exchanges,
 * retraction included.
 *
 * Idempotent (`IF NOT EXISTS` throughout), so `_createTables` and the v49
 * migration share it. Nothing prunes these rows: retention needs its own
 * admitted policy.
 * @returns {string}
 */
function _medusaExchangeTablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS medusa_exchanges (
      exchange_id            TEXT    PRIMARY KEY,
      request_id             TEXT    NOT NULL UNIQUE CHECK (length(request_id) <= 128),
      hub_id                 TEXT    CHECK (hub_id IS NULL OR length(hub_id) <= 128),
      origin                 TEXT    NOT NULL CHECK (origin IN ('send','arrival')),
      tracking               TEXT    NOT NULL CHECK (tracking IN ('tracked','untracked')),
      sender_project_id      INTEGER,
      sender_session_id      TEXT,
      sender_workspace_id    TEXT    CHECK (sender_workspace_id IS NULL OR length(sender_workspace_id) <= 128),
      sender_verified        INTEGER NOT NULL DEFAULT 0 CHECK (sender_verified IN (0,1)),
      sender_proof           TEXT    CHECK (sender_proof IS NULL OR sender_proof IN ('launch','verified-session','ambient-open','system')),
      recipient_workspace_id TEXT    NOT NULL CHECK (length(recipient_workspace_id) <= 128),
      recipient_project_id   INTEGER,
      recipient_session_id   TEXT,
      priority               TEXT    NOT NULL CHECK (priority IN ('normal','blocking','critical')),
      reply_required         INTEGER NOT NULL CHECK (reply_required IN (0,1)),
      escalate_after_ms      INTEGER CHECK (escalate_after_ms IS NULL OR escalate_after_ms > 0),
      reason_code            TEXT    CHECK (reason_code IS NULL OR length(reason_code) <= 40),
      in_reply_to            TEXT    CHECK (in_reply_to IS NULL OR length(in_reply_to) <= 64),
      created_at             TEXT    NOT NULL,
      -- The projection: every column below is recomputed from the facts.
      state                  TEXT    NOT NULL CHECK (state IN (
                               'send_pending','send_unknown','stored','delivered',
                               'wake_pending','wake_blocked','wake_attempted','wake_not_accepted','wake_accepted',
                               'read','acknowledged','replied',
                               'closed','retracted','undeliverable','recipient_retired','untracked')),
      wake_code              TEXT    CHECK (wake_code IS NULL OR length(wake_code) <= 40),
      esc_level              TEXT    NOT NULL DEFAULT 'none'
                               CHECK (esc_level IN ('none','aged','escalated','operator')),
      rearm_count            INTEGER NOT NULL DEFAULT 0 CHECK (rearm_count >= 0),
      next_eligible_at       TEXT,
      terminal_at            TEXT,
      terminal_by            TEXT    CHECK (terminal_by IS NULL OR length(terminal_by) <= 64),
      terminal_code          TEXT    CHECK (terminal_code IS NULL OR length(terminal_code) <= 40),
      replacement_hub_id     TEXT    CHECK (replacement_hub_id IS NULL OR length(replacement_hub_id) <= 128),
      updated_at             TEXT    NOT NULL
    );
    -- A Hub id names one message. A send learns it only after the Hub
    -- answers, and the Hub can push the message to a recipient on this host
    -- before that answer returns, so one send row and one arrival row may
    -- share it until the send adopts the arrival.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_medusa_exchanges_hub
      ON medusa_exchanges(hub_id, origin) WHERE hub_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_medusa_exchanges_recipient ON medusa_exchanges(recipient_workspace_id, state);
    CREATE INDEX IF NOT EXISTS idx_medusa_exchanges_sender ON medusa_exchanges(sender_project_id, state);
    CREATE INDEX IF NOT EXISTS idx_medusa_exchanges_open
      ON medusa_exchanges(created_at) WHERE terminal_at IS NULL AND tracking = 'tracked';

    CREATE TABLE IF NOT EXISTS medusa_exchange_facts (
      fact_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange_id  TEXT    NOT NULL,
      fact         TEXT    NOT NULL CHECK (fact IN (
                     'send_pending','hub_accepted','send_unknown','send_refused','arrived',
                     'wake_pending','wake_blocked','wake_attempted','wake_not_accepted','wake_accepted','rearmed',
                     'readiness_changed',
                     'read','acknowledged','replied',
                     'closed','retracted','undeliverable','recipient_retired',
                     'aged','escalated','escalation_queued','escalation_accepted','escalation_failed','escalation_undeliverable',
                     'operator_alerted')),
      code         TEXT    CHECK (code IS NULL OR length(code) <= 40),
      actor        TEXT    CHECK (actor IS NULL OR length(actor) <= 64),
      proof        TEXT    CHECK (proof IS NULL OR length(proof) <= 40),
      detail_json  TEXT    CHECK (detail_json IS NULL OR length(detail_json) <= 1024),
      at           TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_medusa_exchange_facts_exchange ON medusa_exchange_facts(exchange_id, fact_seq);

    CREATE TRIGGER IF NOT EXISTS medusa_exchange_facts_append_only_update
      BEFORE UPDATE ON medusa_exchange_facts
      BEGIN SELECT RAISE(ABORT, 'medusa_exchange_facts is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS medusa_exchange_facts_append_only_delete
      BEFORE DELETE ON medusa_exchange_facts
      BEGIN SELECT RAISE(ABORT, 'medusa_exchange_facts is append-only'); END;
  `;
}

/**
 * v48→v49: add the Medusa exchange tables (#1839), then prove they carry the
 * constraints the watchdog rests on before the version advances. Purely
 * additive, so a v48 server that meets a v49 store ignores the new tables and
 * the rows survive a rollback and re-upgrade.
 * @returns {void}
 * @throws {Error} When a postcondition fails.
 */
function _migrateMedusaExchangesV49() {
  _startupControlTransaction(() => _db.exec(_medusaExchangeTablesDdl()));
  _verifyMedusaExchangeTablesV49();
}

/**
 * The v49 postcondition: both tables, the Hub-id uniqueness index and both
 * append-only triggers exist.
 * @returns {void}
 * @throws {Error} When any is missing.
 */
function _verifyMedusaExchangeTablesV49() {
  const refuse = (what) => {
    throw new Error(`v48→v49 left ${what}. Refusing to advance schema_version.`);
  };
  for (const table of ['medusa_exchanges', 'medusa_exchange_facts']) {
    if (!_tableDdl(table)) refuse(`no ${table} table`);
  }
  if (!/UNIQUE/i.test(_tableDdl('idx_medusa_exchanges_hub'))) refuse('no Hub-id uniqueness index');
  for (const trigger of ['medusa_exchange_facts_append_only_update', 'medusa_exchange_facts_append_only_delete']) {
    if (!/RAISE\s*\(\s*ABORT/i.test(_tableDdl(trigger))) refuse(`no ${trigger} trigger`);
  }
}

/** Every column v46 gave `startup_prompt_fires`, copied verbatim by the v47 rebuild. */
const _STARTUP_FIRES_V46_COLUMNS = `${_STARTUP_FIRES_V45_COLUMNS}, payload, payload_digest, engine_thread_id, engine_turn_id, `
  + 'dispatched_at, accepted_at, settled_at';

/**
 * v46→v47 (#1825 B3): the automatic bootstrap's actor on `startup_prompt_fires`
 * (`caller_kind` gains `launch`, `caller_clearance` gains `launch-automatic`),
 * and `launch_sequences.startup_delivery`, the durable record of which path a
 * launch selected.
 *
 * The fires table is rebuilt the way v46 rebuilt it — a CHECK cannot be
 * altered in place — inside one `BEGIN IMMEDIATE`, every row copied by name
 * and counted, the indexes recreated. The sequence column is additive with a
 * default of `legacy`, which is the truth for every launch made before it
 * existed. Idempotent; the postcondition refuses to advance over a half-built
 * result.
 * @returns {void}
 */
function _migrateStartupControlV47() {
  const ddl = _tableDdl;
  _db.exec('BEGIN IMMEDIATE');
  try {
    const fires = ddl('startup_prompt_fires');
    if (!fires.includes("'launch'") || !fires.includes("'launch-automatic'") || !fires.includes("'pane_not_ready'")) {
      _db.exec(_startupPromptFiresDdl('startup_prompt_fires_v47'));
      _db.exec(
        `INSERT INTO startup_prompt_fires_v47 (${_STARTUP_FIRES_V46_COLUMNS}) `
        + `SELECT ${_STARTUP_FIRES_V46_COLUMNS} FROM startup_prompt_fires`
      );
      const before = _db.prepare('SELECT COUNT(*) AS n FROM startup_prompt_fires').get().n;
      const after = _db.prepare('SELECT COUNT(*) AS n FROM startup_prompt_fires_v47').get().n;
      if (before !== after) throw new Error(`v46→v47 copied ${after} of ${before} fire rows. Refusing to advance schema_version.`);
      _db.exec('DROP TABLE startup_prompt_fires');
      _db.exec('ALTER TABLE startup_prompt_fires_v47 RENAME TO startup_prompt_fires');
      _db.exec(_startupPromptFiresIndexesSql());
    }
    if (!/startup_delivery/i.test(ddl('launch_sequences'))) {
      _db.exec(`ALTER TABLE launch_sequences ADD COLUMN startup_delivery TEXT NOT NULL DEFAULT 'legacy' `
        + `CHECK (startup_delivery IN (${STARTUP_DELIVERIES_SQL}))`);
    }
    _db.exec('COMMIT');
  } catch (err) {
    try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  }
  _verifyStartupControlTables('v46→v47');
  _verifyStartupControlTablesV47();
}

/**
 * The v47 postcondition: the fires table's actor CHECKs name the launch caller
 * and the sequence table carries `startup_delivery` with its CHECK.
 * @returns {void}
 * @throws {Error} When either is missing.
 */
function _verifyStartupControlTablesV47() {
  const ddl = _tableDdl;
  const refuse = (what) => {
    throw new Error(`v46→v47 left ${what}. Refusing to advance schema_version.`);
  };
  const fires = ddl('startup_prompt_fires');
  for (const kind of STARTUP_FIRE_CALLER_KINDS) {
    if (!fires.includes(`'${kind}'`)) refuse(`startup_prompt_fires whose caller_kind CHECK lacks ${kind}`);
  }
  for (const clearance of STARTUP_FIRE_CLEARANCES) {
    if (!fires.includes(`'${clearance}'`)) refuse(`startup_prompt_fires whose caller_clearance CHECK lacks ${clearance}`);
  }
  if (!ddl('idx_startup_prompt_fires_active')) refuse('no one-active-fire-per-launch index');
  if (!ddl('idx_startup_prompt_fires_applied')) refuse('no applied-is-never-reinjected index');
  if (!ddl('idx_startup_prompt_fires_session')) refuse('no fires-by-session index');
  if (!/startup_delivery[^,]*CHECK\s*\(\s*startup_delivery\s+IN/i.test(ddl('launch_sequences'))) refuse('launch_sequences without startup_delivery and its CHECK');
}

/**
 * v45→v46 (#1825): the receipt columns on `startup_prompt_fires`
 * and the wider `reason_code` CHECK the Codex adapter needs, plus the
 * `startup_control_channels` table (created by the boot-time block).
 *
 * SQLite cannot alter a CHECK constraint in place, so the table is rebuilt:
 * a new table with the v46 DDL, every row copied by name, the old table
 * dropped, the new one renamed, the indexes recreated — one `BEGIN
 * IMMEDIATE`, so a crash leaves either the old table or the new one, never
 * both or neither. Idempotent: a table already carrying the v46 shape is
 * left alone. The postcondition refuses to let the version advance over a
 * half-built result.
 * @returns {void}
 */
function _migrateStartupControlV46() {
  const ddl = _tableDdl;
  const current = ddl('startup_prompt_fires');
  const hasShape = /payload_digest/i.test(current) && current.includes("'trust_required'");
  if (!hasShape) {
    _db.exec('BEGIN IMMEDIATE');
    try {
      _db.exec(_startupPromptFiresDdl('startup_prompt_fires_v46'));
      _db.exec(
        `INSERT INTO startup_prompt_fires_v46 (${_STARTUP_FIRES_V45_COLUMNS}) `
        + `SELECT ${_STARTUP_FIRES_V45_COLUMNS} FROM startup_prompt_fires`
      );
      const before = _db.prepare('SELECT COUNT(*) AS n FROM startup_prompt_fires').get().n;
      const after = _db.prepare('SELECT COUNT(*) AS n FROM startup_prompt_fires_v46').get().n;
      if (before !== after) throw new Error(`v45→v46 copied ${after} of ${before} fire rows. Refusing to advance schema_version.`);
      _db.exec('DROP TABLE startup_prompt_fires');
      _db.exec('ALTER TABLE startup_prompt_fires_v46 RENAME TO startup_prompt_fires');
      _db.exec(_startupPromptFiresIndexesSql());
      _db.exec('COMMIT');
    } catch (err) {
      try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw err;
    }
  }
  _verifyStartupControlTables();
}

/**
 * The v46 postcondition: refuse to advance the schema version unless the
 * fires table carries the receipt columns and the widened CHECK, its indexes
 * survived the rebuild, and the channels table exists with its one-open rule.
 * The v47 rebuild re-runs it under its own label, because it rebuilds the same
 * table and owes the same shape.
 * @param {string} [migration='v45→v46'] - Which migration the refusal names.
 * @returns {void}
 * @throws {Error} When any of those is missing.
 */
function _verifyStartupControlTables(migration = 'v45→v46') {
  const ddl = _tableDdl;
  const refuse = (what) => {
    throw new Error(`${migration} left ${what}. Refusing to advance schema_version.`);
  };
  const fires = ddl('startup_prompt_fires');
  for (const col of ['payload', 'payload_digest', 'engine_thread_id', 'engine_turn_id', 'dispatched_at', 'accepted_at', 'settled_at']) {
    if (!new RegExp(`\\b${col}\\b`).test(fires)) refuse(`startup_prompt_fires without ${col}`);
  }
  for (const code of STARTUP_FIRE_REASON_CODES) {
    if (!fires.includes(`'${code}'`)) refuse(`startup_prompt_fires whose reason_code CHECK lacks ${code}`);
  }
  if (!/idempotency_key\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(fires)) refuse('startup_prompt_fires without its idempotency key');
  if (!ddl('idx_startup_prompt_fires_active')) refuse('no one-active-fire-per-launch index');
  if (!ddl('idx_startup_prompt_fires_applied')) refuse('no applied-is-never-reinjected index');
  if (!ddl('idx_startup_prompt_fires_session')) refuse('no fires-by-session index');
  const channels = ddl('startup_control_channels');
  if (!/state[^,]*CHECK\s*\(\s*state\s+IN/i.test(channels)) refuse('startup_control_channels without its state CHECK');
  if (!/adapter_state/i.test(channels)) refuse('startup_control_channels without adapter_state');
  if (!ddl('idx_startup_control_channels_open')) refuse('no one-open-channel-per-session index');
}

/**
 * v44→45 (#1825): verify the startup prompt tables.
 *
 * `_createTables` has already created both tables and seeded revision 1 by the
 * time this runs, so the migration's work is to refuse to advance the schema
 * version if either table lacks a constraint its readers rely on: the
 * provenance and outcome CHECKs, the idempotency key, the active-fire and
 * applied-fire indexes, and the seed.
 *
 * @throws {Error} When any of those is missing.
 */
function _verifyStartupPromptTables() {
  const ddl = _tableDdl;
  const refuse = (what) => {
    throw new Error(`v44→v45 left ${what}. Refusing to advance schema_version.`);
  };
  const revisions = ddl('startup_prompt_revisions');
  if (!/created_by_kind[^,]*CHECK\s*\(\s*created_by_kind\s+IN/i.test(revisions)) {
    refuse('startup_prompt_revisions without its created_by_kind CHECK');
  }
  if (!/policy_digest/i.test(revisions)) refuse('startup_prompt_revisions without policy_digest');
  const fires = ddl('startup_prompt_fires');
  if (!/outcome[^,]*CHECK\s*\(\s*outcome\s+IN/i.test(fires)) refuse('startup_prompt_fires without its outcome CHECK');
  if (!/idempotency_key\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(fires)) refuse('startup_prompt_fires without its idempotency key');
  if (!ddl('idx_startup_prompt_fires_active')) refuse('no one-active-fire-per-launch index');
  if (!ddl('idx_startup_prompt_fires_applied')) refuse('no applied-is-never-reinjected index');
  const seeded = _db.prepare('SELECT 1 FROM startup_prompt_revisions WHERE revision = 1').get();
  if (!seeded) {
    throw new Error('v44→v45 found no revision 1 of the startup prompt. Refusing to advance schema_version.');
  }
}

/**
 * Current revision, write and fire-audit access to the startup prompt (#1825).
 * The service in `lib/startup-prompt.js` is the only caller; routes go through
 * it so the dashboard and the API share one path.
 */
/**
 * Run `fn` inside one `BEGIN IMMEDIATE` transaction and return its result:
 * the one write-serializing wrapper the startupControl APIs share. A fire's
 * checks and its intent row are one decision, and a channel's state merge is
 * a read-modify-write; this keeps two concurrent callers from both passing.
 * @param {() => *} fn - Synchronous work.
 * @returns {*} Whatever `fn` returns.
 */
function _startupControlTransaction(fn) {
  _ensureDb();
  _db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    _db.exec('COMMIT');
    return out;
  } catch (err) {
    try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
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
 * Run `fn` atomically whether or not the caller holds a transaction.
 *
 * A SAVEPOINT, not a BEGIN: `insertFire` always runs inside the fire service's
 * `BEGIN IMMEDIATE`, the channel writers usually run outside one, and SQLite
 * refuses a nested BEGIN. A savepoint is legal in both places — outside a
 * transaction it opens one and RELEASE commits it; inside one it is a nested
 * scope that RELEASE folds into the caller's — so ownership never has to be
 * sniffed from the runtime (a `DatabaseSync.isTransaction` probe would need a
 * Node minor the product's declared floor does not guarantee).
 * @param {() => *} fn - Synchronous work.
 * @returns {*}
 */
function _startupControlAtomic(fn) {
  _db.exec('SAVEPOINT startup_control_atomic');
  try {
    const out = fn();
    _db.exec('RELEASE startup_control_atomic');
    return out;
  } catch (err) {
    try {
      _db.exec('ROLLBACK TO startup_control_atomic');
      _db.exec('RELEASE startup_control_atomic');
    } catch { /* the caller's transaction, if any, decides what happens next */ }
    throw err;
  }
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
    _startupControlAtomic(() => _trimStartupFires(fire.projectId));
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
   *   `reason`, `engineThreadId`, `engineTurnId`. Timestamps are stamped from
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
      const terminal = STARTUP_FIRE_TERMINAL.includes(next);
      _db.prepare(
        `UPDATE startup_prompt_fires
            SET outcome = ?, reason_code = ?, reason = ?,
                engine_thread_id = COALESCE(?, engine_thread_id),
                engine_turn_id = COALESCE(?, engine_turn_id),
                dispatched_at = CASE WHEN ? = 'dispatching' THEN COALESCE(dispatched_at, datetime('now')) ELSE dispatched_at END,
                accepted_at = CASE WHEN ? = 'accepted' THEN COALESCE(accepted_at, datetime('now')) ELSE accepted_at END,
                settled_at = CASE WHEN ? THEN COALESCE(settled_at, datetime('now')) ELSE settled_at END,
                updated_at = datetime('now')
          WHERE id = ?`
      ).run(next, reasonCode, reason, patch.engineThreadId || null, patch.engineTurnId || null,
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
    dispatchedAt: row.dispatched_at || null,
    acceptedAt: row.accepted_at || null,
    settledAt: row.settled_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

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
    return _startupControlAtomic(() => _trimStartupChannels(session.project_id));
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
 * v42→43 (Train 21, #1587): the recovery columns on `launch_sequences`.
 *
 * Additive, and deliberately so. Every existing row takes `recovery = 'none'`,
 * `recovery_mode = 'operator'` and `recovery_revision = 1`: a launch that
 * happened before the gate existed was never told it owed a recovery, and
 * defaulting live panes to `required` would strand every session mid-launch
 * behind a clear nobody knew to give. The gate applies from the next launch on,
 * where a preflight verdict actually decided it.
 *
 * `_createTables` runs first and builds a fresh table already carrying these
 * columns, so each one is added only when `table_info` says it is missing —
 * which also makes a retried or half-applied upgrade a no-op rather than an
 * error. The postcondition then reads the DDL back, because `PRAGMA table_info`
 * cannot surface a CHECK clause and a column without its CHECK would accept the
 * clearance values this car exists to keep apart.
 */
function _migrateLaunchRecovery() {
  _db.exec('BEGIN IMMEDIATE');
  try {
    const have = new Set(_db.prepare('PRAGMA table_info(launch_sequences)').all().map((c) => c.name));
    for (const [name, decl] of LAUNCH_RECOVERY_COLUMNS) {
      if (!have.has(name)) _db.exec(`ALTER TABLE launch_sequences ADD COLUMN ${name} ${decl}`);
    }
    const after = new Set(_db.prepare('PRAGMA table_info(launch_sequences)').all().map((c) => c.name));
    for (const [name] of LAUNCH_RECOVERY_COLUMNS) {
      if (!after.has(name)) {
        throw new Error(`v42→43 did not add launch_sequences.${name}. Refusing to advance schema_version.`);
      }
    }
    const ddl = _db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='launch_sequences'").get();
    const sql = ddl && ddl.sql ? ddl.sql : '';
    for (const [name, decl] of LAUNCH_RECOVERY_COLUMNS) {
      if (!decl.includes('CHECK')) continue;
      // The column's own CHECK, not merely the words somewhere in the table: a
      // regex anchored to the column name is what tells "this column is
      // constrained" from "some column is".
      const constrained = new RegExp(`${name}[^,]*CHECK\\s*\\(\\s*${name}\\s+IN`, 'i').test(sql);
      if (!constrained) {
        throw new Error(
          `v42→43 left launch_sequences.${name} without its CHECK constraint. Refusing to advance schema_version.`
        );
      }
    }
    _db.exec('COMMIT');
  } catch (err) {
    try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  }
  log.info('Migration v42→43: launch recovery columns added (#1587)');
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
    _db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
};

// ── Sessions (store layer only — lifecycle in lib/sessions.js) ──

/**
 * The session lifecycle vocabulary (#1034). `active` is the only non-terminal
 * status; the other three each record HOW a session stopped, and nothing
 * follows them.
 *
 * There is deliberately no wrap-in-progress value. A wrap is a pipeline running
 * in this process, and `lib/wrap-run-registry.js` is where that fact lives: a
 * persisted row saying "wrapping" would survive a restart the pipeline itself
 * cannot, so it would durably record something false. The registry's empty
 * answer after a boot is the true one.
 *
 * `degraded` and `ended` are NOT session statuses despite appearing as status
 * strings elsewhere in the codebase — they belong to `lib/model-status.js`, the
 * health check, and `ai-content.js`'s gateway states.
 * @type {Readonly<{ACTIVE: string, WRAPPED: string, KILLED: string, CRASHED: string}>}
 */
const SESSION_STATUS = Object.freeze({
  ACTIVE: 'active',
  WRAPPED: 'wrapped',
  KILLED: 'killed',
  CRASHED: 'crashed'
});

/**
 * Every value `sessions.status` may hold, as a list.
 * @type {readonly string[]}
 */
const SESSION_STATUSES = Object.freeze(Object.values(SESSION_STATUS));

/**
 * The allowed transitions, keyed by the status being left. Every status has an
 * entry, so an absent key is a modelling error rather than "anything goes", and
 * the three terminal statuses map to an empty list because a session that has
 * ended does not end again.
 *
 * This is not a description — `_transitionSession` derives its SQL precondition
 * from it, so a transition missing here cannot be written. That is what stops a
 * second `kill` on an ended session from rewriting `ended_at` and appending a
 * duplicate `session.killed` row to the activity log, which is the history
 * anyone auditing the lifecycle has to read.
 * @type {Readonly<Object<string, readonly string[]>>}
 */
const SESSION_STATUS_TRANSITIONS = Object.freeze({
  [SESSION_STATUS.ACTIVE]: Object.freeze([
    SESSION_STATUS.WRAPPED, SESSION_STATUS.KILLED, SESSION_STATUS.CRASHED
  ]),
  [SESSION_STATUS.WRAPPED]: Object.freeze([]),
  [SESSION_STATUS.KILLED]: Object.freeze([]),
  [SESSION_STATUS.CRASHED]: Object.freeze([])
});

/**
 * Whether a session may move from one status to another.
 * @param {string} from - Current status
 * @param {string} to - Proposed status
 * @returns {boolean} - True only if the transition is modelled
 */
function canTransition(from, to) {
  const allowed = SESSION_STATUS_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * The statuses a session may hold and still reach `to` — the inverse of the
 * transition map, and the precondition every status write is guarded by.
 * @param {string} to - Target status
 * @returns {string[]} - Statuses from which `to` is reachable
 */
function _statusSourcesFor(to) {
  return SESSION_STATUSES.filter((from) => canTransition(from, to));
}

/**
 * Move a session to a terminal status, refusing any transition the map does not
 * allow.
 *
 * A refusal is a no-op, not a throw: the kill and wrap routes — and a great many
 * fixtures — call these as "end it if it is still live", and turning that benign
 * redundancy into an exception would buy nothing. It is not silent either: the
 * refusal is logged, and `changed` is what the public writers turn into `null`
 * so a caller can tell a transition it performed from one it did not.
 *
 * @param {number} id - Session id
 * @param {string} to - Target status
 * @param {string} setClause - Extra SQL assignments, applied with `status`
 * @param {any[]} setParams - Parameters for `setClause`, in order
 * @returns {{session: object|null, changed: boolean}} - The row as it now
 *   stands (unchanged on a refusal), and whether this call wrote it
 */
function _transitionSession(id, to, setClause, setParams) {
  const sources = _statusSourcesFor(to);
  // An unmodelled target leaves `sources` empty, and that needs no special
  // case: SQLite reads `status IN ()` as the empty set, so the UPDATE matches
  // nothing and falls into the same refusal below as any other transition the
  // map does not allow. Checked, not assumed — the plausible-looking guard here
  // would have been keyed to a parse error that does not happen.
  const placeholders = sources.map(() => '?').join(', ');
  const result = _db.prepare(
    `UPDATE sessions SET status = ?, ${setClause}
       WHERE id = ? AND status IN (${placeholders})`
  ).run(to, ...setParams, id, ...sources);

  const session = _getSessionById(id);
  if (result.changes === 0) {
    log.warn('Refused a session status transition the lifecycle does not allow', {
      session: id, from: session ? session.status : null, to
    });
    return { session, changed: false };
  }
  return { session, changed: true };
}

const sessionsApi = {
  /**
   * Get the active session for a project.
   *
   * `started_at` is second-resolution, so two rows created in the same second
   * tie — and this lookup decides which session a wrap or a kill lands on. The
   * id breaks the tie toward the newer row, which is the one the operator is
   * looking at; without it SQLite picks, and it picked the older one.
   *
   * Every session ordering in this API breaks the tie the same way, including
   * the ones that return a list: `list` feeds a LIMIT, so there too the tie
   * decides which rows a caller sees.
   * @param {number} projectId - Project id
   * @returns {object|null}
   */
  getActive(projectId) {
    _ensureDb();
    const row = _db.prepare(
      `SELECT * FROM sessions WHERE project_id = ? AND status = ?
         ORDER BY started_at DESC, id DESC LIMIT 1`
    ).get(projectId, SESSION_STATUS.ACTIVE);
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
   * List every live session across all projects, most-recently-started first.
   * The getActive/list helpers above are project-scoped; this is the fleet-wide
   * view the session-ownership primitive's (#347) listLive() consumer needs.
   *
   * `active` is the whole of "live" — it is the only non-terminal status, and a
   * session stays `active` for the duration of its wrap, so a wrapping agent is
   * included here exactly as it always was.
   * @returns {object[]}
   */
  listLiveAll() {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM sessions WHERE status = ? ORDER BY started_at DESC, id DESC'
    ).all(SESSION_STATUS.ACTIVE).map(_rowToSession);
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
    // The id tiebreak is not cosmetic here: this ORDER BY feeds a LIMIT, so two
    // rows sharing a second-resolution `started_at` decide which of them falls
    // inside the page. Every session ordering in this API breaks the tie the
    // same way — see `getActive`.
    sql += ' ORDER BY started_at DESC, id DESC';
    sql += ` LIMIT ${options.limit || 20}`;

    return _db.prepare(sql).all(...params).map(_rowToSession);
  },

  /**
   * Get the most recent session for a project (any status).
   *
   * Same second-resolution tie as `getActive`, broken the same way.
   * @param {number} projectId - Project id
   * @returns {object|null}
   */
  getLatest(projectId) {
    _ensureDb();
    const row = _db.prepare(
      'SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT 1'
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
   * @param {{sha:string, toplevel:string, dirty:({paths:string[], truncated:boolean}|null)}|null} [data.launchBaseline]
   *   From `lib/launch-baseline.js#capture`; null/absent when the project is not a repo.
   * @param {object} [data.launchSequence] - The launch sequence to bind to this session in the
   *   same transaction (`lib/launch-sequence.js#buildSnapshot`). A failure to write it fails the
   *   whole start, so no session row exists without its sequence.
   * @returns {object} - Created session
   */
  start(data) {
    _ensureDb();
    if (!data.projectId || !data.engineId) {
      throw new StoreError('projectId and engineId are required', 'BAD_REQUEST');
    }
    const baseline = data.launchBaseline && data.launchBaseline.sha ? data.launchBaseline : null;
    const insertSession = () => {
      _db.prepare(
        `INSERT INTO sessions (project_id, engine_id, tmux_session, prime_prompt, session_mode, launch_mode, owner,
           launch_sha, launch_toplevel, launch_dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        data.projectId,
        data.engineId,
        data.tmuxSession || null,
        data.primePrompt || null,
        data.sessionMode || 'tmux',
        data.launchMode || null,
        data.owner || null,
        baseline ? baseline.sha : null,
        baseline ? baseline.toplevel || null : null,
        baseline && baseline.dirty ? JSON.stringify(baseline.dirty) : null
      );
      const row = _db.prepare('SELECT * FROM sessions WHERE id = last_insert_rowid()').get();
      return _rowToSession(row);
    };

    let session;
    if (data.launchSequence) {
      // The launch id is bound in the same transaction as the session row, so a
      // sequence can exist only for a session that does, and a failed bind
      // leaves no session row either (Train 21, #1579).
      _db.exec('BEGIN IMMEDIATE');
      try {
        session = insertSession();
        _insertLaunchSequence(session.id, data.projectId, data.engineId, data.launchSequence);
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
    } else {
      session = insertSession();
    }
    activityApi.log({
      projectId: data.projectId,
      sessionId: session.id,
      eventType: 'session.started',
      detail: { engine: data.engineId, primeLength: (data.primePrompt || '').length }
    });
    return session;
  },

  /**
   * Read a session's launch baseline (#1309, #1406) — the HEAD and dirty-path set
   * captured when it launched. Kept off the session object every API serves; the
   * wrap is its only reader.
   *
   * @param {number} id - Session id
   * @returns {{sha:string, toplevel:(string|null), dirty:({paths:string[], truncated:boolean}|null)}|null}
   *   Null for an unknown session, a non-repo project, or a session launched
   *   before the baseline existed.
   */
  getLaunchBaseline(id) {
    _ensureDb();
    const row = _db.prepare('SELECT id, launch_sha, launch_toplevel, launch_dirty FROM sessions WHERE id = ?').get(id);
    return row ? _launchBaselineFromRow(row) : null;
  },

  /**
   * Wrap a session (set status='wrapped', capture summary).
   *
   * **`null` means this call did not wrap it** — the session had already ended,
   * or there is no such row. Reading `.status` back cannot answer that for
   * `wrap`: a refusal on an already-`wrapped` row reads identically to success,
   * which is why the outcome travels in the return value rather than the row.
   * @param {number} id - Session id
   * @param {string} [summary] - Wrap summary markdown
   * @returns {object|null} - The wrapped session, or null if this call did not wrap it
   */
  wrap(id, summary, options = {}) {
    _ensureDb();

    /**
     * The lifecycle transition itself, plus — when this wrap staged a handoff —
     * the eligibility binding for that exact attempt.
     * @returns {{session: object|null, changed: boolean, publicationBound: boolean|null}}
     */
    const transition = () => {
      const { session, changed } = _transitionSession(
        id,
        SESSION_STATUS.WRAPPED,
        `ended_at = datetime('now'),
         wrap_summary = ?,
         duration_seconds = CAST((julianday(datetime('now')) - julianday(started_at)) * 86400 AS INTEGER)`,
        [summary || null]
      );
      // A refused transition (Kill won the race) binds nothing: the attempt did
      // not complete, so it must not be able to claim it did.
      if (!changed || !options.publicationId) {
        return { session, changed, publicationBound: options.publicationId ? false : null };
      }
      const publicationBound = handoffsApi.bindLifecycleEligibility(
        options.publicationId, id, options.wrapRunId, new Date().toISOString()
      );
      return { session, changed, publicationBound };
    };

    // Train 21, #1585: when this wrap staged a handoff, the `active → wrapped`
    // UPDATE and the eligibility binding commit or fail TOGETHER. Splitting
    // them is what would let a wrapped session carry an unbound attempt, or an
    // attempt claim a lifecycle that never completed.
    let result;
    if (options.publicationId) {
      _db.exec('BEGIN IMMEDIATE');
      try {
        result = transition();
        _db.exec('COMMIT');
      } catch (err) {
        try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
    } else {
      result = transition();
    }

    const { session, changed, publicationBound } = result;
    if (changed && session) {
      activityApi.log({
        projectId: session.projectId,
        sessionId: id,
        eventType: 'session.wrapped',
        detail: { durationSeconds: session.durationSeconds, summaryLength: (summary || '').length }
      });
    }
    if (!changed) return null;
    // The publication verdict rides on the session object rather than changing
    // the return contract: every existing caller reads a session or null, and
    // only the handoff-aware caller looks for this.
    return options.publicationId ? { ...session, publicationBound } : session;
  },

  /**
   * Kill a session (set status='killed').
   *
   * **`null` means this call did not kill it** — the session had already ended,
   * or there is no such row. Same contract as `wrap`.
   * @param {number} id - Session id
   * @param {string} [reason] - Kill reason
   * @returns {object|null} - The killed session, or null if this call did not kill it
   */
  kill(id, reason) {
    _ensureDb();
    const { session, changed } = _transitionSession(
      id,
      SESSION_STATUS.KILLED,
      `ended_at = datetime('now'),
       duration_seconds = CAST((julianday(datetime('now')) - julianday(started_at)) * 86400 AS INTEGER)`,
      []
    );
    if (changed && session) {
      activityApi.log({
        projectId: session.projectId,
        sessionId: id,
        eventType: 'session.killed',
        detail: { reason: reason || 'Manual kill' }
      });
    }
    return changed ? session : null;
  },

  /**
   * Mark a session as crashed.
   *
   * **`null` means this call did not record the crash** — the session had
   * already ended, or there is no such row. Same contract as `wrap`.
   * @param {number} id - Session id
   * @param {string} [error] - Error description
   * @returns {object|null} - The crashed session, or null if this call did not record it
   */
  markCrashed(id, error) {
    _ensureDb();
    const { session, changed } = _transitionSession(
      id,
      SESSION_STATUS.CRASHED,
      `ended_at = datetime('now'),
       duration_seconds = CAST((julianday(datetime('now')) - julianday(started_at)) * 86400 AS INTEGER)`,
      []
    );
    if (changed && session) {
      activityApi.log({
        projectId: session.projectId,
        sessionId: id,
        eventType: 'session.crashed',
        detail: { error: error || 'Unknown' }
      });
    }
    return changed ? session : null;
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

// ── Launch sequences (Train 21) ──

/**
 * The step ids a launch sequence serves, in order. Pinned here because the
 * CHECK on `launch_sequence_steps.step_id` rejects anything else.
 * @type {string[]}
 */
const LAUNCH_STEP_IDS = ['identity', 'governance', 'state', 'task'];

/**
 * Insert a sequence row and its frozen steps. The caller holds the transaction.
 *
 * An applicable sequence carries exactly the four steps; a not-applicable one
 * carries none and must say why. Both are checked here rather than left to a
 * later reader, because a sequence missing a step would stall at that cursor
 * with nothing to serve.
 * @param {number} sessionId - The session being bound
 * @param {number} projectId - Its project
 * @param {string} engineId - The engine the session runs
 * @param {object} seq - `{launchId, pageBudget, applicability, notApplicableReason, preflight, recovery, recoveryMode, sourceManifest, steps}`
 * @returns {number} The new sequence id
 */
function _insertLaunchSequence(sessionId, projectId, engineId, seq) {
  const steps = Array.isArray(seq.steps) ? seq.steps : [];
  if (seq.applicability === 'applicable') {
    const ids = steps.map((st) => st.id).join(',');
    if (ids !== LAUNCH_STEP_IDS.join(',')) {
      throw new StoreError(`An applicable launch sequence needs the steps ${LAUNCH_STEP_IDS.join(', ')} in order; got "${ids}"`, 'BAD_REQUEST');
    }
  } else if (steps.length > 0) {
    throw new StoreError('A not-applicable launch sequence carries no steps', 'BAD_REQUEST');
  }
  // Recovery is decided once, here, from what the preflight found — never
  // recomputed later from the stored verdict. `requiresRecovery` is not a
  // function of the verdict word (`lib/sessions.js#_storedPreflight` says why),
  // so a reader that re-derived it would answer `false` for exactly the case
  // nobody measured. The column defaults cover a caller that passes neither,
  // and they default to the blocking side of the mode and the quiet side of the
  // state: no recovery asked for, and `operator` if one ever is.
  _db.prepare(
    `INSERT INTO launch_sequences (launch_id, session_id, project_id, engine_id, page_budget,
       applicability, not_applicable_reason, preflight, source_manifest, recovery, recovery_mode, startup_delivery)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    seq.launchId,
    sessionId,
    projectId,
    engineId,
    seq.pageBudget,
    seq.applicability,
    seq.notApplicableReason || null,
    JSON.stringify(seq.preflight),
    JSON.stringify(seq.sourceManifest),
    seq.recovery === 'required' ? 'required' : 'none',
    seq.recoveryMode === 'advisory' ? 'advisory' : 'operator',
    // Native only when the launch SAID so; anything else, including a caller
    // that predates the field, is the keystroke path it always was.
    seq.startupDelivery === 'native' ? 'native' : 'legacy'
  );
  const sequenceId = _db.prepare('SELECT id FROM launch_sequences WHERE launch_id = ?').get(seq.launchId).id;
  const insertStep = _db.prepare(
    `INSERT INTO launch_sequence_steps (sequence_id, revision, step_index, step_id, content, digest, page_count, page_offsets)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`
  );
  steps.forEach((st, index) => {
    insertStep.run(sequenceId, index, st.id, st.content, st.digest, st.pageOffsets.length, JSON.stringify(st.pageOffsets));
  });
  return sequenceId;
}

/**
 * Map a `launch_sequences` row to its camelCase shape.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToLaunchSequence(row) {
  return {
    id: row.id,
    launchId: row.launch_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    engineId: row.engine_id,
    revision: row.revision,
    cursor: row.cursor,
    pageBudget: row.page_budget,
    applicability: row.applicability,
    notApplicableReason: row.not_applicable_reason,
    preflight: _jsonParse(row.preflight, null),
    sourceManifest: _jsonParse(row.source_manifest, null),
    readyAt: row.ready_at,
    readyArtifact: _jsonParse(row.ready_artifact, null),
    readyDigest: row.ready_digest,
    unreadyAt: row.unready_at,
    nudgeCount: row.nudge_count,
    lastNudgedAt: row.last_nudged_at,
    recovery: row.recovery,
    recoveryMode: row.recovery_mode,
    recoveryRevision: row.recovery_revision,
    recoveryClearedAt: row.recovery_cleared_at,
    recoveryClearedBy: row.recovery_cleared_by,
    recoveryClearance: row.recovery_clearance,
    startupDelivery: row.startup_delivery === 'native' ? 'native' : 'legacy',
    createdAt: row.created_at
  };
}

/**
 * Map a `launch_sequence_steps` row to its camelCase shape.
 * @param {object} row - Raw SQLite row
 * @returns {object}
 */
function _rowToLaunchStep(row) {
  return {
    sequenceId: row.sequence_id,
    revision: row.revision,
    index: row.step_index,
    id: row.step_id,
    content: row.content,
    digest: row.digest,
    pageCount: row.page_count,
    pageOffsets: _jsonParse(row.page_offsets, []),
    carriedFromRevision: row.carried_from_revision,
    pagesServed: _jsonParse(row.pages_served, []),
    servedAt: row.served_at,
    ackedAt: row.acked_at
  };
}

const launchSequencesApi = {
  /**
   * Run `fn` inside one `BEGIN IMMEDIATE` transaction and return its result.
   * The ack protocol reads and writes a sequence as one decision; this is what
   * keeps two identical acks from both advancing the cursor.
   * @param {() => *} fn - Synchronous work
   * @returns {*} Whatever `fn` returns
   */
  transaction(fn) {
    _ensureDb();
    _db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      _db.exec('COMMIT');
      return out;
    } catch (err) {
      try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw err;
    }
  },

  /**
   * The sequence a launch id is bound to.
   * @param {string} launchId - From the pane's TANGLECLAW_LAUNCH_ID
   * @returns {object|null} Null when no session row carries this launch id (yet)
   */
  getByLaunchId(launchId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM launch_sequences WHERE launch_id = ?').get(launchId);
    return row ? _rowToLaunchSequence(row) : null;
  },

  /**
   * The sequence bound to a session.
   * @param {number} sessionId - Session id
   * @returns {object|null}
   */
  getBySession(sessionId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM launch_sequences WHERE session_id = ?').get(sessionId);
    return row ? _rowToLaunchSequence(row) : null;
  },

  /**
   * The steps of one revision of a sequence, in serving order.
   * @param {number} sequenceId - Sequence id
   * @param {number} revision - Snapshot revision
   * @returns {object[]}
   */
  listSteps(sequenceId, revision) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM launch_sequence_steps WHERE sequence_id = ? AND revision = ? ORDER BY step_index'
    ).all(sequenceId, revision).map(_rowToLaunchStep);
  },

  /**
   * Record that a page was served. Serving is idempotent: a page already in
   * the set is not added twice, and `served_at` keeps its first value. This
   * records what was SENT, never what was received — only an ack says that.
   * @param {number} sequenceId - Sequence id
   * @param {number} revision - Snapshot revision
   * @param {number} stepIndex - 0–3
   * @param {number} page - Page index
   * @returns {object|null} The updated step
   */
  markPageServed(sequenceId, revision, stepIndex, page) {
    _ensureDb();
    const key = [sequenceId, revision, stepIndex];
    const row = _db.prepare(
      'SELECT pages_served FROM launch_sequence_steps WHERE sequence_id = ? AND revision = ? AND step_index = ?'
    ).get(...key);
    if (!row) return null;
    const served = new Set(_jsonParse(row.pages_served, []));
    served.add(page);
    _db.prepare(
      `UPDATE launch_sequence_steps
          SET pages_served = ?, served_at = COALESCE(served_at, datetime('now'))
        WHERE sequence_id = ? AND revision = ? AND step_index = ?`
    ).run(JSON.stringify([...served].sort((a, b) => a - b)), ...key);
    const updated = _db.prepare(
      'SELECT * FROM launch_sequence_steps WHERE sequence_id = ? AND revision = ? AND step_index = ?'
    ).get(...key);
    return _rowToLaunchStep(updated);
  },

  /**
   * Acknowledge the cursor step and advance the cursor past it, as one
   * compare-and-set: nothing changes unless the step is unacked and the cursor
   * is still on it at this revision.
   * @param {number} sequenceId - Sequence id
   * @param {number} revision - Snapshot revision
   * @param {number} stepIndex - The step being acknowledged
   * @returns {boolean} Whether this call advanced the cursor
   */
  ackStep(sequenceId, revision, stepIndex) {
    _ensureDb();
    const moved = _db.prepare(
      'UPDATE launch_sequences SET cursor = ? WHERE id = ? AND revision = ? AND cursor = ?'
    ).run(stepIndex + 1, sequenceId, revision, stepIndex);
    if (moved.changes === 0) return false;
    _db.prepare(
      `UPDATE launch_sequence_steps SET acked_at = datetime('now')
        WHERE sequence_id = ? AND revision = ? AND step_index = ? AND acked_at IS NULL`
    ).run(sequenceId, revision, stepIndex);
    return true;
  },

  /**
   * Record an accepted READY attestation, as one compare-and-set.
   *
   * Nothing changes unless the sequence is still unready at this revision, so
   * two callers racing the same artifact cannot both write one — the second
   * reads the stored digest and answers idempotently or as a conflict. The
   * caller holds the transaction and has already validated the artifact.
   * @param {number} sequenceId - Sequence id
   * @param {number} revision - The revision the artifact was accepted at
   * @param {object} artifact - The canonical `tc.ready/1` artifact as accepted
   * @param {string} digest - sha256 of the canonical artifact
   * @returns {boolean} Whether this call recorded the attestation
   */
  markReady(sequenceId, revision, artifact, digest) {
    _ensureDb();
    const written = _db.prepare(
      `UPDATE launch_sequences SET ready_at = datetime('now'), ready_artifact = ?, ready_digest = ?
        WHERE id = ? AND revision = ? AND ready_at IS NULL`
    ).run(JSON.stringify(artifact), digest, sequenceId, revision);
    return written.changes > 0;
  },

  /**
   * Replace a sequence's snapshot with a new revision.
   *
   * The new revision's step rows are inserted whole rather than updated in
   * place: an old revision's rows stay exactly as they were served, so evidence
   * recorded against content can never be re-pointed at different content. A
   * step the caller marks as carried keeps its acknowledgement, which is sound
   * only for byte-equal content — the caller decides that (§2.2), and passes
   * `carriedFromRevision` to say it did.
   * @param {number} sequenceId - Sequence id
   * @param {object} args
   * @param {number} args.revision - The new revision (the caller's old + 1)
   * @param {number} args.cursor - The first un-acked step of the new revision
   * @param {object} args.sourceManifest - The manifest the new revision was built from
   * @param {Array<{index: number, id: string, content: string, digest: string,
   *   pageOffsets: Array<[number, number]>, carriedFromRevision?: number|null,
   *   pagesServed?: number[], servedAt?: string|null, ackedAt?: string|null}>} args.steps -
   *   All steps of the new revision
   * @returns {object} The revised sequence row
   */
  revise(sequenceId, { revision, cursor, sourceManifest, steps }) {
    _ensureDb();
    const insert = _db.prepare(
      `INSERT INTO launch_sequence_steps (sequence_id, revision, step_index, step_id, content, digest,
         page_count, page_offsets, carried_from_revision, pages_served, served_at, acked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const st of steps) {
      const pagesServed = Array.isArray(st.pagesServed) ? st.pagesServed : [];
      insert.run(
        sequenceId, revision, st.index, st.id, st.content, st.digest,
        st.pageOffsets.length, JSON.stringify(st.pageOffsets),
        st.carriedFromRevision === undefined ? null : st.carriedFromRevision,
        JSON.stringify(pagesServed),
        // A carried step keeps its served stamp with its pages; a re-rendered
        // one has been served nothing, and saying otherwise would let ack rule
        // (f) pass over pages this revision never sent.
        st.servedAt || null,
        st.ackedAt || null
      );
    }
    // `recovery_revision` moves with the snapshot revision, and only with it.
    // A clear is an operator's decision about the verdict THEY read in step 3,
    // and a revision re-renders step 3 — so an outstanding clear for the old
    // revision is a decision about content that no longer exists. Binding it to
    // anything that moves more often would void clears for changes the operator
    // never saw; binding it to nothing would let a stale click clear a launch
    // whose story had changed underneath it.
    _db.prepare(
      `UPDATE launch_sequences
          SET revision = ?, cursor = ?, source_manifest = ?, recovery_revision = recovery_revision + 1
        WHERE id = ?`
    ).run(revision, cursor, JSON.stringify(sourceManifest), sequenceId);
    return _rowToLaunchSequence(_db.prepare('SELECT * FROM launch_sequences WHERE id = ?').get(sequenceId));
  },

  /**
   * Clear a sequence's required recovery, as one compare-and-set bound to the
   * exact launch state the clearer was looking at.
   *
   * Nothing changes unless the row is still `required` at this `sessionId` and
   * `recoveryRevision`. That binding is the whole guard: a clear granted against
   * one launch — or against a revision whose step 3 has since been replaced —
   * must not silently apply to a newer one, because the operator decided about a
   * verdict they were shown and not about whatever the row says now.
   *
   * `clearedBy` is the operator's username where one authenticated, and NULL
   * where none did. It is never filled in with a placeholder: a row that names
   * nobody is the honest record of a clearance that proved nobody, and
   * `clearance` says which of the three it was.
   * @param {number} sequenceId - Sequence id
   * @param {object} args
   * @param {number} args.sessionId - The session the caller believes this is
   * @param {number} args.recoveryRevision - The recovery revision the caller read
   * @param {'operator-verified'|'open-install-unverified'|'agent-reconciled'} args.clearance - How it was cleared
   * @param {string|null} [args.clearedBy] - The authenticated operator, or null
   * @returns {object|null} The cleared sequence, or null when the binding did not match
   */
  clearRecovery(sequenceId, { sessionId, recoveryRevision, clearance, clearedBy = null }) {
    _ensureDb();
    const written = _db.prepare(
      `UPDATE launch_sequences
          SET recovery = 'cleared', recovery_cleared_at = datetime('now'),
              recovery_cleared_by = ?, recovery_clearance = ?
        WHERE id = ? AND session_id = ? AND recovery_revision = ? AND recovery = 'required'`
    ).run(clearedBy, clearance, sequenceId, sessionId, recoveryRevision);
    if (written.changes === 0) return null;
    return _rowToLaunchSequence(_db.prepare('SELECT * FROM launch_sequences WHERE id = ?').get(sequenceId));
  },

  /**
   * Stamp the unready window as passed. Idempotent: the first stamp stands, so
   * the window's start time is not re-dated by a later tick.
   *
   * Sets nothing else. The window is an observation, never a gate: it does not
   * move the cursor, does not require recovery, and does not make a later READY
   * any less valid (§2.3).
   * @param {number} sequenceId - Sequence id
   * @returns {boolean} Whether this call wrote the stamp
   */
  markUnready(sequenceId) {
    _ensureDb();
    const written = _db.prepare(
      "UPDATE launch_sequences SET unready_at = datetime('now') WHERE id = ? AND unready_at IS NULL"
    ).run(sequenceId);
    return written.changes > 0;
  },

  /**
   * Count one nudge that was SENT, on the sequence row rather than in
   * `activity_log` — the activity log is pruned per type, and "was this session
   * nudged" has to stay answerable for as long as the sequence does.
   * @param {number} sequenceId - Sequence id
   * @returns {object|null} The updated sequence
   */
  recordNudge(sequenceId) {
    _ensureDb();
    _db.prepare(
      "UPDATE launch_sequences SET nudge_count = nudge_count + 1, last_nudged_at = datetime('now') WHERE id = ?"
    ).run(sequenceId);
    const row = _db.prepare('SELECT * FROM launch_sequences WHERE id = ?').get(sequenceId);
    return row ? _rowToLaunchSequence(row) : null;
  },

  /**
   * Sequences of live sessions that have not attested READY.
   *
   * Bounded by the JOIN to active sessions on purpose: these rows are never
   * pruned, so every session that ended before attesting leaves one behind and
   * an unbounded `ready_at IS NULL` scan would grow forever.
   * @returns {object[]} Oldest first — the one most overdue is answered first
   */
  listUnreadyOfActiveSessions() {
    _ensureDb();
    return _db.prepare(
      `SELECT ls.* FROM launch_sequences ls
         JOIN sessions s ON s.id = ls.session_id
        WHERE ls.ready_at IS NULL AND ls.applicability = 'applicable' AND s.status = ?
        ORDER BY ls.created_at ASC`
    ).all(SESSION_STATUS.ACTIVE).map(_rowToLaunchSequence);
  },

  /**
   * Was any step of an EARLIER revision of this sequence served or acknowledged?
   *
   * The question behind it is whether a revision replaced content the session
   * had already read. A snapshot revised before anything went out replaced
   * nothing the agent saw, and treating that as something to reconcile asks for
   * an account of an event the agent never witnessed.
   * @param {number} sequenceId - Sequence id
   * @param {number} revision - The current revision; earlier ones are examined
   * @returns {boolean}
   */
  anyStepReadBefore(sequenceId, revision) {
    _ensureDb();
    const row = _db.prepare(
      `SELECT 1 FROM launch_sequence_steps
        WHERE sequence_id = ? AND revision < ? AND (served_at IS NOT NULL OR acked_at IS NOT NULL)
        LIMIT 1`
    ).get(sequenceId, revision);
    return Boolean(row);
  },

  /**
   * A project's most recent sequences, newest first, for the readiness panel.
   * @param {number} projectId - Project id
   * @param {number} [limit=5] - How many to return
   * @returns {object[]}
   */
  listForProject(projectId, limit = 5) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM launch_sequences WHERE project_id = ? ORDER BY id DESC LIMIT ?'
    ).all(projectId, limit).map(_rowToLaunchSequence);
  }
};

/**
 * Shape a `handoff_publications` row for callers, who work in camelCase and
 * should never see the column names.
 * @param {object} row - Raw row
 * @returns {object} The publication
 */
function _rowToHandoffPublication(row) {
  return {
    publicationId: row.publication_id,
    seq: row.seq,
    projectId: row.project_id,
    sessionId: row.session_id,
    wrapRunId: row.wrap_run_id,
    kind: row.kind,
    state: row.state,
    fileDigest: row.file_digest,
    eligibleAt: row.eligible_at,
    eligibleVia: row.eligible_via,
    stagedAt: row.staged_at,
    publishedAt: row.published_at,
    supersededAt: row.superseded_at,
    supersededBy: row.superseded_by,
    abandonedAt: row.abandoned_at,
    abandonedReason: row.abandoned_reason
  };
}

/**
 * Shape one `project_handoff_epoch` row for callers.
 * @param {object} row - The row as stored
 * @returns {{projectId: number, epochSessionId: number, baseline: string, baselineReason: string|null, recordedAt: string}}
 */
function _rowToHandoffEpoch(row) {
  return {
    projectId: row.project_id,
    epochSessionId: row.epoch_session_id,
    baseline: row.baseline,
    baselineReason: row.baseline_reason,
    recordedAt: row.recorded_at
  };
}

/**
 * `project_handoff_epoch` — where handoffs began, per project (#1586).
 *
 * There is deliberately no update or recompute here. The boundary is written
 * once, by the v41→42 migration for projects that predate it and by
 * `projects.create` for every project after, and the launch preflight only ever
 * reads it.
 */
const handoffEpochApi = {
  /**
   * One project's recorded boundary, or null when none was ever recorded.
   * @param {number} projectId - Project id
   * @returns {object|null}
   */
  get(projectId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM project_handoff_epoch WHERE project_id = ?').get(projectId);
    return row ? _rowToHandoffEpoch(row) : null;
  },

  /**
   * The boundary as the launch preflight reads it, present or not.
   *
   * A missing row on a store that carries this table is an integrity condition,
   * not a blank slate — so it answers with a cutoff of 0 and an `unclean`
   * baseline, and says `present: false` so the caller can report it. Both halves
   * matter: a cutoff of 0 means no session can be "pre-epoch", and an `unclean`
   * baseline withholds the clean-legacy exception, so the pair cannot combine
   * into `legacy` or `ok` for any project that has history. That is the whole
   * point — the alternative, taking today's `MAX(id)` to fill the gap, would
   * grant exactly the legacy acceptance the missing row fails to justify.
   *
   * @param {number} projectId - Project id
   * @returns {{epochSessionId: number, baseline: string, baselineReason: string|null, present: boolean}}
   */
  readBoundary(projectId) {
    const recorded = handoffEpochApi.get(projectId);
    if (recorded) {
      return {
        epochSessionId: recorded.epochSessionId,
        baseline: recorded.baseline,
        baselineReason: recorded.baselineReason,
        present: true
      };
    }
    return {
      epochSessionId: 0,
      baseline: HANDOFF_BASELINES.UNCLEAN,
      baselineReason: EPOCH_ROW_MISSING,
      present: false
    };
  },

  /**
   * Record an empty boundary for a project that has none yet.
   *
   * Idempotent, and never overwrites: a project that already has a boundary
   * keeps it, because re-deriving one is precisely the recompute the epoch
   * exists to prevent.
   *
   * @param {number} projectId - Project id
   * @returns {object} The project's boundary, new or pre-existing
   */
  ensureEmpty(projectId) {
    _ensureDb();
    _db.prepare(
      'INSERT OR IGNORE INTO project_handoff_epoch '
      + '(project_id, epoch_session_id, baseline, baseline_reason, recorded_at) VALUES (?, 0, ?, NULL, ?)'
    ).run(projectId, HANDOFF_BASELINES.EMPTY, new Date().toISOString());
    return handoffEpochApi.get(projectId);
  }
};

/**
 * Handoff publications (Train 21, #1585).
 *
 * The DB half of the handoff. Every guarantee here is about ONE attempt named
 * by its `publicationId`, so a late completion can only ever touch its own
 * attempt — never a neighbouring one that happens to share a session.
 *
 * `eligible_at` is the load-bearing column: it is the attempt-exact proof that
 * this attempt completed, written only by `bindLifecycleEligibility` (inside
 * the lifecycle transition) or `markCheckpointComplete`. Nothing infers it from
 * session status, because a failed attempt must never borrow a later attempt's
 * success.
 */
const handoffsApi = {
  /**
   * Run `fn` inside one `BEGIN IMMEDIATE` transaction and return its result.
   * Publishing reads several rows and the filesystem's answer as one decision;
   * this is what keeps two finalizers from both deciding they are newest.
   * @param {() => *} fn - Synchronous work
   * @returns {*} Whatever `fn` returns
   */
  transaction(fn) {
    _ensureDb();
    _db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      _db.exec('COMMIT');
      return out;
    } catch (err) {
      try { _db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw err;
    }
  },

  /**
   * One publication by id.
   * @param {string} publicationId - Publication id
   * @returns {object|null} Null when no such attempt was ever staged
   */
  get(publicationId) {
    _ensureDb();
    const row = _db.prepare('SELECT * FROM handoff_publications WHERE publication_id = ?').get(publicationId);
    return row ? _rowToHandoffPublication(row) : null;
  },

  /**
   * The attempt staged by a given wrap run, if any.
   *
   * This is what makes a replayed stage idempotent WITHIN one run: the unique
   * `(session_id, wrap_run_id)` means a second stage for the same run finds the
   * first rather than minting a second id for one attempt.
   * @param {number} sessionId - Session id
   * @param {string} wrapRunId - Wrap run id
   * @returns {object|null}
   */
  getByRun(sessionId, wrapRunId) {
    _ensureDb();
    const row = _db.prepare(
      'SELECT * FROM handoff_publications WHERE session_id = ? AND wrap_run_id = ?'
    ).get(sessionId, wrapRunId);
    return row ? _rowToHandoffPublication(row) : null;
  },

  /**
   * The currently published publication for a project, if there is one.
   * @param {number} projectId - Project id
   * @returns {object|null}
   */
  getPublished(projectId) {
    _ensureDb();
    const row = _db.prepare(
      "SELECT * FROM handoff_publications WHERE project_id = ? AND state = 'published' ORDER BY seq DESC LIMIT 1"
    ).get(projectId);
    return row ? _rowToHandoffPublication(row) : null;
  },

  /**
   * Every publication for a project, newest attempt first.
   * @param {number} projectId - Project id
   * @param {number} [limit] - Cap on rows returned
   * @returns {object[]}
   */
  listByProject(projectId, limit = 20) {
    _ensureDb();
    return _db.prepare(
      'SELECT * FROM handoff_publications WHERE project_id = ? ORDER BY seq DESC LIMIT ?'
    ).all(projectId, limit).map(_rowToHandoffPublication);
  },

  /**
   * Stage an attempt, or return the one this run already staged.
   *
   * `seq` is allocated here as `MAX(seq) + 1`. It orders attempts across the
   * install, which is what lets finalize ask "is any NEWER publication already
   * published" — a question that has no answer without a total order.
   *
   * @param {object} attempt - The attempt being staged
   * @param {string} attempt.publicationId - From `newPublicationId`
   * @param {number} attempt.projectId - Logical project ref
   * @param {number} attempt.sessionId - Producing session
   * @param {string} attempt.wrapRunId - The wrap run staging this attempt
   * @param {string} attempt.kind - 'final' | 'checkpoint'
   * @param {string} attempt.fileDigest - sha256 of the staged bytes
   * @param {string} attempt.stagedAt - ISO timestamp
   * @returns {{publication: object, replayed: boolean}} `replayed` is true when
   *   this run had already staged an attempt and nothing was written.
   */
  stage(attempt) {
    _ensureDb();
    const existing = this.getByRun(attempt.sessionId, attempt.wrapRunId);
    if (existing) return { publication: existing, replayed: true };

    const nextSeq = (_db.prepare('SELECT MAX(seq) AS m FROM handoff_publications').get().m || 0) + 1;
    _db.prepare(`
      INSERT INTO handoff_publications
        (publication_id, seq, project_id, session_id, wrap_run_id, kind, state, file_digest, staged_at)
      VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?)
    `).run(
      attempt.publicationId, nextSeq, attempt.projectId, attempt.sessionId,
      attempt.wrapRunId, attempt.kind, attempt.fileDigest, attempt.stagedAt
    );
    return { publication: this.get(attempt.publicationId), replayed: false };
  },

  /**
   * Bind eligibility for a FINAL attempt. Call this only from inside the
   * lifecycle transition, so the `active → wrapped` UPDATE and this write
   * commit or fail together (plan §2.6 step 2).
   *
   * Returns false rather than throwing when the row does not match: the wrap
   * itself still completed, and the caller reports `publicationBound: false`
   * and abandons the attempt. A throw here would roll back a lifecycle
   * transition that was legitimate.
   *
   * @param {string} publicationId - The attempt to bind
   * @param {number} sessionId - The session whose lifecycle just completed
   * @param {string} wrapRunId - The run that staged the attempt
   * @param {string} at - ISO timestamp
   * @returns {boolean} True when this exact attempt was bound
   */
  bindLifecycleEligibility(publicationId, sessionId, wrapRunId, at) {
    _ensureDb();
    const changes = _db.prepare(`
      UPDATE handoff_publications
         SET eligible_at = ?, eligible_via = 'lifecycle-wrap'
       WHERE publication_id = ?
         AND session_id = ? AND wrap_run_id = ?
         AND kind = 'final' AND state = 'staged' AND eligible_at IS NULL
    `).run(at, publicationId, sessionId, wrapRunId).changes;
    return changes === 1;
  },

  /**
   * Bind eligibility for a CHECKPOINT attempt. There is no lifecycle
   * transition for a kept session, so this single write is the proof the
   * attempt completed. A crash before it leaves the attempt unbound, which
   * preflight reports as `unfinished` rather than repairing.
   * @param {string} publicationId - The attempt to bind
   * @param {string} wrapRunId - The run that staged it
   * @param {string} at - ISO timestamp
   * @returns {boolean} True when this exact attempt was bound
   */
  markCheckpointComplete(publicationId, wrapRunId, at) {
    _ensureDb();
    const changes = _db.prepare(`
      UPDATE handoff_publications
         SET eligible_at = ?, eligible_via = 'checkpoint-complete'
       WHERE publication_id = ? AND wrap_run_id = ?
         AND kind = 'checkpoint' AND state = 'staged' AND eligible_at IS NULL
    `).run(at, publicationId, wrapRunId).changes;
    return changes === 1;
  },

  /**
   * Is any publication NEWER than this one already published for the project?
   *
   * Finalize asks this so an older attempt can never overwrite a newer one's
   * `current.json`. Answering it needs the total order `seq` provides.
   * @param {number} projectId - Project id
   * @param {number} seq - The attempt's own seq
   * @returns {object|null} The newer published publication, or null
   */
  newerPublished(projectId, seq) {
    _ensureDb();
    const row = _db.prepare(
      "SELECT * FROM handoff_publications WHERE project_id = ? AND state = 'published' AND seq > ? ORDER BY seq DESC LIMIT 1"
    ).get(projectId, seq);
    return row ? _rowToHandoffPublication(row) : null;
  },

  /**
   * Mark this attempt published and the one it replaces superseded.
   *
   * Call inside `transaction`, AFTER the file rename has succeeded — the rename
   * is what makes `current.json` these bytes, and this write is the record that
   * it happened. Splitting them is unavoidable (a filesystem rename cannot join
   * a SQL transaction), which is exactly why reconciliation exists and why an
   * atomic rename is never on its own trusted to prove the DB was updated.
   * @param {string} publicationId - The attempt now current
   * @param {string|null} supersededId - The publication it replaced, if any
   * @param {string} at - ISO timestamp
   * @returns {void}
   */
  recordPublished(publicationId, supersededId, at) {
    _ensureDb();
    if (supersededId) {
      _db.prepare(`
        UPDATE handoff_publications
           SET state = 'superseded', superseded_at = ?, superseded_by = ?
         WHERE publication_id = ? AND state = 'published'
      `).run(at, publicationId, supersededId);
    }
    _db.prepare(`
      UPDATE handoff_publications SET state = 'published', published_at = ?
       WHERE publication_id = ? AND state = 'staged'
    `).run(at, publicationId);
  },

  /**
   * Supersede an ELIGIBLE attempt that lost to a newer published one.
   *
   * Deliberately not `abandon`: the attempt did complete, and its
   * `eligible_at` is preserved so the record still says so. No file moves and
   * `current.json` is untouched — an older attempt never overwrites a newer.
   * @param {string} publicationId - The losing attempt
   * @param {string} supersededBy - The publication that won
   * @param {string} at - ISO timestamp
   * @returns {boolean} True when the row moved
   */
  supersedeBeforePublish(publicationId, supersededBy, at) {
    _ensureDb();
    return _db.prepare(`
      UPDATE handoff_publications
         SET state = 'superseded', superseded_at = ?, superseded_by = ?
       WHERE publication_id = ? AND state = 'staged' AND eligible_at IS NOT NULL
    `).run(at, supersededBy, publicationId).changes === 1;
  },

  /**
   * Abandon a staged attempt that never became eligible.
   *
   * Only ever from `staged` with a NULL `eligible_at`: an attempt that
   * completed is superseded instead, never abandoned. The staged file is left
   * on disk for forensics.
   * @param {string} publicationId - The attempt to abandon
   * @param {string} reason - Why, in a few words
   * @param {string} at - ISO timestamp
   * @returns {boolean} True when the row moved
   */
  abandon(publicationId, reason, at) {
    _ensureDb();
    return _db.prepare(`
      UPDATE handoff_publications
         SET state = 'abandoned', abandoned_at = ?, abandoned_reason = ?
       WHERE publication_id = ? AND state = 'staged' AND eligible_at IS NULL
    `).run(at, reason, publicationId).changes === 1;
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
 * How long after a delivery row is written a receipt for it is still believed
 * (#1063).
 *
 * A SessionStart hook fires at engine boot, seconds after the row is written.
 * The window exists to bound the one replay the token itself cannot: an
 * unconsumed token stands exactly while the row is `written`, and every
 * `claude` opened in that project directory runs the same startup hook. Ten
 * minutes is far longer than any boot and far shorter than "some later
 * session", which is the separation that matters.
 * @type {number}
 */
const RECEIPT_MAX_AGE_MS = 10 * 60 * 1000;

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
 * - `written`    — the rule shards were written to disk and nothing has yet
 *                  confirmed the engine read them (#1063). The `rules-hook`
 *                  channel's honest write-time row: a hook that never runs
 *                  leaves this standing, and the #759 outage — every Claude
 *                  SessionStart hook failing, sessions booting with no rules —
 *                  produced a clean `delivered` ledger for as long as it
 *                  lasted precisely because this state did not exist. The hook
 *                  itself upgrades the row to `delivered` when it runs
 *                  (`markDelivered`), so `delivered` on this channel now means
 *                  the engine executed the hook, not that a file exists.
 * @type {string[]}
 */
const SESSION_RULE_DELIVERY_OUTCOMES = ['delivered', 'no-rules', 'skipped', 'unverified', 'written'];

/**
 * The skip reason a launch records when the rule TEXT rides the launch sequence
 * instead of the prime (Train 21, #1584).
 *
 * A constant because two places must agree on it exactly: `lib/sessions.js`
 * writes it, and `projectsWithUndeliveredRules` matches it to keep a pulled
 * project out of the undelivered warning. A `channel` value of its own would be
 * cleaner and needs a migration to widen the CHECK, which belongs with the next
 * schema version rather than beside this fix.
 * @type {string}
 */
const RULES_SERVED_BY_LAUNCH_SEQUENCE =
  "the rules are served in full by this session's launch sequence (`tc start next`), not by the prime";

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
    confirmedAt: row.confirmed_at || null,
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
    // unverified SEND — or a `written` one — through no channel. This list must
    // stay in step with the table's matching CHECK: when it did not, the DB
    // caught the case the guard missed, so the caller got a raw SQLite error
    // instead of a BAD_REQUEST naming the field. This ledger's only value is that its
    // rows can be trusted as evidence of what reached an engine, so a state
    // that cannot be true must not be storable.
    if (['delivered', 'unverified', 'written'].includes(entry.outcome) && entry.channel === 'none') {
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
   * Upgrade a `written` row to `delivered` on evidence the engine ran the hook
   * (#1063).
   *
   * The ONLY transition this ledger allows, and deliberately narrow. It moves
   * `written` → `delivered` and nothing else: a row that already says
   * `delivered` is left alone (a hook that fires twice is not new evidence), and
   * a `skipped` or `unverified` row is never rescued by a late receipt, because
   * those rows attest a different channel state and overwriting them would let
   * a receipt launder a failure into a success. A row that does not exist, or
   * is in any other state, returns `null` rather than throwing — the caller is
   * an inbound HTTP route fed an id from a file on a session's disk, so a stale
   * or wrong id is an ordinary condition, not an exception.
   *
   * **What a receipt actually proves, and the freshness window.** It proves
   * that *a* hook ran in the project directory and read the shards — not which
   * session's. It cannot prove that: the hook is registered on `startup` in the
   * project's own settings (`lib/engines.js`), so every `claude` opened in that
   * directory runs it, and the token names a row rather than a session. (It also
   * re-fires on `clear` and `compact`, but the hook posts no receipt for those.)
   * The token is consumed on a successful post, which handles the ordinary
   * case, but NOT the one that matters: when this session's hook never ran,
   * nothing was consumed and the token stands — exactly while the row is still
   * `written`, the only state this function acts on. Some later `claude` in
   * that directory would then credit its own hook run to a session that never
   * received anything.
   *
   * So the binding is temporal and enforced HERE, server-side, where a token on
   * a session's disk cannot influence it: a SessionStart hook fires within
   * seconds of the launch that wrote the row, so a receipt arriving more than
   * `RECEIPT_MAX_AGE_MS` after the row was written is refused.
   *
   * Residual, stated rather than closed: a `claude` opened by hand in that
   * directory *inside* the window, for a launch whose own hook failed, still
   * confirms that row. The window is what bounds it; nothing here makes it
   * impossible.
   *
   * @param {number} id - Delivery row id, from the receipt token the launch wrote.
   * @param {number} [nowMs] - Clock override for tests.
   * @returns {object|null} The upgraded row, or `null` if nothing was upgraded.
   */
  markDelivered(id, nowMs) {
    _ensureDb();
    const numeric = Number(id);
    if (!Number.isInteger(numeric) || numeric <= 0) return null;
    const row = _db.prepare(
      "SELECT id, created_at FROM session_rule_deliveries WHERE id = ? AND outcome = 'written'"
    ).get(numeric);
    if (!row) return null;
    // `created_at` is SQLite's `datetime('now')` — UTC, no zone marker, so it
    // is read as UTC explicitly rather than left to the host's local zone.
    const writtenAtMs = Date.parse(`${String(row.created_at).replace(' ', 'T')}Z`);
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    // `Math.abs`: a negative age means the host clock is behind the clock that
    // stamped the row. Without it that case is not `> RECEIPT_MAX_AGE_MS` and
    // so accepts unconditionally — a window that silently stops being one is
    // the shape this whole chunk is about, even where no abuse is realistic.
    const age = now - writtenAtMs;
    if (!Number.isFinite(writtenAtMs) || Math.abs(age) > RECEIPT_MAX_AGE_MS) {
      log.warn('Refused a rules-hook receipt outside the freshness window', {
        deliveryId: numeric, writtenAt: row.created_at, ageMs: Number.isFinite(writtenAtMs) ? age : null
      });
      return null;
    }
    const info = _db.prepare(
      "UPDATE session_rule_deliveries SET outcome = 'delivered', confirmed_at = datetime('now') "
      + "WHERE id = ? AND outcome = 'written'"
    ).run(numeric);
    if (!info.changes) return null;
    return _rowToSessionRuleDelivery(
      _db.prepare('SELECT * FROM session_rule_deliveries WHERE id = ?').get(numeric)
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
   * One skip is excluded, and only one: a project whose newest row is
   * `RULES_SERVED_BY_LAUNCH_SEQUENCE` deliberately sent no rule text on the
   * prime channel, and whether the rules were read is answered by that launch's
   * own record (`launch_sequences`, surfaced by the readiness panel). This
   * composes two records; it never upgrades a row — the skip stays a skip
   * (Train 21 §2.5, no cross-upgrades).
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
          AND (lastSkipReason IS NULL OR lastSkipReason != ?)
        ORDER BY p.name`
    ).all(RULES_SERVED_BY_LAUNCH_SEQUENCE);
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

// ── Activity Log ──

/**
 * Default per-`event_type` retention for `activity_log` (#869).
 *
 * A per-type cap is the mechanical rule that separates churn from forensic
 * history, and it needs no classification step: because the cap applies within
 * a type, cross-type eviction is impossible by construction. A high-volume type
 * (`port.leased`, 2,167 rows and 36% of the table when this was measured) hits
 * the cap and rotates, while a rare type stays under it for a long time —
 * without anyone maintaining an exemption list that the next `activity.log`
 * call site would silently fall outside of. Rarity exempts itself, and a
 * brand-new event type is bounded on its first insert with nothing to update.
 * The flip side: a type that grows steadily reaches the cap eventually. A record
 * that must outlive such a type gets a rare type of its own, as a stranded wrap
 * does (`wrap.stranded`, separate from the busier `wrap.auto_pr`).
 *
 * A time-based TTL is the wrong instrument for the same reason: at any age
 * cutoff it deletes the rare forensic rows first while leaving the churn that
 * actually grows the table.
 *
 * Scoped per `event_type`, never `project_id`: every `port.leased` and
 * `port.released` row carries a NULL `project_id`, so a project-keyed prune
 * would leave the single largest type entirely unbounded — the case
 * `_pruneSessionRuleDeliveries` documents itself as not covering.
 * @type {number}
 */
const ACTIVITY_LOG_RETENTION = 500;

/** Live retention, defaulting to the constant; overridable via the test seam. */
let _activityLogRetention = ACTIVITY_LOG_RETENTION;

/**
 * The event type recording a retention sweep. Named once so the emit site and
 * the re-entrancy guard below cannot drift apart.
 * @type {string}
 */
const ACTIVITY_PRUNE_EVENT = 'activity.pruned';

/**
 * Test/embedder seam to override the per-`event_type` retention, mirroring
 * `_setSessionRuleVersionRetention`.
 * @param {number} n - Rows to keep per event_type; <= 0 keeps all (unbounded)
 * @returns {void}
 */
function _setActivityLogRetention(n) {
  _activityLogRetention = n;
}

/**
 * Trim one event type's history to the newest `keep` rows. No-op when
 * `keep <= 0` (unbounded) or the type already has <= `keep` rows. Runs after
 * each insert so the table stays bounded without a sweeper.
 *
 * Ordered by `id` rather than `created_at`: `created_at` has one-second
 * resolution, so a burst of inserts within the same second has no total order
 * and "the newest `keep`" would be arbitrary among them. `id` is AUTOINCREMENT
 * and therefore monotonic with insertion.
 * @param {string} eventType - The event type to prune
 * @param {number} keep - Newest rows to retain
 * @returns {number} Rows deleted
 */
function _pruneActivityLog(eventType, keep) {
  if (!keep || keep <= 0) return 0;
  const info = _db.prepare(
    `DELETE FROM activity_log
      WHERE event_type = @eventType
        AND id < (
          SELECT MIN(id) FROM (
            SELECT id FROM activity_log
             WHERE event_type = @eventType
             ORDER BY id DESC
             LIMIT @keep
          )
        )`
  ).run({ eventType, keep });
  return info.changes;
}

/**
 * Oldest `created_at` still held for an event type — the history horizon a
 * sweep left behind, so the report can say what survived rather than only how
 * much died.
 * @param {string} eventType - The event type to measure
 * @returns {string|null} ISO-ish SQLite timestamp, or null if the type has no rows
 */
function _oldestActivityAt(eventType) {
  const row = _db.prepare(
    'SELECT MIN(created_at) AS oldest FROM activity_log WHERE event_type = ?'
  ).get(eventType);
  return (row && row.oldest) || null;
}


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
    // Which step failed, for the catch below. A lost event and a retention sweep
    // that has thrown on every insert for a week are different incidents, and
    // the second one means `activity_log` is unbounded again — the condition
    // this policy exists to prevent — while every surface still looks healthy.
    let phase = 'insert';
    try {
      if (!_db) return;
      const detail = event.detail ? JSON.stringify(event.detail) : null;
      _db.prepare(
        'INSERT INTO activity_log (project_id, session_id, event_type, detail) VALUES (?, ?, ?, ?)'
      ).run(event.projectId || null, event.sessionId || null, event.eventType, detail);
      phase = 'prune';

      const pruned = _pruneActivityLog(event.eventType, _activityLogRetention);
      // A steady-state trim removes exactly one row: the insert above put this
      // type one over its cap. More than one means a backlog converged — the cap
      // newly applied to an install with existing history, or lowered — which is
      // the only case that deletes history an operator might be looking for, and
      // so the only case worth reporting.
      //
      // That rests on an invariant worth stating, because nothing enforces it:
      // this is the ONLY insert into `activity_log`, and the prune runs after
      // every one of them. A bulk writer, backfill or migration added later would
      // make multi-row trims routine and turn this threshold back into a flood.
      // If a second writer is ever added, this moves with it.
      //
      // Reporting every trim instead makes the report the problem: at steady
      // state each churny insert would write a second row, doubling the table's
      // write rate, flooding the log with one WARN per insert, and making
      // `activity.pruned` the churniest type in the table — where it would then
      // rotate at its own cap and evict the convergence record it exists to keep.
      if (pruned > 1) {
        const retainedFrom = _oldestActivityAt(event.eventType);
        // Warned for EVERY converged type, this one included. A sweep that runs
        // unattended names what it displaced, and exempting the audit type from
        // that would make its own convergence the one deletion nothing records.
        log.warn('Retention sweep pruned activity log', {
          eventType: event.eventType, count: pruned, retainedFrom
        });
        // The durable half: recorded in the table it just pruned, so the
        // deletion outlives the process that did it. Rare by the threshold
        // above, so it never approaches its own cap.
        //
        // Only the ROW is gated, not the warning — a row inserts and would
        // re-enter this path, a warning cannot, so termination stays obvious
        // rather than merely argued while the norm above still holds.
        if (event.eventType !== ACTIVITY_PRUNE_EVENT) {
          activityApi.log({
            eventType: ACTIVITY_PRUNE_EVENT,
            detail: { prunedType: event.eventType, count: pruned, retainedFrom }
          });
        }
      }
    } catch (err) {
      // Swallowed on purpose — activity logging must never break its caller.
      // Routed through `log.error` rather than a raw stderr write so it reaches
      // the rotating log file the operator actually greps, and carries `phase`
      // so a prune failing on every insert is distinguishable from one lost
      // event: the first means the table is growing unbounded again.
      log.error('Activity log write failed', {
        phase, eventType: event && event.eventType, error: err.message
      });
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
    // The launch baseline is deliberately NOT here: this object is what every
    // session API serves, and the baseline carries up to thousands of repo paths
    // that only the wrap reads. `store.sessions.getLaunchBaseline(id)` is its read.
  };
}

/**
 * Read a session row's launch baseline back into the shape `launch-baseline.js`
 * captured. A row with no `launch_sha` has no baseline at all. A `launch_dirty`
 * that is missing or will not parse becomes `dirty: null` — "not captured", which
 * the ownership check treats as no snapshot, never as "nothing was dirty".
 *
 * @param {object} row - Raw sessions row
 * @returns {{sha:string, toplevel:(string|null), dirty:({paths:string[], truncated:boolean}|null)}|null}
 */
function _launchBaselineFromRow(row) {
  if (!row.launch_sha) return null;
  let dirty = null;
  if (row.launch_dirty) {
    try {
      const parsed = JSON.parse(row.launch_dirty);
      if (parsed && Array.isArray(parsed.paths)) {
        dirty = { paths: parsed.paths.filter((p) => typeof p === 'string'), truncated: parsed.truncated === true };
      }
    } catch {
      log.warn('sessions.launch_dirty is not valid JSON; treating the launch dirty set as not captured', { id: row.id });
    }
  }
  return { sha: row.launch_sha, toplevel: row.launch_toplevel || null, dirty };
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
    reach: row.reach || 'loopback',
    ownerKind: row.owner_kind || 'project',
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
   * @param {string} workspaceId - Recipient workspace id
   * @returns {object[]} Raw rows
   */
  listOpenForRecipient(workspaceId) {
    _ensureDb();
    return _db.prepare(
      "SELECT * FROM medusa_exchanges WHERE recipient_workspace_id = ? AND terminal_at IS NULL AND tracking = 'tracked' "
      + 'ORDER BY created_at, exchange_id'
    ).all(workspaceId);
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

module.exports = {
  init,
  close,
  hasPriorUse,
  config: configApi,
  engines: enginesApi,
  orchestrationProfiles: orchestrationProfilesApi,
  control: controlApi,
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
  sessionRuleDeliveries: sessionRuleDeliveriesApi,
  launchSequences: launchSequencesApi,
  startupPrompts: startupPromptsApi,
  startupControlChannels: startupControlChannelsApi,
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
  _setBasePath,
  _getBasePath,
  _getConfigPath,
  DEFAULT_CONFIG,
  DEFAULT_PROJECT_CONFIG
};
