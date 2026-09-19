'use strict';

/**
 * Launch preflight: what the last session left behind, decided before the next
 * one is handed anything.
 *
 * A session used to start with no statement about the one before it. A handoff
 * that was never written, one written by a run that crashed before it completed,
 * and a project that has genuinely never launched all presented the same way —
 * as an absent file — so the launcher could not tell "nothing to hand over" from
 * "something was lost". This decides which of those it is, and says so in one
 * word.
 *
 * **Purity is the contract, not a style preference.** This runs on the launch
 * path beside the stranded-wrap gate, before anything is rendered. It never
 * writes and never throws to the launcher: a preflight that threw would take
 * down the launch it exists to protect, and a preflight that wrote would be
 * repairing state it is in the middle of judging. Repairs are returned as
 * *proposals*; `applyHandoffRepairs` is the only thing that acts on them, and it
 * re-checks every condition itself.
 *
 * **The order of the checks is the design.** Artifact integrity is decided
 * first, before any compatibility exception, so that no "this project is new" or
 * "this project predates handoffs" branch can be reached while a corrupt
 * artifact is sitting on disk — an exception evaluated ahead of integrity is how
 * a bad artifact gets waved through as a normal first launch.
 *
 * **`ok` is a positive predicate, never a fallthrough.** It is row 15 and it
 * names every condition it requires. Anything matching no row at all is row 16,
 * `unclassified`, which is a recovery verdict carrying the list of predicates
 * that failed. The two together mean a case nobody anticipated lands in recovery
 * rather than in "fine".
 */

/**
 * File states for `current.json`, as the caller reports them.
 *
 * `unreadable` and `invalid` are kept apart because they need different words in
 * front of an operator — one is a filesystem problem, the other is a file whose
 * bytes parsed but did not describe a handoff this build understands.
 */
const FILE_STATES = Object.freeze({
  ABSENT: 'absent',
  UNREADABLE: 'unreadable',
  INVALID: 'invalid',
  VALID: 'valid'
});

/** Baseline classifications recorded at the migration boundary. */
const BASELINES = Object.freeze({
  CLEAN: 'clean',
  UNCLEAN: 'unclean',
  EMPTY: 'empty'
});

/**
 * Every verdict this can return.
 *
 * Exported so callers match on a constant rather than a spelling, and so a test
 * can assert the set is exhaustive instead of trusting a literal list to have
 * been kept in step.
 */
const VERDICTS = Object.freeze({
  HANDOFF_CORRUPT: 'handoff-corrupt',
  IDENTITY_MISMATCH: 'identity-mismatch',
  HANDOFF_UNEXPECTED: 'handoff-unexpected',
  FIRST_LAUNCH: 'first-launch',
  CRASH_RECOVERY: 'crash-recovery',
  UNFINISHED: 'unfinished',
  LEGACY: 'legacy',
  LEGACY_UNCLEAN: 'legacy-unclean',
  HANDOFF_NEVER_PUBLISHED: 'handoff-never-published',
  HANDOFF_MISSING: 'handoff-missing',
  HANDOFF_UNCONFIRMED: 'handoff-unconfirmed',
  HANDOFF_BEHIND: 'handoff-behind',
  WORKSPACE_UNAVAILABLE: 'workspace-unavailable',
  STALE: 'stale',
  OK: 'ok',
  UNCLASSIFIED: 'unclassified',
  // Not a decision this module ever returns — it is what the LAUNCH records
  // when the context could not be gathered at all, and it lives here because
  // every other reader of a verdict (the stored launch record, the READY
  // attestation check, the exhaustiveness test below) matches against this enum.
  // A verdict the system can hold but the enum cannot name is one the
  // exhaustiveness proof silently skips.
  NOT_EVALUATED: 'not-evaluated'
});

/**
 * The verdicts that put the next session into recovery.
 *
 * `workspace-unavailable` is deliberately absent: whether it needs recovery
 * depends on whether the vanished worktree had uncommitted work, which is a
 * per-case answer rather than a property of the verdict. `needsRecovery` below
 * owns that one exception so no caller has to remember it.
 */
const RECOVERY_VERDICTS = Object.freeze(new Set([
  VERDICTS.HANDOFF_CORRUPT,
  VERDICTS.IDENTITY_MISMATCH,
  VERDICTS.HANDOFF_UNEXPECTED,
  VERDICTS.CRASH_RECOVERY,
  VERDICTS.UNFINISHED,
  VERDICTS.LEGACY_UNCLEAN,
  VERDICTS.HANDOFF_NEVER_PUBLISHED,
  VERDICTS.HANDOFF_MISSING,
  VERDICTS.HANDOFF_UNCONFIRMED,
  VERDICTS.HANDOFF_BEHIND,
  VERDICTS.UNCLASSIFIED
]));

/**
 * Verdicts that require the next session to reconcile before it is READY, even
 * where no recovery is owed. Both describe a workspace that moved under a
 * handoff which is otherwise sound, so the document is still worth reading — it
 * just cannot be believed about the tree without a human saying so.
 */
const RECONCILIATION_VERDICTS = Object.freeze(new Set([
  VERDICTS.WORKSPACE_UNAVAILABLE,
  VERDICTS.STALE
]));

/** Session statuses that mean the session did not end on its own terms. */
const CRASHED_STATUSES = Object.freeze(new Set(['crashed', 'killed']));

/**
 * Whether a verdict puts the next session into recovery.
 *
 * Takes the whole result rather than the verdict alone because
 * `workspace-unavailable` cannot be answered from the word: a vanished worktree
 * that was clean has nothing to recover, while one that had uncommitted work has
 * lost it. Reading `evidence.worktreeDirty` here keeps that single exception in
 * one place instead of at each call site. That field is true/false/null, and the
 * null is load-bearing: only a MEASURED clean tree withholds recovery.
 *
 * @param {{verdict: string, evidence: object}} result - A `runPreflight` result.
 * @returns {boolean}
 */
function needsRecovery(result) {
  if (!result || typeof result.verdict !== 'string') return false;
  if (result.verdict === VERDICTS.WORKSPACE_UNAVAILABLE) {
    // Only a MEASURED clean tree withholds recovery. An unverifiable loss is not
    // a proven non-loss, so the unknown owes recovery — the same direction
    // `probeWorktree` already takes when a HEAD probe fails.
    return (result.evidence && result.evidence.worktreeDirty) !== false;
  }
  return RECOVERY_VERDICTS.has(result.verdict);
}

/**
 * Whether a verdict requires a reconciliation before READY.
 * @param {{verdict: string}} result - A `runPreflight` result.
 * @returns {boolean}
 */
function needsReconciliation(result) {
  return !!result && RECONCILIATION_VERDICTS.has(result.verdict);
}

/**
 * The prior session with the highest id, or null when there are none.
 * @param {Array<{id: number, status: string}>} sessions - Session history.
 * @returns {{id: number, status: string}|null}
 */
function _newestSession(sessions) {
  let newest = null;
  for (const s of sessions) {
    if (!newest || s.id > newest.id) newest = s;
  }
  return newest;
}

/**
 * The published row with the highest `seq`, or null.
 * @param {object[]} publications - Publication rows.
 * @returns {object|null}
 */
function _newestPublished(publications) {
  let newest = null;
  for (const p of publications) {
    if (p.state !== 'published') continue;
    if (!newest || p.seq > newest.seq) newest = p;
  }
  return newest;
}

/**
 * Resolve the **current publication** — the one `current.json` names, if that
 * row is genuinely the install's newest published, eligible, digest-matching
 * record.
 *
 * Every clause is a separate reason string rather than one boolean, because the
 * caller that lands on `unclassified` has to be able to say which predicate
 * failed. A single "not current" would make the catch-all unreadable, which is
 * the failure mode `reasons[]` exists to prevent.
 *
 * @param {object} ctx - Normalized context.
 * @returns {{row: object|null, reasons: string[]}}
 */
function _resolveCurrentPublication(ctx) {
  const reasons = [];
  if (ctx.file.state !== FILE_STATES.VALID) {
    reasons.push(`current.json is ${ctx.file.state}, not valid`);
    return { row: null, reasons };
  }
  const pid = ctx.file.doc && ctx.file.doc.publicationId;
  if (!pid) {
    reasons.push('current.json names no publicationId');
    return { row: null, reasons };
  }
  const row = ctx.publications.find((p) => p.publicationId === pid) || null;
  if (!row) {
    reasons.push(`current.json names publication ${pid}, which has no row`);
    return { row: null, reasons };
  }
  if (row.state !== 'published') reasons.push(`publication ${pid} is ${row.state}, not published`);
  if (!row.eligibleAt) reasons.push(`publication ${pid} was never bound eligible`);
  if (ctx.file.digest !== row.fileDigest) {
    reasons.push(`current.json digest does not match publication ${pid}`);
  }
  const newestPublished = _newestPublished(ctx.publications);
  if (newestPublished && newestPublished.publicationId !== pid) {
    reasons.push(`publication ${newestPublished.publicationId} is published with a higher seq`);
  }
  return { row: reasons.length === 0 ? row : null, reasons };
}

/**
 * Whether a staged row could be repaired into a publication.
 *
 * **This is a proposal test, not the decision.** `lib/handoff-publish.js` holds
 * the authoritative rules (`_attemptRowState`, `_fileMismatch`) and re-runs all
 * of them against the live row and file inside the transaction that acts. What
 * this answers is only "is it worth nominating", from a context gathered before
 * anything could act on it — so a rule tightened on the applier side makes this
 * over-propose, which the applier then refuses, and never the reverse.
 *
 * The eligibility clause is the one that matters and the one most easily lost:
 * a staged row is only ever repairable when `eligible_at` was bound in the
 * lifecycle or checkpoint transaction, which is the sole durable proof that the
 * attempt that wrote those bytes actually completed. Session status is NOT an
 * input here — an attempt that staged and then died is not redeemed by a later
 * attempt wrapping the same session.
 *
 * @param {object} row - A `staged` publication row.
 * @param {object} ctx - Normalized context.
 * @param {string|null} observedDigest - Digest of the file backing this row.
 * @param {object|null} observedDoc - Parsed document backing this row.
 * @returns {boolean}
 */
function _repairable(row, ctx, observedDigest, observedDoc) {
  if (row.state !== 'staged') return false;
  if (!row.eligibleAt) return false;
  if (!observedDigest || observedDigest !== row.fileDigest) return false;
  if (!observedDoc) return false;
  if (observedDoc.publicationId !== row.publicationId) return false;
  if (observedDoc.kind !== row.kind) return false;
  const newestPublished = _newestPublished(ctx.publications);
  if (newestPublished && newestPublished.seq > row.seq) return false;
  return true;
}

/**
 * Every repair action a proposal may name.
 *
 * `publish` promotes a staged file that never became `current.json` — the crash
 * landed before the rename. `record-published` is its mirror: the rename DID
 * happen, and the database write that records it did not, so the bytes are
 * already current and only the row is behind. They are separate actions because
 * the applier has to read a different file for each, and an applier that guessed
 * would publish from whichever one happened to exist.
 * @type {readonly string[]}
 */
const REPAIR_ACTIONS = Object.freeze(['publish', 'record-published']);

/**
 * Every repair the store's state justifies, independent of which verdict wins.
 *
 * Both cases are one crash split by where it landed relative to a rename that
 * cannot join a SQL transaction:
 *
 * - the rename had NOT happened, so the bytes are still `staged-<pid>.json` and
 *   the row is `staged` → `publish`;
 * - the rename HAD happened, so the bytes are already `current.json` and only
 *   the row is behind → `record-published`.
 *
 * The second is the case the plan's reconciliation table names first, and it is
 * invisible to a scan that looks only in the staged files: after the rename
 * there is no staged file left to find.
 *
 * Neither is a decision to repair. Both are nominations, re-validated by
 * `applyHandoffRepairs` against the live row and the live file.
 *
 * @param {object} ctx - Normalized context.
 * @returns {Array<{action: string, publicationId: string, seq: number}>}
 */
function _proposeRepairs(ctx) {
  const proposals = [];
  const newestPublished = _newestPublished(ctx.publications);

  // The rename never happened: the bytes are still staged.
  for (const row of ctx.publications) {
    if (row.state !== 'staged') continue;
    if (newestPublished && row.seq <= newestPublished.seq) continue;
    const staged = ctx.stagedFiles.find((f) => f.publicationId === row.publicationId) || null;
    if (_repairable(row, ctx, staged && staged.digest, staged && staged.doc)) {
      proposals.push({ action: 'publish', publicationId: row.publicationId, seq: row.seq });
    }
  }

  // The rename happened and the row did not follow. `current.json` is validated
  // against the row exactly as a staged file would be — a promoted file earns no
  // weaker check for having already been moved.
  if (ctx.file.state === FILE_STATES.VALID && ctx.file.doc) {
    const row = ctx.publications.find((p) => p.publicationId === ctx.file.doc.publicationId);
    if (row && row.state === 'staged'
        && !proposals.some((p) => p.publicationId === row.publicationId)
        && _repairable(row, ctx, ctx.file.digest, ctx.file.doc)) {
      proposals.push({ action: 'record-published', publicationId: row.publicationId, seq: row.seq });
    }
  }
  return proposals;
}

/**
 * Normalize and defensively copy the caller's context.
 *
 * Everything optional gets a total default here, so no check below has to guard
 * a missing field. That is what lets this stay non-throwing without a `try`
 * wrapped around the decision: the decision cannot dereference something absent,
 * because nothing is absent by the time it runs.
 *
 * @param {object} raw - Caller-supplied context.
 * @returns {object} Normalized context.
 */
function _normalize(raw) {
  const ctx = raw || {};
  const file = ctx.file || {};
  const epoch = ctx.handoffEpoch || {};
  return {
    projectId: ctx.projectId,
    workspaceId: Object.prototype.hasOwnProperty.call(ctx, 'workspaceId') ? ctx.workspaceId : null,
    sessions: Array.isArray(ctx.sessions) ? ctx.sessions.filter((s) => s && Number.isFinite(s.id)) : [],
    publications: Array.isArray(ctx.publications) ? ctx.publications.filter(Boolean) : [],
    file: {
      state: file.state || FILE_STATES.ABSENT,
      doc: file.doc || null,
      digest: file.digest || null
    },
    stagedFiles: Array.isArray(ctx.stagedFiles) ? ctx.stagedFiles.filter(Boolean) : [],
    continuityIndexPresent: ctx.continuityIndexPresent === true,
    handoffEpoch: {
      epochSessionId: Number.isFinite(epoch.epochSessionId) ? epoch.epochSessionId : 0,
      baseline: epoch.baseline || BASELINES.EMPTY,
      baselineReason: epoch.baselineReason || null,
      // Carried to the exit rather than dropped here. A tri-state that survives
      // every hop but the last is not a tri-state: this one says the boundary
      // row is MISSING on a store that carries them, which is an integrity
      // condition an operator has to be told about — and the last hop, where it
      // looks like formatting, is exactly where such a field dies.
      present: epoch.present !== false
    },
    // `null` means "no worktree was recorded" (a non-git project). `toplevelExists:
    // false` means one was recorded and is gone. Collapsing the two would make a
    // project that never had a worktree indistinguishable from one whose worktree
    // vanished, which are opposite situations.
    worktreeProbe: ctx.worktreeProbe || null,
    fallbackRootHead: ctx.fallbackRootHead || null
  };
}

/**
 * Decide what the previous session left behind.
 *
 * @param {object} rawCtx - Everything the decision reads. See the module docblock.
 * @param {number} rawCtx.projectId - The launching project.
 * @param {string|null} [rawCtx.workspaceId] - Its workspace id, for the identity check.
 * @param {Array<{id: number, status: string}>} [rawCtx.sessions] - Prior sessions.
 * @param {object[]} [rawCtx.publications] - `handoff_publications` rows, camelCase.
 * @param {{state: string, doc: object|null, digest: string|null}} [rawCtx.file] - `current.json`.
 * @param {Array<{publicationId: string, digest: string, doc: object}>} [rawCtx.stagedFiles] - Staged files on disk.
 * @param {boolean} [rawCtx.continuityIndexPresent] - Whether a continuity index exists.
 * @param {{epochSessionId: number, baseline: string, baselineReason: string|null}} [rawCtx.handoffEpoch] - Migration boundary.
 * @param {{toplevelExists: boolean, headSha: string|null, branch: string|null}|null} [rawCtx.worktreeProbe] - Live state of the recorded worktree.
 * @param {string|null} [rawCtx.fallbackRootHead] - Registered root's HEAD, diagnosis only.
 * @returns {{verdict: string, reasons: string[], repairs: object[], evidence: object}}
 */
function runPreflight(rawCtx) {
  const ctx = _normalize(rawCtx);
  const newest = _newestSession(ctx.sessions);
  const hasPublications = ctx.publications.length > 0;
  const current = _resolveCurrentPublication(ctx);
  const evidence = {
    fileState: ctx.file.state,
    sessionCount: ctx.sessions.length,
    newestSessionId: newest ? newest.id : null,
    newestSessionStatus: newest ? newest.status : null,
    publicationCount: ctx.publications.length,
    currentPublicationId: current.row ? current.row.publicationId : null,
    baseline: ctx.handoffEpoch.baseline,
    epochSessionId: ctx.handoffEpoch.epochSessionId,
    epochPresent: ctx.handoffEpoch.present,
    continuityIndexPresent: ctx.continuityIndexPresent,
    // Diagnosis only. The registered root's HEAD is recorded so an operator can
    // see where the project actually sits, and it never promotes a verdict:
    // knowing some other tree is healthy says nothing about the one the handoff
    // named.
    fallbackRootHead: ctx.fallbackRootHead
  };

  // Proposals are computed BEFORE the verdict chain, not inside it.
  //
  // A repair describes the store, not the verdict — a caller holding one is
  // holding a fact about a staged attempt whatever word came back with it. When
  // the scan sat at row 6 it inherited the chain's early exits, so rows 1-5
  // returned `repairs: []`. Row 5 is the damaging one: a kept session whose
  // checkpoint was bound eligible and then crashed, or a session that wrapped
  // with an eligible-but-unpublished final followed by a crash, both land on
  // `crash-recovery` — and the completed attempt that would have recovered them
  // sat unpublished until some later publication's higher `seq` made it
  // permanently unrepairable.
  const repairs = _proposeRepairs(ctx);

  /**
   * Build a result, keeping the shape identical on every path.
   * @param {string} verdict - The verdict.
   * @param {string[]} reasons - Why.
   * @returns {object}
   */
  const decide = (verdict, reasons) => ({
    verdict,
    // A missing boundary row is said out loud on EVERY verdict, not only the one
    // that happens to print `baselineReason`. It is an integrity condition about
    // the store, so which word the chain landed on does not change whether the
    // operator needs to hear it.
    reasons: ctx.handoffEpoch.present === false
      ? [...reasons, `this project has no recorded handoff epoch (${ctx.handoffEpoch.baselineReason || 'reason unrecorded'}), so its boundary is unknown`]
      : reasons,
    repairs,
    evidence
  });

  // 1 — integrity, ahead of every exception. A file that cannot be trusted is
  // decided here so no first-launch or legacy branch can be reached past it.
  if (ctx.file.state === FILE_STATES.UNREADABLE || ctx.file.state === FILE_STATES.INVALID) {
    return decide(VERDICTS.HANDOFF_CORRUPT, [`current.json is ${ctx.file.state}`]);
  }

  const doc = ctx.file.state === FILE_STATES.VALID ? ctx.file.doc : null;

  // 2 — the handoff belongs to someone else. Checked before anything reads a
  // further field, so a foreign document is never interpreted as this project's.
  if (doc) {
    const mismatches = [];
    if (doc.projectId !== ctx.projectId) {
      mismatches.push(`handoff projectId ${doc.projectId} is not project ${ctx.projectId}`);
    }
    // Only compared when BOTH sides carry one: a handoff written before the
    // workspace id was resolvable records null, and refusing those would turn
    // old-but-sound handoffs into an identity incident.
    if (doc.workspaceId && ctx.workspaceId && doc.workspaceId !== ctx.workspaceId) {
      mismatches.push(`handoff workspaceId ${doc.workspaceId} is not ${ctx.workspaceId}`);
    }
    if (mismatches.length) return decide(VERDICTS.IDENTITY_MISMATCH, mismatches);
  }

  // 3 — a sound handoff for a project that has no history to have produced it.
  if (doc && ctx.sessions.length === 0 && !hasPublications) {
    return decide(VERDICTS.HANDOFF_UNEXPECTED,
      ['current.json is valid, but this project has no sessions and no publication rows']);
  }

  // 4 — first launch, an explicit exception rather than a fallthrough: all four
  // conditions, so a project that has lost its history cannot pass as new.
  if (ctx.sessions.length === 0 && !hasPublications
      && !ctx.continuityIndexPresent && ctx.file.state === FILE_STATES.ABSENT) {
    return decide(VERDICTS.FIRST_LAUNCH, ['no sessions, no publications, no continuity index, no handoff']);
  }

  // 5 — the newest session did not end on its own terms. A later session that
  // wrapped cleanly makes ITSELF the newest, so this only fires while the crash
  // is still the most recent thing that happened.
  if (newest && CRASHED_STATUSES.has(newest.status)) {
    return decide(VERDICTS.CRASH_RECOVERY,
      [`the newest session (${newest.id}) is ${newest.status}`]);
  }

  // 6 — an attempt got further than the published record, or a kept session's
  // checkpoint was never followed by an eligible final.
  const newestPublished = _newestPublished(ctx.publications);
  const aheadOfPublished = ctx.publications.some((p) => (p.state === 'staged' || p.state === 'abandoned')
    && (!newestPublished || p.seq > newestPublished.seq));
  if (aheadOfPublished) {
    // Unfinished whether or not a repair was proposed. §2.7 row 6 is evaluated
    // "after any validated repair", and this is the pass BEFORE one has run —
    // reporting ok here would let the launcher proceed and leave the proposal
    // nobody applied. `applyHandoffRepairs` acts, then preflight runs once more
    // and that pass sees a consistent record.
    return decide(VERDICTS.UNFINISHED, [repairs.length
      ? 'an attempt was staged past the newest published record; a repair is proposed'
      : 'an attempt was staged or abandoned past the newest published record, and cannot be repaired']);
  }
  if (newestPublished && newestPublished.kind === 'checkpoint') {
    const producer = ctx.sessions.find((s) => s.id === newestPublished.sessionId);
    if (producer && producer.status === 'wrapped') {
      const eligibleFinal = ctx.publications.some((p) => p.kind === 'final'
        && p.sessionId === producer.id && p.eligibleAt);
      if (!eligibleFinal) {
        return decide(VERDICTS.UNFINISHED,
          [`session ${producer.id} wrapped after a checkpoint but never published an eligible final`]);
      }
    }
  }

  const everyPriorPreEpoch = ctx.sessions.length > 0
    && ctx.sessions.every((s) => s.id <= ctx.handoffEpoch.epochSessionId);

  // 7 — legacy, the second explicit exception: a project whose whole history
  // predates handoffs and ended cleanly. Only a `clean` baseline qualifies.
  if (!hasPublications && everyPriorPreEpoch && ctx.file.state === FILE_STATES.ABSENT) {
    if (ctx.handoffEpoch.baseline === BASELINES.CLEAN) {
      return decide(VERDICTS.LEGACY,
        ['every session predates the handoff epoch and the baseline was recorded clean']);
    }
    // 8 — the same shape with a baseline that was not clean.
    if (ctx.handoffEpoch.baseline === BASELINES.UNCLEAN) {
      return decide(VERDICTS.LEGACY_UNCLEAN, [
        'every session predates the handoff epoch, but the baseline was recorded unclean',
        ctx.handoffEpoch.baselineReason || 'no baseline reason recorded'
      ]);
    }
  }

  // 9 — a session ran after handoffs existed and none was ever published.
  if (ctx.file.state === FILE_STATES.ABSENT && !hasPublications
      && ctx.sessions.some((s) => s.id > ctx.handoffEpoch.epochSessionId)) {
    return decide(VERDICTS.HANDOFF_NEVER_PUBLISHED,
      ['a session ran after the handoff epoch, and no publication was ever recorded']);
  }

  // 10 — the record says published; the file is gone.
  if (ctx.file.state === FILE_STATES.ABSENT && newestPublished) {
    return decide(VERDICTS.HANDOFF_MISSING,
      [`publication ${newestPublished.publicationId} is published, but current.json is absent`]);
  }

  // 11 — the file and the rows disagree in a way no repair may cross.
  if (doc && !current.row) {
    return decide(VERDICTS.HANDOFF_UNCONFIRMED, current.reasons);
  }

  // 12 — a sound handoff, overtaken by a later session that wrapped without
  // publishing one of its own. A crash is already row 5.
  if (current.row && newest && newest.id > current.row.sessionId) {
    return decide(VERDICTS.HANDOFF_BEHIND, [
      `session ${newest.id} is newer than the handoff's session ${current.row.sessionId}`,
      `session ${newest.id} is ${newest.status} and published no eligible handoff`
    ]);
  }

  // 13/14 — the workspace moved under an otherwise sound handoff. Only reached
  // with a current publication, so the document itself is trustworthy; what is
  // in question is the tree it describes.
  if (current.row) {
    const recorded = doc.worktree || null;
    if (recorded) {
      const probe = ctx.worktreeProbe;
      if (!probe || probe.toplevelExists === false) {
        // `dirty` is three-valued at the producer and stays three-valued here.
        // `handoff-stage.js#_worktreeFacts` records null when it could not
        // establish the state, deliberately: "we did not find out" is not
        // "there is nothing uncommitted". Flattening it with `=== true` told an
        // operator the tree was clean when nobody had measured it, and withheld
        // recovery on that basis.
        evidence.worktreeDirty = recorded.dirty === true ? true
          : recorded.dirty === false ? false
            : null;
        return decide(VERDICTS.WORKSPACE_UNAVAILABLE, [
          `the recorded worktree ${recorded.toplevel} no longer exists`,
          evidence.worktreeDirty === true
            ? 'it had uncommitted work when the handoff was written'
            : evidence.worktreeDirty === false
              ? 'it was clean when the handoff was written'
              : 'whether it had uncommitted work could not be measured when the handoff was written'
        ]);
      }
      // THREE outcomes, not two, and the asymmetry is deliberate.
      //
      // A recorded head the probe could not read is STALE and already was:
      // `recorded` is evidence, the probe is not, and the mismatch is real even
      // though one side is missing. That case is preserved exactly.
      //
      // NEITHER side readable is different. `null !== null` is false, so an
      // unmeasured pair would read as "the head did not move" and satisfy a
      // precondition of `ok` — a worktree nobody verified, reported as
      // verified. A failed measurement answers null on either side, so this is
      // reachable whenever git cannot be read at wrap or at launch.
      const movedHead = !!recorded.headSha && probe.headSha !== recorded.headSha;
      const movedBranch = !!recorded.branch && !!probe.branch && probe.branch !== recorded.branch;
      // Both absent: nothing was compared. Not a mismatch to report here —
      // collected below, where `ok` states its preconditions positively, so
      // the failure names which one was missing rather than being silent.
      if (!recorded.headSha && !probe.headSha) {
        evidence.worktreeHeadUnverified = true;
      }
      if (movedHead || movedBranch) {
        return decide(VERDICTS.STALE, [
          // "could not read HEAD" and "HEAD moved" are different facts, and this
          // sentence reaches the agent through step 3. The verdict is the same
          // either way — an unverifiable worktree is not a verified one — but
          // reporting an unread probe as `HEAD is null` states a reading nobody
          // took, which is the one conflation this subsystem avoids everywhere
          // else (`unreadable` vs `invalid`, `evaluationFailed`).
          movedHead
            ? (probe.headSha === null
              ? `the recorded worktree's HEAD could not be read; the handoff recorded ${recorded.headSha}`
              : `HEAD is ${probe.headSha}, the handoff recorded ${recorded.headSha}`)
            : null,
          movedBranch ? `branch is ${probe.branch}, the handoff recorded ${recorded.branch}` : null
        ].filter(Boolean));
      }
    } else {
      // Recorded as a non-git project. 13 and 14 have nothing to check, and 15
      // accepts that only because the skip is written down here.
      evidence.worktreeChecks = 'skipped: no-git';
    }
  }

  // 15 — ok, stated positively. Every clause is required and each failure is
  // collected rather than short-circuited, so the `unclassified` below can say
  // which one was missing.
  const okFailures = [];
  // A worktree neither end could establish is not a verified worktree. Stated
  // here, among `ok`'s other positive preconditions, so an unclassified verdict
  // can name it as the clause that failed.
  if (evidence.worktreeHeadUnverified) {
    okFailures.push('neither the handoff nor this launch could read the worktree\'s HEAD, so it is unverified');
  }
  if (!current.row) okFailures.push(...current.reasons);
  if (current.row && !newest) okFailures.push('a publication exists but the project has no sessions');
  if (current.row && newest && current.row.sessionId !== newest.id) {
    okFailures.push(`the handoff's session ${current.row.sessionId} is not the newest session ${newest.id}`);
  }
  if (current.row && newest && current.row.sessionId === newest.id) {
    // A final proves the session finished. A checkpoint is only good while its
    // session is STILL kept: once that session is gone, a checkpoint with no
    // final is an unfinished story, not a handoff.
    const finalWrapped = current.row.kind === 'final' && newest.status === 'wrapped';
    const keptCheckpoint = current.row.kind === 'checkpoint' && newest.status === 'active';
    if (!finalWrapped && !keptCheckpoint) {
      okFailures.push(`a ${current.row.kind} publication does not match session status ${newest.status}`);
    }
  }
  if (okFailures.length === 0 && current.row) {
    return decide(VERDICTS.OK, ['a current eligible publication from the newest session']);
  }

  // 16 — nothing matched. Recovery, carrying every predicate that failed.
  return decide(VERDICTS.UNCLASSIFIED, okFailures.length ? okFailures : ['no check matched this state']);
}

module.exports = {
  runPreflight,
  REPAIR_ACTIONS,
  needsRecovery,
  needsReconciliation,
  FILE_STATES,
  BASELINES,
  VERDICTS,
  RECOVERY_VERDICTS,
  RECONCILIATION_VERDICTS
};
