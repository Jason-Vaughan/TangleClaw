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
 * **Store is gitignored.** The index lives under `.tangleclaw/continuity/`
 * (gitignored), so writing it directly here — rather than staging for the
 * `commit` step — is correct: it must be on disk for the next prime, and
 * it should never land in the wrap commit. This is also why the step runs
 * after `commit` without needing a second commit.
 */

const { execFile } = require('node:child_process');
const continuity = require('../continuity');
const transcript = require('../transcript');
const featuresToc = require('./features-toc');
const engines = require('../engines');
const store = require('../store');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-continuity-write');

const EXEC_TIMEOUT_MS = 30 * 1000;

/**
 * Thin `execFile` wrapper mirroring `commit.js:defaultExec` — resolves to
 * a structured result, never throws on non-zero exit. Overridable via
 * `_internal` so tests can stub git without a real repo.
 * @param {string} file
 * @param {string[]} args
 * @param {object} options
 * @param {string} options.cwd
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string}>}
 */
function defaultExec(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: options.cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env
    }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ exitCode, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
    });
  });
}

/**
 * Resolve the AI-captured continuity fields from prior step results.
 * Duck-typed on shape rather than keyed by step id (so a methodology that
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
  const out = { currentState: '', nextAction: '', learnings: '' };
  if (!Array.isArray(previousResults)) return out;
  for (let i = previousResults.length - 1; i >= 0; i--) {
    const pf = previousResults[i] && previousResults[i].output && previousResults[i].output.parsedFields;
    if (pf && (pf.summary || pf.nextSteps)) {
      out.currentState = (pf.summary || '').trim();
      out.nextAction = (pf.nextSteps || '').trim();
      out.learnings = (pf.learnings || '').trim();
      return out;
    }
  }
  return out;
}

/**
 * Resolve the wrap-commit anchor from the runner's prior results — the
 * commit step's `{commitSha, branch}` output. #467's auto-PR close-loop
 * may return HEAD to the original branch before this step runs, so HEAD
 * is no longer the wrap commit; anchoring the freshness stamp and the
 * Map delta to the commit step's recorded sha/branch keeps them correct
 * regardless of where HEAD points. Null when no commit landed this wrap
 * (clean session / halted pipeline) — callers fall back to HEAD.
 *
 * @param {Array} previousResults - Runner's prior-step results
 * @returns {{sha:string, branch:string}|null}
 */
function _resolveCommitAnchor(previousResults) {
  if (!Array.isArray(previousResults)) return null;
  for (const r of previousResults) {
    const out = r && r.output;
    if (out && typeof out.commitSha === 'string' && out.commitSha) {
      return { sha: out.commitSha, branch: typeof out.branch === 'string' ? out.branch : '' };
    }
  }
  return null;
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
    if (anchor && anchor.branch) {
      facts.branch = anchor.branch;
    } else {
      const branch = await _internal.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      if (branch.exitCode === 0) facts.branch = branch.stdout.trim();
    }
  } catch (err) {
    log.debug('git facts unavailable for continuity stamp', { cwd, error: err.message });
  }
  return facts;
}

/**
 * Resolve the base branch this branch diverged from (main, then master).
 * Best-effort: returns null if neither verifies.
 * @param {string} cwd - Project root
 * @returns {Promise<string|null>}
 */
async function _resolveBase(cwd) {
  for (const candidate of ['main', 'master']) {
    try {
      const r = await _internal.exec('git', ['rev-parse', '--verify', '--quiet', candidate], { cwd });
      if (r.exitCode === 0 && r.stdout.trim()) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Compute the session's indexable touched + deleted files vs the base
 * branch, for Map self-maintenance (CC-3). Best-effort and non-throwing:
 * a non-repo / no-base / git failure yields empty lists, so `updateMap`
 * leaves the prior Map untouched. Reuses `features-toc._isIndexableCandidate`
 * for the same source-file allowlist the public index uses.
 *
 * `git diff --name-status <base>...<anchor|HEAD>`: `A`/`M`/`C` → touched
 * (last path), `D` → deleted, `R` → old path deleted + new path touched.
 * The anchor (see `_resolveCommitAnchor`) pins the diff to the wrap
 * commit when #467's close-loop has already moved HEAD off the wrap
 * branch.
 *
 * @param {string} cwd - Project root
 * @param {{sha:string, branch:string}|null} [anchor] - Wrap-commit anchor
 * @returns {Promise<{touched:string[], deleted:string[]}>}
 */
async function _mapDelta(cwd, anchor = null) {
  const empty = { touched: [], deleted: [] };
  const base = await _resolveBase(cwd);
  if (!base) return empty;

  const tip = anchor && anchor.sha ? anchor.sha : 'HEAD';
  let out;
  try {
    out = await _internal.exec('git', ['diff', '--name-status', `${base}...${tip}`], { cwd });
  } catch {
    return empty;
  }
  if (!out || out.exitCode !== 0) return empty;

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
  return {
    touched: touched.filter(featuresToc._isIndexableCandidate),
    deleted: deleted.filter(featuresToc._isIndexableCandidate)
  };
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
  // #467 — anchor git facts + Map delta to the wrap commit, not HEAD:
  // the commit step's auto-PR close-loop may already have returned the
  // checkout to the original branch by the time this step runs.
  const anchor = _resolveCommitAnchor(previousResults || []);
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
  let touchedFiles = []; // reused by the CC-5 `files:` warm-tier fields below
  try {
    const prior = continuity.readIndexRaw(project.path);
    const priorMap = prior && prior.map ? prior.map : '';
    const delta = await _mapDelta(project.path, anchor);
    touchedFiles = delta.touched;
    nextMap = continuity.updateMap(priorMap, delta);
  } catch (err) {
    log.debug('Map maintenance skipped', { project: project.name, error: err.message });
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
          methodology: project.methodology,
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
          'Freshness': [
            `- written-at: ${writtenAt || 'unknown'}`,
            `- sha: ${facts.sha || 'unknown'}`,
            `- branch: ${facts.branch || 'unknown'}`,
            `- tier: ${tier}` // CC-7: stamp the tier in the per-session record too
          ].join('\n')
          // Delta / Open threads / Decisions / Pointers are not captured by
          // today's ai-content step — renderWrapSummary honest-flags them.
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

module.exports = { run, _internal, _resolveCapturedFields, _resolveBase, _resolveCommitAnchor, _mapDelta, _branchType, _deriveTier, _deriveUncapturedReason };
