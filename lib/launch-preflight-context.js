'use strict';

/**
 * Gathering what the launch preflight decides from, and running it (Train 21,
 * #1586).
 *
 * `lib/launch-preflight.js` is pure on purpose: it never reads the store, never
 * touches the filesystem, and never throws. That purity has to be paid for
 * somewhere, and this is where — every read against the database, the handoff
 * directory and git happens here, and the decision itself gets a plain object.
 *
 * **Nothing here throws to the launcher.** This runs on the launch path before
 * anything is rendered. A failure to gather the context, or to probe a worktree,
 * degrades the verdict to one that says so; it never takes down the launch it
 * exists to protect. The caller gets a verdict either way, and
 * `evaluationFailed` tells "checked, and this is the answer" apart from "could
 * not check" — the same honesty the `not-evaluated` verdict keeps.
 *
 * **Not taking down the launch is not the same as clearing it.** A degraded
 * verdict REQUIRES RECOVERY (#1650): failing to establish current continuity is
 * not evidence that continuity is sound, so the pane stays up for diagnosis
 * while the task step and READY stay gated under the configured recovery mode.
 *
 * **One repair pass, then one re-run.** Detection is pure and writes nothing, so
 * a proposal it returns has to be acted on separately and the decision retaken
 * against what that left. The re-run happens exactly once: a loop here would be
 * a launch that retries a repair forever.
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const { createLogger } = require('./logger');
const { wasTimedOut } = require('./exec-timeout');
const store = require('./store');
const continuity = require('./continuity');
const lockfile = require('./handoff-lockfile');
const { runPreflight, needsRecovery, needsReconciliation, VERDICTS, FILE_STATES } = require('./launch-preflight');
const { applyHandoffRepairs } = require('./handoff-publish');
const { digestOf, resumeState, normalizeResume } = require('./handoff-publication');

const log = createLogger('launch-preflight-context');

/** Bound on each git probe. A launch waits on these, so they stay short. */
const PROBE_TIMEOUT_MS = 5 * 1000;

/**
 * How many of a project's sessions are read.
 *
 * This is a diagnostic breadth, not a correctness threshold, and it is worth
 * knowing why before anyone tunes it. The decision reads the session list for
 * three things: the newest session, whether any session ran after the handoff
 * epoch, and the session that produced the newest published attempt. The list is
 * ordered newest-first, so the first two are answered correctly by any slice —
 * truncation can only drop LOWER ids, and both of those questions are about the
 * high end. The third is answered by `_withPublicationProducers` below, which
 * fetches producing sessions by id whatever the slice contained. So a project
 * with more sessions than this still gets the same verdict; it just carries
 * fewer of them in `evidence.sessionCount`.
 */
const SESSION_WINDOW = 200;

/**
 * How many of a project's publication rows are read.
 *
 * Bounded for the same reason and safe for the same one: the rows come back
 * newest-`seq` first, and every question the decision asks of them — which is
 * the newest published, is anything staged ahead of it, does `current.json`
 * name a row it holds — is about the high end. A separate constant from
 * `SESSION_WINDOW` because they bound different things; one number serving both
 * reads as a coincidence the next person has to check.
 */
const PUBLICATION_WINDOW = 200;

/**
 * How `readHandoffFile`'s outcomes map to the file states the decision names.
 *
 * `corrupt` splits into `invalid` rather than `unreadable`: the bytes were read
 * fine, and it is the document that this build does not understand. The two need
 * different words in front of an operator, so they are kept apart all the way
 * from the read to the verdict.
 */
const FILE_STATE_BY_OUTCOME = Object.freeze({
  absent: FILE_STATES.ABSENT,
  unreadable: FILE_STATES.UNREADABLE,
  corrupt: FILE_STATES.INVALID,
  ok: FILE_STATES.VALID
});

/**
 * Run one git probe and return its trimmed stdout, or null with a logged reason.
 * @param {string} cwd - Directory to run in
 * @param {string[]} args - Argv after `git`
 * @param {Function} exec - `execFileSync` replacement, for tests
 * @returns {string|null}
 */
function _probe(cwd, args, exec) {
  try {
    return String(exec('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    })).trim();
  } catch (err) {
    if (wasTimedOut(err)) {
      log.warn('Preflight git probe was stopped before it answered', {
        cwd, command: `git ${args.join(' ')}`, timeoutMs: PROBE_TIMEOUT_MS
      });
    } else {
      log.debug('Preflight git probe did not answer', { cwd, command: `git ${args.join(' ')}`, error: err.message });
    }
    return null;
  }
}

/**
 * The live state of a worktree a handoff recorded.
 *
 * `null` and a probe that answers are different facts and stay different:
 * `null` means no worktree was recorded (a non-git project, which the decision
 * records as a skip), while `toplevelExists: false` means one was recorded and
 * is gone. Collapsing them would make a project that never had a worktree
 * indistinguishable from one whose worktree vanished.
 *
 * A probe that fails on a directory that DOES exist reports `headSha: null`,
 * which the decision reads as "not the recorded sha" — conservative, and the
 * right direction: an unverifiable worktree is not a verified one.
 *
 * @param {{toplevel: string}|null|undefined} worktree - The handoff's worktree facts
 * @param {Function} [exec] - `execFileSync` replacement, for tests
 * @returns {{toplevelExists: boolean, headSha: string|null, branch: string|null}|null}
 */
function probeWorktree(worktree, exec = execFileSync) {
  if (!worktree || typeof worktree.toplevel !== 'string' || !worktree.toplevel) return null;
  if (!fs.existsSync(worktree.toplevel)) {
    return { toplevelExists: false, headSha: null, branch: null };
  }
  const headSha = _probe(worktree.toplevel, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], exec);
  const branch = _probe(worktree.toplevel, ['rev-parse', '--abbrev-ref', 'HEAD'], exec);
  return {
    toplevelExists: true,
    headSha: headSha || null,
    branch: branch || null
  };
}

/**
 * Add any session that produced a publication but fell outside the window.
 *
 * Check 6's checkpoint branch looks up the session that published a checkpoint,
 * and that session can be arbitrarily old on a project with a long history. A
 * lookup that missed it would not report an error — the branch would simply not
 * fire, and an unfinished handoff would read as something else. So the producers
 * are fetched by id rather than hoped for.
 *
 * @param {Array<{id: number, status: string}>} sessions - The window, newest first
 * @param {object[]} publications - The project's publication rows
 * @returns {Array<{id: number, status: string}>}
 */
function _withPublicationProducers(sessions, publications) {
  const have = new Set(sessions.map((s) => s.id));
  const out = [...sessions];
  for (const row of publications) {
    if (!Number.isFinite(row.sessionId) || have.has(row.sessionId)) continue;
    have.add(row.sessionId);
    const session = store.sessions.get(row.sessionId);
    // A publication whose session row is gone is left out rather than invented.
    // The decision treats an absent producer as "cannot confirm", which is what
    // it is.
    if (session) out.push({ id: session.id, status: session.status });
  }
  return out;
}

/**
 * Gather everything `runPreflight` reads for one project.
 *
 * @param {object} project - Project record (`id`, `path`, `name`)
 * @param {object} [options]
 * @param {string|null} [options.workspaceId] - The launching workspace, for the identity check
 * @param {Function} [options.exec] - `execFileSync` replacement, for tests
 * @returns {object} A context for `runPreflight`
 */
function buildContext(project, options = {}) {
  const exec = options.exec || execFileSync;
  const publications = store.handoffs.listByProject(project.id, PUBLICATION_WINDOW);
  const sessions = _withPublicationProducers(
    store.sessions.list(project.id, { limit: SESSION_WINDOW }).map((s) => ({ id: s.id, status: s.status })),
    publications
  );

  const observed = lockfile.observe(project);
  const current = observed.current;
  // Only the staged files the record knows about are offered. A staged file with
  // no row is not evidence of an attempt — the row is what an attempt IS — and
  // reading it in would let a file on disk nominate itself.
  const knownStaged = new Set(publications.map((p) => p.publicationId));
  const stagedFiles = [];
  for (const publicationId of observed.staged) {
    if (!knownStaged.has(publicationId)) continue;
    const read = lockfile.readHandoffFile(lockfile.stagedPath(project, publicationId));
    if (read.outcome !== 'ok') continue;
    stagedFiles.push({ publicationId, digest: read.digest, doc: read.doc });
  }

  const currentDoc = current.outcome === 'ok' ? current.doc : null;
  const worktreeProbe = probeWorktree(currentDoc && currentDoc.worktree, exec);
  return {
    projectId: project.id,
    workspaceId: options.workspaceId === undefined ? null : options.workspaceId,
    sessions,
    publications,
    file: {
      state: FILE_STATE_BY_OUTCOME[current.outcome] || FILE_STATES.UNREADABLE,
      doc: currentDoc,
      digest: current.digest || null,
      // `readDocument` names WHY a file is not a handoff, and that reason died
      // here: the operator sent to recovery was told only that current.json is
      // invalid, which says nothing about what to look at. Carried so the
      // verdict can state it — for every reason the reader produces, not just
      // the newest ones.
      reason: current.reason || null
    },
    stagedFiles,
    continuityIndexPresent: Boolean(project.path)
      && fs.existsSync(continuity.indexPath(project.path)),
    handoffEpoch: store.handoffEpoch.readBoundary(project.id),
    worktreeProbe,
    // Diagnosis only, and taken on exactly the condition that makes it useful:
    // a worktree was recorded and is gone, so the operator is about to be told
    // `workspace-unavailable` and has nowhere to look. This answers "where does
    // this project actually sit now". It never promotes a verdict — knowing some
    // other tree is healthy says nothing about the one the handoff named — and
    // it is not taken otherwise, because a probe nobody will read is a git call
    // on every launch for nothing.
    fallbackRootHead: worktreeProbe && worktreeProbe.toplevelExists === false && project.path
      ? _probe(project.path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], exec)
      : null
  };
}

/**
 * The resume the next launch renders, taken from the publication the verdict
 * read (#1675), with the facts its provenance line states.
 *
 * The same `current.json` the verdict was decided on, never a second read of
 * it: a Resume drawn from a different document than the one certified is the
 * defect this exists to close. Null when there is no readable publication, so
 * the caller falls back to an unbound source and labels it.
 *
 * A document from before the `resume` block carries a next action and a hash of
 * the continuity index as it stood at staging. The index's "where we are" and
 * freshness stamp are shown for such a document only when the index still
 * hashes to that value — otherwise a later run has rewritten it, and its text
 * describes some other attempt.
 *
 * @param {object} project - Project record
 * @param {object} ctx - The context the verdict was decided on
 * @param {{verdict: string, evidence: object}} result - The verdict
 * @returns {object|null}
 */
function _handoffResume(project, ctx, result) {
  const doc = ctx.file && ctx.file.doc;
  if (!doc) return null;
  const evidence = result.evidence || {};
  const newer = evidence.newestSessionId != null && evidence.newestSessionId !== doc.sessionId
    ? { id: evidence.newestSessionId, status: evidence.newestSessionStatus || null }
    : null;
  const base = {
    publicationId: doc.publicationId,
    digest: ctx.file.digest || null,
    kind: doc.kind,
    sessionId: doc.sessionId,
    stagedAt: doc.stagedAt || null,
    verdict: result.verdict,
    newerSession: newer
  };
  const fromDoc = (note) => ({ ...base, resume: _nextActionOnly(doc), note });
  switch (resumeState(doc)) {
    case 'valid':
      return { ...base, resume: normalizeResume(doc.resume), note: null };
    case 'none':
      return fromDoc('this wrap recorded no resume, because its continuity step did not write one; only the next action it captured is shown');
    case 'malformed':
      log.warn('A handoff publication carries a malformed resume block; the launch shows only its next action', {
        project: project && project.name, publicationId: doc.publicationId
      });
      return fromDoc('its resume block is malformed, so only the next action it captured is shown');
    default:
      return _legacyResume(project, doc, base);
  }
}

/**
 * A resume holding only the document's own next action, through the one
 * normalizer. A next action that is not text is shown as none rather than
 * trusted: these are bytes some other producer may have written.
 * @param {object} doc - The publication
 * @returns {object}
 */
function _nextActionOnly(doc) {
  try {
    return normalizeResume({ nextAction: doc.nextAction ?? null });
  } catch {
    return normalizeResume({});
  }
}

/**
 * The resume for a publication that predates the `resume` block (#1675).
 * @param {object} project - Project record
 * @param {object} doc - The publication
 * @param {object} base - Its provenance fields
 * @returns {object}
 */
function _legacyResume(project, doc, base) {
  let text = null;
  try {
    text = fs.readFileSync(continuity.indexPath(project.path), 'utf8');
  } catch {
    text = null;
  }
  const matches = text !== null && doc.continuityIndexHash && digestOf(text) === doc.continuityIndexHash;
  if (!matches) {
    return {
      ...base,
      resume: _nextActionOnly(doc),
      note: text === null
        ? 'this publication predates recorded resumes and the continuity index is gone, so only its next action is shown'
        : 'this publication predates recorded resumes and the continuity index has changed since it was written, so only its next action is shown'
    };
  }
  const parsed = continuity.parseIndex(text);
  const own = _nextActionOnly(doc).nextAction;
  return {
    ...base,
    resume: normalizeResume({
      currentState: parsed.currentState,
      // The document's own next action wins over the index's: it is the
      // frozen one, and the two came from the same capture.
      nextAction: own || parsed.nextAction,
      freshness: parsed.freshness
    }),
    note: null
  };
}

/**
 * Decide what the previous session left behind, repairing once if the decision
 * proposes it.
 *
 * @param {object} project - Project record
 * @param {object} [options]
 * @param {string|null} [options.workspaceId] - The launching workspace
 * @param {Function} [options.exec] - `execFileSync` replacement, for tests
 * @returns {{verdict: string, reason: string, reasons: string[], evidence: object, requiresRecovery: boolean, requiresReconciliation: boolean, handoffResume: (object|null), repairOutcomes: object[], repaired: boolean, evaluationFailed: boolean, evaluationMissing: boolean}}
 *   `handoffResume` (#1675) is the resume drawn from the same publication the
 *   verdict read, with its provenance; null when there is no readable one.
 *   `evaluationFailed` means the evaluation was attempted and threw — a server
 *   log on this machine names it, and the result requires recovery.
 *   `evaluationMissing` is always false here, because reaching this function IS
 *   the attempt. It belongs to a caller that has no usable result — which is
 *   not the same as knowing none was produced.
 */
function evaluate(project, options = {}) {
  try {
    // Reassigned by a repair, never shadowed: a repair can rename a staged file
    // over `current.json`, so the context the verdict was decided on is the only
    // one whose document matches that verdict. Reading the pre-repair context
    // afterwards would hand car 21.10 the manifest of a document the repair
    // just replaced.
    let ctx = buildContext(project, options);
    let result = runPreflight(ctx);
    let repairOutcomes = [];
    let repaired = false;

    if (result.repairs.length > 0) {
      const applied = applyHandoffRepairs(project, result.repairs);
      repairOutcomes = applied.outcomes;
      repaired = applied.appliedCount > 0;
      if (repaired) {
        // Exactly one re-run. The record moved, so the first decision is now
        // about a state that no longer exists — but a second repair pass would
        // be a launch retrying itself, and the decision is the same shape
        // whatever this pass says.
        ctx = buildContext(project, options);
        result = runPreflight(ctx);
      }
    }

    const answer = {
      verdict: result.verdict,
      reason: result.reasons.length ? result.reasons.join('; ') : 'no reason was recorded',
      reasons: result.reasons,
      evidence: result.evidence,
      // Both halves of the model are answered here, so a caller never has to
      // know which of the engine's two predicates applies to what it was handed.
      // `requiresRecovery` is what the launch record freezes and the step-4 and
      // READY gates read; it is answered here rather than recomputed, because it
      // is not a function of the verdict alone (`needsRecovery` reads
      // `evidence.worktreeDirty` for `workspace-unavailable`).
      requiresRecovery: needsRecovery(result),
      requiresReconciliation: needsReconciliation(result),
      // The governing-text manifest the previous session froze, handed up so
      // the launch can diff it against the rules in force now (car 21.10). It
      // rides the preflight answer because the preflight is what already read
      // `current.json`; a second read would be a second chance to disagree
      // with the verdict about which document is current. `null` when there is
      // no readable current document — a first launch, or a corrupt file the
      // verdict already names.
      handoffManifest: ctx.file && ctx.file.doc
        ? { rules: ctx.file.doc.rules || [], manifestSources: ctx.file.doc.manifestSources }
        : null,
      // WHY there is no manifest, when there is a reason worth telling the
      // session. A project that has never wrapped has nothing to say and gets
      // null; a document that exists and could not be read is a failed
      // measurement, and a launch that renders the same blank for both lets a
      // corrupt handoff read exactly like a clean slate.
      // #1738 — whether the previous session's engine could run the project's
      // methodology, from the same document the verdict read. Null when the
      // document has no block (a producer that predates it) or there is none.
      handoffMethodology: ctx.file && ctx.file.doc && ctx.file.doc.methodology
        ? { disposition: ctx.file.doc.methodology.disposition, engineId: ctx.file.doc.methodology.engineId ?? null }
        : null,
      // #1675 — the resume the launch renders, from this same document, with
      // the provenance its first line states. Null when there is none to read.
      handoffResume: _handoffResume(project, ctx, result),
      handoffManifestUnavailable: ctx.file && !ctx.file.doc && ctx.file.state
        && ctx.file.state !== FILE_STATES.ABSENT
        ? `the previous session's handoff could not be read (${ctx.file.state}), so the rules it was written under are unknown`
        : null,
      repairOutcomes,
      repaired,
      evaluationFailed: false,
      evaluationMissing: false
    };
    // Every launch says what it decided, because step 3 is not a channel that
    // always exists: an engine that declares no launch sequence, or any launch
    // whose steps could not be rendered, would otherwise record
    // `handoff-corrupt` or `crash-recovery` into the launch row and tell nobody.
    // The LEVEL is the verdict's: a recovery-class answer is the operator's
    // problem to see, the rest is a record.
    const line = 'Launch preflight verdict';
    const evidence = answer.evidence || {};
    const fields = {
      project: project && project.name,
      verdict: answer.verdict,
      reason: answer.reason,
      repaired,
      // The diagnosis reaches a reader here or nowhere. `fallbackRootHead` is a
      // git subprocess taken specifically so an operator handed
      // `workspace-unavailable` can see where the project actually sits, and it
      // is dropped from the stored launch record as launch-time diagnosis — so
      // this line is its only destination. Same for the epoch's absence, which
      // is an integrity condition about the store rather than about this launch.
      fallbackRootHead: evidence.fallbackRootHead || null,
      worktreeDirty: evidence.worktreeDirty === undefined ? null : evidence.worktreeDirty,
      epochPresent: evidence.epochPresent !== false,
      repairsProposed: repairOutcomes.length
    };
    if (answer.requiresRecovery) log.warn(line, fields);
    else log.info(line, fields);
    return answer;
  // prawduct:allow prawduct/broad-except -- a launch must never fail because the preflight could not gather its context
  } catch (err) {
    log.warn('Launch preflight could not be evaluated — this launch owes recovery before it can attest READY', {
      project: project && project.name, error: err.message
    });
    return {
      verdict: VERDICTS.NOT_EVALUATED,
      reason: `the previous session's handoff could not be checked (${err.message})`,
      reasons: [],
      evidence: {},
      // The evaluation was ATTEMPTED and failed, so recovery is owed. Failing
      // to establish current continuity is not evidence that continuity is
      // sound, and answering `false` here is how a launch that checked nothing
      // reached an ungated READY. Reconciliation stays false deliberately: a
      // reconciliation cannot clear operator-mode recovery, and demanding one
      // here would describe a gate the launch is not standing at.
      requiresRecovery: true,
      requiresReconciliation: false,
      // Same reasoning: a gather that failed read no document, so it has no
      // manifest to offer and must not let a caller infer one. It DID try,
      // though, so it says so rather than reading as a project with no handoff.
      handoffManifest: null,
      handoffMethodology: null,
      handoffResume: null,
      handoffManifestUnavailable: 'the previous session\'s handoff could not be checked, so the rules it was written under are unknown',
      repairOutcomes: [],
      repaired: false,
      // A POSITIVELY OBSERVED failure: called, and it threw. Kept distinct from
      // `evaluationMissing`, which says only that no usable result is available
      // and cannot tell a lost result from one never produced. This flag is the
      // stronger claim and is only ever set where the failure was witnessed —
      // here, in the catch. Neither satisfies a required successful check.
      evaluationFailed: true,
      evaluationMissing: false
    };
  }
}

module.exports = {
  buildContext,
  evaluate,
  _handoffResume,
  probeWorktree,
  SESSION_WINDOW,
  PUBLICATION_WINDOW,
  PROBE_TIMEOUT_MS,
  FILE_STATE_BY_OUTCOME
};
