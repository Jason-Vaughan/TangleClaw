'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hc = require('../lib/release-certification/host-checks');
const { CertificationError, REFUSAL } = require('../lib/release-certification/codes');
const fx = require('./_release-certification-fixtures');

const { SHA, T0 } = fx;
const DIGEST = 'e'.repeat(64);
const GREEN = { state: 'ok', checks: { test: 'success' } };

let tmp;
let hostBase;
let exchange;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-host-')));
  hostBase = path.join(tmp, 'host');
  exchange = path.join(tmp, 'exchange');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A controllable clock.
 * @param {number} [t] - Start time
 * @returns {{now: function(): number, advance: function(number): void}} Clock
 */
function clock(t = T0) {
  let at = t;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

/**
 * Mint a run for the fixture candidate.
 * @param {string} [runId] - The id to mint
 * @returns {string} Run id
 */
function mint(runId = fx.RUN_ID) {
  return hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test'] }, { random: () => runId, now: () => T0 }).runId;
}

/**
 * An observer standing in for GitHub, counting its calls.
 * @param {object} [observation] - What GitHub reports
 * @returns {{observe: Function, calls: object[]}} Observer
 */
function observer(observation = GREEN) {
  const calls = [];
  return { calls, observe: async (ctx) => { calls.push(ctx); return { observation, error: null }; } };
}

/**
 * The guest's probe context.
 * @param {object} [over] - Overrides
 * @returns {object} Context
 */
function guest(over = {}) {
  return { candidateSha: SHA, runId: fx.RUN_ID, exchangeDir: exchange, hostVerdictWaitMs: 5000, maxReadingAgeMs: 150_000, ...over };
}

/**
 * Attest a sample with a host that answers whenever the guest waits.
 * @param {object} ctx - Guest context
 * @param {object} binding - `{seq, manifestDigest}`
 * @param {object} [opts] - `{observe, c, host}`; `host: false` means no host answers
 * @returns {Promise<object>} The attest result
 */
function attestAnswered(ctx, binding, opts = {}) {
  const c = opts.c || clock();
  const obs = opts.observe || observer().observe;
  return hc.attest(ctx, binding, {
    now: c.now,
    sleep: async (ms) => {
      if (opts.host !== false) await hc.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, observe: obs, now: c.now });
      c.advance(ms);
    }
  });
}

/**
 * Write a verdict file by hand, the way a tampered transport could.
 * @param {number} seq - Sample number
 * @param {object} verdict - Verdict
 * @returns {void}
 */
function plant(seq, verdict) {
  fs.mkdirSync(path.join(exchange, 'verdicts'), { recursive: true });
  fs.writeFileSync(path.join(exchange, 'verdicts', `${seq}.json`), JSON.stringify(verdict));
}

describe('host checks: minting and answering (#2020 Q1)', () => {
  it('mints a 128-bit run id and records what the host will judge', () => {
    const { runId } = hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test', 'lint'] });
    assert.match(runId, /^[0-9a-f]{32}$/);
    const rec = hc.mintedRuns(hostBase, SHA).get(runId);
    assert.deepEqual([rec.repository, rec.requiredChecks], ['o/r', ['lint', 'test']]);
    assert.notEqual(hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test'] }).runId, runId);
  });

  it('refuses to mint without a repository or with no required checks', () => {
    assert.throws(() => hc.mintRun(hostBase, { candidateSha: SHA, repository: 'nope', requiredChecks: ['test'] }), (e) => e instanceof CertificationError && e.code === REFUSAL.INVALID_MANIFEST);
    assert.throws(() => hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: [] }), (e) => e.code === REFUSAL.INVALID_MANIFEST);
  });

  it('answers a minted run\'s request once, from GitHub, and records the verdict in its ledger first', async () => {
    mint();
    const o = observer();
    const r = await attestAnswered(guest(), { seq: 3, manifestDigest: DIGEST }, { observe: o.observe });
    assert.deepEqual(r.observation, GREEN);
    assert.equal(r.binding.sampleSeq, 3);
    assert.deepEqual(o.calls, [{ repo: 'o/r', candidateSha: SHA, requiredChecks: ['test'] }]);
    const ledger = fs.readFileSync(hc.hostPaths(hostBase, SHA).ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].verdictDigest, r.binding.verdictDigest);
    const again = await hc.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, observe: o.observe, now: () => T0 });
    assert.deepEqual(again.answered, [], 'an answered request is not answered twice');
  });

  it('never answers a run it did not mint, so the guest fails closed', async () => {
    mint();
    const o = observer();
    const r = await attestAnswered(guest({ runId: 'f'.repeat(32) }), { seq: 1, manifestDigest: DIGEST }, { observe: o.observe });
    assert.deepEqual(r, { observation: { state: 'unavailable', checks: null }, error: hc.DIAGNOSTIC.MISSING });
    assert.equal(o.calls.length, 0, 'GitHub was never read for it');
    assert.equal(fs.existsSync(path.join(exchange, 'verdicts', '1.json')), false);
  });

  it('skips a request that does not parse or whose file name disagrees with its sequence', async () => {
    mint();
    fs.mkdirSync(path.join(exchange, 'requests'), { recursive: true });
    fs.writeFileSync(path.join(exchange, 'requests', '2.json'), '{broken');
    fs.writeFileSync(path.join(exchange, 'requests', '4.json'), JSON.stringify({ schema: hc.REQUEST_SCHEMA, candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: DIGEST, sampleSeq: 5, requestedAt: T0 }));
    const r = await hc.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, observe: observer().observe, now: () => T0 });
    assert.deepEqual(r.answered, []);
    assert.deepEqual(r.skipped.map((s) => s.reason), ['invalid-request', 'invalid-request']);
  });
});

describe('host checks: the guest accepts only a verdict bound to its own sample', () => {
  /**
   * A valid verdict for the default binding, which a test then breaks.
   * @param {object} [over] - Fields to change after the digest is computed
   * @param {object} [pre] - Fields to change before the digest is computed
   * @returns {object} Verdict
   */
  function verdict(over = {}, pre = {}) {
    const v = { schema: hc.VERDICT_SCHEMA, candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: DIGEST, sampleSeq: 1, requestedAt: T0, observedAt: T0 + 10, observation: GREEN, reason: null, ...pre };
    v.verdictDigest = hc.verdictDigest(v);
    return { ...v, ...over };
  }
  const expected = { candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: DIGEST, sampleSeq: 1, requestedAt: T0 };

  it('accepts a verdict whose every binding matches', () => {
    const r = hc.judgeVerdict(JSON.stringify(verdict()), expected);
    assert.deepEqual(r.observation, GREEN);
  });

  for (const [name, text, diag] of [
    ['no verdict', null, 'MISSING'],
    ['unparsable text', '{nope', 'INVALID'],
    ['a malformed observation', JSON.stringify(verdict({}, { observation: { state: 'ok', checks: { test: 'green' } } })), 'INVALID'],
    ['another candidate', JSON.stringify(verdict({}, { candidateSha: 'b'.repeat(40) })), 'MISMATCH'],
    ['another run id', JSON.stringify(verdict({}, { runId: 'f'.repeat(32) })), 'MISMATCH'],
    ['another manifest digest', JSON.stringify(verdict({}, { manifestDigest: 'f'.repeat(64) })), 'MISMATCH'],
    ['another sample', JSON.stringify(verdict({}, { sampleSeq: 2 })), 'MISMATCH'],
    ['another request time', JSON.stringify(verdict({}, { requestedAt: T0 - 1 })), 'MISMATCH'],
    ['an observation edited after the host signed off on it', JSON.stringify(verdict({ observation: { state: 'ok', checks: { test: 'success', lint: 'success' } } }, { observation: { state: 'ok', checks: { test: 'failure' } } })), 'MISMATCH']
  ]) {
    it(`reads ${name} as GitHub unavailable (${diag})`, () => {
      assert.deepEqual(hc.judgeVerdict(text, expected), { diagnostic: hc.DIAGNOSTIC[diag] });
    });
  }

  it('accepts a bound verdict whatever the host clock reads, since freshness is the guest\'s own', () => {
    for (const observedAt of [1, T0 + 3_600_000]) {
      assert.deepEqual(hc.judgeVerdict(JSON.stringify(verdict({}, { observedAt })), expected).observation, GREEN);
    }
  });

  it('answers once even when the host clock is far behind the guest\'s, and the guest accepts it', async () => {
    mint();
    const o = observer();
    const guestClock = clock(T0 + 3_600_000);
    const r = await hc.attest(guest(), { seq: 1, manifestDigest: DIGEST }, {
      now: guestClock.now,
      sleep: async (ms) => { await hc.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, observe: o.observe, now: () => T0 }); guestClock.advance(ms); }
    });
    assert.deepEqual(r.observation, GREEN);
    assert.equal(o.calls.length, 1, 'GitHub was read once, not once per pass');
  });

  it('waits only as long as allowed for a verdict, then reports it missing', async () => {
    const c = clock();
    const r = await attestAnswered(guest({ hostVerdictWaitMs: 3000 }), { seq: 1, manifestDigest: DIGEST }, { c, host: false });
    assert.equal(r.error, hc.DIAGNOSTIC.MISSING);
    assert.ok(c.now() - T0 >= 3000 && c.now() - T0 < 3000 + 1000);
  });

  it('does not accept a verdict left from an earlier attempt at the same sample', async () => {
    mint();
    plant(1, verdict({}, { requestedAt: T0 - 5000, observedAt: T0 - 4000 }));
    const r = await attestAnswered(guest(), { seq: 1, manifestDigest: DIGEST }, { host: false });
    assert.equal(r.error, hc.DIAGNOSTIC.MISSING, 'the old verdict was removed before asking, not read');
  });

  it('reads a verdict delivered through a symlink as invalid', async () => {
    fs.mkdirSync(path.join(exchange, 'verdicts'), { recursive: true });
    const elsewhere = path.join(tmp, 'elsewhere.json');
    const c = clock();
    const ctx = guest();
    const p = hc.attest(ctx, { seq: 1, manifestDigest: DIGEST }, {
      now: c.now,
      sleep: async (ms) => {
        fs.writeFileSync(elsewhere, JSON.stringify(verdict()));
        fs.rmSync(path.join(exchange, 'verdicts', '1.json'), { force: true });
        fs.symlinkSync(elsewhere, path.join(exchange, 'verdicts', '1.json'));
        c.advance(ms);
      }
    });
    assert.equal((await p).error, hc.DIAGNOSTIC.INVALID);
  });

  it('refuses to vouch for a sample it was not told about', async () => {
    assert.equal((await hc.attest(guest(), undefined)).error, hc.DIAGNOSTIC.UNBOUND);
    assert.equal((await hc.attest(guest({ runId: null }), { seq: 1, manifestDigest: DIGEST })).error, hc.DIAGNOSTIC.UNBOUND);
    assert.equal((await hc.attest(guest(), { seq: 0, manifestDigest: DIGEST })).error, hc.DIAGNOSTIC.UNBOUND);
  });
});

describe('host checks: finalization trusts only the host\'s own ledger', () => {
  const manifest = fx.manifest({ checksSource: 'host-attested', checksExchange: '/x', publishRemote: '/x/metrics.git', isolationProducer: '/x/guest-setup.sh' });

  /**
   * Take samples 1..n through the real exchange, each answered by the host.
   * @param {number} n - How many
   * @param {object} [opts] - `{observe, qualifies}`; `qualifies(seq)` says which intervals earned time
   * @returns {Promise<object[]>} Sample records
   */
  async function samples(n, opts = {}) {
    const out = [];
    for (let seq = 1; seq <= n; seq++) {
      const r = await attestAnswered(guest(), { seq, manifestDigest: DIGEST }, { observe: opts.observe });
      const qualifies = seq > 1 && (opts.qualifies ? opts.qualifies(seq) : true);
      // Taken just after it asked, as the runner does: the guest's clock is
      // the only one either time comes from.
      out.push({ seq, wallAt: T0 + 1000, isolation: { sampleSeq: seq, bootId: fx.BOOT_ID, adminDigest: 'a'.repeat(64), workloadDigest: 'b'.repeat(64) }, observations: { isolation: fx.ISOLATED }, ...(r.binding ? { checks: r.binding } : {}), interval: seq === 1 ? null : { qualifies } });
    }
    return out;
  }
  const finalize = (s, over = {}) => hc.finalize({
    hostBase, manifest, manifestDigest: DIGEST, state: { state: 'awaiting-review', sampleCount: s.length, baseline: { bootId: fx.BOOT_ID } }, samples: s, observe: observer().observe, now: () => T0, ...over
  });

  it('passes a run whose admission and every earning sample the host vouched for, and records it', async () => {
    mint();
    const out = await finalize(await samples(4));
    assert.deepEqual(out, { ok: true, reasons: [] });
    const rec = hc.readFinalization(hostBase, SHA, fx.RUN_ID);
    assert.deepEqual([rec.ok, rec.runId, rec.manifestDigest], [true, fx.RUN_ID, DIGEST]);
  });

  it('ignores a missing verdict on a sample that earned no time', async () => {
    mint();
    const s = await samples(3, { qualifies: (seq) => seq !== 2 });
    delete s[1].checks;
    assert.equal((await finalize(s)).ok, true);
  });

  it('fails on a gap, a verdict it never issued, or one that was not green, naming each sample', async () => {
    mint();
    const s = await samples(4);
    delete s[1].checks;
    s[2].checks = { ...s[2].checks, verdictDigest: 'f'.repeat(64) };
    const out = await finalize(s);
    assert.deepEqual(out.reasons, [{ code: 'VERDICT_MISSING', sampleSeq: 2 }, { code: 'VERDICT_MISMATCH', sampleSeq: 3 }]);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    mint();
    const pending = await samples(2, { observe: observer({ state: 'ok', checks: { test: 'pending' } }).observe });
    assert.deepEqual((await finalize(pending)).reasons, [{ code: 'VERDICT_NOT_GREEN', sampleSeq: 1 }, { code: 'VERDICT_NOT_GREEN', sampleSeq: 2 }]);
  });

  it('fails a run the host never minted, one judged by other checks, and one not yet up for review', async () => {
    const s = await samples(2);
    assert.ok((await finalize(s)).reasons.some((r) => r.code === 'RUN_NOT_MINTED'));
    hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test', 'lint'] }, { random: () => fx.RUN_ID });
    const out = await finalize(s, { state: { state: 'running', sampleCount: s.length, baseline: { bootId: fx.BOOT_ID } } });
    assert.deepEqual(out.reasons.map((r) => r.code).filter((c) => ['CHECKS_LIST_DRIFT', 'NOT_REVIEWABLE'].includes(c)), ['CHECKS_LIST_DRIFT', 'NOT_REVIEWABLE']);
  });

  it('fails when the checks drift by the end, or cannot be read then', async () => {
    mint();
    const s = await samples(2);
    assert.deepEqual((await finalize(s, { observe: observer({ state: 'ok', checks: { test: 'failure' } }).observe })).reasons, [{ code: 'FINAL_CHECKS_NOT_GREEN' }]);
    assert.deepEqual((await finalize(s, { observe: observer({ state: 'unavailable', checks: null }).observe })).reasons, [{ code: 'FINAL_CHECKS_UNAVAILABLE' }]);
    assert.equal(hc.readFinalization(hostBase, SHA, fx.RUN_ID).ok, false, 'the failed outcome is what is recorded');
  });

  it('refuses to finalize a run that did not use host-attested checks', async () => {
    mint();
    const out = await hc.finalize({ hostBase, manifest: fx.manifest(), manifestDigest: DIGEST, state: { state: 'awaiting-review', sampleCount: 0 }, samples: [], observe: observer().observe });
    assert.ok(out.reasons.some((r) => r.code === 'NOT_HOST_ATTESTED'));
  });
});

describe('host checks: robustness and bookkeeping (B3 review)', () => {
  const request = (seq, over = {}) => JSON.stringify({ schema: hc.REQUEST_SCHEMA, candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: DIGEST, sampleSeq: seq, requestedAt: T0, ...over });

  it('moves a request it will never answer aside once, and still answers the rest', async () => {
    mint();
    const req = path.join(exchange, 'requests');
    fs.mkdirSync(req, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'elsewhere.json'), request(1));
    fs.symlinkSync(path.join(tmp, 'elsewhere.json'), path.join(req, '1.json'));
    fs.mkdirSync(path.join(req, '2.json'));
    fs.writeFileSync(path.join(req, '3.json'), '{broken');
    fs.writeFileSync(path.join(req, '4.json'), request(4, { runId: 'f'.repeat(32) }));
    fs.writeFileSync(path.join(req, '5.json'), request(5));
    const o = observer();
    const first = await hc.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, observe: o.observe, now: () => T0 });
    assert.deepEqual(first.answered, [5], 'a bad file never stopped the good one');
    assert.deepEqual(first.skipped.map((x) => x.reason).sort(), ['invalid-request', 'not-a-regular-file', 'not-a-regular-file', 'run-not-minted']);
    assert.deepEqual(fs.readdirSync(req), ['5.json'], 'the rejected requests left the exchange');
    assert.equal(fs.readdirSync(hc.hostPaths(hostBase, SHA).rejected).length, 4);
    const second = await hc.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, observe: o.observe, now: () => T0 });
    assert.deepEqual([second.answered, second.skipped], [[], []], 'nothing is re-read or re-reported');
  });

  it('leaves nothing in the exchange once a sample has its answer, or has given up', async () => {
    mint();
    await attestAnswered(guest(), { seq: 1, manifestDigest: DIGEST });
    await attestAnswered(guest(), { seq: 2, manifestDigest: DIGEST }, { host: false });
    assert.deepEqual(fs.readdirSync(path.join(exchange, 'requests')), []);
    assert.deepEqual(fs.readdirSync(path.join(exchange, 'verdicts')), []);
  });

  it('keeps a finalization per run, so a later run never overwrites an earlier one', async () => {
    const A = 'a1'.repeat(16);
    const B = 'b2'.repeat(16);
    hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test'] }, { random: () => A });
    hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test'] }, { random: () => B });
    const base = { hostBase, manifestDigest: DIGEST, samples: [], state: { state: 'awaiting-review', sampleCount: 0, baseline: { bootId: fx.BOOT_ID } }, now: () => T0 };
    await hc.finalize({ ...base, manifest: fx.manifest({ runId: A, checksSource: 'host-attested', checksExchange: '/x', publishRemote: '/x/metrics.git', isolationProducer: '/x/guest-setup.sh' }), observe: observer().observe });
    await hc.finalize({ ...base, manifest: fx.manifest({ runId: B, checksSource: 'host-attested', checksExchange: '/x', publishRemote: '/x/metrics.git', isolationProducer: '/x/guest-setup.sh' }), observe: observer({ state: 'ok', checks: { test: 'failure' } }).observe });
    assert.equal(hc.readFinalization(hostBase, SHA, A).ok, true);
    assert.equal(hc.readFinalization(hostBase, SHA, B).ok, false);
    assert.equal(hc.readFinalization(hostBase, SHA, 'c'.repeat(32)), null);
  });

  it('fails a run whose evidence is missing a committed sample, or whose verdict came from another request window', async () => {
    mint();
    const manifest = fx.manifest({ checksSource: 'host-attested', checksExchange: '/x', publishRemote: '/x/metrics.git', isolationProducer: '/x/guest-setup.sh' });
    const out = [];
    for (let seq = 1; seq <= 3; seq++) {
      const r = await attestAnswered(guest(), { seq, manifestDigest: DIGEST });
      out.push({ seq, wallAt: T0 + 1000, isolation: { sampleSeq: seq, bootId: fx.BOOT_ID, adminDigest: 'a'.repeat(64), workloadDigest: 'b'.repeat(64) }, observations: { isolation: fx.ISOLATED }, checks: r.binding, interval: seq === 1 ? null : { qualifies: true } });
    }
    const fin = (samples, sampleCount) => hc.finalize({ hostBase, manifest, manifestDigest: DIGEST, state: { state: 'awaiting-review', sampleCount, baseline: { bootId: fx.BOOT_ID } }, samples, observe: observer().observe });
    assert.deepEqual((await fin([out[0], out[2]], 3)).reasons, [{ code: 'SAMPLES_INCOMPLETE' }]);
    const late = [out[0], out[1], { ...out[2], wallAt: T0 + 150_001 }];
    assert.deepEqual((await fin(late, 3)).reasons, [{ code: 'VERDICT_NOT_FRESH', sampleSeq: 3 }]);
    const early = [out[0], { ...out[1], wallAt: T0 - 1 }, out[2]];
    assert.deepEqual((await fin(early, 3)).reasons, [{ code: 'VERDICT_NOT_FRESH', sampleSeq: 2 }]);
  });
});

describe('rc-cert host-checks --watch survives a failed pass', () => {
  it('reports the failure and keeps answering', async () => {
    const cli = require('../scripts/rc-cert');
    mint();
    fs.mkdirSync(path.join(exchange, 'requests'), { recursive: true });
    fs.writeFileSync(path.join(exchange, 'requests', '1.json'), JSON.stringify({ schema: hc.REQUEST_SCHEMA, candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: DIGEST, sampleSeq: 1, requestedAt: T0 }));
    const controller = new AbortController();
    let calls = 0;
    let passes = 0;
    let err = '';
    const code = await cli.main(['host-checks', '--sha', SHA, '--exchange', exchange, '--host-base', hostBase, '--watch', '--interval', '1'], {
      stdout: { write: () => {} }, stderr: { write: (x) => { err += x; } }, env: {}, configFile: path.join(tmp, 'none.json'), signal: controller.signal,
      deps: {
        observeGithub: async () => { if (++calls === 1) throw new Error('GitHub hiccup'); return { observation: GREEN, error: null }; },
        sleep: async () => { if (++passes >= 3) controller.abort(); }
      }
    });
    assert.equal(code, 0);
    assert.match(err, /host-checks-failed/);
    assert.ok(fs.existsSync(path.join(exchange, 'verdicts', '1.json')), 'the next pass answered');
  });
});

describe('host checks: nothing in the exchange can stall the responder', () => {
  const request = (seq) => JSON.stringify({ schema: hc.REQUEST_SCHEMA, candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: DIGEST, sampleSeq: seq, requestedAt: T0 });

  it('removes a rejected request it cannot move aside, and answers the next one', async () => {
    mint();
    const req = path.join(exchange, 'requests');
    fs.mkdirSync(req, { recursive: true });
    fs.writeFileSync(path.join(req, '1.json'), '{broken');
    fs.writeFileSync(path.join(req, '2.json'), request(2));
    const acrossVolumes = () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; throw e; };
    const r = await hc.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, observe: observer().observe, now: () => T0, rename: acrossVolumes });
    assert.deepEqual(r.answered, [2], 'the bad request never stalled the good one');
    assert.deepEqual(fs.readdirSync(req), ['2.json'], 'the bad request was removed when it could not be moved');
  });

  it('answers a request whose verdict slot holds something that is not a plain file', async () => {
    mint();
    fs.mkdirSync(path.join(exchange, 'requests'), { recursive: true });
    fs.mkdirSync(path.join(exchange, 'verdicts'), { recursive: true });
    fs.writeFileSync(path.join(exchange, 'requests', '1.json'), request(1));
    fs.writeFileSync(path.join(tmp, 'elsewhere.json'), '{}');
    fs.symlinkSync(path.join(tmp, 'elsewhere.json'), path.join(exchange, 'verdicts', '1.json'));
    const r = await hc.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, observe: observer().observe, now: () => T0 });
    assert.deepEqual(r.answered, [1]);
    assert.equal(fs.lstatSync(path.join(exchange, 'verdicts', '1.json')).isSymbolicLink(), false, 'the answer replaced the link rather than writing through it');
    assert.equal(fs.readFileSync(path.join(tmp, 'elsewhere.json'), 'utf8'), '{}');
  });
});

describe('host checks: a GitHub failure on the host leaves a trace on both sides (B4 review R-5)', () => {
  it('binds the reason into the verdict, reports it on the host, and surfaces it in the guest sample', async () => {
    mint();
    const lapsed = async () => ({ observation: { state: 'unavailable', checks: null }, error: 'gh-failed' });
    const c = clock();
    const r = await hc.attest(guest(), { seq: 1, manifestDigest: DIGEST }, {
      now: c.now,
      sleep: async (ms) => {
        const out = await hc.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, observe: lapsed, now: c.now });
        if (out.answered.length) assert.deepEqual(out.unavailable, [{ sampleSeq: 1, reason: 'gh-failed' }]);
        c.advance(ms);
      }
    });
    assert.deepEqual(r.observation, { state: 'unavailable', checks: null });
    assert.equal(r.error, 'host-gh-failed');
    assert.equal(r.binding.sampleSeq, 1, 'still a verdict the host issued, so still bound');
    const ledger = fs.readFileSync(hc.hostPaths(hostBase, SHA).ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(ledger[0].reason, 'gh-failed');
  });

  it('refuses a verdict whose reason was edited, since the digest covers it', () => {
    const v = { schema: hc.VERDICT_SCHEMA, candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: DIGEST, sampleSeq: 1, requestedAt: T0, observedAt: T0, observation: { state: 'unavailable', checks: null }, reason: 'gh-failed' };
    v.verdictDigest = hc.verdictDigest(v);
    const expected = { candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: DIGEST, sampleSeq: 1, requestedAt: T0 };
    assert.equal(hc.judgeVerdict(JSON.stringify(v), expected).reason, 'gh-failed');
    assert.deepEqual(hc.judgeVerdict(JSON.stringify({ ...v, reason: null }), expected), { diagnostic: hc.DIAGNOSTIC.MISMATCH });
    assert.deepEqual(hc.judgeVerdict(JSON.stringify({ ...v, reason: 'Not A Code!' }), expected), { diagnostic: hc.DIAGNOSTIC.INVALID });
  });
});

describe('host checks: finalization joins the guest\'s isolation too (A43, A44, A51)', () => {
  const manifest = fx.guestManifest();
  /**
   * Committed samples 1..n, each vouched for and attested.
   * @param {number} n - How many
   * @returns {Promise<object[]>} Sample records
   */
  async function vouched(n) {
    const out = [];
    for (let seq = 1; seq <= n; seq++) {
      const r = await attestAnswered(guest(), { seq, manifestDigest: DIGEST });
      out.push({ seq, wallAt: T0 + 1000, checks: r.binding, isolation: { sampleSeq: seq, bootId: fx.BOOT_ID, adminDigest: 'a'.repeat(64), workloadDigest: 'b'.repeat(64) }, observations: { isolation: fx.ISOLATED }, interval: seq === 1 ? null : { qualifies: true } });
    }
    return out;
  }
  const fin = (samples, baseline = { bootId: fx.BOOT_ID }) => hc.finalize({ hostBase, manifest, manifestDigest: DIGEST, state: { state: 'awaiting-review', sampleCount: samples.length, baseline }, samples, observe: observer().observe, now: () => T0 });

  it('records the boot and a digest of the exact committed sample set', async () => {
    mint();
    const s = await vouched(3);
    assert.deepEqual(await fin(s), { ok: true, reasons: [] });
    const rec = hc.readFinalization(hostBase, SHA, fx.RUN_ID);
    assert.equal(rec.bootId, fx.BOOT_ID);
    assert.match(rec.sampleSetDigest, /^[0-9a-f]{64}$/);
    const first = rec.sampleSetDigest;
    await fin([s[0], s[1], { ...s[2], interval: { qualifies: false } }]);
    assert.notEqual(hc.readFinalization(hostBase, SHA, fx.RUN_ID).sampleSetDigest, first, 'any change to the committed set changes its digest');
  });

  it('fails an earning sample with no isolation, or one from another boot or sample', async () => {
    mint();
    const s = await vouched(4);
    delete s[1].isolation;
    s[2].isolation = { ...s[2].isolation, bootId: 'boot-other' };
    s[3].isolation = { ...s[3].isolation, sampleSeq: 1 };
    assert.deepEqual((await fin(s)).reasons, [
      { code: 'ISOLATION_MISSING', sampleSeq: 2 }, { code: 'ISOLATION_MISMATCH', sampleSeq: 3 }, { code: 'ISOLATION_MISMATCH', sampleSeq: 4 }
    ]);
  });

  it('fails a guest run whose state carries no admission boot', async () => {
    mint();
    const s = await vouched(1);
    assert.ok((await fin(s, {})).reasons.some((r) => r.code === 'ISOLATION_MISSING'));
  });
});
