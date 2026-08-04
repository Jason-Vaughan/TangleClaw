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
  DIVERGED: 'diverged',
  GATE_BROKEN: 'gate-broken',
  WRITE_FAILED: 'write-failed',
  REMOTE_CONNECTION: 'remote-connection',
  // Gate CREATION refusals. Distinct from NO_GATE, which means "there is no gate
  // to change" — these say why one cannot be built, and each sends the operator
  // somewhere different.
  GATE_EXISTS: 'gate-exists',
  NOT_GENERATED: 'not-generated',
  UNRECOGNIZED_SHAPE: 'unrecognized-shape'
});

/**
 * Whether a socket's remote address is the loopback interface.
 *
 * Node reports IPv4 loopback as `127.0.0.1`, IPv6 as `::1`, and an IPv4 client on
 * a dual-stack socket as the IPv4-mapped `::ffff:127.0.0.1` — all three are the
 * same machine, and a check that knew only the first would refuse a legitimate
 * local caller. A missing address (a destroyed socket) is NOT loopback: fail
 * closed on the one thing this exists to decide.
 * @param {string|undefined} remoteAddress - `req.socket.remoteAddress`.
 * @returns {boolean}
 */
function isLoopbackRemote(remoteAddress) {
  if (typeof remoteAddress !== 'string' || !remoteAddress) return false;
  const addr = remoteAddress.toLowerCase().replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.');
}

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
 * @returns {{ok: boolean, backup: string, error: (string|null), restored: boolean,
 *   cause: (string|null)}} `restored` is false when even the restore failed, so the
 *   live file holds content nobody intended. `cause` is `'write'` or `'validate'`
 *   — the same outcome for different reasons, and the two send an operator to
 *   different places (a full disk versus a syntax error).
 */
function writeValidatedCaddyfile(caddyfilePath, newContent, validateFn, stamp) {
  const backup = `${caddyfilePath}${BACKUP_SUFFIX(stamp)}`;
  fs.copyFileSync(caddyfilePath, backup);
  // The backup holds a live credential hash. copyFileSync carries the source's
  // mode across, and the source may be a hand-edited file at 0644 — so the mode
  // is set here rather than inherited.
  fs.chmodSync(backup, 0o600);

  // BOTH restore sites go through here. There were two, and guarding only one of
  // them left the MORE reachable path unable to report itself: a `caddy validate`
  // rejection is an ordinary outcome, and at that moment the live file holds the
  // invalid content — so a restore that throws there escaped as a generic 500
  // with no backup path and no log line.
  const restore = (failure, cause) => {
    try {
      fs.copyFileSync(backup, caddyfilePath);
    } catch (restoreErr) {
      log.error('The Caddyfile could not be restored, so the live gate is not what anyone intended',
        { error: restoreErr.message, cause, backup });
      return {
        ok: false,
        backup,
        error: `${failure} (the Caddyfile could not be restored: ${restoreErr.message})`,
        restored: false,
        cause
      };
    }
    return { ok: false, backup, error: failure, restored: true, cause };
  };

  // Guarded for the same failure class the config write below is guarded for.
  // A mid-write ENOSPC truncates the LIVE gate and throws before `validateFn`
  // ever runs, so the fail-closed restore that makes this function safe would be
  // skipped entirely — the one path that can leave a broken ingress behind.
  try {
    fs.writeFileSync(caddyfilePath, newContent, { mode: 0o600 });
  } catch (err) {
    return restore(err.message, 'write');
  }

  const v = validateFn(caddyfilePath);
  if (!v.ok) {
    return restore(v.error || 'validation failed', 'validate');
  }
  // Only after a good write, so a run that restored still leaves its own backup
  // in place for whoever has to look at what went wrong.
  pruneCaddyfileBackups(caddyfilePath);
  return { ok: true, backup, error: null, restored: false, cause: null };
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
 * @param {boolean} [fromLoopback] - Whether this request arrived on a loopback
 *   connection. **Defaults to false — this one fails CLOSED**, unlike
 *   `caddyAvailable` below, because it is the actual security guard: a caller
 *   that omits it must be refused, never waved through. The default previously
 *   read `true`, justified by "non-request callers (the CLI has no socket)" —
 *   there is no such caller. Both call sites are in `server.js` and both pass a
 *   real socket answer, so nothing depends on the permissive behaviour, and a
 *   future caller that forgets the argument now gets a clean refusal instead of
 *   silent authorization.
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
function canChangeCredential(config, ingressState, caddyAvailable = true, fromLoopback = false) {
  const state = ingressState && ingressState.state;
  // FIRST, because it is the only condition about the connection rather than the
  // machine, and because it closes a path the other three cannot see.
  //
  // In caddy mode the listener is loopback-only (`bindPolicy.describeBindState`
  // locks it, overriding even an explicit opt-in), so Caddy — which proxies from
  // 127.0.0.1 — is the only way in. But that bind is chosen at LISTEN time, while
  // `ingressMode` is read per request. An install running direct-mode-and-wide
  // (the legacy grace state) has an unauthenticated `PATCH /api/config` that
  // accepts `ingressMode`, so a caller on the network can flip config to caddy
  // and reach this route over the still-wide socket without a restart. Every
  // other condition here would be satisfied on a machine whose Caddyfile really
  // does carry a gate. Asking the SOCKET closes that, and asks nothing of the
  // operator's Caddyfile.
  //
  // Deliberately not an `X-Auth-User` check: in caddy mode TC trusts that header,
  // so anyone able to make the request can also set it — it proves nothing a
  // caller cannot forge. It would also have broken this machine, whose
  // hand-edited Caddyfile has one gated `reverse_proxy` with no `header_up`.
  if (!fromLoopback) {
    return {
      allowed: false,
      code: CREDENTIAL_CODES.REMOTE_CONNECTION,
      reason: 'This request did not come through the login gate, so it cannot change the login.',
      remedy: 'Open TangleClaw at its usual address, or run `node scripts/reset-admin.js` at a terminal on this machine.'
    };
  }
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
  return _persistGatedCaddyfile({
    caddyfilePath,
    newContent: patched.content,
    user: patched.user,
    hash,
    replaced: patched.replaced,
    uid, stamp, reload, execFn, validateFn, reloadCommand
  });
}

/**
 * Write a new Caddyfile fail-closed, record the credential it carries, and
 * reload — the half of a credential change that is identical whether the gate
 * was re-hashed in place or built for the first time.
 *
 * Shared rather than duplicated because the ORDER is the safety property, not
 * the individual steps: the file is written and validated before config moves,
 * so a failure leaves the live gate and the recorded credential agreeing. A
 * second copy of this sequence would be free to drift out of that order, and
 * this project has already paid for exactly that once.
 *
 * @param {object} opts
 * @param {string} opts.caddyfilePath - Live Caddyfile.
 * @param {string} opts.newContent - Full replacement content, already gated.
 * @param {string} opts.user - Username the new content's gate carries.
 * @param {string} opts.hash - Bcrypt hash to record in config.
 * @param {number} opts.replaced - Credential lines changed, for reporting.
 * @param {number} opts.uid - Numeric uid for the launchctl target.
 * @param {string} opts.stamp - Filename-safe timestamp for the backup.
 * @param {boolean} opts.reload - Reload inline, or leave pending for the caller.
 * @param {Function} opts.execFn - Injected `execFileSync` (tests).
 * @param {Function} opts.validateFn - Injected validator (tests).
 * @param {string} opts.reloadCommand - Pre-rendered manual reload command.
 * @returns {{ok: boolean, code: string, backup: (string|null), error: (string|null),
 *   reloaded: boolean, reloadPending: boolean, reloadCommand: string,
 *   replaced: number, user: (string|null)}}
 */
function _persistGatedCaddyfile(opts) {
  const {
    caddyfilePath, newContent, user, hash, replaced,
    uid, stamp, reload, execFn, validateFn, reloadCommand
  } = opts;
  const written = writeValidatedCaddyfile(caddyfilePath, newContent, validateFn, stamp);

  if (!written.ok) {
    return {
      ok: false,
      // Three outcomes, not one. Collapsing them makes the caller say "nothing
      // was changed" about a machine whose live gate is whatever a failed write
      // left behind, or blame Caddy's parser for a full disk. The credential did
      // not change in any of them — but they send the operator to three different
      // places, and only one of them is "check your syntax".
      code: written.restored === false
        ? CREDENTIAL_CODES.GATE_BROKEN
        : (written.cause === 'write'
          ? CREDENTIAL_CODES.WRITE_FAILED
          : CREDENTIAL_CODES.VALIDATE_FAILED),
      backup: written.backup,
      error: written.error,
      reloaded: false,
      reloadPending: false,
      reloadCommand,
      replaced: 0,
      user: user
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
    config.basicAuthUser = user;
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
        replaced: replaced,
        user: user
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
      user: user
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
    replaced: replaced,
    user: user
  };
}

/**
 * Whether a gate can be built in this Caddyfile — the pure predicate behind
 * {@link createGate}.
 *
 * Separate from the write so a `--dry-run` can answer the same question the real
 * run will. A preview that promised a rebuild the real path then refuses is the
 * failure this whole surface exists to avoid, and it would land on someone
 * already locked out, checking before they commit. Same reason
 * `canChangeCredential` is separate from `applyCredentialChange`.
 *
 * @param {object} config - Loaded config; `ingressMode` decides whether a gate in
 *   this file would be enforced by anything.
 * @param {string} content - Caddyfile text.
 * @param {string} [user] - Proposed username.
 * @returns {{allowed: boolean, code: string, reason: (string|null)}}
 */
function canCreateGate(config, content, user) {
  // Config is REQUIRED rather than optional. An ingress check that a caller may
  // omit is one forgetful call site away from writing `authEnabled: true` onto a
  // machine nothing is gating, and the sibling predicate would have refused it.
  if (!config || config.ingressMode !== 'caddy') {
    return {
      allowed: false,
      code: CREDENTIAL_CODES.NOT_CADDY_MODE,
      reason: 'this install is not in caddy ingress mode, so nothing would enforce a gate written '
        + 'into this file. A leftover Caddyfile from a previous cutover is not a live gate — '
        + 'run `ingress-cutover.js --to caddy` first'
    };
  }
  if (!user) {
    return {
      allowed: false,
      code: CREDENTIAL_CODES.NO_CREDENTIAL,
      reason: 'a username is required to create a gate (there is no existing one to read it from)'
    };
  }
  const state = caddy.classifyCaddyfileContent(content);
  // Asked BEFORE the generated check so a hand-edited file that already has a
  // login is told it has one, rather than being told it is the wrong shape to
  // build one in. Same refusal either way; only one of them is the truth.
  if (state.users.length > 0) {
    return {
      allowed: false,
      code: CREDENTIAL_CODES.GATE_EXISTS,
      reason: `this Caddyfile already gates on '${state.users.join("', '")}'`
    };
  }
  if (!state.safeToWrite) {
    return {
      allowed: false,
      code: CREDENTIAL_CODES.NOT_GENERATED,
      reason: 'this Caddyfile is hand-maintained and carries no login. Adding one means editing '
        + 'blocks this tool did not write, so it will not guess at them'
    };
  }
  const derived = caddy.extractGeneratedCaddyfileOptions(content);
  if (!derived) {
    return {
      allowed: false,
      code: CREDENTIAL_CODES.UNRECOGNIZED_SHAPE,
      reason: 'this Caddyfile is stamped as generated but its ports, upstream or certificate '
        + 'could not be read back, so regenerating it could move settings that are working'
    };
  }

  // PROVE the recovery is total, rather than trusting the field list.
  //
  // Rebuilding from a handful of extracted fields silently drops anything the
  // extractor does not model. That is not hypothetical: `buildCaddyfileContent`
  // also takes `publicDomain`, the cutover passes it whether or not a gate is
  // configured, and an ungated file carrying a public ACME site is exactly the
  // population this function serves. Such a file extracts CLEANLY — the public
  // block repeats the same upstream and emits no `tls` line, so both unanimity
  // checks still hold — and the rebuild then omits the block, validates, and
  // restarts Caddy while reporting success. The operator loses their public site
  // with no error, on the one surface built to never report an unobserved outcome.
  //
  // So the ungated rebuild must reproduce the original byte for byte. The header
  // is a sha256 of the body, which makes this an exact round-trip and turns "we
  // extracted the right fields" from a claim into a check — one that covers
  // `publicDomain`, `localSite`, and whatever option the generator gains next.
  let roundTrip;
  try {
    roundTrip = caddy.buildCaddyfileContent(derived);
  } catch (err) {
    return { allowed: false, code: CREDENTIAL_CODES.UNRECOGNIZED_SHAPE, reason: err.message };
  }
  if (roundTrip !== content) {
    return {
      allowed: false,
      code: CREDENTIAL_CODES.UNRECOGNIZED_SHAPE,
      reason: 'this Caddyfile carries settings this tool cannot reproduce — a public-domain site, '
        + 'or an option added since it was written. Rebuilding it would drop them silently, so it '
        + 'will not rebuild. Add the credential with `ingress-cutover.js` instead, which builds from '
        + 'your full config'
    };
  }

  return { allowed: true, code: CREDENTIAL_CODES.OK, reason: null };
}

/**
 * Build a basic_auth gate on an install that completed setup without one.
 *
 * A machine can reach `setupComplete` in caddy mode carrying no credential — an
 * install that finished before the credential became mandatory and then moved to
 * caddy ingress. Every other way in refuses it: the setup route is already
 * complete, the adopt path only runs on a first run, and changing a credential
 * needs one to change. Nothing was left that could put a login on it, which is a
 * strange place for a product whose posture is secure-by-default to strand
 * someone. This is the way out, and it is deliberately the same local-shell tool
 * as recovery: the alternative — letting an unauthenticated route set the first
 * credential — reopens the hole that making the gate mandatory closed.
 *
 * Refuses unless ALL of: the install is in caddy mode (read from config here — a
 * Caddyfile left behind by a `--to direct` cutover is a file, not a live gate, and
 * gating it would record protection nothing enforces), a username is supplied, the
 * file carries no credential already, and the file is TangleClaw-GENERATED. An
 * ungated file a human maintains is refused rather than reshaped: adding a gate
 * means placing directives inside site blocks this code did not write, and guessing
 * wrong either drops the operator's configuration or leaves an opening it appears to
 * have closed. See {@link canCreateGate}, which both this and `--dry-run` ask.
 *
 * Where it does proceed, the rebuild is derived from the ORIGINAL FILE rather than
 * from config and is proven byte-for-byte reproducible first, so it differs from what
 * was there by exactly the gate. A file that cannot be reproduced is refused, not
 * approximated.
 *
 * @param {object} opts
 * @param {string} opts.caddyfilePath - Live Caddyfile.
 * @param {string} opts.user - Username for the new gate. Required — unlike a
 *   change, there is no existing line to read one from.
 * @param {string} opts.hash - New bcrypt hash.
 * @param {number} opts.uid - Numeric uid for the launchctl target.
 * @param {string} opts.stamp - Filename-safe timestamp for the backup.
 * @param {boolean} [opts.reload] - Reload Caddy inline.
 * @param {Function} [opts.execFn] - Injected `execFileSync` (tests).
 * @param {Function} [opts.validateFn] - Injected validator (tests).
 * @returns {{ok: boolean, code: string, backup: (string|null), error: (string|null),
 *   reloaded: boolean, reloadPending: boolean, reloadCommand: string,
 *   replaced: number, user: (string|null)}}
 */
function createGate(opts) {
  const {
    caddyfilePath, user, hash, uid, stamp,
    reload = true,
    execFn = execFileSync,
    validateFn = caddy.validateCaddyfile
  } = opts;

  const reloadCommand = `launchctl ${reloadCaddyArgs(uid).join(' ')}`;
  const refuse = (code, error) => ({
    ok: false, code, backup: null, error,
    reloaded: false, reloadPending: false, reloadCommand, replaced: 0, user: null
  });

  let original;
  try {
    original = fs.readFileSync(caddyfilePath, 'utf8');
  } catch (err) {
    // Includes ENOENT. Creating a Caddyfile from nothing is provisioning, not
    // recovery — it needs certificates and LaunchAgents this tool does not
    // manage — so a missing file is a refusal here rather than a blank canvas.
    return refuse(CREDENTIAL_CODES.UNREADABLE, err.message);
  }

  // One predicate, asked here and by `--dry-run`, so a preview cannot promise a
  // rebuild this refuses.
  const verdict = canCreateGate(store.config.load(), original, user);
  if (!verdict.allowed) return refuse(verdict.code, verdict.reason);

  const newContent = caddy.buildCaddyfileContent({
    ...caddy.extractGeneratedCaddyfileOptions(original),
    basicAuthUser: user,
    basicAuthHash: hash
  });

  return _persistGatedCaddyfile({
    caddyfilePath,
    newContent,
    user,
    hash,
    // Counted from the built content rather than assumed to be 1: the generator
    // emits the credential once per gated site, and the operator is told how
    // many lines changed.
    replaced: newContent.split(hash).length - 1,
    uid, stamp, reload, execFn, validateFn, reloadCommand
  });
}

module.exports = {
  BACKUP_RETENTION,
  CREDENTIAL_CODES,
  httpCode,
  isLoopbackRemote,
  reloadCaddyArgs,
  reloadCaddy,
  reloadCaddyAsync,
  pruneCaddyfileBackups,
  writeValidatedCaddyfile,
  canChangeCredential,
  canCreateGate,
  applyCredentialChange,
  createGate
};
