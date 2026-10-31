'use strict';

/*
 * Governed model/engine switch (#2598): target validation through
 * `lib/engine-models.js`, the boundary-mode safety gate (clearance, inbox,
 * git), the outage-takeover recovery path (worktree snapshot + termination),
 * and the decider-outage escalation check. Every production side effect
 * (session refresh, kill, git) is exercised through an injected fake here —
 * nothing in this file starts tmux, touches the real database, or runs `git`
 * against a repo it did not create itself in a temp directory.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { initRepo } = require('./_temp-repo');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const modelSwitch = require('../lib/model-switch');

describe('lib/model-switch — validateSwitchTarget', () => {
  it('refuses a malformed engine id', () => {
    const result = modelSwitch.validateSwitchTarget({ engine: 'not/an/id', model: 'claude-sonnet-5' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ENGINE_MALFORMED');
  });

  it('refuses a malformed model id', () => {
    const result = modelSwitch.validateSwitchTarget({ engine: 'claude', model: '--not-a-model' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MODEL_MALFORMED');
  });

  it('refuses an unknown engine', () => {
    const result = modelSwitch.validateSwitchTarget(
      { engine: 'nonexistent-engine', model: 'claude-sonnet-5' },
      { getEngineProfile: () => null }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ENGINE_UNKNOWN');
  });

  it('refuses when the engine profile declares no models block', () => {
    const result = modelSwitch.validateSwitchTarget(
      { engine: 'bare-engine', model: 'claude-sonnet-5' },
      { getEngineProfile: () => ({ id: 'bare-engine', name: 'Bare' }) }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ENGINE_HAS_NO_MODELS');
  });

  it('refuses a model not on the engine\'s offered list', () => {
    const profile = {
      id: 'fake', name: 'Fake',
      models: { flag: '--model', offered: ['claude-sonnet-5'], roster: { source: 'codex-models-cache' } }
    };
    const result = modelSwitch.validateSwitchTarget(
      { engine: 'fake', model: 'claude-opus-5-5' },
      { getEngineProfile: () => profile }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MODEL_NOT_OFFERED');
  });

  it('refuses when the installed CLI\'s roster cannot be read', () => {
    const profile = {
      id: 'fake', name: 'Fake',
      models: { flag: '--model', offered: ['claude-sonnet-5'], roster: { source: 'codex-models-cache' } }
    };
    const result = modelSwitch.validateSwitchTarget(
      { engine: 'fake', model: 'claude-sonnet-5' },
      { getEngineProfile: () => profile, readFile: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ROSTER_UNAVAILABLE');
  });

  it('accepts an offered model the installed CLI\'s roster actually lists', () => {
    const profile = {
      id: 'fake', name: 'Fake',
      models: { flag: '--model', offered: ['claude-sonnet-5'], roster: { source: 'codex-models-cache' } }
    };
    const fakeCache = JSON.stringify({ fetched_at: new Date().toISOString(), models: [{ slug: 'claude-sonnet-5', display_name: 'Sonnet' }] });
    const result = modelSwitch.validateSwitchTarget(
      { engine: 'fake', model: 'claude-sonnet-5' },
      { getEngineProfile: () => profile, readFile: () => fakeCache }
    );
    assert.equal(result.ok, true);
  });
});

describe('lib/model-switch — switchSessionModel', () => {
  let tmpDir;
  let projectPath;
  let project;

  const target = () => ({
    getEngineProfile: () => ({
      id: 'fake', name: 'Fake',
      models: { flag: '--model', offered: ['claude-sonnet-5'], roster: { source: 'codex-models-cache' } }
    }),
    readFile: () => JSON.stringify({ fetched_at: new Date().toISOString(), models: [{ slug: 'claude-sonnet-5', display_name: 'Sonnet' }] })
  });

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-model-switch-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-model-switch-project-'));
    project = store.projects.create({ name: `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`, path: projectPath });
  });

  it('refuses before touching anything when target validation fails', async () => {
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'not/valid', model: 'claude-sonnet-5' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ENGINE_MALFORMED');
  });

  it('refuses an unknown project', async () => {
    const result = await modelSwitch.switchSessionModel('no-such-project', { engine: 'fake', model: 'claude-sonnet-5' }, target());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PROJECT_NOT_FOUND');
  });

  it('refuses boundary mode when there is no active session', async () => {
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5' }, target());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_ACTIVE_SESSION');
  });

  it('refuses boundary mode when the boundary check finds blockers, and touches nothing', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    let refreshCalled = false;
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: false, blockers: ['git worktree is not clean'], details: {} }),
      refreshSession: () => { refreshCalled = true; }
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SESSION_NOT_AT_BOUNDARY');
    assert.deepEqual(result.blockers, ['git worktree is not clean']);
    assert.equal(refreshCalled, false);
    assert.equal(store.projects.get(project.id).engineId, 'claude');
  });

  it('switches (cross-provider relaunch), refreshes the session, and persists engine/model when at boundary', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    let refreshArgs = null;
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5', effort: 'high' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      refreshSession: (p, s) => { refreshArgs = { projectName: p.name }; }
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'boundary');
    assert.equal(result.sameProvider, false); // project was on 'claude', target engine is 'fake'
    assert.deepEqual(refreshArgs, { projectName: project.name });
    assert.equal(store.projects.get(project.id).engineId, 'fake');
    const savedConfig = store.projectConfig.load(projectPath);
    assert.equal(savedConfig.model, 'claude-sonnet-5');
    // effort has no persisted field (#2188's schema has none) — only the
    // live reconciler sees it, and this is the cross-provider (relaunch)
    // path, which never touches the reconciler at all.
    assert.equal(savedConfig.effort, undefined);
  });

  it('persists the new config BEFORE refreshing the session, so an interrupted refresh never leaves the old config behind', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    let engineIdWhenRefreshRan = null;
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      refreshSession: () => { engineIdWhenRefreshRan = store.projects.get(project.id).engineId; }
    });
    assert.equal(result.ok, true);
    assert.equal(engineIdWhenRefreshRan, 'fake', 'the project row must already carry the new engine by the time refresh runs');
  });

  it('same-provider: reconciles the live session through lib/profile-reconciler instead of relaunching', async () => {
    const session = store.sessions.start({ projectId: project.id, engineId: 'fake', tmuxSession: 'the-tmux-name', primePrompt: null });
    store.projects.update(project.id, { engine_id: 'fake' });
    let setArgs = null;
    let checkpointArgs = null;
    let reconcileArgs = null;
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5', effort: 'high' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      setDesiredProfile: (id, profile) => { setArgs = { id, profile }; },
      recordCheckpoint: (id, receipt) => { checkpointArgs = { id, receipt }; },
      reconcile: (id, tmuxSession, rdeps) => { reconcileArgs = { id, tmuxSession, rdeps }; return { ok: true, state: 'verified' }; }
    });
    assert.equal(result.ok, true);
    assert.equal(result.sameProvider, true);
    assert.deepEqual(setArgs, { id: `session:${session.id}`, profile: { engine: 'fake', model: 'claude-sonnet-5', effort: 'high' } });
    assert.equal(checkpointArgs.id, `session:${session.id}`);
    assert.equal(checkpointArgs.receipt.safeToClear, true);
    assert.equal(checkpointArgs.receipt.generation, session.id);
    assert.equal(reconcileArgs.id, `session:${session.id}`);
    assert.equal(reconcileArgs.tmuxSession, 'the-tmux-name');
    assert.equal(reconcileArgs.rdeps.currentGeneration, session.id);
  });

  it('same-provider: refuses when the reconciler cannot verify the live profile, but the config stays updated', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'fake', tmuxSession: 'x', primePrompt: null });
    store.projects.update(project.id, { engine_id: 'fake' });
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      setDesiredProfile: () => {},
      recordCheckpoint: () => {},
      reconcile: () => ({ ok: false, state: 'hold', reason: 'the observed profile still did not match after reconciliation' })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RECONCILE_FAILED');
    assert.match(result.error, /did not match/);
    // The config write already happened (it precedes the reconcile attempt
    // on purpose) — a later launch will still get it right.
    assert.equal(store.projectConfig.load(projectPath).model, 'claude-sonnet-5');
  });

  it('outage-takeover: refuses when there is no active session to take over', async () => {
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5', mode: 'outage-takeover' }, target());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_ACTIVE_SESSION');
  });

  it('outage-takeover: snapshots a dirty worktree onto a wip branch, terminates the session, launches a successor, and applies the switch', async () => {
    initRepo(projectPath, ['-q']);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'committed.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: projectPath });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'uncommitted.txt'), 'wip\n');

    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    let killedProject = null;
    let launchArgs = null;
    const result = await modelSwitch.switchSessionModel(project.name, {
      engine: 'fake', model: 'claude-sonnet-5', mode: 'outage-takeover', reason: 'test outage'
    }, {
      ...target(),
      branchTimestamp: () => 1234567890,
      killSession: (name) => { killedProject = name; return { error: null }; },
      launchSuccessor: (name, engineOverride) => { launchArgs = { name, engineOverride }; return { error: null }; }
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'outage-takeover');
    assert.equal(result.wipBranch, `wip/${project.name}-outage-1234567890`);
    assert.equal(result.handoff.snapshot.committed, true);
    assert.equal(result.handoff.sessionTerminated, true);
    assert.equal(result.handoff.successorLaunched, true);
    assert.deepEqual(launchArgs, { name: project.name, engineOverride: 'fake' });
    assert.equal(killedProject, project.name);
    assert.equal(store.projects.get(project.id).engineId, 'fake');

    const branches = execFileSync('git', ['branch', '--list', result.wipBranch], { cwd: projectPath, encoding: 'utf8' });
    assert.match(branches, /wip\//);
    // The snapshot commit itself left nothing of ITS OWN uncommitted — the
    // `.tangleclaw/project.json` write that follows (this test's fixture
    // repo has no .gitignore, unlike a real managed project's) is a separate,
    // later write and no part of what this assertion checks.
    const committedLog = execFileSync('git', ['log', result.wipBranch, '--oneline'], { cwd: projectPath, encoding: 'utf8' });
    assert.match(committedLog, /Outage takeover snapshot/);
  });

  it('outage-takeover: reports a successor-launch failure without treating it as an overall failure', async () => {
    initRepo(projectPath, ['-q']);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'committed.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: projectPath });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: projectPath });

    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    const result = await modelSwitch.switchSessionModel(project.name, {
      engine: 'fake', model: 'claude-sonnet-5', mode: 'outage-takeover'
    }, {
      ...target(),
      killSession: () => ({ error: null }),
      launchSuccessor: () => { throw new Error('no engine installed on this host'); }
    });

    assert.equal(result.ok, true, 'the recovery (snapshot + terminate) already succeeded; a launch failure is reported, not escalated');
    assert.equal(result.handoff.successorLaunched, false);
    assert.match(result.handoff.successorError, /no engine installed/);
  });

  it('outage-takeover: a clean worktree is left uncommitted, with wipBranch null', async () => {
    initRepo(projectPath, ['-q']);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'committed.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: projectPath });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: projectPath });

    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    const result = await modelSwitch.switchSessionModel(project.name, {
      engine: 'fake', model: 'claude-sonnet-5', mode: 'outage-takeover'
    }, { ...target(), killSession: () => ({ error: null }), launchSuccessor: () => ({ error: null }) });

    assert.equal(result.ok, true);
    assert.equal(result.wipBranch, null);
    assert.equal(result.handoff.snapshot.committed, false);
  });

  it('outage-takeover: refuses, and does not touch the project config, when terminating the session fails', async () => {
    initRepo(projectPath, ['-q']);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'committed.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: projectPath });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'uncommitted.txt'), 'wip\n');

    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    const result = await modelSwitch.switchSessionModel(project.name, {
      engine: 'fake', model: 'claude-sonnet-5', mode: 'outage-takeover'
    }, { ...target(), branchTimestamp: () => 9999, killSession: () => ({ error: 'tmux has-session: no server running' }) });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'TERMINATE_FAILED');
    assert.match(result.error, /tmux has-session/);
    // The snapshot itself already landed — the branch name is still reported
    // so nothing is lost, even though the overall call failed.
    assert.equal(result.wipBranch, `wip/${project.name}-outage-9999`);
    assert.equal(store.projects.get(project.id).engineId, 'claude', 'engine must NOT be switched when termination failed');
  });

  it('outage-takeover: a colliding branch name is disambiguated with a numeric suffix', async () => {
    initRepo(projectPath, ['-q']);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'committed.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: projectPath });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: projectPath });
    // A prior outage already claimed this exact branch name.
    execFileSync('git', ['branch', `wip/${project.name}-outage-9999`], { cwd: projectPath });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: projectPath }).toString();
    fs.writeFileSync(path.join(projectPath, 'uncommitted.txt'), 'wip\n');

    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    const result = await modelSwitch.switchSessionModel(project.name, {
      engine: 'fake', model: 'claude-sonnet-5', mode: 'outage-takeover'
    }, { ...target(), branchTimestamp: () => 9999, killSession: () => ({ error: null }), launchSuccessor: () => ({ error: null }) });

    assert.equal(result.ok, true);
    assert.equal(result.wipBranch, `wip/${project.name}-outage-9999-1`);
  });

  it('outage-takeover: restores the original branch when the snapshot commit itself fails', async () => {
    initRepo(projectPath, ['-q']);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'committed.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: projectPath });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'uncommitted.txt'), 'wip\n');
    const originalBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath, encoding: 'utf8' }).trim();

    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    let commitAttempted = false;
    const result = await modelSwitch.switchSessionModel(project.name, {
      engine: 'fake', model: 'claude-sonnet-5', mode: 'outage-takeover'
    }, {
      ...target(),
      branchTimestamp: () => 4242,
      execGit: (args) => {
        if (args[0] === 'commit') {
          commitAttempted = true;
          throw new Error('commit failed: nothing configured to sign with');
        }
        return execFileSync('git', args, { cwd: projectPath, encoding: 'utf8' });
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'SNAPSHOT_FAILED');
    assert.equal(commitAttempted, true);
    const nowOn = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath, encoding: 'utf8' }).trim();
    assert.equal(nowOn, originalBranch, 'worktree must be restored to the branch it started on, not left on the half-made recovery branch');
  });
});

describe('lib/model-switch — checkDeciderOutageEscalation', () => {
  it('does not escalate a decider that is merely slow but healthy', () => {
    const result = modelSwitch.checkDeciderOutageEscalation({
      deciderName: 'TC-Lane-PM', deciderRole: 'PM', lastDeliveryAt: 0, timeoutMs: 1000, health: 'healthy'
    }, { now: () => 5000 });
    assert.equal(result.shouldEscalate, false);
    assert.equal(result.payload, null);
  });

  it('does not escalate a degraded decider still inside its timeout', () => {
    const result = modelSwitch.checkDeciderOutageEscalation({
      deciderName: 'TC-Lane-PM', deciderRole: 'PM', lastDeliveryAt: 4500, timeoutMs: 1000, health: 'degraded'
    }, { now: () => 5000 });
    assert.equal(result.shouldEscalate, false);
  });

  it('escalates once a degraded decider has been silent past its timeout, with a structured payload', () => {
    const result = modelSwitch.checkDeciderOutageEscalation({
      deciderName: 'TC-Lane-Arc', deciderRole: 'Architect', lastDeliveryAt: 0, timeoutMs: 1000, health: 'degraded'
    }, { now: () => 5000 });
    assert.equal(result.shouldEscalate, true);
    assert.equal(result.payload.kind, 'operator-action-required');
    assert.match(result.payload.text, /TC-Lane-Arc/);
    assert.match(result.payload.text, /degraded/);
    assert.deepEqual(result.payload.receipts, []);
  });
});
