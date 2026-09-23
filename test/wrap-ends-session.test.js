'use strict';

/*
 * A wrap that finishes ends the session (#1558), whether or not it committed,
 * unless the operator ticked "Keep the session running". A run that stops,
 * fails or throws leaves the session open. The choice travels dialog → options
 * → POST → server and is replayed on Retry and after a reload, and the result
 * tells the drawer what happened to the session.
 *
 * Server cases run on a temp store with the pipeline and tmux stubbed. Page
 * cases run the real page code, lifted out of its file, against a fake DOM.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const tmux = require('../lib/tmux');
const sessions = require('../lib/sessions');
const wrapPipeline = require('../lib/wrap-pipeline');
const wrapRunRegistry = require('../lib/wrap-run-registry');
const { handleRequest } = require('../server');
const drawer = require('../public/wrap-drawer');

const PUBLIC = path.join(__dirname, '..', 'public');
const LANDING_SRC = fs.readFileSync(path.join(PUBLIC, 'landing.js'), 'utf8');
const SESSION_SRC = fs.readFileSync(path.join(PUBLIC, 'session.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const SESSION_HTML = fs.readFileSync(path.join(PUBLIC, 'session.html'), 'utf8');

const FINISHED_CLEAN = { ok: true, blockedAt: null, results: [], commitSha: null, summary: null, error: null };
const FINISHED_COMMITTED = { ...FINISHED_CLEAN, commitSha: 'abc123def4567890' };
const STOPPED = {
  ok: false,
  blockedAt: 'version-bump',
  results: [{ stepId: 'version-bump', kind: 'version-bump', status: 'needs-operator', output: null, blockers: ['Cut or Hold?'] }],
  commitSha: null,
  summary: null,
  error: null
};

describe('a finished wrap ends the session (#1558)', () => {
  let tempDir;
  let prevBase;
  let project;
  let seq = 0;
  let realRun;
  let realKill;
  let realHas;
  let realRelease;
  let killCalls;
  let releaseCalls;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-ends-'));
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
    realRelease = store.documentLocks.releaseBySession;
  });

  after(() => {
    wrapPipeline.runWrapPipeline = realRun;
    tmux.killSession = realKill;
    tmux.hasSession = realHas;
    store.documentLocks.releaseBySession = realRelease;
    wrapRunRegistry._resetForTests();
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    wrapRunRegistry._resetForTests();
    killCalls = [];
    releaseCalls = [];
    tmux.hasSession = () => true;
    tmux.killSession = (name) => { killCalls.push(name); };
    store.documentLocks.releaseBySession = (sid) => { releaseCalls.push(sid); return 0; };
    seq += 1;
    const dir = fs.mkdtempSync(path.join(tempDir, 'proj-'));
    project = store.projects.create({ name: `wrap-ends-${seq}`, path: dir, engine: 'claude' });
  });

  afterEach(() => {
    wrapPipeline.runWrapPipeline = realRun;
  });

  /**
   * Start a session on this case's project.
   * @returns {object} The session row
   */
  function startSession() {
    return store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: `${project.name}-tmux` });
  }

  /**
   * Make every pipeline run answer with `results` in order (the last repeats),
   * recording the options each run was given.
   * @param {object[]} results
   * @returns {object[]} The options each run received
   */
  function stubRuns(...results) {
    const seen = [];
    wrapPipeline.runWrapPipeline = async (_name, options) => {
      seen.push(options);
      return results.length > 1 ? results.shift() : results[0];
    };
    return seen;
  }

  describe('the lifecycle rule', () => {
    it('ends the session when a finished run committed nothing', async () => {
      const session = startSession();
      stubRuns(FINISHED_CLEAN);
      const result = await sessions.triggerWrap(project.name);
      assert.equal(result.ok, true);
      assert.equal(result.lifecycleCompleted, true);
      assert.equal(result.sessionKept, false);
      assert.equal(store.sessions.getActive(project.id), null, 'no session is left active');
      assert.equal(store.sessions.get(session.id).status, 'wrapped');
      assert.deepEqual(killCalls, [`${project.name}-tmux`], 'tmux is torn down');
      assert.deepEqual(releaseCalls, [session.id], 'doc locks are released');
    });

    it('still ends the session when a finished run committed', async () => {
      const session = startSession();
      stubRuns(FINISHED_COMMITTED);
      const result = await sessions.triggerWrap(project.name);
      assert.equal(result.lifecycleCompleted, true);
      assert.equal(store.sessions.get(session.id).status, 'wrapped');
    });

    it('keeps the session open when the operator asked, with or without a commit', async () => {
      const session = startSession();
      for (const finished of [FINISHED_CLEAN, FINISHED_COMMITTED]) {
        wrapRunRegistry._resetForTests();
        stubRuns(finished);
        const result = await sessions.triggerWrap(project.name, { keepSessionRunning: true });
        assert.equal(result.ok, true);
        assert.equal(result.lifecycleCompleted, false);
        assert.equal(result.sessionKept, true);
        assert.equal(store.sessions.getActive(project.id).id, session.id, 'the same session is still active');
        assert.deepEqual(killCalls, [], 'tmux is left alone');
        assert.deepEqual(releaseCalls, [], 'doc locks are left alone');
      }
    });

    it('ends the session when keepSessionRunning is false', async () => {
      startSession();
      stubRuns(FINISHED_CLEAN);
      const result = await sessions.triggerWrap(project.name, { keepSessionRunning: false });
      assert.equal(result.lifecycleCompleted, true);
      assert.equal(result.sessionKept, false);
    });

    it('leaves the session open when the run stopped for the operator', async () => {
      const session = startSession();
      stubRuns(STOPPED);
      const result = await sessions.triggerWrap(project.name);
      assert.equal(result.ok, false);
      assert.equal(result.lifecycleCompleted, false);
      assert.equal(result.sessionKept, false, 'nothing was kept: the run did not finish');
      assert.equal(store.sessions.getActive(project.id).id, session.id);
      assert.deepEqual(killCalls, []);
    });

    it('does not report a kept session when the session was killed mid-wrap, box ticked or not', async () => {
      for (const options of [undefined, { keepSessionRunning: true }]) {
        wrapRunRegistry._resetForTests();
        const session = startSession();
        wrapPipeline.runWrapPipeline = async () => {
          store.sessions.kill(session.id, 'operator pressed Kill mid-wrap');
          return FINISHED_CLEAN;
        };
        const result = await sessions.triggerWrap(project.name, options);
        assert.equal(result.ok, true);
        assert.equal(result.lifecycleCompleted, false, 'no wrap was recorded on a killed row');
        assert.equal(result.sessionKept, false, `${JSON.stringify(options)}: a killed session is not kept`);
      }
    });

    it('does not report a kept session when a new session replaced it mid-wrap', async () => {
      const session = startSession();
      wrapPipeline.runWrapPipeline = async () => {
        store.sessions.kill(session.id, 'killed');
        startSession();
        return FINISHED_CLEAN;
      };
      const result = await sessions.triggerWrap(project.name, { keepSessionRunning: true });
      assert.equal(result.sessionKept, false, 'the session the wrap ran against is gone');
    });

    it('refuses a keepSessionRunning that is not a boolean, before claiming a run', async () => {
      startSession();
      const seen = stubRuns(FINISHED_CLEAN);
      for (const bad of ['true', 1, null, {}]) {
        const started = sessions.startWrap(project.name, { keepSessionRunning: bad });
        assert.equal(started.ok, false, `${JSON.stringify(bad)} is refused`);
        assert.equal(started.code, 'BAD_REQUEST');
        assert.match(started.error, /keepSessionRunning/);
      }
      assert.equal(wrapRunRegistry.get(project.name).runId, null, 'no run was claimed');
      assert.deepEqual(seen, [], 'the pipeline never ran');
      assert.ok(store.sessions.getActive(project.id), 'the session is untouched');
    });

    it('keeps the choice across a Retry that replays the recorded options', async () => {
      // The browser replays the options a run was started with (the run's
      // recorded `options`, which is what a reloaded page reads back).
      const session = startSession();
      const seen = stubRuns(STOPPED, FINISHED_CLEAN);
      const first = await sessions.triggerWrap(project.name, { keepSessionRunning: true });
      assert.equal(first.ok, false);
      const recorded = sessions.getWrapRunStatus(project.name).options;
      assert.equal(recorded.keepSessionRunning, true, 'the run recorded the choice');

      const retry = await sessions.triggerWrap(project.name, drawer.collectOptionsFromAccessors({
        keepSessionRunning: () => drawer.replayChoicesFromOptions(recorded).keepSessionRunning
      }));
      assert.equal(retry.ok, true);
      assert.equal(retry.sessionKept, true);
      assert.equal(store.sessions.getActive(project.id).id, session.id, 'the retried wrap kept the session');
      assert.equal(seen[1].keepSessionRunning, true, 'the retry carried it to the pipeline');
    });
  });

  describe('POST /api/sessions/:project/wrap and GET /wrap/status', () => {
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
     * @returns {Promise<object>}
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
      return res;
    }

    const wrapUrl = () => `/api/sessions/${encodeURIComponent(project.name)}/wrap`;

    /**
     * Start a wrap over HTTP and read its settled status.
     * @param {object} body
     * @returns {Promise<object>} The status body
     */
    async function wrapAndSettle(body) {
      const res = await send('POST', wrapUrl(), body);
      assert.equal(res.statusCode, 202, res.body);
      for (let i = 0; i < 200 && wrapRunRegistry.get(project.name).running; i++) {
        await new Promise((r) => setImmediate(r));
      }
      const status = await send('GET', `${wrapUrl()}/status`);
      return JSON.parse(status.body);
    }

    it('says the session ended', async () => {
      startSession();
      stubRuns(FINISHED_CLEAN);
      const status = await wrapAndSettle({});
      assert.equal(status.result.sessionOutcome, 'ended');
    });

    it('says the session was kept, and records the choice', async () => {
      startSession();
      stubRuns(FINISHED_CLEAN);
      const status = await wrapAndSettle({ options: { keepSessionRunning: true } });
      assert.equal(status.result.sessionOutcome, 'kept');
      assert.equal(status.options.keepSessionRunning, true);
    });

    it('says nothing about the session for a stopped run', async () => {
      startSession();
      stubRuns(STOPPED);
      const status = await wrapAndSettle({ options: { keepSessionRunning: true } });
      assert.equal(status.result.sessionOutcome, null);
    });

    it('says nothing about the session when it was killed mid-wrap, box ticked or not', async () => {
      for (const body of [{}, { options: { keepSessionRunning: true } }]) {
        wrapRunRegistry._resetForTests();
        const session = startSession();
        wrapPipeline.runWrapPipeline = async () => {
          store.sessions.kill(session.id, 'killed');
          return FINISHED_CLEAN;
        };
        const status = await wrapAndSettle(body);
        assert.equal(status.result.sessionOutcome, null, JSON.stringify(body));
      }
    });

    it('answers 400 for a keepSessionRunning that is not a boolean', async () => {
      startSession();
      stubRuns(FINISHED_CLEAN);
      const res = await send('POST', wrapUrl(), { options: { keepSessionRunning: 'true' } });
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).code, 'BAD_REQUEST');
      assert.ok(store.sessions.getActive(project.id), 'the session is untouched');
    });
  });
});

describe('drawer helpers (#1558)', () => {
  it('names a no-commit wrap that ended the session', () => {
    const s = drawer.summarizePipelineStatus(FINISHED_CLEAN, { sessionOutcome: 'ended' });
    assert.equal(s.tone, 'success');
    assert.equal(s.label, 'Wrapped — nothing new to commit');
    assert.equal(s.detail, 'Your work was already committed or merged, or there was nothing to add. The session has ended.');
  });

  it('names a no-commit wrap that kept the session', () => {
    const s = drawer.summarizePipelineStatus(FINISHED_CLEAN, { sessionOutcome: 'kept' });
    assert.equal(s.detail, 'Your work was already committed or merged, or there was nothing to add. The session is still running, as you asked.');
  });

  it('says nothing about the session when the outcome is unknown', () => {
    for (const ctx of [undefined, {}, { sessionOutcome: null }, { sessionOutcome: 'bogus' }]) {
      const s = drawer.summarizePipelineStatus(FINISHED_CLEAN, ctx);
      assert.equal(s.label, 'Wrapped — nothing new to commit');
      assert.equal(s.detail, 'Your work was already committed or merged, or there was nothing to add.');
    }
  });

  it('adds the session phrase to a no-commit wrap with warnings, keeping its label', () => {
    const warned = { ...FINISHED_CLEAN, results: [{ stepId: 'preflight', kind: 'preflight', status: 'done', output: { warning: true }, blockers: [] }] };
    const s = drawer.summarizePipelineStatus(warned, { sessionOutcome: 'ended' });
    assert.equal(s.label, 'Wrap completed with warnings');
    assert.equal(s.detail, 'Warnings on: preflight · The session has ended.');
  });

  // #1708 changed this contract: an explicit false now overrides a project set
  // to keep, so the page sends the boolean it holds, either way. Anything that
  // is not a boolean still sends nothing, so the server resolves it.
  it('sends keepSessionRunning as the boolean the page holds, and nothing otherwise', () => {
    assert.deepEqual({ ...drawer.collectOptionsFromAccessors({ keepSessionRunning: () => true }) }, { keepSessionRunning: true });
    assert.deepEqual({ ...drawer.collectOptionsFromAccessors({ keepSessionRunning: () => false }) }, { keepSessionRunning: false });
    for (const v of ['true', 1, null, undefined]) {
      assert.deepEqual({ ...drawer.collectOptionsFromAccessors({ keepSessionRunning: () => v }) }, {}, `${String(v)} sends nothing`);
    }
  });

  it('takes the choice back from a recorded run only as a boolean', () => {
    assert.equal(drawer.replayChoicesFromOptions({ keepSessionRunning: true }).keepSessionRunning, true);
    assert.equal(drawer.replayChoicesFromOptions({ keepSessionRunning: false }).keepSessionRunning, false);
    assert.equal(drawer.replayChoicesFromOptions({ keepSessionRunning: 'true' }).keepSessionRunning, null,
      'not a boolean: the page holds no choice');
    assert.equal(drawer.replayChoicesFromOptions(null).keepSessionRunning, null);
  });
});

/**
 * Slice a top-level function out of source text by brace-matching, so the test
 * runs the real code rather than a copy.
 * @param {string} src
 * @param {string} decl
 * @returns {string}
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
  return '';
}

/**
 * A fake element with the properties the wrap dialogs touch.
 * @param {string} id
 * @returns {object}
 */
function makeElement(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', value: '', disabled: false, checked: false, dataset: {}, children: [],
    _classes: classes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (on ? classes.add(c) : classes.delete(c)))
    },
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

/**
 * A fake document whose elements are created on first lookup.
 * @returns {{document: object, els: Object<string, object>}}
 */
function makeDocument() {
  const els = {};
  return {
    els,
    document: {
      getElementById: (id) => (els[id] = els[id] || makeElement(id)),
      createElement: (tag) => makeElement(tag),
      querySelector: () => null
    }
  };
}

const escSrc = liftFunction(LANDING_SRC, 'function esc(');
const plain = (v) => JSON.parse(JSON.stringify(v));

describe('dashboard wrap dialog: Keep the session running (#1558)', () => {
  /**
   * Run the dashboard wrap modal against a fake apiMutate.
   * @returns {object} The sandbox; `sent` holds each request body
   */
  function sandboxFor() {
    const { document, els } = makeDocument();
    const sent = [];
    const sandbox = {
      document, els, sent,
      api: {},
      state: { config: {} },
      tcStrandedKeys: (items) => items.map((i) => ({ remote: i.remote, branch: i.branch, headSha: i.headSha })),
      tcStrandedItemsMarkup: () => '',
      tcStrandedWrapNotice: () => '',
      async apiMutate(_url, _method, body) { sent.push(body); return { runId: 'r1' }; },
      awaitDashboardWrapFailure: async () => null,
      loadProjects: async () => {}
    };
    vm.createContext(sandbox);
    vm.runInContext([
      escSrc,
      'let wrapTarget = null; let wrapInFlight = false; let wrapStrandedItems = null;',
      liftFunction(LANDING_SRC, 'function openWrapModal('),
      liftFunction(LANDING_SRC, 'function showWrapStranded('),
      liftFunction(LANDING_SRC, 'function syncWrapConfirmButton('),
      liftFunction(LANDING_SRC, 'function closeWrapModal('),
      liftFunction(LANDING_SRC, 'async function confirmWrap('),
      'this.openWrapModal = openWrapModal; this.confirmWrap = confirmWrap;'
    ].join('\n'), sandbox);
    return sandbox;
  }

  it('sends an untick as an explicit false (#1708)', async () => {
    const sb = sandboxFor();
    sb.openWrapModal('proj');
    await sb.confirmWrap();
    assert.deepEqual(plain(sb.sent[0]), { options: { keepSessionRunning: false } });
  });

  it('starts from the project\'s setting, and can still be unticked (#1708)', async () => {
    const sb = sandboxFor();
    sb.state.projects = [{ name: 'proj', wrapKeepSessionRunning: true }, { name: 'other', wrapKeepSessionRunning: false }];
    sb.openWrapModal('proj');
    assert.equal(sb.els.wrapKeepRunning.checked, true, 'pre-ticked from the project');
    sb.openWrapModal('other');
    assert.equal(sb.els.wrapKeepRunning.checked, false, 'reset for a project that does not keep');
    sb.openWrapModal('proj');
    sb.els.wrapKeepRunning.checked = false;
    await sb.confirmWrap();
    assert.deepEqual(plain(sb.sent[0]), { options: { keepSessionRunning: false } }, 'the untick overrides the project');
  });

  it('sends keepSessionRunning when ticked', async () => {
    const sb = sandboxFor();
    sb.openWrapModal('proj');
    sb.els.wrapKeepRunning.checked = true;
    await sb.confirmWrap();
    assert.deepEqual(plain(sb.sent[0]), { options: { keepSessionRunning: true } });
  });

  it('starts unticked every time the dialog opens', () => {
    const sb = sandboxFor();
    sb.openWrapModal('proj');
    sb.els.wrapKeepRunning.checked = true;
    sb.openWrapModal('proj');
    assert.equal(sb.els.wrapKeepRunning.checked, false);
  });

  it('sends both choices together', async () => {
    const sb = sandboxFor();
    sb.openWrapModal('proj');
    vm.runInContext('showWrapStranded([{ remote: "r", branch: "wrap/1", headSha: "s" }])', sb);
    sb.els.wrapStrandedConfirm.checked = true;
    sb.els.wrapKeepRunning.checked = true;
    await sb.confirmWrap();
    assert.deepEqual(plain(sb.sent[0]), {
      options: { proceedPastStranded: [{ remote: 'r', branch: 'wrap/1', headSha: 's' }], keepSessionRunning: true }
    });
  });

  it('is in the page', () => {
    assert.match(INDEX_HTML, /<input type="checkbox" id="wrapKeepRunning">/);
    assert.match(INDEX_HTML, /Keep the session running/);
  });
});

describe('session page wrap dialog: Keep the session running (#1558)', () => {
  /**
   * Run the session page's wrap pieces with a fake DOM.
   * @returns {object} The sandbox
   */
  function sandboxFor() {
    const { document, els } = makeDocument();
    const posted = [];
    const sandbox = {
      document, els, posted,
      api: {},
      window: { tcWrapDrawerHelpers: drawer },
      phase: 'idle',
      wrapRunState() { return { phase: sandbox.phase }; },
      dispatchWrapRun() { return {}; },
      currentWrapPassword: '',
      tcStrandedKeys: () => [],
      async postWrap(body) { posted.push(body); return true; }
    };
    vm.createContext(sandbox);
    vm.runInContext([
      'let wrapReleaseChoice = ""; let wrapBumpLevel = ""; let wrapUntrackState = ""; let wrapSkipPreflight = false;',
      'let wrapPathDecisions = {}; let wrapSkippedAiSteps = {}; let wrapProceedPastStranded = [];',
      'let wrapKeepRunning = null;',
      'let lastRefusedStrandedItems = null; let wrapDrawerStrandedItems = null; let wrapModalStrandedItems = null;',
      liftFunction(SESSION_SRC, 'function adoptWrapRunChoices('),
      liftFunction(SESSION_SRC, 'async function retryWrap('),
      'this.get = (name) => eval(name); this.set = (name, v) => eval(`${name} = v`);'
    ].join('\n'), sandbox);
    return sandbox;
  }

  it('replays the choice on Retry', async () => {
    const sb = sandboxFor();
    sb.set('wrapKeepRunning', true);
    await vm.runInContext('retryWrap()', sb);
    assert.equal(sb.posted[0].options.keepSessionRunning, true);
  });

  it('sends nothing on Retry when this page never chose (#1708)', async () => {
    const sb = sandboxFor();
    await vm.runInContext('retryWrap()', sb);
    assert.equal((sb.posted[0].options || {}).keepSessionRunning, undefined,
      'the server keeps what it resolved for the run being retried');
  });

  it('replays an unticked dialog on Retry as an explicit false', async () => {
    const sb = sandboxFor();
    sb.set('wrapKeepRunning', false);
    await vm.runInContext('retryWrap()', sb);
    assert.equal(sb.posted[0].options.keepSessionRunning, false);
  });

  it('takes the choice back from the run it follows after a reload', () => {
    const sb = sandboxFor();
    vm.runInContext('adoptWrapRunChoices({ keepSessionRunning: true })', sb);
    assert.equal(sb.get('wrapKeepRunning'), true);
    vm.runInContext('adoptWrapRunChoices({ keepSessionRunning: false })', sb);
    assert.equal(sb.get('wrapKeepRunning'), false);
    vm.runInContext('adoptWrapRunChoices({})', sb);
    assert.equal(sb.get('wrapKeepRunning'), null, 'a run with no recorded boolean leaves no choice');
  });

  /**
   * Run the session page's real modal open and first-wrap confirm.
   * @returns {object} The sandbox; `posted` holds each wrap POST body
   */
  function modalSandbox() {
    const { document, els } = makeDocument();
    const posted = [];
    const sandbox = {
      document, els, posted,
      projectName: 'proj',
      sessionState: { config: {}, project: { releaseMode: 'auto' } },
      window: { tcWrapDrawerHelpers: drawer, tcWrapRunController: { isBusy: () => false } },
      esc: (s) => String(s),
      tcStrandedKeys: () => [],
      wrapRunState: () => ({ phase: 'idle' }),
      dispatchWrapRun() {},
      showWrapModalStranded() {},
      syncWrapReleaseControls() {},
      refreshWrapReleaseMode: async () => false,
      wrapModalNeedsStrandedConfirm: () => false,
      closeWrapModal() {},
      async postWrap(body) { posted.push(body); return true; }
    };
    vm.createContext(sandbox);
    vm.runInContext([
      'let wrapReleaseChoice = ""; let wrapBumpLevel = ""; let wrapUntrackState = ""; let wrapSkipPreflight = false;',
      'let wrapPathDecisions = {}; let wrapSkippedAiSteps = {}; let wrapProceedPastStranded = [];',
      'let wrapKeepRunning = false; let wrapModalStrandedItems = null; let lastRefusedStrandedItems = null;',
      'let currentWrapPassword = "";',
      liftFunction(SESSION_SRC, 'function openWrapModal('),
      liftFunction(SESSION_SRC, 'async function confirmWrap('),
      'this.openWrapModal = openWrapModal; this.confirmWrap = confirmWrap;',
      'this.get = (name) => eval(name);'
    ].join('\n'), sandbox);
    return sandbox;
  }

  it('sends the ticked box with the first POST, and keeps it for Retry', async () => {
    const sb = modalSandbox();
    sb.openWrapModal();
    sb.els.wrapKeepRunning.checked = true;
    await sb.confirmWrap();
    assert.equal(sb.posted[0].options.keepSessionRunning, true);
    assert.equal(sb.get('wrapKeepRunning'), true, 'held for every Retry of this wrap');
  });

  it('sends an unticked box as false, and a new wrap forgets an earlier tick', async () => {
    const sb = modalSandbox();
    sb.openWrapModal();
    sb.els.wrapKeepRunning.checked = true;
    await sb.confirmWrap();
    sb.openWrapModal();
    assert.equal(sb.els.wrapKeepRunning.checked, false, 'reset on open to the project setting (off)');
    await sb.confirmWrap();
    assert.equal(sb.posted[1].options.keepSessionRunning, false);
    assert.equal(sb.get('wrapKeepRunning'), false);
  });

  it('opens pre-ticked when the project keeps sessions (#1708)', () => {
    const sb = modalSandbox();
    sb.sessionState.project.wrapKeepSessionRunning = true;
    sb.openWrapModal();
    assert.equal(sb.els.wrapKeepRunning.checked, true);
  });

  it('is in the page', () => {
    assert.match(SESSION_HTML, /<input type="checkbox" id="wrapKeepRunning">/);
    assert.match(SESSION_HTML, /Keep the session running/);
  });

  it('hands the run outcome to the drawer banner', () => {
    const { document, els } = makeDocument();
    const painted = [];
    const sandbox = {
      document, els,
      window: { tcWrapDrawerHelpers: drawer },
      sessionState: {},
      cancelEndedCountdown() {},
      expandWrapDrawer() {},
      paintWrapStatus(status) { painted.push(status); },
      hideLiveSessionControls() {},
      renderSkipRoll() {},
      renderStepRow: () => makeElement('li'),
      syncRetryLabel() {}
    };
    vm.createContext(sandbox);
    const renderSrc = liftFunction(SESSION_SRC, 'function renderWrapDrawer(');
    vm.runInContext([
      'let currentWrapPipelineResult = null; let currentWrapBaseStatus = null;',
      liftFunction(SESSION_SRC, 'function openWrapDrawer('),
      // Only the banner is under test: stop the render once it is painted.
      renderSrc.replace(/paintWrapStatus\(status, status\.pr, status\);/, 'paintWrapStatus(status, status.pr, status); return;'),
      'this.openWrapDrawer = openWrapDrawer;'
    ].join('\n'), sandbox);
    sandbox.openWrapDrawer(FINISHED_CLEAN, { sessionOutcome: 'ended' });
    assert.match(painted[0].detail, /The session has ended\.$/);
    // The controller's settled case is what supplies the outcome.
    assert.match(SESSION_SRC, /openWrapDrawer\(next\.result\.pipelineResult, \{ sessionOutcome: next\.result\.sessionOutcome \}\)/);
  });
});
