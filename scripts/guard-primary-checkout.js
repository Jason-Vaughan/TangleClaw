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
const os = require('node:os');
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
 * Emit the documented PreToolUse refusal.
 *
 * Deliberately does NOT call `process.exit`. Writes to a pipe are asynchronous,
 * and `process.exit` discards whatever has not flushed — so a guard that exits
 * immediately after writing can emit a TRUNCATED decision, which parses as
 * nothing and silently permits the write it just refused. Every caller returns
 * this value, so evaluation stops anyway and the process ends on its own with
 * status 0 once the payload is out.
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
}

/**
 * Exit without a decision, leaving the normal permission flow untouched.
 *
 * The note goes to stderr, which the harness does not feed back on exit 0 — so
 * it is visible under `--debug` and inert otherwise. That asymmetry is the
 * point: a guard that cannot establish its own preconditions must stay
 * diagnosable without being able to interrupt anyone.
 *
 * Like `deny`, it does not call `process.exit` — the process ends on its own with
 * status 0, which is what "no decision" means to the harness.
 *
 * @param {string|null} note - Why no decision was reached; null when the
 *   fall-through is a normal outcome rather than a failure.
 * @returns {void}
 */
function failOpen(note) {
  if (note) process.stderr.write(`guard-primary-checkout: ${note}\n`);
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
 * This is the one place the guard spawns a subprocess, and it is not in tension
 * with `checkout-layout.js`'s no-spawn rule: that rule governs the questions
 * asked on EVERY matched call, while this one is reached only after those have
 * already established that the write lands in the primary and is not the live
 * surface. There is also no on-disk index this module could read as cheaply or
 * as correctly.
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
 * Names WHICH route stood down rather than answering a bare boolean. The one
 * path that disarms the guard was the one path that said nothing: a forgotten
 * sentinel produced output byte-identical to "no rule matched", so whoever asked
 * why a write reached the primary could not tell disarmed from not-applicable,
 * and would reach "the guard is broken" first. The design calls both routes "a
 * deliberate act that leaves a trace"; this is the trace.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {string|null} How the guard was waived, or null when it was not.
 */
function overriddenBy(primary) {
  const v = process.env[OVERRIDE_ENV];
  if (typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false') {
    return `${OVERRIDE_ENV} is set`;
  }
  const sentinel = path.join(primary, OVERRIDE_FILE);
  try {
    fs.statSync(sentinel);
    return `the sentinel ${sentinel} exists — delete it to re-arm the guard`;
  } catch (err) {
    return null;
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

/** Git's own global options that consume the token after them. */
const GIT_OPTS_WITH_VALUE = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'];

/**
 * Split a shell fragment into tokens, honouring quotes.
 *
 * Quoting is what separates a subcommand from a commit message: `git commit -m
 * "fix the checkout path"` must yield `commit`, not a stray `checkout`.
 *
 * @param {string} s - One command segment.
 * @returns {string[]} Tokens, unquoted.
 */
function tokenize(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m = re.exec(s);
  while (m) {
    out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
    m = re.exec(s);
  }
  return out;
}

/**
 * Resolve a path as the shell would, expanding a leading `~`.
 *
 * `cd ~/Documents/Projects/TangleClaw` is the form an operator actually types,
 * and it names the primary without ever containing the primary's resolved path.
 *
 * @param {string} p - Path as written in the command.
 * @param {string} base - Directory it is relative to.
 * @returns {string} Absolute path, not yet symlink-resolved.
 */
function resolveShellPath(p, base) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(base, p);
}

/**
 * Every directory this command would move a working tree in.
 *
 * Walks the command's segments in order, tracking the directory a `cd` moves to,
 * and recognises a moving verb ONLY in git's subcommand position — the first
 * non-option token after a `git` token. Both are load-bearing:
 *
 *   - Matching the verb anywhere in the string made `git commit -m "fix the
 *     checkout path"` read as a working-tree move, and "never refuses a commit"
 *     is a promise this guard makes in its own refusal text.
 *   - Answering "does it touch the primary" by substring-matching the command
 *     against the primary path was wrong in BOTH directions, which is what
 *     replaced it: every worktree root is lexically prefixed by the primary
 *     (`<primary>/.claude/worktrees/<name>`), so `git -C <abs worktree> checkout`
 *     was refused with a message telling the actor to go where it already was —
 *     and `cd ~/…/TangleClaw && git checkout main` contains no resolved primary
 *     path, so the case the scan existed for walked past it. Returning
 *     DIRECTORIES lets the caller ask `landsInPrimary`, which subtracts the
 *     worktree roots, exactly as the file-write arm does.
 *
 * Bound worth knowing: a segment split inside a quoted string containing `|` or
 * `;` yields odd segments. It cannot invent a git subcommand, so it can only
 * fail toward permitting — the direction this guard is allowed to fail in.
 *
 * @param {string} command - The Bash tool's command string.
 * @param {string} cwd - The tool's working directory.
 * @returns {string[]} Absolute, symlink-resolved directories.
 */
function movingGitTargets(command, cwd) {
  const targets = [];
  let dir = cwd;
  for (const segment of command.split(/&&|\|\||[;|]/)) {
    const toks = tokenize(segment);
    let i = 0;
    while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || toks[i] === 'sudo')) i += 1;
    if (i >= toks.length) continue;
    if (toks[i] === 'cd') {
      if (toks[i + 1]) dir = resolveShellPath(toks[i + 1], dir);
      continue;
    }
    // Exactly `git`, or a path ending in `/git` — so `/usr/bin/git` counts and
    // `mygit` does not.
    if (!/(^|\/)git$/.test(toks[i])) continue;
    i += 1;
    let at = dir;
    while (i < toks.length && toks[i].startsWith('-')) {
      if (toks[i] === '-C') {
        if (toks[i + 1]) at = resolveShellPath(toks[i + 1], dir);
        i += 2;
      } else if (GIT_OPTS_WITH_VALUE.includes(toks[i])) {
        i += 2;
      } else {
        i += 1;
      }
    }
    if (i < toks.length && HEAD_MOVING_VERBS.includes(toks[i])) targets.push(realOrSelf(at));
  }
  return targets;
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

  // This guard's rules are about ONE repository — the one whose primary checkout
  // is being served. The wiring is machine-local, so nothing structurally stops
  // it being invoked for a session in some other project, and there it would
  // apply this repo's `public/**` policy to a tree nobody serves. Scoped by
  // asking the same question of the guard's own location: a different family is
  // not this guard's business.
  const own = locateCheckouts(REPO_ROOT);
  if (!own) return failOpen(`could not establish this guard's own checkout at ${REPO_ROOT}`);
  if (own.primary !== primary) {
    return failOpen(`session at ${sessionRoot} belongs to ${primary}, not ${own.primary}`);
  }

  const waived = overriddenBy(primary);
  if (waived) return failOpen(`standing down: ${waived}`);

  const ti = (input && input.tool_input) || {};
  const cwd = realOrSelf(input.cwd || sessionRoot);
  const { roots, unreadable, failed } = linkedWorktreeRoots(primary);
  if (failed) {
    // The subtraction list is UNKNOWN, not empty. Treating it as empty makes
    // every path inside every nested worktree read as the primary, so the guard
    // would refuse all of them — fail-closed, in a guard whose whole posture is
    // fail-open.
    return failOpen(`could not read the worktree records under ${primary} (${failed})`);
  }
  if (unreadable.length) {
    process.stderr.write(
      `guard-primary-checkout: unreadable worktree records: ${unreadable.join(', ')}\n`);
  }

  if (input.tool_name === 'Bash') {
    // P1 only. `git checkout main` in the primary is the documented fast
    // rollback from a bad branch, so a primary-rooted session must keep it.
    if (!sessionIsWorktree) return;
    const command = typeof ti.command === 'string' ? ti.command : '';
    // `allowRoot` because this asks about a DIRECTORY: the case to catch is a
    // command run in the primary root itself, and a worktree root must count as
    // inside its own worktree or the subtraction never fires.
    if (!movingGitTargets(command, cwd)
      .some((t) => landsInPrimary(t, primary, roots, { allowRoot: true }))) return;
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
