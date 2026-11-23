'use strict';

/**
 * Satisfaction predicate `learnings-entry` for the `learnings-capture` wrap step.
 *
 * The step's gate asks "did the AI change learnings.md while this step ran?" That
 * is the wrong question for an entry that already landed: the session wrote it
 * while preparing to wrap, or the AI finished it after a blocked attempt and the
 * operator pressed Retry. The file carries the entry, nothing changes during the
 * step, and the gate blocks. The only way through was writing more, which the
 * step's own prompt forbids (#843, #1405).
 *
 * This predicate answers "does the file already carry this session's entry?"
 * Both of these must hold:
 *
 *   1. **Written this session** — the file's modification time is at or after the
 *      session's start. An old file nobody touched cannot satisfy the step.
 *   2. **A dated entry inside the session** — a `## YYYY-MM-DD` heading, or the
 *      prompt's no-op line `- YYYY-MM-DD: no novel learnings`, dated on or after
 *      the session's start day and no later than today (local dates, the prompt's
 *      convention). A write that added no entry cannot satisfy the step.
 *
 * Each condition closes the other's hole: a modification time alone credits any
 * edit, and a date alone credits a previous session's entry from earlier today.
 * The remaining limit is an edit that adds no entry while a same-day entry from a
 * previous session is still in the file. It passes, because nothing records the
 * file's content at launch for a path git ignores. The cost is a missing learning,
 * not lost work.
 *
 * The gate stays hard: this is evidence in the file, the same second route
 * `changelog-coverage` gives `changelog-update`, not a waiver. A session whose
 * start time is unknown gets `unavailable`, and the gate falls back to the
 * mutation check.
 *
 * @module lib/wrap-steps/learnings-coverage
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isoLocalDate } = require('./_date');

const VERDICTS = Object.freeze({
  COVERED: 'covered',
  UNCOVERED: 'uncovered',
  UNAVAILABLE: 'unavailable'
});

const HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})\b/;
const NO_OP_RE = /^-\s+(\d{4}-\d{2}-\d{2}):\s*no novel learnings/i;

/**
 * The entry dates a learnings file carries, in file order.
 *
 * @param {string} content - File content
 * @returns {string[]} `YYYY-MM-DD` dates from entry headings and no-op lines
 */
function entryDates(content) {
  const dates = [];
  for (const line of String(content).split(/\r?\n/)) {
    const m = HEADING_RE.exec(line) || NO_OP_RE.exec(line);
    if (m) dates.push(m[1]);
  }
  return dates;
}

/**
 * The project's own registered name for `projectPath`, when it can be
 * determined with more confidence than the final path segment (PRR-A
 * R-Gate R1 BLOCKING 1, PR #3239): many registered projects have
 * `project.name !== path.basename(project.path)` (e.g. a checkout cloned
 * under a different directory name than the project was registered
 * under). Resolution order:
 *   1. `deps.projectName`, when the caller already has the project row
 *      (`learnings-db-write.js`'s `context.project.name`).
 *   2. `deps.store.projects.getByPath(projectPath)`, when a store handle
 *      is available but the caller didn't thread a name through
 *      (`evaluate` itself receives only `projectPath`).
 *   3. `null` — caller falls back to `path.basename(projectPath)`.
 * @param {string} projectPath
 * @param {object} deps - `{projectName, store}` seams
 * @returns {string|null}
 */
function _resolveProjectName(projectPath, deps) {
  if (typeof deps.projectName === 'string' && deps.projectName.trim()) {
    return deps.projectName.trim();
  }
  if (deps.store && deps.store.projects && typeof deps.store.projects.getByPath === 'function') {
    try {
      const row = deps.store.projects.getByPath(projectPath);
      if (row && typeof row.name === 'string' && row.name.trim()) return row.name.trim();
    } catch {
      // Falls through to the basename fallback below.
    }
  }
  return null;
}

/**
 * The TCC-exempt managed workspace mirror of a project-relative path
 * (#3216 Pillar 4): `~/.tangleclaw/workspaces/<project>/<rel>`, never
 * under a TCC-protected root like `~/Documents` — so a `learnings.md`
 * write a session's shell made THERE (because `<project.path>` itself hit
 * macOS TCC `EPERM`/`EACCES`) can still satisfy this step.
 *
 * `deps.projectName` (or a store lookup via `_resolveProjectName`), when
 * available, names the project directly; otherwise this falls back to
 * `path.basename(projectPath)`, which is only an approximation — see
 * `_managedFallbackCandidatePaths` for checking BOTH when they differ.
 * @param {string} projectPath - Absolute project root (the primary path's own base)
 * @param {string} rel - The step's declared `verifyChanged` path, relative to `projectPath`
 * @param {object} deps - `{homedir, managedWorkspacesDir, projectName, store}` seams
 * @returns {string}
 */
function _managedFallbackPath(projectPath, rel, deps) {
  const homedir = deps.homedir || os.homedir;
  const managedWorkspacesDir = deps.managedWorkspacesDir || path.join(homedir(), '.tangleclaw', 'workspaces');
  const name = _resolveProjectName(projectPath, deps) || path.basename(projectPath);
  return path.join(managedWorkspacesDir, name, rel);
}

/**
 * Every managed-fallback path worth checking, most-canonical first (PRR-A
 * R-Gate R1 BLOCKING 1, PR #3239): the project's own registered name
 * (`_resolveProjectName`) when it can be determined, THEN
 * `path.basename(projectPath)` too when that differs — covering both a
 * checkout whose directory name doesn't match its registered name, and
 * one where it does (the common case, where this returns a single path).
 * @param {string} projectPath
 * @param {string} rel
 * @param {object} deps
 * @returns {string[]} 1 or 2 absolute paths, in priority order
 */
function _managedFallbackCandidatePaths(projectPath, rel, deps) {
  const canonical = _resolveProjectName(projectPath, deps);
  const basename = path.basename(projectPath);
  const names = canonical ? [canonical] : [basename];
  if (canonical && canonical !== basename) names.push(basename);
  return names.map((name) => _managedFallbackPath(projectPath, rel, { ...deps, projectName: name }));
}

/**
 * Stat + read one candidate path, never throwing.
 * @param {string} abs - Absolute path
 * @param {function} stat
 * @param {function} read
 * @returns {{ok: true, path: string, mtimeMs: number, content: string}|{ok: false, path: string, error: string}}
 */
function _readCandidate(abs, stat, read) {
  try {
    const mtimeMs = stat(abs).mtimeMs;
    const content = read(abs);
    return { ok: true, path: abs, mtimeMs, content };
  } catch (err) {
    return { ok: false, path: abs, error: String((err && (err.code || err.message)) || err) };
  }
}

/**
 * Best-effort control-plane mirror sync (#3216 Pillar 4): whenever the
 * managed workspace fallback was the chosen candidate — because the
 * primary path is TCC-blocked, or simply fresher — try to write that same
 * content back to the primary path, so a later read (this session's own,
 * or a human's) converges on it once TCC allows writing again. NEVER
 * throws and never affects a caller's verdict: a TCC-blocked primary
 * fails the write exactly as it failed the read, and that failure is the
 * expected case, not an error to surface.
 * @param {string} primaryAbs - `<projectPath>/<rel>` — the write target
 * @param {string} content - The chosen (managed-fallback) candidate's content
 * @param {object} [deps] - `{write}` seam: `(abs, content) => void`, throws on failure
 * @returns {boolean} Whether the mirror write succeeded
 */
function _mirrorBack(primaryAbs, content, deps = {}) {
  const write = deps.write || ((abs, c) => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, c);
  });
  try {
    write(primaryAbs, content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Judge whether the declared learnings file already carries this session's entry.
 *
 * #3216 (Pillar 4): each declared path is checked at its ordinary
 * location (`<projectPath>/<rel>`) and EVERY TCC-exempt managed workspace
 * mirror candidate (`_managedFallbackCandidatePaths` — the project's
 * canonical name, and `path.basename(projectPath)` too when that
 * differs) — covering the macOS TCC `EPERM`/`EACCES` case (the primary is
 * unreadable at all), the case where multiple are readable but a managed
 * copy is the fresher one, and a checkout whose directory name doesn't
 * match the project's registered name.
 *
 * PRR-A R-Gate R1 BLOCKING 2 (PR #3239): every READABLE candidate is
 * first checked against the SAME two conditions this predicate has
 * always required (written this session, a dated entry inside it) —
 * validity is judged BEFORE a candidate can win, not after. Among the
 * candidates that are both readable and valid, the fresher one (by
 * `mtimeMs`) wins; a tie keeps the primary. A readable-but-INVALID
 * candidate (e.g. a newer managed fallback with no entry for this
 * session) can never win over a readable, valid primary just for being
 * fresher — it is excluded from the pick entirely. Whenever the winning
 * candidate is a managed fallback, a best-effort mirror write copies its
 * content back to the primary path (`_mirrorBack`) — never gates the
 * verdict, reported only as `mirroredBack`.
 * @param {string} projectPath - Absolute root the paths are relative to
 * @param {string[]} paths - The step's `verifyChanged` paths
 * @param {object|null} scope - The wrap run's scope; `startedAtMs` is the session start
 * @param {object} [deps] - Test seams: `{stat, read, write, now, homedir, managedWorkspacesDir, projectName, store}`
 * @returns {{verdict: string, path: (string|null), entryDate: (string|null), reason: (string|null), source?: ('primary'|'managed-fallback'), mirroredBack?: boolean}}
 */
function evaluate(projectPath, paths, scope, deps = {}) {
  const stat = deps.stat || ((p) => fs.statSync(p));
  const read = deps.read || ((p) => fs.readFileSync(p, 'utf8'));
  const now = deps.now || (() => Date.now());

  const startedAtMs = scope && Number.isFinite(scope.startedAtMs) ? scope.startedAtMs : null;
  if (startedAtMs === null) {
    return { verdict: VERDICTS.UNAVAILABLE, path: null, entryDate: null, reason: 'the session start time is unknown' };
  }

  const fromDate = isoLocalDate(startedAtMs);
  const toDate = isoLocalDate(now());
  const reasons = [];

  for (const rel of paths) {
    const primaryAbs = path.join(projectPath, rel);
    const candidates = [
      { ..._readCandidate(primaryAbs, stat, read), source: 'primary' },
      ..._managedFallbackCandidatePaths(projectPath, rel, deps)
        .map((abs) => ({ ..._readCandidate(abs, stat, read), source: 'managed-fallback' }))
    ];

    let best = null;
    const unreadableErrors = [];
    const invalidReasons = [];
    for (const c of candidates) {
      if (!c.ok) {
        unreadableErrors.push(`${c.source === 'primary' ? 'the project path' : 'the managed workspace fallback'} (${c.path}: ${c.error})`);
        continue;
      }
      if (!(c.mtimeMs >= startedAtMs)) {
        invalidReasons.push(`${rel} (${c.source}) has not been written since this session started`);
        continue;
      }
      const inSession = entryDates(c.content).filter((d) => d >= fromDate && d <= toDate);
      if (inSession.length === 0) {
        invalidReasons.push(fromDate === toDate
          ? `${rel} (${c.source}) carries no entry dated ${toDate}`
          : `${rel} (${c.source}) carries no entry dated ${fromDate} through ${toDate}`);
        continue;
      }
      if (!best || c.mtimeMs > best.mtimeMs) {
        best = { ...c, entryDate: inSession[inSession.length - 1] };
      }
    }

    if (best) {
      const mirroredBack = best.source === 'managed-fallback'
        ? _mirrorBack(primaryAbs, best.content, deps)
        : undefined;
      return {
        verdict: VERDICTS.COVERED, path: rel, entryDate: best.entryDate, reason: null, source: best.source,
        ...(best.source === 'managed-fallback' ? { mirroredBack } : {})
      };
    }

    if (unreadableErrors.length > 0 && invalidReasons.length === 0) {
      reasons.push(`${rel} could not be read from ${unreadableErrors.join(' or ')}`);
    } else {
      reasons.push(...invalidReasons);
      if (unreadableErrors.length > 0) {
        reasons.push(`${rel} additionally could not be read from ${unreadableErrors.join(' or ')}`);
      }
    }
  }

  return { verdict: VERDICTS.UNCOVERED, path: null, entryDate: null, reason: reasons.join('; ') || 'no path declared' };
}

module.exports = {
  evaluate, entryDates, VERDICTS,
  _managedFallbackPath, _managedFallbackCandidatePaths, _resolveProjectName,
  _readCandidate, _mirrorBack
};
