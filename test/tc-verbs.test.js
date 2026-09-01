'use strict';

/**
 * The `tc` verb surface + declared roster (ambient-awareness Chunk 03).
 *
 * Two layers under test. The roster (`lib/tc-verbs.js`): every verb is a
 * declared entry whose renderers report honest emptiness — an empty inbox,
 * an idle fleet, and a project with no rules each SAY SO in words, because a
 * surface that only ever describes success teaches an agent to invent one.
 * The server: one awareness receipt per invocation, recorded at the request
 * dispatcher from the CLI's provenance headers — verb-labeled, before the M2M
 * gate (a refused call still proves discovery), never doubled by the identity
 * side-fetch, and with the unresolved-project bucket pruned like every other.
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
const { createServer } = require('../server');
const {
  VERB_ROSTER,
  renderUsage,
  receiptVerbLabel,
  renderCapabilities,
  renderSessions,
  renderPorts,
  renderDocs,
  renderRules,
  renderLearnings,
  renderInbox
} = require('../lib/tc-verbs');

const TC_BIN = path.join(__dirname, '..', 'bin', 'tc');

/**
 * Run bin/tc asynchronously (a sync spawn would deadlock against the
 * in-process test server — same shape as test/tc-cli.test.js).
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

/**
 * One JSON request against the in-process server, with optional headers.
 * @param {object} server - Listening http server
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [headers]
 * @returns {Promise<{status: number, body: object|null}>}
 */
function request(server, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers },
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

/** Count receipts by verb via a direct query. */
function receiptCount(verb) {
  return store.getDb().prepare(
    'SELECT COUNT(*) AS n FROM awareness_receipts WHERE verb = ?'
  ).get(verb).n;
}

describe('tc verb roster (lib/tc-verbs)', () => {
  it('declares every planned verb, and usage renders from the roster alone', () => {
    const ids = VERB_ROSTER.map((v) => v.id);
    for (const expected of ['whoami', 'capabilities', 'sessions', 'message', 'ports', 'docs', 'rules', 'learnings']) {
      assert.ok(ids.includes(expected), `roster declares '${expected}'`);
    }
    const usage = renderUsage();
    for (const v of VERB_ROSTER) {
      assert.ok(usage.includes(v.usage), `usage lists ${v.id}`);
      assert.ok(v.summary && usage.includes(v.summary), `usage carries ${v.id}'s summary`);
      assert.equal(typeof v.run, 'function');
    }
  });

  it('labels message subverbs for the receipt ledger; other verbs pass through', () => {
    assert.equal(receiptVerbLabel('message', ['send', 'ws-1', 'hi']), 'message.send');
    assert.equal(receiptVerbLabel('message', ['read']), 'message.read');
    assert.equal(receiptVerbLabel('message', ['ack', '3']), 'message.ack');
    assert.equal(receiptVerbLabel('message', ['bogus']), 'message');
    assert.equal(receiptVerbLabel('ports', []), 'ports');
  });

  describe('renderers report honest emptiness — never blank output, never invented success', () => {
    it('sessions: an idle fleet says idle, a live one marks your own project', () => {
      assert.match(renderSessions({ sessions: [] }, {}), /No live TangleClaw sessions/);
      const out = renderSessions({
        sessions: [
          { id: 7, projectId: 3, projectName: 'other', engineId: 'claude', status: 'active', startedAt: 't1' },
          { id: 9, projectId: 5, projectName: 'mine', engineId: 'aider', status: 'wrapping', startedAt: 't2' }
        ]
      }, { TANGLECLAW_PROJECT_ID: '5' });
      assert.match(out, /2 live TangleClaw session\(s\)/);
      assert.match(out, /#9 mine — engine aider, wrapping.*← your project/);
      assert.ok(!/#7 other.*← your project/.test(out), 'only the caller\'s project is marked');
    });

    it('ports: empty names the registration route; leases render project + service', () => {
      assert.match(renderPorts({ leases: [] }), /No ports are currently leased/);
      const out = renderPorts({
        leases: [{ port: 3200, host: 'localhost', project: 'p1', service: 'dev', permanent: true }]
      });
      assert.match(out, /3200 — p1 \(dev\) \[permanent\]/);
    });

    it('docs / learnings: absence is an answer, presence lists the rows', () => {
      assert.match(renderDocs({ docs: [] }), /No shared documents are registered/);
      assert.match(
        renderDocs({ docs: [{ id: 1, name: 'NETWORK', groupId: 'g1', filePath: '/x/NETWORK.md' }] }),
        /NETWORK \(id 1, group g1\)/
      );
      assert.match(renderLearnings({ learnings: [] }), /No learnings are recorded/);
      assert.match(
        renderLearnings({ learnings: [{ tier: 2, confirmedCount: 3, content: 'grep is ugrep' }] }),
        /\[tier 2, seen 3×\] grep is ugrep/
      );
    });

    it('rules: review state is visible — a PROPOSED rule is shown but marked not in force', () => {
      assert.match(renderRules({ rules: [] }), /NO session rules/);
      const out = renderRules({
        rules: [
          { id: 1, kind: 'startup', status: 'active', enabled: 1, content: 'always X' },
          { id: 2, kind: 'wrap', status: 'proposed', enabled: 1, content: 'maybe Y' },
          { id: 3, kind: 'startup', status: 'active', enabled: 0, content: 'was Z' }
        ]
      });
      assert.match(out, /\[#1 startup — active\] always X/);
      assert.match(out, /\[#2 wrap — PROPOSED\] maybe Y/);
      assert.match(out, /\[#3 startup — active but DISABLED\] was Z/);
      assert.match(out, /PROPOSED rows await operator approval/);
    });

    it('inbox: reading is pure and says so — the ack instruction rides every non-empty read', () => {
      assert.match(renderInbox({ messages: [] }), /inbox is empty/);
      const out = renderInbox({ messages: [{ id: 'm1', from: 'ws-2', message: 'ping' }] });
      assert.match(out, /\[m1\] from ws-2: ping/);
      assert.match(out, /does NOT mark these handled/);
      assert.match(out, /tc message ack/);
    });

    it('capabilities: an empty server roster is stated as the server\'s answer', () => {
      assert.match(renderCapabilities({ capabilities: [] }), /NO capabilities/);
    });
  });

  describe('the message verb family fails loudly at every gate', () => {
    const noopCtx = { env: {}, argv: [], getJson: async () => { throw new Error('unexpected fetch'); }, postJson: async () => { throw new Error('unexpected fetch'); } };
    const message = VERB_ROSTER.find((v) => v.id === 'message');

    it('no subverb / bad subverb → exit 1 with usage', async () => {
      for (const argv of [[], ['bogus']]) {
        const res = await message.run({ ...noopCtx, argv });
        assert.equal(res.code, 1);
        assert.match(res.stderr, /usage: tc message/);
      }
    });

    it('send without recipient or text → exit 1 before any network call', async () => {
      const res = await message.run({ ...noopCtx, argv: ['send', 'ws-1'] });
      assert.equal(res.code, 1);
      assert.match(res.stderr, /needs a recipient and a message/);
    });

    it('unresolved identity → exit 2 telling the agent not to guess a project name', async () => {
      const ctx = {
        env: {}, argv: ['read'],
        getJson: async (p, opts) => {
          assert.ok(opts && opts.aux, 'the identity lookup marks itself auxiliary — one receipt per invocation');
          return { project: null, unresolved: 'projectId (absent) did not resolve' };
        },
        postJson: async () => { throw new Error('unexpected'); }
      };
      const res = await message.run(ctx);
      assert.equal(res.code, 2);
      assert.match(res.stderr, /did not resolve/);
      assert.match(res.stderr, /Do not guess a project name/);
    });

    it('send relays the server\'s honest status (queued/received), never a blanket "sent"', async () => {
      const calls = [];
      const ctx = {
        env: {}, argv: ['send', 'ws-2', 'hello', 'there'],
        getJson: async () => ({ project: { id: 1, name: 'proj a' } }),
        postJson: async (p, body) => { calls.push({ p, body }); return { status: 'queued' }; }
      };
      const res = await message.run(ctx);
      assert.equal(res.code, 0);
      assert.match(res.stdout, /queued/);
      assert.match(res.stdout, /you close it/i, 'the initiator-closes-the-loop convention rides the send');
      assert.equal(calls[0].p, '/api/sessions/proj%20a/medusa/send', 'the project name is resolved and URL-encoded, never guessed');
      assert.deepEqual(calls[0].body, { to: 'ws-2', message: 'hello there' });
    });

    it('a send the server refuses propagates the refusal — no invented success', async () => {
      const ctx = {
        env: {}, argv: ['send', 'nobody', 'hi'],
        getJson: async () => ({ project: { id: 1, name: 'p' } }),
        postJson: async () => { throw new Error('the TangleClaw API answered 502 — Unknown workspace: nobody'); }
      };
      await assert.rejects(() => ctx.postJson(), /Unknown workspace/);
      await assert.rejects(() => VERB_ROSTER.find((v) => v.id === 'message').run(ctx), /Unknown workspace/);
    });

    it('ack requires ids; with them it posts and reports the count', async () => {
      const message2 = VERB_ROSTER.find((v) => v.id === 'message');
      const bare = await message2.run({ ...noopCtx, argv: ['ack'] });
      assert.equal(bare.code, 1);
      const calls = [];
      const ok = await message2.run({
        env: {}, argv: ['ack', 'a', 'b'],
        getJson: async () => ({ project: { id: 1, name: 'p' } }),
        postJson: async (p, body) => { calls.push({ p, body }); return {}; }
      });
      assert.equal(ok.code, 0);
      assert.match(ok.stdout, /Marked 2 message\(s\) handled/);
      assert.deepEqual(calls[0].body, { ids: ['a', 'b'] });
    });
  });

  it('project-scoped verbs (rules, learnings) refuse to guess a missing project id', async () => {
    for (const id of ['rules', 'learnings']) {
      const verb = VERB_ROSTER.find((v) => v.id === id);
      const res = await verb.run({ env: {}, argv: [], getJson: async () => { throw new Error('unexpected fetch'); } });
      assert.equal(res.code, 1, `${id} exits 1 without TANGLECLAW_PROJECT_ID`);
      assert.match(res.stderr, /TANGLECLAW_PROJECT_ID is not set/);
    }
  });
});

describe('tc verb surface against a live server (ambient-awareness Chunk 03)', () => {
  let tmpDir;
  let server;
  let project;
  let apiOrigin;
  let paneEnv;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-verbs-'));
    store._setBasePath(tmpDir);
    store.init();
    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    const projDir = path.join(projectsDir, 'tc-verbs-proj');
    fs.mkdirSync(projDir, { recursive: true });
    project = store.projects.create({ name: 'tc-verbs-proj', path: projDir, engine: 'claude' });

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiOrigin = `http://127.0.0.1:${server.address().port}`;
    paneEnv = { PATH: process.env.PATH, TANGLECLAW_API: apiOrigin, TANGLECLAW_PROJECT_ID: String(project.id) };
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/tc/sessions', () => {
    it('answers the idle fleet honestly, then lists live sessions with resolved project names', async () => {
      const idle = await request(server, 'GET', '/api/tc/sessions');
      assert.equal(idle.status, 200);
      assert.deepEqual(idle.body.sessions, []);

      const s = store.sessions.start({ projectId: project.id, engineId: 'claude' });
      const live = await request(server, 'GET', '/api/tc/sessions');
      assert.equal(live.body.sessions.length, 1);
      assert.equal(live.body.sessions[0].id, s.id);
      assert.equal(live.body.sessions[0].projectName, 'tc-verbs-proj');
      assert.equal(live.body.sessions[0].status, 'active');
      store.sessions.kill(s.id, 'test teardown');
      const after2 = await request(server, 'GET', '/api/tc/sessions');
      assert.deepEqual(after2.body.sessions, [], 'an ended session leaves the live roster');
    });
  });

  describe('dispatcher-level awareness receipts — every verb records, exactly once', () => {
    it('a cli-identified, verb-labeled request to any API path records that verb', async () => {
      const beforeN = receiptCount('ports');
      const res = await request(server, 'GET', '/api/ports', {
        'x-tangleclaw-cli': 'tc',
        'x-tangleclaw-verb': 'ports',
        'x-tangleclaw-project-id': String(project.id)
      });
      assert.equal(res.status, 200);
      assert.equal(receiptCount('ports'), beforeN + 1);
      const row = store.getDb().prepare(
        "SELECT * FROM awareness_receipts WHERE verb = 'ports' ORDER BY id DESC LIMIT 1"
      ).get();
      assert.equal(row.source, 'tc-cli');
      assert.equal(row.project_id, project.id, 'the header-claimed project resolves like whoami\'s query param');
    });

    it('without the verb header nothing records — an auxiliary side-fetch is not an invocation', async () => {
      const beforeAll = store.getDb().prepare('SELECT COUNT(*) AS n FROM awareness_receipts').get().n;
      await request(server, 'GET', '/api/ports', { 'x-tangleclaw-cli': 'tc' });
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM awareness_receipts').get().n, beforeAll);
    });

    it('whoami honors the declared verb (tc capabilities records as capabilities) and skips aux fetches', async () => {
      const beforeCaps = receiptCount('capabilities');
      await request(server, 'GET', `/api/tc/whoami?projectId=${project.id}`, {
        'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'capabilities'
      });
      assert.equal(receiptCount('capabilities'), beforeCaps + 1);

      const beforeAll = store.getDb().prepare('SELECT COUNT(*) AS n FROM awareness_receipts').get().n;
      const aux = await request(server, 'GET', `/api/tc/whoami?projectId=${project.id}`, {
        'x-tangleclaw-cli': 'tc', 'x-tangleclaw-aux': '1'
      });
      assert.equal(aux.status, 200, 'the aux fetch still gets its answer');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM awareness_receipts').get().n, beforeAll,
        'but records nothing — the primary request already did');
    });

    it('records BEFORE the M2M gate: a refused call still proves the agent found the CLI', async () => {
      const config = store.config.load();
      config.serviceTokenEnabled = true;
      config.serviceToken = require('../lib/service-token').generateToken();
      store.config.save(config);
      try {
        const beforeN = receiptCount('ports');
        const res = await request(server, 'GET', '/api/ports', {
          'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'ports'
        });
        assert.equal(res.status, 401, 'the gate still refuses the tokenless call');
        assert.equal(receiptCount('ports'), beforeN + 1, 'the invocation recorded anyway');
      } finally {
        const cfg = store.config.load();
        cfg.serviceTokenEnabled = false;
        store.config.save(cfg);
      }
    });

    it('a junk verb header is capped, not rejected — a skewed client still counts', async () => {
      await request(server, 'GET', '/api/ports', {
        'x-tangleclaw-cli': 'tc', 'x-tangleclaw-verb': 'x'.repeat(200)
      });
      const row = store.getDb().prepare(
        'SELECT verb FROM awareness_receipts ORDER BY id DESC LIMIT 1'
      ).get();
      assert.equal(row.verb.length, 64);
    });
  });

  it('the unresolved-project receipt bucket is pruned to the same cap as project buckets', () => {
    store._setAwarenessReceiptRetention(3);
    try {
      for (let i = 0; i < 6; i++) {
        store.awarenessReceipts.record({ projectId: null, verb: `null-prune-${i}`, source: 'tc-cli' });
      }
      const n = store.getDb().prepare(
        'SELECT COUNT(*) AS n FROM awareness_receipts WHERE project_id IS NULL'
      ).get().n;
      assert.equal(n, 3, 'the NULL bucket does not grow forever');
      const newest = store.getDb().prepare(
        'SELECT verb FROM awareness_receipts WHERE project_id IS NULL ORDER BY id DESC LIMIT 1'
      ).get();
      assert.equal(newest.verb, 'null-prune-5', 'oldest pruned first');
    } finally {
      store._setAwarenessReceiptRetention(200);
    }
  });

  describe('bin/tc (spawned for real)', () => {
    it('tc capabilities renders the roster alone, absence included — and records as capabilities, not whoami', async () => {
      const beforeCaps = receiptCount('capabilities');
      const res = await runTc(['capabilities'], paneEnv);
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /Capabilities:/);
      assert.match(res.stdout, /\[--\] switchboard/, 'the disabled switchboard is visible');
      assert.ok(!/You are a TangleClaw-managed session/.test(res.stdout), 'identity prose stays with whoami');
      assert.equal(receiptCount('capabilities'), beforeCaps + 1,
        'the real binary declares its verb — the receipt is labeled by what was invoked, not which route answered');
    });

    it('tc sessions answers the idle fleet in words', async () => {
      const res = await runTc(['sessions'], paneEnv);
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /No live TangleClaw sessions right now/);
    });

    it('tc rules renders the project\'s rules with review state', async () => {
      const rule = store.sessionRules.create({ content: 'no timers in UI', projectId: project.id, createdBy: 'operator' });
      try {
        const res = await runTc(['rules'], paneEnv);
        assert.equal(res.code, 0, res.stderr);
        assert.match(res.stdout, /no timers in UI/);
      } finally {
        store.sessionRules.delete(rule.id);
      }
    });

    it('tc ports surfaces the honest registry (empty here)', async () => {
      const res = await runTc(['ports'], paneEnv);
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /No ports are currently leased/);
    });

    it('a project-scoped verb without the env fails loudly, exit 1', async () => {
      const res = await runTc(['learnings'], { PATH: process.env.PATH, TANGLECLAW_API: apiOrigin });
      assert.equal(res.code, 1);
      assert.match(res.stderr, /TANGLECLAW_PROJECT_ID is not set/);
    });

    it('tc message send to an unregistered peer relays the server\'s words, exit 2 — and one invocation is ONE receipt despite two HTTP calls', async () => {
      const beforeAll = store.getDb().prepare('SELECT COUNT(*) AS n FROM awareness_receipts').get().n;
      const res = await runTc(['message', 'send', 'nobody', 'hello'], paneEnv);
      assert.equal(res.code, 2);
      assert.match(res.stderr, /message failed/);
      assert.match(res.stderr, /say so instead of improvising/);
      // The real binary made an aux whoami fetch AND the medusa POST; the
      // ledger must show exactly one new row, labeled by the subverb, even
      // though the action itself was refused.
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM awareness_receipts').get().n, beforeAll + 1);
      const newest = store.getDb().prepare('SELECT verb FROM awareness_receipts ORDER BY id DESC LIMIT 1').get();
      assert.equal(newest.verb, 'message.send');
    });

    it('the usage text lists the whole roster', async () => {
      const res = await runTc(['--help'], paneEnv);
      assert.equal(res.code, 0);
      for (const v of VERB_ROSTER) assert.ok(res.stderr.includes(`tc ${v.id}`) || res.stderr.includes(v.usage), `help lists ${v.id}`);
    });
  });
});
