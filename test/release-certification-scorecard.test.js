'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const sm = require('../lib/release-certification/state-machine');
const sc = require('../lib/release-certification/scorecard');
const { STATES } = require('../lib/release-certification/codes');
const fx = require('./_release-certification-fixtures');

const { SHA, WTID, GEN, MIN, T0 } = fx;

const DIGEST = 'f'.repeat(64);
const WORKTREE = '/Users/secret-operator/private/rc-worktree';
const HOST = 'secret-host.tail123678.ts.net';

/**
 * A manifest carrying recognisable private values.
 * @param {object} [thresholds] - Overrides
 * @returns {object} Manifest
 */
function manifest(thresholds) {
  return fx.manifest({ worktreePath: WORKTREE, host: HOST, thresholds });
}

/**
 * Healthy observations.
 * @param {object} [over] - Per-probe overrides
 * @returns {object} Observations
 */
function obs(over = {}) {
  return fx.observations(over, { ttyd: { poolUsed: 4 } });
}

/**
 * A sample carrying a diagnostic, which must never be published.
 * @param {number} t - Offset ms
 * @param {object} [o] - Observations
 * @returns {object} Sample
 */
function sample(t, o = obs()) {
  return fx.sample(t, o, { diagnostics: { server: 'http-401' } });
}

/**
 * Run samples through the state machine, carrying a manifest digest as the store would.
 * @param {object} m - Manifest
 * @param {object[]} samples - Samples after admission
 * @returns {{state: object, events: object[]}} Final state and all events
 */
function run(m, samples) {
  let { state, events } = sm.admit(m, sample(0));
  state = { ...state, manifestDigest: DIGEST };
  for (const s of samples) {
    const out = sm.reduce(state, m, s);
    state = out.state;
    events = events.concat(out.events);
  }
  return { state, events };
}

const FAST = { targetQualifiedMs: 2 * MIN, ptyMinAttaches: 1, ptyMinDetaches: 1, ptyMinSpanMs: 1 };
const busy = (n, t) => obs({ pty: { attaches: n, detaches: n, lastAt: T0 + t } });

describe('published documents (#1949 C02)', () => {
  it('lays out each candidate under release-certification/v1/', () => {
    assert.deepEqual(sc.paths(SHA), {
      admission: `release-certification/v1/admissions/${SHA}.json`,
      scorecard: `release-certification/v1/scorecards/${SHA}.json`,
      events: `release-certification/v1/events/${SHA}.ndjson`
    });
    assert.equal(sc.INDEX_PATH, 'release-certification/v1/index.json');
  });

  it('admits with the manifest digest and the rules the run is judged by', () => {
    const a = sc.admissionRecord(manifest(), DIGEST);
    assert.deepEqual(Object.keys(a).sort(), ['admittedAt', 'baselineSource', 'candidateSha', 'canonicalThresholds', 'checksSource', 'isolation', 'manifestDigest', 'repository', 'requiredChecks', 'requiredChecksSource', 'runId', 'schema', 'thresholds', 'version']);
    assert.equal(a.requiredChecksSource, 'branch-protection');
    assert.deepEqual([a.checksSource, a.runId], ['gh', fx.RUN_ID], 'how the checks were judged, and for which host-minted run, is public');
    assert.deepEqual([a.isolation, a.baselineSource], ['none', 'admission']);
    for (const [field, value] of [['checksSource', undefined], ['checksSource', 'github'], ['runId', undefined], ['runId', 'short'], ['isolation', 'attested'], ['baselineSource', 'staging'], ['baselineSource', undefined]]) {
      const bad = { ...a, [field]: value };
      if (value === undefined) delete bad[field];
      assert.notDeepEqual(sc.validateAdmission(bad), [], `an admission with ${field} ${value} must not validate`);
    }
    assert.equal(sc.scorecard(run(manifest(), [sample(MIN)]).state, manifest(), T0 + MIN, 1).checksSource, 'gh');
    assert.equal(a.manifestDigest, DIGEST);
    assert.equal(a.canonicalThresholds, true);
    assert.equal(a.admittedAt, T0);
    assert.deepEqual(sc.validateAdmission(a), []);
    assert.equal(sc.admissionRecord(manifest(FAST), DIGEST).canonicalThresholds, false);
  });

  it('builds a scorecard that validates, carrying the digest and the standing', () => {
    const m = manifest();
    const { state } = run(m, [sample(MIN), sample(2 * MIN, obs({ server: null }))]);
    const c = sc.scorecard(state, m, T0 + 2 * MIN, 3);
    assert.deepEqual(sc.validateScorecard(c), []);
    assert.equal(c.manifestDigest, DIGEST);
    assert.equal(c.state, STATES.EXTENDED);
    assert.equal(c.qualifiedMs, MIN);
    assert.deepEqual(c.extensions, { PROBE_UNKNOWN: { intervals: 1, lostMs: MIN } });
    assert.equal(c.publishSeq, 3);
    assert.equal(c.failure, null);
    assert.equal(c.requiredChecksSource, 'branch-protection', 'readers can see where the required checks came from');
  });

  it('publishes only a failure code and time, not the per-probe reasons', () => {
    const m = manifest();
    const { state } = run(m, [sample(MIN, obs({ worktree: { dirty: true } }))]);
    const c = sc.scorecard(state, m, T0 + MIN, 1);
    assert.deepEqual(c.failure, { code: 'WORKTREE_DIRTY', at: T0 + MIN });
    assert.deepEqual(sc.validateScorecard(c), []);
  });

  it('publishes the accepting operator, or withholds the id when the manifest does, whatever the caller passes', () => {
    const m = manifest(FAST);
    const reviewing = run(m, [sample(MIN, busy(1, MIN)), sample(2 * MIN, busy(2, 2 * MIN))]).state;
    assert.equal(reviewing.state, STATES.AWAITING_REVIEW);
    const passed = sm.accept(reviewing, 'jason', T0 + 3 * MIN, manifest()).state;
    const canonical = manifest();
    assert.deepEqual(sc.scorecard(passed, canonical, T0 + 3 * MIN, 1).acceptance, { actor: 'jason', at: T0 + 3 * MIN });
    const withheld = { ...canonical, publishActor: false };
    const quiet = sc.scorecard(passed, withheld, T0 + 3 * MIN, 1);
    assert.deepEqual(quiet.acceptance, { at: T0 + 3 * MIN });
    assert.deepEqual(sc.validateScorecard(quiet), []);
    const overridden = sc.scorecard(passed, withheld, T0 + 3 * MIN, 1, { publishActor: true });
    assert.deepEqual(overridden.acceptance, { at: T0 + 3 * MIN }, 'no caller option can publish an id the manifest withheld');
  });

  it('never publishes the worktree path, host, ttyd generation or diagnostics', () => {
    const m = manifest();
    const { state, events } = run(m, [sample(MIN), sample(2 * MIN, obs({ github: { state: 'unavailable' } })), sample(3 * MIN, obs({ ttyd: { leakState: 'fired' } }))]);
    const cancelled = sm.cancel(run(m, [sample(MIN)]).state, 'op', T0 + 5 * MIN).state;
    const docs = [
      sc.admissionRecord(m, DIGEST),
      sc.scorecard(state, m, T0 + 3 * MIN, 1),
      sc.scorecard(cancelled, m, T0 + 5 * MIN, 1),
      ...events.map(sc.eventLine),
      sc.indexDoc([sc.scorecard(state, m, T0 + 3 * MIN, 1)])
    ];
    const text = docs.map(sc.serialize).join('');
    for (const secret of [WORKTREE, 'secret-operator', HOST, GEN, '4242', 'http-401', WTID, 'runner', 'diagnostics', 'private']) {
      assert.equal(text.includes(secret), false, `published text must not contain ${secret}`);
    }
  });

  it('builds event lines and an index newest first, each valid', () => {
    const m = manifest();
    const { events } = run(m, [sample(MIN, obs({ server: null })), sample(2 * MIN), sample(3 * MIN)]);
    const lines = events.map(sc.eventLine);
    assert.deepEqual(lines.map((l) => [l.from, l.to, l.code]), [
      ['not-started', 'running', 'ADMITTED'], ['running', 'extended', 'PROBE_UNKNOWN'], ['extended', 'running', 'RECOVERED']
    ]);
    for (const l of lines) assert.deepEqual(sc.validateEvent(l), []);
    const older = { candidateSha: 'b'.repeat(40), version: '5.29.0', state: 'passed', updatedAt: 5 };
    const newer = { candidateSha: SHA, version: '5.30.0', state: 'running', updatedAt: 9 };
    const idx = sc.indexDoc([older, newer]);
    assert.deepEqual(idx.candidates.map((c) => c.candidateSha), [SHA, 'b'.repeat(40)]);
    assert.deepEqual(sc.validateIndex(idx), []);
  });

  it('serializes deterministically, so published bytes compare', () => {
    const a = sc.admissionRecord(manifest(), DIGEST);
    assert.equal(sc.serialize(a), sc.serialize(sc.admissionRecord(manifest(), DIGEST)));
    assert.ok(sc.serialize(a).endsWith('}\n'));
  });
});

describe('the certification section of the combined scorecard (#1949)', () => {
  const m = manifest();
  const newer = sc.scorecard(run(m, [sample(MIN)]).state, m, T0 + 5 * MIN, 2);
  const older = { ...sc.scorecard(run(m, [sample(MIN)]).state, m, T0, 1), candidateSha: 'b'.repeat(40), updatedAt: 1 };

  it('lists every candidate newest first and carries the newest scorecard', () => {
    const summary = sc.certificationSummary([older, newer]);
    assert.equal(summary.schema, 'tc.release-certification.summary/v1');
    assert.deepEqual(summary.candidates.map((c) => c.candidateSha), [SHA, 'b'.repeat(40)]);
    assert.deepEqual(summary.current, newer);
    assert.deepEqual(sc.validateCertificationSummary(summary), []);
    assert.deepEqual(sc.certificationSummary([]), { schema: sc.SCHEMAS.summary, candidates: [], current: null });
    assert.deepEqual(sc.validateCertificationSummary(sc.certificationSummary([])), []);
  });

  it('refuses a summary whose current is not the newest candidate, is invalid, or carries extra fields', () => {
    const good = () => sc.certificationSummary([older, newer]);
    assert.deepEqual(sc.validateCertificationSummary({ ...good(), current: older }), ['FIELD:current']);
    assert.deepEqual(sc.validateCertificationSummary({ ...good(), current: { ...newer, worktreePath: '/x' } }), ['FIELD:current']);
    assert.deepEqual(sc.validateCertificationSummary({ ...good(), current: null }), ['FIELD:current']);
    assert.deepEqual(sc.validateCertificationSummary({ ...good(), host: 'h' }), ['UNKNOWN_FIELD:host']);
    assert.deepEqual(sc.validateCertificationSummary({ ...good(), candidates: [{ candidateSha: SHA }] }), ['FIELD:candidates']);
    assert.deepEqual(sc.validateCertificationSummary({ ...good(), candidates: [] }), ['FIELD:current'], 'a current scorecard needs a listed candidate');
    assert.deepEqual(sc.validateCertificationSummary({ schema: 'tc.scorecard/v1' }), ['SCHEMA']);
  });
});

describe('validators refuse what the builder would never emit', () => {
  const m = manifest();
  const good = () => sc.scorecard(run(m, [sample(MIN)]).state, m, T0 + MIN, 1);

  for (const [name, mutate, violation] of [
    ['a wrong schema', (d) => { d.schema = 'x'; }, 'SCHEMA'],
    ['an extra field such as a worktree path', (d) => { d.worktreePath = WORKTREE; }, 'UNKNOWN_FIELD:worktreePath'],
    ['a short SHA', (d) => { d.candidateSha = 'abc'; }, 'FIELD:candidateSha'],
    ['an unknown state', (d) => { d.state = 'certified'; }, 'FIELD:state'],
    ['an unknown extension code', (d) => { d.extensions.MADE_UP = { intervals: 1, lostMs: 1 }; }, 'FIELD:extensions'],
    ['a failure on a running scorecard', (d) => { d.failure = { code: 'LEAK_FIRED', at: 1 }; }, 'FIELD:failure'],
    ['a passed scorecard with no acceptance', (d) => { d.state = 'passed'; }, 'FIELD:acceptance'],
    ['a negative time', (d) => { d.qualifiedMs = -1; }, 'FIELD:qualifiedMs'],
    ['a publish sequence of zero', (d) => { d.publishSeq = 0; }, 'FIELD:publishSeq'],
    ['a passed state under non-canonical thresholds', (d) => { d.state = 'passed'; d.acceptance = { actor: 'op', at: 1 }; d.canonicalThresholds = false; }, 'FIELD:canonicalThresholds'],
    ['an unknown required-checks source', (d) => { d.requiredChecksSource = 'guess'; }, 'FIELD:requiredChecksSource'],
    ['an unknown checks source', (d) => { d.checksSource = 'github'; }, 'FIELD:checksSource'],
    ['failure reasons, which the builder drops', (d) => { d.state = 'failed'; d.failure = { code: 'LEAK_FIRED', at: 1, reasons: [{ probe: 'ttyd' }] }; }, 'FIELD:failure'],
    ['a PTY server instance id, which holds a pid', (d) => { d.pty.instance = '4242-1-ab'; }, 'FIELD:pty'],
    ['an extra field in the PTY target', (d) => { d.pty.target.host = HOST; }, 'FIELD:pty'],
    ['an extra field in a trend point', (d) => { d.poolUsedTrend = [{ at: 1, used: 1, pid: 4242 }]; }, 'FIELD:poolUsedTrend'],
    ['an extra field in an extension', (d) => { d.extensions.PROBE_UNKNOWN = { intervals: 1, lostMs: 1, probe: 'server' }; }, 'FIELD:extensions'],
    ['an extra field in an acceptance', (d) => { d.state = 'passed'; d.acceptance = { actor: 'op', at: 1, host: HOST }; }, 'FIELD:acceptance']
  ]) {
    it(`refuses a scorecard with ${name}`, () => {
      const d = good();
      mutate(d);
      assert.ok(sc.validateScorecard(d).includes(violation), `${sc.validateScorecard(d)} should include ${violation}`);
    });
  }

  it('refuses an admission with no required checks, a bad digest, or a missing threshold', () => {
    const a = () => sc.admissionRecord(m, DIGEST);
    const noChecks = { ...a(), requiredChecks: [] };
    const badDigest = { ...a(), manifestDigest: 'nope' };
    const t = { ...a().thresholds };
    delete t.maxIntervalMs;
    const missing = { ...a(), thresholds: t };
    assert.deepEqual(sc.validateAdmission(noChecks), ['FIELD:requiredChecks']);
    assert.deepEqual(sc.validateAdmission(badDigest), ['FIELD:manifestDigest']);
    assert.deepEqual(sc.validateAdmission(missing), ['FIELD:thresholds', 'FIELD:canonicalThresholds']);
    assert.deepEqual(sc.validateAdmission({ ...a(), host: HOST }), ['UNKNOWN_FIELD:host']);
    assert.deepEqual(sc.validateAdmission({ ...a(), requiredChecksSource: undefined }), ['FIELD:requiredChecksSource']);
    assert.deepEqual(sc.validateAdmission({ ...a(), requiredChecks: ['test', 'test'] }), ['FIELD:requiredChecks']);
    assert.deepEqual(sc.validateAdmission({ ...a(), requiredChecks: Array.from({ length: 65 }, (_, i) => `c${i}`) }), ['FIELD:requiredChecks']);
    assert.deepEqual(sc.validateAdmission({ ...a(), thresholds: { ...a().thresholds, extra: 1 } }), ['FIELD:thresholds', 'FIELD:canonicalThresholds']);
  });

  it('refuses an admission that claims canonical thresholds it does not have', () => {
    const loose = sc.admissionRecord(manifest(FAST), DIGEST);
    assert.equal(loose.canonicalThresholds, false);
    assert.deepEqual(sc.validateAdmission({ ...loose, canonicalThresholds: true }), ['FIELD:canonicalThresholds']);
  });

  it('refuses a malformed event line and index', () => {
    assert.deepEqual(sc.validateEvent({ schema: sc.SCHEMAS.event, from: 'running', to: 'not-started', code: 'ADMITTED', at: 1, sampleSeq: 1 }), ['FIELD:to']);
    assert.deepEqual(sc.validateEvent({ schema: sc.SCHEMAS.event, from: 'running', to: 'failed', code: 'NOPE', at: 1, sampleSeq: null }), ['FIELD:code']);
    assert.deepEqual(sc.validateIndex({ schema: sc.SCHEMAS.index, candidates: [{ candidateSha: SHA }] }), ['FIELD:candidates']);
    assert.deepEqual(sc.validateIndex({ schema: sc.SCHEMAS.index, candidates: [{ candidateSha: SHA, version: '5.30.0', state: 'running', updatedAt: 1, host: HOST }] }), ['FIELD:candidates']);
    assert.deepEqual(sc.validateIndex(null), ['SCHEMA']);
  });
});
