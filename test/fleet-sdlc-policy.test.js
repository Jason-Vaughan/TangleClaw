'use strict';

// #3265 (V6-016) — configurable per-fleet SDLC workflow enforcement. Pure
// logic; no network, no filesystem, no GitHub calls.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../lib/fleet-sdlc-policy');

describe('resolveFleetSdlcPolicy', () => {
  it('defaults to github + requireRoadmapTriage when nothing is configured', () => {
    const r = policy.resolveFleetSdlcPolicy(null);
    assert.deepEqual(r.policy, { issueBackend: 'github', requireRoadmapTriage: true });
    assert.equal(r.source, 'default');
    assert.equal(r.warning, null);
  });

  it('reads fleetSdlcPolicy off the given project config', () => {
    const cfg = { fleetSdlcPolicy: { issueBackend: 'local', requireRoadmapTriage: false } };
    const r = policy.resolveFleetSdlcPolicy(cfg);
    assert.deepEqual(r.policy, { issueBackend: 'local', requireRoadmapTriage: false });
    assert.equal(r.source, 'project-config');
  });

  it('an explicit option wins over the project config', () => {
    const cfg = { fleetSdlcPolicy: { issueBackend: 'local', requireRoadmapTriage: false } };
    const r = policy.resolveFleetSdlcPolicy(cfg, { fleetSdlcPolicy: { issueBackend: 'none', requireRoadmapTriage: false } });
    assert.deepEqual(r.policy, { issueBackend: 'none', requireRoadmapTriage: false });
    assert.equal(r.source, 'explicit');
  });

  it('falls back to the default with a warning on an unrecognized issueBackend, never throws', () => {
    const cfg = { fleetSdlcPolicy: { issueBackend: 'jira', requireRoadmapTriage: true } };
    const r = policy.resolveFleetSdlcPolicy(cfg);
    assert.deepEqual(r.policy, policy.DEFAULT_FLEET_SDLC_POLICY);
    assert.equal(r.source, 'default');
    assert.match(r.warning, /unrecognized fleetSdlcPolicy/);
  });

  it('falls back to the default with a warning on a malformed explicit override', () => {
    const r = policy.resolveFleetSdlcPolicy(null, { fleetSdlcPolicy: { issueBackend: 'github' } });
    assert.deepEqual(r.policy, policy.DEFAULT_FLEET_SDLC_POLICY);
    assert.equal(r.source, 'default');
    assert.match(r.warning, /invalid explicit fleetSdlcPolicy/);
  });

  it('a project config with no fleetSdlcPolicy field at all is just "nothing configured"', () => {
    const r = policy.resolveFleetSdlcPolicy({ engine: 'claude' });
    assert.equal(r.source, 'default');
    assert.equal(r.warning, null);
  });
});

describe('validateFleetSdlcPolicy', () => {
  it('accepts every recognized issueBackend', () => {
    for (const issueBackend of policy.ISSUE_BACKENDS) {
      assert.doesNotThrow(() => policy.validateFleetSdlcPolicy({ issueBackend, requireRoadmapTriage: true }));
    }
  });

  it('rejects a non-object, a bad issueBackend, and a non-boolean requireRoadmapTriage', () => {
    assert.throws(() => policy.validateFleetSdlcPolicy(null), policy.FleetSdlcPolicyError);
    assert.throws(() => policy.validateFleetSdlcPolicy([]), policy.FleetSdlcPolicyError);
    assert.throws(() => policy.validateFleetSdlcPolicy({ issueBackend: 'jira', requireRoadmapTriage: true }), policy.FleetSdlcPolicyError);
    assert.throws(() => policy.validateFleetSdlcPolicy({ issueBackend: 'github', requireRoadmapTriage: 'yes' }), policy.FleetSdlcPolicyError);
  });
});

describe('evaluateCarAdmission', () => {
  const GITHUB_STRICT = { issueBackend: 'github', requireRoadmapTriage: true };
  const GITHUB_LOOSE = { issueBackend: 'github', requireRoadmapTriage: false };
  const LOCAL = { issueBackend: 'local', requireRoadmapTriage: false };
  const NONE = { issueBackend: 'none', requireRoadmapTriage: false };

  it('"none" admits a car with zero issues at all, no gate applies', () => {
    const r = policy.evaluateCarAdmission(NONE, { issues: [] });
    assert.equal(r.admitted, true);
    assert.deepEqual(r.reasons, []);
  });

  it('"local" and "github" both refuse a car with no tracked issues', () => {
    for (const p of [LOCAL, GITHUB_LOOSE]) {
      const r = policy.evaluateCarAdmission(p, { issues: [] });
      assert.equal(r.admitted, false);
      assert.ok(r.reasons.some((s) => s.includes('no tracked issue')));
    }
  });

  it('"local" admits any non-empty issue reference, no roadmap-triage check even if requested', () => {
    const r = policy.evaluateCarAdmission({ issueBackend: 'local', requireRoadmapTriage: true }, { issues: ['local-ticket-1'] });
    assert.equal(r.admitted, true);
  });

  it('"github" without requireRoadmapTriage admits any non-empty issue list', () => {
    const r = policy.evaluateCarAdmission(GITHUB_LOOSE, { issues: ['#3265'] });
    assert.equal(r.admitted, true);
  });

  it('"github" with requireRoadmapTriage refuses an issue not in the triaged set', () => {
    const r = policy.evaluateCarAdmission(GITHUB_STRICT, { issues: ['#3265', '#9999'], triagedIssues: ['#3265'] });
    assert.equal(r.admitted, false);
    assert.ok(r.reasons.some((s) => s.includes('#9999')));
    assert.ok(!r.reasons.some((s) => s.includes('#3265')), 'the triaged issue must not also be named as a reason');
  });

  it('"github" with requireRoadmapTriage admits once every issue is triaged (TC-Lane\'s own default shape)', () => {
    const r = policy.evaluateCarAdmission(GITHUB_STRICT, { issues: ['#3270', '#3276'], triagedIssues: ['#3270', '#3276'] });
    assert.equal(r.admitted, true);
    assert.deepEqual(r.reasons, []);
  });

  it('treats a missing triagedIssues as "nothing triaged", not as "skip the check"', () => {
    const r = policy.evaluateCarAdmission(GITHUB_STRICT, { issues: ['#1'] });
    assert.equal(r.admitted, false);
    assert.ok(r.reasons.some((s) => s.includes('#1')));
  });

  it('reports every failing reason in one pass rather than stopping at the first', () => {
    const r = policy.evaluateCarAdmission(GITHUB_STRICT, { issues: [] });
    assert.equal(r.admitted, false);
    assert.ok(r.reasons.some((s) => s.includes('no tracked issue')));
  });

  it('refuses malformed inputs rather than silently admitting them', () => {
    assert.throws(() => policy.evaluateCarAdmission({ issueBackend: 'jira', requireRoadmapTriage: true }, { issues: [] }), policy.FleetSdlcPolicyError);
    assert.throws(() => policy.evaluateCarAdmission(NONE, { issues: 'not-an-array' }), policy.FleetSdlcPolicyError);
    assert.throws(() => policy.evaluateCarAdmission(NONE, null), policy.FleetSdlcPolicyError);
  });
});
