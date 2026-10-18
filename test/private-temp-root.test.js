'use strict';

/*
 * #2171 — the engine private temp root account on the launch 201 of
 * POST /api/sessions/:project. The route builds each 201 field by field, so a
 * field reaches the caller only where the route copies it, and it has two
 * 201s: the tmux launch's and the web UI launch's. The key is on both, and a
 * caller tells "no root applies" (`null`) from "the server did not say"
 * (absent) by the key being present.
 *
 * A real listening server, because the web UI 201 is written after the
 * handler has returned, once the web UI launch resolves.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const sessions = require('../lib/sessions');
const launchWarmup = require('../lib/launch-warmup');
const strandedCheck = require('../lib/stranded-check');
const { handleRequest } = require('../server');
const { operatorHeaders, sendAs } = require('./_shared-docs-callers');

describe('the launch 201 carries privateTempRoot on every launch path (#2171)', () => {
  let tempDir;
  let prevBase;
  let server;
  let project;
  const real = {
    launchSession: sessions.launchSession,
    launchWebuiSession: sessions.launchWebuiSession,
    warmForLaunch: launchWarmup.warmForLaunch,
    checkAfterLaunch: strandedCheck.checkAfterLaunch
  };

  before(async () => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-private-temp-root-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
    const cfg = store.config.load();
    cfg.setupComplete = true;
    cfg.ingressMode = 'direct';
    cfg.authEnabled = false;
    store.config.save(cfg);
    const dir = fs.mkdtempSync(path.join(tempDir, 'proj-'));
    project = store.projects.create({ name: 'private-temp-root', path: dir, engine: 'claude' });

    // Neither runs `git` or `gh` here: CI has no GitHub to ask, and this file
    // tests only what the route copies into its 201.
    launchWarmup.warmForLaunch = async () => {};
    strandedCheck.checkAfterLaunch = async () => {};

    server = http.createServer(handleRequest);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    Object.assign(sessions, { launchSession: real.launchSession, launchWebuiSession: real.launchWebuiSession });
    launchWarmup.warmForLaunch = real.warmForLaunch;
    strandedCheck.checkAfterLaunch = real.checkAfterLaunch;
    await new Promise((resolve) => server.close(resolve));
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Launch the test project as the operator's dashboard.
   * @returns {Promise<{status: number, data: object}>}
   */
  function launch() {
    return sendAs(server, 'POST', `/api/sessions/${encodeURIComponent(project.name)}`, {}, operatorHeaders(server));
  }

  it('is present and null on the web UI 201, which starts no engine on this host', async () => {
    sessions.launchSession = () => ({ webui: true, _conn: {}, _engineId: 'openclaw', _engineProfile: {}, _project: project });
    sessions.launchWebuiSession = async () => ({
      session: { id: 7, engineId: 'openclaw', startedAt: 'now' },
      iframeUrl: '/openclaw/'
    });
    const res = await launch();
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.sessionMode, 'webui');
    assert.ok(Object.hasOwn(res.data, 'privateTempRoot'), 'the web UI 201 has no privateTempRoot key');
    assert.equal(res.data.privateTempRoot, null);
  });

  it('carries a refused account whole on the tmux 201', async () => {
    const refused = {
      state: 'refused', refusedPath: '/a', problem: 'world-writable', remediation: 'fix /a',
      defaultRoot: { path: '/private/tmp', usable: false, remediation: 'sudo chmod +t /private/tmp' }
    };
    sessions.launchSession = () => ({
      session: { id: 8, engineId: 'claude', sessionMode: 'tmux', tmuxSession: 'x', startedAt: 'now' },
      primePrompt: null, ttydUrl: '/terminal/', error: null, strandedUnchecked: null, privateTempRoot: refused
    });
    const res = await launch();
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.sessionMode, 'tmux');
    assert.deepEqual(res.data.privateTempRoot, refused);
  });
});
