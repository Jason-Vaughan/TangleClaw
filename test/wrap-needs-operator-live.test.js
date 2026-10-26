'use strict';

/*
 * #2588 — the needs-operator pre-commit review pause (#2156, A461-R3), driven
 * end to end through the real HTTP wrap route and the REAL pipeline (no step
 * mocked), proving the three scenarios PR #2587's isolated scratch-server
 * browser check could not reach without a live wrap session:
 *
 *   1. `options.reviewSessionFiles: true` pauses the run `needs-operator`
 *      before any content step runs, naming the owned file in the
 *      session-files step's `output.manifest.commit`.
 *   2. That same manifest is what the drawer's Keep-local checkboxes are
 *      built from (one per `manifest.commit` entry) — proven here by reading
 *      it off a REAL settled run, not a VM-sandboxed accessor.
 *   3. A Retry — `pathDecisions: {<path>: 'leave'}`, `reviewSessionFiles`
 *      omitted (the no-loop contract `test/wrap-run-session-wiring.test.js`
 *      already pins on the frontend accessor) — moves the file onto
 *      `manifest.keepLocal` against the REAL backend, and the real commit
 *      that follows excludes it from the tree.
 *
 * Isolation (#2604): both axes a scratch run must scope so it never touches
 * the live install's own database (port 3102) or the real
 * `~/Documents/Projects` — an isolated `TANGLECLAW_HOME`-equivalent
 * (`store._setBasePath`) AND an isolated `projectsDir`
 * (`store.config.save`). This is the in-process `createServer()` harness
 * `test/api-wrap-status.test.js` already uses for real wrap-run HTTP tests;
 * `scripts/with-scratch-server.js` (#2596) spawns a separate child process
 * and has no handle into that process's `store`, so seeding an active
 * session for it would need a real tmux pane and a real engine launch — far
 * heavier than this scenario needs, and not what any existing wrap test does.
 * Real HTTP, a real git repo (direct `child_process` git calls), a real
 * (unmocked) `runWrapPipeline`: large tier (`node scripts/test-tiers.js
 * --propose`), not medium (`test/tiers.json`).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');
const wrapRunRegistry = require('../lib/wrap-run-registry');
const { operatorHeaders } = require('./_shared-docs-callers');
const { liftDeclaration } = require('./helpers/lift');
const { makeDocument } = require('./_mini-dom');
const wrapDrawerHelpers = require('../public/wrap-drawer');
const wrapRunController = require('../public/wrap-run-controller');

/** Every `kind: "ai-content"` step in the default pipeline (#2588's scenario needs none of them). */
const SKIP_AI_CONTENT = Object.freeze({
  'changelog-update': true,
  'release-recommendation': true,
  'learnings-capture': true,
  'memory-update': true
});

const SESSION_JS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');

/**
 * The same-origin headers `test/_shared-docs-callers.js#operatorHeaders` sends
 * for a scratch store with no login in force — needed here too since this
 * sandbox's `fetch` calls are real requests, not the `http.request` calls
 * `operatorHeaders(server)` was written against.
 * @param {string} baseUrl
 * @returns {{Origin: string, 'Sec-Fetch-Site': string}}
 */
function SAME_ORIGIN_HEADERS(baseUrl) {
  return { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' };
}

/**
 * The real session.js functions PRR-B's fix asked this test to drive, instead
 * of constructing `pathDecisions` by hand: the wrap-run controller (so a real
 * settle triggers a real paint), `postWrap`/`retryWrap` (so the browser's own
 * code builds the POST body), and `renderStepRow`/`buildKeepLocalControls`
 * (so the Keep-local checkbox the operator ticks is the one the real drawer
 * renders, not a hand-built stand-in).
 *
 * Deliberately NOT the full `renderWrapDrawer`/`openWrapDrawer`: those also
 * paint the status banner, the skip rollup, and decision widgets for every
 * OTHER blocker kind (version-bump's Cut/Hold, pr-check's resolution list,
 * the foreign-path Include/Leave list, the untrack offer) — none of which
 * #2588 is about, and each with its own DOM-id and helper-function surface.
 * `openWrapDrawer` below is this test's own replacement: it calls the two
 * real functions that build the Keep-local checkbox and nothing else.
 */
const BROWSER_WIRING = [
  'function wrapRunState(', 'function wrapStatusUrl(', 'function dispatchWrapRun(', 'function syncWrapRunEffects(', 'function paintWrapRun(',
  'async function postWrap(', 'async function retryWrap(', 'async function _probeWrapStatus(', 'function renderStepRow(', 'function buildKeepLocalControls(',
  'function renderManifest('
];

/**
 * Build a VM sandbox holding the real wiring above, wired to a REAL fetch
 * against a live server instead of a canned response.
 *
 * @param {string} baseUrl - The live in-process server's origin
 * @param {string} projectName - The project this page follows
 * @returns {{sandbox: object, openedRows: object[]}} `openedRows` accumulates
 *   every `<li>` this sandbox's `openWrapDrawer` has built, most recent last.
 */
function buildBrowserSandbox(baseUrl, projectName) {
  const { doc } = makeDocument(['wrapStepList', 'wrapDrawerDecision', 'wrapDrawerRetryBtn']);
  const openedRows = [];
  const noop = () => {};

  const sandbox = {
    console,
    JSON, Promise, Date, Map, Set, Object, Array, String, Number, Boolean, Error,
    encodeURIComponent,
    setTimeout, clearTimeout,
    document: doc,
    projectName,
    sessionState: { wrapDrawerOpen: false },
    wrapSkippedAiSteps: {},
    wrapPathDecisions: {},
    wrapPathDecisionBasis: {},
    wrapSkipPreflight: false,
    wrapBumpLevel: '',
    wrapReleaseChoice: '',
    wrapUntrackState: '',
    wrapProceedPastStranded: [],
    wrapKeepRunning: false,
    lastRefusedStrandedItems: null,
    wrapDrawerStrandedItems: null,
    tcStrandedKeys: (items) => items,
    currentWrapPassword: '',
    // The transport/handback/clock machinery is real in production, but
    // nothing in #2588's scenario touches a stream or a handback — stubbed
    // so this sandbox's dependency surface stays exactly what the Keep-local
    // round trip needs, auditable in one read.
    startWrapStream: noop, stopWrapStream: noop,
    scheduleWrapStatusPoll: noop, cancelWrapStatusPoll: noop,
    syncHandbackEffects: noop, paintWrapButton: noop, paintHandback: noop, syncWrapClock: noop,
    rememberFollowedWrapRun: noop,
    renderLiveWrapDrawer: noop, openWrapDrawerNotice: noop,
    hideWrapDrawer: noop, collapseWrapDrawer: noop, expandWrapDrawer: noop,
    showWrappingState: noop, clearWrappingState: noop,
    /**
     * This test's stand-in for the real `openWrapDrawer` (see BROWSER_WIRING's
     * doc comment): builds the settled session-files row through the REAL
     * `buildStepRow` + `renderStepRow` + `buildKeepLocalControls`, the exact
     * functions that turn a live poll response into the Keep-local checkbox
     * the operator ticks, and keeps the rendered `<li>` where the test can
     * read it back.
     * @param {object} pipelineResult - The settled run's real pipelineResult
     */
    openWrapDrawer(pipelineResult) {
      const sfResult = pipelineResult.results.find((r) => r.stepId === 'session-files');
      const row = wrapDrawerHelpers.buildStepRow(sfResult, { blockedAt: pipelineResult.blockedAt });
      const li = sandbox.renderStepRow(row, { commitSha: pipelineResult.commitSha });
      doc.getElementById('wrapStepList').appendChild(li);
      openedRows.push({ row, li });
    },
    // #2604 — the only network path this sandbox has: a real fetch against
    // the live, isolated in-process server this test started, never a canned
    // response. `apiMutate`'s contract (parsed body on 2xx, null otherwise)
    // mirrors `public/api-helper.js`'s `tcCreateApi`/`tcCreateApiMutate`
    // closely enough for `postWrap`/`retryWrap` to drive it unmodified; this
    // test does not load api-helper.js itself; CSRF/connection-state tracking
    // are a different file's concern and this scratch store runs with no
    // login in force, so neither is exercised here.
    async apiMutate(url, method, body) {
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...SAME_ORIGIN_HEADERS(baseUrl) },
        body: JSON.stringify(body)
      });
      if (!res.ok) return null;
      return res.json();
    },
    // `_probeWrapStatus`'s own transport — a real fetch, raw `Response` (its
    // contract), against the same live server. Only reached on a refused
    // POST, which this test's happy path should never hit.
    async tcFetch(url) {
      return fetch(`${baseUrl}${url}`, { headers: SAME_ORIGIN_HEADERS(baseUrl) });
    },
    api: { lastError: null }
  };
  sandbox.window = sandbox;
  sandbox.window.tcWrapDrawerHelpers = wrapDrawerHelpers;
  sandbox.window.tcWrapRunController = wrapRunController;
  vm.createContext(sandbox);
  const globals = 'let wrapRun = null;\nlet currentWrapStreamRunId = null;';
  vm.runInContext(
    `${globals}\n${BROWSER_WIRING.map((decl) => liftDeclaration(SESSION_JS_SRC, decl)).join('\n\n')}\n`,
    sandbox
  );
  return { sandbox, openedRows };
}

/**
 * GET a status URL through the sandbox's own real fetch (not Node's `http`
 * module), so the poll that drives the controller is the same transport
 * `postWrap`/`retryWrap` use.
 * @param {string} baseUrl
 * @param {string} statusUrl
 * @returns {Promise<object|null>}
 */
async function realStatusGet(baseUrl, statusUrl) {
  const res = await fetch(`${baseUrl}${statusUrl}`);
  if (!res.ok) return null;
  return res.json();
}

/**
 * Drive the REAL controller's settle detection by polling `/wrap/status`
 * and feeding each answer through the REAL `dispatchWrapRun({type:'status'})`
 * — the same signal `scheduleWrapStatusPoll`'s timer sends in production,
 * just invoked directly instead of waiting on a real or faked timer.
 *
 * @param {object} sandbox - From `buildBrowserSandbox`
 * @param {string} baseUrl
 * @param {string} projectName
 * @param {string} runId - The run being followed
 * @returns {Promise<object>} The settled controller state
 */
async function pollUntilSettled(sandbox, baseUrl, projectName, runId) {
  const statusUrl = `/api/sessions/${encodeURIComponent(projectName)}/wrap/status`;
  for (let i = 0; i < 500; i++) {
    const status = await realStatusGet(baseUrl, statusUrl);
    sandbox.dispatchWrapRun({ type: 'status', runId, status });
    const state = sandbox.wrapRunState();
    if (state.phase === 'settled') return state;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('browser-driven wrap run never settled within the poll bound');
}

/**
 * Make an HTTP request to the test server.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @param {Record<string, string>} [callerHeaders] - Who is asking
 * @returns {Promise<{ status: number, body: object }>}
 */
function request(server, method, urlPath, body, callerHeaders = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...callerHeaders };
    if (bodyStr != null) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr != null) req.write(bodyStr);
    req.end();
  });
}

/**
 * A request from the operator's dashboard, as the wrap drawer sends it.
 * @param {http.Server} server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<{ status: number, body: object }>}
 */
function operatorRequest(server, method, urlPath, body) {
  return request(server, method, urlPath, body, operatorHeaders(server));
}

/**
 * Run git in a repo.
 * @param {string} cwd
 * @param {...string} args
 * @returns {string} stdout
 */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Poll `GET /wrap/status` until the run is no longer `running`.
 * @param {http.Server} server
 * @param {string} project
 * @returns {Promise<object>} The settled status body.
 */
async function waitForSettled(server, project) {
  for (let i = 0; i < 1000; i++) {
    const res = await request(server, 'GET', `/api/sessions/${project}/wrap/status`);
    if (!res.body.running) return res.body;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('wrap run never settled within the poll bound');
}

describe('#2588 — needs-operator pre-commit review pause, a real wrap start to finish', () => {
  const PROJECT_NAME = 'needs-operator-live';
  const SESSION_FILE = 'notes/session-scratch.md';
  // A second, independent project+repo for the browser-driven test below:
  // the first test deliberately leaves SESSION_FILE modified and uncommitted
  // when it finishes, and a second session starting within the same
  // wall-clock SECOND as that write would see it as its own (ownership-by-
  // mtime is second-grained, matching the session row's SQLite timestamp) —
  // sharing a project risks exactly the cross-test flake the real pipeline's
  // mtime rule exists to accept for a single session, not two.
  const BROWSER_PROJECT_NAME = 'needs-operator-live-browser';
  const BROWSER_SESSION_FILE = 'notes/session-scratch-browser.md';

  let tmpDir;
  let server;
  let projectPath;
  let projectId;
  let browserProjectPath;
  let browserProjectId;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-w3b-2588-'));
    store._setBasePath(tmpDir);
    store.init();

    // #2604 — the isolated projects root this check must never fall back off of.
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    projectPath = path.join(projectsDir, PROJECT_NAME);
    fs.mkdirSync(projectPath, { recursive: true });
    git(projectPath, 'init', '-q');
    git(projectPath, 'config', 'user.email', 't@t');
    git(projectPath, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(projectPath, 'README.md'), `# ${PROJECT_NAME}\n`);
    // Committed as a placeholder, then overwritten after the session starts
    // (below): a file born brand-new mid-session is `_file-ownership.js`'s
    // `untracked-new` case and is asked about regardless of its write time —
    // ownership-by-mtime (the path that lets an edited file through with no
    // ask) applies only to a file git already tracks.
    fs.mkdirSync(path.join(projectPath, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, SESSION_FILE), 'placeholder\n');
    git(projectPath, 'add', '-A');
    git(projectPath, 'commit', '-q', '-m', 'scaffold');

    const project = store.projects.create({ name: PROJECT_NAME, path: projectPath, engine: 'claude' });
    projectId = project.id;

    browserProjectPath = path.join(projectsDir, BROWSER_PROJECT_NAME);
    fs.mkdirSync(browserProjectPath, { recursive: true });
    git(browserProjectPath, 'init', '-q');
    git(browserProjectPath, 'config', 'user.email', 't@t');
    git(browserProjectPath, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(browserProjectPath, 'README.md'), `# ${BROWSER_PROJECT_NAME}\n`);
    fs.mkdirSync(path.join(browserProjectPath, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(browserProjectPath, BROWSER_SESSION_FILE), 'placeholder\n');
    git(browserProjectPath, 'add', '-A');
    git(browserProjectPath, 'commit', '-q', '-m', 'scaffold');
    const browserProject = store.projects.create({ name: BROWSER_PROJECT_NAME, path: browserProjectPath, engine: 'claude' });
    browserProjectId = browserProject.id;

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    wrapRunRegistry._resetForTests();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    wrapRunRegistry._resetForTests();
    const active = store.sessions.getActive(projectId);
    if (active) store.sessions.kill(active.id, 'test cleanup');
    const browserActive = store.sessions.getActive(browserProjectId);
    if (browserActive) store.sessions.kill(browserActive.id, 'test cleanup');
  });

  it('pauses with the owned file on manifest.commit, then a Retry leaves it uncommitted on manifest.keepLocal', async () => {
    // A fake tmux session name: `lib/wrap-scope.js` `resolveWorkTree` probes it
    // and degrades to the registered checkout ("pane directory could not be
    // read") when no such pane exists — no real tmux session is created or
    // touched by this test.
    const headBefore = git(projectPath, 'rev-parse', 'HEAD').trim();
    store.sessions.start({ projectId, engineId: 'claude', tmuxSession: 'tc-w3b-2588-no-such-pane' });
    fs.writeFileSync(path.join(projectPath, SESSION_FILE), 'scratch notes written this session\n');

    // Scenario 1 + 2: `reviewSessionFiles` pauses before any content step,
    // naming the owned file in `manifest.commit` — exactly what the drawer's
    // Keep-local checkboxes (#2156) are built from.
    const start = await operatorRequest(server, 'POST', `/api/sessions/${PROJECT_NAME}/wrap`, {
      options: { reviewSessionFiles: true, skipAiContent: SKIP_AI_CONTENT }
    });
    assert.equal(start.status, 202, JSON.stringify(start.body));

    const paused = await waitForSettled(server, PROJECT_NAME);
    assert.equal(paused.result.pipelineResult.ok, false);
    assert.equal(paused.result.pipelineResult.blockedAt, 'session-files');
    const pausedSessionFiles = paused.result.pipelineResult.results.find((r) => r.stepId === 'session-files');
    assert.equal(pausedSessionFiles.status, 'needs-operator');
    assert.ok(
      pausedSessionFiles.output.manifest.commit.includes(SESSION_FILE),
      'the owned file is on manifest.commit — the drawer builds one Keep-local checkbox per entry here (#2156)'
    );

    // Scenario 3: Retry — `reviewSessionFiles` omitted (the no-loop contract
    // `retryWrap`'s real accessors hold to), `pathDecisions` marks the file Leave.
    const retry = await operatorRequest(server, 'POST', `/api/sessions/${PROJECT_NAME}/wrap`, {
      options: { pathDecisions: { [SESSION_FILE]: 'leave' }, skipAiContent: SKIP_AI_CONTENT }
    });
    assert.equal(retry.status, 202, JSON.stringify(retry.body));

    const done = await waitForSettled(server, PROJECT_NAME);
    assert.equal(done.result.pipelineResult.ok, true, JSON.stringify(done.result.pipelineResult.error));
    const retriedSessionFiles = done.result.pipelineResult.results.find((r) => r.stepId === 'session-files');
    assert.equal(
      retriedSessionFiles.status, 'done',
      'no second pause: reviewSessionFiles absent, so the no-loop contract held against the REAL backend, not just the frontend accessor'
    );
    assert.ok(retriedSessionFiles.output.manifest.keepLocal.includes(SESSION_FILE));
    assert.ok(!retriedSessionFiles.output.manifest.commit.includes(SESSION_FILE));

    // With the sole owned file left out, there is nothing left to commit — the
    // real `commit` step skips rather than opening an empty commit, so HEAD
    // never moves. That IS the live ground truth the isolated scratch check
    // deferred (#2588): the operator's Leave choice held all the way through
    // the real backend, not just the frontend accessor.
    assert.equal(git(projectPath, 'rev-parse', 'HEAD').trim(), headBefore, 'the wrap must not have created a commit');
    // Not `.trim()`-ed: porcelain's leading column is a literal space for "no
    // staged change", which `.trim()` would strip and falsify the match.
    const statusLine = git(projectPath, 'status', '--porcelain', '--', SESSION_FILE);
    assert.match(statusLine, /^ M /, `${SESSION_FILE}'s session edit must remain uncommitted on disk`);
  });

  it('PRR-B fix (#2588 C1): the REAL drawer renders the checkbox, a real toggle drives the REAL Retry handler\'s own POST', async () => {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const { sandbox, openedRows } = buildBrowserSandbox(baseUrl, BROWSER_PROJECT_NAME);

    const headBefore = git(browserProjectPath, 'rev-parse', 'HEAD').trim();
    store.sessions.start({ projectId: browserProjectId, engineId: 'claude', tmuxSession: 'tc-w3b-2588-browser-no-pane' });
    fs.writeFileSync(path.join(browserProjectPath, BROWSER_SESSION_FILE), 'scratch notes written this session (browser path)\n');

    // The browser's own `postWrap`, not a raw HTTP POST this test constructs.
    sandbox.dispatchWrapRun({ type: 'start', retry: false });
    const posted = await sandbox.postWrap({ options: { reviewSessionFiles: true, skipAiContent: SKIP_AI_CONTENT } });
    assert.equal(posted, true, 'the real postWrap must report a followed run');

    const pausedState = await pollUntilSettled(sandbox, baseUrl, BROWSER_PROJECT_NAME, sandbox.wrapRunState().runId);
    assert.equal(pausedState.result.pipelineResult.ok, false);
    assert.equal(pausedState.result.pipelineResult.blockedAt, 'session-files');

    // The settle triggered the REAL paintWrapRun -> this sandbox's openWrapDrawer,
    // which built the row through the REAL buildStepRow + renderStepRow +
    // buildKeepLocalControls — not this test reading manifest.commit by hand.
    assert.equal(openedRows.length, 1, 'the real settle-time paint fired exactly once');
    const { row, li } = openedRows[0];
    assert.ok(row.keepLocalControls.includes(BROWSER_SESSION_FILE),
      'the REAL buildStepRow lists the owned file as a Keep-local candidate');
    const checkboxes = li.querySelectorAll('.wrap-step-keeplocal-cb');
    assert.equal(checkboxes.length, 1, 'the REAL renderStepRow + buildKeepLocalControls rendered exactly one checkbox');
    assert.equal(checkboxes[0].dataset.path, BROWSER_SESSION_FILE, 'the checkbox is scoped to the owned file');
    assert.equal(checkboxes[0].checked, false, 'a fresh render is unchecked');

    // The operator ticking the box — the one DOM mutation this test makes
    // instead of a real click event, since there is no browser here to click.
    checkboxes[0].checked = true;

    // retryWrap's own `skipAiContent` accessor reads a "Skip & note" checkbox
    // this scenario never renders (its blocker is Keep-local, not a content
    // step) — `accumulateAiContentSkips` replays the FULL accumulated set onto
    // `options` regardless (#328, so an earlier retry's skip survives a later
    // one), so seeding the accumulator directly is the accessor-free
    // equivalent of "these boxes were already ticked on an earlier retry".
    Object.assign(sandbox.wrapSkippedAiSteps, SKIP_AI_CONTENT);

    // The REAL retryWrap(): it reads the checkbox above through its own real
    // `keepLocalPaths` accessor (document.getElementById('wrapStepList')
    // .querySelectorAll('.wrap-step-keeplocal-cb:checked')), builds
    // pathDecisions itself, and POSTs it — this test sends nothing by hand.
    await sandbox.retryWrap();
    const settledState = await pollUntilSettled(sandbox, baseUrl, BROWSER_PROJECT_NAME, sandbox.wrapRunState().runId);
    assert.equal(settledState.result.pipelineResult.ok, true, JSON.stringify(settledState.result.pipelineResult.error));
    const retriedSessionFiles = settledState.result.pipelineResult.results.find((r) => r.stepId === 'session-files');
    assert.equal(retriedSessionFiles.status, 'done', 'no second pause — reviewSessionFiles is not among retryWrap\'s accessors');
    assert.ok(retriedSessionFiles.output.manifest.keepLocal.includes(BROWSER_SESSION_FILE),
      'the browser-checked box moved the file to manifest.keepLocal');
    assert.ok(!retriedSessionFiles.output.manifest.commit.includes(BROWSER_SESSION_FILE));

    assert.equal(git(browserProjectPath, 'rev-parse', 'HEAD').trim(), headBefore, 'the wrap must not have created a commit');
    const statusLine2 = git(browserProjectPath, 'status', '--porcelain', '--', BROWSER_SESSION_FILE);
    assert.match(statusLine2, /^ M /, `${BROWSER_SESSION_FILE}'s session edit must remain uncommitted on disk`);
  });
});
