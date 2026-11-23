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
 * The TCC-exempt managed workspace mirror of a project-relative path
 * (#3216 Pillar 4): `~/.tangleclaw/workspaces/<project>/<rel>`, never
 * under a TCC-protected root like `~/Documents` — so a `learnings.md`
 * write a session's shell made THERE (because `<project.path>` itself hit
 * macOS TCC `EPERM`/`EACCES`) can still satisfy this step.
 *
 * `evaluate` receives only `projectPath` (not the full project row), so
 * the project's own name is derived from the final path segment — the
 * convention every project row this codebase creates actually follows
 * (`path.basename(project.path) === project.name`, confirmed against this
 * module's own test fixtures and the real store's `create`). Best-effort
 * by construction: a project path that genuinely violates that convention
 * degrades to a fallback candidate this file never finds, not a thrown
 * error — `_readCandidate` below treats "does not exist" the same as any
 * other unreadable candidate.
 * @param {string} projectPath - Absolute project root (the primary path's own base)
 * @param {string} rel - The step's declared `verifyChanged` path, relative to `projectPath`
 * @param {object} deps - `{homedir, managedWorkspacesDir}` seams
 * @returns {string}
 */
function _managedFallbackPath(projectPath, rel, deps) {
  const homedir = deps.homedir || os.homedir;
  const managedWorkspacesDir = deps.managedWorkspacesDir || path.join(homedir(), '.tangleclaw', 'workspaces');
  return path.join(managedWorkspacesDir, path.basename(projectPath), rel);
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
 * #3216 (Pillar 4): each declared path is checked at BOTH its ordinary
 * location (`<projectPath>/<rel>`) and its TCC-exempt managed workspace
 * mirror (`_managedFallbackPath`) — covering both the macOS TCC `EPERM`/
 * `EACCES` case (the primary is unreadable at all) and the case where
 * BOTH are readable but the managed copy is the fresher one (a session
 * whose shell wrote there this run). When both candidates are readable,
 * the one with the later `mtimeMs` is judged; a tie keeps the primary.
 * Whenever the managed fallback is the chosen candidate, a best-effort
 * mirror write copies its content back to the primary path (`_mirrorBack`)
 * — never gates the verdict, reported only as `mirroredBack`.
 * @param {string} projectPath - Absolute root the paths are relative to
 * @param {string[]} paths - The step's `verifyChanged` paths
 * @param {object|null} scope - The wrap run's scope; `startedAtMs` is the session start
 * @param {object} [deps] - Test seams: `{stat, read, write, now, homedir, managedWorkspacesDir}`
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
    const primary = _readCandidate(path.join(projectPath, rel), stat, read);
    const fallback = _readCandidate(_managedFallbackPath(projectPath, rel, deps), stat, read);
    let chosen = null;
    let source = null;
    if (primary.ok && fallback.ok) {
      if (fallback.mtimeMs > primary.mtimeMs) { chosen = fallback; source = 'managed-fallback'; }
      else { chosen = primary; source = 'primary'; }
    } else if (primary.ok) {
      chosen = primary; source = 'primary';
    } else if (fallback.ok) {
      chosen = fallback; source = 'managed-fallback';
    }
    const mirroredBack = source === 'managed-fallback'
      ? _mirrorBack(path.join(projectPath, rel), chosen.content, deps)
      : undefined;
    if (!chosen) {
      reasons.push(`${rel} could not be read from the project path (${primary.error}) or the managed workspace fallback (${fallback.error})`);
      continue;
    }
    if (!(chosen.mtimeMs >= startedAtMs)) {
      reasons.push(`${rel} (${source}) has not been written since this session started`);
      continue;
    }
    const inSession = entryDates(chosen.content).filter((d) => d >= fromDate && d <= toDate);
    if (inSession.length === 0) {
      reasons.push(fromDate === toDate
        ? `${rel} (${source}) carries no entry dated ${toDate}`
        : `${rel} (${source}) carries no entry dated ${fromDate} through ${toDate}`);
      continue;
    }
    return {
      verdict: VERDICTS.COVERED, path: rel, entryDate: inSession[inSession.length - 1], reason: null, source,
      ...(source === 'managed-fallback' ? { mirroredBack } : {})
    };
  }

  return { verdict: VERDICTS.UNCOVERED, path: null, entryDate: null, reason: reasons.join('; ') || 'no path declared' };
}

module.exports = { evaluate, entryDates, VERDICTS, _managedFallbackPath, _readCandidate, _mirrorBack };
