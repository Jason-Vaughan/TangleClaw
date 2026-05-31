'use strict';

/**
 * `critic-check` wrap step (#139 Chunk 7) — heuristic for "medium+
 * work that should have had an Independent Critic review." Reads git
 * history for commit count, line-change count, and chunk-tag patterns;
 * cross-references `<project>/.tangleclaw/critic-runs.json` for
 * evidence that a Critic ran on the current branch. If the heuristic
 * trips AND no Critic ran, surfaces a warning that Chunk 10's UI will
 * render with a "provide skip rationale" affordance.
 *
 * **Never blocks.** The step's `blocker` is always `false` per ADR 0002:
 * a missing Critic is a methodology rule the user can knowingly skip
 * (with rationale), not a structural failure that halts the pipeline.
 * The handler always returns `ok:true`; the warning lives in `output`.
 *
 * **Session range.** Without `lastWrapSha` (which Chunk 9 will add), the
 * session window is approximated as commits on the current branch
 * since divergence from the project's main branch:
 *   - `git symbolic-ref refs/remotes/origin/HEAD` → main branch name
 *   - Range: `<main>..HEAD` (commits exclusive to current branch)
 *   - If current === main OR the symref fails: fall back to `HEAD~10..HEAD`
 *     and surface the fallback in `output.rangeSpec` so the Chunk 10 UI
 *     can warn that the heuristic is operating in degraded mode.
 *
 * **Heuristic — medium+ trips if ANY of:**
 *   - Commit count ≥ `step.commitThreshold` (default 10)
 *   - Total line changes (insertions + deletions) ≥
 *     `step.lineChangeThreshold` (default 500)
 *   - Chunk-tag pattern (`\bchunk[\s\-_]?N(?:\.N[a-z]?)*\b`,
 *     case-insensitive) found in any commit subject or in the current
 *     branch name. The tag itself is captured in
 *     `output.heuristic.chunkTag` so the Chunk 10 UI can show "this
 *     looks like Chunk N work" in the warning.
 *
 * **Critic-dispatch detection.** The handler reads
 * `<project>/.tangleclaw/critic-runs.json` and filters entries to the
 * current branch. Any entry → `criticRan: true`. Missing / malformed /
 * empty file → `criticRan: false`. The file's *write* side is future
 * work — the `Run Critic` action button in methodology templates
 * (`actions[]`) will eventually POST to a server endpoint that
 * appends an entry; Chunk 7 only defines the read contract so the
 * pipeline can produce useful output today via test fixtures, and the
 * write path can land independently without re-touching this handler.
 *
 * **Rationale staging.** When the warning trips AND the caller passes
 * `options.criticSkipRationale` (a non-empty string), the rationale is
 * staged in `context.staged[step.id] = {warning, owedRationale, ...}`
 * so the Chunk 9 commit step + Chunk 5's `memory-update` prompt can
 * include "Critic owed: <rationale>" in the wrap MEMORY block. No
 * rationale + warning → the warning still surfaces, but `staged`
 * carries `owedRationale: null` and the Chunk 10 UI is expected to
 * prompt the user before letting the pipeline commit.
 */

const { exec } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-critic-check');

const EXEC_TIMEOUT_MS = 30 * 1000; // 30s — git ops should be fast; bound prevents wedging
const DEFAULT_COMMIT_THRESHOLD = 10;
const DEFAULT_LINE_CHANGE_THRESHOLD = 500;
const FALLBACK_RANGE_DEPTH = 10; // HEAD~10..HEAD when main-branch detection fails

// Match `chunk` followed by optional separator (whitespace, dash, underscore)
// and a numeric id with optional dotted sub-ids and a single trailing letter
// per segment. Matches: "Chunk 5", "chunk-7", "chunk_10.2", "chunk5",
// "Chunk 10c.2". Id shape mirrors `lib/wrap-steps/priming-roll.js`'s
// `CHUNK_HEADING_RE` so a chunk priming-roll knows about is also a
// chunk-tag this heuristic detects (ADR 0001: symmetric capability
// gates — if these two regexes ever need to diverge, the divergence
// MUST be cross-referenced in both modules' comments).
const CHUNK_TAG_RE = /\bchunk[\s\-_]?([0-9]+[a-z]?(?:\.[0-9]+[a-z]?)*)\b/i;

const CRITIC_RUNS_FILENAME = path.join('.tangleclaw', 'critic-runs.json');

/**
 * Default thin exec wrapper — resolves to a structured result; never
 * throws on non-zero exit (caller decides what non-zero means).
 *
 * @param {string} command
 * @param {object} options
 * @param {string} options.cwd
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, error:string|null}>}
 */
function defaultExec(command, options) {
  return new Promise((resolve) => {
    exec(command, {
      cwd: options.cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
      env: process.env
    }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({
        exitCode,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        error: err && typeof err.code !== 'number' ? err.message : null
      });
    });
  });
}

/**
 * Detect the current branch via `git rev-parse --abbrev-ref HEAD`.
 * Returns `null` on any failure (detached HEAD, not a repo, git missing).
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function defaultGetCurrentBranch(cwd) {
  const r = await _internal.exec('git rev-parse --abbrev-ref HEAD', { cwd });
  if (r.exitCode !== 0) return null;
  const name = r.stdout.trim();
  if (!name || name === 'HEAD') return null; // detached
  return name;
}

/**
 * Detect the project's main branch via `git symbolic-ref refs/remotes/origin/HEAD`.
 * Returns the short name (e.g. "main", "master") or `null` if the
 * symref doesn't exist (project has no origin remote, or the symref
 * was never set). Caller falls back to a depth-based range when null.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function defaultGetMainBranch(cwd) {
  const r = await _internal.exec('git symbolic-ref refs/remotes/origin/HEAD', { cwd });
  if (r.exitCode !== 0) return null;
  // Output: "refs/remotes/origin/main\n" → "main"
  const m = r.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
  return m ? m[1] : null;
}

/**
 * Run a `git diff --shortstat <range>` and parse the human-readable
 * line into `{insertions, deletions}`. Returns zeros on parse failure
 * or empty diff. Shortstat format examples:
 *   " 3 files changed, 47 insertions(+), 12 deletions(-)"
 *   " 1 file changed, 5 insertions(+)"   ← deletions absent
 *   " 1 file changed, 2 deletions(-)"    ← insertions absent
 *   ""                                    ← empty range
 *
 * @param {string} cwd
 * @param {string} rangeSpec - e.g. "main..HEAD" or "HEAD~10..HEAD"
 * @returns {Promise<{insertions:number, deletions:number}>}
 */
async function defaultGetDiffStats(cwd, rangeSpec) {
  const r = await _internal.exec(`git diff --shortstat ${rangeSpec}`, { cwd });
  if (r.exitCode !== 0) return { insertions: 0, deletions: 0 };
  const ins = r.stdout.match(/(\d+)\s+insertion/);
  const del = r.stdout.match(/(\d+)\s+deletion/);
  return {
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0
  };
}

/**
 * Count commits in a range via `git rev-list --count <range>`.
 * Returns 0 on any failure (range invalid, repo malformed).
 * @param {string} cwd
 * @param {string} rangeSpec
 * @returns {Promise<number>}
 */
async function defaultGetCommitCount(cwd, rangeSpec) {
  const r = await _internal.exec(`git rev-list --count ${rangeSpec}`, { cwd });
  if (r.exitCode !== 0) return 0;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * List commit subjects in a range via `git log --format=%s <range>`.
 * Returns [] on any failure.
 * @param {string} cwd
 * @param {string} rangeSpec
 * @returns {Promise<string[]>}
 */
async function defaultGetCommitSubjects(cwd, rangeSpec) {
  const r = await _internal.exec(`git log --format=%s ${rangeSpec}`, { cwd });
  if (r.exitCode !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Load `<project>/.tangleclaw/critic-runs.json`. Returns `[]` on any
 * failure (file missing, JSON malformed, non-array contents) — the
 * file is opt-in and a missing one is the normal "no Critic ran" case.
 *
 * Expected shape: `[{branchName: string, timestamp: ISO 8601, ...}, ...]`
 *
 * @param {string} projectPath
 * @returns {Array<{branchName:string, timestamp:string}>}
 */
function defaultLoadCriticRuns(projectPath) {
  const filePath = path.join(projectPath, CRITIC_RUNS_FILENAME);
  if (!fs.existsSync(filePath)) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    log.warn('failed to read critic-runs.json', { filePath, error: err.message });
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('critic-runs.json is not valid JSON', { filePath, error: err.message });
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // Filter to entries that minimally have a string branchName — defensive
  // against partial writes or schema drift.
  return parsed.filter((e) => e && typeof e.branchName === 'string');
}

/**
 * Pick the chunk-tag from a branch name or any commit subject. Branch
 * name wins (more specific to the session); commit subjects searched
 * in order otherwise. Returns `{tag, source}` or `null`.
 *
 * @param {string|null} branchName
 * @param {string[]} subjects
 * @returns {{tag:string, source:'branch'|'commit', match:string}|null}
 */
function _detectChunkTag(branchName, subjects) {
  if (branchName) {
    const m = branchName.match(CHUNK_TAG_RE);
    if (m) return { tag: m[1], source: 'branch', match: m[0] };
  }
  for (const subject of subjects) {
    const m = subject.match(CHUNK_TAG_RE);
    if (m) return { tag: m[1], source: 'commit', match: m[0] };
  }
  return null;
}

/**
 * Pick the most-recent N entries by `timestamp` (string-comparable
 * ISO 8601) descending. Entries without a string `timestamp` sort to
 * the bottom (treated as oldest-unknown). Returns at most N entries.
 *
 * @param {Array<{timestamp?:string}>} entries
 * @param {number} n
 * @returns {Array}
 */
function _selectRecentRuns(entries, n) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  // Stable sort: copy first; ISO 8601 string compare matches chronology
  // for any well-formed timestamp.
  const sorted = entries.slice().sort((a, b) => {
    const ta = typeof a.timestamp === 'string' ? a.timestamp : '';
    const tb = typeof b.timestamp === 'string' ? b.timestamp : '';
    if (ta === tb) return 0;
    return ta > tb ? -1 : 1; // descending
  });
  return sorted.slice(0, n);
}

/**
 * Determine medium+ status from heuristic inputs. Returns `true` if
 * ANY threshold trips. Exposed for testability.
 *
 * @param {object} h - {commits, lineChanges, chunkTag, commitThreshold, lineChangeThreshold}
 * @returns {boolean}
 */
function _isMediumPlus(h) {
  if (h.commits >= h.commitThreshold) return true;
  if (h.lineChanges >= h.lineChangeThreshold) return true;
  if (h.chunkTag) return true;
  return false;
}

/**
 * Choose the git range spec for the session.
 *   - branch === main OR mainBranch unknown OR branch === null →
 *     `HEAD~N..HEAD` (degraded mode; surfaced in output.rangeSpec)
 *   - else → `<mainBranch>..HEAD`
 *
 * @param {string|null} branch
 * @param {string|null} mainBranch
 * @returns {{rangeSpec:string, degraded:boolean, reason:string|null}}
 */
function _pickRange(branch, mainBranch) {
  if (!branch) {
    return {
      rangeSpec: `HEAD~${FALLBACK_RANGE_DEPTH}..HEAD`,
      degraded: true,
      reason: 'current branch unresolved (detached HEAD?)'
    };
  }
  if (!mainBranch) {
    return {
      rangeSpec: `HEAD~${FALLBACK_RANGE_DEPTH}..HEAD`,
      degraded: true,
      reason: 'main branch unresolved (no origin/HEAD symref)'
    };
  }
  if (branch === mainBranch) {
    return {
      rangeSpec: `HEAD~${FALLBACK_RANGE_DEPTH}..HEAD`,
      degraded: true,
      reason: 'working directly on main branch'
    };
  }
  return {
    rangeSpec: `${mainBranch}..HEAD`,
    degraded: false,
    reason: null
  };
}

/**
 * Step handler. See module docstring for full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (must include `path`)
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @param {object} [context.options] - Caller options (e.g. `criticSkipRationale`)
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:true, status:string, output:object, blockers:string[]}>}
 */
async function run(context) {
  const { project, step, staged } = context;
  const options = context.options || {};

  if (!project || !project.path) {
    // Defensive — never blocks, even on misconfiguration. Surface as a
    // skipped step with a reason so the UI can show why.
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'critic-check requires context.project.path' },
      blockers: []
    };
  }

  // Threshold validation: must be a positive integer to be honored.
  // `0` and negatives are footguns (every wrap with ≥ 0 commits would
  // trip medium+) so they fall back to the defaults; floats are
  // rejected because a threshold like `3.7` is semantically odd
  // (commits and lineChanges are integer counts).
  const commitThreshold = Number.isInteger(step.commitThreshold) && step.commitThreshold > 0
    ? step.commitThreshold : DEFAULT_COMMIT_THRESHOLD;
  const lineChangeThreshold = Number.isInteger(step.lineChangeThreshold) && step.lineChangeThreshold > 0
    ? step.lineChangeThreshold : DEFAULT_LINE_CHANGE_THRESHOLD;

  const cwd = project.path;

  // Wrap ALL I/O in a single try/catch so the handler honors the
  // "always returns ok:true" contract (the module docstring + the
  // schema's `blocker: false` rule). Anything thrown by `_internal.*`
  // (git missing, exec timeout that isn't a clean non-zero exit, fs
  // permission, OOM from maxBuffer) becomes a structured skipped
  // result rather than a runner-level "step threw" blocker. Matches
  // the priming-roll / ai-content explicit-catch pattern from Chunks
  // 5 + 6 — drift would re-create the Chunk-7 Critic-MAJOR-1 incident.
  let branch, mainBranch, range, commits, diffStats, subjects, chunkTagInfo;
  try {
    [branch, mainBranch] = await Promise.all([
      _internal.getCurrentBranch(cwd),
      _internal.getMainBranch(cwd)
    ]);
    range = _pickRange(branch, mainBranch);

    [commits, diffStats, subjects] = await Promise.all([
      _internal.getCommitCount(cwd, range.rangeSpec),
      _internal.getDiffStats(cwd, range.rangeSpec),
      _internal.getCommitSubjects(cwd, range.rangeSpec)
    ]);
    chunkTagInfo = _detectChunkTag(branch, subjects);
  } catch (err) {
    log.warn('critic-check git probe failed — degrading to skipped', {
      project: project.name,
      error: err.message
    });
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'git probe failed', error: err.message },
      blockers: []
    };
  }

  const lineChanges = diffStats.insertions + diffStats.deletions;

  const isMediumPlus = _isMediumPlus({
    commits,
    lineChanges,
    chunkTag: chunkTagInfo,
    commitThreshold,
    lineChangeThreshold
  });

  const criticRunsAll = _internal.loadCriticRuns(cwd);
  const criticRunsThisBranch = branch
    ? criticRunsAll.filter((e) => e.branchName === branch)
    : [];
  const criticRan = criticRunsThisBranch.length > 0;

  // #264 / ADR 0002 amendment (2026-05-30): scan critic-runs entries on
  // current branch for BLOCKING findings. Only entries with
  // `ranAt === 'actual'` carry a findings array (per #267 schema);
  // legacy entries (no `ranAt`) and `ranAt: 'ack'` entries are bare
  // acknowledgments and never trigger the halt. Severity match is
  // case-insensitive — the Critic skill writes "blocking" but external
  // producers might write "BLOCKING".
  const blockingFindings = [];
  for (const entry of criticRunsThisBranch) {
    if (entry.ranAt !== 'actual') continue;
    if (!Array.isArray(entry.findings)) continue;
    for (const finding of entry.findings) {
      if (finding
          && typeof finding.severity === 'string'
          && finding.severity.toLowerCase() === 'blocking') {
        blockingFindings.push(finding);
      }
    }
  }

  // Operator-override path: when blocking findings exist AND the
  // operator explicitly opts to proceed anyway (via the wrap drawer's
  // override widget — Chunk 10), record the override + the findings on
  // the commit footer for audit traceability rather than halting.
  // The override MUST be opt-in per click; the runner is not allowed
  // to persist this across sessions.
  const criticBlockingOverride = options.criticBlockingOverride === true;
  const criticBlockingOverrideReason = typeof options.criticBlockingOverrideReason === 'string'
    && options.criticBlockingOverrideReason.trim()
    ? options.criticBlockingOverrideReason.trim()
    : null;

  const warning = isMediumPlus && !criticRan;
  const owedRationale = warning && typeof options.criticSkipRationale === 'string'
    && options.criticSkipRationale.trim()
    ? options.criticSkipRationale.trim()
    : null;

  const output = {
    warning,
    isMediumPlus,
    criticRan,
    branch,
    mainBranch,
    rangeSpec: range.rangeSpec,
    rangeDegraded: range.degraded,
    rangeDegradedReason: range.reason,
    // #264 — surface the BLOCKING-finding metadata so Chunk 10's UI can
    // render the override widget. Empty array means "no Critic-blocking
    // findings on current branch" (covers no-Critic-ran case, ack-only
    // case, and ran-but-no-blockings case).
    blockingFindings,
    blockingFindingCount: blockingFindings.length,
    blockingOverrideApplied: blockingFindings.length > 0 && criticBlockingOverride,
    blockingOverrideReason: criticBlockingOverrideReason,
    heuristic: {
      commits,
      lineChanges,
      insertions: diffStats.insertions,
      deletions: diffStats.deletions,
      chunkTag: chunkTagInfo ? chunkTagInfo.tag : null,
      chunkTagSource: chunkTagInfo ? chunkTagInfo.source : null,
      chunkTagMatch: chunkTagInfo ? chunkTagInfo.match : null,
      commitThreshold,
      lineChangeThreshold
    },
    // Last 3 critic-runs entries (across ALL branches) for the Chunk-10
    // UI to render "last Critic ran at …" context hints — including
    // cross-branch entries so a user who ran Critic on a sibling branch
    // sees that fact when deciding whether to warn here. Sorted by
    // `timestamp` descending when present so callers don't depend on
    // file-write order (which a future producer might trim or re-sort).
    // Unknown / non-string timestamps sort to the bottom. Pass-through
    // is verbatim: any extra fields the producer chose to include on
    // an entry survive into the output (see the `defaultLoadCriticRuns`
    // schema note — `{branchName, timestamp, ...passthrough}`).
    criticRunsRecent: _selectRecentRuns(criticRunsAll, 3),
    owedRationale
  };

  if (warning) {
    // Stage the warning for the Chunk 9 commit step / Chunk 5 memory-update
    // prompt to consume. We stage regardless of whether the rationale is
    // present — the Chunk 10 UI will check `staged.owedRationale === null`
    // to know whether to prompt the user. ai-content's prompt template
    // can interpolate `{criticOwed}` (Chunk 9-or-later) for the MEMORY
    // block; for now staging is just structured data.
    staged[step.id] = {
      warning: true,
      owedRationale,
      branchName: branch,
      isMediumPlus,
      criticRan,
      heuristic: output.heuristic
    };
    log.info('critic-check WARNING — medium+ work with no Critic dispatch', {
      project: project.name,
      branch,
      commits,
      lineChanges,
      chunkTag: chunkTagInfo ? chunkTagInfo.tag : null,
      owedRationale: owedRationale ? '(provided)' : '(none)'
    });
  } else {
    log.info('critic-check ok', {
      project: project.name,
      branch,
      commits,
      lineChanges,
      isMediumPlus,
      criticRan
    });
  }

  // #264 / ADR 0002 amendment: halt pipeline when blocking findings
  // exist AND no operator override is in effect. Returning ok:false
  // pairs with the methodology template's `blocker: "errors-only"`
  // declaration on this step to halt the runner. The blockers array
  // surfaces verbatim in the wrap drawer; the override widget reads
  // `output.blockingFindings` to render its per-finding checklist.
  if (blockingFindings.length > 0 && !criticBlockingOverride) {
    log.info('critic-check BLOCKED — Critic returned blocking findings', {
      project: project.name,
      branch,
      blockingFindingCount: blockingFindings.length
    });
    return {
      ok: false,
      status: 'blocked',
      output: {
        ...output,
        remediation: 'An Independent Critic returned blocking findings. Address each finding listed above, then re-run `/critic verify-resolutions` to confirm the fixes before wrapping again. To proceed without fixing (recorded in the commit body for the audit trail), set context.options.criticBlockingOverride=true with a written rationale in criticBlockingOverrideReason.'
      },
      blockers: [
        `Critic returned ${blockingFindings.length} BLOCKING finding(s) on branch "${branch}":`,
        ...blockingFindings.map((f) => `  - ${f.summary || f.message || JSON.stringify(f)}`),
        'Address the findings and re-run /critic verify-resolutions, or supply context.options.criticBlockingOverride=true with a written rationale in criticBlockingOverrideReason.'
      ]
    };
  }

  // Operator-override-applied: stage the override for the commit-message
  // footer + audit trail. The commit step's `_buildBodyLines` duck-types
  // entries by shape; this entry's `overrideBlockingFindings: true`
  // marker triggers a body line of the form
  // "Critic-override: <reason> (<N> blocking finding(s) ignored)".
  if (blockingFindings.length > 0 && criticBlockingOverride) {
    staged[`${step.id}-blocking-override`] = {
      overrideBlockingFindings: true,
      findingCount: blockingFindings.length,
      findings: blockingFindings,
      reason: criticBlockingOverrideReason,
      branchName: branch
    };
    log.info('critic-check BLOCKING override applied', {
      project: project.name,
      branch,
      findingCount: blockingFindings.length,
      reason: criticBlockingOverrideReason ? '(provided)' : '(none)'
    });
  }

  return {
    ok: true,
    status: 'done',
    output,
    blockers: []
  };
}

const _internal = {
  exec: defaultExec,
  getCurrentBranch: defaultGetCurrentBranch,
  getMainBranch: defaultGetMainBranch,
  getCommitCount: defaultGetCommitCount,
  getDiffStats: defaultGetDiffStats,
  getCommitSubjects: defaultGetCommitSubjects,
  loadCriticRuns: defaultLoadCriticRuns
};

module.exports = {
  run,
  _internal,
  _detectChunkTag,
  _isMediumPlus,
  _pickRange,
  _selectRecentRuns,
  CHUNK_TAG_RE,
  CRITIC_RUNS_FILENAME,
  DEFAULT_COMMIT_THRESHOLD,
  DEFAULT_LINE_CHANGE_THRESHOLD,
  FALLBACK_RANGE_DEPTH
};
