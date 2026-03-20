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

    it('includes methodology info when template exists', () => {
      const project = store.projects.getByName('prime-test');
      const engine = store.engines.get('claude');

      // Set methodology to one with phases
      store.projects.update(project.id, { methodology: 'minimal' });
      const updatedProject = store.projects.getByName('prime-test');

      const prompt = sessions.generatePrimePrompt(updatedProject, engine);
      assert.ok(prompt.includes('Methodology'));
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
      // Cleanup active/wrapping sessions
      const project = store.projects.getByName('prime-test');
      if (project) {
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
  });
});
