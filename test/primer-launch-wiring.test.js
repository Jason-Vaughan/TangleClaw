'use strict';

// #2844 (#2070 Slice 2): operating-primer launch wiring, via
// `lib/primer-launch-wiring.js`. A fresh temp store per test for the
// coordinator_roles precedence tests; everything else is pure, so the
// store is only started where a test actually needs it.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const operatingPrimer = require('../lib/operating-primer');
const plw = require('../lib/primer-launch-wiring');

describe('resolveSessionRole (pure precedence, no store)', () => {
  it('defaults to worker with no signal at all', () => {
    assert.equal(plw.resolveSessionRole({}, { env: {} }), 'worker');
    assert.equal(plw.resolveSessionRole(undefined, { env: {} }), 'worker');
  });

  it('isMaster wins over every other signal', () => {
    const role = plw.resolveSessionRole(
      { isMaster: true, roleHint: 'worker' },
      { env: { [plw.ROLE_ENV_VAR]: 'reviewer' } }
    );
    assert.equal(role, 'master');
  });

  it('roleHint wins over the env convention', () => {
    const role = plw.resolveSessionRole({ roleHint: 'reviewer' }, { env: { [plw.ROLE_ENV_VAR]: 'worker' } });
    assert.equal(role, 'reviewer');
  });

  it('an unrecognized roleHint is ignored, not thrown or trusted', () => {
    const role = plw.resolveSessionRole({ roleHint: 'not-a-real-role' }, { env: { [plw.ROLE_ENV_VAR]: 'reviewer' } });
    assert.equal(role, 'reviewer');
  });

  it('the TANGLECLAW_SESSION_ROLE env var is read when nothing stronger names a role', () => {
    for (const role of plw.ROLES) {
      assert.equal(plw.resolveSessionRole({}, { env: { [plw.ROLE_ENV_VAR]: role } }), role);
    }
  });

  it('an unrecognized env value falls through rather than being trusted', () => {
    assert.equal(plw.resolveSessionRole({}, { env: { [plw.ROLE_ENV_VAR]: 'not-a-real-role' } }), 'worker');
  });

  it('reads process.env when no env override is injected', () => {
    const real = process.env[plw.ROLE_ENV_VAR];
    process.env[plw.ROLE_ENV_VAR] = 'coordinator';
    try {
      assert.equal(plw.resolveSessionRole({}), 'coordinator');
    } finally {
      if (real === undefined) delete process.env[plw.ROLE_ENV_VAR];
      else process.env[plw.ROLE_ENV_VAR] = real;
    }
  });
});

describe('resolveSessionRole (coordinator_roles precedence)', () => {
  let tmpDir = null;
  let project = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-primer-launch-wiring-'));
    store._setBasePath(tmpDir);
    store.init();
    const projDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projDir);
    project = store.projects.create({ name: 'plw-proj', path: projDir, engine: 'claude' });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a project with no active coordinator_roles row still defaults to worker', () => {
    assert.equal(plw.resolveSessionRole({ projectId: project.id }, { env: {} }), 'worker');
  });

  it('an active "architect" row folds to coordinator', () => {
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: project.id, role: 'architect', note: null, now: '2026-11-05T00:00:00.000Z' });
    assert.equal(plw.resolveSessionRole({ projectId: project.id }, { env: {} }), 'coordinator');
  });

  it('an active "project-manager" row folds to coordinator', () => {
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: project.id, role: 'project-manager', note: null, now: '2026-11-05T00:00:00.000Z' });
    assert.equal(plw.resolveSessionRole({ projectId: project.id }, { env: {} }), 'coordinator');
  });

  it('a revoked coordinator_roles row does not fold to coordinator', () => {
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: project.id, role: 'architect', note: null, now: '2026-11-05T00:00:00.000Z' });
    store.coordinatorRoles.revoke(project.id, '2026-11-05T00:05:00.000Z');
    assert.equal(plw.resolveSessionRole({ projectId: project.id }, { env: {} }), 'worker');
  });

  it('an explicit roleHint still wins over an active coordinator_roles row', () => {
    store.coordinatorRoles.grant({ roleId: 'role-1', projectId: project.id, role: 'architect', note: null, now: '2026-11-05T00:00:00.000Z' });
    assert.equal(plw.resolveSessionRole({ projectId: project.id, roleHint: 'worker' }, { env: {} }), 'worker');
  });
});

describe('primerForLaunch', () => {
  it('returns the resolved role and its real operating primer text', () => {
    const r = plw.primerForLaunch({ roleHint: 'reviewer' }, { env: {} });
    assert.equal(r.role, 'reviewer');
    assert.equal(r.primer, operatingPrimer.buildOperatingPrimer('reviewer'));
  });

  it('never produces a role buildOperatingPrimer would reject', () => {
    for (const roleHint of plw.ROLES) {
      assert.doesNotThrow(() => plw.primerForLaunch({ roleHint }, { env: {} }));
    }
  });
});

describe('attachOperatingPrimerToLease', () => {
  it('attaches the resolved role and primer without mutating the input lease', () => {
    const lease = { leaseId: 'lease_x', state: 'active' };
    const attached = plw.attachOperatingPrimerToLease(lease, { roleHint: 'worker' }, { env: {} });
    assert.notEqual(attached, lease, 'must return a new object');
    assert.equal(lease.operatingPrimer, undefined, 'the input lease is never mutated');
    assert.equal(attached.leaseId, 'lease_x');
    assert.equal(attached.state, 'active');
    assert.equal(attached.operatingPrimerRole, 'worker');
    assert.equal(attached.operatingPrimer, operatingPrimer.buildOperatingPrimer('worker'));
  });

  it('tolerates a missing/null lease', () => {
    const attached = plw.attachOperatingPrimerToLease(null, { roleHint: 'master' }, { env: {} });
    assert.equal(attached.operatingPrimerRole, 'master');
    assert.equal(typeof attached.operatingPrimer, 'string');
  });
});
