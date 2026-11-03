'use strict';

/*
 * Session-level bridge awareness, and the layered notification policy the
 * bridge's typed notifications (`lib/bridge-notify.js`) are gated by (#2119,
 * Ruling A2119).
 *
 * Two separate questions, one module:
 *
 * 1. `resolveSessionBridgeAwareness(projectId)` -- can ANY session ask "does
 *    the operator bridge even exist, is it on, and is my own project
 *    something it would reach?" without needing to read three other
 *    modules' own state itself. Read-only; nothing here decides policy.
 * 2. `resolveNotificationPolicy(projectId, eventKind)` / the two setters --
 *    a fleet-wide global default per event kind, layered with a per-project
 *    override that wins when it exists. Storage is additive: it reuses
 *    `bridgeStore.settings`'s existing generic key/value table (the same
 *    one `ENABLED_AT` already lives in) under two key families
 *    (`notification-policy.global`, `notification-policy.project.<id>`),
 *    rather than a new schema -- nothing in `lib/bridge-store.js` needed to
 *    change for this.
 *
 * `lib/bridge-notify.js` is the one caller of `resolveNotificationPolicy`:
 * every per-project `_emit` call there now checks it before enqueueing,
 * exactly as `bridgeStore.optouts`/`_hasLiveCoordinator` already gate the
 * same call sites. A fleet-wide event (`fleet-idle`, `gateway-down`,
 * `gateway-recovered`) has no project to override, so it is checked only
 * against the global layer, with `projectId: null`.
 */

const store = require('./store');
const bridgeStore = require('./bridge-store');
const reach = require('./bridge-reach');

/** Enabled by default: existing behavior (every notification always fires) is unchanged until the operator says otherwise. */
const DEFAULT_ENABLED = true;

/** The bridge_settings key holding the fleet-wide global policy map. */
const GLOBAL_KEY = 'notification-policy.global';

/**
 * The bridge_settings key holding one project's override map.
 * @param {number} projectId
 * @returns {string}
 */
function _projectKey(projectId) {
  return `notification-policy.project.${projectId}`;
}

/**
 * Read a policy map stored under one `bridge_settings` key. Anything
 * unreadable or not a plain object reads as empty, never thrown -- a
 * corrupted setting fails closed to "no overrides", not to a crash.
 * @param {string} key
 * @returns {Object<string, boolean>}
 */
function _readPolicyMap(key) {
  const raw = bridgeStore.settings.get(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Whether any session can see the operator bridge actively connected to
 * Discord: an active helper token is the operator having set credentials up
 * at all, distinct from `bridgeStore.settings.isEnabled()` (the operator's
 * own on/off switch) and from a live gateway connection, which fluctuates.
 * @returns {boolean}
 */
function _bridgeConfigured() {
  return Boolean(bridgeStore.helperTokens.active());
}

/**
 * What a session may want to know about the operator bridge before it tries
 * to use it: whether it exists, is on, and whether this session's own
 * project is somewhere it would reach (#2119, Ruling A2119).
 * @param {number} projectId
 * @returns {{bridgeConfigured: boolean, bridgeEnabled: boolean, projectInReach: boolean,
 *   excludedReason: (string|null), candidateVerbAvailable: boolean}} `excludedReason` is
 *   `lib/bridge-reach.js#outOfReach`'s own code (`'unknown'|'archived'|'scope-unresolved'|
 *   'out-of-scope'|'opted-out'`), or null when in reach. `candidateVerbAvailable` is true
 *   only when a `tc candidate submit` from this project could ever actually be posted --
 *   configured, enabled, and in reach, all three.
 */
function resolveSessionBridgeAwareness(projectId) {
  const bridgeConfigured = _bridgeConfigured();
  const bridgeEnabled = bridgeStore.settings.isEnabled();
  const project = Number.isInteger(projectId) ? store.projects.get(projectId) : null;
  const excludedReason = reach.outOfReach(project);
  const projectInReach = excludedReason === null;
  return {
    bridgeConfigured,
    bridgeEnabled,
    projectInReach,
    excludedReason,
    candidateVerbAvailable: bridgeConfigured && bridgeEnabled && projectInReach
  };
}

/**
 * Set (or clear) the fleet-wide default for one event kind. There is no
 * closed enum of event kinds: any non-empty string a notifier names is
 * valid, so a new notification type never needs this module edited first.
 * @param {string} eventKind
 * @param {boolean} enabled
 * @returns {void}
 * @throws {TypeError} On a malformed `eventKind` or `enabled`.
 */
function setGlobalNotificationPolicy(eventKind, enabled) {
  if (typeof eventKind !== 'string' || !eventKind) throw new TypeError('eventKind must be a non-empty string');
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  const map = _readPolicyMap(GLOBAL_KEY);
  map[eventKind] = enabled;
  bridgeStore.settings.set(GLOBAL_KEY, JSON.stringify(map));
}

/**
 * Set, or clear, one project's override of the global default for one event
 * kind. `enabled: null` clears the override, falling back to the global
 * (then built-in) default again -- never the same as setting it `false`.
 * @param {number} projectId
 * @param {string} eventKind
 * @param {boolean|null} enabled
 * @returns {void}
 * @throws {TypeError} On a malformed `projectId`, `eventKind` or `enabled`.
 */
function setProjectNotificationOverride(projectId, eventKind, enabled) {
  if (!Number.isInteger(projectId) || projectId <= 0) throw new TypeError('projectId must be a positive integer');
  if (typeof eventKind !== 'string' || !eventKind) throw new TypeError('eventKind must be a non-empty string');
  if (enabled !== null && typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean, or null to clear the override');
  const key = _projectKey(projectId);
  const map = _readPolicyMap(key);
  if (enabled === null) delete map[eventKind];
  else map[eventKind] = enabled;
  bridgeStore.settings.set(key, Object.keys(map).length > 0 ? JSON.stringify(map) : null);
}

/**
 * Whether one event kind should notify for one project right now: the
 * project's own override when it has one, else the fleet-wide global
 * default when THAT has one, else {@link DEFAULT_ENABLED}. A `null`
 * `projectId` (a fleet-wide event with no one project to override) is
 * resolved against the global layer alone.
 * @param {number|null} projectId
 * @param {string} eventKind
 * @returns {{enabled: boolean, source: ('project'|'global'|'default')}}
 */
function resolveNotificationPolicy(projectId, eventKind) {
  const globalMap = _readPolicyMap(GLOBAL_KEY);
  const projectMap = Number.isInteger(projectId) ? _readPolicyMap(_projectKey(projectId)) : {};
  if (Object.prototype.hasOwnProperty.call(projectMap, eventKind)) {
    return { enabled: projectMap[eventKind], source: 'project' };
  }
  if (Object.prototype.hasOwnProperty.call(globalMap, eventKind)) {
    return { enabled: globalMap[eventKind], source: 'global' };
  }
  return { enabled: DEFAULT_ENABLED, source: 'default' };
}

module.exports = {
  DEFAULT_ENABLED,
  resolveSessionBridgeAwareness,
  setGlobalNotificationPolicy,
  setProjectNotificationOverride,
  resolveNotificationPolicy
};
