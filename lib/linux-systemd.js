'use strict';

/**
 * The Linux half of TangleClaw's background service management (#1424):
 * a `systemd` user-unit generator, an install/uninstall/status
 * orchestrator over `systemctl --user`/`loginctl`, and a verifier for the
 * two contracts restart detection depends on. The macOS half already
 * exists (`scripts/ingress-cutover.js`'s launchd plists); this module is
 * its systemd analogue, not a replacement.
 *
 * Two requirements came out of the issue's own design discussion and are
 * load-bearing, not stylistic:
 *
 * 1. **`KillMode=process`.** systemd's default (`control-group`) kills
 *    every process in the unit's cgroup on restart — including the `tmux`
 *    server TangleClaw itself started, which would end every session.
 * 2. **`ExecStart` execs `node server.js` directly** — not through a shell
 *    or `npm` wrapper. A wrapper becomes the unit's `MainPID`; the real
 *    server process never does, and `systemctl --user show` then never
 *    reports the PID restart-detection actually needs to compare against.
 *
 * Restart detection (a later car; this module is read by it, not the
 * reverse) shows its button only when `systemctl --user show
 * tangleclaw.service` reports `LoadState=loaded`, the running server's PID
 * as `MainPID`, `KillMode=process`, and `NeedDaemonReload=no` — {@link
 * verifyRestartButtonContract} is that exact check, pure, over an already-
 * fetched `systemctl --user show` output.
 *
 * Live installation and status (`systemctl --user daemon-reload`,
 * `loginctl enable-linger`, `systemctl --user enable|start|stop|disable`)
 * run through `_internal.exec`, mirroring `lib/roadmap-sync.js`'s seam —
 * physical Linux verification is deferred to #1564 (Milestone #52, Ruling
 * A185); this module is fully unit-testable without a Linux host.
 *
 * Platform dispatch (deciding to CALL this module because
 * `process.platform === 'linux'`) is a caller's job — out of this car's
 * envelope, which never touches `server.js` or `deploy/install.sh`.
 *
 * **Companion units (#2931, Car 5730-W1-B).** On macOS, `launchd` manages
 * four units: the server, and three companions — `ttyd` (the terminal
 * bridge), `caddy` (the reverse-proxy ingress), and the Discord
 * `bridge-helper`. This module's generators/verifiers for those three
 * ({@link generateTtydUnitFile}, {@link generateCaddyUnitFile}, {@link
 * generateBridgeHelperUnitFile} and their `verify*UnitFileContract`
 * siblings) mirror `deploy/com.tangleclaw.{ttyd,caddy,bridge-helper}.plist`'s
 * arguments and environment variables, for 1-to-1 background-daemon parity
 * on Linux. Each stays as pure/parametrized as `generateUnitFile` already
 * is for the server: resolving a REAL ttyd binary (`lib/ttyd-runtime.js`),
 * a real Caddy binary, or a real Caddyfile path is the CALLER's job
 * (`scripts/linux-systemd-install.js`, mirroring how `scripts/ingress-
 * cutover.js` resolves those same values for the macOS plists) — this
 * module only ever turns already-resolved values into unit-file text, so
 * it stays fully unit-testable without a Linux host or any of those other
 * modules' own dependencies (a real ttyd binary, a real Caddy install).
 *
 * `install()`/`uninstall()` are generalized to any unit via their own
 * `serviceName` option (already true of `uninstall()`/`status()` before
 * this car; `install()` gains it here) through one shared private
 * `_writeAndBringUp` helper, so three new `installTtyd`/`installCaddy`/
 * `installBridgeHelper` exports reuse the exact same write-then-
 * `daemon-reload`/`enable-linger`/`enable`/`start` sequence rather than
 * duplicating it three more times. This also fixes a pre-existing, latent
 * bug: `install()`'s and `uninstall()`'s own calls to {@link unitFilePath}
 * never passed their `serviceName` option through, so a caller supplying a
 * non-default `serviceName` got systemd orchestration against the RIGHT
 * unit name but a file written/removed at `tangleclaw.service`'s path — a
 * mismatch nothing exercised before (every real caller used the default),
 * but one the companion units require fixed to behave correctly at all.
 *
 * @module lib/linux-systemd
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileArgs, describeFailure } = require('./exec');
const { createLogger } = require('./logger');

const log = createLogger('linux-systemd');

/** Error for unit-generation or orchestration input that does not match this module's contract. */
class LinuxSystemdError extends Error {}

function _need(cond, msg) {
  if (!cond) throw new LinuxSystemdError(msg);
}

/** The unit's name, fixed — one TangleClaw instance, one unit. */
const SERVICE_NAME = 'tangleclaw.service';

/** The companion units' names, mirroring the macOS launchd labels (#2931). */
const TTYD_SERVICE_NAME = 'tangleclaw-ttyd.service';
const CADDY_SERVICE_NAME = 'tangleclaw-caddy.service';
const BRIDGE_HELPER_SERVICE_NAME = 'tangleclaw-bridge-helper.service';

/** Where the user unit lives, relative to `$HOME` (systemd's own convention, not TangleClaw's). */
const UNIT_DIR_REL = path.join('.config', 'systemd', 'user');

const EXEC_TIMEOUT_MS = 10000;
const MAX_BUFFER_BYTES = 1024 * 1024;

function defaultExec(file, args, options) {
  return execFileArgs(file, args, { cwd: options && options.cwd, timeoutMs: EXEC_TIMEOUT_MS, maxBufferBytes: MAX_BUFFER_BYTES });
}

const _internal = { exec: defaultExec };

/**
 * Where a user unit file lives on disk.
 * @param {string} [homeDir] - Defaults to `os.homedir()`.
 * @param {string} [serviceName] - Defaults to {@link SERVICE_NAME}. Added for
 *   the companion units (#2931) — a caller passing a non-default
 *   `serviceName` to {@link install}/{@link uninstall} now gets a file
 *   path that actually matches it (see the module docblock's "pre-existing,
 *   latent bug" note).
 * @returns {string}
 */
function unitFilePath(homeDir = os.homedir(), serviceName = SERVICE_NAME) {
  return path.join(homeDir, UNIT_DIR_REL, serviceName);
}

/**
 * Generate the unit file's text. Pure — no I/O.
 * @param {object} o
 * @param {string} o.repoDir - Absolute path to the TangleClaw checkout `server.js` lives in.
 * @param {string} [o.nodeBin] - The `node` executable to exec; an absolute path is safest (a user unit's `PATH` is not a login shell's). Defaults to `'node'`.
 * @param {string} [o.description] - Unit `Description=`.
 * @param {string[]} [o.afterTargets] - Unit `After=` targets.
 * @param {number} [o.restartSec] - Seconds to wait before `Restart=on-failure` retries.
 * @returns {string} The complete `.service` file text.
 */
function generateUnitFile({ repoDir, nodeBin = 'node', description = 'TangleClaw', afterTargets = ['network.target'], restartSec = 5 }) {
  _need(typeof repoDir === 'string' && path.isAbsolute(repoDir), 'repoDir must be an absolute path');
  _need(typeof nodeBin === 'string' && nodeBin.length > 0, 'nodeBin must be a non-empty string');
  _need(Array.isArray(afterTargets) && afterTargets.every((t) => typeof t === 'string' && t.length > 0), 'afterTargets must be an array of non-empty strings');
  _need(Number.isInteger(restartSec) && restartSec >= 0, 'restartSec must be a non-negative integer');
  const serverPath = path.join(repoDir, 'server.js');
  return [
    '[Unit]',
    `Description=${description}`,
    `After=${afterTargets.join(' ')}`,
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${repoDir}`,
    `ExecStart=${nodeBin} ${serverPath}`,
    'KillMode=process',
    'Restart=on-failure',
    `RestartSec=${restartSec}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

/**
 * Check a generated unit file's text against the two load-bearing
 * requirements, before it is ever written to disk.
 * @param {string} unitFileText
 * @returns {string[]} Violations; empty means the contract is satisfied.
 */
function verifyUnitFileContract(unitFileText) {
  _need(typeof unitFileText === 'string', 'unitFileText must be a string');
  const violations = [];
  if (!/^KillMode=process$/m.test(unitFileText)) {
    violations.push('KillMode=process is missing — a restart would also stop the tmux server this unit started, ending every session');
  }
  const execStart = /^ExecStart=(.+)$/m.exec(unitFileText);
  if (!execStart) {
    violations.push('ExecStart is missing');
  } else {
    const cmd = execStart[1].trim();
    if (/^(\S*\/)?(sh|bash|npm|npx)(\s|$)/.test(cmd)) {
      violations.push('ExecStart must exec node directly, not through a shell or npm wrapper — the wrapper becomes the unit\'s MainPID, never the real server process');
    }
    if (!/\bserver\.js\b/.test(cmd)) {
      violations.push('ExecStart does not appear to run server.js');
    }
  }
  return violations;
}

/**
 * Single-quote a token for safe inclusion inside a `/bin/bash -c '...'`
 * string: wraps it in single quotes, and turns any embedded single quote
 * into `'"'"'` (close the quoting, emit a literally-quoted quote, reopen).
 * @param {string} token
 * @returns {string}
 */
function _shellQuote(token) {
  return `'${String(token).replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Generate the `ttyd` companion unit's text. Pure — no I/O. Mirrors
 * `deploy/com.tangleclaw.ttyd.plist`: the inline self-heal (unlink a stale
 * Unix socket before exec, a no-op when `socketPath` is empty) that plist
 * does via `/bin/bash -c '... ; exec "$@"'`; this does the same, with the
 * socket path carried in `Environment=TTYD_SOCKET=` rather than an argv
 * tail, since a unit file has no `"$@"` equivalent to pass it through.
 * @param {object} o
 * @param {string} o.ttydPath - Absolute path to the `ttyd` binary.
 * @param {string} o.attachScriptPath - Absolute path to `ttyd-attach.sh`
 *   (`lib/ttyd-attach.js#attachScriptPath`), ttyd's own `--url-arg` target.
 * @param {string} [o.bindKey] - Defaults to `'--interface'`.
 * @param {string} [o.bindVal] - Defaults to `'127.0.0.1'`. In caddy-ingress
 *   mode, the caller passes the ttyd Unix socket path here instead (AUTH-1,
 *   #395/#710 — ttyd must never bind an unqualified/public interface).
 * @param {number} [o.port] - TCP port, ignored once `bindVal` is a socket
 *   path rather than an address, but still part of ttyd's own argv either
 *   way. Defaults to `3100`.
 * @param {string} [o.socketPath] - The Unix socket this unit's self-heal
 *   unlinks before start. Empty string (default) in direct mode.
 * @param {string} [o.description]
 * @param {string[]} [o.afterTargets]
 * @param {number} [o.restartSec]
 * @returns {string} The complete `.service` file text.
 */
function generateTtydUnitFile({
  ttydPath, attachScriptPath, bindKey = '--interface', bindVal = '127.0.0.1',
  port = 3100, socketPath = '', description = 'TangleClaw ttyd (terminal bridge)',
  afterTargets = ['network.target'], restartSec = 5
}) {
  _need(typeof ttydPath === 'string' && path.isAbsolute(ttydPath), 'ttydPath must be an absolute path');
  _need(typeof attachScriptPath === 'string' && path.isAbsolute(attachScriptPath), 'attachScriptPath must be an absolute path');
  _need(typeof bindKey === 'string' && bindKey.length > 0, 'bindKey must be a non-empty string');
  _need(typeof bindVal === 'string' && bindVal.length > 0, 'bindVal must be a non-empty string');
  _need(Number.isInteger(port) && port > 0 && port < 65536, 'port must be a valid TCP port number');
  _need(typeof socketPath === 'string', 'socketPath must be a string (empty for direct mode)');
  _need(Array.isArray(afterTargets) && afterTargets.every((t) => typeof t === 'string' && t.length > 0), 'afterTargets must be an array of non-empty strings');
  _need(Number.isInteger(restartSec) && restartSec >= 0, 'restartSec must be a non-negative integer');

  const execArgs = [
    ttydPath, '--writable', bindKey, bindVal, '--port', String(port),
    '--url-arg', '--client-option', 'scrollback=10000', attachScriptPath
  ].map(_shellQuote).join(' ');

  return [
    '[Unit]',
    `Description=${description}`,
    `After=${afterTargets.join(' ')}`,
    '',
    '[Service]',
    'Type=simple',
    `Environment=TTYD_SOCKET=${socketPath}`,
    `ExecStart=/bin/bash -c 'if [ -n "$TTYD_SOCKET" ]; then rm -f "$TTYD_SOCKET"; fi; exec ${execArgs}'`,
    'Restart=on-failure',
    `RestartSec=${restartSec}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

/**
 * Check a generated `ttyd` unit file's text against its load-bearing
 * requirements, before it is ever written to disk.
 * @param {string} unitFileText
 * @returns {string[]} Violations; empty means the contract is satisfied.
 */
function verifyTtydUnitFileContract(unitFileText) {
  _need(typeof unitFileText === 'string', 'unitFileText must be a string');
  const violations = [];
  const execStart = /^ExecStart=(.+)$/m.exec(unitFileText);
  if (!execStart) {
    violations.push('ExecStart is missing');
  } else {
    const cmd = execStart[1];
    if (!/--writable\b/.test(cmd)) {
      violations.push('ExecStart must pass --writable, or the attached terminal cannot accept input');
    }
    if (!/--interface\b/.test(cmd)) {
      violations.push('ExecStart must bind an explicit --interface (loopback or a Unix socket) — ttyd with no interface binds every interface, an unauthenticated writable shell on the LAN (AUTH-1, #395/#710)');
    } else if (/--interface'?\s+'?0\.0\.0\.0/.test(cmd)) {
      violations.push('ExecStart must never bind --interface 0.0.0.0 — ttyd is reached only through TangleClaw\'s own proxy, never directly');
    }
  }
  return violations;
}

/**
 * Generate the `caddy` companion unit's text. Pure — no I/O. Mirrors
 * `deploy/com.tangleclaw.caddy.plist`'s `ExecStart` and its two `XDG_*`
 * environment variables, which keep Caddy's local CA and ACME state under
 * the TangleClaw tree rather than the operator's real home.
 * @param {object} o
 * @param {string} o.caddyPath - Absolute path to the `caddy` binary.
 * @param {string} o.caddyfilePath - Absolute path to the generated Caddyfile.
 * @param {string} o.homeDir - The user's home directory (not TangleClaw's
 *   possibly-relocated base dir) — matches the plist's own `__HOME__`.
 * @param {string} [o.description]
 * @param {string[]} [o.afterTargets]
 * @param {number} [o.restartSec]
 * @returns {string} The complete `.service` file text.
 */
function generateCaddyUnitFile({
  caddyPath, caddyfilePath, homeDir, description = 'TangleClaw Caddy (ingress reverse proxy)',
  afterTargets = ['network.target'], restartSec = 5
}) {
  _need(typeof caddyPath === 'string' && path.isAbsolute(caddyPath), 'caddyPath must be an absolute path');
  _need(typeof caddyfilePath === 'string' && path.isAbsolute(caddyfilePath), 'caddyfilePath must be an absolute path');
  _need(typeof homeDir === 'string' && path.isAbsolute(homeDir), 'homeDir must be an absolute path');
  _need(Array.isArray(afterTargets) && afterTargets.every((t) => typeof t === 'string' && t.length > 0), 'afterTargets must be an array of non-empty strings');
  _need(Number.isInteger(restartSec) && restartSec >= 0, 'restartSec must be a non-negative integer');
  const xdgDataHome = path.join(homeDir, '.tangleclaw', 'caddy', 'data');
  const xdgConfigHome = path.join(homeDir, '.tangleclaw', 'caddy', 'config');
  return [
    '[Unit]',
    `Description=${description}`,
    `After=${afterTargets.join(' ')}`,
    '',
    '[Service]',
    'Type=simple',
    `Environment=XDG_DATA_HOME=${xdgDataHome}`,
    `Environment=XDG_CONFIG_HOME=${xdgConfigHome}`,
    `ExecStart=${caddyPath} run --config ${caddyfilePath} --adapter caddyfile`,
    'Restart=on-failure',
    `RestartSec=${restartSec}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

/**
 * Check a generated `caddy` unit file's text against its load-bearing
 * requirements, before it is ever written to disk.
 * @param {string} unitFileText
 * @returns {string[]} Violations; empty means the contract is satisfied.
 */
function verifyCaddyUnitFileContract(unitFileText) {
  _need(typeof unitFileText === 'string', 'unitFileText must be a string');
  const violations = [];
  const execStart = /^ExecStart=(.+)$/m.exec(unitFileText);
  if (!execStart) {
    violations.push('ExecStart is missing');
  } else {
    const cmd = execStart[1];
    if (!/\brun\b/.test(cmd) || !/--config\b/.test(cmd) || !/--adapter\s+caddyfile\b/.test(cmd)) {
      violations.push('ExecStart must run caddy as "run --config <file> --adapter caddyfile"');
    }
  }
  if (!/^Environment=XDG_DATA_HOME=\S+/m.test(unitFileText) || !/^Environment=XDG_CONFIG_HOME=\S+/m.test(unitFileText)) {
    violations.push('XDG_DATA_HOME and XDG_CONFIG_HOME must both be set — without them Caddy\'s local CA and ACME state land under the operator\'s real home, not the TangleClaw tree');
  }
  return violations;
}

/**
 * Generate the Discord `bridge-helper` companion unit's text. Pure — no
 * I/O. Mirrors `deploy/com.tangleclaw.bridge-helper.plist`'s `ExecStart`
 * and `WorkingDirectory`; its `ThrottleInterval=30` becomes `RestartSec=30`
 * here — the closest systemd analogue to "at most one relaunch every N
 * seconds" — so a crash-restart loop cannot spend Discord's daily
 * identify-budget (no in-repo systemd precedent decided this mapping
 * before #2931; recorded here as the one place the decision lives).
 * @param {object} o
 * @param {string} o.repoDir - Absolute path to the TangleClaw checkout `bin/tc-bridge-helper` lives in.
 * @param {string} [o.nodeBin] - Defaults to `'node'`.
 * @param {string} [o.description]
 * @param {string[]} [o.afterTargets]
 * @param {number} [o.restartSec] - Defaults to `30`, and {@link
 *   verifyBridgeHelperUnitFileContract} refuses anything lower.
 * @returns {string} The complete `.service` file text.
 */
function generateBridgeHelperUnitFile({
  repoDir, nodeBin = 'node', description = 'TangleClaw operator bridge helper (Discord)',
  afterTargets = ['network.target'], restartSec = 30
}) {
  _need(typeof repoDir === 'string' && path.isAbsolute(repoDir), 'repoDir must be an absolute path');
  _need(typeof nodeBin === 'string' && nodeBin.length > 0, 'nodeBin must be a non-empty string');
  _need(Array.isArray(afterTargets) && afterTargets.every((t) => typeof t === 'string' && t.length > 0), 'afterTargets must be an array of non-empty strings');
  _need(Number.isInteger(restartSec) && restartSec >= 0, 'restartSec must be a non-negative integer');
  const binPath = path.join(repoDir, 'bin', 'tc-bridge-helper');
  return [
    '[Unit]',
    `Description=${description}`,
    `After=${afterTargets.join(' ')}`,
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${repoDir}`,
    `ExecStart=${nodeBin} ${binPath} run`,
    'Restart=on-failure',
    `RestartSec=${restartSec}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

/**
 * Check a generated `bridge-helper` unit file's text against its
 * load-bearing requirements, before it is ever written to disk.
 * @param {string} unitFileText
 * @returns {string[]} Violations; empty means the contract is satisfied.
 */
function verifyBridgeHelperUnitFileContract(unitFileText) {
  _need(typeof unitFileText === 'string', 'unitFileText must be a string');
  const violations = [];
  const execStart = /^ExecStart=(.+)$/m.exec(unitFileText);
  if (!execStart) {
    violations.push('ExecStart is missing');
  } else {
    const cmd = execStart[1].trim();
    if (!/\btc-bridge-helper\b/.test(cmd) || !/\brun\b/.test(cmd)) {
      violations.push('ExecStart must run tc-bridge-helper run');
    }
  }
  const restartSecMatch = /^RestartSec=(\d+)$/m.exec(unitFileText);
  if (!restartSecMatch || Number(restartSecMatch[1]) < 30) {
    violations.push('RestartSec must be at least 30 — mirrors the launchd plist\'s ThrottleInterval=30, which exists so a crash-restart loop cannot spend Discord\'s daily identify-budget');
  }
  return violations;
}

/**
 * Parse `systemctl --user show <unit>` output into a flat field map.
 * @param {string} output
 * @returns {Object<string, string>}
 */
function parseSystemctlShow(output) {
  const fields = {};
  for (const line of output.split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    fields[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return fields;
}

/**
 * Whether the restart button's own four live conditions hold, given an
 * already-fetched `systemctl --user show` field map.
 * @param {Object<string, string>} fields - From {@link parseSystemctlShow}.
 * @param {object} [opts]
 * @param {number} [opts.expectedPid] - The running server's own PID, to compare `MainPID` against. Omitted skips that one check.
 * @returns {string[]} Violations; empty means the button may show.
 */
function verifyRestartButtonContract(fields, { expectedPid } = {}) {
  const violations = [];
  if (fields.LoadState !== 'loaded') violations.push(`LoadState must be "loaded" (is ${JSON.stringify(fields.LoadState)})`);
  if (fields.KillMode !== 'process') violations.push(`KillMode must be "process" (is ${JSON.stringify(fields.KillMode)})`);
  if (fields.NeedDaemonReload !== 'no') violations.push(`NeedDaemonReload must be "no" (is ${JSON.stringify(fields.NeedDaemonReload)})`);
  if (typeof expectedPid === 'number') {
    if (String(fields.MainPID) !== String(expectedPid)) violations.push(`MainPID must equal the running server's pid ${expectedPid} (is ${JSON.stringify(fields.MainPID)})`);
  }
  return violations;
}

/**
 * One orchestration step's result.
 * @typedef {{cmd: string, args: string[], ok: boolean, detail: (string|null)}} StepResult
 */

/**
 * Run a sequence of `[cmd, args]` tuples via `_internal.exec`, stopping at
 * the first failure.
 * @param {Array<[string, string[]]>} steps
 * @returns {Promise<{ok: boolean, steps: StepResult[]}>}
 */
async function _runSteps(steps) {
  const results = [];
  for (const [cmd, args] of steps) {
    const r = await _internal.exec(cmd, args, {});
    const ok = r.exitCode === 0;
    results.push({ cmd, args, ok, detail: ok ? null : describeFailure(r, `${cmd} ${args.join(' ')}`) });
    if (!ok) {
      log.warn('systemd orchestration step failed', { cmd, args, detail: results[results.length - 1].detail });
      return { ok: false, steps: results };
    }
  }
  return { ok: true, steps: results };
}

/**
 * Write an already-generated, already-verified unit file and bring it up:
 * `daemon-reload`, `loginctl enable-linger` (so the user manager outlives
 * the login session), `enable`, `start`. Shared by {@link install} and the
 * companion `install*` functions below (#2931) so the sequence is defined
 * once.
 * @param {object} o
 * @param {string} o.serviceName
 * @param {string} o.content - The unit file's text.
 * @param {string} o.homeDir
 * @returns {Promise<{ok: boolean, file: string, steps?: StepResult[]}>}
 */
async function _writeAndBringUp({ serviceName, content, homeDir }) {
  const file = unitFilePath(homeDir, serviceName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  const { ok, steps } = await _runSteps([
    ['systemctl', ['--user', 'daemon-reload']],
    ['loginctl', ['enable-linger']],
    ['systemctl', ['--user', 'enable', serviceName]],
    ['systemctl', ['--user', 'start', serviceName]]
  ]);
  return { ok, file, steps };
}

/**
 * Write the unit file and bring it up. Refuses to write a unit file that
 * fails {@link verifyUnitFileContract} — the live orchestration never runs
 * on a unit that could not pass its own static check.
 * @param {object} o
 * @param {string} o.repoDir - See {@link generateUnitFile}.
 * @param {string} [o.nodeBin]
 * @param {string} [o.homeDir] - Defaults to `os.homedir()`.
 * @param {string} [o.serviceName] - Defaults to {@link SERVICE_NAME}.
 * @returns {Promise<{ok: boolean, file: string, steps?: StepResult[]}>}
 * @throws {LinuxSystemdError} When the generated unit fails its own contract.
 */
async function install({ repoDir, nodeBin, homeDir = os.homedir(), serviceName = SERVICE_NAME } = {}) {
  const content = generateUnitFile({ repoDir, nodeBin });
  const violations = verifyUnitFileContract(content);
  _need(violations.length === 0, `generated unit file fails its own contract: ${violations.join('; ')}`);
  return _writeAndBringUp({ serviceName, content, homeDir });
}

/**
 * Write the `ttyd` companion unit and bring it up. Refuses to write one
 * that fails {@link verifyTtydUnitFileContract} (#2931).
 * @param {object} o - See {@link generateTtydUnitFile} for the generator
 *   options; all are accepted here the same way.
 * @param {string} [o.homeDir] - Defaults to `os.homedir()`.
 * @param {string} [o.serviceName] - Defaults to {@link TTYD_SERVICE_NAME}.
 * @returns {Promise<{ok: boolean, file: string, steps?: StepResult[]}>}
 * @throws {LinuxSystemdError} When the generated unit fails its own contract.
 */
async function installTtyd({ homeDir = os.homedir(), serviceName = TTYD_SERVICE_NAME, ...genOpts } = {}) {
  const content = generateTtydUnitFile(genOpts);
  const violations = verifyTtydUnitFileContract(content);
  _need(violations.length === 0, `generated ttyd unit file fails its own contract: ${violations.join('; ')}`);
  return _writeAndBringUp({ serviceName, content, homeDir });
}

/**
 * Write the `caddy` companion unit and bring it up. Refuses to write one
 * that fails {@link verifyCaddyUnitFileContract} (#2931).
 * @param {object} o - See {@link generateCaddyUnitFile} for the generator
 *   options; all are accepted here the same way.
 * @param {string} [o.homeDir] - Defaults to `os.homedir()`; also passed to
 *   the generator as its own `homeDir` (the unit file lives under it AND
 *   its `XDG_*` variables are built from it — the same value either way).
 * @param {string} [o.serviceName] - Defaults to {@link CADDY_SERVICE_NAME}.
 * @returns {Promise<{ok: boolean, file: string, steps?: StepResult[]}>}
 * @throws {LinuxSystemdError} When the generated unit fails its own contract.
 */
async function installCaddy({ homeDir = os.homedir(), serviceName = CADDY_SERVICE_NAME, ...genOpts } = {}) {
  const content = generateCaddyUnitFile({ ...genOpts, homeDir });
  const violations = verifyCaddyUnitFileContract(content);
  _need(violations.length === 0, `generated caddy unit file fails its own contract: ${violations.join('; ')}`);
  return _writeAndBringUp({ serviceName, content, homeDir });
}

/**
 * Write the Discord `bridge-helper` companion unit and bring it up.
 * Refuses to write one that fails {@link
 * verifyBridgeHelperUnitFileContract} (#2931).
 * @param {object} o - See {@link generateBridgeHelperUnitFile} for the
 *   generator options; all are accepted here the same way.
 * @param {string} [o.homeDir] - Defaults to `os.homedir()`.
 * @param {string} [o.serviceName] - Defaults to {@link BRIDGE_HELPER_SERVICE_NAME}.
 * @returns {Promise<{ok: boolean, file: string, steps?: StepResult[]}>}
 * @throws {LinuxSystemdError} When the generated unit fails its own contract.
 */
async function installBridgeHelper({ homeDir = os.homedir(), serviceName = BRIDGE_HELPER_SERVICE_NAME, ...genOpts } = {}) {
  const content = generateBridgeHelperUnitFile(genOpts);
  const violations = verifyBridgeHelperUnitFileContract(content);
  _need(violations.length === 0, `generated bridge-helper unit file fails its own contract: ${violations.join('; ')}`);
  return _writeAndBringUp({ serviceName, content, homeDir });
}

/**
 * Stop and remove the unit: `stop`, `disable`, delete the file, `daemon-
 * reload`. A unit that was never installed (file missing) is a no-op
 * success, not a failure — uninstalling something absent is the same as
 * uninstalling something gone.
 *
 * `stop`/`disable` against a unit systemd never loaded (no unit file ever
 * written) answer a nonzero exit — "Unit tangleclaw.service not loaded" —
 * before this function gets anywhere near the file. Checked here, not
 * inferred from that exit code's text: whether the file existed BEFORE this
 * call is the actual fact that makes the live step's failure benign, so a
 * unit that genuinely failed to stop for some other reason still reports
 * failure (#PRR-A Round 1 on PR #2899).
 * @param {object} [o]
 * @param {string} [o.homeDir] - Defaults to `os.homedir()`.
 * @param {string} [o.serviceName] - Defaults to {@link SERVICE_NAME}.
 * @returns {Promise<{ok: boolean, file: string, steps?: StepResult[]}>}
 */
async function uninstall({ homeDir = os.homedir(), serviceName = SERVICE_NAME } = {}) {
  const file = unitFilePath(homeDir, serviceName);
  const fileExisted = fs.existsSync(file);
  const { ok, steps } = await _runSteps([
    ['systemctl', ['--user', 'stop', serviceName]],
    ['systemctl', ['--user', 'disable', serviceName]]
  ]);
  if (!ok && fileExisted) return { ok: false, file, steps };
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const reload = await _runSteps([['systemctl', ['--user', 'daemon-reload']]]);
  return { ok: reload.ok, file, steps: [...steps, ...reload.steps] };
}

/**
 * Read the unit's live status fields, for a caller to pass to {@link
 * verifyRestartButtonContract} alongside the running server's own PID.
 * @param {object} [o]
 * @param {string} [o.serviceName] - Defaults to {@link SERVICE_NAME}.
 * @returns {Promise<{available: true, fields: Object<string,string>} | {available: false, reason: string}>}
 */
async function status({ serviceName = SERVICE_NAME } = {}) {
  const r = await _internal.exec('systemctl', ['--user', 'show', serviceName], {});
  if (r.exitCode !== 0) return { available: false, reason: describeFailure(r, 'systemctl --user show') };
  return { available: true, fields: parseSystemctlShow(r.stdout) };
}

module.exports = {
  LinuxSystemdError,
  SERVICE_NAME,
  TTYD_SERVICE_NAME,
  CADDY_SERVICE_NAME,
  BRIDGE_HELPER_SERVICE_NAME,
  unitFilePath,
  generateUnitFile,
  verifyUnitFileContract,
  generateTtydUnitFile,
  verifyTtydUnitFileContract,
  generateCaddyUnitFile,
  verifyCaddyUnitFileContract,
  generateBridgeHelperUnitFile,
  verifyBridgeHelperUnitFileContract,
  parseSystemctlShow,
  verifyRestartButtonContract,
  install,
  installTtyd,
  installCaddy,
  installBridgeHelper,
  uninstall,
  status,
  _internal
};
