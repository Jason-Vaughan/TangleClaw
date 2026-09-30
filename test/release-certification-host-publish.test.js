'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { initRepo, cloneRepo } = require('./_temp-repo');

const publisherLib = require('../lib/release-certification/publisher');
const publicationLib = require('../lib/release-certification/publication');
const hostPublish = require('../lib/release-certification/host-publish');
const hc = require('../lib/release-certification/host-checks');
const store = require('../lib/release-certification/store');
const sm = require('../lib/release-certification/state-machine');
const { REFUSAL, CertificationError } = require('../lib/release-certification/codes');
const fx = require('./_release-certification-fixtures');

const { SHA, MIN, T0 } = fx;
const ID = { name: 'Guest Runner', email: 'guest@example.invalid' };
const GREEN = async () => ({ observation: { state: 'ok', checks: { test: 'success' } }, error: null });

let tmp;
let guest;
let pub;
let hostBase;
let base;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-relay-')));
  guest = path.join(tmp, 'guest.git');
  pub = path.join(tmp, 'public.git');
  for (const d of [guest, pub]) {
    fs.mkdirSync(d);
    initRepo(d, ['--bare']);
  }
  hostBase = path.join(tmp, 'host');
  base = path.join(tmp, 'v1');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * The tip of a repository's metrics branch.
 * @param {string} repo - Bare repository
 * @returns {string|null} OID, or null when there is no branch
 */
function tip(repo) {
  try {
    return execFileSync('git', ['--git-dir', repo, 'rev-parse', 'refs/heads/metrics'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Publish a host-attested run into the guest's local metrics repository, the
 * way the guest's runner does, and optionally finalize it on the host.
 * @param {object} [opts] - `{checksSource, finalize, updates}`
 * @returns {Promise<{manifest: object, digest: string, publication: object, state: object, events: object[], clock: object}>} The run
 */
async function guestRun(opts = {}) {
  const hostAttested = (opts.checksSource || 'host-attested') === 'host-attested';
  const manifest = fx.manifest(hostAttested ? { checksSource: 'host-attested', checksExchange: '/x', publishRemote: guest, isolationProducer: '/x/guest-setup.sh' } : { publishRemote: guest });
  const digest = store.manifestDigest(store.manifestText(manifest));
  const clock = { t: T0 };
  fs.mkdirSync(store.runPaths(base, SHA).dir, { recursive: true, mode: 0o700 });
  const publisher = publisherLib.createPublisher({ dir: path.join(tmp, '_metrics'), remoteUrl: guest, identity: ID }, { sleep: async () => {} });
  const publication = publicationLib.createPublication({ base, candidateSha: SHA, publisher, now: () => clock.t });
  await publication.admit(manifest, digest);
  const admitted = sm.admit(manifest, fx.sample(0, hostAttested ? { ...fx.observations(), isolation: fx.ISOLATED } : fx.observations()));
  const state = { ...admitted.state, manifestDigest: digest };
  await publication.update({ state, manifest, events: admitted.events });
  if (opts.finalize !== false && hostAttested) {
    hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test'] }, { random: () => fx.RUN_ID });
    await hc.finalize({ hostBase, manifest, manifestDigest: opts.finalizeDigest || digest, state: { state: 'awaiting-review', sampleCount: 0, baseline: { bootId: fx.BOOT_ID } }, samples: [], observe: opts.observe || GREEN });
  }
  return { manifest, digest, publication, state, events: admitted.events, clock };
}

/**
 * The host's relay records for the fixture candidate.
 * @returns {string[]} File names
 */
function records() {
  try {
    return fs.readdirSync(hc.hostPaths(hostBase, SHA).dir).filter((n) => n.startsWith('record-'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Run the relay, asserting it refuses with a code and leaves the public
 * branch and the record as they were.
 * @param {string} code - Expected refusal
 * @param {object} [over] - Relay option overrides
 * @returns {Promise<CertificationError>} The refusal
 */
async function refuses(code, over = {}) {
  const before = tip(pub);
  let caught = null;
  try {
    await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub, ...over });
  } catch (err) { caught = err; }
  assert.ok(caught instanceof CertificationError, `expected ${code}, got ${caught && caught.stack}`);
  assert.equal(caught.code, code);
  assert.deepEqual(records(), [], 'no record was written');
  if (code !== REFUSAL.PUBLICATION_MISMATCH) assert.equal(tip(pub), before, 'the public branch did not move');
  return caught;
}

describe('host relay: the guest\'s exact commit reaches the public branch (#2020 Q2)', () => {
  it('pushes the guest\'s exact tip, reads it back, and records it', async () => {
    await guestRun();
    const record = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub, now: () => T0 + MIN });
    assert.equal(record.oid, tip(guest));
    assert.equal(tip(pub), tip(guest), 'the public branch names the guest\'s commit, not a copy');
    assert.deepEqual([record.runId, record.state, record.certified], [fx.RUN_ID, 'running', false]);
    assert.deepEqual(JSON.parse(fs.readFileSync(hostPublish.recordPath(hostBase, SHA, fx.RUN_ID, record.oid), 'utf8')), record);
  });

  it('fast-forwards the public branch as the guest publishes more', async () => {
    const run = await guestRun();
    await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub });
    const first = tip(pub);
    run.clock.t += MIN;
    const cancelled = sm.cancel(run.state, 'op', T0 + MIN);
    await run.publication.update({ state: cancelled.state, manifest: run.manifest, events: [...run.events, ...cancelled.events] });
    const record = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub });
    assert.notEqual(tip(pub), first);
    assert.equal(tip(pub), tip(guest));
    assert.equal(record.state, 'cancelled');
    execFileSync('git', ['--git-dir', pub, 'merge-base', '--is-ancestor', first, tip(pub)]);
  });
});

describe('host relay: every check fails closed and publishes nothing', () => {
  it('refuses a run the host has not finalized, or finalized as failed, or for another manifest', async () => {
    await guestRun({ finalize: false });
    await refuses(REFUSAL.NOT_FINALIZED);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    for (const d of [guest, pub]) { fs.mkdirSync(d); initRepo(d, ['--bare']); }
    await guestRun({ observe: async () => ({ observation: { state: 'ok', checks: { test: 'failure' } }, error: null }) });
    await refuses(REFUSAL.NOT_FINALIZED);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    for (const d of [guest, pub]) { fs.mkdirSync(d); initRepo(d, ['--bare']); }
    await guestRun({ finalizeDigest: 'f'.repeat(64) });
    await refuses(REFUSAL.NOT_FINALIZED);
  });

  it('refuses a gh run, which publishes to its remote itself', async () => {
    await guestRun({ checksSource: 'gh' });
    await refuses(REFUSAL.NOT_HOST_ATTESTED);
  });

  it('refuses a guest history the branch verifier rejects', async () => {
    await guestRun();
    const wc = path.join(tmp, 'wc');
    cloneRepo(guest, wc, ['-b', 'metrics']);
    fs.writeFileSync(path.join(wc, 'server.js'), 'x');
    const g = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', ...args], { cwd: wc, stdio: 'pipe' });
    g('add', '-A');
    g('commit', '-q', '-m', 'tamper');
    g('push', '-q', 'origin', 'HEAD:metrics');
    await refuses(REFUSAL.HISTORY_INVALID);
  });

  it('never overwrites public history the guest does not have', async () => {
    await guestRun();
    const other = path.join(tmp, 'other.git');
    fs.mkdirSync(other);
    initRepo(other, ['--bare']);
    const wc = path.join(tmp, 'wc-other');
    fs.mkdirSync(wc);
    initRepo(wc);
    fs.mkdirSync(path.join(wc, 'x'));
    fs.writeFileSync(path.join(wc, 'x', 'y'), 'y');
    const g = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', ...args], { cwd: wc, stdio: 'pipe' });
    g('add', '-A');
    g('commit', '-q', '-m', 'someone else');
    g('push', '-q', pub, 'HEAD:refs/heads/metrics');
    await refuses(REFUSAL.NOT_FAST_FORWARD);
  });

  it('records nothing when the remote does not read back the relayed commit', async () => {
    await guestRun();
    const lying = async (args, o) => {
      const r = await publisherLib.runGit(args, o);
      if (args[0] === 'ls-remote' && !args.includes('--exit-code')) return { ...r, stdout: `${'0'.repeat(40)}\trefs/heads/metrics\n` };
      return r;
    };
    await refuses(REFUSAL.PUBLICATION_MISMATCH, { git: lying });
  });

  it('refuses before pushing when the guest has no valid scorecard', async () => {
    const manifest = fx.manifest({ checksSource: 'host-attested', checksExchange: '/x', publishRemote: guest, isolationProducer: '/x/guest-setup.sh' });
    const digest = store.manifestDigest(store.manifestText(manifest));
    fs.mkdirSync(store.runPaths(base, SHA).dir, { recursive: true, mode: 0o700 });
    const publisher = publisherLib.createPublisher({ dir: path.join(tmp, '_metrics'), remoteUrl: guest, identity: ID }, { sleep: async () => {} });
    await publicationLib.createPublication({ base, candidateSha: SHA, publisher, now: () => T0 }).admit(manifest, digest);
    await refuses(REFUSAL.PUBLICATION_MISMATCH);
    assert.equal(tip(pub), null, 'nothing was pushed');
  });
});

describe('host relay: what counts as certification of record', () => {
  for (const [name, card, fin, want] of [
    ['a passed canonical run the host finalized', { state: 'passed', canonicalThresholds: true }, { ok: true }, true],
    ['a passed run judged by other thresholds', { state: 'passed', canonicalThresholds: false }, { ok: true }, false],
    ['a run awaiting review', { state: 'awaiting-review', canonicalThresholds: true }, { ok: true }, false],
    ['a passed run whose finalization failed', { state: 'passed', canonicalThresholds: true }, { ok: false }, false],
    ['a passed run with no finalization', { state: 'passed', canonicalThresholds: true }, null, false]
  ]) {
    it(`${want ? 'certifies' : 'does not certify'} ${name}`, () => {
      assert.equal(hostPublish.certifiedFrom(card, fin), want);
    });
  }
});

describe('rc-cert: the guest publishes locally with no git identity, and the host relays it', () => {
  const cli = require('../scripts/rc-cert');
  /**
   * Run the CLI with captured output.
   * @param {string[]} argv - Arguments
   * @param {object} [deps] - Seams
   * @returns {Promise<{code: number, out: string, err: string}>} Result
   */
  async function run(argv, deps = {}) {
    let out = '';
    let err = '';
    const code = await cli.main(argv, { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, env: {}, configFile: path.join(tmp, 'none.json'), deps });
    return { code, out, err };
  }

  it('relays through host-publish, and refuses with exit 3 when the host has not finalized', async () => {
    await guestRun({ finalize: false });
    const refused = await run(['host-publish', '--sha', SHA, '--guest-metrics', guest, '--remote', pub, '--host-base', hostBase]);
    assert.equal(refused.code, 3);
    assert.equal(JSON.parse(refused.err).error, REFUSAL.NOT_FINALIZED);
    hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test'] }, { random: () => fx.RUN_ID });
    const m = fx.manifest({ checksSource: 'host-attested', checksExchange: '/x', publishRemote: guest, isolationProducer: '/x/guest-setup.sh' });
    await hc.finalize({ hostBase, manifest: m, manifestDigest: store.manifestDigest(store.manifestText(m)), state: { state: 'awaiting-review', sampleCount: 0, baseline: { bootId: fx.BOOT_ID } }, samples: [], observe: GREEN });
    const relayed = await run(['host-publish', '--sha', SHA, '--guest-metrics', guest, '--remote', pub, '--host-base', hostBase]);
    assert.equal(relayed.code, 0, relayed.err);
    assert.equal(JSON.parse(relayed.out).oid, tip(pub));
  });

  it('starts a run that withholds the operator id and pins its remote without reading any git config (R-4)', async () => {
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'version.json'), '{"version":"5.30.0"}');
    const runnerLib = require('../lib/release-certification/runner');
    const f = { wall: () => T0, mono: () => 0 };
    const obs = fx.observations({ server: { checkoutId: runnerLib.worktreeId(wt) } });
    const r = await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://x', '--repo', 'o/r', '--required-check', 'test', '--no-publish-actor', '--metrics-remote', guest], {
      repoFacts: async () => { throw new Error('no git config may be read'); },
      probes: () => ({ collect: async () => ({ observations: obs, diagnostics: {} }) }),
      runner: (ctx) => runnerLib.createRunner({ ...ctx, clock: f })
    });
    assert.equal(r.code, 0, r.err);
    const authors = execFileSync('git', ['--git-dir', guest, 'log', '--format=%an', 'metrics'], { encoding: 'utf8' });
    assert.match(authors, /TangleClaw release certification/);
    assert.equal(store.readRun(base, SHA).manifest.private.publishRemote, guest);
  });
});

describe('host relay: the guest is read once, and relays to one remote never overlap (B4 review)', () => {
  it('publishes only the commit it verified, even when the guest moves its branch straight after the check', async () => {
    await guestRun();
    const verified = tip(guest);
    const realVerify = require('../lib/release-certification/verify').verifyHistory;
    let moved = false;
    // The moment the history check has passed, the guest pushes a commit the
    // verifier would reject.
    const racing = async (o) => {
      const result = await realVerify(o);
      moved = true;
      const wc = path.join(tmp, 'wc-race');
      cloneRepo(guest, wc, ['-b', 'metrics']);
      fs.writeFileSync(path.join(wc, 'server.js'), 'x');
      const g = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', ...a], { cwd: wc, stdio: 'pipe' });
      g('add', '-A');
      g('commit', '-q', '-m', 'unverified');
      g('push', '-q', 'origin', 'HEAD:metrics');
      return result;
    };
    const record = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub, verifyHistory: racing });
    assert.ok(moved);
    assert.notEqual(tip(guest), verified, 'the guest did move');
    assert.equal(record.oid, verified);
    assert.equal(tip(pub), verified, 'only the verified commit reached the public branch');
  });

  it('refuses a second relay to the same remote while one is running', async () => {
    await guestRun();
    const lockfile = require('../lib/release-certification/lockfile');
    const crypto = require('node:crypto');
    const root = path.join(hostBase, '_relay');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const lock = path.join(root, `${crypto.createHash('sha256').update(pub).digest('hex').slice(0, 32)}.lock`);
    const token = lockfile.acquire(lock, { timeoutMs: 0 });
    try {
      await refuses(REFUSAL.LOCK_HELD);
    } finally {
      lockfile.release(lock, token);
    }
    const record = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub });
    assert.equal(record.oid, tip(pub), 'the lock was released, so the next relay runs');
  });
});

describe('host relay: the record is created once and proves itself (A51, A54)', () => {
  it('binds the read-back commit, its tree and the bytes it vouches for', async () => {
    await guestRun();
    const r = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub });
    assert.equal(r.recordDigest, hostPublish.recordDigest(r));
    for (const f of ['treeOid', 'admissionSha256', 'scorecardSha256', 'finalizationSha256', 'sampleSetDigest']) assert.match(r[f], /^[0-9a-f]{40,64}$/, f);
    assert.equal(r.bootId, fx.BOOT_ID);
    assert.deepEqual(await hostPublish.verifyRecord(r, { hostBase, remoteUrl: pub }), { ok: true, reasons: [] });
  });

  it('re-runs an interrupted relay to the one record it would have written', async () => {
    await guestRun();
    const dying = async (args, o) => {
      const res = await publisherLib.runGit(args, o);
      if (args.includes('push')) throw new Error('host lost power after the push');
      return res;
    };
    await assert.rejects(() => hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub, git: dying }));
    assert.equal(tip(pub), tip(guest), 'the push landed');
    assert.deepEqual(records(), [], 'but no record was written');
    const first = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub, now: () => T0 + 1 });
    const again = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub, now: () => T0 + 2 });
    assert.deepEqual(again, first, 'a second relay of the same commit returns the record already written');
    assert.equal(records().length, 1);
  });

  it('refuses to replace a different record for the same run and commit', async () => {
    await guestRun();
    const r = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub });
    const file = hostPublish.recordPath(hostBase, SHA, fx.RUN_ID, r.oid);
    const forged = { ...r, certified: true };
    forged.recordDigest = hostPublish.recordDigest(forged);
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify(forged));
    await assert.rejects(() => hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub }), (e) => e.code === REFUSAL.RECORD_CONFLICT);
  });

  it('fails a forged, replayed or cross-run record when re-derived', async () => {
    await guestRun();
    const r = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub });
    const v = (rec) => hostPublish.verifyRecord(rec, { hostBase, remoteUrl: pub });
    assert.deepEqual((await v({ ...r, certified: true })).reasons, ['RECORD_DIGEST'], 'an edited field breaks its own digest');
    const reDigested = (over) => { const x = { ...r, ...over }; x.recordDigest = hostPublish.recordDigest(x); return x; };
    assert.ok((await v(reDigested({ scorecardSha256: 'f'.repeat(64) }))).reasons.includes('SCORECARD'), 'a forged digest does not match the public bytes');
    assert.ok((await v(reDigested({ oid: 'f'.repeat(40) }))).reasons.includes('OID_NOT_PUBLIC'), 'a commit the public branch never had');
    const other = 'c'.repeat(32);
    hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test'] }, { random: () => other });
    const res = await v(reDigested({ runId: other }));
    assert.ok(res.reasons.includes('FINALIZATION') && res.reasons.includes('RUN_BINDING'), 'a record replayed onto another run');
  });
});

describe('host relay: a record whose digest was recomputed still has to be true (B7 review R-2, R-5)', () => {
  it('re-derives the verdict, the boot and the sample set, whatever the record claims', async () => {
    await guestRun();
    const r = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub });
    const reDigested = (over) => { const x = { ...r, ...over }; x.recordDigest = hostPublish.recordDigest(x); return x; };
    const v = (rec) => hostPublish.verifyRecord(rec, { hostBase, remoteUrl: pub });
    assert.ok((await v(reDigested({ certified: true }))).reasons.includes('VERDICT'), 'a running run re-digested as certified');
    assert.ok((await v(reDigested({ state: 'passed' }))).reasons.includes('VERDICT'));
    assert.ok((await v(reDigested({ canonicalThresholds: !r.canonicalThresholds }))).reasons.includes('VERDICT'));
    assert.ok((await v(reDigested({ bootId: 'boot-other' }))).reasons.includes('FINALIZATION'));
    assert.ok((await v(reDigested({ sampleSetDigest: 'f'.repeat(64) }))).reasons.includes('FINALIZATION'));
  });

  it('fails malformed input instead of throwing', async () => {
    await guestRun();
    const r = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub });
    const v = (rec) => hostPublish.verifyRecord(rec, { hostBase, remoteUrl: pub });
    assert.deepEqual(await v(null), { ok: false, reasons: ['RECORD_DIGEST'] });
    assert.deepEqual(await v({ ...r, runId: '../x' }), { ok: false, reasons: ['RECORD_DIGEST'] });
    const fin = hc.hostPaths(hostBase, SHA).finalization(fx.RUN_ID);
    fs.chmodSync(fin, 0o600);
    fs.writeFileSync(fin, '{truncated');
    assert.ok((await v(r)).reasons.includes('FINALIZATION'));
  });

  it('refuses, and does not throw on, a record under its name that is not a record', async () => {
    await guestRun();
    const r = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub });
    const file = hostPublish.recordPath(hostBase, SHA, fx.RUN_ID, r.oid);
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, '{partial');
    await assert.rejects(() => hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub }), (e) => e.code === REFUSAL.RECORD_CONFLICT);
  });
});

describe('private-fs: create once, atomically', () => {
  const privateFs = require('../lib/release-certification/private-fs');
  it('creates a whole file once, refuses a second, and leaves no temporary file behind', () => {
    const f = path.join(tmp, 'rec.json');
    assert.equal(privateFs.createOnceAtomic(f, 'first'), true);
    assert.equal(privateFs.createOnceAtomic(f, 'second'), false);
    assert.equal(fs.readFileSync(f, 'utf8'), 'first');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('rec.json')), ['rec.json']);
  });
});

describe('host relay: a relayed run\'s finalization is sealed (RM05 finding 1)', () => {
  it('refuses to re-finalize a relayed run, so its record still verifies', async () => {
    const run = await guestRun();
    const r = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub });
    const before = fs.readFileSync(hc.hostPaths(hostBase, SHA).finalization(fx.RUN_ID), 'utf8');
    await assert.rejects(
      () => hc.finalize({ hostBase, manifest: run.manifest, manifestDigest: run.digest, state: { state: 'awaiting-review', sampleCount: 0, baseline: { bootId: fx.BOOT_ID } }, samples: [], observe: GREEN, now: () => T0 + 99 }),
      (e) => e.code === REFUSAL.FINALIZATION_SEALED
    );
    assert.equal(fs.readFileSync(hc.hostPaths(hostBase, SHA).finalization(fx.RUN_ID), 'utf8'), before, 'not rewritten');
    assert.deepEqual(await hostPublish.verifyRecord(r, { hostBase, remoteUrl: pub }), { ok: true, reasons: [] });
    const again = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub });
    assert.deepEqual(again, r, 'a re-relay finds the same record rather than a conflict');
  });

  it('allows a re-finalize before any relay, e.g. after a failed one', async () => {
    const run = await guestRun({ observe: async () => ({ observation: { state: 'ok', checks: { test: 'failure' } }, error: null }) });
    assert.equal(hc.readFinalization(hostBase, SHA, fx.RUN_ID).ok, false);
    const out = await hc.finalize({ hostBase, manifest: run.manifest, manifestDigest: run.digest, state: { state: 'awaiting-review', sampleCount: 0, baseline: { bootId: fx.BOOT_ID } }, samples: [], observe: GREEN });
    assert.equal(out.ok, true);
    assert.equal(hc.readFinalization(hostBase, SHA, fx.RUN_ID).ok, true);
  });
});

describe('host relay and finalize never interleave (Architect ruling 727dcaaf, B9 review R-1)', () => {
  const lockfile = require('../lib/release-certification/lockfile');
  const refin = (run) => hc.finalize({ hostBase, manifest: run.manifest, manifestDigest: run.digest, state: { state: 'awaiting-review', sampleCount: 0, baseline: { bootId: fx.BOOT_ID } }, samples: [], observe: GREEN, now: () => T0 + 7 });

  it('refuses a finalize that lands in the middle of a relay, and the record still verifies', async () => {
    const run = await guestRun();
    let attempted = null;
    const midway = async (args, o) => {
      if (args.includes('push') && attempted === null) {
        attempted = await refin(run).then(() => 'finalized', (e) => e.code);
      }
      return publisherLib.runGit(args, o);
    };
    const r = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub, git: midway });
    assert.equal(attempted, REFUSAL.LOCK_HELD, 'the relay held the run lock');
    assert.deepEqual(await hostPublish.verifyRecord(r, { hostBase, remoteUrl: pub }), { ok: true, reasons: [] });
  });

  it('refuses a relay while the run is being finalized', async () => {
    await guestRun();
    const lock = hc.hostPaths(hostBase, SHA).runLock(fx.RUN_ID);
    const token = lockfile.acquire(lock, { timeoutMs: 0 });
    try {
      await refuses(REFUSAL.LOCK_HELD);
    } finally {
      lockfile.release(lock, token);
    }
    assert.ok(await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub }), 'once released, the relay runs');
  });

  it('refuses a finalize while the run lock is held', async () => {
    const run = await guestRun();
    const lock = hc.hostPaths(hostBase, SHA).runLock(fx.RUN_ID);
    const token = lockfile.acquire(lock, { timeoutMs: 0 });
    try {
      await assert.rejects(() => refin(run), (e) => e.code === REFUSAL.LOCK_HELD);
    } finally {
      lockfile.release(lock, token);
    }
  });

  it('records the digest of the finalization bytes it read, once, even if the file changes under it', async () => {
    await guestRun();
    const fin = hc.hostPaths(hostBase, SHA).finalization(fx.RUN_ID);
    const original = fs.readFileSync(fin);
    let swapped = false;
    const swapping = async (args, o) => {
      if (args.includes('push') && !swapped) {
        swapped = true;
        fs.chmodSync(fin, 0o600);
        fs.writeFileSync(fin, original.toString().replace('"finalizedAt"', '"finalizedAt_" : 0, "finalizedAt"'));
      }
      return publisherLib.runGit(args, o);
    };
    const r = await hostPublish.relay({ hostBase, candidateSha: SHA, guestMetrics: guest, remoteUrl: pub, git: swapping });
    assert.ok(swapped);
    assert.equal(r.finalizationSha256, require('node:crypto').createHash('sha256').update(original).digest('hex'), 'the one buffer read under the lock, not a second read');
  });

  it('names relay records in one place, and the seal finds exactly those', () => {
    const paths = hc.hostPaths(hostBase, SHA);
    const oid = 'e'.repeat(40);
    assert.equal(hostPublish.recordPath(hostBase, SHA, fx.RUN_ID, oid), paths.record(fx.RUN_ID, oid));
    assert.ok(path.basename(paths.record(fx.RUN_ID, oid)).startsWith(paths.recordPrefix(fx.RUN_ID)));
    assert.throws(() => paths.record(fx.RUN_ID, 'short'), (e) => e.code === REFUSAL.INVALID_MANIFEST);
    assert.throws(() => paths.recordPrefix('../x'), (e) => e.code === REFUSAL.INVALID_MANIFEST);
  });
});
