'use strict';

/**
 * `continuity-write` wrap step (CC-1) — the WRITE half of the Continuity
 * Contract's thin first slice. Runs AFTER `commit` so its freshness stamp
 * anchors to the wrap commit's HEAD, and rewrites the project's hot
 * continuity index (`lib/continuity.js`) from:
 *
 *   - the `Next action` + `Where we are` the AI captured this wrap
 *     (a prior `ai-content` step's `parsedFields`), and
 *   - server-side git facts (short sha + branch).
 *
 * The next session's prime reads that index back and offers a visible
 * "we left off at X — continue?" resume (see `generatePrimePrompt`).
 *
 * **Mechanical floor / honest emptiness.** This step NEVER blocks a wrap
 * (`blocker: false` in the template, and it returns `ok: true` even when
 * inputs are missing). With no AI capture it still writes the freshness
 * stamp and a flagged-empty Next action rather than fabricating one — the
 * contract's "missing judgment is flagged-empty, never fabricated" rule.
 *
 * **Degraded-wrap tier (CC-7).** It also stamps which tier ran — `full`,
 * `no-plugin`, or `mechanical-only` (see `_deriveTier`) — into both the index
 * and the per-session wrap summary's freshness, and on a mechanical-only wrap
 * flags the empty judgment sections WITH the reason (`_deriveUncapturedReason`)
 * so the next session reads WHY, not just that they're empty.
 *
 * **The `files:` stamp is provenance, so it is the session's set or it is
 * absent.** The warm tier records which paths changed since the previous wrap's
 * recorded boundary — the same session range every other wrap step measures — and
 * records them unfiltered, because a wrap's commit is mostly `.tangleclaw/`
 * bookkeeping that no source-file allowlist would keep. When that range cannot be
 * established the field is omitted with a logged reason rather than filled from
 * the branch's wider inventory: a provenance record that is confidently wrong is
 * worse than one that is visibly empty (#797).
 *
 * **Store is gitignored.** The index lives under `.tangleclaw/continuity/`
 * (gitignored), so writing it directly here — rather than staging for the
 * `commit` step — is correct: it must be on disk for the next prime, and
 * it should never land in the wrap commit. This is also why the step runs
 * after `commit` without needing a second commit.
 */

const continuity = require('../continuity');
const transcript = require('../transcript');
const featuresToc = require('./features-toc');
const engines = require('../engines');
const store = require('../store');
const { createLogger } = require('../logger');
const { execFileArgs } = require('./_exec-shell');
const gitRange = require('./_git-range');

const log = createLogger('wrap-step-continuity-write');

const EXEC_TIMEOUT_MS = 30 * 1000;
const MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * This step's git runner: the shared argv-style runner plus this step's caps.
 * Overridable via `_internal` so tests can stub git without a real repo.
 *
 * The caps are overridable ONLY so a guard can drive the timeout path in
 * milliseconds instead of waiting out the real thirty seconds; production
 * callers pass neither. Without that seam the mapping from a real kill to
 * `timedOut` is unreachable by any test, which is where this defect lived
 * (#897).
 *
 * @param {string} file
 * @param {string[]} args
 * @param {object} options
 * @param {string} options.cwd
 * @param {number} [options.timeoutMs] - Test seam; defaults to EXEC_TIMEOUT_MS.
 * @param {number} [options.maxBufferBytes] - Test seam; defaults to MAX_BUFFER_BYTES.
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string,
 *   error:string|null, timedOut:boolean}>}
 */
function defaultExec(file, args, options) {
  return execFileArgs(file, args, {
    cwd: options.cwd,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : EXEC_TIMEOUT_MS,
    maxBufferBytes: Number.isFinite(options.maxBufferBytes)
      ? options.maxBufferBytes : MAX_BUFFER_BYTES
  });
}

/**
 * Resolve the AI-captured continuity fields from prior step results.
 * Duck-typed on shape rather than keyed by step id (so a pipeline variant that
 * renames its summary step still feeds continuity): scans for the most
 * recent prior result whose `output.parsedFields` carries a `summary` or
 * `nextSteps`. The prawduct `memory-update` step produces exactly this.
 * `learnings` (CC-2) feeds the wrap summary's `## Landmines` section when
 * present; the other four summary sections are honest-flagged (uncaptured).
 *
 * @param {Array} previousResults - Runner's prior-step results
 * @returns {{currentState:string, nextAction:string, learnings:string}}
 */
function _resolveCapturedFields(previousResults) {
  const out = { currentState: '', nextAction: '', learnings: '', delta: '', openThreads: '', decisions: '', pointers: '' };
  if (!Array.isArray(previousResults)) return out;
  for (let i = previousResults.length - 1; i >= 0; i--) {
    const pf = previousResults[i] && previousResults[i].output && previousResults[i].output.parsedFields;
    if (pf && (pf.summary || pf.nextSteps)) {
      out.currentState = (pf.summary || '').trim();
      out.nextAction = (pf.nextSteps || '').trim();
      out.learnings = (pf.learnings || '').trim();
      out.delta = (pf.delta || '').trim();
      out.openThreads = (pf.openThreads || '').trim();
      out.decisions = (pf.decisions || '').trim();
      out.pointers = (pf.pointers || '').trim();
      return out;
    }
  }
  return out;
}

/**
 * Find the commit step's output among the runner's prior results.
 *
 * Duck-typed on the step's own contract — an output that carries a `commitSha`
 * key, present and null on the skip path — rather than on the step id, matching
 * `_resolveCapturedFields`' shape-over-id philosophy. One definition of "which
 * result is the commit step's", so the anchor and the range base cannot end up
 * reading different results.
 *
 * @param {Array} previousResults - Runner's prior-step results
 * @returns {object|null} The commit step's output, or null when no commit step ran.
 */
function _resolveCommitOutput(previousResults) {
  if (!Array.isArray(previousResults)) return null;
  for (const r of previousResults) {
    const out = r && r.output;
    if (out && typeof out === 'object' && Object.hasOwn(out, 'commitSha')) return out;
  }
  return null;
}

/**
 * Resolve the wrap-commit anchor from the runner's prior results — the
 * commit step's `{commitSha, branch}` output. #467's auto-PR close-loop
 * may return HEAD to the original branch before this step runs, so HEAD
 * is no longer the wrap commit; anchoring the freshness stamp and the
 * session delta to the commit step's recorded sha/branch keeps them correct
 * regardless of where HEAD points. Null when no commit landed this wrap
 * (clean session / halted pipeline) — callers fall back to HEAD.
 *
 * @param {Array} previousResults - Runner's prior-step results
 * @returns {{sha:string, branch:string}|null}
 */
function _resolveCommitAnchor(previousResults) {
  const out = _resolveCommitOutput(previousResults);
  if (!out || typeof out.commitSha !== 'string' || !out.commitSha) return null;
  return { sha: out.commitSha, branch: typeof out.branch === 'string' ? out.branch : '' };
}

/**
 * Record that a git probe was STOPPED rather than that it answered badly.
 *
 * This step is best-effort by contract: every git failure degrades to an empty
 * value and the wrap continues, which is right. But that makes it the step
 * where a kill is most completely invisible — a stamp reading `unknown` and a
 * Map left untouched look identical whether git said "no" or never answered at
 * all. This log line is the only place that distinction survives (#897).
 *
 * @param {string} what - The command, as an operator would name it.
 * @param {string} cwd - Project root the probe ran in.
 * @param {{error:(string|null)}} res - The exec result that timed out.
 * @returns {void}
 */
function _warnStopped(what, cwd, res) {
  log.warn('git probe was stopped before it answered; continuity data degrades to unknown', {
    command: what, cwd, error: res.error
  });
}

/**
 * Read short sha + branch for the freshness stamp. Anchored to the wrap
 * commit when `anchor` is provided (see `_resolveCommitAnchor`); falls
 * back to HEAD reads otherwise. Best-effort: a non-repo or git failure
 * yields empty values (renderIndex flags them `unknown`) — the wrap
 * still completes.
 * @param {string} cwd - Project root
 * @param {{sha:string, branch:string}|null} [anchor] - Wrap-commit anchor
 * @returns {Promise<{sha:string, branch:string}>}
 */
async function _gitFacts(cwd, anchor = null) {
  const facts = { sha: '', branch: '' };
  try {
    const shaRef = anchor && anchor.sha ? anchor.sha : 'HEAD';
    const sha = await _internal.exec('git', ['rev-parse', '--short', shaRef], { cwd });
    if (sha.exitCode === 0) facts.sha = sha.stdout.trim();
    else if (sha.timedOut) _warnStopped('git rev-parse --short', cwd, sha);
    if (anchor && anchor.branch) {
      facts.branch = anchor.branch;
    } else {
      const branch = await _internal.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      if (branch.exitCode === 0) facts.branch = branch.stdout.trim();
      else if (branch.timedOut) _warnStopped('git rev-parse --abbrev-ref HEAD', cwd, branch);
    }
  } catch (err) {
    log.debug('git facts unavailable for continuity stamp', { cwd, error: err.message });
  }
  return facts;
}

/**
 * Compute what THIS SESSION changed: the touched + deleted paths across the
 * session's own commit range.
 *
 * Two consumers with different needs come off one diff. The Map (CC-3) wants the
 * indexable subset — it stubs source files an operator will describe. The `files:`
 * provenance stamp (CC-5) wants ALL of them: a record of the session that silently
 * omits the paths its own commit contains is the defect #797 reports, and every
 * `.tangleclaw/` path a wrap commits falls outside the index allowlist. So the
 * filter is applied by the caller, on the Map's half only.
 *
 * **The range is the session's, not the branch's.** This step used to diff
 * `<trunk>...<tip>` — every commit on the branch, however many sessions built it —
 * which is why a wrap on a long-lived branch recorded a cumulative inventory
 * disjoint from its own commit. `previousWrapSha` is the boundary the previous
 * wrap left (see `commit._readLastWrapSha`); `resolveSessionRangeAsync` accepts it
 * only when it resolves AND is an ancestor of the tip, and otherwise falls back to
 * the trunk range — the same policy the pre-commit steps already use.
 *
 * The boundary's reach is `lastWrapSha`'s, not this step's: it records the wrap
 * commit's PARENT so a squash-merge cannot orphan it (#664), so a session whose
 * only commit IS its wrap commit leaves a boundary that precedes its own work, and
 * a boundary that has not moved for several sessions spans all of them. Whatever
 * the rest of the wrap calls this session, so does the record.
 *
 * `git diff --name-status <range>`: `A`/`M`/`C` → touched (last path), `D` →
 * deleted, `R` → old path deleted + new path touched.
 *
 * Best-effort and non-throwing: a non-repo / no-range / git failure yields empty
 * lists, so `updateMap` leaves the prior Map untouched. The three ways that can
 * happen are kept APART, because the caller prints a cause and the operator acts
 * on it: no range resolved at all, a range that resolved whose diff would not
 * answer, and a probe our own timeout killed rather than let answer.
 *
 * @param {string} cwd - Project root
 * @param {object} [options]
 * @param {{sha:string, branch:string}|null} [options.anchor] - Wrap-commit anchor;
 *   the diff's far end, so #467's close-loop moving HEAD off the wrap branch
 *   cannot empty the range.
 * @param {string|null} [options.previousWrapSha] - The range base the previous
 *   wrap recorded, from the commit step's output.
 * @returns {Promise<{touched:string[], deleted:string[],
 *   kind:('session'|'branch'|'diff-failed'|null), stopped:string[]}>} `kind` says
 *   which range answered: `session` is the range since the recorded boundary,
 *   `branch` is the trunk fallback, `diff-failed` is a resolved range whose diff
 *   did not answer, `null` is no range at all. `stopped` names every probe our own
 *   timeout killed — non-empty means any negative above was taken on an UNKNOWN
 *   answer, which `_git-range`'s contract says a caller reporting a cause must say
 *   (#897), and which both sibling callers already do.
 */
async function _sessionDelta(cwd, options = {}) {
  const { anchor = null, previousWrapSha = null } = options;
  const stopped = [];

  const tip = anchor && anchor.sha ? anchor.sha : 'HEAD';
  const resolved = await gitRange.resolveSessionRangeAsync(cwd, previousWrapSha, {
    dots: 'three', // feeds `git diff`, where three-dot means "since the merge base"
    tip,
    exec: _internal.exec,
    onStopped: (command) => stopped.push(command)
  });
  if (!resolved) return { touched: [], deleted: [], kind: null, stopped };

  const diffCommand = `git diff --name-status ${resolved.range}`;
  const diffFailed = { touched: [], deleted: [], kind: 'diff-failed', stopped };
  let out;
  try {
    out = await _internal.exec('git', ['diff', '--name-status', resolved.range], { cwd });
  } catch (err) {
    // The production runner resolves rather than throws, so this is the seam
    // being stubbed with a thrower to drive the no-repo path. Warned rather than
    // debugged: this is a reason no provenance stamp was written, and the default
    // log level never prints debug, so a debug line here is no line at all.
    // prawduct:allow prawduct/broad-except -- degrades to the documented empty
    // delta and logs the cause; the wrap must never halt on continuity.
    log.warn('the session delta could not be read; this wrap records no files: stamp', {
      cwd, command: diffCommand, error: err.message
    });
    return diffFailed;
  }
  if (!out || out.exitCode !== 0) {
    // Empty lists leave the prior Map untouched — the safe degrade. A kill and a
    // refusal both land here and neither is "the session touched nothing", so
    // both say so — the kill through the shared vocabulary, the refusal with its
    // own line, which previously existed nowhere at all.
    if (out && out.timedOut) {
      _warnStopped(diffCommand, cwd, out);
      stopped.push(diffCommand);
    } else {
      log.warn('the session delta was refused; this wrap records no files: stamp', {
        cwd, command: diffCommand, exitCode: out ? out.exitCode : null,
        stderr: out ? String(out.stderr || '').trim().slice(0, 200) : null
      });
    }
    return diffFailed;
  }

  const touched = [];
  const deleted = [];
  for (const raw of String(out.stdout || '').split('\n')) {
    const parts = raw.split('\t').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const status = parts[0];
    if (status.startsWith('D')) {
      deleted.push(parts[1]);
    } else if (status.startsWith('R')) {
      // Rename: parts = [Rxxx, oldPath, newPath]
      if (parts[1]) deleted.push(parts[1]);
      if (parts[2]) touched.push(parts[2]);
    } else {
      touched.push(parts[parts.length - 1]);
    }
  }
  return { touched, deleted, kind: resolved.kind, stopped };
}

/**
 * Decide whether this wrap may publish a `files:` provenance stamp, and say why
 * not when it may not.
 *
 * The stamp claims "these are the paths that changed since the previous wrap".
 * The trunk-range fallback answers a different question — every path the BRANCH
 * changed, however many wraps built it — and publishing that under this name is
 * #797. It is the right answer in exactly one case: a boundary POSITIVELY
 * established as absent, where the branch's divergence from trunk is all there
 * has ever been because no earlier wrap has stamped.
 *
 * Which is why this takes the commit step's `previousWrapShaRead` rather than
 * only its sha. A null sha has three sources and they are not interchangeable —
 * never wrapped, a config that would not load, a stamp that failed to write — and
 * on two of them a boundary is probably on disk, unread, while the branch behind
 * this wrap carries earlier sessions. Treating all three as "no earlier session"
 * is `architecture.md`'s rule read backwards, and it is the shape of #797 itself:
 * a plausible default published as an established fact. Same for a missing
 * report: `blocker` is operator-overridable, so a blocked commit can reach this
 * step, and the absence of a field is not the absence of a boundary.
 *
 * @param {object} args
 * @param {'session'|'branch'|'diff-failed'|null} args.kind - Which range answered
 *   (`_sessionDelta`).
 * @param {boolean} args.commitStepReported - Did a commit-step output reach us at all?
 * @param {'recorded'|'absent'|'unreadable'|null} args.boundaryRead - The commit
 *   step's account of reading the previous boundary.
 * @param {string[]} [args.stopped] - Probes our own timeout killed. A negative
 *   taken on an unknown answer is not the same refusal as one taken on a real
 *   answer, and only the caller can say so — see `_sessionDelta`.
 * @returns {{publish:boolean, why:(string|null)}} `why` names the refusal in the
 *   operator's terms, and is null when the stamp is published.
 */
function _stampDecision({ kind, commitStepReported, boundaryRead, stopped = [] }) {
  // A killed probe reads as a definite negative to every predicate below, so it
  // is named FIRST — a cause stated with confidence sends an operator to the
  // wrong place faster than no cause at all.
  const unanswered = stopped.length
    ? ` (a git probe was stopped before it answered — ${stopped.join('; ')} — so this may be a fallback taken on an unknown answer rather than a negative one)`
    : '';
  if (!commitStepReported) {
    return { publish: false, why: 'no commit step reported a boundary, so nothing establishes where this session began' };
  }
  if (boundaryRead === 'unreadable') {
    return { publish: false, why: 'the project config would not load, so a recorded boundary may exist unread' };
  }
  if (kind === 'session') return { publish: true, why: null };
  if (kind === 'branch' && boundaryRead === 'absent') return { publish: true, why: null };
  if (kind === 'branch') {
    return { publish: false, why: `the recorded boundary is not an ancestor of this wrap commit, so the only range that resolved is the whole branch${unanswered}` };
  }
  if (kind === 'diff-failed') {
    return { publish: false, why: `a range resolved but its diff did not answer, so nothing was measured${unanswered}` };
  }
  return { publish: false, why: `no git range resolved at all — this is not a repository, or it has no trunk branch${unanswered}` };
}

/**
 * Derive the session's work type (CC-5) from its branch prefix — TC's branch
 * convention (`feat/`, `fix/`, `chore/`, `docs/`, `refactor/`; `feature/` →
 * `feat`). The `type` filter's source: no new git call, just `facts.branch`.
 * A typeless branch (e.g. `main`) yields `''` so the field is omitted (the
 * session stays un-indexed for the type filter — an honest forward-only gap).
 * @param {string} branch
 * @returns {string}
 */
function _branchType(branch) {
  const m = String(branch || '').match(/^([A-Za-z]+)\//);
  if (!m) return '';
  const prefix = m[1].toLowerCase();
  const ALLOWED = { feat: 'feat', feature: 'feat', fix: 'fix', chore: 'chore', docs: 'docs', refactor: 'refactor' };
  return ALLOWED[prefix] || '';
}

/**
 * Resolve the degraded-wrap tier (CC-7, `continuity-contract.md` §"Degraded
 * wrap"). The wrap always delivers the mechanical floor; this records how much
 * *judgment* it could capture so the next session can verify before trusting:
 *   - `mechanical-only` — no AI judgment captured (headless / no channel / skip);
 *     the floor still ran, judgment sections are honest-flagged.
 *   - `no-plugin` — AI captured judgment but the project isn't plugin-governed,
 *     so no reflection fold.
 *   - `full` — AI captured judgment AND the project is plugin-governed.
 * `pluginGoverned` is the contract's stated proxy for "reflection fold eligible"
 * (`engines.isPluginGoverned`, #335).
 *
 * @param {boolean} hadCapture - Did a prior ai-content step yield judgment?
 * @param {boolean} pluginGoverned - Is the project plugin-governed?
 * @returns {'full'|'no-plugin'|'mechanical-only'}
 */
function _deriveTier(hadCapture, pluginGoverned) {
  if (!hadCapture) return 'mechanical-only';
  return pluginGoverned ? 'full' : 'no-plugin';
}

/**
 * Explain WHY judgment was uncaptured this wrap, for honest flagged-empty
 * labeling (CC-7). Duck-typed on the prior steps' skip-output shape — mirroring
 * `_resolveCapturedFields`' shape-over-id philosophy so a renamed ai-content
 * step still classifies. The ai-content step stages `{webui:true}` when a
 * webui/OpenClaw session has no AI channel (#334) and `{override:true}` when the
 * operator skipped it. Anything else falls back to the generic reason.
 *
 * @param {Array} previousResults - Runner's prior-step results
 * @returns {string} A short reason phrase (never empty)
 */
function _deriveUncapturedReason(previousResults) {
  if (Array.isArray(previousResults)) {
    for (let i = previousResults.length - 1; i >= 0; i--) {
      const out = previousResults[i] && previousResults[i].output;
      if (!out) continue;
      if (out.webui) return 'no AI channel';
      if (out.override) return 'AI content skipped by operator';
    }
  }
  return 'no AI capture this wrap';
}

/**
 * Step handler. See module docstring for the full contract.
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record
 * @param {Array} context.previousResults - Prior step results
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, session, previousResults } = context;

  const captured = _resolveCapturedFields(previousResults || []);
  // #467 — anchor git facts + the session delta to the wrap commit, not HEAD:
  // the commit step's auto-PR close-loop may already have returned the
  // checkout to the original branch by the time this step runs.
  const commitOut = _resolveCommitOutput(previousResults || []);
  const anchor = _resolveCommitAnchor(previousResults || []);
  // #797 — the boundary the PREVIOUS wrap recorded, and the commit step's account
  // of reading it. The commit step reports both because its own stamp has already
  // overwritten the on-disk value by now, and because a null sha alone cannot say
  // whether a boundary is absent or merely unread (see `_stampDecision`).
  const previousWrapSha = commitOut && typeof commitOut.previousWrapSha === 'string'
    ? commitOut.previousWrapSha
    : null;
  const boundaryRead = commitOut && typeof commitOut.previousWrapShaRead === 'string'
    ? commitOut.previousWrapShaRead
    : null;

  const facts = await _gitFacts(project.path, anchor);
  const writtenAt = _internal.today();
  const sid = session && session.id != null ? session.id : null;

  // CC-7 degraded-wrap tier — computed up front so it stamps BOTH the hot index
  // (read at the next resume) and the per-session wrap summary. `hadCapture` is
  // the AI-judgment signal; `uncapturedReason` explains an empty wrap so the
  // next session reads WHY (honest labeling, never fabrication). Plugin-
  // governance read is best-effort: a throw falls back to non-governed.
  const hadCapture = Boolean(captured.currentState || captured.nextAction);
  let pluginGoverned = false;
  try {
    pluginGoverned = engines.isPluginGoverned(project.path);
  } catch (err) {
    log.debug('isPluginGoverned check failed; assuming non-governed', { project: project.name, error: err.message });
  }
  const tier = _deriveTier(hadCapture, pluginGoverned);
  const uncapturedReason = hadCapture ? '' : _deriveUncapturedReason(previousResults || []);

  // CC-3 Map: recover the prior (curated) Map BEFORE the index rewrite, then
  // self-maintain it — stub touched files, prune deleted ones. The Map is the
  // one index section that survives a rewrite; everything else is regenerated.
  // Best-effort: any failure leaves the prior Map intact (never halts a wrap).
  let nextMap = '';
  let touchedFiles = []; // the CC-5 `files:` warm-tier stamp, written below
  try {
    const prior = continuity.readIndexRaw(project.path);
    const priorMap = prior && prior.map ? prior.map : '';
    const delta = await _sessionDelta(project.path, { anchor, previousWrapSha });
    // The Map indexes source files an operator will describe, so it takes the
    // allowlisted subset. `files:` takes the whole set — see `_sessionDelta`.
    // The Map accretes from whatever range resolved even when the stamp is
    // withheld: stubbing is idempotent, so a wider range costs it nothing, while
    // starving it would lose real entries over a bookkeeping doubt.
    nextMap = continuity.updateMap(priorMap, {
      touched: delta.touched.filter(featuresToc._isIndexableCandidate),
      deleted: delta.deleted.filter(featuresToc._isIndexableCandidate)
    });
    // Every path goes through `_stampDecision` — no call-site short-circuit. A
    // wrap that committed nothing is NOT "the session changed nothing": the
    // commit step skips on a clean tree, which a session that committed by hand
    // reaches with real work behind it, and `commitSha` is also null on the
    // committed path when `git rev-parse HEAD` fails after the commit landed. On
    // all of those the range since the boundary is the honest answer, over-
    // reporting by the previous wrap's own commit (#1280) rather than dropping
    // real work — and dropping paths from a provenance record is #797's own
    // second half.
    const decision = _stampDecision({
      kind: delta.kind,
      commitStepReported: Boolean(commitOut),
      boundaryRead,
      stopped: delta.stopped
    });
    if (decision.publish) {
      touchedFiles = delta.touched;
    } else {
      log.warn('this wrap records no files: stamp — the session\'s range could not be established', {
        project: project.name,
        why: decision.why,
        previousWrapSha,
        boundaryRead,
        rangeMeasured: delta.kind || 'none',
        // Naming the probes our own timeout killed is the difference between a
        // cause and a guess: a stopped `merge-base --is-ancestor` produces the
        // same `kind: 'branch'` as a genuine negative, and the remediation below
        // would send the operator to check things that are perfectly fine.
        stoppedProbes: delta.stopped.length ? delta.stopped : undefined,
        remediation: delta.stopped.length
          ? 'a git probe was stopped at its timeout rather than answering, so the range above is a '
            + 'fallback taken on an UNKNOWN answer — check the repository for an index lock or a '
            + 'very large tree before checking the boundary itself'
          : 'the next wrap re-stamps the boundary, so the stamp returns on its own; if it does not, '
            + 'check that .tangleclaw/project.json loads and that the recorded lastWrapSha still '
            + 'exists in this clone'
      });
    }
  } catch (err) {
    // This catch is also the reason no `files:` stamp was written, and the
    // default log level never prints debug — so a debug line here is the silent
    // omission the module docstring promises does not happen.
    log.warn('Map maintenance and the files: stamp were both skipped', {
      project: project.name, error: err.message
    });
  }

  // CC-5 work type from the branch prefix (reuses facts.branch — no extra git).
  const workType = _branchType(facts.branch);

  let indexFile;
  try {
    indexFile = continuity.writeIndex(project.path, {
      project: project.name,
      currentState: captured.currentState,
      nextAction: captured.nextAction,
      map: nextMap,
      freshness: { sha: facts.sha, branch: facts.branch, writtenAt, tier }
    });
  } catch (err) {
    // Continuity is never worth halting a wrap over — record a note, not a
    // blocker. The `blocker: false` template entry already prevents a halt;
    // returning ok:false here would still surface a red row, so we keep it
    // honest as a non-blocking 'done' with the error in output.
    log.warn('Failed to write continuity index', { project: project.name, error: err.message });
    return {
      ok: true,
      status: 'done',
      output: { written: false, error: err.message },
      blockers: []
    };
  }

  // CC-6 (#381): the per-project wrap-section selection. null ⇒ all 8 (deep
  // default); an array renders only its members (`Next action` always forced
  // in by renderWrapSummary). Best-effort like version-bump's config read —
  // a missing/unreadable config falls back to the deep default, never halts.
  let wrapSections = null;
  try {
    const projConfig = store.projectConfig.load(project.path);
    if (Array.isArray(projConfig.wrapSections)) wrapSections = projConfig.wrapSections;
  } catch (err) {
    log.debug('wrapSections config read skipped', { project: project.name, error: err.message });
  }

  // CC-2 warm tier — append the per-session changelog entry + write the
  // 8-section wrap summary. Session-keyed, so only when a session id is
  // present (a session is always present in a real wrap; guarded for tests
  // and degraded paths). Best-effort: a failure here is a non-blocking note,
  // never a wrap halt — same posture as the index write above.
  const warm = { changelog: false, wrapSummary: false };
  if (sid != null) {
    try {
      continuity.appendChangelogEntry(project.path, {
        date: writtenAt,
        sid,
        line: captured.currentState,
        type: workType,
        files: touchedFiles
      });
      warm.changelog = true;
      continuity.writeWrapSummary(project.path, sid, {
        enabledSections: wrapSections,
        // CC-7: a non-empty reason (mechanical-only wraps only) flags empty
        // judgment sections WITH the cause; '' falls back to the bare marker.
        uncapturedReason: uncapturedReason,
        meta: {
          session: sid,
          date: writtenAt,
          project: project.name,
          harness: session.engineId,
          branch: facts.branch,
          sha: facts.sha,
          type: workType,
          files: touchedFiles,
          tier // CC-7 degraded-wrap tier
        },
        sections: {
          'Where we are': captured.currentState,
          'Next action': captured.nextAction,
          'Landmines': captured.learnings,
          'Delta': captured.delta,
          'Open threads': captured.openThreads,
          'Decisions': captured.decisions,
          'Pointers': captured.pointers,
          'Freshness': [
            `- written-at: ${writtenAt || 'unknown'}`,
            `- sha: ${facts.sha || 'unknown'}`,
            `- branch: ${facts.branch || 'unknown'}`,
            `- tier: ${tier}` // CC-7: stamp the tier in the per-session record too
          ].join('\n')
        }
      });
      warm.wrapSummary = true;
    } catch (err) {
      log.warn('Failed to write continuity warm tier', { project: project.name, sid, error: err.message });
    }
  }

  // CC-4b cold tier — snapshot the raw transcript into sessions/<sid>/ and scan
  // it for secrets. Isolated try/catch in its OWN block: a transcript failure (a
  // slow/huge copy, an unresolved harness, a missing ~/.claude) must never affect
  // the warm-tier writes above and never halts a wrap (blocker:false posture).
  // Honest skip (`captured:false`) for non-Claude / remote / no-transcript.
  let transcriptResult = { captured: false, reason: 'no session id' };
  if (sid != null) {
    try {
      transcriptResult = await transcript.snapshot(project, session, sid);
    } catch (err) {
      transcriptResult = { captured: false, reason: `error: ${err.message}` };
      log.warn('Transcript snapshot failed', { project: project.name, sid, error: err.message });
    }
  }

  log.info('Continuity index written', {
    project: project.name,
    indexFile,
    hadCapture,
    tier,
    sha: facts.sha,
    warm,
    transcript: transcriptResult.captured
      ? { lines: transcriptResult.lineCount, secrets: transcriptResult.secretsFlagged }
      : { captured: false }
  });

  return {
    ok: true,
    status: 'done',
    output: {
      written: true,
      indexPath: indexFile,
      hadCapture,
      tier,
      nextAction: captured.nextAction,
      changelogAppended: warm.changelog,
      wrapSummaryWritten: warm.wrapSummary,
      transcript: transcriptResult
    },
    blockers: []
  };
}

const _internal = {
  exec: defaultExec,
  today: () => new Date().toISOString().slice(0, 10)
};

module.exports = { run, _internal, _resolveCapturedFields, _resolveCommitOutput, _resolveCommitAnchor, _sessionDelta, _stampDecision, _gitFacts, _branchType, _deriveTier, _deriveUncapturedReason };
