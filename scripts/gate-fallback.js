#!/usr/bin/env node
'use strict';

// Stand TangleClaw's login down behind Caddy's password, when the login itself
// is what broke — and stand it back up afterwards.
//
//   node scripts/gate-fallback.js --dry-run            say what would happen, touch nothing
//   node scripts/gate-fallback.js                      fall back
//   node scripts/gate-fallback.js --restore <file>     fall back to a saved Caddyfile (a backup)
//   node scripts/gate-fallback.js --undo               re-arm the login, then drop Caddy's password
//
// Run it at a terminal ON the TangleClaw host (over SSH is fine). It is not a
// route and has no remote form: a broken gate is recovered from a shell (ADR
// 0009 rule 5, as amended by ADR 0016's ruling).
//
// The order is the whole design (ADR 0016 addendum, "What the switch does"):
//   1. put Caddy's `basic_auth` in front of every route to TangleClaw — or find
//      it already there — checked with `caddy adapt`;
//   2. `caddy validate`, restart Caddy, and see each site answer 401 with a Basic
//      challenge from THIS machine;
//   3. only then write the marker TangleClaw reads (`lib/gate-fallback.js`).
// `--undo` runs it backwards: remove the marker, see TangleClaw enforce again,
// and only then take `basic_auth` out of a file this tool can reproduce.
//
// TangleClaw re-checks the door itself on every change of the Caddyfile, so a
// marker left behind by a half-finished run can never open anything.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const REPO_DIR = path.resolve(__dirname, '..');
const caddy = require(path.join(REPO_DIR, 'lib', 'caddy'));
const drift = require(path.join(REPO_DIR, 'lib', 'caddy-drift'));
const authGate = require(path.join(REPO_DIR, 'lib', 'auth-gate'));
const adminCredential = require(path.join(REPO_DIR, 'lib', 'admin-credential'));
const gateFallback = require(path.join(REPO_DIR, 'lib', 'gate-fallback'));

const USAGE =
  'Usage: node scripts/gate-fallback.js [--dry-run] [--restore <file>] [--undo]\n' +
  '  Falls back from TangleClaw\'s login to Caddy\'s password (basic_auth) when the\n' +
  '  login is broken: puts basic_auth in front of TangleClaw, checks Caddy serves it,\n' +
  '  and only then tells TangleClaw to stand down.\n' +
  '  --restore <file>  use this saved Caddyfile (e.g. a .bak) as the fallback door\n' +
  '  --undo            re-arm TangleClaw\'s login, then drop basic_auth again\n' +
  '  --dry-run         say what would happen and change nothing\n' +
  '  Run this at a terminal ON the TangleClaw host.\n';

/** Exit codes. */
const EXIT = Object.freeze({
  OK: 0,
  REFUSED: 1,
  NOT_LIVE: 2,
  NOT_HONOURED: 3
});

/**
 * Parse CLI args. Pure.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ dryRun: boolean, undo: boolean, restore: string|null, help: boolean, unknown: string[] }}
 */
function parseArgs(argv) {
  const result = { dryRun: false, undo: false, restore: null, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--undo') result.undo = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--restore') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) result.unknown.push('--restore (needs a file)');
      else { result.restore = value; i++; }
    } else result.unknown.push(arg);
  }
  return result;
}

/**
 * Rebuild a TangleClaw-generated Caddyfile for another gate state, proving first
 * that the same inputs reproduce the file on disk byte for byte.
 *
 * The inputs are the ones the cutover used: ports, certificate and access log
 * read back out of the file, and the sites (tailnet host, plain-HTTP catch-all,
 * public domain, LAN name) from config. The round trip is what makes the rebuild
 * differ from the original by exactly the gate: a file carrying anything these
 * inputs do not reproduce is refused, never approximated.
 *
 * @param {string} content - The Caddyfile on disk.
 * @param {object} config - Loaded TangleClaw config.
 * @param {object} opts
 * @param {string} opts.fromState - The gate state the file on disk was written for.
 * @param {string} opts.toState - The gate state to write for.
 * @param {Array<string|null>} opts.lanHosts - LAN names the file may carry (null = none).
 * @returns {{ ok: true, content: string } | { ok: false, reason: string }}
 */
function rebuildGenerated(content, config, { fromState, toState, lanHosts }) {
  if (!caddy.isGeneratedCaddyfile(content)) {
    return { ok: false, reason: 'the Caddyfile is hand-maintained, so this tool will not rebuild it' };
  }
  const derived = caddy.extractGeneratedCaddyfileOptions(content);
  if (!derived) {
    return { ok: false, reason: 'the generated Caddyfile\'s ports, upstream or certificate could not be read back' };
  }
  const credential = config.basicAuthUser && config.basicAuthHash
    && caddy.BCRYPT_HASH_RE.test(config.basicAuthHash)
    ? { basicAuthUser: config.basicAuthUser, basicAuthHash: config.basicAuthHash }
    : { basicAuthUser: null, basicAuthHash: null };
  const inputs = (lanHost, gateState) => ({
    ...derived,
    publicDomain: config.publicDomain || null,
    remoteHttpCatchAll: config.caddyRemoteHttp === true,
    tailnetHost: config.caddyTailnetHost || null,
    lanHost,
    gateState,
    ...credential
  });
  for (const lanHost of lanHosts) {
    let original;
    try {
      original = caddy.buildCaddyfileContent(inputs(lanHost, fromState));
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    if (original !== content) continue;
    try {
      return { ok: true, content: caddy.buildCaddyfileContent(inputs(lanHost, toState)) };
    } catch (err) {
      // The generator refuses a remote site with no gate — the fallback asked for
      // one and has no credential to gate it with.
      return { ok: false, reason: err.message };
    }
  }
  return {
    ok: false,
    reason: 'the Caddyfile is stamped as generated but carries settings this tool cannot reproduce from '
      + 'config, so rebuilding it could drop them'
  };
}

/**
 * Ask one site, from this machine, whether Caddy challenges it for a password.
 *
 * TangleClaw's own login answers 401 too, so 401 alone proves nothing: only a
 * `WWW-Authenticate: Basic` challenge is Caddy's gate.
 *
 * @param {{ port: number, tls: boolean, host: string|null }} target
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
function probeBasicChallenge(target, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const client = target.tls ? https : http;
    const host = target.host || '127.0.0.1';
    const options = {
      host: '127.0.0.1',
      port: target.port,
      path: '/',
      method: 'GET',
      headers: { Host: host },
      rejectUnauthorized: false,
      timeout: timeoutMs
    };
    if (target.tls && target.host && net.isIP(target.host) === 0) options.servername = target.host;
    let req;
    try {
      req = client.request(options, (res) => {
        res.resume();
        const challenge = String(res.headers['www-authenticate'] || '');
        const ok = res.statusCode === 401 && /^Basic\b/i.test(challenge);
        resolve({ ok, detail: `HTTP ${res.statusCode}${challenge ? ` (${challenge.split(' ')[0]} challenge)` : ''}` });
      });
    } catch (err) {
      resolve({ ok: false, detail: err.message });
      return;
    }
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ ok: false, detail: err.message }));
    req.end();
  });
}

/**
 * Ask the running TangleClaw which gate state it is in, as a local tool (no
 * browser headers, no cookie — the fleet carve-out answers `/api/auth/me`).
 *
 * @param {number} port - TangleClaw's port.
 * @param {number} [timeoutMs]
 * @returns {Promise<{ state: string|null, error: string|null }>}
 */
async function queryGateState(port, timeoutMs = 3000) {
  const attempt = (client) => new Promise((resolve) => {
    let req;
    try {
      req = client.get({ host: '127.0.0.1', port, path: '/api/auth/me', rejectUnauthorized: false, timeout: timeoutMs },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try {
              const state = JSON.parse(body).gateState;
              resolve({ state: typeof state === 'string' ? state : null, error: typeof state === 'string' ? null : 'no gateState in the answer' });
            } catch (err) {
              resolve({ state: null, error: `unreadable answer (${err.message})` });
            }
          });
        });
    } catch (err) {
      resolve({ state: null, error: err.message });
      return;
    }
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ state: null, error: err.message }));
  });
  const plain = await attempt(http);
  if (plain.state !== null) return plain;
  const tls = await attempt(https);
  return tls.state !== null ? tls : plain;
}

/**
 * Retry an async check until it passes or the tries run out.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {(result: T) => boolean} done
 * @param {number} tries
 * @param {(ms: number) => Promise<void>} sleep
 * @param {number} delayMs
 * @returns {Promise<T>} The last result.
 */
async function retry(fn, done, tries, sleep, delayMs) {
  let result = await fn();
  for (let i = 1; i < tries && !done(result); i++) {
    await sleep(delayMs);
    result = await fn();
  }
  return result;
}

/**
 * Fall back, or undo. Every side effect is injected, so the whole decision and
 * its output are testable against a temp directory with no `caddy`, no launchd
 * and no running server.
 *
 * @param {object} opts
 * @param {string} opts.caddyfilePath - The live Caddyfile.
 * @param {string} opts.markerFile - From `gateFallback.markerPath()`.
 * @param {object} opts.config - Loaded TangleClaw config.
 * @param {string} opts.intendedGateState - `authGate.resolveIntendedGateState`.
 * @param {Array<string|null>} opts.lanHosts - LAN names a generated file may carry.
 * @param {boolean} [opts.undo=false]
 * @param {boolean} [opts.dryRun=false]
 * @param {string|null} [opts.restore=null] - A saved Caddyfile to use.
 * @param {number} opts.uid - For the launchctl target.
 * @param {string} opts.stamp - Filename-safe timestamp for the backup.
 * @param {object} [opts.deps] - Injected collaborators (tests).
 * @param {{write: Function}} [opts.stdout]
 * @param {{write: Function}} [opts.stderr]
 * @returns {Promise<number>} An {@link EXIT} code.
 */
async function run(opts) {
  const {
    caddyfilePath, markerFile, config, intendedGateState, lanHosts = [null],
    undo = false, dryRun = false, restore = null, uid, stamp,
    deps = {}, stdout = process.stdout, stderr = process.stderr
  } = opts;
  const d = {
    adapt: drift.adaptCaddyfile,
    adaptContent: drift.adaptCaddyfileContent,
    validate: caddy.validateCaddyfile,
    reload: adminCredential.reloadCaddy,
    probe: probeBasicChallenge,
    queryState: queryGateState,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    tries: 10,
    delayMs: 1000,
    now: () => new Date(),
    ...deps
  };
  const port = config.serverPort;
  const say = (text) => stdout.write(`${text}\n`);
  const fail = (text) => stderr.write(`${caddy.redactHashes(text)}\n`);

  let current = null;
  try {
    current = fs.readFileSync(caddyfilePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      fail(`ERROR: could not read the Caddyfile at ${caddyfilePath}: ${err.message}`);
      return EXIT.REFUSED;
    }
  }

  let restored = null;
  if (restore) {
    try {
      restored = fs.readFileSync(restore, 'utf8');
    } catch (err) {
      fail(`ERROR: could not read ${restore}: ${err.message}`);
      return EXIT.REFUSED;
    }
    if (current === null) {
      fail('REFUSED: there is no Caddyfile to restore over; --restore replaces a live one.');
      return EXIT.REFUSED;
    }
  }

  /**
   * Write new content with a backup, validate, restart Caddy.
   * @param {string} content
   * @returns {number|null} An exit code on failure, null on success.
   */
  const writeAndReload = (content) => {
    const written = adminCredential.writeValidatedCaddyfile(caddyfilePath, content, d.validate, stamp);
    if (!written.ok) {
      fail(`ERROR: ${written.error || 'the write failed'}`);
      fail(written.restored
        ? `  The original was restored. Backup kept at: ${written.backup}`
        : `  The Caddyfile could not be put back. A copy of the original is at: ${written.backup}`);
      return EXIT.REFUSED;
    }
    say(`  Caddyfile written (backup: ${written.backup}).`);
    const reloaded = d.reload(uid);
    if (!reloaded.ok) {
      fail('WARNING: the Caddyfile is written but Caddy could not be restarted, so it is NOT live yet.');
      fail(`  Why: ${reloaded.error || 'no reason given'}`);
      fail(`  Run: ${reloaded.command}  then run this command again.`);
      return EXIT.NOT_LIVE;
    }
    say('  ✓ Caddy restarted.');
    return null;
  };

  if (undo) return runUndo();
  return runForward();

  /** @returns {Promise<number>} */
  async function runForward() {
    say(`\n${dryRun ? '[dry-run] ' : ''}Fall back from TangleClaw's login to Caddy's password`);
    let door;

    if (current === null) {
      if (config.ingressMode !== 'direct') {
        fail(`REFUSED: there is no Caddyfile at ${caddyfilePath}, but this install is in `
          + `${config.ingressMode || 'an unknown'} ingress mode. There is no Caddy door to fall back to.`);
        return EXIT.REFUSED;
      }
      say('  Direct mode, no Caddyfile: TangleClaw will stand down only while it listens on loopback,');
      say('  so the dashboard is reachable from this machine alone.');
      door = { ok: true, reason: null, probes: [] };
    } else {
      const live = d.adapt(caddyfilePath);
      const liveDoor = live.ok ? gateFallback.checkFallbackDoor(live.config, port) : null;
      let candidate = null;

      if (restored !== null) {
        candidate = restored;
      } else if (liveDoor && liveDoor.ok) {
        say('  The live Caddyfile already puts a gate in front of every route to TangleClaw. Not rewriting it.');
        door = liveDoor;
      } else {
        const why = live.ok ? liveDoor.reason : `caddy adapt could not read it: ${live.reason}`;
        const rebuilt = rebuildGenerated(current, config, {
          fromState: intendedGateState, toState: authGate.GATE_STATES.FALLBACK, lanHosts
        });
        if (!rebuilt.ok) {
          fail(`REFUSED: the live Caddyfile is not a fallback door (${why}),`);
          fail(`  and it cannot be rebuilt as one: ${rebuilt.reason}.`);
          fail('  Nothing was written. Either restore a Caddyfile that gates every route with');
          fail('  --restore <file> (a .bak next to the Caddyfile), or remove the ungated routes by hand.');
          return EXIT.REFUSED;
        }
        candidate = rebuilt.content;
      }

      if (candidate !== null) {
        const adapted = d.adaptContent(candidate);
        if (!adapted.ok) {
          fail(`REFUSED: caddy adapt could not read the fallback Caddyfile: ${adapted.reason}. Nothing was written.`);
          return EXIT.REFUSED;
        }
        door = gateFallback.checkFallbackDoor(adapted.config, port);
        if (!door.ok) {
          fail(`REFUSED: the fallback Caddyfile would not gate TangleClaw: ${door.reason}. Nothing was written.`);
          return EXIT.REFUSED;
        }
        if (dryRun) {
          say(`  would: write ${restored !== null ? restore : 'a rebuilt Caddyfile carrying basic_auth'} to ${caddyfilePath}`);
          say(`         → backup + caddy validate (restore on failure) → launchctl ${adminCredential.reloadCaddyArgs(uid).join(' ')}`);
        } else {
          const code = writeAndReload(candidate);
          if (code !== null) return code;
        }
      }
    }

    if (dryRun) {
      for (const p of door.probes) say(`  would probe: ${p.tls ? 'https' : 'http'}://${p.host || '127.0.0.1'}:${p.port}/ for a Basic challenge`);
      say(`  would write the marker: ${markerFile}`);
      say(`  would ask TangleClaw on port ${port} to confirm it reports "fallback"\n`);
      return EXIT.OK;
    }

    for (const target of door.probes) {
      const label = `${target.tls ? 'https' : 'http'}://${target.host || '127.0.0.1'}:${target.port}/`;
      const result = await retry(() => d.probe(target), (r) => r.ok, d.tries, d.sleep, d.delayMs);
      if (!result.ok) {
        fail(`ERROR: ${label} did not answer with Caddy's password challenge (${result.detail}).`);
        fail('  The marker was NOT written, so TangleClaw\'s login still enforces.');
        return EXIT.REFUSED;
      }
      say(`  ✓ ${label} challenges for Caddy's password.`);
    }

    gateFallback.writeMarker(markerFile, { createdAt: d.now().toISOString() });
    say(`  Marker written: ${markerFile}`);

    const answer = await retry(() => d.queryState(port), (r) => r.state === authGate.GATE_STATES.FALLBACK,
      d.tries, d.sleep, d.delayMs);
    if (answer.state === authGate.GATE_STATES.FALLBACK) {
      say('  ✓ TangleClaw reports "fallback": its login is stood down behind Caddy\'s password.');
      say('  Sign in with the Caddy username and password. When the login works again:');
      say('    node scripts/gate-fallback.js --undo\n');
      return EXIT.OK;
    }
    if (answer.state === null) {
      say(`  TangleClaw did not answer on port ${port} (${answer.error}). When it runs, it honours the`);
      say('  marker only while this door holds. Undo with: node scripts/gate-fallback.js --undo\n');
      return EXIT.OK;
    }
    fail(`WARNING: TangleClaw still reports "${answer.state}", so it did NOT honour the marker and its`);
    fail('  login still enforces. The reason is in TangleClaw\'s log ("Fallback marker present but NOT honoured").');
    fail('  Remove the marker with: node scripts/gate-fallback.js --undo');
    return EXIT.NOT_HONOURED;
  }

  /** @returns {Promise<number>} */
  async function runUndo() {
    say(`\n${dryRun ? '[dry-run] ' : ''}Stand TangleClaw's login back up`);
    const markerPresent = fs.existsSync(markerFile);
    if (!markerPresent) {
      say('  No fallback marker is set, so TangleClaw is not stood down. Nothing to undo.\n');
      return EXIT.OK;
    }
    if (dryRun) {
      say(`  would remove the marker: ${markerFile}`);
      say(`  would ask TangleClaw on port ${port} to confirm its login enforces again`);
      say('  would then take basic_auth out of the Caddyfile only if TangleClaw guards the door and the');
      say('  file is one this tool wrote (or --restore names one)\n');
      return EXIT.OK;
    }

    gateFallback.removeMarker(markerFile);
    say(`  Marker removed: ${markerFile}`);
    const answer = await retry(() => d.queryState(port), (r) => r.state !== null && r.state !== authGate.GATE_STATES.FALLBACK,
      d.tries, d.sleep, d.delayMs);
    const live = answer.state;

    if (current === null) {
      say(live ? `  TangleClaw reports "${live}". There is no Caddyfile to change.\n`
        : `  TangleClaw did not answer (${answer.error}). There is no Caddyfile to change.\n`);
      return EXIT.OK;
    }
    if (!authGate.guardsTheDoor(live)) {
      say(live
        ? `  TangleClaw reports "${live}", which does not guard the door by itself, so Caddy's password STAYS.`
        : `  TangleClaw did not answer (${answer.error}), so Caddy's password STAYS in front of it.`);
      say('  Run --undo again once the login is armed, or remove basic_auth by hand.\n');
      return EXIT.OK;
    }
    if (!authGate.guardsTheDoor(intendedGateState)) {
      say(`  Config resolves to "${intendedGateState}", which needs Caddy's password, so it STAYS.\n`);
      return EXIT.OK;
    }

    let candidate;
    if (restored !== null) {
      const adapted = d.adaptContent(restored);
      if (!adapted.ok) {
        fail(`REFUSED: caddy adapt could not read ${restore}: ${adapted.reason}. The Caddyfile was not changed;`);
        fail('  TangleClaw\'s login is armed and Caddy\'s password is still in front of it.');
        return EXIT.REFUSED;
      }
      candidate = restored;
    } else {
      const rebuilt = rebuildGenerated(current, config, {
        fromState: authGate.GATE_STATES.FALLBACK, toState: intendedGateState, lanHosts
      });
      if (!rebuilt.ok) {
        say(`  TangleClaw's login is armed. Caddy's password stays in front of it: ${rebuilt.reason}.`);
        say('  To drop it, remove basic_auth by hand or pass --restore <file>.\n');
        return EXIT.OK;
      }
      candidate = rebuilt.content;
    }
    const code = writeAndReload(candidate);
    if (code !== null) return code;
    say(`  ✓ TangleClaw's login ("${live}") is the gate again.\n`);
    return EXIT.OK;
  }
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
  if (args.unknown.length) {
    process.stderr.write(`ERROR: unknown argument(s): ${args.unknown.join(' ')}\n${USAGE}`);
    process.exit(EXIT.REFUSED);
  }

  // The gate state as CONFIGURED, like every other Caddyfile writer — never the
  // marker's, which describes a failure rather than what the operator set up.
  const store = require(path.join(REPO_DIR, 'lib', 'store'));
  const httpsSetup = require(path.join(REPO_DIR, 'lib', 'https-setup'));
  store.init();
  let config;
  let intendedGateState;
  let caddyfilePath;
  let markerFile;
  try {
    config = store.config.load();
    intendedGateState = authGate.resolveIntendedGateState(() => config, store.authSessions);
    caddyfilePath = caddy.getCaddyfilePath();
    markerFile = gateFallback.markerPath();
  } finally {
    store.close();
  }

  const lanHost = httpsSetup.mdnsHostFor(require('node:os').hostname());
  const code = await run({
    caddyfilePath,
    markerFile,
    config,
    intendedGateState,
    lanHosts: lanHost ? [null, lanHost] : [null],
    undo: args.undo,
    dryRun: args.dryRun,
    restore: args.restore,
    uid: process.getuid(),
    stamp: new Date().toISOString().replace(/[:.]/g, '-')
  });
  if (code !== EXIT.OK) process.exit(code);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`ERROR: ${caddy.redactHashes(err && err.stack ? err.stack : String(err))}\n`);
    process.exit(EXIT.REFUSED);
  });
}

module.exports = { parseArgs, run, rebuildGenerated, probeBasicChallenge, queryGateState, EXIT };
