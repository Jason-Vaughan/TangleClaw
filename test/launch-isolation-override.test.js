'use strict';

/*
 * The launch-isolation overrides (#2229): the store's accessor, the one
 * question the launch path asks of it, and the operator-only routes that read,
 * set and clear them. The store is a scratch one. Nothing here launches
 * anything: no launch reads the setting in this file.
 */

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const master = require('../lib/master');
const sessions = require('../lib/sessions');
const logger = require('../lib/logger');
const { createServer } = require('../server');
const { operatorHeaders, bindProject, sendAs, signInOperator, attemptUnidentified, DEFAULT_OPERATOR } = require('./_shared-docs-callers');

const overrides = store.launchIsolationOverrides;
const AT = '2026-10-12T05:00:00.000Z';
const NOT_ALLOWED = (reason) => ({ allowed: false, scope: null, setAt: null, setBy: null, reason });
const BASE = '/api/launch/isolation-overrides';

/**
 * Run `fn` with the logger's console output collected instead of printed.
 * @param {function(): *} fn - The work
 * @returns {{result: *, logged: string}}
 */
function quietly(fn) {
  let logged = '';
  logger.setConsoleStream({ write: (chunk) => { logged += chunk; return true; } });
  try {
    return { result: fn(), logged };
  } finally {
    logger.setConsoleStream(null);
  }
}

/**
 * The activity rows of the two override events, oldest first.
 * @returns {Array<{projectId: (number|null), eventType: string, detail: object}>}
 */
function overrideEvents() {
  return store.getDb().prepare(
    "SELECT project_id, event_type, detail FROM activity_log WHERE event_type LIKE 'launch.isolation_override_%' ORDER BY id"
  ).all().map((row) => ({ projectId: row.project_id, eventType: row.event_type, detail: JSON.parse(row.detail) }));
}

describe('launch-isolation overrides (#2229)', () => {
  let tmpDir;
  let server;
  let alpha;
  let beta;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-isolation-override-'));
    store._setBasePath(tmpDir);
    store.init();
    const mk = (name) => {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir);
      return store.projects.create({ name, path: dir, engine: 'codex' });
    };
    alpha = mk('override-alpha');
    beta = mk('override-beta');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store.getDb().exec('DELETE FROM launch_isolation_overrides');
    store.getDb().exec("DELETE FROM activity_log WHERE event_type LIKE 'launch.isolation_override_%'");
  });

  describe('the store accessor', () => {
    it('is off by default: nothing is listed and nothing is allowed', () => {
      assert.deepEqual(overrides.list(), { install: null, projects: [] });
      assert.deepEqual(overrides.effectiveFor(alpha.id), NOT_ALLOWED('not_set'));
      assert.deepEqual(overrides.effectiveFor(null), NOT_ALLOWED('not_set'));
    });

    it('a project\'s override allows that project only, never another and never the Project Master', () => {
      assert.deepEqual(overrides.set({ projectId: alpha.id, setBy: 'operator', at: AT }), { changed: true });
      assert.deepEqual(overrides.effectiveFor(alpha.id), { allowed: true, scope: 'project', setAt: AT, setBy: 'operator', reason: null });
      assert.deepEqual(overrides.effectiveFor(beta.id), NOT_ALLOWED('not_set'));
      assert.deepEqual(overrides.effectiveFor(null), NOT_ALLOWED('not_set'));
      assert.deepEqual(overrides.list(), { install: null, projects: [{ projectId: alpha.id, setAt: AT, setBy: 'operator' }] });
    });

    it('the install-wide override allows every project and the Project Master', () => {
      overrides.set({ projectId: null, setBy: null, at: AT });
      const expected = { allowed: true, scope: 'install', setAt: AT, setBy: null, reason: null };
      assert.deepEqual(overrides.effectiveFor(alpha.id), expected);
      assert.deepEqual(overrides.effectiveFor(beta.id), expected);
      assert.deepEqual(overrides.effectiveFor(null), expected);
      assert.deepEqual(overrides.list(), { install: { setAt: AT, setBy: null }, projects: [] });
    });

    it('with both on it reports the install-wide one, and falls back to the project\'s when that is cleared', () => {
      overrides.set({ projectId: alpha.id, setBy: 'operator', at: AT });
      overrides.set({ projectId: null, setBy: 'operator', at: '2026-10-12T06:00:00.000Z' });
      assert.equal(overrides.effectiveFor(alpha.id).scope, 'install');
      assert.equal(overrides.effectiveFor(alpha.id).setAt, '2026-10-12T06:00:00.000Z');

      assert.deepEqual(overrides.clear({ projectId: null }), { changed: true });
      assert.deepEqual(overrides.effectiveFor(alpha.id), { allowed: true, scope: 'project', setAt: AT, setBy: 'operator', reason: null });
      assert.deepEqual(overrides.effectiveFor(beta.id), NOT_ALLOWED('not_set'));
    });

    it('a clear takes effect at the next question: nothing is remembered between calls', () => {
      overrides.set({ projectId: alpha.id });
      assert.equal(overrides.effectiveFor(alpha.id).allowed, true);
      overrides.clear({ projectId: alpha.id });
      assert.deepEqual(overrides.effectiveFor(alpha.id), NOT_ALLOWED('not_set'));
    });

    it('setting what is on, and clearing what is off, change nothing and log nothing', () => {
      assert.deepEqual(overrides.set({ projectId: alpha.id, setBy: 'first', at: AT }), { changed: true });
      assert.deepEqual(overrides.set({ projectId: alpha.id, setBy: 'second' }), { changed: false });
      assert.deepEqual(overrides.list().projects, [{ projectId: alpha.id, setAt: AT, setBy: 'first' }]);
      assert.deepEqual(overrides.clear({ projectId: alpha.id, clearedBy: 'first' }), { changed: true });
      assert.deepEqual(overrides.clear({ projectId: alpha.id }), { changed: false });
      assert.deepEqual(overrides.clear({ projectId: null }), { changed: false });
      assert.deepEqual(overrideEvents(), [
        { projectId: alpha.id, eventType: 'launch.isolation_override_set', detail: { scope: 'project', setBy: 'first' } },
        { projectId: alpha.id, eventType: 'launch.isolation_override_cleared', detail: { scope: 'project', clearedBy: 'first' } }
      ]);
    });

    it('records the install-wide override\'s set and clear against no project', () => {
      overrides.set({ projectId: null, setBy: 'operator' });
      overrides.clear({ projectId: null, clearedBy: 'operator' });
      assert.deepEqual(overrideEvents(), [
        { projectId: null, eventType: 'launch.isolation_override_set', detail: { scope: 'install', setBy: 'operator' } },
        { projectId: null, eventType: 'launch.isolation_override_cleared', detail: { scope: 'install', clearedBy: 'operator' } }
      ]);
    });

    it('refuses to store an override for a project that does not exist, or for an id that is not one', () => {
      assert.throws(() => overrides.set({ projectId: 987654 }), (err) => err.code === 'NOT_FOUND');
      for (const bad of [0, -1, 1.5, '7', undefined, NaN]) {
        assert.throws(() => overrides.set({ projectId: bad }), (err) => err.code === 'BAD_REQUEST', String(bad));
        assert.throws(() => overrides.clear({ projectId: bad }), (err) => err.code === 'BAD_REQUEST', String(bad));
      }
      assert.deepEqual(overrides.list(), { install: null, projects: [] });
      assert.deepEqual(overrideEvents(), []);
    });

    it('answers a bad project id as not allowed, even with the install-wide override on, and never throws', () => {
      overrides.set({ projectId: null });
      for (const bad of [0, -1, 1.5, '7', undefined, NaN, {}, 'null']) {
        assert.deepEqual(overrides.effectiveFor(bad), NOT_ALLOWED('bad_project_id'), String(bad));
      }
    });

    it('answers an id that names no project from the rows alone', () => {
      assert.deepEqual(overrides.effectiveFor(987654), NOT_ALLOWED('not_set'));
      overrides.set({ projectId: null, at: AT });
      assert.equal(overrides.effectiveFor(987654).scope, 'install');
    });

    it('gives a new frozen answer each time', () => {
      overrides.set({ projectId: alpha.id });
      const first = overrides.effectiveFor(alpha.id);
      assert.ok(Object.isFrozen(first));
      assert.ok(Object.isFrozen(overrides.effectiveFor(beta.id)));
      assert.notEqual(first, overrides.effectiveFor(alpha.id));
    });

    it('deleting a project removes its override and leaves the others', () => {
      const dir = path.join(tmpDir, 'override-gone');
      fs.mkdirSync(dir);
      const gone = store.projects.create({ name: 'override-gone', path: dir, engine: 'codex' });
      overrides.set({ projectId: gone.id });
      overrides.set({ projectId: alpha.id, at: AT });
      overrides.set({ projectId: null, at: AT });
      store.projects.delete(gone.id);
      assert.deepEqual(overrides.list(), { install: { setAt: AT, setBy: null }, projects: [{ projectId: alpha.id, setAt: AT, setBy: null }] });
    });
  });

  describe('fails closed when the override cannot be read', () => {
    it('answers not allowed, with the reason, and logs what to check, when the table is gone', () => {
      overrides.set({ projectId: null });
      const db = store.getDb();
      db.exec('ALTER TABLE launch_isolation_overrides RENAME TO launch_isolation_overrides_away');
      try {
        const { result, logged } = quietly(() => [overrides.effectiveFor(alpha.id), overrides.effectiveFor(null)]);
        assert.deepEqual(result, [NOT_ALLOWED('unreadable'), NOT_ALLOWED('unreadable')]);
        assert.match(logged, /The launch-isolation override could not be read; the launch is treated as not allowed/);
        assert.match(logged, /launch_isolation_overrides/);
      } finally {
        db.exec('ALTER TABLE launch_isolation_overrides_away RENAME TO launch_isolation_overrides');
      }
      assert.equal(overrides.effectiveFor(alpha.id).allowed, true, 'and applies again once it can be read');
    });

    it('answers not allowed when the row read back is not of the stored shape', () => {
      overrides.set({ projectId: null });
      const real = store.getDb().prepare.bind(store.getDb());
      const stub = mock.method(store.getDb(), 'prepare', (sql) => (
        /FROM launch_isolation_overrides/.test(sql) ? { get: () => ({ scope: 'master', set_at: AT, set_by: null }) } : real(sql)
      ));
      try {
        assert.deepEqual(quietly(() => overrides.effectiveFor(alpha.id)).result, NOT_ALLOWED('unreadable'));
      } finally {
        stub.mock.restore();
      }
    });

    it('answers not allowed, and does not throw, when the store is closed', () => {
      overrides.set({ projectId: null });
      store.close();
      try {
        const { result, logged } = quietly(() => overrides.effectiveFor(alpha.id));
        assert.deepEqual(result, NOT_ALLOWED('unreadable'));
        assert.match(logged, /Store not initialized/);
      } finally {
        store._setBasePath(tmpDir);
        store.init();
      }
      assert.equal(overrides.effectiveFor(alpha.id).allowed, true);
    });
  });

  describe('on an install with no login, where a request\'s shape is all that says "operator"', () => {
    const OFF = { install: { allowed: false, setAt: null, setBy: null }, projects: [] };
    // Each is admitted as the operator by `operatorProjectCaller` while no
    // login is enforced, and each can be sent by any process on the host.
    const SHAPES = {
      'the dashboard\'s marker alone': () => ({ 'x-tangleclaw-client': 'dashboard' }),
      'a Sec-Fetch-Site header alone': () => ({ 'Sec-Fetch-Site': 'same-origin' }),
      'a whole same-origin browser shape': () => operatorHeaders(server)
    };

    for (const [name, headers] of Object.entries(SHAPES)) {
      it(`refuses to turn an override on for ${name}: 403 LOGIN_GATE_REQUIRED, and no row changes`, async () => {
        overrides.set({ projectId: beta.id, setBy: null, at: AT });
        const was = { list: overrides.list(), events: overrideEvents() };
        logger.setConsoleStream({ write: () => true });
        try {
          for (const urlPath of [`${BASE}/install`, `${BASE}/projects/${alpha.id}`, `${BASE}/projects/${beta.id}`, `${BASE}/projects/987654`, `${BASE}/projects/not-an-id`]) {
            const res = await sendAs(server, 'PUT', urlPath, undefined, headers());
            assert.equal(res.status, 403, urlPath);
            assert.equal(res.data.code, 'LOGIN_GATE_REQUIRED', urlPath);
            assert.match(res.data.error, /only by a signed-in operator/);
            assert.match(res.data.error, /Turn TangleClaw's login on, sign in/);
            assert.ok(!('install' in res.data) && !('projects' in res.data), 'the refusal carries no settings');
          }
        } finally {
          logger.setConsoleStream(null);
        }
        assert.deepEqual({ list: overrides.list(), events: overrideEvents() }, was);
        assert.deepEqual(overrides.effectiveFor(alpha.id), NOT_ALLOWED('not_set'));
        assert.deepEqual(overrides.effectiveFor(null), NOT_ALLOWED('not_set'));
      });
    }

    it('still reads the settings: all off by default', async () => {
      const res = await sendAs(server, 'GET', BASE, undefined, operatorHeaders(server));
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, OFF);
    });

    it('still turns off an override that is on, for the install and for a project', async () => {
      overrides.set({ projectId: null, setBy: 'operator', at: AT });
      overrides.set({ projectId: alpha.id, setBy: 'operator', at: AT });
      logger.setConsoleStream({ write: () => true });
      try {
        const read = await sendAs(server, 'GET', BASE, undefined, operatorHeaders(server));
        assert.deepEqual(read.data, {
          install: { allowed: true, setAt: AT, setBy: 'operator' },
          projects: [{ projectId: alpha.id, projectName: 'override-alpha', allowed: true, setAt: AT, setBy: 'operator' }]
        });
        const first = await sendAs(server, 'DELETE', `${BASE}/install`, undefined, operatorHeaders(server));
        assert.equal(first.status, 200);
        assert.equal(first.data.install.allowed, false);
        assert.equal(first.data.projects.length, 1);
        const second = await sendAs(server, 'DELETE', `${BASE}/projects/${alpha.id}`, undefined, operatorHeaders(server));
        assert.equal(second.status, 200);
        assert.deepEqual(second.data, OFF);
        const again = await sendAs(server, 'DELETE', `${BASE}/projects/${alpha.id}`, undefined, operatorHeaders(server));
        assert.equal(again.status, 200);
        assert.deepEqual(again.data, OFF);
      } finally {
        logger.setConsoleStream(null);
      }
      assert.equal(overrides.effectiveFor(alpha.id).allowed, false);
      assert.deepEqual(overrideEvents().map((e) => [e.eventType, e.detail]), [
        ['launch.isolation_override_set', { scope: 'install', setBy: 'operator' }],
        ['launch.isolation_override_set', { scope: 'project', setBy: 'operator' }],
        ['launch.isolation_override_cleared', { scope: 'install', clearedBy: null }],
        ['launch.isolation_override_cleared', { scope: 'project', clearedBy: null }]
      ]);
    });

    it('answers 400 and 404 on a clear for a project that is not named by an id, or does not exist', async () => {
      for (const bad of ['override-alpha', '0', '-3', '1.5', '7x']) {
        const res = await sendAs(server, 'DELETE', `${BASE}/projects/${bad}`, undefined, operatorHeaders(server));
        assert.equal(res.status, 400, bad);
        assert.equal(res.data.code, 'BAD_REQUEST');
      }
      const missing = await sendAs(server, 'DELETE', `${BASE}/projects/987654`, undefined, operatorHeaders(server));
      assert.equal(missing.status, 404);
      assert.equal(missing.data.code, 'NOT_FOUND');
    });
  });

  describe('nobody but the operator reads, sets or clears them', () => {
    const MASTER_ID = 'isolation-override-master-launch';
    const MASTER = { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': MASTER_ID };
    let live;
    let binding;

    /** Every route of the family, with a project that exists and one that does not. */
    const routes = () => [
      ['GET', BASE],
      ['PUT', `${BASE}/install`],
      ['DELETE', `${BASE}/install`],
      ['PUT', `${BASE}/projects/${alpha.id}`],
      ['DELETE', `${BASE}/projects/${alpha.id}`],
      ['PUT', `${BASE}/projects/987654`],
      ['DELETE', `${BASE}/projects/not-an-id`]
    ];

    /**
     * What is stored, to compare before and after a refused request.
     * @returns {object}
     */
    const stored = () => ({ list: overrides.list(), events: overrideEvents() });

    before(() => {
      live = mock.method(master, 'liveMasterLaunchId', () => ({ launchId: MASTER_ID, answered: true, cause: null }));
      binding = bindProject(alpha);
    });

    after(() => live.mock.restore());

    beforeEach(() => {
      // One of each is on, so a refused clear that went through would show.
      overrides.set({ projectId: null, setBy: 'operator', at: AT });
      overrides.set({ projectId: alpha.id, setBy: 'operator', at: AT });
      logger.setConsoleStream({ write: () => true });
    });

    it('a project session, on its own project too, reads 403 OPERATOR_ONLY on every route, before any lookup', async () => {
      const was = stored();
      for (const [method, urlPath] of routes()) {
        const res = await sendAs(server, method, urlPath, undefined, binding.headers);
        logger.setConsoleStream({ write: () => true });
        assert.equal(res.status, 403, `${method} ${urlPath}`);
        assert.equal(res.data.code, 'OPERATOR_ONLY', `${method} ${urlPath}`);
        assert.ok(!('install' in res.data) && !('projects' in res.data), 'the refusal carries no settings');
      }
      logger.setConsoleStream(null);
      assert.deepEqual(stored(), was);
    });

    it('the Project Master reads 403 OPERATOR_ONLY on every route', async () => {
      const was = stored();
      for (const [method, urlPath] of routes()) {
        const res = await sendAs(server, method, urlPath, undefined, MASTER);
        assert.equal(res.status, 403, `${method} ${urlPath}`);
        assert.equal(res.data.code, 'OPERATOR_ONLY', `${method} ${urlPath}`);
      }
      logger.setConsoleStream(null);
      assert.deepEqual(stored(), was);
    });

    it('an unidentified caller reads 403 OPERATOR_ONLY on the settings read, and is refused every set and clear by the launch binding guard', async () => {
      const was = stored();
      for (const [method, urlPath] of routes()) {
        const res = await sendAs(server, method, urlPath, undefined, {});
        assert.equal(res.status, 403, `${method} ${urlPath}`);
        assert.equal(res.data.code, method === 'GET' ? 'OPERATOR_ONLY' : 'LAUNCH_BINDING_REQUIRED', `${method} ${urlPath}`);
        assert.ok(!('install' in res.data) && !('projects' in res.data), 'the refusal carries no settings');
      }
      logger.setConsoleStream(null);
      assert.deepEqual(stored(), was);
    });

    it('a session whose launch has ended is refused every route', async () => {
      const ended = bindProject(beta);
      store.sessions.kill(ended.sessionId, 'test');
      const was = stored();
      for (const [method, urlPath] of routes()) {
        const res = await sendAs(server, method, urlPath, undefined, ended.headers);
        assert.equal(res.status, 403, `${method} ${urlPath}`);
        assert.notEqual(res.data.code, undefined);
        assert.ok(!('install' in res.data), `${method} ${urlPath}`);
      }
      logger.setConsoleStream(null);
      assert.deepEqual(stored(), was);
    });
  });

  describe('on an install whose login gate is on: the signed-in operator\'s routes', () => {
    const OFF = { install: { allowed: false, setAt: null, setBy: null }, projects: [] };
    const NAME = DEFAULT_OPERATOR.username;
    let restore;
    let session;

    before(async () => {
      const config = store.config.load();
      restore = { authEnabled: config.authEnabled, basicAuthUser: config.basicAuthUser, basicAuthHash: config.basicAuthHash };
      store.config.save({ ...config, authEnabled: true, basicAuthUser: null, basicAuthHash: null });
      session = await signInOperator(server);
    });

    after(() => {
      store.config.save({ ...store.config.load(), ...restore });
      store.getDb().prepare('DELETE FROM auth_sessions').run();
      store.getDb().prepare('DELETE FROM recovery_codes').run();
      store.getDb().prepare('DELETE FROM users').run();
    });

    beforeEach(() => logger.setConsoleStream({ write: () => true }));
    afterEach(() => logger.setConsoleStream(null));

    it('turns a project\'s override on and off, answering the settings as they then stand, with the operator\'s name', async () => {
      const on = await sendAs(server, 'PUT', `${BASE}/projects/${alpha.id}`, undefined, session);
      assert.equal(on.status, 200);
      assert.equal(on.data.install.allowed, false);
      assert.equal(on.data.projects.length, 1);
      const [row] = on.data.projects;
      assert.deepEqual({ ...row, setAt: null }, { projectId: alpha.id, projectName: 'override-alpha', allowed: true, setAt: null, setBy: NAME });
      assert.ok(!Number.isNaN(Date.parse(row.setAt)));
      assert.equal(overrides.effectiveFor(alpha.id).scope, 'project');
      assert.equal(overrides.effectiveFor(alpha.id).setBy, NAME);
      assert.equal(overrides.effectiveFor(beta.id).allowed, false);

      const read = await sendAs(server, 'GET', BASE, undefined, session);
      assert.deepEqual(read.data, on.data);

      const again = await sendAs(server, 'PUT', `${BASE}/projects/${alpha.id}`, undefined, session);
      assert.equal(again.status, 200);
      assert.deepEqual(again.data, on.data, 'a second set keeps the first time');

      const off = await sendAs(server, 'DELETE', `${BASE}/projects/${alpha.id}`, undefined, session);
      assert.equal(off.status, 200);
      assert.deepEqual(off.data, OFF);
      assert.equal(overrides.effectiveFor(alpha.id).allowed, false);
    });

    it('turns the install-wide override on and off, and the activity log names who did each', async () => {
      const on = await sendAs(server, 'PUT', `${BASE}/install`, undefined, session);
      assert.equal(on.status, 200);
      assert.equal(on.data.install.allowed, true);
      assert.equal(on.data.install.setBy, NAME);
      assert.ok(!Number.isNaN(Date.parse(on.data.install.setAt)));
      assert.deepEqual(on.data.projects, []);
      assert.equal(overrides.effectiveFor(null).scope, 'install');
      assert.equal(overrides.effectiveFor(beta.id).scope, 'install');

      const off = await sendAs(server, 'DELETE', `${BASE}/install`, undefined, session);
      assert.equal(off.status, 200);
      assert.deepEqual(off.data, OFF);
      assert.equal(overrides.effectiveFor(null).allowed, false);
      assert.deepEqual(overrideEvents().map((e) => [e.eventType, e.detail]), [
        ['launch.isolation_override_set', { scope: 'install', setBy: NAME }],
        ['launch.isolation_override_cleared', { scope: 'install', clearedBy: NAME }]
      ]);
    });

    it('answers 400 for a project segment that is not a numeric id, and 404 for an id no project has', async () => {
      for (const method of ['PUT', 'DELETE']) {
        for (const bad of ['override-alpha', '0', '-3', '1.5', '7x']) {
          const res = await sendAs(server, method, `${BASE}/projects/${bad}`, undefined, session);
          assert.equal(res.status, 400, `${method} ${bad}`);
          assert.equal(res.data.code, 'BAD_REQUEST');
        }
        const missing = await sendAs(server, method, `${BASE}/projects/987654`, undefined, session);
        assert.equal(missing.status, 404, method);
        assert.equal(missing.data.code, 'NOT_FOUND');
      }
      assert.deepEqual(overrides.list(), { install: null, projects: [] });
    });

    it('answers 500 with no settings, and stores nothing, when the store cannot be written or read', async () => {
      const db = store.getDb();
      db.exec('ALTER TABLE launch_isolation_overrides RENAME TO launch_isolation_overrides_away');
      try {
        for (const [method, urlPath] of [['GET', BASE], ['PUT', `${BASE}/install`], ['DELETE', `${BASE}/install`], ['PUT', `${BASE}/projects/${alpha.id}`]]) {
          const res = await sendAs(server, method, urlPath, undefined, session);
          assert.equal(res.status, 500, `${method} ${urlPath}`);
          assert.equal(res.data.code, 'INTERNAL_ERROR');
          assert.ok(!('install' in res.data), `${method} ${urlPath}`);
          assert.doesNotMatch(res.data.error, /Nothing was changed/, 'a write that may have landed is not called unchanged');
        }
      } finally {
        db.exec('ALTER TABLE launch_isolation_overrides_away RENAME TO launch_isolation_overrides');
      }
      assert.deepEqual(overrides.list(), { install: null, projects: [] });
      assert.deepEqual(overrideEvents(), []);
    });

    it('a browser holding no session and a bare request are both refused every route, and nothing is stored', async () => {
      for (const [method, urlPath] of [['GET', BASE], ['PUT', `${BASE}/install`], ['DELETE', `${BASE}/install`], ['PUT', `${BASE}/projects/${alpha.id}`], ['DELETE', `${BASE}/projects/${alpha.id}`]]) {
        const { browser, machine } = await attemptUnidentified(server, method, urlPath);
        assert.equal(browser.status, 401, `${method} ${urlPath}`);
        assert.equal(machine.status, 403, `${method} ${urlPath}`);
        assert.equal(machine.data.code, method === 'GET' ? 'OPERATOR_ONLY' : 'LAUNCH_BINDING_REQUIRED', `${method} ${urlPath}`);
      }
      assert.deepEqual(overrides.list(), { install: null, projects: [] });
    });

    it('a project session reads 403 OPERATOR_ONLY on a set, never the sign-in refusal: who it is comes first', async () => {
      const bound = bindProject(beta);
      for (const urlPath of [`${BASE}/install`, `${BASE}/projects/${beta.id}`]) {
        const res = await sendAs(server, 'PUT', urlPath, undefined, bound.headers);
        assert.equal(res.status, 403, urlPath);
        assert.equal(res.data.code, 'OPERATOR_ONLY', urlPath);
      }
      assert.deepEqual(overrides.list(), { install: null, projects: [] });
    });
  });

  describe('the launch route\'s answer carries the override a launch ran under', () => {
    const realLaunch = sessions.launchSession;
    const session = { id: 99, engineId: 'codex', sessionMode: 'tmux', tmuxSession: 'x', startedAt: 'now' };
    const launched = { session, primePrompt: null, ttydUrl: '/terminal/', error: null, strandedUnchecked: null };

    after(() => { sessions.launchSession = realLaunch; });

    it('is null on an ordinary launch, and is what the launch reports when it reports one', async () => {
      const urlPath = `/api/sessions/${encodeURIComponent(alpha.name)}`;
      sessions.launchSession = () => ({ ...launched });
      let res = await sendAs(server, 'POST', urlPath, {}, operatorHeaders(server));
      assert.equal(res.status, 201);
      assert.ok('isolationOverride' in res.data, 'the key is in the answer, not left out');
      assert.equal(res.data.isolationOverride, null);

      const ranUnder = { scope: 'project', reasonCode: 'version_unverified' };
      sessions.launchSession = () => ({ ...launched, isolationOverride: ranUnder });
      res = await sendAs(server, 'POST', urlPath, {}, operatorHeaders(server));
      assert.equal(res.status, 201);
      assert.deepEqual(res.data.isolationOverride, ranUnder);
    });
  });
});
