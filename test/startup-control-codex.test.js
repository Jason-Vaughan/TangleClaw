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
   * Start a fire against the fake server without waiting on it, for cases
   * that act between its acceptance and its end.
   * @param {object} f - From `pendingFire`.
   * @param {object} [deps] - Adapter seams.
   * @returns {{accepted: Promise<object>, settled: Promise<object>}}
   */
  function startFire(f, deps = { reconnectPauseMs: 10 }) {
    return codex.fire({ session, project, sequenceId: 100, promptText: PROMPT, promptTextDigest: PROMPT_DIGEST, payloadDigest: DIGEST, onUpdate: f.onUpdate }, deps);
  }

  /**
   * Run `step` once, when the fake has answered the adapter's first `method`
   * request after the turn started. The fake emits `request` after it has
   * written that answer, so whatever `step` sends follows the answer on the
   * wire: the fake's side of a case is ordered by the adapter's own progress
   * and not by a clock a busy host can outrun.
   * @param {string} method - The adapter's request to follow.
   * @param {() => void} step - What the fake does then.
   * @returns {void}
   */
  function afterFirstRequest(method, step) {
    let done = false;
    server.on('request', (req) => {
      if (done || req.method !== method || !server.state.turnStarted) return;
      done = true;
      step();
    });
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

      it('an engine profile under another id that names this adapter: the fire reads that profile\'s patterns, the ones the wake reads for the session', async () => {
        const wakeTable = require('../lib/medusa-wake').ENGINE_WAKE_PROFILES;
        const variant = { ...wakeTable.codex, headerRe: /\bengine:\s+\S/, startingRe: /\bengine:\s+warming\b/ };
        const realProfile = codex._seams.wakeProfile;
        const asked = [];
        // What the wake's table would hold for a profile `codex-variant`.
        codex._seams.wakeProfile = (engineId) => { asked.push(engineId); return engineId === 'codex-variant' ? variant : wakeTable[engineId]; };
        try {
          await serve(NO_ENTRY);
          completeTheTurn();
          channel(LAUNCH_PANE, { engineId: 'codex-variant' });
          const witnessed = [];
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async (opts) => { witnessed.push(opts); return { shown: true }; } }).settled;
          assert.equal(settled.outcome, 'applied');
          assert.deepEqual(asked, ['codex-variant'], 'asked for the launch\'s own engine id');
          assert.equal(witnessed[0].headerRe, variant.headerRe);
          assert.equal(witnessed[0].startingRe, variant.startingRe);
          assert.notEqual(witnessed[0].startingRe, wakeTable.codex.startingRe, 'not the patterns of the profile that happens to be called codex');
        } finally {
          codex._seams.wakeProfile = realProfile;
        }
      });

      it('the two header patterns handed to the witness are the wake profile\'s own, and a profile that declares none holds the fire', async () => {
        const declared = require('../lib/medusa-wake').ENGINE_WAKE_PROFILES.codex;
        assert.ok(declared.headerRe instanceof RegExp && declared.startingRe instanceof RegExp, 'the bundled Codex profile declares both');
        await serve(NO_ENTRY);
        completeTheTurn();
        channel(LAUNCH_PANE);
        const witnessed = [];
        const first = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async (opts) => { witnessed.push(opts); return { shown: true }; } }).settled;
        assert.equal(first.outcome, 'applied');
        assert.equal(witnessed[0].headerRe, declared.headerRe, 'the same compiled pattern the wake\'s pane gate reads');
        assert.equal(witnessed[0].startingRe, declared.startingRe);
        server.close();
        server = null;

        const realProfile = codex._seams.wakeProfile;
        try {
          for (const undeclared of [undefined, (({ headerRe, startingRe, ...rest }) => rest)(declared), { ...declared, startingRe: undefined }]) {
            codex._seams.wakeProfile = () => undeclared;
            await serve(NO_ENTRY);
            store.getDb().prepare('DELETE FROM startup_control_channels').run();
            channel(LAUNCH_PANE);
            let consulted = 0;
            const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: async () => { consulted += 1; return { shown: true }; } }).settled;
            assert.equal(settled.reasonCode, 'pane_not_ready');
            assert.match(settled.reason, /headerPattern and startingPattern/);
            assert.match(settled.reason, /The engine profile in force for this session \(codex\)/, 'names the profile by the launch\'s engine id');
            assert.match(settled.reason, /restore those two fields in that profile/);
            assert.equal(consulted, 0, 'a pane that cannot be checked for a starting screen is not consulted');
            assert.equal(server.calls('turn/start').length, 0);
            server.close();
            server = null;
          }
        } finally {
          codex._seams.wakeProfile = realProfile;
        }
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

        it('a status row that ends with a warning and the key that shows it is still a composer at rest: the fire goes', async () => {
          // Codex appends `⚠ 1 warning · f2 to view` to its status row. The row
          // names a key, and it is not a dialog footer: the adapter's own list
          // of footer keys must not take it for one.
          assert.match(PANES.composerWarningStatus.rows[PANES.composerWarningStatus.y + 2], /⚠ 1 warning · f2 to view$/);
          await serve(NO_ENTRY);
          completeTheTurn();
          channel(LAUNCH_PANE);
          const settled = await fireWith(pendingFire(), { absentOn: ['0.156.1'], witness: witnessOver('composerWarningStatus', []) }).settled;
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

        it('as shipped, the same composer gets the fire on the one measured version', async () => {
          await serve(NO_ENTRY);
          completeTheTurn();
          channel(LAUNCH_PANE);
          const tmuxLog = [];
          const shipped = codexProfile.capabilities.startupControl.remoteTrustPrompt.absentOn;
          assert.deepEqual(shipped, ['0.156.1']);
          const settled = await fireWith(pendingFire(), { absentOn: shipped, witness: witnessOver('composer', tmuxLog) }).settled;
          assert.equal(settled.outcome, 'applied');
          assert.deepEqual(tmuxLog, ['pin-pane', 'read-visible-pane %7', 'read-visible-pane %7'], 'the witness read the pane, twice');
          assert.equal(server.calls('turn/start').length, 1);
          assert.match(settled.dispatchNote, /TangleClaw did not grant trust\./);
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

  describe('the launch gate and the automatic fire\'s last look (#2059)', () => {
    const paneWitness = require('../lib/pane-witness');
    const { CODEX_VISIBLE_PANES: PANES } = require('./_codex-visible-pane-fixtures');
    const codexProfile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
    const NO_ENTRY = { 'config/read': () => ({ config: { projects: { '/somewhere/else': { trust_level: 'trusted' } } } }) };
    /** What a launch records about its pane: the id, and the tmux server that issued it. */
    const LAUNCH_PANE = { paneId: '%7', paneServer: '4242.1790431343' };

    /**
     * The measured empty composer with one of its rows replaced.
     * @param {number} offset - Rows below the composer row (0 is the composer itself).
     * @param {string} row - The replacement.
     * @param {number} [x] - Cursor column, when the composer row changes.
     * @returns {{height: number, x: number, y: number, rows: string[]}}
     */
    const composerWith = (offset, row, x = PANES.composer.x) => {
      const rows = [...PANES.composer.rows];
      rows[PANES.composer.y + offset] = row;
      return { ...PANES.composer, x, rows };
    };
    // Constructed from the measured composer, and labelled so: the measured
    // captures of these screens are the fixtures file's own entries.
    const TYPED = composerWith(0, '\u001b[1m›\u001b[0m hello', 7);
    const BUSY = composerWith(-2, '• Working (3s • esc to interrupt)');
    const MOVED = composerWith(-3, '  Tip: a different tip is drawn here now');

    /**
     * A pane the test can change, and a witness over it as the fire service
     * builds one: the adapter's options first, one read or two as it asks, and
     * a pane that could not be pinned or read marked `unavailable`.
     * @param {object|Error|Function} frame - What a read returns, or throws; a function is asked each read.
     * @returns {{frame: *, pin: *, log: string[], onGap: (Function|null), afterWitness: (Function|null), witness: Function}}
     */
    const pane = (frame = PANES.composer) => {
      const screen = { frame, pin: '%7', log: [], onGap: null, afterWitness: null, readAs: null, engineProfile: codexProfile, wakeProfile: require('../lib/medusa-wake').ENGINE_WAKE_PROFILES.codex };
      screen.witness = async (opts) => {
        const { single, ...shape } = opts;
        let unread = false;
        const ask = single === true ? paneWitness.composerShownOnce : paneWitness.composerShown;
        const seen = await ask({
          ...shape, tmuxName: 'tc-deputy', engineProfile: screen.engineProfile, wakeProfile: screen.wakeProfile
        }, {
          gapMs: 0,
          sleep: async () => { if (screen.onGap) screen.onGap(); },
          pin: () => {
            if (screen.pin instanceof Error) { unread = true; throw screen.pin; }
            return screen.pin;
          },
          read: (name, paneId) => {
            const kind = single === true ? 'read-once' : 'read';
            screen.log.push(kind);
            const f = typeof screen.frame === 'function' ? screen.frame(kind) : screen.frame;
            if (f instanceof Error) { unread = true; throw f; }
            return { paneId: screen.readAs || paneId, ...f, rows: [...f.rows] };
          }
        });
        if (screen.afterWitness) screen.afterWitness(single === true);
        return unread && seen.shown !== true ? { ...seen, unavailable: true } : seen;
      };
      return screen;
    };
    const otherServer = () => Object.assign(new Error('another tmux server answered'), { tcOtherServer: true });

    /**
     * The witness refusals that come back as an answer and not from a failed
     * tmux call. Nothing establishes that the pane could not be read, so none
     * of them may be worded as an unavailable proof; each is said as what it
     * is, with the witness's own reason. Each builder takes the screen to
     * spoil and returns it.
     */
    const REFUSED_WITHOUT_A_FAILED_READ = [
      ['a frame from another pane', (screen) => Object.assign(screen, { readAs: '%99' }), 'the pane that was read is not the pane that was pinned'],
      ['a misaligned capture', (screen) => Object.assign(screen, { frame: { ...PANES.composer, rows: PANES.composer.rows.slice(1) } }), 'the pane and its cursor could not be read row for row'],
      ['an unreadable guarded-dialog declaration', (screen) => Object.assign(screen, { engineProfile: { ...codexProfile, launch: { ...codexProfile.launch, guardedDialogs: [{ id: 'update', match: '(' }] } } }), 'the engine profile declares a guarded dialog that could not be read, so a dialog could not be ruled out'],
      ['no composer pattern', (screen) => Object.assign(screen, { wakeProfile: null }), 'this session has no pane, or its engine no composer pattern, to read']
    ];

    describe('awaitLaunchReady', () => {
      /**
       * Ask the gate with a clock the test owns, so a 90-second window costs nothing.
       * @param {object} screen - From `pane`.
       * @param {object} [over] - Input overrides.
       * @returns {Promise<{answer: object, looks: number}>}
       */
      const gate = async (screen, over = {}) => {
        let clock = 0;
        let waits = 0;
        const answer = await codex.awaitLaunchReady({
          session, project, sequenceId: 100, witness: screen ? screen.witness : undefined, windowMs: 6000, pollMs: 1500, ...over
        }, { now: () => clock, wait: async (ms) => { clock += ms; waits += 1; if (over.onWait) over.onWait(waits); } });
        return { answer, looks: waits + 1 };
      };

      it('the session-1410 shape: Codex\'s DEFAULT status line, an idle thread, an empty composer: ready on the first look, and no status-line word was waited for', async () => {
        await serve();
        channel(LAUNCH_PANE);
        assert.ok(!PANES.composer.rows.join('\n').includes('Ready'), 'the default status line carries no at-rest item');
        const screen = pane(PANES.composer);
        const { answer, looks } = await gate(screen);
        assert.deepEqual(answer, { ready: true });
        assert.equal(looks, 1);
        assert.deepEqual(screen.log, ['read', 'read'], 'the pane was read twice by the witness and nothing was sent to it');
        assert.equal(server.calls('turn/start').length, 0, 'the gate sends nothing');
        assert.equal(server.calls('account/read').length + server.calls('account/rateLimits/read').length + server.calls('config/read').length, 0, 'and reads only the launch\'s thread');
      });

      it('ready on every measured composer at rest, and on a custom status line that never says Ready', async () => {
        assert.ok(!PANES.composerCustomStatus.rows.join('\n').includes('Ready'));
        for (const name of ['composerDefaultStatusSignedIn', 'composerCustomStatus', 'composerAfterUpdateSkipped', 'composerOperatorStatus', 'composerWarningStatus']) {
          const frame = PANES[name];
          await serve();
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(LAUNCH_PANE);
          assert.deepEqual((await gate(pane(frame))).answer, { ready: true }, name);
          server.close();
          server = null;
        }
      });

      it('the thread is read idle again AFTER the pane was witnessed', async () => {
        await serve();
        channel(LAUNCH_PANE);
        const screen = pane();
        let readsAtWitness = null;
        screen.afterWitness = () => { readsAtWitness = server.calls('thread/read').length; };
        assert.deepEqual((await gate(screen)).answer, { ready: true });
        assert.equal(server.calls('thread/read').length, readsAtWitness + 1);
      });

      it('AN IDLE THREAD ALONE IS NEVER READY: each pane that is not a proven empty composer holds the gate to the window\'s end, named', async () => {
        const cases = [
          ['the folder-trust prompt', PANES.trustPrompt, /Codex was showing its folder-trust prompt in the pane \(read from the pane\)/],
          ['the update prompt', PANES.updatePrompt, /Codex was showing its update prompt in the pane/],
          ['the opening screen', PANES.openingScreen, /the pane was not seen at an empty composer: the engine is still starting/],
          ['typed text', TYPED, /the pane was not seen at an empty composer: /],
          ['a running turn', BUSY, /the pane was not seen at an empty composer: a turn is running/],
          ['a status line of one item (measured)', PANES.composerSingleItemStatus, /something other than a status row is drawn below the composer/]
        ];
        for (const [name, frame, said] of cases) {
          await serve();
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(LAUNCH_PANE);
          const { answer, looks } = await gate(pane(frame));
          assert.equal(answer.ready, false, name);
          assert.equal(answer.unavailable, false, `${name}: the pane was read, so this is not an unavailable proof`);
          assert.match(answer.observation, said, name);
          assert.ok(answer.remedy, name);
          assert.equal(looks, 4, `${name}: it kept looking until the window ended`);
          assert.ok(server.calls('thread/read').length >= looks, 'the thread answered idle at every look');
          assert.equal(server.calls('turn/start').length, 0);
          server.close();
          server = null;
        }
      });

      it('a pane that changes between the witness\'s two reads is not ready', async () => {
        await serve();
        channel(LAUNCH_PANE);
        const screen = pane(() => (screen.log.length % 2 === 1 ? PANES.composer : MOVED));
        const { answer } = await gate(screen);
        assert.equal(answer.ready, false);
        assert.match(answer.observation, /the pane changed between two reads a second apart/);
      });

      it('a thread that turns busy after the pane was witnessed is not ready', async () => {
        await serve();
        channel(LAUNCH_PANE);
        const screen = pane();
        screen.afterWitness = () => { server.state.threadStatus = { type: 'active', activeFlags: [] }; };
        const { answer } = await gate(screen, { windowMs: 1000 });
        assert.equal(answer.ready, false);
        assert.equal(answer.unavailable, false);
        assert.match(answer.observation, /the launch's thread was active, not idle/);
      });

      it('a thread that is not idle, or not there yet, is not ready, and the pane is not consulted', async () => {
        await serve();
        channel(LAUNCH_PANE);
        server.state.threadStatus = { type: 'active', activeFlags: [] };
        let screen = pane();
        let r = await gate(screen);
        assert.match(r.answer.observation, /the launch's thread was active, not idle/);
        assert.deepEqual(screen.log, []);
        server.close();
        await serve({ 'thread/loaded/list': () => ({ data: [], nextCursor: null }) });
        store.getDb().prepare('DELETE FROM startup_control_channels').run();
        channel(LAUNCH_PANE);
        screen = pane();
        r = await gate(screen);
        assert.equal(r.answer.unavailable, false);
        assert.match(r.answer.observation, /has not opened a thread for the project directory yet/);
        assert.ok(screen.log.every((kind) => kind === 'read-once'), 'one read a look, only to name a dialog');
        assert.equal(r.answer.ready, false, 'a composer with no thread behind it is not ready');
      });

      it('the probe-update shape: no thread yet because a startup dialog is up: the row names the dialog and what to do, read from the pane', async () => {
        for (const [frame, id, action] of [[PANES.updatePrompt, 'update', /Escape skips it/], [PANES.trustPrompt, 'folder-trust', /Answer Codex's folder-trust prompt/]]) {
          await serve({ 'thread/loaded/list': () => ({ data: [], nextCursor: null }) });
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(LAUNCH_PANE);
          const screen = pane(frame);
          const { answer, looks } = await gate(screen);
          assert.equal(answer.ready, false, id);
          assert.equal(answer.unavailable, false, id);
          assert.match(answer.observation, new RegExp(`Codex was showing its ${id} prompt in the pane \\(read from the pane\\)`));
          assert.match(answer.remedy, action);
          assert.match(answer.remedy, /Then press Fire startup prompt\.$/);
          assert.equal(looks, 4, 'a dialog can be answered, so the gate keeps looking');
          assert.equal(server.calls('turn/start').length, 0);
          server.close();
          server = null;
        }
      });

      it('with no thread and a pane that cannot be read, the thread is what is reported: the pane read was only for a dialog\'s name', async () => {
        await serve({ 'thread/loaded/list': () => ({ data: [], nextCursor: null }) });
        channel(LAUNCH_PANE);
        for (const screen of [pane(new Error('no server running')), null]) {
          const { answer } = await gate(screen);
          assert.equal(answer.ready, false);
          assert.match(answer.observation, /has not opened a thread for the project directory yet/);
        }
      });

      it('becomes ready when the pane does: the opening screen, then the composer', async () => {
        await serve();
        channel(LAUNCH_PANE);
        const screen = pane(PANES.openingScreen);
        const { answer, looks } = await gate(screen, { onWait: (n) => { if (n === 2) screen.frame = PANES.composer; } });
        assert.deepEqual(answer, { ready: true });
        assert.equal(looks, 3);
      });

      it('at the window\'s end the answer is the LAST thing observed, not the first', async () => {
        await serve();
        channel(LAUNCH_PANE);
        const screen = pane(PANES.openingScreen);
        const { answer } = await gate(screen, { onWait: (n) => { if (n === 1) screen.frame = PANES.updatePrompt; } });
        assert.match(answer.observation, /update prompt/);
      });

      it('A PROOF THAT COULD NOT BE MADE is unavailable, never a pane seen unready: an unreadable pane, a second pane, no witness', async () => {
        const cases = [
          ['an unreadable pane', () => pane(new Error('no server running')), /the pane could not be read/],
          ['a second pane', () => Object.assign(pane(), { pin: new Error('2 panes') }), /does not have exactly one pane to read/],
          ['no witness at all', () => null, /this session's pane could not be consulted/]
        ];
        for (const [name, build, said] of cases) {
          await serve();
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(LAUNCH_PANE);
          const { answer, looks } = await gate(build());
          assert.equal(answer.ready, false, name);
          assert.equal(answer.unavailable, true, name);
          assert.match(answer.observation, said, name);
          assert.ok(!/at an empty composer/.test(answer.observation), `${name}: it says nothing of a composer it could not read`);
          assert.equal(looks, 4, `${name}: it may clear, so the gate keeps looking`);
          server.close();
          server = null;
        }
      });

      it('THE TWO WORDINGS, AT THE GATE: a refusal with no failed read is "not seen at an empty composer" with the witness\'s reason; a thrown read is an unavailable proof', async () => {
        for (const [name, spoil, why] of REFUSED_WITHOUT_A_FAILED_READ) {
          await serve();
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(LAUNCH_PANE);
          const { answer } = await gate(spoil(pane()));
          assert.equal(answer.ready, false, name);
          assert.equal(answer.unavailable, false, `${name}: nothing shows the read failed, so it is not called unavailable`);
          assert.equal(answer.observation, `the pane was not seen at an empty composer: ${why}`, name);
          assert.equal(server.calls('turn/start').length, 0, name);
          server.close();
          server = null;
        }
        await serve();
        store.getDb().prepare('DELETE FROM startup_control_channels').run();
        channel(LAUNCH_PANE);
        const { answer } = await gate(pane(new Error('no server running')));
        assert.equal(answer.unavailable, true);
        assert.equal(answer.observation, 'the pane could not be read');
      });

      it('a pane that is not the launch\'s own, another tmux server, or no pane on record: unavailable, and answered at once because waiting cannot clear it', async () => {
        const cases = [
          ['a replacement pane', LAUNCH_PANE, () => Object.assign(pane(), { pin: '%40' }), /the session's pane is not the pane this launch created/],
          ['another tmux server', LAUNCH_PANE, () => pane(otherServer()), /the tmux server is not the one this launch's pane was created in/],
          ['no pane on record', {}, () => pane(), /the pane this launch created was not recorded/]
        ];
        for (const [name, recorded, build, said] of cases) {
          await serve();
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel(recorded);
          const { answer, looks } = await gate(build());
          assert.equal(answer.ready, false, name);
          assert.equal(answer.unavailable, true, name);
          assert.match(answer.observation, said, name);
          assert.match(answer.remedy, /relaunch the session/, name);
          assert.equal(looks, 1, name);
          assert.equal('lasting' in answer, false);
          server.close();
          server = null;
        }
      });

      it('a channel that cannot answer is unavailable: no app-server, a thread list that fails, a thread re-read that fails', async () => {
        channel(LAUNCH_PANE);
        let r = await gate(pane());
        assert.equal(r.answer.unavailable, true);
        assert.match(r.answer.observation, /the app-server did not answer/);
        assert.equal(r.looks, 4);

        await serve({ 'thread/loaded/list': () => { throw Object.assign(new Error('internal /private/secret'), { code: -32603 }); } });
        store.getDb().prepare('DELETE FROM startup_control_channels').run();
        channel(LAUNCH_PANE);
        r = await gate(pane());
        assert.equal(r.answer.unavailable, true);
        assert.match(r.answer.observation, /the loaded threads could not all be read over the channel/);
        assert.ok(!r.answer.observation.includes('/private/secret'));
        server.close();

        let fail = false;
        await serve({ 'thread/read': (p) => { if (fail) throw Object.assign(new Error('gone'), { code: -32603 }); return { thread: { id: p.threadId, cwd: PROJECT_PATH, status: { type: 'idle' } } }; } });
        store.getDb().prepare('DELETE FROM startup_control_channels').run();
        channel({ ...LAUNCH_PANE, threadId: THREAD });
        const screen = pane();
        screen.afterWitness = () => { fail = true; };
        r = await gate(screen, { windowMs: 1000 });
        assert.equal(r.answer.unavailable, true);
        assert.match(r.answer.observation, /the launch's thread could not be read over the channel/);
      });

      it('a loaded thread that cannot be read is a read that was not made: unavailable, not "no thread yet"', async () => {
        await serve({ 'thread/read': () => { throw Object.assign(new Error('gone /private/secret'), { code: -32603 }); } });
        channel(LAUNCH_PANE);
        const screen = pane();
        const { answer, looks } = await gate(screen);
        assert.equal(answer.ready, false);
        assert.equal(answer.unavailable, true);
        assert.match(answer.observation, /the loaded threads could not all be read over the channel/);
        assert.ok(!answer.observation.includes('/private/secret'));
        assert.deepEqual(screen.log, [], 'and the pane is not read to name a dialog on it');
        assert.equal(looks, 4);
      });

      it('a channel that records no socket is unavailable at once: there is nothing to wait for', async () => {
        await serve();
        channel({ ...LAUNCH_PANE, resolvedSocketPath: null });
        const { answer, looks } = await gate(pane());
        assert.equal(answer.unavailable, true);
        assert.match(answer.observation, /the channel records no socket/);
        assert.match(answer.remedy, /relaunch the session/);
        assert.equal(looks, 1);
      });

      it('no open channel, or a channel of another launch: unavailable, at once', async () => {
        await serve();
        let r = await gate(pane());
        assert.equal(r.answer.unavailable, true);
        assert.match(r.answer.observation, /no open native channel/);
        assert.equal(r.looks, 1);
        channel(LAUNCH_PANE);
        r = await gate(pane(), { sequenceId: 999 });
        assert.match(r.answer.observation, /belongs to a different launch/);
        assert.equal(r.looks, 1);
      });

      it('a profile with no starting patterns never sets the gate ready: the pane is not consulted, and the sentence names the two fields, not an unavailable proof', async () => {
        await serve();
        channel(LAUNCH_PANE);
        const realProfile = codex._seams.wakeProfile;
        const { headerRe, startingRe, ...undeclared } = realProfile('codex');
        void headerRe; void startingRe;
        try {
          codex._seams.wakeProfile = () => undeclared;
          const screen = pane();
          const { answer, looks } = await gate(screen);
          assert.equal(answer.ready, false);
          assert.equal(answer.unavailable, false, 'a configuration fault is not an unavailable proof');
          assert.match(answer.whole, /declares no capabilities\.wake\.headerPattern and startingPattern/);
          assert.match(answer.whole, /This does not clear by itself/);
          assert.deepEqual(screen.log, []);
          assert.equal(looks, 1);
        } finally {
          codex._seams.wakeProfile = realProfile;
        }
      });

      it('the gate is the adapter\'s own window: 90 seconds, as the gate it replaces for this launch', () => {
        assert.equal(codex._internal.LAUNCH_READY_WINDOW_MS, 90000);
        assert.equal(codex._internal.LAUNCH_READY_WINDOW_MS, require('../lib/sessions').PANE_READY_TIMEOUT_MS);
      });
    });

    describe('the automatic fire reads the pane and the thread once more, immediately before turn/start', () => {
      /** Finish the turn once the adapter has read it back. */
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
      /**
       * The launch's automatic fire, as the fire service sends it.
       * @param {object} f - From `pendingFire`.
       * @param {object} screen - From `pane`.
       * @param {object} [over] - Input overrides.
       * @returns {Promise<object>} The settled row.
       */
      const fireAuto = (f, screen, over = {}) => codex.fire({
        session, project, sequenceId: 100, promptText: PROMPT, promptTextDigest: PROMPT_DIGEST, payloadDigest: DIGEST, onUpdate: f.onUpdate,
        trustException: { absentOn: ['0.156.1'], witness: screen.witness }, automatic: true, paneWitness: screen.witness, ...over
      }, { reconnectPauseMs: 10 }).settled;
      const FOLDERS = [['a trusted folder', {}], ['a folder with no trust entry', NO_ENTRY]];
      /** The fire rows written for the launch. */
      const fireRows = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM startup_prompt_fires').get().n;

      for (const [folder, handlers] of FOLDERS) {
        const noEntry = handlers === NO_ENTRY;
        /** A pane that is the composer for the allowance's two reads and `then` at the send-time read. */
        const changedAtTheSend = (then) => pane((kind) => (kind === 'read-once' ? then : PANES.composer));

        describe(folder, () => {
          it('an unchanged pane and thread: exactly one turn/start, after one fresh pane read and one more thread read', async () => {
            await serve(handlers);
            completeTheTurn();
            channel(LAUNCH_PANE);
            const screen = pane();
            let threadReadsAtLastLook = null;
            screen.afterWitness = (single) => { if (single) threadReadsAtLastLook = server.calls('thread/read').length; };
            const f = pendingFire();
            const settled = await fireAuto(f, screen);
            assert.equal(settled.outcome, 'applied');
            assert.equal(server.calls('turn/start').length, 1);
            assert.deepEqual(screen.log, noEntry ? ['read', 'read', 'read-once'] : ['read-once'], 'the allowance\'s two reads where there is no entry, then ONE read at the send');
            const order = server.received.filter((m) => m.method !== undefined && m.id !== undefined).map((m) => m.method);
            assert.equal(order.slice(0, order.indexOf('turn/start')).filter((m) => m === 'thread/read').length, threadReadsAtLastLook + 1, 'exactly one thread read between the last pane read and the send');
            assert.equal(order[order.indexOf('turn/start') - 1], 'thread/read', 'and nothing is asked of the engine between that read and the send');
            assert.equal(fireRows(), 1);
          });

          it('A STALE READY GATE IS NOT A PERMISSION: text typed into the composer after the gate passed is not sent over', async () => {
            await serve(handlers);
            channel(LAUNCH_PANE);
            const f = pendingFire();
            const settled = await fireAuto(f, changedAtTheSend(TYPED));
            assert.equal(settled.outcome, 'blocked');
            assert.equal(settled.reasonCode, 'pane_not_ready');
            assert.match(settled.reason, /^The pane was seen ready at the launch gate and was not seen ready immediately before the send, so nothing was sent: the pane was not seen at an empty composer: /);
            assert.ok(settled.reason.endsWith('Press Fire startup prompt once the pane shows an empty composer.'), settled.reason);
            assert.equal(server.calls('turn/start').length, 0);
            assert.equal(fireRows(), 1);
            assert.deepEqual(f.patches.map((p) => p.outcome), ['blocked'], 'one row, settled once, never dispatching');
          });

          it('a dialog that came up before the send (the update prompt, the trust prompt) stops it, named', async () => {
            for (const [frame, id] of [[PANES.updatePrompt, 'update'], [PANES.trustPrompt, 'folder-trust']]) {
              await serve(handlers);
              store.getDb().prepare('DELETE FROM startup_control_channels').run();
              store.getDb().prepare('DELETE FROM startup_prompt_fires').run();
              channel(LAUNCH_PANE);
              const settled = await fireAuto(pendingFire(), changedAtTheSend(frame));
              assert.equal(settled.outcome, 'blocked', id);
              assert.equal(settled.reasonCode, 'pane_not_ready', id);
              assert.match(settled.reason, new RegExp(`Codex was showing its ${id} prompt in the pane \\(read from the pane\\)`));
              assert.match(settled.reason, /Then press Fire startup prompt\.$/);
              assert.ok(settled.reason.length <= 500);
              assert.equal(server.calls('turn/start').length, 0, id);
              assert.equal(fireRows(), 1);
              server.close();
              server = null;
            }
          });

          it('a busy marker drawn before the send stops it', async () => {
            await serve(handlers);
            channel(LAUNCH_PANE);
            const settled = await fireAuto(pendingFire(), changedAtTheSend(BUSY));
            assert.equal(settled.reasonCode, 'pane_not_ready');
            assert.match(settled.reason, /a turn is running/);
            assert.equal(server.calls('turn/start').length, 0);
          });

          it('a thread that turns active after the last pane read stops it', async () => {
            await serve(handlers);
            channel(LAUNCH_PANE);
            const screen = pane();
            screen.afterWitness = (single) => { if (single) server.state.threadStatus = { type: 'active', activeFlags: [] }; };
            const settled = await fireAuto(pendingFire(), screen);
            assert.equal(settled.outcome, 'blocked');
            assert.equal(settled.reasonCode, 'pane_not_ready');
            assert.match(settled.reason, /the launch's thread was active, not idle/);
            assert.equal(server.calls('turn/start').length, 0);
            assert.equal(fireRows(), 1);
          });

          it('A LAST LOOK THAT COULD NOT BE MADE sends nothing and says the proof was unavailable: the pane unreadable, another tmux server, the thread read unanswered', async () => {
            const cases = [
              ['the pane cannot be read', () => changedAtTheSend(new Error('no server running: /private/secret/sock'))],
              ['the tmux server is another one', () => changedAtTheSend(otherServer())],
              ['the channel does not answer the thread read', () => {
                const screen = pane();
                screen.afterWitness = (single) => { if (single) screen.failThread = true; };
                return screen;
              }]
            ];
            for (const [name, build] of cases) {
              const screen = build();
              await serve({ ...handlers, 'thread/read': (p) => { if (screen.failThread) throw Object.assign(new Error('gone /private/secret'), { code: -32603 }); return { thread: { id: p.threadId, cwd: PROJECT_PATH, status: { type: 'idle' } } }; } });
              store.getDb().prepare('DELETE FROM startup_control_channels').run();
              store.getDb().prepare('DELETE FROM startup_prompt_fires').run();
              channel(LAUNCH_PANE);
              const settled = await fireAuto(pendingFire(), screen);
              assert.equal(settled.outcome, 'blocked', name);
              assert.equal(settled.reasonCode, 'pane_not_ready', name);
              assert.match(settled.reason, /^The proof that the pane still showed an empty composer and an idle thread was unavailable immediately before the send, so nothing was sent: /, name);
              assert.ok(!/was seen ready at the launch gate/.test(settled.reason), `${name}: not worded as a pane seen unready`);
              assert.ok(!settled.reason.includes('/private/secret'), name);
              assert.equal(server.calls('turn/start').length, 0, name);
              assert.equal(fireRows(), 1, name);
              server.close();
              server = null;
            }
          });

          it('no witness for the last look, or a profile with no starting patterns, sends nothing', async () => {
            await serve(handlers);
            channel(LAUNCH_PANE);
            const screen = pane();
            let settled = await fireAuto(pendingFire(), screen, { paneWitness: undefined });
            assert.equal(settled.reasonCode, 'pane_not_ready');
            assert.match(settled.reason, /was unavailable immediately before the send.*this session's pane could not be consulted/);
            assert.equal(server.calls('turn/start').length, 0);
            if (noEntry) return;
            const realProfile = codex._seams.wakeProfile;
            const { headerRe, startingRe, ...undeclared } = realProfile('codex');
            void headerRe; void startingRe;
            try {
              codex._seams.wakeProfile = () => undeclared;
              store.getDb().prepare('DELETE FROM startup_prompt_fires').run();
              settled = await fireAuto(pendingFire(), pane());
              assert.equal(settled.reasonCode, 'pane_not_ready');
              assert.match(settled.reason, /^The engine profile in force for this session \(codex\) declares no capabilities\.wake\.headerPattern and startingPattern/);
              assert.ok(!/unavailable/.test(settled.reason));
              assert.equal(server.calls('turn/start').length, 0);
            } finally {
              codex._seams.wakeProfile = realProfile;
            }
          });
        });
      }

      it('THE TWO WORDINGS, AT THE SEND: every refusal sends nothing; one with no failed read says "not seen ready … not seen at an empty composer" with the witness\'s reason, a thrown read says the proof was unavailable', async () => {
        for (const [name, spoil, why] of REFUSED_WITHOUT_A_FAILED_READ) {
          await serve();
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          store.getDb().prepare('DELETE FROM startup_prompt_fires').run();
          channel(LAUNCH_PANE);
          const settled = await fireAuto(pendingFire(), spoil(pane()));
          assert.equal(settled.outcome, 'blocked', name);
          assert.equal(settled.reasonCode, 'pane_not_ready', name);
          assert.equal(settled.reason, `The pane was seen ready at the launch gate and was not seen ready immediately before the send, so nothing was sent: the pane was not seen at an empty composer: ${why}. Press Fire startup prompt once the pane shows an empty composer.`, name);
          assert.ok(!/unavailable/.test(settled.reason), name);
          assert.equal(server.calls('turn/start').length, 0, name);
          server.close();
          server = null;
        }
        await serve();
        store.getDb().prepare('DELETE FROM startup_control_channels').run();
        store.getDb().prepare('DELETE FROM startup_prompt_fires').run();
        channel(LAUNCH_PANE);
        const settled = await fireAuto(pendingFire(), pane(new Error('no server running')));
        assert.equal(settled.reason, 'The proof that the pane still showed an empty composer and an idle thread was unavailable immediately before the send, so nothing was sent: the pane could not be read. Press Fire startup prompt once the pane shows an empty composer.');
        assert.ok(!/not seen/.test(settled.reason));
        assert.equal(server.calls('turn/start').length, 0);
      });

      it('a long observation gives way before the remedy does: the stored reason keeps its last sentence', async () => {
        await serve();
        channel(LAUNCH_PANE);
        const long = { shown: false, dialog: null, why: `the pane showed ${'something very long '.repeat(40)}` };
        const settled = await fireAuto(pendingFire(), { witness: async () => long });
        assert.equal(settled.reason.length, 500);
        assert.ok(settled.reason.includes('…'));
        assert.ok(settled.reason.endsWith('Press Fire startup prompt once the pane shows an empty composer.'));
      });

      it('AN OPERATOR\'S FIRE IS UNCHANGED: in a trusted folder the pane is never consulted, whatever it shows, and only a literal `automatic: true` is the launch\'s fire', async () => {
        for (const automatic of [undefined, false, 'true', 1]) {
          await serve();
          completeTheTurn();
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          // A launch's prompt revision is applied once; each pass is its own launch's fire.
          store.getDb().prepare('DELETE FROM startup_prompt_fires').run();
          channel(LAUNCH_PANE);
          const screen = pane(PANES.updatePrompt);
          const settled = await fireAuto(pendingFire(), screen, { automatic });
          assert.equal(settled.outcome, 'applied', String(automatic));
          assert.deepEqual(screen.log, [], String(automatic));
          server.close();
          server = null;
        }
      });
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

    it('idle and active map to idle and busy, and nothing is spent or checked for account or quota', async () => {
      await serve();
      channel({ threadId: THREAD });
      assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
      server.state.threadStatus = { type: 'active', activeFlags: ['waitingOnApproval'] };
      assert.deepEqual(await observe(), { state: 'busy', reasonCode: 'thread-active' });
      for (const m of ['turn/start', 'account/read', 'account/rateLimits/read', 'thread/resume']) {
        assert.equal(server.calls(m).length, 0, `${m} is never called by an observation`);
      }
    });

    describe('a folder Codex was told not to trust (#2186)', () => {
      /** A `config/read` handler answering with the given projects table. */
      const projects = (table) => ({ 'config/read': () => ({ config: { projects: table }, origins: {} }) });
      /**
       * Run `fn` with warnings captured.
       * @param {(lines: string[]) => Promise<void>} fn - The body.
       * @returns {Promise<void>}
       */
      async function withWarnings(fn) {
        const logger = require('../lib/logger');
        const lines = [];
        logger.setLevel('warn');
        logger.setConsoleStream({ write: (line) => { lines.push(String(line)); return true; } });
        try {
          await fn(lines);
        } finally {
          logger.setConsoleStream(null);
          setLevel('error');
        }
      }
      const unreadWarnings = (lines) => lines.filter((l) => l.includes('trust for the project directory is not established')).length;

      beforeEach(() => codex._internal._trustUnreadWarned.clear());

      it('an idle thread in a folder with an entry that is not trusted is held, under its own code', async () => {
        await serve(projects({ [PROJECT_PATH]: { trust_level: 'untrusted' } }));
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'held', reasonCode: 'folder-untrusted' });
        assert.equal(server.calls('turn/start').length, 0);
      });

      it('an entry with any value but trusted, or with none, is held as well', async () => {
        for (const entry of [{ trust_level: 'on-request' }, {}, null]) {
          await serve(projects({ [PROJECT_PATH]: entry }));
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel({ threadId: THREAD });
          assert.deepEqual(await observe(), { state: 'held', reasonCode: 'folder-untrusted' }, JSON.stringify(entry));
          server.close();
        }
      });

      it('a trusted entry, no entry for the folder, and a null table are all idle', async () => {
        for (const table of [{ [PROJECT_PATH]: { trust_level: 'trusted' } }, { '/somewhere/else': { trust_level: 'untrusted' } }, {}, null]) {
          await serve(projects(table));
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel({ threadId: THREAD });
          assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' }, JSON.stringify(table));
          server.close();
        }
      });

      it('the entry is matched by the canonical directory, as the fire matches it', async () => {
        await serve(projects({ [`${PROJECT_PATH}/`]: { trust_level: 'untrusted' } }));
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'held', reasonCode: 'folder-untrusted' });
      });

      it('a read that fails is idle, not held, and is warned about once per launch', async () => {
        await withWarnings(async (lines) => {
          await serve({ 'config/read': () => { throw Object.assign(new Error('config is locked'), { code: -32603 }); } });
          channel({ threadId: THREAD });
          assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
          assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
          assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
          assert.equal(unreadWarnings(lines), 1, 'one warning for the launch, not one per observation');
          assert.ok(lines.some((l) => l.includes('config is locked')), 'the warning carries why the read failed');
        });
      });

      it('an answer with no readable projects table is idle and warned about; a later launch is warned about again', async () => {
        await withWarnings(async (lines) => {
          await serve({ 'config/read': () => ({ config: { projects: 'not a table' }, origins: {} }) });
          channel({ threadId: THREAD });
          assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
          assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
          assert.equal(unreadWarnings(lines), 1);
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel({ threadId: THREAD });
          assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
          assert.equal(unreadWarnings(lines), 2, 'a new channel is a new launch');
        });
      });

      it('a readable answer is not warned about, held or not', async () => {
        await withWarnings(async (lines) => {
          await serve(projects({ [PROJECT_PATH]: { trust_level: 'untrusted' } }));
          channel({ threadId: THREAD });
          assert.deepEqual(await observe(), { state: 'held', reasonCode: 'folder-untrusted' });
          server.close();
          await serve(projects(null));
          store.getDb().prepare('DELETE FROM startup_control_channels').run();
          channel({ threadId: THREAD });
          assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
          assert.equal(unreadWarnings(lines), 0);
        });
      });

      it('a busy thread, an unknown one and a working second thread are answered without reading the config', async () => {
        const untrusted = projects({ [PROJECT_PATH]: { trust_level: 'untrusted' } });
        await serve(untrusted);
        channel({ threadId: THREAD });
        server.state.threadStatus = { type: 'active' };
        assert.deepEqual(await observe(), { state: 'busy', reasonCode: 'thread-active' });
        server.state.threadStatus = { type: 'systemError' };
        assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-status-unknown' });
        assert.equal(server.calls('config/read').length, 0, 'the folder\'s trust cannot change these answers, so it is not asked');
        server.close();
        await serve({
          ...untrusted,
          'thread/loaded/list': () => ({ data: [THREAD, 'other'] }),
          'thread/read': (p) => ({ thread: { id: p.threadId, cwd: PROJECT_PATH, status: { type: p.threadId === THREAD ? 'idle' : 'active' }, parentThreadId: null, source: 'cli' } })
        });
        store.getDb().prepare('DELETE FROM startup_control_channels').run();
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'busy', reasonCode: 'other-thread-active' });
        assert.equal(server.calls('config/read').length, 0);
      });

      it('one read per idle observation, and the answer follows an entry changed while the session runs', async () => {
        let table = null;
        await serve({ 'config/read': () => ({ config: { projects: table }, origins: {} }) });
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
        assert.equal(server.calls('config/read').length, 1);
        table = { [PROJECT_PATH]: { trust_level: 'untrusted' } };
        assert.deepEqual(await observe(), { state: 'held', reasonCode: 'folder-untrusted' });
        table = { [PROJECT_PATH]: { trust_level: 'trusted' } };
        assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
        assert.equal(server.calls('config/read').length, 3);
      });

      it('a held answer is withheld, like an idle one, when the channel changed under the read', async () => {
        await serve({
          'config/read': () => {
            // The launch's channel is closed while the observation reads the config.
            store.getDb().prepare("UPDATE startup_control_channels SET state = 'closed'").run();
            return { config: { projects: { [PROJECT_PATH]: { trust_level: 'untrusted' } } }, origins: {} };
          }
        });
        channel({ threadId: THREAD });
        assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'channel-changed' });
      });

      it('a thread bound by this observation in an untrusted folder is held, and stays bound', async () => {
        await serve(projects({ [PROJECT_PATH]: { trust_level: 'untrusted' } }));
        channel();
        assert.deepEqual(await observe(), { state: 'held', reasonCode: 'folder-untrusted' });
        assert.equal(store.startupControlChannels.getOpenBySession(session.id).adapterState.threadId, THREAD);
      });
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
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      // A summary-shaped completion arrives before any read-back is answered.
      // It follows the adapter's subscription request and not the turn/start
      // answer: the adapter drops a completion for a turn id it has not been
      // given yet, and it asks to subscribe only once it has the id. Sent
      // then, the completion is on the wire ahead of every read-back answer,
      // so it is weighed with no accepted evidence.
      let listsAskedBeforeCompletion = null;
      afterFirstRequest('thread/resume', () => {
        listsAskedBeforeCompletion = server.calls('thread/turns/list').length;
        server.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed', items: [] } });
      });
      channel();
      const f = pendingFire();
      const { settled } = await fireAndSettle(f);
      assert.equal(listsAskedBeforeCompletion, 0, 'the completion was sent before any read-back was asked for');
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
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      // The turn ends once the adapter's first read of the record has been
      // answered, not after a delay: a read that found the turn already ended
      // would accept and settle in one call, and the poll would never be
      // needed. The request event fires after the answer is written, so the
      // first read always answers "in progress" and only a later one can
      // answer "completed". The poll's interval decides how long the case
      // takes and nothing else.
      const readSaw = [];
      server.on('request', ({ method }) => {
        if (method !== 'thread/turns/list' || !server.state.turnStarted) return;
        readSaw.push(server.state.turn.status);
        if (readSaw.length === 1) server.state.turn = finishedTurn('completed');
      });
      channel();
      const f = pendingFire();
      const { settled, accepted } = await fireAndSettle(f, { reconnectPauseMs: 10, pollMs: 25 });
      assert.equal(accepted.outcome, 'accepted');
      assert.equal(settled.outcome, 'applied');
      assert.equal(readSaw[0], 'inProgress', 'the first read saw the turn still running');
      assert.equal(readSaw[readSaw.length - 1], 'completed', 'a later read saw it ended');
      assert.deepEqual(f.patches.map((p) => p.outcome).slice(-2), ['accepted', 'applied'], 'accepted from the first read, applied from a later one');
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
      let turnConn = null;
      await serve({
        initialize: () => { connectionsSeen += 1; return { userAgent: 'tangleclaw/0.156.1 (x)' }; },
        'turn/start': (p, ctx) => {
          server.state.turnStarted = true;
          server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
          server.state.turn = { id: TURN, status: 'inProgress', items: [server.state.userItem] };
          turnConn = ctx.conn;
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      channel();
      const f = pendingFire();
      const handles = startFire(f, { reconnectPauseMs: 10 });
      // The socket goes only once the adapter has recorded acceptance: lost
      // any earlier, the fire would end the same way by another path and the
      // case would not be about a loss after acceptance.
      await untilPatch(f, (p) => p.outcome === 'accepted');
      const outcomeAtLoss = f.current().outcome;
      turnConn.destroy();
      server.state.turn = finishedTurn('completed');
      const settled = await handles.settled;
      const accepted = await handles.accepted;
      assert.equal(outcomeAtLoss, 'accepted', 'the socket was lost from an accepted fire');
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
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      channel();
      const f = pendingFire();
      const handles = startFire(f, { reconnectPauseMs: 5 });
      // The server goes only once the adapter has recorded acceptance, so the
      // loss is one the reconnects have to answer for.
      await untilPatch(f, (p) => p.outcome === 'accepted');
      const outcomeAtLoss = f.current().outcome;
      server.close();
      const settled = await handles.settled;
      assert.equal(outcomeAtLoss, 'accepted', 'the channel was lost from an accepted fire');
      assert.equal(settled.outcome, 'indeterminate');
      assert.equal(settled.reasonCode, 'channel_lost');
    });
  });

  describe('faults on the channel', () => {
    it('a protocol fault after acceptance is logged and turned into a reconnect, never an unhandled error', async () => {
      const { frame } = require('./helpers/ws-test-server');
      let faults = 0;
      let turnConn = null;
      await serve({
        'turn/start': (p, ctx) => {
          server.state.turnStarted = true;
          server.state.userItem = { type: 'userMessage', id: 'item-1', clientId: p.clientUserMessageId, content: p.input };
          server.state.turn = { id: TURN, status: 'inProgress', items: [server.state.userItem] };
          turnConn = ctx.conn;
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        }
      });
      channel();
      const f = pendingFire();
      const handles = startFire(f, { reconnectPauseMs: 10, pollMs: 25 });
      // The fault is sent only once the adapter has recorded acceptance, so it
      // lands on a fire that is being watched.
      await untilPatch(f, (p) => p.outcome === 'accepted');
      const outcomeAtFault = f.current().outcome;
      faults += 1;
      // Garbage the client cannot parse as JSON, then a frame with a reserved opcode: a fault, not a close.
      turnConn.send('{not json');
      turnConn.raw(frame(0x3, Buffer.from('x')));
      server.state.turn = finishedTurn('completed');
      const settled = await handles.settled;
      assert.equal(outcomeAtFault, 'accepted', 'the fault reached an accepted fire');
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
          return { turn: { id: TURN, status: 'inProgress', items: [] } };
        },
        'thread/turns/list': () => {
          listCalls += 1;
          if (listCalls <= 2) throw Object.assign(new Error('storage busy'), { code: -32603 });
          return { data: [server.state.turn], nextCursor: null };
        }
      });
      // The summary-shaped completion follows the adapter's subscription
      // request: by then the adapter knows the turn id, and no read of the
      // list has been asked for, so the read the completion triggers is one
      // of the unreadable ones.
      let listsAskedBeforeCompletion = null;
      afterFirstRequest('thread/resume', () => {
        listsAskedBeforeCompletion = listCalls;
        server.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed', items: [] } });
      });
      channel();
      const f = pendingFire();
      const { settled } = await fireAndSettle(f, { reconnectPauseMs: 10, pollMs: 25 });
      assert.equal(listsAskedBeforeCompletion, 0, 'the completion was sent before any read of the list was asked for');
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

    describe('the app-server\'s environment: a launch identity variable is the launch\'s or it is absent (#2268)', () => {
      // TangleClaw's own environment as it is when the server was started from
      // inside a launched pane: every identity variable set, to another launch's values.
      const OWN = {
        HOME: '/Users/someone',
        TMUX: '/private/tmp/tmux-501/default,4242,0',
        TMUX_PANE: '%7',
        TANGLECLAW_LAUNCH_ID: 'L-own',
        TANGLECLAW_PROJECT_ID: '900',
        TANGLECLAW_ROLE: 'master',
        TANGLECLAW_WORKSPACE_ID: 'own-workspace-0000'
      };
      const IDENTITY = ['TANGLECLAW_LAUNCH_ID', 'TANGLECLAW_PROJECT_ID', 'TANGLECLAW_ROLE', 'TANGLECLAW_WORKSPACE_ID'];
      const identityOf = (env) => Object.fromEntries(IDENTITY.filter((key) => key in env).map((key) => [key, env[key]]));

      it('a project launch that gives a launch id and a project id passes on those two and neither of the others', () => {
        const env = codex._internal._serverEnvironment(OWN, { TANGLECLAW_LAUNCH_ID: 'L-this', TANGLECLAW_PROJECT_ID: '14', PATH: '/x/bin:/usr/bin' });
        assert.deepEqual(identityOf(env), { TANGLECLAW_LAUNCH_ID: 'L-this', TANGLECLAW_PROJECT_ID: '14' },
          'the role and workspace id TangleClaw itself holds do not reach the server');
        assert.equal(env.PATH, '/x/bin:/usr/bin', 'the pane\'s other entries still lie over TangleClaw\'s');
        assert.equal(env.HOME, '/Users/someone', 'TangleClaw\'s own environment is still underneath');
        assert.ok(!('TMUX' in env) && !('TMUX_PANE' in env), 'and the pane keys are still removed');
      });

      it('passes on every identity variable the launch gives, with the launch\'s value', () => {
        const given = { TANGLECLAW_LAUNCH_ID: 'L-this', TANGLECLAW_PROJECT_ID: '14', TANGLECLAW_ROLE: 'builder', TANGLECLAW_WORKSPACE_ID: 'this-workspace-1111' };
        assert.deepEqual(identityOf(codex._internal._serverEnvironment(OWN, given)), given);
      });

      it('reads an empty value as not given: the variable is absent, not TangleClaw\'s and not empty', () => {
        const env = codex._internal._serverEnvironment(OWN, { TANGLECLAW_LAUNCH_ID: 'L-this', TANGLECLAW_ROLE: '' });
        assert.deepEqual(identityOf(env), { TANGLECLAW_LAUNCH_ID: 'L-this' });
      });

      it('passes on no identity variable at all when the launch gives no entries', () => {
        for (const paneEnv of [undefined, null, {}, 'not an object']) {
          assert.deepEqual(identityOf(codex._internal._serverEnvironment(OWN, paneEnv)), {}, `for ${JSON.stringify(paneEnv)}`);
        }
      });

      it('does not change the environment it was handed', () => {
        const own = { ...OWN };
        codex._internal._serverEnvironment(own, { TANGLECLAW_LAUNCH_ID: 'L-this' });
        assert.deepEqual(own, OWN);
      });
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
        for (const args of [
          '-c "x --no-daemon"', "-c 'x' --no-daemon", '--no-daemon; codex', '$(x) --no-daemon', '--no-daemon && codex', '`x` --no-daemon', '--no-daemon | cat',
          // A shell may rewrite each of these before Codex sees it: a glob that matches a file, history, tilde and `=` expansion, a comment.
          '--daemo[n] --no-daemon', '--no-daemon --d?emon', '--no-daemon *', '^x --no-daemon', '=codex --no-daemon', '~root --no-daemon',
          '--no-daemon #x', '--no-daemon !!', '{a,b} --no-daemon', '--no-daemon \\x', '--no-daemon >out', '--no-daemon <in', '--no-daemon (x)'
        ]) {
          assert.equal(judge({ command: `${BIN} ${args}`, probe: probe('0.157.1') }).reasonCode, 'command_unparseable', args);
        }
        assert.match(judge({ command: `${BIN} --daemo[n] --no-daemon`, probe: probe('0.157.1') }).reason, /"--daemo\[n\]"/, 'the refusal names the argument at fault');
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
          assert.equal(verdict.reasonCode, 'native_version_unverified', label);
        }

        // 0.157.1 is verified for --no-daemon only. Installing it would be refused again on this path, so it is never offered here.
        const refused = judge({ command, native: { ...native, engineVersion: '0.157.1' } });
        assert.match(refused.reason, /0\.157\.1/, 'the reason names the version that was found');
        assert.ok(!refused.recovery.includes('0.157.1'), 'the recovery does not offer a version this path refuses');
        assert.match(refused.recovery, /\(0\.156\.1\)/);
        assert.ok(refused.recovery.includes('npm install -g @openai/codex@0.156.1'));
        const two = judge({ command, native: { ...native, engineVersion: '0.157.1' }, nativeVerifiedVersions: ['0.160.0', '0.156.1'] });
        assert.match(two.recovery, /\(0\.160\.0 or 0\.156\.1\)/, 'the list named is the native one, as the profile records it');
        assert.ok(two.recovery.includes('@openai/codex@0.160.0'));
        assert.match(refused.recovery, /check_for_update_on_startup = false/, 'the named version is one the setting was measured on, so the remedy says how to stay on it');
        assert.match(refused.recovery, /\(measured on Codex 0\.156\.1\)/, 'and says so of that version alone');
        assert.doesNotMatch(two.recovery, /check_for_update_on_startup/, 'no advice where a named version (0.160.0) was not measured');
        const none = judge({ command, native, nativeVerifiedVersions: null });
        assert.doesNotMatch(none.recovery, /Install a Codex version/, 'with no verified native version, no install is the remedy');
        assert.doesNotMatch(none.recovery, /check_for_update_on_startup|config\.toml/, 'staying on a version fixes nothing when no version is the remedy');
        assert.doesNotMatch(none.recovery, /0\.15\d\.\d/);
        assert.match(none.recovery, /restore or update TangleClaw/);
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

      it('a version refusal says which versions to install, and gives the command that installs one', () => {
        for (const verdict of [judge({ command: 'codex', probe: probe('0.161.0') }), judge({ command: 'codex', probe: null })]) {
          assert.equal(verdict.allowed, false);
          for (const version of codex._internal.NO_DAEMON_VERSIONS) assert.ok(verdict.recovery.includes(version));
          assert.ok(verdict.recovery.includes(codex._internal.INSTALL_COMMAND));
          assert.match(verdict.recovery, /Nothing was started/);
          assert.match(verdict.recovery, /already running are not changed/);
        }
      });

      it('a version refusal says how to stop Codex offering to leave the version it names, and claims only the prompt', () => {
        for (const verdict of [judge({ command: 'codex', probe: probe('0.161.0') }), judge({ command: 'codex', probe: null })]) {
          const advice = verdict.recovery.slice(verdict.recovery.indexOf('then launch again.'));
          assert.match(advice, /update prompt whose default choice \(Enter\) runs `npm install -g @openai\/codex`/, 'what the prompt does, as it was captured');
          assert.match(advice, /`check_for_update_on_startup = false`/, 'the setting');
          assert.match(advice, /`~\/\.codex\/config\.toml` unless `CODEX_HOME` is set/, 'the file');
          assert.match(advice, /TangleClaw does not edit that file/);
          assert.doesNotMatch(verdict.recovery, /updates itself|auto-?update/i, 'an update with no prompt was not measured');
          // Every version this remedy names must be one the setting was measured on:
          // admitting a version without that measurement drops the advice, and this fails.
          const measured = /\(measured on Codex ([^)]+)\)/.exec(advice)[1];
          for (const version of codex._internal.NO_DAEMON_VERSIONS) assert.ok(measured.includes(version), `the setting was measured on ${version}`);
          assert.ok(advice.endsWith('Nothing was started. Sessions that were already running are not changed by this.'), 'the advice sits before the closing lines');
        }
      });

      it('the install command it gives is the one the engine profile offers, and installs a version that launches', () => {
        const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
        assert.equal(profile.install.command, codex._internal.INSTALL_COMMAND);
        const pinned = /@openai\/codex@(\d+\.\d+\.\d+)$/.exec(profile.install.command);
        assert.ok(pinned, 'the offered command pins a version: an unpinned one installs the newest Codex, which does not launch');
        assert.ok(codex._internal.NO_DAEMON_VERSIONS.includes(pinned[1]), 'verified for --no-daemon');
        assert.ok(profile.capabilities.startupControl.verifiedVersions.includes(pinned[1]), 'verified for the native channel');
      });

      it('a refusal that a different Codex version would not fix does not tell the operator to install one', () => {
        const onVerified = { probe: probe('0.157.1') };
        for (const [reasonCode, verdict] of [
          ['command_not_pinned', judge({ command: 'codex --no-daemon', ...onVerified })],
          ['command_unparseable', judge({ command: `${BIN} "x" --no-daemon`, ...onVerified })],
          ['command_unisolated', judge({ command: `${BIN} --sandbox workspace-write`, ...onVerified })],
          ['executable_unresolved', judge({ command: 'codex', enginePath: "/opt/it's/codex", probe: probe('0.157.1', "/opt/it's/codex") })]
        ]) {
          assert.equal(verdict.reasonCode, reasonCode);
          assert.doesNotMatch(verdict.recovery, /Install a Codex version/, reasonCode);
          assert.ok(!verdict.recovery.includes(codex._internal.INSTALL_COMMAND), reasonCode);
          assert.match(verdict.recovery, /Nothing was started/, reasonCode);
        }
        assert.match(judge({ command: 'codex --no-daemon', ...onVerified }).recovery, /not the Codex version/);
        assert.match(judge({ command: 'codex', enginePath: "/opt/it's/codex", probe: probe('0.157.1', "/opt/it's/codex") }).recovery, /command -v codex/);
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
        // The launch site recognised it from the profile it holds; the adapter takes its word and judges.
        assert.equal(codex.judgeLaunchCommand({ engineId: 'my-engine', command: 'wrapper', enginePath: '/opt/x/wrapper', identifiedAs: 'codex' }).applies, true);
        assert.equal(codex.judgeLaunchCommand({ engineId: 'my-engine', command: 'wrapper', enginePath: '/opt/x/wrapper', identifiedAs: 'codex' }).allowed, false);
      });

      it('refuses a launch identified as Codex whose executable is not named codex, whatever version it reports', () => {
        const WRAP = '/opt/x/wrapper';
        let probes = 0;
        const deps = { probeVersionSync: () => { probes += 1; return '0.157.1'; } };
        for (const id of [{ engineId: 'codex' }, { engineId: 'my-engine', identifiedAs: 'codex' }]) {
          const built = codex.isolateLaunch({ ...id, launchCmd: 'wrapper --x', shell: 'wrapper', enginePath: WRAP }, deps);
          assert.deepEqual(built, { applies: true, command: null, probe: { version: null, enginePath: WRAP } }, 'no command is built for a wrapper');
          // Even a command that is pinned, flagged and on a verified version is refused: the wrapper may drop the flag.
          const verdict = codex.judgeLaunchCommand({ ...id, command: `${WRAP} --no-daemon`, enginePath: WRAP, probe: { version: '0.157.1', enginePath: WRAP }, native: null });
          assert.equal(verdict.allowed, false);
          assert.equal(verdict.reasonCode, 'executable_unverified');
          assert.ok(verdict.reason.includes(WRAP));
          assert.match(verdict.recovery, /real Codex executable/);
          assert.match(verdict.recovery, /wrapper's version or flags does not help/);
          assert.doesNotMatch(verdict.recovery, /Install a Codex version/);
          const attached = codex.judgeLaunchCommand({ ...id, command: `${WRAP} --remote unix:///private/tmp/fake-daemon/abc`, enginePath: WRAP, nativeVerifiedVersions: ['0.156.1'],
            native: { resolvedSocketPath: '/private/tmp/fake-daemon/abc', enginePath: WRAP, engineVersion: '0.156.1' } });
          assert.equal(attached.reasonCode, 'executable_unverified');
        }
        assert.equal(probes, 0, 'a wrapper is never asked its version');
      });
    });

    describe('which refusals the operator\'s override may set aside, and the command an overridden launch runs (#2229)', () => {
      const BIN = '/opt/fake/bin/codex';
      const judge = (over) => codex.judgeLaunchCommand({ engineId: 'codex', enginePath: BIN, probe: null, native: null, nativeVerifiedVersions: ['0.156.1'], ...over });
      const overridden = (over) => codex.judgeOverriddenLaunch({ engineId: 'codex', launchCmd: 'codex', shell: 'codex', enginePath: BIN, probe: { version: '0.170.0', enginePath: BIN }, ...over });
      const ADVICE = 'An operator can instead allow this launch without isolation, with the launch-isolation override.';

      it('marks the two version refusals overridable, and names the override in their remedy once', () => {
        assert.deepEqual([...codex.OVERRIDABLE_REFUSALS], ['version_unknown', 'version_unverified']);
        for (const verdict of [
          judge({ command: 'codex' }),
          judge({ command: 'codex', probe: { version: null, enginePath: BIN, retryInSeconds: 12 } }),
          judge({ command: `${BIN} --no-daemon`, probe: { version: '0.170.0', enginePath: BIN } })
        ]) {
          assert.equal(verdict.allowed, false);
          assert.ok(codex.OVERRIDABLE_REFUSALS.includes(verdict.reasonCode), verdict.reasonCode);
          assert.equal(verdict.overridable, true);
          assert.equal(verdict.recovery.split(ADVICE).length - 1, 1, 'the override is named once');
          assert.ok(verdict.recovery.indexOf(ADVICE) < verdict.recovery.indexOf('update prompt'), 'before the advice on staying on a version');
        }
      });

      it('marks every other refusal not overridable, and never names the override in its remedy', () => {
        const native = { resolvedSocketPath: '/private/tmp/fake-daemon/abc', enginePath: BIN, engineVersion: '0.156.1' };
        const verified = { version: '0.157.1', enginePath: BIN };
        const refusals = [
          judge({ command: 'codex-wrapper', enginePath: '/opt/fake/bin/codex-wrapper' }),
          judge({ command: 'codex', enginePath: '/opt/it\'s/codex' }),
          judge({ command: 'codex --no-daemon', probe: verified }),
          judge({ command: `${BIN} --config $(id) --no-daemon`, probe: verified }),
          judge({ command: BIN, probe: verified }),
          judge({ command: `${BIN} --remote unix:///private/tmp/other`, native }),
          judge({ command: `${BIN} --remote unix:///private/tmp/fake-daemon/abc`, native: { ...native, engineVersion: '0.170.0' } }),
          judge({ command: `${BIN} --remote unix:///private/tmp/fake-daemon/abc`, native: { ...native, engineVersion: '0.170.0' }, nativeVerifiedVersions: [] })
        ];
        const codes = new Set();
        for (const verdict of refusals) {
          assert.equal(verdict.allowed, false);
          assert.equal(verdict.overridable, false, verdict.reasonCode);
          assert.ok(!verdict.recovery.includes('override'), `${verdict.reasonCode}: ${verdict.recovery}`);
          codes.add(verdict.reasonCode);
        }
        assert.deepEqual([...codes].sort(), ['command_not_pinned', 'command_unisolated', 'command_unparseable', 'executable_unresolved', 'executable_unverified', 'native_version_unverified']);
      });

      it('builds the overridden command on the exact executable, with the launch\'s own arguments and no isolation flag', () => {
        assert.deepEqual(overridden(), { applies: true, allowed: true, command: BIN, versionRead: '0.170.0' });
        assert.deepEqual(
          overridden({ launchCmd: 'codex --ask-for-approval never --sandbox workspace-write' }),
          { applies: true, allowed: true, command: `${BIN} --ask-for-approval never --sandbox workspace-write`, versionRead: '0.170.0' }
        );
        const quoted = overridden({ enginePath: '/opt/my tools/codex', probe: null });
        assert.equal(quoted.command, '\'/opt/my tools/codex\'');
        assert.equal(quoted.versionRead, null);
        assert.equal(overridden({ probe: { version: '0.170.0', enginePath: '/other/codex' } }).versionRead, null, 'a version read from another executable is not this one\'s');
      });

      it('refuses what the version refusal was hiding, and none of those refusals is overridable', () => {
        for (const [over, reasonCode] of [
          [{ enginePath: '/opt/fake/bin/codex-wrapper' }, 'executable_unverified'],
          [{ enginePath: null }, 'executable_unresolved'],
          [{ launchCmd: 'env X=1 codex' }, 'command_not_pinned'],
          [{ shell: null }, 'command_not_pinned'],
          [{ launchCmd: 'codex --config $(id)' }, 'command_unparseable'],
          [{ launchCmd: 'codex -- --no-daemon' }, 'command_unparseable'],
          [{ launchCmd: 'codex --remote unix:///tmp/x --no-daemon' }, 'command_unparseable'],
          [{ launchCmd: 'codex --remote unix:///tmp/someone-elses.sock' }, 'command_unisolated'],
          [{ launchCmd: 'codex --no-daemon' }, 'command_unisolated'],
          [{ launchCmd: 'codex --sandbox workspace-write --no-daemon' }, 'command_unisolated']
        ]) {
          const verdict = overridden(over);
          assert.equal(verdict.allowed, false, JSON.stringify(over));
          assert.equal(verdict.reasonCode, reasonCode, JSON.stringify(over));
          assert.equal(verdict.overridable, false);
          assert.match(verdict.recovery, /Nothing was started/);
        }
        assert.deepEqual(overridden({ engineId: 'claude', launchCmd: 'claude', shell: 'claude', enginePath: '/opt/fake/bin/claude' }), { applies: false });
      });

      it('the recorded command of an overridden launch reads not isolated, and is the only one marked as started that way', () => {
        const recorded = (command) => codex.judgeRecordedCommand({ engineId: 'codex', command, channel: null, nativeVerifiedVersions: ['0.156.1'] });
        const mine = recorded(overridden({ launchCmd: 'codex --sandbox workspace-write' }).command);
        assert.equal(mine.verdict, 'not-isolated');
        assert.equal(mine.reasonCode, 'command_unisolated');
        assert.equal(mine.startedUnisolatedByPath, true);
        // No command an overridden launch can run reads isolated afterwards.
        for (const launchCmd of ['codex', 'codex --sandbox workspace-write', 'codex --ask-for-approval never']) {
          assert.equal(recorded(overridden({ launchCmd }).command).verdict, 'not-isolated', launchCmd);
        }
        for (const command of ['codex', 'codex --sandbox workspace-write', `${BIN} --no-daemon`, `${BIN} --remote unix:///tmp/x`, '/opt/fake/bin/codex-wrapper', `${BIN} --config $(id)`]) {
          assert.equal('startedUnisolatedByPath' in recorded(command), false, command);
        }
      });
    });

    describe('admitExecutable: may this path be run as Codex at all (#2233)', () => {
      it('admits an executable named codex, refuses a wrapper and an unnameable path, and disclaims other engines', () => {
        assert.deepEqual(codex.admitExecutable({ engineId: 'codex', enginePath: '/opt/fake/bin/codex', command: 'codex' }), { applies: true, allowed: true });
        assert.deepEqual(codex.admitExecutable({ engineId: 'codex', enginePath: '/Users/Jo Smith/bin/codex', command: 'codex' }), { applies: true, allowed: true });
        for (const id of [{ engineId: 'codex' }, { engineId: 'my-engine', identifiedAs: 'codex' }, { engineId: 'my-engine', command: 'codex --x' }]) {
          const verdict = codex.admitExecutable({ command: 'wrapper', ...id, enginePath: '/opt/x/wrapper' });
          assert.equal(verdict.allowed, false);
          assert.equal(verdict.reasonCode, 'executable_unverified');
        }
        for (const enginePath of [null, 'codex', "/opt/it's/codex"]) {
          assert.equal(codex.admitExecutable({ engineId: 'codex', enginePath, command: 'codex' }).reasonCode, 'executable_unresolved', String(enginePath));
        }
        assert.deepEqual(codex.admitExecutable({ engineId: 'claude', enginePath: '/opt/fake/bin/claude', command: 'claude' }), { applies: false });
      });

      it('runs nothing to decide', () => {
        const realSeams = { ...codex._seams };
        const trap = () => { throw new Error('admitExecutable must not run anything'); };
        Object.assign(codex._seams, { execFileSync: trap, execFile: trap, spawn: trap });
        try {
          assert.equal(codex.admitExecutable({ engineId: 'codex', enginePath: '/opt/fake/bin/codex', command: 'codex' }).allowed, true);
          assert.equal(codex.admitExecutable({ engineId: 'codex', enginePath: '/opt/x/wrapper', command: 'codex' }).allowed, false);
        } finally {
          Object.assign(codex._seams, realSeams);
        }
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

    describe('a Codex that does not answer its version probe is left unasked for a short time (#2231)', () => {
      const WAIT = codex._internal.PROBE_UNANSWERED_MEMORY_MS;
      let dir;
      let bin;
      let clock;
      let spawns;
      let saved;

      /**
       * Make the probe answer as given, counting each run of the executable.
       * @param {() => string} answer - What the executable prints; a throw is a probe that fails.
       * @returns {void}
       */
      function answers(answer) {
        codex._seams.execFileSync = (file) => { spawns.push(file); return answer(); };
      }

      const hangs = () => { throw Object.assign(new Error('spawnSync codex ETIMEDOUT'), { code: 'ETIMEDOUT' }); };

      beforeEach(() => {
        saved = { ...codex._seams };
        dir = fs.mkdtempSync(path.join(tempDir, 'probe-memory-'));
        bin = path.join(dir, 'codex');
        fs.writeFileSync(bin, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
        clock = 1_000_000;
        spawns = [];
        codex._seams.now = () => clock;
        codex._internal._unanswered.clear();
      });

      afterEach(() => {
        Object.assign(codex._seams, saved);
        codex._internal._unanswered.clear();
      });

      it('is 60 seconds, and longer than the probe itself may run', () => {
        assert.equal(WAIT, 60000);
        assert.ok(WAIT > codex._internal.VERSION_PROBE_TIMEOUT_MS);
      });

      for (const [label, answer] of [
        ['hangs past the limit', hangs],
        ['fails to start', () => { throw new Error('spawn EACCES'); }],
        ['prints something that is not a version', () => 'Segmentation fault\n']
      ]) {
        it(`an executable that ${label} is run once, then not again until the time has passed`, () => {
          answers(answer);
          assert.deepEqual(codex.probeForLaunch({ enginePath: bin }), { version: null, enginePath: bin }, 'the ask that ran says nothing about waiting');
          clock += 1000;
          assert.deepEqual(codex.probeForLaunch({ enginePath: bin }), { version: null, enginePath: bin, retryInSeconds: 59 });
          assert.equal(codex.probeVersionSync({ enginePath: bin }), null);
          assert.equal(codex.installedVersion(), null, 'the cached version is empty, as after a failed probe');
          clock += WAIT - 1001;
          assert.equal(codex.probeForLaunch({ enginePath: bin }).retryInSeconds, 1, 'still inside the time at its last millisecond');
          assert.deepEqual(spawns, [bin], 'four asks, one run');
          clock += 1;
          assert.deepEqual(codex.probeForLaunch({ enginePath: bin }), { version: null, enginePath: bin });
          assert.deepEqual(spawns, [bin, bin], 'asked again once the time has passed');
          clock += 1000;
          assert.equal(codex.probeForLaunch({ enginePath: bin }).retryInSeconds, 59, 'and that second non-answer is remembered for its own time');
          assert.deepEqual(spawns, [bin, bin]);
        });
      }

      it('a file changed at the same path is asked at once, whether its time, its size or the file itself changed', () => {
        answers(hangs);
        codex.probeForLaunch({ enginePath: bin });
        const touched = new Date(Date.now() + 5000);
        fs.utimesSync(bin, touched, touched);
        codex.probeForLaunch({ enginePath: bin });
        assert.equal(spawns.length, 2, 'a new modification time');
        fs.appendFileSync(bin, '# longer\n');
        fs.utimesSync(bin, touched, touched);
        codex.probeForLaunch({ enginePath: bin });
        assert.equal(spawns.length, 3, 'a new size under the same modification time');
        const body = fs.readFileSync(bin);
        const replacement = path.join(dir, 'codex.new');
        fs.writeFileSync(replacement, body, { mode: 0o755 });
        fs.utimesSync(replacement, touched, touched);
        fs.renameSync(replacement, bin);
        codex.probeForLaunch({ enginePath: bin });
        assert.equal(spawns.length, 4, 'another file of the same size and time, moved into place');
        assert.equal(codex.probeForLaunch({ enginePath: bin }).retryInSeconds, 60);
        assert.equal(spawns.length, 4, 'and the file as it now is, is left unasked');
      });

      it('a repaired executable answers at once and nothing of the failure is kept', () => {
        answers(hangs);
        codex.probeForLaunch({ enginePath: bin });
        fs.writeFileSync(bin, '#!/bin/sh\necho codex-cli 0.156.1\n', { mode: 0o755 });
        answers(() => 'codex-cli 0.156.1\n');
        assert.deepEqual(codex.probeForLaunch({ enginePath: bin }), { version: '0.156.1', enginePath: bin });
        assert.equal(codex._internal._unanswered.size, 0);
      });

      it('an executable that answers is run at every ask: a version is never kept', () => {
        answers(() => 'codex-cli 0.157.1\n');
        for (let i = 0; i < 3; i += 1) assert.equal(codex.probeVersionSync({ enginePath: bin }), '0.157.1');
        assert.equal(spawns.length, 3);
        assert.equal(codex._internal._unanswered.size, 0);
      });

      it('each executable is remembered by itself, and a link to one is the file it points at', () => {
        answers(hangs);
        const other = path.join(dir, 'other', 'codex');
        fs.mkdirSync(path.dirname(other));
        fs.writeFileSync(other, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
        const link = path.join(dir, 'codex-link');
        fs.symlinkSync(bin, link);
        codex.probeForLaunch({ enginePath: bin });
        codex.probeForLaunch({ enginePath: other });
        assert.deepEqual(spawns, [bin, other], 'one failing executable does not silence another');
        assert.deepEqual(codex.probeForLaunch({ enginePath: link }), { version: null, enginePath: link, retryInSeconds: 60 }, 'the link is not a way to ask the same file again');
        assert.equal(spawns.length, 2);
      });

      it('an executable whose file cannot be read is never remembered: it is asked every time', () => {
        answers(hangs);
        const gone = path.join(dir, 'missing', 'codex');
        codex.probeForLaunch({ enginePath: gone });
        assert.deepEqual(codex.probeForLaunch({ enginePath: gone }), { version: null, enginePath: gone });
        codex._seams.statSync = () => { throw new Error('EACCES: permission denied'); };
        codex.probeForLaunch({ enginePath: bin });
        codex.probeForLaunch({ enginePath: bin });
        assert.deepEqual(spawns, [gone, gone, bin, bin]);
        assert.equal(codex._internal._unanswered.size, 0);
      });

      it('a bare command name is never remembered: it names a different file on a different PATH', () => {
        answers(hangs);
        assert.deepEqual(codex.probeForLaunch(), { version: null, enginePath: null });
        codex.probeForLaunch();
        assert.deepEqual(spawns, ['codex', 'codex']);
      });

      it('a clock that went backwards asks again and never waits longer than the time', () => {
        answers(hangs);
        codex.probeForLaunch({ enginePath: bin });
        clock -= 10 * WAIT;
        codex.probeForLaunch({ enginePath: bin });
        assert.equal(spawns.length, 2);
      });

      it('the refusal for an executable that was not asked keeps its reason code and says when it will be asked', () => {
        answers(hangs);
        const first = codex.isolateLaunch({ engineId: 'codex', launchCmd: 'codex', shell: 'codex', enginePath: bin });
        const judge = (probe) => codex.judgeLaunchCommand({ engineId: 'codex', command: 'codex', enginePath: bin, probe });
        const asked = judge(first.probe);
        assert.equal(asked.reasonCode, 'version_unknown');
        assert.match(asked.reason, /^TangleClaw could not read the version of /);
        assert.doesNotMatch(asked.reason, /asked again/);
        clock += 18500;
        const second = codex.isolateLaunch({ engineId: 'codex', launchCmd: 'codex', shell: 'codex', enginePath: bin });
        assert.deepEqual(second, { applies: true, command: null, probe: { version: null, enginePath: bin, retryInSeconds: 42 } });
        const waiting = judge(second.probe);
        assert.equal(waiting.reasonCode, 'version_unknown', 'the same reason code');
        assert.equal(waiting.allowed, false);
        assert.equal(waiting.recovery, asked.recovery, 'and the same way out');
        assert.equal(waiting.reason, `TangleClaw asked ${bin} for its version less than a minute ago and got no answer, so this launch did not ask again and it cannot tell whether that Codex can be kept off its shared background process. It will be asked again in about 42 seconds, or at once if that file is replaced.`);
        assert.match(judge({ version: null, enginePath: bin, retryInSeconds: 1 }).reason, /in about 1 second, or/);
        assert.match(judge({ version: null, enginePath: '/elsewhere/codex', retryInSeconds: 30 }).reason, /^TangleClaw could not read the version of /, 'a wait recorded for another executable is not this one\'s');
        assert.equal(spawns.length, 1);
      });

      it('a launch step handed the probe its launch already made does not run the executable; a probe of another path is not used', () => {
        answers(() => 'codex-cli 0.157.1\n');
        const made = { version: '0.157.1', enginePath: bin };
        assert.deepEqual(
          codex.isolateLaunch({ engineId: 'codex', launchCmd: 'codex', shell: 'codex', enginePath: bin, probe: made }),
          { applies: true, command: `${bin} --no-daemon`, probe: made }
        );
        assert.equal(spawns.length, 0);
        const unanswered = codex.isolateLaunch({ engineId: 'codex', launchCmd: 'codex', shell: 'codex', enginePath: bin, probe: { version: null, enginePath: bin } });
        assert.deepEqual(unanswered, { applies: true, command: null, probe: { version: null, enginePath: bin } }, 'a non-answer handed on is a non-answer, not a reason to ask again');
        assert.equal(spawns.length, 0);
        const elsewhere = codex.isolateLaunch({ engineId: 'codex', launchCmd: 'codex', shell: 'codex', enginePath: bin, probe: { version: '0.156.1', enginePath: '/elsewhere/codex' } });
        assert.equal(elsewhere.probe.version, '0.157.1', 'the version is this executable\'s own answer');
        assert.deepEqual(spawns, [bin]);
        const noServer = codex.prepareLaunch({ project, engineProfile: { launch: { shellCommand: 'codex' } }, launchCmd: 'codex', enginePath: bin, probe: { version: null, enginePath: bin } });
        assert.equal(noServer.reasonCode, 'channel_unavailable', 'no app-server is started on a version nobody read');
        assert.equal(spawns.length, 1);
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

  // #2059. Codex 0.161.0 and 0.162.0, each read by its own declaration
  // (`capabilities.wake.restRows`) and from its own captures over the launch
  // path TangleClaw uses: which rows may follow the composer, and which loaded
  // thread is the launch's own. Neither is a verified version: these tests
  // drive the adapter directly, behind the facade's version gate.
  describe('a version that declares its rows at rest, and the launch\'s own thread (#2059)', () => {
    const paneWitness = require('../lib/pane-witness');
    const { CODEX_VISIBLE_PANES: PANES, CODEX_CHANNEL_VERSIONS, CODEX_CHANNEL_FIXTURES } = require('./_codex-visible-pane-fixtures');
    const codexProfile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
    const LAUNCH_PANE = { paneId: '%7', paneServer: '4242.1790431343' };
    const TITLE = '01a0d0ce-0000-7000-8000-00000000717e';
    const SECOND = '01a0d0ce-0000-7000-8000-0000000005ec';
    const ours = {
      psCommand: (pid) => (pid === 4242 ? 'codex app-server --listen unix:///x/requested.sock' : ''),
      psBirth: (pid) => (pid === 4242 ? 'Wed Sep 23 18:00:04 2026' : '')
    };
    const OPENING_WHY = /the footer row is drawn with no status row above it, as on a screen that is still opening or resuming/;
    const threadOf = () => store.startupControlChannels.getOpenBySession(session.id).adapterState.threadId;
    /** The recorded thread on the channel row, and the provisional one beside it. */
    const binding = () => {
      const state = store.startupControlChannels.getOpenBySession(session.id).adapterState;
      return { threadId: state.threadId || null, provisional: state.provisionalThreadId || null };
    };
    const observe = () => codex.observeActivity(store.startupControlChannels.getOpenBySession(session.id), project, ours);

    /**
     * A witness over a pane the test can change, built as the fire service
     * builds one, that records the options the adapter asked with.
     * @param {object|Function} frame - What a read returns; a function is asked each read with `read` or `read-once`.
     * @returns {{frame: *, asked: object[], answers: object[], afterWitness: (Function|null), witness: Function}}
     */
    const screenOf = (frame) => {
      const screen = { frame, asked: [], answers: [], afterWitness: null };
      screen.witness = async (opts) => {
        const { single, ...shape } = opts;
        screen.asked.push(opts);
        const ask = single === true ? paneWitness.composerShownOnce : paneWitness.composerShown;
        const kind = single === true ? 'read-once' : 'read';
        const seen = await ask({ ...shape, tmuxName: 'tc-deputy', engineProfile: codexProfile, wakeProfile: require('../lib/medusa-wake').ENGINE_WAKE_PROFILES.codex }, {
          gapMs: 0,
          sleep: async () => {},
          pin: () => '%7',
          read: (name, paneId) => {
            const f = typeof screen.frame === 'function' ? screen.frame(kind) : screen.frame;
            return { paneId, ...f, rows: [...f.rows] };
          }
        });
        screen.answers.push(seen);
        if (screen.afterWitness) screen.afterWitness(single === true);
        return seen;
      };
      return screen;
    };

    /**
     * The gate, with a clock the test owns.
     * @param {object} screen - From `screenOf`.
     * @param {number} [windowMs=6000] - The window; one poll interval or less is a single look.
     * @returns {Promise<{answer: object, looks: number}>}
     */
    const gate = async (screen, windowMs = 6000) => {
      let clock = 0;
      let waits = 0;
      const answer = await codex.awaitLaunchReady({ session, project, sequenceId: 100, witness: screen.witness, windowMs, pollMs: 1500 },
        { now: () => clock, wait: async (ms) => { clock += ms; waits += 1; } });
      return { answer, looks: waits + 1 };
    };

    /** Finish the turn once the adapter has read it back. */
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

    /**
     * A fire, the operator's or the launch's own.
     * @param {object} screen - From `screenOf`.
     * @param {boolean} automatic - Whether it is the launch's automatic fire.
     * @returns {Promise<object>} The settled row.
     */
    const fireOn = (screen, automatic) => codex.fire({
      session, project, sequenceId: 100, promptText: PROMPT, promptTextDigest: PROMPT_DIGEST, payloadDigest: DIGEST, onUpdate: pendingFire().onUpdate,
      trustException: { absentOn: [], witness: screen.witness }, ...(automatic ? { automatic: true, paneWitness: screen.witness } : {})
    }, { reconnectPauseMs: 10 }).settled;

    for (const version of CODEX_CHANNEL_VERSIONS) {
      describe(`codex-cli ${version}`, () => {
        const fx = CODEX_CHANNEL_FIXTURES[version];
        const MODEL = fx.threads.userBeforeFirstTurn.model;
        /** A captured thread as this fake's project would hold it: the fixture's own frame, its id and folder replaced. */
        const captured = (name, id, over = {}) => ({ ...JSON.parse(JSON.stringify(fx.threads[name])), id, sessionId: id, cwd: PROJECT_PATH, ...over });
        const userIdle = (over = {}) => captured('userBeforeFirstTurn', THREAD, over);
        const userAfterTurn = (over = {}) => captured('userIdleAfterTurn', THREAD, over);
        const titleIdle = (over = {}) => captured('titleIdle', TITLE, over);
        const titleActive = (over = {}) => captured('titleActive', TITLE, over);

        /**
         * A fake app-server of this version holding `threads`, and a channel its launch recorded.
         * @param {Array<object|Error>} threads - Loaded threads; an Error is a thread whose read fails (its `threadId` names it).
         * @param {object} [stateOver] - Adapter state overrides.
         * @param {object} [handlers] - Handler overrides.
         * @returns {Promise<{table: Map<string, object|Error>}>}
         */
        const world = async (threads, stateOver = {}, handlers = {}) => {
          codex._internal._version.version = version;
          const table = new Map(threads.map((t) => [t instanceof Error ? t.threadId : t.id, t]));
          await serve({
            initialize: () => ({ userAgent: `tangleclaw/${version} (Mac OS 15.6.1; arm64)`, codexHome: '/x', platformFamily: 'unix', platformOs: 'macos' }),
            'thread/loaded/list': () => ({ data: [...table.keys()], nextCursor: null }),
            'thread/read': (p) => {
              const t = table.get(p.threadId);
              if (t instanceof Error) throw t;
              return { thread: t };
            },
            ...handlers
          });
          // Every world finishes a turn that is started, so a fire that should
          // have been refused settles as applied and fails its assertion, where
          // it would otherwise wait on a turn nobody ends.
          completeTheTurn();
          channel({ ...LAUNCH_PANE, engineVersion: version, ...stateOver });
          return { table };
        };
        const unreadable = (id) => Object.assign(new Error('thread read failed'), { code: -32603, threadId: id });

        it('the fixture frames are this version\'s own, and are the two kinds the rule tells apart', () => {
          assert.equal(fx.threads.userBeforeFirstTurn.cliVersion, version);
          assert.equal(fx.threads.titleActive.cliVersion, version);
          assert.equal(codex._internal._threadKind(fx.threads.userBeforeFirstTurn), 'launch');
          assert.equal(codex._internal._threadKind(fx.threads.userActive), 'launch');
          assert.equal(codex._internal._threadKind(fx.threads.userIdleAfterTurn), 'launch');
          assert.equal(codex._internal._threadKind(fx.threads.titleActive), 'title');
          assert.equal(codex._internal._threadKind(fx.threads.titleIdle), 'title');
          assert.equal(codex._internal._threadKind(fx.threads.titleStarted.thread), 'title', 'as its thread/started notification already says');
          assert.equal(fx.threads.titleActive.status.type, 'active');
          assert.equal(codex._internal._isSubagent ? codex._internal._isSubagent(fx.threads.titleActive) : false, false);
        });

        describe('the launch gate', () => {
          for (const name of ['idleDefaultLayout', 'idleThreeItemStatus', 'idleSingleItemStatus', 'idleAfterTurn', 'idleAfterUpdateSkipped', 'idleAfterResume']) {
            it(`${name}: ready on the first look, asked with this version's footer and no row count`, async () => {
              await world([userIdle()]);
              const screen = screenOf(fx.panes[name]);
              const { answer, looks } = await gate(screen);
              assert.deepEqual(answer, { ready: true });
              assert.equal(looks, 1);
              const asked = screen.asked[0];
              assert.equal(asked.footerRe.source, codexProfile.capabilities.wake.restRows[version].footerPattern);
              assert.equal('maxStatusRows' in asked, false, 'never a count of two: the order is the rule');
              assert.ok(asked.statusRe.test(`  ${MODEL.toUpperCase()}`), 'the thread\'s model, alone, is a status row');
              assert.ok(!asked.statusRe.test('  ? for shortcuts'), 'the footer is not');
              assert.equal(server.calls('turn/start').length, 0);
            });
          }

          for (const name of ['startScreen', 'resumingScreen']) {
            it(`${name}: refused with the thread reading idle, by a reason that names the rule`, async () => {
              await world([userIdle()]);
              const screen = screenOf(fx.panes[name]);
              const { answer } = await gate(screen);
              assert.equal(answer.ready, false);
              assert.equal(answer.unavailable, false, 'the pane was read, and seen not ready');
              assert.match(answer.observation, OPENING_WHY);
              assert.equal(server.calls('thread/read').filter((c) => c.params.threadId === THREAD).length > 0, true);
            });
          }

          it('the empty status line at rest is refused: the operator\'s Fire is what remains', async () => {
            await world([userIdle()]);
            const { answer } = await gate(screenOf(fx.panes.idleEmptyStatus));
            assert.equal(answer.ready, false);
            assert.match(answer.observation, /something other than one status row and then the declared footer row is drawn below the composer/);
            assert.match(answer.remedy, /Press Fire startup prompt/);
          });

          it('the dialogs, typed text and a drawn busy row are refused as what they are', async () => {
            const cases = [
              ['trustDialog', /Codex was showing its folder-trust prompt in the pane/],
              ['updateDialog', /Codex was showing its update prompt in the pane/],
              ['typing', /no empty composer row is on screen/],
              ['busyDefaultLayout', /a turn is running/]
            ];
            for (const [name, expected] of cases) {
              store.getDb().prepare('DELETE FROM startup_control_channels').run();
              await world([userIdle()]);
              const { answer } = await gate(screenOf(fx.panes[name]));
              assert.equal(answer.ready, false, name);
              assert.match(answer.observation, expected, name);
              server.close();
              server = null;
            }
          });

          it('the single-item row is recognised only against the thread\'s own model, and the thread must still report it afterwards', async () => {
            await world([userIdle({ model: 'some-other-model' })]);
            let { answer } = await gate(screenOf(fx.panes.idleSingleItemStatus));
            assert.equal(answer.ready, false, 'a row that is not the thread\'s model');
            assert.match(answer.observation, /something other than one status row and then the declared footer row/);
            server.close();

            store.getDb().prepare('DELETE FROM startup_control_channels').run();
            const unread = userIdle();
            delete unread.model;
            await world([unread]);
            ({ answer } = await gate(screenOf(fx.panes.idleSingleItemStatus)));
            assert.equal(answer.ready, false, 'a model that could not be read recognises no single item');
            server.close();

            store.getDb().prepare('DELETE FROM startup_control_channels').run();
            const { table } = await world([userIdle()]);
            const screen = screenOf(fx.panes.idleSingleItemStatus);
            screen.afterWitness = () => { table.set(THREAD, userIdle({ model: 'some-other-model' })); };
            ({ answer } = await gate(screen, 1000));
            assert.equal(screen.answers[0].shown, true, 'the pane itself passed, against the model read before it');
            assert.equal(answer.ready, false);
            assert.match(answer.observation, /the launch's thread was no longer the one in the project directory/);
          });

          it('a streaming turn: the pane alone passes the witness, and the thread read AFTER it refuses', async () => {
            const { table } = await world([userIdle()]);
            const screen = screenOf(fx.turnFrames.streamingFirst);
            screen.afterWitness = () => { table.set(THREAD, captured('userActive', THREAD)); };
            const { answer } = await gate(screen);
            assert.equal(screen.answers[0].shown, true, 'held still, a streaming frame has the shape of a composer at rest');
            assert.equal(answer.ready, false);
            assert.match(answer.observation, /the launch's thread was active, not idle/);
            server.close();

            // And when the two reads straddle a moving transcript, the witness itself refuses.
            store.getDb().prepare('DELETE FROM startup_control_channels').run();
            await world([userIdle()]);
            let n = 0;
            const moving = screenOf(() => (n++ === 0 ? fx.turnFrames.streamingFirst : fx.turnFrames.streamingNext));
            assert.match((await gate(moving, 1000)).answer.observation, /the pane changed between two reads a second apart/);
            server.close();

            // A thread already reading active is refused before any pane is read.
            store.getDb().prepare('DELETE FROM startup_control_channels').run();
            await world([captured('userActive', THREAD)]);
            const unasked = screenOf(fx.turnFrames.streamingFirst);
            assert.match((await gate(unasked)).answer.observation, /the launch's thread was active, not idle/);
            assert.equal(unasked.asked.length, 0);
          });

          it('this version\'s usable composer is refused under 0.156.1\'s rule and under no declaration', async () => {
            // The same pane on a channel proved to be 0.156.1: the one-row rule.
            codex._internal._version.version = '0.156.1';
            await serve({ 'thread/read': () => ({ thread: userIdle() }) });
            channel(LAUNCH_PANE);
            let screen = screenOf(fx.panes.idleDefaultLayout);
            let { answer } = await gate(screen);
            assert.equal(answer.ready, false);
            assert.match(answer.observation, /something other than a status row is drawn below the composer/);
            assert.equal(screen.asked[0].maxStatusRows, 1);
            assert.equal('footerRe' in screen.asked[0], false);
            server.close();

            // This version, proved, with a profile that declares nothing for it.
            store.getDb().prepare('DELETE FROM startup_control_channels').run();
            const realProfile = codex._seams.wakeProfile;
            const { restRows, ...undeclared } = require('../lib/medusa-wake').ENGINE_WAKE_PROFILES.codex;
            assert.ok(restRows[version]);
            codex._seams.wakeProfile = () => undeclared;
            try {
              await world([userIdle()]);
              screen = screenOf(fx.panes.idleDefaultLayout);
              ({ answer } = await gate(screen));
              assert.equal(answer.ready, false);
              assert.match(answer.observation, /something other than a status row is drawn below the composer/);
              assert.equal(screen.asked[0].maxStatusRows, 1);
              server.close();

              // And declared for the OTHER version only: never read by a neighbour's entry.
              store.getDb().prepare('DELETE FROM startup_control_channels').run();
              const other = CODEX_CHANNEL_VERSIONS.find((v) => v !== version);
              codex._seams.wakeProfile = () => ({ ...undeclared, restRows: { [other]: restRows[other] } });
              await world([userIdle()]);
              screen = screenOf(fx.panes.idleDefaultLayout);
              ({ answer } = await gate(screen));
              assert.equal(answer.ready, false, 'the other version\'s declaration is not this one\'s');
              assert.equal('footerRe' in screen.asked[0], false);
            } finally {
              codex._seams.wakeProfile = realProfile;
            }
          });

          it('a channel whose version is not proved is refused outright, lasting, and the pane is not read', async () => {
            const cases = [
              ['no version recorded by the launch', { engineVersion: undefined }, {}, /the launch recorded none, its app-server reports/],
              ['a recorded version the app-server does not report', { engineVersion: '0.156.1' }, {}, /the launch recorded 0\.156\.1, its app-server reports/],
              ['an app-server that reports no version', {}, { initialize: () => ({ userAgent: 'tangleclaw (no version)' }) }, /its app-server reports none/]
            ];
            for (const [name, stateOver, handlers, expected] of cases) {
              store.getDb().prepare('DELETE FROM startup_control_channels').run();
              await world([userIdle()], stateOver, handlers);
              const screen = screenOf(fx.panes.idleDefaultLayout);
              const { answer, looks } = await gate(screen);
              assert.equal(answer.ready, false, name);
              assert.equal(answer.unavailable, true, name);
              assert.match(answer.observation, /this launch's Codex version could not be proved/, name);
              assert.match(answer.observation, expected, name);
              assert.match(answer.remedy, /relaunch the session/, name);
              assert.equal(looks, 1, `${name}: waiting does not prove a version`);
              assert.equal(screen.asked.length, 0, `${name}: no rule to read the pane by`);
              server.close();
              server = null;
            }
          });
        });

        describe('the fire', () => {
          it('the automatic fire sends once on a usable composer, after one fresh read under this version\'s declaration', async () => {
            await world([userIdle()]);
            const screen = screenOf(fx.panes.idleDefaultLayout);
            const settled = await fireOn(screen, true);
            assert.equal(settled.outcome, 'applied');
            assert.equal(server.calls('turn/start').length, 1);
            assert.equal(screen.asked.length, 1);
            assert.equal(screen.asked[0].single, true);
            assert.equal(screen.asked[0].footerRe.source, codexProfile.capabilities.wake.restRows[version].footerPattern);
          });

          it('the automatic fire on the single-item status row: sent, the row checked against the model the readiness read', async () => {
            await world([userIdle()]);
            const settled = await fireOn(screenOf(fx.panes.idleSingleItemStatus), true);
            assert.equal(settled.outcome, 'applied');
          });

          for (const name of ['startScreen', 'resumingScreen']) {
            it(`a footer that is alone at the send (${name}): nothing sent, although the thread reads idle`, async () => {
              await world([userIdle()]);
              const settled = await fireOn(screenOf(fx.panes[name]), true);
              assert.equal(settled.outcome, 'blocked');
              assert.equal(settled.reasonCode, 'pane_not_ready');
              assert.match(settled.reason, /was not seen ready immediately before the send/);
              assert.match(settled.reason, OPENING_WHY);
              assert.equal(server.calls('turn/start').length, 0);
            });
          }

          it('a footer that changes between the gate and the send: the gate was ready, the send-time read refuses', async () => {
            await world([userIdle()]);
            const drawn = fx.panes.idleDefaultLayout;
            const gone = { ...drawn, rows: drawn.rows.map((row, i) => (i > drawn.y && /for shortcuts/.test(row) ? '' : row)) };
            const screen = screenOf((kind) => (kind === 'read-once' ? gone : drawn));
            assert.deepEqual((await gate(screen)).answer, { ready: true });
            const settled = await fireOn(screen, true);
            assert.equal(settled.outcome, 'blocked');
            assert.equal(settled.reasonCode, 'pane_not_ready');
            assert.match(settled.reason, /something other than one status row and then the declared footer row/);
            assert.equal(server.calls('turn/start').length, 0);
          });

          it('a streaming frame at the send: the pane passes, the thread read after it refuses, nothing is sent', async () => {
            const { table } = await world([userIdle()]);
            const screen = screenOf(fx.turnFrames.streamingFirst);
            screen.afterWitness = () => { table.set(THREAD, captured('userActive', THREAD)); };
            const settled = await fireOn(screen, true);
            assert.equal(settled.outcome, 'blocked');
            assert.match(settled.reason, /the launch's thread was active, not idle/);
            assert.equal(server.calls('turn/start').length, 0);
          });

          it('a folder with no trust entry stays refused on this version: it is on no measured list', async () => {
            await world([userIdle()], {}, { 'config/read': () => ({ config: { projects: { '/somewhere/else': { trust_level: 'trusted' } } } }) });
            const screen = screenOf(fx.panes.idleDefaultLayout);
            const settled = await fireOn(screen, false);
            assert.equal(settled.outcome, 'blocked');
            assert.equal(settled.reasonCode, 'trust_required');
            assert.match(settled.reason, new RegExp(`It is not established for Codex ${version.replace(/\./g, '\\.')} whether a trust prompt is shown`));
            assert.equal(screen.asked.length, 0);
            assert.equal(server.calls('turn/start').length, 0);
            assert.deepEqual(codexProfile.capabilities.startupControl.remoteTrustPrompt.absentOn.includes(version), false);
          });
        });

        describe('whose thread is the launch\'s', () => {
          it('unbound, the user thread beside an idle title helper: binds the user thread, and the wake reads idle, naming the version', async () => {
            await world([userAfterTurn(), titleIdle()]);
            assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle', version });
            assert.equal(threadOf(), THREAD);
          });

          it('unbound, the same two threads: the gate and the operator\'s fire take the user thread', async () => {
            await world([userAfterTurn(), titleIdle()]);
            assert.deepEqual((await gate(screenOf(fx.panes.idleAfterTurn))).answer, { ready: true });
            assert.equal(threadOf(), THREAD);
            server.close();
            store.getDb().prepare('DELETE FROM startup_control_channels').run();
            await world([userAfterTurn(), titleIdle()]);
            const settled = await fireOn(screenOf(fx.panes.idleAfterTurn), false);
            assert.equal(settled.outcome, 'applied');
            assert.equal(server.calls('turn/start')[0].params.threadId, THREAD);
          });

          it('a title helper alone is never bound', async () => {
            await world([titleIdle()]);
            assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-unbound', version });
            assert.equal(threadOf(), null);
            const { answer } = await gate(screenOf(fx.panes.idleAfterTurn));
            assert.equal(answer.ready, false);
            assert.match(answer.observation, /only Codex's title helper is loaded for the project directory, and it is never the launch's thread/);
            const settled = await fireOn(screenOf(fx.panes.idleAfterTurn), false);
            assert.equal(settled.outcome, 'blocked');
            assert.equal(settled.reasonCode, 'engine_not_ready');
            assert.equal(threadOf(), null);
            assert.equal(server.calls('turn/start').length, 0);
          });

          it('two user threads stay ambiguous, with or without a title helper', async () => {
            await world([userAfterTurn(), captured('userIdleAfterTurn', SECOND), titleIdle()]);
            assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-ambiguous', version });
            assert.equal(threadOf(), null);
            const settled = await fireOn(screenOf(fx.panes.idleAfterTurn), false);
            assert.equal(settled.outcome, 'blocked');
            assert.match(settled.reason, /2 threads are loaded for the project directory and none is recorded as this launch's/);
            assert.equal(server.calls('turn/start').length, 0);
          });

          it('a thread whose metadata is missing or changed is not guessed into either kind: nothing binds', async () => {
            const spoiled = [
              ['a title helper with no threadSource', () => { const t = titleIdle(); delete t.threadSource; return [userAfterTurn(), t]; }],
              ['a title helper that is not ephemeral', () => [userAfterTurn(), titleIdle({ ephemeral: false })]],
              ['a title helper with a rollout path', () => [userAfterTurn(), titleIdle({ path: '/x/rollout.jsonl' })]],
              ['a title helper with no path field', () => { const t = titleIdle(); delete t.path; return [userAfterTurn(), t]; }],
              ['a thread of another source', () => [userAfterTurn(), titleIdle({ threadSource: 'review' })]],
              ['a user thread that is ephemeral', () => [userAfterTurn({ ephemeral: true })]],
              ['a user thread with no rollout path', () => [userAfterTurn({ path: '' })]],
              ['a user thread with a parent', () => [userAfterTurn({ parentThreadId: SECOND })]],
              ['a user thread with no ephemeral field', () => { const t = userAfterTurn(); delete t.ephemeral; return [t]; }]
            ];
            for (const [name, threads] of spoiled) {
              store.getDb().prepare('DELETE FROM startup_control_channels').run();
              await world(threads());
              assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-ambiguous', version }, name);
              assert.equal(threadOf(), null, name);
              const settled = await fireOn(screenOf(fx.panes.idleAfterTurn), false);
              assert.equal(settled.outcome, 'blocked', name);
              assert.match(settled.reason, /could not be identified as this launch's own or as Codex's title helper/, name);
              assert.equal(threadOf(), null, name);
              assert.equal(server.calls('turn/start').length, 0, name);
              server.close();
              server = null;
            }
          });

          it('an active title helper holds the wake, and a fire, automatic or the operator\'s, bound or not', async () => {
            for (const recorded of [null, THREAD]) {
              store.getDb().prepare('DELETE FROM startup_control_channels').run();
              await world([userAfterTurn(), titleActive()], { threadId: recorded });
              assert.deepEqual(await observe(), { state: 'busy', reasonCode: 'other-thread-active', version }, `recorded ${recorded}`);
              for (const automatic of [true, false]) {
                const screen = screenOf(fx.panes.idleAfterTurn);
                const settled = await fireOn(screen, automatic);
                assert.equal(settled.outcome, 'blocked', `automatic ${automatic}`);
                assert.equal(settled.reasonCode, 'engine_not_ready');
                assert.match(settled.reason, /another thread loaded for the project directory is working/);
              }
              const { answer } = await gate(screenOf(fx.panes.idleAfterTurn));
              assert.equal(answer.ready, false);
              assert.match(answer.observation, /another thread loaded for the project directory is working/);
              assert.equal(server.calls('turn/start').length, 0);
              server.close();
              server = null;
            }
          });

          it('a title helper in a status the protocol does not promise holds both', async () => {
            await world([userAfterTurn(), titleIdle({ status: { type: 'somethingNew' } })], { threadId: THREAD });
            assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'other-thread-status-unknown', version });
            const settled = await fireOn(screenOf(fx.panes.idleAfterTurn), false);
            assert.equal(settled.outcome, 'blocked');
            assert.match(settled.reason, /is in a state the protocol does not promise/);
            assert.equal(server.calls('turn/start').length, 0);
          });

          it('an unreadable title helper refuses, bound or not', async () => {
            for (const recorded of [null, THREAD]) {
              store.getDb().prepare('DELETE FROM startup_control_channels').run();
              await world([userAfterTurn(), unreadable(TITLE)], { threadId: recorded });
              assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'threads-unreadable', version });
              const settled = await fireOn(screenOf(fx.panes.idleAfterTurn), false);
              assert.equal(settled.outcome, 'blocked');
              assert.match(settled.reason, /a loaded thread could not be read, so the launch's own thread could not be told from the others/);
              const { answer } = await gate(screenOf(fx.panes.idleAfterTurn));
              assert.equal(answer.ready, false);
              assert.equal(answer.unavailable, true, 'a read that could not be made');
              assert.equal(threadOf(), recorded);
              assert.equal(server.calls('turn/start').length, 0);
              server.close();
              server = null;
            }
          });

          it('a recorded user thread stays bound beside an idle title helper, and is fired at', async () => {
            await world([userAfterTurn(), titleIdle()], { threadId: THREAD });
            assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle', version });
            assert.equal(threadOf(), THREAD);
            const settled = await fireOn(screenOf(fx.panes.idleAfterTurn), true);
            assert.equal(settled.outcome, 'applied');
            assert.equal(server.calls('turn/start')[0].params.threadId, THREAD);
          });

          it('a recorded thread stays authoritative even where filtering would not have chosen it', async () => {
            // Recorded before these rules, or by a fire: its metadata is not asked for again.
            await world([userAfterTurn({ threadSource: 'somethingElse' }), titleIdle()], { threadId: THREAD });
            assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle', version });
            assert.deepEqual((await gate(screenOf(fx.panes.idleAfterTurn))).answer, { ready: true });
          });

          it('a recorded thread that is missing does not fall back to the one that is loaded', async () => {
            await world([captured('userIdleAfterTurn', SECOND), titleIdle()], { threadId: THREAD });
            assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-not-loaded', version });
            assert.equal(threadOf(), THREAD);
            const settled = await fireOn(screenOf(fx.panes.idleAfterTurn), false);
            assert.equal(settled.outcome, 'blocked');
            assert.match(settled.reason, /the launch's recorded thread is not loaded for the project directory/);
            assert.equal(threadOf(), THREAD);
            assert.equal(server.calls('turn/start').length, 0);
          });

          it('a binding that loses its race, or a second user thread appearing after it, refuses', async () => {
            await world([userAfterTurn(), titleIdle()]);
            const realCas = store.startupControlChannels.updateAdapterStateIf;
            store.startupControlChannels.updateAdapterStateIf = (id) => ({ written: false, channel: { ...store.startupControlChannels.get(id), adapterState: { threadId: SECOND } } });
            try {
              assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-bind-contended', version });
            } finally {
              store.startupControlChannels.updateAdapterStateIf = realCas;
            }
            assert.equal(threadOf(), null);
            server.close();

            store.getDb().prepare('DELETE FROM startup_control_channels').run();
            let lists = 0;
            const { table } = await world([userAfterTurn(), titleIdle()], {}, {
              'thread/loaded/list': () => {
                lists += 1;
                if (lists === 2) table.set(SECOND, captured('userIdleAfterTurn', SECOND));
                return { data: [...table.keys()], nextCursor: null };
              }
            });
            assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-ambiguous', version }, 'the fresh read after the write no longer shows one sole launch thread');
          });

          describe('the gate and the fire bind as the wake does: compare-and-set, then the same sole thread read again', () => {
            /** Every way this launch can be asked for its thread and then act on the answer. */
            const ASKERS = [
              ['the launch gate', async () => { const { answer } = await gate(screenOf(fx.panes.idleAfterTurn), 1000); return answer.ready === true ? null : answer.observation; }],
              ['the operator\'s fire', async () => { const row = await fireOn(screenOf(fx.panes.idleAfterTurn), false); return row.outcome === 'blocked' ? row.reason : null; }],
              ['the automatic fire', async () => { const row = await fireOn(screenOf(fx.panes.idleAfterTurn), true); return row.outcome === 'blocked' ? row.reason : null; }]
            ];
            /**
             * Run `body` with one method of the channel store replaced.
             * @param {string} name - The method.
             * @param {Function} make - Given the real method, returns the stand-in.
             * @param {Function} body - What to run.
             * @returns {Promise<void>}
             */
            const withStore = async (name, make, body) => {
              const real = store.startupControlChannels[name];
              store.startupControlChannels[name] = make(real.bind(store.startupControlChannels));
              try {
                await body();
              } finally {
                store.startupControlChannels[name] = real;
              }
            };
            const fresh = async (threads, stateOver = {}, handlers = {}) => {
              if (server) { server.close(); server = null; }
              store.getDb().prepare('DELETE FROM startup_control_channels').run();
              return world(threads, stateOver, handlers);
            };

            for (const [who, ask] of ASKERS) {
              it(`${who}: the bind is two conditional writes on the launch's own open channel, provisional and then proved, and is not written any other way`, async () => {
                await fresh([userAfterTurn(), titleIdle()]);
                const seen = [];
                let plainWrites = 0;
                let listsAtFirstWrite = null;
                let listsAtSecondWrite = null;
                await withStore('setAdapterState', (real) => (id, patch) => { if ('threadId' in patch || 'provisionalThreadId' in patch) plainWrites += 1; return real(id, patch); }, async () => {
                  await withStore('updateAdapterStateIf', (real) => (id, expect, patch) => {
                    const row = store.startupControlChannels.get(id);
                    if (seen.length === 0) listsAtFirstWrite = server.calls('thread/loaded/list').length;
                    if (seen.length === 1) listsAtSecondWrite = server.calls('thread/loaded/list').length;
                    seen.push({
                      patch,
                      genuine: expect(row),
                      closed: expect({ ...row, state: 'closed' }),
                      otherLaunch: expect({ ...row, sequenceId: row.sequenceId + 1 }),
                      otherThread: expect({ ...row, adapterState: { ...row.adapterState, threadId: SECOND } }),
                      unbound: expect({ ...row, adapterState: { ...row.adapterState, threadId: null, provisionalThreadId: null } }),
                      proved: expect({ ...row, adapterState: { ...row.adapterState, threadId: THREAD, provisionalThreadId: null } }),
                      otherProvisional: expect({ ...row, adapterState: { ...row.adapterState, threadId: null, provisionalThreadId: SECOND } }),
                      bothFields: expect({ ...row, adapterState: { ...row.adapterState, threadId: THREAD, provisionalThreadId: THREAD } })
                    });
                    return real(id, expect, patch);
                  }, async () => {
                    assert.equal(await ask(), null, 'bound, proved and answered');
                  });
                });
                assert.equal(seen.length, 2, 'two conditional writes: the inference, then its proof');
                // The inference: only onto this launch's open channel with no thread of either kind on it, and never into `threadId`.
                assert.deepEqual(seen[0], { patch: { provisionalThreadId: THREAD }, genuine: true, closed: false, otherLaunch: false, otherThread: false, unbound: true, proved: false, otherProvisional: false, bothFields: false });
                // The proof: only while that same thread is the provisional one and nothing is recorded.
                assert.deepEqual(seen[1], { patch: { threadId: THREAD, provisionalThreadId: null }, genuine: true, closed: false, otherLaunch: false, otherThread: false, unbound: false, proved: false, otherProvisional: false, bothFields: false });
                assert.equal(listsAtFirstWrite, 1, 'the inference is written after the first list');
                assert.equal(listsAtSecondWrite, 2, 'and proved only after the threads were listed again');
                assert.equal(plainWrites, 0, 'the thread is never written unconditionally');
                assert.deepEqual(binding(), { threadId: THREAD, provisional: null });
              });

              it(`${who}: a bind that another writer won, that a changed generation refused, or that failed, binds nothing and sends nothing`, async () => {
                const LOST = /was bound to another thread, or by another reader, or was replaced, while this one was being chosen/;
                const lost = [
                  ['another thread was bound first', () => (id) => ({ written: false, channel: { ...store.startupControlChannels.get(id), adapterState: { threadId: SECOND } } }), LOST],
                  ['the channel is no longer this launch\'s', () => (id) => ({ written: false, channel: store.startupControlChannels.get(id) }), LOST],
                  // Another reader persisted the SAME thread first: this caller lost the write and did not make that inference.
                  ['another reader bound the same thread first', () => (id) => ({ written: false, channel: { ...store.startupControlChannels.get(id), adapterState: { provisionalThreadId: THREAD } } }), LOST],
                  ['another reader bound and proved the same thread first', () => (id) => ({ written: false, channel: { ...store.startupControlChannels.get(id), adapterState: { threadId: THREAD, provisionalThreadId: null } } }), LOST],
                  ['the write answered nothing', () => () => null, LOST],
                  ['the write threw', () => () => { throw new Error('database is locked'); }, /could not be recorded on its channel, so it is not bound and nothing is sent on it/]
                ];
                for (const [name, make, expected] of lost) {
                  await fresh([userAfterTurn(), titleIdle()]);
                  await withStore('updateAdapterStateIf', make, async () => {
                    const reason = await ask();
                    assert.match(String(reason), expected, name);
                    assert.doesNotMatch(String(reason), /database is locked/, 'the fault\'s own text stays in the log');
                  });
                  assert.equal(threadOf(), null, name);
                  assert.equal(server.calls('turn/start').length, 0, name);
                }
              });

              it(`${who}: a second user thread, a title helper or an unreadable thread appearing after the first list refuses`, async () => {
                const arrivals = [
                  ['a second user thread', () => captured('userIdleAfterTurn', SECOND), [userAfterTurn()], /changed while the launch's thread was being bound/],
                  ['an idle title helper', () => titleIdle(), [userAfterTurn()], /changed while the launch's thread was being bound/],
                  ['an active title helper', () => titleActive(), [userAfterTurn()], /changed while the launch's thread was being bound/],
                  ['an unidentified thread', () => titleIdle({ threadSource: 'review' }), [userAfterTurn()], /changed while the launch's thread was being bound/],
                  // The gate says a read was not made in its own words; a fire gives the adapter's.
                  ['a thread that cannot be read', () => unreadable(TITLE), [userAfterTurn()], /a loaded thread could not be read|the loaded threads could not all be read over the channel/],
                  ['the title helper leaving', () => null, [userAfterTurn(), titleIdle()], /changed while the launch's thread was being bound/]
                ];
                for (const [name, arriving, start, expected] of arrivals) {
                  let lists = 0;
                  const { table } = await fresh(start, {}, {
                    'thread/loaded/list': () => {
                      lists += 1;
                      if (lists === 2) {
                        const t = arriving();
                        if (t === null) table.delete(TITLE);
                        else table.set(t instanceof Error ? t.threadId : t.id, t);
                      }
                      return { data: [...table.keys()], nextCursor: null };
                    }
                  });
                  const reason = await ask();
                  assert.match(String(reason), expected, name);
                  assert.ok(lists >= 2, `${name}: the threads were listed again after the bind`);
                  assert.equal(server.calls('turn/start').length, 0, name);
                }
              });

              it(`${who}: the launch's thread turning into another kind between the two reads refuses, although its id is the same`, async () => {
                let lists = 0;
                const { table } = await fresh([userAfterTurn(), titleIdle()], {}, {
                  'thread/loaded/list': () => {
                    lists += 1;
                    if (lists === 2) table.set(THREAD, userAfterTurn({ ephemeral: true }));
                    return { data: [...table.keys()], nextCursor: null };
                  }
                });
                assert.match(String(await ask()), /changed while the launch's thread was being bound/);
                assert.equal(server.calls('turn/start').length, 0);
              });

              it(`${who}: a channel closed, replaced or rebound while its thread was being read is not answered for, bound here or recorded before`, async () => {
                const changes = [
                  ['closed', (row) => ({ ...row, state: 'closed' })],
                  ['another launch\'s', (row) => ({ ...row, sequenceId: row.sequenceId + 1 })],
                  ['bound to another thread', (row) => ({ ...row, adapterState: { ...row.adapterState, threadId: SECOND } })],
                  ['gone', () => null],
                  ['unreadable', () => { throw new Error('database is locked'); }],
                  ['holding a provisional thread beside it', (row) => ({ ...row, adapterState: { ...row.adapterState, provisionalThreadId: SECOND } })]
                ];
                for (const recorded of [null, THREAD]) {
                  for (const [name, change] of changes) {
                    await fresh([userAfterTurn(), titleIdle()], { threadId: recorded });
                    await withStore('get', (real) => (id) => change(real(id)), async () => {
                      // Unbound, the conditional write reads the same row and refuses first; either way nothing is answered for it.
                      const expected = recorded === null
                        ? /the launch's channel changed while its thread was being read|was bound to another thread, or by another reader, or was replaced, while this one was being chosen|could not be recorded on its channel|could not be recorded as proved/
                        : /the launch's channel changed while its thread was being read/;
                      assert.match(String(await ask()), expected, `${name}, recorded ${recorded}`);
                    });
                    assert.equal(server.calls('turn/start').length, 0, name);
                  }
                }
              });
            }

            for (const [who, ask] of ASKERS) {
              // One case per test: each ends in a fire that is applied, and a launch has one such fire.
              const FAILED_CHECKS = [
                ['a second user thread appeared after the write', (table) => table.set(SECOND, captured('userIdleAfterTurn', SECOND)), (table) => table.delete(SECOND), /threads are loaded for the project directory and none is recorded as this launch's/],
                ['a thread became unreadable after the write', (table) => table.set(TITLE, unreadable(TITLE)), (table) => table.set(TITLE, titleIdle()), /a loaded thread could not be read|the loaded threads could not all be read over the channel/]
              ];
              for (const [name, spoil, mend, second] of FAILED_CHECKS) {
                it(`${who}: ${name}: the inference is withdrawn, the next look cannot be ready or send on that id, and a later clean look binds`, async () => {
                  let lists = 0;
                  const { table } = await fresh([userAfterTurn(), titleIdle()], {}, {
                    'thread/loaded/list': () => {
                      lists += 1;
                      if (lists === 2) spoil(table);
                      return { data: [...table.keys()], nextCursor: null };
                    }
                  });
                  // Look one: bound provisionally, then the second list differs.
                  assert.notEqual(await ask(), null, 'the first look refuses');
                  assert.deepEqual(binding(), { threadId: null, provisional: null }, 'the inference was withdrawn');
                  // Look two, the change still in place: the first candidate is NOT a recorded thread.
                  assert.match(String(await ask()), second, 'the second look refuses too');
                  assert.deepEqual(binding(), { threadId: null, provisional: null });
                  assert.equal(server.calls('turn/start').length, 0, 'nothing was sent on the unvalidated id');
                  // Look three, the folder clean again: bound and proved.
                  mend(table);
                  assert.equal(await ask(), null, 'a later clean look binds');
                  assert.deepEqual(binding(), { threadId: THREAD, provisional: null });
                });
              }

              it(`${who}: where the withdrawal does not land, the id stays provisional and is still not acted on`, async () => {
                for (const failing of ['throws', 'answers written: false', 'answers nothing']) {
                  let lists = 0;
                  const { table } = await fresh([userAfterTurn(), titleIdle()], {}, {
                    'thread/loaded/list': () => {
                      lists += 1;
                      if (lists === 2) table.set(SECOND, captured('userIdleAfterTurn', SECOND));
                      return { data: [...table.keys()], nextCursor: null };
                    }
                  });
                  let writes = 0;
                  await withStore('updateAdapterStateIf', (real) => (id, expect, patch) => {
                    writes += 1;
                    if (writes === 1) return real(id, expect, patch);
                    if (failing === 'throws') throw new Error('database is locked');
                    return failing === 'answers nothing' ? null : { written: false, channel: store.startupControlChannels.get(id) };
                  }, async () => {
                    assert.notEqual(await ask(), null, `${failing}: the first look refuses whether or not the withdrawal landed`);
                  });
                  assert.deepEqual(binding(), { threadId: null, provisional: THREAD }, `${failing}: the id is still on the row, marked provisional`);
                  // The second user thread is still loaded and idle. A recorded thread would be answered for here; a provisional one is not.
                  assert.match(String(await ask()), /threads are loaded for the project directory and none is recorded as this launch's/, failing);
                  assert.deepEqual(binding(), { threadId: null, provisional: null }, `${failing}: and it is withdrawn now that the write lands`);
                  assert.equal(server.calls('turn/start').length, 0, failing);
                }
              });

              it(`${who}: a provisional id found on the row is proved from the start or withdrawn, never taken as recorded`, async () => {
                // Alone of its kind: proved on two fresh lists and then recorded, with no new first write.
                await fresh([userAfterTurn(), titleIdle()], { provisionalThreadId: THREAD });
                const patches = [];
                await withStore('updateAdapterStateIf', (real) => (id, expect, patch) => { patches.push(patch); return real(id, expect, patch); }, async () => {
                  assert.equal(await ask(), null);
                });
                assert.deepEqual(patches[0], { threadId: THREAD, provisionalThreadId: null }, 'no second inference is written over the first');
                assert.deepEqual(binding(), { threadId: THREAD, provisional: null });

                const notProved = [
                  ['beside a second user thread', [userAfterTurn(), captured('userIdleAfterTurn', SECOND)]],
                  ['beside an unidentified thread', [userAfterTurn(), titleIdle({ threadSource: 'review' })]],
                  ['beside a thread that cannot be read', [userAfterTurn(), unreadable(TITLE)]],
                  ['no longer loaded', [titleIdle()]],
                  ['no longer the sole launch thread, another being it', [captured('userIdleAfterTurn', SECOND)]]
                ];
                for (const [name, threads] of notProved) {
                  await fresh(threads, { provisionalThreadId: THREAD });
                  assert.notEqual(await ask(), null, name);
                  assert.deepEqual(binding(), { threadId: null, provisional: null }, `${name}: withdrawn`);
                  assert.equal(server.calls('turn/start').length, 0, name);
                }
              });

              it(`${who}: a proof that cannot be recorded leaves the id provisional, and the next look proves it`, async () => {
                await fresh([userAfterTurn(), titleIdle()]);
                let writes = 0;
                await withStore('updateAdapterStateIf', (real) => (id, expect, patch) => {
                  writes += 1;
                  if (writes === 2) throw new Error('database is locked');
                  return real(id, expect, patch);
                }, async () => {
                  const reason = await ask();
                  assert.match(String(reason), /was chosen but could not be recorded as proved, so it is not bound and nothing is sent on it/);
                  assert.doesNotMatch(String(reason), /database is locked/);
                });
                assert.deepEqual(binding(), { threadId: null, provisional: THREAD });
                assert.equal(server.calls('turn/start').length, 0);
                assert.equal(await ask(), null, 'the next look proves the same id and records it');
                assert.deepEqual(binding(), { threadId: THREAD, provisional: null });
              });
            }

            for (const [who, ask] of ASKERS) {
              it(`${who}: the withdrawal clears only its own unproved inference, never a thread that was proved or changed meanwhile`, async () => {
                const meanwhile = [
                  ['another reader proved the same thread', { threadId: THREAD, provisionalThreadId: null }, { threadId: THREAD, provisional: null }],
                  ['another thread was recorded', { threadId: SECOND, provisionalThreadId: null }, { threadId: SECOND, provisional: null }],
                  ['another thread was bound provisionally', { provisionalThreadId: SECOND }, { threadId: null, provisional: SECOND }]
                ];
                for (const [name, patch, left] of meanwhile) {
                  let lists = 0;
                  const { table } = await fresh([userAfterTurn(), titleIdle()], {}, {
                    'thread/loaded/list': () => {
                      lists += 1;
                      if (lists === 2) {
                        // The check is about to fail, and the row has moved on under this look.
                        table.set(SECOND, captured('userIdleAfterTurn', SECOND));
                        store.startupControlChannels.setAdapterState(store.startupControlChannels.getOpenBySession(session.id).id, patch);
                      }
                      return { data: [...table.keys()], nextCursor: null };
                    }
                  });
                  assert.notEqual(await ask(), null, `${name}: this look refuses`);
                  assert.deepEqual(binding(), left, `${name}: and leaves the row as the other writer left it`);
                }
              });

              it(`${who}: a proof this look did not write is not a proof, although the row then reads proved with the same thread`, async () => {
                await fresh([userAfterTurn(), titleIdle()]);
                let writes = 0;
                await withStore('updateAdapterStateIf', (real) => (id, expect, patch) => {
                  writes += 1;
                  if (writes !== 2) return real(id, expect, patch);
                  return { written: false, channel: { ...store.startupControlChannels.get(id), adapterState: { ...store.startupControlChannels.get(id).adapterState, threadId: THREAD, provisionalThreadId: null } } };
                }, async () => {
                  assert.match(String(await ask()), /was chosen but could not be recorded as proved, so it is not bound and nothing is sent on it/);
                });
                assert.equal(server.calls('turn/start').length, 0);
              });

              it(`${who}: after a bind lost to another reader of the same thread, a later look proceeds only once that binding is proved`, async () => {
                // Look one: the conditional write answers written: false with this look's own candidate on the row.
                const { table } = await fresh([userAfterTurn(), titleIdle()]);
                await withStore('updateAdapterStateIf', () => (id) => {
                  // The other reader's write, as the store would then hold it.
                  store.startupControlChannels.setAdapterState(id, { provisionalThreadId: THREAD });
                  return { written: false, channel: store.startupControlChannels.get(id) };
                }, async () => {
                  assert.match(String(await ask()), /was bound to another thread, or by another reader, or was replaced/);
                });
                assert.equal(server.calls('turn/start').length, 0, 'this look sends nothing');
                assert.deepEqual(binding(), { threadId: null, provisional: THREAD }, 'the other reader\'s inference is still unproved');
                // Look two, a second user thread now loaded: the matching id is not a validation.
                table.set(SECOND, captured('userIdleAfterTurn', SECOND));
                assert.match(String(await ask()), /threads are loaded for the project directory and none is recorded as this launch's/);
                assert.deepEqual(binding(), { threadId: null, provisional: null }, 'the failed inference is cleared');
                assert.equal(server.calls('turn/start').length, 0);
              });

              it(`${who}: a binding another reader has PROVED is a recorded thread, and the next look proceeds on it`, async () => {
                await fresh([userAfterTurn(), titleIdle(), captured('userIdleAfterTurn', SECOND)], { threadId: THREAD });
                assert.equal(await ask(), null, 'a second idle user thread does not unseat a proved binding');
                assert.deepEqual(binding(), { threadId: THREAD, provisional: null });
              });
            }

            it('an unproved thread is never in the field a recorded thread is read from, so no other reader can take it for one', async () => {
              // Mid-proof: the row as it stands between the two writes of a look.
              let lists = 0;
              let between = null;
              await fresh([userAfterTurn(), titleIdle()], {}, {
                'thread/loaded/list': () => {
                  lists += 1;
                  if (lists === 2) between = { ...store.startupControlChannels.getOpenBySession(session.id).adapterState };
                  return { data: [THREAD, TITLE], nextCursor: null };
                }
              });
              assert.deepEqual((await gate(screenOf(fx.panes.idleAfterTurn), 1000)).answer, { ready: true });
              assert.equal(between.provisionalThreadId, THREAD);
              assert.ok(!between.threadId, 'nothing is recorded until the proof');
              // A row left provisional: the rotation's rebind, which moves a RECORDED thread, finds none to move.
              await fresh([userAfterTurn(), titleIdle()], { provisionalThreadId: THREAD });
              const row = store.startupControlChannels.getOpenBySession(session.id);
              assert.ok(!row.adapterState.threadId);
              const moved = codex.rebindThread(row, { priorThreadId: THREAD, replacementThreadId: SECOND });
              assert.deepEqual({ written: moved.written, bound: moved.bound }, { written: false, bound: false });
              assert.deepEqual(binding(), { threadId: null, provisional: THREAD });
            });

            it('the wake binds by the same procedure: a failed check withdraws its inference, and a provisional id is never answered idle', async () => {
              let lists = 0;
              const { table } = await fresh([userAfterTurn(), titleIdle()], {}, {
                'thread/loaded/list': () => {
                  lists += 1;
                  if (lists === 2) table.set(SECOND, captured('userIdleAfterTurn', SECOND));
                  return { data: [...table.keys()], nextCursor: null };
                }
              });
              assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-ambiguous', version });
              assert.deepEqual(binding(), { threadId: null, provisional: null }, 'withdrawn');
              assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-ambiguous', version }, 'the second observation is not idle on that id');
              table.delete(SECOND);
              assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle', version });
              assert.deepEqual(binding(), { threadId: THREAD, provisional: null });

              // A provisional id left on the row, beside a second idle user thread.
              await fresh([userAfterTurn(), captured('userIdleAfterTurn', SECOND)], { provisionalThreadId: THREAD });
              assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-ambiguous', version });
              assert.deepEqual(binding(), { threadId: null, provisional: null });
              // And alone of its kind: proved, then idle.
              await fresh([userAfterTurn(), titleIdle()], { provisionalThreadId: THREAD });
              assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle', version });
              assert.deepEqual(binding(), { threadId: THREAD, provisional: null });
              // A row that turns provisional while the answer is being read is not answered idle.
              await fresh([userAfterTurn(), titleIdle()], { threadId: THREAD });
              const stale = store.startupControlChannels.getOpenBySession(session.id);
              store.startupControlChannels.setAdapterState(stale.id, { provisionalThreadId: SECOND });
              assert.deepEqual(await codex.observeActivity(stale, project, ours), { state: 'unknown', reasonCode: 'channel-changed', version });
            });

            // No path is known to write this row. It is pinned as a STATE: every
            // reader refuses it, and no reader repairs it, so it stays refused.
            it('a row holding BOTH a recorded and a provisional thread is refused by every reader on every look, nothing is sent, and the row is left as found', async () => {
              for (const provisional of [THREAD, SECOND]) {
                const both = { threadId: THREAD, provisionalThreadId: provisional };
                for (const [who, ask] of ASKERS) {
                  await fresh([userAfterTurn(), titleIdle()], both);
                  for (const look of ['first', 'second']) {
                    assert.match(String(await ask()), /the launch's channel changed while its thread was being read/, `${who}, ${look} look, provisional ${provisional}`);
                    assert.deepEqual(binding(), { threadId: THREAD, provisional }, `${who}, ${look} look: neither field was rewritten`);
                  }
                  assert.equal(server.calls('turn/start').length, 0, who);
                }
                await fresh([userAfterTurn(), titleIdle()], both);
                for (const look of ['first', 'second']) {
                  assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'channel-changed', version }, `the wake, ${look} look`);
                  assert.deepEqual(binding(), { threadId: THREAD, provisional });
                }
              }
            });

            it('the thread answered for is the one read AFTER the bind, not the one read before it', async () => {
              let lists = 0;
              const { table } = await fresh([userAfterTurn()], {}, {
                'thread/loaded/list': () => {
                  lists += 1;
                  if (lists === 2) table.set(THREAD, captured('userActive', THREAD));
                  return { data: [...table.keys()], nextCursor: null };
                }
              });
              const screen = screenOf(fx.panes.idleAfterTurn);
              const { answer } = await gate(screen, 1000);
              assert.equal(answer.ready, false);
              assert.match(answer.observation, /the launch's thread was active, not idle/);
              assert.equal(screen.asked.length, 0, 'the pane is not consulted for a thread that is working');
            });

            it('a recorded thread is not bound again: it is listed once before the pane and once after it', async () => {
              await fresh([userAfterTurn(), titleIdle()], { threadId: THREAD });
              let conditional = 0;
              const screen = screenOf(fx.panes.idleAfterTurn);
              let listsAtWitness = null;
              screen.afterWitness = () => { listsAtWitness = server.calls('thread/loaded/list').length; };
              await withStore('updateAdapterStateIf', (real) => (...a) => { conditional += 1; return real(...a); }, async () => {
                assert.deepEqual((await gate(screen, 1000)).answer, { ready: true });
              });
              assert.equal(conditional, 0);
              assert.equal(listsAtWitness, 1);
              assert.equal(server.calls('thread/loaded/list').length, 2);
            });

            for (const [who, automatic] of [['the launch gate', null], ['the automatic fire', true]]) {
              it(`${who}: what changed WHILE the pane was being witnessed refuses, where reading the chosen thread again would not show it`, async () => {
                const during = [
                  ['a second user thread appears and is working', (table) => table.set(SECOND, captured('userActive', SECOND)), /another thread loaded for the project directory is working/],
                  ['the title helper starts working', (table) => table.set(TITLE, titleActive()), /another thread loaded for the project directory is working/],
                  ['the title helper cannot be read', (table) => table.set(TITLE, unreadable(TITLE)), /a loaded thread could not be read/],
                  ['the title helper reports a status the protocol does not promise', (table) => table.set(TITLE, titleIdle({ status: { type: 'somethingNew' } })), /is in a state the protocol does not promise/],
                  ['the launch\'s own thread is no longer loaded', (table) => table.delete(THREAD), /the launch's recorded thread is not loaded for the project directory/]
                ];
                for (const [name, change, expected] of during) {
                  const { table } = await fresh([userAfterTurn(), titleIdle()], { threadId: THREAD });
                  const screen = screenOf(fx.panes.idleAfterTurn);
                  screen.afterWitness = () => change(table);
                  let reason;
                  if (automatic) {
                    const row = await fireOn(screen, true);
                    assert.equal(row.outcome, 'blocked', name);
                    assert.equal(row.reasonCode, 'pane_not_ready', name);
                    reason = row.reason;
                  } else {
                    const { answer } = await gate(screen, 1000);
                    assert.equal(answer.ready, false, name);
                    reason = answer.observation;
                  }
                  assert.equal(screen.answers[0].shown, true, `${name}: the pane itself passed`);
                  // The launch's own thread read idle throughout, except where it left.
                  assert.match(reason, expected, name);
                  assert.equal(server.calls('turn/start').length, 0, name);
                }
              });

              it(`${who}: a channel that stops being this launch's while the pane is witnessed refuses`, async () => {
                await fresh([userAfterTurn(), titleIdle()], { threadId: THREAD });
                const screen = screenOf(fx.panes.idleAfterTurn);
                const real = store.startupControlChannels.get;
                screen.afterWitness = () => { store.startupControlChannels.get = (id) => ({ ...real.call(store.startupControlChannels, id), sequenceId: 999 }); };
                try {
                  const reason = automatic ? (await fireOn(screen, true)).reason : (await gate(screen, 1000)).answer.observation;
                  assert.match(String(reason), /the launch's channel changed while its thread was being read/);
                } finally {
                  store.startupControlChannels.get = real;
                }
                assert.equal(server.calls('turn/start').length, 0);
              });
            }
          });

          it('a channel replaced while the answer was being read is not answered idle', async () => {
            await world([userAfterTurn(), titleIdle()], { threadId: THREAD });
            const stale = store.startupControlChannels.getOpenBySession(session.id);
            store.startupControlChannels.setAdapterState(stale.id, { threadId: SECOND });
            assert.deepEqual(await codex.observeActivity(stale, project, ours), { state: 'unknown', reasonCode: 'channel-changed', version });
          });
        });
      });
    }

    describe('0.156.1 keeps every rule it had', () => {
      const fx = CODEX_CHANNEL_FIXTURES['0.161.0'];
      const at156 = (name, id) => ({ ...JSON.parse(JSON.stringify(fx.threads[name])), id, cwd: PROJECT_PATH });

      it('its candidates are every loaded project thread: a user thread beside a title-shaped one is ambiguous, and no answer names a version', async () => {
        await serve({
          'thread/loaded/list': () => ({ data: [THREAD, TITLE], nextCursor: null }),
          'thread/read': (p) => ({ thread: p.threadId === THREAD ? at156('userIdleAfterTurn', THREAD) : at156('titleIdle', TITLE) })
        });
        channel(LAUNCH_PANE);
        assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-ambiguous' });
        assert.equal(threadOf(), null);
      });

      it('its sole loaded thread binds whatever its metadata says, as before', async () => {
        await serve({
          'thread/loaded/list': () => ({ data: [TITLE], nextCursor: null }),
          'thread/read': () => ({ thread: at156('titleIdle', TITLE) })
        });
        channel(LAUNCH_PANE);
        assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
        assert.equal(threadOf(), TITLE);
      });

      it('its gate asks the witness exactly what it asked before, and another thread working does not hold its fire', async () => {
        await serve();
        channel(LAUNCH_PANE);
        const screen = screenOf(PANES.composer);
        assert.deepEqual((await gate(screen)).answer, { ready: true });
        assert.deepEqual(Object.keys(screen.asked[0]), ['headerRe', 'startingRe', 'statusRe', 'maxStatusRows', 'keyHintRe', 'paneId', 'paneServer']);
        assert.equal(screen.asked[0].maxStatusRows, 1);
        assert.equal(screen.asked[0].statusRe.flags, '', 'the status pattern is the one it had, not a model-aware one');
        server.close();

        store.getDb().prepare('DELETE FROM startup_control_channels').run();
        await serve({
          'thread/loaded/list': () => ({ data: [THREAD, TITLE], nextCursor: null }),
          'thread/read': (p) => ({ thread: p.threadId === THREAD ? { id: THREAD, cwd: PROJECT_PATH, status: { type: 'idle' }, path: '/x/rollout.jsonl' } : at156('titleActive', TITLE) })
        });
        channel({ ...LAUNCH_PANE, threadId: THREAD });
        assert.deepEqual((await gate(screenOf(PANES.composer))).answer, { ready: true }, 'the 0.156.1 gate reads its own thread only, as before');
      });
    });

    describe('the rule\'s own parts', () => {
      it('a thread\'s kind is read from its four fields and from nothing else', () => {
        const kind = codex._internal._threadKind;
        const user = { threadSource: 'user', ephemeral: false, path: '/x/r.jsonl', parentThreadId: null };
        const title = { threadSource: 'thread_title', ephemeral: true, path: null };
        assert.equal(kind(user), 'launch');
        assert.equal(kind({ ...user, parentThreadId: undefined }), 'launch');
        assert.equal(kind(title), 'title');
        for (const spoiled of [{ ...user, ephemeral: true }, { ...user, ephemeral: undefined }, { ...user, path: '' }, { ...user, path: null }, { ...user, parentThreadId: 'p' }, { ...user, threadSource: 'User' },
          { ...title, ephemeral: false }, { ...title, path: undefined }, { ...title, path: '' }, { ...title, threadSource: 'title' }, {}, null, undefined]) {
          assert.equal(kind(spoiled), 'unidentified', JSON.stringify(spoiled));
        }
      });

      it('the status pattern recognises a model alone on its row, and nothing else new', () => {
        const pattern = codex._internal._statusRowPattern;
        const withModel = pattern('gpt-6.1-sol');
        assert.ok(withModel.test('  GPT-6.1-Sol'));
        assert.ok(withModel.test('  gpt-6.1-sol'));
        assert.ok(withModel.test('  GPT-6.1-Sol default · /a/folder'), 'the shape it had is still a status row');
        for (const other of ['  GPT-6x1-Sol', '  GPT-6.1-Sol ', '  GPT-6.1-Sol more', ' GPT-6.1-Sol', '   GPT-6.1-Sol', '  ? for shortcuts', '  anything', 'GPT-6.1-Sol']) {
          assert.equal(withModel.test(other), false, JSON.stringify(other));
        }
        assert.ok(pattern('a+b(c)').test('  a+b(c)'), 'a model is matched as text, not as a pattern');
        assert.equal(pattern('a+b(c)').test('  aab(c)'), false);
        for (const unusable of [undefined, null, '', 42, 'two words', 'x'.repeat(81), 'tab\tbed']) {
          const plain = pattern(unusable);
          assert.equal(plain.flags, '', JSON.stringify(unusable));
          assert.equal(plain.test('  anything'), false);
          assert.ok(plain.test('  a · b'));
        }
      });

      it('the version is the recorded and the reported one, equal, and the table is asked for that version\'s own entry', () => {
        const rest = codex._internal._restScreen;
        const conn = (version) => ({ initResult: { userAgent: version ? `tangleclaw/${version} (x)` : 'tangleclaw' } });
        const row = (engineVersion) => ({ engineId: 'codex', adapterState: { engineVersion } });
        assert.equal(rest(conn('0.161.0'), row('0.161.0')).version, '0.161.0');
        assert.ok(rest(conn('0.161.0'), row('0.161.0')).footerRe instanceof RegExp);
        assert.equal(rest(conn('0.156.1'), row('0.156.1')).footerRe, null);
        assert.deepEqual(rest(conn('0.162.0'), row('0.161.0')), { unproved: true, recorded: '0.161.0', reported: '0.162.0' });
        assert.deepEqual(rest(conn(null), row('0.161.0')), { unproved: true, recorded: '0.161.0', reported: null });
        assert.deepEqual(rest(conn('0.161.0'), row(undefined)), { unproved: true, recorded: null, reported: '0.161.0' });
        // The installed binary is not consulted: a host that has since moved on does not change what a launch is.
        codex._internal._version.version = '0.999.0';
        assert.equal(rest(conn('0.162.0'), row('0.162.0')).version, '0.162.0');
        const realProfile = codex._seams.wakeProfile;
        codex._seams.wakeProfile = () => ({ restRows: Object.create({ '0.161.0': { footerRe: /x/ } }) });
        try {
          assert.equal(rest(conn('0.161.0'), row('0.161.0')).footerRe, null, 'an inherited entry is not the version\'s own');
        } finally {
          codex._seams.wakeProfile = realProfile;
        }
      });
    });
  });
});
