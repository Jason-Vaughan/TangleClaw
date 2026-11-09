#!/usr/bin/env node
'use strict';

/**
 * CLI wrapper around `lib/linux-systemd.js`'s install/verify/status/uninstall
 * orchestrator (#1424, PRR-A Round 1 on PR #2899), extended for the three
 * companion units (#2931, Car 5730-W1-B): `ttyd`, `caddy`, and the Discord
 * `bridge-helper`. Platform dispatch (only calling this on Linux) is the
 * caller's — this script never checks `process.platform` itself, consistent
 * with the library it wraps.
 *
 * `--unit` picks which unit a subcommand acts on and defaults to `server` —
 * every existing invocation with no `--unit` flag keeps doing exactly what
 * it did before #2931 (install.sh/callers never pass it). This script, not
 * `lib/linux-systemd.js`, resolves each companion's REAL inputs (a real
 * `ttyd` binary via `lib/ttyd-runtime.js`, a real `caddy` binary via `which`,
 * the generated Caddyfile's path) — the same split `scripts/ingress-
 * cutover.js` makes for the macOS plists: the library's generators stay
 * pure and parametrized, this script is the one that knows how to find
 * real values on a real machine.
 *
 * Usage: node scripts/linux-systemd-install.js install   [--unit <unit>] [options...]
 *        node scripts/linux-systemd-install.js verify    [--unit <unit>] [options...]
 *        node scripts/linux-systemd-install.js status    [--unit <unit>]
 *        node scripts/linux-systemd-install.js uninstall  [--unit <unit>] [--home-dir <path>]
 *   install     writes the unit file and brings it up (daemon-reload, enable-linger, enable, start)
 *   verify      generates the unit file and checks it against its own contract, writing nothing
 *   status      reads systemctl --user show <unit>
 *   uninstall   stops, disables, removes the unit file, and reloads; a no-op success if never installed
 *
 *   --unit                 server | ttyd | caddy | bridge-helper. Defaults to "server".
 *   --repo-dir             absolute path to the TangleClaw checkout. (server, bridge-helper)
 *                          Defaults to this script's own repo root.
 *   --node-bin             the node executable to exec. (server, bridge-helper) Defaults to process.execPath.
 *   --home-dir             where the unit file lives under (`$HOME/.config/systemd/user/`), and — for
 *                          caddy — the home its XDG_DATA_HOME/XDG_CONFIG_HOME are built under.
 *                          Defaults to os.homedir().
 *   --base-dir             TangleClaw's base directory (`~/.tangleclaw`), used to resolve ttyd/caddy
 *                          defaults below. (ttyd, caddy) Defaults to lib/tangleclaw-home.js#baseDir().
 *   --mode                 direct | caddy. (ttyd only) Defaults to "direct": ttyd binds --interface
 *                          127.0.0.1. In "caddy" mode it binds a Unix socket under --base-dir/run/
 *                          instead (AUTH-1, #395/#710 — ttyd must never bind an unqualified interface).
 *   --ttyd-path            absolute path to the ttyd binary. (ttyd) Defaults to
 *                          lib/ttyd-runtime.js#resolveTtydPath({baseDir}).path.
 *   --ttyd-port            TCP port. (ttyd) Defaults to 3100.
 *   --ttyd-attach-script   absolute path to ttyd-attach.sh. (ttyd) Defaults to
 *                          lib/ttyd-attach.js#attachScriptPath(baseDir).
 *   --caddy-path           absolute path to the caddy binary. (caddy) Defaults to `which caddy`.
 *   --caddyfile            absolute path to the generated Caddyfile. (caddy) Defaults to
 *                          --base-dir/Caddyfile.
 * Exit 0: the subcommand succeeded (verify: the unit file passes its own contract).
 * Exit 1: the subcommand failed, verify found a violation, or a required value could not be resolved.
 * Exit 4: the arguments could not be parsed.
 */

const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const systemd = require('../lib/linux-systemd');
const tangleclawHome = require('../lib/tangleclaw-home');
const ttydRuntime = require('../lib/ttyd-runtime');
const ttydAttach = require('../lib/ttyd-attach');

const REPO_ROOT = path.join(__dirname, '..');

const UNITS = ['server', 'ttyd', 'caddy', 'bridge-helper'];

/**
 * The `caddy` binary's absolute path, or `null` if it is not on `PATH`.
 * Mirrors `scripts/ingress-cutover.js`'s own local `which()` helper — there
 * is no exported cross-platform resolver for this today (`lib/caddy.js`'s
 * `detectCaddy()` runs `caddy version` via `PATH` lookup for availability,
 * never returning the resolved absolute path).
 * @param {string} bin
 * @returns {string|null}
 */
function which(bin) {
  try {
    const out = execFileSync('/usr/bin/which', [bin], { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// A test seam, the same shape `lib/linux-systemd.js`'s own `_internal.exec`
// is: `resolveUnit` calls `_internal.which`, never the bare `which` above
// directly, so a test can replace it without touching PATH or /usr/bin/which.
const _internal = { which };

/**
 * Parse argv into a subcommand and options.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {object}
 * @throws {Error} On a missing/unknown subcommand, an unrecognized flag, a flag missing its value, or an invalid --unit/--mode/--ttyd-port.
 */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['install', 'verify', 'status', 'uninstall'].includes(command)) {
    throw new Error(`unknown subcommand ${JSON.stringify(command)}; expected install, verify, status or uninstall`);
  }
  const opts = {
    command, unit: 'server', repoDir: REPO_ROOT, nodeBin: process.execPath, homeDir: undefined,
    baseDir: undefined, mode: 'direct', ttydPath: undefined, ttydPort: undefined,
    ttydAttachScript: undefined, caddyPath: undefined, caddyfile: undefined
  };
  const takesValue = {
    '--unit': 'unit', '--repo-dir': 'repoDir', '--node-bin': 'nodeBin', '--home-dir': 'homeDir',
    '--base-dir': 'baseDir', '--mode': 'mode', '--ttyd-path': 'ttydPath', '--ttyd-port': 'ttydPort',
    '--ttyd-attach-script': 'ttydAttachScript', '--caddy-path': 'caddyPath', '--caddyfile': 'caddyfile'
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const key = takesValue[flag];
    if (!key) throw new Error(`unrecognized argument '${flag}'`);
    const value = rest[i + 1];
    if (!value) throw new Error(`${flag} needs a non-empty value`);
    opts[key] = value;
    i += 1;
  }
  if (!UNITS.includes(opts.unit)) {
    throw new Error(`--unit must be one of ${UNITS.join(', ')} (got ${JSON.stringify(opts.unit)})`);
  }
  if (opts.mode !== 'direct' && opts.mode !== 'caddy') {
    throw new Error(`--mode must be "direct" or "caddy" (got ${JSON.stringify(opts.mode)})`);
  }
  if (opts.ttydPort !== undefined) {
    const n = Number(opts.ttydPort);
    if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
      throw new Error(`--ttyd-port must be a valid TCP port number (got ${JSON.stringify(opts.ttydPort)})`);
    }
    opts.ttydPort = n;
  }
  return opts;
}

/**
 * Resolve everything a subcommand needs for the `--unit` the caller picked:
 * the unit's `serviceName`, a `generate()` thunk (pure, for `verify`), and
 * an `install()` thunk (brings it up). `lib/linux-systemd.js`'s own
 * generators/installers stay pure — all the "find a real binary/path on
 * this machine" work happens inside those two thunks, so `verify` and
 * `install` resolve identically, and `uninstallOpts`/`statusOpts` (which
 * never need a real ttyd/caddy binary, only a `serviceName`) never trigger
 * that resolution at all. Never throws itself.
 * @param {object} opts - From {@link parseArgs}.
 * @returns {{serviceName: string, generate: () => string, install: () => Promise<object>, uninstallOpts: object, statusOpts: object}}
 */
function resolveUnit(opts) {
  const homeDir = opts.homeDir || os.homedir();

  if (opts.unit === 'server') {
    const genOpts = () => ({ repoDir: opts.repoDir, nodeBin: opts.nodeBin });
    return {
      serviceName: systemd.SERVICE_NAME,
      generate: () => systemd.generateUnitFile(genOpts()),
      install: () => systemd.install({ ...genOpts(), homeDir }),
      uninstallOpts: { serviceName: systemd.SERVICE_NAME, homeDir },
      statusOpts: { serviceName: systemd.SERVICE_NAME }
    };
  }

  // `genOpts()` below is deliberately a THUNK, called only from `generate`/
  // `install` — never from `uninstallOpts`/`statusOpts`, which need only a
  // `serviceName` and `homeDir`. Resolving a real ttyd runtime or a real
  // `caddy` on `PATH` just to STOP or REMOVE a unit (or read its status)
  // would make those two subcommands fail on a machine where the thing
  // being uninstalled/queried is already gone or was never resolvable.

  if (opts.unit === 'ttyd') {
    const genOpts = () => {
      const baseDir = opts.baseDir || tangleclawHome.baseDir();
      const ttydPath = opts.ttydPath || ttydRuntime.resolveTtydPath({ baseDir }).path;
      const attachScriptPath = opts.ttydAttachScript || ttydAttach.attachScriptPath(baseDir);
      const port = opts.ttydPort || 3100;
      const socketPath = opts.mode === 'caddy' ? path.join(baseDir, 'run', 'ttyd.sock') : '';
      const bindVal = opts.mode === 'caddy' ? socketPath : '127.0.0.1';
      return { ttydPath, attachScriptPath, bindVal, port, socketPath };
    };
    return {
      serviceName: systemd.TTYD_SERVICE_NAME,
      generate: () => systemd.generateTtydUnitFile(genOpts()),
      install: () => systemd.installTtyd({ ...genOpts(), homeDir }),
      uninstallOpts: { serviceName: systemd.TTYD_SERVICE_NAME, homeDir },
      statusOpts: { serviceName: systemd.TTYD_SERVICE_NAME }
    };
  }

  if (opts.unit === 'caddy') {
    const genOpts = () => {
      const baseDir = opts.baseDir || tangleclawHome.baseDir();
      const caddyPath = opts.caddyPath || _internal.which('caddy');
      if (!caddyPath) throw new Error('caddy was not found on PATH; pass --caddy-path explicitly');
      const caddyfilePath = opts.caddyfile || path.join(baseDir, 'Caddyfile');
      return { caddyPath, caddyfilePath, homeDir };
    };
    return {
      serviceName: systemd.CADDY_SERVICE_NAME,
      generate: () => systemd.generateCaddyUnitFile(genOpts()),
      install: () => systemd.installCaddy(genOpts()),
      uninstallOpts: { serviceName: systemd.CADDY_SERVICE_NAME, homeDir },
      statusOpts: { serviceName: systemd.CADDY_SERVICE_NAME }
    };
  }

  // bridge-helper
  const genOpts = () => ({ repoDir: opts.repoDir, nodeBin: opts.nodeBin });
  return {
    serviceName: systemd.BRIDGE_HELPER_SERVICE_NAME,
    generate: () => systemd.generateBridgeHelperUnitFile(genOpts()),
    install: () => systemd.installBridgeHelper({ ...genOpts(), homeDir }),
    uninstallOpts: { serviceName: systemd.BRIDGE_HELPER_SERVICE_NAME, homeDir },
    statusOpts: { serviceName: systemd.BRIDGE_HELPER_SERVICE_NAME }
  };
}

/**
 * CLI entry point.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {Promise<number>} Exit code.
 */
async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`linux-systemd-install: ${err.message}\n`);
    return 4;
  }

  // Pure descriptor construction — never throws. The actual "find a real
  // ttyd/caddy on this machine" work is a thunk inside `unit.generate`/
  // `unit.install`, called (and its own errors caught) only by the
  // subcommands that need it, below.
  const unit = resolveUnit(opts);

  if (opts.command === 'verify') {
    let violations;
    try {
      const content = unit.generate();
      violations = (
        opts.unit === 'server' ? systemd.verifyUnitFileContract
          : opts.unit === 'ttyd' ? systemd.verifyTtydUnitFileContract
            : opts.unit === 'caddy' ? systemd.verifyCaddyUnitFileContract
              : systemd.verifyBridgeHelperUnitFileContract
      )(content);
    } catch (err) {
      process.stderr.write(`linux-systemd-install: could not generate the unit file — ${err.message}\n`);
      return 1;
    }
    if (violations.length > 0) {
      process.stdout.write(`linux-systemd-install: verify failed — ${violations.join('; ')}\n`);
      return 1;
    }
    process.stdout.write('linux-systemd-install: verify passed — the generated unit file meets its own contract\n');
    return 0;
  }

  if (opts.command === 'status') {
    const result = await systemd.status(unit.statusOpts);
    if (!result.available) {
      process.stdout.write(`linux-systemd-install: status unavailable — ${result.reason}\n`);
      return 1;
    }
    process.stdout.write(`linux-systemd-install: status — ${JSON.stringify(result.fields)}\n`);
    return 0;
  }

  if (opts.command === 'uninstall') {
    const result = await systemd.uninstall(unit.uninstallOpts);
    process.stdout.write(`linux-systemd-install: uninstall ${result.ok ? 'ok' : 'failed'} — ${result.file}\n`);
    return result.ok ? 0 : 1;
  }

  // install
  let result;
  try {
    result = await unit.install();
  } catch (err) {
    process.stderr.write(`linux-systemd-install: install refused — ${err.message}\n`);
    return 1;
  }
  process.stdout.write(`linux-systemd-install: install ${result.ok ? 'ok' : 'failed'} — ${result.file}\n`);
  return result.ok ? 0 : 1;
}

module.exports = { parseArgs, resolveUnit, which, _internal, main, REPO_ROOT, UNITS };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
