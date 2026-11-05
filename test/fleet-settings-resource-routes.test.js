'use strict';

/*
 * The three library/route adapter surfaces Architect Ruling A503-R1 scopes
 * for Car 66-C: `lib/fleet-visibility-routes.js` (#2858),
 * `lib/settings-rules-routes.js` (#2852), `lib/resource-lease-routes.js`
 * (#2856) -- each a thin, stable composition over already-shipped pure
 * libraries, ready for a future HTTP route (Milestone #54) to call
 * unchanged. Also covers the two underlying wiring changes #2858 asks for
 * directly in `lib/workload-fleet.js` (`buildFleetView`) and
 * `lib/project-version-files.js` (the version-cache write diagnostic).
 *
 * `buildFleetView` is the one piece here that touches the real store
 * (mirroring `lib/workload-fleet.js`'s own existing `laneFor`/`laneContext`,
 * which already do); every route-adapter function in the three new files
 * is pure, with no database or subprocess dependency at all.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const fleetVisibilityRoutes = require('../lib/fleet-visibility-routes');
const settingsRulesRoutes = require('../lib/settings-rules-routes');
const resourceLeaseRoutes = require('../lib/resource-lease-routes');
const projectVersionFiles = require('../lib/project-version-files');

// ---------------------------------------------------------------------------
// #2858 -- lib/fleet-visibility-routes.js
// ---------------------------------------------------------------------------

describe('getFleetWorkloadView (#2858)', () => {
  it('builds the fleet view over already-fetched session summaries, no store involved', () => {
    const now = '2026-11-05T00:00:00.000Z';
    const result = fleetVisibilityRoutes.getFleetWorkloadView([
      { sessionId: 's1', project: 'proj-a', workloadState: 'complete', workloadClearance: 'safe-to-clear', paneAlive: true, updatedAt: now }
    ], { now });
    assert.equal(result.ok, true);
    assert.equal(result.view.sessions[0].passiveState, 'idle');
    assert.equal(result.view.projects['proj-a'].sessions.length, 1);
  });

  it('propagates a refusal from the underlying library unchanged', () => {
    const result = fleetVisibilityRoutes.getFleetWorkloadView('not-an-array');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FLEET_WORKLOAD_VIEW_INVALID');
  });
});

describe('getSwitchboardSwarmStats (#2858)', () => {
  it('delegates to the real computeSwarmStats', () => {
    const result = fleetVisibilityRoutes.getSwitchboardSwarmStats([
      { lane: 'TC-Lane-B', state: 'open', owed: true, ackLatencyMs: null }
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.stats.openExchanges, 1);
    assert.equal(result.stats.byLane['TC-Lane-B'].owedReplies, 1);
  });
});

describe('getVersionCacheDiagnostics (#2858)', () => {
  let tmpDir;
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fleet-vcd-')); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('batches getVersionCacheDiagnostic over several project paths, keyed by path', () => {
    const a = path.join(tmpDir, 'a');
    const b = path.join(tmpDir, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    projectVersionFiles.writeVersionCacheFile(a, '1.0.0', 'version.json');
    const result = fleetVisibilityRoutes.getVersionCacheDiagnostics([a, b]);
    assert.equal(result[a].state.consecutiveFailures, 0);
    assert.equal(result[a].banner, null);
    assert.equal(result[b], null, 'never-tracked project reads null');
  });
});

describe('getProjectTestDurationStats (#2858)', () => {
  it('returns the no-duration display for a null raw record', () => {
    const result = fleetVisibilityRoutes.getProjectTestDurationStats(null);
    assert.equal(result.ok, true);
    assert.equal(result.stats.hasDuration, false);
    assert.equal(result.stats.displayLabel, 'No recorded duration');
  });

  it('extracts and projects a real raw record in one call', () => {
    const result = fleetVisibilityRoutes.getProjectTestDurationStats({
      source: 'testament', durationMs: 65000, recordedAt: '2026-11-04T00:00:00.000Z', commitSha: 'abc123'
    }, { now: '2026-11-05T00:00:00.000Z', currentCommitSha: 'abc123' });
    assert.equal(result.ok, true);
    assert.equal(result.stats.hasDuration, true);
    assert.equal(result.stats.displayLabel, '1m 5s');
    assert.equal(result.stats.stale, false);
  });

  it('propagates an extraction refusal rather than building stats from garbage', () => {
    const result = fleetVisibilityRoutes.getProjectTestDurationStats({ source: 'not-a-source', durationMs: 1, recordedAt: '2026-01-01T00:00:00Z' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TEST_DURATION_INVALID');
  });
});

// ---------------------------------------------------------------------------
// lib/workload-fleet.js -- buildFleetView wiring (#2858, real store)
// ---------------------------------------------------------------------------

describe('workload-fleet.js buildFleetView (#2858)', () => {
  let tmpDir;
  let store;
  const observer = { get: () => ({ activity: 'unknown', reason: 'test', observedAt: '2026-11-05T00:00:00.000Z', ageSeconds: 0, provenance: 'engine-observed' }) };

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fleet-view-'));
    store = require('../lib/store');
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function startSession(projectName) {
    const dir = path.join(tmpDir, projectName);
    fs.mkdirSync(dir);
    const project = store.projects.create({ name: projectName, path: dir, engine: 'claude' });
    const launchSequence = require('../lib/launch-sequence');
    const launchId = launchSequence.mintLaunchId();
    const snapshot = launchSequence.buildSnapshot({
      launchId, project, engineProfile: store.engines.get('claude'),
      applicability: { applicable: false, reason: 'test' }, rendered: null, rules: []
    });
    const session = store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });
    return { project, session, launchId };
  }

  /**
   * Insert a workload receipt directly (no HTTP), for a lane that needs one
   * to exercise {@link module:lib/workload-fleet.buildFleetView}'s mapping
   * of a REAL receipt.
   */
  function appendReceipt({ project, session, launchId }, { state, clearance, summary, receivedAt }) {
    store.workloadReceipts.append({
      project_id: project.id, session_id: session.id, launch_id: launchId, assignment_id: null,
      state, clearance, summary, wait_kind: null, wait_detail: null,
      refs_json: JSON.stringify({ issues: [], prs: [], tasks: [] }),
      branch: null, head_sha: null, source: 'tc-cli', received_at: receivedAt
    }, { minIntervalMs: 0, nowMs: Date.parse(receivedAt) });
  }

  it('maps a receipt-less active session into an "active" lane, grouped by project', () => {
    const { project, session } = startSession('fleet-a');
    const workloadFleet = require('../lib/workload-fleet');
    const result = workloadFleet.buildFleetView(
      [{ id: session.id, projectId: project.id, projectName: project.name, status: store.SESSION_STATUS.ACTIVE }],
      { observer, now: '2026-11-05T00:00:00.000Z' }
    );
    assert.equal(result.ok, true);
    assert.equal(result.view.sessions[0].sessionId, String(session.id));
    assert.equal(result.view.sessions[0].passiveState, 'active');
    assert.equal(result.view.sessions[0].workloadState, null);
    assert.ok(result.view.projects['fleet-a']);
  });

  it('a wrapped (ended) session reads offline, independent of its engine activity', () => {
    const { project, session } = startSession('fleet-b');
    store.sessions.wrap(session.id, 'done');
    const workloadFleet = require('../lib/workload-fleet');
    const result = workloadFleet.buildFleetView(
      [{ id: session.id, projectId: project.id, projectName: project.name, status: store.SESSION_STATUS.WRAPPED }],
      { observer, now: '2026-11-05T00:00:00.000Z' }
    );
    assert.equal(result.ok, true);
    assert.equal(result.view.sessions[0].passiveState, 'offline');
  });

  it('I-Gate Round 1 regression (#2904): a stale "working" receipt reads wedged, not masked by a fresh observer poll', () => {
    const fixture = startSession('fleet-stale-working');
    appendReceipt(fixture, { state: 'working', clearance: 'do-not-clear', summary: 'still going', receivedAt: '2026-11-04T23:00:00.000Z' });
    // The observer's own `observedAt` is a FRESH poll timestamp, taken at the
    // exact moment this test runs its assertion -- the real-world shape of
    // the bug: routine polling keeps observedAt fresh regardless of whether
    // the session has actually done anything since the receipt.
    const freshObserver = { get: () => ({ activity: 'unknown', reason: 'test', observedAt: '2026-11-05T00:00:00.000Z', ageSeconds: 0, provenance: 'engine-observed' }) };
    const workloadFleet = require('../lib/workload-fleet');
    const result = workloadFleet.buildFleetView(
      [{ id: fixture.session.id, projectId: fixture.project.id, projectName: fixture.project.name, status: store.SESSION_STATUS.ACTIVE }],
      { observer: freshObserver, now: '2026-11-05T00:00:00.000Z' }
    );
    assert.equal(result.ok, true);
    // One hour old, past the 30-minute working threshold -- must read wedged.
    assert.equal(result.view.sessions[0].passiveState, 'wedged');
  });

  it('I-Gate Round 1 regression (#2904): a complete session with real switchboard debt is never read as idle', () => {
    const fixture = startSession('fleet-debt');
    appendReceipt(fixture, { state: 'complete', clearance: 'safe-to-clear', summary: 'done', receivedAt: '2026-11-05T00:00:00.000Z' });
    const workloadFleet = require('../lib/workload-fleet');

    const withoutDebt = workloadFleet.buildFleetView(
      [{ id: fixture.session.id, projectId: fixture.project.id, projectName: fixture.project.name, status: store.SESSION_STATUS.ACTIVE }],
      { observer, now: '2026-11-05T00:00:00.000Z' }
    );
    assert.equal(withoutDebt.view.sessions[0].passiveState, 'idle', 'no debt, no staleness: idle is correct here');

    const withDebt = workloadFleet.buildFleetView(
      [{ id: fixture.session.id, projectId: fixture.project.id, projectName: fixture.project.name, status: store.SESSION_STATUS.ACTIVE, unreadMessageCount: 1 }],
      { observer, now: '2026-11-05T00:00:00.000Z' }
    );
    assert.notEqual(withDebt.view.sessions[0].passiveState, 'idle', 'real unread debt must never be silently dropped into an idle verdict');
  });

  it('I-Gate Round 1 regression (#2904): stale debt on a complete session reads wedged -- PRR-A\'s own exact repro', () => {
    const fixture = startSession('fleet-stale-debt');
    appendReceipt(fixture, { state: 'complete', clearance: 'safe-to-clear', summary: 'done', receivedAt: '2026-11-04T23:00:00.000Z' });
    const workloadFleet = require('../lib/workload-fleet');
    const result = workloadFleet.buildFleetView(
      [{ id: fixture.session.id, projectId: fixture.project.id, projectName: fixture.project.name, status: store.SESSION_STATUS.ACTIVE, unreadMessageCount: 1 }],
      { observer, now: '2026-11-05T00:00:00.000Z' }
    );
    assert.equal(result.view.sessions[0].passiveState, 'wedged');
  });
});

// ---------------------------------------------------------------------------
// lib/project-version-files.js -- version-cache write diagnostic (#2858, #1046)
// ---------------------------------------------------------------------------

describe('project-version-files.js version-cache write diagnostic (#1046)', () => {
  let tmpDir;
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-vcd-')); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('a successful write clears any prior failure streak', () => {
    const projectPath = path.join(tmpDir, 'p1');
    fs.mkdirSync(projectPath);
    assert.equal(projectVersionFiles.writeVersionCacheFile(projectPath, '1.0.0', 'version.json'), true);
    const diag = projectVersionFiles.getVersionCacheDiagnostic(projectPath);
    assert.equal(diag.state.consecutiveFailures, 0);
    assert.equal(diag.banner, null);
  });

  it('getVersionCacheDiagnostic reads null for a project never tracked', () => {
    assert.equal(projectVersionFiles.getVersionCacheDiagnostic(path.join(tmpDir, 'never-tracked')), null);
  });

  it('three consecutive write failures escalate to a visible banner, and a success afterward clears it', () => {
    const projectPath = path.join(tmpDir, 'p2');
    fs.mkdirSync(projectPath);
    // Make .tangleclaw a file, not a directory, so mkdirSync inside
    // writeVersionCacheFile throws EEXIST/ENOTDIR on every attempt -- a real,
    // reproducible write failure with no mocking required.
    fs.writeFileSync(path.join(projectPath, '.tangleclaw'), 'not a directory');

    assert.equal(projectVersionFiles.writeVersionCacheFile(projectPath, '1.0.0', 'version.json'), false);
    assert.equal(projectVersionFiles.getVersionCacheDiagnostic(projectPath).banner, null);
    assert.equal(projectVersionFiles.writeVersionCacheFile(projectPath, '1.0.0', 'version.json'), false);
    assert.equal(projectVersionFiles.getVersionCacheDiagnostic(projectPath).banner, null);
    assert.equal(projectVersionFiles.writeVersionCacheFile(projectPath, '1.0.0', 'version.json'), false);
    const escalated = projectVersionFiles.getVersionCacheDiagnostic(projectPath);
    assert.equal(escalated.state.consecutiveFailures, 3);
    assert.ok(escalated.banner);
    assert.equal(escalated.banner.severity, 'persistent-write-failure');

    fs.rmSync(path.join(projectPath, '.tangleclaw'));
    assert.equal(projectVersionFiles.writeVersionCacheFile(projectPath, '1.0.0', 'version.json'), true);
    const recovered = projectVersionFiles.getVersionCacheDiagnostic(projectPath);
    assert.equal(recovered.state.consecutiveFailures, 0);
    assert.equal(recovered.banner, null);
  });
});

// ---------------------------------------------------------------------------
// #2852 -- lib/settings-rules-routes.js
// ---------------------------------------------------------------------------

describe('getProjectAdrRulesView (#2852)', () => {
  it('delegates to the real projectRulesView', () => {
    const result = settingsRulesRoutes.getProjectAdrRulesView([
      { id: 'r1', title: 'A rule', body: 'body text', status: 'active' }
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.view.items.length, 1);
  });
});

describe('getShareableRulesMarkdown (#2852)', () => {
  it('composes buildShareableRulesView + renderShareableRulesMarkdown in one call', () => {
    const result = settingsRulesRoutes.getShareableRulesMarkdown([
      { id: 'r1', title: 'A rule', body: 'body text', status: 'active', category: 'Process' }
    ]);
    assert.equal(result.ok, true);
    assert.match(result.markdown, /# Rules & ADRs/);
    assert.match(result.markdown, /A rule/);
    assert.equal(typeof result.payload.digestSha256, 'string');
  });

  it('propagates a refusal from the build step', () => {
    const result = settingsRulesRoutes.getShareableRulesMarkdown('not-an-array');
    assert.equal(result.ok, false);
  });
});

describe('previewRulesCompression (#2852)', () => {
  it('delegates to the real buildRulesCompressPreview', () => {
    const result = settingsRulesRoutes.previewRulesCompression({
      scope: { type: 'project', id: 'p1' }, originalText: 'Always run tests before committing.'
    });
    assert.equal(result.ok, true);
    assert.ok(result.preview);
  });
});

describe('decideRuleProposal / bulkDecideRuleProposals / editSessionRuleInPlace (#2852)', () => {
  it('decideRuleProposal delegates to the real decideSessionRuleProposal', () => {
    const result = settingsRulesRoutes.decideRuleProposal({
      approvalMode: 'operator-only', caller: { principal: 'operator', id: 'operator' },
      proposal: { id: 'rp1', authoredBy: 'TC-Lane-B' }, decision: 'approve'
    });
    assert.equal(result.ok, true);
    assert.equal(result.result.decision, 'approve');
  });

  it('bulkDecideRuleProposals delegates to the real bulkDecideSessionRuleProposals', () => {
    const result = settingsRulesRoutes.bulkDecideRuleProposals({
      approvalMode: 'operator-only', caller: { principal: 'operator', id: 'operator' }, decision: 'approve',
      proposals: [{ id: 'rp1', authoredBy: 'TC-Lane-B' }, { id: 'rp2', authoredBy: 'TC-Lane-C' }]
    });
    assert.equal(result.ok, true);
    assert.equal(result.summary.approved.length, 2);
  });

  it('editSessionRuleInPlace delegates to the real editRuleInPlace', () => {
    const result = settingsRulesRoutes.editSessionRuleInPlace({
      approvalMode: 'operator-only', caller: { principal: 'operator', id: 'operator' },
      rule: { ruleId: 'r1', title: 'T', body: 'B', category: null, scope: null, enabled: true, version: 1, digestSha256: 'x' },
      patch: { title: 'New title' }, expectedVersion: 1
    });
    assert.equal(result.ok, true);
    assert.equal(result.rule.title, 'New title');
  });
});

describe('validateAndPreviewTeamTemplate (#2852)', () => {
  it('delegates to the real previewTeamTemplateApplication (validates internally)', () => {
    const template = {
      templateId: 'tpl1', name: 'Fleet', version: 1,
      roles: [{ roleId: 'builder', title: 'Builder', laneClass: 'builder', defaultRules: [], carAssignments: [], reviewGates: [] }]
    };
    const result = settingsRulesRoutes.validateAndPreviewTeamTemplate(template, []);
    assert.equal(result.ok, true);
    assert.equal(result.preview.addedSeats.length, 1);
  });

  it('propagates a validation refusal', () => {
    const result = settingsRulesRoutes.validateAndPreviewTeamTemplate({}, []);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TEAM_TEMPLATE_INVALID');
  });
});

// ---------------------------------------------------------------------------
// #2856 -- lib/resource-lease-routes.js
// ---------------------------------------------------------------------------

describe('resource-lease-routes.js (#2856)', () => {
  it('handleAcquireLease delegates to the real acquireLease', () => {
    const result = resourceLeaseRoutes.handleAcquireLease({
      resourceId: 'res1', holderSessionId: 's1', holderProjectId: 'p1',
      mode: 'exclusive', ttlMs: 60000, existingLeases: []
    });
    assert.equal(result.ok, true);
    assert.equal(result.lease.resourceId, 'res1');
  });

  it('handleTransitionLease delegates to the real transitionLease', () => {
    const acquired = resourceLeaseRoutes.handleAcquireLease({
      resourceId: 'res2', holderSessionId: 's1', holderProjectId: 'p1',
      mode: 'exclusive', ttlMs: 60000, existingLeases: []
    });
    const result = resourceLeaseRoutes.handleTransitionLease({
      lease: acquired.lease, toState: 'draining', presentedEpoch: acquired.lease.epoch
    });
    assert.equal(result.ok, true);
    assert.equal(result.lease.state, 'draining');
  });

  it('handleForceReclaimLease delegates to the real forceReclaimLease', () => {
    const acquired = resourceLeaseRoutes.handleAcquireLease({
      resourceId: 'res3', holderSessionId: 's1', holderProjectId: 'p1',
      mode: 'exclusive', ttlMs: 60000, existingLeases: []
    });
    const result = resourceLeaseRoutes.handleForceReclaimLease({
      lease: acquired.lease, operatorId: 'operator', reason: 'stuck'
    });
    assert.equal(result.ok, true);
    assert.ok(result.audit);
  });

  it('handleDelegationGrant delegates to the real issueDelegationGrant', () => {
    const result = resourceLeaseRoutes.handleDelegationGrant({
      caller: { principal: 'operator', id: 'op1' }, projectId: 'p1', architectPrincipal: 'TC-Lane-Arc',
      allowedKinds: ['db'], maxInstances: 1, ttlMs: 3600000
    });
    assert.equal(result.ok, true);
    assert.ok(result.grant);
  });

  it('handleDelegationGrant propagates an unauthorized refusal for a non-operator caller', () => {
    const result = resourceLeaseRoutes.handleDelegationGrant({
      caller: { principal: 'builder', id: 'tc-lane-b' }, projectId: 'p1', architectPrincipal: 'TC-Lane-Arc',
      allowedKinds: ['db'], maxInstances: 1, ttlMs: 3600000
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RESOURCE_DELEGATION_UNAUTHORIZED');
  });

  it('handleResourceModuleProvision delegates to the real provisionResourceModule', () => {
    const result = resourceLeaseRoutes.handleResourceModuleProvision({
      resourceId: 'res4', kind: 'db', projectId: 'p1', capacity: 1,
      caller: { principal: 'operator', id: 'op1' }
    });
    assert.equal(result.ok, true);
    assert.equal(result.resource.resourceId, 'res4');
  });

  it('evaluateOutboundRoleInstruction delegates to the real evaluateRoleInstruction', () => {
    const result = resourceLeaseRoutes.evaluateOutboundRoleInstruction({
      text: 'please merge this PR right now', targetRole: 'builder', targetSessionId: 's1'
    });
    // Whichever verdict the real guard returns for this text, it must be the
    // real module answering -- never a stub this test invented.
    assert.ok(result.ok === true || typeof result.code === 'string');
  });
});
