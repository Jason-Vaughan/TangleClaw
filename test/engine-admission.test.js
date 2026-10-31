'use strict';

/*
 * Engine portability beyond the wrap (#1809): capability-matched task
 * admission, and the attested-rotation state machine that replaces one
 * engine attempt with another without ever producing two live publishers.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const admission = require('../lib/engine-admission');

describe('admit / admitTask — capability-matched admission', () => {
  it('admits when every required capability is present', () => {
    const r = admission.admit({ engineCapabilities: ['shell', 'methodology', 'critic'], requiredCapabilities: ['methodology', 'critic'] });
    assert.equal(r.admitted, true);
    assert.deepEqual(r.missingCapabilities, []);
  });

  it('refuses and names exactly what is missing', () => {
    const r = admission.admit({ engineCapabilities: ['shell'], requiredCapabilities: ['methodology', 'critic'] });
    assert.equal(r.admitted, false);
    assert.deepEqual(r.missingCapabilities, ['methodology', 'critic']);
  });

  it('refuses methodology-required work (critic/pr/merge/release) to an engine with no methodology capability', () => {
    for (const taskKind of ['critic', 'pr', 'merge', 'release']) {
      const r = admission.admitTask({ engineCapabilities: ['shell', 'file-edit'], taskKind });
      assert.equal(r.admitted, false, `${taskKind} must not admit a methodology-less engine`);
      assert.ok(r.missingCapabilities.includes('methodology'));
    }
  });

  it('admits each named task kind once the engine declares the matching capability', () => {
    assert.equal(admission.admitTask({ engineCapabilities: ['methodology', 'critic'], taskKind: 'critic' }).admitted, true);
    assert.equal(admission.admitTask({ engineCapabilities: ['methodology', 'pr'], taskKind: 'pr' }).admitted, true);
    assert.equal(admission.admitTask({ engineCapabilities: ['methodology', 'merge'], taskKind: 'merge' }).admitted, true);
    assert.equal(admission.admitTask({ engineCapabilities: ['methodology', 'release'], taskKind: 'release' }).admitted, true);
  });

  it('refuses to resolve an unrecognized task kind rather than defaulting it to admitted', () => {
    assert.throws(() => admission.admitTask({ engineCapabilities: ['methodology'], taskKind: 'deploy-the-planet' }), admission.AdmissionError);
  });

  it('names exactly the four methodology-required task kinds the issue calls out', () => {
    assert.deepEqual(Object.keys(admission.TASK_KIND_REQUIREMENTS).sort(), ['critic', 'merge', 'pr', 'release']);
  });

  it('draws every TASK_KIND_REQUIREMENTS capability from KNOWN_CAPABILITIES, so a future typo is caught here', () => {
    const known = new Set(admission.KNOWN_CAPABILITIES);
    for (const [taskKind, caps] of Object.entries(admission.TASK_KIND_REQUIREMENTS)) {
      for (const cap of caps) assert.ok(known.has(cap), `${taskKind} requires unknown capability "${cap}"`);
    }
  });
});

/**
 * A checkpoint whose three digests are all equal to its own wip summary's
 * length-derived stand-in — good enough for a test fixture, where only
 * equality (not real hashing) matters.
 * @param {string} tag - A short tag to vary the digests by.
 * @returns {{wipSummary: string, checkoutDigest: string, worktreeDigest: string, stateDigest: string}}
 */
function checkpoint(tag = 'a') {
  return { wipSummary: `WIP for ${tag}`, checkoutDigest: `checkout-${tag}`, worktreeDigest: `worktree-${tag}`, stateDigest: `state-${tag}` };
}

describe('attested rotation — the happy path', () => {
  it('walks prepared -> quiesced -> revoked -> attested -> active, with the epoch advanced exactly once', () => {
    let r = admission.prepareRotation({
      rotationId: 'rot-1', resourceId: 'task-42', oldAttemptId: 'attempt-old', oldEpoch: 3, checkpoint: checkpoint()
    }, { now: 1000 });
    assert.equal(r.schema, admission.SCHEMA);
    assert.equal(r.stage, admission.STAGES.PREPARED);
    assert.equal(r.nextEpoch, 4);

    r = admission.markQuiesced(r, { now: 1001 });
    assert.equal(r.stage, admission.STAGES.QUIESCED);

    r = admission.revokeLease(r, { now: 1002 });
    assert.equal(r.stage, admission.STAGES.REVOKED);

    r = admission.attestReplacement(r, {
      newAttemptId: 'attempt-new', checkoutDigest: 'checkout-a', worktreeDigest: 'worktree-a', stateDigest: 'state-a'
    }, { now: 1003 });
    assert.equal(r.stage, admission.STAGES.ATTESTED);
    assert.equal(r.newAttemptId, 'attempt-new');

    r = admission.transferAuthority(r, { now: 1004 });
    assert.equal(r.stage, admission.STAGES.ACTIVE);
  });
});

describe('attested rotation — stage ordering is enforced', () => {
  it('refuses to quiesce a record twice', () => {
    let r = admission.prepareRotation({ rotationId: 'rot-2', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });
    r = admission.markQuiesced(r);
    assert.throws(() => admission.markQuiesced(r), admission.AdmissionError);
  });

  it('refuses to revoke before quiescing', () => {
    const r = admission.prepareRotation({ rotationId: 'rot-3', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });
    assert.throws(() => admission.revokeLease(r), admission.AdmissionError);
  });

  it('refuses to attest before revoking', () => {
    let r = admission.prepareRotation({ rotationId: 'rot-4', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });
    r = admission.markQuiesced(r);
    assert.throws(() => admission.attestReplacement(r, { newAttemptId: 'n', checkoutDigest: 'c', worktreeDigest: 'w', stateDigest: 's' }), admission.AdmissionError);
  });

  it('refuses to transfer authority before attesting', () => {
    let r = admission.prepareRotation({ rotationId: 'rot-5', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });
    r = admission.markQuiesced(r);
    r = admission.revokeLease(r);
    assert.throws(() => admission.transferAuthority(r), admission.AdmissionError);
  });
});

describe('attested rotation — the attestation must match the checkpoint exactly', () => {
  it('refuses a replacement whose checkout digest does not match, and leaves the record retryable at revoked', () => {
    let r = admission.prepareRotation({ rotationId: 'rot-6', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint('a') });
    r = admission.markQuiesced(r);
    r = admission.revokeLease(r);
    assert.throws(
      () => admission.attestReplacement(r, { newAttemptId: 'n', checkoutDigest: 'WRONG', worktreeDigest: 'worktree-a', stateDigest: 'state-a' }),
      admission.AdmissionError
    );
    assert.equal(r.stage, admission.STAGES.REVOKED, 'a failed attestation does not advance the record');
    // Retrying with the correct digests succeeds on the same record.
    const attested = admission.attestReplacement(r, { newAttemptId: 'n', checkoutDigest: 'checkout-a', worktreeDigest: 'worktree-a', stateDigest: 'state-a' });
    assert.equal(attested.stage, admission.STAGES.ATTESTED);
  });

  it('refuses a replacement whose worktree or state digest does not match', () => {
    let r = admission.prepareRotation({ rotationId: 'rot-7', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint('a') });
    r = admission.markQuiesced(r);
    r = admission.revokeLease(r);
    assert.throws(
      () => admission.attestReplacement(r, { newAttemptId: 'n', checkoutDigest: 'checkout-a', worktreeDigest: 'WRONG', stateDigest: 'state-a' }),
      admission.AdmissionError
    );
    assert.throws(
      () => admission.attestReplacement(r, { newAttemptId: 'n', checkoutDigest: 'checkout-a', worktreeDigest: 'worktree-a', stateDigest: 'WRONG' }),
      admission.AdmissionError
    );
  });
});

describe('attested rotation — authority transfers exactly once', () => {
  function activeRotation(rotationId) {
    let r = admission.prepareRotation({ rotationId, resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint('a') });
    r = admission.markQuiesced(r);
    r = admission.revokeLease(r);
    r = admission.attestReplacement(r, { newAttemptId: 'attempt-new', checkoutDigest: 'checkout-a', worktreeDigest: 'worktree-a', stateDigest: 'state-a' });
    return admission.transferAuthority(r);
  }

  it('a retried transfer on an already-active record is a no-op that returns the same attempt', () => {
    const active = activeRotation('rot-8');
    const again = admission.transferAuthority(active);
    assert.equal(again.stage, admission.STAGES.ACTIVE);
    assert.equal(again.newAttemptId, 'attempt-new');
    assert.deepEqual(again, active);
  });

  it('abandoning is terminal: a record cannot advance again afterward', () => {
    let r = admission.prepareRotation({ rotationId: 'rot-9', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint('a') });
    r = admission.abandonRotation(r, 'operator exited the session mid-rotation');
    assert.equal(r.stage, admission.STAGES.ABANDONED);
    assert.throws(() => admission.markQuiesced(r), admission.AdmissionError);
  });
});

describe('NEXT_STAGE', () => {
  it('names the one healthy successor of each non-terminal stage', () => {
    assert.equal(admission.NEXT_STAGE[admission.STAGES.PREPARED], admission.STAGES.QUIESCED);
    assert.equal(admission.NEXT_STAGE[admission.STAGES.QUIESCED], admission.STAGES.REVOKED);
    assert.equal(admission.NEXT_STAGE[admission.STAGES.REVOKED], admission.STAGES.ATTESTED);
    assert.equal(admission.NEXT_STAGE[admission.STAGES.ATTESTED], admission.STAGES.ACTIVE);
    assert.equal(admission.NEXT_STAGE[admission.STAGES.ACTIVE], undefined, 'active is terminal for ordinary advancement');
  });
});

describe('validateRotationRecord', () => {
  it('rejects nextEpoch that does not equal oldEpoch + 1', () => {
    const bad = { ...admission.prepareRotation({ rotationId: 'r', resourceId: 't', oldAttemptId: 'o', oldEpoch: 5, checkpoint: checkpoint() }), nextEpoch: 9 };
    assert.throws(() => admission.validateRotationRecord(bad), admission.AdmissionError);
  });

  it('rejects newAttemptId present before stage reaches attested', () => {
    const prepared = admission.prepareRotation({ rotationId: 'r2', resourceId: 't', oldAttemptId: 'o', oldEpoch: 0, checkpoint: checkpoint() });
    const bad = { ...prepared, newAttemptId: 'sneaking-in-early' };
    assert.throws(() => admission.validateRotationRecord(bad), admission.AdmissionError);
  });
});

describe('rotation record size budget', () => {
  it('a worst-case valid record (max-length wipSummary) comfortably fits MAX_BYTES', () => {
    const r = admission.prepareRotation({
      rotationId: 'rot-worst-case',
      resourceId: 'task',
      oldAttemptId: 'old',
      oldEpoch: 0,
      checkpoint: { wipSummary: 'x'.repeat(4000), checkoutDigest: 'c', worktreeDigest: 'w', stateDigest: 's' }
    });
    const bytes = Buffer.byteLength(JSON.stringify(r));
    assert.ok(bytes < admission.MAX_BYTES, `expected ${bytes} bytes to fit under MAX_BYTES (${admission.MAX_BYTES})`);
  });
});

describe('rotation ledger persistence', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-admission-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports missing for a rotation nothing has recorded yet', () => {
    const file = admission.rotationPath(dir, 'never-started');
    const read = admission.readRotation(file);
    assert.equal(read.status, 'missing');
  });

  it('round-trips a written record through every stage', () => {
    const file = admission.rotationPath(dir, 'rot-persisted');
    let r = admission.prepareRotation({ rotationId: 'rot-persisted', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint('a') });
    admission.writeRotation(file, r);
    assert.equal(admission.readRotation(file).record.stage, admission.STAGES.PREPARED);

    r = admission.markQuiesced(r);
    admission.writeRotation(file, r);
    r = admission.revokeLease(r);
    admission.writeRotation(file, r);
    r = admission.attestReplacement(r, { newAttemptId: 'new', checkoutDigest: 'checkout-a', worktreeDigest: 'worktree-a', stateDigest: 'state-a' });
    admission.writeRotation(file, r);
    r = admission.transferAuthority(r);
    admission.writeRotation(file, r);

    const read = admission.readRotation(file);
    assert.equal(read.status, 'ok');
    assert.equal(read.record.stage, admission.STAGES.ACTIVE);
    assert.equal(read.record.newAttemptId, 'new');
  });

  it('reports invalid for a file that is not valid JSON', () => {
    const file = admission.rotationPath(dir, 'corrupt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all');
    assert.equal(admission.readRotation(file).status, 'invalid');
  });
});
