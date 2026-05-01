'use strict';

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('sessions', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sessions-'));
    store._setBasePath(tmpDir);
    store.init();

    // Create a projects directory
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    // Set the projectsDir in config
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Since sessions.js depends on tmux (shell commands), we test the logic
  // that doesn't require actual tmux sessions

  describe('generatePrimePrompt', () => {
    let sessions;
    let projectId;

    before(() => {
      sessions = require('../lib/sessions');

      // Create a project in the store
      const projDir = path.join(projectsDir, 'prime-test');
      fs.mkdirSync(projDir, { recursive: true });

      const project = store.projects.create({
        name: 'prime-test',
        path: projDir,
        engine: 'claude',
        methodology: 'minimal'
      });
      projectId = project.id;
    });

    it('generates a prime prompt with project name', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');
      const prompt = sessions.generatePrimePrompt(project, engine);

      assert.ok(prompt.includes('prime-test'));
      assert.ok(prompt.includes('Session Start'));
    });

    it('does not inject methodology heading or description (#102 — already in CLAUDE.md + pill)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      store.projects.update(project.id, { methodology: 'minimal' });
      const updatedProject = store.projects.getByName('prime-test');

      const prompt = sessions.generatePrimePrompt(updatedProject, engine);
      assert.equal(prompt.includes('## Methodology:'), false, 'prime should not carry methodology heading');
      assert.equal(prompt.includes('## Current Phase:'), false, 'prime should not carry current phase heading');
    });

    it('includes active learnings', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      store.learnings.create({
        projectId: project.id,
        content: 'Always validate inputs',
        tier: 'active'
      });

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.ok(prompt.includes('Always validate inputs'));
      assert.ok(prompt.includes('Active Learnings'));
    });

    it('does not inject Shared Infrastructure pointer for single group (#102 — docs already in CLAUDE.md)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      const group = store.projectGroups.create({ name: 'habitat infra', description: 'shared habitat' });
      store.projectGroups.addMember(group.id, project.id);
      store.sharedDocs.create({
        groupId: group.id,
        name: 'NETWORK',
        filePath: '/tmp/NETWORK.md',
        injectIntoConfig: true,
        injectMode: 'reference'
      });

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.equal(prompt.includes('Shared Infrastructure'), false, 'prime should not surface Shared Infrastructure heading');
      assert.equal(prompt.includes('1 shared doc linked'), false, 'prime should not surface shared-doc counts');

      store.projectGroups.delete(group.id);
    });

    it('does not inject sharedDir path (#102)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      const group = store.projectGroups.create({ name: 'frontend libs', sharedDir: '/tmp/shared-frontend' });
      store.projectGroups.addMember(group.id, project.id);
      store.sharedDocs.create({
        groupId: group.id,
        name: 'STYLES',
        filePath: '/tmp/shared-frontend/STYLES.md',
        injectIntoConfig: true,
        injectMode: 'reference'
      });

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.equal(prompt.includes('/tmp/shared-frontend'), false, 'prime should not echo sharedDir paths');

      store.projectGroups.delete(group.id);
    });

    it('does not list multiple groups in bulleted format (#102)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      const g1 = store.projectGroups.create({ name: 'group-alpha' });
      const g2 = store.projectGroups.create({ name: 'group-beta' });
      store.projectGroups.addMember(g1.id, project.id);
      store.projectGroups.addMember(g2.id, project.id);
      store.sharedDocs.create({ groupId: g1.id, name: 'DOC1', filePath: '/tmp/d1.md', injectIntoConfig: true, injectMode: 'reference' });
      store.sharedDocs.create({ groupId: g2.id, name: 'DOC2', filePath: '/tmp/d2.md', injectIntoConfig: true, injectMode: 'reference' });
      store.sharedDocs.create({ groupId: g2.id, name: 'DOC3', filePath: '/tmp/d3.md', injectIntoConfig: true, injectMode: 'reference' });

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.equal(prompt.includes('Shared Infrastructure'), false);
      assert.equal(prompt.includes('group-alpha'), false);
      assert.equal(prompt.includes('group-beta'), false);

      store.projectGroups.delete(g1.id);
      store.projectGroups.delete(g2.id);
    });

    it('omits shared infrastructure when project has no groups with docs', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.ok(!prompt.includes('Shared Infrastructure'));
    });

    it('includes last session summary', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      // Create and wrap a session in the store
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'prime-wrap-test'
      });
      store.sessions.wrap(session.id, 'Completed chunk 4 with 108 tests');

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.ok(prompt.includes('Last Session Summary'));
      assert.ok(prompt.includes('Completed chunk 4'));
    });

    it('omits playbook AND methodology heading (#102 — both belong in CLAUDE.md, not prime)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      store.projects.update(project.id, { methodology: 'prawduct' });
      const updated = store.projects.getByName('prime-test');

      const prompt = sessions.generatePrimePrompt(updated, engine);
      assert.ok(!prompt.includes('Session Playbook'), 'playbook should not be in prime prompt');
      assert.ok(!prompt.includes('Janitor Pass'), 'playbook details should not be in prime prompt');
      assert.equal(prompt.includes('Methodology: Prawduct'), false, 'methodology heading should not be in prime (#102)');

      store.projects.update(project.id, { methodology: 'minimal' });
    });

    it('does not inject Active Extension Rules with definitions (#102 — already in CLAUDE.md)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      store.projects.update(project.id, { methodology: 'prawduct' });
      const updated = store.projects.getByName('prime-test');
      const projConfig = store.projectConfig.load(updated.path);
      projConfig.rules = projConfig.rules || { extensions: {} };
      projConfig.rules.extensions.independentCritic = true;
      projConfig.rules.extensions.docsParity = true;
      store.projectConfig.save(updated.path, projConfig);

      const prompt = sessions.generatePrimePrompt(updated, engine);
      assert.equal(prompt.includes('## Active Extension Rules'), false, 'no Active Extension Rules heading');
      assert.equal(prompt.includes('**independentCritic**:'), false, 'no rule definitions');
      assert.equal(prompt.includes('**docsParity**:'), false, 'no rule definitions');

      store.projects.update(project.id, { methodology: 'minimal' });
    });

    it('does not list plain rule names either (#102 — extension rules block fully removed)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      const projConfig = store.projectConfig.load(project.path);
      projConfig.rules = projConfig.rules || { extensions: {} };
      projConfig.rules.extensions.customRule = true;
      store.projectConfig.save(project.path, projConfig);

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.equal(prompt.includes('## Active Extension Rules'), false, 'no Active Extension Rules heading');
      assert.equal(prompt.includes('- customRule'), false, 'no rule list');

      delete projConfig.rules.extensions.customRule;
      store.projectConfig.save(project.path, projConfig);
    });

    it('does not inject Previous Methodology Archives (#102 — AI can find filesystem itself)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      const projConfig = store.projectConfig.load(project.path);
      projConfig.methodologyArchives = [
        { archivePath: '.tangleclaw/project.json.archived/2025-12-01', methodology: 'minimal' }
      ];
      store.projectConfig.save(project.path, projConfig);

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.equal(prompt.includes('## Previous Methodology Archives'), false);
      assert.equal(prompt.includes('archived'), false, 'no archive pointer text');

      delete projConfig.methodologyArchives;
      store.projectConfig.save(project.path, projConfig);
    });

    it('prime carries header + branding flourish on a clean project (no learnings, no last session, no audit mode)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');
      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.match(prompt, /^# Session Start — prime-test/m, 'header present');
      assert.match(prompt, /\*TangleClaw'd into existence\.\*/, 'branding flourish present');
    });

    it('does not inject Project Version Recording protocol (#101 — TC owns the writer)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');
      const prompt = sessions.generatePrimePrompt(project, engine);

      assert.equal(prompt.includes('## Project Version Recording'), false, 'prime should not include version-recording heading');
      assert.equal(prompt.includes('.tangleclaw/project-version.txt'), false, 'prime should not reference cache file path');
      assert.equal(prompt.includes('git describe'), false, 'prime should not mention git tags as a fallback');
      assert.equal(prompt.includes('recorded_at:'), false, 'prime should not show cache file format');
    });

    it('omits version recording for all methodologies (#101)', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      store.projects.update(project.id, { methodology: 'prawduct' });
      const prawductPrompt = sessions.generatePrimePrompt(store.projects.getByName('prime-test'), engine);
      assert.equal(prawductPrompt.includes('## Project Version Recording'), false, 'prawduct prime should not include version recording');

      store.projects.update(project.id, { methodology: 'minimal' });
      const minimalPrompt = sessions.generatePrimePrompt(store.projects.getByName('prime-test'), engine);
      assert.equal(minimalPrompt.includes('## Project Version Recording'), false, 'minimal prime should not include version recording');
    });
  });

  describe('_buildLaunchCommand', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('builds command from engine profile', () => {
      const cmd = sessions._buildLaunchCommand({
        launch: { shellCommand: 'claude', args: ['--verbose'], env: {} }
      });
      assert.equal(cmd, 'claude --verbose');
    });

    it('handles no args', () => {
      const cmd = sessions._buildLaunchCommand({
        launch: { shellCommand: 'codex', args: [], env: {} }
      });
      assert.equal(cmd, 'codex');
    });

    it('returns undefined when no launch config', () => {
      const cmd = sessions._buildLaunchCommand({});
      assert.equal(cmd, undefined);
    });

    it('appends launch mode args when mode is specified', () => {
      const cmd = sessions._buildLaunchCommand({
        launch: { shellCommand: 'claude', args: [], env: {} },
        launchModes: {
          auto: { label: 'Auto', args: ['--permission-mode', 'auto', '--enable-auto-mode'] }
        }
      }, null, 'auto');
      assert.equal(cmd, 'claude --permission-mode auto --enable-auto-mode');
    });

    it('ignores launch mode when mode key does not exist', () => {
      const cmd = sessions._buildLaunchCommand({
        launch: { shellCommand: 'claude', args: ['--verbose'], env: {} },
        launchModes: {
          auto: { label: 'Auto', args: ['--permission-mode', 'auto'] }
        }
      }, null, 'nonexistent');
      assert.equal(cmd, 'claude --verbose');
    });

    it('ignores launch mode when engine has no launchModes', () => {
      const cmd = sessions._buildLaunchCommand({
        launch: { shellCommand: 'codex', args: [], env: {} }
      }, null, 'auto');
      assert.equal(cmd, 'codex');
    });

    it('appends mode args after static args', () => {
      const cmd = sessions._buildLaunchCommand({
        launch: { shellCommand: 'claude', args: ['--verbose'], env: {} },
        launchModes: {
          plan: { label: 'Plan', args: ['--permission-mode', 'plan'] }
        }
      }, null, 'plan');
      assert.equal(cmd, 'claude --verbose --permission-mode plan');
    });
  });

  describe('_resolvePreKeys', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns mode-level preKeys when mode defines them', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [] },
        launchModes: {
          bypassPermissions: { label: 'Bypass', args: ['--dangerously-skip-permissions'], preKeys: ['2'], preKeyDelay: 2000 }
        }
      }, 'bypassPermissions');
      assert.deepEqual(result.preKeys, ['2']);
      assert.equal(result.preKeyDelay, 2000);
    });

    it('falls back to engine-level preKeys when mode has none', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'codex', args: [], preKeys: ['Enter', 'Enter'], preKeyDelay: 3000 },
        launchModes: {
          default: { label: 'Interactive', args: [] }
        }
      }, 'default');
      assert.deepEqual(result.preKeys, ['Enter', 'Enter']);
      assert.equal(result.preKeyDelay, 3000);
    });

    it('falls back to engine-level preKeys when launchMode is null', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'codex', args: [], preKeys: ['Enter'], preKeyDelay: 2500 }
      }, null);
      assert.deepEqual(result.preKeys, ['Enter']);
      assert.equal(result.preKeyDelay, 2500);
    });

    it('returns null preKeys when neither mode nor engine define them', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [] },
        launchModes: {
          default: { label: 'Interactive', args: [] }
        }
      }, 'default');
      assert.equal(result.preKeys, null);
      assert.equal(result.preKeyDelay, 0);
    });

    it('returns null preKeys for engine with no launch config', () => {
      const result = sessions._resolvePreKeys({}, null);
      assert.equal(result.preKeys, null);
      assert.equal(result.preKeyDelay, 0);
    });

    it('uses mode preKeyDelay over engine preKeyDelay', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [], preKeyDelay: 1000 },
        launchModes: {
          bypassPermissions: { label: 'Bypass', args: [], preKeys: ['2'], preKeyDelay: 3000 }
        }
      }, 'bypassPermissions');
      assert.equal(result.preKeyDelay, 3000);
    });

    it('falls back to engine preKeyDelay when mode omits it', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [], preKeyDelay: 1500 },
        launchModes: {
          bypassPermissions: { label: 'Bypass', args: [], preKeys: ['2'] }
        }
      }, 'bypassPermissions');
      assert.equal(result.preKeyDelay, 1500);
    });

    it('defaults preKeyDelay to 2000 when neither mode nor engine specify it', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [] },
        launchModes: {
          bypassPermissions: { label: 'Bypass', args: [], preKeys: ['2'] }
        }
      }, 'bypassPermissions');
      assert.equal(result.preKeyDelay, 2000);
    });

    it('ignores mode preKeys for nonexistent mode key', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [], preKeys: ['Enter'] },
        launchModes: {
          bypassPermissions: { label: 'Bypass', args: [], preKeys: ['2'] }
        }
      }, 'nonexistent');
      assert.deepEqual(result.preKeys, ['Enter']);
    });

    it('skips empty preKeys arrays', () => {
      const result = sessions._resolvePreKeys({
        launch: { shellCommand: 'claude', args: [], preKeys: ['Enter'] },
        launchModes: {
          default: { label: 'Interactive', args: [], preKeys: [] }
        }
      }, 'default');
      // Empty mode preKeys should fall through to engine-level
      assert.deepEqual(result.preKeys, ['Enter']);
    });
  });

  describe('detectIdle', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns not idle when no cached output', () => {
      sessions.clearIdleCache('nonexistent-session');
      const result = sessions.detectIdle('nonexistent-session');
      // tmux.capturePane will fail for nonexistent session, returning idle: false
      assert.equal(result.idle, false);
    });
  });

  describe('getSessionStatus (no active session)', () => {
    let sessions;
    const tmux = require('../lib/tmux');

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns null for unknown project', () => {
      const status = sessions.getSessionStatus('nonexistent-project');
      assert.equal(status, null);
    });

    it('returns inactive status with last session', () => {
      const status = sessions.getSessionStatus('prime-test');
      assert.ok(status);
      assert.equal(status.active, false);
      assert.equal(status.project, 'prime-test');
      assert.ok(status.lastSession);
      assert.equal(status.lastSession.status, 'wrapped');
    });

    it('returns active+untracked when tmux session exists but DB has no active record', () => {
      // Mock tmux.hasSession to return true for prime-test
      const originalHasSession = tmux.hasSession;
      tmux.hasSession = (name) => name === 'prime-test';
      try {
        // prime-test has a wrapped (not active) DB session, but tmux says it exists
        const status = sessions.getSessionStatus('prime-test');
        assert.ok(status);
        assert.equal(status.active, true);
        assert.equal(status.untracked, true);
        assert.equal(status.tmuxSession, 'prime-test');
        assert.equal(status.engine, null);
      } finally {
        tmux.hasSession = originalHasSession;
      }
    });
  });

  describe('injectCommand', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.injectCommand('nonexistent', 'ls');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('not found'));
    });

    it('returns error when no active session', () => {
      const result = sessions.injectCommand('prime-test', 'ls');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('No active session'));
    });

    it('rejects commands exceeding 4096 characters', () => {
      const longCommand = 'x'.repeat(4097);
      const result = sessions.injectCommand('prime-test', longCommand);
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('maximum length'));
    });
  });

  describe('peek', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.peek('nonexistent');
      assert.equal(result.lines, null);
      assert.ok(result.error.includes('not found'));
    });

    it('returns error when no active session', () => {
      const result = sessions.peek('prime-test');
      assert.equal(result.lines, null);
      assert.ok(result.error.includes('No active session'));
    });

    it('accepts options object with lines param', () => {
      const result = sessions.peek('nonexistent', { lines: 50 });
      assert.equal(result.lines, null);
      assert.ok(result.error.includes('not found'));
    });

    it('accepts options object with full param', () => {
      const result = sessions.peek('nonexistent', { full: true });
      assert.equal(result.lines, null);
      assert.ok(result.error.includes('not found'));
    });
  });

  describe('triggerWrap', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.triggerWrap('nonexistent');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('not found'));
    });

    it('returns error when no active session', () => {
      const result = sessions.triggerWrap('prime-test');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('No active session'));
    });
  });

  describe('killSession', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.killSession('nonexistent');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('not found'));
    });

    it('returns error when no active session', () => {
      const result = sessions.killSession('prime-test');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('No active session'));
    });

    it('releases document locks on kill', () => {
      const project = store.projects.getByName('prime-test');

      // Create a group, doc, and lock
      const group = store.projectGroups.create({ name: 'KillLockGroup' });
      store.projectGroups.addMember(group.id, project.id);
      const doc = store.sharedDocs.create({
        groupId: group.id,
        name: 'KillLockDoc',
        filePath: '/tmp/kill-lock.md',
        injectIntoConfig: true
      });

      // Start a session
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'kill-lock-test'
      });

      // Acquire lock
      store.documentLocks.acquire(doc.id, session.id, 'prime-test');
      assert.ok(store.documentLocks.check(doc.id), 'Lock should be acquired');

      // Kill the session
      sessions.killSession('prime-test');

      // Lock should be released
      assert.equal(store.documentLocks.check(doc.id), null, 'Lock should be released after kill');

      // Clean up
      store.sharedDocs.delete(doc.id);
      store.projectGroups.delete(group.id);
    });
  });

  describe('killSession recovers wrapping + orphan tmux (#105)', () => {
    let sessions;
    const tmux = require('../lib/tmux');
    let originalHasSession;
    let originalKillSession;
    let killedTmux;

    before(() => {
      sessions = require('../lib/sessions');
    });

    beforeEach(() => {
      originalHasSession = tmux.hasSession;
      originalKillSession = tmux.killSession;
      killedTmux = [];
      tmux.killSession = (name) => { killedTmux.push(name); };
    });

    afterEach(() => {
      tmux.hasSession = originalHasSession;
      tmux.killSession = originalKillSession;
      // Cleanup any leftover wrapping/active rows so tests are independent
      const project = store.projects.getByName('prime-test');
      if (project) {
        const wrapping = store.sessions.getWrapping(project.id);
        if (wrapping) store.sessions.kill(wrapping.id, 'test cleanup');
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.kill(active.id, 'test cleanup');
      }
    });

    it('kills wrapping session when tmux is alive', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'kill-wrapping-alive'
      });
      store.sessions.setWrapping(session.id);
      tmux.hasSession = (name) => name === 'kill-wrapping-alive';

      const result = sessions.killSession('prime-test', 'user kill while wrapping');

      assert.equal(result.error, null);
      assert.ok(result.session, 'should return killed session');
      assert.equal(result.session.status, 'killed');
      assert.deepEqual(killedTmux, ['kill-wrapping-alive'], 'tmux session should be killed');
    });

    it('kills wrapping session when tmux is already dead — reconciles DB only', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'kill-wrapping-dead'
      });
      store.sessions.setWrapping(session.id);
      tmux.hasSession = () => false;

      const result = sessions.killSession('prime-test');

      assert.equal(result.error, null);
      assert.ok(result.session);
      assert.equal(result.session.status, 'killed');
      assert.deepEqual(killedTmux, [], 'should not call tmux.killSession when session is dead');
    });

    it('reconciles orphan tmux when no DB row exists', () => {
      // No active and no wrapping row — but tmux still has a session.
      tmux.hasSession = (name) => name === 'prime-test';

      const result = sessions.killSession('prime-test', 'cleanup orphan');

      assert.equal(result.error, null);
      assert.equal(result.session, null);
      assert.equal(result.reconciled, true);
      assert.deepEqual(killedTmux, ['prime-test'], 'orphan tmux should be killed under the project name');
    });

    it('returns NOT_FOUND-style error when no DB row and no orphan tmux', () => {
      tmux.hasSession = () => false;

      const result = sessions.killSession('prime-test');

      assert.equal(result.session, null);
      assert.ok(result.error.includes('No active session'));
      assert.ok(!result.reconciled);
      assert.deepEqual(killedTmux, []);
    });

    it('clears wrap pane cache when killing wrapping session', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'kill-wrapping-cache'
      });
      store.sessions.setWrapping(session.id);
      sessions._wrapPaneCache.set(session.id, 'cached pane output');
      tmux.hasSession = () => true;

      sessions.killSession('prime-test');

      assert.equal(sessions._wrapPaneCache.has(session.id), false, 'cache entry should be cleared');
    });

    it('prefers active over wrapping when both somehow exist', () => {
      // Defensive: there shouldn't normally be both, but if a future bug allows
      // it the kill button must target the active row first.
      const project = store.projects.getByName('prime-test');
      const wrappingSession = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'kill-priority-wrap'
      });
      store.sessions.setWrapping(wrappingSession.id);
      const activeSession = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'kill-priority-active'
      });
      tmux.hasSession = () => true;

      const result = sessions.killSession('prime-test');

      assert.equal(result.session.id, activeSession.id, 'should target the active row');
      assert.deepEqual(killedTmux, ['kill-priority-active']);

      // Cleanup the still-wrapping row
      store.sessions.kill(wrappingSession.id, 'test cleanup');
    });
  });

  describe('completeWrap', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.completeWrap('nonexistent', 'summary');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('not found'));
    });

    it('releases document locks on wrap', () => {
      const project = store.projects.getByName('prime-test');

      // Create a group, doc, and lock
      const group = store.projectGroups.create({ name: 'WrapLockGroup' });
      store.projectGroups.addMember(group.id, project.id);
      const doc = store.sharedDocs.create({
        groupId: group.id,
        name: 'WrapLockDoc',
        filePath: '/tmp/wrap-lock.md',
        injectIntoConfig: true
      });

      // Start a session
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'wrap-lock-test'
      });

      // Acquire lock
      store.documentLocks.acquire(doc.id, session.id, 'prime-test');
      assert.ok(store.documentLocks.check(doc.id), 'Lock should be acquired');

      // Mark as wrapping and complete
      store.sessions.setWrapping(session.id);
      sessions.completeWrap('prime-test', 'test wrap');

      // Lock should be released
      assert.equal(store.documentLocks.check(doc.id), null, 'Lock should be released after wrap');

      // Clean up
      store.sharedDocs.delete(doc.id);
      store.projectGroups.delete(group.id);
    });
  });

  describe('parseWrapSummary', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('extracts structured fields from markdown headings', () => {
      const rawOutput = [
        'Some preamble',
        '## summary',
        'We completed chunk 5',
        'All tests pass',
        '## nextSteps',
        'Start chunk 6',
        '## learnings',
        'Wrap parsing is tricky'
      ].join('\n');

      const result = sessions.parseWrapSummary(rawOutput, ['summary', 'nextSteps', 'learnings']);
      assert.ok(result.includes('## summary'));
      assert.ok(result.includes('We completed chunk 5'));
      assert.ok(result.includes('## nextSteps'));
      assert.ok(result.includes('Start chunk 6'));
      assert.ok(result.includes('## learnings'));
    });

    it('falls back to last 50 lines when no fields match', () => {
      const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
      const rawOutput = lines.join('\n');

      const result = sessions.parseWrapSummary(rawOutput, ['nonexistent']);
      assert.ok(result.includes('line 59'));
      assert.ok(result.includes('line 10'));
      assert.ok(!result.includes('line 9'));
    });

    it('returns empty string for empty input', () => {
      const result = sessions.parseWrapSummary('', ['summary']);
      assert.equal(result, '');
    });

    it('falls back to raw output when no captureFields provided', () => {
      const result = sessions.parseWrapSummary('some output', []);
      assert.equal(result, 'some output');
    });
  });

  describe('autoCompleteWrap', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('wraps session with cached pane output', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'auto-wrap-test'
      });
      store.sessions.setWrapping(session.id);

      // Simulate cached pane output
      sessions._wrapPaneCache.set(session.id, '## summary\nDone with chunk\n## nextSteps\nNext chunk');

      const result = sessions.autoCompleteWrap(project, session);
      assert.ok(result);
      assert.equal(result.status, 'wrapped');
      assert.ok(result.wrapSummary.includes('Done with chunk'));
    });

    it('handles missing cache gracefully', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'auto-wrap-empty-test'
      });
      store.sessions.setWrapping(session.id);

      const result = sessions.autoCompleteWrap(project, session);
      assert.ok(result);
      assert.equal(result.status, 'wrapped');
      // Empty cache → empty string → store converts to null
      assert.equal(result.wrapSummary, null);
    });
  });

  describe('triggerWrap (methodology-driven)', () => {
    let sessions;
    const tmux = require('../lib/tmux');
    let originalSendKeys;
    let originalHasSession;
    let sentCommand;

    before(() => {
      sessions = require('../lib/sessions');
    });

    beforeEach(() => {
      originalSendKeys = tmux.sendKeys;
      originalHasSession = tmux.hasSession;
      sentCommand = null;
      tmux.sendKeys = (name, cmd, opts) => { sentCommand = cmd; };
      tmux.hasSession = () => true;
    });

    afterEach(() => {
      tmux.sendKeys = originalSendKeys;
      tmux.hasSession = originalHasSession;
      // Cleanup active/wrapping sessions and restore methodology
      const project = store.projects.getByName('prime-test');
      if (project) {
        store.projects.update(project.id, { methodology: 'minimal' });
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.kill(active.id, 'test cleanup');
        const wrapping = store.sessions.getWrapping(project.id);
        if (wrapping) store.sessions.wrap(wrapping.id, 'test cleanup');
      }
    });

    it('sets session to wrapping status', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-test'
      });

      const result = sessions.triggerWrap('prime-test');
      assert.ok(result.ok);
      assert.equal(result.sessionId, session.id);

      // Session should now be wrapping
      const wrapping = store.sessions.getWrapping(project.id);
      assert.ok(wrapping);
      assert.equal(wrapping.id, session.id);
    });

    it('returns wrapSteps and captureFields', () => {
      const project = store.projects.getByName('prime-test');
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-fields-test'
      });

      const result = sessions.triggerWrap('prime-test');
      assert.ok(result.ok);
      assert.ok(Array.isArray(result.wrapSteps));
      assert.ok(Array.isArray(result.captureFields));
    });

    it('does NOT inject version-recording instruction in wrap command (#101 — TC owns the writer)', () => {
      const project = store.projects.getByName('prime-test');
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-version-test'
      });

      sessions.triggerWrap('prime-test');
      assert.ok(sentCommand, 'should have sent a command');
      assert.equal(sentCommand.includes('project-version.txt'), false, 'wrap command should not reference version cache file');
      assert.equal(sentCommand.includes('re-check the project version'), false, 'wrap command should not include re-record instruction');
    });

    it('writes project-version.txt directly during wrap (#101)', () => {
      const project = store.projects.getByName('prime-test');
      store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'trigger-wrap-tc-writer-test'
      });

      const cachePath = path.join(project.path, '.tangleclaw', 'project-version.txt');
      // Remove any prior recording so we can detect this wrap's write.
      try { fs.rmSync(cachePath, { force: true }); } catch {}

      sessions.triggerWrap('prime-test');
      assert.ok(fs.existsSync(cachePath), 'wrap should produce the version cache file');
      const body = fs.readFileSync(cachePath, 'utf8');
      assert.match(body, /^version:\s*\S+/m, 'cache file should contain a version: line');
      assert.match(body, /^source:\s*\S+/m, 'cache file should contain a source: line');
      assert.match(body, /^recorded_at:\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m, 'recorded_at should be ISO-8601 UTC');
    });

    it('preserves custom wrap command without injecting any version protocol (#101)', () => {
      const skills = require('../lib/skills');
      const originalGetWrapSkill = skills.getWrapSkill;
      skills.getWrapSkill = () => ({
        command: '/custom-wrap --fast',
        steps: ['commit'],
        captureFields: ['summary']
      });

      try {
        const project = store.projects.getByName('prime-test');
        store.sessions.start({
          projectId: project.id,
          engineId: 'claude',
          tmuxSession: 'trigger-wrap-custom-cmd-test'
        });

        sessions.triggerWrap('prime-test');
        assert.ok(sentCommand, 'should have sent a command');
        assert.ok(sentCommand.includes('/custom-wrap --fast'), 'should start with custom command');
        assert.equal(sentCommand.includes('project-version.txt'), false, 'custom-command wrap should not include version protocol');
        assert.equal(sentCommand.includes('re-check the project version'), false, 'custom-command wrap should not include re-record instruction');
      } finally {
        skills.getWrapSkill = originalGetWrapSkill;
      }
    });
  });

  describe('wrap state persistence (#91)', () => {
    let sessions;
    const tmux = require('../lib/tmux');
    let originalHasSession, originalCapturePane, originalKillSession;

    before(() => {
      sessions = require('../lib/sessions');
    });

    beforeEach(() => {
      originalHasSession = tmux.hasSession;
      originalCapturePane = tmux.capturePane;
      originalKillSession = tmux.killSession;
      tmux.hasSession = () => true;
      tmux.capturePane = () => ['line1', 'line2', 'line3'];
      tmux.killSession = () => {};
    });

    afterEach(() => {
      tmux.hasSession = originalHasSession;
      tmux.capturePane = originalCapturePane;
      tmux.killSession = originalKillSession;
      // Cleanup wrapping sessions
      const project = store.projects.getByName('prime-test');
      if (project) {
        const wrapping = store.sessions.getWrapping(project.id);
        if (wrapping) store.sessions.wrap(wrapping.id, 'test cleanup');
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.kill(active.id, 'test cleanup');
      }
    });

    it('getSessionStatus stays wrapping while tmux is alive', () => {
      const project = store.projects.getByName('prime-test');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'wrap-stays-active-test'
      });
      store.sessions.setWrapping(session.id);

      const status = sessions.getSessionStatus('prime-test');
      assert.equal(status.wrapping, true);
      assert.equal(status.active, false);
    });

    it('does not export WRAP_TIMEOUT_MS or _wrapStartTimes — server-side timeout removed', () => {
      assert.equal(sessions.WRAP_TIMEOUT_MS, undefined);
      assert.equal(sessions._wrapStartTimes, undefined);
    });
  });

  describe('getSessionHistory', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.getSessionHistory('nonexistent');
      assert.deepEqual(result.sessions, []);
      assert.ok(result.error.includes('not found'));
    });

    it('returns session history for known project', () => {
      const result = sessions.getSessionHistory('prime-test');
      assert.ok(result.sessions.length > 0);
      assert.ok(result.total > 0);
      assert.equal(result.error, null);
    });

    it('respects limit option', () => {
      const result = sessions.getSessionHistory('prime-test', { limit: 1 });
      assert.equal(result.sessions.length, 1);
    });

    it('history entries have expected fields', () => {
      const result = sessions.getSessionHistory('prime-test');
      const entry = result.sessions[0];
      assert.ok('id' in entry);
      assert.ok('engine' in entry);
      assert.ok('startedAt' in entry);
      assert.ok('status' in entry);
    });
  });

  describe('launchSession validation', () => {
    let sessions;

    before(() => {
      sessions = require('../lib/sessions');
    });

    it('returns error for unknown project', () => {
      const result = sessions.launchSession('nonexistent');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('not found'));
    });

    it('returns error for archived project', () => {
      const projDir = path.join(projectsDir, 'archived-proj');
      fs.mkdirSync(projDir, { recursive: true });
      const proj = store.projects.create({
        name: 'archived-proj',
        path: projDir,
        engine: 'claude',
        methodology: 'minimal'
      });
      store.projects.archive(proj.id);

      const result = sessions.launchSession('archived-proj');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('archived'));
    });

    it('returns error for unavailable engine', () => {
      // Create a project with an unavailable engine
      const projDir = path.join(projectsDir, 'bad-engine');
      fs.mkdirSync(projDir, { recursive: true });
      store.projects.create({
        name: 'bad-engine',
        path: projDir,
        engine: 'genesis',
        methodology: 'minimal'
      });

      const result = sessions.launchSession('bad-engine');
      assert.equal(result.session, null);
      assert.ok(result.error.includes('not available'));
    });
  });

  describe('launchSession adopts orphaned tmux session', () => {
    const tmux = require('../lib/tmux');
    const enginesModule = require('../lib/engines');
    let sessions;
    let originalHasSession;
    let originalDetectEngine;

    before(() => {
      sessions = require('../lib/sessions');

      // Create a project with the claude engine
      const projDir = path.join(projectsDir, 'orphan-test');
      fs.mkdirSync(projDir, { recursive: true });
      store.projects.create({
        name: 'orphan-test',
        path: projDir,
        engine: 'claude',
        methodology: 'minimal'
      });
    });

    beforeEach(() => {
      originalHasSession = tmux.hasSession;
      originalDetectEngine = enginesModule.detectEngine;
    });

    afterEach(() => {
      tmux.hasSession = originalHasSession;
      enginesModule.detectEngine = originalDetectEngine;
      // Clean up any active sessions so tests are independent
      const project = store.projects.getByName('orphan-test');
      if (project) {
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.kill(active.id, 'test cleanup');
      }
    });

    it('adopts orphaned tmux session instead of failing', () => {
      // Mock: tmux session exists, engine is available
      tmux.hasSession = (name) => name === 'orphan-test';
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const result = sessions.launchSession('orphan-test');

      assert.equal(result.error, null);
      assert.ok(result.session, 'should return a session');
      assert.equal(result.session.tmuxSession, 'orphan-test');
      assert.equal(result.session.engineId, 'claude');
    });

    it('writes project-version.txt during launch (#101 — TC owns the writer)', () => {
      tmux.hasSession = (name) => name === 'orphan-test';
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const project = store.projects.getByName('orphan-test');
      const cachePath = path.join(project.path, '.tangleclaw', 'project-version.txt');
      const seededPkgPath = path.join(project.path, 'package.json');
      try { fs.rmSync(cachePath, { force: true }); } catch {}
      try {
        // Seed a version source so detection has something to write.
        fs.writeFileSync(seededPkgPath, '{"version": "0.1.0"}\n');

        const result = sessions.launchSession('orphan-test');
        assert.equal(result.error, null);
        assert.ok(fs.existsSync(cachePath), 'project-version.txt should exist after launch');
        const body = fs.readFileSync(cachePath, 'utf8');
        assert.match(body, /^version: 0\.1\.0$/m);
        assert.match(body, /^source: package\.json$/m);
        assert.match(body, /^recorded_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
      } finally {
        // Test isolation (Critic MINOR): leaving the seeded package.json behind
        // would let the next test in this suite hit a different detection layer.
        try { fs.rmSync(seededPkgPath, { force: true }); } catch {}
        try { fs.rmSync(cachePath, { force: true }); } catch {}
        try { fs.rmSync(path.dirname(cachePath), { recursive: true, force: true }); } catch {}
      }
    });
  });

  describe('launchSession stale wrapping recovery (#105)', () => {
    const tmux = require('../lib/tmux');
    const enginesModule = require('../lib/engines');
    let sessions;
    let originalHasSession;
    let originalDetectEngine;
    let originalKillSession;
    let originalCreateSession;
    let killedTmux;

    before(() => {
      sessions = require('../lib/sessions');
      // Project for launch-guard tests
      const projDir = path.join(projectsDir, 'stale-wrap');
      fs.mkdirSync(projDir, { recursive: true });
      store.projects.create({
        name: 'stale-wrap',
        path: projDir,
        engine: 'claude',
        methodology: 'minimal'
      });
    });

    beforeEach(() => {
      originalHasSession = tmux.hasSession;
      originalDetectEngine = enginesModule.detectEngine;
      originalKillSession = tmux.killSession;
      originalCreateSession = tmux.createSession;
      killedTmux = [];
      tmux.killSession = (name) => { killedTmux.push(name); };
      tmux.createSession = () => true;
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });
    });

    afterEach(() => {
      tmux.hasSession = originalHasSession;
      tmux.killSession = originalKillSession;
      tmux.createSession = originalCreateSession;
      enginesModule.detectEngine = originalDetectEngine;
      const project = store.projects.getByName('stale-wrap');
      if (project) {
        const wrapping = store.sessions.getWrapping(project.id);
        if (wrapping) store.sessions.kill(wrapping.id, 'test cleanup');
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.kill(active.id, 'test cleanup');
      }
    });

    /**
     * Force a session row's wrap_started_at to a past timestamp (simulating a
     * wrap that has been stuck for `hoursAgo` hours). Uses store.getDb()
     * directly since there is no public mutator for this column — appropriate
     * here because the field is otherwise managed exclusively by setWrapping.
     */
    function _backdateWrapStart(sessionId, hoursAgo) {
      const db = store.getDb();
      db.prepare(`UPDATE sessions SET wrap_started_at = datetime('now', ?) WHERE id = ?`)
        .run(`-${hoursAgo} hours`, sessionId);
    }

    function _backdateStartedAt(sessionId, hoursAgo) {
      const db = store.getDb();
      db.prepare(`UPDATE sessions SET started_at = datetime('now', ?) WHERE id = ?`)
        .run(`-${hoursAgo} hours`, sessionId);
    }

    function _clearWrapStart(sessionId) {
      const db = store.getDb();
      db.prepare('UPDATE sessions SET wrap_started_at = NULL WHERE id = ?').run(sessionId);
    }

    it('recovers stale wrapping row (>1h) and proceeds with fresh launch', () => {
      const project = store.projects.getByName('stale-wrap');
      // Distinct tmux name on the wrapping row so the recovery-kill is
      // distinguishable from the pre-launch orphan-kill that fires later in
      // launchSession against the project's canonical tmux name (Critic MINOR).
      const stale = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'stale-wrap-OLD'
      });
      store.sessions.setWrapping(stale.id);
      _backdateWrapStart(stale.id, 2); // wrap began 2h ago — well past threshold
      tmux.hasSession = (name) => name === 'stale-wrap-OLD' || name === 'stale-wrap';

      const result = sessions.launchSession('stale-wrap');

      assert.equal(result.error, null, 'launch should proceed');
      assert.ok(result.session, 'fresh session should be created');
      assert.notEqual(result.session.id, stale.id, 'should be a new session row');
      assert.ok(killedTmux.includes('stale-wrap-OLD'),
        'stale wrapping tmux name should have been killed during recovery branch');

      // Original wrapping row should now be marked killed
      const recovered = store.sessions.list(project.id, { status: 'killed', limit: 5 })
        .find((s) => s.id === stale.id);
      assert.ok(recovered, 'stale row should be marked killed');
      assert.equal(recovered.status, 'killed');
    });

    it('falls back to recovery (not block) when timestamps are unparseable', () => {
      // Defense for MINOR 5: a wrapping row with corrupt timestamps must not
      // brick the project. Fail-safe direction is "recover" since that's the
      // entire bug class #105 was filed for.
      const project = store.projects.getByName('stale-wrap');
      const corrupt = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'corrupt-wrap'
      });
      store.sessions.setWrapping(corrupt.id);
      const db = store.getDb();
      db.prepare("UPDATE sessions SET wrap_started_at = '<not a date>', started_at = '<not a date>' WHERE id = ?")
        .run(corrupt.id);
      tmux.hasSession = () => true;

      const result = sessions.launchSession('stale-wrap');
      assert.equal(result.error, null, 'corrupt timestamps must not block launch');
      assert.ok(result.session);
    });

    it('blocks launch when wrapping row is recent (<1h) and tmux is alive', () => {
      const project = store.projects.getByName('stale-wrap');
      const recent = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'recent-wrap'
      });
      store.sessions.setWrapping(recent.id);
      // wrap_started_at defaults to now (just set by setWrapping) — well within threshold
      tmux.hasSession = (name) => name === 'recent-wrap';

      const result = sessions.launchSession('stale-wrap');

      assert.equal(result.session, null);
      assert.ok(result.error.includes('currently wrapping'));
      assert.deepEqual(killedTmux, [], 'recent wrap should not be killed');
    });

    it('falls back to started_at for legacy rows with NULL wrap_started_at', () => {
      // Legacy row predates schema v14 — wrap_started_at is NULL but the row
      // is in wrapping status with an old started_at. Should still recover.
      const project = store.projects.getByName('stale-wrap');
      const legacy = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'legacy-wrap-OLD'
      });
      store.sessions.setWrapping(legacy.id);
      _clearWrapStart(legacy.id);
      _backdateStartedAt(legacy.id, 3); // started 3h ago
      tmux.hasSession = (name) => name === 'legacy-wrap-OLD' || name === 'stale-wrap';

      const result = sessions.launchSession('stale-wrap');

      assert.equal(result.error, null, 'legacy stale row should be recovered too');
      assert.ok(result.session);
      assert.notEqual(result.session.id, legacy.id);
      assert.ok(killedTmux.includes('legacy-wrap-OLD'),
        'legacy stale tmux name should have been killed during recovery');
    });

    it('STALE_WRAPPING_THRESHOLD_MS is 1 hour', () => {
      assert.equal(sessions.STALE_WRAPPING_THRESHOLD_MS, 60 * 60 * 1000);
    });

    it('setWrapping populates wrap_started_at on transition (schema v14)', () => {
      const project = store.projects.getByName('stale-wrap');
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude',
        tmuxSession: 'set-wrapping-timestamp'
      });
      const wrapped = store.sessions.setWrapping(session.id);
      assert.ok(wrapped, 'setWrapping should return updated row');
      assert.equal(wrapped.status, 'wrapping');
      assert.ok(wrapped.wrapStartedAt, 'wrap_started_at should be populated');
      // Should be within the last few seconds. Parse as UTC since SQLite emits
      // a TZ-less string and the test machine may not be in UTC.
      const ageMs = Date.now() - sessions._parseSqliteUtcMs(wrapped.wrapStartedAt);
      assert.ok(ageMs < 5000, `wrap_started_at should be very recent (got ageMs=${ageMs})`);
      assert.ok(ageMs >= 0, `wrap_started_at should not be in the future (got ageMs=${ageMs})`);
    });

    it('_parseSqliteUtcMs interprets TZ-less SQLite timestamps as UTC', () => {
      // SQLite emits 'YYYY-MM-DD HH:MM:SS' without timezone — should parse as UTC.
      const tzLess = '2026-04-29 05:00:00';
      const withZ = '2026-04-29T05:00:00Z';
      assert.equal(sessions._parseSqliteUtcMs(tzLess), Date.parse(withZ));
      // Also handle inputs that already have Z or offset
      assert.equal(sessions._parseSqliteUtcMs(withZ), Date.parse(withZ));
      assert.ok(Number.isNaN(sessions._parseSqliteUtcMs(null)));
      assert.ok(Number.isNaN(sessions._parseSqliteUtcMs('')));
    });
  });

  describe('silent prime delivery (#103)', () => {
    const tmux = require('../lib/tmux');
    const enginesModule = require('../lib/engines');
    let sessions;
    let originalHasSession;
    let originalDetectEngine;

    before(() => {
      sessions = require('../lib/sessions');
      const projDir = path.join(projectsDir, 'silent-prime-test');
      fs.mkdirSync(projDir, { recursive: true });
      store.projects.create({
        name: 'silent-prime-test',
        path: projDir,
        engine: 'claude',
        methodology: 'minimal'
      });
    });

    beforeEach(() => {
      originalHasSession = tmux.hasSession;
      originalDetectEngine = enginesModule.detectEngine;
    });

    afterEach(() => {
      tmux.hasSession = originalHasSession;
      enginesModule.detectEngine = originalDetectEngine;
      const project = store.projects.getByName('silent-prime-test');
      if (project) {
        const active = store.sessions.getActive(project.id);
        if (active) store.sessions.kill(active.id, 'test cleanup');
        // Clean up prime file + project config so each test starts fresh
        try { fs.rmSync(path.join(project.path, '.tangleclaw'), { recursive: true, force: true }); } catch {}
      }
      // Real tmux session may have been spawned by launchSession — clean it up
      // so the next test starts without leftover state.
      try { require('node:child_process').execSync('tmux kill-session -t silent-prime-test 2>/dev/null', { stdio: 'ignore' }); } catch {}
    });

    it('_writePrimeFile creates .tangleclaw/session-prime.md and returns its path', () => {
      const project = store.projects.getByName('silent-prime-test');
      const out = sessions._writePrimeFile(project.path, '# prime\nbody line\n');
      const expected = path.join(project.path, '.tangleclaw', 'session-prime.md');
      assert.equal(out, expected);
      assert.equal(fs.readFileSync(expected, 'utf8'), '# prime\nbody line\n');
    });

    it('_writePrimeFile creates .tangleclaw/ directory when missing', () => {
      const project = store.projects.getByName('silent-prime-test');
      const tcDir = path.join(project.path, '.tangleclaw');
      try { fs.rmSync(tcDir, { recursive: true, force: true }); } catch {}
      assert.equal(fs.existsSync(tcDir), false, 'precondition: .tangleclaw missing');

      sessions._writePrimeFile(project.path, 'body');

      assert.equal(fs.existsSync(tcDir), true);
      assert.equal(fs.existsSync(path.join(tcDir, 'session-prime.md')), true);
    });

    it('_writePrimeFile returns null when the path is unwritable (non-throwing)', () => {
      // Pass a path that cannot be created (parent is a file, not a dir).
      const fakeProject = path.join(projectsDir, 'silent-prime-not-a-dir');
      try { fs.rmSync(fakeProject, { force: true, recursive: true }); } catch {}
      fs.writeFileSync(fakeProject, 'i am a file, not a project');
      try {
        const out = sessions._writePrimeFile(fakeProject, 'body');
        assert.equal(out, null);
      } finally {
        fs.rmSync(fakeProject, { force: true });
      }
    });

    it('launchSession writes prime file when projConfig.silentPrime is true', () => {
      // Mirror the orphan-adoption pattern from the launchSession tests above:
      // pretend a tmux session exists so launchSession kills+recreates rather
      // than failing on whatever stale tmux state may exist on the test host.
      tmux.hasSession = (name) => name === 'silent-prime-test';
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const project = store.projects.getByName('silent-prime-test');
      // Enable silentPrime via project config
      store.projectConfig.save(project.path, {
        engine: 'claude',
        methodology: 'minimal',
        silentPrime: true
      });

      const result = sessions.launchSession('silent-prime-test');
      assert.equal(result.error, null);

      const primeFile = path.join(project.path, '.tangleclaw', 'session-prime.md');
      assert.equal(fs.existsSync(primeFile), true, 'prime file should be written');
      assert.ok(fs.readFileSync(primeFile, 'utf8').length > 0, 'prime file should be non-empty');
    });

    it('launchSession does NOT write prime file when silentPrime is false (default)', () => {
      // Mirror the orphan-adoption pattern from the launchSession tests above:
      // pretend a tmux session exists so launchSession kills+recreates rather
      // than failing on whatever stale tmux state may exist on the test host.
      tmux.hasSession = (name) => name === 'silent-prime-test';
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const project = store.projects.getByName('silent-prime-test');
      // No projConfig save → DEFAULT_PROJECT_CONFIG.silentPrime is false
      const result = sessions.launchSession('silent-prime-test');
      assert.equal(result.error, null);

      const primeFile = path.join(project.path, '.tangleclaw', 'session-prime.md');
      assert.equal(fs.existsSync(primeFile), false, 'prime file should not be written when silent is off');
    });

    it('launchSession does NOT write prime file when engine lacks supportsSilentPrime capability', () => {
      // Stub the claude engine profile to drop the supportsSilentPrime capability,
      // then assert silentPrime=true in projConfig is ignored gracefully.
      // Mirror the orphan-adoption pattern from the launchSession tests above:
      // pretend a tmux session exists so launchSession kills+recreates rather
      // than failing on whatever stale tmux state may exist on the test host.
      tmux.hasSession = (name) => name === 'silent-prime-test';
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const project = store.projects.getByName('silent-prime-test');
      store.projectConfig.save(project.path, {
        engine: 'claude',
        methodology: 'minimal',
        silentPrime: true
      });

      // launchSession reads the engine profile via store.engines.get (not the
      // availability-enriched variant) — patch there so silentPrime resolves to false.
      const origGet = store.engines.get;
      store.engines.get = (id) => {
        const real = origGet(id);
        if (real && real.capabilities) {
          return { ...real, capabilities: { ...real.capabilities, supportsSilentPrime: false } };
        }
        return real;
      };
      try {
        const result = sessions.launchSession('silent-prime-test');
        assert.equal(result.error, null);
        const primeFile = path.join(project.path, '.tangleclaw', 'session-prime.md');
        assert.equal(fs.existsSync(primeFile), false,
          'engines without supportsSilentPrime should fall back to typed prime even if user opted in');
      } finally {
        store.engines.get = origGet;
      }
    });

    it('DEFAULT_PROJECT_CONFIG.silentPrime is false (opt-in until proven)', () => {
      const projDir = path.join(projectsDir, 'silentprime-default-check');
      fs.mkdirSync(projDir, { recursive: true });
      try {
        const cfg = store.projectConfig.load(projDir);
        assert.equal(cfg.silentPrime, false);
      } finally {
        fs.rmSync(projDir, { recursive: true, force: true });
      }
    });

    // ── Chunk 3: prime-file cleanup on silent→typed transition ──

    it('_removePrimeFile removes session-prime.md and returns true', () => {
      const project = store.projects.getByName('silent-prime-test');
      sessions._writePrimeFile(project.path, 'stale prime body');
      const primeFile = path.join(project.path, '.tangleclaw', 'session-prime.md');
      assert.equal(fs.existsSync(primeFile), true, 'precondition: prime file written');

      const result = sessions._removePrimeFile(project.path);
      assert.equal(result, true);
      assert.equal(fs.existsSync(primeFile), false, 'prime file should be gone');
    });

    it('_removePrimeFile returns false when prime file is absent (no-op)', () => {
      const project = store.projects.getByName('silent-prime-test');
      // Ensure the file does NOT exist
      const primeFile = path.join(project.path, '.tangleclaw', 'session-prime.md');
      try { fs.unlinkSync(primeFile); } catch {}

      const result = sessions._removePrimeFile(project.path);
      assert.equal(result, false);
    });

    it('_removePrimeFile is non-throwing when unlink itself fails (exercises catch arm)', () => {
      // Pre-fix Mn2 from final Critic: the original test passed a missing path
      // and exited via the `existsSync === false` branch, never reaching the
      // catch. Stub fs.unlinkSync to throw so we genuinely test the catch path.
      const project = store.projects.getByName('silent-prime-test');
      sessions._writePrimeFile(project.path, 'will be unlinked');
      const fs2 = require('node:fs');
      const original = fs2.unlinkSync;
      fs2.unlinkSync = () => { throw new Error('simulated EACCES'); };
      try {
        const result = sessions._removePrimeFile(project.path);
        assert.equal(result, false, 'returns false when unlink throws');
      } finally {
        fs2.unlinkSync = original;
        // Real cleanup so we don't leak the prime file into other tests.
        try { fs2.unlinkSync(path.join(project.path, '.tangleclaw', 'session-prime.md')); } catch {}
      }
    });

    it('launchSession removes stale prime file when silentPrime flips to false', () => {
      // The transition path: silentPrime was on (file exists), user toggles off,
      // next session launch should clean up the stale file so the SessionStart
      // hook (still installed) doesn't replay yesterday's prime.
      tmux.hasSession = (name) => name === 'silent-prime-test';
      enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/claude' });

      const project = store.projects.getByName('silent-prime-test');
      // Pre-seed a stale prime file (from a prior silent session)
      sessions._writePrimeFile(project.path, '# stale prime from yesterday\n');
      const primeFile = path.join(project.path, '.tangleclaw', 'session-prime.md');
      assert.equal(fs.existsSync(primeFile), true, 'precondition: stale file present');

      // silentPrime now false (the off-by-default config)
      store.projectConfig.save(project.path, {
        engine: 'claude',
        methodology: 'minimal',
        silentPrime: false
      });

      const result = sessions.launchSession('silent-prime-test');
      assert.equal(result.error, null);

      assert.equal(fs.existsSync(primeFile), false,
        'stale prime file should be removed when silentPrime is off');
    });
  });
});
