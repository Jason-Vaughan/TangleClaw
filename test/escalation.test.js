'use strict';

/*
 * TB-3 (#358) — escalation-signal recognizer stub.
 *
 * Covers the pure recognizer module (lib/escalation.js): the marker contract
 * (`tanglebrain.escalate === true`, strict), normalization of the snake_case wire
 * fields, the never-throw totality on malformed input, single-SSE-line
 * recognition (the "last chunk" path), and the surfacing HOOK — which logs and
 * returns WITHOUT routing (`routed: false`), the stub boundary that proves TC
 * makes no cloud call.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const escalation = require('../lib/escalation');
const {
  recognizeEscalation,
  recognizeEscalationFromSSELine,
  surfaceEscalation
} = escalation;

/** A logger double that records every call for assertions. */
function fakeLog() {
  const calls = [];
  const rec = (level) => (message, context) => calls.push({ level, message, context });
  return { calls, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

/** A realistic chat-completion response carrying the marker alongside finish_reason. */
function responseWithMarker(marker) {
  return {
    id: 'chatcmpl-x',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }],
    tanglebrain: marker
  };
}

describe('recognizeEscalation — valid markers', () => {
  it('recognizes a full marker and normalizes suggested_tier → suggestedTier', () => {
    const res = responseWithMarker({
      escalate: true,
      reason: 'needs_frontier',
      detail: 'classifier confidence below threshold',
      suggested_tier: 'frontier'
    });
    assert.deepEqual(recognizeEscalation(res), {
      escalate: true,
      reason: 'needs_frontier',
      detail: 'classifier confidence below threshold',
      suggestedTier: 'frontier'
    });
  });

  it('defaults optional fields to null when only escalate is present', () => {
    assert.deepEqual(recognizeEscalation({ tanglebrain: { escalate: true } }), {
      escalate: true,
      reason: null,
      detail: null,
      suggestedTier: null
    });
  });

  it('does not require finish_reason to be present (marker rides alongside, independently)', () => {
    const out = recognizeEscalation({ tanglebrain: { escalate: true, reason: 'x' } });
    assert.equal(out.escalate, true);
    assert.equal(out.reason, 'x');
  });

  it('normalizes non-string reason/detail/suggested_tier to null without throwing', () => {
    const out = recognizeEscalation({
      tanglebrain: { escalate: true, reason: 42, detail: { nested: true }, suggested_tier: ['frontier'] }
    });
    assert.deepEqual(out, { escalate: true, reason: null, detail: null, suggestedTier: null });
  });
});

describe('recognizeEscalation — declines (returns null)', () => {
  it('declines escalate: false', () => {
    assert.equal(recognizeEscalation({ tanglebrain: { escalate: false } }), null);
  });

  it('declines a missing escalate field', () => {
    assert.equal(recognizeEscalation({ tanglebrain: { reason: 'x' } }), null);
  });

  it('declines truthy-but-not-strictly-true escalate (1, "true")', () => {
    assert.equal(recognizeEscalation({ tanglebrain: { escalate: 1 } }), null);
    assert.equal(recognizeEscalation({ tanglebrain: { escalate: 'true' } }), null);
  });

  it('declines a response with no tanglebrain marker', () => {
    assert.equal(recognizeEscalation(responseWithMarker(undefined)), null);
    assert.equal(recognizeEscalation({ choices: [] }), null);
  });

  it('declines a non-object marker', () => {
    assert.equal(recognizeEscalation({ tanglebrain: 'escalate' }), null);
    assert.equal(recognizeEscalation({ tanglebrain: 42 }), null);
    assert.equal(recognizeEscalation({ tanglebrain: null }), null);
  });

  it('declines null/undefined/non-object responses without throwing', () => {
    assert.equal(recognizeEscalation(null), null);
    assert.equal(recognizeEscalation(undefined), null);
    assert.equal(recognizeEscalation('nope'), null);
    assert.equal(recognizeEscalation(7), null);
    assert.equal(recognizeEscalation([1, 2, 3]), null);
  });
});

describe('recognizeEscalationFromSSELine', () => {
  const dataLine = (obj) => `data: ${JSON.stringify(obj)}`;

  it('recognizes a marker on the terminal SSE data line', () => {
    const line = dataLine({
      choices: [{ finish_reason: 'stop', delta: {} }],
      tanglebrain: { escalate: true, reason: 'needs_frontier', suggested_tier: 'frontier' }
    });
    assert.deepEqual(recognizeEscalationFromSSELine(line), {
      escalate: true,
      reason: 'needs_frontier',
      detail: null,
      suggestedTier: 'frontier'
    });
  });

  it('handles "data:" with no space after the colon', () => {
    const line = `data:${JSON.stringify({ tanglebrain: { escalate: true } })}`;
    assert.equal(recognizeEscalationFromSSELine(line).escalate, true);
  });

  it('declines the [DONE] sentinel', () => {
    assert.equal(recognizeEscalationFromSSELine('data: [DONE]'), null);
  });

  it('declines non-data lines (comments, event:, blank)', () => {
    assert.equal(recognizeEscalationFromSSELine(': keep-alive comment'), null);
    assert.equal(recognizeEscalationFromSSELine('event: message'), null);
    assert.equal(recognizeEscalationFromSSELine(''), null);
    assert.equal(recognizeEscalationFromSSELine('   '), null);
  });

  it('declines a data line whose payload is not valid JSON (no throw)', () => {
    assert.equal(recognizeEscalationFromSSELine('data: {not json'), null);
  });

  it('declines a valid JSON chunk that carries no marker', () => {
    assert.equal(recognizeEscalationFromSSELine(dataLine({ choices: [{ delta: { content: 'hi' } }] })), null);
  });

  it('declines non-string input', () => {
    assert.equal(recognizeEscalationFromSSELine(null), null);
    assert.equal(recognizeEscalationFromSSELine({ data: 'x' }), null);
  });
});

describe('surfaceEscalation — the hook (logs, never routes)', () => {
  it('logs a recognized escalation and returns surfaced/not-routed', () => {
    const log = fakeLog();
    const esc = { escalate: true, reason: 'needs_frontier', detail: 'd', suggestedTier: 'frontier' };
    const result = surfaceEscalation(esc, { project: 'p', session: 7, engine: 'claude', profile: 'direct' }, { log });

    assert.deepEqual(result, { surfaced: true, routed: false });
    assert.equal(log.calls.length, 1);
    const [call] = log.calls;
    assert.equal(call.level, 'info');
    assert.match(call.message, /escalation signal recognized/i);
    assert.deepEqual(call.context, {
      project: 'p',
      session: 7,
      engine: 'claude',
      profile: 'direct',
      reason: 'needs_frontier',
      detail: 'd',
      suggestedTier: 'frontier'
    });
  });

  it('is a no-op for a null escalation (declined recognition) and does not log', () => {
    const log = fakeLog();
    const result = surfaceEscalation(null, { project: 'p' }, { log });
    assert.deepEqual(result, { surfaced: false, routed: false });
    assert.equal(log.calls.length, 0);
  });

  it('works without a context argument', () => {
    const log = fakeLog();
    const result = surfaceEscalation({ escalate: true, reason: null, detail: null, suggestedTier: null }, undefined, { log });
    assert.deepEqual(result, { surfaced: true, routed: false });
    assert.equal(log.calls[0].context.project, undefined);
  });
});

describe('acceptance — simulated marker recognized + surfaced, no cloud call', () => {
  it('object response: recognize → surface logs and never routes', () => {
    const log = fakeLog();
    const simulated = responseWithMarker({ escalate: true, reason: 'needs_frontier', suggested_tier: 'frontier' });

    const result = surfaceEscalation(recognizeEscalation(simulated), { project: 'demo' }, { log });

    assert.deepEqual(result, { surfaced: true, routed: false }); // routed:false ⇒ TC made no cloud call
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].context.suggestedTier, 'frontier');
  });

  it('SSE terminal chunk: recognize-from-line → surface logs and never routes', () => {
    const log = fakeLog();
    const line = `data: ${JSON.stringify({
      choices: [{ finish_reason: 'stop', delta: {} }],
      tanglebrain: { escalate: true, reason: 'needs_frontier' }
    })}`;

    const result = surfaceEscalation(recognizeEscalationFromSSELine(line), { engine: 'aider' }, { log });

    assert.deepEqual(result, { surfaced: true, routed: false });
    assert.equal(log.calls.length, 1);
  });

  it('the module imports no HTTP client (no cloud-call surface exists in the stub)', () => {
    // Structural guard for invariant #3 / the stub boundary: a recognizer that
    // could reach the cloud would be a routing implementation, not a stub.
    const src = require('node:fs').readFileSync(require.resolve('../lib/escalation.js'), 'utf8');
    assert.doesNotMatch(src, /require\(['"](node:)?(http|https|net|undici)['"]\)/);
    assert.doesNotMatch(src, /\bfetch\s*\(/);
  });
});
