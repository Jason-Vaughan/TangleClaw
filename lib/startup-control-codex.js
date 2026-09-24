'use strict';

/**
 * The Codex startupControl adapter (#1825): TangleClaw's side of
 * Codex's app-server protocol, behind the generic adapter contract in
 * `docs/engine-guide.md` ("startupControl"). Nothing outside this module
 * knows about sockets, threads, turns or the app-server: the generic channel
 * row carries only a lifecycle header, and everything Codex-specific lives in
 * its `adapterState`, which only this module reads or writes.
 *
 * What it owns, per launch:
 * - a `codex app-server --listen unix://…` process, spawned DETACHED in its
 *   own process group before the pane exists, so a TangleClaw restart does not
 *   sever the pane's server; recorded with its birth identity so a reused pid
 *   can never be signalled by mistake;
 * - the pane's command, `codex --remote unix://<resolved> <launch-mode args>`,
 *   with the already-validated argv kept verbatim after `--remote`;
 * - readiness, all read from the protocol (never from the pane): the server's
 *   version against the installed and the recorded one, the project's trust in
 *   Codex's own config, the account, the quota, exactly one thread for the
 *   project directory (the recorded one once seen), and its idle status; an
 *   unknown answer fails closed with a typed reason, never as ready;
 * - the fire: `turn/start` carrying the launch-start payload digest as
 *   `clientUserMessageId`; the engine echoes it on the user item, and the item's
 *   content must hash to the prompt's text digest, so a receipt is bound by the
 *   engine to this launch AND to these bytes;
 * - the receipt transitions, driven by the engine's notifications and by
 *   read-backs of the engine's own turn record; recovery of every in-flight
 *   fire after a TangleClaw restart, without resending anything.
 *
 * Measured against codex-cli 0.156.1 (the spike, and the six probes recorded
 * in the plan). The fact that shapes the fire path: a fresh thread cannot be
 * subscribed to or listed before its first user message, so the subscription
 * and the read-back FOLLOW the `turn/start` response.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFile, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const store = require('./store');
const { WsUnixClient } = require('./ws-unix-client');
const { createLogger } = require('./logger');

const log = createLogger('startup-control-codex');

/** The adapter's registered name; a profile's `adapter` field names it. */
const NAME = 'codex';

/** Where per-launch sockets are requested, under the store's base path. */
const RUN_DIRNAME = path.join('run', 'startup-control');

/** How long a launch waits for the app-server's socket to appear. */
const SOCKET_WAIT_MS = 5000;

/** How long one protocol request may take before it counts as unanswered. */
const CALL_TIMEOUT_MS = 15000;

/** How long `turn/start` may take to answer before the send is indeterminate. */
const TURN_START_TIMEOUT_MS = 30000;

/** How long the version probe may run. */
const VERSION_PROBE_TIMEOUT_MS = 5000;

/** How often the reaper looks for channels whose session has ended. */
const REAP_INTERVAL_MS = 5 * 60 * 1000;

/** Reconnect attempts while watching an accepted fire, and the pause between them. */
const WATCH_RECONNECTS = 5;
const WATCH_RECONNECT_PAUSE_MS = 2000;

/**
 * How often an accepted fire re-reads the engine's turn record while it
 * waits for the turn to end. Measured live (2026-09-24, codex-cli 0.156.1):
 * `thread/resume` on a freshly materialized thread can fail with
 * `list_turns is not supported yet`, so a subscription is not guaranteed and
 * the record is the evidence that always answers.
 */
const WATCH_POLL_MS = 5000;

/** How long a thread must stay idle before an absent turn means "never sent": one instantaneous absence is not proof. */
const STABLE_IDLE_MS = 1500;

/** Most turn pages a reconcile reads before calling the thread unreadable. */
const MAX_TURN_PAGES = 200;

/** The characters a resolved socket path may contain before it is placed in a shell command. */
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;

/** The client TangleClaw announces itself as. */
const CLIENT_INFO = Object.freeze({ name: 'tangleclaw', title: 'TangleClaw', version: _tangleclawVersion() });

/**
 * Every effect this module has on the machine, behind one object so a test
 * can replace them all and so no test can start a real app-server, signal a
 * real process or run a real `codex --version` by accident. Production uses
 * the real implementations.
 * @type {object}
 */
const _seams = {
  spawn,
  execFile,
  execFileSync,
  /**
   * The command line of a process, or '' when it cannot be read.
   * @param {number} pid - Process id.
   * @returns {string}
   */
  psCommand: (pid) => _ps(pid, 'command='),
  /**
   * The birth identity of a process (its start time as `ps` prints it), or ''.
   * @param {number} pid - Process id.
   * @returns {string}
   */
  psBirth: (pid) => _ps(pid, 'lstart=').trim(),
  kill: (pid, signal) => process.kill(pid, signal),
  resolveSocket: (requested) => _resolveSocket(requested),
  sleep: (ms) => _sleepSync(ms),
  ClientClass: WsUnixClient,
  now: () => Date.now()
};

/**
 * One `ps` column for a pid.
 * @param {number} pid - Process id.
 * @param {string} column - A `ps -o` spec.
 * @returns {string}
 */
function _ps(pid, column) {
  try {
    return execFileSync('ps', ['-o', column, '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/**
 * TangleClaw's own version, for `initialize`'s clientInfo.
 * @returns {string}
 */
function _tangleclawVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * SHA-256 of a string, hex.
 * @param {string} text - Input.
 * @returns {string}
 */
function _sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The cached installed version. `installedVersion()` reads it and never
 * spawns; the probes fill it. A failed probe EMPTIES it: a stale value is
 * never reused.
 * @type {{version: (string|null), enginePath: (string|null), probedAt: (string|null), error: (string|null)}}
 */
const _version = { version: null, enginePath: null, probedAt: null, error: null };

/**
 * Parse `codex --version` output.
 * @param {string} text - Command output.
 * @returns {string|null}
 */
function _parseVersion(text) {
  const m = /codex-cli\s+(\d+\.\d+\.\d+)/.exec(String(text || ''));
  return m ? m[1] : null;
}

/**
 * The installed codex-cli version, from the last probe. Synchronous and
 * cached: this runs on request paths (`tc capabilities`, the fire route).
 * @returns {string|null}
 */
function installedVersion() {
  return _version.version;
}

/**
 * Probe the engine's version without blocking, and cache the answer.
 * @param {object} [deps] - Seams: `execFile`, `enginePath`.
 * @returns {Promise<string|null>}
 */
function probeVersion(deps = {}) {
  const run = deps.execFile || _seams.execFile;
  const bin = deps.enginePath || _version.enginePath || 'codex';
  return new Promise((resolve) => {
    run(bin, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS }, (err, stdout) => {
      _recordProbe(err, stdout, bin);
      resolve(_version.version);
    });
  });
}

/**
 * Probe the exact engine executable a launch will run, synchronously and
 * bounded, and cache the answer. Used on the launch path only, which is
 * an operator action that already spawns.
 * @param {object} [deps] - Seams: `execFileSync`, `enginePath`.
 * @returns {string|null}
 */
function probeVersionSync(deps = {}) {
  const run = deps.execFileSync || _seams.execFileSync;
  const bin = deps.enginePath || 'codex';
  try {
    const out = run(bin, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    _recordProbe(null, out, bin);
  } catch (err) {
    _recordProbe(err, '', bin);
  }
  return _version.version;
}

/**
 * Record a probe's result.
 * @param {Error|null} err - Probe error.
 * @param {string} stdout - Probe output.
 * @param {string} bin - The executable probed.
 * @returns {void}
 */
function _recordProbe(err, stdout, bin) {
  _version.probedAt = new Date().toISOString();
  _version.enginePath = bin;
  if (err) {
    _version.version = null;
    _version.error = err.message;
    log.warn('codex --version failed; the startupControl channel resolves to unsupported', { bin, error: err.message });
    return;
  }
  _version.version = _parseVersion(stdout);
  _version.error = _version.version ? null : `unrecognised output: ${String(stdout).trim().slice(0, 80)}`;
  if (!_version.version) log.warn('codex --version output not understood', { bin, output: String(stdout).trim().slice(0, 80) });
}

/**
 * Synchronous sleep without a busy loop.
 * @param {number} ms - Milliseconds.
 * @returns {void}
 */
function _sleepSync(ms) {
  spawnSync('sleep', [String(ms / 1000)], { timeout: ms + 1000 });
}

/**
 * The directory sockets are requested in, created on first use.
 * @returns {string}
 */
function _runDir() {
  const dir = path.join(store._getBasePath(), RUN_DIRNAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Resolve the socket Codex actually bound. `--listen unix://<long path>`
 * binds a short path under `/private/tmp/codex-daemon-<uid>/` and leaves a
 * symlink at the requested one; the TUI must be handed the short path.
 * @param {string} requested - The requested socket path.
 * @returns {string|null} The bound path, or null when nothing is there yet.
 */
function _resolveSocket(requested) {
  try {
    const st = fs.lstatSync(requested);
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(requested);
      const resolved = path.isAbsolute(target) ? target : path.join(path.dirname(requested), target);
      return fs.existsSync(resolved) ? resolved : null;
    }
    return st.isSocket() ? requested : null;
  } catch {
    return null;
  }
}

/**
 * The canonical identity of a directory: its real path when it exists, else
 * its resolved form. Two spellings of one directory compare equal.
 * @param {string} p - A path.
 * @returns {string}
 */
function _canonicalDir(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Start the per-launch app-server and build the pane's command.
 *
 * Synchronous, because `launchSession` is. A failure here never fails the
 * launch; the caller launches today's command and records the reason as
 * `channel_unavailable`.
 *
 * @param {object} input
 * @param {object} input.project - The project (its `path` is the thread's cwd).
 * @param {object} input.engineProfile - The resolved engine profile.
 * @param {string} input.launchCmd - The command `_buildLaunchCommand` produced (already validated argv).
 * @param {string|null} [input.enginePath] - The exact engine executable this launch runs.
 * @param {object} [deps] - Seams.
 * @returns {{ok: true, handle: object, command: string} | {ok: false, reasonCode: string, reason: string}}
 */
function prepareLaunch(input, deps = {}) {
  const spawnFn = deps.spawn || _seams.spawn;
  const resolveSocket = deps.resolveSocket || _seams.resolveSocket;
  const sleep = deps.sleep || _seams.sleep;
  const unavailable = (reason) => ({ ok: false, reasonCode: 'channel_unavailable', reason });
  const version = (deps.probeVersionSync || probeVersionSync)({ enginePath: input.enginePath || undefined });
  if (!version) return unavailable('the engine version could not be probed for this launch');
  const shell = input.engineProfile && input.engineProfile.launch ? input.engineProfile.launch.shellCommand : null;
  if (!shell || typeof input.launchCmd !== 'string' || !(input.launchCmd === shell || input.launchCmd.startsWith(`${shell} `))) {
    return unavailable('the launch command does not start with the engine binary, so --remote cannot be placed');
  }
  let requested;
  try {
    requested = path.join(_runDir(), `${crypto.randomBytes(8).toString('hex')}.sock`);
  } catch (err) {
    return unavailable(`no run directory for the socket: ${err.message}`);
  }
  const bin = input.enginePath || shell;
  let child;
  try {
    child = spawnFn(bin, ['app-server', '--listen', `unix://${requested}`], {
      cwd: input.project.path,
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.unref();
  } catch (err) {
    return unavailable(`could not start the app-server: ${err.message}`);
  }
  if (!child || !child.pid) return unavailable('the app-server did not start');
  const birth = (deps.psBirth || _seams.psBirth)(child.pid);
  let resolved = null;
  const deadline = (deps.now || _seams.now)() + SOCKET_WAIT_MS;
  while (!resolved && (deps.now || _seams.now)() < deadline) {
    resolved = resolveSocket(requested);
    if (!resolved) sleep(100);
  }
  const state = { pid: child.pid, birth, socketPath: requested, resolvedSocketPath: resolved, engineVersion: version, enginePath: bin, threadId: null, serverVersion: null };
  if (!resolved) {
    _terminate(state, deps);
    return unavailable(`the app-server did not open its socket within ${SOCKET_WAIT_MS}ms`);
  }
  if (!SAFE_PATH.test(resolved)) {
    _terminate(state, deps);
    return unavailable('the resolved socket path contains characters that cannot be placed in the pane command');
  }
  const rest = input.launchCmd.slice(shell.length);
  const command = `${shell} --remote unix://${resolved}${rest}`;
  log.info('startupControl channel started for a launch', { project: input.project.name, pid: child.pid });
  return { ok: true, handle: { state, command }, command };
}

/**
 * Record a started channel against the session it now belongs to.
 * @param {object} handle - From `prepareLaunch`.
 * @param {{sessionId: number, sequenceId: number, engineId: string}} launch - The bound launch.
 * @returns {object|null} The channel row, or null when it could not be recorded (the channel is then stopped).
 */
function attachLaunch(handle, launch) {
  try {
    return store.startupControlChannels.open({
      sessionId: launch.sessionId,
      sequenceId: launch.sequenceId,
      engineId: launch.engineId,
      adapter: NAME,
      adapterState: handle.state
    });
  } catch (err) {
    log.warn('Could not record the startupControl channel; stopping it', { session: launch.sessionId, error: err.message });
    abandonLaunch(handle, 'channel row not recorded');
    return null;
  }
}

/**
 * Stop a channel that never got a session.
 * @param {object} handle - From `prepareLaunch`.
 * @param {string} reason - Why.
 * @returns {void}
 */
function abandonLaunch(handle, reason) {
  log.info('startupControl channel abandoned', { pid: handle.state.pid, reason });
  _terminate(handle.state);
}

/**
 * Whether `state` still names the app-server this adapter started: the same
 * command line (app-server on this socket) AND the same birth identity, so a
 * pid reused by an unrelated process is never ours.
 * @param {object} state - Adapter state.
 * @param {object} [deps] - Seams: `psCommand`, `psBirth`.
 * @returns {boolean}
 */
function _isOurAppServer(state, deps = {}) {
  if (!state || !Number.isInteger(state.pid) || state.pid <= 0) return false;
  const command = (deps.psCommand || _seams.psCommand)(state.pid);
  if (!command.includes('app-server') || !command.includes(state.socketPath)) return false;
  if (state.birth) {
    const birth = (deps.psBirth || _seams.psBirth)(state.pid);
    if (birth !== state.birth) return false;
  }
  return true;
}

/**
 * Terminate an app-server we started (its whole process group, since it was
 * spawned detached as a group leader), and remove its socket link. Never
 * signals a pid that is not ours, and reports what it did.
 * @param {object} state - Adapter state.
 * @param {object} [deps] - Seams.
 * @returns {{signalled: boolean, teardown: string}} `teardown` is 'ok', 'skipped' or the error.
 */
function _terminate(state, deps = {}) {
  let result = { signalled: false, teardown: 'skipped' };
  if (_isOurAppServer(state, deps)) {
    const kill = deps.kill || _seams.kill;
    try {
      try {
        kill(-state.pid, 'SIGTERM');
      } catch (groupErr) {
        if (groupErr.code === 'ESRCH') throw groupErr;
        kill(state.pid, 'SIGTERM');
      }
      result = { signalled: true, teardown: 'ok' };
    } catch (err) {
      result = err.code === 'ESRCH'
        ? { signalled: false, teardown: 'skipped' }
        : { signalled: false, teardown: `signal failed: ${err.message}` };
      if (err.code !== 'ESRCH') log.warn('Could not signal the app-server', { pid: state.pid, error: err.message });
    }
  }
  if (state && state.socketPath) {
    try { fs.unlinkSync(state.socketPath); } catch { /* already gone */ }
  }
  return result;
}

/**
 * End the channel of a session that has ended (killed, wrapped to an end,
 * crashed, or replaced by a new launch). Idempotent; a session with no
 * channel is a no-op.
 * @param {number} sessionId - Session id.
 * @param {string} reason - Why.
 * @param {object} [deps] - Seams.
 * @returns {object|null} The closed channel row, if there was one.
 */
function releaseSession(sessionId, reason, deps = {}) {
  let channel;
  try {
    channel = store.startupControlChannels.getOpenBySession(sessionId);
  } catch (err) {
    log.warn('Could not read the session\'s startupControl channel', { session: sessionId, error: err.message });
    return null;
  }
  if (!channel || channel.adapter !== NAME) return null;
  const result = _terminate(channel.adapterState, deps);
  const closed = store.startupControlChannels.close(channel.id, reason, result.teardown);
  log.info('startupControl channel closed', { session: sessionId, channel: channel.id, reason, teardown: result.teardown });
  return closed;
}

/**
 * Close every open channel whose session is no longer active. Runs at boot
 * (after recovery) and on an interval.
 * @param {object} [deps] - Seams.
 * @returns {{examined: number, closed: number}}
 */
function reap(deps = {}) {
  let examined = 0;
  let closed = 0;
  let channels;
  try {
    channels = store.startupControlChannels.listOpen();
  } catch (err) {
    log.warn('startupControl reaper could not list channels', { error: err.message });
    return { examined, closed };
  }
  for (const channel of channels) {
    if (channel.adapter !== NAME) continue;
    examined += 1;
    let session = null;
    try {
      session = store.sessions.get(channel.sessionId);
    } catch (err) {
      // Unknown is not ended: a read that failed says nothing about the pane,
      // and signalling its server on that basis could sever a live session.
      log.warn('startupControl reaper could not read a channel\'s session; leaving it', { channel: channel.id, error: err.message });
      continue;
    }
    if (session && session.status === store.SESSION_STATUS.ACTIVE) continue;
    const result = _terminate(channel.adapterState, deps);
    store.startupControlChannels.close(channel.id, session ? `session ${session.status}` : 'session row missing', result.teardown);
    closed += 1;
  }
  if (closed > 0) log.info('startupControl reaper closed channels of ended sessions', { closed });
  return { examined, closed };
}

/**
 * After a TangleClaw restart: revalidate every open channel of an active
 * session (its server must answer and report the version the channel was
 * recorded with), then recover every in-flight fire without resending: a
 * resend could deliver the prompt twice. A channel that does not answer is closed as lost; its fires are
 * settled as far as the evidence allows and otherwise left indeterminate.
 * @param {object} [deps] - Seams.
 * @returns {Promise<{channels: number, lost: number, fires: number}>}
 */
async function recover(deps = {}) {
  const out = { channels: 0, lost: 0, fires: 0 };
  const applyTransition = deps.applyTransition || _storeTransition;
  let channels = [];
  let fires = [];
  try {
    // Both snapshots are taken before the first await: a fire that begins
    // while the channels are being revalidated belongs to the running server,
    // not to the restart, and must never be judged here.
    channels = store.startupControlChannels.listOpen().filter((c) => c.adapter === NAME);
    fires = store.startupPrompts.listActiveFires();
  } catch (err) {
    log.warn('startupControl recovery could not list channels or fires', { error: err.message });
    return out;
  }
  const live = new Map();
  for (const channel of channels) {
    let session = null;
    try { session = store.sessions.get(channel.sessionId); } catch { session = null; }
    if (!session || session.status !== store.SESSION_STATUS.ACTIVE) continue;
    out.channels += 1;
    const opened = await _connect(channel, deps);
    if (opened.blocker) {
      out.lost += 1;
      const result = _terminate(channel.adapterState, deps);
      store.startupControlChannels.close(channel.id, `not answering after restart: ${opened.blocker.reason}`, result.teardown);
      continue;
    }
    const serverVersion = _serverVersion(opened.conn.initResult);
    opened.conn.close();
    if (channel.adapterState.serverVersion && serverVersion !== channel.adapterState.serverVersion) {
      out.lost += 1;
      const result = _terminate(channel.adapterState, deps);
      store.startupControlChannels.close(channel.id, `server version changed after restart (${serverVersion})`, result.teardown);
      continue;
    }
    live.set(channel.sessionId, channel);
  }
  for (const fire of fires) {
    let session = null;
    try { session = store.sessions.get(fire.sessionId); } catch { session = null; }
    if (!session || session.engineId !== NAME) continue;
    out.fires += 1;
    const onUpdate = (patch) => applyTransition(fire.id, patch);
    if (fire.outcome === 'pending' && !fire.dispatchedAt) {
      onUpdate({ outcome: 'failed', reasonCode: 'restart_before_dispatch', reason: 'TangleClaw restarted before this fire was dispatched; nothing was sent, and it may be fired again' });
      continue;
    }
    if (fire.outcome === 'pending' || fire.outcome === 'dispatching') {
      onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: 'TangleClaw restarted after the send began and before the engine answered; never retried automatically' });
    }
    if (!live.has(fire.sessionId)) {
      onUpdate({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: 'the channel did not survive the restart, so the turn cannot be followed; relaunch the session' });
      continue;
    }
    const current = store.startupPrompts.getFireById(fire.id);
    try {
      if (current.outcome === 'accepted') {
        _resumeWatch({ session, fire: current, onUpdate }, deps);
      } else {
        await reconcile({ session, fire: current, onUpdate }, deps);
      }
    } catch (err) {
      log.warn('Could not recover a fire after restart', { fire: fire.id, error: err.message });
    }
  }
  return out;
}

let _reapTimer = null;

/**
 * Apply a fire transition straight to the store. The fallback for a caller
 * that supplies no `applyTransition`; the server supplies the service's, so
 * every transition is also logged to the activity log by one writer.
 * @param {number} fireId - Fire row id.
 * @param {object} patch - Transition.
 * @returns {object} The row.
 */
function _storeTransition(fireId, patch) {
  const r = store.startupPrompts.updateFire(fireId, patch);
  return r.fire || store.startupPrompts.getFireById(fireId);
}

/**
 * Boot: probe the version, recover channels and fires, then start the reaper.
 * @param {object} [opts]
 * @param {(fireId: number, patch: object) => object} [opts.applyTransition] - The one writer of fire transitions.
 * @returns {Promise<void>}
 */
async function start(opts = {}) {
  await probeVersion().catch(() => null);
  try { await recover({ applyTransition: opts.applyTransition }); } catch (err) { log.warn('startupControl recovery failed at boot', { error: err.message }); }
  try { reap(); } catch (err) { log.warn('startupControl reaper failed at boot', { error: err.message }); }
  if (!_reapTimer) {
    _reapTimer = setInterval(() => {
      try { reap(); } catch (err) { log.warn('startupControl reaper failed', { error: err.message }); }
    }, REAP_INTERVAL_MS);
    _reapTimer.unref();
  }
}

/**
 * Stop the reaper (tests and shutdown).
 * @returns {void}
 */
function stop() {
  if (_reapTimer) clearInterval(_reapTimer);
  _reapTimer = null;
}

/**
 * One connection to an app-server: the JSON-RPC layer over the WebSocket.
 * Requests get numeric ids and time out; notifications and server requests
 * are emitted as `notification` (`{method, params}`) and `serverRequest`.
 * Server requests (approvals, user input) are never answered by TangleClaw.
 */
class AppServerConnection extends EventEmitter {
  /**
   * @param {string} socketPath - The resolved socket.
   * @param {object} [deps] - Seams: `ClientClass`.
   */
  constructor(socketPath, deps = {}) {
    super();
    this.socketPath = socketPath;
    const ClientClass = deps.ClientClass || _seams.ClientClass;
    this.client = new ClientClass(socketPath);
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.client.on('message', (text) => this._onMessage(text));
    this.client.on('close', (info) => this._onClose(info));
    // A socket error or protocol fault is handled HERE: logged, remembered, and
    // turned into a close (the client destroys itself on a fault; a plain
    // socket error is destroyed here). It is re-emitted only to a listener that
    // asked for it, because an 'error' event with no listener throws out of the
    // socket handler and would leave a watcher polling a dead socket forever.
    this.client.on('error', (err) => this._fault(err));
  }

  /**
   * Record a socket or protocol fault, tell a listener that asked, and drop
   * the connection so its `closed` event drives the recovery.
   * @param {Error} err - The fault.
   * @returns {void}
   */
  _fault(err) {
    this.lastError = err;
    log.warn('app-server connection fault', { socket: this.socketPath, error: err.message });
    if (this.listenerCount('error') > 0) this.emit('error', err);
    if (!this.closed) this.client.destroy();
  }

  /**
   * Dial and run the initialize handshake.
   * @returns {Promise<object>} The `initialize` result.
   */
  async open() {
    await this.client.connect();
    const result = await this.call('initialize', { clientInfo: CLIENT_INFO });
    this.notify('initialized', {});
    return result;
  }

  /**
   * Send a request and await its result.
   * @param {string} method - Method name.
   * @param {object} params - Params.
   * @param {number} [timeoutMs=CALL_TIMEOUT_MS] - Deadline.
   * @returns {Promise<object>} The result; rejects with `{code, message}` on an error response.
   */
  call(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(Object.assign(new Error('connection closed'), { code: 'CLOSED' }));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} unanswered after ${timeoutMs}ms`), { code: 'TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.client.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Object.assign(err, { code: err.code || 'CLOSED' }));
      }
    });
  }

  /**
   * Send a notification.
   * @param {string} method - Method name.
   * @param {object} params - Params.
   * @returns {void}
   */
  notify(method, params) {
    this.client.send(JSON.stringify({ method, params }));
  }

  /**
   * Route one inbound message.
   * @param {string} text - JSON text.
   * @returns {void}
   */
  _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this._fault(new Error('app-server sent a message that is not JSON'));
      return;
    }
    if (msg && msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(Object.assign(new Error(msg.error.message || 'app-server error'), { code: msg.error.code, data: msg.error.data }));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg && msg.method && msg.id !== undefined) {
      this.emit('serverRequest', { id: msg.id, method: msg.method, params: msg.params });
      return;
    }
    if (msg && msg.method) this.emit('notification', { method: msg.method, params: msg.params });
  }

  /**
   * Fail every pending request when the socket goes.
   * @param {object} info - Close info.
   * @returns {void}
   */
  _onClose(info) {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error(`connection closed before ${entry.method} answered`), { code: 'CLOSED' }));
      this.pending.delete(id);
    }
    this.emit('closed', info);
  }

  /**
   * Close the connection.
   * @returns {void}
   */
  close() {
    this.closed = true;
    this.client.close();
  }
}

/**
 * The version an `initialize` result reports, from its userAgent.
 * @param {object} init - The result.
 * @returns {string|null}
 */
function _serverVersion(init) {
  const m = /^[^/]+\/(\d+\.\d+\.\d+)/.exec(String(init && init.userAgent ? init.userAgent : ''));
  return m ? m[1] : null;
}

/**
 * A blocker result.
 * @param {string} reasonCode - Bounded code.
 * @param {string} reason - Human-readable.
 * @returns {{ready: false, reasonCode: string, reason: string}}
 */
function _blocked(reasonCode, reason) {
  return { ready: false, reasonCode, reason };
}

/**
 * Whether Codex trusts the project directory, per its config: `true`,
 * `false`, or `null` when the config carries no readable projects table.
 * @param {object} config - The `config/read` result.
 * @param {string} projectPath - The project path.
 * @returns {boolean|null}
 */
function _trusted(config, projectPath) {
  const projects = config && config.config && config.config.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return null;
  const want = _canonicalDir(projectPath);
  for (const [key, value] of Object.entries(projects)) {
    if (_canonicalDir(key) === want) return !!(value && value.trust_level === 'trusted');
  }
  return false;
}

/**
 * Whether the account can run a turn: only an explicit
 * `ordinaryUsageAllowed: true`, or an explicitly usable positive credit
 * balance, passes. An unavailable answer is unknown, not a pass.
 * @param {object} limits - The `account/rateLimits/read` result.
 * @returns {{state: 'allowed'|'exhausted'|'unknown', reason: string}}
 */
function _usageAllowed(limits) {
  if (!limits || typeof limits !== 'object') return { state: 'unknown', reason: 'the usage read returned nothing' };
  if (limits.ordinaryUsageAllowed === true) return { state: 'allowed', reason: 'ordinary usage allowed' };
  const rl = limits.rateLimits || {};
  const credits = rl.credits;
  const balance = credits && credits.balance !== undefined && credits.balance !== null ? Number(credits.balance) : NaN;
  const usable = !!credits && credits.hasCredits === true && (credits.unlimited === true || (Number.isFinite(balance) && balance > 0));
  if (limits.ordinaryUsageAllowed === false) {
    if (usable) return { state: 'allowed', reason: 'the usage window is exhausted; credits are available' };
    const resets = rl.primary && rl.primary.resetsAt ? new Date(rl.primary.resetsAt * 1000).toISOString() : 'unknown';
    return { state: 'exhausted', reason: `the usage window is exhausted (${rl.rateLimitReachedType || 'rate limit'}) and no usable credits are reported; resets ${resets}` };
  }
  if (usable) return { state: 'allowed', reason: 'credits are available' };
  return { state: 'unknown', reason: 'the usage read did not say whether ordinary usage is allowed' };
}

/**
 * Establish readiness on an open connection (acceptance case 2), reading only
 * the protocol. Returns the thread to fire at, or the blocker. Every unknown
 * answer fails closed as `readiness_unknown`.
 *
 * @param {AppServerConnection} conn - An opened connection.
 * @param {object} channel - The channel row.
 * @param {object} project - The project.
 * @returns {Promise<{ready: true, threadId: string} | {ready: false, reasonCode: string, reason: string}>}
 */
async function _readiness(conn, channel, project) {
  const state = channel.adapterState || {};
  const serverVersion = _serverVersion(conn.initResult);
  const installed = installedVersion();
  if (!serverVersion || serverVersion !== installed || (state.engineVersion && serverVersion !== state.engineVersion)) {
    return _blocked('version_mismatch', `the app-server reports version ${serverVersion || 'unknown'}; codex-cli ${installed || 'unknown'} is installed and the channel was started on ${state.engineVersion || 'unknown'}`);
  }
  if (state.serverVersion !== serverVersion) {
    try { store.startupControlChannels.setAdapterState(channel.id, { serverVersion }); } catch (err) { log.warn('Could not record the server version', { error: err.message }); }
  }

  let config;
  try {
    config = await conn.call('config/read', {});
  } catch (err) {
    return _blocked('readiness_unknown', `Codex's config could not be read, so trust is unknown: ${err.message}`);
  }
  const trusted = _trusted(config, project.path);
  if (trusted === null) return _blocked('readiness_unknown', 'Codex\'s config carries no projects table, so trust for the project directory is unknown');
  if (!trusted) return _blocked('trust_required', `Codex has not been told to trust ${project.path}; the pane is showing its folder-trust dialog and nothing is typed through it`);

  let account;
  try {
    account = await conn.call('account/read', {});
  } catch (err) {
    return _blocked('readiness_unknown', `the account could not be read: ${err.message}`);
  }
  if (!account || typeof account !== 'object' || !('account' in account)) return _blocked('readiness_unknown', 'the account read answered without an account field');
  if (!account.account) return _blocked('auth_required', 'Codex is not signed in; the operator must log in before the prompt can be fired');

  let limits;
  try {
    limits = await conn.call('account/rateLimits/read', {});
  } catch (err) {
    return _blocked('readiness_unknown', `the usage limits could not be read: ${err.message}`);
  }
  const usage = _usageAllowed(limits);
  if (usage.state === 'exhausted') return _blocked('quota_exhausted', usage.reason);
  if (usage.state === 'unknown') return _blocked('readiness_unknown', usage.reason);

  let loaded;
  try {
    loaded = await conn.call('thread/loaded/list', {});
  } catch (err) {
    return _blocked('readiness_unknown', `the loaded threads could not be listed: ${err.message}`);
  }
  const want = _canonicalDir(project.path);
  const candidates = [];
  for (const id of (loaded && loaded.data) || []) {
    let read;
    try {
      read = await conn.call('thread/read', { threadId: id, includeTurns: false });
    } catch {
      continue;
    }
    const t = read && read.thread;
    if (t && typeof t.cwd === 'string' && _canonicalDir(t.cwd) === want) candidates.push(t);
  }
  let thread = null;
  if (state.threadId) {
    thread = candidates.find((t) => t.id === state.threadId) || null;
    if (!thread) return _blocked('engine_not_ready', `the launch's recorded thread is not loaded for the project directory (${candidates.length} other candidate${candidates.length === 1 ? '' : 's'})`);
  } else if (candidates.length === 1) {
    thread = candidates[0];
    try { store.startupControlChannels.setAdapterState(channel.id, { threadId: thread.id }); } catch (err) { log.warn('Could not record the channel thread', { error: err.message }); }
  } else if (candidates.length === 0) {
    return _blocked('engine_not_ready', 'the pane has not opened a thread for the project directory yet: it may be starting, or showing a trust or login dialog');
  } else {
    return _blocked('engine_not_ready', `${candidates.length} threads are loaded for the project directory and none is recorded as this launch's; not firing at a guess`);
  }
  const status = thread.status && thread.status.type;
  if (status !== 'idle') return _blocked('engine_not_ready', `the thread is ${status || 'in an unknown state'}, not idle`);
  return { ready: true, threadId: thread.id };
}

/**
 * Open a connection to a channel's app-server, or say why not.
 * @param {object} channel - The channel row.
 * @param {object} deps - Seams.
 * @returns {Promise<{conn: AppServerConnection} | {blocker: object}>}
 */
async function _connect(channel, deps) {
  const socketPath = channel.adapterState && channel.adapterState.resolvedSocketPath;
  if (!socketPath) return { blocker: _blocked('engine_not_ready', 'the channel records no socket') };
  const conn = new AppServerConnection(socketPath, deps);
  try {
    conn.initResult = await conn.open();
    return { conn };
  } catch (err) {
    conn.close();
    return { blocker: _blocked('engine_not_ready', `the app-server did not answer: ${err.message}`) };
  }
}

/**
 * The text of a user item's content, as the engine echoes it.
 * @param {object} item - A userMessage item.
 * @returns {string}
 */
function _itemText(item) {
  return ((item && item.content) || []).filter((c) => c && c.type === 'text').map((c) => String(c.text)).join('');
}

/**
 * The userMessage item in a turn record that carries our digest AND whose
 * text is exactly the prompt's bytes, if any. A correct clientId never
 * blesses wrong text.
 * @param {object} turn - A Turn.
 * @param {string} digest - The payload digest.
 * @param {string} promptTextDigest - SHA-256 of the prompt text.
 * @returns {object|null}
 */
function _echoedItem(turn, digest, promptTextDigest) {
  for (const item of (turn && turn.items) || []) {
    if (item && item.type === 'userMessage' && item.clientId === digest && _sha256(_itemText(item)) === promptTextDigest) return item;
  }
  return null;
}

/**
 * The outcome a finished turn maps to, or null while it runs.
 * @param {object} turn - A Turn.
 * @returns {{outcome: string, reasonCode: (string|null), reason: (string|null)}|null}
 */
function _turnOutcome(turn) {
  if (!turn) return null;
  switch (turn.status) {
    case 'completed':
      return { outcome: 'applied', reasonCode: null, reason: null };
    case 'failed': {
      const info = turn.error && turn.error.codexErrorInfo;
      const code = typeof info === 'string' ? info : (info && Object.keys(info)[0]) || 'unknown';
      return { outcome: 'failed', reasonCode: 'turn_failed', reason: `the turn failed (${code}): ${(turn.error && turn.error.message) || ''}`.trim() };
    }
    case 'interrupted':
      return { outcome: 'interrupted', reasonCode: 'turn_interrupted', reason: 'the turn was interrupted before it completed (the operator declined or stopped it)' };
    default:
      return null;
  }
}

/**
 * Read every page of a thread's turns.
 * @param {AppServerConnection} conn - Connection.
 * @param {string} threadId - Thread.
 * @returns {Promise<{turns: object[], complete: boolean}>} `complete` is false when a page failed or the cap was hit.
 */
async function _allTurns(conn, threadId) {
  const turns = [];
  let cursor = null;
  for (let page = 0; page < MAX_TURN_PAGES; page++) {
    let list;
    try {
      list = await conn.call('thread/turns/list', { threadId, itemsView: 'full', cursor: cursor || undefined });
    } catch (err) {
      return { turns, complete: false, error: err };
    }
    for (const t of (list && list.data) || []) turns.push(t);
    cursor = list && list.nextCursor ? list.nextCursor : null;
    if (!cursor) return { turns, complete: true };
  }
  return { turns, complete: false };
}

/**
 * Fire the prompt at a session's channel and drive the receipt.
 *
 * The caller has already written the fire's intent row (`pending`) and
 * commits every transition this function reports through `onUpdate`. The
 * returned `accepted` promise settles when the engine has echoed the payload
 * digest with the prompt's bytes (or the fire ended first); `settled` settles
 * at a terminal outcome or at `indeterminate`.
 *
 * @param {object} input
 * @param {object} input.session - The target session row.
 * @param {object} input.project - Its project.
 * @param {number} input.sequenceId - The launch the fire is bound to.
 * @param {string} input.promptText - The prompt to send.
 * @param {string} input.promptTextDigest - SHA-256 of the prompt's exact bytes.
 * @param {string} input.payloadDigest - The launch-start payload digest.
 * @param {(patch: object) => object} input.onUpdate - Applies a transition; returns the row.
 * @param {object} [deps] - Seams.
 * @returns {{accepted: Promise<object>, settled: Promise<object>}}
 */
function fire(input, deps = {}) {
  let resolveAccepted;
  const accepted = new Promise((resolve) => { resolveAccepted = resolve; });
  const settled = _fire(input, deps, (row) => resolveAccepted(row));
  settled.then((row) => resolveAccepted(row), () => resolveAccepted(null));
  return { accepted, settled };
}

/**
 * The fire itself; see {@link fire}.
 * @param {object} input - As `fire`.
 * @param {object} deps - Seams.
 * @param {(row: object) => void} onAccepted - Called once the engine echoed the digest.
 * @returns {Promise<object>} The final row.
 */
async function _fire(input, deps, onAccepted) {
  const { session, project, sequenceId, promptText, promptTextDigest, payloadDigest, onUpdate } = input;
  let channel = null;
  try {
    channel = store.startupControlChannels.getOpenBySession(session.id);
  } catch (err) {
    return onUpdate({ outcome: 'blocked', reasonCode: 'engine_not_ready', reason: `the channel record could not be read: ${err.message}` });
  }
  if (!channel || channel.adapter !== NAME) {
    let why = 'it was launched without one';
    try {
      const last = store.startupControlChannels.getLatestBySession(session.id);
      if (last && last.state === 'closed' && last.closeReason) why = `${last.closeReason}`;
    } catch { /* the generic reason stands */ }
    return onUpdate({ outcome: 'blocked', reasonCode: 'channel_unavailable', reason: `this session has no native channel: ${why}` });
  }
  if (Number.isInteger(sequenceId) && channel.sequenceId !== sequenceId) {
    return onUpdate({ outcome: 'blocked', reasonCode: 'engine_not_ready', reason: 'the session\'s channel belongs to a different launch than this fire' });
  }
  const opened = await _connect(channel, deps);
  if (opened.blocker) return onUpdate({ outcome: 'blocked', reasonCode: opened.blocker.reasonCode, reason: opened.blocker.reason });
  const conn = opened.conn;
  let watcher = null;
  try {
    const ready = await _readiness(conn, channel, project);
    if (!ready.ready) return onUpdate({ outcome: 'blocked', reasonCode: ready.reasonCode, reason: ready.reason });
    const threadId = ready.threadId;

    watcher = new TurnWatcher({ conn, threadId, payloadDigest, promptTextDigest, onUpdate, onAccepted, channel, deps });
    watcher.listen(conn);

    const row = onUpdate({ outcome: 'dispatching', reason: null, engineThreadId: threadId });
    if (!row || row.outcome !== 'dispatching') {
      watcher.finished = true;
      return row;
    }

    let response;
    try {
      response = await conn.call('turn/start', {
        threadId,
        input: [{ type: 'text', text: promptText }],
        clientUserMessageId: payloadDigest
      }, TURN_START_TIMEOUT_MS);
    } catch (err) {
      watcher.finished = true;
      if (err.code === 'CLOSED' || err.code === 'TIMEOUT') {
        return onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: `turn/start was sent but not answered (${err.message}); never retried automatically` });
      }
      return onUpdate({ outcome: 'failed', reasonCode: 'turn_rejected', reason: `the engine rejected the turn (${err.code}): ${err.message}` });
    }
    const turn = response && response.turn;
    if (!turn || !turn.id) {
      watcher.finished = true;
      return onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: 'turn/start answered without a turn id; never retried automatically' });
    }
    watcher.turnId = turn.id;
    onUpdate({ outcome: 'dispatching', engineTurnId: turn.id, engineThreadId: threadId });
    await watcher.consider(turn);
    await watcher.subscribeAndReadBack();
    watcher.startPolling();
    return await watcher.done;
  } finally {
    if (!watcher || watcher.finished) conn.close();
  }
}

/**
 * Follows one turn to its end: notifications while the socket lives, a
 * read-back of the engine's own turn record after a subscription, after an
 * early completion, and after every reconnect, and a bounded number of
 * reconnects before the fire is left indeterminate. Applied is recorded only
 * after accepted evidence exists for the same turn.
 */
class TurnWatcher {
  /**
   * @param {object} args - `conn, threadId, payloadDigest, promptTextDigest, onUpdate, onAccepted, channel, deps`, and optionally `turnId`.
   */
  constructor(args) {
    Object.assign(this, { turnId: null }, args);
    this.acceptedSeen = false;
    this.finished = false;
    this.reconnects = 0;
    this.row = null;
    this.polling = false;
    this._poll = null;
    this.done = new Promise((resolve) => { this._resolve = resolve; });
  }

  /**
   * Re-read the turn record on an interval until the fire ends, so a turn
   * whose end no notification reports is still settled from the record.
   * @returns {void}
   */
  startPolling() {
    if (this._poll || this.finished) return;
    const pollMs = this.deps.pollMs !== undefined ? this.deps.pollMs : WATCH_POLL_MS;
    this._poll = setInterval(() => {
      if (this.finished || this.polling || !this.conn || this.conn.closed) return;
      this.polling = true;
      this.readBack().catch((err) => log.warn('watch poll failed', { error: err.message })).finally(() => { this.polling = false; });
    }, pollMs);
    if (this._poll.unref) this._poll.unref();
  }

  /**
   * Attach to a connection's events.
   * @param {AppServerConnection} conn - The connection.
   * @returns {void}
   */
  listen(conn) {
    conn.on('notification', (n) => { this._onNotification(n).catch((err) => log.warn('watch notification failed', { error: err.message })); });
    conn.on('closed', () => { this._onClosed().catch((err) => log.warn('watch reconnect failed', { error: err.message })); });
    conn.on('serverRequest', (r) => {
      // Never answered: an approval or a question is the operator's, in the TUI.
      log.info('app-server asked the operator for something; left to the pane', { method: r.method });
    });
  }

  /**
   * Apply a transition and remember the row.
   * @param {object} patch - Transition.
   * @returns {object}
   */
  _update(patch) {
    this.row = this.onUpdate(patch);
    return this.row;
  }

  /**
   * Finish with a terminal or indeterminate row.
   * @param {object} patch - The final transition.
   * @returns {void}
   */
  _finish(patch) {
    if (this.finished) return;
    this.finished = true;
    if (this._poll) clearInterval(this._poll);
    const row = patch ? this._update(patch) : this.row;
    try { if (this.conn) this.conn.close(); } catch { /* closing */ }
    this._resolve(row);
  }

  /**
   * Mark accepted once, from whichever evidence came first.
   * @returns {void}
   */
  _accept() {
    if (this.acceptedSeen || this.finished) return;
    this.acceptedSeen = true;
    const row = this._update({ outcome: 'accepted', reason: null, engineTurnId: this.turnId });
    try { this.onAccepted(row); } catch { /* the caller's promise is already settled */ }
  }

  /**
   * Weigh a turn record. A finished turn with no accepted evidence yet is
   * read back once before it is judged, so an early completion is reconciled
   * rather than skipped.
   * @param {object} turn - A Turn.
   * @param {boolean} [fromReadBack=false] - Whether this record is already the read-back.
   * @returns {Promise<void>}
   */
  async consider(turn, fromReadBack = false) {
    if (!turn || this.finished) return;
    if (this.turnId && turn.id !== this.turnId) return;
    if (_echoedItem(turn, this.payloadDigest, this.promptTextDigest)) this._accept();
    const outcome = _turnOutcome(turn);
    if (!outcome) return;
    if (!this.acceptedSeen && !fromReadBack) {
      const read = await this.readBack();
      // Found: judged from the record. Unreadable: nothing is known, the poll
      // will read again; a completion is never judged from a summary alone.
      if (read !== 'absent' || this.finished) return;
    }
    if (this.finished) return;
    if (outcome.outcome === 'applied' && !this.acceptedSeen) {
      this._finish({ outcome: 'failed', reasonCode: 'send_unconfirmed', reason: 'the turn completed but its record carries no user message with this fire\'s digest and text' });
      return;
    }
    this._finish(outcome);
  }

  /**
   * Subscribe to the thread (possible now that the turn materialized it) and
   * read the turn back once, so nothing emitted before the subscription is
   * lost.
   * @returns {Promise<void>}
   */
  async subscribeAndReadBack() {
    if (this.finished) return;
    try {
      await this.conn.call('thread/resume', { threadId: this.threadId, excludeTurns: true });
    } catch (err) {
      log.warn('thread/resume after turn/start failed; relying on the read-back', { error: err.message });
    }
    await this.readBack();
  }

  /**
   * Read the engine's record of the turn and weigh it.
   * @returns {Promise<'found'|'absent'|'unreadable'>} 'unreadable' when the list
   *   could not be read in full: that says nothing about the turn and settles nothing.
   */
  async readBack() {
    if (this.finished) return 'found';
    const listed = await _allTurns(this.conn, this.threadId);
    const turn = listed.turns.find((t) => t && t.id === this.turnId);
    if (turn) {
      await this.consider(turn, true);
      return 'found';
    }
    if (!listed.complete) {
      log.warn('thread/turns/list could not be read in full during the watch', { error: listed.error ? listed.error.message : 'page cap' });
      return 'unreadable';
    }
    return 'absent';
  }

  /**
   * One notification from the engine.
   * @param {{method: string, params: object}} n - The notification.
   * @returns {Promise<void>}
   */
  async _onNotification(n) {
    if (this.finished) return;
    const p = n.params || {};
    switch (n.method) {
      case 'item/completed':
        if (p.threadId === this.threadId && p.turnId === this.turnId && p.item && p.item.type === 'userMessage'
          && _echoedItem({ id: this.turnId, items: [p.item] }, this.payloadDigest, this.promptTextDigest)) {
          this._accept();
        }
        return;
      case 'turn/completed':
        if (p.threadId === this.threadId && p.turn && p.turn.id === this.turnId) await this.consider(p.turn);
        return;
      case 'thread/status/changed': {
        if (p.threadId !== this.threadId || !this.acceptedSeen) return;
        const flags = p.status && p.status.type === 'active' ? p.status.activeFlags || [] : [];
        if (flags.includes('waitingOnApproval')) {
          this._update({ outcome: 'accepted', reasonCode: 'approval_pending', reason: 'the turn is waiting on an approval in the pane; the operator answers it there' });
        } else if (flags.includes('waitingOnUserInput')) {
          this._update({ outcome: 'accepted', reasonCode: 'user_input_pending', reason: 'the turn is waiting on user input in the pane; the operator answers it there' });
        } else if (this.row && (this.row.reasonCode === 'approval_pending' || this.row.reasonCode === 'user_input_pending')) {
          this._update({ outcome: 'accepted', reasonCode: null, reason: null });
        }
        return;
      }
      default:
    }
  }

  /**
   * The socket went away mid-watch: reconnect, bounded, and read back.
   * @returns {Promise<void>}
   */
  async _onClosed() {
    if (this.finished) return;
    const pause = this.deps.reconnectPauseMs !== undefined ? this.deps.reconnectPauseMs : WATCH_RECONNECT_PAUSE_MS;
    while (!this.finished && this.reconnects < WATCH_RECONNECTS) {
      this.reconnects += 1;
      await new Promise((r) => setTimeout(r, pause));
      if (this.finished) return;
      const opened = await _connect(this.channel, this.deps);
      if (opened.blocker) continue;
      this.conn = opened.conn;
      this.listen(this.conn);
      try {
        await this.conn.call('thread/resume', { threadId: this.threadId, excludeTurns: true });
      } catch { /* the read-back still tells us where the turn stands */ }
      const read = await this.readBack();
      if (read === 'found' || this.finished) return;
    }
    if (!this.finished) {
      this._finish({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: `the channel was lost while the turn ran and ${WATCH_RECONNECTS} reconnects found no record of it; never retried automatically` });
    }
  }
}

/**
 * Resume following an accepted fire after a restart: reconnect, subscribe,
 * read back, then watch. Nothing is resent.
 * @param {{session: object, fire: object, onUpdate: Function}} input - The fire.
 * @param {object} deps - Seams.
 * @returns {void}
 */
function _resumeWatch(input, deps) {
  const { session, fire: row, onUpdate } = input;
  const channel = store.startupControlChannels.getOpenBySession(session.id);
  if (!channel || !row.engineThreadId || !row.engineTurnId) {
    onUpdate({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: 'the accepted fire cannot be followed after the restart: its thread or turn is not recorded' });
    return;
  }
  const watcher = new TurnWatcher({
    conn: null, threadId: row.engineThreadId, turnId: row.engineTurnId, payloadDigest: row.payloadDigest,
    promptTextDigest: row.promptTextDigest, onUpdate, onAccepted: () => {}, channel, deps
  });
  watcher.acceptedSeen = true;
  watcher.row = row;
  watcher._onClosed()
    .then(() => watcher.startPolling())
    .catch((err) => log.warn('Could not resume a fire watch', { fire: row.id, error: err.message }));
}

/**
 * Settle an indeterminate fire from the engine's own record. Never
 * sends anything. `failed` is recorded only after every page of the exact
 * materialized thread, on the reachable channel, shows the payload absent
 * while the thread stayed idle across a pause.
 *
 * @param {object} input
 * @param {object} input.session - The session.
 * @param {object} input.fire - The indeterminate fire row.
 * @param {(patch: object) => object} input.onUpdate - Applies a transition.
 * @param {object} [deps] - Seams: `stableIdleMs`.
 * @returns {Promise<object>} The row after the reconcile.
 */
async function reconcile(input, deps = {}) {
  const { session, fire: row, onUpdate } = input;
  let channel = null;
  try { channel = store.startupControlChannels.getOpenBySession(session.id); } catch { channel = null; }
  if (!channel || channel.adapter !== NAME) {
    return onUpdate({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: 'no open channel to reconcile against; relaunch the session' });
  }
  const opened = await _connect(channel, deps);
  if (opened.blocker) {
    return onUpdate({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: `the app-server could not be reached to reconcile: ${opened.blocker.reason}` });
  }
  const conn = opened.conn;
  try {
    const threadId = row.engineThreadId || (channel.adapterState && channel.adapterState.threadId);
    if (!threadId) {
      return onUpdate({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: 'no thread is recorded for this fire, so its turn cannot be looked up' });
    }
    try { await conn.call('thread/resume', { threadId, excludeTurns: true }); } catch { /* the list may still answer */ }
    const readStatus = async () => {
      const read = await conn.call('thread/read', { threadId, includeTurns: false });
      return read && read.thread && read.thread.status && read.thread.status.type;
    };
    const listed = await _allTurns(conn, threadId);
    if (!listed.complete) {
      const notMaterialized = listed.error && /not materialized/i.test(listed.error.message);
      if (!notMaterialized) {
        return onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: `the thread's turns could not be read in full${listed.error ? `: ${listed.error.message}` : ''}; it stays indeterminate` });
      }
    }
    const turn = listed.turns.find((t) => _echoedItem(t, row.payloadDigest, row.promptTextDigest));
    if (turn) {
      // The echo is accepted evidence, stamped before the turn's own end so the
      // record reads like a watched fire: accepted, then applied.
      const acceptedRow = onUpdate({ outcome: 'accepted', reason: null, engineTurnId: turn.id });
      const outcome = _turnOutcome(turn);
      if (outcome) return onUpdate({ ...outcome, engineTurnId: turn.id });
      return acceptedRow;
    }
    const first = await readStatus();
    if (first !== 'idle' && first !== 'notLoaded') {
      return onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: `the thread is ${first || 'in an unknown state'} and carries no turn with this fire's digest yet` });
    }
    await new Promise((r) => setTimeout(r, deps.stableIdleMs !== undefined ? deps.stableIdleMs : STABLE_IDLE_MS));
    const second = await readStatus();
    const again = await _allTurns(conn, threadId);
    const stillAbsent = again.complete || (again.error && /not materialized/i.test(again.error.message));
    if ((second === 'idle' || second === 'notLoaded') && stillAbsent && !again.turns.some((t) => _echoedItem(t, row.payloadDigest, row.promptTextDigest))) {
      return onUpdate({ outcome: 'failed', reasonCode: 'send_unconfirmed', reason: 'the engine has no record of this fire\'s turn on any page and the thread stayed idle: the send never landed' });
    }
    return onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: `the thread was ${second || 'in an unknown state'} on the second read; it stays indeterminate` });
  } finally {
    conn.close();
  }
}

module.exports = {
  NAME,
  installedVersion,
  probeVersion,
  probeVersionSync,
  prepareLaunch,
  attachLaunch,
  abandonLaunch,
  releaseSession,
  reap,
  recover,
  start,
  stop,
  fire,
  reconcile,
  AppServerConnection,
  _seams,
  _internal: {
    _version, _parseVersion, _resolveSocket, _canonicalDir, _isOurAppServer, _terminate, _trusted, _usageAllowed,
    _serverVersion, _echoedItem, _itemText, _turnOutcome, _readiness, _allTurns, TurnWatcher, RUN_DIRNAME, SAFE_PATH
  }
};
