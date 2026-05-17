'use strict';

/**
 * `pr-check` wrap step (#139 Chunk 8) — surfaces open PRs the user
 * has authored on the project's git remote, via the `gh` CLI. Output
 * separates the full open-PR list from the session-scoped subset
 * (PRs whose `headRefName` matches the current branch) so Chunk 10's
 * UI can render two distinct buckets: "this session's PR" and "other
 * open PRs you might want to think about."
 *
 * **Never blocks.** The step's `blocker` is always `false` per ADR
 * 0002; a session with an open PR isn't a structural failure. Even
 * when `gh` is missing, unauthenticated, or pointed at a non-GitHub
 * remote, the handler returns `{ok:true, status:'skipped',
 * output:{reason}}` rather than throwing or blocking. The always-ok
 * contract matches Chunks 5 / 6 / 7's explicit-catch pattern.
 *
 * **Session-scope filter.** `headRefName === currentBranch` is the
 * single source of truth for "this PR belongs to the session being
 * wrapped." More elaborate matching (PR title chunk-tag, issue
 * number cross-reference, base branch heuristic) lives in Chunk 10
 * if it lives anywhere — overly-clever filtering at the handler
 * level produces false positives the user can't easily undo. Mirrors
 * the `critic-check` (Chunk 7) discipline of keeping detection
 * mechanisms explicit and one-source-of-truth.
 *
 * **Caller-supplied resolution (Chunk 10 hand-off).** When the wrap
 * UI lets the user mark how to handle each open PR
 * ("merge-before-wrap", "defer", "ignore"), the choice flows in via
 * `options.prHandling`. Two shapes are supported:
 *   - `{prNumber: 'merge'|'defer'|'ignore'}` — per-PR map
 *   - A single string `'merge'|'defer'|'ignore'` — applies to ALL
 *     session-scoped PRs
 * The handler validates entries but does NOT act on them — the
 * Chunk 9 `commit` step is what reads `context.staged[step.id]` to
 * embed the choices in the wrap commit body / MEMORY block.
 *
 * **Step config.**
 *   - `step.includeDrafts` — boolean; default `false`. Open draft
 *     PRs are excluded unless the methodology author opts in.
 *
 * **Single-transaction discipline.** Like Chunks 5–7, this handler
 * reads only — never mutates git, never writes the filesystem.
 * `context.staged[step.id]` is the sole side effect when session-
 * scoped PRs exist or a user choice arrives.
 */

const { exec } = require('node:child_process');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-pr-check');

const EXEC_TIMEOUT_MS = 30 * 1000; // 30s — gh API calls should be fast over a healthy net
const VALID_HANDLINGS = new Set(['merge', 'defer', 'ignore']);
// JSON fields requested from `gh pr list`. Kept narrow on purpose: the
// commit-step + UI need just enough to identify and link the PR.
// Adding fields here without a downstream consumer is dead surface area.
const GH_PR_JSON_FIELDS = 'number,title,headRefName,baseRefName,url,createdAt,isDraft,author';

/**
 * Default thin exec wrapper — resolves to a structured result; never
 * throws on non-zero exit (caller decides what non-zero means). gh
 * exits non-zero on the no-auth path, no-repo path, and many other
 * recoverable cases, so blanket-rethrow would defeat the never-blocks
 * contract.
 *
 * @param {string} command
 * @param {object} options
 * @param {string} options.cwd
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, error:string|null}>}
 */
function defaultExec(command, options) {
  return new Promise((resolve) => {
    exec(command, {
      cwd: options.cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
      env: process.env
    }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({
        exitCode,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        error: err && typeof err.code !== 'number' ? err.message : null
      });
    });
  });
}

/**
 * Detect whether the `gh` CLI is available + minimally functional.
 * Uses `gh --version` (no auth required, no network round-trip) so
 * the answer is honest about install presence without coupling to
 * the auth state — the auth check happens implicitly when we run
 * `gh pr list`. Returns `true` on exit 0; `false` otherwise.
 *
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
async function defaultIsGhAvailable(cwd) {
  const r = await _internal.exec('gh --version', { cwd });
  return r.exitCode === 0;
}

/**
 * Detect the current branch via `git rev-parse --abbrev-ref HEAD`.
 * Returns `null` for detached HEAD / non-repo / git missing — the
 * caller treats null as "no session scope possible, surface
 * everything as open."
 *
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function defaultGetCurrentBranch(cwd) {
  const r = await _internal.exec('git rev-parse --abbrev-ref HEAD', { cwd });
  if (r.exitCode !== 0) return null;
  const name = r.stdout.trim();
  if (!name || name === 'HEAD') return null;
  return name;
}

/**
 * Fetch the list of open authored PRs via `gh pr list`. Returns
 * `{ok:true, prs}` on success; `{ok:false, reason}` on any failure
 * path (gh not authenticated, gh in a non-GitHub repo, gh API down,
 * JSON parse fail). The caller maps `ok:false` → step `skipped`.
 *
 * @param {string} cwd
 * @returns {Promise<{ok:boolean, prs:Array, reason:string|null, exitCode?:number}>}
 */
async function defaultListOpenPrs(cwd) {
  const cmd = `gh pr list --state open --author @me --json ${GH_PR_JSON_FIELDS}`;
  const r = await _internal.exec(cmd, { cwd });
  if (r.exitCode !== 0) {
    // gh prints actionable text on stderr ("no auth", "not a repo", etc).
    // Surface the first ~200 chars so the UI can render the recovery
    // hint inline rather than just "gh failed." Append `…` when the
    // raw text was longer so a Chunk-10 UI consumer knows there's more.
    const raw = (r.stderr || r.stdout || `exit ${r.exitCode}`).trim();
    const reason = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
    return { ok: false, prs: [], reason, exitCode: r.exitCode };
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout || '[]');
  } catch (err) {
    return {
      ok: false,
      prs: [],
      reason: `gh pr list returned malformed JSON: ${err.message}`
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, prs: [], reason: 'gh pr list returned non-array JSON' };
  }
  return { ok: true, prs: parsed, reason: null };
}

/**
 * Apply per-step + per-handler filters to a `gh pr list` result.
 * Currently just the draft filter; kept as a function so future
 * filter axes (e.g. `step.excludeLabels`) have a single composition
 * point.
 *
 * @param {Array<object>} prs
 * @param {object} step
 * @returns {Array<object>}
 */
function _filterPrs(prs, step) {
  const includeDrafts = step.includeDrafts === true;
  if (includeDrafts) return prs;
  return prs.filter((pr) => pr.isDraft !== true);
}

/**
 * Split a list of PRs into session-scoped + other-open buckets.
 * Session scope is defined as `headRefName === currentBranch`; if
 * `currentBranch` is null (detached / missing) nothing is session-
 * scoped — everything falls into the "other" bucket so the UI still
 * shows open PRs.
 *
 * @param {Array<object>} prs
 * @param {string|null} currentBranch
 * @returns {{sessionScoped:Array<object>, otherOpen:Array<object>}}
 */
function _partitionPrs(prs, currentBranch) {
  if (!currentBranch) return { sessionScoped: [], otherOpen: prs.slice() };
  const sessionScoped = [];
  const otherOpen = [];
  for (const pr of prs) {
    if (pr.headRefName === currentBranch) sessionScoped.push(pr);
    else otherOpen.push(pr);
  }
  return { sessionScoped, otherOpen };
}

/**
 * Normalize and validate `options.prHandling` against the
 * session-scoped PR list. Returns `{resolutions, invalid}` where
 * `resolutions` is `{prNumber: 'merge'|'defer'|'ignore'}` for every
 * PR the caller resolved (or all PRs if a string shortcut was used),
 * and `invalid` is an array of human-readable problem descriptors
 * for the UI to surface (unknown PR number, unknown handling value).
 *
 * @param {*} prHandling - Raw caller input (object map | string | undefined)
 * @param {Array<object>} sessionScoped - The PRs the handler considers in-scope
 * @returns {{resolutions: Record<string,string>, invalid: string[]}}
 */
function _normalizeHandling(prHandling, sessionScoped) {
  const resolutions = {};
  const invalid = [];

  if (prHandling === undefined || prHandling === null) {
    return { resolutions, invalid };
  }

  // String shortcut: apply to every session-scoped PR.
  if (typeof prHandling === 'string') {
    if (!VALID_HANDLINGS.has(prHandling)) {
      invalid.push(`Unknown prHandling shortcut "${prHandling}" (expected merge|defer|ignore)`);
      return { resolutions, invalid };
    }
    for (const pr of sessionScoped) {
      // Normalize to string keys symmetrically with the object-map
      // branch below — both produce a `{string: enum}` map so the
      // Chunk 9 commit step + Chunk 10 UI iterate with predictable
      // key types.
      resolutions[String(pr.number)] = prHandling;
    }
    return { resolutions, invalid };
  }

  // Object map: per-PR overrides. Validate both keys (must reference a
  // known session-scoped PR number) and values (must be in the enum).
  if (typeof prHandling !== 'object' || Array.isArray(prHandling)) {
    invalid.push('prHandling must be a string shortcut or an object map');
    return { resolutions, invalid };
  }
  const knownNumbers = new Set(sessionScoped.map((pr) => String(pr.number)));
  for (const [key, value] of Object.entries(prHandling)) {
    if (!knownNumbers.has(String(key))) {
      invalid.push(`prHandling key ${key} does not match any session-scoped open PR`);
      continue;
    }
    if (typeof value !== 'string' || !VALID_HANDLINGS.has(value)) {
      invalid.push(`prHandling[${key}] = ${JSON.stringify(value)} is not one of merge|defer|ignore`);
      continue;
    }
    resolutions[String(key)] = value;
  }
  return { resolutions, invalid };
}

/**
 * Step handler. See module docstring for full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (must include `path`)
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @param {object} [context.options] - Caller options (`prHandling`)
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:true, status:string, output:object, blockers:string[]}>}
 */
async function run(context) {
  const { project, step, staged } = context;
  const options = context.options || {};

  if (!project || !project.path) {
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'pr-check requires context.project.path' },
      blockers: []
    };
  }
  const cwd = project.path;

  // Outer try/catch — see ADR 0002 Chunk 7's "always-ok contract"
  // discussion. Any throw from `_internal.*` (gh binary genuinely
  // crashes, child_process spawn fails, OOM, etc.) degrades to
  // skipped rather than propagating to the runner as a blocker.
  try {
    if (!(await _internal.isGhAvailable(cwd))) {
      return {
        ok: true,
        status: 'skipped',
        output: { reason: 'gh CLI not available on this machine' },
        blockers: []
      };
    }

    const branch = await _internal.getCurrentBranch(cwd);
    const listResult = await _internal.listOpenPrs(cwd);

    if (!listResult.ok) {
      // gh ran but couldn't enumerate — typically no auth, not a
      // GitHub remote, or a transient API hiccup. Surface the reason
      // for the UI; never block.
      log.info('pr-check skipped — gh pr list returned non-zero', {
        project: project.name,
        reason: listResult.reason
      });
      return {
        ok: true,
        status: 'skipped',
        output: {
          reason: 'gh pr list could not enumerate open PRs',
          detail: listResult.reason,
          ghExitCode: listResult.exitCode || null
        },
        blockers: []
      };
    }

    const filtered = _filterPrs(listResult.prs, step);
    const { sessionScoped, otherOpen } = _partitionPrs(filtered, branch);
    const { resolutions, invalid } = _normalizeHandling(options.prHandling, sessionScoped);

    const output = {
      branch,
      includeDrafts: step.includeDrafts === true,
      counts: {
        openTotal: filtered.length,
        sessionScoped: sessionScoped.length,
        otherOpen: otherOpen.length,
        // `rawTotal` = before draft-filter; surfaces "5 drafts hidden" UX
        // without needing to re-call gh.
        rawTotal: listResult.prs.length
      },
      sessionScoped,
      otherOpen,
      resolutions,
      invalidHandling: invalid
    };

    // Stage only when there's something the commit step needs to know
    // about (session-scoped open PR OR a caller-supplied resolution).
    // No staging = nothing to write in the wrap commit body — matches
    // the Chunk 5/6/7 "no warning → nothing staged" discipline.
    if (sessionScoped.length > 0 || Object.keys(resolutions).length > 0) {
      staged[step.id] = {
        branch,
        sessionScoped,
        resolutions,
        invalidHandling: invalid
      };
    }

    log.info('pr-check ok', {
      project: project.name,
      branch,
      openTotal: filtered.length,
      sessionScoped: sessionScoped.length,
      resolved: Object.keys(resolutions).length,
      invalid: invalid.length
    });

    return {
      ok: true,
      status: 'done',
      output,
      blockers: []
    };
  } catch (err) {
    log.warn('pr-check probe failed — degrading to skipped', {
      project: project.name,
      error: err.message
    });
    return {
      ok: true,
      status: 'skipped',
      output: { reason: 'pr-check probe failed', error: err.message },
      blockers: []
    };
  }
}

const _internal = {
  exec: defaultExec,
  isGhAvailable: defaultIsGhAvailable,
  getCurrentBranch: defaultGetCurrentBranch,
  listOpenPrs: defaultListOpenPrs
};

module.exports = {
  run,
  _internal,
  _filterPrs,
  _partitionPrs,
  _normalizeHandling,
  VALID_HANDLINGS,
  GH_PR_JSON_FIELDS
};
