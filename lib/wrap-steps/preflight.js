'use strict';

/**
 * `preflight` wrap step (#854) — ask prawduct for its session-end verdict
 * BEFORE the pipeline mutates anything.
 *
 * In a prawduct-onboarded project the plugin's Stop hook blocks the session
 * when governance is unmet (no Critic review, no reflection captured). It
 * fires on every turn end — including the turns the wrap pipeline itself
 * drives — so the block used to arrive partway down the pipeline, after
 * `changelog-update` and `version-bump` had already written to the tree,
 * leaving a half-applied wrap to reason about. The verdict is available
 * before the first step runs; this step asks for it.
 *
 * How: when `<project>/.prawduct/` exists, run `prawduct-hook stop` and read
 * its verdict — against the installed 3.4.0, `cmd_stop` prints its block text
 * to STDERR (not stdout, as the issue supposed) and exits 2 when a gate is
 * unmet, 0 when clear. A project without `.prawduct/` is skipped without
 * spawning anything: the hook would exit 0 for it, but a python process per
 * wrap in every non-prawduct project buys nothing.
 *
 * NOT a pure read, and the wording matters because the step's whole premise is
 * "ask before anything is touched". `cmd_stop` calls `gates.session_review_verdict`
 * with `record_grants=True`, which appends one base-advance transfer grant to
 * the project's prawduct evidence store the first time a given span is granted
 * (`gates.record_transfer_grant`; keyed on the span, so later observations
 * append nothing, and fail-soft, so a store failure cannot change the verdict).
 * What the step guarantees is the guarantee that was wanted: it touches nothing
 * in the WORKING TREE — no CHANGELOG, no version.json, no commit — so the wrap
 * is still all-or-nothing over the files it edits.
 *
 * Do NOT read that as "the same write the operator's own Stop would make
 * anyway". `closeStdin` hands the hook an empty payload, so its background-task
 * deferral cannot fire from here and this probe takes a different branch than
 * an interactive Stop would; and with a complete reviewer roster on disk
 * `cmd_stop` consolidates — writing findings, a ledger anchor, and clearing the
 * critic-active marker — possibly concurrently with the harness's own
 * SubagentStop. That is a real cost of the probe, accepted because prawduct
 * exposes no read-only form of the verdict, and it is the paragraph to re-read
 * before flipping `blocker` to `true` for a project. ADR 0011's 2026-09-03
 * amendment records it as a narrowing of the seam.
 *
 * ADVISORY BY DEFAULT (`blocker: false` in the shipped pipeline), for the
 * three reasons the issue argues: the reflection gate would deadlock against
 * the wrap (our own content steps produce the narrative it wants), the Critic
 * gate is minutes of agent time and belongs opt-in per project, and the
 * escape hatch means writing another framework's state. So an unmet gate is
 * reported as a `blocked` row with the block text and `output.warning`, the
 * pipeline continues, and the banner reads "completed with warnings". A
 * project that wants the door shut sets `wrapStepOverrides.preflight.blocker`
 * to `true` — the runner then halts here, ahead of `open-pr-check`, with the
 * tree untouched. The handler reads the resolved `step.blocker` so its
 * wording matches what actually happened.
 *
 * A probe that could not answer — hook not found, killed by the timeout, a
 * spawn error — is `skipped` with a reason that says the gates were NOT
 * measured. Never `done`: a step that reports clear gates it never checked
 * is the false-report class this drawer exists to end.
 *
 * Locating the hook: PATH first (the operator's shell puts the plugin's
 * `bin/` there), then `~/.claude/plugins/installed_plugins.json` — the
 * server runs under launchd with a PATH that rarely carries a plugin bin
 * directory, and the registry names the install path directly.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('../logger');
const { execFileArgs } = require('./_exec-shell');

const log = createLogger('wrap-step-preflight');

const HOOK_NAME = 'prawduct-hook';
// The hook's blocked exit code. Its contract is exactly two outcomes — 0 clear,
// 2 blocked — so any OTHER non-zero is the hook failing rather than a verdict.
const BLOCKED_EXIT_CODE = 2;
// The stop gate may probe PR state over the network (`gh`); a minute bounds a
// hung probe without cutting off a slow but honest one.
const EXEC_TIMEOUT_MS = 60 * 1000;
const MAX_BUFFER_BYTES = 1024 * 1024;
// The block text is rendered in a drawer row; a runaway hook must not paint a
// megabyte into it.
const BLOCK_TEXT_MAX_CHARS = 4000;

/**
 * Whether `file` is an existing executable regular file.
 * @param {string} file - Absolute path
 * @returns {boolean}
 */
function _isExecutableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { // prawduct:allow prawduct/broad-except -- ENOENT/EACCES/ENOTDIR all mean "not this one"; the locator moves on
    return false;
  }
}

/**
 * Whether `dir` is an existing directory.
 * @param {string} dir - Absolute path
 * @returns {boolean}
 */
function _isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch { // prawduct:allow prawduct/broad-except -- a missing or unreadable path is "no directory" for a presence check
    return false;
  }
}

/**
 * The `prawduct-hook` recorded in the machine's plugin registry, preferring a
 * user-scope install (it governs every project on the machine) over a
 * project-scope one. Null when the registry is absent, unreadable, or names
 * no executable hook — every failure is "not found", logged once, and the
 * step reports the skip.
 * @returns {string|null} Absolute path to the hook, or null
 */
function installedPluginBin() {
  try {
    const file = path.join(_internal.pluginsHome(), 'installed_plugins.json');
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const plugins = data && data.plugins;
    if (!plugins || typeof plugins !== 'object') return null;
    for (const [key, entries] of Object.entries(plugins)) {
      if (!key.startsWith('prawduct@') || !Array.isArray(entries)) continue;
      const ordered = [...entries].sort((a, b) => Number(b && b.scope === 'user') - Number(a && a.scope === 'user'));
      for (const entry of ordered) {
        if (!entry || typeof entry.installPath !== 'string') continue;
        const candidate = path.join(entry.installPath, 'bin', HOOK_NAME);
        if (_isExecutableFile(candidate)) return candidate;
      }
    }
    return null;
  } catch (err) { // prawduct:allow prawduct/broad-except -- an unreadable or malformed registry means the hook cannot be located this way; the reason is logged and the step reports the skip
    log.warn('installed_plugins.json unreadable — cannot locate prawduct-hook through it', { error: err.message });
    return null;
  }
}

/**
 * Find `prawduct-hook`: PATH, then the plugin registry.
 * @returns {{path: string, via: 'PATH'|'installed plugin'}|null}
 */
function locateHook() {
  for (const dir of _internal.pathDirs()) {
    if (!dir) continue;
    const candidate = path.join(dir, HOOK_NAME);
    if (_isExecutableFile(candidate)) return { path: candidate, via: 'PATH' };
  }
  const fromPlugin = _internal.installedPluginBin();
  if (fromPlugin) return { path: fromPlugin, via: 'installed plugin' };
  return null;
}

/**
 * Last `n` characters of a string, trimmed. Empty input → empty string.
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function _tailChars(s, n) {
  if (!s) return '';
  const text = String(s);
  return (text.length > n ? text.slice(-n) : text).trim();
}

/**
 * A `skipped` result whose reason says the gates were not measured — the
 * shape every "could not answer" path shares, so none of them can read as a
 * clean verdict.
 * @param {string} reason - Operator-readable reason
 * @param {object} [extra] - Merged into `output`
 * @returns {{ok: true, status: 'skipped', output: object, blockers: []}}
 */
function _skipped(reason, extra) {
  return { ok: true, status: 'skipped', output: { reason, measured: false, ...(extra || {}) }, blockers: [] };
}

/**
 * Step handler. See the module docstring for semantics.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (id, name, path)
 * @param {object} context.step - The resolved step spec (its `blocker` reflects
 *   the project's override, which decides the advisory wording)
 * @returns {Promise<{ok: boolean, status: string, output: object, blockers: string[]}>}
 */
async function run(context) {
  const { project, step } = context;
  if (!project || !project.path) {
    return _skipped('preflight requires context.project.path');
  }
  if (!_isDir(path.join(project.path, '.prawduct'))) {
    return _skipped('no .prawduct/ directory — not a prawduct-governed project', { governed: false });
  }

  const hook = _internal.locateHook();
  if (!hook) {
    log.info('prawduct-hook not found — preflight cannot measure the gates', { project: project.name });
    return _skipped('prawduct-hook not found on PATH or in the installed prawduct plugin — gates not measured', { governed: true });
  }

  const timeoutMs = _internal.timeoutMs;
  const exec = await _internal.execFileArgs(hook.path, ['stop'], {
    cwd: project.path,
    timeoutMs,
    maxBufferBytes: MAX_BUFFER_BYTES,
    // The hook reads its harness payload from stdin to EOF; an open pipe
    // would hang it to the timeout.
    closeStdin: true,
    // Pin the project the hook is asked about. Its resolver otherwise reads
    // CLAUDE_PROJECT_DIR — set in this process's environment when the server
    // was launched from inside a session — or the cwd's git worktree.
    env: { ...process.env, CLAUDE_PROJECT_DIR: project.path }
  });

  if (exec.timedOut) {
    log.warn('prawduct-hook stop was killed by its deadline — gates not measured', {
      project: project.name, hook: hook.path, timeoutMs
    });
    return _skipped(`prawduct-hook stop did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped — gates not measured`, { governed: true, hook: hook.path });
  }
  if (exec.error) {
    log.warn('prawduct-hook stop could not run — gates not measured', {
      project: project.name, hook: hook.path, error: exec.error
    });
    return _skipped(`prawduct-hook stop could not run: ${exec.error} — gates not measured`, { governed: true, hook: hook.path });
  }

  // The hook's own contract is 0 clean / 2 block; api-contract.md gives its row
  // exactly those two outcomes. Anything else — an unrecognised subcommand, a
  // build-plan refusal, a traceback — is the HOOK failing, not a gate verdict,
  // and rendering a Python stack trace as prawduct's block text is precisely
  // the false report this step exists to prevent.
  if (exec.exitCode !== 0 && exec.exitCode !== BLOCKED_EXIT_CODE) {
    log.warn('prawduct-hook stop exited outside its 0/2 contract — treating as unmeasured', {
      project: project.name, exitCode: exec.exitCode
    });
    return _skipped(
      `prawduct-hook stop exited ${exec.exitCode}, which is neither clear (0) nor blocked (${BLOCKED_EXIT_CODE}) — `
      + 'the hook itself failed, so the gates were not measured',
      { governed: true, hook: hook.path, exitCode: exec.exitCode, detail: _tailChars(exec.stderr, BLOCK_TEXT_MAX_CHARS) }
    );
  }

  if (exec.exitCode === 0) {
    return {
      ok: true,
      status: 'done',
      output: { exitCode: 0, hook: hook.path, hookVia: hook.via, governed: true, measured: true, detail: 'prawduct gates clear' },
      blockers: []
    };
  }

  // The hook prints its verdict to stderr; stdout is read only as a fallback
  // for a future version that moves it.
  const blockText = _tailChars(exec.stderr, BLOCK_TEXT_MAX_CHARS) || _tailChars(exec.stdout, BLOCK_TEXT_MAX_CHARS);
  const halts = step && (step.blocker === true || step.blocker === 'errors-only');
  const advisory = !halts;
  log.info('prawduct preflight reports an unmet gate', { project: project.name, exitCode: exec.exitCode, advisory });
  return {
    ok: false,
    status: 'blocked',
    output: {
      exitCode: exec.exitCode,
      hook: hook.path,
      hookVia: hook.via,
      governed: true,
      measured: true,
      advisory,
      // The drawer's kind-agnostic "ok, but look at this" channel: an advisory
      // block rows as a warning and the banner reads "completed with
      // warnings". A halting block is the blocker itself and needs no flag.
      warning: advisory,
      blockText,
      remediation: advisory
        ? 'prawduct’s Stop hook would block this session from ending, and the wrap continued anyway — preflight is advisory by default. Satisfy the gate in the session (run the Critic, capture the reflection) or waive it in .prawduct/.gates-waived; the wrap’s own commit already landed, so nothing here needs a retry. To make this step stop the wrap for this project, set wrapStepOverrides.preflight.blocker to true in .tangleclaw/project.json.'
        : 'prawduct’s Stop hook would block this session from ending, so the wrap stopped here before touching the tree (this project made preflight blocking). Satisfy the gate in the session (run the Critic, capture the reflection) or waive it in .prawduct/.gates-waived, then Retry.'
    },
    blockers: [blockText || `prawduct-hook stop exited ${exec.exitCode} with no message`]
  };
}

const _internal = {
  /** @returns {string[]} The directories this process's PATH names */
  pathDirs: () => String(process.env.PATH || '').split(path.delimiter),
  /** @returns {string} The Claude plugins home (`~/.claude/plugins`) */
  pluginsHome: () => path.join(os.homedir(), '.claude', 'plugins'),
  installedPluginBin,
  locateHook,
  execFileArgs,
  // Overridable only so a guard can drive the timeout path in milliseconds.
  timeoutMs: EXEC_TIMEOUT_MS
};

module.exports = { run, locateHook, installedPluginBin, HOOK_NAME, EXEC_TIMEOUT_MS, _internal };
