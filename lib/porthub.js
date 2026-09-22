'use strict';

const path = require('node:path');
const { execSync } = require('node:child_process');
const store = require('./store');
const { createLogger } = require('./logger');
const portScanner = require('./port-scanner');

const log = createLogger('porthub');

let _expirationTimer = null;

// Service names TangleClaw gives its own Caddy leases. Bootstrap writes them in
// caddy mode and releases them outside it, so the two must name the same rows.
const CADDY_INGRESS_SERVICES = ['caddy-https-ingress', 'caddy-http-ingress'];

/**
 * Decide whether this machine shows a listener on a port no live lease
 * accounts for, and whether that should stop the lease.
 *
 * Only an UNLEASED listener is this check's business. A port under another
 * project's live lease is the store's conflict (or, with `force`, a recorded
 * takeover — the listener belongs to the displaced lease, which is exactly
 * what `force` says the caller knows about). A renewal never probes:
 * re-registering a service that is already running is the documented happy
 * path, and the listener IS that service. Only `localhost` can be asked — a
 * lease for another host names a machine this process cannot see.
 *
 * @param {number} port
 * @param {string} host
 * @param {string} projectName
 * @param {boolean} adoptListener - The caller says the listener is its own
 * @param {boolean} force - The caller is taking over another project's lease
 * @returns {{ listenerCheck: 'clear'|'adopted'|'renewal'|'takeover'|'not-local'|'unavailable'|'refused'|null, refuse: boolean, listener: object|null }}
 *   `null` when another project's live lease makes the store's answer the
 *   whole answer (`takeover` when the caller forces it).
 */
function _checkListener(port, host, projectName, adoptListener, force) {
  const existing = store.portLeases.get(port, host);
  const live = existing && store.portLeases.isLive(existing);
  if (live && existing.project === projectName) {
    return { listenerCheck: 'renewal', refuse: false, listener: null };
  }
  if (live) return { listenerCheck: force ? 'takeover' : null, refuse: false, listener: null };
  if (host !== 'localhost') return { listenerCheck: 'not-local', refuse: false, listener: null };
  const probe = portScanner.probePort(port);
  if (probe.source === 'unavailable') {
    log.warn('Could not check this port for a listener; granting the lease unchecked', { host, port, project: projectName });
    return { listenerCheck: 'unavailable', refuse: false, listener: null };
  }
  if (!probe.inUse) return { listenerCheck: 'clear', refuse: false, listener: null };
  const listener = { port, pid: probe.pid, command: probe.process };
  if (adoptListener) return { listenerCheck: 'adopted', refuse: false, listener };
  return { listenerCheck: 'refused', refuse: true, listener };
}

/**
 * Register (lease) a port for a project.
 *
 * On `localhost` the machine is asked first (#814): a port with a listener and
 * no live lease held by this project is refused with `code: 'PORT_IN_USE'`,
 * because the registry saying "free" about a port the machine is using is how a
 * session once took Caddy's port and cut remote access to every tab. A caller
 * that bound its own service before registering it says so with
 * `adoptListener`. That is a separate flag from `force` on purpose — `force`
 * takes over another project's lease, and a caller reaching for it to claim its
 * own listener would silently take leased ports too.
 *
 * @param {number} port - Port number
 * @param {string} projectName - Project name
 * @param {string} service - Service description
 * @param {object} [options]
 * @param {string} [options.host] - Host identifier (default 'localhost')
 * @param {boolean} [options.permanent] - Whether the lease is permanent (default true)
 * @param {number} [options.ttlMs] - TTL in milliseconds (for non-permanent leases)
 * @param {string} [options.description] - Description
 * @param {boolean} [options.autoRenew] - Stored on the lease as-is
 * @param {boolean} [options.force] - Take over a live lease held by a different
 *   project. Without it such a claim fails with `code: 'PORT_CONFLICT'`;
 *   renewing a lease this project already holds never needs it.
 * @param {boolean} [options.adoptListener] - The listener already on this port
 *   is the caller's own service. Every in-process caller passes it, since each
 *   registers a port TangleClaw itself binds.
 * @param {'loopback'|'tailnet'|'lan'} [options.reach='loopback'] - How far this
 *   service is MEANT to be reachable. A service binding `127.0.0.1` is already
 *   stating loopback; this records it where another process can read it — the
 *   Caddyfile divergence check reads it to tell a deliberate exposure from an
 *   accidental one. Omitting it means loopback on every write, renewals
 *   included (`store.portLeases.lease`).
 * @param {'project'|'external'} [options.ownerKind] - Whether the owner is a
 *   TangleClaw project; kept on a renewal when omitted (`store.portLeases.lease`).
 * @returns {{ success: boolean, error: string|null, code: string|null, owner: object|null,
 *   lease: object|null, listener: object|null, listenerCheck: string|null }}
 *   On a conflict, `code` is `'PORT_CONFLICT'` and `owner` is the current lease;
 *   on an unleased listener it is `'PORT_IN_USE'` and `listener` names the
 *   process — either is enough to pick another port without a second call.
 *   `listenerCheck` says what the machine check found (`clear`, `adopted`,
 *   `renewal`, `takeover`, `not-local`, `unavailable`, `refused`), or null when
 *   another project's live lease answered first (see `_checkListener`).
 */
function registerPort(port, projectName, service, options = {}) {
  const host = options.host || 'localhost';
  let check = { listenerCheck: null, refuse: false, listener: null };
  try {
    // Another project's live lease is the older, more specific answer, so it
    // stays the store's: a leased port is PORT_CONFLICT naming its owner, never
    // PORT_IN_USE naming only a pid.
    check = _checkListener(port, host, projectName, options.adoptListener === true, options.force === true);
    if (check.refuse) {
      log.warn('Refused port lease — a process is listening on it and no lease says it is this project\'s', {
        host, port, project: projectName, service, listener: check.listener
      });
      return {
        success: false,
        error: `Port ${port} on ${host} has a listener (${check.listener.command || 'unknown'}, pid ${check.listener.pid}) `
          + 'that no lease records. Pick another port, or, if that listener is your own service, '
          + 'repeat with adoptListener: true.',
        code: 'PORT_IN_USE',
        owner: null,
        lease: null,
        listener: check.listener,
        listenerCheck: 'refused'
      };
    }

    const permanent = options.permanent !== false;
    const lease = store.portLeases.lease({
      host,
      port,
      project: projectName,
      service,
      permanent,
      ttlMs: options.ttlMs || null,
      description: options.description || null,
      autoRenew: options.autoRenew === true,
      force: options.force === true,
      reach: options.reach,
      ownerKind: options.ownerKind
    });
    log.info('Port registered', {
      host, port, project: projectName, service, reach: options.reach || 'loopback', listenerCheck: check.listenerCheck
    });
    // Same key set on both paths so callers can read `.code`/`.owner` without
    // first checking `.success` — an absent key and a null one read the same in
    // a truthiness test but not in a strict one.
    return {
      success: true, error: null, code: null, owner: null,
      lease, listener: check.listener, listenerCheck: check.listenerCheck
    };
  } catch (err) {
    log.warn('Port registration failed', { host, port, project: projectName, error: err.message });
    // Surface the conflict distinctly: callers that can pick another port need
    // to tell "someone else owns this" apart from a malformed request, and the
    // owner is what makes the failure actionable rather than just a message.
    return {
      success: false,
      error: err.message,
      code: err.code || null,
      owner: err.owner || null,
      lease: null,
      listener: null,
      listenerCheck: check.listenerCheck
    };
  }
}

/**
 * Release a port.
 * @param {number} port - Port number
 * @param {string} [host='localhost'] - Host identifier
 * @param {string|null} [project=null] - Releasing project; when given, a live
 *   lease held by a different project is refused (`store.portLeases.release`)
 * @returns {{ success: boolean, error: string|null }}
 */
function releasePort(port, host = 'localhost', project = null) {
  try {
    store.portLeases.release(port, host, { project });
    log.info('Port released', { host, port });
    return { success: true, error: null };
  } catch (err) {
    log.warn('Port release failed', { host, port, error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Register multiple ports for a project.
 * @param {object} ports - Map of service name to port number { "dev": 8080, "api": 8081 }
 * @param {string} projectName - Project name
 * @returns {{ registered: object, errors: string[] }}
 */
function registerPorts(ports, projectName) {
  const registered = {};
  const errors = [];

  for (const [service, port] of Object.entries(ports)) {
    const result = registerPort(port, projectName, service);
    if (result.success) {
      registered[service] = port;
    } else {
      errors.push(`Port ${port} (${service}): ${result.error}`);
    }
  }

  return { registered, errors };
}

/**
 * Release multiple ports.
 * @param {object} ports - Map of service name to port number
 * @returns {{ released: number[], errors: string[] }}
 */
function releasePorts(ports) {
  const released = [];
  const errors = [];

  for (const [service, port] of Object.entries(ports)) {
    const result = releasePort(port);
    if (result.success) {
      released.push(port);
    } else {
      errors.push(`Port ${port} (${service}): ${result.error}`);
    }
  }

  return { released, errors };
}

/**
 * Check if a port is available: not held by a live lease, and (on localhost)
 * not listening now.
 * @param {number} port - Port number
 * @param {string} [host='localhost'] - Host identifier
 * @returns {{ available: boolean, leasedBy: string|null }}
 */
function checkPort(port, host = 'localhost') {
  try {
    const conflict = store.portLeases.checkConflict(port, host);
    if (conflict) {
      return { available: false, leasedBy: conflict.project, systemDetected: false };
    }

    // Ask the machine about this port now (localhost only). The periodic
    // scan's cache is empty before its first run and forever when scanning is
    // off, and callers pick a port from this answer and lease it before
    // anything binds it — so a cold cache here was the same "free" for a used
    // port that #814 closed on the lease path.
    if (host === 'localhost') {
      const probe = portScanner.probePort(port);
      if (probe.inUse) {
        return { available: false, leasedBy: null, systemDetected: true, process: probe.process };
      }
    }

    return { available: true, leasedBy: null, systemDetected: false };
  } catch {
    return { available: true, leasedBy: null, systemDetected: false };
  }
}

/**
 * Find the first free port in a range — one not held by a live lease and
 * (on localhost) not OS-bound by a system process. Used to auto-allocate a
 * non-colliding port at add-time instead of defaulting every consumer to the
 * same port (e.g. OpenClaw tunnel `local_port`, which historically defaulted
 * to 18789 for every connection and collided on the second add — #352).
 * @param {object} opts
 * @param {[number, number]} opts.range - `[start, end)` half-open scan range (start inclusive, end exclusive)
 * @param {string} [opts.host='localhost'] - Host identifier
 * @returns {number} First free port in the range
 * @throws {Error} If the range is malformed or holds no free port
 */
function nextFreePort({ range, host = 'localhost' } = {}) {
  if (!Array.isArray(range) || range.length !== 2
      || !Number.isInteger(range[0]) || !Number.isInteger(range[1])) {
    throw new Error('nextFreePort requires a [start, end) integer range');
  }
  const [start, end] = range;
  for (let p = start; p < end; p++) {
    if (checkPort(p, host).available) return p;
  }
  throw new Error(`No free port available in range [${start}, ${end}) on ${host}`);
}

/**
 * Get all port leases.
 * @param {object} [options] - Filter options
 * @returns {object[]}
 */
function getLeases(options) {
  return store.portLeases.list(options);
}

/**
 * Get all port leases for a project.
 * @param {string} project - Project name
 * @returns {object[]}
 */
function getLeasesForProject(project) {
  return store.portLeases.getByProject(project);
}

/**
 * Bootstrap port management: register TangleClaw infrastructure ports
 * and attempt one-time migration from old PortHub daemon.
 * @param {object} config
 * @param {number} config.ttydPort
 * @param {number} config.serverPort
 */
function bootstrap(config) {
  log.info('PortHub bootstrap starting');

  // Register TangleClaw infra ports (use directory name to match registered project)
  //
  // `force` is required here, and it is not a convenience. These ports are the
  // server's own — it is binding them regardless of what the registry says, so
  // a refusal would make the registry lie rather than prevent anything. It also
  // keeps startup working when the derived name drifts: `selfName` is the
  // CHECKOUT DIRECTORY name, so a clone or worktree named anything other than
  // the original re-registers the same ports under a different owner and would
  // otherwise 409 against its own previous lease on every boot. The takeover is
  // logged like any other.
  //
  // `adoptListener` for the same reason: ttyd is already listening when this
  // runs, and the listener is TangleClaw's own.
  const selfName = path.basename(path.resolve(__dirname, '..'));
  const own = { permanent: true, force: true, adoptListener: true };
  registerPort(config.ttydPort, selfName, 'ttyd', own);
  registerPort(config.serverPort, selfName, 'server', own);

  // Caddy's listeners are TangleClaw's front door in caddy mode, and a registry
  // that does not know them tells the next session they are free — which is
  // how a session once took 8443 and cut remote access to every tab (#814).
  // Enrolled only in caddy mode: in direct mode nothing TangleClaw runs binds
  // them, and claiming them would block a project that legitimately does.
  // `tailnet` because Caddy's global `https_port` binds every interface and
  // remote operator access is what it exists for.
  const fullConfigForIngress = store.config.load();
  if (fullConfigForIngress.ingressMode === 'caddy') {
    const caddyLease = { ...own, reach: 'tailnet' };
    const httpsPort = fullConfigForIngress.caddyHttpsPort || store.DEFAULT_CONFIG.caddyHttpsPort;
    const httpPort = fullConfigForIngress.caddyHttpPort || store.DEFAULT_CONFIG.caddyHttpPort;
    registerPort(httpsPort, selfName, CADDY_INGRESS_SERVICES[0], caddyLease);
    registerPort(httpPort, selfName, CADDY_INGRESS_SERVICES[1], caddyLease);
  } else {
    // An install that left caddy mode no longer runs Caddy, so its own Caddy
    // leases would refuse those ports to a project for a service that is gone.
    // Only TangleClaw's own rows under these service names are touched, and
    // releasing under its own project name keeps the ownership check on.
    for (const lease of store.portLeases.getByProject(selfName)) {
      if (CADDY_INGRESS_SERVICES.includes(lease.service)) {
        releasePort(lease.port, lease.host, selfName);
      }
    }
  }

  // Sync from old PortHub daemon on every boot.
  // _migrateFromOldPorthub skips ports already in our database,
  // so this is safe to run repeatedly.
  _migrateFromOldPorthub();

  // Clean up orphan leases — permanent leases for projects that are neither
  // registered in SQLite nor present as directories in projectsDir.
  _cleanupOrphanLeases();

  // Start periodic port scanning (respects config)
  const fullConfig = store.config.load();
  if (fullConfig.portScannerEnabled !== false) {
    portScanner.startScanner(fullConfig.portScannerIntervalMs || 60000);
  } else {
    log.info('Port scanner disabled by config');
  }

  log.info('PortHub bootstrap complete', { leases: store.portLeases.list().length });
}

/**
 * Shutdown port management: release TangleClaw infrastructure ports.
 * @param {object} config
 * @param {number} config.ttydPort
 * @param {number} config.serverPort
 */
function shutdown(config) {
  log.info('PortHub shutdown');
  portScanner.stopScanner();
  releasePort(config.ttydPort);
  releasePort(config.serverPort);
  stopExpirationTimer();
}

/**
 * Start periodic expiration of stale leases (every 60s).
 */
function startExpirationTimer() {
  if (_expirationTimer) return;
  _expirationTimer = setInterval(() => {
    try {
      const expired = store.portLeases.expireStale();
      if (expired > 0) {
        log.info('Expired stale leases', { count: expired });
      }
    } catch (err) {
      log.warn('Expiration timer error', { error: err.message });
    }
  }, 60000);
  // Allow the timer to not keep the process alive
  if (_expirationTimer.unref) _expirationTimer.unref();
}

/**
 * Stop the expiration timer.
 */
function stopExpirationTimer() {
  if (_expirationTimer) {
    clearInterval(_expirationTimer);
    _expirationTimer = null;
  }
}

/**
 * Attempt to import leases from the old PortHub daemon.
 * Best-effort: if porthub CLI is not available, skip silently.
 */
function _migrateFromOldPorthub() {
  try {
    execSync('which porthub 2>/dev/null', { timeout: 2000, encoding: 'utf8' });
  } catch {
    log.debug('Old PortHub CLI not available, skipping migration');
    return;
  }

  try {
    const output = execSync('porthub status --json 2>/dev/null', {
      timeout: 5000,
      encoding: 'utf8'
    });

    // porthub CLI outputs ASCII art banner before the JSON.
    // Extract the JSON array by finding the first '[' character.
    const jsonStart = output.indexOf('[');
    if (jsonStart === -1) {
      log.debug('No JSON array found in porthub output');
      return;
    }

    const data = JSON.parse(output.slice(jsonStart));
    // porthub returns a raw array of lease objects, not wrapped in { leases: [...] }
    const leases = Array.isArray(data) ? data : (data.leases || data.ports || []);
    let imported = 0;

    for (const lease of leases) {
      if (!lease.port) continue;
      // Skip expired leases
      if (lease.status === 'expired') continue;
      // Skip if we already have this port registered
      if (store.portLeases.get(lease.port)) continue;

      store.portLeases.lease({
        port: lease.port,
        project: lease.project || 'unknown',
        service: lease.service || 'imported',
        permanent: lease.permanent !== false,
        description: 'Imported from PortHub daemon'
      });
      imported++;
    }

    if (imported > 0) {
      log.info('Migrated leases from old PortHub', { count: imported });
    }
  } catch (err) {
    log.debug('Could not migrate from old PortHub', { error: err.message });
  }
}

/**
 * Clean up permanent port leases that reference projects which are neither
 * registered in SQLite nor present as directories in projectsDir.
 * These are ghost entries — typically from old PortHub imports for archived
 * or deleted projects whose directories no longer exist.
 *
 * Runs unattended on every boot, which is why it releases under the
 * `orphan-sweep` reason: the classifier below can be wrong (a rename in
 * flight, a misread `projectsDir`, a connection registered after this ran),
 * and a displaced lease whose service is still listening has to be traceable
 * to the sweep that took it rather than reading as the owner's own release.
 * The summary line here answers a different question — how many projects the
 * classifier rejected — so it stays alongside the per-lease record.
 */
function _cleanupOrphanLeases() {
  const fs = require('node:fs');
  const config = store.config.load();
  const projectsDir = config.projectsDir
    ? (config.projectsDir.startsWith('~')
      ? path.join(process.env.HOME || '', config.projectsDir.slice(1))
      : path.resolve(config.projectsDir))
    : null;

  if (!projectsDir) return;

  const allLeases = store.portLeases.list();
  const registeredProjects = new Set(store.projects.list().map(p => p.name));

  // Also include TangleClaw's own self-name (infra ports)
  const selfName = path.basename(path.resolve(__dirname, '..'));
  registeredProjects.add(selfName);

  // Include OpenClaw connection tunnel identifiers (tunnels register under oc-direct-<id>)
  //
  // This read is one of the three inputs that decide "not an orphan", and it is
  // the only one that can fail. If it does, EVERY live tunnel lease looks like
  // an orphan and the sweep below takes them all in one boot — a truthful-looking
  // audit trail naming ports that were never orphaned. A classifier that lost an
  // input cannot tell the two apart, so it refuses to classify rather than
  // guessing in the deleting direction.
  try {
    const openclawConns = store.openclawConnections.list();
    for (const conn of openclawConns) {
      registeredProjects.add(`oc-direct-${conn.id}`);
    }
  } catch (err) { // prawduct:allow prawduct/broad-except -- an older schema with no table and a genuine read failure are one fact here: the tunnel identifiers could not be established. Named, then the sweep declines to run.
    log.warn('Skipping the orphan lease sweep — the OpenClaw connection list could not be read', {
      error: err.message,
      consequence: 'every oc-direct-* tunnel lease would look like an orphan; leases are left in place until the next boot'
    });
    return;
  }

  const orphanProjects = new Set();
  for (const lease of allLeases) {
    if (registeredProjects.has(lease.project)) continue;
    // A lease recorded as not belonging to a TangleClaw project was never going
    // to have a project directory, so a missing one says nothing about it
    // (#1381). Before this, a `brew services` database's lease was deleted on
    // every boot.
    if (lease.ownerKind === 'external') continue;
    // Check if directory exists
    const projPath = path.join(projectsDir, lease.project);
    if (fs.existsSync(projPath)) continue;
    orphanProjects.add(lease.project);
  }

  for (const project of orphanProjects) {
    const released = store.portLeases.releaseByProject(project, { reason: 'orphan-sweep', ownerKind: 'project' });
    log.info('Cleaned up orphan port leases', { project, count: released });
  }
}

/**
 * Manually trigger a sync from the old PortHub daemon.
 * Imports any leases not already in our database.
 * @returns {{ imported: number }}
 */
function syncFromDaemon() {
  const before = store.portLeases.list().length;
  _migrateFromOldPorthub();
  const after = store.portLeases.list().length;
  return { imported: after - before };
}

module.exports = {
  registerPort,
  releasePort,
  registerPorts,
  releasePorts,
  checkPort,
  nextFreePort,
  getLeases,
  getLeasesForProject,
  bootstrap,
  shutdown,
  startExpirationTimer,
  stopExpirationTimer,
  syncFromDaemon
};
