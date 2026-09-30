'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const sm = require('../lib/release-certification/state-machine');
const { STATES, EXTEND, HARD_FAIL, TRANSITION, REFUSAL, CertificationError } = require('../lib/release-certification/codes');
const fx = require('./_release-certification-fixtures');

const { SHA, GEN, WTID, MIN } = fx;

const HOUR = 60 * MIN;

/**
 * A manifest for the test candidate.
 * @param {object} [thresholds] - Threshold overrides
 * @returns {object} Manifest
 */
function manifest(thresholds) {
  return fx.manifest({ createdAt: 1000, worktreePath: '/tmp/rc-wt', host: 'test-host', thresholds });
}

/** Thresholds small enough to reach the target in a few samples. */
const FAST = { targetQualifiedMs: 3 * MIN, maxIntervalMs: 2 * MIN, ptyMinAttaches: 2, ptyMinDetaches: 2, ptyMinSpanMs: 2 * MIN };

/**
 * Healthy observations with per-probe overrides.
 * @param {object} [over] - Overrides; null makes a probe unreachable
 * @returns {object} Observations
 */
function obs(over = {}) {
  return fx.observations(over, { server: { startedAt: 500_000 }, ttyd: { poolUsed: 3 }, pty: { instance: 'srv-1' } });
}

/**
 * A sample taken `t` ms after the manifest's reference time.
 * @param {number} t - Offset in ms
 * @param {object} [o] - Observations
 * @param {{mono?: number, runner?: string}} [opts] - Monotonic reading and runner identity
 * @returns {object} Sample
 */
function sample(t, o = obs(), opts = {}) {
  return fx.sample(t, o, { monoAt: opts.mono ?? t, runnerInstance: opts.runner ?? 'runner-1' });
}

/**
 * Admit at t=0, then fold samples in order.
 * @param {object} m - Manifest
 * @param {object[]} samples - Samples after admission
 * @returns {{state: object, events: object[], last: object}} Final state, every event, last reduce result
 */
function run(m, samples) {
  let { state, events } = sm.admit(m, sample(0));
  let last = null;
  for (const s of samples) {
    last = sm.reduce(state, m, s);
    state = last.state;
    events = events.concat(last.events);
  }
  return { state, events, last };
}

/**
 * Assert a function throws a CertificationError with a code.
 * @param {Function} fn - Thunk
 * @param {string} code - Expected REFUSAL code
 * @returns {CertificationError} The error
 */
function refuses(fn, code) {
  let caught = null;
  try { fn(); } catch (err) { caught = err; }
  assert.ok(caught instanceof CertificationError, `expected CertificationError ${code}, got ${caught}`);
  assert.equal(caught.code, code);
  return caught;
}

describe('buildManifest', () => {
  it('pins the candidate and keeps sensitive fields under private', () => {
    const m = manifest();
    assert.equal(m.candidateSha, SHA);
    assert.equal(m.schema, 'tc.release-certification/v1');
    assert.deepEqual(m.private, { worktreePath: '/tmp/rc-wt', worktreeId: WTID, host: 'test-host', publishRemote: null, checksExchange: null, isolationProducer: null, baseline: { ttydGeneration: GEN } });
    assert.deepEqual([m.isolation, m.baselineSource], ['none', 'admission'], 'a host run attests no isolation, and its baseline comes from admission');
    assert.equal(m.runId, fx.RUN_ID, 'the host-minted run id is pinned under the digest');
    assert.equal(m.checksSource, 'gh');
    assert.equal(m.publishActor, true);
    assert.equal(m.thresholds.targetQualifiedMs, 259_200_000);
    assert.equal(m.thresholds.maxIntervalMs, 150_000);
  });

  for (const [name, input] of [
    ['a short SHA', { candidateSha: 'abc' }],
    ['an uppercase SHA', { candidateSha: 'A'.repeat(40) }],
    ['a relative worktree', { worktreePath: 'rc-wt' }],
    ['duplicate required checks', { requiredChecks: ['test', 'test'] }],
    ['an unknown threshold', { thresholds: { nope: 1 } }],
    ['a zero threshold', { thresholds: { maxIntervalMs: 0 } }],
    ['a missing ttyd generation', { ttydGeneration: '' }],
    ['a malformed repository', { repository: 'not a repo' }],
    ['an unknown required-checks source', { requiredChecksSource: 'guess' }],
    ['a publishActor that is not a boolean', { publishActor: 'no' }],
    ['no required checks, which would pass GitHub vacuously', { requiredChecks: [] }],
    ['a worktree id that is not a sha256', { worktreeId: 'abc' }],
    ['no run id', { runId: undefined }],
    ['a run id that is not 32 hex characters', { runId: 'B'.repeat(32) }],
    ['an unknown checks source', { checksSource: 'github' }],
    ['a host-attested run with no exchange directory', { checksSource: 'host-attested' }],
    ['a host-attested run with a relative exchange directory', { checksSource: 'host-attested', checksExchange: 'x' }],
    ['an exchange directory on a gh run', { checksExchange: '/x' }],
    ['a host-attested run publishing to a URL', { checksSource: 'host-attested', checksExchange: '/x', isolationProducer: '/x/g', publishRemote: 'https://github.com/o/r.git' }],
    ['a host-attested run publishing to a file:// URL', { checksSource: 'host-attested', checksExchange: '/x', isolationProducer: '/x/g', publishRemote: 'file:///x/metrics.git' }],
    ['a host-attested run publishing to host:path', { checksSource: 'host-attested', checksExchange: '/x', isolationProducer: '/x/g', publishRemote: 'github.com:o/r.git' }],
    ['a host-attested run with no publish remote', { checksSource: 'host-attested', checksExchange: '/x', isolationProducer: '/x/g' }],
    ['a host-attested run with no isolation producer', { checksSource: 'host-attested', checksExchange: '/x', publishRemote: '/x/m.git' }],
    ['a host-attested run with a relative isolation producer', { checksSource: 'host-attested', checksExchange: '/x', publishRemote: '/x/m.git', isolationProducer: 'guest-setup.sh' }],
    ['an isolation producer on a gh run', { isolationProducer: '/x/g' }]
  ]) {
    it(`refuses ${name}`, () => {
      refuses(() => sm.buildManifest({
        candidateSha: SHA, version: '5.30.0', repository: 'o/r', requiredChecks: ['test'], requiredChecksSource: 'branch-protection', createdAt: 1,
        worktreePath: '/w', worktreeId: WTID, ttydGeneration: GEN, runId: fx.RUN_ID, ...input
      }), REFUSAL.INVALID_MANIFEST);
    });
  }

  it('reports whether the manifest uses the canonical thresholds', () => {
    assert.equal(sm.isCanonical(manifest()), true);
    assert.equal(sm.isCanonical(manifest(FAST)), false);
  });
});

describe('classify', () => {
  const hardCases = [
    ['HEAD moved', { worktree: { headSha: 'b'.repeat(40) } }, HARD_FAIL.HEAD_DRIFT],
    ['worktree on a branch', { worktree: { detached: false } }, HARD_FAIL.WORKTREE_NOT_DETACHED],
    ['worktree dirty', { worktree: { dirty: true } }, HARD_FAIL.WORKTREE_DIRTY],
    ['runtime proven different', { server: { startupSha: 'c'.repeat(40) } }, HARD_FAIL.RUNTIME_SHA_MISMATCH],
    ['the server runs from another checkout', { server: { checkoutId: 'd'.repeat(64) } }, HARD_FAIL.SERVER_NOT_IN_WORKTREE],
    ['the server checkout moved under the running process', { server: { isStale: true } }, HARD_FAIL.RUNTIME_CHECKOUT_DRIFT],
    ['the server checkout on disk is another commit', { server: { currentDiskSha: 'e'.repeat(40) } }, HARD_FAIL.RUNTIME_CHECKOUT_DRIFT],
    ['this platform has no owned ttyd', { ttyd: { applicable: false } }, HARD_FAIL.TTYD_NOT_APPLICABLE],
    ['version differs', { server: { runningVersion: '5.29.0' } }, HARD_FAIL.VERSION_MISMATCH],
    ['ttyd not the owned binary', { ttyd: { managed: false } }, HARD_FAIL.TTYD_NOT_OWNED],
    ['ttyd generation changed', { ttyd: { generation: '999@later' } }, HARD_FAIL.TTYD_GENERATION_CHANGED],
    ['leak fired', { ttyd: { leakState: 'fired' } }, HARD_FAIL.LEAK_FIRED],
    ['a wedged child', { ttyd: { wedgedCount: 1 } }, HARD_FAIL.WEDGED_CHILD],
    ['the orphan gate tripped', { ttyd: { orphanGate: true } }, HARD_FAIL.ORPHAN_GATE],
    ['a required check failed', { github: { checks: { test: 'failure' } } }, HARD_FAIL.REQUIRED_CHECK_FAILED]
  ];
  for (const [name, over, code] of hardCases) {
    it(`hard-fails when ${name}`, () => {
      const v = sm.classify(manifest(), obs(over));
      assert.deepEqual(v.hardFails.map((r) => r.code), [code]);
      assert.deepEqual(v.extends, []);
    });
  }

  const extendCases = [
    ['the worktree probe is down', { worktree: null }, EXTEND.PROBE_UNKNOWN, 'worktree'],
    ['the server is down', { server: null }, EXTEND.PROBE_UNKNOWN, 'server'],
    ['the runtime SHA was adopted late', { server: { shaBaselineSource: 'late' } }, EXTEND.RUNTIME_UNPROVEN, 'server'],
    ['the runtime SHA baseline is missing', { server: { shaBaselineSource: null } }, EXTEND.RUNTIME_UNPROVEN, 'server'],
    ['a late SHA differs', { server: { shaBaselineSource: 'late', startupSha: 'c'.repeat(40) } }, EXTEND.RUNTIME_UNPROVEN, 'server'],
    ['the server start time is missing', { server: { startedAt: null } }, EXTEND.PROBE_UNKNOWN, 'server'],
    ['the server checkout id is missing', { server: { checkoutId: null } }, EXTEND.PROBE_UNKNOWN, 'server'],
    ['server staleness is unknown', { server: { isStale: null } }, EXTEND.PROBE_UNKNOWN, 'server'],
    ['ttyd ownership is unknown', { ttyd: { managed: null } }, EXTEND.PROBE_UNKNOWN, 'ttyd'],
    ['the leak condition is unknown', { ttyd: { leakState: 'unknown' } }, EXTEND.PROBE_UNKNOWN, 'ttyd'],
    ['the orphan gate is unknown', { ttyd: { orphanGate: null } }, EXTEND.PROBE_UNKNOWN, 'ttyd'],
    ['GitHub is unreachable', { github: { state: 'unavailable' } }, EXTEND.GITHUB_UNAVAILABLE, 'github'],
    ['a required check is still running', { github: { checks: { test: 'pending' } } }, EXTEND.CHECKS_PENDING, 'github'],
    ['a required check is absent', { github: { checks: {} } }, EXTEND.CHECKS_PENDING, 'github'],
    ['the PTY counter is unreachable', { pty: null }, EXTEND.PROBE_UNKNOWN, 'pty']
  ];
  for (const [name, over, code, probe] of extendCases) {
    it(`extends when ${name}`, () => {
      const v = sm.classify(manifest(), obs(over));
      assert.deepEqual(v.hardFails, []);
      assert.equal(v.extends[0].code, code);
      assert.equal(v.extends[0].probe, probe);
    });
  }

  it('ignores a failing check the manifest does not require', () => {
    const v = sm.classify(manifest(), obs({ github: { checks: { test: 'success', lint: 'failure' } } }));
    assert.deepEqual(v, { hardFails: [], extends: [] });
  });

  it('orders several hard fails by priority, candidate first', () => {
    const v = sm.classify(manifest(), obs({ ttyd: { leakState: 'fired' }, worktree: { dirty: true } }));
    assert.deepEqual(v.hardFails.map((r) => r.code), [HARD_FAIL.WORKTREE_DIRTY, HARD_FAIL.LEAK_FIRED]);
  });
});

describe('admit', () => {
  it('starts a healthy candidate running', () => {
    const { state, events } = sm.admit(manifest(), sample(0));
    assert.equal(state.state, STATES.RUNNING);
    assert.equal(state.qualifiedMs, 0);
    assert.deepEqual(events.map((e) => [e.from, e.to, e.code]), [[STATES.NOT_STARTED, STATES.RUNNING, TRANSITION.ADMITTED]]);
  });

  for (const [name, over, code] of [
    ['an unproven runtime', { server: { shaBaselineSource: 'late' } }, EXTEND.RUNTIME_UNPROVEN],
    ['a required check not yet green', { github: { checks: { test: 'pending' } } }, EXTEND.CHECKS_PENDING],
    ['a dirty worktree', { worktree: { dirty: true } }, HARD_FAIL.WORKTREE_DIRTY],
    ['an unreachable probe', { ttyd: null }, EXTEND.PROBE_UNKNOWN]
  ]) {
    it(`refuses ${name}`, () => {
      const err = refuses(() => sm.admit(manifest(), sample(0, obs(over))), REFUSAL.ADMISSION_REFUSED);
      assert.equal(err.details.reasons[0].code, code);
    });
  }
});

describe('interval accrual', () => {
  it('earns the monotonic duration of a healthy interval', () => {
    const { state } = run(manifest(), [sample(MIN)]);
    assert.equal(state.qualifiedMs, MIN);
    assert.equal(state.state, STATES.RUNNING);
  });

  it('earns an interval of exactly the maximum', () => {
    assert.equal(run(manifest(), [sample(150_000)]).state.qualifiedMs, 150_000);
  });

  it('earns nothing for an interval one millisecond over, and extends', () => {
    const { state, events } = run(manifest(), [sample(150_001)]);
    assert.equal(state.qualifiedMs, 0);
    assert.equal(state.state, STATES.EXTENDED);
    assert.deepEqual(state.extensions, { INTERVAL_TOO_LONG: { intervals: 1, lostMs: 150_001 } });
    assert.equal(events.at(-1).code, EXTEND.INTERVAL_TOO_LONG);
  });

  it('detects sleep when wall time outruns monotonic time', () => {
    const { state } = run(manifest(), [sample(10 * MIN, obs(), { mono: MIN })]);
    assert.equal(state.qualifiedMs, 0);
    assert.deepEqual(Object.keys(state.extensions), [EXTEND.SLEEP_DETECTED]);
  });

  it('tolerates small clock disagreement', () => {
    assert.equal(run(manifest(), [sample(MIN + 5000, obs(), { mono: MIN })]).state.qualifiedMs, MIN);
  });

  it('detects a wall clock stepped backwards', () => {
    const { state } = run(manifest(), [sample(-MIN, obs(), { mono: MIN })]);
    assert.deepEqual(state.extensions, { CLOCK_SKEW: { intervals: 1, lostMs: 0 } });
  });

  it('treats a new runner process as a monitor gap', () => {
    const { state } = run(manifest(), [sample(MIN, obs(), { runner: 'runner-2', mono: 5 })]);
    assert.equal(state.qualifiedMs, 0);
    assert.deepEqual(Object.keys(state.extensions), [EXTEND.MONITOR_GAP]);
  });

  it('refuses monotonic time that did not advance within one runner', () => {
    const { state } = sm.admit(manifest(), sample(0, obs(), { mono: 500 }));
    refuses(() => sm.reduce(state, manifest(), sample(MIN, obs(), { mono: 500 })), REFUSAL.INVALID_SAMPLE);
  });

  it('refuses a fractional monotonic reading, at admission and after it', () => {
    // Qualified time is summed from monotonic deltas, and the scorecard
    // publishes it as a whole-ms count; a fractional reading would be
    // accepted here and refused only at publish.
    refuses(() => sm.admit(manifest(), sample(0, obs(), { mono: 0.25 })), REFUSAL.INVALID_SAMPLE);
    const { state } = sm.admit(manifest(), sample(0, obs(), { mono: 500 }));
    refuses(() => sm.reduce(state, manifest(), sample(MIN, obs(), { mono: 500 + MIN + 0.5 })), REFUSAL.INVALID_SAMPLE);
  });

  it('returns to running after the next pair of healthy samples, keeping earned time', () => {
    const { state, events } = run(manifest(), [
      sample(1 * MIN),
      sample(2 * MIN, obs({ server: null })),
      sample(3 * MIN),
      sample(4 * MIN)
    ]);
    assert.equal(state.state, STATES.RUNNING);
    assert.equal(state.qualifiedMs, 2 * MIN);
    assert.deepEqual(events.slice(1).map((e) => [e.to, e.code]), [
      [STATES.EXTENDED, EXTEND.PROBE_UNKNOWN],
      [STATES.RUNNING, TRANSITION.RECOVERED]
    ]);
    assert.deepEqual(state.extensions, { PROBE_UNKNOWN: { intervals: 2, lostMs: 2 * MIN } });
  });

  it('extends through a server restart on the same SHA and ttyd generation', () => {
    const restarted = obs({ server: { startedAt: 900_000 }, pty: { instance: 'srv-2', attaches: 0, detaches: 0 } });
    const { state } = run(manifest(), [sample(MIN, obs({ server: null })), sample(2 * MIN, restarted), sample(3 * MIN, restarted), sample(4 * MIN, restarted)]);
    assert.equal(state.state, STATES.RUNNING);
    assert.equal(state.failure, null);
    assert.equal(state.qualifiedMs, 2 * MIN);
  });

  it('earns nothing for an interval the server restarted inside, however quickly', () => {
    const restarted = obs({ server: { startedAt: 1_030_000 }, pty: { instance: 'srv-2', attaches: 0, detaches: 0 } });
    const { state, events } = run(manifest(), [sample(MIN), sample(2 * MIN, restarted)]);
    assert.equal(state.qualifiedMs, MIN);
    assert.equal(state.state, STATES.EXTENDED);
    assert.deepEqual(state.extensions, { SERVER_RESTARTED: { intervals: 1, lostMs: MIN } });
    assert.equal(events.at(-1).code, EXTEND.SERVER_RESTARTED);
    assert.equal(run(manifest(), [sample(MIN), sample(2 * MIN, restarted), sample(3 * MIN, restarted)]).state.state, STATES.RUNNING);
  });

  it('never moves updatedAt backwards when the wall clock is stepped back', () => {
    const { state } = run(manifest(), [sample(MIN), sample(-5 * MIN, obs(), { mono: 2 * MIN })]);
    assert.equal(state.updatedAt, 1_000_000 + MIN);
    assert.deepEqual(Object.keys(state.extensions), [EXTEND.CLOCK_SKEW]);
  });

  it('never earns more qualified time than updatedAt moved (PR #1975 review)', () => {
    // Monotonic time ahead of the wall clock, within tolerance: earns the wall time.
    assert.equal(run(manifest(), [sample(MIN - 5000, obs(), { mono: MIN })]).state.qualifiedMs, MIN - 5000);
    // A clock stepped back re-covers wall time already counted; none of it is earned twice.
    const { state, events } = run(manifest(), [
      sample(1 * MIN, obs(), { mono: 1 * MIN }),
      sample(2 * MIN, obs(), { mono: 2 * MIN }),
      sample(3 * MIN, obs(), { mono: 3 * MIN }),
      sample(1 * MIN, obs(), { mono: 4 * MIN }),
      sample(2 * MIN, obs(), { mono: 5 * MIN }),
      sample(3 * MIN, obs(), { mono: 6 * MIN }),
      sample(4 * MIN, obs(), { mono: 7 * MIN })
    ]);
    assert.ok(state.qualifiedMs <= state.updatedAt - state.startedAt, `${state.qualifiedMs} > ${state.updatedAt - state.startedAt}`);
    assert.equal(state.qualifiedMs, 4 * MIN);
    assert.ok(events.every((e, i) => i === 0 || e.at >= events[i - 1].at), 'transition times never go back');
    assert.ok(events.every((e) => e.at <= state.updatedAt));
  });

  it('refuses an admission sample that predates its manifest', () => {
    refuses(() => sm.admit(manifest(), sample(-1_000_000)), REFUSAL.INVALID_SAMPLE);
  });

  it('asserts every transition it emits against the shared table', () => {
    const codes = require('../lib/release-certification/codes');
    assert.equal(codes.transitionAllowed('awaiting-review', 'passed', 'OPERATOR_ACCEPTED'), true);
    assert.equal(codes.transitionAllowed('running', 'passed', 'OPERATOR_ACCEPTED'), false);
    assert.equal(codes.reachable('running', 'passed'), true);
    assert.equal(codes.reachable('awaiting-review', 'running'), false);
    assert.equal(codes.reachable('passed', 'failed'), false);
  });

  it('does not mutate the state it is given', () => {
    const admitted = sm.admit(manifest(), sample(0)).state;
    const before = structuredClone(admitted);
    sm.reduce(admitted, manifest(), sample(MIN));
    assert.deepEqual(admitted, before);
  });
});

describe('hard fails', () => {
  it('fails on an owned ttyd generation change, even across a monitor gap', () => {
    const { state, events } = run(manifest(), [sample(MIN, obs({ ttyd: { generation: '7@restarted' } }), { runner: 'runner-2' })]);
    assert.equal(state.state, STATES.FAILED);
    assert.equal(state.failure.code, HARD_FAIL.TTYD_GENERATION_CHANGED);
    assert.equal(state.failure.sampleSeq, 2);
    assert.equal(events.at(-1).code, HARD_FAIL.TTYD_GENERATION_CHANGED);
  });

  it('fails an extended run', () => {
    const { state, events } = run(manifest(), [sample(MIN, obs({ server: null })), sample(2 * MIN, obs({ ttyd: { wedgedCount: 2 } }))]);
    assert.equal(state.state, STATES.FAILED);
    assert.deepEqual(events.slice(1).map((e) => [e.from, e.to]), [[STATES.RUNNING, STATES.EXTENDED], [STATES.EXTENDED, STATES.FAILED]]);
  });

  it('is terminal', () => {
    const { state } = run(manifest(), [sample(MIN, obs({ ttyd: { leakState: 'fired' } }))]);
    refuses(() => sm.reduce(state, manifest(), sample(2 * MIN)), REFUSAL.ALREADY_TERMINAL);
    refuses(() => sm.cancel(state, 'op', 1), REFUSAL.ALREADY_TERMINAL);
  });

  it('still fails a run awaiting review', () => {
    const m = manifest(FAST);
    const busy = (n, t) => obs({ pty: { attaches: n, detaches: n, lastAt: 1_000_000 + t } });
    const reviewing = run(m, [sample(MIN, busy(1, MIN)), sample(2 * MIN, busy(1, MIN)), sample(3 * MIN, busy(2, 3 * MIN))]).state;
    assert.equal(reviewing.state, STATES.AWAITING_REVIEW);
    const { state } = sm.reduce(reviewing, m, sample(4 * MIN, obs({ worktree: { dirty: true }, pty: { attaches: 2, detaches: 2, lastAt: 1_000_000 + 3 * MIN } })));
    assert.equal(state.state, STATES.FAILED);
  });
});

describe('target, PTY use and review', () => {
  const m = manifest(FAST);
  const busy = (n, lastAt) => obs({ pty: { attaches: n, detaches: n, lastAt: 1_000_000 + lastAt } });

  it('reaches awaiting-review, never passed, and only acceptance passes', () => {
    const { state, events } = run(m, [sample(MIN, busy(1, MIN)), sample(2 * MIN, busy(1, MIN)), sample(3 * MIN, busy(2, 3 * MIN))]);
    assert.equal(state.state, STATES.AWAITING_REVIEW);
    assert.equal(events.at(-1).code, TRANSITION.TARGET_REACHED);
    const at = 1_000_000 + 4 * MIN;
    refuses(() => sm.accept(state, 'jason', at, m), REFUSAL.NOT_CANONICAL);
    const passed = sm.accept(state, 'jason', at, manifest());
    assert.equal(passed.state.state, STATES.PASSED);
    assert.deepEqual(passed.state.acceptance, { actor: 'jason', at });
    assert.equal(passed.events[0].code, TRANSITION.OPERATOR_ACCEPTED);
    assert.equal(passed.events[0].at, at);
  });

  it('never records an acceptance before the review it accepts, whatever the operator clock says', () => {
    const { state, events } = run(m, [sample(MIN, busy(1, MIN)), sample(2 * MIN, busy(1, MIN)), sample(3 * MIN, busy(2, 3 * MIN))]);
    const passed = sm.accept(state, 'jason', 5, manifest());
    assert.deepEqual(passed.state.acceptance, { actor: 'jason', at: state.updatedAt });
    assert.ok(passed.events[0].at >= events.at(-1).at);
  });

  it('does not begin review on an interval that did not qualify', () => {
    const early = run(m, [sample(MIN, busy(1, MIN)), sample(2 * MIN, busy(1, MIN)), sample(3 * MIN)]).state;
    assert.equal(early.state, STATES.EXTENDED);
    const { state } = sm.reduce(early, m, sample(4 * MIN, obs({ github: { state: 'unavailable' }, pty: { attaches: 2, detaches: 2, lastAt: 1_000_000 + 4 * MIN } })));
    assert.equal(state.state, STATES.EXTENDED);
    assert.equal(sm.reduce(state, m, sample(5 * MIN, busy(2, 4 * MIN))).state.state, STATES.EXTENDED);
    const reviewing = sm.reduce(sm.reduce(state, m, sample(5 * MIN, busy(2, 4 * MIN))).state, m, sample(6 * MIN, busy(2, 4 * MIN))).state;
    assert.equal(reviewing.state, STATES.AWAITING_REVIEW);
  });

  it('stops earning at the target, so earned and lost time never exceed elapsed', () => {
    const { state } = run(m, [sample(2 * MIN), sample(4 * MIN), sample(6 * MIN)]);
    assert.equal(state.qualifiedMs, 3 * MIN);
    assert.deepEqual(state.extensions, { PTY_TARGET_UNMET: { intervals: 2, lostMs: 3 * MIN } });
    const s = sm.summarize(state, m, 1_000_000 + 6 * MIN);
    assert.ok(s.qualifiedMs + s.extensions.PTY_TARGET_UNMET.lostMs <= s.elapsedMs);
    assert.equal(s.remainingMs, 0);
  });

  it('refuses every operation on a passed run', () => {
    const reviewing = run(m, [sample(MIN, busy(1, MIN)), sample(2 * MIN, busy(1, MIN)), sample(3 * MIN, busy(2, 3 * MIN))]).state;
    const passed = sm.accept(reviewing, 'jason', 5, manifest()).state;
    refuses(() => sm.accept(passed, 'jason', 6, manifest()), REFUSAL.ALREADY_TERMINAL);
    refuses(() => sm.cancel(passed, 'jason', 6), REFUSAL.ALREADY_TERMINAL);
    refuses(() => sm.reduce(passed, m, sample(4 * MIN)), REFUSAL.ALREADY_TERMINAL);
  });

  it('refuses every operation on a cancelled or failed run', () => {
    const live = run(m, [sample(MIN)]).state;
    const cancelled = sm.cancel(live, 'jason', 5).state;
    const failed = run(m, [sample(MIN, obs({ worktree: { dirty: true } }))]).state;
    for (const [name, terminal] of [['cancelled', cancelled], ['failed', failed]]) {
      for (const [op, fn] of [
        ['reduce', () => sm.reduce(terminal, m, sample(2 * MIN))],
        ['accept', () => sm.accept(terminal, 'jason', 6, manifest())],
        ['cancel', () => sm.cancel(terminal, 'jason', 6)]
      ]) {
        const err = refuses(fn, REFUSAL.ALREADY_TERMINAL);
        assert.equal(err.details.state, terminal.state, `${op} on ${name}`);
      }
    }
  });

  it('cancels a run awaiting review', () => {
    const reviewing = run(m, [sample(MIN, busy(1, MIN)), sample(2 * MIN, busy(1, MIN)), sample(3 * MIN, busy(2, 3 * MIN))]).state;
    assert.equal(sm.cancel(reviewing, 'jason', 7).state.state, STATES.CANCELLED);
  });

  it('refuses acceptance before review and from a malformed actor', () => {
    const { state } = run(m, [sample(MIN)]);
    refuses(() => sm.accept(state, 'jason', 5, manifest()), REFUSAL.NOT_AWAITING_REVIEW);
    refuses(() => sm.accept(state, 'has space', 5, manifest()), REFUSAL.INVALID_ACTOR);
  });

  it('holds extended at the target until the PTY target is met, then goes to review', () => {
    const { state } = run(m, [sample(MIN), sample(2 * MIN), sample(3 * MIN), sample(4 * MIN)]);
    assert.equal(state.state, STATES.EXTENDED);
    assert.equal(state.extensions.PTY_TARGET_UNMET.intervals, 2);
    const after = run(m, [sample(MIN), sample(2 * MIN), sample(3 * MIN, busy(1, 3 * MIN)), sample(5 * MIN, busy(2, 5 * MIN))]);
    assert.equal(after.state.state, STATES.AWAITING_REVIEW);
  });

  it('does not count events from before admission', () => {
    const pre = obs({ pty: { attaches: 30, detaches: 30, lastAt: 999_000 } });
    let { state } = sm.admit(m, sample(0, pre));
    state = sm.reduce(state, m, sample(MIN, pre)).state;
    assert.equal(state.pty.attaches, 0);
    assert.equal(state.pty.firstEventAt, null);
  });

  it('carries counts across a server restart and ignores a counter that goes backwards', () => {
    const { state } = run(m, [
      sample(1 * MIN, obs({ pty: { attaches: 3, detaches: 2, lastAt: 1_000_000 + MIN } })),
      sample(2 * MIN, obs({ pty: { attaches: 1, detaches: 1, lastAt: 1_000_000 + MIN } })),
      sample(3 * MIN, obs({ pty: { instance: 'srv-2', attaches: 2, detaches: 2, lastAt: 1_000_000 + 3 * MIN } }))
    ]);
    assert.equal(state.pty.attaches, 5);
    assert.equal(state.pty.detaches, 4);
    assert.equal(state.pty.firstEventAt, 1_000_000 + MIN);
    assert.equal(state.pty.lastEventAt, 1_000_000 + 3 * MIN);
  });

  it('needs every PTY minimum, including the full span', () => {
    const t = manifest().thresholds;
    const p = { attaches: 25, detaches: 25, firstEventAt: 0, lastEventAt: 6 * HOUR };
    assert.equal(sm.ptyTargetMet(p, t), true);
    assert.equal(sm.ptyTargetMet({ ...p, attaches: 24 }, t), false);
    assert.equal(sm.ptyTargetMet({ ...p, detaches: 24 }, t), false);
    assert.equal(sm.ptyTargetMet({ ...p, lastEventAt: 6 * HOUR - 1 }, t), false);
    assert.equal(sm.ptyTargetMet({ ...p, firstEventAt: null }, t), false);
  });

  it('reports the PTY span in the summary', () => {
    const { state } = run(m, [sample(MIN, busy(1, MIN)), sample(2 * MIN, busy(2, 2 * MIN))]);
    assert.equal(sm.summarize(state, m, 1_000_000 + 2 * MIN).pty.spanMs, MIN);
  });

  it('caps the pool-use trend', () => {
    const tiny = manifest({ trendBucketMs: 1 });
    let { state } = sm.admit(tiny, sample(0));
    state.poolUsedTrend = Array.from({ length: 2000 }, (_, i) => ({ at: i, used: i }));
    state = sm.reduce(state, tiny, sample(MIN)).state;
    assert.equal(state.poolUsedTrend.length, 2000);
    assert.equal(state.poolUsedTrend.at(-1).used, 3);
    assert.equal(state.poolUsedTrend[0].used, 1);
  });

  it('keeps an hourly pool-use trend', () => {
    const samples = [];
    for (let i = 1; i <= 130; i++) samples.push(sample(i * MIN, obs({ ttyd: { poolUsed: i } })));
    const { state } = run(manifest(), samples);
    assert.deepEqual(state.poolUsedTrend.map((p) => p.used), [3, 60, 120]);
  });
});

describe('cancel and summarize', () => {
  it('cancels a live run with the actor recorded', () => {
    const { state } = run(manifest(), [sample(MIN, obs({ server: null }))]);
    assert.equal(state.state, STATES.EXTENDED);
    const out = sm.cancel(state, 'jason', 1_000_000 + 2 * MIN);
    assert.equal(out.state.state, STATES.CANCELLED);
    assert.deepEqual(out.state.cancellation, { actor: 'jason', at: 1_000_000 + 2 * MIN });
    // A clock behind the last sample stamps the cancellation at the run's time.
    assert.deepEqual(sm.cancel(state, 'jason', 9).state.cancellation, { actor: 'jason', at: state.updatedAt });
  });

  it('summarizes progress as structured health', () => {
    const m = manifest();
    const { state } = run(m, [sample(MIN), sample(2 * MIN, obs({ github: { state: 'unavailable' } }))]);
    const s = sm.summarize(state, m, 1_000_000 + 2 * MIN + 10_000);
    assert.equal(s.state, STATES.EXTENDED);
    assert.equal(s.canonicalThresholds, true);
    assert.equal(s.qualifiedMs, MIN);
    assert.equal(s.remainingMs, 259_200_000 - MIN);
    assert.equal(s.elapsedMs, 2 * MIN + 10_000);
    assert.equal(s.monitorStale, false);
    assert.deepEqual(s.extensions, { GITHUB_UNAVAILABLE: { intervals: 1, lostMs: MIN } });
    assert.equal(s.pty.met, false);
    assert.equal('private' in s, false);
  });

  it('reports a stale monitor for a live run whose samples stopped', () => {
    const m = manifest();
    const { state } = run(m, [sample(MIN)]);
    assert.equal(sm.summarize(state, m, 1_000_000 + MIN + 150_001).monitorStale, true);
  });

  it('freezes elapsed time at the terminal transition', () => {
    const m = manifest();
    const { state } = run(m, [sample(MIN)]);
    const cancelled = sm.cancel(state, 'op', 1_000_000 + 5 * MIN).state;
    const s = sm.summarize(cancelled, m, 1_000_000 + 99 * MIN);
    assert.equal(s.elapsedMs, 5 * MIN);
    assert.equal(s.monitorStale, false);
  });
});
