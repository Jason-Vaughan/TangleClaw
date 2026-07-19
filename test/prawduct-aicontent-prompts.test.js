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
const store = require('../lib/store');

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

    // #287: the structured block is parsed from a FILE, not the pane —
    // `capture-pane -p` strips the literal `##` that the TUI renders away,
    // so heading-parsing the pane never matched. The step must declare a
    // `captureFile` AND the prompt must instruct the AI to write the block
    // there; otherwise the handler falls back to the (broken-for-Claude)
    // pane path. Lockstep guard so neither half can drift away alone.
    assert.equal(step.captureFile, '.tangleclaw/.wrap-summary.md');
    assert.ok(
      step.prompt.includes(step.captureFile),
      'memory-update prompt must instruct the AI to write the block to its captureFile'
    );

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

describe('prawduct ai-content prompts — drift guards (Critic coverage gaps)', () => {
  const prawduct = JSON.parse(fs.readFileSync(PRAWDUCT_TEMPLATE_PATH, 'utf8'));

  it('every captureField on memory-update appears as a ## Heading literal in the prompt (lockstep)', () => {
    // If a future PR adds `risks` to captureFields without adding `## Risks`
    // to the prompt, every wrap silently blocks with "Required captureField
    // missing." This pins the forward direction.
    const step = prawduct.wrap_pipeline.steps.find((s) => s.id === 'memory-update');
    for (const field of step.captureFields) {
      // Build the expected heading using the field's original casing (the
      // matcher itself is case-insensitive, but our prompt convention uses
      // the camelCase / PascalCase form to match how the existing wrap-pipeline
      // tests fixture the AI response).
      const heading = `## ${field.charAt(0).toUpperCase()}${field.slice(1)}`;
      assert.ok(
        step.prompt.includes(heading),
        `captureField "${field}" not mentioned as "${heading}" literal in memory-update prompt`
      );
    }
  });

  it('every ## Heading other than ## Result corresponds to a captureField entry (inverse drift)', () => {
    // If a future PR adds `## Risks` to the prompt without adding `risks`
    // to captureFields, the AI emits a block the parser ignores and the
    // wrap commit subject deriver in _completeV2Wrap can't see it.
    const steps = prawduct.wrap_pipeline.steps.filter((s) => s.kind === 'ai-content');
    for (const step of steps) {
      // Pull every "## X" instructional heading from the prompt. Exclude the
      // free-form-step tail convention `## Result`. Exclude the in-body
      // YYYY-MM-DD heading convention from learnings-capture (it's the
      // *user's* heading they'll write to learnings.md, not a parser anchor).
      const matches = [...step.prompt.matchAll(/^## (\w[\w-]*)/gm)].map((m) => m[1]);
      const captureFields = step.captureFields || [];
      const expected = new Set(captureFields.map((f) => f.toLowerCase()));
      for (const heading of matches) {
        const norm = heading.toLowerCase();
        if (norm === 'result') continue; // free-form tail
        assert.ok(
          expected.has(norm),
          `step "${step.id}" prompt has "## ${heading}" but no matching captureField`
        );
      }
    }
  });

  it('every {...} token in a prawduct prompt is one the interpolator actually substitutes', () => {
    // Originally "no tokens at all", pinning a scope decision. The hazard it
    // guards is unchanged and is what matters: an UNRECOGNIZED token passes
    // through verbatim to the AI by design (so a misnamed token is visible
    // rather than silently blank), so shipping one in a bundled prompt is a
    // defect. Now that the interpolation surface has grown deliberately
    // (`{engineConfigFile}`, #612), assert membership against the
    // implementation's own list instead of banning tokens outright — a token
    // added to a prompt without being implemented still fails here.
    const { SUPPORTED_PROMPT_TOKENS } = require('../lib/wrap-steps/ai-content');
    const supported = new Set(SUPPORTED_PROMPT_TOKENS);
    const steps = prawduct.wrap_pipeline.steps.filter((s) => s.kind === 'ai-content');
    for (const step of steps) {
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

  it('_reconcileMergeBy preserves existing empty prompts on bundled-template reconcile (migration-note behavior pin)', () => {
    // The CHANGELOG migration note tells existing users their on-disk
    // template's empty `prompt: ""` survives reconcile. This pin grounds
    // the documented behavior so the recipe stays accurate.
    const bundledSteps = prawduct.wrap_pipeline.steps;
    // Simulate an existing on-disk template (live) with the same step ids
    // but empty prompts on the three ai-content steps.
    const liveSteps = bundledSteps.map((s) => {
      if (s.kind === 'ai-content') {
        return { ...s, prompt: '' };
      }
      return { ...s };
    });
    const result = store._reconcileMergeBy(liveSteps, bundledSteps, 'id');
    // null = no change — the reconciler did not append any new entries and
    // did not modify the existing ones. Per ADR 0001's additive-only
    // contract, the live empty prompts are preserved on boot.
    assert.equal(result, null, 'reconciler should return null (no change) when all step ids already exist on disk');
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
