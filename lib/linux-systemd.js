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

/** Where the user unit lives, relative to `$HOME` (systemd's own convention, not TangleClaw's). */
const UNIT_DIR_REL = path.join('.config', 'systemd', 'user');

const EXEC_TIMEOUT_MS = 10000;
const MAX_BUFFER_BYTES = 1024 * 1024;

function defaultExec(file, args, options) {
  return execFileArgs(file, args, { cwd: options && options.cwd, timeoutMs: EXEC_TIMEOUT_MS, maxBufferBytes: MAX_BUFFER_BYTES });
}

const _internal = { exec: defaultExec };

/**
 * Where the user unit file lives on disk.
 * @param {string} [homeDir] - Defaults to `os.homedir()`.
 * @returns {string}
 */
function unitFilePath(homeDir = os.homedir()) {
  return path.join(homeDir, UNIT_DIR_REL, SERVICE_NAME);
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
 * Write the unit file and bring it up: `daemon-reload`, `loginctl enable-
 * linger` (so the user manager outlives the login session), `enable`,
 * `start`. Refuses to write a unit file that fails {@link
 * verifyUnitFileContract} — the live orchestration never runs on a unit
 * that could not pass its own static check.
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
  const file = unitFilePath(homeDir);
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
  const file = unitFilePath(homeDir);
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
  unitFilePath,
  generateUnitFile,
  verifyUnitFileContract,
  parseSystemctlShow,
  verifyRestartButtonContract,
  install,
  uninstall,
  status,
  _internal
};
