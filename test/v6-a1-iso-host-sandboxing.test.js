'use strict';

/*
 * v6 (#3005, V6-35 / A1-Iso, Car V62-W1-B): isolated-mode admission
 * (`lib/v6/a1-iso-host-sandboxing.js`). Medium tier: attestation receipts
 * open an in-memory `node:sqlite` database. Nothing here spawns a process —
 * host facts are injected, which is the point: the planner decides, a
 * launcher executes.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  ISOLATION_MODES, CONTAINER_RUNTIMES, ARGV_RUNTIMES, ENV_ALLOWLIST, FORBIDDEN_MOUNT_TARGETS, DEFAULT_PIDS_LIMIT,
  profileDigest, validateMounts, planIsolation, ensureSchema, recordAttestation, listAttestations, currentHostFacts
} = require('../lib/v6/a1-iso-host-sandboxing');

const HOST = { uid: 501, gid: 20, runtimes: { docker: true, podman: false }, canSwitchUid: true,
  env: { PATH: '/usr/bin', LANG: 'en_US.UTF-8', GH_TOKEN: 'ghp_secret', HOME: '/Users/op' },
  realpath: (p) => (p.includes('link') ? '/elsewhere' : path.resolve(p)) };

const CONTAINER = { mode: 'container', requireIsolation: true, runtime: 'docker', image: 'ghcr.io/acme/agent@sha256:abc',
  command: ['node', 'agent.js'], uid: 1500, gid: 1500, mountRoots: ['/srv/fleet'], writableRoots: ['/srv/fleet/work'],
  mounts: [{ source: '/srv/fleet/repo', target: '/repo' }, { source: '/srv/fleet/work/a', target: '/work', readOnly: false }] };

describe('constants', () => {
  it('names the modes, runtimes and the env allowlist', () => {
    assert.deepEqual([...ISOLATION_MODES], ['shared_uid', 'container', 'separate_unix_uid']);
    assert.deepEqual([...CONTAINER_RUNTIMES], ['docker', 'podman', 'apple-container']);
    assert.deepEqual([...ARGV_RUNTIMES], ['docker', 'podman']);
    assert.ok(!ENV_ALLOWLIST.some((k) => /TOKEN|KEY|SECRET|HOME/.test(k)));
    assert.ok(FORBIDDEN_MOUNT_TARGETS.includes('/') && FORBIDDEN_MOUNT_TARGETS.includes('/etc'));
    assert.equal(DEFAULT_PIDS_LIMIT, 256);
  });
});

describe('shared_uid', () => {
  it('is admitted only when isolation is not required, and attests isolated: false', () => {
    const plan = planIsolation({ mode: 'shared_uid' }, HOST);
    assert.equal(plan.ok, true);
    assert.equal(plan.attestation.isolated, false);
    assert.equal(plan.attestation.network, 'shared');
  });

  it('is refused when the profile requires isolation', () => {
    assert.equal(planIsolation({ mode: 'shared_uid', requireIsolation: true }, HOST).code, 'ISOLATION_REQUIRED');
  });
});

describe('separate_unix_uid', () => {
  const profile = { mode: 'separate_unix_uid', requireIsolation: true, uid: 1600, gid: 1600, workdir: '/srv/fleet/s1' };

  it('admits an unprivileged uid distinct from the host and passes only allowlisted env', () => {
    const plan = planIsolation(profile, HOST);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.launch, { kind: 'spawn', options: { uid: 1600, gid: 1600, cwd: '/srv/fleet/s1',
      env: { PATH: '/usr/bin', LANG: 'en_US.UTF-8', HOME: '/srv/fleet/s1' } } });
    assert.equal(plan.attestation.isolated, true);
    assert.equal(plan.attestation.network, 'shared', 'honest: uid separation does not isolate the network');
  });

  it('fails closed: target uid equal to the host, root, unknown host uid, or a host that cannot switch', () => {
    assert.equal(planIsolation({ ...profile, uid: 501 }, HOST).code, 'SAME_UID');
    assert.equal(planIsolation({ ...profile, uid: 0 }, HOST).code, 'TARGET_ID_INVALID');
    assert.equal(planIsolation({ ...profile, gid: 0 }, HOST).code, 'TARGET_ID_INVALID');
    assert.equal(planIsolation(profile, { ...HOST, uid: null }).code, 'HOST_UID_UNKNOWN');
    assert.equal(planIsolation(profile, { ...HOST, canSwitchUid: false }).code, 'ISOLATION_UNAVAILABLE');
    assert.equal(planIsolation({ ...profile, workdir: 'rel' }, HOST).code, 'WORKDIR_INVALID');
  });
});

describe('container', () => {
  it('builds a locked-down argv: read-only rootfs, all caps dropped, no-new-privileges, no network, non-root user', () => {
    const plan = planIsolation(CONTAINER, HOST);
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.launch.command, 'docker');
    const a = plan.launch.args;
    for (const flag of ['--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--network=none', '--user=1500:1500']) {
      assert.ok(a.includes(flag), flag);
    }
    assert.ok(a.includes('--mount=type=bind,src=/srv/fleet/repo,dst=/repo,readonly'));
    assert.ok(a.includes('--mount=type=bind,src=/srv/fleet/work/a,dst=/work'), 'a writable mount inside a writable root');
    assert.deepEqual(a.slice(-3), ['ghcr.io/acme/agent@sha256:abc', 'node', 'agent.js']);
    assert.equal(plan.attestation.filesystem, 'read-only-rootfs');
    assert.equal(plan.attestation.network, 'none');
  });

  it('accepts one named allowlist network, never host or bridge', () => {
    const plan = planIsolation({ ...CONTAINER, network: { allowlistNetwork: 'tc-egress' } }, HOST);
    assert.ok(plan.launch.args.includes('--network=tc-egress'));
    assert.equal(plan.attestation.network, 'allowlist:tc-egress');
    for (const n of ['host', 'bridge']) assert.equal(planIsolation({ ...CONTAINER, network: { allowlistNetwork: n } }, HOST).code, 'NETWORK_INVALID');
    assert.equal(planIsolation({ ...CONTAINER, network: 'host' }, HOST).code, 'NETWORK_INVALID');
  });

  it('fails closed on an unavailable, unknown or unverified runtime', () => {
    assert.equal(planIsolation({ ...CONTAINER, runtime: 'podman' }, HOST).code, 'RUNTIME_UNAVAILABLE');
    assert.equal(planIsolation({ ...CONTAINER, runtime: 'lxc' }, HOST).code, 'RUNTIME_INVALID');
    assert.equal(planIsolation({ ...CONTAINER, runtime: 'apple-container' }, { ...HOST, runtimes: { 'apple-container': true } }).code, 'RUNTIME_UNSUPPORTED');
    assert.equal(planIsolation(CONTAINER, { ...HOST, runtimes: undefined }).code, 'RUNTIME_UNAVAILABLE');
  });

  it('refuses root, a bad image, a bad command and a bad pids limit', () => {
    assert.equal(planIsolation({ ...CONTAINER, uid: 0 }, HOST).code, 'TARGET_ID_INVALID');
    for (const image of ['acme; rm -rf /', 'Acme/Upper', '']) assert.equal(planIsolation({ ...CONTAINER, image }, HOST).code, 'IMAGE_INVALID', image);
    assert.equal(planIsolation({ ...CONTAINER, command: [] }, HOST).code, 'COMMAND_INVALID');
    assert.equal(planIsolation({ ...CONTAINER, command: 'node x' }, HOST).code, 'COMMAND_INVALID');
    assert.equal(planIsolation({ ...CONTAINER, pidsLimit: 0 }, HOST).code, 'PIDS_LIMIT_INVALID');
  });
});

describe('validateMounts', () => {
  const opts = { mountRoots: ['/srv/fleet'], writableRoots: ['/srv/fleet/work'], realpath: HOST.realpath };

  it('refuses a source outside the roots, a writable mount outside the writable roots, and a symlinked source', () => {
    assert.equal(validateMounts([{ source: '/etc', target: '/x' }], opts).code, 'MOUNT_NOT_ALLOWED');
    assert.equal(validateMounts([{ source: '/srv/fleetx/a', target: '/x' }], opts).code, 'MOUNT_NOT_ALLOWED', 'a prefix-sharing sibling is outside');
    assert.equal(validateMounts([{ source: '/srv/fleet/repo', target: '/x', readOnly: false }], opts).code, 'MOUNT_WRITE_DENIED');
    assert.equal(validateMounts([{ source: '/srv/fleet/link', target: '/x' }], opts).code, 'MOUNT_SYMLINK_DENIED');
  });

  it('refuses a system target, a relative path, and a comma that would inject mount options', () => {
    for (const target of ['/', '/etc', '/etc/ssh', '/proc', '/var/run']) {
      assert.equal(validateMounts([{ source: '/srv/fleet/repo', target }], opts).code, 'MOUNT_TARGET_FORBIDDEN', target);
    }
    assert.equal(validateMounts([{ source: 'srv/fleet', target: '/x' }], opts).code, 'MOUNT_INVALID');
    assert.equal(validateMounts([{ source: '/srv/fleet/a,readonly=false', target: '/x' }], opts).code, 'MOUNT_INVALID');
  });

  it('defaults every mount to read-only and needs host.realpath to admit any mount', () => {
    assert.deepEqual(validateMounts([{ source: '/srv/fleet/repo', target: '/repo' }], opts).mounts, [{ source: '/srv/fleet/repo', target: '/repo', readOnly: true }]);
    assert.equal(planIsolation(CONTAINER, { ...HOST, realpath: undefined }).code, 'HOST_FACTS_REQUIRED');
  });
});

describe('fail-closed and input shape', () => {
  it('refuses an unknown mode, a missing profile and missing host facts', () => {
    assert.equal(planIsolation({ mode: 'vm' }, HOST).code, 'MODE_INVALID');
    assert.equal(planIsolation(null, HOST).code, 'MODE_INVALID');
    assert.equal(planIsolation({ mode: 'container' }, null).code, 'HOST_FACTS_REQUIRED');
  });

  it('no refusal ever returns a launch: a refused isolated request is never downgraded', () => {
    const refusals = [
      planIsolation({ mode: 'separate_unix_uid', requireIsolation: true, uid: 501, gid: 20 }, HOST),
      planIsolation({ ...CONTAINER, runtime: 'podman' }, HOST),
      planIsolation({ mode: 'shared_uid', requireIsolation: true }, HOST)
    ];
    for (const r of refusals) {
      assert.equal(r.ok, false);
      assert.equal(r.launch, undefined);
      assert.equal(typeof r.reason, 'string');
    }
  });

  it('currentHostFacts reads the real uid but reports no runtimes and no uid switching', () => {
    const facts = currentHostFacts();
    assert.equal(facts.uid, process.getuid());
    assert.deepEqual(facts.runtimes, {});
    assert.equal(facts.canSwitchUid, false);
    assert.equal(planIsolation({ ...CONTAINER, mounts: [] }, facts).code, 'RUNTIME_UNAVAILABLE');
  });
});

describe('attestation receipts', () => {
  it('profileDigest ignores key order', () => {
    assert.equal(profileDigest({ a: 1, b: { c: 2, d: 3 } }), profileDigest({ b: { d: 3, c: 2 }, a: 1 }));
    assert.notEqual(profileDigest({ a: 1 }), profileDigest({ a: 2 }));
  });

  it('ensureSchema is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    ensureSchema(db);
    ensureSchema(db);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'v6_isolation_attestations'").get());
  });

  it('records admitted and refused decisions, once each per session and profile', () => {
    const db = new DatabaseSync(':memory:');
    const admitted = planIsolation(CONTAINER, HOST);
    const first = recordAttestation(db, { sessionId: 's1', profile: CONTAINER, plan: admitted, now: 1 });
    const again = recordAttestation(db, { sessionId: 's1', profile: CONTAINER, plan: admitted, now: 2 });
    assert.deepEqual([first.created, again.created, again.id === first.id], [true, false, true]);
    assert.equal(first.isolated, true);
    const refusedProfile = { ...CONTAINER, runtime: 'podman' };
    const r = recordAttestation(db, { sessionId: 's1', profile: refusedProfile, plan: planIsolation(refusedProfile, HOST), now: 3 });
    assert.equal(r.decision, 'refused');
    const rows = listAttestations(db, 's1');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].target_uid, 1500);
    assert.equal(rows[0].host_uid, 501);
    assert.equal(rows[1].code, 'RUNTIME_UNAVAILABLE');
    assert.equal(rows[1].detail.reason.includes('podman'), true);
  });

  it('a shared_uid admission is recorded as not isolated', () => {
    const db = new DatabaseSync(':memory:');
    const profile = { mode: 'shared_uid' };
    assert.equal(recordAttestation(db, { sessionId: 's2', profile, plan: planIsolation(profile, HOST) }).isolated, false);
  });

  it('refuses a receipt with no session or plan', () => {
    const db = new DatabaseSync(':memory:');
    assert.throws(() => recordAttestation(db, { profile: {}, plan: { ok: true } }), TypeError);
    assert.throws(() => recordAttestation(db, { sessionId: 's', profile: {} }), TypeError);
  });
});
