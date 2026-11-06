'use strict';

/*
 * #2837 (#2072 Slice 2): governed-wrap's progress-stage helpers
 * (`lib/governed-wrap.js#formatWrapProgressEvent` /
 * `#createWrapProgressStream`) and the Dashboard-side UI
 * (`public/governed-wrap-ui.js`).
 *
 * Same fixture shape as `test/governed-wrap.test.js` (Slice 1): a fresh temp
 * store + a real git repo per test, `sessions.startWrap` stubbed to claim a
 * REAL `lib/wrap-run-registry.js` run rather than mocking the registry
 * itself, so `createWrapProgressStream`'s subscription goes through the
 * genuine `sessions.subscribeWrapRun` -> `wrapRunRegistry.subscribe` path.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { initRepo } = require('./_temp-repo');
const { setLevel } = require('../lib/logger');
const { liftDeclaration } = require('./helpers/lift');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

setLevel('error');

const store = require('../lib/store');
const launchSequence = require('../lib/launch-sequence');
const sessionsLib = require('../lib/sessions');
const wrapRunRegistry = require('../lib/wrap-run-registry');
const gw = require('../lib/governed-wrap');

let tmpDir = null;
let project = null;
let session = null;

const COORDINATOR = { kind: 'coordinator', principal: 'project:9' };

/** @see test/governed-wrap.test.js#decisionFor */
function decisionFor(r, extra = { result: 'ready' }) {
  return {
    requestId: r.request.requestId, optionSchemaVersion: r.request.optionSchemaVersion,
    preflightDigest: r.request.preflightDigest, ...extra
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-governed-wrap-ui-'));
  store._setBasePath(tmpDir);
  store.init();
  const projDir = path.join(tmpDir, 'proj');
  fs.mkdirSync(projDir);
  initRepo(projDir);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: projDir });
  project = store.projects.create({ name: 'gwrap-ui-proj', path: projDir, engine: 'claude' });

  const launchId = launchSequence.mintLaunchId();
  const snapshot = launchSequence.buildSnapshot({
    launchId, project, engineProfile: store.engines.get('claude'),
    applicability: { applicable: false, reason: 'test binding' }, rendered: null, rules: []
  });
  session = store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });
  wrapRunRegistry._resetForTests();
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  wrapRunRegistry._resetForTests();
});

describe('formatWrapProgressEvent', () => {
  it('frames a stage as the same id:/event:/data: SSE wire shape the plain wrap stream uses', () => {
    const frame = gw.formatWrapProgressEvent(3, gw.PROGRESS_STAGES.PIPELINE_RUNNING, { foo: 'bar' });
    assert.match(frame, /^id: 3\n/);
    assert.match(frame, /event: pipeline-running\n/);
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
    const data = JSON.parse(dataLine.slice('data: '.length));
    assert.equal(data.stage, 'pipeline-running');
    assert.deepEqual(data.detail, { foo: 'bar' });
    assert.equal(typeof data.sentAt, 'string');
    assert.ok(frame.endsWith('\n\n'));
  });

  it('defaults a missing detail to null rather than omitting the field', () => {
    const frame = gw.formatWrapProgressEvent(0, gw.PROGRESS_STAGES.PREFLIGHT);
    const data = JSON.parse(frame.split('\n').find((l) => l.startsWith('data: ')).slice('data: '.length));
    assert.equal(data.detail, null);
  });

  it('rejects a negative or non-integer seq', () => {
    assert.throws(() => gw.formatWrapProgressEvent(-1, gw.PROGRESS_STAGES.PREFLIGHT), /non-negative integer/);
    assert.throws(() => gw.formatWrapProgressEvent(1.5, gw.PROGRESS_STAGES.PREFLIGHT), /non-negative integer/);
  });

  it('rejects a stage outside the real set', () => {
    assert.throws(() => gw.formatWrapProgressEvent(0, 'not-a-real-stage'), /unknown progress stage/);
  });
});

describe('createWrapProgressStream', () => {
  it('reports "preflight" for a request still awaiting a decision, with no run to subscribe to', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    const stream = gw.createWrapProgressStream(r.request.requestId, { onEvent: () => {}, onEnd: () => {} });
    assert.equal(stream.ok, true);
    assert.equal(stream.replay.length, 1);
    assert.equal(stream.replay[0].stage, gw.PROGRESS_STAGES.PREFLIGHT);
    assert.equal(stream.replay[0].seq, 1);
    assert.equal(stream.finished, false);
  });

  it('reports "decision-validated" once a decision is ready but not yet executed', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    gw.submitDecision({ requestId: r.request.requestId, principal: 'operator', decision: decisionFor(r) });
    const stream = gw.createWrapProgressStream(r.request.requestId, { onEvent: () => {}, onEnd: () => {} });
    assert.equal(stream.replay[0].stage, gw.PROGRESS_STAGES.DECISION_VALIDATED);
    assert.equal(stream.finished, false);
  });

  it('reports "failed" for a request that never got a run (stale/expired/cancelled)', async () => {
    const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
    gw.cancelRequest(r.request.requestId, 'test: no longer needed');
    const stream = gw.createWrapProgressStream(r.request.requestId, { onEvent: () => {}, onEnd: () => {} });
    assert.equal(stream.replay[0].stage, gw.PROGRESS_STAGES.FAILED);
    assert.equal(stream.finished, true);
  });

  it('refuses an unknown request id', () => {
    const stream = gw.createWrapProgressStream('no-such-request', { onEvent: () => {}, onEnd: () => {} });
    assert.equal(stream.ok, false);
    assert.equal(stream.code, 'NOT_FOUND');
  });

  describe('once executing, against a real wrap-run-registry run', () => {
    let realStartWrap;

    beforeEach(() => {
      realStartWrap = sessionsLib.startWrap;
    });

    afterEach(() => {
      sessionsLib.startWrap = realStartWrap;
    });

    /** Drive a request through to `executing`, claiming a real registry run. */
    async function readyAndExecuting() {
      const r = await gw.createPreflightRequest({ projectName: project.name, initiator: COORDINATOR });
      gw.submitDecision({ requestId: r.request.requestId, principal: 'operator', decision: decisionFor(r) });
      sessionsLib.startWrap = (projectName) => {
        const claim = wrapRunRegistry.begin(projectName, session.id, {});
        return { ok: true, runId: claim.runId, sessionId: session.id };
      };
      const executed = await gw.executeReadyRequest(r.request.requestId);
      assert.equal(executed.ok, true);
      return executed.request;
    }

    it('replays "pipeline-running" while the run is still live, with no terminal frame', async () => {
      const request = await readyAndExecuting();
      const stream = gw.createWrapProgressStream(request.requestId, { onEvent: () => {}, onEnd: () => {} });
      assert.equal(stream.ok, true);
      assert.equal(stream.finished, false);
      const stages = stream.replay.map((f) => f.stage);
      assert.ok(stages.includes(gw.PROGRESS_STAGES.PIPELINE_RUNNING));
      assert.ok(!stages.includes(gw.PROGRESS_STAGES.COMPLETED));
      assert.ok(!stages.includes(gw.PROGRESS_STAGES.FAILED));
    });

    it('delivers a live "completed" frame when the run finishes ok, and ends the stream', async () => {
      const request = await readyAndExecuting();
      const events = [];
      let ended = false;
      const stream = gw.createWrapProgressStream(request.requestId, {
        onEvent: (f) => events.push(f),
        onEnd: () => { ended = true; }
      });
      assert.equal(stream.ok, true);
      wrapRunRegistry.finish(project.name, request.runId, { ok: true });
      assert.equal(events.length, 1);
      assert.equal(events[0].stage, gw.PROGRESS_STAGES.COMPLETED);
      assert.equal(ended, true);
    });

    it('delivers a live "failed" frame when the run finishes with ok:false', async () => {
      const request = await readyAndExecuting();
      const events = [];
      const stream = gw.createWrapProgressStream(request.requestId, { onEvent: (f) => events.push(f), onEnd: () => {} });
      assert.equal(stream.ok, true);
      wrapRunRegistry.finish(project.name, request.runId, { ok: false, error: 'test failure' });
      assert.equal(events.length, 1);
      assert.equal(events[0].stage, gw.PROGRESS_STAGES.FAILED);
    });

    it('replays "completed" for a run that already finished before the stream was opened', async () => {
      const request = await readyAndExecuting();
      wrapRunRegistry.finish(project.name, request.runId, { ok: true });
      const stream = gw.createWrapProgressStream(request.requestId, { onEvent: () => {}, onEnd: () => {} });
      assert.equal(stream.ok, true);
      assert.equal(stream.finished, true);
      assert.ok(stream.replay.some((f) => f.stage === gw.PROGRESS_STAGES.COMPLETED));
    });

    it('reports "failed", never "completed", for a stale/wedged run whose outcome is unknown (I-Gate R1 Finding 2)', async () => {
      // `wrap-run-registry.js#subscribe` synthesizes a `run-done` with
      // `result: null` for a run older than STALE_RUN_MS that never settled
      // -- its own doc: "the outcome is precisely what nobody knows". The
      // ORIGINAL `_stageForRunEvent` defaulted anything short of
      // `result.ok === false` to `completed`, so `result: null` read as a
      // successful finish. Same clock-override shape test/api-wrap-stream.
      // test.js uses to produce the same synthetic event.
      const request = await readyAndExecuting();
      const realNow = wrapRunRegistry._internal.now;
      try {
        const fakeNow = realNow() + wrapRunRegistry.STALE_RUN_MS + 1000;
        wrapRunRegistry._internal.now = () => fakeNow;
        const stream = gw.createWrapProgressStream(request.requestId, { onEvent: () => {}, onEnd: () => {} });
        assert.equal(stream.ok, true);
        assert.equal(stream.finished, true);
        const terminal = stream.replay[stream.replay.length - 1];
        assert.equal(terminal.stage, gw.PROGRESS_STAGES.FAILED);
        assert.notEqual(terminal.stage, gw.PROGRESS_STAGES.COMPLETED);
        // The stale detail rides along, distinguishing this from a genuine failure.
        assert.equal(terminal.detail.stale, true);
      } finally {
        wrapRunRegistry._internal.now = realNow;
      }
    });

    it('unsubscribe stops further live frames from reaching the listener', async () => {
      const request = await readyAndExecuting();
      const events = [];
      const stream = gw.createWrapProgressStream(request.requestId, { onEvent: (f) => events.push(f), onEnd: () => {} });
      stream.unsubscribe();
      wrapRunRegistry.finish(project.name, request.runId, { ok: true });
      assert.equal(events.length, 0);
    });

    it('reports an explicit "failed" terminal, never a bare "pipeline-running", for a run the registry lost (I-Gate R2)', async () => {
      // The reviewer's own repro: a real executing request, the in-process
      // registry reset underneath it (the restart case), then the stream
      // reopened. Before this fix, `sessions.subscribeWrapRun` returning
      // `{ok:false}` left the replay at `[initial]` -- the "pipeline-running"
      // frame pushed before the subscribe attempt -- with `finished: true`
      // and no terminal stage at all, so a progress bar would sit at its
      // "running" percent forever even though the stream had closed.
      const request = await readyAndExecuting();
      wrapRunRegistry._resetForTests(); // simulates the server restarting: the run is gone from the in-process registry
      const stream = gw.createWrapProgressStream(request.requestId, { onEvent: () => {}, onEnd: () => {} });
      assert.equal(stream.ok, true);
      assert.equal(stream.finished, true);
      const terminal = stream.replay[stream.replay.length - 1];
      assert.equal(terminal.stage, gw.PROGRESS_STAGES.FAILED);
      assert.notEqual(terminal.stage, gw.PROGRESS_STAGES.PIPELINE_RUNNING);
      assert.equal(terminal.detail.reason, 'run-not-in-registry');
    });
  });
});

describe('public/governed-wrap-ui.js', () => {
  let js;

  beforeEach(() => {
    js = fs.readFileSync(path.join(__dirname, '..', 'public', 'governed-wrap-ui.js'), 'utf8');
  });

  it('declares the same five stages lib/governed-wrap.js does', () => {
    const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'governed-wrap.js'), 'utf8');
    for (const stage of ['preflight', 'decision-validated', 'pipeline-running', 'completed', 'failed']) {
      assert.ok(js.includes(`'${stage}'`), `UI declares stage "${stage}"`);
      assert.ok(libSrc.includes(`'${stage}'`), `lib declares stage "${stage}"`);
    }
  });

  describe('renderGovernedWrapButton', () => {
    function loadFn() {
      const esc = require('./helpers/lift').loadEsc('landing.js');
      return new Function('esc', `${require('./helpers/lift').liftDeclaration(js, 'function renderGovernedWrapButton(')}\nreturn renderGovernedWrapButton;`)(esc);
    }

    it('renders an enabled Wrap button with no open request', () => {
      const html = loadFn()(null);
      assert.match(html, /<button/);
      assert.doesNotMatch(html, /disabled/);
      assert.match(html, />Wrap</);
    });

    it('renders a disabled, state-labeled button with an open request', () => {
      const html = loadFn()({ state: 'executing' });
      assert.match(html, /disabled/);
      assert.match(html, /executing/);
    });
  });

  describe('renderGovernedWrapPreflightModal', () => {
    function loadFn() {
      const esc = require('./helpers/lift').loadEsc('landing.js');
      return new Function('esc', `${require('./helpers/lift').liftDeclaration(js, 'function renderGovernedWrapPreflightModal(')}\nreturn renderGovernedWrapPreflightModal;`)(esc);
    }

    it('shows the target head and control state', () => {
      const html = loadFn()({ preflight: { headSha: 'abc123', controlState: 'hold' }, expiresAt: '2026-11-05T00:00:00.000Z' });
      assert.match(html, /abc123/);
      assert.match(html, /hold/);
      assert.match(html, /2026-11-05T00:00:00\.000Z/);
    });

    it('offers both bulk file policies, defaulting to leave-all-preexisting', () => {
      const html = loadFn()({ preflight: {}, expiresAt: 'x' });
      assert.match(html, /value="leave-all-preexisting"\s+checked/);
      assert.match(html, /value="include-owned-only"/);
      assert.doesNotMatch(html, /value="include-owned-only"\s+checked/);
    });
  });

  describe('renderGovernedWrapProgressBar', () => {
    /** The function depends on the module-level info map; `liftDeclaration`
     * alone would lift `const X = Object.freeze({…}` without its closing
     * `);`, since that constant's declaration is not a bare function body —
     * so this lifts through the first `});` after the decl instead. */
    function liftInfoConst() {
      const decl = 'const GOVERNED_WRAP_PROGRESS_INFO';
      const start = js.indexOf(decl);
      assert.notEqual(start, -1);
      const end = js.indexOf('});', start) + 3;
      return js.slice(start, end);
    }

    function loadFn() {
      const esc = require('./helpers/lift').loadEsc('landing.js');
      const src = `${liftInfoConst()}\n${require('./helpers/lift').liftDeclaration(js, 'function renderGovernedWrapProgressBar(')}\nreturn renderGovernedWrapProgressBar;`;
      return new Function('esc', src)(esc);
    }

    it('renders an accessible progressbar with the stage-appropriate percent', () => {
      const html = loadFn()('pipeline-running');
      assert.match(html, /role="progressbar"/);
      assert.match(html, /aria-valuenow="70"/);
      assert.match(html, /width:70%/);
    });

    it('reaches 100% on both completed and failed, distinguished by a tone class', () => {
      const completed = loadFn()('completed');
      const failed = loadFn()('failed');
      assert.match(completed, /aria-valuenow="100"/);
      assert.match(failed, /aria-valuenow="100"/);
      assert.doesNotMatch(completed, /governed-wrap-progress-failed/);
      assert.match(failed, /governed-wrap-progress-failed/);
    });
  });
});

describe('public/session.js call sites for governed-wrap-ui.js (v5.67.0 FEED-FORWARD 01)', () => {
  const SESSION_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
  const GOVERNED_WRAP_UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'governed-wrap-ui.js'), 'utf8');

  /**
   * Build a sandbox with the REAL governed-wrap-ui.js loaded, and the REAL
   * `checkGovernedWrapProgress` + `_governedWrapProgressContainer` lifted
   * from session.js's own source — a genuine two-file integration, not a
   * stub standing in for either side.
   * @param {object} [overrides] - `{api}`.
   * @returns {{doc: object, check: Function}}
   */
  function loadLifted(overrides = {}) {
    const { doc, ids } = makeDocument(['wrapDrawerBody', 'wrapDrawerStatus']);
    withIdParsingInnerHTML(ids.wrapDrawerBody, doc);
    const sandbox = {
      console,
      document: doc,
      projectName: 'proj-1',
      api: overrides.api || (async () => null),
      esc: require('./helpers/lift').loadEsc('landing.js')
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(GOVERNED_WRAP_UI_SRC, sandbox);
    vm.runInContext(
      'let currentGovernedWrapStream = null;\n'
      + `${liftDeclaration(SESSION_SRC, 'function _governedWrapProgressContainer(')}\n`
      + `${liftDeclaration(SESSION_SRC, 'async function checkGovernedWrapProgress(')}\n`
      + 'globalThis.checkGovernedWrapProgress = checkGovernedWrapProgress;',
      sandbox
    );
    return { doc, check: sandbox.checkGovernedWrapProgress };
  }

  /**
   * The mini-dom's `byId` registry is populated only by `makeDocument`'s own
   * initial ids and by `withIdParsingInnerHTML`'s string-parsing (test/_mini-
   * dom.js's documented limits) — never by a real `createElement` +
   * `appendChild`/`insertBefore`, which is exactly how production
   * `_governedWrapProgressContainer` builds its container. A real browser's
   * `getElementById` would find it; this walks `childNodes` instead, the one
   * thing the mini-dom's DOM methods DO maintain correctly.
   * @param {object} parent
   * @param {string} id
   * @returns {object|null}
   */
  function findChildById(parent, id) {
    for (const child of parent.childNodes) {
      if (child.id === id) return child;
      const deeper = findChildById(child, id);
      if (deeper) return deeper;
    }
    return null;
  }

  it('leaves the container hidden and empty when no request is open (the common case)', async () => {
    const { doc, check } = loadLifted({ api: async () => null });
    await check();
    const container = findChildById(doc.body, 'wrapDrawerGovernedProgress');
    assert.ok(container, 'the container must still be created');
    assert.equal(container.classList.contains('hidden'), true);
    assert.equal(container.innerHTML, '');
  });

  it('leaves the container hidden for a request already at a terminal stage', async () => {
    const { doc, check } = loadLifted({
      api: async () => ({ ok: true, request: { id: 'gw-1', state: 'completed' } })
    });
    await check();
    assert.equal(findChildById(doc.body, 'wrapDrawerGovernedProgress').classList.contains('hidden'), true);
  });

  it('renders the real progress bar for an open, non-terminal request', async () => {
    const { doc, check } = loadLifted({
      api: async () => ({ ok: true, request: { id: 'gw-1', state: 'pipeline-running' } })
    });
    await check();
    const container = findChildById(doc.body, 'wrapDrawerGovernedProgress');
    assert.equal(container.classList.contains('hidden'), false);
    assert.match(container.innerHTML, /role="progressbar"/);
    assert.match(container.innerHTML, /aria-valuenow="70"/);
  });
});
