'use strict';

/**
 * `pr-merge` wrap step (#570) — applies the PR resolutions the `pr-check`
 * gate collected, by enqueueing GitHub auto-merge for every PR the operator
 * resolved as `merge`.
 *
 * **Why this is a separate step from the gate.** The two halves have opposite
 * ordering requirements. The gate must run EARLY: it blocks on an undecided
 * PR, and blocking is only cheap before the AI-content steps have prompted
 * the session and before `commit` has landed. The merge must run LATE: it
 * merges the PR that the wrap commit belongs to, so enqueueing it before
 * `commit` would merge a PR missing that commit — and `--delete-branch` could
 * delete the branch mid-wrap. One step cannot be both first and last, so the
 * decision is gated up front and applied at the end.
 *
 * **Running after `commit` is necessary but NOT sufficient — the commit has
 * to be PUSHED.** `commit` only pushes on the auto-branch path (wrapping on
 * `main`/`master`), and a session-scoped PR is by definition on a feature
 * branch, which is exactly the path where the wrap commit stays local. So
 * enqueueing auto-merge on a wrap-committed-but-unpushed branch merges a PR
 * that does not contain the wrap commit — the version bump and CHANGELOG
 * promotion never reach the base branch and `--delete-branch` strands the
 * local commit with no upstream. That is the #447/#450/#453 dangling-wrap
 * class arriving through a different door. This step therefore pushes the
 * branch first, and if the push fails it enqueues nothing: a stale PR is a
 * far cheaper outcome than a merged-but-incomplete one.
 *
 * **This step never blocks.** It runs after `commit`, so a halt here would
 * strand the wrap half-finished — the commit landed, the session's AI steps
 * already fired, but the pipeline reports failure and the session lifecycle
 * never completes. A failed enqueue is also not something a retry fixes
 * (auto-merge disabled on the repo, a closed PR): it needs the operator to
 * act on GitHub. So a failure surfaces as `output.warning` with remediation
 * and the wrap completes honestly, rather than trading a stale PR for a
 * stranded session.
 *
 * **Input.** Duck-typed on the staged shape `{resolutions, sessionScoped}`
 * rather than keyed to the gate's step id, so a template that renames its
 * gate step still feeds this one.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logger');
const { execShell, execFileArgs } = require('../exec');
const { reasonFromFailure } = require('../remote-output');
const projectConfig = require('../project-config');
const { configRootOf } = require('./_config-root');

const log = createLogger('wrap-step-pr-merge');

const EXEC_TIMEOUT_MS = 60 * 1000;
const MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * The `gh pr merge` flags a wrap run may use (#1172). Frozen so a stray
 * typo elsewhere in this module cannot silently widen what `gh` is handed.
 */
const VALID_MERGE_METHODS = Object.freeze(['squash', 'merge', 'rebase']);

/**
 * `--squash` when nothing else says otherwise — preserves the behavior
 * every call site had before #1172, so existing wraps keep working
 * unconfigured.
 */
const DEFAULT_MERGE_METHOD = 'squash';

const PROJECT_PREFERENCES_REL = path.join('.prawduct', 'artifacts', 'project-preferences.md');

/**
 * The project-preferences.md row format this reads: a list item whose bold
 * label is exactly `PR merge strategy`, followed by its stated value.
 */
const PREFERENCES_ROW_RE = /^[-*]\s*\*\*PR merge strategy\*\*:\s*(.+)$/im;

/**
 * Pull a `PR merge strategy` governance preference out of
 * `.prawduct/artifacts/project-preferences.md`, when the project has one —
 * the row's STATED VALUE only, never the surrounding rationale prose.
 *
 * That distinction matters because the row's own rationale routinely names
 * every OTHER merge method too (e.g. a `merge commit` row's explanation says
 * "a squash rewrites the branch..." and "Never fall back to `--squash`..."),
 * so a scan for "does this row's text contain the word squash/rebase/merge
 * anywhere" can match the wrong word — found a false `squash` on a row whose
 * actual, stated value is `merge commit`. Anchoring to the label and reading
 * only the text up to the first sentence boundary or inline code span (an
 * em dash, a backtick, or a period) isolates the stated value from that
 * prose before any keyword is matched.
 *
 * @param {string} projectPath
 * @returns {string|null} one of VALID_MERGE_METHODS when the stated value
 *   names one (matched by its leading word, since the file writes prose
 *   like `"merge commit"` rather than the bare keyword `"merge"`); the raw
 *   stated value, lowercased and trimmed, when it names none — so the
 *   caller can warn with the actual text instead of a generic message;
 *   null when the file is unreadable or has no such row at all.
 */
function _readPreferencesMergeStrategy(projectPath) {
  let text;
  try {
    text = fs.readFileSync(path.join(projectPath, PROJECT_PREFERENCES_REL), 'utf8');
  } catch (_) {
    return null;
  }
  const m = PREFERENCES_ROW_RE.exec(text);
  if (!m) return null;
  const value = m[1].split(/[—`.]/)[0].trim().toLowerCase();
  if (!value) return null;
  const known = VALID_MERGE_METHODS.find((method) => value.startsWith(method));
  return known || value;
}

/**
 * Resolve which `gh pr merge` flag a wrap run should pass for this project
 * (#1172) — `"squash"`, `"merge"` or `"rebase"`.
 *
 * Precedence: an explicit caller option, then `.tangleclaw/project.json`'s
 * `wrapMergeMethod`, then a `PR merge strategy` row in
 * `.prawduct/artifacts/project-preferences.md`, then `DEFAULT_MERGE_METHOD`.
 * An unrecognized value at any source falls back to the default with a
 * warning rather than throwing — a typo in a config string should never
 * crash a wrap.
 *
 * @param {string} projectPath
 * @param {object} [options]
 * @param {string} [options.wrapMergeMethod] - Explicit override, checked first.
 * @param {string} [options.mergeMethod] - Alias for `wrapMergeMethod`.
 * @param {object} [options.projectConfig] - Pre-loaded `.tangleclaw/project.json`
 *   config; skips re-reading it from disk when the caller already has one.
 * @returns {{method: string, source: ('explicit'|'project-config'|'project-preferences'|'default'), warning: (string|null)}}
 */
function resolveWrapMergeMethod(projectPath, options = {}) {
  const explicit = options.wrapMergeMethod || options.mergeMethod;
  if (explicit) {
    if (VALID_MERGE_METHODS.includes(explicit)) {
      return { method: explicit, source: 'explicit', warning: null };
    }
    return {
      method: DEFAULT_MERGE_METHOD,
      source: 'default',
      warning: `unrecognized wrap merge method "${explicit}" — falling back to "${DEFAULT_MERGE_METHOD}"`
    };
  }

  const cfg = options.projectConfig || (projectPath ? projectConfig.load(projectPath) : null);
  const configured = cfg && cfg.wrapMergeMethod;
  if (configured) {
    if (VALID_MERGE_METHODS.includes(configured)) {
      return { method: configured, source: 'project-config', warning: null };
    }
    return {
      method: DEFAULT_MERGE_METHOD,
      source: 'default',
      warning: `unrecognized wrapMergeMethod "${configured}" in .tangleclaw/project.json — falling back to "${DEFAULT_MERGE_METHOD}"`
    };
  }

  const preferred = projectPath ? _readPreferencesMergeStrategy(projectPath) : null;
  if (preferred) {
    if (VALID_MERGE_METHODS.includes(preferred)) {
      return { method: preferred, source: 'project-preferences', warning: null };
    }
    return {
      method: DEFAULT_MERGE_METHOD,
      source: 'default',
      warning: `unrecognized PR merge strategy "${preferred}" in .prawduct/artifacts/project-preferences.md — falling back to "${DEFAULT_MERGE_METHOD}"`
    };
  }

  return { method: DEFAULT_MERGE_METHOD, source: 'default', warning: null };
}

/**
 * This step's git runner: the shared argv-style runner plus this step's caps.
 *
 * The caps are overridable ONLY so a guard can drive the timeout path in
 * milliseconds instead of waiting out the real minute; production callers pass
 * neither. Without that seam the mapping from a real kill to `timedOut` is
 * unreachable by any test, which is where this defect lived (#897).
 *
 * @param {string} file
 * @param {string[]} args
 * @param {object} options
 * @param {string} options.cwd
 * @param {number} [options.timeoutMs] - Test seam; defaults to EXEC_TIMEOUT_MS.
 * @param {number} [options.maxBufferBytes] - Test seam; defaults to MAX_BUFFER_BYTES.
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string,
 *   error:string|null, timedOut:boolean}>}
 */
function defaultExec(file, args, options) {
  return execFileArgs(file, args, {
    cwd: options.cwd,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : EXEC_TIMEOUT_MS,
    maxBufferBytes: Number.isFinite(options.maxBufferBytes)
      ? options.maxBufferBytes : MAX_BUFFER_BYTES
  });
}

/**
 * Shell-form runner for the `gh` calls, which are composed as command strings.
 * Same never-throw contract as `defaultExec`; separate because git is invoked
 * argv-style and gh is not.
 *
 * @param {string} command
 * @param {object} options
 * @param {string} options.cwd
 * @param {number} [options.timeoutMs] - Test seam; defaults to EXEC_TIMEOUT_MS.
 * @param {number} [options.maxBufferBytes] - Test seam; defaults to MAX_BUFFER_BYTES.
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string,
 *   error:string|null, timedOut:boolean}>}
 */
function defaultExecShell(command, options) {
  return execShell(command, {
    cwd: options.cwd,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : EXEC_TIMEOUT_MS,
    maxBufferBytes: Number.isFinite(options.maxBufferBytes)
      ? options.maxBufferBytes : MAX_BUFFER_BYTES
  });
}

/**
 * Enqueue GitHub's server-side auto-merge for one PR:
 * `gh pr merge <n> --auto --${mergeMethod} --delete-branch`.
 *
 * Auto-merge rather than an immediate merge is deliberate. Branch
 * protection and required checks still gate the merge — GitHub lands it
 * once they pass — so a wrap can resolve its PR without either waiting
 * for CI or forcing a merge over red checks. The merge method itself is
 * resolved by `resolveWrapMergeMethod` (#1172), defaulting to `--squash`
 * when the project configures nothing.
 *
 * Returns a structured outcome rather than throwing; the caller decides
 * whether a failure blocks. A repo with auto-merge disabled makes `gh`
 * exit non-zero with actionable text, which is surfaced verbatim.
 *
 * @param {string} cwd
 * @param {number|string} prNumber
 * @param {string} [mergeMethod] - One of VALID_MERGE_METHODS; defaults to DEFAULT_MERGE_METHOD.
 * @returns {Promise<{ok:boolean, reason:string|null}>}
 */
async function defaultEnqueueAutoMerge(cwd, prNumber, mergeMethod = DEFAULT_MERGE_METHOD) {
  // The number reaches here having been matched against a `gh pr list`
  // result, so it is already a PR number — but it is interpolated into a
  // shell string, and "already validated upstream" is exactly the
  // assumption that ages badly. Re-assert it at the point of use.
  if (!/^\d+$/.test(String(prNumber))) {
    return { ok: false, reason: `refusing to run gh with a non-numeric PR id: ${prNumber}` };
  }
  const flag = VALID_MERGE_METHODS.includes(mergeMethod) ? mergeMethod : DEFAULT_MERGE_METHOD;
  const r = await _internal.execShell(
    `gh pr merge ${prNumber} --auto --${flag} --delete-branch`,
    { cwd }
  );
  if (r.exitCode === 0) return { ok: true, reason: null };
  // A stopped request is not a refused one. `gh` prints nothing when we kill
  // it, so the raw fallback here used to render as a bare "exit 1" — which
  // reads as GitHub declining the request, when in fact the request may have
  // reached GitHub and armed auto-merge. Say that it is unknown, and where to
  // look (#897).
  if (r.timedOut) {
    return {
      ok: false,
      reason: `the request was stopped before it answered (${r.error || 'timed out'}) — auto-merge may or may not have been armed; check PR #${prNumber} before merging by hand`
    };
  }
  return { ok: false, reason: reasonFromFailure(r) };
}

/**
 * Enqueue auto-merge for each `merge` resolution, in ascending PR order so
 * a partial failure is reproducible.
 * `defer` and `ignore` are recorded-only by definition — the operator
 * has said "not now" / "not mine," and acting on either would be the
 * step overriding a decision it just collected.
 *
 * @param {string} cwd
 * @param {Record<string,string>} resolutions - Validated `{prNumber: handling}`
 * @param {string} [mergeMethod] - One of VALID_MERGE_METHODS; defaults to DEFAULT_MERGE_METHOD.
 * @returns {Promise<{applied: Record<string,object>, failures: string[]}>}
 */
async function _applyResolutions(cwd, resolutions, mergeMethod = DEFAULT_MERGE_METHOD) {
  const applied = {};
  const failures = [];
  const merges = Object.keys(resolutions)
    .filter((n) => resolutions[n] === 'merge')
    .sort((a, b) => Number(a) - Number(b));
  for (const number of merges) {
    // Caught per PR, not around the loop: once an earlier enqueue has
    // succeeded the remote is already mutated, and a throw on a later one
    // must not discard that record by unwinding to the handler's outer
    // catch — the operator needs to know what did happen, not just that
    // something failed.
    let outcome;
    try {
      outcome = await _internal.enqueueAutoMerge(cwd, number, mergeMethod);
    } catch (err) {
      outcome = { ok: false, reason: `auto-merge threw: ${err.message}` };
    }
    applied[number] = { handling: 'merge', ok: outcome.ok, reason: outcome.reason };
    if (!outcome.ok) {
      failures.push(`PR #${number}: auto-merge could not be enqueued — ${outcome.reason}`);
    }
  }
  for (const [number, handling] of Object.entries(resolutions)) {
    if (handling !== 'merge') applied[number] = { handling, ok: true, reason: null };
  }
  return { applied, failures };
}

/**
 * Make sure the branch the PR points at actually contains the wrap commit,
 * by pushing HEAD when the branch is ahead of `origin/<branch>`, or when that
 * ref does not exist yet.
 *
 * Returns `{ok:true, pushed}` when the remote is known to be current, and
 * `{ok:false, reason}` when it is not — including the "can't tell" cases.
 * Refusing to enqueue on an uncertain answer is deliberate: enqueueing a
 * merge for a PR that may be missing the wrap commit is unrecoverable once
 * `--delete-branch` fires, while declining leaves a stale PR the operator
 * can merge themselves.
 *
 * @param {string} cwd - Project root
 * @returns {Promise<{ok:boolean, pushed:boolean, reason:string|null}>}
 */
async function _ensurePushed(cwd) {
  const branchRes = await _internal.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : '';
  if (!branch || branch === 'HEAD') {
    // Declining is right either way, but the REASON must not claim a detached
    // HEAD when the probe was simply stopped before it answered — that sends
    // the operator to check out a branch they are probably already on (#897).
    return {
      ok: false,
      pushed: false,
      reason: branchRes.timedOut
        ? 'could not identify the branch to push — `git rev-parse` was stopped before it answered'
        : 'HEAD is detached — cannot identify the branch to push'
    };
  }

  // Measured against `origin/<branch>` rather than the tracking ref `@{u}`:
  // the merge targets the PR's head on `origin`, and a branch whose upstream
  // is something else (a fork, a second remote, a renamed tracking branch)
  // can be level with `@{u}` while `origin` still lacks the wrap commit —
  // which is precisely the merge this check exists to prevent.
  const ahead = await _internal.exec('git', ['rev-list', '--count', `origin/${branch}..HEAD`], { cwd });
  if (ahead.exitCode === 0 && ahead.stdout.trim() === '0') {
    return { ok: true, pushed: false, reason: null };
  }

  // Either the branch is ahead, or `origin/<branch>` does not exist yet (the
  // rev-list fails). Both want the same push; `-u` is harmless when an
  // upstream already exists. A STOPPED rev-list also lands here, and pushing
  // is the safe response to not knowing — the push is idempotent when the
  // remote was already current.
  const push = await _internal.exec('git', ['push', '-u', 'origin', branch], { cwd });
  if (push.exitCode !== 0) {
    // git prints nothing when we kill it, so a stopped push used to surface as
    // a bare "exit 1" — indistinguishable from a rejected push, and wrong: the
    // remote may have received the pack after we stopped waiting. Declining to
    // enqueue is still correct (this function refuses on any uncertainty); the
    // reason just has to be true.
    if (push.timedOut) {
      return {
        ok: false,
        pushed: false,
        reason: `the push was stopped before it answered (${push.error || 'timed out'}) — origin/${branch} may or may not have the wrap commit, so auto-merge was not enqueued`
      };
    }
    return { ok: false, pushed: false, reason: reasonFromFailure(push) };
  }
  return { ok: true, pushed: true, reason: null };
}

/**
 * Find the staged PR resolutions produced by the gate. Shape-typed: the
 * first staged entry carrying a `resolutions` object alongside a
 * `sessionScoped` array wins.
 *
 * @param {Record<string, object>} staged - Pipeline scratch space
 * @returns {{resolutions: Record<string,string>}|null}
 */
function _findStagedResolutions(staged) {
  if (!staged || typeof staged !== 'object') return null;
  for (const entry of Object.values(staged)) {
    if (entry
        && typeof entry.resolutions === 'object' && entry.resolutions !== null
        && Array.isArray(entry.sessionScoped)) {
      return entry;
    }
  }
  return null;
}

/**
 * Step handler. See module docstring for the full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (must include `path`)
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:true, status:string, output:object, blockers:string[]}>}
 */
async function run(context) {
  const { project, step, staged } = context;

  if (!project || !project.path) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'pr-merge requires context.project.path' },
      blockers: []
    };
  }

  const entry = _findStagedResolutions(staged);
  if (!entry) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no PR resolutions were staged this wrap' },
      blockers: []
    };
  }

  const merges = Object.keys(entry.resolutions).filter((n) => entry.resolutions[n] === 'merge');
  if (merges.length === 0) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'no PR was resolved as merge', resolutions: entry.resolutions },
      blockers: []
    };
  }

  // #1738 — enqueueing a merge is merge authority, which the project's
  // methodology grants. On an engine that cannot run it, nothing is enqueued.
  // The row names the PRs the operator resolved as merge; nothing carries that
  // decision forward, so it is theirs to make again from a capable session.
  const methodology = context.methodology || null;
  if (methodology && methodology.disposition === 'capability-unavailable') {
    log.info('PR merges withheld — methodology unavailable on this engine', {
      project: project.name, engineId: methodology.engineId, prs: merges.join(', ')
    });
    return {
      ok: true,
      status: 'capability-unavailable',
      output: {
        engineId: methodology.engineId,
        capability: methodology.capability,
        reason: `merge withheld for PR${merges.length === 1 ? '' : 's'} ${merges.map((n) => `#${n}`).join(', ')}: ${methodology.reason}`,
        notEnqueued: merges,
        resolutions: entry.resolutions
      },
      blockers: []
    };
  }

  const heldPush = _controlBlocked(context, 'pr-merge-push');
  if (heldPush) return heldPush;

  // #2320 — asked after the hold, which refuses first whatever the project's
  // role, and before the push. In a project whose merges are another's to decide, or whose role
  // could not be read, nothing is enqueued. Nothing is pushed either: the
  // pull request's head is what its reviewers and its merge owner named, and a
  // wrap commit pushed onto it would move that head under them.
  const withheld = await _mergeAuthorityWithheld(project, entry, merges);
  if (withheld) {
    log.info('PR merges not enqueued — this project does not decide its own merges', {
      project: project.name, prs: merges.join(', '), authority: Object.values(withheld.byPr).map((a) => a.authority).join(', ')
    });
    return {
      ok: true,
      status: 'skipped',
      output: {
        reason: withheld.reason,
        mergeAuthority: withheld.byPr,
        notEnqueued: merges,
        pushed: false,
        resolutions: entry.resolutions
      },
      blockers: []
    };
  }

  const push = await _ensurePushed(project.path);
  if (!push.ok) {
    const output = {
      resolutions: entry.resolutions,
      applied: {},
      enqueued: 0,
      pushed: false,
      failures: [`Branch not pushed, so no merge was enqueued — ${push.reason}`],
      warning: true,
      remediation: 'The wrap commit is safe locally but is not on the remote, so merging the PR now '
        + 'would land a PR without it. Push the branch and merge the PR yourself. '
        + 'The wrap itself completed — nothing needs to be re-run.'
    };
    log.warn('pr-merge declined to enqueue — branch not pushed', {
      project: project.name, reason: push.reason
    });
    return { ok: true, status: 'done', output, blockers: [] };
  }

  // Asked again: a HOLD stored while the push ran must still stop the merge.
  const heldMerge = _controlBlocked(context, 'pr-merge-auto-merge-arm');
  if (heldMerge) return heldMerge;
  // #1172 — read from the registered checkout, not the work tree: a wrap
  // running on a worktree has `.tangleclaw/project.json` only at `configPath`
  // (see `_config-root.js`).
  const resolvedMergeMethod = resolveWrapMergeMethod(configRootOf(project));
  if (resolvedMergeMethod.warning) {
    log.info(resolvedMergeMethod.warning, { project: project.name });
  }
  const { applied, failures } = await _applyResolutions(project.path, entry.resolutions, resolvedMergeMethod.method);
  // Record the outcome back onto the gate's staged entry so anything reading
  // the wrap's staged state sees what actually happened, not just what was
  // asked for. `commit` has already run, so this is a record, not an input.
  entry.applied = applied;

  const output = {
    resolutions: entry.resolutions,
    applied,
    enqueued: merges.length - failures.length,
    pushed: push.pushed,
    failures
  };

  if (failures.length > 0) {
    output.warning = true;
    output.remediation = 'Auto-merge could not be enqueued. Enable it for the repository '
      + '(Settings → Pull Requests → Allow auto-merge), or merge the PR yourself. '
      + 'The wrap itself completed — nothing needs to be re-run.';
    log.warn('pr-merge could not enqueue every auto-merge', {
      project: project.name, failures
    });
    return { ok: true, status: 'done', output, blockers: [] };
  }

  log.info('pr-merge enqueued auto-merge', { project: project.name, enqueued: merges.length });
  return { ok: true, status: 'done', output, blockers: [] };
}

/**
 * Why this wrap enqueues no merge, or null when the project decides its own
 * merges (#2320).
 *
 * A project that names no coordinator is answered from its settings alone, so
 * its wrap runs no command it did not run before. Only when a coordinator is
 * named, or the settings could not be read, is the repository read to look up
 * its merge queue, once per base branch among the pull requests.
 *
 * @param {object} project - The project record
 * @param {{sessionScoped: Array<object>}} entry - The gate's staged entry, whose
 *   pull requests carry their `baseRefName`
 * @param {string[]} merges - The pull request numbers resolved as merge
 * @returns {Promise<{reason: string, byPr: Record<string, object>}|null>}
 */
async function _mergeAuthorityWithheld(project, entry, merges) {
  const authority = _internal.mergeAuthority;
  if (authority.mayArmAutoMerge(authority.forProject(project))) return null;

  const remote = await _internal.exec('git', ['remote', 'get-url', 'origin'], { cwd: project.path });
  const repo = remote.exitCode === 0 ? authority.repoFromRemoteUrl(remote.stdout) : null;
  const byPr = {};
  const said = [];
  for (const number of merges) {
    const pr = entry.sessionScoped.find((candidate) => String(candidate.number) === String(number));
    const answer = authority.forProject(project, { repo, baseBranch: pr && pr.baseRefName ? pr.baseRefName : null });
    const sentence = authority.describe(answer, project);
    byPr[number] = { ...answer, said: sentence };
    if (!said.includes(sentence)) said.push(sentence);
  }
  const named = merges.map((n) => `#${n}`).join(', ');
  return {
    reason: `merge not enqueued for PR${merges.length === 1 ? '' : 's'} ${named}: ${said.join(' ')} `
      + 'The wrap commit is on the local branch and was not pushed.',
    byPr
  };
}

/**
 * The blocked result for a governed side effect the control state refuses, or
 * null to proceed (#1861). A refusal blocks the step so the operator sees it
 * and can Retry once the lane is released; nothing was pushed or armed.
 * @param {object} context - Step context (`controlGate` is set by the wrap runner)
 * @param {string} surface - The side effect about to happen
 * @returns {object|null}
 */
function _controlBlocked(context, surface) {
  const refusal = context && typeof context.controlGate === 'function' ? context.controlGate(surface) : null;
  return refusal ? require('../control-gate').blockedStepResult(refusal) : null;
}

const _internal = {
  exec: defaultExec,
  execShell: defaultExecShell,
  enqueueAutoMerge: defaultEnqueueAutoMerge,
  // Who decides this project's merges (#2320); a seam so a test can make the
  // answer anything.
  mergeAuthority: require('../merge-authority')
};

module.exports = {
  run,
  _internal,
  _findStagedResolutions,
  _ensurePushed,
  _applyResolutions,
  VALID_MERGE_METHODS,
  DEFAULT_MERGE_METHOD,
  resolveWrapMergeMethod
};
