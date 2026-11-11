'use strict';

// v6.1 (#2993, V6-23 / C4+D2, Car V61-W1-A): the Operator-ratified standing
// failover policy and quota-aware placement. Policy ratification and
// receipts run against a real node:sqlite-backed store with a real
// AuthorizationService; decideFailover and the D2 placement functions are
// pure and tested directly, including P04's D-series placement cases.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const authorityService = require('../lib/v6/authority-service');
const c4 = require('../lib/v6/c4-d2-failover-and-quota-placement');

const CURRENT = Object.freeze({ engine: 'claude', model: 'claude-opus-5-5', effort: null });
const okValidator = () => ({ ok: true });

/**
 * A standing policy with a Builder boundary list, a worker outage fallback
 * and an auto-placement allowlist.
 * @param {object} [over]
 * @returns {object}
 */
function standing(over = {}) {
  const v = c4.validatePolicy({
    mode: 'standing-policy',
    allowedBoundaryTargets: { Builder: [{ engine: 'claude', model: 'claude-sonnet-5' }, { engine: 'codex', model: 'gpt-5.6-sol' }] },
    allowedOutageFallbacks: [{ engine: 'codex', model: 'gpt-5.6-sol' }],
    allowedAutoPlacements: [{ engine: 'b', model: 'mb' }],
    ...over
  });
  assert.equal(v.ok, true, JSON.stringify(v));
  return v.policy;
}

describe('validatePolicy (#2993)', () => {
  it('normalizes a valid policy and defaults the decider carve-out to off', () => {
    const p = standing();
    assert.equal(p.allowAutonomousDeciderFailover, false);
    assert.deepEqual(p.allowedOutageFallbacks[0].roles, ['Builder', 'Reviewer', 'Observer']);
  });

  it('refuses unknown keys, modes, roles and malformed tuples rather than dropping them', () => {
    assert.equal(c4.validatePolicy({ mode: 'confirm', allowOutage: true }).code, 'POLICY_UNKNOWN_KEY');
    assert.equal(c4.validatePolicy({ mode: 'yolo' }).code, 'POLICY_MODE_INVALID');
    assert.equal(c4.validatePolicy({ mode: 'standing-policy', allowedBoundaryTargets: { Intern: [] } }).code, 'POLICY_UNKNOWN_ROLE');
    assert.equal(c4.validatePolicy({ mode: 'standing-policy', allowedOutageFallbacks: [{ engine: 'x; rm -rf', model: 'm' }] }).code, 'POLICY_TARGET_MALFORMED');
    assert.equal(c4.validatePolicy({ mode: 'standing-policy', allowAutonomousDeciderFailover: 'yes' }).code, 'POLICY_MALFORMED');
    assert.equal(c4.validatePolicy(null).code, 'POLICY_MALFORMED');
    assert.equal(c4.validatePolicy([]).code, 'POLICY_MALFORMED');
  });
});

describe('decideFailover (#2993)', () => {
  it('no policy, or mode confirm, always yields the confirmation card (#109 default posture)', () => {
    for (const policy of [null, c4.validatePolicy({ mode: 'confirm' }).policy]) {
      for (const trigger of [...c4.BOUNDARY_TRIGGERS, ...c4.OUTAGE_TRIGGERS]) {
        const d = c4.decideFailover({ policy, role: 'Builder', trigger, current: CURRENT, validateTarget: okValidator });
        assert.equal(d.decision, 'confirm');
        assert.equal(d.code, 'CONFIRM_DEFAULT_POSTURE');
        assert.deepEqual(d.options, ['restart', 'switch', 'continue-manually']);
      }
    }
  });

  it('a routine boundary trigger auto-switches through boundary mode to the first valid allowlisted target', () => {
    const d = c4.decideFailover({ policy: standing(), role: 'Builder', trigger: 'quota-threshold', current: CURRENT, validateTarget: okValidator });
    assert.deepEqual([d.decision, d.switchMode, d.code], ['execute', 'boundary', 'STANDING_BOUNDARY_SWITCH']);
    assert.deepEqual(d.target, { engine: 'claude', model: 'claude-sonnet-5', effort: null });
  });

  it('skips the current tuple and any target the validator refuses, recording why', () => {
    const policy = standing({ allowedBoundaryTargets: { Builder: [{ engine: 'claude', model: 'claude-opus-5-5' }, { engine: 'claude', model: 'claude-sonnet-5' }, { engine: 'codex', model: 'gpt-5.6-sol' }] } });
    const validateTarget = ({ model }) => (model === 'claude-sonnet-5' ? { ok: false, code: 'MODEL_UNCONFIRMED' } : { ok: true });
    const d = c4.decideFailover({ policy, role: 'Builder', trigger: 'chunk-boundary', current: CURRENT, validateTarget });
    assert.equal(d.target.engine, 'codex');
    assert.deepEqual(d.rejected.map((r) => r.code), ['MODEL_UNCONFIRMED']);
  });

  it('a validator that throws counts as a refusal, never an approval', () => {
    const d = c4.decideFailover({ policy: standing(), role: 'Builder', trigger: 'chunk-boundary', current: CURRENT, validateTarget: () => { throw new Error('x'); } });
    assert.equal(d.decision, 'confirm');
    assert.equal(d.code, 'NO_ALLOWED_TARGET');
    assert.ok(d.rejected.every((r) => r.code === 'VALIDATOR_THREW'));
  });

  it('a target below the role capability floor is never chosen; unknown facts fail a non-trivial floor', () => {
    const policy = standing({ capabilityFloor: { Builder: { minQuality: 0.8, capabilities: ['tools'] } } });
    const facts = { 'claude/claude-sonnet-5/': { quality: 0.7, capabilities: ['tools'] } };
    const d = c4.decideFailover({ policy, role: 'Builder', trigger: 'chunk-boundary', current: CURRENT, candidateFacts: facts, validateTarget: okValidator });
    assert.equal(d.decision, 'confirm');
    assert.deepEqual(d.rejected.map((r) => r.code), ['BELOW_CAPABILITY_FLOOR', 'BELOW_CAPABILITY_FLOOR']);
    facts['codex/gpt-5.6-sol/'] = { quality: 0.9, capabilities: ['tools', 'shell'] };
    const ok = c4.decideFailover({ policy, role: 'Builder', trigger: 'chunk-boundary', current: CURRENT, candidateFacts: facts, validateTarget: okValidator });
    assert.equal(ok.target.engine, 'codex');
  });

  it('a worker outage auto-takes-over through outage-takeover mode (work preserved on wip/*)', () => {
    for (const role of ['Builder', 'Reviewer', 'Observer']) {
      const d = c4.decideFailover({ policy: standing(), role, trigger: 'provider-outage', current: CURRENT, validateTarget: okValidator });
      assert.deepEqual([d.decision, d.switchMode, d.code], ['execute', 'outage-takeover', 'STANDING_OUTAGE_TAKEOVER'], role);
    }
  });

  it('an outage fallback restricted to some roles is not offered to others', () => {
    const policy = standing({ allowedOutageFallbacks: [{ engine: 'codex', model: 'gpt-5.6-sol', roles: ['Reviewer'] }] });
    assert.equal(c4.decideFailover({ policy, role: 'Builder', trigger: 'session-crashed', current: CURRENT, validateTarget: okValidator }).code, 'NO_ALLOWED_TARGET');
    assert.equal(c4.decideFailover({ policy, role: 'Reviewer', trigger: 'session-crashed', current: CURRENT, validateTarget: okValidator }).decision, 'execute');
  });

  it('a decider outage escalates to the Operator unless the policy explicitly allows autonomous decider failover', () => {
    for (const role of ['PM', 'Architect', 'Orchestrator']) {
      const d = c4.decideFailover({ policy: standing(), role, trigger: 'provider-outage', current: CURRENT, validateTarget: okValidator });
      assert.deepEqual([d.decision, d.code], ['escalate', 'DECIDER_OUTAGE_REQUIRES_OPERATOR'], role);
    }
    const policy = standing({ allowAutonomousDeciderFailover: true, allowedOutageFallbacks: [{ engine: 'codex', model: 'gpt-5.6-sol', roles: ['PM'] }] });
    assert.equal(c4.decideFailover({ policy, role: 'PM', trigger: 'provider-outage', current: CURRENT, validateTarget: okValidator }).decision, 'execute');
  });

  it('an unknown role, trigger, current tuple or missing validator never auto-switches', () => {
    const p = standing();
    assert.equal(c4.decideFailover({ policy: p, role: 'Integrator', trigger: 'provider-outage', current: CURRENT, validateTarget: okValidator }).code, 'ROLE_NOT_COVERED');
    assert.equal(c4.decideFailover({ policy: p, role: 'Builder', trigger: 'vibes', current: CURRENT, validateTarget: okValidator }).decision, 'refuse');
    assert.equal(c4.decideFailover({ policy: p, role: 'Builder', trigger: 'chunk-boundary', current: {}, validateTarget: okValidator }).decision, 'refuse');
    assert.equal(c4.decideFailover({ policy: p, role: 'Builder', trigger: 'chunk-boundary', current: CURRENT }).code, 'NO_TARGET_VALIDATOR');
  });
});

describe('ratifyPolicy / getEffectivePolicy / receipts (#2993)', () => {
  let tmpDir;
  let db;
  let auth;

  /**
   * Seed a project in its own workspace with a user principal of `role`.
   * @param {string} role
   * @returns {{projectId: number, principalId: string}}
   */
  function seed(role = 'owner') {
    const stamp = new Date().toISOString();
    const projectId = db.prepare('INSERT INTO projects (name, path) VALUES (?,?)').run(`p-${crypto.randomUUID()}`, path.join(tmpDir, crypto.randomUUID())).lastInsertRowid;
    const wsId = `ws-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO trusted_workspaces (id, name, created_at) VALUES (?,?,?)').run(wsId, wsId, stamp);
    db.prepare('INSERT INTO trusted_project_workspaces (project_id, workspace_id) VALUES (?,?)').run(projectId, wsId);
    const userId = db.prepare('INSERT INTO users (username, password_hash) VALUES (?,?)').run(`u-${crypto.randomUUID()}`, 'x').lastInsertRowid;
    db.prepare('INSERT INTO trusted_memberships (workspace_id, user_id, role, granted_at) VALUES (?,?,?,?)').run(wsId, userId, role, stamp);
    const principalId = `principal-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO trusted_principals (id, kind, workspace_id, user_id, created_at) VALUES (?,?,?,?,?)').run(principalId, 'user', wsId, userId, stamp);
    return { projectId, principalId };
  }

  /**
   * Create a fleet under a project's own legacy logical project (`lp-<id>`,
   * made by the v6_legacy_project_insert trigger) and move that project's
   * legacy resource into it. With no project, an empty fleet on a fresh
   * native logical project.
   * @param {number|null} projectId
   * @returns {string} The fleet id.
   */
  function fleetOf(projectId) {
    const fleet = `fleet-${crypto.randomUUID()}`;
    const lp = projectId === null ? `lp-native-${crypto.randomUUID()}` : `lp-${projectId}`;
    if (projectId === null) db.prepare('INSERT INTO v6_logical_projects (id, display_name, origin) VALUES (?,?,?)').run(lp, lp, 'native');
    db.prepare('INSERT INTO v6_fleets (id, logical_project_id, display_name) VALUES (?,?,?)').run(fleet, lp, fleet);
    if (projectId !== null) db.prepare('UPDATE v6_resources SET fleet_id = ? WHERE legacy_project_id = ?').run(fleet, projectId);
    return fleet;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-c4-'));
    store._setBasePath(tmpDir);
    store.init();
    db = store.getDb();
    auth = authorityService.createAuthorizationService(db);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ensureSchema is idempotent', () => {
    c4.ensureSchema(db);
    c4.ensureSchema(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(names.includes('v6_c4_failover_policies') && names.includes('v6_c4_failover_receipts'));
  });

  it('an owner ratifies a project policy with version CAS; a stale version conflicts', () => {
    const { projectId, principalId } = seed();
    const base = { scopeKind: 'project', scopeId: projectId, policy: { mode: 'standing-policy' }, principalId, auth };
    assert.deepEqual(c4.ratifyPolicy(db, { ...base, expectedVersion: 0 }), { ok: true, code: 'RATIFIED', version: 1 });
    assert.equal(c4.ratifyPolicy(db, { ...base, expectedVersion: 0 }).code, 'VERSION_CONFLICT');
    assert.equal(c4.ratifyPolicy(db, { ...base, expectedVersion: 1 }).version, 2);
    assert.equal(c4.getEffectivePolicy(db, { projectId }).version, 2);
  });

  it('a plain member cannot ratify, and an invalid policy is refused before any write', () => {
    const { projectId, principalId } = seed('member');
    assert.equal(c4.ratifyPolicy(db, { scopeKind: 'project', scopeId: projectId, policy: { mode: 'standing-policy' }, expectedVersion: 0, principalId, auth }).code, 'ROLE_DENIED');
    const owner = seed();
    assert.equal(c4.ratifyPolicy(db, { scopeKind: 'project', scopeId: owner.projectId, policy: { mode: 'nope' }, expectedVersion: 0, principalId: owner.principalId, auth }).code, 'POLICY_MODE_INVALID');
    assert.equal(c4.getEffectivePolicy(db, { projectId: owner.projectId }), null);
  });

  it('authority over one project cannot ratify another project\'s policy', () => {
    const a = seed();
    const b = seed();
    const out = c4.ratifyPolicy(db, { scopeKind: 'project', scopeId: b.projectId, policy: { mode: 'standing-policy' }, expectedVersion: 0, principalId: a.principalId, auth });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'SCOPE_DENIED');
    assert.equal(c4.ratifyPolicy(db, { scopeKind: 'project', scopeId: '1.0', policy: { mode: 'confirm' }, expectedVersion: 0, principalId: a.principalId, auth }).code, 'SCOPE_INVALID');
  });

  it('a fleet policy needs writePolicy on its member projects, and a project policy overrides its fleet\'s', () => {
    const a = seed();
    const b = seed();
    const fleet = fleetOf(a.projectId);
    const fleetPolicy = { scopeKind: 'fleet', scopeId: fleet, policy: { mode: 'standing-policy' }, expectedVersion: 0, auth };
    const denied = c4.ratifyPolicy(db, { ...fleetPolicy, principalId: b.principalId });
    assert.equal(denied.code, 'SCOPE_DENIED');
    assert.equal(denied.detail, `project ${a.projectId}`);
    assert.equal(c4.ratifyPolicy(db, { ...fleetPolicy, scopeId: fleetOf(null), principalId: a.principalId }).code, 'FLEET_HAS_NO_MEMBER_PROJECTS');

    assert.equal(c4.ratifyPolicy(db, { ...fleetPolicy, principalId: a.principalId }).code, 'RATIFIED');
    assert.equal(c4.getEffectivePolicy(db, { projectId: a.projectId, fleetId: fleet }).scopeKind, 'fleet');
    c4.ratifyPolicy(db, { scopeKind: 'project', scopeId: a.projectId, policy: { mode: 'confirm' }, expectedVersion: 0, principalId: a.principalId, auth });
    const eff = c4.getEffectivePolicy(db, { projectId: a.projectId, fleetId: fleet });
    assert.deepEqual([eff.scopeKind, eff.policy.mode], ['project', 'confirm']);
  });

  it('a fleet policy never applies to a non-member project or one added after ratification (PRR-A R1 BLOCKING 1)', () => {
    const a = seed();
    const outsider = seed();
    const fleet = fleetOf(a.projectId);
    assert.equal(c4.ratifyPolicy(db, { scopeKind: 'fleet', scopeId: fleet, policy: { mode: 'standing-policy' }, expectedVersion: 0, principalId: a.principalId, auth }).code, 'RATIFIED');
    assert.equal(c4.getEffectivePolicy(db, { projectId: a.projectId, fleetId: fleet }).scopeKind, 'fleet');
    assert.equal(c4.getEffectivePolicy(db, { projectId: outsider.projectId, fleetId: fleet }), null, 'caller-supplied fleetId of a fleet the project is not in');

    // Move the outsider into the fleet AFTER ratification: still not covered.
    // (Drop its trigger-made legacy rows child-first, then re-home its
    // resource in the fleet's own logical project, as a C1 join would.)
    db.prepare('DELETE FROM v6_legacy_project_map WHERE legacy_project_id = ?').run(outsider.projectId);
    db.prepare('DELETE FROM v6_checkouts WHERE legacy_project_id = ?').run(outsider.projectId);
    db.prepare('DELETE FROM v6_resources WHERE legacy_project_id = ?').run(outsider.projectId);
    db.prepare('INSERT INTO v6_resources (id, logical_project_id, fleet_id, kind, display_name, legacy_project_id) VALUES (?,?,?,?,?,?)')
      .run(`res-joined-${outsider.projectId}`, `lp-${a.projectId}`, fleet, 'harness', 'joined', outsider.projectId);
    assert.equal(c4.getEffectivePolicy(db, { projectId: outsider.projectId, fleetId: fleet }), null, 'joined after ratification');

    // A ratified member that has since left the fleet loses it too.
    db.prepare('UPDATE v6_resources SET fleet_id = NULL WHERE legacy_project_id = ?').run(a.projectId);
    assert.equal(c4.getEffectivePolicy(db, { projectId: a.projectId, fleetId: fleet }), null, 'left the fleet');
  });

  it('records and lists a receipt carrying the exact trigger reason and requested target', () => {
    const { projectId } = seed();
    const decision = c4.decideFailover({ policy: standing(), role: 'Builder', trigger: 'provider-outage', current: CURRENT, validateTarget: okValidator });
    const r = c4.recordFailoverReceipt(db, { projectId, sessionId: 7, role: 'Builder', trigger: 'provider-outage', reasonCode: 'provider-5xx-outage', decision, from: CURRENT, policyVersion: 3 });
    assert.equal(r.code, 'RECORDED');
    const [row] = c4.listFailoverReceipts(db, projectId);
    assert.deepEqual([row.reasonCode, row.decision, row.switchMode, row.to.engine, row.sessionId, row.policyVersion], ['provider-5xx-outage', 'execute', 'outage-takeover', 'codex', '7', 3]);
    assert.equal(c4.recordFailoverReceipt(db, { projectId, role: 'Builder', trigger: 't', reasonCode: ' ', decision, from: CURRENT }).code, 'RECEIPT_INVALID');
  });
});

describe('D2 quota windows and placement (#2993, P04)', () => {
  const now = 100;
  const job = { id: 'job-1', approved: true, capabilities: ['code'], minQuality: 0.5 };
  const catalog = c4.resolveEngineCatalog(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [{ id: 'a', healthy: true, expiresAt: 500 }, { id: 'b', healthy: true, expiresAt: 500 }, { id: 'c', healthy: false, expiresAt: 500 }],
    now
  );
  const candidates = [
    { engineId: 'a', modelId: 'ma', accountId: 'one', selectable: true, quality: 0.9, capabilities: ['code'], relativeCost: 1 },
    { engineId: 'b', modelId: 'mb', accountId: 'one', selectable: true, quality: 0.85, capabilities: ['code'], relativeCost: 1 },
    { engineId: 'c', modelId: 'mc', accountId: 'one', selectable: true, quality: 0.99, capabilities: ['code'], relativeCost: 0.1 }
  ];
  const signal = (engineId, confidence = 'measured', remaining = 9) => ({ accountId: 'one', engineId, confidence, remaining, capacity: 10, resetAt: 200 });
  const schedule = (over = {}) => c4.recommendPlacement({ strategy: 'balanced', job, candidates, catalog, quota: [], now, ...over });

  it('catalog marks missing, unhealthy, stale and unsupported engines unavailable', () => {
    const rows = c4.resolveEngineCatalog([{ id: 'a' }, { id: 'b' }, { id: 'd' }],
      [{ id: 'a', healthy: true, expiresAt: 50 }, { id: 'b', healthy: false, expiresAt: 500 }, { id: 'x', healthy: true, expiresAt: 500 }], now);
    assert.deepEqual(rows.map((r) => [r.id, r.available, r.reason]), [
      ['a', false, 'STALE_INVENTORY'], ['b', false, 'UNHEALTHY'], ['d', false, 'NOT_INSTALLED'], ['x', false, 'UNSUPPORTED']
    ]);
  });

  it('quota windows: measured accepted, expired / over-capacity / unknown confidence rejected', () => {
    assert.equal(c4.normalizeQuotaWindow({ accountId: 'one', engineId: 'a', confidence: 'measured', remaining: 4, capacity: 10, resetAt: 200 }, now).remainingFraction, 0.4);
    assert.equal(c4.normalizeQuotaWindow({ ...signal('a'), resetAt: 100 }, now).usable, false);
    assert.equal(c4.normalizeQuotaWindow({ ...signal('a'), remaining: 11 }, now).usable, false);
    assert.equal(c4.normalizeQuotaWindow({ ...signal('a'), confidence: 'vibes' }, now).usable, false);
    assert.equal(c4.normalizeQuotaWindow({ ...signal('a'), confidence: '__proto__' }, now).usable, false);
  });

  it('an unavailable engine is never placed, however good or cheap', () => {
    assert.notEqual(schedule({ strategy: 'quality' }).selected.engineId, 'c');
    assert.notEqual(schedule({ strategy: 'conservation' }).selected.engineId, 'c');
  });

  it('unapproved work, unknown strategy and no eligible candidate are refused', () => {
    assert.equal(schedule({ job: { ...job, approved: false } }).code, 'NO_APPROVED_WORK');
    assert.equal(schedule({ strategy: 'random' }).code, 'UNKNOWN_STRATEGY');
    assert.equal(schedule({ job: { ...job, capabilities: ['vision'] } }).code, 'NO_ELIGIBLE_PLACEMENT');
  });

  it('maximize-useful-allowance prefers measured headroom; an estimate weighs less; stale quota has no effect', () => {
    assert.equal(schedule({ strategy: 'maximize-useful-allowance', quota: [signal('b', 'measured', 10)] }).selected.engineId, 'b');
    assert.equal(schedule({ strategy: 'maximize-useful-allowance', quota: [signal('b', 'estimate', 1)] }).selected.engineId, 'a');
    assert.equal(schedule({ strategy: 'maximize-useful-allowance', quota: [{ ...signal('b'), resetAt: 100 }] }).selected.engineId, 'a');
  });

  it('ties break deterministically by engine then model id', () => {
    const twins = [
      { engineId: 'b', modelId: 'm2', accountId: 'one', selectable: true, quality: 0.9, capabilities: ['code'] },
      { engineId: 'b', modelId: 'm1', accountId: 'one', selectable: true, quality: 0.9, capabilities: ['code'] }
    ];
    assert.equal(schedule({ candidates: twins }).selected.modelId, 'm1');
  });

  it('placeWork auto requires the effort to match the ratified tuple (PRR-A R1 BLOCKING 2)', () => {
    const quota = [signal('b', 'measured', 10)];
    const withEffort = candidates.map((c) => (c.engineId === 'b' ? { ...c, effort: 'max' } : c));
    const base = { mode: 'auto', strategy: 'maximize-useful-allowance', job, catalog, now, quota };
    const low = standing({ allowedAutoPlacements: [{ engine: 'b', model: 'mb', effort: 'low' }] });
    assert.equal(c4.placeWork({ ...base, candidates: withEffort, policy: low }).code, 'AUTO_NOT_PERMITTED', 'b/mb/max must not ride a b/mb/low grant');
    assert.equal(c4.placeWork({ ...base, candidates, policy: low }).code, 'AUTO_NOT_PERMITTED', 'no stated effort must not ride a b/mb/low grant');
    const max = standing({ allowedAutoPlacements: [{ engine: 'b', model: 'mb', effort: 'max' }] });
    assert.equal(c4.placeWork({ ...base, candidates: withEffort, policy: max }).code, 'AUTO_APPLIED');
    assert.equal(c4.placeWork({ ...base, candidates: withEffort, policy: standing() }).code, 'AUTO_NOT_PERMITTED', 'an effort-less grant does not cover b/mb/max');
  });

  it('placeWork recommend never auto-applies', () => {
    const out = c4.placeWork({ mode: 'recommend', strategy: 'balanced', job, candidates, catalog, now, policy: standing() });
    assert.deepEqual([out.code, out.autoApply], ['RECOMMENDED', false]);
  });

  it('placeWork auto applies only an allowlisted tuple with a known quota reading, under a standing policy', () => {
    const base = { mode: 'auto', strategy: 'maximize-useful-allowance', job, candidates, catalog, now };
    const quota = [signal('b', 'measured', 10)];
    assert.deepEqual([c4.placeWork({ ...base, quota, policy: standing() }).code, c4.placeWork({ ...base, quota, policy: standing() }).autoApply], ['AUTO_APPLIED', true]);
    assert.equal(c4.placeWork({ ...base, quota, policy: null }).code, 'AUTO_NOT_PERMITTED');
    assert.equal(c4.placeWork({ ...base, quota, policy: c4.validatePolicy({ mode: 'confirm', allowedAutoPlacements: [{ engine: 'b', model: 'mb' }] }).policy }).code, 'AUTO_NOT_PERMITTED');
    assert.equal(c4.placeWork({ ...base, quota: [], strategy: 'balanced', policy: standing({ allowedAutoPlacements: [{ engine: 'a', model: 'ma' }] }) }).code, 'AUTO_QUOTA_UNKNOWN');
    assert.equal(c4.placeWork({ ...base, mode: 'yolo', policy: standing() }).code, 'UNKNOWN_PLACEMENT_MODE');
  });
});
