'use strict';

/**
 * Per-project wrap step overrides.
 *
 * The wrap pipeline is code-owned (`lib/wrap-default-pipeline.js`) and shared
 * by every project; a project cannot edit the shipped step list. Overrides
 * live in the project's own `.tangleclaw/project.json`, the one config surface
 * that is entirely project-owned. The split mirrors the one already drawn
 * for session rules: `rules.core` is framework-owned and force-reset, while
 * `rules.extensions` is project-owned and preserved.
 *
 * ## What a project may change, and what it may not
 *
 * A project may DISABLE a step and RECONFIGURE an allow-listed field. It may
 * not add, remove, or reorder steps — order and membership stay framework-
 * owned, because wrap step order carries correctness contracts between steps
 * (the changelog must be written before the version bump reads it to choose a
 * level, and both before the commit that flushes them). Those contracts are
 * pinned by one test against the shipped pipeline; if projects could reorder,
 * each project would need its own pin and the guarantee would quietly become
 * per-project.
 *
 * The allow-list is a correctness boundary, not a convenience. `verifyChanged`
 * is deliberately excluded: it names the files a content step must actually
 * have changed for the step to count as done, and emptying it would leave the
 * verification reporting success while checking nothing — the precise failure
 * this verification was built to end. `id` and `kind` are excluded because
 * overriding them is add/remove wearing a different hat. `captureFile` and
 * `captureFields` are excluded because other subsystems read a step's captured
 * fields by name, so a project changing them breaks a contract it can't see.
 *
 * `coveragePaths` IS overridable, and the reason it is safe where `verifyChanged`
 * is not is direction: it can only WIDEN what the `changelog-coverage` predicate
 * accepts, never narrow it. A monorepo keeps a changelog per package, so a commit
 * logging its change to a nested file should satisfy the gate — the project
 * declares those paths (globs) here. An over-broad value can waive the gate, but
 * only as visibly as `blocker:false` already can; it cannot make the gate report
 * success on a commit that touched no changelog at all, which is the failure an
 * emptied `verifyChanged` would produce.
 *
 * ## Relationship to the dedicated effect toggles
 *
 * `releaseMode`, `featureIndexEnabled`, and `projectMapEnabled` are separate from this map and
 * remain the surfaced settings for those three steps. They are independent gates,
 * not competing ones: each is checked by its own step at run time, while this map
 * is resolved by the runner before dispatch, so either switch turning a step off
 * is sufficient and there is no precedence to reason about. Prefer the dedicated
 * toggle where one exists.
 *
 * ## Disabling one step cannot silently corrupt another
 *
 * Steps do read each other's output, so "can I turn this off?" is really "what
 * happens to whatever depended on it?". The sharp case is disabling
 * `changelog-update` while `version-bump` stays on, since the bump derives its
 * level from the changelog the disabled step would have written. That degrades
 * honestly rather than silently: `version-bump` treats an empty `[Unreleased]`
 * as one of its skip conditions and reports a reason, so the wrap shows a
 * skipped bump instead of promoting a release off a changelog nobody updated.
 * The general property this rests on is that steps already skip visibly when
 * their inputs are absent — a step that instead assumed its predecessor ran
 * would need its own guard, not a rule in this file.
 *
 * `blocker` IS overridable, and the difference from `verifyChanged` is
 * honesty rather than strength: a non-blocking step still runs, still
 * verifies, and still reports `ok:false` in the drawer — it just stops halting
 * the pipeline. The operator sees what happened. An emptied `verifyChanged`
 * reports success. An escape valve that stays visible is a legitimate
 * configuration; one that hides itself is a defect.
 */

/**
 * Step kinds that may not be disabled, and why.
 *
 * The wrap stages its file writes in memory and flushes them in one place; the
 * `commit` step is that place. Disabling it does not produce a wrap that
 * skips committing — it produces a wrap where every earlier step reports
 * having written a changelog entry, a version bump, and a priming roll, and
 * none of it reaches disk. That is the report-success-without-doing-it failure
 * the wrap's verification exists to end, so it is refused rather than
 * documented.
 *
 * Keyed by `kind` rather than `id` because `kind` is the dispatch key: a
 * pipeline variant that renames its commit step still can't disable the flush.
 * @type {Set<string>}
 */
const UNDISABLEABLE_KINDS = new Set(['commit']);

/**
 * Step fields a project may override, and the predicate each value must
 * satisfy. Anything absent from this map is framework-owned.
 * @type {Record<string, (value: *) => boolean>}
 */
const OVERRIDABLE_FIELDS = Object.freeze({
  // `false` disables the step outright; the runner records an honest skip.
  enabled: (v) => typeof v === 'boolean',
  // Matches the runner's halt semantics: `true` and `'errors-only'` halt on
  // a failed step, anything else never halts.
  blocker: (v) => v === true || v === false || v === 'errors-only',
  // Per-project wording for an `ai-content` step's instruction. An empty
  // string self-skips the step, which is already how the templates express
  // "this pipeline doesn't do this step". A non-empty override on an
  // `ai-content` step is run through `applyPromptOverride` by `resolveStep`,
  // which keeps the bundled `Verification: ...` contract paragraph present
  // and current rather than letting a project's own wording drop or stale it
  // (#660).
  prompt: (v) => typeof v === 'string',
  // Additional changelog paths (globs) the `changelog-coverage` predicate accepts,
  // for monorepos that keep a changelog per package. Additive only — see the
  // header. An array of non-empty strings; inert on steps without that predicate.
  coveragePaths: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim().length > 0)
});

/**
 * Validate a `wrapStepOverrides` map.
 *
 * Applied by the settings API before persisting. It is deliberately NOT the
 * only guard: `resolveStep` re-checks every field at the point of use, because
 * a hand-edited `.tangleclaw/project.json` never passes through the API.
 *
 * @param {*} overrides - Candidate `wrapStepOverrides` value
 * @param {object[]} [steps] - The pipeline's steps, when the
 *   caller can resolve them. Supplying them lets the undisableable-kind rule be
 *   reported at save time instead of only taking effect at wrap time; omitting
 *   them checks shape and fields only.
 * @returns {{ok: boolean, error: string|null}} `ok:false` carries an
 *   operator-readable reason naming the offending step and field
 */
function validateOverrides(overrides, steps) {
  if (overrides === null || overrides === undefined) return { ok: true, error: null };
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, error: 'wrapStepOverrides must be an object keyed by step id' };
  }

  for (const [stepId, override] of Object.entries(overrides)) {
    if (typeof override !== 'object' || override === null || Array.isArray(override)) {
      return { ok: false, error: `wrapStepOverrides.${stepId} must be an object` };
    }
    for (const [field, value] of Object.entries(override)) {
      const predicate = OVERRIDABLE_FIELDS[field];
      if (!predicate) {
        return {
          ok: false,
          error: `wrapStepOverrides.${stepId}.${field} is not overridable `
            + `(allowed: ${Object.keys(OVERRIDABLE_FIELDS).join(', ')})`
        };
      }
      if (!predicate(value)) {
        return { ok: false, error: `wrapStepOverrides.${stepId}.${field} has an invalid value` };
      }
      if (field === 'enabled' && value === false && Array.isArray(steps)) {
        const target = steps.find((s) => s && s.id === stepId);
        if (target && UNDISABLEABLE_KINDS.has(target.kind)) {
          return {
            ok: false,
            error: `wrapStepOverrides.${stepId} cannot be disabled — a "${target.kind}" step is `
              + `the only thing that writes the wrap's staged changes to disk, so turning it off `
              + `would make every other step report work that never lands`
          };
        }
      }
    }
  }
  return { ok: true, error: null };
}

/**
 * Extract the framework-owned `Verification: ...` paragraph from a step prompt.
 *
 * Paragraphs are separated by a blank line (`\n\n`), the wrap's own template
 * convention — not markdown structure. The contract paragraph is found by its
 * literal `Verification:` prefix, scanned from the end, rather than by assuming
 * it is always the LAST paragraph: some bundled prompts (e.g. `learnings-
 * capture`) put a short closing instruction after it (#660).
 *
 * @param {string} prompt - A step's prompt text.
 * @returns {string|null} The `Verification: ...` paragraph verbatim, or null
 *   when the prompt carries no such paragraph.
 */
function extractVerificationContract(prompt) {
  if (typeof prompt !== 'string') return null;
  const paragraphs = prompt.split('\n\n');
  for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
    if (paragraphs[i].startsWith('Verification:')) return paragraphs[i];
  }
  return null;
}

/**
 * Apply a project's prompt override to a bundled `ai-content` step prompt,
 * keeping the framework-owned `Verification: ...` contract paragraph current.
 *
 * The override replaces the bundled instructions wholesale — a project
 * rewrites its own conventions freely — but the trailing verification
 * contract is not the project's to silently drop or let go stale: it is what
 * the wrap's own gate (`lib/wrap-steps/ai-content.js` `_verifyChangedGate`)
 * checks the step's output against (#660). Three cases:
 *   - The override carries NO `Verification:` paragraph (project conventions
 *     only): append the bundled one.
 *   - The override's `Verification:` paragraph differs from the bundled one
 *     (an older copy pasted in, now stale): replace it in place with the
 *     current bundled paragraph.
 *   - The override's paragraph already matches the bundled one: leave the
 *     prompt untouched, so a verbatim override is never duplicated.
 *
 * @param {string} bundledPrompt - The framework-shipped step prompt.
 * @param {string} overridePrompt - The project's override prompt. Expected
 *   non-empty — `""` self-skips the step upstream of this function (in
 *   `resolveStep`) and must never reach it.
 * @returns {{prompt: string, promptContractUpdated: boolean}} The resolved
 *   prompt, and whether the contract paragraph was added or replaced. `false`
 *   when it already matched, or the bundled prompt carries no contract to
 *   enforce (a step with no `Verification:` paragraph of its own).
 */
function applyPromptOverride(bundledPrompt, overridePrompt) {
  const bundledContract = extractVerificationContract(bundledPrompt);
  if (!bundledContract) return { prompt: overridePrompt, promptContractUpdated: false };

  const paragraphs = overridePrompt.split('\n\n');
  let contractIndex = -1;
  for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
    if (paragraphs[i].startsWith('Verification:')) {
      contractIndex = i;
      break;
    }
  }

  if (contractIndex === -1) {
    return {
      prompt: `${overridePrompt.replace(/\n+$/, '')}\n\n${bundledContract}`,
      promptContractUpdated: true
    };
  }

  if (paragraphs[contractIndex] === bundledContract) {
    return { prompt: overridePrompt, promptContractUpdated: false };
  }

  paragraphs[contractIndex] = bundledContract;
  return { prompt: paragraphs.join('\n\n'), promptContractUpdated: true };
}

/**
 * Apply a project's overrides to one template step.
 *
 * Fields outside the allow-list are dropped rather than rejected: this runs
 * mid-wrap, where refusing to wrap because a stale config carries an unknown
 * key would be worse than ignoring the key. Each drop is reported to the
 * caller so it can be logged rather than swallowed.
 *
 * An override keyed to a step id the pipeline doesn't contain is inert —
 * it is not an error, because a project may legitimately carry overrides for
 * a step a later framework version renames or retires.
 *
 * A `prompt` override on an `ai-content` step is special-cased: an empty
 * string (`""`) self-skips the step as before, but a non-empty override is
 * run through {@link applyPromptOverride} first, so the project's wording
 * never silently loses the framework's verification contract (#660).
 *
 * @param {object} step - Step spec from `wrap_pipeline.steps[]` (never mutated)
 * @param {object|null|undefined} overrides - Full `wrapStepOverrides` map
 * @returns {{step: object, enabled: boolean, applied: string[], rejected: string[]}}
 */
function resolveStep(step, overrides) {
  const empty = { step, enabled: true, applied: [], rejected: [] };
  if (!overrides || typeof overrides !== 'object') return empty;

  const override = overrides[step.id];
  if (!override || typeof override !== 'object' || Array.isArray(override)) return empty;

  const resolved = { ...step };
  const applied = [];
  const rejected = [];
  let enabled = true;

  for (const [field, value] of Object.entries(override)) {
    const predicate = OVERRIDABLE_FIELDS[field];
    if (!predicate || !predicate(value)) {
      rejected.push(field);
      continue;
    }
    if (field === 'enabled') {
      if (value === false && UNDISABLEABLE_KINDS.has(step.kind)) {
        rejected.push(field);
        continue;
      }
      enabled = value;
      // `enabled` is a runner-level decision, not part of the step spec the
      // handler receives — keep it off the resolved step so no handler can
      // start reading it as a second, competing switch.
      applied.push(field);
      continue;
    }
    if (field === 'prompt' && step.kind === 'ai-content' && value.trim().length > 0) {
      const { prompt, promptContractUpdated } = applyPromptOverride(step.prompt, value);
      resolved.prompt = prompt;
      if (promptContractUpdated) resolved.promptContractUpdated = true;
      applied.push(field);
      continue;
    }
    resolved[field] = value;
    applied.push(field);
  }

  return { step: resolved, enabled, applied, rejected };
}

module.exports = {
  OVERRIDABLE_FIELDS,
  UNDISABLEABLE_KINDS,
  validateOverrides,
  resolveStep,
  extractVerificationContract,
  applyPromptOverride
};
