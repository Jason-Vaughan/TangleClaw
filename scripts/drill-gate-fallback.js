#!/usr/bin/env node
'use strict';

// Rehearse the broken-login recovery end to end, on a working install, and say
// whether each step did what the recovery doc promises.
//
//   node scripts/drill-gate-fallback.js --user <caddy user> --password-stdin [--restore <file>]
//
// Reads the Caddy fallback password from stdin (so it never lands in shell
// history or `ps`), then:
//   1. confirms TangleClaw's own login is the gate right now;
//   2. falls back (`scripts/gate-fallback.js`), which puts Caddy's password in
//      front and proves every site challenges for it;
//   3. signs in to each site with the Caddy password and expects to get through;
//   4. confirms TangleClaw reports `fallback`;
//   5. undoes it (`--undo`, restoring a copy of the Caddyfile taken first), and
//      confirms TangleClaw's login is the gate again and the Caddyfile is
//      byte-for-byte what it was.
//
// It does NOT break the login on purpose. The fallback stands down over every
// enforcing state alike (`lib/auth-gate.js#resolveGateState`), so a drill that
// damaged the account store to prove that would risk the install it rehearses
// on for no extra coverage. What it proves is the part only a live machine can:
// that Caddy, launchd, the certificates and TangleClaw agree.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const REPO_DIR = path.resolve(__dirname, '..');
const caddy = require(path.join(REPO_DIR, 'lib', 'caddy'));
const drift = require(path.join(REPO_DIR, 'lib', 'caddy-drift'));
const authGate = require(path.join(REPO_DIR, 'lib', 'auth-gate'));
const gateFallback = require(path.join(REPO_DIR, 'lib', 'gate-fallback'));
const fallbackCmd = require(path.join(REPO_DIR, 'scripts', 'gate-fallback'));

const USAGE =
  'Usage: node scripts/drill-gate-fallback.js --user <caddy user> --password-stdin [--restore <file>]\n' +
  '  Rehearses the broken-login recovery on a working install: falls back to Caddy\'s\n' +
  '  password, signs in with it, and undoes the fallback. Pipe the Caddy password in:\n' +
  '    read -s PW && printf %s "$PW" | node scripts/drill-gate-fallback.js --user <user> --password-stdin\n' +
  '  Run this at a terminal ON the TangleClaw host.\n';

/**
 * Parse CLI args. Pure.
 * @param {string[]} argv
 * @returns {{ user: string|null, passwordStdin: boolean, restore: string|null, help: boolean, unknown: string[] }}
 */
function parseArgs(argv) {
  const result = { user: null, passwordStdin: false, restore: null, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--password-stdin') result.passwordStdin = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--user' || arg === '--restore') {
      if (!value || value.startsWith('--')) result.unknown.push(`${arg} (needs a value)`);
      else { result[arg.slice(2)] = value; i++; }
    } else result.unknown.push(arg);
  }
  return result;
}

/**
 * GET `/` on one site from this machine with a Basic credential.
 * @param {{ port: number, tls: boolean, host: string|null }} target
 * @param {string} user
 * @param {string} password
 * @param {number} [timeoutMs]
 * @returns {Promise<{ status: number|null, basicChallenge: boolean, error: string|null }>}
 */
function getWithCredential(target, user, password, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const client = target.tls ? https : http;
    const host = target.host || '127.0.0.1';
    const options = {
      host: '127.0.0.1', port: target.port, path: '/', method: 'GET', rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: { Host: host, Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` }
    };
    if (target.tls && target.host && net.isIP(target.host) === 0) options.servername = target.host;
    const req = client.request(options, (res) => {
      res.resume();
      resolve({
        status: res.statusCode,
        basicChallenge: /^Basic\b/i.test(String(res.headers['www-authenticate'] || '')),
        error: null
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ status: null, basicChallenge: false, error: err.message }));
    req.end();
  });
}

/**
 * Run the drill. Collaborators are injected so the sequence and its verdicts
 * are testable with no live install.
 *
 * The Caddyfile is copied aside before anything changes, the undo restores that
 * copy, and the last step checks the file on disk is byte-for-byte the one the
 * drill started with — so a drill cannot pass while leaving the install
 * different from how it found it. The copy is kept whenever the drill fails.
 *
 * @param {object} opts
 * @param {string} opts.user - The Caddy fallback username.
 * @param {string} opts.password - The Caddy fallback password.
 * @param {number} opts.port - TangleClaw's port.
 * @param {object} opts.fallbackOpts - Everything `gate-fallback.js#run` needs
 *   except `undo`.
 * @param {string} opts.snapshotPath - Where to copy the Caddyfile aside (0600).
 * @param {object} [opts.deps]
 * @param {{write: Function}} [opts.stdout]
 * @returns {Promise<{ passed: boolean, steps: Array<{ step: string, ok: boolean, detail: string }> }>}
 */
async function drill(opts) {
  const { user, password, port, fallbackOpts, snapshotPath, stdout = process.stdout } = opts;
  const d = {
    queryState: fallbackCmd.queryGateState,
    runFallback: fallbackCmd.run,
    getWithCredential,
    readDoor: () => {
      const adapted = drift.adaptCaddyfile(fallbackOpts.caddyfilePath);
      return adapted.ok
        ? gateFallback.checkFallbackFile(fs.readFileSync(fallbackOpts.caddyfilePath, 'utf8'), adapted.config, port)
        : { ok: false, probes: [], reason: adapted.reason };
    },
    ...(opts.deps || {})
  };
  const steps = [];
  const record = (step, ok, detail) => {
    steps.push({ step, ok, detail });
    stdout.write(`${ok ? '✓' : '✗'} ${step} — ${detail}\n`);
    return ok;
  };
  const readCaddyfile = () => {
    try {
      return fs.readFileSync(fallbackOpts.caddyfilePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };
  const finish = (snapshotted) => {
    const passed = steps.every((s) => s.ok);
    if (snapshotted) {
      if (passed) fs.rmSync(snapshotPath, { force: true });
      else stdout.write(`\nThe Caddyfile as it was before the drill is kept at ${snapshotPath}\n`);
    }
    return { passed, steps };
  };
  const unchanged = (original) => {
    const now = readCaddyfile();
    return record('the Caddyfile is as it was before the drill', now === original,
      now === original ? 'byte-for-byte' : 'it DIFFERS — Caddy\'s password may still be in front of the login');
  };

  const before = await d.queryState(port);
  if (!record('the login is the gate before the drill', authGate.guardsTheDoor(before.state),
    before.state ? `TangleClaw reports "${before.state}"` : `TangleClaw did not answer (${before.error})`)) {
    return finish(false);
  }

  const original = readCaddyfile();
  if (original !== null) {
    fs.writeFileSync(snapshotPath, original, { mode: 0o600 });
    fs.chmodSync(snapshotPath, 0o600);
  }

  const quiet = { write: () => {} };
  const forward = await d.runFallback({ ...fallbackOpts, undo: false, stdout: quiet, stderr: stdout });
  if (!record('fall back to Caddy\'s password', forward === fallbackCmd.EXIT.OK, `gate-fallback exited ${forward}`)) {
    unchanged(original);
    return finish(original !== null);
  }

  const door = d.readDoor();
  record('the fallback door is readable', door.ok === true, door.ok ? `${door.probes.length} site(s) to sign in to` : door.reason);
  for (const target of door.probes || []) {
    const label = `${target.tls ? 'https' : 'http'}://${target.host || '127.0.0.1'}:${target.port}/`;
    const res = await d.getWithCredential(target, user, password);
    record(`sign in to ${label} with Caddy's password`, res.status !== null && res.status >= 200 && res.status < 400,
      res.status === null ? res.error : `HTTP ${res.status}`);
  }

  const during = await d.queryState(port);
  record('TangleClaw reports fallback', during.state === authGate.GATE_STATES.FALLBACK,
    during.state ? `"${during.state}"` : `no answer (${during.error})`);

  // The undo's own report reaches the operator: every case where it keeps
  // Caddy's password in front is explained there.
  const undo = await d.runFallback({
    ...fallbackOpts, undo: true, restore: original !== null ? snapshotPath : null, stdout, stderr: stdout
  });
  record('undo the fallback', undo === fallbackCmd.EXIT.OK, `gate-fallback --undo exited ${undo}`);

  const after = await d.queryState(port);
  record('the login is the gate again', authGate.guardsTheDoor(after.state),
    after.state ? `TangleClaw reports "${after.state}"` : `no answer (${after.error})`);
  unchanged(original);

  return finish(original !== null);
}

/**
 * Read all of stdin as a string.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * CLI entry.
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.unknown.length || !args.user || !args.passwordStdin) {
    process.stderr.write(`${args.unknown.length ? `ERROR: unknown argument(s): ${args.unknown.join(' ')}\n` : ''}${USAGE}`);
    process.exit(1);
  }
  if (process.stdin.isTTY) {
    process.stderr.write('ERROR: --password-stdin needs the password piped in, not typed at this prompt.\n' + USAGE);
    process.exit(1);
  }
  const password = (await readStdin()).replace(/\r?\n$/, '');
  if (!password) {
    process.stderr.write('ERROR: no password on stdin.\n');
    process.exit(1);
  }

  const store = require(path.join(REPO_DIR, 'lib', 'store'));
  const httpsSetup = require(path.join(REPO_DIR, 'lib', 'https-setup'));
  store.init();
  let config;
  let intendedGateState;
  try {
    config = store.config.load();
    intendedGateState = authGate.resolveIntendedGateState(() => config, store.authSessions);
  } finally {
    store.close();
  }
  const lanHost = httpsSetup.mdnsHostFor(require('node:os').hostname());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const caddyfilePath = caddy.getCaddyfilePath();
  const result = await drill({
    snapshotPath: path.join(path.dirname(caddyfilePath), `drill-gate-fallback-${stamp}.Caddyfile`),
    user: args.user,
    password,
    port: config.serverPort,
    fallbackOpts: {
      caddyfilePath,
      markerFile: gateFallback.markerPath(),
      config,
      intendedGateState,
      lanHosts: lanHost ? [null, lanHost] : [null],
      restore: args.restore,
      uid: process.getuid(),
      stamp
    }
  });
  if (fs.existsSync(gateFallback.markerPath())) {
    process.stdout.write('\nNOTE: the fallback marker is still set. Run: node scripts/gate-fallback.js --undo\n');
  }
  process.stdout.write(`\nDrill ${result.passed ? 'PASSED' : 'FAILED'}.\n`);
  if (!result.passed) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`ERROR: ${caddy.redactHashes(err && err.stack ? err.stack : String(err))}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, drill, getWithCredential };
