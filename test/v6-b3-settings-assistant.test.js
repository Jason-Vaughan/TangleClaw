'use strict';

/*
 * v6 (#2995, V6-25 / B3, Car V61-W1-B): the scoped settings catalog,
 * override inspector, and Settings Assistant preview/commit core
 * (`lib/v6/b3-settings-assistant.js`). Small tier: pure logic over an
 * in-memory store.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SCOPE_KINDS, PREVIEW_TTL_MS, MAX_PENDING_PREVIEWS, MAX_PATCH_KEYS, CATALOG, SettingsAssistantError,
  explainSetting, validatePatch, inspectOverrides, createMemorySettingsStore, createSettingsAssistant
} = require('../lib/v6/b3-settings-assistant');

/**
 * Assert `fn` throws a SettingsAssistantError with `code`.
 * @param {Function} fn
 * @param {string} code
 */
function throwsCode(fn, code) {
  assert.throws(fn, (err) => err instanceof SettingsAssistantError && err.code === code, code);
}

/**
 * An assistant where only `operator` is authorized, on `fleet:f` and `global:global`.
 * @param {object} [opts]
 */
function setup(opts = {}) {
  let time = 1000;
  let n = 0;
  const store = createMemorySettingsStore([
    { scope: 'fleet:f', revision: 4, value: { launchMode: 'manual', displayName: 'Lane Fleet' } },
    { scope: 'global:global', revision: 1, value: { telemetryVisible: true } }
  ]);
  const assistant = createSettingsAssistant(opts.store || store, {
    now: () => time,
    id: () => `p${++n}`,
    authenticate: (ctx) => (ctx && ctx.authenticated ? { id: ctx.id, verified: ctx.verified !== false } : null),
    authorize: opts.authorize || ((p, scope, op) => p.id === 'operator' && ['fleet:f', 'global:global'].includes(scope)
      && ['settings.preview', 'settings.commit'].includes(op))
  });
  return { assistant, store, tick: (ms) => { time += ms; } };
}

const OPERATOR = { id: 'operator', authenticated: true };

describe('constants and catalog', () => {
  it('orders scopes most specific first and bounds previews', () => {
    assert.deepEqual([...SCOPE_KINDS], ['resource', 'fleet', 'project', 'global']);
    assert.equal(PREVIEW_TTL_MS, 5 * 60 * 1000);
    assert.equal(MAX_PENDING_PREVIEWS, 256);
    assert.equal(MAX_PATCH_KEYS, 8);
  });

  it('every catalog key has scopes drawn from SCOPE_KINDS, a validator and a description', () => {
    for (const [key, entry] of Object.entries(CATALOG)) {
      assert.ok(entry.scopes.length > 0 && entry.scopes.every((s) => SCOPE_KINDS.includes(s)), key);
      assert.equal(typeof entry.validate, 'function', key);
      assert.ok(entry.description.length > 10, key);
      assert.equal(typeof entry.inherits, 'boolean', key);
    }
  });

  it('excludes consequential settings and auto launch', () => {
    for (const key of ['serviceToken', 'bindAllInterfaces', 'deleteProject', 'failoverGrant', 'stripAiCoauthors']) {
      assert.equal(Object.hasOwn(CATALOG, key), false, key);
    }
    assert.equal(CATALOG.launchMode.validate('auto'), false);
  });
});

describe('explainSetting', () => {
  it('quotes the catalog description and scopes', () => {
    const out = explainSetting('telemetryVisible');
    assert.match(out.description, /never stops collection/);
    assert.deepEqual(out.scopes, ['global', 'project', 'fleet', 'resource']);
    assert.equal(out.inherits, true);
  });

  it('refuses a setting outside the catalog, including prototype keys', () => {
    throwsCode(() => explainSetting('serviceToken'), 'UNKNOWN_SETTING');
    throwsCode(() => explainSetting('__proto__'), 'UNKNOWN_SETTING');
    throwsCode(() => explainSetting('toString'), 'UNKNOWN_SETTING');
  });
});

describe('validatePatch', () => {
  it('accepts a catalog key at an allowed scope with a valid value', () => {
    assert.deepEqual(validatePatch('fleet', { launchMode: 'offer', displayName: 'New' }), ['launchMode', 'displayName']);
  });

  it('refuses a key at a scope that may not set it, a bad value, an unknown key, and non-plain patches', () => {
    throwsCode(() => validatePatch('global', { launchMode: 'offer' }), 'BAD_PATCH');
    throwsCode(() => validatePatch('fleet', { launchMode: 'auto' }), 'BAD_PATCH');
    throwsCode(() => validatePatch('fleet', { secret: 1 }), 'BAD_PATCH');
    throwsCode(() => validatePatch('fleet', {}), 'BAD_PATCH');
    throwsCode(() => validatePatch('fleet', ['launchMode']), 'BAD_PATCH');
    throwsCode(() => validatePatch('fleet', null), 'BAD_PATCH');
    throwsCode(() => validatePatch('fleet', Object.create({ launchMode: 'offer' })), 'BAD_PATCH');
    throwsCode(() => validatePatch('host', { telemetryVisible: true }), 'BAD_PATCH');
  });

  it('refuses a patch past MAX_PATCH_KEYS keys (counted before any key is looked up)', () => {
    const patch = {};
    for (let i = 0; i <= MAX_PATCH_KEYS; i++) patch[`k${i}`] = true;
    throwsCode(() => validatePatch('global', patch), 'BAD_PATCH');
  });
});

describe('inspectOverrides', () => {
  it('reports the most specific stored value as effective and wider ones as shadowed', () => {
    const out = inspectOverrides('telemetryVisible', [
      { kind: 'resource', scopeId: 'r1' },
      { kind: 'fleet', scopeId: 'f', value: false },
      { kind: 'project', scopeId: 'p', value: true },
      { kind: 'global', value: true }
    ]);
    assert.equal(out.effective, false);
    assert.deepEqual(out.source, { kind: 'fleet', scopeId: 'f' });
    assert.deepEqual(out.layers.map((l) => l.state), ['unset', 'effective', 'shadowed', 'shadowed']);
    assert.equal(out.layers[3].scopeId, null);
  });

  it('falls through to global when nothing narrower is set, and to null when nothing is', () => {
    assert.deepEqual(inspectOverrides('defaultEngine', [{ kind: 'project', scopeId: 'p' }, { kind: 'global', value: 'claude' }]).source,
      { kind: 'global', scopeId: null });
    const none = inspectOverrides('defaultEngine', [{ kind: 'global' }]);
    assert.equal(none.effective, null);
    assert.equal(none.source, null);
  });

  it('ignores a value stored at a scope the key may not be set at', () => {
    const out = inspectOverrides('launchMode', [{ kind: 'resource', scopeId: 'r', value: 'offer' }, { kind: 'fleet', scopeId: 'f', value: 'manual' }]);
    assert.equal(out.effective, 'manual');
    assert.equal(out.layers[0].state, 'unset');
  });

  it('a non-inheriting key uses only the first scope', () => {
    const out = inspectOverrides('displayName', [{ kind: 'resource', scopeId: 'r' }, { kind: 'fleet', scopeId: 'f', value: 'Fleet' }]);
    assert.equal(out.effective, null);
    assert.deepEqual(out.layers.map((l) => l.state), ['unset', 'not-inherited']);
  });

  it('refuses an unknown key, an empty chain, and a chain out of specificity order', () => {
    throwsCode(() => inspectOverrides('ghost', [{ kind: 'global' }]), 'UNKNOWN_SETTING');
    throwsCode(() => inspectOverrides('telemetryVisible', []), 'BAD_CHAIN');
    throwsCode(() => inspectOverrides('telemetryVisible', [{ kind: 'global' }, { kind: 'fleet' }]), 'BAD_CHAIN');
    throwsCode(() => inspectOverrides('telemetryVisible', [{ kind: 'fleet' }, { kind: 'fleet' }]), 'BAD_CHAIN');
    throwsCode(() => inspectOverrides('telemetryVisible', [{ kind: 'host' }]), 'BAD_CHAIN');
    throwsCode(() => inspectOverrides('telemetryVisible', [null]), 'BAD_CHAIN');
  });
});

describe('createSettingsAssistant — preview and commit', () => {
  it('needs a store and both identity hooks', () => {
    assert.throws(() => createSettingsAssistant(null, { authenticate: () => null, authorize: () => true }), TypeError);
    assert.throws(() => createSettingsAssistant(createMemorySettingsStore([]), { authorize: () => true }), TypeError);
  });

  it('a preview is a typed, revision-pinned diff and commits once, reading back the stored value', () => {
    const { assistant, store } = setup();
    const p = assistant.preview({ kind: 'fleet', scopeId: 'f', patch: { launchMode: 'offer' }, context: OPERATOR });
    assert.deepEqual(p.diff, [{ op: 'replace', path: '/launchMode', before: 'manual', after: 'offer' }]);
    assert.equal(p.expectedRevision, 4);
    assert.equal(p.source, 'assistant-suggestion');
    assert.equal(store.read('fleet:f').value.launchMode, 'manual', 'a preview writes nothing');
    const result = assistant.commit({ previewId: p.previewId, context: OPERATOR });
    assert.equal(result.newRevision, 5);
    assert.deepEqual(result.effective, { launchMode: 'offer', displayName: 'Lane Fleet' });
    assert.equal(store.read('fleet:f').value.launchMode, 'offer');
    throwsCode(() => assistant.commit({ previewId: p.previewId, context: OPERATOR }), 'PREVIEW_ALREADY_USED');
  });

  it('a new key previews as add, and the global scope needs no id', () => {
    const { assistant } = setup();
    const p = assistant.preview({ kind: 'global', patch: { defaultEngine: 'codex' }, context: OPERATOR });
    assert.equal(p.scopeId, null);
    assert.deepEqual(p.diff, [{ op: 'add', path: '/defaultEngine', before: null, after: 'codex' }]);
  });

  it('refuses an unverified principal, a bad or denied scope, a missing setting, and a no-op', () => {
    const { assistant } = setup();
    throwsCode(() => assistant.preview({ kind: 'fleet', scopeId: 'f', patch: { launchMode: 'offer' }, context: null }), 'PRINCIPAL_UNVERIFIED');
    throwsCode(() => assistant.preview({ kind: 'fleet', scopeId: 'f', patch: { launchMode: 'offer' }, context: { id: 'operator', authenticated: true, verified: false } }), 'PRINCIPAL_UNVERIFIED');
    throwsCode(() => assistant.preview({ kind: 'fleet', scopeId: '../x', patch: { launchMode: 'offer' }, context: OPERATOR }), 'BAD_SCOPE');
    throwsCode(() => assistant.preview({ kind: 'host', scopeId: 'x', patch: { launchMode: 'offer' }, context: OPERATOR }), 'BAD_SCOPE');
    throwsCode(() => assistant.preview({ kind: 'fleet', scopeId: 'f', patch: { launchMode: 'offer' }, context: { id: 'agent', authenticated: true } }), 'SCOPE_DENIED');
    const { assistant: open } = setup({ authorize: () => true });
    throwsCode(() => open.preview({ kind: 'fleet', scopeId: 'other', patch: { launchMode: 'offer' }, context: OPERATOR }), 'SETTING_NOT_FOUND');
    throwsCode(() => assistant.preview({ kind: 'fleet', scopeId: 'f', patch: { launchMode: 'manual' }, context: OPERATOR }), 'NO_CHANGE');
  });

  it('commit refuses a changed principal, an unknown preview, an expired one, and a revoked scope', () => {
    let allow = true;
    const { assistant, tick } = setup({ authorize: (p, scope) => p.id === 'operator' && scope === 'fleet:f' && allow });
    const p1 = assistant.preview({ kind: 'fleet', scopeId: 'f', patch: { launchMode: 'offer' }, context: OPERATOR });
    throwsCode(() => assistant.commit({ previewId: p1.previewId, context: { id: 'agent', authenticated: true } }), 'PRINCIPAL_CHANGED');
    throwsCode(() => assistant.commit({ previewId: 'ghost', context: OPERATOR }), 'PREVIEW_NOT_FOUND');
    allow = false;
    throwsCode(() => assistant.commit({ previewId: p1.previewId, context: OPERATOR }), 'SCOPE_DENIED');
    allow = true;
    tick(PREVIEW_TTL_MS);
    throwsCode(() => assistant.commit({ previewId: p1.previewId, context: OPERATOR }), 'PREVIEW_EXPIRED');
  });

  it('a revision that moved after the preview refuses, and the preview stays spent', () => {
    const { assistant, store } = setup();
    const p = assistant.preview({ kind: 'fleet', scopeId: 'f', patch: { launchMode: 'offer' }, context: OPERATOR });
    store.cas('fleet:f', 4, { launchMode: 'manual', displayName: 'Renamed' });
    throwsCode(() => assistant.commit({ previewId: p.previewId, context: OPERATOR }), 'STALE_REVISION');
    throwsCode(() => assistant.commit({ previewId: p.previewId, context: OPERATOR }), 'PREVIEW_ALREADY_USED');
    assert.equal(store.read('fleet:f').value.displayName, 'Renamed', 'the other writer\'s value survives');
  });

  it('a CAS that loses the race after the revision check refuses and spends the preview', () => {
    const inner = createMemorySettingsStore([{ scope: 'fleet:f', revision: 4, value: { launchMode: 'manual' } }]);
    const racing = { read: (s) => inner.read(s), cas: () => null };
    const { assistant } = setup({ store: racing });
    const p = assistant.preview({ kind: 'fleet', scopeId: 'f', patch: { launchMode: 'offer' }, context: OPERATOR });
    throwsCode(() => assistant.commit({ previewId: p.previewId, context: OPERATOR }), 'STALE_REVISION');
    throwsCode(() => assistant.commit({ previewId: p.previewId, context: OPERATOR }), 'PREVIEW_ALREADY_USED');
  });

  it('bounds pending previews and prunes expired ones', () => {
    const { assistant, tick } = setup();
    for (let i = 0; i < MAX_PENDING_PREVIEWS; i++) {
      assistant.preview({ kind: 'fleet', scopeId: 'f', patch: { launchMode: 'offer' }, context: OPERATOR });
    }
    assert.equal(assistant.pendingCount(), MAX_PENDING_PREVIEWS);
    throwsCode(() => assistant.preview({ kind: 'fleet', scopeId: 'f', patch: { launchMode: 'offer' }, context: OPERATOR }), 'PREVIEW_LIMIT');
    tick(PREVIEW_TTL_MS);
    assert.equal(assistant.pendingCount(), 0);
    assert.ok(assistant.preview({ kind: 'fleet', scopeId: 'f', patch: { launchMode: 'offer' }, context: OPERATOR }).previewId);
  });
});
