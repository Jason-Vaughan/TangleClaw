'use strict';

/*
 * Train A Car A3, Chunk 01 — a wrap's intent is explicit and its cancellation
 * is honest.
 *
 * #1708: whether a finished wrap ends the session was decided only by the
 * modal's checkbox; any other caller (a peer's or the PM's POST, a script)
 * ended the session. A project can now record "keep it running", every wrap
 * inherits it when its request says nothing, and every run states the outcome
 * it will have, and why, before any step moves.
 *
 * #1707: nothing could stop a running wrap. A cancel now stops it at the next
 * step boundary, only before the commit step, and a cancel after that is
 * refused with its reason rather than faked.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const tmux = require('../lib/tmux');
const sessions = require('../lib/sessions');
const projectConfig = require('../lib/project-config');
const wrapPipeline = require('../lib/wrap-pipeline');
const defaultPipeline = require('../lib/wrap-default-pipeline');
const wrapRunRegistry = require('../lib/wrap-run-registry');
const { WRAP_STREAM_EVENTS: EV } = require('../public/wrap-stream-events');
const { handleRequest } = require('../server');

const FINISHED = { ok: true, blockedAt: null, cancelledAt: null, results: [], commitSha: null, summary: null, error: null };

/**
 * A mock response the real handler can write to.
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
 * @param {string} method
 * @param {string} url
 * @param {object} [body]
 * @returns {Promise<{statusCode: number, json: object}>}
 */
async function send(method, url, body) {
  const raw = body === undefined ? null : JSON.stringify(body);
  const headers = { host: 'localhost:3102', 'sec-fetch-site': 'same-origin' };
  if (raw !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(raw));
  }
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
  return { statusCode: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

/**
 * Yield to the event loop until `cond` holds, or fail.
 * @param {() => boolean} cond
 * @param {string} what - For the failure message
 * @returns {Promise<void>}
 */
async function until(cond, what) {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe('resolveKeepSessionRunning (#1708)', () => {
  it('takes an explicitly present request boolean over the project\'s', () => {
    assert.deepEqual(projectConfig.resolveKeepSessionRunning(false, { wrapKeepSessionRunning: true }),
      { ok: true, keep: false, source: 'request' });
    assert.deepEqual(projectConfig.resolveKeepSessionRunning(true, { wrapKeepSessionRunning: false }),
      { ok: true, keep: true, source: 'request' });
    assert.deepEqual(projectConfig.resolveKeepSessionRunning(true, null, { readFailed: true }),
      { ok: true, keep: true, source: 'request' }, 'an explicit request needs no config');
  });

  it('never coerces a non-boolean request', () => {
    for (const notBool of ['true', 1, null]) {
      assert.equal(projectConfig.resolveKeepSessionRunning(notBool, { wrapKeepSessionRunning: false }).source, 'project',
        `${JSON.stringify(notBool)} is not a request decision`);
    }
  });

  it('inherits the project\'s setting when the request says nothing', () => {
    assert.deepEqual(projectConfig.resolveKeepSessionRunning(undefined, { wrapKeepSessionRunning: true }),
      { ok: true, keep: true, source: 'project' });
    assert.deepEqual(projectConfig.resolveKeepSessionRunning(undefined, { wrapKeepSessionRunning: false }),
      { ok: true, keep: false, source: 'project' });
  });

  it('ends the session by default, as a wrap always has (#1558)', () => {
    assert.deepEqual(projectConfig.resolveKeepSessionRunning(undefined, {}), { ok: true, keep: false, source: 'default' });
    assert.deepEqual(projectConfig.resolveKeepSessionRunning(undefined, null), { ok: true, keep: false, source: 'default' });
    assert.deepEqual(projectConfig.resolveKeepSessionRunning(undefined, projectConfig.load('/nonexistent-tc-path')),
      { ok: true, keep: false, source: 'default' }, 'a project that never chose is "default", not "project"');
  });

  it('refuses a malformed project value rather than choosing either outcome', () => {
    for (const bad of ['true', 1, 'yes', {}]) {
      const r = projectConfig.resolveKeepSessionRunning(undefined, { wrapKeepSessionRunning: bad });
      assert.equal(r.ok, false, `${JSON.stringify(bad)} is refused`);
      assert.match(r.error, /wrapKeepSessionRunning/);
    }
  });

  it('refuses when the config could not be read', () => {
    const r = projectConfig.resolveKeepSessionRunning(undefined, projectConfig.load('/nonexistent-tc-path'), { readFailed: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /could not be read/);
  });
});

describe('wrap-run registry cancel (#1707)', () => {
  beforeEach(() => wrapRunRegistry._resetForTests());
  after(() => wrapRunRegistry._resetForTests());

  const runStart = (ids) => ({ type: EV.RUN_START, steps: ids.map((id) => ({ stepId: id, kind: id })) });

  /**
   * Admit a step the way the runner does, then announce it.
   * @param {string} runId
   * @param {string} stepId
   * @param {boolean} pastCancelBoundary
   * @returns {'cancelled'|'proceed'}
   */
  function startStep(runId, stepId, pastCancelBoundary) {
    const admission = wrapRunRegistry.admitStep('p', runId, { stepId, pastCancelBoundary });
    if (admission === 'proceed') wrapRunRegistry.emit('p', runId, { type: EV.STEP_START, stepId, pastCancelBoundary });
    return admission;
  }

  it('stops before the first step when none has started', () => {
    const { runId } = wrapRunRegistry.begin('p', 1, {});
    wrapRunRegistry.emit('p', runId, runStart(['a', 'b', 'commit']));
    assert.deepEqual(wrapRunRegistry.requestCancel('p', runId), { ok: true, willStopBefore: 'a', finishingStepId: null });
    assert.equal(wrapRunRegistry.isCancelRequested('p', runId), true);
    assert.equal(wrapRunRegistry.get('p').cancelRequested, true);
    assert.equal(startStep(runId, 'a', false), 'cancelled');
  });

  it('names the first not-started step and the step still finishing', () => {
    const { runId } = wrapRunRegistry.begin('p', 1, {});
    wrapRunRegistry.emit('p', runId, runStart(['a', 'b', 'commit']));
    assert.equal(startStep(runId, 'a', false), 'proceed');
    const first = wrapRunRegistry.requestCancel('p', runId);
    assert.deepEqual(first, { ok: true, willStopBefore: 'b', finishingStepId: 'a' });
    assert.deepEqual(wrapRunRegistry.requestCancel('p', runId), first, 'a repeated cancel answers as the first did');
    assert.equal(startStep(runId, 'b', false), 'cancelled', 'the next boundary stops the run');
  });

  it('refuses once the boundary step is admitted, and never re-opens', () => {
    const { runId } = wrapRunRegistry.begin('p', 1, {});
    wrapRunRegistry.emit('p', runId, runStart(['a', 'commit', 'after']));
    assert.equal(startStep(runId, 'commit', true), 'proceed');
    assert.deepEqual(wrapRunRegistry.requestCancel('p', runId),
      { ok: false, code: 'WRAP_NOT_CANCELLABLE', currentStepId: 'commit' });
    startStep(runId, 'after', true);
    assert.equal(wrapRunRegistry.requestCancel('p', runId).code, 'WRAP_NOT_CANCELLABLE');
    assert.equal(wrapRunRegistry.isCancelRequested('p', runId), false, 'nothing was recorded');
    assert.equal(wrapRunRegistry.get('p').cancellable, false);
  });

  it('stops before the boundary step itself when the cancel came first', () => {
    // The last step before commit is running when the cancel is accepted; its
    // 202 promised a stop before commit, so commit's admission must refuse.
    const { runId } = wrapRunRegistry.begin('p', 1, {});
    wrapRunRegistry.emit('p', runId, runStart(['a', 'commit']));
    startStep(runId, 'a', false);
    assert.equal(wrapRunRegistry.requestCancel('p', runId).willStopBefore, 'commit');
    assert.equal(startStep(runId, 'commit', true), 'cancelled');
  });

  it('gives no 202 once the boundary step was admitted', () => {
    const { runId } = wrapRunRegistry.begin('p', 1, {});
    wrapRunRegistry.emit('p', runId, runStart(['a', 'commit']));
    startStep(runId, 'a', false);
    assert.equal(startStep(runId, 'commit', true), 'proceed');
    assert.equal(wrapRunRegistry.requestCancel('p', runId).ok, false);
  });

  it('never lands on a different run', () => {
    const { runId } = wrapRunRegistry.begin('p', 1, {});
    assert.deepEqual(wrapRunRegistry.requestCancel('p', 'not-this-run'), { ok: false, code: 'WRAP_RUN_NOT_FOUND' });
    assert.deepEqual(wrapRunRegistry.requestCancel('p', undefined), { ok: false, code: 'WRAP_RUN_NOT_FOUND' });
    assert.deepEqual(wrapRunRegistry.requestCancel('other', runId), { ok: false, code: 'WRAP_RUN_NOT_FOUND' });
    assert.equal(wrapRunRegistry.isCancelRequested('p', runId), false);
    assert.equal(wrapRunRegistry.admitStep('p', 'not-this-run', { stepId: 'a', pastCancelBoundary: true }), 'proceed');
    assert.equal(wrapRunRegistry.get('p').cancellable, true, 'a foreign admission did not close this run');
  });

  it('refuses a finished run, and a new run starts uncancelled', () => {
    const first = wrapRunRegistry.begin('p', 1, {});
    wrapRunRegistry.requestCancel('p', first.runId);
    wrapRunRegistry.finish('p', first.runId, { ok: false });
    assert.equal(wrapRunRegistry.requestCancel('p', first.runId).code, 'WRAP_RUN_NOT_FOUND');
    assert.equal(wrapRunRegistry.get('p').cancellable, false, 'a finished run is not cancellable');
    const second = wrapRunRegistry.begin('p', 1, {});
    assert.equal(wrapRunRegistry.isCancelRequested('p', second.runId), false);
    assert.equal(wrapRunRegistry.isCancelRequested('p', first.runId), false, 'the old run\'s flag went with it');
    assert.equal(wrapRunRegistry.get('p').cancellable, true);
  });
});

describe('runWrapPipeline cancel boundary (#1707)', () => {
  let tmpDir;
  let prevBase;
  let originals;
  let ran;

  before(() => {
    prevBase = store._getBasePath();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-cancel-pipe-'));
    store.close();
    store._setBasePath(tmpDir);
    store.init();
    const projectPath = path.join(tmpDir, 'cancel-pipe');
    fs.mkdirSync(projectPath, { recursive: true });
    store.projects.create({ name: 'cancel-pipe', path: projectPath });
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Replace every dispatch handler (derived from the table, so no real handler
   * slips through) with one that records the step and runs `hook`.
   * @param {(stepId: string) => void} [hook]
   */
  function stubHandlers(hook) {
    originals = { ...wrapPipeline.STEP_DISPATCH };
    ran = [];
    for (const kind of Object.keys(wrapPipeline.STEP_DISPATCH)) {
      wrapPipeline.STEP_DISPATCH[kind] = {
        run: async (ctx) => {
          ran.push(ctx.step.id);
          if (hook) hook(ctx.step.id);
          return { ok: true, status: 'done', output: null, blockers: [] };
        }
      };
    }
  }

  afterEach(() => {
    if (originals) for (const [kind, handler] of Object.entries(originals)) wrapPipeline.STEP_DISPATCH[kind] = handler;
    originals = null;
  });

  const ids = () => defaultPipeline.steps().map((s) => s.id);
  const boundaryId = () => defaultPipeline.steps()[wrapPipeline.cancelBoundaryIndex(defaultPipeline.steps())].id;

  it('puts the boundary at the commit step', () => {
    assert.equal(defaultPipeline.steps()[wrapPipeline.cancelBoundaryIndex(defaultPipeline.steps())].kind, 'commit');
    assert.equal(wrapPipeline.cancelBoundaryIndex([{ kind: 'a' }]), -1, 'no commit step, no boundary');
  });

  /**
   * Claim a real registry run for the pipeline and hand back the hooks
   * `sessions._runClaimedWrap` injects, bound to it.
   * @returns {{runId: string, hooks: object, cancel: () => object}}
   */
  function claimRun() {
    wrapRunRegistry._resetForTests();
    const { runId } = wrapRunRegistry.begin('cancel-pipe', 1, {});
    return {
      runId,
      cancel: () => wrapRunRegistry.requestCancel('cancel-pipe', runId),
      hooks: {
        onStepEvent: (e) => wrapRunRegistry.emit('cancel-pipe', runId, e),
        admitStep: (step) => wrapRunRegistry.admitStep('cancel-pipe', runId, step),
        isCancelRequested: () => wrapRunRegistry.isCancelRequested('cancel-pipe', runId)
      }
    };
  }

  it('stops at the next boundary before commit, runs nothing after, and says where', async () => {
    const all = ids();
    const run = claimRun();
    let answer = null;
    stubHandlers((id) => { if (id === all[1]) answer = run.cancel(); });
    const events = [];
    const result = await wrapPipeline.runWrapPipeline('cancel-pipe', {
      ...run.hooks,
      onStepEvent: (e) => { events.push(e); run.hooks.onStepEvent(e); }
    });
    assert.deepEqual(answer, { ok: true, willStopBefore: all[2], finishingStepId: all[1] });
    assert.equal(result.ok, false);
    assert.equal(result.cancelledAt, all[2], 'stopped before the first step that had not started');
    assert.equal(result.blockedAt, null, 'a cancel is not a block');
    assert.equal(result.error, null);
    assert.deepEqual(ran, all.slice(0, 2), 'the running step finished and nothing after it started');
    assert.ok(!ran.includes(boundaryId()), 'commit never ran: no commit, branch, push, PR or auto-merge');
    assert.equal(result.results.length, all.length, 'every step still reports');
    assert.ok(result.results.slice(2).every((r) => r.status === 'pending'), 'the rest are pending');
    assert.ok(!events.some((e) => e.type === EV.STEP_START && e.stepId === all[2]), 'the stopped-before step never started');
    assert.equal(events[0].cancelBoundaryStepId, boundaryId());
    wrapRunRegistry._resetForTests();
  });

  it('stops before the first step when asked before the run began', async () => {
    const run = claimRun();
    run.cancel();
    stubHandlers();
    const result = await wrapPipeline.runWrapPipeline('cancel-pipe', run.hooks);
    assert.equal(result.cancelledAt, ids()[0]);
    assert.deepEqual(ran, []);
    wrapRunRegistry._resetForTests();
  });

  it('refuses a cancel from the commit step on, and the run finishes', async () => {
    const run = claimRun();
    let answer = null;
    stubHandlers((id) => { if (id === boundaryId()) answer = run.cancel(); });
    const events = [];
    const result = await wrapPipeline.runWrapPipeline('cancel-pipe', {
      ...run.hooks,
      onStepEvent: (e) => { events.push(e); run.hooks.onStepEvent(e); }
    });
    assert.equal(answer.code, 'WRAP_NOT_CANCELLABLE', 'no 202 once commit was admitted');
    assert.equal(result.ok, true);
    assert.equal(result.cancelledAt, null);
    assert.deepEqual(ran, ids(), 'every step ran');
    const starts = events.filter((e) => e.type === EV.STEP_START);
    const at = starts.findIndex((e) => e.stepId === boundaryId());
    assert.ok(starts.slice(0, at).every((e) => e.pastCancelBoundary === false), 'before commit: cancellable');
    assert.ok(starts.slice(at).every((e) => e.pastCancelBoundary === true), 'from commit on: not');
    wrapRunRegistry._resetForTests();
  });

  it('ends cancelled when a cancel accepted during a step is followed by that step halting, and keeps its result', async () => {
    const all = ids();
    // The first pipeline step that halts on !ok, before the boundary.
    const halting = defaultPipeline.steps().find((st, i) => i < wrapPipeline.cancelBoundaryIndex(defaultPipeline.steps())
      && (st.blocker === true || st.blocker === 'errors-only'));
    assert.ok(halting, 'the default pipeline has a halting step before commit');
    const run = claimRun();
    originals = { ...wrapPipeline.STEP_DISPATCH };
    ran = [];
    for (const kind of Object.keys(wrapPipeline.STEP_DISPATCH)) {
      wrapPipeline.STEP_DISPATCH[kind] = {
        run: async (ctx) => {
          ran.push(ctx.step.id);
          if (ctx.step.id === halting.id) {
            run.cancel();
            return { ok: false, status: 'blocked', output: null, blockers: ['the step failed'] };
          }
          return { ok: true, status: 'done', output: null, blockers: [] };
        }
      };
    }
    const result = await wrapPipeline.runWrapPipeline('cancel-pipe', run.hooks);
    const at = all.indexOf(halting.id);
    assert.equal(result.blockedAt, null, 'cancel wins as the outcome');
    assert.equal(result.cancelledAt, all[at + 1]);
    assert.equal(result.results[at].status, 'blocked', 'the halting step\'s own result stays visible');
    assert.deepEqual(result.results[at].blockers, ['the step failed']);
    assert.ok(!ran.includes(boundaryId()));
    wrapRunRegistry._resetForTests();
  });

  it('halts as blocked, not cancelled, when no cancel was asked', async () => {
    const halting = defaultPipeline.steps().find((st, i) => i < wrapPipeline.cancelBoundaryIndex(defaultPipeline.steps())
      && (st.blocker === true || st.blocker === 'errors-only'));
    const run = claimRun();
    originals = { ...wrapPipeline.STEP_DISPATCH };
    for (const kind of Object.keys(wrapPipeline.STEP_DISPATCH)) {
      wrapPipeline.STEP_DISPATCH[kind] = {
        run: async (ctx) => (ctx.step.id === halting.id
          ? { ok: false, status: 'blocked', output: null, blockers: ['x'] }
          : { ok: true, status: 'done', output: null, blockers: [] })
      };
    }
    const result = await wrapPipeline.runWrapPipeline('cancel-pipe', run.hooks);
    assert.equal(result.blockedAt, halting.id);
    assert.equal(result.cancelledAt, null);
    wrapRunRegistry._resetForTests();
  });

  it('states the planned session outcome on run-start', async () => {
    stubHandlers();
    const events = [];
    await wrapPipeline.runWrapPipeline('cancel-pipe', {
      onStepEvent: (e) => events.push(e), keepSessionRunning: true, keepSource: 'project'
    });
    assert.equal(events[0].sessionOutcomePlanned, 'keep');
    assert.equal(events[0].keepSource, 'project');
    events.length = 0;
    await wrapPipeline.runWrapPipeline('cancel-pipe', { onStepEvent: (e) => events.push(e) });
    assert.equal(events[0].sessionOutcomePlanned, 'end');
    assert.equal(events[0].keepSource, null, 'a run started without startWrap names no source');
  });
});

describe('wrap intent and cancel through sessions and HTTP (#1708, #1707)', () => {
  let tempDir;
  let prevBase;
  let project;
  let seq = 0;
  let realRun;
  let realKill;
  let realHas;
  let killCalls;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-intent-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
    const cfg = store.config.load();
    cfg.setupComplete = true;
    cfg.ingressMode = 'direct';
    cfg.authEnabled = false;
    store.config.save(cfg);
    realRun = wrapPipeline.runWrapPipeline;
    realKill = tmux.killSession;
    realHas = tmux.hasSession;
  });

  after(() => {
    wrapPipeline.runWrapPipeline = realRun;
    tmux.killSession = realKill;
    tmux.hasSession = realHas;
    wrapRunRegistry._resetForTests();
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    wrapRunRegistry._resetForTests();
    killCalls = [];
    tmux.hasSession = () => true;
    tmux.killSession = (name) => { killCalls.push(name); };
    seq += 1;
    const dir = fs.mkdtempSync(path.join(tempDir, 'proj-'));
    project = store.projects.create({ name: `wrap-intent-${seq}`, path: dir, engine: 'claude' });
    store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: `${project.name}-tmux` });
  });

  afterEach(() => {
    wrapPipeline.runWrapPipeline = realRun;
  });

  /**
   * Write this case's project config.
   * @param {object} fields - Merged over the defaults
   */
  function setProjectConfig(fields) {
    store.projectConfig.save(project.path, { ...store.projectConfig.load(project.path), ...fields });
  }

  /**
   * Make every pipeline run answer FINISHED, recording the options it got.
   * @returns {object[]}
   */
  function stubFinished() {
    const seen = [];
    wrapPipeline.runWrapPipeline = async (_name, options) => { seen.push(options); return FINISHED; };
    return seen;
  }

  const wrapUrl = () => `/api/sessions/${encodeURIComponent(project.name)}/wrap`;

  describe('keep-running default (#1708)', () => {
    it('keeps the session for a wrap that says nothing, on a project set to keep (the #1708 repro)', async () => {
      setProjectConfig({ wrapKeepSessionRunning: true });
      const seen = stubFinished();
      const started = sessions.startWrap(project.name);
      assert.equal(started.sessionOutcomePlanned, 'keep');
      assert.equal(started.keepSource, 'project');
      const result = await started.done;
      assert.equal(result.sessionKept, true);
      assert.equal(result.lifecycleCompleted, false);
      assert.ok(store.sessions.getActive(project.id), 'the session is still active');
      assert.deepEqual(killCalls, [], 'tmux is left alone');
      // Multi-hop: handoff-stage picks checkpoint vs final from the options the
      // pipeline is handed, mid-run. Resolving the default only at the kill
      // site would leave this false and stage a final handoff for a kept session.
      assert.equal(seen[0].keepSessionRunning, true, 'the pipeline itself was told to keep');
      assert.equal(seen[0].keepSource, 'project');
    });

    it('lets an explicit request override the project', async () => {
      setProjectConfig({ wrapKeepSessionRunning: true });
      stubFinished();
      const started = sessions.startWrap(project.name, { keepSessionRunning: false });
      assert.equal(started.sessionOutcomePlanned, 'end');
      assert.equal(started.keepSource, 'request');
      assert.equal((await started.done).lifecycleCompleted, true);
    });

    it('still ends the session by default', async () => {
      const seen = stubFinished();
      const started = sessions.startWrap(project.name);
      assert.equal(started.sessionOutcomePlanned, 'end');
      assert.equal(started.keepSource, 'default');
      assert.equal((await started.done).lifecycleCompleted, true);
      assert.equal(seen[0].keepSessionRunning, false);
    });

    it('records the resolved choice for a Retry and a reload', async () => {
      setProjectConfig({ wrapKeepSessionRunning: true });
      stubFinished();
      await sessions.startWrap(project.name).done;
      const recorded = sessions.getWrapRunStatus(project.name).options;
      assert.equal(recorded.keepSessionRunning, true);
      assert.equal(recorded.keepSource, 'project');
    });

    it('states the planned outcome on the 202 and on /wrap/status', async () => {
      setProjectConfig({ wrapKeepSessionRunning: true });
      stubFinished();
      const res = await send('POST', wrapUrl(), {});
      assert.equal(res.statusCode, 202);
      assert.equal(res.json.sessionOutcomePlanned, 'keep');
      assert.equal(res.json.keepSource, 'project');
      assert.equal(res.json.cancelUrl, `${wrapUrl()}/cancel`);
      await until(() => !wrapRunRegistry.get(project.name).running, 'the run to settle');
      const status = await send('GET', `${wrapUrl()}/status`);
      assert.equal(status.json.sessionOutcomePlanned, 'keep');
      assert.equal(status.json.keepSource, 'project');
      assert.equal(status.json.result.sessionOutcome, 'kept');
    });

    it('refuses before claiming a run when the project value is malformed', async () => {
      setProjectConfig({ wrapKeepSessionRunning: 'yes' });
      const seen = stubFinished();
      const res = await send('POST', wrapUrl(), {});
      assert.equal(res.statusCode, 409);
      assert.equal(res.json.code, 'WRAP_KEEP_SETTING_INVALID');
      assert.match(res.json.error, /wrapKeepSessionRunning/);
      assert.equal(wrapRunRegistry.get(project.name).runId, null, 'no run was claimed');
      assert.deepEqual(seen, [], 'the pipeline never ran');
      assert.ok(store.sessions.getActive(project.id), 'the session is untouched');
    });

    it('refuses before claiming a run when the project config cannot be read', async () => {
      fs.mkdirSync(path.join(project.path, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(project.path, '.tangleclaw', 'project.json'), '{ not json');
      const seen = stubFinished();
      const started = sessions.startWrap(project.name);
      assert.equal(started.ok, false);
      assert.equal(started.code, 'WRAP_KEEP_SETTING_INVALID');
      assert.match(started.error, /could not be read/);
      assert.deepEqual(seen, []);
    });

    it('lets an explicit boolean through a setting it cannot resolve', async () => {
      setProjectConfig({ wrapKeepSessionRunning: 'yes' });
      stubFinished();
      const started = sessions.startWrap(project.name, { keepSessionRunning: true });
      assert.equal(started.ok, true);
      assert.equal(started.keepSource, 'request');
      await started.done;
    });

    it('never trusts a caller-supplied source or planned outcome', async () => {
      const seen = stubFinished();
      const started = sessions.startWrap(project.name, { keepSource: 'project', sessionOutcomePlanned: 'keep' });
      assert.equal(started.keepSource, 'default');
      assert.equal(started.sessionOutcomePlanned, 'end');
      await started.done;
      assert.equal(seen[0].keepSource, 'default');
      assert.equal('sessionOutcomePlanned' in seen[0], false, 'dropped, not forwarded');
      assert.equal(sessions.getWrapRunStatus(project.name).options.keepSource, 'default');
    });

    it('lets a Retry keep the run\'s resolved answer and source, unless it sends a different boolean', async () => {
      setProjectConfig({ wrapKeepSessionRunning: true });
      const blocked = { ...FINISHED, ok: false, blockedAt: 'version-bump', results: [{ stepId: 'version-bump', status: 'needs-operator' }] };
      wrapPipeline.runWrapPipeline = async () => blocked;
      await sessions.startWrap(project.name).done;
      // The operator changes the project setting between the attempts; the Retry
      // follows the run it retries, not the new setting.
      setProjectConfig({ wrapKeepSessionRunning: false });
      const seen = [];
      wrapPipeline.runWrapPipeline = async (_n, options) => { seen.push(options); return blocked; };
      const retry = sessions.startWrap(project.name);
      assert.equal(retry.sessionOutcomePlanned, 'keep');
      assert.equal(retry.keepSource, 'project');
      await retry.done;
      const same = sessions.startWrap(project.name, { keepSessionRunning: true });
      assert.equal(same.keepSource, 'project', 'replaying the same boolean keeps the source');
      await same.done;
      const changed = sessions.startWrap(project.name, { keepSessionRunning: false });
      assert.equal(changed.sessionOutcomePlanned, 'end');
      assert.equal(changed.keepSource, 'request', 'an explicit change is the request\'s');
      await changed.done;
    });

    it('resolves afresh after a run that completed', async () => {
      setProjectConfig({ wrapKeepSessionRunning: true });
      stubFinished();
      await sessions.startWrap(project.name).done;
      setProjectConfig({ wrapKeepSessionRunning: false });
      const next = sessions.startWrap(project.name);
      assert.equal(next.sessionOutcomePlanned, 'end');
      assert.equal(next.keepSource, 'project');
      await next.done;
    });
  });

  describe('cancel (#1707)', () => {
    /**
     * A pipeline stub that waits at a "step boundary" until cancelled or
     * released, the way the real loop reads `isCancelRequested`.
     * @returns {{release: () => void, seen: object[]}}
     */
    function stubWaitingRun() {
      const seen = [];
      let released = false;
      wrapPipeline.runWrapPipeline = async (_name, options) => {
        seen.push(options);
        options.onStepEvent({ type: EV.RUN_START, steps: [{ stepId: 'changelog-update' }, { stepId: 'commit' }] });
        options.admitStep({ stepId: 'changelog-update', pastCancelBoundary: false });
        options.onStepEvent({ type: EV.STEP_START, stepId: 'changelog-update', pastCancelBoundary: false });
        await until(() => released || options.isCancelRequested(), 'a cancel or a release');
        if (options.admitStep({ stepId: 'commit', pastCancelBoundary: true }) === 'cancelled') {
          return { ...FINISHED, ok: false, cancelledAt: 'commit', results: [{ stepId: 'changelog-update', status: 'done' }, { stepId: 'commit', status: 'pending' }] };
        }
        return FINISHED;
      };
      return { release: () => { released = true; }, seen };
    }

    it('stops a live run, leaves the session running, and reports it as cancelled', async () => {
      const run = stubWaitingRun();
      const started = await send('POST', wrapUrl(), {});
      assert.equal(started.statusCode, 202);
      await until(() => wrapRunRegistry.get(project.name).currentStepId === 'changelog-update', 'the first step');
      const status = await send('GET', `${wrapUrl()}/status`);
      assert.equal(status.json.cancellable, true);

      const cancel = await send('POST', `${wrapUrl()}/cancel`, { runId: started.json.runId });
      assert.equal(cancel.statusCode, 202);
      assert.equal(cancel.json.cancelRequested, true);
      assert.equal(cancel.json.willStopBefore, 'commit');
      assert.equal(cancel.json.finishingStepId, 'changelog-update', 'says which step is still finishing');
      assert.match(cancel.json.note, /no commit, branch, push, PR or auto-merge/);
      assert.match(cancel.json.note, /not undone/);

      await until(() => !wrapRunRegistry.get(project.name).running, 'the run to settle');
      const settled = await send('GET', `${wrapUrl()}/status`);
      assert.equal(settled.json.result.status, 'cancelled', 'not "blocked"');
      assert.equal(settled.json.result.outcome, 'cancelled');
      assert.equal(wrapRunRegistry.get(project.name).result.outcome, 'cancelled', 'the stored result carries it');
      assert.equal(settled.json.result.pipelineResult.cancelledAt, 'commit');
      assert.equal(settled.json.result.sessionOutcome, null);
      assert.equal(settled.json.cancelRequested, true);
      assert.ok(store.sessions.getActive(project.id), 'the session is still running');
      assert.deepEqual(killCalls, []);
      assert.equal(typeof run.seen[0].isCancelRequested, 'function');
    });

    it('refuses a cancel once the run is past the commit step, naming the step', async () => {
      let released = false;
      wrapPipeline.runWrapPipeline = async (_name, options) => {
        options.onStepEvent({ type: EV.RUN_START, steps: [{ stepId: 'commit' }] });
        options.admitStep({ stepId: 'commit', pastCancelBoundary: true });
        options.onStepEvent({ type: EV.STEP_START, stepId: 'commit', pastCancelBoundary: true });
        await until(() => released, 'release');
        return FINISHED;
      };
      const started = await send('POST', wrapUrl(), {});
      await until(() => wrapRunRegistry.get(project.name).currentStepId === 'commit', 'the commit step');
      const cancel = await send('POST', `${wrapUrl()}/cancel`, { runId: started.json.runId });
      assert.equal(cancel.statusCode, 409);
      assert.equal(cancel.json.code, 'WRAP_NOT_CANCELLABLE');
      assert.equal(cancel.json.currentStepId, 'commit');
      assert.match(cancel.json.error, /past the point of cancelling/);
      released = true;
      await until(() => !wrapRunRegistry.get(project.name).running, 'the run to settle');
      assert.equal(wrapRunRegistry.get(project.name).result.ok, true, 'the run finished');
    });

    it('answers 404 for a run id that is not the live run, and 400 for none', async () => {
      const run = stubWaitingRun();
      const started = await send('POST', wrapUrl(), {});
      await until(() => wrapRunRegistry.get(project.name).currentStepId === 'changelog-update', 'the first step');
      const wrong = await send('POST', `${wrapUrl()}/cancel`, { runId: 'f'.repeat(32) });
      assert.equal(wrong.statusCode, 404);
      assert.equal(wrong.json.code, 'WRAP_RUN_NOT_FOUND');
      const none = await send('POST', `${wrapUrl()}/cancel`, {});
      assert.equal(none.statusCode, 400);
      assert.equal(wrapRunRegistry.isCancelRequested(project.name, started.json.runId), false, 'the live run was not touched');
      run.release();
      await until(() => !wrapRunRegistry.get(project.name).running, 'the run to settle');
      const late = await send('POST', `${wrapUrl()}/cancel`, { runId: started.json.runId });
      assert.equal(late.statusCode, 404, 'a finished run cannot be cancelled');
    });

    it('answers 404 NOT_FOUND for an unknown project', async () => {
      const res = await send('POST', '/api/sessions/no-such-project/wrap/cancel', { runId: 'x' });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json.code, 'NOT_FOUND');
    });

    it('is not stopped by the wrapDisabled switch', async () => {
      const run = stubWaitingRun();
      const started = await send('POST', wrapUrl(), {});
      await until(() => wrapRunRegistry.get(project.name).currentStepId === 'changelog-update', 'the first step');
      const cfg = store.config.load();
      cfg.wrapDisabled = true;
      store.config.save(cfg);
      try {
        const cancel = await send('POST', `${wrapUrl()}/cancel`, { runId: started.json.runId });
        assert.equal(cancel.statusCode, 202);
      } finally {
        const restore = store.config.load();
        restore.wrapDisabled = false;
        store.config.save(restore);
      }
      await until(() => !wrapRunRegistry.get(project.name).running, 'the run to settle');
      assert.ok(run.seen.length === 1);
    });
  });
});

describe('drawer: planned outcome, Hide and Cancel (#1708, #1707)', () => {
  const drawer = require('../public/wrap-drawer');
  const vm = require('node:vm');
  const SESSION_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
  const SESSION_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.html'), 'utf8');

  /**
   * Fold events into a live view, as the page does.
   * @param {object[]} events
   * @returns {object}
   */
  const fold = (events) => events.reduce((live, e) => drawer.applyWrapStreamEvent(live, e), null);
  const START = { type: 'run-start', steps: [{ stepId: 'a', kind: 'ai-content' }, { stepId: 'commit', kind: 'commit' }, { stepId: 'handoff-stage', kind: 'handoff-stage' }] };

  it('states the planned outcome conditionally, with its source', () => {
    assert.equal(drawer.plannedSessionLine(fold([{ ...START, sessionOutcomePlanned: 'keep', keepSource: 'project' }])),
      'If this wrap completes, it will keep the session running (project setting).');
    assert.equal(drawer.plannedSessionLine(fold([{ ...START, sessionOutcomePlanned: 'end', keepSource: 'default' }])),
      'If this wrap completes, it will end the session (default).');
    assert.equal(drawer.plannedSessionLine(fold([START])), null, 'a run that said nothing gets no line');
  });

  it('offers Cancel before the boundary, then says the wrap continues and where', () => {
    const before = fold([START, { type: 'step-start', stepId: 'a', pastCancelBoundary: false }]);
    assert.deepEqual(drawer.liveCancelControl(before), { show: true, disabled: false, label: 'Cancel wrap', note: null });
    const past = fold([START, { type: 'step-start', stepId: 'a', pastCancelBoundary: false },
      { type: 'step-done', stepId: 'a', status: 'done' },
      { type: 'step-start', stepId: 'commit', pastCancelBoundary: true },
      { type: 'step-done', stepId: 'commit', status: 'done' },
      { type: 'step-start', stepId: 'handoff-stage', pastCancelBoundary: true }]);
    const control = drawer.liveCancelControl(past);
    assert.equal(control.show, false);
    assert.match(control.note, /Past the point of cancellation; the wrap continues/);
    assert.match(control.note, /handoff-stage/, 'names the actual step, not "committing"');
    assert.doesNotMatch(control.note, /committing/);
  });

  it('disables Cancel once accepted and says which step is finishing', () => {
    const live = fold([START, { type: 'step-start', stepId: 'a', pastCancelBoundary: false }]);
    const control = drawer.liveCancelControl(live, { requested: true, finishingStepId: 'a' });
    assert.equal(control.show, true);
    assert.equal(control.disabled, true);
    assert.match(control.note, /"a" is finishing/);
  });

  it('reports a cancelled run as its own outcome, naming what ran and what was not undone', () => {
    const s = drawer.summarizePipelineStatus({
      ok: false, blockedAt: null, cancelledAt: 'commit', error: null,
      results: [{ stepId: 'a', status: 'done' }, { stepId: 'commit', status: 'pending' }]
    });
    assert.equal(s.label, 'Wrap cancelled before "commit"');
    assert.notEqual(s.tone, 'blocked');
    assert.match(s.detail, /Nothing was committed, branched, pushed or opened as a PR/);
    assert.match(s.detail, /not undone/);
    assert.match(s.detail, /: a\./);
  });

  it('has the Cancel control and the live lines in the page', () => {
    assert.match(SESSION_HTML, /id="wrapDrawerAbortBtn"/);
    assert.match(SESSION_HTML, /id="wrapDrawerPlanned"/);
    assert.match(SESSION_HTML, /id="wrapDrawerCancelNote"/);
  });

  /**
   * Lift a top-level function out of the page source by brace matching.
   * @param {string} decl
   * @returns {string}
   */
  function lift(decl) {
    const start = SESSION_SRC.indexOf(decl);
    assert.notEqual(start, -1, `${decl} must exist`);
    let depth = 0;
    for (let i = SESSION_SRC.indexOf('{', start); i < SESSION_SRC.length; i++) {
      if (SESSION_SRC[i] === '{') depth++;
      else if (SESSION_SRC[i] === '}' && --depth === 0) return SESSION_SRC.slice(start, i + 1);
    }
    return assert.fail('unbalanced');
  }

  /**
   * A sandbox running the page's real cancel wiring against a fake DOM and API.
   * @param {object} answer - What the fake cancel POST answers
   * @returns {object}
   */
  function pageSandbox(answer) {
    const els = {};
    const el = (id) => {
      if (!els[id]) {
        const classes = new Set(['hidden']);
        els[id] = {
          id, textContent: '', disabled: false, className: '', title: '',
          removeAttribute() {}, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) }
        };
      }
      return els[id];
    };
    const live = fold([START, { type: 'run-start', ...START, sessionOutcomePlanned: 'end', keepSource: 'default' }, { type: 'step-start', stepId: 'a', pastCancelBoundary: false }]);
    const sandbox = {
      els, posted: [],
      document: { getElementById: el },
      window: { tcWrapDrawerHelpers: drawer },
      projectName: 'proj',
      api: { lastError: 'refused by the server' },
      currentWrapPassword: 'pw',
      wrapRunState: () => ({ runId: 'run-1', live }),
      async apiMutate(url, method, body) { sandbox.posted.push({ url, method, body }); return answer; },
      setTimeout: () => {}
    };
    vm.createContext(sandbox);
    vm.runInContext([
      'let wrapCancelState = { runId: null, requested: false, finishingStepId: null };',
      lift('function paintLiveSessionControls('),
      lift('async function requestWrapCancel('),
      'this.paint = () => paintLiveSessionControls(wrapRunState().live);',
      'this.cancel = requestWrapCancel;'
    ].join('\n'), sandbox);
    return sandbox;
  }

  it('the page posts the run id and password, and disables Cancel on a 202', async () => {
    const sb = pageSandbox({ ok: true, cancelRequested: true, finishingStepId: 'a', willStopBefore: 'commit' });
    sb.paint();
    assert.equal(sb.els.wrapDrawerAbortBtn.classList.contains('hidden'), false, 'Cancel is offered');
    assert.equal(sb.els.wrapDrawerPlanned.textContent, 'If this wrap completes, it will end the session (default).');
    await sb.cancel();
    assert.deepEqual(JSON.parse(JSON.stringify(sb.posted[0])), { url: '/api/sessions/proj/wrap/cancel', method: 'POST', body: { runId: 'run-1', password: 'pw' } });
    assert.equal(sb.els.wrapDrawerAbortBtn.disabled, true);
    assert.match(sb.els.wrapDrawerCancelNote.textContent, /"a" is finishing/);
  });

  it('the page shows the server\'s refusal and keeps following the run', async () => {
    const sb = pageSandbox(null);
    sb.els.toast = null;
    sb.paint();
    await sb.cancel();
    assert.equal(sb.els.wrapDrawerAbortBtn.disabled, false, 'still offered: nothing was accepted');
    assert.equal(sb.els.toast.textContent, 'refused by the server');
  });
});
