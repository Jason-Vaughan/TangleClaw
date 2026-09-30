'use strict';

/*
 * #2032, rulings A4/A10: the server's own reader of a rotation checkpoint's
 * GitHub facts. Pull requests are read for state, merged and head; issues for
 * state. A failed read is unavailable, never a guess, and the digest of an
 * observation changes exactly when the observation does.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const gf = require('../lib/github-facts');

const realExec = gf._internal.exec;

describe('github facts (#2032)', () => {
  afterEach(() => { gf._internal.exec = realExec; });

  const answer = (map) => {
    const calls = [];
    gf._internal.exec = async (args) => {
      calls.push(args);
      const out = map[args[1]];
      if (out === undefined) return { exitCode: 1, stdout: '', stderr: 'HTTP 502', error: null, errorCode: null, timedOut: false };
      return { exitCode: 0, stdout: JSON.stringify(out), stderr: '', error: null, errorCode: null, timedOut: false };
    };
    return calls;
  };

  it('reads a pr through pulls and an issue through issues, with the fields each needs', async () => {
    const calls = answer({
      'repos/o/r/pulls/5': { state: 'open', merged: false, headSha: 'a'.repeat(40) },
      'repos/o/r/issues/7': { state: 'closed' }
    });
    const r = await gf.observeAll([{ repo: 'o/r', kind: 'pr', number: 5, state: 'open' }, { repo: 'o/r', kind: 'issue', number: 7, state: 'closed' }]);
    assert.deepEqual(r.unavailable, []);
    assert.deepEqual(r.observations.map((o) => [o.key, o.observed]), [
      ['github:o/r#pr5', { state: 'open', merged: false, headSha: 'a'.repeat(40) }],
      ['github:o/r#issue7', { state: 'closed' }]
    ]);
    assert.deepEqual(calls.map((c) => c[1]), ['repos/o/r/pulls/5', 'repos/o/r/issues/7']);
  });

  it('a failed or strange answer is unavailable, never assumed', async () => {
    answer({ 'repos/o/r/issues/2': { state: 'weird' } });
    const r = await gf.observeAll([{ repo: 'o/r', kind: 'issue', number: 1, state: 'open' }, { repo: 'o/r', kind: 'issue', number: 2, state: 'open' }]);
    assert.equal(r.observations.length, 0);
    assert.equal(r.unavailable.length, 2);
    assert.match(r.unavailable[0], /github:o\/r#issue1/);
  });

  it('drift reports exactly the observations whose digest changed, with before and after', async () => {
    answer({ 'repos/o/r/pulls/5': { state: 'open', merged: false, headSha: 'a'.repeat(40) }, 'repos/o/r/issues/7': { state: 'open' } });
    const facts = [{ repo: 'o/r', kind: 'pr', number: 5, state: 'open' }, { repo: 'o/r', kind: 'issue', number: 7, state: 'open' }];
    const before = (await gf.observeAll(facts)).observations;
    answer({ 'repos/o/r/pulls/5': { state: 'closed', merged: true, headSha: 'a'.repeat(40) }, 'repos/o/r/issues/7': { state: 'open' } });
    const after = (await gf.observeAll(facts)).observations;
    const d = gf.drift(before, after);
    assert.deepEqual(d.map((x) => x.key), ['github:o/r#pr5']);
    assert.notEqual(d[0].before, d[0].after);
    assert.equal(d[0].afterObserved.merged, true);
  });

  it('staleDeclarations compares declared state, head and merged against what was observed', () => {
    const obs = [{ key: 'github:o/r#pr5', observed: { state: 'open', merged: false, headSha: 'a'.repeat(40) } }];
    assert.deepEqual(gf.staleDeclarations([{ repo: 'o/r', kind: 'pr', number: 5, state: 'open', headSha: 'a'.repeat(40), merged: false }], obs), []);
    assert.deepEqual(gf.staleDeclarations([{ repo: 'o/r', kind: 'pr', number: 5, state: 'open', headSha: 'b'.repeat(40) }], obs), ['github:o/r#pr5']);
    assert.deepEqual(gf.staleDeclarations([{ repo: 'o/r', kind: 'pr', number: 5, state: 'closed' }], obs), ['github:o/r#pr5']);
  });

  it('refuses a repo whose owner or name is only dots', () => {
    for (const repo of ['../r', 'o/..', './.', '.../x']) {
      assert.equal(gf.validateFacts([{ repo, kind: 'issue', number: 1, state: 'open' }]).ok, false, repo);
    }
    assert.equal(gf.validateFacts([{ repo: 'o.o/r.r', kind: 'issue', number: 1, state: 'open' }]).ok, true);
  });

  it('reads at most CONCURRENCY facts at once, and a fact not read before the deadline is unavailable', async () => {
    let inFlight = 0;
    let peak = 0;
    gf._internal.exec = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return { exitCode: 0, stdout: JSON.stringify({ state: 'open' }), stderr: '', error: null, errorCode: null, timedOut: false };
    };
    const facts = Array.from({ length: 10 }, (_, i) => ({ repo: 'o/r', kind: 'issue', number: i + 1, state: 'open' }));
    const all = await gf.observeAll(facts);
    assert.equal(all.observations.length, 10);
    assert.ok(peak <= gf.CONCURRENCY, `peak ${peak}`);
    const realDeadline = gf._internal.deadlineMs;
    gf._internal.deadlineMs = 30;
    try {
      const late = await gf.observeAll(facts);
      assert.ok(late.unavailable.some((u) => /before the deadline/.test(u)));
    } finally {
      gf._internal.deadlineMs = realDeadline;
    }
  });

  it('validates the list: shape, bounds, kinds, and no fact twice', () => {
    assert.equal(gf.validateFacts([]).ok, true);
    for (const bad of [null, {}, [{}], [{ repo: 'o/r', kind: 'commit', number: 1, state: 'open' }],
      [{ repo: 'o/r', kind: 'pr', number: 0, state: 'open' }], [{ repo: 'o/r', kind: 'pr', number: 1, state: 'merged' }],
      [{ repo: 'o/r', kind: 'pr', number: 1, state: 'open', headSha: 'short' }],
      [{ repo: 'o/r', kind: 'pr', number: 1, state: 'open' }, { repo: 'o/r', kind: 'pr', number: 1, state: 'open' }],
      Array.from({ length: gf.MAX_FACTS + 1 }, (_, i) => ({ repo: 'o/r', kind: 'issue', number: i + 1, state: 'open' }))]) {
      assert.equal(gf.validateFacts(bad).ok, false, JSON.stringify(bad).slice(0, 80));
    }
  });
});
