'use strict';

/**
 * `index-describe` wrap step (#426) — the value-delivery half of the PIDX
 * auto-orientation indexes. The Feature Index (`FEATURES.md`, #207) and the
 * Project Map (`PROJECT-MAP.md`, #360) both seed *empty* description stubs
 * (`<!-- describe -->`) that a human otherwise fills by hand, leaving the value
 * latent. This step asks the live session's AI to fill **only the empty stubs**
 * with a brief one-line note based on each directory's / feature's actual
 * contents — turning the indexes from skeletons into useful orientation.
 *
 * **Contract (never blocks — it is an enhancement, not a gate):**
 *
 *   - Skip when there is no active session (nothing to drive the AI).
 *   - Skip when neither index toggle is on (`projectMapEnabled` /
 *     `featureIndexEnabled`).
 *   - For each enabled index file, include it as a describe target ONLY when:
 *       1. the file exists on disk, AND
 *       2. it has ≥1 empty `<!-- describe -->` stub, AND
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
 *   - Skip when no target files qualify (no enabled file has describable,
 *     non-pending empty stubs).
 *   - Otherwise: build a prompt naming the target file(s) + the
 *     fill-only-empty-stubs contract and delegate send→poll→capture to
 *     `ai-content.run` (reuse, not reimplement — no captureFields, the AI edits
 *     the files directly memory-update-style; `commit`'s `git add -A` picks the
 *     edits up). After the AI turn, re-scan each target and report
 *     `describedCount = Σ(emptyBefore − emptyAfter)` (clamped ≥0, the honest
 *     count of stubs actually filled), staged under `staged['index-describe']`
 *     as `{indexDescribe:true, describedCount}` so `commit.js:_buildBodyLines`
 *     renders `- Index: described N stub(s)`. Any ai-content non-success
 *     (timeout / declined / webui-skip / send failure) → graceful `skipped`.
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
  const candidates = [];
  if (projConfig.featureIndexEnabled === true) {
    candidates.push({ filename: projects.FEATURE_INDEX_FILENAME, stagedKey: 'features-toc:append', label: 'Feature Index' });
  }
  if (projConfig.projectMapEnabled === true) {
    candidates.push({ filename: projects.PROJECT_MAP_FILENAME, stagedKey: 'project-map:refresh', label: 'Project Map' });
  }
  if (candidates.length === 0) {
    return _skipped('neither featureIndexEnabled nor projectMapEnabled is true');
  }

  // Resolve describe targets: on-disk, has empty stubs, and NO pending staged
  // write this wrap (else the commit-step flush would clobber the AI's edits).
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
    const stubsBefore = _countStubs(content);
    if (stubsBefore === 0) {
      continue; // nothing empty to describe
    }
    targets.push({ ...c, filePath, stubsBefore });
  }

  if (targets.length === 0) {
    return _skipped('no enabled index file has describable empty stubs (or all have pending staged writes)');
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

  // Re-scan each target to count stubs actually filled. The AI edited the
  // files on disk during its turn; an honest count beats reporting the target.
  let describedCount = 0;
  for (const t of targets) {
    let after;
    try {
      after = _internal.readFileSync(t.filePath, 'utf8');
    } catch {
      continue; // can't measure — count nothing for this file
    }
    const stubsAfter = _countStubs(after);
    describedCount += Math.max(0, t.stubsBefore - stubsAfter);
  }

  // Replace ai-content's generic capture marker with the describe-count shape
  // so the commit body renders "- Index: described N stub(s)" (not the generic
  // "AI content (index-describe): captured" line).
  staged[STEP_ID] = { indexDescribe: true, describedCount, stepId: STEP_ID };

  log.info('index-describe applied', {
    project: project.name,
    targets: targets.map((t) => t.filename),
    describedCount
  });

  return {
    ok: true,
    status: 'done',
    output: {
      describedCount,
      files: targets.map((t) => t.filename),
      detail: `described ${describedCount} stub(s) across ${targets.length} index file(s)`
    },
    blockers: []
  };
}

/**
 * Build the describe prompt naming the target index file(s) and the
 * fill-only-empty-stubs contract. The instructions bound the AI to empty
 * `<!-- describe -->` stubs and forbid touching curated entries or
 * adding/removing entries (curation-preserving — the same invariant the
 * index refreshers honor).
 *
 * @param {Array<{filename:string, label:string, stubsBefore:number}>} targets
 * @returns {string}
 */
function _buildPrompt(targets) {
  const fileList = targets
    .map((t) => `- \`${t.filename}\` (${t.label}, ${t.stubsBefore} empty stub${t.stubsBefore === 1 ? '' : 's'})`)
    .join('\n');
  return [
    'You are at the end of a development session. The project keeps AI-orientation index file(s) whose description stubs are currently empty. Fill them in so future sessions can find things faster.',
    '',
    'Target file(s):',
    fileList,
    '',
    `For EACH empty \`${STUB_MARKER}\` stub in those file(s):`,
    `- Replace the literal \`${STUB_MARKER}\` marker with a brief one-line description of what that directory or feature contains, based on its ACTUAL contents (read the directory / files if unsure).`,
    '- Keep it to a single concise line — a few words to a short sentence. No trailing newline changes to the rest of the file.',
    '',
    'STRICT rules:',
    `- Only touch lines that still contain the literal \`${STUB_MARKER}\` marker. Never overwrite an entry that already has a human- or AI-written description (preserve curation).`,
    '- Do NOT add new entries, remove entries, reorder, or restructure the file. Only fill empty stubs in place.',
    '- Edit the file(s) directly with your file tools. The wrap commit picks the changes up automatically.',
    '',
    'When done, reply with a single `## Result` heading followed by a one-line summary (e.g. "Described N stubs in PROJECT-MAP.md"). If there was nothing fillable, say so — do not fabricate descriptions.'
  ].join('\n');
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
  _skipped,
  _internal,
  STEP_ID,
  STUB_MARKER
};
