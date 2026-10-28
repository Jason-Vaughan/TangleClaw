'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// node:sqlite (used by lib/store.js, required just below) needs Node 22+. Fail
// fast with a clear message instead of a cryptic "Cannot find module
// 'node:sqlite'" on an older runtime.
const _nodeMajor = Number(process.versions.node.split('.')[0]);
if (Number.isFinite(_nodeMajor) && _nodeMajor < 22) {
  console.error(`TangleClaw requires Node.js 22+ (node:sqlite); detected ${process.versions.node}.`);
  process.exit(1);
}

const { createLogger, setLevel, initFileLogging } = require('./lib/logger');
const store = require('./lib/store');
const { ruleLabel } = require('./lib/rule-label');
const rulesRefresh = require('./lib/session-rules-refresh');

// --- Shared Docs Watcher ---
const sharedDocWatchers = new Map();
const docDebounceTimers = new Map();

/**
 * @type {number} Trailing debounce on a shared doc's `fs.watch` events.
 *
 * Sized for ONE atomic save — a write followed by a rename arrives as two
 * events milliseconds apart — and deliberately not for an editing session.
 * Who is told of a change, and how often, is the delivery rule's and the
 * per-reader coalescing's in `lib/shared-docs.js`, not this window's.
 */
const SHARED_DOC_DEBOUNCE_MS = 500;

/** @type {number} How long shutdown waits for shared-doc notices already being sent. */
const SHUTDOWN_NOTICE_DRAIN_MS = 5000;

/**
 * Close and forget a shared doc's fs.watch handle and any pending debounce
 * timer. Called on delete, and on retarget (before opening the watcher on
 * the doc's new filePath) — without this, an edited or deleted doc leaked
 * one live fs.watch handle per doc for the life of the server process (#990
 * review).
 *
 * @param {string} docId - Shared doc id
 * @returns {void}
 */
function closeSharedDocWatcher(docId) {
  const entry = sharedDocWatchers.get(docId);
  if (entry) {
    try { entry.watcher.close(); } catch (e) { /* already closed */ }
    sharedDocWatchers.delete(docId);
  }
  if (docDebounceTimers.has(docId)) {
    clearTimeout(docDebounceTimers.get(docId));
    docDebounceTimers.delete(docId);
  }
}

function refreshSharedDocWatchers() {
  const docs = store.sharedDocs.list();
  const liveIds = new Set(docs.map(d => d.id));
  // A doc deleted since the last refresh still has a watcher/timer if the
  // route that removed it forgot to clean up — close it here too, so this
  // function stays a true "watchers now match the live doc set" sync point
  // even if a future call site skips the per-route cleanup.
  for (const watchedId of [...sharedDocWatchers.keys()]) {
    if (!liveIds.has(watchedId)) closeSharedDocWatcher(watchedId);
  }
  for (const doc of docs) {
    const existing = sharedDocWatchers.get(doc.id);
    if (existing && existing.filePath === doc.filePath) continue;
    // Either no watcher yet, or the doc's filePath changed since the watcher
    // was created — close the stale one (if any) and re-target on the current path.
    if (existing) closeSharedDocWatcher(doc.id);
    if (!doc.filePath) continue;
    try {
      const watcher = fs.watch(doc.filePath, (eventType) => {
        if (eventType === 'change') {
          if (docDebounceTimers.has(doc.id)) clearTimeout(docDebounceTimers.get(doc.id));
          docDebounceTimers.set(doc.id, setTimeout(() => {
            // Who is told is derived from the recorded revision, so a write that
            // cannot be recorded notifies nobody: there is no broadcast to fall
            // back to.
            sharedDocRecord.observe(doc.id, { source: 'watch' })
              .catch((err) => log.warn('Shared doc revision not recorded: nobody was notified', { docId: doc.id, source: 'watch', error: err.message }));
          }, SHARED_DOC_DEBOUNCE_MS));
        }
      });
      sharedDocWatchers.set(doc.id, { watcher, filePath: doc.filePath });
    } catch (e) {
      log.warn('Failed to watch shared doc', { path: doc.filePath, error: e.message });
    }
  }
}
// ---------------------------

const system = require('./lib/system');
const systemHealth = require('./lib/system-health');
const ptyActivity = require('./lib/pty-activity');
const engines = require('./lib/engines');
const tmux = require('./lib/tmux');
const projects = require('./lib/projects');
const sessions = require('./lib/sessions');
const launchSequence = require('./lib/launch-sequence');
const launchRecoveryClear = require('./lib/launch-recovery-clear');
const recoveryDefault = require('./lib/recovery-default');
const master = require('./lib/master');
const sharedDocsAccess = require('./lib/shared-docs-access');
const sharedDocRecord = require('./lib/shared-docs');
const launchBindingGuard = require('./lib/launch-binding-guard');
const coordinatorRotation = require('./lib/coordinator-rotation');
const bridgeApi = require('./lib/bridge-api');
const bridgeGateway = require('./lib/bridge-gateway');
const bridgeNotify = require('./lib/bridge-notify');
// The one live fleet activity observer (#1912, ADR 0020 §5): started with the
// other monitors, read by the fleet surfaces, never captured from on a request.
const activityObserver = require('./lib/activity-observer').createObserver();
const startupPrompt = require('./lib/startup-prompt');
const startupControl = require('./lib/startup-control');
const projectView = require('./lib/project-view');
const actions = require('./lib/actions');
const porthub = require('./lib/porthub');
const uploads = require('./lib/uploads');
const continuity = require('./lib/continuity');
const portScanner = require('./lib/port-scanner');
const modelStatus = require('./lib/model-status');
const updateChecker = require('./lib/update-checker');
const updateApplier = require('./lib/update-applier');
const serverInfo = require('./lib/server-info');
const behindOrigin = require('./lib/behind-origin');
const checkoutState = require('./lib/checkout-state');
const checkoutFreshness = require('./lib/checkout-freshness');
const checkoutFleet = require('./lib/checkout-fleet');
const launchIsolationInventory = require('./lib/launch-isolation-inventory');
const bindPolicy = require('./lib/bind-policy');
const wrapRunRegistry = require('./lib/wrap-run-registry');
const evalAudit = require('./lib/eval-audit');
const pidfile = require('./lib/pidfile');
const sidecar = require('./lib/sidecar');
const openclawHtml = require('./lib/openclaw-html');
const tunnelMonitor = require('./lib/tunnel-monitor');
const net = require('node:net');
const httpsSetup = require('./lib/https-setup');
const hostInventory = require('./lib/host-inventory');
const caddy = require('./lib/caddy');
const caddyDrift = require('./lib/caddy-drift');
const setupCredential = require('./lib/setup-credential');
const adminCredential = require('./lib/admin-credential');
const ttydWatcher = require('./lib/ttyd-watcher');
const ttydAttach = require('./lib/ttyd-attach');
const ttydBind = require('./lib/ttyd-bind');
const engineErrorMonitor = require('./lib/engine-error-monitor');
const medusaWake = require('./lib/medusa-wake');
const deliveryDisposition = require('./lib/medusa-delivery-disposition');
const launchUnready = require('./lib/launch-unready');
const workloadNudge = require('./lib/workload-nudge');
const checkWatch = require('./lib/check-watch');
const authIdentity = require('./lib/auth-identity');
const authSession = require('./lib/auth-session');
const authGate = require('./lib/auth-gate');
const gateFallback = require('./lib/gate-fallback');
const ingressDoor = require('./lib/ingress-door');
const recoveryCodes = require('./lib/recovery-codes');
const openInstallToken = require('./lib/open-install-token');
const passwordHashing = require('./lib/password');
const sessionOwnership = require('./lib/session-ownership');
const planDocs = require('./lib/plan-docs');
const scorecardCache = require('./lib/scorecard-cache');
const strandedWraps = require('./lib/stranded-wraps');
const strandedCheck = require('./lib/stranded-check');
const serviceToken = require('./lib/service-token');
const medusa = require('./lib/medusa');
const controlState = require('./lib/control-state');
const controlApi = require('./lib/control-api');
const controlGate = require('./lib/control-gate');
const mergeQueueApi = require('./lib/merge-queue-api');
const { resolveControlCaller, isOperatorShaped } = require('./lib/control-auth');
const medusaExchanges = require('./lib/medusa-exchanges');
const medusaWatchdog = require('./lib/medusa-watchdog');
const medusaSend = require('./lib/medusa-send');
const launchAgentScan = require('./lib/launchagent-scan');

const log = createLogger('server');

// The body-size constants, the route table and the response, body and query
// helpers live in the kernel every route module shares (#2248).
const { route, matchRoute, _routePatterns, jsonResponse, errorResponse, parseBody, reqUrl, parseQuery, MAX_BODY_SIZE, MESSAGE_BODY_LIMIT_BYTES } = require('./lib/routes/_kernel');

// The caller-identity helpers several families share (the project a verified
// launch acts for, the operator proofs) live in their own module. The proofs
// still call three gate helpers defined further down this file, so they are
// bound once here; function declarations hoist, so the three are already
// defined when this line runs.
const callers = require('./lib/routes/_callers');
callers._bind({ _gateIdentity, _isSameOriginClear, _refuseDuringFallback });
const { _callerProjectId, _operatorProofOf, _requireOperatorWrite, coordinatorGateRefused } = callers;

// The OpenClaw connection, tunnel and approval routes live in their own module
// with the proxy helpers the request and upgrade dispatchers below still call;
// the two header builders stay on this file's export surface under their names.
const openclawRoutes = require('./lib/routes/openclaw');
const { resolveOpenclawPort, resolveOpenclawPortDirect, _stripFrameBlockers, _openclawProxyHeaders, _openclawWsRequestLines, proxyToOpenclaw } = openclawRoutes;

// The setup wizard's routes live in their own module with the two test seams
// (the restart scheduler and the ingress-cutover spawner) only that family
// reads; the seam setters stay on this file's export surface under their names.
const setupRoutes = require('./lib/routes/setup');
const { _setRestartScheduler, _setCutoverSpawner } = setupRoutes;

// The global config routes live in their own module; boot reads the fixed
// prior-use answer through it, and its test seam stays on this file's export
// surface under its name.
const configRoutes = require('./lib/routes/config');
const { _installPriorUse, _setInstallPriorUse } = configRoutes;

// The tc routes live in their own module; the request dispatcher reads the
// admission fields for its log line and records the awareness receipt through
// it, and the operator bridge's lane reader takes the lane composition from it.
const tcRoutes = require('./lib/routes/tc');
const { _admittedAs, recordTcAwareness, _composedLane } = tcRoutes;

// Methods that can change server state, and so must not be accepted from a page
// on another site. GET/HEAD are excluded because they are the ones a browser
// issues while merely navigating; any route that mutates behind a GET is a bug
// in that route, not something to paper over here.
const CSRF_UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Load config, or `null` if it cannot be read. Both Host-guard callers fail
 * closed on `null` rather than letting a corrupt config throw out of a request.
 * @returns {object|null}
 */
function _loadConfigOrNull() {
  try { return store.config.load(); } catch { return null; }
}

let _gateConfigCache = null;

/**
 * Config for the auth gate, cached on the config file's mtime and size.
 *
 * `store.config.load()` is an `existsSync` + `readFileSync` + `JSON.parse` with
 * no cache of its own. The gate asks for config on **every request of a gated
 * install** — every static asset, every dashboard poll — so an uncached read
 * puts synchronous disk I/O and a JSON parse on the event loop of the server
 * this chunk moved to async scrypt specifically to keep responsive.
 *
 * Keyed on `mtimeMs` + `size` rather than on a TTL, which is what preserves the
 * property the un-cached version was written for: an operator locked out by a
 * misconfigured gate recovers by setting `authEnabled: false`, and that edit
 * changes both, so it takes effect on the very next request. A `stat` is one
 * syscall against a read-plus-parse. Same construction as `_servedHostsCache`
 * a few lines below, which exists because an uncached per-request read of this
 * kind was already a problem here once.
 *
 * **THIS THUNK THROWS, and that is the contract.** `_loadConfigOrNull` turns
 * every failure into `null`, which is the right answer for the Host guard and
 * the wrong one here: `authGate.resolveGateState` answers a READ FAILURE with
 * `unreadable`, which enforces, and a successful read of nothing with `open`.
 * Routing the gate through the null-swallowing loader would make the enforcing
 * branch unreachable — a corrupt `config.json` would read as "not enforcing",
 * cached on mtime+size and re-served, which is an authentication bypass for as
 * long as the file stays unreadable.
 *
 * A failed `stat` throws too, including ENOENT — so a MISSING `config.json`
 * enforces as well. `store.config.load()`'s answer there is `DEFAULT_CONFIG`,
 * whose `authEnabled` is false: honouring it would mean deleting one file
 * silently un-gates the install, which is the same bypass reached by a
 * different route. `store.init()` writes the file at boot, so no running install
 * is without one, and `authEnabled: false` in a file that IS readable remains
 * the recovery lever — outside caddy mode's ungated-remote-Caddyfile case, which
 * `_gateIngress` and `authGate.resolveGateState` own.
 *
 * Nothing is cached on the failure path, so recovery takes effect on the next
 * request rather than being pinned by a cached verdict.
 *
 * @returns {object} The loaded config
 * @throws {Error} If the config file cannot be read or parsed
 */
function _gateConfig() {
  const st = fs.statSync(store._getConfigPath());
  const key = `${st.mtimeMs}:${st.size}`;
  if (_gateConfigCache && _gateConfigCache.key === key) return _gateConfigCache.value;
  const value = store.config.load();
  _gateConfigCache = { key, value };
  return value;
}

let _gateIngressCache = null;
let _gateIngressLogged = null;

/**
 * How long an answer Caddy could not give ("unread") is reused before
 * `caddy adapt` is asked again. Every other answer lasts until the file changes.
 */
const GATE_INGRESS_UNREAD_RETRY_MS = 30000;

/**
 * The Caddyfile on disk, described as a door, for the auth gate — cached on the
 * file's mtime and size like {@link _gateConfig}.
 *
 * Asked only in caddy mode with `authEnabled` off
 * (`authGate.resolveGateState`): the opt-out opens the install only while this
 * says the file is not a door — what counts as one is `lib/ingress-door.js`'s
 * to say. An edit to the file changes the key, so it takes effect on the next
 * request.
 *
 * A file MISSING at the `stat` answers "no door" — Caddy has nothing to serve.
 * Any OTHER failure throws, which the gate answers with `unreadable` — including
 * a file that was there for the `stat` and gone for the read. That one must not
 * be answered as "missing": the answer would be cached under the key of the file
 * that was just `stat`ed.
 *
 * The description runs `caddy adapt` over the text, synchronously, once per
 * change of the file. The same trade `_gateFallback` makes: an asynchronous
 * check needs a "not yet known" answer, which must count as a door anyway, so
 * the opt-out would stay closed until it landed. Bounded by `caddy-drift`'s
 * adapt timeout. When Caddy cannot read the file the answer is a door; that one
 * is re-asked every {@link GATE_INGRESS_UNREAD_RETRY_MS}, so a passing timeout or
 * a `caddy` briefly missing from PATH does not keep the login on until someone
 * edits the Caddyfile. Each distinct answer is logged once, not per request.
 *
 * @returns {{ ungatedRemoteSite: boolean, unguardedLocalSite: boolean }}
 * @throws {Error} If the Caddyfile exists but cannot be read
 */
function _gateIngress() {
  const file = caddy.getCaddyfilePath();
  let st;
  try {
    st = fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return ingressDoor.describeIngressContent(null);
    throw err;
  }
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  const now = Date.now();
  if (_gateIngressCache && _gateIngressCache.key === key
      && (_gateIngressCache.value.source !== 'unread' || now < _gateIngressCache.retryAt)) {
    return _gateIngressCache.value;
  }
  const value = ingressDoor.describeIngressContent(fs.readFileSync(file, 'utf8'));
  _gateIngressCache = { key, value, retryAt: now + GATE_INGRESS_UNREAD_RETRY_MS };
  const logged = `${key}|${value.source}|${value.reason}|${value.ungatedRemoteSite}|${value.unguardedLocalSite}`;
  if (_gateIngressLogged === logged) return value;
  _gateIngressLogged = logged;
  if (value.source === 'unread') {
    log.warn('caddy adapt could not read the Caddyfile, so authEnabled: false does NOT open TangleClaw\'s login '
      + 'in caddy mode. Make caddy reachable on TangleClaw\'s PATH, or turn authEnabled back on.',
    { caddyfile: file, reason: value.reason });
  } else if (value.source === 'import') {
    log.warn('The Caddyfile imports another file, whose edits the gate would not notice, so authEnabled: false '
      + 'does NOT open TangleClaw\'s login in caddy mode. Inline the import, or turn authEnabled back on.',
    { caddyfile: file, reason: value.reason });
  } else if (value.ungatedRemoteSite) {
    log.warn('The Caddyfile serves a remote site that forwards a request before any basic_auth, so '
      + 'authEnabled: false does NOT open TangleClaw\'s login in caddy mode. Re-run the cutover with only a '
      + 'localhost site, or turn authEnabled back on.', { caddyfile: file });
  } else if (value.unguardedLocalSite) {
    // Whether it closes the opt-out depends on whether accounts exist, which the
    // gate decides per request.
    log.warn('The Caddyfile has a localhost site with no basic_auth and no peer guard, so other machines '
      + 'asking for localhost reach it. On an install with accounts, authEnabled: false does NOT open '
      + 'TangleClaw\'s login. Run node scripts/guard-ungated-sites.js.', { caddyfile: file });
  }
  return value;
}

/**
 * Gather the facts `lib/setup-credential.js` decides from, for one config.
 *
 * The single place the three consumers — `GET /api/setup/ingress-state`,
 * `POST /api/setup/complete` and the Skip path of `PATCH /api/config` — turn a
 * config into those facts, so a fact added later reaches all three. The one
 * input that differs between them is passed, named: whether the calling route
 * supplies a login by adopting a Caddy config.
 *
 * The Caddyfile is described only in caddy mode, where Caddy is the front door.
 * A description that throws is passed as `null`, which the decision reads as a
 * door it cannot see and refuses the choice of no login for.
 *
 * @param {object} config - Config as it will be saved, with any credential this
 *   request supplies already applied.
 * @param {{ adoptionSupplies: boolean, optOut: boolean }} route - What the
 *   calling route contributes: whether it adopts a Caddy login, and whether the
 *   request carries the choice of no login.
 * @returns {ReturnType<typeof setupCredential.decideCredential>}
 */
function _decideSetupCredential(config, route) {
  const inCaddyMode = config.ingressMode === 'caddy';
  let door = null;
  let caddyLoginInForce = false;
  if (inCaddyMode) {
    try {
      door = _gateIngress();
    } catch (err) {
      log.warn('Setup could not read the Caddyfile, so the choice of no login is not offered',
        { error: err.message });
    }
    const classified = caddy.classifyIngressState();
    if (classified.state === 'unreadable') {
      // Not knowing is its own answer, not "a login is in force": that would tell
      // the operator a login already asks, beside the form asking them for one.
      // A door that cannot be read withholds the choice of no login just the same
      // (`DOOR_UNREAD`), and says why truthfully.
      door = null;
    } else {
      caddyLoginInForce = classified.users.length > 0;
    }
  }
  return setupCredential.decideCredential({
    loginInHand: config.authEnabled === true,
    adoptionSupplies: route.adoptionSupplies === true,
    caddyLoginInForce,
    bindWide: bindPolicy.describeBindState(config).wide,
    ingressMode: config.ingressMode || null,
    door,
    optOut: route.optOut === true
  });
}

let _gateFallbackCache = null;
let _gateFallbackReadFailure = null;

/**
 * Whether the operator's fallback marker is honoured for a connection on this
 * socket's listener — `lib/gate-fallback.js#decideFallback` over facts gathered
 * here, for `authGate.resolveGateState`.
 *
 * The marker is `stat`ed on every call, which is the only per-request cost: the
 * gate asks this only while its state would enforce, and with no marker the
 * answer is immediate. The rest — the listener, the config's ingress mode, the
 * Caddyfile's text and `caddy adapt` over it — is cached on everything it reads
 * (the marker's mtime, the listener address and port, the ingress mode, the
 * Caddyfile's mtime and size), so an edit to any of them is weighed on the next
 * request. A Caddyfile that imports another file is refused by the decision
 * itself, because an edit there would change none of those.
 *
 * `caddy adapt` runs synchronously, once per change of those facts and only
 * while a marker exists. A deliberate trade: an asynchronous check needs a
 * "not yet known" answer, which must enforce, so the operator recovering a broken
 * login would meet the login they are recovering from until it lands. One
 * subprocess on a recovery path is cheaper than that, and it is bounded by
 * `caddy-drift`'s adapt timeout.
 *
 * The listener is read from the server that is bound, not from config: what
 * decides who can reach TangleClaw is the address actually bound.
 *
 * A marker or Caddyfile that exists but cannot be `stat`ed or read answers "not
 * honoured" — logged once per distinct failure, not per request — and the end of
 * an honoured fallback is logged when its marker goes, so the log shows both
 * edges of a stand-down.
 *
 * @param {net.Server|null|undefined} server - The listener the question is
 *   asked of: a request's own, or the bound server when no request exists.
 * @returns {{ honoured: boolean, reason: string|null }}
 */
function _gateFallbackForListener(server) {
  const refuseOnce = (what, err) => {
    const failure = `${what}:${err.code || err.message}`;
    if (_gateFallbackReadFailure !== failure) {
      _gateFallbackReadFailure = failure;
      log.error(`Fallback check could not read the ${what}, so the login still enforces`, { error: err.message });
    }
    return { honoured: false, reason: `the ${what} could not be read (${err.code || err.message})` };
  };
  let markerStat;
  try {
    markerStat = fs.statSync(gateFallback.markerPath());
  } catch (err) {
    if (err.code !== 'ENOENT') return refuseOnce('fallback marker', err);
    if (_gateFallbackCache && _gateFallbackCache.value.honoured) {
      log.warn('Fallback marker removed: TangleClaw\'s login enforces again.');
    }
    _gateFallbackCache = null;
    _gateFallbackReadFailure = null;
    return { honoured: false, reason: null };
  }
  const bound = server && typeof server.address === 'function' ? server.address() : null;
  const listenerAddress = bound && typeof bound === 'object' ? bound.address : null;
  const upstreamPort = bound && typeof bound === 'object' ? bound.port : null;
  let ingressMode = null;
  try {
    ingressMode = _gateConfig().ingressMode || null;
  } catch (err) { // prawduct:allow prawduct/broad-except -- an unreadable config is a fact decideFallback weighs (null refuses a Caddyfile-less fallback); resolveGateState already logs the read failure
    ingressMode = null;
  }
  const caddyfile = caddy.getCaddyfilePath();
  let caddyStat = null;
  try {
    caddyStat = fs.statSync(caddyfile);
  } catch (err) {
    if (err.code !== 'ENOENT') return refuseOnce('Caddyfile', err);
  }
  const key = [
    markerStat.mtimeMs, listenerAddress, upstreamPort, ingressMode,
    caddyStat ? `${caddyStat.mtimeMs}:${caddyStat.size}` : 'absent'
  ].join('|');
  if (_gateFallbackCache && _gateFallbackCache.key === key) return _gateFallbackCache.value;
  let caddyfileContent = null;
  if (caddyStat) {
    try {
      caddyfileContent = fs.readFileSync(caddyfile, 'utf8');
    } catch (err) {
      return refuseOnce('Caddyfile', err);
    }
  }
  _gateFallbackReadFailure = null;
  const value = gateFallback.decideFallback({
    markerPresent: true,
    listenerAddress,
    upstreamPort,
    caddyfileExists: caddyStat !== null,
    caddyfileContent,
    adapted: caddyStat ? caddyDrift.adaptCaddyfile(caddyfile) : null,
    ingressMode
  });
  // Once per change of the facts, not per request.
  if (value.honoured) {
    log.warn('Fallback marker honoured: TangleClaw\'s login is STOOD DOWN behind Caddy\'s gate. '
      + 'Run node scripts/gate-fallback.js --undo once the login works again.', { marker: gateFallback.markerPath() });
  } else {
    log.error('Fallback marker present but NOT honoured, so the login still enforces',
      { reason: value.reason, marker: gateFallback.markerPath() });
  }
  _gateFallbackCache = { key, value };
  return value;
}

/**
 * {@link _gateFallbackForListener} for a request, asked of the listener that
 * request arrived on.
 * @param {net.Socket|null|undefined} socket - The request's socket.
 * @returns {{ honoured: boolean, reason: string|null }}
 */
function _gateFallback(socket) {
  return _gateFallbackForListener(socket && socket.server);
}

/**
 * The login gate's state as a request on `server` would find it, for a caller
 * that has no request: a launch deciding whether advisory recovery is the
 * default (`lib/recovery-default.js`).
 *
 * The same four inputs `handleRequest` passes, with the fallback asked of the
 * bound listener itself. A launch is not always inside a request, and a
 * request's socket would say nothing a launch can rely on once it is gone.
 * @param {net.Server} server - The bound listener
 * @returns {() => string} A probe returning a member of `authGate.GATE_STATES`
 */
function _recoveryGateProbeFor(server) {
  return () => authGate.resolveGateState(_gateConfig, store.authSessions, _gateIngress,
    () => _gateFallbackForListener(server));
}

let _servedHostsCache = null;

/**
 * The served-name allowlist, or an empty set if it cannot be computed.
 *
 * **Cached, because computing it reads and X.509-parses the certificate.** This
 * runs on every guarded write and every WebSocket upgrade, and an uncached
 * version did a synchronous file read plus a certificate parse per request —
 * and, on an install with no certificate yet, emitted a warning about
 * regeneration on each one, loudest during the setup wizard, about an operation
 * the request path is not performing. Caching removes the per-request cost and
 * reduces that warning to once per change of state, which is what it was
 * written to report.
 *
 * The key is every input the answer depends on: the two configured names, the
 * machine's hostname, and the certificate's own mtime and size.
 *
 * The certificate term is the load-bearing one. `POST /api/setup/generate-cert`
 * accepts a host list that lands in no config field, so the cert is those names'
 * only record — key on the config alone and a freshly added SAN never enters the
 * allowlist for the life of the process, producing exactly the "loads over a
 * valid certificate, serves reads, refuses every write, kills every terminal
 * upgrade" failure this list exists to prevent. A test rewrites the cert between
 * two guarded requests to hold that.
 *
 * `os.hostname()` is in the key because both `certHostUnion` and
 * `servedHostAllowlist` derive names from it; without it a machine renamed
 * mid-run keeps answering to its old `.local` name until something else moves.
 *
 * The observed overlay name is in the key for the same reason (#1905): with no
 * `caddyTailnetHost` configured it is the tailnet name the list carries, and
 * certificate generation refreshes it.
 *
 * An unreadable or malformed cert must not take a request down with it, so
 * failure yields an empty set: names all refused, while an IP-literal `Host`
 * still passes inside `_hostIsAllowed` on reasoning that does not consult this
 * list at all.
 *
 * @param {object} config - Loaded config.
 * @returns {Set<string>}
 */
function _servedHostsOrEmpty(config) {
  let certStamp = 'none';
  try {
    const st = fs.statSync(path.join(httpsSetup.getCertsDir(), 'cert.pem'));
    certStamp = `${st.mtimeMs}:${st.size}`;
  } catch { /* no cert yet — a real state, and a stable cache key for it */ }

  const key = `${config.publicDomain || ''}|${config.caddyTailnetHost || ''}`
    + `|${hostInventory.observeOverlayDns().host || ''}|${os.hostname()}|${certStamp}`;
  if (_servedHostsCache && _servedHostsCache.key === key) return _servedHostsCache.value;

  let value;
  try {
    value = httpsSetup.servedHostAllowlist(config);
  } catch (err) {
    log.warn('Could not compute the served-host allowlist; refusing named hosts', {
      error: err.message
    });
    value = new Set();
  }
  _servedHostsCache = { key, value };
  return value;
}

/**
 * Is this a first-run setup request the Host allowlist genuinely cannot cover?
 *
 * Setup is what *configures* `publicDomain` / `caddyTailnetHost`, so on an
 * install a remote operator can actually reach, first run is the one moment the
 * allowlist cannot contain the address they arrived by — the `Host` header is
 * how the install learns it, and the wizard names that address back so the
 * operator knows where the gate will appear.
 *
 * **Bounded on three axes, and the third is the one that matters.** An earlier
 * version stopped at "a setup route, before `setupComplete`", reasoning that a
 * fresh install is unprotected anyway. That reasoning was wrong: the default
 * config is `bindAllInterfaces: false` with `ingressMode: 'direct'`, so the
 * default install binds loopback only and **no remote operator can reach the
 * wizard at all**. On that population the exemption protected no real flow, and
 * the only request that could arrive at a setup route under an unserved `Host`
 * was the rebound one — handing back exactly the attack this guard closes, on
 * the route that sets the admin credential.
 *
 * So the carve-out applies only where the flow it exists for is possible: the
 * socket is actually wide. A loopback-only install gets no exemption, because it
 * has no remote first run to protect — and neither does caddy mode, which reads
 * like a second qualifier and is not (see the reasoning at the return below).
 *
 * @param {string} pathname - Request path.
 * @param {object|null} config - Loaded config, or `null` when it could not be
 *   read. `null` denies the exemption — it is never re-read here, because the
 *   caller loads it once and shares it with the allowlist check.
 * @returns {boolean}
 */
function _setupRouteNeedingHostExemption(pathname, config) {
  // `/api/config` is here because the wizard has TWO terminators: Finish posts
  // `/api/setup/complete`, and Skip sends `PATCH /api/config { setupComplete:
  // true }` (ADR 0009 point 2). Guarding one and not the other is the
  // half-swept-family defect this repo keeps re-learning — remote Skip would
  // 403 while remote Finish worked.
  //
  // Including a general settings route looks wide until you note WHERE this can
  // apply: an install that is pre-setup and remotely reachable has no credential
  // and no gate, so anyone who can reach it can already PATCH config directly.
  // Rebinding buys an attacker nothing there that direct access does not. That
  // is precisely why the three-axis form is safe and the two-axis one was not.
  const isSetupSurface = pathname.startsWith('/api/setup/') || pathname === '/api/config';
  if (!isSetupSurface) return false;
  // A config that could not be read is not a reason to open the carve-out.
  if (!config || config.setupComplete !== false) return false;
  // Is this socket reachable from another machine at all? If not, there is no
  // remote first run, and the only request that can arrive here under an
  // unserved Host is the rebound one.
  //
  // Caddy mode is deliberately NOT a second way to qualify, though it looks like
  // one. `bindPolicy` refuses the wide opt-in in caddy mode, so the listener is
  // loopback-only there too — Caddy holds the gate in front of it. A remote
  // operator therefore reaches the wizard THROUGH Caddy, under the site name
  // Caddy serves, which this allowlist already contains; while a rebound page
  // reaches 127.0.0.1 directly, without traversing Caddy at all. Adding caddy
  // mode would have exempted only the attack — the same defect as keying on
  // `setupComplete` alone, in the other arm.
  return bindPolicy.describeBindState(config).wide === true;
}

/**
 * Is `Host` a name this install actually serves?
 *
 * The cross-site guards ask the request to vouch for itself: `Sec-Fetch-Site`
 * is what the browser computed from the page's own origin, and the upgrade
 * guard compares `Origin` to the request's own `Host`. Both are satisfied by an
 * attacker who controls DNS — `evil.example` pointed at `127.0.0.1` is
 * `same-origin` as far as the browser knows, and reaches the ungated loopback
 * listener. This is the independent check (#864).
 *
 * Parsed via `URL`, never split on `':'`: a bracketed IPv6 `Host`
 * (`[fd7a:115c::1]:3102`) splits into `'['`, and Tailscale gives every node an
 * `fd7a:115c::/48` address, so splitting would refuse a normal way to reach
 * this product. Same reasoning as `_isSameOriginUpgrade`.
 *
 * A missing `Host` is refused: HTTP/1.1 requires it, and the callers only
 * consult this for state-changing requests and upgrades.
 *
 * @param {string|undefined} host - The `Host` header.
 * @param {Set<string>} [allowlist] - Override (tests); defaults to the live config.
 * @returns {boolean}
 */
function _hostIsAllowed(host, allowlist) {
  if (!host) return false;
  let name;
  try {
    name = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  // `URL` keeps IPv6 literals bracketed; unwrap before testing either branch.
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1);
  // A fully qualified `host.tailnet.ts.net.` names the same host as the
  // undotted form the allowlist stores (#1905).
  name = name.replace(/\.+$/, '');

  // An IP literal is always allowed, and this is the whole shape of the attack.
  // Rebinding needs a NAME: the trick is to make a name the browser already
  // trusts resolve somewhere else, and `Host` then carries that name. There is
  // no DNS step for a literal — a request that reaches us same-origin as
  // `192.168.1.50` or `[fd7a:115c::1]` means the browser really is talking to
  // that address. A page hosted at a DIFFERENT address posting here yields
  // `Origin` ≠ `Host`, which the two guards above already refuse.
  //
  // This also keeps the allowlist free of the machine's own interface
  // addresses, which would otherwise have to be enumerated and would change
  // with the network — a Tailscale node's `fd7a:115c::/48` address is a normal
  // way to reach this product and appears in no config field.
  if (net.isIP(name)) return true;

  const allowed = allowlist || httpsSetup.servedHostAllowlist(store.config.load());
  return allowed.has(name);
}
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

let PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * Test-only override of `PUBLIC_DIR` — the route-level #1368 degradation
 * tests need a real server to serve a BROKEN `public/` without touching the
 * repo's own, which every other test file's server shares.
 * @param {string|null} dir - Pass `null` to restore the real `public/`.
 */
function _setPublicDir(dir) {
  PUBLIC_DIR = dir || path.join(__dirname, 'public');
}

/**
 * Whether the static UI assets this install serves are present on disk
 * (#1368). A missing `public/index.html` means the install directory was
 * moved or renamed while the server kept running on the old path — every
 * UI route then 404s though the API stays up.
 * @param {string} [publicDir=PUBLIC_DIR]
 * @returns {boolean}
 */
function _checkPublicAssets(publicDir = PUBLIC_DIR) {
  const indexPath = path.join(publicDir, 'index.html');
  try {
    if (!fs.statSync(publicDir).isDirectory()) return false;
    if (!fs.statSync(indexPath).isFile()) return false;
    fs.accessSync(indexPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the durable HOLD/STOP gate (#1861) immediately before a governed
 * mutation, and answer its refusal if there is one.
 * @param {http.ServerResponse} res
 * @param {{surface: string, subject: object}} args - For `control-gate#checkMutation`
 * @returns {boolean} True when the request was refused and answered
 */
function controlRefused(res, args) {
  const refusal = controlGate.checkMutation(args);
  if (!refusal) return false;
  errorResponse(res, refusal.status, refusal.message, refusal.code, refusal.details);
  return true;
}

/**
 * The job subject for a project named in a route, with no admitted assignment
 * yet: the project's current assignment decides.
 * @param {string} projectName - Project name from the path
 * @returns {object|null} The subject, or null when the project does not exist
 */
function controlJobSubject(projectName) {
  const project = store.projects.getByName(projectName);
  return project ? { kind: 'job', projectId: project.id, assignmentId: null } : null;
}

// ── Static File Serving ──

/**
 * Serve a static file from the public directory.
 * @param {http.ServerResponse} res
 * @param {string} pathname - URL path
 * @returns {boolean} - Whether a file was served
 */
function serveStatic(res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname);

  // Prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    errorResponse(res, 403, 'Forbidden', 'FORBIDDEN');
    return true;
  }

  // Default to index.html
  if (pathname === '/' || pathname === '') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(filePath);

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': content.length,
    'Cache-Control': 'no-cache'
  });
  res.end(content);
  return true;
}

// The login document, read once. Memoised because it is served on the refusal
// path of every unauthenticated request — a brute-force attempt would otherwise
// be a synchronous disk read per attempt on the event loop.
//
// Memoising a file this server also ships means an edit needs a restart to take
// effect. That is the same contract every other module in this process has
// (nothing here is hot-reloaded) and it is the safer half of the trade: the
// alternative re-reads a file on the one path an attacker controls the rate of.
const _authPageHtml = new Map();

// What a signed-out person sees if a page file is missing from the install.
// Plain and self-contained for the reason argued at `_serveAuthPage`.
const _AUTH_PAGE_FALLBACKS = {
  'login.html': '<!DOCTYPE html><meta charset="utf-8"><title>Sign in</title>'
    + '<p>TangleClaw needs you to sign in, but its login page is missing from '
    + 'this install. Post a username and password to <code>/api/auth/login</code>, '
    + 'or run <code>node scripts/reset-admin.js --store --user &lt;name&gt;</code> '
    + 'at a terminal on this machine.</p>',
  'account-setup.html': '<!DOCTYPE html><meta charset="utf-8"><title>Create an account</title>'
    + '<p>TangleClaw needs an account before anyone can sign in, but its account '
    + 'page is missing from this install. Post a username and password to '
    + '<code>/api/auth/set-password</code>, or run '
    + '<code>node scripts/reset-admin.js --store --user &lt;name&gt;</code> '
    + 'at a terminal on this machine.</p>',
  'recover.html': '<!DOCTYPE html><meta charset="utf-8"><title>Use a recovery code</title>'
    + '<p>TangleClaw\'s recovery page is missing from this install. Post a recovery code '
    + 'and a new password to <code>/api/auth/recover</code>, or run '
    + '<code>node scripts/reset-admin.js --store --user &lt;name&gt;</code> '
    + 'at a terminal on this machine.</p>'
};

/**
 * Serve the login page.
 *
 * @param {http.ServerResponse} res
 * @param {number} status - 200 for a direct visit, 401 for a refusal
 * @returns {void}
 */
function _serveLoginPage(res, status) {
  _serveAuthPage(res, status, 'login.html');
}

/**
 * Serve one of the self-contained pages a signed-out person needs: the login
 * page, or the page that creates an install's first account.
 *
 * Falls back to a minimal inline document if the file cannot be read. That
 * fallback is not politeness: this is what a locked-out operator is looking at,
 * and answering a partial deployment with a stack trace or an empty 500 would
 * leave them with no way to tell "I typed the wrong address" from "the door is
 * broken".
 *
 * @param {http.ServerResponse} res
 * @param {number} status - 200 for a direct visit, 401 for a refusal
 * @param {'login.html'|'account-setup.html'|'recover.html'} file - The page under `public/`
 * @returns {void}
 */
function _serveAuthPage(res, status, file) {
  let body = _authPageHtml.get(file);
  if (body === undefined) {
    try {
      body = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
      // Memoised ONLY on success. Caching the fallback would freeze a transient
      // read failure — a half-finished self-update, a momentary EMFILE — into
      // the page for the rest of the process's life, and the operator would be
      // looking at the degraded document long after the file came back. The
      // failure path re-reads, which is the one path where the extra syscall is
      // worth more than the saving.
      _authPageHtml.set(file, body);
    } catch (err) {
      log.error('Auth page could not be read', { file, error: err.message });
      body = _AUTH_PAGE_FALLBACKS[file];
    }
  }
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Never cached, by any cache, at any layer. A login page held in a shared
    // cache is served to the next person to ask, and a login page held in the
    // browser's is served back to someone who has since signed in.
    'Cache-Control': 'no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    // Each page is entirely self-contained, so it can afford the tightest
    // policy this server writes: its own inline style and script, and nothing
    // else — no image, no font, no connect target beyond same-origin for its
    // POST, and no frame ancestor, so it cannot be framed for clickjacking.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; "
      + "script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; "
      + "base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(body);
}

/**
 * Send a complete HTML document.
 * @param {http.ServerResponse} res
 * @param {number} status - HTTP status code
 * @param {string} html - The document
 */
function htmlResponse(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    // The page is session-authored content rendered escape-first; the CSP is
    // the second wall behind that escaping. Inline style is the page's own
    // stylesheet; nothing else may load or run.
    'Content-Security-Policy': PLAN_PAGE_CSP
  });
  res.end(html);
}

/** CSP for every plan-docs HTML response (the page and its refusal pages). */
const PLAN_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:";

/**
 * Serve `/plans/:projectId/:file` — a project's plan rendered as a page (#542).
 *
 * Every refusal is a plain HTML page, because a browser is what lands here:
 * 404 for an unknown project, an absent plan, or one moved to `archive/`
 * (named as such — that is where a shipped plan's link goes), 400 for a name
 * that is not a plan name. The name must be a bare `.md` basename and must
 * resolve by real path to a file directly inside the plans directory
 * (`lib/plan-docs.js#resolvePlanFile`), so `..`, encoded separators and
 * symlinks pointing elsewhere are all refused before any read happens.
 * @param {http.ServerResponse} res
 * @param {string} pathname - Request path, still percent-encoded
 */
function servePlanPage(res, pathname) {
  const parts = pathname.split('/'); // ['', 'plans', projectId, file]
  if (parts.length !== 4 || !parts[2] || !parts[3]) {
    return htmlResponse(res, 404, planDocs.renderMessagePage({
      title: 'Not found',
      message: 'A plan is addressed as /plans/<projectId>/<file>.md.'
    }));
  }
  let file;
  try {
    file = decodeURIComponent(parts[3]);
  } catch {
    file = null;
  }
  if (file === null || !planDocs.isValidPlanFileName(file)) {
    log.warn('Refused plan request with an invalid plan name', { path: pathname });
    return htmlResponse(res, 400, planDocs.renderMessagePage({
      title: 'Invalid plan name',
      message: 'A plan is named by its file name alone — letters, digits, dots, hyphens and underscores, ending in .md. Directories and path separators are not accepted.'
    }));
  }
  // Decimal digits only — the same rule as `_projectByIdOrName`. `Number()`
  // alone accepts `0x1`, `1e0` and ` 1`, so one project answered under
  // several spellings of its id.
  const pid = /^\d+$/.test(parts[2]) ? Number(parts[2]) : NaN;
  const project = Number.isInteger(pid) ? store.projects.get(pid) : null;
  if (!project) {
    return htmlResponse(res, 404, planDocs.renderMessagePage({
      title: 'Project not found',
      message: `No project has the id ${parts[2]}. Project ids are numeric — see GET /api/projects.`
    }));
  }
  const resolved = planDocs.resolvePlanFile(project.path, file);
  if (resolved.status === 'archived') {
    return htmlResponse(res, 404, planDocs.renderMessagePage({
      title: 'Plan archived',
      message: `${file} has been archived in ${project.name}: its work shipped and the plan was moved to the plans archive. It is no longer served.`
    }));
  }
  if (resolved.status !== 'ok') {
    return htmlResponse(res, 404, planDocs.renderMessagePage({
      title: 'Plan not found',
      message: `${project.name} has no plan named ${file} in ${planDocs.plansDirCandidates(project.path).map((c) => c.relative).join(' or ')}.`
    }));
  }
  let markdown;
  try {
    markdown = fs.readFileSync(resolved.path, 'utf8');
  } catch (err) {
    log.warn('Plan file resolved but could not be read', { path: resolved.path, error: err.message });
    return htmlResponse(res, 404, planDocs.renderMessagePage({
      title: 'Plan not readable',
      message: `${file} exists in ${project.name} but could not be read: ${err.message}`
    }));
  }
  htmlResponse(res, 200, planDocs.renderPlanPage({
    project: { id: project.id, name: project.name },
    file,
    relative: resolved.relative,
    modifiedAt: resolved.modifiedAt,
    markdown,
    scorecard: () => scorecardCache.readScorecardCache(scorecardCache.cachePath(store._getBasePath()))
  }));
}

/**
 * Log a page navigation at info. Static assets are logged at debug — on a
 * default install (`logLevel: info`) they never reach the log, and that is
 * right for a stylesheet. The documents are different: `GET /` is one half of
 * the pair the blank-dashboard runbook reads — `GET /` followed by `Dashboard
 * booted` means the shell ran, `GET /` alone means it did not (#817) — and the
 * session page is what the runbook names as the innocent explanation for a
 * `GET /` with no beacon. A pair whose first half is invisible by default is
 * not observable; this is the one line that makes it so.
 *
 * @param {string} method - HTTP method
 * @param {string} pathname - Request path as the browser sent it
 * @param {number} startTime - `Date.now()` at request start
 * @param {string} document - The file that answered it (e.g. `index.html`)
 */
function logNavigation(method, pathname, startTime, document) {
  log.info(`${method} ${pathname}`, { status: 200, duration: `${Date.now() - startTime}ms`, document });
}

// ── API Route Handlers ──

// GET /api/health
route('GET', '/api/health', (_req, res) => {
  const db = store.getDb();
  let dbStatus = 'unavailable';
  if (db) {
    try {
      db.prepare('SELECT 1').get();
      dbStatus = 'ok';
    } catch {
      dbStatus = 'unavailable';
    }
  }

  const assetsOk = _checkPublicAssets();

  // tmux check (synchronous)
  let tmuxStatus = 'unavailable';
  try {
    require('node:child_process').execSync('tmux list-sessions 2>/dev/null', { timeout: 2000 });
    tmuxStatus = 'ok';
  } catch {
    try {
      require('node:child_process').execSync('which tmux', { timeout: 1000 });
      tmuxStatus = 'ok';
    } catch {
      tmuxStatus = 'unavailable';
    }
  }

  // ttyd check — TCP connect to configured port
  const config = store.config.load();
  const net = require('node:net');
  const socket = new net.Socket();
  socket.setTimeout(500);

  return new Promise((resolve) => {
    const respond = (ttyd) => {
      const version = _getVersion();
      const allOk = dbStatus === 'ok' && ttyd === 'ok' && assetsOk;
      const status = dbStatus !== 'ok' ? 'degraded' : (allOk ? 'ok' : 'degraded');
      const httpStatus = dbStatus !== 'ok' ? 503 : 200;

      jsonResponse(res, httpStatus, {
        status,
        version,
        uptime: Math.floor(process.uptime()),
        services: {
          database: dbStatus,
          ttyd: ttyd,
          tmux: tmuxStatus,
          assets: assetsOk ? 'ok' : 'unavailable'
        }
      });
      resolve();
    };

    const ttydTarget = caddy.ttydConnectTarget(config);
    const onTtydUp = () => {
      socket.destroy();
      respond('ok');
    };
    if (ttydTarget.socketPath) {
      socket.connect(ttydTarget.socketPath, onTtydUp);
    } else {
      socket.connect(ttydTarget.port, ttydTarget.host, onTtydUp);
    }
    socket.on('error', () => {
      socket.destroy();
      respond('unavailable');
    });
    socket.on('timeout', () => {
      socket.destroy();
      respond('unavailable');
    });
  });
});

// GET /api/version
route('GET', '/api/version', (_req, res) => {
  jsonResponse(res, 200, { version: _getVersion() });
});

// GET /api/server-info — runtime-vs-disk diff (#199). Browser polls this
// (or fetches on page load) to surface a banner when the running process
// is older than the on-disk code. See `lib/server-info.js` docstring.
route('GET', '/api/server-info', (_req, res) => {
  const info = serverInfo.getServerInfo({ gateState: _req.tcGateState });
  const cfg = store.config.load();
  // "Logged in as <user>": the session's username, or null. The session is the
  // only source of identity (ADR 0016 OQ2) — an inbound `X-Auth-User` was
  // deleted at request entry.
  info.currentUser = (_req.tcSession && _req.tcSession.username) || null;
  // Whether a login is enforced, from the gate's own state for this request.
  // Surfacing only — never enforces. See docs/auth-status-surfacing.md.
  info.authStatus = authIdentity.resolveAuthStatus(_req.tcGateState);
  // A recovery code this account's password was reset with, not yet
  // acknowledged. Per account: only the signed-in account's own redemptions.
  info.recoveryNotice = _req.tcSession ? store.recoveryCodes.pendingNotice(_req.tcSession.userId) : null;
  // #227: is the local clone behind origin/main? Cached answer, never waits on
  // the network — a stale cache starts one background fetch for the next poll.
  // `enabled: false` when the operator turned the check off in config.
  info.behindOrigin = behindOrigin.snapshot(cfg);
  // #993: what the served checkout is actually on — branch, unpushed commits,
  // uncommitted and untracked files. Cached; the route never runs git itself.
  // The origin/main ref is only as fresh as behind-origin's last successful
  // fetch, and the payload says which.
  info.liveCheckout = checkoutState.withUpstreamObservation(
    checkoutState.snapshot(serverInfo.getRepoRoot()), info.behindOrigin);
  // #1223: whether the Pull button should render — provably safe (on main,
  // strictly behind, clean tree) from this same poll's liveCheckout.
  info.behindOrigin.canFastForwardPull = behindOrigin.canFastForwardPull(info.liveCheckout, info.behindOrigin);
  // #1949: which checkout this server runs from, as a digest of its real path,
  // so release certification can prove the server is the worktree it certifies.
  info.checkoutId = serverInfo.getCheckoutId();
  // #1678: whether a restart would load anything, for the commits the running
  // process has not loaded. Only asked when disk is known or suspected ahead.
  info.restartImpact = info.isStale === true
    ? checkoutState.impactSnapshot(serverInfo.getRepoRoot(), info.startupSha, info.currentDiskSha)
    : null;
  // #1839: Medusa exchanges waiting on the operator, for the dashboard banner.
  try {
    info.medusaEscalations = medusaWatchdog.escalationSummary();
  } catch (err) { // prawduct:allow prawduct/broad-except -- a store error must not cost the dashboard its whole status poll
    log.warn('Could not summarize Medusa escalations', { error: err.message });
    info.medusaEscalations = null;
  }
  // #1978: sessions whose wakes have been held for want of an engine answer,
  // with mail waiting — read-only evidence; no dashboard UI renders it.
  try {
    info.medusaWakeStalls = medusaWake.wakeStallSummary();
  } catch (err) { // prawduct:allow prawduct/broad-except -- a monitor read must not cost the dashboard its whole status poll
    log.warn('Could not summarize Medusa wake stalls', { error: err.message });
    info.medusaWakeStalls = null;
  }
  jsonResponse(res, 200, info);
});

// POST /api/dashboard/boot — the dashboard shell's boot beacon (#817). The
// client sends it once per page load, after its first successful projects
// fetch has rendered. A shell that never initialized (a stale precached
// landing.js, say) loads the document and nothing else — every server signal
// stays green — so the absence of `GET /api/projects` was the only tell, and
// that is equally what an operator opening a session page directly leaves
// behind. This line is the positive signal: `Dashboard booted` in the log
// after a `GET /` means the shell ran; its absence means it did not. Logged
// with whatever cache generation the browser reports, because "which precache
// did it boot against" is the first question the runbook asks
// (docs/runbooks/dashboard-blank.md). Nothing is stored; 204 by design.
route('POST', '/api/dashboard/boot', (_req, res, _params, body) => {
  const payload = body && typeof body === 'object' ? body : {};
  const { cacheName } = payload;
  if (cacheName !== undefined && cacheName !== null && typeof cacheName !== 'string') {
    return errorResponse(res, 400, 'cacheName must be a string or null', 'BAD_REQUEST');
  }
  // Bounded: this lands in the log verbatim, and a browser-supplied string
  // must not be able to fill a rotation window on its own.
  const reported = typeof cacheName === 'string' ? cacheName.slice(0, 200) : null;
  log.info('Dashboard booted', { cacheName: reported, swControlled: payload.controlled === true });
  res.writeHead(204);
  res.end();
});

// ── Project Master (chunk G, #331) ──
// Operator routes for the global fleet assistant — a reserved tmux
// session, NOT a sessions-table row (see lib/master.js). Deliberately outside
// the M2M-gated path set: these are operator surfaces, not fleet surfaces.

// GET /api/master/status — is the master session alive? Truth from tmux.
route('GET', '/api/master/status', (_req, res) => {
  jsonResponse(res, 200, master.getMasterStatus());
});

// POST /api/master/ensure — idempotent create-or-noop. Regenerates the
// master's CLAUDE.md identity every call (so guide/token changes propagate),
// launches the session only when absent. The UI calls this before attaching
// the terminal iframe (ttyd only attaches to EXISTING tmux sessions).
route('POST', '/api/master/ensure', (_req, res) => {
  const result = master.ensureMasterSession();
  if (result.error) {
    // Refused before anything started: the engine could not be shown isolated
    // from a background process it shares between sessions (#2233). 409, not
    // 500: nothing failed, and the message carries what to do.
    if (result.code === 'LAUNCH_ISOLATION_UNVERIFIED') {
      return errorResponse(res, 409, result.error, result.code, result.isolation);
    }
    // A refusal because tmux never answered is not a failed start, and the panel
    // must not paint it as one — "down" would be a definite claim about the very
    // thing that could not be established. Its own code, so the client branches
    // on a code rather than on the wording of the message.
    const code = (result.incomplete || []).includes('exists')
      ? 'MASTER_LIVENESS_UNKNOWN'
      : 'MASTER_ENSURE_FAILED';
    return errorResponse(res, 500, result.error, code);
  }
  jsonResponse(res, 200, result);
});

// POST /api/master/kill — stop the master's tmux session. Idempotent: an absent
// master is success, because the operator's intent is "not running". The remedy
// for #968 — a level change binds on the guard at once, but the running master
// reads its instructions only at launch, so it has to restart to act on one.
route('POST', '/api/master/kill', (_req, res) => {
  const result = master.killMasterSession();
  if (result.error) {
    // Same distinction ensure draws, and for the same reason: tmux declining to
    // answer is not "the master is stopped". Saying it was would tell the
    // operator their master is down during exactly the wedge where it is most
    // likely still running.
    // The CAUSE travels too. One code covers both refusals — tmux never answered
    // the probe, or the session was live and the kill went unconfirmed — and
    // without the cause a client cannot tell a timeout from the second case,
    // which are different things to tell the operator.
    return errorResponse(res, 500, result.error, 'MASTER_LIVENESS_UNKNOWN', { cause: result.cause });
  }
  jsonResponse(res, 200, result);
});

// POST /api/master/rules/restore-defaults — replace every master Hard rule
// with the shipped baseline (the recovery path if an edit ever weakened the
// boundary). History survives in session_rule_versions. The Master's identity
// file is regenerated on the next ensure, but a running Master read it when it
// was launched: the change reaches it at its next launch.
route('POST', '/api/master/rules/restore-defaults', (req, res) => {
  // It deletes every master rule the operator added, so it is theirs to run.
  if (!operatorProjectCaller(req, res, 'restore the Project Master\'s default rules')) return;
  const rules = master.restoreDefaultMasterRules();
  jsonResponse(res, 200, { ok: true, rules });
}, { signedInOperator: { action: 'restore the Project Master\'s default rules' } });

// POST /api/server/restart — kick the TC server via the platform's
// process manager (#235). 202 Accepted is sent BEFORE the exec so the
// browser sees a clean response, then ~300ms later the process manager
// (launchd or a systemd user unit) replaces this process. The browser
// polls /api/server-info to detect when the new process is up and
// reloads. Returns 501 when no restart mechanism is available (e.g.
// bare-node, or Linux without a qualifying user unit) so the frontend can
// hide the button cleanly, and 409 when a systemd unit that qualified at
// boot no longer does.
route('POST', '/api/server/restart', async (req, res, _params, body) => {
  // #1861 — first, and never bypassed by `force`: a held caller, or one that
  // cannot be attributed while any lane is held, does not restart the server.
  if (controlRefused(res, { surface: 'server-restart', subject: { kind: 'caller', caller: resolveControlCaller(req) } })) return;
  // #583 — a restart kills any in-flight wrap pipeline (the 2026-07-16
  // incident's first domino: a restart POSTed mid-wrap 502'd the wrap and
  // orphaned its content steps). Refuse while a wrap runs unless the
  // operator explicitly forces past the guard. Checked BEFORE mechanism
  // detection so the refusal path can never schedule an exec, and again
  // after the systemd re-check below, since a wrap can start while it runs.
  const refuseIfWrapping = () => {
    const wrappingProject = wrapRunRegistry.anyRunning();
    if (!wrappingProject || (body && body.force === true)) return false;
    errorResponse(res, 409,
      `A session wrap is running for "${wrappingProject}" — restarting now would kill it mid-pipeline. ` +
      'Wait for it to finish (GET /api/sessions/:project/wrap/status), or retry with {"force": true}.',
      'WRAP_RESTART_BLOCKED');
    return true;
  };
  if (refuseIfWrapping()) return;
  const mechanism = serverInfo.detectRestartMechanism();
  if (!mechanism) {
    jsonResponse(res, 501, {
      ok: false,
      error: 'no restart mechanism available on this host (no macOS launchd plist, and no systemd user unit tangleclaw.service that runs this server with KillMode=process)'
    });
    return;
  }
  // The unit may have changed since boot; a restart it cannot survive would
  // end every tmux session, so ask systemd again (without blocking) first.
  const confirmed = await serverInfo.confirmRestartMechanism(mechanism);
  if (!confirmed.ok) {
    return errorResponse(res, 409, `Restart not safe right now: ${confirmed.reason}`, 'RESTART_NOT_SAFE');
  }
  if (refuseIfWrapping()) return;
  const command = serverInfo.buildRestartCommand(mechanism);
  if (!command) {
    // Defensive: detectRestartMechanism returned non-null but
    // buildRestartCommand didn't recognize it. Bug, not user error.
    jsonResponse(res, 500, {
      ok: false,
      error: `internal: no command builder for mechanism "${mechanism}"`
    });
    return;
  }
  jsonResponse(res, 202, {
    ok: true,
    mechanism,
    detail: 'restart scheduled; poll /api/server-info to detect when the new process is up'
  });
  // Delay so the response actually drains through the network before
  // `launchctl kickstart -k` SIGKILLs us. SIGKILL closes sockets with
  // RST (not FIN) on macOS, so any bytes still in the kernel TX buffer
  // are dropped without delivery. On localhost the handover is
  // sub-millisecond; on a Cloudflare tunnel to a remote browser
  // (the common setup: operator on a second machine, TangleClaw on the host)
  // RTT can be 50-150ms, so the 202 response needs a margin past the
  // pure kernel-flush time. 300ms covers typical tunnel RTT plus
  // queue/processing slack without being noticeably slow to the
  // operator (the dialog closes, then ~300ms later polling begins —
  // visually instantaneous). Bumped from 80ms after Critic-flagged
  // remote-truncation risk on #235.
  setTimeout(() => {
    // #2140 — execSync blocked the event loop for up to its own 5s timeout,
    // which kept this process from receiving SIGTERM the instant the restart
    // actually lands, so a successful restart could still spawnSync-ETIMEDOUT
    // against a process manager that was already tearing this one down.
    // Async exec keeps the loop free to receive that signal immediately.
    require('node:child_process').exec(command, { timeout: 5000 }, (err, _stdout, stderr) => {
      if (!err) return;
      // This process is already shutting down as part of the restart it just
      // triggered — the child dying to a SIGTERM IT raised against itself (not
      // one `timeout: 5000` above enforced, which also sets signal: 'SIGTERM'
      // but with killed: true) is the expected success path, not a failure to
      // log. A genuinely hung command that node had to kill on timeout still
      // logs — that is a real failure, not a shutdown.
      if (err.signal === 'SIGTERM' && !err.killed) return;
      // No process manager took the restart, so this process lives on:
      // log the command's own reason (a missing unit, no user bus) rather
      // than just its exit status, and don't crash.
      const reason = stderr ? String(stderr).trim() : '';
      // eslint-disable-next-line no-console
      console.error('[server-restart] exec failed:', err.message, reason ? `— ${reason}` : '');
    });
  }, 300);
});

// The config routes are registered from their own module, at the position they
// held; the setup credential decision and the ingress door reader the handlers
// use still live here and are handed over.
configRoutes.register({ _decideSetupCredential, _gateIngress });

// AUTH-4b — service-token management. These are OPERATOR endpoints (gated by
// basic_auth in caddy mode / localhost-only in direct mode, like the rest of
// /api), deliberately OUTSIDE the M2M-gated path set — a service caller holding
// the token must not be able to reveal or rotate its own gate credential.

// ── TangleClaw's own session routes (#1418) ──
//
// These three are TangleClaw's login, distinct from the `/api/auth/credential`
// pair below them, which manages the CADDY basic_auth credential. Caddy's
// password stands in front of TangleClaw only in some gate states
// (`authGate.guardsTheDoor` says when it is not needed), so a reader needs to
// know which door a route is about: `/api/auth/login|logout|me` are
// TangleClaw's own (scrypt, a session cookie), `/api/auth/credential` is
// Caddy's (bcrypt, a Caddyfile).

// How many password verifications `POST /api/auth/login` runs at once.
//
// The route is gate-exempt, CSRF-exempt and open to anyone who can reach the
// listener, and async scrypt moved a burst of attempts off the event loop onto
// libuv's threadpool rather than removing it. That pool is 4 slots by default
// and it is SHARED with fs and dns, so a handful of concurrent unauthenticated
// POSTs would occupy every slot the process has — the same "stalls every other
// request" failure ADR 0016 gives for choosing async scrypt, relocated. Two
// leaves half the pool to the rest of the server.
//
// A cap on concurrency, deliberately not a lockout: there is no per-account or
// per-address state, so nobody can lock the operator out by guessing at their
// username. The trade-off, stated rather than hidden: during an anonymous flood
// the operator's own attempt usually meets the 503 too, and retries. Chosen over
// the alternative on purpose — an uncapped flood stalls the whole server, the
// dashboard included, while a capped one costs only sign-ins, and only for as
// long as the flood lasts.
const MAX_CONCURRENT_LOGIN_VERIFICATIONS = 2;
let _loginVerificationsInFlight = 0;

/**
 * Run one password derivation inside the shared concurrency cap, or refuse.
 *
 * The ONE place the cap is checked, counted and released. Every route that
 * hashes or verifies a password calls this — the login, the first-account
 * page, a recovery-code redemption, minting new codes — because a copy that
 * drops the `finally` leaks a slot on a route anyone can reach signed-out, and
 * a leaked slot is a refusal that lasts until the process restarts. The refusal
 * is logged at warn from here too, so "the server said it was busy" is in the
 * log whichever route said it.
 *
 * Call it only once a derivation is actually about to run, so a malformed
 * request never holds a slot. An exception from `derive` releases the slot and
 * propagates to the caller.
 *
 * @template T
 * @param {http.ServerResponse} res - Headers not yet sent
 * @param {string} action - What was refused, for the log, e.g. `a login`.
 * @param {() => Promise<T>} derive - The hashing work.
 * @param {string} [busyMessage] - The 503's message.
 * @returns {Promise<{ refused: true }|{ refused: false, value: T }>} `refused`
 *   when the 503 has been sent and the caller must stop.
 */
async function _withHashSlot(res, action, derive, busyMessage = 'The server is busy. Try again in a moment.') {
  if (_loginVerificationsInFlight >= MAX_CONCURRENT_LOGIN_VERIFICATIONS) {
    log.warn(`Refused ${action}: too many password hashes already in flight`, {
      inFlight: _loginVerificationsInFlight
    });
    res.setHeader('Retry-After', '1');
    errorResponse(res, 503, busyMessage, 'LOGIN_BUSY');
    return { refused: true };
  }
  _loginVerificationsInFlight += 1;
  try {
    return { refused: false, value: await derive() };
  } finally {
    _loginVerificationsInFlight -= 1;
  }
}

// POST /api/auth/login — exchange a username and password for a session.
//
// Exempt from the gate (`lib/auth-gate.js` LOGIN_SURFACE_PATHS) because it is
// how a person stops being unauthenticated.
route('POST', '/api/auth/login', async (req, res, _params, body) => {
  // parseBody resolves null for an empty request, so reading fields off `body`
  // directly would throw a 500 for what is simply a malformed request.
  const payload = body || {};
  const username = typeof payload.username === 'string' ? payload.username : '';
  const password = typeof payload.password === 'string' ? payload.password : '';

  // ONE message and ONE code for every failure — no account, wrong password,
  // disabled account. The store already equalises the TIMING of those three
  // (`users.verifyAsync` spends the same scrypt cost on all of them); saying
  // which one happened in the response would hand back through the body
  // exactly the username oracle that equalisation exists to deny. The operator
  // gets the distinction in the log, at warn, where `store.users` writes it.
  const deny = () => errorResponse(res, 401,
    'That username and password did not match.', 'INVALID_CREDENTIALS');

  // Validated for PRESENCE only, never against `validateAdminPassword`. Policy
  // belongs where a password is SET, not where one is checked: running the
  // rules here would refuse a login before verifying it, so an account whose
  // password predates a policy change could never sign in to change it — and
  // the refusal message would state a live credential's shape to whoever asked.
  if (!username || !password) return deny();

  // Async scrypt, per ADR 0016. `scryptSync` costs tens of milliseconds and
  // this is a route anyone can knock on: a burst of attempts on the sync
  // version stalls every other request, including the dashboard the operator is
  // trying to reach. The equal-cost comparison inside `verifyAsync` is kept —
  // that cost is the anti-timing-oracle fix, so the answer to blocking is to
  // stop blocking, never to stop paying.
  //
  // Inside the shared cap (`_withHashSlot`).
  const verified = await _withHashSlot(res, 'a login', () => store.users.verifyAsync(username, password),
    'The server is busy checking other sign-ins. Try again in a moment.');
  if (verified.refused) return;
  const user = verified.value;
  if (!user) return deny();

  const session = _signIn(req, res, user);
  jsonResponse(res, 200, { username: user.username, csrfToken: session.csrfToken });
});

/**
 * Sign a verified user in: rotate away the session the request arrived with,
 * mint a new one, and set both cookies on the response.
 *
 * The ONE place a session is issued. Every route that signs someone in — the
 * login, the first-account page, the first-run wizard — calls this rather than
 * repeating the three steps, because the step that matters is the easiest to
 * leave out of a copy: session fixation. The session the request ARRIVED with
 * is destroyed; `store.authSessions.create` cannot adopt a caller-supplied id,
 * so the new token is fresh by construction, and destroying the old one keeps
 * an attacker-planted cookie from surviving as a second live session.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res - Headers not yet sent
 * @param {{ id: number, username: string }} user - Already authenticated
 * @returns {{ token: string, csrfToken: string }} The new session
 */
function _signIn(req, res, user) {
  const arriving = authSession.tokenFromRequest(req);
  if (arriving) store.authSessions.destroy(arriving);
  const session = store.authSessions.create(user);
  const secure = authSession.isSecureRequest(req);
  res.setHeader('Set-Cookie', [
    authSession.serializeCookie(session.token, { secure }),
    authSession.serializeCsrfCookie(session.csrfToken, { secure })
  ]);
  return session;
}

// POST /api/auth/logout — end this session.
//
// Answers 200 whether or not a session was found. A logout that 404s on an
// already-expired cookie tells the caller nothing useful and leaves the cookie
// sitting in the browser; clearing it unconditionally is both simpler and the
// behaviour every client wants. The CSRF check still applies when a session
// DOES resolve — `lib/auth-gate.js` runs it ahead of the exemption list for
// exactly this route.
route('POST', '/api/auth/logout', (req, res) => {
  const token = authSession.tokenFromRequest(req);
  if (token) store.authSessions.destroy(token);
  const secure = authSession.isSecureRequest(req);
  res.setHeader('Set-Cookie', [
    authSession.clearCookie({ secure }),
    authSession.clearCsrfCookie({ secure })
  ]);
  jsonResponse(res, 200, { ok: true });
});

// POST /api/auth/set-password — create an install's FIRST account.
//
// Reachable by a signed-out person ONLY while the install is `account-required`
// (`lib/auth-gate.js#ACCOUNT_SETUP_PATH`): `authEnabled` is on and no account
// row exists. That is where every upgraded install lands, since the bcrypt
// `basicAuthHash` Caddy's gate used cannot be verified by scrypt.
//
// WHAT AUTHORISES IT IS REACH, as ADR 0016 decides. No current-password field:
// this server cannot verify the bcrypt hash it holds, and a field it cannot
// check would be theatre. Reach is enough because no code path deletes a user
// row, so this state exists only before an install's first account, and anyone
// who can reach this route then could already reach the install ungated or had
// already passed Caddy's gate. `lib/auth-gate.js#resolveGateState` carries the
// full argument, and the dependency on rows never being deleted.
//
// `basicAuthHash` is deliberately NOT touched. It stays as the fallback
// credential Caddy's gate can be restored with (ADR 0016 addendum).
//
// Policy is `caddy.validateAdminPassword`, the same rules the Caddy credential
// enforced, so the new door is not weaker than the one it replaces. The check
// runs BEFORE any hashing, so a stream of rejected submissions costs no scrypt.
// The hash itself is async and shares the login route's concurrency cap.
route('POST', '/api/auth/set-password', async (req, res, _params, body) => {
  // The gate's verdict for THIS request, carried on `req`. The gate lets a
  // signed-out caller reach this route only in `account-required`, so any other
  // state here means the install is open or the caller is signed in. The
  // account check that matters runs again inside `createFirstAsync`, under a
  // write lock, because another submission or `scripts/reset-admin.js` can land
  // in between.
  if (req.tcGateState !== authGate.GATE_STATES.ACCOUNT_REQUIRED) {
    // Each answer says what is actually true of the install. `armed` and
    // `locked` do have accounts; `open` needs none; `unreadable` cannot say, so
    // it must not claim either.
    if (authGate.isOpen(req.tcGateState)) {
      return errorResponse(res, 409,
        'This install does not require a login, so there is no account to create here.',
        'LOGIN_NOT_REQUIRED');
    }
    if (req.tcGateState === authGate.GATE_STATES.FALLBACK) {
      return _refuseDuringFallback(res, 'create an account');
    }
    if (req.tcGateState === authGate.GATE_STATES.UNREADABLE) {
      return errorResponse(res, 503,
        'TangleClaw cannot read its login state right now, so it cannot create an account. '
        + 'Check the server log.', 'GATE_UNREADABLE');
    }
    return errorResponse(res, 409,
      'An account already exists on this install. Sign in instead.', 'ACCOUNT_EXISTS');
  }
  // Reach authorises the first account only while no account has ever existed.
  // An install that had one and now has none lost its account store outside the
  // code (a deleted or restored database), and by then the Caddyfile may carry
  // no password of its own — the login it relied on is the one that was lost.
  // So the claim is taken only from this machine, on the loopback listener and
  // not through a proxy, which is also where `reset-admin.js --store` runs.
  const directLocal = adminCredential.isLoopbackRemote(req.socket && req.socket.remoteAddress)
    && !authIdentity.cameThroughProxy(req.headers);
  if (!directLocal) {
    let established;
    try {
      established = store.users.accountsEstablished();
    } catch (err) {
      log.error('Refused a first-account submission: could not check whether this install has had an account',
        { error: err.message });
      return errorResponse(res, 503,
        'TangleClaw cannot tell whether this install has had an account, so it cannot create one from here. '
        + 'Check the server log.', 'GATE_UNREADABLE');
    }
    if (established) {
      log.warn('Refused a first-account submission from off this machine: this install has had an account '
        + 'and its account store has none', { proxied: authIdentity.cameThroughProxy(req.headers) });
      return errorResponse(res, 403,
        'This install has had an account, and its account store no longer has one, so the first account '
        + 'can only be created on the machine itself: node scripts/reset-admin.js --store --user <name>. '
        + 'See docs/recovery.md.', 'ACCOUNT_STORE_LOST');
    }
  }
  const payload = body || {};
  const username = typeof payload.username === 'string' ? payload.username.trim() : '';
  const password = typeof payload.password === 'string' ? payload.password : '';
  if (!username) {
    return errorResponse(res, 400, 'Choose a username.', 'BAD_REQUEST');
  }
  const policy = caddy.validateAdminPassword(password, username);
  if (!policy.ok) {
    return errorResponse(res, 400, policy.error, 'WEAK_PASSWORD');
  }

  // Async scrypt, inside the SAME concurrency cap as the login route. Both are
  // reachable signed-out and both put a derivation on libuv's threadpool, which
  // fs and dns share, so they draw on one budget rather than two.
  let created;
  try {
    created = await _withHashSlot(res, 'a first-account submission',
      () => store.users.createFirstAsync(username, password));
  } catch (err) {
    if (err.code === 'ACCOUNT_EXISTS') {
      log.warn('Refused a first-account submission: an account was created first', { username });
      return errorResponse(res, 409,
        'An account already exists on this install. Sign in instead.', 'ACCOUNT_EXISTS');
    }
    throw err;
  }
  if (created.refused) return;
  const user = created.value;
  // Warn, not info: this is the moment an install acquires its only key, and an
  // operator reading the log afterwards must be able to see when, and whether it
  // came through the proxy or from the machine itself.
  log.warn('First account created from the account-setup page', {
    username: user.username,
    proxied: authIdentity.cameThroughProxy(req.headers)
  });

  // The account's first recovery codes, shown once by the page that asked. A
  // failure here must not undo the account that was just created — the person
  // is signed in and can generate codes in Settings — so it is logged and
  // reported as `recoveryCodes: null` rather than turned into a 500 that would
  // read as "the account was not created".
  let codes = null;
  try {
    codes = store.recoveryCodes.replaceForUser(user.id).map(recoveryCodes.formatCode);
  } catch (err) { // prawduct:allow prawduct/broad-except -- the account already exists; any failure is logged and reported as no codes
    log.error('Could not generate recovery codes for the first account', {
      username: user.username, error: err.message
    });
  }

  const session = _signIn(req, res, user);
  jsonResponse(res, 200, { username: user.username, csrfToken: session.csrfToken, recoveryCodes: codes });
});

// POST /api/auth/add-login — turn TangleClaw's login on for an install that has none.
//
// The way back from the choice of no login made during setup (ADR 0009's
// opt-out, ruled 2026-09-10: a login is addable later from global settings),
// and from an install whose account was made at a terminal while the login was
// off. It turns `authEnabled` on and nothing else. The account is not created
// here: with none, the gate becomes `account-required` and `/login` serves the
// first-account page, which already creates it, signs the person in and shows
// the recovery codes once. With one, `/login` asks for it. So the settings page
// sends the browser to `/login` and this route never touches a password.
//
// Allowed only while the gate is `open`, because that is the state in which it
// authorises itself: whoever can reach an open install already has its shell,
// the reason the first-account screen is reachable signed out (ADR 0016).
// Turning a login ON opens nothing. What it can do wrong is strand the person
// who pressed it, so it is refused where the next page could not let them in:
// an install that has had an account and lost it, from off this machine, where
// the first-account page refuses with ACCOUNT_STORE_LOST.
//
// The saved config loses `loginOptOutAt`: once a login is on, "the operator chose
// no login" is no longer true of the install, and `store.config.save` clears it.
route('POST', '/api/auth/add-login', (req, res) => {
  if (!authGate.isOpen(req.tcGateState)) {
    if (req.tcGateState === authGate.GATE_STATES.FALLBACK) {
      return _refuseDuringFallback(res, 'turn the login on');
    }
    if (req.tcGateState === authGate.GATE_STATES.UNREADABLE) {
      return errorResponse(res, 503,
        'TangleClaw cannot read its login state right now, so it cannot turn the login on. '
        + 'Check the server log.', 'GATE_UNREADABLE');
    }
    return errorResponse(res, 409,
      'TangleClaw\'s login is already on for this install.', 'LOGIN_ALREADY_ON');
  }
  const config = store.config.load();
  if (config.setupComplete !== true) {
    return errorResponse(res, 409,
      'Setup is not finished. Choose the login in the setup wizard.', 'SETUP_NOT_COMPLETE');
  }
  let presence;
  let established;
  try {
    presence = store.authSessions.accountPresence();
    established = store.users.accountsEstablished();
  } catch (err) {
    log.error('Refused to turn the login on: could not read the account store', { error: err.message });
    return errorResponse(res, 503,
      'TangleClaw cannot read its account store, so it cannot tell whether you could sign in afterwards. '
      + 'Check the server log.', 'GATE_UNREADABLE');
  }
  const directLocal = adminCredential.isLoopbackRemote(req.socket && req.socket.remoteAddress)
    && !authIdentity.cameThroughProxy(req.headers);
  if (!presence.exists && established && !directLocal) {
    return errorResponse(res, 403,
      'This install has had an account, and its account store no longer has one, so turning the login on '
      + 'from here would leave a sign-in page that cannot create one. Run '
      + 'node scripts/reset-admin.js --store --user <name> on the machine itself. See docs/recovery.md.',
      'ACCOUNT_STORE_LOST');
  }
  if (presence.exists && !presence.loginable) {
    return errorResponse(res, 409,
      'Every account on this install is disabled, so turning the login on would leave no one able to sign in. '
      + 'Run node scripts/reset-admin.js --store --user <name> on the machine to re-enable one first.',
      'NO_LOGINABLE_ACCOUNT');
  }
  // Saving with the login on clears `loginOptOutAt` (`store.config.save`).
  config.authEnabled = true;
  store.config.save(config);
  log.warn('TangleClaw\'s login was turned on from settings', {
    accountExists: presence.exists, proxied: authIdentity.cameThroughProxy(req.headers)
  });
  jsonResponse(res, 200, { loginEnabled: true, accountExists: presence.exists, next: '/login' });
});

// ── Recovery codes (#1420, ADR 0016 "The ruling") ──
//
// A code resets one account's password once, from anywhere the login page can be
// reached. That is a second way past the password, accepted by the operator for
// installers for whom "SSH in and run a script" is no recovery at all, and every
// choice below keeps it worth exactly that:
//
//   - redemption is exempt from the gate only while `armed`
//     (`lib/auth-gate.js#RECOVERY_PATHS`);
//   - a wrong code, a used code and a disabled account's code get one answer
//     (`store.recoveryCodes#peek` is one query for all three);
//   - failures are counted per client and refused past a limit;
//   - a redemption ends every session the account holds, is logged at warn, and
//     raises a notice on the account's dashboard;
//   - minting codes needs the current PASSWORD, not only a session, because a
//     stolen cookie that could mint codes would leave the thief a key that
//     survives the operator's next password change.

// Failed redemptions per client. Only failures count, so the operator's own
// success is never slowed. The code's 125 bits already make guessing hopeless;
// this bounds the log and CPU a flood can cost, and it is per client so one
// flood cannot lock everyone else out of recovery.
const _recoveryFailures = recoveryCodes.createFailureLimiter();

/**
 * Who is redeeming: the limiter's key, and a readable origin for the log and
 * the dashboard notice.
 * @param {http.IncomingMessage} req
 * @returns {{ key: string, from: string }}
 */
function _recoveryClient(req) {
  const client = recoveryCodes.clientKey(req.socket, req.headers, adminCredential.isLoopbackRemote);
  const from = client.proxied ? `${client.address} (through the proxy)` : (client.address || 'unknown');
  return { key: client.key, from };
}

/**
 * Whether a browser request positively vouches for being same-origin.
 *
 * The perimeter's cross-site guard refuses `Sec-Fetch-Site: cross-site` and lets
 * `same-site` and an absent header through, which is right for the whole API: a
 * non-browser caller sends neither header and is not a forgery vector. This is
 * the POSITIVE form, for the one route that runs with no login behind it — there
 * the absence of a refusal is not the same as evidence, so `same-site` (a
 * sibling subdomain) and a missing `Origin` are both refused rather than assumed
 * friendly.
 *
 * The `Origin`-vs-`Host` comparison itself is `_isSameOriginUpgrade`'s, not a
 * second one: it parses both sides rather than splitting on `':'` (an IPv6
 * literal `Host` is bracketed) and compares HOSTNAMES, deliberately dropping
 * the port, because this dashboard is reached over https through Caddy on one
 * port and over http directly on another. A private copy comparing `host` would
 * have answered differently for the same request — an operator behind an
 * ingress that rewrites the port would have had the terminal socket connect and
 * this button refuse.
 *
 * @param {http.IncomingMessage} req - The request
 * @param {string} [what='A recovery clear'] - The write being attempted, for the refusal message.
 * @returns {{ok: true}|{ok: false, error: string, code: string}}
 */
function _isSameOriginClear(req, what = 'A recovery clear') {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') {
    return {
      ok: false,
      code: 'CROSS_SITE_FORBIDDEN',
      error: `${what} must come from this server's own dashboard; this request reported itself as "${site}".`
    };
  }
  const origin = req.headers.origin;
  if (!origin) {
    return {
      ok: false,
      code: 'CROSS_SITE_FORBIDDEN',
      error: `${what} must come from this server's own dashboard, and this request carried no Origin.`
    };
  }
  if (!req.headers.host || !_isSameOriginUpgrade(origin, req.headers.host)) {
    return {
      ok: false,
      code: 'CROSS_SITE_FORBIDDEN',
      error: `${what} must come from this server's own dashboard; that Origin is not `
        + `"${req.headers.host || 'this host'}".`
    };
  }
  // The independent check (#864): the two headers above agree with each other
  // even when an attacker controls DNS, because both describe the same name.
  if (!_hostIsAllowed(req.headers.host)) {
    return {
      ok: false,
      code: 'HOST_NOT_ALLOWED',
      error: 'That host is not a name this install serves.'
    };
  }
  return { ok: true };
}

/**
 * Refuse a login-management request while TangleClaw's login is stood down
 * behind Caddy's gate. Every such request would act on a login that is not in
 * force, and the operator's next step is at the terminal, not here.
 * @param {http.ServerResponse} res
 * @param {string} action - What was asked, e.g. `create an account`.
 * @returns {void}
 */
function _refuseDuringFallback(res, action) {
  errorResponse(res, 409, `TangleClaw's login is stood down behind Caddy's password (fallback), so it cannot ${action} `
    + 'right now. Fix the login, then run node scripts/gate-fallback.js --undo at a terminal on the machine.',
  'GATE_FALLBACK');
}

/**
 * Admit only a signed-in operator to a route that grants or approves authority
 * over sessions (#2378). The operator checks that guard such routes admit,
 * while no login is in force (`open`, `fallback`), by the request's shape: a browser's headers or
 * the dashboard's marker, which any process on the host can send, a project
 * session included. That cannot authorize a session to be granted something,
 * so such a route asks for the one thing a shape cannot carry: a session the
 * login gate issued. Called by the dispatcher for a route registered with
 * `signedInOperator`, and by a handler for a branch of one that is not wholly
 * such a route; in both, only once the caller has been admitted as the
 * operator, so a project or the Project Master never meets it.
 * @param {http.IncomingMessage} req - The request
 * @param {http.ServerResponse} res - The response, written only on refusal
 * @param {{action: string, logLine?: string, refusal?: string}} demand - `action` is
 *   what was asked, as a verb phrase (`grant a coordinator role`). `refusal`, where a
 *   route shipped its own, replaces the 403's message and is answered in `fallback`
 *   too; `logLine` replaces the warn line.
 * @returns {boolean} true when the request carries the operator's signed-in session
 */
function _requireSignedInOperator(req, res, demand) {
  if (req.tcSession) return true;
  const stoodDownBehindCaddy = req.tcGateState === authGate.GATE_STATES.FALLBACK && !demand.refusal;
  const code = stoodDownBehindCaddy ? 'GATE_FALLBACK' : 'LOGIN_GATE_REQUIRED';
  log.warn(demand.logLine || `A request to ${demand.action} was refused: no signed-in operator`, {
    code, method: req.method, path: reqUrl(req).pathname, gateState: req.tcGateState || null
  });
  if (stoodDownBehindCaddy) {
    _refuseDuringFallback(res, demand.action);
    return false;
  }
  errorResponse(res, 403, demand.refusal || `Only a signed-in operator can ${demand.action}, and this request `
    + 'carries no sign-in: with no login in force nothing would establish that the sender is the operator. Turn '
    + 'TangleClaw\'s login on, sign in, and send the request again. Nothing was changed.', 'LOGIN_GATE_REQUIRED');
  return false;
}

/**
 * Refuse a recovery request on an install where no code can succeed, saying what
 * is actually true of it.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {boolean} true when a refusal was sent
 */
function _refuseRecoveryOutsideArmed(req, res) {
  if (req.tcGateState === authGate.GATE_STATES.ARMED) return false;
  if (authGate.isOpen(req.tcGateState)) {
    errorResponse(res, 409, 'This install does not require a login, so there is no password to recover.',
      'LOGIN_NOT_REQUIRED');
  } else if (req.tcGateState === authGate.GATE_STATES.FALLBACK) {
    _refuseDuringFallback(res, 'check a recovery code');
  } else if (req.tcGateState === authGate.GATE_STATES.UNREADABLE) {
    errorResponse(res, 503, 'TangleClaw cannot read its login state right now, so it cannot check a '
      + 'recovery code. Check the server log.', 'GATE_UNREADABLE');
  } else {
    errorResponse(res, 409, 'No account on this install can be recovered with a code. '
      + 'Run node scripts/reset-admin.js at a terminal on the machine.', 'RECOVERY_UNAVAILABLE');
  }
  return true;
}

// POST /api/auth/recover — set a new password with a one-time recovery code.
//
// Order is argued:
//   1. Not `armed` → refuse. The gate normally challenges first; the fleet
//      carve-out can still reach here in any state.
//   2. The per-client failure limit, before anything is read.
//   3. Both fields present — a 400 that reads nothing and costs no failure.
//   4. The code (`peek`, no side effect). Unknown, used, or a disabled
//      account's → the one answer, counted as a failure.
//   5. Password policy, which needs the account's username. Reached only by
//      someone already holding a valid code, and the code is not consumed.
//   6. Hash the new password off the event loop, inside the login cap.
//   7. `redeem` re-checks the code under the write lock and applies everything
//      at once; a code used in between gets the step-4 answer.
//   8. Sign the redeemer in through `_signIn`.
route('POST', '/api/auth/recover', async (req, res, _params, body) => {
  if (_refuseRecoveryOutsideArmed(req, res)) return;
  const client = _recoveryClient(req);
  if (_recoveryFailures.isLimited(client.key)) {
    log.warn('Refused a recovery attempt: too many failures from this client', { from: client.from });
    res.setHeader('Retry-After', '900');
    return errorResponse(res, 429,
      'Too many recovery attempts from here. Wait a few minutes and try again.', 'RECOVERY_RATE_LIMITED');
  }
  const payload = body || {};
  const code = typeof payload.code === 'string' ? payload.code : '';
  const password = typeof payload.password === 'string' ? payload.password : '';
  if (!code || !password) {
    return errorResponse(res, 400, 'Enter a recovery code and a new password.', 'BAD_REQUEST');
  }

  // ONE message and ONE code for an unknown, used or disabled-account code —
  // "wrong" and "already used" must not be told apart.
  const deny = () => {
    _recoveryFailures.recordFailure(client.key);
    log.warn('Recovery code refused', { from: client.from });
    return errorResponse(res, 401, 'That recovery code is not valid.', 'INVALID_RECOVERY_CODE');
  };
  const holder = store.recoveryCodes.peek(code);
  if (!holder) return deny();

  const policy = caddy.validateAdminPassword(password, holder.username);
  if (!policy.ok) return errorResponse(res, 400, policy.error, 'WEAK_PASSWORD');

  const hashed = await _withHashSlot(res, 'a recovery-code redemption',
    () => passwordHashing.hashPasswordAsync(password));
  if (hashed.refused) return;
  const redeemed = store.recoveryCodes.redeem(code, hashed.value, client.from);
  if (!redeemed) return deny();

  const user = { id: redeemed.id, username: redeemed.username };
  const session = _signIn(req, res, user);
  jsonResponse(res, 200, { username: user.username, remaining: redeemed.remaining, csrfToken: session.csrfToken });
});

/**
 * The signed-in session an account-management route acts for, or null after
 * sending the refusal. An `open` install resolves no session at all, so the
 * answer there says a login is not in use.
 *
 * Shared by every route that manages the signed-in account — recovery codes,
 * the password, signing out everywhere — so the three refusals read the same
 * wherever they are met, and a local tool that reaches one of these routes past
 * the gate with no session is refused by the route rather than by luck.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object} words
 * @param {string} words.notRequired - The 409's message on an open install
 * @param {string} words.action - What was asked, e.g. `manage recovery codes`
 * @returns {object|null}
 */
function _accountSession(req, res, words) {
  if (req.tcSession) return req.tcSession;
  if (authGate.isOpen(req.tcGateState)) {
    errorResponse(res, 409, words.notRequired, 'LOGIN_NOT_REQUIRED');
  } else if (req.tcGateState === authGate.GATE_STATES.FALLBACK) {
    _refuseDuringFallback(res, words.action);
  } else {
    errorResponse(res, 401, `Sign in to ${words.action}.`, 'UNAUTHENTICATED');
  }
  return null;
}

/**
 * {@link _accountSession} with the recovery-code routes' words.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {object|null}
 */
function _recoveryCodesSession(req, res) {
  return _accountSession(req, res, {
    notRequired: 'Recovery codes belong to a login, and this install does not require one.',
    action: 'manage recovery codes'
  });
}

// GET /api/auth/recovery-codes — how many unused codes the signed-in account
// holds, and any redemption it has not acknowledged. Never a code: codes exist
// in the clear only in the response that minted them.
route('GET', '/api/auth/recovery-codes', (req, res) => {
  const session = _recoveryCodesSession(req, res);
  if (!session) return;
  jsonResponse(res, 200, Object.assign(store.recoveryCodes.status(session.userId), {
    notice: store.recoveryCodes.pendingNotice(session.userId)
  }));
});

// POST /api/auth/recovery-codes — replace the signed-in account's codes.
//
// Requires the current password in the body: a session alone must not mint a
// key that outlives a password change. Verified with the login route's
// equal-cost `verifyAsync`, inside the same concurrency cap.
route('POST', '/api/auth/recovery-codes', async (req, res, _params, body) => {
  const session = _recoveryCodesSession(req, res);
  if (!session) return;
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!password) {
    return errorResponse(res, 400, 'Enter your current password to generate new codes.', 'BAD_REQUEST');
  }
  const reauth = await _withHashSlot(res, 'minting recovery codes',
    () => store.users.verifyAsync(session.username, password));
  if (reauth.refused) return;
  const verified = reauth.value;
  if (!verified) {
    return errorResponse(res, 403, 'That password did not match.', 'REAUTH_FAILED');
  }
  let codes;
  try {
    codes = store.recoveryCodes.replaceForUser(verified.id);
  } catch (err) {
    if (err.code === 'NO_SUCH_ACCOUNT') {
      return errorResponse(res, 409, 'This account cannot hold recovery codes.', 'NO_SUCH_ACCOUNT');
    }
    throw err;
  }
  jsonResponse(res, 200, { codes: codes.map(recoveryCodes.formatCode), remaining: codes.length });
});

// POST /api/auth/recovery-codes/acknowledge — clear the signed-in account's
// redemption notice. The one way it goes away besides regenerating the codes.
route('POST', '/api/auth/recovery-codes/acknowledge', (req, res) => {
  const session = _recoveryCodesSession(req, res);
  if (!session) return;
  jsonResponse(res, 200, { cleared: store.recoveryCodes.clearNotice(session.userId) });
});

// ── Account self-service (#1457, #1463) ──

// POST /api/auth/password — change the signed-in account's password.
//
// Order is argued:
//   1. A session (`_accountSession`). The route is not on the gate's exemption
//      list, so the gate has already required the session and its CSRF token.
//   2. Both fields present — a 400 that costs no hashing.
//   3. Policy on the NEW password, before any hashing, so a stream of rejected
//      submissions costs no scrypt. The same rules as every surface that sets
//      one (`caddy.validateAdminPassword`).
//   4. `users.changePasswordFromSession`, inside ONE hash slot: verify the
//      CURRENT password and hash the new one, then, under the write lock and
//      only if neither the stored hash nor this session changed meanwhile, set
//      the password, end the account's other sessions and replace this one.
//      A session alone must not be able to change the password: a stolen
//      cookie that could would lock the owner out of their own account.
//   5. Set the replacement session's cookies, so this browser stays signed in
//      and a copy of its old cookie does not.
//
// A wrong current password answers 403 `REAUTH_FAILED`, as minting recovery
// codes does — not 401, which the dashboard reads as "your session is gone"
// and leaves the page for. It is logged at warn under its own message: a run of
// them is someone with a session guessing at the password, which a generic
// verify-failed line would hide among ordinary mistyped sign-ins.
route('POST', '/api/auth/password', async (req, res, _params, body) => {
  const session = _accountSession(req, res, {
    notRequired: 'This install does not require a login, so there is no password to change.',
    action: 'change your password'
  });
  if (!session) return;
  const payload = body || {};
  const current = typeof payload.currentPassword === 'string' ? payload.currentPassword : '';
  const next = typeof payload.newPassword === 'string' ? payload.newPassword : '';
  if (!current || !next) {
    return errorResponse(res, 400, 'Enter your current password and a new one.', 'BAD_REQUEST');
  }
  const policy = caddy.validateAdminPassword(next, session.username);
  if (!policy.ok) return errorResponse(res, 400, policy.error, 'WEAK_PASSWORD');

  const attempt = await _withHashSlot(res, 'a password change',
    () => store.users.changePasswordFromSession(session, current, next));
  if (attempt.refused) return;
  const outcome = attempt.value;
  if (outcome.status === 'bad-password') {
    log.warn('Refused a password change: the current password did not match', { username: session.username });
    return errorResponse(res, 403, 'That current password did not match.', 'REAUTH_FAILED');
  }
  if (outcome.status === 'stale') {
    log.warn('Refused a password change: the password or this session changed while it was being checked',
      { username: session.username });
    return errorResponse(res, 409,
      'Your password or your session changed while this was being checked, so nothing was changed. '
      + 'Reload and try again.', 'PASSWORD_CHANGE_STALE');
  }
  const secure = authSession.isSecureRequest(req);
  res.setHeader('Set-Cookie', [
    authSession.serializeCookie(outcome.session.token, { secure }),
    authSession.serializeCsrfCookie(outcome.session.csrfToken, { secure })
  ]);
  jsonResponse(res, 200, {
    ok: true, otherSessionsEnded: outcome.sessionsEnded, csrfToken: outcome.session.csrfToken
  });
});

// POST /api/auth/logout-everywhere — end every session the signed-in account
// holds, this one included, and clear this browser's cookies.
//
// Unlike `POST /api/auth/logout` this is NOT on the gate's exemption list: it
// acts on sessions other than the one presenting it, so it needs a live session
// and the CSRF token like any other write. No password: the worst a stolen
// cookie does with it is sign the owner out, and the owner — on a lost or
// borrowed device's behalf — needs it to be one click.
route('POST', '/api/auth/logout-everywhere', (req, res) => {
  const session = _accountSession(req, res, {
    notRequired: 'This install does not require a login, so there is no session to end.',
    action: 'sign out everywhere'
  });
  if (!session) return;
  const ended = store.authSessions.destroyForUser(session.username);
  log.warn('Signed out everywhere', { username: session.username, sessionsEnded: ended });
  const secure = authSession.isSecureRequest(req);
  res.setHeader('Set-Cookie', [
    authSession.clearCookie({ secure }),
    authSession.clearCsrfCookie({ secure })
  ]);
  jsonResponse(res, 200, { ok: true, sessionsEnded: ended });
});

// GET /api/auth/me — who this request is, and whether a login is required.
//
// Built from the SESSION and never from the user row. ADR 0016 records why:
// `store.users.getByName` returns the password hash, because its only caller is
// the one about to verify a password against it. A route that answered from
// that row would be one careless spread away from serving a credential.
//
// Answers 200 with `authenticated: false` rather than 401 when the gate is off,
// because "no login is required here" is a successful answer to the question
// the dashboard is asking. It stays reachable signed out while the gate IS on
// (`lib/auth-gate.js` LOGIN_SURFACE_PATHS): the sign-in page reads `gateState`
// here to say why a sign-in cannot work, and whether a recovery code can.
route('GET', '/api/auth/me', (req, res) => {
  const session = req.tcSession;
  // Both branches read the verdict `handleRequest` already reached, never a
  // fresh one: one request, one answer.
  const gateActive = req.tcGateActive === true;
  const gateState = req.tcGateState;
  if (!session) {
    return jsonResponse(res, 200, {
      authenticated: false,
      gateActive,
      gateState,
      username: null,
      csrfToken: null,
      // An OPEN install has no session and therefore no CSRF token, which left
      // its dashboard with nothing to prove it was this server's page. One is
      // minted here, for the one route that needs it. `null` everywhere else,
      // including `armed` signed out: a token that means "this page came from
      // this server" is worth nothing where a session token already says more.
      openInstallToken: authGate.isOpen(gateState) ? openInstallToken.mint() : null
    });
  }
  jsonResponse(res, 200, {
    authenticated: true,
    gateActive,
    gateState,
    username: session.username,
    csrfToken: session.csrfToken,
    openInstallToken: null
  });
});

// GET /api/auth/credential — what the settings surface may offer, and why not.
//
// Answered BEFORE the operator types anything, so the form is never rendered for
// an install that cannot use it. The refusal reasons are the same ones the POST
// returns, from the same predicate, so the two can never disagree about a machine
// between rendering the form and submitting it — the failure this chunk's sibling
// (the wizard step list) already had to fix once.
route('GET', '/api/auth/credential', (req, res) => {
  const config = store.config.load();
  const ingressState = caddy.classifyIngressState();
  const check = adminCredential.canChangeCredential(
    config, ingressState, caddy.detectCaddy().available,
    adminCredential.isLoopbackRemote(req.socket && req.socket.remoteAddress),
    req.tcGateState);
  jsonResponse(res, 200, {
    changeable: check.allowed,
    // Same spelling the POST's refusal uses, from the same translator — a client
    // comparing the two must never see one state under two names.
    code: adminCredential.httpCode(check.code),
    reason: check.reason,
    remedy: check.remedy,
    // The username currently in force, read from the FILE rather than from
    // config, because the change itself resolves its target from the file and the
    // two can drift (ADR 0009's amendment names that state). Showing config's
    // copy would name one account in the form and re-hash a different one.
    // Never the hash: it is a credential, and the redacted config API withholds
    // it for the same reason.
    user: check.allowed ? ingressState.user : null
  });
});

// POST /api/auth/credential — change the admin username/password after setup.
//
// The ONLY route that writes a credential outside first-run setup and the
// terminal recovery tool. `PATCH /api/config` deliberately no longer accepts
// these fields: a guarded front door beside an unguarded side one is not a gate,
// and that side door was reachable unauthenticated on an ungated install.
//
// It may CHANGE a credential and never create or blank one. Creating is recovery
// and belongs at a terminal, because a reset that lives behind the gate cannot
// help someone the gate has locked out; blanking would be a second route to "no
// password", and the Direction allows exactly one.
//
// There is no "current password" field, and its absence is a finding rather than
// an oversight: `caddy hash-password` has no verify mode and no `--salt`, so a
// stored bcrypt hash cannot be reproduced for comparison, and Node's stdlib has
// no bcrypt. The server cannot check a typed current password, and a field that
// does not verify is theatre. What authenticates this request is that Caddy
// already did — which is exactly why the guard below refuses whenever no gate is
// in force.
route('POST', '/api/auth/credential', (req, res, _params, body) => {
  // parseBody resolves null for an empty request, so every field read below would
  // throw on a bodyless POST — a 500 that reads as "the server broke" for what is
  // simply a malformed request.
  const payload = body || {};
  const config = store.config.load();
  const ingressState = caddy.classifyIngressState();
  // Both routes ask the same predicate the same way, including the socket — a
  // GET that discloses the username to a caller the POST would refuse is the
  // client-vs-server disagreement this surface already had to fix once.
  const check = adminCredential.canChangeCredential(
    config, ingressState, caddy.detectCaddy().available,
    adminCredential.isLoopbackRemote(req.socket && req.socket.remoteAddress),
    req.tcGateState);
  if (!check.allowed) {
    return errorResponse(res, 409, `${check.reason} ${check.remedy}`, adminCredential.httpCode(check.code));
  }

  // The username is NOT changeable here, and the field is read-only in the UI for
  // the same reason: `caddy.replaceBasicAuthCredential` takes a username as a
  // SELECTOR of which credential line to re-hash, and writes back the matched
  // name. A rename would therefore leave the gate on the old username while config
  // recorded the new one — a config-vs-gate divergence, which is the failure this
  // whole chunk exists to prevent. Renaming is a `reset-admin.js` job.
  //
  // Resolved from the LIVE FILE rather than from config, because those two drift
  // (ADR 0009's amendment names that state) and the file is what the gate
  // enforces. A caller sending a different name is refused, not obeyed.
  const user = typeof payload.user === 'string' ? payload.user.trim() : '';
  if (payload.user !== undefined && !user) {
    return errorResponse(res, 400, 'A username is required', 'BAD_REQUEST');
  }
  const password = typeof payload.password === 'string' ? payload.password : '';
  // Validated against the username IN FORCE, not the one the caller sent. The UI
  // deliberately sends no `user` — the field is read-only and the server resolves
  // the target itself — so validating against the request's copy left the
  // no-username-in-password rule inert on every request the product actually
  // makes. Setup enforces that rule; a change surface that did not would let the
  // rule be escaped simply by changing the password afterwards.
  //
  // From the FILE, for the same reason the GET reads the file: config and the
  // live gate drift (ADR 0009's amendment names that state), and the guard above
  // requires both to be non-empty without requiring them to AGREE. Taking
  // config's copy would check the password against a name that is not the login
  // in force — accepting, in exactly the drift case, a password containing the
  // real username that setup would have refused.
  const pwCheck = caddy.validateAdminPassword(password, user || ingressState.user);
  if (!pwCheck.ok) {
    return errorResponse(res, 400, pwCheck.error, 'BAD_REQUEST');
  }

  let hash;
  try {
    hash = caddy.hashPassword(password);
  } catch (err) {
    // Never the plaintext; the message is the caddy failure, not the secret.
    log.error('Admin credential hashing failed', { error: err.message });
    return errorResponse(res, 500, `Could not hash the password: ${err.message}`, 'HASH_FAILED');
  }

  const result = adminCredential.applyCredentialChange({
    caddyfilePath: caddy.getCaddyfilePath(),
    // Undefined when the caller sent none: the module then resolves the single
    // credential in the file itself.
    user: user || undefined,
    hash,
    uid: process.getuid(),
    stamp: new Date().toISOString().replace(/[:.]/g, '-'),
    // The reply to this request travels back through the very Caddy that has to
    // restart, so restarting it first tears down the connection carrying the
    // reply: the change succeeds and the browser is told the network failed.
    // Deferred to after the response is flushed, below.
    reload: false
  });

  if (result.code === adminCredential.CREDENTIAL_CODES.RENAME_UNSUPPORTED) {
    // Nothing was written. Says which name IS in force, because the caller's whole
    // problem is that it disagrees with what they sent.
    return errorResponse(res, 400,
      `The username cannot be changed here — ${result.error}. `
      + 'Run `node scripts/reset-admin.js` at a terminal to change it.',
      adminCredential.httpCode(result.code));
  }
  if (result.code === adminCredential.CREDENTIAL_CODES.DIVERGED) {
    // The gate carries the NEW password and config still records the old one, and
    // the restore that should have undone it failed too. Says which password is
    // live, because that is the one thing the operator needs in the next minute.
    log.error('Admin credential change left the gate and config disagreeing',
      { error: caddy.redactHashes(result.error) });
    return errorResponse(res, 500,
      'The new login was written to Caddy but could not be recorded, and the previous '
      + 'Caddy config could not be put back. The NEW password is the one in force. '
      + 'Run `node scripts/reset-admin.js` at a terminal on this machine to settle it.',
      adminCredential.httpCode(result.code));
  }
  if (result.code === adminCredential.CREDENTIAL_CODES.GATE_BROKEN) {
    // The credential did not change — but the write that failed could not be
    // undone either, so the live Caddyfile is whatever it left behind and may not
    // load. "Nothing was changed" would be true about the password and dangerously
    // misleading about the ingress, on the one path where the operator is about to
    // lose the dashboard entirely.
    log.error('The Caddyfile could not be written or restored; the live gate may be broken',
      { error: caddy.redactHashes(result.error), backup: result.backup });
    return errorResponse(res, 500,
      'Your login was NOT changed, but the Caddy config could not be written or put back, so the '
      + `ingress may now be broken. A copy of the original is at ${result.backup} — restore it at a `
      + 'terminal on this machine, or run `node scripts/reset-admin.js`.',
      adminCredential.httpCode(result.code));
  }
  if (!result.ok) {
    // The gate and the recorded credential are both untouched — applyCredentialChange
    // restores the original before returning, whether the write was rejected by
    // `caddy validate` or the config could not be recorded afterwards. Redacted
    // for the same reason the cutover's is: `caddy validate` output quotes the
    // offending line, and that line carries a hash.
    log.warn('Admin credential change did not complete; nothing was changed',
      { code: result.code, error: caddy.redactHashes(result.error) });
    // Three failures that all leave the login unchanged, said three ways, because
    // they send the operator to three different places. Blaming Caddy's parser
    // for a full disk is a false report of the same family as the rest.
    const CODES = adminCredential.CREDENTIAL_CODES;
    const detail = {
      [CODES.CONFIG_WRITE_FAILED]: 'The new login could not be recorded, so nothing was changed.',
      [CODES.WRITE_FAILED]: 'The Caddy config could not be written, so nothing was changed. '
        + 'This is usually a full disk or a permissions problem, not the password.'
    }[result.code] || 'The new login was rejected by Caddy, so nothing was changed.';
    return errorResponse(res, 400, detail, adminCredential.httpCode(result.code));
  }

  log.info('Admin credential changed; reloading Caddy once this response is out',
    { user: result.user });

  // The restart is hung off `finish` — after the response has left this process —
  // and never before it. What cannot be reported is the reload's OUTCOME: by the
  // time it is known, every further request needs the new password, so there is no
  // response left to carry it. That is why `reloadCommand` ships unconditionally
  // rather than only on failure: it is the operator's recourse for the one case
  // this route cannot tell them about, a restart that did not happen.
  // Asynchronous, because a synchronous restart here holds the event loop for as
  // long as launchd takes — every unrelated request queued behind a Caddy restart.
  // `close`, not `finish`: finish fires only when the response was fully sent, so
  // a client that aborts mid-reply would leave the credential changed on disk and
  // Caddy never reloaded — the old password still opening the door, with nothing
  // reporting it. close fires either way, and after finish when both do.
  res.on('close', () => {
    adminCredential.reloadCaddyAsync(process.getuid(), (reload) => {
      if (reload.ok) {
        log.info('Caddy reloaded; the new login is in force');
      } else {
        log.error('Caddy could not be reloaded, so the OLD login is still in force',
          { error: reload.error, reloadCommand: reload.command });
      }
    });
  });

  jsonResponse(res, 200, {
    ok: true,
    // The name the GATE carries, which is authoritative — not the one that was sent.
    user: result.user,
    // The change is on disk and Caddy restarts as this response leaves, so the
    // next request is challenged. Unconditional now, and honestly so: it is a
    // statement about what has been done, not a claim about a restart this
    // response is racing.
    signedOut: true,
    // What to run if the sign-in prompt never comes — the only symptom the
    // operator can observe of a reload that failed after this reply was sent.
    reloadCommand: result.reloadCommand
  });
});

// GET /api/service-token — reveal the raw fleet token for the Settings
// "reveal" display. 404 when the gate is off or no token is set (nothing to
// reveal); the redacted config API never carries the raw value.
route('GET', '/api/service-token', (_req, res) => {
  const config = store.config.load();
  if (!config.serviceTokenEnabled || !config.serviceToken) {
    return errorResponse(res, 404, 'No service token is configured', 'NO_SERVICE_TOKEN');
  }
  jsonResponse(res, 200, { token: config.serviceToken });
});

// POST /api/service-token/rotate — generate + persist a NEW fleet token and
// return it. Only meaningful while the gate is active, so guard on enabled
// (mirrors reveal). Re-injected into every project at the next session launch;
// live sessions holding the old token break until relaunch — documented.
route('POST', '/api/service-token/rotate', (_req, res) => {
  const config = store.config.load();
  if (!config.serviceTokenEnabled) {
    return errorResponse(res, 409, 'Enable the service token gate before rotating', 'SERVICE_TOKEN_DISABLED');
  }
  config.serviceToken = serviceToken.generateToken();
  store.config.save(config);
  log.info('AUTH-4 service token rotated');
  jsonResponse(res, 200, { token: config.serviceToken });
});

// The setup routes are registered from their own module, at the position they
// held; the credential decision, the ingress door reader and the sign-in helper
// the handlers use still live here and are handed over.
setupRoutes.register({ _decideSetupCredential, _gateIngress, _signIn });

// GET /api/rules/global
route('GET', '/api/rules/global', (_req, res) => {
  const content = store.globalRules.load();
  jsonResponse(res, 200, { content });
});

// PUT /api/rules/global
// #212 — bumped body cap to 256 KB. The default MAX_BODY_SIZE of 10 KB
// was below the size of the canonical bundled `data/global-rules.md`
// (14 KB and growing as new conventions land), so every PUT — whether
// from the landing-page editor or the API — was returning 413. 256 KB
// gives ~18x headroom over current size; even a 10x growth in the
// ruleset stays well under the limit. Other large-body routes use the
// same per-route override pattern — see `/api/audit/ingest` at the
// 512 KB cap (`server.js:2834`) and the upload route at 15 MB
// (`server.js:1574`).
route('PUT', '/api/rules/global', (req, res, _params, body) => {
  // The document binds every project on the install. A Builder may draft or
  // propose its text; applying it is the operator's.
  if (!operatorProjectCaller(req, res, 'change the global rules')) return;
  if (typeof body.content !== 'string') {
    return errorResponse(res, 400, 'content (string) is required', 'BAD_REQUEST');
  }
  store.globalRules.save(body.content);
  jsonResponse(res, 200, { ok: true });
}, { maxBodySize: 256 * 1024, signedInOperator: { action: 'change the global rules' } });

// POST /api/rules/global/reset
route('POST', '/api/rules/global/reset', (req, res) => {
  // A no-op today, but its intent is privileged: it stays the operator's so a
  // future implementation inherits the gate rather than having to add one.
  if (!operatorProjectCaller(req, res, 'reset the global rules')) return;
  const content = store.globalRules.reset();
  jsonResponse(res, 200, { content });
}, { signedInOperator: { action: 'reset the global rules' } });

// ── Session Rules API (#347/D1a) ──
// Durable operator/AI-authored per-project behavioral directives. 'startup'
// rules inject cross-model at session launch; 'wrap' rules inject into the
// wrap pipeline's ai-content prompt. Persisting a rule does NOT force a
// config regen — configs pick it up on next session launch / syncAllProjects,
// identical to how global-rules edits propagate today. Rules are always
// project-scoped: the hidden global tier (projectId omitted) was retired —
// cross-project directives belong in the Global rules document
// (`/api/rules/global` → data/global-rules.md).

/**
 * Validate a request-supplied projectId and resolve it to the numeric id the
 * store keys on (#1121). An unknown id — typically the project's NAME, which
 * every /api/sessions/:project route accepts, so it is the natural mistake —
 * used to either match nothing (a silent empty list, indistinguishable from a
 * project with no rules) or die on the FK constraint as a bare 500. On failure
 * this writes the 400 INVALID_PROJECT_ID response and returns null; callers
 * just return.
 * @param {import('node:http').ServerResponse} res - Response to write the 400 to on failure
 * @param {*} raw - The caller-supplied projectId (query string or body value)
 * @returns {number|null} The validated numeric id, or null when the response was already written
 */
function requireNumericProjectId(res, raw) {
  const pid = Number(raw);
  if (Number.isInteger(pid) && store.projects.get(pid)) return pid;
  errorResponse(res, 400,
    `unknown projectId ${JSON.stringify(raw)} — pass the project's numeric id (see GET /api/projects), not its name`,
    'INVALID_PROJECT_ID');
  return null;
}

// GET /api/session-rules — list (optional ?projectId= / ?kind=)
route('GET', '/api/session-rules', (req, res) => {
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);
  const options = {};
  if (query.projectId !== undefined) {
    const pid = requireNumericProjectId(res, query.projectId);
    if (pid === null) return;
    options.projectId = pid;
  }
  // CC-6 (#381): filter the per-project modal's rule boxes by kind.
  if (query.kind !== undefined) options.kind = query.kind;
  // #569: review state. Unfiltered by default; the Project Rules modal fetches
  // unfiltered and renders proposals with a "Proposed" badge (rejections it
  // drops client-side — a rejected row is a decision record, not a rule).
  if (query.status !== undefined) options.status = query.status;
  const rules = store.sessionRules.list(options);
  jsonResponse(res, 200, { rules });
});

// GET /api/session-rules/deliveries — the #595 delivery ledger. Answers "did
// session X receive rule set Y" (?sessionId=) and "is this project actually
// receiving its rules" (?projectId=, newest first). Undelivered attempts are
// included on purpose: an empty-looking project and a severed channel must be
// distinguishable, which is the failure this ledger exists to expose.
route('GET', '/api/session-rules/deliveries', (req, res) => {
  const query = parseQuery(reqUrl(req).search);
  if (query.sessionId !== undefined) {
    return jsonResponse(res, 200, { deliveries: store.sessionRuleDeliveries.listForSession(Number(query.sessionId)) });
  }
  if (query.projectId !== undefined) {
    const options = {};
    if (query.limit !== undefined) options.limit = Number(query.limit);
    return jsonResponse(res, 200, { deliveries: store.sessionRuleDeliveries.listForProject(Number(query.projectId), options) });
  }
  // No scope given → the fleet-wide health answer: every project that HAS
  // startup rules but has never had one delivered. This is #595's original
  // question, and it needs no argument to be worth asking.
  return jsonResponse(res, 200, { undelivered: store.sessionRuleDeliveries.projectsWithUndeliveredRules() });
});

// GET /api/launch-sequences?projectId= — the readiness evidence for a project's
// recent launches (Train 21, #1583).
//
// Three kinds of evidence, side by side and never merged (plan §2.5): the
// rule-delivery ledger's own row for the prime channel, what the sequence
// SERVED, and what the session ACKNOWLEDGED and attested. They answer different
// questions and no one of them upgrades another — a hook receipt proves a hook
// ran in a directory, not which session's rules landed, which is why a pulled
// sequence keeps its own record.
route('GET', '/api/launch-sequences', (req, res) => {
  const query = parseQuery(reqUrl(req).search);
  const projectId = Number(query.projectId);
  if (!Number.isInteger(projectId)) {
    return errorResponse(res, 400, 'projectId is required (the project\'s numeric id)', 'BAD_REQUEST');
  }
  const limit = query.limit === undefined ? 5 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return errorResponse(res, 400, 'limit must be a whole number between 1 and 50', 'BAD_REQUEST');
  }
  // The startupControl block (#1825 B3, Architect F5) is the operator's and the
  // Master's to read: it carries every fire row, `denied` ones included, and a
  // denied row names the project that tried. Served to a project-bound or
  // unbound caller it would be the cross-group oracle D4 forbids, so those get
  // the rows without it. Only the operator may FIRE (the route proves that
  // itself); `fireable` is computed here so the panel renders the button for
  // exactly the row it can act on.
  const access = sharedDocsAccess.resolveAccess(req);
  const readsStartupControl = access.kind === sharedDocsAccess.KINDS.OPERATOR || access.kind === sharedDocsAccess.KINDS.MASTER;
  const sequences = store.launchSequences.listForProject(projectId, limit).map((sequence) => {
    const steps = store.launchSequences.listSteps(sequence.id, sequence.revision);
    // The rule-delivery row for this same session, so the panel can put the two
    // channels beside each other. Looked up per sequence rather than joined: the
    // ledger is keyed by session, and a session may have no row at all, which is
    // a fact to show rather than a row to invent.
    const rulesRow = store.sessionRuleDeliveries.listForSession(sequence.sessionId)[0] || null;
    // The pointer paste's own outcome (#1597): a pull-pointer launch's prime
    // carries no rule text, so it writes no `rulesDelivery` row for the paste
    // itself — this is kept in `activity_log` instead, and is simply absent
    // for every other launch, which is why a missing row here means null
    // rather than "unverified".
    const pasteOutcomeRow = store.activity.query({
      sessionId: sequence.sessionId, eventType: sessions.POINTER_PASTE_OUTCOME_EVENT, limit: 1
    })[0] || null;
    return {
      sequenceId: sequence.id,
      sessionId: sequence.sessionId,
      revision: sequence.revision,
      applicability: sequence.applicability,
      notApplicableReason: sequence.notApplicableReason,
      createdAt: sequence.createdAt,
      cursor: sequence.cursor,
      of: steps.length,
      readyAt: sequence.readyAt,
      unreadyAt: sequence.unreadyAt,
      nudgeCount: sequence.nudgeCount,
      lastNudgedAt: sequence.lastNudgedAt,
      // The unready monitor's latest tick read for this launch (#1596), one of
      // `launch-unready.js`'s `VERDICT_MEANINGS` codes; null before its first tick.
      lastUnreadyVerdict: sequence.lastUnreadyVerdict,
      lastUnreadyVerdictAt: sequence.lastUnreadyVerdictAt,
      // Recovery, as five separate facts rather than one word. The panel has to
      // say which of the three clearances it was — an open install's clear is
      // never shown as an operator's — and it has to know the mode, because a
      // `required` advisory launch clears itself and offers the operator
      // nothing to do, while a `required` operator launch is waiting on them.
      recovery: sequence.recovery,
      recoveryMode: sequence.recoveryMode,
      recoveryRevision: sequence.recoveryRevision,
      recoveryClearance: sequence.recoveryClearance,
      recoveryClearedAt: sequence.recoveryClearedAt,
      recoveryClearedBy: sequence.recoveryClearedBy,
      // Whether this launch's session is still active, by the clear route's own
      // judgement. A launch whose session has ended is refused there as
      // `SESSION_ENDED`, so the panel needs this to stop offering that clear.
      sessionActive: launchRecoveryClear.sessionIsActive(store.sessions.get(sequence.sessionId)),
      preflightVerdict: (sequence.preflight && sequence.preflight.verdict) || null,
      // The verdict WORD alone asks someone to grant `operator-verified` against
      // a cause they cannot see — "Recovery required: not-evaluated" beside a
      // Clear button. The reason says what happened, and the two provenance
      // flags say where to look for it: `evaluationFailed` means this machine's
      // server log names the error, `evaluationMissing` means no evaluation
      // reached the launch at all, so there is no log to find.
      preflightReason: (sequence.preflight && sequence.preflight.reason) || null,
      preflightEvaluationFailed: !!(sequence.preflight && sequence.preflight.evaluationFailed),
      preflightEvaluationMissing: !!(sequence.preflight && sequence.preflight.evaluationMissing),
      // Read from the measured predicate, never the verdict word (#1623): a
      // `not-applicable` row's `recovery` is always `'none'`, so this is the
      // only signal the panel has that its handoff was damaged anyway.
      preflightRequiresRecovery: !!(sequence.preflight && sequence.preflight.requiresRecovery),
      // Named `rulesDelivery`, not `hook`: the row it comes from records
      // whichever channel the prime used for the rule text — the startup hook,
      // a paste, or the deliberate skip a pulled launch writes. Calling it the
      // hook labelled three different facts with one of their names.
      rulesDelivery: rulesRow
        ? { outcome: rulesRow.outcome, channel: rulesRow.channel, skipReason: rulesRow.skipReason || null }
        : null,
      // The paste's own fate, shown beside `rulesDelivery` rather than inside
      // it — the activity-log detail already carries exactly the shape
      // `launchPasteOutcomeHtml` (public/ui.js) reads.
      pasteOutcome: pasteOutcomeRow ? pasteOutcomeRow.detail : null,
      // Which path put this launch's context in front of the engine (#1825 B3):
      // `native` means the startup prompt was fired through the engine's own
      // channel and nothing was typed into the pane; `legacy` is the paste or
      // the kickoff. Every caller may read it — it names no other project.
      startupDelivery: sequence.startupDelivery,
      steps: steps.map((st) => ({
        index: st.index,
        id: st.id,
        pageCount: st.pageCount,
        pagesServed: st.pagesServed.length,
        servedAt: st.servedAt,
        ackedAt: st.ackedAt,
        carriedFromRevision: st.carriedFromRevision
      })),
      ...(readsStartupControl ? { startupControl: _startupControlForLaunch(sequence, access) } : {})
    };
  });
  // #1937: each row carries the mode its launch FROZE; this is the project's
  // CURRENT setting beside them, so a reader can tell a launch that started in
  // operator mode from a project that is operator now (the setting applies from
  // the next launch). It is a live read, separate from any launch's frozen
  // one. Every field is `null` for a project this install does not have: no
  // mode is not the default mode.
  return jsonResponse(res, 200, { sequences, ...launchSequence.projectRecoveryNow(projectId) });
});

/**
 * The startupControl evidence of one launch, for the launch panel (#1825 B3).
 *
 * The channel's generic header only — never `adapterState`, which is the
 * adapter's and may name a socket or a pid (E2/S4) — and every fire row the
 * launch's session has, newest first, `denied` included, with the
 * bounded fields the panel reads. `fireable` is true only when the caller is
 * the operator, the session is active and the channel is open: the exact row
 * the Fire button can act on. The Master reads and never fires (D4).
 * @param {object} sequence - A launch-sequence row.
 * @param {{kind: string}} access - The resolved caller.
 * @returns {{channel: (object|null), fires: object[], fireable: boolean}}
 */
function _startupControlForLaunch(sequence, access) {
  const channelRow = store.startupControlChannels.getLatestBySession(sequence.sessionId);
  const channel = channelRow
    ? {
      state: channelRow.state,
      adapter: channelRow.adapter,
      engineId: channelRow.engineId,
      openedAt: channelRow.openedAt,
      closedAt: channelRow.closedAt,
      closeReason: channelRow.closeReason,
      teardown: channelRow.teardown
    }
    : null;
  const fires = store.startupPrompts.firesForSession(sequence.sessionId).map((f) => ({
    id: f.id,
    sequenceId: f.sequenceId,
    outcome: f.outcome,
    reasonCode: f.reasonCode,
    reason: f.reason,
    callerKind: f.callerKind,
    callerClearance: f.callerClearance,
    callerProjectId: f.callerProjectId,
    promptRevision: f.promptRevision,
    createdAt: f.createdAt,
    acceptedAt: f.acceptedAt,
    settledAt: f.settledAt,
    // What the fire was sent despite (#2186); null on every other fire.
    dispatchNote: f.dispatchNote || null
  }));
  const session = store.sessions.get(sequence.sessionId);
  const fireable = access.kind === sharedDocsAccess.KINDS.OPERATOR
    && launchRecoveryClear.sessionIsActive(session)
    && !!channel && channel.state === 'open';
  return { channel, fires, fireable };
}

// The tc routes are registered from their own module, at the position the
// family's first route held; the activity observer the lane composition reads
// still lives here and is handed over.
tcRoutes.register({ activityObserver });

// The operator bridge's HTTP surface (ADR 0023, #2031). Three callers, each
// with its own proof and none standing in for another; `lib/bridge-api.js`
// holds the handlers.

/** How often the operator bridge's gateway runs its pass: often enough that a route never waits long on it, rarely enough to cost nothing while idle. */
const BRIDGE_TICK_MS = 15 * 1000;

// Each route is declared in `lib/bridge-api.js` with the principal it belongs
// to, and `bridgeApi.handle` proves that principal before the handler runs.
// The fleet-idle notification reads the same lane composition the fleet roster
// does, so the two cannot disagree about whether a lane is clear. Wired where
// the routes are, not at boot, so anything that loads the server has it.
bridgeNotify.setLaneReader(() => bridgeNotify.readLanes(_composedLane));
// Which pane verbs the operator has switched on. Read from the bridge's own
// settings each time a pane's instructions are written.
require('./lib/ecosystem-primer').setSwitchReader(() => (bridgeApi.candidatesPrimed() ? ['bridge-candidates'] : []));

for (const entry of bridgeApi.ROUTES) {
  route(entry.method, entry.path, async (req, res, params, body) => {
    const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    const result = await bridgeApi.handle(entry, { req, headers: req.headers, params, query, body });
    return jsonResponse(res, result.status, result.body);
  }, { ownPrincipal: bridgeApi.provesOwnPrincipal(entry) });
}

// GET /api/bridge/session/candidates[/:candidateId] (#2214): a session's own
// read of what became of the candidates it submitted. Mounted outside
// `bridgeApi.ROUTES` and `bridgeApi.handle` — these two routes answer even
// while the operator bridge is disabled, since a session's own history does
// not depend on whether Discord delivery is currently switched on.
require('./lib/bridge-candidates').registerRoutes({ route, jsonResponse });

// GET /api/launch/isolation — for every live session and the Project Master,
// whether the command its pane was started with shows it was kept off its
// engine's shared background process (#2233). A launch is judged as it starts;
// this is the same question asked of sessions that were already running.
// `?replaced=<session ids>` adds, for each earlier session, whether it has
// ended and its project's current session reads isolated. Read-only: it ends
// and restarts nothing. One tmux invocation per request, so it is asked by
// hand and not polled. It names every project, so it answers the operator,
// the Master and a verified project session, and refuses anyone else in the
// write floor's words.
route('GET', '/api/launch/isolation', async (req, res) => {
  const access = sharedDocsAccess.resolveAccess(req);
  if (access.kind !== sharedDocsAccess.KINDS.OPERATOR && access.kind !== sharedDocsAccess.KINDS.MASTER) {
    const described = launchBindingGuard.describeBinding(req);
    if (described.state !== launchBindingGuard.BINDING_STATES.VERIFIED) {
      const refusal = launchBindingGuard.refusalFor(described);
      return errorResponse(res, refusal.status, refusal.message, refusal.code);
    }
  }
  const raw = reqUrl(req).searchParams.get('replaced');
  const asked = raw === null ? null : launchIsolationInventory.parseSessionIds(raw);
  if (asked && !asked.ok) {
    return errorResponse(res, 400, '`replaced` is a comma-separated list of session ids, for example ?replaced=1373,1380', 'BAD_REQUEST');
  }
  try {
    const inv = await launchIsolationInventory.inventory();
    jsonResponse(res, 200, asked ? { ...inv, replaced: launchIsolationInventory.verifyReplaced(asked.ids, inv) } : inv);
  } catch (err) { // prawduct:allow prawduct/broad-except -- a store or tmux fault answers 500 with no verdicts, never a partial list that reads as the whole fleet
    log.error('The launch-isolation inventory could not be read', { error: err.message });
    errorResponse(res, 500, 'The launch-isolation inventory could not be read just now. No session was judged.', 'INTERNAL_ERROR');
  }
});

/**
 * The launch-isolation override settings as the operator's routes answer
 * them: the install-wide override, and each project whose own is on.
 * @returns {{install: {allowed: boolean, setAt: (string|null), setBy: (string|null)}, projects: Array<{projectId: number, projectName: (string|null), allowed: boolean, setAt: string, setBy: (string|null)}>}}
 */
function _launchIsolationOverrideSettings() {
  const { install, projects } = store.launchIsolationOverrides.list();
  return {
    install: { allowed: Boolean(install), setAt: install ? install.setAt : null, setBy: install ? install.setBy : null },
    projects: projects.map((row) => {
      const project = store.projects.get(row.projectId);
      return { projectId: row.projectId, projectName: project ? project.name : null, allowed: true, setAt: row.setAt, setBy: row.setBy };
    })
  };
}

/**
 * Turn a launch-isolation override on or off for the operator and answer the
 * settings as they then stand. The caller has already been admitted as the
 * operator. A store fault answers 500 with no settings, and does not say
 * whether the write landed: the caller reads them again.
 * @param {http.IncomingMessage} req - The request
 * @param {http.ServerResponse} res - The response
 * @param {number|null} projectId - The project, or null for the install-wide override
 * @param {boolean} on - Whether to turn it on
 * @returns {void}
 */
function _writeLaunchIsolationOverride(req, res, projectId, on) {
  const by = (req.tcSession && req.tcSession.username) || null;
  try {
    const result = on
      ? store.launchIsolationOverrides.set({ projectId, setBy: by })
      : store.launchIsolationOverrides.clear({ projectId, clearedBy: by });
    if (result.changed) {
      log.warn(on ? 'Launch-isolation override turned on' : 'Launch-isolation override turned off', {
        scope: projectId === null ? 'install' : 'project', projectId, by
      });
    }
    jsonResponse(res, 200, _launchIsolationOverrideSettings());
  } catch (err) { // prawduct:allow prawduct/broad-except -- a store fault answers 500 with no settings, never an answer that may not be what is stored
    if (err.code === 'NOT_FOUND') return errorResponse(res, 404, err.message, 'NOT_FOUND');
    log.error('A launch-isolation override could not be written', {
      scope: projectId === null ? 'install' : 'project', projectId, on, error: err.message
    });
    errorResponse(res, 500, 'The launch-isolation override could not be saved or read back just now. Read the settings again before retrying.', 'INTERNAL_ERROR');
  }
}

/**
 * The project a launch-isolation override route names, after the operator has
 * been admitted: 400 for a segment that is not a numeric id, 404 for an id no
 * project has.
 * @param {http.ServerResponse} res - The response, written only on refusal
 * @param {string} segment - The `:id` path segment
 * @returns {number|null} The project id, or null when the request was answered
 */
function _launchIsolationOverrideProject(res, segment) {
  if (!/^[1-9]\d{0,15}$/.test(String(segment))) {
    errorResponse(res, 400, 'A project is named here by its numeric id, for example /api/launch/isolation-overrides/projects/12', 'BAD_REQUEST');
    return null;
  }
  const projectId = Number(segment);
  if (!store.projects.get(projectId)) {
    errorResponse(res, 404, `No project has the id ${projectId}.`, 'NOT_FOUND');
    return null;
  }
  return projectId;
}

// Turning a launch-isolation override on allows a launch that may borrow
// another project's identity, so it asks for a signed-in operator (see
// `_requireSignedInOperator`). These routes shipped with their own refusal,
// answered 403 in every no-login state, fallback included, and they keep it.
const ISOLATION_OVERRIDE_SIGN_IN = Object.freeze({
  action: 'turn a launch-isolation override on',
  logLine: 'Turning a launch-isolation override on was refused: no signed-in operator',
  refusal: 'A launch-isolation override can be turned on only by a signed-in operator, and this request '
    + 'carries no sign-in: with no login in force nothing would establish that the sender is the operator. Turn '
    + 'TangleClaw\'s login on, sign in, and turn the override on again. Nothing was changed. Reading the overrides '
    + 'and turning one off need no sign-in.'
});

// The launch-isolation overrides (#2229): the operator's allowance to start an
// engine that could not be shown to be kept off its shared background process,
// for the whole install or for one project. Such a launch may borrow another
// project's identity, so who may grant it is the whole design: every route
// here, the read included, admits the operator alone and refuses before any
// lookup, and turning one on also needs the operator to be signed in. A
// session reads what applies to it from the launch record
// (`GET /api/launch/isolation`), never from these settings.
route('GET', '/api/launch/isolation-overrides', (req, res) => {
  if (!operatorProjectCaller(req, res, 'read the launch-isolation overrides')) return;
  try {
    jsonResponse(res, 200, _launchIsolationOverrideSettings());
  } catch (err) { // prawduct:allow prawduct/broad-except -- a store fault answers 500, never a partial list that reads as every override that is on
    log.error('The launch-isolation overrides could not be read', { error: err.message });
    errorResponse(res, 500, 'The launch-isolation overrides could not be read just now.', 'INTERNAL_ERROR');
  }
});

route('PUT', '/api/launch/isolation-overrides/install', (req, res) => {
  if (!operatorProjectCaller(req, res, 'turn on the install-wide launch-isolation override')) return;
  _writeLaunchIsolationOverride(req, res, null, true);
}, { signedInOperator: ISOLATION_OVERRIDE_SIGN_IN });

route('DELETE', '/api/launch/isolation-overrides/install', (req, res) => {
  if (!operatorProjectCaller(req, res, 'turn off the install-wide launch-isolation override')) return;
  _writeLaunchIsolationOverride(req, res, null, false);
});

route('PUT', '/api/launch/isolation-overrides/projects/:id', (req, res, params) => {
  if (!operatorProjectCaller(req, res, 'turn on a project\'s launch-isolation override')) return;
  const projectId = _launchIsolationOverrideProject(res, params.id);
  if (projectId === null) return;
  _writeLaunchIsolationOverride(req, res, projectId, true);
}, { signedInOperator: ISOLATION_OVERRIDE_SIGN_IN });

route('DELETE', '/api/launch/isolation-overrides/projects/:id', (req, res, params) => {
  if (!operatorProjectCaller(req, res, 'turn off a project\'s launch-isolation override')) return;
  const projectId = _launchIsolationOverrideProject(res, params.id);
  if (projectId === null) return;
  _writeLaunchIsolationOverride(req, res, projectId, false);
});

// GET /api/checkouts — the fleet's checkouts in one answer (#1678, #993): one
// row per project with a live session, from the same `projectCheckout` the
// project route, the prime and the session chip read, so the PM, the Master, a
// Builder and the operator cannot compute different answers. Shaped per caller
// by `lib/checkout-fleet.js`. An unbound caller is answered with no rows and
// the reason; a binding that was presented and not honoured is refused, so a
// broken binding never reads as an empty fleet. Cached; never waits on git.
route('GET', '/api/checkouts', (req, res) => {
  const access = sharedDocsAccess.resolveAccess(req);
  if (access.kind === sharedDocsAccess.KINDS.INVALID) {
    log.warn('Checkouts read with a binding that was not honoured; refused', {
      reason: access.reason,
      cause: access.cause || null,
      claimedProjectId: req.headers[sharedDocsAccess.PROJECT_HEADER] || null,
      claimedRole: req.headers[sharedDocsAccess.ROLE_HEADER] || null
    });
    const refusal = sharedDocsAccess.projectRefusalFor(access, sharedDocsAccess.NEEDS.OWN_PROJECT);
    return errorResponse(res, refusal.status, refusal.message, refusal.code);
  }
  jsonResponse(res, 200, checkoutFleet.fleetView(access, { config: store.config.load() }));
});

// GET /api/awareness — "sessions that never became aware" as a queryable
// surfaced state (ambient-awareness Chunk 05). Per project, the most recent
// sessions each carry a composed awareness state (confirmed / sent /
// unverified / no-rules / unaware) with a `basis` saying in words what the state rests
// on. The dashboard polls it; the Project Master queries it — the surface the
// 2026-08-18 carrier regression lacked.
route('GET', '/api/awareness', (req, res) => {
  const perRaw = Number(reqUrl(req).searchParams.get('sessionsPerProject'));
  const projects = store.awarenessReceipts.fleetAwareness(
    Number.isInteger(perRaw) && perRaw > 0 ? { sessionsPerProject: perRaw } : {}
  );
  jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    states: {
      confirmed: 'the session invoked tc itself — awareness demonstrated',
      sent: 'a channel was observed to deliver; nothing was demonstrated',
      unverified: 'something was put on the channel and nothing confirmed the far side — a blind send, or rule shards whose engine hook never posted its receipt',
      'no-rules': 'the launch path ran; the project had no rules to deliver — nothing was owed',
      unaware: 'no evidence awareness ever arrived — the red state',
      'not-running': 'no Master session is running — nothing launched, nothing to be aware (master only)',
      unknown: 'tmux could not answer for the Master — said so rather than guessed (master only)'
    },
    master: master.getMasterAwareness(),
    projects
  });
});

// GET /api/medusa/deliveries — the fleet-wide Switchboard answer (#792): every
// participant whose newest inbox edge was NOT nudged, oldest silence first.
// `?sessionId=` narrows to one participant's history instead.
//
// This is the query that would have caught every miss on 2026-07-30 without a
// human noticing a badge: an inbox with unread mail and a session that was
// never woken are the same thing from outside, and this route is what tells
// them apart.
route('GET', '/api/medusa/deliveries', (req, res) => {
  const query = parseQuery(reqUrl(req).search);
  if (query.sessionId !== undefined) {
    const options = {};
    if (query.limit !== undefined) options.limit = Number(query.limit);
    return jsonResponse(res, 200, { deliveries: store.medusaDeliveries.listForSession(query.sessionId, options) });
  }
  // #2086: the same rows, in the same order, each one classified, and the same
  // items again partitioned by class. `undelivered` is still the complete list.
  const rows = store.medusaDeliveries.sessionsWithUndeliveredMail().filter(_stillHasUnhandledMail);
  const view = deliveryDisposition.buildView(rows, { factsFor: _deliveryFacts, monitorRunning: medusaWake.isRunning(), now: Date.now() });
  for (const code of view.summary.unknownReasons) {
    if (_unknownDeliveryReasons.has(code)) continue;
    _unknownDeliveryReasons.add(code);
    log.warn('An undelivered Medusa wake carries a reason no class is declared for; shown as configuration, to be investigated', { reason: code });
  }
  return jsonResponse(res, 200, view);
});

/** Reason codes already reported as having no declared class, so each is logged once. */
const _unknownDeliveryReasons = new Set();

/**
 * What is known about the session an undelivered row belongs to (#2086), for
 * `deliveryDisposition.buildView`. Reads the store and the wake monitor's
 * memory; it asks tmux nothing and writes nothing.
 *
 * `live` is false only when something positively says so: the store has no
 * active session under that id, or the monitor's last tick found the Master
 * not running. Anything that could not be established is null, never false.
 *
 * @param {{sessionId: (string|number)}} row - A `sessionsWithUndeliveredMail` row
 * @returns {{live: (boolean|null), restartable?: boolean, lastAssessedAt: (string|null)}}
 */
function _deliveryFacts(row) {
  const key = String(row.sessionId);
  if (/^\d+$/.test(key)) {
    const session = store.sessions.get(Number(key));
    const live = launchRecoveryClear.sessionIsActive(session);
    const verdict = live ? medusaWake.verdictFor(Number(key)) : null;
    return { live, lastAssessedAt: verdict ? verdict.observedAt : null };
  }
  if (key === master.MASTER_MEDUSA_KEY) {
    // The Master is one identity that stops and starts. Stopped, its mail waits
    // for it, so it is something to start and never a historical record.
    const verdict = medusaWake.verdictFor(key);
    return { live: medusaWake.masterIsLive(), restartable: true, lastAssessedAt: verdict ? verdict.observedAt : null };
  }
  return { live: null, lastAssessedAt: null };
}

// GET /api/medusa/escalations — every open Medusa exchange the delivery
// watchdog has escalated (#1839), oldest first: priority, age, sender and
// recipient names, and what the recipient's side is blocked on. Never a
// message body. Read-only, like the deliveries view above.
route('GET', '/api/medusa/escalations', (_req, res) => {
  jsonResponse(res, 200, { escalations: medusaWatchdog.listEscalations() });
});

/**
 * Whether a session the wake ledger lists as un-nudged may still have mail
 * nobody has handled (#1435). The ledger only writes while there is unread
 * mail, so mail handled by hand never supersedes a skipped nudge; asking the
 * listener and the exchange record now lets a session leave the list once its
 * mail is dealt with. Only a running listener can show that, so a session
 * with none stays listed: absence of a listener is not evidence of handling.
 * @param {{sessionId: string}} row - A `sessionsWithUndeliveredMail` row
 * @returns {boolean}
 */
function _stillHasUnhandledMail(row) {
  const status = medusa.getStatus(row.sessionId);
  if (status.state === 'off' || !status.workspaceId) return true;
  if (status.unread > 0) return true;
  return store.medusaExchanges.listOpenForRecipient(status.workspaceId)
    .some((x) => !medusaExchanges.hasFact(x.exchange_id, ['acknowledged']));
}

/**
 * Resolve who is changing a session rule, and refuse a caller the change is
 * not theirs to make (#2013). A startup rule governs every future session of
 * its project, so only the operator may create a governing rule or change,
 * disable, delete, demote, restore or approve one. A session bound to a
 * project keeps the one role the proposal model gives it: it may propose a
 * rule for its OWN project, and revise, withdraw or decline an AI proposal in
 * that project while it is still a proposal. Unbound, invalid and Project Master
 * callers change nothing.
 *
 * The binding is checked before the rule is looked up, so a refused caller
 * learns nothing about the rule it named; a rule that does not exist then
 * answers 404. Attribution comes from the verified caller, never from the
 * request body — a body saying `changedBy: 'operator'` is a claim, and a
 * local process can make it.
 *
 * The operator is recognised the way every operator-only project route
 * recognises it (`sharedDocsAccess.resolveAccess`, #1752). Approval keeps its
 * password on top of that, at its own route.
 * @param {http.IncomingMessage} req - The request
 * @param {http.ServerResponse} res - The response, written only on refusal
 * @param {object} target - What the caller is changing
 * @param {number} [target.ruleId] - The rule being changed; omitted for a create
 * @param {*} [target.projectId] - For a create: the project the rule is for
 * @param {string} [target.kind] - For a create: the rule's kind
 * @param {boolean} target.proposalAction - Whether a bound session may do this
 *   to a still-proposed AI rule in its own project (a create is always a proposal)
 * @param {string} target.action - Completes "Only the operator can …"
 * @returns {{operator: boolean, changedBy: string, rule: (object|null)}|null}
 *   The caller, or null when the request was answered
 */
function sessionRuleCaller(req, res, target) {
  const access = sharedDocsAccess.resolveAccess(req);
  const isCreate = target.ruleId === undefined;
  const operator = access.kind === sharedDocsAccess.KINDS.OPERATOR;
  if (!operator) {
    const refusal = sharedDocsAccess.projectRefusalFor(access, sharedDocsAccess.NEEDS.OWN_PROJECT);
    if (refusal) {
      _refuseProjectWrite(req, res, refusal, _callerLogFields(req, access));
      return null;
    }
  }
  const rule = isCreate ? null : store.sessionRules.get(target.ruleId);
  if (!isCreate && !rule) {
    errorResponse(res, 404, `Session rule ${target.ruleId} not found`, 'NOT_FOUND');
    return null;
  }
  if (operator) return { operator: true, changedBy: 'operator', rule };

  const operatorOnly = {
    status: 403,
    code: 'OPERATOR_ONLY',
    message: `Only the operator can ${target.action}${rule ? ` (${ruleLabel(rule.id)})` : ''}. `
      + 'A session may propose rules for its own project, '
      + 'and revise, withdraw or decline AI proposals in that project while they are still proposals; approving, '
      + 'changing or removing a rule that governs sessions is the operator\'s, from the TangleClaw dashboard.'
  };
  const details = { callerProjectId: access.projectId, ruleId: rule ? rule.id : null };
  // Project Master rules have no project, so no project session owns one.
  const masterRule = isCreate ? target.kind === 'master' : rule.kind === 'master';
  if (masterRule) {
    _refuseProjectWrite(req, res, operatorOnly, details);
    return null;
  }
  const targetProjectId = isCreate ? target.projectId : rule.projectId;
  // A create with no projectId falls through to the store, which answers the
  // same 400 it gives the operator.
  const present = targetProjectId !== undefined && targetProjectId !== null;
  if (present && String(targetProjectId) !== String(access.projectId)) {
    _refuseProjectWrite(req, res, {
      status: 403,
      code: 'OTHER_PROJECT',
      message: 'This session is bound to another project, so it cannot change that project\'s rules. '
        + 'A project\'s rules are proposed by that project\'s own session, or set by the operator from the '
        + 'TangleClaw dashboard.'
    }, { ...details, targetProjectId });
    return null;
  }
  const ownProposal = isCreate
    || (rule.status === 'proposed' && rule.createdBy === 'ai');
  if (!target.proposalAction || !ownProposal) {
    _refuseProjectWrite(req, res, operatorOnly, details);
    return null;
  }
  return { operator: false, changedBy: 'ai', rule };
}

/**
 * Bring a project's delivered rules files up to date after a rule change, and
 * say so when that could not be done.
 *
 * The session-start hook prints files the launch wrote, on every start
 * including after a `/clear`. A rule that came into force, left it or changed
 * its text while the session runs is in the store and not in those files until
 * they are rewritten, so every route that can change the rules in force calls
 * this once, after its store write and before it answers.
 *
 * The files are rewritten only when the change can have moved the set in
 * force: this rule entered or left it, or became or stopped being an active
 * rule (an approval may retire another rule with it). A proposal, a wrap rule
 * and a Project Master rule never do. Nor does a text edit or rollback of an active rule:
 * the store files that as a proposal and leaves the rule as it was, so new
 * text reaches the files when its proposal is approved and enters the set.
 *
 * It never throws and never fails the route: the rule change is already saved,
 * and the store stays the authority. What it returns is spread into the
 * response, so a caller is told when what a cleared session will be shown
 * differs from the rules in force:
 *
 * - the files could not be rewritten;
 * - the project's running session has no rules file, or no hook that prints
 *   one (it was launched with no rule in force, or its launch delivered rules
 *   another way), so rules in force are not re-delivered to it after a clear
 *   until its next launch. Nothing registers a hook mid-session; delivering
 *   that case is #2293.
 *
 * @param {object|null} before - The rule before the change; null for a new one
 * @param {object|null} after - The rule after the change; null for a deleted one
 * @returns {{deliveryWarning?: string}} Empty when there is nothing to say
 */
function refreshDeliveredRules(before, after) {
  const inForce = (rule) => !!rule && rule.kind === 'startup' && rule.status === 'active' && !!rule.enabled;
  // An approval can retire the rule it replaces in the same write, whatever
  // the approved rule's own switch says, so a rule becoming or ceasing to be
  // active counts as well as this rule entering or leaving the set.
  const active = (rule) => !!rule && rule.kind === 'startup' && rule.status === 'active';
  if (inForce(before) === inForce(after) && active(before) === active(after)) return {};
  const projectId = (after || before).projectId;
  try {
    const verdict = rulesRefresh.refreshProjectRules(projectId);
    if (verdict.status === 'failed') {
      // The refresh logged the project, the directory and the cause.
      const left = verdict.filesReplaced > 0
        ? 'some of them were replaced before the failure, so they are part new and part old'
        : 'they still hold the rule set from before this change';
      return {
        deliveryWarning: 'The rule change is saved, but the rules files a cleared session of '
          + `${verdict.project || `project ${projectId}`} is re-delivered could not be rewritten (${verdict.reason}); ${left}. `
          + '`tc rules` is correct, and the next launch of the project rewrites the files.'
      };
    }
    const undelivered = verdict.status === 'nothing-to-refresh' && verdict.rulesInForce > 0
      && verdict.reason !== 'no-project' && store.sessions.getActive(projectId);
    if (!undelivered) return {};
    const project = store.projects.get(projectId);
    const count = `${verdict.rulesInForce} rule${verdict.rulesInForce === 1 ? ' is' : 's are'} in force`;
    const why = verdict.reason === 'no-rules-hooks'
      ? 'no session-start hook is registered to print its rules files'
      : 'its launch wrote no rules file';
    log.warn(
      `${count} for ${project.name} and will not be re-delivered to its running session after a clear or a `
      + `compaction, because ${why}. \`tc rules\` shows them meanwhile; the next launch of the project delivers them (#2293).`,
      { projectId, project: project.name, reason: verdict.reason, rulesInForce: verdict.rulesInForce }
    );
    return {
      deliveryWarning: `The rule change is saved. ${count} for ${project.name}, and its running session will not be `
        + `re-delivered them after a clear or a compaction until its next launch, because ${why}. `
        + '`tc rules` shows them meanwhile.'
    };
  } catch (err) {
    // prawduct:allow prawduct/broad-except -- a rule change that already succeeded must be answered as a success whatever reporting on its delivered copy does
    log.warn('Could not report on the delivered rules files after a rule change; the change itself is saved and `tc rules` is correct.',
      { projectId, error: err.message });
    return {};
  }
}

// POST /api/session-rules — create { content, projectId, createdBy?, kind? }
route('POST', '/api/session-rules', (req, res, _params, body) => {
  // #2032: a coordinator bound to a rotation epoch writes rules only from its
  // bound replacement thread, and none while it reconciles.
  if (coordinatorGateRefused(req, res, _callerProjectId(req), 'session-rule-write')) return;
  const caller = sessionRuleCaller(req, res, {
    projectId: body ? body.projectId : undefined,
    kind: body ? body.kind : undefined,
    proposalAction: true,
    action: 'create a Project Master rule'
  });
  if (!caller) return;
  if (!body || typeof body.content !== 'string' || !body.content.trim()) {
    return errorResponse(res, 400, 'content (non-empty string) is required', 'BAD_REQUEST');
  }
  // Architect ruling A88: an operator-authored create with `replacesRuleId`
  // lands active by default (this route never requests another status), and
  // the store retires its target in the same transaction — the same
  // retirement the PUT .../status route requires the delete password for.
  // A bound session's create always lands 'proposed' regardless of
  // `replacesRuleId` (never retires anything immediately), so only the
  // operator path can reach this side effect and only it is gated here.
  if (caller.operator && body.replacesRuleId !== undefined && body.replacesRuleId !== null) {
    const check = projects.checkDeletePassword(body.password);
    if (!check.allowed) return errorResponse(res, 403, check.error, 'FORBIDDEN');
  }
  try {
    const rule = store.sessionRules.create({
      content: body.content,
      // Required for every kind except 'master' (singleton-scoped, projectId
      // forbidden) — the store enforces both directions with BAD_REQUEST.
      projectId: body.projectId,
      // The operator may record an explicit author; anyone else's rule is an
      // AI proposal whatever the body says, so it lands 'proposed'.
      createdBy: caller.operator ? (body.createdBy || 'operator') : 'ai',
      // CC-6 (#381): 'startup' (default) | 'wrap' | 'master'. Invalid → store throws BAD_REQUEST.
      kind: body.kind,
      // SR-7K2P: optional Critic-gate attestation. Invalid → store throws BAD_REQUEST.
      criticGate: body.criticGate,
      // #1696: the active rule (same project and kind) this one replaces,
      // if any. Validated by the store (INVALID_REPLACES on refusal); never
      // silently dropped the way it used to be.
      replacesRuleId: body.replacesRuleId
    });
    jsonResponse(res, 201, { ...rule, ...refreshDeliveredRules(null, rule) });
  } catch (err) {
    if (err.code === 'BAD_REQUEST') {
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    // #1121: an unknown projectId used to die on the FK constraint as a bare
    // 500 — the caller most likely passed the project's name, not its id.
    if (err.code === 'INVALID_PROJECT_ID') {
      return errorResponse(res, 400, err.message, 'INVALID_PROJECT_ID');
    }
    // #1696: replacesRuleId named a rule that cannot be replaced (wrong
    // project/kind, not active, or already has a pending replacement).
    if (err.code === 'INVALID_REPLACES') {
      return errorResponse(res, 400, err.message, 'INVALID_REPLACES');
    }
    throw err;
  }
}, { maxBodySize: 256 * 1024, signedInOperator: { action: 'add a session rule as the operator' } });

/**
 * Eyes-open gate for the Project Master's baseline Hard rules: weakening a
 * `created_by='system'` master rule (edit, disable, delete) requires an
 * explicit confirmation flag, mirroring the `confirmBypassHidden` launch-mode
 * guard — the server enforces it, the UI merely surfaces the confirm. Restore
 * defaults always recovers the shipped baseline regardless.
 * @param {object|null} rule - The rule being mutated
 * @param {boolean} confirmed - Whether the caller sent the confirm flag
 * @returns {boolean} true when the mutation must be refused
 */
function refuseUnconfirmedBaselineEdit(rule, confirmed) {
  return !!(rule && rule.kind === 'master' && rule.createdBy === 'system' && !confirmed);
}

// PUT /api/session-rules/:id — update { content?, enabled?, confirmBaselineEdit? }
route('PUT', '/api/session-rules/:id', (req, res, params, body) => {
  // #2032: a coordinator bound to a rotation epoch writes rules only from its
  // bound replacement thread, and none while it reconciles.
  if (coordinatorGateRefused(req, res, _callerProjectId(req), 'session-rule-write')) return;
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }
  // A bound session may revise the text of an AI proposal in its project; enabling or
  // disabling is never a proposal-level act.
  const caller = sessionRuleCaller(req, res, {
    ruleId: Number(params.id),
    proposalAction: body.enabled === undefined,
    action: 'change or disable a session rule'
  });
  if (!caller) return;
  try {
    const existing = caller.rule;
    const weakens = body.content !== undefined || body.enabled === false || body.enabled === 0;
    if (weakens && refuseUnconfirmedBaselineEdit(existing, body.confirmBaselineEdit === true)) {
      return errorResponse(res, 400,
        'This is a shipped Master boundary rule — editing or disabling it requires confirmBaselineEdit: true (Restore defaults always recovers the baseline)',
        'CONFIRM_REQUIRED');
    }
    const { confirmBaselineEdit, changedBy: _claimedBy, ...updates } = body;
    const rule = store.sessionRules.update(Number(params.id), { ...updates, changedBy: caller.changedBy });
    // #1696: a text change to an active, non-master rule files a replacement
    // proposal instead of rewriting the rule — `rule` here is the ORIGINAL
    // rule, unchanged, plus `replacementProposed`. 202 says so; the rule
    // itself still answers 200 for every ordinary (non-deferred) update.
    jsonResponse(res, rule.replacementProposed ? 202 : 200, { ...rule, ...refreshDeliveredRules(existing, rule) });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    if (err.code === 'BAD_REQUEST') {
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    // #1709: a retired rule's text is history — restore it first.
    if (err.code === 'RULE_RETIRED') {
      return errorResponse(res, 409, err.message, 'RULE_RETIRED');
    }
    // #1696: a second text change while one replacement is still pending —
    // approve or reject that proposal before filing another.
    if (err.code === 'REPLACEMENT_PENDING') {
      return errorResponse(res, 409, err.message, 'REPLACEMENT_PENDING', { pendingReplacementId: err.pendingReplacementId });
    }
    throw err;
  }
}, { maxBodySize: 256 * 1024, signedInOperator: { action: 'change a session rule' } });

// DELETE /api/session-rules/:id — ?confirm=true required for shipped Master
// baseline rules (see refuseUnconfirmedBaselineEdit)
route('DELETE', '/api/session-rules/:id', (req, res, params) => {
  // #2032: a coordinator bound to a rotation epoch writes rules only from its
  // bound replacement thread, and none while it reconciles.
  if (coordinatorGateRefused(req, res, _callerProjectId(req), 'session-rule-write')) return;
  // A bound session may withdraw an AI proposal in its project, and nothing else.
  const caller = sessionRuleCaller(req, res, {
    ruleId: Number(params.id),
    proposalAction: true,
    action: 'delete a session rule'
  });
  if (!caller) return;
  try {
    const query = parseQuery(reqUrl(req).search);
    const existing = caller.rule;
    if (refuseUnconfirmedBaselineEdit(existing, query.confirm === 'true')) {
      return errorResponse(res, 400,
        'This is a shipped Master boundary rule — deleting it requires ?confirm=true (Restore defaults always recovers the baseline)',
        'CONFIRM_REQUIRED');
    }
    store.sessionRules.delete(Number(params.id), { changedBy: caller.changedBy });
    jsonResponse(res, 200, { ok: true, id: Number(params.id), ...refreshDeliveredRules(existing, null) });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    throw err;
  }
}, { signedInOperator: { action: 'remove a session rule' } });

// ── Session Rules self-improvement (D1b) ──
// Versioning + rollback, learnings→rule promotion, and the non-authoritative
// conflict-candidate signal. The Critic-gate for conflicting/autonomous edits is
// an IN-SESSION agent capability (the server cannot summon a Critic) — see
// `docs/session-rules-self-improvement.md`.

// POST /api/session-rules/promote — promote a learning into a rule (operator-confirmed)
route('POST', '/api/session-rules/promote', (req, res, _params, body) => {
  // #2032: a coordinator bound to a rotation epoch writes rules only from its
  // bound replacement thread, and none while it reconciles.
  if (coordinatorGateRefused(req, res, _callerProjectId(req), 'session-rule-write')) return;
  // This route mints a LIVE rule from AI-authored text, so it is the
  // operator's, exactly as approval is: the operator as the caller, then the
  // password. The password alone is no gate on an install that has none set.
  const caller = sessionRuleCaller(req, res, {
    projectId: body ? body.projectId : undefined,
    kind: body ? body.kind : undefined,
    proposalAction: false,
    action: 'promote a learning into a rule that governs sessions'
  });
  if (!caller) return;
  if (!body || body.learningId === undefined) {
    return errorResponse(res, 400, 'learningId is required', 'BAD_REQUEST');
  }
  const promoteCheck = projects.checkDeletePassword(body ? body.password : undefined);
  if (!promoteCheck.allowed) return errorResponse(res, 403, promoteCheck.error, 'FORBIDDEN');
  try {
    const rule = store.sessionRules.promoteFromLearning(Number(body.learningId), {
      content: body.content,
      projectId: body.projectId ?? null,
      createdBy: body.createdBy,
      // CC-6 (#381): the wrap-time self-critique loop promotes a learning into a 'wrap' rule.
      kind: body.kind,
      // SR-7K2P: optional Critic-gate attestation. Invalid → store throws BAD_REQUEST.
      criticGate: body.criticGate,
      // #569: authority comes from clearing the operator gate above, not from
      // the request claiming it. Without this the store would treat AI-authored
      // content as a proposal and the operator's own approval would land back
      // in the queue they just cleared; the wrap's proposal step calls the same
      // store method WITHOUT it and gets a proposal.
      approvedByOperator: true
    });
    jsonResponse(res, 201, { ...rule, ...refreshDeliveredRules(null, rule) });
  } catch (err) {
    if (err.code === 'NOT_FOUND') return errorResponse(res, 404, err.message, 'NOT_FOUND');
    if (err.code === 'BAD_REQUEST') return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    if (err.code === 'INVALID_PROJECT_ID') return errorResponse(res, 400, err.message, 'INVALID_PROJECT_ID');
    throw err;
  }
}, { maxBodySize: 256 * 1024, signedInOperator: { action: 'promote a session rule' } });

// PUT /api/session-rules/:id/status — the rule lifecycle's one door (#569,
// #1696, #1709). Approve ('active') or decline ('rejected') a proposal;
// retire an active rule ('retired') or restore a retired one ('active').
// Which moves are allowed at all is the store's SESSION_RULE_TRANSITIONS
// allow-list — a move it forbids is 400 INVALID_TRANSITION. An approval
// must carry `expectedContent`, the exact text the operator was shown, and
// is refused (409) if the rule no longer holds it (#1053). A rejection is
// RECORDED rather than deleted: the wrap proposes from recurring learnings,
// so a deleted decision would simply be re-proposed at the next wrap.
route('PUT', '/api/session-rules/:id/status', (req, res, params, body) => {
  // #2032: a coordinator bound to a rotation epoch writes rules only from its
  // bound replacement thread, and none while it reconciles.
  if (coordinatorGateRefused(req, res, _callerProjectId(req), 'session-rule-write')) return;
  if (!body || typeof body.status !== 'string') {
    return errorResponse(res, 400, 'status is required', 'BAD_REQUEST');
  }
  // Retiring takes a governing rule out of force for good — unlike
  // switching it off, which the operator can undo in place — so it carries
  // the same password gate as approval (Architect ruling on #1709).
  // Checked BEFORE the caller is resolved and BEFORE the rule is read at
  // all: a refused caller must not learn anything about the rule from this
  // request, including whether it exists. This is a deliberate asymmetry
  // from the 'active' branch below (which resolves the caller first,
  // matching main's existing, already-shipped approval order) — the
  // Architect's finding named the retirement password specifically.
  if (body.status === 'retired') {
    const check = projects.checkDeletePassword(body.password);
    if (!check.allowed) return errorResponse(res, 403, check.error, 'FORBIDDEN');
  }
  // Declining an AI proposal in its project is the one status change a
  // bound session may make — stated explicitly, not left to rely on
  // `ownProposal`'s independent `status === 'proposed'` check to
  // coincidentally also refuse a bound session's retire/restore attempt.
  const caller = sessionRuleCaller(req, res, {
    ruleId: Number(params.id),
    proposalAction: body.status === 'rejected',
    action: body.status === 'active' ? 'approve or restore a session rule'
      : body.status === 'retired' ? 'retire a governing rule'
        : 'change the status of a governing rule'
  });
  if (!caller) return;
  // 'active' is either an ordinary approval (password required, exactly as
  // before) or a restore from 'retired' (no password — it comes back
  // disabled, so it never starts governing on the strength of one click).
  // `caller.rule` is already resolved above, so this costs no second read.
  let restoreOnly = false;
  if (body.status === 'active') {
    if (caller.rule.status === 'retired') {
      restoreOnly = true;
    } else {
      const check = projects.checkDeletePassword(body.password);
      if (!check.allowed) return errorResponse(res, 403, check.error, 'FORBIDDEN');
    }
  }
  try {
    const rule = store.sessionRules.setStatus(Number(params.id), body.status, {
      changedBy: caller.changedBy,
      changeReason: body.changeReason,
      criticGate: body.criticGate,
      restoreOnly,
      // The text the operator was shown. Read only AFTER the password gate
      // above: a caller that cannot approve must not learn from a 409 whether
      // the text has changed, let alone what it now says.
      expectedContent: body.expectedContent
    });
    // One refresh covers an approval that also retired the rule it replaces:
    // both are in the store by now.
    jsonResponse(res, 200, { ...rule, ...refreshDeliveredRules(caller.rule, rule) });
  } catch (err) {
    if (err.code === 'NOT_FOUND') return errorResponse(res, 404, err.message, 'NOT_FOUND');
    if (err.code === 'BAD_REQUEST') return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    if (err.code === 'FORBIDDEN') return errorResponse(res, 403, err.message, 'FORBIDDEN');
    // #1709: the lifecycle forbids this exact move, or a password-free
    // restore attempt landed on a rule that stopped being retired between
    // this request's checks and its write.
    if (err.code === 'INVALID_TRANSITION') return errorResponse(res, 400, err.message, 'INVALID_TRANSITION');
    if (err.code === 'APPROVAL_REQUIRES_AUTHORITY') return errorResponse(res, 403, err.message, 'FORBIDDEN');
    if (err.code === 'EXPECTED_CONTENT_REQUIRED') {
      return errorResponse(res, 400, err.message, 'EXPECTED_CONTENT_REQUIRED');
    }
    // The current text goes back so the surface can show the operator what
    // they would actually be approving, instead of a bare refusal.
    if (err.code === 'CONTENT_CHANGED') {
      return errorResponse(res, 409, err.message, 'RULE_CONTENT_CHANGED', { currentContent: err.currentContent });
    }
    // #1696: approving a replacement whose target is no longer the rule it
    // was shown against — either a different replacement already won
    // (SUPERSEDED), or this is an edit/rollback whose target rule is gone
    // (TARGET_INACTIVE, which would otherwise resurrect edited text).
    if (err.code === 'REPLACEMENT_SUPERSEDED') {
      return errorResponse(res, 409, err.message, 'REPLACEMENT_SUPERSEDED', { targetId: err.targetId, supersededBy: err.supersededBy });
    }
    if (err.code === 'REPLACEMENT_TARGET_INACTIVE') {
      return errorResponse(res, 409, err.message, 'REPLACEMENT_TARGET_INACTIVE', { targetId: err.targetId });
    }
    throw err;
  }
}, { maxBodySize: 256 * 1024, signedInOperator: { action: 'change a session rule\'s status' } });

// ── Learnings (#569) ──
// Until now there were no learnings routes at all, so the tier a learning sits
// at — the thing deciding whether it reaches a future session — was reachable
// only from inside the process. An operator could neither see the backlog nor
// correct a wrong promotion.

// GET /api/learnings?projectId=&tier=
route('GET', '/api/learnings', (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const projectId = url.searchParams.get('projectId');
  if (!projectId) return errorResponse(res, 400, 'projectId is required', 'BAD_REQUEST');
  const pid = requireNumericProjectId(res, projectId);
  if (pid === null) return;
  const tier = url.searchParams.get('tier') || undefined;
  jsonResponse(res, 200, { learnings: store.learnings.list(pid, { tier }) });
});

// PUT /api/learnings/:id/tier — correct a learning's tier by hand.
// The loop advances tiers on its own via recurrence; this is the operator's
// override for when it advanced something they disagree with, or held back
// something they want live now. An active learning is rendered into its
// project's session primes, so the override is the operator's alone (#2018).
route('PUT', '/api/learnings/:id/tier', (req, res, params, body) => {
  if (!operatorProjectCaller(req, res, 'change a learning\'s tier')) return;
  if (!body || typeof body.tier !== 'string') {
    return errorResponse(res, 400, 'tier is required', 'BAD_REQUEST');
  }
  try {
    jsonResponse(res, 200, store.learnings.setTier(Number(params.id), body.tier));
  } catch (err) {
    if (err.code === 'NOT_FOUND') return errorResponse(res, 404, err.message, 'NOT_FOUND');
    if (err.code === 'BAD_REQUEST') return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    throw err;
  }
}, { maxBodySize: 64 * 1024, signedInOperator: { action: 'change a learning\'s tier' } });

// POST /api/session-rules/conflicts — non-authoritative conflict-candidate signal
route('POST', '/api/session-rules/conflicts', (_req, res, _params, body) => {
  if (!body || typeof body.content !== 'string' || !body.content.trim()) {
    return errorResponse(res, 400, 'content (non-empty string) is required', 'BAD_REQUEST');
  }
  // A null projectId is a legitimate unscoped query; a PRESENT one must name a
  // real project (#1121) or the comparison silently runs against nothing.
  if (body.projectId !== undefined && body.projectId !== null
      && requireNumericProjectId(res, body.projectId) === null) return;
  const candidates = store.sessionRules.findConflictCandidates(body.content, body.projectId ?? null, { kind: body.kind });
  jsonResponse(res, 200, { candidates });
}, { maxBodySize: 256 * 1024 });

// GET /api/session-rules/:id/versions — version history (newest first)
route('GET', '/api/session-rules/:id/versions', (_req, res, params) => {
  const rule = store.sessionRules.get(Number(params.id));
  if (!rule) return errorResponse(res, 404, `Session rule ${params.id} not found`, 'NOT_FOUND');
  const versions = store.sessionRules.listVersions(Number(params.id));
  jsonResponse(res, 200, { versions });
});

// POST /api/session-rules/:id/restore — roll back to a prior version.
// Restore is a mutation like PUT/DELETE, so shipped Master baseline rules take
// the same eyes-open gate when the restore would weaken them (content change
// or restoring a disabled snapshot) — the gate predicates must stay symmetric
// across every path that can alter a rule, or the confirm is bypassable.
route('POST', '/api/session-rules/:id/restore', (req, res, params, body) => {
  // #2032: a coordinator bound to a rotation epoch writes rules only from its
  // bound replacement thread, and none while it reconciles.
  if (coordinatorGateRefused(req, res, _callerProjectId(req), 'session-rule-write')) return;
  if (!body || body.versionNo === undefined) {
    return errorResponse(res, 400, 'versionNo is required', 'BAD_REQUEST');
  }
  const caller = sessionRuleCaller(req, res, {
    ruleId: Number(params.id),
    proposalAction: false,
    action: 'restore an earlier version of a session rule'
  });
  if (!caller) return;
  try {
    const existing = caller.rule;
    if (refuseUnconfirmedBaselineEdit(existing, body.confirmBaselineEdit === true)) {
      const target = store.sessionRules.listVersions(Number(params.id))
        .find((v) => v.versionNo === Number(body.versionNo));
      // #1048 — a versionNo that does not exist is NOT a weakening, so it must
      // not answer CONFIRM_REQUIRED: that would tell the caller to confirm an
      // operation that can never succeed, and shadow the accurate answer.
      //
      // The existence check is deliberately NOT hoisted above this gate, which
      // is what the issue suggests: `store.sessionRules.restore` already
      // validates it and throws NOT_FOUND, which the catch below maps to 404.
      // Pre-checking here would put the same rule in two places — and the gate
      // must stay symmetric across every path that can alter a rule, so a
      // second copy is the thing most likely to drift. Falling through gives
      // the authoritative answer from the one owner of it.
      const weakens = Boolean(target)
        && (target.content !== existing.content || !target.enabled);
      if (weakens) {
        return errorResponse(res, 400,
          'This is a shipped Master boundary rule — restoring a version that changes or disables it requires confirmBaselineEdit: true (Restore defaults always recovers the baseline)',
          'CONFIRM_REQUIRED');
      }
    }
    // SR-7K2P: optional Critic-gate attestation. Invalid → store throws BAD_REQUEST.
    const rule = store.sessionRules.restore(Number(params.id), Number(body.versionNo), { changedBy: caller.changedBy, criticGate: body.criticGate });
    // #1696: a version rollback that changes an active, non-master rule's
    // text files a replacement proposal instead of applying it — same 202
    // contract as the PUT route above.
    jsonResponse(res, rule.replacementProposed ? 202 : 200, { ...rule, ...refreshDeliveredRules(existing, rule) });
  } catch (err) {
    if (err.code === 'NOT_FOUND') return errorResponse(res, 404, err.message, 'NOT_FOUND');
    if (err.code === 'BAD_REQUEST') return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    // #1709: a retired rule's text is history — restore it (via PUT .../status) first.
    if (err.code === 'RULE_RETIRED') return errorResponse(res, 409, err.message, 'RULE_RETIRED');
    // #1696: a second text change while one replacement is still pending —
    // approve or reject that proposal before filing another.
    if (err.code === 'REPLACEMENT_PENDING') {
      return errorResponse(res, 409, err.message, 'REPLACEMENT_PENDING', { pendingReplacementId: err.pendingReplacementId });
    }
    throw err;
  }
}, { signedInOperator: { action: 'restore a session rule' } });

// GET /api/system
route('GET', '/api/system', (_req, res) => {
  const stats = system.getStats();
  jsonResponse(res, 200, stats);
});

// GET /api/system/health — the machine-wide conditions the dashboard's system
// health panel renders (#345) — every condition the detector list assembles.
// Each is `fired` / `clear` / `unknown`; see lib/system-health for the roster.
// Async because the Full Disk Access probe reads a directory in the scanner
// child under a deadline — the one read that must never happen on this loop (#859).
route('GET', '/api/system/health', async (_req, res) => {
  const health = await systemHealth.getHealth();
  jsonResponse(res, 200, health);
});

// GET /api/system/pty-activity — terminal attaches and detaches through the
// `/terminal` proxy since this process started (#1949). Release-candidate
// certification reads it for its PTY-use target; `instance` changes with every
// process, so a reader can tell a restart from a counter going backwards.
route('GET', '/api/system/pty-activity', (_req, res) => {
  jsonResponse(res, 200, ptyActivity.snapshot());
});

// GET /api/engines — `?refresh=1` re-reads the operator's login PATH before
// probing, rather than reusing the cached one. That is what the setup wizard's
// "Check again" calls: the operator has just installed an engine in another
// window, and an installer that edits their shell profile changes the PATH
// itself, not only what sits on it.
route('GET', '/api/engines', async (req, res) => {
  const refresh = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1';
  // Awaited, not run synchronously: resolving the login PATH means starting the
  // operator's shell and running their profile, which is unbounded work someone
  // else wrote. Doing that on the event loop inside a route is the defect this
  // whole branch exists to remove.
  if (refresh) await engines.refreshDetectionPath();
  let list = engines.listWithAvailability();
  // Resolve the login PATH before answering "nothing found". The boot probe is
  // fire-and-forget, so a request landing before it settles would otherwise be
  // told detection could not look — reporting a race as a finding, which is the
  // unknown-vs-known conflation this release exists to remove.
  //
  // Keyed on ATTEMPTED, not succeeded: a shell that cannot answer never sets
  // succeeded, so keying on that would re-probe on every request for exactly
  // the operators stuck on this step pressing buttons. Worst case is one
  // request paying for up to two shell starts (`-lic`, then `-lc`, 6s each);
  // afterwards the answer is cached until something explicitly asks for a new
  // one. `?refresh=1` is that explicit ask, and it is a button press.
  if (!list.some((e) => e && e.available) && !engines.detectionProbeAttempted()) {
    await engines.refreshDetectionPath();
    list = engines.listWithAvailability();
  }
  // `detectionCertain: false` means no login shell answered, so detection saw
  // only the PATH launchd gives this service and "not installed" is not a
  // trustworthy answer (#346). The wizard shows that rather than presenting a
  // guess as a fact — and it is what lets an operator whose engine IS installed
  // get past a step that would otherwise be a locked door.
  const certain = list.some((e) => e && e.available) || engines.detectionWasProbed();
  jsonResponse(res, 200, { engines: list, detectionCertain: certain });
});

// GET /api/engines/:id
route('GET', '/api/engines/:id', (_req, res, params) => {
  const profile = engines.getWithAvailability(params.id);
  if (!profile) {
    return errorResponse(res, 404, `Engine "${params.id}" not found`, 'NOT_FOUND');
  }
  // The RAW profile, deliberately — this is the introspection endpoint, and it
  // carries fields the client projection drops on purpose (`detection`,
  // `errorPatterns`, `statusPage`). It is therefore the one engine response
  // that does NOT carry #736's usable-`name` guarantee, which is safe only
  // while no browser code calls it; `test/engine-picker-gating.test.js` pins
  // that no file under `public/` does. A future browser caller must route
  // through `engineClientPayload` rather than reading this shape.
  jsonResponse(res, 200, profile);
});

// GET /api/models/status — Upstream service status for all engines
route('GET', '/api/models/status', (_req, res) => {
  jsonResponse(res, 200, { status: modelStatus.getStatus() });
});

// GET /api/update-status — Cached update check result
route('GET', '/api/update-status', (_req, res) => {
  jsonResponse(res, 200, updateChecker.getCachedStatus());
});

// POST /api/update/check — measure now, rather than reporting whatever the
// periodic timer last saw.
//
// The timer alone cannot keep the answer current: it fires on a long interval, so
// a release published just after a check stays invisible for most of its life,
// and the dashboard's own status poll only re-read the same cached value. This
// is the route that lets a page load, a tab regaining focus, or the operator
// asking directly produce a real measurement.
//
// POST rather than a flag on the GET because it has a side effect — it can start
// a network call. `GET /api/update-status` stays a cheap, side-effect-free cache
// read for the consumers that just want the last known answer.
//
// `{"manual": true}` selects the tighter staleness floor: an explicit request is
// owed a real check, where an automatic one should settle for a recent answer.
// Throttling and single-flight both live in `refreshIfStale`, so no amount of
// reloading turns into a poll loop against origin.
route('POST', '/api/update/check', (_req, res, _params, body) => {
  const maxAge = updateChecker.resolveRefreshFloor(body && body.manual === true);

  // Responds with the status object unchanged — deliberately the same shape as
  // the GET, so nothing has to branch on which route it asked. Whether this was
  // a fresh measurement or a throttled cache hit is already observable in
  // `checkedAt`, which does not move when the cache is reused; a separate
  // `refreshed` flag would be a second encoding of the same fact.
  updateChecker.refreshIfStale(maxAge, (status) => {
    jsonResponse(res, 200, status);
  });
});

// POST /api/update/apply — the self-update ACTION (#228/#229, UB). Fetches +
// checks out the latest release tag; does NOT restart. The client chains
// POST /api/server/restart on a 200. A refused safety guard (dirty tree, no
// update, wrong ref, not a git checkout, files to reconcile, a conflicted
// rebase attempt on a local branch) returns 409 with a stable `code`, and the
// checkout is as it was. The two 500s are the failures
// where that cannot be promised: `git-error`, an unexpected git failure with the
// pre-update `fromSha`, and `recovery-failed`, where putting the checkout back
// after a failed step did not fully succeed and `recovery` says what is where.
route('POST', '/api/update/apply', (req, res, _params, body) => {
  // #1861 — the same caller gate as restart. Checking for an update is not a
  // governed mutation and stays open; applying one is.
  if (controlRefused(res, { surface: 'update-apply', subject: { kind: 'caller', caller: resolveControlCaller(req) } })) return;
  // `discardDirty` opts into removing TangleClaw-written files that block the
  // update (#711 chunk 03). A strict-boolean gate like bindAllInterfaces': a
  // truthy string from a sloppy client must not authorize a discard.
  const result = updateApplier.applyUpdate({
    discardDirty: !!(body && body.discardDirty === true)
  });
  if (result.ok) {
    jsonResponse(res, 200, result);
    return;
  }
  jsonResponse(res, result.code === 'git-error' || result.code === 'recovery-failed' ? 500 : 409, result);
});

// POST /api/update/pull — the safe fast-forward Pull action (#1223). Shown
// only when the dashboard's last poll said `canFastForwardPull: true`; this
// route re-verifies the same three preconditions against a FRESH
// measurement rather than trusting that poll (`behindOrigin.pullFastForward`),
// because the poll that rendered the button can be up to 15 minutes old.
// Returns 409 `PULL_NOT_SAFE` if the recheck fails, 409 `MERGE_FAILED` if
// `git merge --ff-only` itself refuses (the checkout moved again in the gap),
// 500 `GIT_ERROR` if git itself is unavailable, or 200 with the SHAs moved
// and a `restartMechanism` so the client can immediately offer the restart
// this clone (the live install) now needs.
route('POST', '/api/update/pull', async (req, res) => {
  // P20 names this route operator-only, unlike its siblings /api/server/restart
  // and /api/update/apply (which admit any clear project caller too) — a git
  // merge against the live checkout's own working tree is a step up from
  // restarting or re-checking out a release tag. Before any other check, so
  // a refused caller learns nothing else about the route (#1746/#1752 pattern).
  if (!operatorProjectCaller(req, res, 'pull origin/main into this checkout')) return;
  // #1861 — the same caller gate as restart and update-apply: a held caller
  // never mutates the checkout.
  if (controlRefused(res, { surface: 'update-pull', subject: { kind: 'caller', caller: resolveControlCaller(req) } })) return;
  // The render-time gate (canFastForwardPull) already hides the button when
  // the operator turned the behind-origin check off — this closes the same
  // gap for a DIRECT call to the route, which skips that button entirely. An
  // operator who set the kill switch (metered connection, privacy, or a test
  // process that must not touch `.git`) must not have this install merge
  // anyway just because something else knows the route exists.
  if (!behindOrigin.isCheckEnabled(store.config.load())) {
    return errorResponse(res, 409, 'The behind-origin check is turned off for this install.', 'CHECK_DISABLED');
  }
  const result = await behindOrigin.pullFastForward();
  if (!result.ok) {
    return errorResponse(res, result.code === 'GIT_ERROR' ? 500 : 409, result.error, result.code);
  }
  jsonResponse(res, 200, {
    ok: true,
    fromSha: result.fromSha,
    toSha: result.toSha,
    restartMechanism: serverInfo.detectRestartMechanism()
  });
});

// POST /api/tmux/mouse — set a session-level mouse value, or `unset: true`
// to remove the override so the session inherits the global again (#579).
route('POST', '/api/tmux/mouse', (_req, res, _params, body) => {
  if (!body || typeof body.session !== 'string') {
    return errorResponse(res, 400, 'session is required', 'BAD_REQUEST');
  }
  const unset = body.unset === true;
  if (!unset && typeof body.on !== 'boolean') {
    return errorResponse(res, 400, 'on must be a boolean (or pass unset: true)', 'BAD_REQUEST');
  }
  if (unset && typeof body.on === 'boolean') {
    return errorResponse(res, 400, 'on and unset are mutually exclusive', 'BAD_REQUEST');
  }

  try {
    const tmuxName = tmux.toSessionName(body.session);
    if (unset) {
      tmux.unsetMouse(tmuxName);
    } else {
      tmux.setMouse(tmuxName, body.on, { hooks: !!body.hooks });
    }
    // Report the post-op EFFECTIVE state — after an unset that is whatever
    // the session now inherits, which the client cannot know on its own.
    const state = tmux.getMouseState(tmuxName);
    jsonResponse(res, 200, {
      mouse: state.on,
      explicit: state.explicit,
      session: body.session
    });
  } catch (err) {
    return errorResponse(res, 404, err.message, 'NOT_FOUND');
  }
});

// GET /api/ports — List all port leases (optional ?host= filter)
route('GET', '/api/ports', (req, res) => {
  const url = reqUrl(req);
  const hostFilter = url.searchParams.get('host') || undefined;
  const leases = porthub.getLeases(hostFilter ? { host: hostFilter } : undefined);
  const grouped = {};
  for (const lease of leases) {
    const key = lease.host === 'localhost' ? lease.project : `${lease.host}/${lease.project}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(lease);
  }

  // System-detected listeners no lease accounts for (localhost only). Their
  // identities, not just a count, so a caller can see WHICH ports are taken
  // before picking one (#814). From the periodic scan's cache: the lease route
  // asks the machine fresh, this listing does not need to. The scan reads the
  // same sources as the lease probe (lsof plus the kernel socket table), so
  // root's listeners are listed too; the list is as old as the last scan, and
  // empty when scanning is off.
  const leasedPortSet = new Set(leases.filter(l => l.host === 'localhost').map(l => l.port));
  const systemPorts = portScanner.getSystemPorts()
    .filter(sp => !leasedPortSet.has(sp.port))
    .map(sp => ({ port: sp.port, pid: sp.pid, command: sp.command }));

  jsonResponse(res, 200, {
    totalLeases: leases.length,
    systemPortCount: systemPorts.length,
    systemPorts,
    leases,
    grouped
  });
});

// POST /api/ports/lease — Create or renew a lease
route('POST', '/api/ports/lease', (_req, res, _params, body) => {
  if (!body || !body.port || !body.project || !body.service) {
    return errorResponse(res, 400, 'port, project, and service are required', 'BAD_REQUEST');
  }
  // A port sent as a string ("8443") would skip the listener probe, which
  // checks for an integer, and be granted unchecked. Normalize once here.
  const leasePort = Number(body.port);
  if (!Number.isInteger(leasePort) || leasePort < 1 || leasePort > 65535) {
    return errorResponse(res, 400, `port must be an integer from 1 to 65535 (got ${JSON.stringify(body.port)})`, 'BAD_REQUEST');
  }
  // Through PortHub, not the store directly, so the machine is asked before
  // the registry answers "free" (#814) — this is the path every managed
  // project is told to use, and it was the one path without the check.
  const result = porthub.registerPort(leasePort, body.project, body.service, {
    host: body.host || 'localhost',
    // The HTTP default has always been a non-permanent lease; PortHub's own
    // default is permanent, so the route states it.
    permanent: body.permanent === true,
    ttlMs: body.ttl || null,
    description: body.description || null,
    autoRenew: body.autoRenew === true,
    force: body.force === true,
    adoptListener: body.adoptListener === true,
    // Passed through unvalidated on purpose: `store.portLeases.lease` owns
    // these vocabularies and throws BAD_REQUEST naming the legal values, so a
    // second check here could only drift from it.
    reach: body.reach,
    ownerKind: body.ownerKind
  });
  if (result.success) {
    return jsonResponse(res, 201, { ...result.lease, listenerCheck: result.listenerCheck });
  }
  // A port already owned by another project, or held by a process no lease
  // records, is a conflict, not a malformed request — 409 lets a caller retry
  // against a different port, and the owner or listener in the body is what
  // makes that decision possible without a second call.
  if (result.code === 'PORT_CONFLICT') {
    return jsonResponse(res, 409, { error: result.error, code: 'PORT_CONFLICT', owner: result.owner });
  }
  if (result.code === 'PORT_IN_USE') {
    return jsonResponse(res, 409, { error: result.error, code: 'PORT_IN_USE', listener: result.listener });
  }
  return errorResponse(res, 400, result.error, 'BAD_REQUEST');
});

// POST /api/ports/owner-kind — Record whether an owner name is a TangleClaw project
route('POST', '/api/ports/owner-kind', (_req, res, _params, body) => {
  if (!body || !body.project || !body.ownerKind) {
    return errorResponse(res, 400, 'project and ownerKind are required', 'BAD_REQUEST');
  }
  let updated;
  try {
    // The dashboard's "Not a project" control (#1381). The store owns the
    // vocabulary and names the legal values on a bad one.
    updated = store.portLeases.setOwnerKind(body.project, body.ownerKind, { host: body.host || null });
  } catch (err) {
    return errorResponse(res, 400, err.message, 'BAD_REQUEST');
  }
  if (updated === 0) {
    return errorResponse(res, 404, `No lease is held under "${body.project}"${body.host ? ` on ${body.host}` : ''}`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, { ok: true, project: body.project, ownerKind: body.ownerKind, updated });
});

// POST /api/ports/sync — Sync leases from old PortHub daemon
route('POST', '/api/ports/sync', (_req, res) => {
  const result = porthub.syncFromDaemon();
  jsonResponse(res, 200, { ok: true, imported: result.imported });
});

// POST /api/ports/release — Release a lease
route('POST', '/api/ports/release', (_req, res, _params, body) => {
  if (!body || !body.port) {
    return errorResponse(res, 400, 'port is required', 'BAD_REQUEST');
  }
  // Leases are keyed on (host, port), and the same port number can belong to
  // different projects on different hosts. A release that omits `host` means
  // localhost; when another host also holds this port, that default is a guess
  // that can delete a stranger's lease, so it is refused instead (#853).
  if (!body.host) {
    const elsewhere = porthub.getLeases()
      .filter(l => l.port === Number(body.port) && l.host !== 'localhost')
      .map(l => l.host);
    if (elsewhere.length > 0) {
      return errorResponse(res, 400,
        `Port ${body.port} is also leased on ${[...new Set(elsewhere)].join(', ')}, so a release without "host" is ambiguous. `
        + 'Say which lease you mean with "host" ("localhost" for this machine).',
        'HOST_REQUIRED');
    }
  }
  try {
    // `project` is optional but verified when present (#656): a release names
    // whose lease it is, and releasing another live project's port is refused with
    // 409 unless `force` is set. Omitting `project` keeps the prior behavior.
    store.portLeases.release(body.port, body.host || 'localhost', {
      project: body.project || null,
      force: body.force === true
    });
  } catch (err) {
    if (err.code === 'PORT_CONFLICT') {
      return jsonResponse(res, 409, {
        error: err.message,
        code: 'PORT_CONFLICT',
        owner: err.owner || null
      });
    }
    return errorResponse(res, 400, err.message, 'BAD_REQUEST');
  }
  jsonResponse(res, 200, { ok: true, host: body.host || 'localhost', port: body.port });
});

// POST /api/ports/heartbeat — Heartbeat a lease
route('POST', '/api/ports/heartbeat', (_req, res, _params, body) => {
  if (!body || !body.port) {
    return errorResponse(res, 400, 'port is required', 'BAD_REQUEST');
  }
  let lease;
  try {
    // `project` is optional but verified when present (#656): renewing another
    // project's lease keeps a port nobody-you-own alive, so a mismatch is a 409.
    lease = store.portLeases.heartbeat(body.port, body.host || 'localhost', {
      project: body.project || null
    });
  } catch (err) {
    if (err.code === 'PORT_CONFLICT') {
      return jsonResponse(res, 409, {
        error: err.message,
        code: 'PORT_CONFLICT',
        owner: err.owner || null
      });
    }
    return errorResponse(res, 400, err.message, 'BAD_REQUEST');
  }
  if (!lease) {
    return errorResponse(res, 404, `No lease found for port ${body.port}`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, lease);
});

/**
 * Log and send a project write route's refusal.
 * @param {http.IncomingMessage} req - The request
 * @param {http.ServerResponse} res - The response
 * @param {{status: number, code: string, message: string}} refusal - What to send
 * @param {object} details - Extra log fields: who the caller is and why
 * @returns {void}
 */
function _refuseProjectWrite(req, res, refusal, details) {
  log.warn('Project write route refused', {
    method: req.method,
    path: reqUrl(req).pathname,
    code: refusal.code,
    ...details
  });
  errorResponse(res, refusal.status, refusal.message, refusal.code);
}

/**
 * The log fields that say who a refused caller claimed to be.
 * @param {http.IncomingMessage} req - The request
 * @param {object} access - From `sharedDocsAccess.resolveAccess`
 * @returns {object}
 */
function _callerLogFields(req, access) {
  return {
    kind: access.kind,
    reason: access.reason,
    cause: access.cause || null,
    claimedProjectId: req.headers[sharedDocsAccess.PROJECT_HEADER] || null,
    claimedRole: req.headers[sharedDocsAccess.ROLE_HEADER] || null
  };
}

/**
 * Admit only the operator to an operator-only project route, before any
 * lookup, so a refused caller learns nothing about the project it named.
 * These routes change what every session on the install can reach (#1746,
 * #1752).
 * @param {http.IncomingMessage} req - The request
 * @param {http.ServerResponse} res - The response, written only on refusal
 * @param {string} action - What the route does, completing "Only the operator can …"
 * @returns {boolean} true when the caller is the operator
 */
function operatorProjectCaller(req, res, action) {
  const access = sharedDocsAccess.resolveAccess(req);
  const refusal = sharedDocsAccess.projectRefusalFor(access, sharedDocsAccess.NEEDS.OPERATOR, action);
  if (!refusal) return true;
  _refuseProjectWrite(req, res, refusal, _callerLogFields(req, access));
  return false;
}

/**
 * Admit the operator, or a session bound to the named project, to a route
 * that changes one project (#1752). The whole check is one call so no route
 * can do half of it: a binding refusal before any lookup; then the lookup,
 * answering 404 for a project that does not exist (project names are public
 * in the roster, so this discloses nothing); then `403 OTHER_PROJECT` for a
 * session bound to a different project.
 * @param {http.IncomingMessage} req - The request
 * @param {http.ServerResponse} res - The response, written only on refusal
 * @param {string} segment - The project named in the path
 * @param {function(string): (object|null)} lookup - Finds the project row by that segment
 * @returns {object|null} The project row, or null when the request was answered
 */
function ownProjectCaller(req, res, segment, lookup) {
  const access = sharedDocsAccess.resolveAccess(req);
  const refusal = sharedDocsAccess.projectRefusalFor(access, sharedDocsAccess.NEEDS.OWN_PROJECT);
  if (refusal) {
    _refuseProjectWrite(req, res, refusal, _callerLogFields(req, access));
    return null;
  }
  const project = lookup(segment);
  if (!project) {
    errorResponse(res, 404, `Project "${segment}" not found`, 'NOT_FOUND');
    return null;
  }
  if (!sharedDocsAccess.canChangeProject(access, project.id)) {
    _refuseProjectWrite(req, res, {
      status: 403,
      code: 'OTHER_PROJECT',
      message: `This session is bound to another project, so it cannot change "${project.name}". `
        + 'A project\'s settings, actions and stranded wraps are changed by that project\'s own session, '
        + 'or by the operator from the TangleClaw dashboard.'
    }, { callerProjectId: access.projectId, targetProjectId: project.id });
    return null;
  }
  return project;
}

/**
 * Resolve who is reading the projects list or a project row. A read is never
 * refused, so a binding that was presented and not honoured would otherwise
 * pass unnoticed: the pane just sees public rows. Log it, as the shared-docs
 * refusals do, so an operator can tell a stale binding from an unbound caller.
 * A caller with no binding at all is the common roster read and is not logged.
 * @param {http.IncomingMessage} req - The request
 * @returns {{kind: string, projectId: (number|null), groupIds: string[], reason: (string|null)}}
 */
function projectsReader(req) {
  const access = sharedDocsAccess.resolveAccess(req);
  if (access.kind === sharedDocsAccess.KINDS.INVALID) {
    log.warn('Projects read with a binding that was not honoured; answered with public rows', {
      method: req.method,
      path: reqUrl(req).pathname,
      reason: access.reason,
      cause: access.cause || null,
      claimedProjectId: req.headers[sharedDocsAccess.PROJECT_HEADER] || null,
      claimedRole: req.headers[sharedDocsAccess.ROLE_HEADER] || null
    });
  }
  return access;
}

// GET /api/projects
route('GET', '/api/projects', async (req, res) => {
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);
  const options = {};
  if (query.archived === 'true') options.archived = true;
  if (query.tag) options.tag = query.tag;
  if (query.engine) options.engine = query.engine;

  // `scan` travels with the list, because the list alone cannot say whether it is
  // the whole list — a directory that would not answer degrades to the registered
  // projects, and that used to look identical to having no others (#885).
  const { projects: list, scan } = await projects.listAllProjects(options);
  // Not refused for an unbound caller: agent panes read this list as a roster
  // of names and engines. What they may not read is another project's
  // workspace, so each row is shaped for the caller (#1739).
  const access = projectsReader(req);
  jsonResponse(res, 200, {
    projects: list.map((project) => projectView.shapeProject(access, project)),
    scan: projectView.shapeScan(access, scan)
  });
});

// POST /api/projects/attach — Attach an existing filesystem directory as a project
route('POST', '/api/projects/attach', async (req, res, _params, body) => {
  // Registering a directory as a project is the operator's (#1752).
  if (!operatorProjectCaller(req, res, 'attach a directory as a project')) return;
  if (!body || !body.name) {
    return errorResponse(res, 400, 'name is required', 'BAD_REQUEST');
  }

  const result = await projects.attachProject(body.name);
  if (!result.project) {
    const firstError = result.errors[0] || 'Attach failed';
    const code = firstError.includes('already registered') ? 'CONFLICT' : 'BAD_REQUEST';
    return errorResponse(res, code === 'CONFLICT' ? 409 : 400, firstError, code);
  }

  const response = {
    id: result.project.id,
    name: result.project.name,
    path: result.project.path,
    engine: result.project.engine,
    tags: result.project.tags,
    registered: true,
    createdAt: result.project.createdAt
  };

  if (result.errors.length > 0) {
    response.warnings = result.errors;
  }

  jsonResponse(res, 201, response);
});

// GET /api/projects/orphan-hooks-scan — Read-only inventory of projects with
// orphan hook entries in the .claude hook settings files (#145, chunk 2). MUST be
// registered before GET /api/projects/:name so the literal path wins.
route('GET', '/api/projects/orphan-hooks-scan', (_req, res) => {
  const result = projects.scanForOrphanHooks();
  jsonResponse(res, 200, result);
});

// GET /api/projects/stranded-configs-scan — Read-only inventory of governance
// configs (CLAUDE.md, .claude/settings.json) stranded in unregistered ancestor
// dirs of registered projects (#592). No repair counterpart by design — a
// stranded file can contain hand-written content, so removal is an operator
// decision. MUST be registered before GET /api/projects/:name so the literal
// path wins.
route('GET', '/api/projects/stranded-configs-scan', (_req, res) => {
  const result = projects.scanForStrandedConfigs();
  jsonResponse(res, 200, result);
});

// POST /api/projects/repair-orphan-hooks — Strip orphan hook entries from
// affected projects. Body: `{ project?: string }` for single-target. Returns
// `{ repaired, skipped, errors }` (#145, chunk 2).
route('POST', '/api/projects/repair-orphan-hooks', (req, res, _params, body) => {
  // It rewrites hook files in every project, or in one it names (#1752).
  if (!operatorProjectCaller(req, res, 'repair orphan hooks')) return;
  if (body && body.project !== undefined && typeof body.project !== 'string') {
    return errorResponse(res, 400, 'project must be a string', 'BAD_REQUEST');
  }
  const projectName = body && body.project ? body.project : null;
  const result = projects.repairOrphanHooks(projectName);
  if (projectName && result.errors.some((e) => e.error === 'Project not found')) {
    return errorResponse(res, 404, `Project "${projectName}" not found`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, result);
});

// GET /api/projects/:name
route('GET', '/api/projects/:name', async (req, res, params) => {
  const project = await projects.getProject(params.name);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.name}" not found`, 'NOT_FOUND');
  }
  // The same row the list carries, so the same shaping (#1739).
  const reader = projectsReader(req);
  // #1678: the checkout compared against the upstream every related session
  // shares. Workspace facts, so only a caller that sees the row whole gets
  // them — and only then is the clone measured at all. Cached; never waits.
  if (projectView.seesWhole(reader, project)) {
    project.checkout = checkoutFreshness.projectCheckout(project, { config: store.config.load() });
  }
  jsonResponse(res, 200, projectView.shapeProject(reader, project));
});

/**
 * Resolve a `/api/projects/:project/...` segment that may be the numeric id
 * (what the whoami roster and `/plans/:projectId/...` use) or the project name
 * (what the rest of the `/api/projects/:name` family uses). The id wins when
 * the segment is an integer that resolves; a project literally named after a
 * different project's number is the one ambiguity, and ids are the documented
 * key. Returns null when neither form resolves.
 * @param {string} segment - The decoded path segment
 * @returns {object|null} The stored project row, or null
 */
function _projectByIdOrName(segment) {
  const pid = Number(segment);
  if (Number.isInteger(pid) && /^\d+$/.test(segment)) {
    const byId = store.projects.get(pid);
    if (byId) return byId;
  }
  return store.projects.getByName(segment) || null;
}

// GET /api/projects/:project/plans — every served plan in the project with the
// link to hand the operator (#542). Accepts the numeric id or the name.
//
// The origin is the operator's FRONT DOOR, not this listener: in caddy mode
// that is Caddy's HTTPS port, and the host is the one the operator reaches
// this box on (`resolveOperatorHost` — the caller's own Host header when it
// is not loopback, else the machine's MagicDNS/hostname probe). An agent
// calling from localhost therefore gets a link that answers from the
// operator's phone, which is the whole point. When no host can be
// established, `url` is null and `originNote` says to ask — a fabricated
// localhost link would be worse than an honest absence.
route('GET', '/api/projects/:project/plans', (req, res, params) => {
  const project = _projectByIdOrName(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const config = store.config.load();
  const topology = sessionOwnership.resolveOperatorHost(req.headers, config);
  const origin = topology.host ? httpsSetup.effectiveOperatorOrigin(config, topology.host) : null;
  const plans = planDocs.listPlans(project.path).map((p) => {
    const urlPath = `/plans/${project.id}/${encodeURIComponent(p.file)}`;
    return { ...p, urlPath, url: origin ? origin + urlPath : null };
  });
  jsonResponse(res, 200, {
    project: { id: project.id, name: project.name },
    plansDirs: planDocs.plansDirCandidates(project.path).map((c) => c.relative),
    origin,
    originSource: topology.source,
    originNote: sessionOwnership.operatorLinkDirective(topology.host),
    plans
  });
});

/**
 * The body both stranded-wraps reads answer with: the local items, their
 * counts, and what the latest GitHub check said.
 * @param {object} project - Project row
 * @returns {object}
 */
function _strandedBody(project) {
  const { items } = strandedWraps.list(project);
  return {
    project: { id: project.id, name: project.name },
    items,
    // `blocking` is what holds a launch or a wrap: unacknowledged and fully
    // recorded. Grandfathered items are listed but never count there.
    counts: strandedWraps.counts(items),
    // Findings here never block, and they are as of `github.lastOkAt`.
    github: strandedCheck.status(project)
  };
}

// GET /api/projects/:project/stranded-wraps — the project's stranded wraps from
// local records (#868): wrap branches that reached the remote with no pull
// request, minus the ones a GitHub check has cleared (#1542). Accepts the
// numeric id or the name. This read never calls GitHub: `github` is what the
// latest recorded check said, with its time (#1543).
route('GET', '/api/projects/:project/stranded-wraps', (_req, res, params) => {
  const project = _projectByIdOrName(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, _strandedBody(project));
});

// POST /api/projects/:project/stranded-wraps/check — run the GitHub check now
// (#1542) and answer with its result and the refreshed list. A request made
// while a check is running joins it. A check that could not run is still a 200:
// it was recorded, and `check.state` is `failed` with the reason.
route('POST', '/api/projects/:project/stranded-wraps/check', async (req, res, params) => {
  const project = ownProjectCaller(req, res, params.project, _projectByIdOrName);
  if (!project) return;
  const result = await strandedCheck.check(project);
  jsonResponse(res, 200, { check: result, ..._strandedBody(project) });
});

// POST /api/projects/:project/stranded-wraps/ack — acknowledge one listed
// stranded wrap at its current head (#1538): { branch, headSha, remote? }.
// `headSha` is required and is null only for an older record that has none.
// The acknowledger is the signed-in user, or null when nobody is signed in —
// never a name taken from the request body, which anyone can write.
route('POST', '/api/projects/:project/stranded-wraps/ack', (req, res, params, body) => {
  const project = ownProjectCaller(req, res, params.project, _projectByIdOrName);
  if (!project) return;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }
  const by = (req.tcSession && req.tcSession.username) || null;
  const result = strandedWraps.acknowledge(project, body, by);
  if (!result.ok) {
    const status = { NOT_FOUND: 404, WRITE_FAILED: 500 }[result.code] || 400;
    return errorResponse(res, status, result.error, result.code);
  }
  // 201 when this request recorded the acknowledgement, 200 when it already existed.
  jsonResponse(res, result.created ? 201 : 200, { ok: true, created: result.created, item: result.item });
});

// POST /api/projects/:project/stranded-wraps/open-pr — open a pull request for
// one listed stranded wrap (#1545): { branch, headSha, remote?, confirm: true }.
// GitHub is read first (origin, the branch and its head, any open PR) and
// nothing is recorded unless `gh pr create` printed a PR URL. The PR targets
// the repository's default branch. Who opened it is the signed-in user, never
// a name from the body. Deleting a remote branch is deliberately not offered.
const OPEN_PR_STATUS = {
  NOT_FOUND: 404,
  IN_PROGRESS: 409,
  REMOTE_MISMATCH: 409,
  BRANCH_GONE: 409,
  BRANCH_MOVED: 409,
  PR_EXISTS: 409,
  NOT_GITHUB: 422,
  READ_FAILED: 502,
  CREATE_FAILED: 502,
  WRITE_FAILED: 500,
  // #1861 — the control gate's own answers.
  CONTROL_HELD: 423,
  CONTROL_STOPPED: 423,
  CONTROL_STATE_UNAVAILABLE: 503
};
route('POST', '/api/projects/:project/stranded-wraps/open-pr', async (req, res, params, body) => {
  const project = ownProjectCaller(req, res, params.project, _projectByIdOrName);
  if (!project) return;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }
  const by = (req.tcSession && req.tcSession.username) || null;
  const result = await strandedCheck.openPr(project, body, by);
  if (!result.ok) {
    const status = OPEN_PR_STATUS[result.code] || 400;
    return errorResponse(res, status, result.error, result.code, { prUrl: result.prUrl || null });
  }
  jsonResponse(res, 201, { ok: true, prUrl: result.prUrl, item: result.item });
});

// POST /api/projects
route('POST', '/api/projects', (req, res, _params, body) => {
  // Creating a project scaffolds a directory and registers it: the operator's (#1752).
  if (!operatorProjectCaller(req, res, 'create a project')) return;
  if (!body || !body.name) {
    return errorResponse(res, 400, 'name is required', 'BAD_REQUEST');
  }

  const result = projects.createProject(body);
  if (!result.project) {
    const code = result.errors[0] && result.errors[0].includes('already exists') ? 'CONFLICT' : 'BAD_REQUEST';
    return errorResponse(res, code === 'CONFLICT' ? 409 : 400, result.errors[0], code);
  }

  const response = {
    id: result.project.id,
    name: result.project.name,
    path: result.project.path,
    engine: result.project.engineId,
    tags: result.project.tags,
    ports: result.project.ports,
    createdAt: result.project.createdAt
  };

  if (result.errors.length > 0) {
    response.warnings = result.errors;
  }

  jsonResponse(res, 201, response);
});

// POST /api/projects/import — Register existing project directories
route('POST', '/api/projects/import', (req, res, _params, body) => {
  if (!operatorProjectCaller(req, res, 'import projects')) return;
  if (!body || !Array.isArray(body.names) || body.names.length === 0) {
    return errorResponse(res, 400, 'names array is required', 'BAD_REQUEST');
  }

  const config = store.config.load();
  const projectsDir = projects.resolveProjectsDir(config.projectsDir);
  const imported = [];
  const warnings = [];
  // Resolved once for the batch — see the bulk-attach route for why per-item
  // resolution is both slow (a detection probe per engine, per item) and wrong
  // (a mid-batch change in what is installed would split the batch across
  // engines).
  const importDefaultEngine = engines.resolveDefaultEngine(config)
    || config.defaultEngine
    || store.DEFAULT_CONFIG.defaultEngine;

  for (const name of body.names) {
    // #2180 — a name that fails shape validation (too long, disallowed
    // characters) must not reach `store.projects.create`, which would either
    // throw or register a row the rest of the product cannot address the
    // same way every other registration path does.
    const nameCheck = projects.validateName(name);
    if (!nameCheck.valid) {
      warnings.push(`Skipped "${name}": ${nameCheck.error}`);
      continue;
    }

    // Case-insensitive identity (#221) — symmetric with createProject /
    // attachProject so import can't introduce a case-collision the other
    // paths would reject.
    const existing = store.projects.getByNameCaseInsensitive(name);
    if (existing) {
      const msg = existing.name === name
        ? `"${name}" already registered`
        : `"${name}" already registered as "${existing.name}" (case-insensitive match)`;
      warnings.push(msg);
      continue;
    }

    const projPath = path.join(projectsDir, name);
    if (!fs.existsSync(projPath) || !fs.statSync(projPath).isDirectory()) {
      // Import registers; it does not delete. A missing directory used to
      // release every lease under the name, which destroyed correct leases for
      // owners that were never projects, such as a `brew services` database
      // (#1381). The leases stay; the warning says how to record what they are.
      const held = store.portLeases.getByProject(name).length;
      warnings.push(held > 0
        ? `"${name}" directory not found in ${projectsDir} — its ${held} port lease${held > 1 ? 's were' : ' was'} left in place. `
          + 'If it is not a TangleClaw project, mark it "Not a project".'
        : `"${name}" directory not found in ${projectsDir}`);
      continue;
    }

    // Prefer an installed engine over the configured default; fall back to that
    // default when nothing is installed (import is bookkeeping, not a launch).
    const engineId = importDefaultEngine;

    try {
      store.projects.create({
        name,
        path: projPath,
        engine: engineId,
        tags: [],
        ports: {}
      });

      // Write per-project config only when none is on disk — an existing (or
      // unusable) project.json is never clobbered by defaults (#2232).
      // Exclusive creation (`flag: 'wx'`) replaces a separate
      // existsSync-then-save: that pairing left a check-to-write race where a
      // file landing in the gap between the check and the write would be
      // silently overwritten; `wx` makes the write itself fail `EEXIST`
      // instead.
      const projConfigPath = path.join(projPath, '.tangleclaw', 'project.json');
      const projConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
      projConfig.engine = engineId;
      try {
        fs.mkdirSync(path.join(projPath, '.tangleclaw'), { recursive: true });
        fs.writeFileSync(projConfigPath, JSON.stringify(projConfig, null, 2) + '\n', { flag: 'wx' });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }

      imported.push(name);
    } catch (err) {
      warnings.push(`Failed to import "${name}": ${err.message}`);
    }
  }

  if (warnings.length > 0) {
    log.warn('Project import completed with skips', { imported: imported.length, count: warnings.length, warnings });
  }
  jsonResponse(res, 200, { imported, warnings });
});

// DELETE /api/projects/:name
route('DELETE', '/api/projects/:name', async (req, res, params, body) => {
  // Operator identity first, whatever the password says: an install that never
  // set one used to answer every caller here, `rm -rf` included (#1746). A set
  // password stays a second key on top.
  if (!operatorProjectCaller(req, res, 'delete a project')) return;
  const passwordCheck = projects.checkDeletePassword(body ? body.password : undefined);
  if (!passwordCheck.allowed) {
    return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');
  }

  const project = projects.getProjectRow(params.name);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.name}" not found`, 'NOT_FOUND');
  }

  const deleteFiles = body && body.deleteFiles === true;
  const result = projects.deleteProject(params.name, { deleteFiles });

  if (!result.success) {
    return errorResponse(res, 500, result.errors[0] || 'Delete failed', 'INTERNAL_ERROR');
  }

  jsonResponse(res, 200, {
    ok: true,
    name: params.name,
    filesDeleted: result.filesDeleted
  });
});

// POST /api/projects/:name/archive — Archive (deactivate) a project
route('POST', '/api/projects/:name/archive', (req, res, params) => {
  if (!operatorProjectCaller(req, res, 'archive a project')) return;
  const result = projects.archiveProject(params.name);
  if (!result.success) {
    const firstError = result.errors[0];
    const status = firstError.includes('not found') ? 404 : 400;
    return errorResponse(res, status, firstError, firstError.includes('not found') ? 'NOT_FOUND' : 'BAD_REQUEST');
  }
  jsonResponse(res, 200, { ok: true, name: params.name });
});

// POST /api/projects/:name/unarchive — Restore an archived project
route('POST', '/api/projects/:name/unarchive', (req, res, params, body) => {
  if (!operatorProjectCaller(req, res, 'unarchive a project')) return;
  const result = projects.unarchiveProject(params.name, {
    confirmFreshStart: Boolean(body && body.confirmFreshStart === true)
  });
  if (!result.success) {
    const firstError = result.errors[0];
    // #2401: a missing or placeholder-only path is a confirmable warning
    // (409, so the operator can retry with confirmFreshStart), not a 400 —
    // the request itself is well-formed, the PROJECT is the thing in a
    // state that needs an explicit yes.
    if (result.code === 'PROJECT_PATH_MISSING' || result.code === 'PROJECT_PATH_UNSEEDED') {
      return errorResponse(res, 409, firstError, result.code);
    }
    const status = firstError.includes('not found') ? 404 : 400;
    return errorResponse(res, status, firstError, firstError.includes('not found') ? 'NOT_FOUND' : 'BAD_REQUEST');
  }
  jsonResponse(res, 200, { ok: true, name: params.name });
});

// POST /api/projects/:name/migrate-to-plugin — Migrate a project to V2-plugin
// governance (#262, C1). Cohort-aware (non-Claude → not-applicable) + session-safe
// (defers on a live session; never auto-closes). Idempotent.
route('POST', '/api/projects/:name/migrate-to-plugin', async (req, res, params) => {
  // It rewrites the project's governance files; nothing but the operator calls it (#1752).
  if (!operatorProjectCaller(req, res, 'migrate a project to the plugin')) return;
  const result = await projects.migrateProjectToPlugin(params.name);
  if (result.error) {
    const notFound = result.error.includes('not found');
    return errorResponse(res, notFound ? 404 : 400, result.error, notFound ? 'NOT_FOUND' : 'BAD_REQUEST');
  }
  jsonResponse(res, 200, {
    ok: true,
    name: params.name,
    migrationStatus: result.status,
    migrated: result.migrated,
    deferred: result.deferred || false,
    alreadyGoverned: result.alreadyGoverned || false,
    reason: result.reason
  });
});

// PATCH /api/projects/:name
route('PATCH', '/api/projects/:name', async (req, res, params, body) => {
  // A project's own session may change its settings; only the operator may
  // change another project's, rename one (#1752), or choose its launch recovery
  // mode (#1937, below). A rename moves the
  // project's directory and changes the identity every live binding was
  // issued against, so it is more than that project's configuration.
  const renaming = body && typeof body === 'object' && body.name !== undefined && body.name !== params.name;
  // The recovery mode decides whether a session may clear its own launch gate,
  // so a session choosing it would be loosening its own gate (ADR 0017 R3a).
  // Refused on PRESENCE, not on a change of value, and before anything is
  // looked up or written, so no part of a request that names it is applied.
  // The operator's decision is recorded in the server store, which outranks
  // the copy of the value in the project's checkout.
  const launchBlock = body && typeof body === 'object' ? body.launchSequence : undefined;
  const choosingRecoveryMode = Boolean(launchBlock) && typeof launchBlock === 'object'
    && Object.prototype.hasOwnProperty.call(launchBlock, 'recoveryMode');
  let admitted;
  if (renaming) admitted = operatorProjectCaller(req, res, 'rename a project');
  else if (choosingRecoveryMode) admitted = operatorProjectCaller(req, res, 'choose a project\'s launch recovery mode');
  else admitted = ownProjectCaller(req, res, params.name, projects.getProjectRow);
  if (!admitted) return;
  // Choosing the mode is granting a session that loosening, so the operator
  // must be signed in (#2378). Asked on presence whichever branch admitted the
  // request: a rename that also names the mode carries the same choice. Both
  // such branches admit the operator alone.
  if (choosingRecoveryMode
    && !_requireSignedInOperator(req, res, { action: 'choose a project\'s launch recovery mode' })) return;
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }

  // The proof behind the decision goes with it into the store, in the words a
  // recovery clear is recorded with. It is read here, after the operator guard
  // above admitted the request: that guard takes a request with the
  // dashboard's shape as the operator wherever the login stands down, so the
  // caller kind it resolved would record "operator" for a request that
  // identified nobody.
  let result;
  try {
    result = await projects.updateProject(params.name, body, choosingRecoveryMode
      ? { recoveryDecisionBy: _operatorProofOf(req).clearance }
      : {});
  } catch (err) {
    // A failure thrown after the recovery decision reached the store — checked
    // FIRST, ahead of PROJECT_CONFIG_UNREADABLE below: a mid-apply config
    // reload can fail AFTER the store write lands (`_applyProjectUpdates`
    // reloads via `loadConfigForWrite` repeatedly), and that decision already
    // stands whatever this request answers with. Answering 409 first would
    // drop `recoveryDecisionSaved`/`recoveryMode` from the response and the
    // operator would read "config unreadable" with no sign the mode they just
    // chose was, in fact, saved and applies from the next launch. The
    // dispatcher would otherwise answer a bare 500 for this case, same risk.
    if (err.recoveryDecisionSaved) {
      log.error('A project update failed after its recovery-mode decision was saved', {
        project: params.name, error: err.message
      });
      return errorResponse(res, 500, `The update failed. ${err.recoveryDecisionSavedMessage}`,
        projects.RECOVERY_DECISION_SAVED_UPDATE_FAILED, { recoveryMode: err.recoveryDecisionSaved });
    }
    // #1289/#2232 — `project.json` became unreadable between the up-front load
    // and a reload inside phase two (a TOCTOU remove/permission change), with
    // no recovery decision in play. Unlike the up-front refusal below, phase
    // two writes as it goes rather than all at once: `_applyProjectUpdates`
    // writes the engine's on-disk config and re-syncs its hooks immediately,
    // and only batches the project row's `engine_id`/`tags` into a single
    // write at the very end. A reload that throws here can therefore land
    // AFTER the new engine's files already landed on disk but BEFORE the
    // project row was updated to match — the message says so, rather than
    // reading like the clean, nothing-written refusal the up-front check gives.
    if (err.code === projects.PROJECT_CONFIG_UNREADABLE) {
      return errorResponse(res, 409,
        `${err.message}. The project row's engine and tags are written last, after every other field in this `
        + 'request; if this request also changed the engine, its on-disk files may already be written while the '
        + 'project row still names the old engine.',
        projects.PROJECT_CONFIG_UNREADABLE);
    }
    // Any other throw is the dispatcher's, as before.
    throw err;
  }

  if (result.errors.length > 0 && !result.project) {
    const firstError = result.errors[0];
    // #1289 — the project's own `project.json` could not be read, before
    // anything was validated against it. Distinct from a validator's BAD_REQUEST:
    // the request may well have been fine, so 409 says the project's own state
    // is the obstacle, not the body.
    if (result.code === projects.PROJECT_CONFIG_UNREADABLE) {
      return errorResponse(res, 409, firstError, projects.PROJECT_CONFIG_UNREADABLE);
    }
    // A returned failure after the recovery decision reached the store (a
    // directory rename that would not move): the same statement, on the same
    // field, with the status the failure always had.
    if (result.recoveryDecisionSaved) {
      return errorResponse(res, 400, `${firstError}. ${result.recoveryDecisionSavedMessage}`,
        projects.RECOVERY_DECISION_SAVED_UPDATE_FAILED, { recoveryMode: result.recoveryDecisionSaved });
    }
    // The store write of the recovery mode failed: a server fault, not a
    // verdict on the request, and nothing was applied.
    if (result.code === projects.RECOVERY_DECISION_NOT_SAVED) {
      return errorResponse(res, 500, result.errors.join(' '), projects.RECOVERY_DECISION_NOT_SAVED);
    }
    // #1288 — branches on the structured code `updateProject` returns, not on
    // searching the message for "not found": an unknown engine or a missing
    // activePlan says "not found" too, and is a BAD_REQUEST on an existing
    // project, not a 404 that claims the project itself is gone.
    if (result.code === 'NOT_FOUND') {
      return errorResponse(res, 404, firstError, 'NOT_FOUND');
    }
    // #1697 — a validator may now name its own code (group release-ownership
    // conflict); 409 says the project's current group state is the obstacle,
    // not the request body (Architect B1).
    if (result.code === 'CONFLICT') {
      return errorResponse(res, 409, firstError, 'CONFLICT');
    }
    return errorResponse(res, 400, firstError, 'BAD_REQUEST');
  }

  const response = {
    id: result.project.id,
    name: result.project.name,
    engine: result.project.engine.id,
    tags: result.project.tags,
    silentPrime: result.project.silentPrime,
    medusaEnabled: result.project.medusaEnabled,
    medusaWake: result.project.medusaWake,
    provenanceWatermark: result.project.provenanceWatermark,
    defaultLaunchMode: result.project.defaultLaunchMode,
    showLaunchModePicker: result.project.showLaunchModePicker,
    updatedAt: result.project.updatedAt
  };

  // Partial failures of the update and after-the-fact warnings (#1148: the
  // LaunchAgents still naming a renamed project's old path) travel on the
  // same field — the dashboard renders one list, and both need the operator.
  const warnings = result.errors.concat(Array.isArray(result.warnings) ? result.warnings : []);
  if (warnings.length > 0) {
    response.warnings = warnings;
  }
  // Present only when the request chose the recovery mode (#1937). It is the
  // store's answer, with `fileWritten: false` when project.json could not be
  // written behind it, so a caller never has to parse the warning to learn
  // which half landed.
  if (result.recoveryMode) response.recoveryMode = result.recoveryMode;

  jsonResponse(res, 200, response);
});

// POST /api/projects/:name/actions/:command — Run a project action
// (#139 Chunk 11b). Body is the handler's `options` (forwarded verbatim;
// undefined when absent). Returns the handler's `{ok, output, error}` result.
// Status codes: 200 ok or handler-soft-fail; 400 bad request; 404 project /
// unknown or unavailable action; 500 handler thrown. Routing keys on the
// dispatcher's `code`, never on message text.
route('POST', '/api/projects/:name/actions/:command', async (req, res, params, body) => {
  // An action runs against the project's own checkout (the Critic, today), so
  // the operator or the project's own session may start one (#1752). This gate
  // admits project-scoped actions only: a fleet, identity, destructive-lifecycle
  // or operator action needs its own operator-only classification
  // (`lib/actions.js#ACTIONS`).
  if (!ownProjectCaller(req, res, params.name, projects.getProjectRow)) return;
  // #1861 — an action types into the project's own pane; a held lane takes no
  // injected work.
  const actionProject = store.projects.getByName(params.name);
  if (actionProject && controlRefused(res, { surface: `action:${params.command}`, subject: { kind: 'target', projectId: actionProject.id } })) return;
  const options = body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
  const result = await actions.runAction(params.name, params.command, options);

  if (!result.ok) {
    if (result.code === 'BAD_REQUEST') {
      return errorResponse(res, 400, result.error, 'BAD_REQUEST');
    }
    if (result.code === 'NOT_FOUND' || result.code === 'UNKNOWN_ACTION' || result.code === 'UNAVAILABLE') {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }
    if (result.code === 'HANDLER_THREW') {
      return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
    }
    // Soft fail (e.g. detached HEAD, missing project.path, fs error) —
    // return 200 with `ok:false` so the frontend can surface the
    // handler's specific error message inline.
    return jsonResponse(res, 200, result);
  }

  jsonResponse(res, 200, result);
});

// The session lifecycle routes are registered from their own module, at the
// position the first of them held, so the family keeps its order; the two gates,
// the startup prompt's proof options and the activity observer the handlers
// use still live here and are handed over.
require('./lib/routes/sessions').register({ controlRefused, coordinatorGateRefused, _startupPromptProofOptions, activityObserver });

// ── Medusa switchboard routes — one handler family, two mounts ──
//
// Every switchboard verb is the same handler whether the participant is a
// project session or the Project Master. What differs is how the caller's
// IDENTITY is resolved — a project's active session row, or the Master's tmux
// liveness — and whether its access level permits the outbound verbs. So the
// handlers are written once, against a resolver, and mounted twice:
// `/api/sessions/:project/medusa/*` and `/api/master/medusa/*`. A synthetic
// project row for the Master was the smaller diff and the wrong one: it would
// have leaked a non-project into listings, the dashboard and the fleet map.
//
// The resolver contract — `resolve(params, query)` returns one of:
//   { error: {status, message, code} }  the caller cannot be resolved at all
//                                       (unknown project);
//   { target: null, absent, fallbackSessionId? }
//                                       resolved, but nothing live to act for.
//                                       `absent` is the clause a 409 is built
//                                       from ("<absent> to <verb>"), so the
//                                       message names WHICH participant is
//                                       missing; `fallbackSessionId` is the
//                                       `?sessionId=` a read may still honor;
//   { target: {projectPath, sessionId, name, outbound: {allowed, reason}},
//     afterToggle? }                    live. `outbound` is the access-level
//                                       verdict for send/loop; `afterToggle`
//                                       persists a toggle for a participant
//                                       whose setting outlives its session.
//
// Routes that tolerate an absent target (status / messages / read) degrade to
// the `off` / empty shape; routes that need one (toggle / roster / send / the
// loop family) answer 409 `NO_SESSION`.

/**
 * Resolve a project session as a switchboard participant.
 * @param {object} params - Route params (`project`).
 * @param {object} [query] - Parsed query string.
 * @returns {object} A resolver result (contract above).
 */
function resolveProjectMedusaTarget(params, query) {
  const project = store.projects.getByName(params.project);
  if (!project) {
    return { error: { status: 404, message: `Project "${params.project}" not found`, code: 'NOT_FOUND' } };
  }
  const active = store.sessions.getActive(project.id);
  if (!active) {
    return {
      target: null,
      absent: 'No active session',
      enabled: _projectMedusaEnabled(project.path),
      fallbackSessionId: query && query.sessionId ? query.sessionId : null
    };
  }
  return {
    enabled: _projectMedusaEnabled(project.path),
    target: {
      projectPath: project.path,
      sessionId: active.id,
      name: project.name,
      // A project session's outbound is never gated here: its authority is the
      // operator's, exercised inside its own terminal.
      outbound: { allowed: true, reason: null }
    }
  };
}

/**
 * Is the switchboard turned on for this project?
 *
 * The durable per-project opt-in, distinct from whether a listener happens to
 * be running: it is what decides whether the session page shows the control at
 * all (#820). Unreadable config reads as OFF — a project whose settings cannot
 * be loaded has not opted in to anything.
 * @param {string} projectPath - Absolute project directory.
 * @returns {boolean}
 */
function _projectMedusaEnabled(projectPath) {
  try {
    const cfg = store.projectConfig.load(projectPath);
    return Boolean(cfg) && cfg.medusaEnabled === true;
  } catch (err) {
    log.warn('Could not read a project config for the Medusa gate — treating as off', { projectPath, error: err.message });
    return false;
  }
}

/**
 * Resolve the Project Master as a switchboard participant (#996). Liveness is
 * tmux truth, three-valued like everywhere else the Master is read: a silent
 * tmux is an UNKNOWN, refused with its own clause rather than flattened into
 * "not running".
 * @returns {object} A resolver result (contract above).
 */
function resolveMasterMedusaTarget() {
  const probe = master.masterLiveness();
  const masterEnabled = master.masterSettings(store.config.load()).medusaEnabled === true;
  if (!probe.answered) {
    return { target: null, enabled: masterEnabled, absent: 'tmux did not answer, so whether the Project Master is running is unknown; refusing' };
  }
  if (!probe.live) {
    return { target: null, enabled: masterEnabled, absent: 'The Project Master is not running, so there is no session' };
  }
  const settings = master.masterSettings(store.config.load());
  const level = settings.accessLevel;
  return {
    enabled: settings.medusaEnabled === true,
    target: { ...master.masterMedusaTarget(), outbound: master.masterMedusaOutbound(level) },
    // The Master is killed and restarted routinely (#968), and its bar toggle
    // is the only control it has — so a toggle persists, or the next restart
    // silently undoes the operator's click. A project's toggle is
    // session-scoped on purpose (its durable setting lives in project settings).
    afterToggle: (enabled) => {
      const config = store.config.load();
      config.master = { ...master.masterSettings(config), medusaEnabled: enabled };
      store.config.save(config);
    }
  };
}

/**
 * Who is calling, in the terms the exchange record uses (#1839). A verified
 * launch counts only for the participant's own project; the dashboard is
 * `operator-ui` when `asReader`, since opening the inbox panel is the
 * operator looking, not the agent.
 *
 * Module-scoped rather than nested in `registerMedusaRoutes` (which calls it
 * identically for both the project and the Master prefix): it closes over
 * nothing local to that function, so nesting it only built the same closure
 * twice and put the `projectId == null` guard below out of direct reach for
 * a test, since every consumer of its `master` kind independently re-derives
 * the same restriction from the exchange row or sender shape — exported as
 * `_exchangeCaller` so the guard itself can be tested directly.
 * @param {import('http').IncomingMessage} req - Request.
 * @param {number|null} projectId - The participant's project.
 * @param {boolean} [asReader] - Resolving a read or ack rather than a send.
 * @returns {object}
 */
function exchangeCaller(req, projectId, asReader = false) {
  const c = resolveControlCaller(req);
  if (c.kind === 'operator') {
    const proof = c.actor.operatorProof;
    return asReader && isOperatorShaped(req) ? { kind: 'operator-ui', proof } : { kind: 'operator', proof };
  }
  if (c.kind === 'project' && projectId != null && c.projectId === projectId) return { kind: 'project', projectId };
  // A verified Master launch has no project id, so the `project` branch
  // above can never match it (#1988): every Master caller fell through to
  // `unbound`, which is why a Master-addressed reply could never bind.
  // Scoped to `projectId == null` (the route's own TARGET has no project —
  // true only on the Master's own mount) so a Master-role caller hitting a
  // PROJECT's mount still resolves `unbound` there rather than being
  // credited as a verified sender of that project's mail.
  if (c.kind === 'master' && projectId == null) return { kind: 'master' };
  return { kind: 'unbound' };
}

/**
 * Mount the switchboard route family under `prefix`, resolving the
 * participant through `resolve`. Thin pass-throughs to lib/medusa; the
 * browser never talks to the Bridge directly.
 * @param {string} prefix - Route prefix, e.g. `/api/sessions/:project/medusa`.
 * @param {(params: object, query: object) => object} resolve - Participant resolver.
 * @returns {void}
 */
function registerMedusaRoutes(prefix, resolve) {
  /**
   * The project a resolved switchboard participant belongs to, or null (the
   * Project Master belongs to none).
   *
   * The Master is told apart by its reserved session key, never by its
   * display name: `masterMedusaTarget()` names it `'Project Master'`, and
   * project creation permits that exact string, so looking it up by name
   * would resolve to that colliding project's id instead of null for the
   * Master's own mount — a project with a valid launch of its own would then
   * pass `senderAuthRefused` on the Master's mount, sending from the
   * Master's listener while the exchange attributed the sender to that
   * project, and the Master's own launch would be refused.
   * @param {object|null} target - Resolved target.
   * @returns {number|null}
   */
  function targetProjectId(target) {
    if (!target || target.sessionId === master.MASTER_MEDUSA_KEY) return null;
    if (!target.name || !target.projectPath) return null;
    const project = store.projects.getByName(target.name);
    return project ? project.id : null;
  }

  /**
   * Answer an exchange refusal, or rethrow anything else.
   * @param {import('http').ServerResponse} res - Response.
   * @param {Error} err - The error.
   * @returns {void}
   */
  function exchangeRefusal(res, err) {
    if (!(err instanceof medusaExchanges.ExchangeError)) throw err;
    errorResponse(res, err.status, err.message, err.code, Object.keys(err.details || {}).length ? { details: err.details } : undefined);
  }

  /**
   * Answer the two refusal shapes. True when the route has already responded.
   * @param {import('http').ServerResponse} res - Response.
   * @param {object} r - Resolver result.
   * @param {string} verb - What the caller was trying to do, for the 409 clause.
   * @returns {boolean}
   */
  function refused(res, r, verb) {
    if (r.error) {
      errorResponse(res, r.error.status, r.error.message, r.error.code);
      return true;
    }
    if (!r.target) {
      errorResponse(res, 409, `${r.absent} to ${verb}`, 'NO_SESSION');
      return true;
    }
    return false;
  }

  /**
   * The outbound gate — 403 `ACCESS_LEVEL` when the participant's level can
   * receive but not send. True when the route has already responded.
   * @param {import('http').ServerResponse} res - Response.
   * @param {object} target - Resolved target.
   * @returns {boolean}
   */
  function outboundRefused(res, target) {
    if (target.outbound && target.outbound.allowed === false) {
      errorResponse(res, 403, target.outbound.reason, 'ACCESS_LEVEL');
      return true;
    }
    return false;
  }

  /**
   * The sender-identity gate on `/send` (#1865, #1875) — refused before the
   * Hub ever sees the message, never just labelled after the fact. The URL's
   * `:project` segment is a destination, not a credential: this re-derives
   * the same verdict `exchangeCaller` computes for attribution and acts on
   * it. `senderProjectId` is this mount's own identity (null on the Master's
   * mount), so a caller must be verified for THIS route, not merely verified
   * for some project or the Master. True when the route has already responded.
   *
   * `/send` is a mutating route, so `lib/launch-binding-guard.js` (#2233)
   * already refuses an unbound or stale/ended/superseded launch before the
   * dispatcher ever reaches this handler — that floor is caller-agnostic
   * about which route is being called, not sender-aware. What it does NOT
   * check is whether the caller's OWN verified project or Master identity
   * matches THIS route's: a project with a perfectly current launch of its
   * own, or a verified Master, both pass that floor regardless of whose
   * `/send` they hit. This gate is what closes that remaining gap, so the
   * `unbound` branch below is believed unreachable via HTTP today — kept as
   * the explicit, direct contract P13 names, and as a seam this function
   * keeps working correctly if that floor's route list ever changes.
   * @param {import('http').ServerResponse} res - Response.
   * @param {import('http').IncomingMessage} req - Request.
   * @param {number|null} senderProjectId - The project this mount sends as (null on the Master's mount).
   * @returns {boolean}
   */
  function senderAuthRefused(res, req, senderProjectId) {
    const c = resolveControlCaller(req);
    if (c.kind === 'operator') return false;
    if (c.kind === 'project' && senderProjectId != null && c.projectId === senderProjectId) return false;
    if (c.kind === 'master' && senderProjectId == null) return false;
    if (c.kind === 'unbound') {
      errorResponse(res, 403,
        'Sending needs a verified launch — send x-tangleclaw-launch-id and x-tangleclaw-project-id (tc message send does this for you).',
        'SENDER_LAUNCH_REQUIRED');
      return true;
    }
    // Something verified was presented (another project's own current launch,
    // or a verified Master) but it is not THIS route's own participant: a
    // cross-project send, or a Master/project claim on the other's mount.
    errorResponse(res, 403, "Your verified launch does not send as this route's participant.", 'SENDER_PROJECT_MISMATCH');
    return true;
  }

  // GET <prefix>/status — listener status (MED-2K9P Chunk 01). No live
  // participant → an `off` status (a `?sessionId=` query is honored as a
  // fallback for a project with no active session). MED-2K9P v2 T4: the
  // response also carries `loops` — the participant's known loops with live
  // Bridge state — so the banner loop view rides the existing status poll (no
  // new timer). A Bridge failure during the loop fetch degrades honestly:
  // `loops: []` plus a `loopsError` naming the reason, never a silent empty
  // list; the listener status itself is still returned.
  route('GET', `${prefix}/status`, async (req, res, params) => {
    const r = resolve(params, parseQuery(reqUrl(req).search));
    if (r.error) return errorResponse(res, r.error.status, r.error.message, r.error.code);
    const sessionId = r.target ? r.target.sessionId : (r.fallbackSessionId || null);
    const status = medusa.getStatus(sessionId);
    let loops = [];
    let loopsError = null;
    if (sessionId != null && status.state !== 'off') {
      try {
        loops = await medusa.getLoops({ sessionId });
      } catch (err) {
        loopsError = err.message;
      }
    }
    // The outbound verdict travels with the status so a control can render a
    // disabled send WITH its reason rather than discovering the 403 on click.
    const outbound = r.target ? r.target.outbound : { allowed: true, reason: null };
    // `enabled` is the DURABLE opt-in, not "is a listener running" — the control
    // is only shown where the operator turned the switchboard on (#820). It
    // rides the status because that is the one fetch every surface already makes,
    // and because both mounts must gate on the same predicate rather than each
    // page deciding for itself.
    const enabled = r.enabled === true;
    // The message body cap rides the same fetch, so a compose box can count
    // against the limit the send will actually meet (#1514).
    const base = { ...status, loops, outbound, enabled, messageLimitBytes: MESSAGE_BODY_LIMIT_BYTES };
    jsonResponse(res, 200, loopsError ? { ...base, loopsError } : base);
  });

  // POST <prefix>/toggle — start or stop the participant's listener (MED-2K9P
  // Chunk 02). Body `{enabled}` sets the desired state explicitly (idempotent —
  // safe against double-clicks); omitted → flips the current state. Returns the
  // resulting status.
  route('POST', `${prefix}/toggle`, async (_req, res, params, body) => {
    const r = resolve(params);
    if (refused(res, r, 'toggle Medusa for')) return;
    // #2032: a stale coordinator context must not switch its switchboard off
    // or on. While reconciling, the bound replacement may only turn it ON, and
    // only by saying so (`enabled: true`): resuming needs a listener, but
    // turning one off is an authority change that waits for the resume.
    if (coordinatorGateRefused(_req, res, targetProjectId(r.target), 'medusa-listener', { enable: body && body.enabled === true })) return;
    const { target } = r;
    const isOn = medusa.getStatus(target.sessionId).state !== 'off';
    const desired = (body && typeof body.enabled === 'boolean') ? body.enabled : !isOn;
    // Preflight on the way ON, and it does NOT gate the toggle (#1130, operator
    // decision 2026-09-08). The listener still starts and still retries, because a
    // retrying listener registers by itself once the Bridge appears and a refused
    // toggle starts nothing to retry. What the probe buys is the diagnosis: the
    // verdict rides back on this response, so the control can say "no Bridge here,
    // and here is how to fix it" at the moment of the click rather than leaving
    // the operator to read a generic reconnect loop.
    let bridge;
    if (desired) {
      // Start FIRST, then probe: the listener spends the preflight's wall time
      // connecting instead of waiting for it, and the verdict is a diagnosis
      // rather than a gate (operator decision, 2026-09-08).
      medusa.startSession({ projectPath: target.projectPath, sessionId: target.sessionId, name: target.name });
      try {
        bridge = await medusa.checkBridgeHealth();
      } catch (err) {
        // prawduct:allow prawduct/broad-except -- checkBridgeHealth is documented and
        // tested as never throwing, but the dispatcher turns any rejection into a
        // 500, which would refuse a toggle whose listener has already started —
        // arriving at refuse-when-absent by accident, the posture the 2026-09-08
        // decision explicitly rejected. The diagnosis is optional; the toggle is not.
        log.warn('Medusa Bridge preflight failed; toggling on without a verdict', {
          session: target.sessionId, error: err.message
        });
      }
    } else {
      medusa.stopSession(target.sessionId);
    }
    if (typeof r.afterToggle === 'function') r.afterToggle(desired);
    // `bridge` is present only when one was taken. A `null` on the way OFF would
    // read as "we looked and found nothing" for a path that never looked.
    const status = medusa.getStatus(target.sessionId);
    jsonResponse(res, 200, bridge ? { ...status, bridge } : status);
  });

  // GET <prefix>/messages — the received inbox (MED-2K9P Chunk 02). It never
  // marks mail handled or clears unread. For any other reader it records a
  // `read` fact for what it returned (#1839); for the dashboard (`operator-ui`)
  // it records nothing, because a read fact changes the exchange: it ends
  // awaiting-read and wake re-arms, and forbids a retract. The inbox panel
  // calls this route and nothing else, so viewing mail never acts for the
  // agent (#1987). No live participant → an empty inbox.
  route('GET', `${prefix}/messages`, (req, res, params) => {
    const r = resolve(params, parseQuery(reqUrl(req).search));
    if (r.error) return errorResponse(res, r.error.status, r.error.message, r.error.code);
    const sessionId = r.target ? r.target.sessionId : (r.fallbackSessionId || null);
    const messages = sessionId == null ? [] : medusa.getMessages(sessionId);
    // #1839: record what was actually shown to the reader, and who read it.
    // The dashboard records nothing (#1987): recordRead ignores `operator-ui`,
    // and a browser-shaped request that is not the agent's verified launch is
    // treated as the dashboard too, so an auth gate in fallback or unreadable
    // (the operator unproven) does not turn viewing into an unverified read.
    // Presenting that shape can only suppress a read record, never forge one.
    const reader = r.target && messages.length > 0 ? exchangeCaller(req, targetProjectId(r.target), true) : null;
    const viewing = reader && reader.kind !== 'project' && isOperatorShaped(req);
    if (reader && !viewing) {
      try {
        medusaExchanges.recordRead(messages.map((m) => m && m.id).filter(Boolean),
          medusa.getStatus(sessionId).workspaceId, reader);
      } catch (err) { // prawduct:allow prawduct/broad-except -- a failed read record must not withhold the inbox from its reader
        log.warn('Could not record Medusa reads', { sessionId: String(sessionId), error: err.message });
      }
    }
    jsonResponse(res, 200, { messages });
  });

  // POST <prefix>/read — two verbs on one route, told apart by the body.
  //
  // With `{ids: [...]}` the caller is reporting those messages HANDLED: they
  // leave the inbox and are ACKed to the Hub, which drops its durable copies.
  // With no body it is only a badge clear — the counter resets and nothing is
  // discarded anywhere. The bodyless form used to ACK everything, which meant
  // opening the inbox panel destroyed the last copy of what it displayed (#785).
  // Idempotent both ways; no listener is a safe no-op.
  route('POST', `${prefix}/read`, (req, res, params, body) => {
    const r = resolve(params);
    if (r.error) return errorResponse(res, r.error.status, r.error.message, r.error.code);
    const sessionId = r.target ? r.target.sessionId : null;
    if (coordinatorGateRefused(req, res, targetProjectId(r.target), 'medusa-ack',
      { messageIds: body && Array.isArray(body.ids) ? body.ids : null })) return;
    if (sessionId != null) {
      const ids = body && Array.isArray(body.ids) ? body.ids : null;
      if (ids) medusa.markHandled(sessionId, ids);
      else medusa.markRead(sessionId);
      // #1839: handled mail is acknowledged, recorded as whoever handled it.
      if (ids) {
        try {
          medusaExchanges.recordAcknowledged(ids.filter((id) => typeof id === 'string'),
            medusa.getStatus(sessionId).workspaceId, exchangeCaller(req, targetProjectId(r.target), true));
        } catch (err) { // prawduct:allow prawduct/broad-except -- the Hub ACK already happened; a failed record is logged, never turned into a failed read
          log.warn('Could not record Medusa acknowledgements', { sessionId: String(sessionId), error: err.message });
        }
      }
      // #1861: a control notice marked handled is the target observing it.
      // `targetProjectId` (not an independent by-name lookup) so the Master's
      // own mount is never mistaken for a project named 'Project Master'.
      const readerProjectId = ids ? targetProjectId(r.target) : null;
      if (readerProjectId) controlApi.noticesHandled(ids, readerProjectId);
    }
    jsonResponse(res, 200, medusa.getStatus(sessionId));
  });

  // GET <prefix>/deliveries — what became of every nudge for this participant's
  // inbox (#792). The route exists so "was this session ever told about its
  // mail" is answerable from outside the session, which is exactly what was
  // missing when the operator had to relay badges by hand.
  route('GET', `${prefix}/deliveries`, (req, res, params) => {
    const query = parseQuery(reqUrl(req).search);
    const r = resolve(params, query);
    if (r.error) return errorResponse(res, r.error.status, r.error.message, r.error.code);
    const sessionId = r.target ? r.target.sessionId : (r.fallbackSessionId || null);
    if (sessionId == null) return jsonResponse(res, 200, { deliveries: [] });
    const limit = query && query.limit ? Number(query.limit) : undefined;
    return jsonResponse(res, 200, {
      deliveries: store.medusaDeliveries.listForSession(sessionId, { limit })
    });
  });

  /**
   * The gate for READING about peers — the roster and a peer's reachability.
   *
   * One function for both routes so they cannot drift: whatever may list the
   * roster may ask why a peer on it is silent, and nothing else may. A live
   * participant is required (404 unknown / 409 none live), and the outbound
   * access level deliberately is NOT consulted — a read-only Master can still
   * list peers, so it can still ask about them. The front-door gate
   * (`lib/auth-gate.js`) runs ahead of every route and applies to both alike.
   * @param {object} params - Route params.
   * @param {import('http').ServerResponse} res - Response.
   * @param {string} verb - What the caller was trying to do, for the 409 clause.
   * @returns {object|null} The resolved target, or null when already answered.
   */
  function peerReadTarget(params, res, verb) {
    const r = resolve(params);
    return refused(res, r, verb) ? null : r.target;
  }

  // GET <prefix>/roster — the live roster of other registered workspaces this
  // participant can message (MED-2K9P Chunk 03), proxied from the Bridge
  // (`GET /workspaces`) with the caller's own workspace excluded. Requires a
  // live participant (409).
  route('GET', `${prefix}/roster`, async (_req, res, params) => {
    const target = peerReadTarget(params, res, 'list a roster for');
    if (!target) return;
    try {
      const workspaces = await medusa.getRoster({ sessionId: target.sessionId });
      jsonResponse(res, 200, { workspaces });
    } catch (err) {
      errorResponse(res, err.httpStatus || 502, err.message, err.code || 'MEDUSA_ROSTER_FAILED');
    }
  });

  // GET <prefix>/peers/:workspaceId — why a peer has not picked up its mail
  // (#918). The wake monitor's latest in-memory verdict on the LOCAL session
  // holding that workspace id, as a reason code with the time it was observed —
  // never pane text. A workspace no TangleClaw session on this host holds is
  // `local: false`: its pane is not ours to read, and nothing is guessed.
  // Gated exactly as the roster is (`peerReadTarget`).
  route('GET', `${prefix}/peers/:workspaceId`, (_req, res, params) => {
    const target = peerReadTarget(params, res, 'check a peer for');
    if (!target) return;
    try {
      jsonResponse(res, 200, medusaWake.peerReachability(params.workspaceId));
    } catch (err) {
      // prawduct:allow prawduct/broad-except -- the store read behind the
      // session list can throw anything; the caller gets the failure named,
      // never a verdict assembled from half a lookup.
      log.warn('Peer reachability lookup failed', { workspaceId: params.workspaceId, error: err.message });
      errorResponse(res, 500, `Could not resolve peer reachability: ${err.message}`, 'PEER_STATUS_FAILED');
    }
  });

  // POST <prefix>/send — send a direct message to another workspace (MED-2K9P
  // Chunk 03). Body `{ to, message }`. Requires a live participant (409), a
  // verified sender identity for THIS mount (403 — #1865, #1875), and a
  // level that may send (403). Returns the HONEST result — `received`
  // (delivered live) or `queued` (recipient offline) — never a blanket
  // "sent"; validation and Bridge failures surface as errors, not false
  // successes.
  //
  // #1839: the body may also carry delivery metadata (`priority`,
  // `replyRequired`, `escalateAfterMinutes`, `reason`, `inReplyTo`,
  // `requestId`). The exchange is recorded before the Hub is called and bound
  // to the Hub's id afterwards; a send whose Hub outcome is lost is reported as
  // `send_unknown` and is never re-sent, including when the same `requestId`
  // comes back.
  route('POST', `${prefix}/send`, async (req, res, params, body) => {
    const r = resolve(params);
    if (refused(res, r, 'send from')) return;
    const senderProjectId = targetProjectId(r.target);
    if (senderAuthRefused(res, req, senderProjectId)) return;
    if (outboundRefused(res, r.target)) return;
    // #2032: a coordinator bound to a rotation epoch sends only from its bound
    // replacement thread, and while reconciling only replies within its
    // checkpoint's interval.
    if (coordinatorGateRefused(req, res, senderProjectId, 'medusa-send', { inReplyTo: body && body.inReplyTo })) return;
    const out = await medusaSend.sendTracked({
      sessionId: r.target.sessionId, senderProjectId, caller: exchangeCaller(req, senderProjectId), body
    });
    jsonResponse(res, out.status, out.body);
  }, { maxBodySize: MESSAGE_BODY_LIMIT_BYTES });

  // GET <prefix>/exchanges — this participant's Medusa exchanges (#1839):
  // `?direction=sent` (default) or `received`, `?open=1` for unfinished only.
  // States and metadata only; never a message body.
  route('GET', `${prefix}/exchanges`, (req, res, params) => {
    const query = parseQuery(reqUrl(req).search);
    const r = resolve(params, query);
    if (refused(res, r, 'list exchanges for')) return;
    const openOnly = query.open === '1' || query.open === 'true';
    const limit = query.limit !== undefined ? Number(query.limit) : undefined;
    let rows;
    if (query.direction === 'received') {
      const workspaceId = medusa.getStatus(r.target.sessionId).workspaceId;
      rows = workspaceId ? store.medusaExchanges.listForRecipient(workspaceId, { openOnly, limit }) : [];
    } else {
      const projectId = targetProjectId(r.target);
      rows = projectId != null ? store.medusaExchanges.listForSender(projectId, { openOnly, limit }) : [];
    }
    jsonResponse(res, 200, { exchanges: rows.map(medusaExchanges.view) });
  });

  // POST <prefix>/exchanges/:exchangeId/close — the initiator ends an exchange
  // (#1839). Only a verified launch of the sending project, a verified Master
  // launch on the Master's own mount (for what the Master sent), or the operator.
  route('POST', `${prefix}/exchanges/:exchangeId/close`, (req, res, params) => {
    const r = resolve(params);
    if (refused(res, r, 'close an exchange for')) return;
    if (coordinatorGateRefused(req, res, targetProjectId(r.target), 'exchange-close', { exchangeId: params.exchangeId })) return;
    const row = store.medusaExchanges.get(params.exchangeId);
    if (!row) return errorResponse(res, 404, 'No exchange has that id', 'EXCHANGE_NOT_FOUND');
    const masterMount = r.target.sessionId === master.MASTER_MEDUSA_KEY;
    const caller = masterMount && resolveControlCaller(req).kind === 'master'
      ? { kind: 'master' }
      : exchangeCaller(req, targetProjectId(r.target));
    try {
      jsonResponse(res, 200, { exchange: medusaExchanges.view(medusaExchanges.close(row.exchange_id, caller)) });
    } catch (err) {
      exchangeRefusal(res, err);
    }
  });

  // POST <prefix>/loop — open a Medusa loop to a target workspace (MED-2K9P v2
  // T3, the setup modal's launch). Body `{ target, task, doneCriteria, mode,
  // guards }`. Requires a live participant (409) whose level may send (403).
  // Returns `{ loop }` — the created loop object; the Bridge itself delivers
  // the loopInvite to the target (durably queued, pushed live when the target
  // is online — Medusa#47 fixed upstream, so TC's out-of-band task notice was
  // dropped, TC#552). Validation and Bridge failures surface as errors, never a
  // false "launched".
  route('POST', `${prefix}/loop`, async (_req, res, params, body) => {
    const r = resolve(params);
    if (refused(res, r, 'open a loop from')) return;
    if (outboundRefused(res, r.target)) return;
    // #2032: opening a loop is new dispatch, gated like a send.
    if (coordinatorGateRefused(_req, res, targetProjectId(r.target), 'medusa-loop')) return;
    try {
      const result = await medusa.openLoop({
        sessionId: r.target.sessionId,
        target: body && body.target,
        task: body && body.task,
        doneCriteria: body && body.doneCriteria,
        mode: body && body.mode,
        guards: body && body.guards
      });
      jsonResponse(res, 200, result);
    } catch (err) {
      errorResponse(res, err.httpStatus || 502, err.message, err.code || 'MEDUSA_LOOP_FAILED');
    }
  }, { maxBodySize: MESSAGE_BODY_LIMIT_BYTES });

  // POST <prefix>/loops/:loopId/force-done — the human kill-switch on a loop
  // this participant initiated (MED-2K9P v2 T4). Rides the Bridge's
  // initiator-only close with a structured `closeSignal.reason: 'force-done'`
  // (the Bridge reserves `halted` for its own runaway guards — no external halt
  // transition exists). Bridge rejections pass through with their real status:
  // 403 = not the initiator (the control invariant), 400 = already complete or
  // guard-halted ("a halted loop cannot be closed"), 404 = the Bridge no longer
  // knows the loop.
  route('POST', `${prefix}/loops/:loopId/force-done`, async (_req, res, params) => {
    const r = resolve(params);
    if (refused(res, r, 'end a loop from')) return;
    if (outboundRefused(res, r.target)) return;
    if (coordinatorGateRefused(_req, res, targetProjectId(r.target), 'medusa-loop')) return;
    try {
      const result = await medusa.forceDoneLoop({ sessionId: r.target.sessionId, loopId: params.loopId });
      jsonResponse(res, 200, result);
    } catch (err) {
      errorResponse(res, err.httpStatus || 502, err.message, err.code || 'MEDUSA_FORCE_DONE_FAILED');
    }
  });

  // POST <prefix>/loops/:loopId/continue — send an initiator FEEDBACK round to
  // continue a supervised loop this participant initiated (TC#561 — the
  // FEEDBACK half of the design §1 control spine). Body `{ message }`. Rides
  // the Bridge's `POST /loops/:id/message`; valid only once the target has
  // responded (`state === 'responded'`) — a wrong-state click surfaces the
  // Bridge's 400 verbatim, never a false "sent".
  route('POST', `${prefix}/loops/:loopId/continue`, async (_req, res, params, body) => {
    const r = resolve(params);
    if (refused(res, r, 'continue a loop from')) return;
    if (outboundRefused(res, r.target)) return;
    if (coordinatorGateRefused(_req, res, targetProjectId(r.target), 'medusa-loop')) return;
    try {
      const result = await medusa.continueLoop({ sessionId: r.target.sessionId, loopId: params.loopId, message: body && body.message });
      jsonResponse(res, 200, result);
    } catch (err) {
      errorResponse(res, err.httpStatus || 502, err.message, err.code || 'MEDUSA_CONTINUE_FAILED');
    }
  }, { maxBodySize: MESSAGE_BODY_LIMIT_BYTES });

  // POST <prefix>/loops/:loopId/closeout — the SATISFIED closeout of a loop
  // this participant initiated (TC#561 — the CLOSEOUT half of the control
  // spine). Distinct from force-done (the kill-switch): rides the Bridge close
  // with `closeSignal.reason: 'satisfied'` so the outcome is labeled "ended —
  // marked done", not "ended by force-done". Same initiator-only (403) /
  // already-closed (400) / unknown (404) passthrough.
  route('POST', `${prefix}/loops/:loopId/closeout`, async (_req, res, params) => {
    const r = resolve(params);
    if (refused(res, r, 'close a loop from')) return;
    if (outboundRefused(res, r.target)) return;
    if (coordinatorGateRefused(_req, res, targetProjectId(r.target), 'medusa-loop')) return;
    try {
      const result = await medusa.closeoutLoop({ sessionId: r.target.sessionId, loopId: params.loopId });
      jsonResponse(res, 200, result);
    } catch (err) {
      errorResponse(res, err.httpStatus || 502, err.message, err.code || 'MEDUSA_CLOSEOUT_FAILED');
    }
  });
}

registerMedusaRoutes('/api/sessions/:project/medusa', resolveProjectMedusaTarget);

// #1839: every message a listener on this host receives is recorded against
// the exchange its sender opened here, or as an untracked arrival. Keyed by the
// Hub's message id; nothing is matched by order or body.
medusa.setArrivalObserver(({ sessionKey, workspaceId, message }) => {
  try {
    if (message && typeof message.id === 'string') {
      const session = /^\d+$/.test(sessionKey) ? store.sessions.get(Number(sessionKey)) : null;
      medusaExchanges.recordArrival({
        hubId: message.id,
        recipientWorkspaceId: workspaceId,
        recipientProjectId: session ? session.projectId : null,
        recipientSessionId: session ? sessionKey : null,
        senderWorkspaceId: typeof message.from === 'string' ? message.from : null
      });
      // The operator bridge's gateway is the one listener that is not a session:
      // what arrives for it is a held reply or nothing (ADR 0023).
      if (sessionKey === bridgeGateway.GATEWAY_KEY) {
        try {
          bridgeGateway.drainInbox();
        } catch (err) {
          log.warn('Operator bridge could not process an arrival', { error: err.message });
        }
      }
      // #2323: a check watch message names its own send on its last line, and
      // reaches its recipient before the Hub has answered that send, so the
      // monitor binds it here. After the arrival is recorded, so the bind
      // adopts that record. It never throws.
      checkWatch.noteArrival({ sessionKey, workspaceId, message });
    }
  } finally {
    // #2086: mail has arrived, so the wake monitor looks at this session now
    // and not up to an interval later. After the arrival is recorded, so the
    // look's verdict lands on an exchange that exists; and whether or not the
    // record could be written, because the listener holds the mail either way.
    // The look runs on a later turn of the event loop and passes every wake
    // gate. Asking cannot fail the arrival: the request is contained here.
    // For the bridge gateway's key there is no session, so the look finds
    // nothing to look at and does nothing.
    try {
      medusaWake.requestScan(sessionKey, 'mail-arrived');
    } catch (err) {
      log.warn('Could not ask the wake monitor for a scan', { sessionId: sessionKey, error: err.message });
    }
  }
});

// ── Control state (#1861): durable HOLD / RELEASE / STOP ──
//
// The handlers live in lib/control-api.js. This wrapper writes the response
// first and only then attempts the Medusa notice, because "accepted" must mean
// "stored": a notice that fails is recorded, and never undoes the command.

/**
 * Register one control route.
 * @param {string} method - HTTP method
 * @param {string} pattern - Route pattern
 * @param {(req: object, params: object, body: object) => {status: number, body: object, notify: (object|null)}} fn - Handler
 * @param {string|null} [gatedAction] - The coordinator epoch gate action this route is (#2032), or null
 * @param {object} [options] - The route's registration options, passed to `route`
 * @returns {void}
 */
function controlRoute(method, pattern, fn, gatedAction = null, options) {
  route(method, pattern, (req, res, params, body) => {
    // #2032: a coordinator bound to a rotation epoch issues control only from
    // its bound replacement thread; while reconciling, only the ack.
    if (gatedAction && coordinatorGateRefused(req, res, _callerProjectId(req), gatedAction)) return;
    let out;
    try {
      out = fn(req, params, body);
    } catch (err) { // prawduct:allow prawduct/broad-except -- a control command that did not commit must never read as accepted: a ControlError keeps its own status, and anything else (the store threw) is the fail-closed 503
      if (err instanceof controlState.ControlError) {
        return errorResponse(res, err.status, err.message, err.code, err.details);
      }
      log.error('Control state unavailable', { method, pattern, error: err.message });
      return errorResponse(res, 503, 'control state is unavailable; nothing was changed', 'CONTROL_STATE_UNAVAILABLE');
    }
    jsonResponse(res, out.status, out.body);
    if (out.notify) controlApi.notify(out.notify);
  }, options);
}

controlRoute('GET', '/api/control/assignments', (req) => controlApi.listOpen(req));
controlRoute('POST', '/api/control/assignments', (req, _params, body) => controlApi.createAssignment(req, body), 'control-mutate');
controlRoute('GET', '/api/control/assignments/:id', (req, params) => controlApi.getStatus(req, params));
controlRoute('POST', '/api/control/assignments/:id/hold', (req, params, body) => controlApi.holdAssignment(req, params, body), 'control-mutate');
controlRoute('POST', '/api/control/assignments/:id/release', (req, params, body) => controlApi.releaseAssignment(req, params, body), 'control-mutate',
  { signedInOperator: { action: 'release a HOLD or STOP' } });
controlRoute('POST', '/api/control/assignments/:id/stop', (req, params, body) => controlApi.stopAssignment(req, params, body), 'control-mutate');
controlRoute('POST', '/api/control/assignments/:id/close', (req, params, body) => controlApi.closeAssignment(req, params, body), 'control-mutate',
  { signedInOperator: { action: 'close a control assignment' } });
controlRoute('POST', '/api/control/assignments/:id/ack', (req, params, body) => controlApi.ackAssignment(req, params, body), 'control-ack');
controlRoute('POST', '/api/control/assignments/:id/exchange-closed', (req, params, body) => controlApi.closeExchange(req, params, body), 'control-mutate');
controlRoute('GET', '/api/control/mine', (req) => controlApi.mine(req));
controlRoute('GET', '/api/control/check', (req) => controlApi.check(parseQuery(reqUrl(req).search)));

// ── Merge queue (#2322): make a queue, submit, read, withdraw, advance, record the Operator gate, clear a halt ──
//
// The handlers live in lib/merge-queue-api.js. Only an advance by the queue's owner lands anything.

/**
 * Register one merge queue route.
 * @param {string} method - HTTP method
 * @param {string} pattern - Route pattern
 * @param {(req: object, params: object, body: object) => ({status: number, body: object}|Promise<{status: number, body: object}>)} fn - Handler
 * @param {object} [options] - The route's registration options, passed to `route`
 * @returns {void}
 */
function mergeQueueRoute(method, pattern, fn, options) {
  route(method, pattern, async (req, res, params, body) => {
    let out;
    try {
      out = await fn(req, params, body);
    } catch (err) { // prawduct:allow prawduct/broad-except -- a queue request that did not finish must never read as accepted: a QueueError keeps its own status and code, and anything else (the store threw) is the fail-closed 503
      if (err instanceof mergeQueueApi.QueueError) {
        return errorResponse(res, err.status, err.message, err.code, err.details);
      }
      log.error('Merge queue unavailable', { method, pattern, error: err.message });
      return errorResponse(res, 503, 'The merge queue could not answer. Read the queue again before repeating the request.', 'MERGE_QUEUE_UNAVAILABLE');
    }
    jsonResponse(res, out.status, out.body);
  }, options);
}

mergeQueueRoute('POST', '/api/merge-queue', (req, _params, body) => mergeQueueApi.createQueue(req, body),
  { signedInOperator: { action: 'create a merge queue and name its owner' } });
mergeQueueRoute('GET', '/api/merge-queue', (req) => mergeQueueApi.listQueues(req));
mergeQueueRoute('GET', '/api/merge-queue/entries/:id', (req, params) => mergeQueueApi.getEntry(req, params));
mergeQueueRoute('POST', '/api/merge-queue/entries', (req, _params, body) => mergeQueueApi.submit(req, body));
mergeQueueRoute('POST', '/api/merge-queue/entries/:id/withdraw', (req, params, body) => mergeQueueApi.withdraw(req, params, body));
mergeQueueRoute('POST', '/api/merge-queue/advance', (req, _params, body) => mergeQueueApi.advance(req, body));
mergeQueueRoute('POST', '/api/merge-queue/:id/clear-halt', (req, params, body) => mergeQueueApi.clearHalt(req, params, body),
  { signedInOperator: { action: 'clear a merge queue\'s halt' } });
mergeQueueRoute('POST', '/api/merge-queue/entries/:id/operator-gate', (req, params, body) => mergeQueueApi.recordOperatorGate(req, params, body),
  { signedInOperator: { action: 'record the operator\'s merge gate' } });
mergeQueueRoute('POST', '/api/merge-queue/entries/:id/settle-landing', (req, params, body) => mergeQueueApi.settleLanding(req, params, body),
  { signedInOperator: { action: 'settle a merge queue landing' } });
// The Master's mount (#996). Deliberately the SAME family rather than a subset:
// the outbound gate, not a missing route, is what a read-only Master meets.
registerMedusaRoutes('/api/master/medusa', resolveMasterMedusaTarget);


// The launch recovery routes are registered from their own module, at the
// position they held; nothing the handlers use still lives here.
require('./lib/routes/launch-recovery').register();

/**
 * The operator-proof options for a startup prompt write, worded for the action.
 * @param {string} action - What is attempted, completing "... to <action>".
 * @param {object} logContext - Extra log fields.
 * @returns {object} Options for `_requireOperatorWrite`.
 */
function _startupPromptProofOptions(action, logContext) {
  return {
    logEvent: `Refused to ${action}`,
    logContext,
    fallbackAction: action,
    sameOriginWhat: 'A startup prompt change',
    unauthenticated: `Sign in to ${action}: this install requires a login, and the startup prompt is the `
      + "operator's to change and fire.",
    machineClient: `Only the operator may ${action} this way, and a local process is not the operator. `
      + 'An agent session fires through its own launch binding, and only when the operator listed its project.',
    openToken: `This install has no login, so a request to ${action} must carry the anti-forgery token its `
      + 'dashboard was issued. Reload the dashboard and try again.',
    gateUnsupported: (gateState) => `Cannot ${action} while the login gate is "${gateState}". Resolve the gate first.`
  };
}

// GET /api/startup-prompt — the current startup prompt (#1825). The operator
// sees the full firer list; a bound project session sees the prompt, its
// digests, and only whether its own project is listed.
route('GET', '/api/startup-prompt', (req, res) => {
  const access = sharedDocsAccess.resolveAccess(req);
  if (access.kind !== 'operator') {
    const refusal = sharedDocsAccess.projectRefusalFor(access, sharedDocsAccess.NEEDS.OWN_PROJECT);
    if (refusal) return errorResponse(res, refusal.status, refusal.message, refusal.code);
  }
  const result = startupPrompt.read(access);
  jsonResponse(res, result.status, result.body);
});

// PUT /api/startup-prompt — write a new revision of the prompt and its firer
// list. Body: {text, firerProjectIds, expectedRevision}. The operator only,
// through the strict operator write: an agent that could edit this list could
// authorize itself to fire.
route('PUT', '/api/startup-prompt', (req, res, _params, body) => {
  const proof = _requireOperatorWrite(req, res, _startupPromptProofOptions('change the startup prompt', {}));
  if (!proof) return;
  const result = startupPrompt.update(body, proof);
  if (result.status !== 200) {
    log.warn('Refused a startup prompt change', { code: result.body.code });
    return errorResponse(res, result.status, result.body.error, result.body.code, result.body);
  }
  store.activity.log({
    projectId: null,
    sessionId: null,
    eventType: 'startup_prompt.updated',
    detail: { revision: result.body.revision, firerProjectIds: result.body.firerProjectIds, clearance: proof.clearance, actor: proof.actor }
  });
  log.info('Startup prompt updated', { revision: result.body.revision, clearance: proof.clearance, actor: proof.actor });
  jsonResponse(res, 200, result.body);
}, { maxBodySize: 64 * 1024, signedInOperator: { action: 'change the startup prompt' } });

// The wrap routes are registered from their own module, at the position they
// held here, so the route table keeps its order; the three gate helpers the
// handlers call still live here and are handed over.
require('./lib/routes/wrap').register({ controlRefused, controlJobSubject, coordinatorGateRefused });

// ── CC-5: operator-facing cross-session continuity search ──
// These read the per-project continuity store (changelog + wrap summaries +
// cold transcripts), distinct from GET /api/sessions/:project/history (lib/routes/sessions.js), which
// reads the SQLite sessions table. The drawer (History) consumes these.

/**
 * Validate an untrusted continuity `:sid` route param. The `<sid>` store key is
 * an integer session id or a wrap-summary filename stem; restrict it to the safe
 * charset BEFORE it reaches `path.join` in the store helpers. `matchRoute`
 * decodeURIComponent's after the `[^/]+` match, so a percent-encoded `..%2F..`
 * would otherwise traverse out of the project's store root.
 * @param {string} sid - Decoded route parameter
 * @returns {boolean} True when safe to use as a store key
 */
function _isValidSid(sid) {
  return typeof sid === 'string' && /^[A-Za-z0-9_-]+$/.test(sid);
}

/**
 * Strip the cold-tier meta envelope to the fields the UI needs, dropping the
 * absolute `source` path (a local `~/.claude` leak). Secret VALUES are never in
 * the meta to begin with (CC-4b records pattern types only).
 * @param {object|null} meta - Parsed `transcript.meta.json`, or null
 * @returns {object|null} UI-safe subset, or null when meta is absent
 */
function _publicTranscriptMeta(meta) {
  if (!meta) return null;
  return {
    harness: meta.harness || null,
    capturedAt: meta.capturedAt || null,
    bytes: meta.bytes || 0,
    lineCount: meta.lineCount || 0,
    secretsFlagged: !!meta.secretsFlagged,
    secretTypes: Array.isArray(meta.secretTypes) ? meta.secretTypes : [],
    scanSkipped: !!meta.scanSkipped
  };
}

// GET /api/continuity/:project/search — global search across this project's
// session history. `scope=summaries` (default) searches the warm changelog +
// wrap summaries; `scope=transcripts` greps every captured transcript directly
// (the "search my old transcripts" path). Both honor the same five filters.
route('GET', '/api/continuity/:project/search', async (req, res, params) => {
  const project = projects.getProjectRow(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const query = parseQuery(reqUrl(req).search);
  const opts = {
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    type: query.type,
    tags: query.tags,
    refs: query.refs,
    file: query.file,
    section: query.section,
    limit: query.limit ? parseInt(query.limit, 10) : 0
  };
  const result = query.scope === 'transcripts'
    ? await continuity.searchProjectTranscripts(project.path, query.q || '', opts)
    : continuity.searchSessions(project.path, query.q || '', opts);
  jsonResponse(res, 200, result);
});

// GET /api/continuity/:project/sessions — list every session in the store
route('GET', '/api/continuity/:project/sessions', async (req, res, params) => {
  const project = projects.getProjectRow(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, { sessions: continuity.listSessions(project.path) });
});

// GET /api/continuity/:project/sessions/:sid — drill-down payload for one session
route('GET', '/api/continuity/:project/sessions/:sid', async (req, res, params) => {
  const project = projects.getProjectRow(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const sid = params.sid;
  if (!_isValidSid(sid)) {
    return errorResponse(res, 400, 'Invalid session id', 'BAD_REQUEST');
  }
  const session = continuity.listSessions(project.path).find((s) => s.sid === String(sid)) || null;
  const uploadList = await uploads.listUploads(project.path);
  jsonResponse(res, 200, {
    sid: String(sid),
    session,
    summary: continuity.readWrapSummary(project.path, sid),
    transcript: _publicTranscriptMeta(continuity.readTranscriptMeta(project.path, sid)),
    // listUploads tags each entry with `session` (the <sid> dir name), not `sid`.
    uploads: uploadList.uploads.filter((u) => String(u.session) === String(sid)),
    // Carried even though this drill-down filters to one session: a directory
    // that refused to be read is why the list is short, and dropping the reason
    // here would render "no uploads" for a session that has them.
    uploadsUnreadable: uploadList.unreadable,
    uploadsUnreadableHint: uploadList.unreadableHint,
    uploadsUnreadableCode: uploadList.unreadableCode
  });
});

// GET /api/continuity/:project/sessions/:sid/transcript/search — cold drill-down
route('GET', '/api/continuity/:project/sessions/:sid/transcript/search', async (req, res, params) => {
  const project = projects.getProjectRow(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  if (!_isValidSid(params.sid)) {
    return errorResponse(res, 400, 'Invalid session id', 'BAD_REQUEST');
  }
  const query = parseQuery(reqUrl(req).search);
  const result = await continuity.searchTranscript(project.path, params.sid, query.q || '', {
    cap: query.cap ? parseInt(query.cap, 10) : undefined
  });
  jsonResponse(res, 200, result);
});

// GET /api/activity — Activity log query
route('GET', '/api/activity', (req, res) => {
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);

  const options = {};
  if (query.project) {
    const project = store.projects.getByName(query.project);
    if (project) options.projectId = project.id;
  }
  if (query.type) options.eventType = query.type;
  if (query.limit) options.limit = parseInt(query.limit, 10);
  if (query.since) options.since = query.since;

  const entries = store.activity.query(options);

  // Enrich with project names
  const projectCache = new Map();
  const enriched = entries.map((entry) => {
    let projectName = null;
    if (entry.projectId) {
      if (!projectCache.has(entry.projectId)) {
        const p = store.projects.get(entry.projectId);
        projectCache.set(entry.projectId, p ? p.name : null);
      }
      projectName = projectCache.get(entry.projectId);
    }
    return {
      id: entry.id,
      projectId: entry.projectId,
      projectName,
      sessionId: entry.sessionId,
      eventType: entry.eventType,
      detail: entry.detail,
      createdAt: entry.createdAt
    };
  });

  jsonResponse(res, 200, { entries: enriched });
});

// POST /api/upload — Upload a file to a project's .uploads/ directory
route('POST', '/api/upload', async (_req, res, _params, body) => {
  if (!body || !body.project || !body.filename || !body.data) {
    return errorResponse(res, 400, 'project, filename, and data are required', 'BAD_REQUEST');
  }

  const project = projects.getProjectRow(body.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${body.project}" not found`, 'NOT_FOUND');
  }

  // Whether the project directory is still on disk is answered by the same
  // child that performs the write. Do not add an `existsSync` here: it is a
  // synchronous read of an operator-chosen path, and the most likely one to
  // hang, because a project on a stalled mount is exactly the case it is for.
  try {
    // Route the upload into the active session's slot in the consolidated
    // store (CC-4); no active session → uploads.saveUpload falls back to the
    // legacy flat dir. `getActive` returns null when nothing is running.
    const active = store.sessions.getActive(project.id);
    const sid = active && active.id != null ? active.id : null;
    const result = await uploads.saveUpload(project.path, body.filename, body.data, sid);

    if (result.status === 'project-missing') {
      return errorResponse(res, 400, 'Project directory not found on disk', 'BAD_REQUEST');
    }
    if (result.status === 'unavailable') {
      // Not a rejection of the file. The directory would not answer, which is
      // the server's limitation to report, and the hint is the only thing that
      // tells an operator on macOS what to change.
      log.error('Upload failed', { error: result.unreadable, code: result.unreadableCode });
      return errorResponse(res, 500, result.unreadableHint
        ? `${result.unreadable} — ${result.unreadableHint}`
        : result.unreadable, result.unreadableCode || 'INTERNAL_ERROR');
    }
    jsonResponse(res, 201, result.upload);
  } catch (err) {
    // #338 — any file type is accepted, so there is no "not allowed" rejection
    // path any more; a throw here is a genuine save failure.
    log.error('Upload failed', { error: err.message });
    return errorResponse(res, 500, err.message, 'INTERNAL_ERROR');
  }
}, { maxBodySize: uploads.MAX_UPLOAD_BYTES });

// GET /api/uploads — List uploads for a project
route('GET', '/api/uploads', async (req, res) => {
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);

  if (!query.project) {
    return errorResponse(res, 400, 'project query parameter is required', 'BAD_REQUEST');
  }

  const project = projects.getProjectRow(query.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${query.project}" not found`, 'NOT_FOUND');
  }

  const list = await uploads.listUploads(project.path);
  jsonResponse(res, 200, {
    uploads: list.uploads,
    // An empty `uploads` with `unreadable` set means "we could not look", which
    // is not what "nothing has been uploaded" means. Both consumers render the
    // difference; collapsing them here would put the lie back one layer down.
    unreadable: list.unreadable,
    unreadableHint: list.unreadableHint,
    unreadableCode: list.unreadableCode
  });
});

// GET /api/tmux/mouse/:session — effective value plus its source (#579):
// `explicit` = a session-level override exists (vs inherited from global).
route('GET', '/api/tmux/mouse/:session', (_req, res, params) => {
  try {
    const tmuxName = tmux.toSessionName(params.session);
    const state = tmux.getMouseState(tmuxName);
    jsonResponse(res, 200, {
      mouse: state.on,
      explicit: state.explicit,
      session: params.session
    });
  } catch (err) {
    return errorResponse(res, 404, err.message, 'NOT_FOUND');
  }
});

// ── Groups API ──

/**
 * Resolve who is asking a shared-docs or groups route, and send the refusal
 * when the caller cannot do what the route needs.
 *
 * A caller that is refused never learns whether the group or document it named
 * exists: the refusal is sent before any lookup.
 * @param {http.IncomingMessage} req - The request
 * @param {http.ServerResponse} res - The response, written only on refusal
 * @param {string} [need] - One of `sharedDocsAccess.NEEDS`; defaults to read
 * @returns {{kind: string, projectId: (number|null), groupIds: string[], reason: (string|null)}|null}
 *   The resolved caller, or null when a refusal has been sent.
 */
function sharedDocsCaller(req, res, need = sharedDocsAccess.NEEDS.READ) {
  const access = sharedDocsAccess.resolveAccess(req);
  const refusal = sharedDocsAccess.refusalFor(access, need);
  if (refusal) {
    // Enough to tell a caller that never bound from a stale or mismatched
    // binding, or from a Master check tmux never answered. The launch id is
    // never logged: it is the binding itself.
    log.warn('Shared-docs caller refused', {
      method: req.method,
      path: reqUrl(req).pathname,
      code: refusal.code,
      need,
      kind: access.kind,
      reason: access.reason,
      cause: access.cause || null,
      claimedProjectId: req.headers[sharedDocsAccess.PROJECT_HEADER] || null,
      claimedRole: req.headers[sharedDocsAccess.ROLE_HEADER] || null
    });
    errorResponse(res, refusal.status, refusal.message, refusal.code);
    return null;
  }
  return access;
}

// GET /api/groups
route('GET', '/api/groups', (req, res) => {
  const access = sharedDocsCaller(req, res);
  if (!access) return;
  const groups = store.projectGroups.list().filter(g => sharedDocsAccess.canSeeGroup(access, g.id));
  // Enrich with member count and doc count
  const enriched = groups.map(g => {
    const members = store.projectGroups.listMembers(g.id);
    const docs = store.sharedDocs.getByGroup(g.id);
    return { ...g, memberCount: members.length, docCount: docs.length };
  });
  jsonResponse(res, 200, { groups: enriched });
});

// POST /api/groups
route('POST', '/api/groups', (req, res, _params, body) => {
  if (!sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.OPERATOR)) return;
  if (!body || !body.name) {
    return errorResponse(res, 400, 'name is required', 'BAD_REQUEST');
  }
  try {
    const group = store.projectGroups.create(body);
    jsonResponse(res, 201, group);
  } catch (err) {
    if (err.code === 'CONFLICT') {
      return errorResponse(res, 409, err.message, 'CONFLICT');
    }
    throw err;
  }
});

// GET /api/groups/:id
route('GET', '/api/groups/:id', (req, res, params) => {
  const access = sharedDocsCaller(req, res);
  if (!access) return;
  const group = store.projectGroups.get(params.id);
  // A group the caller is not in answers exactly like one that does not exist,
  // so the response is not an oracle for another project's group ids.
  if (!group || !sharedDocsAccess.canSeeGroup(access, group.id)) {
    return errorResponse(res, 404, `Group "${params.id}" not found`, 'NOT_FOUND');
  }
  const memberIds = store.projectGroups.listMembers(group.id);
  const members = memberIds.map(pid => {
    const proj = store.projects.get(pid);
    return proj ? { id: pid, name: proj.name, path: proj.path } : { id: pid, name: null, path: null };
  });
  const docs = store.sharedDocs.getByGroup(group.id);
  jsonResponse(res, 200, { ...group, memberCount: members.length, docCount: docs.length, members, docs });
});

// PUT /api/groups/:id
route('PUT', '/api/groups/:id', (req, res, params, body) => {
  if (!sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.OPERATOR)) return;
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }
  try {
    const group = store.projectGroups.update(params.id, body);
    jsonResponse(res, 200, group);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    if (err.code === 'CONFLICT') {
      return errorResponse(res, 409, err.message, 'CONFLICT');
    }
    // #1697: releaseOwnerProjectId naming a non-member project.
    if (err.code === 'BAD_REQUEST') {
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    throw err;
  }
});

// DELETE /api/groups/:id
route('DELETE', '/api/groups/:id', (req, res, params) => {
  if (!sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.OPERATOR)) return;
  try {
    store.projectGroups.delete(params.id);
    jsonResponse(res, 200, { ok: true, id: params.id });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    throw err;
  }
});

// POST /api/groups/:id/sync — Sync shared docs from group's sharedDir
route('POST', '/api/groups/:id/sync', (req, res, params) => {
  const access = sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.WRITE);
  if (!access) return;
  const group = store.projectGroups.get(params.id);
  if (!group || !sharedDocsAccess.canWriteGroup(access, group.id)) {
    return errorResponse(res, 404, `Group "${params.id}" not found`, 'NOT_FOUND');
  }
  if (!group.sharedDir) {
    return errorResponse(res, 400, 'Group has no sharedDir configured', 'BAD_REQUEST');
  }
  const result = store.sharedDocs.syncFromDirectory(params.id, group.sharedDir);
  jsonResponse(res, 200, { ok: true, ...result });
});

// ── Group Members API ──

// GET /api/groups/:id/members
route('GET', '/api/groups/:id/members', (req, res, params) => {
  const access = sharedDocsCaller(req, res);
  if (!access) return;
  const group = store.projectGroups.get(params.id);
  if (!group || !sharedDocsAccess.canSeeGroup(access, group.id)) {
    return errorResponse(res, 404, `Group "${params.id}" not found`, 'NOT_FOUND');
  }
  const memberIds = store.projectGroups.listMembers(params.id);
  // Enrich with project names
  const members = memberIds.map(pid => {
    const proj = store.projects.get(pid);
    return proj ? { id: pid, name: proj.name, path: proj.path } : { id: pid, name: null, path: null };
  });
  jsonResponse(res, 200, { members });
});

// POST /api/groups/:id/members
route('POST', '/api/groups/:id/members', (req, res, params, body) => {
  if (!sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.OPERATOR)) return;
  const group = store.projectGroups.get(params.id);
  if (!group) {
    return errorResponse(res, 404, `Group "${params.id}" not found`, 'NOT_FOUND');
  }
  if (!body || !body.projectId) {
    return errorResponse(res, 400, 'projectId is required', 'BAD_REQUEST');
  }
  const project = store.projects.get(body.projectId);
  if (!project) {
    return errorResponse(res, 404, `Project "${body.projectId}" not found`, 'NOT_FOUND');
  }
  store.projectGroups.addMember(params.id, body.projectId);
  jsonResponse(res, 200, { ok: true, groupId: params.id, projectId: body.projectId });
}, { signedInOperator: { action: 'add a project to a group' } });

// DELETE /api/groups/:id/members/:projectId
route('DELETE', '/api/groups/:id/members/:projectId', (req, res, params) => {
  if (!sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.OPERATOR)) return;
  const group = store.projectGroups.get(params.id);
  if (!group) {
    return errorResponse(res, 404, `Group "${params.id}" not found`, 'NOT_FOUND');
  }
  store.projectGroups.removeMember(params.id, parseInt(params.projectId, 10));
  jsonResponse(res, 200, { ok: true, groupId: params.id, projectId: parseInt(params.projectId, 10) });
});

// ── Shared Documents API ──

// GET /api/shared-docs
route('GET', '/api/shared-docs', (req, res) => {
  const access = sharedDocsCaller(req, res);
  if (!access) return;
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);
  const options = {};
  if (query.groupId) {
    // Naming a group the caller is not in answers like naming one that does
    // not exist, rather than confirming the id with an empty list.
    if (!sharedDocsAccess.canSeeGroup(access, query.groupId)) {
      return errorResponse(res, 404, `Group "${query.groupId}" not found`, 'NOT_FOUND');
    }
    options.groupId = query.groupId;
  }
  // With no groupId a project gets its own groups' documents, never the
  // install-wide list.
  const docs = store.sharedDocs.list(options).filter(d => sharedDocsAccess.canSeeGroup(access, d.groupId));
  jsonResponse(res, 200, { docs });
});

// POST /api/shared-docs
route('POST', '/api/shared-docs', (req, res, _params, body) => {
  const access = sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.WRITE);
  if (!access) return;
  if (!body || !body.groupId || !body.name || !body.filePath) {
    return errorResponse(res, 400, 'groupId, name, and filePath are required', 'BAD_REQUEST');
  }
  // Registering into a group the caller is not in answers like registering
  // into one that does not exist (the store's own 404 below).
  if (!sharedDocsAccess.canWriteGroup(access, body.groupId)) {
    return errorResponse(res, 404, `Group "${body.groupId}" not found`, 'NOT_FOUND');
  }
  try {
    const doc = store.sharedDocs.create(body);
    refreshSharedDocWatchers();
    jsonResponse(res, 201, doc);
  } catch (err) {
    if (err.code === 'CONFLICT') {
      return errorResponse(res, 409, err.message, 'CONFLICT');
    }
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    if (err.code === 'BAD_REQUEST') {
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    throw err;
  }
});

// GET /api/shared-docs/:id
route('GET', '/api/shared-docs/:id', (req, res, params) => {
  const access = sharedDocsCaller(req, res);
  if (!access) return;
  const doc = store.sharedDocs.get(params.id);
  if (!doc || !sharedDocsAccess.canSeeGroup(access, doc.groupId)) {
    return errorResponse(res, 404, `Shared document "${params.id}" not found`, 'NOT_FOUND');
  }
  // Include lock status
  const lock = store.documentLocks.check(doc.id);
  jsonResponse(res, 200, { ...doc, lock: lock || null });
});

// PUT /api/shared-docs/:id
route('PUT', '/api/shared-docs/:id', (req, res, params, body) => {
  if (!sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.OPERATOR)) return;
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }
  try {
    const doc = store.sharedDocs.update(params.id, body);
    refreshSharedDocWatchers();
    jsonResponse(res, 200, doc);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    if (err.code === 'BAD_REQUEST') {
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    throw err;
  }
}, { signedInOperator: { action: 'change a shared document\'s registration' } });

// POST /api/shared-docs/:id/notify
route('POST', '/api/shared-docs/:id/notify', async (req, res, params) => {
  const access = sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.WRITE);
  if (!access) return;
  try {
    const doc = store.sharedDocs.get(params.id);
    if (!doc || !sharedDocsAccess.canWriteGroup(access, doc.groupId)) {
      return errorResponse(res, 404, `Shared document "${params.id}" not found`, 'NOT_FOUND');
    }

    // The notify caller is never made the author: new bytes are an `unknown`
    // revision, which the delivery rule sends to subscribers only. Unchanged
    // bytes are a duplicate and notify nobody: direct mail is the nudge path.
    // A revision that cannot be recorded notifies nobody. That is reported the
    // way this route has always reported a delivery failure: in `errors`, with
    // both counts present and zero.
    /**
     * Answer a notify whose revision was not recorded: nothing was sent.
     * @param {string} why - Why it was not recorded
     * @returns {void}
     */
    const notRecorded = (why) => {
      log.warn('Shared doc revision not recorded: nobody was notified', { docId: params.id, source: 'notify', error: why });
      jsonResponse(res, 200, {
        success: true, notifiedCount: 0, coalescedCount: 0,
        errors: [`The revision was not recorded, so nobody was notified: ${why}`]
      });
    };
    let observed;
    try {
      observed = await sharedDocRecord.observe(params.id, { source: 'notify' });
    } catch (err) {
      if (err.code !== 'UNREADABLE') throw err;
      return notRecorded(err.message);
    }
    if (!observed) return notRecorded('the document was re-registered or removed while its file was read');
    // The counts are THIS call's sends: another caller's sends of the same
    // revision are its own. `coalescedCount` is reported so a zero
    // `notifiedCount` is never mistaken for a failed notify.
    const { notified, coalesced, errors } = await observed.delivery;
    jsonResponse(res, 200, {
      success: true,
      notifiedCount: notified,
      coalescedCount: coalesced,
      errors: errors.length > 0 ? errors : undefined,
      seq: observed.revision.seq,
      duplicate: observed.duplicate
    });
  } catch (err) {
    log.error('Failed to notify shared-doc update', { error: err.stack });
    errorResponse(res, 500, err.message, 'SERVER_ERROR');
  }
});

// DELETE /api/shared-docs/:id
route('DELETE', '/api/shared-docs/:id', (req, res, params) => {
  if (!sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.OPERATOR)) return;
  try {
    store.sharedDocs.delete(params.id);
    closeSharedDocWatcher(params.id);
    jsonResponse(res, 200, { ok: true, id: params.id });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    throw err;
  }
});

// ── Shared Document Revisions (#2389) ──

/** @type {RegExp} A lowercase hex sha256. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** @type {number} Body cap of the attest route: two digests and a flag. */
const ATTEST_BODY_LIMIT_BYTES = 1024;

/**
 * Whether a project caller holds a doc's lock right now: present, unexpired,
 * taken by the caller's own verified session and project, and (when
 * `lockedAt` is given) the same acquisition the caller started with. A
 * member's lock records its verified session, but an operator's lock records
 * whatever session id the operator names, so the comparison is with the
 * session the launch binding verified, never with the body.
 * @param {string} docId - Shared doc id
 * @param {{sessionId: number}} access - A project caller
 * @param {string} projectName - The caller's project name
 * @param {string} [lockedAt] - The acquisition the attestation began under
 * @returns {{status: number, code: string, message: string}|null} The refusal, or null.
 */
function attestLockRefusal(docId, access, projectName, lockedAt) {
  const lock = store.documentLocks.check(docId);
  const refuse = (why) => ({ status: 409, code: 'NOT_LOCK_HOLDER', message: `Attestation needs this session to hold the document's lock: ${why}` });
  if (!lock) return refuse('the document is not locked');
  if (lock.expiresAt && new Date(lock.expiresAt) <= new Date()) return refuse('the lock has expired');
  if (Number(lock.lockedBySession) !== access.sessionId || lock.lockedByProject !== projectName) {
    return refuse('the lock is held by another session');
  }
  if (lockedAt !== undefined && lock.lockedAt !== lockedAt) return refuse('the lock changed while the file was read');
  return null;
}

// POST /api/shared-docs/:id/attest
//
// `{"base": true}` is a writer's base capture: observe the file into the
// record and answer the digest to save. `{"baseSha256", "sha256"}` attests
// that the newest revision is this session's edit of that base. Attested
// authorship is authenticated attestation by a lock holder in a
// cooperative-writer model, not proof of who wrote the bytes.
route('POST', '/api/shared-docs/:id/attest', async (req, res, params, body) => {
  const access = sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.WRITE);
  if (!access) return;
  const doc = store.sharedDocs.get(params.id);
  if (!doc || !sharedDocsAccess.canWriteGroup(access, doc.groupId)) {
    return errorResponse(res, 404, `Shared document "${params.id}" not found`, 'NOT_FOUND');
  }
  // An attestation binds a verified session and its project; the operator and
  // the Project Master have neither.
  if (access.kind !== sharedDocsAccess.KINDS.PROJECT) {
    return errorResponse(res, 403, 'Only a bound project session can capture a base or attest a revision', 'PROJECT_ONLY');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }
  /**
   * Re-authorize the caller after the file read, against the registration as
   * it stands then: the binding and the group access may each have changed
   * while the read was in flight.
   * @param {{groupId: string}} current - The doc as registered after the read
   * @returns {{status: number, code: string, message: string}|null} The refusal, or null.
   */
  const reauthorize = (current) => {
    const now = sharedDocsAccess.resolveAccess(req);
    if (now.kind !== sharedDocsAccess.KINDS.PROJECT || now.sessionId !== access.sessionId
      || now.projectId !== access.projectId) {
      return { status: 403, code: 'LAUNCH_BINDING_INVALID', message: 'The caller\'s launch binding changed during the read' };
    }
    if (!sharedDocsAccess.canWriteGroup(now, current.groupId)) {
      return { status: 404, code: 'NOT_FOUND', message: `Shared document "${params.id}" not found` };
    }
    return null;
  };
  try {
    if (body.base === true) {
      const base = await sharedDocRecord.captureBase(doc.id, { recheck: reauthorize });
      if (base.code) return errorResponse(res, base.status, base.message, base.code);
      return jsonResponse(res, 200, { docId: doc.id, base: true, seq: base.seq, sha256: base.sha256 });
    }
    if (!SHA256_HEX.test(body.baseSha256 || '') || !SHA256_HEX.test(body.sha256 || '')) {
      return errorResponse(res, 400, 'baseSha256 and sha256 must each be a lowercase hex sha256, or send {"base": true}', 'BAD_REQUEST');
    }
    const project = store.projects.get(access.projectId);
    const projectName = project ? project.name : null;
    const first = attestLockRefusal(doc.id, access, projectName);
    if (first) return errorResponse(res, first.status, first.message, first.code);
    const lockedAt = store.documentLocks.check(doc.id).lockedAt;
    const outcome = await sharedDocRecord.attest(doc.id, {
      baseSha256: body.baseSha256,
      sha256: body.sha256,
      projectId: access.projectId,
      sessionId: access.sessionId,
      // Re-read after the file read: the binding, the group access and the
      // lock may each have changed while it was in flight.
      recheck: (current) => reauthorize(current) || attestLockRefusal(current.id, access, projectName, lockedAt)
    });
    if (outcome.code) return errorResponse(res, outcome.status, outcome.message, outcome.code);
    jsonResponse(res, 200, { docId: doc.id, attested: true, already: outcome.already, revision: outcome.revision });
  } catch (err) {
    if (err.code === 'UNREADABLE') return errorResponse(res, 409, err.message, 'UNREADABLE');
    log.error('Shared-doc attestation failed', { docId: doc.id, error: err.stack });
    errorResponse(res, 500, err.message, 'SERVER_ERROR');
  }
}, { maxBodySize: ATTEST_BODY_LIMIT_BYTES });

// GET /api/shared-docs/:id/events
//
// The doc's recorded revisions after `since` (a seq), oldest first, with the
// newest revision, the oldest one retained, and `gap` when revisions after
// `since` were pruned. `shadowWouldSelect` is a shadow: nobody was notified
// by it.
route('GET', '/api/shared-docs/:id/events', (req, res, params) => {
  const access = sharedDocsCaller(req, res);
  if (!access) return;
  const doc = store.sharedDocs.get(params.id);
  if (!doc || !sharedDocsAccess.canSeeGroup(access, doc.groupId)) {
    return errorResponse(res, 404, `Shared document "${params.id}" not found`, 'NOT_FOUND');
  }
  const query = parseQuery(reqUrl(req).search);
  const since = query.since === undefined ? 0 : Number(query.since);
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    return errorResponse(res, 400, 'since must be a non-negative integer and limit an integer from 1 to 500', 'BAD_REQUEST');
  }
  jsonResponse(res, 200, { docId: doc.id, ...store.sharedDocEvents.list(doc.id, { sinceSeq: since, limit }) });
});

// ── Shared Document Notice Settings (#2389) ──
//
// A project may mute a doc or a group (never told by the delivery rule), or
// subscribe to one (told of every change, whoever made it); `default` clears
// the setting. A doc-scope setting overrides a group-scope one. A project may
// set only its own, for a doc or group it belongs to; the operator may set
// any member's. Any member may read every member's, so a coordinator can see
// that a peer is muted. Muting touches nothing but these notices: direct
// mail, exchange replies, HOLD/STOP and urgent messages are not routed here.

/**
 * Every current member's notice setting for a group, or for one doc in it.
 * @param {{id: string}} group - The group
 * @param {{id: string, groupId: string}|null} doc - The doc, or null for the group scope
 * @returns {Array<{projectId: number, name: (string|null), doc: (string|null), group: (string|null), effective: (string|null)}>}
 */
function noticeSettingsView(group, doc) {
  // The same resolution the delivery rule routes on, so what is shown is what applies.
  const settings = sharedDocRecord.memberSettings(group.id, doc ? doc.id : null);
  return [...settings].map(([projectId, s]) => {
    const project = store.projects.get(projectId);
    return {
      projectId,
      name: project ? project.name : null,
      doc: doc ? s.doc : undefined,
      group: s.group,
      effective: s.effective
    };
  });
}

/**
 * Set one member's notice setting at a group or doc scope, answering the
 * request. The caller is already resolved and may write the group.
 * @param {object} res - Response
 * @param {object} access - The resolved caller
 * @param {{group: {id: string}, doc: ({id: string, groupId: string}|null)}} scope - Where
 * @param {*} body - `{setting, projectId?}`
 * @returns {void}
 */
function putNoticeSetting(res, access, scope, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }
  const setting = body.setting;
  const allowed = [...store.SHARED_DOC_NOTICE_SETTINGS, 'default'];
  if (!allowed.includes(setting)) {
    return errorResponse(res, 400, `setting must be one of ${allowed.join(', ')}`, 'BAD_REQUEST');
  }
  let projectId = access.projectId;
  if (body.projectId !== undefined) {
    projectId = Number(body.projectId);
    if (!Number.isInteger(projectId)) return errorResponse(res, 400, 'projectId must be an integer', 'BAD_REQUEST');
  }
  if (projectId == null) return errorResponse(res, 400, 'projectId is required for the operator', 'BAD_REQUEST');
  if (!sharedDocsAccess.canChangeProject(access, projectId)) {
    return errorResponse(res, 403, 'A project may change only its own notice settings', 'NOT_OWN_PROJECT');
  }
  if (!store.projectGroups.listMembers(scope.group.id).includes(projectId)) {
    return errorResponse(res, 404, `Project ${projectId} is not a member of this group`, 'NOT_A_MEMBER');
  }
  const setBy = access.kind === sharedDocsAccess.KINDS.OPERATOR ? 'operator' : `session:${access.sessionId}`;
  const saved = store.sharedDocNoticePrefs.set({
    projectId,
    groupId: scope.doc ? undefined : scope.group.id,
    docId: scope.doc ? scope.doc.id : undefined,
    setting,
    setBy
  });
  const view = noticeSettingsView(scope.group, scope.doc).find((m) => m.projectId === projectId);
  jsonResponse(res, 200, {
    scope: scope.doc ? 'doc' : 'group',
    groupId: scope.group.id,
    docId: scope.doc ? scope.doc.id : undefined,
    projectId,
    setting: saved ? saved.setting : null,
    effective: view ? view.effective : null
  });
}

// GET /api/shared-docs/:id/notices
route('GET', '/api/shared-docs/:id/notices', (req, res, params) => {
  const access = sharedDocsCaller(req, res);
  if (!access) return;
  const doc = store.sharedDocs.get(params.id);
  if (!doc || !sharedDocsAccess.canSeeGroup(access, doc.groupId)) {
    return errorResponse(res, 404, `Shared document "${params.id}" not found`, 'NOT_FOUND');
  }
  const group = store.projectGroups.get(doc.groupId);
  jsonResponse(res, 200, { scope: 'doc', docId: doc.id, groupId: doc.groupId, members: noticeSettingsView(group, doc) });
});

// POST /api/shared-docs/:id/notices
route('POST', '/api/shared-docs/:id/notices', (req, res, params, body) => {
  const access = sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.WRITE);
  if (!access) return;
  const doc = store.sharedDocs.get(params.id);
  if (!doc || !sharedDocsAccess.canWriteGroup(access, doc.groupId)) {
    return errorResponse(res, 404, `Shared document "${params.id}" not found`, 'NOT_FOUND');
  }
  putNoticeSetting(res, access, { group: store.projectGroups.get(doc.groupId), doc }, body);
});

// GET /api/groups/:id/notices
route('GET', '/api/groups/:id/notices', (req, res, params) => {
  const access = sharedDocsCaller(req, res);
  if (!access) return;
  const group = store.projectGroups.get(params.id);
  if (!group || !sharedDocsAccess.canSeeGroup(access, group.id)) {
    return errorResponse(res, 404, `Group "${params.id}" not found`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, { scope: 'group', groupId: group.id, members: noticeSettingsView(group, null) });
});

// POST /api/groups/:id/notices
route('POST', '/api/groups/:id/notices', (req, res, params, body) => {
  const access = sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.WRITE);
  if (!access) return;
  const group = store.projectGroups.get(params.id);
  if (!group || !sharedDocsAccess.canWriteGroup(access, group.id)) {
    return errorResponse(res, 404, `Group "${params.id}" not found`, 'NOT_FOUND');
  }
  putNoticeSetting(res, access, { group, doc: null }, body);
});

// ── Document Locks API ──

/** @type {number} Shortest lock, in minutes, the lock route grants. */
const LOCK_TTL_MIN_MINUTES = 1;

/**
 * @type {number} Longest lock, in minutes, the lock route grants. A lock cannot
 * be renewed (acquiring one already held is a conflict), so the ceiling sits
 * well above the 30-minute default to leave room for a long edit.
 */
const LOCK_TTL_MAX_MINUTES = 120;

/**
 * Whether a lock request's `ttlMinutes` is out of range. Omitted means the
 * store's default; anything present must be a whole number of minutes within
 * the route's bounds, never coerced. The store itself still accepts any ttl,
 * so a test can seed an expired lock directly.
 * @param {*} ttlMinutes - The body's ttlMinutes, as sent
 * @returns {boolean} True when the request must be refused.
 */
function lockTtlRefusal(ttlMinutes) {
  if (ttlMinutes === undefined) return false;
  return !Number.isInteger(ttlMinutes) || ttlMinutes < LOCK_TTL_MIN_MINUTES || ttlMinutes > LOCK_TTL_MAX_MINUTES;
}

// POST /api/shared-docs/:id/lock
route('POST', '/api/shared-docs/:id/lock', (req, res, params, body) => {
  const access = sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.WRITE);
  if (!access) return;
  const doc = store.sharedDocs.get(params.id);
  if (!doc || !sharedDocsAccess.canWriteGroup(access, doc.groupId)) {
    return errorResponse(res, 404, `Shared document "${params.id}" not found`, 'NOT_FOUND');
  }
  if (!body || !body.sessionId || !body.projectName) {
    return errorResponse(res, 400, 'sessionId and projectName are required', 'BAD_REQUEST');
  }
  if (lockTtlRefusal(body.ttlMinutes)) {
    return errorResponse(res, 400,
      `ttlMinutes must be a whole number of minutes from ${LOCK_TTL_MIN_MINUTES} to ${LOCK_TTL_MAX_MINUTES}`, 'BAD_REQUEST');
  }
  let sessionId = body.sessionId;
  let projectName = body.projectName;
  if (access.kind === sharedDocsAccess.KINDS.PROJECT) {
    // A member's body names a claim, checked like x-tangleclaw-project-id is
    // checked against the launch: a lock in another session's or project's
    // name is refused, never quietly rebound, so the caller learns its claim
    // was wrong instead of holding a lock it did not ask for.
    const project = store.projects.get(access.projectId);
    const verifiedName = project ? project.name : null;
    if (Number(body.sessionId) !== access.sessionId || verifiedName === null || body.projectName !== verifiedName) {
      return errorResponse(res, 403,
        'The lock is taken in the caller\'s own name: sessionId and projectName must be the session and project this launch verified',
        'LOCK_CALLER_MISMATCH');
    }
    sessionId = access.sessionId;
    projectName = verifiedName;
  }
  try {
    const lock = store.documentLocks.acquire(params.id, sessionId, projectName, body.ttlMinutes);
    jsonResponse(res, 200, lock);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    if (err.code === 'LOCK_CONFLICT') {
      return errorResponse(res, 409, err.message, 'LOCK_CONFLICT');
    }
    throw err;
  }
});

// GET /api/shared-docs/:id/lock
route('GET', '/api/shared-docs/:id/lock', (req, res, params) => {
  const access = sharedDocsCaller(req, res);
  if (!access) return;
  const doc = store.sharedDocs.get(params.id);
  if (!doc || !sharedDocsAccess.canSeeGroup(access, doc.groupId)) {
    return errorResponse(res, 404, `Shared document "${params.id}" not found`, 'NOT_FOUND');
  }
  const lock = store.documentLocks.check(params.id);
  jsonResponse(res, 200, { locked: !!lock, lock: lock || null });
});

// DELETE /api/shared-docs/:id/lock
route('DELETE', '/api/shared-docs/:id/lock', (req, res, params) => {
  const access = sharedDocsCaller(req, res, sharedDocsAccess.NEEDS.WRITE);
  if (!access) return;
  const doc = store.sharedDocs.get(params.id);
  if (!doc || !sharedDocsAccess.canWriteGroup(access, doc.groupId)) {
    return errorResponse(res, 404, `Shared document "${params.id}" not found`, 'NOT_FOUND');
  }
  if (access.kind === sharedDocsAccess.KINDS.OPERATOR) {
    store.documentLocks.release(params.id);
    return jsonResponse(res, 200, { ok: true, id: params.id });
  }
  // A member session may release only a lock it holds, or one that has
  // expired. A member's lock records its verified session, but an operator's
  // lock records whatever session id the operator names, so the comparison is
  // with the session the launch binding verified, never with anything this
  // request says about itself.
  const { released, holder } = store.documentLocks.releaseHeld(params.id, access.sessionId);
  if (!released && holder) {
    log.warn('Refused shared-doc lock release by a session that does not hold it', {
      docId: params.id,
      holderSession: holder.lockedBySession,
      holderProject: holder.lockedByProject,
      callerSession: access.sessionId
    });
    return errorResponse(res, 409,
      `Document is locked by ${holder.lockedByProject} (session ${holder.lockedBySession}); only that session or the operator can release it`,
      'NOT_LOCK_HOLDER',
      { holder: { sessionId: holder.lockedBySession, project: holder.lockedByProject, lockedAt: holder.lockedAt, expiresAt: holder.expiresAt } });
  }
  jsonResponse(res, 200, { ok: true, id: params.id });
});

// The OpenClaw routes are registered from their own module, at the position
// they held; nothing the handlers use still lives here.
openclawRoutes.register();

// ── Terminal Proxy ──

/**
 * Proxy an HTTP request to the ttyd backend.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} pathname
 */
function proxyToTtyd(req, res, pathname) {
  const config = store.config.load();
  const target = caddy.ttydConnectTarget(config);
  const targetPath = pathname.replace(/^\/terminal/, '') || '/';

  // In caddy mode ttyd is on a Unix socket (`socketPath`); otherwise a TCP port.
  // http.request accepts either `socketPath` or `hostname`+`port`.
  const reqOptions = {
    path: targetPath + (req.url.includes('?') ? '?' + req.url.split('?')[1] : ''),
    method: req.method,
    // TangleClaw's own session cookie is stripped before it reaches ttyd
    // (ADR 0016 OQ1). ttyd has no use for it, and `/terminal/*` fronts a
    // `--writable` shell — a credential that travels further than it is needed
    // is the #470 class of bug. Only OUR cookies go; anything else the browser
    // sent is the upstream's business.
    headers: {
      ...authSession.stripOwnCookiesFromHeaders(req.headers),
      host: target.hostHeader
    }
  };
  if (target.socketPath) {
    reqOptions.socketPath = target.socketPath;
  } else {
    reqOptions.hostname = target.host;
    reqOptions.port = target.port;
  }

  const proxyReq = http.request(reqOptions, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    log.warn('ttyd proxy error', { error: err.message });
    errorResponse(res, 502, 'Terminal service unavailable', 'BAD_GATEWAY');
  });

  req.pipe(proxyReq);
}

/**
 * Does a WebSocket handshake's `Origin` name the same host we are serving?
 *
 * Compared by HOST, not by full origin string: the dashboard is reached over
 * https through Caddy on one port and over http directly on another, and both
 * are legitimately the same machine — a strict origin match would break the
 * terminal on the install this release makes default. An unparseable Origin is
 * refused rather than waved through.
 *
 * @param {string} origin - The `Origin` header.
 * @param {string|undefined} host - The `Host` header.
 * @returns {boolean}
 */
function _isSameOriginUpgrade(origin, host) {
  let originHost;
  let targetHost;
  try {
    originHost = new URL(origin).hostname;
    // Parsed, never split on ':'. An IPv6 literal Host is bracketed
    // (`[fd7a:115c::1]:3102`), so splitting yields `'['` while the Origin side
    // yields the full `[fd7a:115c::1]` — they can never match, and every
    // terminal socket gets destroyed for an operator whose dashboard is on an
    // IPv6 address. Tailscale assigns every node an `fd7a:115c::/48` address,
    // so that is a normal way to reach this product, not an edge case. The
    // dashboard would load and the terminal would silently never connect.
    targetHost = new URL(`http://${host || 'localhost'}`).hostname;
  } catch {
    return false;
  }
  return originHost === targetHost;
}

// What a refused upgrade is answered with. A status line rather than a bare
// socket close, so a client that is merely signed out — a dashboard left open
// past its session — can be told apart from one refused for being cross-site,
// which the two guards ahead of the session check still close silently.
// Nothing about the request or the session is echoed.
const UPGRADE_UNAUTHORIZED_RESPONSE =
  'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

/**
 * Whether a request carries the markers only a browser sends.
 *
 * One definition for every guard that asks. A browser cannot suppress
 * `Sec-Fetch-Site` from script and always sends `Origin` on a WebSocket
 * handshake, so a page cannot disguise itself as the CLI; `curl`, scripts and
 * the agent-facing API send neither. The three request-shape guards in
 * `handleRequest` and the machine-client carve-out both read this, so a change
 * to what counts as a browser cannot reach one and miss the other.
 *
 * @param {http.IncomingMessage} req
 * @returns {boolean}
 */
function _looksLikeBrowser(req) {
  return req.headers['sec-fetch-site'] !== undefined || req.headers.origin !== undefined;
}

/**
 * Who is asking, as TangleClaw's session gate needs to know it — resolved ONCE,
 * here, for both transports.
 *
 * `handleRequest`'s gate and `handleUpgrade`'s gate both call this, and neither
 * assembles these inputs itself. That is the point of it existing: the verdicts
 * differ (`authGate.evaluate` for HTTP, `authGate.evaluateUpgrade` for a
 * handshake), but the facts they judge — the session token, the session it
 * resolves to, whether the request is browser-shaped, whether it is the fleet —
 * must be the same facts, or an edit to one gate's inputs that misses the
 * other's lets a signed-out request through the transport nobody re-read.
 *
 * A session lookup that THROWS is treated as no session. That is the fail-closed
 * direction, and it is safe to choose here because this is only called once the
 * gate is known to be armed, where no session means a challenge or a refusal
 * that still leaves `/login` reachable — the operator is not locked out by it.
 * Guarded because `resolve` runs two prepared statements and can delete a row, so
 * a store fault (SQLITE_BUSY against a concurrent `reset-admin.js`, a disk error,
 * a closed handle) would otherwise throw out of a request handler that has no
 * catch above it, and the response would never be written.
 *
 * @param {http.IncomingMessage} req
 * @param {import('net').Socket|undefined} socket - The connection; `req.socket` when absent
 * @param {string} pathname - For the log line only
 * @returns {{ sessionToken: string|null, session: object|null, machineClient: boolean }}
 */
function _gateIdentity(req, socket, pathname) {
  const sessionToken = authSession.tokenFromRequest(req);
  let session = null;
  if (sessionToken) {
    try {
      session = store.authSessions.resolve(sessionToken);
    } catch (err) {
      log.error('Session lookup failed — treating the request as unauthenticated', {
        method: req.method, path: pathname, error: err.message
      });
      session = null;
    }
  }
  const browserShaped = _looksLikeBrowser(req);
  const conn = socket || req.socket;
  const machineClient = authGate.isMachineClient({
    // `isLoopbackRemote` is `lib/admin-credential.js`'s, reused because
    // `POST /api/auth/credential` already authorises on exactly this predicate.
    loopback: adminCredential.isLoopbackRemote(conn && conn.remoteAddress),
    // The header's PRESENCE, whatever its value: Caddy always sets it on a
    // forwarded request, so even an empty one is not evidence of a local
    // process. See `authGate.isMachineClient` condition 2.
    proxied: authIdentity.cameThroughProxy(req.headers),
    browserShaped,
    hasSessionCookie: sessionToken !== null
  });
  return { sessionToken, session, machineClient };
}

/**
 * Percent-decode one path segment of an upgrade target, or `null` when it is
 * not valid percent-encoding (`%E0`). `decodeURIComponent` throws on that, and
 * in the 'upgrade' listener a throw strands the socket; the callers treat
 * `null` as "no such connection", which closes it.
 *
 * @param {string} segment - Raw path segment
 * @returns {string|null}
 */
function _decodeUpgradeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Delete an inbound `X-Auth-User` header from a request, and log that it was.
 *
 * A header that came through a reverse proxy is almost certainly Caddy's own
 * `header_up` line on a Caddyfile that still carries the `basic_auth` gate — so
 * it is logged at debug, once per request, rather than filling the log for the
 * whole cutover window. One that did NOT come through a proxy cannot be Caddy's:
 * it is a caller claiming an identity, and it is logged at warn.
 *
 * @param {http.IncomingMessage} req
 * @param {string} where - The path, for the log line only
 * @returns {void}
 */
function _refuseInboundIdentity(req, where) {
  const refused = authIdentity.refuseInboundIdentity(req.headers);
  if (!refused.present) return;
  if (refused.proxied) {
    log.debug('Dropped an X-Auth-User header forwarded by a proxy; identity comes from the session', { path: where });
  } else {
    log.warn('Refused an X-Auth-User header that did not come through a proxy — identity comes from the session', {
      path: where
    });
  }
}

/**
 * Handle a WebSocket upgrade: the terminal proxy and both OpenClaw proxies.
 *
 * Three checks run before any branch dispatches, in this order — cross-site
 * Origin, served Host (#864), then TangleClaw's session gate (#1419) — so every
 * prefix is covered by position rather than by a check repeated per branch.
 *
 * @param {http.IncomingMessage} req
 * @param {import('net').Socket} socket
 * @param {Buffer} head
 */
function handleUpgrade(req, socket, head) {
  // Deleted before any guard or branch, as on the HTTP path — the upgrade
  // proxies copy request headers to ttyd and the gateway, so a header left here
  // would also travel upstream.
  _refuseInboundIdentity(req, req.url);

  // Everything below runs inside the server's 'upgrade' listener, where a throw
  // is caught by no request handler: it reaches the process-level logger and
  // leaves the client's socket open. `reqUrl` throws on a Host header `new URL`
  // cannot parse (`Host: a b`), and it runs before any guard — so a caller with
  // no session at all controls whether it throws. Such a request names no
  // target this server could answer, so it is closed.
  let urlObj;
  try {
    urlObj = reqUrl(req);
  } catch (err) {
    log.warn('Refused a WebSocket upgrade with an unparseable target', { error: err.message });
    socket.destroy();
    return;
  }

  // The cross-site guard comes first, and it is the sharper half of this path.
  //
  // WebSockets are NOT subject to the same-origin policy: any page can open one
  // to any host, no preflight, no CORS. So the reasoning that protects the HTTP
  // routes — loopback means it came through Caddy — fails harder here, because a
  // page the operator merely visits can connect straight to the ungated
  // 127.0.0.1:<serverPort> listener and then read AND write on the socket, which
  // a cross-site form post cannot do. `/terminal/*` proxies to a `--writable`
  // ttyd, so that is a shell; the OpenClaw branches attach the operator's
  // gateway token.
  //
  // Browsers always send `Origin` on a WebSocket handshake and it cannot be
  // forged from script, so this is the check that exists for exactly this case.
  // Non-browser clients (the OpenClaw CLI, scripts) omit it and pass THIS guard —
  // they are not a cross-site vector — the same contract as the HTTP guard.
  // Passing it is not being let in: the session gate below still decides.
  const origin = req.headers.origin;
  if (origin && !_isSameOriginUpgrade(origin, req.headers.host)) {
    log.warn('Refused cross-origin WebSocket upgrade', { path: urlObj.pathname, origin });
    socket.destroy();
    return;
  }

  // #864 — the check above only proves Origin and Host AGREE, which they do
  // under DNS rebinding: both read `evil.example`, and the handshake proceeds
  // to a `--writable` ttyd. Requiring the name to be one this install serves is
  // what makes them agree on something true.
  //
  // Gated on `origin` for the same reason the check above is: a browser always
  // sends it, a non-browser client (the OpenClaw CLI, scripts) does not and is
  // not a cross-site vector. Without that gate this would refuse every
  // headless consumer that reaches the socket by an address the allowlist has
  // no way to know about.
  if (origin) {
    const wsCfg = _loadConfigOrNull();
    const wsAllowlist = wsCfg ? _servedHostsOrEmpty(wsCfg) : new Set();
    // No setup carve-out here on purpose: the wizard completes over HTTP, and
    // nothing in first run opens a terminal socket. An exemption would be dead
    // code guarding the route with the worst payoff — `/terminal/*` proxies to
    // a `--writable` ttyd.
    if (!_hostIsAllowed(req.headers.host, wsAllowlist)) {
      log.warn('Refused WebSocket upgrade for an unserved Host', {
        path: urlObj.pathname, origin, host: req.headers.host
      });
      socket.destroy();
      return;
    }
  }

  // ── TangleClaw's own front door, on the upgrade path (#1419) ──
  //
  // AFTER the two guards above, which refuse a handshake for what it IS before
  // any question of who is asking — and which must keep refusing a cross-site or
  // rebound handshake even when the browser holds a valid session, because the
  // cookie rides that attack too.
  //
  // BEFORE every branch, because an upgrade must be authenticated before the
  // socket is established, not after (ADR 0015): past this line a branch opens a
  // connection to ttyd — a `--writable` shell — or to an OpenClaw gateway with
  // the operator's token injected. HTTP's gate cannot stand in for this one;
  // `handleRequest` never sees an upgrade.
  //
  // `/openclaw-direct/*` is gated here like every other path: it is not on
  // `lib/auth-gate.js#GATE_BYPASS_PATHS`, and an upgrade takes no path anyway.
  const upgradeGateState = authGate.resolveGateState(_gateConfig, store.authSessions, _gateIngress,
    () => _gateFallback(socket));
  const upgradeIdentity = authGate.standsDown(upgradeGateState)
    ? null : _gateIdentity(req, socket, urlObj.pathname);
  const upgradeVerdict = authGate.evaluateUpgrade({
    gateState: upgradeGateState,
    session: upgradeIdentity && upgradeIdentity.session,
    machineClient: upgradeIdentity !== null && upgradeIdentity.machineClient
  });
  if (upgradeVerdict.action !== 'allow') {
    // `hadCookie` separates a dashboard left open past its session (a cookie
    // that no longer resolves) from a caller that never signed in, which is the
    // first question an operator with a dead terminal asks. The value is never
    // logged.
    log.info('Unauthenticated WebSocket upgrade refused', {
      path: urlObj.pathname, hadCookie: upgradeIdentity !== null && upgradeIdentity.sessionToken !== null
    });
    // A raw socket with no 'error' listener turns a client that resets while
    // this is being written into an uncaught exception in the 'upgrade'
    // listener. Attached before the write, and the answer to an error is the
    // destroy the refusal was going to do anyway.
    socket.on('error', () => socket.destroy());
    socket.end(UPGRADE_UNAUTHORIZED_RESPONSE, () => socket.destroy());
    return;
  }

  // OpenClaw direct WebSocket proxy — /openclaw-direct/:connId/*
  if (urlObj.pathname.startsWith('/openclaw-direct/')) {
    const parts = urlObj.pathname.split('/'); // ['', 'openclaw-direct', connId, ...rest]
    if (parts.length >= 3 && parts[2]) {
      const connId = _decodeUpgradeSegment(parts[2]);
      const resolved = connId === null ? null : resolveOpenclawPortDirect(connId);
      if (!resolved) {
        socket.destroy();
        return;
      }
      const subPath = parts.slice(3).join('/');
      const targetUrl = '/' + subPath + (urlObj.search || '');

      const net = require('node:net');
      const proxySocket = net.connect(resolved.localPort, '127.0.0.1', () => {
        const reqHeaders = _openclawWsRequestLines(
          req.headers, targetUrl, resolved.localPort, resolved.conn.gatewayToken
        );

        proxySocket.write(reqHeaders.join('\r\n'));
        if (head.length > 0) {
          proxySocket.write(head);
        }

        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      });

      proxySocket.on('error', () => socket.destroy());
      socket.on('error', () => proxySocket.destroy());
      socket.on('close', () => proxySocket.destroy());
      proxySocket.on('close', () => socket.destroy());
      return;
    }
    socket.destroy();
    return;
  }

  // OpenClaw WebSocket proxy — /openclaw/:project/*
  if (urlObj.pathname.startsWith('/openclaw/')) {
    const parts = urlObj.pathname.split('/'); // ['', 'openclaw', project, ...rest]
    if (parts.length >= 3 && parts[2]) {
      const ocProject = _decodeUpgradeSegment(parts[2]);
      const resolved = ocProject === null ? null : resolveOpenclawPort(ocProject);
      if (!resolved) {
        socket.destroy();
        return;
      }
      const subPath = parts.slice(3).join('/');
      const targetUrl = '/' + subPath + (urlObj.search || '');

      const net = require('node:net');
      const proxySocket = net.connect(resolved.localPort, '127.0.0.1', () => {
        const reqHeaders = _openclawWsRequestLines(
          req.headers, targetUrl, resolved.localPort, resolved.conn.gatewayToken
        );

        proxySocket.write(reqHeaders.join('\r\n'));
        if (head.length > 0) {
          proxySocket.write(head);
        }

        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      });

      proxySocket.on('error', () => socket.destroy());
      socket.on('error', () => proxySocket.destroy());
      socket.on('close', () => proxySocket.destroy());
      proxySocket.on('close', () => socket.destroy());
      return;
    }
    socket.destroy();
    return;
  }

  if (!urlObj.pathname.startsWith('/terminal')) {
    socket.destroy();
    return;
  }

  // Guarded, because this runs inside the server's 'upgrade' listener: a throw
  // here is not caught by any request handler, reaches the process-level
  // `uncaughtException` logger, and leaves the client's socket open with
  // nothing on the other end. A config that cannot be read has no ttyd target
  // to name, so the only honest answer is to close the socket.
  let config;
  try {
    config = store.config.load();
  } catch (err) {
    log.error('Could not read config for a terminal upgrade — closing the socket', {
      error: err.message
    });
    socket.destroy();
    return;
  }
  const target = caddy.ttydConnectTarget(config);
  const targetPath = urlObj.pathname.replace(/^\/terminal/, '') || '/';
  const targetUrl = targetPath + (urlObj.search || '');

  const net = require('node:net');
  // caddy mode → Unix socket; direct mode → TCP host:port. net.connect accepts
  // a socket path (string) or (port, host).
  const onProxyConnect = () => {
    // Build the upgrade request to forward to ttyd. TangleClaw's own cookies are
    // stripped first (ADR 0016 OQ1), the same rule `proxyToTtyd` applies on
    // HTTP: ttyd has no use for them, and this socket is a shell.
    const reqHeaders = [];
    reqHeaders.push(`GET ${targetUrl} HTTP/1.1`);
    reqHeaders.push(`Host: ${target.hostHeader}`);
    for (const [key, value] of Object.entries(authSession.stripOwnCookiesFromHeaders(req.headers))) {
      if (key.toLowerCase() === 'host') continue;
      reqHeaders.push(`${key}: ${value}`);
    }
    reqHeaders.push('', '');

    proxySocket.write(reqHeaders.join('\r\n'));
    if (head.length > 0) {
      proxySocket.write(head);
    }

    // Pipe data bidirectionally
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  };

  const proxySocket = target.socketPath
    ? net.connect(target.socketPath, onProxyConnect)
    : net.connect(target.port, target.host, onProxyConnect);

  // Counts the terminal attach when ttyd accepts the upgrade, and its detach
  // on close, for release-candidate certification's PTY-use target (#1949).
  ptyActivity.trackTerminalConnection(socket, proxySocket);

  proxySocket.on('error', () => {
    socket.destroy();
  });

  socket.on('error', () => {
    proxySocket.destroy();
  });

  socket.on('close', () => {
    proxySocket.destroy();
  });

  proxySocket.on('close', () => {
    socket.destroy();
  });
}

// ── Version Helper ──

let _cachedVersion = null;

/**
 * The version this server reports as its own — what the process loaded, falling
 * back to `version.json` only when startup was never captured.
 * @returns {string}
 */
function _getVersion() {
  // The version this process loaded, when it is known. Reading version.json
  // here instead would answer with the DISK version, and the two diverge for
  // the whole window between a self-update's checkout and the restart that
  // loads it — so `/api/version` would confirm a release the running code is
  // not yet serving. The memo below made that worse rather than better: it is
  // filled by the first request that asks, not at boot, so an idle server that
  // is then updated freezes the *new* number and reports it indefinitely.
  //
  // Keeping this in step with `/api/server-info`'s `runningVersion` is a
  // contract, not a coincidence: the dashboard writes its version label from
  // both, and a disagreement between them is exactly the misreport this
  // function used to produce.
  const running = serverInfo.getRunningVersion();
  if (running) return running;

  // Fallback for the window before startup is captured (and for tests that
  // never capture it). Memoized because it is a synchronous read on a request
  // path.
  if (_cachedVersion) return _cachedVersion;
  try {
    const versionFile = path.join(__dirname, 'version.json');
    const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    _cachedVersion = data.version;
    return _cachedVersion;
  } catch {
    return 'unknown';
  }
}

// ── Request Handler ──

/**
 * Main HTTP request handler.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handleRequest(req, res) {
  const startTime = Date.now();
  const urlObj = reqUrl(req);
  const pathname = urlObj.pathname;
  const method = req.method.toUpperCase();

  // An inbound identity header is deleted before anything reads the request —
  // identity is the session's (ADR 0016 OQ2). See `authIdentity.refuseInboundIdentity`.
  _refuseInboundIdentity(req, pathname);

  // Reject state-changing requests a browser tells us came from another site.
  //
  // Ahead of EVERY branch, not just `/api/`. The first version of this guard sat
  // inside the `/api/` branch and left the proxies open, which was the more
  // dangerous half: `_openclawProxyHeaders` rewrites `origin` and `referer` to
  // the local origin and attaches `Bearer <gatewayToken>`, so a cross-site page
  // POSTing to `/openclaw/:project/*` would have reached the OpenClaw gateway
  // with the operator's token supplied and the tell-tale Origin laundered off
  // the request. `/terminal/*` was open the same way. Scoping a CSRF check to
  // one path prefix is how the exemption outlives the reason for it.
  //
  // Placed ahead of route matching on purpose too: a cross-site caller is
  // refused whether or not the route exists, so the guard cannot be probed for
  // which methods and paths this server implements, and adding a route later
  // can never open a hole this guard was assumed to already cover.
  //
  // Several routes authorize on "the request arrived over loopback" — most
  // sharply POST /api/auth/credential, which treats loopback as proof that the
  // perimeter already authenticated the caller. That reasoning holds for
  // traffic through Caddy, but in caddy mode this server still binds an
  // ungated 127.0.0.1:<serverPort> listener, and a browser on the operator's
  // machine can reach it directly. `parseBody` parses any body as JSON
  // regardless of Content-Type, so a form with enctype="text/plain" is a CORS
  // *simple* request: no preflight, it is sent, and its body parses. The
  // attacker cannot read the reply, which does not matter for a write — the
  // admin credential is already changed.
  //
  // Sec-Fetch-Site is the cheap correct check: every current browser sends it
  // and it cannot be forged from script. Non-browser callers (curl, scripts,
  // the agent-facing API in the project guide) omit it entirely, and they are
  // not a CSRF vector, so an absent header is allowed — this closes the
  // browser path without breaking a single existing API consumer.
  //
  // Deliberately narrow: only `cross-site` is refused. Rejecting `same-site`
  // as well would need an attacker controlling a sibling subdomain of the
  // operator's own host, and would risk breaking a legitimate multi-subdomain
  // deployment. On TangleClaw's own `/api/` surface that residual is closed a
  // different way — the JSON-body rule below refuses a form from a sibling
  // subdomain too, since a `<form>` cannot send `application/json` — so
  // `same-site` stays allowed and nothing multi-subdomain breaks (#860). That
  // rule is confined to `/api/` (its own comment says why), so on the proxied
  // prefixes the sibling-subdomain residual still stands, recorded in
  // security-model.md rather than implied here. The CSRF acceptance there,
  // whose premise "no session state in the browser" is what shipping
  // browser-cached HTTP Basic invalidated, has been re-argued rather than
  // re-cited: CSRF is now in scope, with all three guards and their residuals
  // recorded there.
  if (CSRF_UNSAFE_METHODS.has(method) && req.headers['sec-fetch-site'] === 'cross-site') {
    log.warn('Refused cross-site state-changing request', { method, path: pathname });
    return errorResponse(res, 403,
      'Cross-site requests may not change server state.', 'CROSS_SITE_FORBIDDEN');
  }

  // #864 — the check above trusts the browser's own same-origin verdict, which
  // an attacker controlling DNS can manufacture. Refuse a state-changing
  // request that arrives under a name this install does not serve.
  //
  // Scoped to the unsafe methods ON PURPOSE, not applied to every request: an
  // allowlist derived wrongly (a reverse proxy that rewrites Host, a container
  // name, a LAN address nobody registered) then degrades to "reads still work,
  // writes are refused with a named error" instead of taking the dashboard away
  // from a remote operator entirely. Tightening to an outright refusal is a
  // separate decision, to be made once the derivation has proven itself.
  // Applied only to requests that look like they came from a browser, matching
  // the contract both sibling guards state explicitly: `curl`, scripts and the
  // agent-facing API in the project guide send neither header and are not a
  // cross-site vector, so they keep working under any `Host` (a container name,
  // a proxy rewrite). This costs the guard nothing — a rebound page IS a
  // browser, and a browser cannot suppress `Sec-Fetch-Site` from script, so the
  // attack always carries the marker that brings it back into scope.
  const looksLikeBrowser = _looksLikeBrowser(req);
  if (CSRF_UNSAFE_METHODS.has(method) && looksLikeBrowser) {
    // #860 — a browser-shaped write that carries a BODY must declare JSON.
    //
    // This is what makes the form attack a CORS *simple* request in the first
    // place: `parseBody` JSON-parses any body whatever its Content-Type, and
    // the three encodings a `<form>` can send (`text/plain`,
    // `application/x-www-form-urlencoded`, `multipart/form-data`) are exactly
    // the three that need no preflight. Requiring `application/json` forces a
    // preflight the server never answers affirmatively, and a form cannot send
    // that type at all — so the class closes without depending on
    // `Sec-Fetch-Site` being present or being `cross-site`. That is the point:
    // it also covers the `same-site` sibling-subdomain residual the
    // Sec-Fetch-Site guard deliberately allows, without refusing `same-site`
    // outright and breaking legitimate multi-subdomain deployments.
    //
    // Scoped to browser-shaped requests for the same reason the guards below
    // are: `curl`, scripts and the agent-facing API send no `Sec-Fetch-Site`
    // and no `Origin`, so they are unaffected whatever Content-Type they use.
    // That is what lets this land without breaking the documented agent API —
    // the guide's PortHub and shared-docs examples show a JSON body and no
    // header, and they keep working exactly as written.
    //
    // Keyed on a body being PRESENT, not on the method. The dashboard sends
    // genuine bodyless writes (`medusa/toggle` goes
    // through `api()` with no body and no
    // Content-Type), and refusing those would break the operator's own UI to
    // close nothing — a request with no body carries no forged payload. The
    // residual is a bodyless same-site POST to a route that acts without one;
    // `Sec-Fetch-Site` still refuses the cross-site case, which is the one an
    // arbitrary page can mount.
    // Confined to TangleClaw's OWN API. This block runs ahead of route
    // matching, so without the check it would also govern `/terminal/*`,
    // `/openclaw/*` and `/openclaw-direct/*` — reverse proxies whose browser
    // client is NOT ours: `public/openclaw-view.js` iframes
    // `/openclaw-direct/:connId/chat` SAME-ORIGIN, so OpenClaw's gateway UI
    // runs inside our page and its fetches are browser-shaped. Any of them
    // using the ordinary `fetch(url, {method:'POST', body: JSON.stringify(x)})`
    // idiom — no explicit header, which the browser labels
    // `text/plain;charset=UTF-8` — would take a 415 before reaching the
    // gateway, and multipart attachment paths would break the same way.
    // Imposing a media-type contract on a third party's client through a proxy
    // is not ours to do, and grepping `public/` cannot see it.
    //
    // Those prefixes keep the two guards below (cross-site refusal, and the
    // served-Host check), which is exactly what they had before this change —
    // so this is no regression, only a narrower new rule. The residual is a
    // same-site body-carrying write to a proxied path, recorded in
    // `security-model.md` beside the others.
    const ownApiSurface = pathname.startsWith('/api/');
    const hasBody = Number(req.headers['content-length'] || 0) > 0
      || req.headers['transfer-encoding'] !== undefined;
    const declaredType = String(req.headers['content-type'] || '')
      .split(';')[0].trim().toLowerCase();
    if (ownApiSurface && hasBody && declaredType !== 'application/json') {
      log.warn('Refused browser write whose body is not declared JSON', {
        method, path: pathname, contentType: declaredType || '(none)'
      });
      return errorResponse(res, 415,
        'A request body from a browser must be declared as application/json.',
        'JSON_BODY_REQUIRED');
    }

    // ONE read of config, shared by both checks below. They used to load it
    // separately and only one wrapped the call, so a corrupt config threw out
    // of the request through the unguarded path instead of being refused.
    // `null` here means "could not read it", which fails CLOSED: no exemption,
    // and an empty name list (an IP-literal Host still passes on its own merit).
    const cfg = _loadConfigOrNull();
    const allowlist = cfg ? _servedHostsOrEmpty(cfg) : new Set();
    if (!_setupRouteNeedingHostExemption(pathname, cfg)
        && !_hostIsAllowed(req.headers.host, allowlist)) {
      log.warn('Refused state-changing request for an unserved Host', {
        method, path: pathname, host: req.headers.host
      });
      return errorResponse(res, 403,
        'This server does not answer to that host name.', 'HOST_NOT_SERVED');
    }
  }

  // ── TangleClaw's own front door (#1418, ADR 0015/0016) ──
  //
  // Placed HERE, and the position is load-bearing in both directions.
  //
  // AFTER the three guards above (cross-site, JSON-body, served-Host) because
  // those refuse a request on what it IS, before any question of who is asking
  // — a cross-site write from an authenticated browser is still a cross-site
  // write, and running the session lookup first would spend a database read on
  // a request that was always going to be refused.
  //
  // BEFORE every route branch, proxy branch and static-file branch, because
  // "the perimeter is the gate" is this server's model (see the /plans/ comment
  // below) and a gate that sits inside one branch leaves every sibling open —
  // which is the exact defect the CSRF guard above had to be moved out of
  // `/api/` to fix. `/terminal/*` proxies to a writable shell and
  // `/openclaw/*` carries the operator's gateway token; neither is a route, and
  // both are gated by standing here.
  //
  // The session is resolved for EVERY request once the gate is live, including
  // ones it then waves through, because the CSRF check needs it and because
  // `/api/auth/me` answers from it.
  let tcSession = null;
  const gateState = authGate.resolveGateState(_gateConfig, store.authSessions, _gateIngress,
    () => _gateFallback(req.socket));
  if (!authGate.standsDown(gateState)) {
    // Resolved by the helper `handleUpgrade`'s gate also calls, so the two
    // transports judge the same facts — see `_gateIdentity`.
    const identity = _gateIdentity(req, req.socket, pathname);
    tcSession = identity.session;
    const verdict = authGate.evaluate({
      method,
      rawUrl: req.url,
      pathname,
      gateState,
      session: tcSession,
      submittedCsrf: authSession.csrfTokenFromRequest(req),
      // The fleet carve-out (#1418 Critic R-1) — see `authGate.isMachineClient`.
      machineClient: identity.machineClient
    });
    if (verdict.action === 'refuse-csrf') {
      log.warn('Refused session-authenticated write with no valid CSRF token', {
        method, path: pathname, username: tcSession.username
      });
      return errorResponse(res, 403,
        'This request is missing a valid CSRF token.', 'CSRF_TOKEN_INVALID');
    }
    if (verdict.action === 'challenge') {
      log.info('Unauthenticated request refused', { method, path: pathname, gateState });
      const setup = verdict.for === 'account-setup';
      if (verdict.as === 'json') {
        return setup
          ? errorResponse(res, 401,
            'No account exists yet. Open this address in a browser to create one.', 'ACCOUNT_REQUIRED')
          : errorResponse(res, 401, 'Sign in to continue.', 'UNAUTHENTICATED');
      }
      // 401, not 200: a login page served as a success tells caches and uptime
      // monitors the request worked. The body is the page a person needs.
      return setup ? _serveAuthPage(res, 401, 'account-setup.html') : _serveLoginPage(res, 401);
    }
  }
  // Readable by the routes below, which must never re-derive identity: ADR 0016
  // records that `users.getByName` returns the password hash, so anything
  // asking "who is this" reads the session and not the user row.
  req.tcSession = tcSession;
  // Carried beside the session so a route reads THIS request's decision rather
  // than asking again. `/api/auth/me` recomputed it, which was both a second
  // config read and a seam where the two answers could one day disagree.
  req.tcGateState = gateState;
  req.tcGateActive = !authGate.standsDown(gateState);

  // The login page itself, on the one path `lib/auth-gate.js` exempts for it.
  // Served whether or not the gate is live, so the path does not blink into
  // existence at the moment the gate turns on. While no account exists there is
  // nothing to sign in to, so the same path answers with the first-account
  // page rather than a login form that can only fail.
  if (method === 'GET' && pathname === '/login') {
    return gateState === authGate.GATE_STATES.ACCOUNT_REQUIRED
      ? _serveAuthPage(res, 200, 'account-setup.html')
      : _serveLoginPage(res, 200);
  }
  // The recovery-code page. The gate lets a signed-out person reach it only in
  // `armed`; anywhere else it is reached only when the gate is open or the
  // caller is signed in, and the route it posts to says why a code cannot help.
  if (method === 'GET' && pathname === '/recover') {
    return _serveAuthPage(res, 200, 'recover.html');
  }

  // API routes
  if (pathname.startsWith('/api/')) {

    const matched = matchRoute(method, pathname);
    if (!matched) {
      log.debug('Route not found', { method, path: pathname });
      return errorResponse(res, 404, `${method} ${pathname} not found`, 'NOT_FOUND');
    }

    // Ambient-awareness receipts for the whole verb surface: any request the
    // tc CLI identifies itself on records one awareness receipt, keyed by the
    // verb it declares — so the ledger sees `tc ports` and `tc message.send`,
    // not just whoami. Recorded BEFORE the M2M gate on purpose: an invocation
    // the gate then refuses still proves the agent discovered and ran the CLI,
    // which is the fact this ledger measures. /api/tc/whoami is skipped — that
    // route records its own receipt (it must also count browser/'http' calls,
    // which this interception never sees). The verb header is required: a
    // cli-identified request without one is an auxiliary side-fetch whose
    // primary request records instead.
    if (req.headers['x-tangleclaw-cli'] && req.headers['x-tangleclaw-verb'] && pathname !== '/api/tc/whoami') {
      recordTcAwareness(req.headers);
    }

    // AUTH-4 — M2M service-token gate on the PortHub + shared-docs surfaces. A
    // no-op when serviceTokenEnabled is false (default), so the surfaces stay
    // byte-for-byte open until the operator opts in.
    // Whether a service token was actually checked on this request: the gate is
    // on AND the token matched. Read from the one config load that made the
    // decision, so the guard below cannot see a gate the check above did not.
    let serviceTokenVerified = false;
    if (serviceToken.requiresServiceToken(pathname)) {
      // Outside the handler's error boundary below, like the launch-binding
      // check after it: a config read that throws is answered here, or the
      // request gets no response at all.
      let tokenConfig;
      let gate;
      try {
        tokenConfig = store.config.load();
        gate = serviceToken.validateRequest(req.headers, tokenConfig);
      } catch (err) { // prawduct:allow prawduct/broad-except -- the dispatcher's boundary for a read that sits ahead of the route's own: any failure must still answer the request
        log.error('Service-token check failed: the request is refused', {
          method, path: pathname, error: err.message, stack: err.stack
        });
        return errorResponse(res, 500, 'Internal server error', 'INTERNAL_ERROR');
      }
      if (!gate.ok) {
        // Log the denial (never the token) — the gate returns before the normal
        // access-log line below, so without this a rejected M2M caller leaves no
        // trace for the operator to debug.
        log.warn('Service-token gate denied request', { method, path: pathname, code: gate.code });
        return errorResponse(res, gate.status, gate.message, gate.code);
      }
      serviceTokenVerified = Boolean(tokenConfig && tokenConfig.serviceTokenEnabled);
    }

    // The floor under every mutating route (#2233): the caller must be known
    // before a handler runs. It establishes who is asking and nothing more; each
    // route's own check of what that caller may touch still runs after it.
    // The check reads the store, and this call sits outside the handler's
    // error boundary below. A read that throws is answered here: left to
    // escape, the request gets no response and the caller's socket stays open.
    // The answer is a refusal, because who is asking was never established.
    let binding;
    try {
      binding = launchBindingGuard.judge(req, { ...matched, serviceTokenVerified });
    } catch (err) {
      log.error('Launch binding check failed: the request is refused', {
        method, path: pathname, error: err.message, stack: err.stack
      });
      return errorResponse(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }
    if (!binding.allowed) {
      log.warn('Mutating request refused: the caller is not bound to a live, current launch', {
        method, path: pathname, code: binding.code, reason: binding.reason
      });
      return errorResponse(res, binding.status, binding.message, binding.code, { reason: binding.reason });
    }
    // A route that grants or approves authority over sessions (#2378) admits the
    // operator only signed in. Keyed on what admitted the request: a project,
    // the Project Master or a service token never meets this check, so a
    // session's own proposal or an authority's own release is unchanged.
    if (matched.options.signedInOperator && binding.via === sharedDocsAccess.KINDS.OPERATOR
      && !_requireSignedInOperator(req, res, matched.options.signedInOperator)) {
      return;
    }

    try {
      const body = await parseBody(req, matched.options.maxBodySize);
      await matched.handler(req, res, matched.params, body);
    } catch (err) {
      if (err.status) {
        return errorResponse(res, err.status, err.message, err.code, err.extra);
      }
      log.error('Unhandled error in route handler', {
        method, path: pathname, error: err.message, stack: err.stack
      });
      return errorResponse(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }

    const duration = Date.now() - startTime;
    log.info(`${method} ${pathname}`, { status: res.statusCode, duration: `${duration}ms`, ..._admittedAs(binding) });
    return;
  }

  // Terminal reverse proxy — forward /terminal/* to ttyd
  if (pathname.startsWith('/terminal/') || pathname === '/terminal') {
    if (method === 'GET' || method === 'POST') {
      return proxyToTtyd(req, res, pathname);
    }
  }

  // OpenClaw direct proxy — forward /openclaw-direct/:connId/* to local tunnel port (standalone)
  if (pathname.startsWith('/openclaw-direct/')) {
    const parts = pathname.split('/'); // ['', 'openclaw-direct', connId, ...rest]
    if (parts.length >= 3 && parts[2]) {
      const connId = decodeURIComponent(parts[2]);
      const resolved = resolveOpenclawPortDirect(connId);
      if (!resolved) {
        return errorResponse(res, 404, 'OpenClaw connection not found', 'NOT_FOUND');
      }
      // #1012 — the bare `/openclaw-direct/<connId>` form serves the Control UI
      // index. Builds before 2026.9 reference their bundle RELATIVELY
      // (`src="./assets/index-*.js"`), and from a base with no trailing slash the
      // browser resolves that to
      // `/openclaw-direct/assets/...`, where `parts[2]` above reads "assets" as the
      // connection id, misses, and 404s the bundle. The page then renders but the
      // `openclaw-app` component never registers, and OpenClaw's own error card
      // blames a browser extension — a misdiagnosis three layers from the cause.
      // Redirect to the canonical slashed form so relative assets resolve from any
      // entry point (a link, a bookmark, a hand-typed URL), not just from the
      // `/chat` sub-path today's UI happens to use. (2026.9+ builds use
      // root-absolute paths instead; `openclawHtml.relayOpenclawResponse` moves
      // those under this prefix, #1534.)
      if (parts.length === 3) {
        const query = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
        res.writeHead(301, { Location: pathname + '/' + query });
        return res.end();
      }
      const subPath = parts.slice(3).join('/');
      const targetPath = '/' + subPath + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');

      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: resolved.localPort,
        path: targetPath,
        method: req.method,
        headers: _openclawProxyHeaders(req.headers, resolved.localPort, resolved.conn.gatewayToken)
      }, (proxyRes) => {
        openclawHtml.relayOpenclawResponse(req, res, proxyRes, _stripFrameBlockers(proxyRes.headers),
          `/openclaw-direct/${parts[2]}`, log);
      });

      proxyReq.on('error', (err) => {
        log.warn('OpenClaw direct proxy error', { error: err.message, connId });
        errorResponse(res, 502, 'OpenClaw service unavailable', 'BAD_GATEWAY');
      });

      req.pipe(proxyReq);
      return;
    }
  }

  // OpenClaw reverse proxy — forward /openclaw/:project/* to local tunnel port
  if (pathname.startsWith('/openclaw/')) {
    const parts = pathname.split('/'); // ['', 'openclaw', project, ...rest]
    if (parts.length >= 3 && parts[2]) {
      const ocProject = decodeURIComponent(parts[2]);
      const subPath = parts.slice(3).join('/');
      return proxyToOpenclaw(req, res, ocProject, subPath);
    }
  }

  // Served plan docs — GET /plans/:projectId/:file renders a project's plan as
  // a page (#542). Sits with the other pages on purpose: NOT a bypass path
  // (`lib/auth-gate.js#GATE_BYPASS_PATHS`), so the gate in front of the
  // dashboard gates it too. No route-level gate is added because none of the
  // pages have one — the perimeter is the gate.
  if (method === 'GET' && pathname.startsWith('/plans/')) {
    // Outside the `/api/` branch there is no route try/catch, so a renderer
    // failure here (a pathological plan, a read race) would leave the
    // response open forever. Answer with a 500 page instead.
    try {
      servePlanPage(res, pathname);
    } catch (err) {
      log.error('Plan page failed to render', { path: pathname, error: err.message, stack: err.stack });
      if (!res.headersSent) {
        htmlResponse(res, 500, planDocs.renderMessagePage({
          title: 'Plan could not be rendered',
          message: 'TangleClaw hit an error rendering this plan. The server log has the detail; the file itself is unchanged.'
        }));
      } else {
        res.end();
      }
    }
    const duration = Date.now() - startTime;
    log.info(`${method} ${pathname}`, { status: res.statusCode, duration: `${duration}ms` });
    return;
  }

  // Static files
  if (method === 'GET') {
    if (serveStatic(res, pathname)) {
      // The dashboard document is the one static response logged at info —
      // see logNavigation. Every other asset stays at debug.
      if (pathname === '/' || pathname === '') {
        logNavigation(method, pathname, startTime, 'index.html');
        return;
      }
      const duration = Date.now() - startTime;
      log.debug(`${method} ${pathname}`, { status: 200, duration: `${duration}ms` });
      return;
    }
  }

  // Fail-closed auth-bypass parity guard (#473). Both gates — TangleClaw's and,
  // while it is emitted, Caddy's basic_auth — decide "bypass" against the
  // DECODED, path-cleaned target, while TC's router above parses the RAW target
  // with `new URL` — so normalization variants (`//manifest.json`,
  // `/api%2Fhealth`) are waved through unauthenticated yet miss their handler
  // here. A real bypass path is already handled above (health via /api, the
  // manifest file via serveStatic). Anything reaching this point whose canonical
  // path is still a bypass path did NOT resolve to its handler, so serving the
  // SPA shell would leak it unauthenticated (the #472 residual-risk #2 leak
  // class). Refuse instead — never serve fallback content to a bypass-shaped
  // request. Non-bypass GETs fall through to the SPA/wrapper routes unchanged.
  if (authGate.isGateBypassPath(req.url)) {
    log.warn('Auth-bypass path fell through without a handler — refusing (parity guard)', {
      method, path: pathname, canonical: caddy.caddyCanonicalPath(req.url)
    });
    return errorResponse(res, 404, 'Not found', 'NOT_FOUND');
  }

  // Session wrapper page — /session/:name serves session.html
  if (method === 'GET' && pathname.startsWith('/session/') && pathname.split('/').length === 3) {
    const sessionName = pathname.split('/')[2];
    if (sessionName && serveStatic(res, '/session.html')) {
      logNavigation(method, pathname, startTime, 'session.html');
      return;
    }
  }

  // OpenClaw viewer page — /openclaw-view/:connId serves openclaw-view.html
  if (method === 'GET' && pathname.startsWith('/openclaw-view/') && pathname.split('/').length === 3) {
    const connId = pathname.split('/')[2];
    if (connId && serveStatic(res, '/openclaw-view.html')) {
      return;
    }
  }

  // Fallback: serve index.html for SPA routing
  if (method === 'GET' && !pathname.includes('.')) {
    if (serveStatic(res, '/')) {
      logNavigation(method, pathname, startTime, 'index.html');
      return;
    }
  }

  errorResponse(res, 404, 'Not found', 'NOT_FOUND');
}

// ── Eval Audit Mode ──

// The audit and sidecar routes are registered from their own module, at the
// position they held here, so the route table keeps its order.
require('./lib/routes/audit').register();

// ── Server Creation ──

/**
 * Report the protocol a constructed server actually speaks.
 *
 * The distinction this exists to preserve: config `httpsEnabled` is *intent*,
 * and `createServer` falls back to plain HTTP whenever HTTPS is asked for
 * without usable cert/key. That is the ordinary fresh-install state, since the
 * shipped default enables HTTPS before any certificate exists — so a startup
 * banner derived from config announced `https://` for a plain-HTTP socket and
 * sent new operators to debug certificates that were never in play. Ask the
 * server, not the config.
 *
 * @param {http.Server|https.Server} server - The constructed server
 * @returns {'https'|'http'} The scheme the server actually serves
 */
function serverProtocol(server) {
  return server instanceof https.Server ? 'https' : 'http';
}

/**
 * Say once, loudly, when `TANGLECLAW_PORT` is set to something unbindable.
 *
 * `httpsSetup.effectiveServerPort` falls back silently by design — it also runs
 * on every config regeneration, so it must not log. That leaves boot responsible
 * for the noise, and boot is where it matters: a silent fallback here would
 * replace the hard `ERR_SOCKET_BAD_PORT` that `server.listen('<typo>')` used to
 * raise with a server quietly listening on a port the plist, `install.sh`'s
 * health check, and any Caddy upstream all disagree with. Same posture as the
 * `httpsFallback` WARN on the listen line (#616): report the fallback, don't
 * hide it.
 *
 * An unset OR empty value is "no override" — not a misconfiguration — so it says
 * nothing. Only a non-empty value the server could never bind is worth an error.
 *
 * Extracted from `main` so the branch is testable (the #616 seam pattern).
 *
 * @param {number} portInUse - The port actually resolved for binding.
 * @param {object} [env] - Environment to read; defaults to `process.env`.
 * @param {object} [logger] - Logger to use; defaults to the module logger.
 * @returns {boolean} Whether a warning was emitted.
 */
function warnUnbindablePortEnv(portInUse, env, logger) {
  const raw = (env || process.env).TANGLECLAW_PORT;
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  if (httpsSetup.isBindableServerPort(raw)) return false;
  (logger || log).error(
    'TANGLECLAW_PORT is not a bindable port — ignoring it and using the configured port instead. '
    + 'Fix the value in ~/Library/LaunchAgents/com.tangleclaw.server.plist; until then anything that '
    + 'expects the plist port (health checks, Caddy upstream) will not reach this server.',
    { tangleclawPortEnv: String(raw), portInUse }
  );
  return true;
}

/**
 * Create and configure the HTTP/HTTPS server (does not start listening).
 * @param {object} [options]
 * @param {boolean} [options.httpsEnabled] - Use HTTPS
 * @param {string} [options.certPath] - Path to TLS certificate
 * @param {string} [options.keyPath] - Path to TLS private key
 * @returns {http.Server|https.Server}
 */
function createServer(options = {}) {
  let server;
  if (options.httpsEnabled && options.certPath && options.keyPath) {
    try {
      const cert = fs.readFileSync(options.certPath);
      const key = fs.readFileSync(options.keyPath);
      server = https.createServer({ cert, key }, handleRequest);
      log.info('HTTPS enabled', { cert: options.certPath });
    } catch (err) {
      log.warn('HTTPS enabled but cert/key could not be loaded — falling back to HTTP. Fix cert paths in Settings or regenerate via the setup wizard.', {
        certPath: options.certPath,
        keyPath: options.keyPath,
        error: err.message
      });
      server = http.createServer(handleRequest);
    }
  } else {
    if (options.httpsEnabled && (!options.certPath || !options.keyPath)) {
      log.warn('HTTPS enabled but cert/key paths not configured — falling back to HTTP. Run the setup wizard (Settings → HTTPS) to generate certificates.', {
        certPath: options.certPath || null,
        keyPath: options.keyPath || null
      });
    }
    server = http.createServer(handleRequest);
  }
  server.on('upgrade', handleUpgrade);
  return server;
}

// ── Main ──

if (require.main === module) {
  // Configure log level from env or config
  const envLogLevel = process.env.TANGLECLAW_LOG_LEVEL;
  if (envLogLevel) {
    setLevel(envLogLevel);
  }

  // Capture git HEAD SHA at boot for stale-server detection (#199).
  // Doing this before store.init keeps the snapshot honest — any code
  // paths the store init triggers run against the SHA we just stamped.
  serverInfo.captureStartup();
  // Start restart-mechanism detection now, so a Linux host has systemd's
  // answer (queried in the background) before the first page asks for it.
  serverInfo.detectRestartMechanism();

  // Initialize store (needed for config before PID check)
  store.init();
  // #1861 — remember which projects are governed before any request arrives,
  // so a control store that fails later still fails closed for them.
  controlGate.prime();
  const config = store.config.load();

  // #1368 — the install directory may have moved or been renamed while a
  // process manager kept this server running on the old path; the clearest
  // symptom is every UI route 404ing while the API itself stays up, which is
  // why /api/health degrades on this too.
  if (!_checkPublicAssets()) {
    log.error('Static asset directory (public/index.html) is missing or unreadable — UI routes will 404; '
      + 'check if the install directory was moved or renamed while running', { publicDir: PUBLIC_DIR });
  }

  // #1369 — the same move/rename leaves a LaunchAgent plist's WorkingDirectory
  // and any persisted cert/key paths pointing at the OLD install directory.
  // Read-only and never-throwing, like the scan it builds on (#1148).
  try {
    const startupAudit = launchAgentScan.auditStartupPaths({
      cwd: __dirname,
      launchAgentsDir: launchAgentScan.defaultLaunchAgentsDir(),
      config
    });
    const startupWarning = launchAgentScan.formatStartupWarning(startupAudit);
    if (startupWarning) log.warn(startupWarning);
  } catch (err) {
    log.warn('Startup LaunchAgent/config path audit failed', { error: err.message });
  }

  // Clear out sessions nobody is coming back for (#1418). At boot rather than
  // on a timer because `authSessions.resolve` already deletes an expired row the
  // moment it meets one, so the rows this catches are only those from browsers
  // that closed for good — a housekeeping problem in a tiny table, not a
  // security one. (Not a prohibition: #98/#268 ban timer-driven UI lifecycle,
  // which says nothing about server-side reaping, and this file already runs
  // `_lockExpiryInterval`.)
  try {
    store.authSessions.sweepExpired();
  } catch (err) {
    // Never fatal. A failed sweep leaves dead rows in a small table; refusing
    // to boot over it would turn a tidiness problem into an outage.
    log.warn('Expired-session sweep failed', { error: err.message });
  }

  // PID file guard — prevent duplicate instances
  const existingPid = pidfile.check();
  if (existingPid) {
    // eslint-disable-next-line no-console
    console.error(`TangleClaw is already running (PID ${existingPid}). Exiting.`);
    process.exit(1);
  }
  pidfile.write();

  // Initialize file logging
  initFileLogging(path.join(store._getBasePath(), 'logs'));

  if (!envLogLevel && config.logLevel) {
    setLevel(config.logLevel);
  }

  // Recover the last process's shared-doc deliveries before a server exists:
  // every delivery it left `pending` becomes `interrupted`, never resent or
  // extended. A failed sweep refuses the start here, before anything listens,
  // a watcher starts or boot touches tmux or the ttyd job, and leaves routing
  // closed in this process: an unrecovered revision could otherwise be
  // extended by a later attestation. After the PID file is written, so the
  // refusal removes only this process's own.
  try {
    const swept = sharedDocRecord.recoverDeliveries();
    if (swept.revisions > 0) log.warn('Shared-doc deliveries interrupted by the last stop: not resent', swept);
  } catch (err) {
    log.error('Refusing to start: interrupted shared-doc deliveries could not be recovered', { error: err.message });
    pidfile.remove();
    process.exit(1);
  }

  // #397 credential durability (2026-07-03 lockout): in caddy mode, if the live
  // Caddyfile carries a basic_auth credential that the canonical config doesn't,
  // adopt it into config at boot — READ-ONLY on the Caddyfile. Makes the working
  // credential durable so every future regeneration (cutover, reset-admin)
  // re-emits the same hash instead of losing it with the file. Never overwrites
  // an existing config credential; non-throwing.
  if (config.ingressMode === 'caddy') {
    caddy.adoptCredentialIntoConfig();
  }

  // #500 — keep the ttyd attach script current in its non-TCC install path
  // (~/.tangleclaw/deploy/). ttyd opens this file per client-connect and is
  // denied Full Disk Access, so a repo-resident copy under ~/Documents freezes
  // ttyd in open() (all sessions black-screen after a ttyd restart). Running at
  // every boot means an update that bumps the repo script refreshes the copy on
  // the ensuing restart. Idempotent + non-throwing.
  ttydAttach.syncAttachScript({ repoDir: __dirname, baseDir: store._getBasePath() });

  // Re-stamp the version into the status bar of sessions that already exist
  // (#745). A session sets its bar once, at creation, so every session that
  // survives an update would otherwise keep naming the version it was born
  // under — and surviving the update is the normal case, since the restart
  // that loads new code leaves tmux running. Boot is the only moment the
  // running version can change, so this needs no polling. Deliberately before
  // listen and synchronous, so a session attached in the first moments after a
  // restart already reads the right version rather than briefly showing the old
  // one: two `tmux` calls per session, ~6ms each, measured at ~58ms across ten
  // sessions. Non-throwing, so a tmux quirk cannot keep the server from
  // listening.
  try {
    tmux.refreshStatusBars();
  } catch (err) {
    log.warn('Status-bar refresh failed', { error: err.message });
  }

  // Say so when tmux's global environment holds a launch identity variable
  // (#2268). A launch decides each of them itself, so none reaches a pane
  // TangleClaw creates; the operator is told because every other session on
  // that tmux server inherits them. Read once, here: the answer is carried on
  // `GET /api/server-info`, which is polled too often to run tmux. Before
  // listen so the first poll already has it, bounded by tmux's read timeout,
  // and non-throwing, so a tmux that does not answer cannot stop the start.
  try {
    require('./lib/launch-identity').reportGlobalIdentity({ read: tmux.readGlobalIdentityKeys, log, setNotice: serverInfo.setLaunchIdentityNotice });
  } catch (err) {
    log.warn('Launch identity report failed', { error: err.name });
  }

  // Pin the INSTALLED ttyd job to its configured interface (#710). install.sh
  // writes that plist once and an update is only a `git checkout`, so without
  // this an existing machine keeps serving a `--writable` terminal — one that
  // execs `tmux attach-session` — to its entire network, while the release notes
  // say otherwise. Same non-fatal contract as the attach-script sync above: it
  // refuses anything it does not recognize, backs up and validates before
  // touching the live job, and restores the previous one if ttyd does not come
  // back. Nothing here can affect the dashboard or this process.
  try {
    const ttydPlan = ttydBind.reconcileInstalledJob({
      home: os.homedir(),
      config,
      deps: {
        fs, path, execFileSync: require('node:child_process').execFileSync,
        uid: process.getuid ? process.getuid() : 0,
        log,
        // Confirm the job actually came back rather than assuming launchctl's
        // silence means success — a valid plist that launchd accepts can still
        // produce a ttyd that exits immediately.
        probe: (port) => {
          const { execFileSync } = require('node:child_process');
          // A missing probe tool is not a failed ttyd. Rolling back a good change
          // because `nc` is absent would be the tool breaking the thing it exists
          // to protect, so an unavailable prober means "unverified", not "dead".
          try {
            execFileSync('command', ['-v', 'nc'], { timeout: 1000, stdio: 'ignore', shell: true });
          } catch {
            log.warn('Skipped ttyd liveness verification — no `nc` on PATH', { port });
            return true;
          }
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            try {
              execFileSync('nc', ['-z', '127.0.0.1', String(port)], { timeout: 1000, stdio: 'ignore' });
              return true;
            } catch { /* not up yet — retry until the deadline */ }
          }
          return false;
        }
      }
    });
    if (ttydPlan.action === 'refuse') {
      // The interface it judged rides along, so a misclassified bind is
      // diagnosable from the log and not only from the notice's presence.
      log.warn('Left the installed ttyd job alone', {
        reason: ttydPlan.reason, iface: ttydPlan.from, stillWide: ttydPlan.stillWide
      });
      // Refusing is correct — guessing at an unrecognized job could take every
      // terminal down. But if the job it declined to touch is still reachable
      // from off the machine, that is an unauthenticated shell on the network,
      // and a log line reaches nobody who is looking at a browser.
      if (ttydPlan.stillWide) {
        serverInfo.setTtydNotice({
          setting: 'ttyd interface',
          severity: 'exposed',
          message: 'TangleClaw could not pin the terminal service to this machine, so it is still '
            + 'accepting connections from your whole network — and it opens a shell with no password. '
            + `TangleClaw did not change it because: ${ttydPlan.reason}. Fix it from a terminal on `
            + 'this machine, or reinstall TangleClaw to regenerate the service definition.'
        });
      }
    }
  } catch (err) {
    log.warn('ttyd bind reconciliation skipped', { error: err.message });
  }

  // Bootstrap port management — resolve actual port (env var takes precedence).
  // Shares the one derivation with every consumer that reports or injects this
  // port, so what we bind and what we tell operators/agents cannot diverge.
  const port = httpsSetup.effectiveServerPort(config);

  warnUnbindablePortEnv(port);
  // AUTH-1 (#395): the ttydPort lease is kept even in caddy mode, where ttyd is
  // socket-bound and nothing listens on :3100. This is deliberate — reserving the
  // port keeps it free so a rollback to direct mode rebinds cleanly, rather than
  // racing another project for it. (Critic warning, ADR 0003.)
  porthub.bootstrap({ ttydPort: config.ttydPort || 3100, serverPort: port });
  porthub.startExpirationTimer();

  // AUTH-1 (#395): in 'caddy' ingress mode Caddy terminates TLS and is the only
  // front door, so TC drops to plain HTTP (Caddy reaches it over the loopback).
  // 'direct' mode terminates its own HTTPS. The live cutover is operator-driven;
  // until ingressMode is flipped this branch is inert.
  // This decides the PROTOCOL only — which interfaces either mode binds is
  // lib/bind-policy.js's call, and is no longer implied by the ingress mode.
  const caddyMode = config.ingressMode === 'caddy';
  const effectiveHttps = caddyMode ? false : !!config.httpsEnabled;
  const server = createServer({
    httpsEnabled: effectiveHttps,
    certPath: config.httpsCertPath || null,
    keyPath: config.httpsKeyPath || null
  });

  // Start model status monitor
  modelStatus.startMonitor(store.engines.list(), config.modelStatusIntervalMs || 120000);

  // Start update checker (first check 60s after startup, then on an interval).
  // A rejected `updateCheckIntervalMs` is logged rather than silently swallowed —
  // an operator who set it deserves to know it didn't take.
  const checkInterval = updateChecker.resolveCheckInterval(config.updateCheckIntervalMs);
  if (checkInterval.warning) {
    log.warn(`Ignoring updateCheckIntervalMs: ${checkInterval.warning}`, { usingMs: checkInterval.intervalMs });
  }
  updateChecker.startChecker(checkInterval.intervalMs);

  // Start eval audit heartbeat watchdog
  evalAudit.startWatchdog((level, sessionId, project, message) => {
    log.warn('Eval audit watchdog alert', { level, sessionId, project, message });
  });

  // Start sidecar polling for active OpenClaw sessions
  sidecar.syncPolling();

  // Refresh the master's identity file on every boot, regardless of autoStart.
  // It embeds the TangleClaw API base URL, and only ensureMasterSession used to
  // rewrite it — so with autoStart off, an install whose effective port changed
  // kept telling the master to call a dead port until someone opened the master
  // (#726). Managed projects already heal below via syncAllProjects(); this is
  // the master's equivalent. skipIfAbsent so starting the server never creates
  // master state for an operator who has not used it.
  try {
    // `fleetState` starts the async state pass that fills FLEET.md in; it is
    // fire-and-forget inside, so boot never waits on the fleet's git reads.
    const refreshed = master.refreshMasterIdentity({ skipIfAbsent: true, fleetState: true });
    if (refreshed.refreshed) log.debug('Master identity refreshed', { home: refreshed.home });
  } catch (err) {
    log.warn('Master identity refresh failed', { error: err.message });
  }

  // The Master at boot (ADR 0023): settle the bridge credential the previous
  // process left, then auto-start the Master if the operator turned that on
  // (master.autoStart). One call, so the reconciliation can never run after a
  // launch and revoke that launch's credential mid-handoff. Before `listen`, so
  // no request or gateway pass can create a Master first. Never fatal — the
  // brain icon's on-demand ensure remains the fallback path.
  master.bootMaster();

  // Drift detector (#595): TangleClaw's own CLAUDE.md is hand-maintained because
  // the Prawduct plugin governs this repo. Compare it against data/global-rules.md
  // at boot so edits made via the API/UI don't silently fail to govern TC itself.
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const tcClaudeMdPath = path.join(process.cwd(), 'CLAUDE.md');
    const globalRulesPath = path.join(process.cwd(), 'data', 'global-rules.md');
    
    if (fs.existsSync(tcClaudeMdPath) && fs.existsSync(globalRulesPath)) {
      const claudeMdContent = fs.readFileSync(tcClaudeMdPath, 'utf8');
      const globalRulesContent = fs.readFileSync(globalRulesPath, 'utf8').trim();
      
      if (!claudeMdContent.includes(globalRulesContent)) {
        log.warn('DRIFT DETECTED: TangleClaw\'s own CLAUDE.md is out of sync with data/global-rules.md', {
          advisory: 'Global rules were edited but not synced to TC\'s engine config. Run a sync or hand-edit CLAUDE.md to match.'
        });
      }
    }
  } catch (err) {
    log.warn('Global rules drift detection failed', { error: err.message });
  }

  // Run retention policy on startup (purge old eval data)
  try {
    const retentionDays = store.DEFAULT_PROJECT_CONFIG.evalAuditMode.retentionDays || 90;
    const retentionResult = evalAudit.runRetentionPolicy(store, retentionDays);
    if (retentionResult.exchangesPurged > 0) {
      log.info('Startup retention policy', retentionResult);
    }
  } catch (err) {
    log.warn('Startup retention policy failed', { error: err.message });
  }

  // Sync all projects: ensure scaffolding + regenerate engine configs
  try {
    const syncResult = projects.syncAllProjects();
    if (syncResult.synced > 0) {
      log.info('Startup project sync', syncResult);
    }
    if (syncResult.errors.length > 0) {
      log.warn('Startup project sync errors', { errors: syncResult.errors });
    }
  } catch (err) {
    log.warn('Startup project sync failed', { error: err.message });
  }

  // Stranded-config guard (#592): governance files in unregistered ancestor
  // dirs re-inject stale rules into nested projects' sessions (Claude Code
  // loads every ancestor CLAUDE.md). Detection only — see the API route.
  try {
    const strandedResult = projects.scanForStrandedConfigs();
    for (const s of strandedResult.stranded) {
      log.warn('Stranded governance config in ancestor dir (#592)', {
        dir: s.dir,
        files: s.files,
        affectedProjects: s.affectedProjects
      });
    }
  } catch (err) {
    log.warn('Stranded-config scan failed', { error: err.message });
  }

  // Start document lock expiry timer (every 5 minutes)
  const _lockExpiryInterval = setInterval(() => {
    try {
      store.documentLocks.expireStale();
    } catch (err) {
      log.warn('Lock expiry sweep failed', { error: err.message });
    }
    // Drafts cleared before an injection are kept only a retention period past
    // their attempt (#1507). A failed sweep leaves them in place.
    const drafts = require('./lib/draft-store').pruneDrafts();
    if (drafts.deleted.length > 0) log.info('Expired kept drafts', { attempts: drafts.deleted.length });
    if (drafts.errors.length > 0) log.warn('Draft retention sweep could not finish', { errors: drafts.errors.length });
  }, 5 * 60 * 1000);

  // Describe the socket that exists, not the one the config asked for.
  const protocol = serverProtocol(server);
  const servingHttps = protocol === 'https';
  // Record the legacy install's "never chosen" state as a real value before
  // anything reads it. Absence of the key identifies such an install exactly
  // once — the next config save of any kind would materialize the default and
  // erase the distinction — so it is converted to an explicit value here and
  // persisted: null (grace) for an install the store shows was used, false for
  // one written by hand before its first boot, which has no remote operator to
  // strand. Everything downstream reads the value, never the file.
  const legacyBind = bindPolicy.migrateLegacyBind(
    config,
    store.config.isKeyPersisted(bindPolicy.OPT_IN_KEY),
    _installPriorUse()
  );
  if (legacyBind.migrated) {
    try {
      store.config.save(config);
      log.info(legacyBind.reason === 'fresh-install'
        ? 'Recorded this install as fresh: its config has no network-binding setting and nothing shows it was used, so it listens on loopback'
        : 'Recorded this install as predating the network-binding setting', {
        setting: bindPolicy.OPT_IN_KEY, reason: legacyBind.reason
      });
    } catch (err) {
      // Non-fatal: the in-memory value still drives this boot correctly, so the
      // operator keeps their access and the warning below still fires. It will
      // simply be re-attempted next start.
      log.warn('Could not persist the network-binding grace state — will retry next start', {
        error: err.message
      });
    }
  }

  const bind = bindPolicy.resolveBind(config);
  const bindHost = bind.host;
  const bindLabel = bind.label;

  // An opt-in that caddy mode overrode is refused out loud. Silently ignoring it
  // would leave the config claiming one thing while the socket does another —
  // and the operator believing they had reopened remote access when they had not.
  if (bind.refusedOptIn) {
    log.warn(
      `Ignoring "${bindPolicy.OPT_IN_KEY}": true — Caddy is the ingress in this mode and already `
      + 'listens on every interface, so a second, plain-HTTP listener beside it would only carry '
      + 'passwords unencrypted. Reach TangleClaw through Caddy. The saved value applies again if '
      + 'you set "ingressMode": "direct".',
      { ingressMode: config.ingressMode }
    );
  }

  // A non-boolean opt-in reads as "not opted in", which is the safe choice — but
  // the operator who typed it believes they reopened the door, so say otherwise.
  if (bind.malformedOptIn) {
    log.warn(
      `Ignoring "${bindPolicy.OPT_IN_KEY}" — it must be a boolean (true or false, unquoted). `
      + 'TangleClaw is treating this as not-opted-in and binding loopback only.',
      { setting: bindPolicy.OPT_IN_KEY, type: typeof config[bindPolicy.OPT_IN_KEY] }
    );
  }

  // An install written before this key existed is still bound wide, deliberately
  // (ADR 0009's 2026-07-28 amendment) — narrowing it would take away the remote
  // access its operator may be using to read this very dashboard, before the
  // credential gate exists to replace it. That is a bounded exposure window, not
  // an accepted state, so it is reported on every boot and on the dashboard until
  // the operator resolves it. Unlike the terminal listener, which is pinned
  // immediately because nothing external addresses it.
  // The gate state decides only whether that wide bind is guarded — an install
  // whose own login is armed is not "reachable with no password". The log line
  // reads it once, at boot; the dashboard's copy is re-derived per request from
  // the recorded bind and that request's gate state (`serverInfo.getServerInfo`),
  // because the login can change without a restart and the bind cannot.
  const bindNotice = bindPolicy.describeNarrowing(
    config, authGate.resolveGateState(() => config, store.authSessions, _gateIngress)
  );
  if (bindNotice) {
    log.warn(bindNotice.message, { setting: bindNotice.setting, severity: bindNotice.severity });
  }
  serverInfo.setBindConfig(config);

  // #1394 — compare the live Caddyfile against the one the generator would
  // write, and report the security properties it does not hold.
  //
  // Caddy-mode only: in direct mode TangleClaw is not behind a Caddyfile, so
  // there is nothing it owns to have drifted.
  //
  // Deferred past listen with setImmediate because it spawns `caddy adapt`
  // twice, and delaying the socket by a subprocess pair to answer a question
  // nobody is waiting on is the wrong trade. Measured once, at boot, and
  // carried on /api/server-info — re-running it per poll would spawn two
  // processes on the route the dashboard polls continuously.
  if (config.ingressMode === 'caddy') {
    setImmediate(() => {
      try {
        const leases = (() => {
          try {
            return store.portLeases.list();
          } catch (err) {
            // Null, not []: an empty list would read as "no lease declares a
            // narrow reach" and turn an unanswered PortHub into a clean bill.
            log.warn('Could not read port leases for the Caddyfile drift check', { error: err.message });
            return null;
          }
        })();
        // The gate state decides whether the baseline still carries
        // `basic_auth`: once TangleClaw's own gate guards the door, a live file
        // without it has not lost a gate.
        const gateState = authGate.resolveGateState(() => config, store.authSessions, _gateIngress);
        const result = caddyDrift.checkCaddyDrift({ config, leases, gateState });
        const notice = caddyDrift.describeDrift(result);
        serverInfo.setCaddyDriftNotice(notice);
        if (notice) {
          log.warn(notice.message, { setting: notice.setting, severity: notice.severity, findings: notice.findings });
        } else {
          log.info('Live Caddyfile holds every security property TangleClaw generates');
        }
      } catch (err) {
        // The check is diagnostic. A fault in it must never take the server
        // down, but it must also not leave the dashboard implying a clean file.
        // Redacted on the way in, not trusted to arrive clean: this path can
        // carry a `caddy adapt` stderr string, which quotes the offending
        // Caddyfile line — and that line can be `basic_auth <user> <hash>`.
        const reason = caddy.redactHashes(`the check itself failed: ${err.message}`);
        log.warn('Caddyfile drift check failed to run', { error: reason });
        serverInfo.setCaddyDriftNotice(caddyDrift.describeDrift({
          measured: false, reason, findings: []
        }));
      }
    });
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${port} is already in use — another process is bound to it. Exiting.`);
      pidfile.remove();
      process.exit(1);
    }
    throw err;
  });

  const onListening = () => {
    // Installed here and not before: until the listener is bound it has no
    // address, the fallback check would be asked about a door that does not
    // exist yet, and with no probe a launch takes the operator-cleared default.
    recoveryDefault.setGateStateProbe(_recoveryGateProbeFor(server));
    log.info(`TangleClaw v${_getVersion()} listening on ${protocol}://${bindLabel}:${port}${caddyMode ? ' (behind Caddy)' : ''}`, {
      node: process.version,
      pid: process.pid,
      https: servingHttps,
      // #864 — the names state-changing requests and WebSocket upgrades are
      // accepted under. Logged because this list is DERIVED (from
      // `certHostUnion` — the certificate's own names, the mkcert defaults, the
      // mDNS name and the two configured public names — plus the bare machine
      // name), and a derivation that misses a legitimate address refuses writes
      // from it. That reads as "the
      // dashboard is broken" unless the operator can see what the server
      // believes it serves. Printing it costs one line and turns a silent
      // refusal into a diff against reality.
      servedHosts: [...httpsSetup.servedHostAllowlist(config)].sort().join(', '),
      // Surfaced only when intent and reality diverge, so the listen line
      // points back at the fallback WARN logged during construction rather
      // than leaving the operator to notice the mismatch themselves.
      ...(effectiveHttps && !servingHttps ? { httpsFallback: true } : {}),
      ingressMode: config.ingressMode || 'direct',
      // WHY this host, not just which one. An operator reading a log to find out
      // why they cannot reach the dashboard needs the reason and the setting
      // that changes it, otherwise the line states the symptom and withholds the
      // cause. `grace` in particular is the one worth spotting: it means the
      // machine is still wide open and nobody has decided yet.
      bind: bind.reason,
      bindSetting: bindPolicy.OPT_IN_KEY
    });
    // #1905 — a configured tailnet name the overlay no longer reports keeps
    // serving (it is what the certificate and the Caddy site were built for),
    // and the observed one is refused until reconciled. Say so at boot, where an
    // operator looking for "why is my MagicDNS name refused" reads first.
    const bootTailnet = hostInventory.resolveTailnetHost(config);
    if (bootTailnet.drift) {
      log.warn('Configured tailnet host differs from the observed overlay name; the observed name '
        + 'is refused until reconciled. Direct mode: POST /api/setup/generate-cert '
        + '{"reconcileTailnet": true}. Caddy mode: POST /api/setup/generate-cert '
        + '{"reconcileTailnet": "prepare"}, then node scripts/ingress-cutover.js --to caddy '
        + `--tailnet-host ${bootTailnet.drift.observed}`,
      bootTailnet.drift);
    }
    // Start ttyd zombie-child watcher (#94). macOS-only; no-op elsewhere.
    ttydWatcher.start();
    // First ttyd health reading (#345), so the dashboard's first poll after a
    // restart finds a measurement. Fire-and-forget; the route never awaits one.
    systemHealth.warm();
    // Start OpenClaw tunnel liveness monitor (#294) — auto-recreates tunnels
    // that die out from under an open Web UI so they self-heal without a
    // manual re-launch.
    tunnelMonitor.start();
    // Start the engine-error monitor (#261): reads each live tmux pane's tail
    // for the engine's own API errors. It reads nothing as a wrap request (#2027).
    engineErrorMonitor.start();
    // Start the Medusa wake-nudge monitor (MED-2K9P v2 T2) — idle-gated inbox
    // watcher that types a fixed nudge into an opted-in (`medusaWake`) session
    // when fresh inbound mail is waiting and the pane is at a bare prompt.
    medusaWake.start();
    // Start the bounded fleet activity observer (#1912, ADR 0020 §5): one
    // asynchronous capture per live session per 10 s tick, within a 3 s budget,
    // so the fleet read can report engine activity without capturing a pane.
    activityObserver.start();
    // Start the Medusa delivery watchdog (#1839): a deterministic pass over
    // durable exchange state that re-arms a wake through the monitor's gates
    // on a durable trigger: a nudge provably not accepted, or the session
    // recorded as ready again after it.
    medusaWatchdog.start();
    // Start every registered startupControl adapter (#1825): each probes its
    // engine's version once, so capability resolution never spawns on a
    // request path, recovers the channels and in-flight fires a restart
    // interrupted, and reaps servers whose sessions ended while TangleClaw was
    // down. Fire transitions go through the service's one writer, so recovery
    // is logged like a live fire.
    for (const [name, adapter] of Object.entries(startupControl.ADAPTERS)) {
      if (typeof adapter.start !== 'function') continue;
      Promise.resolve(adapter.start({ applyTransition: (fireId, patch) => startupPrompt.applyFireTransition(fireId, patch) }))
        .catch((err) => log.warn('startupControl adapter failed to start', { adapter: name, error: err.message }));
    }
    // Start the unready-launch monitor (Train 21, #1583) — records the launches
    // that have not attested READY inside their window and nudges each one once,
    // behind the same idle gate the wake monitor uses. It records and reminds;
    // it gates nothing.
    launchUnready.start();
    sessions.startLaunchBlockerSweep();
    // Start the workload nudge monitor (#2262): types one line into a session
    // whose workload report expired, for projects that turned it on. It reads
    // engine activity from the observer above and types only into a pane seen
    // at rest.
    workloadNudge.start({ observer: activityObserver });
    // Start the check watch monitor (#2323): reads each open watch's check
    // from GitHub about once a minute, records its result, and sends the
    // watch's project a switchboard message. Its own listener is started by
    // its passes, only while there is a watch to send for, and stopped by
    // `stop()`. It types into nothing.
    checkWatch.start();
    // Re-sync Medusa listeners for live sessions (TC#550, MED-2K9P v2 T4) —
    // listeners are in-memory, so without this a server restart silently
    // deregistered every running session from the switchboard.
    sessions.resyncMedusaListeners();
    // Resume the server's side of any coordinator rotation a restart
    // interrupted (#2032); each step is a compare-and-set, so a pass that had
    // already landed is not repeated.
    coordinatorRotation.recover();
    // The Master's half of that re-sync (#996): a Master left running across
    // a TangleClaw restart would otherwise drop off the switchboard until its
    // next ensure. Probes tmux and starts nothing when tmux does not answer.
    master.resyncMasterMedusa();
    // The gateway listens exactly while the bridge is enabled, and its pass
    // carries on any route a restart interrupted. Both do nothing while it is off.
    try {
      bridgeGateway.syncListener();
    } catch (err) {
      log.warn('Operator bridge listener could not be started', { error: err.message });
    }
    setInterval(() => {
      bridgeGateway.tick().catch((err) => log.warn('Operator bridge pass failed', { error: err.message }));
    }, BRIDGE_TICK_MS).unref();
    // Resolve the operator's login PATH once, here, so no request ever pays for
    // it. launchd hands this service `/usr/bin:/bin:/usr/sbin:/sbin`, which
    // contains none of the places an engine CLI actually installs (#346) — and
    // reading the real PATH means starting their shell and running their
    // profile, which is unbounded work that must not happen on the event loop
    // inside a route. Fire-and-forget: detection falls back to this process's
    // own PATH until it lands, which is exactly what it did before.
    refreshSharedDocWatchers();
    engines.refreshDetectionPath().catch((err) => {
      log.warn('Could not resolve the login PATH at boot; engine detection will see only '
        + 'the PATH launchd gave this service', { error: err && err.message });
    });
  };

  // Loopback unless something is guarding the door — see lib/bind-policy.js.
  // A null host is Node's "every interface", reached only via the explicit opt-in.
  if (bindHost) {
    server.listen(port, bindHost, onListening);
  } else {
    server.listen(port, onListening);
  }

  // Graceful shutdown
  const shutdown = () => {
    log.info('Shutting down');
    pidfile.remove();
    porthub.shutdown({ ttydPort: config.ttydPort || 3100, serverPort: port });
    porthub.stopExpirationTimer();
    modelStatus.stopMonitor();
    updateChecker.stopChecker();
    evalAudit.stopWatchdog();
    sidecar.stopAllPolling();
    ttydWatcher.stop();
    tunnelMonitor.stop();
    engineErrorMonitor.stop();
    medusaWake.stop();
    activityObserver.stop();
    medusaWatchdog.stop();
    launchUnready.stop();
    sessions.stopLaunchBlockerSweep();
    workloadNudge.stop();
    checkWatch.stop();
    // Each startupControl adapter's reaper timer (#1825): the timers are unref'd,
    // so this is bookkeeping symmetry with `start`, not what lets the process exit.
    for (const [name, adapter] of Object.entries(startupControl.ADAPTERS)) {
      try {
        if (typeof adapter.stop === 'function') adapter.stop();
      } catch (err) {
        log.warn('startupControl adapter failed to stop', { adapter: name, error: err.message });
      }
    }
    clearInterval(_lockExpiryInterval);
    server.close();
    // Shared-doc notices already on their way are given a bounded moment to
    // settle, so a planned restart does not leave them `interrupted`; one that
    // outlasts it is swept at the next boot, as a crash would leave it.
    sharedDocRecord.drain(SHUTDOWN_NOTICE_DRAIN_MS).finally(() => {
      store.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { error: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { error: String(reason) });
  });
}


module.exports = { _routePatterns, createServer, _recoveryGateProbeFor, _operatorProofOf, serverProtocol, _setInstallPriorUse, warnUnbindablePortEnv, handleRequest, handleUpgrade, route, matchRoute, jsonResponse, errorResponse, parseBody, parseQuery, reqUrl, MAX_BODY_SIZE, MESSAGE_BODY_LIMIT_BYTES, _setRestartScheduler, _setCutoverSpawner, _recoveryFailures, _openclawProxyHeaders, _openclawWsRequestLines, _hostIsAllowed, _servedHostsOrEmpty, _sharedDocWatchers: sharedDocWatchers, _sharedDocDebounceTimers: docDebounceTimers, _activityObserver: activityObserver, _exchangeCaller: exchangeCaller, _checkPublicAssets, _setPublicDir };
