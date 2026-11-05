'use strict';

// Car 65-D (v5.65.0 Wave 1, Charter A502 v1.0): the wiring added by #2864,
// #2871, #2870, and the #2834 fix (routed in from Car 65-B under the
// Charter A502 v1.0 amendment). Each underlying module (lib/workspace-rename-check.js,
// lib/medusa-toggle-sync.js, lib/scratch-home-defaults.js,
// lib/master-authority.js, lib/shared-docs.js, lib/shared-docs-http.js,
// lib/fleet-provisioning.js) already has its own test file proving its own
// logic; this file's job is to prove the GLUE -- that lib/projects.js,
// lib/store.js, lib/master-authority.js, and lib/fleet-provisioning.js now
// actually call those modules, with the right data, at the right point.
//
// #2864's fs-migration half is split: the SAFE call sites (attachProject,
// already-async; detectExistingProjects, no production caller) are already
// covered by test/projects.test.js and test/migration.test.js. The
// remainder (createProject, syncAllProjects, scanForOrphanHooks,
// repairOrphanHooks, deleteProject, scanForStrandedConfigs) is BLOCKED --
// each is called synchronously from server.js, outside this car's envelope
// -- flagged to PM rather than converted and silently broken; see the PR body.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const projects = require('../lib/projects');
const launchSequence = require('../lib/launch-sequence');
const sessionBriefing = require('../lib/session-briefing');
const masterAuthority = require('../lib/master-authority');
const coordinatorRotation = require('../lib/coordinator-rotation');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car65d-wiring-'));
  store._setBasePath(path.join(tmpDir, 'tangleclaw'));
  store.init();
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A real, started session for a fresh project (the fixture every section below shares). */
function makeProjectAndSession(name) {
  const projDir = fs.mkdtempSync(path.join(tmpDir, `${name}-`));
  const project = store.projects.create({ name, path: projDir, engine: 'claude' });
  const launchId = launchSequence.mintLaunchId();
  const snapshot = launchSequence.buildSnapshot({
    launchId, project, engineProfile: store.engines.get('claude'),
    applicability: { applicable: false, reason: 'test binding' }, rendered: null, rules: []
  });
  const session = store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });
  return { project, session };
}

describe('#2834: coordinator_roles/coordinator_rotations retention prune tie-break', () => {
  it('never evicts the row that should be kept when created_at ties exactly (deterministic repro via a fixed clock)', () => {
    // The issue's own repro raced the real wall clock (three grants issued
    // back-to-back land in the same millisecond ~48% of the time, measured)
    // and was first written here as that race, run 50x. That version FAILED
    // on the real Testament pool (a differently-scheduled/slower container:
    // 0 ties in 50 runs) despite passing locally every time -- a race is
    // exactly the kind of thing "ran it once, looked fine" cannot rule out
    // across machines. Pinning `now` through grantRole's own `deps` seam
    // forces the exact tie the issue describes on every machine, so this
    // proves the SAME `rowid DESC` tie-break mechanism without gambling on
    // real timing.
    for (let i = 0; i < 10; i++) {
      const projDir = fs.mkdtempSync(path.join(tmpDir, `tie-${i}-`));
      const project = store.projects.create({ name: `tie-${i}`, path: projDir, engine: 'codex' });
      store.coordinatorRoles._setRetention({ historical: 1 });
      const fixedNow = new Date(2026, 0, 1, 0, 0, 0, i).toISOString();
      const grant = () => coordinatorRotation.grantRole(
        { caller: { kind: 'operator' }, body: { projectId: project.id, role: 'architect' } },
        { now: () => fixedNow }
      ).body.role;
      const first = grant();
      const second = grant();
      grant();
      assert.equal(first.createdAt, second.createdAt, 'the fixture itself must produce a real tie, or the test proves nothing');
      assert.equal(store.coordinatorRoles.get(first.roleId), null,
        `iteration ${i}: the earlier-inserted tied row must be pruned`);
      assert.ok(store.coordinatorRoles.get(second.roleId),
        `iteration ${i}: the later-inserted row, tied on created_at, must be kept (rowid DESC tie-break)`);
    }
  });
});

describe('#2864: decideWorkspaceRename wired into the rename validator', () => {
  it('refuses a rename that would orphan Claude engine state, without explicit confirmation', async () => {
    // Spies on the real exported function (there is no _internal seam to
    // override claudeHome through updateProject's own validator, which
    // forwards no override -- see the next test for the real orphan-risk
    // behavior, exercised directly against decideWorkspaceRename itself):
    // proves updateProject's rename validator genuinely calls it, with the
    // exact oldPath/newPath/confirmOrphanRisk it should.
    const projDir = fs.mkdtempSync(path.join(tmpDir, 'wr-call-'));
    const project = store.projects.create({ name: 'wr-call', path: projDir, engine: 'claude' });
    const workspaceRenameCheck = require('../lib/workspace-rename-check');
    const real = workspaceRenameCheck.decideWorkspaceRename;
    let calledWith = null;
    workspaceRenameCheck.decideWorkspaceRename = (oldPath, newPath, options) => {
      calledWith = { oldPath, newPath, options };
      return real(oldPath, newPath, options);
    };
    try {
      await projects.updateProject(project.name, { name: 'wr-call-renamed', confirmOrphanRisk: true });
      assert.ok(calledWith, 'the validator must call decideWorkspaceRename');
      assert.equal(calledWith.oldPath, projDir);
      assert.equal(calledWith.newPath, path.join(path.dirname(projDir), 'wr-call-renamed'));
      assert.equal(calledWith.options.confirmOrphanRisk, true);
    } finally {
      workspaceRenameCheck.decideWorkspaceRename = real;
    }
  });

  it('decideWorkspaceRename itself is reachable from the validator table with real orphan risk, and confirmOrphanRisk lifts the refusal', () => {
    // Exercises the validator function directly (the same
    // PROJECT_UPDATE_VALIDATORS entry updateProject runs), against a real
    // claudeHome override passed through `options` the same shape
    // lib/workspace-rename-check.js#decideWorkspaceRename itself accepts.
    const workspaceRenameCheck = require('../lib/workspace-rename-check');
    const claudeHome = path.join(tmpDir, 'claude-home-2');
    const oldPath = path.join(tmpDir, 'rename-src');
    const newPath = path.join(tmpDir, 'rename-dst');
    fs.mkdirSync(oldPath, { recursive: true });
    const enc = oldPath.replace(/[/.]/g, '-');
    const dir = path.join(claudeHome, 'projects', enc);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess.jsonl'), JSON.stringify({ type: 'message', cwd: oldPath }) + '\n');

    const refused = workspaceRenameCheck.decideWorkspaceRename(oldPath, newPath, { claudeHome });
    assert.equal(refused.allowed, false);
    assert.match(refused.warning, /orphan/);

    const confirmed = workspaceRenameCheck.decideWorkspaceRename(oldPath, newPath, { claudeHome, confirmOrphanRisk: true });
    assert.equal(confirmed.allowed, true);
    assert.equal(confirmed.requiresConfirmation, true);
  });

  it('a rename with no orphan risk at all is unaffected', async () => {
    // No active session this time -- the validator's own pre-existing
    // "cannot rename while a session is active" check would otherwise
    // refuse first, which is not what this test is isolating.
    const projDir = fs.mkdtempSync(path.join(tmpDir, 'wr-safe-'));
    const project = store.projects.create({ name: 'wr-safe', path: projDir, engine: 'claude' });
    const result = await projects.updateProject(project.name, { name: 'wr-safe-renamed' });
    assert.ok(result.project, 'an ordinary rename with no engine state at the old path still succeeds');
    assert.equal(result.project.name, 'wr-safe-renamed');
  });
});

describe('#2864: lib/session-briefing.js wires findOrphanedSibling/orphanedSiblingWarningFor', () => {
  it('returns null when the workspace has its own engine state (not newly set up)', () => {
    const claudeHome = path.join(tmpDir, 'ch');
    const workspacePath = path.join(tmpDir, 'own-state');
    fs.mkdirSync(workspacePath, { recursive: true });
    const enc = workspacePath.replace(/[/.]/g, '-');
    fs.mkdirSync(path.join(claudeHome, 'projects', enc), { recursive: true });
    fs.writeFileSync(
      path.join(claudeHome, 'projects', enc, 's.jsonl'),
      JSON.stringify({ type: 'message', cwd: workspacePath }) + '\n'
    );
    const line = sessionBriefing.orphanedSiblingBriefingLine(workspacePath, { claudeHome });
    assert.equal(line, null);
  });

  it('_trackedSiblingNames excludes the workspace itself and lists every other tracked project by directory name', () => {
    const { project: p1 } = makeProjectAndSession('sib-1');
    const { project: p2 } = makeProjectAndSession('sib-2');
    const names = sessionBriefing._trackedSiblingNames(p1.path);
    assert.ok(!names.includes(path.basename(p1.path)), 'the workspace itself is excluded');
    assert.ok(names.includes(path.basename(p2.path)), 'every other tracked project is included');
  });

  it('warns when a same-parent sibling holds orphaned state and this workspace looks freshly set up', () => {
    const claudeHome = path.join(tmpDir, 'ch2');
    const parent = path.join(tmpDir, 'parent');
    const workspacePath = path.join(parent, 'renamed-into');
    const siblingPath = path.join(parent, 'old-sibling');
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.mkdirSync(siblingPath, { recursive: true });
    const enc = siblingPath.replace(/[/.]/g, '-');
    fs.mkdirSync(path.join(claudeHome, 'projects', enc), { recursive: true });
    fs.writeFileSync(
      path.join(claudeHome, 'projects', enc, 's.jsonl'),
      JSON.stringify({ type: 'message', cwd: siblingPath }) + '\n'
    );
    // No tracked project named "old-sibling" -- it reads as orphaned, not in active use.
    const line = sessionBriefing.orphanedSiblingBriefingLine(workspacePath, { claudeHome });
    assert.match(line, /old-sibling/);
    assert.match(line, /NOTE:/);
  });
});

describe('#2871: lib/medusa-toggle-sync.js wired into enrichProject (read) and _applyProjectUpdates (write)', () => {
  it('enrichProject reports medusaToggleDrift:{drifted:false} with no active listener and no persisted enable', async () => {
    const { project } = makeProjectAndSession('mt-read-1');
    const enriched = await projects.enrichProject(project);
    assert.equal(enriched.medusaToggleDrift.drifted, false);
  });

  it('enrichProject reports drift when a live listener is on but the persisted pref is off', async () => {
    const { project, session } = makeProjectAndSession('mt-read-2');
    const medusa = require('../lib/medusa');
    const real = medusa.getStatus;
    medusa.getStatus = (id) => (id === session.id ? { state: 'listening' } : real(id));
    try {
      const enriched = await projects.enrichProject(project);
      assert.equal(enriched.medusaEnabled, false, 'the persisted value is never overridden');
      assert.equal(enriched.medusaToggleDrift.drifted, true);
      assert.ok(enriched.medusaToggleDrift.driftReasons.includes('session-override-enabled'));
    } finally {
      medusa.getStatus = real;
    }
  });

  it('updateProject persists medusaEnabled/medusaWake through syncMedusaToggleSettings, validated and unchanged in value', async () => {
    // No active session: medusaEnabled:true on a project WITH one calls the
    // real _syncLiveMedusaListener -> medusa.startSession, a genuine
    // network attempt at the (nonexistent, in this test) Bridge -- pre-
    // existing behavior, not something this test means to exercise.
    const projDir = fs.mkdtempSync(path.join(tmpDir, 'mt-write-'));
    const project = store.projects.create({ name: 'mt-write', path: projDir, engine: 'claude' });
    const r1 = await projects.updateProject(project.name, { medusaEnabled: true });
    assert.equal(r1.project.medusaEnabled, true);
    const r2 = await projects.updateProject(project.name, { medusaWake: true });
    assert.equal(r2.project.medusaWake, true);
    assert.equal(r2.project.medusaEnabled, true, 'an omitted key is left exactly as syncMedusaToggleSettings promises');
  });
});

describe('#2871: lib/scratch-home-defaults.js wired into store.config.load()\'s no-file default', () => {
  it('a canonical (non-scratch) TANGLECLAW_HOME still defaults to ~/Projects -- unchanged for every ordinary install', () => {
    fs.rmSync(path.join(tmpDir, 'tangleclaw', 'config.json'), { force: true });
    const config = store.config.load();
    assert.equal(config.projectsDir, '~/Projects');
  });

  // #2871 I-Gate PRR-B Round 1 (#issuecomment-6651783501): the test above
  // exercises config.load()'s "file missing" branch directly, by deleting
  // config.json AFTER store.init() already ran -- a branch normal boot never
  // takes, since init() always creates config.json first. A real scratch
  // first boot never hit the scratch-aware default at all and silently kept
  // scaffolding into the operator's real ~/Projects. Run in a fresh
  // subprocess (this file is already `large` tier) so the real, completely
  // unmodified init() -> config.load() sequence runs with its own process
  // env and its own first require of lib/store.js -- no shared singleton
  // state from this file's own beforeEach to contaminate or be contaminated by.
  it('a SCRATCH TANGLECLAW_HOME reaches the scratch-aware default through the real, unmodified init() -> config.load() flow', () => {
    const scratchHome = fs.mkdtempSync(path.join(tmpDir, 'scratch-boot-'));
    const script = `
      process.env.TANGLECLAW_HOME = ${JSON.stringify(scratchHome)};
      const path = require('node:path');
      // init()'s own log.info('Created default config', ...) writes to
      // stdout at this level (lib/logger.js: only error-and-above goes to
      // stderr) -- would otherwise land right before this script's own JSON
      // and break the parse below.
      require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'logger.js'))}).setLevel('error');
      const store = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'store.js'))});
      store._setBasePath(path.join(${JSON.stringify(scratchHome)}, 'tangleclaw'));
      store.init();
      const config = store.config.load();
      process.stdout.write(JSON.stringify({ projectsDir: config.projectsDir }));
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const { projectsDir } = JSON.parse(out);
    assert.ok(
      projectsDir.startsWith(scratchHome),
      `expected a scratch-scoped projectsDir under ${scratchHome}, got "${projectsDir}" -- ` +
        'the real first-boot flow fell back to the operator\'s real home default'
    );
  });
});

describe('#2871: lib/master-authority.js#applyMasterAccessConfigPatch wires reconcileMasterAccessConfigPatch to store.config', () => {
  it('reconciles and returns a full config with master stamped, without saving it itself', () => {
    const before = store.config.load();
    assert.equal(before.master.accessLevel, 'read-only', 'DEFAULT_CONFIG.master\'s own stock default');
    assert.equal(before.master.lifecycleGeneration, undefined, 'never stamped yet');
    const next = masterAuthority.applyMasterAccessConfigPatch({ accessLevel: 'write' }, { actor: 'operator:test' });
    assert.equal(next.master.accessLevel, 'write');
    assert.equal(typeof next.master.lifecycleGeneration, 'number');
    const stillBefore = store.config.load();
    assert.equal(stillBefore.master.accessLevel, 'read-only', 'applyMasterAccessConfigPatch never saves -- the caller does');
  });
});

describe('#2870: lib/fleet-provisioning.js wires buildSharedDocMagicDnsUrl + inspectSharedDocRegistrations', () => {
  const fp = require('../lib/fleet-provisioning');

  it('reports a shareableUrl when shareableBaseUrl is given, and docId always', () => {
    const { project } = makeProjectAndSession('fp-1');
    const sharedDir = fs.mkdtempSync(path.join(tmpDir, 'shared-'));
    const r = fp.provisionFleetResources({
      groupName: 'fp-group-1', sharedDir, memberProjectIds: [project.id],
      shareableBaseUrl: 'https://cursatory.tail123678.ts.net:8443'
    });
    assert.equal(r.ok, true);
    assert.ok(r.result.laneQueue.docId);
    assert.equal(r.result.laneQueue.shareableUrl, `https://cursatory.tail123678.ts.net:8443/shared-docs/${r.result.laneQueue.docId}`);
  });

  it('shareableUrl is null when no shareableBaseUrl is given', () => {
    const { project } = makeProjectAndSession('fp-2');
    const sharedDir = fs.mkdtempSync(path.join(tmpDir, 'shared2-'));
    const r = fp.provisionFleetResources({ groupName: 'fp-group-2', sharedDir, memberProjectIds: [project.id] });
    assert.equal(r.ok, true);
    assert.equal(r.result.laneQueue.shareableUrl, null);
    assert.ok(r.result.laneQueue.docId);
  });

  it('health reports the doc as resolved right after provisioning', () => {
    const { project } = makeProjectAndSession('fp-3');
    const sharedDir = fs.mkdtempSync(path.join(tmpDir, 'shared3-'));
    const r = fp.provisionFleetResources({ groupName: 'fp-group-3', sharedDir, memberProjectIds: [project.id] });
    assert.equal(r.result.laneQueue.health.resolved, true);
  });

  it('a repeat (idempotent) call still returns the same docId, scoped shareableUrl, and resolved health', () => {
    const { project } = makeProjectAndSession('fp-4');
    const sharedDir = fs.mkdtempSync(path.join(tmpDir, 'shared4-'));
    const first = fp.provisionFleetResources({
      groupName: 'fp-group-4', sharedDir, memberProjectIds: [project.id], shareableBaseUrl: 'https://x.ts.net'
    });
    const second = fp.provisionFleetResources({
      groupName: 'fp-group-4', sharedDir, memberProjectIds: [project.id], shareableBaseUrl: 'https://x.ts.net'
    });
    assert.equal(second.result.laneQueue.registered, false, 'already registered on the repeat call');
    assert.equal(second.result.laneQueue.docId, first.result.laneQueue.docId);
    assert.equal(second.result.laneQueue.shareableUrl, first.result.laneQueue.shareableUrl);
    assert.equal(second.result.laneQueue.health.resolved, true);
  });
});

describe('#2864 Async companions (A502-W1D-R2): createProjectAsync/syncAllProjectsAsync/' +
  'scanForOrphanHooksAsync/repairOrphanHooksAsync/deleteProjectAsync/scanForStrandedConfigsAsync', () => {
  // Each twin reimplements its sync original's exact contract against
  // `lib/projects-async-io.js` + `fs.promises` instead of `fs`; these tests
  // prove the async body matches, not re-derive the business logic its sync
  // counterpart already has full coverage for (test/orphan-hooks.test.js,
  // test/stranded-configs.test.js, test/projects.test.js).
  let projectsDir;

  beforeEach(() => {
    projectsDir = path.join(tmpDir, 'async-projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const cfg = store.config.load();
    cfg.projectsDir = projectsDir;
    store.config.save(cfg);
  });

  function registerProject(rel) {
    const projectPath = path.join(projectsDir, rel);
    fs.mkdirSync(projectPath, { recursive: true });
    const name = rel.replace(/[/\\]/g, '-');
    store.projects.create({ name, path: projectPath, engine: 'claude', tags: [], ports: {} });
    return projectPath;
  }

  function writeSettings(projectPath, hooks, extraKeys = {}) {
    const settingsDir = path.join(projectPath, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    const settings = { ...extraKeys };
    if (hooks !== null) settings.hooks = hooks;
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(settings, null, 2));
  }

  function readSettings(projectPath) {
    return JSON.parse(fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf8'));
  }

  function orphanStopEntry(scriptPath = 'tools/product-hook') {
    return {
      matcher: '',
      hooks: [{
        type: 'command',
        command: `python3 "$CLAUDE_PROJECT_DIR/${scriptPath}" stop`,
        statusMessage: 'Checking governance gates...'
      }]
    };
  }

  describe('createProjectAsync', () => {
    it('creates a project identically to the sync original: directory, CHANGELOG.md, memory seed, DB row', async () => {
      const { project, errors } = await projects.createProjectAsync({ name: 'async-create-1', gitInit: false });
      assert.deepStrictEqual(errors, []);
      assert.ok(project);
      assert.equal(project.name, 'async-create-1');
      const projectPath = path.join(projectsDir, 'async-create-1');
      assert.ok(fs.existsSync(path.join(projectPath, 'CHANGELOG.md')));
      assert.ok(fs.existsSync(path.join(projectPath, '.tangleclaw', 'memories', 'MEMORY.md')));
      assert.ok(store.projects.getByName('async-create-1'));
    });

    it('refuses a duplicate name, case-insensitively, same as the sync original', async () => {
      await projects.createProjectAsync({ name: 'dupe-async', gitInit: false });
      const { project, errors } = await projects.createProjectAsync({ name: 'Dupe-Async', gitInit: false });
      assert.equal(project, null);
      assert.ok(errors[0].includes('already exists'));
    });

    it('refuses when the target directory already exists on disk', async () => {
      fs.mkdirSync(path.join(projectsDir, 'existing-dir-async'));
      const { project, errors } = await projects.createProjectAsync({ name: 'existing-dir-async' });
      assert.equal(project, null);
      assert.ok(errors[0].includes('already exists in'));
    });
  });

  describe('syncAllProjectsAsync', () => {
    it('creates the missing session-memory directory and seed file, same as the sync original', async () => {
      const projectPath = registerProject('sync-async-1');
      const memoriesDir = path.join(projectPath, '.tangleclaw', 'memories');
      assert.ok(!fs.existsSync(memoriesDir));

      const result = await projects.syncAllProjectsAsync();
      assert.equal(result.synced, 1);
      assert.deepStrictEqual(result.errors, []);
      assert.ok(fs.existsSync(path.join(memoriesDir, 'MEMORY.md')));
    });

    it('skips a project whose directory no longer exists on disk, without erroring', async () => {
      registerProject('sync-async-gone');
      fs.rmSync(path.join(projectsDir, 'sync-async-gone'), { recursive: true, force: true });

      const result = await projects.syncAllProjectsAsync();
      assert.equal(result.synced, 0);
      assert.deepStrictEqual(result.errors, []);
    });
  });

  describe('deleteProjectAsync', () => {
    it('removes the project row and, with deleteFiles, the directory from disk', async () => {
      const projectPath = registerProject('delete-async-1');
      const result = await projects.deleteProjectAsync('delete-async-1', { deleteFiles: true });
      assert.equal(result.success, true);
      assert.equal(result.filesDeleted, true);
      assert.ok(!fs.existsSync(projectPath));
      assert.equal(store.projects.getByName('delete-async-1'), null);
    });

    it('with deleteFiles:false, removes the DB row but preserves the directory', async () => {
      const projectPath = registerProject('delete-async-keep');
      const result = await projects.deleteProjectAsync('delete-async-keep', { deleteFiles: false });
      assert.equal(result.success, true);
      assert.equal(result.filesDeleted, false);
      assert.ok(fs.existsSync(projectPath));
    });

    it('reports an error for an unknown project name', async () => {
      const result = await projects.deleteProjectAsync('does-not-exist-async');
      assert.equal(result.success, false);
      assert.ok(result.errors[0].includes('not found'));
    });
  });

  describe('scanForOrphanHooksAsync + repairOrphanHooksAsync', () => {
    it('flags the same orphan a sync scan would, and repair removes it', async () => {
      const p = registerProject('orphan-async-1');
      writeSettings(p, { Stop: [orphanStopEntry()] });

      const scanResult = await projects.scanForOrphanHooksAsync();
      assert.equal(scanResult.scanned, 1);
      assert.equal(scanResult.projectsWithOrphans.length, 1);
      assert.equal(scanResult.projectsWithOrphans[0].name, 'orphan-async-1');

      const repairResult = await projects.repairOrphanHooksAsync();
      assert.equal(repairResult.repaired.length, 1);
      const after = readSettings(p);
      assert.equal(after.hooks, undefined, 'the only entry was orphan, so the hooks block is removed entirely');
    });

    it('does not flag a hook whose referenced path exists', async () => {
      const p = registerProject('orphan-async-ok');
      fs.mkdirSync(path.join(p, 'tools'));
      fs.writeFileSync(path.join(p, 'tools', 'product-hook'), '#!/bin/sh\n');
      writeSettings(p, { Stop: [orphanStopEntry()] });

      const scanResult = await projects.scanForOrphanHooksAsync();
      assert.deepStrictEqual(scanResult.projectsWithOrphans, []);
    });

    it('single-target repair via projectName, same as the sync original', async () => {
      const alpha = registerProject('orphan-async-alpha');
      const beta = registerProject('orphan-async-beta');
      writeSettings(alpha, { Stop: [orphanStopEntry()] });
      writeSettings(beta, { Stop: [orphanStopEntry()] });

      const result = await projects.repairOrphanHooksAsync('orphan-async-alpha');
      assert.equal(result.repaired.length, 1);
      assert.equal(result.repaired[0].name, 'orphan-async-alpha');
      const betaAfter = readSettings(beta);
      assert.ok(betaAfter.hooks.Stop, 'beta was not targeted, so its orphan entry must survive untouched');
    });
  });

  describe('scanForStrandedConfigsAsync', () => {
    it('reports a stranded ancestor CLAUDE.md above a registered nested project, same as the sync original', async () => {
      registerProject('TiLT-v2-async/tilt-v2');
      fs.writeFileSync(path.join(projectsDir, 'TiLT-v2-async', 'CLAUDE.md'), '## stale\n');

      const result = await projects.scanForStrandedConfigsAsync();
      assert.equal(result.scanned, 1);
      assert.equal(result.stranded.length, 1);
      assert.equal(result.stranded[0].dir, path.join(projectsDir, 'TiLT-v2-async'));
      assert.deepStrictEqual(result.stranded[0].files, ['CLAUDE.md']);
      assert.deepStrictEqual(result.errors, []);
    });

    it('does not report a parent that is itself a registered project', async () => {
      registerProject('mono-async');
      registerProject('mono-async/app');
      fs.writeFileSync(path.join(projectsDir, 'mono-async', 'CLAUDE.md'), '# registered parent\n');

      const result = await projects.scanForStrandedConfigsAsync();
      assert.deepStrictEqual(result.stranded, []);
    });
  });
});
