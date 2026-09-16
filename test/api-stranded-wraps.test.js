'use strict';

/*
 * GET /api/projects/:project/stranded-wraps (#868) and
 * POST /api/projects/:project/stranded-wraps/ack (#1538), driven through the
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

const store = require('../lib/store');
const authSession = require('../lib/auth-session');
const stranded = require('../lib/stranded-wraps');
const { handleRequest } = require('../server');

const PASSWORD = 'correct-horse-battery';
const REMOTE = 'https://github.com/example/sandbox.git';
const SHA = 'c'.repeat(40);

describe('stranded-wraps API (#868, #1538)', () => {
  let tempDir;
  let prevBase;
  let project;
  let seq = 0;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-stranded-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
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
  });

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
});
