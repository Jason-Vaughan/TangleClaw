'use strict';

/**
 * `ai-content` wrap step (#139 Chunk 5) — sends a prompt to the AI
 * engine via tmux, waits for the step to finish, captures the pane output, and
 * optionally validates structured response.
 *
 * The same handler powers both prawduct's `memory-update` step (AI
 * writes the session MEMORY block to `.tangleclaw/memories/MEMORY.md`
 * via its own file tools — TangleClaw owns the *prompt*, not the
 * write) and the `summary-derive` step (AI emits `## Heading` blocks
 * the handler parses against `step.captureFields` plus any
 * `step.optionalCaptureFields`). The contract is
 * the same; the *prompt* differs.
 *
 * **Prompt construction.** `step.prompt` is treated as a template
 * string. Two substitution tokens are supported:
 *   `{previousMemoryBlock}` → captured output of the prior step
 *   whose `stepId === 'memory-update'` (if any).
 *   `{engineConfigFile}`    → the project engine's own config filename
 *   (`configFormat.filename`), so a bundled prompt never names one
 *   engine's file to every engine.
 * Substitution is a single literal `String.replace` — not a template
 * engine. Unrecognized braces in the prompt pass through verbatim.
 * After interpolation, the project's enabled `kind='wrap'` session rules
 * are appended as a `## Project wrap rules` block (see `_appendWrapRules`)
 * on both the tmux and gateway paths.
 *
 * **Read-only pre-check (#429).** Before anything is sent, the pane's footer
 * is sampled against the engine profile's optional
 * `capabilities.readOnlyModeMarker`. A session sitting in a read-only mode
 * (Claude Code's plan mode) cannot do a content step's work — it answers with
 * a plan and waits on an approval — so a present marker fails the step
 * immediately with `status:'needs-operator'` and the exit instruction, instead
 * of spending MAX_WAIT_MS discovering it. An engine with no marker declared,
 * or a pane that could not be read, records that honestly on the step
 * (`output.readOnlyPrecheck`) and proceeds exactly as before.
 *
 * **Send → poll → capture.** Prompt goes out via `tmux.sendKeys` with
 * Enter, ending with a completion instruction that carries a fresh nonce.
 * The handler then sleeps the initial settle window and polls every
 * `POLL_INTERVAL_MS` (default 2s) for three completion signals, checked in
 * this order, capped by `MAX_WAIT_MS` (default 5 min → exceeded is
 * `ok:false, status:'blocked'`):
 *   1. **marker** — the recent pane shows `TCWRAP-DONE <nonce>`. The AI
 *      says it is finished, so the next step cannot land on a turn still
 *      in progress (#1450).
 *   2. **file-settle (#672)** — a file the step is expected to produce
 *      (its `verifyChanged` edits plus any `captureFile`) has changed
 *      from its pre-prompt content, held still for `STABILITY_MS`, and
 *      the marker has still not appeared `MARKER_GRACE_MS` later. This
 *      keys off the work product, not terminal quiet, so an operator
 *      interacting with the session mid-wrap cannot starve the step into
 *      a timeout; the grace keeps a write from ending the wait while the
 *      AI is still composing its reply.
 *   3. **quiet** — the recent pane (`PANE_TAIL_LINES`, not a TUI's static
 *      footer) has not changed for `QUIET_FALLBACK_MS`. The marker is a
 *      hint, not a requirement: an engine that never prints it still
 *      finishes, later and with a note on the step saying no marker was
 *      seen (wrap Direction commitment 2).
 * How the step finished is recorded as `output.completedVia`. On completion,
 * full pane scrollback is captured via `tmux.capturePane({full:true})` and
 * parsed. (The gateway path uses the bridge's own `inputReady` turn-end
 * signal and is unaffected.)
 *
 * **Validation.** If `step.captureFields[]` is set, each field must
 * appear as a `## Heading` (case-insensitive match) with non-empty
 * content. Missing/empty fields → `ok:false, status:'blocked',
 * blockers:[…]`. If `captureFields` is unset/empty, the handler
 * asserts the AI produced a non-trivial response (≥20 chars after
 * trimming) — catching AI no-ops and a prematurely-accepted quiet pane —
 * EXCEPT when completion came from the file-settle signal, where a
 * changed-and-settled output file is stronger evidence than pane
 * length (and the pane may hold unrelated operator chatter).
 *
 * **`step.optionalCaptureFields[]` — wanted, never required.** These
 * are parsed and staged exactly like `captureFields`, but their
 * absence never blocks. The guarantee is per-FIELD, not per-step: a step whose
 * contract is entirely optional still blocks if its `captureFile` is missing or
 * unreadable, because that is a broken run rather than a model's judgment call. The two lists are unioned before parsing
 * because `_parseFields` only recognizes a heading it was given a
 * name for: a field left out of both lists is not "optional", it is
 * invisible, and the section it feeds stays permanently empty.
 * Validation then filters on `captureFields` alone.
 *
 * The split exists because the wrap's judgment sections must degrade
 * rather than halt. `wrap-direction.md` § Direction (2) holds that a
 * step "never hard-fails the wrap for lacking a single engine's
 * feature", and (3) lets a gate block only where failure would be
 * silent or destructive. A judgment section the AI omitted is
 * neither — `lib/continuity.js:renderWrapSummary` renders it as a
 * visible `_⚠ not captured_` and nothing is lost — so it is asked
 * for, taken when offered, and flagged when not.
 *
 * Unset ⇒ behavior identical to a step that declares only
 * `captureFields`. Like `captureFields`, it is absent from
 * `lib/wrap-step-overrides.js`'s allow-list: other subsystems read
 * these fields by name, so a project cannot rename them.
 *
 * **Single-transaction discipline.** This handler does NOT touch the
 * filesystem; it stages its captured text in `context.staged` under
 * the step's `id` key. The `commit` step (Chunk 9) is the only
 * runner step that flushes `staged` to the working tree. The AI's
 * MEMORY.md edits are filesystem writes the AI itself performs —
 * they sit in the working tree until the `commit` step picks them up.
 */

const governance = require('../governance-state');
// `lib/tmux.js` has no back-edge to sessions and is safe to eager-require.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const tmuxLib = require('../tmux');
// `lib/clawbridge.js` only pulls in `node:http` + `./logger`, so it has no
// back-edge to this module — safe to eager-require (unlike `../sessions`).
const clawbridgeLib = require('../clawbridge');
const { resolveBridgeContext } = require('../bridge-context');
// `lib/store.js` is the base data layer with no back-edge into sessions or
// the wrap pipeline — safe to eager-require (wrap-pipeline.js already does).
const store = require('../store');
// Sibling wrap-step module; pulls in `./store` + `./logger` only, so it adds no
// back-edge into sessions or the wrap pipeline.
const changelogCoverage = require('./changelog-coverage');
const learningsCoverage = require('./learnings-coverage');
const gitRange = require('./_git-range');
const releaseRecommendation = require('./_release-recommendation');
const deliveryReceipt = require('../wrap-delivery-receipt');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-ai-content');

const INITIAL_SETTLE_MS = 3000;
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes — wraps with long Critic dispatches can run this long; bounded so a stuck AI cannot wedge the wrap drawer forever

// #672 — how long a step's declared output files must sit UNCHANGED before the
// file-settle signal treats the step as complete. Kept short (a discrete write
// settles fast) and above one POLL_INTERVAL_MS so a multi-file write (e.g.
// memory-update writing MEMORY.md then the captureFile) isn't split mid-way.
const STABILITY_MS = 4000;
const MIN_RESPONSE_CHARS = 20;

// How long the recent pane must stay byte-identical before an engine that never
// printed the completion marker is taken as finished. A minute, not the old 10s:
// a model thinking silently routinely passes 10s, and every early finish sends
// the next step's prompt into a turn that has not ended.
const QUIET_FALLBACK_MS = 60 * 1000;
// The poll reads this many trailing pane lines. Enough to reach above a TUI's
// input box and footer, which hold still while the AI works, to the spinner or
// stream that does move.
const PANE_TAIL_LINES = 80;
const COMPLETION_TOKEN = 'TCWRAP-DONE';
// Once a watched output file has settled, how much longer the step waits for the
// completion marker before taking the settled file as the finish. An AI writes
// its file and then composes its reply; ending the wait at the write would send
// the next prompt into that reply, the same race the marker exists to close. An
// engine that never prints the marker pays this once per file-producing step.
const MARKER_GRACE_MS = 15 * 1000;
// ClawBridge PTY-broker terminal states (CC-7 B1): a session in any of these
// will never become input-ready again, so the gateway poll fast-fails on them
// rather than waiting out MAX_WAIT_MS. (`completed` is intentionally excluded —
// it can describe a finished turn that is also input-ready.)
const GATEWAY_TERMINAL_STATES = ['ended', 'failed', 'timed_out'];

/**
 * Default sleep — mockable so tests don't sit on real wall-clock
 * delays. Tests override via `_internal.sleep`.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Substituted for `{engineConfigFile}` when the project's engine declares no
// config file of its own (openclaw). The prompt still reads sensibly, and the
// alternative — naming some other engine's filename — is what this token exists
// to stop.
const GENERIC_CONFIG_FILE_PHRASE = "the project's configuration file";

/**
 * Tokens `_interpolatePrompt` actually substitutes.
 *
 * Exported so a bundled prompt can be checked against the real implementation:
 * an unrecognized `{token}` passes through VERBATIM to the AI by design (so a
 * misnamed token is visible rather than silently blank), which makes shipping
 * one in a bundled prompt a defect. The guard test asserts membership here
 * rather than banning tokens outright.
 * @type {string[]}
 */
const SUPPORTED_PROMPT_TOKENS = ['previousMemoryBlock', 'engineConfigFile', 'sessionScope'];

/**
 * Resolve the filename of the project's own engine config, for the
 * `{engineConfigFile}` prompt token.
 *
 * Bundled prompts must not name one engine's file: a prompt hardcoding
 * `CLAUDE.md` tells a Gemini or Codex session to read a file that does not
 * exist there, so the step either does nothing or invents an answer. The
 * per-engine filename is already modelled in the engine profile
 * (`configFormat.filename`) — this reads it rather than restating it.
 *
 * Reads the profile through `store.engines` — already a module-top import here
 * — rather than `lib/engines`, so this adds no edge to the
 * `projects → sessions → wrap-pipeline → wrap-steps` require chain.
 *
 * @param {object} [project] - Project record (carries `engineId`)
 * @returns {string} The engine's config filename, or a generic phrase
 */
/**
 * The engine id the delivery receipt should look up a wake profile under.
 *
 * An openclaw project's `engineId` carries its connection id (`openclaw:<id>`),
 * which matches no profile key — the same normalization `_resolveEngineConfigFile`
 * does, for the same reason.
 *
 * @param {object} [project] - Project record (carries `engineId`).
 * @returns {string} Base engine id, or '' when the project declares none.
 */
function _receiptEngineId(project) {
  const id = (project && project.engineId) || '';
  return id.startsWith('openclaw:') ? 'openclaw' : id;
}

function _resolveEngineConfigFile(project) {
  if (!project || !project.engineId) return GENERIC_CONFIG_FILE_PHRASE;
  try {
    // An openclaw project's engineId carries its connection id (`openclaw:<id>`).
    const baseEngineId = project.engineId.startsWith('openclaw:') ? 'openclaw' : project.engineId;
    const profile = store.engines.get(baseEngineId);
    const filename = profile && profile.configFormat && profile.configFormat.filename;
    return filename || GENERIC_CONFIG_FILE_PHRASE;
  } catch (err) {
    log.warn('Failed to resolve engine config filename for prompt interpolation', {
      engineId: project.engineId, error: err.message
    });
    return GENERIC_CONFIG_FILE_PHRASE;
  }
}

/**
 * How deep into the pane's tail the engine's mode line is looked for.
 *
 * The mode line is NOT the last line: a pane with subagents running draws
 * `⏺ main` and one row per agent below it (live captures in
 * `test/medusa-wake.test.js`, #783/#1101), and plan mode dispatching parallel
 * read-only agents is exactly the shape this check exists to catch — so a
 * fixed slice off the bottom loses the marker precisely when it matters and
 * regresses to the five-minute timeout. The line is located by its signature
 * instead (`readOnlyModeMarker.modeLine`), and this only bounds how far up to
 * look.
 *
 * Bounded rather than whole-pane because the words are ordinary English that
 * can appear in the transcript above: the session that built this check had
 * the marker in its own scrollback while discussing it. 15 matches
 * `TMUX_TAIL_LINES` in `lib/medusa-wake.js`, which was measured against these
 * same panes for the same question — how far up the input box and status line
 * reach.
 */
const READ_ONLY_TAIL_LINES = 15;

/**
 * The engine profile's read-only-mode marker, or `null` when the profile
 * declares none.
 *
 * Modelled per-engine rather than hard-coded because "read-only mode" is not a
 * universal concept and its tell is a TUI string that only the engine's own
 * profile can date: Claude Code has plan mode, Codex and Aider have no
 * equivalent footer, and Antigravity's is unmeasured. An engine with no field
 * is a capability TangleClaw does not have, not a session that is fine — the
 * caller records the difference.
 *
 * Read through `store.engines` (already imported here) rather than
 * `lib/engines`, for the same reason `_resolveEngineConfigFile` does: it adds
 * no edge to the `projects → sessions → wrap-pipeline → wrap-steps` chain.
 *
 * @param {object} [project] - Project record (carries `engineId`)
 * @returns {{modeLine: string, marker: string, label: string, exit: string}|null}
 */
function _readOnlyModeMarker(project) {
  if (!project || !project.engineId) return null;
  try {
    // An openclaw project's engineId carries its connection id (`openclaw:<id>`).
    const baseEngineId = project.engineId.startsWith('openclaw:') ? 'openclaw' : project.engineId;
    const profile = store.engines.get(baseEngineId);
    const field = profile && profile.capabilities && profile.capabilities.readOnlyModeMarker;
    if (!field) return null;
    // A field that is present but unusable is a profile defect, not an engine
    // without the capability — the two are indistinguishable to the caller
    // unless this says so, and a silently-degraded check is the failure on this
    // path that would otherwise announce itself nowhere.
    if (typeof field.marker !== 'string' || !field.marker.trim()
        || typeof field.modeLine !== 'string' || !field.modeLine.trim()) {
      log.warn('Engine profile declares a readOnlyModeMarker with no usable marker/modeLine — treating the engine as declaring none', {
        engineId: project.engineId
      });
      return null;
    }
    // A marker equal to its own locator matches the mode line in EVERY mode,
    // so it would refuse every wrap on this engine — the precise failure the
    // two-field design exists to prevent, and one that presents as "wraps stopped
    // working" rather than as a bad profile. Documented in the engine guide;
    // checked here, because a constraint only prose enforces is not enforced.
    if (field.marker.trim() === field.modeLine.trim()) {
      log.warn('Engine profile readOnlyModeMarker.marker is identical to its modeLine — it would match every mode, so the engine is treated as declaring none', {
        engineId: project.engineId, marker: field.marker
      });
      return null;
    }
    return {
      modeLine: field.modeLine,
      marker: field.marker,
      label: (typeof field.label === 'string' && field.label.trim()) ? field.label.trim() : 'read-only mode',
      exit: (typeof field.exit === 'string' && field.exit.trim()) ? field.exit.trim() : ''
    };
  } catch (err) {
    log.warn('Failed to read the engine read-only-mode marker', {
      engineId: project.engineId, error: err.message
    });
    return null;
  }
}

/**
 * Decide, BEFORE the prompt is sent, whether the pane is in a mode that cannot
 * do the step's work (#429).
 *
 * Four outcomes, never two — the same three-state bar this train applies to
 * every other surface: the affirmative fact, the affirmative absence, and an
 * explicit unknown that names why.
 * The pane's mode line is LOCATED by `readOnlyModeMarker.modeLine` (the
 * signature every permission mode draws) and then TESTED for
 * `readOnlyModeMarker.marker`. Locating by position would be wrong: subagent
 * rows render below the mode line, so it is not the last line of the pane.
 *
 *   - `read-only`  — the mode line carries the marker. The caller refuses the step.
 *   - `clear`      — the mode line was found and does not carry it. Measured.
 *   - `unmeasured` — a marker is declared and no mode line could be read.
 *   - `no-marker`  — this engine declares no marker; nothing was measured and
 *                    the step proceeds exactly as it did before this change.
 *
 * @param {object} project - Project record (carries `engineId`)
 * @param {string} tmuxSession - tmux session name to sample
 * @returns {{state: 'read-only'|'clear'|'unmeasured'|'no-marker', reason: string, label?: string, exit?: string}}
 */
function _readOnlyPrecheck(project, tmuxSession) {
  const field = _readOnlyModeMarker(project);
  if (!field) {
    const engineId = (project && project.engineId) || 'unknown';
    return {
      state: 'no-marker',
      reason: `the ${engineId} engine profile declares no read-only-mode marker, so the pane was not checked for one`
    };
  }

  let capture;
  try {
    capture = _internal.capturePane(tmuxSession, { lines: READ_ONLY_TAIL_LINES });
  } catch (err) {
    return {
      state: 'unmeasured',
      reason: `the pane could not be read before sending (${err.message}), so ${field.label} was not ruled out`,
      label: field.label,
      exit: field.exit
    };
  }

  const paneLines = Array.isArray(capture && capture.lines) ? capture.lines : null;
  if (!paneLines || paneLines.length === 0) {
    return {
      state: 'unmeasured',
      reason: `the pane capture came back empty, so ${field.label} was not ruled out`,
      label: field.label,
      exit: field.exit
    };
  }

  // An alternate-screen pane (which is what Claude Code draws in) ignores the
  // line count and returns the whole visible pane, so the tail is bounded HERE
  // rather than trusted from the capture options.
  //
  // The LAST match wins: the real mode line is the lowest one on the pane, so a
  // copy of it quoted in the transcript above can only be read when the real one
  // is not in the window at all — in which case the answer is `unmeasured`
  // anyway, and the residual is a refusal the operator can skip rather than a
  // silent five-minute wait.
  const tail = paneLines.slice(-READ_ONLY_TAIL_LINES);
  let modeLine = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i].includes(field.modeLine)) { modeLine = tail[i]; break; }
  }
  if (modeLine === null) {
    // Not "no read-only mode" — the line that would have said either way was
    // not on the pane. An engine could have changed its footer, or enough
    // subagent rows could be drawn below it to push it past the tail.
    return {
      state: 'unmeasured',
      reason: `no mode line matching "${field.modeLine}" in the last ${READ_ONLY_TAIL_LINES} pane lines, so ${field.label} was not ruled out`,
      label: field.label,
      exit: field.exit
    };
  }
  if (modeLine.includes(field.marker)) {
    return {
      state: 'read-only',
      reason: `the pane's mode line reads "${field.marker}"`,
      label: field.label,
      exit: field.exit
    };
  }
  return {
    state: 'clear',
    reason: `the pane's mode line is present and does not show ${field.label}`,
    label: field.label,
    exit: field.exit
  };
}

/**
 * The operator-facing "how to fix this" line for a refused read-only step.
 *
 * @param {{label: string, exit: string}} precheck - A `read-only` pre-check.
 * @returns {string}
 */
function _readOnlyRemediation(precheck) {
  const how = precheck.exit ? ` (${precheck.exit})` : '';
  return `This session is in ${precheck.label}, which is read-only — the content steps have to edit files, so the prompt would be answered with a plan and never write anything. Exit ${precheck.label} in the session${how}, then click Retry.`;
}

/**
 * Stamp the pre-check outcome onto a step result, so the step record says what
 * was measured about the pane whichever way the step then went.
 *
 * The one stamp site for the tmux path (see `_runTmuxCapture`). `output` may be
 * `null` on several failure returns; it becomes an object carrying only the
 * pre-check, which every consumer reads by field.
 *
 * @param {{ok:boolean, status:string, output:any, blockers:string[]}} result
 * @param {object} precheck - Return of `_readOnlyPrecheck`.
 * @returns {{ok:boolean, status:string, output:object, blockers:string[]}}
 */
function _withPrecheck(result, precheck) {
  const output = (result.output && typeof result.output === 'object') ? result.output : {};
  return { ...result, output: { ...output, readOnlyPrecheck: precheck } };
}

/**
 * Interpolate the supported tokens into a step prompt. Unrecognized braces
 * pass through verbatim so the AI can see the original literal if a
 * pipeline author misnamed a token.
 *
 * Supported:
 *   - `{previousMemoryBlock}` — captured output of the `memory-update` step.
 *   - `{engineConfigFile}`    — the project engine's own config filename, so a
 *                               bundled prompt never names one engine's file.
 *   - `{sessionScope}`        — the commands that show THIS session's work, over
 *                               the same range the wrap's own checks use (#1309).
 *
 * @param {string} promptTemplate - The raw `step.prompt` string
 * @param {Array} previousResults - Prior step results from runner context
 * @param {object} [project] - Project record, for engine-derived tokens
 * @param {object|null} [scope] - The wrap run's scope, for `{sessionScope}`
 * @returns {string} The interpolated prompt ready for tmux
 */
function _interpolatePrompt(promptTemplate, previousResults, project, scope = null) {
  if (!promptTemplate) return '';
  let out = promptTemplate;

  if (out.includes('{sessionScope}')) {
    out = out.replace(/\{sessionScope\}/g, () => _sessionScopeText(project, scope));
  }

  if (out.includes('{previousMemoryBlock}')) {
    const memoryStep = previousResults.find(
      (r) => r.stepId === 'memory-update' && r.status === 'done'
    );
    const memoryText = (memoryStep && memoryStep.output && memoryStep.output.capturedText) || '';
    out = out.replace(/\{previousMemoryBlock\}/g, memoryText);
  }

  if (out.includes('{engineConfigFile}')) {
    out = out.replace(/\{engineConfigFile\}/g, _resolveEngineConfigFile(project));
  }

  return out;
}

/**
 * The `{sessionScope}` sentence: which commands show this session's work.
 *
 * The prompts used to say `HEAD~10..HEAD`, which is neither the session nor the
 * range the wrap's checks judge, so an AI could write an entry for other
 * sessions' commits and still be blocked on its own (#1309, #1450). This hands
 * the AI the range `changelog-coverage` resolves — the launch baseline, or a wrap
 * inside the session, along first parents — and says so plainly when no such
 * boundary exists.
 *
 * @param {object} project - Scoped project record (`path` is the work tree).
 * @param {object|null} scope - The wrap run's scope.
 * @returns {string}
 */
function _sessionScopeText(project, scope) {
  const status = 'Run `git status --short` for uncommitted work.';
  const resolved = project && project.path
    ? gitRange.resolveSessionRange(project.path, scope ? scope.lastWrapSha : null, {
      dots: 'two',
      launchSha: scope && scope.baseline ? scope.baseline.sha : null,
      exec: _internal.rangeExec
    })
    : null;
  if (!resolved) {
    return `No session range could be established for this project, so judge the session from your own work and ${status.charAt(0).toLowerCase()}${status.slice(1)}`;
  }
  const where = resolved.kind === 'branch'
    ? ` This session has no launch record, so this is the whole branch since \`${resolved.baseBranch}\` and may include work from earlier sessions.`
    : '';
  return `This session's commits are \`git log --oneline --first-parent ${resolved.range}\` (a pull of \`main\` into your branch is not this session's work). ${status}${where}`;
}

/**
 * The self-identifying first line prepended to every ai-content prompt sent to
 * a session (#627). Three near-identical wrap prompts arriving unlabeled read
 * as a re-fire rather than pipeline progress — the operator could not tell the
 * two apart, twice, and the rational response to a wrap that looks broken is to
 * stop pressing it (the #571 failure). A header naming the step, and its
 * position where that is knowable, lets two consecutive prompts be read as
 * distinct steps at a glance.
 *
 * Plain text, no markdown: this must render identically in any engine's
 * terminal, and a `## Heading` would be re-styled by a markdown-rendering TUI
 * (the #287 class) — so the marker would vanish exactly where it is needed.
 *
 * `context.aiContentProgress` (`{ordinal, total}`) is set by the runner only
 * for the fixed content steps, whose count is known before the first prompt
 * fires. A prompt sent without it — `index-describe`'s conditional delegation,
 * or a direct unit-test call — gets a numberless header: it still
 * self-identifies, but is not forced into a count it cannot accurately join.
 *
 * @param {object} step - The step spec (`id` names the step)
 * @param {object} [context] - Runner context (may carry `aiContentProgress`)
 * @returns {string} The header line (no trailing newline)
 */
function _wrapStepHeader(step, context) {
  const id = (step && typeof step.id === 'string' && step.id) || 'ai-content';
  const p = context && context.aiContentProgress;
  if (p && Number.isInteger(p.ordinal) && Number.isInteger(p.total)) {
    return `[TangleClaw wrap — step ${p.ordinal} of ${p.total}: ${id}]`;
  }
  return `[TangleClaw wrap — ${id}]`;
}

/**
 * The instruction that closes every tmux wrap prompt: print a completion line
 * carrying this send's nonce.
 *
 * The token and the nonce are deliberately separated by words, so the prompt's
 * own text never satisfies {@link _markerSeen}. A pane that echoes the pasted
 * prompt must not read as a finished step. The line is plain text rather than a
 * `##` heading because a TUI that renders markdown strips the hashes (#287).
 *
 * @param {string} nonce - This send's nonce (hex)
 * @returns {string} The paragraph appended to the prompt
 */
function _completionInstruction(nonce) {
  return `When this step is finished, print one final line containing ${COMPLETION_TOKEN}, then a single space, then \`${nonce}\`. TangleClaw waits for that line before sending anything else, so print it only once the step's work is done.`;
}

/**
 * Whether pane text shows the completion line for this nonce.
 *
 * Tolerates what a TUI or a model does to the line: backticks, bold or quotes
 * around the nonce, and a soft wrap splitting it (newlines are removed before
 * matching). Nothing else may sit between the token and the nonce, which is
 * what keeps the instruction's own wording from matching.
 *
 * @param {string} text - Recent pane text
 * @param {string} nonce - This send's nonce
 * @returns {boolean}
 */
function _markerSeen(text, nonce) {
  if (typeof text !== 'string' || !nonce) return false;
  const joined = text.replace(/\r?\n/g, '');
  return new RegExp(`${COMPLETION_TOKEN}[\\s\`*'"]*${nonce}`).test(joined);
}

/**
 * Append the project's enabled `kind='wrap'` session rules to an ai-content
 * prompt. This is what makes the Wrap-rules field REAL: rules authored in the
 * Project rules UI (and the self-improvement loop's promoted learnings) reach
 * the AI inside every wrap prompt, instead of being stored with no consumer.
 * Rules are advisory prompt content, so a failed read degrades to the bare
 * prompt with a warning — a rules-store hiccup must never block a wrap.
 *
 * @param {string} prompt - The interpolated step prompt
 * @param {object} project - Project record (carries id + name)
 * @returns {string} The prompt, with a `## Project wrap rules` block appended
 *   when the project has enabled wrap rules
 */
function _appendWrapRules(prompt, project) {
  let rules = [];
  try {
    rules = _internal.listWrapRules(project.id);
  } catch (err) {
    log.warn('Failed to read wrap rules — sending prompt without them', { project: project.name, error: err.message });
    return prompt;
  }
  const lines = rules.map((r) => r.content.trim()).filter(Boolean);
  if (lines.length === 0) return prompt;
  return `${prompt}\n\n## Project wrap rules\nApply these project-specific rules while performing this wrap step:\n${lines.map((l) => `- ${l}`).join('\n')}`;
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
 * Parse captured pane output into `## Heading` sections, returning the raw
 * sections map (not a flattened string) so the handler can validate
 * field-by-field.
 *
 * Heading-to-captureField matching uses `_normalizeFieldKey` on both
 * sides — symmetric normalization absorbs natural-English whitespace
 * and punctuation variants without requiring the pipeline author
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
 * Resolve a step's capture contract into the two lists the handler needs.
 *
 * `required` gates: a member missing or empty blocks the step. `all` is what
 * the parser is told to look for — the required fields plus every
 * `optionalCaptureFields` member, deduplicated, required-first so the parse
 * order matches the declaration order a reader expects.
 *
 * The union matters because `_parseFields` matches a heading only against the
 * names it is handed. A field named in neither list is not optional, it is
 * unparseable: the AI can write the block and the handler will not see it.
 *
 * One resolver serves both transports so the tmux and gateway paths cannot
 * drift into different answers about what a step captures — the two validate
 * in separate functions, and the same guard living twice is how they diverge.
 *
 * @param {object} step - Step spec from wrap_pipeline.steps[]
 * @returns {{required:string[], all:string[]}}
 */
function _resolveCaptureContract(step) {
  const required = Array.isArray(step && step.captureFields) ? step.captureFields : [];
  const optional = Array.isArray(step && step.optionalCaptureFields) ? step.optionalCaptureFields : [];
  const all = required.slice();
  for (const field of optional) {
    if (!all.includes(field)) all.push(field);
  }
  return { required, all };
}

/**
 * Does this step have a structured-capture contract at all?
 *
 * The question "does this step capture?" is asked in several places that are
 * not this handler — the runner's webui prompt roster
 * (`lib/wrap-pipeline.js:_planAiContentPrompts`), and the pipeline guards that
 * pin a capturing step against its `captureFile`. Each used to spell it
 * `Array.isArray(step.captureFields) && step.captureFields.length > 0`, which
 * became half the contract the moment a step could declare only optional
 * fields: such a step prompts and captures, but every site spelling the
 * predicate the old way answers "no" for it.
 *
 * Exported so those sites share one definition rather than each carrying a
 * copy that was correct when it was written. A predicate duplicated across
 * modules does not drift all at once — it drifts one call site at a time.
 *
 * @param {object} step - Step spec from wrap_pipeline.steps[]
 * @returns {boolean} True when the step declares any capture field, required or optional
 */
function _hasCaptureContract(step) {
  return _resolveCaptureContract(step).all.length > 0;
}

/**
 * Which optional fields the AI did not supply this run — reported, not merely
 * tolerated.
 *
 * Making an absent judgment section normal removes the only signal that used to
 * distinguish it from a broken one. #1379 was exactly that: four sections empty
 * on every wrap and every engine, with nothing in the server saying so, until an
 * outside user noticed and filed it with six reproducing files. The rendered
 * `_⚠ not captured_` cannot tell "the model skipped the block" from "the wiring
 * broke again", and after this change the first is expected — so the second
 * would look like nothing at all.
 *
 * Logged at the capture site and carried on `output` so the drawer can name the
 * gap instead of only counting what arrived. Only a gap is logged — the
 * everything-captured run returns an empty array and says nothing, because the
 * absence is the event worth a line.
 *
 * @param {object} step - Step spec
 * @param {Record<string,string>} sections - Parsed fields from this run
 * @param {object} project - Project record (for the log line's context)
 * @returns {string[]} Optional field names that came back missing or empty
 */
function _uncapturedOptional(step, sections, project) {
  const { required, all } = _resolveCaptureContract(step);
  const requiredSet = new Set(required);
  const absent = all.filter((f) => !requiredSet.has(f) && (!sections[f] || !sections[f].trim()));
  if (absent.length > 0) {
    log.info('AI did not supply every wanted capture field — those sections render honest-flagged', {
      project: project && project.name,
      stepId: step.id,
      uncaptured: absent,
      captured: all.filter((f) => sections[f] && sections[f].trim())
    });
  }
  return absent;
}

/**
 * The staged capture a content step leaves for the commit and continuity steps,
 * derived from the step's own result output.
 *
 * ONE owner for that shape. The handler stages through it on every successful
 * path, and the wrap runner stages through it when a Retry reuses a previous
 * run's result (`lib/wrap-pipeline.js#_resumedContentResult`) — so a reused
 * capture and a fresh one cannot drift into two shapes that downstream steps
 * read differently.
 *
 * @param {{capturedText: string, parsedFields?: object|null}} output - A done step's output
 * @returns {{capturedText: string, parsedFields: object|null}}
 */
function stagedFromOutput(output) {
  return {
    capturedText: output.capturedText,
    parsedFields: output.parsedFields === undefined ? null : output.parsedFields
  };
}

/**
 * The blocker for a captureFile that could not be read back (#1404).
 *
 * A blocker that names a cause the code did not establish sends operators — and
 * agent sessions, which act on the text — after the wrong problem. Each variant
 * therefore says only what the read actually established, and none names the
 * step prompt as the cause:
 *
 *   - `not-written` (local ENOENT). The capture is armed by deleting the file
 *     before the prompt (#840), so a missing file after the AI finished means
 *     nothing wrote it during this step. The likely reason on a Retry — the AI
 *     believing it already wrote the block — is offered as what to do, never
 *     asserted as a finding.
 *   - `gateway-not-found` (bridge 404). The bridge answers 404 for a missing
 *     FILE and for an unknown PROJECT alike, so this names both rather than
 *     claiming the first.
 *   - `read-failure`. The file may well exist: a permission error, a directory
 *     at that path, or a bridge failure is a different problem with a different
 *     fix, and must not read as the AI's omission.
 *
 * @param {string} captureFile - Project-relative path
 * @param {'not-written'|'gateway-not-found'|'read-failure'} kind - What the read established
 * @param {string} detail - The underlying error code or message
 * @param {string} where - "after the step finished" | "over the gateway"
 * @returns {string}
 */
function _captureReadBlocker(captureFile, kind, detail, where) {
  const retryHint = 'If the AI believes it already wrote the block earlier, ask it to write it again, then Retry';
  if (kind === 'not-written') {
    return `captureFile "${captureFile}" was not written during this step (checked ${where}; `
      + 'the file is cleared before the prompt, so only this step can have produced it). '
      + `${retryHint} (${detail})`;
  }
  if (kind === 'gateway-not-found') {
    return `captureFile "${captureFile}" was not found ${where} — either nothing wrote it during this `
      + 'step (the file is cleared before the prompt), or the bridge does not know this project. '
      + `${retryHint}; if it persists, check the bridge's project name (${detail})`;
  }
  return `captureFile "${captureFile}" could not be read ${where} — this is a read failure, not `
    + `a missing file, so check the path and its permissions (${detail})`;
}

/**
 * Step handler. See module docstring for full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record
 * @param {object|null} context.session - Active Session record. A tmux-mode
 *   session must have `tmuxSession`; a webui-mode session (`sessionMode ===
 *   'webui'`, no tmux) is skipped (#334).
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @param {Array} context.previousResults - Prior step results
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, session, step, staged } = context;
  const options = context.options || {};

  // Operator override (#328): when a content ai-content step opts in via
  // `step.allowOverride === true` and the user ticked "Skip & note" in the
  // wrap drawer (`options.skipAiContent[step.id] === true`), skip the step
  // cleanly and stage a marker so `commit.js:_buildBodyLines` records the
  // skip in the wrap commit body. Mirrors the `test` step's `skipTests`
  // override. Keyed by step.id (a map, not a bare boolean) because more
  // than one ai-content step can be skipped across successive retries.
  if (step.allowOverride === true
      && options.skipAiContent
      && options.skipAiContent[step.id] === true) {
    log.info('ai-content step skipped via user override', { project: project.name, stepId: step.id });
    staged[step.id] = { aiContentSkipped: true, stepId: step.id };
    return {
      ok: true,
      status: 'skipped',
      output: { override: true, reason: `user opted to skip ${step.id} (recorded in commit body)` },
      blockers: []
    };
  }

  // A step whose prompt could change nothing this wrap sends none. Checked
  // before the session and transport branches so the tmux and gateway paths
  // can't answer differently, and asked of the same predicate the runner's
  // prompt roster uses.
  const precondition = preconditionVerdict(step, project, options);
  if (!precondition.open) {
    log.info('ai-content step not needed this wrap', { project: project && project.name, stepId: step.id, reason: precondition.reason });
    return {
      ok: true,
      status: 'skipped',
      output: { precondition: step.precondition, reason: precondition.reason },
      blockers: []
    };
  }

  if (!session) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: ['ai-content step requires an active session']
    };
  }

  // #334 / CC-7 Slice B1 — WebUI/OpenClaw sessions have no tmux pane
  // (`sessionMode === 'webui'`, `tmuxSession === null`), so capture happens
  // over the ClawBridge gateway instead of the pane. `_runGatewayCapture`
  // sends the prompt, waits for the AI turn, and reads the structured block
  // back from the captureFile over the bridge (ClawBridge #18). When the
  // gateway can't capture a step (no captureFile, or no bridge sidecar) it
  // returns an honest `skipped` (never a fabricated capture) so Slice A
  // renders the judgment sections flagged-empty with a reason.
  if (session.sessionMode === 'webui') {
    return _runGatewayCapture(context);
  }

  if (!session.tmuxSession) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: ['ai-content step requires an active tmux session']
    };
  }

  // #139 — empty prompt = pipeline author's intentional skip marker, not a
  // structural failure. `status: 'blocked'` would surface as a blocked row in
  // every prawduct wrap drawer, because prawduct ships three intentionally-empty
  // `ai-content` placeholder steps that depend on future prompt-content work.
  // `status: 'skipped'` matches the intent: the step is declared but has no
  // work to do today.
  if (typeof step.prompt !== 'string' || step.prompt.trim() === '') {
    return {
      ok: true,
      status: 'skipped',
      output: null,
      blockers: []
    };
  }

  // #429 — plan mode is read-only, so a content step's prompt (edit the
  // changelog, write MEMORY.md, produce the capture file) cannot be obeyed:
  // Claude answers with a plan and waits on an approval that never comes. The
  // step used to discover this by waiting out MAX_WAIT_MS and reporting
  // `blocked` — five minutes to learn a fact the pane states on its footer
  // before a byte is sent. Sample first, and say the actionable thing.
  const precheck = _readOnlyPrecheck(project, session.tmuxSession);
  if (precheck.state === 'read-only') {
    log.warn('ai-content step refused: the session is in a read-only mode', {
      project: project.name, stepId: step.id, engineId: project.engineId, mode: precheck.label
    });
    return {
      ok: false,
      status: 'needs-operator',
      output: { remediation: _readOnlyRemediation(precheck), readOnlyPrecheck: precheck },
      blockers: [`Exit ${precheck.label} to wrap — content steps need write access`]
    };
  }
  if (precheck.state === 'unmeasured') {
    // The profile declares a marker and the pane could not be read. Proceeding
    // is the right call — this check exists to save five minutes, not to gate
    // the wrap on tmux being cooperative — but an unmeasured pane must not
    // read like a measured-clear one, here or on the step record.
    log.warn('Could not sample the pane for a read-only mode before sending the wrap prompt', {
      project: project.name, stepId: step.id, reason: precheck.reason
    });
  }

  return _withPrecheck(await _runTmuxCapture(context), precheck);
}

/**
 * Stamp the delivery outcome onto whatever the capture returns.
 *
 * ONE stamp site, deliberately. The inner function has several exits and will
 * grow more; enumerating them is the exact fragility that lost this value the
 * first time it was wired (`wrap-pipeline.js` built its row from an explicit
 * field list and dropped it). A return added inside is covered here without
 * anyone remembering to stamp it.
 *
 * The field is absent, never null, when no receipt was taken — the early exits
 * before the send genuinely measured nothing, and `undefined` must not read as
 * a measured `unknown`.
 *
 * @param {object} context - Step context.
 * @returns {Promise<object>} The step result, carrying `deliveryOutcome`
 *   (`'not-accepted'|'unknown'` — the receipt is negative-only and never
 *   reports success) and `deliveryReason` (the sentence explaining it) when
 *   delivery was measured, and neither when it was not.
 */
async function _runTmuxCapture(context) {
  const carry = {};
  const result = await _runTmuxCaptureInner(context, carry);
  if (!carry.receipt) return result;
  // The reason travels with the outcome. One sentence cannot honestly stand for
  // four different causes — "the pane was never read" (an engine declaring no
  // vocabulary) and "the pane is at rest with an empty composer" are both
  // `unknown`, and a drawer given only the word would assert one of them for
  // all of them.
  return { ...result, deliveryOutcome: carry.receipt.outcome, deliveryReason: carry.receipt.reason };
}

/**
 * The send → poll → capture → parse flow against a tmux pane. Split out of
 * `run` so the read-only pre-check has exactly ONE place to stamp its outcome
 * onto the step record (`_withPrecheck`): a surface reporting a state it did
 * not measure is the defect class this change belongs to, and a dozen
 * hand-stamped `return` sites is how half of them end up unstamped.
 *
 * Reached only through `run`, which has already established that there is a
 * session, that it is not a webui one, that it has a tmux pane, and that the
 * step carries a prompt.
 *
 * Wrapped by `_runTmuxCapture`, which is the exported name and the ONE place the
 * delivery receipt is stamped — same reasoning as `_withPrecheck` above, one
 * layer down. This function has several exits and will grow more; none of them
 * stamps anything.
 *
 * @param {object} context - Pipeline runner context (see `run`)
 * @param {{receipt?: object}} carry - Out-parameter the wrapper reads the
 *   delivery receipt back from. An out-parameter rather than a return field
 *   because every exit below returns a step result whose shape is the runner's
 *   contract, and widening all of them is what the single stamp site avoids.
 * @returns {Promise<{ok:boolean, status:string, output:any, blockers:string[]}>}
 */
async function _runTmuxCaptureInner(context, carry) {
  const { project, session, step, previousResults, staged } = context;
  const tmuxSession = session.tmuxSession;

  const body = _appendWrapRules(_interpolatePrompt(step.prompt, previousResults || [], project, context.scope), project);
  // A fresh nonce per send: a Retry's prompt must not be finished by the marker
  // an earlier attempt left in the scrollback.
  const nonce = _internal.newNonce();
  // #627 — prefix a self-identifying header so consecutive pane prompts read as
  // distinct pipeline steps, not a re-fire. First line the operator sees.
  const prompt = `${_wrapStepHeader(step, context)}\n\n${body}\n\n${_completionInstruction(nonce)}`;

  // D6 (#571 items 4-5, #638) — fail-closed verification for a content step
  // whose job is a FILE EDIT. `changelog-update`/`learnings-capture` carry no
  // `captureFields`, so the only success gate below is the ≥20-char no-op
  // check — the AI can answer "done" without touching the file and the step
  // still reports `done`. A `verifyChanged: string[]` step field names the
  // project-relative paths the step must have modified; snapshot them BEFORE
  // the AI acts so the post-completion gate can prove at least one actually changed.
  // Tmux path only: the gateway path can't read the local tree and already
  // returns an honest `skipped` for a file-edit step. This is the file-edit
  // analog of `memory-update`'s existing captureFile verification.
  const verifyChanged = Array.isArray(step.verifyChanged)
    ? step.verifyChanged.filter((p) => typeof p === 'string' && p.trim())
    : [];
  const beforeSnapshot = verifyChanged.length > 0
    ? _snapshotPaths(project.path, verifyChanged)
    : null;

  // Arm the capture: remove any `captureFile` BEFORE the AI is asked to write it,
  // so the file's existence afterwards is itself the proof this run produced it
  // (#840). `_runGatewayCapture` arms the same way with the primitive it has — a
  // consuming read — because the reasoning is about the FILE, not about tmux.
  //
  // A leftover from another run is syntactically perfect, so no validation can
  // catch it, and its `## Summary` becomes the wrap commit subject. Provenance is
  // established mechanically rather than by asking the AI to stamp a run id:
  // `wrap-direction.md` commitment 2 requires the mechanical layer to produce
  // identical results on every engine, and a stamp only some models write
  // reliably is exactly the capability dependency it forbids.
  //
  // A delete that does not take is a HARD refusal, not a skip — commitment 3's
  // bright-line, since the wrap would otherwise report success while attributing
  // another session's work to this one.
  // The union, not just the required list: a step whose contract is entirely
  // optional still writes a captureFile, so a stale one still has to be cleared
  // before the prompt goes out or this run inherits the last one's content.
  const armCaptureFields = _resolveCaptureContract(step).all;
  if (armCaptureFields.length > 0 && step.captureFile
      && _internal.captureFileExists(project.path, step.captureFile)) {
    // Only reached when a file is genuinely there before the AI has written
    // anything — which means it belongs to no current run.
    try {
      _internal.removeCaptureFile(project.path, step.captureFile);
    } catch (err) {
      log.warn('Could not clear a stale captureFile before arming the capture', {
        project: project.name, stepId: step.id, captureFile: step.captureFile, error: err.message
      });
    }
    if (_internal.captureFileExists(project.path, step.captureFile)) {
      return {
        ok: false,
        status: 'blocked',
        output: null,
        blockers: [`captureFile "${step.captureFile}" already exists and could not be removed — `
          + 'it belongs to no current run, and a leftover from a previous wrap parses as valid '
          + "content, so this session's commit would describe another session's work. "
          + 'Delete the file and retry the wrap.']
      };
    }
    log.warn('Cleared a captureFile left behind by a previous run', {
      project: project.name, stepId: step.id, captureFile: step.captureFile
    });
  }


  try {
    // The engine locates the composer, so a draft cleared before the paste is
    // recorded rather than lost unlogged (#1507).
    _internal.sendKeys(tmuxSession, prompt, { enter: true, engineId: governance.sessionEngineId(session, project) });
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: [`Failed to send prompt to tmux: ${err.message}`]
    };
  }

  // #1685 — `sendKeys` returning means tmux accepted characters into a pty, NOT
  // that the engine turned them into a task. Logging `prompt sent` on that basis
  // made an unsubmitted prompt indistinguishable from a slow model, so the run
  // spent MAX_WAIT_MS before reporting a generic non-completion. Ask the pane
  // instead, and say what it answered.
  const receipt = await _internal.verifySubmission(
    tmuxSession, _receiptEngineId(project), nonce
  );
  carry.receipt = receipt;
  deliveryReceipt.logReceipt(
    { project: project.name, stepId: step.id, promptLength: prompt.length }, receipt
  );

  // Positive evidence the prompt never became a task. Fail here rather than
  // wait out MAX_WAIT_MS for work that was never queued. NOT a re-send: #1685
  // requires duplicate submission be prevented, and re-pasting over a composer
  // on a misread would submit the same task twice.
  if (receipt.outcome === 'not-accepted') {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: [`The wrap prompt for "${step.id}" never became a task — ${receipt.reason}. `
        + 'This is a delivery failure, not the model taking too long: nothing was queued, so '
        + 'waiting would not have helped. Clear the pane\'s composer and retry the wrap.']
    };
  }

  // Capture the deadline BEFORE the initial settle so the total wait
  // (settle + polling) is bounded by MAX_WAIT_MS, matching the
  // module-level docstring. Capturing after the sleep would let the
  // effective cap drift to MAX_WAIT_MS + INITIAL_SETTLE_MS — small but
  // misleading enough to surface in the wrap-blocked error message.
  // Clock reads go through `_internal.now` so the timeout branch is
  // deterministically testable (tests stub `now` to fast-forward past
  // MAX_WAIT_MS without a 5-minute wall-clock wait).
  const startedAt = _internal.now();

  // #672 — a completion signal a busy pane can't starve into a timeout. The quiet
  // fallback is reset by any pane output — including the operator interacting
  // with the session mid-wrap, which it cannot distinguish from the AI still
  // working. So also watch the files this step is expected to PRODUCE (its
  // `verifyChanged` edits plus any `captureFile`): once one has changed from its
  // pre-prompt content AND nothing has changed for STABILITY_MS, the AI has done
  // its work and settled, regardless of what the pane shows. Baseline is captured
  // BEFORE the settle sleep so a change during that window still registers.
  const settleWatch = _watchedOutputPaths(step);
  const settleBaseline = settleWatch.length > 0 ? _snapshotPaths(project.path, settleWatch) : {};
  let settleLast = settleBaseline;
  let settleLastChangeAt = startedAt;
  let settleEverChanged = false;
  let settledAt = null;

  await _internal.sleep(INITIAL_SETTLE_MS);

  let completedVia = null; // 'marker' | 'files' | 'quiet'
  let quietLast = null;
  let quietSince = startedAt;
  while (_internal.now() - startedAt < MAX_WAIT_MS) {
    let tail;
    try {
      tail = _internal.readPaneTail(tmuxSession);
    } catch (err) {
      // The pane read throws when the tmux session dies mid-poll.
      return {
        ok: false,
        status: 'blocked',
        output: null,
        blockers: [`Could not read the terminal while waiting for ${step.id}: ${err.message}`]
      };
    }
    if (_markerSeen(tail, nonce)) {
      completedVia = 'marker';
      break;
    }
    // File-settle check. Re-read the watched paths and compare against the last
    // observation; any difference restarts the stability window. Completion
    // requires a change from the PRE-PROMPT baseline (the AI actually produced
    // output) that has then held still for STABILITY_MS.
    if (settleWatch.length > 0) {
      const current = _snapshotPaths(project.path, settleWatch);
      if (settleWatch.some((p) => current[p] !== settleLast[p])) {
        settleLast = current;
        settleLastChangeAt = _internal.now();
      }
      if (settleWatch.some((p) => current[p] !== settleBaseline[p])) {
        settleEverChanged = true;
      }
      if (settleEverChanged && _internal.now() - settleLastChangeAt >= STABILITY_MS) {
        // Settled. Give the marker its grace window before the file ends the wait.
        if (settledAt === null || settledAt < settleLastChangeAt) settledAt = _internal.now();
        if (_internal.now() - settledAt >= MARKER_GRACE_MS) {
          completedVia = 'files';
          break;
        }
      }
    }
    // Quiet fallback for an engine that never prints the marker. Any change to
    // the recent pane restarts the window, so a moving spinner or stream keeps
    // the step waiting.
    if (tail !== quietLast) {
      quietLast = tail;
      quietSince = _internal.now();
    } else if (_internal.now() - quietSince >= QUIET_FALLBACK_MS) {
      completedVia = 'quiet';
      break;
    }
    await _internal.sleep(POLL_INTERVAL_MS);
  }

  if (!completedVia) {
    // #328: describe the STEP outcome, not the pipeline's. Whether the wrap
    // halts is the runner's call (driven by `step.blocker`), so the handler
    // must not assert "wrap pipeline blocked" — that was false for the
    // historically non-blocker content steps and contradicted the commit
    // that landed anyway. The remediation tells the operator the AI may
    // still be working (wait + Retry) or is wedged (use "Skip & note").
    const waited = Math.round(MAX_WAIT_MS / 1000);
    const quiet = Math.round(QUIET_FALLBACK_MS / 1000);
    return {
      ok: false,
      status: 'blocked',
      output: {
        remediation: `The AI did not finish within ${waited}s: it never printed its completion line, and the terminal never stayed unchanged for ${quiet}s. If it is still working, wait for it to finish and click Retry. If it is wedged, use "Skip & note" to wrap without this step (the skip is recorded in the commit body).`
      },
      blockers: [`${step.id}: AI did not finish within ${waited}s (no completion line, and the terminal never went quiet)`]
    };
  }

  log.info('ai-content step finished waiting', {
    project: project.name, stepId: step.id, completedVia, waitedMs: _internal.now() - startedAt
  });
  return _withCompletion(_captureAndValidate(context, { beforeSnapshot, completedVia }), completedVia);
}

/**
 * Stamp how a tmux step finished onto its result, at one site, so no return path
 * reports a step without saying what ended its wait.
 *
 * A `quiet` finish also carries a note: the step may have been judged finished
 * while the AI was still thinking, and the operator reading the row should know
 * the evidence was a silent terminal rather than the AI saying so.
 *
 * @param {{ok:boolean, status:string, output:any, blockers:string[]}} result - The step result
 * @param {'marker'|'files'|'quiet'} completedVia - The signal that ended the wait
 * @returns {{ok:boolean, status:string, output:any, blockers:string[]}}
 */
function _withCompletion(result, completedVia) {
  const stamp = { completedVia };
  if (completedVia === 'quiet') {
    stamp.completionNote = `no completion marker seen — finished after ${Math.round(QUIET_FALLBACK_MS / 1000)}s of an unchanged terminal`;
  }
  const output = result.output && typeof result.output === 'object' ? { ...result.output, ...stamp } : stamp;
  return { ...result, output };
}

/**
 * The capture → parse → verify half of the tmux flow, run once the wait has ended.
 *
 * @param {object} context - Pipeline runner context (see `run`)
 * @param {{beforeSnapshot: (Object<string, string|null>|null), completedVia: string}} wait -
 *   The pre-prompt snapshot of the step's `verifyChanged` paths and the signal that ended the wait
 * @returns {{ok:boolean, status:string, output:any, blockers:string[]}}
 */
function _captureAndValidate(context, wait) {
  const { project, session, step, staged } = context;
  const tmuxSession = session.tmuxSession;
  const { beforeSnapshot, completedVia } = wait;

  let capture;
  try {
    capture = _internal.capturePane(tmuxSession, { full: true });
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: [`Failed to capture pane after the step finished: ${err.message}`]
    };
  }

  const capturedText = (capture.lines || []).join('\n');
  const trimmed = capturedText.trim();

  const { required: requiredFields, all: captureFields } = _resolveCaptureContract(step);

  // #287: `capture-pane -p` returns the TUI-RENDERED pane (escapes
  // stripped). A TUI that renders markdown — Claude Code is the case that
  // surfaced this, but it is a property of rich-rendering TUIs generally, not
  // of one engine — displays `## Heading` as styled text without the literal
  // `##`, so parsing structured `## Heading` blocks out of the pane never
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
        blockers: [_captureReadBlocker(step.captureFile,
          err.code === 'ENOENT' ? 'not-written' : 'read-failure', err.code || err.message, 'after the step finished')]
      };
    }
    _internal.removeCaptureFile(project.path, step.captureFile);
  }

  if (captureFields.length > 0) {
    const sections = _parseFields(parseSource, captureFields);
    // Only the REQUIRED list gates. An absent optional field leaves its key out
    // of `sections`, and the continuity renderer flags the section it feeds.
    const missing = requiredFields.filter((f) => !sections[f] || !sections[f].trim());
    if (missing.length > 0) {
      return {
        ok: false,
        status: 'blocked',
        output: { capturedText, parsedFields: sections },
        blockers: missing.map((f) => `Required captureField "${f}" missing or empty in AI response`)
      };
    }
    // D6 — even a step that produced valid captureFields must have touched
    // its declared verifyChanged paths (a step can legitimately declare both).
    const verifyBlock = _verifyChangedGate(project.path, step, beforeSnapshot, context.scope, context.options);
    if (verifyBlock) {
      return {
        ok: false,
        status: 'blocked',
        output: { capturedText, parsedFields: sections, remediation: verifyBlock.remediation },
        blockers: [verifyBlock.blocker]
      };
    }
    // Stage the parsed fields for the commit step (Chunk 9) to consume.
    // `capturedAt` is recorded on the result so a Retry measures how old this
    // capture is from when it happened, not from when the run later halted.
    const uncapturedOptional = _uncapturedOptional(step, sections, project);
    const output = { capturedText, parsedFields: sections, uncapturedOptional, capturedAt: _internal.now() };
    staged[step.id] = stagedFromOutput(output);
    return {
      ok: true,
      status: 'done',
      output,
      blockers: []
    };
  }

  // No captureFields → minimal validation: just check the AI said
  // *something*. Below this threshold the AI either no-op'd or
  // the quiet fallback fired before a response was on the pane.
  // Skipped when completion came from the file-settle signal (#672): that path
  // already has proof the AI produced its work product (a watched file changed
  // and settled), which is stronger than the pane length, and the pane may hold
  // unrelated operator chatter rather than the AI's response.
  if (completedVia !== 'files' && trimmed.length < MIN_RESPONSE_CHARS) {
    return {
      ok: false,
      status: 'blocked',
      output: { capturedText },
      blockers: [`AI response too short (${trimmed.length} chars; expected ≥${MIN_RESPONSE_CHARS})`]
    };
  }

  // D6 — the ≥20-char check above only proves the AI SAID something; for a
  // file-edit step it must also have CHANGED the file. This is the gate that
  // catches "reported done, edited nothing".
  const verifyBlock = _verifyChangedGate(project.path, step, beforeSnapshot, context.scope, context.options);
  if (verifyBlock) {
    return {
      ok: false,
      status: 'blocked',
      output: { capturedText, remediation: verifyBlock.remediation },
      blockers: [verifyBlock.blocker]
    };
  }

  const output = { capturedText, parsedFields: null, capturedAt: _internal.now() };
  staged[step.id] = stagedFromOutput(output);
  return {
    ok: true,
    status: 'done',
    output,
    blockers: []
  };
}

/**
 * WebUI/gateway capture path (CC-7 Slice B1) — the gateway analog of the tmux
 * send→poll→capture→parse flow, over the ClawBridge bridge:
 *   1. `clawbridge.send` pushes the wrap prompt to the remote session.
 *   2. `clawbridge.getStatus` is polled until the AI's turn completes
 *      (`inputReady` true again), bounded by MAX_WAIT_MS.
 *   3. `clawbridge.getFile` reads the structured block from the step's
 *      `captureFile` as raw markdown (`consume:true`), parsed by `_parseFields`.
 *
 * Only the structured-capture path (a step with BOTH `captureFields` and a
 * `captureFile`) goes over the gateway: the Slice B1 spike proved the PTY
 * output stream mangles `##` and collapses line structure, so unstructured
 * pane text can't be reconstructed. Steps without a captureFile — and sessions
 * with no ClawBridge sidecar — return an honest `skipped` so Slice A flags the
 * judgment empty with a reason (never a fabricated capture). memory-update-style
 * steps that write their own files are likewise not handled here: the AI writes
 * to the REMOTE working tree while TC's `commit` step reconciles the LOCAL one —
 * a pre-existing webui reality out of B1 scope.
 *
 * @param {object} context - Pipeline runner context (see `run`)
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function _runGatewayCapture(context) {
  const { project, session, step, previousResults, staged } = context;

  // Empty prompt = pipeline author's intentional skip marker (parity with
  // the tmux path's identical guard).
  if (typeof step.prompt !== 'string' || step.prompt.trim() === '') {
    return { ok: true, status: 'skipped', output: null, blockers: [] };
  }

  const { required: requiredFields, all: captureFields } = _resolveCaptureContract(step);

  // No structured-capture contract → nothing the gateway can reliably bring
  // back (B1 spike). Honest skip; Slice A renders the section flagged-empty.
  if (captureFields.length === 0 || !step.captureFile) {
    return {
      ok: true,
      status: 'skipped',
      output: { webui: true, reason: 'webui session: ai-content without a captureFile cannot be captured over the gateway' },
      blockers: []
    };
  }

  // Resolve the ClawBridge sidecar for this webui session. No sidecar (or a
  // non-openclaw engine) → no gateway channel → honest skip.
  const bridge = _internal.getBridgeContext(session, project.name);
  if (!bridge) {
    return {
      ok: true,
      status: 'skipped',
      output: { webui: true, reason: 'webui session: no ClawBridge sidecar (bridgePort) configured — ai-content capture is N/A' },
      blockers: []
    };
  }

  // #627 — same self-identifying header as the tmux path; the gateway prompt is
  // one of the same content steps, just delivered over the bridge.
  const prompt = `${_wrapStepHeader(step, context)}\n\n${_appendWrapRules(_interpolatePrompt(step.prompt, previousResults || [], project, context.scope), project)}`;

  // 0. Arm the capture, the same discipline as the tmux path with the primitive
  // this one has (#840).
  //
  // The tmux side unlinks the captureFile before the prompt so its later
  // existence proves this run wrote it. That reasoning is about the FILE, not
  // about tmux, so it holds here identically — and the file lives on a remote
  // filesystem a local unlink cannot reach, which is exactly why the tmux-side
  // guard alone would have left half the family uncovered. The bridge's only
  // primitive is a consuming read, so arming IS a consuming read: whatever comes
  // back belongs to no current run and is discarded rather than parsed.
  //
  // A read that cannot answer is a refusal, matching the tmux side, because a
  // capture step proceeding on a payload it cannot attribute is the defect this
  // guard exists to stop.
  if (captureFields.length > 0 && step.captureFile) {
    // Branch on the ANSWER, not on a throw. `clawbridge.getFile` resolves for
    // every outcome — it returns `{ok:false, status}` for any non-2xx and
    // `status: 0` for a network failure or timeout — so a try/catch here would
    // refuse nothing and let an unarmed run proceed, which is #840's exact end
    // state on this runner. The step's own step-3 read already branches this way.
    let stale;
    try {
      stale = await _internal.bridgeClearCaptureFile({
        localPort: bridge.localPort, token: bridge.token, project: bridge.project,
        path: step.captureFile, consume: true
      });
    } catch (err) {
      // Defensive only: the current client cannot reach here, but a future one
      // that throws must not be treated as a successful clear.
      stale = { ok: false, status: 0, error: err.message, consumed: false };
    }

    // A 404 is the armed case, not a failure: there was nothing to clear. It
    // mirrors the tmux path, which refuses only when the file EXISTS and the
    // unlink does not take.
    const nothingToClear = stale && !stale.ok && stale.status === 404;
    // `ok` without `consumed` means the bridge answered but the file is still
    // there — read, not removed — which is exactly as unarmed as a failed read.
    const cleared = stale && stale.ok && stale.consumed;
    if (!nothingToClear && !cleared) {
      const why = stale && stale.error ? stale.error
        : `the gateway answered ${stale && stale.ok ? 'without consuming the file' : `status ${stale && stale.status}`}`;
      return {
        ok: false,
        status: 'blocked',
        output: null,
        blockers: [`Could not clear a possible stale captureFile "${step.captureFile}" over the gateway `
          + `before starting the step (${why}) — a leftover from a previous wrap parses as valid `
          + "content, so this session's commit could describe another session's work."]
      };
    }
    if (cleared && typeof stale.content === 'string' && stale.content.trim()) {
      log.warn('Cleared a captureFile left behind by a previous run', {
        project: project.name, stepId: step.id, captureFile: step.captureFile, via: 'gateway'
      });
    }
  }

  // 1. Send the wrap prompt over the bridge. `clawbridge.send` resolves
  // (never rejects), but guard the try in case a future client throws.
  let sent;
  try {
    sent = await _internal.bridgeSend({ localPort: bridge.localPort, token: bridge.token, project: bridge.project, message: prompt });
  } catch (err) {
    return { ok: false, status: 'blocked', output: null, blockers: [`Failed to send prompt to ClawBridge: ${err.message}`] };
  }
  if (!sent.ok) {
    return { ok: false, status: 'blocked', output: null, blockers: [`Failed to send prompt to ClawBridge: ${sent.error}`] };
  }

  log.info('ai-content prompt sent (gateway)', {
    project: project.name,
    stepId: step.id,
    promptLength: prompt.length
  });

  // 2. Poll status until the AI's turn completes. Capture the deadline BEFORE
  // the settle so total wait is bounded by MAX_WAIT_MS (matches the tmux path).
  // `inputReady` flips true when the session is ready for the next turn (its
  // wrap turn finished); `waiting_for_permission` would hang forever, so it is
  // surfaced as an honest blocked step rather than silently timing out.
  const startedAt = _internal.now();
  await _internal.sleep(INITIAL_SETTLE_MS);

  let ready = false;
  while (_internal.now() - startedAt < MAX_WAIT_MS) {
    let status;
    try {
      status = await _internal.bridgeGetStatus({ localPort: bridge.localPort, token: bridge.token, project: bridge.project });
    } catch (err) {
      return { ok: false, status: 'blocked', output: null, blockers: [`ClawBridge status check failed: ${err.message}`] };
    }
    if (!status.ok) {
      return { ok: false, status: 'blocked', output: null, blockers: [`ClawBridge status check failed: ${status.error}`] };
    }
    if (status.state === 'waiting_for_permission') {
      return {
        ok: false,
        status: 'blocked',
        output: { remediation: 'The ClawBridge session is waiting on a permission prompt. Approve it in the OpenClaw chat UI, then click Retry.' },
        blockers: [`${step.id}: ClawBridge session is waiting on a permission prompt`]
      };
    }
    // A dead/terminal remote session never becomes input-ready — fast-fail
    // honestly instead of hanging the full MAX_WAIT_MS (the tmux path
    // fast-fails when its pane read throws on a vanished pane). `getStatus`
    // reports a gone session as 200 + `active:false` (not a network error),
    // so `status.ok` stays true; `ended`/`failed`/`timed_out` are the bridge's
    // terminal states. (`completed` is NOT terminal here — it can accompany a
    // finished turn that is also `inputReady`, which the next check catches.)
    if (status.active === false || GATEWAY_TERMINAL_STATES.includes(status.state)) {
      const why = status.active === false ? 'session is no longer active' : `session ${status.state}`;
      return {
        ok: false,
        status: 'blocked',
        output: null,
        blockers: [`${step.id}: ClawBridge ${why} before the wrap turn completed — the remote session died mid-wrap; re-launch it and Retry`]
      };
    }
    if (status.inputReady) { ready = true; break; }
    await _internal.sleep(POLL_INTERVAL_MS);
  }

  if (!ready) {
    const waited = Math.round(MAX_WAIT_MS / 1000);
    return {
      ok: false,
      status: 'blocked',
      output: {
        remediation: `The AI did not finish within ${waited}s (ClawBridge never reported the session ready again). If it is still working, wait and click Retry. If it is wedged, use "Skip & note" to wrap without this step.`
      },
      blockers: [`${step.id}: AI did not return within ${waited}s (gateway session never became input-ready)`]
    };
  }

  // 3. Read the captureFile back over the bridge — consume-once, mirroring the
  // tmux path's `removeCaptureFile` so a later wrap can't reuse a stale block.
  let fileRes;
  try {
    fileRes = await _internal.bridgeGetFile({ localPort: bridge.localPort, token: bridge.token, project: bridge.project, path: step.captureFile, consume: true });
  } catch (err) {
    return { ok: false, status: 'blocked', output: null, blockers: [`Failed to read captureFile over ClawBridge: ${err.message}`] };
  }
  if (!fileRes.ok) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: [_captureReadBlocker(step.captureFile,
        fileRes.status === 404 ? 'gateway-not-found' : 'read-failure', fileRes.error, 'over the gateway')]
    };
  }

  // 4. Parse with the SAME parser the tmux path uses — the captureFile is raw
  // markdown, so `## Heading` blocks match (the whole point of #18).
  const parseSource = fileRes.content || '';
  const sections = _parseFields(parseSource, captureFields);
  // Required-only gating, symmetric with the tmux path above — the two
  // transports must agree on which fields can halt a wrap.
  const missing = requiredFields.filter((f) => !sections[f] || !sections[f].trim());
  if (missing.length > 0) {
    return {
      ok: false,
      status: 'blocked',
      output: { capturedText: parseSource, parsedFields: sections },
      blockers: missing.map((f) => `Required captureField "${f}" missing or empty in AI response`)
    };
  }
  const uncapturedOptional = _uncapturedOptional(step, sections, project);
  const output = { capturedText: parseSource, parsedFields: sections, uncapturedOptional, capturedAt: _internal.now() };
  staged[step.id] = stagedFromOutput(output);
  return {
    ok: true,
    status: 'done',
    output,
    blockers: []
  };
}

/**
 * Read the recent pane for the completion poll: the last `PANE_TAIL_LINES`
 * lines as one string. Goes through `_internal.capturePane`, which throws when
 * the tmux session is gone.
 * @param {string} tmuxSession - tmux session name
 * @returns {string} Recent pane text
 */
function defaultReadPaneTail(tmuxSession) {
  const capture = _internal.capturePane(tmuxSession, { lines: PANE_TAIL_LINES });
  return (capture && Array.isArray(capture.lines) ? capture.lines : []).join('\n');
}

/**
 * A fresh completion nonce for one prompt send.
 * @returns {string} 8 hex characters
 */
function defaultNewNonce() {
  return crypto.randomBytes(4).toString('hex');
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
 * Whether a step's `captureFile` is present on disk.
 *
 * Read through `_internal` for the same reason the read and remove are: the arm
 * check below must be stubbable, or the refusal it guards can only be tested by
 * making a real file undeletable.
 * @param {string} projectPath - Absolute path to the project root.
 * @param {string} relPath - Project-relative path to the capture file.
 * @returns {boolean}
 */
function defaultCaptureFileExists(projectPath, relPath) {
  return fs.existsSync(path.join(projectPath, relPath));
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

/**
 * Read a project-relative path for D6 change-detection. Returns the file's
 * content, or `null` for a missing/unreadable file — a distinct sentinel from
 * an empty file (`''`), so creating an empty file registers as a change. Never
 * throws: an unreadable path is treated as absent, which makes the gate
 * fail-closed (a path unreadable both before and after reads as "unchanged" →
 * the step blocks rather than passing on a state it couldn't confirm).
 * Overridable via `_internal` for tests.
 * @param {string} projectPath - Absolute project root
 * @param {string} relPath - Project-relative path
 * @returns {string|null} File content, or null if missing/unreadable
 */
function defaultReadForVerify(projectPath, relPath) {
  try {
    return fs.readFileSync(path.join(projectPath, relPath), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Snapshot the content of each declared path into a `{relPath: content|null}`
 * map, used by `_verifyChangedGate` to detect a post-AI change. Reads go
 * through `_internal.readForVerify` so tests can stub the filesystem.
 * @param {string} projectPath - Absolute project root
 * @param {string[]} paths - Project-relative paths
 * @returns {Object<string, string|null>} Path → content-or-null snapshot
 */
function _snapshotPaths(projectPath, paths) {
  const snap = {};
  for (const p of paths) snap[p] = _internal.readForVerify(projectPath, p);
  return snap;
}

/**
 * The project-relative files a step is expected to PRODUCE — the paths the
 * #672 file-settle completion signal watches. A file-edit step declares
 * `verifyChanged`; a structured-capture step (e.g. `memory-update`) also writes
 * a `captureFile`. Both are the step's own work product, so a change to either
 * that then holds still is evidence the AI finished — independent of pane quiet.
 * Deduped; a step with neither yields `[]` and relies on the marker and quiet signals only.
 * @param {object} step - The wrap step spec
 * @returns {string[]} Project-relative output paths
 */
function _watchedOutputPaths(step) {
  const paths = Array.isArray(step.verifyChanged)
    ? step.verifyChanged.filter((p) => typeof p === 'string' && p.trim())
    : [];
  if (typeof step.captureFile === 'string' && step.captureFile.trim()) {
    paths.push(step.captureFile);
  }
  return [...new Set(paths)];
}

/**
 * D6 gate — after a file-edit content step, confirm the step actually did its job.
 *
 * The step is satisfied by EITHER route:
 *
 *   1. **Mutation** — at least one declared `verifyChanged` path differs from its
 *      pre-AI snapshot. A path is "changed" when its current content differs from
 *      the snapshot, covering created (`null`→content), deleted (content→`null`),
 *      and edited files alike.
 *   2. **A declared satisfaction predicate** (`step.verifySatisfiedBy`) — the file
 *      already says what it should. Consulted only when route 1 fails, so the
 *      cheap in-memory comparison still short-circuits the common case.
 *
 * Route 2 exists because mutation alone asks the wrong question of a file the
 * session was required to keep current as it worked. A project whose rules say
 * "update the changelog with every change" reaches the wrap with nothing left to
 * write, and a mutation-only gate blocks exactly the sessions that complied
 * (GH #645). The predicate is opt-in per step: a step that declares none behaves
 * exactly as before.
 *
 * A predicate that cannot judge (`unavailable`) does NOT satisfy the step — the
 * gate falls through to the mutation blocker. Not knowing is not the same as
 * knowing the step did its job, and that fallback is what keeps the honor-system
 * hole closed for projects the predicate cannot evaluate.
 *
 * @param {string} projectPath - Absolute project root
 * @param {object} step - Step spec (`step.id` for messages, `step.verifySatisfiedBy` for route 2)
 * @param {Object<string, string|null>|null} beforeSnapshot - Pre-AI snapshot
 * @param {object|null} [scope] - The wrap run's scope, handed to the predicate
 * @param {object|null} [options] - The run's options; `pathDecisions` is handed to the predicate
 * @returns {{blocker: string, remediation: string}|null} Null when the step is satisfied.
 */
function _verifyChangedGate(projectPath, step, beforeSnapshot, scope = null, options = null) {
  if (!beforeSnapshot) return null;
  const paths = Object.keys(beforeSnapshot);
  const after = _snapshotPaths(projectPath, paths);
  const changed = paths.some((p) => after[p] !== beforeSnapshot[p]);
  if (changed) return null;

  const satisfied = _satisfactionPredicateGate(projectPath, step, paths, scope, options);
  if (satisfied) return satisfied.ok ? null : satisfied.block;

  const names = paths.join(', ');
  log.warn('ai-content step reported done but changed none of its declared files', {
    stepId: step.id, verifyChanged: paths
  });
  return {
    blocker: `${step.id}: no change detected in ${names} — the step's job is to edit ${names}, but it is byte-identical to before the AI ran`,
    // Retry is deliberately NOT offered as the primary route. Each attempt
    // re-snapshots, so if the AI completed the edit after this step gave up,
    // the retry sees no *further* change and blocks again — an unclearable
    // loop. "Skip & note" is the correct resolution in both cases, and it is
    // safe: any edit already on disk is still picked up by the commit step's
    // `git add -A`. Retry only helps when the AI never ran at all.
    remediation: `The AI reported done but did not modify ${names}. Tick "Skip & note" to record the skip and wrap without this step — if the AI did write the file after this check ran, that edit is still on disk and will be committed. Retry only if the AI never acted; note that a retry re-checks for a NEW change, so it will block again on an edit that has already landed.`
  };
}

/**
 * Route 2 of {@link _verifyChangedGate} — evaluate the step's declared satisfaction
 * predicate, if it declared one.
 *
 * Returns `null` to mean "no verdict, use the mutation result" — covering a step
 * that declared no predicate, a predicate name this build does not implement, and
 * a predicate that ran but could not judge. All three collapse to the same safe
 * answer: fall through to the mutation blocker rather than pass on no evidence.
 *
 * An unrecognized predicate name is logged rather than thrown. A step spec naming a
 * predicate that does not exist is a bug, but failing the wrap closed on it would
 * turn a spec typo into an unclearable block, and the mutation check it falls back
 * to is the same gate that shipped before predicates existed.
 *
 * @param {string} projectPath - Absolute project root
 * @param {object} step - Step spec
 * @param {string[]} paths - The step's declared `verifyChanged` paths, handed to the
 *   predicate so it looks for the same files the gate snapshots
 * @param {object|null} [scope] - The wrap run's scope (`lib/wrap-scope.js`): the
 *   session's launch baseline and trunk position the predicate measures from
 * @param {object|null} [options] - The run's options; `pathDecisions` tells the
 *   predicate which uncommitted files the operator included or left out
 * @returns {{ok: true}|{ok: false, block: {blocker: string, remediation: string}}|null}
 */
function _satisfactionPredicateGate(projectPath, step, paths, scope = null, options = null) {
  const name = step.verifySatisfiedBy;
  if (!name) return null;

  const predicate = Object.prototype.hasOwnProperty.call(SATISFACTION_PREDICATES, name)
    ? SATISFACTION_PREDICATES[name]
    : null;
  if (!predicate) {
    log.warn('ai-content step declares an unrecognized verifySatisfiedBy predicate', {
      stepId: step.id, verifySatisfiedBy: name
    });
    return null;
  }
  return predicate(projectPath, step, paths, scope, options);
}

/**
 * `verifySatisfiedBy: 'changelog-coverage'` — CHANGELOG.md already accounts for
 * the session's commits and uncommitted work (GH #645, #659).
 *
 * @param {string} projectPath - Absolute project root
 * @param {object} step - Step spec
 * @param {string[]} paths - The step's filtered `verifyChanged` paths
 * @param {object|null} scope - The wrap run's scope
 * @param {object|null} options - The run's options (`pathDecisions`)
 * @returns {{ok: true}|{ok: false, block: {blocker: string, remediation: string}}|null}
 */
function _changelogCoveragePredicate(projectPath, step, paths, scope, options) {
  let result;
  try {
    result = _internal.changelogCoverage(projectPath, paths, step.coveragePaths, scope, { pathDecisions: options ? options.pathDecisions : undefined });
  } catch (err) {
    log.warn('changelog-coverage predicate threw; falling back to the mutation check', {
      stepId: step.id, error: err.message
    });
    return null;
  }
  if (result.verdict === changelogCoverage.VERDICTS.COVERED) {
    log.info('ai-content step satisfied by coverage rather than mutation', {
      stepId: step.id, checkedCount: result.checkedCount, range: result.range
    });
    return { ok: true };
  }

  if (result.verdict === changelogCoverage.VERDICTS.UNCOVERED) {
    // The filtered list the gate actually snapshotted, not the raw declaration —
    // the two differ if a step declares a blank path, and a message naming a file
    // the gate never looked at would send the operator to the wrong place.
    const names = paths.join(', ');

    // A non-null `reason` on an UNCOVERED verdict means the range this verdict
    // was computed over was widened by a git probe our own timeout killed. The
    // block still stands — the changelog genuinely was not maintained over that
    // range — but the operator is about to be handed a commit list that may
    // reach back past their own session, so the caveat rides with it.
    const degraded = typeof result.reason === 'string' && result.reason.trim()
      ? `\n\nNote: ${result.reason.trim()}. Check the listed commits belong to this session before writing entries for them.`
      : '';

    // #659: an `uncovered` verdict has two shapes and they render differently. When
    // it names uncommitted work (files that `git add -A` will sweep into this wrap's
    // own commit with no entry) the rows are paths, not commits — the commit
    // renderer below would throw on their null sha.
    const uncommittedWork = Array.isArray(result.uncommittedWork) ? result.uncommittedWork : [];
    if (uncommittedWork.length > 0) {
      const listed = uncommittedWork.join('\n  - ');
      return {
        ok: false,
        block: {
          blocker: `${step.id}: ${names} is unchanged, and ${uncommittedWork.length} uncommitted work file(s) will ship in this wrap's commit with no entry`,
          remediation: `These uncommitted files will be committed by this wrap with no ${names} entry:\n  - ${listed}\nWrite the entry into ${names} (an uncommitted entry counts, so it does not matter whether you write it now or the session writes it on retry), then Retry. If that work genuinely warrants no entry, tick "Skip & note" to record that decision.${degraded}`
        }
      };
    }

    const listed = result.uncovered
      .map((c) => `${c.sha.slice(0, 7)} ${c.subject}`)
      .join('\n  - ');
    return {
      ok: false,
      block: {
        blocker: `${step.id}: ${names} is unchanged, and ${result.uncovered.length} of ${result.checkedCount} commit(s) in this session never touched it`,
        // Writing the entry is what clears this, and it clears via TWO routes: an
        // edit made during the retry turn trips the mutation check, and an edit
        // made before it leaves the file dirty, which the predicate itself accepts.
        // Both are covered, so this text can promise a retry works — unlike the
        // mutation blocker below, where a retry genuinely cannot clear.
        remediation: `These commits shipped without a ${names} entry:\n  - ${listed}\nWrite the missing entries into ${names}, then Retry — an uncommitted entry counts, so it does not matter whether you write it now or the session writes it on retry. If that work genuinely warrants no entry, tick "Skip & note" to record that decision.${degraded}`
      }
    };
  }

  log.debug('changelog-coverage predicate could not judge; using the mutation result', {
    stepId: step.id, reason: result.reason
  });
  return null;
}

/**
 * `verifySatisfiedBy: 'learnings-entry'` — the learnings file already carries an
 * entry this session wrote (#843, #1405). See `lib/wrap-steps/learnings-coverage.js`
 * for what counts and the one known false pass.
 *
 * An entry already on disk satisfies the step on the attempt that finds it, so,
 * unlike the bare mutation blocker, this block can promise that a Retry clears
 * once the entry is written.
 *
 * @param {string} projectPath - Absolute project root
 * @param {object} step - Step spec
 * @param {string[]} paths - The step's filtered `verifyChanged` paths
 * @param {object|null} scope - The wrap run's scope (`startedAtMs`)
 * @returns {{ok: true}|{ok: false, block: {blocker: string, remediation: string}}|null}
 */
function _learningsEntryPredicate(projectPath, step, paths, scope) {
  let result;
  try {
    result = _internal.learningsCoverage(projectPath, paths, scope);
  } catch (err) {
    log.warn('learnings-entry predicate threw; falling back to the mutation check', {
      stepId: step.id, error: err.message
    });
    return null;
  }

  if (result.verdict === learningsCoverage.VERDICTS.COVERED) {
    log.info('ai-content step satisfied by an entry already in the file', {
      stepId: step.id, path: result.path, entryDate: result.entryDate
    });
    return { ok: true };
  }

  if (result.verdict === learningsCoverage.VERDICTS.UNCOVERED) {
    const names = paths.join(', ');
    return {
      ok: false,
      block: {
        blocker: `${step.id}: no change detected in ${names}, and it carries no entry from this session — ${result.reason}`,
        remediation: `Add this session's entry to ${names}: a dated \`## YYYY-MM-DD — title\` entry, or the single line \`- YYYY-MM-DD: no novel learnings (routine work).\` when there is genuinely nothing to record. An entry already written this session counts, so Retry clears once it is on disk, whenever it was written. To wrap without one, tick "Skip & note" to record that decision.`
      }
    };
  }

  log.debug('learnings-entry predicate could not judge; using the mutation result', {
    stepId: step.id, reason: result.reason
  });
  return null;
}

// Preconditions a step may name in `precondition`, keyed by that name. Each
// returns `{open:true}` when the step's prompt could change what the wrap does,
// or `{open:false, reason}` when it couldn't.
const PRECONDITIONS = Object.freeze({
  'release-decision-open': releaseRecommendation.releaseDecisionOpen
});

/**
 * Whether a content step should send its prompt this wrap, from the step's
 * `precondition` field.
 *
 * One answer for the handler and for the runner's `step N of M` roster
 * (`lib/wrap-pipeline.js:_planAiContentPrompts`), so a step the handler skips is
 * never counted as a prompt. A step with no `precondition` always runs. A name
 * with no registered predicate is a bug in the code-owned pipeline, and the step
 * skips with a reason saying so rather than prompting on an unchecked condition.
 *
 * The roster plans before any step runs, and a content step earlier in the
 * pipeline can change what a predicate reads (`changelog-update` writes the
 * entries the release predicate looks for). So the roster passes
 * `planning: true`, and a predicate then decides only on facts no earlier step
 * changes. A prompt the handler later finds unneeded leaves the count one high,
 * which is the cheaper error: a count one low would number a prompt past the
 * total.
 *
 * @param {object} step - Override-resolved step spec
 * @param {object} project - Scoped project record
 * @param {object} [options] - Runner options
 * @param {{planning?: boolean}} [phase] - `planning: true` from the roster
 * @returns {{open: true}|{open: false, reason: string}}
 */
function preconditionVerdict(step, project, options, phase) {
  if (!step || step.precondition === undefined || step.precondition === null) return { open: true };
  const predicate = typeof step.precondition === 'string'
    && Object.prototype.hasOwnProperty.call(PRECONDITIONS, step.precondition)
    ? PRECONDITIONS[step.precondition]
    : null;
  if (!predicate) {
    return { open: false, reason: `unknown precondition ${JSON.stringify(step.precondition)} on ${step.id} — a bug in the wrap pipeline, so the prompt was not sent` };
  }
  return predicate(project, options || {}, phase || {});
}

// Satisfaction predicates a step may name in `verifySatisfiedBy`, keyed by that name.
// Each returns `{ok:true}`, `{ok:false, block}`, or `null` for "no verdict, use the
// mutation result".
const SATISFACTION_PREDICATES = Object.freeze({
  'changelog-coverage': _changelogCoveragePredicate,
  'learnings-entry': _learningsEntryPredicate
});

const _internal = {
  // `execSync` for the `{sessionScope}` range probes; a unit harness that drives
  // prompts against a non-repo path replaces it.
  rangeExec: require('node:child_process').execSync,
  sendKeys: tmuxLib.sendKeys,
  // #1685 delivery receipt, behind the seam so consecutive-step tests can drive
  // each outcome without a real pane.
  verifySubmission: (session, engineId, prompt) =>
    deliveryReceipt.verifySubmission(session, engineId, prompt),
  capturePane: tmuxLib.capturePane,
  readPaneTail: defaultReadPaneTail,
  newNonce: defaultNewNonce,
  sleep: defaultSleep,
  now: () => Date.now(),
  readCaptureFile: defaultReadCaptureFile,
  removeCaptureFile: defaultRemoveCaptureFile,
  captureFileExists: defaultCaptureFileExists,
  readForVerify: defaultReadForVerify,
  // Satisfaction predicate for `verifySatisfiedBy: 'changelog-coverage'`. Behind
  // the seam so gate tests can drive each verdict without a real git history.
  changelogCoverage: (projectPath, paths, coveragePaths, scope, opts) => changelogCoverage.evaluate(projectPath, paths, coveragePaths, scope, opts),
  // Satisfaction predicate for `verifySatisfiedBy: 'learnings-entry'`, behind the
  // same seam for the same reason.
  learningsCoverage: (projectPath, paths, scope) => learningsCoverage.evaluate(projectPath, paths, scope),
  // Wrap-rules bridge — the project's enabled `kind='wrap'` rules, appended to
  // every non-empty ai-content prompt. `list()` returns newest-first for the
  // UI; re-sorted by monotonic id so the prompt reads oldest-first, matching
  // the startup rules' launch-injection order (created_at has second
  // resolution, so reversing on it mis-orders same-second rules). Mockable so
  // tests don't need a live DB.
  // `status: 'active'` is load-bearing, not defensive: a wrap can now PROPOSE a
  // rule, and a proposal must not govern anything until the operator approves
  // it. Without this filter an unreviewed proposal would be injected into the
  // very next wrap's prompts — the wrap would be taking instruction from itself.
  listWrapRules: (projectId) => store.sessionRules.list({ projectId, enabled: 1, status: 'active', kind: 'wrap' }).sort((a, b) => a.id - b.id),
  // CC-7 Slice B1 — gateway capture deps (mockable in tests vs a real bridge).
  getBridgeContext: resolveBridgeContext,
  bridgeSend: clawbridgeLib.send,
  bridgeGetStatus: clawbridgeLib.getStatus,
  bridgeGetFile: clawbridgeLib.getFile,
  // The ARM read, separate from `bridgeGetFile` even though it calls the same
  // primitive. They are different acts: one clears a file that belongs to no
  // current run and discards it, the other reads this run's result and parses
  // it. Sharing one seam would make "the step never read the result" and "the
  // step never touched the file" the same assertion, and only the first is the
  // property the gateway tests are pinning.
  bridgeClearCaptureFile: clawbridgeLib.getFile
};

module.exports = { run, stagedFromOutput, preconditionVerdict, PRECONDITIONS, _internal, _interpolatePrompt, _readOnlyModeMarker, _readOnlyPrecheck, _readOnlyRemediation, _withPrecheck, _runTmuxCapture, READ_ONLY_TAIL_LINES, _appendWrapRules, _wrapStepHeader, _parseFields, _resolveCaptureContract, _hasCaptureContract, _uncapturedOptional, _normalizeFieldKey, _runGatewayCapture, _resolveEngineConfigFile, _receiptEngineId, _snapshotPaths, _watchedOutputPaths, _verifyChangedGate, SUPPORTED_PROMPT_TOKENS, STABILITY_MS, QUIET_FALLBACK_MS, MAX_WAIT_MS, POLL_INTERVAL_MS, PANE_TAIL_LINES, MARKER_GRACE_MS, _markerSeen, _completionInstruction, SATISFACTION_PREDICATES };
