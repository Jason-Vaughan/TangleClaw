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

  it('requires every field it marks required', () => {
    const required = Object.keys(sc.FIELDS).filter((field) => sc.FIELDS[field].required);
    assert.deepEqual(required.sort(), ['adapter', 'blockers', 'channel', 'readiness', 'receipt', 'verifiedVersions']);
    for (const field of required) {
      const b = block();
      delete b[field];
      delete b.evidence[field];
      assert.ok(sc.blockErrors(b).some((e) => e.includes(`startupControl.${field} is required`)), field);
    }
  });

  describe('remoteTrustPrompt, the versions measured to draw no trust dialog (#2186)', () => {
    /**
     * A valid block that also declares the fact.
     * @param {*} value - The `remoteTrustPrompt` value.
     * @returns {object}
     */
    const withFact = (value) => {
      const b = block();
      b.remoteTrustPrompt = value;
      b.evidence.remoteTrustPrompt = { verifiedOn: '2026-10-07', source: 'a probe' };
      return b;
    };

    it('is optional: a block without it is well-formed', () => {
      assert.deepEqual(sc.blockErrors(block()), []);
    });

    it('accepts an empty list: measured for no version yet', () => {
      assert.deepEqual(sc.blockErrors(withFact({ absentOn: [] })), []);
    });

    it('accepts an exact version that is also a verified one', () => {
      const b = withFact({ absentOn: [block().verifiedVersions[0]] });
      assert.deepEqual(sc.blockErrors(b), []);
    });

    it('refuses a version the channel is not verified on', () => {
      const errors = sc.blockErrors(withFact({ absentOn: ['9.9.9'] }));
      assert.ok(errors.some((e) => e.includes('remoteTrustPrompt.absentOn names 9.9.9, which is not in verifiedVersions')), errors.join('; '));
    });

    it('refuses anything that is not a list of unique exact versions', () => {
      const v = block().verifiedVersions[0];
      for (const bad of [null, [], 'all', { absentOn: 'all' }, { absentOn: ['0.156'] }, { absentOn: ['^0.156.1'] }, { absentOn: [v, v] }, { absentOn: [], extra: true }, {}]) {
        const errors = sc.blockErrors(withFact(bad));
        assert.ok(errors.some((e) => e.includes('startupControl.remoteTrustPrompt must be')), JSON.stringify(bad));
      }
    });

    it('needs its own evidence, like every declared field', () => {
      const b = withFact({ absentOn: [] });
      delete b.evidence.remoteTrustPrompt;
      assert.ok(sc.blockErrors(b).some((e) => e.includes('evidence.remoteTrustPrompt is missing')));
    });
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

  it('the codex profile lists exactly the versions measured to draw no trust dialog (#2186)', () => {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
    const block = p.capabilities.startupControl;
    assert.deepEqual(block.remoteTrustPrompt.absentOn, ['0.156.1']);
    for (const version of block.remoteTrustPrompt.absentOn) {
      assert.ok(block.verifiedVersions.includes(version), `${version} is listed for the allowance and not verified`);
    }
    assert.deepEqual(sc.blockErrors(block), []);
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

  it('an adapter that answers held is passed through as held, with its reason code (#2186)', async () => {
    const { adapters } = answering({ state: 'held', reasonCode: 'folder-untrusted' });
    assert.deepEqual(await sc.observeActivity(target(), adapters), { channel: 'present', state: 'held', reasonCode: 'folder-untrusted' });
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

describe('awaitLaunchReady: the generic facade over the optional launch-readiness read (#2059)', () => {
  const getProfile = (value) => () => profile(value);
  const session = { id: 5, projectId: 1, engineId: 'eng', tmuxSession: 'tc-eng' };
  const project = { id: 1, path: '/p' };
  /**
   * Ask the facade about an engine whose adapter is `adapter`.
   * @param {object} adapter - The registered adapter.
   * @param {object} [over] - Target overrides.
   * @returns {Promise<object>}
   */
  const ask = (adapter, over = {}) => sc.awaitLaunchReady({ engineId: 'eng', getProfile: getProfile(block()), session, project, sequenceId: 9, ...over }, { fake: adapter });

  it('UNSUPPORTED is only an adapter that does not have the method: none declared, none registered, or one without it', async () => {
    assert.deepEqual(await ask({ installedVersion: () => '1.0.0' }), { answer: 'unsupported' });
    assert.deepEqual(await ask({ awaitLaunchReady: 'yes' }), { answer: 'unsupported' }, 'a property that is not a function is not the method');
    assert.deepEqual(await sc.awaitLaunchReady({ engineId: 'eng', getProfile: getProfile(undefined), session, project }, {}), { answer: 'unsupported' });
    assert.deepEqual(await sc.awaitLaunchReady({ engineId: 'eng', getProfile: getProfile(block({ adapter: 'absent' })), session, project }, {}), { answer: 'unsupported' });
    assert.deepEqual(await sc.awaitLaunchReady({ engineId: 'eng', getProfile: getProfile(block({ adapter: 'toString' })), session, project }, {}), { answer: 'unsupported' }, 'an inherited property is not an adapter');
  });

  it('passes the adapter\'s ready and not-ready answers through, and hands it the launch and the witness', async () => {
    const seen = [];
    const witness = async () => ({ shown: true });
    const adapter = { awaitLaunchReady: async (input, deps) => { seen.push({ input, deps }); return { ready: true }; } };
    assert.deepEqual(await ask(adapter, { witness, windowMs: 50, adapterDeps: { pollMs: 1 } }), { answer: 'ready' });
    assert.deepEqual(seen[0].input, { session, project, sequenceId: 9, witness, windowMs: 50 });
    assert.deepEqual(seen[0].deps, { pollMs: 1 });

    const held = { awaitLaunchReady: async () => ({ ready: false, unavailable: false, observation: 'the composer holds typed text', remedy: 'Press Fire.' }) };
    assert.deepEqual(await ask(held), { answer: 'not-ready', unavailable: false, observation: 'the composer holds typed text', remedy: 'Press Fire.', whole: null });
    const unread = { awaitLaunchReady: async () => ({ ready: false, unavailable: true, observation: 'the pane could not be read', whole: 'A whole sentence.' }) };
    assert.deepEqual(await ask(unread), { answer: 'not-ready', unavailable: true, observation: 'the pane could not be read', remedy: null, whole: 'A whole sentence.' });
  });

  it('UNKNOWN, never unsupported, when an adapter that HAS the method cannot answer: it throws, rejects, answers nonsense, or the launch cannot be read', async () => {
    const unknowns = [
      await ask({ awaitLaunchReady: () => { throw new Error('boom /private/path'); } }),
      await ask({ awaitLaunchReady: async () => { throw new Error('socket gone'); } }),
      await ask({ awaitLaunchReady: async () => null }),
      await ask({ awaitLaunchReady: async () => ({}) }),
      await ask({ awaitLaunchReady: async () => ({ ready: 'true' }) }),
      await ask({ awaitLaunchReady: async () => ({ ready: false }) }),
      await ask({ awaitLaunchReady: async () => ({ ready: true }) }, { session: null }),
      await ask({ awaitLaunchReady: async () => ({ ready: true }) }, { project: null })
    ];
    for (const u of unknowns) {
      assert.equal(u.answer, 'unknown');
      assert.notEqual(u.answer, 'unsupported');
      assert.equal(u.unavailable, true, 'an answer that could not be had is a proof that could not be made');
      assert.ok(u.observation && !u.observation.includes('/private/path'), 'and the fault\'s own text stays in the log');
    }
  });

  it('a profile that cannot be read is unknown: nothing says the adapter lacks the method', async () => {
    const r = await sc.awaitLaunchReady({ engineId: 'eng', getProfile: () => { throw new Error('EACCES'); }, session, project }, {});
    assert.equal(r.answer, 'unknown');
  });

  it('an adapter that does not come back within the window and its grace is unknown, and a late answer changes nothing', async (t) => {
    // The facade's own timer does not hold the process open; this one stands in for the server's.
    const alive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(alive));
    let release;
    const adapter = { awaitLaunchReady: () => new Promise((resolve) => { release = resolve; }) };
    const r = await ask(adapter, { windowMs: 5, graceMs: 5 });
    assert.equal(r.answer, 'unknown');
    assert.match(r.observation, /did not answer the launch-readiness read in time/);
    release({ ready: true });
    const rejecting = { awaitLaunchReady: () => new Promise((resolve, reject) => { setTimeout(() => reject(new Error('late')), 20); }) };
    assert.equal((await ask(rejecting, { windowMs: 1, graceMs: 1 })).answer, 'unknown');
    await new Promise((r2) => setTimeout(r2, 30));
  });

  it('the adapter is found by name, not by the version probe: an unverified version is still asked', async () => {
    const adapter = { installedVersion: () => '9.9.9', awaitLaunchReady: async () => ({ ready: true }) };
    assert.deepEqual(await ask(adapter), { answer: 'ready' });
  });

  it('the Codex adapter implements it', () => {
    assert.equal(typeof sc.ADAPTERS.codex.awaitLaunchReady, 'function');
  });
});
