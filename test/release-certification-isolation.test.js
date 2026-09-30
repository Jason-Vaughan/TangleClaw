'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const iso = require('../lib/release-certification/isolation');
const sm = require('../lib/release-certification/state-machine');
const { HARD_FAIL, EXTEND, STATES, REFUSAL } = require('../lib/release-certification/codes');
const fx = require('./_release-certification-fixtures');

const { SHA, MIN, T0 } = fx;
const B = { candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: 'e'.repeat(64), sampleSeq: 3 };

describe('isolation attestations (#2020, A43, A44)', () => {
  it('reads a joined, bound, healthy pair as attested, with both digests', () => {
    const r = iso.judgeIsolation(fx.isolationPair(B), B);
    assert.equal(r.error, null);
    assert.deepEqual([r.observation.state, r.observation.bootId, r.observation.rulesetSha256], ['ok', fx.BOOT_ID, fx.RULESET]);
    assert.match(r.observation.adminDigest, /^[0-9a-f]{64}$/);
    assert.notEqual(r.observation.adminDigest, r.observation.workloadDigest);
  });

  it('digests the content, not how the producer ordered its fields', () => {
    const pair = fx.isolationPair(B);
    const reordered = Object.fromEntries(Object.entries(pair.admin).reverse());
    assert.equal(iso.digest(reordered), iso.digest(pair.admin));
    assert.notEqual(iso.digest({ ...pair.admin, observedAt: T0 + 1 }), iso.digest(pair.admin));
  });

  for (const [name, pair, diag] of [
    ['no attestation', null, 'MISSING'],
    ['a missing plane', { admin: fx.isolationPair(B).admin }, 'MISSING'],
    ['an unknown schema', fx.isolationPair(B, { admin: { schema: 'x' } }), 'INVALID'],
    ['an extra field', fx.isolationPair(B, { workload: { extra: 1 } }), 'INVALID'],
    ['a malformed ruleset digest', fx.isolationPair(B, { admin: { rulesetSha256: 'short' } }), 'INVALID'],
    ['a non-boolean egress answer', fx.isolationPair(B, { workload: { egressDenied: { ipv4: true, ipv6: 'yes', dns: true } } }), 'INVALID'],
    ['another sample\'s attestation', fx.isolationPair({ ...B, sampleSeq: 2 }), 'UNBOUND'],
    ['another run\'s attestation', fx.isolationPair({ ...B, runId: 'f'.repeat(32) }), 'UNBOUND'],
    ['one plane bound to another manifest', fx.isolationPair(B, { workload: { manifestDigest: 'f'.repeat(64) } }), 'UNBOUND'],
    ['planes from two different boots', fx.isolationPair(B, { workload: { bootId: 'boot-other' } }), 'SPLIT']
  ]) {
    it(`reads ${name} as unattested (${diag})`, () => {
      assert.deepEqual(iso.judgeIsolation(pair, B), { observation: { state: 'unavailable' }, error: iso.DIAGNOSTIC[diag] });
    });
  }

  for (const [name, over] of [
    ['the packet filter off', { admin: { pfEnabled: false } }],
    ['the management path open', { admin: { managementPath: 'open' } }],
    ['IPv4 egress allowed', { workload: { egressDenied: { ipv4: false, ipv6: true, dns: true } } }],
    ['IPv6 egress allowed', { workload: { egressDenied: { ipv4: true, ipv6: false, dns: true } } }],
    ['DNS allowed', { workload: { egressDenied: { ipv4: true, ipv6: true, dns: false } } }],
    ['sudo allowed', { workload: { sudoRefused: false } }],
    ['pfctl allowed', { workload: { pfctlRefused: false } }],
    ['the loopback API unreachable', { workload: { loopbackApi: false } }],
    ['a root workload', { workload: { uid: 0 } }],
    ['a workload in the admin group', { workload: { groups: [20, 80] } }],
    ['a workload in the wheel group', { workload: { groups: [0] } }]
  ]) {
    it(`reads a well-formed attestation with ${name} as a breach`, () => {
      assert.equal(iso.judgeIsolation(fx.isolationPair(B, over), B).observation.state, 'breached');
    });
  }

  it('reads a producer that throws, or a bad binding, as unattested and never throws', async () => {
    assert.equal((await iso.attest(async () => { throw new Error('ssh down'); }, B)).error, iso.DIAGNOSTIC.MISSING);
    assert.equal((await iso.attest(async (b) => fx.isolationPair(b), { ...B, sampleSeq: 0 })).error, iso.DIAGNOSTIC.MISSING);
    assert.equal((await iso.attest(undefined, B)).error, iso.DIAGNOSTIC.MISSING);
    assert.equal((await iso.attest(async (b) => fx.isolationPair(b), B)).observation.state, 'ok');
  });

  it('runs the pinned producer with the sample\'s binding and reads its JSON, or a classed failure with sanitized stderr', async () => {
    const calls = [];
    const fake = (out, err, stderr = '') => (program, args, opts, cb) => { calls.push([program, args]); cb(err, out, stderr); };
    const pair = fx.isolationPair(B);
    assert.deepEqual(await iso.producer('/x/guest-setup.sh', fake(JSON.stringify(pair), null))(B), pair);
    assert.deepEqual(calls[0], ['/x/guest-setup.sh', ['--verify-network', '--candidate', SHA, '--run-id', fx.RUN_ID, '--manifest-digest', B.manifestDigest, '--sample-seq', '3']]);
    const exit3 = Object.assign(new Error('exit 3'), { code: 3 });
    assert.deepEqual(await iso.producer('/x/g', fake('', exit3, 'refused: the two attestations could not be joined\n\u0007attest-bridge refused (SPLIT)'))(B),
      { failure: { class: 'exit-3', detail: 'refused: the two attestations could not be joined attest-bridge refused (SPLIT)' } });
    assert.equal((await iso.producer('/x/g', fake('', Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' })))(B)).failure.class, 'timeout');
    assert.equal((await iso.producer('/x/g', fake('', new Error('ENOENT')))(B)).failure.class, 'spawn-failed');
    assert.equal((await iso.producer('/x/g', fake('  ', null))(B)).failure.class, 'no-output');
    assert.equal((await iso.producer('/x/g', fake('not json', null))(B)).failure.class, 'bad-json');
    assert.equal((await iso.producer('/x/g', fake('', exit3, 'x'.repeat(500)))(B)).failure.detail.length, 300, 'stderr is truncated');
  });

  it('keeps a producer failure as a private diagnostic, never a breach', async () => {
    const r = await iso.attest(async () => ({ failure: { class: 'exit-3', detail: 'attest-bridge refused (SPLIT)' } }), B);
    assert.deepEqual(r, { observation: { state: 'unavailable' }, error: iso.DIAGNOSTIC.MISSING, detail: 'exit-3: attest-bridge refused (SPLIT)' });
    const raw = await iso.attest(async () => ({ failure: { class: 'exit-1', detail: '\u001b[31m' + 'y'.repeat(900) } }), B);
    assert.equal(raw.observation.state, 'unavailable', 'a failure is never a breach');
    assert.ok(raw.detail.length <= 300 && /^[\x20-\x7e]*$/.test(raw.detail), 'attest bounds a producer it did not build');
  });

  it('reads only a closed, bound breach envelope as breached', () => {
    const env = { schema: iso.BREACH_SCHEMA, ...B, bootId: fx.BOOT_ID, facts: [{ plane: 'workload', fact: 'egress-permitted' }], observedAt: T0 };
    const ok = iso.judgeIsolation({ breach: env }, B);
    assert.equal(ok.observation.state, 'breached');
    assert.match(ok.observation.breachDigest, /^[0-9a-f]{64}$/);
    for (const [name, bad, diag] of [
      ['an unknown fact', { ...env, facts: [{ plane: 'workload', fact: 'flaky' }] }, 'INVALID'],
      ['no facts', { ...env, facts: [] }, 'INVALID'],
      ['the same plane twice', { ...env, facts: [{ plane: 'admin', fact: 'pf-disabled' }, { plane: 'admin', fact: 'pf-rules-changed' }] }, 'INVALID'],
      ['an extra field', { ...env, extra: 1 }, 'INVALID'],
      ['another sample', { ...env, sampleSeq: 4 }, 'UNBOUND'],
      ['another run', { ...env, runId: 'f'.repeat(32) }, 'UNBOUND']
    ]) {
      assert.equal(iso.judgeIsolation({ breach: bad }, B).error, iso.DIAGNOSTIC[diag], name);
    }
    assert.equal(iso.judgeIsolation({ breach: env, admin: {} }, B).error, iso.DIAGNOSTIC.INVALID, 'an envelope beside a pair is ambiguous');
  });
});

describe('probes: a sample carries what the isolation producer returned (B10 review)', () => {
  const probes = require('../lib/release-certification/probes');
  const bridge = require('../lib/soak/attest-bridge');
  const collect = (verifyNetwork) => probes.createProbes(
    { apiBase: 'http://x', worktreePath: '/x', candidateSha: SHA, runId: B.runId, repo: 'o/r', requiredChecks: ['test'], maxReadingAgeMs: MIN, isolation: 'attested' },
    { fetchJson: async () => ({ body: null, error: 'connect-failed' }), measure: async () => null, ghJson: async () => ({ body: null, error: 'gh-failed' }), verifyNetwork }
  ).collect(T0, { seq: B.sampleSeq, manifestDigest: B.manifestDigest });

  it('keeps a producer failure as the stable diagnostic plus its private detail, and binds no isolation', async () => {
    const s = await collect(async () => ({ failure: { class: 'exit-3', detail: 'attest-bridge refused (SPLIT)' } }));
    assert.deepEqual(s.observations.isolation, { state: 'unavailable' });
    assert.equal(s.diagnostics.isolation, iso.DIAGNOSTIC.MISSING);
    assert.equal(s.diagnostics.isolationDetail, 'exit-3: attest-bridge refused (SPLIT)');
    assert.equal(s.isolation, undefined);
  });

  it('carries a bound breach envelope as a breached observation, binding its sample, boot and digest', async () => {
    const env = { schema: iso.BREACH_SCHEMA, ...B, bootId: fx.BOOT_ID, facts: [{ plane: 'workload', fact: 'egress-permitted' }], observedAt: T0 };
    const s = await collect(async () => ({ breach: env }));
    assert.equal(s.observations.isolation.state, 'breached');
    assert.equal(s.diagnostics.isolation, undefined);
    assert.equal(s.diagnostics.isolationDetail, undefined);
    assert.deepEqual(s.isolation, { sampleSeq: B.sampleSeq, bootId: fx.BOOT_ID, breachDigest: s.observations.isolation.breachDigest });
    assert.match(s.isolation.breachDigest, /^[0-9a-f]{64}$/);
  });

  it('keeps the bridge\'s copies of the breach schema and facts equal to the judge\'s', () => {
    assert.deepEqual([bridge.BREACH_SCHEMA, bridge.BREACH_FACTS], [iso.BREACH_SCHEMA, iso.BREACH_FACTS]);
  });
});

describe('state machine: a guest run is judged on its isolation (A43, A44, A47)', () => {
  const m = fx.guestManifest();
  const healthy = (over = {}) => ({ ...fx.observations(), isolation: { ...fx.ISOLATED, ...over } });
  const admitted = () => sm.admit(m, fx.sample(0, healthy()));

  it('pins attested isolation and an admission baseline in a guest manifest', () => {
    assert.deepEqual([m.isolation, m.baselineSource, m.private.isolationProducer], ['attested', 'admission', '/x/guest-setup.sh']);
  });

  it('refuses admission without an attestation, and records the whole baseline once when admitted', () => {
    assert.throws(() => sm.admit(m, fx.sample(0)), (e) => e.code === REFUSAL.ADMISSION_REFUSED && e.details.reasons.some((r) => r.code === EXTEND.ISOLATION_UNATTESTED));
    const { state } = admitted();
    assert.deepEqual(state.baseline, { source: 'admission', ttydGeneration: fx.GEN, bootId: fx.BOOT_ID, rulesetSha256: fx.RULESET, adminDigest: fx.ISOLATED.adminDigest, workloadDigest: fx.ISOLATED.workloadDigest });
  });

  it('earns nothing on an unattested sample, and keeps the baseline', () => {
    const s1 = admitted().state;
    const out = sm.reduce(s1, m, fx.sample(MIN, { ...fx.observations(), isolation: { state: 'unavailable' } }));
    assert.equal(out.state.state, STATES.EXTENDED);
    assert.equal(out.state.qualifiedMs, 0);
    assert.ok(out.state.extensions[EXTEND.ISOLATION_UNATTESTED]);
    assert.deepEqual(out.state.baseline, s1.baseline);
  });

  for (const [name, over, code] of [
    ['a breach', { state: 'breached' }, HARD_FAIL.ISOLATION_BREACHED],
    ['a reboot', { bootId: 'boot-after-reboot' }, HARD_FAIL.BOOT_CHANGED],
    ['a changed packet filter', { rulesetSha256: 'c'.repeat(64) }, HARD_FAIL.ISOLATION_CHANGED]
  ]) {
    it(`fails the run irrevocably on ${name}`, () => {
      const s1 = admitted().state;
      const out = sm.reduce(s1, m, fx.sample(MIN, healthy(over)));
      assert.equal(out.state.state, STATES.FAILED);
      assert.equal(out.state.failure.code, code);
      assert.deepEqual(out.state.baseline, s1.baseline, 'the baseline is never rewritten in place');
      assert.throws(() => sm.reduce(out.state, m, fx.sample(2 * MIN, healthy())), (e) => e.code === REFUSAL.ALREADY_TERMINAL);
    });
  }

  it('fails the run on a measured-breach envelope, with no spurious ruleset change', () => {
    const s1 = admitted().state;
    const out = sm.reduce(s1, m, fx.sample(MIN, { ...fx.observations(), isolation: { state: 'breached', bootId: fx.BOOT_ID, facts: ['workload:egress-permitted'], breachDigest: 'e'.repeat(64) } }));
    assert.equal(out.state.state, STATES.FAILED);
    assert.deepEqual(out.state.failure.reasons.map((r) => r.code), [HARD_FAIL.ISOLATION_BREACHED]);
  });

  it('ignores isolation entirely on a host run', () => {
    const host = fx.manifest();
    const { state } = sm.admit(host, fx.sample(0));
    assert.equal(state.baseline.bootId, null);
    assert.equal(sm.reduce(state, host, fx.sample(MIN)).state.state, STATES.RUNNING);
  });
});
