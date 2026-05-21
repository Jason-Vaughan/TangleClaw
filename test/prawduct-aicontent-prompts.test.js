'use strict';

/**
 * Structural pins on the prawduct methodology template's `ai-content`
 * step prompts (open-queue #2 from MEMORY.md post-#139 — populated
 * after the V2 default flip exposed the three placeholder steps as
 * `skipped` rows in every wrap drawer).
 *
 * These are data-invariant tests (parallel pattern to
 * `test/changelog-structure.test.js`). They pin the bundled template
 * shape so an accidental edit that empties a prompt — which would
 * silently re-introduce three `skipped` rows in the prawduct wrap
 * drawer — fails CI immediately rather than surfacing during a real
 * session wrap.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PRAWDUCT_TEMPLATE_PATH = path.join(
  REPO_ROOT,
  'data',
  'templates',
  'prawduct',
  'template.json'
);
const MINIMAL_TEMPLATE_PATH = path.join(
  REPO_ROOT,
  'data',
  'templates',
  'minimal',
  'template.json'
);

const MIN_PROMPT_CHARS = 200;

function getAiContentStep(template, stepId) {
  const step = template.wrap_pipeline.steps.find((s) => s.id === stepId);
  assert.ok(step, `template missing wrap_pipeline step ${stepId}`);
  assert.equal(step.kind, 'ai-content', `${stepId} kind is not ai-content`);
  return step;
}

describe('prawduct ai-content prompts (open-queue #2)', () => {
  const prawduct = JSON.parse(fs.readFileSync(PRAWDUCT_TEMPLATE_PATH, 'utf8'));

  it('changelog-update prompt is populated and references CHANGELOG conventions', () => {
    const step = getAiContentStep(prawduct, 'changelog-update');
    assert.ok(
      step.prompt.length >= MIN_PROMPT_CHARS,
      `prompt should be >= ${MIN_PROMPT_CHARS} chars, got ${step.prompt.length}`
    );
    assert.match(step.prompt, /CHANGELOG\.md/);
    assert.match(step.prompt, /\[Unreleased\]/);
    assert.match(step.prompt, /## Result/);
  });

  it('learnings-capture prompt is populated and references learnings.md', () => {
    const step = getAiContentStep(prawduct, 'learnings-capture');
    assert.ok(
      step.prompt.length >= MIN_PROMPT_CHARS,
      `prompt should be >= ${MIN_PROMPT_CHARS} chars, got ${step.prompt.length}`
    );
    assert.match(step.prompt, /learnings\.md/);
    assert.match(step.prompt, /## Result/);
  });

  it('memory-update prompt is populated AND instructs the three required heading blocks', () => {
    const step = getAiContentStep(prawduct, 'memory-update');
    assert.ok(
      step.prompt.length >= MIN_PROMPT_CHARS,
      `prompt should be >= ${MIN_PROMPT_CHARS} chars, got ${step.prompt.length}`
    );
    // The prompt MUST instruct the AI to emit each captureField as a
    // `## Heading` block — these literals are what `_parseFields`
    // matches against (case-insensitive). Drift between the prompt
    // and the captureFields array would either block every wrap
    // ("Required captureField missing") or silently lose the wrap
    // commit subject if `## Summary` doesn't appear.
    assert.match(step.prompt, /## Summary/);
    assert.match(step.prompt, /## NextSteps/);
    assert.match(step.prompt, /## Learnings/);

    // captureFields stays in lockstep with the prompt above.
    assert.deepEqual(step.captureFields, ['summary', 'nextSteps', 'learnings']);

    // The prompt must explain WHY these blocks matter (so future
    // methodology authors editing this prompt don't strip the
    // structured-response section as "verbose").
    assert.match(step.prompt, /captureField/);
  });

  it('all three prawduct ai-content steps share the same prompt-tail discipline (Result heading or structured blocks)', () => {
    // A safety net: any future ai-content step added to prawduct that
    // forgets a closing protocol would surface as a "free-form AI
    // response of indeterminate shape" — annoying to debug post-merge.
    const aiSteps = prawduct.wrap_pipeline.steps.filter((s) => s.kind === 'ai-content');
    assert.equal(aiSteps.length, 3, 'prawduct should declare exactly 3 ai-content steps');
    for (const step of aiSteps) {
      // Either captureFields-driven (memory-update) or `## Result`-tailed
      // (changelog-update, learnings-capture). Anything else is drift.
      const hasCaptureFields = Array.isArray(step.captureFields) && step.captureFields.length > 0;
      const hasResultTail = /## Result/.test(step.prompt);
      assert.ok(
        hasCaptureFields || hasResultTail,
        `step ${step.id} prompt has neither captureFields nor a ## Result tail — wrap response will be unstructured`
      );
    }
  });
});

describe('minimal methodology — empty-prompt → skipped contract (Chunk 11c regression pin)', () => {
  const minimal = JSON.parse(fs.readFileSync(MINIMAL_TEMPLATE_PATH, 'utf8'));

  it('minimal methodology ai-content steps still ship with empty prompts', () => {
    // Pre-condition for the Chunk 11c contract change (empty prompt →
    // `skipped`) to remain meaningfully exercised by the bundled
    // templates: at least one bundled methodology must keep placeholder
    // steps. Prawduct just gave up its empty-prompt status (this PR);
    // minimal is the remaining anchor. If a future PR populates
    // minimal's ai-content prompts, the empty-prompt path is no longer
    // exercised by any bundled methodology — file an issue to either
    // (a) add a fixture-based test that hits the empty-prompt path
    // directly, or (b) restore an empty placeholder somewhere bundled.
    const aiSteps = minimal.wrap_pipeline.steps.filter((s) => s.kind === 'ai-content');
    assert.ok(
      aiSteps.length > 0,
      'minimal template should still have at least one ai-content step'
    );
    for (const step of aiSteps) {
      assert.equal(
        step.prompt,
        '',
        `minimal/${step.id} should ship with empty prompt (placeholder semantics anchor)`
      );
    }
  });
});
