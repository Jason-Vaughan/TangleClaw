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
 * whatever follows it (or `null` when current is the tail).
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
 *                          to the plan markdown. If unset, scans
 *                          `<project>/.claude/plans/*.md` and requires
 *                          exactly one match — zero or two+ → blocked
 *                          with a clear "set step.planPath to
 *                          disambiguate" message.
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
  } else {
    lines.push(
      `No \`### Chunk N: Title\` headings found in \`${planRelPath}\`.`
    );
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
 * Resolve the plan path. If `step.planPath` is set, use it verbatim
 * (absolute or project-relative); otherwise scan
 * `<project>/.claude/plans/*.md` and require exactly one match.
 *
 * @param {string} projectPath - Project root
 * @param {object} step - Step spec
 * @returns {{ok:boolean, planPath:string|null, error:string|null}}
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
  const plansDir = path.join(projectPath, DEFAULT_PLANS_DIR);
  if (!_internal.existsSync(plansDir)) {
    return {
      ok: false,
      planPath: null,
      error: `No plans directory at ${DEFAULT_PLANS_DIR} (and no step.planPath configured)`
    };
  }
  const entries = _internal.readdirSync(plansDir).filter((f) => f.endsWith('.md'));
  if (entries.length === 0) {
    return {
      ok: false,
      planPath: null,
      error: `No .md plans found in ${DEFAULT_PLANS_DIR}`
    };
  }
  if (entries.length > 1) {
    return {
      ok: false,
      planPath: null,
      error: `Multiple .md plans in ${DEFAULT_PLANS_DIR} (${entries.join(', ')}) — set step.planPath to disambiguate`
    };
  }
  return { ok: true, planPath: path.join(plansDir, entries[0]), error: null };
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
  if (!planRes.ok) {
    return {
      ok: false,
      status: 'blocked',
      output: {
        remediation: 'This step could not resolve a single build plan. Set `step.planPath` in the methodology template to point at the canonical plan, or clean up `.claude/plans/` so exactly one `.md` plan remains (archive shipped plans under `.claude/plans/archive/`). See lib/wrap-steps/priming-roll.js for the disambiguation contract.'
      },
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
    return {
      ok: false,
      status: 'blocked',
      output: {
        remediation: 'The resolved plan has no `### Chunk N: Title` headings, so there is no chunk to roll the priming pointer to. Add chunk headings to the plan, or point `step.planPath` at the correct plan file.'
      },
      blockers: [`No "### Chunk N: Title" headings found in ${planRes.planPath}`]
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
  _renderPointerBody,
  _replaceManagedBlock,
  _resolvePlanPath,
  _resolvePrimingPath,
  BEGIN_MARKER,
  END_MARKER,
  DEFAULT_PRIMING_PATH,
  DEFAULT_PLANS_DIR
};
