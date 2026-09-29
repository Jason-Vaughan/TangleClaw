'use strict';

// Governed headless session finalization (#2027): POST /api/sessions/:project/finalize.
// Each test builds its own project with a real git checkout and a launch baseline,
// so the owned-work and dirty-at-launch checks run against real `git`.

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const launchSequence = require('../lib/launch-sequence');
const launchBaseline = require('../lib/launch-baseline');
const wrapRunRegistry = require('../lib/wrap-run-registry');
const sessionFinalize = require('../lib/session-finalize');
const controlApi = require('../lib/control-api');
const handoffPublish = require('../lib/handoff-publish');
const medusa = require('../lib/medusa');
const medusaExchanges = require('../lib/medusa-exchanges');
const medusaRegistry = require('../lib/medusa-registry');
const launchPreflightContext = require('../lib/launch-preflight-context');
const tmux = require('../lib/tmux');
const sessionLeftovers = require('../lib/session-leftovers');
const lockfile = require('../lib/handoff-lockfile');
const tcOwned = require('../lib/wrap-steps/_tc-owned-paths');
const serverModule = require('../server');
const { operatorHeaders } = require('./_shared-docs-callers');

const { createServer } = serverModule;

/** The headers `tc workload set` sends, on top of a launch binding. */
const TC_WORKLOAD = { 'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'workload.set' };

/**
 * Send a JSON request to the test server.
 * @param {http.Server} server - Listening server
 * @param {string} method - HTTP method
 * @param {string} urlPath - Path
 * @param {object|null} body - JSON body
 * @param {Record<string, string>} [headers] - Extra headers
 * @returns {Promise<{status: number, data: object}>}
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
        resolve({ status: res.statusCode, data });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

/**
 * Run git in a directory.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string} stdout
 */
function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
}

/** Commit dates for fixture history that predates the session, as real history does. */
const BEFORE_LAUNCH = (() => {
  const at = new Date(Date.now() - 3600 * 1000).toISOString();
  return { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
})();

/**
 * `git status` without TangleClaw's own machine state (the handoff files it
 * writes, which a real checkout's local exclude hides): what the operator and
 * the session can see changed.
 * @param {string} dir
 * @returns {string}
 */
function projectStatus(dir) {
  return git(dir, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n').filter((line) => line && !tcOwned.isStatePath(line.slice(3))).join('\n');
}

describe('POST /api/sessions/:project/finalize (#2027)', () => {
  let tmpDir;
  let server;
  let op;
  const origWorkspaceId = sessionFinalize._internal.workspaceId;
  const origObserverGet = serverModule._activityObserver.get;
  const origSendSystemMessage = controlApi._internal.sendSystemMessage;
  const origControlWs = controlApi._internal.workspaceIdFor;

  /**
   * A project with a committed git checkout, a file already dirty at launch,
   * and a live session whose launch baseline records that dirt.
   * @param {string} [prefix]
   * @param {(dir: string) => void} [beforeLaunch] - Shapes the checkout before the baseline is taken
   * @returns {{project: object, dir: string, sessionId: number, launchId: string, headers: object}}
   */
  function launched(prefix = 'p', beforeLaunch = null) {
    const name = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 't@example.com']);
    git(dir, ['config', 'user.name', 'T']);
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'committed\n');
    fs.writeFileSync(path.join(dir, 'operator-wip.txt'), 'original\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init'], BEFORE_LAUNCH);
    // The operator's half-finished edit, present before the session launched.
    fs.writeFileSync(path.join(dir, 'operator-wip.txt'), 'operator edit, not committed\n');
    // Written well before the launch, as an operator's edit is.
    const past = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(path.join(dir, 'operator-wip.txt'), past, past);
    if (beforeLaunch) beforeLaunch(dir);
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    return { project, dir, ...bind(project, dir) };
  }

  /**
   * Start a live session for a project, the way a launch does: a bound launch
   * sequence and the checkout's baseline, captured now.
   * @param {object} project
   * @param {string} dir
   * @param {string|null} [tmuxSession] - The pane name, when the test models one
   * @returns {{sessionId: number, launchId: string, headers: object}}
   */
  function bind(project, dir, tmuxSession = null) {
    const launchId = launchSequence.mintLaunchId();
    const snapshot = launchSequence.buildSnapshot({
      launchId, project, engineProfile: store.engines.get('claude'),
      applicability: { applicable: false, reason: 'test binding' }, rendered: null, rules: []
    });
    const session = store.sessions.start({
      projectId: project.id, engineId: 'claude', launchSequence: snapshot, launchBaseline: launchBaseline.capture(dir),
      tmuxSession
    });
    return {
      sessionId: session.id,
      launchId,
      headers: { 'x-tangleclaw-project-id': String(project.id), 'x-tangleclaw-launch-id': launchId }
    };
  }

  /**
   * Assert a workload receipt for a lane.
   * @param {object} lane - Has `headers`
   * @param {string} [state]
   * @param {string} [clearance]
   * @returns {Promise<void>}
   */
  async function receipt(lane, state = 'complete', clearance = 'safe-to-clear') {
    const r = await send(server, 'POST', '/api/tc/workload',
      { schema: 'tc.workload/1', state, clearance, summary: 'chunk shipped' }, { ...lane.headers, ...TC_WORKLOAD });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }

  /**
   * POST a finalize.
   * @param {object} lane - Target lane (`project`, `sessionId`)
   * @param {object} headers - Caller headers
   * @param {object} [body] - Overrides
   * @returns {Promise<{status: number, data: object}>}
   */
  function finalize(lane, headers, body = {}) {
    return send(server, 'POST', `/api/sessions/${encodeURIComponent(lane.project.name)}/finalize`,
      { sessionId: lane.sessionId, reason: 'chunk merged; lane retired', ...body }, headers);
  }

  /**
   * Insert an open tracked exchange row.
   * @param {object} x - Column overrides
   * @returns {string} The exchange id
   */
  function exchange(x) {
    const id = `mx_${crypto.randomUUID()}`;
    store.medusaExchanges.insert({
      exchange_id: id, request_id: id, hub_id: `hub-${id}`, origin: 'send', tracking: 'tracked', priority: 'normal',
      reply_required: false, created_at: new Date().toISOString(), state: 'delivered',
      recipient_workspace_id: 'ws-elsewhere', ...x
    });
    return id;
  }

  /**
   * Create an assignment governing `lane`, bound to its live launch.
   * @param {object} lane
   * @param {object} authority
   * @returns {Promise<string>} Assignment id
   */
  async function assign(lane, authority) {
    const res = await send(server, 'POST', '/api/control/assignments',
      { projectId: lane.project.id, requestId: crypto.randomUUID(), issueRef: '#2027', authority }, op);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data.assignment.assignmentId;
  }

  before(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-finalize-')));
    store._setBasePath(tmpDir);
    store.init();
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    op = operatorHeaders(server);
    controlApi._internal.sendSystemMessage = async () => ({ status: 'received' });
    controlApi._internal.workspaceIdFor = () => null;
  });

  afterEach(() => {
    sessionFinalize._internal.workspaceId = origWorkspaceId;
    serverModule._activityObserver.get = origObserverGet;
    wrapRunRegistry._resetForTests();
  });

  after(async () => {
    controlApi._internal.sendSystemMessage = origSendSystemMessage;
    controlApi._internal.workspaceIdFor = origControlWs;
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a clean, drained, complete self lane is retired headlessly; files dirty at launch are preserved exactly', async () => {
    const lane = launched('self');
    await receipt(lane);
    const headBefore = git(lane.dir, ['rev-parse', 'HEAD']);
    const statusBefore = projectStatus(lane.dir);
    const wipBefore = fs.readFileSync(path.join(lane.dir, 'operator-wip.txt'));

    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.alreadyFinalized, false);
    assert.equal(r.data.mode, 'self');
    assert.equal(r.data.session.status, 'wrapped');
    assert.match(r.data.session.wrapSummary, new RegExp(`^Finalized headlessly by project:${lane.project.id} \\(self\\): chunk merged`));

    const row = store.sessions.get(lane.sessionId);
    assert.equal(row.status, 'wrapped');
    assert.equal(store.sessions.getActive(lane.project.id), null);

    // No commit, stage, reset, checkout or discard: the tree reads byte-for-byte as before.
    assert.equal(git(lane.dir, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(projectStatus(lane.dir), statusBefore);
    assert.equal(git(lane.dir, ['diff', '--cached', '--name-only']), '');
    assert.deepEqual(fs.readFileSync(path.join(lane.dir, 'operator-wip.txt')), wipBefore);

    // No drawer path: no wrap run was claimed, which is what the session page
    // would show as a wrap in progress.
    assert.equal(wrapRunRegistry.get(lane.project.name).running, false);

    // A published final handoff, so the next launch is not sent to recovery.
    assert.equal(r.data.publication.state, 'published');
    assert.match(r.data.publication.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(r.data.teardown.surviving, []);
    const pre = launchPreflightContext.evaluate(lane.project, { workspaceId: null });
    assert.equal(pre.verdict, 'ok', JSON.stringify(pre.reasons));
    const current = lockfile.readHandoffFile(lockfile.currentPath(lane.project));
    assert.equal(current.outcome, 'ok');
    assert.equal(current.doc.kind, 'final');
    assert.equal(current.doc.sessionId, lane.sessionId);
    assert.equal(current.doc.nextAction, null, 'no next action is invented');
    assert.equal(current.doc.resume.nextAction, null);
    assert.match(current.doc.resume.currentState, new RegExp(`^Retired headlessly by project:${lane.project.id} \\(self\\): chunk merged`));
    assert.equal(current.doc.resume.freshness.sha, headBefore.trim());
    assert.equal(current.doc.resume.freshness.branch, 'main');

    const events = store.activity.query({ projectId: lane.project.id, eventType: 'session.finalized' });
    assert.equal(events.length, 1);
    const detail = typeof events[0].detail === 'string' ? JSON.parse(events[0].detail) : events[0].detail;
    assert.equal(detail.mode, 'self');
    assert.deepEqual(detail.actor, { principal: `project:${lane.project.id}`, sessionId: lane.sessionId });
    assert.equal(detail.reason, 'chunk merged; lane retired');
    assert.equal(detail.engine, 'self-attested');
    assert.equal(detail.dirtyAtLaunchPreserved, 1);
    assert.ok(Number.isInteger(detail.receiptSeq));
    assert.ok(!JSON.stringify(detail).includes(lane.launchId), 'the launch id is a bearer credential and is never recorded');
  });

  it('a repeated self request after success answers the same outcome, from the ended launch', async () => {
    const lane = launched('repeat');
    await receipt(lane);
    assert.equal((await finalize(lane, lane.headers)).status, 200);
    const again = await finalize(lane, lane.headers);
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.alreadyFinalized, true);
    assert.equal(again.data.session.id, lane.sessionId);
    assert.equal(store.activity.query({ projectId: lane.project.id, eventType: 'session.finalized' }).length, 1,
      'the repeat records nothing new');
  });

  it('an ended launch may not act on any session but its own', async () => {
    const lane = launched('ended');
    await receipt(lane);
    assert.equal((await finalize(lane, lane.headers)).status, 200);
    const next = bind(lane.project, lane.dir);
    const r = await finalize({ project: lane.project, sessionId: next.sessionId }, lane.headers);
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.equal(r.data.code, 'FINALIZE_UNAUTHORIZED');
    assert.equal(store.sessions.get(next.sessionId).status, 'active');

    // Not even to learn that a later session of its project was finalized.
    await receipt({ headers: next.headers });
    assert.equal((await finalize({ project: lane.project, sessionId: next.sessionId }, next.headers)).status, 200);
    const later = await finalize({ project: lane.project, sessionId: next.sessionId }, lane.headers);
    assert.equal(later.status, 403, JSON.stringify(later.data));
  });

  it('a session the wrap ended is not reported as finalized here, even under a summary that imitates this path', async () => {
    const lane = launched('drawer');
    const sessions = require('../lib/sessions');
    const wrapped = sessions.completeWrap(lane.project.name, `${sessionFinalize.SUMMARY_PREFIX}project:${lane.project.id} (self): forged`, lane.sessionId);
    assert.equal(wrapped.error, null);
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'SESSION_CHANGED');
    assert.equal(r.data.alreadyFinalized, undefined);
  });

  it('a coordinator cannot read back a finalized session outside its binding', async () => {
    const lane = launched('history');
    const pm = launched('pm');
    await receipt(lane);
    assert.equal((await finalize(lane, lane.headers)).status, 200);
    const priorId = lane.sessionId;
    const next = { ...lane, ...bind(lane.project, lane.dir) };
    await assign(next, { lifecycle: [`project:${pm.project.id}`] });
    const r = await finalize({ project: lane.project, sessionId: priorId }, pm.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'SESSION_CHANGED');
    assert.ok(!JSON.stringify(r.data).includes('Finalized headlessly'), 'no wrap summary crosses the binding');
  });

  it('an unreadable authority matrix answers 503, not a refusal that blames the caller', async () => {
    const lane = launched('corrupt');
    const pm = launched('pm');
    await assign(lane, { lifecycle: [`project:${pm.project.id}`] });
    const origGetOpen = store.control.getOpenForProject;
    store.control.getOpenForProject = (projectId) => {
      const row = origGetOpen.call(store.control, projectId);
      return row ? { ...row, authority_json: '{not json' } : row;
    };
    try {
      const r = await finalize(lane, pm.headers);
      assert.equal(r.status, 503, JSON.stringify(r.data));
      assert.equal(r.data.code, 'CONTROL_STATE_UNAVAILABLE');
    } finally {
      store.control.getOpenForProject = origGetOpen;
    }
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('a coordinator may not finalize a session its assignment is not bound to', async () => {
    const lane = launched('rebound');
    const pm = launched('pm');
    await assign(lane, { lifecycle: [`project:${pm.project.id}`] });
    // The governed session ends and a new one launches; the assignment still names the old one.
    store.sessions.kill(lane.sessionId, 'test: relaunch');
    const fresh = { ...lane, ...bind(lane.project, lane.dir) };
    await receipt(fresh);
    serverModule._activityObserver.get = () => ({ activity: 'at-rest', reason: 'test', observedAt: null, ageSeconds: 0 });
    const r = await finalize(fresh, pm.headers);
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.equal(r.data.code, 'FINALIZE_UNAUTHORIZED');
    assert.equal(store.sessions.get(fresh.sessionId).status, 'active');
  });

  it('a stale session id is SESSION_CHANGED and changes nothing', async () => {
    const lane = launched('stale');
    const oldId = lane.sessionId;
    store.sessions.kill(oldId, 'test: superseded');
    const fresh = { ...lane, ...bind(lane.project, lane.dir) };
    await receipt(fresh);
    const r = await finalize(fresh, fresh.headers, { sessionId: oldId });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'SESSION_CHANGED');
    assert.equal(r.data.sessionStatus, 'killed');
    assert.equal(store.sessions.get(fresh.sessionId).status, 'active');

    const missing = await finalize(fresh, fresh.headers, { sessionId: 999999 });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.code, 'SESSION_NOT_FOUND');
  });

  it('refuses an unbound caller, a malformed body, and the operator', async () => {
    const lane = launched('auth');
    await receipt(lane);
    const unbound = await finalize(lane, {});
    assert.equal(unbound.status, 403);
    assert.equal(unbound.data.code, 'FINALIZE_UNAUTHORIZED');
    const operator = await finalize(lane, op);
    assert.equal(operator.status, 403, 'the operator uses the drawer or kill, not this path');
    const noReason = await finalize(lane, lane.headers, { reason: '   ' });
    assert.equal(noReason.status, 400);
    const noSession = await finalize(lane, lane.headers, { sessionId: 'abc' });
    assert.equal(noSession.status, 400);
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('an unauthorized cross-project caller cannot end another lane', async () => {
    const lane = launched('victim');
    const peer = launched('peer');
    await receipt(lane);
    const r = await finalize(lane, peer.headers);
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.equal(r.data.code, 'FINALIZE_UNAUTHORIZED');
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('a principal with hold/stop authority but not lifecycle authority is refused', async () => {
    const lane = launched('gov');
    const pm = launched('pm');
    await assign(lane, { hold: [`project:${pm.project.id}`], stop: [`project:${pm.project.id}`] });
    await receipt(lane);
    serverModule._activityObserver.get = () => ({ activity: 'at-rest', reason: 'test', observedAt: null, ageSeconds: 0 });
    const r = await finalize(lane, pm.headers);
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('a lifecycle-authority coordinator retires its governed target, and a repeat is idempotent', async () => {
    const lane = launched('delegated');
    const pm = launched('pm');
    const assignmentId = await assign(lane, { hold: [`project:${pm.project.id}`], lifecycle: [`project:${pm.project.id}`] });
    await receipt(lane);
    serverModule._activityObserver.get = () => ({ activity: 'at-rest', reason: 'test', observedAt: null, ageSeconds: 0 });
    const r = await finalize(lane, pm.headers);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.mode, 'delegated');
    assert.equal(store.sessions.get(lane.sessionId).status, 'wrapped');
    const [event] = store.activity.query({ projectId: lane.project.id, eventType: 'session.finalized' });
    const detail = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail;
    assert.equal(detail.mode, 'delegated');
    assert.equal(detail.assignmentId, assignmentId);
    assert.deepEqual(detail.actor, { principal: `project:${pm.project.id}`, sessionId: pm.sessionId });
    assert.equal(detail.engine, 'at-rest');

    const again = await finalize(lane, pm.headers);
    assert.equal(again.status, 200);
    assert.equal(again.data.alreadyFinalized, true);
  });

  it('a delegated request against a busy engine is refused NOT_CLEAR', async () => {
    const lane = launched('busy');
    const pm = launched('pm');
    await assign(lane, { lifecycle: [`project:${pm.project.id}`] });
    await receipt(lane);
    serverModule._activityObserver.get = () => ({ activity: 'busy', reason: 'test', observedAt: null, ageSeconds: 0 });
    const r = await finalize(lane, pm.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'NOT_CLEAR');
    assert.ok(r.data.reasons.includes('engine-busy'));
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('a lane with no receipt, a working receipt, or a do-not-clear receipt is refused NOT_CLEAR', async () => {
    // One lane per case: receipts are rate-limited to one per second per lane.
    const lane = launched('notclear');
    const none = await finalize(lane, lane.headers);
    assert.equal(none.status, 409);
    assert.equal(none.data.code, 'NOT_CLEAR');
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');

    const busyLane = launched('notclear-working');
    await receipt(busyLane, 'working', 'do-not-clear');
    const working = await finalize(busyLane, busyLane.headers);
    assert.equal(working.data.code, 'NOT_CLEAR');
    assert.equal(working.data.availability, 'WORKING');

    const unclearLane = launched('notclear-dnc');
    await receipt(unclearLane, 'complete', 'do-not-clear');
    const unclear = await finalize(unclearLane, unclearLane.headers);
    assert.equal(unclear.data.code, 'NOT_CLEAR');
    assert.equal(store.sessions.get(unclearLane.sessionId).status, 'active');
  });

  it('a held lane is refused by the control gate', async () => {
    const lane = launched('held');
    const pm = launched('pm');
    const assignmentId = await assign(lane, { hold: [`project:${pm.project.id}`], lifecycle: [`project:${pm.project.id}`] });
    await receipt(lane);
    const h = await send(server, 'POST', `/api/control/assignments/${assignmentId}/hold`,
      { requestId: crypto.randomUUID(), reasonCode: 'boundary' }, pm.headers);
    assert.equal(h.status, 201, JSON.stringify(h.data));
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 423, JSON.stringify(r.data));
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('a live wrap run owns the session end: WRAP_IN_PROGRESS', async () => {
    const lane = launched('wrapping');
    await receipt(lane);
    const run = wrapRunRegistry.begin(lane.project.name, lane.sessionId, {});
    assert.equal(run.ok, true);
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'WRAP_IN_PROGRESS');
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('a wrap that starts while the checkout is being read is caught by the last check before the write', async () => {
    const lane = launched('race');
    await receipt(lane);
    const origProbe = sessionFinalize._internal.probe;
    sessionFinalize._internal.probe = async (project, session) => {
      const answer = await origProbe(project, session);
      assert.equal(wrapRunRegistry.begin(project.name, session.id, {}).ok, true);
      return answer;
    };
    try {
      const r = await finalize(lane, lane.headers);
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.code, 'WRAP_IN_PROGRESS');
      assert.equal(store.sessions.get(lane.sessionId).status, 'active');
      assert.equal(store.activity.query({ projectId: lane.project.id, eventType: 'session.finalized' }).length, 0);
    } finally {
      sessionFinalize._internal.probe = origProbe;
    }
  });

  /**
   * Append a fact to an exchange.
   * @param {string} id - Exchange id
   * @param {string} fact - Fact kind
   * @param {string} [actor]
   */
  function fact(id, fact, actor = 'project:1') {
    store.medusaExchanges.appendFact({ exchange_id: id, fact, actor, at: new Date().toISOString() });
  }

  /**
   * Acknowledge an incoming exchange through the production path, as a caller.
   * @param {string} id - Exchange id
   * @param {string} workspaceId - The recipient workspace
   * @param {object} caller - `{kind: 'project'}` (the lane's launch), `{kind: 'operator'}`, `{kind: 'operator-ui'}` or null
   */
  function acknowledge(id, workspaceId, caller) {
    medusaExchanges.recordAcknowledged([`hub-${id}`], workspaceId, caller);
  }

  it('drained means no unresolved obligation: unacknowledged incoming mail refuses', async () => {
    const lane = launched('inbox');
    await receipt(lane);
    sessionFinalize._internal.workspaceId = () => 'ws-inbox';
    const id = exchange({ recipient_workspace_id: 'ws-inbox', recipient_project_id: lane.project.id });
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'EXCHANGES_OPEN');
    assert.deepEqual(r.data.unacknowledged, [id]);
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('an acknowledgement by the dashboard, the operator or an unbound reader is not the lane\'s: it does not discharge the obligation', async () => {
    const lane = launched('inbox-ui');
    await receipt(lane);
    sessionFinalize._internal.workspaceId = () => 'ws-inbox-ui';
    const id = exchange({ recipient_workspace_id: 'ws-inbox-ui', reply_required: true });
    acknowledge(id, 'ws-inbox-ui', { kind: 'operator-ui' });
    acknowledge(id, 'ws-inbox-ui', { kind: 'operator' });
    acknowledge(id, 'ws-inbox-ui', null);
    fact(id, 'replied');
    const r = await finalize(lane, lane.headers);
    assert.equal(r.data.code, 'EXCHANGES_OPEN');
    assert.deepEqual(r.data.unacknowledged, [id], 'only the lane\'s own verified launch discharges it');
  });

  it('incoming mail that requires a reply refuses until it is answered', async () => {
    const lane = launched('inbox-reply');
    await receipt(lane);
    sessionFinalize._internal.workspaceId = () => 'ws-inbox-reply';
    const id = exchange({ recipient_workspace_id: 'ws-inbox-reply', reply_required: true });
    acknowledge(id, 'ws-inbox-reply', { kind: 'project' });
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.deepEqual(r.data.unanswered, [id]);
  });

  it('incoming mail acknowledged and answered does not strand the lane while its initiator has not closed it', async () => {
    const lane = launched('inbox-done');
    await receipt(lane);
    sessionFinalize._internal.workspaceId = () => 'ws-inbox-done';
    const id = exchange({ recipient_workspace_id: 'ws-inbox-done', reply_required: true });
    acknowledge(id, 'ws-inbox-done', { kind: 'project' });
    fact(id, 'replied');
    assert.equal(store.medusaExchanges.get(id).terminal_at, null, 'the exchange is still open');
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  });

  it('sent mail awaiting a reply refuses; once answered it does not; sent mail needing no reply is audit-only', async () => {
    const lane = launched('outbox');
    await receipt(lane);
    const awaiting = exchange({ sender_project_id: lane.project.id, sender_session_id: String(lane.sessionId), reply_required: true });
    exchange({ sender_project_id: lane.project.id, sender_session_id: String(lane.sessionId), reply_required: false });
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.deepEqual(r.data.awaitingReply, [awaiting]);

    fact(awaiting, 'replied');
    const ok = await finalize(lane, lane.headers);
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const [event] = store.activity.query({ projectId: lane.project.id, eventType: 'session.finalized' });
    const detail = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail;
    assert.equal(detail.sentInFlight, 1);
  });

  it('a file changed since launch is owned work: the full wrap is required', async () => {
    const lane = launched('owned');
    await receipt(lane);
    fs.writeFileSync(path.join(lane.dir, 'tracked.txt'), 'changed by the session\n');
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'OWNED_WORK_PRESENT');
    assert.deepEqual(r.data.paths, ['tracked.txt']);
    assert.equal(fs.readFileSync(path.join(lane.dir, 'tracked.txt'), 'utf8'), 'changed by the session\n');
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('a commit since launch that no remote has is owned work: the full wrap is required', async () => {
    const lane = launched('unpushed');
    await receipt(lane);
    fs.writeFileSync(path.join(lane.dir, 'new.txt'), 'x\n');
    git(lane.dir, ['add', 'new.txt']);
    git(lane.dir, ['commit', '-q', '-m', 'session work']);
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'OWNED_WORK_PRESENT');
    assert.equal(r.data.unpushed, 1);
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('a session with no launch baseline cannot show it left no work: WORK_STATE_UNKNOWN', async () => {
    const name = `nobase-${crypto.randomUUID().slice(0, 8)}`;
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    const lane = { project, dir, ...bind(project, dir) };
    await receipt(lane);
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'WORK_STATE_UNKNOWN');
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('a file dirty at launch and written since is a delta: the full wrap is required', async () => {
    const lane = launched('launchdirt');
    await receipt(lane);
    fs.writeFileSync(path.join(lane.dir, 'operator-wip.txt'), 'edited again during the session\n');
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'OWNED_WORK_PRESENT');
    assert.deepEqual(r.data.changedSinceLaunch, ['operator-wip.txt']);
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('a file dirty at launch and reverted since is a delta: the full wrap is required', async () => {
    const lane = launched('reverted');
    await receipt(lane);
    git(lane.dir, ['checkout', '--', 'operator-wip.txt']);
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.deepEqual(r.data.changedSinceLaunch, ['operator-wip.txt']);
  });

  it('a commit since launch that a freshly fetched remote has is not owned work', async () => {
    const lane = launched('pushed');
    const bare = path.join(tmpDir, `${lane.project.name}.git`);
    git(tmpDir, ['init', '-q', '--bare', bare]);
    git(lane.dir, ['remote', 'add', 'origin', bare]);
    git(lane.dir, ['push', '-q', 'origin', 'main']);
    await receipt(lane);
    fs.writeFileSync(path.join(lane.dir, 'shipped.txt'), 'x\n');
    git(lane.dir, ['add', 'shipped.txt']);
    git(lane.dir, ['commit', '-q', '-m', 'shipped']);
    git(lane.dir, ['push', '-q', 'origin', 'main']);
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  });

  it('a remote that cannot be fetched leaves provenance unknown: WORK_STATE_UNKNOWN', async () => {
    const lane = launched('nofetch');
    git(lane.dir, ['remote', 'add', 'origin', path.join(tmpDir, 'does-not-exist.git')]);
    await receipt(lane);
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'WORK_STATE_UNKNOWN');
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
  });

  it('a receipt superseded while the checkout is read is caught at the commit point', async () => {
    const lane = launched('receipt-race');
    await receipt(lane);
    const origProbe = sessionFinalize._internal.probe;
    sessionFinalize._internal.probe = async (project, session, opts) => {
      const answer = await origProbe(project, session, opts);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await receipt(lane, 'working', 'do-not-clear');
      return answer;
    };
    try {
      const r = await finalize(lane, lane.headers);
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.code, 'NOT_CLEAR');
      assert.equal(store.sessions.get(lane.sessionId).status, 'active');
      assert.equal(store.handoffs.listBySessionRunPrefix(lane.sessionId, 'finalize-').length, 0, 'nothing was staged');
    } finally {
      sessionFinalize._internal.probe = origProbe;
    }
  });

  it('a handoff that cannot be staged leaves the session active and nothing recorded', async () => {
    const lane = launched('nostage');
    await receipt(lane);
    const origStage = sessionFinalize._internal.stageFinal;
    sessionFinalize._internal.stageFinal = () => { throw new Error('disk full'); };
    try {
      const r = await finalize(lane, lane.headers);
      assert.equal(r.status, 503, JSON.stringify(r.data));
      assert.equal(r.data.code, 'FINALIZE_STAGE_FAILED');
    } finally {
      sessionFinalize._internal.stageFinal = origStage;
    }
    assert.equal(store.sessions.get(lane.sessionId).status, 'active');
    assert.equal(store.activity.query({ projectId: lane.project.id, eventType: 'session.finalized' }).length, 0);
  });

  it('an interrupted publication is not success; a repeat finishes the same attempt and never mints another', async () => {
    const lane = launched('publish-retry');
    await receipt(lane);
    const origPublish = handoffPublish.publishHandoff;
    handoffPublish.publishHandoff = () => ({ published: false, reason: 'simulated interruption', supersededId: null, supersededById: null });
    let first;
    try {
      first = await finalize(lane, lane.headers);
    } finally {
      handoffPublish.publishHandoff = origPublish;
    }
    assert.equal(first.status, 409, JSON.stringify(first.data));
    assert.equal(first.data.code, 'FINALIZE_INCOMPLETE');
    assert.equal(first.data.publication.state, 'staged');
    assert.equal(store.sessions.get(lane.sessionId).status, 'wrapped');
    const attempt = store.handoffs.get(first.data.publication.id);
    assert.equal(attempt.state, 'staged');
    assert.ok(attempt.eligibleAt, 'bound eligible in the transition, so it can still be finished');

    const again = await finalize(lane, lane.headers);
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.alreadyFinalized, true);
    assert.equal(again.data.publication.state, 'published');
    assert.equal(again.data.publication.id, first.data.publication.id);
    assert.equal(store.handoffs.listBySessionRunPrefix(lane.sessionId, 'finalize-').length, 1, 'one attempt, finished');
    assert.equal(launchPreflightContext.evaluate(lane.project, { workspaceId: null }).verdict, 'ok');
  });

  it('an attempt staged by a request that never reached the transition is abandoned, not left unfinished', async () => {
    const lane = launched('leftover');
    await receipt(lane);
    const session = store.sessions.get(lane.sessionId);
    const scope = await require('../lib/wrap-scope').resolve(lane.project, session);
    // What a crash between staging and the write leaves behind.
    const leftover = require('../lib/wrap-steps/handoff-stage').stageAttempt({
      project: lane.project, session, scope, wrapRunId: 'finalize-crashed', kind: 'final',
      missingEvidence: [], methodology: null, nextAction: null, resume: null
    });
    const r = await finalize(lane, lane.headers);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(store.handoffs.get(leftover.publication.publicationId).state, 'abandoned');
    assert.notEqual(r.data.publication.id, leftover.publication.publicationId);
    assert.equal(launchPreflightContext.evaluate(lane.project, { workspaceId: null }).verdict, 'ok');
  });

  it('when nobody can repeat a self-finalize whose publish failed, the next launch\'s preflight publishes it (RM03 W3)', async () => {
    const lane = launched('w3-orphaned');
    await receipt(lane);
    const origPublish = handoffPublish.publishHandoff;
    handoffPublish.publishHandoff = () => ({ published: false, reason: 'simulated interruption', supersededId: null, supersededById: null });
    let first;
    try {
      first = await finalize(lane, lane.headers);
    } finally {
      handoffPublish.publishHandoff = origPublish;
    }
    assert.equal(first.data.code, 'FINALIZE_INCOMPLETE');
    // No repeat request: the pane that could send one is gone.
    const pre = launchPreflightContext.evaluate(lane.project, { workspaceId: null });
    assert.equal(pre.verdict, 'ok', JSON.stringify(pre.reasons));
    assert.equal(store.handoffs.get(first.data.publication.id).state, 'published', 'the launch repaired it');
  });

  it('a teardown step that fails is reported, not claimed; a repeat finishes it', async () => {
    const lane = launched('teardown-retry');
    await receipt(lane);
    medusaRegistry.ensureWorkspaceId(lane.dir, lane.sessionId, lane.project.name);
    sessionFinalize._internal.workspaceId = () => null;
    const origForget = medusa.forgetSession;
    medusa.forgetSession = () => {};
    let first;
    try {
      first = await finalize(lane, lane.headers);
    } finally {
      medusa.forgetSession = origForget;
    }
    assert.equal(first.status, 409, JSON.stringify(first.data));
    assert.equal(first.data.code, 'FINALIZE_INCOMPLETE');
    assert.deepEqual(first.data.teardown.surviving, ['medusa']);
    assert.equal(first.data.teardown.steps.medusa, 'failed');

    const again = await finalize(lane, lane.headers);
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.deepEqual(again.data.teardown.surviving, []);
    assert.equal(again.data.teardown.steps.medusa, 'released');
    assert.equal(medusaRegistry.getWorkspaceId(lane.dir, lane.sessionId), null);
    const ledger = store.activity.query({ projectId: lane.project.id, eventType: 'session.finalize-teardown' });
    assert.equal(ledger.length, 2, 'each run records its per-step outcome');
  });

  it('two concurrent requests for one session both report the one finalization', async () => {
    const lane = launched('concurrent');
    await receipt(lane);
    const [a, b] = await Promise.all([finalize(lane, lane.headers), finalize(lane, lane.headers)]);
    assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.data, b.data]));
    assert.deepEqual([a.data.alreadyFinalized, b.data.alreadyFinalized].sort(), [false, true]);
    assert.equal(store.handoffs.listBySessionRunPrefix(lane.sessionId, 'finalize-').length, 1);
    assert.equal(store.activity.query({ projectId: lane.project.id, eventType: 'session.finalized' }).length, 1);
  });

  describe('files dirty at launch are preserved by identity, not by time (Architect A8)', () => {
    const wip = (lane) => path.join(lane.dir, 'operator-wip.txt');

    it('a content change with the file time restored is a delta', async () => {
      const lane = launched('a8-content');
      await receipt(lane);
      const { atime, mtime } = fs.statSync(wip(lane));
      fs.writeFileSync(wip(lane), 'operator edit, not commiTTed\n');
      fs.utimesSync(wip(lane), atime, mtime);
      const r = await finalize(lane, lane.headers);
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.code, 'OWNED_WORK_PRESENT');
      assert.deepEqual(r.data.changedSinceLaunch, ['operator-wip.txt']);
    });

    it('an identical rewrite, with a new file time, is preserved', async () => {
      const lane = launched('a8-identical');
      await receipt(lane);
      fs.writeFileSync(wip(lane), fs.readFileSync(wip(lane)));
      const now = new Date();
      fs.utimesSync(wip(lane), now, now);
      const r = await finalize(lane, lane.headers);
      assert.equal(r.status, 200, JSON.stringify(r.data));
    });

    it('an executable-bit change is a delta', async () => {
      const lane = launched('a8-mode');
      await receipt(lane);
      fs.chmodSync(wip(lane), 0o755);
      const r = await finalize(lane, lane.headers);
      assert.equal(r.data.code, 'OWNED_WORK_PRESENT', JSON.stringify(r.data));
      assert.deepEqual(r.data.changedSinceLaunch, ['operator-wip.txt']);
    });

    it('a symlink target change is a delta', async () => {
      const lane = launched('a8-link', (dir) => fs.symlinkSync('tracked.txt', path.join(dir, 'current')));
      await receipt(lane);
      fs.rmSync(path.join(lane.dir, 'current'));
      fs.symlinkSync('operator-wip.txt', path.join(lane.dir, 'current'));
      const r = await finalize(lane, lane.headers);
      assert.equal(r.data.code, 'OWNED_WORK_PRESENT', JSON.stringify(r.data));
      assert.deepEqual(r.data.changedSinceLaunch, ['current']);
    });

    it('a removal is a delta; a removal and exact recreation is preserved', async () => {
      const removed = launched('a8-removed');
      await receipt(removed);
      fs.rmSync(wip(removed));
      const r = await finalize(removed, removed.headers);
      assert.equal(r.data.code, 'OWNED_WORK_PRESENT', JSON.stringify(r.data));
      assert.deepEqual(r.data.changedSinceLaunch, ['operator-wip.txt']);

      const recreated = launched('a8-recreated');
      await receipt(recreated);
      const bytes = fs.readFileSync(wip(recreated));
      fs.rmSync(wip(recreated));
      fs.writeFileSync(wip(recreated), bytes);
      fs.chmodSync(wip(recreated), 0o644);
      const ok = await finalize(recreated, recreated.headers);
      assert.equal(ok.status, 200, JSON.stringify(ok.data));
    });

    it('re-reading launch-dirty files is bounded: a path past the byte budget refuses by name, one within it compares', async () => {
      const origBudget = sessionLeftovers._internal.fingerprintBudget;
      try {
        const size = fs.statSync(path.join(launched('a8-probe-size').dir, 'operator-wip.txt')).size;

        sessionLeftovers._internal.fingerprintBudget = () => size - 1;
        const over = launched('a8-over-budget');
        await receipt(over);
        const r = await finalize(over, over.headers);
        assert.equal(r.status, 409, JSON.stringify(r.data));
        assert.equal(r.data.code, 'WORK_STATE_UNKNOWN');
        assert.match(r.data.reason, /operator-wip\.txt/);

        sessionLeftovers._internal.fingerprintBudget = () => size;
        const within = launched('a8-within-budget');
        await receipt(within);
        const ok = await finalize(within, within.headers);
        assert.equal(ok.status, 200, JSON.stringify(ok.data));

        sessionLeftovers._internal.fingerprintBudget = () => size;
        const changed = launched('a8-within-changed');
        await receipt(changed);
        fs.writeFileSync(path.join(changed.dir, 'operator-wip.txt'), 'x'.repeat(size - 1) + '\n');
        const delta = await finalize(changed, changed.headers);
        assert.equal(delta.data.code, 'OWNED_WORK_PRESENT', 'within budget the comparison still runs');
      } finally {
        sessionLeftovers._internal.fingerprintBudget = origBudget;
      }
    });

    it('a baseline written before fingerprints existed refuses: WORK_STATE_UNKNOWN', async () => {
      const lane = launched('a8-legacy');
      // Rewrite this session's baseline the way an older build stored it: paths only.
      const legacyProject = lane.project;
      store.sessions.kill(lane.sessionId, 'test: relaunch on an older build');
      const captured = launchBaseline.capture(lane.dir);
      const launchId = launchSequence.mintLaunchId();
      const snapshot = launchSequence.buildSnapshot({
        launchId, project: legacyProject, engineProfile: store.engines.get('claude'),
        applicability: { applicable: false, reason: 'test binding' }, rendered: null, rules: []
      });
      const session = store.sessions.start({
        projectId: legacyProject.id, engineId: 'claude', launchSequence: snapshot,
        launchBaseline: { sha: captured.sha, toplevel: captured.toplevel, dirty: { paths: captured.dirty.paths, truncated: false } }
      });
      const legacy = { project: legacyProject, dir: lane.dir, sessionId: session.id, headers: { 'x-tangleclaw-project-id': String(legacyProject.id), 'x-tangleclaw-launch-id': launchId } };
      await receipt(legacy);
      const r = await finalize(legacy, legacy.headers);
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.code, 'WORK_STATE_UNKNOWN');
      assert.match(r.data.reason, /predates identity fingerprints/);
    });

    it('a file that could not be fingerprinted at launch refuses: WORK_STATE_UNKNOWN', async () => {
      const lane = launched('a8-unreadable', (dir) => fs.chmodSync(path.join(dir, 'operator-wip.txt'), 0o000));
      fs.chmodSync(wip(lane), 0o644);
      await receipt(lane);
      const r = await finalize(lane, lane.headers);
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.code, 'WORK_STATE_UNKNOWN');
      assert.match(r.data.reason, /operator-wip\.txt/);
    });
  });

  it('a handoff that does not bind to the session end leaves the session active (A7.4)', async () => {
    const lane = launched('nobind');
    await receipt(lane);
    const origBind = store.handoffs.bindLifecycleEligibility;
    store.handoffs.bindLifecycleEligibility = () => false;
    let r;
    try {
      r = await finalize(lane, lane.headers);
    } finally {
      store.handoffs.bindLifecycleEligibility = origBind;
    }
    assert.equal(r.status, 503, JSON.stringify(r.data));
    assert.equal(r.data.code, 'FINALIZE_STAGE_FAILED');
    assert.equal(store.sessions.get(lane.sessionId).status, 'active', 'the transition rolled back');
    const attempts = store.handoffs.listBySessionRunPrefix(lane.sessionId, 'finalize-');
    assert.deepEqual(attempts.map((a) => a.state), ['abandoned']);
    assert.equal(store.activity.query({ projectId: lane.project.id, eventType: 'session.finalized' }).length, 0);
  });

  it('a repeat after a relaunch never touches the new session\'s pane, which reuses the project\'s pane name', async () => {
    const live = new Set();
    const killed = [];
    const orig = { hasSession: tmux.hasSession, killSession: tmux.killSession, paneCurrentPath: tmux.paneCurrentPath };
    tmux.hasSession = (name) => live.has(name);
    tmux.killSession = (name) => { killed.push(name); live.delete(name); };
    try {
      const lane = launched('pane-reuse');
      // The pane sits in the registered checkout, as a normal launch's does.
      tmux.paneCurrentPath = () => lane.dir;
      const pane = `tc-${lane.project.name}`;
      // Rebind the lane's session with a pane, as a real launch does.
      store.sessions.kill(lane.sessionId, 'test: rebind with a pane');
      const first = { ...lane, ...bind(lane.project, lane.dir, pane) };
      live.add(pane);
      await receipt(first);
      const done = await finalize(first, first.headers);
      assert.equal(done.status, 200, JSON.stringify(done.data));
      assert.deepEqual(killed, [pane], 'the finalized session\'s own pane is torn down');

      // Relaunch: a new session under the same pane name.
      const next = bind(lane.project, lane.dir, pane);
      live.add(pane);
      const again = await finalize(first, first.headers);
      assert.equal(again.status, 200, JSON.stringify(again.data));
      assert.equal(again.data.alreadyFinalized, true);
      assert.equal(again.data.teardown.steps.tmux, 'reassigned');
      assert.deepEqual(killed, [pane], 'the repeat killed nothing');
      assert.ok(live.has(pane), 'the new session\'s pane survives');
      assert.equal(store.sessions.get(next.sessionId).status, 'active');
    } finally {
      tmux.hasSession = orig.hasSession;
      tmux.killSession = orig.killSession;
      tmux.paneCurrentPath = orig.paneCurrentPath;
    }
  });

  describe('where the session works, and what it left outside HEAD (RM03 B1, W1, W2)', () => {
    /**
     * Run a test with a stubbed pane directory.
     * @param {string|null} dir - What the pane reports, or null for unreadable
     * @param {() => Promise<void>} fn
     */
    async function withPane(dir, fn) {
      const orig = tmux.paneCurrentPath;
      tmux.paneCurrentPath = () => dir;
      try { await fn(); } finally { tmux.paneCurrentPath = orig; }
    }

    it('a session whose pane is in a linked worktree with work there is refused, not retired', async () => {
      const lane = launched('b1-worktree');
      store.sessions.kill(lane.sessionId, 'test: relaunch with a pane');
      const withPaneLane = { ...lane, ...bind(lane.project, lane.dir, `tc-${lane.project.name}`) };
      const wt = path.join(tmpDir, `${lane.project.name}-wt`);
      git(lane.dir, ['worktree', 'add', '-q', '-b', 'feat/y', wt]);
      fs.writeFileSync(path.join(wt, 'tracked.txt'), 'uncommitted work in the worktree\n');
      await receipt(withPaneLane);
      await withPane(wt, async () => {
        const r = await finalize(withPaneLane, withPaneLane.headers);
        assert.equal(r.status, 409, JSON.stringify(r.data));
        assert.equal(r.data.code, 'WORK_STATE_UNKNOWN');
        assert.equal(r.data.workTree, fs.realpathSync(wt));
      });
      assert.equal(store.sessions.get(withPaneLane.sessionId).status, 'active');
      assert.equal(fs.readFileSync(path.join(wt, 'tracked.txt'), 'utf8'), 'uncommitted work in the worktree\n');
    });

    it('a pane whose directory cannot be read is refused: it may be working anywhere', async () => {
      const lane = launched('b1-unreadable-pane');
      store.sessions.kill(lane.sessionId, 'test: relaunch with a pane');
      const withPaneLane = { ...lane, ...bind(lane.project, lane.dir, `tc-${lane.project.name}`) };
      await receipt(withPaneLane);
      await withPane(null, async () => {
        const r = await finalize(withPaneLane, withPaneLane.headers);
        assert.equal(r.data.code, 'WORK_STATE_UNKNOWN', JSON.stringify(r.data));
      });
    });

    it('a pane in the registered checkout is judged there as before', async () => {
      const lane = launched('b1-registered');
      store.sessions.kill(lane.sessionId, 'test: relaunch with a pane');
      const withPaneLane = { ...lane, ...bind(lane.project, lane.dir, `tc-${lane.project.name}`) };
      await receipt(withPaneLane);
      await withPane(lane.dir, async () => {
        const r = await finalize(withPaneLane, withPaneLane.headers);
        assert.equal(r.status, 200, JSON.stringify(r.data));
      });
    });

    it('a commit since launch on another local branch, with HEAD moved back, is owned work (W1)', async () => {
      const lane = launched('w1-branch');
      await receipt(lane);
      git(lane.dir, ['checkout', '-q', '-b', 'side']);
      fs.writeFileSync(path.join(lane.dir, 'side.txt'), 'x\n');
      git(lane.dir, ['add', 'side.txt']);
      git(lane.dir, ['commit', '-q', '-m', 'work on a side branch']);
      git(lane.dir, ['checkout', '-q', 'main']);
      const r = await finalize(lane, lane.headers);
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.code, 'OWNED_WORK_PRESENT');
      assert.equal(r.data.unpushedOnBranches, 1);
    });

    it('work stashed since launch is owned work (W1)', async () => {
      const lane = launched('w1-stash');
      await receipt(lane);
      fs.writeFileSync(path.join(lane.dir, 'tracked.txt'), 'stash me\n');
      git(lane.dir, ['stash', 'push', '-q', '--', 'tracked.txt']);
      const r = await finalize(lane, lane.headers);
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.code, 'OWNED_WORK_PRESENT');
      assert.equal(r.data.stashes, 1);
    });

    it('a local branch whose unpushed commits predate the launch is not this session\'s work', async () => {
      const lane = launched('w1-old-branch', (dir) => {
        git(dir, ['checkout', '-q', '-b', 'operator-branch']);
        fs.writeFileSync(path.join(dir, 'old.txt'), 'x\n');
        git(dir, ['add', 'old.txt']);
        git(dir, ['commit', '-q', '-m', 'operator work'], BEFORE_LAUNCH);
        git(dir, ['checkout', '-q', 'main']);
      });
      await receipt(lane);
      const r = await finalize(lane, lane.headers);
      assert.equal(r.status, 200, JSON.stringify(r.data));
    });

    it('mail that arrives while the checkout is read is caught at the commit point (W2)', async () => {
      const lane = launched('w2-late-mail');
      await receipt(lane);
      sessionFinalize._internal.workspaceId = () => 'ws-late';
      const origProbe = sessionFinalize._internal.probe;
      let id = null;
      sessionFinalize._internal.probe = async (project, session, opts) => {
        const answer = await origProbe(project, session, opts);
        id = exchange({ recipient_workspace_id: 'ws-late', reply_required: true, priority: 'blocking' });
        return answer;
      };
      try {
        const r = await finalize(lane, lane.headers);
        assert.equal(r.status, 409, JSON.stringify(r.data));
        assert.equal(r.data.code, 'EXCHANGES_OPEN');
        assert.deepEqual(r.data.unacknowledged, [id]);
        assert.equal(store.sessions.get(lane.sessionId).status, 'active');
      } finally {
        sessionFinalize._internal.probe = origProbe;
      }
    });
  });
});
