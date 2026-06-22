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
// `lib/clawbridge.js` only pulls in `node:http` + `./logger`, so it has no
// back-edge to this module — safe to eager-require (unlike `../sessions`).
const clawbridgeLib = require('../clawbridge');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-ai-content');

const INITIAL_SETTLE_MS = 3000;
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes — wraps with long Critic dispatches can run this long; bounded so a stuck AI cannot wedge the wrap drawer forever
const MIN_RESPONSE_CHARS = 20;
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
 * @param {object|null} context.session - Active Session record. A tmux-mode
 *   session must have `tmuxSession`; a webui-mode session (`sessionMode ===
 *   'webui'`, no tmux) is skipped (#334).
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @param {Array} context.previousResults - Prior step results
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, session, step, previousResults, staged } = context;
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
  // Clock reads go through `_internal.now` so the timeout branch is
  // deterministically testable (tests stub `now` to fast-forward past
  // MAX_WAIT_MS without a 5-minute wall-clock wait).
  const startedAt = _internal.now();
  await _internal.sleep(INITIAL_SETTLE_MS);

  let idled = false;
  while (_internal.now() - startedAt < MAX_WAIT_MS) {
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
    // #328: describe the STEP outcome, not the pipeline's. Whether the wrap
    // halts is the runner's call (driven by `step.blocker`), so the handler
    // must not assert "wrap pipeline blocked" — that was false for the
    // historically non-blocker content steps and contradicted the commit
    // that landed anyway. The remediation tells the operator the AI may
    // still be working (wait + Retry) or is wedged (use "Skip & note").
    const waited = Math.round(MAX_WAIT_MS / 1000);
    return {
      ok: false,
      status: 'blocked',
      output: {
        remediation: `The AI did not finish within ${waited}s (no idle detected in the terminal). If it is still working, wait for it to finish and click Retry. If it is wedged, use "Skip & note" to wrap without this step (the skip is recorded in the commit body).`
      },
      blockers: [`${step.id}: AI did not return within ${waited}s (no idle detected)`]
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

  // Empty prompt = methodology author's intentional skip marker (parity with
  // the tmux path's identical guard).
  if (typeof step.prompt !== 'string' || step.prompt.trim() === '') {
    return { ok: true, status: 'skipped', output: null, blockers: [] };
  }

  const captureFields = Array.isArray(step.captureFields) ? step.captureFields : [];

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
  const bridge = _internal.getBridgeContext(session, project);
  if (!bridge) {
    return {
      ok: true,
      status: 'skipped',
      output: { webui: true, reason: 'webui session: no ClawBridge sidecar (bridgePort) configured — ai-content capture is N/A' },
      blockers: []
    };
  }

  const prompt = _interpolatePrompt(step.prompt, previousResults || []);

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
    // fast-fails when `detectIdle` throws on a vanished pane). `getStatus`
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
      blockers: [`captureFile "${step.captureFile}" missing or unreadable over the gateway — the step prompt must instruct the AI to write the structured block there (${fileRes.error})`]
    };
  }

  // 4. Parse with the SAME parser the tmux path uses — the captureFile is raw
  // markdown, so `## Heading` blocks match (the whole point of #18).
  const parseSource = fileRes.content || '';
  const sections = _parseFields(parseSource, captureFields);
  const missing = captureFields.filter((f) => !sections[f] || !sections[f].trim());
  if (missing.length > 0) {
    return {
      ok: false,
      status: 'blocked',
      output: { capturedText: parseSource, parsedFields: sections },
      blockers: missing.map((f) => `Required captureField "${f}" missing or empty in AI response`)
    };
  }
  staged[step.id] = { capturedText: parseSource, parsedFields: sections };
  return {
    ok: true,
    status: 'done',
    output: { capturedText: parseSource, parsedFields: sections },
    blockers: []
  };
}

/**
 * Resolve the ClawBridge sidecar connection for a webui session. Lazily
 * requires the store (keeps the dependency mockable via `_internal` and avoids
 * pulling the store into this module's load graph). Returns the call essentials
 * for the `clawbridge.*` methods, or `null` when the session isn't bridge-backed
 * (not an openclaw engine, unknown connection, or no `bridgePort` sidecar).
 *
 * The bridge addresses sessions by project name (the same `project.name`
 * `launchWebuiSession` passes to `clawbridge.startSession`).
 *
 * @param {object} session - Active session record (carries `engineId`)
 * @param {object} project - Project record (its `.name` is the bridge's session key)
 * @returns {{localPort:number, token:string|null, project:string}|null}
 */
function defaultGetBridgeContext(session, project) {
  const engineId = session && session.engineId;
  if (!engineId || !engineId.startsWith('openclaw:')) return null;
  const connId = engineId.slice('openclaw:'.length);
  const conn = require('../store').openclawConnections.get(connId);
  if (!conn || !conn.bridgePort) return null;
  return { localPort: conn.bridgePort, token: conn.bridgeToken || null, project: project.name };
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
  now: () => Date.now(),
  readCaptureFile: defaultReadCaptureFile,
  removeCaptureFile: defaultRemoveCaptureFile,
  // CC-7 Slice B1 — gateway capture deps (mockable in tests vs a real bridge).
  getBridgeContext: defaultGetBridgeContext,
  bridgeSend: clawbridgeLib.send,
  bridgeGetStatus: clawbridgeLib.getStatus,
  bridgeGetFile: clawbridgeLib.getFile
};

module.exports = { run, _internal, _interpolatePrompt, _parseFields, _normalizeFieldKey, _runGatewayCapture };
