'use strict';

/*
 * #2027: the `tc finalize` client. With no target it resolves this pane's own
 * project and session from whoami; a coordinator names both --project and
 * --session. A malformed invocation is refused before any request, and a
 * server refusal is rendered with its code and facts and exits 3, apart from
 * the API-unreachable exit 2.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { VERB_ROSTER, FINALIZE_REFUSED_EXIT, renderUsage } = require('../lib/tc-verbs');

const verb = VERB_ROSTER.find((v) => v.id === 'finalize');

const WHOAMI = { project: { id: 102, name: 'TC RM01' }, sessionId: 1220 };

/**
 * A fake `tc` context that records requests.
 * @param {string[]} argv - Arguments after `tc finalize`
 * @param {object} [opts]
 * @param {object} [opts.whoami] - The whoami answer
 * @param {object|Error} [opts.post] - The finalize answer, or an error to throw
 * @returns {{ctx: object, calls: Array<{method: string, path: string, body?: object, opts?: object}>}}
 */
function fakeCtx(argv, { whoami = WHOAMI, post = { ok: true, alreadyFinalized: false, mode: 'self', session: { id: 1220, status: 'wrapped' } } } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      argv,
      env: {},
      getJson: async (p, opts) => { calls.push({ method: 'GET', path: p, opts }); return whoami; },
      postJson: async (p, body) => {
        calls.push({ method: 'POST', path: p, body });
        if (post instanceof Error) throw post;
        return post;
      }
    }
  };
}

/**
 * An error shaped like the one bin/tc throws for a non-2xx answer.
 * @param {number} status
 * @param {object} body
 * @returns {Error}
 */
function apiError(status, body) {
  const err = new Error(`the TangleClaw API answered ${status}`);
  err.status = status;
  err.code = body.code;
  err.body = body;
  return err;
}

describe('tc finalize (#2027)', () => {
  it('is a declared verb and appears in help', () => {
    assert.ok(verb, 'finalize must be a declared verb');
    assert.match(renderUsage(), /tc finalize --reason/);
  });

  it('with no target, finalizes this pane\'s own session, named by whoami', async () => {
    const { ctx, calls } = fakeCtx(['--reason', 'chunk merged']);
    const out = await verb.run(ctx);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].path, /^\/api\/tc\/whoami/);
    assert.deepEqual(calls[0].opts, { aux: true }, 'the lookup is a side fetch, not a second receipt');
    assert.deepEqual(calls[1], {
      method: 'POST',
      path: '/api/sessions/TC%20RM01/finalize',
      body: { sessionId: 1220, reason: 'chunk merged' }
    });
    assert.match(out.stdout, /Session 1220 of "TC RM01" finalized \(self\)/);
  });

  it('a coordinator names the target; no whoami lookup is made', async () => {
    const { ctx, calls } = fakeCtx(['--project', 'Builder B2', '--session', '77', '--reason', 'lane done'],
      { post: { ok: true, alreadyFinalized: true, mode: 'delegated', session: { id: 77, status: 'wrapped' } } });
    const out = await verb.run(ctx);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { sessionId: 77, reason: 'lane done' });
    assert.equal(calls[0].path, '/api/sessions/Builder%20B2/finalize');
    assert.match(out.stdout, /was already finalized \(delegated\)/);
  });

  it('refuses a malformed invocation before any request', async () => {
    const cases = [
      [[], /needs --reason/],
      [['--reason'], /needs a value/],
      [['--reason', 'a', '--reason', 'b'], /given twice/],
      [['--reason', 'x', '--project', 'P'], /--project needs --session/],
      [['--reason', 'x', '--project', 'P', '--session', 'five'], /numeric session id/],
      [['--force'], /unknown argument/]
    ];
    for (const [argv, pattern] of cases) {
      const { ctx, calls } = fakeCtx(argv);
      const out = await verb.run(ctx);
      assert.equal(out.code, 1, `argv ${JSON.stringify(argv)}`);
      assert.match(out.stderr, pattern);
      assert.equal(calls.length, 0, `argv ${JSON.stringify(argv)} must not reach the server`);
    }
  });

  it('--session alone names a session of this pane\'s own project: how a repeat confirms an ended session', async () => {
    const { ctx, calls } = fakeCtx(['--session', '1220', '--reason', 'confirm'], {
      whoami: { project: { id: 102, name: 'TC RM01' }, sessionId: null },
      post: { ok: true, alreadyFinalized: true, mode: 'self', session: { id: 1220, status: 'wrapped' } }
    });
    const out = await verb.run(ctx);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(calls[1], { method: 'POST', path: '/api/sessions/TC%20RM01/finalize', body: { sessionId: 1220, reason: 'confirm' } });
    assert.match(out.stdout, /was already finalized \(self\)/);
  });

  it('with no active session and no --session, says how to confirm instead of failing opaquely', async () => {
    const { ctx, calls } = fakeCtx(['--reason', 'x'], { whoami: { project: { id: 102, name: 'TC RM01' }, sessionId: null } });
    const out = await verb.run(ctx);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /no active session.*tc finalize --session <id>/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });

  it('an unresolved own identity is reported, not guessed', async () => {
    const { ctx, calls } = fakeCtx(['--reason', 'x'], { whoami: { project: null, unresolved: 'no launch binding' } });
    const out = await verb.run(ctx);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /no launch binding/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });

  it('a server refusal renders its code and facts and exits 3', async () => {
    const { ctx } = fakeCtx(['--reason', 'x'], {
      post: apiError(409, { error: 'This session is not drained', code: 'EXCHANGES_OPEN', inbound: ['mx_1'], awaitingReply: [] })
    });
    const out = await verb.run(ctx);
    assert.equal(out.code, FINALIZE_REFUSED_EXIT);
    assert.equal(FINALIZE_REFUSED_EXIT, 3);
    assert.match(out.stderr, /finalize refused \[EXCHANGES_OPEN\] — This session is not drained/);
    assert.match(out.stderr, /inbound: \["mx_1"\]/);
    assert.match(out.stderr, /Nothing was changed\./);
  });

  it('an incomplete finalization is said as incomplete, with the way to finish it', async () => {
    const { ctx } = fakeCtx(['--reason', 'x'], {
      post: apiError(409, { error: 'The session is recorded finalized, but its handoff is not published', code: 'FINALIZE_INCOMPLETE', teardown: { surviving: ['tmux'] } })
    });
    const out = await verb.run(ctx);
    assert.equal(out.code, FINALIZE_REFUSED_EXIT);
    assert.match(out.stderr, /finalize incomplete \[FINALIZE_INCOMPLETE\]/);
    assert.match(out.stderr, /Repeat the same command to finish\./);
    assert.doesNotMatch(out.stderr, /Nothing was changed/);
  });

  it('success names the published handoff', async () => {
    const { ctx } = fakeCtx(['--reason', 'x'], {
      post: { ok: true, alreadyFinalized: false, mode: 'self', session: { id: 1220, status: 'wrapped' }, publication: { id: 'pub_1', state: 'published' } }
    });
    const out = await verb.run(ctx);
    assert.match(out.stdout, /Handoff pub_1 published\./);
  });

  it('a server fault is not dressed as a refusal: it propagates to bin/tc', async () => {
    const { ctx } = fakeCtx(['--reason', 'x'], { post: apiError(500, { error: 'boom', code: 'INTERNAL_ERROR' }) });
    await assert.rejects(verb.run(ctx), /answered 500/);
  });
});
