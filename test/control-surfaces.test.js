'use strict';

// #1861: every TangleClaw-owned mutation route asks the control gate before
// its side effect. Restart and update-apply gate the CALLER (force never
// bypasses; checking for an update is not a mutation); wrap start, injection,
// actions and launch gate the project they act on. Restart and update-apply are
// stubbed so no test can restart a server or move a checkout.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const control = require('../lib/control-state');
const gate = require('../lib/control-gate');
const sessions = require('../lib/sessions');
const serverInfo = require('../lib/server-info');
const updateApplier = require('../lib/update-applier');
const updateChecker = require('../lib/update-checker');
const controlApi = require('../lib/control-api');
const { createServer } = require('../server');
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');

/**
 * Send a JSON request to the test server.
 * @returns {Promise<{status: number, raw: string, data: object}>}
 */
function send(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1', port: server.address().port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        resolve({ status: res.statusCode, raw, data });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

const OPERATOR = { principal: 'operator', operatorProof: 'verified-session' };

describe('control surfaces (#1861)', () => {
  let tmpDir;
  let server;
  let op;
  let builder;
  let bBuilder;
  let pm;
  let bPM;
  let assignmentId;
  let n = 0;
  const rid = () => { n += 1; return `surf-${n}`; };
  const saved = {};

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-surfaces-'));
    store._setBasePath(tmpDir);
    store.init();
    gate._resetForTests();
    const mk = (name) => {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir);
      return store.projects.create({ name, path: dir, engine: 'claude' });
    };
    builder = mk('builder');
    pm = mk('pm');
    bBuilder = bindProject(builder);
    bPM = bindProject(pm);
    assignmentId = control.create({ projectId: builder.id, requestId: rid(), authority: { hold: [`project:${pm.id}`] } }, OPERATOR).assignment.assignmentId;
    control.hold({ assignmentId, requestId: rid(), reasonCode: 'boundary' }, { principal: `project:${pm.id}` });

    saved.detect = serverInfo.detectRestartMechanism;
    saved.apply = updateApplier.applyUpdate;
    saved.refresh = updateChecker.refreshIfStale;
    saved.send = controlApi._internal.sendSystemMessage;
    serverInfo.detectRestartMechanism = () => null;
    updateApplier.applyUpdate = () => ({ ok: true, stubbed: true });
    updateChecker.refreshIfStale = (_age, cb) => cb(updateChecker.getCachedStatus());
    controlApi._internal.sendSystemMessage = async () => ({ status: 'received' });

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    op = operatorHeaders(server);
  });

  after(async () => {
    serverInfo.detectRestartMechanism = saved.detect;
    updateApplier.applyUpdate = saved.apply;
    updateChecker.refreshIfStale = saved.refresh;
    controlApi._internal.sendSystemMessage = saved.send;
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('caller gate: restart and update-apply', () => {
    for (const route of ['/api/server/restart', '/api/update/apply']) {
      it(`${route}: omitted, mismatched and stale headers are unattributable while a lane is held; force never bypasses`, async () => {
        const omitted = await send(server, 'POST', route, { force: true }, {});
        assert.equal(omitted.status, 423);
        assert.equal(omitted.data.code, 'CONTROL_CALLER_UNATTRIBUTABLE');
        const mismatched = await send(server, 'POST', route, { force: true },
          { 'x-tangleclaw-project-id': String(pm.id), 'x-tangleclaw-launch-id': bBuilder.launchId });
        assert.equal(mismatched.data.code, 'CONTROL_CALLER_UNATTRIBUTABLE');
        const stale = await send(server, 'POST', route, null,
          { 'x-tangleclaw-project-id': String(pm.id), 'x-tangleclaw-launch-id': 'no-such-launch' });
        assert.equal(stale.data.code, 'CONTROL_CALLER_UNATTRIBUTABLE');
      });

      it(`${route}: the held Builder is refused; a clear PM and the operator get through to the (stubbed) action`, async () => {
        const held = await send(server, 'POST', route, { force: true }, bBuilder.headers);
        assert.equal(held.status, 423);
        assert.equal(held.data.code, 'CONTROL_HELD');
        for (const headers of [bPM.headers, op]) {
          const r = await send(server, 'POST', route, null, headers);
          assert.notEqual(r.status, 423, r.raw);
        }
      });
    }

    it('checking for an update and reading its status are not gated while a lane is held', async () => {
      assert.notEqual((await send(server, 'GET', '/api/update-status', null, {})).status, 423);
      assert.notEqual((await send(server, 'POST', '/api/update/check', {}, {})).status, 423);
    });
  });

  describe('target gate', () => {
    it('command injection into a held lane is refused with 423 and its hold ids', async () => {
      const r = await send(server, 'POST', `/api/sessions/${builder.name}/command`, { command: 'git push' }, op);
      assert.equal(r.status, 423);
      assert.equal(r.data.code, 'CONTROL_HELD');
      assert.equal(r.data.assignmentId, assignmentId);
    });

    it('the switchboard wake nudge is the one injection a HOLD does not refuse', () => {
      const refused = sessions.injectCommand(builder.name, 'anything');
      assert.equal(refused.controlRefusal.code, 'CONTROL_HELD');
      const nudge = sessions.injectCommand(builder.name, 'you have mail', { controlExempt: 'medusa-wake' });
      assert.equal(nudge.controlRefusal, undefined, 'not refused by control (it fails later for want of a pane)');
    });

    it('a wrap does not start in a held lane', async () => {
      const r = await send(server, 'POST', `/api/sessions/${builder.name}/wrap`, {}, op);
      assert.equal(r.status, 423);
      assert.equal(r.data.code, 'CONTROL_HELD');
    });

    it('a project action does not type into a held lane', async () => {
      const r = await send(server, 'POST', `/api/projects/${builder.name}/actions/invoke-critic`, {}, op);
      assert.equal(r.status, 423);
    });
  });

  describe('launch', () => {
    it('an ordinary launch into a STOPPED lane is refused with no session created; the operator can still read status', async () => {
      const dir = path.join(tmpDir, 'stopped');
      fs.mkdirSync(dir);
      const stopped = store.projects.create({ name: 'stopped', path: dir, engine: 'claude' });
      const a = control.create({ projectId: stopped.id, requestId: rid() }, OPERATOR).assignment.assignmentId;
      control.stop({ assignmentId: a, requestId: rid(), reasonCode: 'incident' }, OPERATOR);
      const r = await send(server, 'POST', `/api/sessions/${stopped.name}`, {}, op);
      assert.equal(r.status, 423, r.raw);
      assert.equal(r.data.code, 'CONTROL_STOPPED');
      assert.equal(store.sessions.getActive(stopped.id), null);
      const st = await send(server, 'GET', `/api/control/assignments/${a}`, null, op);
      assert.equal(st.data.assignment.state, 'stopped');
    });

    it('after an operator successor supersedes a STOP, a launch is no longer refused and rebinds to the successor', () => {
      const dir = path.join(tmpDir, 'successor');
      fs.mkdirSync(dir);
      const proj = store.projects.create({ name: 'successor', path: dir, engine: 'claude' });
      const old = control.create({ projectId: proj.id, requestId: rid() }, OPERATOR).assignment.assignmentId;
      control.stop({ assignmentId: old, requestId: rid(), reasonCode: 'incident' }, OPERATOR);
      assert.equal(sessions._stoppedLaunchRefusal(proj).code, 'CONTROL_STOPPED');
      const successor = control.create({ projectId: proj.id, requestId: rid() }, OPERATOR).assignment.assignmentId;
      assert.equal(sessions._stoppedLaunchRefusal(proj), null, 'the successor lets the launch through');
      const launch = bindProject(proj);
      sessions._rebindControl(proj, { id: launch.sessionId }, launch.launchId);
      const st = control.status(successor);
      assert.equal(st.assignment.boundSessionId, launch.sessionId);
      assert.equal(st.events.at(-1).kind, 'rebind');
      control.ack({ assignmentId: successor, stateGeneration: 1 }, { principal: `project:${proj.id}`, launchId: launch.launchId });
      assert.equal(control.status(old).assignment.state, 'closed');
    });

    it('a successor launch context says the lane is held before any work', () => {
      const lines = sessions._controlPrimeLines(builder).join('\n');
      assert.match(lines, /HELD at generation 2/);
      assert.match(lines, /tc control ack 2/);
      assert.match(lines, /shell git\/gh is not blocked/);
      assert.deepEqual(sessions._controlPrimeLines(pm), [], 'an ungoverned project\'s prime is unchanged');
    });
  });
});
