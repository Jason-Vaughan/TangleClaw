'use strict';

/**
 * `priming-roll` wrap step (#139 Chunk 6) — parses
 * `.claude/plans/<plan>.md` for the current chunk pointer; rolls
 * forward in `.claude/priming/build-session.md`. Pure server-side
 * filesystem reads + (deferred) writes — no AI handoff and no tmux.
 *
 * **Plan format.** Reads markdown matching the convention TangleClaw's
 * own #139 build plan already uses: `### Chunk N: Title` headings,
 * with a `✅` anywhere on the heading line marking that chunk as done.
 * Chunk ids tolerate dotted / lettered sub-chunk numbering (e.g.
 * `### Chunk 10c.2: …` parses to id `10c.2`). The "current" chunk is
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
 * `.claude/priming/build-session.md` delimited by the markers
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
 *                          resolved by precedence (#226): `activePlan` in
 *                          `.tangleclaw/project.json` → the only `.md` in
 *                          `<project>/.claude/plans/` → among several, the
 *                          single in-progress plan. Zero in-progress →
 *                          skip ("nothing to roll"); more than one →
 *                          blocked with `output.remediation`. See
 *                          `_resolvePlanPath` for the full contract.
 *   - `step.primingPath` — optional. Default
 *                          `.claude/priming/build-session.md`.
 *                          Project-relative or absolute.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-priming-roll');

const BEGIN_MARKER = '<!-- TANGLECLAW:PRIMING-ROLL:BEGIN -->';
const END_MARKER = '<!-- TANGLECLAW:PRIMING-ROLL:END -->';
const DEFAULT_PRIMING_PATH = '.claude/priming/build-session.md';
const DEFAULT_PLANS_DIR = '.claude/plans';

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
// Match `**Blocked on:**` so the convention reads naturally in markdown.
// Case-insensitive so authors can write `**blocked on:**` without surprise.
const BLOCKED_ON_RE = /\*\*Blocked on:\*\*\s*(.+)/i;

/**
 * Parse a plan markdown body into an ordered chunk array.
 *
 * @param {string} planContent - Raw plan markdown
 * @returns {Array<{id:string, title:string, done:boolean, blockedOn:string|null, lineNo:number}>}
 */
function _parseChunks(planContent) {
  if (!planContent) return [];
  // CRLF tolerance: split on either form, then strip any trailing \r
  // that survives a lone-CR file (rare but cheap to defend).
  const lines = planContent.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
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
        .replace(/^[\s:]+/, '')
        .trim();
      current = {
        id: m[1],
        title: rawTitle,
        done: DONE_MARKER_RE.test(line),
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
  'Multiple build plans found. Disambiguate by setting `step.planPath` in the methodology template, ' +
  'setting `activePlan: "<filename>"` in `.tangleclaw/project.json` (an operator escape hatch — the ' +
  'filename resolves under `.claude/plans/`), or removing obsolete plans from `.claude/plans/` ' +
  '(archive shipped plans under `.claude/plans/archive/`).';

/**
 * A plan is "in progress" when it declares at least one `### Chunk N`
 * heading and not all of them are done — i.e. there's a chunk left to roll
 * the priming pointer to. Plans with no chunks, or all chunks done, are not
 * roll candidates. Used to auto-disambiguate when several plans coexist (#226).
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
 * Resolve the canonical build plan to roll the priming pointer against.
 *
 * Precedence (#226):
 *   1. `step.planPath` (methodology config; project-relative or absolute)
 *   2. `activePlan` in `.tangleclaw/project.json` (operator escape hatch;
 *      bare filename resolves under `.claude/plans/`)
 *   3. exactly one `.md` plan in `.claude/plans/` → use it
 *   4. several plans → the single in-progress one (auto-disambiguation);
 *      zero in-progress → skip ("all plans complete"); more than one
 *      in-progress → block with `remediation`.
 *   5. zero `.md` plans in `.claude/plans/` → skip ("nothing to roll"):
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
    // methodology). Absolute paths are accepted as-is on the
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
    // project-relative (same containment guard as step.planPath).
    const hasSep = activePlan.includes('/') || activePlan.includes(path.sep);
    const abs = path.isAbsolute(activePlan)
      ? activePlan
      : path.resolve(projectPath, hasSep ? activePlan : path.join(DEFAULT_PLANS_DIR, activePlan));
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

  const plansDir = path.join(projectPath, DEFAULT_PLANS_DIR);
  if (!_internal.existsSync(plansDir)) {
    return {
      ok: false,
      error: `No plans directory at ${DEFAULT_PLANS_DIR} (and no step.planPath configured)`
    };
  }
  const entries = _internal.readdirSync(plansDir).filter((f) => f.endsWith('.md'));
  if (entries.length === 0) {
    // No active plan to roll — same meaning as "several plans, none
    // in-progress" below, so skip cleanly rather than block (#302). This
    // is the well-behaved end state: a project that has shipped and
    // archived all its plans (per CLAUDE.md's archive rule) leaves the
    // active `.claude/plans/` dir empty (the `.md` filter above ignores
    // the `archive/` subdir). Blocking that state failed every clean wrap.
    return {
      ok: false,
      skip: true,
      reason: `No .md plans found in ${DEFAULT_PLANS_DIR} (all plans archived or none authored) — nothing to roll`
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
      reason: `No in-progress plan among ${entries.length} in ${DEFAULT_PLANS_DIR} (all chunks complete or no chunks) — nothing to roll`
    };
  }
  return {
    ok: false,
    error: `Multiple in-progress plans in ${DEFAULT_PLANS_DIR} (${inProgress.map((p) => p.file).join(', ')}) — cannot pick one automatically`,
    remediation: MULTI_PLAN_REMEDIATION,
    // Structured candidate list (filenames only) for the drawer's inline
    // plan-picker (#428) — mirrors the filenames embedded in `error`, but
    // as data the UI can render without string-parsing.
    candidates: inProgress.map((p) => p.file)
  };
}

/**
 * Resolve the priming-file path (absolute on return).
 * @param {string} projectPath
 * @param {object} step
 * @returns {string}
 */
function _resolvePrimingPath(projectPath, step) {
  const rel = step.primingPath || DEFAULT_PRIMING_PATH;
  return path.isAbsolute(rel) ? rel : path.join(projectPath, rel);
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
        || 'This step could not resolve a single build plan. Set `step.planPath` in the methodology template to point at the canonical plan, or clean up `.claude/plans/` so exactly one `.md` plan remains (archive shipped plans under `.claude/plans/archive/`). See lib/wrap-steps/priming-roll.js for the disambiguation contract.'
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
    // No `### Chunk N:` headings — the resolved plan is a spec/design doc
    // (or a plan not yet chunked), so there is no chunk pointer to roll.
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
      `Resolved plan \`${rel}\` has no \`### Chunk N:\` headings — nothing to ` +
      'roll (add chunk headings if this is meant to be an active build plan)';
    return {
      ok: true,
      status: 'skipped',
      output: { reason, detail: `No "### Chunk N: Title" headings in ${planRes.planPath}` },
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
      changed
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
  _renderPointerBody,
  _replaceManagedBlock,
  _resolvePlanPath,
  _resolvePrimingPath,
  BEGIN_MARKER,
  END_MARKER,
  DEFAULT_PRIMING_PATH,
  DEFAULT_PLANS_DIR
};
