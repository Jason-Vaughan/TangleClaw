'use strict';

/**
 * The `tc` in-pane CLI vertical slice (ambient-awareness Chunk 02).
 *
 * The architecture under test, end to end: TangleClaw injects PATH + identity
 * env into every launched pane; a dependency-free `bin/tc` asks the server
 * `GET /api/tc/whoami`; the GET itself records an awareness receipt, so "this
 * session never became aware" is a detectable state instead of a silent one.
 * Failure honesty is load-bearing throughout: a pane without the env, a dead
 * server, and a disabled capability must all SAY SO — an agent that cannot
 * discover it lacks a tool will improvise one (the fabrication that opened
 * the plan).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile, spawnSync } = require('node:child_process');

/**
 * Run bin/tc asynchronously. The in-process test server answers on THIS event
 * loop, so a sync spawn would deadlock: the child waits on the server while
 * the server waits on the loop the sync wait is blocking.
 * @param {string[]} args
 * @param {object} env
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runTc(args, env) {
  return new Promise((resolve) => {
    execFile(TC_BIN, args, { env, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const { createServer } = require('../server');

const TC_BIN = path.join(__dirname, '..', 'bin', 'tc');

/** Same request helper shape as the other api-*.test.js files. */
function request(server, method, urlPath) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('tc CLI vertical slice (ambient-awareness Chunk 02)', () => {
  let tmpDir;
  let server;
  let project;
  let apiOrigin;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cli-'));
    store._setBasePath(tmpDir);
    store.init();
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    const projDir = path.join(projectsDir, 'tc-cli-proj');
    fs.mkdirSync(projDir, { recursive: true });
    project = store.projects.create({ name: 'tc-cli-proj', path: projDir, engine: 'antigravity' });

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiOrigin = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/tc/whoami', () => {
    it('answers identity + capabilities and records the receipt in the same call', async () => {
      const res = await request(server, 'GET', `/api/tc/whoami?projectId=${project.id}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.project, { id: project.id, name: 'tc-cli-proj' });
      assert.match(res.body.api.origin, /^https?:\/\/localhost:\d+$/);
      assert.ok(res.body.operator.host, 'the operator host is reported');
      assert.notEqual(res.body.operator.host, 'localhost', 'operator links never use localhost');
      assert.equal(res.body.receiptRecorded, true);

      const receipts = store.awarenessReceipts.listForProject(project.id);
      assert.equal(receipts.length, 1, 'the GET itself is the receipt');
      assert.equal(receipts[0].verb, 'whoami');
    });

    it('reports capability ABSENCE honestly: a non-opted-in switchboard says you cannot message', async () => {
      const res = await request(server, 'GET', `/api/tc/whoami?projectId=${project.id}`);
      const sb = res.body.capabilities.find((c) => c.id === 'switchboard');
      assert.equal(sb.enabled, false);
      assert.match(sb.detail, /CANNOT message/i, 'absence is stated, not omitted');
      assert.match(sb.detail, /rather than improvising/,
        'the anti-fabrication instruction rides the absence');
    });

    it('an unresolvable project still records a receipt — the signal is "the CLI was invoked at all"', async () => {
      const before2 = store.awarenessReceipts.listForProject(project.id).length;
      const res = await request(server, 'GET', '/api/tc/whoami?projectId=999999');
      assert.equal(res.status, 200);
      assert.equal(res.body.project, null);
      assert.match(res.body.unresolved, /did not resolve/);
      // Receipt recorded with a null project — count it via a direct query.
      const row = store.getDb().prepare(
        "SELECT COUNT(*) AS n FROM awareness_receipts WHERE project_id IS NULL AND verb = 'whoami'"
      ).get();
      assert.ok(row.n >= 1, 'the invocation itself is recorded even when identity fails');
      assert.equal(store.awarenessReceipts.listForProject(project.id).length, before2,
        'and it is not misattributed to a real project');
    });

    it('still answers when the receipt write fails — loud in the log, honest in the body', async () => {
      // The receipt is the point of the endpoint, but the caller still
      // deserves its identity: a broken ledger must not turn whoami into a
      // 500, and the body must not claim a receipt that was not written.
      const original = store.awarenessReceipts.record;
      store.awarenessReceipts.record = () => { throw new Error('ledger on fire'); };
      try {
        const res = await request(server, 'GET', `/api/tc/whoami?projectId=${project.id}`);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.project, { id: project.id, name: 'tc-cli-proj' });
        assert.equal(res.body.receiptRecorded, false, 'the body does not fabricate a receipt');
      } finally {
        store.awarenessReceipts.record = original;
      }
    });

    it('never leaks the M2M service token, even when the gate is enabled', async () => {
      const config = store.config.load();
      const prevEnabled = config.serviceTokenEnabled;
      const prevToken = config.serviceToken;
      config.serviceTokenEnabled = true;
      config.serviceToken = 'tc_live_secret_881122';
      store.config.save(config);
      try {
        const res = await request(server, 'GET', `/api/tc/whoami?projectId=${project.id}`);
        assert.ok(!JSON.stringify(res.body).includes('tc_live_secret_881122'),
          'whoami is identity, not a credential dispenser');
      } finally {
        const restore = store.config.load();
        restore.serviceTokenEnabled = prevEnabled;
        restore.serviceToken = prevToken;
        store.config.save(restore);
      }
    });
  });

  describe('bin/tc (spawned for real)', () => {
    it('whoami renders identity and capabilities from a live server', async () => {
      const res = await runTc(['whoami'], {
        ...process.env,
        TANGLECLAW_API: apiOrigin,
        TANGLECLAW_PROJECT_ID: String(project.id),
        TANGLECLAW_WORKSPACE_ID: 'ws-test-1'
      });
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /TangleClaw-managed session of project "tc-cli-proj"/);
      assert.match(res.stdout, new RegExp(`numeric project id ${project.id}`));
      assert.match(res.stdout, /Capabilities:/);
      assert.match(res.stdout, /\[--\] switchboard/, 'a disabled capability renders as absent, not missing');
    });

    it('fails LOUDLY with no TangleClaw environment (exit 1, says what is missing)', () => {
      const res = spawnSync(TC_BIN, ['whoami'], {
        env: { PATH: process.env.PATH }, encoding: 'utf8'
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /TANGLECLAW_API is not set/);
      assert.match(res.stderr, /not launched under TangleClaw/);
    });

    it('fails LOUDLY when the server is unreachable (exit 2, names the URL, warns against improvising)', () => {
      const res = spawnSync(TC_BIN, ['whoami'], {
        env: { PATH: process.env.PATH, TANGLECLAW_API: 'http://127.0.0.1:1', TANGLECLAW_PROJECT_ID: '1' },
        encoding: 'utf8'
      });
      assert.equal(res.status, 2);
      assert.match(res.stderr, /could not reach the TangleClaw API at http:\/\/127\.0\.0\.1:1\/api\/tc\/whoami/);
      assert.match(res.stderr, /say so instead of improvising/);
    });

    it('an unknown verb exits 1 with usage', () => {
      const res = spawnSync(TC_BIN, ['frobnicate'], {
        env: { PATH: process.env.PATH, TANGLECLAW_API: apiOrigin }, encoding: 'utf8'
      });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /unknown verb 'frobnicate'/);
      assert.match(res.stderr, /usage: tc/);
    });
  });

  describe('receipt provenance — a browser cannot fabricate awareness', () => {
    it('a plain GET records source=http; the tc client records source=tc-cli', async () => {
      await request(server, 'GET', `/api/tc/whoami?projectId=${project.id}`);
      const plain = store.awarenessReceipts.listForProject(project.id)[0];
      assert.equal(plain.source, 'http',
        'an operator opening the endpoint in a browser is not the session becoming aware');

      const res = await runTc(['whoami'], {
        ...process.env, TANGLECLAW_API: apiOrigin, TANGLECLAW_PROJECT_ID: String(project.id)
      });
      assert.equal(res.code, 0, res.stderr);
      const viaCli = store.awarenessReceipts.listForProject(project.id)[0];
      assert.equal(viaCli.source, 'tc-cli', 'the CLI identifies itself, and the row says so');
    });

    it('the store refuses an unknown source', () => {
      assert.throws(() => store.awarenessReceipts.record({ verb: 'whoami', source: 'trust-me' }),
        /source must be one of/);
    });
  });

  describe('awareness receipts store', () => {
    it('requires a verb and round-trips nullable ids', () => {
      assert.throws(() => store.awarenessReceipts.record({}), /verb is required/);
      const r = store.awarenessReceipts.record({ verb: 'whoami', workspaceId: 'ws-x' });
      assert.equal(r.projectId, null);
      assert.equal(r.sessionId, null);
      assert.equal(r.workspaceId, 'ws-x');
    });

    it('lists per session oldest-first', () => {
      store.awarenessReceipts.record({ verb: 'whoami', sessionId: 4242 });
      store.awarenessReceipts.record({ verb: 'whoami', sessionId: 4242 });
      const rows = store.awarenessReceipts.listForSession(4242);
      assert.equal(rows.length, 2);
      assert.ok(rows[0].id < rows[1].id);
    });

    it('prunes per project to the retention cap — a recorded lifecycle, not an accidental keep-forever', () => {
      store._setAwarenessReceiptRetention(3);
      try {
        for (let i = 0; i < 7; i++) {
          store.awarenessReceipts.record({ verb: 'whoami', projectId: 77770, workspaceId: `w${i}` });
        }
        const rows = store.awarenessReceipts.listForProject(77770, { limit: 100 });
        assert.equal(rows.length, 3, 'oldest rows beyond the cap are pruned');
        assert.equal(rows[0].workspaceId, 'w6', 'the newest survives');
      } finally {
        store._setAwarenessReceiptRetention(200);
      }
    });
  });
});

describe('launch env injection — the pane gets tc on PATH (ambient-awareness Chunk 02)', () => {
  let tmpDir;
  let projectsDir;
  let sessions;
  const _restores = [];
  function stub(obj, key, value) {
    _restores.push([obj, key, Object.getOwnPropertyDescriptor(obj, key)]);
    obj[key] = value;
  }

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-env-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    sessions = require('../lib/sessions');
  });

  after(() => {
    while (_restores.length) {
      const [obj, key, d] = _restores.pop();
      if (d) Object.defineProperty(obj, key, d); else delete obj[key];
    }
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the launch command re-asserts the PATH floor AFTER rc processing — the env prepend alone gets rebuilt away (#1140)', () => {
    // Probe-verified on the live host: tmux runs the launch command through
    // the user's shell, whose rc processing (macOS path_helper + user rc)
    // rebuilds PATH before the command body runs. The -e env prepend was
    // stripped from every pane and `which tc` failed fleet-wide, so no
    // session could ever earn a confirmed receipt. The export embedded in
    // the command body executes after the rc files and survives.
    const tmux = require('../lib/tmux');
    const enginesModule = require('../lib/engines');
    let created = false;
    let capturedCommand = null;
    stub(tmux, 'hasSession', () => created);
    stub(tmux, 'probeSession', () => ({ live: created, answered: true, cause: null }));
    stub(tmux, 'createSession', (name, options) => {
      capturedCommand = options.command;
      created = true;
      return true;
    });
    stub(tmux, 'sendKeys', () => true);
    stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));

    const projDir = path.join(projectsDir, 'floor-proj');
    fs.mkdirSync(projDir, { recursive: true });
    const project = store.projects.create({ name: 'floor-proj', path: projDir, engine: 'claude' });
    try {
      const result = sessions.launchSession('floor-proj');
      assert.equal(result.error, null);
      const binDir = path.join(__dirname, '..', 'bin');
      assert.ok(capturedCommand.startsWith(`export PATH="${binDir}:$PATH"; `),
        'the command body opens by re-prepending tc\'s bin dir');
      assert.ok(capturedCommand.length > `export PATH="${binDir}:$PATH"; `.length,
        'the engine launch command follows the export — the wrapper never swallows it');
      store.sessions.kill(result.session.id, 'test cleanup');
    } finally {
      store.projects.delete(project.id);
    }
  });

  it('_withPathFloor degrades honestly: no command passes through, an unsafe bin dir refuses the wrapper', () => {
    // No command (bare interactive pane): nothing to ride — the env prepend
    // is the only floor, unchanged.
    assert.equal(sessions._withPathFloor(undefined), undefined);
    assert.equal(sessions._withPathFloor(''), '');
    // The real bin dir is safe, so the wrapper applies.
    assert.match(sessions._withPathFloor('claude --json'), /^export PATH="[^"]+\/bin:\$PATH"; claude --json$/);
    // A bin dir that could break out of the double quotes refuses the wrapper
    // rather than composing a broken (or injectable) command — the raw launch
    // command survives untouched.
    for (const evil of ['/tmp/a"b/bin', '/tmp/a`b/bin', '/tmp/a$b/bin', '/tmp/a\\b/bin']) {
      assert.equal(sessions._withPathFloor('claude --json', evil), 'claude --json');
    }
  });

  it('launchSession injects PATH + TANGLECLAW_* into the tmux pane env; profile env wins on collision', () => {
    const tmux = require('../lib/tmux');
    const enginesModule = require('../lib/engines');
    let created = false;
    let capturedEnv = null;
    stub(tmux, 'hasSession', () => created);
    stub(tmux, 'probeSession', () => ({ live: created, answered: true, cause: null }));
    stub(tmux, 'createSession', (name, options) => {
      capturedEnv = options.env;
      created = true;
      return true;
    });
    stub(tmux, 'sendKeys', () => true);
    stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));

    const projDir = path.join(projectsDir, 'env-proj');
    fs.mkdirSync(projDir, { recursive: true });
    const project = store.projects.create({ name: 'env-proj', path: projDir, engine: 'claude' });

    try {
      const result = sessions.launchSession('env-proj');
      assert.equal(result.error, null);
      assert.ok(capturedEnv, 'the pane env reached tmux.createSession');
      const binDir = path.join(__dirname, '..', 'bin');
      assert.ok(capturedEnv.PATH.startsWith(`${binDir}:`),
        'tc\'s bin dir is PREPENDED to the pane PATH');
      assert.ok(capturedEnv.PATH.includes(process.env.PATH),
        'the existing PATH survives after the prepend');
      assert.match(capturedEnv.TANGLECLAW_API, /^https?:\/\/localhost:\d+$/);
      assert.equal(capturedEnv.TANGLECLAW_PROJECT_ID, String(project.id));
      assert.equal(capturedEnv.TANGLECLAW_WORKSPACE_ID, undefined,
        'no workspace id is claimed when none was minted — absence stays honest');

      store.sessions.kill(result.session.id, 'test cleanup');
    } finally {
      store.projects.delete(project.id);
    }
  });

  it('an unresolvable API origin OMITS TANGLECLAW_API — never a sentence-shaped URL', () => {
    // The origin resolver used to return English prose on failure, written for
    // prime text; fed into the pane env it would send tc fetching a
    // sentence-shaped URL and misdirect the diagnosis. Absence is the honest
    // failure: tc reports a missing TANGLECLAW_API loudly.
    const tmux = require('../lib/tmux');
    const enginesModule = require('../lib/engines');
    const httpsSetup = require('../lib/https-setup');
    let created = false;
    let capturedEnv = null;
    stub(tmux, 'hasSession', () => created);
    stub(tmux, 'probeSession', () => ({ live: created, answered: true, cause: null }));
    stub(tmux, 'createSession', (name, options) => { capturedEnv = options.env; created = true; return true; });
    stub(tmux, 'sendKeys', () => true);
    stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }));
    stub(httpsSetup, 'effectiveServerProtocol', () => { throw new Error('config unreadable'); });

    const projDir = path.join(projectsDir, 'no-origin-proj');
    fs.mkdirSync(projDir, { recursive: true });
    const project = store.projects.create({ name: 'no-origin-proj', path: projDir, engine: 'claude' });
    try {
      const result = sessions.launchSession('no-origin-proj');
      assert.equal(result.error, null);
      assert.equal(capturedEnv.TANGLECLAW_API, undefined,
        'no origin → no var; tc will say the pane was not launched under TangleClaw');
      assert.equal(capturedEnv.TANGLECLAW_PROJECT_ID, String(project.id),
        'the identity that IS known still ships');
      store.sessions.kill(result.session.id, 'test cleanup');
    } finally {
      store.projects.delete(project.id);
    }
  });
});
