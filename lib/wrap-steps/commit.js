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
 * persisted on `projConfig.lastWrapSha`. This unblocks Chunks 4
 * (lint scope) and 7 (critic-check range detection) to drop their
 * `HEAD~10..HEAD` fallback in favor of a true `<lastWrapSha>..HEAD`
 * range — that wiring lands in a future chunk; Chunk 9 just makes
 * the stamp available.
 *
 * **Blocker contract.** Unlike Chunks 5–8 (always-ok handlers),
 * this step IS a real blocker. `step.blocker: true` in the
 * methodology template means a git failure halts the pipeline.
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
  // Word-boundary anchored to mirror priming-roll + critic-check's
  // CHUNK_TAG regex shape (ADR 0002) — prevents `junkchunk-9` matching.
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
 *   - `{warning:true, owedRationale, isMediumPlus}` (critic-check)
 *       → "Critic skip rationale: ..."
 *   - `{branch, sessionScoped, resolutions}` (pr-check)
 *       → "Open session-scoped PRs: N" + per-PR resolution lines
 *   - `{oldVersion, newVersion, bumpLevel}` (version-bump)
 *       → "Bumped <old> → <new> (<level>)". Deduped — version-bump
 *         stages TWO entries (version-json + changelog) carrying the
 *         same metadata; only the first is rendered.
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
    // priming-roll edge case: priming staged a write but the plan
    // produced no parseable chunks (`current:null, allDone:false`).
    // The file still gets flushed; the body line says so explicitly
    // so the commit message doesn't silently swallow it.
    if (entry.pointer && entry.pointer.current === null
        && entry.pointer.allDone === false
        && typeof entry.primingPath === 'string') {
      lines.push(`- Priming refreshed (${stepId}): plan has no parseable chunks`);
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

    // critic-check
    if (entry.warning === true) {
      if (entry.owedRationale) {
        lines.push(`- Critic skip rationale: ${entry.owedRationale}`);
      } else {
        lines.push('- Critic warning: medium+ work without Critic dispatch (no rationale provided)');
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
 * @param {string} sha
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
      output: { flushed, message, branch },
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

  // 8. Stamp lastWrapSha. Non-fatal — see _stampLastWrapSha doc.
  let stamped = false;
  if (commitSha) {
    stamped = _stampLastWrapSha(project.path, commitSha);
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
      stamped
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
  _stampLastWrapSha,
  MAX_SUBJECT_LEN
};
