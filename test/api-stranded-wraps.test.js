'use strict';

/*
 * GET /api/projects/:project/stranded-wraps (#868) and
 * POST /api/projects/:project/stranded-wraps/ack (#1538) and /open-pr (#1545), driven through the
 * REAL request handler so the auth gate, the CSRF check and the signed-in
 * identity the acknowledgement records are exercised with the routes.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const doubles = require('./_exec-results');

const store = require('../lib/store');
const authSession = require('../lib/auth-session');
const stranded = require('../lib/stranded-wraps');
const strandedCheck = require('../lib/stranded-check');
const { handleRequest } = require('../server');

const PASSWORD = 'correct-horse-battery';
const REMOTE = 'https://github.com/example/sandbox.git';
const SHA = 'c'.repeat(40);

describe('stranded-wraps API (#868, #1538)', () => {
  let tempDir;
  let prevBase;
  let project;
  let seq = 0;

  const realCheckExec = strandedCheck._internal.exec;

  /**
   * What `git` and `gh` answer for the GitHub check in this file: a project with
   * no origin unless a case says otherwise, so no case spawns a real `git`.
   * @type {Function}
   */
  let checkExec;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-stranded-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
    strandedCheck._internal.exec = (...args) => checkExec(...args);
  });

  after(() => {
    strandedCheck._internal.exec = realCheckExec;
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const db = store.getDb();
    db.prepare('DELETE FROM auth_sessions').run();
    db.prepare('DELETE FROM users').run();
    const cfg = store.config.load();
    cfg.setupComplete = true;
    cfg.ingressMode = 'direct';
    cfg.authEnabled = false;
    store.config.save(cfg);
    seq += 1;
    const dir = fs.mkdtempSync(path.join(tempDir, 'proj-'));
    project = store.projects.create({ name: `stranded-api-${seq}`, path: dir, engine: 'claude' });
    checkExec = async () => ({ exitCode: 2, stdout: '', stderr: "error: No such remote 'origin'", error: new Error('exit 2') });
  });

  /**
   * A GitHub where `wrap/1-x` merged and nothing else exists.
   * @param {Promise<void>} [hold] - Resolved when gh may answer
   * @returns {Function}
   */
  const mergedGithub = (hold) => async (file, args) => {
    const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', error: null });
    if (file === 'git' && args[0] === 'remote') return ok(`${REMOTE}\n`);
    if (file === 'git') return ok('');
    if (hold) await hold;
    if (args.includes('--head=wrap/1-x')) {
      return ok(JSON.stringify([{ number: 7, state: 'MERGED', headRefName: 'wrap/1-x', headRefOid: SHA, url: 'https://github.com/example/sandbox/pull/7', statusCheckRollup: [] }]));
    }
    return ok('[]');
  };

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
   * One browser-shaped request through the real handler.
   * @param {string} method
   * @param {string} url
   * @param {object} [opts] - `{body, rawBody, cookie, csrf}`
   * @returns {Promise<object>} The mock response
   */
  async function send(method, url, opts = {}) {
    const raw = opts.rawBody !== undefined ? opts.rawBody
      : (opts.body === undefined ? null : JSON.stringify(opts.body));
    const headers = { host: 'localhost:3102', 'sec-fetch-site': 'same-origin' };
    if (raw !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(raw));
    }
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.csrf) headers[authSession.CSRF_HEADER] = opts.csrf;
    const req = {
      url, method, headers,
      socket: { remoteAddress: '127.0.0.1' },
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
  const cookieOf = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const base = () => `/api/projects/${encodeURIComponent(project.name)}/stranded-wraps`;

  describe('GET', () => {
    it('lists the project\'s stranded wraps with counts', async () => {
      // The older record first, as it happens in practice: newest is listed first.
      store.activity.log({
        projectId: project.id, eventType: 'wrap.auto_pr',
        detail: { branch: 'wrap/0-old', pushed: true, prUrl: null, autoMergeArmed: false, stranded: true }
      });
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      const res = await send('GET', base());
      assert.equal(res.statusCode, 200);
      const body = json(res);
      assert.deepEqual(body.project, { id: project.id, name: project.name });
      assert.deepEqual(body.items.map((i) => [i.branch, i.grandfathered]), [['wrap/1-x', false], ['wrap/0-old', true]]);
      assert.deepEqual(body.counts, { total: 2, unacknowledged: 2, grandfathered: 1, blocking: 1 },
        'a grandfathered item is listed and unacknowledged, but never blocking');
      assert.equal(body.github.state, 'never', 'no GitHub check on record is said, not hidden');
    });

    it('answers by numeric project id as well as by name', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      const res = await send('GET', `/api/projects/${project.id}/stranded-wraps`);
      assert.equal(res.statusCode, 200);
      assert.equal(json(res).items.length, 1);
    });

    it('returns an empty list, not an error, when nothing is recorded', async () => {
      const res = await send('GET', base());
      assert.equal(res.statusCode, 200);
      assert.deepEqual(json(res).items, []);
      assert.deepEqual(json(res).counts, { total: 0, unacknowledged: 0, grandfathered: 0, blocking: 0 });
    });

    it('404s for an unknown project', async () => {
      const res = await send('GET', '/api/projects/no-such-project/stranded-wraps');
      assert.equal(res.statusCode, 404);
      assert.equal(json(res).code, 'NOT_FOUND');
    });

    it('is behind the same sign-in gate as the rest of the API', async () => {
      store.users.create('rosie', PASSWORD);
      const cfg = store.config.load();
      cfg.authEnabled = true;
      store.config.save(cfg);
      const res = await send('GET', base());
      assert.equal(res.statusCode, 401);
    });
  });

  describe('POST /ack', () => {
    it('acknowledges a listed item (201), and the list then shows it acknowledged', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      const res = await send('POST', `${base()}/ack`, { body: { branch: 'wrap/1-x', headSha: SHA } });
      assert.equal(res.statusCode, 201);
      assert.equal(json(res).item.acknowledged, true);
      assert.equal(json(res).item.acknowledgedBy, null, 'nobody is signed in, so nobody is named');

      const after = json(await send('GET', base()));
      assert.equal(after.items[0].acknowledged, true);
      assert.equal(after.counts.unacknowledged, 0);
      assert.equal(after.counts.blocking, 0);
    });

    it('answers 200 with created:false when the item was already acknowledged', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      const first = await send('POST', `${base()}/ack`, { body: { branch: 'wrap/1-x', headSha: SHA } });
      const again = await send('POST', `${base()}/ack`, { body: { branch: 'wrap/1-x', headSha: SHA } });
      assert.equal(first.statusCode, 201);
      assert.equal(json(first).created, true);
      assert.equal(again.statusCode, 200);
      assert.equal(json(again).created, false);
    });

    it('answers 500 when the acknowledgement could not be saved', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      const real = stranded._internal.log;
      stranded._internal.log = () => {};
      let res;
      try {
        res = await send('POST', `${base()}/ack`, { body: { branch: 'wrap/1-x', headSha: SHA } });
      } finally {
        stranded._internal.log = real;
      }
      assert.equal(res.statusCode, 500);
      assert.equal(json(res).code, 'WRITE_FAILED');
    });

    it('records the signed-in user as the acknowledger, never a name from the body', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      store.users.create('rosie', PASSWORD);
      const cfg = store.config.load();
      cfg.authEnabled = true;
      store.config.save(cfg);
      const login = await send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
      assert.equal(login.statusCode, 200);
      const session = { cookie: cookieOf(login), csrf: json(login).csrfToken };

      const res = await send('POST', `${base()}/ack`, {
        ...session, body: { branch: 'wrap/1-x', headSha: SHA, by: 'mallory' }
      });
      assert.equal(res.statusCode, 201);
      assert.equal(json(res).item.acknowledgedBy, 'rosie');
      const [ack] = store.activity.query({ projectId: project.id, eventType: 'wrap.strand_ack' });
      assert.equal(ack.detail.by, 'rosie');
    });

    it('refuses a signed-in acknowledgement with no CSRF token', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      store.users.create('rosie', PASSWORD);
      const cfg = store.config.load();
      cfg.authEnabled = true;
      store.config.save(cfg);
      const login = await send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
      const res = await send('POST', `${base()}/ack`, {
        cookie: cookieOf(login), body: { branch: 'wrap/1-x', headSha: SHA }
      });
      assert.equal(res.statusCode, 403);
      assert.deepEqual(store.activity.query({ projectId: project.id, eventType: 'wrap.strand_ack' }), []);
    });

    it('404s for an item that is not listed, and records nothing', async () => {
      const res = await send('POST', `${base()}/ack`, { body: { branch: 'wrap/9-none', headSha: SHA } });
      assert.equal(res.statusCode, 404);
      assert.equal(json(res).code, 'NOT_FOUND');
      assert.deepEqual(store.activity.query({ projectId: project.id, eventType: 'wrap.strand_ack' }), []);
    });

    it('400s for a missing branch or head SHA', async () => {
      for (const body of [{ headSha: SHA }, { branch: 'wrap/1-x' }, { branch: '', headSha: SHA }]) {
        const res = await send('POST', `${base()}/ack`, { body });
        assert.equal(res.statusCode, 400, JSON.stringify(body));
        assert.equal(json(res).code, 'BAD_REQUEST');
      }
    });

    it('400s for a body that is not a JSON object', async () => {
      const res = await send('POST', `${base()}/ack`, { body: ['wrap/1-x'] });
      assert.equal(res.statusCode, 400);
    });

    it('404s for an unknown project', async () => {
      const res = await send('POST', '/api/projects/no-such-project/stranded-wraps/ack', {
        body: { branch: 'wrap/1-x', headSha: SHA }
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('POST /check (#1542, #1543)', () => {
    it('runs the check and answers with its result and the refreshed list', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      checkExec = mergedGithub();
      const res = await send('POST', `${base()}/check`, { body: {} });
      assert.equal(res.statusCode, 200);
      const body = json(res);
      assert.equal(body.check.state, 'ok');
      assert.deepEqual(body.check.cleared.map((c) => [c.branch, c.reason]), [['wrap/1-x', 'merged']]);
      assert.deepEqual(body.items, []);
      assert.equal(body.counts.blocking, 0);
      assert.equal(body.github.state, 'ok');
      assert.equal(body.github.lastOkAt, body.check.at);
    });

    it('answers 200 with the recorded failure when the check could not run', async () => {
      checkExec = async (file, args) => (file === 'git'
        ? { exitCode: 0, stdout: args[0] === 'remote' ? `${REMOTE}\n` : '', stderr: '', error: null }
        : doubles.notFound('gh'));
      const res = await send('POST', `${base()}/check`, { body: {} });
      assert.equal(res.statusCode, 200);
      const body = json(res);
      assert.equal(body.check.state, 'failed');
      assert.equal(body.github.state, 'failed');
      assert.match(body.github.reason, /gh is not installed/);
    });

    it('404s for an unknown project, and checks nothing', async () => {
      let ran = false;
      checkExec = async () => { ran = true; return { exitCode: 1, stdout: '', stderr: '', error: null }; };
      const res = await send('POST', '/api/projects/no-such-project/stranded-wraps/check', { body: {} });
      assert.equal(res.statusCode, 404);
      assert.equal(ran, false);
    });

    it('refuses a signed-in request with no CSRF token, and checks nothing', async () => {
      store.users.create('rosie', PASSWORD);
      const cfg = store.config.load();
      cfg.authEnabled = true;
      store.config.save(cfg);
      const login = await send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
      let ran = false;
      checkExec = async () => { ran = true; return { exitCode: 1, stdout: '', stderr: '', error: null }; };
      const res = await send('POST', `${base()}/check`, { cookie: cookieOf(login), body: {} });
      assert.equal(res.statusCode, 403);
      assert.equal(ran, false);
      const anon = await send('POST', `${base()}/check`, { body: {} });
      assert.equal(anon.statusCode, 401);
    });
  });

  describe('POST /open-pr (#1545)', () => {
    const PR_URL = 'https://github.com/example/sandbox/pull/42';

    /**
     * A GitHub where `wrap/1-x` is on origin at SHA with no PR, and
     * `gh pr create` answers as given.
     * @param {object} [create] - exec result for `gh pr create`
     * @returns {{exec: Function, creates: string[][]}}
     */
    const openableGithub = (create) => {
      const creates = [];
      const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', error: null });
      const exec = async (file, args) => {
        if (file === 'git' && args[0] === 'remote') return ok(`${REMOTE}\n`);
        if (file === 'git' && args[0] === 'ls-remote') return ok(`${SHA}\trefs/heads/wrap/1-x\n`);
        if (args[1] === 'list') return ok('[]');
        if (args[1] === 'create') {
          creates.push(args);
          return create || ok(`${PR_URL}\n`);
        }
        throw new Error(`unexpected ${file} ${args.join(' ')}`);
      };
      return { exec, creates };
    };

    it('opens the PR and answers 201 with the item', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      const gh = openableGithub();
      checkExec = gh.exec;
      const res = await send('POST', `${base()}/open-pr`, { body: { branch: 'wrap/1-x', headSha: SHA, confirm: true } });
      assert.equal(res.statusCode, 201);
      const body = json(res);
      assert.equal(body.prUrl, PR_URL);
      assert.equal(body.item.prOpened.url, PR_URL);
      assert.equal(body.item.prOpened.by, null, 'nobody is signed in');
      assert.equal(gh.creates.length, 1);
    });

    it('records the signed-in user as the opener, never a name from the body', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      store.users.create('rosie', PASSWORD);
      const cfg = store.config.load();
      cfg.authEnabled = true;
      store.config.save(cfg);
      const login = await send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
      const session = { cookie: cookieOf(login), csrf: json(login).csrfToken };
      checkExec = openableGithub().exec;
      const res = await send('POST', `${base()}/open-pr`, {
        ...session, body: { branch: 'wrap/1-x', headSha: SHA, confirm: true, by: 'mallory' }
      });
      assert.equal(res.statusCode, 201);
      const [row] = store.activity.query({ projectId: project.id, eventType: 'wrap.strand_pr_opened' });
      assert.equal(row.detail.by, 'rosie');
    });

    it('refuses a signed-in request with no CSRF token, and opens nothing', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      store.users.create('rosie', PASSWORD);
      const cfg = store.config.load();
      cfg.authEnabled = true;
      store.config.save(cfg);
      const login = await send('POST', '/api/auth/login', { body: { username: 'rosie', password: PASSWORD } });
      const gh = openableGithub();
      checkExec = gh.exec;
      const res = await send('POST', `${base()}/open-pr`, {
        cookie: cookieOf(login), body: { branch: 'wrap/1-x', headSha: SHA, confirm: true }
      });
      assert.equal(res.statusCode, 403);
      assert.equal(gh.creates.length, 0);
    });

    const statuses = [
      ['400 without confirm', {}, { branch: 'wrap/1-x', headSha: SHA }, 400, 'BAD_REQUEST'],
      ['404 for an unlisted item', {}, { branch: 'wrap/9-none', headSha: SHA, confirm: true }, 404, 'NOT_FOUND'],
      ['409 for a moved branch', { moved: true }, { branch: 'wrap/1-x', headSha: SHA, confirm: true }, 409, 'BRANCH_MOVED'],
      ['422 for a remote not on GitHub', { gitlab: true }, { branch: 'wrap/1-x', headSha: SHA, confirm: true }, 422, 'NOT_GITHUB'],
      ['502 for a failed create', { createFails: true }, { branch: 'wrap/1-x', headSha: SHA, confirm: true }, 502, 'CREATE_FAILED']
    ];
    for (const [label, how, body, status, code] of statuses) {
      it(`answers ${label}, and records nothing`, async () => {
        stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
        const gh = openableGithub(how.createFails
          ? { exitCode: 1, stdout: '', stderr: 'GraphQL: Resource not accessible by integration\n', error: new Error('exit 1') }
          : undefined);
        checkExec = async (file, args) => {
          if (how.gitlab && args[0] === 'remote') return { exitCode: 0, stdout: 'https://gitlab.com/example/sandbox.git\n', stderr: '', error: null };
          if (how.moved && args[0] === 'ls-remote') return { exitCode: 0, stdout: `${'d'.repeat(40)}\trefs/heads/wrap/1-x\n`, stderr: '', error: null };
          return gh.exec(file, args);
        };
        const res = await send('POST', `${base()}/open-pr`, { body });
        assert.equal(res.statusCode, status);
        assert.equal(json(res).code, code);
        assert.equal(typeof json(res).error, 'string');
        assert.deepEqual(store.activity.query({ projectId: project.id, eventType: 'wrap.strand_pr_opened' }), []);
      });
    }

    it('404s for an unknown project', async () => {
      const res = await send('POST', '/api/projects/no-such-project/stranded-wraps/open-pr', {
        body: { branch: 'wrap/1-x', headSha: SHA, confirm: true }
      });
      assert.equal(res.statusCode, 404);
    });

    it('400s for a body that is not a JSON object', async () => {
      const res = await send('POST', `${base()}/open-pr`, { body: ['wrap/1-x'] });
      assert.equal(res.statusCode, 400);
    });
  });

  describe('the check a launch starts (#1542)', () => {
    const sessions = require('../lib/sessions');
    const session = { id: 99, engineId: 'claude', sessionMode: 'tmux', tmuxSession: 'x', startedAt: 'now' };
    let realLaunch;

    before(() => { realLaunch = sessions.launchSession; });
    after(() => { sessions.launchSession = realLaunch; });

    const checkRows = () => store.activity.query({ projectId: project.id, eventType: 'wrap.strand_check' });

    /**
     * Wait until the project has `n` check rows, or fail after a bound.
     * @param {number} n
     */
    async function untilRows(n) {
      for (let i = 0; i < 200 && checkRows().length < n; i += 1) {
        await new Promise((r) => setImmediate(r));
      }
      assert.equal(checkRows().length, n);
    }

    it('answers 201 while the check is still waiting on GitHub, then records it', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      let release;
      checkExec = mergedGithub(new Promise((r) => { release = r; }));
      sessions.launchSession = () => ({ session, primePrompt: null, ttydUrl: '/terminal/', error: null, strandedUnchecked: null });
      const res = await send('POST', `/api/sessions/${encodeURIComponent(project.name)}`, { body: {} });
      assert.equal(res.statusCode, 201);
      assert.deepEqual(checkRows(), [], 'the check has not finished when the launch answers');
      release();
      await untilRows(1);
      assert.equal(checkRows()[0].detail.outcome, 'ok');
      assert.deepEqual(stranded.list(project).items, []);
    });

    it('leaves the launch response unchanged when the check fails', async () => {
      checkExec = async () => { throw new Error('exec exploded'); };
      sessions.launchSession = () => ({ session, primePrompt: null, ttydUrl: '/terminal/', error: null, strandedUnchecked: null });
      const res = await send('POST', `/api/sessions/${encodeURIComponent(project.name)}`, { body: {} });
      assert.equal(res.statusCode, 201);
      assert.equal(json(res).sessionId, 99);
      await untilRows(1);
      assert.equal(checkRows()[0].detail.outcome, 'failed');
      assert.match(checkRows()[0].detail.reason, /exec exploded/);
    });

    it('starts no check when the launch was refused', async () => {
      sessions.launchSession = () => ({ session: null, error: 'Engine "x" is not available' });
      const res = await send('POST', `/api/sessions/${encodeURIComponent(project.name)}`, { body: {} });
      assert.equal(res.statusCode, 400);
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
      assert.deepEqual(checkRows(), []);
    });
  });

  describe('the launch gate on POST /api/sessions/:project (#1539)', () => {
    const engines = require('../lib/engines');
    const sessions = require('../lib/sessions');
    const { installTmuxGuard, removeTmuxGuard } = require('./_tmux-guard');
    let realDetect;

    before(() => {
      installTmuxGuard();
      realDetect = engines.detectEngine;
      engines.detectEngine = () => ({ available: true, path: '/usr/bin/engine' });
    });

    after(() => {
      engines.detectEngine = realDetect;
      removeTmuxGuard();
    });

    it('answers 409 STRANDED_WRAPS with the blocking items, and starts nothing', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      const res = await send('POST', `/api/sessions/${encodeURIComponent(project.name)}`, { body: {} });
      assert.equal(res.statusCode, 409);
      const body = json(res);
      assert.equal(body.code, 'STRANDED_WRAPS');
      assert.deepEqual(body.items.map((i) => [i.remote, i.branch, i.headSha]), [[REMOTE, 'wrap/1-x', SHA]]);
      assert.equal(store.sessions.getActive(project.id), null);
    });

    it('hands acknowledgeStranded to the launch', async () => {
      const keys = [{ remote: REMOTE, branch: 'wrap/1-x', headSha: SHA }];
      const realLaunch = sessions.launchSession;
      let seen = null;
      sessions.launchSession = (name, options) => {
        seen = options;
        return { session: null, primePrompt: null, ttydUrl: null, code: 'NOT_FOUND', error: 'No stranded wrap is listed' };
      };
      try {
        const res = await send('POST', `/api/sessions/${encodeURIComponent(project.name)}`, {
          body: { acknowledgeStranded: keys }
        });
        assert.deepEqual(seen.acknowledgeStranded, keys);
        assert.equal(res.statusCode, 404, 'an acknowledgement that failed keeps its own status, not a generic 500');
        assert.equal(json(res).code, 'NOT_FOUND');
      } finally {
        sessions.launchSession = realLaunch;
      }
    });

    it('says in the 201 when the check was skipped, and null when it ran', async () => {
      const realLaunch = sessions.launchSession;
      const session = { id: 99, engineId: 'claude', sessionMode: 'tmux', tmuxSession: 'x', startedAt: 'now' };
      try {
        sessions.launchSession = () => ({ session, primePrompt: null, ttydUrl: '/terminal/', error: null, strandedUnchecked: 'database is locked' });
        let res = await send('POST', `/api/sessions/${encodeURIComponent(project.name)}`, { body: {} });
        assert.equal(res.statusCode, 201);
        assert.equal(json(res).strandedUnchecked, 'database is locked');
        sessions.launchSession = () => ({ session, primePrompt: null, ttydUrl: '/terminal/', error: null, strandedUnchecked: null });
        res = await send('POST', `/api/sessions/${encodeURIComponent(project.name)}`, { body: {} });
        assert.equal(json(res).strandedUnchecked, null);
      } finally {
        sessions.launchSession = realLaunch;
      }
    });

    it('maps a malformed acknowledgeStranded to 400', async () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
      const res = await send('POST', `/api/sessions/${encodeURIComponent(project.name)}`, {
        body: { acknowledgeStranded: 'wrap/1-x' }
      });
      assert.equal(res.statusCode, 400);
      assert.equal(json(res).code, 'BAD_REQUEST');
    });
  });

  describe('the soft block on POST /api/sessions/:project/wrap (#1540)', () => {
    const wrapRunRegistry = require('../lib/wrap-run-registry');
    const wrapPipeline = require('../lib/wrap-pipeline');
    let realRun;

    before(() => {
      realRun = wrapPipeline.runWrapPipeline;
      wrapPipeline.runWrapPipeline = async () => (
        { ok: false, blockedAt: 'test', results: [], commitSha: null, summary: null, error: null }
      );
    });

    after(() => {
      wrapPipeline.runWrapPipeline = realRun;
      wrapRunRegistry._resetForTests();
    });

    beforeEach(() => {
      wrapRunRegistry._resetForTests();
      store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: `${project.name}-tmux` });
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA });
    });

    const wrapUrl = () => `/api/sessions/${encodeURIComponent(project.name)}/wrap`;

    it('answers 409 STRANDED_WRAPS with the items and claims no run', async () => {
      const res = await send('POST', wrapUrl(), { body: {} });
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).code, 'STRANDED_WRAPS');
      assert.deepEqual(json(res).items.map((i) => i.branch), ['wrap/1-x']);
      assert.equal(json(res).runId, undefined, 'unlike WRAP_IN_PROGRESS, there is no run to follow');
      assert.equal(wrapRunRegistry.get(project.name).runId, null);
    });

    it('starts the wrap when options.proceedPastStranded covers the items', async () => {
      const res = await send('POST', wrapUrl(), {
        body: { options: { proceedPastStranded: [{ remote: REMOTE, branch: 'wrap/1-x', headSha: SHA }] } }
      });
      assert.equal(res.statusCode, 202);
      assert.equal(json(res).strandedUnchecked, null, 'the check ran');
      assert.deepEqual(store.activity.query({ projectId: project.id, eventType: 'wrap.strand_ack' }), []);
    });

    it('says in the 202 when the check was skipped because the records could not be read', async () => {
      const realQuery = stranded._internal.query;
      stranded._internal.query = () => { throw new Error('disk I/O error'); };
      try {
        const res = await send('POST', wrapUrl(), { body: {} });
        assert.equal(res.statusCode, 202);
        assert.match(json(res).strandedUnchecked, /disk I\/O error/);
      } finally {
        stranded._internal.query = realQuery;
      }
    });

    it('answers 400 for a proceed list that is not an array', async () => {
      const res = await send('POST', wrapUrl(), { body: { options: { proceedPastStranded: 'wrap/1-x' } } });
      assert.equal(res.statusCode, 400);
      assert.equal(json(res).code, 'BAD_REQUEST');
    });
  });
});
