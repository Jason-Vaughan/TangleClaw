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
 *   node scripts/install-primary-guard.js              wire it (idempotent)
 *   node scripts/install-primary-guard.js --check      report what is wired; exit 1 if not
 *   node scripts/install-primary-guard.js --self-test  drive the WIRED command; exit 1 if it
 *                                                      does not refuse
 *   node scripts/install-primary-guard.js --remove     unwire it
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { locateCheckouts } = require('../lib/checkout-layout');

/** Tool matcher for the file-writing arm. */
const WRITE_MATCHER = 'Edit|Write|NotebookEdit|MultiEdit';

/** The guard's sentinel override, named here only so `--self-test` can explain a miss. */
const OVERRIDE_FILE = path.join('.prawduct', '.allow-primary-write');

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
 * Two rather than one, and NOT for a cost reason — a single combined
 * `Edit|Write|NotebookEdit|MultiEdit|Bash` matcher invokes the guard on exactly
 * the same set of tool calls. The split is legibility: the two arms answer
 * different questions from different input (a `file_path` versus a `command`),
 * they are refused for different reasons, and either can be unwired on its own
 * while debugging without silencing the other.
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
 * A `PreToolUse` that is present but not an array is REFUSED rather than
 * replaced. `_mergeBaselineHooks` preserves shapes it does not model verbatim,
 * on the reasoning that dropping something an operator or a future Claude Code
 * version wrote is worse than not merging — and an installer that quietly
 * discarded it while that reconciler preserved it would make the two disagree
 * about the same file.
 *
 * @param {object} settings - Current settings.
 * @param {string} primary - Absolute primary checkout root.
 * @param {'install'|'remove'} action - What to do.
 * @returns {{settings:object, wiredBefore:boolean, changed:boolean}}
 * @throws {Error} When `hooks.PreToolUse` exists in a shape this cannot model.
 */
function apply(settings, primary, action) {
  const next = { ...settings };
  const hooks = { ...(next.hooks || {}) };
  if ('PreToolUse' in hooks && !Array.isArray(hooks.PreToolUse)) {
    throw new Error('hooks.PreToolUse is not an array — refusing to overwrite it; '
      + 'fix or remove it by hand first');
  }
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
 * The command string actually present in the settings file, if any.
 *
 * `--check` used to print the command it WOULD write, which answers a different
 * question from the one asked: an entry pinned at a stale absolute path matches
 * `isGuardEntry` on the basename, so it reads as wired, and the wired command
 * ends in `|| true`, so it fails silently. The readback has to report what is
 * there.
 *
 * @param {object} settings - Parsed settings.
 * @returns {string|null} The wired command, or null when none is.
 */
function wiredCommand(settings) {
  const entries = (settings && settings.hooks && settings.hooks.PreToolUse) || [];
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!isGuardEntry(entry)) continue;
    const hook = entry.hooks.find((h) => h && typeof h.command === 'string'
      && h.command.includes(path.basename(GUARD_REL)));
    if (hook) return hook.command;
  }
  return null;
}

/**
 * The script path a wired command points at.
 *
 * @param {string} command - A wired hook command.
 * @returns {string|null} The path it invokes, or null when it cannot be read.
 */
function pinnedScript(command) {
  const m = /"([^"]+)"|(\S*guard-primary-checkout\.js)/.exec(command);
  return m ? (m[1] || m[2]) : null;
}

/**
 * Drive the WIRED command with a synthetic refusal case and check a deny comes
 * back.
 *
 * `--check` proves the entry is listed and the pinned script exists. It cannot
 * prove the wired command still produces a decision — and this repo has already
 * shipped the mirror-image bug (#755: a posture readback keyed on the guard
 * SCRIPT, so removing the hook's REGISTRATION reported healthy). A readback that
 * exercises the path answers the question the operator is actually asking.
 *
 * The probe names `server.js` in the primary, which P2 refuses from any session
 * root, so it needs no worktree and mutates nothing.
 *
 * @param {string} command - The wired command string.
 * @param {string} primary - Absolute primary checkout root.
 * @returns {{ok:boolean, detail:string}}
 */
function selfTest(command, primary) {
  const payload = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: path.join(primary, 'server.js') },
    cwd: primary
  });
  let stdout;
  try {
    stdout = execFileSync('/bin/sh', ['-c', command], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: primary, TANGLECLAW_ALLOW_PRIMARY_WRITE: '' }
    });
  } catch (err) {
    return { ok: false, detail: `the wired command failed to run: ${err.message}` };
  }
  if (!stdout.trim()) {
    return { ok: false, detail: 'the wired command produced NO decision for a write to '
      + `${path.join(primary, 'server.js')} — it should have refused. A sentinel at `
      + `${path.join(primary, OVERRIDE_FILE)} would also explain this.` };
  }
  try {
    const parsed = JSON.parse(stdout);
    const d = parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision;
    if (d !== 'deny') return { ok: false, detail: `decision was ${JSON.stringify(d)}, not "deny"` };
  } catch (err) {
    return { ok: false, detail: `the wired command emitted unparseable output: ${stdout.slice(0, 200)}` };
  }
  return { ok: true, detail: 'the wired command refused a write to the live surface' };
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

  if (argv.includes('--check') || argv.includes('--self-test')) {
    const command = wiredCommand(current);
    if (!command) {
      process.stdout.write('NOT wired — run: node scripts/install-primary-guard.js\n');
      return 1;
    }
    // Report what is THERE, not what would be written.
    process.stdout.write(`wired: ${command}\n`);
    const pinned = pinnedScript(command);
    if (!pinned || !fs.existsSync(pinned)) {
      process.stdout.write(`STALE: it invokes ${pinned || '(unreadable)'}, which does not exist — `
        + 'the command ends in `|| true`, so this fails silently. Re-run the installer.\n');
      return 1;
    }
    if (!argv.includes('--self-test')) return 0;
    const probe = selfTest(command, primary);
    process.stdout.write(`self-test: ${probe.ok ? 'PASS' : 'FAIL'} — ${probe.detail}\n`);
    return probe.ok ? 0 : 1;
  }

  const result = apply(current, primary, action);

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

module.exports = {
  main, apply, isGuardEntry, guardCommand, guardEntries, wiredCommand, pinnedScript, selfTest,
  readSettings, writeSettings, GUARD_REL, WRITE_MATCHER
};
