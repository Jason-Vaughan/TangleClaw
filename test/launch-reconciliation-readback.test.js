'use strict';

/**
 * `POST /api/sessions/:project/launch/reconciliation` (#1937).
 *
 * A session's reconciliation is its own account of why it may proceed, and in
 * advisory mode it is what clears the launch's recovery. This route is the one
 * place that text leaves the store, and it leaves for the operator only. So
 * the property under test is mostly a negative one: every caller that is not
 * a signed-in operator is refused, and no refusal and no other surface carries
 * the text. That includes everyone on an install with no login, where a
 * request can show only its shape and a session can produce that shape.
 *
 * The text is a sentinel string, so "does not carry it" is a substring check
 * on whole response bodies rather than a check of the fields somebody thought
 * to look at.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel, getLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const gateFallback = require('../lib/gate-fallback');
const openInstallToken = require('../lib/open-install-token');
const lockfile = require('../lib/handoff-lockfile');
const launchSequence = require('../lib/launch-sequence');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');
const { handleRequest } = require('../server');

const PASSWORD = 'correct-horse-battery';
const HOST = 'localhost:3102';
const SENTINEL = 'SENTINEL-7f3a9c';
const RECONCILIATION = `${SENTINEL} The previous handoff cannot be trusted; I am rebuilding context from the plan.`;

describe('the launch reconciliation readback (#1937)', () => {
  let tempDir;
  let prevBase;
  let projectsDir;
  let sessions;
  let counter = 0;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-reconciliation-read-'));
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
   * One request through the real handler.
   * @param {string} method - HTTP method
   * @param {string} url - Request path
   * @param {object} [opts]
   * @param {object} [opts.body] - JSON body
   * @param {object} [opts.headers] - Extra headers, lowercase
   * @param {boolean} [opts.browser] - Whether to look browser-shaped (default true)
   * @returns {Promise<{statusCode: number, body: string, headers: object}>} The response
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
    const res = {
      statusCode: 0,
      body: '',
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, hdrs) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(hdrs || {})) this.headers[k.toLowerCase()] = v;
      },
      end(chunk) { if (chunk != null) this.body = String(chunk); }
    };
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
   * Acknowledge every step of a launch, as its session would.
   * @param {object} id - The pane's identity
   * @returns {void}
   */
  function ackAll(id) {
    for (let i = 0; i < 4; i++) {
      let body = launchSequence.next(id).body;
      while (!body.ack) body = launchSequence.next({ ...id, page: body.page.index + 1 }).body;
      launchSequence.next({ ...id, ack: { step: body.step.id, revision: body.revision, digest: body.ack.digest } });
    }
  }

  /**
   * A launched project. With `damaged`, its preflight demands recovery through
   * the real path: a `current.json` this build cannot read.
   * @param {object} [opts]
   * @param {'operator'|'advisory'} [opts.recoveryMode] - The project's setting
   * @param {boolean} [opts.damaged] - Whether the handoff is unreadable
   * @returns {{project: object, sequence: object, id: object, body: object}}
   */
  function launched({ recoveryMode = 'advisory', damaged = true } = {}) {
    const name = `read-${counter}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    const conf = store.projectConfig.load(dir) || {};
    conf.launchSequence = { ...(conf.launchSequence || {}), recoveryMode };
    store.projectConfig.save(dir, conf);
    // The operator's choice of advisory is a decision on record, as their PATCH
    // writes it. The file alone says advisory only while the login is in force.
    if (recoveryMode === 'advisory') store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
    if (damaged) {
      fs.mkdirSync(lockfile.handoffDir(project), { recursive: true });
      fs.writeFileSync(lockfile.currentPath(project), '{"schema":"not-a-handoff"}\n', 'utf8');
    }
    const session = launch(name).session;
    const sequence = store.launchSequences.getBySession(session.id);
    assert.equal(sequence.recovery, damaged ? 'required' : 'none', 'the fixture must be in the state it is named for');
    return {
      project,
      sequence,
      id: { launchId: sequence.launchId, projectId: project.id },
      body: { sessionId: sequence.sessionId, sequenceId: sequence.id }
    };
  }

  /**
   * An advisory launch whose session attested with the sentinel reconciliation,
   * which cleared its recovery.
   * @returns {{project: object, sequence: object, id: object, body: object}} `sequence` is the row after READY
   */
  function reconciled() {
    const fixture = launched();
    ackAll(fixture.id);
    const answer = launchSequence.ready({
      ...fixture.id,
      artifact: {
        schema: 'tc.ready/1', preflightVerdict: fixture.sequence.preflight.verdict,
        proposedFirstAction: 'start the chunk', reconciliation: RECONCILIATION
      }
    });
    assert.equal(answer.status, 200, answer.body.error);
    const sequence = store.launchSequences.getBySession(fixture.sequence.sessionId);
    assert.equal(sequence.readyArtifact.reconciliation, RECONCILIATION, 'the fixture must hold the text it is named for');
    assert.equal(sequence.recoveryClearance, 'agent-reconciled');
    return { ...fixture, sequence };
  }

  /**
   * The read URL for a project.
   * @param {object} project - Project record
   * @returns {string}
   */
  const readUrl = (project) => `/api/sessions/${encodeURIComponent(project.name)}/launch/reconciliation`;

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
   * Turn the login on and sign in: the one caller the route serves.
   * @returns {Promise<object>} The headers a signed-in operator's browser sends
   */
  async function asOperator() {
    arm();
    const { cookie, csrf } = await signIn();
    return { cookie, 'x-csrf-token': csrf };
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

  /**
   * Assert a response refused the read and carries none of the text.
   * @param {object} res - The response
   * @param {number} status - The expected status
   * @param {string} code - The expected error code
   * @param {string} why - Which caller this is, for the failure message
   * @returns {void}
   */
  function assertRefused(res, status, code, why) {
    assert.equal(res.statusCode, status, `${why}: ${res.body}`);
    assert.equal(json(res).code, code, why);
    assert.equal(res.body.includes(SENTINEL), false, `${why}: a refusal carries none of the text`);
    assert.equal('reconciliation' in json(res), false, `${why}: nor the field it would be in`);
  }

  /**
   * The headers a session bound to a launch sends on its own API calls.
   * @param {object} fixture - A launched fixture
   * @returns {object}
   */
  const boundHeaders = (fixture) => ({
    'x-tangleclaw-launch-id': fixture.sequence.launchId,
    'x-tangleclaw-project-id': String(fixture.project.id)
  });

  describe('what the operator reads', () => {
    it('reads the text with the launch it belongs to, as a signed-in operator', async () => {
      const { project, sequence, body } = reconciled();
      const res = await send('POST', readUrl(project), { body, headers: await asOperator() });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(json(res), {
        schema: launchSequence.RECONCILIATION_READBACK_SCHEMA,
        sequenceId: sequence.id,
        sessionId: sequence.sessionId,
        revision: sequence.readyArtifact.revision,
        acceptedAt: sequence.readyAt,
        readyDigest: sequence.readyDigest,
        recovery: {
          state: 'cleared',
          mode: 'advisory',
          verdict: 'handoff-corrupt',
          attestedVerdict: 'handoff-corrupt',
          clearance: 'agent-reconciled',
          clearedAt: sequence.recoveryClearedAt,
          clearedBy: null
        },
        reconciliation: RECONCILIATION,
        provenance: 'agent-authored-unverified'
      });
      assert.ok(sequence.readyAt && sequence.readyDigest && sequence.recoveryClearedAt,
        'and none of those facts is an empty stand-in');
    });

    it('answers null, not an empty text, for an attestation that carried no reconciliation', async () => {
      const fixture = launched({ damaged: false });
      ackAll(fixture.id);
      const answer = launchSequence.ready({
        ...fixture.id,
        artifact: { schema: 'tc.ready/1', preflightVerdict: fixture.sequence.preflight.verdict, proposedFirstAction: 'start' }
      });
      assert.equal(answer.status, 200, answer.body.error);
      const res = await send('POST', readUrl(fixture.project), { body: fixture.body, headers: await asOperator() });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).reconciliation, null);
      assert.equal(json(res).recovery.state, 'none');
      assert.equal(json(res).recovery.clearance, null);
      assert.equal(json(res).provenance, 'agent-authored-unverified');
    });

    it('says the provenance is the session\'s whoever cleared the recovery', async () => {
      // An operator's clear does not make the session's text the operator's.
      const fixture = launched({ recoveryMode: 'operator' });
      const token = await pageToken();
      const clear = await send('POST', `/api/sessions/${encodeURIComponent(fixture.project.name)}/launch/recovery-clear`, {
        body: { ...fixture.body, recoveryRevision: fixture.sequence.recoveryRevision }, headers: { 'x-tc-open-token': token }
      });
      assert.equal(clear.statusCode, 200, clear.body);
      ackAll(fixture.id);
      const answer = launchSequence.ready({
        ...fixture.id,
        artifact: {
          schema: 'tc.ready/1', preflightVerdict: fixture.sequence.preflight.verdict,
          proposedFirstAction: 'start', reconciliation: RECONCILIATION
        }
      });
      assert.equal(answer.status, 200, answer.body.error);
      const res = await send('POST', readUrl(fixture.project), { body: fixture.body, headers: await asOperator() });
      assert.equal(res.statusCode, 200, res.body);
      const read = json(res);
      assert.equal(read.recovery.clearance, 'open-install-unverified');
      assert.equal(read.recovery.mode, 'operator');
      assert.equal(read.provenance, 'agent-authored-unverified');
    });
  });

  describe('an install with no login: nobody is served', () => {
    // There is nothing on such an install that identifies a person. The most
    // the operator proof can establish is the SHAPE of a request, and a session
    // on the same machine can produce that shape, so the route serves none of
    // them. The two cases that matter most come first: the dashboard itself,
    // and a local process imitating it.
    it('refuses the dashboard\'s own request, page token and all, and says a login is what is missing', async () => {
      const { project, body } = reconciled();
      const res = await send('POST', readUrl(project), { body, headers: { 'x-tc-open-token': await pageToken() } });
      assertRefused(res, 403, 'LOGIN_GATE_REQUIRED', 'the dashboard on an open install');
      assert.match(json(res).error, /no login/);
      assert.match(json(res).error, /Turn the login on/);
    });

    it('refuses a local process that imitates the dashboard, the author\'s own session included', async () => {
      // The request the earlier design served: browser-shaped, same-origin, a
      // page token fetched from `/api/auth/me`. Bound headers or not, it is refused.
      const mine = reconciled();
      const other = launched({ damaged: false });
      const token = await pageToken();
      for (const [who, extra] of [
        ['an unbound imitation', {}],
        ['the author imitating the dashboard', boundHeaders(mine)],
        ['another session imitating the dashboard', boundHeaders(other)],
        ['an imitation that also claims the dashboard header', { 'x-tangleclaw-client': 'dashboard' }]
      ]) {
        assertRefused(
          await send('POST', readUrl(mine.project), { body: mine.body, headers: { ...extra, 'x-tc-open-token': token } }),
          403, 'LOGIN_GATE_REQUIRED', who);
      }
    });

    it('refuses the recovery clear\'s clearance by name: only a verified operator is served', async () => {
      // The clear accepts this same request and records `open-install-unverified`.
      // The read is keyed on the proof's result, so that result is refused here
      // while the clear goes on working as it did.
      const fixture = launched({ recoveryMode: 'operator' });
      const token = await pageToken();
      const clear = await send('POST', `/api/sessions/${encodeURIComponent(fixture.project.name)}/launch/recovery-clear`, {
        body: { ...fixture.body, recoveryRevision: fixture.sequence.recoveryRevision }, headers: { 'x-tc-open-token': token }
      });
      assert.equal(clear.statusCode, 200, clear.body);
      assert.equal(json(clear).recoveryClearance, 'open-install-unverified');
      ackAll(fixture.id);
      const answer = launchSequence.ready({
        ...fixture.id,
        artifact: {
          schema: 'tc.ready/1', preflightVerdict: fixture.sequence.preflight.verdict,
          proposedFirstAction: 'start', reconciliation: RECONCILIATION
        }
      });
      assert.equal(answer.status, 200, answer.body.error);
      assertRefused(await send('POST', readUrl(fixture.project), { body: fixture.body, headers: { 'x-tc-open-token': token } }),
        403, 'LOGIN_GATE_REQUIRED', 'the same request the clear just accepted');
    });

    it('refuses a read with no page token, and one with a token this process never minted', async () => {
      const { project, body } = reconciled();
      assertRefused(await send('POST', readUrl(project), { body }), 403, 'OPEN_INSTALL_TOKEN_INVALID', 'no token');
      assertRefused(await send('POST', readUrl(project), { body, headers: { 'x-tc-open-token': 'a'.repeat(43) } }),
        403, 'OPEN_INSTALL_TOKEN_INVALID', 'a forged token');
    });

    it('refuses a machine client, even one holding a token it fetched itself', async () => {
      // Refused before the route (#2233): the read is a POST, and a POST from a
      // caller that says nothing about who it is does not reach a handler. The
      // route's own OPERATOR_REQUIRED is what a bound session gets, below.
      const { project, body } = reconciled();
      const token = await pageToken();
      assertRefused(await send('POST', readUrl(project), { body, browser: false, headers: { 'x-tc-open-token': token } }),
        403, 'LAUNCH_BINDING_REQUIRED', 'a local process');
    });

    it('refuses the session that wrote it, and any other bound session', async () => {
      const mine = reconciled();
      const other = launched({ damaged: false });
      const token = await pageToken();
      for (const [who, fixture] of [['the author', mine], ['another project\'s session', other]]) {
        assertRefused(
          await send('POST', readUrl(mine.project), {
            body: mine.body, browser: false, headers: { ...boundHeaders(fixture), 'x-tc-open-token': token }
          }),
          403, 'OPERATOR_REQUIRED', who);
      }
    });

    it('refuses a caller claiming the dashboard or the Master by header', async () => {
      const { project, body } = reconciled();
      const token = await pageToken();
      // The dashboard header gets a request to the route, which refuses it as the
      // local process it is. A Master claim nothing backs is refused before the
      // route, as a binding TangleClaw cannot verify (#2233).
      for (const [headers, code] of [
        [{ 'x-tangleclaw-client': 'dashboard', 'x-tc-open-token': token }, 'OPERATOR_REQUIRED'],
        [{ 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': 'no-project-owns-this', 'x-tc-open-token': token },
          'LAUNCH_BINDING_INVALID']
      ]) {
        assertRefused(await send('POST', readUrl(project), { body, browser: false, headers }),
          403, code, JSON.stringify(Object.keys(headers)));
      }
    });

    it('refuses a browser that will not vouch for its own origin', async () => {
      const { project, body } = reconciled();
      const token = await pageToken();
      for (const headers of [
        { origin: undefined, 'x-tc-open-token': token },
        { origin: 'http://evil.example', 'x-tc-open-token': token },
        { 'sec-fetch-site': 'same-site', 'x-tc-open-token': token }
      ]) {
        assertRefused(await send('POST', readUrl(project), { body, headers }), 403, 'CROSS_SITE_FORBIDDEN', JSON.stringify(headers));
      }
    });
  });

  describe('an install with a login: who is refused', () => {
    it('refuses an unauthenticated browser and never reaches the open-install branch', async () => {
      const { project, body } = reconciled();
      const token = await pageToken();
      arm();
      assertRefused(await send('POST', readUrl(project), { body, headers: { 'x-tc-open-token': token } }),
        401, 'UNAUTHENTICATED', 'no session');
    });

    it('refuses a signed-in caller with no CSRF token', async () => {
      const { project, body } = reconciled();
      arm();
      const { cookie } = await signIn();
      assertRefused(await send('POST', readUrl(project), { body, headers: { cookie } }), 403, 'CSRF_TOKEN_INVALID', 'no CSRF token');
    });

    it('refuses every machine caller: the author, another session, the dashboard header, the Master header', async () => {
      const mine = reconciled();
      const other = launched({ damaged: false });
      arm();
      // Two refusals, by who the caller is (#2233). A session bound to a live
      // launch is identified, reaches the route, and is told to sign in: it is not
      // the operator. A caller with no binding, or one nothing backs, is refused
      // before the route. With the login on, the dashboard header identifies
      // nobody.
      const row = () => JSON.stringify(store.getDb().prepare('SELECT * FROM launch_sequences WHERE id = ?').get(mine.sequence.id));
      const before = row();
      for (const [who, headers, status, code] of [
        ['a bare local process', {}, 403, 'LAUNCH_BINDING_REQUIRED'],
        ['the author', boundHeaders(mine), 401, 'UNAUTHENTICATED'],
        ['another project\'s session', boundHeaders(other), 401, 'UNAUTHENTICATED'],
        ['a dashboard header', { 'x-tangleclaw-client': 'dashboard' }, 403, 'LAUNCH_BINDING_REQUIRED'],
        ['a Master header', { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': 'no-project-owns-this' },
          403, 'LAUNCH_BINDING_INVALID']
      ]) {
        assertRefused(await send('POST', readUrl(mine.project), { body: mine.body, browser: false, headers }),
          status, code, who);
      }
      assert.equal(row(), before, 'and the launch row is as it was');
    });
  });

  describe('the other gate states', () => {
    it('refuses while TangleClaw\'s login is stood down behind Caddy\'s', async () => {
      const { project, body } = reconciled();
      arm();
      gateFallback.writeMarker(gateFallback.markerPath(), { createdAt: new Date().toISOString() });
      assertRefused(await send('POST', readUrl(project), { body }), 409, 'GATE_FALLBACK', 'fallback');
    });

    it('refuses in a gate state with no branch of its own, rather than falling through to open', async () => {
      const mine = reconciled();
      const { project, body } = mine;
      const token = await pageToken();
      // The login is on and no account exists yet: `account-required`.
      patchConfig({ authEnabled: true });
      // An unidentified machine client is refused before the route (#2233).
      assertRefused(await send('POST', readUrl(project), { body, browser: false, headers: { 'x-tc-open-token': token } }),
        403, 'LAUNCH_BINDING_REQUIRED', 'a machine client');
      // The route's own branch is what answers a caller who does reach it: the
      // session bound to this launch, which is identified and is not the operator.
      assertRefused(await send('POST', readUrl(project), {
        body, browser: false, headers: { ...boundHeaders(mine), 'x-tc-open-token': token }
      }), 409, 'GATE_STATE_UNSUPPORTED', 'the author\'s own session');
      const browser = await send('POST', readUrl(project), { body, headers: { 'x-tc-open-token': token } });
      assert.equal(browser.statusCode, 401, 'a browser is stopped at the perimeter');
      assert.equal(browser.body.includes(SENTINEL), false);
    });
  });

  describe('the binding', () => {
    it('refuses a sequence that belongs to another project', async () => {
      const mine = launched({ damaged: false });
      const theirs = reconciled();
      assertRefused(
        await send('POST', readUrl(mine.project), { body: theirs.body, headers: await asOperator() }),
        404, 'NOT_FOUND', 'another project\'s launch through this project\'s path');
    });

    it('refuses a session id paired with a sequence id that is not its own', async () => {
      const { project, body } = reconciled();
      assertRefused(
        await send('POST', readUrl(project), {
          body: { ...body, sequenceId: body.sequenceId + 1000 }, headers: await asOperator()
        }),
        404, 'NOT_FOUND', 'a mismatched pair');
    });

    it('refuses a project that does not exist, and a body that names no launch', async () => {
      const { project, body } = reconciled();
      const headers = await asOperator();
      assertRefused(await send('POST', '/api/sessions/no-such-project/launch/reconciliation', {
        body, headers
      }), 404, 'NOT_FOUND', 'an unknown project');
      for (const bad of [{}, { sessionId: 'one', sequenceId: body.sequenceId }, { sessionId: body.sessionId }]) {
        assertRefused(await send('POST', readUrl(project), { body: bad, headers }),
          400, 'BAD_REQUEST', JSON.stringify(bad));
      }
    });

    it('refuses a launch that has not attested, including one whose attempt was rejected', async () => {
      const fixture = launched();
      const headers = await asOperator();
      assertRefused(await send('POST', readUrl(fixture.project), { body: fixture.body, headers }),
        409, 'NOT_ATTESTED', 'never attested');
      // A reconciliation offered before the steps were read is refused and stored nowhere.
      const early = launchSequence.ready({
        ...fixture.id,
        artifact: {
          schema: 'tc.ready/1', preflightVerdict: fixture.sequence.preflight.verdict,
          proposedFirstAction: 'start', reconciliation: RECONCILIATION
        }
      });
      assert.notEqual(early.status, 200, 'the fixture\'s attempt must really have been refused');
      assertRefused(await send('POST', readUrl(fixture.project), { body: fixture.body, headers }),
        409, 'NOT_ATTESTED', 'a rejected attempt');
    });
  });

  describe('the read changes nothing', () => {
    /**
     * The stored row, column for column.
     * @param {number} sequenceId - The sequence
     * @returns {object}
     */
    const rawRow = (sequenceId) => ({ ...store.getDb().prepare('SELECT * FROM launch_sequences WHERE id = ?').get(sequenceId) });

    it('leaves the launch row and the activity log exactly as they were', async () => {
      const { project, sequence, body } = reconciled();
      const headers = await asOperator();
      const before = rawRow(sequence.id);
      const eventsBefore = store.activity.query({ projectId: project.id, limit: 200 }).length;
      for (let i = 0; i < 2; i++) {
        assert.equal((await send('POST', readUrl(project), { body, headers })).statusCode, 200);
      }
      // A refused read changes nothing either: not one refused before the route
      // (#2233), and not one the route itself refuses.
      const unbound = await send('POST', readUrl(project), { body, browser: false });
      assert.equal(unbound.statusCode, 403);
      assert.equal(json(unbound).code, 'LAUNCH_BINDING_REQUIRED');
      const author = await send('POST', readUrl(project), {
        body, browser: false,
        headers: { 'x-tangleclaw-launch-id': sequence.launchId, 'x-tangleclaw-project-id': String(project.id) }
      });
      assert.equal(author.statusCode, 401);
      assert.equal(json(author).code, 'UNAUTHENTICATED');
      assert.deepEqual(rawRow(sequence.id), before, 'the READY artifact, its digest and the recovery columns are untouched');
      assert.equal(store.activity.query({ projectId: project.id, limit: 200 }).length, eventsBefore,
        'a read writes no activity event');
    });

    it('leaves a replayed attestation a duplicate with the same digest', async () => {
      const { project, sequence, id, body } = reconciled();
      assert.equal((await send('POST', readUrl(project), { body, headers: await asOperator() })).statusCode, 200);
      const replay = launchSequence.ready({
        ...id,
        artifact: {
          schema: 'tc.ready/1', preflightVerdict: sequence.preflight.verdict,
          proposedFirstAction: 'start the chunk', reconciliation: RECONCILIATION
        }
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.duplicate, true);
      assert.equal(store.launchSequences.getBySession(sequence.sessionId).readyDigest, sequence.readyDigest);
    });

    it('leaves an operator-mode launch held and clearable exactly as before', async () => {
      const fixture = launched({ recoveryMode: 'operator' });
      const headers = await asOperator();
      assertRefused(await send('POST', readUrl(fixture.project), { body: fixture.body, headers }),
        409, 'NOT_ATTESTED', 'a held launch');
      assert.equal(store.launchSequences.getBySession(fixture.sequence.sessionId).recovery, 'required');
      const clear = await send('POST', `/api/sessions/${encodeURIComponent(fixture.project.name)}/launch/recovery-clear`, {
        body: { ...fixture.body, recoveryRevision: fixture.sequence.recoveryRevision }, headers
      });
      assert.equal(clear.statusCode, 200, clear.body);
      assert.equal(json(clear).recoveryClearance, 'operator-verified');
    });
  });

  describe('the text appears nowhere else', () => {
    it('is absent from the launch list for every caller class, the operator included', async () => {
      const mine = reconciled();
      const other = launched({ damaged: false });
      const url = `/api/launch-sequences?projectId=${mine.project.id}`;
      const callers = [
        ['the operator (browser)', { browser: true }],
        ['the operator (dashboard header)', { browser: false, headers: { 'x-tangleclaw-client': 'dashboard' } }],
        ['an unbound process', { browser: false }],
        ['the author', { browser: false, headers: boundHeaders(mine) }],
        ['another project\'s session', { browser: false, headers: boundHeaders(other) }]
      ];
      for (const [who, opts] of callers) {
        const res = await send('GET', url, opts);
        assert.equal(res.statusCode, 200, `${who}: ${res.body}`);
        assert.ok(json(res).sequences.some((s) => s.sequenceId === mine.sequence.id), `${who}: the fixture's row is in the answer`);
        assert.equal(res.body.includes(SENTINEL), false, who);
        for (const s of json(res).sequences) {
          for (const key of ['reconciliation', 'readyArtifact', 'readyDigest']) assert.equal(key in s, false, `${who}: ${key}`);
        }
      }
    });

    it('is absent from the launch list for the Master, who reads more of that list than a session does', async () => {
      const mine = reconciled();
      const master = require('../lib/master');
      const real = master.liveMasterLaunchId;
      master.liveMasterLaunchId = () => ({ launchId: 'master-live', answered: true, cause: null });
      let res;
      try {
        res = await send('GET', `/api/launch-sequences?projectId=${mine.project.id}`, {
          browser: false, headers: { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': 'master-live' }
        });
      } finally {
        master.liveMasterLaunchId = real;
      }
      assert.equal(res.statusCode, 200, res.body);
      const row = json(res).sequences.find((s) => s.sequenceId === mine.sequence.id);
      assert.ok(row && row.startupControl, 'the caller really resolved as the Master: it got the block only the Master and the operator get');
      assert.equal(res.body.includes(SENTINEL), false);
      for (const key of ['reconciliation', 'readyArtifact', 'readyDigest']) assert.equal(key in row, false, key);
    });

    it('is absent from the server log, for a read that worked and for one that was refused', async () => {
      const { project, sequence, body } = reconciled();
      // Captured in both gate states: a refusal on an install with no login
      // (the dashboard's own request), then a read and a refusal with one on.
      const token = await pageToken();
      const lines = [];
      const level = getLevel();
      setConsoleStream({ write: (line) => { lines.push(String(line)); } });
      setLevel('debug');
      try {
        assert.equal((await send('POST', readUrl(project), { body, headers: { 'x-tc-open-token': token } })).statusCode, 403);
        const headers = await asOperator();
        assert.equal((await send('POST', readUrl(project), { body, headers })).statusCode, 200);
        // Refused before the route (#2233), and then by the route itself for the
        // session bound to this launch.
        assert.equal((await send('POST', readUrl(project), { body, browser: false })).statusCode, 403);
        assert.equal((await send('POST', readUrl(project), {
          body, browser: false,
          headers: { 'x-tangleclaw-launch-id': sequence.launchId, 'x-tangleclaw-project-id': String(project.id) }
        })).statusCode, 401);
      } finally {
        setLevel(level);
        setConsoleStream(null);
      }
      const logged = lines.join('');
      assert.match(logged, /Launch reconciliation read/, 'the successful read is in what was captured');
      assert.match(logged, /Refused a launch reconciliation read/, 'and so is the refusal');
      assert.equal(logged.includes(SENTINEL), false, 'neither line carries the text');
    });

    it('is absent from the session\'s own status and review, and from the activity log', () => {
      const { project, id } = reconciled();
      const status = launchSequence.status(id);
      assert.equal(status.status, 200);
      assert.equal(JSON.stringify(status.body).includes(SENTINEL), false, 'tc start status');
      const review = launchSequence.review({ ...id, step: 4 });
      assert.equal(review.status, 200, JSON.stringify(review.body));
      assert.equal(JSON.stringify(review.body).includes(SENTINEL), false, 'tc start review');
      const events = store.activity.query({ projectId: project.id, limit: 200 });
      assert.ok(events.some((e) => e.eventType === 'launch.ready'), 'the READY event is in what was searched');
      assert.equal(JSON.stringify(events).includes(SENTINEL), false, 'the activity log');
    });
  });

  describe('the projection', () => {
    it('answers null for a launch that has not attested, and for no launch at all', () => {
      assert.equal(launchSequence.reconciliationReadback(null), null);
      assert.equal(launchSequence.reconciliationReadback(launched().sequence), null);
    });

    it('reports the revision the attestation was accepted against, not the row\'s current one', () => {
      const { sequence } = reconciled();
      const later = { ...sequence, revision: sequence.revision + 3 };
      assert.equal(launchSequence.reconciliationReadback(later).revision, sequence.readyArtifact.revision);
    });

    it('never reports a text that is not a non-empty string', () => {
      const { sequence } = reconciled();
      for (const reconciliation of [null, '', undefined, 7, ['x'], { text: 'x' }]) {
        const read = launchSequence.reconciliationReadback({ ...sequence, readyArtifact: { ...sequence.readyArtifact, reconciliation } });
        assert.equal(read.reconciliation, null, JSON.stringify(reconciliation));
      }
    });
  });
});
