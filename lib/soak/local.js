'use strict';

/**
 * Local control for the soak's `fault` and `browser` events (#2020).
 *
 * The `api` and `engine` load reaches the server under test only through
 * `--api`. Faults do not: they restart launchd jobs, kill tmux sessions, lock
 * the database file and fill the disk of the machine the driver runs on, and
 * the browser events drive a WebDriver on that machine. So the `--api` guards
 * in `lib/soak/driver.js` are not enough for them. A fault run against the
 * wrong machine would disrupt a live install whatever `--api` named.
 *
 * `requireLocalControl` therefore admits a schedule with any such event only
 * where every one of these holds, and refuses (`LOCAL_CONTROL_REFUSED`)
 * before any load otherwise:
 * - no live install on this machine: `--no-live-install`, which the CLI
 *   accepts only when `TANGLECLAW_API` is unset;
 * - the machine is a virtual machine (`kern.hv_vmm_present` is 1), as
 *   `deploy/soak/guest/guest-setup.sh` also requires, so an operator's own
 *   Mac is refused even from a pane with no `TANGLECLAW_API`;
 * - `--api` is a loopback IP literal, so the server the load reaches is the
 *   one on this machine that the faults act on;
 * - `--home` is an absolute, plain directory owned by this user, holding a
 *   `tangleclaw.db` that is a plain file owned by this user. It is the guest
 *   TangleClaw's `TANGLECLAW_HOME`, and nothing outside it is ever written;
 * - for browser events, `--webdriver` is a loopback IP literal too.
 *
 * @module lib/soak/local
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');

const driver = require('./driver');
const scheduleLib = require('./schedule');

/** The database file inside a TangleClaw home (`lib/store.js`). */
const DB_FILE = 'tangleclaw.db';

/** How long a local command may run before it counts as failed. */
const COMMAND_TIMEOUT_MS = 30 * 1000;

/**
 * Whether a kind acts on this machine rather than only through `--api`.
 * @param {string} kind - Event kind
 * @returns {boolean} True for `fault.*` and `browser.*` kinds
 */
function isLocalKind(kind) {
  return kind.startsWith('fault.') || kind.startsWith('browser.');
}

/**
 * Whether a URL's host is a loopback IP literal. A name is never accepted:
 * it would be resolved at connection time, and nothing binds that to the
 * check.
 * @param {string} href - URL
 * @returns {boolean} True for `127.0.0.0/8` and `[::1]`
 */
function isLoopbackLiteral(href) {
  let host;
  try {
    host = driver.canonicalHost(new URL(href).hostname);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return false;
  }
  if (net.isIPv4(host)) return host.split('.')[0] === '127';
  return host === '::1';
}

/**
 * Run a command without a shell and report how it ended. Never throws: a
 * command that cannot start, fails or times out is an outcome.
 * @param {string} file - Executable
 * @param {string[]} args - Arguments
 * @param {object} [opts] - `{timeoutMs}`
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, error: string|null}>} How it ended
 */
function runCommand(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs || COMMAND_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr, error: null });
      const code = typeof err.code === 'number' ? err.code : null;
      resolve({ code, stdout: stdout || '', stderr: stderr || '', error: err.killed ? 'timeout' : String(err.code || err.message) });
    });
  });
}

/**
 * Whether this machine reports being a virtual machine.
 * @param {Function} run - `runCommand`-shaped
 * @returns {Promise<boolean>} True only when `sysctl -n kern.hv_vmm_present` prints exactly 1
 */
async function isVirtualMachine(run) {
  const r = await run('sysctl', ['-n', 'kern.hv_vmm_present'], { timeoutMs: 5000 });
  return r.code === 0 && r.stdout.trim() === '1';
}

/**
 * Why a path is not a plain entry of the wanted type owned by `uid`, or null.
 * `lstat` is used and the real path compared, so a symlink anywhere in the
 * path is refused rather than followed.
 * @param {string} p - Absolute path
 * @param {'dir'|'file'} type - What it must be
 * @param {number} uid - Owner it must have
 * @param {object} fsImpl - `node:fs`-shaped
 * @returns {string|null} The problem, or null
 */
function _plainOwned(p, type, uid, fsImpl) {
  let st;
  try {
    st = fsImpl.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return `${p} does not exist`;
    throw err;
  }
  if (st.isSymbolicLink()) return `${p} is a symlink`;
  if (type === 'dir' ? !st.isDirectory() : !st.isFile()) return `${p} is not a ${type === 'dir' ? 'directory' : 'regular file'}`;
  if (st.uid !== uid) return `${p} is owned by uid ${st.uid}, not this user (${uid})`;
  if (fsImpl.realpathSync(p) !== p) return `${p} resolves to ${fsImpl.realpathSync(p)}`;
  return null;
}

/**
 * Check a `--home`: the absolute path of the guest TangleClaw's home, a plain
 * directory owned by this user, holding a `tangleclaw.db` that is a plain
 * file owned by this user.
 * @param {*} home - The flag's value
 * @param {object} [deps] - `{fs, uid}` for tests
 * @returns {{home: string|null, problem: string|null}} The normalized home, or the problem
 */
function checkHome(home, deps = {}) {
  const fsImpl = deps.fs || fs;
  const uid = deps.uid === undefined ? process.getuid() : deps.uid;
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    return { home: null, problem: '--home must be the absolute path of the guest TangleClaw home (its TANGLECLAW_HOME)' };
  }
  const normal = path.normalize(home).replace(/\/+$/, '') || '/';
  const why = _plainOwned(normal, 'dir', uid, fsImpl) || _plainOwned(path.join(normal, DB_FILE), 'file', uid, fsImpl);
  return why ? { home: null, problem: `--home: ${why}` } : { home: normal, problem: null };
}

/**
 * What keeps this process from counting as inside the soak guest, for
 * `requireLocalControl` and `admitGuestReader` alike, so the two never drift
 * apart: no live install, a virtual machine, a loopback `--api` when one is
 * given, and an owned `--home`.
 * @param {object} opts - `{noLiveInstall, home, apiBase?}`
 * @param {object} deps - `{fs, run, uid}`
 * @returns {Promise<{problems: string[], home: string|null}>} Every unmet condition, and the normalized home
 */
async function _guestProblems(opts, deps) {
  const problems = [];
  if (!opts.noLiveInstall) problems.push('--no-live-install is required: this acts on or reads this machine, which must hold no live install');
  if (opts.apiBase !== undefined && !isLoopbackLiteral(opts.apiBase)) problems.push('--api must be a loopback IP literal (127.x.x.x or [::1]): the server reached must be the one on this machine');
  const checked = checkHome(opts.home, { fs: deps.fs, uid: deps.uid });
  if (checked.problem) problems.push(checked.problem);
  if (!(await isVirtualMachine(deps.run))) problems.push('this machine is not a virtual machine (kern.hv_vmm_present is not 1): this runs only inside the soak guest');
  return { problems, home: checked.home };
}

/**
 * Admit or refuse local control for a schedule.
 * @param {object} opts - Inputs
 * @param {object} opts.schedule - The schedule to run
 * @param {boolean} opts.noLiveInstall - `--no-live-install` was given (and `TANGLECLAW_API` is unset)
 * @param {string} opts.apiBase - `--api`
 * @param {string|undefined} opts.home - `--home`
 * @param {string|undefined} opts.webdriver - `--webdriver`
 * @param {object} [deps] - `{fs, run, uid}` for tests
 * @returns {Promise<object|null>} Null when the schedule has no local kind; else the local context executors receive as `ctx.local`
 * @throws {driver.DriverRefusal} `LOCAL_CONTROL_REFUSED`, naming every unmet condition
 */
async function requireLocalControl(opts, deps = {}) {
  const fsImpl = deps.fs || fs;
  const run = deps.run || runCommand;
  const uid = deps.uid === undefined ? process.getuid() : deps.uid;
  const kinds = [...new Set(opts.schedule.events.map((e) => e.kind))].filter(isLocalKind);
  const browser = kinds.some((k) => k.startsWith('browser.'));
  if (kinds.length === 0) {
    if (opts.home !== undefined || opts.webdriver !== undefined) {
      throw new driver.DriverRefusal(driver.REFUSAL.LOCAL_CONTROL_REFUSED, 'refusing to run: --home and --webdriver are only for a schedule with fault or browser events', { problems: ['unused local flags'] });
    }
    return null;
  }
  const { problems, home } = await _guestProblems({ noLiveInstall: opts.noLiveInstall, apiBase: opts.apiBase === undefined ? '' : opts.apiBase, home: opts.home }, { fs: fsImpl, run, uid });
  let webdriver = null;
  if (browser) {
    if (typeof opts.webdriver !== 'string' || !isLoopbackLiteral(opts.webdriver)) problems.push('--webdriver must be a loopback IP literal URL of a running WebDriver (safaridriver)');
    else webdriver = new URL(opts.webdriver).origin;
  } else if (opts.webdriver !== undefined) {
    problems.push('--webdriver is only for a schedule with browser events');
  }
  if (problems.length > 0) {
    throw new driver.DriverRefusal(driver.REFUSAL.LOCAL_CONTROL_REFUSED, `refusing to run local events (${kinds.join(', ')}): ${problems.join('; ')}`, { kinds, problems });
  }
  return {
    home,
    dbPath: path.join(home, DB_FILE),
    webdriver,
    uid,
    phase: scheduleLib.normalizeParams(opts.schedule.params).phase,
    run
  };
}

/**
 * Admit or refuse a tool that reads the guest's home directly: the integrity
 * sampler, and the evidence bundle's database snapshot. They only read, but
 * they read a TangleClaw's database and process, so they are held to the same
 * place as the faults: inside the soak guest, never beside a live install.
 * @param {object} opts - `{noLiveInstall, home, apiBase?}`; `apiBase`, when given, must be loopback too
 * @param {object} [deps] - `{fs, run, uid}` for tests
 * @returns {Promise<{home: string, uid: number, run: Function}>} The admitted home
 * @throws {driver.DriverRefusal} `LOCAL_CONTROL_REFUSED`, naming every unmet condition
 */
async function admitGuestReader(opts, deps = {}) {
  const run = deps.run || runCommand;
  const uid = deps.uid === undefined ? process.getuid() : deps.uid;
  const { problems, home } = await _guestProblems(opts, { fs: deps.fs || fs, run, uid });
  if (problems.length > 0) throw new driver.DriverRefusal(driver.REFUSAL.LOCAL_CONTROL_REFUSED, `refusing to read the guest home: ${problems.join('; ')}`, { problems });
  return { home, uid, run };
}

module.exports = { DB_FILE, COMMAND_TIMEOUT_MS, isLocalKind, isLoopbackLiteral, runCommand, isVirtualMachine, checkHome, requireLocalControl, admitGuestReader };
