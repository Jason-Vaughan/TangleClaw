'use strict';

// #2323: `tc check`. The verb registers a watch on a named check of an exact
// commit for the pane's own project, reads the state the server derives, and
// cancels. Each state and each refusal is rendered in words a session can act
// on, `unknown` never reads as failed or done, and a malformed command is
// refused before any request.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  VERB_ROSTER, CHECK_SUBVERBS, verbsFor, renderUsage, renderCheckList, renderCheckWatch, receiptVerbLabel
} = require('../lib/tc-verbs');
const fs = require('node:fs');
const path = require('node:path');
const sync = require('../scripts/sync-claude-md-block');

const check = VERB_ROSTER.find((v) => v.id === 'check');
const SHA = 'a'.repeat(40);

/**
 * A watch as the check watch API returns it.
 * @param {object} [over] - Fields to replace
 * @returns {object}
 */
function watch(over = {}) {
  return {
    watchId: 'cw_111111111111111111111111', projectId: 7, repo: 'Jason-Vaughan/TangleClaw', prNumber: 2341, headSha: SHA, checkName: 'test',
    dueAt: '2026-10-12T12:30:00.000Z', registeredAt: '2026-10-12T12:00:00.000Z', registeredBy: { sessionId: 1409 },
    state: 'waiting', reasons: [], open: true, result: null, lastRead: null, cancelled: null, expired: null,
    ...over
  };
}

const RESULT = { conclusion: 'success', runId: '9001', completedAt: '2026-10-12T12:10:00.000Z', readAt: '2026-10-12T12:11:00.000Z' };

/**
 * A list as the check watch API returns it.
 * @param {object[]} watches - The watches shown
 * @param {object} [over] - Fields to replace
 * @returns {object}
 */
function listOf(watches, over = {}) {
  return {
    projectId: 7, projectName: 'builder-a', yours: true, openCount: watches.filter((w) => w.open).length, maxOpen: 20,
    total: watches.length, watches, monitored: false, ...over
  };
}

/**
 * A fake tc context recording every request.
 * @param {string[]} argv - Arguments after `check`
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

describe('tc check (#2323)', () => {
  it('is in the roster and in the usage, and not in the list every pane is primed with', () => {
    assert.ok(check);
    assert.deepEqual(CHECK_SUBVERBS, ['watch', 'list', 'show', 'cancel']);
    assert.match(renderUsage(), /tc check watch <pr> --sha <sha> --name <check> --due <minutes>/);
    assert.ok(!verbsFor('pane').some((v) => v.id === 'check'));
    assert.ok(verbsFor('unprimed').some((v) => v.id === 'check'));
    assert.equal(receiptVerbLabel('check', ['watch']), 'check.watch');
    assert.equal(receiptVerbLabel('check', ['bogus']), 'check');
  });

  it('leaves the tracked CLAUDE.md block as the generator writes it', () => {
    const tracked = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
    const compared = sync.compareCarrier(tracked);
    assert.equal(compared.inSync, true, `an unprimed verb must not move the block: ${compared.message}`);
  });

  it('rejects a missing or unknown subverb and malformed arguments before any request', async () => {
    const bad = [
      [], ['bogus'],
      ['watch'], ['watch', 'abc', '--sha', SHA, '--name', 'test', '--due', '30'], ['watch', '0', '--sha', SHA, '--name', 'test', '--due', '30'],
      ['watch', '2341', '--sha', SHA, '--name', 'test'], ['watch', '2341', '--sha', SHA, '--due', '30'], ['watch', '2341', '--name', 'test', '--due', '30'],
      ['watch', '2341', '--sha', SHA, '--name', 'test', '--due', 'soon'], ['watch', '2341', '--sha', SHA, '--name', 'test', '--due', '0'],
      ['watch', '2341', '--sha', SHA, '--name', 'test', '--due', '1.5'], ['watch', '2341', '--sha', SHA, '--name', 'test', '--due', '30', '--repo', 'a/b'],
      ['watch', '2341', '--sha', SHA, '--sha', SHA, '--name', 'test', '--due', '30'], ['watch', '2341', '--sha'],
      ['list', 'extra'], ['list', '--project'], ['list', '--project', 'builder-a'], ['list', '--all', '1'],
      ['show'], ['show', 'a', 'b'], ['cancel'], ['cancel', 'a', 'b']
    ];
    for (const argv of bad) {
      const { ctx, calls } = fakeCtx(argv);
      const out = await check.run(ctx);
      assert.equal(out.code, 1, argv.join(' '));
      assert.match(out.stderr, /usage: tc check watch/, argv.join(' '));
      assert.equal(calls.length, 0, `${argv.join(' ')} sent a request`);
    }
  });

  it('watch sends the pull request, the exact commit, the check name and the minutes, and nothing else', async () => {
    const { ctx, calls } = fakeCtx(['watch', '2341', '--name', 'test (node 22)', '--due', '45', '--sha', SHA], { post: { watch: watch({ checkName: 'test (node 22)' }), monitored: false } });
    const out = await check.run(ctx);
    assert.equal(out.code, 0);
    assert.deepEqual(calls, [['POST', '/api/tc/check-watches', { prNumber: 2341, headSha: SHA, checkName: 'test (node 22)', dueInMinutes: 45 }]]);
    assert.match(out.stdout, /^Watching: cw_111111111111111111111111: `test \(node 22\)` on a{40} \(PR #2341, Jason-Vaughan\/TangleClaw\): waiting, due 2026-10-12T12:30:00.000Z\n/);
    assert.match(out.stdout, /tc check show cw_111111111111111111111111/);
  });

  it('says, on every answer from a server that wakes nobody for a watch, that nobody will be woken', async () => {
    const answers = [
      [['watch', '2341', '--sha', SHA, '--name', 'test', '--due', '45'], { post: { watch: watch(), monitored: false } }],
      [['list'], { get: listOf([watch()]) }],
      [['show', 'cw_1'], { get: { watch: watch(), projectName: 'builder-a', facts: [], monitored: false } }]
    ];
    for (const [argv, answer] of answers) {
      const out = await check.run(fakeCtx(argv, answer).ctx);
      assert.match(out.stdout, /NOT MONITORED: .*reads GitHub for a watch and records the result, but wakes nobody\. Read the check yourself/, argv[0]);
    }
    // A server that does read it is not said to be silent.
    assert.ok(!/NOT MONITORED/.test(renderCheckList(listOf([watch()], { monitored: true }))));
    assert.ok(!/NOT MONITORED/.test(renderCheckWatch({ watch: watch(), projectName: 'builder-a', facts: [], monitored: true })));
  });

  it('list renders each state, and unknown with its reason, never as failed or done', async () => {
    const watches = [
      watch(),
      watch({ watchId: 'cw_2', state: 'ready', open: false, result: RESULT }),
      watch({ watchId: 'cw_3', state: 'failed', open: false, result: { ...RESULT, conclusion: 'timed_out', runId: '9002' } }),
      watch({ watchId: 'cw_4', state: 'unknown', reasons: ['past-due', 'read-failed'] }),
      watch({ watchId: 'cw_5', state: 'unknown', reasons: ['cancelled'], open: false, cancelled: { at: '2026-10-12T12:05:00.000Z', projectId: 7 } }),
      watch({ watchId: 'cw_6', state: 'unknown', reasons: ['expired'], open: false, expired: { at: '2026-10-13T12:30:00.000Z' } }),
      watch({ watchId: 'cw_7', state: 'unknown', reasons: ['unreadable'] }),
      watch({ watchId: 'cw_8', state: 'unknown', reasons: ['something-new'] }),
      watch({ watchId: 'cw_9', state: 'unknown', reasons: [] })
    ];
    const { ctx, calls } = fakeCtx(['list'], { get: listOf(watches) });
    const out = await check.run(ctx);
    assert.equal(out.code, 0);
    assert.deepEqual(calls, [['GET', '/api/tc/check-watches']]);
    const line = (id) => out.stdout.split('\n').find((l) => l.includes(`${id}:`));
    assert.match(out.stdout, /^Check watches of project builder-a \(7\), which is this project: 5 open of at most 20\.\n/, 'the count is the server\'s: the watches above that are open');
    assert.match(line('cw_111111111111111111111111'), /: waiting, due 2026-10-12T12:30:00\.000Z$/);
    assert.match(line('cw_2'), /: ready \(success, run 9001, completed 2026-10-12T12:10:00\.000Z\)$/);
    assert.match(line('cw_3'), /: failed \(timed_out, run 9002, completed /);
    assert.match(line('cw_4'), /: unknown, which is neither failed nor done \(its due time passed with no result; the last read of GitHub failed\), due /);
    assert.match(line('cw_5'), /unknown, which is neither failed nor done \(it was cancelled\)$/, 'a closed watch names no due time');
    assert.match(line('cw_6'), /\(it expired unresolved\)$/);
    assert.match(line('cw_7'), /\(its record cannot be read\)/);
    assert.match(line('cw_8'), /\(something-new\)/, 'a reason this tc does not know is shown as sent');
    assert.match(line('cw_9'), /\(no reason recorded\)/);
    for (const id of ['cw_4', 'cw_5', 'cw_6', 'cw_7', 'cw_8', 'cw_9']) assert.ok(!/: (failed|ready)/.test(line(id)), id);
  });

  it('list names another project when asked, says when there is none, and says when it shows only the newest', async () => {
    const { ctx, calls } = fakeCtx(['list', '--project', '12'], { get: listOf([], { projectId: 12, projectName: 'builder-b', yours: false }) });
    const out = await check.run(ctx);
    assert.deepEqual(calls, [['GET', '/api/tc/check-watches?projectId=12']]);
    assert.match(out.stdout, /^Check watches of project builder-b \(12\): 0 open of at most 20\.\n {2}None registered\.\n/);
    const many = renderCheckList(listOf([watch()], { total: 53 }));
    assert.match(many, /\(the newest 1 of 53; `tc check show <watch>` reads an older one\)/);
  });

  it('show renders the watch, its last read of GitHub and its history', async () => {
    const data = {
      watch: watch({ state: 'unknown', reasons: ['read-failed'], lastRead: { at: '2026-10-12T12:02:00.000Z', outcome: 'failed', detail: 'gh api exited 1' } }),
      projectName: 'builder-a',
      facts: [
        { kind: 'registered', code: null, at: '2026-10-12T12:00:00.000Z', exchangeId: null, workspaceId: null, detail: { sessionId: 1409 } },
        { kind: 'read-failed', code: null, at: '2026-10-12T12:02:00.000Z', exchangeId: null, workspaceId: null, detail: { reason: 'gh api exited 1' } },
        { kind: 'resolved', code: 'success', at: '2026-10-12T12:11:00.000Z', exchangeId: null, workspaceId: null, detail: null }
      ],
      monitored: false
    };
    const { ctx, calls } = fakeCtx(['show', 'cw_111111111111111111111111'], { get: data });
    const out = await check.run(ctx);
    assert.equal(out.code, 0);
    assert.deepEqual(calls, [['GET', '/api/tc/check-watches/cw_111111111111111111111111']]);
    assert.match(out.stdout, /^Check watch of project builder-a \(7\), registered 2026-10-12T12:00:00\.000Z:\n/);
    assert.match(out.stdout, /last read of GitHub: failed at 2026-10-12T12:02:00\.000Z \(gh api exited 1\)/);
    assert.match(out.stdout, /History:\n {4}2026-10-12T12:00:00\.000Z {2}registered\n {4}2026-10-12T12:02:00\.000Z {2}read-failed\n {4}2026-10-12T12:11:00\.000Z {2}resolved \[success\]\n/);
    const unread = renderCheckWatch({ watch: watch(), projectName: null, facts: [], monitored: false });
    assert.match(unread, /GitHub has not been read for it\./);
    assert.match(unread, /project unknown \(7\)/);
  });

  it('show and cancel put an id they cannot trust into the path encoded', async () => {
    const shown = fakeCtx(['show', '../../sessions?x=1'], { get: { watch: watch(), projectName: 'p', facts: [], monitored: false } });
    await check.run(shown.ctx);
    assert.deepEqual(shown.calls, [['GET', '/api/tc/check-watches/..%2F..%2Fsessions%3Fx%3D1']]);
    const cancelled = fakeCtx(['cancel', 'a/b'], { post: { watch: watch(), monitored: false } });
    await check.run(cancelled.ctx);
    assert.deepEqual(cancelled.calls, [['POST', '/api/tc/check-watches/a%2Fb/cancel', {}]]);
  });

  it('cancel says the watch is not read again and wakes nobody', async () => {
    const { ctx, calls } = fakeCtx(['cancel', 'cw_111111111111111111111111'], { post: { watch: watch({ state: 'unknown', reasons: ['cancelled'], open: false }), monitored: false } });
    const out = await check.run(ctx);
    assert.equal(out.code, 0);
    assert.deepEqual(calls, [['POST', '/api/tc/check-watches/cw_111111111111111111111111/cancel', {}]]);
    assert.equal(out.stdout, `Cancelled: watch cw_111111111111111111111111 (\`test\` on ${SHA}) is not read again and wakes nobody.\n`);
  });

  it('renders each refusal with its code and the server\'s words, and exits 2', async () => {
    const cases = [
      [['watch', '2341', '--sha', SHA, '--name', 'test', '--due', '45'], 'post', { code: 'CHECK_WATCH_DUPLICATE', error: 'This project already watches that check on that commit (cw_9).', watchId: 'cw_9' }, /^tc: check watch refused \[CHECK_WATCH_DUPLICATE\] — This project already watches that check on that commit \(cw_9\)\.\n {2}watch: cw_9\n$/],
      [['watch', '2341', '--sha', SHA, '--name', 'test', '--due', '45'], 'post', { code: 'CHECK_WATCH_LIMIT', error: 'This project already has 20 open watches.' }, /^tc: check watch refused \[CHECK_WATCH_LIMIT\] — This project already has 20 open watches\.\n$/],
      [['watch', '2341', '--sha', SHA, '--name', 'test', '--due', '9999'], 'post', { code: 'CHECK_WATCH_DUE_OUT_OF_RANGE', error: 'Every watch needs a due time.' }, /refused \[CHECK_WATCH_DUE_OUT_OF_RANGE\]/],
      [['watch', '2341', '--sha', 'short', '--name', 'test', '--due', '45'], 'post', { code: 'CHECK_WATCH_MALFORMED', error: 'A watch cannot be read as asked.' }, /refused \[CHECK_WATCH_MALFORMED\]/],
      [['watch', '2341', '--sha', SHA, '--name', 'test', '--due', '45'], 'post', { code: 'CHECK_WATCH_REPO_UNKNOWN', error: 'No origin remote on github.com.' }, /refused \[CHECK_WATCH_REPO_UNKNOWN\]/],
      [['list', '--project', '99'], 'get', { code: 'CHECK_WATCH_PROJECT_NOT_FOUND', error: 'No such project.' }, /^tc: check list refused \[CHECK_WATCH_PROJECT_NOT_FOUND\] — No such project\.\n$/],
      [['show', 'cw_0'], 'get', { code: 'CHECK_WATCH_NOT_FOUND', error: 'No such check watch.' }, /^tc: check show refused \[CHECK_WATCH_NOT_FOUND\]/],
      [['cancel', 'cw_0'], 'post', { code: 'CHECK_WATCH_NOT_OWNER', error: 'Only the project a watch belongs to may cancel it.' }, /^tc: check cancel refused \[CHECK_WATCH_NOT_OWNER\]/],
      [['cancel', 'cw_0'], 'post', { code: 'CHECK_WATCH_CANCELLED', error: 'Watch cw_0 is already cancelled.' }, /refused \[CHECK_WATCH_CANCELLED\]/],
      [['list'], 'get', { code: 'CALLER_NOT_VERIFIED', error: 'Check watches answer only the Operator or a verified launch.' }, /refused \[CALLER_NOT_VERIFIED\]/]
    ];
    for (const [argv, how, body, said] of cases) {
      const out = await check.run(fakeCtx(argv, { [how]: refused(body) }).ctx);
      assert.equal(out.code, 2, argv.join(' '));
      assert.match(out.stderr, said, argv.join(' '));
      assert.equal(out.stdout, undefined);
    }
  });

  it('lets a failure that is not a refusal reach bin/tc, which reports the server unreachable', async () => {
    for (const argv of [['list'], ['show', 'cw_0'], ['cancel', 'cw_0'], ['watch', '2341', '--sha', SHA, '--name', 'test', '--due', '45']]) {
      const boom = new Error('the TangleClaw API is unreachable');
      await assert.rejects(check.run(fakeCtx(argv, { get: boom, post: boom }).ctx), /unreachable/);
    }
  });
});
