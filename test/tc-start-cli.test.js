'use strict';

/**
 * The `tc start` slice (Train 21, car 21.3): the two routes, the verb that
 * drives them, and what a pane actually sees.
 *
 * The CLI half matters as much as the protocol: a step the agent cannot
 * acknowledge from what was printed is a step that never gets acknowledged, so
 * the printed page is asserted here, not only the JSON behind it.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const tcVerbs = require('../lib/tc-verbs');
const launchSequence = require('../lib/launch-sequence');
const { createServer } = require('../server');

const TC_BIN = path.join(__dirname, '..', 'bin', 'tc');

/**
 * Run `bin/tc` against the in-process server. Async, like `test/tc-cli.test.js`:
 * a sync spawn would deadlock on the event loop the server answers from.
 * @param {string[]} args - Arguments after `tc`
 * @param {object} env - The pane environment
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runTc(args, env) {
  return new Promise((resolve) => {
    execFile(TC_BIN, args, { env, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

/**
 * One JSON request against the test server.
 * @param {object} server - The listening server
 * @param {string} method - HTTP method
 * @param {string} urlPath - Path
 * @param {object} [headers] - Request headers
 * @param {object} [body] - JSON body
 * @returns {Promise<{status: number, body: object|null}>}
 */
function request(server, method, urlPath, headers = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method,
      headers: payload ? { ...headers, 'content-type': 'application/json' } : headers
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('tc start (car 21.3)', () => {
  let tmpDir;
  let server;
  let apiOrigin;
  let project;
  let sequence;
  let paneEnv;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-start-'));
    store._setBasePath(tmpDir);
    store.init();
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    const dir = path.join(projectsDir, 'start-project');
    fs.mkdirSync(dir, { recursive: true });
    project = store.projects.create({ name: 'start-project', path: dir, engine: 'claude' });
    store.sessionRules.create({ projectId: project.id, content: 'A rule the pulled governance step carries.' });

    // Bind a sequence the way a launch does, without starting a pane.
    const sessions = require('../lib/sessions');
    const engine = store.engines.get('claude');
    const launchId = launchSequence.mintLaunchId();
    const rendered = sessions.renderLaunchSteps(project, engine, { operatorHost: 'operator.example.test' });
    const snapshot = launchSequence.buildSnapshot({
      launchId,
      project,
      engineProfile: engine,
      applicability: { applicable: true, reason: null },
      rendered,
      rules: store.sessionRules.listActiveForProject(project.id)
    });
    const session = store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });
    sequence = store.launchSequences.getBySession(session.id);

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiOrigin = `http://127.0.0.1:${server.address().port}`;
    paneEnv = {
      PATH: process.env.PATH,
      TANGLECLAW_API: apiOrigin,
      TANGLECLAW_PROJECT_ID: String(project.id),
      TANGLECLAW_LAUNCH_ID: sequence.launchId
    };
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The headers a launched pane's tc sends. */
  const paneHeaders = () => ({
    'x-tangleclaw-cli': 'tc',
    'x-tangleclaw-verb': 'start.next',
    'x-tangleclaw-project-id': String(project.id),
    'x-tangleclaw-launch-id': sequence.launchId
  });

  it('GET /api/tc/start/status answers the pane that has a sequence', async () => {
    const res = await request(server, 'GET', '/api/tc/start/status', paneHeaders());
    assert.equal(res.status, 200);
    assert.equal(res.body.sequence, 'present');
    assert.equal(res.body.sequenceId, sequence.id);
    assert.equal(res.body.steps.length, 4);
  });

  it('GET /api/tc/start/status tells a pane with no launch id that it has none', async () => {
    const res = await request(server, 'GET', '/api/tc/start/status', { 'x-tangleclaw-project-id': String(project.id) });
    assert.equal(res.status, 200);
    assert.equal(res.body.sequence, 'none');
  });

  it('POST /api/tc/start/next serves a step and refuses a pane with no launch id', async () => {
    const served = await request(server, 'POST', '/api/tc/start/next', paneHeaders(), {});
    assert.equal(served.status, 200);
    assert.equal(served.body.step.id, 'identity');

    const legacy = await request(server, 'POST', '/api/tc/start/next',
      { 'x-tangleclaw-project-id': String(project.id) }, {});
    assert.equal(legacy.status, 409);
    assert.equal(legacy.body.code, 'LAUNCH_ID_REQUIRED');
  });

  it('the refusal body carries the code and the retry hint a client branches on', async () => {
    const unbound = await request(server, 'POST', '/api/tc/start/next', {
      ...paneHeaders(), 'x-tangleclaw-launch-id': launchSequence.mintLaunchId()
    }, {});
    assert.equal(unbound.status, 409);
    assert.equal(unbound.body.code, 'LAUNCH_NOT_BOUND');
    assert.equal(unbound.body.retryAfterMs, launchSequence.NOT_BOUND_RETRY_MS);
  });

  it('records one awareness receipt per invocation, labelled by subverb', async () => {
    store.getDb().prepare('DELETE FROM awareness_receipts').run();
    await request(server, 'POST', '/api/tc/start/next', paneHeaders(), {});
    const rows = store.getDb().prepare("SELECT verb, source FROM awareness_receipts WHERE verb LIKE 'start.%'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verb, 'start.next');
    assert.equal(rows[0].source, 'tc-cli');
    assert.equal(tcVerbs.receiptVerbLabel('start', ['status']), 'start.status');
  });

  it('a spawned tc prints a page an agent can act on, and acknowledges it', async () => {
    const served = await runTc(['start', 'next'], paneEnv);
    assert.equal(served.code, 0, served.stderr);
    assert.match(served.stdout, /# Session Start — start-project/);
    assert.match(served.stdout, /\[tc start · step 1\/4 identity · page \d+\/\d+ · revision 1\]/);

    const command = /tc start next --ack (\S+)/.exec(served.stdout);
    assert.ok(command, 'the page prints the exact command to acknowledge it');
    const acked = await runTc(['start', 'next', '--ack', command[1]], paneEnv);
    assert.equal(acked.code, 0, acked.stderr);
    assert.match(acked.stdout, /step 2\/4 governance/);
    assert.equal(store.launchSequences.getByLaunchId(sequence.launchId).cursor, 1);
  });

  it('a spawned tc relays a refusal with its code instead of inventing success', async () => {
    const wrong = await runTc(['start', 'next', '--ack', 'governance:1:ffffffffffffffff'], paneEnv);
    assert.equal(wrong.code, 2);
    assert.match(wrong.stderr, /ACK_DIGEST_MISMATCH/);
    assert.match(wrong.stderr, /Do not assume/);
  });

  it('a spawned tc renders status, and refuses bad arguments locally', async () => {
    const status = await runTc(['start', 'status'], paneEnv);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /Launch sequence \d+ .*acknowledged/);
    assert.match(status.stdout, /Preflight: not-evaluated/);
    // The disclosure three records promise, asserted where the reader meets it:
    // drop it from the payload or the renderer and this goes red.
    assert.match(status.stdout, /Pages are sized to \d+ characters, against this engine's measured \d+-character tool-output limit\./);
    assert.match(status.stdout, /Not in this version: ready, unready, recovery/);

    for (const args of [['start'], ['start', 'sideways'], ['start', 'next', '--ack', 'nope'], ['start', 'next', '--page', 'x']]) {
      const bad = await runTc(args, paneEnv);
      assert.equal(bad.code, 1, `${args.join(' ')} is a usage error`);
      assert.match(bad.stderr, /usage: tc start/);
    }
  });

  it('prints an ASSUMED limit as assumed, which is the case codex, aider and antigravity are in', () => {
    // Rendered directly: the assumed branch belongs to engines that declare no
    // measurement, and the printed sentence is what tells a session its pages
    // rest on a guess. Asserting only the response body would leave the pane
    // silent while the suite stayed green.
    const printed = tcVerbs.renderStartStatus({
      sequence: 'present',
      sessionId: 7,
      sequenceId: 3,
      revision: 1,
      applicability: 'applicable',
      preflight: { verdict: 'not-evaluated' },
      pageBudget: 7800,
      toolOutput: { maxChars: 8000, measured: false, reason: 'the engine declares no measured tool-output limit, so 8000 characters is assumed' },
      pending: { stages: ['ready', 'unready', 'recovery'], reason: 'later versions' },
      status: { cursor: 0, ready: false, recovery: 'none', unready: false },
      steps: [{ index: 0, id: 'identity', pageCount: 1, pagesServed: [], servedAt: null, ackedAt: null }]
    });
    assert.match(printed, /against an ASSUMED 8000-character tool-output limit/);
    assert.match(printed, /no measured tool-output limit/);
    assert.match(printed, /If a page arrives cut short, say so rather than guessing/);
    assert.ok(!printed.includes('measured 8000'), 'an assumed limit is never presented as measured');
  });

  it('a pane with no launch id is told it has no sequence rather than refused', async () => {
    const { TANGLECLAW_LAUNCH_ID: _dropped, ...legacyEnv } = paneEnv;
    const status = await runTc(['start', 'status'], legacyEnv);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /No launch sequence/);

    const next = await runTc(['start', 'next'], legacyEnv);
    assert.equal(next.code, 2);
    assert.match(next.stderr, /LAUNCH_ID_REQUIRED/);
  });

  it('retries only an unbound launch, then reports LAUNCH_UNKNOWN rather than hanging', async () => {
    const waited = [];
    const attempts = [];
    const notBound = () => {
      const err = new Error('409');
      err.code = 'LAUNCH_NOT_BOUND';
      err.body = { code: 'LAUNCH_NOT_BOUND', retryAfterMs: 1000 };
      return err;
    };
    // A clock the test owns, so the retry window is exercised exactly rather
    // than waited out: each sleep advances it by what the server asked for.
    let clock = 1_000_000;
    const ctx = {
      argv: ['next'],
      env: {},
      now: () => clock,
      sleep: (ms) => { waited.push(ms); clock += ms; return Promise.resolve(); },
      postJson: () => { attempts.push('post'); return Promise.reject(notBound()); },
      getJson: () => Promise.reject(notBound())
    };
    await assert.rejects(() => tcVerbs.VERB_ROSTER.find((v) => v.id === 'start').run(ctx), (err) => {
      assert.equal(err.code, 'LAUNCH_UNKNOWN');
      assert.match(err.message, /still not recorded/);
      return true;
    });
    assert.ok(attempts.length > 1, 'it retried');
    assert.ok(waited.every((ms) => ms === 1000), "it honours the server's retry hint");
    assert.equal(waited.reduce((a, b) => a + b, 0), tcVerbs.LAUNCH_BIND_WAIT_MS,
      'it uses the whole window and never sleeps past it');
  });

  it('does not retry a refusal that will not resolve by itself', async () => {
    let calls = 0;
    const ctx = {
      argv: ['next'],
      env: {},
      sleep: () => Promise.reject(new Error('must not sleep')),
      postJson: () => {
        calls++;
        const err = new Error('409');
        err.code = 'SEQUENCE_SESSION_MISMATCH';
        err.body = { code: 'SEQUENCE_SESSION_MISMATCH' };
        return Promise.reject(err);
      }
    };
    await assert.rejects(() => tcVerbs.VERB_ROSTER.find((v) => v.id === 'start').run(ctx),
      (err) => err.code === 'SEQUENCE_SESSION_MISMATCH');
    assert.equal(calls, 1);
  });
});
