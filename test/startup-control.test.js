'use strict';

/*
 * startupControl capability resolution (#1825). A profile can declare a native
 * startup channel, but only a REGISTERED adapter makes it supported: editing a
 * profile can describe a channel and can never grant one.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sc = require('../lib/startup-control');

/**
 * A well-formed startupControl block with evidence for every field.
 * @param {object} [over] - Field overrides.
 * @returns {object}
 */
function block(over = {}) {
  const b = {
    adapter: 'fake',
    channel: 'a native channel',
    readiness: 'its ready state',
    receipt: 'accepted and applied events',
    blockers: 'auth and approval events',
    verifiedVersions: ['1.0.0'],
    ...over
  };
  const evidence = {};
  for (const k of Object.keys(b)) evidence[k] = { verifiedOn: '2026-09-23', source: 'a live probe' };
  return { ...b, evidence };
}

/**
 * A profile carrying the given startupControl value.
 * @param {*} value - The block, or undefined for none.
 * @returns {object}
 */
function profile(value) {
  const capabilities = value === undefined ? {} : { startupControl: value };
  return { id: 'eng', capabilities };
}

describe('startupControl blockErrors', () => {
  it('accepts a complete block with evidence for every field', () => {
    assert.deepEqual(sc.blockErrors(block()), []);
  });

  it('refuses a non-object', () => {
    assert.ok(sc.blockErrors(null).length > 0);
    assert.ok(sc.blockErrors([]).length > 0);
    assert.ok(sc.blockErrors('codex').length > 0);
  });

  it('requires every field', () => {
    for (const field of Object.keys(sc.FIELDS)) {
      const b = block();
      delete b[field];
      delete b.evidence[field];
      assert.ok(sc.blockErrors(b).some((e) => e.includes(`startupControl.${field} is required`)), field);
    }
  });

  it('refuses an unknown field', () => {
    const b = block();
    b.socketPath = '/tmp/x';
    b.evidence.socketPath = { verifiedOn: null, source: 'x' };
    assert.ok(sc.blockErrors(b).some((e) => e.includes('socketPath is not a field')));
  });

  it('refuses an empty verifiedVersions list', () => {
    assert.ok(sc.blockErrors(block({ verifiedVersions: [] })).some((e) => e.includes('verifiedVersions')));
  });

  it('requires evidence for every declared field, and for nothing else', () => {
    const missing = block();
    delete missing.evidence.channel;
    assert.ok(sc.blockErrors(missing).some((e) => e.includes('evidence.channel is missing')));

    const extra = block();
    extra.evidence.ghost = { verifiedOn: null, source: 'x' };
    assert.ok(sc.blockErrors(extra).some((e) => e.includes('evidence.ghost has no field')));

    const noEvidence = block();
    delete noEvidence.evidence;
    assert.ok(sc.blockErrors(noEvidence).some((e) => e.includes('evidence is required')));
  });

  it('checks evidence dates and sources', () => {
    const b = block();
    b.evidence.adapter = { verifiedOn: 'yesterday', source: '' };
    const errors = sc.blockErrors(b);
    assert.ok(errors.some((e) => e.includes('verifiedOn must be an ISO date')));
    assert.ok(errors.some((e) => e.includes('source must name')));
  });
});

describe('startupControl resolve', () => {
  // The block() fixture verifies version 1.0.0.
  const registry = { fake: { name: 'fake', installedVersion: () => '1.0.0' } };

  it('is unsupported when the profile declares nothing', () => {
    const r = sc.resolve(profile(undefined), registry);
    assert.equal(r.supported, false);
    assert.match(r.reason, /declares no startupControl/);
    assert.equal(r.reasonCode, 'engine_declares_none');
  });

  it('is unsupported when the block is malformed, even if its adapter exists', () => {
    const r = sc.resolve(profile({ adapter: 'fake' }), registry);
    assert.equal(r.supported, false);
    assert.match(r.reason, /malformed/);
    assert.equal(r.reasonCode, 'profile_block_malformed');
  });

  it('is unsupported when the named adapter is not registered: a profile cannot grant one', () => {
    const r = sc.resolve(profile(block({ adapter: 'nope' })), registry);
    assert.equal(r.supported, false);
    assert.match(r.reason, /"nope".*does not implement/);
    assert.equal(r.adapter, null);
    assert.equal(r.reasonCode, 'adapter_not_registered');
  });

  it('is supported only when a well-formed block names a registered adapter on a verified version', () => {
    const r = sc.resolve(profile(block()), registry);
    assert.equal(r.supported, true);
    assert.equal(r.adapter, registry.fake);
    assert.equal(r.reasonCode, null);
  });

  it('is unsupported on an installed version the block did not verify', () => {
    const r = sc.resolve(profile(block()), { fake: { installedVersion: () => '1.0.1' } });
    assert.equal(r.supported, false);
    assert.equal(r.reasonCode, 'version_unverified');
    assert.match(r.reason, /version 1\.0\.1/);
    assert.equal(r.adapter, null);
  });

  it('is unsupported when the adapter cannot say its version, or throws', () => {
    for (const adapter of [{}, { installedVersion: () => null }, { installedVersion: () => { throw new Error('probe'); } }]) {
      const r = sc.resolve(profile(block()), { fake: adapter });
      assert.equal(r.supported, false);
      assert.equal(r.reasonCode, 'version_unverified');
    }
  });

  it('resolveEngine degrades an unreadable profile to unsupported instead of throwing', () => {
    const r = sc.resolveEngine('codex', () => { throw new Error('bad json'); }, registry);
    assert.equal(r.supported, false);
    assert.equal(r.reasonCode, 'engine_profile_unreadable');
    assert.match(r.reason, /codex/);
  });

  it('resolveEngine names the engine id when no profile exists', () => {
    const r = sc.resolveEngine('openclaw:abc', () => null, registry);
    assert.equal(r.reasonCode, 'engine_declares_none');
    assert.match(r.reason, /openclaw:abc/);
  });

  it('does not resolve an inherited property as an adapter', () => {
    const r = sc.resolve(profile(block({ adapter: 'toString' })), {});
    assert.equal(r.supported, false);
  });

  it('registers exactly the codex adapter; every other bundled engine declares nothing and is unsupported', () => {
    assert.deepEqual(Object.keys(sc.ADAPTERS), ['codex']);
    const dir = path.join(__dirname, '..', 'data', 'engines');
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (p.id === 'codex') continue;
      const r = sc.resolve(p);
      assert.equal(r.supported, false, f);
      assert.equal(r.reasonCode, 'engine_declares_none', f);
    }
  });

  it('the codex profile is supported only on the exact version the adapter reports', () => {
    const codex = require('../lib/startup-control-codex');
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
    assert.deepEqual(sc.blockErrors(p.capabilities.startupControl), []);
    assert.deepEqual(p.capabilities.startupControl.verifiedVersions, ['0.156.1']);
    const saved = codex._internal._version.version;
    try {
      codex._internal._version.version = null;
      assert.equal(sc.resolve(p).reasonCode, 'version_unverified', 'no probe yet: unsupported, never assumed');
      codex._internal._version.version = '0.157.0';
      assert.equal(sc.resolve(p).reasonCode, 'version_unverified', 'an unlisted version is unsupported');
      codex._internal._version.version = '0.156.1';
      const r = sc.resolve(p);
      assert.equal(r.supported, true);
      assert.equal(r.adapter, codex);
    } finally {
      codex._internal._version.version = saved;
    }
  });
});

describe('observeActivity: the generic facade over the optional adapter method (#1628)', () => {
  const session = { id: 1, projectId: 10, engineId: 'codex', status: 'active' };
  const project = { id: 10, path: '/p' };
  const channel = { id: 7, sessionId: 1, sequenceId: 70, engineId: 'codex', adapter: 'fake', state: 'open', adapterState: {} };
  const sequence = { id: 70, sessionId: 1 };
  const target = (over = {}) => ({ session, project, channel, sequence, ...over });
  const answering = (answer) => {
    const seen = [];
    return { seen, adapters: { fake: { observeActivity: async (c, p) => { seen.push([c, p]); return answer; } } } };
  };

  it('passes a registered adapter\'s answer through, marked present', async () => {
    const { seen, adapters } = answering({ state: 'busy', reasonCode: 'thread-active' });
    assert.deepEqual(await sc.observeActivity(target(), adapters), { channel: 'present', state: 'busy', reasonCode: 'thread-active' });
    assert.deepEqual(seen, [[channel, project]]);
  });

  it('no channel, or one that is not open, is ABSENT — the one case a caller may treat as "no channel"', async () => {
    const { adapters } = answering({ state: 'idle', reasonCode: 'x' });
    for (const ch of [null, { ...channel, state: 'closed' }]) {
      assert.deepEqual(await sc.observeActivity(target({ channel: ch }), adapters), { channel: 'absent', state: 'unknown', reasonCode: 'no-channel' });
    }
  });

  it('a channel not bound to this active session, its launch, its engine and its project is present-but-unknown, and the adapter is never asked', async () => {
    const cases = [
      [{ channel: { ...channel, sessionId: 2 } }, 'channel-not-this-session'],
      [{ session: { ...session, status: 'wrapped' } }, 'session-not-active'],
      [{ sequence: null }, 'channel-other-launch'],
      [{ sequence: { ...sequence, id: 71 } }, 'channel-other-launch'],
      [{ sequence: { ...sequence, sessionId: 2 } }, 'channel-other-launch'],
      [{ channel: { ...channel, engineId: 'claude' } }, 'channel-other-engine'],
      [{ project: { ...project, id: 11 } }, 'project-mismatch']
    ];
    for (const [over, code] of cases) {
      const { seen, adapters } = answering({ state: 'idle', reasonCode: 'thread-idle' });
      assert.deepEqual(await sc.observeActivity(target(over), adapters), { channel: 'present', state: 'unknown', reasonCode: code }, code);
      assert.equal(seen.length, 0, `${code}: the adapter is not asked`);
    }
  });

  it('an adapter that is not registered, or does not implement it, is present-but-unknown — never idle, never absent', async () => {
    assert.deepEqual(await sc.observeActivity(target(), {}), { channel: 'present', state: 'unknown', reasonCode: 'adapter-cannot-observe' });
    assert.equal((await sc.observeActivity(target(), { fake: {} })).reasonCode, 'adapter-cannot-observe');
    assert.equal((await sc.observeActivity(target({ channel: { ...channel, adapter: 'toString' } }), {})).state, 'unknown', 'no prototype key reads as registered');
  });

  it('an adapter that throws or answers out of vocabulary is present-but-unknown', async () => {
    const throws = { fake: { observeActivity: async () => { throw new Error('boom'); } } };
    assert.deepEqual(await sc.observeActivity(target(), throws), { channel: 'present', state: 'unknown', reasonCode: 'adapter-failed' });
    const { adapters } = answering({ state: 'probably-idle' });
    assert.deepEqual(await sc.observeActivity(target(), adapters), { channel: 'present', state: 'unknown', reasonCode: 'adapter-answer-malformed' });
  });

  it('the Codex adapter implements it', () => {
    assert.equal(typeof sc.ADAPTERS.codex.observeActivity, 'function');
  });
});

describe('declaresObserver: which engines are meant to be judged by their channel (#1628, D2)', () => {
  const profile = (sc0) => () => ({ capabilities: { startupControl: sc0 } });
  const observing = { fake: { observeActivity: async () => ({ state: 'idle' }) } };

  it('true only when the profile names a registered adapter that implements observeActivity', () => {
    assert.equal(sc.declaresObserver('x', profile({ adapter: 'fake' }), observing), true);
    assert.equal(sc.declaresObserver('x', profile({ adapter: 'fake' }), { fake: {} }), false, 'an adapter that cannot observe');
    assert.equal(sc.declaresObserver('x', profile({ adapter: 'other' }), observing), false, 'an unregistered adapter');
    assert.equal(sc.declaresObserver('x', profile(undefined), observing), false, 'no block declared');
    assert.equal(sc.declaresObserver('x', () => null, observing), false, 'no profile');
  });

  it('an unreadable profile is false, never a throw', () => {
    assert.equal(sc.declaresObserver('x', () => { throw new Error('bad json'); }, observing), false);
  });

  it('does not depend on the version probe having answered', () => {
    assert.equal(sc.declaresObserver('x', profile({ adapter: 'fake', verifiedVersions: ['9.9.9'] }), observing), true);
  });
});
