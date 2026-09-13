#!/usr/bin/env node
'use strict';

// Restrict every site that forwards to TangleClaw without a password, in an
// ALREADY-DEPLOYED Caddyfile, to this machine — in place, changing nothing else.
// A site forwarding anywhere else is left alone: it may front a service the
// operator means to be reachable.
//
//   node scripts/guard-ungated-sites.js --dry-run   say what would change, touch nothing
//   node scripts/guard-ungated-sites.js             apply it, then restart Caddy
//
// Why this exists. Caddy listens on every interface and picks a site by the host
// name the client sends, so a `localhost` site with no `basic_auth` serves any
// machine that asks for `localhost`. The generator now adds a peer guard to such
// sites (`lib/caddy.js#OFFBOX_GUARD_LINES`), but a Caddyfile already on disk
// keeps its old blocks until something rewrites it, and the cutover refuses a
// hand-edited file.
//
// Why it is safe on a hand-edited file. The guard is placed on text, but nothing
// is written unless Caddy's own adapter reads the result as the file as it is
// plus the guard routes, with every site that proxies with no gate now refusing
// other machines (`lib/caddy-drift.js#planOffboxGuard`). Anything less exact is
// refused with the reason, and the manual steps in deploy/INGRESS.md still apply.
//
// Fail-closed write: a timestamped 0600 backup is taken, the new file is
// `caddy validate`d, and the backup is restored if it does not validate — the
// same writer the break-glass credential reset uses.

const fs = require('node:fs');
const path = require('node:path');

const REPO_DIR = path.resolve(__dirname, '..');
const caddy = require(path.join(REPO_DIR, 'lib', 'caddy'));
const drift = require(path.join(REPO_DIR, 'lib', 'caddy-drift'));
const adminCredential = require(path.join(REPO_DIR, 'lib', 'admin-credential'));

const USAGE =
  'Usage: node scripts/guard-ungated-sites.js [--dry-run]\n' +
  '  Restricts every site in the live Caddyfile that forwards to TangleClaw with\n' +
  '  no password to this machine, without changing anything else in the file,\n' +
  '  then restarts Caddy.\n' +
  '  Refuses, and says why, whenever Caddy would read any other difference.\n' +
  '  Run this at a terminal ON the TangleClaw host.\n';

/**
 * Parse CLI args. Pure, so it is unit-testable.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ dryRun: boolean, help: boolean, unknown: string[] }}
 */
function parseArgs(argv) {
  const result = { dryRun: false, help: false, unknown: [] };
  for (const arg of argv) {
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else result.unknown.push(arg);
  }
  return result;
}

/**
 * Guard the ungated sites of one Caddyfile. Every side effect is injected, so
 * the whole decision and its output are testable against a temp file with no
 * `caddy` binary and no launchd.
 *
 * Unlike the listener pin, this does NOT refuse outside caddy ingress mode: a
 * Caddyfile left behind by a `--to direct` cutover is still served if Caddy's
 * job is still loaded, and restricting it can only take access away.
 *
 * @param {object} opts
 * @param {string} opts.caddyfilePath - The Caddyfile to guard.
 * @param {number} opts.serverPort - TangleClaw's port (`config.serverPort`).
 * @param {string|null} [opts.gateState] - TangleClaw's gate state
 *   (`lib/auth-gate.js#resolveGateState`). When its own login guards the door
 *   the plan refuses: those sites answer other machines on purpose.
 * @param {boolean} [opts.dryRun=false] - Report only.
 * @param {number} opts.uid - Numeric uid for the launchctl target.
 * @param {string} opts.stamp - Filename-safe timestamp for the backup.
 * @param {object} [opts.deps] - Injected collaborators (tests).
 * @param {Function} [opts.deps.plan] - `drift.planOffboxGuard`.
 * @param {Function} [opts.deps.validate] - `caddy.validateCaddyfile`.
 * @param {Function} [opts.deps.reload] - `adminCredential.reloadCaddy`.
 * @param {{write: Function}} [opts.stdout]
 * @param {{write: Function}} [opts.stderr]
 * @returns {number} Process exit code: 0 guarded (and Caddy restarted), already
 *   guarded, or dry run; 1 refused or failed with nothing live changed; 2 guarded
 *   on disk but Caddy could not be restarted, so the guard is NOT live yet.
 */
function run(opts) {
  const {
    caddyfilePath, serverPort, gateState = null, dryRun = false, uid, stamp,
    deps = {},
    stdout = process.stdout,
    stderr = process.stderr
  } = opts;
  const plan = deps.plan || drift.planOffboxGuard;
  const validate = deps.validate || caddy.validateCaddyfile;
  const reload = deps.reload || adminCredential.reloadCaddy;

  let content;
  try {
    content = fs.readFileSync(caddyfilePath, 'utf8');
  } catch (err) {
    stderr.write(`ERROR: could not read the Caddyfile at ${caddyfilePath}: ${err.message}\n`);
    return 1;
  }

  const planned = plan(content, serverPort, undefined, gateState);
  if (planned.status === drift.GUARD_ALREADY) {
    stdout.write('Every site forwarding to TangleClaw without a password already refuses other machines. Nothing to do.\n');
    return 0;
  }
  if (planned.status !== drift.GUARD_READY) {
    // `plan` redacts its reasons; redacted again because this is scrollback,
    // and scrollback gets pasted into issues.
    stderr.write(`REFUSED: ${caddy.redactHashes(planned.reason || 'no reason given')}\n`);
    stderr.write('  Nothing was written. The manual steps are in deploy/INGRESS.md\n'
      + '  ("Sites without a password answer only this machine").\n');
    return 1;
  }

  const sites = planned.guarded.join(', ');
  if (dryRun) {
    stdout.write('\n[dry-run] restrict sites without a password to this machine\n');
    stdout.write(`  caddyfile: ${caddyfilePath}\n`);
    stdout.write(`  would: add the peer guard to ${sites}\n`);
    stdout.write('         (Caddy reads no other difference — checked with caddy adapt)\n');
    stdout.write(`         → backup + caddy validate (restore on failure) → launchctl ${adminCredential.reloadCaddyArgs(uid).join(' ')}\n\n`);
    return 0;
  }

  return adminCredential.applyCaddyfileInPlace({
    caddyfilePath, content: planned.content, validate, reload, uid, stamp, stdout, stderr,
    change: 'the guard',
    nextStep: 'Restart TangleClaw too, so the dashboard notice re-checks.',
    onWritten: (backup) => {
      stdout.write(`\nRestricted ${sites} to this machine.\n`);
      stdout.write(`  Caddyfile: ${caddyfilePath}\n  Backup:    ${backup}\n`);
    }
  }).code;
}

/**
 * CLI entry: find the live Caddyfile, then `run`.
 * @returns {void}
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.unknown.length) {
    process.stderr.write(`ERROR: unknown argument(s): ${args.unknown.join(' ')}\n${USAGE}`);
    process.exit(1);
  }

  // Config for TangleClaw's port — which sites are TangleClaw's — the store for
  // the base path the Caddyfile lives under, and the gate state as CONFIGURED,
  // exactly as the cutover reads it: a writer asking the file it rewrites would
  // keep refusing to guard a file whose missing gate it read as the login's.
  // `authGate.resolveIntendedGateState` says why.
  const store = require(path.join(REPO_DIR, 'lib', 'store'));
  const authGate = require(path.join(REPO_DIR, 'lib', 'auth-gate'));
  store.init();
  let caddyfilePath;
  let config;
  let gateState;
  try {
    caddyfilePath = caddy.getCaddyfilePath();
    config = store.config.load();
    gateState = authGate.resolveIntendedGateState(() => config, store.authSessions);
  } finally {
    store.close();
  }

  if (!fs.existsSync(caddyfilePath)) {
    process.stderr.write(`ERROR: no Caddyfile at ${caddyfilePath}\n`
      + '  There is no Caddy site to restrict.\n');
    process.exit(1);
  }

  const code = run({
    caddyfilePath,
    serverPort: config.serverPort,
    gateState,
    dryRun: args.dryRun,
    uid: process.getuid(),
    stamp: new Date().toISOString().replace(/[:.]/g, '-')
  });
  if (code !== 0) process.exit(code);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, run };
