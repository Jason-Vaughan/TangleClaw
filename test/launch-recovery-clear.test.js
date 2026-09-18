'use strict';

/**
 * `POST /api/sessions/:project/launch/recovery-clear` (Train 21, #1587).
 *
 * The branch order is the property under test, and the case that matters most is
 * the one a happy path never reaches: an ARMED install whose caller failed to
 * authenticate must be refused as unauthenticated and must NEVER fall through to
 * the open-install branch, where the same request would have been honoured as an
 * anonymous browser and recorded as a clearance. Everything else here — the
 * fallback refusal, the machine-client refusal, the stale binding, the advisory
 * refusal — is the rest of that same shape: each state answered by its own
 * branch, and nothing defaulting to the permissive one.
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
const lockfile = require('../lib/handoff-lockfile');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');
const { handleRequest } = require('../server');

const PASSWORD = 'correct-horse-battery';
const HOST = 'localhost:3102';

describe('the recovery-clear route (Train 21, #1587)', () => {
  let tempDir;
  let prevBase;
  let projectsDir;
  let sessions;
  let counter = 0;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-recovery-clear-'));
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
  });

  after(() => {
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
   * A bound loopback listener, as `net.Server#address` reports one.
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
   * Launch with tmux and engine detection stubbed, so no pane is ever started.
   * @param {string} name - Project name
   * @returns {object} The launch result
   */
  function launch(name) {
    const real = {
      create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine
    };
    tmux.createSession = () => true;
    tmux.hasSession = () => false;
    tmux.killSession = () => true;
    enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-engine' });
    try {
      return sessions.launchSession(name, {});
    } finally {
      tmux.createSession = real.create;
      tmux.hasSession = real.has;
      tmux.killSession = real.kill;
      enginesModule.detectEngine = real.detect;
    }
  }

  /**
   * A launched project whose preflight demanded recovery, driven through the
   * real path: a `current.json` this build cannot read is preflight row 1.
   * @param {'operator'|'advisory'} [recoveryMode] - The project's setting
   * @returns {{project: object, sequence: object, body: object}} The launch and a valid clear body
   */
  function launchInRecovery(recoveryMode = 'operator') {
    const name = `clear-${counter}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    const conf = store.projectConfig.load(dir) || {};
    conf.launchSequence = { ...(conf.launchSequence || {}), recoveryMode };
    store.projectConfig.save(dir, conf);
    fs.mkdirSync(lockfile.handoffDir(project), { recursive: true });
    fs.writeFileSync(lockfile.currentPath(project), '{"schema":"not-a-handoff"}\n', 'utf8');
    const session = launch(name).session;
    const sequence = store.launchSequences.getBySession(session.id);
    assert.equal(sequence.recovery, 'required', 'the fixture must actually be in recovery');
    return {
      project,
      sequence,
      body: { sessionId: sequence.sessionId, sequenceId: sequence.id, recoveryRevision: sequence.recoveryRevision }
    };
  }

  /**
   * The clear URL for a project.
   * @param {object} project - Project record
   * @returns {string}
   */
  const clearUrl = (project) => `/api/sessions/${encodeURIComponent(project.name)}/launch/recovery-clear`;

  /**
   * Create an account and turn the login on.
   * @returns {void}
   */
  function arm() {
    store.users.create('rosie', PASSWORD);
    patchConfig({ authEnabled: true });
  }

  /**
   * Sign in and return the cookie and CSRF token a browser would then carry.
   * @returns {Promise<{cookie: string, csrf: string}>}
   */
  async function signIn() {
    const res = await send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
    assert.equal(res.statusCode, 200, res.body);
    const setCookie = [].concat(res.headers['set-cookie'] || []);
    const cookie = setCookie.map((c) => String(c).split(';')[0]).join('; ');
    return { cookie, csrf: json(res).csrfToken };
  }

  /**
   * The token an open install's dashboard would have been issued.
   * @returns {Promise<string>}
   */
  async function pageToken() {
    const me = json(await send('GET', '/api/auth/me'));
    assert.ok(me.openInstallToken, 'an open install issues its dashboard a token');
    return me.openInstallToken;
  }

  describe('open install', () => {
    it('clears with the page token, and records it as unverified', async () => {
      const { project, sequence, body } = launchInRecovery('operator');
      const token = await pageToken();
      const res = await send('POST', clearUrl(project), { body, headers: { 'x-tc-open-token': token } });
      assert.equal(res.statusCode, 200, res.body);
      const answer = json(res);
      assert.equal(answer.recovery, 'cleared');
      assert.equal(answer.recoveryClearance, 'open-install-unverified',
        'an open install proves nobody, and the record says so');
      assert.equal(answer.recoveryClearedBy, null);
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recovery, 'cleared');
    });

    it('refuses a clear with no page token', async () => {
      const { project, body } = launchInRecovery('operator');
      const res = await send('POST', clearUrl(project), { body });
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'OPEN_INSTALL_TOKEN_INVALID');
    });

    it('refuses a clear with a token this process never minted', async () => {
      const { project, body } = launchInRecovery('operator');
      const res = await send('POST', clearUrl(project), {
        body, headers: { 'x-tc-open-token': 'a'.repeat(43) }
      });
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'OPEN_INSTALL_TOKEN_INVALID');
    });

    it('refuses a machine client before it ever reaches the token check', async () => {
      // A local process is not an operator. It is refused for WHAT IT IS, not
      // for a header it failed to send — so it stays refused even holding a
      // token it fetched itself.
      const { project, body } = launchInRecovery('operator');
      const token = await pageToken();
      const res = await send('POST', clearUrl(project), {
        body, browser: false, headers: { 'x-tc-open-token': token }
      });
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'OPERATOR_REQUIRED');
    });

    it('refuses a browser that will not vouch for its own origin', async () => {
      const { project, body } = launchInRecovery('operator');
      const token = await pageToken();
      for (const headers of [
        { origin: undefined, 'x-tc-open-token': token },
        { origin: 'http://evil.example', 'x-tc-open-token': token },
        { 'sec-fetch-site': 'same-site', 'x-tc-open-token': token }
      ]) {
        const res = await send('POST', clearUrl(project), { body, headers });
        assert.equal(res.statusCode, 403, JSON.stringify(headers));
        assert.equal(json(res).code, 'CROSS_SITE_FORBIDDEN', JSON.stringify(headers));
      }
    });
  });

  describe('armed install', () => {
    it('refuses an unauthenticated caller and never reaches the open-install branch', async () => {
      // The branch-order case. Before the gate state decided first, this request
      // — no session, browser-shaped, same-origin — was exactly the shape the
      // open branch honours, and it would have cleared a recovery on an install
      // that requires a login.
      const { project, sequence, body } = launchInRecovery('operator');
      arm();
      const res = await send('POST', clearUrl(project), { body, headers: { 'x-tc-open-token': 'anything' } });
      assert.equal(res.statusCode, 401);
      assert.equal(json(res).code, 'UNAUTHENTICATED');
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recovery, 'required',
        'nothing was cleared');
    });

    it('clears for a signed-in operator, and names them', async () => {
      const { project, sequence, body } = launchInRecovery('operator');
      arm();
      const { cookie, csrf } = await signIn();
      const res = await send('POST', clearUrl(project), {
        body, headers: { cookie, 'x-csrf-token': csrf }
      });
      assert.equal(res.statusCode, 200, res.body);
      const answer = json(res);
      assert.equal(answer.recoveryClearance, 'operator-verified');
      assert.equal(answer.recoveryClearedBy, 'rosie');
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recoveryClearedBy, 'rosie');
    });

    it('refuses a signed-in caller with no CSRF token', async () => {
      const { project, body } = launchInRecovery('operator');
      arm();
      const { cookie } = await signIn();
      const res = await send('POST', clearUrl(project), { body, headers: { cookie } });
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'CSRF_TOKEN_INVALID');
    });
  });

  describe('fallback', () => {
    it('refuses while TangleClaw\'s login is stood down behind Caddy\'s', async () => {
      const { project, sequence, body } = launchInRecovery('operator');
      arm();
      gateFallback.writeMarker(gateFallback.markerPath(), { createdAt: new Date().toISOString() });
      const res = await send('POST', clearUrl(project), { body });
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'GATE_FALLBACK');
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recovery, 'required');
    });
  });

  describe('the binding', () => {
    it('refuses a clear naming a recovery revision that has moved on', async () => {
      const { project, body } = launchInRecovery('operator');
      const token = await pageToken();
      const res = await send('POST', clearUrl(project), {
        body: { ...body, recoveryRevision: body.recoveryRevision + 1 },
        headers: { 'x-tc-open-token': token }
      });
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'STALE_RECOVERY');
    });

    it('refuses a second clear of a recovery already cleared', async () => {
      const { project, body } = launchInRecovery('operator');
      const token = await pageToken();
      assert.equal((await send('POST', clearUrl(project), { body, headers: { 'x-tc-open-token': token } })).statusCode, 200);
      const again = await send('POST', clearUrl(project), { body, headers: { 'x-tc-open-token': token } });
      assert.equal(again.statusCode, 409);
      assert.equal(json(again).code, 'STALE_RECOVERY');
    });

    it('refuses a sequence that belongs to another project', async () => {
      const mine = launchInRecovery('operator');
      const theirs = launchInRecovery('operator');
      const token = await pageToken();
      const res = await send('POST', clearUrl(mine.project), {
        body: theirs.body, headers: { 'x-tc-open-token': token }
      });
      assert.equal(res.statusCode, 404);
      assert.equal(store.launchSequences.getBySession(theirs.sequence.sessionId).recovery, 'required');
    });

    it('refuses a body that does not name a launch', async () => {
      const { project } = launchInRecovery('operator');
      const token = await pageToken();
      const res = await send('POST', clearUrl(project), {
        body: { sessionId: 'one' }, headers: { 'x-tc-open-token': token }
      });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('advisory mode', () => {
    it('refuses to clear an advisory launch — the two paths never cross', async () => {
      const { project, sequence, body } = launchInRecovery('advisory');
      const token = await pageToken();
      const res = await send('POST', clearUrl(project), { body, headers: { 'x-tc-open-token': token } });
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'RECOVERY_MODE_ADVISORY');
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recovery, 'required');
    });
  });
});
