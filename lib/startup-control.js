'use strict';

/**
 * startupControl: whether an engine can be handed its startup instruction
 * through its own native, persistent, interactive channel, and get back a
 * receipt that it accepted and applied it (#1825).
 *
 * The capability is declared in the engine profile (`capabilities.startupControl`)
 * but it is never granted by the profile alone. A profile NAMES an adapter; the
 * adapter is code registered in `ADAPTERS` below. An operator who edits a
 * profile can therefore describe a channel, but cannot conjure one: a named
 * adapter that is not registered resolves to `unsupported`, the same answer as
 * declaring nothing. That is the `engine-errors.js` PARSERS rule ("a profile
 * JSON selects a parser, it never supplies one") applied to a stronger
 * capability, because an adapter here SUBMITS a turn to a model.
 *
 * Everything engine-specific (sockets, protocol, version probing) lives behind
 * an adapter. The generic store, API and UI see only the resolution this module
 * returns, so no engine's contract leaks into them.
 */

const { createLogger } = require('./logger');

const log = createLogger('startup-control');

/**
 * Registered adapters, keyed by the name a profile's `adapter` field uses.
 *
 * Empty until an engine has a verified native channel. An adapter is an object
 * implementing the contract documented in `docs/engine-guide.md`
 * ("startupControl"); nothing may be registered here without one.
 *
 * @type {Object<string, object>}
 */
const ADAPTERS = Object.freeze({});

/**
 * The fields a `startupControl` block may declare, and what each must be.
 *
 * - `adapter`: the registered adapter that implements the channel.
 * - `channel`, `readiness`, `receipt`, `blockers`: short descriptions of what
 *   the engine offers for each of the four acceptance cases. They are shown to
 *   people and never parsed; the adapter owns the behavior.
 * - `verifiedVersions`: the engine CLI versions this channel was verified on. An
 *   adapter reports an installed version outside this list as unsupported
 *   rather than guessing, because a native protocol can change between
 *   releases.
 *
 * @type {Object<string, {required: boolean, check: (value: *) => boolean, expects: string}>}
 */
const FIELDS = {
  adapter: { required: true, check: _isText, expects: 'a non-empty string naming a registered adapter' },
  channel: { required: true, check: _isText, expects: 'a non-empty string' },
  readiness: { required: true, check: _isText, expects: 'a non-empty string' },
  receipt: { required: true, check: _isText, expects: 'a non-empty string' },
  blockers: { required: true, check: _isText, expects: 'a non-empty string' },
  verifiedVersions: {
    required: true,
    check: (v) => Array.isArray(v) && v.length > 0 && v.every(_isText),
    expects: 'a non-empty array of version strings'
  }
};

/**
 * Whether a value is a non-empty string.
 * @param {*} v - Value to test.
 * @returns {boolean}
 */
function _isText(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Every problem with a declared `startupControl` block.
 *
 * Follows the `wake` block's rules: unknown fields are refused, and `evidence`
 * must vouch for every declared field and for nothing else, so a value with no
 * provenance cannot read as verified.
 *
 * @param {*} block - The profile's `capabilities.startupControl` value.
 * @returns {string[]} Problems, empty when the block is well-formed.
 */
function blockErrors(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return ['startupControl must be an object'];
  const errors = [];
  const declared = Object.keys(block).filter((k) => k !== 'evidence');

  for (const [field, spec] of Object.entries(FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(block, field)) {
      if (spec.required) errors.push(`startupControl.${field} is required (${spec.expects})`);
      continue;
    }
    if (!spec.check(block[field])) errors.push(`startupControl.${field} must be ${spec.expects}`);
  }
  for (const field of declared) {
    if (!Object.prototype.hasOwnProperty.call(FIELDS, field)) {
      errors.push(`startupControl.${field} is not a field this capability reads`);
    }
  }

  const evidence = block.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    errors.push('startupControl.evidence is required: every declared field names where it was verified');
    return errors;
  }
  for (const field of declared) {
    const entry = evidence[field];
    if (!entry || typeof entry !== 'object') {
      errors.push(`startupControl.evidence.${field} is missing: a value with no provenance reads as verified`);
      continue;
    }
    if (entry.verifiedOn !== null
      && !(/^\d{4}-\d{2}-\d{2}$/.test(entry.verifiedOn) && !Number.isNaN(Date.parse(entry.verifiedOn)))) {
      errors.push(`startupControl.evidence.${field}.verifiedOn must be an ISO date or null`);
    }
    if (!_isText(entry.source)) errors.push(`startupControl.evidence.${field}.source must name where this was verified`);
  }
  for (const field of Object.keys(evidence)) {
    if (!declared.includes(field)) errors.push(`startupControl.evidence.${field} has no field to vouch for`);
  }
  return errors;
}

/**
 * Resolve what this engine's startupControl capability actually is.
 *
 * **One decision for every reader.** `tc capabilities`, the fire service and
 * (later) the launch path all ask this function, so none can treat an engine
 * as supported while another refuses it.
 *
 * The installed engine version is not checked here: only the adapter knows how
 * to probe it. A `supported` answer therefore means "an adapter will attempt
 * this"; the adapter itself refuses an unverified version as unsupported at the
 * moment it is used.
 *
 * @param {object|null} profile - An engine profile.
 * @param {Object<string, object>} [adapters=ADAPTERS] - Registry (a test seam).
 * @returns {{supported: boolean, reasonCode: (string|null), reason: string, adapter: (object|null), block: (object|null)}}
 */
function resolve(profile, adapters = ADAPTERS) {
  const engine = profile && profile.id ? profile.id : 'unknown';
  const declared = profile && profile.capabilities ? profile.capabilities.startupControl : undefined;
  if (declared === undefined) {
    return { supported: false, reasonCode: 'engine_declares_none', reason: `engine ${engine} declares no startupControl channel`, adapter: null, block: null };
  }
  const errors = blockErrors(declared);
  if (errors.length > 0) {
    log.warn('Engine declares a malformed startupControl block; it resolves to unsupported', { engine, errors });
    return { supported: false, reasonCode: 'profile_block_malformed', reason: `engine ${engine} declares a malformed startupControl block`, adapter: null, block: null };
  }
  const adapter = Object.prototype.hasOwnProperty.call(adapters, declared.adapter) ? adapters[declared.adapter] : null;
  if (!adapter) {
    return {
      supported: false,
      reasonCode: 'adapter_not_registered',
      reason: `engine ${engine} names adapter "${declared.adapter}", which this TangleClaw does not implement`,
      adapter: null,
      block: declared
    };
  }
  return { supported: true, reasonCode: null, reason: `adapter "${declared.adapter}"`, adapter, block: declared };
}

module.exports = { ADAPTERS, FIELDS, blockErrors, resolve };
