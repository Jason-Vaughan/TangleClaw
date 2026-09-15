'use strict';

/**
 * Release readiness: the deterministic signals that say whether a wrap is a
 * sensible place to cut a release, and the verdict they add up to.
 *
 * WHY THE VERDICT IS DETERMINISTIC. TangleClaw wraps projects on many engines,
 * and the ledger a release writes (version.json, the promoted CHANGELOG, the
 * change-log stamps) must come out identical on every one of them. So the
 * decision to cut is made here, from files alone. A model may later add a
 * narrative recommendation beside it, but it never decides, because two models
 * reading the same session would disagree and produce two different ledgers.
 *
 * Two layers, kept apart on purpose:
 *  - `evaluateReleaseReadiness(signals)` is pure. It reads nothing, so the
 *    aggregation rule can be tested exhaustively without a filesystem.
 *  - `gatherReleaseSignals(projectPath, input)` produces the signals. It reads
 *    only files under the project root: no subprocess, no network, no engine
 *    path.
 *
 * Signal states:
 *  - `pass`: the signal says ready.
 *  - `fail`: the signal says not ready, for a reason it can name.
 *  - `unknown`: the signal applies but couldn't be read. It never counts as a pass.
 *  - `n/a`: the signal doesn't apply to this project (a project with no build
 *    plan has no plan to be mid-way through). It doesn't count either way.
 *
 * Signals deliberately NOT gathered:
 *  - A clean working tree. A wrap commits the session's own work, so a dirty
 *    tree is the normal state at wrap time, not evidence of anything.
 *  - Whether the linked issue is closed. That needs the network and GitHub
 *    credentials, so it can't be answered from files, and a gate that depends
 *    on it would give different answers offline.
 *
 * @module lib/release-readiness
 */

const fs = require('node:fs');
const path = require('node:path');
const projectPaths = require('./project-paths');

const VERDICTS = Object.freeze({ READY: 'ready', NOT_READY: 'not-ready', UNKNOWN: 'unknown' });
const SIGNAL_STATES = Object.freeze(['pass', 'fail', 'unknown', 'n/a']);

const PROJECT_STATE_REL = path.join('.prawduct', 'project-state.yaml');
// Where Prawduct looks when the pointer is unset, relative to `.prawduct/`.
const DEFAULT_PLAN_REL = path.join('artifacts', 'build-plan.md');
// A top-level (unindented) scalar only. The value may be bare, single- or
// double-quoted, and may carry a trailing `# comment`.
const ACTIVE_PLAN_RE = /^active_build_plan:[ \t]*(.*)$/m;
const STATUS_HEADING_RE = /^## Status\s*$/;
const NEXT_H2_RE = /^## /;
const BOX_RE = /^\s*[-*]\s+\[( |x|X)\]/;

/**
 * Aggregate signals into a verdict.
 *
 * Any `fail` makes the verdict `not-ready`. Otherwise any `unknown` makes it
 * `unknown`. Otherwise it is `ready`, and `n/a` signals count for nothing. An
 * empty signal list, or a signal in a state this module doesn't define, gives
 * `unknown`: a verdict of `ready` must rest on at least one signal that
 * actually passed.
 *
 * @param {Array<{id:string, state:string, detail:string}>} signals
 * @returns {{verdict:'ready'|'not-ready'|'unknown', signals:Array<{id:string, state:string, detail:string}>, reason:string}}
 *   `reason` is one operator-facing sentence naming the signals that decided it.
 */
function evaluateReleaseReadiness(signals) {
  const list = Array.isArray(signals) ? signals : [];
  const malformed = list.filter((s) => !s || !SIGNAL_STATES.includes(s.state));
  if (malformed.length > 0) {
    return {
      verdict: VERDICTS.UNKNOWN,
      signals: list,
      reason: `readiness signal in an unrecognized state (${malformed.map((s) => (s && s.id) || '?').join(', ')})`
    };
  }
  const failed = list.filter((s) => s.state === 'fail');
  if (failed.length > 0) {
    return { verdict: VERDICTS.NOT_READY, signals: list, reason: _describe(failed) };
  }
  const unknown = list.filter((s) => s.state === 'unknown');
  if (unknown.length > 0) {
    return { verdict: VERDICTS.UNKNOWN, signals: list, reason: _describe(unknown) };
  }
  const passed = list.filter((s) => s.state === 'pass');
  if (passed.length === 0) {
    return { verdict: VERDICTS.UNKNOWN, signals: list, reason: 'no readiness signal applies to this project' };
  }
  return { verdict: VERDICTS.READY, signals: list, reason: _describe(passed) };
}

/**
 * Join signals into one reason sentence: `id: detail; id: detail`.
 *
 * @param {Array<{id:string, detail:string}>} signals
 * @returns {string}
 */
function _describe(signals) {
  return signals.map((s) => `${s.id}: ${s.detail}`).join('; ');
}

/**
 * Gather this chunk's readiness signals for a project.
 *
 * The CHANGELOG is handed in already parsed, not re-read, because the only
 * caller (the version-bump step) has just parsed it with the parser that decides
 * what gets promoted. A second parser here could disagree with that one about
 * what counts as an entry.
 *
 * @param {string} projectPath - Absolute project root
 * @param {object} input
 * @param {{found:boolean, sectionFound:boolean, hasEntries:boolean}} input.changelog -
 *   What the caller's CHANGELOG parse found.
 * @returns {Array<{id:string, state:string, detail:string}>}
 */
function gatherReleaseSignals(projectPath, input = {}) {
  return [
    unreleasedEntriesSignal(input.changelog),
    buildPlanStatusSignal(projectPath)
  ];
}

/**
 * `unreleased-entries`: is there anything to release?
 *
 * @param {{found:boolean, sectionFound:boolean, hasEntries:boolean}} [changelog]
 * @returns {{id:string, state:string, detail:string}}
 */
function unreleasedEntriesSignal(changelog) {
  const id = 'unreleased-entries';
  if (!changelog || !changelog.found) {
    return { id, state: 'unknown', detail: 'CHANGELOG.md not found' };
  }
  if (!changelog.sectionFound) {
    return { id, state: 'unknown', detail: 'CHANGELOG.md has no [Unreleased] section' };
  }
  return changelog.hasEntries
    ? { id, state: 'pass', detail: '[Unreleased] has entries' }
    : { id, state: 'fail', detail: '[Unreleased] is empty' };
}

/**
 * Read the `active_build_plan:` pointer from `.prawduct/project-state.yaml`.
 *
 * Only the pointer is trusted to name the plan in flight. A directory of plan
 * files routinely holds finished ones nobody archived, and treating any of them
 * as active would hold every release on work that already shipped.
 *
 * @param {string} projectPath - Absolute project root
 * @returns {{present:false}|{present:true, value:string|null}|{present:true, error:string}}
 *   `present:false` when there is no project-state file; `value:null` when the
 *   file has no pointer or the pointer is null/empty.
 */
function readActiveBuildPlanPointer(projectPath) {
  const statePath = path.join(projectPath, PROJECT_STATE_REL);
  let text;
  try {
    text = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { present: false };
    return { present: true, error: `project-state.yaml unreadable (${err.code || err.message})` };
  }
  const m = ACTIVE_PLAN_RE.exec(text);
  if (!m) return { present: true, value: null };
  let raw = m[1].trim();
  const quoted = /^(['"])(.*)\1(\s+#.*)?$/.exec(raw);
  if (quoted) {
    raw = quoted[2];
  } else {
    raw = raw.replace(/\s+#.*$/, '').trim();
  }
  if (raw === '' || raw === 'null' || raw === '~') return { present: true, value: null };
  return { present: true, value: raw };
}

/**
 * `build-plan-status`: is the plan in flight finished?
 *
 * Resolves the active plan the way Prawduct's `project-state.yaml` template
 * defines the pointer: the value is relative to `.prawduct/` (a
 * `.prawduct/...` spelling is tolerated), and an unset or null pointer means
 * `artifacts/build-plan.md`. It then reads that plan's `## Status` section and
 * fails on any unticked box.
 *
 * Two deliberate differences from Prawduct's own resolution:
 *  - A plan claiming a branch in its frontmatter is not consulted. A wrap runs
 *    on the branch work integrates onto, which no feature plan claims.
 *  - A pointer naming a file that doesn't exist is `unknown`, not "no plan".
 *    Prawduct can afford to warn and carry on; a release gate that read a
 *    dangling pointer as "nothing in flight" would cut on a misconfiguration.
 *
 * A plan with no `## Status` section is `n/a`: plans written before that
 * convention track progress in per-chunk checklists, where an unticked box is
 * as often a struck-out, descoped item as unfinished work. Judging those would
 * hold such a project's releases indefinitely. A `## Status` section with no
 * checkboxes in it is `unknown`, since the plan claims the format and can't be
 * read by it.
 *
 * @param {string} projectPath - Absolute project root
 * @returns {{id:string, state:string, detail:string}}
 */
function buildPlanStatusSignal(projectPath) {
  const id = 'build-plan-status';
  const pointer = readActiveBuildPlanPointer(projectPath);
  if (!pointer.present) return { id, state: 'n/a', detail: 'no .prawduct/project-state.yaml' };
  if (pointer.error) return { id, state: 'unknown', detail: pointer.error };

  const explicit = pointer.value !== null;
  const rel = explicit ? pointer.value.replace(/^\.prawduct[\\/]/, '') : DEFAULT_PLAN_REL;
  const label = path.posix.join('.prawduct', rel.split(path.sep).join('/'));
  const resolved = projectPaths.resolveWithinProject(projectPath, path.join('.prawduct', rel));
  if (!resolved.ok) {
    return { id, state: 'unknown', detail: `active_build_plan ${JSON.stringify(pointer.value)} ${resolved.reason}` };
  }
  let planText;
  try {
    planText = fs.readFileSync(resolved.path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' && !explicit) {
      return { id, state: 'n/a', detail: 'no active build plan' };
    }
    const why = err.code === 'ENOENT' ? 'does not exist' : `is unreadable (${err.code || err.message})`;
    return { id, state: 'unknown', detail: `active build plan ${label} ${why}` };
  }
  const boxes = _statusBoxes(planText);
  if (boxes === null) {
    return { id, state: 'n/a', detail: `active build plan ${label} has no ## Status section to judge` };
  }
  if (boxes.length === 0) {
    return { id, state: 'unknown', detail: `active build plan ${label} has a ## Status section with no checkboxes` };
  }
  const open = boxes.filter((b) => !b.ticked);
  if (open.length > 0) {
    return { id, state: 'fail', detail: `${open.length} of ${boxes.length} Status boxes unticked in ${label}` };
  }
  return { id, state: 'pass', detail: `every Status box ticked in ${label}` };
}

/**
 * Extract the checkboxes under a plan's `## Status` heading.
 *
 * @param {string} planText
 * @returns {Array<{ticked:boolean, line:string}>|null} null when the plan has no
 *   `## Status` heading at all.
 */
function _statusBoxes(planText) {
  const lines = String(planText).split('\n');
  const start = lines.findIndex((l) => STATUS_HEADING_RE.test(l));
  if (start === -1) return null;
  const boxes = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (NEXT_H2_RE.test(lines[i])) break;
    const m = BOX_RE.exec(lines[i]);
    if (m) boxes.push({ ticked: m[1] !== ' ', line: lines[i] });
  }
  return boxes;
}

module.exports = {
  VERDICTS,
  SIGNAL_STATES,
  evaluateReleaseReadiness,
  gatherReleaseSignals,
  unreleasedEntriesSignal,
  buildPlanStatusSignal,
  readActiveBuildPlanPointer,
  _statusBoxes
};
