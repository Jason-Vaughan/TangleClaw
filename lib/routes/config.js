'use strict';

/**
 * The global config routes — the settings read (`GET /api/config`) and the
 * settings save (`PATCH /api/config`) — with the helpers only this family
 * holds: the secret redaction a config passes through before it leaves the
 * server, the install's prior-use answer fixed once at boot (with its test
 * seam), the server-resolved bind state and protected roots attached to every
 * config response, and the Master-settings validation, moved out of
 * `server.js` unchanged (#2248).
 *
 * `register(deps)` registers the routes through the shared kernel, in the
 * order they held in `server.js`; the entry point calls it at the position
 * the routes held, so the route table reads as before. Two helpers the
 * handlers call still live in `server.js` because other families read them
 * too — the setup credential decision (`_decideSetupCredential`, shared with
 * the setup finish) and the ingress door reader (`_gateIngress`) — so they
 * arrive as `deps` rather than through a require of the entry point, which
 * would be a cycle. Boot reads the prior-use answer through
 * `_installPriorUse`, and `_setInstallPriorUse` keeps its place on
 * `server.js`'s own export surface, re-exported from here as the same
 * function, so the tests that reset it are unchanged.
 *
 * @module lib/routes/config
 */

const { createLogger } = require('../logger');
const store = require('../store');
const projects = require('../projects');
const engines = require('../engines');
const master = require('../master');
const masterAuthority = require('../master-authority');
const httpsSetup = require('../https-setup');
const gitHooks = require('../git-hooks');
const gitTemplate = require('../git-template');
const { protectedRootsFor } = require('../tcc-folders');
const { userHome } = require('../tangleclaw-home');
const medusaWatchdog = require('../medusa-watchdog');
const portScanner = require('../port-scanner');
const serviceToken = require('../service-token');
const authGate = require('../auth-gate');
const bindPolicy = require('../bind-policy');
const tailscaleIngress = require('../tailscale-ingress');
const sharedDocsAccess = require('../shared-docs-access');
const { route, jsonResponse, errorResponse } = require('./_kernel');

// The logger keeps the entry point's name so every log line this family writes
// reads exactly as it did before the move.
const log = createLogger('server');

// GET /api/config
/**
 * Strip credential material from a config object before it leaves the server.
 * `deletePassword` (scrypt) and `basicAuthHash` (bcrypt) are stored hashes, and
 * `serviceToken` (AUTH-4) is a raw bearer secret — none of them need to reach a
 * client (the hashes are offline-cracking targets; the token is a live
 * credential), the UI only needs to know whether each is set. Returns a shallow
 * copy with each secret removed and a `*Protected`/`*Configured` boolean in its
 * place.
 * @param {object} config
 * @returns {object}
 */
function redactConfigSecrets(config) {
  const redacted = { ...config };
  redacted.deleteProtected = !!redacted.deletePassword;
  delete redacted.deletePassword;
  redacted.basicAuthConfigured = !!redacted.basicAuthHash;
  delete redacted.basicAuthHash;
  // AUTH-4 — the raw fleet token never leaves via the config API; surface only
  // whether one is set. It is revealed through the dedicated reveal endpoint.
  redacted.serviceTokenConfigured = !!redacted.serviceToken;
  delete redacted.serviceToken;
  // #966 — the Master's own scoped bearer token is the same class of live
  // credential as the fleet service token above, one level deeper. Copy
  // `master` before mutating it: `{ ...config }` above is shallow, so
  // `redacted.master` is still `config.master` itself until this copy.
  if (redacted.master && typeof redacted.master === 'object') {
    const redactedMaster = { ...redacted.master };
    redactedMaster.apiTokenConfigured = !!redactedMaster.apiToken;
    delete redactedMaster.apiToken;
    redacted.master = redactedMaster;
  }
  return redacted;
}

/** Boot's answer to `store.hasPriorUse()`, fixed once asked; `undefined` until then. */
let _bindPriorUse;

/**
 * Whether this install had been used, as the store answered it the FIRST time
 * anyone asked — at boot, before the server listens.
 *
 * The network-binding migration runs at boot, on `GET /api/config` and before
 * `PATCH /api/config` saves, and all three must reach the same answer. Every
 * other input to it is fixed after boot, but the store's answer is not: creating
 * a project or a login changes it. If boot's save of a fresh install's `false`
 * failed, a later live answer would flip the in-memory migration to the legacy
 * grace state, PATCH would persist it, and the next restart would listen on every
 * interface with nobody having chosen that. Fixing the answer at boot keeps the
 * three in step.
 * @returns {boolean} Whether the install showed prior use when first asked.
 */
function _installPriorUse() {
  if (_bindPriorUse === undefined) _bindPriorUse = store.hasPriorUse();
  return _bindPriorUse;
}

/**
 * Test seam: set, or with `undefined` clear, the fixed prior-use answer.
 * @param {boolean|undefined} value - The answer to hold.
 */
function _setInstallPriorUse(value) {
  _bindPriorUse = value;
}

/**
 * Directories THIS machine's OS keeps a background service out of, in both the
 * `~` form an operator types and the absolute form a path resolves to.
 *
 * Ships from the server for the same reason `bindState` does: the browser cannot
 * answer it. The question is what the OS running TangleClaw protects, and the
 * browser asking it may be a phone — `navigator.platform` would say iOS about a
 * Mac, and the one warning that matters would never appear. It is also the wrong
 * question to hardcode in the UI: `~/Documents` means nothing on the Linux hosts
 * TangleClaw also runs on, and a caution that fires there is a caution people
 * learn to ignore.
 *
 * Empty on every platform without this behaviour, so callers can treat "no roots"
 * as "nothing to warn about" rather than special-casing macOS themselves.
 *
 * @returns {string[]} Protected directory roots, or `[]` where none apply.
 */
function _protectedRoots() {
  // macOS TCC. A launchd-spawned process gets no prompt and no EPERM here — the
  // read simply never returns (#859), which is why this is worth saying BEFORE
  // someone points the product at one of them rather than only after.
  if (process.platform !== 'darwin') return [];
  return protectedRootsFor(userHome());
}

/**
 * Refuse an `accessLevel` transition reached through `PATCH /api/config`
 * unless the caller is the operator — the SAME admission
 * `operatorProjectCaller` (`server.js`) gives every other operator-only
 * project route, never the looser one (operator, Master, or any verified
 * project session) the generic launch-binding floor gives every OTHER
 * field on this route. A transition here grants the same standing
 * fleet-lifecycle-mutation authority `POST /api/master/authority` does
 * (#2132/#966), so a project session reaching it would otherwise grant the
 * Master write access to itself, with the audit trail's literal
 * `'operator'` fallback actor recording a transition the operator never
 * made (PRR-A BLOCKING, round 2 pre-inspection).
 * @param {object} req - The request.
 * @param {object} res - The response, written on refusal.
 * @returns {boolean} true when the caller is the operator.
 */
function _requireOperatorForMasterAuthority(req, res) {
  const access = sharedDocsAccess.resolveAccess(req);
  const refusal = sharedDocsAccess.projectRefusalFor(
    access, sharedDocsAccess.NEEDS.OPERATOR, "change the Project Master's lifecycle authority"
  );
  if (!refusal) return true;
  log.warn('Refused a Project Master authority change via PATCH /api/config', { code: refusal.code, kind: access.kind });
  errorResponse(res, refusal.status, refusal.message, refusal.code);
  return false;
}

/**
 * The message for an access level that was tightened without knowing which
 * engine the master runs (`applyMasterAccessLevel`'s conservative path).
 *
 * Says only what was read back. With the guard in place a Claude master is
 * bound; a master on any other engine reads no guard and is bound by
 * instructions that were NOT rewritten, so the message does not call the change
 * complete in either case.
 * @param {string} level - The level now in the master's level file
 * @param {boolean} guardBinds - Whether the level and the write guard both read back
 * @returns {string} Operator-facing error text
 */
function _masterTightenedBlindError(level, guardBinds) {
  const why = 'TangleClaw could not determine which engine the master runs (an installed engine profile may be unreadable, or no engine is detected on this machine)';
  const remedy = 'Fix that, then restart the master session.';
  if (guardBinds) {
    return `The master's access level is now "${level}" and its write guard is in place, so a master running Claude Code is held to it from its next tool call. `
      + `${why}, so its instructions and memory files were not refreshed and still describe the previous level. `
      + `A master on another engine has no write guard and follows those instructions. ${remedy}`;
  }
  return `The master's access level was written as "${level}", but the level file and the write guard did not both read back, so do not rely on this change having taken effect. `
    + `${why}, and its instructions and memory files were not refreshed either. ${remedy}`;
}

/**
 * Validate a PATCHed `master` settings object (the Project Master surface).
 * Merges the patch onto the current effective settings first, so a partial
 * object never wipes fields (the config-file merge is shallow), then
 * validates the full shape. Access levels beyond the enabled set are rejected
 * with an honest reason — a tier ships only WITH its structural enforcement,
 * never as a prose-only boundary.
 * @param {*} patch - The PATCH body's `master` value
 * @param {object} config - Current full config
 * @returns {{value?: object, error?: string}}
 */
function validateMasterPatch(patch, config) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: 'master must be an object' };
  }
  const known = ['accessLevel', 'engine', 'launchMode', 'scope', 'autoStart', 'medusaEnabled', 'medusaWake'];
  for (const key of Object.keys(patch)) {
    // Said in full for this one, because it is a real stored field: a caller
    // that could set it could attach a mode chosen for one engine to another.
    if (key === 'launchModeEngine') {
      return { error: 'master.launchModeEngine is not a settable field: TangleClaw records it when a launch mode is chosen. Send master.launchMode, with master.engine when the engine changes too.' };
    }
    if (!known.includes(key)) return { error: `master.${key} is not a settable field` };
  }
  const merged = { ...master.masterSettings(config), ...patch };
  if (!master.MASTER_ACCESS_LEVELS.includes(merged.accessLevel)) {
    return { error: `master.accessLevel must be one of: ${master.MASTER_ACCESS_LEVELS.join(', ')}` };
  }
  if (!master.MASTER_ENABLED_ACCESS_LEVELS.includes(merged.accessLevel)) {
    return { error: `master.accessLevel "${merged.accessLevel}" is not available yet — it ships only with real structural enforcement (currently enabled: ${master.MASTER_ENABLED_ACCESS_LEVELS.join(', ')})` };
  }
  // Everything about the ENGINE is checked only when this patch names
  // `engine` (#2128). The merged object also holds the engine already stored,
  // and checking that on every patch refused unrelated changes over a stored
  // engine whose profile had been removed or had gone bad. The Master bar's
  // access toggle sends `accessLevel` alone, so write access could not be
  // revoked: a safety control held hostage by an unrelated file. An engine
  // already stored is refused where it matters, when the Master is started
  // (`master.ensureMasterSession`).
  if (Object.prototype.hasOwnProperty.call(patch, 'engine') && merged.engine !== null) {
    if (typeof merged.engine !== 'string' || !merged.engine) {
      return { error: 'master.engine must be an engine id string or null' };
    }
    let masterProfile;
    try {
      masterProfile = store.engines.get(merged.engine);
    } catch (err) {
      // A profile file that does not parse cannot be chosen; that is a bad
      // request about that engine, not an internal failure of this route.
      // The parser's own message goes to the log and not into the response: it
      // quotes whatever bytes the file held at the point it gave up.
      log.warn('master.engine refused: its engine profile could not be read', {
        engine: merged.engine, error: err.message
      });
      return { error: `master.engine "${merged.engine}" cannot be selected: its engine profile file could not be read as JSON. Repair or restore the file.` };
    }
    if (!masterProfile) {
      return { error: `master.engine "${merged.engine}" is not a configured engine` };
    }
    // The profile must BE that engine's before it can be chosen for the
    // Master: the same identity test a launch makes. A file found under
    // another letter case on a case-insensitive disk, or one that does not
    // carry its own id, is not it.
    const masterIdentity = require('../startup-dialog').identify(masterProfile, merged.engine);
    if (!masterIdentity.profile) {
      return {
        error: `master.engine "${merged.engine}" cannot be selected: its engine profile is not usable (${masterIdentity.detail}). `
          + `An engine profile file must be a JSON object whose "id" is exactly "${merged.engine}".`
      };
    }
  }
  if (merged.scope !== 'all') {
    const s = merged.scope;
    if (!s || typeof s !== 'object' || s.type !== 'group' || !s.groupId || typeof s.groupId !== 'string') {
      return { error: "master.scope must be 'all' or { type: 'group', groupId }" };
    }
    if (!store.projectGroups.get(s.groupId)) {
      return { error: `master.scope group "${s.groupId}" does not exist` };
    }
    merged.scope = { type: 'group', groupId: s.groupId };
  }
  if (typeof merged.autoStart !== 'boolean') {
    return { error: 'master.autoStart must be a boolean' };
  }
  // Same rule as autoStart, for the same reason: only a real boolean opts the
  // Master onto the switchboard — a truthy string from a hand-edited config
  // must not make it addressable by accident.
  if (typeof merged.medusaEnabled !== 'boolean') {
    return { error: 'master.medusaEnabled must be a boolean' };
  }
  if (typeof merged.medusaWake !== 'boolean') {
    return { error: 'master.medusaWake must be a boolean' };
  }
  // The NAME check only: a mode no engine defines at all is a typo, and the
  // answer names the valid set. Whether the mode belongs to the engine the
  // Master will have is judged once, by `master.masterLaunchModeAfterPatch` in
  // the route, because that engine can also come from `defaultEngine` in the
  // same request and is not known here.
  //
  // Only what this PATCH actually SENT is name-checked, unlike the fields
  // above. `knownLaunchModes()` is the union across INSTALLED engines, so
  // uninstalling an engine shrinks it — and validating the merged value would
  // then reject every master PATCH on the install, including ones that only
  // toggle autoStart, over a stored mode the operator never touched. A stored
  // mode the engine does not define starts as 'default' (`_masterRuntime`).
  if ('launchMode' in patch) {
    if (typeof patch.launchMode !== 'string' || !patch.launchMode) {
      return { error: 'master.launchMode must be a launch-mode id string' };
    }
    const knownModes = master.knownLaunchModes();
    if (!knownModes.includes(patch.launchMode)) {
      return { error: `master.launchMode must be one of: ${knownModes.join(', ')}` };
    }
  }
  // No `merged.launchMode` type check: `masterSettings` normalizes it to a
  // non-empty string before the merge, so a guard here would be unreachable —
  // dead code that reads like a safety net. The patched value is checked above,
  // which is the only place an untrusted value enters.
  const value = {
    accessLevel: merged.accessLevel,
    engine: merged.engine,
    launchMode: merged.launchMode,
    // Carried as stored, never from the patch (`known` above refuses it):
    // the route sets it with the mode, from the one rule that pairs them.
    launchModeEngine: merged.launchModeEngine,
    scope: merged.scope,
    autoStart: merged.autoStart,
    medusaEnabled: merged.medusaEnabled,
    medusaWake: merged.medusaWake
  };
  // #2132/#966 — carried forward ONLY when already on `config.master` before
  // this patch, never introduced fresh here: this route never owns an
  // Operator-authority transition or the Master's own scoped token (that is
  // POST /api/master/authority's job alone). Without this, an unrelated
  // master.engine/launchMode PATCH would silently erase an already-recorded
  // transition by replacing `config.master` wholesale with just the 8 keys
  // above — a real audit record deleted by a save that never touched it.
  const existing = (config && typeof config.master === 'object' && config.master) || {};
  if (Number.isInteger(existing.lifecycleGeneration)) value.lifecycleGeneration = existing.lifecycleGeneration;
  if (typeof existing.lifecycleUpdatedAt === 'string') value.lifecycleUpdatedAt = existing.lifecycleUpdatedAt;
  if (typeof existing.lifecycleUpdatedBy === 'string') value.lifecycleUpdatedBy = existing.lifecycleUpdatedBy;
  if (typeof existing.apiToken === 'string' && existing.apiToken) value.apiToken = existing.apiToken;
  // Carried alongside apiToken for the same reason, though not named in the
  // originating ruling: dropping apiTokenEnabled while keeping apiToken would
  // silently disable the very token just preserved, the same wholesale-replace
  // defect this fix exists to close.
  if (typeof existing.apiTokenEnabled === 'boolean') value.apiTokenEnabled = existing.apiTokenEnabled;
  return { value };
}


/**
 * Validate the SHAPE of a PATCHed `quickCommands` value — the GLOBAL list
 * `public/session.js` actually renders, unlike the per-project list
 * `lib/projects.js`'s `PROJECT_UPDATE_VALIDATORS` floor covers (#1339; that
 * floor's own comment names this route's allowlist as the live defect it does
 * not reach). Mirrors that floor's shape exactly: an array of objects, each
 * with string `label` and `command`.
 *
 * `cmd !== null && typeof cmd === 'object' && !Array.isArray(cmd)` is
 * load-bearing, not defensive noise: `typeof null` is `'object'` and
 * `typeof []` is also `'object'`, so without both checks `[null]` or a nested
 * array element would reach `cmd.label` as a property read on something that
 * is not a plain object, rather than failing the type check outright.
 * @param {unknown} value - Candidate value for the global `quickCommands`.
 * @returns {boolean} Whether the value matches the required shape.
 */
function validateQuickCommandsShape(value) {
  return Array.isArray(value) && value.every((cmd) => (
    cmd !== null
    && typeof cmd === 'object'
    && !Array.isArray(cmd)
    && typeof cmd.label === 'string'
    && typeof cmd.command === 'string'
  ));
}

/**
 * Register the config routes on the shared route table.
 * @param {object} deps - What the handlers use that still lives in `server.js`.
 * @param {(config: object, route: {adoptionSupplies: boolean, optOut: boolean}) => object} deps._decideSetupCredential -
 *   Whether finishing setup needs a login, may offer the choice of none, and may be skipped, for one config.
 * @param {() => object} deps._gateIngress - Read the ingress door (the Caddyfile's gate) as the auth gate sees it.
 * @returns {void}
 */
function register(deps) {
  const { _decideSetupCredential, _gateIngress } = deps;

  route('GET', '/api/config', async (_req, res) => {
    const config = store.config.load();
    jsonResponse(res, 200, await _withBindState(config));
  });

  /**
   * The port a tailnet client should reach this install on — the same choice
   * `lib/https-setup.js#effectiveOperatorFrontDoor` makes for its origin,
   * extracted to a bare port number: `caddyHttpsPort` when Caddy fronts the
   * server, else the port the server itself is bound to. Kept beside that
   * function rather than duplicating its conditional from scratch, so the two
   * can never name different "front door" ports for the same config.
   * @param {object} config
   * @returns {number}
   */
  function _activeListenPort(config) {
    if (config && config.ingressMode === 'caddy') {
      return config.caddyHttpsPort || store.DEFAULT_CONFIG.caddyHttpsPort;
    }
    return httpsSetup.effectiveServerPort(config);
  }

  /**
   * The scheme a tailnet client should use — the other half of
   * `_activeListenPort`'s choice. Caddy always terminates TLS for its site
   * (`https`, independent of what the server behind it speaks:
   * `effectiveServerProtocol` answers `http` in caddy mode on purpose, since
   * THAT is about the server's own internal bind). Direct mode has no proxy
   * to terminate TLS, so it is exactly `effectiveServerProtocol`'s answer —
   * `https` only when a cert and key are actually configured, else `http`
   * (PRR-B C1/C2: an enabled direct-HTTP install must not advertise an
   * `https://` origin nothing answers).
   * @param {object} config
   * @returns {'http'|'https'}
   */
  function _activeListenScheme(config) {
    if (config && config.ingressMode === 'caddy') return 'https';
    return httpsSetup.effectiveServerProtocol(config);
  }

  /**
   * Attach the server-resolved network-binding state to a config response.
   *
   * The settings UI renders a control whose meaning depends on rules the SERVER
   * owns — caddy mode overriding an opt-in, an unchosen install held deliberately
   * wide. Every time the frontend re-derived those rules from the raw fields it
   * drifted, and the drift was always a control that misdescribed the socket. So
   * the server ships its own answer and the UI renders it.
   * @param {object} config - Full config.
   * @returns {object} Redacted config plus a `bindState` block.
   */
  async function _withBindState(config) {
    // Classify from the MIGRATED view. `load()` merges DEFAULT_CONFIG's `false`,
    // so an install whose boot-time persist failed — the contingency boot itself
    // tolerates as non-fatal — would otherwise be reported as "closed" while its
    // socket is wide, and the settings modal would draw a shut door over an open
    // one and hide the way out. In-memory only: a GET must not write.
    bindPolicy.migrateLegacyBind(config, store.config.isKeyPersisted(bindPolicy.OPT_IN_KEY), _installPriorUse());
    // `resolveAdvertisedOrigin` itself skips running `tailscale` at all when
    // `enabled` is falsy (#1380) — one call covers both the on and off states,
    // so this never needs its own "is the mode on" branch.
    const tailscaleStatus = await tailscaleIngress.resolveAdvertisedOrigin({
      enabled: config.tailscaleMode === true,
      port: _activeListenPort(config),
      scheme: _activeListenScheme(config)
    });
    return {
      ...redactConfigSecrets(config),
      bindState: bindPolicy.describeBindState(config, authGate.resolveGateState(() => config, store.authSessions, _gateIngress)),
      protectedRoots: _protectedRoots(),
      tailscaleStatus
    };
  }

  // PATCH /api/config
  route('PATCH', '/api/config', async (req, res, _params, body) => {
    if (!body || typeof body !== 'object') {
      return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
    }

    const config = store.config.load();
    // Re-assert the legacy grace state before this handler saves anything. Boot
    // normally records it, but if that write failed (read-only disk, permissions)
    // the key is still absent here — and since `load()` merges the default, saving
    // would silently persist `false` and narrow a remote operator's install on
    // their next restart, without them choosing. Idempotent: a no-op once recorded.
    bindPolicy.migrateLegacyBind(config, store.config.isKeyPersisted(bindPolicy.OPT_IN_KEY), _installPriorUse());
    // Snapshot of pre-mutation values for fields whose downstream effects
    // are conditional on whether the value actually changed (#247 hardening
    // — saveGlobalSettings POSTs the field on every Save click, so unrelated
    // UI saves were triggering an N-project filesystem walk).
    const oldStripAiCoauthors = config.stripAiCoauthors;
    // Same reason, for the master's access level: the loop below replaces
    // `config.master` wholesale, so the previous level has to be read before it.
    const oldMasterAccessLevel = master.masterSettings(config).accessLevel;
    const oldMasterMedusaEnabled = master.masterSettings(config).medusaEnabled;
    // And for the engine the Master is set to, which the loop can change through
    // `master.engine` or, for a Master that follows it, through `defaultEngine`.
    // `config.master` is replaced below, never edited in place, so holding the
    // reference keeps what was stored.
    const masterEngineBefore = { defaultEngine: config.defaultEngine, master: config.master };
    // Whether setup was still OPEN when this request arrived. Captured here
    // because the loop below writes `body.setupComplete` straight onto `config` —
    // read it afterwards and every request looks like an install that was already
    // finished, which is exactly how a first-run-only gate becomes a gate that
    // never fires.
    const wasSetupOpen = config.setupComplete === false;
    const allowedFields = [
      'serverPort', 'ttydPort', 'defaultEngine',
      'projectsDir', 'deletePassword', 'quickCommands', 'theme',
      'chimeEnabled', 'chimeMuted', 'peekMode', 'setupComplete',
      'portScannerEnabled', 'portScannerIntervalMs', 'behindOriginCheckEnabled',
      'httpsEnabled', 'httpsCertPath', 'httpsKeyPath',
      'stripAiCoauthors', 'ingressMode', 'publicDomain', 'bindAllInterfaces',
      'caddyHttpsPort', 'caddyHttpPort',
      // Orthogonal to `ingressMode` on purpose (#1380's first design
      // correction): this flag says only "advertise a tailnet hostname in
      // generated links," never how TLS is terminated, so it sits beside
      // `ingressMode` as its own boolean rather than widening that field into
      // a four-state one.
      'tailscaleMode',
      // authEnabled / basicAuthUser / basicAuthHash are deliberately ABSENT. This
      // route authenticates nobody, validated only the SHAPE of a hash, and had no
      // lifecycle gate — so on an ungated, network-reachable install an
      // unauthenticated caller could set an admin credential of their choosing and
      // lock the owner out. Credential changes go through POST /api/auth/credential,
      // which refuses unless a live gate is already authenticating the request.
      'serviceTokenEnabled', 'wrapDisabled', 'master', 'medusaWatchdog',
      'ignoredLeaseProjects'
    ];

    // Refuse rather than ignore. Unknown keys below are silently skipped by design,
    // which is right for a field this route never owned — but these three it DID
    // own until now, so a caller still sending them would get 200 and no change,
    // and "your password is updated" when it is not is the exact false report this
    // work exists to end.
    const CREDENTIAL_FIELDS = ['authEnabled', 'basicAuthUser', 'basicAuthHash'];
    const sentCredential = CREDENTIAL_FIELDS.filter((k) => k in body);
    if (sentCredential.length > 0) {
      return errorResponse(res, 409,
        `${sentCredential.join(', ')} cannot be set here. Change the login from settings, `
        + 'which uses POST /api/auth/credential, or run `node scripts/reset-admin.js` at a terminal.',
        'CREDENTIAL_ROUTE_MOVED');
    }

    const validThemes = ['dark', 'light', 'high-contrast'];
    const validPeekModes = ['drawer', 'modal', 'alert'];
    const validIngressModes = ['direct', 'caddy'];

    let requiresRestart = false;

    for (const [key, value] of Object.entries(body)) {
      if (!allowedFields.includes(key)) continue;

      // Project Master settings — merge-then-validate as one object (partial
      // patches never wipe fields), stored whole. Handled before the generic
      // scalar validations because the normalized value replaces the raw one.
      if (key === 'master') {
        const check = validateMasterPatch(value, config);
        if (check.error) return errorResponse(res, 400, check.error, 'BAD_REQUEST');
        config.master = check.value;
        continue;
      }
      // #1839: the watchdog's tunables, bounded and merged over what is stored.
      if (key === 'medusaWatchdog') {
        const check = medusaWatchdog.validatePatch(value, config.medusaWatchdog);
        if (check.error) return errorResponse(res, 400, check.error, 'BAD_REQUEST');
        config.medusaWatchdog = check.value;
        continue;
      }

      // Validate specific fields
      if ((key === 'serverPort' || key === 'ttydPort') && typeof value !== 'number') {
        return errorResponse(res, 400, `${key} must be a number`, 'BAD_REQUEST');
      }
      if (key === 'theme' && !validThemes.includes(value)) {
        return errorResponse(res, 400, `theme must be one of: ${validThemes.join(', ')}`, 'BAD_REQUEST');
      }
      if (key === 'peekMode' && !validPeekModes.includes(value)) {
        return errorResponse(res, 400, `peekMode must be one of: ${validPeekModes.join(', ')}`, 'BAD_REQUEST');
      }
      if (key === 'setupComplete' && typeof value !== 'boolean') {
        return errorResponse(res, 400, 'setupComplete must be a boolean', 'BAD_REQUEST');
      }
      if (key === 'chimeMuted' && typeof value !== 'boolean') {
        return errorResponse(res, 400, 'chimeMuted must be a boolean', 'BAD_REQUEST');
      }
      if (key === 'tailscaleMode' && typeof value !== 'boolean') {
        return errorResponse(res, 400, 'tailscaleMode must be a boolean', 'BAD_REQUEST');
      }
      // #1339 — this is the quickCommands list the browser actually renders
      // (public/session.js reads sessionState.config.quickCommands, the GLOBAL
      // config), unlike the per-project list lib/projects.js already shape-checks.
      if (key === 'quickCommands' && !validateQuickCommandsShape(value)) {
        return errorResponse(res, 400,
          'quickCommands must be an array of objects with string label and command', 'BAD_REQUEST');
      }
      // #1382 — the port-import "Ignore" list, moved here from per-browser
      // localStorage so it syncs across every device reaching this server.
      if (key === 'ignoredLeaseProjects') {
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
          return errorResponse(res, 400, 'ignoredLeaseProjects must be an array of strings', 'BAD_REQUEST');
        }
      }
      if (key === 'portScannerEnabled' && typeof value !== 'boolean') {
        return errorResponse(res, 400, 'portScannerEnabled must be a boolean', 'BAD_REQUEST');
      }
      if (key === 'behindOriginCheckEnabled' && typeof value !== 'boolean') {
        return errorResponse(res, 400, 'behindOriginCheckEnabled must be a boolean', 'BAD_REQUEST');
      }
      if (key === 'portScannerIntervalMs') {
        if (typeof value !== 'number' || value < 10000 || value > 600000) {
          return errorResponse(res, 400, 'portScannerIntervalMs must be a number between 10000 and 600000', 'BAD_REQUEST');
        }
      }

      if (key === 'httpsEnabled' && typeof value !== 'boolean') {
        return errorResponse(res, 400, 'httpsEnabled must be a boolean', 'BAD_REQUEST');
      }
      // Only a real boolean opens the door — a truthy string from a hand-edited
      // config or a sloppy client must not widen the bind by accident.
      if (key === 'bindAllInterfaces' && typeof value !== 'boolean') {
        return errorResponse(res, 400, 'bindAllInterfaces must be a boolean', 'BAD_REQUEST');
      }
      if (key === 'ingressMode' && !validIngressModes.includes(value)) {
        return errorResponse(res, 400, `ingressMode must be one of: ${validIngressModes.join(', ')}`, 'BAD_REQUEST');
      }
      if (key === 'publicDomain' && value !== null && typeof value !== 'string') {
        return errorResponse(res, 400, 'publicDomain must be a string or null', 'BAD_REQUEST');
      }
      if ((key === 'caddyHttpsPort' || key === 'caddyHttpPort')) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
          return errorResponse(res, 400, `${key} must be an integer between 1 and 65535`, 'BAD_REQUEST');
        }
      }
      if (key === 'stripAiCoauthors' && typeof value !== 'boolean') {
        return errorResponse(res, 400, 'stripAiCoauthors must be a boolean', 'BAD_REQUEST');
      }
      if ((key === 'httpsCertPath' || key === 'httpsKeyPath') && value !== null && typeof value !== 'string') {
        return errorResponse(res, 400, `${key} must be a string or null`, 'BAD_REQUEST');
      }
      // AUTH-2 — basic_auth gate config.
      // AUTH-4 — M2M service-token gate master switch. The raw `serviceToken` is
      // NOT patchable here (managed via the rotate endpoint + auto-generation);
      // only the enable flag is operator-settable.
      if (key === 'serviceTokenEnabled' && typeof value !== 'boolean') {
        return errorResponse(res, 400, 'serviceTokenEnabled must be a boolean', 'BAD_REQUEST');
      }
      // #2278 — this field picks which engine a new project, and a Master that
      // follows it, launches with, so a value of the wrong type or naming no
      // configured engine must be refused here rather than stored and left to
      // degrade silently at the point something tries to launch with it. Same
      // identity test `master.engine` makes a few lines up: a profile found
      // under another id, or that cannot be read as JSON, is not a match.
      if (key === 'defaultEngine') {
        if (typeof value !== 'string' || !value) {
          return errorResponse(res, 400, 'defaultEngine must be a non-empty string', 'BAD_REQUEST');
        }
        let defaultEngineProfile;
        try {
          defaultEngineProfile = store.engines.get(value);
        } catch (err) {
          log.warn('defaultEngine refused: its engine profile could not be read', {
            engine: value, error: err.message
          });
          return errorResponse(res, 400,
            `defaultEngine "${value}" cannot be selected: its engine profile file could not be read as JSON. Repair or restore the file.`,
            'BAD_REQUEST');
        }
        const defaultEngineIdentity = require('../startup-dialog').identify(defaultEngineProfile, value);
        if (!defaultEngineIdentity.profile) {
          return errorResponse(res, 400,
            `defaultEngine "${value}" is not a configured engine (${defaultEngineIdentity.detail})`,
            'BAD_REQUEST');
        }
      }
      // Normalize empty-string cert paths to null so persisted shape matches /api/setup/complete
      let storedValue = value;
      if ((key === 'httpsCertPath' || key === 'httpsKeyPath' || key === 'publicDomain')
          && (value === '' || value === null)) {
        storedValue = null;
      }

      if (key === 'serverPort' || key === 'ttydPort' || key === 'httpsEnabled' || key === 'httpsCertPath' || key === 'httpsKeyPath' || key === 'ingressMode' || key === 'bindAllInterfaces') {
        if (config[key] !== storedValue) requiresRestart = true;
      }

      // Hash deletePassword before persisting
      if (key === 'deletePassword' && storedValue !== null) {
        config[key] = projects.hashPassword(storedValue);
      } else {
        config[key] = storedValue;
      }
    }

    // The Master's launch mode belongs to the engine it was chosen for. Judged
    // after the loop, once, because both fields that set the Master's engine may
    // arrive in one request in either order. A save that touches neither cannot
    // change the engine and is left alone, so an unrelated save never rewrites
    // the stored Master block.
    const warnings = [];
    let masterModeReset = null;
    if ('master' in body || 'defaultEngine' in body) {
      const outcome = master.masterLaunchModeAfterPatch(masterEngineBefore, config, body.master);
      if (outcome.error) return errorResponse(res, 400, outcome.error, 'BAD_REQUEST');
      const held = master.masterSettings(config);
      if (held.launchMode !== outcome.launchMode || held.launchModeEngine !== outcome.launchModeEngine) {
        config.master = { ...held, launchMode: outcome.launchMode, launchModeEngine: outcome.launchModeEngine };
      }
      if (outcome.reset) {
        masterModeReset = outcome.reset;
        warnings.push(master.masterLaunchModeResetWarning(outcome.reset));
      }
      if (outcome.unused) warnings.push(master.masterLaunchModeUnusedWarning(outcome.unused));
    }

    // Validate HTTPS cert pair when HTTPS is enabled (mirrors /api/setup/complete).
    // Allow httpsEnabled=true with no cert paths — createServer() will log and fall
    // back to HTTP gracefully so existing installs don't break on upgrade.
    if (config.httpsEnabled && config.httpsCertPath && config.httpsKeyPath) {
      const validation = httpsSetup.validateCertFiles(config.httpsCertPath, config.httpsKeyPath);
      if (!validation.ok) {
        return errorResponse(res, 400, `HTTPS cert validation failed: ${validation.error}`, 'BAD_REQUEST');
      }
    } else if (config.httpsEnabled && (config.httpsCertPath || config.httpsKeyPath)) {
      return errorResponse(res, 400, 'Both httpsCertPath and httpsKeyPath are required when HTTPS is enabled with cert paths', 'BAD_REQUEST');
    }

    // The AUTH-2 both-or-neither check that used to sit here is gone with the fields
    // it guarded. This route no longer accepts authEnabled/basicAuthUser/
    // basicAuthHash at all — it refuses them above — so no request reaching this
    // line can create the half-credential state, and the check could only ever fire
    // on a config that was ALREADY inconsistent on disk. There it did harm: it
    // rejected every unrelated write (a theme, a port) with an instruction to send
    // credential fields this same route refuses, which is an error with no exit.
    // The invariant is enforced where the fields are now written — POST
    // /api/auth/credential, first-run setup, and scripts/reset-admin.js — and by
    // buildCaddyfileContent's own guard at generation.

    // AUTH-4 — enabling the M2M gate auto-generates a fleet token on first enable,
    // so the config can never hold serviceTokenEnabled=true with a null token (the
    // fail-closed state the gate would otherwise 500 on). The invariant lives in
    // one place (service-token.ensureTokenWhenEnabled) shared with the rotate
    // endpoint — see [[feedback_symmetric_capability_gates]]. The token is retained
    // (inert) on disable so re-enabling is stable. Logged without the secret.
    if (serviceToken.ensureTokenWhenEnabled(config)) {
      log.info('AUTH-4 service token auto-generated on enable');
    }

    // The wizard's "Skip" closes setup via PATCH { setupComplete: true }, so this
    // path must honor the SAME rule as /api/setup/complete or Skip is a way past the
    // login gate. That rule is no longer "are we in caddy mode" — it is "can this
    // machine enforce a credential", asked of the one derivation both routes share.
    // Gating on `ingressMode === 'caddy'` here left the default fresh install
    // (direct mode, caddy installed) able to finish setup with no login at all,
    // which is the entire defect the sibling route was changed to close.
    //
    // Same reasoning for the engine requirement, and the same sibling trap: Skip
    // closes setup here, so a rule enforced only on /api/setup/complete is a rule
    // with a door beside it. An install that finishes with no engine is a
    // dashboard that can launch nothing.
    //
    // Guarded only on the explicit transition, and only while setup is still
    // open: re-saving settings on a finished install must never be refused
    // because an engine was uninstalled later.
    if (body.setupComplete === true && wasSetupOpen) {
      if (!await engines.anyEngineInstalled()) {
        return errorResponse(res, 400,
          'No AI engine is installed, so there would be nothing to launch. Install one '
          + '(Claude Code, Codex, Aider or Antigravity), then press Check again.',
          'ENGINE_REQUIRED');
      }
    }

    // Only the explicit complete-setup transition on an unfinished install is
    // guarded, so unrelated PATCHes — and a finished install re-sending the flag —
    // are never blocked. Skip never carries the choice of no login: that choice is
    // made on the login step and submitted to /api/setup/complete, so here the
    // only way through is a login already in hand.
    if (body.setupComplete === true && wasSetupOpen) {
      // Skip adopts nothing, so an `adopt` plan supplies no login here — the
      // probe ships this route's answer separately (`skipAllowed`) so the wizard
      // never offers a Skip that this refuses.
      if (_decideSetupCredential(config, { adoptionSupplies: false, optOut: false }).required) {
        // Names no choice this install may not have: the wizard's login step is not
        // shown where Finish adopts an existing Caddy login, and the choice of none
        // is not offered where it is refused.
        return errorResponse(res, 400,
          'Skip cannot finish setup here, because it puts no login in front of TangleClaw and one is '
          + 'needed. Finish setup from the wizard\'s last step instead.',
          'ADMIN_REQUIRED');
      }
    }

    // #2132, Ruling A491-W2A-R4 — computed and applied BEFORE the save below,
    // never after: `applyOperatorAuthorityChange` mutates `config.master`
    // in place (lifecycleGeneration/lifecycleUpdatedAt/lifecycleUpdatedBy),
    // and the one `store.config.save(config)` in this route is the only
    // thing that reaches disk. Applying it after that save (as a first
    // version of this route once did) left the response reporting a
    // transition that a subsequent `store.config.load()` would never see.
    const newMasterAccessLevel = master.masterSettings(config).accessLevel;
    if (newMasterAccessLevel !== oldMasterAccessLevel) {
      // Nothing is saved yet at this point, so a refusal here persists
      // nothing — see _requireOperatorForMasterAuthority's own doc comment.
      if (!_requireOperatorForMasterAuthority(req, res)) return;
      masterAuthority.applyOperatorAuthorityChange(config, {
        accessLevel: newMasterAccessLevel,
        actor: (req.tcSession && req.tcSession.username) || 'operator'
      });
    }

    store.config.save(config);

    if (masterModeReset) {
      log.info('Master launch mode reset to default: the engine set for the Master changed and the mode was chosen for the previous one', {
        fromEngine: masterModeReset.fromEngine, toEngine: masterModeReset.toEngine,
        fromMode: masterModeReset.mode, toMode: 'default'
      });
    }

    // The master's access level takes effect on its NEXT TOOL CALL, not its next
    // launch — that is the whole point of the level being a file the write guard
    // reads per invocation. So the flip has to reach disk here, on the change
    // path, rather than waiting for an ensure the operator has no reason to run.
    //
    // After the save, never before: an earlier field's validation failure returns
    // 400 without saving, and a level file more permissive than the stored config
    // is the one inconsistency this must not create. (This is about the WRITE
    // GUARD file below, not the audit fields above — those must be IN the save,
    // per the comment there.)
    //
    // Routed through the master module rather than done inline, so `home` resolves
    // in one place and a route test can stub the entry point instead of rewriting
    // the operator's live master posture. An absent master home is a no-op there.
    let masterLevelError = null;
    if (newMasterAccessLevel !== oldMasterAccessLevel) {
      try {
        const { applied } = master.applyMasterAccessLevel(newMasterAccessLevel);
        log.info('Master access level changed', {
          from: oldMasterAccessLevel, to: newMasterAccessLevel, applied
        });
      } catch (err) {
        // Reported to the CALLER, not just the log, and this is the direction that
        // matters: a failed apply does NOT reliably degrade toward the stricter
        // posture. On write→read-only the config now says `read-only` while the
        // level file still says `write` and the guard keeps allowing — a
        // revocation that returns 200 and did not happen. Since the operator
        // cannot see the difference, the request has to say so.
        //
        // The config save is deliberately left standing rather than rolled back:
        // the stored intent is correct, and the next ensure reconciles the guard to
        // it. What must not happen is the UI painting a boundary that did not move.
        log.error(err.runtimeUnknown
          ? 'Master access level tightened without resolving its engine — identity not refreshed'
          : 'Master access level saved but not applied — the write guard still enforces the previous level', {
          from: oldMasterAccessLevel, to: newMasterAccessLevel, error: err.message,
          levelApplied: err.levelApplied === true, guardBinds: err.guardBinds
        });
        // Two different truths, and saying the wrong one is the defect this whole
        // route is about. `levelApplied` means the level file was already written
        // and the guard reads it per tool call, so the new level IS in force —
        // what may not have happened is restoring a guard the master tampered with.
        // Held, not returned here. Returning mid-handler skipped the port-scanner
        // restart and the stripAiCoauthors hook sync below — unrelated settings in
        // the same save silently not taking effect, which is a second failure
        // bolted onto the first. The response is still a 500; it just happens
        // after the rest of the save has finished doing what it was asked.
        //
        // A third truth: the change tightened access and what the master runs on
        // could not be determined. The level and the write guard were written
        // without that answer and its instructions were not, so the sentence has to
        // say which half holds — and, when the guard did not read back, that the
        // revocation is not confirmed at all.
        if (err.runtimeUnknown && err.levelApplied) {
          masterLevelError = _masterTightenedBlindError(newMasterAccessLevel, err.guardBinds === true);
        } else if (err.levelApplied && err.guardBinds === false) {
          // The engine resolved and the refresh finished; what did not happen is
          // the level file and write guard both reading back. That is known, so it
          // is said outright rather than folded into "may be a step behind". The
          // remedy must not ask the operator to raise access in order to retry.
          masterLevelError = `The master's access level was written as "${newMasterAccessLevel}" and its instructions were refreshed, `
            + 'but the level file and the write guard did not both read back, so do not rely on this change having taken effect for a master running Claude Code. '
            + 'Repair the master\'s home directory and the `.claude` directory inside it so they are writable, then restart the master session: '
            + 'a master that resolves as Claude Code has its write guard regenerated at start. Check the guard status in Master settings afterwards. '
            + 'Do not change the access level to retry.';
        } else masterLevelError = err.levelApplied
          ? `The master's access level is now "${newMasterAccessLevel}", but the refresh that should have followed it did not finish. `
            + 'Its identity, its memory scaffold or its write guard may be a step behind. Restart the master session to bring them back into line.'
          : `Settings were saved, but the master's access level could not be applied — it is still enforcing "${oldMasterAccessLevel}". `
            + 'TangleClaw must be able to tell which engine the master runs before it raises access: if an installed engine profile file cannot be read, repair it. If the engine set for the master is not detected on this machine, the change goes through once it is detected again; set `master.engine` to another engine only if that is the engine the running master actually uses. Restarting the master session then reconciles it.';
      }
    }

    // The Master's switchboard listener follows `medusaEnabled` the moment it is
    // saved (#996), the way the access level does above — not on the next ensure.
    // One rule (listener ⇔ live ∧ enabled) lives in `syncMasterMedusa`; this only
    // feeds it the fresh setting against tmux truth. Unanswered tmux → touch
    // nothing, because starting a listener for a Master that may not exist is
    // the #836 shape. Failure is logged, never fatal: the save already stood.
    if ('master' in body) {
      try {
        const probe = master.masterLiveness();
        if (probe.answered) {
          master.syncMasterMedusa({ live: probe.live, enabled: master.masterSettings(config).medusaEnabled });
        }
      } catch (err) {
        log.warn('Master Medusa listener sync after settings save failed', { error: err.message });
      }
      // The identity follows the setting too, or the Master sits on the bus with
      // instructions that still say it is not a participant until something else
      // happens to run an ensure — which is exactly what was found the first time
      // this was flipped live. `skipIfAbsent` so a save on an install that has
      // never opened the Master creates no master state. Like the access-level
      // refresh above, the running Master still reads it only at launch (#968).
      if (master.masterSettings(config).medusaEnabled !== oldMasterMedusaEnabled) {
        try {
          master.refreshMasterIdentity({ skipIfAbsent: true });
        } catch (err) {
          log.warn('Master identity refresh after medusaEnabled change failed', { error: err.message });
        }
      }
    }

    // Restart or stop port scanner if settings changed
    if ('portScannerEnabled' in body || 'portScannerIntervalMs' in body) {
      portScanner.stopScanner();
      if (config.portScannerEnabled) {
        portScanner.startScanner(config.portScannerIntervalMs);
      }
    }

    // #247 — toggling stripAiCoauthors re-syncs the commit-msg hook across
    // EVERY registered project (including archived ones — Critic flagged
    // that filtering on `{archived: false}` would leave orphan hooks on
    // archived projects after a toggle-OFF). Symmetric with the install
    // path: turn ON → install everywhere a `.git/` exists; turn OFF →
    // uninstall everywhere (drift-aware — foreign hooks are preserved by
    // syncGitHooks). Gated on actual value change so a Save click that
    // didn't touch this toggle doesn't trigger an N-project filesystem
    // walk (#247 hardening).
    if ('stripAiCoauthors' in body && body.stripAiCoauthors !== oldStripAiCoauthors) {
      const all = store.projects.list(); // no archived filter — see above
      for (const project of all) {
        if (!project.path) continue;
        try {
          gitHooks.syncGitHooks(project.path, config);
        } catch (err) {
          log.warn('Failed to sync git hooks after stripAiCoauthors toggle', {
            project: project.name, error: err.message
          });
        }
      }
      // #252 — also flip the global git template so non-TC-managed repos
      // pick the hook up on next `git init` / `git clone`. Independent of
      // the per-project walk above: the template covers FUTURE repos
      // anywhere on the host; the per-project loop covers EXISTING
      // TC-managed repos. Both must run on every toggle.
      try {
        gitTemplate.syncGlobalTemplate(config);
      } catch (err) {
        log.warn('Failed to sync global git template after stripAiCoauthors toggle', {
          error: err.message
        });
      }
    }

    // Build redacted response — strip credential hashes (deletePassword,
    // basicAuthHash) — and re-resolve the bind state so the UI re-renders the
    // Network Exposure control from the server's answer, not its own guess.
    const redacted = await _withBindState(config);

    if (masterLevelError) {
      // The save stood, so a reset it made is said here too: this answer has no
      // `warnings` field, and a setting changed without a word is what the
      // warning exists to prevent.
      return errorResponse(res, 500, [masterLevelError, ...warnings].join(' '), 'MASTER_LEVEL_NOT_APPLIED');
    }

    // `warnings` is `[]` when there is nothing to say, never absent: a field that
    // appears only sometimes makes every reader probe for it.
    jsonResponse(res, 200, { ok: true, config: redacted, requiresRestart, warnings });
  });
}

module.exports = { register, _installPriorUse, _setInstallPriorUse };
