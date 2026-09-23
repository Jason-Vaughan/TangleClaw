'use strict';

/**
 * `handoff-stage` wrap step (Train 21, #1585) — stages this wrap attempt's
 * `tc.handoff/1` document.
 *
 * Runs **last**, after `apply-pr-resolutions`, because the document records
 * what the wrap achieved: staged any earlier and it would describe a wrap that
 * had not finished happening.
 *
 * **Never a blocker.** A wrap that produced real work must not fail because the
 * handoff could not be written — the failure is recorded in the wrap result and
 * preflight reports the absent publication later. This is wrap-direction §3: a
 * gate blocks only where failure would otherwise be silent or destructive, and
 * this failure is neither.
 *
 * **Staging is not publishing.** This step writes bytes and a `staged` row and
 * stops. The attempt becomes eligible only when the lifecycle transition (or
 * `markCheckpointComplete`) binds it, and becomes current only when the wrap
 * finalizes it. An attempt that dies here is simply never published.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../store');
const engines = require('../engines');
const continuity = require('../continuity');
const git = require('../git');
const medusaRegistry = require('../medusa-registry');
const launchSequence = require('../launch-sequence');
const { configRootOf } = require('./_config-root');
const { createLogger } = require('../logger');
const lockfile = require('../handoff-lockfile');
const { newPublicationId, buildHandoffDocument } = require('../handoff-publication');

const log = createLogger('wrap-step-handoff-stage');

/**
 * Statuses that mean a step produced the evidence it exists to produce.
 *
 * `done` is success. `skipped` is a step that correctly did not apply (no PRs
 * open, no lint configured) — it withheld no evidence, so naming it would make
 * every ordinary wrap read as degraded. `not-applicable` is the same answer
 * stated outright: the step has no subject in this project (#1738).
 *
 * `capability-unavailable` is deliberately absent. The step applied and its
 * evidence was never produced, because the session's engine could not produce
 * it; counting that as produced is the false green #1738 exists to end.
 * @type {string[]}
 */
const EVIDENCE_PRODUCED = ['done', 'skipped', 'not-applicable'];

/**
 * Whether a result is a skip that says it measured nothing.
 *
 * A step marks this with `output.measured === false` (preflight does, for a hook
 * that could not be found, was killed, broke its contract, or was passed over by
 * the operator). Such a skip withheld the step's evidence as surely as a
 * failure did, so it cannot stand in the produced column.
 * @param {object} r - A step result
 * @returns {boolean}
 */
function _unmeasuredSkip(r) {
  return r.status === 'skipped' && Boolean(r.output) && r.output.measured === false;
}

/**
 * Every step that did not produce its evidence, named — the document's
 * `missingEvidence`.
 *
 * **Reads `status`, never `ok`.** The runner records
 * `{stepId, kind, status, output, blockers}` and no `ok` field
 * (`lib/wrap-pipeline.js`, `const recorded`), so a filter on `r.ok !== true`
 * matches every row including the successful ones — which made `complete`
 * unreachable and had every real wrap naming ~17 healthy steps as missing.
 *
 * Named rather than counted: "3 steps degraded" tells the next session nothing
 * it can act on.
 * @param {object[]} previousResults - Prior step results, in the runner's shape
 * @returns {string[]} `"<stepId>: <status>"` for each step that fell short
 */
function _missingEvidence(previousResults) {
  return (previousResults || [])
    .filter((r) => r && (!EVIDENCE_PRODUCED.includes(r.status) || _unmeasuredSkip(r)))
    .map((r) => `${r.stepId || 'step'}: ${_unmeasuredSkip(r) ? 'skipped (not measured)' : (r.status || 'no status')}`);
}

/**
 * The methodology disposition the handoff records (#1738), so the next launch
 * can tell a session that ran its gates from one whose engine could not.
 *
 * - `capability-unavailable` / `not-applicable` — straight from the capability
 *   the run resolved once.
 * - `measured` — the engine could run it and the preflight row says it measured
 *   (clear or blocked, either is a measurement).
 * - `unmeasured` — the engine could run it and nothing measured: the hook was
 *   missing or failed, the operator passed over it, or the step was disabled.
 *
 * @param {object|null} methodology - The run's resolved capability
 * @param {object[]} previousResults - Prior step results
 * @returns {{disposition: string, engineId: (string|null)}|null} Null when the
 *   run resolved no capability (a direct call outside the runner)
 */
function _methodologyRecord(methodology, previousResults) {
  if (!methodology) return null;
  const base = { engineId: methodology.engineId || null };
  if (methodology.disposition !== 'available') return { ...base, disposition: methodology.disposition };
  const preflight = (previousResults || []).find((r) => r && r.kind === 'preflight');
  const measured = Boolean(preflight && preflight.output && preflight.output.measured === true);
  return { ...base, disposition: measured ? 'measured' : 'unmeasured' };
}

/**
 * The next steps a prior `ai-content` step captured, if any.
 *
 * The captured field is `nextSteps` — the spelling the step's own
 * `captureFields` declares (`lib/wrap-default-pipeline.js`). An earlier
 * `nextAction` here matched nothing and silently recorded null on every wrap.
 * @param {object[]} previousResults - Prior step results
 * @returns {string|null}
 */
function _nextAction(previousResults) {
  for (const result of previousResults || []) {
    const fields = result && result.output && result.output.parsedFields;
    if (fields && typeof fields.nextSteps === 'string' && fields.nextSteps.trim()) {
      return fields.nextSteps.trim();
    }
  }
  return null;
}


/**
 * The git facts the handoff records, built from the scope the runner resolved.
 *
 * `null` means "this root is not a git repository", which is what `tc.handoff/1`
 * defines it to mean — so it is returned only when the scope says the work tree
 * has no git identity, never as a stand-in for a key that was read wrong. The
 * bytes are frozen at staging, so a wrong answer here can never be repaired.
 *
 * **A null here is only half the answer, and `_worktreeProblem` carries the
 * other half.** `wrap-scope` reports a work tree it could not read the same way
 * it reports one that is genuinely not a repository — `workToplevel` is null in
 * both — so this returns null for both and the document says which through its
 * sibling `worktreeProblem` field. Alone, the null asserts the project has no
 * worktree, which is the single most reassuring thing a frozen document can
 * say: it disables the launch's two workspace checks and is a precondition of
 * `ok`. A probe that timed out would have frozen that assertion about a tree
 * nobody measured.
 *
 * **It takes the scope and nothing else.** It used to take the wrap's commit
 * sha as well, to prefer as the head. That is a second source for a field whose
 * entire contract is "one tree, one moment", and the two disagree whenever the
 * wrap auto-branches off a protected branch: the commit lands on the wrap
 * branch and the original branch is checked back out, so the sha and the branch
 * describe different refs. One reader, one reading.
 *
 * @param {object|null} scope - `lib/wrap-scope.js` scope for this run
 * @returns {object|null} Worktree facts, or null for a non-git root
 */
function _worktreeFacts(scope) {
  if (!scope || !scope.workTree || !scope.workToplevel) return null;

  // `dirty` is measured HERE, against the tree as the handoff is written.
  // The scope's baseline describes the tree the session LAUNCHED in, and
  // §2.7 keys a recovery verdict on this field: a session that launched clean
  // and ends dirty would otherwise be told no recovery is needed.
  //
  // `fresh` is what makes that sentence true. `git.getInfo` serves a reading
  // up to its TTL old, and a kept session stages more than one handoff — a
  // checkpoint, another checkpoint, a final — well inside that window, so the
  // later documents would each freeze the FIRST attempt's dirtiness and be
  // read afterwards as a measurement of their own.
  //
  // `git.getInfo` answers `null` when it could not establish the state, and
  // that null is carried through rather than flattened to `false` — "we did
  // not find out" is not "there is nothing uncommitted".
  // ONE reading, for all three tree facts. The preflight reads them as a single
  // snapshot of one tree at one moment, so anything sourced from a different
  // moment — the scope's trunk branch, probed before the commit step; the
  // baseline sha, taken at launch — lets the document name a branch that does
  // not contain the sha beside it. A launch then computes `movedHead` and
  // refuses READY on a sound handoff.
  //
  // `null` is carried through rather than flattened: "we did not find out" is
  // not "there is nothing uncommitted", and it is not "the tree is at no
  // commit" either.
  let dirty = null;
  let branch = null;
  let headSha = null;
  let unestablished = null;
  let readFailure = null;
  try {
    const info = git.getInfo(scope.workTree, { fresh: true });
    if (info) {
      // What the reading could NOT establish, carried into the frozen bytes.
      // Without it the consumer sees a null and cannot tell "this tree has no
      // commits" from "git could not be read" — and the document is frozen, so
      // it can never find out afterwards.
      unestablished = Array.isArray(info.incomplete) && info.incomplete.length > 0
        ? [...info.incomplete] : null;
      readFailure = info.cause || null;
      dirty = info.dirty;
      // `measuredBranch`, not `info.branch || null`: `getInfo` answers the
      // truthy sentinels `'unknown'` (status unread/unparseable) and `'HEAD'`
      // (detached), and freezing either as a branch name puts a word that is
      // not a branch into a document a launch will refuse READY over — with no
      // way to repair it, because the bytes are frozen at staging.
      branch = git.measuredBranch(info);
      headSha = info.headSha || null;
    }
  } catch (err) {
    log.warn('Could not measure the work tree for the handoff', {
      workTree: scope.workTree, error: err.message
    });
  }

  return {
    path: scope.workTree,
    toplevel: scope.workToplevel,
    // The git common dir the scope resolved. `worktreeTarget` is a BOOLEAN
    // saying whether the pane sat in a worktree — it was never a path, and
    // using it here wrote `true` into a field the schema declares as `/abs`.
    gitDir: scope.workGitDir || null,
    // Both from the single reading above, and from NOTHING else. Not
    // `scope.trunk.branch` (probed at wrap-scope resolution, before the commit
    // step), not `scope.baseline.sha` (the sha this session launched at), and
    // not the wrap's own commit sha.
    //
    // That last exclusion is the subtle one. Preferring the commit step's sha
    // looks obviously right — it IS this wrap's commit — and it does NOT agree
    // with the measured branch. When the wrap auto-branches off a protected
    // branch, `commit` captures its sha on the WRAP branch and
    // `_autoPrCloseLoop` checks the original branch back out. Nothing moves
    // HEAD again before this step, so the pair would be a measured
    // `branch: main` beside a sha main has never carried.
    //
    // What this field means is "the tree, as this handoff was staged". The
    // wrap's commit is a different fact and the commit step already records it.
    branch,
    headSha,
    dirty,
    // Present only when something went short, so an ordinary complete reading
    // adds no noise and a reader can treat absence as "the reading was whole".
    ...(unestablished ? { unestablished } : {}),
    ...(readFailure ? { readFailure } : {})
  };
}


/**
 * The governing-text manifest the handoff carries: project rules, the global
 * rule set, and the shared documents in reach.
 *
 * Reuses `launchSequence.manifestFingerprints` rather than deriving a second
 * fingerprint: the next launch diffs this manifest against a live one built by
 * that same function, and two derivations that drift would report drift that is
 * not there.
 *
 * `manifestSources` travels with the rows because it is the only thing that
 * lets the next launch tell "this project has no shared documents" from "this
 * wrap never looked at any" — the question every pre-21.10 document answers
 * ambiguously.
 * @param {object} project - Project record
 * @returns {{rules: object[], manifestSources: string[]}} The manifest
 */
function _ruleManifest(project) {
  try {
    return launchSequence.manifestFingerprints(project);
  // prawduct:allow prawduct/broad-except -- a manifest read must not fail a wrap; an empty
  // source list makes the next launch report every source as not-recorded, which is true
  } catch (err) {
    log.warn('Could not read the governing rules for the handoff manifest', {
      project: project.name, error: err.message
    });
    return { rules: [], manifestSources: [] };
  }
}

/**
 * This session's Medusa workspace id.
 *
 * The `sessions` table carries no `workspace_id` column — the id lives in the
 * project's Medusa registry, so reading `session.workspaceId` recorded null in
 * every document.
 * @param {object} project - Project record
 * @param {object|null} session - The session being wrapped
 * @returns {string|null} The workspace id, or null when this project has no registry entry
 */
function _workspaceId(project, session) {
  if (!session || session.id == null) return null;
  try {
    return medusaRegistry.getWorkspaceId(configRootOf(project), session.id);
  } catch (err) {
    log.warn('Could not read the Medusa workspace id for the handoff', {
      project: project.name, session: session.id, error: err.message
    });
    return null;
  }
}

/**
 * sha256 of the engine's generated config file, or null when there is none.
 * @param {object} project - Project record
 * @param {object|null} session - The session being wrapped
 * @returns {string|null}
 */
function _engineConfigHash(project, session) {
  try {
    const engineId = (session && session.engineId) || project.engineId || null;
    const profile = engineId ? engines.resolveProfile(engineId) : null;
    const file = profile ? engines.configFilenameOf(profile) : null;
    return file ? _fileHash(path.join(configRootOf(project), file)) : null;
  } catch (err) {
    log.warn('Could not hash the engine config for the handoff manifest', {
      project: project.name, error: err.message
    });
    return null;
  }
}

/**
 * sha256 of a file's bytes, or null when it cannot be read.
 * @param {string|null} file - Absolute path
 * @returns {string|null}
 */
function _fileHash(file) {
  if (!file) return null;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Step handler. See module docstring for the full contract.
 * @param {object} context - Pipeline runner context
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, session, previousResults, scope, options, wrapRunId, methodology } = context;

  if (!session || session.id == null) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no session to hand off from' },
      blockers: []
    };
  }
  if (!wrapRunId) {
    // Honest skip rather than a silent nothing: without the run id a
    // publication cannot be bound to the attempt that produced it, and an
    // unbindable publication is worse than none.
    log.warn('No wrap run id in context; the handoff cannot be bound to this attempt', {
      project: project.name, session: session.id
    });
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no wrap run id: the handoff could not be bound to this attempt' },
      blockers: []
    };
  }

  // Fixed at staging from the wrap's own option, never re-read later: a kept
  // session's attempt is a checkpoint for its whole life, even if the session
  // is wrapped for real minutes afterwards.
  const kind = options && options.keepSessionRunning ? 'checkpoint' : 'final';
  const missingEvidence = _missingEvidence(previousResults);

  try {
    // A replayed stage within one run must write NOTHING. Minting an id and
    // writing bytes before asking would leave an orphan staged-<newId>.json on
    // disk that no row ever references, which reconciliation would later read
    // as an unfinished publish.
    const already = store.handoffs.getByRun(session.id, wrapRunId);
    if (already) {
      log.info('This run already staged a handoff attempt; writing nothing', {
        project: project.name, session: session.id, publication: already.publicationId
      });
      return {
        ok: true,
        status: 'done',
        output: {
          publicationId: already.publicationId,
          kind: already.kind,
          replayed: true,
          wrapOutcome: null,
          missingEvidence: []
        },
        blockers: []
      };
    }

    const publicationId = newPublicationId();
    const doc = buildHandoffDocument({
      publicationId,
      projectId: project.id,
      workspaceId: _workspaceId(project, session),
      sessionId: session.id,
      wrapRunId,
      engineId: session.engineId || project.engineId || 'unknown',
      kind,
      stagedAt: new Date().toISOString(),
      // Both sides of this merge changed one of these two lines, for different
      // reasons, so neither side alone is right. `_worktreeFacts` takes ONE
      // argument: #1648 removed the anchor, because measuring the tree once is
      // the fix. `_ruleManifest` is SPREAD: car 21.10 made it return
      // `{rules, manifestSources}`, and `rules:` would nest the pair under one
      // key and silently drop the source roster the drift diff reads.
      worktree: _worktreeFacts(scope),
      // The other half of that null. Without it the frozen bytes say "this
      // project has no worktree" for a probe that merely failed, which is the
      // one claim that disables the launch's workspace checks outright.
      worktreeProblem: _worktreeProblem(scope),
      ..._ruleManifest(project),
      globalRulesHash: crypto.createHash('sha256')
        .update(String(store.globalRules.load() || '')).digest('hex'),
      engineConfigHash: _engineConfigHash(project, session),
      continuityIndexHash: _fileHash(continuity.indexPath(configRootOf(project))),
      wrapOutcome: missingEvidence.length > 0 ? 'degraded' : 'complete',
      missingEvidence,
      methodology: _methodologyRecord(methodology, previousResults),
      nextAction: _nextAction(previousResults),
      // The plan a wrap was working against is not something wrap-scope
      // resolves, and there is no other reader for it yet. Null is honest;
      // inventing a path would put a fabricated reference in frozen bytes.
      planRef: null
    });

    const written = lockfile.writeStaged(project, doc);
    const { publication, replayed } = store.handoffs.stage({
      publicationId,
      projectId: project.id,
      sessionId: session.id,
      wrapRunId,
      kind,
      fileDigest: written.digest,
      stagedAt: doc.stagedAt
    });

    log.info('Staged a handoff attempt', {
      project: project.name, session: session.id,
      publication: publication.publicationId, kind, replayed
    });

    return {
      ok: true,
      status: 'done',
      // The runner carries this to `_runClaimedWrap`, which binds and
      // finalizes it. A replay returns the FIRST attempt's id, so the wrap
      // finalizes the attempt it actually staged.
      output: {
        publicationId: publication.publicationId,
        kind,
        replayed,
        wrapOutcome: doc.wrapOutcome,
        missingEvidence
      },
      blockers: []
    };
  } catch (err) {
    log.error('Could not stage the handoff', {
      project: project.name, session: session.id, error: err.message
    });
    return {
      ok: false,
      status: 'blocked',
      output: { reason: `handoff staging failed: ${err.message}` },
      blockers: []
    };
  }
}


/**
 * Why the work tree could not be read, or null when nobody failed to read it.
 *
 * `wrap-scope` keeps two states apart that every caller before this one
 * flattened: "this is not a git repository" and "git could not be read".
 * `workToplevel` is null in both, and `workTreeProblem` is the discriminator —
 * null only for a genuine non-repo, a reason string for a probe that could not
 * run, timed out, was refused or came back malformed.
 *
 * The wrap's `commit` and `session-files` steps already read it and refuse to
 * act on a tree they could not see. This step could not refuse — a handoff is
 * staged from whatever the wrap knows — so it records the reason instead, and
 * the next launch declines to believe the worktree block rather than reading
 * its absence as "there is no worktree to check".
 *
 * The guard is the exact complement of `_worktreeFacts`'s, deliberately: the
 * problem explains a MISSING fact, so it is reported when and only when that
 * function returns null. Keying on `workToplevel` alone would have left the two
 * disagreeing about a scope with a toplevel and no work tree — unreachable
 * through `wrap-scope.resolve` today, which is exactly the kind of gap that
 * stops being unreachable later, quietly.
 *
 * The reason is stored AS GIVEN, not trimmed. Whitespace is tested to decide
 * whether a reason was really supplied; rewriting the producer's own text would
 * edit recorded evidence on its way into bytes that can never be revisited.
 *
 * @param {object|null} scope - `lib/wrap-scope.js` scope for this run
 * @returns {string|null} The probe failure exactly as the scope stated it, or null
 */
function _worktreeProblem(scope) {
  if (!scope) return null;
  if (scope.workTree && scope.workToplevel) return null;
  const problem = scope.workTreeProblem;
  return typeof problem === 'string' && problem.trim() ? problem : null;
}

module.exports = {
  run, _missingEvidence, _methodologyRecord, _nextAction, _worktreeFacts, _worktreeProblem, _ruleManifest, _workspaceId
};
