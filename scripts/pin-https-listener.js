#!/usr/bin/env node
'use strict';

// Add the HTTP/1.1 pin to the HTTPS listener of an ALREADY-DEPLOYED Caddyfile,
// in place, changing nothing else in it (#848).
//
//   node scripts/pin-https-listener.js --dry-run   say what would change, touch nothing
//   node scripts/pin-https-listener.js             apply it, then restart Caddy
//
// Why this exists. The generator pins `servers :<httpsPort> { protocols h1 }`
// because Chrome aborts terminal WebSockets (1006) when the TLS origin negotiates
// h2/h3. A Caddyfile written before that pin existed stays unpinned, and the
// Caddyfile drift check reports it on every boot — but the obvious remedy does
// not work: the cutover refuses a hand-edited file, and `--force` replaces the
// whole file, taking every other hand edit with it.
//
// Why it is safe on a hand-edited file. The pin is placed on text, but nothing is
// written unless Caddy's own adapter reads the result as identical to the file
// as it is, apart from the listener gaining `protocols h1`
// (`lib/caddy-drift.js#planHttpsListenerPin`). Anything less exact is refused
// with the reason, and the manual steps in deploy/INGRESS.md still apply.
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
  'Usage: node scripts/pin-https-listener.js [--dry-run]\n' +
  '  Adds the HTTP/1.1 pin (servers :<httpsPort> { protocols h1 }) to the live\n' +
  '  Caddyfile without changing anything else in it, then restarts Caddy.\n' +
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
 * Pin the HTTPS listener of one Caddyfile. Every side effect is injected, so the
 * whole decision and its output are testable against a temp file with no `caddy`
 * binary and no launchd.
 *
 * @param {object} opts
 * @param {string} opts.caddyfilePath - The Caddyfile to pin.
 * @param {number} opts.httpsPort - The configured HTTPS port.
 * @param {boolean} [opts.dryRun=false] - Report only.
 * @param {number} opts.uid - Numeric uid for the launchctl target.
 * @param {string} opts.stamp - Filename-safe timestamp for the backup.
 * @param {object} [opts.deps] - Injected collaborators (tests).
 * @param {Function} [opts.deps.plan] - `drift.planHttpsListenerPin`.
 * @param {Function} [opts.deps.validate] - `caddy.validateCaddyfile`.
 * @param {Function} [opts.deps.reload] - `adminCredential.reloadCaddy`.
 * @param {{write: Function}} [opts.stdout]
 * @param {{write: Function}} [opts.stderr]
 * @returns {number} Process exit code: 0 pinned or already pinned, 1 otherwise.
 */
function run(opts) {
  const {
    caddyfilePath, httpsPort, dryRun = false, uid, stamp,
    deps = {},
    stdout = process.stdout,
    stderr = process.stderr
  } = opts;
  const plan = deps.plan || drift.planHttpsListenerPin;
  const validate = deps.validate || caddy.validateCaddyfile;
  const reload = deps.reload || adminCredential.reloadCaddy;

  let content;
  try {
    content = fs.readFileSync(caddyfilePath, 'utf8');
  } catch (err) {
    stderr.write(`ERROR: could not read the Caddyfile at ${caddyfilePath}: ${err.message}\n`);
    return 1;
  }

  const planned = plan(content, httpsPort);
  if (planned.status === drift.PIN_ALREADY) {
    stdout.write(`The HTTPS listener on :${httpsPort} is already pinned to HTTP/1.1. Nothing to do.\n`);
    return 0;
  }
  if (planned.status !== drift.PIN_READY) {
    // `plan` redacts its reasons; redacted again because this is scrollback,
    // and scrollback gets pasted into issues.
    stderr.write(`REFUSED: ${caddy.redactHashes(planned.reason || 'no reason given')}\n`);
    stderr.write('  Nothing was written. The manual steps are in deploy/INGRESS.md\n'
      + '  ("Checking and fixing an already-deployed Caddyfile").\n');
    return 1;
  }

  const where = planned.placement === 'new-global-block'
    ? 'a new global options block at the top of the file'
    : 'the existing global options block';
  if (dryRun) {
    stdout.write(`\n[dry-run] pin the HTTPS listener on :${httpsPort} to HTTP/1.1\n`);
    stdout.write(`  caddyfile: ${caddyfilePath}\n`);
    stdout.write(`  would: add servers :${httpsPort} { protocols h1 } to ${where}\n`);
    stdout.write('         (Caddy reads no other difference — checked with caddy adapt)\n');
    stdout.write(`         → backup + caddy validate (restore on failure) → launchctl ${adminCredential.reloadCaddyArgs(uid).join(' ')}\n\n`);
    return 0;
  }

  const written = adminCredential.writeValidatedCaddyfile(caddyfilePath, planned.content, validate, stamp);
  if (!written.ok) {
    stderr.write(`ERROR: ${caddy.redactHashes(written.error || 'the write failed')}\n`);
    if (written.restored) {
      stderr.write(`  The original was restored (ingress untouched). Backup kept at: ${written.backup}\n`);
    } else {
      stderr.write('  The Caddyfile could not be put back, so it may now be broken.\n'
        + `  A copy of the original is at: ${written.backup}\n`
        + '  Restore it by hand before restarting Caddy.\n');
    }
    return 1;
  }

  stdout.write(`\nPinned the HTTPS listener on :${httpsPort} to HTTP/1.1.\n`);
  stdout.write(`  Caddyfile: ${caddyfilePath}\n  Backup:    ${written.backup}\n`);
  const reloaded = reload(uid);
  if (reloaded.ok) {
    stdout.write('  ✓ Caddy restarted. Restart TangleClaw too, so the dashboard notice re-checks.\n\n');
  } else {
    stderr.write(`WARNING: could not restart Caddy automatically.\n  Run: ${reloaded.command}\n`);
  }
  return 0;
}

/**
 * CLI entry: read the configured HTTPS port and the live Caddyfile path, then
 * `run`.
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

  const store = require(path.join(REPO_DIR, 'lib', 'store'));
  store.init();
  let config;
  try {
    config = store.config.load();
  } finally {
    store.close();
  }

  const caddyfilePath = caddy.getCaddyfilePath();
  if (!fs.existsSync(caddyfilePath)) {
    process.stderr.write(`ERROR: no Caddyfile at ${caddyfilePath}\n`
      + '  The pin belongs to caddy ingress mode; there is nothing to pin.\n');
    process.exit(1);
  }

  // The same default the drift check and the generator use, so the port this
  // pins is the port the check measured.
  const code = run({
    caddyfilePath,
    httpsPort: config.caddyHttpsPort || 8443,
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
