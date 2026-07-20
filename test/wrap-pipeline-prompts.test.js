'use strict';

/**
 * Structural pins on the code-owned wrap pipeline's `ai-content` step prompts.
 *
 * These prompts are a CONTRACT, not prose: `lib/wrap-steps/ai-content.js`
 * parses the AI's reply by looking for the exact headings the prompt asked
 * for. A prompt edit that drops `## Result`, renames a `## Heading`, or adds
 * one with no matching `captureField` does not fail loudly — it produces an
 * unstructured reply that the handler either rejects at wrap time ("Required
 * captureField missing", blocking a real session) or silently fails to read
 * (losing the wrap commit subject). Neither surfaces until an operator is
 * mid-wrap, which is why these are pinned in CI.
 *
 * Ported from the bundled-template era (the prompts were data then, in
 * `data/templates/prawduct/template.json`); they now live in
 * `lib/wrap-default-pipeline.js`, so the pins follow them there. The
 * reconcile-behavior and empty-prompt-anchor pins did NOT come along — the
 * template reconciler and the second bundled template they described are both
 * gone; the empty-prompt → `skipped` path is exercised directly by fixture in
 * `test/wrap-step-ai-content.test.js`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const wrapDefaultPipeline = require('../lib/wrap-default-pipeline');

const MIN_PROMPT_CHARS = 200;

/**
 * Fetch an `ai-content` step from the code-owned pipeline by id.
 * @param {string} stepId
 * @returns {object}
 */
function getAiContentStep(stepId) {
  const step = wrapDefaultPipeline.steps().find((s) => s.id === stepId);
  assert.ok(step, `pipeline missing step ${stepId}`);
  assert.equal(step.kind, 'ai-content', `${stepId} kind is not ai-content`);
  return step;
}

describe('wrap pipeline ai-content prompts', () => {
  it('changelog-update prompt is populated and references CHANGELOG conventions', () => {
    const step = getAiContentStep('changelog-update');
    assert.ok(
      step.prompt.length >= MIN_PROMPT_CHARS,
      `prompt should be >= ${MIN_PROMPT_CHARS} chars, got ${step.prompt.length}`
    );
    assert.match(step.prompt, /CHANGELOG\.md/);
    assert.match(step.prompt, /\[Unreleased\]/);
    assert.match(step.prompt, /## Result/);
  });

  it('learnings-capture prompt is populated and references learnings.md', () => {
    const step = getAiContentStep('learnings-capture');
    assert.ok(
      step.prompt.length >= MIN_PROMPT_CHARS,
      `prompt should be >= ${MIN_PROMPT_CHARS} chars, got ${step.prompt.length}`
    );
    assert.match(step.prompt, /learnings\.md/);
    assert.match(step.prompt, /## Result/);
  });

  it('memory-update prompt instructs the three required heading blocks', () => {
    const step = getAiContentStep('memory-update');
    assert.ok(
      step.prompt.length >= MIN_PROMPT_CHARS,
      `prompt should be >= ${MIN_PROMPT_CHARS} chars, got ${step.prompt.length}`
    );
    // These literals are what `_parseFields` matches against
    // (case-insensitive). Drift between the prompt and captureFields either
    // blocks every wrap ("Required captureField missing") or silently loses
    // the wrap commit subject when `## Summary` never appears.
    assert.match(step.prompt, /## Summary/);
    assert.match(step.prompt, /## NextSteps/);
    assert.match(step.prompt, /## Learnings/);

    assert.deepEqual(step.captureFields, ['summary', 'nextSteps', 'learnings']);

    // #287: the structured block is parsed from a FILE, not the pane —
    // `capture-pane -p` strips the literal `##` the TUI renders away, so
    // heading-parsing the pane never matched. The step must declare a
    // `captureFile` AND the prompt must point the AI at it; otherwise the
    // handler falls back to the (broken-for-Claude) pane path. Lockstep guard
    // so neither half can drift away alone.
    assert.equal(step.captureFile, '.tangleclaw/.wrap-summary.md');
    assert.ok(
      step.prompt.includes(step.captureFile),
      'memory-update prompt must instruct the AI to write the block to its captureFile'
    );

    // The prompt must explain WHY these blocks matter, so a later edit
    // doesn't strip the structured-response section as "verbose".
    assert.match(step.prompt, /captureField/);
  });

  it('every ai-content step closes with a parseable protocol (Result heading or capture fields)', () => {
    // A safety net for any ai-content step added later: without a closing
    // protocol the reply is free-form of indeterminate shape, which is
    // painful to debug post-merge.
    const aiSteps = wrapDefaultPipeline.steps().filter((s) => s.kind === 'ai-content');
    assert.ok(aiSteps.length > 0, 'the pipeline should declare ai-content steps');
    for (const step of aiSteps) {
      const hasCaptureFields = Array.isArray(step.captureFields) && step.captureFields.length > 0;
      const hasResultTail = /## Result/.test(step.prompt);
      assert.ok(
        hasCaptureFields || hasResultTail,
        `step ${step.id} prompt has neither captureFields nor a ## Result tail — the wrap response will be unstructured`
      );
    }
  });
});

describe('wrap pipeline ai-content prompts — drift guards', () => {
  it('every captureField appears as a ## Heading literal in its prompt (forward drift)', () => {
    // Add `risks` to captureFields without adding `## Risks` to the prompt and
    // every wrap silently blocks with "Required captureField missing."
    for (const step of wrapDefaultPipeline.steps()) {
      if (step.kind !== 'ai-content' || !Array.isArray(step.captureFields)) continue;
      for (const field of step.captureFields) {
        const heading = `## ${field.charAt(0).toUpperCase()}${field.slice(1)}`;
        assert.ok(
          step.prompt.includes(heading),
          `captureField "${field}" not mentioned as "${heading}" literal in the ${step.id} prompt`
        );
      }
    }
  });

  it('every ## Heading other than ## Result corresponds to a captureField (inverse drift)', () => {
    // Add `## Risks` to a prompt without adding `risks` to captureFields and
    // the AI emits a block the parser ignores — the wrap commit subject
    // deriver can never see it.
    for (const step of wrapDefaultPipeline.steps()) {
      if (step.kind !== 'ai-content') continue;
      const matches = [...step.prompt.matchAll(/^## (\w[\w-]*)/gm)].map((m) => m[1]);
      const expected = new Set((step.captureFields || []).map((f) => f.toLowerCase()));
      for (const heading of matches) {
        const norm = heading.toLowerCase();
        if (norm === 'result') continue; // free-form tail convention
        assert.ok(
          expected.has(norm),
          `step "${step.id}" prompt has "## ${heading}" but no matching captureField`
        );
      }
    }
  });

  it('every {token} in a prompt is one the interpolator actually substitutes', () => {
    // An unrecognized token passes through verbatim to the AI by design (so a
    // misnamed token is visible rather than silently blank), which makes
    // shipping one a defect. Assert membership against the implementation's
    // own list so a token added to a prompt but never implemented fails here.
    const { SUPPORTED_PROMPT_TOKENS } = require('../lib/wrap-steps/ai-content');
    const supported = new Set(SUPPORTED_PROMPT_TOKENS);
    for (const step of wrapDefaultPipeline.steps()) {
      if (step.kind !== 'ai-content') continue;
      const tokens = step.prompt.match(/\{[a-zA-Z][\w]*\}/g) || [];
      for (const raw of tokens) {
        const name = raw.slice(1, -1);
        assert.ok(
          supported.has(name),
          `step "${step.id}" prompt uses ${raw}, which _interpolatePrompt does not substitute — it would reach the AI verbatim. Implement it or remove it.`
        );
      }
    }
  });
});
