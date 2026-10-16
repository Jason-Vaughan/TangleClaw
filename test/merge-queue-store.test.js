'use strict';

// #2322: the merge queue's records. Every write is driven through the real
// store on a temporary database, and each test reads back both the row and the
// history, because a change with no event (or an event with no change) is the
// defect these records exist to prevent.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const queues = require('../lib/merge-queue-store');
const { REFUSALS } = require('../lib/merge-queue-state');

const OPERATOR = { kind: 'operator', operatorProof: 'verified-session' };
const OWNER = { kind: 'project', projectId: 7, launchId: 'launch-owner' };
const OTHER = { kind: 'project', projectId: 8, launchId: 'launch-other' };
const REPO = 'Jason-Vaughan/TangleClaw';

/**
 * A 40-character commit id made of one hex digit.
 * @param {string} digit - One hex digit
 * @returns {string}
 */
function sha(digit) {
  return digit.repeat(40);
}

let tmpDir = null;
let queueId = null;
let tick = 0;

/**
 * Submit a pull request to the test queue with every gate recorded.
 * @param {number} prNumber - Pull request number
 * @param {object} [overrides] - Fields to change in the submission
 * @returns {object} The store's answer
 */
function submit(prNumber, overrides = {}) {
  return queues.submitEntry({
    queueId,
    prNumber,
    headSha: sha('a'),
    gates: { review: 'critic rev-1', test: 'suite run 42', base: 'main e4dfaf47', operatorRequired: false },
    actor: OWNER,
    ...overrides
  });
}

/**
 * Take an entry from queued to testing with a candidate whose tree is `tree`.
 * @param {string} entryId - Entry id
 * @param {string} [tree] - The candidate's tree
 * @returns {object} The store's answer to recording the candidate
 */
function toTesting(entryId, tree = sha('d')) {
  assert.equal(queues.beginAssembly(entryId, { actor: OWNER }).ok, true);
  return queues.recordCandidate(entryId, { ref: `tc-queue/${entryId}`, baseSha: sha('b'), sha: sha('c'), tree, actor: OWNER });
}

/**
 * Take an entry from queued to landing.
 * @param {string} entryId - Entry id
 * @param {string} [tree] - The candidate's tree
 * @returns {object} The store's answer to starting the landing
 */
function toLanding(entryId, tree = sha('d')) {
  assert.equal(toTesting(entryId, tree).ok, true);
  return queues.beginLanding(entryId, { candidateCheck: { runId: 9001, conclusion: 'success' }, actor: OWNER });
}

/**
 * The event names of the test queue's history, in order.
 * @param {string} [entryId] - Only this entry's events
 * @returns {string[]}
 */
function history(entryId) {
  return queues.listEvents(queueId, entryId ? { entryId } : {}).map((e) => e.event);
}

/**
 * The number of rows in the three merge queue tables, to prove a refused
 * write changed nothing.
 * @returns {{queues: number, entries: number, events: number}}
 */
function counts() {
  const n = (table) => store.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return { queues: n('merge_queues'), entries: n('merge_queue_entries'), events: n('merge_queue_events') };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-merge-queue-'));
  store._setBasePath(tmpDir);
  store.init();
  tick = 0;
  queues._internal.now = () => new Date(Date.UTC(2026, 9, 12, 5, 0, tick++)).toISOString();
  queueId = queues.createQueue({ repo: REPO, baseBranch: 'main', ownerProjectId: 7, actor: OPERATOR }).queue.queueId;
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('merge queue store: making and retiring a queue (#2322)', () => {
  it('records which project owns the queue, who said so, how they were known, and when', () => {
    const queue = queues.getQueue(queueId);
    assert.equal(queue.repo, REPO);
    assert.equal(queue.baseBranch, 'main');
    assert.equal(queue.ownerProjectId, 7);
    assert.equal(queue.status, 'active');
    assert.deepEqual(queue.createdBy, { kind: 'operator', operatorProof: 'verified-session' });
    assert.equal(queue.createdAt, '2026-10-12T05:00:00.000Z');
    assert.equal(queue.halt, null);
    const [created] = queues.listEvents(queueId);
    assert.equal(created.event, 'queue-created');
    assert.equal(created.sequence, 1);
    assert.deepEqual(created.actor, { kind: 'operator', projectId: null, launchId: null, operatorProof: 'verified-session' });
    assert.deepEqual(created.detail, { repo: REPO, baseBranch: 'main', ownerProjectId: 7 });
  });

  it('lets only the Operator make a queue, and refuses an operator with no proof', () => {
    const before = counts();
    for (const actor of [OWNER, OTHER, { kind: 'operator' }, { kind: 'operator', operatorProof: '  ' }, null, undefined, 'operator']) {
      const answer = queues.createQueue({ repo: 'someone/else', baseBranch: 'main', ownerProjectId: 7, actor });
      assert.equal(answer.code, REFUSALS.OPERATOR_ONLY);
    }
    assert.deepEqual(counts(), before);
  });

  it('refuses a second active queue for the same repository and base, however the name is cased', () => {
    const before = counts();
    for (const repo of [REPO, REPO.toLowerCase(), REPO.toUpperCase()]) {
      const answer = queues.createQueue({ repo, baseBranch: 'main', ownerProjectId: 9, actor: OPERATOR });
      assert.equal(answer.code, REFUSALS.QUEUE_EXISTS);
      assert.equal(answer.queueId, queueId);
    }
    assert.deepEqual(counts(), before);
    assert.equal(queues.findActiveQueue(REPO.toLowerCase(), 'main').queueId, queueId);
  });

  it('allows another base branch of the same repository, and another repository', () => {
    assert.equal(queues.createQueue({ repo: REPO, baseBranch: 'v5-baseline', ownerProjectId: 7, actor: OPERATOR }).ok, true);
    assert.equal(queues.createQueue({ repo: 'Jason-Vaughan/Medusa', baseBranch: 'main', ownerProjectId: 7, actor: OPERATOR }).ok, true);
    assert.equal(queues.listQueues().length, 3);
  });

  it('refuses a repository, branch or owner that is not well formed', () => {
    const bad = [
      { repo: 'no-slash' }, { repo: 'a/b/c' }, { repo: '../etc' }, { repo: 'owner/na me' }, { repo: 42 },
      { baseBranch: '' }, { baseBranch: '-main' }, { baseBranch: 'a..b' }, { baseBranch: 'feature/' }, { baseBranch: 'has space' },
      { ownerProjectId: 0 }, { ownerProjectId: -1 }, { ownerProjectId: '7' }, { ownerProjectId: 1.5 }
    ];
    for (const change of bad) {
      const answer = queues.createQueue({ repo: 'someone/else', baseBranch: 'main', ownerProjectId: 7, actor: OPERATOR, ...change });
      assert.equal(answer.code, REFUSALS.INVALID_INPUT, JSON.stringify(change));
    }
    assert.equal(queues.listQueues().length, 1);
  });

  it('retires an empty queue on the Operator\'s word, after which the repository may have a new one', () => {
    assert.equal(queues.retireQueue(queueId, { actor: OWNER }).code, REFUSALS.OPERATOR_ONLY);
    const retired = queues.retireQueue(queueId, { actor: OPERATOR });
    assert.equal(retired.ok, true);
    assert.equal(retired.queue.status, 'retired');
    assert.ok(retired.queue.retiredAt);
    assert.deepEqual(history(), ['queue-created', 'queue-retired']);
    assert.equal(queues.findActiveQueue(REPO, 'main'), null);
    assert.equal(queues.retireQueue(queueId, { actor: OPERATOR }).code, REFUSALS.QUEUE_RETIRED);
    assert.equal(submit(1).code, REFUSALS.QUEUE_RETIRED);
    const again = queues.createQueue({ repo: REPO, baseBranch: 'main', ownerProjectId: 9, actor: OPERATOR });
    assert.equal(again.ok, true);
    assert.equal(queues.listQueues().length, 1);
    assert.equal(queues.listQueues({ includeRetired: true }).length, 2);
  });

  it('will not retire a queue that still has an unfinished entry', () => {
    const { entry } = submit(1);
    assert.equal(queues.retireQueue(queueId, { actor: OPERATOR }).code, REFUSALS.QUEUE_NOT_EMPTY);
    assert.equal(queues.withdrawEntry(entry.entryId, { reason: 'not now', actor: OWNER }).ok, true);
    assert.equal(queues.retireQueue(queueId, { actor: OPERATOR }).ok, true);
  });

  it('answers QUEUE_NOT_FOUND for a queue that does not exist', () => {
    assert.equal(queues.retireQueue('mq_nope', { actor: OPERATOR }).code, REFUSALS.QUEUE_NOT_FOUND);
    assert.equal(queues.clearHalt('mq_nope', { actor: OPERATOR, reference: 'x' }).code, REFUSALS.QUEUE_NOT_FOUND);
    assert.equal(submit(1, { queueId: 'mq_nope' }).code, REFUSALS.QUEUE_NOT_FOUND);
    assert.equal(queues.getQueue('mq_nope'), null);
  });
});

describe('merge queue store: submitting (#2322)', () => {
  it('records the pull request, its exact head, who submitted it from which launch, and each gate with its reference and time', () => {
    const answer = submit(2311, { gates: { review: 'critic rev-1', test: 'suite run 42', base: 'main e4dfaf47', operatorRequired: true } });
    assert.equal(answer.ok, true);
    const entry = queues.getEntry(answer.entry.entryId);
    assert.equal(entry.queueId, queueId);
    assert.equal(entry.prNumber, 2311);
    assert.equal(entry.headSha, sha('a'));
    assert.equal(entry.state, 'queued');
    assert.equal(entry.position, 1);
    assert.deepEqual(entry.submittedBy, { projectId: 7, launchId: 'launch-owner' });
    for (const [name, reference] of [['review', 'critic rev-1'], ['test', 'suite run 42'], ['base', 'main e4dfaf47']]) {
      assert.deepEqual(entry.gates[name], { status: 'recorded', reference, recordedAt: entry.createdAt });
    }
    assert.deepEqual(entry.gates.operator, { status: 'required', reference: null, operatorProof: null, recordedAt: null });
    assert.equal(entry.headCheck, null);
    assert.equal(entry.candidate, null);
    assert.equal(entry.landed, null);
    assert.equal(entry.failure, null);
    assert.equal(entry.finishedAt, null);
    const [event] = queues.listEvents(queueId, { entryId: entry.entryId });
    assert.equal(event.event, 'submitted');
    assert.equal(event.to, 'queued');
    assert.deepEqual(event.actor, { kind: 'project', projectId: 7, launchId: 'launch-owner', operatorProof: null });
    assert.equal(event.detail.headSha, sha('a'));
  });

  it('keeps what the queue itself read of the head\'s check apart from the owner\'s statement', () => {
    const { entry } = submit(1, { headCheck: { runId: 38203505726, conclusion: 'success', readAt: '2026-10-12T04:59:00.000Z' } });
    assert.deepEqual(entry.headCheck, { runId: '38203505726', conclusion: 'success', readAt: '2026-10-12T04:59:00.000Z' });
    assert.equal(entry.gates.test.reference, 'suite run 42');
    assert.equal(submit(2, { headCheck: { conclusion: 'success' } }).code, REFUSALS.INVALID_INPUT);
    assert.equal(submit(2, { headCheck: { runId: 5 } }).code, REFUSALS.INVALID_INPUT);
    for (const runId of [null, '', '  ', 0, -4, 1.5, true, {}, [7]]) {
      assert.equal(submit(2, { headCheck: { runId, conclusion: 'success' } }).code, REFUSALS.INVALID_INPUT, JSON.stringify(runId));
    }
    assert.equal(queues.listEntries(queueId).length, 1);
  });

  it('takes a submission only from a launch of the owner project', () => {
    const before = counts();
    assert.equal(submit(1, { actor: OTHER }).code, REFUSALS.NOT_OWNER);
    assert.equal(submit(1, { actor: OPERATOR }).code, REFUSALS.NOT_OWNER);
    assert.equal(submit(1, { actor: { kind: 'project', projectId: 7 } }).code, REFUSALS.INVALID_INPUT);
    assert.equal(submit(1, { actor: null }).code, REFUSALS.INVALID_INPUT);
    assert.deepEqual(counts(), before);
  });

  it('refuses a submission with a gate reference missing, blank or too long, naming the gate', () => {
    const before = counts();
    for (const name of ['review', 'test', 'base']) {
      for (const value of [undefined, '', '   ', 'x'.repeat(301), 7]) {
        const gates = { review: 'r', test: 't', base: 'b', operatorRequired: false, [name]: value };
        const answer = submit(1, { gates });
        assert.equal(answer.code, REFUSALS.GATE_REFERENCE_MISSING, `${name}=${JSON.stringify(value)}`);
        assert.equal(answer.gate, name);
      }
    }
    assert.equal(submit(1, { gates: { review: 'r', test: 't', base: 'b' } }).code, REFUSALS.INVALID_INPUT);
    assert.equal(submit(1, { gates: { review: 'r', test: 't', base: 'b', operatorRequired: 'no' } }).code, REFUSALS.INVALID_INPUT);
    assert.deepEqual(counts(), before);
  });

  it('refuses a head that is not a full lower-case commit id, and a pull request number that is not one', () => {
    for (const headSha of ['abc123', sha('A'), sha('g'), `${sha('a')}0`, '', undefined]) {
      assert.equal(submit(1, { headSha }).code, REFUSALS.INVALID_INPUT, String(headSha));
    }
    for (const prNumber of [0, -3, 1.5, '12', undefined]) {
      assert.equal(submit(prNumber).code, REFUSALS.INVALID_INPUT, String(prNumber));
    }
    assert.equal(queues.listEntries(queueId).length, 0);
  });

  it('refuses a second unfinished entry for the same pull request, and takes it again once the first is finished', () => {
    const first = submit(5);
    const again = submit(5, { headSha: sha('b') });
    assert.equal(again.code, REFUSALS.DUPLICATE_PR);
    assert.equal(again.entryId, first.entry.entryId);
    assert.equal(queues.listEntries(queueId).length, 1);
    assert.equal(queues.withdrawEntry(first.entry.entryId, { reason: 'new head coming', actor: OWNER }).ok, true);
    const third = submit(5, { headSha: sha('b') });
    assert.equal(third.ok, true);
    assert.equal(third.entry.position, 2);
  });

  it('still takes a submission while the queue is halted', () => {
    const { entry } = submit(1);
    assert.equal(toLanding(entry.entryId).ok, true);
    assert.equal(queues.recordLanded(entry.entryId, { landedSha: sha('e'), landedTree: sha('f'), actor: OWNER }).queueHalted, true);
    assert.equal(submit(2).ok, true);
  });
});

describe('merge queue store: order and one entry at a time (#2322)', () => {
  it('keeps submission order, and a withdrawal in the middle leaves the others where they were', () => {
    const a = submit(1).entry;
    const b = submit(2).entry;
    const c = submit(3).entry;
    assert.deepEqual(queues.listEntries(queueId).map((e) => [e.prNumber, e.position]), [[1, 1], [2, 2], [3, 3]]);
    assert.equal(queues.withdrawEntry(b.entryId, { reason: 'conflict found', actor: OWNER }).ok, true);
    assert.deepEqual(queues.listEntries(queueId, { includeFinished: false }).map((e) => [e.prNumber, e.position]), [[1, 1], [3, 3]]);
    assert.equal(queues.nextEntry(queueId).entryId, a.entryId);
    assert.equal(queues.withdrawEntry(a.entryId, { reason: 'also out', actor: OWNER }).ok, true);
    assert.equal(queues.nextEntry(queueId).entryId, c.entryId);
    assert.equal(submit(4).entry.position, 4);
    assert.deepEqual(queues.listEntries(queueId).map((e) => e.position), [1, 2, 3, 4]);
  });

  it('starts assembling only the entry at the front', () => {
    const a = submit(1).entry;
    const b = submit(2).entry;
    const refused = queues.beginAssembly(b.entryId, { actor: OWNER });
    assert.equal(refused.code, REFUSALS.NOT_FRONT);
    assert.equal(refused.frontEntryId, a.entryId);
    assert.equal(queues.getEntry(b.entryId).state, 'queued');
    assert.equal(queues.beginAssembly(a.entryId, { actor: OWNER }).ok, true);
  });

  it('never has two entries active: the second is refused in each active state of the first', () => {
    const a = submit(1).entry;
    const b = submit(2).entry;
    const steps = [
      () => queues.beginAssembly(a.entryId, { actor: OWNER }),
      () => queues.recordCandidate(a.entryId, { ref: 'tc-queue/a', baseSha: sha('b'), sha: sha('c'), tree: sha('d'), actor: OWNER }),
      () => queues.beginLanding(a.entryId, { candidateCheck: { runId: 1, conclusion: 'success' }, actor: OWNER })
    ];
    for (const step of steps) {
      assert.equal(step().ok, true);
      const refused = queues.beginAssembly(b.entryId, { actor: OWNER });
      assert.equal(refused.code, REFUSALS.QUEUE_BUSY);
      assert.equal(refused.activeEntryId, a.entryId);
      assert.equal(queues.nextEntry(queueId).entryId, a.entryId);
    }
    assert.equal(queues.getEntry(b.entryId).state, 'queued');
    assert.deepEqual(history(b.entryId), ['submitted']);
  });

  it('frees the queue for the next entry when the active one lands, fails or is withdrawn', () => {
    const a = submit(1).entry;
    const b = submit(2).entry;
    const c = submit(3).entry;
    const d = submit(4).entry;
    assert.equal(toLanding(a.entryId).ok, true);
    assert.equal(queues.recordLanded(a.entryId, { landedSha: sha('e'), landedTree: sha('d'), actor: OWNER }).ok, true);
    assert.equal(queues.beginAssembly(b.entryId, { actor: OWNER }).ok, true);
    assert.equal(queues.failEntry(b.entryId, { code: 'CONFLICT', detail: 'lib/store.js', actor: OWNER }).ok, true);
    assert.equal(toTesting(c.entryId).ok, true);
    assert.equal(queues.withdrawEntry(c.entryId, { reason: 'superseded', actor: OWNER }).ok, true);
    assert.equal(queues.beginAssembly(d.entryId, { actor: OWNER }).ok, true);
    assert.deepEqual(queues.listEntries(queueId).map((e) => e.state), ['landed', 'failed', 'withdrawn', 'assembling']);
  });
});

describe('merge queue store: an entry\'s path (#2322)', () => {
  it('walks queued, assembling, testing, landing, landed, with one event per change and the tree comparison recorded', () => {
    const { entry } = submit(1);
    assert.equal(toLanding(entry.entryId).ok, true);
    const landed = queues.recordLanded(entry.entryId, { landedSha: sha('e'), landedTree: sha('d'), landedAt: '2026-10-12T05:30:00.000Z', actor: OWNER });
    assert.equal(landed.ok, true);
    assert.equal(landed.treeMatches, true);
    assert.equal(landed.queueHalted, false);
    const after = queues.getEntry(entry.entryId);
    assert.equal(after.state, 'landed');
    assert.deepEqual(after.candidate, {
      ref: `tc-queue/${entry.entryId}`, baseSha: sha('b'), sha: sha('c'), tree: sha('d'), checkRunId: '9001', checkConclusion: 'success'
    });
    assert.deepEqual(after.landed, { sha: sha('e'), tree: sha('d'), treeMatches: true, at: '2026-10-12T05:30:00.000Z' });
    assert.ok(after.finishedAt);
    assert.equal(queues.getQueue(queueId).halt, null);
    const events = queues.listEvents(queueId, { entryId: entry.entryId });
    assert.deepEqual(events.map((e) => e.event), ['submitted', 'assembly-started', 'candidate-made', 'landing-started', 'landed']);
    assert.deepEqual(events.map((e) => [e.from, e.to]), [
      [null, 'queued'], ['queued', 'assembling'], ['assembling', 'testing'], ['testing', 'landing'], ['landing', 'landed']
    ]);
    for (const event of events) {
      assert.equal(event.actor.kind, 'project');
      assert.equal(event.actor.projectId, 7);
      assert.equal(event.actor.launchId, 'launch-owner');
      assert.ok(event.at);
    }
  });

  it('numbers a queue\'s events 1, 2, 3 with no gap across entries, and can read on from a sequence', () => {
    const a = submit(1).entry;
    submit(2);
    queues.beginAssembly(a.entryId, { actor: OWNER });
    const all = queues.listEvents(queueId);
    assert.deepEqual(all.map((e) => e.sequence), [1, 2, 3, 4]);
    assert.deepEqual(queues.listEvents(queueId, { afterSequence: 2 }).map((e) => e.sequence), [3, 4]);
    assert.deepEqual(queues.listEvents(queueId, { limit: 1 }).map((e) => e.sequence), [1]);
  });

  it('halts the queue in the same write when the landed tree is not the tested one, and still records the landing', () => {
    const a = submit(1).entry;
    const b = submit(2).entry;
    assert.equal(toLanding(a.entryId, sha('d')).ok, true);
    const landed = queues.recordLanded(a.entryId, { landedSha: sha('e'), landedTree: sha('f'), actor: OWNER });
    assert.equal(landed.ok, true);
    assert.equal(landed.treeMatches, false);
    assert.equal(landed.queueHalted, true);
    assert.equal(landed.entry.state, 'landed');
    assert.equal(landed.entry.landed.treeMatches, false);
    const halt = queues.getQueue(queueId).halt;
    assert.equal(halt.code, queues.HALT_TREE_MISMATCH);
    assert.match(halt.detail, new RegExp(sha('f')));
    assert.deepEqual(history().slice(-2), ['landed', 'queue-halted']);

    const refused = queues.beginAssembly(b.entryId, { actor: OWNER });
    assert.equal(refused.code, REFUSALS.QUEUE_HALTED);
    assert.equal(queues.getEntry(b.entryId).state, 'queued');
  });

  it('stays halted until the Operator clears it with a reference, and then advances again', () => {
    const a = submit(1).entry;
    const b = submit(2).entry;
    toLanding(a.entryId, sha('d'));
    queues.recordLanded(a.entryId, { landedSha: sha('e'), landedTree: sha('f'), actor: OWNER });
    assert.equal(queues.clearHalt(queueId, { actor: OWNER, reference: 'looked fine' }).code, REFUSALS.OPERATOR_ONLY);
    assert.equal(queues.clearHalt(queueId, { actor: OPERATOR }).code, REFUSALS.INVALID_INPUT);
    assert.ok(queues.getQueue(queueId).halt);
    const cleared = queues.clearHalt(queueId, { actor: OPERATOR, reference: 'main re-tested, run 77' });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.queue.halt, null);
    const last = queues.listEvents(queueId).pop();
    assert.equal(last.event, 'queue-halt-cleared');
    assert.equal(last.detail.reference, 'main re-tested, run 77');
    assert.equal(last.detail.code, queues.HALT_TREE_MISMATCH);
    assert.equal(queues.clearHalt(queueId, { actor: OPERATOR, reference: 'again' }).code, REFUSALS.QUEUE_NOT_HALTED);
    assert.equal(queues.beginAssembly(b.entryId, { actor: OWNER }).ok, true);
  });

  it('discards a candidate and assembles again when the base moved, keeping the entry\'s place', () => {
    const a = submit(1).entry;
    submit(2);
    assert.equal(toTesting(a.entryId).ok, true);
    assert.equal(queues.discardCandidate(a.entryId, { actor: OWNER }).code, REFUSALS.INVALID_INPUT);
    const discarded = queues.discardCandidate(a.entryId, { reason: 'main moved to 9f33a067', actor: OWNER });
    assert.equal(discarded.ok, true);
    assert.equal(discarded.entry.state, 'assembling');
    assert.equal(discarded.entry.candidate, null);
    assert.equal(discarded.entry.position, 1);
    const event = queues.listEvents(queueId, { entryId: a.entryId }).pop();
    assert.equal(event.event, 'candidate-discarded');
    assert.equal(event.detail.discarded.sha, sha('c'));
    assert.equal(queues.recordCandidate(a.entryId, { ref: 'tc-queue/a2', baseSha: sha('1'), sha: sha('2'), tree: sha('3'), actor: OWNER }).ok, true);
    assert.equal(queues.beginLanding(a.entryId, { candidateCheck: { runId: 2, conclusion: 'success' }, actor: OWNER }).ok, true);
    const fromLanding = queues.discardCandidate(a.entryId, { reason: 'main moved again', actor: OWNER });
    assert.equal(fromLanding.entry.state, 'assembling');
    assert.equal(fromLanding.entry.candidate, null);
  });

  it('goes back to testing with its candidate when the merge was not made', () => {
    const { entry } = submit(1);
    assert.equal(toLanding(entry.entryId).ok, true);
    assert.equal(queues.recordLandingNotMade(entry.entryId, { actor: OWNER }).code, REFUSALS.INVALID_INPUT);
    const back = queues.recordLandingNotMade(entry.entryId, { reason: 'merge refused: head moved', actor: OWNER });
    assert.equal(back.ok, true);
    assert.equal(back.entry.state, 'testing');
    assert.equal(back.entry.candidate.sha, sha('c'));
    assert.equal(history(entry.entryId).pop(), 'landing-not-made');
  });

  it('records why an entry failed, cutting a detail longer than the record holds', () => {
    const { entry } = submit(1);
    queues.beginAssembly(entry.entryId, { actor: OWNER });
    assert.equal(queues.failEntry(entry.entryId, { actor: OWNER }).code, REFUSALS.INVALID_INPUT);
    assert.equal(queues.failEntry(entry.entryId, { code: 'has space', actor: OWNER }).code, REFUSALS.INVALID_INPUT);
    assert.equal(queues.getEntry(entry.entryId).state, 'assembling');
    const failed = queues.failEntry(entry.entryId, { code: 'CONFLICT', detail: 'x'.repeat(1500), actor: OWNER });
    assert.equal(failed.ok, true);
    assert.equal(failed.entry.state, 'failed');
    assert.equal(failed.entry.failure.code, 'CONFLICT');
    assert.equal(failed.entry.failure.detail.length, 1000);
    assert.ok(failed.entry.finishedAt);
    assert.equal(history(entry.entryId).pop(), 'failed');
  });

  it('still fails an entry when its detail is too long for the history once escaped, and says the detail was left out', () => {
    const { entry } = submit(1);
    queues.beginAssembly(entry.entryId, { actor: OWNER });
    // 1000 characters in the column; each becomes six in JSON.
    const failed = queues.failEntry(entry.entryId, { code: 'CONFLICT', detail: `a${'\u0001'.repeat(998)}b`, actor: OWNER });
    assert.equal(failed.ok, true);
    assert.equal(failed.entry.state, 'failed');
    assert.equal(failed.entry.failure.detail.length, 1000);
    const event = queues.listEvents(queueId, { entryId: entry.entryId }).pop();
    assert.equal(event.event, 'failed');
    assert.equal(event.detail.omitted, 'detail too long to record');
    assert.ok(event.detail.length > 4096);
  });

  it('records why an entry was withdrawn, and refuses a withdrawal once landing has started', () => {
    const a = submit(1).entry;
    assert.equal(queues.withdrawEntry(a.entryId, { actor: OWNER }).code, REFUSALS.INVALID_INPUT);
    const withdrawn = queues.withdrawEntry(a.entryId, { reason: 'Builder found a bug', actor: OWNER });
    assert.equal(withdrawn.entry.state, 'withdrawn');
    assert.equal(withdrawn.entry.withdrawnReason, 'Builder found a bug');
    const b = submit(2).entry;
    assert.equal(toLanding(b.entryId).ok, true);
    const refused = queues.withdrawEntry(b.entryId, { reason: 'too late', actor: OWNER });
    assert.equal(refused.code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.getEntry(b.entryId).state, 'landing');
  });

  it('refuses every move the state machine does not list, changing nothing', () => {
    const { entry } = submit(1);
    const id = entry.entryId;
    const candidate = { ref: 'tc-queue/x', baseSha: sha('b'), sha: sha('c'), tree: sha('d'), actor: OWNER };
    const landing = { candidateCheck: { runId: 1, conclusion: 'success' }, actor: OWNER };
    const landed = { landedSha: sha('e'), landedTree: sha('d'), actor: OWNER };
    const before = counts();
    assert.equal(queues.recordCandidate(id, candidate).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.beginLanding(id, landing).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.recordLanded(id, landed).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.discardCandidate(id, { reason: 'r', actor: OWNER }).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.recordLandingNotMade(id, { reason: 'r', actor: OWNER }).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.deepEqual(counts(), before);

    queues.beginAssembly(id, { actor: OWNER });
    assert.equal(queues.beginAssembly(id, { actor: OWNER }).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.beginLanding(id, landing).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.recordLanded(id, landed).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.recordLandingNotMade(id, { reason: 'r', actor: OWNER }).code, REFUSALS.TRANSITION_NOT_ALLOWED);

    queues.recordCandidate(id, candidate);
    assert.equal(queues.beginAssembly(id, { actor: OWNER }).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.recordCandidate(id, candidate).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.recordLanded(id, landed).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.getEntry(id).candidate.sha, sha('c'));

    queues.beginLanding(id, landing);
    assert.equal(queues.recordCandidate(id, { ...candidate, sha: sha('9') }).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.beginAssembly(id, { actor: OWNER }).code, REFUSALS.TRANSITION_NOT_ALLOWED);
    assert.equal(queues.getEntry(id).candidate.sha, sha('c'));

    queues.recordLanded(id, landed);
    const finished = counts();
    for (const attempt of [
      () => queues.beginAssembly(id, { actor: OWNER }),
      () => queues.recordCandidate(id, candidate),
      () => queues.beginLanding(id, landing),
      () => queues.recordLanded(id, landed),
      () => queues.failEntry(id, { code: 'LATE', actor: OWNER }),
      () => queues.withdrawEntry(id, { reason: 'late', actor: OWNER }),
      () => queues.discardCandidate(id, { reason: 'late', actor: OWNER }),
      () => queues.recordLandingNotMade(id, { reason: 'late', actor: OWNER })
    ]) {
      const answer = attempt();
      assert.equal(answer.ok, false);
      assert.ok([REFUSALS.ENTRY_FINISHED, REFUSALS.TRANSITION_NOT_ALLOWED].includes(answer.code), answer.code);
    }
    assert.deepEqual(counts(), finished);
    assert.equal(queues.getEntry(id).state, 'landed');
  });

  it('lets nobody but a launch of the owner project move an entry', () => {
    const { entry } = submit(1);
    const id = entry.entryId;
    for (const actor of [OTHER, OPERATOR]) {
      assert.equal(queues.beginAssembly(id, { actor }).code, REFUSALS.NOT_OWNER);
      assert.equal(queues.failEntry(id, { code: 'X', actor }).code, REFUSALS.NOT_OWNER);
      assert.equal(queues.withdrawEntry(id, { reason: 'r', actor }).code, REFUSALS.NOT_OWNER);
    }
    assert.equal(queues.beginAssembly(id, {}).code, REFUSALS.INVALID_INPUT);
    assert.equal(queues.getEntry(id).state, 'queued');
    assert.deepEqual(history(id), ['submitted']);
    assert.equal(queues.beginAssembly('mqe_nope', { actor: OWNER }).code, REFUSALS.ENTRY_NOT_FOUND);
    assert.equal(queues.getEntry('mqe_nope'), null);
  });

  it('refuses a candidate or a landing whose ids are not full commit ids', () => {
    const { entry } = submit(1);
    queues.beginAssembly(entry.entryId, { actor: OWNER });
    const good = { ref: 'tc-queue/x', baseSha: sha('b'), sha: sha('c'), tree: sha('d'), actor: OWNER };
    for (const change of [{ ref: '' }, { baseSha: 'abc' }, { sha: undefined }, { tree: sha('Z') }]) {
      assert.equal(queues.recordCandidate(entry.entryId, { ...good, ...change }).code, REFUSALS.INVALID_INPUT, JSON.stringify(change));
    }
    queues.recordCandidate(entry.entryId, good);
    assert.equal(queues.beginLanding(entry.entryId, { actor: OWNER }).code, REFUSALS.INVALID_INPUT);
    queues.beginLanding(entry.entryId, { candidateCheck: { runId: 1, conclusion: 'success' }, actor: OWNER });
    assert.equal(queues.recordLanded(entry.entryId, { landedSha: 'e', landedTree: sha('d'), actor: OWNER }).code, REFUSALS.INVALID_INPUT);
    assert.equal(queues.recordLanded(entry.entryId, { landedSha: sha('e'), actor: OWNER }).code, REFUSALS.INVALID_INPUT);
    assert.equal(queues.getEntry(entry.entryId).state, 'landing');
  });
});

describe('merge queue store: gates at landing (#2322)', () => {
  it('will not start landing unless the candidate\'s check concluded success', () => {
    const { entry } = submit(1);
    toTesting(entry.entryId);
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'SUCCESS']) {
      const answer = queues.beginLanding(entry.entryId, { candidateCheck: { runId: 1, conclusion }, actor: OWNER });
      assert.equal(answer.code, REFUSALS.CANDIDATE_NOT_GREEN, conclusion);
    }
    assert.equal(queues.getEntry(entry.entryId).state, 'testing');
    assert.equal(queues.getEntry(entry.entryId).candidate.checkConclusion, null);
    for (const runId of [null, undefined, '', 0, {}]) {
      const answer = queues.beginLanding(entry.entryId, { candidateCheck: { runId, conclusion: 'success' }, actor: OWNER });
      assert.equal(answer.code, REFUSALS.INVALID_INPUT, JSON.stringify(runId));
    }
    assert.equal(queues.getEntry(entry.entryId).state, 'testing');
  });

  it('holds an entry that needs the Operator gate until the Operator records it, and only the Operator can', () => {
    const { entry } = submit(1, { gates: { review: 'r', test: 't', base: 'b', operatorRequired: true } });
    const id = entry.entryId;
    toTesting(id);
    const held = queues.beginLanding(id, { candidateCheck: { runId: 1, conclusion: 'success' }, actor: OWNER });
    assert.equal(held.code, REFUSALS.GATES_NOT_MET);
    assert.deepEqual(held.problems.map((p) => [p.gate, p.code]), [['operator', REFUSALS.OPERATOR_GATE_OPEN]]);
    assert.equal(queues.getEntry(id).state, 'testing');

    for (const actor of [OWNER, OTHER, { kind: 'operator' }, null]) {
      assert.equal(queues.recordOperatorGate(id, { reference: 'the Operator said yes', actor }).code, REFUSALS.OPERATOR_ONLY);
    }
    assert.equal(queues.recordOperatorGate(id, { actor: OPERATOR }).code, REFUSALS.GATE_REFERENCE_MISSING);
    assert.equal(queues.getEntry(id).gates.operator.status, 'required');

    const recorded = queues.recordOperatorGate(id, { reference: 'pane, 21:15 PDT', actor: OPERATOR });
    assert.equal(recorded.ok, true);
    assert.deepEqual(
      { ...recorded.entry.gates.operator, recordedAt: Boolean(recorded.entry.gates.operator.recordedAt) },
      { status: 'recorded', reference: 'pane, 21:15 PDT', operatorProof: 'verified-session', recordedAt: true }
    );
    const event = queues.listEvents(queueId, { entryId: id }).pop();
    assert.equal(event.event, 'operator-gate-recorded');
    assert.equal(event.actor.kind, 'operator');
    assert.equal(event.actor.operatorProof, 'verified-session');
    assert.equal(queues.recordOperatorGate(id, { reference: 'again', actor: OPERATOR }).code, REFUSALS.OPERATOR_GATE_ALREADY_RECORDED);
    assert.equal(queues.beginLanding(id, { candidateCheck: { runId: 1, conclusion: 'success' }, actor: OWNER }).ok, true);
  });

  it('refuses an Operator gate on an entry that did not need one, on a finished entry, and on one that does not exist', () => {
    const a = submit(1).entry;
    assert.equal(queues.recordOperatorGate(a.entryId, { reference: 'x', actor: OPERATOR }).code, REFUSALS.OPERATOR_GATE_NOT_REQUIRED);
    const b = submit(2, { gates: { review: 'r', test: 't', base: 'b', operatorRequired: true } }).entry;
    queues.withdrawEntry(b.entryId, { reason: 'gone', actor: OWNER });
    assert.equal(queues.recordOperatorGate(b.entryId, { reference: 'x', actor: OPERATOR }).code, REFUSALS.ENTRY_FINISHED);
    assert.equal(queues.recordOperatorGate('mqe_nope', { reference: 'x', actor: OPERATOR }).code, REFUSALS.ENTRY_NOT_FOUND);
  });

  it('reads the gates from the record at landing time, so a gate that no longer reads as recorded stops the landing', () => {
    const { entry } = submit(1);
    toTesting(entry.entryId);
    store.getDb().prepare("UPDATE merge_queue_entries SET review_gate_status = 'missing' WHERE entry_id = ?").run(entry.entryId);
    const answer = queues.beginLanding(entry.entryId, { candidateCheck: { runId: 1, conclusion: 'success' }, actor: OWNER });
    assert.equal(answer.code, REFUSALS.GATES_NOT_MET);
    assert.equal(answer.problems[0].gate, 'review');
    assert.equal(queues.getEntry(entry.entryId).state, 'testing');
  });
});

describe('merge queue store: a change and its event land together (#2322)', () => {
  it('has exactly one event for every state an entry has been in', () => {
    const a = submit(1).entry;
    const b = submit(2).entry;
    toLanding(a.entryId);
    queues.recordLandingNotMade(a.entryId, { reason: 'not merged', actor: OWNER });
    queues.discardCandidate(a.entryId, { reason: 'base moved', actor: OWNER });
    queues.failEntry(a.entryId, { code: 'CONFLICT', actor: OWNER });
    queues.withdrawEntry(b.entryId, { reason: 'r', actor: OWNER });
    for (const entry of [a, b]) {
      const moves = queues.listEvents(queueId, { entryId: entry.entryId }).filter((e) => e.to);
      let current = null;
      for (const move of moves) {
        assert.equal(move.from, current, `event ${move.sequence} starts from ${move.from}, but the entry was ${current}`);
        current = move.to;
      }
      assert.equal(current, queues.getEntry(entry.entryId).state);
    }
  });

  it('writes neither the change nor the event when the event cannot be written', () => {
    const { entry } = submit(1);
    const db = store.getDb();
    db.exec("CREATE TRIGGER test_refuse_events BEFORE INSERT ON merge_queue_events BEGIN SELECT RAISE(ABORT, 'no events today'); END;");
    const before = counts();
    assert.throws(() => queues.beginAssembly(entry.entryId, { actor: OWNER }), /no events today/);
    assert.throws(() => submit(2), /no events today/);
    assert.throws(() => queues.createQueue({ repo: 'a/b', baseBranch: 'main', ownerProjectId: 7, actor: OPERATOR }), /no events today/);
    assert.deepEqual(counts(), before);
    assert.equal(queues.getEntry(entry.entryId).state, 'queued');
    db.exec('DROP TRIGGER test_refuse_events');
    assert.equal(queues.beginAssembly(entry.entryId, { actor: OWNER }).ok, true);
  });

  it('writes neither the event nor the change when the change cannot be written', () => {
    const { entry } = submit(1);
    const db = store.getDb();
    db.exec("CREATE TRIGGER test_refuse_entries BEFORE UPDATE ON merge_queue_entries BEGIN SELECT RAISE(ABORT, 'no changes today'); END;");
    const before = counts();
    assert.throws(() => queues.beginAssembly(entry.entryId, { actor: OWNER }), /no changes today/);
    assert.deepEqual(counts(), before);
    db.exec('DROP TRIGGER test_refuse_entries');
    assert.deepEqual(history(entry.entryId), ['submitted']);
  });

  it('leaves the transaction closed after a refusal, so the next write works', () => {
    assert.equal(submit(1, { actor: OTHER }).ok, false);
    assert.equal(submit(1).ok, true);
    assert.equal(store.getDb().isTransaction, false);
  });
});

describe('merge queue store: the owner\'s inbox check a landing records (#2372)', () => {
  const INBOX = {
    binding: { projectId: 7, launchId: 'launch-owner', sessionId: 41 },
    checkedAt: '2026-10-15T23:00:00.000Z', listenerState: 'listening', systemExcluded: 1
  };

  /**
   * The detail of an entry's `landing-started` event.
   * @param {string} entryId - The entry
   * @returns {object|undefined}
   */
  function startedDetail(entryId) {
    const started = queues.listEvents(queues.getEntry(entryId).queueId, { entryId }).find((e) => e.event === 'landing-started');
    return started && started.detail;
  }

  it('records the check with the head, the candidate\'s base and the candidate', () => {
    const { entry } = submit(1);
    toTesting(entry.entryId);
    const answer = queues.beginLanding(entry.entryId, { candidateCheck: { runId: 9001, conclusion: 'success' }, inboxCheck: INBOX, actor: OWNER });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.deepEqual(startedDetail(entry.entryId), {
      headSha: entry.headSha, baseSha: sha('b'), candidateSha: sha('c'), candidateCheck: { runId: '9001', conclusion: 'success' }, inboxCheck: INBOX
    });
  });

  it('keeps only the named fields of a check, so nothing else it carries reaches the record', () => {
    const { entry } = submit(1);
    toTesting(entry.entryId);
    const carried = { ...INBOX, blocking: [{ id: 'msg-1', from: 'tc-pm-1', message: 'do not merge' }], binding: { ...INBOX.binding, extra: 'x' } };
    assert.equal(queues.beginLanding(entry.entryId, { candidateCheck: { runId: 1, conclusion: 'success' }, inboxCheck: carried, actor: OWNER }).ok, true);
    assert.deepEqual(startedDetail(entry.entryId).inboxCheck, INBOX);
  });

  it('refuses a check that is not well formed, and changes nothing', () => {
    const { entry } = submit(1);
    toTesting(entry.entryId);
    const before = queues.listEvents(queues.getEntry(entry.entryId).queueId).length;
    for (const bad of [null, 'clear', {}, { ...INBOX, binding: null }, { ...INBOX, binding: { ...INBOX.binding, sessionId: '41' } },
      { ...INBOX, binding: { ...INBOX.binding, launchId: '' } }, { ...INBOX, checkedAt: '' }, { ...INBOX, listenerState: undefined },
      { ...INBOX, systemExcluded: -1 }, { ...INBOX, systemExcluded: 1.5 }]) {
      const answer = queues.beginLanding(entry.entryId, { candidateCheck: { runId: 1, conclusion: 'success' }, inboxCheck: bad, actor: OWNER });
      assert.equal(answer.code, REFUSALS.INVALID_INPUT, JSON.stringify(bad));
    }
    assert.equal(queues.getEntry(entry.entryId).state, 'testing');
    assert.equal(queues.listEvents(queues.getEntry(entry.entryId).queueId).length, before);
  });
});
