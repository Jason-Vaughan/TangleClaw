#!/usr/bin/env node
'use strict';
/**
 * Wire (or unwire, or report on) the primary-checkout PreToolUse guard (#798).
 *
 * The guard SCRIPT is tracked and reviewable; its WIRING is machine-local, and
 * the split is deliberate:
 *
 *   - The tracked `.claude/settings.json` carries no `hooks` block by contract
 *     (#1022/#1275, asserted by `test/repo-governance-reference.test.js`) —
 *     TangleClaw's own sync writes absolute-path hooks, and a committed hooks
 *     block is what stranded a wrap PR with auto-merge armed.
 *   - "This checkout is the running install" is a fact about THIS MACHINE, not
 *     about the repository. A committed guard would refuse `public/**` edits in
 *     a contributor's clone, where nothing is being served at all.
 *
 * So the entry goes into the gitignored `.claude/settings.local.json`, where
 * TangleClaw already writes its own hooks and where `_mergeBaselineHooks`
 * preserves every foreign entry verbatim across the per-launch reconciliation.
 *
 * The command is pinned to the PRIMARY checkout's absolute copy of the guard
 * rather than to `$CLAUDE_PROJECT_DIR`. A session launched in a worktree whose
 * branch predates this feature would otherwise invoke a script that does not
 * exist — and a failing hook is fed back as a synthetic user message, which is
 * the loop this guard must never start. Absolute paths are correct here for the
 * same reason they are wrong in the tracked file: this file never leaves the
 * machine.
 *
 * Usage:
 *   node scripts/install-primary-guard.js            wire it (idempotent)
 *   node scripts/install-primary-guard.js --check    report only; exit 1 if unwired
 *   node scripts/install-primary-guard.js --remove   unwire it
 */

const fs = require('node:fs');
const path = require('node:path');

const { locateCheckouts } = require('../lib/checkout-layout');

/** Tool matcher for the file-writing arm. */
const WRITE_MATCHER = 'Edit|Write|NotebookEdit|MultiEdit';

/**
 * Repo-relative location of the guard script.
 *
 * `scripts/`, not `.claude/hooks/`: `.claude/*` is gitignored fail-closed with a
 * single deliberate exception, and the guard must be tracked and reviewable.
 * Nothing depends on the location — the wiring names an absolute path.
 */
const GUARD_REL = path.join('scripts', 'guard-primary-checkout.js');

/**
 * The shell command that invokes the guard.
 *
 * `|| true` is load-bearing, not defensive habit: it guarantees exit 0 whatever
 * happens — a missing node, a syntax error, a deleted script — so the guard can
 * never be the thing that starts the hook-failure loop it exists downstream of.
 * A genuine refusal still works, because a refusal is JSON on stdout with exit
 * 0, which `|| true` never reaches.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {string} Shell command for a `hooks[].command` field.
 */
function guardCommand(primary) {
  return `node "${path.join(primary, GUARD_REL)}" || true`;
}

/**
 * Is a hooks entry this guard's?
 *
 * Matched on the script's BASENAME rather than the whole command string, so a
 * reworked invocation prefix does not read as "not installed" and produce a
 * duplicate entry on the next run. Same reasoning as `_masterGuardIsWired` in
 * `lib/master.js`.
 *
 * @param {*} entry - One element of a `hooks.PreToolUse` array.
 * @returns {boolean} True when the entry invokes this guard.
 */
function isGuardEntry(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  const needle = path.basename(GUARD_REL);
  return entry.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(needle));
}

/**
 * The two entries the guard needs.
 *
 * Two rather than one because the matchers are different questions: file writes
 * carry a `file_path`, Bash carries a `command`, and a single combined matcher
 * would run the guard on every Bash call in a primary-rooted session for
 * nothing.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {object[]} PreToolUse entries.
 */
function guardEntries(primary) {
  const command = guardCommand(primary);
  return [
    { matcher: WRITE_MATCHER, hooks: [{ type: 'command', command }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command }] }
  ];
}

/**
 * Read the machine-local settings file, tolerating its absence.
 *
 * An UNPARSEABLE file throws rather than being replaced: silently overwriting
 * the operator's own permissions block to install a guard would be a worse
 * outcome than not installing it. Same posture as `writeEngineConfig`, which
 * refuses to clobber a malformed settings.json.
 *
 * @param {string} file - Absolute path to `settings.local.json`.
 * @returns {object} Parsed settings, or an empty object when absent.
 */
function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (raw.trim() === '') return {};
  return JSON.parse(raw);
}

/**
 * Write settings atomically, in the repo's committed style.
 *
 * tmp-file plus rename, so a crash mid-write cannot leave a truncated settings
 * file — which would read as unparseable and, per `readSettings`, block the next
 * run entirely.
 *
 * @param {string} file - Absolute path to `settings.local.json`.
 * @param {object} settings - Settings to serialize.
 * @returns {void}
 */
function writeSettings(file, settings) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Apply the requested action to a settings object.
 *
 * Returns the new settings and what changed, rather than writing — so the
 * decision is testable without a filesystem, and `--check` and the install path
 * ask the same question of the same code.
 *
 * @param {object} settings - Current settings.
 * @param {string} primary - Absolute primary checkout root.
 * @param {'install'|'remove'} action - What to do.
 * @returns {{settings:object, wiredBefore:boolean, changed:boolean}}
 */
function apply(settings, primary, action) {
  const next = { ...settings };
  const hooks = { ...(next.hooks || {}) };
  const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const foreign = existing.filter((e) => !isGuardEntry(e));
  const wiredBefore = foreign.length !== existing.length;

  const desired = action === 'remove' ? foreign : foreign.concat(guardEntries(primary));
  if (desired.length > 0) hooks.PreToolUse = desired;
  else delete hooks.PreToolUse;

  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;

  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  return { settings: next, wiredBefore, changed };
}

/**
 * Entry point.
 *
 * @param {string[]} argv - Process arguments after the script name.
 * @returns {number} Process exit code.
 */
function main(argv) {
  const located = locateCheckouts(path.join(__dirname, '..'));
  if (!located) {
    process.stderr.write('install-primary-guard: could not locate the primary checkout\n');
    return 1;
  }
  const primary = located.primary;
  const guardPath = path.join(primary, GUARD_REL);
  if (!fs.existsSync(guardPath)) {
    process.stderr.write(`install-primary-guard: guard script missing at ${guardPath} — wiring a `
      + 'hook to a script that does not exist is exactly the failure this guard must not cause\n');
    return 1;
  }

  const file = path.join(primary, '.claude', 'settings.local.json');
  const current = readSettings(file);
  const action = argv.includes('--remove') ? 'remove' : 'install';
  const result = apply(current, primary, action);

  if (argv.includes('--check')) {
    process.stdout.write(result.wiredBefore
      ? `wired: ${guardCommand(primary)}\n`
      : `NOT wired — run: node scripts/install-primary-guard.js\n`);
    return result.wiredBefore ? 0 : 1;
  }

  if (!result.changed) {
    process.stdout.write(`already ${action === 'remove' ? 'absent' : 'wired'}: ${file}\n`);
    return 0;
  }
  writeSettings(file, result.settings);
  process.stdout.write(`${action === 'remove' ? 'removed from' : 'wired into'} ${file}\n`);
  if (action === 'install') {
    process.stdout.write('Takes effect for sessions started after this point.\n');
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { apply, isGuardEntry, guardCommand, guardEntries, GUARD_REL, WRITE_MATCHER };
