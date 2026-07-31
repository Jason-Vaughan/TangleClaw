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
const { execFileSync } = require('node:child_process');
const caddy = require('./caddy');
const store = require('./store');
const { createLogger } = require('./logger');

const log = createLogger('admin-credential');

const CADDY_LABEL = 'com.tangleclaw.caddy';

/** Why a credential change was refused. Returned to callers; safe to show. */
const CREDENTIAL_CODES = Object.freeze({
  OK: 'ok',
  NOT_CADDY_MODE: 'not-caddy-mode',
  NO_GATE: 'no-gate',
  NO_CREDENTIAL: 'no-credential',
  UNREADABLE: 'unreadable',
  VALIDATE_FAILED: 'validate-failed'
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
  return ['kickstart', '-k', `gui/${uid}/${CADDY_LABEL}`];
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
 * @returns {{ok: boolean, backup: string, error: (string|null)}}
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
 * @returns {{allowed: boolean, code: string, reason: (string|null), remedy: (string|null)}}
 */
function canChangeCredential(config, ingressState) {
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
    return {
      allowed: false,
      code: CREDENTIAL_CODES.NO_GATE,
      reason: 'The Caddy config in front of TangleClaw carries no login, so there is none to change here.',
      remedy: 'Run `node scripts/reset-admin.js` at a terminal on this machine.'
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
 * left to run.
 * @param {object} opts
 * @param {string} opts.caddyfilePath - Live Caddyfile.
 * @param {string} opts.user - Username to write (existing or new).
 * @param {string} opts.hash - New bcrypt hash.
 * @param {number} opts.uid - Numeric uid for the launchctl target.
 * @param {string} opts.stamp - Filename-safe timestamp for the backup.
 * @param {Function} [opts.execFn] - Injected `execFileSync` (tests).
 * @param {Function} [opts.validateFn] - Injected validator (tests).
 * @returns {{ok: boolean, code: string, backup: (string|null), error: (string|null),
 *   reloaded: boolean, reloadCommand: string}}
 */
function applyCredentialChange(opts) {
  const {
    caddyfilePath, user, hash, uid, stamp,
    execFn = execFileSync,
    validateFn = caddy.validateCaddyfile
  } = opts;

  const original = fs.readFileSync(caddyfilePath, 'utf8');
  const patched = caddy.replaceBasicAuthCredential(original, { hash, user });
  const written = writeValidatedCaddyfile(caddyfilePath, patched.content, validateFn, stamp);
  const reloadCommand = `launchctl ${reloadCaddyArgs(uid).join(' ')}`;

  if (!written.ok) {
    return {
      ok: false,
      code: CREDENTIAL_CODES.VALIDATE_FAILED,
      backup: written.backup,
      error: written.error,
      reloaded: false,
      reloadCommand
    };
  }

  // Only now, with a validated gate on disk, does the recorded credential move.
  const config = store.config.load();
  config.authEnabled = true;
  config.basicAuthUser = patched.user;
  config.basicAuthHash = hash;
  store.config.save(config);

  let reloaded = true;
  try {
    execFn('launchctl', reloadCaddyArgs(uid), { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    reloaded = false;
    // Not an error for the caller: the credential IS changed. Logged so the
    // reason exists somewhere, without the message claiming a failure.
    log.warn('Admin credential changed, but Caddy could not be reloaded automatically',
      { error: err.message, reloadCommand });
  }

  return {
    ok: true,
    code: CREDENTIAL_CODES.OK,
    backup: written.backup,
    error: null,
    reloaded,
    reloadCommand
  };
}

module.exports = {
  CADDY_LABEL,
  CREDENTIAL_CODES,
  httpCode,
  reloadCaddyArgs,
  writeValidatedCaddyfile,
  canChangeCredential,
  applyCredentialChange
};
