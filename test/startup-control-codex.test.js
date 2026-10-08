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
    // LAUNCH_PANE (below) is what a launch records: its pane and the tmux server that issued it.
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
   * Wait until a recorded patch satisfies `pred`, for steps that must follow
   * the adapter's own processing rather than a wall-clock offset.
   * @param {object} f - From `pendingFire`.
   * @param {(patch: object, index: number) => boolean} pred - Match on a patch and its index.
   * @param {number} [timeoutMs=5000] - Give up after this long.
   * @returns {Promise<void>}
   */
  async function untilPatch(f, pred, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!f.patches.some(pred)) {
      if (Date.now() > deadline) throw new Error(`no matching patch within ${timeoutMs} ms; patches: ${JSON.stringify(f.patches.map((p) => p.reasonCode))}`);
      await new Promise((r) => setTimeout(r, 5));
    }
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

    describe('a folder with no trust entry in Codex\'s config (#2186)', () => {
      const NO_ENTRY = { 'config/read': () => ({ config: { projects: { '/somewhere/else': { trust_level: 'trusted' } } } }) };
      const SHOWN = async () => ({ shown: true });

      /**
       * Fire with a trust exception in the input, as the fire service supplies it.
       * @param {object} f - From `pendingFire`.
       * @param {object} [trustException] - `{absentOn, witness}`.
       * @returns {{settled: Promise<object>, accepted: Promise<object>}}
       */
      /** What a launch records about its pane: the id, and the tmux server that issued it. */
      const LAUNCH_PANE = { paneId: '%7', paneServer: '4242.1790431343' };

      const fireWith = (f, trustException) => codex.fire({
        session, project, sequenceId: 100, promptText: PROMPT, promptTextDigest: PROMPT_DIGEST, payloadDigest: DIGEST,
        onUpdate: f.onUpdate, ...(trustException ? { trustException } : {})
      }, { reconnectPauseMs: 10 });

      /** Finish the turn once the adapter has read it back, as the receipt tests do. */
      const completeTheTurn = () => {
        let sequenced = false;
        server.on('request', ({ method }) => {
          if (method !== 'thread/turns/list' || !server.state.turnStarted || sequenced) return;
          sequenced = true;
          server.notify('item/completed', { threadId: THREAD, turnId: TURN, item: server.state.userItem, completedAtMs: 1 });
          server.state.turn = finishedTurn('completed', { durationMs: 10 });
          server.notify('turn/completed', { threadId: THREAD, turn: server.state.turn });
        });
      };

      /** Every protocol method the adapter called, for the "never grants trust" check. */
      const methodsCalled = () => [...new Set(server.received.filter((m) => m.method !== undefined).map((m) => m.method))];

      it('a launch whose pane was never recorded gets no trust-free fire, and the pane is not consulted', async () => {
        await serve(NO_ENTRY);
        channel();
        let consulted = 0;
        const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => { consulted += 1; return { shown: true }; } }).settled;
        assert.equal(settled.outcome, 'blocked');
        assert.equal(settled.reasonCode, 'trust_required');
        assert.match(settled.reason, /The pane this launch created was not recorded/);
        assert.equal(consulted, 0);
        assert.equal(server.calls('turn/start').length, 0);
      });

      it('a pane id recorded without the tmux server that issued it is no record: the id alone can name another pane after a tmux restart', async () => {
        for (const state of [{ paneId: '%7' }, { paneId: '%7', paneServer: '' }, { paneServer: '4242.1790431343' }]) {
          await serve(NO_ENTRY);
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(state);
          let consulted = 0;
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => { consulted += 1; return { shown: true }; } }).settled;
          assert.equal(settled.reasonCode, 'trust_required', JSON.stringify(state));
          assert.match(settled.reason, /The pane this launch created was not recorded/);
          assert.equal(consulted, 0);
          assert.equal(server.calls('turn/start').length, 0);
          server.close();
          server = null;
        }
      });

      it('the session-1363 shape: measured version, idle thread, composer on the pane: the fire goes, and the row keeps saying trust was not granted', async () => {
        await serve(NO_ENTRY);
        completeTheTurn();
        channel(LAUNCH_PANE);
        const f = pendingFire();
        const witnessed = [];
        const handles = fireWith(f, { absentOn: ['0.156.1'], witness: async (opts) => { witnessed.push(opts); return { shown: true }; } });
        const settled = await handles.settled;

        assert.equal(settled.outcome, 'applied');
        assert.equal(server.calls('turn/start').length, 1);
        assert.equal(witnessed.length, 1, 'the pane is consulted once');
        assert.equal(witnessed[0].paneId, '%7', 'the witness is told which pane this launch created');
        assert.equal(witnessed[0].paneServer, '4242.1790431343', 'and which tmux server created it');
        assert.ok(witnessed[0].headerRe.test('│ model:     GPT-6-Astra   /model to change │'));
        assert.ok(witnessed[0].startingRe.test('│ model:     loading   /model to change │'));
        assert.ok(!witnessed[0].startingRe.test('│ model:     GPT-6-Astra   /model to change │'));
        assert.ok(witnessed[0].statusRe.test('  GPT-6-Astra default · /private/tmp/b4cs-8d6DW4'), 'Codex\'s default status row');
        assert.ok(witnessed[0].statusRe.test('  GPT-6-Astra default · Ready · never · Context 100% left'), 'the operator\'s layout');
        for (const notStatus of ['│ › Careful    │', '› 1. Update now', '  Press enter to continue', '  GPT-6-Astra', '╭──────────────╮', '  enter continue · esc skip'.replace('  enter', '> enter')]) {
          assert.ok(!witnessed[0].statusRe.test(notStatus), notStatus);
        }
        assert.equal(witnessed[0].maxStatusRows, 1);
        for (const key of ['enter', 'Esc', 'TAB', 'space', 'return', 'arrows', '↑↓']) assert.ok(witnessed[0].keyHintRe.test(key), key);
        for (const notKey of ['left', 'GPT-6-Astra', 'continue', 'Enterprise', '/srv/esc', 'never']) assert.ok(!witnessed[0].keyHintRe.test(notKey), notKey);
        assert.match(settled.dispatchNote, /Sent without a trust entry in Codex's config for \/private\/tmp\/tc-b2-project/);
        assert.match(settled.dispatchNote, /this pane showed an empty composer and no declared trust prompt/);
        assert.match(settled.dispatchNote, /TangleClaw did not grant trust\./);
        assert.ok(!/never|always/.test(settled.dispatchNote), 'the note speaks for this pane at fire time, not for the version');
        assert.equal(settled.reasonCode, null, 'the note is not a blocker and takes no reason code');
        const dispatching = f.patches.find((p) => p.outcome === 'dispatching');
        assert.equal(dispatching.dispatchNote, settled.dispatchNote, 'the note is written at dispatch');
        assert.ok(f.patches.slice(1).every((p) => !('dispatchNote' in p)), 'and only there: later transitions do not restate it');
      });

      it('a home that has never trusted any folder (projects: null) is the same case', async () => {
        await serve({ 'config/read': () => ({ config: { projects: null } }) });
        completeTheTurn();
        channel(LAUNCH_PANE);
        const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: SHOWN }).settled;
        assert.equal(settled.outcome, 'applied');
        assert.ok(settled.dispatchNote);
      });

      it('the thread is read again after the pane check, immediately before the send', async () => {
        await serve(NO_ENTRY);
        completeTheTurn();
        channel(LAUNCH_PANE);
        let readsAtWitness = null;
        await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => { readsAtWitness = server.calls('thread/read').length; return { shown: true }; } }).settled;
        const order = server.received.filter((m) => m.method !== undefined && m.id !== undefined).map((m) => m.method);
        assert.ok(readsAtWitness >= 1);
        assert.ok(order.lastIndexOf('thread/read', order.indexOf('turn/start')) >= 0);
        assert.equal(order.slice(0, order.indexOf('turn/start')).filter((m) => m === 'thread/read').length, readsAtWitness + 1, 'exactly one more thread read between the witness and the send');
      });

      it('a thread that turns busy while the pane is being checked stops the send', async () => {
        await serve(NO_ENTRY);
        channel(LAUNCH_PANE);
        const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => { server.state.threadStatus = { type: 'active', activeFlags: [] }; return { shown: true }; } }).settled;
        assert.equal(settled.outcome, 'blocked');
        assert.equal(settled.reasonCode, 'engine_not_ready');
        assert.match(settled.reason, /became active while the pane was being checked/);
        assert.equal(settled.dispatchNote, null);
        assert.equal(server.calls('turn/start').length, 0);
      });

      it('a thread whose folder changes while the pane is being checked stops the send', async () => {
        let moved = false;
        await serve({ ...NO_ENTRY, 'thread/read': (p) => ({ thread: { id: p.threadId, cwd: moved ? '/somewhere/else' : PROJECT_PATH, status: { type: 'idle' } } }) });
        channel(LAUNCH_PANE);
        const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => { moved = true; return { shown: true }; } }).settled;
        assert.equal(settled.reasonCode, 'engine_not_ready');
        assert.match(settled.reason, /thread changed while the pane was being checked/);
        assert.equal(server.calls('turn/start').length, 0);
      });

      it('a trust dialog actually on the pane refuses the fire, and says it was read from the pane', async () => {
        await serve(NO_ENTRY);
        channel(LAUNCH_PANE);
        const dialog = { id: 'folder-trust', humanAction: 'Answer Codex\'s folder-trust prompt in the pane.' };
        const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => ({ shown: false, dialog, why: 'the pane is showing the engine\'s folder-trust prompt' }) }).settled;
        assert.equal(settled.outcome, 'blocked');
        assert.equal(settled.reasonCode, 'trust_required');
        assert.match(settled.reason, /is showing its folder-trust prompt in the pane \(read from the pane\)/);
        assert.match(settled.reason, /TangleClaw does not answer it/);
        assert.equal(server.calls('turn/start').length, 0);
      });

      it('a dialog that is not the trust dialog is a pane that is not ready, named and read from the pane', async () => {
        await serve(NO_ENTRY);
        channel(LAUNCH_PANE);
        const dialog = { id: 'update', humanAction: 'Answer Codex\'s update prompt in the pane (Escape skips it).' };
        const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => ({ shown: false, dialog, why: 'x' }) }).settled;
        assert.equal(settled.outcome, 'blocked');
        assert.equal(settled.reasonCode, 'pane_not_ready');
        assert.match(settled.reason, /is showing its update prompt in the pane \(read from the pane\)/);
        assert.match(settled.reason, /Escape skips it/);
        assert.equal(server.calls('turn/start').length, 0);
      });

      it('a folder Codex was told NOT to trust is not "no entry": it is blocked as such and never gets the exception', async () => {
        for (const entry of [{ trust_level: 'untrusted' }, { trust_level: 'none' }, {}, null]) {
          await serve({ 'config/read': () => ({ config: { projects: { [PROJECT_PATH]: entry } } }) });
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(LAUNCH_PANE);
          let consulted = 0;
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => { consulted += 1; return { shown: true }; } }).settled;
          assert.equal(settled.outcome, 'blocked', JSON.stringify(entry));
          assert.equal(settled.reasonCode, 'trust_required');
          assert.match(settled.reason, /has an entry for \/private\/tmp\/tc-b2-project that does not trust it/);
          assert.ok(!/has no trust entry/.test(settled.reason), 'it does not say there is no entry');
          assert.ok(!/is showing/.test(settled.reason), 'and claims no dialog');
          assert.equal(consulted, 0, 'the pane is not consulted');
          assert.equal(server.calls('turn/start').length, 0);
          server.close();
          server = null;
        }
      });

      it('a pane not proven to show an empty composer is pane_not_ready, naming what failed', async () => {
        for (const why of ['the engine is still starting', 'the composer holds typed text', 'the cursor is not on the composer row', 'a turn is running', 'the pane changed between two reads a second apart', 'the pane could not be read (the capture came back empty)']) {
          await serve(NO_ENTRY);
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(LAUNCH_PANE);
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => ({ shown: false, dialog: null, why }) }).settled;
          assert.equal(settled.outcome, 'blocked', why);
          assert.equal(settled.reasonCode, 'pane_not_ready', why);
          assert.ok(settled.reason.includes(why), settled.reason);
          assert.equal(server.calls('turn/start').length, 0, why);
          server.close();
          server = null;
        }
      });

      it('a witness that throws is pane_not_ready with a safe reason; the fault is not shown to the operator', async () => {
        await serve(NO_ENTRY);
        channel(LAUNCH_PANE);
        const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => { throw new Error('ENOENT /private/secret/path'); } }).settled;
        assert.equal(settled.reasonCode, 'pane_not_ready');
        assert.ok(!settled.reason.includes('ENOENT') && !settled.reason.includes('/private/secret'), settled.reason);
        assert.equal(server.calls('turn/start').length, 0);
      });

      it('a malformed witness answer is not a yes', async () => {
        for (const answer of [null, undefined, {}, { shown: 'true' }, { shown: 1 }]) {
          await serve(NO_ENTRY);
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(LAUNCH_PANE);
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => answer }).settled;
          assert.equal(settled.reasonCode, 'pane_not_ready', JSON.stringify(answer));
          assert.equal(server.calls('turn/start').length, 0);
          server.close();
          server = null;
        }
      });

      it('a version nobody measured keeps the block, with honest wording, and the pane is not consulted', async () => {
        for (const absentOn of [[], ['0.155.0'], undefined]) {
          await serve(NO_ENTRY);
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(LAUNCH_PANE);
          let consulted = 0;
          const settled = await fireWith(pendingFire(), { absentOn, witness: async () => { consulted += 1; return { shown: true }; } }).settled;
          assert.equal(settled.outcome, 'blocked');
          assert.equal(settled.reasonCode, 'trust_required');
          assert.match(settled.reason, /Codex's config \(read over the channel\) has no trust entry for \/private\/tmp\/tc-b2-project\./);
          assert.match(settled.reason, /did not look for a dialog and does not claim one/);
          assert.match(settled.reason, /not established for Codex 0\.156\.1/);
          assert.match(settled.reason, /To grant trust, add this folder under \[projects\] in Codex's config\.toml with trust_level = "trusted"/);
          assert.ok(settled.reason.endsWith('then Fire again.'), 'the way to grant trust is not the part that gets cut off');
          assert.ok(!/is showing/.test(settled.reason), 'no dialog is claimed');
          assert.ok(settled.reason.length <= 500);
          assert.equal(consulted, 0);
          assert.equal(server.calls('turn/start').length, 0);
          server.close();
          server = null;
        }
      });

      it('a long project path still leaves room for how to grant trust within the stored reason', async () => {
        const long = { id: 1, name: 'proj', path: `/Users/someone/Documents/Projects/${'a-deeply-nested-folder/'.repeat(3)}the-project` };
        assert.ok(long.path.length > 90);
        await serve({ ...NO_ENTRY, 'thread/read': (p) => ({ thread: { id: p.threadId, cwd: long.path, status: { type: 'idle' } } }) });
        channel(LAUNCH_PANE);
        const f = pendingFire();
        const settled = await codex.fire({ session, project: long, sequenceId: 100, promptText: PROMPT, promptTextDigest: PROMPT_DIGEST, payloadDigest: DIGEST, onUpdate: f.onUpdate, trustException: { absentOn: [] } }, { reconnectPauseMs: 10 }).settled;
        assert.equal(settled.reasonCode, 'trust_required');
        assert.ok(settled.reason.length <= 500, String(settled.reason.length));
        assert.ok(settled.reason.includes('/a-deeply-nested-folder/the-project.'), 'the end of the path, which names the folder, is kept');
        assert.ok(settled.reason.includes('…'), 'and its front is visibly shortened, not silently cut');
        assert.ok(settled.reason.endsWith('then Fire again.'), settled.reason);
      });

      it('no trust exception supplied at all, or no witness, keeps the block', async () => {
        await serve(NO_ENTRY);
        channel(LAUNCH_PANE);
        let settled = await fireWith(pendingFire()).settled;
        assert.equal(settled.reasonCode, 'trust_required');
        assert.match(settled.reason, /does not claim one/);
        server.close();
        await serve(NO_ENTRY);
        store.getDb().prepare('DELETE FROM startup_control_channels').run();
        channel(LAUNCH_PANE);
        settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'] }).settled;
        assert.equal(settled.reasonCode, 'trust_required');
        assert.match(settled.reason, /pane could not be consulted/);
        assert.equal(server.calls('turn/start').length, 0);
      });

      it('a trusted folder is unchanged: the pane is never consulted and the row carries no note', async () => {
        await serve();
        completeTheTurn();
        channel(LAUNCH_PANE);
        let consulted = 0;
        const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => { consulted += 1; return { shown: true }; } }).settled;
        assert.equal(settled.outcome, 'applied');
        assert.equal(consulted, 0);
        assert.equal(settled.dispatchNote, null);
      });

      it('a config answer that cannot be read does not get the exception', async () => {
        for (const config of [{}, { projects: [] }, { projects: 'none' }]) {
          await serve({ 'config/read': () => ({ config }) });
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(LAUNCH_PANE);
          let consulted = 0;
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => { consulted += 1; return { shown: true }; } }).settled;
          assert.equal(settled.reasonCode, 'readiness_unknown', JSON.stringify(config));
          assert.equal(consulted, 0);
          assert.equal(server.calls('turn/start').length, 0);
          server.close();
          server = null;
        }
      });

      it('the other blockers still come first: no account, no quota, a busy thread are named as before and the pane is not consulted', async () => {
        const cases = [
          [{ 'account/read': () => ({ account: null, requiresOpenaiAuth: true }) }, 'auth_required'],
          [{ 'account/rateLimits/read': () => ({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100, resetsAt: 1790224396 }, credits: { hasCredits: false, unlimited: false } } }) }, 'quota_exhausted'],
          [{ 'thread/loaded/list': () => ({ data: [], nextCursor: null }) }, 'engine_not_ready']
        ];
        for (const [over, code] of cases) {
          await serve({ ...NO_ENTRY, ...over });
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(LAUNCH_PANE);
          let consulted = 0;
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => { consulted += 1; return { shown: true }; } }).settled;
          assert.equal(settled.reasonCode, code);
          assert.equal(consulted, 0, code);
          server.close();
          server = null;
        }
      });

      describe('with the real pane witness reading whole live captures', () => {
        const paneWitness = require('../lib/pane-witness');
        const { CODEX_VISIBLE_PANES: PANES } = require('./_codex-visible-pane-fixtures');
        const codexProfile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));

        /**
         * A witness as the fire service builds it, over a fixture pane, recording every tmux-side call.
         * @param {string} name - Fixture name.
         * @param {string[]} tmuxLog - Receives one entry per pane read.
         * @returns {Function}
         */
        const witnessOver = (name, tmuxLog) => (opts) => paneWitness.composerShown({
          ...opts, tmuxName: 'tc-deputy', engineProfile: codexProfile, wakeProfile: require('../lib/medusa-wake').ENGINE_WAKE_PROFILES.codex
        }, {
          gapMs: 0,
          sleep: async () => {},
          pin: () => { tmuxLog.push('pin-pane'); return '%7'; },
          read: (session, paneId) => { tmuxLog.push(`read-visible-pane ${paneId}`); return { paneId, ...PANES[name], rows: [...PANES[name].rows] }; }
        });

        it('a renamed directory with the ordinary composer on screen: the fire goes', async () => {
          await serve(NO_ENTRY);
          completeTheTurn();
          channel(LAUNCH_PANE);
          const tmuxLog = [];
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: witnessOver('composer', tmuxLog) }).settled;
          assert.equal(settled.outcome, 'applied');
          assert.ok(settled.dispatchNote);
          assert.deepEqual(tmuxLog, ['pin-pane', 'read-visible-pane %7', 'read-visible-pane %7'], 'one pane was pinned and read, twice, and nothing was sent to it');
        });

        it('a real folder-trust dialog on screen: the fire is refused, and nothing is sent to the pane or the engine', async () => {
          await serve(NO_ENTRY);
          channel(LAUNCH_PANE);
          const tmuxLog = [];
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: witnessOver('trustPrompt', tmuxLog) }).settled;
          assert.equal(settled.outcome, 'blocked');
          assert.equal(settled.reasonCode, 'trust_required');
          assert.match(settled.reason, /is showing its folder-trust prompt in the pane \(read from the pane\)/);
          assert.match(settled.reason, /does not accept folder trust on your behalf/);
          assert.equal(server.calls('turn/start').length, 0);
          assert.ok(tmuxLog.length > 0 && tmuxLog.every((c) => c === 'pin-pane' || c === 'read-visible-pane %7'), 'only reads');
        });

        it('the operator\'s own status line, with its run-state item, is still a composer at rest: the fire goes', async () => {
          await serve(NO_ENTRY);
          completeTheTurn();
          channel(LAUNCH_PANE);
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: witnessOver('composerOperatorStatus', []) }).settled;
          assert.equal(settled.outcome, 'applied');
        });

        it('the update prompt and the opening screen are refused too', async () => {
          for (const [name, code] of [['updatePrompt', 'pane_not_ready'], ['openingScreen', 'pane_not_ready']]) {
            await serve(NO_ENTRY);
            store.getDb().prepare('DELETE FROM startup_control_channels').run();
            channel(LAUNCH_PANE);
            const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: witnessOver(name, []) }).settled;
            assert.equal(settled.outcome, 'blocked', name);
            assert.equal(settled.reasonCode, code, name);
            assert.equal(server.calls('turn/start').length, 0, name);
            server.close();
            server = null;
          }
        });

        it('REPLACEMENT BEFORE THE FIRE: the launch\'s pane was killed and another is the session\'s only pane, showing a usable composer: no trust-free fire', async () => {
          await serve(NO_ENTRY);
          channel(LAUNCH_PANE);
          const tmuxLog = [];
          const witness = (opts) => paneWitness.composerShown({
            ...opts, tmuxName: 'tc-deputy', engineProfile: codexProfile, wakeProfile: require('../lib/medusa-wake').ENGINE_WAKE_PROFILES.codex
          }, { gapMs: 0, sleep: async () => {}, pin: () => '%9', read: (session, id) => { tmuxLog.push(`read ${id}`); return { paneId: id, ...PANES.composer, rows: [...PANES.composer.rows] }; } });
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness }).settled;
          assert.equal(settled.outcome, 'blocked');
          assert.equal(settled.reasonCode, 'pane_not_ready');
          assert.match(settled.reason, /is not the pane this launch created/);
          assert.match(settled.reason, /does not clear by itself: relaunch the session\./, 'waiting will not bring the launch\'s pane back');
          assert.ok(!/Fire again once it is/.test(settled.reason));
          assert.deepEqual(tmuxLog, [], 'the replacement pane is never read');
          assert.equal(server.calls('turn/start').length, 0);
        });

        it('TMUX SERVER RESTARTED BEFORE THE FIRE: the same session name and pane id in a new server, showing a usable composer: no trust-free fire, and the operator is told to relaunch', async () => {
          await serve(NO_ENTRY);
          channel(LAUNCH_PANE);
          const asked = [];
          const witness = (opts) => paneWitness.composerShown({
            ...opts, tmuxName: 'tc-deputy', engineProfile: codexProfile, wakeProfile: require('../lib/medusa-wake').ENGINE_WAKE_PROFILES.codex
          }, { gapMs: 0, sleep: async () => {}, pin: () => '%7', read: (session, id, tmuxServer) => { asked.push(tmuxServer); throw Object.assign(new Error('tmux answered from a different server'), { tcOtherServer: true }); } });
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness }).settled;
          assert.equal(settled.outcome, 'blocked');
          assert.equal(settled.reasonCode, 'pane_not_ready');
          assert.match(settled.reason, /the tmux server is not the one this launch's pane was created in/);
          assert.ok(settled.reason.endsWith('This does not clear by itself: relaunch the session.'), settled.reason);
          assert.deepEqual(asked, [LAUNCH_PANE.paneServer], 'the read was asked for the launch\'s own server, once');
          assert.equal(server.calls('turn/start').length, 0);
        });

        it('a session with a second pane gets no trust-free fire, whatever its panes show', async () => {
          await serve(NO_ENTRY);
          channel(LAUNCH_PANE);
          const witness = (opts) => paneWitness.composerShown({
            ...opts, tmuxName: 'tc-deputy', engineProfile: codexProfile, wakeProfile: require('../lib/medusa-wake').ENGINE_WAKE_PROFILES.codex
          }, { gapMs: 0, sleep: async () => {}, pin: () => { throw new Error('does not have exactly one pane'); }, read: () => ({ paneId: '%7', ...PANES.composer }) });
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness }).settled;
          assert.equal(settled.outcome, 'blocked');
          assert.equal(settled.reasonCode, 'pane_not_ready');
          assert.match(settled.reason, /does not have exactly one pane to read/);
          assert.ok(settled.reason.endsWith('Fire again once it is.'), 'closing the extra pane clears this, so the operator is not told to relaunch');
          assert.equal(server.calls('turn/start').length, 0);
        });

        it('a very long project path does not cost a pane refusal the sentence the operator acts on', async () => {
          const long = { id: 1, name: 'proj', path: `/Users/someone/Documents/Projects/${'a-deeply-nested-folder/'.repeat(14)}the-project` };
          assert.ok(long.path.length > 300);
          for (const [seen, ending] of [
            [{ shown: false, dialog: null, why: 'the session\'s pane is not the pane this launch created', lasting: true }, 'This does not clear by itself: relaunch the session.'],
            [{ shown: false, dialog: null, why: 'the composer holds typed text' }, 'Fire again once it is.'],
            [new Error('tmux went away'), 'Fire again once the pane shows an empty composer.']
          ]) {
            await serve({ ...NO_ENTRY, 'thread/read': (p) => ({ thread: { id: p.threadId, cwd: long.path, status: { type: 'idle' } } }) });
            store.getDb().prepare('DELETE FROM startup_control_channels').run();
            channel(LAUNCH_PANE);
            const witness = async () => { if (seen instanceof Error) throw seen; return seen; };
            const settled = await codex.fire({ session, project: long, sequenceId: 100, promptText: PROMPT, promptTextDigest: PROMPT_DIGEST, payloadDigest: DIGEST, onUpdate: pendingFire().onUpdate, trustException: { absentOn: ['0.156.1'], witness } }, { reconnectPauseMs: 10 }).settled;
            assert.equal(settled.reasonCode, 'pane_not_ready');
            assert.ok(settled.reason.length <= 500, String(settled.reason.length));
            assert.ok(settled.reason.includes('/a-deeply-nested-folder/the-project.'), 'the end of the path is kept');
            assert.ok(settled.reason.includes('…'), 'its front is visibly shortened');
            assert.ok(settled.reason.endsWith(ending), settled.reason);
            assert.equal(server.calls('turn/start').length, 0);
            server.close();
            server = null;
          }
        });

        it('the active pane switching between the witness\'s two reads gets no trust-free fire', async () => {
          await serve(NO_ENTRY);
          channel(LAUNCH_PANE);
          let n = 0;
          const witness = (opts) => paneWitness.composerShown({
            ...opts, tmuxName: 'tc-deputy', engineProfile: codexProfile, wakeProfile: require('../lib/medusa-wake').ENGINE_WAKE_PROFILES.codex
          }, { gapMs: 0, sleep: async () => {}, pin: () => '%7', read: () => { n += 1; return { paneId: n === 1 ? '%7' : '%8', ...PANES.composer, rows: [...PANES.composer.rows] }; } });
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness }).settled;
          assert.equal(settled.reasonCode, 'pane_not_ready');
          assert.match(settled.reason, /not the pane that was pinned/);
          assert.equal(server.calls('turn/start').length, 0);
        });

        it('as shipped, the same composer does not get the fire: the profile lists no measured version', async () => {
          await serve(NO_ENTRY);
          channel(LAUNCH_PANE);
          const tmuxLog = [];
          const shipped = codexProfile.capabilities.startupControl.remoteTrustPrompt.absentOn;
          assert.deepEqual(shipped, []);
          const settled = await fireWith(pendingFire(), { absentOn: shipped, witness: witnessOver('composer', tmuxLog) }).settled;
          assert.equal(settled.reasonCode, 'trust_required');
          assert.deepEqual(tmuxLog, [], 'the pane is not even read');
          assert.equal(server.calls('turn/start').length, 0);
        });
      });

      it('never grants trust: no path calls a config write, whatever the outcome', async () => {
        const outcomes = [SHOWN, async () => ({ shown: false, dialog: { id: 'folder-trust', humanAction: '' }, why: 'x' }), async () => ({ shown: false, dialog: null, why: 'x' })];
        for (const witness of outcomes) {
          await serve(NO_ENTRY);
          completeTheTurn();
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(LAUNCH_PANE);
          await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness }).settled;
          const called = methodsCalled();
          assert.ok(called.includes('config/read'), 'the config is read');
          assert.ok(!called.some((m) => m.startsWith('config/') && m !== 'config/read'), `only config/read touches the config: ${called.join(', ')}`);
          assert.ok(!called.some((m) => /write|trust/i.test(m)), called.join(', '));
          server.close();
          server = null;
        }
      });
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

  describe('observeActivity: a read-only view of the launch thread (#1628)', () => {
    /** Process-identity seams under which pid 4242 IS the recorded app-server. */
    const ours = {
      psCommand: (pid) => (pid === 4242 ? 'codex app-server --listen unix:///x/requested.sock' : ''),
      psBirth: (pid) => (pid === 4242 ? 'Wed Sep 23 18:00:04 2026' : '')
    };
    /** Observe the open channel for the session. */
    const observe = (deps = ours) => codex.observeActivity(store.startupControlChannels.getOpenBySession(session.id), project, deps);

    it('a process that is not the recorded app-server is unknown, and its socket is not trusted', async () => {
      await serve();
      channel({ threadId: THREAD });
      assert.deepEqual(await observe({ ...ours, psBirth: () => 'Thu Sep 24 01:00:00 2026' }), { state: 'unknown', reasonCode: 'process-mismatch' });
      assert.deepEqual(await observe({ ...ours, psCommand: () => 'python3 something' }), { state: 'unknown', reasonCode: 'process-mismatch' });
      assert.equal(server.calls('initialize').length, 0);
    });

    it('idle and active map to idle and busy, and nothing is spent, trusted or checked for quota', async () => {
      await serve();
      channel({ threadId: THREAD });
      assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
      server.state.threadStatus = { type: 'active', activeFlags: ['waitingOnApproval'] };
      assert.deepEqual(await observe(), { state: 'busy', reasonCode: 'thread-active' });
      for (const m of ['turn/start', 'config/read', 'account/read', 'account/rateLimits/read', 'thread/resume']) {
        assert.equal(server.calls(m).length, 0, `${m} is never called by an observation`);
      }
    });

    it('any other status is unknown', async () => {
      await serve();
      server.state.threadStatus = { type: 'systemError' };
      channel({ threadId: THREAD });
      assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-status-unknown' });
    });

    describe('binding a channel whose thread was never recorded (D8)', () => {
      const threadOf = () => store.startupControlChannels.getOpenBySession(session.id).adapterState.threadId;

      it('binds the SOLE loaded project thread, then answers for it', async () => {
        await serve();
        channel();
        assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
        assert.equal(threadOf(), THREAD);
        assert.equal(server.calls('turn/start').length, 0, 'binding is TangleClaw metadata only — no engine turn');
      });

      it('with no loaded project thread, or with two, binds nothing and is unknown', async () => {
        await serve({ 'thread/loaded/list': () => ({ data: [] }) });
        channel();
        assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-unbound' });
        assert.equal(threadOf(), null);
        server.close();
        await serve({ 'thread/loaded/list': () => ({ data: [THREAD, 'other-thread'] }) });
        store.getDb().prepare('DELETE FROM startup_control_channels').run();
        channel();
        assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-ambiguous' });
        assert.equal(threadOf(), null);
      });

      it('never replaces a recorded thread — a recorded one that is gone is unknown, and stays recorded', async () => {
        await serve({ 'thread/loaded/list': () => ({ data: ['other-thread'] }) });
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-not-loaded' });
        assert.equal(threadOf(), THREAD);
      });

      it('a binding that lands first from elsewhere (the fire) wins, and this answer is unknown', async () => {
        await serve({
          'thread/loaded/list': () => {
            // The fire records its own thread between this read and the bind.
            const row = store.startupControlChannels.getOpenBySession(session.id);
            if (!row.adapterState.threadId) store.startupControlChannels.setAdapterState(row.id, { threadId: 'fire-bound' });
            return { data: [THREAD] };
          }
        });
        channel();
        assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-bind-contended' });
        assert.equal(threadOf(), 'fire-bound');
      });

      it('a second thread appearing after the bind makes it unknown, with the binding kept', async () => {
        let lists = 0;
        await serve({ 'thread/loaded/list': () => ({ data: ++lists === 1 ? [THREAD] : [THREAD, 'other-thread'] }) });
        channel();
        assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-ambiguous' });
        assert.equal(threadOf(), THREAD);
      });
    });

    it('an idle answer is withheld when the channel changed under the read', async () => {
      await serve({
        'thread/read': (p) => {
          // The launch's channel is closed while the observation reads.
          store.getDb().prepare("UPDATE startup_control_channels SET state = 'closed'").run();
          return { thread: { id: p.threadId, cwd: PROJECT_PATH, status: { type: 'idle' } } };
        }
      });
      channel({ threadId: THREAD });
      assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'channel-changed' });
    });

    describe('a bound thread beside other loaded threads for the project directory (#1978)', () => {
      const SUB = 'sub-thread';
      const OTHER = 'other-root-thread';
      /**
       * Serve the bound thread plus extra same-directory threads.
       * @param {object<string, object>} extras - Thread id → fields (`status`, `parentThreadId`, `source`).
       * @returns {Promise<FakeAppServer>}
       */
      const serveWith = (extras) => serve({
        'thread/loaded/list': () => ({ data: [THREAD, ...Object.keys(extras)] }),
        'thread/read': (p) => ({
          thread: p.threadId === THREAD
            ? { id: THREAD, cwd: PROJECT_PATH, status: server.state.threadStatus, parentThreadId: null, source: 'cli' }
            : { id: p.threadId, cwd: PROJECT_PATH, parentThreadId: null, source: 'cli', ...extras[p.threadId] }
        })
      });
      const subagent = (status) => ({ status, parentThreadId: THREAD, source: { subAgent: { thread_spawn: { parent_thread_id: THREAD, depth: 1 } } } });

      it('an idle bound root with an idle subagent loaded is idle, so the wake reaches the pane gates', async () => {
        await serveWith({ [SUB]: subagent({ type: 'idle' }) });
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
      });

      it('an idle bound root with another idle root thread loaded is idle — the bound thread is authoritative', async () => {
        await serveWith({ [OTHER]: { status: { type: 'idle' } }, [SUB]: subagent({ type: 'systemError' }) });
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
      });

      it('any other loaded thread that is working makes it busy — the operator may be working in it', async () => {
        await serveWith({ [OTHER]: { status: { type: 'active', activeFlags: [] } } });
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'busy', reasonCode: 'other-thread-active' });
      });

      it('a working subagent makes it busy, named as a subagent from the protocol metadata', async () => {
        await serveWith({ [SUB]: subagent({ type: 'active', activeFlags: [] }) });
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'busy', reasonCode: 'subagent-active' });
        server.close();
        // A subagent known only by its source, with no parent id, is still a subagent.
        await serveWith({ [SUB]: { status: { type: 'active', activeFlags: [] }, source: { subAgent: 'review' } } });
        store.getDb().prepare('DELETE FROM startup_control_channels').run();
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'busy', reasonCode: 'subagent-active' });
      });

      it('another thread in a status the protocol does not promise is unknown', async () => {
        await serveWith({ [OTHER]: { status: { type: 'somethingNew' } } });
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'other-thread-status-unknown' });
        server.close();
        await serveWith({ [OTHER]: { status: undefined } });
        store.getDb().prepare('DELETE FROM startup_control_channels').run();
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'other-thread-status-unknown' });
      });

      it('the bound thread\'s own state still decides first: busy, not loaded, and a changed channel', async () => {
        await serveWith({ [OTHER]: { status: { type: 'idle' } } });
        channel({ threadId: THREAD });
        server.state.threadStatus = { type: 'active', activeFlags: [] };
        assert.deepEqual(await observe(), { state: 'busy', reasonCode: 'thread-active' });
        store.getDb().prepare('DELETE FROM startup_control_channels').run();
        channel({ threadId: 'bound-but-gone' });
        assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-not-loaded' });
      });

      it('an idle answer beside other threads is still withheld when the channel changed under the read', async () => {
        await serve({
          'thread/loaded/list': () => ({ data: [THREAD, OTHER] }),
          'thread/read': (p) => {
            if (p.threadId === OTHER) store.getDb().prepare("UPDATE startup_control_channels SET state = 'closed'").run();
            return { thread: { id: p.threadId, cwd: PROJECT_PATH, status: { type: 'idle' } } };
          }
        });
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'channel-changed' });
      });
    });

    it('a second thread in ANOTHER directory does not', async () => {
      await serve({
        'thread/loaded/list': () => ({ data: [THREAD, 'other-thread'] }),
        'thread/read': (p) => ({ thread: { id: p.threadId, cwd: p.threadId === THREAD ? PROJECT_PATH : '/elsewhere', status: server.state.threadStatus } })
      });
      channel({ threadId: THREAD });
      assert.equal((await observe()).state, 'idle');
    });

    it('a recorded thread that is no longer loaded is unknown', async () => {
      await serve({ 'thread/loaded/list': () => ({ data: ['other-thread'] }) });
      channel({ threadId: THREAD });
      assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-not-loaded' });
    });

    it('a loaded thread that cannot be read makes it unknown rather than skipped', async () => {
      await serve({
        'thread/loaded/list': () => ({ data: [THREAD, 'unreadable'] }),
        'thread/read': (p) => {
          if (p.threadId === 'unreadable') throw Object.assign(new Error('nope'), { code: -32600 });
          return { thread: { id: p.threadId, cwd: PROJECT_PATH, status: { type: 'idle' } } };
        }
      });
      channel({ threadId: THREAD });
      assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'threads-unreadable' });
    });

    it('a version other than the recorded or installed one is unknown', async () => {
      await serve({ initialize: () => ({ userAgent: 'tangleclaw/0.157.0 (x)' }) });
      channel({ threadId: THREAD });
      assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'version-mismatch' });
      server.close();
      await serve();
      store.getDb().prepare('DELETE FROM startup_control_channels').run();
      channel({ threadId: THREAD, engineVersion: '0.155.0' });
      assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'version-mismatch' });
    });

    it('an unreachable app-server is unknown', async () => {
      channel({ threadId: THREAD, resolvedSocketPath: path.join(os.tmpdir(), 'tcb2-absent.sock') });
      assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'channel-unreachable' });
    });
  });

  describe('the receipt (acceptance case 3)', () => {
    it('accepted on the echoed clientId + bytes notification, applied on turn/completed, with the thread and server version recorded on the channel', async () => {
      await serve({
        'turn/start': (p) => {
          server.state.turnStarted = true;
          server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
          server.state.turn = { id: TURN, status: 'inProgress', items: [] };
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      // The notifications follow the adapter's own read-back, not a clock: that
      // read answers "in progress, nothing echoed", so acceptance can only come
      // from the notification, and the turn cannot finish before the read-back
      // runs. The request event fires after the answer is written, and socket
      // order carries item/completed ahead of turn/completed.
      let sequenced = false;
      server.on('request', ({ method }) => {
        if (method !== 'thread/turns/list' || !server.state.turnStarted || sequenced) return;
        sequenced = true;
        server.notify('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: [] } });
        server.notify('turn/started', { threadId: THREAD, turn: server.state.turn });
        server.notify('item/completed', { threadId: THREAD, turnId: TURN, item: server.state.userItem, completedAtMs: 1 });
        server.state.turn = finishedTurn('completed', { durationMs: 1976 });
        server.notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } });
        server.notify('turn/completed', { threadId: THREAD, turn: server.state.turn });
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
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      channel();
      const f = pendingFire();
      const handles = codex.fire({ session, project, sequenceId: 100, promptText: PROMPT, promptTextDigest: PROMPT_DIGEST, payloadDigest: DIGEST, onUpdate: f.onUpdate }, { reconnectPauseMs: 10 });
      // The adapter drops status changes that arrive before the fire is
      // accepted, so the waits start from acceptance, and each step waits for
      // the patch the previous one produced rather than a wall-clock offset.
      await handles.accepted;
      server.notify('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
      server.serverRequest('item/commandExecution/requestApproval', { threadId: THREAD, turnId: TURN, itemId: 'cmd-1', command: 'echo hi' });
      await untilPatch(f, (p) => p.reasonCode === 'approval_pending');
      server.notify('serverRequest/resolved', { requestId: 0 });
      server.notify('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: [] } });
      await untilPatch(f, (p, i) => p.reasonCode === null && f.patches.slice(0, i).some((x) => x.reasonCode === 'approval_pending'));
      server.notify('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
      server.serverRequest('item/tool/requestUserInput', { threadId: THREAD, turnId: TURN, itemId: 'q-1' });
      await untilPatch(f, (p) => p.reasonCode === 'user_input_pending');
      server.notify('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: [] } });
      server.state.turn = finishedTurn('completed');
      server.notify('turn/completed', { threadId: THREAD, turn: server.state.turn });
      const settled = await handles.settled;
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

    it('a fire sent without a trust entry keeps its dispatch note when a restart reconciles it (#2186)', async () => {
      const NOTE = 'Sent without a trust entry in Codex\'s config for /p: TangleClaw did not grant trust.';
      await serve({
        'thread/turns/list': () => ({ data: [{ id: TURN, status: 'completed', items: [{ type: 'userMessage', id: 'i', clientId: DIGEST, content: [{ type: 'text', text: PROMPT }] }] }], nextCursor: null })
      });
      server.state.turnStarted = true;
      channel();
      // The row a restart finds: sent with a note, its outcome unknown.
      const f = pendingFire('pending');
      f.onUpdate({ outcome: 'dispatching', reason: null, engineThreadId: THREAD, dispatchNote: NOTE });
      f.onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: 'the server restarted' });
      assert.equal(f.current().dispatchNote, NOTE);
      f.patches.length = 0;
      const row = await codex.reconcile({ session, fire: f.current(), onUpdate: f.onUpdate }, { stableIdleMs: 5 });
      assert.equal(row.outcome, 'applied');
      assert.equal(row.dispatchNote, NOTE, 'kept through reconciliation');
      assert.ok(f.patches.length > 0 && f.patches.every((p) => !('dispatchNote' in p)), 'reconciliation does not restate it; the row keeps it');
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
    it('parses the CLI version and the server version, and reads trust by canonical path: trusted, untrusted, absent, or unreadable', () => {
      assert.equal(codex._internal._parseVersion('codex-cli 0.156.1\n'), '0.156.1');
      assert.equal(codex._internal._parseVersion('nonsense'), null);
      assert.equal(codex._internal._serverVersion({ userAgent: 'tangleclaw-probe/0.156.1 (Mac OS 15.6.1; arm64) screen-256color (x; 0.0.0)' }), '0.156.1');
      assert.equal(codex._internal._serverVersion({}), null);
      assert.equal(codex._internal._trusted({ config: { projects: { '/a/b/': { trust_level: 'trusted' } } } }, '/a/b'), 'trusted');
      // An entry that says anything else is a recorded decision, not a missing one (#2186).
      assert.equal(codex._internal._trusted({ config: { projects: { '/a/b': { trust_level: 'untrusted' } } } }, '/a/b'), 'untrusted');
      assert.equal(codex._internal._trusted({ config: { projects: { '/a/b': {} } } }, '/a/b'), 'untrusted');
      assert.equal(codex._internal._trusted({ config: { projects: {} } }, '/a/b'), 'absent');
      assert.equal(codex._internal._trusted({ config: { projects: { '/x': { trust_level: 'trusted' } } } }, '/a/b'), 'absent');
      // A home that has trusted nothing answers null for the table; that is "no entry".
      assert.equal(codex._internal._trusted({ config: { projects: null } }, '/a/b'), 'absent');
      assert.equal(codex._internal._trusted({ config: {} }, '/a/b'), null);
      assert.equal(codex._internal._trusted({ config: { projects: [] } }, '/a/b'), null);
      assert.equal(codex._internal._trusted({}, '/a/b'), null);
    });

    it('isolates legacy launches only when the probed Codex version accepts --no-daemon', () => {
      const previous = codex._internal._version.version;
      try {
        codex._internal._version.version = null;
        assert.equal(codex.legacyLaunchCommand('codex'), 'codex');
        codex._internal._version.version = '0.154.0';
        assert.equal(codex.legacyLaunchCommand('codex'), 'codex');
        codex._internal._version.version = '0.156.1';
        assert.equal(codex.legacyLaunchCommand('codex'), 'codex --no-daemon');
        codex._internal._version.version = '0.157.1';
        assert.equal(
          codex.legacyLaunchCommand('codex --ask-for-approval never --sandbox workspace-write'),
          'codex --ask-for-approval never --sandbox workspace-write --no-daemon'
        );
        assert.equal(codex.legacyLaunchCommand('codex --no-daemon'), 'codex --no-daemon');
        codex._internal._version.version = '0.158.0';
        assert.equal(codex.legacyLaunchCommand('codex'), 'codex', 'future versions are not guessed compatible');
      } finally {
        codex._internal._version.version = previous;
      }
    });

    describe('judgeLaunchCommand: the last look at a Codex launch (#2233)', () => {
      const BIN = '/opt/fake/bin/codex';
      const probe = (version, enginePath = BIN) => ({ version, enginePath });
      const native = { resolvedSocketPath: '/private/tmp/fake-daemon/abc', enginePath: BIN, engineVersion: '0.156.1' };
      const judge = (over) => codex.judgeLaunchCommand({ engineId: 'codex', enginePath: BIN, probe: null, native: null, nativeVerifiedVersions: ['0.156.1'], ...over });

      it('allows the probed executable attached to the server this launch started', () => {
        assert.deepEqual(
          judge({ command: `${BIN} --remote unix:///private/tmp/fake-daemon/abc --ask-for-approval never`, native }),
          { applies: true, allowed: true, isolation: 'native-app-server' }
        );
      });

      it('allows the probed executable with --no-daemon on each verified version, and on no other', () => {
        for (const version of codex._internal.NO_DAEMON_VERSIONS) {
          assert.deepEqual(judge({ command: `${BIN} --sandbox workspace-write --no-daemon`, probe: probe(version) }), { applies: true, allowed: true, isolation: 'no-daemon' });
        }
        assert.ok(codex._internal.NO_DAEMON_VERSIONS.length > 0);
        for (const version of ['0.150.0', '0.154.0', '0.158.0', '0.161.0', '1.0.0']) {
          const verdict = judge({ command: `${BIN} --no-daemon`, probe: probe(version) });
          assert.equal(verdict.allowed, false, `${version} is not verified`);
          assert.equal(verdict.reasonCode, 'version_unverified');
          assert.ok(verdict.reason.includes(version) && verdict.reason.includes(BIN), 'the refusal names what was found');
        }
      });

      it('refuses when the version is unknown, or was measured on a different executable', () => {
        assert.equal(judge({ command: `${BIN} --no-daemon`, probe: null }).reasonCode, 'version_unknown');
        assert.equal(judge({ command: `${BIN} --no-daemon`, probe: probe(null) }).reasonCode, 'version_unknown');
        assert.equal(judge({ command: `${BIN} --no-daemon`, probe: probe('0.157.1', '/usr/local/bin/codex') }).reasonCode, 'version_unknown');
      });

      it('refuses a command that does not start with the probed executable', () => {
        for (const command of ['codex --no-daemon', '/usr/local/bin/codex --no-daemon', `env X=1 ${BIN} --no-daemon`, `${BIN}-beta --no-daemon`]) {
          assert.equal(judge({ command, probe: probe('0.157.1') }).reasonCode, 'command_not_pinned', command);
        }
      });

      it('refuses a verified version whose command carries no isolation flag, or carries it where Codex would not read it as one', () => {
        assert.equal(judge({ command: BIN, probe: probe('0.157.1') }).reasonCode, 'command_unisolated');
        assert.equal(judge({ command: `${BIN} --sandbox workspace-write`, probe: probe('0.157.1') }).reasonCode, 'command_unisolated');
        assert.equal(judge({ command: `${BIN} --no-daemonize`, probe: probe('0.157.1') }).reasonCode, 'command_unisolated');
        assert.equal(judge({ command: `${BIN} -- --no-daemon`, probe: probe('0.157.1') }).reasonCode, 'command_unparseable');
        for (const args of ['-c "x --no-daemon"', "-c 'x' --no-daemon", '--no-daemon; codex', '$(x) --no-daemon', '--no-daemon && codex', '`x` --no-daemon', '--no-daemon | cat']) {
          assert.equal(judge({ command: `${BIN} ${args}`, probe: probe('0.157.1') }).reasonCode, 'command_unparseable', args);
        }
      });

      it('refuses --remote to anything but the socket this launch started from this executable', () => {
        const command = `${BIN} --remote unix:///private/tmp/fake-daemon/abc`;
        assert.equal(judge({ command, native: null }).reasonCode, 'command_unisolated');
        assert.equal(judge({ command, native: { ...native, resolvedSocketPath: '/private/tmp/fake-daemon/other' } }).reasonCode, 'command_unisolated');
        assert.equal(judge({ command, native: { ...native, enginePath: '/usr/local/bin/codex' } }).reasonCode, 'command_unisolated');
        assert.equal(judge({ command: `${BIN} --sandbox workspace-write --remote unix:///private/tmp/fake-daemon/abc`, native, probe: probe('0.157.1') }).reasonCode, 'command_unisolated', 'the attachment must lead the arguments');
        assert.equal(judge({ command: `${BIN} --remote unix:///private/tmp/fake-daemon/abcd`, native }).reasonCode, 'command_unisolated');
      });

      it('allows the native attachment only for a server version the profile records as verified', () => {
        const command = `${BIN} --remote unix:///private/tmp/fake-daemon/abc`;
        assert.equal(judge({ command, native }).allowed, true);
        for (const [label, over] of [
          ['a server on another version', { native: { ...native, engineVersion: '0.157.1' } }],
          ['a server whose version was never recorded', { native: { ...native, engineVersion: undefined } }],
          ['a profile that records no verified versions', { native, nativeVerifiedVersions: null }],
          ['a profile whose list is empty', { native, nativeVerifiedVersions: [] }],
          ['a list that is not a list', { native, nativeVerifiedVersions: '0.156.1' }]
        ]) {
          const verdict = judge({ command, ...over });
          assert.equal(verdict.allowed, false, label);
          assert.equal(verdict.reasonCode, 'version_unverified', label);
        }
        // The legacy list does not vouch for the native channel: 0.157.1 accepts --no-daemon and is not verified to attach.
        assert.ok(codex._internal.NO_DAEMON_VERSIONS.includes('0.157.1'));
      });

      it('refuses isolation flags that are repeated, combined, written with `=`, or contradicted', () => {
        const remote = '--remote unix:///private/tmp/fake-daemon/abc';
        for (const args of [
          '--no-daemon --no-daemon',
          `${remote} --no-daemon`,
          `${remote} --remote unix:///private/tmp/fake-daemon/other`,
          `${remote} --remote unix:///private/tmp/fake-daemon/abc`,
          '--no-daemon --daemon',
          '--daemon --no-daemon',
          '--no-daemon --daemon=true',
          '--no-daemon=false',
          '--no-daemon --no-daemon=false',
          '--remote=unix:///private/tmp/fake-daemon/abc',
          `${remote} --remote=unix:///private/tmp/elsewhere`
        ]) {
          const verdict = judge({ command: `${BIN} ${args}`, native, probe: probe('0.157.1') });
          assert.equal(verdict.allowed, false, args);
          assert.equal(verdict.reasonCode, 'command_unparseable', args);
        }
      });

      it('refuses when no exact executable can be named', () => {
        for (const enginePath of [null, '', 'codex', "/opt/it's/codex", '/opt/line\nbreak/codex']) {
          assert.equal(judge({ command: 'codex --no-daemon', enginePath, probe: probe('0.157.1', enginePath) }).reasonCode, 'executable_unresolved', String(enginePath));
        }
      });

      it('a path with a space is one quoted word, in the builder and in the judgment alike', () => {
        const spaced = '/Users/Jo Smith/bin/codex';
        const built = codex.isolateLaunch({ engineId: 'codex', launchCmd: 'codex --sandbox workspace-write', shell: 'codex', enginePath: spaced }, { probeVersionSync: () => '0.157.1' });
        assert.equal(built.command, "'/Users/Jo Smith/bin/codex' --sandbox workspace-write --no-daemon");
        assert.equal(codex.judgeLaunchCommand({ engineId: 'codex', command: built.command, enginePath: spaced, probe: built.probe, native: null }).allowed, true);
        assert.equal(codex.judgeLaunchCommand({ engineId: 'codex', command: `${spaced} --no-daemon`, enginePath: spaced, probe: built.probe, native: null }).reasonCode, 'command_not_pinned', 'the unquoted form would run /Users/Jo');
      });

      it('every refusal carries a reason and a recovery that names the verified versions', () => {
        const verdict = judge({ command: 'codex', probe: probe('0.161.0') });
        assert.equal(verdict.applies, true);
        assert.equal(verdict.allowed, false);
        for (const version of codex._internal.NO_DAEMON_VERSIONS) assert.ok(verdict.recovery.includes(version));
        assert.match(verdict.recovery, /Nothing was started/);
        assert.match(verdict.recovery, /already running are not changed/);
      });

      it('reads no version cache: a verified cache does not rescue an unverified probe, nor the reverse', () => {
        const previous = codex._internal._version.version;
        try {
          codex._internal._version.version = '0.157.1';
          assert.equal(judge({ command: `${BIN} --no-daemon`, probe: probe('0.161.0') }).allowed, false);
          codex._internal._version.version = '0.161.0';
          assert.equal(judge({ command: `${BIN} --no-daemon`, probe: probe('0.157.1') }).allowed, true);
        } finally {
          codex._internal._version.version = previous;
        }
      });

      it('applies to anything that would run Codex, whatever names it; and to nothing else', () => {
        assert.equal(codex.judgeLaunchCommand({ engineId: 'claude', command: 'claude --foo', enginePath: '/opt/fake/bin/claude' }).applies, false);
        assert.equal(codex.judgeLaunchCommand({ engineId: 'openclaw:x', command: 'ssh -t host "cli"', enginePath: '/usr/bin/ssh' }).applies, false);
        assert.equal(codex.judgeLaunchCommand({ engineId: 'my-engine', command: 'codex', enginePath: null }).applies, true, 'the command names it');
        assert.equal(codex.judgeLaunchCommand({ engineId: 'my-engine', command: 'wrapper', enginePath: BIN }).applies, true, 'the executable names it');
        assert.equal(codex.judgeLaunchCommand({ engineId: 'codex', command: 'wrapper', enginePath: '/opt/x/wrapper' }).applies, true, 'the engine id names it');
        assert.equal(codex.judgeLaunchCommand({ engineId: 'my-engine', command: 'codex', enginePath: null }).allowed, false);
      });
    });

    describe('isolateLaunch: the legacy command on the exact executable (#2233)', () => {
      const BIN = '/opt/fake/bin/codex';

      it('builds the probed executable, the launch arguments, then --no-daemon, for a verified version only', () => {
        const asked = [];
        const deps = (version) => ({ probeVersionSync: (o) => { asked.push(o.enginePath); return version; } });
        assert.deepEqual(
          codex.isolateLaunch({ engineId: 'codex', launchCmd: 'codex --ask-for-approval never', shell: 'codex', enginePath: BIN }, deps('0.156.1')),
          { applies: true, command: `${BIN} --ask-for-approval never --no-daemon`, probe: { version: '0.156.1', enginePath: BIN } }
        );
        assert.equal(codex.isolateLaunch({ engineId: 'codex', launchCmd: 'codex --no-daemon', shell: 'codex', enginePath: BIN }, deps('0.157.1')).command, `${BIN} --no-daemon`, 'the flag is not doubled');
        for (const version of ['0.154.0', '0.161.0', null]) {
          assert.deepEqual(
            codex.isolateLaunch({ engineId: 'codex', launchCmd: 'codex', shell: 'codex', enginePath: BIN }, deps(version)),
            { applies: true, command: null, probe: { version, enginePath: BIN } }
          );
        }
        assert.ok(asked.length > 0 && asked.every((bin) => bin === BIN), 'only the exact executable is ever probed');
      });

      it('builds nothing when the launch command does not open with the profile command, and probes nothing for another engine', () => {
        let probes = 0;
        const deps = { probeVersionSync: () => { probes += 1; return '0.157.1'; } };
        assert.equal(codex.isolateLaunch({ engineId: 'codex', launchCmd: 'env X=1 codex', shell: 'codex', enginePath: BIN }, deps).command, null);
        probes = 0;
        assert.deepEqual(codex.isolateLaunch({ engineId: 'claude', launchCmd: 'claude', shell: 'claude', enginePath: '/opt/fake/bin/claude' }, deps), { applies: false });
        assert.equal(probes, 0);
      });
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
