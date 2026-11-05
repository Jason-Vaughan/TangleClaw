'use strict';

// #1894 — structured roadmap train dependencies and durable admission
// before dispatch. Pure logic; no network, no filesystem.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const admission = require('../lib/roadmap-admission');

describe('classifyTrain', () => {
  it('blocks a train whose hard prerequisite is still open (Train 4 / #777 needs #721)', () => {
    const candidate = { trainId: 'train:4', issues: ['#777'], prereqs: ['#721'] };
    const facts = { issues: { '#721': { state: 'open' } } };
    const r = admission.classifyTrain(candidate, facts);
    assert.equal(r.classification, admission.CLASSIFICATIONS.BLOCKED);
    assert.ok(r.reasons.some((s) => s.includes('#721')));
  });

  it('is executable once the prerequisite closes', () => {
    const candidate = { trainId: 'train:4', issues: ['#777'], prereqs: ['#721'] };
    const facts = { issues: { '#721': { state: 'closed' } } };
    const r = admission.classifyTrain(candidate, facts);
    assert.equal(r.classification, admission.CLASSIFICATIONS.EXECUTABLE);
  });

  it('treats an unknown prerequisite as open rather than guessing it is satisfied', () => {
    const candidate = { trainId: 'train:9', issues: ['#1'], prereqs: ['#999'] };
    const r = admission.classifyTrain(candidate, { issues: {} });
    assert.equal(r.classification, admission.CLASSIFICATIONS.BLOCKED);
  });

  it('a small independent train with no boundary crossing is executable, no Architect pause', () => {
    const candidate = { trainId: 'train:5', issues: ['#10', '#11'] };
    const r = admission.classifyTrain(candidate, { issues: {} });
    assert.equal(r.classification, admission.CLASSIFICATIONS.EXECUTABLE);
  });

  it('is conditionally-executable when it crosses a reserved gate', () => {
    const candidate = { trainId: 'train:6', issues: ['#20'], reservedGates: [admission.RESERVED_GATE_KINDS[0]] };
    const r = admission.classifyTrain(candidate, { issues: {} });
    assert.equal(r.classification, admission.CLASSIFICATIONS.CONDITIONAL);
    assert.ok(r.reasons.some((s) => s.includes(admission.RESERVED_GATE_KINDS[0])));
  });

  it('is conditionally-executable when it requires operator-only verification', () => {
    const candidate = { trainId: 'train:7', issues: ['#21'], operatorVerification: { required: true, reason: 'live DNS cutover' } };
    const r = admission.classifyTrain(candidate, { issues: {} });
    assert.equal(r.classification, admission.CLASSIFICATIONS.CONDITIONAL);
  });

  it('is conditionally-executable when it has an open conflict', () => {
    const candidate = { trainId: 'train:8', issues: ['#22'], conflicts: ['PR#500'] };
    const r = admission.classifyTrain(candidate, { issues: {} });
    assert.equal(r.classification, admission.CLASSIFICATIONS.CONDITIONAL);
  });

  it('fails validation on contradictory placement (admitted car also unmilestoned)', () => {
    const candidate = { trainId: 'train:4', issues: ['#777'], unmilestoned: true };
    assert.throws(() => admission.classifyTrain(candidate, { issues: {} }), admission.RoadmapAdmissionError);
  });

  it('rejects a malformed candidate rather than defaulting it to executable', () => {
    assert.throws(() => admission.classifyTrain({ trainId: 'x' }, { issues: {} }), admission.RoadmapAdmissionError);
    assert.throws(() => admission.classifyTrain({ trainId: '', issues: [] }, { issues: {} }), admission.RoadmapAdmissionError);
  });
});

describe('validateTrainCandidate', () => {
  it('accepts a minimal valid candidate', () => {
    assert.doesNotThrow(() => admission.validateTrainCandidate({ trainId: 'train:1', issues: ['#1'] }));
  });

  it('refuses a non-boolean operatorVerification.required', () => {
    assert.throws(
      () => admission.validateTrainCandidate({ trainId: 'train:1', issues: ['#1'], operatorVerification: { required: 'yes' } }),
      admission.RoadmapAdmissionError
    );
  });

  it('refuses issues that are not an array of strings', () => {
    assert.throws(() => admission.validateTrainCandidate({ trainId: 'train:1', issues: [1, 2] }), admission.RoadmapAdmissionError);
  });
});

describe('buildTrainAdmissionManifest', () => {
  it('snapshots issue states, prereqs, conflicts and the roadmap revision', () => {
    const candidate = {
      trainId: 'train:4',
      issues: ['#777'],
      prereqs: ['#721'],
      conflicts: ['PR#500'],
      sourceRevision: 'rev-abc'
    };
    const facts = { issues: { '#721': { state: 'closed' }, '#777': { state: 'open' } } };
    const m = admission.buildTrainAdmissionManifest(candidate, facts, { now: 1000 });
    assert.equal(m.trainId, 'train:4');
    assert.deepEqual(m.issueStates, { '#777': 'open' });
    assert.deepEqual(m.hardPrereqs, ['#721']);
    assert.deepEqual(m.conflicts, ['PR#500']);
    assert.equal(m.roadmapRevision, 'rev-abc');
    assert.equal(m.classification, admission.CLASSIFICATIONS.CONDITIONAL);
    assert.equal(m.builtAt, 1000);
  });

  it('propagates classifyTrain\'s contradictory-placement refusal', () => {
    const candidate = { trainId: 'train:4', issues: ['#777'], unmilestoned: true };
    assert.throws(() => admission.buildTrainAdmissionManifest(candidate, { issues: {} }), admission.RoadmapAdmissionError);
  });
});

describe('validateTrainDispatchAdmission', () => {
  function executableManifest() {
    return admission.buildTrainAdmissionManifest({ trainId: 'train:5', issues: ['#10'] }, { issues: {} }, { now: 1000 });
  }

  function conditionalManifest() {
    return admission.buildTrainAdmissionManifest(
      { trainId: 'train:6', issues: ['#20'], reservedGates: ['release'] },
      { issues: {} },
      { now: 1000 }
    );
  }

  it('admits an executable train with no receipt at all — no Architect pause needed', () => {
    const r = admission.validateTrainDispatchAdmission(executableManifest(), undefined, { issues: {} }, { now: 2000 });
    assert.deepEqual(r, { admitted: true, decision: admission.DECISIONS.APPROVED });
  });

  it('refuses a conditionally-executable train with no receipt', () => {
    const r = admission.validateTrainDispatchAdmission(conditionalManifest(), undefined, { issues: {} }, { now: 2000 });
    assert.equal(r.admitted, false);
    assert.equal(r.reason, 'architect-review-required');
  });

  it('admits a conditionally-executable train on an APPROVED receipt', () => {
    const r = admission.validateTrainDispatchAdmission(
      conditionalManifest(), { decision: admission.DECISIONS.APPROVED }, { issues: {} }, { now: 2000 }
    );
    assert.deepEqual(r, { admitted: true, decision: admission.DECISIONS.APPROVED });
  });

  it('admits with the modified subset/sequence on a MODIFY receipt', () => {
    const r = admission.validateTrainDispatchAdmission(
      conditionalManifest(),
      { decision: admission.DECISIONS.MODIFY, admittedSubset: ['#20'], sequence: 1 },
      { issues: {} },
      { now: 2000 }
    );
    assert.deepEqual(r, { admitted: true, decision: admission.DECISIONS.MODIFY, admittedSubset: ['#20'], sequence: 1 });
  });

  it('refuses outright on a REJECTED receipt, naming the blocking dependency', () => {
    const r = admission.validateTrainDispatchAdmission(
      conditionalManifest(), { decision: admission.DECISIONS.REJECTED, blockingDependency: '#999' }, { issues: {} }, { now: 2000 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'rejected', detail: '#999' });
  });

  it('refuses a reopened prerequisite even though the manifest recorded it closed', () => {
    const manifest = admission.buildTrainAdmissionManifest(
      { trainId: 'train:4', issues: ['#777'], prereqs: ['#721'] },
      { issues: { '#721': { state: 'closed' } } },
      { now: 1000 }
    );
    assert.equal(manifest.classification, admission.CLASSIFICATIONS.EXECUTABLE);
    const r = admission.validateTrainDispatchAdmission(
      manifest, undefined, { issues: { '#721': { state: 'open' } } }, { now: 2000 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'hard-prereq-open', detail: ['#721'] });
  });

  it('refuses a new conflict the manifest never saw', () => {
    const manifest = admission.buildTrainAdmissionManifest(
      { trainId: 'train:8', issues: ['#22'], conflicts: ['PR#500'] },
      { issues: {} },
      { now: 1000 }
    );
    const r = admission.validateTrainDispatchAdmission(
      manifest,
      { decision: admission.DECISIONS.APPROVED },
      { issues: {}, conflicts: { 'train:8': ['PR#500', 'PR#777'] } },
      { now: 2000 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'new-conflict-detected', detail: ['PR#777'] });
  });

  it('refuses stale evidence past the TTL', () => {
    const r = admission.validateTrainDispatchAdmission(
      executableManifest(), undefined, { issues: {} }, { now: 1000 + admission.DEFAULT_EVIDENCE_TTL_MS + 1 }
    );
    assert.equal(r.admitted, false);
    assert.equal(r.reason, 'evidence-expired');
  });

  it('refuses when the roadmap revision has moved since the manifest was built', () => {
    const manifest = admission.buildTrainAdmissionManifest(
      { trainId: 'train:5', issues: ['#10'], sourceRevision: 'rev-1' }, { issues: {} }, { now: 1000 }
    );
    const r = admission.validateTrainDispatchAdmission(
      manifest, undefined, { issues: {}, roadmapRevision: 'rev-2' }, { now: 1100 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'evidence-expired', detail: 'the roadmap revision has moved since this manifest was built' });
  });

  it('refuses operator-only verification misrepresented as unattended-safe', () => {
    const manifest = admission.buildTrainAdmissionManifest(
      { trainId: 'train:7', issues: ['#21'], operatorVerification: { required: true, reason: 'live DNS cutover' } },
      { issues: {} },
      { now: 1000 }
    );
    const r = admission.validateTrainDispatchAdmission(
      manifest, { decision: admission.DECISIONS.APPROVED, unattendedSafe: true }, { issues: {} }, { now: 1100 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'operator-verification-misrepresented', detail: 'live DNS cutover' });
  });
});
