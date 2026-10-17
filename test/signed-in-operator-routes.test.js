'use strict';

/*
 * The operator routes that grant or approve authority over sessions refuse an
 * operator who is not signed in (#2378). With no login in force (`open`,
 * `fallback`) the operator is recognised by a request's shape, which any
 * process on the host can send; these routes ask for a session the login gate
 * issued instead. Driven through the real server on a scratch store, every
 * caller sent through `test/_shared-docs-callers.js`.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const logger = require('../lib/logger');
const controlApi = require('../lib/control-api');
const gateFallback = require('../lib/gate-fallback');
const { createServer, _routePatterns, _sharedDocWatchers, _sharedDocDebounceTimers } = require('../server');
const { operatorHeaders, bindProject, sendAs, signInOperator } = require('./_shared-docs-callers');

const REFUSED_BY_THIS_CHECK = new Set(['LOGIN_GATE_REQUIRED', 'GATE_FALLBACK']);

// The refusal the launch-isolation override PUTs shipped with (#2229), kept
// byte for byte in every no-login state.
const ISOLATION_REFUSAL = 'A launch-isolation override can be turned on only by a signed-in operator, and this '
  + 'request carries no sign-in: with no login in force nothing would establish that the sender is the operator. '
  + 'Turn TangleClaw\'s login on, sign in, and turn the override on again. Nothing was changed. Reading the '
  + 'overrides and turning one off need no sign-in.';

/**
 * Everything a handler could have written: every table of the store, the
 * global rules document, and every file under the scratch home other than the
 * database's own and the logs.
 * @param {string} home - The scratch home
 * @returns {object}
 */
function snapshot(home) {
  const db = store.getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map((row) => row.name);
  const rows = {};
  for (const table of tables) rows[table] = db.prepare(`SELECT * FROM "${table}"`).all();
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'logs') walk(full);
      } else if (!/\.db(-wal|-shm)?$/.test(entry.name)) {
        files[path.relative(home, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(home);
  return { rows, globalRules: store.globalRules.load(), files };
}

/**
 * Run `fn` with the logger's console output collected instead of printed.
 * @param {function(): Promise<*>} fn - The work
 * @returns {Promise<{result: *, logged: string}>}
 */
async function collectingLog(fn) {
  let logged = '';
  logger.setConsoleStream({ write: (chunk) => { logged += chunk; return true; } });
  try {
    return { result: await fn(), logged };
  } finally {
    logger.setConsoleStream({ write: () => true });
  }
}

describe('operator routes that grant authority need a signed-in operator (#2378)', () => {
  let home;
  let server;
  let alpha;
  let beta;
  let pm;
  let bAlpha;
  let bPM;
  let proposal;
  let learning;
  let group;
  let doc;
  let assignmentId;
  let holdId;
  let n = 0;
  const rid = () => { n += 1; return `w4b2-req-${n}`; };
  const origSend = controlApi._internal.sendSystemMessage;
  const origWs = controlApi._internal.workspaceIdFor;

  const mkProject = (name) => {
    const dir = path.join(home, name);
    fs.mkdirSync(dir);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  };

  // The two request shapes an operator is recognised by while no login is in
  // force. Neither names anyone: any process on the host can send them.
  const SHAPES = {
    'an Origin header': () => ({ Origin: `http://127.0.0.1:${server.address().port}` }),
    'the dashboard\'s marker': () => ({ 'x-tangleclaw-client': 'dashboard' })
  };

  /**
   * The class A requests, each a real request against this file's fixtures:
   * sent by a signed-in operator, each would change the store.
   * @returns {Array<{method: string, pattern: string, url: string, body: (object|undefined)}>}
   */
  function classA() {
    const r = (method, pattern, url, body) => ({ method, pattern, url, body });
    return [
      r('POST', '/api/session-rules', '/api/session-rules', { projectId: alpha.id, content: 'An operator rule.' }),
      r('PUT', '/api/session-rules/:id', `/api/session-rules/${proposal.id}`, { content: 'Changed by the operator.' }),
      r('DELETE', '/api/session-rules/:id', `/api/session-rules/${proposal.id}`),
      r('POST', '/api/session-rules/promote', '/api/session-rules/promote', { learningId: learning.id, projectId: alpha.id }),
      r('PUT', '/api/session-rules/:id/status', `/api/session-rules/${proposal.id}/status`, { status: 'active', expectedContent: proposal.content }),
      r('POST', '/api/session-rules/:id/restore', `/api/session-rules/${proposal.id}/restore`, { versionNo: 1 }),
      r('PUT', '/api/rules/global', '/api/rules/global', { content: '# Changed global rules\n' }),
      r('POST', '/api/rules/global/reset', '/api/rules/global/reset'),
      r('POST', '/api/master/rules/restore-defaults', '/api/master/rules/restore-defaults'),
      r('PUT', '/api/learnings/:id/tier', `/api/learnings/${learning.id}/tier`, { tier: 'active' }),
      r('POST', '/api/coordinator-roles', '/api/coordinator-roles', { projectId: beta.id, role: 'architect' }),
      r('POST', '/api/control/assignments/:id/release', `/api/control/assignments/${assignmentId}/release`,
        { holdIds: [holdId], expectedGeneration: 2, requestId: rid(), reasonCode: 'resolved' }),
      r('POST', '/api/control/assignments/:id/close', `/api/control/assignments/${assignmentId}/close`,
        { requestId: rid(), reasonCode: 'resolved' }),
      r('POST', '/api/merge-queue', '/api/merge-queue', { repo: 'example/repo', baseBranch: 'main', ownerProjectId: alpha.id }),
      r('POST', '/api/merge-queue/:id/clear-halt', '/api/merge-queue/mq_missing/clear-halt', {}),
      r('POST', '/api/merge-queue/entries/:id/operator-gate', '/api/merge-queue/entries/mqe_missing/operator-gate', {}),
      r('POST', '/api/merge-queue/entries/:id/settle-landing', '/api/merge-queue/entries/mqe_missing/settle-landing', {}),
      r('PUT', '/api/startup-prompt', '/api/startup-prompt', { text: 'A startup prompt.', firerProjectIds: [], expectedRevision: 0 }),
      r('PUT', '/api/shared-docs/:id', `/api/shared-docs/${doc.id}`, { description: 'Changed registration.' }),
      r('POST', '/api/groups/:id/members', `/api/groups/${group.id}/members`, { projectId: beta.id }),
      r('PATCH', '/api/projects/:name', `/api/projects/${alpha.name}`, { launchSequence: { recoveryMode: 'advisory' } })
    ];
  }

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-signed-in-operator-'));
    store._setBasePath(home);
    store.init();
    // The global rules document lives in the repository, not the store: a
    // test that writes it is pointed at a scratch copy.
    const rulesPath = path.join(home, 'global-rules.md');
    fs.writeFileSync(rulesPath, '# Global Rules\n\n- Seed rule from test\n');
    store.globalRules._setBundledGlobalRulesPath(rulesPath);
    alpha = mkProject('w4b2-alpha');
    beta = mkProject('w4b2-beta');
    pm = mkProject('w4b2-pm');
    bAlpha = bindProject(alpha);
    bPM = bindProject(pm);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    controlApi._internal.workspaceIdFor = () => 'ws-w4b2';
    controlApi._internal.sendSystemMessage = async () => ({ status: 'received' });
    logger.setConsoleStream({ write: () => true });

    // A session's own proposal: what the operator would approve.
    const proposed = await sendAs(server, 'POST', '/api/session-rules',
      { projectId: alpha.id, content: 'A rule this session proposes.' }, bAlpha.headers);
    assert.equal(proposed.status, 201, JSON.stringify(proposed.data));
    proposal = proposed.data;
    learning = store.learnings.create({ projectId: alpha.id, content: 'A learning the operator could tier.' });
    group = store.projectGroups.create({ name: 'w4b2-group' });
    store.projectGroups.addMember(group.id, alpha.id);
    const docPath = path.join(home, 'SHARED.md');
    fs.writeFileSync(docPath, '# Shared\n');
    doc = store.sharedDocs.create({ groupId: group.id, name: 'SHARED', filePath: docPath });

    // An assignment held by its authority: what the operator would release.
    const created = await sendAs(server, 'POST', '/api/control/assignments', {
      projectId: alpha.id, requestId: rid(), issueRef: '#2378',
      authority: { hold: [`project:${pm.id}`], stop: [`project:${pm.id}`] }
    }, operatorHeaders(server));
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assignmentId = created.data.assignment.assignmentId;
    const held = await sendAs(server, 'POST', `/api/control/assignments/${assignmentId}/hold`,
      { requestId: rid(), reasonCode: 'boundary' }, bPM.headers);
    assert.equal(held.status, 201, JSON.stringify(held.data));
    holdId = held.data.holdId;
  });

  after(async () => {
    controlApi._internal.sendSystemMessage = origSend;
    controlApi._internal.workspaceIdFor = origWs;
    logger.setConsoleStream(null);
    store.globalRules._resetBundledGlobalRulesPath();
    // A shared document's registration change starts a file watcher, which
    // would keep the process alive past the suite.
    for (const { watcher } of _sharedDocWatchers.values()) watcher.close();
    for (const timer of _sharedDocDebounceTimers.values()) clearTimeout(timer);
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('covers exactly the routes registered as needing a signed-in operator, and the one branch-level route', () => {
    const registered = _routePatterns()
      .filter((r) => r.options.signedInOperator && !r.pattern.startsWith('/api/launch/isolation-overrides'))
      .map((r) => `${r.method} ${r.pattern}`)
      .sort();
    const tested = classA().map((r) => `${r.method} ${r.pattern}`).filter((k) => k !== 'PATCH /api/projects/:name').sort();
    assert.deepEqual(tested, registered);
    assert.equal(classA().length, 21);
  });

  describe('with no login in force (open)', () => {
    it('is the install\'s state', async () => {
      const me = await sendAs(server, 'GET', '/api/auth/me', undefined, operatorHeaders(server));
      assert.equal(me.data.gateState, 'open');
    });

    it('tells the dashboard so, and the notice it draws says what this check does (#2378 D3)', async () => {
      // The landing page's no-login notice keys on this field and promises that
      // authority-granting actions are refused until a login is on: the two
      // are read from the same install so the promise cannot drift from it.
      const info = await sendAs(server, 'GET', '/api/server-info', undefined, operatorHeaders(server));
      assert.equal(info.status, 200, JSON.stringify(info.data));
      assert.equal(info.data.authStatus, 'open');
      const res = await sendAs(server, 'POST', '/api/merge-queue/mq_missing/clear-halt', {}, operatorHeaders(server));
      assert.equal(res.status, 403, JSON.stringify(res.data));
      assert.equal(res.data.code, 'LOGIN_GATE_REQUIRED');
    });

    for (const [shapeName, shape] of Object.entries(SHAPES)) {
      it(`refuses every class A route to ${shapeName} with 403 LOGIN_GATE_REQUIRED, and changes nothing`, async () => {
        for (const req of classA()) {
          const was = snapshot(home);
          const res = await sendAs(server, req.method, req.url, req.body, shape());
          const label = `${req.method} ${req.url}`;
          assert.equal(res.status, 403, `${label}: ${JSON.stringify(res.data)}`);
          assert.equal(res.data.code, 'LOGIN_GATE_REQUIRED', label);
          assert.match(res.data.error, /^Only a signed-in operator can /, label);
          assert.match(res.data.error, /Turn TangleClaw's login on, sign in, and send the request again\. Nothing was changed\.$/, label);
          assert.deepEqual(snapshot(home), was, `${label} changed the store`);
        }
      });
    }

    it('keeps the launch-isolation overrides\' own refusal, byte for byte', async () => {
      for (const url of ['/api/launch/isolation-overrides/install', `/api/launch/isolation-overrides/projects/${alpha.id}`]) {
        const res = await sendAs(server, 'PUT', url, undefined, operatorHeaders(server));
        assert.equal(res.status, 403, url);
        assert.equal(res.data.code, 'LOGIN_GATE_REQUIRED', url);
        assert.equal(res.data.error, ISOLATION_REFUSAL, url);
      }
    });

    it('logs every refusal at warn with its code, method, path and gate state', async () => {
      const { logged } = await collectingLog(() => sendAs(server, 'PUT', '/api/rules/global',
        { content: 'x' }, operatorHeaders(server)));
      assert.match(logged, /\[WARN\] \[server\] A request to change the global rules was refused: no signed-in operator code=LOGIN_GATE_REQUIRED method=PUT path=\/api\/rules\/global gateState=open/);
    });

    it('refuses a request carrying a valid launch binding AND a browser\'s shape: the shape makes it the operator', async () => {
      const was = snapshot(home);
      const res = await sendAs(server, 'PUT', `/api/session-rules/${proposal.id}/status`, { status: 'active', expectedContent: proposal.content },
        { ...bAlpha.headers, ...operatorHeaders(server) });
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'LOGIN_GATE_REQUIRED');
      assert.deepEqual(snapshot(home), was);
    });

    it('a rename that also names the recovery mode is refused too, and nothing in it is applied', async () => {
      const was = snapshot(home);
      const res = await sendAs(server, 'PATCH', `/api/projects/${alpha.name}`,
        { name: 'w4b2-alpha-renamed', launchSequence: { recoveryMode: 'advisory' } }, operatorHeaders(server));
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'LOGIN_GATE_REQUIRED');
      assert.match(res.data.error, /^Only a signed-in operator can choose a project's launch recovery mode/);
      assert.deepEqual(snapshot(home), was);
      assert.ok(store.projects.get(alpha.id), 'the project keeps its name');
    });

    describe('what a bound project session does is unchanged', () => {
      it('proposes a rule of its own (201) and still cannot approve it (403 OPERATOR_ONLY)', async () => {
        const own = await sendAs(server, 'POST', '/api/session-rules', { projectId: alpha.id, content: 'Another proposal.' }, bAlpha.headers);
        assert.equal(own.status, 201, JSON.stringify(own.data));
        const approve = await sendAs(server, 'PUT', `/api/session-rules/${own.data.id}/status`, { status: 'active', expectedContent: own.data.content }, bAlpha.headers);
        assert.equal(approve.status, 403);
        assert.equal(approve.data.code, 'OPERATOR_ONLY');
      });

      it('an authority releases the HOLD it placed', async () => {
        const created = await sendAs(server, 'POST', '/api/control/assignments', {
          projectId: beta.id, requestId: rid(), issueRef: '#2378', authority: { hold: [`project:${pm.id}`] }
        }, operatorHeaders(server));
        assert.equal(created.status, 201, JSON.stringify(created.data));
        bindProject(beta);
        const id = created.data.assignment.assignmentId;
        const held = await sendAs(server, 'POST', `/api/control/assignments/${id}/hold`, { requestId: rid(), reasonCode: 'boundary' }, bPM.headers);
        assert.equal(held.status, 201, JSON.stringify(held.data));
        const released = await sendAs(server, 'POST', `/api/control/assignments/${id}/release`,
          { holdIds: [held.data.holdId], expectedGeneration: 2, requestId: rid(), reasonCode: 'resolved' }, bPM.headers);
        assert.equal(released.status, 200, JSON.stringify(released.data));
      });

      it('leases and releases a port', async () => {
        const body = { port: 59377, project: alpha.name, service: 'w4b2-test' };
        const lease = await sendAs(server, 'POST', '/api/ports/lease', body, bAlpha.headers);
        assert.equal(lease.status, 201, JSON.stringify(lease.data));
        const release = await sendAs(server, 'POST', '/api/ports/release', { port: 59377, project: alpha.name }, bAlpha.headers);
        assert.equal(release.status, 200, JSON.stringify(release.data));
      });
    });

    describe('the narrowing and administration routes keep the shape check', () => {
      it('turns a launch-isolation override off', async () => {
        store.launchIsolationOverrides.set({ projectId: null, setBy: 'operator' });
        const res = await sendAs(server, 'DELETE', '/api/launch/isolation-overrides/install', undefined, operatorHeaders(server));
        assert.equal(res.status, 200, JSON.stringify(res.data));
        assert.equal(res.data.install.allowed, false);
      });

      it('revokes a coordinator role', async () => {
        store.coordinatorRoles.grant({ roleId: `role_${rid()}`, projectId: pm.id, role: 'architect', note: null, now: new Date().toISOString() });
        const res = await sendAs(server, 'POST', '/api/coordinator-roles/revoke', { projectId: pm.id }, operatorHeaders(server));
        assert.equal(res.status, 200, JSON.stringify(res.data));
      });

      it('places a HOLD and a STOP', async () => {
        const created = await sendAs(server, 'POST', '/api/control/assignments', {
          projectId: pm.id, requestId: rid(), issueRef: '#2378'
        }, operatorHeaders(server));
        assert.equal(created.status, 201, JSON.stringify(created.data));
        const id = created.data.assignment.assignmentId;
        const hold = await sendAs(server, 'POST', `/api/control/assignments/${id}/hold`, { requestId: rid(), reasonCode: 'boundary' }, operatorHeaders(server));
        assert.equal(hold.status, 201, JSON.stringify(hold.data));
        const stop = await sendAs(server, 'POST', `/api/control/assignments/${id}/stop`, { requestId: rid(), reasonCode: 'incident' }, operatorHeaders(server));
        assert.equal(stop.status, 200, JSON.stringify(stop.data));
      });

      it('removes a project from a group', async () => {
        store.projectGroups.addMember(group.id, pm.id);
        const res = await sendAs(server, 'DELETE', `/api/groups/${group.id}/members/${pm.id}`, undefined, operatorHeaders(server));
        assert.equal(res.status, 200, JSON.stringify(res.data));
      });

      it('changes an ordinary project setting, and renames a project', async () => {
        const gamma = mkProject('w4b2-gamma');
        const setting = await sendAs(server, 'PATCH', `/api/projects/${gamma.name}`, { tags: ['w4b2'] }, operatorHeaders(server));
        assert.equal(setting.status, 200, JSON.stringify(setting.data));
        const rename = await sendAs(server, 'PATCH', `/api/projects/${gamma.name}`, { name: 'w4b2-gamma-renamed' }, operatorHeaders(server));
        assert.equal(rename.status, 200, JSON.stringify(rename.data));
        assert.equal(store.projects.get(gamma.id).name, 'w4b2-gamma-renamed');
      });
    });
  });

  describe('with the login on (armed), a signed-in operator', () => {
    let restore;
    let session;

    before(async () => {
      const config = store.config.load();
      restore = { authEnabled: config.authEnabled, basicAuthUser: config.basicAuthUser, basicAuthHash: config.basicAuthHash };
      store.config.save({ ...config, authEnabled: true, basicAuthUser: null, basicAuthHash: null });
      session = await signInOperator(server);
    });

    it('is the install\'s state', async () => {
      const me = await sendAs(server, 'GET', '/api/auth/me', undefined, session);
      assert.equal(me.data.gateState, 'armed');
    });

    it('tells the dashboard the login is in force, so no notice shows, and the same route is not refused (#2378 D3)', async () => {
      const info = await sendAs(server, 'GET', '/api/server-info', undefined, session);
      assert.equal(info.status, 200, JSON.stringify(info.data));
      assert.equal(info.data.authStatus, 'armed');
      const res = await sendAs(server, 'POST', '/api/merge-queue/mq_missing/clear-halt', {}, session);
      assert.ok(!REFUSED_BY_THIS_CHECK.has(res.data && res.data.code), JSON.stringify(res.data));
    });

    it('does the class A actions: each one changes what it names', async () => {
      const ok = async (method, url, body) => {
        const res = await sendAs(server, method, url, body, session);
        assert.ok(res.status >= 200 && res.status < 300, `${method} ${url}: ${res.status} ${JSON.stringify(res.data)}`);
        return res.data;
      };
      await ok('PUT', '/api/rules/global', { content: '# Changed global rules\n' });
      assert.equal(store.globalRules.load(), '# Changed global rules\n');
      assert.equal((await ok('PUT', `/api/learnings/${learning.id}/tier`, { tier: 'active' })).tier, 'active');
      await ok('PUT', `/api/session-rules/${proposal.id}/status`, { status: 'active', expectedContent: proposal.content });
      assert.equal(store.sessionRules.get(proposal.id).status, 'active');
      await ok('POST', '/api/coordinator-roles', { projectId: beta.id, role: 'architect' });
      await ok('POST', `/api/control/assignments/${assignmentId}/release`,
        { holdIds: [holdId], expectedGeneration: 2, requestId: rid(), reasonCode: 'resolved' });
      await ok('POST', '/api/merge-queue', { repo: 'example/repo', baseBranch: 'main', ownerProjectId: alpha.id });
      await ok('PUT', `/api/shared-docs/${doc.id}`, { description: 'Changed registration.' });
      assert.equal(store.sharedDocs.get(doc.id).description, 'Changed registration.');
      await ok('POST', `/api/groups/${group.id}/members`, { projectId: beta.id });
      await ok('PATCH', `/api/projects/${alpha.name}`, { launchSequence: { recoveryMode: 'advisory' } });
    });

    it('is not refused by this check on any class A route', async () => {
      for (const req of classA()) {
        const res = await sendAs(server, req.method, req.url, req.body, session);
        assert.ok(!REFUSED_BY_THIS_CHECK.has(res.data && res.data.code), `${req.method} ${req.url}: ${JSON.stringify(res.data)}`);
      }
    });

    describe('while TangleClaw\'s login stands down behind Caddy\'s (fallback)', () => {
      before(() => {
        gateFallback.writeMarker(gateFallback.markerPath(), { createdAt: new Date().toISOString() });
      });

      after(() => {
        gateFallback.removeMarker(gateFallback.markerPath());
        store.config.save({ ...store.config.load(), ...restore });
        store.getDb().prepare('DELETE FROM auth_sessions').run();
        store.getDb().prepare('DELETE FROM recovery_codes').run();
        store.getDb().prepare('DELETE FROM users').run();
      });

      it('is the install\'s state', async () => {
        const me = await sendAs(server, 'GET', '/api/auth/me', undefined, operatorHeaders(server));
        assert.equal(me.data.gateState, 'fallback');
      });

      for (const [shapeName, shape] of Object.entries(SHAPES)) {
        it(`refuses every class A route to ${shapeName} with 409 GATE_FALLBACK, and changes nothing`, async () => {
          for (const req of classA()) {
            const was = snapshot(home);
            const res = await sendAs(server, req.method, req.url, req.body, shape());
            const label = `${req.method} ${req.url}`;
            assert.equal(res.status, 409, `${label}: ${JSON.stringify(res.data)}`);
            assert.equal(res.data.code, 'GATE_FALLBACK', label);
            assert.match(res.data.error, /stood down behind Caddy's password \(fallback\), so it cannot /, label);
            assert.deepEqual(snapshot(home), was, `${label} changed the store`);
          }
        });
      }

      it('logs the refusal with gate state fallback', async () => {
        const { logged } = await collectingLog(() => sendAs(server, 'POST', '/api/coordinator-roles',
          { projectId: beta.id, role: 'architect' }, operatorHeaders(server)));
        assert.match(logged, /A request to grant a coordinator role was refused: no signed-in operator code=GATE_FALLBACK method=POST path=\/api\/coordinator-roles gateState=fallback/);
      });

      it('keeps the launch-isolation overrides\' own 403 LOGIN_GATE_REQUIRED, message and log, and changes nothing', async () => {
        for (const url of ['/api/launch/isolation-overrides/install', `/api/launch/isolation-overrides/projects/${alpha.id}`]) {
          const was = snapshot(home);
          const { result: res, logged } = await collectingLog(() => sendAs(server, 'PUT', url, undefined, operatorHeaders(server)));
          assert.equal(res.status, 403, url);
          assert.equal(res.data.code, 'LOGIN_GATE_REQUIRED', url);
          assert.equal(res.data.error, ISOLATION_REFUSAL, url);
          assert.match(logged, new RegExp(`Turning a launch-isolation override on was refused: no signed-in operator code=LOGIN_GATE_REQUIRED method=PUT path=${url.replace(/\//g, '\\/')} gateState=fallback`), url);
          assert.deepEqual(snapshot(home), was, url);
        }
      });
    });
  });
});
