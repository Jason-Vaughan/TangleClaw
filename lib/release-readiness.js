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
 *  - `gatherReleaseSignals(projectPath, input)` produces the signals.
 *    `unreleased-entries` and `build-plan-status` read only files under the
 *    project root; `linked-issue-closed` (below) is the one exception, and is
 *    bounded by its own timeout so a slow or missing `gh` cannot hang a wrap.
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
 *
 * `linked-issue-closed` (`linkedIssueClosedSignal`) IS gathered by default
 * (Architect ruling `A481-R5`, #1495/#2681): a project with no linked issue
 * reaches no network at all (`_discoverLinkedIssueNumbers` returns `[]`, the
 * signal reads `n/a` immediately), and when one IS linked, the default lookup
 * is a single bounded `gh issue view --json state` (5s timeout) — never a
 * caller-visible hang. `input.includeLinkedIssue === false` opts a caller back
 * out entirely; `options.checkGithub === false` keeps the signal (still
 * discovers the issue) but skips the network call, reading `unknown` instead.
 * A caller that injects `options.fetchIssueState`/`options.execGh` (e.g. a
 * test, or a future caller with its own cached lookup) is used ahead of the
 * default either way.
 *
 * @module lib/release-readiness
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const projectPaths = require('./project-paths');

/** Overridable for tests; the real `gh` call otherwise (see {@link _issueStateLookup}). */
const _internal = { execFileSync };

const VERDICTS = Object.freeze({ READY: 'ready', NOT_READY: 'not-ready', UNKNOWN: 'unknown' });
const SIGNAL_STATES = Object.freeze(['pass', 'fail', 'unknown', 'n/a']);

const PROJECT_STATE_REL = path.join('.prawduct', 'project-state.yaml');
// Where Prawduct looks when the pointer is unset, relative to `.prawduct/`.
const DEFAULT_PLAN_REL = path.join('artifacts', 'build-plan.md');
// A top-level (unindented) scalar only. The value may be bare, single- or
// double-quoted, and may carry a trailing `# comment`.
const ACTIVE_PLAN_RE = /^active_build_plan:[ \t]*(.*)$/m;
// The same heading rule `lib/wrap-steps/priming-roll.js` reads these plans by,
// so `## Status — Train 19` is a Status section to both of them.
const STATUS_HEADING_RE = /^##\s+Status\b/i;
const NEXT_H2_RE = /^## /;
const BOX_RE = /^\s*[-*]\s+\[( |x|X)\]/;
// Lexical containment, as priming-roll uses for the same pointer: a worktree
// routinely symlinks `.prawduct/` state back to its primary checkout, and
// following the link would read every such plan as an escape. The plan is only
// read and its boxes counted; nothing is written through the pointer.
const PLAN_POINTER_CONTAINMENT = Object.freeze({ followSymlinks: false });

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
 * @param {string} [input.configRoot] - The registered project folder, when the
 *   wrap runs in a worktree of it; see {@link prawductRootFor}.
 * @param {boolean} [input.includeLinkedIssue=true] - Set `false` to omit
 *   {@link linkedIssueClosedSignal} entirely (A481-R5 default: included).
 * @param {number|string} [input.issueNumber] - See {@link linkedIssueClosedSignal}.
 * @param {Array<number|string>} [input.issueNumbers] - See {@link linkedIssueClosedSignal}.
 * @param {boolean} [input.checkGithub] - See {@link linkedIssueClosedSignal}.
 * @param {Function} [input.fetchIssueState] - See {@link linkedIssueClosedSignal}.
 * @param {Function} [input.execGh] - See {@link linkedIssueClosedSignal}.
 * @returns {Array<{id:string, state:string, detail:string}>}
 */
function gatherReleaseSignals(projectPath, input = {}) {
  const signals = [
    unreleasedEntriesSignal(input.changelog),
    buildPlanStatusSignal(prawductRootFor(projectPath, input.configRoot))
  ];
  if (input.includeLinkedIssue !== false) {
    signals.push(linkedIssueClosedSignal(projectPath, input));
  }
  return signals;
}

/**
 * Pick the checkout whose `.prawduct/` state describes the work being wrapped.
 *
 * A wrap can run in a git worktree whose registered project folder is a
 * different checkout (`project.path` versus `configRootOf(project)`). Prawduct
 * state is gitignored, so a worktree either carries it (a real copy, or
 * symlinks to the primary) or has none at all. The worktree's own state wins
 * when it has any, because that is the plan the session was working to. With
 * none, the registered checkout's is read. Reading nothing there would make
 * the signal `n/a`, and an `auto` release would cut while the plan in the
 * primary checkout still has unticked boxes.
 *
 * @param {string} projectPath - The checkout being wrapped
 * @param {string} [configRoot] - The registered project folder, when it differs
 * @returns {string} The root to read `.prawduct/` state from
 */
function prawductRootFor(projectPath, configRoot) {
  if (!configRoot || configRoot === projectPath) return projectPath;
  return fs.existsSync(path.join(projectPath, PROJECT_STATE_REL)) ? projectPath : configRoot;
}

/**
 * `unreleased-entries`: is there anything to release?
 *
 * A changelog fragment waiting under `changelog.d/` (#1220) is an entry of the
 * next release, so pending fragments pass this signal with an empty
 * `[Unreleased]`. A fragment set the contract refuses is `unknown`: the
 * version-bump step stops on it and names the files, and a verdict built on it
 * must not read as ready. The caller hands the fragment facts in with the parse,
 * for the same reason it hands in the parse: one reader of the directory, the
 * one that compiles it.
 *
 * @param {{found:boolean, sectionFound:boolean, hasEntries:boolean, fragments?:{ok:boolean, count:number}}} [changelog]
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
  const fragments = changelog.fragments && typeof changelog.fragments === 'object' ? changelog.fragments : null;
  if (fragments && fragments.ok === false) {
    return { id, state: 'unknown', detail: 'changelog.d/ holds files the fragment contract refuses' };
  }
  const pending = fragments && Number.isInteger(fragments.count) && fragments.count > 0 ? fragments.count : 0;
  if (changelog.hasEntries) {
    return { id, state: 'pass', detail: pending > 0 ? `[Unreleased] has entries, ${pending} of them changelog fragment(s)` : '[Unreleased] has entries' };
  }
  if (pending > 0) {
    return { id, state: 'pass', detail: `${pending} changelog fragment(s) wait under changelog.d/` };
  }
  return { id, state: 'fail', detail: '[Unreleased] is empty' };
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
  const resolved = projectPaths.resolveWithinProject(projectPath, path.join('.prawduct', rel), PLAN_POINTER_CONTAINMENT);
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

// A line naming the issue this plan is for, e.g. `**Issue:** #123`, `Issue: #123`,
// or bare `Issue #123`. The colon is optional so all three spellings match.
// `\**` (not `\*{0,2}`) before AND after `issue`/the colon: `**Issue:**` has
// its colon INSIDE the closing bold markers (`issue` + `:` + `**`), while
// `**Issue**:` has it outside (`issue` + `**` + `:`) — a fixed 0-2 count on
// each side only covers one ordering and leaves `** ` as leading noise in
// the capture for the other, which broke the leading-anchor extraction below
// (Critic finding, #2681/#1495 PR #2692).
const ISSUE_HEADER_LINE_RE = /^\s*\**issue\**:?\**\s*(.+)$/im;
// Only the LEADING run of issue references right after "Issue:" is trusted —
// this repo's own real plans write `Issue: https://.../issues/2322 (OPEN...
// ...then #2323 chunk 01...)` on one line, where a later cross-reference or
// build-order note carries its own `#N` that is NOT the line's subject
// (Critic finding, #2681/#1495 PR #2692: scanning the whole line resolved
// #2322's own plan to #2323 instead).
const LEADING_ISSUE_RUN_RE = /^\s*((?:(?:https?:\/\/\S*?\/issues\/\d+|#\d+)\s*(?:[,&]|and)?\s*)+)/i;
const ISSUE_TOKEN_RE = /(?:\/issues\/(\d+)|#(\d+))/g;
const BARE_ISSUE_NUMBER_RE = /^\s*(\d+)\s*$/;
const FIXES_CLOSES_RESOLVES_RE = /\b(?:fixes|closes|resolves)\s+#(\d+)/gi;

/**
 * Read the active build plan's raw text, by the same `active_build_plan:`
 * pointer resolution {@link buildPlanStatusSignal} uses — one pointer
 * mechanism, so this signal and that one can never disagree about which plan
 * is active. Unlike that signal, a missing/unreadable plan is not itself
 * notable here: it just means issue discovery falls through to the next
 * source, which {@link _discoverLinkedIssueNumbers} decides.
 *
 * @param {string} projectPath
 * @returns {string|null}
 */
function _activeBuildPlanText(projectPath) {
  const pointer = readActiveBuildPlanPointer(projectPath);
  if (!pointer.present || pointer.error) return null;
  const explicit = pointer.value !== null;
  const rel = explicit ? pointer.value.replace(/^\.prawduct[\\/]/, '') : DEFAULT_PLAN_REL;
  const resolved = projectPaths.resolveWithinProject(projectPath, path.join('.prawduct', rel), PLAN_POINTER_CONTAINMENT);
  if (!resolved.ok) return null;
  try {
    return fs.readFileSync(resolved.path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Pull the active plan's own linked issue number(s) off its `Issue:` header
 * line — only the leading run of `#N`/issue-URL tokens right after the
 * label, never a `#N` appearing later in the line's prose (a cross-reference,
 * a build-order note). A bare number with no `#`/URL marker is trusted only
 * when it is the entire line, so a stray digit deeper in the sentence is
 * never mistaken for it.
 * @param {string|null} planText
 * @returns {number[]}
 */
function _issueNumbersFromPlan(planText) {
  if (!planText) return [];
  const m = ISSUE_HEADER_LINE_RE.exec(planText);
  if (!m) return [];
  const run = LEADING_ISSUE_RUN_RE.exec(m[1]);
  if (run) {
    return [...new Set([...run[1].matchAll(ISSUE_TOKEN_RE)].map((x) => Number(x[1] || x[2])))];
  }
  const bare = BARE_ISSUE_NUMBER_RE.exec(m[1]);
  return bare ? [Number(bare[1])] : [];
}

/**
 * Pull every issue number off `Fixes #N` / `Closes #N` / `Resolves #N` in a
 * list of commit subjects/bodies.
 * @param {Array<string>|undefined} commits
 * @returns {number[]}
 */
function _issueNumbersFromCommits(commits) {
  if (!Array.isArray(commits)) return [];
  const nums = new Set();
  for (const commit of commits) {
    if (typeof commit !== 'string') continue;
    for (const m of commit.matchAll(FIXES_CLOSES_RESOLVES_RE)) nums.add(Number(m[1]));
  }
  return [...nums];
}

/**
 * Decide which issue number(s) `linkedIssueClosedSignal` judges, in order of
 * precedence: an explicit number always wins (the caller knows better than
 * any discovery); failing that, the active plan's own `Issue:` line; failing
 * that, any `Fixes #N`-style commit trailer the caller handed in.
 *
 * @param {string} projectPath
 * @param {object} options
 * @returns {number[]}
 */
function _discoverLinkedIssueNumbers(projectPath, options) {
  if (options.issueNumber !== undefined && options.issueNumber !== null) {
    return [Number(options.issueNumber)];
  }
  if (Array.isArray(options.issueNumbers) && options.issueNumbers.length > 0) {
    return [...new Set(options.issueNumbers.map(Number))];
  }
  const fromPlan = _issueNumbersFromPlan(_activeBuildPlanText(prawductRootFor(projectPath, options.configRoot)));
  if (fromPlan.length > 0) return fromPlan;
  return _issueNumbersFromCommits(options.commits);
}

/** `gh issue view` timeout (ms): one signal must never hang a wrap on a slow/offline host. */
const GH_ISSUE_VIEW_TIMEOUT_MS = 5000;

/**
 * Resolve the lookup `linkedIssueClosedSignal` calls per issue number, or
 * `null` when `options.checkGithub === false` explicitly disables it. A
 * caller-injected `options.fetchIssueState`/`options.execGh` always wins (the
 * same way a caller can hand in an already-parsed `changelog` fact to
 * {@link gatherReleaseSignals} instead of letting a signal read the file
 * itself). With neither injected, the default (A481-R5) runs `gh` directly,
 * bounded by {@link GH_ISSUE_VIEW_TIMEOUT_MS} — reached only when
 * {@link _discoverLinkedIssueNumbers} has already found at least one issue,
 * so a project with none linked never touches the network.
 *
 * @param {object} options
 * @param {string} projectPath - `cwd` for the default `gh` call
 * @returns {((issueNumber:number) => {state:string}|string)|null}
 */
function _issueStateLookup(options, projectPath) {
  if (typeof options.fetchIssueState === 'function') {
    return (n) => options.fetchIssueState(n);
  }
  if (typeof options.execGh === 'function') {
    return (n) => {
      const stdout = options.execGh(`gh issue view ${n} --json state`);
      return JSON.parse(stdout).state;
    };
  }
  if (options.checkGithub === false) {
    return null;
  }
  return (n) => {
    const stdout = _internal.execFileSync('gh', ['issue', 'view', String(n), '--json', 'state'], {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GH_ISSUE_VIEW_TIMEOUT_MS
    });
    return JSON.parse(stdout).state;
  };
}

/**
 * `linked-issue-closed`: is the issue this plan/commit set out to fix
 * actually closed?
 *
 * Never `pass` without a live, successful lookup — a release gate that read
 * "no issue found" or "couldn't check GitHub" as ready would cut while the
 * thing it was supposed to fix is still open.
 *
 * @param {string} projectPath - Absolute project root
 * @param {object} [options]
 * @param {number|string} [options.issueNumber] - Judge this issue only
 * @param {Array<number|string>} [options.issueNumbers] - Judge all of these
 * @param {Array<string>} [options.commits] - Commit subjects/bodies to mine
 *   for `Fixes #N` / `Closes #N` / `Resolves #N` when no plan/explicit number
 *   names one
 * @param {(issueNumber:number) => ({state:string}|string)} [options.fetchIssueState] -
 *   Caller-supplied lookup; return shape `{state}` or a bare state string;
 *   wins over the default `gh` call and over `options.execGh`
 * @param {boolean} [options.checkGithub=true] - Set `false` to skip the
 *   default `gh` call (reads `unknown` instead) without disabling discovery;
 *   has no effect when `fetchIssueState`/`execGh` is injected
 * @param {(command:string) => string} [options.execGh] - Caller-supplied
 *   shell runner, given the exact `gh issue view <n> --json state` command;
 *   wins over the default `gh` call
 * @param {string} [options.configRoot] - See {@link prawductRootFor}
 * @returns {{id:string, state:string, detail:string}}
 */
function linkedIssueClosedSignal(projectPath, options = {}) {
  const id = 'linked-issue-closed';
  const issueNumbers = _discoverLinkedIssueNumbers(projectPath, options);
  if (issueNumbers.length === 0) {
    return { id, state: 'n/a', detail: 'no linked issue found' };
  }

  const lookup = _issueStateLookup(options, projectPath);
  if (!lookup) {
    return { id, state: 'unknown', detail: 'GitHub issue state unavailable: checkGithub is false' };
  }

  const results = [];
  for (const n of issueNumbers) {
    let answer;
    try {
      answer = lookup(n);
    } catch (err) {
      return { id, state: 'unknown', detail: `GitHub issue state unavailable: ${err.message}` };
    }
    const state = String((answer && typeof answer === 'object' ? answer.state : answer) || '').toLowerCase();
    results.push({ number: n, state });
  }

  const open = results.find((r) => r.state === 'open');
  if (open) {
    return { id, state: 'fail', detail: `linked issue #${open.number} is still open` };
  }
  const unrecognized = results.find((r) => r.state !== 'closed');
  if (unrecognized) {
    return {
      id,
      state: 'unknown',
      detail: `GitHub issue state unavailable: issue #${unrecognized.number} answered an unrecognized state (${JSON.stringify(unrecognized.state)})`
    };
  }
  const names = issueNumbers.map((n) => `#${n}`).join(', ');
  return {
    id,
    state: 'pass',
    detail: issueNumbers.length === 1 ? `linked issue ${names} is closed` : `linked issues ${names} are closed`
  };
}

module.exports = {
  evaluateReleaseReadiness,
  gatherReleaseSignals,
  unreleasedEntriesSignal,
  buildPlanStatusSignal,
  linkedIssueClosedSignal,
  prawductRootFor,
  GH_ISSUE_VIEW_TIMEOUT_MS,
  _internal
};
