'use strict';

/*
 * The Codex startupControl adapter (#1825 B2) against a fake app-server that
 * replays the wire sequence the spike recorded: readiness is read from the
 * protocol, each blocker is named and every unknown answer fails closed; a
 * fire is accepted only on the engine's echo of the payload digest WITH the
 * prompt's exact bytes, whether it arrives as a notification or in the turns
 * read-back; applied, failed and interrupted follow the turn, and an early
 * completion is read back rather than trusted; approvals and user-input
 * waits are distinct accepted states never answered by TangleClaw; a socket
 * lost before the response is indeterminate and after acceptance is
 * reconnected and settled from the record; a reconcile settles an
 * indeterminate fire only from an exhaustive read of a stably idle thread;
 * and a restart recovers every in-flight fire without resending.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const codex = require('../lib/startup-control-codex');
const { FakeAppServer } = require('./helpers/ws-test-server');

const PROJECT_PATH = '/private/tmp/tc-b2-project';
const THREAD = '01a0d0ce-f772-7493-8737-33579a9f8ef1';
const TURN = '019a1c00-0000-7000-8000-000000000001';
const DIGEST = 'a'.repeat(64);
const PROMPT = 'read your launch context: run tc start next';
const PROMPT_DIGEST = crypto.createHash('sha256').update(PROMPT, 'utf8').digest('hex');

describe('Codex startupControl adapter', () => {
  let tempDir;
  let prevBase;
  let server;
  let sockN = 0;
  let keyN = 0;
  const session = { id: 10, projectId: 1, engineId: 'codex', status: 'active' };
  const project = { id: 1, name: 'proj', path: PROJECT_PATH };

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codex-adapter-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    codex._internal._version.version = '0.156.1';
    store.getDb().prepare('DELETE FROM startup_control_channels').run();
    store.getDb().prepare('DELETE FROM startup_prompt_fires').run();
  });

  afterEach(() => {
    if (server) server.close();
    server = null;
  });

  /**
   * A fake app-server with the happy-path handlers, before any turn.
   * @param {object} [over] - Handler overrides.
   * @returns {Promise<FakeAppServer>}
   */
  async function serve(over = {}) {
    const sock = path.join(os.tmpdir(), `tcb2-${process.pid}-${++sockN}.sock`);
    try { fs.unlinkSync(sock); } catch { /* fresh */ }
    server = new FakeAppServer(sock);
    server.state = { turnStarted: false, turn: null, userItem: null, threadStatus: { type: 'idle' }, extraTurns: [] };
    server.handlers = {
      initialize: () => ({ userAgent: 'tangleclaw/0.156.1 (Mac OS 15.6.1; arm64)', codexHome: '/x', platformFamily: 'unix', platformOs: 'macos' }),
      'config/read': () => ({ config: { projects: { [PROJECT_PATH]: { trust_level: 'trusted' } } }, origins: {} }),
      'account/read': () => ({ account: { type: 'chatgpt', email: 'x@y', planType: 'prolite' }, requiresOpenaiAuth: true }),
      'account/rateLimits/read': () => ({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 10 }, credits: { hasCredits: true, unlimited: false, balance: '10' } } }),
      'thread/loaded/list': () => ({ data: [THREAD], nextCursor: null }),
      'thread/read': (p) => ({ thread: { id: p.threadId, cwd: PROJECT_PATH, status: server.state.threadStatus, path: '/x/rollout.jsonl' } }),
      'thread/resume': () => {
        if (!server.state.turnStarted) throw Object.assign(new Error(`no rollout found for thread id ${THREAD}`), { code: -32600 });
        return { thread: { id: THREAD }, approvalPolicy: 'never', sandbox: {}, cwd: PROJECT_PATH, model: 'm', modelProvider: 'openai' };
      },
      'thread/turns/list': () => {
        if (!server.state.turnStarted) throw Object.assign(new Error(`thread ${THREAD} is not materialized yet; thread/turns/list is unavailable before first user message`), { code: -32600 });
        return { data: [...server.state.extraTurns, ...(server.state.turn ? [server.state.turn] : [])], nextCursor: null };
      },
      'turn/start': (p) => {
        server.state.turnStarted = true;
        server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
        server.state.turn = { id: TURN, status: 'inProgress', items: [] };
        return { turn: { id: TURN, status: 'inProgress', items: [] } };
      },
      ...over
    };
    await server.start();
    return server;
  }

  /**
   * An open channel row pointing at the fake server (or at a dead path).
   * @param {object} [stateOver] - Adapter state overrides.
   * @param {object} [rowOver] - Row overrides.
   * @returns {object}
   */
  function channel(stateOver = {}, rowOver = {}) {
    return store.startupControlChannels.open({
      sessionId: session.id, sequenceId: 100, engineId: 'codex', adapter: 'codex',
      adapterState: {
        pid: 4242, birth: 'Wed Sep 23 18:00:04 2026', socketPath: '/x/requested.sock',
        resolvedSocketPath: server ? server.sockPath : '/x/nothing.sock', engineVersion: '0.156.1', threadId: null, serverVersion: null, ...stateOver
      },
      ...rowOver
    });
  }

  /**
   * A pending fire row and an `onUpdate` that applies transitions to it and
   * records every patch.
   * @param {string} [outcome='pending'] - Initial outcome.
   * @param {object} [over] - Row overrides.
   * @returns {{row: object, patches: object[], onUpdate: Function, current: () => object}}
   */
  function pendingFire(outcome = 'pending', over = {}) {
    keyN += 1;
    const row = store.startupPrompts.insertFire({
      idempotencyKey: `codex-key-${String(keyN).padStart(6, '0')}`, projectId: 1, sessionId: session.id, sequenceId: 100,
      promptRevision: 1, promptTextDigest: PROMPT_DIGEST, policyDigest: 'p'.repeat(64),
      callerKind: 'operator', callerClearance: 'operator-verified', callerProjectId: null,
      outcome, reasonCode: null, reason: null, payload: { sessionId: 10 }, payloadDigest: DIGEST, ...over
    });
    const patches = [];
    const onUpdate = (patch) => {
      patches.push(patch);
      const r = store.startupPrompts.updateFire(row.id, patch);
      return r.fire || store.startupPrompts.getFireById(row.id);
    };
    return { row, patches, onUpdate, current: () => store.startupPrompts.getFireById(row.id) };
  }

  /**
   * Fire with the fake server and wait for the settled row.
   * @param {object} f - From `pendingFire`.
   * @param {object} [deps] - Adapter seams.
   * @returns {Promise<{settled: object, accepted: object}>}
   */
  async function fireAndSettle(f, deps = { reconnectPauseMs: 10 }) {
    const handles = codex.fire({ session, project, sequenceId: 100, promptText: PROMPT, promptTextDigest: PROMPT_DIGEST, payloadDigest: DIGEST, onUpdate: f.onUpdate }, deps);
    const settled = await handles.settled;
    const accepted = await handles.accepted;
    return { settled, accepted };
  }

  /**
   * The server's turn, finished with a status, carrying the echoed user item.
   * @param {string} status - Turn status.
   * @param {object} [extra] - Extra turn fields.
   * @returns {object}
   */
  const finishedTurn = (status, extra = {}) => ({ id: TURN, status, items: [server.state.userItem], ...extra });

  /**
   * A `turn/start` handler that materializes the thread and immediately
   * leaves the turn in `status` with the echoed item, so only the read-back
   * can report it.
   * @param {string} status - Final turn status.
   * @param {object} [extra] - Extra turn fields.
   * @returns {Function}
   */
  const startAndFinish = (status, extra = {}) => (p) => {
    server.state.turnStarted = true;
    server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
    server.state.turn = { id: TURN, status, items: [server.state.userItem], ...extra };
    return { turn: { id: TURN, status: 'inProgress', items: [] } };
  };

  describe('blockers before any send (acceptance case 4)', () => {
    it('with no channel row, or a channel of another launch, the fire is blocked as not ready and nothing is sent', async () => {
      await serve();
      let r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.outcome, 'blocked');
      assert.equal(r.settled.reasonCode, 'channel_unavailable');
      assert.match(r.settled.reason, /launched without one/);
      channel({}, { sequenceId: 101 });
      r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.reasonCode, 'engine_not_ready');
      assert.match(r.settled.reason, /different launch/);
      assert.equal(server.calls('turn/start').length, 0);
    });

    it('an unreachable app-server blocks as not ready', async () => {
      channel({ resolvedSocketPath: path.join(os.tmpdir(), 'tcb2-absent.sock') });
      const { settled } = await fireAndSettle(pendingFire());
      assert.equal(settled.outcome, 'blocked');
      assert.equal(settled.reasonCode, 'engine_not_ready');
      assert.match(settled.reason, /did not answer/);
    });

    it('a server version other than the installed one, or than the channel\'s recorded one, is a version mismatch', async () => {
      await serve({ initialize: () => ({ userAgent: 'tangleclaw/0.157.0 (x)' }) });
      channel();
      let r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.reasonCode, 'version_mismatch');
      server.close();
      await serve();
      store.getDb().prepare('DELETE FROM startup_control_channels').run();
      channel({ engineVersion: '0.155.0' });
      r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.reasonCode, 'version_mismatch');
      assert.match(r.settled.reason, /started on 0\.155\.0/);
      assert.equal(server.calls('turn/start').length, 0);
    });

    it('an untrusted project directory is trust_required, read from config, never typed through; an absent projects table is unknown', async () => {
      await serve({ 'config/read': () => ({ config: { projects: { '/somewhere/else': { trust_level: 'trusted' } } } }) });
      channel();
      let r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.outcome, 'blocked');
      assert.equal(r.settled.reasonCode, 'trust_required');
      server.close();
      await serve({ 'config/read': () => ({ config: {} }) });
      store.getDb().prepare('DELETE FROM startup_control_channels').run();
      channel();
      r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.reasonCode, 'readiness_unknown');
      assert.match(r.settled.reason, /trust .* unknown/);
      assert.equal(server.calls('turn/start').length, 0);
    });

    it('no signed-in account is auth_required; an answer with no account field is unknown', async () => {
      await serve({ 'account/read': () => ({ account: null, requiresOpenaiAuth: true }) });
      channel();
      let r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.reasonCode, 'auth_required');
      server.close();
      await serve({ 'account/read': () => ({ requiresOpenaiAuth: true }) });
      store.getDb().prepare('DELETE FROM startup_control_channels').run();
      channel();
      r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.reasonCode, 'readiness_unknown');
    });

    it('quota passes only on an explicit allowance or usable credits; exhausted and unknown are named apart', async () => {
      await serve({ 'account/rateLimits/read': () => ({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100, resetsAt: 1790224396 }, credits: { hasCredits: false, unlimited: false }, rateLimitReachedType: 'rate_limit_reached' } }) });
      channel();
      const { settled } = await fireAndSettle(pendingFire());
      assert.equal(settled.reasonCode, 'quota_exhausted');
      assert.match(settled.reason, /2026-09-24T04:33:16/);
      const usage = codex._internal._usageAllowed;
      assert.equal(usage({ ordinaryUsageAllowed: false, rateLimits: { credits: { hasCredits: true, unlimited: false, balance: '2238.15' } } }).state, 'allowed');
      assert.equal(usage({ ordinaryUsageAllowed: false, rateLimits: { credits: { hasCredits: true, unlimited: false, balance: '0' } } }).state, 'exhausted', 'a zero balance is not usable credit');
      assert.equal(usage({ ordinaryUsageAllowed: false, rateLimits: { credits: { hasCredits: true, unlimited: true } } }).state, 'allowed');
      assert.equal(usage({ ordinaryUsageAllowed: null, rateLimits: { credits: { hasCredits: true, unlimited: false } } }).state, 'unknown', 'a credits object without a balance proves nothing');
      assert.equal(usage({ ordinaryUsageAllowed: null }).state, 'unknown');
      assert.equal(usage(null).state, 'unknown');
    });

    it('unknown quota fails closed as readiness_unknown, never as ready', async () => {
      await serve({ 'account/rateLimits/read': () => ({ ordinaryUsageAllowed: null, rateLimits: {} }) });
      channel();
      const { settled } = await fireAndSettle(pendingFire());
      assert.equal(settled.reasonCode, 'readiness_unknown');
      assert.equal(server.calls('turn/start').length, 0);
    });

    it('no loaded thread for the project, more than one, a recorded one that is missing, or a thread that is not idle, is engine_not_ready', async () => {
      await serve({ 'thread/loaded/list': () => ({ data: [] }) });
      channel();
      let r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.reasonCode, 'engine_not_ready');
      assert.match(r.settled.reason, /has not opened a thread/);

      server.close();
      await serve({ 'thread/loaded/list': () => ({ data: [THREAD, 'other-thread'] }) });
      store.getDb().prepare('DELETE FROM startup_control_channels').run();
      channel();
      r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.reasonCode, 'engine_not_ready');
      assert.match(r.settled.reason, /2 threads .* not firing at a guess/);

      server.close();
      await serve({ 'thread/loaded/list': () => ({ data: [THREAD, 'other-thread'] }) });
      store.getDb().prepare('DELETE FROM startup_control_channels').run();
      channel({ threadId: 'recorded-but-gone' });
      r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.reasonCode, 'engine_not_ready');
      assert.match(r.settled.reason, /recorded thread is not loaded/);

      server.close();
      await serve();
      server.state.threadStatus = { type: 'active', activeFlags: [] };
      store.getDb().prepare('DELETE FROM startup_control_channels').run();
      channel();
      r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.reasonCode, 'engine_not_ready');
      assert.match(r.settled.reason, /active, not idle/);
      assert.equal(server.calls('turn/start').length, 0);
    });

    it('with several threads loaded, the recorded one is chosen exactly', async () => {
      await serve({ 'thread/loaded/list': () => ({ data: ['other-thread', THREAD] }), 'turn/start': startAndFinish('completed') });
      channel({ threadId: THREAD });
      const { settled } = await fireAndSettle(pendingFire());
      assert.equal(settled.outcome, 'applied');
      assert.equal(server.calls('turn/start')[0].params.threadId, THREAD);
    });

    it('a thread in another directory is not this project\'s thread', async () => {
      await serve({ 'thread/read': (p) => ({ thread: { id: p.threadId, cwd: '/elsewhere', status: { type: 'idle' } } }) });
      channel();
      const { settled } = await fireAndSettle(pendingFire());
      assert.equal(settled.reasonCode, 'engine_not_ready');
    });
  });

  describe('the receipt (acceptance case 3)', () => {
    it('accepted on the echoed clientId + bytes notification, applied on turn/completed, with the thread and server version recorded on the channel', async () => {
      await serve({
        'turn/start': (p) => {
          server.state.turnStarted = true;
          server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
          server.state.turn = { id: TURN, status: 'inProgress', items: [] };
          setTimeout(() => {
            server.notify('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: [] } });
            server.notify('turn/started', { threadId: THREAD, turn: server.state.turn });
            server.notify('item/completed', { threadId: THREAD, turnId: TURN, item: server.state.userItem, completedAtMs: 1 });
          }, 20);
          setTimeout(() => {
            server.state.turn = finishedTurn('completed', { durationMs: 1976 });
            server.notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } });
            server.notify('turn/completed', { threadId: THREAD, turn: server.state.turn });
          }, 80);
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      const c = channel();
      const f = pendingFire();
      const { settled, accepted } = await fireAndSettle(f);
      assert.equal(accepted.outcome, 'accepted');
      assert.equal(settled.outcome, 'applied');
      assert.equal(settled.engineThreadId, THREAD);
      assert.equal(settled.engineTurnId, TURN);
      assert.ok(settled.dispatchedAt && settled.acceptedAt && settled.settledAt);
      assert.deepEqual(f.patches.map((p) => p.outcome), ['dispatching', 'dispatching', 'accepted', 'applied']);
      const sent = server.calls('turn/start')[0];
      assert.equal(sent.params.clientUserMessageId, DIGEST, 'the payload digest rides as the client user message id');
      assert.equal(sent.params.threadId, THREAD);
      assert.deepEqual(sent.params.input, [{ type: 'text', text: PROMPT }]);
      assert.equal(server.calls('thread/resume').length, 1, 'subscribed after the send, not before');
      assert.equal(server.calls('thread/turns/list').length, 1, 'one read-back');
      const state = store.startupControlChannels.get(c.id).adapterState;
      assert.equal(state.threadId, THREAD);
      assert.equal(state.serverVersion, '0.156.1');
    });

    it('accepted from the read-back alone when the notifications preceded the subscription', async () => {
      await serve({ 'turn/start': startAndFinish('completed') });
      channel();
      const f = pendingFire();
      const { settled, accepted } = await fireAndSettle(f);
      assert.equal(accepted.outcome, 'accepted');
      assert.equal(settled.outcome, 'applied');
      assert.deepEqual(f.patches.map((p) => p.outcome), ['dispatching', 'dispatching', 'accepted', 'applied']);
    });

    it('a correct clientId with different text never blesses the turn', async () => {
      await serve({
        'turn/start': (p) => {
          server.state.turnStarted = true;
          server.state.turn = { id: TURN, status: 'completed', items: [{ type: 'userMessage', id: 'i', clientId: p.clientUserMessageId, content: [{ type: 'text', text: 'something else' }] }] };
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      channel();
      const { settled } = await fireAndSettle(pendingFire());
      assert.equal(settled.outcome, 'failed');
      assert.equal(settled.reasonCode, 'send_unconfirmed');
      assert.match(settled.reason, /digest and text/);
    });

    it('a completed turn whose record never echoed the digest is not this prompt applied', async () => {
      await serve({
        'turn/start': () => {
          server.state.turnStarted = true;
          server.state.turn = { id: TURN, status: 'completed', items: [{ type: 'userMessage', id: 'i', clientId: 'someone-else', content: [{ type: 'text', text: PROMPT }] }] };
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      channel();
      const { settled } = await fireAndSettle(pendingFire());
      assert.equal(settled.outcome, 'failed');
      assert.equal(settled.reasonCode, 'send_unconfirmed');
    });

    it('an early turn/completed notification without accepted evidence is read back before it is judged', async () => {
      await serve({
        'turn/start': (p) => {
          server.state.turnStarted = true;
          server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
          server.state.turn = { id: TURN, status: 'completed', items: [server.state.userItem] };
          // A summary-shaped completion arrives before any subscription or read-back.
          setTimeout(() => server.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed', items: [] } }), 1);
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      channel();
      const f = pendingFire();
      const { settled } = await fireAndSettle(f);
      assert.equal(settled.outcome, 'applied');
      assert.ok(f.patches.some((p) => p.outcome === 'accepted'), 'accepted was proven before applied');
      assert.ok(f.patches.findIndex((p) => p.outcome === 'accepted') < f.patches.findIndex((p) => p.outcome === 'applied'));
    });

    it('an accepted turn whose end no notification reports is still settled from the record by the poll', async () => {
      await serve({
        'turn/start': (p) => {
          server.state.turnStarted = true;
          server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
          server.state.turn = { id: TURN, status: 'inProgress', items: [server.state.userItem] };
          // Measured live on 0.156.1: the subscription can be refused after the send.
          server.handlers['thread/resume'] = () => { throw Object.assign(new Error('list_turns is not supported yet'), { code: -32601 }); };
          setTimeout(() => { server.state.turn = finishedTurn('completed'); }, 60);
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      channel();
      const f = pendingFire();
      const { settled, accepted } = await fireAndSettle(f, { reconnectPauseMs: 10, pollMs: 25 });
      assert.equal(accepted.outcome, 'accepted');
      assert.equal(settled.outcome, 'applied');
      assert.ok(server.calls('thread/turns/list').length >= 2, 'the record was re-read');
      assert.equal(server.calls('turn/start').length, 1);
    });

    it('a failed turn is failed with the engine\'s error class; an interrupted one is interrupted', async () => {
      await serve({ 'turn/start': startAndFinish('failed', { error: { message: 'boom', codexErrorInfo: 'usageLimitExceeded' } }) });
      channel();
      let r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.outcome, 'failed');
      assert.equal(r.settled.reasonCode, 'turn_failed');
      assert.match(r.settled.reason, /usageLimitExceeded/);
      assert.equal(r.accepted.outcome, 'accepted', 'the echo was accepted evidence before the turn failed');
      server.close();
      await serve({ 'turn/start': startAndFinish('interrupted') });
      store.getDb().prepare('DELETE FROM startup_control_channels').run();
      channel();
      r = await fireAndSettle(pendingFire());
      assert.equal(r.settled.outcome, 'interrupted');
      assert.equal(r.settled.reasonCode, 'turn_interrupted');
    });

    it('an approval and a user-input wait keep the fire accepted under distinct codes, are never answered by TangleClaw, and clear on resolution', async () => {
      await serve({
        'turn/start': (p) => {
          server.state.turnStarted = true;
          server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
          server.state.turn = { id: TURN, status: 'inProgress', items: [server.state.userItem] };
          setTimeout(() => {
            server.notify('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
            server.serverRequest('item/commandExecution/requestApproval', { threadId: THREAD, turnId: TURN, itemId: 'cmd-1', command: 'echo hi' });
          }, 40);
          setTimeout(() => {
            server.notify('serverRequest/resolved', { requestId: 0 });
            server.notify('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: [] } });
          }, 80);
          setTimeout(() => {
            server.notify('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
            server.serverRequest('item/tool/requestUserInput', { threadId: THREAD, turnId: TURN, itemId: 'q-1' });
          }, 110);
          setTimeout(() => {
            server.notify('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: [] } });
            server.state.turn = finishedTurn('completed');
            server.notify('turn/completed', { threadId: THREAD, turn: server.state.turn });
          }, 150);
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      channel();
      const f = pendingFire();
      const { settled } = await fireAndSettle(f);
      assert.equal(settled.outcome, 'applied');
      const codes = f.patches.map((p) => p.reasonCode);
      assert.ok(codes.includes('approval_pending'), 'the approval wait was recorded');
      assert.ok(codes.includes('user_input_pending'), 'the user-input wait was recorded under its own code');
      for (const p of f.patches.filter((x) => x.reasonCode === 'approval_pending' || x.reasonCode === 'user_input_pending')) assert.equal(p.outcome, 'accepted');
      const i = f.patches.findIndex((p) => p.reasonCode === 'approval_pending');
      assert.ok(f.patches.slice(i + 1).some((p) => p.outcome === 'accepted' && p.reasonCode === null), 'the wait was cleared when the request resolved');
      assert.equal(server.answeredAnyServerRequest(), false, 'TangleClaw never answers an approval or a question');
    });

    it('a socket lost before turn/start answers is indeterminate, and is never retried', async () => {
      await serve({
        'turn/start': (p, ctx) => {
          server.state.turnStarted = true;
          ctx.conn.destroy();
          throw Object.assign(new Error('gone'), { noResponse: true });
        }
      });
      channel();
      const { settled } = await fireAndSettle(pendingFire());
      assert.equal(settled.outcome, 'indeterminate');
      assert.equal(settled.reasonCode, 'send_unconfirmed');
      assert.equal(server.calls('turn/start').length, 1, 'sent once');
      assert.equal(store.startupPrompts.activeFire(100).outcome, 'indeterminate', 'it still holds the launch slot');
    });

    it('an error answer to turn/start is failed as rejected', async () => {
      await serve({ 'turn/start': () => { throw Object.assign(new Error('thread is busy'), { code: -32600 }); } });
      channel();
      const { settled } = await fireAndSettle(pendingFire());
      assert.equal(settled.outcome, 'failed');
      assert.equal(settled.reasonCode, 'turn_rejected');
      assert.match(settled.reason, /thread is busy/);
    });

    it('a socket lost after acceptance is reconnected, and the turn is settled from the read-back', async () => {
      let connectionsSeen = 0;
      await serve({
        initialize: () => { connectionsSeen += 1; return { userAgent: 'tangleclaw/0.156.1 (x)' }; },
        'turn/start': (p, ctx) => {
          server.state.turnStarted = true;
          server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
          server.state.turn = { id: TURN, status: 'inProgress', items: [server.state.userItem] };
          setTimeout(() => { ctx.conn.destroy(); server.state.turn = finishedTurn('completed'); }, 60);
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      channel();
      const { settled, accepted } = await fireAndSettle(pendingFire(), { reconnectPauseMs: 10 });
      assert.equal(accepted.outcome, 'accepted');
      assert.equal(settled.outcome, 'applied');
      assert.ok(connectionsSeen >= 2, `reconnected (${connectionsSeen} connections)`);
    });

    it('a channel lost for good after acceptance leaves the fire indeterminate as channel_lost', async () => {
      await serve({
        'turn/start': (p) => {
          server.state.turnStarted = true;
          server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
          server.state.turn = { id: TURN, status: 'inProgress', items: [server.state.userItem] };
          setTimeout(() => server.close(), 60);
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      channel();
      const { settled } = await fireAndSettle(pendingFire(), { reconnectPauseMs: 5 });
      assert.equal(settled.outcome, 'indeterminate');
      assert.equal(settled.reasonCode, 'channel_lost');
    });
  });

  describe('faults on the channel', () => {
    it('a protocol fault after acceptance is logged and turned into a reconnect, never an unhandled error', async () => {
      const { frame } = require('./helpers/ws-test-server');
      let faults = 0;
      await serve({
        'turn/start': (p, ctx) => {
          server.state.turnStarted = true;
          server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
          server.state.turn = { id: TURN, status: 'inProgress', items: [server.state.userItem] };
          setTimeout(() => {
            faults += 1;
            // Garbage the client cannot parse as JSON, then a frame with a reserved opcode: a fault, not a close.
            ctx.conn.send('{not json');
            ctx.conn.raw(frame(0x3, Buffer.from('x')));
            server.state.turn = finishedTurn('completed');
          }, 50);
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      channel();
      const { settled } = await fireAndSettle(pendingFire(), { reconnectPauseMs: 10, pollMs: 25 });
      assert.equal(settled.outcome, 'applied');
      assert.equal(faults, 1);
    });

    it('an unreadable turn list during the watch settles nothing; the next read does', async () => {
      let listCalls = 0;
      await serve({
        'turn/start': (p) => {
          server.state.turnStarted = true;
          server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
          server.state.turn = { id: TURN, status: 'completed', items: [server.state.userItem] };
          setTimeout(() => server.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed', items: [] } }), 1);
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        },
        'thread/turns/list': () => {
          listCalls += 1;
          if (listCalls <= 2) throw Object.assign(new Error('storage busy'), { code: -32603 });
          return { data: [server.state.turn], nextCursor: null };
        }
      });
      channel();
      const f = pendingFire();
      const { settled } = await fireAndSettle(f, { reconnectPauseMs: 10, pollMs: 25 });
      assert.equal(settled.outcome, 'applied');
      assert.ok(!f.patches.some((p) => p.outcome === 'failed'), 'an unreadable list was never read as absence');
      assert.ok(listCalls >= 3);
    });
  });

  describe('reconcile (E7)', () => {
    const indeterminate = () => pendingFire('indeterminate', { reasonCode: 'send_unconfirmed', engineThreadId: THREAD });

    it('settles an indeterminate fire from a turn record carrying its digest and bytes, on any page', async () => {
      await serve({
        'thread/turns/list': (p) => {
          if (!p.cursor) return { data: [{ id: 'older', status: 'completed', items: [] }], nextCursor: 'page-2' };
          return { data: [{ id: TURN, status: 'completed', items: [{ type: 'userMessage', id: 'i', clientId: DIGEST, content: [{ type: 'text', text: PROMPT }] }] }], nextCursor: null };
        }
      });
      server.state.turnStarted = true;
      channel();
      const f = indeterminate();
      const row = await codex.reconcile({ session, fire: f.current(), onUpdate: f.onUpdate }, { stableIdleMs: 5 });
      assert.equal(row.outcome, 'applied');
      assert.equal(row.engineTurnId, TURN);
      assert.ok(row.acceptedAt, 'the echo was stamped as accepted before applied');
      assert.deepEqual(f.patches.map((p) => p.outcome), ['accepted', 'applied']);
      assert.equal(server.calls('thread/turns/list').length, 2, 'both pages were read');
      assert.equal(server.calls('turn/start').length, 0, 'a reconcile never sends');
    });

    it('settles to failed only after every page shows the payload absent and the thread stayed idle', async () => {
      await serve();
      server.state.turnStarted = true;
      server.state.turn = null;
      channel();
      const f = indeterminate();
      const row = await codex.reconcile({ session, fire: f.current(), onUpdate: f.onUpdate }, { stableIdleMs: 5 });
      assert.equal(row.outcome, 'failed');
      assert.equal(row.reasonCode, 'send_unconfirmed');
      assert.ok(server.calls('thread/read').length >= 2, 'idle was read twice');
      assert.ok(server.calls('thread/turns/list').length >= 2, 'the turns were listed again after the pause');
      assert.equal(store.startupPrompts.activeFire(100), null);
    });

    it('stays indeterminate when the thread is active, when a page cannot be read, or when the channel cannot be reached', async () => {
      const fresh = () => { store.getDb().prepare('DELETE FROM startup_prompt_fires').run(); return indeterminate(); };
      await serve();
      server.state.turnStarted = true;
      server.state.turn = null;
      server.state.threadStatus = { type: 'active', activeFlags: [] };
      channel();
      let f = fresh();
      let row = await codex.reconcile({ session, fire: f.current(), onUpdate: f.onUpdate }, { stableIdleMs: 5 });
      assert.equal(row.outcome, 'indeterminate');
      assert.match(row.reason, /thread is active/);

      server.close();
      await serve({ 'thread/turns/list': () => { throw Object.assign(new Error('storage error'), { code: -32603 }); } });
      server.state.turnStarted = true;
      store.getDb().prepare('DELETE FROM startup_control_channels').run();
      channel();
      f = fresh();
      row = await codex.reconcile({ session, fire: f.current(), onUpdate: f.onUpdate }, { stableIdleMs: 5 });
      assert.equal(row.outcome, 'indeterminate');
      assert.match(row.reason, /could not be read in full/);

      store.getDb().prepare('DELETE FROM startup_control_channels').run();
      channel({ resolvedSocketPath: path.join(os.tmpdir(), 'tcb2-absent2.sock') });
      f = fresh();
      row = await codex.reconcile({ session, fire: f.current(), onUpdate: f.onUpdate });
      assert.equal(row.outcome, 'indeterminate');
      assert.equal(row.reasonCode, 'channel_lost');
    });
  });

  describe('restart recovery (E1, E5)', () => {
    /**
     * A project and an active session the recovery can find.
     * @returns {object} The session row.
     */
    function activeSession() {
      const dir = fs.mkdtempSync(path.join(tempDir, 'p-'));
      const p = store.projects.create({ name: `rec-${path.basename(dir)}`, path: dir, engine: 'codex' });
      return store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, tmux_session, status, started_at) VALUES (?, 'codex', ?, 'active', datetime('now')) RETURNING id"
      ).get(p.id, `tc-${p.name}`);
    }

    it('revalidates live channels, closes a silent one, and settles pending, dispatching and lost-channel fires without resending', async () => {
      await serve();
      const live = activeSession();
      const dead = activeSession();
      const liveChannel = store.startupControlChannels.open({ sessionId: live.id, sequenceId: 1, engineId: 'codex', adapter: 'codex', adapterState: { pid: 1, socketPath: '/x/a.sock', resolvedSocketPath: server.sockPath, engineVersion: '0.156.1', serverVersion: '0.156.1' } });
      const deadChannel = store.startupControlChannels.open({ sessionId: dead.id, sequenceId: 2, engineId: 'codex', adapter: 'codex', adapterState: { pid: 2, socketPath: '/x/b.sock', resolvedSocketPath: path.join(os.tmpdir(), 'tcb2-dead.sock'), engineVersion: '0.156.1' } });
      const mk = (sessionId, outcome, extra = {}) => store.startupPrompts.insertFire({
        idempotencyKey: `rec-${sessionId}-${outcome}-${++keyN}`, projectId: 1, sessionId, sequenceId: sessionId, promptRevision: 1,
        promptTextDigest: PROMPT_DIGEST, policyDigest: 'p'.repeat(64), callerKind: 'operator', callerClearance: 'operator-verified',
        callerProjectId: null, outcome, reasonCode: null, reason: null, payload: {}, payloadDigest: DIGEST, ...extra
      });
      const neverSent = mk(live.id, 'pending');
      const midSend = store.startupPrompts.updateFire(mk(dead.id, 'pending').id, { outcome: 'dispatching' }).fire;
      const kills = [];
      const written = [];
      const applyTransition = (id, patch) => { written.push([id, patch.outcome]); const r = store.startupPrompts.updateFire(id, patch); return r.fire; };
      // A fire that begins while recovery is revalidating channels belongs to
      // the running server: the fake initialize inserts one mid-recovery.
      let lateFire = null;
      const third = activeSession();
      server.handlers.initialize = () => {
        if (!lateFire) lateFire = mk(third.id, 'pending');
        return { userAgent: 'tangleclaw/0.156.1 (x)' };
      };
      const out = await codex.recover({ psCommand: () => '', kill: (pid, sig) => kills.push([pid, sig]), applyTransition });
      assert.equal(store.startupPrompts.getFireById(lateFire.id).outcome, 'pending', 'a fire begun after recovery started is not judged by it');
      assert.ok(written.every(([id]) => id !== lateFire.id));
      assert.ok(written.length >= 2, 'every recovered transition went through the supplied writer');
      assert.equal(out.channels, 2);
      assert.equal(out.lost, 1);
      assert.equal(store.startupControlChannels.get(liveChannel.id).state, 'open');
      const closedDead = store.startupControlChannels.get(deadChannel.id);
      assert.equal(closedDead.state, 'closed');
      assert.match(closedDead.closeReason, /not answering after restart/);
      assert.equal(closedDead.teardown, 'skipped', 'an unverifiable pid is never signalled');
      assert.deepEqual(kills, []);
      const a = store.startupPrompts.getFireById(neverSent.id);
      assert.equal(a.outcome, 'failed');
      assert.equal(a.reasonCode, 'restart_before_dispatch');
      const b = store.startupPrompts.getFireById(midSend.id);
      assert.equal(b.outcome, 'indeterminate');
      assert.equal(b.reasonCode, 'channel_lost');
      assert.equal(server.calls('turn/start').length, 0, 'nothing was resent');
    });

    it('resumes the watch of an accepted fire on a live channel and settles it from the record', async () => {
      await serve();
      server.state.turnStarted = true;
      server.state.turn = { id: TURN, status: 'completed', items: [{ type: 'userMessage', id: 'i', clientId: DIGEST, content: [{ type: 'text', text: PROMPT }] }] };
      const live = activeSession();
      store.startupControlChannels.open({ sessionId: live.id, sequenceId: 1, engineId: 'codex', adapter: 'codex', adapterState: { pid: 1, socketPath: '/x/a.sock', resolvedSocketPath: server.sockPath, engineVersion: '0.156.1', serverVersion: '0.156.1', threadId: THREAD } });
      const accepted = store.startupPrompts.insertFire({
        idempotencyKey: `rec-acc-${++keyN}`, projectId: 1, sessionId: live.id, sequenceId: 1, promptRevision: 1,
        promptTextDigest: PROMPT_DIGEST, policyDigest: 'p'.repeat(64), callerKind: 'operator', callerClearance: 'operator-verified',
        callerProjectId: null, outcome: 'accepted', reasonCode: null, reason: null, payload: {}, payloadDigest: DIGEST, engineThreadId: THREAD
      });
      store.getDb().prepare('UPDATE startup_prompt_fires SET engine_turn_id = ? WHERE id = ?').run(TURN, accepted.id);
      await codex.recover({ reconnectPauseMs: 5 });
      const deadline = Date.now() + 3000;
      while (store.startupPrompts.getFireById(accepted.id).outcome === 'accepted' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert.equal(store.startupPrompts.getFireById(accepted.id).outcome, 'applied');
      assert.equal(server.calls('turn/start').length, 0);
    });
  });

  describe('helpers', () => {
    it('parses the CLI version and the server version, and reads trust by canonical path with an unknown for no table', () => {
      assert.equal(codex._internal._parseVersion('codex-cli 0.156.1\n'), '0.156.1');
      assert.equal(codex._internal._parseVersion('nonsense'), null);
      assert.equal(codex._internal._serverVersion({ userAgent: 'tangleclaw-probe/0.156.1 (Mac OS 15.6.1; arm64) screen-256color (x; 0.0.0)' }), '0.156.1');
      assert.equal(codex._internal._serverVersion({}), null);
      assert.equal(codex._internal._trusted({ config: { projects: { '/a/b/': { trust_level: 'trusted' } } } }, '/a/b'), true);
      assert.equal(codex._internal._trusted({ config: { projects: { '/a/b': { trust_level: 'untrusted' } } } }, '/a/b'), false);
      assert.equal(codex._internal._trusted({ config: { projects: {} } }, '/a/b'), false);
      assert.equal(codex._internal._trusted({ config: {} }, '/a/b'), null);
    });

    it('maps a turn record to its outcome, and an item to its text', () => {
      assert.equal(codex._internal._turnOutcome({ status: 'inProgress' }), null);
      assert.equal(codex._internal._turnOutcome({ status: 'completed' }).outcome, 'applied');
      assert.equal(codex._internal._turnOutcome({ status: 'interrupted' }).reasonCode, 'turn_interrupted');
      const failed = codex._internal._turnOutcome({ status: 'failed', error: { message: 'm', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } } });
      assert.equal(failed.reasonCode, 'turn_failed');
      assert.match(failed.reason, /httpConnectionFailed/);
      assert.equal(codex._internal._itemText({ content: [{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }] }), 'ab');
    });

    it('signals only the app-server it started, by command, socket and birth identity, as a process group', () => {
      const kills = [];
      const state = { pid: 7, birth: 'Wed Sep 23 18:00:04 2026', socketPath: '/x/s.sock' };
      const deps = {
        psCommand: (pid) => (pid === 7 ? 'codex app-server --listen unix:///x/s.sock' : 'python3 something'),
        psBirth: (pid) => (pid === 7 ? 'Wed Sep 23 18:00:04 2026' : 'Thu Sep 24 01:00:00 2026'),
        kill: (pid, sig) => kills.push([pid, sig])
      };
      assert.deepEqual(codex._internal._terminate(state, deps), { signalled: true, teardown: 'ok' });
      assert.deepEqual(kills, [[-7, 'SIGTERM']], 'the process group is signalled');
      assert.equal(codex._internal._terminate({ ...state, pid: 8 }, deps).signalled, false, 'a reused pid is left alone');
      assert.equal(codex._internal._terminate({ ...state, socketPath: '/x/other.sock' }, deps).signalled, false, 'a different socket is not ours');
      assert.equal(codex._internal._terminate({ ...state, birth: 'Mon Jan 1 00:00:00 2024' }, deps).signalled, false, 'a different birth is not ours');
      const failing = { ...deps, kill: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) } };
      assert.match(codex._internal._terminate(state, failing).teardown, /signal failed: EPERM/);
    });
  });
});
