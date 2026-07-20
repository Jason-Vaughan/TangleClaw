'use strict';

/**
 * `priming-roll` wrap step (#139 Chunk 6) — parses
 * `.tangleclaw/plans/<plan>.md` for the current chunk pointer; rolls
 * forward in `.tangleclaw/priming/build-session.md`. Pure server-side
 * filesystem reads + (deferred) writes — no AI handoff and no tmux.
 *
 * **Plan format.** Reads markdown matching the convention TangleClaw's
 * own #139 build plan already uses: `### Chunk N: Title` headings,
 * with a `✅` anywhere on the heading line marking that chunk as done.
 * Chunk ids tolerate dotted / lettered sub-chunk numbering (e.g.
 * `### Chunk 10c.2: …` parses to id `10c.2`). A `## Status` checkbox
 * roster (`- [x] Chunk NN: Title`) is honoured as a second done-source
 * and, on a plan that has no `### Chunk` headings, as the chunk list
 * itself — governed plans declare that roster their tracker and leave
 * the heading sections un-ticked (#620). The "current" chunk is
 * the first un-done heading in document order; the "next" chunk is
 * whatever follows it (or `null` when current is the tail). A resolved
 * plan with **no** `### Chunk N:` headings (a spec/design doc, or a
 * plan not yet chunked) is **skipped with a reason**, not blocked —
 * nothing to roll, and blocking on it was asymmetric with the
 * multi-plan path (#515).
 *
 * **Blocker annotations.** A line in a chunk body matching
 * `**Blocked on:** <text>` (case-insensitive) is captured and carried
 * through to the rolled pointer so the next session sees the blocker
 * inline rather than discovering it by re-reading the plan. Only the
 * first match per chunk is carried — additional `**Blocked on:**`
 * lines in the same chunk body are ignored.
 *
 * **Priming roll.** Replaces a managed block in
 * `.tangleclaw/priming/build-session.md` delimited by the markers
 * `<!-- TANGLECLAW:PRIMING-ROLL:BEGIN -->` and
 * `<!-- TANGLECLAW:PRIMING-ROLL:END -->`. The rest of the priming file
 * is sacrosanct — user-authored content surrounding the managed block
 * is preserved byte-for-byte. If the file or the markers don't exist
 * yet, the handler appends a fresh managed block. The handler does NOT
 * itself create the priming file — that's the `commit` step's job in
 * Chunk 9; see "Single-transaction discipline" below.
 *
 * **Single-transaction discipline.** This handler does NOT touch the
 * filesystem (apart from reads). It stages the planned write at
 * `context.staged[step.id] = {primingPath, newContent, changed, pointer, planPath}`;
 * the Chunk 9 `commit` step is the only step that flushes staged writes
 * to the working tree. (Same pattern as Chunk 5's `ai-content` handler,
 * which also stages output for `commit` to consume.)
 *
 * **Step config.**
 *   - `step.planPath`    — optional. Project-relative or absolute path
 *                          to the plan markdown. If unset, the plan is
 *                          resolved by precedence (#226/#620): `activePlan`
 *                          in `.tangleclaw/project.json` → `active_build_plan`
 *                          in `.prawduct/project-state.yaml` → the only `.md`
 *                          in `<project>/.tangleclaw/plans/` (legacy
 *                          `.claude/plans/` still read) → among several, the
 *                          single in-progress plan. Zero in-progress →
 *                          skip ("nothing to roll"); more than one →
 *                          blocked with `output.remediation`. See
 *                          `_resolvePlanPath` for the full contract.
 *   - `step.primingPath` — optional. Default
 *                          `.tangleclaw/priming/build-session.md`
 *                          (legacy `.claude/priming/build-session.md` is
 *                          used when it already exists).
 *                          Project-relative or absolute.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-priming-roll');

const BEGIN_MARKER = '<!-- TANGLECLAW:PRIMING-ROLL:BEGIN -->';
const END_MARKER = '<!-- TANGLECLAW:PRIMING-ROLL:END -->';
// Plans and priming files are TangleClaw orchestration state, so they live in
// TangleClaw's own directory rather than an engine's. `.claude/` is Claude
// Code's config directory; resolving runtime paths there meant a project on any
// other engine silently found no plan — the step reported "nothing to roll"
// rather than failing visibly, so the coupling was invisible.
//
// A project that switches engines keeps its plans, which is why the location is
// TC-owned rather than derived per engine: an engine-derived directory would
// relocate the same project's plans on an engine change.
const DEFAULT_PRIMING_PATH = '.tangleclaw/priming/build-session.md';
const DEFAULT_PLANS_DIR = '.tangleclaw/plans';

// Fallbacks for projects authored before the move. 48 plan files across 12
// projects live here, so resolution checks the legacy location when the
// TC-owned one holds no plans.
//
// A project resolved here keeps using it — including for a NEW priming file —
// so its TangleClaw artifacts stay in one directory rather than straddling
// both. The step reports `legacy: true` in its output and logs a warning, so
// running on the deprecated home is visible rather than silent; migration is
// tracked in the backlog (there is no automatic move).
const LEGACY_PRIMING_PATH = '.claude/priming/build-session.md';
const LEGACY_PLANS_DIR = '.claude/plans';

// `### Chunk <id> <title>` — id is digits + optional single trailing
// letter + optional dotted sub-segments per segment (`1`, `2a`, `10c.2`,
// `12.3a.4`). Title (group 2) is the full remainder; the caller strips
// a leading `:` or whitespace and the ✅ marker before display. Anything
// else (only-whitespace separators between id segments, multi-letter
// suffixes like `10ab`, em-dash separator) is matched only up to the
// first non-conforming character. Plain `### Chunk` lines whose id slot
// doesn't match are surfaced via a logged warning (see `_parseChunks`)
// rather than silently dropped, so a typo like `### Chunk Foo:` is
// visible in the wrap drawer.
const CHUNK_HEADING_RE = /^###\s+Chunk\s+([0-9]+[a-z]?(?:\.[0-9]+[a-z]?)*)\b(.*)$/i;
const CHUNK_LINE_LOOSE_RE = /^###\s+Chunk\b/i;
const DONE_MARKER_RE = /✅/;
// Leading separator between a chunk id and its title. Plans write either
// `### Chunk 1: Title` or `### Chunk 1 — Title`; both forms must render as
// a bare title, or the pointer reads `Chunk 1 — — Title` (the em-dash form
// was left in by an earlier `[\s:]`-only strip). Covers colon, em dash,
// en dash, and hyphen.
const TITLE_SEPARATOR_RE = /^[\s:—–-]+/;
// Column-0 `active_build_plan:` in `.prawduct/project-state.yaml`. The
// leading `^` under /m plus the absence of any indentation allowance is
// the column-0 requirement — see `_readGovernedPlan`.
const GOVERNED_PLAN_RE = /^active_build_plan:[ \t]*(.*)$/m;
const PRAWDUCT_DIR = '.prawduct';
// `## Status` section heading, and a checkbox roster item within it
// (`- [x] Chunk 01: Title`). Governed plans declare this roster as the
// cross-session tracker — the `### Chunk NN:` sections below it are spec
// anchors for the ref-verifier, not done-state. See `_parseRoster`.
const STATUS_HEADING_RE = /^##\s+Status\b/i;
const ANY_H2_RE = /^##\s/;
const ROSTER_ITEM_RE = /^\s*[-*]\s*\[([ xX])\]\s*Chunk\s+([0-9]+[a-z]?(?:\.[0-9]+[a-z]?)*)\b(.*)$/i;
// Match `**Blocked on:**` so the convention reads naturally in markdown.
// Case-insensitive so authors can write `**blocked on:**` without surprise.
const BLOCKED_ON_RE = /\*\*Blocked on:\*\*\s*(.+)/i;

/**
 * Normalize a chunk id for roster↔heading joining.
 *
 * Plans are not internally consistent about zero-padding — a roster may say
 * `Chunk 1` where the heading says `### Chunk 01`. Keying the join on the raw
 * string would miss the lookup, drop the tick, and park the pointer on chunk
 * 01: exactly the silent wrong-pointer failure this module exists to prevent.
 * Each dotted segment loses its leading zeros (`01` → `1`, `010c.02` → `10c.2`).
 *
 * @param {string} id - Raw chunk id as written in the plan
 * @returns {string} Normalized join key
 */
function _chunkIdKey(id) {
  return String(id)
    .toLowerCase()
    .split('.')
    .map((seg) => seg.replace(/^0+(?=\d)/, ''))
    .join('.');
}

/**
 * Parse the `## Status` checkbox roster into `{normalized id → entry}`.
 *
 * Governed build plans track chunk completion in a `## Status` roster of
 * `- [x] Chunk NN: Title` items and carry a parallel set of `### Chunk NN:`
 * spec sections further down. Only the roster is the tracker — the sections
 * exist so a ref-verifier has parseable anchors, and they are routinely left
 * un-ticked after a chunk ships. Reading done-state from the headings alone
 * therefore reports a long-finished plan as sitting on chunk 01.
 *
 * Scoped to the `## Status` section (heading → next `##`) so a checkbox in
 * unrelated prose can't mark a chunk done.
 *
 * @param {string[]} lines - Plan body split into lines
 * @returns {Map<string, {done:boolean, title:string, id:string}>}
 */
function _parseRoster(lines) {
  const roster = new Map();
  let inStatus = false;
  for (const line of lines) {
    if (STATUS_HEADING_RE.test(line)) { inStatus = true; continue; }
    if (inStatus && ANY_H2_RE.test(line)) break; // next section ends the roster
    if (!inStatus) continue;
    const m = line.match(ROSTER_ITEM_RE);
    if (!m) continue;
    const title = (m[3] || '')
      .replace(DONE_MARKER_RE, '')
      .replace(TITLE_SEPARATOR_RE, '')
      .trim();
    roster.set(_chunkIdKey(m[2]), { done: m[1].toLowerCase() === 'x', title, id: m[2] });
  }
  return roster;
}

/**
 * Parse a plan markdown body into an ordered chunk array.
 *
 * Chunks come from `### Chunk N:` headings when present, else from the
 * `## Status` roster (a plan may carry the roster alone — the spec-anchor
 * sections were a later addition to the convention).
 *
 * A chunk is done when EITHER source affirms it: a `✅` on its heading or a
 * ticked roster box. Both are affirmative done-markers and neither is used
 * as a "definitely not done" assertion, so a union can't regress a plan that
 * uses only one — whereas letting an un-ticked source veto a ticked one would
 * resurrect shipped chunks.
 *
 * @param {string} planContent - Raw plan markdown
 * @returns {Array<{id:string, title:string, done:boolean, blockedOn:string|null, lineNo:number}>}
 */
function _parseChunks(planContent) {
  if (!planContent) return [];
  // CRLF tolerance: split on either form, then strip any trailing \r
  // that survives a lone-CR file (rare but cheap to defend).
  const lines = planContent.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
  const roster = _parseRoster(lines);
  const chunks = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(CHUNK_HEADING_RE);
    if (!m && CHUNK_LINE_LOOSE_RE.test(line)) {
      // `### Chunk` heading whose id slot is non-conforming (typo or
      // intentional free-form title). Surface visibly so the author
      // sees something is off, rather than silently dropping it. The
      // chunk is still skipped — the parser remains strict — but the
      // warning gives the user a recovery path.
      log.warn('plan heading skipped — non-conforming id', {
        lineNo: i + 1,
        line: line.slice(0, 120)
      });
      continue;
    }
    if (m) {
      // Strip ✅ + leading separators from the title so it renders cleanly.
      // Done-state is decided on the full heading line, not the
      // stripped title, so a ✅ in the body still doesn't promote a
      // sibling chunk.
      const rawTitle = (m[2] || '')
        .replace(DONE_MARKER_RE, '')
        .replace(TITLE_SEPARATOR_RE, '')
        .trim();
      const rostered = roster.get(_chunkIdKey(m[1]));
      current = {
        id: m[1],
        title: rawTitle,
        done: DONE_MARKER_RE.test(line) || Boolean(rostered && rostered.done),
        blockedOn: null,
        lineNo: i + 1
      };
      chunks.push(current);
      continue;
    }
    if (current && current.blockedOn === null) {
      const b = line.match(BLOCKED_ON_RE);
      if (b) current.blockedOn = b[1].trim();
    }
  }
  if (chunks.length === 0 && roster.size > 0) {
    // Roster-only plan (no spec-anchor sections). Insertion order is
    // document order, so the pointer still advances correctly.
    for (const entry of roster.values()) {
      chunks.push({ id: entry.id, title: entry.title, done: entry.done, blockedOn: null, lineNo: 0 });
    }
  }
  return chunks;
}

/**
 * Pick the "current" chunk pointer and its "next" successor.
 *
 * @param {Array} chunks - Output of `_parseChunks`
 * @returns {{current: object|null, next: object|null, allDone: boolean}}
 */
function _selectPointer(chunks) {
  if (!chunks || chunks.length === 0) {
    return { current: null, next: null, allDone: false };
  }
  const firstUndoneIdx = chunks.findIndex((c) => !c.done);
  if (firstUndoneIdx === -1) {
    return { current: null, next: null, allDone: true };
  }
  return {
    current: chunks[firstUndoneIdx],
    next: chunks[firstUndoneIdx + 1] || null,
    allDone: false
  };
}

/**
 * Render the managed-block body. Plain markdown — no nested code
 * fences so it can sit inside a fenced surrounding markdown block
 * without conflict.
 *
 * The caller (`run`) guarantees a resolvable pointer: it skips before
 * rendering when the plan has zero chunks (#515), so `_selectPointer`
 * always yields either `allDone` or a `current` — never an all-`null`
 * pointer. There is therefore no "no headings" fallback branch here.
 *
 * @param {{current:object|null, next:object|null, allDone:boolean}} pointer
 * @param {string} planRelPath - Plan path relative to project root, for the human reader
 * @returns {string} Body sandwiched between BEGIN/END markers (markers not included)
 */
function _renderPointerBody(pointer, planRelPath) {
  const lines = ['', '## Current build chunk', ''];
  if (pointer.allDone) {
    lines.push(
      `All chunks in \`${planRelPath}\` are marked done. ` +
      'Open a new plan or wrap this one up.'
    );
  } else if (pointer.current) {
    const title = pointer.current.title || '(untitled)';
    lines.push(`**Active:** Chunk ${pointer.current.id} — ${title}`);
    if (pointer.current.blockedOn) {
      lines.push('', `**Blocked on:** ${pointer.current.blockedOn}`);
    }
    if (pointer.next) {
      const nextTitle = pointer.next.title || '(untitled)';
      lines.push('', `**On deck:** Chunk ${pointer.next.id} — ${nextTitle}`);
      if (pointer.next.blockedOn) {
        lines.push(`(blocked on: ${pointer.next.blockedOn})`);
      }
    } else {
      lines.push('', '_Last chunk in this plan._');
    }
    lines.push('', `Plan: \`${planRelPath}\``);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Replace (or append) the managed block inside `priorContent`.
 *
 * @param {string} priorContent - Existing priming-file body (may be empty)
 * @param {string} body - Rendered body to live between BEGIN/END markers
 * @returns {string} New full priming-file content
 */
function _replaceManagedBlock(priorContent, body) {
  const begin = priorContent.indexOf(BEGIN_MARKER);
  const end = priorContent.indexOf(END_MARKER);
  if (begin !== -1 && end !== -1 && end > begin) {
    const head = priorContent.slice(0, begin + BEGIN_MARKER.length);
    const tail = priorContent.slice(end);
    return `${head}\n${body}${tail}`;
  }
  // No managed block yet — append one. Ensure the user-authored body
  // is separated from the appended block by at least one blank line.
  let separator = '';
  if (priorContent.length > 0) {
    if (priorContent.endsWith('\n\n')) separator = '';
    else if (priorContent.endsWith('\n')) separator = '\n';
    else separator = '\n\n';
  }
  return `${priorContent}${separator}${BEGIN_MARKER}\n${body}${END_MARKER}\n`;
}

/**
 * Remediation shown in the wrap drawer (#223/#226) when the step can't
 * pick a single plan among several candidates.
 */
const MULTI_PLAN_REMEDIATION =
  'Multiple build plans found. Disambiguate by setting `step.planPath` in the wrap-step override, ' +
  'setting `activePlan: "<filename>"` in `.tangleclaw/project.json` (an operator escape hatch — the ' +
  'filename resolves under the project\'s plans directory), or removing obsolete plans from it ' +
  '(archive shipped plans under its `archive/` subdirectory).';

/**
 * A plan is "in progress" when it declares at least one chunk — via a
 * `### Chunk N` heading or a `## Status` roster item — and not all of them
 * are done, i.e. there's a chunk left to roll the priming pointer to. Plans
 * with no chunks, or all chunks done, are not roll candidates. Used to
 * auto-disambiguate when several plans coexist (#226).
 *
 * @param {string} planContent
 * @returns {boolean}
 */
function _isPlanInProgress(planContent) {
  const chunks = _parseChunks(planContent);
  if (chunks.length === 0) return false;
  return !_selectPointer(chunks).allDone;
}

/**
 * Read the optional `activePlan` escape hatch from `.tangleclaw/project.json`.
 * Returns the trimmed filename/path string, or null if absent/unreadable (#226).
 *
 * @param {string} projectPath
 * @returns {string|null}
 */
function _readActivePlan(projectPath) {
  const cfgPath = path.join(projectPath, '.tangleclaw', 'project.json');
  if (!_internal.existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(_internal.readFileSync(cfgPath, 'utf8'));
    return cfg && typeof cfg.activePlan === 'string' && cfg.activePlan.trim()
      ? cfg.activePlan.trim()
      : null;
  } catch {
    return null; // malformed project.json is not this step's problem
  }
}

/**
 * Read the governing framework's declared build-plan pointer from
 * `.prawduct/project-state.yaml`.
 *
 * A Prawduct-governed project keeps its active plan under
 * `.prawduct/artifacts/` and names it with a column-0 `active_build_plan:`
 * key whose value is `.prawduct/`-relative. The key MUST be at column 0 —
 * a nested/indented pointer is deliberately not honoured, matching the
 * framework's own reader, so a pointer buried inside another mapping
 * doesn't silently take effect here while the framework ignores it.
 *
 * Parsed with a line regex rather than a YAML dependency: one scalar at a
 * fixed column doesn't justify pulling a parser into the wrap pipeline.
 * A `null`/empty value reads as "not declared".
 *
 * @param {string} projectPath
 * @returns {string|null} `.prawduct/`-relative plan path, or null when absent/unreadable
 */
function _readGovernedPlan(projectPath) {
  const statePath = path.join(projectPath, '.prawduct', 'project-state.yaml');
  if (!_internal.existsSync(statePath)) return null;
  let content;
  try {
    content = _internal.readFileSync(statePath, 'utf8');
  } catch {
    return null; // unreadable governance state is not this step's problem
  }
  const m = content.match(GOVERNED_PLAN_RE);
  if (!m) return null;
  const value = m[1]
    .replace(/\s+#.*$/, '')       // strip a trailing inline comment
    .trim()
    .replace(/^['"]|['"]$/g, ''); // strip surrounding quotes
  if (!value || value === 'null' || value === '~') return null;
  return value;
}

/**
 * Resolve the canonical build plan to roll the priming pointer against.
 *
 * Precedence (#226):
 *   1. `step.planPath` (step config; project-relative or absolute)
 *   2. `activePlan` in `.tangleclaw/project.json` (operator escape hatch;
 *      bare filename resolves under the resolved plans dir)
 *   3. `active_build_plan` in `.prawduct/project-state.yaml` (the governing
 *      framework's declared pointer, `.prawduct/`-relative). Declared but
 *      missing → skip, never fall through to the heuristics below (#620).
 *   4. exactly one `.md` plan in the plans dir → use it
 *   5. several plans → the single in-progress one (auto-disambiguation);
 *      zero in-progress → skip ("all plans complete"); more than one
 *      in-progress → block with `remediation`.
 *   6. zero `.md` plans in the plans dir → skip ("nothing to roll"):
 *      same meaning as zero-in-progress, the well-behaved all-archived
 *      end state (#302). The `.md` filter is non-recursive, so an
 *      `archive/` subdir of shipped plans does not count.
 *
 * @param {string} projectPath
 * @param {object} step - Step spec
 * @returns {{ok:true, planPath:string}
 *   | {ok:false, skip:true, reason:string}
 *   | {ok:false, error:string, remediation?:string}}
 */
function _resolvePlanPath(projectPath, step) {
  if (step.planPath) {
    // Project-relative paths get resolved + a containment check —
    // refuses `../up-and-out.md` style traversals even though
    // template JSON is server-trusted today (defense-in-depth for
    // Chunk 11's default-flip and any future user-editable
    // step config). Absolute paths are accepted as-is on the
    // assumption that an author writing an absolute path knows what
    // they're pointing at (e.g. a shared corporate plan archive).
    const abs = path.isAbsolute(step.planPath)
      ? step.planPath
      : path.resolve(projectPath, step.planPath);
    if (!path.isAbsolute(step.planPath)) {
      const projectRoot = path.resolve(projectPath);
      const inside = abs === projectRoot || abs.startsWith(projectRoot + path.sep);
      if (!inside) {
        return {
          ok: false,
          planPath: null,
          error: `step.planPath "${step.planPath}" resolves outside the project root`
        };
      }
    }
    if (!_internal.existsSync(abs)) {
      return {
        ok: false,
        planPath: null,
        error: `Configured planPath does not exist: ${step.planPath}`
      };
    }
    return { ok: true, planPath: abs, error: null };
  }

  // No explicit planPath — try the operator escape hatch, then the plans dir.
  const activePlan = _readActivePlan(projectPath);
  if (activePlan) {
    // Bare filename resolves under the plans dir; an explicit path is taken
    // project-relative (same containment guard as step.planPath). The plans dir
    // is RESOLVED rather than assumed, so a project whose plans still live in
    // the legacy location keeps working with a bare `activePlan` — pinning this
    // to the preferred constant would break exactly the projects the fallback
    // exists to protect.
    const hasSep = activePlan.includes('/') || activePlan.includes(path.sep);
    const plansRel = hasSep ? null : (_resolvePlansDir(projectPath) || { relative: DEFAULT_PLANS_DIR }).relative;
    const abs = path.isAbsolute(activePlan)
      ? activePlan
      : path.resolve(projectPath, hasSep ? activePlan : path.join(plansRel, activePlan));
    if (!path.isAbsolute(activePlan)) {
      const root = path.resolve(projectPath);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        return { ok: false, error: `activePlan "${activePlan}" (in .tangleclaw/project.json) resolves outside the project root` };
      }
    }
    if (!_internal.existsSync(abs)) {
      return {
        ok: false,
        error: `activePlan "${activePlan}" (in .tangleclaw/project.json) does not exist`,
        remediation: MULTI_PLAN_REMEDIATION
      };
    }
    return { ok: true, planPath: abs };
  }

  // The governing framework's declared pointer outranks the plans-dir
  // heuristic below: a project whose plan lives under `.prawduct/artifacts/`
  // would otherwise fall through and roll the pointer onto whatever
  // unrelated `.md` happens to sit in the plans directory — reporting success
  // while priming the next session onto stale work. It sits BELOW the two
  // explicit hatches above, so `step.planPath` and the operator's
  // `activePlan` pick (which the multi-plan picker persists) still win.
  const governedPlan = _readGovernedPlan(projectPath);
  if (governedPlan) {
    // The pointer is documented as `.prawduct/`-relative, but an author
    // may reasonably write it project-relative with the dir spelled out.
    // Double-prefixing that into `.prawduct/.prawduct/…` would dangle and
    // silently skip, so honour both spellings.
    const alreadyPrefixed = governedPlan === PRAWDUCT_DIR
      || governedPlan.startsWith(`${PRAWDUCT_DIR}/`)
      || governedPlan.startsWith(`${PRAWDUCT_DIR}${path.sep}`);
    const abs = path.isAbsolute(governedPlan)
      ? governedPlan
      : path.resolve(projectPath, alreadyPrefixed ? '' : PRAWDUCT_DIR, governedPlan);
    if (!path.isAbsolute(governedPlan)) {
      const root = path.resolve(projectPath);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        return { ok: false, error: `active_build_plan "${governedPlan}" (in ${PRAWDUCT_DIR}/project-state.yaml) resolves outside the project root` };
      }
    }
    if (_internal.existsSync(abs)) {
      return { ok: true, planPath: abs };
    }
    // Declared but missing — stale governance state. Skip with the reason
    // rather than falling through to the plans-dir heuristic: falling
    // through is exactly what produces a confidently-wrong pointer, and a
    // dangling pointer is not the operator's typo to be blocked on.
    return {
      ok: false,
      skip: true,
      reason: `active_build_plan "${governedPlan}" (in ${PRAWDUCT_DIR}/project-state.yaml) does not exist — nothing to roll (update or clear the pointer)`
    };
  }

  const resolved = _resolvePlansDir(projectPath);
  if (!resolved) {
    return {
      ok: false,
      error: `No plans directory at ${DEFAULT_PLANS_DIR} or ${LEGACY_PLANS_DIR} (and no step.planPath configured)`
    };
  }
  const plansDir = resolved.dir;
  const plansDirLabel = resolved.relative;
  const entries = _internal.readdirSync(plansDir).filter((f) => f.endsWith('.md'));
  if (entries.length === 0) {
    // No active plan to roll — same meaning as "several plans, none
    // in-progress" below, so skip cleanly rather than block (#302). This
    // is the well-behaved end state: a project that has shipped and
    // archived all its plans (per CLAUDE.md's archive rule) leaves the
    // active plans dir empty (the `.md` filter above ignores
    // the `archive/` subdir). Blocking that state failed every clean wrap.
    return {
      ok: false,
      skip: true,
      reason: `No .md plans found in ${plansDirLabel} (all plans archived or none authored) — nothing to roll`
    };
  }
  if (entries.length === 1) {
    return { ok: true, planPath: path.join(plansDir, entries[0]) };
  }

  // Several plans coexist — auto-disambiguate by in-progress state (#226).
  // A long-lived project accumulates completed plans; the one with an undone
  // chunk is the obvious roll target, so we don't force the operator to name
  // it after every plan completes.
  const inProgress = [];
  for (const f of entries) {
    const abs = path.join(plansDir, f);
    let content = '';
    try {
      content = _internal.readFileSync(abs, 'utf8');
    } catch {
      continue; // unreadable candidate — skip it, don't crash disambiguation
    }
    if (_isPlanInProgress(content)) inProgress.push({ file: f, abs });
  }
  if (inProgress.length === 1) {
    return { ok: true, planPath: inProgress[0].abs };
  }
  if (inProgress.length === 0) {
    // Every plan is complete (or chunk-less) — nothing to roll. Skip rather
    // than block: a project that finished its plans shouldn't fail its wrap.
    return {
      ok: false,
      skip: true,
      reason: `No in-progress plan among ${entries.length} in ${plansDirLabel} (all chunks complete or no chunks) — nothing to roll`
    };
  }
  return {
    ok: false,
    error: `Multiple in-progress plans in ${plansDirLabel} (${inProgress.map((p) => p.file).join(', ')}) — cannot pick one automatically`,
    remediation: MULTI_PLAN_REMEDIATION,
    // Structured candidate list (filenames only) for the drawer's inline
    // plan-picker (#428) — mirrors the filenames embedded in `error`, but
    // as data the UI can render without string-parsing.
    candidates: inProgress.map((p) => p.file)
  };
}

/**
 * Resolve the plans directory, preferring TangleClaw's own location and falling
 * back to the legacy engine-owned one for projects authored before the move.
 *
 * Returns `null` when neither exists, so the caller can name both in its error
 * rather than reporting only one and sending the operator to the wrong place.
 *
 * @param {string} projectPath - Absolute project root
 * @returns {{dir: string, relative: string, legacy: boolean}|null}
 */
function _resolvePlansDir(projectPath) {
  const candidates = [
    { dir: path.join(projectPath, DEFAULT_PLANS_DIR), relative: DEFAULT_PLANS_DIR, legacy: false },
    { dir: path.join(projectPath, LEGACY_PLANS_DIR), relative: LEGACY_PLANS_DIR, legacy: true }
  ];

  /**
   * Whether a directory exists and holds at least one `.md` plan.
   * @param {string} dir - Absolute candidate directory
   * @returns {boolean}
   */
  const hasPlans = (dir) => {
    if (!_internal.existsSync(dir)) return false;
    try {
      return _internal.readdirSync(dir).some((f) => f.endsWith('.md'));
    } catch {
      return false;
    }
  };

  // Preference follows CONTENT, not mere existence. Ranking by existence alone
  // reintroduced the very defect this move fixes, one layer quieter: TangleClaw
  // creates `.tangleclaw/` in every project, so an empty `.tangleclaw/plans/`
  // would shadow a legacy directory holding real plans, and the step would
  // report "nothing to roll" while an in-progress plan sat unread.
  const withPlans = candidates.find((c) => hasPlans(c.dir));
  if (withPlans) return withPlans;

  // Neither holds plans. Fall back to whichever exists so "no plans here" is
  // reported against a real directory rather than as a missing-directory error.
  return candidates.find((c) => _internal.existsSync(c.dir)) || null;
}

/**
 * Resolve the priming-file path (absolute on return).
 *
 * Same preference order as the plans directory: an explicit `step.primingPath`
 * wins, then TangleClaw's own location, then the legacy engine-owned one — but
 * the legacy path is only chosen when it already exists on disk. A project with
 * neither gets the TC-owned default, so new priming files are created in the
 * new home rather than perpetuating the old one.
 *
 * @param {string} projectPath - Absolute project root
 * @param {object} step - Step spec (may carry `primingPath`)
 * @returns {string} Absolute path to the priming file
 */
function _resolvePrimingPath(projectPath, step) {
  if (step.primingPath) {
    return path.isAbsolute(step.primingPath)
      ? step.primingPath
      : path.join(projectPath, step.primingPath);
  }
  // An existing priming file always wins, wherever it is — never orphan the
  // operator's file by writing a second one elsewhere.
  const preferred = path.join(projectPath, DEFAULT_PRIMING_PATH);
  if (_internal.existsSync(preferred)) return preferred;
  const legacy = path.join(projectPath, LEGACY_PRIMING_PATH);
  if (_internal.existsSync(legacy)) return legacy;

  // No priming file yet: follow wherever this project's PLANS resolved, so a
  // project's TangleClaw artifacts stay in one place. Choosing the preferred
  // home unconditionally would split a legacy project across both directories
  // — plans read from one, a new priming file written to the other — a state
  // nothing models and the operator would have to discover.
  const plans = _resolvePlansDir(projectPath);
  return plans && plans.legacy
    ? path.join(projectPath, LEGACY_PRIMING_PATH)
    : preferred;
}

/**
 * Step handler. See module docstring for full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (must include `path`)
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, step, staged } = context;

  if (!project || !project.path) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: ['priming-roll requires context.project.path']
    };
  }

  const planRes = _resolvePlanPath(project.path, step);
  if (!planRes.ok && planRes.skip) {
    // Every candidate plan is complete (or chunk-less) — nothing to roll.
    // Skip cleanly so a finished project's wrap isn't blocked (#226).
    return {
      ok: true,
      status: 'skipped',
      output: { reason: planRes.reason, detail: planRes.reason },
      blockers: []
    };
  }
  if (!planRes.ok) {
    const output = {
      remediation: planRes.remediation
        || 'This step could not resolve a single build plan. Set `step.planPath` in the step override to point at the canonical plan, or clean up the project\'s plans directory so exactly one `.md` plan remains (archive shipped plans under its `archive/` subdirectory). See lib/wrap-steps/priming-roll.js for the disambiguation contract.'
    };
    // Multi-plan block (#428): surface the candidate filenames as structured
    // data so the drawer can render an inline plan-picker; the operator's
    // pick is persisted to `activePlan` (see PATCH /api/projects/:name).
    if (Array.isArray(planRes.candidates) && planRes.candidates.length > 0) {
      output.candidates = planRes.candidates;
    }
    return {
      ok: false,
      status: 'blocked',
      output,
      blockers: [planRes.error]
    };
  }

  let planContent;
  try {
    planContent = _internal.readFileSync(planRes.planPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: [`Failed to read plan at ${planRes.planPath}: ${err.message}`]
    };
  }

  const chunks = _parseChunks(planContent);
  if (chunks.length === 0) {
    // Neither `### Chunk N:` headings nor a `## Status` roster — the
    // resolved plan is a spec/design doc (or a plan not yet chunked), so
    // there is no chunk pointer to roll.
    // SKIP (not block): this mirrors the multi-plan path, where a chunk-less
    // plan is dropped by `_isPlanInProgress` rather than failing the wrap.
    // Blocking here was asymmetric — the same chunk-less plan blocked when it
    // was the only `.md` in the dir but skipped when it had company (#515).
    // The skip carries a reason so the drawer still surfaces the "add chunk
    // headings if this is an active build plan" signal without halting the
    // wrap. Applies to explicitly-configured planPaths too: an explicit
    // pointer at a chunk-less file is a visible skip-with-reason, not a hard
    // wrap failure — honest and non-blocking beats loud-and-blocking here.
    const rel = path.relative(project.path, planRes.planPath) || planRes.planPath;
    const reason =
      `Resolved plan \`${rel}\` declares no chunks — nothing to roll (add ` +
      '`### Chunk N:` headings or a `## Status` checkbox roster if this is ' +
      'meant to be an active build plan)';
    return {
      ok: true,
      status: 'skipped',
      output: { reason, detail: `No "### Chunk N: Title" headings and no "## Status" roster in ${planRes.planPath}` },
      blockers: []
    };
  }

  const pointer = _selectPointer(chunks);
  const primingPath = _resolvePrimingPath(project.path, step);
  const planRelPath = path.relative(project.path, planRes.planPath) || planRes.planPath;
  const body = _renderPointerBody(pointer, planRelPath);

  let priorContent = '';
  if (_internal.existsSync(primingPath)) {
    try {
      priorContent = _internal.readFileSync(primingPath, 'utf8');
    } catch (err) {
      return {
        ok: false,
        status: 'blocked',
        output: null,
        blockers: [`Failed to read priming file at ${primingPath}: ${err.message}`]
      };
    }
  }

  const newContent = _replaceManagedBlock(priorContent, body);
  const changed = newContent !== priorContent;
  const pointerSummary = {
    current: pointer.current
      ? { id: pointer.current.id, title: pointer.current.title, blockedOn: pointer.current.blockedOn }
      : null,
    next: pointer.next
      ? { id: pointer.next.id, title: pointer.next.title, blockedOn: pointer.next.blockedOn }
      : null,
    allDone: pointer.allDone
  };

  staged[step.id] = {
    primingPath,
    newContent,
    changed,
    pointer: pointerSummary,
    planPath: planRes.planPath
  };

  // Surface a project still running on the pre-move location. The flag is
  // computed during resolution anyway; leaving it unconsumed would mean a dozen
  // projects run on a deprecated path with no signal — the same
  // looks-fine-but-isn't shape this chunk exists to remove, one layer up.
  const onLegacyHome = Boolean(
    (planRes.planPath && planRes.planPath.includes(`/${LEGACY_PLANS_DIR}/`))
    || primingPath.endsWith(LEGACY_PRIMING_PATH)
  );
  if (onLegacyHome) {
    log.warn('priming-roll resolved under the legacy engine-owned location', {
      project: project.name,
      planPath: planRes.planPath,
      primingPath,
      migrateTo: `${DEFAULT_PLANS_DIR}/ and ${DEFAULT_PRIMING_PATH}`
    });
  }

  log.info('priming pointer rolled', {
    project: project.name,
    plan: planRelPath,
    current: pointer.current && pointer.current.id,
    next: pointer.next && pointer.next.id,
    changed
  });

  return {
    ok: true,
    status: 'done',
    output: {
      primingPath,
      planPath: planRes.planPath,
      pointer: pointerSummary,
      changed,
      legacyHome: onLegacyHome
    },
    blockers: []
  };
}

const _internal = {
  readFileSync: fs.readFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  readdirSync: fs.readdirSync.bind(fs)
};

module.exports = {
  run,
  _internal,
  _parseChunks,
  _selectPointer,
  _isPlanInProgress,
  _readActivePlan,
  _readGovernedPlan,
  _parseRoster,
  _chunkIdKey,
  _renderPointerBody,
  _replaceManagedBlock,
  _resolvePlanPath,
  _resolvePrimingPath,
  _resolvePlansDir,
  BEGIN_MARKER,
  END_MARKER,
  DEFAULT_PRIMING_PATH,
  DEFAULT_PLANS_DIR,
  LEGACY_PRIMING_PATH,
  LEGACY_PLANS_DIR
};
