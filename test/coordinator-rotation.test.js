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
    github: [],
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
  /** What the GitHub seam observes: fact key → observation, or a string when unreadable. */
  let githubState;
  /**
   * The GitHub seam: observes each fact from `githubState`.
   * @param {object[]} facts - Checkpoint facts.
   * @returns {{observations: object[], unavailable: string[]}}
   */
  function githubSeam(facts) {
    const githubFacts = require('../lib/github-facts');
    const observations = [];
    const unavailable = [];
    for (const f of facts) {
      const key = githubFacts.factKey(f);
      const o = githubState[key];
      if (typeof o === 'string' || !o) unavailable.push(`${key}: ${o || 'unknown'}`);
      else observations.push({ key, fact: { repo: f.repo, kind: f.kind, number: f.number }, observed: o, digest: JSON.stringify(o) });
    }
    return { observations, unavailable };
  }
  /** The test clock, in ms. */
  let clockMs = Date.now();
  /** Whether the session has a Medusa listener. */
  let listening = true;
  /** Whether the project has the Medusa switchboard enabled. */
  let medusaOn = true;
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
    listening = true;
    medusaOn = true;
    clockMs = Date.now();
    githubState = {};
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
    listening: () => listening,
    medusaEnabled: () => medusaOn,
    github: async (facts) => githubSeam(facts),
    fingerprint: () => (checkout.ok ? { ok: true, fingerprint: JSON.parse(JSON.stringify(checkout.fingerprint)) } : checkout),
    inject: (_name, command, opts) => {
      typed.push({ command, opts });
      if (command === '/clear') onClear();
      return { ok: true };
    },
    // A test clock: every driver pause moves it forward, so the /clear retry
    // and settle windows can be exercised without waiting for them.
    now: () => new Date(clockMs).toISOString(),
    sleep: (ms) => { clockMs += ms; return Promise.resolve(); }
  });

  /**
   * Prepare a rotation with a fresh attempt key.
   * @param {object} [body] - Body overrides.
   * @returns {Promise<{status: number, body: object}>}
   */
  async function prepare(body = {}) {
    keyN += 1;
    return rotation.prepare({ access: access(), body: { attemptKey: `attempt-${String(keyN).padStart(6, '0')}`, checkpoint: checkpoint(), ...body } }, deps());
  }

  /**
   * A workload receipt from the launch, received `offsetMs` from now.
   * @param {number} [offsetMs=1000]
   * @returns {void}
   */
  function workloadReceipt(offsetMs = 60000) {
    const nowMs = clockMs + offsetMs;
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
    const p = await prepare();
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
      assert.equal((await prepare()).status, 201);
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
      const r = await prepare({ checkpoint: { ...partial, schema: 2 } });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'ROTATION_CHECKPOINT_INCOMPLETE');
      assert.ok(r.body.missing.includes('note'));
      assert.ok(r.body.missing.includes('branch'));
      assert.ok(r.body.missing.some((m) => m.startsWith('schema')));
      assert.equal(rotation.openRotation(project.id), null);
      assert.equal((await prepare({ checkpoint: 'prose summary' })).status, 400);
    });

    it('prepare records the checkpoint digest, the inbox interval and the next generation, and fences new dispatch but not replies', async () => {
      await serve();
      channel();
      inbox = [{ id: 'm-1' }, { id: 'm-2' }];
      const r = await prepare();
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

    it('a checkpoint nested past the depth cap is refused, not recursed into', async () => {
      await serve();
      channel();
      let deep = {};
      const top = deep;
      for (let i = 0; i < rotation.MAX_JSON_DEPTH + 5; i++) { deep.x = {}; deep = deep.x; }
      const r = await prepare({ checkpoint: checkpoint({ note: 'deep', decisions: [top] }) });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /nested deeper/);
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
      const first = await rotation.prepare({ access: access(), body }, deps());
      const again = await rotation.prepare({ access: access(), body: { ...body, checkpoint: Object.fromEntries(Object.entries(checkpoint()).reverse()) } }, deps());
      assert.equal(first.status, 201);
      assert.equal(again.status, 200);
      assert.equal(again.body.replayed, true);
      assert.equal(again.body.rotation.rotationId, first.body.rotation.rotationId);

      const reused = await rotation.prepare({ access: access(), body: { ...body, checkpoint: checkpoint({ note: 'different' }) } }, deps());
      assert.equal(reused.status, 409);
      assert.equal(reused.body.code, 'ROTATION_ATTEMPT_KEY_REUSED');

      const second = await prepare();
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'ROTATION_IN_PROGRESS');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) n FROM coordinator_rotations').get().n, 1);
    });

    it('a session with no rebindable channel, or no recorded thread, is refused before anything is recorded', async () => {
      await serve();
      let r = await prepare();
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'ROTATION_ENGINE_UNSUPPORTED');
      channel({ threadId: null });
      r = await prepare();
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'ROTATION_THREAD_UNBOUND');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) n FROM coordinator_rotations').get().n, 0);
    });
  });

  describe('E2: managed clear and authenticated rebind', () => {
    it('happy path: /clear is typed once, the one replacement is bound, the re-entry turn is delivered once, and observation answers for the new thread', async () => {
      await serve();
      channel();
      const p = await prepare();
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
      const id = (await prepare()).body.rotation.rotationId;
      const first = await rotation.advance(id, { ...deps(), now: () => '2026-09-29T00:00:01.000Z' });
      const again = await rotation.advance(id, { ...deps(), now: () => '2026-09-29T00:00:09.000Z' });
      assert.equal(first.failureCode, 'prior-thread-busy');
      assert.equal(again.updatedAt, first.updatedAt);
    });

    it('a refused /clear (a HOLD, a missing pane) is not counted, and is retried only after the retry window', async () => {
      await serve();
      channel();
      let refusals = 2;
      const refusing = { ...deps(), inject: (_n, command, opts) => {
        typed.push({ command, opts });
        if (refusals > 0) { refusals -= 1; return { ok: false, error: 'CONTROL_HELD: lane is held' }; }
        onClear();
        return { ok: true };
      } };
      const id = (await prepare()).body.rotation.rotationId;
      let r = await rotation.advance(id, refusing);
      assert.equal(r.failureCode, 'clear-refused');
      assert.equal(r.clearAttempts, 0, 'a refusal is not an attempt');
      r = await rotation.advance(id, refusing);
      assert.equal(typed.length, 1, 'no retry inside the window');
      clockMs += rotation.CLEAR_RETRY_MS;
      r = await rotation.advance(id, refusing);
      assert.equal(typed.length, 2);
      assert.equal(r.clearAttempts, 0);
      clockMs += rotation.CLEAR_RETRY_MS;
      r = await rotation.advance(id, refusing);
      assert.equal(r.clearAttempts, 1, 'the admitted one counts');
      r = await rotation.drive(id, { attempts: 5, deps: refusing });
      assert.equal(r.state, 'reconciling');
    });

    it('a slow unload is not typed over: no second /clear inside the settle window, one after it', async () => {
      await serve();
      channel();
      onClear = () => {};
      const id = (await prepare()).body.rotation.rotationId;
      await rotation.advance(id, deps());
      assert.equal(typed.length, 1);
      for (let i = 0; i < 5; i++) {
        clockMs += 1000;
        const r = await rotation.advance(id, deps());
        assert.equal(r.failureCode, 'clear-settling');
      }
      assert.equal(typed.length, 1, 'still one /clear while the first may be unloading');
      clockMs += rotation.CLEAR_SETTLE_MS;
      await rotation.advance(id, deps());
      assert.equal(typed.length, 2, 'a second, only after the settle window');
    });

    it('concurrent passes send one re-entry turn with one live nonce (W1)', async () => {
      await serve();
      channel();
      const id = (await prepare()).body.rotation.rotationId;
      await rotation.advance(id, deps());
      await Promise.all([rotation.advance(id, deps()), rotation.advance(id, deps()), rotation.advance(id, deps()), rotation.advance(id, deps())]);
      assert.equal(server.calls('turn/start').length, 1);
      const stored = store.coordinatorRotations.get(id);
      assert.equal(stored.state, 'reconciling');
      assert.equal(stored.resumeNonceHash, require('node:crypto').createHash('sha256').update(nonce()).digest('hex'),
        'the stored hash is the nonce that was actually sent');
    });

    it('a pass that throws on the first try leaves driver-error on the record (W2)', async () => {
      await serve();
      channel();
      const id = (await prepare()).body.rotation.rotationId;
      const throwing = { ...deps(), adapter: () => ({ rotationThreads: () => { throw new Error('socket exploded'); } }) };
      const r = await rotation.drive(id, { attempts: 1, deps: throwing });
      assert.equal(r.failureCode, 'driver-error');
      assert.match(r.failureDetail, /socket exploded/);
      assert.equal(store.coordinatorRotations.get(id).failureCode, 'driver-error');
    });

    it('waits for the coordinator\'s turn to finish before clearing', async () => {
      await serve({ [PRIOR]: { status: { type: 'active', activeFlags: [] } } });
      channel();
      const id = (await prepare()).body.rotation.rotationId;
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
      const r = await rotation.drive((await prepare()).body.rotation.rotationId, { attempts: 200, deps: deps() });
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
      const id = (await prepare()).body.rotation.rotationId;
      let r = await rotation.drive(id, { attempts: 3, deps: deps() });
      assert.equal(r.failureCode, 'replacement-settling', 'inside the settle window two threads are a wait, not a verdict');
      r = await rotation.drive(id, { attempts: 300, deps: deps() });
      assert.equal(r.state, 'rebinding');
      assert.equal(r.failureCode, 'replacement-ambiguous', 'still two after the window: the operator decides');
      assert.equal(threadOf(), PRIOR);
      assert.equal(server.calls('turn/start').length, 0);
    });

    it('LIVE: a short-lived auxiliary thread beside the replacement is waited out, then the one replacement binds', async () => {
      await serve();
      channel();
      onClear = () => {
        server.state.threads.delete(PRIOR);
        server.state.threads.set(NEXT, { status: { type: 'idle' } });
        server.state.threads.set('codex-aux-namer', { status: { type: 'idle' } });
      };
      const id = (await prepare()).body.rotation.rotationId;
      let r = await rotation.drive(id, { attempts: 3, deps: deps() });
      assert.equal(r.failureCode, 'replacement-settling');
      server.state.threads.delete('codex-aux-namer');
      r = await rotation.drive(id, { attempts: 5, deps: deps() });
      assert.equal(r.state, 'reconciling');
      assert.equal(r.replacementThreadId, NEXT);
    });

    it('a new thread that appears before any admitted /clear is not waited on: it goes to the operator', async () => {
      await serve();
      channel();
      // Every /clear is refused, and the operator opens a thread in the directory meanwhile.
      const refusing = { ...deps(), inject: (_n, command, opts) => {
        typed.push({ command, opts });
        server.state.threads.set('operator-opened', { status: { type: 'idle' } });
        return { ok: false, error: 'CONTROL_HELD' };
      } };
      const id = (await prepare()).body.rotation.rotationId;
      const r = await rotation.drive(id, { attempts: 5, deps: refusing });
      assert.equal(r.clearAttempts, 0);
      assert.equal(r.failureCode, 'prior-thread-still-loaded', 'no admitted clear, so no settle window: never an endless wait');
      assert.match(rotation.view(r).nextCommand, /abandon/);
    });

    it('LIVE: the old thread still loaded for a moment after /clear is waited out, not handed to the operator', async () => {
      await serve();
      channel();
      onClear = () => { server.state.threads.set(NEXT, { status: { type: 'idle' } }); };
      const id = (await prepare()).body.rotation.rotationId;
      let r = await rotation.drive(id, { attempts: 3, deps: deps() });
      assert.equal(r.failureCode, 'prior-thread-unloading');
      assert.equal(rotation.view(r).nextCommand, 'tc rotation advance', 'not the operator\'s abandon');
      server.state.threads.delete(PRIOR);
      r = await rotation.drive(id, { attempts: 5, deps: deps() });
      assert.equal(r.state, 'reconciling');
      assert.equal(r.replacementThreadId, NEXT);
    });

    it('a failure only the operator can clear stops the driver at once, not after its budget (B2)', async () => {
      await serve();
      channel();
      onClear = () => {
        server.state.threads.delete(PRIOR);
        server.state.threads.set(NEXT, { status: { type: 'idle' } });
        server.state.threads.set('another-new', { status: { type: 'idle' } });
      };
      let pauses = 0;
      const counting = { ...deps(), sleep: (ms) => { pauses += 1; clockMs += ms; return Promise.resolve(); } };
      const r = await rotation.drive((await prepare()).body.rotation.rotationId, { attempts: 500, deps: counting });
      assert.equal(r.failureCode, 'replacement-ambiguous');
      const windowPasses = rotation.REBIND_WINDOW_MS / 1000;
      assert.ok(pauses <= windowPasses + 3, `the driver paused ${pauses} times; it should stop once the settle window has passed`);
      assert.ok(pauses >= windowPasses - 3, 'and it waited out the window first');
    });

    it('no new thread binds nothing', async () => {
      await serve();
      channel();
      onClear = () => { server.state.threads.delete(PRIOR); };
      const r = await rotation.drive((await prepare()).body.rotation.rotationId, { attempts: 3, deps: deps() });
      assert.equal(r.failureCode, 'replacement-not-loaded');
      assert.equal(threadOf(), PRIOR);
    });

    it('the prior thread still loaded beside a new one is not provable, and binds nothing', async () => {
      await serve();
      channel();
      onClear = () => { server.state.threads.set(NEXT, { status: { type: 'idle' } }); };
      const r = await rotation.drive((await prepare()).body.rotation.rotationId, { attempts: 300, deps: deps() });
      assert.equal(r.failureCode, 'prior-thread-still-loaded', 'only once the settle window has passed');
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
      const r = await rotation.drive((await prepare()).body.rotation.rotationId, { attempts: 5, deps: deps() });
      assert.equal(r.state, 'reconciling');
      assert.equal(r.replacementThreadId, NEXT);
    });

    it('a channel that changed under the rotation binds nothing', async () => {
      await serve();
      channel();
      const id = (await prepare()).body.rotation.rotationId;
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
      const id = (await prepare()).body.rotation.rotationId;
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
      const id = (await prepare()).body.rotation.rotationId;
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
      const r = await rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.rotation.state, 'active');
      assert.equal(r.body.rotation.fenced, false);
      assert.equal(rotation.openRotation(project.id), null);
      assert.equal(rotation.gate({ projectId: project.id, access: access(), threadId: NEXT, action: 'medusa-send' }), null);
      assert.equal(store.coordinatorRotations.currentGeneration(project.id), 1);

      const replay = await rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replayed, true);
      const changed = await rotation.resume({ access: access(), threadId: NEXT, body: { ...body, receipt: receipt(rot, { nextAction: 'other' }) } }, deps());
      assert.equal(changed.status, 409);
      assert.equal(changed.body.code, 'ROTATION_ALREADY_ACTIVE');
    });

    it('missing evidence keeps the fence up and names each gap: undrained inbox, no ready workload receipt, wrong checkpoint', async () => {
      inbox = [{ id: 'left-behind' }];
      const rot = await toReconciling();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot, { checkpointDigest: '0'.repeat(64) }) };
      const r = await rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'ROTATION_EVIDENCE_MISSING');
      assert.deepEqual(r.body.missing.map((m) => m.fact).sort(), ['checkpoint', 'medusa', 'readiness']);
      assert.match(r.body.error, /left-behind/);
      assert.equal(store.coordinatorRotations.get(rot.rotationId).state, 'reconciling');
      assert.equal(rotation.gate({ projectId: project.id, access: access(), threadId: NEXT, action: 'medusa-send' }).status, 409);
    });

    it('a coordinator without the switchboard, and nothing recorded to drain, is not held for a listener (LIVE)', async () => {
      medusaOn = false;
      const rot = await toReconciling();
      workloadReceipt();
      listening = false;
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      assert.equal((await rotation.resume({ access: access(), threadId: NEXT, body }, deps())).status, 200);
    });

    it('a switchboard coordinator whose listener died is refused at resume even with nothing recorded (RM03 W1)', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      listening = false;
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      const r = await rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(r.body.code, 'ROTATION_EVIDENCE_MISSING');
      assert.match(r.body.error, /no Medusa listener/);
    });

    it('a switchboard coordinator cannot prepare with its listener down; one without the switchboard can', async () => {
      await serve();
      channel();
      listening = false;
      assert.equal((await prepare()).body.code, 'ROTATION_LISTENER_DOWN');
      assert.equal(rotation.openRotation(project.id), null);
      medusaOn = false;
      assert.equal((await prepare()).status, 201);
    });

    it('an unreadable project config counts as switchboard-enabled', () => {
      const realLoad = store.projectConfig.load;
      store.projectConfig.load = (_p, opts) => { if (opts && opts.onError) opts.onError(new Error('corrupt')); return null; };
      try {
        assert.equal(rotation._seams.medusaEnabled('/x'), true);
      } finally {
        store.projectConfig.load = realLoad;
      }
    });

    it('a session with no Medusa listener cannot show a drained inbox, so it cannot resume', async () => {
      inbox = [{ id: 'm-recorded' }];
      const rot = await toReconciling();
      workloadReceipt();
      listening = false;
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      const r = await rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(r.body.code, 'ROTATION_EVIDENCE_MISSING');
      assert.match(r.body.error, /no Medusa listener/);
    });

    it('a driver that runs out of passes says so on the record, and the next command is advance', async () => {
      await serve();
      channel();
      const id = (await prepare()).body.rotation.rotationId;
      // A clear that has not taken yet, with the prior thread idle: no failure recorded, just unfinished.
      onClear = () => {};
      const r = await rotation.drive(id, { attempts: 1, deps: deps() });
      assert.equal(r.state, 'rebinding');
      assert.equal(r.failureCode, 'driver-stopped');
      assert.equal(rotation.view(r).nextCommand, 'tc rotation advance');
    });

    it('prepare refuses an untracked file it cannot hash, rather than recording a constant', async () => {
      await serve();
      channel();
      checkout.fingerprint.dirty = ['big.bin'];
      checkout.fingerprint.untracked = { 'big.bin': 'unavailable:too-large' };
      const r = await prepare({ checkpoint: checkpoint({ branch: { head: HEAD, ref: 'main', ownedDirt: ['big.bin'] } }) });
      assert.equal(r.body.code, 'ROTATION_CHECKOUT_UNAVAILABLE');
    });

    it('messages that arrived after prepare stay queued and do not block the resume', async () => {
      const rot = await toReconciling();
      inbox = [{ id: 'arrived-during-absence' }];
      workloadReceipt();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      assert.equal((await rotation.resume({ access: access(), threadId: NEXT, body }, deps())).status, 200);
    });

    it('the control generation must match the lane\'s', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      const lane = { state_generation: 3 };
      const realControl = store.control.getOpenForProject;
      store.control.getOpenForProject = () => lane;
      try {
        const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
        let r = await rotation.resume({ access: access(), threadId: NEXT, body }, deps());
        assert.equal(r.status, 409);
        assert.deepEqual(r.body.missing.map((m) => m.fact), ['control']);
        body.receipt.reconciled.control.stateGeneration = 3;
        r = await rotation.resume({ access: access(), threadId: NEXT, body }, deps());
        assert.equal(r.status, 200);
      } finally {
        store.control.getOpenForProject = realControl;
      }
    });

    it('an incomplete receipt, a stale generation or attempt, another launch, or a rotation not yet reconciling are refused', async () => {
      await serve();
      channel();
      const early = (await prepare()).body.rotation;
      const earlyBody = { rotationId: early.rotationId, attemptKey: early.attemptKey, generation: early.generation, resumeNonce: 'none', receipt: receipt(early) };
      assert.equal((await rotation.resume({ access: access(), threadId: NEXT, body: earlyBody }, deps())).body.code, 'ROTATION_NOT_RECONCILING');
      await rotation.drive(early.rotationId, { attempts: 5, deps: deps() });
      const rot = rotation.view(store.coordinatorRotations.get(early.rotationId));
      const base = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };

      let r = await rotation.resume({ access: access(), threadId: NEXT, body: { ...base, receipt: { schema: 1 } } }, deps());
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'ROTATION_RECEIPT_INCOMPLETE');
      assert.ok(r.body.missing.includes('reconciled'));
      r = await rotation.resume({ access: access(), threadId: NEXT, body: { ...base, receipt: receipt(rot, { restored: [] }) } }, deps());
      assert.equal(r.status, 400);

      r = await rotation.resume({ access: access(), threadId: NEXT, body: { ...base, generation: rot.generation - 1 } }, deps());
      assert.equal(r.body.code, 'ROTATION_STALE_GENERATION');
      r = await rotation.resume({ access: access(), threadId: NEXT, body: { ...base, attemptKey: 'attempt-other' } }, deps());
      assert.equal(r.body.code, 'ROTATION_STALE_GENERATION');
      r = await rotation.resume({ access: { ...access(), launchId: 'other-launch' }, threadId: NEXT, body: base }, deps());
      assert.equal(r.status, 403);
      r = await rotation.resume({ access: { ...access(), projectId: project.id + 1 }, threadId: NEXT, body: base }, deps());
      assert.equal(r.status, 404);
      assert.equal(store.coordinatorRotations.get(rot.rotationId).state, 'reconciling');
    });

    it('the next rotation takes the next generation, and the old one\'s receipt cannot resume it', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      assert.equal((await rotation.resume({ access: access(), threadId: NEXT, body }, deps())).status, 200);
      // The replacement is now the prior thread of the next rotation.
      server.state.threads = new Map([[NEXT, { status: { type: 'idle' } }]]);
      const second = await prepare();
      assert.equal(second.status, 201);
      assert.equal(second.body.rotation.generation, 2);
      assert.equal(second.body.rotation.priorThreadId, NEXT);
      const stale = await rotation.resume({ access: access(), threadId: NEXT, body: { ...body, rotationId: second.body.rotation.rotationId } }, deps());
      assert.equal(stale.body.code, 'ROTATION_STALE_GENERATION');
    });

    it('only the operator can abandon a rotation, and abandoning lifts the fence without touching the channel', async () => {
      await serve();
      channel();
      const rot = (await prepare()).body.rotation;
      assert.equal(rotation.abandon({ caller: { kind: 'project' }, body: { rotationId: rot.rotationId, reason: 'x' } }).status, 403);
      assert.equal(rotation.abandon({ caller: { kind: 'operator' }, body: { rotationId: rot.rotationId } }).status, 400);
      const r = rotation.abandon({ caller: { kind: 'operator' }, body: { rotationId: rot.rotationId, reason: 'coordinator relaunched by hand' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.rotation.state, 'abandoned');
      assert.equal(rotation.openRotation(project.id), null);
      assert.equal(threadOf(), PRIOR);
      assert.equal((await prepare()).body.rotation.generation, 2, 'an abandoned generation is never reused');
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
      assert.equal(judge('medusa-listener', {}, { enable: true }), null, 'the replacement may turn its listener on');
      assert.equal(judge('medusa-listener', {}, { enable: false }).body.code, 'COORDINATOR_FENCED', 'but not off, until it resumes');
      assert.equal(judge('medusa-listener').body.code, 'COORDINATOR_FENCED', 'and a toggle that does not say which is not an enable');
      assert.equal(judge('medusa-send', {}, { inReplyTo: 'm-old' }), null);
      assert.equal(judge('medusa-ack', {}, { messageIds: ['m-old'] }), null);
      assert.equal(judge('exchange-close', {}, { exchangeId: 'mx_1' }), null, 'mx_1 is in the checkpoint\'s exchanges');
      for (const [action, extra] of [
        ['medusa-send', {}], ['medusa-send', { inReplyTo: 'm-new' }], ['medusa-ack', { messageIds: ['m-old', 'm-new'] }],
        ['exchange-close', { exchangeId: 'mx_other' }], ['wrap', {}], ['session-rule-write', {}], ['control-mutate', {}],
        ['medusa-loop', {}], ['session-command', {}]
      ]) {
        assert.equal(judge(action, {}, extra).body.code, 'COORDINATOR_FENCED', `${action} ${JSON.stringify(extra)} waits for the resume`);
      }
    });

    it('a stale thread, another launch, another session, an unbound caller or no thread header is refused as an epoch mismatch', async () => {
      await toReconciling();
      assert.match(judge('workload-set', { threadId: null }).body.error, /through `tc`/, 'a missing header is named');
      assert.doesNotMatch(judge('workload-set', { threadId: PRIOR }).body.error, /through `tc`/);
      for (const over of [{ threadId: PRIOR }, { threadId: null }, { threadId: '' }, { access: { launchId: 'other' } },
        { access: { sessionId: 999 } }, { access: { kind: 'unbound' } }]) {
        assert.equal(judge('workload-set', over).body.code, 'COORDINATOR_EPOCH_MISMATCH', JSON.stringify(over));
      }
    });

    it('after resume every gated action needs the current epoch binding; the old thread is refused for all of them', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      assert.equal((await rotation.resume({ access: access(), threadId: NEXT, body }, deps())).status, 200);
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
      assert.equal((await rotation.resume({ access: access(), threadId: PRIOR, body }, deps())).body.code, 'COORDINATOR_EPOCH_MISMATCH');
      assert.equal((await rotation.resume({ access: access(), threadId: null, body }, deps())).body.code, 'COORDINATOR_EPOCH_MISMATCH');
      assert.equal((await rotation.resume({ access: access(), threadId: NEXT, body: { ...body, resumeNonce: 'guess' } }, deps())).body.code, 'ROTATION_NONCE_INVALID');
      assert.equal((await rotation.resume({ access: access(), threadId: NEXT, body: { ...body, resumeNonce: undefined } }, deps())).body.code, 'ROTATION_NONCE_INVALID');
      assert.equal((await rotation.resume({ access: access(), threadId: NEXT, body }, deps())).status, 200);
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

    it('an active epoch binds while its session lives, and lapses when that session ends, so an ordinary relaunch needs no operator', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      assert.equal((await rotation.resume({ access: access(), threadId: NEXT, body }, deps())).status, 200);
      const relaunched = { kind: 'project', projectId: project.id, sessionId: session.id + 1000, launchId: 'ordinary-relaunch' };
      assert.equal(rotation.gate({ projectId: project.id, access: relaunched, threadId: 'fresh-thread', action: 'medusa-send' }).body.code,
        'COORDINATOR_EPOCH_MISMATCH', 'while the bound session lives, another launch is refused');
      store.getDb().prepare("UPDATE sessions SET status = 'wrapped' WHERE id = ?").run(session.id);
      try {
        assert.equal(rotation.gate({ projectId: project.id, access: relaunched, threadId: 'fresh-thread', action: 'medusa-send' }), null,
          'the bound session ended, so the epoch lapsed');
        assert.equal(store.coordinatorRotations.get(rot.rotationId).state, 'active', 'a completed rotation is not recorded as abandoned');
        // Fail closed: without persisted proof the bound session ended, the epoch holds.
        const realGet = store.sessions.get;
        store.sessions.get = () => null;
        try {
          assert.equal(rotation.gate({ projectId: project.id, access: relaunched, threadId: 'fresh-thread', action: 'medusa-send' }).body.code,
            'COORDINATOR_EPOCH_MISMATCH', 'a missing session row is uncertainty, not an ending');
        } finally {
          store.sessions.get = realGet;
        }
        store.sessions.get = () => { throw new Error('store locked'); };
        try {
          assert.equal(rotation.gate({ projectId: project.id, access: relaunched, threadId: 'fresh-thread', action: 'medusa-send' }).body.code,
            'COORDINATOR_EPOCH_MISMATCH', 'an unreadable session row keeps the fence');
        } finally {
          store.sessions.get = realGet;
        }
        assert.equal(rotation.abandon({ caller: { kind: 'operator' }, body: { rotationId: rot.rotationId, reason: 'explicit release' } }).status, 200,
          'the operator can still release it explicitly');
      } finally {
        store.getDb().prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(session.id);
      }
    });

    it('replaying the byte-identical checkpoint of an active or abandoned rotation is replay-only: no fence, no generation (N3)', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      assert.equal((await rotation.resume({ access: access(), threadId: NEXT, body }, deps())).status, 200);
      const rows = () => store.getDb().prepare('SELECT COUNT(*) n FROM coordinator_rotations').get().n;
      const before = rows();
      const again = await rotation.prepare({ access: access(), body: { attemptKey: rot.attemptKey, checkpoint: checkpoint() } }, deps());
      assert.equal(again.status, 200);
      assert.equal(again.body.replayOnly, true);
      assert.equal(again.body.rotation.state, 'active');
      assert.equal(again.body.rotation.fenced, false);
      assert.match(again.body.note, /nothing was reopened/);
      assert.equal(rows(), before, 'no new rotation');
      assert.equal(rotation.openRotation(project.id), null, 'no fence');
      assert.equal(store.coordinatorRotations.maxGeneration(project.id), rot.generation, 'no generation assigned');

      rotation.abandon({ caller: { kind: 'operator' }, body: { rotationId: rot.rotationId, reason: 'released' } });
      const afterAbandon = await rotation.prepare({ access: access(), body: { attemptKey: rot.attemptKey, checkpoint: checkpoint() } }, deps());
      assert.equal(afterAbandon.body.rotation.state, 'abandoned');
      assert.equal(afterAbandon.body.replayOnly, true);
      assert.equal(rotation.openRotation(project.id), null);
      assert.equal(rotation.gate({ projectId: project.id, access: { kind: 'unbound' }, threadId: null, action: 'medusa-send' }), null,
        'the abandoned rotation regains no authority');
    });

    it('an abandon that lands while a rebind is in flight leaves no authority and no wrong binding (N2)', async () => {
      await serve();
      channel();
      const id = (await prepare()).body.rotation.rotationId;
      await rotation.advance(id, deps());
      const real = codex.rebindThread;
      const racing = { ...deps(), adapter: () => ({
        ...codex,
        rebindThread: (ch, ids) => {
          const out = real(ch, ids);
          // The operator abandons between the channel move and the rotation's record.
          rotation.abandon({ caller: { kind: 'operator' }, body: { rotationId: id, reason: 'operator stepped in' } });
          return out;
        }
      }) };
      const r = await rotation.advance(id, racing);
      assert.equal(r.state, 'abandoned');
      assert.equal(r.replacementThreadId, null, 'the abandoned rotation recorded no replacement');
      assert.equal(server.calls('turn/start').length, 0, 'no re-entry turn and no nonce for an abandoned rotation');
      assert.equal(store.coordinatorRotations.get(id).resumeNonceHash, null);
      assert.equal(threadOf(), NEXT, 'the channel names the thread actually running, never a wrong one');
      assert.equal(rotation.gate({ projectId: project.id, access: { kind: 'unbound' }, threadId: null, action: 'wrap' }), null,
        'abandoned: no authority is held');
      const again = await rotation.advance(id, deps());
      assert.equal(again.state, 'abandoned', 'a later pass cannot revive it');
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

  describe('A10: GitHub facts are re-observed by the server, and drift must be disposed of', () => {
    const PR = { repo: 'Jason-Vaughan/TangleClaw', kind: 'pr', number: 1966, state: 'open', headSha: 'c'.repeat(40) };
    const KEY = 'github:Jason-Vaughan/TangleClaw#pr1966';
    const withFacts = () => checkpoint({ github: [PR] });
    const reconcileWithFacts = async () => {
      githubState = { [KEY]: { state: 'open', merged: false, headSha: 'c'.repeat(40) } };
      await serve();
      channel();
      const p = await prepare({ checkpoint: withFacts() });
      assert.equal(p.status, 201, JSON.stringify(p.body));
      const r = await rotation.drive(p.body.rotation.rotationId, { attempts: 5, deps: deps() });
      return rotation.view(r);
    };
    const bodyFor = (rot, over = {}) => ({ rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot, over) });

    it('prepare refuses a fact GitHub cannot answer, or one the checkpoint declares wrongly', async () => {
      await serve();
      channel();
      githubState = { [KEY]: 'HTTP 502' };
      assert.equal((await prepare({ checkpoint: withFacts() })).body.code, 'ROTATION_EVIDENCE_UNAVAILABLE');
      githubState = { [KEY]: { state: 'closed', merged: true, headSha: 'c'.repeat(40) } };
      const stale = await prepare({ checkpoint: withFacts() });
      assert.equal(stale.body.code, 'ROTATION_CHECKPOINT_STALE');
      assert.deepEqual(stale.body.stale, [KEY]);
    });

    it('a malformed github list is an incomplete checkpoint', async () => {
      await serve();
      channel();
      for (const github of [undefined, 'x', [{ repo: 'nope', kind: 'pr', number: 1, state: 'open' }], [PR, PR]]) {
        assert.equal((await prepare({ checkpoint: checkpoint({ github }) })).body.code, 'ROTATION_CHECKPOINT_INCOMPLETE', JSON.stringify(github));
      }
    });

    it('a fact that changed during absence keeps the fence up until the receipt disposes of it', async () => {
      const rot = await reconcileWithFacts();
      workloadReceipt();
      githubState = { [KEY]: { state: 'closed', merged: true, headSha: 'c'.repeat(40) } };
      let r = await rotation.resume({ access: access(), threadId: NEXT, body: bodyFor(rot) }, deps());
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'ROTATION_DRIFT_UNACKNOWLEDGED');
      assert.deepEqual(r.body.unacknowledged, [KEY]);
      const stored = store.coordinatorRotations.get(rot.rotationId);
      assert.deepEqual(stored.drift.trusted.map((t) => [t.class, t.key, t.afterObserved.merged]), [['github', KEY, true]]);
      assert.ok(stored.drift.trusted[0].before !== stored.drift.trusted[0].after);

      r = await rotation.resume({ access: access(), threadId: NEXT, body: bodyFor(rot, { drift: [{ key: KEY, disposition: 'bogus' }] }) }, deps());
      assert.equal(r.body.code, 'ROTATION_RECEIPT_INCOMPLETE');
      r = await rotation.resume({ access: access(), threadId: NEXT, body: bodyFor(rot, { drift: [{ key: KEY, disposition: 'accepted', note: '#1966 merged' }] }) }, deps());
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const done = store.coordinatorRotations.get(rot.rotationId);
      assert.deepEqual(done.drift.dispositions, [{ key: KEY, disposition: 'accepted', note: '#1966 merged' }]);
      assert.deepEqual(done.drift.trusted.map((t) => t.key), [KEY], 'the observation is kept beside its disposition');
    });

    it('GitHub unreadable at resume keeps the fence up', async () => {
      const rot = await reconcileWithFacts();
      workloadReceipt();
      githubState = { [KEY]: 'timed out' };
      const r = await rotation.resume({ access: access(), threadId: NEXT, body: bodyFor(rot) }, deps());
      assert.equal(r.body.code, 'ROTATION_EVIDENCE_UNAVAILABLE');
      assert.match(store.coordinatorRotations.get(rot.rotationId).drift.unavailable[0], /timed out/);
    });

    it('an unchanged fact needs no disposition', async () => {
      const rot = await reconcileWithFacts();
      workloadReceipt();
      assert.equal((await rotation.resume({ access: access(), threadId: NEXT, body: bodyFor(rot) }, deps())).status, 200);
    });
  });

  describe('A8: the readiness verdict', () => {
    /**
     * A receipt from this launch.
     * @param {string} state - Workload state.
     * @param {string} clearance - Clearance.
     * @param {number} [offsetMs=1000] - Received this far from now.
     */
    const receiptOf = (state, clearance, offsetMs = 1000) => {
      const nowMs = clockMs + offsetMs;
      store.workloadReceipts.append({
        project_id: project.id, session_id: session.id, launch_id: launchId, assignment_id: null, state, clearance,
        summary: 'reconciling', wait_kind: state === 'waiting-external' ? 'peer' : null, wait_detail: null, refs_json: '[]',
        branch: null, head_sha: null, source: 'tc-cli', received_at: new Date(nowMs).toISOString()
      }, { minIntervalMs: 0, nowMs });
    };
    const attempt = async (rot) => rotation.resume({ access: access(), threadId: NEXT,
      body: { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) } }, deps());

    it('complete or safe-to-clear is not a coordinator resuming authority; the verdict is persisted', async () => {
      const rot = await toReconciling();
      receiptOf('complete', 'safe-to-clear', 1000);
      const r = await attempt(rot);
      assert.equal(r.status, 409);
      assert.deepEqual(r.body.missing.map((m) => m.fact), ['readiness']);
      assert.equal(store.coordinatorRotations.get(rot.rotationId).readiness.verdict, 'not-ready');
      receiptOf('working', 'safe-to-clear', 2000);
      assert.match((await attempt(rot)).body.error, /do-not-clear/);
    });

    it('a receipt from before the re-entry turn does not count', async () => {
      receiptOf('working', 'do-not-clear', -60000);
      const rot = await toReconciling();
      const r = await attempt(rot);
      assert.equal(r.body.code, 'ROTATION_EVIDENCE_MISSING');
      assert.match(r.body.error, /predates the re-entry turn/);
    });

    it('waiting-external with do-not-clear is ready, and the ready verdict is stored with the active rotation', async () => {
      const rot = await toReconciling();
      receiptOf('waiting-external', 'do-not-clear');
      const r = await attempt(rot);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const stored = store.coordinatorRotations.get(rot.rotationId).readiness;
      assert.equal(stored.verdict, 'ready');
      assert.equal(stored.state, 'waiting-external');
    });
  });

  describe('E4/A13: full relaunch parity through an explicit claim', () => {
    const SUCCESSOR_THREAD = '01a0e89b-0000-7000-8000-00000000beef';
    let successor = null;
    let launches = 0;

    afterEach(() => {
      // Leave the fixture session active for the next test.
      if (successor) {
        try { store.sessions.wrap(successor.id, 'test'); } catch { /* already ended */ }
        successor = null;
      }
      store.getDb().prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(session.id);
    });

    /**
     * The launch seam: starts a successor session with a launch sequence, and
     * opens its startup-control channel on the fake app-server, as a real
     * Codex launch would.
     * @param {object} [opts] - `noChannel` to launch one without a channel.
     * @returns {function(string): object}
     */
    const launcher = (opts = {}) => () => {
      launches += 1;
      successor = store.sessions.start({
        projectId: project.id, engineId: 'codex', tmuxSession: `tc-rotation-successor-${launches}`, primePrompt: '',
        launchSequence: { launchId: `launch-successor-${launches}-${launchN}`, pageBudget: 10000, applicability: 'not-applicable',
          notApplicableReason: 'test', preflight: {}, sourceManifest: {}, steps: [] }
      });
      if (!opts.noChannel) {
        store.startupControlChannels.open({
          sessionId: successor.id, sequenceId: store.launchSequences.getBySession(successor.id).id, engineId: 'codex', adapter: 'codex',
          adapterState: { pid: 4242, birth: 'Wed Sep 23 18:00:04 2026', socketPath: '/x/requested.sock', resolvedSocketPath: server.sockPath,
            engineVersion: '0.156.1', threadId: opts.recorded === undefined ? SUCCESSOR_THREAD : opts.recorded, serverVersion: null }
        });
      }
      return { session: successor, error: null };
    };
    const relaunchDeps = (opts) => ({ ...deps(), launch: launcher(opts), driveOpts: { attempts: 5, deps: deps() } });
    const operator = { kind: 'operator' };
    const endOld = () => store.sessions.wrap(session.id, 'relaunching');

    it('a relaunch rotation types nothing into the ending session, and lets only that session end itself', async () => {
      await serve();
      channel();
      const rot = (await prepare({ mode: 'relaunch' })).body.rotation;
      assert.equal(rot.mode, 'relaunch');
      const r = await rotation.drive(rot.rotationId, { attempts: 3, deps: deps() });
      assert.equal(r.state, 'fenced');
      assert.equal(typed.length, 0);
      assert.equal(rotation.gate({ projectId: project.id, access: access(), threadId: PRIOR, action: 'wrap' }), null);
      assert.equal(rotation.gate({ projectId: project.id, access: access(), threadId: NEXT, action: 'wrap' }).body.code, 'COORDINATOR_FENCED');
      assert.equal(rotation.gate({ projectId: project.id, access: access(), threadId: PRIOR, action: 'medusa-send' }).body.code, 'COORDINATOR_FENCED');
      assert.match(rotation.view(r).nextCommand, /rotation\/relaunch/);
    });

    it('only the operator claims, and not while the old session is still active', async () => {
      await serve();
      channel();
      const rot = (await prepare({ mode: 'relaunch' })).body.rotation;
      assert.equal((await rotation.claimRelaunch({ caller: { kind: 'project' }, body: { rotationId: rot.rotationId } }, relaunchDeps())).status, 403);
      const before = launches;
      const early = await rotation.claimRelaunch({ caller: operator, body: { rotationId: rot.rotationId } }, relaunchDeps());
      assert.equal(early.body.code, 'ROTATION_PRIOR_SESSION_NOT_ENDED', 'the old session is still active: not proven ended');
      assert.equal(launches, before, 'no launch was attempted');
      // Missing evidence is not an ending either (Architect ruling): stays fenced, nothing launched.
      const realGet = store.sessions.get;
      store.sessions.get = (id) => (id === session.id ? null : realGet.call(store.sessions, id));
      try {
        const missing = await rotation.claimRelaunch({ caller: operator, body: { rotationId: rot.rotationId } }, relaunchDeps());
        assert.equal(missing.body.code, 'ROTATION_PRIOR_SESSION_NOT_ENDED');
      } finally {
        store.sessions.get = realGet;
      }
      assert.equal(launches, before);
      assert.equal(store.coordinatorRotations.get(rot.rotationId).state, 'fenced');
      const clearRot = await rotation.claimRelaunch({ caller: operator, body: { rotationId: 'rot_none' } }, relaunchDeps());
      assert.equal(clearRot.status, 404);
    });

    it('the claim binds exactly the successor it launched; that launch resumes, the old one cannot act', async () => {
      await serve();
      channel();
      const rot = (await prepare({ mode: 'relaunch' })).body.rotation;
      endOld();
      server.state.threads = new Map([[SUCCESSOR_THREAD, { status: { type: 'idle' } }]]);
      const claimed = await rotation.claimRelaunch({ caller: operator, body: { rotationId: rot.rotationId } }, relaunchDeps());
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      assert.equal(claimed.body.rotation.sessionId, successor.id);
      assert.deepEqual(claimed.body.rotation.drift.relaunch, [], 'the baseline is retaken at the claim; changes before it are observations, not drift');
      const r = await rotation.drive(rot.rotationId, { attempts: 5, deps: deps() });
      assert.equal(r.state, 'reconciling', JSON.stringify(r));
      assert.equal(r.replacementThreadId, SUCCESSOR_THREAD);
      assert.equal(store.startupControlChannels.getOpenBySession(successor.id).adapterState.threadId, SUCCESSOR_THREAD);
      const text = server.calls('turn/start').at(-1).params.input[0].text;
      assert.match(text, /relaunched successor/);
      assert.match(text, /tc start next/);

      const successorAccess = { kind: 'project', projectId: project.id, sessionId: successor.id, launchId: r.launchId };
      assert.equal(rotation.gate({ projectId: project.id, access: access(), threadId: PRIOR, action: 'workload-set' }).body.code, 'COORDINATOR_EPOCH_MISMATCH');
      assert.equal(rotation.gate({ projectId: project.id, access: successorAccess, threadId: SUCCESSOR_THREAD, action: 'workload-set' }), null);

      const nowMs = clockMs + 60000;
      store.workloadReceipts.append({
        project_id: project.id, session_id: successor.id, launch_id: r.launchId, assignment_id: null, state: 'working', clearance: 'do-not-clear',
        summary: 'reconciling', wait_kind: null, wait_detail: null, refs_json: '[]', branch: null, head_sha: null, source: 'tc-cli',
        received_at: new Date(nowMs).toISOString()
      }, { minIntervalMs: 0, nowMs });
      const nonceNow = /Resume nonce[^`]*`([^`]+)`/.exec(text)[1];
      const body = { rotationId: r.rotationId, attemptKey: r.attemptKey, generation: r.generation, resumeNonce: nonceNow, receipt: receipt(rotation.view(r)) };
      assert.equal((await rotation.resume({ access: access(), threadId: SUCCESSOR_THREAD, body }, deps())).body.code, 'ROTATION_NOT_YOURS');
      // Before its own launch sequence is attested READY, the successor holds no authority.
      const unready = await rotation.resume({ access: successorAccess, threadId: SUCCESSOR_THREAD, body }, deps());
      assert.equal(unready.body.code, 'ROTATION_EVIDENCE_MISSING');
      assert.deepEqual(unready.body.missing.map((m) => m.fact), ['launch-ready']);
      store.getDb().prepare('UPDATE launch_sequences SET ready_at = ? WHERE launch_id = ?').run(new Date(clockMs).toISOString(), r.launchId);
      const done = await rotation.resume({ access: successorAccess, threadId: SUCCESSOR_THREAD, body }, deps());
      assert.equal(done.status, 200, JSON.stringify(done.body));
    });

    it('a successor whose channel has not recorded its thread is never bound by inference from a visible thread (A16)', async () => {
      await serve();
      channel();
      const rot = (await prepare({ mode: 'relaunch' })).body.rotation;
      endOld();
      server.state.threads = new Map([[SUCCESSOR_THREAD, { status: { type: 'idle' } }]]);
      assert.equal((await rotation.claimRelaunch({ caller: operator, body: { rotationId: rot.rotationId } }, relaunchDeps({ recorded: null }))).status, 200);
      const r = await rotation.drive(rot.rotationId, { attempts: 3, deps: deps() });
      assert.equal(r.state, 'rebinding');
      assert.equal(r.failureCode, 'successor-thread-unrecorded');
      assert.equal(r.replacementThreadId, null);
      assert.equal(store.startupControlChannels.getOpenBySession(successor.id).adapterState.threadId, null, 'nothing was written');
      assert.equal(server.calls('turn/start').length, 0);
    });

    it('the read surfaces show the binding and never a launch id or nonce (A16)', async () => {
      const rot = await toReconciling();
      const v = rotation.view(store.coordinatorRotations.get(rot.rotationId), { checkpoint: true });
      assert.deepEqual(v.binding, { sessionId: session.id, threadId: NEXT, generation: rot.generation });
      const text = JSON.stringify(v);
      assert.ok(!text.includes(launchId), 'no launch id');
      assert.ok(!text.includes(nonce()), 'no nonce');
      assert.ok(!/resumeNonceHash/.test(text), 'no nonce hash either');
    });

    it('an ordinary launch nobody claimed stays fenced, and blocks the claim until it ends', async () => {
      await serve();
      channel();
      const rot = (await prepare({ mode: 'relaunch' })).body.rotation;
      endOld();
      launcher()();
      const unclaimed = { kind: 'project', projectId: project.id, sessionId: successor.id, launchId: store.launchSequences.getBySession(successor.id).launchId };
      assert.equal(rotation.gate({ projectId: project.id, access: unclaimed, threadId: SUCCESSOR_THREAD, action: 'medusa-send' }).body.code, 'COORDINATOR_FENCED');
      assert.equal((await rotation.claimRelaunch({ caller: operator, body: { rotationId: rot.rotationId } }, relaunchDeps())).body.code, 'ROTATION_SESSION_STILL_ACTIVE');
    });

    it('the claim retakes the checkout baseline: changes before it are observations, changes after it still block (B1)', async () => {
      await serve();
      channel();
      const rot = (await prepare({ mode: 'relaunch' })).body.rotation;
      endOld();
      // The old session's governed wrap committed: HEAD moved before the claim.
      checkout.fingerprint.head = 'b'.repeat(40);
      server.state.threads = new Map([[SUCCESSOR_THREAD, { status: { type: 'idle' } }]]);
      const claimed = await rotation.claimRelaunch({ caller: operator, body: { rotationId: rot.rotationId } }, relaunchDeps());
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      assert.deepEqual(claimed.body.rotation.drift.relaunch.map((i) => i.key), ['checkout.head']);
      const r = await rotation.drive(rot.rotationId, { attempts: 5, deps: deps() });
      assert.equal(r.state, 'reconciling');
      const successorAccess = { kind: 'project', projectId: project.id, sessionId: successor.id, launchId: r.launchId };
      const text = server.calls('turn/start').at(-1).params.input[0].text;
      const nowMs = clockMs + 60000;
      store.workloadReceipts.append({
        project_id: project.id, session_id: successor.id, launch_id: r.launchId, assignment_id: null, state: 'working', clearance: 'do-not-clear',
        summary: 'reconciling', wait_kind: null, wait_detail: null, refs_json: '[]', branch: null, head_sha: null, source: 'tc-cli',
        received_at: new Date(nowMs).toISOString()
      }, { minIntervalMs: 0, nowMs });
      const body = { rotationId: r.rotationId, attemptKey: r.attemptKey, generation: r.generation,
        resumeNonce: /Resume nonce[^`]*`([^`]+)`/.exec(text)[1], receipt: receipt(rotation.view(r)) };
      // A change AFTER the claim is still integrity drift.
      checkout.fingerprint.trackedDiffDigest = 'e'.repeat(64);
      const blocked = await rotation.resume({ access: successorAccess, threadId: SUCCESSOR_THREAD, body }, deps());
      assert.equal(blocked.body.code, 'ROTATION_OPERATOR_RECOVERY_REQUIRED');
      assert.deepEqual(blocked.body.drift.relaunch.map((i) => i.key), ['checkout.head'], 'the claim\'s observation survives the attempt');
      // Undo it, and the resume goes through against the claim-time baseline.
      checkout.fingerprint.trackedDiffDigest = 't'.repeat(64);
      store.getDb().prepare('UPDATE launch_sequences SET ready_at = ? WHERE launch_id = ?').run(new Date(clockMs).toISOString(), r.launchId);
      const done = await rotation.resume({ access: successorAccess, threadId: SUCCESSOR_THREAD, body }, deps());
      assert.equal(done.status, 200, JSON.stringify(done.body));
    });

    it('a checkout that cannot be fingerprinted at the claim leaves the rotation fenced and unclaimed', async () => {
      await serve();
      channel();
      const rot = (await prepare({ mode: 'relaunch' })).body.rotation;
      endOld();
      checkout = { ok: false, reason: 'deadline' };
      const r = await rotation.claimRelaunch({ caller: operator, body: { rotationId: rot.rotationId } }, relaunchDeps());
      assert.equal(r.body.code, 'ROTATION_CHECKOUT_UNAVAILABLE');
      const stored = store.coordinatorRotations.get(rot.rotationId);
      assert.equal(stored.state, 'fenced');
      assert.equal(stored.sessionId, session.id, 'nothing was bound to the successor');
    });

    it('a successor that cannot be bound stays unclaimed, with the reason on the rotation', async () => {
      await serve();
      channel();
      const rot = (await prepare({ mode: 'relaunch' })).body.rotation;
      endOld();
      const r = await rotation.claimRelaunch({ caller: operator, body: { rotationId: rot.rotationId } }, relaunchDeps({ noChannel: true }));
      assert.equal(r.body.code, 'ROTATION_RELAUNCH_UNBINDABLE');
      const stored = store.coordinatorRotations.get(rot.rotationId);
      assert.equal(stored.state, 'fenced');
      assert.equal(stored.failureCode, 'relaunch-unbindable');
      assert.match(rotation.view(stored).nextCommand, /abandon/);
    });

    it('a clear rotation is not claimable, and a bad mode is refused', async () => {
      await serve();
      channel();
      assert.equal((await prepare({ mode: 'sideways' })).body.code, 'ROTATION_BAD_MODE');
      const rot = (await prepare()).body.rotation;
      assert.equal((await rotation.claimRelaunch({ caller: operator, body: { rotationId: rot.rotationId } }, relaunchDeps())).body.code, 'ROTATION_NOT_RELAUNCH');
    });
  });

  describe('A13: exactly one next command for each state', () => {
    it('names the blocker and the command for whoever holds the rotation', () => {
      const base = { rotationId: 'rot_x', state: 'fenced', mode: 'clear', failureCode: null, failureDetail: null, drift: null, readiness: null };
      assert.equal(rotation.nextStep(base).nextCommand, 'tc rotation advance');
      assert.match(rotation.nextStep({ ...base, failureCode: 'replacement-ambiguous', failureDetail: '2' }).nextCommand, /abandon/);
      assert.match(rotation.nextStep({ ...base, mode: 'relaunch' }).nextCommand, /rotation\/relaunch/);
      const rec = { ...base, state: 'reconciling', readiness: { verdict: 'not-ready', reason: 'publish workload' },
        drift: { integrity: [], unavailable: [], trusted: [{ key: 'github:o/r#pr1' }] } };
      const step = rotation.nextStep(rec);
      assert.equal(step.nextCommand, 'tc rotation resume --receipt <file>');
      assert.match(step.blocker, /github:o\/r#pr1/);
      assert.match(step.blocker, /publish workload/);
      assert.match(rotation.nextStep({ ...rec, drift: { integrity: [{ key: 'checkout.head' }], unavailable: [], trusted: [] } }).nextCommand, /abandon/);
      assert.deepEqual(rotation.nextStep({ ...base, state: 'active' }), { blocker: null, nextCommand: null });
    });
  });

  describe('A6a: the coordinator role is an operator grant, not a claim', () => {
    it('a project with no active role cannot prepare, whatever its checkpoint says it is', async () => {
      await serve();
      channel();
      store.getDb().prepare('DELETE FROM coordinator_roles').run();
      const r = await prepare({ checkpoint: checkpoint({ role: 'architect' }) });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'ROTATION_NOT_COORDINATOR');
      assert.equal(rotation.openRotation(project.id), null);
    });

    it('prepare records the role and authority version it was prepared under', async () => {
      await serve();
      channel();
      const role = store.coordinatorRoles.getActiveForProject(project.id);
      const r = await prepare();
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
      const r = await rotation.resume({ access: access(), threadId: NEXT, body }, deps());
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
      let r = await prepare({ checkpoint: checkpoint({ branch: { head: 'b'.repeat(40), ref: 'main', ownedDirt: [] } }) });
      assert.equal(r.body.code, 'ROTATION_CHECKPOINT_STALE');
      r = await prepare({ checkpoint: checkpoint({ branch: { head: HEAD, ref: 'other', ownedDirt: [] } }) });
      assert.equal(r.body.code, 'ROTATION_CHECKPOINT_STALE');
      assert.equal((await prepare({ checkpoint: checkpoint({ branch: { head: HEAD, ref: 'refs/heads/main', ownedDirt: [] } }) })).status, 201);
    });

    it('prepare refuses dirt the checkpoint does not declare, and accepts it declared', async () => {
      await serve();
      channel();
      checkout.fingerprint.dirty = ['lib/a.js', 'notes/new.md'];
      let r = await prepare({ checkpoint: checkpoint({ branch: { head: HEAD, ref: 'main', ownedDirt: ['lib/a.js'] } }) });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'ROTATION_UNDECLARED_DIRT');
      assert.deepEqual(r.body.undeclared, ['notes/new.md']);
      r = await prepare({ checkpoint: checkpoint({ branch: { head: HEAD, ref: 'main', ownedDirt: ['lib/a.js', 'notes/new.md'] } }) });
      assert.equal(r.status, 201);
    });

    it('prepare refuses an unfingerprintable checkout or an important ignored file it cannot hash', async () => {
      await serve();
      channel();
      checkout = { ok: false, reason: 'status-unreadable' };
      assert.equal((await prepare()).body.code, 'ROTATION_CHECKOUT_UNAVAILABLE');
      checkout = { ok: true, fingerprint: { ...cleanCheckout(), importantIgnored: { '.env': 'unavailable:not-ignored' } } };
      const r = await prepare({ checkpoint: checkpoint({ branch: { head: HEAD, ref: 'main', ownedDirt: [], importantIgnored: ['.env'] } }) });
      assert.equal(r.body.code, 'ROTATION_IGNORED_FILE_UNAVAILABLE');
    });

    it('any content change to the checkout during absence is a hard blocker, persisted as typed drift', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      checkout.fingerprint.trackedDiffDigest = 'e'.repeat(64);
      checkout.fingerprint.untracked = { 'scratch.txt': 'sha256:abc' };
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      const r = await rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'ROTATION_OPERATOR_RECOVERY_REQUIRED');
      assert.deepEqual(r.body.drift.integrity.map((i) => i.key).sort(), ['checkout.trackedDiffDigest', 'checkout.untracked:scratch.txt']);
      assert.ok(r.body.drift.integrity.every((i) => i.class === 'checkout-integrity' && i.before && i.after));
      // Even a receipt that "acknowledges" it cannot resume.
      const acked = await rotation.resume({ access: access(), threadId: NEXT, body: { ...body, receipt: receipt(rot, { drift: [{ key: 'checkout.trackedDiffDigest', disposition: 'accepted' }] }) } }, deps());
      assert.equal(acked.body.code, 'ROTATION_OPERATOR_RECOVERY_REQUIRED');
      assert.equal(rotation.gate({ projectId: project.id, access: access(), threadId: NEXT, action: 'medusa-send' }).status, 409);
    });

    it('a checkout that cannot be observed at resume keeps the fence up as unavailable evidence', async () => {
      const rot = await toReconciling();
      workloadReceipt();
      checkout = { ok: false, reason: 'diff-unreadable' };
      const body = { rotationId: rot.rotationId, attemptKey: rot.attemptKey, generation: rot.generation, resumeNonce: nonce(), receipt: receipt(rot) };
      const r = await rotation.resume({ access: access(), threadId: NEXT, body }, deps());
      assert.equal(r.body.code, 'ROTATION_EVIDENCE_UNAVAILABLE');
      assert.deepEqual(store.coordinatorRotations.get(rot.rotationId).drift.unavailable, ['checkout: diff-unreadable']);
    });
  });

  describe('schema v51 migration', () => {
    it('upgrades a v50 store through v51: the tables and their one-open indexes appear', () => {
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
          assert.equal(store.CURRENT_SCHEMA_VERSION, 52, 'v51 is this migration: #2032 lands first, and the operator channel (#2031) takes v52 after it (ruling A17)');
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

    it('a fresh install is stamped at the current version with both tables and their indexes, and no migration ran', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rotation-fresh-'));
      const saved = store._getBasePath();
      store.close();
      try {
        store._setBasePath(dir);
        store.init();
        store.close();
        const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
        try {
          assert.deepEqual(db.prepare('SELECT version FROM schema_version').all().map((r) => r.version), [store.CURRENT_SCHEMA_VERSION]);
          for (const name of ['coordinator_rotations', 'coordinator_roles', 'idx_coordinator_rotations_open', 'idx_coordinator_roles_active']) {
            assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name), name);
          }
        } finally {
          db.close();
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
        + "role_id, authority_version, checkout_json, github_json, created_at, updated_at) "
        + "VALUES (?, ?, 77, 1, 'l', 'codex', 1, 1, ?, 1, 't', 1, ?, '{}', '[]', 'r', 1, '{}', '[]', 'x', 'x')"
      ).run(id, `key-${id}-000`, state, 'd'.repeat(64));
      row('a', 'active');
      row('b', 'abandoned');
      row('c', 'fenced');
      assert.throws(() => row('d', 'reconciling'), /UNIQUE/);
    });
  });
});
