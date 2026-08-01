'use strict';

/**
 * Changing the admin credential after setup.
 *
 * The gate is the Caddyfile, not `config`. Writing config alone would tell an
 * operator their password changed while the old one still opens the dashboard,
 * so the whole sequence — patch, validate fail-closed, sync, reload — lives here
 * as ONE function rather than as steps a caller can half-perform.
 *
 * It exists because `scripts/reset-admin.js` already proved this sequence and the
 * settings surface needs the same one. A second implementation is the failure
 * this module prevents: a hand-maintained mirror of the Caddyfile-adoption logic
 * drifted from its original and produced a real defect, which is why adoption was
 * collapsed to a single shared computation. Same reasoning, same answer.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const caddy = require('./caddy');
const store = require('./store');
const { createLogger } = require('./logger');

const log = createLogger('admin-credential');

// How many timestamped Caddyfile backups to keep. Each one holds the bcrypt hash
// that was in force when it was written, so an unbounded pile is a growing set of
// credential-bearing files nobody prunes. A handful is enough to walk a bad change
// back by hand; the rest are only exposure.
const BACKUP_RETENTION = 5;

// Credential-change backups carry their own suffix, and retention only ever
// matches this one. `scripts/ingress-cutover.js` writes `<caddyfile>.<stamp>.bak`
// in the same directory and its `--force` safety depends on that file still being
// there — a shared namespace would let five password changes delete the backup a
// different tool is relying on.
const BACKUP_SUFFIX = (stamp) => `.${stamp}.credential.bak`;
const BACKUP_GLOB_SUFFIX = '.credential.bak';

/** Why a credential change was refused. Returned to callers; safe to show. */
const CREDENTIAL_CODES = Object.freeze({
  OK: 'ok',
  NOT_CADDY_MODE: 'not-caddy-mode',
  NO_GATE: 'no-gate',
  NO_CREDENTIAL: 'no-credential',
  NO_CADDY_BINARY: 'no-caddy-binary',
  UNREADABLE: 'unreadable',
  VALIDATE_FAILED: 'validate-failed',
  RENAME_UNSUPPORTED: 'rename-unsupported',
  CONFIG_WRITE_FAILED: 'config-write-failed',
  DIVERGED: 'diverged'
});

/**
 * Render a credential code as this codebase's HTTP error-code spelling.
 *
 * The lib codes are kebab-case, matching the cutover's result-file vocabulary;
 * HTTP error codes here are UPPER_SNAKE. Both spellings are correct in their own
 * place, so the translation lives in exactly one function — two endpoints
 * uppercasing independently is how one state acquires two names, which is the
 * defect that makes a status unscoreable.
 * @param {string} code - A CREDENTIAL_CODES value.
 * @returns {string} The UPPER_SNAKE form.
 */
function httpCode(code) {
  return code.toUpperCase().replace(/-/g, '_');
}

/**
 * Build the launchctl reload argv for the Caddy LaunchAgent. Pure/testable.
 *
 * `kickstart -k` restarts the running job in place — the same reload primitive the
 * cutover and the EMERGENCY-RECOVERY runbook use, so an operator finishing this by
 * hand runs the command they have already seen.
 * @param {number} uid - The user's numeric uid (process.getuid()).
 * @returns {string[]} argv for execFileSync('launchctl', ...).
 */
function reloadCaddyArgs(uid) {
  return ['kickstart', '-k', `gui/${uid}/${caddy.CADDY_LABEL}`];
}

/**
 * Restart the Caddy job, reporting the outcome rather than throwing.
 *
 * Separate from `applyCredentialChange` because the two have different audiences.
 * A terminal caller reloads inline and reads the result. A caller answering an
 * HTTP request CANNOT: the reply travels back through the very Caddy this
 * restarts, so reloading before the response is written tears down the connection
 * carrying it, and a change that succeeded reaches the browser as a network
 * error. Those callers reload after their response has been flushed — which is
 * after they can still say anything about it — using `reloadCaddyAsync` below.
 * @param {number} uid - The user's numeric uid.
 * @param {Function} [execFn] - Injected `execFileSync` (tests).
 * @returns {{ok: boolean, error: (string|null), command: string}}
 */
function reloadCaddy(uid, execFn = execFileSync) {
  const args = reloadCaddyArgs(uid);
  const command = `launchctl ${args.join(' ')}`;
  try {
    execFn('launchctl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true, error: null, command };
  } catch (err) {
    return { ok: false, error: err.message, command };
  }
}

/**
 * Restart the Caddy job WITHOUT blocking the event loop, reporting to a callback.
 *
 * The synchronous form above is right for a terminal tool, which has nothing else
 * to serve while it waits. It is wrong inside a server: `execFileSync` holds the
 * loop for as long as launchd takes to stop and restart Caddy, and every other
 * request in flight waits behind a restart they have nothing to do with.
 * @param {number} uid - The user's numeric uid.
 * @param {(result: {ok: boolean, error: (string|null), command: string}) => void} [onDone]
 * @returns {void}
 */
function reloadCaddyAsync(uid, onDone = () => {}) {
  const args = reloadCaddyArgs(uid);
  const command = `launchctl ${args.join(' ')}`;
  execFile('launchctl', args, (err) => {
    onDone(err ? { ok: false, error: err.message, command } : { ok: true, error: null, command });
  });
}

/**
 * Delete all but the newest `keep` backups of a Caddyfile.
 *
 * Every backup carries the bcrypt hash that was live when it was taken, so this
 * is retention of credential material, not of disk space. Failures are swallowed
 * deliberately and logged: a credential change that worked must not be reported
 * as failed because a stale backup could not be unlinked.
 * @param {string} caddyfilePath - The live Caddyfile whose backups to prune.
 * @param {number} [keep] - How many of the newest backups to retain.
 * @returns {string[]} The backup paths that were removed.
 */
function pruneCaddyfileBackups(caddyfilePath, keep = BACKUP_RETENTION) {
  const dir = path.dirname(caddyfilePath);
  const prefix = `${path.basename(caddyfilePath)}.`;
  const removed = [];
  try {
    // The stamp is an ISO timestamp with `:` and `.` swapped for `-`, so it sorts
    // lexicographically in time order — no stat() call, and no dependence on
    // mtimes that a copy or a restore would have rewritten.
    const backups = fs.readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith(BACKUP_GLOB_SUFFIX))
      .sort();
    for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
      const full = path.join(dir, name);
      try {
        fs.unlinkSync(full);
        removed.push(full);
      } catch (err) {
        log.warn('Could not remove an old Caddyfile backup', { backup: full, error: err.message });
      }
    }
  } catch (err) {
    log.warn('Could not list Caddyfile backups to prune', { dir, error: err.message });
  }
  return removed;
}

/**
 * Write a Caddyfile, keeping a timestamped backup, and restore it if the written
 * file does not validate.
 *
 * Fail-closed on purpose: an ingress left broken by a bad write locks the operator
 * out of the machine this tool exists to keep them in. The backup is timestamped
 * so repeated runs never clobber an earlier one.
 * @param {string} caddyfilePath - Path to the live Caddyfile.
 * @param {string} newContent - Replacement content.
 * @param {(p: string) => {ok: boolean, error?: string}} validateFn - Validator (injected for tests).
 * @param {string} stamp - Filename-safe timestamp for the backup.
 * @returns {{ok: boolean, backup: string, error: (string|null), restored: boolean}}
 *   `restored` distinguishes the two failure shapes: true when the live file is
 *   back to what it was, false when even the restore failed and the gate now
 *   carries content the caller did not intend.
 */
function writeValidatedCaddyfile(caddyfilePath, newContent, validateFn, stamp) {
  const backup = `${caddyfilePath}${BACKUP_SUFFIX(stamp)}`;
  fs.copyFileSync(caddyfilePath, backup);
  // The backup holds a live credential hash. copyFileSync carries the source's
  // mode across, and the source may be a hand-edited file at 0644 — so the mode
  // is set here rather than inherited.
  fs.chmodSync(backup, 0o600);

  // Guarded for the same failure class the config write below is guarded for.
  // A mid-write ENOSPC truncates the LIVE gate and throws before `validateFn`
  // ever runs, so the fail-closed restore that makes this function safe would be
  // skipped entirely — the one path that can leave a broken ingress behind.
  try {
    fs.writeFileSync(caddyfilePath, newContent, { mode: 0o600 });
  } catch (err) {
    try {
      fs.copyFileSync(backup, caddyfilePath);
    } catch (restoreErr) {
      log.error('The Caddyfile could not be restored after a failed write',
        { error: restoreErr.message, backup });
      return {
        ok: false,
        backup,
        error: `${err.message} (the Caddyfile could not be restored: ${restoreErr.message})`,
        restored: false
      };
    }
    return { ok: false, backup, error: err.message, restored: true };
  }

  const v = validateFn(caddyfilePath);
  if (!v.ok) {
    fs.copyFileSync(backup, caddyfilePath); // restore — never leave a broken ingress
    return { ok: false, backup, error: v.error || 'validation failed', restored: true };
  }
  // Only after a good write, so a run that restored still leaves its own backup
  // in place for whoever has to look at what went wrong.
  pruneCaddyfileBackups(caddyfilePath);
  return { ok: true, backup, error: null, restored: false };
}

/**
 * Decide whether a credential may be CHANGED from a remote surface right now.
 *
 * One predicate doing four jobs, which is why it is written as one thing rather
 * than as four checks a future caller could apply three of:
 *
 * 1. It makes blanking unreachable — you may only change a credential that
 *    already exists, and the Direction allows exactly one route to "no password"
 *    (an explicit opt-out), not two.
 * 2. It keeps the second remote door shut. With no gate in force there is nothing
 *    authenticating the caller, so a write here would let whoever reaches an
 *    ungated install claim it.
 * 3. It keeps recovery in the terminal, where the Direction puts it: an install
 *    with no credential is a RECOVERY case for `scripts/reset-admin.js`, because a
 *    reset that lives behind the gate cannot help someone the gate has locked out.
 * 4. It is what authenticates the request. The server cannot verify a typed
 *    current password — `caddy hash-password` has no verify mode and no `--salt`,
 *    so a stored bcrypt hash cannot be reproduced for comparison, and Node's
 *    stdlib has no bcrypt. Requiring the gate to be live means Caddy already
 *    authenticated whoever is asking.
 * @param {object} config - Loaded TangleClaw config.
 * @param {{state: string, user: (string|null)}} ingressState - From `caddy.classifyIngressState()`.
 * @param {boolean} [caddyAvailable] - Whether the `caddy` binary is on PATH, from
 *   `caddy.detectCaddy().available`. **Defaults to true**, which is permissive:
 *   a caller that omits it gets the answer this predicate gave before the check
 *   existed. That is safe only because this one check is not part of the security
 *   guard — the three above it are. Missing `caddy` cannot let anyone through; it
 *   only means the hash cannot be computed, so omitting it costs a clean refusal
 *   and yields a 500 at submit instead. Every caller that CAN look passes what it
 *   found; the default exists for the ones that cannot.
 * @returns {{allowed: boolean, code: string, reason: (string|null), remedy: (string|null)}}
 */
function canChangeCredential(config, ingressState, caddyAvailable = true) {
  const state = ingressState && ingressState.state;
  if (state === 'unreadable') {
    return {
      allowed: false,
      code: CREDENTIAL_CODES.UNREADABLE,
      reason: 'The Caddy config could not be read, so the current login cannot be confirmed.',
      remedy: 'Run `node scripts/reset-admin.js` at a terminal on this machine.'
    };
  }
  if (config.ingressMode !== 'caddy') {
    return {
      allowed: false,
      code: CREDENTIAL_CODES.NOT_CADDY_MODE,
      reason: 'Nothing is enforcing a login on this install, so there is no password in force to change.',
      remedy: 'Run `node scripts/ingress-cutover.js --to caddy` at a terminal to put the login in place.'
    };
  }
  // A gate present in the LIVE file, not merely a credential recorded in config:
  // config can hold a credential no ingress is applying (the stored-unconfirmed
  // state), and changing that would report a password change nothing enforces.
  if (!ingressState.user) {
    // Several logins present is a different fact from none, and it reaches here
    // the same way — `classifyIngressState` reports no single user. Saying "no
    // login" to someone looking at a file with three of them reads as a bug in
    // TangleClaw and points at the wrong remedy.
    const several = (ingressState.users || []).length > 1;
    return {
      allowed: false,
      code: CREDENTIAL_CODES.NO_GATE,
      reason: several
        ? 'The Caddy config in front of TangleClaw carries more than one login, so this surface '
          + 'cannot tell which one you mean.'
        : 'The Caddy config in front of TangleClaw carries no login, so there is none to change here.',
      remedy: several
        ? 'Run `node scripts/reset-admin.js --user <name>` at a terminal on this machine.'
        : 'Run `node scripts/reset-admin.js` at a terminal on this machine.'
    };
  }
  if (!config.basicAuthUser || !config.basicAuthHash) {
    return {
      allowed: false,
      code: CREDENTIAL_CODES.NO_CREDENTIAL,
      reason: 'No login is recorded for this install, so this surface has nothing to change.',
      remedy: 'Run `node scripts/reset-admin.js` at a terminal on this machine.'
    };
  }
  // Last, because it is the only refusal that is about the machine's tooling
  // rather than about the gate. `caddy hash-password` is the only hasher this
  // codebase has — no binary, no new hash, so the change cannot happen. Asked
  // here so the form is never drawn for an install that would fail at submit
  // with a 500 from a shell-out; the sibling ingress-state endpoint checks the
  // same thing for the same reason.
  if (!caddyAvailable) {
    return {
      allowed: false,
      code: CREDENTIAL_CODES.NO_CADDY_BINARY,
      reason: 'The `caddy` command is not on this machine\'s PATH, so a new password cannot be hashed.',
      remedy: 'Install Caddy (`brew install caddy`), then change the login here.'
    };
  }
  return { allowed: true, code: CREDENTIAL_CODES.OK, reason: null, remedy: null };
}

/**
 * Apply a credential change: patch the live Caddyfile, validate fail-closed, sync
 * config, and reload Caddy.
 *
 * Order is load-bearing. The Caddyfile is patched and validated BEFORE config is
 * touched, so a validation failure leaves both the ingress and the recorded
 * credential exactly as they were — a config that disagrees with the live gate is
 * the state every part of this chunk exists to prevent.
 *
 * The reload is deliberately non-fatal and reported rather than thrown: by the
 * time it runs the file is already patched and validated, so the change HAS
 * happened and the caller must be able to say so while naming the one command
 * left to run. A caller answering an HTTP request through this same Caddy passes
 * `reload: false` and calls `reloadCaddyAsync` once its response is flushed — see
 * `reloadCaddy` for why the restart cannot happen first.
 * `user` is a SELECTOR, not a value — it names WHICH existing credential line to
 * re-hash, exactly as `caddy.replaceBasicAuthCredential` means it. Passing a name
 * the live file does not carry is a rename, which this cannot do: the underlying
 * replace writes back the MATCHED username, so a "successful" rename would leave
 * the gate on the old name while config recorded the new one. It is refused with
 * `rename-unsupported` rather than thrown, so callers can say so plainly.
 *
 * The target is resolved from the FILE, never from `config`. Those two can drift —
 * ADR 0009's amendment describes exactly that state — and the file is what the
 * gate actually enforces.
 * @param {object} opts
 * @param {string} opts.caddyfilePath - Live Caddyfile.
 * @param {string} [opts.user] - Which existing credential to re-hash. Omit when
 *   the file carries exactly one.
 * @param {string} opts.hash - New bcrypt hash.
 * @param {number} opts.uid - Numeric uid for the launchctl target.
 * @param {string} opts.stamp - Filename-safe timestamp for the backup.
 * @param {boolean} [opts.reload] - Reload Caddy inline. Pass false when the reply
 *   to the caller travels through Caddy; reload after flushing it instead.
 * @param {Function} [opts.execFn] - Injected `execFileSync` (tests).
 * @param {Function} [opts.validateFn] - Injected validator (tests).
 * @returns {{ok: boolean, code: string, backup: (string|null), error: (string|null),
 *   reloaded: boolean, reloadPending: boolean, reloadCommand: string}}
 */
function applyCredentialChange(opts) {
  const {
    caddyfilePath, user, hash, uid, stamp,
    reload = true,
    execFn = execFileSync,
    validateFn = caddy.validateCaddyfile
  } = opts;

  const reloadCommand = `launchctl ${reloadCaddyArgs(uid).join(' ')}`;
  const original = fs.readFileSync(caddyfilePath, 'utf8');

  // Refuse a rename here rather than letting replaceBasicAuthCredential throw.
  // The throw would surface as a 500 on a request the operator made deliberately,
  // and the message would name the accounts in their gate.
  const present = caddy.listBasicAuthUsers(original);
  if (user && !present.includes(user)) {
    return {
      ok: false,
      code: CREDENTIAL_CODES.RENAME_UNSUPPORTED,
      backup: null,
      error: `the login in force is '${present.join("', '")}' — the username cannot be changed here`,
      reloaded: false,
      reloadPending: false,
      reloadCommand,
      replaced: 0,
      user: present[0] || null
    };
  }

  const patched = caddy.replaceBasicAuthCredential(original, { hash, user });
  const written = writeValidatedCaddyfile(caddyfilePath, patched.content, validateFn, stamp);

  if (!written.ok) {
    return {
      ok: false,
      code: CREDENTIAL_CODES.VALIDATE_FAILED,
      backup: written.backup,
      error: written.error,
      reloaded: false,
      reloadPending: false,
      reloadCommand,
      replaced: 0,
      user: patched.user
    };
  }

  // Only now, with a validated gate on disk, does the recorded credential move.
  //
  // Guarded because the write can fail — a full disk, a permission change — and
  // an unguarded throw here would surface as a plain failure on a request that
  // had ALREADY rewritten the live gate. "Your password did not change" while the
  // new one is the one in force is the worst report this route can make: it sends
  // the operator to sign in with a password the door no longer takes. So the
  // Caddyfile goes back to what it was, which is the state the message then
  // describes truthfully.
  try {
    const config = store.config.load();
    config.authEnabled = true;
    config.basicAuthUser = patched.user;
    config.basicAuthHash = hash;
    store.config.save(config);
  } catch (err) {
    log.error('Admin credential could not be recorded in config; restoring the gate',
      { error: err.message, backup: written.backup });
    try {
      fs.copyFileSync(written.backup, caddyfilePath);
    } catch (restoreErr) {
      // Both writes failed, so the two halves now disagree and only a terminal
      // can settle it. Named as its own state rather than folded into the one
      // above: the remedies are different, and the operator's next password is
      // different too.
      log.error('The gate could not be restored after a failed config write',
        { error: restoreErr.message, backup: written.backup });
      return {
        ok: false,
        code: CREDENTIAL_CODES.DIVERGED,
        backup: written.backup,
        error: `${err.message} (the Caddyfile could not be restored: ${restoreErr.message})`,
        reloaded: false,
        reloadPending: false,
        reloadCommand,
        replaced: patched.replaced,
        user: patched.user
      };
    }
    return {
      ok: false,
      code: CREDENTIAL_CODES.CONFIG_WRITE_FAILED,
      backup: written.backup,
      error: err.message,
      reloaded: false,
      reloadPending: false,
      reloadCommand,
      replaced: 0,
      user: patched.user
    };
  }

  // `reload: false` means a caller whose response travels through this Caddy will
  // restart it once that response is out — pending, not skipped, and the caller
  // says so rather than reporting a reload that has not happened yet.
  let reloaded = false;
  if (reload) {
    const r = reloadCaddy(uid, execFn);
    reloaded = r.ok;
    if (!r.ok) {
      // Not an error for the caller: the credential IS changed. Logged so the
      // reason exists somewhere, without the message claiming a failure.
      log.warn('Admin credential changed, but Caddy could not be reloaded automatically',
        { error: r.error, reloadCommand });
    }
  }

  return {
    ok: true,
    code: CREDENTIAL_CODES.OK,
    backup: written.backup,
    error: null,
    reloaded,
    reloadPending: !reload,
    reloadCommand,
    replaced: patched.replaced,
    user: patched.user
  };
}

module.exports = {
  BACKUP_RETENTION,
  CREDENTIAL_CODES,
  httpCode,
  reloadCaddyArgs,
  reloadCaddy,
  reloadCaddyAsync,
  pruneCaddyfileBackups,
  writeValidatedCaddyfile,
  canChangeCredential,
  applyCredentialChange
};
