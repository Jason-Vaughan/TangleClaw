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
 * An adapter is an object implementing the contract documented in
 * `docs/engine-guide.md` ("startupControl"); nothing may be registered here
 * without one. `codex` drives Codex's app-server (#1825).
 *
 * @type {Object<string, object>}
 */
const ADAPTERS = Object.freeze({
  codex: require('./startup-control-codex')
});

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
 * **One decision for every reader.** `tc capabilities` and the fire service
 * both ask this function, and any later reader must too, so none can treat an
 * engine as supported while another refuses it.
 *
 * Supported means all three: a well-formed block, a registered adapter, and
 * an installed engine version the block lists in `verifiedVersions`. The
 * version comes from the adapter's `installedVersion()`, which must answer
 * synchronously from a value the adapter probed and cached earlier: this runs
 * on request paths and must never spawn a process. An adapter that cannot say
 * (not probed yet, or the probe failed) makes the engine unsupported, never
 * assumed verified.
 *
 * @param {object|null} profile - An engine profile.
 * @param {Object<string, object>} [adapters=ADAPTERS] - Registry (a test seam).
 * @param {string} [engineId] - Engine id for messages when the profile has none.
 * @returns {{supported: boolean, reasonCode: (string|null), reason: string, adapter: (object|null), block: (object|null)}}
 */
function resolve(profile, adapters = ADAPTERS, engineId) {
  const engine = profile && profile.id ? profile.id : (engineId || 'unknown');
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
  let version = null;
  try {
    version = typeof adapter.installedVersion === 'function' ? adapter.installedVersion() : null;
  } catch (err) {
    log.warn('startupControl adapter could not report the installed engine version', { engine, error: err.message });
    version = null;
  }
  if (typeof version !== 'string' || !declared.verifiedVersions.includes(version)) {
    return {
      supported: false,
      reasonCode: 'version_unverified',
      reason: version
        ? `engine ${engine} is at version ${version}, which its startupControl channel was not verified on`
        : `engine ${engine}'s installed version is unknown, so its startupControl channel cannot be treated as verified`,
      adapter: null,
      block: declared
    };
  }
  return { supported: true, reasonCode: null, reason: `adapter "${declared.adapter}" on verified version ${version}`, adapter, block: declared };
}

/**
 * Resolve the capability for an engine id, reading its profile through
 * `getProfile`. A profile that cannot be read resolves to unsupported with its
 * own reason, so a broken profile file degrades one capability instead of
 * failing the request that asked.
 * @param {string} engineId - Engine id, e.g. `codex` or `openclaw:<id>`.
 * @param {(id: string) => (object|null)} getProfile - Profile lookup.
 * @param {Object<string, object>} [adapters=ADAPTERS] - Registry (a test seam).
 * @returns {{supported: boolean, reasonCode: (string|null), reason: string, adapter: (object|null), block: (object|null)}}
 */
function resolveEngine(engineId, getProfile, adapters = ADAPTERS) {
  let profile;
  try {
    profile = getProfile(engineId);
  } catch (err) {
    log.warn('Engine profile could not be read; startupControl resolves to unsupported', { engine: engineId, error: err.message });
    return {
      supported: false,
      reasonCode: 'engine_profile_unreadable',
      reason: `engine ${engineId}'s profile could not be read`,
      adapter: null,
      block: null
    };
  }
  return resolve(profile, adapters, engineId);
}

/**
 * Resolve the capability for a launch, letting the named adapter refresh its
 * cached engine version first. Launches are operator actions that already
 * spawn processes, so a bounded synchronous probe is acceptable here where it
 * never is on a request path; `resolve` itself still never spawns.
 * @param {string} engineId - Engine id.
 * @param {(id: string) => (object|null)} getProfile - Profile lookup.
 * @param {Object<string, object>} [adapters=ADAPTERS] - Registry (a test seam).
 * @param {{enginePath: (string|null)}} [launch] - The resolved engine executable this launch runs, probed exactly.
 * @returns {{supported: boolean, reasonCode: (string|null), reason: string, adapter: (object|null), block: (object|null)}}
 */
function resolveForLaunch(engineId, getProfile, adapters = ADAPTERS, launch = {}) {
  let profile = null;
  try {
    profile = getProfile(engineId);
  } catch {
    profile = null;
  }
  const declared = profile && profile.capabilities ? profile.capabilities.startupControl : undefined;
  const adapter = declared && typeof declared === 'object' && Object.prototype.hasOwnProperty.call(adapters, declared.adapter)
    ? adapters[declared.adapter]
    : null;
  if (adapter && typeof adapter.probeVersionSync === 'function') {
    try {
      adapter.probeVersionSync({ enginePath: launch.enginePath });
    } catch (err) {
      log.warn('startupControl adapter version probe failed at launch', { engine: engineId, error: err.message });
    }
  }
  return resolveEngine(engineId, getProfile, adapters);
}

/**
 * Is a session's engine working right now, as its own protocol reports it?
 * The optional `observeActivity` half of the adapter contract, behind one
 * generic facade, for a caller that must not type into a busy engine and
 * cannot tell from the pane (the Medusa wake, #1628).
 *
 * The answer first says whether the session HAS a channel, because the two
 * cases are handled differently by design: with no channel the caller keeps
 * whatever it did before channels existed; with one, anything short of a
 * proven `idle` or `busy` is `unknown`, and a caller holds on it rather than
 * guessing from somewhere else.
 *
 * Before any adapter is asked, the channel must be this session's, of the
 * session's current launch and engine, and the session must be active and of
 * this project. The adapter then answers for its process, version and thread.
 *
 * Only ever an observation, never permission: nothing here checks trust,
 * account or quota, and `idle` does not authorize a fire.
 *
 * @param {object} target - What is being asked about.
 * @param {object} target.session - The live session record (`id`, `projectId`, `engineId`, `status`).
 * @param {object} target.project - The session's project (`id`, `path`).
 * @param {object|null} target.channel - The session's open channel row, or null.
 * @param {object|null} target.sequence - The session's launch sequence row, or null.
 * @param {Object<string, object>} [adapters=ADAPTERS] - Registry (a test seam).
 * @returns {Promise<{channel: 'absent'|'present', state: 'idle'|'busy'|'unknown', reasonCode: string}>}
 */
async function observeActivity(target, adapters = ADAPTERS) {
  const { session, project, channel, sequence } = target || {};
  if (!channel || channel.state !== 'open') return { channel: 'absent', state: 'unknown', reasonCode: 'no-channel' };
  const present = (state, reasonCode) => ({ channel: 'present', state, reasonCode });
  if (!session || channel.sessionId !== session.id) return present('unknown', 'channel-not-this-session');
  if (session.status !== 'active') return present('unknown', 'session-not-active');
  if (!sequence || sequence.sessionId !== session.id || channel.sequenceId !== sequence.id) return present('unknown', 'channel-other-launch');
  if (channel.engineId !== session.engineId) return present('unknown', 'channel-other-engine');
  if (!project || project.id !== session.projectId) return present('unknown', 'project-mismatch');

  const adapter = Object.prototype.hasOwnProperty.call(adapters, channel.adapter) ? adapters[channel.adapter] : null;
  if (!adapter || typeof adapter.observeActivity !== 'function') return present('unknown', 'adapter-cannot-observe');
  try {
    const seen = await adapter.observeActivity(channel, project);
    if (seen && ['idle', 'busy', 'unknown'].includes(seen.state)) {
      return present(seen.state, String(seen.reasonCode || seen.state));
    }
    return present('unknown', 'adapter-answer-malformed');
  } catch (err) {
    log.warn('startupControl activity observation failed', { adapter: channel.adapter, error: err.message });
    return present('unknown', 'adapter-failed');
  }
}

/**
 * Does this engine's profile name a registered adapter that can observe its
 * activity? True means a session of the engine is EXPECTED to be judged by
 * its channel, so a caller should hold, not fall back to the pane, when that
 * session has none (#1628, D2). Deliberately independent of the version
 * probe: an engine whose version is not yet verified is still one whose
 * sessions should have been observed, and the probe answers asynchronously
 * after a boot.
 * @param {string} engineId - Engine id.
 * @param {(id: string) => (object|null)} getProfile - Profile lookup.
 * @param {Object<string, object>} [adapters=ADAPTERS] - Registry (a test seam).
 * @returns {boolean} False for an unreadable profile, an undeclared block or an adapter that cannot observe.
 */
function declaresObserver(engineId, getProfile, adapters = ADAPTERS) {
  let profile;
  try {
    profile = getProfile(engineId);
  } catch {
    return false;
  }
  const declared = profile && profile.capabilities ? profile.capabilities.startupControl : undefined;
  if (!declared || typeof declared !== 'object' || !Object.prototype.hasOwnProperty.call(adapters, declared.adapter)) return false;
  return typeof adapters[declared.adapter].observeActivity === 'function';
}

module.exports = { ADAPTERS, FIELDS, blockErrors, resolve, resolveEngine, resolveForLaunch, observeActivity, declaresObserver };
