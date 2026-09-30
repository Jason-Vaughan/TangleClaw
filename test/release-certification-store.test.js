'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const privateFs = require('../lib/release-certification/private-fs');
const lockfile = require('../lib/release-certification/lockfile');
const store = require('../lib/release-certification/store');
const sm = require('../lib/release-certification/state-machine');
const { STATES, REFUSAL, CertificationError } = require('../lib/release-certification/codes');
const fx = require('./_release-certification-fixtures');

const { SHA, GEN, MIN } = fx;


let tmp;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-store-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Assert a thunk throws a CertificationError with a code.
 * @param {Function} fn - Thunk
 * @param {string} code - Expected code
 * @returns {CertificationError} The error
 */
function refuses(fn, code) {
  let caught = null;
  try { fn(); } catch (err) { caught = err; }
  assert.ok(caught instanceof CertificationError, `expected ${code}, got ${caught}`);
  assert.equal(caught.code, code);
  return caught;
}

/**
 * The permission bits of a path.
 * @param {string} p - Path
 * @returns {number} Mode & 0o777
 */
function mode(p) {
  return fs.statSync(p).mode & 0o777;
}

/**
 * Run a function under a temporary umask.
 * @param {number} mask - Umask
 * @param {Function} fn - Thunk
 * @returns {void}
 */
function withUmask(mask, fn) {
  const old = process.umask(mask);
  try { fn(); } finally { process.umask(old); }
}

/**
 * A manifest.
 * @returns {object} Manifest
 */
function manifest() {
  return fx.manifest({ createdAt: 1000, worktreePath: '/tmp/rc-wt' });
}

/**
 * A healthy sample; `over` replaces whole probe observations.
 * @param {number} t - Offset in ms
 * @param {object} [over] - Probe observations to replace
 * @returns {object} Sample
 */
function sample(t, over = {}) {
  return fx.sample(t, { ...fx.observations(), ...over });
}

/**
 * Create a run in the temp base.
 * @returns {{base: string, m: object}} Base and manifest
 */
function created() {
  const base = path.join(tmp, 'v1');
  const m = manifest();
  const s = sample(0);
  store.createRun(base, m, sm.admit(m, s), s);
  return { base, m };
}

/**
 * Fold one sample into a stored run.
 * @param {string} base - Evidence base
 * @param {object} s - Sample
 * @returns {object} Committed state
 */
function tick(base, s) {
  return store.updateRun(base, SHA, (state, m) => {
    const out = sm.reduce(state, m, s);
    return { state: out.state, events: out.events, record: store.sampleRecord(out.state.sampleCount, s, out.verdict, out.interval) };
  });
}

describe('private-fs', () => {
  for (const mask of [0o000, 0o022, 0o277]) {
    it(`makes 0700 directories and 0600 files under umask ${mask.toString(8)}`, () => {
      withUmask(mask, () => {
        const dir = privateFs.ensurePrivateDir(path.join(tmp, 'a', 'b'));
        privateFs.writeOnce(path.join(dir, 'once'), 'x');
        privateFs.replaceAtomic(path.join(dir, 'swap'), 'y');
        privateFs.appendLine(path.join(dir, 'log'), '{}');
        assert.equal(mode(dir), 0o700);
        for (const f of ['once', 'swap', 'log']) assert.equal(mode(path.join(dir, f)), 0o600, f);
      });
    });
  }

  it('tightens a loose directory and refuses a symlinked one', () => {
    const loose = path.join(tmp, 'loose');
    fs.mkdirSync(loose, { mode: 0o755 });
    fs.chmodSync(loose, 0o755);
    privateFs.ensurePrivateDir(loose);
    assert.equal(mode(loose), 0o700);
    fs.symlinkSync(loose, path.join(tmp, 'link'));
    refuses(() => privateFs.ensurePrivateDir(path.join(tmp, 'link')), REFUSAL.STORE_UNSAFE);
  });

  it('writes once and never overwrites', () => {
    const f = path.join(tmp, 'm');
    assert.equal(privateFs.writeOnce(f, 'first'), true);
    assert.equal(privateFs.writeOnce(f, 'second'), false);
    assert.equal(fs.readFileSync(f, 'utf8'), 'first');
  });

  it('replaces a planted symlink instead of writing through it, and refuses to read one', () => {
    const outside = path.join(tmp, 'outside');
    fs.writeFileSync(outside, 'keep');
    const target = path.join(tmp, 'state.json');
    fs.symlinkSync(outside, target);
    refuses(() => privateFs.readPrivate(target), REFUSAL.STORE_UNSAFE);
    privateFs.replaceAtomic(target, 'new');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  });

  it('refuses to append through a symlink', () => {
    const outside = path.join(tmp, 'outside');
    fs.writeFileSync(outside, '');
    fs.symlinkSync(outside, path.join(tmp, 'log'));
    refuses(() => privateFs.appendLine(path.join(tmp, 'log'), '{}'), REFUSAL.STORE_UNSAFE);
  });

  it('drops a torn final line on read and cuts it off on the next append', () => {
    const f = path.join(tmp, 'log');
    fs.writeFileSync(f, '{"a":1}\n{"b":', { mode: 0o600 });
    assert.deepEqual(privateFs.readLines(f), { records: [{ a: 1 }], tornTail: true });
    privateFs.appendLine(f, '{"c":3}');
    assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}\n{"c":3}\n');
    assert.deepEqual(privateFs.readLines(f), { records: [{ a: 1 }, { c: 3 }], tornTail: false });
  });

  it('cuts off a torn tail longer than one read chunk', () => {
    const f = path.join(tmp, 'log');
    fs.writeFileSync(f, `{"a":1}\n${'x'.repeat(200 * 1024)}`, { mode: 0o600 });
    privateFs.appendLine(f, '{"c":3}');
    assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}\n{"c":3}\n');
  });

  it('refuses a damaged record before the end, and a multi-line record', () => {
    const f = path.join(tmp, 'log');
    fs.writeFileSync(f, '{"a":1}\nnot json\n{"b":2}\n', { mode: 0o600 });
    refuses(() => privateFs.readLines(f), REFUSAL.EVIDENCE_CORRUPT);
    refuses(() => privateFs.appendLine(f, '{\n}'), REFUSAL.INVALID_SAMPLE);
  });
});

describe('lockfile', () => {
  /**
   * Environment for lock tests.
   * @param {object} [over] - Overrides
   * @returns {object} Deps
   */
  const deps = (over = {}) => ({ hostname: () => 'this-host', machine: () => 'darwin:M1', isAlive: () => true, bootTime: () => 0, processStart: () => null, now: () => Date.now(), sleep: () => {}, ...over });
  /**
   * Plant a lock record.
   * @param {object} record - Fields
   * @returns {string} Lock path
   */
  const plant = (record) => {
    const file = path.join(tmp, 'lock');
    fs.writeFileSync(file, JSON.stringify({ pid: 99999, machine: 'darwin:M1', host: 'this-host', writtenAt: 5000, token: 'old', ...record }));
    return file;
  };

  it('grants one holder, refuses a second, and releases only for its own token', () => {
    const file = path.join(tmp, 'lock');
    const token = lockfile.acquire(file, { deps: deps() });
    const err = refuses(() => lockfile.acquire(file, { timeoutMs: 0, deps: deps() }), REFUSAL.LOCK_HELD);
    assert.equal(err.details.pid, process.pid);
    assert.equal(lockfile.release(file, 'not-mine'), false);
    assert.equal(fs.existsSync(file), true);
    assert.equal(lockfile.release(file, token), true);
    assert.equal(fs.existsSync(file), false);
  });

  it('waits for a holder until the timeout', () => {
    const file = path.join(tmp, 'lock');
    lockfile.acquire(file, { deps: deps() });
    let t = 0;
    let slept = 0;
    refuses(() => lockfile.acquire(file, { timeoutMs: 200, deps: deps({ now: () => t, sleep: (ms) => { slept += 1; t += ms; } }) }), REFUSAL.LOCK_HELD);
    assert.equal(slept, 4);
  });

  for (const [name, record, env] of [
    ['a dead holder', {}, { isAlive: () => false }],
    ['a holder from before this boot', { writtenAt: 5000 }, { bootTime: () => 100_000 }],
    ['a reused pid', { writtenAt: 5000 }, { processStart: () => 60_000 }]
  ]) {
    it(`reclaims the lock of ${name}`, () => {
      const file = plant(record);
      const token = lockfile.acquire(file, { timeoutMs: 0, deps: deps(env) });
      assert.equal(lockfile.readRecord(file).token, token);
    });
  }

  it('puts back a lock taken fresh between judging the old one stale and moving it', () => {
    const file = plant({});
    let calls = 0;
    const reclaimed = [];
    const isAlive = () => {
      calls += 1;
      if (calls > 1) return true;
      fs.writeFileSync(file, JSON.stringify({ pid: 12345, host: 'this-host', writtenAt: Date.now(), token: 'fresh' }));
      return false;
    };
    refuses(() => lockfile.acquire(file, { timeoutMs: 0, deps: deps({ isAlive }), onReclaim: (r) => reclaimed.push(r) }), REFUSAL.LOCK_HELD);
    assert.equal(lockfile.readRecord(file).token, 'fresh');
    assert.deepEqual(reclaimed, []);
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.includes('.stale.')), []);
  });

  it('reports each stale lock it reclaims', () => {
    const file = plant({ pid: 777 });
    const reclaimed = [];
    lockfile.acquire(file, { timeoutMs: 0, deps: deps({ isAlive: () => false }), onReclaim: (r) => reclaimed.push(r) });
    assert.deepEqual(reclaimed, [{ pid: 777, machine: 'darwin:M1', host: 'this-host', writtenAt: 5000 }]);
  });

  it('never reclaims a lock from another machine', () => {
    const file = plant({ machine: 'darwin:OTHER', host: 'this-host' });
    refuses(() => lockfile.acquire(file, { timeoutMs: 0, deps: deps({ isAlive: () => false }) }), REFUSAL.LOCK_HELD);
  });

  it('still reclaims a dead lock after this machine was renamed', () => {
    const file = plant({ host: 'old-name.local' });
    const token = lockfile.acquire(file, { timeoutMs: 0, deps: deps({ hostname: () => 'new-name.local', isAlive: () => false }) });
    assert.equal(lockfile.readRecord(file).token, token);
    assert.equal(lockfile.readRecord(file).machine, 'darwin:M1');
  });

  it('falls back to the host name for a lock that names no machine', () => {
    const file = path.join(tmp, 'lock');
    fs.writeFileSync(file, JSON.stringify({ pid: 99999, host: 'elsewhere', writtenAt: 5000, token: 'old' }));
    refuses(() => lockfile.acquire(file, { timeoutMs: 0, deps: deps({ isAlive: () => false }) }), REFUSAL.LOCK_HELD);
    fs.writeFileSync(file, JSON.stringify({ pid: 99999, host: 'this-host', writtenAt: 5000, token: 'old' }));
    assert.equal(typeof lockfile.acquire(file, { timeoutMs: 0, deps: deps({ isAlive: () => false }) }), 'string');
  });

  it('reads a stable machine id', () => {
    assert.match(lockfile.machineId(), /^(darwin|linux|host):.+/);
    assert.equal(lockfile.machineId(), lockfile.machineId());
  });

  it('reclaims an unreadable lock only once it is old enough to be a crash', () => {
    const file = path.join(tmp, 'lock');
    fs.writeFileSync(file, '');
    refuses(() => lockfile.acquire(file, { timeoutMs: 0, deps: deps() }), REFUSAL.LOCK_HELD);
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(file, old, old);
    assert.equal(typeof lockfile.acquire(file, { timeoutMs: 0, deps: deps() }), 'string');
  });

  it('tells a holder its lock was lost', () => {
    const file = path.join(tmp, 'lock');
    const token = lockfile.acquire(file, { deps: deps() });
    lockfile.assertHeld(file, token);
    fs.writeFileSync(file, JSON.stringify({ token: 'someone-else' }));
    refuses(() => lockfile.assertHeld(file, token), REFUSAL.LOCK_LOST);
  });
});

describe('store', () => {
  it('creates a private run with manifest, state, first sample and admission snapshot', () => {
    const { base, m } = created();
    const p = store.runPaths(base, SHA);
    assert.equal(mode(base), 0o700);
    assert.equal(mode(p.dir), 0o700);
    assert.equal(mode(p.snapshots), 0o700);
    for (const f of [p.manifest, p.state, p.samples]) assert.equal(mode(f), 0o600);
    assert.equal(fs.existsSync(p.lock), false);
    const run = store.readRun(base, SHA);
    assert.deepEqual(run.manifest, m);
    assert.equal(run.state.state, STATES.RUNNING);
    assert.match(run.state.manifestDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(store.readSamples(base, SHA).map((r) => r.seq), [1]);
    const snaps = store.readSnapshots(base, SHA);
    assert.deepEqual(snaps.map((s) => [s.event.code, s.event.to]), [['ADMITTED', 'running']]);
    assert.equal(snaps[0].manifestDigest, run.state.manifestDigest);
    assert.deepEqual(store.listRuns(base), [SHA]);
  });

  it('stages by what the metrics branch holds: fresh when unpublished, reused when its admission is public', () => {
    const base = path.join(tmp, 'v1');
    const facts = [];
    const onRecover = (f) => facts.push(f.kind);
    const later = sm.buildManifest({ ...manifest(), worktreePath: '/tmp/rc-wt', worktreeId: 'c'.repeat(64), ttydGeneration: GEN, createdAt: 9999 });
    const first = store.stageManifest(base, manifest(), null, { onRecover });
    assert.equal(first.reused, false);
    assert.equal(first.digest, store.manifestDigest(store.manifestText(manifest())));
    const unpublished = store.stageManifest(base, later, null, { onRecover });
    assert.equal(unpublished.reused, false);
    assert.notEqual(unpublished.digest, first.digest, 'an admission nobody published leaves no settings behind');
    const again = store.stageManifest(base, manifest(), unpublished.digest, { onRecover });
    assert.equal(again.reused, true);
    assert.equal(again.digest, unpublished.digest, 'a public admission pins the staged manifest');
    refuses(() => store.stageManifest(base, manifest(), 'e'.repeat(64)), REFUSAL.ADMISSION_CONFLICT);
    assert.deepEqual(facts, ['unpublished-staged-manifest-replaced', 'staged-manifest-reused']);
    const s = sample(0);
    const state = store.createRun(base, again.manifest, sm.admit(again.manifest, s), s, { onRecover });
    assert.equal(state.manifestDigest, unpublished.digest);
    assert.equal(facts.length, 2, 'committing the staged bytes is not a recovery');
    refuses(() => store.stageManifest(base, manifest(), null), REFUSAL.RUN_EXISTS);
  });

  it('keeps a numbered transition log that the committed state counts', () => {
    const { base } = created();
    tick(base, sample(MIN, { server: null }));
    tick(base, sample(2 * MIN));
    tick(base, sample(3 * MIN));
    const { state, paths: p } = store.readRun(base, SHA);
    assert.equal(state.transitionCount, 3);
    assert.deepEqual(store.readTransitions(base, SHA).map((e) => e.to), ['running', 'extended', 'running']);
    privateFs.appendLine(p.transitions, JSON.stringify({ n: 4, event: { to: 'failed' } }));
    fs.rmSync(p.snapshots, { recursive: true });
    assert.deepEqual(store.readTransitions(base, SHA).map((e) => e.to), ['running', 'extended', 'running'], 'uncommitted lines are ignored and lost snapshots do not matter');
    assert.equal(mode(p.transitions), 0o600);
  });

  it('refuses a second run for the same candidate', () => {
    const { base, m } = created();
    const s = sample(0);
    refuses(() => store.createRun(base, m, sm.admit(m, s), s), REFUSAL.RUN_EXISTS);
  });

  it('completes a start that crashed after writing only the manifest', () => {
    const base = path.join(tmp, 'v1');
    const p = store.runPaths(base, SHA);
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(p.manifest, '{"half":');
    const m = manifest();
    const s = sample(0);
    store.createRun(base, m, sm.admit(m, s), s);
    assert.deepEqual(store.readRun(base, SHA).manifest, m);
  });

  it('refuses a symlinked base', () => {
    const real = path.join(tmp, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tmp, 'v1'));
    const m = manifest();
    const s = sample(0);
    refuses(() => store.createRun(path.join(tmp, 'v1'), m, sm.admit(m, s), s), REFUSAL.STORE_UNSAFE);
  });

  it('folds samples, recording every sample and snapshotting only transitions', () => {
    const { base } = created();
    tick(base, sample(MIN));
    tick(base, sample(2 * MIN, { server: null }));
    const state = tick(base, sample(3 * MIN));
    assert.equal(state.sampleCount, 4);
    const records = store.readSamples(base, SHA);
    assert.deepEqual(records.map((r) => r.seq), [1, 2, 3, 4]);
    assert.equal(records[2].verdict.extends[0].code, 'PROBE_UNKNOWN');
    assert.equal(records[3].interval.qualifies, false);
    assert.deepEqual(store.readSnapshots(base, SHA).map((s) => s.event.to), ['running', 'extended']);
  });

  it('refuses to pass a smoke run, and records an operator decision and its snapshot', () => {
    const base = path.join(tmp, 'v1');
    const m = sm.buildManifest({
      candidateSha: SHA, version: '5.30.0', repository: 'o/r', requiredChecks: ['test'], requiredChecksSource: 'branch-protection', createdAt: 1000, worktreePath: '/w', worktreeId: 'c'.repeat(64), ttydGeneration: GEN, runId: fx.RUN_ID,
      thresholds: { targetQualifiedMs: MIN, ptyMinAttaches: 1, ptyMinDetaches: 1, ptyMinSpanMs: 1 }
    });
    const s0 = sample(0);
    store.createRun(base, m, sm.admit(m, s0), s0);
    tick(base, sample(MIN, { pty: { instance: 's1', attaches: 1, detaches: 1, lastAt: 1_000_000 + 30_000 } }));
    tick(base, sample(2 * MIN, { pty: { instance: 's1', attaches: 2, detaches: 2, lastAt: 1_000_000 + 2 * MIN } }));
    assert.equal(store.readRun(base, SHA).state.state, STATES.AWAITING_REVIEW);
    refuses(() => store.updateRun(base, SHA, (state, man) => sm.accept(state, 'jason', 7, man)), REFUSAL.NOT_CANONICAL);
    assert.equal(store.readRun(base, SHA).state.state, STATES.AWAITING_REVIEW, 'a smoke run reaches review but never passes');
    const cancelled = store.updateRun(base, SHA, (state) => sm.cancel(state, 'jason', 7));
    assert.equal(cancelled.state, STATES.CANCELLED);
    assert.equal(store.readSnapshots(base, SHA).at(-1).event.code, 'OPERATOR_CANCELLED');
  });

  it('refuses a manifest changed after the run began', () => {
    const { base } = created();
    const p = store.runPaths(base, SHA);
    const text = fs.readFileSync(p.manifest, 'utf8').replace('"5.30.0"', '"5.30.1"');
    fs.writeFileSync(p.manifest, text);
    refuses(() => store.readRun(base, SHA), REFUSAL.MANIFEST_TAMPERED);
    refuses(() => tick(base, sample(MIN)), REFUSAL.MANIFEST_TAMPERED);
  });

  it('ignores sample records from writes that never committed', () => {
    const { base } = created();
    tick(base, sample(MIN));
    const p = store.runPaths(base, SHA);
    privateFs.appendLine(p.samples, JSON.stringify({ seq: 3, uncommitted: true }));
    let records = store.readSamples(base, SHA);
    assert.deepEqual(records.map((r) => r.seq), [1, 2]);
    tick(base, sample(2 * MIN));
    records = store.readSamples(base, SHA);
    assert.deepEqual(records.map((r) => r.seq), [1, 2, 3]);
    assert.equal(records[2].uncommitted, undefined);
  });

  it('is unaffected by a replace killed before its rename', () => {
    const { base } = created();
    const p = store.runPaths(base, SHA);
    const before = fs.readFileSync(p.state, 'utf8');
    fs.writeFileSync(`${p.state}.123.deadbeef.tmp`, '{"half":');
    assert.equal(store.readRun(base, SHA).state.sampleCount, 1);
    assert.equal(fs.readFileSync(p.state, 'utf8'), before);
    assert.equal(tick(base, sample(MIN)).sampleCount, 2);
  });

  it('aborts a change whose lock was lost before commit, leaving state untouched', () => {
    const { base } = created();
    const p = store.runPaths(base, SHA);
    const before = fs.readFileSync(p.state, 'utf8');
    refuses(() => store.updateRun(base, SHA, (state) => {
      fs.writeFileSync(p.lock, JSON.stringify({ pid: 1, host: 'x', writtenAt: 1, token: 'thief' }));
      return sm.cancel(state, 'op', 1);
    }), REFUSAL.LOCK_LOST);
    assert.equal(fs.readFileSync(p.state, 'utf8'), before);
    assert.equal(lockfile.readRecord(p.lock).token, 'thief');
    assert.equal(store.readSnapshots(base, SHA).length, 1);
  });

  it('reports every recovery it performs', () => {
    const base = path.join(tmp, 'v1');
    const p = store.runPaths(base, SHA);
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(p.manifest, '{"half":');
    fs.writeFileSync(p.lock, JSON.stringify({ pid: 424242, machine: lockfile.machineId(), host: os.hostname(), writtenAt: 1, token: 'dead' }));
    const facts = [];
    const onRecover = (f) => facts.push(f.kind);
    const m = manifest();
    const s = sample(0);
    store.createRun(base, m, sm.admit(m, s), s, { onRecover, lockDeps: { isAlive: (pid) => pid !== 424242 } });
    fs.appendFileSync(p.samples, '{"seq":2,"to');
    store.updateRun(base, SHA, (state, man) => {
      const out = sm.reduce(state, man, sample(MIN));
      return { state: out.state, events: out.events, record: store.sampleRecord(2, sample(MIN), out.verdict, out.interval) };
    }, { onRecover });
    assert.deepEqual(facts, ['lock-reclaimed', 'orphan-manifest-replaced', 'torn-sample-truncated']);
  });

  it('does not create a run directory for a candidate that has no run', () => {
    const { base } = created();
    const typo = 'b'.repeat(40);
    refuses(() => store.updateRun(base, typo, (state) => sm.cancel(state, 'op', 1)), REFUSAL.RUN_NOT_FOUND);
    assert.equal(fs.existsSync(path.join(base, typo)), false);
    fs.mkdirSync(path.join(base, 'c'.repeat(40)));
    assert.deepEqual(store.listRuns(base), [SHA]);
  });

  it('refuses to write while another live process holds the lock', () => {
    const { base } = created();
    const p = store.runPaths(base, SHA);
    const token = lockfile.acquire(p.lock);
    try {
      refuses(() => store.updateRun(base, SHA, (state) => sm.cancel(state, 'op', 1), { lockTimeoutMs: 0 }), REFUSAL.LOCK_HELD);
    } finally {
      lockfile.release(p.lock, token);
    }
    assert.equal(store.readRun(base, SHA).state.state, STATES.RUNNING);
  });

  it('refuses a run that does not exist and a malformed SHA', () => {
    refuses(() => store.readRun(path.join(tmp, 'v1'), SHA), REFUSAL.RUN_NOT_FOUND);
    refuses(() => store.runPaths(path.join(tmp, 'v1'), 'abc'), REFUSAL.INVALID_MANIFEST);
    refuses(() => store.runPaths('relative', SHA), REFUSAL.STORE_UNSAFE);
  });

  it('defaults to release-certification/v1 under the TangleClaw home', () => {
    assert.match(store.defaultBase(), /release-certification[/\\]v1$/);
  });
});
