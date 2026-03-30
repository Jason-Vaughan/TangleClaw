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
 * Ensure an SSH tunnel is running for a project's OpenClaw connection.
 * If the local port is already connectable (manual tunnel or prior spawn), skips spawning.
 * Otherwise spawns `ssh -f -N -L ...` in the background and tracks the PID.
 *
 * @param {string} projectName - Project identifier (key for tracking)
 * @param {object} config - Connection config
 * @param {string} config.host - Remote host
 * @param {number} config.port - Remote OpenClaw port
 * @param {number} config.localPort - Local port to forward to
 * @param {string} config.sshUser - SSH username
 * @param {string} config.sshKeyPath - Path to SSH private key (~ expanded)
 * @param {Array<{localPort: number, remotePort: number}>} [config.extraForwards] - Additional port forwards
 * @returns {Promise<{ ok: boolean, alreadyUp: boolean, pid: number|null, error: string|null }>}
 */
async function ensureTunnel(projectName, config) {
  const { host, port, localPort, sshUser, sshKeyPath, extraForwards } = config;
  const keyPath = sshKeyPath.replace(/^~/, process.env.HOME);

  // Check if port is already connectable (existing manual tunnel or previous spawn)
  const alreadyUp = await tcpProbe(localPort);
  if (alreadyUp) {
    // If force mode, kill the existing tunnel first and proceed to spawn a fresh one
    if (config.force) {
      log.info('Force mode: killing existing tunnel on port', { project: projectName, localPort });
      killTunnelByPort(localPort, host);
      // Give OS a moment to release the port
      await _wait(500);
    } else {
      const existingPid = _findSshPid(localPort, host);
      log.info('Tunnel already up (port connectable)', { project: projectName, localPort, pid: existingPid });
      // Ensure PortHub knows about this port — skip if another project already holds the lease (avoid conflicts)
      const existingLease = porthub.getLeases().find(l => l.port === localPort && l.host === 'localhost');
      if (!existingLease || existingLease.project === projectName) {
        porthub.registerPort(localPort, projectName, 'openclaw-tunnel', { permanent: false, ttlMs: 86400000 });
      }
      // Track it in memory if not already tracked (handles server restarts)
      if (!_tunnels.has(projectName) && existingPid) {
        _tunnels.set(projectName, { pid: existingPid, localPort, host, remotePort: port });
      }
      return { ok: true, alreadyUp: true, pid: existingPid, error: null };
    }
  }

  // Spawn SSH tunnel in background
  // ssh -f -N -L <localPort>:127.0.0.1:<remotePort> -i <key> <user>@<host>
  try {
    const sshArgs = [
      '-f', '-N',
      '-L', `${localPort}:127.0.0.1:${port}`,
    ];
    // Add extra port forwards (e.g., ClawBridge direct port)
    if (extraForwards && extraForwards.length > 0) {
      for (const fwd of extraForwards) {
        sshArgs.push('-L', `${fwd.localPort}:127.0.0.1:${fwd.remotePort}`);
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
    const child = spawn('ssh', sshArgs, {
      stdio: 'ignore',
      detached: true
    });

    // ssh -f forks itself — the child exits quickly, but we need the actual SSH PID.
    // Wait for the child to exit, then find the SSH process by port.
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.once('error', resolve);
    });

    // Give SSH a moment to establish the tunnel
    await _wait(1500);

    // Verify the tunnel came up
    const isUp = await tcpProbe(localPort);
    if (!isUp) {
      return { ok: false, alreadyUp: false, pid: null, error: 'SSH tunnel spawned but port not connectable' };
    }

    // Find the SSH process PID by looking for the forwarding spec
    const pid = _findSshPid(localPort, host);

    _tunnels.set(projectName, { pid, localPort, host, remotePort: port });
    // Register tunnel port with PortHub — skip if another project already holds the lease (avoid conflicts)
    const newLease = porthub.getLeases().find(l => l.port === localPort && l.host === 'localhost');
    if (!newLease || newLease.project === projectName) {
      porthub.registerPort(localPort, projectName, 'openclaw-tunnel', { permanent: false, ttlMs: 86400000 });
    }
    log.info('Tunnel established', { project: projectName, localPort, pid });

    return { ok: true, alreadyUp: false, pid, error: null };
  } catch (err) {
    log.error('Failed to spawn SSH tunnel', { project: projectName, error: err.message });
    return { ok: false, alreadyUp: false, pid: null, error: err.message };
  }
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
 * @param {number} config.localPort - Local port where OpenClaw is accessible
 * @param {number} [timeoutMs=5000] - Timeout in milliseconds
 * @returns {Promise<{ healthy: boolean, error: string|null }>}
 */
async function checkHealth(config, timeoutMs = 5000) {
  const { localPort } = config;
  const url = `http://127.0.0.1:${localPort}/healthz`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });

    clearTimeout(timer);

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
 * @returns {Promise<{ active: boolean, pid: number|null, port: number, connectable: boolean }>}
 */
async function detectTunnel(localPort, host) {
  const connectable = await tcpProbe(localPort);
  const pid = host ? _findSshPid(localPort, host) : _findSshPidByPort(localPort);
  return {
    active: connectable || pid !== null,
    pid,
    port: localPort,
    connectable
  };
}

/**
 * Kill an SSH tunnel by port, without needing it to be tracked in the in-memory map.
 * Finds the SSH process by port forwarding spec, kills it, and releases from PortHub.
 * @param {number} localPort - Local port the tunnel is forwarding
 * @param {string} [host] - Remote host (optional, narrows the search)
 * @returns {{ ok: boolean, pid: number|null, error: string|null }}
 */
function killTunnelByPort(localPort, host) {
  // Also check if any tracked tunnel uses this port (clean up the map)
  for (const [projectName, entry] of _tunnels.entries()) {
    if (entry.localPort === localPort) {
      _tunnels.delete(projectName);
      break;
    }
  }

  const pid = host ? _findSshPid(localPort, host) : _findSshPidByPort(localPort);
  if (!pid) {
    // No SSH process found — still release from PortHub in case of stale lease
    porthub.releasePort(localPort);
    return { ok: true, pid: null, error: null };
  }

  try {
    process.kill(pid, 'SIGTERM');
    log.info('Killed tunnel by port', { localPort, pid, host: host || 'any' });
  } catch (err) {
    if (err.code !== 'ESRCH') {
      log.warn('Failed to kill tunnel by port', { localPort, pid, error: err.message });
      return { ok: false, pid, error: err.message };
    }
  }

  porthub.releasePort(localPort);
  return { ok: true, pid, error: null };
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

module.exports = {
  tcpProbe,
  ensureTunnel,
  killTunnel,
  killTunnelByPort,
  detectTunnel,
  checkHealth,
  getTunnel,
  listTunnels,
  _tunnels,
  _findSshPid,
  _findSshPidByPort,
  _wait
};
