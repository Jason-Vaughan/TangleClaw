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
 * Read short HEAD sha + branch for the freshness stamp. Best-effort: a
 * non-repo or git failure yields empty values (renderIndex flags them
 * `unknown`) — the wrap still completes.
 * @param {string} cwd - Project root
 * @returns {Promise<{sha:string, branch:string}>}
 */
async function _gitFacts(cwd) {
  const facts = { sha: '', branch: '' };
  try {
    const sha = await _internal.exec('git', ['rev-parse', '--short', 'HEAD'], { cwd });
    if (sha.exitCode === 0) facts.sha = sha.stdout.trim();
    const branch = await _internal.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    if (branch.exitCode === 0) facts.branch = branch.stdout.trim();
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
 * `git diff --name-status <base>...HEAD`: `A`/`M`/`C` → touched (last path),
 * `D` → deleted, `R` → old path deleted + new path touched.
 *
 * @param {string} cwd - Project root
 * @returns {Promise<{touched:string[], deleted:string[]}>}
 */
async function _mapDelta(cwd) {
  const empty = { touched: [], deleted: [] };
  const base = await _resolveBase(cwd);
  if (!base) return empty;

  let out;
  try {
    out = await _internal.exec('git', ['diff', '--name-status', `${base}...HEAD`], { cwd });
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
 * Step handler. See module docstring for the full contract.
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record
 * @param {Array} context.previousResults - Prior step results
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, session, previousResults } = context;

  const captured = _resolveCapturedFields(previousResults || []);
  const facts = await _gitFacts(project.path);
  const writtenAt = _internal.today();
  const sid = session && session.id != null ? session.id : null;

  // CC-3 Map: recover the prior (curated) Map BEFORE the index rewrite, then
  // self-maintain it — stub touched files, prune deleted ones. The Map is the
  // one index section that survives a rewrite; everything else is regenerated.
  // Best-effort: any failure leaves the prior Map intact (never halts a wrap).
  let nextMap = '';
  try {
    const prior = continuity.readIndexRaw(project.path);
    const priorMap = prior && prior.map ? prior.map : '';
    const delta = await _mapDelta(project.path);
    nextMap = continuity.updateMap(priorMap, delta);
  } catch (err) {
    log.debug('Map maintenance skipped', { project: project.name, error: err.message });
  }

  let indexFile;
  try {
    indexFile = continuity.writeIndex(project.path, {
      project: project.name,
      currentState: captured.currentState,
      nextAction: captured.nextAction,
      map: nextMap,
      freshness: { sha: facts.sha, branch: facts.branch, writtenAt }
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

  const hadCapture = Boolean(captured.currentState || captured.nextAction);

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
        line: captured.currentState
      });
      warm.changelog = true;
      continuity.writeWrapSummary(project.path, sid, {
        meta: {
          session: sid,
          date: writtenAt,
          project: project.name,
          methodology: project.methodology,
          harness: session.engineId,
          branch: facts.branch,
          sha: facts.sha
        },
        sections: {
          'Where we are': captured.currentState,
          'Next action': captured.nextAction,
          'Landmines': captured.learnings,
          'Freshness': [
            `- written-at: ${writtenAt || 'unknown'}`,
            `- sha: ${facts.sha || 'unknown'}`,
            `- branch: ${facts.branch || 'unknown'}`
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

module.exports = { run, _internal, _resolveCapturedFields, _resolveBase, _mapDelta };
