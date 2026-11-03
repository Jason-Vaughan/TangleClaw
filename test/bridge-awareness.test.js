'use strict';

// #2119 (Ruling A2119): session-level bridge awareness, and the layered
// notification policy (fleet-wide global default + per-project override)
// `lib/bridge-notify.js` is gated by.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const awareness = require('../lib/bridge-awareness');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-awareness-'));
  store._setBasePath(tmpDir);
  store.init();
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A project in the registry.
 * @param {string} name
 * @returns {object}
 */
function project(name) {
  return store.projects.create({ name, path: path.join(tmpDir, name.replace(/\W+/g, '_')) });
}

describe('resolveSessionBridgeAwareness', () => {
  it('reports not configured, not enabled, by default', () => {
    const p = project('Alpha');
    const r = awareness.resolveSessionBridgeAwareness(p.id);
    assert.equal(r.bridgeConfigured, false);
    assert.equal(r.bridgeEnabled, false);
    assert.equal(r.candidateVerbAvailable, false);
  });

  it('reports configured once an active helper token exists', () => {
    const p = project('Alpha');
    bridgeStore.helperTokens.replace('t-1', 'a'.repeat(64));
    const r = awareness.resolveSessionBridgeAwareness(p.id);
    assert.equal(r.bridgeConfigured, true);
  });

  it('reports enabled once the operator switch is on', () => {
    const p = project('Alpha');
    bridgeStore.settings.set('enabled', 'true');
    const r = awareness.resolveSessionBridgeAwareness(p.id);
    assert.equal(r.bridgeEnabled, true);
  });

  it('reports a project in reach by default (scope "all")', () => {
    const p = project('Alpha');
    const r = awareness.resolveSessionBridgeAwareness(p.id);
    assert.equal(r.projectInReach, true);
    assert.equal(r.excludedReason, null);
  });

  it('names the real exclusion reason for an opted-out project', () => {
    const p = project('Alpha');
    bridgeStore.optouts.set(p.id);
    const r = awareness.resolveSessionBridgeAwareness(p.id);
    assert.equal(r.projectInReach, false);
    assert.equal(r.excludedReason, 'opted-out');
  });

  it('names the real exclusion reason for an archived project', () => {
    const p = project('Alpha');
    store.projects.archive(p.id);
    const r = awareness.resolveSessionBridgeAwareness(p.id);
    assert.equal(r.excludedReason, 'archived');
  });

  it('reports "unknown" for a project id that does not exist', () => {
    const r = awareness.resolveSessionBridgeAwareness(999999);
    assert.equal(r.excludedReason, 'unknown');
    assert.equal(r.projectInReach, false);
  });

  it('candidateVerbAvailable is true only when configured, enabled, AND in reach -- all three', () => {
    const p = project('Alpha');
    bridgeStore.helperTokens.replace('t-1', 'a'.repeat(64));
    bridgeStore.settings.set('enabled', 'true');
    assert.equal(awareness.resolveSessionBridgeAwareness(p.id).candidateVerbAvailable, true);

    bridgeStore.optouts.set(p.id);
    assert.equal(awareness.resolveSessionBridgeAwareness(p.id).candidateVerbAvailable, false, 'opted out breaks it');
  });
});

describe('notification policy: layered global + per-project (resolveNotificationPolicy)', () => {
  it('defaults to enabled with no global or project setting', () => {
    const r = awareness.resolveNotificationPolicy(1, 'work-blocked');
    assert.deepEqual(r, { enabled: true, source: 'default' });
  });

  it('a global setting overrides the built-in default for every project', () => {
    awareness.setGlobalNotificationPolicy('work-blocked', false);
    assert.deepEqual(awareness.resolveNotificationPolicy(1, 'work-blocked'), { enabled: false, source: 'global' });
    assert.deepEqual(awareness.resolveNotificationPolicy(2, 'work-blocked'), { enabled: false, source: 'global' });
  });

  it('a project override wins over the global setting', () => {
    const p = project('Alpha');
    awareness.setGlobalNotificationPolicy('work-blocked', false);
    awareness.setProjectNotificationOverride(p.id, 'work-blocked', true);
    assert.deepEqual(awareness.resolveNotificationPolicy(p.id, 'work-blocked'), { enabled: true, source: 'project' });
    // A different project still sees the global default.
    assert.deepEqual(awareness.resolveNotificationPolicy(p.id + 1, 'work-blocked'), { enabled: false, source: 'global' });
  });

  it('clearing a project override (enabled: null) falls back to the global layer', () => {
    const p = project('Alpha');
    awareness.setGlobalNotificationPolicy('work-blocked', false);
    awareness.setProjectNotificationOverride(p.id, 'work-blocked', true);
    awareness.setProjectNotificationOverride(p.id, 'work-blocked', null);
    assert.deepEqual(awareness.resolveNotificationPolicy(p.id, 'work-blocked'), { enabled: false, source: 'global' });
  });

  it('a null projectId (fleet-wide event) resolves against the global layer alone', () => {
    awareness.setGlobalNotificationPolicy('fleet-idle', false);
    assert.deepEqual(awareness.resolveNotificationPolicy(null, 'fleet-idle'), { enabled: false, source: 'global' });
  });

  it('there is no closed set of event kinds -- an arbitrary new one still resolves to the default', () => {
    assert.deepEqual(awareness.resolveNotificationPolicy(1, 'some-brand-new-event-kind'), { enabled: true, source: 'default' });
  });

  it('two event kinds are tracked independently within one project and within the global layer', () => {
    awareness.setGlobalNotificationPolicy('work-blocked', false);
    awareness.setGlobalNotificationPolicy('pr-opened', true);
    assert.deepEqual(awareness.resolveNotificationPolicy(1, 'work-blocked'), { enabled: false, source: 'global' });
    assert.deepEqual(awareness.resolveNotificationPolicy(1, 'pr-opened'), { enabled: true, source: 'global' });
  });

  it('throws on malformed inputs to the setters', () => {
    assert.throws(() => awareness.setGlobalNotificationPolicy('', true), TypeError);
    assert.throws(() => awareness.setGlobalNotificationPolicy('x', 'yes'), TypeError);
    assert.throws(() => awareness.setProjectNotificationOverride(0, 'x', true), TypeError);
    assert.throws(() => awareness.setProjectNotificationOverride(1, '', true), TypeError);
    assert.throws(() => awareness.setProjectNotificationOverride(1, 'x', 'yes'), TypeError);
  });

  it('a corrupted stored policy map fails closed to no overrides, not a crash', () => {
    bridgeStore.settings.set('notification-policy.global', '{not json');
    assert.deepEqual(awareness.resolveNotificationPolicy(1, 'work-blocked'), { enabled: true, source: 'default' });
  });
});
