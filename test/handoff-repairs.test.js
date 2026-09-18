'use strict';

/**
 * `applyHandoffRepairs` — the only thing that acts on a preflight proposal
 * (Train 21, #1586).
 *
 * The property under test throughout: a proposal is a *nomination*, never an
 * instruction. Detection is pure and runs before this, so everything it saw may
 * have moved by the time this runs — and every condition that made a proposal
 * repairable is re-established against the live row and the live file before
 * anything is written. The tests below break each of those conditions AFTER the
 * proposal is minted, which is the only way to tell a real re-check apart from
 * one that trusts what it was handed.
 *
 * The second property: this runs on the launch path, before anything is
 * rendered, so a refusal is an outcome and never an exception.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store.js');
const lockfile = require('../lib/handoff-lockfile.js');
const { applyHandoffRepairs } = require('../lib/handoff-publish.js');
const { runPreflight, VERDICTS } = require('../lib/launch-preflight.js');
const { buildHandoffDocument, newPublicationId } = require('../lib/handoff-publication.js');

const tmpDirs = [];
let project;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-handoff-repair-'));
  tmpDirs.push(dir);
  store._setBasePath(dir);
  store.init();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-handoff-repair-root-'));
  tmpDirs.push(root);
  project = store.projects.create({ name: `p-${Math.random().toString(36).slice(2)}`, path: root, engine: 'claude' });
});

after(() => {
  try { store.close(); } catch { /* already closed */ }
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * Stage an attempt on disk and in the DB, binding its eligibility by default.
 * @param {object} [opts] - `{sessionId, wrapRunId, kind, bind}`
 * @returns {string} The publication id
 */
function stageAttempt({ sessionId = 1, wrapRunId = 'run-1', kind = 'final', bind = true } = {}) {
  const publicationId = newPublicationId();
  const doc = buildHandoffDocument({
    publicationId, projectId: project.id, workspaceId: null, sessionId,
    wrapRunId, engineId: 'claude', kind, stagedAt: new Date().toISOString(),
    worktree: null, rules: [], globalRulesHash: null, engineConfigHash: null,
    continuityIndexHash: null, wrapOutcome: 'complete', missingEvidence: []
  });
  const written = lockfile.writeStaged(project, doc);
  store.handoffs.stage({
    publicationId, projectId: project.id, sessionId, wrapRunId, kind,
    fileDigest: written.digest, stagedAt: doc.stagedAt
  });
  if (bind) {
    if (kind === 'final') {
      store.handoffs.bindLifecycleEligibility(publicationId, sessionId, wrapRunId, new Date().toISOString());
    } else {
      store.handoffs.markCheckpointComplete(publicationId, wrapRunId, new Date().toISOString());
    }
  }
  return publicationId;
}

/**
 * The preflight context for this project, read from the live store and disk —
 * so a proposal under test is one the real detector actually emits.
 * @param {object} [over] - Context overrides
 * @returns {object}
 */
function preflightCtx(over = {}) {
  const publications = store.handoffs.listByProject(project.id, 50);
  const stagedFiles = [];
  for (const row of publications) {
    const read = lockfile.readHandoffFile(lockfile.stagedPath(project, row.publicationId));
    if (read.outcome === 'ok') {
      stagedFiles.push({ publicationId: row.publicationId, digest: read.digest, doc: read.doc });
    }
  }
  const current = lockfile.readHandoffFile(lockfile.currentPath(project));
  return {
    projectId: project.id,
    workspaceId: null,
    sessions: [{ id: 1, status: 'wrapped' }],
    publications,
    file: current.outcome === 'ok'
      ? { state: 'valid', digest: current.digest, doc: current.doc }
      : { state: 'absent' },
    stagedFiles,
    continuityIndexPresent: true,
    handoffEpoch: store.handoffEpoch.readBoundary(project.id),
    ...over
  };
}

/**
 * The publication id `current.json` names, or null when there is none.
 * @returns {string|null}
 */
function currentPublicationId() {
  const read = lockfile.readHandoffFile(lockfile.currentPath(project));
  return read.outcome === 'ok' ? read.doc.publicationId : null;
}

describe('a real proposal, applied', () => {
  it('publishes the attempt the detector nominated, and preflight then reads ok', () => {
    // The crash this models: the wrap staged and bound an attempt, then died
    // before the rename. Nothing is current, and the record says one should be.
    const pid = stageAttempt();
    const before = runPreflight(preflightCtx());
    assert.equal(before.verdict, VERDICTS.UNFINISHED, 'precondition: the detector sees an unfinished attempt');
    assert.deepEqual(before.repairs, [{ action: 'publish', publicationId: pid, seq: store.handoffs.get(pid).seq }]);

    const { outcomes, appliedCount } = applyHandoffRepairs(project, before.repairs);
    assert.equal(appliedCount, 1);
    assert.equal(outcomes[0].applied, true);
    assert.equal(currentPublicationId(), pid);
    assert.equal(store.handoffs.get(pid).state, 'published');

    // The single re-run the plan asks for: the pass after a repair sees a
    // consistent record.
    assert.equal(runPreflight(preflightCtx()).verdict, VERDICTS.OK);
  });

  it('reports the attempt it superseded', () => {
    const first = stageAttempt({ wrapRunId: 'run-1' });
    applyHandoffRepairs(project, [{ action: 'publish', publicationId: first }]);
    const second = stageAttempt({ sessionId: 2, wrapRunId: 'run-2' });

    const { outcomes } = applyHandoffRepairs(project, [{ action: 'publish', publicationId: second }]);
    assert.equal(outcomes[0].applied, true);
    assert.equal(outcomes[0].supersededId, first);
    assert.equal(currentPublicationId(), second);
  });
});

describe('the proposal is a nomination, not an instruction', () => {
  it('refuses one whose attempt was superseded after the proposal was minted', () => {
    // Detection is pure and already happened; this is a concurrent finalizer
    // stepping the attempt aside between then and now. Note what CANNOT happen
    // here: an eligible attempt is never abandoned — `store.handoffs.abandon`
    // moves a row only while `eligible_at` is NULL — so superseding is the real
    // shape of "it lost the race after it was nominated".
    const pid = stageAttempt();
    const proposals = runPreflight(preflightCtx()).repairs;
    assert.equal(proposals.length, 1, 'precondition: a proposal exists');

    const winner = stageAttempt({ sessionId: 2, wrapRunId: 'run-winner' });
    store.handoffs.supersedeBeforePublish(pid, winner, new Date().toISOString());

    const { outcomes, appliedCount } = applyHandoffRepairs(project, proposals);
    assert.equal(appliedCount, 0);
    assert.equal(outcomes[0].applied, false);
    assert.match(outcomes[0].reason, /superseded/);
    assert.equal(currentPublicationId(), null, 'nothing was made current');
  });

  it('refuses a stale proposal naming an attempt that never became eligible', () => {
    // The detector would not mint this one — `_repairable` requires
    // `eligible_at`. A proposal replayed from an earlier launch, or handed in by
    // a caller, still reaches here, and eligibility is re-established rather
    // than assumed from the fact that something proposed it.
    const pid = stageAttempt({ bind: false });
    assert.equal(runPreflight(preflightCtx()).repairs.length, 0,
      'precondition: the real detector proposes nothing for an ineligible attempt');

    const { outcomes, appliedCount } = applyHandoffRepairs(project, [
      { action: 'publish', publicationId: pid }
    ]);
    assert.equal(appliedCount, 0);
    assert.match(outcomes[0].reason, /not eligible/);
    assert.equal(currentPublicationId(), null, 'an attempt that never completed is never published');
  });

  it('refuses one whose staged bytes changed after the proposal was minted', () => {
    const pid = stageAttempt();
    const proposals = runPreflight(preflightCtx()).repairs;

    fs.writeFileSync(
      lockfile.stagedPath(project, pid),
      '{"schema":"tc.handoff/1","publicationId":"' + pid + '","kind":"final"}\n',
      'utf8'
    );

    const { outcomes, appliedCount } = applyHandoffRepairs(project, proposals);
    assert.equal(appliedCount, 0);
    assert.match(outcomes[0].reason, /digest does not match/);
    assert.equal(currentPublicationId(), null);
  });

  it('refuses one whose staged file is gone after the proposal was minted', () => {
    const pid = stageAttempt();
    const proposals = runPreflight(preflightCtx()).repairs;
    fs.rmSync(lockfile.stagedPath(project, pid));

    const { outcomes, appliedCount } = applyHandoffRepairs(project, proposals);
    assert.equal(appliedCount, 0);
    assert.equal(outcomes[0].applied, false);
    assert.equal(currentPublicationId(), null, 'a publication is never recorded with no bytes');
  });

  it('never publishes an attempt that a concurrent finalizer already overtook', () => {
    // Both are eligible and ahead of nothing. The newer publishes by another
    // path between detection and repair; the older must become superseded, and
    // must not overwrite the newer handoff.
    const older = stageAttempt({ wrapRunId: 'run-1' });
    const proposals = [{ action: 'publish', publicationId: older }];
    const newer = stageAttempt({ sessionId: 2, wrapRunId: 'run-2' });
    applyHandoffRepairs(project, [{ action: 'publish', publicationId: newer }]);
    assert.equal(currentPublicationId(), newer, 'precondition: the newer attempt is current');

    const { outcomes, appliedCount } = applyHandoffRepairs(project, proposals);
    assert.equal(appliedCount, 0);
    assert.match(outcomes[0].reason, /newer publication/);
    assert.equal(currentPublicationId(), newer, 'current.json is never overwritten by an older attempt');
    assert.equal(store.handoffs.get(older).state, 'superseded', 'it completed, so it steps aside rather than being abandoned');
    assert.equal(store.handoffs.get(older).supersededBy, newer);
  });

  it('refuses a publication id that names nothing', () => {
    const { outcomes, appliedCount } = applyHandoffRepairs(project, [
      { action: 'publish', publicationId: 'pub-that-never-existed' }
    ]);
    assert.equal(appliedCount, 0);
    assert.match(outcomes[0].reason, /no such publication/);
  });
});

describe('two eligible attempts ahead of the published record', () => {
  it('publishes the newest and supersedes the older, never the other way round', () => {
    // A kept session staged a checkpoint, completed it, then staged and bound a
    // final — and the crash landed before either was published. Both are
    // repairable, so the order this applies them in is the whole question.
    const checkpoint = stageAttempt({ wrapRunId: 'run-cp', kind: 'checkpoint' });
    const final = stageAttempt({ wrapRunId: 'run-final', kind: 'final' });
    const checkpointSeq = store.handoffs.get(checkpoint).seq;
    const finalSeq = store.handoffs.get(final).seq;
    assert.ok(finalSeq > checkpointSeq, 'precondition: the final is the newer attempt');

    const detected = runPreflight(preflightCtx());
    assert.equal(detected.repairs.length, 2, 'precondition: the detector proposes both');

    // Deliberately handed oldest-first: the applier must not simply follow the
    // order it was given.
    const oldestFirst = [...detected.repairs].sort((a, b) => a.seq - b.seq);
    const { outcomes } = applyHandoffRepairs(project, oldestFirst);

    assert.equal(currentPublicationId(), final, 'the newest attempt is the one that becomes current');
    assert.equal(store.handoffs.get(final).state, 'published');
    assert.equal(store.handoffs.get(checkpoint).state, 'superseded');
    assert.equal(store.handoffs.get(checkpoint).supersededBy, final);

    const applied = outcomes.filter((o) => o.applied).map((o) => o.publicationId);
    assert.deepEqual(applied, [final], 'exactly one attempt was published');
  });
});

describe('a repair pass never takes the launch down', () => {
  it('refuses an action it cannot carry out rather than skipping it silently', () => {
    // A proposal this cannot apply is a disagreement between the detector and
    // the applier. Reporting it is the point: dropping it would report the pass
    // as clean while the condition that produced it is still there.
    const { outcomes, appliedCount } = applyHandoffRepairs(project, [
      { action: 'delete', publicationId: 'pub-1' }
    ]);
    assert.equal(appliedCount, 0);
    assert.equal(outcomes.length, 1, 'the refusal is reported, not swallowed');
    assert.equal(outcomes[0].applied, false);
    assert.match(outcomes[0].reason, /action "delete"/);
  });

  it('refuses a proposal with no publication id', () => {
    const { outcomes } = applyHandoffRepairs(project, [{ action: 'publish' }]);
    assert.equal(outcomes[0].applied, false);
    assert.match(outcomes[0].reason, /no publication id/);
  });

  it('survives malformed proposals without throwing', () => {
    const { outcomes, appliedCount } = applyHandoffRepairs(project, [null, undefined, 'publish', 42, {}]);
    assert.equal(appliedCount, 0);
    assert.equal(outcomes.length, 5, 'each one is answered for');
    assert.ok(outcomes.every((o) => o.applied === false));
  });

  it('accepts no proposals at all, and anything that is not a list', () => {
    for (const input of [[], null, undefined, 'nope', { action: 'publish' }]) {
      const result = applyHandoffRepairs(project, input);
      assert.deepEqual(result, { outcomes: [], appliedCount: 0 });
    }
  });

  it('applies the proposals it can when another in the same batch is unusable', () => {
    const pid = stageAttempt();
    const { outcomes, appliedCount } = applyHandoffRepairs(project, [
      { action: 'burn-it-down', publicationId: 'pub-x' },
      { action: 'publish', publicationId: pid }
    ]);
    assert.equal(appliedCount, 1);
    assert.equal(currentPublicationId(), pid, 'one bad proposal does not strand a good one');
    assert.ok(outcomes.some((o) => o.applied === false && /burn-it-down/.test(o.reason)));
  });
});

describe('re-running a repair', () => {
  it('is a no-op success, so a launch interrupted mid-repair can simply run again', () => {
    const pid = stageAttempt();
    const proposals = runPreflight(preflightCtx()).repairs;
    assert.equal(applyHandoffRepairs(project, proposals).appliedCount, 1);

    const second = applyHandoffRepairs(project, proposals);
    assert.equal(second.appliedCount, 1, 'an already-published attempt reports success, not a refusal');
    assert.match(second.outcomes[0].reason, /already published/);
    assert.equal(currentPublicationId(), pid);
  });
});

describe('the crash that landed AFTER the rename (#1586)', () => {
  /**
   * Promote a staged attempt's file without writing the DB record — the exact
   * state a crash between `promoteStaged` and `recordPublished` leaves behind.
   * @param {string} publicationId - The attempt
   * @returns {void}
   */
  function promoteWithoutRecording(publicationId) {
    lockfile.promoteStaged(project, publicationId, null);
  }

  it('is proposed at all — a scan of the staged files alone cannot see it', () => {
    // After the rename there is no `staged-<pid>.json` left to find, which is
    // why this case needs its own proposal rather than falling out of the
    // staged-file loop.
    const pid = stageAttempt();
    promoteWithoutRecording(pid);
    assert.equal(fs.existsSync(lockfile.stagedPath(project, pid)), false, 'precondition: the staged file is gone');
    assert.equal(currentPublicationId(), pid, 'precondition: the bytes are already current');
    assert.equal(store.handoffs.get(pid).state, 'staged', 'precondition: the record is behind its bytes');

    const detected = runPreflight(preflightCtx());
    assert.deepEqual(
      detected.repairs.map((r) => r.action),
      ['record-published'],
      'the promoted case is proposed, and the staged-file case is not'
    );
  });

  it('is applied by recording the row, and the next pass reads ok', () => {
    const pid = stageAttempt();
    promoteWithoutRecording(pid);

    const { outcomes, appliedCount } = applyHandoffRepairs(project, runPreflight(preflightCtx()).repairs);
    assert.equal(appliedCount, 1);
    assert.equal(outcomes[0].action, 'record-published');
    assert.equal(store.handoffs.get(pid).state, 'published');
    assert.equal(currentPublicationId(), pid, 'no file moved — the rename had already happened');
    assert.equal(runPreflight(preflightCtx()).verdict, VERDICTS.OK);
  });

  it('refuses when the already-current bytes do not match the row', () => {
    // A promoted file earns no weaker check for having been moved.
    const pid = stageAttempt();
    promoteWithoutRecording(pid);
    fs.writeFileSync(lockfile.currentPath(project), '{"schema":"tc.handoff/1","publicationId":"' + pid + '","kind":"final"}\n', 'utf8');

    const { appliedCount, outcomes } = applyHandoffRepairs(project, [
      { action: 'record-published', publicationId: pid }
    ]);
    assert.equal(appliedCount, 0);
    assert.match(outcomes[0].reason, /digest does not match/);
    assert.equal(store.handoffs.get(pid).state, 'staged', 'the row stays behind rather than recording bytes it cannot vouch for');
  });

  it('refuses when the attempt never became eligible', () => {
    const pid = stageAttempt({ bind: false });
    promoteWithoutRecording(pid);
    const { appliedCount, outcomes } = applyHandoffRepairs(project, [
      { action: 'record-published', publicationId: pid }
    ]);
    assert.equal(appliedCount, 0);
    assert.match(outcomes[0].reason, /not eligible/);
  });

  it('supersedes rather than recording over a newer publication', () => {
    const older = stageAttempt({ wrapRunId: 'run-older' });
    promoteWithoutRecording(older);
    const newer = stageAttempt({ sessionId: 2, wrapRunId: 'run-newer' });
    applyHandoffRepairs(project, [{ action: 'publish', publicationId: newer }]);
    assert.equal(currentPublicationId(), newer, 'precondition: the newer attempt is current');

    const { appliedCount } = applyHandoffRepairs(project, [
      { action: 'record-published', publicationId: older }
    ]);
    assert.equal(appliedCount, 0);
    assert.equal(store.handoffs.get(older).state, 'superseded');
    assert.equal(currentPublicationId(), newer);
  });

  it('re-running it is a no-op success', () => {
    const pid = stageAttempt();
    promoteWithoutRecording(pid);
    const proposals = [{ action: 'record-published', publicationId: pid }];
    assert.equal(applyHandoffRepairs(project, proposals).appliedCount, 1);
    const second = applyHandoffRepairs(project, proposals);
    assert.equal(second.appliedCount, 1);
    assert.match(second.outcomes[0].reason, /already published/);
  });
});

describe('a repair is a fact about the store, not about the verdict', () => {
  it('is proposed even when an earlier check wins the chain', () => {
    // A kept session bound a checkpoint eligible and then crashed. The chain
    // stops at row 5 (`crash-recovery`), and the completed attempt that would
    // recover it must still be proposed — when the scan sat at row 6 it was not,
    // and a later publication's higher seq made it permanently unrepairable.
    const pid = stageAttempt({ kind: 'checkpoint', wrapRunId: 'run-cp' });
    const ctx = preflightCtx({ sessions: [{ id: 1, status: 'crashed' }] });

    const result = runPreflight(ctx);
    assert.equal(result.verdict, VERDICTS.CRASH_RECOVERY, 'precondition: an early row wins');
    assert.deepEqual(result.repairs.map((r) => r.publicationId), [pid],
      'the proposal survives the early exit');
  });

  it('is proposed under a corrupt handoff too — row 1 exits first of all', () => {
    const pid = stageAttempt();
    const result = runPreflight(preflightCtx({ file: { state: 'invalid' } }));
    assert.equal(result.verdict, VERDICTS.HANDOFF_CORRUPT);
    assert.deepEqual(result.repairs.map((r) => r.publicationId), [pid]);
  });
});

describe('the repair vocabulary exists in two places and must stay one list', () => {
  it('every action the detector can propose has an applier', () => {
    // `lib/launch-preflight.js` declares the actions it may mint; this module
    // derives its list from the appliers it actually has. The detector's copy is
    // the one that can grow an action nothing can carry out — and the failure is
    // quiet in the wrong direction: the proposal is refused as "not a repair
    // this can apply", which reads as a malformed caller rather than a missing
    // applier. Same pin, and the same reason, as the baseline vocabulary's.
    const { REPAIR_ACTIONS: proposable } = require('../lib/launch-preflight.js');
    const { REPAIR_ACTIONS: appliable } = require('../lib/handoff-publish.js');
    assert.deepEqual([...proposable].sort(), [...appliable].sort(),
      'add the action to BOTH the proposer and REPAIR_APPLIERS, or it can be proposed and never applied');
  });
});

describe('a batch holding both actions', () => {
  it('records the promoted attempt before renaming another document over it', () => {
    // The two actions contend for ONE `current.json`. A `record-published`
    // proposal exists only because the file already holds its bytes, and a
    // `publish` renames over that file. Ordered by `seq` alone, the rename goes
    // first whenever the promoted attempt has the lower seq — and then either
    // `promoteStaged` refuses to retire a `current.json` naming someone else, or
    // with no published row to retire it destroys the promoted document.
    const promoted = stageAttempt({ wrapRunId: 'run-promoted' });
    lockfile.promoteStaged(project, promoted, null);
    const newer = stageAttempt({ sessionId: 2, wrapRunId: 'run-newer' });
    assert.ok(store.handoffs.get(newer).seq > store.handoffs.get(promoted).seq,
      'precondition: the promoted attempt has the LOWER seq');

    const detected = runPreflight(preflightCtx());
    assert.deepEqual(
      [...detected.repairs].map((r) => r.action).sort(),
      ['publish', 'record-published'],
      'precondition: the detector proposes both in one pass'
    );

    // Handed seq-descending, which is the order that breaks it.
    const seqDescending = [...detected.repairs].sort((a, b) => b.seq - a.seq);
    const { outcomes } = applyHandoffRepairs(project, seqDescending);

    assert.equal(currentPublicationId(), newer, 'the newest attempt ends up current');
    assert.equal(store.handoffs.get(newer).state, 'published');

    // The ROW state alone cannot tell the two orderings apart: in the broken
    // order the promoted attempt still ends `superseded`, because the publish
    // that destroyed its document also made it the newer publication. What
    // differs is whether the document survived, so that is what is asserted.
    assert.equal(store.handoffs.get(promoted).state, 'superseded');
    assert.equal(store.handoffs.get(promoted).supersededBy, newer);
    const retired = lockfile.readHandoffFile(lockfile.historyPath(project, promoted));
    assert.equal(retired.outcome, 'ok', 'the promoted document was filed, not overwritten');
    assert.equal(retired.doc.publicationId, promoted);
    assert.ok(outcomes.every((o) => typeof o.reason === 'string' || o.applied),
      'every proposal is answered for');
  });

  it('files the promoted document in history rather than destroying it', () => {
    // The concrete loss the ordering prevents: with no published row to retire,
    // `promoteStaged` skips the retire branch entirely and renames straight over
    // whatever `current.json` holds.
    const promoted = stageAttempt({ wrapRunId: 'run-promoted' });
    lockfile.promoteStaged(project, promoted, null);
    const newer = stageAttempt({ sessionId: 2, wrapRunId: 'run-newer' });

    applyHandoffRepairs(project, runPreflight(preflightCtx()).repairs);

    const retired = lockfile.readHandoffFile(lockfile.historyPath(project, promoted));
    assert.equal(retired.outcome, 'ok', 'the replaced document survives in history/');
    assert.equal(retired.doc.publicationId, promoted);
    assert.equal(currentPublicationId(), newer);
  });

  it('applies record-published first whatever order the batch arrives in', () => {
    const promoted = stageAttempt({ wrapRunId: 'run-promoted' });
    lockfile.promoteStaged(project, promoted, null);
    const newer = stageAttempt({ sessionId: 2, wrapRunId: 'run-newer' });

    const { outcomes } = applyHandoffRepairs(project, [
      { action: 'publish', publicationId: newer },
      { action: 'record-published', publicationId: promoted }
    ]);
    assert.deepEqual(outcomes.map((o) => o.action), ['record-published', 'publish'],
      'the applier orders the batch; it does not follow the order it was given');
  });
});
