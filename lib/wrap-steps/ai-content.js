'use strict';

/**
 * `ai-content` wrap step (#139 Chunk 5) — sends a prompt to the AI
 * engine via tmux, polls for AI idle, captures the pane output, and
 * optionally validates structured response.
 *
 * The same handler powers both prawduct's `memory-update` step (AI
 * writes the session MEMORY block to `.tangleclaw/memories/MEMORY.md`
 * via its own file tools — TangleClaw owns the *prompt*, not the
 * write) and the `summary-derive` step (AI emits `## Heading` blocks
 * the handler parses against `step.captureFields`). The contract is
 * the same; the *prompt* differs.
 *
 * **Prompt construction.** `step.prompt` is treated as a template
 * string. One substitution token is supported in Chunk 5:
 *   `{previousMemoryBlock}` → captured output of the prior step
 *   whose `stepId === 'memory-update'` (if any).
 * Substitution is a single literal `String.replace` — not a template
 * engine. Unrecognized braces in the prompt pass through verbatim.
 *
 * **Send → poll → capture.** Prompt goes out via `tmux.sendKeys` with
 * Enter; the handler then sleeps the initial settle window and polls
 * `detectIdle` every `POLL_INTERVAL_MS` (default 2s) until idle is
 * reported. `detectIdle` itself defines "idle" as ≥10s of unchanged
 * pane output (see `lib/sessions.js:detectIdle`). Total wait is
 * capped by `MAX_WAIT_MS` (default 5 min) — exceeded → `ok:false,
 * status:'blocked'`. On idle, full pane scrollback is captured via
 * `tmux.capturePane({full:true})` and parsed.
 *
 * **Validation.** If `step.captureFields[]` is set, each field must
 * appear as a `## Heading` (case-insensitive match) with non-empty
 * content. Missing/empty fields → `ok:false, status:'blocked',
 * blockers:[…]`. If `captureFields` is unset/empty, the handler only
 * asserts the AI produced a non-trivial response (≥20 chars after
 * trimming) — this catches AI no-ops and runaway timeouts that
 * detectIdle accepted prematurely (rare; tmux idle is 10s of zero
 * change).
 *
 * **Single-transaction discipline.** This handler does NOT touch the
 * filesystem; it stages its captured text in `context.staged` under
 * the step's `id` key. The `commit` step (Chunk 9) is the only
 * runner step that flushes `staged` to the working tree. The AI's
 * MEMORY.md edits are filesystem writes the AI itself performs —
 * they sit in the working tree until the `commit` step picks them up.
 */

// `lib/sessions.js` is loaded lazily inside `defaultDetectIdle` to break
// the module-load cycle:
//   sessions.js → wrap-pipeline.js → wrap-steps/ai-content.js → sessions.js
// At call time the cycle is fully resolved, so `sessions.detectIdle` is
// always defined. `lib/tmux.js` has no back-edge to sessions and is safe
// to eager-require.
const fs = require('node:fs');
const path = require('node:path');
const tmuxLib = require('../tmux');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-ai-content');

const INITIAL_SETTLE_MS = 3000;
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes — wraps with long Critic dispatches can run this long; bounded so a stuck AI cannot wedge the wrap drawer forever
const MIN_RESPONSE_CHARS = 20;

/**
 * Default sleep — mockable so tests don't sit on real wall-clock
 * delays. Tests override via `_internal.sleep`.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Interpolate the Chunk-5 supported tokens into a step prompt. Only
 * `{previousMemoryBlock}` is recognized today; unrecognized braces
 * pass through verbatim so the AI can see the original literal if a
 * methodology author misnamed a token.
 *
 * @param {string} promptTemplate - The raw `step.prompt` string
 * @param {Array} previousResults - Prior step results from runner context
 * @returns {string} The interpolated prompt ready for tmux
 */
function _interpolatePrompt(promptTemplate, previousResults) {
  if (!promptTemplate) return '';
  if (!promptTemplate.includes('{previousMemoryBlock}')) return promptTemplate;

  const memoryStep = previousResults.find(
    (r) => r.stepId === 'memory-update' && r.status === 'done'
  );
  const memoryText = (memoryStep && memoryStep.output && memoryStep.output.capturedText) || '';
  return promptTemplate.replace(/\{previousMemoryBlock\}/g, memoryText);
}

/**
 * Normalize a field-name token for matching: lowercase, strip every
 * character that isn't `[a-z0-9]`. Used symmetrically on both the
 * heading text and the declared captureField so the two only need to
 * agree on alphanumeric content. Resolves a known fragility class
 * (#201): the parser previously required exact-string equality after
 * `.toLowerCase()`, which made `step.captureFields: ['nextSteps']`
 * silently reject the most natural Markdown heading `## Next Steps`
 * (two words). Normalizing strips spaces, hyphens, underscores,
 * punctuation — so `Next Steps`, `next-steps`, `next_steps`,
 * `NEXT.STEPS`, and `nextSteps` all collapse to the same match key
 * `nextsteps`.
 *
 * @param {string} s - Raw heading text OR a captureField name
 * @returns {string} Alphanumeric-only lowercase key
 */
function _normalizeFieldKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parse captured pane output into `## Heading` sections. Mirrors the
 * `parseWrapSummary` logic in `lib/sessions.js` but returns the raw
 * sections map (not a flattened string) so the handler can validate
 * field-by-field.
 *
 * Heading-to-captureField matching uses `_normalizeFieldKey` on both
 * sides — symmetric normalization absorbs natural-English whitespace
 * and punctuation variants without requiring the methodology author
 * to enumerate synonyms (see #201 rationale).
 *
 * @param {string} rawOutput - Pane scrollback as a single string
 * @param {string[]} captureFields - Field names expected as `## Heading`
 * @returns {Record<string,string>} Map of field name → trimmed section content
 */
function _parseFields(rawOutput, captureFields) {
  const sections = {};
  if (!rawOutput || !captureFields || captureFields.length === 0) return sections;

  const lines = rawOutput.split('\n');
  let currentField = null;
  let currentContent = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      const heading = _normalizeFieldKey(headingMatch[1]);
      const matched = captureFields.find((f) => _normalizeFieldKey(f) === heading);
      if (matched) {
        if (currentField) sections[currentField] = currentContent.join('\n').trim();
        currentField = matched;
        currentContent = [];
        continue;
      }
    }
    if (currentField) currentContent.push(line);
  }
  if (currentField) sections[currentField] = currentContent.join('\n').trim();
  return sections;
}

/**
 * Step handler. See module docstring for full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record
 * @param {object|null} context.session - Active Session record (must have tmuxSession)
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @param {Array} context.previousResults - Prior step results
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, session, step, previousResults, staged } = context;

  if (!session || !session.tmuxSession) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: ['ai-content step requires an active tmux session']
    };
  }

  // #139 Chunk 11c — empty prompt = methodology author's intentional
  // skip marker, not a structural failure. Pre-Chunk-11c this returned
  // `status: 'blocked'`, which was harmless while `wrapV2: false` was
  // the default but would surface as a `blocked` row in every prawduct
  // wrap drawer post-flip (prawduct ships three intentionally-empty
  // `ai-content` placeholder steps that depend on future prompt-content
  // work). Returning `status: 'skipped'` matches the intent: the step
  // is declared but has no work to do today.
  if (typeof step.prompt !== 'string' || step.prompt.trim() === '') {
    return {
      ok: true,
      status: 'skipped',
      output: null,
      blockers: []
    };
  }

  const prompt = _interpolatePrompt(step.prompt, previousResults || []);
  const tmuxSession = session.tmuxSession;

  try {
    _internal.sendKeys(tmuxSession, prompt, { enter: true });
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: [`Failed to send prompt to tmux: ${err.message}`]
    };
  }

  log.info('ai-content prompt sent', {
    project: project.name,
    stepId: step.id,
    promptLength: prompt.length
  });

  // Capture the deadline BEFORE the initial settle so the total wait
  // (settle + polling) is bounded by MAX_WAIT_MS, matching the
  // module-level docstring. Capturing after the sleep would let the
  // effective cap drift to MAX_WAIT_MS + INITIAL_SETTLE_MS — small but
  // misleading enough to surface in the wrap-blocked error message.
  const startedAt = Date.now();
  await _internal.sleep(INITIAL_SETTLE_MS);

  let idled = false;
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    let idleInfo;
    try {
      idleInfo = _internal.detectIdle(tmuxSession);
    } catch (err) {
      // detectIdle can throw if the tmux session dies mid-poll
      return {
        ok: false,
        status: 'blocked',
        output: null,
        blockers: [`Idle detection failed: ${err.message}`]
      };
    }
    if (idleInfo && idleInfo.idle) {
      idled = true;
      break;
    }
    await _internal.sleep(POLL_INTERVAL_MS);
  }

  if (!idled) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: [`AI did not return within ${Math.round(MAX_WAIT_MS / 1000)}s — wrap pipeline blocked`]
    };
  }

  let capture;
  try {
    capture = _internal.capturePane(tmuxSession, { full: true });
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: [`Failed to capture pane after AI idle: ${err.message}`]
    };
  }

  const capturedText = (capture.lines || []).join('\n');
  const trimmed = capturedText.trim();

  const captureFields = Array.isArray(step.captureFields) ? step.captureFields : [];

  // #287: `capture-pane -p` returns the TUI-RENDERED pane (escapes
  // stripped), and Claude Code renders `## Heading` without the literal
  // `##` — so parsing structured `## Heading` blocks out of the pane never
  // matches. A step that needs structured fields declares `captureFile`:
  // the AI writes the block to that project-relative file (raw markdown,
  // `##` preserved) and we parse the file instead of the pane. Consume-once
  // — the file is removed after a successful read so a later wrap can't
  // pick up a stale summary if the AI fails to rewrite it. Steps without
  // `captureFile` keep the original pane-parse behavior unchanged.
  let parseSource = capturedText;
  if (captureFields.length > 0 && step.captureFile) {
    try {
      parseSource = _internal.readCaptureFile(project.path, step.captureFile);
    } catch (err) {
      return {
        ok: false,
        status: 'blocked',
        output: { capturedText },
        blockers: [`captureFile "${step.captureFile}" missing or unreadable after AI idle — the step prompt must instruct the AI to write the structured block there (${err.code || err.message})`]
      };
    }
    _internal.removeCaptureFile(project.path, step.captureFile);
  }

  if (captureFields.length > 0) {
    const sections = _parseFields(parseSource, captureFields);
    const missing = captureFields.filter((f) => !sections[f] || !sections[f].trim());
    if (missing.length > 0) {
      return {
        ok: false,
        status: 'blocked',
        output: { capturedText, parsedFields: sections },
        blockers: missing.map((f) => `Required captureField "${f}" missing or empty in AI response`)
      };
    }
    // Stage the parsed fields for the commit step (Chunk 9) to consume.
    staged[step.id] = { capturedText, parsedFields: sections };
    return {
      ok: true,
      status: 'done',
      output: { capturedText, parsedFields: sections },
      blockers: []
    };
  }

  // No captureFields → minimal validation: just check the AI said
  // *something*. Below this threshold the AI either no-op'd or
  // detectIdle tripped prematurely on a still-streaming response.
  if (trimmed.length < MIN_RESPONSE_CHARS) {
    return {
      ok: false,
      status: 'blocked',
      output: { capturedText },
      blockers: [`AI response too short (${trimmed.length} chars; expected ≥${MIN_RESPONSE_CHARS})`]
    };
  }

  staged[step.id] = { capturedText, parsedFields: null };
  return {
    ok: true,
    status: 'done',
    output: { capturedText, parsedFields: null },
    blockers: []
  };
}

/**
 * Lazy-resolving wrapper around `lib/sessions.js:detectIdle` — defers
 * the require until call time so the module-load cycle never trips.
 * @param {string} tmuxSession
 * @returns {{idle:boolean, lastOutputAge:number}}
 */
function defaultDetectIdle(tmuxSession) {
  return require('../sessions').detectIdle(tmuxSession);
}

/**
 * Read a step's `captureFile` (project-relative) as raw UTF-8. Throws on
 * a missing/unreadable file so the handler can block with a clear message
 * (#287). Overridable via `_internal` for tests.
 * @param {string} projectPath - Absolute project root
 * @param {string} relPath - Project-relative capture-file path
 * @returns {string} Raw file contents
 */
function defaultReadCaptureFile(projectPath, relPath) {
  return fs.readFileSync(path.join(projectPath, relPath), 'utf8');
}

/**
 * Best-effort removal of a consumed `captureFile` so a later wrap can't
 * parse a stale summary if the AI fails to rewrite it (#287). Swallows
 * errors — a leftover file is not worth blocking the wrap. Overridable
 * via `_internal` for tests.
 * @param {string} projectPath - Absolute project root
 * @param {string} relPath - Project-relative capture-file path
 * @returns {void}
 */
function defaultRemoveCaptureFile(projectPath, relPath) {
  try {
    fs.unlinkSync(path.join(projectPath, relPath));
  } catch {
    /* best-effort cleanup — leftover transient file is harmless */
  }
}

const _internal = {
  sendKeys: tmuxLib.sendKeys,
  capturePane: tmuxLib.capturePane,
  detectIdle: defaultDetectIdle,
  sleep: defaultSleep,
  readCaptureFile: defaultReadCaptureFile,
  removeCaptureFile: defaultRemoveCaptureFile
};

module.exports = { run, _internal, _interpolatePrompt, _parseFields, _normalizeFieldKey };
