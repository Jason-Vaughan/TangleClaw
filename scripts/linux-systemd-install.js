#!/usr/bin/env node
'use strict';

/**
 * CLI wrapper around `lib/linux-systemd.js`'s install/verify/status/uninstall
 * orchestrator (#1424, PRR-A Round 1 on PR #2899). Platform dispatch (only
 * calling this on Linux) is the caller's — this script never checks
 * `process.platform` itself, consistent with the library it wraps.
 *
 * Usage: node scripts/linux-systemd-install.js install [--repo-dir <path>] [--node-bin <path>] [--home-dir <path>]
 *        node scripts/linux-systemd-install.js verify [--repo-dir <path>] [--node-bin <path>]
 *        node scripts/linux-systemd-install.js status
 *        node scripts/linux-systemd-install.js uninstall [--home-dir <path>]
 *   install     writes the unit file and brings it up (daemon-reload, enable-linger, enable, start)
 *   verify      generates the unit file and checks it against verifyUnitFileContract, writing nothing
 *   status      reads systemctl --user show tangleclaw.service
 *   uninstall   stops, disables, removes the unit file, and reloads; a no-op success if never installed
 *   --repo-dir  absolute path to the TangleClaw checkout; defaults to this script's own repo root
 *   --node-bin  the node executable to exec; defaults to process.execPath
 *   --home-dir  where the unit file lives under (`$HOME/.config/systemd/user/`); defaults to os.homedir()
 * Exit 0: the subcommand succeeded (verify: the unit file passes its own contract).
 * Exit 1: the subcommand failed, or verify found a violation.
 * Exit 4: the arguments could not be parsed.
 */

const path = require('node:path');

const systemd = require('../lib/linux-systemd');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * Parse argv into a subcommand and options.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{command: string, repoDir: string, nodeBin: string, homeDir: (string|undefined)}}
 * @throws {Error} On a missing/unknown subcommand, an unrecognized flag, or a flag missing its value.
 */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['install', 'verify', 'status', 'uninstall'].includes(command)) {
    throw new Error(`unknown subcommand ${JSON.stringify(command)}; expected install, verify, status or uninstall`);
  }
  const opts = { command, repoDir: REPO_ROOT, nodeBin: process.execPath, homeDir: undefined };
  const takesValue = { '--repo-dir': 'repoDir', '--node-bin': 'nodeBin', '--home-dir': 'homeDir' };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const key = takesValue[flag];
    if (!key) throw new Error(`unrecognized argument '${flag}'`);
    const value = rest[i + 1];
    if (!value) throw new Error(`${flag} needs a non-empty value`);
    opts[key] = value;
    i += 1;
  }
  return opts;
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

  if (opts.command === 'verify') {
    let violations;
    try {
      const content = systemd.generateUnitFile({ repoDir: opts.repoDir, nodeBin: opts.nodeBin });
      violations = systemd.verifyUnitFileContract(content);
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
    const result = await systemd.status();
    if (!result.available) {
      process.stdout.write(`linux-systemd-install: status unavailable — ${result.reason}\n`);
      return 1;
    }
    process.stdout.write(`linux-systemd-install: status — ${JSON.stringify(result.fields)}\n`);
    return 0;
  }

  if (opts.command === 'uninstall') {
    const result = await systemd.uninstall(opts.homeDir ? { homeDir: opts.homeDir } : {});
    process.stdout.write(`linux-systemd-install: uninstall ${result.ok ? 'ok' : 'failed'} — ${result.file}\n`);
    return result.ok ? 0 : 1;
  }

  // install
  let result;
  try {
    result = await systemd.install({ repoDir: opts.repoDir, nodeBin: opts.nodeBin, ...(opts.homeDir ? { homeDir: opts.homeDir } : {}) });
  } catch (err) {
    process.stderr.write(`linux-systemd-install: install refused — ${err.message}\n`);
    return 1;
  }
  process.stdout.write(`linux-systemd-install: install ${result.ok ? 'ok' : 'failed'} — ${result.file}\n`);
  return result.ok ? 0 : 1;
}

module.exports = { parseArgs, main, REPO_ROOT };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
