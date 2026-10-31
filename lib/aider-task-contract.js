'use strict';

/**
 * Aider Builder task contract (#1644) — a bounded, verifiable one-shot task
 * handed to Aider's CLI, and the receipt that comes back.
 *
 * Aider is a chat-first pair programmer, not an autonomous bash-tool agent
 * (#2439's source-verified audit): in its normal interactive mode it either
 * prints a suggested shell command as chat text or prompts a human for
 * confirmation, so it cannot run TangleClaw's multi-step `tc start` ritual on
 * its own, and a Builder lane with nobody at the pane would stall forever on
 * any confirmation `--yes-always` does not cover. The supported escape hatch
 * is Aider's own CLI one-task invocation — `--message-file`, which the CLI's
 * own help text says "process[es] reply, then exit[s] (disables chat mode)".
 * This module wraps exactly that: one bounded task in, one verifiable
 * receipt out, no terminal wake dependence, no Medusa parity claimed.
 *
 * **What this module decides, and does not.** It defines the shape of a task
 * (`buildTaskContract`) and runs it (`runTask`), turning the CLI's exit code,
 * output and the repo's own git history into one of a small set of
 * DISTINGUISHABLE outcomes (`OUTCOMES`). It does not judge whether a patch is
 * good, does not retry, and does not decide when a Builder gets dispatched
 * again — composing several tasks, bounding retries and surfacing
 * uncertainty up the fleet is the PM/Architect's job per #1644's own text.
 *
 * **Why evidence comes from git, not from Aider's own words.** Aider
 * auto-commits each edit by default (`--auto-commits`, on unless disabled),
 * so "did anything really change" is answered by comparing `git rev-parse
 * HEAD` before and after the run and diffing the two, never by scanning the
 * model's chat reply for words like "done" — a model can say it finished
 * without touching a file, and the issue this module implements names that
 * exact failure mode ("a model merely claiming completion") as one the
 * receipt must distinguish from real, verified success.
 *
 * @module lib/aider-task-contract
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLogger } = require('./logger');

const log = createLogger('aider-task-contract');

/** Contract/receipt schema tag — bump if either shape changes incompatibly. */
const SCHEMA = 'tc.aider-task/1';

/**
 * Every outcome a receipt may report. Mutually exclusive — `runTask` picks
 * exactly one — and exhaustive over what a one-shot CLI invocation can do.
 */
const OUTCOMES = Object.freeze([
  // Real edits landed (new commit(s), all inside `editableFiles`), and the
  // task's `testCommand` (if any) exited 0 when run independently afterward.
  'success',
  // Real edits landed, but the independently-run `testCommand` exited non-0.
  'test-failure',
  // Aider exited 0 and advanced HEAD, but outside the task's `editableFiles`
  // — the one outcome that overrides whatever the diff/tests looked like,
  // because a bounded task that edits unbounded files broke its own contract.
  'scope-violation',
  // Aider exited 0 but HEAD never moved — no real change, whatever the
  // model's chat reply claimed. `claimedCompletion` on the receipt says
  // whether it also asserted success in words.
  'no-op',
  // The CLI process did not exit within `timeoutMs`.
  'timeout',
  // The CLI process did not exit within `timeoutMs`, AND its own output
  // contains a recognizable confirmation-prompt line — the specific,
  // actionable case of "stuck waiting on a human" rather than a generic hang.
  'blocked-input',
  // Caller aborted the task (`signal`) before it finished.
  'cancelled',
  // Aider itself exited non-zero (bad invocation, crash, auth failure, ...).
  'error'
]);

/** Field length bounds, so a pathological message/path can't blow up a receipt. */
const LIMITS = Object.freeze({
  message: 32 * 1024,
  outputTail: 8 * 1024,
  editableFiles: 64
});

/** How many trailing characters of stdout/stderr a receipt keeps. */
const OUTPUT_TAIL_CHARS = LIMITS.outputTail;

/**
 * Lines Aider is known to print while waiting on a human it will never get
 * an answer from in an unattended run — the signal that classifies a timeout
 * as `blocked-input` rather than a bare `timeout`. Not exhaustive: an
 * unrecognized stall still reports as `timeout`, honestly, rather than
 * guessing at a prompt it did not actually measure (same evidence discipline
 * `lib/medusa-wake.js`'s wake-signature fields document for terminal gating).
 * @type {RegExp[]}
 */
const BLOCKED_INPUT_PATTERNS = Object.freeze([
  /Add \.aider\* to \.gitignore\?/i,
  /\(y\)es\/\(n\)o/i,
  /Edit the files\? \(Y\)es\/\(n\)o/i,
  /Run shell command\?/i
]);

/**
 * Validate and normalize a task spec into a frozen contract.
 *
 * @param {object} spec
 * @param {string} spec.repoPath - Absolute path to the repo or worktree the
 *   task runs in. Must exist and contain a `.git` (a worktree's `.git` is a
 *   file, not a directory — both are accepted).
 * @param {string[]} spec.editableFiles - Repo-relative paths Aider may edit.
 *   At least one, each a relative path with no `..` segment and no leading
 *   `/` — the bound this contract exists to enforce.
 * @param {string} spec.message - The task instruction sent via
 *   `--message-file`. Non-empty, at most `LIMITS.message` characters.
 * @param {?string} [spec.testCommand] - Shell command run independently
 *   after Aider exits, via the project's own shell (`spawnSync(cmd, {shell:
 *   true})`), to verify the edit rather than trust Aider's own `--auto-test`.
 *   `null`/omitted means no test is run and `testResult` stays `null`.
 * @param {?string} [spec.model] - Passed through as Aider's `--model`.
 * @param {number} [spec.timeoutMs=600000] - Wall-clock budget for the Aider
 *   process. Positive integer.
 * @returns {Readonly<object>} The frozen contract `runTask` accepts.
 * @throws {Error} On any malformed or out-of-bound field, naming the field.
 */
function buildTaskContract(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('aider-task-contract: spec must be an object');

  const repoPath = spec.repoPath;
  if (typeof repoPath !== 'string' || repoPath.length === 0 || !path.isAbsolute(repoPath)) {
    throw new Error('aider-task-contract: repoPath must be a non-empty absolute path');
  }
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`aider-task-contract: repoPath is not a git repo or worktree (no .git): ${repoPath}`);
  }

  if (!Array.isArray(spec.editableFiles) || spec.editableFiles.length === 0) {
    throw new Error('aider-task-contract: editableFiles must be a non-empty array of repo-relative paths');
  }
  if (spec.editableFiles.length > LIMITS.editableFiles) {
    throw new Error(`aider-task-contract: editableFiles exceeds the ${LIMITS.editableFiles}-file bound`);
  }
  const editableFiles = spec.editableFiles.map((f, i) => {
    if (typeof f !== 'string' || f.length === 0) throw new Error(`aider-task-contract: editableFiles[${i}] must be a non-empty string`);
    const normalized = f.split(path.sep).join('/');
    if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`aider-task-contract: editableFiles[${i}] must be a repo-relative path with no '..' segment: ${f}`);
    }
    return normalized;
  });

  if (typeof spec.message !== 'string' || spec.message.trim().length === 0) {
    throw new Error('aider-task-contract: message must be a non-empty string');
  }
  if (spec.message.length > LIMITS.message) {
    throw new Error(`aider-task-contract: message exceeds ${LIMITS.message} characters`);
  }

  if (spec.testCommand !== undefined && spec.testCommand !== null) {
    if (typeof spec.testCommand !== 'string' || spec.testCommand.trim().length === 0) {
      throw new Error('aider-task-contract: testCommand must be a non-empty string or null');
    }
  }

  if (spec.model !== undefined && spec.model !== null && typeof spec.model !== 'string') {
    throw new Error('aider-task-contract: model must be a string or null');
  }

  let timeoutMs = 600000;
  if (spec.timeoutMs !== undefined) {
    if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
      throw new Error('aider-task-contract: timeoutMs must be a positive number');
    }
    timeoutMs = spec.timeoutMs;
  }

  return Object.freeze({
    schema: SCHEMA,
    repoPath,
    editableFiles: Object.freeze(editableFiles),
    message: spec.message,
    testCommand: spec.testCommand || null,
    model: spec.model || null,
    timeoutMs
  });
}

/**
 * Current `HEAD` of a repo/worktree. Distinguishes three outcomes explicitly
 * rather than collapsing a real command failure into the same `null` a
 * legitimately-unborn branch (no commits yet) returns (#2756 PRR-A
 * re-review): a caller that only checked `sha === null` could not tell "no
 * commits yet, carry on" from "git itself failed, stop" — and the latter was
 * silently treated as the former.
 * @param {object} deps - Injected `spawnSync`.
 * @param {string} repoPath
 * @returns {{ok: boolean, sha: ?string, error: ?string}} `ok: true, sha:
 *   null` means a real, unborn-branch repo with no commits yet (not a
 *   failure). `ok: false` means the command itself could not be trusted.
 */
function _headSha(deps, repoPath) {
  const result = deps.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' });
  if (!result) return { ok: false, sha: null, error: 'git rev-parse HEAD produced no result' };
  if (result.status !== 0) {
    const stderr = String(result.stderr || '');
    if (/unknown revision|ambiguous argument 'HEAD'/i.test(stderr)) {
      return { ok: true, sha: null, error: null };
    }
    return { ok: false, sha: null, error: `git rev-parse HEAD failed: ${stderr.trim() || `exit ${result.status}`}` };
  }
  return { ok: true, sha: String(result.stdout || '').trim() || null, error: null };
}

/**
 * Repo-relative paths changed between two commits (exclusive..inclusive).
 * Returns an explicit `ok: false` on a real `git diff` failure instead of
 * silently reporting `[]` — `[]` on failure previously meant the EXACT same
 * thing as "legitimately nothing changed," which let `_inspectAfterRun`
 * report `ok: true` whenever `git status` happened to succeed even though
 * this call had already failed (#2756 PRR-A re-review).
 * @param {object} deps - Injected `spawnSync`.
 * @param {string} repoPath
 * @param {?string} beforeSha
 * @param {?string} afterSha
 * @returns {{ok: boolean, files: string[], error: ?string}}
 */
function _changedFiles(deps, repoPath, beforeSha, afterSha) {
  if (!beforeSha || !afterSha || beforeSha === afterSha) return { ok: true, files: [], error: null };
  const result = deps.spawnSync('git', ['diff', '--name-only', `${beforeSha}..${afterSha}`], { cwd: repoPath, encoding: 'utf8' });
  if (!result || result.status !== 0) {
    const detail = result ? (String(result.stderr || '').trim() || `exit ${result.status}`) : 'spawn failed';
    return { ok: false, files: [], error: `git diff ${beforeSha}..${afterSha} failed: ${detail}` };
  }
  return { ok: true, files: String(result.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean), error: null };
}

/**
 * Repo-relative paths from a `git status --porcelain --untracked-files=all`
 * line, stripping the two-character status code. A rename line's old and
 * new path are both returned — a file Aider removed outside its scope is
 * exactly the kind of escape this exists to catch.
 * @param {string} output
 * @returns {string[]}
 */
function _parsePorcelainPaths(output) {
  const files = [];
  for (const line of String(output || '').split('\n')) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    if (!rest) continue;
    const arrow = rest.indexOf(' -> ');
    if (arrow !== -1) {
      files.push(rest.slice(0, arrow).trim());
      files.push(rest.slice(arrow + 4).trim());
    } else {
      files.push(rest.trim());
    }
  }
  return files.filter(Boolean);
}

/**
 * Inspect the full working tree after a run attempt: committed changes
 * between `beforeSha` and current `HEAD`, UNION'd with anything uncommitted
 * or untracked (Aider can run with auto-commits disabled, or can die
 * mid-edit before its own commit lands). Fails CLOSED — `ok: false` if the
 * `git status` call itself cannot be trusted, rather than silently reporting
 * "no changes" for a working tree this could not actually verify.
 * @param {object} deps - Injected `spawnSync`.
 * @param {string} repoPath
 * @param {?string} beforeSha
 * @returns {{ok: boolean, filesChanged: string[], error: ?string}}
 */
function _inspectAfterRun(deps, repoPath, beforeSha) {
  const statusResult = deps.spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoPath, encoding: 'utf8' });
  if (!statusResult || statusResult.status !== 0) {
    return { ok: false, filesChanged: [], error: 'post-run working-tree inspection failed (git status) — changes could not be verified' };
  }
  const uncommitted = _parsePorcelainPaths(statusResult.stdout);
  const after = _headSha(deps, repoPath);
  if (!after.ok) {
    return { ok: false, filesChanged: [], error: `post-run working-tree inspection failed (git rev-parse HEAD) — ${after.error}` };
  }
  const committed = _changedFiles(deps, repoPath, beforeSha, after.sha);
  if (!committed.ok) {
    return { ok: false, filesChanged: [], error: `post-run working-tree inspection failed (git diff) — ${committed.error}` };
  }
  const filesChanged = Array.from(new Set([...committed.files, ...uncommitted])).sort();
  return { ok: true, filesChanged, error: null };
}

/**
 * Run `_inspectAfterRun` and classify the result against `editableSet` in
 * one call — used on EVERY exit path (success, test-failure, timeout,
 * blocked-input, cancelled, error) so a run that edited outside its scope
 * before dying still reports that violation instead of returning
 * empty-handed, and an unverifiable tree never gets reported as "no change".
 * @param {object} deps
 * @param {string} repoPath
 * @param {?string} beforeSha
 * @param {Set<string>} editableSet
 * @returns {{kind: 'unverified', error: string}
 *   | {kind: 'violation', filesChanged: string[], scopeViolations: string[], error: string}
 *   | {kind: 'ok', filesChanged: string[]}}
 */
function _classifyInspection(deps, repoPath, beforeSha, editableSet) {
  const inspection = _inspectAfterRun(deps, repoPath, beforeSha);
  if (!inspection.ok) return { kind: 'unverified', error: inspection.error };
  const scopeViolations = inspection.filesChanged.filter((f) => !editableSet.has(f));
  if (scopeViolations.length > 0) {
    return {
      kind: 'violation', filesChanged: inspection.filesChanged, scopeViolations,
      error: `aider edited file(s) outside editableFiles: ${scopeViolations.join(', ')}`
    };
  }
  return { kind: 'ok', filesChanged: inspection.filesChanged };
}

/** @param {...(?string)} parts @returns {?string} Non-empty parts joined with '; ', or null. */
function _combineErrors(...parts) {
  const filtered = parts.filter(Boolean);
  return filtered.length > 0 ? filtered.join('; ') : null;
}

/** @param {string} text @param {number} max @returns {string} Last `max` characters. */
function _tail(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(s.length - max) : s;
}

/**
 * Does this output contain a line Aider is known to print while stuck
 * waiting on human input it will never receive unattended?
 * @param {string} output
 * @returns {boolean}
 */
function _looksBlockedOnInput(output) {
  return BLOCKED_INPUT_PATTERNS.some((re) => re.test(output));
}

/**
 * A loose, HONEST heuristic for "the chat reply reads like a completion
 * claim" — used only to flag a `no-op` receipt as also claim-disputed, never
 * to upgrade an outcome. Documented as a heuristic because it is one: a model
 * can phrase success in words this does not match, and this function makes
 * no claim beyond "this specific substring was seen".
 * @param {string} output
 * @returns {boolean}
 */
function _claimsCompletion(output) {
  return /\b(done|completed?|finished|implemented|fixed|all set)\b/i.test(output);
}

/**
 * Run one bounded Aider task and return its receipt.
 *
 * @param {ReturnType<typeof buildTaskContract>} contract
 * @param {object} [options]
 * @param {Function} [options.spawnSync] - Injected in place of
 *   `node:child_process`'s `spawnSync`, so tests never launch a real process
 *   (mirrors this repo's `tmux.createSession`-style stubbing convention).
 * @param {Function} [options.now] - Injected clock (`() => number`), ms epoch.
 * @param {AbortSignal} [options.signal] - If already aborted (or aborts
 *   before the CLI call returns), the receipt reports `cancelled` and no
 *   process is spawned.
 * @returns {object} The receipt — see inline fields.
 */
function runTask(contract, options = {}) {
  const deps = {
    spawnSync: options.spawnSync || require('node:child_process').spawnSync,
    now: options.now || Date.now
  };
  const startedAt = new Date(deps.now()).toISOString();

  if (options.signal && options.signal.aborted) {
    return _receipt(contract, {
      outcome: 'cancelled', startedAt, finishedAt: startedAt, durationMs: 0,
      exitCode: null, signal: null, filesChanged: [], scopeViolations: [],
      testResult: null, claimedCompletion: false, stdoutTail: '', stderrTail: ''
    });
  }

  // Require a clean baseline BEFORE invoking aider (#2756 PRR-A re-review): a
  // pre-existing dirty file inside `editableFiles` would otherwise be picked
  // up by the post-run inspection and reported as a real, verified edit even
  // if aider made no change at all. Fail closed rather than guess which of
  // the pre-existing changes, if any, aider is responsible for.
  const baselineStatus = deps.spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: contract.repoPath, encoding: 'utf8' });
  if (!baselineStatus || baselineStatus.status !== 0) {
    return _receipt(contract, {
      outcome: 'error', startedAt, finishedAt: startedAt, durationMs: 0,
      exitCode: null, signal: null, filesChanged: [], scopeViolations: [],
      testResult: null, claimedCompletion: false, stdoutTail: '', stderrTail: '',
      error: 'pre-run working-tree inspection failed (git status) — could not verify a clean baseline before invoking aider'
    });
  }
  const dirtyBaseline = _parsePorcelainPaths(baselineStatus.stdout);
  if (dirtyBaseline.length > 0) {
    return _receipt(contract, {
      outcome: 'error', startedAt, finishedAt: startedAt, durationMs: 0,
      exitCode: null, signal: null, filesChanged: [], scopeViolations: [],
      testResult: null, claimedCompletion: false, stdoutTail: '', stderrTail: '',
      error: `working tree is dirty before invocation (${dirtyBaseline.join(', ')}) — refusing to run; a pre-existing change could be mistaken for aider's own edit`
    });
  }

  const beforeHead = _headSha(deps, contract.repoPath);
  if (!beforeHead.ok) {
    return _receipt(contract, {
      outcome: 'error', startedAt, finishedAt: startedAt, durationMs: 0,
      exitCode: null, signal: null, filesChanged: [], scopeViolations: [],
      testResult: null, claimedCompletion: false, stdoutTail: '', stderrTail: '',
      error: `could not establish baseline HEAD before run — ${beforeHead.error}`
    });
  }
  // Reject an unborn branch (no commits yet) rather than run against it
  // (#2756 PRR-A round 3): `_changedFiles` returns `[]` whenever `beforeSha`
  // is null, because that's also what a legitimate "nothing changed" case
  // looks like — so Aider's very first commit on an empty repo would diff
  // against nothing, read as no real change, and a scope violation on that
  // same first commit would go undetected right along with it.
  if (beforeHead.sha === null) {
    return _receipt(contract, {
      outcome: 'error', startedAt, finishedAt: startedAt, durationMs: 0,
      exitCode: null, signal: null, filesChanged: [], scopeViolations: [],
      testResult: null, claimedCompletion: false, stdoutTail: '', stderrTail: '',
      error: 'repository has no commits yet (unborn branch) — refusing to run; a first commit could not be verified against an empty baseline'
    });
  }
  const beforeSha = beforeHead.sha;
  const editableSet = new Set(contract.editableFiles);

  const messageFile = path.join(os.tmpdir(), `tc-aider-task-${crypto.randomBytes(8).toString('hex')}.txt`);
  fs.writeFileSync(messageFile, contract.message, 'utf8');

  const args = ['--yes-always', '--no-check-update', '--no-analytics', '--message-file', messageFile];
  for (const f of contract.editableFiles) args.push('--file', f);
  if (contract.model) args.push('--model', contract.model);

  let result;
  try {
    result = deps.spawnSync('aider', args, {
      cwd: contract.repoPath,
      encoding: 'utf8',
      timeout: contract.timeoutMs,
      killSignal: 'SIGTERM',
      signal: options.signal
    });
  } finally {
    try { fs.unlinkSync(messageFile); } catch { /* best-effort cleanup */ }
  }

  const finishedAt = new Date(deps.now()).toISOString();
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  const stdout = String((result && result.stdout) || '');
  const stderr = String((result && result.stderr) || '');
  const stdoutTail = _tail(stdout, OUTPUT_TAIL_CHARS);
  const stderrTail = _tail(stderr, OUTPUT_TAIL_CHARS);
  const combined = `${stdout}\n${stderr}`;

  // Shared by every exit path below (cancelled/timeout/spawn-error/hard-error):
  // a scope violation or an unverifiable working tree overrides the branch's
  // own intended outcome, the same override `OUTCOMES`' doc describes for
  // `scope-violation` on the success path — applied uniformly so a run that
  // edited outside scope before dying cannot report empty-handed, and one
  // whose tree this process could not verify cannot report "no change".
  const finalize = (fallbackOutcome, fallbackError, baseFields) => {
    const c = _classifyInspection(deps, contract.repoPath, beforeSha, editableSet);
    if (c.kind === 'unverified') {
      return _receipt(contract, {
        ...baseFields, outcome: 'error', startedAt, finishedAt, durationMs,
        filesChanged: [], scopeViolations: [], testResult: null, stdoutTail, stderrTail,
        error: _combineErrors(fallbackError, c.error)
      });
    }
    if (c.kind === 'violation') {
      return _receipt(contract, {
        ...baseFields, outcome: 'scope-violation', startedAt, finishedAt, durationMs,
        filesChanged: c.filesChanged, scopeViolations: c.scopeViolations, testResult: null, stdoutTail, stderrTail,
        error: _combineErrors(fallbackError, c.error)
      });
    }
    return _receipt(contract, {
      ...baseFields, outcome: fallbackOutcome, startedAt, finishedAt, durationMs,
      filesChanged: c.filesChanged, scopeViolations: [], testResult: null, stdoutTail, stderrTail,
      error: fallbackError
    });
  };

  if (options.signal && options.signal.aborted) {
    return finalize('cancelled', null, {
      exitCode: result ? result.status : null, signal: result ? result.signal : null, claimedCompletion: false
    });
  }

  const timedOut = Boolean(result && (result.error && result.error.code === 'ETIMEDOUT'
    || (result.signal === 'SIGTERM' && result.status === null)));
  if (timedOut) {
    const outcome = _looksBlockedOnInput(combined) ? 'blocked-input' : 'timeout';
    return finalize(outcome, null, { exitCode: result.status, signal: result.signal, claimedCompletion: false });
  }

  if (!result || result.error) {
    log.warn('aider-task-contract: could not spawn aider', { repoPath: contract.repoPath, error: result && result.error && result.error.message });
    return finalize('error', result && result.error ? result.error.message : 'spawnSync returned no result',
      { exitCode: result ? result.status : null, signal: result ? result.signal : null, claimedCompletion: false });
  }

  if (result.status !== 0) {
    return finalize('error', `aider exited ${result.status}`, { exitCode: result.status, signal: result.signal, claimedCompletion: false });
  }

  const claimedCompletion = _claimsCompletion(combined);
  const c = _classifyInspection(deps, contract.repoPath, beforeSha, editableSet);

  if (c.kind === 'unverified') {
    return _receipt(contract, {
      outcome: 'error', startedAt, finishedAt, durationMs,
      exitCode: result.status, signal: result.signal, filesChanged: [], scopeViolations: [],
      testResult: null, claimedCompletion, stdoutTail, stderrTail, error: c.error
    });
  }

  if (c.kind === 'violation') {
    return _receipt(contract, {
      outcome: 'scope-violation', startedAt, finishedAt, durationMs,
      exitCode: result.status, signal: result.signal, filesChanged: c.filesChanged, scopeViolations: c.scopeViolations,
      testResult: null, claimedCompletion, stdoutTail, stderrTail, error: c.error
    });
  }

  if (c.filesChanged.length === 0) {
    return _receipt(contract, {
      outcome: 'no-op', startedAt, finishedAt, durationMs,
      exitCode: result.status, signal: result.signal, filesChanged: c.filesChanged, scopeViolations: [],
      testResult: null, claimedCompletion, stdoutTail, stderrTail
    });
  }

  let testResult = null;
  if (contract.testCommand) {
    const testStarted = deps.now();
    const testRun = deps.spawnSync(contract.testCommand, { cwd: contract.repoPath, encoding: 'utf8', shell: true, timeout: contract.timeoutMs });
    testResult = {
      command: contract.testCommand,
      exitCode: testRun ? testRun.status : null,
      durationMs: deps.now() - testStarted,
      stdoutTail: _tail((testRun && testRun.stdout) || '', OUTPUT_TAIL_CHARS),
      stderrTail: _tail((testRun && testRun.stderr) || '', OUTPUT_TAIL_CHARS)
    };
  }

  const outcome = testResult && testResult.exitCode !== 0 ? 'test-failure' : 'success';
  return _receipt(contract, {
    outcome, startedAt, finishedAt, durationMs,
    exitCode: result.status, signal: result.signal, filesChanged: c.filesChanged, scopeViolations: [],
    testResult, claimedCompletion, stdoutTail, stderrTail
  });
}

/**
 * Assemble the final receipt object. The one place every field name and
 * default lives, so every return path in `runTask` produces the same shape.
 * @param {object} contract
 * @param {object} fields
 * @returns {object}
 */
function _receipt(contract, fields) {
  if (!OUTCOMES.includes(fields.outcome)) {
    throw new Error(`aider-task-contract: internal error — unknown outcome '${fields.outcome}'`);
  }
  return {
    schema: SCHEMA,
    repoPath: contract.repoPath,
    editableFiles: contract.editableFiles,
    outcome: fields.outcome,
    startedAt: fields.startedAt,
    finishedAt: fields.finishedAt,
    durationMs: fields.durationMs,
    exitCode: fields.exitCode,
    signal: fields.signal,
    filesChanged: fields.filesChanged,
    scopeViolations: fields.scopeViolations,
    testResult: fields.testResult,
    claimedCompletion: fields.claimedCompletion,
    claimDisputed: fields.outcome === 'no-op' && fields.claimedCompletion === true,
    stdoutTail: fields.stdoutTail,
    stderrTail: fields.stderrTail,
    error: fields.error || null
  };
}

module.exports = {
  SCHEMA,
  OUTCOMES,
  buildTaskContract,
  runTask,
  // Exported for tests only — the same names `tmux`-style stubbing tests use
  // this module's own dependency-injection seams instead, so these two stay
  // for direct unit coverage of the heuristics themselves.
  _looksBlockedOnInput,
  _claimsCompletion
};
