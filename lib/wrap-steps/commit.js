'use strict';

/**
 * `commit` wrap step (#139 Chunk 9) — the single-transaction flush
 * point for the wrap pipeline. Every prior step that produced a
 * filesystem change has staged it in `context.staged`; the AI may
 * also have edited the working tree directly (e.g. the
 * `memory-update` ai-content step's MEMORY.md edit). This step is
 * the only step that touches the project's git index: it flushes
 * staged writes, stages the paths this wrap may commit, builds a
 * session-derived commit message, and produces exactly one commit (or
 * skips when there is nothing of the session's to commit).
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
 * **Release-prepare command (#1502).** When the staged writes carry a release
 * cut and the project sets `releasePrepareCommand`, the command runs right after
 * the flush, and the paths it changed are committed as the wrap's own writes. A
 * failing command is the one halt here that restores the flushed files: a Retry
 * must find `[Unreleased]` still there to cut, or it would commit the bump
 * without the files the command exists to add. See `_runReleasePrepare`.
 *
 * **A release cut is recoverable until its commit lands (#1220).** `version-bump`
 * stages the promoted `CHANGELOG.md`, the bumped version file and, as
 * `{primingPath, newContent:null, delete:true}` entries, the deletion of every
 * changelog fragment it compiled. Before the flush, this step reads each target's
 * prior bytes and the index entries of exactly those targets, and writes both to
 * `.tangleclaw/release-recovery/<run id>/` under the project's config root (one
 * file per target plus `manifest.json`). Any halt after the flush and before a
 * successful commit puts the work tree back from that snapshot, and the index
 * entries too once `git add` has run; a commit that was stopped by its timeout
 * restores nothing, because it may still land. The artifact is removed only
 * after the commit succeeds or a restore puts everything back; while one exists,
 * `version-bump` refuses to cut, so a fragment is compiled once and never twice.
 * See `_prepareReleaseRecovery` and `_recoverRelease`.
 *
 * **Skip-when-clean.** After flushing staged writes we run `git
 * status --porcelain`. If the working tree + index are empty, the
 * step returns `{ok:true, status:'skipped'}` with no SHA and no
 * `lastWrapSha` update. A truly clean session (no AI edits, no
 * priming change, no version bump) is a valid outcome — the wrap
 * pipeline still ran the verifications, just produced nothing to
 * commit.
 *
 * **Skip-when-not-a-repository (#2008).** A project whose folder is not a git
 * repository is skipped too, after the flush (so the wrap's files are written in
 * place) and before `git status`, which would fail there and halt every later
 * step. The scope says which case it is: no toplevel and no `workTreeProblem`
 * is not a repository; no toplevel WITH one is git failing to answer, which
 * still blocks.
 *
 * **The answers, recorded (#2155).** Every commit and every skip writes one
 * `wrap.commit_answers` activity row: the paths answered Include, the paths
 * answered Leave (as given, so an ignored answer can be told from one never
 * given), and the session's own paths that were committed. Path names only. A
 * blocked commit writes none — it neither committed nor skipped.
 *
 * **`lastWrapSha` stamping.** After a successful commit, the SHA is
 * persisted in the checkout's untracked wrap state (`lib/wrap-state.js`), so any step that needs the
 * session's true range (e.g. lint scoping) can use `<lastWrapSha>..HEAD`
 * instead of a `HEAD~10..HEAD` guess. The value it REPLACES rides the two
 * outcomes a later step can act on — committed and skipped — as
 * `output.previousWrapSha`, alongside `previousWrapShaRead` saying whether
 * it was recorded, absent, or unreadable; the steps that run after this
 * one need the boundary the previous wrap left, can no longer read it from
 * disk, and act differently on the three (#797). A BLOCKED outcome carries
 * neither, deliberately: `blocker` is operator-overridable
 * (`lib/wrap-step-overrides.js`), so a project can let a blocked commit
 * fall through, and a consumer must be able to see that this step reached
 * no conclusion rather than read an absent field as an absent boundary.
 * `continuity-write` keys on exactly that — no output, no stamp.
 *
 * **Blocker contract.** Unlike Chunks 5–8 (always-ok handlers),
 * this step IS a real blocker. `step.blocker: true` in the
 * pipeline definition means a git failure halts the pipeline.
 * Pre-commit hook failures bubble up here — the user fixes the
 * hook-rejected issue and retries the wrap. We do NOT pass
 * `--no-verify` (per CLAUDE.md's Git Safety Protocol).
 *
 * **What gets committed (#1406).** Not everything in the working tree. This
 * step used to run `git add -A` on the assumption that an operator pressing
 * Session Wrap had already set aside unrelated changes; nobody did, and a
 * co-resident session's half-finished work landed in a "Session wrap" commit.
 * Now only three kinds of path are staged and committed: files changed since
 * the session launched, files this wrap wrote, and files the operator chose to
 * include (`options.pathDecisions`). Anything else blocks until the operator
 * decides, and a path they leave out stays uncommitted. `./_file-ownership` is
 * the rule; the `session-files` step asks for the decisions before the content
 * steps run, and this step checks again because it is the one that commits.
 * A file that matches a secret pattern is held back the same way until the
 * operator decides (#1513, `./_secret-check`), scanned here after the flush so
 * the wrap's own writes are read as they will be committed.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLogger } = require('../logger');
const ownership = require('./_file-ownership');
const upstreamProvenance = require('./_upstream-provenance');
const untrackOffer = require('./_untrack-offer');
const secretCheck = require('./_secret-check');
const store = require('../store');
const wrapState = require('../wrap-state');
const { configRootOf } = require('./_config-root');
const { redactRemoteOutput, detailFromFailure, stripRemoteCredentials } = require('../remote-output');
const strandedWraps = require('../stranded-wraps');
const governance = require('../governance-state');
const { execFileArgs, execShell } = require('../exec');
// The one spelling of the recovery directory, owned by the step that refuses to
// cut while one exists.
const { RELEASE_RECOVERY_REL } = require('./version-bump');
// #1172 — one resolver, shared with `pr-merge.js`'s own auto-merge arm, so the
// two merge-enqueueing call sites in a wrap can never disagree about the flag.
const { resolveWrapMergeMethod } = require('./pr-merge');

const log = createLogger('wrap-step-commit');

const EXEC_TIMEOUT_MS = 60 * 1000;
const RELEASE_PREPARE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER_BYTES = 5 * 1024 * 1024;
const MAX_SUBJECT_LEN = 72;

/**
 * This step's git runner: the shared argv-style runner plus this step's caps.
 *
 * Argv-style, not shell — `git commit -m` receives a multi-line message whose
 * quotes, newlines and backticks must reach the child's `argv[]` byte-intact.
 *
 * The caps are overridable ONLY so a guard can drive the timeout path in
 * milliseconds instead of waiting out the real minute. Production callers pass
 * neither. Without that seam the mapping from a real kill to `timedOut` is the
 * one thing no test could reach — which is exactly where this defect lived
 * undetected (#897).
 *
 * @param {string} file - Command name (e.g. `'git'`)
 * @param {string[]} args - Args (each passed argv-style — no shell quoting needed)
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
    env: options.env,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : EXEC_TIMEOUT_MS,
    maxBufferBytes: Number.isFinite(options.maxBufferBytes)
      ? options.maxBufferBytes : MAX_BUFFER_BYTES
  });
}

/**
 * Name what happened to a git command, in words the operator can act on.
 *
 * A command this step KILLED and a command that ran and REPORTED A PROBLEM need
 * different sentences: "git commit failed" is a false statement about a commit
 * that was stopped at sixty seconds, and every remediation downstream of it
 * then explains a cause nobody observed (#897, and #894 before it).
 *
 * The timeout wording quotes the runner's own `error` rather than restating
 * `EXEC_TIMEOUT_MS`, so the number the operator reads is the wall clock that
 * actually applied and cannot drift from it.
 *
 * @param {{exitCode:number, timedOut:boolean, error:(string|null)}} res - An exec result.
 * @param {string} what - The command, as the operator would name it.
 * @returns {string} A clause suitable as the head of a blocker line.
 */
function _describeOutcome(res, what) {
  if (!res.timedOut) return `${what} failed (exit ${res.exitCode})`;
  return `${what} did not finish and was stopped (${res.error || 'timed out'})`;
}

/**
 * Whether a staged entry asks the flush to write a file:
 * `{primingPath, newContent:string}`.
 *
 * @param {*} entry - A staged entry
 * @returns {boolean}
 */
function _isWriteEntry(entry) {
  return !!entry && typeof entry.primingPath === 'string' && typeof entry.newContent === 'string';
}

/**
 * Whether a staged entry asks the flush to delete a file:
 * `{primingPath, newContent:null, delete:true}` (#1220). A changelog fragment
 * the release compiled is staged this way by `version-bump`, so the same flush,
 * snapshot and restore that carry the promoted `CHANGELOG.md` carry its
 * deletion. `newContent` must be exactly `null`: an entry with no content at all
 * is still skipped, as it always was.
 *
 * @param {*} entry - A staged entry
 * @returns {boolean}
 */
function _isDeleteEntry(entry) {
  return !!entry && typeof entry.primingPath === 'string' && entry.newContent === null && entry.delete === true;
}

/**
 * Flush all staged filesystem writes from prior pipeline steps. The contract is
 * duck-typed on shape (`{primingPath, newContent, changed}`, or the delete shape
 * {@link _isDeleteEntry} names) rather than keyed by step kind so any future
 * write-producing step that mimics the shape Just Works without a
 * dispatch-table edit.
 *
 * A delete target that is already gone is an error, not a silent success: a
 * fragment deleted twice is one the release compiled from a tree this step did
 * not read, and the throw is what makes the caller put everything back.
 *
 * @param {Record<string, object>} staged
 * @returns {Array<{stepId:string, path:string, deleted?:true}>} Paths actually
 *   written, and paths actually deleted (marked `deleted`)
 */
function _flushStagedWrites(staged) {
  const flushed = [];
  if (!staged || typeof staged !== 'object') return flushed;
  for (const [stepId, entry] of Object.entries(staged)) {
    if (!_isWriteEntry(entry) && !_isDeleteEntry(entry)) continue;
    // `changed === false` means the staged content matches what's
    // already on disk — skip the syscall to keep mtime stable. Any
    // other value (including missing) is treated as "needs write".
    if (entry.changed === false) continue;
    if (_isDeleteEntry(entry)) {
      _internal.rmSync(entry.primingPath, { force: false });
      flushed.push({ stepId, path: entry.primingPath, deleted: true });
      continue;
    }
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
 *   - `{indexDescribe:true, describedCount, graduatedCount}` (index-describe, #426/#568)
 *       → "Feature Index: graduated N entr(y/ies)" when graduatedCount > 0 (the
 *         AI named + filed that many TODO-block entries into real categories),
 *         and/or "Index: described N stub(s)" when describedCount > 0 (empty
 *         `<!-- describe -->` stubs filled). Both, one, or neither may render.
 *   - `{oldVersion, newVersion, bumpLevel}` (version-bump)
 *       → "Bumped <old> → <new> (<level>)". Deduped — version-bump
 *         stages TWO entries (version-json + changelog) carrying the
 *         same metadata; only the first is rendered.
 *   - `{primingPath, newContent:null, delete:true, fragment:true}` (version-bump, #1220)
 *       → "Compiled N changelog fragment(s)", once, right after the
 *         "Bumped" line: one entry per fragment the release consumed.
 *   - `{sessionFiles, includedFiles}` (commit itself, #1724)
 *       → "Session files (…): a, b" and "Included by the operator (…): c",
 *         each only when non-empty
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
  let fragments = 0;

  for (const [stepId, entry] of Object.entries(staged)) {
    if (!entry || typeof entry !== 'object') continue;

    // version-bump (deduped: stages two entries — version-json +
    // changelog — both carry the same bump metadata; emit one body
    // line, skip the second to avoid a duplicate "Bumped …" line.
    // Checked first so the version-bump entries don't accidentally
    // match a later duck-type via shared shape (they don't today, but
    // ordering makes the contract explicit).
    if (_isReleaseEntry(entry)) {
      if (!emittedVersionBump) {
        lines.push(`- Bumped ${entry.oldVersion} → ${entry.newVersion} (${entry.bumpLevel})`);
        emittedVersionBump = true;
      }
      continue;
    }

    // A changelog fragment the release consumed (#1220): counted here, written
    // as one line beside the "Bumped" line after the walk.
    if (_isDeleteEntry(entry) && entry.fragment === true) {
      fragments += 1;
      continue;
    }

    // releasePrepareCommand's files that went into this commit (#1502). Staged by
    // `run()` so the auto-PR body carries the same line as the commit message.
    if (Array.isArray(entry.releaseCompanions)) {
      if (entry.releaseCompanions.length > 0) {
        lines.push(`- Release files updated by releasePrepareCommand: ${entry.releaseCompanions.join(', ')}`);
      }
      continue;
    }

    // TangleClaw state the operator approved removing from tracking (#1512).
    if (Array.isArray(entry.untrackState)) {
      if (entry.untrackState.length > 0) {
        lines.push(`- Stopped tracking TangleClaw state (the files stay on disk): ${entry.untrackState.join(', ')}`);
      }
      continue;
    }

    // The session's own files and the ones the operator admitted (#1724). Both
    // bodies render from this one entry, so the PR a reviewer reads and the
    // commit that lands name the same files.
    if (Array.isArray(entry.sessionFiles) || Array.isArray(entry.includedFiles)) {
      const sessionFiles = entry.sessionFiles || [];
      const includedFiles = entry.includedFiles || [];
      if (sessionFiles.length > 0) {
        lines.push(`- Session files (changed since this session launched): ${sessionFiles.join(', ')}`);
      }
      if (includedFiles.length > 0) {
        lines.push(`- Included by the operator (not provably this session's, or new to the repository): ${includedFiles.join(', ')}`);
      }
      continue;
    }

    // TangleClaw's own edits to tracked files, committed without asking (#1509).
    if (Array.isArray(entry.tangleclawMaintenance)) {
      if (entry.tangleclawMaintenance.length > 0) {
        lines.push(`- TangleClaw maintenance (changed only where TangleClaw writes): ${entry.tangleclawMaintenance.join(', ')}`);
      }
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

    // preflight passed over by the operator's "Wrap anyway" (#1229). Staged by
    // `preflight.js`; the line says the gates were not met, not that they cleared.
    if (entry.preflightOverride === true) {
      lines.push(`- Preflight (${stepId}): prawduct gates passed over — operator chose to wrap anyway`);
      continue;
    }

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
      // #640: dead auto-stubs pruned this wrap (self-healed dangling citations).
      // Independent of the append line above — a wrap can prune with no drift.
      const pruned = typeof entry.prunedCount === 'number' ? entry.prunedCount : 0;
      if (pruned > 0) {
        lines.push(`- Feature Index: pruned ${pruned} dead stub(s)`);
      }
      continue;
    }

    // index-describe (#426) — duck-typed on `indexDescribe:true`. The AI
    // filled empty `<!-- describe -->` stubs in the enabled index file(s)
    // directly (the edits land via the commit's `git add -A`, not a staged
    // flush); this just surfaces the audit line with the actually-filled count.
    if (entry.indexDescribe === true
        && (typeof entry.describedCount === 'number' || typeof entry.graduatedCount === 'number')) {
      if (typeof entry.graduatedCount === 'number' && entry.graduatedCount > 0) {
        lines.push(`- Feature Index: graduated ${entry.graduatedCount} entr${entry.graduatedCount === 1 ? 'y' : 'ies'}`);
      }
      if (typeof entry.describedCount === 'number' && entry.describedCount > 0) {
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
  if (fragments > 0) {
    const line = `- Compiled ${fragments} changelog fragment(s)`;
    const bumped = lines.findIndex((l) => l.startsWith('- Bumped '));
    if (bumped === -1) lines.push(line);
    else lines.splice(bumped + 1, 0, line);
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
 * @param {string|null} [notArmedBecause] - Why nothing arms auto-merge on this
 *   pull request, from `lib/merge-authority.js`; null when the wrap arms it
 * @returns {string}
 */
function _buildAutoPrBody(wrapBranch, originalBranch, bodyLines, notArmedBecause = null) {
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
    '- Automated wrap PR opened by the TangleClaw wrap pipeline; artifacts were produced by the wrap steps against the session\'s final verified state.',
    // A reader of the pull request cannot see the wrap's result, and an open
    // wrap PR otherwise looks like one that is about to land by itself.
    ...(notArmedBecause ? ['', '## Who merges this', `Auto-merge is not armed, on purpose. ${notArmedBecause}`] : [])
  ].join('\n');
}

/**
 * Is this close-loop result a *stranded* wrap — a branch on the remote that
 * nothing will ever land?
 *
 * The commit is safe, but no PR exists to merge it, and the only cue the
 * operator gets — HEAD left on the wrap branch — is erased by any later
 * checkout on a shared clone. It reads as success unless it is called out, so
 * every surface that classifies an outcome must agree on this one predicate;
 * `public/wrap-drawer.js` mirrors it, and a test pins the two together.
 *
 * `autoMergeArmed` is load-bearing, not decoration: when `gh pr create`
 * succeeds but its URL cannot be parsed out of stdout, the arm step falls back
 * to the branch name and can still arm auto-merge. That PR exists and will
 * land, so a missing `prUrl` alone would call it stranded when it is not.
 *
 * The pre-push refusals (opt-out, no origin) push nothing, so nothing is left
 * behind and they are not stranded.
 *
 * @param {{pushed:boolean, prUrl:string|null, autoMergeArmed:boolean}} autoPr
 * @returns {boolean}
 */
function _isStranded(autoPr) {
  if (!autoPr) return false;
  return autoPr.pushed === true && !autoPr.prUrl && autoPr.autoMergeArmed !== true;
}

/**
 * Why this wrap may not arm auto-merge, or null when it may (#1738).
 *
 * Merging is authority the project's methodology grants. A session whose engine
 * cannot run that methodology opens the PR and leaves the merge to one that can.
 *
 * @param {{disposition: string, reason: string}|null} methodology - The run's resolved capability.
 * @returns {string|null}
 */
function _autoMergeWithheldReason(methodology) {
  if (!methodology || methodology.disposition !== 'capability-unavailable') return null;
  return `${methodology.reason}.`;
}

/**
 * #467 — close the loop on an auto-branched wrap commit. Push the wrap
 * branch, open a PR back to the original branch via `gh`, arm
 * auto-merge (`--auto --${mergeMethod} --delete-branch`, resolved by
 * `resolveWrapMergeMethod` (#1172) — branch protection still gates; this
 * only removes the wait), and return the checkout to the original branch
 * on full success.
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
 * @param {string} [params.configRoot=cwd] - Where the project's config lives; the
 *   registered checkout when the wrap works on a worktree (`./_config-root`)
 * @param {string|null} [params.withholdAutoMerge] - When set, the PR opens but
 *   auto-merge is not armed, and this reason is reported (#1738).
 * @param {object|null} [params.project] - The project record, for who decides its
 *   merges (#2320). Without one, the settings under `configRoot` are what is read.
 * @returns {Promise<{attempted:boolean, pushed:boolean, prUrl:string|null,
 *   autoMergeArmed:boolean, autoMergeWithheld:(string|null), mergeAuthority:(object|null),
 *   returnedToBranch:boolean, remote:string|null,
 *   skippedReason:string|null, error:string|null, remediation:string|null}>}
 *   `remote` is the `origin` URL without credentials, or null when there is none.
 *   `mergeAuthority` is the answer of `lib/merge-authority.js` when it is why
 *   auto-merge was not armed, with the sentence said as `said`; null otherwise.
 *   It is a field of its own because `autoMergeWithheld` is read as "this
 *   engine cannot run the methodology" by the wrap drawer.
 */
async function _autoPrCloseLoop({ cwd, branch, originalBranch, staged, configRoot = cwd, withholdAutoMerge = null, controlGate = null, project = null }) {
  const result = {
    attempted: false,
    pushed: false,
    prUrl: null,
    autoMergeArmed: false,
    autoMergeWithheld: null,
    mergeAuthority: null,
    returnedToBranch: false,
    remote: null,
    skippedReason: null,
    error: null,
    remediation: null,
    controlRefusal: null
  };

  // #1861 — a HOLD stored after the commit landed must still stop what comes
  // next. Each remote side effect asks again, and a refusal leaves the work
  // exactly where it is, saying so.
  const heldBefore = (surface, remediation) => {
    const refusal = typeof controlGate === 'function' ? controlGate(surface) : null;
    if (!refusal) return false;
    result.controlRefusal = { code: refusal.code, ...refusal.details };
    result.skippedReason = `${refusal.code}: ${refusal.message}`;
    result.remediation = remediation;
    return true;
  };

  let enabled = true;
  try {
    const cfg = store.projectConfig.load(configRoot);
    if (cfg && cfg.wrapAutoPrEnabled === false) enabled = false;
  } catch (_) { /* unreadable config → default-on */ }
  if (!enabled) {
    result.skippedReason = 'wrapAutoPrEnabled is false for this project';
    return result;
  }

  const remoteRes = await _internal.exec('git', ['remote', 'get-url', 'origin'], { cwd });
  if (remoteRes.exitCode !== 0) {
    // A stopped probe says nothing about whether the remote exists. Reporting
    // "no origin remote" for a command that never answered sends the operator
    // to configure a remote they may already have.
    result.skippedReason = remoteRes.timedOut
      ? 'could not tell whether an origin remote exists — the probe was stopped before it answered'
      : 'no origin remote — nowhere to land the wrap branch';
    return result;
  }

  result.attempted = true;
  // Kept so a stranded branch can be identified by repo as well as by name.
  result.remote = stripRemoteCredentials(remoteRes.stdout);

  if (heldBefore('wrap-push', `The wrap commit is safe on local branch ${branch} and was NOT pushed, because this lane is held. Push it only after the hold is released: git push -u origin ${branch}`)) {
    return result;
  }
  const pushRes = await _internal.exec('git', ['push', '-u', 'origin', branch], { cwd });
  if (pushRes.exitCode !== 0) {
    const detail = detailFromFailure(pushRes);
    result.error = `${_describeOutcome(pushRes, 'git push')}${detail ? `: ${detail}` : ''}`;
    // A stopped push may have completed server-side — git can finish receiving
    // the pack after we stop waiting for the client. The safe instruction is
    // the same either way (re-push; it is idempotent), but the operator must
    // not be told the push "failed" when the branch may be on the remote.
    result.remediation = pushRes.timedOut
      ? `The wrap commit is safe on local branch ${branch}. The push was stopped before it answered, so the branch may or may not have reached origin — a slow network or a large first push is the usual cause. Re-running it is harmless either way: git push -u origin ${branch} && gh pr create --base ${originalBranch} --head ${branch}`
      : `The wrap commit is safe on local branch ${branch}. Push it and open a PR manually: git push -u origin ${branch} && gh pr create --base ${originalBranch} --head ${branch}`;
    return result;
  }
  result.pushed = true;

  const ghRes = await _internal.exec('gh', ['--version'], { cwd });
  if (ghRes.exitCode !== 0) {
    // Same rule as the remote probe: `gh --version` being stopped is not
    // evidence that `gh` is missing, and telling the operator it is sends them
    // to install a CLI they already have.
    result.skippedReason = ghRes.timedOut
      ? 'could not tell whether the gh CLI is available — the probe was stopped before it answered; branch pushed, PR not opened'
      : 'gh CLI not available — branch pushed, PR not opened';
    result.remediation = `Open the PR manually: gh pr create --base ${originalBranch} --head ${branch} (or use the GitHub web UI — the branch is pushed).`;
    return result;
  }

  if (heldBefore('wrap-pr-create', `The wrap branch is pushed; no PR was opened, because this lane is held. Open it only after the hold is released: gh pr create --base ${originalBranch} --head ${branch}`)) {
    return result;
  }
  // #2320 — asked before the pull request is opened so its body can say who
  // merges it, and acted on again where auto-merge would be armed.
  const authority = _internal.mergeAuthority.forProject(
    { ...(project || {}), path: cwd, configPath: configRoot },
    { repo: _internal.mergeAuthority.repoFromRemoteUrl(remoteRes.stdout), baseBranch: originalBranch }
  );
  const notArmedBecause = _internal.mergeAuthority.describe(authority, project);
  const subject = _buildSubject(branch);
  const body = _buildAutoPrBody(branch, originalBranch, _buildBodyLines(staged), notArmedBecause);
  const createRes = await _internal.exec('gh', [
    'pr', 'create', '--base', originalBranch, '--head', branch,
    '--title', subject, '--body', body
  ], { cwd });
  if (createRes.exitCode !== 0) {
    const detail = detailFromFailure(createRes);
    result.error = `${_describeOutcome(createRes, 'gh pr create')}${detail ? `: ${detail}` : ''}`;
    // The request may have reached GitHub before we stopped waiting, so the PR
    // may already exist. Sending the operator straight to `gh pr create` would
    // then hand them a duplicate-PR error with no idea where the first came
    // from; check first.
    result.remediation = createRes.timedOut
      ? `The wrap branch is pushed. The PR request was stopped before it answered, so a PR may already have been opened — check with \`gh pr list --head ${branch}\` before opening one: gh pr create --base ${originalBranch} --head ${branch}`
      : `The wrap branch is pushed. Open the PR manually: gh pr create --base ${originalBranch} --head ${branch}`;
    return result;
  }
  const urlMatch = createRes.stdout.match(/https:\/\/\S+\/pull\/\d+/);
  result.prUrl = urlMatch ? urlMatch[0] : null;

  if (result.prUrl) {
    // Best-effort label — a repo without the label must not fail the loop.
    await _internal.exec('gh', ['pr', 'edit', result.prUrl, '--add-label', 'chore'], { cwd });
  }

  // #2320 — in a project whose merges are another's to decide, or whose role
  // could not be read, the PR stays open and unarmed. Said before the
  // methodology's reason below: that one ends "merge it from a session that
  // can run the methodology", which is the wrong instruction here.
  if (!_internal.mergeAuthority.mayArmAutoMerge(authority)) {
    log.info('auto-merge not armed — this project does not decide its own merges', {
      cwd, branch, prUrl: result.prUrl, authority: authority.authority, integrator: authority.integrator || null
    });
    result.mergeAuthority = { ...authority, said: notArmedBecause };
    result.remediation = `The PR is open and auto-merge was deliberately not armed. ${notArmedBecause}`;
    return result;
  }

  // #1738 — merge authority is the methodology's; without it the PR stays open
  // for a session that can run it. HEAD stays on the wrap branch, as it does
  // whenever auto-merge was not armed: the commit is not guaranteed to land.
  if (withholdAutoMerge) {
    log.info('auto-merge withheld — methodology unavailable on this engine', { cwd, branch, prUrl: result.prUrl });
    result.autoMergeWithheld = withholdAutoMerge;
    result.remediation = `The PR is open and auto-merge was deliberately not armed: ${withholdAutoMerge} Merge it from a session that can run the methodology.`;
    return result;
  }

  if (heldBefore('wrap-auto-merge-arm', 'The PR is open and auto-merge was NOT armed, because this lane is held. Leave it for the merge owner once the hold is released.')) {
    return result;
  }
  // #1172 — read from the registered checkout, not the work tree: a wrap
  // running on a worktree has `.tangleclaw/project.json` only at `configRoot`
  // (see `_config-root.js`).
  const resolvedMergeMethod = resolveWrapMergeMethod(configRoot);
  if (resolvedMergeMethod.warning) {
    log.info(resolvedMergeMethod.warning, { cwd, branch });
  }
  const mergeTarget = result.prUrl || branch;
  const mergeRes = await _internal.exec('gh', [
    'pr', 'merge', mergeTarget, '--auto', `--${resolvedMergeMethod.method}`, '--delete-branch'
  ], { cwd });
  if (mergeRes.exitCode !== 0) {
    const detail = detailFromFailure(mergeRes);
    result.error = `${_describeOutcome(mergeRes, 'gh pr merge --auto')}${detail ? `: ${detail}` : ''}`;
    // "Auto-merge could not be armed" asserts an outcome we did not observe: a
    // stopped request may have armed it, in which case following the old
    // advice means merging by hand a PR that GitHub was already going to land.
    result.remediation = mergeRes.timedOut
      ? 'The PR is open. The auto-merge request was stopped before it answered, so it is unknown whether auto-merge was armed — check the PR page before acting. If it was not, enable auto-merge in the repo (Settings → General → Pull Requests) or merge the PR manually once checks pass.'
      : 'The PR is open but auto-merge could not be armed. Enable auto-merge in the repo (Settings → General → Pull Requests) or merge the PR manually once checks pass.';
    return result;
  }
  result.autoMergeArmed = true;

  // Full success — return the checkout to the original branch so the
  // next session starts from the protected branch, not the wrap branch.
  // `gh pr merge --delete-branch` may already have switched HEAD; a
  // checkout onto the current branch exits 0, so this is idempotent.
  const coRes = await _internal.exec('git', ['checkout', originalBranch], { cwd });
  result.returnedToBranch = coRes.exitCode === 0;
  if (!result.returnedToBranch && coRes.timedOut) {
    // `returnedToBranch: false` asserts HEAD is NOT on the original branch. A
    // stopped checkout does not establish that — it may have completed after we
    // stopped waiting — so the flag is a guess here and the log says so.
    // No `project` here: this function takes `{cwd, branch, originalBranch,
    // staged}`, and reaching for a name bound in `run()`'s scope throws a
    // ReferenceError that the call site's catch turns into a WORSE lie than the
    // one this log exists to prevent — the catch synthesises
    // `pushed:false, prUrl:null` for a branch that by this line is already
    // pushed, with its PR open and auto-merge armed.
    log.warn('checkout back to the original branch was stopped before it answered; HEAD position is unknown', {
      cwd, branch, originalBranch, error: coRes.error
    });
  }

  return result;
}

/**
 * The uncommitted paths this wrap wrote itself, in the repo-root-relative form
 * `git status` reports. Staged flushes are written as absolute paths; each is
 * matched against the dirty list by its path under the work tree's toplevel, or,
 * with no toplevel known (a direct call with no scope), by path suffix.
 *
 * @param {Array<{path:string}>} flushed - `_flushStagedWrites` output.
 * @param {Array<{path:string}>} dirty - Parsed `git status` entries.
 * @param {object|null} scope - The wrap run's scope.
 * @returns {Set<string>}
 */
function _wrapWrittenPaths(flushed, dirty, scope) {
  const out = new Set();
  const root = scope && scope.workToplevel ? scope.workToplevel : null;
  for (const f of flushed || []) {
    // Resolved through symlinks, because the toplevel is: git reports it as a
    // real path, while a flush is addressed from the project's registered path,
    // which may run through a symlink (macOS's `/var` is one). Compared as
    // spelled, the wrap's own write went unrecognised, and since a file new to
    // the repository is asked about unless the wrap wrote it (#1724), the wrap
    // then asked the operator about its own output.
    const abs = _realpathOr(path.resolve(f.path));
    for (const d of dirty) {
      if (root ? abs === path.join(root, d.path) : abs.endsWith(path.sep + d.path)) out.add(d.path);
    }
  }
  return out;
}

/**
 * A path with its symlinks resolved, or the path as given when it cannot be
 * resolved (it is unreadable).
 *
 * A path that does not exist is resolved through its nearest existing parent:
 * a fragment the flush just deleted (#1220) cannot be resolved as a whole, but
 * its directory can, and `git status` reports the deletion under the resolved
 * toplevel (macOS's `/var` is `/private/var` there). Returned as given, the
 * deleted path matched nothing, the wrap did not recognise its own deletion,
 * and the fragment stayed out of the commit.
 *
 * @param {string} abs - Absolute path.
 * @returns {string}
 */
function _realpathOr(abs) {
  try {
    return fs.realpathSync(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const parent = path.dirname(abs);
      if (parent !== abs) return path.join(_realpathOr(parent), path.basename(abs));
    }
    return abs;
  }
}

/** Operations that leave the repository mid-commit, with how to abandon each. */
const IN_PROGRESS_MARKERS = [
  { ref: 'MERGE_HEAD', name: 'merge', abort: 'git merge --abort' },
  { ref: 'CHERRY_PICK_HEAD', name: 'cherry-pick', abort: 'git cherry-pick --abort' },
  { ref: 'REVERT_HEAD', name: 'revert', abort: 'git revert --abort' }
];

/**
 * Whether a merge, cherry-pick or revert is unfinished in the repository at `cwd`.
 *
 * Asks git where each marker file lives (a worktree keeps its own), then checks
 * the file exists. A probe that does not answer reports nothing in progress: the
 * commit then runs and git's own refusal still stops it.
 *
 * @param {string} cwd - Work tree.
 * @returns {Promise<{name:string, abort:string}|null>}
 */
async function _operationInProgress(cwd) {
  const args = ['rev-parse'];
  for (const m of IN_PROGRESS_MARKERS) args.push('--git-path', m.ref);
  const res = await _internal.exec('git', args, { cwd });
  if (!res || res.exitCode !== 0) return null;
  const paths = String(res.stdout || '').split('\n').map((l) => l.trim());
  for (let i = 0; i < IN_PROGRESS_MARKERS.length; i += 1) {
    if (paths[i] && _internal.existsSync(path.resolve(cwd, paths[i]))) return IN_PROGRESS_MARKERS[i];
  }
  return null;
}

/**
 * Write the NUL-separated pathspec file `git add` and `git commit` read.
 *
 * @param {string[]} paths - Repo-root-relative paths.
 * @returns {string} Absolute path of the file.
 */
function _writePathspecFile(paths) {
  const file = path.join(os.tmpdir(), `tc-wrap-pathspec-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  _internal.writeFileSync(file, paths.map((p) => `:(top,literal)${p}`).join('\0') + '\0');
  return file;
}

/**
 * Remove a pathspec file. A file left behind in the temp dir holds only path
 * names, so failure is logged, not raised.
 *
 * @param {string} file - From {@link _writePathspecFile}.
 * @returns {void}
 */
function _removePathspecFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    log.debug('wrap pathspec file could not be removed', { file, error: err.message });
  }
}

/**
 * The state paths an approved un-track offer covers, or none. Only an
 * `approve` answer reads git at all; a listing failure removes nothing, because
 * an untrack is never a guess.
 *
 * The approval is an answer to a list the operator was SHOWN, so where this run's
 * `session-files` result is present, only paths it reported as approved are
 * removed: a state file that became tracked after it asked stays tracked and is
 * offered on the next wrap. Without that result (the step did not run in this
 * attempt), the current resolution stands.
 *
 * @param {object} context - Pipeline runner context.
 * @param {object|null} scope - The wrap run's scope.
 * @returns {Promise<string[]>}
 */
async function _approvedUntrackPaths(context, scope) {
  const answer = untrackOffer.sanitizeAnswer(context.options && context.options.untrackState);
  if (answer !== untrackOffer.ANSWERS.APPROVE || !scope || !scope.workToplevel) return [];
  const listed = await untrackOffer.listTrackedState(_internal.exec, scope.workToplevel);
  if (listed.error) {
    log.warn('could not list tracked TangleClaw state at commit; nothing is removed from tracking', { error: listed.error });
    return [];
  }
  const resolved = untrackOffer.resolve({
    tracked: listed.paths,
    declined: wrapState.readUntrackDeclined(configRootOf(context.project)),
    answer
  }).untrack;
  const asked = (context.previousResults || []).find((r) => r && r.stepId === 'session-files' && r.output);
  if (!asked || !Array.isArray(asked.output.untrackState)) return resolved;
  const shown = new Set(asked.output.untrackState);
  return resolved.filter((p) => shown.has(p));
}

/**
 * The upstream fields every commit-step outcome carries (#1868).
 *
 * @param {{alreadyUpstream:string[], provenanceRefusedIncludes:string[], provenanceChanged:string[]}} classified
 * @param {object|null} provenance - This step's recheck.
 * @returns {object}
 */
function _provenanceOutput(classified, provenance) {
  const summary = upstreamProvenance.summaryOf(provenance);
  return {
    provenance: summary,
    provenanceHeadline: upstreamProvenance.headline(summary),
    alreadyUpstream: classified.alreadyUpstream,
    provenanceRefusedIncludes: classified.provenanceRefusedIncludes,
    provenanceChanged: classified.provenanceChanged
  };
}

/**
 * A sentence for the remediation when upstream changed after the operator
 * answered, so an Include was not carried into the commit (#1868).
 *
 * @param {{provenanceChanged:string[]}} classified
 * @returns {string}
 */
function _provenanceChangedNote(classified) {
  if (!classified.provenanceChanged.length) return '';
  return `\nNothing was committed. Upstream changed after you answered, so the Include was not carried forward for: ${classified.provenanceChanged.join(', ')}. Choose again with the new facts, then Retry.`;
}

/**
 * Why a wrap with nothing stageable skips its commit, naming the kind of file
 * that is left when it is not the operator's own Leave.
 *
 * @param {{left:string[], tangleclawState:string[], safetyWithheld?:string[]}} classified
 * @param {{left:string[]}} secretReport - `secretCheck.check(...).report`.
 * @returns {string}
 */
function _nothingToCommitReason(classified, secretReport) {
  const leftByOperator = classified.left.length + secretReport.left.length;
  if (leftByOperator === 0 && (classified.safetyWithheld || []).length > 0) {
    return 'nothing of this session\'s to commit — the only other uncommitted files are databases, which a wrap never commits';
  }
  if (leftByOperator === 0 && classified.tangleclawState.length > 0) {
    return 'nothing of this session\'s to commit — the only uncommitted files are TangleClaw state, which a wrap never commits';
  }
  return 'nothing of this session\'s to commit — every uncommitted file was left out';
}

/**
 * What an operator can actually DO about a half-committed rename.
 *
 * "Include both or leave both" is only advice when both halves are the
 * operator's to decide. A half withheld by the secret scan, or one that is
 * TangleClaw state a wrap never commits, cannot be included by any decision they
 * can make — telling them to include it would send them looking for a control
 * that is not there. Those cases get the move-it-back remedy instead, which is
 * the one that works.
 *
 * @param {Array<{staged:string[], left:string[], reason?:string}>} splits - From `splitRenamesOf`.
 * @returns {string}
 */
function splitRenameRemedy(splits) {
  const undecidable = splits.filter((r) => r.reason && r.reason !== 'decision');
  if (undecidable.length === splits.length && splits.length > 0) {
    return 'Nothing was staged or committed, and no Include/Leave choice can resolve this: the other '
      + 'half of the rename is not a path a wrap may commit. Undo the move (`git mv` it back), or '
      + 'commit the rename yourself outside the wrap, then re-run.';
  }
  return 'Nothing was staged or committed. Decide the same way for both halves of each rename — '
    + 'include both to commit the move, or leave both to keep it out of this wrap. If a half cannot '
    + 'be included, undo the move or commit it yourself outside the wrap, then re-run.';
}

/**
 * Commit the allowed paths AND remove approved state paths from tracking, in one
 * commit, without committing anything else the operator had staged.
 *
 * `git commit <pathspec>` cannot carry a removal: it re-reads each listed path
 * from the working tree, and a state file is still on disk. So the commit is
 * built on a temporary index started from HEAD — the allowed paths added, the
 * approved paths removed — and the real index is brought level afterwards. The
 * operator's own staged work lives only in the real index, so it stays staged
 * and out of this commit, exactly as with a pathspec commit.
 *
 * This index is seeded from HEAD, so a path git has already removed from the
 * REAL index is still present here — and this commit carries no pathspec, so
 * whatever survives in the temporary index is what lands. A rename's source
 * therefore has to be removed from this index explicitly, or the commit would
 * record the destination as a new file and keep the source alongside it (#1629).
 *
 * @param {object} args
 * @param {string} args.cwd - Work tree.
 * @param {string} args.message - Commit message.
 * @param {string[]} args.addPathspecArgs - The paths `git add` can resolve, as pathspec-file args.
 * @param {boolean} args.hasAddable - Whether there is anything for `git add` at all.
 * @param {string[]} args.untrackPaths - Repo-root-relative paths to stop tracking.
 * @param {string[]} [args.indexRemoved] - Authorized paths git already removed from the real
 *   index (rename sources, staged deletions), to remove from this one too.
 * @param {string[]} [args.addedThenDeleted] - Paths added to the REAL index this session and
 *   since deleted from the work tree (porcelain `AD`; a pre-staged new fragment the release
 *   consumed, #1220). The caller leaves them out of `addPathspecArgs`, since the temporary
 *   index seeded from HEAD never held them and `git add` would match nothing; after the
 *   commit they are removed from the real index here, as the untrack paths are.
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, timedOut?:boolean}>} The commit's result,
 *   or the first failing preparation step's (nothing is committed then).
 */
async function _commitWithUntrack({ cwd, message, addPathspecArgs, hasAddable, untrackPaths, indexRemoved = [], addedThenDeleted = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
  const literal = untrackPaths.map((p) => `:(top,literal)${p}`);
  const removedLiteral = indexRemoved.map((p) => `:(top,literal)${p}`);
  const levelLiteral = [...literal, ...addedThenDeleted.map((p) => `:(top,literal)${p}`)];
  try {
    const steps = [
      ['read-tree', 'HEAD'],
      ...(hasAddable ? [['add', '-A', ...addPathspecArgs]] : []),
      // Before the untrack removal, and separate from it: these paths are being
      // committed as removals, where `untrackPaths` are being taken out of
      // tracking while staying on disk. Same git verb, different reasons.
      ...(removedLiteral.length > 0 ? [['rm', '--cached', '-q', '--ignore-unmatch', '--', ...removedLiteral]] : []),
      ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...literal]
    ];
    for (const args of steps) {
      const res = await _internal.exec('git', args, { cwd, env });
      if (res.exitCode !== 0) {
        return { ...res, stderr: `preparing the commit (git ${args[0]}) failed, so nothing was committed: ${String(res.stderr || '').trim()}` };
      }
    }
    const commitRes = await _internal.exec('git', ['commit', '-m', message], { cwd, env });
    if (commitRes.exitCode === 0) {
      // `-f`: after the commit the index copy matches neither HEAD (which no longer
      // has the path) nor the disk (which TangleClaw rewrote), and git refuses
      // without it. `--cached` never touches the file on disk. An added-then-
      // deleted path is brought level the same way: its entry is in the real
      // index only, and the file is gone.
      const sync = await _internal.exec('git', ['rm', '--cached', '-f', '-q', '--ignore-unmatch', '--', ...levelLiteral], { cwd });
      if (sync.exitCode !== 0) {
        // The commit landed; only `git status` still lists the paths as staged
        // deletions until the index is refreshed. Logged, not raised.
        log.warn('wrap committed the un-track, but the index could not be brought level', { stderr: String(sync.stderr || '').trim().slice(0, 200) });
      }
    }
    return commitRes;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Stamp `lastWrapSha` in the checkout's untracked wrap state (`lib/wrap-state.js`).
 * Non-fatal on failure — the commit already landed, the stamp is a hint for
 * later steps' range detection. We log and continue.
 *
 * It is never written to `.tangleclaw/project.json`: that file is tracked in
 * many projects, and a stamp there left a tracked file changed after every wrap.
 *
 * Concurrent wraps on the same project are not supported by the runner, so the
 * read → merge → write of the state file is lock-free by design.
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
    wrapState.stampLastWrapSha(projectPath, sha);
    return true;
  } catch (err) {
    log.warn('Failed to stamp lastWrapSha in the wrap state file', {
      projectPath,
      sha,
      error: err.message
    });
    return false;
  }
}

/**
 * Read the `lastWrapSha` in effect BEFORE this wrap — the boundary the PREVIOUS
 * wrap left behind, and therefore the base of this session's own range.
 *
 * It is read here, and reported in this step's output, because this step is the
 * one that overwrites it: by the time `continuity-write` runs, `lastWrapSha`
 * already names this wrap's base, and `<that>..<wrap commit>` is the wrap commit
 * alone rather than the session. A later step cannot recover the replaced value
 * from disk, so the step that replaced it has to hand it forward (#797).
 *
 * **The outcome is reported, not just the value.** A null `sha` has two causes
 * that must not be collapsed: no boundary has ever been recorded, and a record
 * that could not be read. The consumer ACTS on the difference: on `absent` it
 * may publish the branch range as the session's work, on `unreadable` it must
 * not, because a boundary is probably sitting on disk unread. `wrap-state`
 * establishes the outcome; this function logs the unreadable case.
 *
 * @param {string} projectPath
 * @returns {{sha:(string|null), read:('recorded'|'absent'|'unreadable')}}
 */
function _readLastWrapSha(projectPath) {
  let boundary;
  try {
    boundary = wrapState.readLastWrapSha(projectPath);
  } catch (err) {
    // `readLastWrapSha` is documented not to throw; this is a belt on another
    // module's contract, and it lands in the same `unreadable` state for the same reason.
    log.warn('wrap state read threw; the previous wrap boundary is unknown', {
      projectPath, error: err.message
    });
    return { sha: null, read: 'unreadable' };
  }
  if (boundary.read === 'unreadable') {
    log.warn('wrap state could not be read; the previous wrap boundary is unknown', {
      projectPath, source: boundary.source, error: boundary.error
    });
  }
  return { sha: boundary.sha, read: boundary.read };
}

/**
 * Whether a staged entry is one of `version-bump`'s release entries. The one
 * test for "this wrap cuts a release", shared by the commit body and the
 * release-prepare trigger so the two can't disagree about it.
 *
 * @param {*} entry - A staged entry
 * @returns {boolean}
 */
function _isReleaseEntry(entry) {
  return !!entry && typeof entry === 'object'
    && typeof entry.bumpLevel === 'string'
    && typeof entry.oldVersion === 'string'
    && typeof entry.newVersion === 'string';
}

/**
 * The release this wrap is cutting, read off the entries `version-bump` staged.
 *
 * @param {Record<string, object>} staged
 * @returns {{from:string, to:string}|null} null when no release is being cut
 */
function _releaseCutOf(staged) {
  if (!staged || typeof staged !== 'object') return null;
  for (const entry of Object.values(staged)) {
    if (_isReleaseEntry(entry)) {
      return { from: entry.oldVersion, to: entry.newVersion };
    }
  }
  return null;
}

/**
 * The project's `releasePrepareCommand`, or why there is none to run.
 *
 * Only a release cut asks, and the reason is shown on the commit row, so each
 * cause gets its own words. An unreadable `.tangleclaw/project.json` in
 * particular must not read as "not configured": `projectConfig.load` returns
 * defaults for it, and a command may well be set in the file it could not read.
 * None of these stops the wrap. Without the command the release PR is what it
 * was before this setting existed, and the row says the command did not run.
 *
 * @param {object} project - Project record
 * @returns {{command:string, reason:null}|{command:null, reason:string}}
 */
function _releasePrepareCommandOf(project) {
  let unreadable = null;
  const cfg = store.projectConfig.load(configRootOf(project), {
    onError: (err) => { unreadable = err.message; }
  });
  if (unreadable !== null) {
    log.warn('project config unreadable; releasePrepareCommand not run on this release cut', {
      project: project.name, error: unreadable
    });
    return { command: null, reason: `.tangleclaw/project.json could not be read (${unreadable}), so releasePrepareCommand was not run` };
  }
  const value = cfg ? cfg.releasePrepareCommand : null;
  if (typeof value === 'string' && value.trim() !== '') return { command: value, reason: null };
  if (value !== null && value !== undefined && value !== '') {
    log.warn('releasePrepareCommand is not a command string; not running it', {
      project: project.name, type: typeof value
    });
    return { command: null, reason: `releasePrepareCommand is not a command string (got ${Array.isArray(value) ? 'an array' : typeof value})` };
  }
  log.info('release cut with no releasePrepareCommand configured', { project: project.name });
  return { command: null, reason: 'no releasePrepareCommand configured' };
}

/**
 * Read what every staged write target holds before the flush replaces it, and
 * what every staged delete target holds before the flush unlinks it (#1220).
 *
 * @param {Record<string, object>} staged
 * @returns {Array<{path:string, existed:boolean, content?:Buffer, readError?:string}>}
 */
function _snapshotStagedTargets(staged) {
  const out = [];
  for (const entry of Object.values(staged || {})) {
    if (!_isWriteEntry(entry) && !_isDeleteEntry(entry)) continue;
    if (entry.changed === false) continue;
    try {
      out.push({ path: entry.primingPath, existed: true, content: _internal.readFileSync(entry.primingPath) });
    } catch (err) {
      if (err.code === 'ENOENT') out.push({ path: entry.primingPath, existed: false });
      else out.push({ path: entry.primingPath, existed: true, readError: err.message });
    }
  }
  return out;
}

/**
 * Put staged write targets back the way {@link _snapshotStagedTargets} found them.
 *
 * @param {Array<{path:string, existed:boolean, content?:Buffer, readError?:string}>|null} snapshot
 * @returns {string[]} One line per target that could not be put back
 */
function _restoreSnapshot(snapshot) {
  const problems = [];
  for (const s of snapshot || []) {
    if (s.readError) {
      problems.push(`${s.path} (its previous contents could not be read: ${s.readError})`);
      continue;
    }
    try {
      if (s.existed) _internal.writeFileSync(s.path, s.content);
      else _internal.rmSync(s.path, { force: true });
    } catch (err) {
      problems.push(`${s.path} (${err.message})`);
    }
  }
  return problems;
}

/**
 * Every uncommitted path with a fingerprint of its contents, so a before/after
 * pair shows which paths a command changed, including a file that was already
 * uncommitted beforehand.
 *
 * @param {string} cwd - Work tree
 * @param {string} root - Repository toplevel, which `git status` paths are relative to
 * @returns {Promise<{ok:true, prints:Map<string,string>}|{ok:false, reason:string}>}
 */
async function _dirtyFingerprints(cwd, root) {
  const res = await _internal.exec('git', ownership.statusArgs(), { cwd });
  if (res.exitCode !== 0) {
    return { ok: false, reason: `${_describeOutcome(res, 'git status')}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ''}` };
  }
  const prints = new Map();
  for (const entry of ownership.parseStatus(res.stdout)) {
    let print;
    try {
      print = crypto.createHash('sha256').update(_internal.readFileSync(path.join(root, entry.path))).digest('hex');
    } catch (err) {
      print = `unreadable:${err.code || err.message}`;
    }
    prints.set(entry.path, print);
  }
  return { ok: true, prints };
}

/**
 * Run the project's `releasePrepareCommand` against the flushed release (#1502).
 *
 * A project's release can need files the wrap knows nothing about: this repo's
 * README clone pins and its released-CHANGELOG lock, say. Without them the
 * release PR fails CI. The command runs after the bump and the CHANGELOG
 * promotion are on disk and before anything is staged, with the release in
 * `TANGLECLAW_RELEASE_VERSION` and `TANGLECLAW_RELEASE_PREVIOUS`. The version
 * goes in the environment, not into the command string, so no value reaches a
 * shell as syntax.
 *
 * The paths it changed are the ones whose `git status` entry or contents
 * differ afterwards. The caller treats them like files the wrap wrote.
 *
 * @param {{cwd:string, root:string, command:string, cut:{from:string, to:string}}} args
 * @returns {Promise<{ok:true, paths:string[]}
 *   |{ok:false, reason:string, tail?:string, timedOut?:boolean, paths?:string[]}>}
 */
async function _runReleasePrepare({ cwd, root, command, cut }) {
  const before = await _dirtyFingerprints(cwd, root);
  if (!before.ok) {
    return { ok: false, reason: `releasePrepareCommand was not run: the uncommitted files could not be listed first (${before.reason})` };
  }
  const res = await _internal.execShell(command, {
    cwd,
    timeoutMs: _internal.releasePrepareTimeoutMs,
    maxBufferBytes: MAX_BUFFER_BYTES,
    env: { ...process.env, TANGLECLAW_RELEASE_VERSION: cut.to, TANGLECLAW_RELEASE_PREVIOUS: cut.from },
    closeStdin: true
  });
  const after = await _dirtyFingerprints(cwd, root);
  const paths = after.ok
    ? [...after.prints.keys()].filter((p) => before.prints.get(p) !== after.prints.get(p)).sort()
    : [];
  const output = String(res.stderr || res.stdout || '').trim();
  const tail = output ? output.split('\n').slice(-20).join('\n') : '';
  if (res.timedOut) {
    return {
      ok: false,
      timedOut: true,
      paths,
      tail,
      reason: `releasePrepareCommand was stopped after ${Math.round(_internal.releasePrepareTimeoutMs / 1000)}s without finishing`
    };
  }
  if (res.exitCode !== 0) {
    return {
      ok: false,
      paths,
      tail,
      reason: `releasePrepareCommand exited ${res.exitCode}${res.error ? ` (${res.error})` : ''}`
    };
  }
  if (!after.ok) {
    return { ok: false, reason: `releasePrepareCommand finished, but the files it changed could not be listed (${after.reason})` };
  }
  return { ok: true, paths };
}

/**
 * What an operator does after the release-prepare command stopped the commit.
 *
 * @param {{timedOut?:boolean, paths?:string[]}} prep - The failed run
 * @param {object} recovery - From {@link _recoverRelease}: what was put back and what was not
 * @returns {string}
 */
function _releasePrepareRemediation(prep, recovery) {
  const parts = ['Nothing was committed.'];
  parts.push(prep.timedOut
    ? 'The release-prepare command did not finish in time and was stopped, so there is no result to read. Run it by hand to see where it hangs.'
    : 'The release-prepare command did not succeed; its output is above.');
  parts.push(_recoveryRemediation(recovery));
  if (prep.paths && prep.paths.length > 0) {
    parts.push(`The command had already changed ${prep.paths.join(', ')}; check them with \`git diff\`.`);
  }
  parts.push('Fix the command, or remove releasePrepareCommand from .tangleclaw/project.json, then Retry.');
  return parts.join(' ');
}

/**
 * A run id for a direct call with no wrap runner (a unit harness): the recovery
 * artifact is keyed by it, so it must be unique per attempt.
 *
 * @returns {string}
 */
function _localRunId() {
  return `local-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * The index entries git holds for exactly the release targets, before `git add`
 * touches them (#1220, Safeguard 3(e)).
 *
 * Read with `git ls-files -s`, whose record is what `git update-index
 * --cacheinfo` takes back: mode, object and path. A target absent from the index
 * (an untracked fragment) is recorded as absent, so the restore can remove it
 * again. An unmerged entry (stage other than 0) refuses the read: `--cacheinfo`
 * writes stage 0 only, so such an entry could not be put back exactly, and a
 * cut that cannot promise its own undo is not made.
 *
 * @param {string} root - Repository toplevel.
 * @param {string[]} relPaths - Toplevel-relative target paths.
 * @returns {Promise<{ok:true, entries:Array<{path:string, entry:({mode:string, object:string}|null)}>}|{ok:false, reason:string}>}
 */
async function _readIndexEntries(root, relPaths) {
  const res = await _internal.exec('git', ['ls-files', '-s', '-z', '--', ...relPaths.map((p) => `:(top,literal)${p}`)], { cwd: root });
  if (res.exitCode !== 0) {
    const detail = String(res.stderr || '').trim();
    return { ok: false, reason: `${_describeOutcome(res, 'git ls-files')}${detail ? `: ${detail}` : ''}` };
  }
  const byPath = new Map();
  for (const rec of String(res.stdout || '').split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab === -1) continue;
    const [mode, object, stage] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (stage !== '0') {
      return { ok: false, reason: `${p} has an unmerged index entry (stage ${stage}), which a restore could not put back exactly; resolve it before cutting a release` };
    }
    byPath.set(p, { mode, object });
  }
  return { ok: true, entries: relPaths.map((p) => ({ path: p, entry: byPath.get(p) || null })) };
}

/**
 * Everything a release cut needs to be undone, taken BEFORE the flush (#1220,
 * Safeguard 3): the prior bytes of every target (`_snapshotStagedTargets`), the
 * index entries of exactly those targets, and a durable copy of both under
 * `.tangleclaw/release-recovery/<run id>/` in the project's config root.
 *
 * The on-disk artifact is what makes a failed in-memory restore recoverable by
 * hand. It holds a fragment that was untracked at the time (which `HEAD` does
 * not), and unrelated uncommitted edits the targets already carried (which a
 * `git checkout` would discard), so no `git checkout` is ever recommended. It
 * is removed only after the commit lands or a restore puts everything back,
 * and `version-bump` refuses to cut while one exists.
 *
 * The artifact's directory ignores itself (a `.gitignore` holding `*`), so the
 * commit never sees it: TangleClaw state is never a wrap's to commit, and a
 * recovery record that asked to be committed would be its own hazard.
 *
 * Any failure here refuses the cut with nothing changed: a cut whose undo could
 * not be recorded is not made.
 *
 * @param {object} args
 * @param {Record<string, object>} args.staged - The run's staged writes.
 * @param {string|null} args.root - Repository toplevel, or null when there is none.
 * @param {string} args.configRoot - Where the project's TangleClaw state lives.
 * @param {string} args.runId - This wrap run's id.
 * @param {{from:string, to:string}} args.cut - The release being cut.
 * @returns {Promise<{ok:true, recovery:object}|{ok:false, reason:string}>}
 */
async function _prepareReleaseRecovery({ staged, root, configRoot, runId, cut }) {
  const snapshot = _snapshotStagedTargets(staged);
  const unreadable = snapshot.filter((s) => s.readError);
  if (unreadable.length > 0) {
    return { ok: false, reason: `the prior contents of ${unreadable.map((s) => `${s.path} (${s.readError})`).join(', ')} could not be read, so the cut could not be made recoverable` };
  }
  const targets = snapshot.map((s) => {
    const abs = _realpathOr(path.resolve(s.path));
    const rel = root ? path.relative(root, abs) : null;
    const inRepo = rel !== null && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    return { ...s, repoPath: inRepo ? rel.split(path.sep).join('/') : null };
  });
  const relPaths = targets.filter((t) => t.repoPath).map((t) => t.repoPath);
  let index = { read: false, entries: [] };
  if (root && relPaths.length > 0) {
    const read = await _readIndexEntries(root, relPaths);
    if (!read.ok) return { ok: false, reason: `the index entries of the release files could not be recorded (${read.reason})` };
    index = { read: true, entries: read.entries };
  }
  const artifactDir = path.join(configRoot, RELEASE_RECOVERY_REL, runId);
  const manifestPath = path.join(artifactDir, 'manifest.json');
  try {
    fs.mkdirSync(path.join(artifactDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, RELEASE_RECOVERY_REL, '.gitignore'), '*\n');
    const manifest = {
      runId,
      createdAt: new Date().toISOString(),
      cut: { from: cut.from, to: cut.to },
      root,
      indexRecorded: index.read,
      targets: targets.map((t, i) => {
        const file = t.existed ? path.posix.join('files', `${i}-${path.basename(t.path)}`) : null;
        if (file) fs.writeFileSync(path.join(artifactDir, file), t.content);
        const recorded = index.entries.find((e) => e.path === t.repoPath);
        return {
          path: t.path,
          repoPath: t.repoPath,
          existed: t.existed,
          sha256: t.existed ? crypto.createHash('sha256').update(t.content).digest('hex') : null,
          file,
          index: index.read && t.repoPath ? (recorded && recorded.entry ? recorded.entry : null) : undefined
        };
      }),
      recover: 'Copy each listed file back to its path (an entry with no file did not exist before the cut: remove it), '
        + 'put back each listed index entry with `git update-index --add --cacheinfo <mode>,<object>,<repoPath>` '
        + '(`git update-index --force-remove -- <repoPath>` for one whose index is null), then delete this directory.'
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  } catch (err) {
    return { ok: false, reason: `the recovery record ${artifactDir} could not be written (${err.message})` };
  }
  return { ok: true, recovery: { snapshot, index, root, repoPaths: relPaths, artifactDir, manifestPath } };
}

/**
 * Put a release cut back after a halt that follows the flush (#1220, Safeguard
 * 3(c)–(e)): the work tree from the snapshot, and, once `git add` has run, the
 * index entries of exactly the release targets. The artifact is removed only
 * when everything was put back; otherwise it is retained and the report says
 * what the operator still has to do.
 *
 * @param {object} recovery - From {@link _prepareReleaseRecovery}.
 * @param {{restoreIndex:boolean}} options - Whether `git add` may have changed the index.
 * @returns {Promise<{artifactDir:string, putBack:string[], problems:string[], indexRestored:(boolean|null), retained:boolean}>}
 */
async function _recoverRelease(recovery, { restoreIndex }) {
  const problems = _restoreSnapshot(recovery.snapshot);
  const report = {
    artifactDir: recovery.artifactDir,
    putBack: recovery.snapshot.map((s) => s.path).filter((p) => !problems.some((line) => line.startsWith(`${p} (`))),
    problems,
    indexRestored: null,
    retained: false
  };
  if (restoreIndex) {
    if (!recovery.index.read) {
      report.indexRestored = false;
      report.problems.push('the index entries of the release files were not recorded (no git work tree was known), so they were not put back');
    } else {
      const cacheinfo = recovery.index.entries.filter((e) => e.entry)
        .flatMap((e) => ['--cacheinfo', `${e.entry.mode},${e.entry.object},${e.path}`]);
      const absent = recovery.index.entries.filter((e) => !e.entry).map((e) => e.path);
      const indexProblems = [];
      if (cacheinfo.length > 0) {
        const res = await _internal.exec('git', ['update-index', '--add', ...cacheinfo], { cwd: recovery.root });
        if (res.exitCode !== 0) indexProblems.push(`${_describeOutcome(res, 'git update-index --cacheinfo')}: ${String(res.stderr || '').trim()}`);
      }
      if (absent.length > 0) {
        const res = await _internal.exec('git', ['update-index', '--force-remove', '--', ...absent], { cwd: recovery.root });
        if (res.exitCode !== 0) indexProblems.push(`${_describeOutcome(res, 'git update-index --force-remove')}: ${String(res.stderr || '').trim()}`);
      }
      report.indexRestored = indexProblems.length === 0;
      for (const p of indexProblems) report.problems.push(`the index entries of the release files could not be put back (${p})`);
    }
  }
  if (report.problems.length === 0) {
    const removal = _removeRecoveryArtifact(recovery);
    if (!removal.removed) report.problems.push(removal.problem);
  }
  report.retained = report.problems.length > 0;
  if (report.retained) {
    log.warn('release cut not fully put back; the recovery record is retained', {
      artifactDir: recovery.artifactDir, problems: report.problems
    });
  }
  return report;
}

/**
 * Remove the recovery artifact once nothing can need it: the commit landed, or
 * every byte and index entry is back where it was.
 *
 * @param {{artifactDir:string}} recovery
 * @returns {{removed:true}|{removed:false, problem:string}}
 */
function _removeRecoveryArtifact(recovery) {
  try {
    fs.rmSync(recovery.artifactDir, { recursive: true, force: true });
    // The parent holds only the self-ignore once the last run directory is
    // gone; leaving it would be an empty `release-recovery/` on every project
    // that ever cut a release.
    const parent = path.dirname(recovery.artifactDir);
    if (fs.readdirSync(parent).every((name) => name === '.gitignore')) {
      fs.rmSync(parent, { recursive: true, force: true });
    }
    return { removed: true };
  } catch (err) {
    return { removed: false, problem: `the recovery record ${recovery.artifactDir} could not be removed (${err.message}); delete it by hand once you have checked the release files, or no release is cut` };
  }
}

/**
 * The report for a halt that restores nothing on purpose: a `git commit` that
 * was stopped by its timeout may still complete, and a restore would race it.
 *
 * @param {{artifactDir:string}} recovery
 * @returns {{artifactDir:string, putBack:string[], problems:string[], indexRestored:null, retained:true, notRestored:string}}
 */
function _retainedReport(recovery) {
  return {
    artifactDir: recovery.artifactDir,
    putBack: [],
    problems: [],
    indexRestored: null,
    retained: true,
    notRestored: 'the commit was stopped before it answered and may still complete, so nothing was put back'
  };
}

/**
 * The sentence an operator reads about a release cut that did not commit: what
 * was put back, what was not, and where every prior byte is. It never says the
 * tree is clean when something could not be restored.
 *
 * @param {object} report - From {@link _recoverRelease} or {@link _retainedReport}.
 * @returns {string}
 */
function _recoveryRemediation(report) {
  if (report.notRestored) {
    return `The version bump, the CHANGELOG promotion and the consumed changelog fragments were NOT put back: ${report.notRestored}. `
      + 'Run `git log -1` first. If the wrap commit is there, the release landed and only the wrap was cut short: delete '
      + `${report.artifactDir} and nothing else is needed. If it is not, every file's prior bytes are in that directory and manifest.json names each one's path: `
      + 'copy each file back, put back the index entries it lists, then delete the directory. No release is cut while it exists.';
  }
  if (report.problems.length === 0) {
    return 'The version bump, the CHANGELOG promotion and the consumed changelog fragments were put back'
      + `${report.indexRestored === true ? ', and the index entries of those files with them' : ''}, so Retry cuts the release again from scratch.`;
  }
  return `Not everything was put back: ${report.problems.join('; ')}. `
    + `Every release file's prior bytes are kept in ${report.artifactDir}, and its manifest.json names each file's path and index entry: `
    + 'copy each file back to the path it names, put back each index entry it lists '
    + '(`git update-index --add --cacheinfo <mode>,<object>,<path>`, or `git update-index --force-remove -- <path>` for one recorded as absent), '
    + 'then delete the directory. No release is cut while it exists.';
}

/**
 * A halted result with the recovery's outcome attached: the report under
 * `output.releaseRecovery`, and its sentence appended to the remediation.
 *
 * @param {object} result - The step result that halts the wrap.
 * @param {object} report - From {@link _recoverRelease} or {@link _retainedReport}.
 * @returns {object}
 */
function _withRecovery(result, report) {
  const output = result.output && typeof result.output === 'object' ? result.output : {};
  return {
    ...result,
    output: {
      ...output,
      releaseRecovery: report,
      remediation: [output.remediation, _recoveryRemediation(report)].filter(Boolean).join(' ')
    }
  };
}

/**
 * The blocked result for a governed side effect the control state refuses, or
 * null to proceed (#1861). Asked immediately before each side effect.
 * @param {object} context - Step context (`controlGate` is set by the wrap runner)
 * @param {string} surface - The side effect about to happen
 * @returns {object|null}
 */
function _controlBlocked(context, surface) {
  const refusal = context && typeof context.controlGate === 'function' ? context.controlGate(surface) : null;
  return refusal ? require('../control-gate').blockedStepResult(refusal) : null;
}

/**
 * Record the Include / Leave answers this commit ran with, once per commit or
 * skip (#2155). The answers are recorded as given, not as the classification
 * honoured them: an answer the commit ignored must be distinguishable later from
 * one that was never given. Path names only — never content. Never throws
 * (`store.activity.log` swallows), so the record cannot break a wrap.
 *
 * @param {object} args
 * @param {object} args.project - Project record (`id` attributes the row)
 * @param {object|null} args.session - Session record, when there is one
 * @param {'committed'|'skipped'} args.outcome - What the step concluded
 * @param {string} [args.reason] - Why it skipped (skipped only)
 * @param {string|null} [args.commitSha] - The commit made (committed only)
 * @param {Object<string,string>} args.decisions - Sanitised `{[path]: 'include'|'leave'}`
 * @param {string[]} [args.committedOwn] - The session's own paths that were committed
 * @returns {void}
 */
function _recordAnswers({ project, session, outcome, reason, commitSha, decisions, committedOwn = [] }) {
  const answered = (value) => Object.keys(decisions).filter((p) => decisions[p] === value).sort();
  store.activity.log({
    projectId: project.id,
    sessionId: session ? session.id : null,
    eventType: 'wrap.commit_answers',
    detail: {
      outcome,
      ...(outcome === 'skipped' ? { reason } : { commitSha }),
      include: answered(ownership.DECISIONS.INCLUDE),
      leave: answered(ownership.DECISIONS.LEAVE),
      committedOwn: [...committedOwn].sort()
    }
  });
}

/**
 * Step handler. See module docstring for full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (must include `path`)
 * @param {object} [context.session] - Session record; attributes the auto-PR
 *   activity row. Absent in unit harnesses, so the row is written unattributed
 *   rather than skipped — the branch name is what makes it findable.
 * @param {object} context.step - Step spec from wrap_pipeline.steps[]
 * @param {object} context.staged - Single-transaction scratch space
 * @returns {Promise<{ok:boolean, status:string, output:object|null, blockers:string[]}>}
 */
async function run(context) {
  const { project, staged, session } = context;

  if (!project || !project.path) {
    return {
      ok: false,
      status: 'blocked',
      output: null,
      blockers: ['commit step requires context.project.path']
    };
  }
  const cwd = project.path;
  // The operator's Include / Leave answers, read once: every non-blocked return
  // below records them (#2155), the first two before the classification runs.
  const decisions = ownership.sanitizeDecisions(context.options && context.options.pathDecisions);

  // 0. Read the range base this wrap is about to replace, BEFORE anything can
  //    replace it, and report it on the outcomes a later step can act on.
  //    `continuity-write` runs after
  //    this step and needs the PREVIOUS boundary to say what the session changed;
  //    once step 8 stamps, it is gone from disk (#797). The blocked returns below
  //    carry neither field, which is the signal a consumer needs: this step
  //    reached no conclusion, so nothing may be inferred from the absence.
  const boundary = _readLastWrapSha(configRootOf(project));
  const previousWrapSha = boundary.sha;
  const previousWrapShaRead = boundary.read;

  // 0b. A release cut (#1502, #1220). Before anything is flushed, every target's
  //     prior bytes and index entry are recorded in memory and on disk, so that
  //     any halt between here and a landed commit can put the cut back — the
  //     release-prepare command failing is one such halt, no longer the only one.
  //     A cut whose undo cannot be recorded is refused with nothing changed.
  const releaseCut = _releaseCutOf(staged);
  const releasePrepareConfig = releaseCut ? _releasePrepareCommandOf(project) : null;
  const releasePrepareCommand = releasePrepareConfig ? releasePrepareConfig.command : null;
  let recovery = null;
  if (releaseCut) {
    const prepared = await _prepareReleaseRecovery({
      staged,
      root: (context.scope && context.scope.workToplevel) || null,
      configRoot: configRootOf(project),
      runId: context.wrapRunId || _localRunId(),
      cut: releaseCut
    });
    if (!prepared.ok) {
      log.warn('release cut refused before the flush', { project: project.name, reason: prepared.reason });
      return {
        ok: false,
        status: 'blocked',
        output: {
          remediation: `Nothing was written or committed: the release cut was refused before any file changed, because ${prepared.reason}. Fix that, then Retry.`
        },
        blockers: [`release cut refused: ${prepared.reason}`]
      };
    }
    recovery = prepared.recovery;
  }
  // Set just before `git add`; from then on a restore puts the index back too.
  let indexTouched = false;
  // Every halt after the flush goes through here (#1220, Safeguard 3(c)): with a
  // release cut in flight the work tree, and the index once touched, are put
  // back first, except after a commit stopped by its timeout, which may still
  // land. Without a cut there is nothing to put back and the result passes
  // through.
  const halt = async (result, opts = {}) => {
    if (!recovery) return result;
    if (opts.timedOut) return _withRecovery(result, _retainedReport(recovery));
    return _withRecovery(result, await _recoverRelease(recovery, { restoreIndex: indexTouched }));
  };
  // The artifact's removal once nothing can need it, reported on the outcome.
  const settled = (output) => {
    if (!recovery) return output;
    const removal = _removeRecoveryArtifact(recovery);
    if (removal.removed) return { ...output, releaseRecovery: { artifactDir: recovery.artifactDir, removed: true } };
    log.warn('release recovery record could not be removed after the commit', { project: project.name, problem: removal.problem });
    return {
      ...output,
      releaseRecovery: { artifactDir: recovery.artifactDir, removed: false, problem: removal.problem },
      remediation: [output.remediation, `The release landed, but ${removal.problem}.`].filter(Boolean).join(' ')
    };
  };

  // 1. Flush staged writes. Wrapped in try/catch so a single bad
  //    staging entry doesn't tear down the whole pipeline — the
  //    error surfaces as a blocker. A throw partway through a release
  //    cut is a halt after the flush began, so the cut is put back.
  let flushed;
  try {
    flushed = _flushStagedWrites(staged);
  } catch (err) {
    return halt({
      ok: false,
      status: 'blocked',
      output: null,
      blockers: [`Failed to flush staged write: ${err.message}`]
    });
  }

  // 1a. Run the release-prepare command against the flushed release.
  let releasePrepare = null;
  const releaseWritten = new Set();
  if (releaseCut && !releasePrepareCommand) {
    releasePrepare = { status: 'skipped', reason: releasePrepareConfig.reason };
  } else if (releaseCut) {
    const heldPrep = _controlBlocked(context, 'wrap-release-prepare');
    if (heldPrep) return halt(heldPrep);
    const prepRoot = (context.scope && context.scope.workToplevel) || cwd;
    const prep = await _runReleasePrepare({ cwd, root: prepRoot, command: releasePrepareCommand, cut: releaseCut });
    if (!prep.ok) {
      const report = await _recoverRelease(recovery, { restoreIndex: false });
      log.warn('release-prepare command did not succeed; the release files were put back', {
        project: project.name, reason: prep.reason, restoreProblems: report.problems
      });
      return {
        ok: false,
        status: 'blocked',
        output: {
          releasePrepare: { status: 'failed', command: releasePrepareCommand, paths: prep.paths || [] },
          releaseRecovery: report,
          remediation: _releasePrepareRemediation(prep, report)
        },
        blockers: [prep.reason, ...(prep.tail ? [prep.tail] : [])]
      };
    }
    for (const p of prep.paths) releaseWritten.add(p);
    releasePrepare = { status: 'done', command: releasePrepareCommand, paths: prep.paths };
  }

  // 1c. A work tree that is not a git repository has nothing to commit (#2008).
  //     Checked AFTER the flush, so the content steps' staged writes still land
  //     in place, and BEFORE `git status`, which exits 128 there and would block
  //     every step after this one. Git failing to answer is a different fact
  //     with the same null toplevel, and `workTreeProblem` is what tells them
  //     apart: that one blocks, because an unreadable repository is not proof
  //     that there is no repository. Same order as `session-files`.
  const scope = context.scope || null;
  if (scope && !scope.workToplevel && scope.workTreeProblem) {
    // Without the repo's toplevel no file can be judged, and "no record of when
    // this session started" would be a false reason for every one of them.
    return halt({
      ok: false,
      status: 'blocked',
      output: {
        remediation: `Nothing was committed. The wrap could not read this project's git repository, so it cannot tell which uncommitted files are this session's: ${scope.workTreeProblem}. Fix what git reports, then re-run the wrap.`
      },
      blockers: [`git could not be read: ${scope.workTreeProblem}`]
    });
  }
  if (!scope || !scope.workToplevel) {
    const reason = 'not a git repository — nothing to commit; the wrap\'s files were written in place, and this project gets no commit or PR history';
    log.info('commit step skipped — not a git repository', { project: project.name, flushedCount: flushed.length });
    _recordAnswers({ project, session, outcome: 'skipped', reason, decisions });
    // The flush IS the outcome here: nothing after it can fail, so a release
    // cut's recovery record has served its purpose.
    return {
      ok: true,
      status: 'skipped',
      output: settled({
        reason,
        flushed,
        commitSha: null,
        previousWrapSha,
        previousWrapShaRead,
        releasePrepare
      }),
      blockers: []
    };
  }

  // 2. List what is uncommitted, in the shape the launch baseline recorded
  //    (repo-root-relative, every untracked file on its own line).
  //    Empty output = working tree clean + index empty.
  const statusRes = await _internal.exec('git', ownership.statusArgs(), { cwd });
  if (statusRes.exitCode !== 0) {
    const detail = statusRes.stderr.trim() || statusRes.stdout.trim();
    return halt({
      ok: false,
      status: 'blocked',
      output: statusRes.timedOut ? {
        // NOT "your working tree is untouched": step 1 above already flushed
        // the staged writes to disk (see `_flushStagedWrites`, and the same
        // caveat spelled out at the auto-branch failure below). Session
        // artifacts from earlier steps are already there.
        remediation: 'Nothing was committed. Session artifacts staged by earlier wrap steps are already written to disk, so run `git status` to see what is there. `git status` itself is normally instant, so a repo where it hangs usually has an index lock left behind by another git process, or a very large untracked tree. Check the repo, then re-run the wrap.'
      } : null,
      blockers: [`${_describeOutcome(statusRes, 'git status')}${detail ? `: ${detail}` : ''}`]
    });
  }
  const dirty = ownership.parseStatus(statusRes.stdout);
  // #1512 — an approved un-track offer, resolved before the clean-tree exit: an
  // unchanged tracked state file leaves `git status` empty, and the removal from
  // tracking is still a commit to make.
  const untrackPaths = await _approvedUntrackPaths(context, context.scope || null);
  if (dirty.length === 0 && untrackPaths.length === 0) {
    log.info('commit step skipped — no changes to commit', { project: project.name });
    _recordAnswers({ project, session, outcome: 'skipped', reason: 'no changes to commit', decisions });
    // A clean tree after the flush means the flush changed nothing git can see,
    // so there is nothing a release cut's recovery record could put back.
    return {
      ok: true,
      status: 'skipped',
      output: settled({
        reason: 'no changes to commit',
        flushed,
        commitSha: null,
        previousWrapSha,
        previousWrapShaRead
      }),
      blockers: []
    };
  }

  // 1b. An unfinished merge, cherry-pick or revert. The wrap commits a path list,
  //     which git refuses mid-merge ("cannot do a partial commit during a
  //     merge"), and that refusal would otherwise surface as the generic
  //     hook-rejection remediation. Say what is actually in the way.
  const inProgress = await _operationInProgress(cwd);
  if (inProgress) {
    return halt({
      ok: false,
      status: 'blocked',
      output: {
        remediation: `Nothing was committed. A ${inProgress.name} is in progress in this repository, and the wrap commits only this session's files, which git does not allow until it is finished. Finish it (resolve the conflicts, then \`git commit\`) or abandon it (\`${inProgress.abort}\`), then re-run the wrap.`
      },
      blockers: [`A ${inProgress.name} is in progress, so the wrap cannot commit a chosen set of files`]
    });
  }

  // 2a. Decide what this wrap may commit (#1406). Only the session's own changes,
  //     the files this wrap wrote, and files the operator chose to include — never
  //     every uncommitted file in the tree. The `session-files` step asked for the
  //     decisions before any content step ran; this re-checks, because the commit
  //     is the step that would do the damage, and a file can turn up in between.
  //     The scope was checked at 1c: here it names a readable repository.
  const wrapWritten = _wrapWrittenPaths(flushed, dirty, scope);
  for (const p of releaseWritten) wrapWritten.add(p);
  // #1868 — re-judged against the upstream commit `session-files` recorded, from
  // the tree as it is NOW (a wrap step may have rewritten a file since), with no
  // network call. If the local ref moved meanwhile, the newer commit can only
  // tighten what is committed.
  const provenance = await _internal.recheckProvenance((scope && scope.workToplevel) || cwd, dirty, context.previousResults);
  const secrets = secretCheck.check((scope && scope.workToplevel) || cwd, ownership.classify(scope, dirty, {
    wrapWritten,
    decisions,
    decisionBasis: ownership.sanitizeDecisionBasis(context.options && context.options.pathDecisionBasis),
    provenance,
    // #1738 — Prawduct's state stays out of a commit made on an engine that
    // cannot run Prawduct, whoever edited it; it is named in the output instead.
    withheldPrefixes: governance.withheldPrefixesFor(context.methodology)
  }), decisions);
  const classified = secrets.classified;
  if (secrets.report.flagged.length > 0 || secrets.report.skipped.length > 0) {
    secretCheck.record({
      project, session, stepId: (context.step && context.step.id) || 'commit',
      blocked: secrets.undecided.length > 0, report: secrets.report
    });
  }
  if (secrets.undecided.length > 0) {
    return halt({
      ok: false,
      status: 'blocked',
      output: {
        foreignPaths: secrets.undecided,
        included: classified.included,
        left: classified.left,
        secretScan: secrets.report,
        safetyWithheld: classified.safetyWithheld,
        refusedIncludes: classified.refusedIncludes,
        ..._provenanceOutput(classified, provenance),
        manifest: ownership.manifestOf(classified, secrets.undecided, secrets.report.left),
        remediation: secretCheck.remediation(secrets) + _provenanceChangedNote(classified)
      },
      blockers: secretCheck.blockerLines(secrets)
    });
  }
  // A rename whose halves got different answers is refused HERE — before step 3a
  // creates a wrap branch. `splitRenames` is complete from step 2a, and blocking
  // after the checkout would leave HEAD on a fresh empty `wrap/<ts>-<slug>`: the
  // orphan-branch residue this very fix exists to stop producing.
  //
  // Committing one half is not a smaller version of the change. Publish only the
  // destination and the source stays tracked, so the file is committed under
  // both names and the history reads as an add; publish only the source and a
  // move reads as a deletion. Both look like a successful wrap, which is why
  // this refuses rather than warns (#1629).
  if (classified.splitRenames && classified.splitRenames.length > 0) {
    return halt({
      ok: false,
      status: 'blocked',
      output: {
        splitRenames: classified.splitRenames,
        remediation: splitRenameRemedy(classified.splitRenames)
      },
      blockers: classified.splitRenames.map((r) => 'a rename would be half-committed: '
        + `${r.staged.join(', ')} would go in but ${r.left.join(', ')} would be left out, which commits `
        + 'the file under both names rather than recording a move')
    });
  }

  // 2b. A release cut commits every one of its files or none (#1220). With
  //     CHANGELOG.md left out while the version file and the fragment deletions
  //     go in, the fragments are consumed and never published, and with the
  //     record removed nothing would refuse the next cut; with every release
  //     file left out, the cut sits flushed and uncommitted, an untracked
  //     fragment gone for good. Either way the cut is put back, before anything
  //     is branched or staged, and the operator is told to include them all or
  //     hold the release.
  if (recovery) {
    const releasePaths = new Set(recovery.repoPaths);
    const stageable = new Set(classified.stageable);
    const leftOut = dirty.map((d) => d.path).filter((p) => releasePaths.has(p) && !stageable.has(p));
    if (leftOut.length > 0) {
      return halt({
        ok: false,
        status: 'blocked',
        output: {
          releaseLeftOut: leftOut,
          left: classified.left,
          remediation: `Nothing was committed. A release cut commits all of its files or none, and ${leftOut.join(', ')} would have been left out of this commit. Include every release file (CHANGELOG.md, the version file and each changelog fragment), or choose Release: Hold, then Retry.`
        },
        blockers: [`a release cut would be half-committed: ${leftOut.join(', ')} left out`]
      });
    }
  }

  if (classified.stageable.length === 0 && untrackPaths.length === 0) {
    log.info('commit step skipped — every uncommitted file was left out by the operator', {
      project: project.name, left: classified.left.length
    });
    const reason = _nothingToCommitReason(classified, secrets.report);
    _recordAnswers({ project, session, outcome: 'skipped', reason, decisions });
    return {
      ok: true,
      status: 'skipped',
      output: {
        reason,
        flushed,
        left: classified.left,
        tangleclawState: classified.tangleclawState,
        secretScan: secrets.report,
        safetyWithheld: classified.safetyWithheld,
        refusedIncludes: classified.refusedIncludes,
        ..._provenanceOutput(classified, provenance),
        manifest: ownership.manifestOf(classified, [], secrets.report.left),
        commitSha: null,
        previousWrapSha,
        previousWrapShaRead
      },
      blockers: []
    };
  }

  // 3. Capture current branch for subject-building. Detached / missing
  //    git → null and the subject falls back to generic. Branch detection
  //    failure must NOT block the commit — the commit itself is what
  //    matters.
  let branch = null;
  let branchProbeStopped = false;
  try {
    const br = await _internal.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    if (br.exitCode === 0) {
      const name = br.stdout.trim();
      if (name && name !== 'HEAD') branch = name;
    } else if (br.timedOut) {
      // This is the ONE probe in this step where reading a stop as a negative
      // answer changes what the wrap DOES rather than what it says. A null
      // branch makes `onProtectedBranch` false below, which turns the
      // auto-branch guard off — so a wrap fired on `main` would commit
      // straight to `main`, which is precisely the outcome that guard was
      // added to prevent. Recorded here and acted on in step 3a.
      branchProbeStopped = true;
      log.warn('branch probe was stopped before it answered; the protected-branch check cannot be made', {
        project: project.name, error: br.error
      });
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
  //     Branch detection FAILURES (branch === null because git answered
  //     and the answer was "detached" or "not a repo") are NOT auto-
  //     branched — we can't know what we're protecting against, and git
  //     has told us we are not sitting on a named branch.
  //
  //     A branch probe we KILLED is a different thing and is handled
  //     separately below. It produces the same null, but it is not an
  //     answer: the wrap may well be on `main`, and letting the null
  //     switch the guard off would commit straight to the branch the
  //     guard exists to protect — silently, which is the failure mode
  //     the guard was added for in the first place. So an unanswered
  //     probe halts instead, and says why.
  //
  //     A failed `git checkout -b` is a blocker — the operator's
  //     intent ("safely wrap to a branch") was clear; silently
  //     committing to main against that intent would be worse than
  //     halting.
  const directToMainAllowed = !!(context.options && context.options.allowDirectToMain === true);
  // An unanswered branch probe halts rather than committing to a branch nobody
  // identified. `allowDirectToMain` still bypasses: an operator who has already
  // said "commit wherever I am" is not protected by this check and should not be
  // stopped by it.
  if (branchProbeStopped && !directToMainAllowed) {
    return halt({
      ok: false,
      status: 'blocked',
      output: {
        branch: null,
        remediation: 'Nothing was committed. The wrap could not read which branch you are on — `git rev-parse --abbrev-ref HEAD` was stopped before it answered — so it cannot tell whether committing here would land directly on a protected branch. Check the repo (`git status`), then re-run the wrap. If you know you want to commit wherever HEAD currently is, tick the direct-to-main option in the wrap drawer.'
      },
      blockers: [
        'Branch detection was stopped before it answered, so the protected-branch check could not be made.'
      ]
    });
  }
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
    const heldBranch = _controlBlocked(context, 'wrap-branch');
    if (heldBranch) return halt(heldBranch);
    const checkoutRes = await _internal.exec('git', ['checkout', '-b', wrapBranchName], { cwd });
    if (checkoutRes.exitCode !== 0) {
      const detail = checkoutRes.stderr.trim() || checkoutRes.stdout.trim();
      // NOTE (post-#264 Critic NOTE): staged writes from step 1
      // (`_flushStagedWrites`) have already landed on disk by this
      // point. `priming-roll`'s artifacts are safe to leave in the
      // working tree on a halted wrap — the operator typically retries
      // after addressing the auto-branch failure, and the same artifacts
      // are re-staged on retry idempotently. A release cut is the write
      // step whose side effects must NOT persist across a halted wrap
      // (a consumed fragment would be compiled twice or never), and
      // `halt` puts those back (#1220).
      return halt({
        ok: false,
        status: 'blocked',
        output: {
          branch: originalBranch,
          attemptedWrapBranch: wrapBranchName,
          // A killed `git checkout -b` leaves the branch's existence unknown:
          // the ref may have been written before the kill even though HEAD did
          // not move. Say so rather than let a retry hit "branch already
          // exists" with no explanation for where it came from.
          ...(checkoutRes.timedOut ? {
            remediation: `Nothing was committed. The wrap was creating ${wrapBranchName} when the command was stopped, so that branch may or may not exist — check with \`git branch --list ${wrapBranchName}\` and delete it if it was left behind, then re-run the wrap.`
          } : {})
        },
        blockers: [
          `${_describeOutcome(checkoutRes, 'Auto-branch')}${detail ? `: ${detail}` : ''}`,
          'Set context.options.allowDirectToMain to bypass auto-branching.'
        ]
      });
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
  //    The release files releasePrepareCommand changed are staged as a body-line
  //    entry first, so the auto-PR body built later from `staged` names them too.
  //    Only those this commit takes: a Left file is not in it.
  if (releasePrepare && releasePrepare.status === 'done') {
    staged['commit:release-prepare'] = {
      releaseCompanions: releasePrepare.paths.filter((p) => classified.stageable.includes(p))
    };
  }
  // Every non-routine file the commit takes is named (#1724): a wrap PR that
  // said only "session-wrap artifacts" is how ten scratch files reached `main`
  // with nobody able to see them in review. The wrap's own writes are routine
  // and already described by the step that wrote them.
  const sessionFiles = classified.owned.filter((p) => !wrapWritten.has(p));
  if (sessionFiles.length > 0 || classified.included.length > 0) {
    staged['commit:session-files'] = { sessionFiles, includedFiles: classified.included };
  }
  // TangleClaw's own maintenance goes in without the operator being asked, so the
  // commit says so by name (#1509) — a reader of the history must be able to tell
  // those lines from the session's work.
  if (classified.tangleclawMaintenance.length > 0) {
    staged['commit:tangleclaw-maintenance'] = { tangleclawMaintenance: classified.tangleclawMaintenance };
  }
  if (untrackPaths.length > 0) {
    staged['commit:untrack-state'] = { untrackState: untrackPaths };
  }
  const message = _buildMessage(staged, branch);

  // 5. Stage exactly the paths step 2a allowed, and nothing else (#1406). The
  //    paths go through a NUL-separated pathspec file rather than argv, so a
  //    session with thousands of changed files cannot overflow the command line,
  //    and each carries `:(top,literal)` so a path is matched from the repo root
  //    as spelled — a file named `a*.js` must not stage every `a…js`.
  //    Two lists, because git wants different things from each command.
  //    `stageable` is the COMMIT selection: everything this wrap may publish,
  //    including paths git has already removed from the index — a rename's
  //    source belongs in the commit, and `git commit` accepts it. `addable` is
  //    what `git add` can resolve; handing it an already-removed path matches
  //    nothing and exits 128, which is what blocked a live wrap (#1629).
  const heldCommit = _controlBlocked(context, 'wrap-commit');
  if (heldCommit) return halt(heldCommit);
  //    A path added to the index this session and then deleted from the work
  //    tree by the flush (porcelain `AD`: a pre-staged new fragment the release
  //    consumed, #1220) is one `git add -A` resolves — it stages the removal of
  //    the index entry — and one a commit pathspec must not name: after that
  //    add the path is known to neither HEAD, the index nor the work tree, and
  //    `git commit <pathspec>` fails on it before any hook runs. So it stays in
  //    `addable` and leaves the commit selection. The untrack route's temporary
  //    index is seeded from HEAD and never held it, so it leaves that add too
  //    and the real index is brought level after the commit.
  //    Only paths this wrap is AUTHORIZED to commit qualify: an `AD` path the
  //    operator left out, or that is foreign, is their staged work, and the
  //    untrack route's index sync must never touch it. Intersected here, once,
  //    before anything reads the set.
  const stageableSet = new Set(classified.stageable);
  const addedThenDeleted = new Set(dirty.filter((d) => d.deleted && d.newToRepo && stageableSet.has(d.path)).map((d) => d.path));
  const commitPaths = classified.stageable.filter((p) => !addedThenDeleted.has(p));
  const tempIndexAddable = classified.addable.filter((p) => !addedThenDeleted.has(p));
  const pathspecFile = _writePathspecFile(commitPaths);
  const pathspecArgs = [`--pathspec-from-file=${pathspecFile}`, '--pathspec-file-nul'];
  const addPathspecFile = _writePathspecFile(classified.addable);
  const addPathspecArgs = [`--pathspec-from-file=${addPathspecFile}`, '--pathspec-file-nul'];
  const tempIndexAddFile = _writePathspecFile(tempIndexAddable);
  const tempIndexAddArgs = [`--pathspec-from-file=${tempIndexAddFile}`, '--pathspec-file-nul'];
  let commitRes;
  try {
    // An empty pathspec file would make `git add -A` stage the whole tree, so a
    // commit with nothing to add skips it rather than handing git no paths.
    // That now includes a commit whose every path is already staged — a pure
    // rename — not only the untrack-only case.
    // From here the index may change, so a release cut's restore puts the
    // recorded index entries of its targets back too (#1220, Safeguard 3(e)).
    indexTouched = true;
    const addRes = classified.addable.length > 0
      ? await _internal.exec('git', ['add', '-A', ...addPathspecArgs], { cwd })
      : { exitCode: 0, stdout: '', stderr: '' };
    if (addRes.exitCode !== 0) {
      const addDetail = addRes.stderr.trim() || addRes.stdout.trim();
      return await halt({
        ok: false,
        status: 'blocked',
        output: addRes.timedOut ? {
          // `git add` stages incrementally, so a kill can leave the index
          // PARTIALLY staged — no commit was made, but the index is not
          // necessarily as it was. Naming that is the difference between a
          // recoverable state and a confusing one.
          remediation: 'Nothing was committed, but `git add` was stopped partway, so some paths may already be staged. Run `git status` to see where it got to (`git reset` unstages without touching your files), then re-run the wrap.'
        } : null,
        blockers: [`${_describeOutcome(addRes, 'git add')}${addDetail ? `: ${addDetail}` : ''}`]
      });
    }

    // 5b. With every selected path an added-then-deleted one, the add above
    //     left the index exactly as HEAD has it and there is nothing to commit;
    //     an empty pathspec file would commit the whole index instead. A release
    //     cut can never be here (its promoted CHANGELOG is always selected), so
    //     one in flight is a contradiction answered by putting the cut back.
    if (commitPaths.length === 0 && untrackPaths.length === 0) {
      const reason = `nothing to commit — the only files selected (${[...addedThenDeleted].join(', ')}) were added to the index this session and then deleted, which leaves the tree as HEAD has it`;
      if (recovery) {
        return await halt({
          ok: false,
          status: 'blocked',
          output: { remediation: 'Nothing was committed: the release cut selected no file to commit, which should not happen; the cut is put back. Re-run the wrap, and report this if it recurs.' },
          blockers: [`release cut with no file to commit (${reason})`]
        });
      }
      log.info('commit step skipped — only added-then-deleted paths were selected', { project: project.name, paths: [...addedThenDeleted] });
      _recordAnswers({ project, session, outcome: 'skipped', reason, decisions });
      return {
        ok: true,
        status: 'skipped',
        output: { reason, flushed, commitSha: null, previousWrapSha, previousWrapShaRead, releasePrepare },
        blockers: []
      };
    }

    // 6. Commit the same paths only. `git commit <pathspec>` commits those paths
    //    and leaves anything else already in the index staged but uncommitted — an
    //    operator who had `git add`-ed their own work keeps it out of this commit.
    //    `execFile` doesn't go through a shell, so a multi-line message with
    //    quotes, newlines, and special chars reaches `git commit -m` byte-intact.
    commitRes = untrackPaths.length > 0
      ? await _commitWithUntrack({
        cwd,
        message,
        addPathspecArgs: tempIndexAddArgs,
        hasAddable: tempIndexAddable.length > 0,
        untrackPaths,
        // Derived by the module that owns the classification, not filtered here:
        // one definition of "authorized AND already removed from the index". It
        // reads `indexRemoved` with no empty-array fallback on purpose — a
        // classification missing it is a bug, and defaulting would silently
        // commit a rename's source beside its destination.
        indexRemoved: ownership.removedFromIndexOf(classified),
        addedThenDeleted: [...addedThenDeleted]
      })
      : await _internal.exec('git', ['commit', '-m', message, ...pathspecArgs], { cwd });
  } finally {
    _removePathspecFile(pathspecFile);
    _removePathspecFile(addPathspecFile);
    _removePathspecFile(tempIndexAddFile);
  }
  if (commitRes.exitCode !== 0) {
    // Pre-commit hook failures land here. Surface the hook output
    // verbatim so the user sees what to fix. Per CLAUDE.md's Git
    // Safety Protocol we don't pass --no-verify — the hook is the
    // user's intentional gate.
    const detail = commitRes.stderr.trim() || commitRes.stdout.trim();
    // A stopped commit restores nothing (#1220): it may still land, and a
    // restore would race it. A rejected one is put back, index included.
    return halt({
      ok: false,
      status: 'blocked',
      output: {
        flushed,
        message,
        branch,
        // A KILLED commit and a REJECTED one need different instructions, and
        // this is the site where getting it wrong costs the most. "The commit
        // was rejected — read the hook output above" is false twice over when
        // the command was stopped: there is no hook output, and the commit may
        // have LANDED. A long-running pre-commit hook is the likeliest way to
        // reach the kill, and such a hook can still finish — letting git write
        // the commit — after we have stopped waiting for it.
        remediation: commitRes.timedOut
          ? 'The commit command was stopped before it answered, so it is unknown whether the commit landed. A pre-commit hook that outran the wrap is the usual cause, and such a hook can still complete after we stop waiting. Run `git log -1` first: if your wrap commit is there, the commit succeeded and only the wrap was cut short; if it is not, nothing was committed. Re-running the wrap is safe once you know which.'
          : 'The commit was rejected — most often by a pre-commit hook (e.g. husky running tests or lint). Read the hook output above, fix what it flagged, then re-run the wrap. The wrap pipeline never passes `--no-verify`; the hook is your intentional gate.'
      },
      blockers: [`${_describeOutcome(commitRes, 'git commit')}${detail ? `: ${detail}` : ''}`]
    }, { timedOut: commitRes.timedOut === true });
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
    log.warn('git rev-parse HEAD did not return a SHA after the commit landed', {
      project: project.name,
      exitCode: shaRes.exitCode,
      // Whether the probe was STOPPED or answered non-zero points at different
      // causes (a wedged repo vs a broken git), and this log line is the only
      // record either way.
      timedOut: !!shaRes.timedOut,
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
      project: project.name, exitCode: parentRes.exitCode, timedOut: !!parentRes.timedOut
    });
  }
  // A wrap commit with no parent (a repo whose first-ever commit is a wrap) has no
  // pre-wrap base — fall back to the wrap commit's own SHA rather than skip the
  // stamp, so the next session still has a boundary to measure from.
  const stampSha = baseSha || commitSha;
  let stamped = false;
  if (stampSha) {
    stamped = _stampLastWrapSha(configRootOf(project), stampSha);
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
      autoPr = await _autoPrCloseLoop({
        cwd, branch, originalBranch, staged, configRoot: configRootOf(project),
        withholdAutoMerge: _autoMergeWithheldReason(context.methodology),
        controlGate: context.controlGate,
        project
      });
    } catch (err) {
      autoPr = {
        attempted: true,
        pushed: false,
        prUrl: null,
        autoMergeArmed: false,
        returnedToBranch: false,
        remote: null,
        skippedReason: null,
        error: redactRemoteOutput(`auto-PR close-loop threw: ${err.message}`),
        remediation: `The wrap commit is safe on local branch ${branch}. Push it and open a PR manually.`
      };
    }
    const stranded = _isStranded(autoPr);
    if (autoPr.error || stranded) {
      log.warn('wrap auto-PR close-loop degraded', {
        project: project.name,
        branch,
        pushed: autoPr.pushed,
        prUrl: autoPr.prUrl,
        autoMergeArmed: autoPr.autoMergeArmed,
        skippedReason: autoPr.skippedReason,
        // Second pass, for the same reason the `activity_log` row below takes
        // one: this line lands in `~/.tangleclaw/logs/tangleclaw.log`, which is
        // tailed and pasted into issues, and a log line may never carry a
        // credential (`observability-strategy.md` § Direction).
        error: redactRemoteOutput(autoPr.error)
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

    // Persist the outcome. The log lines above rotate out — a wrap that pushed
    // its branch and never opened a PR became unattributable once they aged,
    // and the branch sat undiscovered because nothing else records whether the
    // PR opened. `activity_log` is the durable side: one row per auto-branched
    // wrap, carrying the branch name so a stranded wrap can be found later by
    // querying instead of by noticing. Never throws (`store.activity.log`
    // swallows and no-ops without a DB), so this cannot break a wrap.
    store.activity.log({
      projectId: project.id,
      sessionId: session ? session.id : null,
      eventType: 'wrap.auto_pr',
      detail: {
        branch,
        pushed: autoPr.pushed,
        prUrl: autoPr.prUrl,
        autoMergeArmed: autoPr.autoMergeArmed,
        stranded,
        skippedReason: autoPr.skippedReason,
        // Already redacted by the producers that built it; this is the
        // reporter's second pass, which the observability Direction permits and
        // this row wants — it is served over `GET /api/activity` and a rare row
        // type can sit in the table indefinitely, so it must not depend on every
        // current and future producer having remembered.
        error: redactRemoteOutput(autoPr.error)
      }
    });
    // The full record of a stranded wrap, in its own event type: the busy
    // `wrap.auto_pr` type is pruned at a fixed row count, which would drop a
    // stranded branch long before anyone acted on it. Keyed by remote, branch
    // and head, so an acknowledgement covers exactly this head.
    if (stranded) {
      strandedWraps.record({
        projectId: project.id,
        sessionId: session ? session.id : null,
        remote: autoPr.remote,
        branch,
        headSha: commitSha
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
  _recordAnswers({ project, session, outcome: 'committed', commitSha, decisions, committedOwn: classified.owned });

  // The commit landed, so the release cut's recovery record has nothing left
  // to recover (#1220); `settled` removes it and reports the removal.
  return {
    ok: true,
    status: 'done',
    output: settled({
      commitSha,
      message,
      branch,
      flushed,
      stamped,
      // #797 — the boundary this wrap's stamp replaced, so `continuity-write`
      // can measure the session's range after the stamp has moved, plus WHY it is
      // null when it is: `absent` (no wrap has ever stamped) and `unreadable` (a
      // config that would not load) are the same value and different answers.
      previousWrapSha,
      previousWrapShaRead,
      // #264 — surface the auto-branch decision so Chunk 10's UI can
      // render "Wrap committed on branch <X> (auto-branched off
      // <originalBranch>)" alongside a "Push + open PR" affordance.
      // `autoBranched: false` covers both the on-feature-branch case
      // (no auto-branch needed) and the explicit-allowDirectToMain
      // escape hatch.
      autoBranched,
      originalBranch,
      // #1502 — null when this wrap cut no release; otherwise whether the
      // project's releasePrepareCommand ran and which paths it changed.
      releasePrepare,
      // #1508/#1509 — TangleClaw's own files: what went in as maintenance, and
      // the machine state deliberately left out of the commit.
      tangleclawMaintenance: classified.tangleclawMaintenance,
      tangleclawState: classified.tangleclawState,
      // #1738 — Prawduct-owned paths left out of this commit because the
      // session's engine cannot run Prawduct. They stay in the working tree.
      methodologyWithheld: classified.methodologyWithheld,
      // #1858 — runtime databases left out whatever was answered, the Includes
      // ignored for them, and the whole picture by path for the audit trail.
      safetyWithheld: classified.safetyWithheld,
      refusedIncludes: classified.refusedIncludes,
      // #1868 — files upstream already held, left out of this commit.
      ..._provenanceOutput(classified, provenance),
      manifest: ownership.manifestOf(classified, [], secrets.report.left),
      // #1512 — state paths this commit removed from tracking.
      untrackState: untrackPaths,
      // #1513 — files matching a secret pattern (rule names only) with the
      // operator's decision for each, and files not scanned with the reason.
      secretScan: secrets.report,
      // #467 — auto-PR close-loop result for auto-branched commits;
      // null when no auto-branch happened (nothing dangles). The drawer
      // renders the outcome on the commit row's detail line.
      autoPr,
      // #2320 — the drawer shows a step's own `remediation` and nothing nested
      // under `autoPr`. A PR left unarmed because the merge is someone else's
      // reads there as a failure to arm unless the reason sits beside it.
      ...(autoPr && autoPr.mergeAuthority ? { remediation: autoPr.remediation } : {})
    }),
    blockers: []
  };
}

const _internal = {
  exec: defaultExec,
  execShell,
  // Who decides this project's merges (#2320). A seam so a test can make the
  // answer anything, including one no real project could produce.
  mergeAuthority: require('../merge-authority'),
  /**
   * Re-judge upstream provenance at the commit boundary, with no network call.
   *
   * @param {string} toplevel
   * @param {Array<object>} dirty
   * @param {Array<object>} previousResults
   * @returns {Promise<object>}
   */
  recheckProvenance: (toplevel, dirty, previousResults) =>
    upstreamProvenance.recheck(toplevel, dirty, upstreamProvenance.capturedFrom(previousResults)),
  existsSync: fs.existsSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs),
  mkdirSync: fs.mkdirSync.bind(fs),
  rmSync: fs.rmSync.bind(fs),
  // Overridable so a guard can drive the timeout path in milliseconds.
  releasePrepareTimeoutMs: RELEASE_PREPARE_TIMEOUT_MS
};

module.exports = {
  run,
  _internal,
  _flushStagedWrites,
  _snapshotStagedTargets,
  _restoreSnapshot,
  _prepareReleaseRecovery,
  _recoverRelease,
  _recoveryRemediation,
  _realpathOr,
  _isDeleteEntry,
  _buildSubject,
  _buildBodyLines,
  _buildMessage,
  _buildAutoPrBody,
  _autoPrCloseLoop,
  _stampLastWrapSha,
  _readLastWrapSha,
  _commitWithUntrack,
  _releaseCutOf,
  _runReleasePrepare,
  _isStranded,
  splitRenameRemedy,
  MAX_SUBJECT_LEN
};
