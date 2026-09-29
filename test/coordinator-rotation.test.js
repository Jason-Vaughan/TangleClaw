'use strict';

/*
 * Governed coordinator context rotation (#2032), against a fake Codex
 * app-server whose loaded threads the test controls.
 *
 * The incident: a Codex coordinator was `/clear`ed; its channel stayed bound
 * to the pre-clear thread, and every wake observation answered
 * `thread-not-loaded`. Ordinary observation must stay that way — it never
 * replaces a recorded thread. Only a managed rotation may, and only to the one
 * replacement it can prove, after fencing dispatch, and it is not done until
 * the replacement context's receipt checks out.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const codex = require('../lib/startup-control-codex');
const rotation = require('../lib/coordinator-rotation');
const { FakeAppServer } = require('./helpers/ws-test-server');

const PRIOR = '01a0e89b-70d8-7313-a00d-dbd017115385';
const NEXT = '01a0e89b-0000-7000-8000-00000000c1ea';
const HEAD = 'a'.repeat(40);

/** Process-identity seams under which pid 4242 IS the recorded app-server. */
const OURS = {
  psCommand: (pid) => (pid === 4242 ? 'codex app-server --listen unix:///x/requested.sock' : ''),
  psBirth: (pid) => (pid === 4242 ? 'Wed Sep 23 18:00:04 2026' : '')
};

/**
 * A complete checkpoint.
 * @param {object} [over] - Field overrides.
 * @returns {object}
 */
function checkpoint(over = {}) {
  return {
    schema: 1,
    role: 'architect',
    assignments: [{ lane: 'RM01', issue: 2027, head: 'b'.repeat(40) }],
    decisions: [{ id: 'A1', state: 'open' }],
    exchanges: [{ id: 'mx_1', with: 'tangleclaw-projectmanager' }],
    branch: { head: HEAD, ref: 'main', ownedDirt: [], status: 'clean' },
    nextActions: ['review #2029 at its exact head'],
    note: 'Wrapping for a controlled relaunch.',
    ...over
  };
}

describe('coordinator context rotation (#2032)', () => {
  let tempDir;
  let prevBase;
  let server;
  let sockN = 0;
  let keyN = 0;
  let project;
  let session;
  let projectPath;
  /** The fake inbox, oldest first. */
  let inbox;
  /** Every command typed into the pane. */
  let typed;
  /** What typing `/clear` does to the fake server's threads. */
  let onClear;
  /** What the checkout fingerprint seam observes. */
  let checkout;
  /** A clean checkout on main at HEAD. */
  const cleanCheckout = () => ({
    path: projectPath, ref: 'refs/heads/main', head: HEAD, statusDigest: 's'.repeat(64), trackedDiffDigest: 't'.repeat(64),
    dirty: [], untracked: {}, importantIgnored: {}
  });
  /** This test's launch: workload receipts are append-only, so each test gets its own. */
  let launchId;
  let launchN = 0;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rotation-'));
    projectPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rotation-proj-')));
    store.close();
    store._setBasePath(tempDir);
    store.init();
    project = store.projects.create({ name: 'Architect', path: projectPath, engine: 'codex' });
    session = store.sessions.start({ projectId: project.id, engineId: 'codex', tmuxSession: 'tc-rotation', primePrompt: '' });
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  beforeEach(() => {
    codex._internal._version.version = '0.156.1';
    for (const t of ['startup_control_channels', 'coordinator_rotations', 'coordinator_roles']) store.getDb().prepare(`DELETE FROM ${t}`).run();
    grant();
    inbox = [];
    typed = [];
    checkout = { ok: true, fingerprint: cleanCheckout() };
    launchId = `launch-architect-${++launchN}`;
    onClear = () => {
      // Codex /clear: the old thread unloads, one new root thread appears.
      server.state.threads.delete(PRIOR);
      server.state.threads.set(NEXT, { status: { type: 'idle' } });
    };
  });

  afterEach(() => {
    if (server) server.close();
    server = null;
  });

  /**
   * A fake app-server whose loaded threads are `server.state.threads`
   * (id → fields), each answering in the project directory unless it says
   * otherwise, with per-thread turn history.
   * @param {object<string, object>} threads - Initial threads.
   * @returns {Promise<FakeAppServer>}
   */
  async function serve(threads = { [PRIOR]: { status: { type: 'idle' } } }) {
    const sock = path.join(os.tmpdir(), `tcrot-${process.pid}-${++sockN}.sock`);
    try { fs.unlinkSync(sock); } catch { /* fresh */ }
    server = new FakeAppServer(sock);
    server.state = { threads: new Map(Object.entries(threads)), turns: new Map() };
    server.handlers = {
      initialize: () => ({ userAgent: 'tangleclaw/0.156.1 (Mac OS 15.6.1; arm64)', codexHome: '/x', platformFamily: 'unix', platformOs: 'macos' }),
      'thread/loaded/list': () => ({ data: [...server.state.threads.keys()], nextCursor: null }),
      'thread/read': (p) => {
        const t = server.state.threads.get(p.threadId);
        if (!t) throw Object.assign(new Error('not loaded'), { code: -32600 });
        return { thread: { id: p.threadId, cwd: projectPath, parentThreadId: null, source: 'cli', ...t } };
      },
      'thread/turns/list': (p) => {
        const turns = server.state.turns.get(p.threadId);
        if (!turns) throw Object.assign(new Error(`thread ${p.threadId} is not materialized yet`), { code: -32600 });
        return { data: turns, nextCursor: null };
      },
      'turn/start': (p) => {
        const item = { type: 'userMessage', id: `item-${p.threadId}`, clientId: p.clientUserMessageId, content: p.input };
        const list = server.state.turns.get(p.threadId) || [];
        list.push({ id: `turn-${list.length + 1}`, status: 'inProgress', items: [item] });
        server.state.turns.set(p.threadId, list);
        return { turn: { id: `turn-${list.length}`, status: 'inProgress', items: [] } };
      }
    };
    await server.start();
    return server;
  }

  /**
   * The session's open channel, recording `threadId`.
   * @param {object} [stateOver] - Adapter state overrides.
   * @param {object} [rowOver] - Row overrides.
   * @returns {object}
   */
  function channel(stateOver = {}, rowOver = {}) {
    return store.startupControlChannels.open({
      sessionId: session.id, sequenceId: 100, engineId: 'codex', adapter: 'codex',
      adapterState: {
        pid: 4242, birth: 'Wed Sep 23 18:00:04 2026', socketPath: '/x/requested.sock',
        resolvedSocketPath: server ? server.sockPath : '/x/nothing.sock', engineVersion: '0.156.1', threadId: PRIOR, serverVersion: null, ...stateOver
      },
      ...rowOver
    });
  }

  /**
   * The operator grants this test's project the architect role.
   * @returns {object} The role.
   */
  function grant() {
    return rotation.grantRole({ caller: { kind: 'operator' }, body: { projectId: project.id, role: 'architect' } }).body.role;
  }

  const access = () => ({ kind: 'project', projectId: project.id, sessionId: session.id, launchId });
  const threadOf = () => store.startupControlChannels.getOpenBySession(session.id).adapterState.threadId;
  const observe = () => codex.observeActivity(store.startupControlChannels.getOpenBySession(session.id), project, OURS);

  /** Seams for the rotation module, bound to this test's fakes. */
  const deps = () => ({
    adapterDeps: OURS,
    messages: () => inbox.slice(),
    fingerprint: () => (checkout.ok ? { ok: true, fingerprint: JSON.parse(JSON.stringify(checkout.fingerprint)) } : checkout),
    inject: (_name, command, opts) => {
      typed.push({ command, opts });
      if (command === '/clear') onClear();
      return { ok: true };
    },
    sleep: () => Promise.resolve()
  });

  /**
   * Prepare a rotation with a fresh attempt key.
   * @param {object} [body] - Body overrides.
   * @returns {{status: number, body: object}}
   */
  function prepare(body = {}) {
    keyN += 1;
    return rotation.prepare({ access: access(), body: { attemptKey: `attempt-${String(keyN).padStart(6, '0')}`, checkpoint: checkpoint(), ...body } }, deps());
  }

  /**
   * A workload receipt from the launch, received `offsetMs` from now.
   * @param {number} [offsetMs=1000]
   * @returns {void}
   */
  function workloadReceipt(offsetMs = 1000) {
    const nowMs = Date.now() + offsetMs;
    store.workloadReceipts.append({
      project_id: project.id, session_id: session.id, launch_id: launchId, assignment_id: null,
      state: 'working', clearance: 'do-not-clear', summary: 'reconciling after rotation',
      wait_kind: null, wait_detail: null, refs_json: '[]', branch: null, head_sha: null,
      source: 'tc-cli', received_at: new Date(nowMs).toISOString()
    }, { minIntervalMs: 0, nowMs });
  }

  /**
   * A receipt that satisfies every cross-check for `rot`.
   * @param {object} rot - The rotation view.
   * @param {object} [over] - Overrides.
   * @returns {object}
   */
  function receipt(rot, over = {}) {
    return {
      schema: 1,
      checkpointDigest: rot.checkpointDigest,
      restored: ['lane table', 'pending decisions'],
      drift: [],
      reconciled: {
        control: { stateGeneration: null },
        medusa: { handled: [] }
      },
      nextAction: 'resume the release queue',
      ...over
    };
  }

  /**
   * The resume nonce the last re-entry turn carried, read from what the fake
   * app-server received — the only place it exists in plaintext.
   * @returns {string}
   */
  function nonce() {
    const starts = server.calls('turn/start');
    const text = starts[starts.length - 1].params.input[0].text;
    return /Resume nonce[^`]*`([^`]+)`/.exec(text)[1];
  }

  /**
   * Prepare and drive a rotation to `reconciling`.
   * @returns {Promise<object>} The rotation.
   */
  async function toReconciling() {
    await serve();
    channel();
    const p = prepare();
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const r = await rotation.drive(p.body.rotation.rotationId, { attempts: 5, deps: deps() });
    assert.equal(r.state, 'reconciling', JSON.stringify(r));
    return rotation.view(r);
  }

  describe('E1: the incident, reproduced, stays fail-closed without a rotation', () => {
    it('a /clear that unloads the recorded thread and loads a replacement leaves the channel bound to the old one, and the wake view is thread-not-loaded', async () => {
      await serve();
      channel();
      assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
      onClear();
      assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-not-loaded' });
      assert.equal(threadOf(), PRIOR, 'ordinary observation never adopts the new thread');
    });

    it('an open rotation does not change that: observation still never rebinds', async () => {
      await serve();
      channel();
      assert.equal(prepare().status, 201);
      onClear();
      assert.deepEqual(await observe(), { state: 'unknown', reasonCode: 'thread-not-loaded' });
      assert.equal(threadOf(), PRIOR);
    });
  });

  describe('E1: prepare and the fence', () => {
    it('an incomplete checkpoint is refused with what is missing, and nothing is fenced', async () => {
      await serve();
      channel();
      const { note, branch, ...partial } = checkpoint();
      assert.ok(note && branch);
      const r = prepare({ checkpoint: { ...partial, schema: 2 } });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'ROTATION_CHECKPOINT_INCOMPLETE');
      assert.ok(r.body.missing.includes('note'));
      assert.ok(r.body.missing.includes('branch'));
      assert.ok(r.body.missing.some((m) => m.startsWith('schema')));
      assert.equal(rotation.openRotation(project.id), null);
      assert.equal(prepare({ checkpoint: 'prose summary' }).status, 400);
    });

    it('prepare records the checkpoint digest, the inbox interval and the next generation, and fences new dispatch but not replies', async () => {
      await serve();
      channel();
      inbox = [{ id: 'm-1' }, { id: 'm-2' }];
      const r = prepare();
      assert.equal(r.status, 201);
      const rot = r.body.rotation;
      assert.equal(rot.state, 'fenced');
      assert.equal(rot.fenced, true);
      assert.equal(rot.generation, 1);
      assert.equal(rot.priorThreadId, PRIOR);
      assert.deepEqual(rot.inboxIds, ['m-1', 'm-2']);
      assert.equal(rot.checkpointDigest, require('node:crypto').createHash('sha256').update(rotation.canonicalJson(checkpoint())).digest('hex'));

      const refused = rotation.gate({ projectId: project.id, access: access(), threadId: PRIOR, action: 'medusa-send' });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'COORDINATOR_FENCED');
      for (const action of rotation.GATED_ACTIONS) {
        assert.equal(rotation.gate({ projectId: project.id, access: access(), threadId: PRIOR, action, inReplyTo: 'm-1', messageIds: ['m-1'] }).body.code,
          'COORDINATOR_FENCED', `${action} is held until a replacement is bound`);
      }
      assert.equal(rotation.gate({ projectId: project.id + 1, access: access(), threadId: null, action: 'medusa-send' }), null, 'another project is not judged');
      assert.equal(rotation.gate({ projectId: project.id, access: { kind: 'operator' }, threadId: null, action: 'control-mutate' }), null, 'the operator is never gated');
    });

    it('the digest does not depend on key order', () => {
      const a = rotation.validateCheckpoint(checkpoint());
      const reordered = Object.fromEntries(Object.entries(checkpoint()).reverse());
      assert.equal(rotation.validateCheckpoint(reordered).digest, a.digest);
    });

    it('a replayed prepare returns the same rotation; the key reused for other content, or a second rotation, is refused', async () => {
      await serve();
      channel();
      const body = { attemptKey: 'replay-key-0001', checkpoint: checkpoint() };
      const first = rotation.prepare({ access: access(), body }, deps());
      const again = rotation.prepare({ access: access(), body: { ...body, checkpoint: Object.fromEntries(Object.entries(checkpoint()).reverse()) } }, deps());
      assert.equal(first.status, 201);
      assert.equal(again.status, 200);
      assert.equal(again.body.replayed, true);
      assert.equal(again.body.rotation.rotationId, first.body.rotation.rotationId);

      const reused = rotation.prepare({ access: access(), body: { ...body, checkpoint: checkpoint({ note: 'different' }) } }, deps());
      assert.equal(reused.status, 409);
      assert.equal(reused.body.code, 'ROTATION_ATTEMPT_KEY_REUSED');

      const second = prepare();
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'ROTATION_IN_PROGRESS');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) n FROM coordinator_rotations').get().n, 1);
    });

    it('a session with no rebindable channel, or no recorded thread, is refused before anything is recorded', async () => {
      await serve();
      let r = prepare();
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'ROTATION_ENGINE_UNSUPPORTED');
      channel({ threadId: null });
      r = prepare();
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'ROTATION_THREAD_UNBOUND');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) n FROM coordinator_rotations').get().n, 0);
    });
  });

  describe('E2: managed clear and authenticated rebind', () => {
    it('happy path: /clear is typed once, the one replacement is bound, the re-entry turn is delivered once, and observation answers for the new thread', async () => {
      await serve();
      channel();
      const p = prepare();
      const r = await rotation.drive(p.body.rotation.rotationId, { attempts: 5, deps: deps() });
      assert.equal(r.state, 'reconciling');
      assert.equal(r.replacementThreadId, NEXT);
      assert.equal(r.reentryDigest, rotation.reentryDigest(r));
      assert.deepEqual(typed.map((t) => t.command), ['/clear']);
      assert.equal(typed[0].opts.sessionId, session.id);
      assert.equal(threadOf(), NEXT);
      const starts = server.calls('turn/start');
      assert.equal(starts.length, 1);
      assert.equal(starts[0].params.threadId, NEXT);
      assert.equal(starts[0].params.clientUserMessageId, r.reentryDigest);
      assert.match(starts[0].params.input[0].text, /tc rotation resume --receipt/);
      assert.match(starts[0].params.input[0].text, /FENCED/);
      assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' }, 'the wake now observes the replacement');
      // Driving again changes nothing.
      await rotation.drive(r.rotationId, { attempts: 3, deps: deps() });
      assert.equal(server.calls('turn/start').length, 1);
      assert.equal(typed.length, 1);
    });

    it('a pass still waiting on the same thing does not rewrite the row', async () => {
      await serve({ [PRIOR]: { status: { type: 'active', activeFlags: [] } } });
      channel();
      const id = prepare().body.rotation.rotationId;
      const first = await rotation.advance(id, { ...deps(), now: () => '2026-09-29T00:00:01.000Z' });
      const again = await rotation.advance(id, { ...deps(), now: () => '2026-09-29T00:00:09.000Z' });
      assert.equal(first.failureCode, 'prior-thread-busy');
      assert.equal(again.updatedAt, first.updatedAt);
    });

    it('waits for the coordinator\'s turn to finish before clearing', async () => {
      await serve({ [PRIOR]: { status: { type: 'active', activeFlags: [] } } });
      channel();
      const id = prepare().body.rotation.rotationId;
      let r = await rotation.advance(id, deps());
      assert.equal(r.state, 'fenced');
      assert.equal(r.failureCode, 'prior-thread-busy');
      assert.equal(typed.length, 0);
      server.state.threads.set(PRIOR, { status: { type: 'idle' } });
      r = await rotation.drive(id, { attempts: 5, deps: deps() });
      assert.equal(r.state, 'reconciling');
      assert.equal(r.failureCode, null);
    });

    it('a /clear that does not take is typed again, a bounded number of times, then reported', async () => {
      await serve();
      channel();
      onClear = () => {};
      const r = await rotation.drive(prepare().body.rotation.rotationId, { attempts: 10, deps: deps() });
      assert.equal(r.state, 'rebinding');
      assert.equal(r.failureCode, 'clear-not-applied');
      assert.equal(typed.length, rotation.MAX_CLEAR_ATTEMPTS);
      assert.equal(threadOf(), PRIOR);
    });

    it('two new threads bind neither', async () => {
      await serve();
      channel();
      onClear = () => {
        server.state.threads.delete(PRIOR);
        server.state.threads.set(NEXT, { status: { type: 'idle' } });
        server.state.threads.set('another-new', { status: { type: 'idle' } });
      };
      const r = await rotation.drive(prepare().body.rotation.rotationId, { attempts: 3, deps: deps() });
      assert.equal(r.state, 'rebinding');
      assert.equal(r.failureCode, 'replacement-ambiguous');
      assert.equal(threadOf(), PRIOR);
      assert.equal(server.calls('turn/start').length, 0);
    });

    it('no new thread binds nothing', async () => {
      await serve();
      channel();
      onClear = () => { server.state.threads.delete(PRIOR); };
      const r = await rotation.drive(prepare().body.rotation.rotationId, { attempts: 3, deps: deps() });
      assert.equal(r.failureCode, 'replacement-not-loaded');
      assert.equal(threadOf(), PRIOR);
    });

    it('the prior thread still loaded beside a new one is not provable, and binds nothing', async () => {
      await serve();
      channel();
      onClear = () => { server.state.threads.set(NEXT, { status: { type: 'idle' } }); };
      const r = await rotation.drive(prepare().body.rotation.rotationId, { attempts: 3, deps: deps() });
      assert.equal(r.failureCode, 'prior-thread-still-loaded');
      assert.equal(threadOf(), PRIOR);
    });

    it('a new subagent, a thread in another directory, and a thread already loaded before the clear are never candidates', async () => {
      await serve({ [PRIOR]: { status: { type: 'idle' } }, 'old-other': { status: { type: 'idle' } } });
      channel();
      onClear = () => {
        server.state.threads.delete(PRIOR);
        server.state.threads.set('sub', { status: { type: 'idle' }, parentThreadId: NEXT, source: { subAgent: 'review' } });
        server.state.threads.set('elsewhere', { status: { type: 'idle' }, cwd: '/elsewhere' });
        server.state.threads.set(NEXT, { status: { type: 'idle' } });
      };
      const r = await rotation.drive(prepare().body.rotation.rotationId, { attempts: 5, deps: deps() });
      assert.equal(r.state, 'reconciling');
      assert.equal(r.replacementThreadId, NEXT);
    });

    it('a channel that changed under the rotation binds nothing', async () => {
      await serve();
      channel();
      const id = prepare().body.rotation.rotationId;
      store.getDb().prepare("UPDATE startup_control_channels SET state = 'closed'").run();
      channel({}, { sequenceId: 101 });
      const r = await rotation.advance(id, deps());
      assert.equal(r.failureCode, 'channel-changed');
      assert.equal(typed.length, 0);
      assert.equal(threadOf(), PRIOR);
    });

    it('a crash after the channel was rebound but before the rotation recorded it converges on the same thread', async () => {
      await serve();
      channel();
      const id = prepare().body.rotation.rotationId;
      await rotation.advance(id, deps());
      assert.equal(store.coordinatorRotations.get(id).state, 'rebinding');
      codex.rebindThread(store.startupControlChannels.getOpenBySession(session.id), { priorThreadId: PRIOR, replacementThreadId: NEXT });
      const r = await rotation.advance(id, deps());
      assert.equal(r.state, 'reconciling');
      assert.equal(r.replacementThreadId, NEXT);
      assert.equal(server.calls('turn/start').length, 1);
    });

    it('a re-entry turn that already landed is read back and never sent again', async () => {
      await serve({ [NEXT]: { status: { type: 'idle' } } });
      channel({ threadId: NEXT });
      const ch = store.startupControlChannels.getOpenBySession(session.id);
      let minted = 0;
      const turn = { threadId: NEXT, text: () => { minted += 1; return `rotate ${minted}`; }, clientId: 'c'.repeat(64) };
      assert.deepEqual(await codex.deliverTurn(ch, project, turn, OURS), { status: 'sent' });
      assert.deepEqual(await codex.deliverTurn(ch, project, turn, OURS), { status: 'already' });
      assert.equal(server.calls('turn/start').length, 1);
      assert.equal(minted, 1, 'the text (and its one-time secret) is produced only for a turn that is sent');
    });

    it('a crash after the re-entry turn was sent but before the rotation recorded it does not send it twice', async () => {
      const rot = await toReconciling();
      // Rewind the record to just before its last write; the turn is already on the thread.
      store.getDb().prepare("UPDATE coordinator_rotations SET state = 'rebinding', reentry_digest = NULL WHERE rotation_id = ?").run(rot.rotationId);
      const r = await rotation.advance(rot.rotationId, deps());
      assert.equal(r.state, 'reconciling');
      assert.equal(server.calls('turn/start').length, 1);
    });

    it('concurrent passes type /clear once and bind once', async () => {
      await serve();
      channel();
      const id = prepare().body.rotation.rotationId;
      await Promise.all([rotation.advance(id, deps()), rotation.advance(id, deps()), rotation.advance(id, deps())]);
      assert.equal(typed.length, 1);
      const joined = [rotation.drive(id, { attempts: 5, deps: deps() }), rotation.drive(id, { attempts: 5, deps: deps() })];
      assert.equal(joined[0], joined[1], 'a second driver joins the first');
      const [r] = await Promise.all(joined);
      assert.equal(r.state, 'reconciling');
      assert.equal(server.calls('turn/start').length, 1);
    });

    it('the old thread reappearing after the rebind does not move the binding back', async () => {
      await toReconciling();
      server.state.threads.set(PRIOR, { status: { type: 'idle' } });
      assert.deepEqual(await observe(), { state: 'idle', reasonCode: 'thread-idle' });
      assert.equal(threadOf(), NEXT);
      server.state.threads.set(PRIOR, { status: { type: 'active', activeFlags: [] } });
      assert.deepEqual(await observe(), { state: 'busy', reasonCode: 'other-thread-active' }, 'a working old thread still holds the wake');
    });

    it('rebindThread refuses a channel whose recorded thread is neither the prior nor the replacement', async () => {
      await serve();
      const ch = channel({ threadId: 'someone-else' });
      const r = codex.rebindThread(ch, { priorThreadId: PRIOR, replacementThreadId: NEXT });
      assert.equal(r.bound, false);
      assert.equal(threadOf(), 'someone-else');
    });
  });

  describe('E3: resume proof and the fence release', () => {
    it('a complete, checked receipt makes the rotation active and lifts the fence; a replay is idempotent', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      const r = rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.rotation.state, 'active');
      assert.equal(r.body.rotation.fenced, false);
      assert.equal(rotation.openRotation(project.id), null);
      assert.equal(rotation.gate({ projectId: project.id, access: access(), threadId: NEXT, action: 'medusa-send' }), null);
      assert.equal(store.coordinatorRotations.currentGeneration(project.id), 1);

      const replay = rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replayed, true);
      const changed = rotation.resume({ access: access(), threadId: NEXT, body: { ...body, receipt: receipt(rot, { nextAction: 'other' }) } }, deps());
      assert.equal(changed.status, 409);
      assert.equal(changed.body.code, 'ROTATION_ALREADY_ACTIVE');
    });

    it('missing evidence keeps the fence up and names each gap: undrained inbox, no workload receipt, wrong checkpoint', async () => {
      inbox = [{ id: 'left-behind' }];
      const rot = await toReconciling();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot, { checkpointDigest: '0'.repeat(64) }) };
      const r = rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'ROTATION_EVIDENCE_MISSING');
      assert.deepEqual(r.body.missing.map((m) => m.fact).sort(), ['checkpoint', 'medusa', 'workload']);
      assert.match(r.body.error, /left-behind/);
      assert.equal(store.coordinatorRotations.get(rot.rotationId).state, 'reconciling');
      assert.equal(rotation.gate({ projectId: project.id, access: access(), threadId: NEXT, action: 'medusa-send' }).status, 409);
    });

    it('messages that arrived after prepare stay queued and do not block the resume', async () => {
      const rot = await toReconciling();
      inbox = [{ id: 'arrived-during-absence' }];
      workloadReceipt();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      assert.equal(rotation.resume({ access: access(), threadId: NEXT, body }, deps()).status, 200);
    });

    it('the control generation must match the lane\'s', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      const lane = { state_generation: 3 };
      const realControl = store.control.getOpenForProject;
      store.control.getOpenForProject = () => lane;
      try {
        const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
        let r = rotation.resume({ access: access(), threadId: NEXT, body }, deps());
        assert.equal(r.status, 409);
        assert.deepEqual(r.body.missing.map((m) => m.fact), ['control']);
        body.receipt.reconciled.control.stateGeneration = 3;
        r = rotation.resume({ access: access(), threadId: NEXT, body }, deps());
        assert.equal(r.status, 200);
      } finally {
        store.control.getOpenForProject = realControl;
      }
    });

    it('an incomplete receipt, a stale generation or attempt, another launch, or a rotation not yet reconciling are refused', async () => {
      await serve();
      channel();
      const early = prepare().body.rotation;
      const earlyBody = { rotationId: early.rotationId, attemptKey: early.attemptKey, generation: early.generation, resumeNonce: 'none', receipt: receipt(early) };
      assert.equal(rotation.resume({ access: access(), threadId: NEXT, body: earlyBody }, deps()).body.code, 'ROTATION_NOT_RECONCILING');
      await rotation.drive(early.rotationId, { attempts: 5, deps: deps() });
      const rot = rotation.view(store.coordinatorRotations.get(early.rotationId));
      const base = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };

      let r = rotation.resume({ access: access(), threadId: NEXT, body: { ...base, receipt: { schema: 1 } } }, deps());
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'ROTATION_RECEIPT_INCOMPLETE');
      assert.ok(r.body.missing.includes('reconciled'));
      r = rotation.resume({ access: access(), threadId: NEXT, body: { ...base, receipt: receipt(rot, { restored: [] }) } }, deps());
      assert.equal(r.status, 400);

      r = rotation.resume({ access: access(), threadId: NEXT, body: { ...base, generation: rot.generation - 1 } }, deps());
      assert.equal(r.body.code, 'ROTATION_STALE_GENERATION');
      r = rotation.resume({ access: access(), threadId: NEXT, body: { ...base, attemptKey: 'attempt-other' } }, deps());
      assert.equal(r.body.code, 'ROTATION_STALE_GENERATION');
      r = rotation.resume({ access: { ...access(), launchId: 'other-launch' }, threadId: NEXT, body: base }, deps());
      assert.equal(r.status, 403);
      r = rotation.resume({ access: { ...access(), projectId: project.id + 1 }, threadId: NEXT, body: base }, deps());
      assert.equal(r.status, 404);
      assert.equal(store.coordinatorRotations.get(rot.rotationId).state, 'reconciling');
    });

    it('the next rotation takes the next generation, and the old one\'s receipt cannot resume it', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      assert.equal(rotation.resume({ access: access(), threadId: NEXT, body }, deps()).status, 200);
      // The replacement is now the prior thread of the next rotation.
      server.state.threads = new Map([[NEXT, { status: { type: 'idle' } }]]);
      const second = prepare();
      assert.equal(second.status, 201);
      assert.equal(second.body.rotation.generation, 2);
      assert.equal(second.body.rotation.priorThreadId, NEXT);
      const stale = rotation.resume({ access: access(), threadId: NEXT, body: { ...body, rotationId: second.body.rotation.rotationId } }, deps());
      assert.equal(stale.body.code, 'ROTATION_STALE_GENERATION');
    });

    it('only the operator can abandon a rotation, and abandoning lifts the fence without touching the channel', async () => {
      await serve();
      channel();
      const rot = prepare().body.rotation;
      assert.equal(rotation.abandon({ caller: { kind: 'project' }, body: { rotationId: rot.rotationId, reason: 'x' } }).status, 403);
      assert.equal(rotation.abandon({ caller: { kind: 'operator' }, body: { rotationId: rot.rotationId } }).status, 400);
      const r = rotation.abandon({ caller: { kind: 'operator' }, body: { rotationId: rot.rotationId, reason: 'coordinator relaunched by hand' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.rotation.state, 'abandoned');
      assert.equal(rotation.openRotation(project.id), null);
      assert.equal(threadOf(), PRIOR);
      assert.equal(prepare().body.rotation.generation, 2, 'an abandoned generation is never reused');
    });
  });

  describe('A11/A12: the epoch gate and the one-time resume nonce', () => {
    const judge = (action, over = {}, extra = {}) => rotation.gate({
      projectId: project.id, access: { ...access(), ...over.access }, threadId: 'threadId' in over ? over.threadId : NEXT, action, ...extra
    });

    it('while reconciling, the bound replacement may publish workload, ack control, and answer only its checkpoint\'s interval', async () => {
      inbox = [{ id: 'm-old' }];
      await toReconciling();
      assert.equal(judge('workload-set'), null);
      assert.equal(judge('control-ack'), null);
      assert.equal(judge('medusa-send', {}, { inReplyTo: 'm-old' }), null);
      assert.equal(judge('medusa-ack', {}, { messageIds: ['m-old'] }), null);
      assert.equal(judge('exchange-close', {}, { exchangeId: 'mx_1' }), null, 'mx_1 is in the checkpoint\'s exchanges');
      for (const [action, extra] of [
        ['medusa-send', {}], ['medusa-send', { inReplyTo: 'm-new' }], ['medusa-ack', { messageIds: ['m-old', 'm-new'] }],
        ['exchange-close', { exchangeId: 'mx_other' }], ['wrap', {}], ['session-rule-write', {}], ['control-mutate', {}]
      ]) {
        assert.equal(judge(action, {}, extra).body.code, 'COORDINATOR_FENCED', `${action} ${JSON.stringify(extra)} waits for the resume`);
      }
    });

    it('a stale thread, another launch, another session, an unbound caller or no thread header is refused as an epoch mismatch', async () => {
      await toReconciling();
      for (const over of [{ threadId: PRIOR }, { threadId: null }, { threadId: '' }, { access: { launchId: 'other' } },
        { access: { sessionId: 999 } }, { access: { kind: 'unbound' } }]) {
        assert.equal(judge('workload-set', over).body.code, 'COORDINATOR_EPOCH_MISMATCH', JSON.stringify(over));
      }
    });

    it('after resume every gated action needs the current epoch binding; the old thread is refused for all of them', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      assert.equal(rotation.resume({ access: access(), threadId: NEXT, body }, deps()).status, 200);
      for (const action of rotation.GATED_ACTIONS) {
        assert.equal(judge(action), null, `${action} from the bound replacement`);
        assert.equal(judge(action, { threadId: PRIOR }).body.code, 'COORDINATOR_EPOCH_MISMATCH', `${action} from the old thread`);
      }
    });

    it('resume needs the bound thread and the one-time nonce, and the nonce cannot be used twice', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      const good = nonce();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: good, receipt: receipt(rot) };
      assert.equal(rotation.resume({ access: access(), threadId: PRIOR, body }, deps()).body.code, 'COORDINATOR_EPOCH_MISMATCH');
      assert.equal(rotation.resume({ access: access(), threadId: null, body }, deps()).body.code, 'COORDINATOR_EPOCH_MISMATCH');
      assert.equal(rotation.resume({ access: access(), threadId: NEXT, body: { ...body, resumeNonce: 'guess' } }, deps()).body.code, 'ROTATION_NONCE_INVALID');
      assert.equal(rotation.resume({ access: access(), threadId: NEXT, body: { ...body, resumeNonce: undefined } }, deps()).body.code, 'ROTATION_NONCE_INVALID');
      assert.equal(rotation.resume({ access: access(), threadId: NEXT, body }, deps()).status, 200);
      const stored = store.coordinatorRotations.get(rot.rotationId);
      assert.equal(stored.resumeNonceHash, null, 'spent');
      assert.ok(!JSON.stringify(stored).includes(good), 'the nonce is never stored in plaintext');
    });

    it('the nonce exists only in the re-entry turn: the stored rotation holds its hash', async () => {
      const rot = await toReconciling();
      const stored = store.coordinatorRotations.get(rot.rotationId);
      assert.match(stored.resumeNonceHash, /^[0-9a-f]{64}$/);
      assert.ok(!JSON.stringify(stored).includes(nonce()));
      assert.ok(!JSON.stringify(rotation.view(stored, { checkpoint: true })).includes(nonce()));
    });

    it('an abandoned latest rotation releases the binding: the project is judged as before', async () => {
      const rot = await toReconciling();
      rotation.abandon({ caller: { kind: 'operator' }, body: { rotationId: rot.rotationId, reason: 'relaunched by hand' } });
      assert.equal(judge('medusa-send', { threadId: 'anything' }), null);
    });

    it('a project that never rotated is not judged', () => {
      assert.equal(rotation.gate({ projectId: 424242, access: { kind: 'unbound' }, threadId: null, action: 'wrap' }), null);
      assert.throws(() => rotation.gate({ projectId: 1, access: null, threadId: null, action: 'bogus' }), /not a gated action/);
    });
  });

  describe('A6a: the coordinator role is an operator grant, not a claim', () => {
    it('a project with no active role cannot prepare, whatever its checkpoint says it is', async () => {
      await serve();
      channel();
      store.getDb().prepare('DELETE FROM coordinator_roles').run();
      const r = prepare({ checkpoint: checkpoint({ role: 'architect' }) });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'ROTATION_NOT_COORDINATOR');
      assert.equal(rotation.openRotation(project.id), null);
    });

    it('prepare records the role and authority version it was prepared under', async () => {
      await serve();
      channel();
      const role = store.coordinatorRoles.getActiveForProject(project.id);
      const r = prepare();
      assert.deepEqual(r.body.rotation.role, { roleId: role.roleId, authorityVersion: role.authorityVersion });
    });

    it('only the operator grants or revokes a role; a regrant bumps the authority version', () => {
      assert.equal(rotation.grantRole({ caller: { kind: 'project' }, body: { projectId: project.id, role: 'architect' } }).status, 403);
      assert.equal(rotation.revokeRole({ caller: { kind: 'project' }, body: { projectId: project.id } }).status, 403);
      assert.equal(rotation.grantRole({ caller: { kind: 'operator-unverifiable', reason: 'x' }, body: {} }).status, 503);
      assert.equal(rotation.grantRole({ caller: { kind: 'operator' }, body: { projectId: project.id, role: 'emperor' } }).status, 400);
      assert.equal(rotation.grantRole({ caller: { kind: 'operator' }, body: { projectId: 99999, role: 'architect' } }).status, 404);
      const before = store.coordinatorRoles.getActiveForProject(project.id);
      const again = grant();
      assert.equal(again.authorityVersion, before.authorityVersion + 1);
      assert.equal(store.coordinatorRoles.get(before.roleId).status, 'revoked');
      const revoked = rotation.revokeRole({ caller: { kind: 'operator' }, body: { projectId: project.id } });
      assert.equal(revoked.status, 200);
      assert.equal(store.coordinatorRoles.getActiveForProject(project.id), null);
      assert.equal(rotation.revokeRole({ caller: { kind: 'operator' }, body: { projectId: project.id } }).status, 404);
    });

    it('a role revoked or regranted while the rotation is open is authority drift: no receipt can resume it', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      grant();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      const r = rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'ROTATION_OPERATOR_RECOVERY_REQUIRED');
      assert.deepEqual(r.body.drift.integrity.map((i) => i.class), ['authority']);
      const stored = store.coordinatorRotations.get(rot.rotationId);
      assert.equal(stored.state, 'reconciling');
      assert.deepEqual(stored.drift.integrity.map((i) => i.key), ['authority.coordinator-role']);
    });
  });

  describe('A7a: the checkout is fingerprinted at prepare and must be unchanged at resume', () => {
    it('prepare refuses a checkpoint whose head or ref is stale', async () => {
      await serve();
      channel();
      let r = prepare({ checkpoint: checkpoint({ branch: { head: 'b'.repeat(40), ref: 'main', ownedDirt: [] } }) });
      assert.equal(r.body.code, 'ROTATION_CHECKPOINT_STALE');
      r = prepare({ checkpoint: checkpoint({ branch: { head: HEAD, ref: 'other', ownedDirt: [] } }) });
      assert.equal(r.body.code, 'ROTATION_CHECKPOINT_STALE');
      assert.equal(prepare({ checkpoint: checkpoint({ branch: { head: HEAD, ref: 'refs/heads/main', ownedDirt: [] } }) }).status, 201);
    });

    it('prepare refuses dirt the checkpoint does not declare, and accepts it declared', async () => {
      await serve();
      channel();
      checkout.fingerprint.dirty = ['lib/a.js', 'notes/new.md'];
      let r = prepare({ checkpoint: checkpoint({ branch: { head: HEAD, ref: 'main', ownedDirt: ['lib/a.js'] } }) });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'ROTATION_UNDECLARED_DIRT');
      assert.deepEqual(r.body.undeclared, ['notes/new.md']);
      r = prepare({ checkpoint: checkpoint({ branch: { head: HEAD, ref: 'main', ownedDirt: ['lib/a.js', 'notes/new.md'] } }) });
      assert.equal(r.status, 201);
    });

    it('prepare refuses an unfingerprintable checkout or an important ignored file it cannot hash', async () => {
      await serve();
      channel();
      checkout = { ok: false, reason: 'status-unreadable' };
      assert.equal(prepare().body.code, 'ROTATION_CHECKOUT_UNAVAILABLE');
      checkout = { ok: true, fingerprint: { ...cleanCheckout(), importantIgnored: { '.env': 'unavailable:not-ignored' } } };
      const r = prepare({ checkpoint: checkpoint({ branch: { head: HEAD, ref: 'main', ownedDirt: [], importantIgnored: ['.env'] } }) });
      assert.equal(r.body.code, 'ROTATION_IGNORED_FILE_UNAVAILABLE');
    });

    it('any content change to the checkout during absence is a hard blocker, persisted as typed drift', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      checkout.fingerprint.trackedDiffDigest = 'e'.repeat(64);
      checkout.fingerprint.untracked = { 'scratch.txt': 'sha256:abc' };
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      const r = rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'ROTATION_OPERATOR_RECOVERY_REQUIRED');
      assert.deepEqual(r.body.drift.integrity.map((i) => i.key).sort(), ['checkout.trackedDiffDigest', 'checkout.untracked:scratch.txt']);
      assert.ok(r.body.drift.integrity.every((i) => i.class === 'checkout-integrity' && i.before && i.after));
      // Even a receipt that "acknowledges" it cannot resume.
      const acked = rotation.resume({ access: access(), threadId: NEXT, body: { ...body, receipt: receipt(rot, { drift: [{ key: 'checkout.trackedDiffDigest', disposition: 'accepted' }] }) } }, deps());
      assert.equal(acked.body.code, 'ROTATION_OPERATOR_RECOVERY_REQUIRED');
      assert.equal(rotation.gate({ projectId: project.id, access: access(), threadId: NEXT, action: 'medusa-send' }).status, 409);
    });

    it('a checkout that cannot be observed at resume keeps the fence up as unavailable evidence', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      checkout = { ok: false, reason: 'diff-unreadable' };
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      const r = rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(r.body.code, 'ROTATION_EVIDENCE_UNAVAILABLE');
      assert.deepEqual(store.coordinatorRotations.get(rot.rotationId).drift.unavailable, ['checkout: diff-unreadable']);
    });
  });

  describe('schema v51 migration', () => {
    it('upgrades a v50 store: the table and its one-open-rotation index appear, and the version advances', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rotation-mig-'));
      const saved = store._getBasePath();
      store.close();
      try {
        store._setBasePath(dir);
        store.init();
        store.close();
        const dbPath = path.join(dir, 'tangleclaw.db');
        const db = new DatabaseSync(dbPath);
        db.exec('DROP TABLE coordinator_rotations');
        db.exec('DROP TABLE coordinator_roles');
        db.exec('DELETE FROM schema_version WHERE version >= 51');
        db.exec('INSERT INTO schema_version (version) VALUES (50)');
        db.close();

        store._setBasePath(dir);
        store.init();
        store.close();
        const after = new DatabaseSync(dbPath);
        try {
          assert.equal(after.prepare('SELECT MAX(version) v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
          const index = after.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_coordinator_rotations_open'").get();
          assert.match(index.sql, /UNIQUE/);
          assert.match(index.sql, /WHERE state IN/);
          const roles = after.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_coordinator_roles_active'").get();
          assert.match(roles.sql, /UNIQUE/);
        } finally {
          after.close();
        }
      } finally {
        store._setBasePath(saved);
        store.init();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('the index allows one open rotation per project, but any number of finished ones', () => {
      const row = (id, state) => store.getDb().prepare(
        'INSERT INTO coordinator_rotations (rotation_id, attempt_key, project_id, session_id, launch_id, engine_id, channel_id, sequence_id, '
        + "state, generation, prior_thread_id, checkpoint_schema, checkpoint_digest, checkpoint_json, inbox_ids_json, "
        + "role_id, authority_version, checkout_json, created_at, updated_at) "
        + "VALUES (?, ?, 77, 1, 'l', 'codex', 1, 1, ?, 1, 't', 1, ?, '{}', '[]', 'r', 1, '{}', 'x', 'x')"
      ).run(id, `key-${id}-000`, state, 'd'.repeat(64));
      row('a', 'active');
      row('b', 'abandoned');
      row('c', 'fenced');
      assert.throws(() => row('d', 'reconciling'), /UNIQUE/);
    });
  });
});
