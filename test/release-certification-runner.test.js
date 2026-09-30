'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const probes = require('../lib/release-certification/probes');
const runnerLib = require('../lib/release-certification/runner');
const store = require('../lib/release-certification/store');
const cli = require('../scripts/rc-cert');
const { STATES, REFUSAL, CertificationError } = require('../lib/release-certification/codes');
const fx = require('./_release-certification-fixtures');

const { SHA, GEN, WTID, MIN, T0 } = fx;


let tmp;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-runner-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Healthy observations with per-probe overrides.
 * @param {object} [over] - Overrides; null makes a probe unreachable
 * @returns {object} Observations
 */
function healthy(over = {}) {
  return fx.observations(over, { ttyd: { poolUsed: 2 } });
}

/**
 * A fake clock and probe set that replays scripted observations.
 * @param {object[]} script - Observations per collect call; the last repeats
 * @returns {{clock: object, probes: object, advance: function(number): void}} Fakes
 */
function fakes(script) {
  let wall = T0;
  let mono = 0;
  let i = 0;
  return {
    clock: { wall: () => wall, mono: () => mono },
    probes: { collect: async () => ({ observations: script[Math.min(i++, script.length - 1)], diagnostics: {} }) },
    advance: (ms) => { wall += ms; mono += ms; }
  };
}

/**
 * Assert an async thunk rejects with a CertificationError code.
 * @param {Function} fn - Async thunk
 * @param {string} code - Expected code
 * @returns {Promise<CertificationError>} The error
 */
async function rejects(fn, code) {
  let caught = null;
  try { await fn(); } catch (err) { caught = err; }
  assert.ok(caught instanceof CertificationError, `expected ${code}, got ${caught}`);
  assert.equal(caught.code, code);
  return caught;
}

const SPEC = { version: '5.30.0', repository: 'o/r', worktreePath: '/tmp/rc-wt', worktreeId: WTID, requiredChecks: ['test'], requiredChecksSource: 'branch-protection', host: 'h', runId: fx.RUN_ID };
/**
 * A publication that always succeeds, recording what it was asked.
 * @param {object} [over] - Method overrides
 * @returns {object} Fake publication
 */
function fakePub(over = {}) {
  const calls = { admit: [], publish: 0 };
  return {
    calls,
    publishedDigest: async () => null,
    admit: async (manifest, digest, opts) => { calls.admit.push({ manifest, digest, opts }); return { verifiedAt: 1 }; },
    publishCurrent: async () => { calls.publish += 1; return { published: true, seq: calls.publish }; },
    due: () => true,
    recordFailure: () => ({ nextAttemptAt: 99 }),
    readStatus: () => ({}),
    ...over
  };
}

/** Admission options that never sleep. */
const NOW = { wait: async () => {} };

describe('probe observations', () => {
  it('reads a clean detached worktree, and counts untracked files as dirty', () => {
    const m = { state: 'measured', headSha: SHA, detached: true, dirtyTracked: 0, untracked: 0 };
    assert.deepEqual(probes.worktreeObservation(m), { headSha: SHA, detached: true, dirty: false });
    assert.equal(probes.worktreeObservation({ ...m, untracked: 1 }).dirty, true);
    assert.equal(probes.worktreeObservation({ ...m, dirtyTracked: null }).dirty, null);
    assert.equal(probes.worktreeObservation({ state: 'unknown' }), null);
  });

  it('reads server-info, turning its ISO start time into epoch ms', () => {
    const o = probes.serverObservation({ checkoutId: WTID, currentDiskSha: SHA, isStale: false, startupSha: SHA, shaBaselineSource: 'startup', runningVersion: '5.30.0', startedAt: '2026-09-27T16:00:00.000Z' });
    assert.equal(o.startedAt, Date.parse('2026-09-27T16:00:00.000Z'));
    assert.deepEqual([o.checkoutId, o.currentDiskSha, o.isStale], [WTID, SHA, false]);
    assert.equal(probes.serverObservation(null), null);
    assert.equal(probes.serverObservation({}).startupSha, null);
  });

  const health = (state, reading) => ({ conditions: [{ id: 'other' }, { id: 'ttyd-leak', state, reading }] });
  const fresh = { sampledAt: new Date(T0).toISOString(), generation: GEN, managed: true, wedged: 0, orphanGate: false, pool: { used: 7, cap: 511 } };

  it('reads the ttyd-leak condition as values', () => {
    assert.deepEqual(probes.ttydObservation({ conditions: [{ id: 'ttyd-leak', state: 'clear', applicable: false }] }, T0, 1), { applicable: false });
    assert.deepEqual(probes.ttydObservation(health('clear', fresh), T0 + 1000, 150_000), {
      applicable: true, managed: true, generation: GEN, leakState: 'clear', wedgedCount: 0, orphanGate: false, poolUsed: 7
    });
    assert.equal(probes.ttydObservation({ conditions: [] }, T0, 1), null);
  });

  it('will not let an old reading vouch for health, but keeps its failures', () => {
    const late = T0 + 10 * MIN;
    assert.deepEqual(probes.ttydObservation(health('clear', fresh), late, 150_000), {
      applicable: true, managed: null, generation: null, leakState: 'unknown', wedgedCount: null, orphanGate: null, poolUsed: null
    });
    const bad = { ...fresh, managed: false, wedged: 3, orphanGate: true };
    assert.deepEqual(probes.ttydObservation(health('fired', bad), late, 150_000), {
      applicable: true, managed: false, generation: null, leakState: 'fired', wedgedCount: 3, orphanGate: true, poolUsed: null
    });
  });

  it('judges only required checks, by their newest run, falling back to commit statuses', () => {
    const runs = (...list) => ({ check_runs: list });
    const byName = {
      test: runs({ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }, { id: 2, name: 'test', status: 'completed', conclusion: 'success' }),
      slow: runs({ id: 4, name: 'slow', status: 'in_progress', conclusion: null }),
      gone: runs({ id: 5, name: 'gone', status: 'completed', conclusion: 'cancelled' }),
      broke: runs({ id: 6, name: 'broke', status: 'completed', conclusion: 'timed_out' }),
      legacy: runs(),
      absent: runs()
    };
    const statuses = { statuses: [{ context: 'legacy', state: 'error' }] };
    const o = probes.githubObservation(byName, statuses, ['test', 'slow', 'gone', 'broke', 'legacy', 'absent']);
    assert.deepEqual(o, { state: 'ok', checks: { test: 'success', slow: 'pending', gone: 'pending', broke: 'failure', legacy: 'failure', absent: 'missing' } });
    assert.deepEqual(probes.githubObservation({ test: null }, statuses, ['test']), { state: 'unavailable', checks: null });
    assert.deepEqual(probes.githubObservation(byName, null, ['test']), { state: 'unavailable', checks: null });
  });

  it('reads PTY activity', () => {
    assert.deepEqual(probes.ptyObservation({ instance: 'i', attaches: 3, detaches: 2, lastAt: '2026-09-27T16:00:00.000Z' }),
      { instance: 'i', attaches: 3, detaches: 2, lastAt: Date.parse('2026-09-27T16:00:00.000Z') });
    assert.equal(probes.ptyObservation({ instance: 'i', attaches: -1, detaches: 0, lastAt: null }).attaches, null);
  });

  it('reads the required checks from branch protection', async () => {
    const gh = async () => ({ body: { contexts: ['b'], checks: [{ context: 'a' }, { context: 'b' }] }, error: null });
    assert.deepEqual(await probes.requiredChecks('o/r', gh), ['a', 'b']);
    assert.equal(await probes.requiredChecks('o/r', async () => ({ body: null, error: 'gh-failed' })), null);
  });

  it('collects every probe, asking GitHub about each required check of the candidate SHA by name', async () => {
    const calls = [];
    const set = probes.createProbes({ apiBase: 'http://x', worktreePath: '/wt', candidateSha: SHA, repo: 'o/r', requiredChecks: ['test', 'e2e run'], maxReadingAgeMs: 150_000 }, {
      measure: async () => ({ state: 'measured', headSha: SHA, detached: true, dirtyTracked: 0, untracked: 0 }),
      fetchJson: async (_opts, route) => {
        calls.push(route);
        if (route === '/api/server-info') return { body: { checkoutId: WTID, currentDiskSha: SHA, isStale: false, startupSha: SHA, shaBaselineSource: 'startup', runningVersion: '5.30.0', startedAt: 500 }, error: null };
        if (route === '/api/system/health') return { body: health('clear', fresh), error: null };
        return { body: { instance: 's', attaches: 0, detaches: 0, lastAt: null }, error: null };
      },
      ghJson: async (args) => {
        calls.push(args[1]);
        const name = new URLSearchParams(args[1].split('?')[1]).get('check_name');
        return { body: name ? { check_runs: [{ id: 1, name, status: 'completed', conclusion: 'success' }] } : { statuses: [] }, error: null };
      }
    });
    const { observations, diagnostics } = await set.collect(T0);
    assert.deepEqual(observations.github.checks, { test: 'success', 'e2e run': 'success' });
    assert.equal(observations.ttyd.generation, GEN);
    assert.deepEqual(diagnostics, {});
    assert.ok(calls.includes(`repos/o/r/commits/${SHA}/check-runs?check_name=e2e%20run&per_page=100`));
    assert.ok(calls.every((c) => !c.startsWith('repos/') || c.includes(`/commits/${SHA}/`)));
  });

  it('says why each source gave nothing', async () => {
    const set = probes.createProbes({ apiBase: 'http://x', worktreePath: '/wt', candidateSha: SHA, repo: 'o/r', requiredChecks: ['test'], maxReadingAgeMs: 150_000 }, {
      measure: async () => ({ state: 'unknown' }),
      fetchJson: async (_opts, route) => ({ body: null, error: route === '/api/server-info' ? 'http-401' : 'connect-failed' }),
      ghJson: async () => ({ body: null, error: 'gh-failed' })
    });
    const { observations, diagnostics } = await set.collect(T0);
    assert.deepEqual(diagnostics, { worktree: 'worktree-unknown', server: 'http-401', ttyd: 'connect-failed', pty: 'connect-failed', github: 'gh-failed' });
    assert.equal(observations.server, null);
    assert.equal(observations.github.state, 'unavailable');
  });

  it('fetches JSON over HTTP with a bearer token, and reads a failure as null', async () => {
    let seenAuth = null;
    const server = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      if (req.url === '/ok') { res.writeHead(200); res.end('{"a":1}'); } else { res.writeHead(401); res.end('{}'); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const apiBase = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.deepEqual(await probes.fetchJson({ apiBase, token: 't' }, '/ok'), { body: { a: 1 }, error: null });
      assert.equal(seenAuth, 'Bearer t');
      assert.deepEqual(await probes.fetchJson({ apiBase }, '/denied'), { body: null, error: 'http-401' });
    } finally {
      server.close();
    }
    assert.deepEqual(await probes.fetchJson({ apiBase }, '/ok'), { body: null, error: 'connect-failed' });
    assert.deepEqual(await probes.fetchJson({ apiBase: 'not a url' }, '/ok'), { body: null, error: 'bad-url' });
  });
});

describe('runner', () => {
  it('admits a healthy candidate with the ttyd generation it observed as the baseline', async () => {
    const f = fakes([healthy()]);
    const r = runnerLib.createRunner({ publication: fakePub(), base: path.join(tmp, 'v1'), candidateSha: SHA, probes: f.probes, clock: f.clock });
    const state = await r.start(SPEC);
    assert.equal(state.state, STATES.RUNNING);
    const { manifest } = store.readRun(path.join(tmp, 'v1'), SHA);
    assert.equal(manifest.private.baseline.ttydGeneration, GEN);
  });

  it('refuses admission, writing nothing, when the ttyd generation stays unknown or the runtime stays unproven', async () => {
    for (const obs of [healthy({ ttyd: { generation: null } }), healthy({ server: { shaBaselineSource: 'late' } })]) {
      const f = fakes([obs]);
      const base = path.join(tmp, 'v1');
      let waits = 0;
      await rejects(() => runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: f.probes, clock: f.clock })
        .start(SPEC, { wait: async () => { waits += 1; } }), REFUSAL.ADMISSION_REFUSED);
      assert.equal(waits, runnerLib.ADMISSION_ATTEMPTS - 1);
      assert.deepEqual(store.listRuns(base), []);
    }
  });

  it('admits an idle server once its first unknown readings clear', async () => {
    const coldHealth = healthy({ ttyd: { generation: null, leakState: 'unknown', managed: null } });
    const f = fakes([coldHealth, coldHealth, healthy()]);
    const log = [];
    const state = await runnerLib.createRunner({ publication: fakePub(), base: path.join(tmp, 'v1'), candidateSha: SHA, probes: f.probes, clock: f.clock, log: (e) => log.push(e) })
      .start(SPEC, { wait: async () => f.advance(10_000) });
    assert.equal(state.state, STATES.RUNNING);
    assert.equal(log.filter((e) => e.event === 'admission-retry').length, 2);
  });

  it('refuses at once, without retrying, on a hard fail such as a platform with no owned ttyd', async () => {
    for (const obs of [healthy({ ttyd: { applicable: false } }), healthy({ server: { checkoutId: 'd'.repeat(64) } })]) {
      const f = fakes([obs]);
      let waits = 0;
      const err = await rejects(() => runnerLib.createRunner({ publication: fakePub(), base: path.join(tmp, 'v1'), candidateSha: SHA, probes: f.probes, clock: f.clock })
        .start(SPEC, { wait: async () => { waits += 1; } }), REFUSAL.ADMISSION_REFUSED);
      assert.equal(waits, 0);
      assert.ok(['TTYD_NOT_APPLICABLE', 'SERVER_NOT_IN_WORKTREE'].includes(err.details.reasons[0].code));
    }
  });

  it('identifies a worktree by the digest of its real path, as the server does', () => {
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    const crypto = require('node:crypto');
    assert.equal(runnerLib.worktreeId(wt), crypto.createHash('sha256').update(fs.realpathSync(wt)).digest('hex'));
  });

  it('earns whole-ms qualified time on the real clocks, so its scorecard validates', async () => {
    const f = fakes([healthy()]);
    const r = runnerLib.createRunner({ publication: fakePub(), base: path.join(tmp, 'v1'), candidateSha: SHA, probes: f.probes });
    await r.start(SPEC);
    await new Promise((resolve) => setTimeout(resolve, 7));
    const state = await r.tick();
    assert.equal(state.state, STATES.RUNNING);
    assert.ok(state.qualifiedMs > 0, `qualifiedMs ${state.qualifiedMs}`);
    assert.ok(Number.isInteger(state.qualifiedMs), `qualifiedMs ${state.qualifiedMs} is not whole ms`);
    const { manifest } = store.readRun(path.join(tmp, 'v1'), SHA);
    const sc = require('../lib/release-certification/scorecard');
    assert.deepEqual(sc.validateScorecard(sc.scorecard(state, manifest, Date.now(), 1)), []);
  });

  it('logs transitions, and extends across a runner restart', async () => {
    const base = path.join(tmp, 'v1');
    const log = [];
    const f = fakes([healthy()]);
    const first = runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: f.probes, clock: f.clock, runnerInstance: 'r1', log: (e) => log.push(e) });
    await first.start(SPEC);
    f.advance(MIN);
    await first.tick();
    f.advance(MIN);
    const second = runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: f.probes, clock: f.clock, runnerInstance: 'r2', log: (e) => log.push(e) });
    const state = await second.tick();
    assert.equal(state.state, STATES.EXTENDED);
    assert.deepEqual(Object.keys(state.extensions), ['MONITOR_GAP']);
    assert.deepEqual(log.filter((e) => e.event === 'transition').map((e) => e.to), ['running', 'extended']);
  });

  it('fails when the owned ttyd generation changed while the runner was down', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy(), healthy({ ttyd: { generation: '9@later' } })]);
    await runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: f.probes, clock: f.clock, runnerInstance: 'r1' }).start(SPEC);
    f.advance(10 * MIN);
    const state = await runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: f.probes, clock: f.clock, runnerInstance: 'r2' }).tick();
    assert.equal(state.state, STATES.FAILED);
    assert.equal(state.failure.code, 'TTYD_GENERATION_CHANGED');
  });

  it('extends on a GitHub error and on an unproven runtime', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy(), healthy({ github: { state: 'unavailable' } }), healthy({ server: { shaBaselineSource: 'late' } })]);
    const r = runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: f.probes, clock: f.clock });
    await r.start(SPEC);
    f.advance(MIN);
    await r.tick();
    f.advance(MIN);
    const state = await r.tick();
    assert.deepEqual(Object.keys(state.extensions).sort(), ['GITHUB_UNAVAILABLE', 'RUNTIME_UNPROVEN']);
  });

  it('runs until terminal, holding and then releasing the single-runner lock', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy(), healthy(), healthy({ worktree: { dirty: true } })]);
    const log = [];
    const r = runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: f.probes, clock: f.clock, log: (e) => log.push(e) });
    await r.start(SPEC);
    const waits = [];
    const state = await r.run({ intervalMs: MIN, wait: async (ms) => { waits.push(ms); f.advance(MIN); } });
    assert.equal(state.state, STATES.FAILED);
    assert.deepEqual(waits, [MIN]);
    assert.equal(fs.existsSync(path.join(store.runPaths(base, SHA).dir, 'runner.lock')), false);
    assert.deepEqual(log.map((e) => e.event).filter((e) => e.startsWith('runner')), ['runner-started', 'runner-stopped']);
  });

  it('refuses a second runner for the same candidate', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy()]);
    const r = runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: f.probes, clock: f.clock });
    await r.start(SPEC);
    const controller = new AbortController();
    let release;
    const gate = new Promise((res) => { release = res; });
    const running = r.run({ intervalMs: MIN, signal: controller.signal, wait: async () => { await gate; } });
    await new Promise((res) => setImmediate(res));
    await rejects(() => runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: f.probes, clock: f.clock }).run({ intervalMs: MIN }), REFUSAL.LOCK_HELD);
    controller.abort();
    release();
    await running;
  });

  it('keeps sampling after a failed tick and logs it', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy()]);
    const log = [];
    const r = runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: f.probes, clock: f.clock, log: (e) => log.push(e) });
    await r.start(SPEC);
    const p = store.runPaths(base, SHA);
    const lockfile = require('../lib/release-certification/lockfile');
    const held = lockfile.acquire(p.lock);
    const controller = new AbortController();
    let n = 0;
    await r.run({ intervalMs: MIN, signal: controller.signal, wait: async () => {
      f.advance(MIN);
      if (++n === 1) lockfile.release(p.lock, held);
      if (n === 2) controller.abort();
    } });
    assert.equal(log.filter((e) => e.event === 'tick-failed')[0].code, REFUSAL.LOCK_HELD);
    assert.equal(store.readRun(base, SHA).state.sampleCount, 2);
  });

  it('stops, rather than keeps sampling, when the evidence has been tampered with', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy()]);
    const log = [];
    const r = runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: f.probes, clock: f.clock, log: (e) => log.push(e) });
    await r.start(SPEC);
    const p = store.runPaths(base, SHA);
    let n = 0;
    await rejects(() => r.run({ intervalMs: MIN, wait: async () => {
      f.advance(MIN);
      if (++n === 1) fs.writeFileSync(p.manifest, fs.readFileSync(p.manifest, 'utf8').replace('"5.30.0"', '"9.9.9"'));
    } }), REFUSAL.MANIFEST_TAMPERED);
    assert.equal(log.filter((e) => e.event === 'tick-failed').at(-1).code, REFUSAL.MANIFEST_TAMPERED);
    assert.equal(fs.existsSync(p.runnerLock), false);
  });

  it('stops at once when signalled mid-interval, not after the interval', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy()]);
    const r = runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: f.probes, clock: f.clock });
    await r.start(SPEC);
    const controller = new AbortController();
    const began = Date.now();
    const running = r.run({ intervalMs: 120_000, signal: controller.signal });
    await new Promise((res) => setTimeout(res, 20));
    controller.abort();
    const state = await running;
    assert.ok(Date.now() - began < 5000);
    assert.equal(state.state, STATES.RUNNING);
  });

  it('records why a probe gave nothing with the sample', async () => {
    const base = path.join(tmp, 'v1');
    let first = true;
    const probeSet = { collect: async () => {
      if (first) { first = false; return { observations: healthy(), diagnostics: {} }; }
      return { observations: healthy({ server: null }), diagnostics: { server: 'http-401' } };
    } };
    const f = fakes([]);
    const r = runnerLib.createRunner({ publication: fakePub(), base, candidateSha: SHA, probes: probeSet, clock: f.clock });
    await r.start(SPEC);
    f.advance(MIN);
    await r.tick();
    assert.deepEqual(store.readSamples(base, SHA).at(-1).diagnostics, { server: 'http-401' });
  });

  it('bounds the sampling interval so one late tick stays inside the interval limit', () => {
    assert.equal(runnerLib.resolveInterval(undefined), MIN);
    assert.throws(() => runnerLib.resolveInterval(121_000), CertificationError);
    assert.throws(() => runnerLib.resolveInterval(14_999), CertificationError);
  });
});

describe('rc-cert CLI', () => {
  /**
   * Run the CLI with captured output.
   * @param {string[]} argv - Arguments
   * @param {object} [extra] - More io
   * @returns {Promise<{code: number, out: string, err: string}>} Result
   */
  async function run(argv, extra = {}) {
    let out = '';
    let err = '';
    const code = await cli.main(argv, {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
      env: {},
      configFile: path.join(tmp, 'missing-config.json'),
      ...extra
    });
    return { code, out, err };
  }

  it('prints usage and exits 2 for a bad command line', async () => {
    assert.equal((await run(['frobnicate'])).code, 2);
    const token = await run(['status', '--sha', SHA, '--token', 'secret']);
    assert.equal(token.code, 2, 'a token on the command line would be visible in ps');
    assert.match(token.err, /TANGLECLAW_SERVICE_TOKEN/);
    assert.equal((await run(['status'])).code, 2);
    assert.equal((await run(['status', '--sha'])).code, 2);
  });

  it('prints a refusal as JSON and exits 3', async () => {
    const r = await run(['status', '--sha', SHA, '--base', path.join(tmp, 'v1')]);
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).error, REFUSAL.RUN_NOT_FOUND);
  });

  it('starts, reports status, and cancels a run through injected probes', async () => {
    const base = path.join(tmp, 'v1');
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'version.json'), '{"version":"5.30.0"}');
    const f = fakes([healthy({ server: { checkoutId: runnerLib.worktreeId(wt) } })]);
    const deps = {
      repository: async () => 'o/r',
      requiredChecks: async () => ['test'],
      publication: fakePub(),
      probes: () => f.probes,
      runner: (ctx) => runnerLib.createRunner({ ...ctx, publication: fakePub(), clock: f.clock })
    };
    const started = await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://127.0.0.1:1'], { deps });
    assert.equal(started.code, 0, started.err);
    assert.equal(store.readRun(base, SHA).manifest.requiredChecksSource, 'branch-protection');
    assert.deepEqual(JSON.parse(started.out), { state: 'running', candidateSha: SHA });
    const status = await run(['status', '--sha', SHA, '--base', base, '--json']);
    assert.equal(JSON.parse(status.out).state, 'running');
    assert.equal(JSON.parse(status.out).canonicalThresholds, true);
    assert.match((await run(['status', '--sha', SHA, '--base', base])).out, /running/);
    assert.equal((await run(['accept', '--sha', SHA, '--base', base, '--actor', 'jason'], { deps })).code, 3);
    assert.deepEqual(JSON.parse((await run(['cancel', '--sha', SHA, '--base', base, '--actor', 'jason'], { deps })).out), { state: 'cancelled', published: true });
    assert.equal(deps.publication.calls.publish, 1, 'the decision is published at once');
    assert.deepEqual(JSON.parse((await run(['list', '--base', base])).out), [SHA]);
  });

  it('runs from what the manifest pinned: repository, required checks and reading age', async () => {
    const base = path.join(tmp, 'v1');
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'version.json'), '{"version":"5.30.0"}');
    const f = fakes([healthy({ server: { checkoutId: runnerLib.worktreeId(wt) } })]);
    const probeCtxs = [];
    let runArgs = null;
    const deps = {
      repository: async () => 'pinned/repo',
      requiredChecks: async () => ['test'],
      publication: fakePub(),
      probes: (ctx) => { probeCtxs.push(ctx); return f.probes; },
      runner: (ctx) => {
        const real = runnerLib.createRunner({ ...ctx, publication: fakePub(), clock: f.clock });
        return { ...real, run: async (args) => {
          runArgs = args;
          sawAbortBefore = args.signal.aborted;
          controller.abort();
          sawAbortAfter = args.signal.aborted;
          return store.readRun(base, SHA).state;
        } };
      }
    };
    const controller = new AbortController();
    let sawAbortBefore = null;
    let sawAbortAfter = null;
    const thresholds = '{"maxIntervalMs":30000}';
    assert.equal((await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://x', '--thresholds', thresholds], { deps })).code, 0);
    const ran = await run(['run', '--sha', SHA, '--base', base, '--api', 'http://x', '--interval', '20000'], {
      deps: { ...deps, repository: async () => { throw new Error('run must not look the repository up'); } },
      signal: controller.signal
    });
    assert.equal(ran.code, 0, ran.err);
    const ctx = probeCtxs.at(-1);
    assert.equal(ctx.repo, 'pinned/repo');
    assert.deepEqual(ctx.requiredChecks, ['test']);
    assert.equal(ctx.maxReadingAgeMs, 30000);
    assert.equal(ctx.worktreePath, wt);
    assert.equal(runArgs.intervalMs, 20000);
    assert.equal(sawAbortBefore, false);
    assert.equal(sawAbortAfter, true, 'the caller\'s stop signal reaches the running loop');
  });

  it('treats a malformed --interval or --thresholds as a usage error', async () => {
    const base = path.join(tmp, 'v1');
    for (const interval of ['abc', '5', '999999']) {
      assert.equal((await run(['run', '--sha', SHA, '--base', base, '--api', 'http://x', '--interval', interval])).code, 2, interval);
    }
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'version.json'), '{"version":"5.30.0"}');
    for (const t of ['null', '[1]', '7']) {
      const r = await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://x', '--repo', 'o/r', '--required-check', 't', '--thresholds', t]);
      assert.equal(r.code, 2, t);
      assert.match(r.err, /--thresholds must be a JSON object/);
    }
  });

  it('publishes on demand, and says so when it could not', async () => {
    const base = path.join(tmp, 'v1');
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'version.json'), '{"version":"5.30.0"}');
    const f = fakes([healthy({ server: { checkoutId: runnerLib.worktreeId(wt) } })]);
    const pub = fakePub();
    const deps = { repository: async () => 'o/r', requiredChecks: async () => ['test'], publication: pub, probes: () => f.probes, runner: (ctx) => runnerLib.createRunner({ ...ctx, clock: f.clock }) };
    assert.equal((await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://x', '--no-publish-actor', '--required-check', 'test'], { deps })).code, 0);
    assert.equal(pub.calls.admit[0].manifest.publishActor, false, 'the actor setting is pinned in the manifest');
    assert.equal(pub.calls.admit[0].manifest.requiredChecksSource, 'operator', 'hand-named checks are recorded as an operator override');
    const ok = await run(['publish', '--sha', SHA, '--base', base], { deps });
    assert.deepEqual([ok.code, JSON.parse(ok.out)], [0, { published: true }]);
    const failing = fakePub({ publishCurrent: async (log) => { log({ event: 'publish-failed', code: 'PUBLISH_FAILED' }); return { published: false, code: 'PUBLISH_FAILED' }; } });
    const bad = await run(['publish', '--sha', SHA, '--base', base], { deps: { ...deps, publication: failing } });
    assert.deepEqual([bad.code, JSON.parse(bad.out)], [3, { published: false }]);
    assert.match(bad.err, /publish-failed/);
    const status = JSON.parse((await run(['status', '--sha', SHA, '--base', base, '--json'])).out);
    assert.deepEqual(Object.keys(status.publication).sort(), ['admissionVerifiedAt', 'failures', 'lastError', 'lastMessage', 'lastPublishedAt', 'lastPublishedSeq', 'nextAttemptAt']);
  });

  it('refuses to start when main requires no checks', async () => {
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'version.json'), '{"version":"5.30.0"}');
    const r = await run(['start', '--sha', SHA, '--worktree', wt, '--base', path.join(tmp, 'v1'), '--api', 'http://x'], {
      deps: { repository: async () => 'o/r', requiredChecks: async () => [] }
    });
    assert.equal(r.code, 2);
    assert.match(r.err, /requires no checks/);
  });

  it('marks a run with overridden thresholds as unable to certify', async () => {
    const base = path.join(tmp, 'v1');
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'version.json'), '{"version":"5.30.0"}');
    const f = fakes([healthy({ server: { checkoutId: runnerLib.worktreeId(wt) } })]);
    const deps = { repository: async () => 'o/r', requiredChecks: async () => ['test'], publication: fakePub(), probes: () => f.probes, runner: (ctx) => runnerLib.createRunner({ ...ctx, publication: fakePub(), clock: f.clock }) };
    await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://x', '--thresholds', '{"targetQualifiedMs":600000}'], { deps });
    assert.equal(JSON.parse((await run(['status', '--sha', SHA, '--base', base, '--json'])).out).canonicalThresholds, false);
    assert.equal((await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://x', '--thresholds', '{bad'], { deps })).code, 2);
  });

  it('resolves the base from the flag, then config.json, and refuses a relative configured base', () => {
    const cfg = path.join(tmp, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ releaseCertification: { baseDir: '/srv/rc' } }));
    assert.equal(cli.resolveBase({}, cfg), '/srv/rc');
    assert.equal(cli.resolveBase({ base: '/flag' }, cfg), '/flag');
    fs.writeFileSync(cfg, JSON.stringify({ releaseCertification: { baseDir: 'relative' } }));
    assert.throws(() => cli.resolveBase({}, cfg), (e) => e.code === REFUSAL.STORE_UNSAFE);
    assert.equal(cli.resolveBase({}, path.join(tmp, 'none.json')), store.defaultBase());
    fs.writeFileSync(cfg, '{not json');
    assert.throws(() => cli.resolveBase({}, cfg), (e) => e.code === REFUSAL.STORE_UNSAFE);
    const dirAsConfig = path.join(tmp, 'a-directory');
    fs.mkdirSync(dirAsConfig);
    assert.throws(() => cli.resolveBase({}, dirAsConfig), (e) => e.code === REFUSAL.STORE_UNSAFE, 'an unreadable config is a refusal, not a crash');
  });
});

describe('runner: host-attested checks and admission (#2020 Q1, A31, A32)', () => {
  const hostChecks = require('../lib/release-certification/host-checks');
  const isolation = require('../lib/release-certification/isolation');
  const SPEC_HA = { ...SPEC, checksSource: 'host-attested' };

  /**
   * A runner whose checks come from the host through the real exchange.
   * The host answers whenever the guest waits, unless `answering` is false.
   * @param {object} [opts] - `{answering, observation, script, pub}`
   * @returns {object} `{r, f, base, exchange, hostBase, requests, ghCalls}`
   */
  function hostAttested(opts = {}) {
    const base = path.join(tmp, 'v1');
    const exchange = path.join(tmp, 'exchange');
    const hostBase = path.join(tmp, 'host');
    const f = fakes(opts.script || [healthy()]);
    const requests = [];
    let i = 0;
    const script = opts.script || [healthy()];
    const probesStub = {
      collect: async (now, binding) => {
        if (binding) requests.push(binding);
        const checks = await hostChecks.attest({ candidateSha: SHA, runId: fx.RUN_ID, exchangeDir: exchange, hostVerdictWaitMs: 2000, maxReadingAgeMs: 150_000 }, binding, {
          now: f.clock.wall,
          sleep: async (ms) => {
            if (opts.answering !== false) {
              await hostChecks.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, now: f.clock.wall, observe: async () => ({ observation: opts.observation || { state: 'ok', checks: { test: 'success' } }, error: null }) });
            }
            f.advance(ms);
          }
        });
        // The guest's isolation, attested for the same sample through the real judge.
        const iso = binding ? await isolation.attest((b) => fx.isolationPair(b), { candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: binding.manifestDigest, sampleSeq: binding.seq }) : { observation: { state: 'unavailable' } };
        const o = iso.observation;
        const observations = { ...script[Math.min(i++, script.length - 1)], github: checks.observation, isolation: o };
        return {
          observations, diagnostics: checks.error ? { github: checks.error } : {},
          ...(checks.binding ? { checks: checks.binding } : {}),
          ...(o.state !== 'unavailable' ? { isolation: { sampleSeq: binding.seq, bootId: o.bootId, adminDigest: o.adminDigest, workloadDigest: o.workloadDigest } } : {})
        };
      }
    };
    hostChecks.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test'] }, { random: () => fx.RUN_ID });
    // Every read moves the clock on, as a real one does, so two samples taken
    // concurrently still carry distinct times.
    const ticking = { wall: f.clock.wall, mono: () => { f.advance(1); return f.clock.mono(); } };
    const r = runnerLib.createRunner({ publication: opts.pub || fakePub(), base, candidateSha: SHA, probes: probesStub, clock: ticking });
    return { r, f, base, exchange, hostBase, requests };
  }
  const specFor = (h) => ({ ...SPEC_HA, checksExchange: h.exchange, remoteUrl: path.join(tmp, 'metrics.git'), isolationProducer: '/x/guest-setup.sh' });

  it('admits only on a verdict bound to the staged manifest, then binds every sample to its own number', async () => {
    const h = hostAttested();
    const state = await h.r.start(specFor(h), NOW);
    assert.equal(state.state, STATES.RUNNING);
    assert.deepEqual(h.requests, [{ seq: 1, manifestDigest: state.manifestDigest }], 'admission asked about the staged manifest, as sample 1');
    for (let n = 0; n < 2; n++) {
      h.f.advance(MIN);
      await h.r.tick();
    }
    const samples = store.readSamples(h.base, SHA);
    assert.deepEqual(samples.map((s) => s.checks && s.checks.sampleSeq), [1, 2, 3]);
    assert.deepEqual(h.requests.map((b) => b.seq), [1, 2, 3]);
    assert.ok(h.requests.every((b) => b.manifestDigest === state.manifestDigest));
    const { manifest } = store.readRun(h.base, SHA);
    assert.deepEqual([manifest.runId, manifest.checksSource, manifest.private.checksExchange], [fx.RUN_ID, 'host-attested', h.exchange]);
    const out = await hostChecks.finalize({ hostBase: h.hostBase, manifest, manifestDigest: state.manifestDigest, state: { ...store.readRun(h.base, SHA).state, state: 'awaiting-review' }, samples, observe: async () => ({ observation: { state: 'ok', checks: { test: 'success' } }, error: null }) });
    assert.deepEqual(out, { ok: true, reasons: [] }, 'the host can vouch for every earning sample this run took');
  });

  it('refuses admission when no host answers, and no run or time exists', async () => {
    const h = hostAttested({ answering: false });
    const err = await rejects(() => h.r.start(specFor(h), NOW), REFUSAL.ADMISSION_REFUSED);
    assert.ok(err.details.reasons.some((x) => x.code === 'GITHUB_UNAVAILABLE'));
    assert.deepEqual(store.listRuns(h.base), []);
  });

  it('extends rather than earns when the host reports checks still pending, and fails on a failed check', async () => {
    const pending = hostAttested({ observation: { state: 'ok', checks: { test: 'pending' } } });
    await rejects(() => pending.r.start(specFor(pending), NOW), REFUSAL.ADMISSION_REFUSED);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    const failed = hostAttested({ observation: { state: 'ok', checks: { test: 'failure' } } });
    const err = await rejects(() => failed.r.start(specFor(failed), NOW), REFUSAL.ADMISSION_REFUSED);
    assert.ok(err.details.reasons.some((x) => x.code === 'REQUIRED_CHECK_FAILED'));
  });

  it('drops a verdict bound to a sample number another commit took first', async () => {
    const h = hostAttested();
    await h.r.start(specFor(h), NOW);
    h.f.advance(MIN);
    await Promise.all([h.r.tick(), h.r.tick()]);
    const samples = store.readSamples(h.base, SHA);
    assert.equal(samples.length, 3);
    const moved = samples[2];
    assert.equal(moved.checks, undefined, 'the second commit carries no binding');
    assert.equal(moved.observations.github.state, 'unavailable');
    assert.equal(moved.diagnostics.github, 'host-verdict-seq-moved');
    assert.equal(moved.isolation, undefined, 'its isolation attestations were bound to the same number, so they go too');
    assert.deepEqual(moved.observations.isolation, { state: 'unavailable' });
    assert.equal(moved.diagnostics.isolation, 'host-verdict-seq-moved');
    assert.ok(samples[1].isolation, 'the first commit keeps its own');
  });

  it('never reads GitHub in host-attested mode, and forwards the sample binding to the host', async () => {
    const seen = [];
    const p = probes.createProbes({ apiBase: 'http://x', worktreePath: '/w', candidateSha: SHA, repo: 'o/r', requiredChecks: ['test'], maxReadingAgeMs: 1, checksSource: 'host-attested', runId: fx.RUN_ID, exchangeDir: '/x' }, {
      fetchJson: async () => ({ body: null, error: 'connect-failed' }),
      measure: async () => null,
      ghJson: async () => { throw new Error('GitHub must not be read from a host-attested runner'); },
      attest: async (ctx, binding) => { seen.push(binding); return { observation: { state: 'ok', checks: { test: 'success' } }, error: null, binding: { sampleSeq: 4, verdictDigest: 'd'.repeat(64) } }; }
    });
    const out = await p.collect(T0, { seq: 4, manifestDigest: 'e'.repeat(64) });
    assert.deepEqual(seen, [{ seq: 4, manifestDigest: 'e'.repeat(64) }]);
    assert.deepEqual(out.checks, { sampleSeq: 4, verdictDigest: 'd'.repeat(64) });
    assert.deepEqual(out.observations.github, { state: 'ok', checks: { test: 'success' } });
  });
});

describe('runner: a crash between publishing and committing never uses up the candidate (R-3, ADR 0021 point 3)', () => {
  it('reuses the public manifest after a reboot, and baselines the ttyd generation it now observes', async () => {
    const base = path.join(tmp, 'v1');
    const AFTER = '5151@Mon Sep 28 10:00:00 2026';
    let staged = null;
    const crashing = fakePub({ admit: async (m, digest) => { staged = digest; throw new CertificationError(REFUSAL.PUBLISH_FAILED, 'crashed after the push, before the read-back'); } });
    const before = fakes([healthy()]);
    await rejects(() => runnerLib.createRunner({ publication: crashing, base, candidateSha: SHA, probes: before.probes, clock: before.clock }).start(SPEC, NOW), REFUSAL.PUBLISH_FAILED);
    const rebooted = fakes([healthy({ ttyd: { generation: AFTER } }), healthy({ ttyd: { generation: AFTER } }), healthy()]);
    rebooted.advance(10 * MIN);
    const retry = runnerLib.createRunner({ publication: fakePub({ publishedDigest: async () => staged }), base, candidateSha: SHA, probes: rebooted.probes, clock: rebooted.clock });
    const state = await retry.start(SPEC, NOW);
    assert.equal(state.state, STATES.RUNNING, 'the retry admitted instead of refusing the candidate for a ttyd that changed before the run existed');
    assert.equal(state.manifestDigest, staged, 'it kept the manifest whose admission is public');
    assert.equal(state.baseline.ttydGeneration, AFTER);
    rebooted.advance(MIN);
    assert.equal((await retry.tick()).state, STATES.RUNNING);
    rebooted.advance(MIN);
    const failed = await retry.tick();
    assert.equal(failed.state, STATES.FAILED, 'a generation change during the run still fails it');
    assert.equal(failed.failure.code, 'TTYD_GENERATION_CHANGED');
  });
});

describe('runner: a loop error survives a failing final publish (O-2)', () => {
  it('surfaces MANIFEST_TAMPERED even when the final publish throws too', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy()]);
    const throwing = fakePub({ publishCurrent: async () => { throw new CertificationError(REFUSAL.PUBLISH_FAILED, 'boom'); } });
    const r = runnerLib.createRunner({ publication: throwing, base, candidateSha: SHA, probes: f.probes, clock: f.clock });
    await r.start(SPEC, NOW);
    const paths = store.runPaths(base, SHA);
    fs.chmodSync(paths.manifest, 0o600);
    fs.writeFileSync(paths.manifest, fs.readFileSync(paths.manifest, 'utf8').replace('"h"', '"tampered"'));
    f.advance(MIN);
    await rejects(() => r.run({ intervalMs: MIN, wait: async () => f.advance(MIN) }), REFUSAL.MANIFEST_TAMPERED);
  });
});

describe('rc-cert CLI: run ids and the host commands (#2020 Q1)', () => {
  const hostChecks = require('../lib/release-certification/host-checks');
  /**
   * Run the CLI with captured output.
   * @param {string[]} argv - Arguments
   * @param {object} [extra] - More io
   * @returns {Promise<{code: number, out: string, err: string}>} Result
   */
  async function run(argv, extra = {}) {
    let out = '';
    let err = '';
    const code = await cli.main(argv, { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, env: {}, configFile: path.join(tmp, 'missing-config.json'), ...extra });
    return { code, out, err };
  }
  /**
   * A candidate worktree carrying a version.
   * @returns {string} Path
   */
  function worktree() {
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'version.json'), '{"version":"5.30.0"}');
    return wt;
  }
  const GREEN = async () => ({ observation: { state: 'ok', checks: { test: 'success' } }, error: null });

  it('mints a fresh 128-bit run id when it is its own host (gh checks)', async () => {
    const base = path.join(tmp, 'v1');
    const wt = worktree();
    const f = fakes([healthy({ server: { checkoutId: runnerLib.worktreeId(wt) } })]);
    const deps = { repository: async () => 'o/r', requiredChecks: async () => ['test'], publication: fakePub(), probes: () => f.probes, runner: (ctx) => runnerLib.createRunner({ ...ctx, publication: fakePub(), clock: f.clock }) };
    assert.equal((await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://127.0.0.1:1'], { deps })).code, 0);
    const { manifest } = store.readRun(base, SHA);
    assert.match(manifest.runId, /^[0-9a-f]{32}$/);
    assert.equal(manifest.checksSource, 'gh');
  });

  it('refuses a host-attested start missing anything only the host can supply', async () => {
    const wt = worktree();
    const full = ['start', '--sha', SHA, '--worktree', wt, '--api', 'http://x', '--checks-source', 'host-attested', '--repo', 'o/r', '--required-check', 'test', '--metrics-remote', path.join(tmp, 'm.git'), '--isolation-producer', path.join(tmp, 'g'), '--run-id', fx.RUN_ID, '--exchange', path.join(tmp, 'x')];
    for (const drop of ['--repo', '--required-check', '--metrics-remote', '--isolation-producer', '--run-id', '--exchange']) {
      const i = full.indexOf(drop);
      const argv = [...full.slice(0, i), ...full.slice(i + 2)];
      assert.equal((await run(argv)).code, 2, `missing ${drop}`);
    }
    assert.equal((await run([...full.slice(0, -4), '--run-id', 'short', '--exchange', path.join(tmp, 'x')])).code, 2, 'a malformed run id');
    assert.equal((await run(['start', '--sha', SHA, '--worktree', wt, '--api', 'http://x', '--checks-source', 'github'])).code, 2, 'an unknown checks source');
  });

  it('carries a host-attested run from mint to finalization through the CLI alone', async () => {
    const base = path.join(tmp, 'v1');
    const hostBase = path.join(tmp, 'host');
    const exchange = path.join(tmp, 'exchange');
    const wt = worktree();
    const minted = await run(['host-mint', '--sha', SHA, '--repo', 'o/r', '--required-check', 'test', '--host-base', hostBase]);
    assert.equal(minted.code, 0, minted.err);
    const { runId } = JSON.parse(minted.out);
    const f = fakes([healthy()]);
    const ticking = { wall: f.clock.wall, mono: () => { f.advance(1); return f.clock.mono(); } };
    const probeCtxs = [];
    // The real probes in host-attested mode; the host answers through its own
    // CLI command whenever the guest waits for a verdict.
    const guestProbes = (ctx) => {
      probeCtxs.push(ctx);
      return probes.createProbes(ctx, {
        fetchJson: async () => ({ body: null, error: 'connect-failed' }),
        measure: async () => null,
        ghJson: async () => { throw new Error('the guest must not read GitHub'); },
        verifyNetwork: async (b) => fx.isolationPair(b),
        attest: (c, b) => hostChecks.attest(c, b, { now: f.clock.wall, sleep: async (ms) => { await run(['host-checks', '--sha', SHA, '--exchange', exchange, '--host-base', hostBase], { deps: { observeGithub: GREEN } }); f.advance(ms); } })
      });
    };
    // PTY use counts from the admission baseline, so each sample reports one
    // more terminal attached and detached than the last.
    let used = 0;
    const observed = () => { used++; return healthy({ server: { checkoutId: runnerLib.worktreeId(wt) }, pty: { attaches: used, detaches: used, lastAt: f.clock.wall() } }); };
    const deps = {
      publication: fakePub(),
      probes: (ctx) => {
        const real = guestProbes(ctx);
        return { collect: async (now, b) => { const out = await real.collect(now, b); return { ...out, observations: { ...observed(), github: out.observations.github, isolation: out.observations.isolation } }; } };
      },
      runner: (ctx) => runnerLib.createRunner({ ...ctx, publication: fakePub(), clock: ticking })
    };
    const TH = JSON.stringify({ targetQualifiedMs: 2 * MIN, ptyMinAttaches: 1, ptyMinDetaches: 1, ptyMinSpanMs: 1 });
    const started = await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://127.0.0.1:1', '--checks-source', 'host-attested', '--repo', 'o/r', '--required-check', 'test', '--run-id', runId, '--exchange', exchange, '--metrics-remote', path.join(tmp, 'metrics.git'), '--isolation-producer', '/x/guest-setup.sh', '--thresholds', TH], { deps });
    assert.equal(started.code, 0, started.err);
    assert.deepEqual([probeCtxs[0].checksSource, probeCtxs[0].runId, probeCtxs[0].exchangeDir], ['host-attested', runId, exchange]);
    const controller = new AbortController();
    let ticks = 0;
    const running = await run(['run', '--sha', SHA, '--base', base, '--api', 'http://127.0.0.1:1', '--interval', '60000'], {
      signal: controller.signal,
      deps: { ...deps, runner: (ctx) => {
        const real = runnerLib.createRunner({ ...ctx, publication: fakePub(), clock: ticking });
        return { ...real, run: (a) => real.run({ ...a, wait: async () => { f.advance(MIN); if (++ticks >= 4) controller.abort(); } }) };
      } }
    });
    assert.equal(running.code, 0, running.err);
    assert.deepEqual([probeCtxs[1].checksSource, probeCtxs[1].runId, probeCtxs[1].exchangeDir], ['host-attested', runId, exchange], 'run reads them from the pinned manifest');
    assert.equal(store.readRun(base, SHA).state.state, 'awaiting-review');
    const fin = await run(['host-finalize', '--sha', SHA, '--base', base, '--host-base', hostBase], { deps: { observeGithub: GREEN } });
    assert.equal(fin.code, 0, fin.out + fin.err);
    assert.deepEqual(JSON.parse(fin.out), { ok: true, reasons: [] });
    const drifted = await run(['host-finalize', '--sha', SHA, '--base', base, '--host-base', hostBase], { deps: { observeGithub: async () => ({ observation: { state: 'ok', checks: { test: 'failure' } }, error: null }) } });
    assert.equal(drifted.code, 3);
    assert.deepEqual(JSON.parse(drifted.out).reasons, [{ code: 'FINAL_CHECKS_NOT_GREEN' }]);
  });
});
