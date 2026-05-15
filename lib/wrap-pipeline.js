'use strict';

/**
 * #139 — Wrap pipeline runner.
 *
 * Reads `wrap_pipeline.steps[]` from the project's methodology template
 * and dispatches each step by `kind` to a handler in `lib/wrap-steps/`.
 * Single-transaction semantics per ADR 0002: server-side mutations stage
 * in `context.staged` and `context.results` until the `commit` step (in
 * Chunk 9) flushes them to the project's git index. A `!ok` result from
 * a `blocker: true` step halts the pipeline immediately.
 *
 * **Chunk 3 (this file) ships the runner skeleton only.** Every step
 * dispatches to a no-op stub returning `{ok:true, status:'done',
 * output:null, blockers:[]}`. Real implementations land in Chunks 4–9.
 *
 * Opt-in: `projConfig.wrapV2` (defaults `false`). While `false`,
 * `lib/sessions.js:triggerWrap` runs the legacy NL-prompt path
 * byte-equal to pre-#139 behavior. Chunk 11 flips the default.
 */

const { createLogger } = require('./logger');
const store = require('./store');

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
  'lint':         require('./wrap-steps/lint'),
  'test':         require('./wrap-steps/test'),
  'critic-check': require('./wrap-steps/critic-check'),
  'ai-content':   require('./wrap-steps/ai-content'),
  'priming-roll': require('./wrap-steps/priming-roll'),
  'version-bump': require('./wrap-steps/version-bump'),
  'commit':       require('./wrap-steps/commit')
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
 *   - The runner is transactionally inert in Chunk 3: stubs never
 *     mutate `staged`, so a partial run leaves no trace.
 *
 * @param {string} projectName - Project name (lookup key into `store.projects`)
 * @param {object} [options] - Run options
 * @param {object} [options.session] - Override session record (used by tests to avoid tmux)
 * @param {boolean} [options.skipTests] - User opted to skip the `test` step (honored only when the step declares `allowOverride: true`); recorded in the wrap commit body
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

  const template = store.templates.get(project.methodology);
  if (!template) {
    return _failResult(`Methodology "${project.methodology}" not found for project "${projectName}"`);
  }

  const pipeline = template.wrap_pipeline;
  if (!pipeline || !Array.isArray(pipeline.steps)) {
    return _failResult(
      `Methodology "${project.methodology}" has no wrap_pipeline.steps; ` +
      `cannot run V2 wrap. Set projConfig.wrapV2=false to use the legacy path.`
    );
  }

  const session = options.session
    || store.sessions.getActive(project.id)
    || null;

  const runState = { results: [], staged: {} };
  let blockedAt = null;

  for (const step of pipeline.steps) {
    if (blockedAt !== null) {
      runState.results.push({
        stepId: step.id,
        kind: step.kind,
        status: 'pending',
        output: null,
        blockers: []
      });
      continue;
    }

    const handler = STEP_DISPATCH[step.kind];
    let stepResult;
    if (!handler) {
      log.warn('Unknown wrap step kind — skipping', { project: projectName, stepId: step.id, kind: step.kind });
      stepResult = { ...SKIPPED_UNKNOWN_KIND };
    } else {
      const context = _buildStepContext(project, session, step, runState, options);
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

  return {
    ok: blockedAt === null,
    blockedAt,
    results: runState.results,
    // Filled by the `commit` step in Chunk 9; null until then.
    commitSha: null,
    // Filled by the `summary-derive` ai-content step in Chunk 5; null until then.
    summary: null,
    error: null
  };
}

/**
 * Build a fail-fast result for the runner's preflight errors (missing
 * project, missing methodology, schema absent). Returns the same shape
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
  STEP_DISPATCH
};
