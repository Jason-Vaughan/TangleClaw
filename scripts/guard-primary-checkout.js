#!/usr/bin/env node
'use strict';
/**
 * PreToolUse guard — the primary checkout is the running install (#798).
 *
 * launchd runs `server.js` from the primary checkout and serves `public/`
 * straight off that working tree: no build, no staging copy, no deploy step. An
 * edit there is live to the operator the instant it hits disk. Chunk work
 * therefore happens in git worktrees — but `$CLAUDE_PROJECT_DIR` expands to
 * where a session STARTED and stays fixed for its whole life, so everything the
 * session dispatches (subagents, Skills, scripts) inherits the primary checkout
 * as its cwd even after the session itself has moved. One mechanism, five
 * documented incidents; the worktree convention fixes the session's own edits
 * and nothing about the dispatched ones.
 *
 * Two predicates, neither of which depends on worktree bookkeeping — nothing
 * retires stale worktrees (#1267), so arming on worktree PRESENCE would arm
 * permanently and the guard would simply be switched off:
 *
 *   P1  the session's own root is a linked worktree, the write lands in the
 *       primary, and the file is tracked by git  →  refuse.
 *   P2  the write lands on `public/**` or `server.js` in the primary  →  refuse,
 *       whatever the session root. That is the surface that is live on WRITE
 *       rather than on restart, and it is what locked the operator out of
 *       Chrome (#710). It is also the only predicate that can see a swarm
 *       subagent whose coordinator was itself launched in the primary.
 *
 * FAILS OPEN by construction, which is the opposite of `lib/master.js`'s write
 * guard and is argued rather than inherited. That guard bounds an UNTRUSTED
 * agent's authority — a security boundary, where failing open means writing
 * where it was never allowed. This one prevents an ACCIDENT by a trusted agent —
 * a safety interlock, where failing closed costs the whole session: Claude Code
 * feeds hook failures back as synthetic user messages, so a buggy guard loops
 * forever on a machine the operator is almost never at. Every internal error
 * exits 0 with no decision and one line on stderr.
 *
 * Wiring lives in the gitignored `.claude/settings.local.json`, written by
 * `scripts/install-primary-guard.js`, NOT in the tracked `.claude/settings.json`
 * — that file carries no hooks by contract (#1022/#1275), and "this checkout is
 * the live install" is a fact about this machine rather than about the repo, so
 * a committed P2 would refuse `public/` edits in a contributor's clone.
 *
 * The script lives in `scripts/` rather than `.claude/hooks/` because `.claude/*`
 * is gitignored fail-closed with one deliberate exception, and this file must be
 * tracked, reviewable and testable. Nothing depends on the location: the wiring
 * is an absolute path either way.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const {
  realOrSelf, locateCheckouts, linkedWorktreeRoots, landsInPrimary
} = require(path.join(REPO_ROOT, 'lib', 'checkout-layout.js'));
const { checkContainment } = require(path.join(REPO_ROOT, 'lib', 'project-paths.js'));

/** Verbs that move a working tree under the running server. `commit` is not one. */
const HEAD_MOVING_VERBS = ['checkout', 'switch', 'reset', 'rebase', 'merge'];

/** Waives the guard for one command; can be set inline, so it is not sticky. */
const OVERRIDE_ENV = 'TANGLECLAW_ALLOW_PRIMARY_WRITE';

/** Waives the guard for a tool call, which cannot carry an env var. Gitignored. */
const OVERRIDE_FILE = path.join('.prawduct', '.allow-primary-write');

/**
 * Emit the documented PreToolUse refusal and stop.
 *
 * @param {string} reason - Operator-facing explanation, including how to proceed.
 * @returns {void}
 */
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

/**
 * Exit without a decision, leaving the normal permission flow untouched.
 *
 * The note goes to stderr, which the harness does not feed back on exit 0 — so
 * it is visible under `--debug` and inert otherwise. That asymmetry is the
 * point: a guard that cannot establish its own preconditions must stay
 * diagnosable without being able to interrupt anyone.
 *
 * @param {string|null} note - Why no decision was reached; null when the
 *   fall-through is a normal outcome rather than a failure.
 * @returns {void}
 */
function failOpen(note) {
  if (note) process.stderr.write(`guard-primary-checkout: ${note}\n`);
  process.exit(0);
}

/**
 * Is the file tracked by git in the primary checkout?
 *
 * Tracked files are the live install and its source. Untracked files under the
 * primary — `.prawduct/` above all — are written there BY DESIGN: the Stop
 * hook's reflection lands there, and every worktree session symlinks its
 * governance state back to it. Refusing those would break governance in order to
 * protect source.
 *
 * A git that will not answer leaves the question unestablished, and unestablished
 * means "do not refuse" here. That is the permissive direction, chosen to match
 * this guard's fail-open posture, and stated because the opposite reading is the
 * one a reader would expect from a guard.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @param {string} realTarget - Absolute, symlink-resolved target path.
 * @returns {boolean} True only when git says the path is tracked.
 */
function isTracked(primary, realTarget) {
  const rel = path.relative(primary, realTarget);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    execFileSync('git', ['-C', primary, 'ls-files', '--error-unmatch', '--', rel],
      { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Is this the serving surface that goes live on write rather than on restart?
 *
 * `public/**` and `server.js` only. `lib/**` is deliberately absent: it is live
 * on the next launchd restart, not on write, so refusing it would block ordinary
 * main-side work whose worst case is a lost edit rather than a broken operator
 * environment.
 *
 * @param {string} realTarget - Absolute, symlink-resolved target path.
 * @param {string} primary - Absolute primary checkout root.
 * @returns {boolean} True for the live-on-write surface.
 */
function isLiveSurface(realTarget, primary) {
  if (checkContainment(path.join(primary, 'public'), realTarget).inside) return true;
  return realTarget === realOrSelf(path.join(primary, 'server.js'));
}

/**
 * Has the operator waived the guard for this invocation?
 *
 * Two routes because they answer different situations. The env var can be set
 * inline on a single command — the precise, non-sticky form, and the right one
 * for Bash. A tool call cannot carry an env var, so the file arm honours a
 * gitignored sentinel instead.
 *
 * Neither is a lock, and that is stated rather than hidden: an EXPORTED env var
 * is inherited by the very subagents this guard exists to catch, and a forgotten
 * sentinel disarms it indefinitely. Both are a deliberate act that leaves a
 * trace, which is all they claim to be.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {boolean} True when the guard should stand down.
 */
function overridden(primary) {
  const v = process.env[OVERRIDE_ENV];
  if (typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false') return true;
  try {
    fs.statSync(path.join(primary, OVERRIDE_FILE));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * How to proceed deliberately — appended to every refusal so the operator never
 * has to go looking for it.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {string} Sentence naming both override routes.
 */
function overrideHint(primary) {
  return ` To do this deliberately: set ${OVERRIDE_ENV}=1 (inline on the command), or create `
    + `${path.join(primary, OVERRIDE_FILE)} for the duration of the edit and delete it after.`;
}

/**
 * Does this shell command move a working tree with git?
 *
 * Requires BOTH a `git` token and a working-tree-moving subcommand, so
 * `grep -r checkout` or a path containing the word does not read as one.
 * `commit` is deliberately absent: it does not move file content, and the
 * session wrap commits on `main` in the primary by design.
 *
 * @param {string} command - The Bash tool's command string.
 * @returns {boolean} True when the command appears to move a working tree.
 */
function movesWorkingTree(command) {
  if (!/(^|[\s;&|(])git(\s|$)/.test(command)) return false;
  return HEAD_MOVING_VERBS.some((v) => new RegExp(`(^|[\\s;&|(])${v}([\\s;&|)]|$)`).test(command));
}

/**
 * The directory a git command would act on: an explicit `-C <path>` wins over
 * the tool's cwd, because that is what git itself does.
 *
 * @param {string} command - The Bash tool's command string.
 * @param {string} cwd - The tool's working directory.
 * @returns {string} Absolute, symlink-resolved directory.
 */
function effectiveGitDir(command, cwd) {
  const m = /(?:^|\s)-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const named = m && (m[1] || m[2] || m[3]);
  return realOrSelf(named ? path.resolve(cwd, named) : cwd);
}

/**
 * Apply both predicates to one tool call.
 *
 * @param {object} input - Parsed PreToolUse stdin payload.
 * @returns {void} Denies and exits, or falls through to the normal flow.
 */
function evaluate(input) {
  const sessionRoot = process.env.CLAUDE_PROJECT_DIR;
  if (!sessionRoot) return failOpen('CLAUDE_PROJECT_DIR is unset — cannot locate the checkout');

  const located = locateCheckouts(sessionRoot);
  if (!located) return failOpen(`could not establish the checkout layout at ${sessionRoot}`);
  const primary = located.primary;
  const sessionIsWorktree = located.isWorktree;

  if (overridden(primary)) return failOpen(null);

  const ti = (input && input.tool_input) || {};
  const cwd = realOrSelf(input.cwd || sessionRoot);
  const { roots, unreadable } = linkedWorktreeRoots(primary);
  if (unreadable.length) {
    process.stderr.write(
      `guard-primary-checkout: unreadable worktree records: ${unreadable.join(', ')}\n`);
  }

  if (input.tool_name === 'Bash') {
    // P1 only. `git checkout main` in the primary is the documented fast
    // rollback from a bad branch, so a primary-rooted session must keep it.
    if (!sessionIsWorktree) return;
    const command = typeof ti.command === 'string' ? ti.command : '';
    if (!movesWorkingTree(command)) return;
    // The command TEXT is checked as well as the effective directory, because
    // `cd <primary> && git checkout …` moves the tree without ever changing the
    // cwd the hook is told about.
    // `allowRoot` because this asks about a DIRECTORY: the case to catch is a
    // command run in the primary root itself, and a worktree root must count as
    // inside its own worktree or the subtraction never fires.
    if (!landsInPrimary(effectiveGitDir(command, cwd), primary, roots, { allowRoot: true })
        && !command.includes(primary)) return;
    return deny('Refused: this command moves the working tree of the PRIMARY checkout '
      + `(${primary}), which is the running install — launchd serves public/ off it, so a branch `
      + 'switch there changes what the operator\'s browser is served, and it moves HEAD under the '
      + `running server. This session is rooted in the worktree ${realOrSelf(sessionRoot)}; run it `
      + 'there instead.' + overrideHint(primary));
  }

  const raw = ti.file_path || ti.notebook_path;
  if (!raw || typeof raw !== 'string') return;
  const realTarget = realOrSelf(path.resolve(cwd, raw));
  if (!landsInPrimary(realTarget, primary, roots)) return;

  if (isLiveSurface(realTarget, primary)) {
    return deny(`Refused: ${realTarget} is served LIVE off the primary checkout — launchd serves `
      + 'public/ straight off this working tree, so this write reaches the operator\'s browser the '
      + 'instant it hits disk, on an unmerged branch and with no restart. Bumping CACHE_NAME in '
      + 'public/sw.js this way locked the operator out of Chrome once (#710). Make this change in a '
      + 'worktree unless you intend it to be live right now.' + overrideHint(primary));
  }

  if (sessionIsWorktree && isTracked(primary, realTarget)) {
    return deny(`Refused: ${realTarget} is a tracked file in the PRIMARY checkout, but this session `
      + `is rooted in the worktree ${realOrSelf(sessionRoot)} — so this write almost certainly `
      + 'inherited the primary as its cwd rather than meaning to land there. Dispatched subagents '
      + 'and scripts default to the session\'s launch directory, which stays the primary even after '
      + 'the session enters a worktree. Write to the worktree\'s copy instead.'
      + overrideHint(primary));
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => failOpen('could not read the tool input'));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    return failOpen('could not parse the tool input');
  }
  try {
    evaluate(input);
  } catch (err) { // prawduct:allow prawduct/broad-except -- a guard that throws is fed back as a synthetic user message and loops the session on an unreachable machine; every failure must land on exit 0. The error is reported on stderr, never swallowed.
    return failOpen(`internal error: ${err && err.message}`);
  }
});
