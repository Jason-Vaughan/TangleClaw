'use strict';

/*
 * #1176 — a `rules-hook` delivery that never receives its receipt stays
 * `written` forever (#1063 already made that an honest, visible state; it
 * never made anything watch for it). This pins the watcher that does:
 * grace-window gating on session activity, #1150 sandbox-loopback
 * disambiguation against the local receipt token, and bounded, cooled-down
 * re-delivery through an injected open channel that must itself confirm
 * before a row is treated as resolved.
 */

const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setLevel } = require('../lib/logger');

const execFileAsync = promisify(execFile);

setLevel('error');

const store = require('../lib/store');
const rulesChannel = require('../lib/session-rules-channel');
const tmux = require('../lib/tmux');
const redelivery = require('../lib/rule-receipt-redelivery');

describe('#1176 — rule-receipt-redelivery', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1176-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    redelivery._resetAttemptState();
  });

  let _uidCounter = 0;
  const uid = () => (++_uidCounter);

  function makeProject() {
    const name = `proj-${uid()}`;
    const projDir = path.join(projectsDir, name);
    fs.mkdirSync(projDir, { recursive: true });
    return store.projects.create({ name, path: projDir, engine: 'claude' });
  }

  function makeSession(project, overrides = {}) {
    return store.sessions.start({ projectId: project.id, engineId: 'claude', ...overrides });
  }

  function writtenDelivery(session, project) {
    return store.sessionRuleDeliveries.record({
      sessionId: session.id, projectId: project.id, engineId: 'claude',
      channel: 'rules-hook', outcome: 'written', ruleIds: [1, 2], digest: 'd'.repeat(64)
    });
  }

  function pastGraceNow() {
    return Date.now() + redelivery.DEFAULT_GRACE_MS + 60_000;
  }

  describe('probeLocalReceipt', () => {
    it('reports no receipt when the token file does not exist', () => {
      const project = makeProject();
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 1),
        { exists: false, matches: false, hookFiredAt: null, loopbackRefused: false });
    });

    it('reports a match with no hook-ran marker for a plain {deliveryId, api} token — '
      + 'the ordinary shape `writeReceiptToken` leaves BEFORE the engine ever starts (#1176 Round 2)', () => {
      const project = makeProject();
      rulesChannel.writeReceiptToken(project.path, { deliveryId: 42, api: 'http://localhost:3102' });
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 42),
        { exists: true, matches: true, hookFiredAt: null, loopbackRefused: false });
    });

    it('reports exists-but-no-match when the token now names a different delivery', () => {
      const project = makeProject();
      rulesChannel.writeReceiptToken(project.path, { deliveryId: 42, api: 'http://localhost:3102' });
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 7),
        { exists: true, matches: false, hookFiredAt: null, loopbackRefused: false });
    });

    it('surfaces hookFiredAt when the token (once the hook-side stamp lands) carries one', () => {
      const project = makeProject();
      const file = rulesChannel.receiptTokenPath(project.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ deliveryId: 42, api: 'http://localhost:3102', hookFiredAt: '2026-10-31T00:00:00Z' }));
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 42),
        { exists: true, matches: true, hookFiredAt: '2026-10-31T00:00:00Z', loopbackRefused: false });
    });

    it('surfaces loopbackRefused when the token carries it (#1150)', () => {
      const project = makeProject();
      const file = rulesChannel.receiptTokenPath(project.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ deliveryId: 42, api: 'http://localhost:3102', loopbackRefused: true }));
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 42),
        { exists: true, matches: true, hookFiredAt: null, loopbackRefused: true });
    });

    it('never surfaces hookFiredAt/loopbackRefused from a token that does not match this delivery', () => {
      const project = makeProject();
      const file = rulesChannel.receiptTokenPath(project.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ deliveryId: 999, api: 'http://localhost:3102', hookFiredAt: 'now', loopbackRefused: true }));
      assert.deepEqual(redelivery.probeLocalReceipt(project.path, 42),
        { exists: true, matches: false, hookFiredAt: null, loopbackRefused: false });
    });

    it('fails closed with readError on a non-ENOENT read failure, rather than reading as "no token" (WARNING 1)', () => {
      const project = makeProject();
      const file = rulesChannel.receiptTokenPath(project.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}');
      const original = fs.readFileSync;
      mock.method(fs, 'readFileSync', (p, enc) => {
        if (p === file) { const err = new Error('boom'); err.code = 'EACCES'; throw err; }
        return original(p, enc);
      });
      try {
        assert.deepEqual(redelivery.probeLocalReceipt(project.path, 1),
          { exists: false, matches: false, hookFiredAt: null, loopbackRefused: false, readError: 'EACCES' });
      } finally {
        mock.restoreAll();
      }
    });

    it('fails closed with parseError on malformed JSON, rather than reading as "exists, no match" (WARNING 3)', () => {
      const project = makeProject();
      const file = rulesChannel.receiptTokenPath(project.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{not valid json');
      const result = redelivery.probeLocalReceipt(project.path, 1);
      assert.equal(result.exists, true);
      assert.equal(result.matches, false);
      assert.equal(result.hookFiredAt, null);
      assert.equal(result.loopbackRefused, false);
      assert.ok(result.parseError, 'a parse failure must be reported, not silently folded into "no match"');
    });
  });

  // #1176 Round 3, PRR-A BLOCKING 1: the writer's half of the #1150 fix —
  // running the REAL hook script against a refused loopback, end to end,
  // rather than only unit-testing the reader against a hand-written token.
  describe('data/hooks/sessionstart-rules-claude.sh stamps hookFiredAt/loopbackRefused on a failed receipt POST (#1150, PRR-A BLOCKING 1)', () => {
    const HOOK = path.join(__dirname, '..', 'data', 'hooks', 'sessionstart-rules-claude.sh');

    /** A refused loopback port (#1150): nothing listens on 127.0.0.1:1, ever. */
    const REFUSED_API = 'http://127.0.0.1:1';

    function runHook(projectPath, shard = '1', source = 'startup') {
      return execFileSync('bash', [HOOK, shard], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectPath },
        input: JSON.stringify({ source }),
        encoding: 'utf8'
      });
    }

    /** The one shard `cat`'d by shard 1 — `.tangleclaw/` created first, like a real launch leaves it. */
    function writeShard(projectPath, body = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'test' } }) {
      fs.mkdirSync(path.join(projectPath, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(projectPath, '.tangleclaw', 'session-rules-1.json'), JSON.stringify(body));
    }

    it('on a failed POST (connection refused), stamps hookFiredAt + loopbackRefused onto the token in place', () => {
      const project = makeProject();
      writeShard(project.path);
      rulesChannel.writeReceiptToken(project.path, { deliveryId: 77, api: REFUSED_API });

      const out = runHook(project.path);
      assert.match(out, /additionalContext/, 'the shard is still printed — rules delivery itself never depends on the receipt');

      const tokenFile = rulesChannel.receiptTokenPath(project.path);
      assert.ok(fs.existsSync(tokenFile), 'a failed POST must leave the token — a real retry still needs it');
      const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      assert.equal(token.deliveryId, 77);
      assert.equal(token.loopbackRefused, true);
      assert.match(token.hookFiredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('end to end: the reader then classifies that stamped token as local-receipt-pending, not needs-redelivery', () => {
      const project = makeProject();
      writeShard(project.path);
      rulesChannel.writeReceiptToken(project.path, { deliveryId: 78, api: REFUSED_API });
      runHook(project.path);

      const probe = redelivery.probeLocalReceipt(project.path, 78);
      assert.equal(probe.matches, true);
      assert.equal(probe.loopbackRefused, true);
      assert.ok(probe.hookFiredAt);

      const classification = redelivery.classifyWrittenDelivery({ id: 78 }, project.path);
      assert.equal(classification.status, 'local-receipt-pending');
    });

    it('on a SUCCESSFUL POST (a real listener answering 200), still deletes the token exactly as before (no regression)', async () => {
      const http = require('node:http');
      const server = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => { res.writeHead(200); res.end('{}'); });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = server.address();
        const project = makeProject();
        writeShard(project.path, { ok: true });
        rulesChannel.writeReceiptToken(project.path, { deliveryId: 79, api: `http://127.0.0.1:${port}` });
        // ASYNC, deliberately (same reason test/rule-delivery-receipt.test.js
        // uses execFileAsync): execFileSync blocks this process's event loop,
        // so the in-process server above could never accept the hook's
        // connection and a genuine success would misreport as a failure —
        // exactly the false negative that file's own comment names. No stdin
        // is written — the hook's 1s read timeout then defaults HOOK_SOURCE
        // to empty, which the receipt condition already treats as 'startup'.
        await execFileAsync('bash', [HOOK, '1'], {
          env: { ...process.env, CLAUDE_PROJECT_DIR: project.path }
        });
        assert.equal(fs.existsSync(rulesChannel.receiptTokenPath(project.path)), false,
          'a successful POST must still delete the token, unaffected by the new failure-branch stamping');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('a non-startup source (e.g. /clear) never touches the token at all', () => {
      const project = makeProject();
      writeShard(project.path, { ok: true });
      rulesChannel.writeReceiptToken(project.path, { deliveryId: 80, api: REFUSED_API });
      const before = fs.readFileSync(rulesChannel.receiptTokenPath(project.path), 'utf8');
      runHook(project.path, '1', 'clear');
      const after = fs.readFileSync(rulesChannel.receiptTokenPath(project.path), 'utf8');
      assert.equal(after, before, 'a re-fire on /clear must not claim or alter a startup token');
    });
  });

  describe('classifyWrittenDelivery — #1150 disambiguation (corrected, #1176 Round 2 / PRR-B BLOCKING 1)', () => {
    it('is needs-redelivery when the token matches but carries NO hook-ran marker — the ordinary un-run-hook case', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: true, matches: true, hookFiredAt: null, loopbackRefused: false })
      });
      assert.equal(result.status, 'needs-redelivery',
        'presence-and-match alone must NOT withhold re-delivery — that was the Round 1 bug');
    });

    it('is local-receipt-pending when the token carries hookFiredAt', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: true, matches: true, hookFiredAt: '2026-10-31T00:00:00Z', loopbackRefused: false })
      });
      assert.equal(result.status, 'local-receipt-pending');
    });

    it('is local-receipt-pending when the token carries loopbackRefused (#1150)', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: true, matches: true, hookFiredAt: null, loopbackRefused: true })
      });
      assert.equal(result.status, 'local-receipt-pending');
    });

    it('is superseded when the token now names a different delivery', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: true, matches: false, hookFiredAt: null, loopbackRefused: false })
      });
      assert.equal(result.status, 'superseded');
    });

    it('is needs-redelivery when no local token exists at all', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: false, matches: false, hookFiredAt: null, loopbackRefused: false })
      });
      assert.equal(result.status, 'needs-redelivery');
    });

    it('is token-read-error, and does not fall through to needs-redelivery, on a non-ENOENT read failure (WARNING 1)', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: false, matches: false, hookFiredAt: null, loopbackRefused: false, readError: 'EACCES' })
      });
      assert.equal(result.status, 'token-read-error');
      assert.match(result.reason, /EACCES/);
    });

    it('is token-parse-error, and does not fall through to superseded, on malformed JSON (WARNING 3)', () => {
      const result = redelivery.classifyWrittenDelivery({ id: 9 }, '/irrelevant', {
        probeLocalReceipt: () => ({ exists: true, matches: false, hookFiredAt: null, loopbackRefused: false, parseError: 'Unexpected token' })
      });
      assert.equal(result.status, 'token-parse-error');
      assert.match(result.reason, /Unexpected token/);
    });
  });

  describe('defaults', () => {
    it('bounds re-delivery to 2 attempts by default, per the dispatch (#1176)', () => {
      assert.equal(redelivery.DEFAULT_MAX_ATTEMPTS, 2);
    });

    it('spaces default attempts by a cooldown shorter than a day and longer than the grace window', () => {
      assert.ok(redelivery.DEFAULT_COOLDOWN_MS > 0);
      assert.ok(redelivery.DEFAULT_COOLDOWN_MS >= redelivery.DEFAULT_GRACE_MS);
    });
  });

  describe('checkAndRedeliver', () => {
    it('defaults deliverViaOpenChannel to the production tmux paste when none is supplied (PRR-B BLOCKING 2)', async () => {
      const project = makeProject();
      const session = makeSession(project, { tmuxSession: `tc-1176-${uid()}` });
      const delivery = writtenDelivery(session, project);

      mock.method(tmux, 'sendKeys', () => {});
      try {
        const outcomes = await redelivery.checkAndRedeliver({
          now: pastGraceNow,
          listCandidates: () => [{ delivery, session }],
          getRules: () => [{ id: 1, content: 'a rule' }]
        });
        assert.equal(outcomes[0].status, 'redelivered');
        assert.equal(tmux.sendKeys.mock.calls.length, 1);
        assert.equal(tmux.sendKeys.mock.calls[0].arguments[0], session.tmuxSession);
        assert.match(tmux.sendKeys.mock.calls[0].arguments[1], /a rule/);
      } finally {
        mock.restoreAll();
      }
    });

    it('the default channel reports a failed attempt (never throws past checkAndRedeliver) when the session has no tmux pane', async () => {
      const project = makeProject();
      const session = makeSession(project); // no tmuxSession
      const delivery = writtenDelivery(session, project);

      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        getRules: () => [{ id: 1, content: 'a rule' }]
      });
      assert.equal(outcomes[0].status, 'attempt-failed');
      assert.match(outcomes[0].reason, /no tmux pane/);
    });

    it('leaves a freshly-written row alone until the session has stood active past the grace window', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: () => Date.now(),
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].status, 'pending-grace');
      assert.equal(calls, 0, 'must not re-deliver before the grace window elapses');
    });

    it('RE-DELIVERS (does not withhold) when the local token matches but carries no hook-ran marker — '
      + 'presence-and-match alone is the ordinary un-run-hook shape, not evidence (#1176 Round 2 / PRR-B BLOCKING 1)', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);
      rulesChannel.writeReceiptToken(project.path, { deliveryId: delivery.id, api: 'http://localhost:3102' });

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      assert.equal(outcomes[0].status, 'redelivered');
      assert.equal(calls, 1, 'a presence-and-match-only token (what writeReceiptToken ALWAYS leaves pre-hook) '
        + 'must not be mistaken for proof the hook ran — Round 1\'s bug froze this forever at local-receipt-pending');
    });

    it('does NOT re-deliver while the local token carries loopbackRefused — genuine #1150 evidence the hook ran', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);
      const file = rulesChannel.receiptTokenPath(project.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ deliveryId: delivery.id, api: 'http://localhost:3102', loopbackRefused: true }));

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      assert.equal(outcomes[0].status, 'local-receipt-pending');
      assert.equal(calls, 0, 'real evidence the hook ran (#1150 loopback-blocked) must still withhold re-delivery');
    });

    it('fails closed with token-read-error, attempting no re-delivery, on a non-ENOENT token read failure (WARNING 1)', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        probeLocalReceipt: () => ({ exists: false, matches: false, hookFiredAt: null, loopbackRefused: false, readError: 'EACCES' }),
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      assert.equal(outcomes[0].status, 'token-read-error');
      assert.equal(calls, 0, 'an unreadable token must never be treated as "no token, proceed"');
    });

    it('fails closed with token-parse-error, attempting no re-delivery, on malformed token JSON (WARNING 3)', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);
      const file = rulesChannel.receiptTokenPath(project.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{not valid json');

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      assert.equal(outcomes[0].status, 'token-parse-error');
      assert.equal(calls, 0, 'malformed JSON must never be treated as "no match, proceed"');
    });

    it('treats a token now pointing at a different delivery as superseded, not actionable', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);
      rulesChannel.writeReceiptToken(project.path, { deliveryId: delivery.id + 999, api: 'http://localhost:3102' });

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      assert.equal(outcomes[0].status, 'superseded');
      assert.equal(calls, 0);
    });

    it('re-delivers through the open channel when nothing local explains the silence, and records the attempt as SENT, not confirmed (#1176 Round 3 BLOCKING 3)', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);

      const seen = [];
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        getRules: () => [{ id: 1, content: 'rule text' }],
        deliverViaOpenChannel: async (entry) => { seen.push(entry); }
      });

      assert.equal(outcomes[0].status, 'redelivered');
      assert.equal(outcomes[0].attempt, 1);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0], { sessionId: session.id, projectId: project.id, rules: [{ id: 1, content: 'rule text' }], attempt: 1 });

      const activity = store.activity.query({ sessionId: session.id, eventType: redelivery.EVENT_ATTEMPT });
      assert.equal(activity.length, 1);
      // `pasted`, never `confirmed` (BLOCKING 3): a successful paste proves
      // only that the reminder was sent, not that the engine consumed it.
      assert.equal(activity[0].detail.pasted, true);
      assert.equal(activity[0].detail.confirmed, undefined, 'the old (incorrect) field name must not reappear');
    });

    it('a successful paste does NOT stop the watch: a later pass with the row still "written" tries again (#1176 Round 3 BLOCKING 3)', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);

      let calls = 0;
      const deps = {
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; },
        cooldownMs: 0,
        maxAttempts: 5
      };

      const first = await redelivery.checkAndRedeliver({ ...deps, now: pastGraceNow });
      assert.equal(first[0].status, 'redelivered');
      assert.equal(calls, 1);

      // The ledger row is still 'written' — nothing upgraded it — so a
      // second pass, with the cooldown elapsed, tries again rather than
      // treating the first successful paste as the end of the story.
      const second = await redelivery.checkAndRedeliver({ ...deps, now: () => pastGraceNow() + 1000 });
      assert.equal(second[0].status, 'redelivered');
      assert.equal(second[0].attempt, 2);
      assert.equal(calls, 2, 'a successful paste must never set a permanent confirmed flag that stops future passes');
    });

    it('once the ledger row genuinely upgrades to delivered, the watch reports already-delivered and never calls the channel again', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);

      let calls = 0;
      const outcomes1 = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });
      assert.equal(outcomes1[0].status, 'redelivered');

      // The REAL confirmation: the hook's own late receipt (or any other
      // mechanism) upgrades the ledger row — never the open-channel paste.
      store.sessionRuleDeliveries.markDelivered(delivery.id, Date.now());

      const outcomes2 = await redelivery.checkAndRedeliver({
        now: () => pastGraceNow() + 1000,
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });
      assert.equal(outcomes2[0].status, 'already-delivered');
      assert.equal(calls, 1, 'once genuinely delivered, the channel must never be called again');
    });

    // #1176 Round 3, PRR-A BLOCKING 2: never paste into a pane that isn't
    // verified idle — a redelivery must not clobber a live draft or an
    // in-flight command.
    describe('isPaneSafeToDeliver gate (PRR-A Round 3 BLOCKING 2)', () => {
      it('defers (consumes no attempt, never touches the pane) when the gate says the pane is not safe', async () => {
        const project = makeProject();
        const session = makeSession(project);
        const delivery = writtenDelivery(session, project);

        let calls = 0;
        const outcomes = await redelivery.checkAndRedeliver({
          now: pastGraceNow,
          listCandidates: () => [{ delivery, session }],
          isPaneSafeToDeliver: () => false,
          deliverViaOpenChannel: async () => { calls += 1; }
        });

        assert.equal(outcomes[0].status, 'deferred');
        assert.equal(outcomes[0].reason, 'pane-not-at-rest');
        assert.equal(calls, 0, 'the channel must never be touched while deferred');

        const activity = store.activity.query({ sessionId: session.id, eventType: redelivery.EVENT_ATTEMPT });
        assert.equal(activity.length, 0, 'a deferred pass must not count as an attempt');
      });

      it('a later pass, once the gate says the pane is safe, proceeds normally and consumes attempt 1', async () => {
        const project = makeProject();
        const session = makeSession(project);
        const delivery = writtenDelivery(session, project);
        const safe = { value: false };

        let calls = 0;
        const deps = {
          listCandidates: () => [{ delivery, session }],
          isPaneSafeToDeliver: () => safe.value,
          deliverViaOpenChannel: async () => { calls += 1; }
        };

        const deferred = await redelivery.checkAndRedeliver({ ...deps, now: pastGraceNow });
        assert.equal(deferred[0].status, 'deferred');
        assert.equal(calls, 0);

        safe.value = true;
        const proceeded = await redelivery.checkAndRedeliver({ ...deps, now: () => pastGraceNow() + 1000 });
        assert.equal(proceeded[0].status, 'redelivered');
        assert.equal(proceeded[0].attempt, 1, 'the earlier deferral must not have consumed an attempt');
        assert.equal(calls, 1);
      });

      it('with no isPaneSafeToDeliver supplied at all, behaves exactly as before the gate existed (opt-in)', async () => {
        const project = makeProject();
        const session = makeSession(project);
        const delivery = writtenDelivery(session, project);

        const outcomes = await redelivery.checkAndRedeliver({
          now: pastGraceNow,
          listCandidates: () => [{ delivery, session }],
          deliverViaOpenChannel: async () => {}
        });
        assert.equal(outcomes[0].status, 'redelivered');
      });
    });

    // #1176 Round 3, PRR-A WARNING 1: the attempt COUNT must survive a
    // server restart. `_resetAttemptState()` clears exactly what a restart
    // loses (the in-memory `_attempts` Map) — the durable count, read from
    // `activity_log`, must be unaffected.
    describe('durable attempt count survives a simulated restart (PRR-A Round 3 WARNING 1)', () => {
      it('maxAttempts is still honoured after the in-memory state is cleared mid-sequence', async () => {
        const project = makeProject();
        const session = makeSession(project);
        const delivery = writtenDelivery(session, project);

        const deps = {
          listCandidates: () => [{ delivery, session }],
          deliverViaOpenChannel: async () => { throw new Error('channel unreachable'); },
          cooldownMs: 0,
          maxAttempts: 2
        };

        const first = await redelivery.checkAndRedeliver({ ...deps, now: pastGraceNow });
        assert.equal(first[0].status, 'attempt-failed');
        assert.equal(first[0].attempt, 1);

        // Simulates a server restart: the in-memory Map (lastAttemptAt,
        // the old confirmed/exhausted flags) is gone. The durable count
        // (one EVENT_ATTEMPT row already in activity_log) is not.
        redelivery._resetAttemptState();

        const second = await redelivery.checkAndRedeliver({ ...deps, now: () => pastGraceNow() + 1000 });
        assert.equal(second[0].status, 'exhausted', 'the durable count (1 prior attempt) must still count toward maxAttempts (2) after a restart');
        assert.equal(second[0].attempts, 2);

        const exhaustions = store.activity.query({ sessionId: session.id, eventType: redelivery.EVENT_EXHAUSTED });
        assert.equal(exhaustions.length, 1, 'exhaustion is surfaced exactly once, even across the simulated restart');
      });
    });

    // #1176 Round 3, PRR-A WARNING 2: bound how many candidates one pass
    // processes, so a backlog never costs one tick noticeably more than its
    // own capture budget.
    describe('maxCandidatesPerPass bound (PRR-A Round 3 WARNING 2)', () => {
      it('processes at most maxCandidatesPerPass candidates, leaving the rest for a later pass', async () => {
        const project = makeProject();
        const sessionA = makeSession(project);
        const sessionB = makeSession(project);
        const deliveryA = writtenDelivery(sessionA, project);
        const deliveryB = writtenDelivery(sessionB, project);

        let calls = 0;
        const outcomes = await redelivery.checkAndRedeliver({
          now: pastGraceNow,
          listCandidates: () => [{ delivery: deliveryA, session: sessionA }, { delivery: deliveryB, session: sessionB }],
          maxCandidatesPerPass: 1,
          deliverViaOpenChannel: async () => { calls += 1; }
        });

        assert.equal(outcomes.length, 1, 'only one candidate is examined at all this pass');
        assert.equal(outcomes[0].sessionId, sessionA.id, 'candidates are processed in listCandidates\' own order');
        assert.equal(calls, 1);
      });

      it('is unbounded by default — unchanged for a caller that never asks for a bound', async () => {
        const project = makeProject();
        const sessionA = makeSession(project);
        const sessionB = makeSession(project);
        const deliveryA = writtenDelivery(sessionA, project);
        const deliveryB = writtenDelivery(sessionB, project);

        const outcomes = await redelivery.checkAndRedeliver({
          now: pastGraceNow,
          listCandidates: () => [{ delivery: deliveryA, session: sessionA }, { delivery: deliveryB, session: sessionB }],
          deliverViaOpenChannel: async () => {}
        });
        assert.equal(outcomes.length, 2);
      });
    });

    it('records a failed attempt, then withholds a retry during the cooldown window', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);

      let calls = 0;
      const deps = {
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; throw new Error('channel unreachable'); },
        cooldownMs: 10 * 60 * 1000,
        maxAttempts: 5
      };

      const first = await redelivery.checkAndRedeliver({ ...deps, now: pastGraceNow });
      assert.equal(first[0].status, 'attempt-failed');
      assert.equal(first[0].attempt, 1);
      assert.equal(calls, 1);

      const second = await redelivery.checkAndRedeliver({ ...deps, now: () => pastGraceNow() + 1000 });
      assert.equal(second[0].status, 'cooling-down');
      assert.equal(calls, 1, 'must not attempt again inside the cooldown window');
    });

    it('stops at maxAttempts, surfaces exhaustion once, and never calls the channel again', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivery = writtenDelivery(session, project);

      let calls = 0;
      const exhaustions = [];
      const deps = {
        listCandidates: () => [{ delivery, session }],
        deliverViaOpenChannel: async () => { calls += 1; throw new Error('channel unreachable'); },
        maxAttempts: 2,
        cooldownMs: 0,
        onExhausted: (entry) => exhaustions.push(entry)
      };

      const r1 = await redelivery.checkAndRedeliver({ ...deps, now: pastGraceNow });
      assert.equal(r1[0].status, 'attempt-failed');

      const r2 = await redelivery.checkAndRedeliver({ ...deps, now: () => pastGraceNow() + 1000 });
      assert.equal(r2[0].status, 'exhausted');
      assert.equal(calls, 2);
      assert.equal(exhaustions.length, 1);
      assert.equal(exhaustions[0].deliveryId, delivery.id);
      assert.equal(exhaustions[0].attempts, 2);

      const r3 = await redelivery.checkAndRedeliver({ ...deps, now: () => pastGraceNow() + 2000 });
      assert.equal(r3[0].status, 'exhausted');
      assert.equal(calls, 2, 'an already-exhausted delivery must never call the channel again');
      assert.equal(exhaustions.length, 1, 'exhaustion is surfaced once, not on every subsequent pass');

      const activity = store.activity.query({ sessionId: session.id, eventType: redelivery.EVENT_EXHAUSTED });
      assert.equal(activity.length, 1);
    });

    it('never calls the channel for a delivered or skipped row (only `written` rules-hook rows are candidates)', async () => {
      const project = makeProject();
      const session = makeSession(project);
      const delivered = store.sessionRuleDeliveries.record({
        sessionId: session.id, projectId: project.id, engineId: 'claude',
        channel: 'rules-hook', outcome: 'delivered', ruleIds: [1], digest: 'd'.repeat(64)
      });

      let calls = 0;
      const outcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        listCandidates: () => [{ delivery: delivered, session }],
        deliverViaOpenChannel: async () => { calls += 1; }
      });

      // Fed directly, bypassing `_defaultListCandidates`'s own filter, to pin
      // the defensive re-check inside `_processOne` itself.
      assert.equal(outcomes[0].status, 'not-applicable');
      assert.equal(calls, 0);

      // The default candidate list is fleet-wide (every live session), so this
      // asserts against THIS session specifically rather than an empty result
      // — other tests in this file leave their own live sessions behind, and
      // a reset attempt-state means some of those get a fresh, real attempt
      // here too.
      const liveOutcomes = await redelivery.checkAndRedeliver({
        now: pastGraceNow,
        deliverViaOpenChannel: async () => {}
      });
      assert.equal(
        liveOutcomes.some((o) => o.sessionId === session.id), false,
        'the live store default must not surface a delivered row as a candidate'
      );
    });
  });

  // #1176, PRR-B BLOCKING 2: checkAndRedeliver has to actually run somewhere
  // in production, not only in a test's own direct call. This pins that
  // `lib/activity-observer.js`'s tick loop is that somewhere, and that a
  // failure in it (the default "no store yet" case every bare unit-test
  // observer hits) can never break the tick itself.
  describe('wired into lib/activity-observer.js\'s tick (#1176, PRR-B BLOCKING 2)', () => {
    it('calls deps.checkRuleReceipts once per tick, after the tick\'s own result is already final', async () => {
      const { createObserver } = require('../lib/activity-observer');
      const calls = [];
      const obs = createObserver({
        listSessions: () => [],
        checkRuleReceipts: async () => { calls.push(1); }
      });
      const result = await obs.tick();
      assert.equal(calls.length, 1);
      assert.deepEqual(result, { observed: [], skipped: [] }, 'the redelivery pass must not alter the tick result');
    });

    it('a rejecting checkRuleReceipts (e.g. no store yet) is swallowed — tick() still resolves normally', async () => {
      const { createObserver } = require('../lib/activity-observer');
      const obs = createObserver({
        listSessions: () => [],
        checkRuleReceipts: async () => { throw new Error('store not initialized'); }
      });
      await assert.doesNotReject(() => obs.tick());
    });

    it('defaults checkRuleReceipts to this module\'s own checkAndRedeliver when a caller supplies none', async () => {
      const { createObserver } = require('../lib/activity-observer');
      const obs = createObserver({ listSessions: () => [] }); // no checkRuleReceipts override
      // The real default reaches this suite's own already-initialized live
      // store (earlier tests leave real `written` rules-hook rows behind),
      // and its own default `deliverViaOpenChannel` will genuinely attempt —
      // and fail — a tmux paste against sessions with no real pane. Both are
      // caught well before this call: `_processOne` catches a failed attempt
      // as an ordinary outcome, and `tick()`'s own try/catch around
      // `checkRuleReceipts()` is the backstop. This proves the production
      // default is actually wired, not just a test-supplied stand-in.
      await assert.doesNotReject(() => obs.tick());
    });
  });
});
