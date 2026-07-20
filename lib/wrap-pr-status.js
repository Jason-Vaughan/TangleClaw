'use strict';

/**
 * #638 — resolve the live merge outcome of a wrap PR after the wrap pipeline
 * has already returned.
 *
 * The wrap's `commit` step opens a PR and ARMS auto-merge, then returns. The
 * release only lands when GitHub merges the PR server-side — which happens
 * after checks pass, and never at all if a required check goes red. The wrap
 * therefore cannot know the outcome synchronously, and reporting "auto-merge
 * armed" as unqualified success is the #638 defect (on #636 a red required
 * check left the PR blocked, `main` never moved, and every step read Done).
 *
 * This module answers "did the wrap actually ship?" as a read-only, on-demand
 * query the drawer runs after the pipeline returns — mapping `gh pr view`'s
 * state to one of `merged | pending | blocked | unknown`. `blocked` (a red
 * check, a conflict, or a closed-unmerged PR) must never render as success;
 * `unknown` (no gh, probe failure) stays honestly indeterminate rather than
 * claiming either outcome.
 */

const { execFile } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('wrap-pr-status');

const EXEC_TIMEOUT_MS = 15000;
const GH_JSON_FIELDS = 'state,mergeStateStatus,url,number';

/**
 * A full GitHub PR URL. `gh pr view` accepts a URL or a bare number; we accept
 * either but validate the shape so an arbitrary string can never reach `gh` as
 * an argument (execFile already prevents shell injection; this rejects a
 * leading-dash token being read as a flag, and gives the route a clean 400).
 * @type {RegExp}
 */
const PR_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

/**
 * Whether a PR reference is a shape we will hand to `gh pr view`: a full
 * github.com PR URL, or a bare positive integer.
 * @param {string} ref - Candidate PR reference
 * @returns {boolean}
 */
function isValidPrRef(ref) {
  return typeof ref === 'string' && (PR_URL_RE.test(ref) || /^\d+$/.test(ref));
}

/**
 * Classify a `gh pr view --json state,mergeStateStatus` payload into the
 * release outcome the drawer renders.
 *
 * - `MERGED` → `merged` (the release landed; `main` is at the new version).
 * - `CLOSED` (unmerged) → `blocked` (the PR was closed without shipping).
 * - `OPEN` + `mergeStateStatus ∈ {BLOCKED, DIRTY}` → `blocked` — a required
 *   check failed, a review is required and missing, or the branch conflicts;
 *   auto-merge cannot land it as-is. This is the #636 case.
 * - `OPEN` otherwise (`CLEAN`/`UNSTABLE`/`BEHIND`/`HAS_HOOKS`/`UNKNOWN`) →
 *   `pending` — armed and waiting on checks; outcome not yet known. `pending`
 *   is honestly "not confirmed", which is safe; only `blocked`/`merged` are
 *   definite claims.
 *
 * @param {{state?: string, mergeStateStatus?: string}} data - Parsed gh JSON
 * @returns {'merged'|'blocked'|'pending'} Release outcome
 */
function classify(data) {
  const state = String(data && data.state || '').toUpperCase();
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'blocked';
  const mss = String(data && data.mergeStateStatus || '').toUpperCase();
  if (mss === 'BLOCKED' || mss === 'DIRTY') return 'blocked';
  return 'pending';
}

/**
 * Resolve a wrap PR's live outcome via `gh pr view`. Never throws — a missing
 * `gh`, an auth failure, or unparseable output all resolve to
 * `outcome: 'unknown'` with a `reason`, so the caller renders "not confirmed"
 * rather than a false success or a false failure.
 *
 * @param {string} cwd - Project working tree (gh reads repo/auth context here)
 * @param {string} prRef - A github.com PR URL or a bare PR number
 * @returns {Promise<{outcome:'merged'|'pending'|'blocked'|'unknown', state:string|null, mergeStateStatus:string|null, url:string|null, reason:string|null}>}
 */
async function resolve(cwd, prRef) {
  const base = { outcome: 'unknown', state: null, mergeStateStatus: null, url: null, reason: null };
  // Every `unknown` path logs: an unexplained "release not confirmed" in the
  // drawer is otherwise undebuggable after the fact.
  const indeterminate = (reason) => {
    log.warn('could not resolve wrap PR status', { cwd, prRef, reason });
    return { ...base, reason };
  };
  if (!isValidPrRef(prRef)) {
    return indeterminate('not a valid PR reference (expected a github.com PR URL or a number)');
  }
  let res;
  try {
    res = await _internal.exec('gh', ['pr', 'view', prRef, '--json', GH_JSON_FIELDS], { cwd });
  } catch (err) {
    return indeterminate(`gh pr view threw: ${err.message}`);
  }
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().slice(0, 300);
    // `gh` missing, not authed, or the PR not found — all indeterminate, not
    // a failed release.
    return indeterminate(`gh pr view failed (exit ${res.exitCode}): ${detail}`);
  }
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch (err) {
    return indeterminate(`could not parse gh output: ${err.message}`);
  }
  const outcome = classify(data);
  log.info('resolved wrap PR status', { prRef, outcome, state: data.state, mergeStateStatus: data.mergeStateStatus });
  return {
    outcome,
    state: data.state || null,
    mergeStateStatus: data.mergeStateStatus || null,
    url: data.url || (PR_URL_RE.test(prRef) ? prRef : null),
    reason: null
  };
}

/**
 * Thin `execFile` wrapper mirroring `commit.js:defaultExec` — resolves to a
 * `{exitCode, stdout, stderr}` object, never rejects. Overridable via
 * `_internal` for tests.
 * @param {string} file - Executable
 * @param {string[]} args - Arguments
 * @param {object} options - `{cwd}`
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string}>}
 */
function defaultExec(file, args, options) {
  return new Promise((resolve2) => {
    execFile(file, args, {
      cwd: options && options.cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
      env: process.env
    }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve2({ exitCode, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() });
    });
  });
}

const _internal = { exec: defaultExec };

module.exports = { resolve, classify, isValidPrRef, _internal, PR_URL_RE };
