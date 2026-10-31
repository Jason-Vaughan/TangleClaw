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
const profileReconciler = require('../lib/profile-reconciler');
const continuity = require('../lib/continuity');

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

  it('cross-provider: calls sessions.triggerWrap with the project name and the side-effect-neutralizing options, before killing or relaunching (PRR-A Round 4 BLOCKING 2, #2598)', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    let wrapArgs = null;
    let killed = false;
    let launched = false;
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      triggerWrap: (name, wopts) => { wrapArgs = { name, wopts }; return { ok: true }; },
      killSession: () => { killed = true; return { error: null }; },
      launchSession: () => { launched = true; return { error: null }; }
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(wrapArgs, {
      name: project.name,
      wopts: { keepSessionRunning: false, skipTests: true, prHandling: 'defer', bumpLevel: 'none' }
    });
    assert.equal(killed, true);
    assert.equal(launched, true);
  });

  it('cross-provider: refuses (WRAP_FAILED) before killing or relaunching, when the governed wrap itself fails', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    let killed = false;
    let launched = false;
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      triggerWrap: () => ({ ok: false, error: 'test step failed: 3 failing assertions' }),
      killSession: () => { killed = true; return { error: null }; },
      launchSession: () => { launched = true; return { error: null }; }
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WRAP_FAILED');
    assert.match(result.error, /3 failing assertions/);
    assert.equal(killed, false, 'must not kill the session once the governed wrap itself failed');
    assert.equal(launched, false);
    // The config write already happened (it precedes the wrap, same as it
    // always preceded the relaunch) — a later launch will still get it right.
    assert.equal(store.projectConfig.load(projectPath).model, 'claude-sonnet-5');
  });

  it('cross-provider: refuses (WRAP_FAILED) when triggerWrap returns a falsy result entirely', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      triggerWrap: () => null
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WRAP_FAILED');
    assert.match(result.error, /governed wrap failed/);
  });

  it('switches (cross-provider relaunch), refreshes the session, and persists engine/model when at boundary', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    let refreshArgs = null;
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      triggerWrap: () => ({ ok: true }),
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
      triggerWrap: () => ({ ok: true }),
      refreshSession: () => { engineIdWhenRefreshRan = store.projects.get(project.id).engineId; }
    });
    assert.equal(result.ok, true);
    assert.equal(engineIdWhenRefreshRan, 'fake', 'the project row must already carry the new engine by the time refresh runs');
  });

  it('cross-provider: refuses (KILL_FAILED) when killSession fails, using the real default refreshSession', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      triggerWrap: () => ({ ok: true }),
      // The real default `getActiveSession` reads `store.sessions.getActive`,
      // which is still active here (the stubbed triggerWrap didn't end it) —
      // this is exactly the "lightweight test double" case the kill-as-
      // cleanup fallback exists for.
      killSession: () => ({ error: 'tmux has-session: no server running' })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'KILL_FAILED');
    assert.match(result.error, /tmux has-session/);
  });

  it('cross-provider: refuses (LAUNCH_FAILED) when launchSession fails after a successful kill', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    let killed = false;
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      triggerWrap: () => ({ ok: true }),
      killSession: () => { killed = true; return { error: null }; },
      launchSession: () => ({ error: 'ENGINE_PROFILE_INVALID' })
    });
    assert.equal(killed, true);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'LAUNCH_FAILED');
    assert.match(result.error, /ENGINE_PROFILE_INVALID/);
  });

  it('cross-provider: writes a continuity handoff naming the active plan before killing', async () => {
    const plansDir = path.join(projectPath, '.tangleclaw', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    const olderPlan = path.join(plansDir, 'older-plan.md');
    fs.writeFileSync(olderPlan, '# old\n');
    fs.utimesSync(olderPlan, new Date(Date.now() - 3600000), new Date(Date.now() - 3600000));
    const newestPlan = path.join(plansDir, 'newest-plan.md');
    fs.writeFileSync(newestPlan, '# newest\n');

    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5', reason: 'ship chunk 2' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      triggerWrap: () => ({ ok: true }),
      refreshSession: () => ({ ok: true })
    });
    assert.equal(result.ok, true);
    const handoff = JSON.parse(fs.readFileSync(path.join(projectPath, '.tangleclaw', 'model-switch-handoff.json'), 'utf8'));
    assert.equal(handoff.project, project.name);
    assert.equal(handoff.mode, 'boundary');
    assert.equal(handoff.reason, 'ship chunk 2');
    assert.equal(handoff.planPath, newestPlan);
    assert.equal(handoff.appliedModel, 'claude-sonnet-5');
    assert.ok(handoff.writtenAt);
    // The REAL mechanism lib/sessions.js#_resumeSource reads back at the
    // next launch (continuity.readIndex) — confirmed by reading that
    // function directly, not assumed.
    const index = continuity.readIndex(projectPath);
    assert.ok(index, 'a continuity index must exist after a cross-provider switch');
    assert.match(index.currentState, /ship chunk 2|session/i);
    assert.match(index.nextAction, new RegExp(newestPlan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('cross-provider: preserves an existing curated Map in the continuity index rather than wiping it (PRR-A WARNING, Round 4)', async () => {
    // A prior wrap's curated Map, written before this switch ever runs.
    continuity.writeIndex(projectPath, {
      project: project.name, currentState: 'old state', nextAction: 'old action',
      map: '- `lib/foo.js` — does the foo thing\n- `lib/bar.js` — does the bar thing',
      freshness: { sha: 'deadbeef', branch: 'main', writtenAt: new Date().toISOString(), tier: 'full' }
    });

    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      triggerWrap: () => ({ ok: true }),
      refreshSession: () => ({ ok: true })
    });
    assert.equal(result.ok, true, result.error);
    const existing = continuity.readIndexRaw(projectPath);
    assert.match(existing.map, /lib\/foo\.js/, 'a curated Map from before this switch must survive it, not be wiped by writeIndex regenerating the file');
    assert.match(existing.map, /lib\/bar\.js/);
  });

  it('cross-provider: refuses (EFFORT_UNSUPPORTED_ON_RELAUNCH) before touching anything', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5', effort: 'high' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EFFORT_UNSUPPORTED_ON_RELAUNCH');
    assert.equal(store.projects.get(project.id).engineId, 'claude', 'nothing touched — refused before _applyToProjectConfig');
  });

  it('cross-provider: fails closed (HANDOFF_WRITE_FAILED) before killing, when the continuity index cannot be written', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    let killed = false;
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'fake', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      killSession: () => { killed = true; return { error: null }; },
      writeContinuityIndex: () => { throw new Error('disk full'); }
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HANDOFF_WRITE_FAILED');
    assert.match(result.error, /disk full/);
    assert.equal(killed, false, 'must not kill the session once the handoff cannot be recorded');
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
    // Required, not optional: lib/profile-reconciler.js's Claude adapter
    // fails closed (returns null, which can never match) unless BOTH are
    // given — a prior version of this call omitted them entirely.
    assert.equal(reconcileArgs.rdeps.projectPath, projectPath);
    assert.equal(reconcileArgs.rdeps.startedAtMs, profileReconciler.parseLaunchTimestampMs(session.startedAt));
    assert.ok(Number.isFinite(reconcileArgs.rdeps.startedAtMs), 'startedAtMs must be a finite number, not NaN/undefined');
    // PRR-A Round 4 (#2598): never trust a pre-switch match by coincidence —
    // `/clear` must always run for a live switch.
    assert.equal(reconcileArgs.rdeps.requireClear, true);
  });

  it('same-provider: a non-stubbed reconcile actually sends /clear + /model and verifies against the post-switch transcript (#2598 BLOCKING 2, PRR-A Round 3 BLOCKING 1)', async () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-model-switch-claudehome-'));
    const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'the-real-tmux', primePrompt: null });
    const startedAtMs = profileReconciler.parseLaunchTimestampMs(session.startedAt);

    // Pre-switch evidence that the session already ran on a DIFFERENT
    // model, so the initial observation genuinely does not match the
    // upcoming switch target (proving /clear + /model fire for a real
    // reason, not skipped by coincidence). `startedAtMs + 2000` clears the
    // reader's own one-second same-instant ambiguity window around
    // `session.startedAt` (SQLite's `started_at` column has only
    // second resolution) the same way the BLOCKING 2 test above does.
    const transcriptDir = path.join(claudeHome, 'projects', 'some-slug');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, 'abc123.jsonl');
    fs.writeFileSync(transcriptFile, JSON.stringify({
      type: 'assistant', cwd: projectPath, timestamp: new Date(startedAtMs + 2000).toISOString(),
      message: { model: 'claude-opus-4-6' }
    }) + '\n');

    const sentKeys = [];
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'claude', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      claudeHome,
      tmux: {
        sendKeys: (sessionArg, cmd) => {
          sentKeys.push({ session: sessionArg, cmd });
          // A real Claude Code session appends a new transcript record once
          // `/model <id>` actually lands — simulated here by appending one
          // ourselves, which also refreshes the file's own mtime past the
          // switch's start instant, same as the real file would.
          if (cmd === '/model claude-sonnet-5') {
            fs.appendFileSync(transcriptFile, JSON.stringify({
              type: 'assistant', cwd: projectPath, timestamp: new Date().toISOString(),
              message: { model: 'claude-sonnet-5' }
            }) + '\n');
          }
        }
      }
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.sameProvider, true);
    // Proof this actually drove the live control loop against the real
    // adapter/observer — not a stub that always answers ok, and not an
    // early-exit match against stale pre-switch evidence.
    assert.ok(sentKeys.some((k) => k.cmd === '/clear'), 'must send /clear');
    assert.ok(sentKeys.some((k) => k.cmd === '/model claude-sonnet-5'), 'must send /model claude-sonnet-5');
  });

  it('same-provider: a non-stubbed reconcile still sends /clear + /model and re-verifies against a post-clear record, even when the PRE-switch transcript already names the target model (PRR-A Round 4 BLOCKING 1)', async () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-model-switch-claudehome-'));
    const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'the-real-tmux', primePrompt: null });
    const startedAtMs = profileReconciler.parseLaunchTimestampMs(session.startedAt);

    // The stale-coincidence scenario Round 3 named: the session already ran
    // on the SAME model being "switched" to (e.g. it drifted away and back
    // with no conversation turn in between). Without `requireClear: true`
    // this would short-circuit `verified` with nothing sent at all.
    const transcriptDir = path.join(claudeHome, 'projects', 'some-slug');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, 'abc123.jsonl');
    fs.writeFileSync(transcriptFile, JSON.stringify({
      type: 'assistant', cwd: projectPath, timestamp: new Date(startedAtMs + 2000).toISOString(),
      message: { model: 'claude-sonnet-5' }
    }) + '\n');

    const sentKeys = [];
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'claude', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      claudeHome,
      tmux: {
        sendKeys: (sessionArg, cmd) => {
          sentKeys.push({ session: sessionArg, cmd });
          // The post-clear record `requireClear`'s recency scoping needs:
          // without this, the only matching-model record on file predates
          // the clear and can no longer satisfy the re-observation.
          if (cmd === '/model claude-sonnet-5') {
            fs.appendFileSync(transcriptFile, JSON.stringify({
              type: 'assistant', cwd: projectPath, timestamp: new Date().toISOString(),
              message: { model: 'claude-sonnet-5' }
            }) + '\n');
          }
        }
      }
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.sameProvider, true);
    // The whole point of this test: /clear + /model still fire even though
    // the pre-switch transcript already named the target model.
    assert.ok(sentKeys.some((k) => k.cmd === '/clear'), 'must send /clear despite the coincidental pre-switch match');
    assert.ok(sentKeys.some((k) => k.cmd === '/model claude-sonnet-5'), 'must send /model claude-sonnet-5 despite the coincidental pre-switch match');
  });

  it('same-provider: fails closed (RECONCILE_FAILED) when requireClear cannot verify because no post-clear record ever appears', async () => {
    const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-model-switch-claudehome-'));
    const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'the-real-tmux', primePrompt: null });
    const startedAtMs = profileReconciler.parseLaunchTimestampMs(session.startedAt);

    const transcriptDir = path.join(claudeHome, 'projects', 'some-slug');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, 'abc123.jsonl');
    fs.writeFileSync(transcriptFile, JSON.stringify({
      type: 'assistant', cwd: projectPath, timestamp: new Date(startedAtMs + 2000).toISOString(),
      message: { model: 'claude-sonnet-5' }
    }) + '\n');

    const sentKeys = [];
    const result = await modelSwitch.switchSessionModel(project.name, { engine: 'claude', model: 'claude-sonnet-5' }, {
      ...target(),
      checkBoundary: () => ({ atBoundary: true, blockers: [], details: {} }),
      claudeHome,
      // `clearAppliedAtMs` reads from THIS seam, forced well past the
      // fixture's only record (startedAtMs + 2000) — without it, a
      // fast-executing test would see real `Date.now()` land only
      // milliseconds after `startedAtMs`, which is BEFORE that record and
      // would make it look like valid post-clear evidence by accident.
      now: () => startedAtMs + 5000,
      // No new record ever gets appended here — the engine never actually
      // ran a turn after /model landed, so there is nothing post-clear to
      // confirm against.
      tmux: { sendKeys: (sessionArg, cmd) => sentKeys.push({ session: sessionArg, cmd }) }
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'RECONCILE_FAILED');
    assert.ok(sentKeys.some((k) => k.cmd === '/clear'));
    assert.ok(sentKeys.some((k) => k.cmd === '/model claude-sonnet-5'));
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

  it('outage-takeover: refuses (EFFORT_UNSUPPORTED_ON_RELAUNCH) before touching anything', async () => {
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    const result = await modelSwitch.switchSessionModel(project.name, {
      engine: 'fake', model: 'claude-sonnet-5', mode: 'outage-takeover', effort: 'high'
    }, target());
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EFFORT_UNSUPPORTED_ON_RELAUNCH');
    assert.equal(store.projects.get(project.id).engineId, 'claude');
  });

  it('outage-takeover: fails closed (HANDOFF_WRITE_FAILED) before killing, when the continuity index cannot be written', async () => {
    initRepo(projectPath, ['-q']);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'committed.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: projectPath });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: projectPath });

    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    let killed = false;
    const result = await modelSwitch.switchSessionModel(project.name, {
      engine: 'fake', model: 'claude-sonnet-5', mode: 'outage-takeover'
    }, {
      ...target(),
      killSession: () => { killed = true; return { error: null }; },
      writeContinuityIndex: () => { throw new Error('disk full'); }
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HANDOFF_WRITE_FAILED');
    assert.match(result.error, /disk full/);
    assert.equal(killed, false, 'must not kill the wedged session once the handoff cannot be recorded');
    assert.equal(store.projects.get(project.id).engineId, 'claude', 'nothing touched — refused before _applyToProjectConfig');
  });

  it('outage-takeover: snapshots a dirty worktree onto a wip branch, terminates the session, launches a successor, and applies the switch', async () => {
    initRepo(projectPath, ['-q']);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'committed.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: projectPath });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'uncommitted.txt'), 'wip\n');
    const plansDir = path.join(projectPath, '.tangleclaw', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    const planPath = path.join(plansDir, 'in-progress.md');
    fs.writeFileSync(planPath, '# plan\n');

    const session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'x', primePrompt: null });
    let killedProject = null;
    let handoffWrittenBeforeKill = null;
    let launchArgs = null;
    const result = await modelSwitch.switchSessionModel(project.name, {
      engine: 'fake', model: 'claude-sonnet-5', mode: 'outage-takeover', reason: 'test outage'
    }, {
      ...target(),
      branchTimestamp: () => 1234567890,
      killSession: (name) => {
        killedProject = name;
        handoffWrittenBeforeKill = fs.existsSync(path.join(projectPath, '.tangleclaw', 'outage-handoff.json'));
        return { error: null };
      },
      launchSuccessor: (name, engineOverride) => { launchArgs = { name, engineOverride }; return { error: null }; }
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'outage-takeover');
    assert.equal(result.wipBranch, `wip/${project.name}-outage-1234567890`);
    assert.equal(result.handoff.snapshot.committed, true);
    assert.equal(result.handoff.sessionTerminated, true);
    assert.equal(result.handoff.successorLaunched, true);
    assert.equal(result.handoff.planPath, planPath);
    assert.deepEqual(launchArgs, { name: project.name, engineOverride: 'fake' });
    assert.equal(killedProject, project.name);
    assert.equal(handoffWrittenBeforeKill, true, 'the continuity handoff must be written BEFORE the kill, not after');
    assert.equal(store.projects.get(project.id).engineId, 'fake');

    const handoff = JSON.parse(fs.readFileSync(result.handoff.continuityHandoffFile, 'utf8'));
    assert.equal(handoff.project, project.name);
    assert.equal(handoff.mode, 'outage-takeover');
    assert.equal(handoff.sessionId, session.id);
    assert.equal(handoff.planPath, planPath);

    // The REAL mechanism the successor's own launch reads back
    // (lib/sessions.js#_resumeSource -> continuity.readIndex).
    const index = continuity.readIndex(projectPath);
    assert.ok(index);
    assert.match(index.currentState, new RegExp(result.wipBranch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(index.nextAction, new RegExp(planPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(index.freshness.branch, result.wipBranch);

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
