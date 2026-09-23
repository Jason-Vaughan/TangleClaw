'use strict';

/**
 * The startup prompt routes (#1825), through the real handler:
 * `GET/PUT /api/startup-prompt` and `POST /api/sessions/:project/startup-prompt/fire`.
 *
 * What is under test is who may do what. Only the operator writes the prompt
 * and its firer list, through the same strict operator write the recovery
 * clear uses. An agent session reads it, and fires only when the operator
 * listed its project and it shares a group with the target. No engine has an
 * adapter yet, so every authorized fire is a typed, audited `unsupported`, and
 * nothing is ever typed into a pane.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const gateFallback = require('../lib/gate-fallback');
const openInstallToken = require('../lib/open-install-token');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');
const { handleRequest } = require('../server');

const PASSWORD = 'correct-horse-battery';
const HOST = 'localhost:3102';

describe('startup prompt routes (#1825)', () => {
  let tempDir;
  let prevBase;
  let projectsDir;
  let sessions;
  let counter = 0;
  let sendKeysCalls = 0;
  let realSendKeys;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-startup-prompt-api-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
    projectsDir = path.join(tempDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    config.authEnabled = false;
    config.ingressMode = 'direct';
    store.config.save(config);
    sessions = require('../lib/sessions');
    realSendKeys = tmux.sendKeys;
    tmux.sendKeys = () => { sendKeysCalls += 1; return true; };
  });

  after(() => {
    tmux.sendKeys = realSendKeys;
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    counter += 1;
    store.getDb().prepare('DELETE FROM auth_sessions').run();
    store.getDb().prepare('DELETE FROM users').run();
    gateFallback.removeMarker(gateFallback.markerPath());
    openInstallToken.reset();
    patchConfig({ authEnabled: false });
  });

  /**
   * Merge fields into the live config.
   * @param {object} fields - Config keys to set
   * @returns {void}
   */
  function patchConfig(fields) {
    const cfg = store.config.load();
    Object.assign(cfg, fields);
    store.config.save(cfg);
  }

  /**
   * A bound loopback listener.
   * @returns {{address: Function}}
   */
  const listener = () => ({ address: () => ({ address: '127.0.0.1', port: 3102, family: 'IPv4' }) });

  /**
   * A response object the real handler can write to.
   * @returns {object}
   */
  function mockRes() {
    return {
      statusCode: 0,
      body: '',
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(headers || {})) this.headers[k.toLowerCase()] = v;
      },
      end(chunk) { if (chunk != null) this.body = String(chunk); }
    };
  }

  /**
   * One request through the real handler.
   * @param {string} method - HTTP method
   * @param {string} url - Request path
   * @param {object} [opts]
   * @param {object} [opts.body] - JSON body
   * @param {object} [opts.headers] - Extra headers, lowercase
   * @param {boolean} [opts.browser] - Whether to look browser-shaped (default true)
   * @returns {Promise<object>} The response
   */
  async function send(method, url, opts = {}) {
    const raw = opts.body === undefined ? null : JSON.stringify(opts.body);
    const browser = opts.browser !== false;
    const headers = { host: HOST, ...(browser ? { 'sec-fetch-site': 'same-origin', origin: `http://${HOST}` } : {}) };
    Object.assign(headers, opts.headers || {});
    for (const [k, v] of Object.entries(headers)) if (v === undefined) delete headers[k];
    if (raw !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(raw));
    }
    const req = {
      url,
      method,
      headers,
      socket: { remoteAddress: '127.0.0.1', server: listener() },
      on(event, cb) {
        if (event === 'data' && raw !== null) cb(Buffer.from(raw));
        if (event === 'end') cb();
      }
    };
    const res = mockRes();
    await handleRequest(req, res);
    return res;
  }

  const json = (res) => JSON.parse(res.body);

  /**
   * Create and launch a project with tmux and engine detection stubbed.
   * @param {string} [engine='codex'] - Engine id.
   * @returns {{project: object, session: object, sequence: object}}
   */
  function launched(engine = 'codex') {
    const name = `sp-${counter}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine });
    const real = {
      create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine
    };
    tmux.createSession = () => true;
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-engine' });
    let session;
    try {
      session = sessions.launchSession(name, {}).session;
    } finally {
      tmux.createSession = real.create;
      tmux.hasSession = real.has;
      tmux.killSession = real.kill;
      enginesModule.detectEngine = real.detect;
    }
    return { project, session, sequence: store.launchSequences.getBySession(session.id) };
  }

  /**
   * Headers that bind a request to a launched session, as a pane sends them.
   * @param {{project: object, sequence: object}} l - A launch.
   * @returns {object}
   */
  const binding = (l) => ({
    'x-tangleclaw-project-id': String(l.project.id),
    'x-tangleclaw-launch-id': l.sequence.launchId
  });

  /**
   * The token an open install's dashboard would have been issued.
   * @returns {Promise<string>}
   */
  async function pageToken() {
    const me = json(await send('GET', '/api/auth/me'));
    return me.openInstallToken;
  }

  /**
   * Write a prompt revision as the operator on an open install.
   * @param {object} body - PUT body.
   * @returns {Promise<object>} The response.
   */
  async function operatorPut(body) {
    return send('PUT', '/api/startup-prompt', { body, headers: { 'x-tc-open-token': await pageToken() } });
  }

  /**
   * The fire URL for a project.
   * @param {object} project - Project record.
   * @returns {string}
   */
  const fireUrl = (project) => `/api/sessions/${encodeURIComponent(project.name)}/startup-prompt/fire`;

  /**
   * A fire body for a launch at the current prompt revision.
   * @param {{sequence: object}} l - A launch.
   * @returns {object}
   */
  let keySeq = 0;
  const fireBody = (l) => ({
    sessionId: l.sequence.sessionId,
    sequenceId: l.sequence.id,
    expectedRevision: store.startupPrompts.current().revision,
    idempotencyKey: `api-key-${String(++keySeq).padStart(6, '0')}`
  });

  describe('read', () => {
    it('the operator reads the current prompt', async () => {
      const res = await send('GET', '/api/startup-prompt');
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(Number.isInteger(json(res).revision));
      assert.ok(Array.isArray(json(res).firerProjectIds));
    });

    it('a bound session reads it; an unbound machine client does not', async () => {
      const l = launched();
      const ok = await send('GET', '/api/startup-prompt', { browser: false, headers: binding(l) });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(json(ok).firerProjectIds, undefined, 'a session does not see other projects\' authority');
      assert.equal(typeof json(ok).callerListedAsFirer, 'boolean');
      const unbound = await send('GET', '/api/startup-prompt', { browser: false });
      assert.equal(unbound.statusCode, 403);
    });
  });

  describe('update', () => {
    it('the operator writes a new revision with its firer list', async () => {
      const cur = store.startupPrompts.current().revision;
      const res = await operatorPut({ text: 'read your launch context', firerProjectIds: [], expectedRevision: cur });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).revision, cur + 1);
      assert.equal(json(res).updatedByKind, 'open-install-unverified', 'an open install proves nobody, and the revision says so');
    });

    it('a stale revision is refused with the current one', async () => {
      const cur = store.startupPrompts.current().revision;
      await operatorPut({ text: 'one', firerProjectIds: [], expectedRevision: cur });
      const res = await operatorPut({ text: 'two', firerProjectIds: [], expectedRevision: cur });
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'STALE_STARTUP_PROMPT');
      assert.equal(json(res).currentRevision, cur + 1);
    });

    it('invalid text is refused with 400', async () => {
      const res = await operatorPut({ text: 'a\u001bb', firerProjectIds: [], expectedRevision: store.startupPrompts.current().revision });
      assert.equal(res.statusCode, 400);
      assert.equal(json(res).code, 'STARTUP_PROMPT_INVALID');
    });

    it('an agent session cannot write it, even listing itself as a firer', async () => {
      const l = launched();
      const before = store.startupPrompts.current().revision;
      const res = await send('PUT', '/api/startup-prompt', {
        browser: false,
        headers: binding(l),
        body: { text: 'hijack', firerProjectIds: [l.project.id], expectedRevision: before }
      });
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'OPERATOR_REQUIRED');
      assert.equal(store.startupPrompts.current().revision, before, 'nothing was written');
    });

    it('an open-install write with no page token is refused', async () => {
      const res = await send('PUT', '/api/startup-prompt', { body: { text: 'x', expectedRevision: 1 } });
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'OPEN_INSTALL_TOKEN_INVALID');
    });

    it('an armed install refuses a caller with no session, rather than treating it as open', async () => {
      store.users.create('rosie', PASSWORD);
      patchConfig({ authEnabled: true });
      const res = await send('PUT', '/api/startup-prompt', { body: { text: 'x', expectedRevision: 1 } });
      assert.equal(res.statusCode, 401);
      assert.equal(json(res).code, 'UNAUTHENTICATED');
    });
  });

  describe('fire', () => {
    it('the operator fire at a codex session is a typed, audited unsupported, and types nothing', async () => {
      const l = launched('codex');
      const calls = sendKeysCalls;
      const res = await send('POST', fireUrl(l.project), {
        body: fireBody(l), headers: { 'x-tc-open-token': await pageToken() }
      });
      assert.equal(res.statusCode, 409, res.body);
      const body = json(res);
      assert.equal(body.code, 'STARTUP_CONTROL_UNSUPPORTED');
      assert.equal(body.engine, 'codex');
      assert.equal(body.fire.outcome, 'unsupported');
      assert.equal(body.fire.callerKind, 'operator');
      assert.ok(!JSON.stringify(body).includes(l.sequence.launchId), 'the launch id never leaves the server');
      assert.equal(sendKeysCalls, calls, 'no keystroke fallback');
      assert.equal(store.startupPrompts.firesForSession(l.session.id).length, 1);
    });

    it('a listed firer sharing a group fires; the same launch and revision again is a duplicate', async () => {
      const target = launched();
      const firer = launched();
      const group = store.projectGroups.create({ name: `g-${counter}` });
      store.projectGroups.addMember(group.id, target.project.id);
      store.projectGroups.addMember(group.id, firer.project.id);
      await operatorPut({ text: 'read your launch context', firerProjectIds: [firer.project.id], expectedRevision: store.startupPrompts.current().revision });

      const body = fireBody(target);
      const first = await send('POST', fireUrl(target.project), { browser: false, headers: binding(firer), body });
      assert.equal(first.statusCode, 409, first.body);
      assert.equal(json(first).fire.callerKind, 'project');
      assert.equal(json(first).fire.callerProjectId, firer.project.id);
      assert.equal(json(first).fire.callerClearance, 'project-binding');
      const again = await send('POST', fireUrl(target.project), { browser: false, headers: binding(firer), body });
      assert.equal(json(again).duplicate, true);
      assert.equal(json(again).fire.id, json(first).fire.id);
    });

    it('an unlisted session in the same group is refused and nothing is recorded', async () => {
      const target = launched();
      const other = launched();
      const group = store.projectGroups.create({ name: `h-${counter}` });
      store.projectGroups.addMember(group.id, target.project.id);
      store.projectGroups.addMember(group.id, other.project.id);
      const res = await send('POST', fireUrl(target.project), { browser: false, headers: binding(other), body: fireBody(target) });
      assert.equal(res.statusCode, 404, 'the same answer as a target that does not exist');
      assert.equal(json(res).code, 'SESSION_NOT_FOUND');
      const recorded = store.startupPrompts.firesForSession(target.session.id);
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].outcome, 'denied');
      assert.equal(recorded[0].reasonCode, 'fire_scope_denied');
    });

    it('a listed firer with no shared group is refused', async () => {
      const target = launched();
      const firer = launched();
      await operatorPut({ text: 'read', firerProjectIds: [firer.project.id], expectedRevision: store.startupPrompts.current().revision });
      const res = await send('POST', fireUrl(target.project), { browser: false, headers: binding(firer), body: fireBody(target) });
      assert.equal(res.statusCode, 404);
      assert.equal(json(res).code, 'SESSION_NOT_FOUND');
    });

    it('an operator fire on an open install without the page token is refused and records nothing', async () => {
      const l = launched();
      const res = await send('POST', fireUrl(l.project), { body: fireBody(l) });
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'OPEN_INSTALL_TOKEN_INVALID');
      assert.equal(store.startupPrompts.firesForSession(l.session.id).length, 0);
    });

    it('an unbound machine client is refused before anything is looked up', async () => {
      const target = launched();
      const res = await send('POST', fireUrl(target.project), { browser: false, body: fireBody(target) });
      assert.equal(res.statusCode, 403);
    });

    it('a launch that is not the current one is refused', async () => {
      const l = launched();
      const res = await send('POST', fireUrl(l.project), {
        body: { ...fireBody(l), sequenceId: l.sequence.id + 999 }, headers: { 'x-tc-open-token': await pageToken() }
      });
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'LAUNCH_NOT_CURRENT');
    });

    it('a stale prompt revision is refused', async () => {
      const l = launched();
      const res = await send('POST', fireUrl(l.project), {
        body: { ...fireBody(l), expectedRevision: 0 }, headers: { 'x-tc-open-token': await pageToken() }
      });
      assert.equal(json(res).code, 'STALE_STARTUP_PROMPT');
    });
  });

  describe('tc capabilities', () => {
    it('reports startup-control as disabled with its reason for a launched session', async () => {
      const l = launched('codex');
      const res = await send('GET', `/api/tc/whoami?projectId=${l.project.id}`, { browser: false });
      assert.equal(res.statusCode, 200, res.body);
      const cap = json(res).capabilities.find((c) => c.id === 'startup-control');
      assert.ok(cap, 'startup-control is reported, not omitted');
      assert.equal(cap.enabled, false);
      assert.match(cap.detail, /unsupported: engine codex declares no startupControl/);
    });
  });
});
