'use strict';

/*
 * #261 — the parts that only exist once the pieces are wired: the wrap
 * sentinel's tick feeds `lib/engine-errors.js`, and the recorded error reaches
 * the session status payload and the project's `session` object. The parser
 * and the clear rule are pinned in test/engine-errors.test.js; these pin that
 * they are what the server actually asks.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const tmux = require('../lib/tmux');
const engineErrors = require('../lib/engine-errors');
const ws = require('../lib/wrap-sentinel');

const CODEX_400 = '{"type":"error","status":400,"error":{"type":"invalid_request_error",'
  + '"message":"The requested model is not supported under the current authentication mode."}}';

/** A tmux session record as `store.sessions.listLiveAll()` returns it. */
function tmuxSession(id, engineId = 'codex') {
  return { id, projectId: id * 10, sessionMode: 'tmux', tmuxSession: `tc-${id}`, engineId };
}

describe('#261 the wrap sentinel tick feeds engine-error detection', () => {
  let saved;
  const codex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
  beforeEach(() => {
    ws.stop();
    saved = { ...ws._internal };
    ws._internal.getProjectName = (pid) => `proj-${pid}`;
    ws._internal.now = () => 1000;
    ws._internal.getEngineProfile = (id) => (id === 'codex' ? codex : null);
  });
  afterEach(() => { Object.assign(ws._internal, saved); ws.stop(); });

  it('records the error from the SAME capture the sentinel already takes, and clears when the pane moves past it', async () => {
    const s = tmuxSession(1);
    ws._internal.listLiveAll = () => [s];
    let pane = ['> prompt', CODEX_400, '> '];
    let captures = 0;
    ws._internal.capturePane = () => { captures++; return { lines: pane }; };

    await ws._internal.tick();
    assert.equal(captures, 1, 'one capture per session per tick — no second loop');
    const rec = engineErrors.get(1);
    assert.ok(rec, 'the tick must record the error');
    assert.equal(rec.status, 400);
    assert.equal(rec.type, 'invalid_request_error');

    pane = ['> prompt', 'Sure — done.', '> '];
    await ws._internal.tick();
    assert.equal(captures, 2);
    assert.equal(engineErrors.get(1), null, 'a capture without the line clears it');
  });

  it('keeps scanning a session that already asked to wrap — a wrapping engine can still be failing', async () => {
    const s = tmuxSession(2);
    ws._internal.listLiveAll = () => [s];
    let pane = ['idle'];
    ws._internal.capturePane = () => ({ lines: pane });
    await ws._internal.tick(); // baseline
    pane = ['done', ws.SENTINEL_TOKEN];
    await ws._internal.tick(); // flags the wrap
    assert.equal(ws.isWrapRequested('proj-20'), true);
    pane = ['done', ws.SENTINEL_TOKEN, CODEX_400];
    await ws._internal.tick();
    assert.equal(engineErrors.get(2) && engineErrors.get(2).status, 400,
      'the one-nudge latch must not stop error detection');
  });

  it('an engine with no patterns records nothing, and an ended session is forgotten on prune', async () => {
    const claude = tmuxSession(3, 'claude');
    const codexSession = tmuxSession(4);
    ws._internal.listLiveAll = () => [claude, codexSession];
    ws._internal.capturePane = () => ({ lines: [CODEX_400] });
    await ws._internal.tick();
    assert.equal(engineErrors.get(3), null, 'claude declares no errorPatterns');
    assert.ok(engineErrors.get(4));

    ws._internal.listLiveAll = () => [claude];
    await ws._internal.tick();
    assert.equal(engineErrors.get(4), null, 'prune must drop the ended session\'s record');
  });
});

describe('#261 the recorded error reaches the status payload and the project card', () => {
  let tmpDir;
  let sessions;
  let projects;
  let projectId;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-error-'));
    store._setBasePath(tmpDir);
    store.init();
    sessions = require('../lib/sessions');
    projects = require('../lib/projects');
    const projDir = path.join(tmpDir, 'projects', 'engine-error');
    fs.mkdirSync(projDir, { recursive: true });
    projectId = store.projects.create({ name: 'engine-error', path: projDir, engine: 'codex' }).id;
  });

  after(() => {
    engineErrors._reset();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const ALIVE = { live: true, answered: true, cause: null };

  /** Run `fn` with a live session whose pane probe and capture are stubbed. */
  function withSession(fn) {
    const realProbe = tmux.probeSession;
    const realCapture = tmux.capturePane;
    const realCursor = tmux.cursorInfo;
    tmux.probeSession = () => ALIVE;
    tmux.capturePane = () => ({ lines: ['> '] });
    tmux.cursorInfo = () => null;
    const session = store.sessions.start({
      projectId, engineId: 'codex', tmuxSession: `tc-engine-error-${Math.random().toString(36).slice(2)}`
    });
    sessions.clearIdleCache(session.tmuxSession);
    try {
      return fn(session);
    } finally {
      tmux.probeSession = realProbe;
      tmux.capturePane = realCapture;
      tmux.cursorInfo = realCursor;
      sessions.clearIdleCache(session.tmuxSession);
      engineErrors.forget(session.id);
      store.sessions.kill(session.id, "fixture teardown");
    }
  }

  it('GET status carries lastEngineError — null on the healthy path, the record once observed', () => {
    withSession((session) => {
      let status = sessions.getSessionStatus('engine-error');
      assert.equal(status.active, true);
      assert.equal(status.lastEngineError, null, 'present and null, not absent');

      engineErrors.observe(session, [CODEX_400], store.engines.get('codex'));
      status = sessions.getSessionStatus('engine-error');
      assert.equal(status.lastEngineError.status, 400);
      assert.equal(status.lastEngineError.type, 'invalid_request_error');
      assert.match(status.lastEngineError.message, /not supported/);
      assert.match(status.lastEngineError.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it('the bundled Codex profile, as the store serves it, is what detection compiles', () => {
    withSession((session) => {
      const profile = store.engines.get('codex');
      assert.ok(Array.isArray(profile.errorPatterns) && profile.errorPatterns.length > 0,
        'store.engines.get must carry errorPatterns — the sentinel reads the profile from there');
      assert.equal(engineErrors.observe(session, ['> ok', '> '], profile), null);
    });
  });

  it('the project list reports the error on a LIVE session', async () => {
    await (async () => {
      const realProbe = tmux.probeSession;
      tmux.probeSession = () => ALIVE;
      const session = store.sessions.start({ projectId, engineId: 'codex', tmuxSession: 'tc-engine-error-card' });
      try {
        engineErrors.observe(session, [CODEX_400], store.engines.get('codex'));
        const project = store.projects.get(projectId);
        const confirmed = { get: async () => ({ answered: true, names: new Set(['tc-engine-error-card']), cause: null }) };
        const enriched = await projects.enrichProject(project, {}, { tmuxSessionNames: confirmed });
        assert.equal(enriched.session.active, true);
        assert.equal(enriched.session.lastEngineError.status, 400);

        engineErrors.forget(session.id);
        const healthy = await projects.enrichProject(project, {}, { tmuxSessionNames: confirmed });
        assert.equal(healthy.session.lastEngineError, null);
      } finally {
        tmux.probeSession = realProbe;
        engineErrors.forget(session.id);
        store.sessions.kill(session.id, "fixture teardown");
      }
    })();
  });
});
