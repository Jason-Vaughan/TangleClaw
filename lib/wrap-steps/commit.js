'use strict';

/**
 * `commit` wrap step (#139 Chunk 9) — the single-transaction flush
 * point for the wrap pipeline. Every prior step that produced a
 * filesystem change has staged it in `context.staged`; the AI may
 * also have edited the working tree directly (e.g. the
 * `memory-update` ai-content step's MEMORY.md edit). This step is
 * the only step that touches the project's git index: it flushes
 * staged writes, runs `git add -A`, builds a session-derived commit
 * message, and produces exactly one commit (or skips when the
 * session is truly clean).
 *
 * **Single-transaction discipline.** A pipeline failure before this
 * step means the working tree is left whatever the prior steps put
 * there (the AI's MEMORY.md edit, the priming-roll's NOT-yet-flushed
 * staged content) but NO commit lands. The user fixes the blocker
 * and retries; on the next attempt, this step picks up everything
 * still in the working tree plus the staged writes from that fresh
 * run. Re-running the wrap is idempotent at the commit level — the
 * runner produces zero or one commit per invocation.
 *
 * **Skip-when-clean.** After flushing staged writes we run `git
 * status --porcelain`. If the working tree + index are empty, the
 * step returns `{ok:true, status:'skipped'}` with no SHA and no
 * `lastWrapSha` update. A truly clean session (no AI edits, no
 * priming change, no version bump) is a valid outcome — the wrap
 * pipeline still ran the verifications, just produced nothing to
 * commit.
 *
 * **`lastWrapSha` stamping.** After a successful commit, the SHA is
 * persisted on `projConfig.lastWrapSha`, so any step that needs the
 * session's true range (e.g. lint scoping) can use `<lastWrapSha>..HEAD`
 * instead of a `HEAD~10..HEAD` guess.
 *
 * **Blocker contract.** Unlike Chunks 5–8 (always-ok handlers),
 * this step IS a real blocker. `step.blocker: true` in the
 * pipeline definition means a git failure halts the pipeline.
 * Pre-commit hook failures bubble up here — the user fixes the
 * hook-rejected issue and retries the wrap. We do NOT pass
 * `--no-verify` (per CLAUDE.md's Git Safety Protocol).
 *
 * **What gets committed.** `git add -A` is intentional — the user
 * clicking Session Wrap is opting into "everything in my working
 * tree belongs to this session." If the user had unrelated changes
 * they'd have stashed them. Chunk 10's UI surfaces the about-to-
 * commit file list so the user can cancel before this step runs.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logger');
const store = require('../store');

const log = createLogger('wrap-step-commit');

const EXEC_TIMEOUT_MS = 60 * 1000;
const MAX_SUBJECT_LEN = 72;

/**
 * Thin `execFile` wrapper — resolves to a structured result; never
 * throws on non-zero exit so the caller decides what each non-zero
 * means. Mirrors the shape used by `pr-check.js` so the test harness
 * pattern carries over.
 *
 * @param {string} file - Command name (e.g. `'git'`)
 * @param {string[]} args - Args (each passed argv-style — no shell quoting needed)
 * @param {object} options
 * @param {string} options.cwd
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string}>}
 */
function defaultExec(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: options.cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
      env: process.env
    }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({
        exitCode,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString()
      });
    });
  });
}

/**
 * Flush all staged filesystem writes from prior pipeline steps. Today
 * the `priming-roll` handler is the only producer; the contract is
 * duck-typed on shape (`{primingPath, newContent, changed}`) rather
 * than keyed by step kind so any future write-producing step that
 * mimics the shape Just Works without a dispatch-table edit.
 *
 * @param {Record<string, object>} staged
 * @returns {Array<{stepId:string, path:string}>} Paths actually written
 */
function _flushStagedWrites(staged) {
  const flushed = [];
  if (!staged || typeof staged !== 'object') return flushed;
  for (const [stepId, entry] of Object.entries(staged)) {
    if (!entry || typeof entry.primingPath !== 'string' || typeof entry.newContent !== 'string') {
      continue;
    }
    // `changed === false` means the staged content matches what's
    // already on disk — skip the syscall to keep mtime stable. Any
    // other value (including missing) is treated as "needs write".
    if (entry.changed === false) continue;
    _internal.mkdirSync(path.dirname(entry.primingPath), { recursive: true });
    _internal.writeFileSync(entry.primingPath, entry.newContent);
    flushed.push({ stepId, path: entry.primingPath });
  }
  return flushed;
}

/**
 * Build the commit subject from session content. Prefers a chunk-tag
 * extracted from the current branch; falls back to the branch name;
 * finally generic. Subject is truncated to `MAX_SUBJECT_LEN` chars
 * (kebab-friendly) so `git log --oneline` stays readable.
 *
 * @param {string|null} branch
 * @returns {string}
 */
function _buildSubject(branch) {
  // Matches `chunk-9`, `chunk_9`, `chunk 9`, `chunk9`, `chunk-10c.2`, etc.
  // Word-boundary anchored to mirror priming-roll's CHUNK_TAG regex
  // shape (ADR 0002) — prevents `junkchunk-9` matching.
  const tagMatch = (branch || '').match(/\bchunk[\s\-_]?(\d+[a-z]?(?:\.\d+[a-z]?)*)/i);
  let subject;
  if (tagMatch) {
    subject = `Session wrap (chunk ${tagMatch[1]})`;
  } else if (branch) {
    subject = `Session wrap on ${branch}`;
  } else {
    subject = 'Session wrap';
  }
  if (subject.length > MAX_SUBJECT_LEN) {
    subject = subject.slice(0, MAX_SUBJECT_LEN - 1) + '…';
  }
  return subject;
}

/**
 * Walk `staged` and produce the commit-body lines describing what
 * the session did. Shape-typed on entries so any step staging the
 * documented shapes contributes without explicit registration:
 *
 *   - `{primingPath, newContent, changed, pointer}` (priming-roll)
 *       → "Priming rolled to Chunk X — Title"
 *   - `{capturedText, parsedFields}` (ai-content)
 *       → "Memory block: <step-id>" if parsedFields is non-empty;
 *         "AI content captured: <step-id>" otherwise
 *   - `{branch, sessionScoped, resolutions}` (pr-check)
 *       → "Open session-scoped PRs: N" + per-PR resolution lines (the
 *         operator's decisions; `pr-merge` applies them after this step)
 *   - `{mapRefresh:true, created, addedDirs, removedDirs}` (project-map, PIDX slice 3)
 *       → "Project Map: created (N dir(s))" when `created` (self-heal, #423),
 *         "Project Map: refreshed (+A/-R dir(s))" on a dir-count change, or
 *         "Project Map: membership/descriptions refreshed" when only the
 *         shared-dir snapshot / descriptions changed
 *   - `{featuresToc:true, created, addedCount, addedFiles}` (features-toc, #207/#425)
 *       → "Feature Index: created [(N stub(s) appended)]" when `created`
 *         (self-heal, #425), else "Feature Index: N stub(s) appended (files…)"
 *   - `{indexDescribe:true, describedCount}` (index-describe, #426)
 *       → "Index: described N stub(s)" when N > 0 (the AI filled that many
 *         empty `<!-- describe -->` stubs across the enabled index file(s))
 *   - `{oldVersion, newVersion, bumpLevel}` (version-bump)
 *       → "Bumped <old> → <new> (<level>)". Deduped — version-bump
 *         stages TWO entries (version-json + changelog) carrying the
 *         same metadata; only the first is rendered.
 *   - `{changeLogFlipped}` (version-bump prawduct release stamp, WRP-9F2K)
 *       → "Stamped N prawduct change-log entr(y|ies) status=shipped".
 *         Carries no version fields, so it never collides with the
 *         version-bump dedup above.
 *
 * Anything else is skipped silently — extra staging keys aren't an
 * error, they just don't get rendered. The body is intentionally
 * scannable in `git log` and `gh pr view` — short bulleted lines,
 * no nested code fences, no Markdown headings (which `git log
 * --oneline` would render as `#` and confuse human readers).
 *
 * @param {Record<string, object>} staged
 * @returns {string[]} Body lines (no trailing blank)
 */
function _buildBodyLines(staged) {
  const lines = [];
  if (!staged || typeof staged !== 'object') return lines;
  let emittedVersionBump = false;

  for (const [stepId, entry] of Object.entries(staged)) {
    if (!entry || typeof entry !== 'object') continue;

    // version-bump (deduped: stages two entries — version-json +
    // changelog — both carry the same bump metadata; emit one body
    // line, skip the second to avoid a duplicate "Bumped …" line.
    // Checked first so the version-bump entries don't accidentally
    // match a later duck-type via shared shape (they don't today, but
    // ordering makes the contract explicit).
    if (typeof entry.bumpLevel === 'string'
        && typeof entry.oldVersion === 'string'
        && typeof entry.newVersion === 'string') {
      if (!emittedVersionBump) {
        lines.push(`- Bumped ${entry.oldVersion} → ${entry.newVersion} (${entry.bumpLevel})`);
        emittedVersionBump = true;
      }
      continue;
    }

    // version-bump prawduct change-log release stamp (WRP-9F2K)
    if (typeof entry.changeLogFlipped === 'number') {
      lines.push(`- Stamped ${entry.changeLogFlipped} prawduct change-log ${entry.changeLogFlipped === 1 ? 'entry' : 'entries'} status=shipped`);
      continue;
    }

    // priming-roll
    if (entry.pointer && entry.pointer.current) {
      const c = entry.pointer.current;
      const title = c.title || '(untitled)';
      lines.push(`- Priming rolled to Chunk ${c.id} — ${title}`);
      if (c.blockedOn) lines.push(`  (blocked on: ${c.blockedOn})`);
      continue;
    }
    if (entry.pointer && entry.pointer.allDone) {
      lines.push(`- Priming: all chunks in plan marked done (${stepId})`);
      continue;
    }
    // NOTE: a staged priming pointer is always either `allDone` or has a
    // non-null `current`. Since #515, priming-roll's `run()` skips a
    // chunk-less plan (`### Chunk N:`-less) *before* selecting a pointer or
    // staging, so the `{current:null, allDone:false}` shape can never be
    // staged here. The former defensive "no parseable chunks" branch (and
    // its test) was removed as dead code under WRP-6C4M — the twin of the
    // `priming-roll._renderPointerBody` dead branch dropped in #517.

    // ai-content skipped via operator override (#328). Staged by
    // `ai-content.js` when `allowOverride` + `options.skipAiContent[id]`.
    // Audit-trail line so `git log` shows a content step was deliberately
    // skipped rather than silently omitted.
    if (entry.aiContentSkipped === true) {
      lines.push(`- AI content (${stepId}): skipped via user override`);
      continue;
    }

    // ai-content
    if (typeof entry.capturedText === 'string') {
      if (entry.parsedFields && typeof entry.parsedFields === 'object'
          && Object.keys(entry.parsedFields).length > 0) {
        const fields = Object.keys(entry.parsedFields).join(', ');
        lines.push(`- AI content (${stepId}): captured fields [${fields}]`);
      } else {
        lines.push(`- AI content (${stepId}): captured`);
      }
      continue;
    }

    // features-toc (#207 Chunk 3; self-heal #425) — duck-typed on the
    // explicit `featuresToc:true` discriminator + the `addedFiles` array.
    // `created:true` is the self-heal path (#425, parity with project-map's
    // #423): FEATURES.md was missing under an enabled toggle and got created
    // on wrap, with or without drifted stubs appended.
    if (entry.featuresToc === true && Array.isArray(entry.addedFiles)) {
      const n = typeof entry.addedCount === 'number' ? entry.addedCount : 0;
      if (entry.created === true) {
        lines.push(n > 0
          ? `- Feature Index: created (${n} stub(s) appended)`
          : '- Feature Index: created');
      } else if (n > 0) {
        const filesPreview = entry.addedFiles.slice(0, 3).join(', ');
        const suffix = entry.addedFiles.length > 3
          ? `, +${entry.addedFiles.length - 3} more`
          : '';
        lines.push(`- Feature Index: ${n} stub(s) appended (${filesPreview}${suffix})`);
      }
      continue;
    }

    // index-describe (#426) — duck-typed on `indexDescribe:true`. The AI
    // filled empty `<!-- describe -->` stubs in the enabled index file(s)
    // directly (the edits land via the commit's `git add -A`, not a staged
    // flush); this just surfaces the audit line with the actually-filled count.
    if (entry.indexDescribe === true && typeof entry.describedCount === 'number') {
      if (entry.describedCount > 0) {
        lines.push(`- Index: described ${entry.describedCount} stub(s)`);
      }
      continue;
    }

    // project-map (PIDX slice 3) — duck-typed on `mapRefresh:true`. The
    // staged file is flushed generically via the `{primingPath, newContent,
    // changed}` trio; this just surfaces the audit line. `created:true` is the
    // self-heal path (#423): the index was missing and got created on wrap.
    if (entry.mapRefresh === true) {
      const added = Array.isArray(entry.addedDirs) ? entry.addedDirs.length : 0;
      const removed = Array.isArray(entry.removedDirs) ? entry.removedDirs.length : 0;
      if (entry.created === true) {
        lines.push(`- Project Map: created (${added} dir(s))`);
      } else if (added > 0 || removed > 0) {
        lines.push(`- Project Map: refreshed (+${added}/-${removed} dir(s))`);
      } else {
        lines.push('- Project Map: membership/descriptions refreshed');
      }
      continue;
    }

    // pr-check
    if (Array.isArray(entry.sessionScoped)) {
      if (entry.sessionScoped.length > 0) {
        lines.push(`- Open session-scoped PRs: ${entry.sessionScoped.length}`);
      }
      if (entry.resolutions && typeof entry.resolutions === 'object') {
        for (const [prNum, action] of Object.entries(entry.resolutions)) {
          // The operator's DECISION, not an outcome: the merge is enqueued by
          // `pr-merge` after this step runs, so claiming anything about the
          // result here would be a guess.
          lines.push(`  - PR #${prNum}: ${action}`);
        }
      }
    }
  }
  return lines;
}

/**
 * Assemble the full commit message: subject + blank + body.
 *
 * @param {Record<string, object>} staged
 * @param {string|null} branch
 * @returns {string}
 */
function _buildMessage(staged, branch) {
  const subject = _buildSubject(branch);
  const body = _buildBodyLines(staged);
  if (body.length === 0) return subject;
  return `${subject}\n\n${body.join('\n')}`;
}

/**
 * Build the auto-PR body for an auto-branched wrap commit (#467).
 * Sections follow the house What/Why convention; the wrap commit's
 * body lines are embedded so `gh pr view` shows what the wrap did
 * without opening the commit.
 *
 * @param {string} wrapBranch - The `wrap/<ts>-<slug>` head branch
 * @param {string} originalBranch - The protected base branch (`main`/`master`)
 * @param {string[]} bodyLines - Output of `_buildBodyLines(staged)`
 * @returns {string}
 */
function _buildAutoPrBody(wrapBranch, originalBranch, bodyLines) {
  const what = bodyLines.length > 0
    ? bodyLines.join('\n')
    : '- Session-wrap artifacts (no structured body lines)';
  return [
    '## What',
    `Lands the session-wrap commit from \`${wrapBranch}\` onto \`${originalBranch}\`.`,
    '',
    what,
    '',
    '## Why',
    `Wrap commits auto-branch off protected branches; without a PR they dangle and the wrap's artifacts (version bump, CHANGELOG promotion, index files, memory updates) never reach \`${originalBranch}\`.`,
    '',
    '## Test plan',
    '- Automated wrap PR opened by the TangleClaw wrap pipeline; artifacts were produced by the wrap steps against the session\'s final verified state.'
  ].join('\n');
}

/**
 * #467 — close the loop on an auto-branched wrap commit. Push the wrap
 * branch, open a PR back to the original branch via `gh`, arm
 * auto-merge (`--auto --squash --delete-branch` — branch protection
 * still gates; this only removes the wait), and return the checkout to
 * the original branch on full success.
 *
 * **Never fatal.** The commit already landed when this runs; every
 * sub-step degrades to a structured `{skippedReason|error, remediation}`
 * so the wrap result stays `done` and the drawer can render the
 * partial outcome. Failure policy for the checkout: HEAD returns to the
 * original branch ONLY when auto-merge was armed (the commit is then
 * guaranteed to land server-side). On any earlier failure HEAD stays on
 * the wrap branch — the visible dangling branch is the operator's cue
 * to rescue manually, exactly as before #467.
 *
 * Gates, in order:
 *   1. `projConfig.wrapAutoPrEnabled === false` → skip (per-project opt-out;
 *      a config-load failure counts as enabled — default-on is the fix).
 *   2. No `origin` remote → skip (local-only repo, nowhere to land).
 *   3. `gh --version` fails → push-only (the branch at least survives
 *      remotely), skip the PR with a manual-command remediation.
 *
 * The `chore` label is best-effort via `gh pr edit --add-label` — a
 * missing label in the target repo must not fail the close-loop.
 *
 * @param {object} params
 * @param {string} params.cwd - Project path (git working tree)
 * @param {string} params.branch - The wrap branch the commit landed on
 * @param {string} params.originalBranch - The protected branch wrap fired from
 * @param {object} params.staged - Pipeline staged scratch (for PR body lines)
 * @returns {Promise<{attempted:boolean, pushed:boolean, prUrl:string|null,
 *   autoMergeArmed:boolean, returnedToBranch:boolean,
 *   skippedReason:string|null, error:string|null, remediation:string|null}>}
 */
async function _autoPrCloseLoop({ cwd, branch, originalBranch, staged }) {
  const result = {
    attempted: false,
    pushed: false,
    prUrl: null,
    autoMergeArmed: false,
    returnedToBranch: false,
    skippedReason: null,
    error: null,
    remediation: null
  };

  let enabled = true;
  try {
    const cfg = store.projectConfig.load(cwd);
    if (cfg && cfg.wrapAutoPrEnabled === false) enabled = false;
  } catch (_) { /* unreadable config → default-on */ }
  if (!enabled) {
    result.skippedReason = 'wrapAutoPrEnabled is false for this project';
    return result;
  }

  const remoteRes = await _internal.exec('git', ['remote', 'get-url', 'origin'], { cwd });
  if (remoteRes.exitCode !== 0) {
    result.skippedReason = 'no origin remote — nowhere to land the wrap branch';
    return result;
  }

  result.attempted = true;

  const pushRes = await _internal.exec('git', ['push', '-u', 'origin', branch], { cwd });
  if (pushRes.exitCode !== 0) {
    const detail = pushRes.stderr.trim() || pushRes.stdout.trim();
    result.error = `git push failed (exit ${pushRes.exitCode}): ${detail}`;
    result.remediation = `The wrap commit is safe on local branch ${branch}. Push it and open a PR manually: git push -u origin ${branch} && gh pr create --base ${originalBranch} --head ${branch}`;
    return result;
  }
  result.pushed = true;

  const ghRes = await _internal.exec('gh', ['--version'], { cwd });
  if (ghRes.exitCode !== 0) {
    result.skippedReason = 'gh CLI not available — branch pushed, PR not opened';
    result.remediation = `Open the PR manually: gh pr create --base ${originalBranch} --head ${branch} (or use the GitHub web UI — the branch is pushed).`;
    return result;
  }

  const subject = _buildSubject(branch);
  const body = _buildAutoPrBody(branch, originalBranch, _buildBodyLines(staged));
  const createRes = await _internal.exec('gh', [
    'pr', 'create', '--base', originalBranch, '--head', branch,
    '--title', subject, '--body', body
  ], { cwd });
  if (createRes.exitCode !== 0) {
    const detail = createRes.stderr.trim() || createRes.stdout.trim();
    result.error = `gh pr create failed (exit ${createRes.exitCode}): ${detail}`;
    result.remediation = `The wrap branch is pushed. Open the PR manually: gh pr create --base ${originalBranch} --head ${branch}`;
    return result;
  }
  const urlMatch = createRes.stdout.match(/https:\/\/\S+\/pull\/\d+/);
  result.prUrl = urlMatch ? urlMatch[0] : null;

  if (result.prUrl) {
    // Best-effort label — a repo without the label must not fail the loop.
    await _internal.exec('gh', ['pr', 'edit', result.prUrl, '--add-label', 'chore'], { cwd });
  }

  const mergeTarget = result.prUrl || branch;
  const mergeRes = await _internal.exec('gh', [
    'pr', 'merge', mergeTarget, '--auto', '--squash', '--delete-branch'
  ], { cwd });
  if (mergeRes.exitCode !== 0) {
    const detail = mergeRes.stderr.trim() || mergeRes.stdout.trim();
    result.error = `gh pr merge --auto failed (exit ${mergeRes.exitCode}): ${detail}`;
    result.remediation = 'The PR is open but auto-merge could not be armed. Enable auto-merge in the repo (Settings → General → Pull Requests) or merge the PR manually once checks pass.';
    return result;
  }
  result.autoMergeArmed = true;

  // Full success — return the checkout to the original branch so the
  // next session starts from the protected branch, not the wrap branch.
  // `gh pr merge --delete-branch` may already have switched HEAD; a
  // checkout onto the current branch exits 0, so this is idempotent.
  const coRes = await _internal.exec('git', ['checkout', originalBranch], { cwd });
  result.returnedToBranch = coRes.exitCode === 0;

  return result;
}

/**
 * Stamp `lastWrapSha` on the project's persisted config. Non-fatal
 * on failure — the commit already landed, the stamp is a hint for
 * later steps' range detection. We log and continue.
 *
 * Concurrent wraps on the same project are not supported by the
 * runner; this load → mutate → save sequence is therefore lock-free
 * by design. If concurrent wrap support is added later, this site
 * needs a file lock or moved into the store DB.
 *
 * @param {string} projectPath
 * @param {string} sha - The base the next session measures its range from — the
 *   wrap commit's PARENT (or the wrap commit itself when it is a parentless root
 *   commit), chosen because the parent survives the squash-merge that lands the
 *   wrap on a protected branch (see the call site, #664).
 * @returns {boolean} True iff the stamp was persisted
 */
function _stampLastWrapSha(projectPath, sha) {
  try {
    const cfg = store.projectConfig.load(projectPath);
    cfg.lastWrapSha = sha;
    store.projectConfig.save(projectPath, cfg);
    return true;
  } catch (err) {
    log.warn('Failed to stamp lastWrapSha on projConfig', {
      projectPath,
      sha,
      error: err.message
    });
    return false;
  }
}

/**
 * Step handler. See module docstring for full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (must include `path`)
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, staged } = context;

  if (!project || !project.path) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: ['commit step requires context.project.path']
    };
  }
  const cwd = project.path;

  // 1. Flush staged writes. Wrapped in try/catch so a single bad
  //    staging entry doesn't tear down the whole pipeline — the
  //    error surfaces as a blocker.
  let flushed;
  try {
    flushed = _flushStagedWrites(staged);
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: [`Failed to flush staged write: ${err.message}`]
    };
  }

  // 2. Detect "anything to commit?" via `git status --porcelain`.
  //    Empty output = working tree clean + index empty.
  const statusRes = await _internal.exec('git', ['status', '--porcelain'], { cwd });
  if (statusRes.exitCode !== 0) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: [`git status failed (exit ${statusRes.exitCode}): ${statusRes.stderr.trim() || statusRes.stdout.trim()}`]
    };
  }
  const statusOutput = statusRes.stdout;
  if (!statusOutput.trim()) {
    log.info('commit step skipped — no changes to commit', { project: project.name });
    return {
      ok: true,
      status: 'skipped',
      output: {
        reason: 'no changes to commit',
        flushed,
        commitSha: null
      },
      blockers: []
    };
  }

  // 3. Capture current branch for subject-building. Detached / missing
  //    git → null and the subject falls back to generic. Branch detection
  //    failure must NOT block the commit — the commit itself is what
  //    matters.
  let branch = null;
  try {
    const br = await _internal.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    if (br.exitCode === 0) {
      const name = br.stdout.trim();
      if (name && name !== 'HEAD') branch = name;
    }
  } catch (_) { /* branch stays null */ }

  // 3a. #264 / ADR 0002 amendment (2026-05-30): auto-branch when wrap
  //     fires on `main`/`master`. Per CLAUDE.md "direct main commits
  //     only for trivial doc edits or incident hot-fixes" and per the
  //     631acb5 regression incident (a Critic-blocking commit landed
  //     directly on main because no branching pressure existed), the
  //     pipeline now creates a `wrap/<ts>-<slug>` branch and commits
  //     there instead. Escape hatch: `context.options.allowDirectToMain`
  //     bypasses entirely — for trivial doc fixes or hot-fixes where
  //     the operator explicitly opts in via the wrap drawer UI.
  //
  //     Branch detection failures (branch === null) are NOT auto-
  //     branched — we can't know what we're protecting against.
  //
  //     A failed `git checkout -b` is a blocker — the operator's
  //     intent ("safely wrap to a branch") was clear; silently
  //     committing to main against that intent would be worse than
  //     halting.
  const directToMainAllowed = !!(context.options && context.options.allowDirectToMain === true);
  const onProtectedBranch = branch === 'main' || branch === 'master';
  const shouldAutoBranch = onProtectedBranch && !directToMainAllowed;
  let originalBranch = branch;
  let autoBranched = false;
  if (shouldAutoBranch) {
    const slug = (project.name || 'session')
      .replace(/[^A-Za-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 40) || 'session';
    // YYYYMMDDHHMMSS — kebab-friendly, sortable, no ambiguity. Built from
    // UTC for cross-host consistency (same as `lastSync` in sync-manifest).
    const ts = new Date().toISOString()
      .replace(/[-:T.]/g, '')
      .slice(0, 14);
    const wrapBranchName = `wrap/${ts}-${slug}`;
    const checkoutRes = await _internal.exec('git', ['checkout', '-b', wrapBranchName], { cwd });
    if (checkoutRes.exitCode !== 0) {
      const detail = checkoutRes.stderr.trim() || checkoutRes.stdout.trim();
      // NOTE (post-#264 Critic NOTE): staged writes from step 1
      // (`_flushStagedWrites`) have already landed on disk by this
      // point. Today's producers (`priming-roll`, `version-bump`) write
      // intentional session artifacts that are safe to leave in the
      // working tree on a halted wrap — the operator typically retries
      // after addressing the auto-branch failure, and the same artifacts
      // are re-staged on retry idempotently. If a future write step has
      // side effects that should NOT persist across a halted wrap, this
      // path needs a working-tree rollback (e.g., `git checkout -- .`
      // before returning) — keeping that exception explicit because the
      // single-transaction discipline in the module docstring expects
      // the wrap drawer's "retry" affordance to handle leak cleanup.
      return {
        ok: false,
        status: 'blocked',
        output: { branch: originalBranch, attemptedWrapBranch: wrapBranchName },
        blockers: [
          `Auto-branch failed (exit ${checkoutRes.exitCode}): ${detail}`,
          'Set context.options.allowDirectToMain to bypass auto-branching.'
        ]
      };
    }
    branch = wrapBranchName;
    autoBranched = true;
    log.info('commit step auto-branched off protected branch', {
      project: project.name,
      from: originalBranch,
      to: wrapBranchName
    });
  }

  // 4. Build commit message.
  const message = _buildMessage(staged, branch);

  // 5. Stage everything in the working tree. The user clicking Wrap is
  //    opting into "everything in my working tree belongs to this
  //    session." Chunk 10's UI surfaces the about-to-commit list so the
  //    user can cancel before this step runs.
  const addRes = await _internal.exec('git', ['add', '-A'], { cwd });
  if (addRes.exitCode !== 0) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: [`git add -A failed (exit ${addRes.exitCode}): ${addRes.stderr.trim() || addRes.stdout.trim()}`]
    };
  }

  // 6. Commit. `execFile` doesn't go through a shell, so multi-line
  //    messages with quotes, newlines, and special chars pass through
  //    to `git commit -m` byte-intact via argv-style — no shell-quoting
  //    math required. Node hands `args` straight to the child's argv[].
  const commitRes = await _internal.exec('git', ['commit', '-m', message], { cwd });
  if (commitRes.exitCode !== 0) {
    // Pre-commit hook failures land here. Surface the hook output
    // verbatim so the user sees what to fix. Per CLAUDE.md's Git
    // Safety Protocol we don't pass --no-verify — the hook is the
    // user's intentional gate.
    const detail = commitRes.stderr.trim() || commitRes.stdout.trim();
    return {
      ok: false,
      status: 'blocked',
      output: {
        flushed,
        message,
        branch,
        remediation: 'The commit was rejected — most often by a pre-commit hook (e.g. husky running tests or lint). Read the hook output above, fix what it flagged, then re-run the wrap. The wrap pipeline never passes `--no-verify`; the hook is your intentional gate.'
      },
      blockers: [`git commit failed (exit ${commitRes.exitCode}): ${detail}`]
    };
  }

  // 7. Capture the resulting SHA. `git rev-parse HEAD` is the
  //    canonical post-commit handle — `git commit` itself prints a
  //    short SHA but parsing that is fragile across git versions.
  let commitSha = null;
  const shaRes = await _internal.exec('git', ['rev-parse', 'HEAD'], { cwd });
  if (shaRes.exitCode === 0) {
    commitSha = shaRes.stdout.trim() || null;
  }
  // If rev-parse failed, the commit still landed — we just couldn't
  // capture the SHA. Log it; don't block. Downstream consumers
  // (Chunk 10 UI, lastWrapSha stamping) handle null gracefully.
  if (commitSha === null) {
    log.warn('git rev-parse HEAD failed after commit landed', {
      project: project.name,
      exitCode: shaRes.exitCode,
      stderr: shaRes.stderr.trim().slice(0, 200)
    });
  }

  // 8. Stamp lastWrapSha — the base the NEXT session measures its range from.
  //    Record the wrap commit's PARENT, not the wrap commit itself: this wrap
  //    lands on a protected branch by squash-merge, which replaces the wrap
  //    commit with a brand-new commit and orphans the one made here. Stamping the
  //    orphaned SHA leaves the next session with a `lastWrapSha` that is not an
  //    ancestor of HEAD, so `<lastWrapSha>..HEAD` balloons back to the last shared
  //    ancestor — many sessions of already-released work (#664). The parent is the
  //    pre-wrap tip; squash-merge stacks the new commit on top of it, so the parent
  //    stays an ancestor and `parent..HEAD` is exactly the next session's work
  //    (the squashed wrap commit falls in range but is excluded by subject).
  let baseSha = null;
  const parentRes = await _internal.exec('git', ['rev-parse', '--verify', '--quiet', 'HEAD~1'], { cwd });
  if (parentRes.exitCode === 0) {
    baseSha = parentRes.stdout.trim() || null;
  } else {
    // Almost always a root commit (a repo whose first-ever commit is a wrap) — the
    // fallback below stamps the wrap commit itself. Logged, not silent, so the rare
    // non-root failure (a broken git that also failed the step-7 HEAD capture) is
    // visible when someone asks why the range base looks wrong.
    log.info('git rev-parse HEAD~1 found no parent; stamping the wrap commit as the range base', {
      project: project.name, exitCode: parentRes.exitCode
    });
  }
  // A wrap commit with no parent (a repo whose first-ever commit is a wrap) has no
  // pre-wrap base — fall back to the wrap commit's own SHA rather than skip the
  // stamp, so the next session still has a boundary to measure from.
  const stampSha = baseSha || commitSha;
  let stamped = false;
  if (stampSha) {
    stamped = _stampLastWrapSha(project.path, stampSha);
  }

  // 9. #467 — close the loop on an auto-branched commit. Without this,
  //    the wrap commit dangles on the wrap branch: version bumps,
  //    CHANGELOG promotions, and self-healed index files never reach
  //    the protected branch, and the next wrap re-creates them from
  //    scratch (the #447/#450/#453 dangling-wrap class). Never fatal —
  //    the commit already landed; see _autoPrCloseLoop's contract.
  let autoPr = null;
  if (autoBranched) {
    try {
      autoPr = await _autoPrCloseLoop({ cwd, branch, originalBranch, staged });
    } catch (err) {
      autoPr = {
        attempted: true,
        pushed: false,
        prUrl: null,
        autoMergeArmed: false,
        returnedToBranch: false,
        skippedReason: null,
        error: `auto-PR close-loop threw: ${err.message}`,
        remediation: `The wrap commit is safe on local branch ${branch}. Push it and open a PR manually.`
      };
    }
    if (autoPr.error) {
      log.warn('wrap auto-PR close-loop degraded', {
        project: project.name, branch, error: autoPr.error
      });
    } else {
      log.info('wrap auto-PR close-loop finished', {
        project: project.name,
        branch,
        pushed: autoPr.pushed,
        prUrl: autoPr.prUrl,
        autoMergeArmed: autoPr.autoMergeArmed,
        skippedReason: autoPr.skippedReason
      });
    }
  }

  log.info('commit step done', {
    project: project.name,
    commitSha,
    branch,
    flushedCount: flushed.length,
    stamped
  });

  return {
    ok: true,
    status: 'done',
    output: {
      commitSha,
      message,
      branch,
      flushed,
      stamped,
      // #264 — surface the auto-branch decision so Chunk 10's UI can
      // render "Wrap committed on branch <X> (auto-branched off
      // <originalBranch>)" alongside a "Push + open PR" affordance.
      // `autoBranched: false` covers both the on-feature-branch case
      // (no auto-branch needed) and the explicit-allowDirectToMain
      // escape hatch.
      autoBranched,
      originalBranch,
      // #467 — auto-PR close-loop result for auto-branched commits;
      // null when no auto-branch happened (nothing dangles). The drawer
      // renders the outcome on the commit row's detail line.
      autoPr
    },
    blockers: []
  };
}

const _internal = {
  exec: defaultExec,
  writeFileSync: fs.writeFileSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs)
};

module.exports = {
  run,
  _internal,
  _flushStagedWrites,
  _buildSubject,
  _buildBodyLines,
  _buildMessage,
  _buildAutoPrBody,
  _autoPrCloseLoop,
  _stampLastWrapSha,
  MAX_SUBJECT_LEN
};
