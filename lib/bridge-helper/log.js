'use strict';

/**
 * The bridge helper's log: closed codes and timestamps, nothing else (#2031).
 *
 * The helper relays a third-party chat and holds two secrets, so what it may
 * write is a closed vocabulary, not a free-form message. A caller passes a
 * code and, at most, numeric or id-shaped fields. Message text, tokens,
 * headers and Discord's raw answers have no field to travel in. A code this
 * file does not define is written as `unknown-code`, so a mistake in a caller
 * cannot become a leak.
 *
 * @module lib/bridge-helper/log
 */

/**
 * Every code the helper may log, with what it means.
 * @type {Readonly<Record<string, string>>}
 */
const CODES = Object.freeze({
  'helper-start': 'the helper started',
  'helper-stop': 'the helper stopped',
  'helper-already-running': 'another helper is running, or it could not be checked that none is; two would post every item twice',
  'config-missing': 'the helper has no config; run configure',
  'config-invalid': 'the helper\'s config is not valid; run configure',
  'secret-missing': 'a Keychain item the helper needs is absent',
  'secret-read-failed': 'the Keychain could not be read',
  'state-unreadable': 'the record of posts in progress could not be read; the helper will not start without it',
  'state-write-failed': 'the record of posts in progress could not be written; nothing is posted that could not be recorded first',
  'lock-failed': 'the one-helper lock could not be taken',
  'status-write-failed': 'the status snapshot could not be written',
  'gateway-connecting': 'connecting to the Discord Gateway',
  'gateway-ready': 'the Gateway session is ready',
  'gateway-resumed': 'the Gateway session resumed',
  'gateway-address-refused': 'Discord named a first-connection address outside its own Gateway; nothing was sent to it and the helper identifies at the default address',
  'gateway-resume-refused': 'Discord named a resume address outside its own Gateway; the session was dropped and the helper identifies afresh',
  'gateway-closed': 'the Gateway connection closed; a reconnect is scheduled',
  'gateway-connect-failed': 'a connection to the Gateway failed before it opened; a reconnect is scheduled',
  'gateway-attempt-abandoned': 'a connection attempt did not reach a ready session within its time limit and was given up; a reconnect is scheduled',
  'gateway-watchdog-reconnect': 'the Gateway had no connection and nothing scheduled; the watchdog started an attempt',
  'gateway-fatal': 'Discord closed the Gateway for a reason a retry cannot fix',
  'gateway-invalid-session': 'Discord invalidated the session',
  'inbound-accepted': 'an operator message was handed to TangleClaw',
  'inbound-replayed': 'an operator message TangleClaw already had was handed over again',
  'inbound-refused': 'TangleClaw refused an operator message',
  'inbound-transport-failed': 'TangleClaw could not be reached with an operator message',
  'inbound-notice-failed': 'the reaction or notice telling the operator how a message fared could not be posted',
  'inbound-handler-failed': 'an operator message could not be handled',
  'claim-failed': 'TangleClaw could not be asked what to post',
  'outbound-posted': 'an item was posted to Discord',
  'outbound-acked': 'a posted item was acknowledged to TangleClaw',
  'outbound-post-failed': 'Discord did not take an item; it stays unacknowledged',
  'outbound-ack-failed': 'a posted item could not be acknowledged yet',
  'outbound-lease-short': 'an item\'s lease had too little time left to post it; it will be claimed again',
  'outbound-digest-mismatch': 'an item\'s text did not match the digest it was handed over with; it was not posted',
  'outbound-foreign-channel': 'an item named a channel other than the allowlisted one; it was not posted',
  'outbound-uncertain': 'an item may have posted and cannot be confirmed; it is held for the operator and not retried',
  'outbound-rejected': 'Discord rejected an item itself; the bridge was asked to set it aside for the operator',
  'outbound-chat-closed': 'Discord says the chat is closed to the helper (channel or server missing, permission denied, token refused); the bridge was told and stops handing items over',
  'outbound-reply-target-missing': 'the message an answer replies to may be gone; the answer is being tried once more by itself, and the next line says how that went',
  'outbound-unplaceable': 'Discord refused an item in a way the helper cannot place; nothing was posted, and the bridge was asked to set the item aside',
  'bridge-configuration-blocked': 'the bridge hands nothing over until its configuration circuit is reset by the Project Master or the operator',
  'outbound-part-conflict': 'the bridge\'s record of an item\'s parts disagrees with the helper\'s; the bridge was asked to set the item aside',
  'outbound-report-failed': 'the bridge could not be told that an item could not be posted; it is told again on the next pass',
  'outbound-pass-failed': 'a pass ended on a failure the helper did not expect; its type is given, never its message',
  'redirect-refused': 'a server answered with a redirect; the helper follows none',
  'discord-rate-limited': 'Discord asked the helper to slow down',
  'dm-surface-disabled-at-startup': 'the pinned DM channel failed its startup check (not a usable DM, or Discord could not confirm it); the DM surface is off for this run, the guild surface is unaffected',
  'unknown-code': 'a caller used a code this log does not define'
});

/**
 * Field values allowed through: numbers, booleans and short id-shaped
 * strings. A Discord id is at most 20 digits and a lease id 26 characters, so
 * 32 fits every id the helper logs while leaving out both secrets, which are
 * longer.
 */
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,32}$/;

/**
 * Keep only fields whose values cannot carry text.
 * @param {object} [fields] - Candidate fields.
 * @returns {object}
 */
function safeFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!/^[a-zA-Z]{1,32}$/.test(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string' && SAFE_VALUE.test(value) && !value.startsWith('bht_')) out[key] = value;
  }
  return out;
}

/**
 * Make a logger that writes one JSON line per event.
 * @param {object} [opts]
 * @param {function(string): void} [opts.write] - Line sink; stderr by default.
 * @param {function(): Date} [opts.now] - Clock.
 * @returns {function(string, object=): object} Logs one event and returns the record written.
 */
function createLog(opts = {}) {
  const write = opts.write || ((line) => process.stderr.write(`${line}\n`));
  const now = opts.now || (() => new Date());
  return (code, fields) => {
    const known = Object.prototype.hasOwnProperty.call(CODES, code);
    const record = { at: now().toISOString(), code: known ? code : 'unknown-code', ...safeFields(fields) };
    write(JSON.stringify(record));
    return record;
  };
}

module.exports = { CODES, createLog, safeFields };
