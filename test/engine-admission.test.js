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
    assert.equal(r.revokedAt, 1002, 'the revocation is explicit on the record, not merely implied by the stage name');

    r = admission.attestReplacement(r, {
      newAttemptId: 'attempt-new', checkoutDigest: 'checkout-a', worktreeDigest: 'worktree-a', stateDigest: 'state-a'
    }, { now: 1003 });
    assert.equal(r.stage, admission.STAGES.ATTESTED);
    assert.equal(r.newAttemptId, 'attempt-new');

    r = admission.transferAuthority(r, { now: 1004 });
    assert.equal(r.stage, admission.STAGES.ACTIVE);
    assert.equal(r.revision, 5, 'revision advances exactly once per transition');
  });
});

describe('authorizePublisher — active-publisher enforcement', () => {
  function rotationAt(stage) {
    let r = admission.prepareRotation({ rotationId: `pub-${stage}`, resourceId: 't', oldAttemptId: 'old', oldEpoch: 7, checkpoint: checkpoint('a') });
    if (stage === admission.STAGES.PREPARED) return r;
    r = admission.markQuiesced(r);
    if (stage === admission.STAGES.QUIESCED) return r;
    r = admission.revokeLease(r);
    if (stage === admission.STAGES.REVOKED) return r;
    r = admission.attestReplacement(r, { newAttemptId: 'new', checkoutDigest: 'checkout-a', worktreeDigest: 'worktree-a', stateDigest: 'state-a' });
    if (stage === admission.STAGES.ATTESTED) return r;
    return admission.transferAuthority(r);
  }

  it('authorizes only the old attempt at its old epoch while prepared', () => {
    const r = rotationAt(admission.STAGES.PREPARED);
    assert.equal(admission.authorizePublisher(r, { attemptId: 'old', epoch: 7 }).authorized, true);
    assert.equal(admission.authorizePublisher(r, { attemptId: 'old', epoch: 8 }).authorized, false, 'wrong epoch is refused even for the right attempt');
    assert.equal(admission.authorizePublisher(r, { attemptId: 'new', epoch: 7 }).authorized, false, 'the new attempt has no authority yet');
  });

  it('authorizes nobody once quiesced, revoked, or attested', () => {
    for (const stage of [admission.STAGES.QUIESCED, admission.STAGES.REVOKED, admission.STAGES.ATTESTED]) {
      const r = rotationAt(stage);
      assert.equal(admission.authorizePublisher(r, { attemptId: 'old', epoch: 7 }).authorized, false, `old attempt must not publish at "${stage}"`);
      assert.equal(admission.authorizePublisher(r, { attemptId: 'new', epoch: 8 }).authorized, false, `new attempt must not publish before "active" (at "${stage}")`);
    }
  });

  it('authorizes only the new attempt at the new epoch once active, never the old one', () => {
    const r = rotationAt(admission.STAGES.ACTIVE);
    assert.equal(admission.authorizePublisher(r, { attemptId: 'new', epoch: 8 }).authorized, true);
    assert.equal(admission.authorizePublisher(r, { attemptId: 'old', epoch: 7 }).authorized, false, 'a stale attempt presenting its revoked epoch is never authorized once active');
  });

  it('authorizes nobody once abandoned', () => {
    const r = admission.abandonRotation(rotationAt(admission.STAGES.PREPARED), 'operator exited');
    assert.equal(admission.authorizePublisher(r, { attemptId: 'old', epoch: 7 }).authorized, false);
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

describe('writeRotation — compare-and-set against concurrent/stale writers (R1 Finding 4)', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-admission-cas-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('refuses to write revision 1 over an existing record', () => {
    const file = admission.rotationPath(dir, 'cas-1');
    const r = admission.prepareRotation({ rotationId: 'cas-1', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });
    admission.writeRotation(file, r);
    assert.throws(() => admission.writeRotation(file, r), admission.AdmissionError);
  });

  it('two sessions racing from the same revision: the first write wins, the second is refused and must re-read', () => {
    const file = admission.rotationPath(dir, 'cas-2');
    const base = admission.prepareRotation({ rotationId: 'cas-2', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });
    admission.writeRotation(file, base);

    // Two independent sessions each read revision 1 and compute their own
    // revision 2, at different times — simulating a real race, not a shared
    // in-memory object.
    const sessionA = admission.markQuiesced(admission.readRotation(file).record, { now: 2000 });
    const sessionB = admission.markQuiesced(admission.readRotation(file).record, { now: 3000 });

    admission.writeRotation(file, sessionA); // first writer wins
    assert.throws(
      () => admission.writeRotation(file, sessionB),
      (err) => err instanceof admission.AdmissionError && /already recorded on disk with different content/.test(err.message)
    );
    // The on-disk record is session A's, untouched by B's refused write.
    assert.equal(admission.readRotation(file).record.updatedAt, 2000);
  });

  it('a true idempotent retry (same revision, identical content) is a no-op success, not a CAS failure', () => {
    const file = admission.rotationPath(dir, 'cas-3');
    const r = admission.prepareRotation({ rotationId: 'cas-3', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });
    admission.writeRotation(file, r);
    const quiesced = admission.markQuiesced(r, { now: 2000 });
    admission.writeRotation(file, quiesced);
    assert.doesNotThrow(() => admission.writeRotation(file, quiesced), 'retrying the exact same write (e.g. after a timeout with an uncertain response) must succeed');
    assert.equal(admission.readRotation(file).record.stage, admission.STAGES.QUIESCED);
  });

  it('refuses a write that skips ahead of the on-disk revision', () => {
    const file = admission.rotationPath(dir, 'cas-4');
    let r = admission.prepareRotation({ rotationId: 'cas-4', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });
    admission.writeRotation(file, r); // revision 1 on disk
    r = admission.markQuiesced(r);
    r = admission.revokeLease(r); // in-memory revision 3, but disk is still at 1
    assert.throws(
      () => admission.writeRotation(file, r),
      (err) => err instanceof admission.AdmissionError && /someone else already advanced this rotation/.test(err.message)
    );
  });

  it('a second write that reaches the lock while the first is still inside its critical section is refused, not raced (R2 Finding 1)', () => {
    const file = admission.rotationPath(dir, 'cas-6');
    const r = admission.prepareRotation({ rotationId: 'cas-6', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });

    // Simulate a writer already inside writeRotation's critical section —
    // including, specifically, mid-writeAtomic, which is exactly the window
    // a bare read-then-write would miss — by holding the SAME lock
    // `_acquireLock` itself would take.
    const lockPath = admission._lockPath(file);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const fd = fs.openSync(lockPath, 'wx');
    try {
      assert.throws(
        () => admission.writeRotation(file, r, { lockTimeoutMs: 100 }),
        (err) => err instanceof admission.AdmissionError && /could not acquire the rotation lock/.test(err.message)
      );
      assert.equal(fs.existsSync(file), false, 'the interleaved write never reached the record at all');
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lockPath);
    }

    // Once the lock is free, the same write succeeds normally.
    admission.writeRotation(file, r);
    assert.equal(admission.readRotation(file).record.stage, admission.STAGES.PREPARED);
  });

  it('a stale lock (crashed holder) is reclaimed rather than wedging the record forever', () => {
    const file = admission.rotationPath(dir, 'cas-7');
    const r = admission.prepareRotation({ rotationId: 'cas-7', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });
    const lockPath = admission._lockPath(file);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.closeSync(fs.openSync(lockPath, 'wx'));
    // Back-date it well past LOCK_STALE_MS so it reads as abandoned.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    assert.doesNotThrow(() => admission.writeRotation(file, r));
    assert.equal(admission.readRotation(file).record.stage, admission.STAGES.PREPARED);
  });

  it('refuses to steal a lock whose recorded pid is still alive, even once it is well past LOCK_STALE_MS (R3 Finding)', () => {
    const file = admission.rotationPath(dir, 'cas-8');
    const r = admission.prepareRotation({ rotationId: 'cas-8', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });
    const lockPath = admission._lockPath(file);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // This test process's own pid is unambiguously alive.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'someone-elses-token' }));
    const old = new Date(Date.now() - 31_000);
    fs.utimesSync(lockPath, old, old);

    try {
      assert.throws(
        () => admission.writeRotation(file, r, { lockTimeoutMs: 100 }),
        (err) => err instanceof admission.AdmissionError && /could not acquire the rotation lock/.test(err.message)
      );
      assert.equal(fs.existsSync(file), false, 'a live holder\'s lock, even stale by age, is never stolen');
      assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), { pid: process.pid, token: 'someone-elses-token' }, 'the live holder\'s lock file is untouched');
    } finally {
      fs.unlinkSync(lockPath);
    }
  });

  it('_releaseLock does not unlink a lock recorded under a different token (R3 Finding)', () => {
    const file = admission.rotationPath(dir, 'cas-9');
    const lockPath = admission._lockPath(file);
    const token = admission._acquireLock(file);
    // Simulate another writer having reclaimed and re-locked this exact path
    // while we were (hypothetically) still inside our critical section.
    const otherToken = 'a-different-writers-token';
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: otherToken }));

    admission._releaseLock(file, token); // our (now stale) token must not match
    assert.equal(fs.existsSync(lockPath), true, 'the other writer\'s lock must still be there');
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), { pid: process.pid, token: otherToken });

    admission._releaseLock(file, otherToken); // releasing with the CURRENT token does remove it
    assert.equal(fs.existsSync(lockPath), false);
  });

  it('refuses to write a record for one rotationId over a file already holding a different one', () => {
    const file = admission.rotationPath(dir, 'cas-5-slot');
    const first = admission.prepareRotation({ rotationId: 'cas-5-a', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });
    admission.writeRotation(file, first);
    const second = admission.prepareRotation({ rotationId: 'cas-5-b', resourceId: 't', oldAttemptId: 'old', oldEpoch: 0, checkpoint: checkpoint() });
    const advanced = admission.markQuiesced(second);
    assert.throws(
      () => admission.writeRotation(file, advanced),
      (err) => err instanceof admission.AdmissionError && /different rotationId/.test(err.message)
    );
  });
});
