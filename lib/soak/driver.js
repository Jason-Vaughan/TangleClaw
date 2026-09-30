'use strict';

/**
 * Execute a soak schedule (#2020) against the server under test, and keep an
 * append-only ndjson log of every outcome.
 *
 * The log is the run's evidence and its resume point:
 * - Its header binds it to one schedule digest and one start time.
 * - Resuming after an interruption continues from the first event with no
 *   logged outcome. A logged event never runs again; the one in flight when
 *   a crash hit has no outcome, so it does.
 * - Every event keeps its original wall-clock slot. After downtime, stale load
 *   is skipped and recorded, faults are deferred to keep their quiet window,
 *   and other overdue events are spaced out. Lateness is always recorded.
 *
 * The driver judges nothing. Whether the soak passed is decided elsewhere,
 * from this log together with the release-certification evidence.
 *
 * @module lib/soak/driver
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');

const scheduleLib = require('./schedule');

const LOG_SCHEMA = 'tc.soak-log/v1';

/** Closed set of reasons the driver refuses to run. */
const REFUSAL = Object.freeze({
  INVALID_SCHEDULE: 'INVALID_SCHEDULE',
  NO_EXECUTOR: 'NO_EXECUTOR',
  LIVE_INSTALL_TARGET: 'LIVE_INSTALL_TARGET',
  LIVE_IDENTITY_UNREADABLE: 'LIVE_IDENTITY_UNREADABLE',
  TARGET_NOT_IP_LITERAL: 'TARGET_NOT_IP_LITERAL',
  GUARD_CONTEXT_ABSENT: 'GUARD_CONTEXT_ABSENT',
  LOG_LOCKED: 'LOG_LOCKED',
  LOCK_LOST: 'LOCK_LOST',
  LOCK_LOST_UNRECORDED: 'LOCK_LOST_UNRECORDED',
  LOCK_RELEASE_FAILED: 'LOCK_RELEASE_FAILED',
  OWNERSHIP_UNVERIFIED: 'OWNERSHIP_UNVERIFIED',
  SEGMENT_CLOSE_FAILED: 'SEGMENT_CLOSE_FAILED',
  LOG_LOCK_LOST: 'LOG_LOCK_LOST',
  LOG_LOCK_LOST_INVALID: 'LOG_LOCK_LOST_INVALID',
  LOG_SEGMENT_OPEN: 'LOG_SEGMENT_OPEN',
  LOG_SEGMENT_UNRECONCILED: 'LOG_SEGMENT_UNRECONCILED',
  LOG_SEGMENT_INVALID: 'LOG_SEGMENT_INVALID',
  LOG_MISMATCH: 'LOG_MISMATCH',
  LOG_UNREADABLE: 'LOG_UNREADABLE',
  // Fault and browser events act on the machine the driver runs on, so they
  // run only where no live install can be touched (`lib/soak/local.js`).
  LOCAL_CONTROL_REFUSED: 'LOCAL_CONTROL_REFUSED'
});

/** A refusal: the run did not start, and the reason is one of `REFUSAL`. */
class DriverRefusal extends Error {
  /**
   * @param {string} code - One of `REFUSAL`
   * @param {string} message - Human explanation
   * @param {object} [details] - Structured details
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'DriverRefusal';
    this.code = code;
    this.details = details || {};
  }
}

/**
 * The names this machine answers to: loopback in all its spellings, the
 * wildcard addresses, its hostname with and without a domain (a MagicDNS or LAN
 * name starts with it), and every local interface address.
 * @returns {{exact: Set<string>, hostnamePrefix: string}} Lower-cased names
 */
function localNames() {
  const exact = new Set(['localhost', '::1', '[::1]', '0.0.0.0', '::', '[::]']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      exact.add(a.address.toLowerCase());
      if (a.family === 'IPv6' || a.family === 6) exact.add(`[${a.address.toLowerCase()}]`);
    }
  }
  const hostname = os.hostname().toLowerCase();
  const short = hostname.split('.')[0];
  exact.add(hostname);
  exact.add(short);
  return { exact, hostnamePrefix: `${short}.` };
}

/**
 * A host in one canonical spelling, so that aliases compare equal: lower
 * case, IPv6 brackets removed, trailing dots removed (`localhost.` is
 * `localhost`), and an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`, which
 * WHATWG URL reports as `[::ffff:7f00:1]`) reduced to its IPv4 form. Numeric
 * IPv4 spellings such as `2130706433` or `0x7f.1` need nothing here, because
 * URL parsing already normalizes them to dotted form.
 * @param {string} host - `URL.hostname` or a resolved address
 * @returns {string} Canonical host
 */
function canonicalHost(host) {
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/\.+$/, '');
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return h;
}

/**
 * Whether a host names this machine: loopback in any spelling (all of
 * 127.0.0.0/8, `::1`, `localhost` and every `*.localhost` name, which
 * resolvers must send to loopback), the wildcard addresses, the hostname and
 * names under it, and every local interface address.
 * @param {string} host - A host or address, in any spelling
 * @param {{exact: Set<string>, hostnamePrefix: string}} names - From `localNames`
 * @returns {boolean} True for this machine
 */
function _isLocal(host, names) {
  const h = canonicalHost(host);
  return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1' || h === '0.0.0.0' || h === '::'
    || names.exact.has(h) || h.startsWith(names.hostnamePrefix);
}

/**
 * The port a URL connects to, filling in the scheme's default.
 * @param {URL} u - URL
 * @returns {string} Port
 */
function _port(u) {
  return u.port || (u.protocol === 'https:' ? '443' : '80');
}

/**
 * Refuse a target that is, by its address, the live install this process was
 * launched from. A soak's load includes writes (port leases, sessions), and
 * pointing one at the operator's real TangleClaw is the mistake this guard
 * exists for.
 *
 * The same origin is refused, and so is any spelling that reaches the same
 * port on this machine, in either scheme (see `_isLocal`). This check reads
 * only the spelling. `refuseLiveAddress` requires an IP-literal target and
 * resolves the live name, and `refuseSameInstall` covers a route on another
 * port, such as a reverse proxy.
 * @param {string} apiBase - The target the operator named
 * @param {string|undefined} liveApi - `TANGLECLAW_API` of the launching pane, if any
 * @param {{exact: Set<string>, hostnamePrefix: string}} [names] - Local names, injectable for tests
 * @throws {DriverRefusal} `LIVE_INSTALL_TARGET`
 */
function refuseLiveTarget(apiBase, liveApi, names) {
  if (!liveApi) return;
  let target;
  let live;
  try {
    target = new URL(apiBase);
    live = new URL(liveApi);
  } catch (err) {
    // An unparseable TANGLECLAW_API cannot name the target; an unparseable
    // target is refused later, by the first request.
    if (err instanceof TypeError) return;
    throw err;
  }
  const local = names || localNames();
  const sameOrigin = target.origin === live.origin;
  const sameMachinePort = _port(target) === _port(live) && _isLocal(target.hostname, local) && _isLocal(live.hostname, local);
  if (sameOrigin || sameMachinePort) {
    throw new DriverRefusal(REFUSAL.LIVE_INSTALL_TARGET, `refusing to run a soak against ${target.origin}: it reaches this pane's own TangleClaw (TANGLECLAW_API ${live.origin})`, { target: target.origin });
  }
}

/**
 * With a live install to protect, require the target to be an IP literal,
 * and refuse it when that address is this machine on the live port.
 *
 * Why an IP literal: a hostname is resolved once when checked and again when
 * connected to, and nothing binds the two answers. A name that resolves
 * elsewhere at the check and to 127.0.0.1 at connect time (DNS rebinding)
 * would pass any resolve-then-check guard. An IP literal is never resolved,
 * so the address checked is the address connected to. The soak guest has a
 * fixed address, so this costs nothing in practice. Inside the guest there is
 * no live install (`--no-live-install`), and this does not apply.
 *
 * Whether the live install is on this machine is decided by spelling or by
 * resolving its own name. `TANGLECLAW_API` may use a Tailscale or LAN name
 * that is not the hostname. A live name that does not resolve counts as
 * local: when in doubt, protect.
 * @param {object} opts - Options
 * @param {string} opts.apiBase - Target
 * @param {string|undefined} opts.liveApi - `TANGLECLAW_API`, if any
 * @param {{exact: Set<string>, hostnamePrefix: string}} [opts.names] - Local names
 * @param {(host: string) => Promise<string[]>} [opts.lookup] - Resolver for the LIVE name only, injectable for tests
 * @returns {Promise<{targetAddress: string, liveLocal: boolean}|null>} What was checked, for the evidence record; null with no live install
 * @throws {DriverRefusal} `TARGET_NOT_IP_LITERAL` or `LIVE_INSTALL_TARGET`
 */
async function refuseLiveAddress(opts) {
  if (!opts.liveApi) return null;
  const target = new URL(opts.apiBase);
  const live = new URL(opts.liveApi);
  const targetAddress = canonicalHost(target.hostname);
  if (net.isIP(targetAddress) === 0) {
    throw new DriverRefusal(REFUSAL.TARGET_NOT_IP_LITERAL, `refusing to run: with a live install to protect, --api must name the soak guest by IP address, not ${target.hostname}, so the address checked is the address connected to`, { target: target.origin });
  }
  const local = opts.names || localNames();
  let liveLocal = _isLocal(live.hostname, local);
  if (!liveLocal) {
    const lookup = opts.lookup || (async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address));
    try {
      const liveAddrs = await lookup(canonicalHost(live.hostname));
      liveLocal = !Array.isArray(liveAddrs) || liveAddrs.length === 0 || liveAddrs.some((x) => _isLocal(x, local));
    } catch (err) { // prawduct:allow prawduct/broad-except -- resolver boundary: an unresolvable live name is treated as local, the protective answer
      liveLocal = true;
    }
  }
  if (_port(target) === _port(live) && liveLocal && _isLocal(targetAddress, local)) {
    throw new DriverRefusal(REFUSAL.LIVE_INSTALL_TARGET, `refusing to run a soak against ${target.origin}: ${targetAddress} is this machine, on the live install's port`, { target: target.origin });
  }
  return { targetAddress, liveLocal };
}

/**
 * Refuse to run with no live-install guard context, unless the operator says
 * so explicitly. Every guard compares the target with `TANGLECLAW_API`, so a
 * run started where that is unset (a plain shell, cron, launchd) is not
 * guarded at all. That is correct inside the soak guest, where the driver
 * targets the guest's own TangleClaw, but it has to be stated, not assumed.
 * The override is recorded in the log header by the caller.
 * @param {string|undefined} liveApi - `TANGLECLAW_API`, if any
 * @param {boolean} override - The operator's explicit `--no-live-install`
 * @returns {boolean} True when the run proceeds on the override
 * @throws {DriverRefusal} `GUARD_CONTEXT_ABSENT`
 */
function requireGuardContext(liveApi, override) {
  if (liveApi) return false;
  if (override) return true;
  throw new DriverRefusal(REFUSAL.GUARD_CONTEXT_ABSENT, 'refusing to run: TANGLECLAW_API is not set, so nothing can check that the target is not a live install. Inside the soak guest, pass --no-live-install to say so');
}

/**
 * Refuse a target that identifies itself as the same running server as the
 * live install. Both are asked for `/api/server-info`; the same `startedAt`
 * and `startupSha` means one process, whatever address reached it. This is
 * what catches a route the address checks cannot see, such as a reverse proxy
 * in front of the live install on another port.
 *
 * The two sides fail differently, on purpose:
 * - **The live side** is the thing being protected. When `TANGLECLAW_API` is
 *   set but its identity cannot be read (an error, a timeout, a non-200, or no
 *   `startedAt`/`startupSha`), the check refuses (`LIVE_IDENTITY_UNREADABLE`)
 *   unless `allowUnverifiedLive` is given. The caller records that override.
 * - **The target side** failing only means the comparison cannot be made. A
 *   target that answers nothing, or answers `401`, answers the load the same
 *   way, so nothing can be written through it. That is reported as unchecked.
 *
 * With no `TANGLECLAW_API` there is no live install to protect from this
 * process. That is the soak guest's normal case: the driver runs there
 * against the guest's own TangleClaw.
 * @param {object} opts - Options
 * @param {string} opts.apiBase - Target
 * @param {string|undefined} opts.liveApi - `TANGLECLAW_API`, if any
 * @param {Function} opts.fetch - Fetch implementation
 * @param {string|null} [opts.token] - Service token for the target
 * @param {boolean} [opts.allowUnverifiedLive] - Proceed when the live identity is unreadable
 * @returns {Promise<{checked: boolean, reason: string|null, liveUnverified: boolean}>} What the comparison established
 * @throws {DriverRefusal} `LIVE_INSTALL_TARGET` or `LIVE_IDENTITY_UNREADABLE`
 */
async function refuseSameInstall(opts) {
  if (!opts.liveApi) return { checked: false, reason: 'no TANGLECLAW_API in this pane', liveUnverified: false };
  const read = async (base, token) => {
    try {
      const res = await opts.fetch(new URL('/api/server-info', base), {
        // A redirect is never followed: the identity must come from the
        // server that was named, not from wherever it points.
        redirect: 'manual',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10 * 1000)
      });
      if (res.status >= 300 && res.status <= 399) return { error: `redirect refused (HTTP ${res.status})` };
      if (res.status !== 200) return { error: `HTTP ${res.status}` };
      const body = JSON.parse(await res.text());
      if (!body || !body.startedAt || !body.startupSha) return { error: 'no startedAt/startupSha' };
      return { body };
    } catch (err) { // prawduct:allow prawduct/broad-except -- network boundary: an unreadable side becomes a reason, and each side's caller decides what that means
      return { error: String((err && (err.name === 'TimeoutError' ? 'timeout' : err.message)) || err) };
    }
  };
  const [live, target] = await Promise.all([read(opts.liveApi, null), read(opts.apiBase, opts.token || null)]);
  if (live.error) {
    const reason = `live install server-info: ${live.error}`;
    if (!opts.allowUnverifiedLive) {
      throw new DriverRefusal(REFUSAL.LIVE_IDENTITY_UNREADABLE, `refusing to run: cannot read the live install's identity (${reason}), so the target cannot be shown to be a different server. Pass --allow-unverified-live to proceed anyway`, { reason });
    }
    return { checked: false, reason, liveUnverified: true };
  }
  if (target.error) return { checked: false, reason: `target server-info: ${target.error}`, liveUnverified: false };
  if (live.body.startedAt === target.body.startedAt && live.body.startupSha === target.body.startupSha) {
    throw new DriverRefusal(REFUSAL.LIVE_INSTALL_TARGET, `refusing to run a soak against ${new URL(opts.apiBase).origin}: it reports the same running server as this pane's TangleClaw (started ${live.body.startedAt})`, { target: new URL(opts.apiBase).origin });
  }
  return { checked: true, reason: null, liveUnverified: false };
}

/** Schema of the lock-lost sidecar. */
const LOCK_LOST_SCHEMA = 'tc.soak-lock-lost/v1';

/**
 * Where a log's lock-lost sidecar lives.
 * @param {string} logPath - Log file
 * @returns {string} Sidecar path
 */
function lockLostPath(logPath) {
  return `${logPath}.lock-lost`;
}

/**
 * Record, beside the log, that this driver lost the log's lock.
 *
 * Once ownership is gone the log itself is never written again: appending to
 * it without the lock is exactly what the lock forbids. So the loss is
 * recorded in a separate, fail-only sidecar. It binds the exact log it
 * condemns (absolute path, byte size and sha256 at the moment of loss), plus
 * who should have held the lock and who was found holding it. It is created
 * atomically: written in full to a private temp file, fsynced, then
 * hard-linked into place, which never overwrites. The directory is fsynced
 * too. A sidecar that already exists is left as it is: the loss is already on
 * record.
 * @param {string} logPath - Log file
 * @param {{expected: object, observed: object|null, why: string, at: number}} loss - What happened
 * @returns {string} The sidecar path
 * @throws {Error} When it cannot be written; the caller reports `LOCK_LOST_UNRECORDED`
 */
function writeLockLostSidecar(logPath, loss) {
  let bytes;
  try {
    bytes = fs.readFileSync(logPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    bytes = Buffer.alloc(0);
  }
  const record = {
    type: 'lock-lost',
    schema: LOCK_LOST_SCHEMA,
    logPath: path.resolve(logPath),
    logBytes: bytes.length,
    logSha256: _sha256(bytes),
    expected: loss.expected,
    observed: loss.observed,
    why: loss.why,
    at: loss.at
  };
  const target = lockLostPath(logPath);
  const tmp = `${target}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    writeAll(fd, Buffer.from(`${JSON.stringify(record)}\n`));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, target);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const dir = fs.openSync(path.dirname(path.resolve(target)), 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
  return target;
}

/**
 * Refuse a log that has a lock-lost sidecar. While one exists, nothing may
 * read the log as evidence, resume it or judge it.
 * - A sidecar that binds this log exactly (same path, and the log still
 *   begins with the bytes it recorded) is refused as `LOG_LOCK_LOST`.
 * - One that does not bind it, is malformed, or cannot be read is refused as
 *   `LOG_LOCK_LOST_INVALID`. Tampering never turns a refusal into acceptance.
 * @param {string} logPath - Log file
 * @throws {DriverRefusal} `LOG_LOCK_LOST` or `LOG_LOCK_LOST_INVALID`
 */
function checkLockLost(logPath) {
  const target = lockLostPath(logPath);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    // A read can fail because the sidecar itself cannot be read, or because
    // the log's directory cannot be searched, in which case whether any
    // sidecar exists is unknown. Asking for the entry's metadata tells the
    // two apart: it needs only the directory, not the file.
    let directoryUnreadable = false;
    try {
      fs.statSync(target);
    } catch (statErr) { // prawduct:allow prawduct/broad-except -- any failure to see the entry means the directory, not the sidecar, is what cannot be read
      directoryUnreadable = true;
    }
    if (directoryUnreadable) {
      const dir = path.dirname(path.resolve(target));
      throw new DriverRefusal(REFUSAL.LOG_LOCK_LOST_INVALID, `the directory holding ${logPath} cannot be read (${err.code || err.message}), so whether it has a lock-lost sidecar is unknown; it cannot be used as evidence until ${dir} is readable again`, { sidecar: target, directoryUnreadable: dir });
    }
    throw new DriverRefusal(REFUSAL.LOG_LOCK_LOST_INVALID, `${logPath} has a lock-lost sidecar that cannot be read (${err.code || err.message}); it cannot be used as evidence`, { sidecar: target, directoryUnreadable: null });
  }
  const invalid = (why) => new DriverRefusal(REFUSAL.LOG_LOCK_LOST_INVALID, `${logPath} has a lock-lost sidecar that ${why}; it cannot be used as evidence`, { sidecar: target });
  let record;
  try {
    record = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw invalid('is not valid JSON');
  }
  if (!record || record.type !== 'lock-lost' || record.schema !== LOCK_LOST_SCHEMA || !Number.isInteger(record.logBytes) || typeof record.logSha256 !== 'string') {
    throw invalid('is malformed');
  }
  if (record.logPath !== path.resolve(logPath)) throw invalid('names a different log');
  let bytes;
  try {
    bytes = fs.readFileSync(logPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    bytes = Buffer.alloc(0);
  }
  if (bytes.length < record.logBytes || _sha256(bytes.subarray(0, record.logBytes)) !== record.logSha256) {
    throw invalid('does not match the log (it was cut or rewritten after the loss)');
  }
  throw new DriverRefusal(REFUSAL.LOG_LOCK_LOST, `${logPath} lost its lock (${record.why}); another writer may have touched it, so it cannot be resumed or judged. Start a new log`, { sidecar: target, why: record.why, expected: record.expected, observed: record.observed });
}

/** Schema of the segment-in-progress marker. */
const SEGMENT_SCHEMA = 'tc.soak-segment/v1';

/**
 * Where a log's segment-in-progress marker lives.
 * @param {string} logPath - Log file
 * @returns {string} Marker path
 */
function segmentPath(logPath) {
  return `${logPath}.segment`;
}

/**
 * Write a file durably and atomically: in full to a private temp file,
 * fsynced, renamed over the target, then the directory fsynced. Used only for
 * the segment marker, which its owner may replace.
 * @param {string} target - Destination
 * @param {string} text - Content
 */
function _writeDurable(target, text) {
  const tmp = `${target}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    writeAll(fd, Buffer.from(text));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  _fsyncDir(target);
}

/**
 * fsync the directory holding a path, so a create, rename or unlink in it is
 * durable.
 * @param {string} p - A path in the directory
 */
function _fsyncDir(p) {
  const dir = fs.openSync(path.dirname(path.resolve(p)), 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}

/**
 * Open a log segment: durably record, before any work, that `owner` is
 * running against this log. The marker binds the log's absolute path and the
 * exact bytes the log held when the segment began.
 *
 * The marker is what lets a later run tell an ordinary crash from a lost lock
 * whose loss could not even be recorded:
 * - an ordinary crash leaves the marker AND the old lock, both naming the
 *   same dead owner on this host. That may be reconciled and resumed.
 * - an unrecorded loss leaves the marker with the lock absent, replaced or
 *   unreadable. That is never resumed.
 * @param {string} logPath - Log file
 * @param {{pid: number, host: string}} owner - The segment's owner
 * @param {number} at - Clock time
 */
function openSegment(logPath, owner, at) {
  let bytes;
  try {
    bytes = fs.readFileSync(logPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    bytes = Buffer.alloc(0);
  }
  _writeDurable(segmentPath(logPath), `${JSON.stringify({
    type: 'segment-in-progress',
    schema: SEGMENT_SCHEMA,
    state: 'active',
    logPath: path.resolve(logPath),
    owner,
    startedAt: at,
    logBytesAtStart: bytes.length,
    logSha256AtStart: _sha256(bytes)
  })}\n`);
}

/**
 * Mark a segment as stopped cleanly. Called under exact ownership, after the
 * `stop` record is appended and fsynced, and before the lock is released. The
 * marker is atomically replaced by a `stopped-clean` one that binds the WHOLE
 * log as it stands, so any byte written after the stop is detected. If the
 * process dies after releasing the lock but before the marker is cleaned up,
 * a later run can validate this marker and resume, even with no lock.
 * @param {string} logPath - Log file
 * @param {object} marker - The segment's active marker
 * @param {number} at - Clock time
 */
function stopSegment(logPath, marker, at) {
  const bytes = fs.readFileSync(logPath);
  _writeDurable(segmentPath(logPath), `${JSON.stringify({
    ...marker,
    state: 'stopped-clean',
    stoppedAt: at,
    logBytes: bytes.length,
    logSha256: _sha256(bytes)
  })}\n`);
}

/**
 * Close a log segment: remove its marker durably. Called only after the
 * segment's last append was fsynced and its exact owner released the lock.
 * The two steps fail differently, and the caller must say which:
 * - the unlink failed: the marker is still there;
 * - the unlink succeeded but the directory fsync failed: the marker is gone
 *   now, but a crash could bring it back, so whether it remains is unknown.
 * @param {string} logPath - Log file
 * @param {{rmSync?: Function, fsyncDir?: Function}} [io] - Stand-ins for tests
 * @returns {{cleanup: 'done'}|{cleanup: 'marker-remains'|'unknown', error: Error}} What became of the marker
 */
function closeSegment(logPath, io = {}) {
  const target = segmentPath(logPath);
  try {
    (io.rmSync || fs.rmSync)(target, { force: true });
  } catch (err) { // prawduct:allow prawduct/broad-except -- a failed unlink is returned to the caller, which reports it
    return { cleanup: 'marker-remains', error: err };
  }
  try {
    (io.fsyncDir || _fsyncDir)(target);
  } catch (err) { // prawduct:allow prawduct/broad-except -- a failed directory fsync is returned to the caller, which reports it
    return { cleanup: 'unknown', error: err };
  }
  return { cleanup: 'done' };
}

/** `recoveredFrom.state` for a segment resumed by an exact-owner reclaim. */
const OWNERSHIP_UNVERIFIED_STATE = 'ownership-unverified';

/**
 * Refuse, for good, a segment whose lock no longer names its owner. The
 * owner is dead, so nothing can finish or reconcile that segment, and a lock
 * that is gone, names someone else or cannot be read may be a loss whose
 * record was never written. The loss is recorded now, in the same bound
 * sidecar a run writes when it loses its lock, so that no later lock, even
 * one restored to name the exact owner again, can resume the log.
 *
 * "For good" holds only once that record is written. Where it cannot be
 * (`condemnError`), or where the whole directory is unreadable so recovery
 * never gets this far (`checkLockLost` refuses first), nothing durable
 * remains, and a later exact-owner reclaim can resume the log. That resume is
 * still recorded as ownership-unverified, so it never reads as clean.
 * @param {string} logPath - Log file
 * @param {object} marker - The open segment's active marker
 * @param {object|null} observed - What the lock was found to name, if anything
 * @param {string} found - How the lock was found, for the message
 * @param {number} at - Clock time
 * @returns {DriverRefusal} `LOG_SEGMENT_UNRECONCILED`, with `condemned` naming the sidecar (null if it could not be written) and `condemnError`
 */
function _condemnSegment(logPath, marker, observed, found, at) {
  const why = `segment left open by pid ${marker.owner.pid} on ${marker.owner.host}, a dead process, and its lock is ${found}`;
  let condemned = null;
  let condemnError = null;
  try {
    condemned = writeLockLostSidecar(logPath, { expected: marker.owner, observed, why, at });
  } catch (err) { // prawduct:allow prawduct/broad-except -- a failed condemnation is reported on the refusal, never swallowed
    condemnError = String((err && (err.code || err.message)) || err);
  }
  const record = condemned ? `the refusal is recorded in ${condemned}` : `the refusal could not be recorded (${condemnError}), so check this log by hand before any use`;
  return new DriverRefusal(REFUSAL.LOG_SEGMENT_UNRECONCILED,
    `${logPath} has a ${why}; its lock may have been lost without a record, so it is never resumed and ${record}. Start a new log`,
    { marker: segmentPath(logPath), owner: marker.owner, lockFound: observed, condemned, condemnError });
}

/**
 * Read and validate a log's segment marker, if it has one. A marker that is
 * malformed, names another log, or no longer matches the bytes the log began
 * the segment with is refused as tampered (`LOG_SEGMENT_INVALID`).
 * @param {string} logPath - Log file
 * @returns {object|null} The marker, or null when there is none
 * @throws {DriverRefusal} `LOG_SEGMENT_INVALID`
 */
function readSegment(logPath) {
  const target = segmentPath(logPath);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new DriverRefusal(REFUSAL.LOG_SEGMENT_INVALID, `${logPath} has a segment marker that cannot be read (${err.code || err.message})`, { marker: target });
  }
  const invalid = (why) => new DriverRefusal(REFUSAL.LOG_SEGMENT_INVALID, `${logPath} has a segment marker that ${why}; it cannot be reconciled`, { marker: target });
  let m;
  try {
    m = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw invalid('is not valid JSON');
  }
  if (!m || m.type !== 'segment-in-progress' || m.schema !== SEGMENT_SCHEMA || !['active', 'stopped-clean'].includes(m.state)
    || !m.owner || !Number.isInteger(m.owner.pid) || typeof m.owner.host !== 'string'
    || !Number.isInteger(m.logBytesAtStart) || typeof m.logSha256AtStart !== 'string'
    || (m.state === 'stopped-clean' && (!Number.isInteger(m.logBytes) || typeof m.logSha256 !== 'string'))) {
    throw invalid('is malformed');
  }
  if (m.logPath !== path.resolve(logPath)) throw invalid('names a different log');
  let bytes;
  try {
    bytes = fs.readFileSync(logPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    bytes = Buffer.alloc(0);
  }
  if (bytes.length < m.logBytesAtStart || _sha256(bytes.subarray(0, m.logBytesAtStart)) !== m.logSha256AtStart) {
    throw invalid('does not match the log (it was cut or rewritten)');
  }
  // A clean stop binds the whole log: nothing may have been written since.
  if (m.state === 'stopped-clean' && (bytes.length !== m.logBytes || _sha256(bytes) !== m.logSha256)) {
    throw invalid('says the segment stopped cleanly, but the log has changed since');
  }
  return m;
}

/**
 * The sha256 of some bytes, as hex.
 * @param {Buffer} buf - Bytes
 * @returns {string} Hex digest
 */
function _sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Read an existing log without changing it.
 *
 * The log is read as bytes, split on newlines, so every line's exact byte
 * offset and content are known:
 * - **A torn tail.** A crash mid-write can leave a final line without its
 *   newline. That tail is reported (`torn`: offset, length, sha256) and its
 *   event counts as not run, so it runs again. The file is not changed here;
 *   `sealTornTail` closes the fragment by appending after it.
 * - **A sealed region.** Damaged bytes are accepted only when a
 *   `torn-tail-sealed` seal immediately after them binds exactly that region:
 *   its start offset, its length and its sha256. A seal that binds anything
 *   else, a seal with no region before it, and damage that no seal binds are
 *   all refused, except at the very end of the log, where unsealed damage is
 *   the pending region of the most recent crash. That includes a seal whose
 *   own write was torn.
 * - **Several crashes.** Each seal binds one fragment, so a log that survived
 *   several torn writes, each sealed, still reads back. Only its unsealed
 *   final fragment may be pending.
 * @param {string} logPath - Log file
 * @param {{segmentOwner?: {pid: number, host: string}}} [opts] - The run that owns the open segment, which alone may read it
 * @returns {{header: object|null, lastIndex: number, ended: boolean, tornTail: boolean, torn: {offset: number, bytes: number, sha256: string, endsWithNewline: boolean}|null, finishSeal: boolean, lastStartedAt: number|null, lastFaultStartedAt: number|null, ownership: {verified: boolean, unverifiedSegments: object[]}, certification: object}} What the log records. `finishSeal` means the log ends in a complete seal that lost only its newline, which the next run appends. `ownership` lists every ownership-unverified segment, and `certification` is what that means for a pass (see `_certification`).
 * @throws {DriverRefusal} `LOG_UNREADABLE`; `LOG_LOCK_LOST`/`LOG_LOCK_LOST_INVALID` when a lock-lost sidecar exists (see `checkLockLost`); `LOG_SEGMENT_OPEN`/`LOG_SEGMENT_INVALID` for an open segment that is not the caller's
 */
function readLog(logPath, opts = {}) {
  // A log whose run lost its lock is never read as evidence.
  checkLockLost(logPath);
  // Nor is one with a segment still open: a run is in progress, or one ended
  // without closing its segment and has not been reconciled. Only the run
  // that owns the open segment may read the log it is writing.
  const marker = readSegment(logPath);
  if (marker && !(opts.segmentOwner && marker.owner.pid === opts.segmentOwner.pid && marker.owner.host === opts.segmentOwner.host)) {
    throw new DriverRefusal(REFUSAL.LOG_SEGMENT_OPEN, `${logPath} has an open segment (owner pid ${marker.owner.pid} on ${marker.owner.host}); it is being written, or was left unreconciled, and cannot be read as evidence`, { marker: segmentPath(logPath), owner: marker.owner });
  }
  let buf;
  try {
    buf = fs.readFileSync(logPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const ownership = { verified: true, unverifiedSegments: [] };
      return { header: null, lastIndex: -1, ended: false, tornTail: false, torn: null, finishSeal: false, lastStartedAt: null, lastFaultStartedAt: null, ownership, certification: _certification(logPath, Buffer.alloc(0), ownership) };
    }
    throw new DriverRefusal(REFUSAL.LOG_UNREADABLE, `cannot read ${logPath}: ${err.code || err.message}`);
  }
  const unreadable = (why) => new DriverRefusal(REFUSAL.LOG_UNREADABLE, `${logPath}: ${why}`);

  // Split into complete lines, each with its byte offset, plus any torn tail.
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push({ offset: start, bytes: buf.subarray(start, i) });
      start = i + 1;
    }
  }
  let tailStart = start;

  const parse = (bytes) => {
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return undefined;
    }
  };
  const isSeal = (r) => !!r && r.type === 'torn-tail-sealed';

  // A torn tail that is itself a complete seal, matching the damage right
  // before it, is not damage: it is a finished seal whose trailing newline
  // was cut. It is accepted as a seal, and the next run appends just the
  // newline (`finishSeal`). Treating it as fresh damage instead would put a
  // seal on top of a seal, and a later read could no longer tell which seal
  // closes which region.
  let finishSeal = false;
  if (tailStart < buf.length) {
    const tail = parse(buf.subarray(tailStart));
    if (isSeal(tail) && Number.isInteger(tail.offset) && tail.offset < tailStart && lines.some((l) => l.offset === tail.offset)) {
      const region = buf.subarray(tail.offset, tailStart - 1);
      if (tail.bytes === region.length && tail.sha256 === _sha256(region)) {
        lines.push({ offset: tailStart, bytes: buf.subarray(tailStart) });
        tailStart = buf.length;
        finishSeal = true;
      }
    }
  }

  // A seal binds a byte RANGE: from the first byte of a damaged region up to
  // the newline just before the seal itself. The range is usually one torn
  // line. It can be more than one when the seal's own write was torn and a
  // later resume sealed the leftovers together. The seal must name the
  // range's exact start offset, length and sha256, and it is found by that
  // start offset, whether or not the lines inside the range parse. A crash
  // can cut off only a newline, leaving a complete, valid record.
  const sealAt = new Map();
  lines.forEach((line, j) => {
    const r = line.bytes.includes('"torn-tail-sealed"') ? parse(line.bytes) : undefined;
    if (isSeal(r) && Number.isInteger(r.offset)) sealAt.set(r.offset, j);
  });

  const records = [];
  let pendingFrom = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const j = sealAt.get(line.offset);
    if (j !== undefined && j > i) {
      const seal = parse(lines[j].bytes);
      const region = buf.subarray(line.offset, lines[j].offset - 1);
      if (seal.bytes !== region.length || seal.sha256 !== _sha256(region)) {
        throw unreadable(`the seal on line ${j + 1} does not bind the region starting at line ${i + 1} (length or sha256 differ)`);
      }
      i = j; // the region and its seal are consumed together
      continue;
    }
    const r = line.bytes.length === 0 ? undefined : parse(line.bytes);
    if (r === undefined) {
      // Unsealed damage is allowed only as the very end of the log: the
      // leftovers of a crash, including one that tore the seal's own write.
      // It becomes the pending region the next run seals. Anywhere else, the
      // log can no longer be trusted as evidence.
      const restIsDamage = lines.slice(i).every((l) => l.bytes.length === 0 || parse(l.bytes) === undefined);
      if (!restIsDamage) throw unreadable(`line ${i + 1} is not JSON and no seal binds it`);
      pendingFrom = line.offset;
      break;
    }
    if (isSeal(r)) throw unreadable(`line ${i + 1} is a seal with no damaged region before it`);
    records.push(r);
  }
  if (pendingFrom === null && tailStart < buf.length) pendingFrom = tailStart;
  // The pending region runs to the end of the file, less a final newline,
  // which is not part of the damage and is reused as the seal's separator.
  let torn = null;
  if (pendingFrom !== null) {
    const end = buf.length > pendingFrom && buf[buf.length - 1] === 0x0a ? buf.length - 1 : buf.length;
    const region = buf.subarray(pendingFrom, end);
    torn = { offset: pendingFrom, bytes: region.length, sha256: _sha256(region), endsWithNewline: end !== buf.length };
  }

  const header = records.length > 0 ? records[0] : null;
  if (!header && (torn || lines.length > 0)) throw unreadable('it has no complete header, so it cannot be resumed');
  if (header && (header.type !== 'header' || header.schema !== LOG_SCHEMA)) throw unreadable(`it does not start with a ${LOG_SCHEMA} header`);
  // Every slot is computed from startEpochMs. A missing or non-numeric value
  // would make every slot NaN, and every event would fire at once.
  if (header && (!Number.isSafeInteger(header.startEpochMs) || header.startEpochMs <= 0 || typeof header.scheduleDigest !== 'string')) {
    throw unreadable('its header has no valid startEpochMs and scheduleDigest');
  }
  let lastIndex = -1;
  let ended = false;
  let lastStartedAt = null;
  let lastFaultStartedAt = null;
  // Every segment resumed by an exact-owner reclaim, whose lock ownership
  // therefore cannot be shown to have held throughout.
  const unverifiedSegments = records
    .filter((r) => (r.type === 'header' || r.type === 'resume') && r.recoveredFrom && r.recoveredFrom.state === OWNERSHIP_UNVERIFIED_STATE)
    .map((r) => ({ recoveredAt: r.type === 'header' ? r.startEpochMs : r.at, owner: r.recoveredFrom.owner, segmentStartedAt: r.recoveredFrom.segmentStartedAt }));
  for (const r of records.slice(1)) {
    if (r.type === 'event' && Number.isInteger(r.index)) {
      lastIndex = Math.max(lastIndex, r.index);
      if (Number.isFinite(r.startedAt)) {
        lastStartedAt = r.startedAt;
        if (typeof r.kind === 'string' && r.kind.startsWith('fault.') && !r.skipped) lastFaultStartedAt = r.startedAt;
      }
    }
    if (r.type === 'end') ended = true;
  }
  const ownership = { verified: unverifiedSegments.length === 0, unverifiedSegments };
  return { header, lastIndex, ended, tornTail: torn !== null || finishSeal, torn, finishSeal, lastStartedAt, lastFaultStartedAt, ownership, certification: _certification(logPath, buf, ownership) };
}

/**
 * What the log's lock ownership means for certification. The driver judges
 * nothing else: this says only whether ownership stops the log counting as
 * an automatic pass.
 *
 * A log with any ownership-unverified segment is not an automatic pass. Its
 * default disposition is fail and reset. The Operator may accept it, but only
 * this exact evidence: the acceptance must bind the log's path, size and
 * sha256 as they are now (see `acceptanceMatches`).
 * @param {string} logPath - Log file
 * @param {Buffer} buf - The log's bytes as read
 * @param {{verified: boolean}} ownership - From `readLog`
 * @returns {{automaticPassAllowed: boolean, defaultDisposition: 'fail-reset'|null, reason: 'OWNERSHIP_UNVERIFIED'|null, operatorAcceptance: {required: true, evidence: {logPath: string, logBytes: number, logSha256: string}}|null}} The disposition
 */
function _certification(logPath, buf, ownership) {
  if (ownership.verified) return { automaticPassAllowed: true, defaultDisposition: null, reason: null, operatorAcceptance: null };
  return {
    automaticPassAllowed: false,
    defaultDisposition: 'fail-reset',
    reason: REFUSAL.OWNERSHIP_UNVERIFIED,
    operatorAcceptance: { required: true, evidence: { logPath: path.resolve(logPath), logBytes: buf.length, logSha256: _sha256(buf) } }
  };
}

/**
 * Whether an Operator's acceptance covers exactly the evidence a
 * certification disposition names. A judge overrides a `fail-reset`
 * disposition only when this is true. An acceptance of any other bytes, of
 * another log, or with no binding at all covers nothing.
 * @param {object} certification - `readLog(...).certification`
 * @param {{logPath?: string, logBytes?: number, logSha256?: string}|null|undefined} acceptance - The Operator's recorded acceptance
 * @returns {boolean} True only for an exact match
 */
function acceptanceMatches(certification, acceptance) {
  if (!certification || !certification.operatorAcceptance || !acceptance) return false;
  const e = certification.operatorAcceptance.evidence;
  return acceptance.logPath === e.logPath && acceptance.logBytes === e.logBytes && acceptance.logSha256 === e.logSha256;
}

/**
 * Close the log's damaged end by appending after it: a newline if the damage
 * does not already end with one, then a seal that binds exactly that region
 * by its byte offset, length and sha256. Nothing already in the file changes,
 * and `readLog` accepts the region only because this seal matches it byte for
 * byte. If this write is itself torn, its leftovers join the region the next
 * run seals.
 * @param {string} logPath - Log file
 * @param {{offset: number, bytes: number, sha256: string, endsWithNewline: boolean}} torn - The pending region, from `readLog`
 * @param {number} at - Clock time
 */
function sealTornTail(logPath, torn, at) {
  const fd = fs.openSync(logPath, 'a', 0o600);
  try {
    const lead = torn.endsWithNewline ? '' : '\n';
    writeAll(fd, Buffer.from(`${lead}${JSON.stringify({ type: 'torn-tail-sealed', at, offset: torn.offset, bytes: torn.bytes, sha256: torn.sha256 })}\n`));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read a lock file's holder, or null when it is gone or unreadable.
 * @param {string} lockPath - Lock file
 * @returns {{pid: number, host: string}|null} The holder
 */
function _readHolder(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    if (err instanceof SyntaxError || err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Whether a process exists, by signalling it with signal 0. `EPERM` means it
 * exists but belongs to someone else.
 * @param {number} p - pid
 * @returns {boolean} True when it exists
 */
function _isAlive(p) {
  try {
    process.kill(p, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Whether an owner is provably dead: a process on this host that no longer
 * exists. An owner on another host, or one whose pid is in use, is not.
 * @param {{pid: number, host: string}} owner - A segment's owner
 * @param {object} [deps] - `{host, isAlive}`, as for `acquireLogLock`
 * @returns {boolean} True only when provably dead
 */
function _ownerDead(owner, deps = {}) {
  const host = deps.host || os.hostname();
  const isAlive = deps.isAlive || _isAlive;
  return owner.host === host && Number.isInteger(owner.pid) && !isAlive(owner.pid);
}

/**
 * Take the log's lock, so two drivers can never append to the same log.
 *
 * The lock file (`<log>.lock`) records the holder's pid and host, and is
 * created with `wx`, which only one process can win. A lock left by a
 * process on this host that no longer exists is reclaimed, and the reclaim is
 * reported. Reclaiming has to have exactly one winner too. A plain
 * remove-then-create does not: a second reclaimer can remove the first one's
 * fresh lock and take it as well. So a reclaim happens only while holding a
 * reclaim mutex, `<log>.lock.reclaim`, a directory whose `mkdir` only one
 * process can win. Inside it the winner re-reads the lock and replaces it
 * only if it is still the same dead holder. Every other process is refused.
 * Everything else is refused as well: a live holder, a holder on another
 * host (liveness cannot be checked from here), an unreadable lock file, or a
 * reclaim already in progress.
 * @param {string} logPath - Log file
 * @param {object} [deps] - `{pid, host, isAlive, afterStaleCheck, releaseFs}`, injectable for tests
 * @returns {{release: () => {lost: object|null, releaseFailed: object|null}, owned: () => object, expected: object, reclaimed: object|null}} The lock. `owned` re-reads ownership from disk; `release` never throws.
 * @throws {DriverRefusal} `LOG_LOCKED`
 */
function acquireLogLock(logPath, deps = {}) {
  const lockPath = `${logPath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  const pid = deps.pid || process.pid;
  const host = deps.host || os.hostname();
  const isAlive = deps.isAlive || _isAlive;
  const mine = JSON.stringify({ pid, host });
  const expected = { pid, host };
  /**
   * Whether the lock is still ours, read fresh from disk. A failure has one
   * of three kinds, because they call for different handling:
   * - `removed`: the lock file is gone;
   * - `replaced`: it holds something other than our identity;
   * - `unverified`: it could not be read at all. Ownership that cannot be
   *   verified is not held, so the run stops; but nothing shows another
   *   writer, so the log is not condemned (see `runSchedule`).
   * @param {object} io - `fs`, or a stand-in for tests
   * @returns {{ok: true}|{ok: false, kind: 'removed'|'replaced'|'unverified', why: string, holder: object|null}} The answer
   */
  const ownership = (io) => {
    let now;
    try {
      now = io.readFileSync(lockPath, 'utf8');
    } catch (err) { // prawduct:allow prawduct/broad-except -- any failure to read the lock means ownership is not verified; the kind says which
      if (err.code === 'ENOENT') return { ok: false, kind: 'removed', why: 'lock file removed during the run', holder: null };
      return { ok: false, kind: 'unverified', why: `lock unreadable (${err.code || err.message})`, holder: null };
    }
    if (now === mine) return { ok: true };
    let holder = null;
    try {
      holder = JSON.parse(now);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    return { ok: false, kind: 'replaced', why: 'lock taken over during the run', holder };
  };
  const io = deps.releaseFs || fs;
  // Release never throws, and tells apart the three ways it can go wrong:
  // - `lost`: the lock is not ours any more (removed or taken over), so
  //   another writer may have touched the log;
  // - `unverified`: the lock cannot be read, so whether it is still ours is
  //   unknown. It is left exactly as it is: a lock we cannot read is not ours
  //   to remove;
  // - `releaseFailed`: the lock is still ours but could not be removed. The
  //   log is intact; only the lock file is left behind.
  const release = () => {
    const own = ownership(io);
    if (!own.ok && own.kind === 'unverified') return { lost: null, unverified: { why: own.why, expected }, releaseFailed: null };
    if (!own.ok) return { lost: { why: own.why, holder: own.holder, expected }, unverified: null, releaseFailed: null };
    try {
      io.rmSync(lockPath, { force: true });
    } catch (err) { // prawduct:allow prawduct/broad-except -- release must never throw: a lock we own but cannot remove is reported, not raised
      return { lost: null, unverified: null, releaseFailed: { why: `lock could not be removed (${err.code || err.message}); remove ${lockPath} by hand` } };
    }
    return { lost: null, unverified: null, releaseFailed: null };
  };
  const owned = () => ownership(fs);
  const take = () => {
    fs.writeFileSync(lockPath, mine, { flag: 'wx', mode: 0o600 });
    return { release, owned, expected };
  };
  const refuse = (holder, why, extra = {}) => new DriverRefusal(REFUSAL.LOG_LOCKED,
    `${logPath} is locked (${why})${holder ? ` by pid ${holder.pid} on ${holder.host}` : ''}; remove ${lockPath} only if no driver is running`, { holder, why, ...extra });

  try {
    return { ...take(), reclaimed: null };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  // A lock that exists but cannot be read, or holds no identity, is refused.
  // `lockUnreadable` says which, so that a caller finding an open segment
  // behind it can refuse that segment for good (see `runSchedule`). A lock
  // that vanished between the create and this read is only a race, and is
  // refused without that mark.
  let text;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw refuse(null, 'lock file vanished while it was being read');
    throw refuse(null, `unreadable lock file (${err.code || err.message})`, { lockUnreadable: err.code || err.message });
  }
  let holder = null;
  try {
    holder = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  if (!holder || typeof holder !== 'object') throw refuse(null, 'unparseable lock file', { lockUnreadable: 'unparseable' });
  const stale = holder.host === host && Number.isInteger(holder.pid) && !isAlive(holder.pid);
  if (!stale) throw refuse(holder, holder.host === host ? 'holder is running' : 'holder is on another host');
  // Test-only: hold every contender here, so a concurrency test can make
  // them all find the lock stale before any of them reclaims it.
  if (deps.afterStaleCheck) deps.afterStaleCheck();

  try {
    fs.mkdirSync(reclaimPath, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    throw refuse(holder, `another process is reclaiming it; if none is, remove ${reclaimPath}`);
  }
  try {
    // Re-read under the mutex: the lock may have been reclaimed and retaken
    // between the first read and winning the mutex.
    const again = _readHolder(lockPath);
    if (!again || again.pid !== holder.pid || again.host !== holder.host) throw refuse(again, 'lock changed hands during reclaim');
    // Replace the lock in one atomic rename. Removing it and creating a new
    // one would leave a moment with no lock file at all, and a process on its
    // ordinary first attempt could take the lock in that gap.
    const tmp = `${lockPath}.${pid}.${process.hrtime.bigint()}.tmp`;
    fs.writeFileSync(tmp, mine, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, lockPath);
    return { release, owned, expected, reclaimed: holder };
  } finally {
    fs.rmSync(reclaimPath, { recursive: true, force: true });
  }
}

/**
 * Write every byte of a buffer, however many calls it takes. `fs.writeSync`
 * may write only part of what it was given, for example when the disk is
 * nearly full. Ignoring that would leave a partial record in the middle of
 * the log, with the next record joined onto it, which no seal can repair. A
 * write that makes no progress throws instead.
 * @param {number} fd - Open file descriptor
 * @param {Buffer} buf - Bytes to write
 * @param {Function} [write] - `fs.writeSync`, injectable for tests
 */
function writeAll(fd, buf, write = fs.writeSync) {
  let done = 0;
  while (done < buf.length) {
    const n = write(fd, buf, done, buf.length - done);
    if (!(n > 0)) {
      const err = new Error(`short write: ${done} of ${buf.length} bytes written, then no progress`);
      err.code = 'ESHORTWRITE';
      throw err;
    }
    done += n;
  }
}

/**
 * Append raw text and flush it, for the one repair that is not a record: the
 * newline a finished seal lost to a crash.
 * @param {string} logPath - Log file
 * @param {string} text - Text to append
 */
function appendRaw(logPath, text) {
  const fd = fs.openSync(logPath, 'a', 0o600);
  try {
    writeAll(fd, Buffer.from(text));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append one record and flush it to disk before returning, so a crash can
 * lose at most the event in flight.
 * @param {string} logPath - Log file
 * @param {object} record - Record
 */
function appendRecord(logPath, record) {
  const fd = fs.openSync(logPath, 'a', 0o600);
  try {
    writeAll(fd, Buffer.from(`${JSON.stringify(record)}\n`));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** The minimum gap between two events while the run is behind schedule. */
const CATCH_UP_GAP_MS = 1000;

/** A load event this far past its slot is skipped and recorded, not run. */
const STALE_LOAD_MS = 60 * 1000;

/** The longest a stop request waits while the driver is waiting for a slot. */
const STOP_POLL_MS = 1000;

/**
 * Run a schedule to its end, or until `shouldStop` says to stop.
 *
 * On time, every event runs at its slot. Behind schedule, for example after
 * the driver was down, three rules apply, and each record says which:
 * - A load event more than `staleLoadMs` past its slot is skipped and logged
 *   (`skipped: true`, `SKIPPED_STALE`), never run late in a burst.
 * The two pacing rules (`paced`):
 * - A fault never starts within `faultQuietMs` of the previous fault's start,
 *   counting faults the log shows ran before an interruption. The schedule's
 *   quiet-window invariant therefore holds at run time, not only on paper.
 * - Overdue events run at least `catchUpGapMs` apart, never as one burst
 *   straight after whatever caused the delay.
 * `lateMs` records how far each event started after its slot.
 * @param {object} opts - Options
 * @param {object} opts.schedule - A schedule (see `lib/soak/schedule`)
 * @param {Object<string, Function>} opts.executors - Executors by kind
 * @param {object} opts.ctx - Passed to every executor (`{apiBase, token, fetch, timeoutMs}`), with the running event's `eventIndex` and the run's `runKey` added
 * @param {string} opts.logPath - The ndjson log to create or resume
 * @param {{now: () => number, sleep: (ms: number) => Promise<void>}} opts.clock - Wall clock, injectable for tests
 * @param {() => boolean} [opts.shouldStop] - Checked before each event
 * @param {number} [opts.catchUpGapMs] - Minimum gap between overdue events (default `CATCH_UP_GAP_MS`)
 * @param {number} [opts.staleLoadMs] - Lateness past which load is skipped (default `STALE_LOAD_MS`)
 * @param {number} [opts.stopPollMs] - Longest wait between stop checks (default `STOP_POLL_MS`)
 * @param {object} [opts.headerExtra] - Overrides this run segment ran under: written into a new log's header, or into a `resume` record on an existing log
 * @param {object} [opts.lockDeps] - Lock dependencies, injectable for tests (see `acquireLogLock`)
 * @param {object} [opts.segmentFs] - fs stand-in for closing the segment, for tests
 * @returns {Promise<{status: 'completed'|'completed-ownership-unverified'|'stopped'|'already-complete'|'already-complete-ownership-unverified', ran: number, resumedFrom: number, tornTail: boolean, skipped: number, ownershipUnverified: boolean}>} Result. A log with any ownership-unverified segment is never plain `completed` or `already-complete`.
 * @throws {DriverRefusal} When the run cannot start, or `LOCK_LOST`, `LOCK_LOST_UNRECORDED`, `OWNERSHIP_UNVERIFIED`, `SEGMENT_CLOSE_FAILED` or `LOCK_RELEASE_FAILED` when it could not end cleanly
 */
async function runSchedule(opts) {
  const { schedule, executors } = opts;
  const shouldStop = opts.shouldStop || (() => false);

  const violations = scheduleLib.validateSchedule(schedule);
  if (violations.length > 0) {
    throw new DriverRefusal(REFUSAL.INVALID_SCHEDULE, `schedule is invalid: ${violations.slice(0, 5).map((v) => v.code).join(', ')}`, { violations });
  }
  const missing = [...new Set(schedule.events.map((e) => e.kind))].filter((k) => typeof executors[k] !== 'function');
  if (missing.length > 0) {
    throw new DriverRefusal(REFUSAL.NO_EXECUTOR, `no executor for: ${missing.join(', ')}`, { kinds: missing });
  }

  // Refused before the lock is even taken: a log that lost its lock is never
  // resumed.
  checkLockLost(opts.logPath);
  const clock = opts.clock;
  const lockDeps = opts.lockDeps || {};
  let lock;
  try {
    lock = acquireLogLock(opts.logPath, lockDeps);
  } catch (err) { // prawduct:allow prawduct/broad-except -- inspected for one case below, then rethrown unchanged
    // A lock that cannot be read, or names no one, in front of an open segment
    // whose owner is dead: the segment's ownership is unreadable at recovery,
    // which is refused for good. Whether a later lock would read back as the
    // owner's is exactly what cannot be trusted.
    if (err instanceof DriverRefusal && err.code === REFUSAL.LOG_LOCKED && err.details.lockUnreadable) {
      const marker = readSegment(opts.logPath);
      if (marker && marker.state === 'active' && _ownerDead(marker.owner, lockDeps)) {
        throw _condemnSegment(opts.logPath, marker, null, `unreadable (${err.details.lockUnreadable})`, clock.now());
      }
    }
    throw err;
  }

  // Reconcile a segment left open by an earlier run before doing anything.
  // It may be resumed only when the old lock was still there and named
  // exactly the marker's owner, a dead process on this host (acquireLogLock
  // reclaims only such a lock). That is what an ordinary crash leaves. It is
  // also what a run leaves when it stopped because its lock became
  // unreadable and the lock later read back again, and the two cannot be told
  // apart here. So every such resume is recorded as ownership-unverified.
  let recoveredFrom = null;
  try {
    const marker = readSegment(opts.logPath);
    if (marker && marker.state === 'stopped-clean') {
      // A clean stop whose cleanup did not finish. Its binding was verified
      // above (the whole log is exactly as it was at the stop), so it may be
      // resumed whatever became of the lock.
      recoveredFrom = { owner: marker.owner, segmentStartedAt: marker.startedAt, state: 'stopped-clean' };
    } else if (marker) {
      const r = lock.reclaimed;
      if (!r || r.pid !== marker.owner.pid || r.host !== marker.owner.host) {
        const found = r ? `held by pid ${r.pid} on ${r.host} instead` : 'gone';
        // Only a provably dead owner's segment is condemned. An owner that
        // may be alive (or is on another host) may be a run finishing right
        // now, between releasing its lock and closing its segment.
        if (_ownerDead(marker.owner, lockDeps)) throw _condemnSegment(opts.logPath, marker, r, found, clock.now());
        throw new DriverRefusal(REFUSAL.LOG_SEGMENT_UNRECONCILED,
          `${opts.logPath} has a segment left open by pid ${marker.owner.pid} on ${marker.owner.host}, but its lock is ${found}; its lock may have been lost without a record. It is never resumed: start a new log, or reset it by hand after checking it`,
          { marker: segmentPath(opts.logPath), owner: marker.owner, lockFound: r, condemned: null, condemnError: null });
      }
      recoveredFrom = { owner: marker.owner, segmentStartedAt: marker.startedAt, state: OWNERSHIP_UNVERIFIED_STATE };
    }
    openSegment(opts.logPath, lock.expected, clock.now());
  } catch (err) { // prawduct:allow prawduct/broad-except -- the lock taken above is released on any failure here, then the error is rethrown unchanged
    // The refusal stays the headline; how the lock release went rides on it,
    // so a lock left behind here is reported, not silent.
    const rel = lock.release();
    if (rel.lost || rel.unverified || rel.releaseFailed) err.lockRelease = rel;
    throw err;
  }

  let result;
  let primary = null;
  let stoppedBy = null;
  const progress = { recoveryRecorded: false };
  try {
    result = await _runLocked({ ...opts, recoveredFrom, progress }, shouldStop, lock);
  } catch (err) { // prawduct:allow prawduct/broad-except -- held only to combine with the lock outcome below, then rethrown unchanged
    if (err instanceof OwnershipLost) stoppedBy = err.loss;
    else primary = err;
  }
  // The old marker was replaced when this segment opened. Until the log itself
  // durably records that this segment resumed with ownership unverified, the
  // lock and the new marker are the only trace of it. So a failure before
  // that record leaves both exactly as a crash would: nothing is released or
  // closed, and the next run can only resume through the same exact-owner
  // reclaim, which records the mark again.
  const recoveryPending = !!(recoveredFrom && recoveredFrom.state === OWNERSHIP_UNVERIFIED_STATE && !progress.recoveryRecorded);
  let released;
  if (stoppedBy && stoppedBy.kind === 'unverified') released = { lost: null, unverified: { why: stoppedBy.why, expected: lock.expected }, releaseFailed: null };
  else if (stoppedBy) released = { lost: { why: stoppedBy.why, holder: stoppedBy.holder }, unverified: null, releaseFailed: null };
  else if (recoveryPending) released = { lost: null, unverified: null, releaseFailed: null };
  else released = lock.release();
  // The segment closes only when every append of this segment is durable
  // (appendRecord fsyncs each one) and its exact owner released the lock. A
  // lost or unverified lock, or a lock still held but not removable, leaves
  // it open.
  let segmentCloseFailed = null;
  if (!released.lost && !released.unverified && !released.releaseFailed && !recoveryPending) {
    const closed = closeSegment(opts.logPath, opts.segmentFs);
    if (closed.cleanup !== 'done') {
      const code = closed.error.code || closed.error.message;
      // Nothing reconciles a leftover marker automatically: once its owner is
      // gone and the lock released, a later run refuses the log for good.
      segmentCloseFailed = closed.cleanup === 'unknown'
        ? { cleanup: 'unknown', marker: segmentPath(opts.logPath), why: `the segment marker was removed, but the removal could not be made durable (${code}), so whether ${segmentPath(opts.logPath)} survives a crash is unknown. If it is there, start a new log, or reset it by hand after checking the log` }
        : { cleanup: 'marker-remains', marker: segmentPath(opts.logPath), why: `the segment marker could not be removed (${code}). The log will not be reconciled automatically: start a new log, or reset it by hand (remove ${segmentPath(opts.logPath)}) after checking the log` };
    }
  }

  // A lost lock is recorded in the sidecar, never in the log.
  let lossReport = null;
  if (released.lost) {
    const loss = { expected: lock.expected, observed: released.lost.holder, why: released.lost.why, at: clock.now() };
    try {
      lossReport = { ...loss, sidecar: writeLockLostSidecar(opts.logPath, loss), unrecorded: false };
    } catch (err) { // prawduct:allow prawduct/broad-except -- a failed sidecar write is reported as LOCK_LOST_UNRECORDED, never swallowed
      lossReport = { ...loss, sidecar: null, unrecorded: true, sidecarError: String((err && (err.code || err.message)) || err) };
    }
  }
  // An unverified lock condemns nothing: it is left as it is, with the
  // segment open, and the log resumes only through an exact-owner reclaim,
  // which records the segment as ownership-unverified.
  const unverifiedReport = released.unverified
    ? { why: released.unverified.why, expected: lock.expected, at: clock.now(), marker: segmentPath(opts.logPath), lock: `${opts.logPath}.lock` }
    : null;

  if (primary) {
    // The run's own failure is the primary error and is never masked; the
    // lock outcome rides along on it.
    if (lossReport) primary.lockLost = lossReport;
    if (unverifiedReport) primary.ownershipUnverified = unverifiedReport;
    if (recoveryPending && !lossReport && !unverifiedReport) {
      primary.recoveryPending = {
        why: `the resumed segment's ownership-unverified recovery was not yet recorded in the log, so ${opts.logPath}.lock and ${segmentPath(opts.logPath)} are left as a crash would leave them. Once this process has exited, the next run resumes it again, recorded as ownership-unverified`,
        lock: `${opts.logPath}.lock`,
        marker: segmentPath(opts.logPath),
        owner: lock.expected
      };
    }
    if (released.releaseFailed) primary.lockReleaseFailed = released.releaseFailed;
    if (segmentCloseFailed) primary.segmentCloseFailed = segmentCloseFailed;
    throw primary;
  }
  if (lossReport) {
    const code = lossReport.unrecorded ? REFUSAL.LOCK_LOST_UNRECORDED : REFUSAL.LOCK_LOST;
    const where = lossReport.unrecorded ? `and the lock-lost sidecar could not be written (${lossReport.sidecarError}); do not use this log` : `recorded in ${lossReport.sidecar}; the log will be refused from now on`;
    throw new DriverRefusal(code, `the log lock was lost during the run (${lossReport.why}); nothing further was written to the log, ${where}`, { ...lossReport, result: result || null });
  }
  if (unverifiedReport) {
    throw new DriverRefusal(REFUSAL.OWNERSHIP_UNVERIFIED,
      `the log lock could not be verified (${unverifiedReport.why}); the run stopped and nothing further was written to the log. The lock and the open segment are left as they are. The log can be resumed only once ${unverifiedReport.lock} again names pid ${lock.expected.pid} on ${lock.expected.host}, after that process has exited, and every resumed segment is then recorded as ownership-unverified, which is not an automatic certification pass`,
      { ...unverifiedReport, result: result || null });
  }
  if (segmentCloseFailed) {
    throw new DriverRefusal(REFUSAL.SEGMENT_CLOSE_FAILED, `the run finished and its log is intact, but ${segmentCloseFailed.why}`, { ...segmentCloseFailed, result });
  }
  if (released.releaseFailed) {
    throw new DriverRefusal(REFUSAL.LOCK_RELEASE_FAILED, `the run finished and its log is intact, but its lock could not be released: ${released.releaseFailed.why}`, { ...released.releaseFailed, result });
  }
  return result;
}

/**
 * Raised inside a run the moment the lock is found not to be ours. It stops
 * the run before anything else is written to the log.
 */
class OwnershipLost extends Error {
  /**
   * @param {{kind: string, why: string, holder: object|null}} loss - What the ownership check found
   */
  constructor(loss) {
    super(`log lock lost: ${loss.why}`);
    this.name = 'OwnershipLost';
    this.loss = loss;
  }
}

/**
 * The body of `runSchedule`, run while holding the log lock.
 * @param {object} opts - As for `runSchedule`
 * @param {() => boolean} shouldStop - Stop check
 * @param {object} lock - The held lock, from `acquireLogLock`
 * @returns {Promise<object>} As for `runSchedule`
 * @throws {OwnershipLost} The moment the lock is found not to be ours
 */
async function _runLocked(opts, shouldStop, lock) {
  const { schedule, executors, ctx, logPath, clock } = opts;
  const reclaimed = lock.reclaimed;
  // Every write to the log, and every executor event, happens only while the
  // lock is verifiably ours. The check runs immediately before each append,
  // so the one before `end` is exact, and before each event, so no load runs
  // for a log we no longer hold.
  const assertOwned = () => {
    const own = lock.owned();
    if (!own.ok) throw new OwnershipLost(own);
  };
  const append = (record) => {
    assertOwned();
    appendRecord(logPath, record);
  };
  const catchUpGapMs = opts.catchUpGapMs === undefined ? CATCH_UP_GAP_MS : opts.catchUpGapMs;
  const staleLoadMs = opts.staleLoadMs === undefined ? STALE_LOAD_MS : opts.staleLoadMs;
  const stopPollMs = opts.stopPollMs === undefined ? STOP_POLL_MS : opts.stopPollMs;
  // Read through the normalizer, never straight from the file, so the value
  // used at run time is the value validation checked.
  const faultQuietMs = scheduleLib.normalizeParams(schedule.params).faultQuietMs;
  const log = readLog(logPath, { segmentOwner: lock.expected });
  if (log.header && log.header.scheduleDigest !== schedule.digest) {
    throw new DriverRefusal(REFUSAL.LOG_MISMATCH, `${logPath} belongs to schedule ${log.header.scheduleDigest}, not ${schedule.digest}`);
  }
  // A log with any ownership-unverified segment, including the one this run
  // is about to record, never gets a clean completed status.
  const ownershipUnverified = !log.ownership.verified || !!(opts.recoveredFrom && opts.recoveredFrom.state === OWNERSHIP_UNVERIFIED_STATE);
  const finished = (status) => (ownershipUnverified ? `${status}-ownership-unverified` : status);
  if (log.ended) {
    // The log is complete, but a recovery still happened: it is recorded, so
    // the evidence shows it, before anything reports on the log.
    if (opts.recoveredFrom) {
      append({ ...(opts.headerExtra || {}), type: 'resume', at: clock.now(), resumedFrom: log.lastIndex + 1, recoveredFrom: opts.recoveredFrom });
      if (opts.progress) opts.progress.recoveryRecorded = true;
      if (reclaimed) append({ type: 'lock-reclaimed', at: clock.now(), holder: reclaimed });
    }
    return { status: finished('already-complete'), ran: 0, resumedFrom: log.lastIndex + 1, tornTail: log.tornTail, skipped: 0, recoveredFrom: opts.recoveredFrom || null, ownershipUnverified };
  }
  if (log.finishSeal) {
    assertOwned();
    appendRaw(logPath, '\n');
  }
  if (log.torn) {
    assertOwned();
    sealTornTail(logPath, log.torn, clock.now());
  }

  // Each run segment records the overrides it ran under. A fresh log carries
  // them in its header. A resumed log gets a `resume` record, because an
  // override passed only on a later segment must leave a trace too, and the
  // header is written once. The fixed fields go last, so no override key can
  // overwrite them.
  let startEpochMs;
  if (log.header) {
    startEpochMs = log.header.startEpochMs;
    append({ ...(opts.headerExtra || {}), type: 'resume', at: clock.now(), resumedFrom: log.lastIndex + 1, recoveredFrom: opts.recoveredFrom || null });
  } else {
    startEpochMs = clock.now();
    append({ ...(opts.headerExtra || {}), type: 'header', schema: LOG_SCHEMA, scheduleDigest: schedule.digest, phase: schedule.params.phase, seed: schedule.params.seed, startEpochMs, recoveredFrom: opts.recoveredFrom || null });
  }
  const runKey = `${schedule.digest.slice(0, 16)}-${startEpochMs}`;
  // appendRecord fsyncs, so the recovery is now durably in the log.
  if (opts.progress) opts.progress.recoveryRecorded = true;
  if (reclaimed) append({ type: 'lock-reclaimed', at: clock.now(), holder: reclaimed });

  const resumedFrom = log.lastIndex + 1;
  // A graceful stop, committed under exact ownership: the stop record is
  // appended and fsynced, then the marker becomes stopped-clean, bound to
  // the log as it now stands. A loss found before either step writes neither.
  const stopCleanly = (ran, skipped) => {
    append({ type: 'stop', at: clock.now(), lastIndex: resumedFrom + ran + skipped - 1 });
    assertOwned();
    stopSegment(logPath, readSegment(logPath), clock.now());
    return { status: 'stopped', ran, resumedFrom, tornTail: log.tornTail, skipped, ownershipUnverified };
  };
  let lastStartedAt = log.lastStartedAt;
  let lastFaultStartedAt = log.lastFaultStartedAt;
  let ran = 0;
  let skipped = 0;
  for (const event of schedule.events.slice(resumedFrom)) {
    if (shouldStop()) return stopCleanly(ran, skipped);
    const due = startEpochMs + event.atMs;
    // Load that is already stale is recorded as skipped, not run: a backlog
    // replayed after an outage is not the load the schedule described, and
    // running it would only hammer a server that has just recovered. Faults
    // are never skipped. They are deferred, below.
    if (event.class !== 'fault' && clock.now() - due > staleLoadMs) {
      append({ type: 'event', index: event.index, kind: event.kind, scheduledAt: due, startedAt: null, lateMs: clock.now() - due, paced: null, skipped: true, ok: null, code: 'SKIPPED_STALE' });
      skipped++;
      continue;
    }
    let startAt = due;
    let paced = null;
    if (event.class === 'fault' && lastFaultStartedAt !== null && lastFaultStartedAt + faultQuietMs > startAt) {
      startAt = lastFaultStartedAt + faultQuietMs;
      paced = 'quiet-window';
    }
    if (clock.now() > due && lastStartedAt !== null && lastStartedAt + catchUpGapMs > startAt) {
      startAt = lastStartedAt + catchUpGapMs;
      paced = paced || 'catch-up';
    }
    // Wait in short slices, so a stop is honoured within a slice, not after
    // a deferred fault's whole quiet window.
    while (clock.now() < startAt) {
      if (shouldStop()) return stopCleanly(ran, skipped);
      await clock.sleep(Math.min(stopPollMs, startAt - clock.now()));
    }
    if (shouldStop()) return stopCleanly(ran, skipped);
    assertOwned();
    const startedAt = clock.now();
    let outcome;
    try {
      // Each executor also learns which event it is running, and in which
      // run, so anything it sends can be traced back to the schedule. The run
      // key (the schedule digest and the log's start time) is the same on a
      // resume and different for any other run against the same target, so
      // ids built from it never collide with another run's.
      outcome = await executors[event.kind]({ ...ctx, eventIndex: event.index, runKey }, event.params);
    } catch (err) { // prawduct:allow prawduct/broad-except -- a supervisor loop: one faulty executor must not end a 72-hour run
      // Executors resolve to outcomes by contract; one that throws is a bug in
      // the executor, recorded as such so the soak keeps its remaining load.
      outcome = { ok: false, code: 'EXECUTOR_THREW', status: null, error: String(err && err.message) };
    }
    // The outcome goes first, so no key an executor returns can overwrite the
    // fields resume depends on (type, index, kind, startedAt).
    append({
      ...outcome,
      type: 'event',
      index: event.index,
      kind: event.kind,
      scheduledAt: due,
      startedAt,
      lateMs: Math.max(0, startedAt - due),
      paced,
      durationMs: clock.now() - startedAt
    });
    lastStartedAt = startedAt;
    if (event.class === 'fault') lastFaultStartedAt = startedAt;
    ran++;
  }
  append({ type: 'end', completedAt: clock.now(), events: schedule.events.length });
  return { status: finished('completed'), ran, resumedFrom, tornTail: log.tornTail, skipped, ownershipUnverified };
}

module.exports = { OWNERSHIP_UNVERIFIED_STATE, acceptanceMatches, closeSegment, writeAll, SEGMENT_SCHEMA, segmentPath, openSegment, stopSegment, readSegment, LOCK_LOST_SCHEMA, lockLostPath, writeLockLostSidecar, checkLockLost, LOG_SCHEMA, REFUSAL, CATCH_UP_GAP_MS, STALE_LOAD_MS, STOP_POLL_MS, DriverRefusal, acquireLogLock, requireGuardContext, sealTornTail, localNames, canonicalHost, refuseLiveTarget, refuseLiveAddress, refuseSameInstall, readLog, appendRecord, runSchedule };
