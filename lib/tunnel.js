'use strict';

const net = require('node:net');
const { spawn, execSync } = require('node:child_process');
const { createLogger } = require('./logger');
const porthub = require('./porthub');

const log = createLogger('tunnel');

// Active tunnels: projectName → { pid, localPort, host, remotePort }
const _tunnels = new Map();

/**
 * Probe a TCP port to see if something is listening.
 * @param {number} port - Port to probe
 * @param {string} [host='127.0.0.1'] - Host to probe
 * @param {number} [timeoutMs=2000] - Timeout in milliseconds
 * @returns {Promise<boolean>} - true if port is connectable
 */
function tcpProbe(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.connect(port, host);
  });
}

/**
 * Bind-check the LOCAL forward end on both loopback families (#295) — the TCP
 * analogue of `_fetchLoopback`. ssh usually binds the local `-L` port on IPv4
 * (127.0.0.1) but can bind IPv6-only ([::1]); a 127.0.0.1-only probe would
 * dismiss a live IPv6-bound tunnel as "not bound" and short-circuit the
 * end-to-end round-trip below it. `net.Socket` wants the bare IPv6 literal
 * `::1` (no brackets, unlike URL form). IPv4 first → no added latency in the
 * common case.
 * @param {number} port - Local tunnel port
 * @param {number} [timeoutMs=2000] - Per-family connect timeout
 * @returns {Promise<boolean>} true if either loopback family accepts a connection
 */
async function _loopbackConnectable(port, timeoutMs = 2000) {
  if (await tcpProbe(port, '127.0.0.1', timeoutMs)) return true;
  return tcpProbe(port, '::1', timeoutMs);
}

// #291: the REMOTE forward target for `ssh -L <localPort>:<target>:<remotePort>`.
// Docker Desktop for Mac republishes container ports as an IPv6-only socket
// after a restart, so a `127.0.0.1` target dead-ends (`[::1]` answers, IPv4
// loopback resets). Linux hosts publish dual-stack, so 127.0.0.1 works there.
// We try IPv4 first (the common case) and fall back to IPv6, keeping whichever
// passes the end-to-end round-trip (#288). In argv the IPv6 form is bracketed.
const FORWARD_TARGETS = ['127.0.0.1', '[::1]'];

// #295: the LOCAL end of `ssh -L <localPort>:...` usually binds IPv4 loopback
// (127.0.0.1), but on some hosts/configs it binds IPv6-only ([::1]) — the
// local-side analogue of the #291 remote-target family problem. Every local
// HTTP probe (httpRoundTrip, checkHealth) must therefore try both families and
// accept whichever answers, or a healthy tunnel gets misreported as dead.
// IPv4 first (the common case answers immediately, so no added latency); bracket
// the IPv6 literal for URL syntax.
const LOCAL_LOOPBACKS = ['127.0.0.1', '[::1]'];

/**
 * fetch() a local loopback URL, trying IPv4 then IPv6 and returning the first
 * Response that comes back (#295). Each family attempt gets its own timeout, so
 * the common IPv4-healthy case returns at single-attempt latency; only a failed
 * IPv4 attempt incurs the IPv6 fallback. Throws the last error if every family
 * fails (callers translate that to dead/unhealthy).
 * @param {number} port - Local tunnel port
 * @param {string} pathname - Request path, e.g. '/' or '/healthz'
 * @param {object} fetchOpts - Extra fetch options (headers, redirect, …); `signal` is managed here
 * @param {number} timeoutMs - Per-family abort timeout
 * @returns {Promise<Response>}
 */
async function _fetchLoopback(port, pathname, fetchOpts, timeoutMs) {
  let lastErr;
  for (const host of LOCAL_LOOPBACKS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`http://${host}:${port}${pathname}`, { ...fetchOpts, signal: controller.signal });
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * End-to-end liveness probe through an established tunnel (#288). A bound local
 * port only proves the socket is held — with `ExitOnForwardFailure=yes` an
 * `ssh -f -N -L` keeps the local socket bound for up to ~90s after its
 * transport dies (a "zombie" tunnel forwarding into a void), and a wrong
 * forward target (#291) leaves it bound-but-dead from the first second. This
 * does a real HTTP round-trip to the local end: ANY HTTP status
 * (200/401/404/502…) proves the transport reached a live gateway; a timeout or
 * connection error means the tunnel is dead despite being bound.
 * @param {number} localPort - Local tunnel port (probed on loopback, where ssh binds locally — IPv4 or IPv6, #295)
 * @param {number} [timeoutMs=4000] - Abort each loopback-family attempt after this long
 * @returns {Promise<boolean>} true if the tunnel carried an HTTP response
 */
async function httpRoundTrip(localPort, timeoutMs = 4000) {
  try {
    // Probe both loopback families (#295); any status code means headers
    // arrived — transport is live end-to-end.
    const res = await _fetchLoopback(localPort, '/', { redirect: 'manual' }, timeoutMs);
    return typeof res.status === 'number';
  } catch {
    // AbortError (timeout) / ECONNRESET / ECONNREFUSED / socket hang on every
    // family → dead.
    return false;
  }
}

/**
 * Ensure an SSH tunnel is running for a project's OpenClaw connection.
 * If the local port already passes an end-to-end round-trip (a genuinely live
 * tunnel), skips spawning; a bound-but-dead "zombie" (or `force`) is torn down
 * and rebuilt (#288). Otherwise spawns `ssh -f -N -L ...` in the background,
 * trying remote forward target `127.0.0.1` first and falling back to `[::1]`
 * for IPv6-only Docker-Desktop hosts (#291), and tracks the PID.
 *
 * @param {string} projectName - Project identifier (key for tracking)
 * @param {object} config - Connection config
 * @param {string} config.host - Remote host
 * @param {number} config.port - Remote OpenClaw port
 * @param {number} config.localPort - Local port to forward to
 * @param {string} config.sshUser - SSH username
 * @param {string} config.sshKeyPath - Path to SSH private key (~ expanded)
 * @param {boolean} [config.force] - Tear down and rebuild even if the tunnel is live
 * @param {Array<{localPort: number, remotePort: number}>} [config.extraForwards] - Additional port forwards
 * @returns {Promise<{ ok: boolean, alreadyUp: boolean, pid: number|null, forwardTarget?: string, error: string|null }>}
 */
async function ensureTunnel(projectName, config) {
  const { host, port, localPort, sshUser, sshKeyPath, extraForwards } = config;
  const keyPath = sshKeyPath.replace(/^~/, process.env.HOME);

  // #288: end-to-end check, not just bind. A bound-but-dead "zombie" tunnel
  // (transport dropped under ExitOnForwardFailure, or a wrong forward target
  // per #291) keeps the local socket bound while forwarding into a void — it
  // must be torn down and rebuilt, never reported as alreadyUp.
  const bound = await _loopbackConnectable(localPort);
  const liveEndToEnd = bound ? await httpRoundTrip(localPort) : false;
  if (liveEndToEnd && !config.force) {
    const existingPid = _findSshPid(localPort, host);
    log.info('Tunnel already up (end-to-end round-trip OK)', { project: projectName, localPort, pid: existingPid });
    // Ensure PortHub knows about this port. The ownership check that used to
    // live here is now enforced inside the lease itself (#613), so a claim on
    // another project's port fails rather than needing to be pre-empted — and
    // the store's rule is the stricter one: this guard treated an EXPIRED
    // foreign lease as a reason to skip, which left the port bound and
    // unrecorded. A refusal is logged and does not stop the tunnel, which was
    // already the behavior when this skipped.
    porthub.registerPort(localPort, projectName, 'openclaw-tunnel', { permanent: false, ttlMs: 86400000 });
    // Track it in memory if not already tracked (handles server restarts)
    if (!_tunnels.has(projectName) && existingPid) {
      _tunnels.set(projectName, { pid: existingPid, localPort, host, remotePort: port });
    }
    return { ok: true, alreadyUp: true, pid: existingPid, error: null };
  }
  if (bound) {
    // Either force mode, or a zombie (bound but no round-trip). Tear it down
    // before rebuilding so the fresh spawn can bind the local port.
    log.info('Tearing down existing tunnel before rebuild', {
      project: projectName,
      localPort,
      reason: config.force ? 'force' : 'zombie (bound but no end-to-end round-trip)'
    });
    // killTunnelByPort verifies the socket is released before returning.
    await killTunnelByPort(localPort, host);
  }

  // Spawn the tunnel, trying each forward target until the end-to-end
  // round-trip passes (#291 + #288). IPv4 first (Linux / dual-stack hosts),
  // then [::1] for Docker-Desktop-for-Mac's post-restart IPv6-only publish.
  // The remote forward target of `-L` is resolved lazily (per-connection), so
  // ssh binds + forks successfully even against a dead target — only the
  // round-trip can tell IPv4 from IPv6 here, which is why bind-based detection
  // never caught it.
  let lastError = 'SSH tunnel spawned but port not connectable';
  for (const target of FORWARD_TARGETS) {
    let spawned;
    try {
      spawned = await _spawnTunnelOnce(config, keyPath, target);
    } catch (err) {
      log.error('Failed to spawn SSH tunnel', { project: projectName, target, error: err.message });
      lastError = err.message;
      continue;
    }

    if (!spawned.bound) {
      // ssh never bound the local port — a target-independent failure (auth,
      // network, DNS, local-bind conflict). Retrying the other target would
      // just repeat it, so surface the attributed error and stop.
      return {
        ok: false,
        alreadyUp: false,
        pid: null,
        error: _formatTunnelError(spawned.stderr, extraForwards)
      };
    }

    const live = await httpRoundTrip(localPort);
    if (live) {
      const pid = _findSshPid(localPort, host);
      _tunnels.set(projectName, { pid, localPort, host, remotePort: port, forwardTarget: target });
      // Ownership is enforced by the lease itself (#613) — see the equivalent
      // call on the already-up path above.
      porthub.registerPort(localPort, projectName, 'openclaw-tunnel', { permanent: false, ttlMs: 86400000 });
      log.info('Tunnel established', { project: projectName, localPort, pid, forwardTarget: target });
      return { ok: true, alreadyUp: false, pid, forwardTarget: target, error: null };
    }

    // Bound but no round-trip for this target → wrong loopback family (#291).
    // Tear it down and try the next target.
    log.warn('Forward target bound but no end-to-end round-trip; trying next', {
      project: projectName, localPort, target
    });
    await killTunnelByPort(localPort, host);
    lastError = `tunnel bound but no end-to-end round-trip (last forward target tried: ${target})`;
  }
  return { ok: false, alreadyUp: false, pid: null, error: lastError };
}

/**
 * Spawn a single `ssh -f -N -L` tunnel attempt with a specific remote forward
 * target, wait for it to fork, and report whether the local port bound. The
 * caller decides liveness via `httpRoundTrip` (#288) and whether to retry
 * another forward target (#291).
 *
 * @param {object} config - Connection config (host, port, localPort, sshUser, extraForwards)
 * @param {string} keyPath - Expanded SSH private-key path
 * @param {string} target - Remote forward target: '127.0.0.1' or '[::1]'
 * @returns {Promise<{ bound: boolean, stderr: string }>}
 */
async function _spawnTunnelOnce(config, keyPath, target) {
  const { host, port, localPort, sshUser, extraForwards } = config;
  const sshArgs = ['-f', '-N', '-L', `${localPort}:${target}:${port}`];
  // Add extra port forwards (e.g., ClawBridge direct port) on the same target.
  if (extraForwards && extraForwards.length > 0) {
    for (const fwd of extraForwards) {
      sshArgs.push('-L', `${fwd.localPort}:${target}:${fwd.remotePort}`);
    }
  }
  sshArgs.push(
    '-i', keyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    `${sshUser}@${host}`
  );
  // Capture SSH stderr so failures surface a useful message (#160). `ssh -f`
  // forks AFTER the local bind, so bind/auth/connection-refused failures print
  // before exit and we can attribute them.
  let stderrBuf = '';
  const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      // Cap the buffer at 4KB so a chatty SSH config doesn't balloon memory.
      if (stderrBuf.length < 4096) {
        stderrBuf += chunk.toString('utf8', 0, 4096 - stderrBuf.length);
      }
    });
  }
  // ssh -f forks itself — wait for the foreground child to exit (or error on a
  // missing binary), then give SSH a moment to bind the forward.
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', (err) => {
      if (!stderrBuf) stderrBuf = err.message || String(err);
      resolve();
    });
  });
  await _wait(1500);
  // #295: family-aware bind check. ensureTunnel hard-fails (`ok:false`) on
  // `!bound` BEFORE attempting the round-trip, so a fresh spawn that bound the
  // local port IPv6-only would otherwise be misreported as a bind failure.
  const bound = await _loopbackConnectable(localPort);
  return { bound, stderr: stderrBuf };
}

/**
 * Kill a tracked SSH tunnel for a project.
 * @param {string} projectName - Project identifier
 * @returns {{ ok: boolean, error: string|null }}
 */
function killTunnel(projectName) {
  const entry = _tunnels.get(projectName);
  if (!entry) {
    log.debug('No tracked tunnel to kill', { project: projectName });
    return { ok: true, error: null };
  }

  // Try killing by tracked PID first
  if (entry.pid) {
    try {
      process.kill(entry.pid, 'SIGTERM');
      log.info('Killed tunnel by PID', { project: projectName, pid: entry.pid });
    } catch (err) {
      if (err.code !== 'ESRCH') {
        log.warn('Failed to kill tunnel PID', { project: projectName, pid: entry.pid, error: err.message });
      }
    }
  }

  // Also try finding by port (in case PID changed or wasn't tracked)
  const pid = _findSshPid(entry.localPort, entry.host);
  if (pid && pid !== entry.pid) {
    try {
      process.kill(pid, 'SIGTERM');
      log.info('Killed tunnel by port lookup', { project: projectName, pid });
    } catch (err) {
      if (err.code !== 'ESRCH') {
        log.warn('Failed to kill tunnel by port lookup', { project: projectName, pid, error: err.message });
      }
    }
  }

  _tunnels.delete(projectName);
  // Release tunnel port from PortHub
  porthub.releasePort(entry.localPort);
  return { ok: true, error: null };
}

/**
 * Check health of an OpenClaw instance via HTTP GET to /healthz.
 * @param {object} config - Connection config
 * @param {number} config.localPort - Local port where OpenClaw is accessible (loopback, IPv4 or IPv6 — #295)
 * @param {number} [timeoutMs=5000] - Per loopback-family timeout in milliseconds
 * @returns {Promise<{ healthy: boolean, error: string|null }>}
 */
async function checkHealth(config, timeoutMs = 5000) {
  const { localPort } = config;

  try {
    // Probe both loopback families (#295) so an IPv6-only local bind isn't
    // misreported as Gateway: FAIL when the tunnel is actually healthy.
    const res = await _fetchLoopback(localPort, '/healthz', { headers: { 'Accept': 'application/json' } }, timeoutMs);

    if (!res.ok) {
      return { healthy: false, error: `HTTP ${res.status}` };
    }

    const body = await res.json();
    return { healthy: body.ok === true, error: body.ok ? null : 'healthz returned ok=false' };
  } catch (err) {
    return { healthy: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

/**
 * Get info about a tracked tunnel.
 * @param {string} projectName - Project identifier
 * @returns {{ pid: number|null, localPort: number, host: string, remotePort: number }|null}
 */
function getTunnel(projectName) {
  return _tunnels.get(projectName) || null;
}

/**
 * List all tracked tunnels.
 * @returns {Array<{ projectName: string, pid: number|null, localPort: number, host: string, remotePort: number }>}
 */
function listTunnels() {
  return Array.from(_tunnels.entries()).map(([projectName, info]) => ({
    projectName,
    ...info
  }));
}

/**
 * Detect if an SSH tunnel is running on a given port, regardless of in-memory tracking.
 * Uses ps to find SSH processes with local port forwarding on the specified port.
 * @param {number} localPort - Local port to check
 * @param {string} [host] - Remote host to narrow the search (optional)
 * @returns {Promise<{ active: boolean, pid: number|null, port: number, connectable: boolean, roundTrip: boolean }>}
 */
async function detectTunnel(localPort, host) {
  const connectable = await _loopbackConnectable(localPort);
  // #288: end-to-end, not bind-based. A bound socket alone (connectable) is
  // exactly what a zombie tunnel presents, so require a real HTTP round-trip
  // before reporting the tunnel active — otherwise callers trust a dead-but-
  // bound port and never rebuild.
  const roundTrip = connectable ? await httpRoundTrip(localPort) : false;
  const pid = host ? _findSshPid(localPort, host) : _findSshPidByPort(localPort);
  return {
    active: roundTrip,
    pid,
    port: localPort,
    connectable,
    roundTrip
  };
}

/**
 * Kill an SSH tunnel by port, without needing it to be tracked in the in-memory
 * map. Resolves the PID actually holding the listening socket (via `lsof`,
 * scoped to our `ssh -L` signature), kills it, verifies the port is released
 * (escalating SIGTERM→SIGKILL), and releases from PortHub. Async because the
 * release verification waits on the OS to free the socket.
 *
 * #288 defect 2: the old ps+grep resolver missed zombies whose command line
 * didn't match the expected pattern, returning `{ok:true, pid:null}` while the
 * process kept holding the port — so the documented "delete + recreate"
 * recovery was a no-op against exactly the state needing recovery.
 *
 * @param {number} localPort - Local port the tunnel is forwarding
 * @param {string} [host] - Remote host (optional, narrows the ps-grep fallback)
 * @returns {Promise<{ ok: boolean, pid: number|null, released: boolean, error: string|null }>}
 */
async function killTunnelByPort(localPort, host) {
  // Also check if any tracked tunnel uses this port (clean up the map)
  for (const [projectName, entry] of _tunnels.entries()) {
    if (entry.localPort === localPort) {
      _tunnels.delete(projectName);
      break;
    }
  }

  // Prefer the real listening-socket holder (lsof, ssh-scoped); fall back to
  // the ps-grep resolvers for environments without lsof.
  const pid = _findSshPidByPortLsof(localPort)
    || (host ? _findSshPid(localPort, host) : _findSshPidByPort(localPort));
  if (!pid) {
    // Nothing holding the port — still release from PortHub in case of a stale lease.
    porthub.releasePort(localPort);
    const released = !(await _loopbackConnectable(localPort));
    return { ok: true, pid: null, released, error: null };
  }

  try {
    process.kill(pid, 'SIGTERM');
    log.info('Killed tunnel by port (SIGTERM)', { localPort, pid, host: host || 'any' });
  } catch (err) {
    if (err.code !== 'ESRCH') {
      log.warn('Failed to kill tunnel by port', { localPort, pid, error: err.message });
      return { ok: false, pid, released: false, error: err.message };
    }
  }

  // Verify the port is actually released; escalate to SIGKILL if SIGTERM didn't
  // free it. The recovery must not report success while the zombie still holds
  // the port (the #288 defect-2 failure mode).
  await _wait(500);
  if (await _loopbackConnectable(localPort)) {
    const stubborn = _findSshPidByPortLsof(localPort);
    if (stubborn) {
      try {
        process.kill(stubborn, 'SIGKILL');
        log.warn('Tunnel survived SIGTERM; sent SIGKILL', { localPort, pid: stubborn });
      } catch { /* already gone */ }
      await _wait(500);
    }
  }
  const released = !(await _loopbackConnectable(localPort));
  porthub.releasePort(localPort);
  if (!released) {
    log.warn('Tunnel port still bound after kill attempts', { localPort, pid });
    return { ok: false, pid, released: false, error: `port ${localPort} still bound after SIGTERM+SIGKILL` };
  }
  return { ok: true, pid, released: true, error: null };
}

/**
 * Resolve the PID that actually holds the LISTEN socket on `localPort` via
 * `lsof`, but only return it when it's one of our `ssh -L <localPort>:` tunnels
 * — never kill an unrelated process that happens to hold the port (#288).
 * @param {number} localPort - Local forwarded port
 * @returns {number|null}
 */
function _findSshPidByPortLsof(localPort) {
  let out;
  try {
    out = execSync(`lsof -t -iTCP:${localPort} -sTCP:LISTEN`, { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    // lsof exits non-zero when nothing matches, or isn't installed — caller falls back.
    return null;
  }
  if (!out) return null;
  for (const line of out.split('\n')) {
    const pid = parseInt(line.trim(), 10);
    if (isNaN(pid)) continue;
    try {
      const cmd = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8', timeout: 3000 });
      if (/\bssh\b/.test(cmd) && new RegExp(`-L\\s*${localPort}:`).test(cmd)) {
        return pid;
      }
    } catch {
      // process vanished between lsof and ps — skip
    }
  }
  return null;
}

// ── Helpers ──

/**
 * Find the PID of an SSH process doing local port forwarding.
 * @param {number} localPort - Local forwarded port
 * @param {string} host - Remote host
 * @returns {number|null}
 */
function _findSshPid(localPort, host) {
  try {
    // Look for ssh processes with the forwarding spec in their command line
    const output = execSync(
      `ps ax -o pid,command | grep "ssh.*-L.*${localPort}:.*${host}" | grep -v grep`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();

    if (output) {
      const firstLine = output.split('\n')[0].trim();
      const pid = parseInt(firstLine.split(/\s+/)[0], 10);
      return isNaN(pid) ? null : pid;
    }
  } catch {
    // grep returns exit code 1 when no match — ignore
  }
  return null;
}

/**
 * Find the PID of an SSH process doing local port forwarding on a specific port (any host).
 * @param {number} localPort - Local forwarded port
 * @returns {number|null}
 */
function _findSshPidByPort(localPort) {
  try {
    const output = execSync(
      `ps ax -o pid,command | grep "ssh.*-L.*${localPort}:" | grep -v grep`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();

    if (output) {
      const firstLine = output.split('\n')[0].trim();
      const pid = parseInt(firstLine.split(/\s+/)[0], 10);
      return isNaN(pid) ? null : pid;
    }
  } catch {
    // grep returns exit code 1 when no match — ignore
  }
  return null;
}

/**
 * Promise-based wait.
 * @param {number} ms - Milliseconds
 * @returns {Promise<void>}
 */
function _wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert raw SSH stderr into a user-facing failure message (#160). Recognizes
 * the load-bearing failure modes — local-bind conflict, auth, network/DNS —
 * and renders them with actionable hints. Falls back to the first non-empty
 * stderr line when no pattern matches; falls back to a generic message when
 * stderr is empty (e.g. SSH crashed before producing output).
 *
 * @param {string} stderr - Captured SSH stderr (may be empty)
 * @param {Array<{localPort: number, remotePort: number}>} [extraForwards] - Forwards present beyond the primary tunnel
 * @returns {string} User-facing error message
 */
function _formatTunnelError(stderr, extraForwards) {
  const trimmed = (stderr || '').trim();
  if (!trimmed) {
    return 'SSH tunnel spawned but port not connectable';
  }

  // Local-bind conflict: SSH prints variations like
  //   `bind [127.0.0.1]:3201: Address already in use`
  //   `bind 0.0.0.0:3201: Address already in use`
  //   `bind [::1]:3201: Address already in use`        ← IPv6 (Critic MINOR-1)
  // The address segment is either `[ipv6-or-v4]` (bracketed, ANY interior including colons)
  // or a non-colon bare token (v4 without brackets). Followed by `:<port>: Address already in use`.
  const bindMatch = trimmed.match(/bind\s+(?:\[[^\]]+\]|[^:\s]+):(\d+):\s*Address already in use/i);
  if (bindMatch) {
    const conflictPort = parseInt(bindMatch[1], 10);
    const isExtraForward = Array.isArray(extraForwards)
      && extraForwards.some((f) => f && f.localPort === conflictPort);
    const hint = isExtraForward
      ? `Clear the secondary forward in this connection's settings or free port ${conflictPort}.`
      : `Free port ${conflictPort} or change the connection's local port, then retry.`;
    return `Local port ${conflictPort} is already in use; SSH refused the forward and exited. ${hint}`;
  }

  // Auth failure: ssh prints "Permission denied (publickey)" etc. before exit.
  if (/Permission denied|publickey/i.test(trimmed)) {
    return `SSH authentication failed: ${_firstLine(trimmed)}`;
  }

  // Network-level: connection refused / unreachable / DNS.
  if (/Connection refused|No route to host|Network is unreachable|Could not resolve hostname/i.test(trimmed)) {
    return `SSH connection failed: ${_firstLine(trimmed)}`;
  }

  // Default: surface the first non-empty line so the user has something to grep.
  return `SSH tunnel failed: ${_firstLine(trimmed)}`;
}

/**
 * Return the first meaningful line of `s` — skips lines that are pure SSH
 * informational noise (e.g. `Warning: Permanently added '<host>' (ECDSA) to
 * the list of known hosts.` printed on first-connect to a new host) before
 * picking the first non-empty line. Without this filter, `_formatTunnelError`
 * would render auth and network failures with the host-key Warning prefix
 * instead of the real error line (Critic MAJOR-1).
 * @param {string} s
 * @returns {string}
 */
function _firstLine(s) {
  const lines = String(s).split('\n').map((l) => l.trim()).filter(Boolean);
  const meaningful = lines.filter((l) => !/^Warning: Permanently added/i.test(l));
  return meaningful[0] || lines[0] || s;
}

module.exports = {
  tcpProbe,
  httpRoundTrip,
  ensureTunnel,
  killTunnel,
  killTunnelByPort,
  detectTunnel,
  checkHealth,
  getTunnel,
  listTunnels,
  _tunnels,
  _spawnTunnelOnce,
  _findSshPid,
  _findSshPidByPort,
  _findSshPidByPortLsof,
  _formatTunnelError,
  _wait,
  FORWARD_TARGETS
};
