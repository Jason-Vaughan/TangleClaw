'use strict';

// v6.1 (#2992, V6-21 / A3, Car V61-W1-A): Full / Lean / Minimal operating
// profiles over an immutable safety floor, and the workload-matched
// benchmark aggregator. P04's seven A3 cases, ported, plus the percentile,
// delta and JSONL behavior this module adds.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const a3 = require('../lib/v6/a3-operating-profiles');

describe('resolveProfile (#2992)', () => {
  it('every profile retains the whole safety floor', () => {
    for (const name of a3.PROFILES) {
      const result = a3.resolveProfile(name);
      assert.equal(result.ok, true, name);
      for (const service of a3.SAFETY_FLOOR) assert.ok(result.services.includes(service), `${name} lacks ${service}`);
    }
  });

  it('the floor covers what ADR 0008 names as never configurable', () => {
    for (const s of ['authentication', 'launchBindingVerification', 'controlGateHolds', 'secretScanning', 'tmuxSafetyGuard']) {
      assert.ok(a3.SAFETY_FLOOR.includes(s), s);
    }
  });

  it('disabling a floor service is refused, naming it', () => {
    const out = a3.resolveProfile('Full', { disable: ['audit', 'diagnostics'] });
    assert.equal(out.code, 'SAFETY_FLOOR_IMMUTABLE');
    assert.deepEqual(out.unsafe, ['audit']);
  });

  it('an unknown service or profile fails closed', () => {
    assert.equal(a3.resolveProfile('Lean', { enable: ['phantom'] }).code, 'UNKNOWN_SERVICE');
    assert.equal(a3.resolveProfile('Zero').code, 'UNKNOWN_PROFILE');
    assert.equal(a3.resolveProfile('__proto__').code, 'UNKNOWN_PROFILE');
    assert.equal(a3.resolveProfile('unattended').code, 'UNKNOWN_PROFILE');
  });

  it('overrides add and remove only optional services', () => {
    const x = a3.resolveProfile('Minimal', { enable: ['diagnostics'] });
    assert.ok(x.services.includes('diagnostics'));
    const y = a3.resolveProfile('Full', { disable: ['richPrompt'] });
    assert.ok(!y.services.includes('richPrompt'));
    assert.ok(y.services.includes('authentication'));
  });

  it('profiles strictly reduce ceremony and slow telemetry from Full to Minimal', () => {
    const [full, lean, min] = a3.PROFILES.map((p) => a3.resolveProfile(p));
    assert.ok(full.services.length > lean.services.length && lean.services.length > min.services.length);
    assert.deepEqual(min.services, [...a3.SAFETY_FLOOR].sort());
    assert.ok(full.telemetryCadenceMs < lean.telemetryCadenceMs && lean.telemetryCadenceMs < min.telemetryCadenceMs);
  });

  it('exported vocabularies are frozen', () => {
    assert.ok(Object.isFrozen(a3.SAFETY_FLOOR));
    assert.ok(Object.isFrozen(a3.OPTIONAL_SERVICES.Full));
    assert.throws(() => { a3.SAFETY_FLOOR.push('x'); }, TypeError);
  });
});

describe('profileOverhead / compareToFull (#2992)', () => {
  /** A full 3×3 matrix with two runs per cell. */
  function matrix() {
    const samples = [];
    for (const seats of [1, 4, 10]) {
      for (const [i, profile] of a3.PROFILES.entries()) {
        const scale = 3 - i;
        samples.push({ runId: `${seats}-${profile}-a`, seats, profile, promptTokens: seats * 100 * scale, serviceMs: seats * 20 * scale });
        samples.push({ runId: `${seats}-${profile}-b`, seats, profile, promptTokens: seats * 200 * scale, serviceMs: seats * 40 * scale });
      }
    }
    return samples;
  }

  it('aggregates every profile × seat cell with totals and per-sample means', () => {
    const rows = a3.profileOverhead(matrix());
    assert.equal(rows.length, 9);
    const leanFour = rows.find((r) => r.profile === 'Lean' && r.seats === 4);
    assert.deepEqual(
      [leanFour.runs, leanFour.samples, leanFour.promptTokensTotal, leanFour.promptTokensPerSample, leanFour.serviceMsPerSeat],
      [2, 2, 2400, 1200, 120]
    );
    assert.deepEqual(rows.slice(0, 3).map((r) => r.profile), ['Full', 'Lean', 'Minimal']);
  });

  it('reports nearest-rank p50/p95', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((t, i) => ({ runId: `r${i}`, profile: 'Full', seats: 1, promptTokens: t, serviceMs: t }));
    const [row] = a3.profileOverhead(samples);
    assert.equal(row.promptTokensP50, 50);
    assert.equal(row.promptTokensP95, 100);
  });

  it('deltas compare against Full at the same seat count, never another', () => {
    const rows = a3.profileOverhead(matrix());
    const minOne = a3.compareToFull(rows).find((r) => r.profile === 'Minimal' && r.seats === 1);
    assert.equal(minOne.baseline, 'Full');
    assert.ok(minOne.promptTokensP50Delta < 0);
    const noFull = a3.compareToFull(a3.profileOverhead([{ runId: 'r', profile: 'Lean', seats: 4, promptTokens: 1, serviceMs: 1 }]));
    assert.deepEqual(noFull, [{ matchKey: null, profile: 'Lean', seats: 4, baseline: null, promptTokensP50Delta: null, serviceMsP50Delta: null }]);
  });

  it('matchKey keeps workloads apart and deltas compare only within the same workload (PRR-A R1)', () => {
    const s = (matchKey, profile, t) => ({ runId: `${matchKey}-${profile}-${t}`, matchKey, profile, seats: 1, promptTokens: t, serviceMs: t });
    const rows = a3.profileOverhead([s('cold', 'Full', 100), s('warm', 'Full', 10), s('cold', 'Lean', 60), s('warm', 'Lean', 8)]);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => [r.matchKey, r.profile, r.promptTokensTotal]), [['cold', 'Full', 100], ['cold', 'Lean', 60], ['warm', 'Full', 10], ['warm', 'Lean', 8]]);
    const deltas = a3.compareToFull(rows).filter((r) => r.profile === 'Lean');
    assert.deepEqual(deltas.map((d) => [d.matchKey, d.promptTokensP50Delta]), [['cold', -40], ['warm', -2]]);
    const orphan = a3.compareToFull(a3.profileOverhead([s('cold', 'Full', 100), s('warm', 'Lean', 8)])).find((r) => r.profile === 'Lean');
    assert.equal(orphan.baseline, null, 'a warm Lean run must not be compared with a cold Full run');
    assert.throws(() => a3.profileOverhead([s('  ', 'Full', 1)]), TypeError);
  });

  it('an invalid sample throws rather than shrinking a cell', () => {
    assert.throws(() => a3.profileOverhead([{ runId: 'r', profile: 'Full', seats: 1, promptTokens: -1, serviceMs: 1 }]), TypeError);
    assert.throws(() => a3.profileOverhead([{ runId: 'r', profile: 'Full', seats: 3, promptTokens: 1, serviceMs: 1 }]), TypeError);
    assert.throws(() => a3.profileOverhead([{ runId: '', profile: 'Full', seats: 1, promptTokens: 1, serviceMs: 1 }]), TypeError);
    assert.throws(() => a3.profileOverhead([null]), TypeError);
    assert.throws(() => a3.profileOverhead('nope'), TypeError);
  });

  it('overheadFromJsonl parses one sample per line and names a bad line', () => {
    const text = '{"runId":"r","profile":"Lean","seats":1,"promptTokens":5,"serviceMs":2}\n\n';
    assert.equal(a3.overheadFromJsonl(text)[0].promptTokensTotal, 5);
    assert.throws(() => a3.overheadFromJsonl('{"runId":"r"\n'), /line 1/);
  });
});

describe('measureProfileRun (#2992)', () => {
  it('uses the supplied production hooks and a monotonic clock', async () => {
    let t = 10;
    const sample = await a3.measureProfileRun({
      profile: 'Lean', seats: 4, runId: 'r',
      buildPrompt: async (p, s) => `${p}:${s}`,
      countTokens: async (prompt) => prompt.length,
      startServices: async () => { t += 27; },
      clock: () => t
    });
    assert.deepEqual(sample, { profile: 'Lean', seats: 4, runId: 'r', promptTokens: 6, serviceMs: 27 });
  });

  it('records an optional matchKey on the sample', async () => {
    const sample = await a3.measureProfileRun({
      profile: 'Full', seats: 1, runId: 'r', matchKey: 'task-a/claude/cold',
      buildPrompt: async () => 'x', countTokens: async () => 1, startServices: async () => {}, clock: () => 0
    });
    assert.equal(sample.matchKey, 'task-a/claude/cold');
  });

  it('has no fallback tokenizer: a missing hook throws', async () => {
    await assert.rejects(a3.measureProfileRun({ profile: 'Lean', seats: 1, runId: 'r', buildPrompt: async () => 'x', startServices: async () => {} }), TypeError);
  });
});
