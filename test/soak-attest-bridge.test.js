'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const bridge = require('../lib/soak/attest-bridge');
const isolation = require('../lib/release-certification/isolation');

const B = { candidateSha: 'a'.repeat(40), runId: 'b'.repeat(32), manifestDigest: 'c'.repeat(64), sampleSeq: '7' };
const ART = { scriptSha256: '1'.repeat(64), profileSha256: '2'.repeat(64), guestConfSha256: '3'.repeat(64) };
const BOOT = { session: '11111111-2222-3333-4444-555555555555', time: 1790000000 };

/**
 * A healthy raw admin line, as `guest-setup.sh --verify-admin` prints it.
 * @param {object} [over] - Top-level fields to replace
 * @returns {object} The line's object
 */
function admin(over = {}) {
  return {
    schema: 'tc.soak-guest-attest/v1', mode: 'admin', ok: true, time: '2026-09-29T19:50:00Z', boot: BOOT, artifact: ART,
    pf: { enabled: true, expectedRulesSha256: 'd'.repeat(64), activeRulesSha256: 'd'.repeat(64), rulesMatch: true, rules: 5 },
    interface: { name: 'en0', address: '192.168.64.5' }, host: '192.168.64.1', management: { ssh: 'listening' },
    tangleclaw: { port: 3102, user: 'soakrun', uid: 502, pid: 4242, executable: '/usr/bin/node' }, ...over
  };
}

/**
 * A healthy raw workload line, as `guest-setup.sh --verify-workload` prints it.
 * @param {object} [over] - Top-level fields to replace
 * @returns {object} The line's object
 */
function workload(over = {}) {
  return {
    schema: 'tc.soak-guest-attest/v1', mode: 'workload', ok: true, time: '2026-09-29T19:50:01Z', boot: BOOT, artifact: ART,
    identity: { user: 'soakrun', uid: 502, groups: 'staff everyone', gids: '20 12 61' },
    refused: { sudo: true, pfctl: true }, loopback: { ipv4: true, ipv6: true, api: true },
    egress: { tcp4: 'denied', tcp6: 'denied', udpDns: 'denied' }, ...over
  };
}
const line = (o) => `${JSON.stringify(o)}\n`;

/**
 * Assert the bridge refuses, with a code.
 * @param {Function} fn - Thunk
 * @param {string} code - Expected code
 * @returns {void}
 */
function refuses(fn, code) {
  assert.throws(fn, (e) => e instanceof bridge.BridgeError && e.code === code);
}

describe('soak attest bridge: two fresh raw lines become one bound pair (Architect ruling 2baeac0d)', () => {
  it('copies the binding into both planes, maps host-only and numeric groups, and the judge accepts it', () => {
    const pair = bridge.bridge(line(admin()), line(workload()), B);
    const binding = { candidateSha: B.candidateSha, runId: B.runId, manifestDigest: B.manifestDigest, sampleSeq: 7 };
    for (const plane of [pair.admin, pair.workload]) {
      assert.deepEqual([plane.candidateSha, plane.runId, plane.manifestDigest, plane.sampleSeq], Object.values(binding));
      assert.equal(plane.bootId, `${BOOT.session}@${BOOT.time}`);
    }
    assert.equal(pair.admin.managementPath, 'host-only');
    assert.equal(pair.admin.rulesetSha256, 'd'.repeat(64));
    assert.deepEqual(pair.admin.interfaces, ['en0=192.168.64.5']);
    assert.deepEqual(pair.workload.groups, [20, 12, 61]);
    assert.equal(pair.admin.observedAt, Date.parse('2026-09-29T19:50:00Z'));
    assert.deepEqual(isolation.judgeIsolation(pair, binding).observation.state, 'ok');
  });

  for (const [name, over] of [
    ['a missing candidate', { candidateSha: undefined }],
    ['an uppercase candidate', { candidateSha: 'A'.repeat(40) }],
    ['a short run id', { runId: 'b'.repeat(31) }],
    ['a bad manifest digest', { manifestDigest: 'z'.repeat(64) }],
    ['a zero sample number', { sampleSeq: '0' }],
    ['a padded sample number', { sampleSeq: '07' }],
    ['an unsafe sample number', { sampleSeq: '9'.repeat(16) }]
  ]) {
    it(`refuses ${name} (BINDING)`, () => refuses(() => bridge.bridge(line(admin()), line(workload()), { ...B, ...over }), 'BINDING'));
  }

  for (const [name, a, w] of [
    ['no admin output', '', line(workload())],
    ['two admin lines', line(admin()) + line(admin()), line(workload())],
    ['extra text after the workload line', line(workload()), line(workload()) + 'debug\n'],
    ['a line that is not JSON', 'not json\n', line(workload())],
    ['a JSON array', '[1]\n', line(workload())],
    ['the wrong schema', line(admin({ schema: 'x' })), line(workload())],
    ['planes swapped', line(workload()), line(admin())]
  ]) {
    it(`refuses ${name} (OUTPUT)`, () => refuses(() => bridge.bridge(a, w, B), 'OUTPUT'));
  }

  it('refuses a plane that did not attest (NOT_OK)', () => {
    refuses(() => bridge.bridge(line(admin({ ok: false, code: 'REFUSED', reason: 'pf is not enabled' })), line(workload()), B), 'NOT_OK');
  });

  it('refuses planes from different boots or different artifacts (SPLIT)', () => {
    refuses(() => bridge.bridge(line(admin()), line(workload({ boot: { ...BOOT, time: BOOT.time + 1 } })), B), 'SPLIT');
    refuses(() => bridge.bridge(line(admin()), line(workload({ artifact: { ...ART, profileSha256: '9'.repeat(64) } })), B), 'SPLIT');
  });

  for (const [name, a, w] of [
    ['a ruleset that is not the profile', admin({ pf: { ...admin().pf, activeRulesSha256: 'e'.repeat(64) } }), workload()],
    ['pf reported disabled', admin({ pf: { ...admin().pf, enabled: false } }), workload()],
    ['an SSH state it has no mapping for', admin({ management: { ssh: 'unknown' } }), workload()],
    ['no numeric group ids', admin(), workload({ identity: { user: 'soakrun', uid: 502, groups: 'staff' } })],
    ['group ids that are names', admin(), workload({ identity: { ...workload().identity, gids: 'staff admin' } })],
    ['a system uid', admin(), workload({ identity: { ...workload().identity, uid: 0 } })],
    ['an egress probe that was not denied', admin(), workload({ egress: { ...workload().egress, tcp6: 'open' } })],
    ['a missing time', admin({ time: undefined }), workload()],
    ['a malformed interface', admin({ interface: { name: 'en0', address: 'not-an-ip' } }), workload()]
  ]) {
    it(`refuses ${name} (FIELD)`, () => refuses(() => bridge.bridge(line(a), line(w), B), 'FIELD'));
  }

  it('prints exactly one line and exits 0 from its command-line entry, or nothing and 3', () => {
    let out = '';
    let err = '';
    const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } };
    assert.equal(bridge.main([line(admin()), '0', line(workload()), '0', B.candidateSha, B.runId, B.manifestDigest, B.sampleSeq], io), 0);
    assert.equal(out.split('\n').filter(Boolean).length, 1);
    out = '';
    assert.equal(bridge.main([line(admin({ ok: false })), '3', line(workload()), '0', B.candidateSha, B.runId, B.manifestDigest, B.sampleSeq], io), 3);
    assert.equal(out, '');
    assert.match(err, /NOT_OK/);
    assert.equal(bridge.main([line(admin())], io), 3, 'a wrong argument count yields no pair');
    out = '';
    assert.equal(bridge.main([line(breachLine('admin', 'pf-disabled')), '3', line(workload()), '0', B.candidateSha, B.runId, B.manifestDigest, B.sampleSeq], io), 0);
    assert.ok(JSON.parse(out).breach, 'a measured breach is printed as its envelope');
  });
});


/**
 * A raw line reporting a MEASURED breach, as a verifier prints it (exit 3).
 * @param {'admin'|'workload'} mode - The plane
 * @param {string} fact - The measured fact
 * @param {object} [over] - Top-level fields to replace
 * @returns {object} The line's object
 */
function breachLine(mode, fact, over = {}) {
  return { schema: 'tc.soak-guest-attest/v1', mode, ok: false, code: 'BREACH', breach: { fact }, reason: 'measured', time: '2026-09-29T19:50:02Z', boot: BOOT, artifact: ART, ...over };
}

describe('soak attest bridge: a measured breach is bound, an inability to measure is not (Architect ruling 727dcaaf)', () => {
  const binding = { candidateSha: B.candidateSha, runId: B.runId, manifestDigest: B.manifestDigest, sampleSeq: 7 };

  it('binds an admin-plane breach without fabricating a healthy plane, and the judge reads it as breached', () => {
    const r = bridge.bridge(line(breachLine('admin', 'pf-disabled')), line(workload()), B, { admin: 3, workload: 0 });
    assert.deepEqual(Object.keys(r), ['breach']);
    assert.deepEqual(r.breach, { schema: bridge.BREACH_SCHEMA, ...binding, bootId: `${BOOT.session}@${BOOT.time}`, facts: [{ plane: 'admin', fact: 'pf-disabled' }], observedAt: Date.parse('2026-09-29T19:50:02Z') });
    const judged = isolation.judgeIsolation(r, binding);
    assert.equal(judged.observation.state, 'breached');
    assert.deepEqual(judged.observation.facts, ['admin:pf-disabled']);
  });

  it('binds a workload-plane breach even when the admin plane could not attest', () => {
    const r = bridge.bridge('not json\n', line(breachLine('workload', 'egress-permitted')), B, { admin: 3, workload: 3 });
    assert.deepEqual(r.breach.facts, [{ plane: 'workload', fact: 'egress-permitted' }]);
  });

  it('names both facts when both planes measured a breach', () => {
    const r = bridge.bridge(line(breachLine('admin', 'pf-rules-changed')), line(breachLine('workload', 'sudo-permitted')), B, { admin: 3, workload: 3 });
    assert.deepEqual(r.breach.facts, [{ plane: 'admin', fact: 'pf-rules-changed' }, { plane: 'workload', fact: 'sudo-permitted' }]);
  });

  for (const [name, a, rcA] of [
    ['a refusal to measure (code REFUSED)', { ...breachLine('admin', 'pf-disabled'), code: 'REFUSED' }, 3],
    ['a BREACH code from a verifier that did not exit 3', breachLine('admin', 'pf-disabled'), 0],
    ['an unknown breach fact', breachLine('admin', 'pf-flaky'), 3],
    ['a BREACH with no fact', { ...breachLine('admin', 'pf-disabled'), breach: null }, 3],
    ['a missing tool reported by the verifier', { schema: 'tc.soak-guest-attest/v1', mode: 'admin', ok: false, code: 'ENCODER_MISSING', reason: 'node is missing' }, 3]
  ]) {
    it(`never reads ${name} as a breach: the sample is unattested`, () => {
      refuses(() => bridge.bridge(line(a), line(workload()), B, { admin: rcA, workload: 0 }), 'NOT_OK');
    });
  }

  it('refuses a breach it cannot bind to one boot (FIELD, SPLIT)', () => {
    refuses(() => bridge.bridge(line(breachLine('admin', 'pf-disabled', { boot: undefined })), line(workload()), B, { admin: 3, workload: 0 }), 'FIELD');
    refuses(() => bridge.bridge(line(breachLine('admin', 'pf-disabled')), line(breachLine('workload', 'sudo-permitted', { boot: { ...BOOT, time: 1 } })), B, { admin: 3, workload: 3 }), 'SPLIT');
  });
});
