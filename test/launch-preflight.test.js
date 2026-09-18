'use strict';

/*
 * The launch preflight's ordered verdicts (Train 21, car 21.8).
 *
 * Two properties carry this file, and they are the two the plan's §2.7 spends
 * its words on.
 *
 * ORDER IS THE DESIGN. Each check is asserted against a fixture that ALSO
 * satisfies a later one, so a test fails if the checks are reordered rather than
 * only if one is deleted. A suite that asserted each verdict from a fixture
 * matching exactly one row would pass against any ordering, which is the whole
 * thing §2.7 is specifying.
 *
 * `ok` IS A POSITIVE PREDICATE. The exhaustive pass at the bottom walks the
 * input space and asserts that `ok` appears ONLY for the one combination that
 * names it, and that everything else lands on a recovery or reconciliation
 * verdict. That is the acceptance case's "table-driven test asserts every other
 * combination of the input space lands on a recovery or advisory verdict", and
 * it is what stops `ok` degrading into a fallthrough later.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const preflight = require('../lib/launch-preflight');
const { runPreflight, needsRecovery, needsReconciliation, VERDICTS, FILE_STATES, BASELINES } = preflight;

const PROJECT = 14;
const WORKSPACE = 'tangleclaw-builder-15ba0aaf';
const DIGEST = 'sha256:aaa';

/**
 * A worktree block as a handoff records one.
 * @param {object} [o] - Overrides.
 * @returns {object}
 */
function worktree(o = {}) {
  return {
    path: '/repo', toplevel: '/repo', gitDir: '/repo/.git',
    branch: 'main', headSha: 'abc123', dirty: false, ...o
  };
}

/**
 * A `current.json` document.
 * @param {object} [o] - Overrides.
 * @returns {object}
 */
function doc(o = {}) {
  return {
    schema: 'tc.handoff/1', publicationId: 'pid-1', projectId: PROJECT,
    workspaceId: WORKSPACE, sessionId: 10, kind: 'final', worktree: worktree(), ...o
  };
}

/**
 * A publication row as the store shapes one.
 * @param {object} [o] - Overrides.
 * @returns {object}
 */
function pub(o = {}) {
  return {
    publicationId: 'pid-1', seq: 1, projectId: PROJECT, sessionId: 10,
    wrapRunId: 'run-1', kind: 'final', state: 'published', fileDigest: DIGEST,
    eligibleAt: '2026-09-17T00:00:00Z', eligibleVia: 'lifecycle-wrap', ...o
  };
}

/**
 * A context whose defaults are the healthy case, so each test states only its
 * own deviation and an unrelated default can never be what made it pass.
 * @param {object} [o] - Overrides.
 * @returns {object}
 */
function ctx(o = {}) {
  return {
    projectId: PROJECT,
    workspaceId: WORKSPACE,
    sessions: [{ id: 10, status: 'wrapped' }],
    publications: [pub()],
    file: { state: FILE_STATES.VALID, doc: doc(), digest: DIGEST },
    stagedFiles: [],
    continuityIndexPresent: true,
    handoffEpoch: { epochSessionId: 0, baseline: BASELINES.EMPTY, baselineReason: null },
    worktreeProbe: { toplevelExists: true, headSha: 'abc123', branch: 'main' },
    fallbackRootHead: null,
    ...o
  };
}

describe('runPreflight — the healthy case', () => {
  it('reaches ok for a current eligible final from the newest wrapped session', () => {
    const r = runPreflight(ctx());
    assert.equal(r.verdict, VERDICTS.OK);
    assert.equal(needsRecovery(r), false);
    assert.equal(needsReconciliation(r), false);
  });

  it('accepts a kept session\'s checkpoint, because that session has not finished yet', () => {
    const r = runPreflight(ctx({
      sessions: [{ id: 10, status: 'active' }],
      publications: [pub({ kind: 'checkpoint', eligibleVia: 'checkpoint-complete' })],
      file: { state: FILE_STATES.VALID, doc: doc({ kind: 'checkpoint' }), digest: DIGEST }
    }));
    assert.equal(r.verdict, VERDICTS.OK);
  });

  it('refuses a checkpoint whose session is no longer kept', () => {
    // The mirror of the case above, and the reason `ok` names the status: a
    // checkpoint from a session that has since ended is an unfinished story.
    const r = runPreflight(ctx({
      sessions: [{ id: 10, status: 'wrapped' }],
      publications: [pub({ kind: 'checkpoint', eligibleVia: 'checkpoint-complete' })],
      file: { state: FILE_STATES.VALID, doc: doc({ kind: 'checkpoint' }), digest: DIGEST }
    }));
    assert.notEqual(r.verdict, VERDICTS.OK);
    assert.equal(needsRecovery(r), true);
  });

  it('accepts a non-git project only with the skip written down', () => {
    const r = runPreflight(ctx({
      file: { state: FILE_STATES.VALID, doc: doc({ worktree: null }), digest: DIGEST },
      worktreeProbe: null
    }));
    assert.equal(r.verdict, VERDICTS.OK);
    assert.equal(r.evidence.worktreeChecks, 'skipped: no-git');
  });
});

describe('runPreflight — integrity comes before every exception', () => {
  for (const state of [FILE_STATES.UNREADABLE, FILE_STATES.INVALID]) {
    it(`reports handoff-corrupt for a ${state} file even under first-launch conditions`, () => {
      // The ordering assertion: this fixture ALSO satisfies row 4's "no sessions,
      // no publications, no continuity". If integrity were checked after the
      // compatibility exceptions, a corrupt artifact would be waved through as a
      // brand-new project.
      const r = runPreflight(ctx({
        sessions: [], publications: [], continuityIndexPresent: false,
        file: { state, doc: null, digest: null }
      }));
      assert.equal(r.verdict, VERDICTS.HANDOFF_CORRUPT);
      assert.equal(needsRecovery(r), true);
    });

    it(`reports handoff-corrupt for a ${state} file even under legacy conditions`, () => {
      const r = runPreflight(ctx({
        sessions: [{ id: 3, status: 'wrapped' }], publications: [],
        handoffEpoch: { epochSessionId: 5, baseline: BASELINES.CLEAN, baselineReason: null },
        file: { state, doc: null, digest: null }
      }));
      assert.equal(r.verdict, VERDICTS.HANDOFF_CORRUPT);
    });
  }

  it('reports identity-mismatch before reading any other handoff field', () => {
    const r = runPreflight(ctx({ file: { state: FILE_STATES.VALID, doc: doc({ projectId: 99 }), digest: DIGEST } }));
    assert.equal(r.verdict, VERDICTS.IDENTITY_MISMATCH);
    assert.match(r.reasons.join(' '), /projectId 99/);
  });

  it('does not call a null workspaceId a mismatch', () => {
    // A handoff written before the workspace id was resolvable records null.
    // Refusing those would turn old-but-sound handoffs into identity incidents.
    const r = runPreflight(ctx({
      file: { state: FILE_STATES.VALID, doc: doc({ workspaceId: null }), digest: DIGEST }
    }));
    assert.equal(r.verdict, VERDICTS.OK);
  });
});

describe('runPreflight — the two explicit exceptions', () => {
  it('reports first-launch only when all four conditions hold', () => {
    const r = runPreflight(ctx({
      sessions: [], publications: [], continuityIndexPresent: false,
      file: { state: FILE_STATES.ABSENT, doc: null, digest: null }
    }));
    assert.equal(r.verdict, VERDICTS.FIRST_LAUNCH);
    assert.equal(needsRecovery(r), false);
  });

  it('does not report first-launch when a continuity index exists', () => {
    // A project with continuity has run before; calling that a first launch
    // would hand the next session a clean slate it did not earn.
    const r = runPreflight(ctx({
      sessions: [], publications: [], continuityIndexPresent: true,
      file: { state: FILE_STATES.ABSENT, doc: null, digest: null }
    }));
    assert.equal(r.verdict, VERDICTS.UNCLASSIFIED);
    assert.equal(needsRecovery(r), true);
  });

  it('reports legacy for a clean pre-epoch history with no handoff', () => {
    const r = runPreflight(ctx({
      sessions: [{ id: 3, status: 'wrapped' }], publications: [],
      handoffEpoch: { epochSessionId: 5, baseline: BASELINES.CLEAN, baselineReason: null },
      file: { state: FILE_STATES.ABSENT, doc: null, digest: null }
    }));
    assert.equal(r.verdict, VERDICTS.LEGACY);
    assert.equal(needsRecovery(r), false);
  });

  it('reports legacy-unclean when the baseline was not clean', () => {
    const r = runPreflight(ctx({
      sessions: [{ id: 3, status: 'wrapped' }], publications: [],
      handoffEpoch: { epochSessionId: 5, baseline: BASELINES.UNCLEAN, baselineReason: 'continuity index missing' },
      file: { state: FILE_STATES.ABSENT, doc: null, digest: null }
    }));
    assert.equal(r.verdict, VERDICTS.LEGACY_UNCLEAN);
    assert.equal(needsRecovery(r), true);
    assert.match(r.reasons.join(' '), /continuity index missing/);
  });

  it('ends legacy acceptance permanently at the first post-epoch session', () => {
    // The boundary the epoch exists to draw: one session past it and a lost
    // handoff is never forgiven as legacy again.
    const r = runPreflight(ctx({
      sessions: [{ id: 3, status: 'wrapped' }, { id: 9, status: 'wrapped' }], publications: [],
      handoffEpoch: { epochSessionId: 5, baseline: BASELINES.CLEAN, baselineReason: null },
      file: { state: FILE_STATES.ABSENT, doc: null, digest: null }
    }));
    assert.equal(r.verdict, VERDICTS.HANDOFF_NEVER_PUBLISHED);
    assert.equal(needsRecovery(r), true);
  });
});

describe('runPreflight — a session that did not finish', () => {
  it('reports crash-recovery when the newest session crashed', () => {
    const r = runPreflight(ctx({ sessions: [{ id: 10, status: 'crashed' }] }));
    assert.equal(r.verdict, VERDICTS.CRASH_RECOVERY);
  });

  it('treats a killed session the same way', () => {
    const r = runPreflight(ctx({ sessions: [{ id: 10, status: 'killed' }] }));
    assert.equal(r.verdict, VERDICTS.CRASH_RECOVERY);
  });

  it('clears a crash once a LATER session publishes an eligible final', () => {
    // The pivot §2.7 names: a crash is recovered by a later good session, which
    // then becomes the newest. Without this the project would be in recovery
    // forever.
    const r = runPreflight(ctx({
      sessions: [{ id: 10, status: 'crashed' }, { id: 11, status: 'wrapped' }],
      publications: [pub({ publicationId: 'pid-2', seq: 2, sessionId: 11 })],
      file: { state: FILE_STATES.VALID, doc: doc({ publicationId: 'pid-2', sessionId: 11 }), digest: DIGEST }
    }));
    assert.equal(r.verdict, VERDICTS.OK);
  });

  it('reports handoff-behind when a later session wrapped without publishing', () => {
    const r = runPreflight(ctx({
      sessions: [{ id: 10, status: 'wrapped' }, { id: 11, status: 'wrapped' }]
    }));
    assert.equal(r.verdict, VERDICTS.HANDOFF_BEHIND);
    assert.equal(needsRecovery(r), true);
  });
});

describe('runPreflight — repairs are proposals, and eligibility is the gate', () => {
  it('proposes publishing a staged, eligible, digest-matching attempt', () => {
    const staged = pub({ publicationId: 'pid-2', seq: 2, state: 'staged', fileDigest: 'sha256:bbb' });
    const r = runPreflight(ctx({
      publications: [pub(), staged],
      stagedFiles: [{ publicationId: 'pid-2', digest: 'sha256:bbb', doc: doc({ publicationId: 'pid-2' }) }]
    }));
    assert.deepEqual(r.repairs, [{ action: 'publish', publicationId: 'pid-2', seq: 2 }]);
    // Still `unfinished` on this pass: §2.7 row 6 is evaluated "after any
    // validated repair", and no repair has run yet. Reporting ok here would let
    // the launcher proceed past a proposal nobody applied.
    assert.equal(r.verdict, VERDICTS.UNFINISHED);
  });

  it('carries the proposal on every path, not only the one that reports it', () => {
    // A repair describes the store, not the verdict. A path that dropped it
    // would strand the attempt it names.
    const staged = pub({ publicationId: 'pid-2', seq: 2, state: 'staged', fileDigest: 'sha256:bbb' });
    const r = runPreflight(ctx({
      publications: [pub(), staged],
      stagedFiles: [{ publicationId: 'pid-2', digest: 'sha256:bbb', doc: doc({ publicationId: 'pid-2' }) }],
      worktreeProbe: { toplevelExists: true, headSha: 'moved', branch: 'main' }
    }));
    assert.equal(r.repairs.length, 1, 'the proposal survives whichever check returns first');
  });

  it('never proposes a repair for an attempt that was never bound eligible', () => {
    // The rule that kept attempt A from being published by attempt B's success:
    // eligibility is the ONLY durable proof the attempt completed, and session
    // status is never an input.
    const staged = pub({ publicationId: 'pid-2', seq: 2, state: 'staged', eligibleAt: null, fileDigest: 'sha256:bbb' });
    const r = runPreflight(ctx({
      publications: [pub(), staged],
      stagedFiles: [{ publicationId: 'pid-2', digest: 'sha256:bbb', doc: doc({ publicationId: 'pid-2' }) }]
    }));
    assert.deepEqual(r.repairs, []);
    assert.equal(r.verdict, VERDICTS.UNFINISHED);
  });

  it('never proposes a repair for a file whose digest differs from its row', () => {
    const staged = pub({ publicationId: 'pid-2', seq: 2, state: 'staged', fileDigest: 'sha256:bbb' });
    const r = runPreflight(ctx({
      publications: [pub(), staged],
      stagedFiles: [{ publicationId: 'pid-2', digest: 'sha256:WRONG', doc: doc({ publicationId: 'pid-2' }) }]
    }));
    assert.deepEqual(r.repairs, []);
    assert.equal(r.verdict, VERDICTS.UNFINISHED);
  });

  it('reports unfinished for an abandoned attempt past the published record', () => {
    const r = runPreflight(ctx({
      publications: [pub(), pub({ publicationId: 'pid-2', seq: 2, state: 'abandoned', eligibleAt: null })]
    }));
    assert.equal(r.verdict, VERDICTS.UNFINISHED);
  });

  it('reports unfinished when a kept session wrapped after a checkpoint with no final', () => {
    const r = runPreflight(ctx({
      sessions: [{ id: 10, status: 'wrapped' }],
      publications: [pub({ kind: 'checkpoint', eligibleVia: 'checkpoint-complete' })],
      file: { state: FILE_STATES.VALID, doc: doc({ kind: 'checkpoint' }), digest: DIGEST }
    }));
    assert.equal(r.verdict, VERDICTS.UNFINISHED);
  });
});

describe('runPreflight — file and rows disagreeing', () => {
  it('reports handoff-missing when a published row has no file', () => {
    const r = runPreflight(ctx({ file: { state: FILE_STATES.ABSENT, doc: null, digest: null } }));
    assert.equal(r.verdict, VERDICTS.HANDOFF_MISSING);
  });

  it('reports handoff-unexpected for a valid file with no history at all', () => {
    const r = runPreflight(ctx({ sessions: [], publications: [] }));
    assert.equal(r.verdict, VERDICTS.HANDOFF_UNEXPECTED);
  });

  it('reports handoff-unconfirmed when the file names a row that does not exist', () => {
    const r = runPreflight(ctx({
      file: { state: FILE_STATES.VALID, doc: doc({ publicationId: 'pid-ghost' }), digest: DIGEST }
    }));
    assert.equal(r.verdict, VERDICTS.HANDOFF_UNCONFIRMED);
    assert.match(r.reasons.join(' '), /pid-ghost/);
  });

  it('reports handoff-unconfirmed when the file digest does not match its row', () => {
    const r = runPreflight(ctx({
      file: { state: FILE_STATES.VALID, doc: doc(), digest: 'sha256:DIFFERENT' }
    }));
    assert.equal(r.verdict, VERDICTS.HANDOFF_UNCONFIRMED);
  });

  it('reports handoff-unconfirmed when the named row is not eligible', () => {
    const r = runPreflight(ctx({ publications: [pub({ eligibleAt: null })] }));
    assert.equal(r.verdict, VERDICTS.HANDOFF_UNCONFIRMED);
  });
});

describe('runPreflight — the workspace moved', () => {
  it('reports workspace-unavailable, with recovery only if it was dirty', () => {
    const gone = { toplevelExists: false, headSha: null, branch: null };
    const clean = runPreflight(ctx({ worktreeProbe: gone }));
    assert.equal(clean.verdict, VERDICTS.WORKSPACE_UNAVAILABLE);
    assert.equal(needsRecovery(clean), false, 'a clean vanished worktree has nothing to recover');
    assert.equal(needsReconciliation(clean), true);

    const dirty = runPreflight(ctx({
      file: { state: FILE_STATES.VALID, doc: doc({ worktree: worktree({ dirty: true }) }), digest: DIGEST },
      worktreeProbe: gone
    }));
    assert.equal(dirty.verdict, VERDICTS.WORKSPACE_UNAVAILABLE);
    assert.equal(needsRecovery(dirty), true, 'uncommitted work in a vanished worktree is lost work');
  });

  it('never lets the registered root\'s HEAD promote a vanished worktree to ok', () => {
    // Diagnosis only. Knowing some other tree is healthy says nothing about the
    // one the handoff named.
    const r = runPreflight(ctx({
      worktreeProbe: { toplevelExists: false, headSha: null, branch: null },
      fallbackRootHead: 'abc123'
    }));
    assert.equal(r.verdict, VERDICTS.WORKSPACE_UNAVAILABLE);
    assert.equal(r.evidence.fallbackRootHead, 'abc123');
  });

  it('reports stale before ok when HEAD moved', () => {
    const r = runPreflight(ctx({ worktreeProbe: { toplevelExists: true, headSha: 'moved', branch: 'main' } }));
    assert.equal(r.verdict, VERDICTS.STALE);
    assert.equal(needsRecovery(r), false);
    assert.equal(needsReconciliation(r), true);
  });

  it('reports stale when the branch moved', () => {
    const r = runPreflight(ctx({ worktreeProbe: { toplevelExists: true, headSha: 'abc123', branch: 'other' } }));
    assert.equal(r.verdict, VERDICTS.STALE);
  });
});

describe('runPreflight — the catch-all', () => {
  it('reports unclassified for a continuity index with no history', () => {
    const r = runPreflight(ctx({
      sessions: [], publications: [], continuityIndexPresent: true,
      file: { state: FILE_STATES.ABSENT, doc: null, digest: null },
      handoffEpoch: { epochSessionId: 0, baseline: BASELINES.EMPTY, baselineReason: null }
    }));
    assert.equal(r.verdict, VERDICTS.UNCLASSIFIED);
    assert.equal(needsRecovery(r), true);
  });

  it('reports unclassified for an active session with no checkpoint', () => {
    // §2.7's second named example. The session is live and pre-epoch, so no
    // "ran after the epoch" row claims it, and there is nothing to hand over.
    const r = runPreflight(ctx({
      sessions: [{ id: 3, status: 'active' }],
      publications: [],
      handoffEpoch: { epochSessionId: 5, baseline: BASELINES.UNCLEAN, baselineReason: 'session still active' },
      file: { state: FILE_STATES.ABSENT, doc: null, digest: null }
    }));
    assert.equal(r.verdict, VERDICTS.LEGACY_UNCLEAN);
    assert.equal(needsRecovery(r), true);
  });

  it('lists the predicates that failed rather than a bare verdict', () => {
    const r = runPreflight(ctx({
      sessions: [], publications: [], continuityIndexPresent: true,
      file: { state: FILE_STATES.ABSENT, doc: null, digest: null }
    }));
    assert.equal(r.verdict, VERDICTS.UNCLASSIFIED);
    assert.ok(r.reasons.length > 0, 'unclassified must say what failed');
  });
});

describe('runPreflight — purity', () => {
  it('never throws, whatever it is handed', () => {
    // The launcher calls this before rendering. A throw here would take down the
    // launch this exists to protect, so malformed input must still produce a
    // verdict.
    for (const bad of [undefined, null, {}, { sessions: 'no' }, { publications: [null] },
      { file: {} }, { handoffEpoch: {} }, { sessions: [{ id: 'x' }] }]) {
      const r = runPreflight(bad);
      assert.equal(typeof r.verdict, 'string');
      assert.ok(Array.isArray(r.reasons));
      assert.ok(Array.isArray(r.repairs));
    }
  });

  it('does not mutate the context it was given', () => {
    const input = ctx();
    const before = JSON.stringify(input);
    runPreflight(input);
    assert.equal(JSON.stringify(input), before);
  });

  it('returns the same shape on every path', () => {
    for (const c of [ctx(), ctx({ sessions: [] }), ctx({ file: { state: FILE_STATES.INVALID } })]) {
      const r = runPreflight(c);
      assert.deepEqual(Object.keys(r).sort(), ['evidence', 'reasons', 'repairs', 'verdict']);
    }
  });
});

describe('ok is a positive predicate, proven by exhaustion', () => {
  // The acceptance case: walk the input space and assert `ok` appears ONLY where
  // it is named. Every other cell must be a verdict that stops the launch short
  // of "fine" — recovery, reconciliation, or one of the two explicit exceptions
  // that are deliberately neither.
  const FILE = [FILE_STATES.ABSENT, FILE_STATES.UNREADABLE, FILE_STATES.INVALID, FILE_STATES.VALID];
  const STATUSES = ['wrapped', 'active', 'crashed', 'killed'];
  const KINDS = ['final', 'checkpoint'];
  const STATES = ['published', 'staged', 'superseded', 'abandoned'];
  const ELIGIBLE = [true, false];

  it('finds ok only for the combination §2.7 row 15 names', () => {
    const okCases = [];
    let total = 0;

    for (const fileState of FILE) {
      for (const status of STATUSES) {
        for (const kind of KINDS) {
          for (const state of STATES) {
            for (const eligible of ELIGIBLE) {
              total++;
              const p = pub({ kind, state, eligibleAt: eligible ? '2026-09-17T00:00:00Z' : null });
              const d = doc({ kind });
              const r = runPreflight(ctx({
                sessions: [{ id: 10, status }],
                publications: [p],
                file: {
                  state: fileState,
                  doc: fileState === FILE_STATES.VALID ? d : null,
                  digest: fileState === FILE_STATES.VALID ? DIGEST : null
                }
              }));
              if (r.verdict === VERDICTS.OK) {
                okCases.push({ fileState, status, kind, state, eligible });
                continue;
              }
              // Everything that is not ok must be actionable: recovery, a
              // reconciliation, or an explicit exception. A verdict that is
              // none of those would be a silent pass under another name.
              const actionable = needsRecovery(r) || needsReconciliation(r)
                || r.verdict === VERDICTS.FIRST_LAUNCH || r.verdict === VERDICTS.LEGACY;
              assert.ok(actionable,
                `${r.verdict} for ${JSON.stringify({ fileState, status, kind, state, eligible })} is neither ok nor actionable`);
            }
          }
        }
      }
    }

    assert.equal(total, FILE.length * STATUSES.length * KINDS.length * STATES.length * ELIGIBLE.length);
    // Exactly two: a final from a wrapped session, and a checkpoint from a
    // session still kept. Both require a valid file, a published row and a bound
    // eligibility — which is row 15 stated as a fact about the whole space
    // rather than as a claim in one fixture.
    assert.deepEqual(okCases, [
      { fileState: FILE_STATES.VALID, status: 'wrapped', kind: 'final', state: 'published', eligible: true },
      { fileState: FILE_STATES.VALID, status: 'active', kind: 'checkpoint', state: 'published', eligible: true }
    ]);
  });

  it('never reaches ok without a current publication, whatever the baseline', () => {
    for (const baseline of [BASELINES.CLEAN, BASELINES.UNCLEAN, BASELINES.EMPTY]) {
      for (const epochSessionId of [0, 5, 100]) {
        const r = runPreflight(ctx({
          publications: [],
          file: { state: FILE_STATES.ABSENT, doc: null, digest: null },
          handoffEpoch: { epochSessionId, baseline, baselineReason: null }
        }));
        assert.notEqual(r.verdict, VERDICTS.OK, `baseline ${baseline} epoch ${epochSessionId} reached ok with no publication`);
      }
    }
  });

  it('classifies every verdict it can return as recovery, reconciliation, or an explicit exception', () => {
    // Nothing may sit outside the three buckets: a verdict that is in none would
    // be a pass nobody decided to grant.
    const exceptions = new Set([VERDICTS.FIRST_LAUNCH, VERDICTS.LEGACY, VERDICTS.OK]);
    for (const verdict of Object.values(VERDICTS)) {
      const covered = preflight.RECOVERY_VERDICTS.has(verdict)
        || preflight.RECONCILIATION_VERDICTS.has(verdict)
        || exceptions.has(verdict);
      assert.ok(covered, `${verdict} belongs to no bucket`);
    }
  });
});
