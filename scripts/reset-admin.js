#!/usr/bin/env node
'use strict';

// AUTH-2 slice 3 — break-glass admin credential reset (the no-permanent-lockout
// guarantee). The basic_auth gate lives in Caddy on the operator's own Mac, so
// recovery proves PHYSICAL control (a terminal on the box) rather than opening a
// second remote door. This script regenerates the bcrypt hash, patches the LIVE
// Caddyfile IN PLACE (works on both the TangleClaw-generated gate and a
// hand-edited one — it never reshapes an operator-owned file), re-validates it
// fail-closed, reloads Caddy, and syncs the persisted config so a later
// `ingress-cutover.js` stays consistent.
//
//   node scripts/reset-admin.js                   reset the (single) admin password
//   node scripts/reset-admin.js --user jason      disambiguate when >1 user exists
//   node scripts/reset-admin.js --password-stdin  read the new password from stdin (piped)
//   node scripts/reset-admin.js --dry-run         show what would change, touch nothing
//
// Fail-closed: the patched Caddyfile is `caddy validate`d BEFORE the reload, and
// the prior file is restored from a timestamped backup if validation fails — a
// recovery run can never itself break the ingress.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_DIR = path.resolve(__dirname, '..');
const caddy = require(path.join(REPO_DIR, 'lib', 'caddy'));

const CADDY_LABEL = 'com.tangleclaw.caddy';
const USAGE =
  'Usage: node scripts/reset-admin.js [--user <name>] [--password-stdin] [--dry-run]\n' +
  '  Resets the Caddy basic_auth admin password (break-glass recovery).\n' +
  '  Run this at a terminal ON the TangleClaw host.\n';

/**
 * Parse CLI args. Pure — no I/O — so it is unit-testable.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ user: string|null, dryRun: boolean, passwordStdin: boolean, help: boolean }}
 */
function parseArgs(argv) {
  let user = null;
  let dryRun = false;
  let passwordStdin = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') { user = argv[++i] || null; }
    else if (a === '--dry-run') { dryRun = true; }
    else if (a === '--password-stdin') { passwordStdin = true; }
    else if (a === '--help' || a === '-h') { help = true; }
  }
  return { user, dryRun, passwordStdin, help };
}

/**
 * Resolve which credential to reset given the users present in the Caddyfile and
 * an optional `--user` selector. Pure so the disambiguation rules are testable.
 * @param {string[]} users - Distinct usernames from caddy.listBasicAuthUsers().
 * @param {string|null} requested - The `--user` value, or null.
 * @returns {string} The resolved username.
 * @throws if there is no gate, the requested user is absent, or the choice is ambiguous.
 */
function resolveTargetUser(users, requested) {
  if (!users || users.length === 0) {
    throw new Error('no basic_auth credential found — the gate is only present in caddy ingress mode (nothing to reset)');
  }
  if (requested) {
    if (!users.includes(requested)) {
      throw new Error(`no credential for user '${requested}' (found: ${users.join(', ')})`);
    }
    return requested;
  }
  if (users.length > 1) {
    throw new Error(`multiple admin users present (${users.join(', ')}); choose one with --user <name>`);
  }
  return users[0];
}

/**
 * Build the launchctl reload argv for the Caddy LaunchAgent. Pure/testable.
 * `kickstart -k` restarts the running job in place (the same reload primitive the
 * cutover and the EMERGENCY-RECOVERY runbook use).
 * @param {number} uid - The user's numeric uid (process.getuid()).
 * @returns {string[]} argv for execFileSync('launchctl', ...).
 */
function reloadCaddyArgs(uid) {
  return ['kickstart', '-k', `gui/${uid}/${CADDY_LABEL}`];
}

/**
 * Prompt for a line of input on the TTY without echoing it. Side-effecting (raw
 * mode on stdin); the live operator path, not unit-tested.
 * @param {string} query - Prompt text.
 * @returns {Promise<string>} The typed line (no trailing newline).
 */
function promptHidden(query) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('stdin is not a TTY — use --password-stdin to pipe the password'));
      return;
    }
    process.stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '\u0003') { // Ctrl-C
        stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') { // backspace
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Read piped stdin to end and return its first line (the --password-stdin path).
 * @returns {Promise<string>}
 */
function readPipedPassword() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data.split(/\r?\n/)[0]));
  });
}

/**
 * Write newContent over caddyfilePath behind a fail-closed guard: back the file
 * up first (timestamped), write, validate, and RESTORE the backup if validation
 * fails — so a recovery run can never itself leave a broken ingress. Validation
 * is injected, so the restore branch is unit-testable without a real Caddy.
 * @param {string} caddyfilePath
 * @param {string} newContent
 * @param {(p:string)=>{ok:boolean,error?:string}} validateFn - e.g. caddy.validateCaddyfile.
 * @param {string} stamp - filesystem-safe timestamp for the .bak name.
 * @returns {{ ok: boolean, backup: string, error: string|null }}
 */
function writeValidatedCaddyfile(caddyfilePath, newContent, validateFn, stamp) {
  const backup = `${caddyfilePath}.${stamp}.bak`;
  fs.copyFileSync(caddyfilePath, backup);
  fs.writeFileSync(caddyfilePath, newContent, { mode: 0o600 });
  const v = validateFn(caddyfilePath);
  if (!v.ok) {
    fs.copyFileSync(backup, caddyfilePath); // restore — never leave a broken ingress
    return { ok: false, backup, error: v.error || 'validation failed' };
  }
  return { ok: true, backup, error: null };
}

/**
 * Acquire the new password: piped (single read) or interactive (entered twice and
 * confirmed). Throws on mismatch or validation failure so nothing is written.
 * @param {object} opts
 * @param {boolean} opts.passwordStdin
 * @param {string} opts.user - resolved username (for the no-username-match rule).
 * @returns {Promise<string>}
 */
async function acquirePassword({ passwordStdin, user }) {
  let password;
  if (passwordStdin) {
    password = await readPipedPassword();
  } else {
    password = await promptHidden(`New password for admin '${user}': `);
    const confirm = await promptHidden('Confirm new password: ');
    if (password !== confirm) {
      throw new Error('passwords did not match');
    }
  }
  const v = caddy.validateAdminPassword(password, user);
  if (!v.ok) {
    throw new Error(v.error);
  }
  return password;
}

async function main() {
  const { user, dryRun, passwordStdin, help } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(USAGE);
    return;
  }

  const store = require(path.join(REPO_DIR, 'lib', 'store'));
  store.init();

  const caddyfilePath = caddy.getCaddyfilePath();
  if (!fs.existsSync(caddyfilePath)) {
    process.stderr.write(`ERROR: no Caddyfile at ${caddyfilePath}\n  The basic_auth gate exists only in caddy ingress mode; there is nothing to reset.\n`);
    store.close();
    process.exit(1);
  }
  const original = fs.readFileSync(caddyfilePath, 'utf8');

  let targetUser;
  try {
    targetUser = resolveTargetUser(caddy.listBasicAuthUsers(original), user);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    store.close();
    process.exit(1);
  }

  if (dryRun) {
    const uid = process.getuid();
    process.stdout.write(`\n[dry-run] reset admin credential\n`);
    process.stdout.write(`  caddyfile:    ${caddyfilePath}\n`);
    process.stdout.write(`  admin user:   ${targetUser}\n`);
    process.stdout.write(`  would: prompt new password → caddy hash-password → patch credential line(s)\n`);
    process.stdout.write(`         → backup + caddy validate (restore on failure) → sync config → launchctl ${reloadCaddyArgs(uid).join(' ')}\n\n`);
    store.close();
    return;
  }

  let password;
  let hash;
  try {
    password = await acquirePassword({ passwordStdin, user: targetUser });
    hash = caddy.hashPassword(password);
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    store.close();
    process.exit(1);
  }

  const patched = caddy.replaceBasicAuthCredential(original, { hash, user: targetUser });

  // Back up + write + validate fail-closed (timestamped backup so repeated runs
  // never clobber an earlier one; the original is restored if validation fails).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const written = writeValidatedCaddyfile(caddyfilePath, patched.content, caddy.validateCaddyfile, stamp);
  if (!written.ok) {
    process.stderr.write(`ERROR: patched Caddyfile failed validation — restored the original (ingress untouched):\n  ${written.error}\n  Backup kept at: ${written.backup}\n`);
    store.close();
    process.exit(1);
  }
  const backup = written.backup;

  // Sync persisted config so a future cutover regenerates the same credential.
  const config = store.config.load();
  config.authEnabled = true;
  config.basicAuthUser = patched.user;
  config.basicAuthHash = hash;
  store.config.save(config);

  // Reload Caddy in place. Non-fatal: the file is already patched + validated, so
  // even if the reload can't run here the operator can finish it by hand.
  const uid = process.getuid();
  let reloaded = true;
  try {
    execFileSync('launchctl', reloadCaddyArgs(uid), { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    reloaded = false;
    process.stderr.write(`WARNING: could not reload Caddy automatically: ${err.message}\n  Run: launchctl ${reloadCaddyArgs(uid).join(' ')}\n`);
  }

  process.stdout.write(`\nAdmin credential reset for '${patched.user}' (${patched.replaced} line(s) updated).\n`);
  process.stdout.write(`  Caddyfile: ${caddyfilePath}\n  Backup:    ${backup}\n`);
  if (reloaded) process.stdout.write('  ✓ Caddy reloaded — log in with the new password.\n\n');
  store.close();
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, resolveTargetUser, reloadCaddyArgs, writeValidatedCaddyfile };
