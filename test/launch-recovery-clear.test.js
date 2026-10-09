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

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
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
const { handleRequest, _recoveryGateProbeFor } = require('../server');
const recoveryDefault = require('../lib/recovery-default');
const authGate = require('../lib/auth-gate');
const launchSequence = require('../lib/launch-sequence');

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
    // The operator's choice of advisory is a decision on record, as their PATCH
    // writes it. The file alone says advisory only while the login is in force.
    if (recoveryMode === 'advisory') store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
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
   * The headers the held launch's own session sends on its API calls: the one
   * machine-shaped caller that is identified, and so reaches the route (#2233).
   * @param {object} project - Project record
   * @param {object} sequence - The launch sequence
   * @returns {object}
   */
  const boundHeaders = (project, sequence) => ({
    'x-tangleclaw-launch-id': sequence.launchId,
    'x-tangleclaw-project-id': String(project.id)
  });

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
      const { project, sequence, body } = launchInRecovery('operator');
      const token = await pageToken();
      // One that says nothing about who it is does not reach the route at all
      // (#2233).
      const res = await send('POST', clearUrl(project), {
        body, browser: false, headers: { 'x-tc-open-token': token }
      });
      assert.equal(res.statusCode, 403);
      assert.equal(json(res).code, 'LAUNCH_BINDING_REQUIRED');
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recovery, 'required', 'nothing was cleared');
      // The held launch's own session is identified, reaches the route, and is
      // refused there for what it is, token and all.
      const own = await send('POST', clearUrl(project), {
        body, browser: false, headers: { ...boundHeaders(project, sequence), 'x-tc-open-token': token }
      });
      assert.equal(own.statusCode, 403);
      assert.equal(json(own).code, 'OPERATOR_REQUIRED');
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recovery, 'required', 'nothing was cleared');
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

  describe('what the perimeter demands of the button', () => {
    it('refuses a browser body that is not declared JSON, which is why the client sets the header', async () => {
      // This is the contract the Clear-recovery button has to satisfy, pinned
      // from the server side: `/api/` answers 415 before any route runs when a
      // browser-shaped request carries an undeclared body (#860). The button
      // once sent none, and every test around it passed — the route test sets
      // the header in its own helper, and the UI test stubs `api()`. Neither
      // could see the hop between them, so the contract is asserted here.
      const { project, sequence, body } = launchInRecovery('operator');
      const token = await pageToken();
      const raw = JSON.stringify(body);
      const req = {
        url: clearUrl(project),
        method: 'POST',
        headers: {
          host: HOST,
          origin: `http://${HOST}`,
          'sec-fetch-site': 'same-origin',
          'x-tc-open-token': token,
          // What a browser labels a body sent with no Content-Type.
          'content-type': 'text/plain;charset=UTF-8',
          'content-length': String(Buffer.byteLength(raw))
        },
        socket: { remoteAddress: '127.0.0.1', server: listener() },
        on(event, cb) {
          if (event === 'data') cb(Buffer.from(raw));
          if (event === 'end') cb();
        }
      };
      const res = mockRes();
      await handleRequest(req, res);
      assert.equal(res.statusCode, 415);
      assert.equal(json(res).code, 'JSON_BODY_REQUIRED');
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recovery, 'required',
        'the request never reached the route');
    });
  });

  describe('an unsupported gate state', () => {
    it('refuses rather than falling through to the open-install branch', async () => {
      // The fourth branch. `account-required` is a real state — an install whose
      // login is on with no account yet — and the property is that it is
      // answered by its OWN branch: there is no fall-through, so a machine
      // client and a browser are refused identically and neither is honoured.
      const { project, sequence, body } = launchInRecovery('operator');
      // Taken while the install is still open, then the gate is moved to
      // `account-required`. A caller holding a token minted under a different
      // gate state is the realistic shape of this request, and it must be
      // refused for the state the install is in NOW.
      const token = await pageToken();
      patchConfig({ authEnabled: true });
      // An unidentified machine client is refused before the route (#2233): the
      // fleet carve-out waves it past the login, and the launch binding guard
      // then refuses a write from a caller that says nothing about who it is.
      const machine = await send('POST', clearUrl(project), {
        body, browser: false, headers: { 'x-tc-open-token': token }
      });
      assert.equal(machine.statusCode, 403);
      assert.equal(json(machine).code, 'LAUNCH_BINDING_REQUIRED');
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recovery, 'required');
      // The held launch's own session is the caller that reaches the route here,
      // and the route's own fourth branch is what answers it.
      const own = await send('POST', clearUrl(project), {
        body, browser: false, headers: { ...boundHeaders(project, sequence), 'x-tc-open-token': token }
      });
      assert.equal(own.statusCode, 409);
      assert.equal(json(own).code, 'GATE_STATE_UNSUPPORTED');
      // A browser never gets that far — the perimeter challenges it for the
      // account that does not exist yet. Asserted so the two refusals are on
      // the record as different, rather than one being assumed to cover both.
      const browser = await send('POST', clearUrl(project), {
        body, headers: { 'x-tc-open-token': token }
      });
      assert.equal(browser.statusCode, 401);
      assert.equal(json(browser).code, 'ACCOUNT_REQUIRED');
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).recovery, 'required',
        'neither reached the open-install branch');
    });
  });

  // What an operator-held launch is told must be true of the install it is told
  // on. Each case below puts the install in one login gate state, reads the
  // sentence through the probe `server.js` installs, and then drives the real
  // clear and the real reconciliation readback to see whether the sentence
  // described them. The states come from `GATE_STATES`, so a state added later
  // fails here until it has a row.
  describe('what a held launch is told, against what the routes do (#1937)', () => {
    const readUrl = (project) => `/api/sessions/${encodeURIComponent(project.name)}/launch/reconciliation`;
    const states = authGate.GATE_STATES;
    let configBytes = null;

    afterEach(() => {
      recoveryDefault.setGateStateProbe(null);
      if (configBytes !== null) {
        fs.writeFileSync(store._getConfigPath(), configBytes);
        configBytes = null;
      }
    });

    /** How each gate state is reached from the open install every case starts on. */
    const reach = {
      [states.OPEN]: () => {},
      [states.ARMED]: () => arm(),
      [states.FALLBACK]: () => {
        arm();
        gateFallback.writeMarker(gateFallback.markerPath(), { createdAt: new Date().toISOString() });
      },
      [states.ACCOUNT_REQUIRED]: () => patchConfig({ authEnabled: true }),
      [states.LOCKED]: () => {
        arm();
        store.getDb().prepare("UPDATE users SET disabled_at = datetime('now')").run();
      },
      [states.UNREADABLE]: () => {
        configBytes = fs.readFileSync(store._getConfigPath());
        fs.writeFileSync(store._getConfigPath(), '{ this is not json');
      }
    };

    /**
     * A held launch, the install moved to a gate state, and the sentence the
     * launch is then told. The launch and the page token are taken while the
     * install is open, so every case holds the credentials a caller could have.
     * @param {string} state - The gate state to reach
     * @returns {Promise<{project: object, sequence: object, body: object, token: string, hint: {text: string, clear: string}}>}
     */
    async function heldIn(state) {
      const held = launchInRecovery('operator');
      const token = await pageToken();
      reach[state]();
      // The probe a real server installs, on the listener every request in
      // this file arrives on, so the launch-side answer and the request-side
      // answer are read from the same door.
      recoveryDefault.setGateStateProbe(_recoveryGateProbeFor(listener()));
      assert.equal(recoveryDefault.gateAnswer().gateState, state, 'the fixture must reach the state it is named for');
      return { ...held, token, hint: launchSequence.operatorHeldHintFor(held.sequence) };
    }

    /**
     * The two unauthenticated request shapes a local process can send.
     * @param {string} url - The route
     * @param {object} body - The request body
     * @param {string} token - A page token
     * @returns {Promise<{machine: object, imitation: object}>} A raw machine-shaped request, and one
     *   imitating the dashboard (same origin, a page token it fetched itself)
     */
    async function bothShapes(url, body, token) {
      return {
        machine: await send('POST', url, { body, browser: false, headers: { 'x-tc-open-token': token } }),
        imitation: await send('POST', url, { body, headers: { 'x-tc-open-token': token } })
      };
    }

    /**
     * The machine-shaped request the held launch's own session sends: bound to
     * its launch, so identified, and holding a page token it fetched itself.
     * @param {string} url - The route
     * @param {{project: object, sequence: object, body: object}} held - The held launch
     * @param {string} token - A page token
     * @returns {Promise<object>} The response
     */
    const ownSession = (url, held, token) => send('POST', url, {
      body: held.body, browser: false,
      headers: { ...boundHeaders(held.project, held.sequence), 'x-tc-open-token': token }
    });

    const stillHeld = (sequence) => store.launchSequences.getBySession(sequence.sessionId).recovery === 'required';

    it('has a row for every login gate state', () => {
      assert.deepEqual(Object.keys(reach).sort(), Object.values(states).sort());
    });

    it('open: the clear is unverified and a local process can reproduce it, and the sentence claims no more', async () => {
      const { project, sequence, body, token, hint } = await heldIn(states.OPEN);
      assert.equal(hint.clear, 'unverified');
      assert.match(hint.text, /Launch readiness panel/);
      assert.match(hint.text, /recorded as unverified/);
      assert.match(hint.text, /nothing shows who or what made it/);
      assert.doesNotMatch(hint.text, /sign in|the operator to clear|operator-verified/,
        'no operator is named as the one who clears: nothing here can tell who did');

      // A machine-shaped request that says nothing about who it is never reaches
      // either route (#2233). The launch's own session does, and each route
      // refuses it as a local process.
      const read = await bothShapes(readUrl(project), body, token);
      assert.equal(read.machine.statusCode, 403);
      assert.equal(json(read.machine).code, 'LAUNCH_BINDING_REQUIRED');
      assert.equal(read.imitation.statusCode, 403, 'the readback refuses the dashboard imitation too');
      assert.equal(json(read.imitation).code, 'LOGIN_GATE_REQUIRED');
      const ownRead = await ownSession(readUrl(project), { project, sequence, body }, token);
      assert.equal(ownRead.statusCode, 403);
      assert.equal(json(ownRead).code, 'OPERATOR_REQUIRED');

      const machine = await send('POST', clearUrl(project), { body, browser: false, headers: { 'x-tc-open-token': token } });
      assert.equal(machine.statusCode, 403, 'a raw machine-shaped clear is refused outright');
      assert.equal(json(machine).code, 'LAUNCH_BINDING_REQUIRED');
      assert.ok(stillHeld(sequence));
      const ownClear = await ownSession(clearUrl(project), { project, sequence, body }, token);
      assert.equal(ownClear.statusCode, 403, 'and so is the launch\'s own session');
      assert.equal(json(ownClear).code, 'OPERATOR_REQUIRED');
      assert.ok(stillHeld(sequence));
      const imitation = await send('POST', clearUrl(project), { body, headers: { 'x-tc-open-token': token } });
      assert.equal(imitation.statusCode, 200, 'a request with the dashboard\'s shape clears, whoever sent it');
      assert.equal(json(imitation).recoveryClearance, 'open-install-unverified');
      assert.equal(json(imitation).recoveryClearedBy, null);
    });

    it('armed: a signed-in operator clears and reads back, nobody else does, and the sentence says sign in', async () => {
      const { project, sequence, body, token, hint } = await heldIn(states.ARMED);
      assert.equal(hint.clear, 'signed-in-operator');
      assert.match(hint.text, /Ask the operator to sign in and clear it from this project's Launch readiness panel\./);
      for (const url of [clearUrl(project), readUrl(project)]) {
        const { machine, imitation } = await bothShapes(url, body, token);
        // Refused before the route (#2233): nothing says who it is.
        assert.equal(machine.statusCode, 403, url);
        assert.equal(json(machine).code, 'LAUNCH_BINDING_REQUIRED', url);
        assert.equal(imitation.statusCode, 401, url);
        // The launch's own session reaches the route and is told to sign in.
        const own = await ownSession(url, { project, sequence, body }, token);
        assert.equal(own.statusCode, 401, url);
        assert.equal(json(own).code, 'UNAUTHENTICATED', url);
      }
      assert.ok(stillHeld(sequence));
      const { cookie, csrf } = await signIn();
      const read = await send('POST', readUrl(project), { body, headers: { cookie, 'x-csrf-token': csrf } });
      assert.equal(json(read).code, 'NOT_ATTESTED', 'the readback served the operator: its only complaint is the launch');
      const cleared = await send('POST', clearUrl(project), { body, headers: { cookie, 'x-csrf-token': csrf } });
      assert.equal(cleared.statusCode, 200, cleared.body);
      assert.equal(json(cleared).recoveryClearance, 'operator-verified');
    });

    for (const [state, code] of [
      [states.FALLBACK, 'GATE_FALLBACK'],
      [states.ACCOUNT_REQUIRED, 'GATE_STATE_UNSUPPORTED'],
      [states.LOCKED, 'GATE_STATE_UNSUPPORTED'],
      [states.UNREADABLE, null]
    ]) {
      it(`${state}: nothing clears or reads back, and the sentence does not point at the panel`, async () => {
        // Signed in while the login still worked, so the case also holds the
        // one credential that clears on an armed install.
        let operator = null;
        const { project, sequence, body, token, hint } = await (async () => {
          if (state === states.FALLBACK || state === states.LOCKED) {
            const held = launchInRecovery('operator');
            const pageTok = await pageToken();
            arm();
            operator = await signIn();
            if (state === states.FALLBACK) {
              gateFallback.writeMarker(gateFallback.markerPath(), { createdAt: new Date().toISOString() });
            } else {
              store.getDb().prepare("UPDATE users SET disabled_at = datetime('now')").run();
            }
            recoveryDefault.setGateStateProbe(_recoveryGateProbeFor(listener()));
            assert.equal(recoveryDefault.gateAnswer().gateState, state, 'the fixture must reach the state it is named for');
            return { ...held, token: pageTok, hint: launchSequence.operatorHeldHintFor(held.sequence) };
          }
          return heldIn(state);
        })();
        assert.equal(hint.clear, 'unavailable');
        assert.match(hint.text, /It cannot be cleared/);
        assert.doesNotMatch(hint.text, /Launch readiness panel/, 'the clear is refused here, so the panel is not a way through');
        assert.doesNotMatch(hint.text, /has no login/, 'and this is not an install with no login');
        if (state === states.FALLBACK) assert.match(hint.text, /stood down behind Caddy's/);
        else assert.ok(hint.text.includes(`login gate is "${state}"`), hint.text);

        for (const url of [clearUrl(project), readUrl(project)]) {
          const attempts = Object.values(await bothShapes(url, body, token));
          // The unidentified machine-shaped request is refused before the route in
          // every one of these states (#2233).
          assert.equal(attempts[0].statusCode, 403, `${url}: ${attempts[0].body}`);
          assert.equal(json(attempts[0]).code, 'LAUNCH_BINDING_REQUIRED', url);
          // The launch's own session is identified, so it is the machine-shaped
          // request that reaches the route's own refusal.
          const own = await ownSession(url, { project, sequence, body }, token);
          attempts.push(own);
          if (operator) {
            attempts.push(await send('POST', url, { body, headers: { cookie: operator.cookie, 'x-csrf-token': operator.csrf } }));
          }
          for (const res of attempts) {
            assert.ok(res.statusCode >= 400, `${url} answered ${res.statusCode}: ${res.body}`);
          }
          if (code) {
            assert.equal(json(own).code, code, `${url}: the launch's own session reaches the route's own refusal`);
          }
        }
        assert.ok(stillHeld(sequence), 'nothing cleared it');
      });
    }
  });
});
