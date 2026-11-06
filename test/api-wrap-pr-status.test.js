'use strict';

/*
 * #638 — HTTP-level tests for GET /api/sessions/:project/wrap/pr-status, the
 * read-only probe that resolves a wrap PR's live merge outcome after the
 * pipeline returns, so a blocked release never renders as success. `gh` is
 * stubbed via `wrap-pr-status._internal.exec`; the harness mirrors
 * api-wrap-status.test.js (real server, isolated store).
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');
const prStatus = require('../lib/wrap-pr-status');
const wrapRoutes = require('../lib/routes/wrap');
const { operatorHeaders, sendAs } = require('./_shared-docs-callers');

function request(server, method, urlPath) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('api GET /wrap/pr-status (#638)', () => {
  let tmpDir;
  let server;
  const savedExec = prStatus._internal.exec;
  // #2886 — the docs-parity probe this route also runs makes its OWN `gh pr
  // view` call, through its own seam, never through prStatus's: stubbed here
  // too so no test in this file reaches real `gh`. Default answers "no
  // files, no body", which `docsParityGate.evaluate` reads as `signal:
  // false` (no user-facing file touched) — the least surprising default for
  // a test that isn't about docs-parity at all.
  const savedExecGh = wrapRoutes._internal.execGh;
  const noDocsSignalStub = async () => ({ exitCode: 0, stdout: JSON.stringify({ files: [], body: '' }), stderr: '' });

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-prstatus-'));
    store._setBasePath(tmpDir);
    store.init();
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    const projDir = path.join(projectsDir, 'prstatus-test');
    fs.mkdirSync(projDir, { recursive: true });
    store.projects.create({ name: 'prstatus-test', path: projDir, engine: 'claude' });
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    prStatus._internal.exec = savedExec;
    wrapRoutes._internal.execGh = savedExecGh;
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => { prStatus._internal.exec = savedExec; wrapRoutes._internal.execGh = noDocsSignalStub; });
  afterEach(() => { prStatus._internal.exec = savedExec; wrapRoutes._internal.execGh = savedExecGh; });

  it('400 when the url query param is missing', async () => {
    const res = await request(server, 'GET', '/api/sessions/prstatus-test/wrap/pr-status');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'BAD_REQUEST');
  });

  it('resolves a MERGED PR to outcome merged', async () => {
    prStatus._internal.exec = async () => ({ exitCode: 0, stdout: JSON.stringify({ state: 'MERGED', url: 'u' }), stderr: '' });
    const url = encodeURIComponent('https://github.com/o/r/pull/12');
    const res = await request(server, 'GET', `/api/sessions/prstatus-test/wrap/pr-status?url=${url}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'merged');
    assert.equal(res.body.project, 'prstatus-test');
  });

  it('resolves an OPEN+BLOCKED PR with a FAILED check to outcome blocked (the #636 case)', async () => {
    const rollup = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
    prStatus._internal.exec = async () => ({ exitCode: 0, stdout: JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BLOCKED', statusCheckRollup: rollup }), stderr: '' });
    const res = await request(server, 'GET', '/api/sessions/prstatus-test/wrap/pr-status?url=7');
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'blocked');
  });

  it('#686: resolves an OPEN+BLOCKED PR whose check is still RUNNING to outcome pending', async () => {
    const rollup = [{ status: 'IN_PROGRESS', conclusion: null }];
    prStatus._internal.exec = async () => ({ exitCode: 0, stdout: JSON.stringify({ state: 'OPEN', mergeStateStatus: 'BLOCKED', statusCheckRollup: rollup }), stderr: '' });
    const res = await request(server, 'GET', '/api/sessions/prstatus-test/wrap/pr-status?url=7');
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'pending');
  });

  it('an invalid PR ref resolves to unknown WITHOUT invoking gh', async () => {
    let called = false;
    prStatus._internal.exec = async () => { called = true; return { exitCode: 0, stdout: '{}', stderr: '' }; };
    const res = await request(server, 'GET', '/api/sessions/prstatus-test/wrap/pr-status?url=--json');
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'unknown');
    assert.equal(called, false);
  });

  it('an unknown project resolves to unknown, not a 500', async () => {
    const res = await request(server, 'GET', '/api/sessions/does-not-exist/wrap/pr-status?url=9');
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome, 'unknown');
    assert.match(res.body.reason, /not found/);
    // #2886 — an unknown project can't be read for docs-parity either; null,
    // not a thrown error, and no attempt (asserted in the next test's own
    // shape) to call gh a second time for a project that does not exist.
    assert.equal(res.body.docsParity, null);
  });

  describe('docsParity (#2886, riding on the same probe)', () => {
    it('attaches a fired verdict when the PR touches a route with no docs touch or escape line', async () => {
      prStatus._internal.exec = async () => ({ exitCode: 0, stdout: JSON.stringify({ state: 'MERGED', url: 'u' }), stderr: '' });
      wrapRoutes._internal.execGh = async () => ({
        exitCode: 0, stdout: JSON.stringify({ files: [{ path: 'server.js' }], body: 'no docs line here' }), stderr: ''
      });
      const url = encodeURIComponent('https://github.com/o/r/pull/12');
      const res = await request(server, 'GET', `/api/sessions/prstatus-test/wrap/pr-status?url=${url}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.docsParity.signal, true);
      assert.deepEqual(res.body.docsParity.userFacingFiles, ['server.js']);
    });

    it('attaches a clear verdict when the PR body carries the Docs: none escape line', async () => {
      wrapRoutes._internal.execGh = async () => ({
        exitCode: 0, stdout: JSON.stringify({ files: [{ path: 'public/ui.js' }], body: 'Docs: none nothing operator-visible changed' }), stderr: ''
      });
      const res = await request(server, 'GET', '/api/sessions/prstatus-test/wrap/pr-status?url=7');
      assert.equal(res.status, 200);
      assert.equal(res.body.docsParity.signal, false);
      assert.match(res.body.docsParity.reason, /escaped: Docs: none/);
    });

    it('is null when gh cannot answer, and never throws through the route', async () => {
      wrapRoutes._internal.execGh = async () => ({ exitCode: 1, stdout: '', stderr: 'gh: not authenticated' });
      const res = await request(server, 'GET', '/api/sessions/prstatus-test/wrap/pr-status?url=7');
      assert.equal(res.status, 200);
      assert.equal(res.body.docsParity, null);
    });

    it('is null, and gh is never invoked, for an invalid PR ref', async () => {
      let called = false;
      wrapRoutes._internal.execGh = async () => { called = true; return { exitCode: 0, stdout: '{}', stderr: '' }; };
      const res = await request(server, 'GET', '/api/sessions/prstatus-test/wrap/pr-status?url=--json');
      assert.equal(res.status, 200);
      assert.equal(res.body.docsParity, null);
      assert.equal(called, false);
    });
  });

  describe('POST /wrap/docs-parity/dismiss (#2886)', () => {
    it('refuses an unidentified caller (no operator/launch binding)', async () => {
      const res = await request(server, 'POST', '/api/sessions/prstatus-test/wrap/docs-parity/dismiss');
      assert.equal(res.status, 403);
    });

    it('400 when url is missing', async () => {
      const res = await sendAs(server, 'POST', '/api/sessions/prstatus-test/wrap/docs-parity/dismiss',
        { reason: 'internal only' }, operatorHeaders(server));
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'BAD_REQUEST');
    });

    it('404 for an unknown project', async () => {
      const res = await sendAs(server, 'POST', '/api/sessions/does-not-exist/wrap/docs-parity/dismiss',
        { url: '7', reason: 'x' }, operatorHeaders(server));
      assert.equal(res.status, 404);
    });

    it('400 NOT_SIGNALED when the PR has nothing to dismiss', async () => {
      wrapRoutes._internal.execGh = async () => ({
        exitCode: 0, stdout: JSON.stringify({ files: [], body: '' }), stderr: ''
      });
      const res = await sendAs(server, 'POST', '/api/sessions/prstatus-test/wrap/docs-parity/dismiss',
        { url: '7', reason: 'nothing fired' }, operatorHeaders(server));
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'NOT_SIGNALED');
    });

    it('400 INVALID_INPUT when reason is blank', async () => {
      wrapRoutes._internal.execGh = async () => ({
        exitCode: 0, stdout: JSON.stringify({ files: [{ path: 'server.js' }], body: '' }), stderr: ''
      });
      const res = await sendAs(server, 'POST', '/api/sessions/prstatus-test/wrap/docs-parity/dismiss',
        { url: '7', reason: '  ' }, operatorHeaders(server));
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'INVALID_INPUT');
    });

    it('502 when gh pr edit fails, after a successful dismiss computation', async () => {
      let editArgs = null;
      wrapRoutes._internal.execGh = async (args) => {
        if (args[1] === 'view') return { exitCode: 0, stdout: JSON.stringify({ files: [{ path: 'server.js' }], body: 'original body' }), stderr: '' };
        editArgs = args;
        return { exitCode: 1, stdout: '', stderr: 'gh: permission denied' };
      };
      const res = await sendAs(server, 'POST', '/api/sessions/prstatus-test/wrap/docs-parity/dismiss',
        { url: '7', reason: 'operator-verified, no user-facing change' }, operatorHeaders(server));
      assert.equal(res.status, 502);
      assert.ok(editArgs, 'gh pr edit must have been attempted');
      assert.equal(editArgs[1], 'edit');
    });

    it('dismisses a fired signal by appending the Docs: none escape line via gh pr edit', async () => {
      let editedBody = null;
      wrapRoutes._internal.execGh = async (args) => {
        if (args[1] === 'view') {
          return { exitCode: 0, stdout: JSON.stringify({ files: [{ path: 'server.js' }], body: 'Original PR description.' }), stderr: '' };
        }
        assert.equal(args[1], 'edit');
        assert.equal(args[0], 'pr');
        const bodyFlagIndex = args.indexOf('--body');
        editedBody = args[bodyFlagIndex + 1];
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      const res = await sendAs(server, 'POST', '/api/sessions/prstatus-test/wrap/docs-parity/dismiss',
        { url: '7', reason: 'operator-verified, no user-facing change' }, operatorHeaders(server));
      assert.equal(res.status, 200);
      assert.equal(res.data.dismissed, true);
      assert.equal(res.data.dismissedBy, 'operator');
      assert.equal(res.data.dismissedReason, 'operator-verified, no user-facing change');
      assert.match(editedBody, /Original PR description\./);
      assert.match(editedBody, /Docs: none operator-verified, no user-facing change/);
    });

    it('normalizes a reason with a leading newline to one line, so the escape line is never blank (I-Gate R1 Round 2)', async () => {
      let editedBody = null;
      wrapRoutes._internal.execGh = async (args) => {
        if (args[1] === 'view') {
          return { exitCode: 0, stdout: JSON.stringify({ files: [{ path: 'server.js' }], body: 'Original PR description.' }), stderr: '' };
        }
        const bodyFlagIndex = args.indexOf('--body');
        editedBody = args[bodyFlagIndex + 1];
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      const res = await sendAs(server, 'POST', '/api/sessions/prstatus-test/wrap/docs-parity/dismiss',
        { url: '7', reason: '\nWhy docs do not apply' }, operatorHeaders(server));
      assert.equal(res.status, 200);
      assert.equal(res.data.dismissed, true);
      assert.equal(res.data.dismissedReason, 'Why docs do not apply');
      // The whole trailer must be on ONE line: ESCAPE_LINE_RE is single-line
      // (`[^\n]*`), so a reason that split across two lines would leave the
      // first line reading "Docs: none " -- blank once trimmed, and
      // evaluate() would signal again on the very next probe.
      assert.match(editedBody, /^Docs: none Why docs do not apply$/m);
      assert.doesNotMatch(editedBody, /^Docs: none \s*$/m);

      // Prove it on the real function, not just this route: re-evaluating
      // the exact body this dismissal wrote must read signal: false.
      const docsParityGate = require('../lib/docs-parity-gate');
      const verdict = docsParityGate.evaluate(['server.js'], editedBody);
      assert.equal(verdict.signal, false);
    });
  });
});
