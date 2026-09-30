'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { initRepo } = require('./_temp-repo');

const publisherLib = require('../lib/release-certification/publisher');
const publicationLib = require('../lib/release-certification/publication');
const runnerLib = require('../lib/release-certification/runner');
const store = require('../lib/release-certification/store');
const sm = require('../lib/release-certification/state-machine');
const sc = require('../lib/release-certification/scorecard');
const { REFUSAL, STATES, CertificationError } = require('../lib/release-certification/codes');
const fx = require('./_release-certification-fixtures');

const { SHA, WTID, GEN, MIN, T0 } = fx;

const ID = { name: 'Test Operator', email: 'op@example.invalid' };

let tmp;
let remote;
let base;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-publish-')));
  remote = path.join(tmp, 'remote.git');
  fs.mkdirSync(remote);
  initRepo(remote, ['--bare']);
  base = path.join(tmp, 'v1');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Read a file from the bare remote's metrics branch.
 * @param {string} rel - Path
 * @returns {string|null} Contents, or null when absent
 */
function remoteFile(rel) {
  try {
    return execFileSync('git', ['--git-dir', remote, 'show', `metrics:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/**
 * Commits on the remote's metrics branch.
 * @returns {number} Count
 */
function remoteCommits() {
  try {
    return Number(execFileSync('git', ['--git-dir', remote, 'rev-list', '--count', 'metrics'], { encoding: 'utf8' }).trim());
  } catch {
    return 0;
  }
}

/**
 * A publisher into the test remote.
 * @param {string} [name] - Clone directory name
 * @param {object} [deps] - Seams
 * @returns {object} Publisher
 */
function publisher(name = '_metrics', deps = {}) {
  return publisherLib.createPublisher({ dir: path.join(tmp, name), remoteUrl: remote, identity: ID }, { sleep: async () => {}, ...deps });
}

/**
 * Assert an async thunk rejects with a CertificationError code.
 * @param {Function} fn - Thunk
 * @param {string} code - Code
 * @returns {Promise<CertificationError>} The error
 */
async function rejects(fn, code) {
  let caught = null;
  try { await fn(); } catch (err) { caught = err; }
  assert.ok(caught instanceof CertificationError, `expected ${code}, got ${caught && caught.stack}`);
  assert.equal(caught.code, code);
  return caught;
}

const IDX = sc.INDEX_PATH;
const P = sc.paths(SHA);

describe('publisher: git mechanics against a real remote', () => {
  it('creates the metrics branch on first publish and writes only what it was given', async () => {
    const r = await publisher().publish(() => ({ [IDX]: '{"x":1}\n' }), 'first');
    assert.equal(r.changed, true);
    assert.match(r.commit, /^[0-9a-f]{40}$/);
    assert.equal(remoteFile(IDX), '{"x":1}\n');
    assert.equal(remoteCommits(), 1);
    const author = execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%an <%ae>', 'metrics'], { encoding: 'utf8' }).trim();
    assert.equal(author, 'Test Operator <op@example.invalid>');
  });

  it('commits nothing when nothing changed', async () => {
    const pub = publisher();
    await pub.publish(() => ({ [IDX]: 'same\n' }), 'one');
    assert.deepEqual(await pub.publish(() => ({ [IDX]: 'same\n' }), 'two'), { changed: false, commit: null });
    assert.deepEqual(await pub.publish(() => ({}), 'three'), { changed: false, commit: null });
    assert.equal(remoteCommits(), 1);
  });

  for (const bad of ['server.js', 'lib/x.js', 'release-certification/v1/../../server.js', 'release-certification/v1/admissions/abc.json', '.github/workflows/x.yml']) {
    it(`refuses to write ${bad}`, async () => {
      await rejects(() => publisher().publish(() => ({ [bad]: 'x' }), 'bad'), REFUSAL.PATH_NOT_ALLOWED);
      assert.equal(remoteCommits(), 0);
    });
  }

  it('rebuilds from the new tip and retries when someone else published first, never forcing', async () => {
    const calls = [];
    const spy = async (args, opts) => { calls.push(args); return publisherLib.runGit(args, opts); };
    const other = publisher('_other');
    let interfered = false;
    const seen = [];
    const r = await publisher('_metrics', { git: spy }).publish(async (read) => {
      seen.push(read(IDX));
      if (!interfered) {
        interfered = true;
        await other.publish(() => ({ [IDX]: 'theirs\n' }), 'theirs');
      }
      return { [P.scorecard]: 'ours\n' };
    }, 'ours');
    assert.equal(r.changed, true);
    assert.deepEqual(seen, [null, 'theirs\n'], 'the retry saw the other publish');
    assert.equal(remoteFile(IDX), 'theirs\n');
    assert.equal(remoteFile(P.scorecard), 'ours\n');
    assert.equal(calls.filter((a) => a.includes('push')).length, 2);
    assert.ok(calls.every((a) => !a.some((x) => x === '--force' || x === '-f' || x.startsWith('+HEAD') || x === '--force-with-lease')), 'never forces');
  });

  it('reads back what the remote holds, and nothing when the branch does not exist', async () => {
    const pub = publisher();
    assert.equal(await pub.read(IDX), null);
    await publisher('_other').publish(() => ({ [IDX]: 'v\n' }), 'x');
    assert.equal(await pub.read(IDX), 'v\n');
  });

  it('refuses when the remote cannot be reached', async () => {
    const pub = publisherLib.createPublisher({ dir: path.join(tmp, '_m'), remoteUrl: path.join(tmp, 'missing.git'), identity: ID });
    await rejects(() => pub.publish(() => ({ [IDX]: 'x' }), 'x'), REFUSAL.PUBLISH_FAILED);
  });

  it('keeps its clones private, one per remote', async () => {
    const other = path.join(tmp, 'other.git');
    fs.mkdirSync(other);
    initRepo(other, ['--bare']);
    const a = publisher();
    const b = publisherLib.createPublisher({ dir: path.join(tmp, '_metrics'), remoteUrl: other, identity: ID });
    await a.publish(() => ({ [IDX]: 'a\n' }), 'a');
    await b.publish(() => ({ [IDX]: 'b\n' }), 'b');
    assert.notEqual(a.cloneDir, b.cloneDir);
    assert.equal(remoteFile(IDX), 'a\n', 'each candidate publishes to its own remote');
    assert.equal(execFileSync('git', ['--git-dir', other, 'show', `metrics:${IDX}`], { encoding: 'utf8' }), 'b\n');
    assert.equal(fs.statSync(path.join(tmp, '_metrics')).mode & 0o777, 0o700);
  });

  it('serializes publishes that share a clone', async () => {
    const a = publisher();
    const b = publisher();
    const [ra, rb] = await Promise.all([
      a.publish(() => ({ [P.scorecard]: 'a\n' }), 'a'),
      b.publish((read) => ({ [IDX]: `b after ${read(P.scorecard) === null ? 'nothing' : 'a'}\n` }), 'b')
    ]);
    assert.equal(ra.changed && rb.changed, true);
    assert.equal(remoteCommits(), 2);
    assert.equal(remoteFile(P.scorecard), 'a\n');
  });

  it('keeps an excerpt of git\'s error when a publish fails', async () => {
    const pub = publisherLib.createPublisher({ dir: path.join(tmp, '_m'), remoteUrl: path.join(tmp, 'missing.git'), identity: ID });
    const err = await rejects(() => pub.publish(() => ({ [IDX]: 'x' }), 'x'), REFUSAL.PUBLISH_FAILED);
    assert.equal(typeof err.details.stderr, 'string');
    assert.ok(err.details.stderr.length > 0 && err.details.stderr.length <= 300);
  });

  it('reads the worktree origin and the operator identity', async () => {
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    initRepo(wt);
    execFileSync('git', ['-C', wt, 'remote', 'add', 'origin', remote]);
    execFileSync('git', ['-C', wt, 'config', 'user.name', 'Jay']);
    execFileSync('git', ['-C', wt, 'config', 'user.email', 'jay@example.invalid']);
    assert.deepEqual(await publisherLib.repoFacts(wt), { remoteUrl: remote, identity: { name: 'Jay', email: 'jay@example.invalid' } });
    execFileSync('git', ['-C', wt, 'remote', 'remove', 'origin']);
    await rejects(() => publisherLib.repoFacts(wt), REFUSAL.PUBLISH_FAILED);
  });
});

/**
 * A manifest.
 * @returns {object} Manifest
 */
function manifest() {
  return fx.manifest();
}

/**
 * Healthy observations.
 * @param {object} [over] - Overrides
 * @returns {object} Observations
 */
function obs(over = {}) {
  return fx.observations(over);
}

/**
 * The publication under test, with a controllable clock.
 * @param {object} [pub] - Publisher (defaults to one into the test remote)
 * @returns {{publication: object, clock: {t: number}}} Publication and its clock
 */
function publication(pub = publisher()) {
  const clock = { t: T0 };
  fs.mkdirSync(store.runPaths(base, SHA).dir, { recursive: true, mode: 0o700 });
  return { publication: publicationLib.createPublication({ base, candidateSha: SHA, publisher: pub, now: () => clock.t }), clock };
}

describe('publication: fail-closed admission and forward-only updates', () => {
  it('publishes the admission and verifies it by reading it back', async () => {
    const { publication: p } = publication();
    const m = manifest();
    const digest = 'd'.repeat(64);
    const r = await p.admit(m, digest);
    assert.equal(r.verifiedAt, T0);
    assert.equal(remoteFile(P.admission), sc.serialize(sc.admissionRecord(m, digest)));
    assert.deepEqual(p.readStatus().admission, { digest, verifiedAt: T0 });
  });

  it('reports the digest the metrics branch already holds for this candidate', async () => {
    const { publication: p } = publication();
    assert.equal(await p.publishedDigest(), null);
    await p.admit(manifest(), 'd'.repeat(64));
    assert.equal(await p.publishedDigest(), 'd'.repeat(64));
  });

  it('re-admits the identical record as a no-op, and refuses a different one', async () => {
    const { publication: p } = publication();
    await p.admit(manifest(), 'd'.repeat(64));
    await p.admit(manifest(), 'd'.repeat(64));
    assert.equal(remoteCommits(), 1);
    await rejects(() => p.admit(manifest(), 'e'.repeat(64)), REFUSAL.ADMISSION_CONFLICT);
    assert.match(remoteFile(P.admission), /d{64}/);
  });

  it('refuses admission when the read-back does not match', async () => {
    const real = publisher();
    const lying = { publish: real.publish, read: async () => 'something else' };
    await rejects(() => publication(lying).publication.admit(manifest(), 'd'.repeat(64)), REFUSAL.ADMISSION_UNPUBLISHED);
  });

  it('publishes scorecard, transitions and index, with a rising sequence', async () => {
    const { publication: p, clock } = publication();
    const m = manifest();
    await p.admit(m, 'd'.repeat(64));
    let { state, events } = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    state = { ...state, manifestDigest: 'd'.repeat(64) };
    assert.equal((await p.update({ state, manifest: m, events })).seq, 1);
    const out = sm.reduce(state, m, { wallAt: T0 + MIN, monoAt: MIN, runnerInstance: 'r', observations: obs({ server: null }) });
    clock.t += MIN;
    assert.equal((await p.update({ state: out.state, manifest: m, events: [...events, ...out.events] })).seq, 2);
    const card = JSON.parse(remoteFile(P.scorecard));
    assert.deepEqual(sc.validateScorecard(card), []);
    assert.equal(card.state, STATES.EXTENDED);
    assert.equal(card.publishSeq, 2);
    assert.equal(remoteFile(P.events).trim().split('\n').length, 2);
    assert.deepEqual(JSON.parse(remoteFile(IDX)).candidates.map((c) => c.candidateSha), [SHA]);
    assert.equal(p.readStatus().lastPublishedSeq, 2);
  });

  it('refuses an update before the admission is published', async () => {
    const { publication: p } = publication();
    const m = manifest();
    const { state, events } = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    await rejects(() => p.update({ state: { ...state, manifestDigest: 'd'.repeat(64) }, manifest: m, events }), REFUSAL.ADMISSION_UNPUBLISHED);
  });

  it('refuses to rewrite a published transition log', async () => {
    const { publication: p } = publication();
    const m = manifest();
    await p.admit(m, 'd'.repeat(64));
    const { state, events } = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    const run = { state: { ...state, manifestDigest: 'd'.repeat(64) }, manifest: m, events };
    await p.update(run);
    await publisher('_other').publish(() => ({ [P.events]: '{"tampered":true}\n' }), 'tamper');
    await rejects(() => p.update(run), REFUSAL.EVENTS_DIVERGED);
  });

  it('never throws from publishCurrent, and survives an unreadable publish.json', async () => {
    const { publication: p } = publication();
    const log = [];
    assert.deepEqual(await p.publishCurrent((e) => log.push(e)), { published: false, code: REFUSAL.RUN_NOT_FOUND });
    assert.equal(log.at(-1).event, 'publish-failed');
    fs.writeFileSync(store.runPaths(base, SHA).publish, '{broken');
    assert.equal(p.readStatus().lastError, 'STATUS_UNREADABLE');
    assert.equal(p.due({ transitioned: true, state: 'running' }), true);
  });

  it('reports a failed publish even when its status cannot be written, and never throws', async () => {
    const { publication: p } = publication();
    fs.mkdirSync(store.runPaths(base, SHA).publish);
    const log = [];
    assert.deepEqual(await p.publishCurrent((e) => log.push(e)), { published: false, code: REFUSAL.RUN_NOT_FOUND });
    assert.deepEqual(log.map((e) => e.event), ['publish-status-unwritable', 'publish-failed']);
  });

  it('records a publisher that cannot be built as a failed publish, and builds it again next time', async () => {
    let builds = 0;
    const d = publicationLib.createDeferredPublication({
      base, candidateSha: SHA, now: () => T0,
      build: async () => {
        builds++;
        if (builds === 1) throw new CertificationError(REFUSAL.PUBLISH_FAILED, 'no git identity');
        return { publishCurrent: async () => ({ published: true, seq: 1 }) };
      }
    });
    fs.mkdirSync(store.runPaths(base, SHA).dir, { recursive: true, mode: 0o700 });
    const log = [];
    assert.deepEqual(await d.publishCurrent((e) => log.push(e)), { published: false, code: REFUSAL.PUBLISH_FAILED });
    assert.equal(log.at(-1).event, 'publish-failed');
    assert.equal(d.readStatus().lastMessage, 'no git identity');
    assert.equal(d.readStatus().nextAttemptAt, T0 + publicationLib.backoffMs(1));
    assert.deepEqual(await d.publishCurrent(), { published: true, seq: 1 });
    assert.equal(builds, 2);
  });

  it('never throws when the publisher cannot be built and the status cannot be written either', async () => {
    const d = publicationLib.createDeferredPublication({ base, candidateSha: SHA, build: async () => { throw new Error('no origin'); } });
    fs.mkdirSync(store.runPaths(base, SHA).publish, { recursive: true });
    const log = [];
    assert.deepEqual(await d.publishCurrent((e) => log.push(e)), { published: false, code: 'PUBLISH_FAILED' });
    assert.deepEqual(log.map((e) => e.event), ['publish-status-unwritable', 'publish-failed']);
  });

  it('publishes at most once a minute unless the run is final', async () => {
    const { publication: p, clock } = publication();
    const m = manifest();
    await p.admit(m, 'd'.repeat(64));
    const { state, events } = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    await p.update({ state: { ...state, manifestDigest: 'd'.repeat(64) }, manifest: m, events });
    clock.t += 30_000;
    assert.equal(p.due({ transitioned: true, state: 'extended' }), false, 'a flapping run does not push every tick');
    assert.equal(p.due({ transitioned: false, state: 'failed' }), true, 'a final state is never held back');
    clock.t += 30_000;
    assert.equal(p.due({ transitioned: true, state: 'running' }), true);
  });

  it('is due after a transition, a terminal state or the heartbeat, but never inside a backoff', async () => {
    const { publication: p, clock } = publication();
    await p.admit(manifest(), 'd'.repeat(64));
    assert.equal(p.due({ transitioned: false, state: 'running' }), true, 'nothing published yet');
    const m = manifest();
    const { state, events } = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    await p.update({ state: { ...state, manifestDigest: 'd'.repeat(64) }, manifest: m, events });
    assert.equal(p.due({ transitioned: false, state: 'running' }), false);
    clock.t += publicationLib.MIN_INTERVAL_MS;
    assert.equal(p.due({ transitioned: true, state: 'extended' }), true);
    assert.equal(p.due({ transitioned: false, state: 'failed' }), true);
    clock.t += publicationLib.HEARTBEAT_MS;
    assert.equal(p.due({ transitioned: false, state: 'running' }), true);
    const s = p.recordFailure(new CertificationError(REFUSAL.PUBLISH_FAILED, 'x'));
    assert.equal(s.nextAttemptAt, clock.t + 60_000);
    assert.equal(p.due({ transitioned: true, state: 'failed' }), false, 'a backoff holds even a transition');
    assert.equal(p.recordFailure(new Error('y')).nextAttemptAt, clock.t + 120_000);
    assert.equal(publicationLib.backoffMs(20), 30 * 60 * 1000);
  });
});

describe('publication: never pushes what the branch verifier would reject', () => {
  it('refuses an update whose transition log disagrees with the published one, and leaves the branch as it was', async () => {
    const { publication: p } = publication();
    const m = manifest();
    await p.admit(m, 'd'.repeat(64));
    const admitted = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    const running = { ...admitted.state, manifestDigest: 'd'.repeat(64) };
    const cancelled = sm.cancel(running, 'op', T0 + 1);
    await p.update({ state: cancelled.state, manifest: m, events: [...admitted.events, ...cancelled.events] });
    const before = remoteCommits();
    await rejects(() => p.update({ state: running, manifest: m, events: admitted.events }), REFUSAL.EVENTS_DIVERGED);
    assert.equal(remoteCommits(), before, 'nothing reached the branch');
    assert.equal(JSON.parse(remoteFile(P.scorecard)).state, 'cancelled');
  });

  it('turns a would-be violation into WOULD_VIOLATE before anything is pushed', async () => {
    const { publication: p } = publication();
    const m = manifest();
    await p.admit(m, 'd'.repeat(64));
    const admitted = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    const running = { ...admitted.state, manifestDigest: 'd'.repeat(64) };
    await p.update({ state: running, manifest: m, events: admitted.events });
    const forged = { ...running, state: 'awaiting-review' };
    const err = await rejects(() => p.update({ state: forged, manifest: m, events: [...admitted.events, { type: 'transition', from: 'running', to: 'awaiting-review', code: 'TARGET_REACHED', at: T0 + 1, sampleSeq: 2 }] }), REFUSAL.WOULD_VIOLATE);
    assert.ok(err.details.violations.some((v) => v.rule === 'UNEARNED_REVIEW'));
    assert.equal(remoteCommits(), 2, 'only the admission and the honest update are on the branch');
  });
});

describe('rc-cert publishing identity and failure records', () => {
  const cli = require('../scripts/rc-cert');
  /**
   * Run the CLI with captured output.
   * @param {string[]} argv - Arguments
   * @param {object} deps - Seams
   * @returns {Promise<{code: number, out: string, err: string}>} Result
   */
  async function run(argv, deps) {
    let out = '';
    let err = '';
    const code = await cli.main(argv, { stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, env: {}, configFile: path.join(tmp, 'none.json'), deps });
    return { code, out, err };
  }

  it('commits as a neutral identity when the run withholds the operator id', async () => {
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'version.json'), '{"version":"5.30.0"}');
    const wtid = runnerLib.worktreeId(wt);
    const probesFake = () => ({ collect: async () => ({ observations: obs({ server: { checkoutId: wtid } }), diagnostics: {} }) });
    const deps = {
      repository: async () => 'o/r',
      repoFacts: async () => ({ remoteUrl: remote, identity: { name: 'Jay Operator', email: 'jay@example.invalid' } }),
      probes: probesFake
    };
    const r = await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://x', '--required-check', 'test', '--no-publish-actor'], deps);
    assert.equal(r.code, 0, r.err);
    const authors = execFileSync('git', ['--git-dir', remote, 'log', '--format=%an <%ae>', 'metrics'], { encoding: 'utf8' });
    assert.doesNotMatch(authors, /Jay|jay@/);
    assert.match(authors, /TangleClaw release certification/);
    const manifestOnDisk = store.readRun(base, SHA).manifest;
    assert.equal(manifestOnDisk.publishActor, false);
    assert.equal(manifestOnDisk.private.publishRemote, remote, 'the remote is pinned in the manifest');
  });

  it('keeps sampling when the publisher cannot be built, recording the failure instead', async () => {
    const m = sm.buildManifest({
      candidateSha: SHA, version: '5.30.0', repository: 'o/r', requiredChecks: ['test'], requiredChecksSource: 'branch-protection',
      createdAt: T0, worktreePath: '/tmp/wt', worktreeId: WTID, ttydGeneration: GEN, host: 'h', runId: fx.RUN_ID
    });
    const s0 = { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() };
    store.createRun(base, m, sm.admit(m, s0), s0);
    let t = T0;
    const clock = { wall: () => t, mono: () => t - T0 };
    const controller = new AbortController();
    let ticks = 0;
    const deps = {
      repoFacts: async () => { throw new CertificationError(REFUSAL.PUBLISH_FAILED, 'no git identity under launchd'); },
      probes: () => ({ collect: async () => ({ observations: obs(), diagnostics: {} }) }),
      runner: (ctx) => {
        const real = runnerLib.createRunner({ ...ctx, clock });
        return { ...real, run: (args) => real.run({ ...args, wait: async () => { t += MIN; if (++ticks === 2) controller.abort(); } }) };
      }
    };
    let err = '';
    const code = await cli.main(['run', '--sha', SHA, '--base', base, '--api', 'http://x'], {
      stdout: { write: () => {} }, stderr: { write: (x) => { err += x; } }, env: {}, configFile: path.join(tmp, 'none.json'), deps, signal: controller.signal
    });
    assert.equal(code, 0, err);
    assert.ok(store.readRun(base, SHA).state.sampleCount >= 3, 'sampling went on');
    assert.equal(publicationLib.readStatus(base, SHA).lastMessage, 'no git identity under launchd');
    assert.match(err, /publish-failed/);
  });

  it('needs no git facts to publish a run whose remote is pinned and whose actor is withheld', async () => {
    const m = sm.buildManifest({
      candidateSha: SHA, version: '5.30.0', repository: 'o/r', requiredChecks: ['test'], requiredChecksSource: 'branch-protection',
      createdAt: T0, worktreePath: '/tmp/wt', worktreeId: WTID, ttydGeneration: GEN, host: 'h', runId: fx.RUN_ID, publishActor: false, publishRemote: remote
    });
    const s0 = { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() };
    fs.mkdirSync(store.runPaths(base, SHA).dir, { recursive: true, mode: 0o700 });
    await publicationLib.createPublication({ base, candidateSha: SHA, publisher: publisherLib.createPublisher({ dir: path.join(base, '_metrics'), remoteUrl: remote, identity: ID }) }).admit(m, store.manifestDigest(store.manifestText(m)));
    store.createRun(base, m, sm.admit(m, s0), s0);
    const r = await run(['publish', '--sha', SHA, '--base', base], { repoFacts: async () => { throw new Error('must not be asked'); } });
    assert.equal(r.code, 0, r.err);
    assert.ok(remoteFile(P.scorecard));
  });

  it('records a publish failure even when no publisher could be built', async () => {
    const m = manifest();
    const s0 = { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() };
    store.createRun(base, m, sm.admit(m, s0), s0);
    const r = await run(['cancel', '--sha', SHA, '--base', base, '--actor', 'op'], { repoFacts: async () => { throw new CertificationError(REFUSAL.PUBLISH_FAILED, 'no origin'); } });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { state: 'cancelled', published: false });
    const status = publicationLib.readStatus(base, SHA);
    assert.equal(status.lastError, REFUSAL.PUBLISH_FAILED);
    assert.equal(status.lastMessage, 'no origin');
    assert.equal(status.failures, 1);
  });
});

describe('rc-cert decisions survive publishing failures', () => {
  it('keeps an accepted or cancelled decision and exits 0 when publishing cannot even record its failure', async () => {
    const cli = require('../scripts/rc-cert');
    const m = manifest();
    const s0 = { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() };
    store.createRun(base, m, sm.admit(m, s0), s0);
    fs.mkdirSync(store.runPaths(base, SHA).publish);
    let out = '';
    let err = '';
    const code = await cli.main(['cancel', '--sha', SHA, '--base', base, '--actor', 'op'], {
      stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, env: {}, configFile: path.join(tmp, 'none.json'),
      deps: { repoFacts: async () => { throw new CertificationError(REFUSAL.PUBLISH_FAILED, 'no origin'); } }
    });
    assert.equal(code, 0, err);
    assert.deepEqual(JSON.parse(out), { state: 'cancelled', published: false });
    assert.equal(store.readRun(base, SHA).state.state, STATES.CANCELLED);
    assert.match(err, /publish-status-unwritable/);
    assert.match(err, /publish-failed/);
  });
});

describe('runner: fail-closed start and background publishing', () => {
  /**
   * Probes that replay one healthy observation.
   * @returns {object} Probes
   */
  const probes = () => ({ collect: async () => ({ observations: obs(), diagnostics: {} }) });
  const SPEC = { version: '5.30.0', repository: 'o/r', worktreePath: '/tmp/wt', worktreeId: WTID, requiredChecks: ['test'], requiredChecksSource: 'branch-protection', host: 'h', runId: fx.RUN_ID };

  it('refuses to start with no publisher', async () => {
    await rejects(() => runnerLib.createRunner({ base, candidateSha: SHA, probes: probes() }).start(SPEC), REFUSAL.ADMISSION_UNPUBLISHED);
    assert.deepEqual(store.listRuns(base), []);
  });

  it('commits no run when the admission cannot be published, and starts fresh when it never became public', async () => {
    let t = T0;
    const clock = { wall: () => t, mono: () => t - T0 };
    const offline = { publish: async () => { throw new CertificationError(REFUSAL.PUBLISH_FAILED, 'offline'); }, read: async () => null };
    await rejects(() => runnerLib.createRunner({ base, candidateSha: SHA, probes: probes(), clock, publication: publication(offline).publication }).start(SPEC), REFUSAL.PUBLISH_FAILED);
    assert.deepEqual(store.listRuns(base), [], 'no run began unpublished');
    const staleDigest = store.manifestDigest(fs.readFileSync(store.runPaths(base, SHA).manifest, 'utf8'));
    t += 10 * MIN;
    const state = await runnerLib.createRunner({ base, candidateSha: SHA, probes: probes(), clock, publication: publication().publication }).start(SPEC);
    assert.equal(state.state, STATES.RUNNING);
    assert.notEqual(state.manifestDigest, staleDigest, 'the unpublished attempt left no settings behind');
    assert.equal(JSON.parse(remoteFile(P.admission)).manifestDigest, state.manifestDigest);
  });

  it('reuses the staged manifest when a crashed start had already made its admission public', async () => {
    let t = T0;
    const clock = { wall: () => t, mono: () => t - T0 };
    const real = publisher();
    let crash = true;
    const crashAfterPublish = {
      publish: real.publish,
      read: async (rel) => {
        const text = await real.read(rel);
        if (crash && text !== null) { crash = false; throw new CertificationError(REFUSAL.PUBLISH_FAILED, 'crashed before read-back'); }
        return text;
      }
    };
    await rejects(() => runnerLib.createRunner({ base, candidateSha: SHA, probes: probes(), clock, publication: publication(crashAfterPublish).publication }).start(SPEC), REFUSAL.PUBLISH_FAILED);
    const published = JSON.parse(remoteFile(P.admission)).manifestDigest;
    t += 10 * MIN;
    const state = await runnerLib.createRunner({ base, candidateSha: SHA, probes: probes(), clock, publication: publication().publication }).start(SPEC);
    assert.equal(state.manifestDigest, published, 'the retry kept the public admission');
    assert.equal(remoteCommits(), 1);
  });

  it('admits end to end through a real remote, then publishes each transition without delaying the tick', async () => {
    const { publication: p } = publication();
    let t = T0;
    const clock = { wall: () => t, mono: () => t - T0 };
    let current = obs();
    const pr = { collect: async () => ({ observations: current, diagnostics: {} }) };
    const log = [];
    const r = runnerLib.createRunner({ base, candidateSha: SHA, probes: pr, clock, publication: p, log: (e) => log.push(e) });
    await r.start(SPEC);
    assert.ok(remoteFile(P.admission), 'the admission is public before the run exists');
    t += MIN;
    current = obs({ worktree: { dirty: true } });
    const state = await r.tick();
    assert.equal(state.state, STATES.FAILED);
    assert.equal(log.filter((e) => e.event === 'published').length, 0, 'the tick returned before publishing finished');
    await r.run({ intervalMs: MIN });
    assert.equal(JSON.parse(remoteFile(P.scorecard)).state, STATES.FAILED);
    assert.ok(log.some((e) => e.event === 'published'));
  });

  it('records a failed publish with a backoff and never changes certification state', async () => {
    const real = publisher();
    let offline = false;
    const flaky = {
      publish: async (...a) => { if (offline) throw new CertificationError(REFUSAL.PUBLISH_FAILED, 'offline'); return real.publish(...a); },
      read: real.read
    };
    const { publication: p, clock: pc } = publication(flaky);
    const log = [];
    let t = T0;
    const clock = { wall: () => t, mono: () => t - T0 };
    const r = runnerLib.createRunner({ base, candidateSha: SHA, probes: probes(), clock, publication: p, log: (e) => log.push(e) });
    await r.start(SPEC);
    offline = true;
    t += MIN;
    const before = await r.tick();
    assert.equal(await r.publishNow(), false);
    const failed = log.filter((e) => e.event === 'publish-failed').at(-1);
    assert.equal(failed.code, REFUSAL.PUBLISH_FAILED);
    assert.equal(p.readStatus().failures, 2, 'the tick\'s background publish and this one both failed');
    assert.equal(failed.nextAttemptAt, pc.t + publicationLib.backoffMs(2));
    const after = store.readRun(base, SHA).state;
    assert.equal(after.qualifiedMs, before.qualifiedMs);
    assert.deepEqual(after.extensions, before.extensions);
  });

  /**
   * A committed run and a runner over a publication stand-in whose first
   * publish is held until released, recording the state each publish saw.
   * @returns {object} `{r, calls, release, setObs, advance}`
   */
  function heldPublication() {
    const m = manifest();
    const s0 = { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() };
    store.createRun(base, m, sm.admit(m, s0), s0);
    let t = T0;
    let current = obs();
    const calls = [];
    let release = null;
    const held = new Promise((resolve) => { release = resolve; });
    const fake = {
      publishCurrent: async () => {
        calls.push(store.readRun(base, SHA).state.state);
        if (calls.length === 1) await held;
        return { published: true, seq: calls.length };
      },
      due: (hint) => hint.transitioned
    };
    const r = runnerLib.createRunner({
      base, candidateSha: SHA, clock: { wall: () => t, mono: () => t - T0 }, publication: fake,
      probes: { collect: async () => ({ observations: current, diagnostics: {} }) }
    });
    return { r, calls, release: () => release(), setObs: (o) => { current = o; }, advance: () => { t += MIN; } };
  }

  it('still owes a transition that arrived while a publish was in flight, once that publish succeeds', async () => {
    const h = heldPublication();
    h.advance();
    h.setObs(obs({ github: { checks: { test: 'pending' } } }));
    assert.equal((await h.r.tick()).state, STATES.EXTENDED);
    h.setObs(obs());
    h.advance();
    assert.equal((await h.r.tick()).state, STATES.EXTENDED, 'one healthy sample does not yet qualify an interval');
    h.advance();
    assert.equal((await h.r.tick()).state, STATES.RUNNING, 'this transition lands while the first publish is held');
    h.release();
    await new Promise(setImmediate);
    h.advance();
    await h.r.tick();
    await new Promise(setImmediate);
    assert.deepEqual(h.calls, [STATES.EXTENDED, STATES.RUNNING], 'the later transition was published, not left for the heartbeat');
  });

  it('publishes a transition still owed when a run is stopped', async () => {
    const h = heldPublication();
    h.advance();
    h.setObs(obs({ github: { checks: { test: 'pending' } } }));
    await h.r.tick();
    h.setObs(obs());
    h.advance();
    await h.r.tick();
    h.advance();
    assert.equal((await h.r.tick()).state, STATES.RUNNING);
    h.release();
    await new Promise(setImmediate);
    const controller = new AbortController();
    controller.abort();
    await h.r.run({ intervalMs: MIN, signal: controller.signal });
    assert.deepEqual(h.calls, [STATES.EXTENDED, STATES.RUNNING]);
  });

  it('reports a publication that throws instead of swallowing it, and keeps the run\'s own outcome', async () => {
    const m = manifest();
    const s0 = { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() };
    store.createRun(base, m, sm.admit(m, s0), s0);
    let t = T0;
    const log = [];
    const throwing = { publishCurrent: async () => { throw new CertificationError(REFUSAL.PUBLISH_FAILED, 'boom'); }, due: () => true };
    const r = runnerLib.createRunner({
      base, candidateSha: SHA, clock: { wall: () => t, mono: () => t - T0 }, publication: throwing, log: (e) => log.push(e),
      probes: { collect: async () => ({ observations: obs({ worktree: { dirty: true } }), diagnostics: {} }) }
    });
    t += MIN;
    const state = await r.run({ intervalMs: MIN });
    assert.equal(state.state, STATES.FAILED);
    const failed = log.filter((e) => e.event === 'publish-failed');
    assert.ok(failed.length > 0);
    assert.ok(failed.every((e) => e.code === REFUSAL.PUBLISH_FAILED && e.message === 'boom'));
    assert.equal(fs.existsSync(store.runPaths(base, SHA).runnerLock), false);
  });

  it('releases the runner lock even when the final publish fails', async () => {
    const real = publisher();
    const broken = { publish: async () => { throw new Error('boom'); }, read: real.read };
    const admitting = publication();
    let t = T0;
    const clock = { wall: () => t, mono: () => t - T0 };
    await runnerLib.createRunner({ base, candidateSha: SHA, probes: probes(), clock, publication: admitting.publication }).start(SPEC);
    const r = runnerLib.createRunner({ base, candidateSha: SHA, probes: { collect: async () => ({ observations: obs({ worktree: { dirty: true } }), diagnostics: {} }) }, clock, publication: publication(broken).publication });
    t += MIN;
    const state = await r.run({ intervalMs: MIN });
    assert.equal(state.state, STATES.FAILED);
    assert.equal(fs.existsSync(store.runPaths(base, SHA).runnerLock), false);
  });
});
