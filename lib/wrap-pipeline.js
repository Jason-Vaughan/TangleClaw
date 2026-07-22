'use strict';

/**
 * #139 — Wrap pipeline runner.
 *
 * Runs the code-owned pipeline from `lib/wrap-default-pipeline.js` and
 * dispatches each step by `kind` to a handler in `lib/wrap-steps/`.
 * Single-transaction semantics per ADR 0002: server-side mutations stage
 * in `context.staged` and `context.results` until the `commit` step
 * flushes them to the project's git index. A `!ok` result from a
 * `blocker: true` step halts the pipeline immediately.
 *
 * This runner is the only wrap path: the legacy NL-prompt-via-tmux flow
 * (and its `projConfig.wrapV2` opt-out) was stripped after outliving its
 * documented one-release-cycle grace window.
 */

const { createLogger } = require('./logger');
const store = require('./store');
const wrapStepOverrides = require('./wrap-step-overrides');
const defaultPipeline = require('./wrap-default-pipeline');

const log = createLogger('wrap-pipeline');

/**
 * Dispatch table — maps a step `kind` to the handler module that runs it.
 * Adding a new step kind = a one-line entry here plus a sibling module
 * under `lib/wrap-steps/`. The contract for each handler:
 *
 *   `async function run(context) -> {ok, status, output, blockers}`
 *
 * Where `status` is one of `'done' | 'blocked' | 'skipped'` and
 * `blockers` is an array of human-readable blocker strings (used by the
 * UI in Chunk 10 to render the blocked-step UX).
 *
 * @type {Record<string, {run: (context: object) => Promise<object>}>}
 */
const STEP_DISPATCH = {
  'pr-check':     require('./wrap-steps/pr-check'),
  'pr-merge':     require('./wrap-steps/pr-merge'),
  'lint':         require('./wrap-steps/lint'),
  'test':         require('./wrap-steps/test'),
  'ai-content':   require('./wrap-steps/ai-content'),
  'learnings-db-write': require('./wrap-steps/learnings-db-write'),
  'rule-proposal': require('./wrap-steps/rule-proposal'),
  'priming-roll': require('./wrap-steps/priming-roll'),
  'version-bump': require('./wrap-steps/version-bump'),
  'features-toc': require('./wrap-steps/features-toc'),
  'project-map':  require('./wrap-steps/project-map'),
  'index-describe': require('./wrap-steps/index-describe'),
  'commit':       require('./wrap-steps/commit'),
  'continuity-write': require('./wrap-steps/continuity-write')
};

/**
 * Canonical no-op-shape result used by the runner whenever a step is
 * skipped without dispatching (e.g. unknown `kind`). Returning the
 * exact same shape every step handler returns keeps the
 * `previousResults` aggregation uniform for downstream consumers.
 * @type {{ok: boolean, status: string, output: null, blockers: string[]}}
 */
const SKIPPED_UNKNOWN_KIND = Object.freeze({
  ok: true,
  status: 'skipped',
  output: null,
  blockers: []
});

/**
 * The ordered ids of `ai-content`-kind steps whose prompt this wrap will send
 * to the session — the basis for each content prompt's self-identifying
 * "step N of M" header (#627).
 *
 * A step is counted only when it will actually prompt, so the denominator the
 * operator sees matches the prompts they see:
 *   - enabled — a step disabled by `wrapStepOverrides` never runs;
 *   - `kind === 'ai-content'` with a non-empty resolved prompt (an empty prompt
 *     is the pipeline author's self-skip marker);
 *   - not opted out for this run via `options.skipAiContent[id]` (honored only
 *     when the step declares `allowOverride`, matching the handler's own guard);
 *   - on a webui/gateway session, only a step carrying both `captureFields` and
 *     a `captureFile` prompts — the others honestly skip over the bridge, so
 *     counting them would inflate the total the operator sees.
 *
 * `index-describe` is deliberately absent: it emits its pane prompt by
 * delegating to the ai-content handler, but only when it has describable
 * targets — a fact decided at its own pipeline position, after the earlier
 * content prompts have already gone out under a fixed denominator. It cannot
 * join an accurate count, so it self-identifies with a numberless header
 * instead (`_wrapStepHeader` in `lib/wrap-steps/ai-content.js`).
 *
 * @param {object[]} pipelineSteps - The pipeline's base step specs, in run order
 * @param {object|null} stepOverrides - The project's `wrapStepOverrides` map
 * @param {object} options - Run options (reads `skipAiContent`)
 * @param {object|null} session - Active session (its `sessionMode` picks the path)
 * @returns {string[]} Ordered ids of the content steps that will prompt
 */
function _planAiContentPrompts(pipelineSteps, stepOverrides, options, session) {
  const isWebui = !!(session && session.sessionMode === 'webui');
  const skipMap = (options && options.skipAiContent) || {};
  const ids = [];
  for (const baseStep of pipelineSteps) {
    const resolution = wrapStepOverrides.resolveStep(baseStep, stepOverrides);
    if (!resolution.enabled) continue;
    const step = resolution.step;
    if (step.kind !== 'ai-content') continue;
    if (typeof step.prompt !== 'string' || step.prompt.trim() === '') continue;
    if (step.allowOverride === true && skipMap[step.id] === true) continue;
    if (isWebui) {
      const hasCapture = Array.isArray(step.captureFields)
        && step.captureFields.length > 0
        && typeof step.captureFile === 'string' && step.captureFile.trim() !== '';
      if (!hasCapture) continue;
    }
    ids.push(step.id);
  }
  return ids;
}

/**
 * Build a fresh runner context. Each invocation gets its own context so
 * concurrent wraps (a future possibility) cannot share scratch state.
 *
 * @param {object} project - Project record from `store.projects.getByName`
 * @param {object|null} session - Active Session record (may be null in tests)
 * @param {object} step - The step spec from `wrap_pipeline.steps[]`
 * @param {object} runState - Mutable run-level state (results so far, staged changes)
 * @param {object} options - Caller-supplied options forwarded from `runWrapPipeline`
 * @returns {object} Context object handed to the step handler's `run(context)`
 */
function _buildStepContext(project, session, step, runState, options) {
  return {
    project,
    session,
    step,
    // `previousResults` is a flat array of every prior step's result —
    // used by `summary-derive` (Chunk 5) to read `memory-update`'s output.
    previousResults: runState.results.slice(),
    // `staged` is the in-memory scratch space for server-side mutations
    // that have not yet been flushed to git. Steps that mutate the
    // working tree (e.g. the `priming-roll` step in Chunk 6) write here;
    // only the `commit` step in Chunk 9 reconciles `staged` against the
    // real filesystem.
    staged: runState.staged,
    // `options` is the caller-supplied control bag (e.g. `skipTests` when
    // the user clicked "skip tests" in the wrap UI). Handlers honor these
    // only when the step spec opts in (e.g. `step.allowOverride === true`
    // for the `test` step in Chunk 4). Frozen so handlers cannot mutate
    // shared caller state mid-pipeline.
    options
  };
}

/**
 * Run the wrap pipeline for a project. Returns a structured result the
 * frontend (Chunk 10) renders as the multi-step progress drawer.
 *
 * Pipeline semantics:
 *   - Steps run sequentially in declaration order.
 *   - A step's `blocker` field can be `true`, `false`, or an
 *     enum string (currently `"errors-only"` for `lint`). The runner
 *     halts the pipeline on `!ok` when `blocker === true` OR when
 *     `blocker === "errors-only"`. The handler is responsible for
 *     deciding what counts as an "error" in the enum case (e.g. lint
 *     `exitCode !== 0`) by returning `ok: false`; the runner then
 *     halts. `blocker === false` and any other falsy value never halt.
 *   - On block, every subsequent step is reported as `'pending'` in the
 *     result so the UI can show the user where the pipeline froze.
 *   - Steps with real handlers stage outputs in `context.staged` keyed
 *     by `step.id` (Chunk 5 `ai-content`, Chunk 6 `priming-roll`, and
 *     so on). The Chunk 9 `commit` step is the only step that flushes
 *     `staged` to the project's git index. A failed pipeline leaves
 *     `staged` populated but never reaches `commit`, so the working
 *     tree stays untouched.
 *
 * @param {string} projectName - Project name (lookup key into `store.projects`)
 * @param {object} [options] - Run options
 * @param {object} [options.session] - Override session record (used by tests to avoid tmux)
 * @param {boolean} [options.skipTests] - User opted to skip the `test` step (honored only when the step declares `allowOverride: true`); recorded in the wrap commit body
 * @param {(stepId: string, kind: string) => void} [options.onStepStart] - Progress
 *   hook invoked before each step dispatches (#583 — feeds the wrap-run
 *   registry so `GET /wrap/status` can report where a running wrap is).
 *   Skipped for steps reported `pending` after a halt (they never run).
 *   A throwing hook is swallowed — progress reporting must never be able
 *   to alter pipeline outcome.
 * @returns {Promise<{
 *   ok: boolean,
 *   blockedAt: string|null,
 *   results: Array<{stepId: string, kind: string, status: string, output: any, blockers: string[]}>,
 *   commitSha: string|null,
 *   summary: object|null,
 *   error: string|null
 * }>}
 */
async function runWrapPipeline(projectName, options = {}) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return _failResult(`Project "${projectName}" not found`);
  }

  const pipelineSteps = defaultPipeline.steps();

  const session = options.session
    || store.sessions.getActive(project.id)
    || null;

  const runState = { results: [], staged: {} };
  let blockedAt = null;

  // Per-project step overrides. Read once for the whole run so a config edit
  // landing mid-wrap cannot change the pipeline's shape between steps.
  // Advisory: a project with no readable config runs the default pipeline unmodified,
  // which is the pre-override behavior.
  let stepOverrides = null;
  try {
    stepOverrides = (store.projectConfig.load(project.path) || {}).wrapStepOverrides || null;
  } catch (err) { // prawduct:allow prawduct/broad-except -- the wrap must still run for a project whose config is unreadable; the failure is reported rather than swallowed
    log.warn('project config unreadable — running the wrap pipeline with no step overrides', {
      project: projectName,
      error: err.message
    });
    stepOverrides = null;
  }

  // Ordered ids of the content prompts this wrap will send, so each can carry a
  // self-identifying "step N of M" header (#627). Computed once, before the
  // loop, because the denominator must be known when the FIRST prompt fires.
  const aiContentPlan = _planAiContentPrompts(pipelineSteps, stepOverrides, options, session);

  for (const baseStep of pipelineSteps) {
    if (blockedAt !== null) {
      runState.results.push({
        stepId: baseStep.id,
        kind: baseStep.kind,
        status: 'pending',
        output: null,
        blockers: []
      });
      continue;
    }

    const resolution = wrapStepOverrides.resolveStep(baseStep, stepOverrides);
    const step = resolution.step;

    if (resolution.rejected.length > 0) {
      // Not silently ignored: an operator who configured a field that does
      // nothing needs a reason it did nothing, and the step still runs.
      log.warn('ignoring non-overridable wrap step override field(s)', {
        project: projectName,
        stepId: step.id,
        fields: resolution.rejected.join(', ')
      });
    }

    if (!resolution.enabled) {
      // A disabled step reports a skip rather than vanishing from the run.
      // A step absent from the results reads as a pipeline that never had it,
      // which is how a wrap ends up claiming work it did not do.
      log.info('wrap step disabled by project config', { project: projectName, stepId: step.id });
      const reason = 'disabled for this project in wrap step settings';
      runState.results.push({
        stepId: step.id,
        kind: step.kind,
        status: 'skipped',
        output: { reason, detail: reason },
        blockers: []
      });
      continue;
    }

    if (typeof options.onStepStart === 'function') {
      try {
        options.onStepStart(step.id, step.kind);
      } catch (err) { // prawduct:allow prawduct/broad-except -- progress hook must never alter pipeline outcome; error is logged, not swallowed silently
        log.warn('onStepStart hook threw — continuing pipeline', { project: projectName, stepId: step.id, error: err.message });
      }
    }

    const handler = STEP_DISPATCH[step.kind];
    let stepResult;
    if (!handler) {
      log.warn('Unknown wrap step kind — skipping', { project: projectName, stepId: step.id, kind: step.kind });
      stepResult = { ...SKIPPED_UNKNOWN_KIND };
    } else {
      const context = _buildStepContext(project, session, step, runState, options);
      // #627 — a fixed content step carries its position so the handler can
      // prepend a "step N of M" header. Ordinal follows run order because the
      // plan was built in run order. Steps absent from the plan (including
      // `index-describe`, which delegates to the handler) get no progress and
      // the handler falls back to a numberless self-identifying header.
      const planIdx = aiContentPlan.indexOf(step.id);
      if (planIdx >= 0) {
        context.aiContentProgress = { ordinal: planIdx + 1, total: aiContentPlan.length };
      }
      try {
        stepResult = await handler.run(context);
      } catch (err) {
        log.error('Step handler threw', { project: projectName, stepId: step.id, kind: step.kind, error: err.message });
        // Throws record as `status:'blocked'` regardless of the step's
        // `blocker` field — the step's own outcome was unsuccessful — but
        // the pipeline-halt check below still respects `step.blocker ===
        // true`. So a thrown error on a `blocker:false` step leaves
        // `blockedAt: null` (pipeline `ok: true`) even though the step's
        // result reads `status: 'blocked'`. Aggregators wanting "did the
        // pipeline halt?" must check `blockedAt`, not scan
        // `results[].status` (#139 Chunk 3 Critic nit).
        stepResult = {
          ok: false,
          status: 'blocked',
          output: null,
          blockers: [`${step.kind} threw: ${err.message}`]
        };
      }
    }

    runState.results.push({
      stepId: step.id,
      kind: step.kind,
      status: stepResult.status,
      output: stepResult.output,
      blockers: stepResult.blockers || []
    });

    // Blocker semantics:
    //   - `blocker === true`   → halt on any !ok
    //   - `blocker === "errors-only"` → halt on !ok (handler decides
    //                                    when "errors" tripped, by
    //                                    returning ok:false). Lint uses
    //                                    this to distinguish errors
    //                                    (exit ≠ 0 → ok:false) from
    //                                    warnings (exit 0 → ok:true).
    //   - anything else (false, undefined, ...) → never halt
    if ((step.blocker === true || step.blocker === 'errors-only') && !stepResult.ok) {
      blockedAt = step.id;
    }
  }

  // Read commitSha from the commit step's output (Chunk 9). The runner
  // doesn't hardcode the step ID — any step whose result `output`
  // exposes a string `commitSha` populates the top-level field, so a
  // future pipeline with a renamed commit step still surfaces the
  // SHA without a runner edit. On a pipeline that halted before
  // reaching commit, or on a clean session that skipped commit, this
  // stays `null`.
  let commitSha = null;
  for (const r of runState.results) {
    if (r.output && typeof r.output.commitSha === 'string' && r.output.commitSha) {
      commitSha = r.output.commitSha;
      break;
    }
  }

  return {
    ok: blockedAt === null,
    blockedAt,
    results: runState.results,
    commitSha,
    // Filled by the `summary-derive` ai-content step in Chunk 5; null until then.
    summary: null,
    error: null
  };
}

/**
 * Build a fail-fast result for the runner's preflight errors (missing
 * project, schema absent). Returns the same shape
 * as a successful run so the frontend doesn't need to special-case the
 * preflight-failure path.
 * @param {string} error - Human-readable preflight failure reason
 * @returns {object}
 */
function _failResult(error) {
  return {
    ok: false,
    blockedAt: null,
    results: [],
    commitSha: null,
    summary: null,
    error
  };
}

module.exports = {
  runWrapPipeline,
  STEP_DISPATCH,
  _planAiContentPrompts
};
