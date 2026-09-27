'use strict';

/**
 * Whether it is safe to give a sandboxed agent loopback network access (#1957).
 *
 * Codex's loopback profile lets a Full Auto agent reach every port on
 * `127.0.0.1` and `localhost`, because Codex's proxy cannot narrow a host to
 * one port. Loopback is not neutral ground on this machine. Two things grant
 * privilege there on the source address alone:
 * - ttyd, when it listens on TCP. It runs `--writable` against
 *   `tmux attach-session`, so a loopback client that opens its WebSocket has a
 *   shell.
 * - The API's machine-client carve-out (`lib/auth-gate.js#isMachineClient`). A
 *   loopback caller that is not browser-shaped is let past the login.
 *
 * Handing an agent loopback while either holds would let "sandboxed" stop
 * bounding what it can do. So the profile may be applied only when:
 * 1. ttyd is off TCP: the install is in caddy mode AND the installed ttyd job
 *    binds a unix socket. The config alone is a claim about what the job
 *    should be; the job's own arguments are what it runs.
 * 2. Loopback API access needs cryptographic auth: the AUTH-4 service-token
 *    gate is on with a token, AND the machine-client carve-out does not admit
 *    a loopback caller to privileged routes without that token.
 *
 * Every fact must be present and exactly the value that grants. A missing,
 * unreadable or unfamiliar fact withholds the profile. This check does not
 * remove the source-address trust; it only refuses to extend it to a sandbox
 * while it exists.
 *
 * Pure: the caller gathers the facts (`lib/startup-control-codex.js`). Every
 * granting verdict this module issues is remembered in a private WeakSet, so
 * the profile module can tell a real grant from an object that merely says
 * `granted: true`, or a copy of one.
 *
 * @module lib/loopback-trust-guard
 */

/** Why the profile was granted or withheld. */
const CODES = Object.freeze({
  GRANTED: 'granted',
  FACTS_UNKNOWN: 'facts-unknown',
  TTYD_ON_TCP: 'ttyd-on-tcp',
  TTYD_BIND_UNKNOWN: 'ttyd-bind-unknown',
  LOOPBACK_API_UNAUTHENTICATED: 'loopback-api-unauthenticated'
});

/** The granting verdicts this module issued. Not exported. */
const ISSUED_GRANTS = new WeakSet();

/**
 * Build a frozen verdict.
 * @param {boolean} granted - Whether the profile may be applied.
 * @param {string} code - One of {@link CODES}.
 * @param {string} reason - Operator-facing explanation.
 * @returns {Readonly<{granted: boolean, code: string, reason: string}>}
 */
function _verdict(granted, code, reason) {
  const v = Object.freeze({ granted, code, reason });
  if (granted) ISSUED_GRANTS.add(v);
  return v;
}

/**
 * Withhold, with a code and reason.
 * @param {string} code - One of {@link CODES}.
 * @param {string} reason - Operator-facing explanation.
 * @returns {Readonly<object>}
 */
function _withhold(code, reason) {
  return _verdict(false, code, reason);
}

/**
 * The value that follows a flag in an argument list, or null.
 * @param {string[]} args - ProgramArguments.
 * @param {string} flag - e.g. `--interface`.
 * @returns {string|null}
 */
function _flagValue(args, flag) {
  const at = args.indexOf(flag);
  return at !== -1 && at + 1 < args.length && typeof args[at + 1] === 'string' ? args[at + 1] : null;
}

/**
 * Decide whether the loopback profile may be applied.
 *
 * @param {object} facts - Gathered by the caller.
 * @param {object|null} facts.config - The global config, or null when it could not be read.
 * @param {string[]|null} facts.ttydArgs - The installed ttyd job's ProgramArguments, or null
 *   when there is no job, or it could not be read or parsed.
 * @param {string|null} facts.ttydSocketPath - The unix socket caddy mode binds ttyd to.
 * @param {boolean|null} facts.machineClientRequiresServiceToken - Whether the API's loopback
 *   machine-client carve-out demands the service token (`lib/auth-gate.js`).
 * @returns {Readonly<{granted: boolean, code: string, reason: string}>}
 */
function assessLoopbackTrust(facts) {
  if (!facts || typeof facts !== 'object') {
    return _withhold(CODES.FACTS_UNKNOWN, 'the facts needed to judge loopback trust were not gathered');
  }
  const { config, ttydArgs, ttydSocketPath, machineClientRequiresServiceToken } = facts;
  if (!config || typeof config !== 'object') {
    return _withhold(CODES.FACTS_UNKNOWN, 'the TangleClaw config could not be read, so the ttyd and API protections are unknown');
  }

  // 1. ttyd off TCP.
  if (config.ingressMode !== 'caddy') {
    return _withhold(CODES.TTYD_ON_TCP, `ingress mode is ${JSON.stringify(config.ingressMode === undefined ? null : config.ingressMode)}, not caddy, so ttyd listens on TCP where any loopback client can open a writable terminal`);
  }
  if (!Array.isArray(ttydArgs) || !ttydArgs.every((a) => typeof a === 'string')) {
    return _withhold(CODES.TTYD_BIND_UNKNOWN, 'the installed ttyd job could not be read, so whether ttyd is off TCP is unknown');
  }
  const iface = _flagValue(ttydArgs, '--interface');
  if (typeof ttydSocketPath !== 'string' || !ttydSocketPath.startsWith('/')) {
    return _withhold(CODES.TTYD_BIND_UNKNOWN, 'the ttyd socket path is unknown, so the installed job cannot be checked against it');
  }
  if (iface !== ttydSocketPath) {
    return _withhold(CODES.TTYD_ON_TCP, iface === null
      ? 'the installed ttyd job names no --interface, so it listens on TCP on every interface'
      : 'the installed ttyd job does not bind the caddy-mode unix socket, so it is on TCP (or on a socket TangleClaw does not manage)');
  }

  // 2. Loopback API access needs cryptographic auth.
  if (config.serviceTokenEnabled !== true || typeof config.serviceToken !== 'string' || config.serviceToken.length === 0) {
    return _withhold(CODES.LOOPBACK_API_UNAUTHENTICATED, 'the AUTH-4 service-token gate is not enabled with a token');
  }
  if (machineClientRequiresServiceToken !== true) {
    return _withhold(CODES.LOOPBACK_API_UNAUTHENTICATED, 'the API admits a loopback machine client to privileged routes without the service token');
  }

  return _verdict(true, CODES.GRANTED, 'ttyd is on the caddy-mode unix socket and loopback API access requires the service token');
}

/**
 * Whether a value is a granting verdict issued by {@link assessLoopbackTrust}.
 * @param {*} verdict - Candidate.
 * @returns {boolean}
 */
function isGranted(verdict) {
  return !!verdict && typeof verdict === 'object' && ISSUED_GRANTS.has(verdict) && verdict.granted === true;
}

module.exports = { CODES, assessLoopbackTrust, isGranted };
