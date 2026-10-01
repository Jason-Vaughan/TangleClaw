'use strict';

/**
 * The Discord helper's log: closed codes and timestamps, nothing else (#1799).
 *
 * The helper relays a third-party chat and holds two secrets, so what it may
 * write is a closed vocabulary rather than a free-form message. A caller passes
 * a code and, at most, numeric or id-shaped fields; message bodies, tokens,
 * headers and raw Discord responses have no field to travel in. An unknown code
 * is logged as `unknown-code` rather than printed, so a mistake in a caller
 * cannot become a leak.
 *
 * @module lib/discord-helper/log
 */

/**
 * Every code the helper may log, with what it means.
 * @type {Readonly<Record<string, string>>}
 */
const CODES = Object.freeze({
  'helper-start': 'the helper started',
  'helper-stop': 'the helper stopped',
  'helper-already-running': 'another helper is running; two would post every reply twice',
  'config-missing': 'the helper has no config; run configure',
  'config-invalid': 'the helper\'s config is not valid; run configure',
  'status-write-failed': 'the status snapshot could not be written',
  'secret-missing': 'a Keychain item the helper needs is absent',
  'secret-read-failed': 'the Keychain could not be read',
  'secret-store-failed': 'a secret could not be stored in the Keychain',
  'state-unreadable': 'the helper\'s record of replies in progress could not be read; it will not start without it',
  'gateway-connecting': 'connecting to the Discord Gateway',
  'gateway-ready': 'the Gateway session is ready',
  'gateway-resumed': 'the Gateway session resumed',
  'gateway-closed': 'the Gateway connection closed; a reconnect is scheduled',
  'gateway-fatal': 'Discord closed the Gateway for a reason a retry cannot fix',
  'gateway-invalid-session': 'Discord invalidated the session; identifying afresh',
  'inbound-ignored': 'a message outside the allowlist was ignored without reading it',
  'inbound-accepted': 'an operator message was handed to TangleClaw',
  'inbound-replayed': 'an operator message TangleClaw already had was handed over again',
  'inbound-refused': 'TangleClaw refused an operator message',
  'inbound-transport-failed': 'TangleClaw could not be reached with an operator message',
  'inbound-notice-failed': 'the reaction or notice telling the operator how a message fared could not be posted',
  'inbound-handler-failed': 'an operator message could not be handled',
  'outbound-posted': 'a reply was posted to Discord',
  'outbound-acked': 'a posted reply was acknowledged to TangleClaw',
  'outbound-post-failed': 'Discord did not accept a reply; it stays unacknowledged',
  'outbound-ack-failed': 'a posted reply could not be acknowledged yet',
  'outbound-uncertain': 'a reply may have posted before a restart and cannot be confirmed',
  'outbound-rejected': 'Discord rejected a reply itself; it is held for the operator and not retried',
  'outbound-poll-failed': 'TangleClaw could not be polled for replies',
  'outbound-queue-held': 'every reply TangleClaw listed is held for the operator; newer ones may be waiting behind them',
  'discord-rate-limited': 'Discord asked the helper to slow down; the call is retried once after the wait',
  'unknown-code': 'a caller used a code this log does not define'
});

/**
 * Field values allowed through: numbers, booleans, and short id-shaped strings.
 * Discord ids are at most 20 digits, so 32 characters fits every id the helper
 * logs while leaving out both secrets, which are longer: the channel token is
 * 48 characters and a bot token is longer still.
 */
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,32}$/;

/**
 * Keep only fields whose values cannot carry text.
 * @param {object} [fields] - Candidate fields
 * @returns {object}
 */
function safeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (!/^[a-zA-Z]{1,32}$/.test(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && SAFE_VALUE.test(v) && !v.startsWith('ocsk_')) out[k] = v;
  }
  return out;
}

/**
 * Make a logger that writes one JSON line per event.
 * @param {object} [opts]
 * @param {function(string): void} [opts.write] - Line sink; stderr by default
 * @param {function(): Date} [opts.now] - Clock
 * @returns {{log: function(string, object=): object, CODES: object}}
 */
function createLog(opts = {}) {
  const write = opts.write || ((line) => process.stderr.write(`${line}\n`));
  const now = opts.now || (() => new Date());
  return {
    CODES,
    /**
     * Log one event.
     * @param {string} code - A key of CODES
     * @param {object} [fields] - Numeric or id-shaped fields only
     * @returns {object} The record written
     */
    log(code, fields) {
      const known = Object.prototype.hasOwnProperty.call(CODES, code);
      const record = { at: now().toISOString(), code: known ? code : 'unknown-code', ...safeFields(fields) };
      write(JSON.stringify(record));
      return record;
    }
  };
}

module.exports = { CODES, createLog, safeFields };
