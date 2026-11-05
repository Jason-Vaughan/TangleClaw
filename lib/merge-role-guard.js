'use strict';

/**
 * Cross-engine Builder `gh pr merge` role guard (#2601, Architect Ruling
 * A2601, `v5.61.0` Car 61-A Slice 1).
 *
 * `gh pr merge` talks directly to the GitHub API and triggers no local git
 * `pre-push` hook (`lib/control-hooks.js:12-13`), and a tracked
 * `.claude/settings.json` hook is engine-specific and shared across every
 * clone -- neither stops a Builder/Reviewer/Architect/Coordinator lane from
 * merging its own PR, which Rule #282 reserves for the Integrator alone.
 *
 * A pure classifier/evaluator: {@link detectMergeInvocation} and
 * {@link evaluateMergeRoleGuard} take a candidate shell command string and
 * the caller's own already-resolved role/lane identity as plain data, and
 * return a computed verdict -- nothing here reads `TANGLECLAW_ROLE` from the
 * environment, intercepts a real shell command, or writes a launch-env `PATH`
 * wrapper or hook file. Wiring this into an actual pre-execution guard (a
 * launch-env wrapper, a `tc` verb, an engine shell hook) is Slice 2,
 * deliberately deferred so Car 61-A stays 100% file-disjoint from this
 * wave's other `v5.61.0` cars.
 *
 * @module lib/merge-role-guard
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** Role categories this module recognizes, resolved from either an explicit `role` or a lane id. */
const ROLE_CATEGORIES = Object.freeze(['builder', 'reviewer', 'architect', 'pm', 'integrator']);

/** The role categories Rule #282 forbids from merging a PR. */
const FORBIDDEN_ROLE_CATEGORIES = Object.freeze(['builder', 'reviewer', 'architect', 'pm']);

/** The only merge method `gh pr merge`/the REST merge endpoint may use (Rule #282: a true merge commit, never squash or rebase). */
const ALLOWED_MERGE_METHOD = 'merge';

/** Every merge method this module recognizes in a candidate command. */
const MERGE_METHODS = Object.freeze(['merge', 'squash', 'rebase']);

/**
 * `gh pr merge`'s own documented short aliases for each method
 * (`gh pr merge --help`: `-m`/`--merge`, `-s`/`--squash`, `-r`/`--rebase`) --
 * checked in addition to the long form, never instead of it (PRR-B I-Gate
 * Round 1 #1 on PR #2865: `gh pr merge 123 -s` bypassed `MERGE_METHOD_FORBIDDEN`
 * entirely, since only `--squash`/`--rebase` were recognized).
 * @type {Readonly<Record<string, string>>}
 */
const SHORT_METHOD_FLAGS = Object.freeze({ m: 'merge', s: 'squash', r: 'rebase' });

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * Resolve a caller's own role/lane identity into one of {@link ROLE_CATEGORIES},
 * or `'operator'` for an explicit operator context -- `null` when neither an
 * explicit `role` nor a recognized lane id is given. An explicit `role` is
 * trusted outright when it names a known category; a lane id is pattern-
 * matched only when `role` is absent, never used to override an explicit role.
 * @param {{role?: string, lane?: string, isOperator?: boolean}} input
 * @returns {string|null}
 */
function _resolveRoleCategory(input) {
  if (input.isOperator === true) return 'operator';
  if (typeof input.role === 'string' && ROLE_CATEGORIES.includes(input.role)) return input.role;
  if (typeof input.lane === 'string' && input.lane) {
    if (/^TC-Lane-INT$/i.test(input.lane)) return 'integrator';
    if (/^TC-Lane-PRR(-[A-Za-z0-9]+)?$/i.test(input.lane)) return 'reviewer';
    if (/^TC-Lane-Arc$/i.test(input.lane)) return 'architect';
    if (/^TC-Lane-PM$/i.test(input.lane)) return 'pm';
    if (/^TC-Lane-[A-Za-z]$/i.test(input.lane)) return 'builder';
  }
  return null;
}

/**
 * Whether a candidate shell command invokes a PR merge, and which merge
 * method it names, if any (#2601). Recognizes `gh pr merge`, `gh api ...
 * /pulls/<n>/merge` and a raw `curl -X PUT .../pulls/<n>/merge` -- the three
 * shapes the ruling names ("across engine shell/command hooks and
 * wrappers"). A command with none of these patterns is not a merge
 * invocation at all; this function never raises on one, since most commands
 * a shell hook sees are not a merge attempt.
 * @param {string} commandText
 * @returns {{isMergeInvocation: boolean, mergeMethod: (string|null), via: (string|null)}}
 */
function detectMergeInvocation(commandText) {
  if (typeof commandText !== 'string' || !commandText) {
    return { isMergeInvocation: false, mergeMethod: null, via: null };
  }
  const isGhPrMerge = /\bgh\s+pr\s+merge\b/.test(commandText);
  const mergeEndpointRe = /\/pulls\/[^/\s"']+\/merge\b/;
  const isGhApiMerge = !isGhPrMerge && /\bgh\s+api\b/.test(commandText) && mergeEndpointRe.test(commandText);
  const isRestPutMerge = !isGhPrMerge && !isGhApiMerge && /-X\s*PUT\b/i.test(commandText) && mergeEndpointRe.test(commandText);
  const isMergeInvocation = isGhPrMerge || isGhApiMerge || isRestPutMerge;

  let mergeMethod = null;
  for (const method of MERGE_METHODS) {
    if (new RegExp(`--${method}\\b`).test(commandText) || new RegExp(`merge_method["']?[=:\\s]+["']?${method}`, 'i').test(commandText)) {
      mergeMethod = method;
      break;
    }
  }
  if (!mergeMethod) {
    for (const [flag, method] of Object.entries(SHORT_METHOD_FLAGS)) {
      if (new RegExp(`(?:^|\\s)-${flag}(?:\\s|$)`).test(commandText)) {
        mergeMethod = method;
        break;
      }
    }
  }

  return { isMergeInvocation, mergeMethod, via: isGhPrMerge ? 'gh-pr-merge' : (isGhApiMerge ? 'gh-api' : (isRestPutMerge ? 'rest-put' : null)) };
}

/**
 * Evaluate whether a candidate command's PR-merge attempt (if it is one)
 * may proceed, for a given caller identity (#2601). A command that is not a
 * merge invocation at all always proceeds -- this guard has nothing to say
 * about any other command. Role is checked before merge method: a forbidden
 * caller using `--squash` gets `MERGE_ROLE_FORBIDDEN`, the more fundamental
 * violation, not `MERGE_METHOD_FORBIDDEN`.
 * @param {object} input
 * @param {string} input.commandText - The candidate shell command
 * @param {string} [input.role] - One of {@link ROLE_CATEGORIES}
 * @param {string} [input.lane] - A lane id (`TC-Lane-A`..`TC-Lane-D`, `TC-Lane-INT`,
 *   `TC-Lane-PRR-A`/`-B`, `TC-Lane-Arc`, `TC-Lane-PM`), used only when `role` is absent
 * @param {boolean} [input.isOperator] - An explicit operator context; overrides role/lane
 * @returns {{ok: true, result: {allowed: true, reason: string}}|{ok: false, code: string, message: string}}
 */
function evaluateMergeRoleGuard(input) {
  if (!input || typeof input !== 'object' || typeof input.commandText !== 'string') {
    return _refuse('MERGE_ROLE_GUARD_INVALID', 'input.commandText must be a string.');
  }
  if (input.role !== undefined && typeof input.role !== 'string') {
    return _refuse('MERGE_ROLE_GUARD_INVALID', 'input.role must be a string when present.');
  }
  if (input.lane !== undefined && typeof input.lane !== 'string') {
    return _refuse('MERGE_ROLE_GUARD_INVALID', 'input.lane must be a string when present.');
  }

  const detected = detectMergeInvocation(input.commandText);
  if (!detected.isMergeInvocation) {
    return { ok: true, result: { allowed: true, reason: 'not a PR-merge invocation' } };
  }

  const category = _resolveRoleCategory(input);
  if (category !== 'operator' && category !== 'integrator') {
    return _refuse('MERGE_ROLE_FORBIDDEN',
      'Only the Integrator or an explicit operator may merge a PR (Rule #282); '
      + `this caller's role/lane (${input.role || input.lane || 'unrecognized'}) is not authorized.`);
  }
  if (detected.mergeMethod && detected.mergeMethod !== ALLOWED_MERGE_METHOD) {
    return _refuse('MERGE_METHOD_FORBIDDEN',
      `--${detected.mergeMethod} is forbidden; every PR merges via a true merge commit (--merge) under Rule #282, never squash or rebase.`);
  }

  return { ok: true, result: { allowed: true, reason: category === 'operator' ? 'explicit operator context' : 'authorized Integrator' } };
}

/**
 * The `gh` wrapper script {@link createRoleGuardWrapperScripts} writes.
 * Plain text so the module stays easy to read and diff; `${GUARD_MODULE}`
 * is substituted with this file's own absolute path at write time, so the
 * generated script always requires the exact code that wrote it, never a
 * guessed relative path.
 * @type {string}
 */
const GH_WRAPPER_TEMPLATE = `#!/usr/bin/env node
'use strict';
// Generated by lib/merge-role-guard.js#createRoleGuardWrapperScripts (#2866,
// #2601 Slice 2). Do not edit by hand -- recreated on every session launch.
//
// SAFETY NET, independent of the realpath-based PATH filtering below: this
// process marks itself with an env var before doing anything else, and
// refuses outright if that mark is already set on entry. A fork-bomb from
// this exact wrapper re-finding itself is not a hypothetical -- the
// unguarded version did it for real the first time it was tested (see the
// comment further down). This guard is deliberately independent of that
// fix so a second bug in the PATH-filtering logic alone cannot reproduce it.
if (process.env.TC_GH_WRAPPER_ACTIVE === '1') {
  process.stderr.write('gh: wrapper re-entered itself; refusing rather than recursing.\\n');
  process.exit(1);
}
process.env.TC_GH_WRAPPER_ACTIVE = '1';

const { execFileSync, execSync } = require('node:child_process');
const guard = require(${JSON.stringify('${GUARD_MODULE}')});

const args = process.argv.slice(2);
const commandText = \`gh \${args.join(' ')}\`;
// Deliberately left unassigned (undefined), never null: evaluateMergeRoleGuard
// validates lane as "undefined, or a string" -- null fails that check with
// MERGE_ROLE_GUARD_INVALID instead of being read as "no lane known", which
// would have reported the wrong refusal code for the exact case (no tmux
// session resolvable) this guard most needs to fail closed on correctly.
let lane;
if (process.env.TMUX) {
  try {
    lane = execSync('tmux display-message -p "#S"', { encoding: 'utf8' }).trim() || undefined;
  } catch {
    // Not inside a named tmux session (or tmux unavailable) -- lane stays
    // null, which evaluateMergeRoleGuard already fails closed on.
  }
}
const verdict = guard.evaluateMergeRoleGuard({ commandText, lane });
if (verdict.ok === false) {
  guard.recordBlockedAttempt(undefined, { commandText, lane, code: verdict.code, message: verdict.message });
  process.stderr.write(\`gh: refused [\${verdict.code}] -- \${verdict.message}\\n\`);
  process.exit(1);
}
// Resolve the REAL gh: this wrapper's own directory stripped from PATH, so
// the lookup below cannot loop back to this file. Compared by REALPATH, not
// the literal string -- on macOS __dirname resolves through /private (a
// /var -> /private/var symlink), so a bare string-equality filter against
// the literal PATH entry never matches and the lookup below finds THIS
// script again, forever. Verified empirically: the unguarded version
// fork-bombed the host in seconds the first time this was tested for real.
const { realpathSync } = require('node:fs');
let selfDirReal;
try { selfDirReal = realpathSync(__dirname); } catch { selfDirReal = __dirname; }
const realPath = (process.env.PATH || '').split(':').filter((p) => {
  if (!p) return false;
  let real;
  try { real = realpathSync(p); } catch { real = p; }
  return real !== selfDirReal;
}).join(':');
try {
  execFileSync('gh', args, { stdio: 'inherit', env: { ...process.env, PATH: realPath } });
} catch (err) {
  process.exit(typeof err.status === 'number' ? err.status : 1);
}
`;

/**
 * Write the `gh` PATH-wrapper script into `dir` (#2866, #2601 Slice 2) --
 * the launch-env wrapper this module's own docstring named as the real
 * interception point, since `lib/control-hooks.js`'s git hooks never see a
 * `gh pr merge` call at all. Idempotent and side-effect-free beyond the one
 * file: safe to call on every session launch, which is exactly how
 * `lib/sessions.js#_paneEnvironment` uses it -- recreating the script each
 * time means an upgrade of this module reaches every pane on its next
 * launch, with nothing to migrate.
 *
 * Deliberately NOT a static file committed to `bin/` (the originally
 * discussed shape): `bin/tc` is this car's only authorized `bin/` file
 * (Ruling A504-W1A-R2's envelope), and `lib/sessions.js#_paneEnvironment`
 * already prepends this repo's own `bin/` to every session's `PATH` --
 * writing a second, dynamically-generated wrapper directory and prepending
 * THAT achieves the same interception without adding an unauthorized file.
 * @param {string} dir - Directory to write into; created if missing.
 * @returns {{dir: string, file: string}}
 */
function createRoleGuardWrapperScripts(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'gh');
  const content = GH_WRAPPER_TEMPLATE.replace('${GUARD_MODULE}', __filename);
  fs.writeFileSync(file, content, { mode: 0o755 });
  return { dir, file };
}

/** Where {@link recordBlockedAttempt} appends when the caller gives no explicit file (Slice 2, #2866). */
const DEFAULT_BLOCKED_ATTEMPT_LOG = path.join(os.homedir(), '.tangleclaw', 'logs', 'merge-role-guard-blocked.jsonl');

/**
 * Append one audit line for a command `evaluateMergeRoleGuard` refused —
 * the record a HOLD-style authority mechanism keeps of what it actually
 * stopped, not just that it can. Best-effort and never throws: an audit
 * trail write failing must never be the reason a refusal that already
 * happened looks like it didn't (the same posture `lib/decision-routing.js`'s
 * `_recordEvent` takes — "an event is a record of what already happened,
 * not a gate").
 * @param {string} [file] - Absolute path to append to; defaults to {@link DEFAULT_BLOCKED_ATTEMPT_LOG}.
 * @param {{commandText: string, lane: (string|null), role: (string|null), code: string, message: string, at?: string}} record
 * @returns {boolean} Whether the write succeeded.
 */
function recordBlockedAttempt(file, record) {
  const target = file || DEFAULT_BLOCKED_ATTEMPT_LOG;
  const r = record || {};
  const line = JSON.stringify({
    at: r.at || new Date().toISOString(),
    commandText: r.commandText || null,
    lane: r.lane || null,
    role: r.role || null,
    code: r.code || null,
    message: r.message || null
  });
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${line}\n`);
    return true;
  } catch {
    // prawduct:allow prawduct/broad-except -- an audit-log write is advisory;
    // the refusal it describes already happened and must stand regardless.
    return false;
  }
}

module.exports = {
  ROLE_CATEGORIES,
  FORBIDDEN_ROLE_CATEGORIES,
  ALLOWED_MERGE_METHOD,
  MERGE_METHODS,
  SHORT_METHOD_FLAGS,
  detectMergeInvocation,
  evaluateMergeRoleGuard,
  createRoleGuardWrapperScripts,
  recordBlockedAttempt
};
