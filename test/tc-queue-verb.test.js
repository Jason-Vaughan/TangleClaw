'use strict';

// #2322: `tc queue`. The verb reads the queue for anyone who may, and submits
// or withdraws for the owner; the server decides who that is. Each answer and
// each refusal is rendered in words a session can act on, and a malformed
// command is refused before any request.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  VERB_ROSTER, QUEUE_SUBVERBS, verbsFor, renderUsage, renderQueueStatus, renderQueueEntry, renderQueueRefusal, receiptVerbLabel
} = require('../lib/tc-verbs');

const queue = VERB_ROSTER.find((v) => v.id === 'queue');
const HEAD = 'a'.repeat(40);

/**
 * An entry as the merge queue API returns it.
 * @param {object} [over] - Fields to replace
 * @returns {object}
 */
function entry(over = {}) {
  const gate = (reference) => ({ status: 'recorded', reference, recordedAt: '2026-10-12T10:00:00.000Z', source: 'owner-statement' });
  return {
    entryId: 'mqe_1111111111111111', queueId: 'mq_1', prNumber: 2340, headSha: HEAD, position: 1, state: 'queued',
    gates: {
      review: gate('msg 1a2b'), test: gate('run 77'), base: gate('main c0ffee'),
      operator: { status: 'not-required', reference: null, operatorProof: null, recordedAt: null, source: 'operator-record' }
    },
    headCheck: { runId: '9001', conclusion: 'success', readAt: '2026-10-12T10:00:00.000Z', name: 'test', source: 'queue-read' },
    submittedBy: { projectId: 7 }, candidate: null, landed: null, failure: null, withdrawnReason: null, openGates: [],
    ...over
  };
}

const QUEUE = { queueId: 'mq_1', repo: 'Jason-Vaughan/TangleClaw', baseBranch: 'main', ownerProjectId: 7, ownerProjectName: 'integrator', status: 'active', halt: null };

/**
 * A fake tc context recording every request.
 * @param {string[]} argv - Arguments after `queue`
 * @param {object} [answers] - `{ get, post }`: what each call answers, or an error to throw
 * @returns {{ctx: object, calls: object[]}}
 */
function fakeCtx(argv, answers = {}) {
  const calls = [];
  const give = (answer) => { if (answer instanceof Error) throw answer; return answer; };
  const ctx = {
    argv,
    env: {},
    getJson: async (p) => { calls.push(['GET', p]); return give(answers.get); },
    postJson: async (p, body) => { calls.push(['POST', p, body]); return give(answers.post); }
  };
  return { ctx, calls };
}

/**
 * The error `bin/tc` throws for a refused request.
 * @param {object} body - The server's error body
 * @returns {Error}
 */
function refused(body) {
  return Object.assign(new Error(body.error), { body });
}

describe('tc queue (#2322)', () => {
  it('is in the roster and in the usage, and not in the list every pane is primed with', () => {
    assert.ok(queue);
    assert.deepEqual(QUEUE_SUBVERBS, ['status', 'submit', 'show', 'withdraw']);
    assert.match(renderUsage(), /tc queue status \| submit <pr> --head <sha>/);
    assert.ok(!verbsFor('pane').some((v) => v.id === 'queue'));
    assert.ok(verbsFor('unprimed').some((v) => v.id === 'queue'));
    assert.equal(receiptVerbLabel('queue', ['submit']), 'queue.submit');
    assert.equal(receiptVerbLabel('queue', ['bogus']), 'queue');
  });

  it('rejects a missing or unknown subverb and malformed arguments before any request', async () => {
    const bad = [
      [], ['bogus'], ['status', 'extra'], ['show'], ['show', 'a', 'b'],
      ['withdraw'], ['withdraw', 'mqe_1'], ['withdraw', 'mqe_1', '--reason'], ['withdraw', '--reason', 'x'], ['withdraw', 'mqe_1', '--why', 'x'],
      ['submit'], ['submit', 'abc', '--head', HEAD], ['submit', '0', '--head', HEAD], ['submit', '-3'],
      ['submit', '12', '--head', HEAD, '--review', 'r', '--test', 't'],
      ['submit', '12', '--head', HEAD, '--review', 'r', '--test', 't', '--base'],
      ['submit', '12', '--head', HEAD, '--review', 'r', '--test', 't', '--base', 'b', '--force', 'yes'],
      ['submit', '12', '--head', HEAD, '--head', HEAD, '--review', 'r', '--test', 't', '--base', 'b'],
      ['submit', '12', '--head', HEAD, '--review', 'r', '--test', 't', '--base', 'b', '--operator-gate', 'maybe']
    ];
    for (const argv of bad) {
      const { ctx, calls } = fakeCtx(argv);
      const r = await queue.run(ctx);
      assert.equal(r.code, 1, argv.join(' '));
      assert.match(r.stderr, /usage: tc queue/, argv.join(' '));
      assert.equal(calls.length, 0, argv.join(' '));
    }
  });

  it('status shows order, each entry\'s state and gates, and whose word each one is', async () => {
    const data = {
      queues: [{
        ...QUEUE, youAreOwner: true, nextEntryId: 'mqe_1111111111111111',
        entries: [
          entry(),
          entry({
            entryId: 'mqe_2222222222222222', prNumber: 2341, position: 2,
            gates: { ...entry().gates, operator: { status: 'required', reference: null, source: 'operator-record' } }
          })
        ]
      }]
    };
    const { ctx, calls } = fakeCtx(['status'], { get: data });
    const r = await queue.run(ctx);
    assert.equal(r.code, 0);
    assert.deepEqual(calls, [['GET', '/api/merge-queue']]);
    const out = r.stdout;
    assert.match(out, /Merge queue mq_1: Jason-Vaughan\/TangleClaw onto main, owned by integrator \(project 7\), which is this project\./);
    assert.ok(out.indexOf('1. mqe_1111111111111111') < out.indexOf('2. mqe_2222222222222222'), 'entries are in queue order');
    assert.match(out, new RegExp(`1\\. mqe_1111111111111111: PR #2340 at ${HEAD}, queued \\(next\\)`));
    assert.match(out, /2\. mqe_2222222222222222: PR #2341 at a+, queued\n/);
    assert.match(out, /review gate: recorded, "msg 1a2b" \(the owner's statement\)/);
    assert.match(out, /test gate: recorded, "run 77" \(the owner's statement\)/);
    assert.match(out, /base gate: recorded, "main c0ffee" \(the owner's statement\)/);
    assert.match(out, /operator gate: not required for this entry \(the Operator's record\)/);
    assert.match(out, /operator gate: REQUIRED and not recorded yet: only the Operator records it/);
    assert.match(out, /test check on the head: success, run 9001 \(read by the queue from GitHub\)/);
  });

  it('status says plainly when there is no queue to read, when a queue is empty and when it is halted', () => {
    assert.match(renderQueueStatus({ queues: [] }), /No merge queue is readable from this pane/);
    assert.match(renderQueueStatus(undefined), /No merge queue is readable/);
    const empty = renderQueueStatus({ queues: [{ ...QUEUE, youAreOwner: false, nextEntryId: null, entries: [] }] });
    assert.match(empty, /Nothing is waiting\./);
    assert.ok(!empty.includes('which is this project'));
    const halted = renderQueueStatus({
      queues: [{ ...QUEUE, entries: [], halt: { at: '2026-10-12T10:00:00.000Z', code: 'TREE_MISMATCH', detail: 'landed tree differs' } }]
    });
    assert.match(halted, /HALTED \[TREE_MISMATCH\].*landed tree differs.*until the Operator clears it/);
  });

  it('show renders an entry with its candidate, its end and its history', async () => {
    const data = {
      queue: QUEUE,
      entry: entry({
        state: 'withdrawn', withdrawnReason: 'new head',
        candidate: { ref: 'tc-queue/mqe_1111111111111111', sha: 'd'.repeat(40), baseSha: 'c'.repeat(40) },
        gates: { ...entry().gates, operator: { status: 'recorded', reference: 'pane, 03:40', source: 'operator-record' } }
      }),
      events: [
        { sequence: 2, event: 'submitted', from: null, to: 'queued', actor: { kind: 'project', projectId: 7 }, at: '2026-10-12T10:00:00.000Z' },
        { sequence: 3, event: 'operator-gate-recorded', from: null, to: null, actor: { kind: 'operator', projectId: null }, at: '2026-10-12T10:01:00.000Z' },
        { sequence: 4, event: 'withdrawn', from: 'queued', to: 'withdrawn', actor: { kind: 'project', projectId: 7 }, at: '2026-10-12T10:02:00.000Z' }
      ]
    };
    const { ctx, calls } = fakeCtx(['show', 'mqe_1111111111111111'], { get: data });
    const r = await queue.run(ctx);
    assert.equal(r.code, 0);
    assert.deepEqual(calls, [['GET', '/api/merge-queue/entries/mqe_1111111111111111']]);
    assert.match(r.stdout, /candidate: tc-queue\/mqe_1111111111111111 at d+, on base c+/);
    assert.match(r.stdout, /operator gate: recorded, "pane, 03:40"/);
    assert.match(r.stdout, /withdrawn: new head/);
    assert.match(r.stdout, /submitted \(queued\), by project 7/);
    assert.match(r.stdout, /operator-gate-recorded, by the Operator/);
    assert.match(r.stdout, /withdrawn \(queued to withdrawn\), by project 7/);
    const failed = renderQueueEntry({ queue: QUEUE, entry: entry({ state: 'failed', failure: { code: 'CONFLICT', detail: 'merge conflict' }, headCheck: null }), events: [] });
    assert.match(failed, /failed: \[CONFLICT\] merge conflict/);
    assert.match(failed, /check on the head: not read by the queue/);
    const landed = renderQueueEntry({ queue: QUEUE, entry: entry({ state: 'landed', landed: { sha: 'f'.repeat(40), treeMatches: false } }), events: [] });
    assert.match(landed, /landed as f+ \(ITS TREE IS NOT THE TESTED ONE\)/);
  });

  it('show puts an id it cannot trust into the path encoded', async () => {
    const { ctx, calls } = fakeCtx(['show', '../control/mine'], { get: refused({ code: 'INVALID_INPUT', error: 'That is not a merge queue entry id.' }) });
    const r = await queue.run(ctx);
    assert.equal(calls[0][1], '/api/merge-queue/entries/..%2Fcontrol%2Fmine');
    assert.equal(r.code, 2);
  });

  it('submit sends the exact head and every gate, with the Operator gate not required unless asked', async () => {
    const answer = { entry: entry({ position: 3 }), queue: QUEUE };
    const args = ['submit', '2340', '--head', HEAD, '--review', 'msg 1a2b', '--test', 'run 77', '--base', 'main c0ffee'];
    const plain = fakeCtx(args, { post: answer });
    const r = await queue.run(plain.ctx);
    assert.equal(r.code, 0);
    assert.deepEqual(plain.calls, [['POST', '/api/merge-queue/entries', {
      prNumber: 2340, headSha: HEAD, gates: { review: 'msg 1a2b', test: 'run 77', base: 'main c0ffee' }, operatorGate: 'none'
    }]]);
    assert.match(r.stdout, new RegExp(`Queued: entry mqe_1111111111111111, PR #2340 at ${HEAD}, position 3 in mq_1\\.`));
    assert.match(r.stdout, /Nothing lands yet/);
    assert.ok(!r.stdout.includes('Operator gate'));

    const gated = fakeCtx([...args, '--operator-gate', 'required', '--queue', 'mq_1'], {
      post: { entry: entry({ gates: { ...entry().gates, operator: { status: 'required', source: 'operator-record' } } }), queue: QUEUE }
    });
    const g = await queue.run(gated.ctx);
    assert.equal(gated.calls[0][2].operatorGate, 'required');
    assert.equal(gated.calls[0][2].queueId, 'mq_1');
    assert.match(g.stdout, /cannot land until the Operator records the Operator gate/);
  });

  it('withdraw sends the reason and says what happened to the candidate\'s branches', async () => {
    const plain = fakeCtx(['withdraw', 'mqe_1111111111111111', '--reason', 'new head'], { post: { entry: entry({ state: 'withdrawn' }), branches: null } });
    const r = await queue.run(plain.ctx);
    assert.equal(r.code, 0);
    assert.deepEqual(plain.calls, [['POST', '/api/merge-queue/entries/mqe_1111111111111111/withdraw', { reason: 'new head' }]]);
    assert.equal(r.stdout, 'Withdrawn: entry mqe_1111111111111111 (PR #2340) is out of the queue.\n');
    const withBranches = fakeCtx(['withdraw', 'mqe_1111111111111111', '--reason', 'x'], {
      post: { entry: entry({ state: 'withdrawn' }), branches: { candidate: 'deleted', stage: 'not-found' } }
    });
    assert.match((await queue.run(withBranches.ctx)).stdout, /Its candidate branch was deleted and its stage branch not-found\./);
  });

  it('renders each refusal with its code, the server\'s words and the facts to act on, and exits 2', async () => {
    const cases = [
      [['status'], 'get', { code: 'CALLER_NOT_VERIFIED', error: 'The merge queue answers only the Operator or a verified launch.' }, []],
      [['show', 'mqe_x'], 'get', { code: 'ENTRY_NOT_FOUND', error: 'No such merge queue entry.' }, []],
      [['submit', '12', '--head', HEAD, '--review', 'r', '--test', 't', '--base', 'b'], 'post',
        { code: 'RELEASE_TRIGGER_CHANGED', error: 'Pull request 12 changes version.json.', paths: ['version.json'] }, ['paths: version.json']],
      [['submit', '12', '--head', HEAD, '--review', 'r', '--test', 't', '--base', 'b'], 'post',
        { code: 'DUPLICATE_PR', error: 'Pull request 12 already has an unfinished entry.', entryId: 'mqe_9' }, ['entry: mqe_9']],
      [['submit', '12', '--head', HEAD, '--review', 'r', '--test', 't', '--base', 'b'], 'post',
        { code: 'QUEUE_AMBIGUOUS', error: 'Name the one you mean.', queueIds: ['mq_1', 'mq_2'] }, ['queues: mq_1, mq_2']],
      [['submit', '12', '--head', HEAD, '--review', 'r', '--test', 't', '--base', 'b'], 'post',
        { code: 'NOT_OWNER', error: 'Only a verified launch of project 7 may submit to it.' }, []],
      [['submit', '12', '--head', HEAD, '--review', 'r', '--test', 't', '--base', 'b'], 'post',
        { code: 'CONTROL_HELD', error: 'this lane is on HOLD' }, []],
      [['withdraw', 'mqe_1', '--reason', 'x'], 'post',
        { code: 'CANDIDATE_NOT_DISCARDED', error: 'The entry is not withdrawn. Withdraw again.', candidate: 'deleted', stage: 'unknown' },
        ['candidate branch: deleted; stage branch: unknown']]
    ];
    for (const [argv, method, body, facts] of cases) {
      const { ctx } = fakeCtx(argv, { [method]: refused(body) });
      const r = await queue.run(ctx);
      assert.equal(r.code, 2, body.code);
      assert.ok(r.stderr.startsWith(`tc: queue ${argv[0]} refused [${body.code}] — ${body.error}`), r.stderr);
      for (const fact of facts) assert.ok(r.stderr.includes(fact), `${body.code}: ${fact}`);
    }
    assert.equal(renderQueueRefusal('submit', { code: 'X', error: 'y' }), 'tc: queue submit refused [X] — y\n');
  });

  it('lets a failure that is not a refusal reach bin/tc, which reports the server unreachable', async () => {
    const { ctx } = fakeCtx(['status'], { get: new Error('ECONNREFUSED') });
    await assert.rejects(() => queue.run(ctx), /ECONNREFUSED/);
  });
});
