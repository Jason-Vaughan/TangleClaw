'use strict';

// #2322: /api/merge-queue over an in-process server and a scratch store, with
// GitHub faked at the API module's seam. Only the Operator makes a queue or
// records the Operator gate; only a verified launch of the owner project adds
// to a queue or takes from it; what a submit claims about the pull request is
// read from GitHub, and a read that fails refuses.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const api = require('../lib/merge-queue-api');
const queueStore = require('../lib/merge-queue-store');
const state = require('../lib/merge-queue-state');
const mergeQueue = require('../lib/merge-queue');
const { withQueueSlot, isQueueSlotTaken } = mergeQueue;
const { GATE_STATES, standsDown } = require('../lib/auth-gate');
const { createServer } = require('../server');
const { operatorHeaders, bindProject, signInOperator, sendAs: sendRaw } = require('./_shared-docs-callers');

/** Every refusal a request in this file was answered with, for the last test to read. */
const REFUSED = [];

/**
 * Send a request as `sendAs` does, keeping each refusal's body.
 * @param {...*} args - As `sendAs` takes them
 * @returns {Promise<{status: number, headers: object, data: any}>}
 */
async function sendAs(...args) {
  const res = await sendRaw(...args);
  if (res.status >= 400) REFUSED.push({ request: `${args[1]} ${args[2]}`, status: res.status, body: res.data });
  return res;
}

const REPO = 'Jason-Vaughan/TangleClaw';
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const BASE_SHA = 'c'.repeat(40);
const CANDIDATE_SHA = 'd'.repeat(40);
const TREE = 'e'.repeat(40);
const LANDED_SHA = 'f'.repeat(40);

describe('/api/merge-queue (#2322)', () => {
  let tmpDir;
  let server;
  let op;
  let owner;
  let neighbour;
  let outsider;
  let bOwner;
  let bNeighbour;
  let bOutsider;
  let queueId;
  let pr = 100;
  let gh;
  const original = { ...api._internal };

  const mkProject = (name) => {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  };

  /** @returns {number} A pull request number no other test has used */
  const nextPr = () => { pr += 1; return pr; };

  /**
   * A submit body for a pull request, with every gate stated.
   * @param {number} prNumber - The pull request
   * @param {object} [over] - Fields to replace
   * @returns {object}
   */
  const submitBody = (prNumber, over = {}) => ({
    prNumber, headSha: HEAD, gates: { review: 'msg 1a2b', test: 'run 77', base: 'main c0ffee' }, operatorGate: 'none', ...over
  });

  /**
   * Submit as the owner and return the entry.
   * @param {object} [over] - Fields to replace in the body
   * @returns {Promise<object>}
   */
  const submitted = async (over = {}) => {
    const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr(), over), bOwner.headers);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data.entry;
  };

  let ownerAssignmentId = null;

  /**
   * Put the owner's lane on HOLD, under one control assignment made on first use.
   * @returns {Promise<object>} The hold's answer
   */
  const holdOwner = async () => {
    if (!ownerAssignmentId) {
      const made = await sendAs(server, 'POST', '/api/control/assignments', { projectId: owner.id, requestId: `mq-asg-${nextPr()}`, issueRef: '#2322' }, op);
      assert.equal(made.status, 201, JSON.stringify(made.data));
      ownerAssignmentId = made.data.assignment.assignmentId;
    }
    const hold = await sendAs(server, 'POST', `/api/control/assignments/${ownerAssignmentId}/hold`, { requestId: `mq-hold-${nextPr()}`, reasonCode: 'boundary' }, op);
    assert.equal(hold.status, 201, JSON.stringify(hold.data));
    return hold.data;
  };

  /**
   * Release a hold {@link holdOwner} placed.
   * @param {object} hold - Its answer
   * @returns {Promise<void>}
   */
  const releaseOwner = async (hold) => {
    const released = await sendAs(server, 'POST', `/api/control/assignments/${ownerAssignmentId}/release`, {
      requestId: `mq-rel-${nextPr()}`, reasonCode: 'resolved', holdIds: [hold.holdId], expectedGeneration: hold.assignment.stateGeneration
    }, op);
    assert.equal(released.status, 200, JSON.stringify(released.data));
  };

  /** The owner's launch as the store's actor. */
  const ownerActor = () => ({ kind: 'project', projectId: owner.id, launchId: bOwner.launchId });

  /**
   * Bring the queue to one entry holding a candidate, by the store's own
   * calls: everything ahead of it is withdrawn first.
   * @param {boolean} recorded - Whether the candidate has been recorded yet
   * @returns {Promise<object>} The entry
   */
  const withCandidate = async (recorded) => {
    for (const waiting of queueStore.listEntries(queueId, { includeFinished: false })) {
      assert.equal(queueStore.withdrawEntry(waiting.entryId, { reason: 'clearing the queue for a test', actor: ownerActor() }).ok, true);
    }
    const entry = await submitted();
    assert.equal(queueStore.beginAssembly(entry.entryId, { actor: ownerActor() }).ok, true);
    if (recorded) {
      const made = queueStore.recordCandidate(entry.entryId, {
        ref: `tc-queue/${entry.entryId}`, baseSha: BASE_SHA, sha: CANDIDATE_SHA, tree: TREE, actor: ownerActor()
      });
      assert.equal(made.ok, true);
    }
    gh.calls.length = 0;
    return entry;
  };

  /**
   * Empty the queue of everything unfinished, by the store's own calls, and
   * count every landing's branches as removed, so an advance starts from a
   * queue with nothing in front.
   * @returns {void}
   */
  const emptyQueue = () => {
    for (const waiting of queueStore.listEntries(queueId, { includeFinished: false })) {
      const out = waiting.state === 'landing'
        ? queueStore.failEntry(waiting.entryId, { code: 'TEST_CLEARED', actor: ownerActor() })
        : queueStore.withdrawEntry(waiting.entryId, { reason: 'clearing the queue for a test', actor: ownerActor() });
      assert.equal(out.ok, true, JSON.stringify(out));
    }
    for (const done of queueStore.listEntries(queueId)) mergeQueue._internal.branchesGone.add(done.entryId);
    mergeQueue._internal.refExistsSeen.clear();
  };

  /**
   * GitHub as an advance wants it, beside what `beforeEach` set up for a
   * submit: `main` at BASE_SHA and green, a candidate that is made and whose
   * check is green, ordinary changed files, and a merge that lands. A field of
   * `gh` replaces one answer: `tip`, `create`, `merge`, `commit`, `compare`, or
   * `branchCheck` as a function of the branch.
   * @returns {void}
   */
  const githubForAdvance = () => {
    const seam = (name, answer) => {
      api._internal[name] = async (...args) => {
        gh.calls.push([name, ...args]);
        if (gh.during && gh.during[name]) await gh.during[name]();
        return answer(...args);
      };
    };
    seam('readRefTip', () => gh.tip || { status: 'read', sha: BASE_SHA });
    seam('readBranchCheck', (repo, branch) => (gh.branchCheck ? gh.branchCheck(branch)
      : { status: 'concluded', conclusion: 'success', runId: branch === 'main' ? '7000' : '7001', suiteId: '1', completedAt: '2026-10-12T10:00:00Z', app: 'github-actions' }));
    seam('createCandidate', (repo, ref, baseSha, headSha) => gh.create
      || { status: 'created', ref, sha: CANDIDATE_SHA, tree: TREE, parents: [baseSha, headSha], refCreated: true, stageLeft: false });
    seam('readCompareFiles', () => gh.compare || { status: 'read', paths: ['lib/thing.js'] });
    seam('mergePull', () => gh.merge || { status: 'merged', sha: LANDED_SHA });
    seam('readCommit', (repo, sha) => gh.commit || { status: 'read', sha, tree: TREE, parents: [BASE_SHA, HEAD] });
  };

  /**
   * Advance the queue as a caller.
   * @param {object} [headers] - The caller's headers, the owner's when not given
   * @param {object} [body] - The request body
   * @returns {Promise<{status: number, data: any}>}
   */
  const advanceAs = (headers = bOwner.headers, body = {}) => sendAs(server, 'POST', '/api/merge-queue/advance', body, headers);

  /** The calls made to GitHub that change something there. */
  const githubWrites = () => gh.calls.map((c) => c[0]).filter((n) => ['createCandidate', 'discardCandidate', 'mergePull'].includes(n));

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-merge-queue-'));
    store._setBasePath(tmpDir);
    store.init();
    owner = mkProject('integrator');
    neighbour = mkProject('builder-a');
    outsider = mkProject('elsewhere');
    const group = store.projectGroups.create({ name: 'lanes' });
    store.projectGroups.addMember(group.id, owner.id);
    store.projectGroups.addMember(group.id, neighbour.id);
    bOwner = bindProject(owner);
    bNeighbour = bindProject(neighbour);
    bOutsider = bindProject(outsider);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    op = operatorHeaders(server);
    const made = await sendAs(server, 'POST', '/api/merge-queue', { repo: REPO, baseBranch: 'main', ownerProjectId: owner.id }, op);
    assert.equal(made.status, 201, JSON.stringify(made.data));
    queueId = made.data.queue.queueId;
  });

  beforeEach(() => {
    // GitHub as a submit wants it: an open, ready pull request on `main` at
    // HEAD, a green `test` check, and one ordinary changed file.
    gh = { calls: [], pull: {}, check: {}, files: {}, discard: { status: 'discarded', candidate: 'deleted', stage: 'not-found' } };
    api._internal.readPull = async (repo, number) => {
      gh.calls.push(['readPull', repo, number]);
      return { status: 'read', number, state: 'open', merged: false, draft: false, mergeable: true, baseRef: 'main', headSha: HEAD, changedFiles: 1, ...gh.pull };
    };
    api._internal.readCheck = async (repo, sha, name) => {
      gh.calls.push(['readCheck', repo, sha, name]);
      return { status: 'concluded', conclusion: 'success', runId: '9001', completedAt: '2026-10-12T10:00:00.000Z', ...gh.check };
    };
    api._internal.readPullFiles = async (repo, number) => {
      gh.calls.push(['readPullFiles', repo, number]);
      return { status: 'read', headSha: HEAD, paths: ['lib/thing.js'], ...gh.files };
    };
    api._internal.discardCandidate = async (repo, ref) => {
      gh.calls.push(['discardCandidate', repo, ref]);
      return gh.discard;
    };
  });

  after(async () => {
    Object.assign(api._internal, original);
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('making a queue', () => {
    it('the Operator made it, the owner is named, and the proof tier is on record', () => {
      const queue = queueStore.getQueue(queueId);
      assert.equal(queue.ownerProjectId, owner.id);
      assert.equal(queue.createdBy.operatorProof, 'ambient-open');
    });

    it('no project launch makes a queue, the owner-to-be included', async () => {
      for (const b of [bOwner, bNeighbour, bOutsider]) {
        const res = await sendAs(server, 'POST', '/api/merge-queue', { repo: 'Jason-Vaughan/Other', baseBranch: 'main', ownerProjectId: owner.id }, b.headers);
        assert.equal(res.status, 403);
        assert.equal(res.data.code, 'OPERATOR_ONLY');
      }
      assert.equal(queueStore.listQueues().length, 1);
    });

    it('refuses an owner that is not a project, a second queue for the same base, and a malformed repository', async () => {
      const ghost = await sendAs(server, 'POST', '/api/merge-queue', { repo: 'Jason-Vaughan/Other', baseBranch: 'main', ownerProjectId: 999999 }, op);
      assert.equal(ghost.status, 404);
      assert.equal(ghost.data.code, 'PROJECT_NOT_FOUND');
      const twice = await sendAs(server, 'POST', '/api/merge-queue', { repo: REPO, baseBranch: 'main', ownerProjectId: owner.id }, op);
      assert.equal(twice.status, 409);
      assert.equal(twice.data.code, 'QUEUE_EXISTS');
      for (const body of [{ repo: 'not a repo', baseBranch: 'main', ownerProjectId: owner.id }, { repo: REPO, baseBranch: 'main' }, {}]) {
        const bad = await sendAs(server, 'POST', '/api/merge-queue', body, op);
        assert.equal(bad.status, 400, JSON.stringify(body));
        assert.equal(bad.data.code, 'INVALID_INPUT');
      }
    });
  });

  describe('who is asking', () => {
    const ROUTES = [
      ['POST', '/api/merge-queue', { repo: REPO, baseBranch: 'main', ownerProjectId: 1 }],
      ['GET', '/api/merge-queue', undefined],
      ['GET', '/api/merge-queue/entries/mqe_0000000000000000', undefined],
      ['POST', '/api/merge-queue/entries', { prNumber: 1 }],
      ['POST', '/api/merge-queue/entries/mqe_0000000000000000/withdraw', { reason: 'x' }],
      ['POST', '/api/merge-queue/entries/mqe_0000000000000000/operator-gate', { reference: 'x' }]
    ];

    it('an unbound caller reaches no route', async () => {
      for (const [method, urlPath, body] of ROUTES) {
        const res = await sendAs(server, method, urlPath, body, {});
        assert.equal(res.status, 403, `${method} ${urlPath}`);
        assert.ok(res.data.code, `${method} ${urlPath} names a code`);
      }
    });

    it('a launch that claims another project, and a service token, are not principals', async () => {
      const spoofed = { 'x-tangleclaw-project-id': String(owner.id), 'x-tangleclaw-launch-id': bOutsider.launchId };
      const token = { authorization: 'Bearer anything', 'x-tangleclaw-project-id': String(owner.id) };
      for (const headers of [spoofed, token]) {
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), headers);
        assert.equal(res.status, 403);
        const read = await sendAs(server, 'GET', '/api/merge-queue', undefined, headers);
        assert.equal(read.status, 403);
      }
      assert.equal(gh.calls.length, 0, 'GitHub is not asked on behalf of an unverified caller');
    });

    it('a launch of the owner project that has ended, or been replaced, can neither submit nor withdraw', async () => {
      const rotating = mkProject('rotating-owner');
      const first = bindProject(rotating);
      const made = await sendAs(server, 'POST', '/api/merge-queue', { repo: 'Jason-Vaughan/Rotating', baseBranch: 'main', ownerProjectId: rotating.id }, op);
      assert.equal(made.status, 201, JSON.stringify(made.data));
      const queued = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), first.headers);
      assert.equal(queued.status, 201, JSON.stringify(queued.data));
      const withdrawUrl = `/api/merge-queue/entries/${queued.data.entry.entryId}/withdraw`;
      const refusedEverywhere = async (why) => {
        gh.calls.length = 0;
        const submit = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), first.headers);
        assert.equal(submit.status, 403, why);
        assert.equal(submit.data.code, 'LAUNCH_BINDING_INVALID', why);
        const withdraw = await sendAs(server, 'POST', withdrawUrl, { reason: 'x' }, first.headers);
        assert.equal(withdraw.status, 403, why);
        assert.equal(withdraw.data.code, 'LAUNCH_BINDING_INVALID', why);
        assert.equal(gh.calls.length, 0, why);
        assert.equal(queueStore.getEntry(queued.data.entry.entryId).state, 'queued', why);
      };
      // Ended: the session is over and nothing has taken its place.
      const ended = require('../lib/sessions').completeWrap(rotating.name, 'ended for a test', first.sessionId);
      assert.equal(ended.error, null);
      await refusedEverywhere('ended');
      // Replaced: the project has a new launch, and the old one is still not it.
      const second = bindProject(rotating);
      await refusedEverywhere('replaced');
      const byNew = await sendAs(server, 'POST', withdrawUrl, { reason: 'the new launch owns the queue' }, second.headers);
      assert.equal(byNew.status, 200, JSON.stringify(byNew.data));
      assert.equal(queueStore.retireQueue(made.data.queue.queueId, { actor: { kind: 'operator', operatorProof: 'ambient-open' } }).ok, true);
    });

    it('an operator-shaped request with no proof is refused with 503, as the control routes refuse it', () => {
      const req = (gate) => ({ headers: { 'x-tangleclaw-client': 'dashboard' }, tcSession: null, tcGateState: gate, tcGateActive: !standsDown(gate) });
      for (const gate of [GATE_STATES.FALLBACK, GATE_STATES.UNREADABLE]) {
        for (const call of [
          () => api.createQueue(req(gate), { repo: 'Jason-Vaughan/Other', baseBranch: 'main', ownerProjectId: owner.id }),
          () => api.listQueues(req(gate)),
          () => api.recordOperatorGate(req(gate), { id: 'mqe_0000000000000000' }, { reference: 'x' })
        ]) {
          assert.throws(call, (err) => err instanceof api.QueueError && err.status === 503 && err.code === 'OPERATOR_UNVERIFIABLE', gate);
        }
      }
      assert.equal(queueStore.listQueues().length, 1);
    });
  });

  describe('submitting', () => {
    it('the owner queues an exact head; the answer says whose word each gate is and what the queue read itself', async () => {
      const entry = await submitted({ operatorGate: 'required' });
      assert.equal(entry.state, 'queued');
      assert.equal(entry.headSha, HEAD);
      for (const name of ['review', 'test', 'base']) {
        assert.equal(entry.gates[name].status, 'recorded');
        assert.equal(entry.gates[name].source, 'owner-statement');
      }
      assert.equal(entry.gates.operator.status, 'required');
      assert.equal(entry.gates.operator.source, 'operator-record');
      assert.deepEqual({ ...entry.headCheck, readAt: undefined },
        { runId: '9001', conclusion: 'success', readAt: undefined, name: 'test', source: 'queue-read' });
      assert.deepEqual(entry.openGates.map((p) => p.code), ['OPERATOR_GATE_OPEN']);
      assert.deepEqual(gh.calls.map((c) => c[0]), ['readPull', 'readCheck', 'readPullFiles']);
      assert.deepEqual(gh.calls[1], ['readCheck', REPO, HEAD, 'test']);
    });

    it('an entry id is one name that fits under both branch prefixes', async () => {
      const entry = await submitted();
      assert.match(entry.entryId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
    });

    it('an id that cannot name a candidate branch is never left queued', async () => {
      const mint = queueStore._internal.id;
      queueStore._internal.id = (prefix) => (prefix === 'mqe' ? 'mqe/../main' : mint(prefix));
      try {
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
        assert.equal(res.status, 500);
        assert.equal(res.data.code, 'ENTRY_ID_UNUSABLE');
        assert.equal(res.data.withdrawn, true);
        assert.equal(queueStore.getEntry('mqe/../main').state, 'withdrawn');
      } finally {
        queueStore._internal.id = mint;
      }
    });

    it('says so when such an entry could not be taken back out, and never claims it was', async () => {
      const mint = queueStore._internal.id;
      const withdrawEntry = queueStore.withdrawEntry;
      queueStore._internal.id = (prefix) => (prefix === 'mqe' ? 'mqe/../stuck' : mint(prefix));
      queueStore.withdrawEntry = () => ({ ok: false, code: 'TRANSITION_NOT_ALLOWED', message: 'refused for a test' });
      try {
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
        assert.equal(res.status, 500);
        assert.equal(res.data.code, 'ENTRY_ID_UNUSABLE');
        assert.equal(res.data.withdrawn, false);
        assert.match(res.data.error, /could not withdraw the entry \(TRANSITION_NOT_ALLOWED\).*still queued/);
      } finally {
        queueStore._internal.id = mint;
        queueStore.withdrawEntry = withdrawEntry;
      }
      assert.equal(queueStore.withdrawEntry('mqe/../stuck', { reason: 'test cleanup', actor: ownerActor() }).ok, true);
    });

    it('never returns a launch id', async () => {
      const entry = await submitted();
      const list = await sendAs(server, 'GET', '/api/merge-queue', undefined, bNeighbour.headers);
      const one = await sendAs(server, 'GET', `/api/merge-queue/entries/${entry.entryId}`, undefined, op);
      for (const text of [JSON.stringify(entry), JSON.stringify(list.data), JSON.stringify(one.data)]) {
        assert.ok(!text.includes(bOwner.launchId));
      }
      assert.deepEqual(one.data.events.map((e) => [e.event, e.actor.kind, e.actor.projectId]), [['submitted', 'project', owner.id]]);
    });

    it('nobody but the owner\'s verified launch adds to the queue', async () => {
      const before = queueStore.listEntries(queueId).length;
      const asNeighbour = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr(), { queueId }), bNeighbour.headers);
      assert.equal(asNeighbour.status, 403);
      assert.equal(asNeighbour.data.code, 'NOT_OWNER');
      const asOutsider = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr(), { queueId }), bOutsider.headers);
      assert.equal(asOutsider.status, 404, 'a queue the caller may not read does not exist for it');
      assert.equal(asOutsider.data.code, 'QUEUE_NOT_FOUND');
      const unnamed = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bNeighbour.headers);
      assert.equal(unnamed.status, 404);
      assert.equal(unnamed.data.code, 'QUEUE_NOT_FOUND');
      const asOperator = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr(), { queueId }), op);
      assert.equal(asOperator.status, 403);
      assert.equal(asOperator.data.code, 'NOT_OWNER');
      assert.equal(queueStore.listEntries(queueId).length, before);
      assert.equal(gh.calls.length, 0);
    });

    it('refuses a malformed submit before asking GitHub, and names the missing gate', async () => {
      const cases = [
        [{ prNumber: 0 }, 'INVALID_INPUT'],
        [{ prNumber: '12' }, 'INVALID_INPUT'],
        [{ headSha: HEAD.slice(0, 12) }, 'INVALID_INPUT'],
        [{ headSha: HEAD.toUpperCase() }, 'INVALID_INPUT'],
        [{ operatorGate: undefined }, 'INVALID_INPUT'],
        [{ operatorGate: 'maybe' }, 'INVALID_INPUT'],
        [{ operatorGate: 'toString' }, 'INVALID_INPUT'],
        [{ gates: undefined }, 'GATE_REFERENCE_MISSING'],
        [{ gates: null }, 'GATE_REFERENCE_MISSING'],
        [{ gates: { review: 'r', test: '  ', base: 'b' } }, 'GATE_REFERENCE_MISSING'],
        [{ gates: { review: 'r', test: 't' } }, 'GATE_REFERENCE_MISSING']
      ];
      for (const [over, code] of cases) {
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr(), over), bOwner.headers);
        assert.equal(res.status, 400, JSON.stringify(over));
        assert.equal(res.data.code, code, JSON.stringify(over));
      }
      const noBase = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr(), { gates: { review: 'r', test: 't' } }), bOwner.headers);
      assert.equal(noBase.data.gate, 'base');
      assert.equal(gh.calls.length, 0);
    });

    it('refuses each state of the pull request that is not an open, ready pull request at the submitted head on the queue\'s base', async () => {
      const cases = [
        [{ state: 'closed', merged: false }, 'PR_NOT_OPEN'],
        [{ state: 'closed', merged: true }, 'PR_NOT_OPEN'],
        [{ baseRef: 'v5-baseline' }, 'PR_WRONG_BASE'],
        [{ headSha: OTHER_HEAD }, 'PR_HEAD_MOVED'],
        [{ draft: true }, 'PR_DRAFT']
      ];
      const before = queueStore.listEntries(queueId).length;
      for (const [pull, code] of cases) {
        gh.pull = pull;
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
        assert.equal(res.status, 409, code);
        assert.equal(res.data.code, code);
      }
      assert.equal(queueStore.listEntries(queueId).length, before);
    });

    it('refuses a head whose test check is anything but a concluded success', async () => {
      const cases = [
        { status: 'not-found', conclusion: undefined, runId: undefined },
        { status: 'running', conclusion: undefined },
        { status: 'concluded', conclusion: 'failure' },
        { status: 'concluded', conclusion: 'cancelled' },
        { status: 'concluded', conclusion: 'skipped' },
        { status: 'concluded', conclusion: 'neutral' }
      ];
      for (const check of cases) {
        gh.check = check;
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
        assert.equal(res.status, 409, JSON.stringify(check));
        assert.equal(res.data.code, 'HEAD_CHECK_NOT_GREEN');
        assert.equal(res.data.check.status, check.status);
      }
    });

    it('fails closed when any of the three reads is unavailable', async () => {
      const before = queueStore.listEntries(queueId).length;
      for (const part of ['pull', 'check', 'files']) {
        gh.pull = {}; gh.check = {}; gh.files = {};
        gh[part] = { status: 'unavailable', reason: 'gh api timed out' };
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
        assert.equal(res.status, 503, part);
        assert.equal(res.data.code, 'GITHUB_UNAVAILABLE', part);
        assert.equal(res.data.reason, 'gh api timed out');
      }
      assert.equal(queueStore.listEntries(queueId).length, before);
    });

    it('refuses a second submit of a pull request while the first is unfinished, and takes it again once that is withdrawn', async () => {
      const prNumber = nextPr();
      const first = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(prNumber), bOwner.headers);
      assert.equal(first.status, 201);
      gh.calls.length = 0;
      const second = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(prNumber), bOwner.headers);
      assert.equal(second.status, 409);
      assert.equal(second.data.code, 'DUPLICATE_PR');
      assert.equal(second.data.entryId, first.data.entry.entryId);
      assert.equal(gh.calls.length, 0);
      const gone = await sendAs(server, 'POST', `/api/merge-queue/entries/${first.data.entry.entryId}/withdraw`, { reason: 'new head' }, bOwner.headers);
      assert.equal(gone.status, 200);
      const again = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(prNumber), bOwner.headers);
      assert.equal(again.status, 201);
    });

    it('a held owner cannot submit', async () => {
      const hold = await holdOwner();
      try {
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
        assert.equal(res.status, 423);
        assert.equal(res.data.code, 'CONTROL_HELD');
        assert.equal(gh.calls.length, 0);
      } finally {
        await releaseOwner(hold);
      }
      const after = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
      assert.equal(after.status, 201);
    });
  });

  describe('a hold stored while GitHub is being read', () => {
    it('still stops the entry: the gate is asked again immediately before the write', async () => {
      const before = queueStore.listEntries(queueId).length;
      let hold;
      const readFiles = api._internal.readPullFiles;
      api._internal.readPullFiles = async (repo, number) => {
        hold = await holdOwner();
        return readFiles(repo, number);
      };
      try {
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
        assert.equal(res.status, 423, JSON.stringify(res.data));
        assert.equal(res.data.code, 'CONTROL_HELD');
        assert.deepEqual(gh.calls.map((c) => c[0]), ['readPull', 'readCheck', 'readPullFiles'], 'every read was made: the hold arrived during the last');
        assert.equal(queueStore.listEntries(queueId).length, before);
      } finally {
        await releaseOwner(hold);
      }
    });
  });

  describe('a landing is never a release', () => {
    it('refuses a pull request that changes a release-trigger path, and queues nothing', async () => {
      const before = queueStore.listEntries(queueId).length;
      const cases = [
        [['lib/thing.js', 'version.json'], ['version.json']],
        [['.github/workflows/release.yml'], ['.github/workflows/release.yml']],
        // A rename gives both its old path and its new one, so one moved from
        // or to a trigger path is in the list either way.
        [['version.json', 'version.old.json'], ['version.json']],
        [['docs/x.md', '.github/workflows/release.yml', 'version.json'], ['.github/workflows/release.yml', 'version.json']]
      ];
      for (const [paths, named] of cases) {
        gh.files = { paths };
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
        assert.equal(res.status, 409, paths.join(','));
        assert.equal(res.data.code, 'RELEASE_TRIGGER_CHANGED');
        assert.deepEqual(res.data.paths, named);
      }
      assert.equal(queueStore.listEntries(queueId).length, before);
    });

    it('refuses when the file list is unreadable or was cut short, never reading that as no trigger path', async () => {
      for (const reason of ['gh api failed', 'the pull request changes 3000 files, and GitHub lists at most 3000']) {
        gh.files = { status: 'unavailable', reason };
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
        assert.equal(res.status, 503);
        assert.equal(res.data.code, 'GITHUB_UNAVAILABLE');
      }
    });

    it('refuses when the files read are those of another head', async () => {
      gh.files = { headSha: OTHER_HEAD };
      const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
      assert.equal(res.status, 409);
      assert.equal(res.data.code, 'PR_HEAD_MOVED');
    });

    it('queues an ordinary pull request, one that only names a file like a trigger path included', async () => {
      gh.files = { paths: ['docs/version.json', 'lib/version.json.js', '.github/workflows/test.yml'] };
      const entry = await submitted();
      assert.equal(entry.state, 'queued');
    });
  });

  describe('reading', () => {
    it('the Operator, the owner and a project in the owner\'s group read the queue in order; anyone else sees none', async () => {
      const entry = await submitted();
      for (const headers of [op, bOwner.headers, bNeighbour.headers]) {
        const res = await sendAs(server, 'GET', '/api/merge-queue', undefined, headers);
        assert.equal(res.status, 200);
        assert.equal(res.data.queues.length, 1);
        const queue = res.data.queues[0];
        assert.equal(queue.ownerProjectName, 'integrator');
        assert.equal(queue.youAreOwner, headers === bOwner.headers);
        const positions = queue.entries.map((e) => e.position);
        assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
        assert.ok(queue.entries.every((e) => !state.isFinished(e.state)));
        assert.equal(queue.nextEntryId, queue.entries[0].entryId);
        const one = await sendAs(server, 'GET', `/api/merge-queue/entries/${entry.entryId}`, undefined, headers);
        assert.equal(one.status, 200);
        assert.equal(one.data.entry.entryId, entry.entryId);
        assert.equal(one.data.queue.queueId, queueId);
      }
      const none = await sendAs(server, 'GET', '/api/merge-queue', undefined, bOutsider.headers);
      assert.deepEqual(none.data, { queues: [] });
      const hidden = await sendAs(server, 'GET', `/api/merge-queue/entries/${entry.entryId}`, undefined, bOutsider.headers);
      assert.equal(hidden.status, 404);
      assert.equal(hidden.data.code, 'ENTRY_NOT_FOUND');
    });

    it('answers an unknown entry and a malformed id by name', async () => {
      const unknown = await sendAs(server, 'GET', '/api/merge-queue/entries/mqe_ffffffffffffffff', undefined, op);
      assert.equal(unknown.status, 404);
      assert.equal(unknown.data.code, 'ENTRY_NOT_FOUND');
      for (const id of ['.hidden', '-x', 'a'.repeat(101), 'a%20b', 'a%2Fb']) {
        const bad = await sendAs(server, 'GET', `/api/merge-queue/entries/${id}`, undefined, op);
        assert.equal(bad.status, 400, id);
        assert.equal(bad.data.code, 'INVALID_INPUT', id);
      }
    });
  });

  describe('the Operator gate', () => {
    it('stays open until the Operator records it, and the owner cannot', async () => {
      const entry = await submitted({ operatorGate: 'required' });
      for (const b of [bOwner, bNeighbour, bOutsider]) {
        const res = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/operator-gate`, { reference: 'the Operator said yes' }, b.headers);
        assert.equal(res.status, 403);
        assert.equal(res.data.code, 'OPERATOR_ONLY');
      }
      assert.equal(queueStore.getEntry(entry.entryId).gates.operator.status, 'required');
      const blank = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/operator-gate`, {}, op);
      assert.equal(blank.status, 400);
      assert.equal(blank.data.code, 'GATE_REFERENCE_MISSING');
      const res = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/operator-gate`, { reference: 'pane, 03:40' }, op);
      assert.equal(res.status, 200);
      assert.equal(res.data.entry.gates.operator.status, 'recorded');
      assert.equal(res.data.entry.gates.operator.operatorProof, 'ambient-open');
      assert.deepEqual(res.data.entry.openGates, []);
      const twice = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/operator-gate`, { reference: 'again' }, op);
      assert.equal(twice.status, 409);
      assert.equal(twice.data.code, 'OPERATOR_GATE_ALREADY_RECORDED');
    });

    it('is refused for an entry submitted as not needing it, and for an entry that does not exist', async () => {
      const entry = await submitted();
      const res = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/operator-gate`, { reference: 'x' }, op);
      assert.equal(res.status, 409);
      assert.equal(res.data.code, 'OPERATOR_GATE_NOT_REQUIRED');
      const none = await sendAs(server, 'POST', '/api/merge-queue/entries/mqe_ffffffffffffffff/operator-gate', { reference: 'x' }, op);
      assert.equal(none.status, 404);
    });
  });

  describe('withdrawing', () => {
    it('only the owner withdraws, with a reason', async () => {
      const entry = await submitted();
      const url = `/api/merge-queue/entries/${entry.entryId}/withdraw`;
      const asNeighbour = await sendAs(server, 'POST', url, { reason: 'x' }, bNeighbour.headers);
      assert.equal(asNeighbour.status, 403);
      assert.equal(asNeighbour.data.code, 'NOT_OWNER');
      const asOperator = await sendAs(server, 'POST', url, { reason: 'x' }, op);
      assert.equal(asOperator.status, 403);
      assert.equal(asOperator.data.code, 'NOT_OWNER');
      const asOutsider = await sendAs(server, 'POST', url, { reason: 'x' }, bOutsider.headers);
      assert.equal(asOutsider.status, 404);
      for (const body of [{}, { reason: '   ' }, { reason: 7 }]) {
        const bare = await sendAs(server, 'POST', url, body, bOwner.headers);
        assert.equal(bare.status, 400);
        assert.equal(bare.data.code, 'INVALID_INPUT');
      }
      assert.equal(queueStore.getEntry(entry.entryId).state, 'queued');
      const res = await sendAs(server, 'POST', url, { reason: 'superseded' }, bOwner.headers);
      assert.equal(res.status, 200);
      assert.equal(res.data.entry.state, 'withdrawn');
      assert.equal(res.data.entry.withdrawnReason, 'superseded');
      assert.equal(res.data.branches, null, 'a queued entry has no candidate, so no branch is touched');
      assert.equal(gh.calls.length, 3, 'only the submit\'s three reads reached GitHub');
      const again = await sendAs(server, 'POST', url, { reason: 'superseded' }, bOwner.headers);
      assert.equal(again.status, 409);
      assert.equal(again.data.code, 'ENTRY_FINISHED');
    });

    it('deletes both branches of an entry\'s candidate, and only those, before the entry leaves', async () => {
      const entry = await withCandidate(true);
      const res = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/withdraw`, { reason: 'base moved on' }, bOwner.headers);
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.deepEqual(gh.calls, [['discardCandidate', REPO, `tc-queue/${entry.entryId}`]]);
      assert.deepEqual(res.data.branches, { candidate: 'deleted', stage: 'not-found' });
      assert.equal(res.data.entry.state, 'withdrawn');
    });

    it('removes the branch named after an entry whose candidate is still being made', async () => {
      const entry = await withCandidate(false);
      const res = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/withdraw`, { reason: 'stuck assembling' }, bOwner.headers);
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.deepEqual(gh.calls, [['discardCandidate', REPO, `tc-queue/${entry.entryId}`]]);
    });

    it('leaves the entry in the queue when a branch could not be removed, and says which is left', async () => {
      const entry = await withCandidate(true);
      gh.discard = { status: 'unavailable', reason: 'tc-queue-stage/x could not be deleted (timed out)', candidate: 'deleted', stage: 'unknown' };
      const url = `/api/merge-queue/entries/${entry.entryId}/withdraw`;
      const res = await sendAs(server, 'POST', url, { reason: 'base moved on' }, bOwner.headers);
      assert.equal(res.status, 503);
      assert.equal(res.data.code, 'CANDIDATE_NOT_DISCARDED');
      assert.equal(res.data.candidate, 'deleted');
      assert.equal(res.data.stage, 'unknown');
      assert.match(res.data.error, /Withdraw again/);
      assert.equal(queueStore.getEntry(entry.entryId).state, 'testing');
      gh.discard = { status: 'discarded', candidate: 'not-found', stage: 'deleted' };
      const again = await sendAs(server, 'POST', url, { reason: 'base moved on' }, bOwner.headers);
      assert.equal(again.status, 200);
      assert.equal(again.data.entry.state, 'withdrawn');
    });

    it('touches no branch of an entry whose merge has been asked for', async () => {
      const entry = await withCandidate(true);
      assert.equal(queueStore.beginLanding(entry.entryId, { candidateCheck: { runId: '9100', conclusion: 'success' }, actor: ownerActor() }).ok, true);
      const res = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/withdraw`, { reason: 'changed my mind' }, bOwner.headers);
      assert.equal(res.status, 409);
      assert.equal(res.data.code, 'TRANSITION_NOT_ALLOWED');
      assert.match(res.data.error, /outcome is read/);
      assert.equal(gh.calls.length, 0);
      assert.equal(queueStore.failEntry(entry.entryId, { code: 'TEST_CLEANUP', actor: ownerActor() }).ok, true);
    });

    it('refuses a reason the records would not take before any branch is deleted', async () => {
      const entry = await withCandidate(true);
      const url = `/api/merge-queue/entries/${entry.entryId}/withdraw`;
      const tooLong = 'x'.repeat(api.MAX_WITHDRAW_REASON + 1);
      const res = await sendAs(server, 'POST', url, { reason: tooLong }, bOwner.headers);
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'INVALID_INPUT');
      assert.match(res.data.error, /at most 1000 characters, and this one is 1001\. Nothing was changed/);
      assert.equal(gh.calls.length, 0, 'no GitHub call was made for a withdrawal that could not be recorded');
      assert.equal(queueStore.getEntry(entry.entryId).state, 'testing');
      // The limit checked here is the records' own: the store refuses the same
      // reason, and takes the longest one this route lets through.
      assert.equal(queueStore.withdrawEntry(entry.entryId, { reason: tooLong, actor: ownerActor() }).code, 'INVALID_INPUT');
      const longest = 'y'.repeat(api.MAX_WITHDRAW_REASON);
      const ok = await sendAs(server, 'POST', url, { reason: `  ${longest}\n` }, bOwner.headers);
      assert.equal(ok.status, 200, JSON.stringify(ok.data));
      assert.equal(ok.data.entry.withdrawnReason, longest, 'the space around a reason is not counted, and is not recorded');
      assert.deepEqual(gh.calls, [['discardCandidate', REPO, `tc-queue/${entry.entryId}`]]);
    });

    /**
     * Hold a queue's slot until the returned function is called.
     * @param {string} id - The queue's id
     * @returns {() => Promise<void>} Gives the slot back and waits for it to be free
     */
    const holdSlot = (id) => {
      let release;
      const held = withQueueSlot(id, () => new Promise((resolve) => { release = resolve; }));
      return async () => { release(); await held; };
    };

    it('a withdrawal arriving while another call holds the queue changes nothing and deletes nothing', async () => {
      const entry = await withCandidate(true);
      const url = `/api/merge-queue/entries/${entry.entryId}/withdraw`;
      const free = holdSlot(queueId);
      try {
        const res = await sendAs(server, 'POST', url, { reason: 'base moved on' }, bOwner.headers);
        assert.equal(res.status, 409);
        assert.equal(res.data.code, 'QUEUE_CALL_IN_FLIGHT');
        assert.equal(res.data.entryId, entry.entryId);
        assert.match(res.data.error, /changed nothing\. Read `tc queue status`, then withdraw again/);
        assert.equal(gh.calls.length, 0);
        assert.equal(queueStore.getEntry(entry.entryId).state, 'testing');
      } finally {
        await free();
      }
      const after = await sendAs(server, 'POST', url, { reason: 'base moved on' }, bOwner.headers);
      assert.equal(after.status, 200, JSON.stringify(after.data));
    });

    it('two withdrawals of one queue do not interleave: the second is refused while the first waits on GitHub', async () => {
      const entry = await withCandidate(true);
      const url = `/api/merge-queue/entries/${entry.entryId}/withdraw`;
      let answerGitHub;
      let reached;
      const atGitHub = new Promise((resolve) => { reached = resolve; });
      // Only the first call waits. A second one reaching GitHub at all is the
      // defect, and it is answered at once so that the test fails on it rather
      // than waiting for an answer nobody gives.
      api._internal.discardCandidate = (repo, ref) => {
        gh.calls.push(['discardCandidate', repo, ref]);
        if (answerGitHub) return Promise.resolve(gh.discard);
        reached();
        return new Promise((resolve) => { answerGitHub = () => resolve(gh.discard); });
      };
      const first = sendAs(server, 'POST', url, { reason: 'first' }, bOwner.headers);
      await atGitHub;
      let done;
      try {
        assert.equal(isQueueSlotTaken(queueId), true);
        const second = await sendAs(server, 'POST', url, { reason: 'second' }, bOwner.headers);
        assert.equal(second.status, 409);
        assert.equal(second.data.code, 'QUEUE_CALL_IN_FLIGHT');
        assert.equal(gh.calls.length, 1, 'the refused withdrawal made no GitHub call of its own');
      } finally {
        // Whatever was found, the first request is answered: one left open
        // would keep the server from closing.
        answerGitHub();
        done = await first;
      }
      assert.equal(done.status, 200, JSON.stringify(done.data));
      assert.equal(done.data.entry.withdrawnReason, 'first');
      assert.equal(isQueueSlotTaken(queueId), false);
    });

    it('gives the slot back after a withdrawal that was refused and after one that threw', async () => {
      const entry = await withCandidate(true);
      const url = `/api/merge-queue/entries/${entry.entryId}/withdraw`;
      gh.discard = { status: 'unavailable', reason: 'timed out', candidate: 'unknown', stage: 'unknown' };
      const refusedOnce = await sendAs(server, 'POST', url, { reason: 'x' }, bOwner.headers);
      assert.equal(refusedOnce.data.code, 'CANDIDATE_NOT_DISCARDED');
      assert.equal(isQueueSlotTaken(queueId), false, 'free after a refusal');
      api._internal.discardCandidate = async () => { throw new Error('boom'); };
      const threw = await sendAs(server, 'POST', url, { reason: 'x' }, bOwner.headers);
      assert.equal(threw.status, 503);
      assert.equal(threw.data.code, 'MERGE_QUEUE_UNAVAILABLE');
      assert.equal(isQueueSlotTaken(queueId), false, 'free after a throw');
      const finished = await sendAs(server, 'POST', `/api/merge-queue/entries/${(await submitted()).entryId}/withdraw`, { reason: 'x' }, bOwner.headers);
      assert.equal(finished.status, 200, JSON.stringify(finished.data));
      const again = await sendAs(server, 'POST', `/api/merge-queue/entries/${finished.data.entry.entryId}/withdraw`, { reason: 'x' }, bOwner.headers);
      assert.equal(again.data.code, 'ENTRY_FINISHED');
      assert.equal(isQueueSlotTaken(queueId), false, 'free after a refusal made inside the slot');
      assert.equal(queueStore.failEntry(entry.entryId, { code: 'TEST_CLEANUP', actor: ownerActor() }).ok, true);
    });

    it('a call holding another queue\'s slot does not block this one', async () => {
      const entry = await withCandidate(true);
      const free = holdSlot('mq_some_other_queue');
      try {
        const res = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/withdraw`, { reason: 'x' }, bOwner.headers);
        assert.equal(res.status, 200, JSON.stringify(res.data));
      } finally {
        await free();
      }
    });

    it('a submit neither waits for the slot nor takes it', async () => {
      let takenDuringReads = null;
      const readPull = api._internal.readPull;
      api._internal.readPull = async (...args) => {
        takenDuringReads = isQueueSlotTaken(queueId);
        return readPull(...args);
      };
      const alone = await submitted();
      assert.equal(takenDuringReads, false, 'a submit running alone does not take the slot');
      const free = holdSlot(queueId);
      try {
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
        assert.equal(res.status, 201, JSON.stringify(res.data));
      } finally {
        await free();
      }
      assert.equal(queueStore.getEntry(alone.entryId).state, 'queued');
    });
  });

  describe('advancing', () => {
    beforeEach(() => {
      emptyQueue();
      githubForAdvance();
    });

    it('the owner takes an entry from queued to landed, one step a call, and each answer says what the call did', async () => {
      const entry = await submitted();
      gh.calls.length = 0;
      const assembled = await advanceAs();
      assert.equal(assembled.status, 200, JSON.stringify(assembled.data));
      assert.equal(assembled.data.step, 'assembled');
      assert.equal(assembled.data.changed, true);
      assert.equal(assembled.data.entry.entryId, entry.entryId);
      assert.equal(assembled.data.entry.state, 'testing');
      assert.deepEqual(assembled.data.entry.candidate, {
        ref: `tc-queue/${entry.entryId}`, baseSha: BASE_SHA, sha: CANDIDATE_SHA, tree: TREE, checkRunId: null, checkConclusion: null
      });
      assert.equal(assembled.data.queue.queueId, queueId);
      assert.match(assembled.data.message, /advance again once it has concluded\.$/);

      const landed = await advanceAs();
      assert.equal(landed.status, 200, JSON.stringify(landed.data));
      assert.equal(landed.data.step, 'landed');
      assert.equal(landed.data.entry.state, 'landed');
      assert.deepEqual(landed.data.landed, { sha: LANDED_SHA, tree: TREE, treeMatches: true, baseMatches: true });
      assert.equal(landed.data.queue.halt, null);
      assert.deepEqual(gh.calls.filter((c) => c[0] === 'mergePull'), [['mergePull', REPO, entry.prNumber, HEAD]]);
      assert.doesNotMatch(JSON.stringify([assembled.data, landed.data]), new RegExp(bOwner.launchId), 'no answer carries a launch id');

      const idle = await advanceAs();
      assert.equal(idle.status, 200);
      assert.equal(idle.data.step, 'idle');
      assert.equal(idle.data.entry, null);
      const shown = await sendAs(server, 'GET', `/api/merge-queue/entries/${entry.entryId}`, undefined, bNeighbour.headers);
      assert.deepEqual(shown.data.events.map((e) => e.event), ['submitted', 'assembly-started', 'candidate-made', 'landing-started', 'landed']);
    });

    it('nobody but the owner\'s verified launch advances the queue, and a refused caller reads and changes nothing', async () => {
      const entry = await submitted();
      gh.calls.length = 0;
      const callers = [
        [op, {}, 403, 'NOT_OWNER'],
        [bNeighbour.headers, { queueId }, 403, 'NOT_OWNER'],
        [bNeighbour.headers, {}, 404, 'QUEUE_NOT_FOUND'],
        [bOutsider.headers, { queueId }, 404, 'QUEUE_NOT_FOUND'],
        [bOwner.headers, { queueId: 'mq_nosuch' }, 404, 'QUEUE_NOT_FOUND'],
        [bOwner.headers, { queueId: 7 }, 404, 'QUEUE_NOT_FOUND'],
        [{}, {}, 403, 'LAUNCH_BINDING_REQUIRED']
      ];
      for (const [headers, body, status, code] of callers) {
        const res = await advanceAs(headers, body);
        assert.equal(res.status, status, JSON.stringify(res.data));
        assert.equal(res.data.code, code);
      }
      assert.equal(gh.calls.length, 0);
      assert.equal(queueStore.getEntry(entry.entryId).state, 'queued');
      assert.match((await advanceAs(op)).data.error, /Ask the owner project's session to advance\.$/);
    });

    it('a held owner cannot advance, and a hold stored while GitHub is being read stops the step before anything is written', async () => {
      const entry = await submitted();
      gh.calls.length = 0;
      const hold = await holdOwner();
      const held = await advanceAs();
      assert.equal(held.status, 423, JSON.stringify(held.data));
      assert.equal(held.data.code, 'CONTROL_HELD');
      assert.equal(gh.calls.length, 0);
      await releaseOwner(hold);

      let during = null;
      gh.during = { readRefTip: async () => { during = await holdOwner(); } };
      const overtaken = await advanceAs();
      gh.during = null;
      await releaseOwner(during);
      assert.equal(overtaken.status, 423, JSON.stringify(overtaken.data));
      assert.equal(overtaken.data.code, 'CONTROL_HELD');
      assert.deepEqual(githubWrites(), []);
      assert.equal(queueStore.getEntry(entry.entryId).state, 'queued');
      assert.equal((await advanceAs()).data.step, 'assembled');
    });

    it('says which gate stops a green entry, which read failed, and that a red base stops everything', async () => {
      const entry = await submitted({ operatorGate: 'required' });
      assert.equal((await advanceAs()).data.step, 'assembled');
      const gated = await advanceAs();
      assert.equal(gated.status, 409, JSON.stringify(gated.data));
      assert.equal(gated.data.code, 'GATES_NOT_MET');
      assert.deepEqual(gated.data.problems.map((p) => p.gate), ['operator']);
      assert.equal(gated.data.queueId, queueId);

      gh.branchCheck = (branch) => (branch === 'main'
        ? { status: 'concluded', conclusion: 'failure', runId: '7000', suiteId: '1', completedAt: '2026-10-12T10:00:00Z', app: 'github-actions' }
        : { status: 'concluded', conclusion: 'success', runId: '7001', suiteId: '2', completedAt: '2026-10-12T10:00:00Z', app: 'github-actions' });
      const red = await advanceAs();
      assert.equal(red.status, 409, JSON.stringify(red.data));
      assert.equal(red.data.code, 'BASE_NOT_GREEN');
      assert.deepEqual(red.data.check, { conclusion: 'failure', runId: '7000' });

      gh.branchCheck = () => ({ status: 'unavailable', reason: 'the commit\'s check runs could not be read whole (100 of 100)' });
      const unread = await advanceAs();
      assert.equal(unread.status, 503, JSON.stringify(unread.data));
      assert.equal(unread.data.code, 'GITHUB_UNAVAILABLE');
      assert.equal(unread.data.reason, 'the commit\'s check runs could not be read whole (100 of 100)');
      assert.match(unread.data.error, /could not be read whole \(100 of 100\)\)\. Nothing was changed/);
      assert.equal(queueStore.getEntry(entry.entryId).state, 'testing');
      assert.deepEqual(githubWrites(), ['createCandidate']);
    });

    it('stops for a person when a candidate branch is there again after the queue removed it', async () => {
      const entry = await submitted();
      gh.create = { status: 'ref-exists', ref: `tc-queue/${entry.entryId}`, existing: 'stage', refCreated: false, stageLeft: true };
      const retry = await advanceAs();
      assert.equal(retry.status, 200, JSON.stringify(retry.data));
      assert.equal(retry.data.step, 'assembly-retry');
      const again = await advanceAs();
      assert.equal(again.status, 409, JSON.stringify(again.data));
      assert.equal(again.data.code, 'CANDIDATE_REF_EXISTS');
      assert.equal(again.data.existing, 'stage');
      assert.equal(queueStore.getEntry(entry.entryId).state, 'assembling');
    });

    it('leaves a failing entry where it is while its branches cannot be removed, and says which is left', async () => {
      const entry = await submitted();
      assert.equal((await advanceAs()).data.step, 'assembled');
      gh.pull = { state: 'closed' };
      gh.discard = { status: 'unavailable', reason: 'a branch could not be deleted (GitHub answered HTTP 500)', candidate: 'unknown', stage: 'not-found' };
      const stuck = await advanceAs();
      assert.equal(stuck.status, 503, JSON.stringify(stuck.data));
      assert.equal(stuck.data.code, 'CANDIDATE_NOT_DISCARDED');
      assert.equal(stuck.data.candidate, 'unknown');
      assert.equal(stuck.data.stage, 'not-found');
      assert.equal(queueStore.getEntry(entry.entryId).state, 'testing');
      gh.discard = { status: 'discarded', candidate: 'deleted', stage: 'not-found' };
      const failed = await advanceAs();
      assert.equal(failed.data.step, 'failed');
      assert.deepEqual(failed.data.entry.failure, { code: 'PR_NOT_OPEN', detail: failed.data.failure.detail });
    });

    it('an advance arriving while another call holds the queue changes nothing, and so does a withdrawal arriving during an advance', async () => {
      const entry = await submitted();
      gh.calls.length = 0;
      let release;
      const holding = withQueueSlot(queueId, () => new Promise((resolve) => { release = resolve; }));
      try {
        const refused = await advanceAs();
        assert.equal(refused.status, 409, JSON.stringify(refused.data));
        assert.equal(refused.data.code, 'QUEUE_CALL_IN_FLIGHT');
        assert.match(refused.data.error, /this advance changed nothing\. Read `tc queue status`, then advance again\.$/);
        assert.equal(gh.calls.length, 0);
      } finally {
        release();
        await holding;
      }

      let withdrawn = null;
      gh.during = {
        createCandidate: async () => {
          withdrawn = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/withdraw`, { reason: 'changed my mind' }, bOwner.headers);
        }
      };
      const assembled = await advanceAs();
      gh.during = null;
      assert.equal(assembled.data.step, 'assembled');
      assert.equal(withdrawn.status, 409, JSON.stringify(withdrawn.data));
      assert.equal(withdrawn.data.code, 'QUEUE_CALL_IN_FLIGHT');
      assert.ok(!gh.calls.some((c) => c[0] === 'discardCandidate'), 'the refused withdrawal deleted nothing');
      assert.equal(queueStore.getEntry(entry.entryId).state, 'testing');
      assert.equal(isQueueSlotTaken(queueId), false);
    });

    it('an advance arriving during a withdrawal changes nothing, and the slot is free after an advance that was refused', async () => {
      const entry = await withCandidate(true);
      githubForAdvance();
      let overtaking = null;
      const realDiscard = api._internal.discardCandidate;
      api._internal.discardCandidate = async (...args) => {
        overtaking = await advanceAs();
        return realDiscard(...args);
      };
      const wd = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/withdraw`, { reason: 'base moved on' }, bOwner.headers);
      api._internal.discardCandidate = realDiscard;
      assert.equal(wd.status, 200, JSON.stringify(wd.data));
      assert.equal(overtaking.status, 409, JSON.stringify(overtaking.data));
      assert.equal(overtaking.data.code, 'QUEUE_CALL_IN_FLIGHT');
      assert.ok(!gh.calls.some((c) => c[0] === 'mergePull' || c[0] === 'createCandidate'));

      const next = await submitted();
      gh.tip = { status: 'unavailable', reason: 'gh api timed out after 10000ms' };
      assert.equal((await advanceAs()).status, 503);
      assert.equal(isQueueSlotTaken(queueId), false);
      gh.tip = null;
      assert.equal((await advanceAs()).data.entry.entryId, next.entryId);
    });

    it('a queue that halted itself refuses every advance until the Operator clears the halt, and nobody else can', async () => {
      const made = await sendAs(server, 'POST', '/api/merge-queue', { repo: 'Jason-Vaughan/Halting', baseBranch: 'main', ownerProjectId: owner.id }, op);
      assert.equal(made.status, 201, JSON.stringify(made.data));
      const halting = made.data.queue.queueId;
      try {
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr(), { queueId: halting }), bOwner.headers);
        assert.equal(res.status, 201, JSON.stringify(res.data));
        assert.equal((await advanceAs(bOwner.headers, { queueId: halting })).data.step, 'assembled');
        gh.commit = { status: 'read', sha: LANDED_SHA, tree: OTHER_HEAD, parents: [BASE_SHA, HEAD] };
        const landed = await advanceAs(bOwner.headers, { queueId: halting });
        assert.equal(landed.data.step, 'landed');
        assert.equal(landed.data.queueHalted, true);
        assert.equal(landed.data.queue.halt.code, 'TREE_MISMATCH');
        assert.equal(landed.data.entry.landed.treeMatches, false);
        gh.calls.length = 0;
        const refused = await advanceAs(bOwner.headers, { queueId: halting });
        assert.equal(refused.status, 409, JSON.stringify(refused.data));
        assert.equal(refused.data.code, 'QUEUE_HALTED');
        assert.equal(gh.calls.length, 0);

        const url = `/api/merge-queue/${halting}/clear-halt`;
        for (const b of [bOwner, bNeighbour, bOutsider]) {
          const res = await sendAs(server, 'POST', url, { reference: 'main looks fine to me' }, b.headers);
          assert.equal(res.status, 403, JSON.stringify(res.data));
          assert.equal(res.data.code, 'OPERATOR_ONLY');
          assert.match(res.data.error, /A session saying the Operator agreed is not the Operator: ask them to clear it\.$/);
        }
        assert.equal((await sendAs(server, 'POST', url, { reference: 'x' }, {})).data.code, 'LAUNCH_BINDING_REQUIRED');
        for (const body of [{}, { reference: '' }, { reference: '   ' }, { reference: 7 }]) {
          const res = await sendAs(server, 'POST', url, body, op);
          assert.equal(res.status, 400, JSON.stringify(res.data));
          assert.equal(res.data.code, 'INVALID_INPUT');
        }
        assert.equal((await sendAs(server, 'POST', '/api/merge-queue/mq_nosuch/clear-halt', { reference: 'x' }, op)).status, 404);
        assert.equal((await sendAs(server, 'POST', '/api/merge-queue/no%20such%2Fqueue/clear-halt', { reference: 'x' }, op)).data.code, 'QUEUE_NOT_FOUND');
        assert.equal(queueStore.getQueue(halting).halt.code, 'TREE_MISMATCH', 'no refused call cleared anything');
        assert.equal((await advanceAs(bOwner.headers, { queueId: halting })).data.code, 'QUEUE_HALTED');

        const cleared = await sendAs(server, 'POST', url, { reference: '  main checked by hand against the candidate, 2026-10-12  ' }, op);
        assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
        assert.equal(cleared.data.queue.halt, null);
        assert.equal(cleared.data.cleared.code, 'TREE_MISMATCH');
        const event = queueStore.listEvents(halting).pop();
        assert.equal(event.event, 'queue-halt-cleared');
        assert.equal(event.actor.kind, 'operator');
        assert.ok(event.actor.operatorProof, 'the Operator\'s proof tier is on record');
        assert.equal(event.detail.reference, 'main checked by hand against the candidate, 2026-10-12');
        assert.equal(event.detail.code, 'TREE_MISMATCH');

        const twice = await sendAs(server, 'POST', url, { reference: 'again' }, op);
        assert.equal(twice.status, 409, JSON.stringify(twice.data));
        assert.equal(twice.data.code, 'QUEUE_NOT_HALTED');
        const idle = await advanceAs(bOwner.headers, { queueId: halting });
        assert.equal(idle.status, 200, JSON.stringify(idle.data));
        assert.equal(idle.data.step, 'idle');
      } finally {
        // Whatever the test left, the queue is retired so no later test meets a second queue of this owner.
        const actor = { kind: 'operator', operatorProof: 'ambient-open' };
        queueStore.clearHalt(halting, { actor, reference: 'test teardown' });
        assert.equal(queueStore.retireQueue(halting, { actor }).ok, true);
      }
    });
  });

  describe('the owner\'s coordinator rotation fences submit, withdraw and advance', () => {
    const PRIOR = 'thread-before-the-rotation';
    const NEXT = 'thread-the-rotation-bound';
    const THREAD = 'x-tangleclaw-engine-thread';
    let generation = 0;
    let open = null;

    /** The owner's launch headers with an engine thread, or with none. */
    const from = (thread) => (thread ? { ...bOwner.headers, [THREAD]: thread } : bOwner.headers);

    /**
     * Put the owner project's rotation in a state, as the rotation's own
     * records would hold it: bound to the owner's live session and launch,
     * with NEXT as the replacement thread once one is bound.
     * @param {string} to - `fenced`, `rebinding`, `reconciling`, `active` or `abandoned`
     * @returns {object} The rotation
     */
    const rotate = (to) => {
      const now = new Date().toISOString();
      if (!open) {
        generation += 1;
        open = store.coordinatorRotations.insert({
          rotationId: `rot_mq_${generation}`, attemptKey: `mq-attempt-${generation}`, projectId: owner.id, sessionId: bOwner.sessionId,
          launchId: bOwner.launchId, engineId: 'codex', channelId: 1, sequenceId: 1, generation, priorThreadId: PRIOR, checkpointSchema: 1,
          checkpointDigest: 'f'.repeat(64), checkpoint: {}, inboxIds: [], roleId: 'role_mq', authorityVersion: 1, checkout: {}, github: [], now
        });
      }
      if (to !== open.state) {
        const bound = to === 'reconciling' || to === 'active';
        const moved = store.coordinatorRotations.updateIf(open.rotationId, open.state, { state: to, replacementThreadId: bound ? NEXT : null }, { now });
        assert.equal(moved.written, true);
        open = moved.rotation;
      }
      const rotation = open;
      if (to === 'abandoned') open = null;
      return rotation;
    };

    /** Entries of the queue that are not finished. */
    const waiting = () => queueStore.listEntries(queueId, { includeFinished: false }).length;

    afterEach(() => {
      // No rotation outlives its test: every other test in this file is of a
      // project that is not judged.
      if (open) rotate('abandoned');
    });

    it('a stale thread of the same live launch can neither submit nor withdraw, and the bound replacement can', async () => {
      const entry = await withCandidate(true);
      const url = `/api/merge-queue/entries/${entry.entryId}/withdraw`;
      const rotation = rotate('active');
      const before = waiting();
      for (const thread of [PRIOR, 'some-other-thread']) {
        const sub = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), from(thread));
        assert.equal(sub.status, 409, JSON.stringify(sub.data));
        assert.equal(sub.data.code, 'COORDINATOR_EPOCH_MISMATCH');
        assert.equal(sub.data.rotationId, rotation.rotationId);
        assert.equal(sub.data.action, 'merge-queue-mutate');
        const wd = await sendAs(server, 'POST', url, { reason: 'stale' }, from(thread));
        assert.equal(wd.status, 409, JSON.stringify(wd.data));
        assert.equal(wd.data.code, 'COORDINATOR_EPOCH_MISMATCH');
      }
      assert.equal(gh.calls.length, 0, 'a refused call read nothing from GitHub and deleted nothing');
      assert.equal(waiting(), before);
      assert.equal(queueStore.getEntry(entry.entryId).state, 'testing');
      const sub = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), from(NEXT));
      assert.equal(sub.status, 201, JSON.stringify(sub.data));
      const wd = await sendAs(server, 'POST', url, { reason: 'base moved on' }, from(NEXT));
      assert.equal(wd.status, 200, JSON.stringify(wd.data));
      assert.equal(wd.data.entry.state, 'withdrawn');
    });

    it('a call with no engine thread is refused while an epoch is active, and told to go through tc', async () => {
      const entry = await submitted();
      rotate('active');
      const sub = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), from(null));
      assert.equal(sub.data.code, 'COORDINATOR_EPOCH_MISMATCH');
      assert.match(sub.data.error, /no engine-thread header: make the call through `tc`/);
      const wd = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/withdraw`, { reason: 'x' }, from(null));
      assert.equal(wd.data.code, 'COORDINATOR_EPOCH_MISMATCH');
      assert.match(wd.data.error, /through `tc`/);
      assert.equal(queueStore.getEntry(entry.entryId).state, 'queued');
    });

    for (const [to, code] of [['fenced', 'COORDINATOR_FENCED'], ['rebinding', 'COORDINATOR_FENCED'], ['reconciling', 'COORDINATOR_FENCED']]) {
      it(`while the rotation is ${to}, nobody submits or withdraws, the bound replacement included`, async () => {
        const entry = await withCandidate(true);
        const rotation = rotate(to);
        const before = waiting();
        for (const thread of [NEXT, PRIOR, null]) {
          // Once a replacement is bound, any other thread is told it is not
          // the bound one; the bound one is told to wait for the resume.
          const expected = to === 'reconciling' && thread !== NEXT ? 'COORDINATOR_EPOCH_MISMATCH' : code;
          const sub = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), from(thread));
          assert.equal(sub.status, 409, JSON.stringify(sub.data));
          assert.equal(sub.data.code, expected, `submit from ${thread}`);
          const wd = await sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/withdraw`, { reason: 'x' }, from(thread));
          assert.equal(wd.status, 409, JSON.stringify(wd.data));
          assert.equal(wd.data.code, expected, `withdraw from ${thread}`);
          if (expected === code) assert.equal(wd.data.state, to);
          assert.equal(wd.data.rotationId, rotation.rotationId);
        }
        assert.equal(gh.calls.length, 0);
        assert.equal(waiting(), before);
        assert.equal(queueStore.getEntry(entry.entryId).state, 'testing');
      });
    }

    it('an abandoned rotation judges nobody: the owner submits and withdraws as before, with any thread or none', async () => {
      rotate('fenced');
      rotate('abandoned');
      for (const thread of [PRIOR, null]) {
        const sub = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), from(thread));
        assert.equal(sub.status, 201, JSON.stringify(sub.data));
        const wd = await sendAs(server, 'POST', `/api/merge-queue/entries/${sub.data.entry.entryId}/withdraw`, { reason: 'x' }, from(thread));
        assert.equal(wd.status, 200, JSON.stringify(wd.data));
      }
    });

    it('an epoch whose bound session has ended has lapsed: the owner\'s next launch is not judged', async () => {
      const elsewhere = mkProject('rotated-owner');
      const first = bindProject(elsewhere);
      const made = await sendAs(server, 'POST', '/api/merge-queue', { repo: 'Jason-Vaughan/Rotated', baseBranch: 'main', ownerProjectId: elsewhere.id }, op);
      assert.equal(made.status, 201, JSON.stringify(made.data));
      const now = new Date().toISOString();
      const rot = store.coordinatorRotations.insert({
        rotationId: 'rot_mq_lapse', attemptKey: 'mq-attempt-lapse', projectId: elsewhere.id, sessionId: first.sessionId, launchId: first.launchId,
        engineId: 'codex', channelId: 1, sequenceId: 1, generation: 1, priorThreadId: PRIOR, checkpointSchema: 1, checkpointDigest: 'f'.repeat(64),
        checkpoint: {}, inboxIds: [], roleId: 'role_mq', authorityVersion: 1, checkout: {}, github: [], now
      });
      assert.equal(store.coordinatorRotations.updateIf(rot.rotationId, 'fenced', { state: 'active', replacementThreadId: NEXT }, { now }).written, true);
      const stale = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), { ...first.headers, [THREAD]: PRIOR });
      assert.equal(stale.data.code, 'COORDINATOR_EPOCH_MISMATCH');
      store.sessions.wrap(first.sessionId);
      const second = bindProject(elsewhere);
      const sub = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), second.headers);
      assert.equal(sub.status, 201, JSON.stringify(sub.data));
      assert.equal(queueStore.withdrawEntry(sub.data.entry.entryId, { reason: 'test cleanup', actor: { kind: 'project', projectId: elsewhere.id, launchId: second.launchId } }).ok, true);
      assert.equal(queueStore.retireQueue(made.data.queue.queueId, { actor: { kind: 'operator', operatorProof: 'ambient-open' } }).ok, true);
    });

    it('a rotation that begins while GitHub is being read refuses the write: nothing is queued', async () => {
      rotate('active');
      const before = waiting();
      const readFiles = api._internal.readPullFiles;
      api._internal.readPullFiles = async (repo, number) => {
        rotate('abandoned');
        rotate('fenced');
        return readFiles(repo, number);
      };
      const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), from(NEXT));
      assert.equal(res.status, 409, JSON.stringify(res.data));
      assert.equal(res.data.code, 'COORDINATOR_FENCED');
      assert.deepEqual(gh.calls.map((c) => c[0]), ['readPull', 'readCheck', 'readPullFiles'], 'every read was made: the rotation began during the last');
      assert.equal(waiting(), before);
    });

    it('a rotation that begins while GitHub is deleting leaves the entry in the queue, for the replacement to withdraw again', async () => {
      const entry = await withCandidate(true);
      const url = `/api/merge-queue/entries/${entry.entryId}/withdraw`;
      rotate('active');
      api._internal.discardCandidate = async (repo, ref) => {
        gh.calls.push(['discardCandidate', repo, ref]);
        // Only the first deletion is overtaken by a rotation.
        if (gh.calls.length === 1) {
          rotate('abandoned');
          rotate('reconciling');
        }
        return gh.discard;
      };
      const res = await sendAs(server, 'POST', url, { reason: 'base moved on' }, from(NEXT));
      assert.equal(res.status, 409, JSON.stringify(res.data));
      assert.equal(res.data.code, 'COORDINATOR_FENCED');
      assert.equal(gh.calls.length, 1);
      assert.equal(queueStore.getEntry(entry.entryId).state, 'testing', 'not recorded withdrawn');
      assert.equal(isQueueSlotTaken(queueId), false, 'the slot is given back');
      rotate('active');
      const again = await sendAs(server, 'POST', url, { reason: 'base moved on' }, from(NEXT));
      assert.equal(again.status, 200, JSON.stringify(again.data));
      assert.equal(again.data.entry.state, 'withdrawn');
      assert.equal(gh.calls.length, 2, 'the deletion is asked for again, which is harmless');
    });

    it('asks the gate at entry and again before each deletion and each write, and a refusal at any of them does nothing after it', async () => {
      const gate = api._internal.rotationGate;
      const no = { status: 409, body: { error: 'This project is in managed context rotation.', code: 'COORDINATOR_FENCED', rotationId: 'rot_seam' } };
      /**
       * Run one call with the gate refusing from its nth ask on.
       * @param {number} refuseFrom - The first ask to refuse; Infinity for none
       * @param {() => Promise<object>} call - The request
       * @returns {Promise<{res: object, asks: object[]}>}
       */
      const counted = async (refuseFrom, call) => {
        const asks = [];
        api._internal.rotationGate = (input) => { asks.push(input); return asks.length >= refuseFrom ? no : null; };
        try {
          return { res: await call(), asks };
        } finally {
          api._internal.rotationGate = gate;
        }
      };
      const submit = () => sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), from(NEXT));

      const entry = await withCandidate(true);
      const withdraw = () => sendAs(server, 'POST', `/api/merge-queue/entries/${entry.entryId}/withdraw`, { reason: 'x' }, from(NEXT));
      const before = waiting();
      let out = await counted(1, submit);
      assert.equal(out.res.data.code, 'COORDINATOR_FENCED');
      assert.equal(gh.calls.length, 0, 'refused at entry: GitHub is not asked');
      out = await counted(2, submit);
      assert.equal(out.res.status, 409);
      assert.equal(out.asks.length, 2);
      assert.equal(gh.calls.length, 3, 'refused after the reads');
      assert.equal(waiting(), before, 'and nothing is queued');
      assert.deepEqual(out.asks[0], { projectId: owner.id, access: out.asks[0].access, threadId: NEXT, action: 'merge-queue-mutate' });
      assert.equal(out.asks[0].access.kind, 'project');
      assert.equal(out.asks[0].access.projectId, owner.id);
      assert.equal(out.asks[0].access.sessionId, bOwner.sessionId);
      assert.equal(out.asks[0].access.launchId, bOwner.launchId);

      gh.calls.length = 0;
      out = await counted(1, withdraw);
      assert.equal(out.res.data.code, 'COORDINATOR_FENCED');
      out = await counted(2, withdraw);
      assert.equal(out.res.status, 409);
      assert.equal(gh.calls.length, 0, 'refused before the deletion: no branch is touched');
      out = await counted(3, withdraw);
      assert.equal(out.res.status, 409);
      assert.equal(gh.calls.length, 1, 'refused after the deletion');
      assert.equal(queueStore.getEntry(entry.entryId).state, 'testing', 'and the entry is not recorded withdrawn');
      out = await counted(Infinity, withdraw);
      assert.equal(out.res.status, 200, JSON.stringify(out.res.data));
      assert.equal(out.asks.length, 3, 'entry, before the deletion, before the record');

      const plain = await submitted();
      gh.calls.length = 0;
      out = await counted(Infinity, () => sendAs(server, 'POST', `/api/merge-queue/entries/${plain.entryId}/withdraw`, { reason: 'x' }, from(NEXT)));
      assert.equal(out.res.status, 200, JSON.stringify(out.res.data));
      assert.equal(out.asks.length, 2, 'no candidate, so no deletion: entry and before the record');
    });

    it('a stale thread of the same live launch cannot advance, and the bound replacement can', async () => {
      emptyQueue();
      githubForAdvance();
      const entry = await submitted();
      gh.calls.length = 0;
      const rotation = rotate('active');
      for (const thread of [PRIOR, 'some-other-thread', null]) {
        const res = await advanceAs(from(thread));
        assert.equal(res.status, 409, JSON.stringify(res.data));
        assert.equal(res.data.code, 'COORDINATOR_EPOCH_MISMATCH');
        assert.equal(res.data.rotationId, rotation.rotationId);
        assert.equal(res.data.action, 'merge-queue-mutate');
      }
      assert.equal(gh.calls.length, 0, 'a refused advance read nothing from GitHub');
      assert.equal(queueStore.getEntry(entry.entryId).state, 'queued');
      assert.equal((await advanceAs(from(NEXT))).data.step, 'assembled');
      assert.equal((await advanceAs(from(NEXT))).data.step, 'landed');
    });

    for (const to of ['fenced', 'rebinding', 'reconciling']) {
      it(`while the rotation is ${to}, nobody advances, the bound replacement included`, async () => {
        emptyQueue();
        githubForAdvance();
        const entry = await submitted();
        gh.calls.length = 0;
        rotate(to);
        for (const thread of [NEXT, PRIOR, null]) {
          const res = await advanceAs(from(thread));
          assert.equal(res.status, 409, JSON.stringify(res.data));
          assert.equal(res.data.code, to === 'reconciling' && thread !== NEXT ? 'COORDINATOR_EPOCH_MISMATCH' : 'COORDINATOR_FENCED', `advance from ${thread}`);
        }
        assert.equal(gh.calls.length, 0);
        assert.equal(queueStore.getEntry(entry.entryId).state, 'queued');
      });
    }

    it('a rotation that begins during a landing\'s reads prevents the merge, and the refusal is logged as every gated mutation\'s is', async () => {
      emptyQueue();
      githubForAdvance();
      const entry = await submitted();
      assert.equal((await advanceAs(from(PRIOR))).data.step, 'assembled');
      gh.calls.length = 0;
      let rotation = null;
      gh.during = { readCompareFiles: async () => { rotation = rotate('fenced'); } };
      const lines = [];
      setConsoleStream({ write: (line) => { lines.push(String(line)); return true; } });
      setLevel('info');
      let res;
      try {
        res = await advanceAs(from(PRIOR));
      } finally {
        setLevel('error');
        setConsoleStream(null);
        gh.during = null;
      }
      assert.equal(res.status, 409, JSON.stringify(res.data));
      assert.equal(res.data.code, 'COORDINATOR_FENCED');
      assert.ok(!gh.calls.some((c) => c[0] === 'mergePull'), 'the merge is never asked for');
      const after = queueStore.getEntry(entry.entryId);
      assert.equal(after.state, 'testing');
      assert.equal(after.candidate.sha, CANDIDATE_SHA);
      const logged = lines.filter((line) => line.includes('Coordinator epoch gate refused a mutation'));
      assert.equal(logged.length, 1, lines.join(''));
      assert.ok(logged[0].trimEnd().endsWith('[INFO] [merge-queue-api] Coordinator epoch gate refused a mutation '
        + `projectId=${owner.id} action=merge-queue-mutate code=COORDINATOR_FENCED rotationId=${rotation.rotationId}`), logged[0]);
    });

    it('a rotation that begins after the merge request was started records the landing, deletes no branch and asks for no second merge', async () => {
      emptyQueue();
      githubForAdvance();
      const entry = await submitted();
      assert.equal((await advanceAs(from(PRIOR))).data.step, 'assembled');
      gh.calls.length = 0;
      gh.during = { mergePull: async () => { rotate('fenced'); } };
      const res = await advanceAs(from(PRIOR));
      gh.during = null;
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.step, 'landed');
      assert.equal(res.data.cleanup.code, 'COORDINATOR_FENCED');
      assert.equal(res.data.entry.state, 'landed');
      assert.equal(res.data.entry.landed.sha, LANDED_SHA);
      assert.equal(gh.calls.filter((c) => c[0] === 'mergePull').length, 1);
      assert.ok(!gh.calls.some((c) => c[0] === 'discardCandidate'));
      assert.equal(queueStore.getEntry(entry.entryId).state, 'landed');

      rotate('reconciling');
      rotate('active');
      const cleaned = await advanceAs(from(NEXT));
      assert.equal(cleaned.data.step, 'cleaned-up');
      assert.deepEqual(gh.calls.filter((c) => c[0] === 'discardCandidate'), [['discardCandidate', REPO, `tc-queue/${entry.entryId}`]]);
    });

    it('gates only the owner\'s submit and withdraw: other refusals come first, and reading and the Operator are untouched', async () => {
      const entry = await submitted({ operatorGate: 'required' });
      const url = `/api/merge-queue/entries/${entry.entryId}`;
      rotate('fenced');
      const asOperator = await sendAs(server, 'POST', `${url}/withdraw`, { reason: 'x' }, op);
      assert.equal(asOperator.data.code, 'NOT_OWNER');
      const opSubmit = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), op);
      assert.equal(opSubmit.data.code, 'NOT_OWNER');
      const asNeighbour = await sendAs(server, 'POST', `${url}/withdraw`, { reason: 'x' }, { ...bNeighbour.headers, [THREAD]: PRIOR });
      assert.equal(asNeighbour.data.code, 'NOT_OWNER');
      const list = await sendAs(server, 'GET', '/api/merge-queue', undefined, from(PRIOR));
      assert.equal(list.status, 200);
      const show = await sendAs(server, 'GET', url, undefined, from(null));
      assert.equal(show.status, 200);
      const gated = await sendAs(server, 'POST', `${url}/operator-gate`, { reference: 'the Operator said yes at 07:00' }, op);
      assert.equal(gated.status, 200, JSON.stringify(gated.data));
      const queueByOperator = await sendAs(server, 'POST', '/api/merge-queue', { repo: 'Jason-Vaughan/Fenced', baseBranch: 'main', ownerProjectId: owner.id }, op);
      assert.equal(queueByOperator.status, 201, JSON.stringify(queueByOperator.data));
      assert.equal(queueStore.retireQueue(queueByOperator.data.queue.queueId, { actor: { kind: 'operator', operatorProof: 'ambient-open' } }).ok, true);
      assert.equal(queueStore.getEntry(entry.entryId).state, 'queued');
    });
  });

  describe('what a refusal says', () => {
    it('a store failure is a 503 that says to read before repeating, never an accepted answer', async () => {
      const real = api._internal.readPull;
      api._internal.readPull = async () => { throw new Error('boom'); };
      try {
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
        assert.equal(res.status, 503);
        assert.equal(res.data.code, 'MERGE_QUEUE_UNAVAILABLE');
        assert.match(res.data.error, /Read the queue again/);
      } finally {
        api._internal.readPull = real;
      }
    });

    it('every refusal answered in this file carries a code and a sentence that says what to do next', () => {
      const queueRefusals = REFUSED.filter((r) => r.request.includes('/api/merge-queue'));
      assert.ok(queueRefusals.length > 60, `only ${queueRefusals.length} refusals were recorded`);
      // What "what to do next" looks like in a sentence: an instruction, a
      // condition to wait for, or who can do it. A refusal with none of these
      // only says no.
      const NEXT = /\b(Send|send|Sign in|sign in|Ask|ask|Read|read|Submit|submit|Withdraw|withdraw|Retire|Retarget|Review|Mark|Name|Only|only|until|before|report|makes|needs|must|again|merged by hand|cannot change|not needing|already recorded|act as|release)\b/;
      // The queue words its own refusals. Those of the layers in front of it
      // (the launch binding, the HOLD gate) are theirs, and are held here only
      // to carrying a code and a sentence.
      const ownCodes = new Set([...Object.values(api.API_REFUSALS), ...Object.values(state.REFUSALS), 'MERGE_QUEUE_UNAVAILABLE']);
      let own = 0;
      for (const r of queueRefusals) {
        const where = `${r.status} ${r.request}: ${JSON.stringify(r.body)}`;
        assert.equal(typeof r.body.code, 'string', where);
        assert.match(r.body.code, /^[A-Z][A-Z_]+$/, where);
        assert.equal(typeof r.body.error, 'string', where);
        assert.ok(r.body.error.trim().length > 10, where);
        if (!ownCodes.has(r.body.code)) continue;
        own += 1;
        assert.match(r.body.error, /\.$/, where);
        assert.match(r.body.error, NEXT, where);
      }
      assert.ok(own > 50, `only ${own} of the queue's own refusals were recorded`);
      const seen = new Set(queueRefusals.map((r) => r.body.code));
      const unreachedOverHttp = ['OPERATOR_UNVERIFIABLE', 'QUEUE_AMBIGUOUS'];
      for (const code of Object.values(api.API_REFUSALS)) {
        if (!unreachedOverHttp.includes(code)) assert.ok(seen.has(code), `${code} was never answered in this file`);
      }
      for (const code of ['OPERATOR_ONLY', 'NOT_OWNER', 'INVALID_INPUT', 'GATE_REFERENCE_MISSING', 'QUEUE_NOT_FOUND', 'ENTRY_NOT_FOUND',
        'QUEUE_EXISTS', 'DUPLICATE_PR', 'RELEASE_TRIGGER_CHANGED', 'ENTRY_FINISHED', 'TRANSITION_NOT_ALLOWED',
        'OPERATOR_GATE_NOT_REQUIRED', 'OPERATOR_GATE_ALREADY_RECORDED', 'CONTROL_HELD', 'MERGE_QUEUE_UNAVAILABLE']) {
        assert.ok(seen.has(code), `${code} was never answered in this file`);
      }
    });

    it('an owner of two queues is asked which one, and told their ids', async () => {
      const second = await sendAs(server, 'POST', '/api/merge-queue', { repo: 'Jason-Vaughan/Second', baseBranch: 'main', ownerProjectId: owner.id }, op);
      assert.equal(second.status, 201, JSON.stringify(second.data));
      try {
        const res = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr()), bOwner.headers);
        assert.equal(res.status, 400);
        assert.equal(res.data.code, 'QUEUE_AMBIGUOUS');
        assert.deepEqual([...res.data.queueIds].sort(), [queueId, second.data.queue.queueId].sort());
        assert.match(res.data.error, /Name the one you mean with queueId/);
        const named = await sendAs(server, 'POST', '/api/merge-queue/entries', submitBody(nextPr(), { queueId: second.data.queue.queueId }), bOwner.headers);
        assert.equal(named.status, 201, JSON.stringify(named.data));
        assert.equal(named.data.entry.queueId, second.data.queue.queueId);
        assert.equal(queueStore.withdrawEntry(named.data.entry.entryId, { reason: 'test cleanup', actor: ownerActor() }).ok, true);
      } finally {
        assert.equal(queueStore.retireQueue(second.data.queue.queueId, { actor: { kind: 'operator', operatorProof: 'ambient-open' } }).ok, true);
      }
    });
  });
});

describe('/api/merge-queue on a signed-in install (#2322)', () => {
  let tmpDir;
  let server;
  let project;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-merge-queue-signed-in-'));
    store._setBasePath(tmpDir);
    store.init();
    const dir = path.join(tmpDir, 'integrator');
    fs.mkdirSync(dir);
    project = store.projects.create({ name: 'integrator', path: dir, engine: 'claude' });
    // An install with a login: its gate enforces, and its operator signs in.
    const config = store.config.load();
    config.authEnabled = true;
    config.basicAuthUser = 'admin';
    config.basicAuthHash = '$2a$14$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0';
    store.config.save(config);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the Operator makes a queue with the session\'s token, and the proof on record is the session', async () => {
    const signedIn = await signInOperator(server);
    const body = { repo: 'Jason-Vaughan/TangleClaw', baseBranch: 'main', ownerProjectId: project.id };
    // What a bare `fetch` from the dashboard sends: the session and no token.
    const { 'x-csrf-token': _token, ...bare } = signedIn;
    const refused = await sendRaw(server, 'POST', '/api/merge-queue', body, bare);
    assert.equal(refused.status, 403);
    assert.equal(refused.data.code, 'CSRF_TOKEN_INVALID');
    assert.equal(queueStore.listQueues().length, 0);
    // The dashboard header alone, with no session, is not the Operator here.
    const forged = await sendRaw(server, 'POST', '/api/merge-queue', body, { ...operatorHeaders(server), 'x-tangleclaw-client': 'dashboard' });
    assert.ok([401, 403].includes(forged.status), `answered ${forged.status}`);
    assert.equal(queueStore.listQueues().length, 0);
    const made = await sendRaw(server, 'POST', '/api/merge-queue', body, signedIn);
    assert.equal(made.status, 201, JSON.stringify(made.data));
    assert.equal(made.data.queue.createdBy.operatorProof, 'verified-session');
    const read = await sendRaw(server, 'GET', '/api/merge-queue', undefined, signedIn);
    assert.equal(read.status, 200);
    assert.equal(read.data.queues.length, 1);
  });
});
