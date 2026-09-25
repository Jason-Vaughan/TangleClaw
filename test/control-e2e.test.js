'use strict';

// #1861 exit test: a queued HOLD blocks the next governed mutation before the
// agent reads it. An isolated instance (a scratch store and an in-process
// server on an ephemeral port, never the live service) with a real git repo.
// No Medusa listener exists, so the HOLD notice is never delivered or read:
// the refusal comes from the stored state alone. The same state is what the
// Builder's `tc` shows and what the managed hook in its checkout refuses on.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync, spawn } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const controlApi = require('../lib/control-api');
const { createServer } = require('../server');
const { operatorHeaders, bindProject } = require('./_shared-docs-callers');
const { initRepo } = require('./_temp-repo');

const TC = path.join(__dirname, '..', 'bin', 'tc');

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

/**
 * Run a command WITHOUT blocking this process's event loop, which serves the
 * API the command talks to.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('#1861 exit: a queued HOLD blocks the next governed mutation before the agent reads it', () => {
  let tmpDir;
  let server;
  let api;
  let op;
  let builder;
  let bBuilder;
  let pm;
  let bPM;
  let assignmentId;
  const savedSend = controlApi._internal.sendSystemMessage;
  const savedWs = controlApi._internal.workspaceIdFor;
  const sentNotices = [];
  // A pane launched by TangleClaw exports TANGLECLAW_PORT, and it outranks the
  // config: left in place, the marker written below would name the LIVE
  // server and the hook would query it. This test must only ever talk to its
  // own instance.
  const savedPort = process.env.TANGLECLAW_PORT;

  before(async () => {
    delete process.env.TANGLECLAW_PORT;
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-control-e2e-')));
    store._setBasePath(tmpDir);
    store.init();
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    api = `http://127.0.0.1:${server.address().port}`;
    // The marker the managed hooks read must name THIS instance, never the
    // default port a live install listens on.
    store.config.save({ ...store.config.load(), serverPort: server.address().port, httpsEnabled: false });
    op = operatorHeaders(server);
    // The notice "leaves" but nobody is listening: it is queued, unread.
    controlApi._internal.workspaceIdFor = () => 'ws-builder';
    controlApi._internal.sendSystemMessage = async (m) => { sentNotices.push(m); return { status: 'queued' }; };

    const repoDir = path.join(tmpDir, 'builder');
    fs.mkdirSync(repoDir);
    initRepo(repoDir);
    execSync('git config user.email t@example.com && git config user.name Test && git config commit.gpgsign false', { cwd: repoDir, shell: '/bin/sh' });
    fs.writeFileSync(path.join(repoDir, 'work.txt'), 'v0\n');
    execSync('git add work.txt && git commit -q -m init && git branch -M main', { cwd: repoDir, shell: '/bin/sh' });
    fs.writeFileSync(path.join(repoDir, 'work.txt'), 'the Builder\'s uncommitted work\n');

    builder = store.projects.create({ name: 'builder', path: repoDir, engine: 'claude' });
    const pmDir = path.join(tmpDir, 'pm');
    fs.mkdirSync(pmDir);
    pm = store.projects.create({ name: 'pm', path: pmDir, engine: 'claude' });
    bBuilder = bindProject(builder);
    bPM = bindProject(pm);
  });

  after(async () => {
    controlApi._internal.sendSystemMessage = savedSend;
    controlApi._internal.workspaceIdFor = savedWs;
    if (savedPort === undefined) delete process.env.TANGLECLAW_PORT;
    else process.env.TANGLECLAW_PORT = savedPort;
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GO, then HOLD while the notice sits unread: the wrap is refused, nothing is committed, and the Builder is told at its next tc call', async () => {
    // GO: the operator assigns the lane with the PM as a hold authority.
    const created = await send(server, 'POST', '/api/control/assignments', {
      projectId: builder.id, requestId: 'e2e-create', issueRef: '#1861', authority: { hold: [`project:${pm.id}`] }
    }, op);
    assert.equal(created.status, 201, created.raw);
    assignmentId = created.data.assignment.assignmentId;

    // HOLD: stored and accepted.
    const held = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`,
      { requestId: 'e2e-hold', reasonCode: 'boundary' }, bPM.headers);
    assert.equal(held.status, 201, held.raw);

    // The notice was attempted, but no one has observed or acknowledged it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    const facts = before.data.events.at(-1).receipts.map((r) => r.fact);
    assert.deepEqual(facts, ['notify_pending', 'notify_attempted'], 'queued, never read');
    assert.equal(sentNotices.length, 2, 'one notice per event (create, hold)');

    // The next governed mutation is refused on the stored state alone.
    const headBefore = execSync('git rev-parse HEAD', { cwd: builder.path }).toString().trim();
    const wrap = await send(server, 'POST', `/api/sessions/${builder.name}/wrap`, {}, op);
    assert.equal(wrap.status, 423, wrap.raw);
    assert.equal(wrap.data.code, 'CONTROL_HELD');
    assert.deepEqual(wrap.data.activeHoldIds, [held.data.holdId]);
    assert.equal(execSync('git rev-parse HEAD', { cwd: builder.path }).toString().trim(), headBefore, 'nothing committed');
    assert.match(execSync('git status --porcelain', { cwd: builder.path }).toString(), /work\.txt/, 'the work is still uncommitted');

    // The refusal counts as the target having been shown its state.
    const after = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    assert.ok(after.data.events.at(-1).receipts.some((r) => r.fact === 'observed' && r.outcomeCode === 'gate-refusal'));

    // The Builder's own tc shows the hold, on the control verb and as a
    // notice on any other verb.
    const env = {
      ...process.env,
      TANGLECLAW_API: api,
      TANGLECLAW_PROJECT_ID: String(builder.id),
      TANGLECLAW_LAUNCH_ID: bBuilder.launchId,
      TANGLECLAW_WORKSPACE_ID: ''
    };
    const status = await run(process.execPath, [TC, 'control', 'status'], { env, cwd: builder.path });
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /HELD at generation 2/);
    const other = await run(process.execPath, [TC, 'ports'], { env, cwd: builder.path });
    assert.match(other.stderr, /HELD \(gen 2, 1 hold\)/);
  });

  it('a registered project in another worktree of the clone stays out of the lane, even when it launched first', async () => {
    const sessions = require('../lib/sessions');
    execSync('git worktree add -q ../builder-sibling -b sibling', { cwd: builder.path, shell: '/bin/sh' });
    const siblingPath = path.join(path.dirname(builder.path), 'builder-sibling');
    const sibling = store.projects.create({ name: 'sibling', path: siblingPath, engine: 'claude' });
    // The order that used to leak: the sibling launched before the clone was
    // governed, so it has no marker of its own. Governing the Builder must
    // write the sibling's explicit ungoverned marker by itself.
    const siblingMarker = path.join(builder.path, '.git', 'worktrees', 'builder-sibling', 'tangleclaw-control.json');
    fs.rmSync(siblingMarker, { force: true });
    sessions.syncControlHooks(builder);
    const marker = JSON.parse(fs.readFileSync(siblingMarker, 'utf8'));
    assert.deepEqual(marker, { ungoverned: true });
    fs.appendFileSync(path.join(siblingPath, 'work.txt'), 'sibling work\n');
    const r = await run('git', ['commit', '-am', 'sibling commit while the Builder is held'], { cwd: siblingPath, env: process.env });
    assert.equal(r.code, 0, r.stderr);
  });

  it('the managed hook in the Builder\'s checkout refuses a shell commit while held, and allows it once released', async () => {
    const hookStatus = await send(server, 'GET', '/api/control/mine', null, bBuilder.headers);
    assert.equal(hookStatus.data.controlHook.protected, true, JSON.stringify(hookStatus.data.controlHook));
    const marker = JSON.parse(fs.readFileSync(path.join(builder.path, '.git', 'tangleclaw-control.json'), 'utf8'));
    assert.equal(marker.api, `http://localhost:${server.address().port}`, 'the marker names this test instance, never a live one');
    const refused = await run('git', ['commit', '-am', 'shell commit while held'], { cwd: builder.path, env: process.env });
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /CONTROL_HELD/);

    const st = await send(server, 'GET', `/api/control/assignments/${assignmentId}`, null, op);
    const holdId = st.data.assignment.activeHoldIds[0];
    const released = await send(server, 'POST', `/api/control/assignments/${assignmentId}/release`,
      { holdIds: [holdId], expectedGeneration: 2, requestId: 'e2e-release', reasonCode: 'resolved' }, bPM.headers);
    assert.equal(released.status, 200, released.raw);
    const allowed = await run('git', ['commit', '-am', 'shell commit after release'], { cwd: builder.path, env: process.env });
    assert.equal(allowed.code, 0, allowed.stderr);
  });
});
