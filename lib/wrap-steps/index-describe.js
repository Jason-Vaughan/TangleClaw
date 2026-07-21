'use strict';

/**
 * `index-describe` wrap step (#426, #568) — the value-delivery half of the PIDX
 * auto-orientation indexes. It runs the live session's AI over the enabled
 * index file(s) at wrap, in one of two modes per file:
 *
 *   - **describe** (Project Map, `PROJECT-MAP.md`, #360): fill each empty
 *     `<!-- describe -->` stub with a brief one-line note based on the
 *     directory's actual contents — fill-only, never restructure.
 *   - **graduate** (Feature Index, `FEATURES.md`, #207 / #568): the Feature
 *     Index can otherwise never converge. `features-toc` appends
 *     `## TODO (auto-stubbed …)` blocks of `- **TBD** — … ` entries that the
 *     old fill-only contract could describe but never NAME or MOVE, so curated
 *     categories stayed empty forever and the TODO piles grew without bound.
 *     Graduate mode names each TODO-block entry, describes it, and files it
 *     under the best-fit real category, deleting emptied blocks — the missing
 *     step that lets the index converge. The curation invariant is re-scoped
 *     from "touch only `<!-- describe -->` lines" to "touch only entries inside
 *     a TODO block": a graduate step must restructure, but curated entries
 *     under real categories stay untouchable.
 *
 * **Contract (never blocks — it is an enhancement, not a gate):**
 *
 *   - Skip when there is no active session (nothing to drive the AI).
 *   - Skip when neither index toggle is on (`projectMapEnabled` /
 *     `featureIndexEnabled`).
 *   - For each enabled index file, include it as a target ONLY when:
 *       1. the file exists on disk, AND
 *       2. it has work to do for its mode — a describe file with ≥1 empty
 *          `<!-- describe -->` stub, or a graduate file with ≥1 entry inside a
 *          `## TODO (auto-stubbed …)` block (whether or not that entry still
 *          carries a `<!-- describe -->` marker), AND
 *       3. it has **no pending staged write this wrap** — `features-toc` and
 *          `project-map` *stage* their writes (`staged['features-toc:append']`
 *          / `staged['project-map:refresh']`) for `commit.js:_flushStagedWrites`
 *          to flush at the commit step; they do not write during their own step.
 *          The AI edits the on-disk file directly here, so if we described a
 *          file that also has a pending staged write, the commit-time flush
 *          would **overwrite the AI's descriptions** with the pre-edit staged
 *          content. Skipping such files defers their brand-new stubs to the
 *          NEXT wrap (when the file is settled on disk with no pending write) —
 *          a self-converging one-wrap lag. See `index-auto-describe.md`.
 *   - Skip when no target files qualify (no enabled file has stubs to describe
 *     or entries to graduate, non-pending).
 *   - Otherwise: build a mode-branched prompt naming the target file(s) and
 *     delegate send→poll→capture to `ai-content.run` (reuse, not reimplement —
 *     no captureFields, the AI edits the files directly memory-update-style;
 *     `commit`'s `git add -A` picks the edits up). After the AI turn, re-scan
 *     each target and report `describedCount = Σ(stubsBefore − stubsAfter)` and
 *     `graduatedCount = Σ(todoEntriesBefore − todoEntriesAfter)` (each clamped
 *     ≥0, the honest count of what actually happened), staged under
 *     `staged['index-describe']` as `{indexDescribe:true, describedCount,
 *     graduatedCount}` so `commit.js:_buildBodyLines` renders the audit lines.
 *     Any ai-content non-success (timeout / declined / webui-skip / send
 *     failure) → graceful `skipped`.
 *
 * **Why lazy-require `../projects`.** Same wrap-pipeline require cycle the
 * project-map handler documents (`projects → sessions → wrap-pipeline →
 * wrap-steps/*`): a top-level `require('../projects')` captures partial exports.
 * Required inside `run()` it resolves the complete module.
 *
 * @module lib/wrap-steps/index-describe
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logger');
const store = require('../store');
const aiContent = require('./ai-content');

const log = createLogger('wrap-step-index-describe');

const STEP_ID = 'index-describe';

// The shared empty-stub marker. Both indexes emit this exact placeholder for an
// un-filled entry (Project Map dir lines: "- `lib/` — <!-- describe -->";
// Feature Index auto-stubs: "- **TBD** — touched in this session: `p`. <!-- describe -->").
const STUB_MARKER = '<!-- describe -->';

// The `## TODO (auto-stubbed …)` block parse is shared with the prime
// summarizer (one dependency-free source of truth for the auto-stub format,
// which is a contract with the `features-toc` producer). `feature-index-prime`
// has no requires, so importing it here introduces no cycle.
const {
  countTodoEntries: _countTodoEntries,
  countCuratedEntries: _countCuratedEntries
} = require('../feature-index-prime');

/**
 * Count the empty `<!-- describe -->` stubs in a string. Substring count — a
 * line can only carry one marker, so occurrences == describable stubs.
 *
 * @param {string} content
 * @returns {number}
 */
function _countStubs(content) {
  if (!content || typeof content !== 'string') return 0;
  return content.split(STUB_MARKER).length - 1;
}

/**
 * Step handler. See module docstring for the full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (`{name, path}`)
 * @param {object|null} context.session - Active session record (required)
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:boolean, status:string, output:object, blockers:string[]}>}
 */
async function run(context) {
  const projects = require('../projects'); // lazy — breaks the require cycle (see module head)
  const { project, session, staged } = context;

  if (!project || !project.path) {
    return _skipped('no project path');
  }
  if (!session) {
    // No live session to drive the AI — nothing to describe. Honest skip
    // (never a blocker: describe is an enhancement).
    return _skipped('no active session to drive the describe prompt');
  }

  let projConfig;
  try {
    projConfig = store.projectConfig.load(project.path);
  } catch (err) {
    return _skipped(`projectConfig.load threw: ${err.message}`);
  }
  if (!projConfig) {
    return _skipped('no project config');
  }

  // Candidate index files, each gated by its own toggle. The Feature Index
  // filename comes from `projects` so the constant has a single source.
  // Each candidate carries a `mode`: the Feature Index is `graduate` (name +
  // describe TODO-block stubs and file them into a real category — #568), the
  // Project Map is `describe` (fill empty `<!-- describe -->` stubs in place —
  // #426). The mode picks the trigger, the prompt contract, and the count.
  const candidates = [];
  if (projConfig.featureIndexEnabled === true) {
    candidates.push({ filename: projects.FEATURE_INDEX_FILENAME, stagedKey: 'features-toc:append', label: 'Feature Index', mode: 'graduate' });
  }
  if (projConfig.projectMapEnabled === true) {
    candidates.push({ filename: projects.PROJECT_MAP_FILENAME, stagedKey: 'project-map:refresh', label: 'Project Map', mode: 'describe' });
  }
  if (candidates.length === 0) {
    return _skipped('neither featureIndexEnabled nor projectMapEnabled is true');
  }

  // Resolve targets: on-disk, has work to do (mode-specific trigger), and NO
  // pending staged write this wrap (else the commit-step flush would clobber
  // the AI's edits — the same one-wrap-lag gate for both modes).
  const targets = [];
  for (const c of candidates) {
    if (staged && staged[c.stagedKey]) {
      continue; // pending staged write — defer to next wrap (clobber-avoidance)
    }
    const filePath = path.join(project.path, c.filename);
    if (!_internal.existsSync(filePath)) {
      continue;
    }
    let content;
    try {
      content = _internal.readFileSync(filePath, 'utf8');
    } catch {
      continue; // unreadable — skip this file, never block
    }
    if (c.mode === 'graduate') {
      // Trigger on ANY entry inside a TODO block — not only entries that still
      // carry a `<!-- describe -->` marker — so a described-but-un-graduated
      // `**TBD**` entry (pre-existing installs) still gets finished.
      const entriesBefore = _countTodoEntries(content);
      if (entriesBefore === 0) {
        continue; // nothing to graduate
      }
      // curatedBefore = entries already under real categories. The honest
      // graduated count is how many NEW curated entries appear (arrivals), not
      // how many left the backlog — a dropped entry leaves the backlog without
      // arriving anywhere.
      const curatedBefore = _countCuratedEntries(content);
      targets.push({ ...c, filePath, entriesBefore, curatedBefore, stubsBefore: 0 });
    } else {
      const stubsBefore = _countStubs(content);
      if (stubsBefore === 0) {
        continue; // nothing empty to describe
      }
      targets.push({ ...c, filePath, stubsBefore, entriesBefore: 0 });
    }
  }

  if (targets.length === 0) {
    return _skipped('no enabled index file has stubs to describe or entries to graduate (or all have pending staged writes)');
  }

  const prompt = _buildPrompt(targets);

  // Delegate send→poll→capture to ai-content (reuse, not reimplement). No
  // captureFields — the AI edits the index file(s) directly; the commit step's
  // `git add -A` picks the edits up. A synthetic non-blocker step carries the
  // prompt. ai-content stages a generic capture marker under STEP_ID on
  // success, which we replace below with the describe-count shape.
  let aiRes;
  try {
    aiRes = await aiContent.run({
      ...context,
      step: { id: STEP_ID, kind: 'ai-content', blocker: false, prompt }
    });
  } catch (err) {
    delete staged[STEP_ID];
    return _skipped(`ai-content delegation threw: ${err.message}`);
  }

  if (!aiRes || aiRes.ok !== true || aiRes.status !== 'done') {
    // Timeout, declined, webui-skip, or send failure. Never block — drop any
    // partial capture marker and skip gracefully so the wrap proceeds.
    delete staged[STEP_ID];
    const reason = aiRes && Array.isArray(aiRes.blockers) && aiRes.blockers.length > 0
      ? aiRes.blockers[0]
      : (aiRes && aiRes.output && aiRes.output.reason) || 'AI did not complete the describe turn';
    return _skipped(`describe not applied: ${reason}`);
  }

  // Re-scan each target to count what the AI actually did. It edited the files
  // on disk during its turn; an honest count beats reporting the target. Count
  // by mode: describe files by stubs filled, graduate files by TODO entries
  // that left the backlog.
  let describedCount = 0;
  let graduatedCount = 0;
  for (const t of targets) {
    let after;
    try {
      after = _internal.readFileSync(t.filePath, 'utf8');
    } catch {
      continue; // can't measure — count nothing for this file
    }
    if (t.mode === 'graduate') {
      // Honest count = entries that ARRIVED under a real category (curated
      // growth), clamped ≥0. This can't be inflated by an entry the AI dropped
      // instead of filing. If more entries left the backlog than arrived in
      // categories, the difference vanished — surface it rather than bill it as
      // graduated (the commit audit line must not read data loss as success).
      const entriesAfter = _countTodoEntries(after);
      const leftBacklog = Math.max(0, t.entriesBefore - entriesAfter);
      const arrived = Math.max(0, _countCuratedEntries(after) - t.curatedBefore);
      graduatedCount += arrived;
      if (leftBacklog > arrived) {
        log.warn('index-describe: TODO entries left the backlog without landing in a category', {
          project: project.name, file: t.filename, leftBacklog, arrived, dropped: leftBacklog - arrived
        });
      }
    } else {
      const stubsAfter = _countStubs(after);
      describedCount += Math.max(0, t.stubsBefore - stubsAfter);
    }
  }

  // Replace ai-content's generic capture marker with the describe/graduate-count
  // shape so the commit body renders honest audit lines (not the generic
  // "AI content (index-describe): captured" line).
  staged[STEP_ID] = { indexDescribe: true, describedCount, graduatedCount, stepId: STEP_ID };

  log.info('index-describe applied', {
    project: project.name,
    targets: targets.map((t) => t.filename),
    describedCount,
    graduatedCount
  });

  return {
    ok: true,
    status: 'done',
    output: {
      describedCount,
      graduatedCount,
      files: targets.map((t) => t.filename),
      detail: `graduated ${graduatedCount} entr${graduatedCount === 1 ? 'y' : 'ies'}, described ${describedCount} stub(s) across ${targets.length} index file(s)`
    },
    blockers: []
  };
}

/**
 * Build the AI prompt for the target index file(s). Two contracts, keyed on
 * each target's `mode`:
 *
 *   - `describe` (Project Map): fill empty `<!-- describe -->` stubs in place;
 *     the invariant forbids touching any entry that already has a description,
 *     and forbids restructuring (the #426 curation-preserving contract).
 *   - `graduate` (Feature Index, #568): name the `**TBD**` entries inside a
 *     `## TODO (auto-stubbed …)` block, describe them, and MOVE them under the
 *     best-fit real category, deleting the block once empty. The invariant is
 *     re-scoped to "only touch entries inside a TODO block" — a graduate step
 *     must restructure, so the fill-only invariant is too tight, but curated
 *     entries under real categories stay untouchable.
 *
 * @param {Array<{filename:string, label:string, mode?:string, stubsBefore?:number, entriesBefore?:number}>} targets
 * @returns {string}
 */
function _buildPrompt(targets) {
  const describeTargets = targets.filter((t) => t.mode !== 'graduate');
  const graduateTargets = targets.filter((t) => t.mode === 'graduate');
  const parts = [
    'You are at the end of a development session. The project keeps AI-orientation index file(s) that need finishing so future sessions can find things faster.',
    ''
  ];

  if (describeTargets.length > 0) {
    const fileList = describeTargets
      .map((t) => `- \`${t.filename}\` (${t.label}, ${t.stubsBefore} empty stub${t.stubsBefore === 1 ? '' : 's'})`)
      .join('\n');
    parts.push(
      'FILL empty description stubs (do not restructure these files):',
      fileList,
      '',
      `For EACH empty \`${STUB_MARKER}\` stub in the file(s) above:`,
      `- Replace the literal \`${STUB_MARKER}\` marker with a brief one-line description of what that directory or feature contains, based on its ACTUAL contents (read the directory / files if unsure).`,
      '- Keep it to a single concise line. No trailing newline changes to the rest of the file.',
      '',
      'STRICT rules (fill-only files):',
      `- Only touch lines that still contain the literal \`${STUB_MARKER}\` marker. Never overwrite an entry that already has a description (preserve curation).`,
      '- Do NOT add, remove, reorder, or restructure entries. Only fill empty stubs in place.',
      ''
    );
  }

  if (graduateTargets.length > 0) {
    const fileList = graduateTargets
      .map((t) => `- \`${t.filename}\` (${t.label}, ${t.entriesBefore} entr${t.entriesBefore === 1 ? 'y' : 'ies'} awaiting graduation)`)
      .join('\n');
    parts.push(
      'CURATE the auto-stubbed backlog (graduate TODO entries into their real home):',
      fileList,
      '',
      'Each file above has one or more `## TODO (auto-stubbed <date>)` blocks whose entries were auto-added when a session touched new files. Finish the job for EACH entry inside a `## TODO (auto-stubbed …)` block:',
      '- Give it a real short **Name** in place of `**TBD**`, inferred from what the file actually is (read the file if unsure).',
      '- Write a brief one-line description (keep an existing good description; replace any leftover `<!-- describe -->` marker).',
      '- Keep the exact backtick path token unchanged (e.g. `lib/foo.js`) — it is the stable anchor.',
      '- MOVE the finished entry out of the TODO block and under the single best-fit EXISTING category heading. Match the category to the entry; do not invent new categories.',
      '- When a `## TODO (auto-stubbed …)` block has no entries left, DELETE the now-empty heading and its surrounding blank lines.',
      '',
      'STRICT rules (curated files):',
      '- Only ever touch entries currently inside a `## TODO (auto-stubbed …)` block, and the TODO headings themselves. NEVER modify, reorder, or delete an entry already under a real category heading, and never touch the file\'s top comment. That existing curation is authoritative.',
      '- Do not drop any entry: every TODO entry must end up under a category. If you truly cannot tell what a file is, give it a best-effort name and file it under the closest category — never delete it.',
      ''
    );
  }

  parts.push(
    'Edit the file(s) directly with your file tools. The wrap commit picks the changes up automatically.',
    '',
    'When done, reply with a single `## Result` heading followed by a one-line summary (e.g. "Graduated N entries, described M stubs"). If there was nothing to do, say so — do not fabricate.'
  );
  return parts.join('\n');
}

/**
 * Canonical skip signal (#204) — `status:'skipped'`, never a blocker.
 * @param {string} reason
 * @returns {{ok:boolean, status:string, output:object, blockers:string[]}}
 */
function _skipped(reason) {
  return {
    ok: true,
    status: 'skipped',
    output: { reason, detail: reason },
    blockers: []
  };
}

const _internal = {
  existsSync: fs.existsSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs)
};

module.exports = {
  run,
  _buildPrompt,
  _countStubs,
  _countTodoEntries,
  _skipped,
  _internal,
  STEP_ID,
  STUB_MARKER
};
