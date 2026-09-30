'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { initRepo, cloneRepo } = require('./_temp-repo');

const verify = require('../lib/release-certification/verify');
const cli = require('../scripts/scorecard-verify');
const sc = require('../lib/release-certification/scorecard');
const sm = require('../lib/release-certification/state-machine');
const publisherLib = require('../lib/release-certification/publisher');
const publicationLib = require('../lib/release-certification/publication');
const store = require('../lib/release-certification/store');
const fx = require('./_release-certification-fixtures');

const { RULES } = verify;
const { SHA, MIN, T0 } = fx;
const DIGEST = 'd'.repeat(64);
const P = sc.paths(SHA);

/**
 * A manifest.
 * @returns {object} Manifest
 */
function manifest() {
  return fx.manifest();
}

/**
 * Healthy observations.
 * @param {object} [over] - Per-probe overrides
 * @returns {object} Observations
 */
function obs(over = {}) {
  return fx.observations(over);
}

/**
 * The documents the publisher would write for a run: admitted, then extended.
 * @returns {{admission: string, card1: string, card2: string, events1: string, events2: string, index2: string, state2: object}} Serialized documents
 */
function documents() {
  const m = manifest();
  const admitted = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
  const s1 = { ...admitted.state, manifestDigest: DIGEST };
  const out = sm.reduce(s1, m, { wallAt: T0 + MIN, monoAt: MIN, runnerInstance: 'r', observations: obs({ server: null }) });
  const events1 = admitted.events.map((e) => JSON.stringify(sc.eventLine(e)));
  const events2 = [...admitted.events, ...out.events].map((e) => JSON.stringify(sc.eventLine(e)));
  const c1 = sc.scorecard(s1, m, T0, 1);
  const c2 = sc.scorecard(out.state, m, T0 + MIN, 2);
  return {
    admission: sc.serialize(sc.admissionRecord(m, DIGEST)),
    card1: sc.serialize(c1),
    card2: sc.serialize(c2),
    events1: `${events1.join('\n')}\n`,
    events2: `${events2.join('\n')}\n`,
    index1: sc.serialize(sc.indexDoc([c1])),
    index2: sc.serialize(sc.indexDoc([c2])),
    state2: out.state
  };
}

/**
 * Judge a change between two in-memory trees.
 * @param {object} before - Path to text
 * @param {object} after - Path to text
 * @returns {string[]} Rule codes found
 */
function judge(before, after) {
  const changed = Object.keys(after).filter((p) => after[p] !== before[p]);
  const deleted = Object.keys(before).filter((p) => !(p in after));
  return verify.verifyChange({
    changed, deleted,
    prev: (p) => (p in before ? before[p] : null),
    next: (p) => (p in after ? after[p] : null)
  }).map((v) => v.rule);
}

describe('verifyChange: the rules, one commit at a time (#1949 C02)', () => {
  const d = documents();
  const first = { [P.admission]: d.admission, [P.scorecard]: d.card1, [P.events]: d.events1, [sc.INDEX_PATH]: d.index1 };
  const second = { ...first, [P.scorecard]: d.card2, [P.events]: d.events2, [sc.INDEX_PATH]: d.index2 };

  it('accepts what the publisher writes: admission, then updates', () => {
    assert.deepEqual(judge({}, { [P.admission]: d.admission }), []);
    assert.deepEqual(judge({ [P.admission]: d.admission }, first), []);
    assert.deepEqual(judge(first, second), []);
  });

  const cases = [
    ['a path outside the certification documents', first, { ...first, 'server.js': 'x' }, RULES.PATH_NOT_ALLOWED],
    ['a workflow file', first, { ...first, '.github/workflows/x.yml': 'x' }, RULES.PATH_NOT_ALLOWED],
    ['a deleted document', first, (() => { const t = { ...first }; delete t[P.events]; return t; })(), RULES.DELETED],
    ['a rewritten admission', first, { ...first, [P.admission]: d.admission.replace('5.30.0', '5.30.1') }, RULES.ADMISSION_REWRITTEN],
    ['an admission that does not validate', {}, { [P.admission]: '{"schema":"x"}' }, RULES.INVALID_DOCUMENT],
    ['an admission filed under another candidate', {}, { [sc.paths('b'.repeat(40)).admission]: d.admission }, RULES.WRONG_CANDIDATE],
    ['a scorecard with no admission', {}, { [P.scorecard]: d.card1 }, RULES.SCORECARD_WITHOUT_ADMISSION],
    ['a scorecard bound to another digest', { [P.admission]: d.admission }, { [P.admission]: d.admission, [P.scorecard]: d.card1.replace(DIGEST, 'e'.repeat(64)) }, RULES.SCORECARD_MISMATCH],
    ['a publishSeq that does not rise', first, { ...second, [P.scorecard]: d.card2.replace('"publishSeq": 2', '"publishSeq": 1') }, RULES.SEQ_NOT_INCREASING],
    ['a rewritten transition log', second, { ...second, [P.events]: d.events2.replace('PROBE_UNKNOWN', 'RECOVERED') }, RULES.EVENTS_REWRITTEN],
    ['a transition log that does not start at admission', { [P.admission]: d.admission }, { [P.admission]: d.admission, [P.events]: `${d.events2.split('\n')[1]}\n` }, RULES.EVENTS_BROKEN_CHAIN],
    ['a log that disagrees with its scorecard', { [P.admission]: d.admission }, { [P.admission]: d.admission, [P.scorecard]: d.card2, [P.events]: d.events1 }, RULES.EVENTS_SCORECARD_MISMATCH],
    ['an index that disagrees with its scorecard', first, { ...second, [sc.INDEX_PATH]: d.index1 }, RULES.INDEX_MISMATCH],
    ['a scorecard whose admission does not validate', { [P.admission]: '{"schema":"tc.release-certification.admission/v1"}' }, { [P.admission]: '{"schema":"tc.release-certification.admission/v1"}', [P.scorecard]: d.card1, [P.events]: d.events1 }, RULES.SCORECARD_WITHOUT_ADMISSION]
  ];
  for (const [name, before, after, rule] of cases) {
    it(`refuses ${name}`, () => {
      assert.ok(judge(before, after).includes(rule), `${judge(before, after)} should include ${rule}`);
    });
  }

  it('refuses a terminal state that changes, and review going back to a live state', () => {
    const m = manifest();
    const failed = { ...d.state2, state: 'failed', failure: { code: 'LEAK_FIRED', reasons: [], at: T0 + MIN, sampleSeq: 2 } };
    const failedCard = sc.serialize(sc.scorecard(failed, m, T0 + MIN, 3));
    const revived = sc.serialize(sc.scorecard(d.state2, m, T0 + 2 * MIN, 4));
    const withFailed = { [P.admission]: d.admission, [P.scorecard]: failedCard };
    assert.ok(judge(withFailed, { ...withFailed, [P.scorecard]: revived }).includes(RULES.TERMINAL_CHANGED));
    const reviewing = sc.serialize(sc.scorecard({ ...d.state2, state: 'awaiting-review' }, m, T0 + MIN, 3));
    const withReview = { [P.admission]: d.admission, [P.scorecard]: reviewing };
    assert.ok(judge(withReview, { ...withReview, [P.scorecard]: revived }).includes(RULES.ILLEGAL_STATE_CHANGE));
  });
});

describe('verifyChange: a certification that skips review or its targets cannot verify', () => {
  const d = documents();
  const m = manifest();
  const events = (...lines) => `${lines.map((l) => JSON.stringify({ schema: sc.SCHEMAS.event, sampleSeq: null, at: 1, ...l })).join('\n')}\n`;
  const admitted = { from: 'not-started', to: 'running', code: 'ADMITTED' };

  it('refuses a passed scorecard whose time and PTY targets were not met', () => {
    const forged = sc.serialize(sc.scorecard({ ...d.state2, state: 'passed', acceptance: { actor: 'x', at: T0 + MIN } }, m, T0 + MIN, 3));
    const log = events(admitted, { from: 'running', to: 'awaiting-review', code: 'TARGET_REACHED' }, { from: 'awaiting-review', to: 'passed', code: 'OPERATOR_ACCEPTED' });
    assert.ok(judge({ [P.admission]: d.admission }, { [P.admission]: d.admission, [P.scorecard]: forged, [P.events]: log }).includes(RULES.UNEARNED_REVIEW));
  });

  it('refuses a transition log that jumps straight to passed', () => {
    const log = events(admitted, { from: 'running', to: 'passed', code: 'OPERATOR_ACCEPTED' });
    assert.ok(judge({ [P.admission]: d.admission }, { [P.admission]: d.admission, [P.events]: log }).includes(RULES.EVENTS_ILLEGAL_TRANSITION));
    const wrongCode = events(admitted, { from: 'running', to: 'extended', code: 'LEAK_FIRED' });
    assert.ok(judge({ [P.admission]: d.admission }, { [P.admission]: d.admission, [P.events]: wrongCode }).includes(RULES.EVENTS_ILLEGAL_TRANSITION));
  });

  it('refuses a scorecard claiming thresholds other than its admission\'s', () => {
    const card = JSON.parse(d.card1);
    const bad = sc.serialize({ ...card, targetMs: 60_000, remainingMs: 0 });
    assert.ok(judge({ [P.admission]: d.admission }, { [P.admission]: d.admission, [P.scorecard]: bad, [P.events]: d.events1 }).includes(RULES.SCORECARD_MISMATCH));
  });

  for (const [field, value] of [['version', '9.9.9'], ['canonicalThresholds', false], ['requiredChecksSource', 'operator'], ['checksSource', 'host-attested']]) {
    it(`refuses a scorecard whose ${field} disagrees with its admission`, () => {
      const bad = sc.serialize({ ...JSON.parse(d.card1), [field]: value });
      assert.ok(judge({ [P.admission]: d.admission }, { [P.admission]: d.admission, [P.scorecard]: bad, [P.events]: d.events1 }).includes(RULES.SCORECARD_MISMATCH));
    });
  }

  it('refuses a scorecard whose time goes backwards, or with no transition log behind it', () => {
    const first = { [P.admission]: d.admission, [P.scorecard]: d.card2, [P.events]: d.events2 };
    const earlier = sc.serialize({ ...JSON.parse(d.card2), publishSeq: 3, updatedAt: T0 });
    assert.ok(judge(first, { ...first, [P.scorecard]: earlier }).includes(RULES.TIME_BACKWARDS));
    assert.ok(judge({ [P.admission]: d.admission }, { [P.admission]: d.admission, [P.scorecard]: d.card1 }).includes(RULES.EVENTS_SCORECARD_MISMATCH));
  });

  it('refuses a scorecard filed under another candidate, and invalid scorecards, logs and indexes', () => {
    const other = sc.paths('b'.repeat(40));
    assert.ok(judge({ [other.admission]: d.admission.replace(SHA, 'b'.repeat(40)) }, { [other.admission]: d.admission.replace(SHA, 'b'.repeat(40)), [other.scorecard]: d.card1 }).includes(RULES.WRONG_CANDIDATE));
    assert.ok(judge({ [P.admission]: d.admission }, { [P.admission]: d.admission, [P.scorecard]: '{"schema":"x"}' }).includes(RULES.INVALID_DOCUMENT));
    assert.ok(judge({ [P.admission]: d.admission }, { [P.admission]: d.admission, [P.events]: 'not json\n' }).includes(RULES.INVALID_DOCUMENT));
    assert.ok(judge({}, { [sc.INDEX_PATH]: '{"schema":"x"}' }).includes(RULES.INVALID_DOCUMENT));
  });
});

describe('verifyChange: the timeline must be internally consistent (PR #1975 review)', () => {
  const d = documents();
  const H72 = 72 * 60 * 60 * 1000;
  const line = (from, to, code, at, sampleSeq = null) => JSON.stringify({ schema: sc.SCHEMAS.event, from, to, code, at, sampleSeq });
  const log = (...lines) => `${lines.join('\n')}\n`;

  /**
   * A forged `passed` history that obeys every other rule: canonical
   * thresholds bound to the admission, targets shown met, a legal transition
   * chain that agrees with the scorecard, a rising index. Only its times give
   * it away. `over` replaces scorecard fields; `times` the event times.
   * @param {object} [over] - Scorecard overrides
   * @param {number[]} [times] - At of admitted, review and accepted lines
   * @returns {{[path: string]: string}} The tree after the forging commit
   */
  function forged(over = {}, times = [T0, T0 + MIN, T0 + MIN]) {
    const card = {
      ...JSON.parse(d.card1),
      state: 'passed',
      updatedAt: T0 + MIN,
      lastSampleAt: T0 + MIN,
      elapsedMs: MIN,
      qualifiedMs: H72,
      remainingMs: 0,
      extensions: {},
      pty: { attaches: 25, detaches: 25, firstEventAt: T0, lastEventAt: T0 + 6 * 60 * MIN, spanMs: 6 * 60 * MIN, met: true, target: { attaches: 25, detaches: 25, spanMs: 6 * 60 * MIN } },
      acceptance: { actor: 'x', at: T0 + MIN },
      publishedAt: T0 + MIN,
      publishSeq: 1,
      ...over
    };
    return {
      [P.admission]: d.admission,
      [P.scorecard]: sc.serialize(card),
      [P.events]: log(
        line('not-started', 'running', 'ADMITTED', times[0], 1),
        line('running', 'awaiting-review', 'TARGET_REACHED', times[1], 2),
        line('awaiting-review', 'passed', 'OPERATOR_ACCEPTED', times[2])
      ),
      [sc.INDEX_PATH]: sc.serialize(sc.indexDoc([card]))
    };
  }

  it('refuses 72 qualified hours claimed a minute after admission, and nothing else gives it away', () => {
    // The reviewer's probe: before this rule it verified clean.
    assert.deepEqual(judge({ [P.admission]: d.admission }, forged()), [RULES.TIMELINE_INCONSISTENT, RULES.TIMELINE_INCONSISTENT]);
  });

  it('refuses the same forgery with elapsedMs inflated to match', () => {
    assert.ok(judge({ [P.admission]: d.admission }, forged({ elapsedMs: H72 })).includes(RULES.TIMELINE_INCONSISTENT));
  });

  it('accepts the same documents when their times are consistent — it checks consistency, not that a soak ran', () => {
    const end = T0 + H72;
    const ok = forged({ updatedAt: end, lastSampleAt: end, elapsedMs: H72, acceptance: { actor: 'x', at: end }, publishedAt: end }, [T0, end, end]);
    assert.deepEqual(judge({ [P.admission]: d.admission }, ok), []);
  });

  const end = T0 + H72;
  const consistent = { updatedAt: end, lastSampleAt: end, elapsedMs: H72, acceptance: { actor: 'x', at: end }, publishedAt: end };
  const cases = [
    ['a run that started before its admission', { ...consistent, startedAt: T0 - 1, elapsedMs: H72 + 1 }, [T0 - 1, end, end]],
    ['an updatedAt before startedAt', { ...consistent, updatedAt: T0 - 1 }, [T0, T0, T0]],
    ['a publishedAt before updatedAt', { ...consistent, publishedAt: end - 1 }, [T0, end, end]],
    ['transition times that go back', consistent, [T0, end, end - 1]],
    ['a transition before admission', consistent, [T0 - 1, end, end]],
    ['a transition after the scorecard\'s updatedAt', consistent, [T0, end, end + 1]],
    ['a first transition that is not the run\'s start', consistent, [T0 + 1, end, end]],
    ['an acceptance before the review it accepts', { ...consistent, acceptance: { actor: 'x', at: end - 1 } }, [T0, end, end]]
  ];
  for (const [name, over, times] of cases) {
    it(`refuses ${name}`, () => {
      const found = judge({ [P.admission]: d.admission }, forged(over, times));
      assert.ok(found.includes(RULES.TIMELINE_INCONSISTENT), `${found} should include ${RULES.TIMELINE_INCONSISTENT}`);
    });
  }

  it('refuses qualified time beyond the elapsed time, with every other time consistent', () => {
    const found = judge({ [P.admission]: d.admission }, forged({ ...consistent, qualifiedMs: H72 + 1, targetMs: H72 }));
    assert.ok(found.includes(RULES.TIMELINE_INCONSISTENT), `${found}`);
  });

  /**
   * A consistent terminal scorecard ended by a failure or a cancellation.
   * @param {'failed'|'cancelled'} state - Terminal state
   * @param {number} at - The failure's or cancellation's time
   * @returns {{[path: string]: string}} The tree after the commit
   */
  function ended(state, at) {
    const card = {
      ...JSON.parse(d.card1), state, updatedAt: T0 + MIN, lastSampleAt: T0 + MIN, elapsedMs: MIN, publishedAt: T0 + MIN,
      failure: state === 'failed' ? { code: 'LEAK_FIRED', at } : null,
      cancellation: state === 'cancelled' ? { actor: 'x', at } : null
    };
    const last = state === 'failed' ? line('running', 'failed', 'LEAK_FIRED', T0 + MIN, 2) : line('running', 'cancelled', 'OPERATOR_CANCELLED', T0 + MIN);
    return {
      [P.admission]: d.admission, [P.scorecard]: sc.serialize(card),
      [P.events]: log(line('not-started', 'running', 'ADMITTED', T0, 1), last),
      [sc.INDEX_PATH]: sc.serialize(sc.indexDoc([card]))
    };
  }

  for (const state of ['failed', 'cancelled']) {
    it(`refuses a ${state} time outside the run, and accepts one inside it`, () => {
      assert.deepEqual(judge({ [P.admission]: d.admission }, ended(state, T0 + MIN)), []);
      assert.ok(judge({ [P.admission]: d.admission }, ended(state, T0 - 1)).includes(RULES.TIMELINE_INCONSISTENT));
      assert.ok(judge({ [P.admission]: d.admission }, ended(state, T0 + MIN + 1)).includes(RULES.TIMELINE_INCONSISTENT));
    });
  }

  it('judges a transition log changed without its scorecard against the admission', () => {
    const before = { [P.admission]: d.admission, [P.scorecard]: d.card1, [P.events]: d.events1, [sc.INDEX_PATH]: d.index1 };
    const early = `${d.events1}${log(line('running', 'extended', 'PROBE_UNKNOWN', T0 - 1, 2))}`;
    assert.ok(judge(before, { ...before, [P.events]: early }).includes(RULES.TIMELINE_INCONSISTENT));
  });
});

describe('verifyHistory: a real metrics branch', () => {
  let tmp;
  let remote;
  let base;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-verify-')));
    remote = path.join(tmp, 'remote.git');
    fs.mkdirSync(remote);
    initRepo(remote, ['--bare']);
    base = path.join(tmp, 'v1');
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /**
   * Publish an admission and two updates through the real publisher.
   * @returns {Promise<void>}
   */
  async function publishHonestly() {
    const publisher = publisherLib.createPublisher({ dir: path.join(tmp, '_metrics'), remoteUrl: remote, identity: { name: 'T', email: 't@example.invalid' } }, { sleep: async () => {} });
    let t = T0;
    fs.mkdirSync(store.runPaths(base, SHA).dir, { recursive: true, mode: 0o700 });
    const publication = publicationLib.createPublication({ base, candidateSha: SHA, publisher, now: () => t });
    const m = manifest();
    await publication.admit(m, DIGEST);
    const admitted = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    const s1 = { ...admitted.state, manifestDigest: DIGEST };
    await publication.update({ state: s1, manifest: m, events: admitted.events });
    t += MIN;
    const out = sm.reduce(s1, m, { wallAt: T0 + MIN, monoAt: MIN, runnerInstance: 'r', observations: obs({ server: null }) });
    await publication.update({ state: out.state, manifest: m, events: [...admitted.events, ...out.events] });
  }

  /**
   * Make a commit on metrics by hand, the way someone with push rights could.
   * @param {function(string): void} edit - Changes files in the working clone
   * @returns {void}
   */
  function tamper(edit) {
    const wc = path.join(tmp, `wc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cloneRepo(remote, wc, ['-b', 'metrics']);
    edit(wc);
    const g = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', ...args], { cwd: wc, stdio: 'pipe' });
    g('add', '-A');
    g('commit', '-q', '-m', 'tamper');
    g('push', '-q', 'origin', 'HEAD:metrics');
  }

  it('finds nothing wrong with what the publisher wrote', async () => {
    await publishHonestly();
    const result = await verify.verifyHistory({ repoDir: remote, ref: 'metrics' });
    assert.equal(result.exists, true);
    assert.equal(result.commits, 3);
    assert.deepEqual(result.violations, []);
  });

  it('reports a branch that does not exist yet as nothing to verify', async () => {
    assert.deepEqual(await verify.verifyHistory({ repoDir: remote, ref: 'metrics' }), { exists: false, commits: 0, violations: [] });
  });

  it('reports a history it cannot read as a violation, never as a missing branch', async () => {
    const git = async (dir, args) => (args[0] === 'rev-list' ? { code: 1, stdout: '' } : { code: 0, stdout: 'abc\n' });
    const result = await verify.verifyHistory({ repoDir: remote, ref: 'metrics', git });
    assert.equal(result.exists, true);
    assert.deepEqual(result.violations.map((v) => v.rule), [RULES.HISTORY_UNREADABLE]);
    const notARepo = await verify.verifyHistory({ repoDir: tmp, ref: 'metrics', git: async () => ({ code: 128, stdout: '' }) });
    assert.deepEqual(notARepo.violations.map((v) => v.rule), [RULES.HISTORY_UNREADABLE], 'a wrong --repo is not "nothing published"');
  });

  it('reports a commit whose changes cannot be read, naming it', async () => {
    await publishHonestly();
    const real = async (dir, args) => new Promise((resolve) => {
      require('node:child_process').execFile('git', args, { cwd: dir }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout) }));
    });
    let failed = null;
    const git = async (dir, args) => {
      if (args[0] === 'diff-tree' && failed === null) {
        failed = args[args.length - 1];
        return { code: 1, stdout: '' };
      }
      return real(dir, args);
    };
    const result = await verify.verifyHistory({ repoDir: remote, ref: 'metrics', git });
    assert.deepEqual(result.violations.map((v) => [v.commit, v.rule, v.path]), [[failed, RULES.HISTORY_UNREADABLE, null]]);
  });

  it('judges a previous admission it cannot read as unreadable, never as absent', async () => {
    await publishHonestly();
    tamper((wc) => fs.writeFileSync(path.join(wc, P.admission), fs.readFileSync(path.join(wc, P.admission), 'utf8').replace('5.30.0', '5.30.9')));
    const real = async (dir, args) => new Promise((resolve) => {
      require('node:child_process').execFile('git', args, { cwd: dir }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }));
    });
    const tamperParent = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'metrics~1'], { encoding: 'utf8' }).trim();
    const git = async (dir, args) => {
      // Fail only the read of the admission as it stood before the tampering commit.
      if (args[0] === 'ls-tree' && args[2] === tamperParent && args.includes(P.admission)) return { code: 1, stdout: '', stderr: 'fatal: bad object' };
      return real(dir, args);
    };
    const result = await verify.verifyHistory({ repoDir: remote, ref: 'metrics', git });
    const rules = result.violations.map((v) => v.rule);
    assert.ok(rules.length > 0 && rules.every((r) => r === RULES.HISTORY_UNREADABLE), 'judged unreadable, never as a new admission that would validate');
    const tip = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'metrics'], { encoding: 'utf8' }).trim();
    assert.ok(result.violations.some((v) => v.commit === tip), 'the tampering commit is named');
    assert.equal(result.violations.find((v) => v.rule === RULES.HISTORY_UNREADABLE).detail, 'fatal: bad object');
  });

  it('writes a job summary even for a violation with no commit', () => {
    const md = cli.summaryMarkdown('origin/metrics', { exists: true, commits: 0, violations: [{ commit: null, rule: RULES.HISTORY_UNREADABLE, path: null }] });
    assert.match(md, /FAILED[\s\S]*\(history\)[\s\S]*HISTORY_UNREADABLE/);
    const withDetail = cli.summaryMarkdown('origin/metrics', { exists: true, commits: 0, violations: [{ commit: null, rule: RULES.HISTORY_UNREADABLE, path: null, detail: 'fatal: bad object' }] });
    assert.match(withDetail, /fatal: bad object/);
  });

  it('keeps the workflow from passing a branch it could not fetch', () => {
    const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'scorecard-verify.yml'), 'utf8');
    assert.doesNotMatch(yml, /\|\| echo/, 'a fetch failure must not be swallowed');
    assert.match(yml, /ls-remote --exit-code --heads origin metrics/);
    assert.match(yml, /"\$status" -eq 2/);
  });

  it('names the commit that rewrote an admission, even after later honest commits', async () => {
    await publishHonestly();
    tamper((wc) => fs.writeFileSync(path.join(wc, P.admission), fs.readFileSync(path.join(wc, P.admission), 'utf8').replace('5.30.0', '5.30.9')));
    const result = await verify.verifyHistory({ repoDir: remote, ref: 'metrics' });
    assert.deepEqual(result.violations.map((v) => [v.rule, v.path]), [[RULES.ADMISSION_REWRITTEN, P.admission]]);
    assert.match(result.violations[0].commit, /^[0-9a-f]{40}$/);
  });

  it('refuses source files and deletions pushed to metrics', async () => {
    await publishHonestly();
    tamper((wc) => {
      fs.writeFileSync(path.join(wc, 'server.js'), 'x');
      fs.rmSync(path.join(wc, P.events));
    });
    const rules = (await verify.verifyHistory({ repoDir: remote, ref: 'metrics' })).violations.map((v) => v.rule).sort();
    assert.deepEqual(rules, [RULES.DELETED, RULES.PATH_NOT_ALLOWED].sort());
  });

  it('refuses a symlink, an executable file or a symlinked directory pushed to metrics', async () => {
    await publishHonestly();
    const outside = path.join(tmp, 'outside.json');
    fs.writeFileSync(outside, '{}');
    tamper((wc) => {
      fs.rmSync(path.join(wc, P.scorecard));
      fs.symlinkSync(outside, path.join(wc, P.scorecard));
    });
    tamper((wc) => fs.chmodSync(path.join(wc, sc.INDEX_PATH), 0o755));
    const outsideDir = path.join(tmp, 'outside-dir');
    fs.mkdirSync(outsideDir);
    tamper((wc) => {
      const eventsDir = path.dirname(path.join(wc, P.events));
      fs.rmSync(eventsDir, { recursive: true });
      fs.symlinkSync(outsideDir, eventsDir);
    });
    const violations = (await verify.verifyHistory({ repoDir: remote, ref: 'metrics' })).violations.filter((v) => v.rule === RULES.NOT_REGULAR_FILE);
    assert.deepEqual(violations.map((v) => v.path).sort(), [P.scorecard, sc.INDEX_PATH, path.posix.dirname(P.events)].sort());
    assert.equal(new Set(violations.map((v) => v.commit)).size, 3, 'each tampering commit is named');
  });

  it('never lets a publish or a read-back follow an entry that is not a regular file', async () => {
    await publishHonestly();
    const victim = path.join(tmp, 'victim.txt');
    fs.writeFileSync(victim, 'untouched');
    tamper((wc) => {
      fs.rmSync(path.join(wc, P.scorecard));
      fs.symlinkSync(victim, path.join(wc, P.scorecard));
    });
    const publisher = publisherLib.createPublisher({ dir: path.join(tmp, '_metrics'), remoteUrl: remote, identity: { name: 'T', email: 't@example.invalid' } }, { sleep: async () => {} });
    const refusal = async (fn) => {
      let caught = null;
      try { await fn(); } catch (err) { caught = err; }
      assert.equal(caught && caught.code, 'METRICS_TREE_UNSAFE', caught && caught.stack);
    };
    await refusal(() => publisher.publish(() => ({ [P.scorecard]: 'overwritten' }), 'x'));
    await refusal(() => publisher.read(P.scorecard));
    assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  });

  it('keeps what it writes in the clone private: files 0600, directories 0700', async () => {
    await publishHonestly();
    const clone = publisherLib.createPublisher({ dir: path.join(tmp, '_metrics'), remoteUrl: remote, identity: { name: 'T', email: 't@example.invalid' } }).cloneDir;
    const dirs = [];
    for (let d = path.dirname(path.join(clone, P.admission)); d !== clone; d = path.dirname(d)) dirs.push(d);
    assert.ok(dirs.length > 0);
    for (const d of dirs) assert.equal(fs.statSync(d).mode & 0o777, 0o700, d);
    for (const f of [P.admission, P.scorecard, P.events, sc.INDEX_PATH]) {
      assert.equal(fs.lstatSync(path.join(clone, f)).mode & 0o777, 0o600, f);
    }
  });

  it('refuses a merge commit', async () => {
    await publishHonestly();
    const wc = path.join(tmp, 'wc-merge');
    cloneRepo(remote, wc, ['-b', 'metrics']);
    const g = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', ...args], { cwd: wc, stdio: 'pipe' });
    g('checkout', '-q', '-b', 'side', 'HEAD~1');
    g('commit', '-q', '--allow-empty', '-m', 'side');
    g('checkout', '-q', 'metrics');
    g('merge', '-q', '--no-ff', '-m', 'merge', 'side');
    g('push', '-q', 'origin', 'HEAD:metrics');
    const rules = (await verify.verifyHistory({ repoDir: remote, ref: 'metrics' })).violations.map((v) => v.rule);
    assert.ok(rules.includes(RULES.MERGE_COMMIT));
  });

  it('exits 0 on a clean history and 1 with a job summary on a tampered one', async () => {
    await publishHonestly();
    const summary = path.join(tmp, 'summary.md');
    const io = (env = {}) => ({ stdout: { write: () => {} }, stderr: { write: () => {} }, env });
    assert.equal(await cli.main(['--repo', remote, '--ref', 'metrics'], io()), 0);
    tamper((wc) => fs.writeFileSync(path.join(wc, 'notes.txt'), 'x'));
    assert.equal(await cli.main(['--repo', remote, '--ref', 'metrics'], io({ GITHUB_STEP_SUMMARY: summary })), 1);
    assert.match(fs.readFileSync(summary, 'utf8'), /FAILED[\s\S]*PATH_NOT_ALLOWED[\s\S]*notes\.txt/);
    assert.equal(await cli.main(['--nope'], io()), 2);
  });
});

describe('carried in from earlier reviews', () => {
  it('creates the publishing clone with no git hooks', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-hooks-')));
    try {
      const remote = path.join(tmp, 'remote.git');
      fs.mkdirSync(remote);
      initRepo(remote, ['--bare']);
      const pub = publisherLib.createPublisher({ dir: path.join(tmp, '_metrics'), remoteUrl: remote, identity: { name: 'T', email: 't@example.invalid' } });
      await pub.publish(() => ({ [sc.INDEX_PATH]: 'x\n' }), 'x');
      const hooks = path.join(pub.cloneDir, '.git', 'hooks');
      assert.equal(fs.existsSync(hooks) ? fs.readdirSync(hooks).length : 0, 0, 'no template hooks were copied');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('takes a canonical run through the store to passed', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-pass-')));
    try {
      const b = path.join(tmp, 'v1');
      const m = manifest();
      const s0 = { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() };
      store.createRun(b, m, sm.admit(m, s0), s0);
      const p = store.runPaths(b, SHA);
      const st = JSON.parse(fs.readFileSync(p.state, 'utf8'));
      fs.writeFileSync(p.state, JSON.stringify({ ...st, state: 'awaiting-review' }));
      const passed = store.updateRun(b, SHA, (state, man) => sm.accept(state, 'jason', T0 + 5, man));
      assert.equal(passed.state, 'passed');
      assert.equal(store.readTransitions(b, SHA).at(-1).code, 'OPERATOR_ACCEPTED');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
