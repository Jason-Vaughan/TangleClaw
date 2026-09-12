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
//   node scripts/reset-admin.js --user NAME      disambiguate when >1 user exists
//   node scripts/reset-admin.js --password-stdin  read the new password from stdin (piped)
//   node scripts/reset-admin.js --dry-run         show what would change, touch nothing
//   node scripts/reset-admin.js --create-gate --user jason
//                                                 put a FIRST login on an install that
//                                                 completed setup without one
//   node scripts/reset-admin.js --store --user jason
//                                                 create or reset a TANGLECLAW account
//
// TWO DOORS, AND THIS TOOL OPENS BOTH (#1418). Without `--store` every mode
// above operates on the CADDY basic_auth gate: bcrypt, a Caddyfile, a reload.
// With `--store` it operates on TangleClaw's OWN gate: a scrypt hash in the
// `users` table, no Caddyfile, no reload, and it works in direct ingress mode
// where no Caddyfile exists at all.
//
// The store mode lives here, in the break-glass tool, rather than behind the
// dashboard — ADR 0009 rule 5: recovery is a terminal tool OUTSIDE the gate,
// because a reset that lives behind the door cannot help someone the door has
// locked out. It moved here from chunk 01 (#1417) because a recovery path for a
// door that was not installed yet could not be verified end to end.
//
// It is also how the TangleClaw gate gets turned on for the first time: the
// gate is dormant until an enabled account exists (`lib/auth-gate.js`), so this
// command is the deliberate act that closes the door.
//
// Fail-closed: the patched Caddyfile is `caddy validate`d BEFORE the reload, and
// the prior file is restored from a timestamped backup if validation fails — a
// recovery run can never itself break the ingress.

const fs = require('node:fs');
const path = require('node:path');

const REPO_DIR = path.resolve(__dirname, '..');
const caddy = require(path.join(REPO_DIR, 'lib', 'caddy'));

// The reload argv and the fail-closed write both live in lib/ now, because the
// settings surface performs the same Caddyfile patch and a second copy of either
// would be free to drift from this one. Re-exported below so this script's own
// contract is unchanged.
const adminCredential = require(path.join(REPO_DIR, 'lib', 'admin-credential'));
const { reloadCaddyArgs, writeValidatedCaddyfile } = adminCredential;
const USAGE =
  'Usage: node scripts/reset-admin.js [--user <name>] [--password-stdin] [--dry-run]\n' +
  '       node scripts/reset-admin.js --create-gate --user <name>\n' +
  '       node scripts/reset-admin.js --store --user <name> [--password-stdin] [--dry-run]\n' +
  '  Resets the Caddy basic_auth admin password (break-glass recovery), or with\n' +
  '  --create-gate puts a first login on an install that completed setup without one.\n' +
  '  With --store, creates or resets a TangleClaw account instead (scrypt, the users\n' +
  '  table) — the gate TangleClaw enforces itself, on any ingress mode.\n' +
  '  Run this at a terminal ON the TangleClaw host.\n';

/**
 * Parse CLI args. Pure — no I/O — so it is unit-testable.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ user: string|null, dryRun: boolean, passwordStdin: boolean, help: boolean,
 *   createGate: boolean, store: boolean }}
 */
function parseArgs(argv) {
  let user = null;
  let dryRun = false;
  let passwordStdin = false;
  let help = false;
  let createGate = false;
  let store = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') { user = argv[++i] || null; }
    else if (a === '--dry-run') { dryRun = true; }
    else if (a === '--password-stdin') { passwordStdin = true; }
    else if (a === '--create-gate') { createGate = true; }
    else if (a === '--store') { store = true; }
    else if (a === '--help' || a === '-h') { help = true; }
  }
  return { user, dryRun, passwordStdin, help, createGate, store };
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

/**
 * Create or reset a TangleClaw account in the user store (`--store`).
 *
 * Runs BEFORE any Caddyfile is looked at, and never touches one: TangleClaw's
 * own gate exists on every ingress mode, so requiring a Caddyfile here would
 * make the tool refuse on exactly the direct-mode install that has no other
 * door at all.
 *
 * Create and reset are one command on purpose. The operator running this is
 * recovering access and does not necessarily know whether a row exists — making
 * them find out first, and choose a different flag on the answer, is a puzzle
 * set for someone already locked out. The output states which happened.
 *
 * @param {object} deps
 * @param {object} deps.store - The initialised store module
 * @param {string|null} deps.user - The `--user` value
 * @param {boolean} deps.dryRun
 * @param {boolean} deps.passwordStdin
 * @returns {Promise<number>} Process exit code
 */
async function runStoreMode({ store, user, dryRun, passwordStdin }) {
  if (!user) {
    process.stderr.write('ERROR: --store needs a username\n'
      + '  node scripts/reset-admin.js --store --user <name>\n');
    return 1;
  }

  const existing = store.users.getByName(user);
  const action = existing ? 'reset' : 'create';

  if (dryRun) {
    process.stdout.write(`\n[dry-run] ${action} TangleClaw account\n`);
    process.stdout.write(`  store:      ${store._getBasePath()}\n`);
    process.stdout.write(`  account:    ${user}${existing && existing.disabled_at ? ' (currently DISABLED)' : ''}\n`);
    // The piped password is judged on the real run's own path — same function,
    // same rules, same exit code. The Caddy dry-run above learned this the hard
    // way (#929): a preview that prints a plan and exits 0 for a password the
    // real run refuses is read during a lockout, which is the only time anyone
    // runs this. Nothing is read without --password-stdin: a dry run must not
    // prompt, so there is no password to judge and none is invented.
    if (passwordStdin) {
      try {
        await acquirePassword({ passwordStdin, user });
      } catch (err) {
        process.stderr.write(`ERROR: ${err.message}\n`);
        return 1;
      }
    }
    const passwordStep = passwordStdin
      ? 'use the stdin password (read and validated above)'
      : 'prompt new password';
    process.stdout.write(`  would: ${passwordStep} → scrypt hash → ${action} the users row\n`);
    if (existing) {
      process.stdout.write('         → destroy every live session for this account\n');
    }
    if (existing && existing.disabled_at) {
      process.stdout.write('         → re-enable the account\n');
    }
    process.stdout.write('         → no Caddyfile touched, no reload\n\n');
    return 0;
  }

  let password;
  try {
    // The SAME policy the Caddy door enforces — min length, denylist, no
    // control chars, no username match (ADR 0016). The store itself requires
    // only a non-empty string, which is the right call for a store layer and
    // the wrong one for a credential surface: without this line TangleClaw's
    // new door would accept a one-character password where the door it replaces
    // demanded twelve, and nobody would have decided that.
    password = await acquirePassword({ passwordStdin, user });
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    return 1;
  }

  if (existing) {
    // setPassword also destroys the account's live sessions. That is the
    // property that makes this recovery rather than a password change: someone
    // running it because they believe the credential is compromised must not
    // leave the attacker's session valid for another 30 days.
    store.users.setPassword(user, password);
    // Ordered AFTER the password change, deliberately. Re-enabling first would
    // open a window in which the account is live under the OLD password.
    if (existing.disabled_at) store.users.enable(user);
  } else {
    store.users.create(user, password);
  }

  process.stdout.write(`\nTangleClaw account ${action === 'create' ? 'created' : 'reset'} for '${user}'.\n`);
  if (existing && existing.disabled_at) {
    process.stdout.write('  ✓ Account re-enabled.\n');
  }
  process.stdout.write(`  Store: ${store._getBasePath()}\n`);
  // Said plainly because it is the surprising half. An operator who ran this to
  // recover a login has, on an install with no account before, also just closed
  // a door that was open — and one who ran it in caddy mode still has Caddy's
  // basic_auth in front until the cutover (#1420).
  process.stdout.write(
    '  TangleClaw enforces its own login for any account that exists, on every\n'
    + '  ingress mode, when authEnabled is on. In caddy ingress mode Caddy\'s\n'
    + '  basic_auth still sits in front of it until the cutover.\n\n');
  return 0;
}

async function main() {
  const { user, dryRun, passwordStdin, help, createGate, store: storeMode } =
    parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(USAGE);
    return;
  }

  const store = require(path.join(REPO_DIR, 'lib', 'store'));
  store.init();

  if (storeMode) {
    // Refused rather than silently preferring one: the two flags name two
    // different doors, and guessing which the operator meant is how a recovery
    // run fixes the credential nobody was locked out of.
    if (createGate) {
      process.stderr.write('ERROR: --store and --create-gate are different doors — choose one\n'
        + '  --store       TangleClaw\'s own login (the users table, any ingress mode)\n'
        + '  --create-gate Caddy\'s basic_auth gate (the Caddyfile, caddy mode only)\n');
      store.close();
      process.exit(1);
    }
    let code;
    try {
      code = await runStoreMode({ store, user, dryRun, passwordStdin });
    } finally {
      store.close();
    }
    if (code !== 0) process.exit(code);
    return;
  }

  const caddyfilePath = caddy.getCaddyfilePath();
  if (!fs.existsSync(caddyfilePath)) {
    process.stderr.write(`ERROR: no Caddyfile at ${caddyfilePath}\n  The basic_auth gate exists only in caddy ingress mode; there is nothing to reset.\n`);
    store.close();
    process.exit(1);
  }
  const original = fs.readFileSync(caddyfilePath, 'utf8');

  const existingUsers = caddy.listBasicAuthUsers(original);

  let targetUser;
  if (createGate) {
    // No existing line to read a username from, so one must be supplied.
    if (!user) {
      process.stderr.write('ERROR: --create-gate needs a username\n'
        + '  node scripts/reset-admin.js --create-gate --user <name>\n');
      store.close();
      process.exit(1);
    }
    targetUser = user;
  } else {
    try {
      targetUser = resolveTargetUser(existingUsers, user);
    } catch (err) {
      process.stderr.write(`ERROR: ${err.message}\n`);
      // An install with no gate used to stop here, which is where #806 stranded
      // people: the message was true and led nowhere. Only offered when this file
      // is one the tool can actually build in, so it never advertises a command
      // that will refuse.
      if (existingUsers.length === 0 && caddy.classifyCaddyfileContent(original).safeToWrite) {
        process.stderr.write('\n  This install has no login yet. Create one with:\n'
          + '    node scripts/reset-admin.js --create-gate --user <name>\n');
      }
      store.close();
      process.exit(1);
    }
  }

  if (dryRun) {
    const uid = process.getuid();
    process.stdout.write(`\n[dry-run] ${createGate ? 'create admin gate' : 'reset admin credential'}\n`);
    process.stdout.write(`  caddyfile:    ${caddyfilePath}\n`);
    process.stdout.write(`  admin user:   ${targetUser}\n`);
    // A piped password is input the rehearsal already HAS, so it is judged here
    // on the real run's own path — same function, same rules, same exit code.
    // Skipping it printed a full plan and exited 0 for a password the real run
    // refuses (#929), during a lockout, which is the only time anyone runs this.
    // Asked BEFORE the gate verdict below because that is the order the real run
    // asks them in: `acquirePassword` runs first, and `canCreateGate` only from
    // inside `createGate` after it. A preview that reported the second refusal
    // where the run reports the first would diverge on the reason as well as the
    // code. Nothing is read without `--password-stdin`: a dry run must not
    // prompt, so there is no password to judge and none is invented.
    if (passwordStdin) {
      try {
        await acquirePassword({ passwordStdin, user: targetUser });
      } catch (err) {
        process.stderr.write(`ERROR: ${err.message}\n`);
        store.close();
        process.exit(1);
      }
    }
    // A preview is read by someone deciding whether to commit, often already
    // locked out. It asks the SAME predicate the real run will, so it can never
    // describe a rebuild that would then be refused.
    const verdict = createGate
      ? adminCredential.canCreateGate(store.config.load(), original, targetUser)
      : { allowed: true, reason: null };
    if (!verdict.allowed) {
      process.stdout.write(`  would REFUSE: ${verdict.reason}\n\n`);
      store.close();
      return;
    }
    // Named from the flag rather than assumed. Saying "prompt new password"
    // under `--password-stdin` described a step the run does not take, about a
    // password this preview has already read and accepted.
    const passwordStep = passwordStdin
      ? 'use the stdin password (read and validated above)'
      : 'prompt new password';
    process.stdout.write(createGate
      ? `  would: ${passwordStep} → caddy hash-password → rebuild this generated Caddyfile\n`
        + '         from its own settings, adding the gate and changing nothing else\n'
      : `  would: ${passwordStep} → caddy hash-password → patch credential line(s)\n`);
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

  // The whole apply sequence — patch, fail-closed validated write, config sync,
  // reload — is `adminCredential.applyCredentialChange`. This script proved it and
  // the settings surface performs the identical one, so it is called rather than
  // repeated: two copies of a sequence that rewrites the live gate is the drift
  // the CAD-7X4V precedent already paid for once.
  const applyOpts = {
    caddyfilePath,
    user: targetUser,
    hash,
    uid: process.getuid(),
    stamp: new Date().toISOString().replace(/[:.]/g, '-')
  };
  const result = createGate
    ? adminCredential.createGate(applyOpts)
    : adminCredential.applyCredentialChange(applyOpts);

  if (!result.ok) {
    // Redacted for the same reason the HTTP path redacts it: `caddy validate`
    // quotes the offending line, and that line carries a bcrypt hash. A terminal
    // is a friendlier place for it to land than an HTTP response, but it is still
    // scrollback, and scrollback gets pasted into issues.
    process.stderr.write(`ERROR: ${caddy.redactHashes(result.error || '')}\n`);
    // Branch on the CODE, never on "a backup exists". `diverged` is the one
    // failure that leaves the NEW password in force — the restore is exactly what
    // failed — and a backup path is present there too. Saying "the original was
    // restored" would send the operator to sign in with a password the door no
    // longer takes, on the run where they are already in trouble.
    if (result.code === adminCredential.CREDENTIAL_CODES.DIVERGED) {
      process.stderr.write(
        '  The Caddyfile now carries the NEW password, and it could not be put back.\n'
        + `  The NEW password is the one in force. Backup of the original: ${result.backup}\n`
        + '  Restore it by hand, or re-run this tool once the disk problem is fixed.\n');
    } else if (result.code === adminCredential.CREDENTIAL_CODES.GATE_BROKEN) {
      // Also carries a backup path, so without this arm it fell through to
      // "the original was restored" — which is exactly what did NOT happen. This
      // is the break-glass tool, read by someone already locked out.
      process.stderr.write(
        '  Your login was NOT changed, but the Caddyfile could not be written or put back,\n'
        + '  so the ingress may now be broken and Caddy may not reload.\n'
        + `  A copy of the original is at: ${result.backup}\n`
        + '  Restore it by hand before restarting Caddy.\n');
    } else if (result.backup) {
      process.stderr.write(`  The original was restored (ingress untouched). Backup kept at: ${result.backup}\n`);
    }
    store.close();
    process.exit(1);
  }

  if (!result.reloaded) {
    process.stderr.write(`WARNING: could not reload Caddy automatically.\n  Run: ${result.reloadCommand}\n`);
  }

  process.stdout.write(createGate
    ? `\nAdmin login created for '${result.user}' (${result.replaced} gate line(s) written).\n`
    : `\nAdmin credential reset for '${result.user}' (${result.replaced} line(s) updated).\n`);
  process.stdout.write(`  Caddyfile: ${caddyfilePath}\n  Backup:    ${result.backup}\n`);
  if (result.reloaded) process.stdout.write('  ✓ Caddy reloaded — log in with the new password.\n\n');
  store.close();
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs, resolveTargetUser, reloadCaddyArgs, writeValidatedCaddyfile, runStoreMode
};
