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
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');
const wrapRunRegistry = require('../lib/wrap-run-registry');
const { operatorHeaders } = require('./_shared-docs-callers');

/** Every `kind: "ai-content"` step in the default pipeline (#2588's scenario needs none of them). */
const SKIP_AI_CONTENT = Object.freeze({
  'changelog-update': true,
  'release-recommendation': true,
  'learnings-capture': true,
  'memory-update': true
});

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

  let tmpDir;
  let server;
  let projectPath;
  let projectId;

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
});
