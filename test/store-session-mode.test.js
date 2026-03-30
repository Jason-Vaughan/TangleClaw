'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('schema v6: session_mode column', () => {
  let tmpDir;
  let projectId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sessmode-'));
    store._setBasePath(tmpDir);
    store.init();

    // Create a projects directory and project
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const projDir = path.join(projectsDir, 'mode-test');
    fs.mkdirSync(projDir, { recursive: true });

    const project = store.projects.create({
      name: 'mode-test',
      path: projDir,
      engine: 'claude',
      methodology: 'minimal'
    });
    projectId = project.id;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should default session_mode to tmux when not specified', () => {
    const session = store.sessions.start({
      projectId,
      engineId: 'claude',
      tmuxSession: 'test-sess'
    });

    assert.equal(session.sessionMode, 'tmux');
  });

  it('should store session_mode as webui when specified', () => {
    const session = store.sessions.start({
      projectId,
      engineId: 'openclaw:abc123',
      tmuxSession: null,
      sessionMode: 'webui'
    });

    assert.equal(session.sessionMode, 'webui');
  });

  it('should persist session_mode through retrieval', () => {
    const created = store.sessions.start({
      projectId,
      engineId: 'openclaw:abc123',
      sessionMode: 'webui'
    });

    const active = store.sessions.getActive(projectId);
    assert.ok(active);
    assert.equal(active.sessionMode, 'webui');
    assert.equal(active.id, created.id);
  });

  it('should return session_mode in session history', () => {
    store.sessions.start({
      projectId,
      engineId: 'claude',
      tmuxSession: 'hist-test',
      sessionMode: 'tmux'
    });

    const sessions = store.sessions.list(projectId, { limit: 10 });
    assert.ok(sessions.length > 0);
    assert.equal(sessions[0].sessionMode, 'tmux');
  });

  it('should handle schema version 11', () => {
    const db = store.getDb();
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
    assert.equal(row.version, 12);
  });

  it('should have session_mode column in sessions table', () => {
    const db = store.getDb();
    const cols = db.prepare("PRAGMA table_info(sessions)").all();
    const modeCol = cols.find(c => c.name === 'session_mode');
    assert.ok(modeCol, 'session_mode column should exist');
    assert.equal(modeCol.dflt_value, "'tmux'");
  });
});
