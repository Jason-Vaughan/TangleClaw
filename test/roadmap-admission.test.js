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
  it('snapshots issue states, prereqs, orderAfter, conflicts and the roadmap revision', () => {
    const candidate = {
      trainId: 'train:4',
      issues: ['#777'],
      prereqs: ['#721'],
      orderAfter: ['train:3'],
      conflicts: ['PR#500'],
      sourceRevision: 'rev-abc'
    };
    const facts = { issues: { '#721': { state: 'closed' }, '#777': { state: 'open' } } };
    const m = admission.buildTrainAdmissionManifest(candidate, facts, { now: 1000 });
    assert.equal(m.trainId, 'train:4');
    assert.deepEqual(m.issueStates, { '#777': 'open' });
    assert.deepEqual(m.hardPrereqs, ['#721']);
    assert.deepEqual(m.orderAfter, ['train:3']);
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
  const executableCandidate = { trainId: 'train:5', issues: ['#10'] };
  const conditionalCandidate = { trainId: 'train:6', issues: ['#20'], reservedGates: ['release'] };

  function executableManifest() {
    return admission.buildTrainAdmissionManifest(executableCandidate, { issues: {} }, { now: 1000 });
  }

  function conditionalManifest() {
    return admission.buildTrainAdmissionManifest(conditionalCandidate, { issues: {} }, { now: 1000 });
  }

  it('admits an executable train with no receipt at all, given a fresh (empty) conflict snapshot — no Architect pause needed', () => {
    const r = admission.validateTrainDispatchAdmission(executableManifest(), executableCandidate, undefined, { issues: {}, conflicts: { 'train:5': [] } }, { now: 2000 });
    assert.deepEqual(r, { admitted: true, decision: admission.DECISIONS.APPROVED });
  });

  it('refuses a conditionally-executable train with no receipt', () => {
    const r = admission.validateTrainDispatchAdmission(conditionalManifest(), conditionalCandidate, undefined, { issues: {}, conflicts: { 'train:6': [] } }, { now: 2000 });
    assert.equal(r.admitted, false);
    assert.equal(r.reason, 'architect-review-required');
  });

  it('admits a conditionally-executable train on an APPROVED receipt', () => {
    const r = admission.validateTrainDispatchAdmission(
      conditionalManifest(), conditionalCandidate, { decision: admission.DECISIONS.APPROVED }, { issues: {}, conflicts: { 'train:6': [] } }, { now: 2000 }
    );
    assert.deepEqual(r, { admitted: true, decision: admission.DECISIONS.APPROVED });
  });

  it('admits with the modified subset/sequence on a MODIFY receipt', () => {
    const r = admission.validateTrainDispatchAdmission(
      conditionalManifest(),
      conditionalCandidate,
      { decision: admission.DECISIONS.MODIFY, admittedSubset: ['#20'], sequence: 1 },
      { issues: {}, conflicts: { 'train:6': [] } },
      { now: 2000 }
    );
    assert.deepEqual(r, { admitted: true, decision: admission.DECISIONS.MODIFY, admittedSubset: ['#20'], sequence: 1 });
  });

  it('refuses outright on a REJECTED receipt, naming the blocking dependency', () => {
    const r = admission.validateTrainDispatchAdmission(
      conditionalManifest(), conditionalCandidate, { decision: admission.DECISIONS.REJECTED, blockingDependency: '#999' }, { issues: {}, conflicts: { 'train:6': [] } }, { now: 2000 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'rejected', detail: '#999' });
  });

  it('refuses a candidate whose train diverges from the manifest (different issue set)', () => {
    const divergedCandidate = { trainId: 'train:5', issues: ['#10', '#999'] };
    const r = admission.validateTrainDispatchAdmission(executableManifest(), divergedCandidate, undefined, { issues: {} }, { now: 2000 });
    assert.equal(r.admitted, false);
    assert.equal(r.reason, 'candidate-diverged-from-manifest');
  });

  it('refuses a candidate whose orderAfter diverges from the manifest, even with the same issues', () => {
    const orderedCandidate = { trainId: 'train:5', issues: ['#10'], orderAfter: ['train:a'] };
    const manifest = admission.buildTrainAdmissionManifest(orderedCandidate, { issues: {} }, { now: 1000 });
    const changedOrderCandidate = { trainId: 'train:5', issues: ['#10'], orderAfter: ['train:b'] };
    const r = admission.validateTrainDispatchAdmission(manifest, changedOrderCandidate, undefined, { issues: {} }, { now: 2000 });
    assert.equal(r.admitted, false);
    assert.equal(r.reason, 'candidate-diverged-from-manifest');
  });

  it('admits unchanged when the candidate\'s orderAfter still matches the manifest', () => {
    const orderedCandidate = { trainId: 'train:5', issues: ['#10'], orderAfter: ['train:a'] };
    const manifest = admission.buildTrainAdmissionManifest(orderedCandidate, { issues: {} }, { now: 1000 });
    const r = admission.validateTrainDispatchAdmission(manifest, orderedCandidate, undefined, { issues: {}, conflicts: { 'train:5': [] } }, { now: 2000 });
    assert.deepEqual(r, { admitted: true, decision: admission.DECISIONS.APPROVED });
  });

  it('refuses a MODIFY receipt whose admittedSubset names an issue the manifest never saw', () => {
    const r = admission.validateTrainDispatchAdmission(
      conditionalManifest(),
      conditionalCandidate,
      { decision: admission.DECISIONS.MODIFY, admittedSubset: ['#20', '#999'] },
      { issues: {}, conflicts: { 'train:6': [] } },
      { now: 2000 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'modify-subset-invalid', detail: ['#999'] });
  });

  it('refuses when the candidate being dispatched exceeds a MODIFY receipt\'s admitted subset', () => {
    const biggerCandidate = { trainId: 'train:6', issues: ['#20', '#21'], reservedGates: ['release'] };
    const manifest = admission.buildTrainAdmissionManifest(biggerCandidate, { issues: {} }, { now: 1000 });
    const r = admission.validateTrainDispatchAdmission(
      manifest,
      biggerCandidate,
      { decision: admission.DECISIONS.MODIFY, admittedSubset: ['#20'] },
      { issues: {}, conflicts: { 'train:6': [] } },
      { now: 2000 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'modify-subset-exceeded', detail: ['#21'] });
  });

  it('refuses a reopened prerequisite even though the manifest recorded it closed', () => {
    const candidate = { trainId: 'train:4', issues: ['#777'], prereqs: ['#721'] };
    const manifest = admission.buildTrainAdmissionManifest(candidate, { issues: { '#721': { state: 'closed' } } }, { now: 1000 });
    assert.equal(manifest.classification, admission.CLASSIFICATIONS.EXECUTABLE);
    const r = admission.validateTrainDispatchAdmission(
      manifest, candidate, undefined, { issues: { '#721': { state: 'open' } } }, { now: 2000 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'hard-prereq-open', detail: ['#721'] });
  });

  it('refuses when the candidate\'s own captured issue state has drifted, even toward closed', () => {
    const candidate = { trainId: 'train:4', issues: ['#777'] };
    const manifest = admission.buildTrainAdmissionManifest(candidate, { issues: { '#777': { state: 'open' } } }, { now: 1000 });
    const r = admission.validateTrainDispatchAdmission(
      manifest, candidate, undefined, { issues: { '#777': { state: 'closed' } } }, { now: 2000 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'issue-state-changed', detail: ['#777'] });
  });

  it('refuses dispatch when the manifest recorded conflicts but currentFacts carries no fresh conflict snapshot', () => {
    const candidate = { trainId: 'train:8', issues: ['#22'], conflicts: ['PR#500'] };
    const manifest = admission.buildTrainAdmissionManifest(candidate, { issues: {} }, { now: 1000 });
    const r = admission.validateTrainDispatchAdmission(
      manifest, candidate, { decision: admission.DECISIONS.APPROVED }, { issues: {} }, { now: 2000 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'conflict-snapshot-missing', detail: 'currentFacts carries no fresh conflict snapshot (an explicit array) for this train — required on every dispatch, not only one the manifest recorded conflicts for, since a newly-opened conflict can appear on a train that had none' });
  });

  it('refuses dispatch when the manifest recorded NO conflicts but currentFacts still carries no fresh snapshot (I-Gate Round 2 Finding 2)', () => {
    const candidate = { trainId: 'train:9', issues: ['#30'] };
    const manifest = admission.buildTrainAdmissionManifest(candidate, { issues: {} }, { now: 1000 });
    assert.deepEqual(manifest.conflicts, []);
    const r = admission.validateTrainDispatchAdmission(
      manifest, candidate, undefined, { issues: {} }, { now: 2000 }
    );
    assert.equal(r.admitted, false, 'a train with zero recorded conflicts can still have a NEW one by dispatch time — omission is never read as "none"');
    assert.equal(r.reason, 'conflict-snapshot-missing');
  });

  for (const invalid of [null, false, true, 'oops', 42, {}]) {
    it(`refuses an invalid (non-array) conflict snapshot value rather than reading it as empty (I-Gate Round 3 Finding, value: ${JSON.stringify(invalid)})`, () => {
      const candidate = { trainId: 'train:9', issues: ['#1'] };
      const manifest = admission.buildTrainAdmissionManifest(candidate, { issues: { '#1': { state: 'open' } } }, { now: 1000 });
      const r = admission.validateTrainDispatchAdmission(
        manifest, candidate, undefined, { issues: { '#1': { state: 'open' } }, conflicts: { 'train:9': invalid } }, { now: 2000 }
      );
      assert.equal(r.admitted, false, `a ${typeof invalid} conflicts value must never be treated as "checked, none found"`);
      assert.equal(r.reason, 'conflict-snapshot-missing');
    });
  }

  it('admits once the conflict snapshot is an explicit empty array, distinct from an invalid value', () => {
    const candidate = { trainId: 'train:9', issues: ['#1'] };
    const manifest = admission.buildTrainAdmissionManifest(candidate, { issues: { '#1': { state: 'open' } } }, { now: 1000 });
    const r = admission.validateTrainDispatchAdmission(
      manifest, candidate, undefined, { issues: { '#1': { state: 'open' } }, conflicts: { 'train:9': [] } }, { now: 2000 }
    );
    assert.deepEqual(r, { admitted: true, decision: admission.DECISIONS.APPROVED });
  });

  it('refuses a new conflict the manifest never saw, given a fresh conflict snapshot', () => {
    const candidate = { trainId: 'train:8', issues: ['#22'], conflicts: ['PR#500'] };
    const manifest = admission.buildTrainAdmissionManifest(candidate, { issues: {} }, { now: 1000 });
    const r = admission.validateTrainDispatchAdmission(
      manifest,
      candidate,
      { decision: admission.DECISIONS.APPROVED },
      { issues: {}, conflicts: { 'train:8': ['PR#500', 'PR#777'] } },
      { now: 2000 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'new-conflict-detected', detail: ['PR#777'] });
  });

  it('admits a train with recorded conflicts once the fresh snapshot shows none new', () => {
    const candidate = { trainId: 'train:8', issues: ['#22'], conflicts: ['PR#500'] };
    const manifest = admission.buildTrainAdmissionManifest(candidate, { issues: {} }, { now: 1000 });
    const r = admission.validateTrainDispatchAdmission(
      manifest,
      candidate,
      { decision: admission.DECISIONS.APPROVED },
      { issues: {}, conflicts: { 'train:8': ['PR#500'] } },
      { now: 2000 }
    );
    assert.deepEqual(r, { admitted: true, decision: admission.DECISIONS.APPROVED });
  });

  it('refuses stale evidence past the TTL', () => {
    const r = admission.validateTrainDispatchAdmission(
      executableManifest(), executableCandidate, undefined, { issues: {}, conflicts: { 'train:5': [] } }, { now: 1000 + admission.DEFAULT_EVIDENCE_TTL_MS + 1 }
    );
    assert.equal(r.admitted, false);
    assert.equal(r.reason, 'evidence-expired');
  });

  it('refuses when the roadmap revision has moved since the manifest was built', () => {
    const candidate = { trainId: 'train:5', issues: ['#10'], sourceRevision: 'rev-1' };
    const manifest = admission.buildTrainAdmissionManifest(candidate, { issues: {} }, { now: 1000 });
    const r = admission.validateTrainDispatchAdmission(
      manifest, candidate, undefined, { issues: {}, conflicts: { 'train:5': [] }, roadmapRevision: 'rev-2' }, { now: 1100 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'evidence-expired', detail: 'the roadmap revision has moved since this manifest was built' });
  });

  it('refuses operator-only verification misrepresented as unattended-safe', () => {
    const candidate = { trainId: 'train:7', issues: ['#21'], operatorVerification: { required: true, reason: 'live DNS cutover' } };
    const manifest = admission.buildTrainAdmissionManifest(candidate, { issues: {} }, { now: 1000 });
    const r = admission.validateTrainDispatchAdmission(
      manifest, candidate, { decision: admission.DECISIONS.APPROVED, unattendedSafe: true }, { issues: {}, conflicts: { 'train:7': [] } }, { now: 1100 }
    );
    assert.deepEqual(r, { admitted: false, reason: 'operator-verification-misrepresented', detail: 'live DNS cutover' });
  });
});
