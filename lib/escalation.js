'use strict';

/**
 * TB-3 (#358) — Escalation-signal recognizer STUB.
 *
 * Defines how a local OpenAI-compatible endpoint says "this needs frontier" and
 * how the harness/TC RECOGNIZES it — wiring the seam now so signal-up is additive
 * later, not a rewrite. Honors TangleBrain invariant #3: TC/Monad NEVER broker the
 * cloud call; the top orchestrator handles the cloud hop on its own OAuth. This
 * chunk builds ONLY the recognizer + a surfacing hook — there is NO routing
 * behavior and TC makes NO cloud call.
 *
 * MARKER CONTRACT (agreed with Monad 2026-06-16): a NAMESPACED top-level field
 * `tanglebrain` on the chat-completion response — deliberately NOT `finish_reason`
 * (SDKs enum-validate that against `stop|length|tool_calls|content_filter|
 * function_call`, so a custom value breaks strict parsers). `finish_reason` stays
 * valid; the marker rides alongside:
 *
 *   { "choices": [{ "finish_reason": "stop", "message": {...} }],
 *     "tanglebrain": { "escalate": true, "reason": "needs_frontier",
 *                      "detail": "...", "suggested_tier": "frontier" } }
 *
 * Streaming: the same `tanglebrain` object on the TERMINAL chunk (the one carrying
 * `finish_reason`), before `data: [DONE]`. Standard OpenAI clients drop unknown
 * top-level keys, so the marker is parser-safe.
 *
 * Nothing emits this marker today — LiteLLM just proxies; the emitter is the
 * Layer-3 LangGraph classifier (Monad #35). When a live response tap exists (a
 * LiteLLM callback or a TC-side response proxy), it composes
 * `surfaceEscalation(recognizeEscalation(response), context)`; until then the
 * recognizer is a ready seam with no live call site by design.
 *
 * All recognizers are pure and NEVER throw — a recognizer that crashed the
 * harness on a malformed response would be worse than one that silently declines.
 */

const { createLogger } = require('./logger');

/** The pinned top-level marker key (TC's choice; Monad #35 emitter must match). */
const MARKER_KEY = 'tanglebrain';

/**
 * Recognize an escalation marker on a parsed chat-completion response or a parsed
 * SSE terminal chunk (both carry the same top-level `tanglebrain` object).
 *
 * Pure and total: any input that is not a well-formed escalation marker — null,
 * non-object, missing marker, non-object marker, or `escalate` that is not
 * STRICTLY `true` (the contract is `escalate: true`; `1`/`"true"`/truthy do not
 * count) — yields `null`. Never throws.
 *
 * @param {*} response - A parsed chat-completion response or SSE chunk object.
 * @returns {{escalate: true, reason: string|null, detail: string|null, suggestedTier: string|null}|null}
 *   The normalized escalation, or `null` when no valid marker is present.
 */
function recognizeEscalation(response) {
  if (!response || typeof response !== 'object') return null;
  const marker = response[MARKER_KEY];
  if (!marker || typeof marker !== 'object') return null;
  if (marker.escalate !== true) return null;

  return {
    escalate: true,
    reason: typeof marker.reason === 'string' ? marker.reason : null,
    detail: typeof marker.detail === 'string' ? marker.detail : null,
    // Wire contract uses snake_case `suggested_tier`; normalize to camelCase.
    suggestedTier: typeof marker.suggested_tier === 'string' ? marker.suggested_tier : null
  };
}

/**
 * Recognize an escalation marker carried on a single Server-Sent-Events line.
 *
 * Accepts one raw SSE line (e.g. `data: {…json…}`). Non-`data:` lines (comments,
 * `event:`, blank), the `data: [DONE]` sentinel, and JSON that fails to parse all
 * yield `null` — a streaming recognizer must never crash the harness mid-stream.
 * A successfully parsed payload is handed to {@link recognizeEscalation}.
 *
 * @param {*} line - A single SSE line.
 * @returns {{escalate: true, reason: string|null, detail: string|null, suggestedTier: string|null}|null}
 */
function recognizeEscalationFromSSELine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;

  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '' || payload === '[DONE]') return null;

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // A non-JSON data line is not our concern — decline rather than throw.
    return null;
  }
  return recognizeEscalation(parsed);
}

/**
 * Surface a recognized escalation — the recognizer HOOK.
 *
 * This is the STUB boundary: it logs the signal (structured, non-blocking) and
 * returns. It performs NO routing and makes NO cloud call — `routed` is always
 * `false`. A future signal-up implementation replaces the body's no-op with a
 * hand-off to the top orchestrator (which owns its own cloud OAuth); the seam and
 * its callers do not change.
 *
 * A `null`/absent escalation is a no-op (so callers can pipe a recognizer result
 * straight in): `surfaceEscalation(recognizeEscalation(resp), ctx)`.
 *
 * @param {{escalate: true, reason: string|null, detail: string|null, suggestedTier: string|null}|null} escalation
 *   The output of a recognizer (or `null` when nothing was recognized).
 * @param {object} [context] - Optional provenance for the log line.
 * @param {string} [context.project] - Project name.
 * @param {string|number} [context.session] - Session id.
 * @param {string} [context.engine] - Engine id.
 * @param {string} [context.profile] - Orchestration profile name.
 * @param {object} [deps] - Injected for testability.
 * @param {{info: Function}} [deps.log] - Logger (defaults to this module's).
 * @returns {{surfaced: boolean, routed: false}} Whether a signal was surfaced; `routed` is always false (stub).
 */
function surfaceEscalation(escalation, context = {}, deps = {}) {
  if (!escalation) return { surfaced: false, routed: false };

  const log = deps.log || createLogger('escalation');
  log.info(
    'TangleBrain escalation signal recognized — surfaced only, no cloud routing (TB-3 #358)',
    {
      project: context.project,
      session: context.session,
      engine: context.engine,
      profile: context.profile,
      reason: escalation.reason,
      detail: escalation.detail,
      suggestedTier: escalation.suggestedTier
    }
  );
  return { surfaced: true, routed: false };
}

module.exports = {
  MARKER_KEY,
  recognizeEscalation,
  recognizeEscalationFromSSELine,
  surfaceEscalation
};
