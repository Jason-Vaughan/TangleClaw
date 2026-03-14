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
        engine: 'claude-code',
        methodology: 'minimal'
      });
      projectId = project.id;
    });

    it('generates a prime prompt with project name', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude-code');
      const prompt = sessions.generatePrimePrompt(project, engine);

      assert.ok(prompt.includes('prime-test'));
      assert.ok(prompt.includes('Session Start'));
    });

    it('includes methodology info when template exists', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude-code');

      // Set methodology to one with phases
      store.projects.update(project.id, { methodology: 'minimal' });
      const updatedProject = store.projects.getByName('prime-test');

      const prompt = sessions.generatePrimePrompt(updatedProject, engine);
      assert.ok(prompt.includes('Methodology'));
    });

    it('includes active learnings', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude-code');

      store.learnings.create({
        projectId: project.id,
        content: 'Always validate inputs',
        tier: 'active'
      });

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.ok(prompt.includes('Always validate inputs'));
      assert.ok(prompt.includes('Active Learnings'));
    });

    it('includes last session summary', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude-code');

      // Create and wrap a session in the store
      const session = store.sessions.start({
        projectId: project.id,
        engineId: 'claude-code',
        tmuxSession: 'prime-wrap-test'
      });
      store.sessions.wrap(session.id, 'Completed chunk 4 with 108 tests');

      const prompt = sessions.generatePrimePrompt(project, engine);
      assert.ok(prompt.includes('Last Session Summary'));
      assert.ok(prompt.includes('Completed chunk 4'));
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
});
