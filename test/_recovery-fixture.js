'use strict';

/**
 * A temp store with projects launched into a required recovery, for the tests
 * of clearing one launch and of reading the operator-held fleet.
 *
 * The recovery is reached through the real launch path: a `current.json` this
 * build cannot read makes the preflight demand recovery. No pane is started;
 * tmux and engine detection are stubbed for the length of one launch call.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const lockfile = require('../lib/handoff-lockfile');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');

/**
 * Point the store at a fresh temp directory with no login and direct ingress.
 * @param {string} prefix - Temp directory prefix
 * @returns {{tempDir: string, projectsDir: string, sessions: object, restore: () => void}}
 *   `restore` closes the temp store, removes it and points the store back
 */
function openTempStore(prefix) {
  const prevBase = store._getBasePath();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  store.close();
  store._setBasePath(tempDir);
  store.init();
  const projectsDir = path.join(tempDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const config = store.config.load();
  config.projectsDir = projectsDir;
  config.authEnabled = false;
  config.ingressMode = 'direct';
  store.config.save(config);
  return {
    tempDir,
    projectsDir,
    sessions: require('../lib/sessions'),
    restore() {
      store.close();
      store._setBasePath(prevBase);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

/**
 * Launch a project with tmux and engine detection stubbed.
 * @param {object} sessions - `lib/sessions`
 * @param {string} name - Project name
 * @returns {object} The launch result
 */
function launchStubbed(sessions, name) {
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
 * Create a project and launch it into a required recovery.
 * @param {{projectsDir: string, sessions: object}} env - From {@link openTempStore}
 * @param {'operator'|'advisory'} [recoveryMode] - The project's recovery mode
 * @returns {{project: object, sequence: object, binding: object}} The launch, and the
 *   `{sessionId, sequenceId, recoveryRevision}` that names it
 */
function launchInRecovery(env, recoveryMode = 'operator') {
  const name = `held-${Math.random().toString(36).slice(2, 10)}`;
  const dir = path.join(env.projectsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const project = store.projects.create({ name, path: dir, engine: 'claude' });
  const conf = store.projectConfig.load(dir) || {};
  conf.launchSequence = { ...(conf.launchSequence || {}), recoveryMode };
  store.projectConfig.save(dir, conf);
  // An operator's choice of advisory is a decision on record. The file alone
  // says advisory only while the login is in force.
  if (recoveryMode === 'advisory') store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
  fs.mkdirSync(lockfile.handoffDir(project), { recursive: true });
  fs.writeFileSync(lockfile.currentPath(project), '{"schema":"not-a-handoff"}\n', 'utf8');
  const session = launchStubbed(env.sessions, name).session;
  const sequence = store.launchSequences.getBySession(session.id);
  assert.equal(sequence.recovery, 'required', 'the fixture must actually be in recovery');
  return {
    project,
    sequence,
    binding: { sessionId: sequence.sessionId, sequenceId: sequence.id, recoveryRevision: sequence.recoveryRevision }
  };
}

const HOST = 'localhost:3102';
const PASSWORD = 'correct-horse-battery';

/**
 * A browser-shaped client for the real request handler, with the login
 * helpers the operator-only routes need.
 * @param {Function} handleRequest - `server.js#handleRequest`
 * @returns {{send: Function, json: Function, arm: Function, signIn: Function, pageToken: Function}}
 */
function makeClient(handleRequest) {
  /**
   * One request through the real handler.
   * @param {string} method - HTTP method
   * @param {string} url - Request path
   * @param {object} [opts]
   * @param {object} [opts.body] - JSON body
   * @param {object} [opts.headers] - Extra headers, lowercase; `undefined` removes one
   * @param {boolean} [opts.browser] - Whether to look browser-shaped (default true)
   * @returns {Promise<object>} The response, with `statusCode`, `body` and `headers`
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
      socket: {
        remoteAddress: '127.0.0.1',
        server: { address: () => ({ address: '127.0.0.1', port: 3102, family: 'IPv4' }) }
      },
      on(event, cb) {
        if (event === 'data' && raw !== null) cb(Buffer.from(raw));
        if (event === 'end') cb();
      }
    };
    const res = {
      statusCode: 0,
      body: '',
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, written) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(written || {})) this.headers[k.toLowerCase()] = v;
      },
      end(chunk) { if (chunk != null) this.body = String(chunk); }
    };
    await handleRequest(req, res);
    return res;
  }

  const json = (res) => JSON.parse(res.body);

  /**
   * Create an account and turn the login on.
   * @returns {void}
   */
  function arm() {
    store.users.create('rosie', PASSWORD);
    const cfg = store.config.load();
    cfg.authEnabled = true;
    store.config.save(cfg);
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

  return { send, json, arm, signIn, pageToken };
}

/**
 * Put the login back to "none": no accounts, no sessions, no fallback marker,
 * a fresh open-install token. For a `beforeEach`.
 * @returns {void}
 */
function resetLogin() {
  store.getDb().prepare('DELETE FROM auth_sessions').run();
  store.getDb().prepare('DELETE FROM users').run();
  const gateFallback = require('../lib/gate-fallback');
  gateFallback.removeMarker(gateFallback.markerPath());
  require('../lib/open-install-token').reset();
  const cfg = store.config.load();
  cfg.authEnabled = false;
  store.config.save(cfg);
}

module.exports = { openTempStore, launchStubbed, launchInRecovery, makeClient, resetLogin, PASSWORD };
