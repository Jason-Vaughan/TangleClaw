'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const logger = require('../lib/logger');
const guard = require('../lib/launch-binding-guard');
const serviceToken = require('../lib/service-token');
const wrapRunRegistry = require('../lib/wrap-run-registry');
const { createServer } = require('../server');
const { operatorHeaders, bindProject, sendAs } = require('./_shared-docs-callers');

// What a session is told about the launch identity it carries (#2233), through
// the running server: the verdict `tc whoami` prints, and the one sentence
// every refusal of that identity uses.

describe('launch identity diagnostics through the dispatcher (#2233)', () => {
  let tmpDir;
  let server;
  let project;
  let other;
  let binding;
  let nextPort = 39700;

  /**
   * Create a project on the scratch store.
   * @param {string} name - Project name
   * @returns {object} The project record
   */
  function mk(name) {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  }

  /**
   * Ask whoami as a pane would: the project id in the query, the binding in headers.
   * @param {number|null} projectId - The id the pane claims
   * @param {object} [headers] - The pane's headers
   * @returns {Promise<{status: number, data: object}>}
   */
  function whoami(projectId, headers = {}) {
    const query = projectId === null ? '' : `?projectId=${projectId}`;
    return sendAs(server, 'GET', `/api/tc/whoami${query}`, undefined, headers);
  }

  /**
   * A port lease body for a port nothing else in this file uses.
   * @param {string} name - Project name to lease for
   * @returns {{port: number, body: object}}
   */
  function lease(name) {
    nextPort += 1;
    return { port: nextPort, body: { port: nextPort, project: name, service: 'identity-test', ttl: 60000 } };
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-identity-diag-'));
    store._setBasePath(tmpDir);
    store.init();
    project = mk('diag-project');
    other = mk('diag-other');
    binding = bindProject(project);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('whoami says what the launch binding is worth', () => {
    it('verified: the launch is its project\'s current session', async () => {
      const res = await whoami(project.id, binding.headers);
      assert.equal(res.status, 200);
      assert.deepEqual(res.data.binding, {
        state: 'verified', reason: null, role: 'project', projectId: project.id, sessionId: binding.sessionId, cause: null, recovery: null
      });
      assert.equal(res.data.project.id, project.id);
    });

    it('unbound: no launch id was sent, and the project it claims is still answered', async () => {
      const res = await whoami(project.id);
      assert.equal(res.status, 200);
      assert.equal(res.data.binding.state, 'unbound');
      assert.match(res.data.binding.cause, /TANGLECLAW_LAUNCH_ID/);
      assert.ok(res.data.binding.recovery);
      assert.equal(res.data.project.id, project.id, 'the claimed project is echoed, as before');
    });

    for (const [label, headers, reason] of [
      ['a launch id the store does not hold', () => ({ 'x-tangleclaw-project-id': String(project.id), 'x-tangleclaw-launch-id': 'not-a-launch' }), 'unknown-launch'],
      ['a launch id claimed for another project', () => ({ 'x-tangleclaw-project-id': String(other.id), 'x-tangleclaw-launch-id': binding.launchId }), 'project-mismatch'],
      ['a launch id with no project claim', () => ({ 'x-tangleclaw-launch-id': binding.launchId }), 'project-claim-missing']
    ]) {
      it(`stale: ${label}`, async () => {
        const res = await whoami(project.id, headers());
        assert.equal(res.status, 200, 'a stale binding is diagnosed, not refused');
        assert.equal(res.data.binding.state, 'stale');
        assert.equal(res.data.binding.reason, reason);
        assert.equal(res.data.binding.cause, guard.causeFor(reason));
        assert.match(res.data.binding.recovery, /Do not act from this pane/);
      });
    }

    it('stale: the session has ended', async () => {
      const ended = bindProject(other);
      store.sessions.kill(ended.sessionId, 'test');
      const res = await whoami(other.id, ended.headers);
      assert.equal(res.data.binding.state, 'stale');
      assert.equal(res.data.binding.reason, 'session-not-active');
    });

    it('stale: a newer session of the same project replaced this launch', async () => {
      const p = mk('diag-superseded');
      const first = bindProject(p);
      const second = bindProject(p);
      const old = await whoami(p.id, first.headers);
      assert.equal(old.data.binding.state, 'stale');
      assert.ok(['session-not-current', 'session-not-active'].includes(old.data.binding.reason), old.data.binding.reason);
      const current = await whoami(p.id, second.headers);
      assert.equal(current.data.binding.state, 'verified');
      assert.equal(current.data.binding.sessionId, second.sessionId);
    });

    it('reports on the launch id even when the request is also the operator\'s dashboard', async () => {
      const res = await whoami(project.id, { ...operatorHeaders(server), 'x-tangleclaw-project-id': String(project.id), 'x-tangleclaw-launch-id': 'not-a-launch' });
      assert.equal(res.data.binding.state, 'stale');
      assert.equal(res.data.binding.reason, 'unknown-launch');
    });

    it('gives the Project Master\'s answer a verdict too', async () => {
      const res = await sendAs(server, 'GET', '/api/tc/whoami', undefined, { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': 'not-the-master' });
      assert.equal(res.status, 200);
      assert.equal(res.data.role, 'master');
      assert.equal(res.data.binding.state, 'stale');
      assert.ok(['master-launch-stale', 'master-unverifiable'].includes(res.data.binding.reason), res.data.binding.reason);
    });

    it('a Master launch id tmux could not be asked about is reported as not checked, not as stale', async () => {
      const real = guard.describeBinding;
      const unverifiable = {
        state: 'stale', reason: 'master-unverifiable', role: null, projectId: null, sessionId: null,
        cause: guard.causeFor('master-unverifiable'), recovery: guard.recoveryFor('stale', 'master-unverifiable')
      };
      guard.describeBinding = () => unverifiable;
      try {
        const res = await sendAs(server, 'GET', '/api/tc/whoami', undefined, { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': 'any' });
        assert.equal(res.status, 200);
        assert.deepEqual(res.data.binding, { ...unverifiable, state: 'unknown' }, 'only the state changes: the cause and recovery already say nothing is known to be wrong');
      } finally {
        guard.describeBinding = real;
      }
    });

    it('a check that throws is reported as not checked, and the rest of the answer still arrives', async () => {
      const real = guard.describeBinding;
      guard.describeBinding = () => { throw new Error('database is locked'); };
      try {
        const res = await whoami(project.id, binding.headers);
        assert.equal(res.status, 200);
        assert.equal(res.data.binding.state, 'unknown');
        assert.notEqual(res.data.binding.state, 'verified');
        assert.doesNotMatch(JSON.stringify(res.data), /database is locked/);
        assert.equal(res.data.project.id, project.id);
      } finally {
        guard.describeBinding = real;
      }
    });
  });

  describe('every refusal of a binding says the same thing', () => {
    /**
     * A pane whose launch id belongs to `project` while it claims `other`.
     * @returns {object} Headers
     */
    const foreign = () => ({ 'x-tangleclaw-project-id': String(other.id), 'x-tangleclaw-launch-id': binding.launchId });

    it('the write floor, the launch sequence and whoami agree on a foreign project claim', async () => {
      const told = (await whoami(other.id, foreign())).data.binding;
      assert.equal(told.reason, 'project-mismatch');

      const write = await sendAs(server, 'POST', '/api/ports/lease', lease(other.name).body, foreign());
      assert.equal(write.status, 403);
      for (const urlPath of ['/api/tc/start/next', '/api/tc/start/ready']) {
        const start = await sendAs(server, 'POST', urlPath, {}, foreign());
        assert.equal(start.status, 409, urlPath);
        assert.equal(start.data.code, 'SEQUENCE_SESSION_MISMATCH', urlPath);
        assert.ok(start.data.error.includes(told.cause), `${urlPath}: ${start.data.error}`);
        assert.ok(start.data.error.includes(told.recovery), `${urlPath}: ${start.data.error}`);
      }
      assert.ok(write.data.error.includes(told.cause), write.data.error);
      assert.ok(write.data.error.includes(told.recovery), write.data.error);
    });

    it('a Medusa send, read and close with a stale binding are refused in those words, before the switchboard is asked', async () => {
      const told = (await whoami(other.id, foreign())).data.binding;
      const base = `/api/sessions/${encodeURIComponent(other.name)}/medusa`;
      for (const [urlPath, body] of [
        [`${base}/send`, { to: 'someone', message: 'hello' }],
        [`${base}/read`, { ids: ['m-1'] }],
        [`${base}/exchanges/x-1/close`, {}]
      ]) {
        const res = await sendAs(server, 'POST', urlPath, body, foreign());
        assert.equal(res.status, 403, urlPath);
        assert.equal(res.data.code, 'LAUNCH_BINDING_INVALID', urlPath);
        assert.ok(res.data.error.includes(told.cause), `${urlPath}: ${res.data.error}`);
        assert.ok(res.data.error.includes(told.recovery), `${urlPath}: ${res.data.error}`);
      }
    });

    it('an ended session is told so by the launch sequence in the floor\'s words', async () => {
      const p = mk('diag-ended-words');
      const ended = bindProject(p);
      store.sessions.kill(ended.sessionId, 'test');
      const told = (await whoami(p.id, ended.headers)).data.binding;
      const start = await sendAs(server, 'POST', '/api/tc/start/next', {}, ended.headers);
      assert.equal(start.data.code, 'SESSION_ENDED');
      assert.ok(start.data.error.includes(told.cause), start.data.error);
      assert.ok(start.data.error.includes(told.recovery), start.data.error);
    });
  });

  describe('a wrap in flight', () => {
    it('admits the wrapping session\'s own write while its wrap runs, and refuses it once the wrap has ended the session', async () => {
      const p = mk('diag-wrapping');
      const wrapping = bindProject(p);
      const run = wrapRunRegistry.begin(p.name, wrapping.sessionId, {});
      assert.equal(run.ok, true);
      try {
        const during = lease(p.name);
        const admitted = await sendAs(server, 'POST', '/api/ports/lease', during.body, wrapping.headers);
        assert.equal(admitted.status, 201, JSON.stringify(admitted.data));
        assert.ok(store.portLeases.get(during.port), 'the write happened');

        store.sessions.wrap(wrapping.sessionId, 'done');
      } finally {
        wrapRunRegistry.finish(p.name, run.runId, { success: true });
      }
      const afterWrap = lease(p.name);
      const refused = await sendAs(server, 'POST', '/api/ports/lease', afterWrap.body, wrapping.headers);
      assert.equal(refused.status, 403);
      assert.equal(refused.data.reason, 'session-not-active');
      assert.ok(!store.portLeases.get(afterWrap.port), 'the write did not happen');
    });
  });

  describe('the service-token check', () => {
    it('answers a request when reading its configuration fails, and the write does not happen', async () => {
      // The read sits ahead of the route's own error handling. Left to escape,
      // the request gets no response and the caller's socket stays open.
      const realRequires = serviceToken.requiresServiceToken;
      const realLoad = store.config.load;
      let armed = false;
      serviceToken.requiresServiceToken = (pathname) => {
        const needed = realRequires(pathname);
        armed = needed;
        return needed;
      };
      store.config.load = (...args) => {
        if (armed) { armed = false; throw new Error('config is unreadable'); }
        return realLoad.apply(store.config, args);
      };
      const { port, body } = lease(project.name);
      let timer;
      try {
        const res = await Promise.race([
          sendAs(server, 'POST', '/api/ports/lease', body, operatorHeaders(server)),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('the request was never answered')), 3000);
          })
        ]);
        assert.equal(res.status, 500);
        assert.equal(res.data.code, 'INTERNAL_ERROR');
        assert.doesNotMatch(JSON.stringify(res.data), /config is unreadable/, 'the cause stays in the log');
        assert.ok(!store.portLeases.get(port));
      } finally {
        clearTimeout(timer);
        serviceToken.requiresServiceToken = realRequires;
        store.config.load = realLoad;
      }
      const again = await sendAs(server, 'POST', '/api/ports/lease', lease(project.name).body, operatorHeaders(server));
      assert.equal(again.status, 201, JSON.stringify(again.data));
    });
  });

  describe('the request log', () => {
    /**
     * Run a callback with info-level log lines collected.
     * @param {function(): Promise<void>} fn - The body
     * @returns {Promise<string[]>} The lines written while it ran
     */
    async function collectingLogs(fn) {
      const lines = [];
      const level = logger.getLevel();
      logger.setLevel('info');
      logger.setConsoleStream({ write: (chunk) => { lines.push(String(chunk)); return true; } });
      try { await fn(); } finally {
        logger.setConsoleStream(null);
        logger.setLevel(level);
      }
      return lines;
    }

    it('names who was admitted to a write: the project and its session, or the operator', async () => {
      const lines = await collectingLogs(async () => {
        await sendAs(server, 'POST', '/api/ports/lease', lease(project.name).body, binding.headers);
        await sendAs(server, 'POST', '/api/ports/lease', lease(project.name).body, operatorHeaders(server));
      });
      const writes = lines.filter((line) => line.includes('POST /api/ports/lease') && line.includes('status=201'));
      assert.equal(writes.length, 2, lines.join(''));
      assert.match(writes[0], new RegExp(`via=project admittedProject=${project.id} admittedSession=${binding.sessionId}\\b`));
      assert.match(writes[1], /via=operator\b/);
      assert.doesNotMatch(writes[1], /admittedProject=/);
    });

    it('warns when whoami finds a binding stale, with the reason and who was claimed', async () => {
      const lines = await collectingLogs(async () => {
        await whoami(project.id, { 'x-tangleclaw-project-id': String(project.id), 'x-tangleclaw-launch-id': 'not-a-launch' });
      });
      const warned = lines.filter((line) => line.includes('whoami found a stale launch binding'));
      assert.equal(warned.length, 1, lines.join(''));
      assert.match(warned[0], /WARN/i);
      assert.match(warned[0], /reason=unknown-launch\b/);
      assert.match(warned[0], new RegExp(`claimedProjectId=${project.id}\\b`));
      assert.doesNotMatch(warned[0], /not-a-launch/, 'the launch id itself is not written to the log');
    });

    it('does not warn for a verified binding, or for a caller that sent none', async () => {
      const lines = await collectingLogs(async () => {
        await whoami(project.id, binding.headers);
        await whoami(project.id);
      });
      assert.deepEqual(lines.filter((line) => line.includes('stale launch binding')), [], lines.join(''));
    });

    it('adds nothing to the line for a read', async () => {
      const lines = await collectingLogs(async () => {
        await sendAs(server, 'GET', '/api/ports', undefined, binding.headers);
      });
      const reads = lines.filter((line) => line.includes('GET /api/ports'));
      assert.equal(reads.length, 1, lines.join(''));
      assert.doesNotMatch(reads[0], /via=/);
    });
  });
});
