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
 *     about the repository. A committed guard would refuse `public/**` edits
 *     in a contributor's clone, where nothing is being served at all.
 *
 * So the entry goes into the gitignored `.claude/settings.local.json`, where
 * TangleClaw already writes its own hooks and where `_mergeBaselineHooks`
 * preserves every foreign entry verbatim across the per-launch reconciliation.
 *
 * The wired command invokes THIS file with `--invoke`, not
 * `guard-primary-checkout.js` directly (#1400). `--invoke` is the STABLE OUTER
 * RUNNER: it spawns the policy script as a CHILD PROCESS rather than
 * requiring it in-process, which is the one choice that lets a syntax error
 * or a missing dependency in that script be witnessed and recorded as a crash
 * rather than silently vanishing into the same `|| true` that makes the guard
 * fail open by design. See `runInner`/`invoke` below.
 *
 * The command is pinned to the PRIMARY checkout's absolute copy of this file
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
 *                                                      does not behave (refuse/allow/advance
 *                                                      the liveness heartbeat)
 *   node scripts/install-primary-guard.js --status     print liveness telemetry; exit 1 if a
 *                                                      crash or a staleness warning is actionable
 *   node scripts/install-primary-guard.js --status --json   same, as JSON
 *   node scripts/install-primary-guard.js --invoke     the wired entrypoint itself — not a
 *                                                      human-facing mode; reads a PreToolUse
 *                                                      payload on stdin, as the hook does
 *   node scripts/install-primary-guard.js --remove     unwire it
 */

const fs = require('node:fs');
const path = require('node:path');
const { shellWord, firstWord } = require('../lib/shell-word');
const { execFileSync } = require('node:child_process');

const { locateCheckouts, OVERRIDE_FILE } = require('../lib/checkout-layout');

/** Tool matcher for the file-writing arm. */
const WRITE_MATCHER = 'Edit|Write|NotebookEdit|MultiEdit';

/**
 * Repo-relative location of the guard (policy) script.
 *
 * `scripts/`, not `.claude/hooks/`: `.claude/*` is gitignored fail-closed with a
 * single deliberate exception, and the guard must be tracked and reviewable.
 * Nothing depends on the location — the wiring names an absolute path.
 */
const GUARD_REL = path.join('scripts', 'guard-primary-checkout.js');

/**
 * Repo-relative location of THIS file — the wired entrypoint and stable
 * outer runner, as of #1400. Named the same way `GUARD_REL` is, for the same
 * reason: `isGuardEntry`/`pinnedScript` match on a basename, and both this
 * file's old role (installer only) and its new one (also the runner) need a
 * name to match against.
 */
const INSTALLER_REL = path.join('scripts', 'install-primary-guard.js');

/**
 * Env var a probe invocation sets so `--invoke` buckets its telemetry away
 * from genuine traffic (#1400 Live-Route Proof). `--self-test` causes a real
 * invocation of the real wired command — that invocation is not fake — but
 * counting it alongside tool-call-triggered invocations would let a healthy
 * `--self-test` habit mask a guard nobody's real work ever reaches. Set only
 * by `runProbe` below, inline, non-exported — the same posture as the
 * existing override env var: a deliberate act, not a sticky one.
 */
const PROBE_ENV = 'TANGLECLAW_PRIMARY_GUARD_SELFTEST_PROBE';

/** Override for where liveness telemetry is written (#1400 requirement 3's "configurable status path"). */
const STATUS_ENV = 'TANGLECLAW_PRIMARY_GUARD_STATUS_FILE';

/** Status file basename, under the resolved git-common-dir. */
const STATUS_BASENAME = 'tangleclaw-primary-guard-status.json';

/** Bounded shape for telemetry's `lastHook` — never raw `tool_name` text past this (#1400 Round 2). */
const HOOK_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * How long `runInner`'s child is allowed to run before being killed and
 * treated as an `error` (#1400 Round 2: "a hung... inner child"). Generous
 * relative to this guard's own work (a handful of filesystem/git checks),
 * conservative enough that a genuinely stuck child cannot freeze the tool
 * call that triggered it forever. Overridable so a test can use a short
 * value instead of waiting out the production default.
 */
const INNER_TIMEOUT_ENV = 'TANGLECLAW_PRIMARY_GUARD_INNER_TIMEOUT_MS';
function innerTimeoutMs() {
  const override = parseInt(process.env[INNER_TIMEOUT_ENV], 10);
  return Number.isFinite(override) && override > 0 ? override : 10000;
}

/**
 * How long a `pending` (started, not yet finished) invocation entry may sit
 * before `reclaimStalePending` treats it as abandoned rather than merely
 * slow (#1400 Round 2 finding 1). Generous relative to `innerTimeoutMs()` —
 * a hung child is already killed well before this fires, so reaching this
 * threshold means the OUTER `--invoke` process itself was killed between
 * starting and finishing, not that its child was merely slow. Overridable
 * for the same reason as the timeout above.
 */
const PENDING_STALE_ENV = 'TANGLECLAW_PRIMARY_GUARD_PENDING_STALE_MS';
function pendingStaleMs() {
  const override = parseInt(process.env[PENDING_STALE_ENV], 10);
  return Number.isFinite(override) && override > 0 ? override : 5 * 60 * 1000;
}

/** Exclusive-lock tuning for `updateStatus` (#1400 Round 2 finding 2). */
const LOCK_SUFFIX = '.lock';
const LOCK_RETRY_MS = 15;
const LOCK_STALE_MS = 10000;
/** Overridable so a test can force a quick, bounded contention timeout instead of waiting out the real one. */
const LOCK_MAX_WAIT_ENV = 'TANGLECLAW_PRIMARY_GUARD_LOCK_MAX_WAIT_MS';
function lockMaxWaitMs() {
  const override = parseInt(process.env[LOCK_MAX_WAIT_ENV], 10);
  return Number.isFinite(override) && override > 0 ? override : 2000;
}

/**
 * Basename of the shell-level sentinel `guardCommand`'s own `||` branch
 * writes when the OUTER `node --invoke` invocation itself never completed
 * (#1400 Round 3 finding 1 / AC3) — missing `node`, or a crash before any of
 * this file's JS could run to report one, the one failure mode `--invoke`'s
 * own exit-0 guarantee cannot cover because nothing JS ever starts to
 * provide it. Pure shell (`printf`, no `node`), which is the point: it has
 * to work precisely when node does not.
 */
const OUTER_FAILURE_BASENAME = 'tangleclaw-primary-guard-outer-failure.json';

/**
 * Where that sentinel lives — mirrors `statusFilePath`'s own resolution
 * (and its override) so both land beside each other under the same
 * git-common-dir, shared across every worktree of this primary.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {string} Absolute path to the sentinel.
 */
function outerFailureSentinelPath(primary) {
  if (process.env[STATUS_ENV]) return `${process.env[STATUS_ENV]}.outer-failure`;
  let gitCommonDir;
  try {
    gitCommonDir = execFileSync('git', ['-C', primary, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8' }).trim();
  } catch (err) {
    gitCommonDir = '.git';
  }
  return path.join(path.resolve(primary, gitCommonDir), OUTER_FAILURE_BASENAME);
}

/**
 * The shell command that invokes the guard.
 *
 * `|| true` is load-bearing, not defensive habit: it guarantees exit 0 whatever
 * happens — a missing node, a syntax error, a deleted script — so the guard can
 * never be the thing that starts the hook-failure loop it exists downstream of.
 * `--invoke` (below) now provides that same guarantee itself, by construction,
 * for every failure mode it can observe — but the `||` branch stays as the
 * last-resort net for the one failure mode nothing inside this file can see:
 * `node` itself missing, or this file's OWN script failing to parse at all.
 * Round 3 (#1400 finding 1) makes that branch WRITE something rather than
 * stay silent: a pure-shell `printf` (no `node`, so it works precisely when
 * `node` does not) drops a sentinel `foldOuterFailureSentinel` later folds
 * into telemetry as `OUTER_NODE_FAILED`, the next time anything — a real
 * invocation once `node` recovers, or an operator's own `--status` — can
 * actually run JS against this primary again.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {string} Shell command for a `hooks[].command` field.
 */
function guardCommand(primary) {
  const sentinel = outerFailureSentinelPath(primary);
  // `>>` (append), not `>` (overwrite, #1400 Round 4 finding 2): several
  // outer-node failures before anyone folds them must leave several lines,
  // not have each overwrite the last and silently under-count a burst.
  const fallback = `{ printf '%s\\n' '{"code":"OUTER_NODE_FAILED"}' >> ${shellWord(sentinel)} 2>/dev/null; true; }`;
  // Single-quoted, not double: the primary checkout is an operator-chosen path,
  // and under double quotes a `$` or a backtick in it is expanded by the shell
  // before `node` ever sees it, while a literal `"` or `\\` breaks the quoting
  // outright. The sibling generator of a `hooks[].command` shipped the
  // double-quoted form for the same reason (#1062).
  return `node ${shellWord(path.join(primary, INSTALLER_REL))} --invoke || ${fallback}`;
}

/**
 * Does a resolved script path belong to this guard, under either its old
 * wiring (pinned straight at the policy script) or its current one (pinned
 * at this file, the runner)?
 *
 * Checked by basename rather than full path for the same reason the original
 * installer did: a reworked invocation prefix must not read as "not
 * installed" and stack a duplicate entry. Checking BOTH names, rather than
 * only the current one, is what lets a machine wired before #1400 re-wire
 * cleanly instead of growing a second, stale entry alongside the new one.
 *
 * @param {string} resolved - A script path, as read back from a wired command.
 * @returns {boolean} True when it names either of this guard's own scripts.
 */
function isOwnScriptPath(resolved) {
  if (typeof resolved !== 'string' || !resolved) return false;
  return resolved.includes(path.basename(INSTALLER_REL)) || resolved.includes(path.basename(GUARD_REL));
}

/**
 * Is a hooks entry this guard's?
 *
 * @param {*} entry - One element of a `hooks.PreToolUse` array.
 * @returns {boolean} True when the entry invokes this guard (old or current wiring).
 */
function isGuardEntry(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => h && typeof h.command === 'string' && isOwnScriptPath(h.command));
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
  try {
    return JSON.parse(raw);
  } catch (err) {
    // `JSON.parse`'s own error names no file. This CLI is what
    // `VRF-798-arm-the-primary-guard` tells a remote operator to run, and a bare
    // `SyntaxError` at the end of an ssh session tells them nothing about which
    // file to open.
    throw new Error(`${file} is not valid JSON (${err.message}). `
      + 'Refusing to touch it — fix or move it, then re-run.');
  }
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
    const hook = entry.hooks.find((h) => h && typeof h.command === 'string' && isOwnScriptPath(h.command));
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
  // Read by STRUCTURE, not by re-parsing shell quoting. `guardCommand` emits
  // exactly `node <word> --invoke || true`, so the word is whatever sits
  // between `node` and the next token, and `firstWord` — the quoter's own
  // inverse — turns it back into a path. A regex that hunts for quotes has to
  // know every quoting style the generator has ever used, and silently
  // mis-reads the one it was not taught: that is how a correctly-wired
  // install came back STALE when the quoting changed. `node` as a WORD, so an
  // `/usr/bin/env node …` or `exec node …` prefix — a shape an operator may
  // have hand-written — is still read.
  const m = /(?:^|\s)node\s+([\s\S]*)$/.exec(command || '');
  if (!m) return null;
  const resolved = firstWord(m[1]);
  return isOwnScriptPath(resolved) ? resolved : null;
}

/**
 * A fresh, empty outcome tally.
 * @returns {{total:number, allow:number, refusal:number, error:number}}
 */
function emptyCounts() {
  return { total: 0, allow: 0, refusal: 0, error: 0 };
}

/**
 * The liveness-telemetry shape every reader and writer agrees on (#1400).
 *
 * Three outcome states, matching the issue's own vocabulary exactly:
 * `refusal` (a deliberate deny), `allow` (a handled fail-open or an ordinary
 * no-decision fall-through — indistinguishable from outside the inner guard,
 * and the inner guard's own contract already treats them the same), `error`
 * (the inner script could not even be trusted to answer — a crash, a bad
 * exit, output that does not parse as this guard's own shape).
 *
 * `selfTest` is tracked separately from `counts` so a healthy self-test habit
 * can never read as evidence that REAL traffic is reaching the guard — see
 * `PROBE_ENV`.
 *
 * @returns {object} Default (never-invoked) status.
 */
function defaultStatus() {
  return {
    lastInvokedAt: null,
    lastHook: null,
    lastOutcome: null,
    counts: emptyCounts(),
    lastError: null,
    lastErrorAt: null,
    // Incremented only for a GENUINE (non-probe) invocation whose payload
    // actually looks engine-shaped (#1400 Round 3 finding 2) — narrower
    // and more honest than inferring liveness merely from `counts.allow +
    // counts.refusal`, which a hand-built CLI call could also produce.
    engineInvocations: 0,
    // Set only alongside an `engineInvocations` increment — the existence
    // proof `--self-test` requires BEFORE it will run its own probes (#1400
    // Round 4 finding 1 / AC8): self-test may check for this, never cause it.
    lastEngineHeartbeatAt: null,
    selfTest: { lastAt: null, lastSuccessfulAt: null, counts: emptyCounts() },
    activity: { lastCheckedCommitCount: null, countsTotalAtLastCheck: null },
    // Invocations that have STARTED but not yet finished, keyed by a random
    // id so genuinely concurrent invocations each get their own entry rather
    // than stomping one shared slot (#1400 Round 2 finding 1). An entry still
    // here past `pendingStaleMs()` means the OUTER `--invoke` process itself
    // was killed between starting and finishing — `reclaimStalePending`
    // folds it into `counts.error` as `unclosed-entry`.
    pending: {}
  };
}

/**
 * Where liveness telemetry lives.
 *
 * Git-COMMON-dir, not the primary's own `.git`: every worktree this repo's
 * own convention creates shares one common storage area (a linked worktree's
 * `.git` is a FILE pointing back at `<primary>/.git/worktrees/<name>`, which
 * itself points back at the common dir), so a hook fired from a
 * worktree-rooted session and one fired from the primary-rooted session both
 * update the SAME file — which is what "is this guard alive" has to mean,
 * since both are genuine production traffic. `STATUS_ENV` overrides this for
 * a test fixture, or for an operator who wants it elsewhere — the
 * "configurable status path" #1400 asks for.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {string} Absolute path to the status file.
 */
function statusFilePath(primary) {
  if (process.env[STATUS_ENV]) return process.env[STATUS_ENV];
  let gitCommonDir;
  try {
    gitCommonDir = execFileSync('git', ['-C', primary, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8' }).trim();
  } catch (err) {
    gitCommonDir = '.git';
  }
  return path.join(path.resolve(primary, gitCommonDir), STATUS_BASENAME);
}

/**
 * Read the status file, tolerating absence or corruption.
 *
 * Unlike `readSettings` (the operator's own permissions file, where refusing
 * to clobber a malformed file is the safer failure), this file is PURELY
 * telemetry this script owns end to end — nothing an operator hand-edits,
 * nothing else reads expecting a stable format. Resetting to defaults on
 * corruption is the correct recovery here, not a risk the way it would be
 * there: the alternative is a guard whose `--invoke` throws on every real
 * tool call because one stray byte corrupted a counter nobody else reads.
 *
 * @param {string} file - Absolute path.
 * @returns {object} Status, merged over defaults so an older or partial file
 *   never produces a reader that crashes on a missing field.
 */
function readStatus(file) {
  const base = defaultStatus();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return base;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return base;
    return {
      ...base,
      ...parsed,
      counts: { ...base.counts, ...(parsed.counts || {}) },
      selfTest: {
        ...base.selfTest,
        ...(parsed.selfTest || {}),
        counts: { ...base.selfTest.counts, ...((parsed.selfTest || {}).counts || {}) }
      },
      activity: { ...base.activity, ...(parsed.activity || {}) },
      pending: { ...base.pending, ...(parsed.pending || {}) }
    };
  } catch (err) {
    return base;
  }
}

/**
 * Write the status file atomically.
 *
 * Same tmp-then-rename shape as `writeSettings`, for the same reason: a crash
 * mid-write must not leave a truncated file that the next `readStatus` then
 * has to recover from — cheap to do right even though corruption here is
 * recoverable (unlike `settings.local.json`, where it is not).
 *
 * @param {string} file - Absolute path.
 * @param {object} status - Status to serialize.
 * @returns {void}
 */
function writeStatusAtomic(file, status) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Acquire an exclusive, local lock for one status read-modify-write (#1400
 * Round 2 finding 2).
 *
 * `fs.openSync(..., 'wx')` is the primitive: it creates the file only if it
 * does not already exist, atomically, so two processes racing to create it
 * can never both believe they hold it. A lock whose own mtime is older than
 * `LOCK_STALE_MS` is presumed abandoned by a holder that crashed between
 * acquiring it and releasing it — the same "a crash must not wedge the
 * guard forever" posture as everything else in this file — and is broken
 * rather than honoured. Giving up after `lockMaxWaitMs()` (returning null
 * rather than blocking indefinitely) is deliberate too: telemetry must
 * never be the reason a real tool call stalls. Null means `updateStatus`
 * SKIPS the update entirely rather than proceeding unlocked (#1400 Round 3
 * Warning) — an unlocked read-modify-write risks silently clobbering a
 * concurrent process's own crash record, which is the one thing this
 * telemetry exists to preserve, and a missed increment under contention
 * this guard does not expect to see in practice (one hook invocation per
 * tool call, not a high-throughput server) is the far cheaper failure.
 *
 * @param {string} file - The status file this lock protects.
 * @returns {string|null} The lock path to pass to `releaseLock`, or null
 *   when the lock could not be acquired within the wait budget.
 */
function acquireLock(file) {
  const lockPath = `${file}${LOCK_SUFFIX}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + lockMaxWaitMs();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx'));
      return lockPath;
    } catch (err) {
      if (err.code !== 'EEXIST') return null; // an unexpected filesystem error: proceed unlocked rather than loop on it
      let stale;
      try {
        stale = (Date.now() - fs.statSync(lockPath).mtimeMs) > LOCK_STALE_MS;
      } catch (statErr) {
        stale = true; // the lock vanished between our open() and this stat(): treat as gone, retry below
      }
      if (stale) {
        try { fs.unlinkSync(lockPath); } catch (unlinkErr) { /* another holder already cleared it first */ }
        continue;
      }
      if (Date.now() >= deadline) return null;
      const spinUntil = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < spinUntil) { /* short, local, synchronous lock — no async primitive to await here */ }
    }
  }
}

/**
 * Release a lock acquired by `acquireLock`. Idempotent and silent if the
 * lock is already gone — releasing twice, or after a stale-break already
 * removed it, must never throw.
 *
 * @param {string|null} lockPath - What `acquireLock` returned, or null.
 * @returns {void}
 */
function releaseLock(lockPath) {
  if (!lockPath) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (err) { /* already gone */ }
}

/**
 * Read the status file, fold any pending outer-failure sentinel into it,
 * let `mutate` change it further in place, and write it back — all under
 * `acquireLock`'s exclusive lock, so two concurrent `--invoke` processes
 * updating the SAME counters never lose one side's increment to the
 * other's overwrite (#1400 Round 2 finding 2), and the sentinel fold can
 * never be claimed-then-dropped by a lock that turns out to be contended
 * (#1400 Round 4 finding 2 — see `foldOuterFailureSentinelLocked`'s doc).
 *
 * SKIPS the update entirely — never falls back to an unlocked
 * read-modify-write — when the lock cannot be acquired within its budget
 * (#1400 Round 3 Warning): see `acquireLock`'s own doc for why skipping is
 * the correct degrade. Returns `undefined` in that case; a caller that
 * must never see `undefined` (`reportStatus`, #1400 Round 4 finding 3)
 * substitutes a plain `readStatus` itself rather than this function
 * guessing at a one-size-fits-all fallback for every caller's own shape of
 * return value.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @param {function(object): *} mutate - Mutates the status object in place; its return value is returned.
 * @returns {*} Whatever `mutate` returned, or `undefined` if the update was skipped.
 */
function updateStatus(primary, mutate) {
  const file = statusFilePath(primary);
  const lockPath = acquireLock(file);
  if (!lockPath) {
    process.stderr.write('install-primary-guard: telemetry update skipped — lock contended\n');
    return undefined;
  }
  try {
    const current = readStatus(file);
    foldOuterFailureSentinelLocked(current, primary);
    const result = mutate(current);
    writeStatusAtomic(file, current);
    return result;
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * A fresh, unique id for one in-flight invocation's `pending` entry.
 * @returns {string}
 */
function newPendingId() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Fold every `pending` entry older than `pendingStaleMs()` into `counts.error`
 * (or `selfTest.counts.error` for a probe) as `unclosed-entry`, and remove it.
 *
 * Called at the START of the next `recordInvocationStart`/`reportStatus`
 * update — reached this file's own telemetry still eventually, even though
 * nothing explicit ever ran at the moment the abandoned entry's own process
 * died. By the time this fires, `runInner`'s own timeout (`innerTimeoutMs()`)
 * has already ruled out "the inner child was merely slow" — reaching this
 * means the OUTER `--invoke` process itself was killed between starting and
 * finishing an invocation.
 *
 * @param {object} status - Status object, MUTATED in place.
 * @returns {void}
 */
function reclaimStalePending(status) {
  const threshold = pendingStaleMs();
  const now = Date.now();
  for (const [id, entry] of Object.entries(status.pending)) {
    const startedAt = Date.parse(entry.startedAt);
    if (!Number.isFinite(startedAt) || now - startedAt <= threshold) continue;
    const bucket = entry.probe ? status.selfTest.counts : status.counts;
    bucket.total += 1;
    bucket.error += 1;
    if (!entry.probe) {
      status.lastOutcome = 'error';
      status.lastError = 'unclosed-entry';
      status.lastErrorAt = new Date().toISOString();
    }
    delete status.pending[id];
  }
}

/**
 * Fold the shell-level outer-failure sentinel (`guardCommand`'s `||`
 * fallback) into an ALREADY-LOADED status object, if one is sitting there
 * (#1400 Round 3 finding 1) — called from INSIDE `updateStatus`'s own
 * locked critical section (#1400 Round 4 finding 2), not before it.
 *
 * Moved here after a real bug: the original design unlinked the sentinel
 * as its OWN atomic claim, BEFORE acquiring the status lock — correct
 * across multiple PROCESSES racing to notice the same sentinel, but not
 * against Round 3's OWN other fix (finding 3: skip, never unlocked-write,
 * under lock contention). If the lock happened to be contended at exactly
 * that moment, the unlink still destroyed the sentinel, but the locked
 * write that was supposed to fold it got skipped — losing the
 * `OUTER_NODE_FAILED` signal entirely. Doing both under the SAME lock
 * `updateStatus` already acquires removes the gap: the lock itself is now
 * the mutual exclusion, so read-fold-unlink-write is one atomic step.
 *
 * `>>` (append, not `>`) in `guardCommand`'s fallback means several
 * shell-level failures before anyone folds them leave several lines —
 * folded here as that many errors, not just one, so a burst of real
 * failures is not under-counted.
 *
 * @param {object} status - Status object, MUTATED in place.
 * @param {string} primary - Absolute primary checkout root.
 * @returns {void}
 */
function foldOuterFailureSentinelLocked(status, primary) {
  const sentinel = outerFailureSentinelPath(primary);
  let raw;
  try {
    raw = fs.readFileSync(sentinel, 'utf8');
  } catch (err) {
    return; // nothing to fold
  }
  try {
    fs.unlinkSync(sentinel);
  } catch (err) { /* already gone somehow — fine, still fold what was read */ }
  const lines = raw.split('\n').filter((l) => l.trim());
  const now = new Date().toISOString();
  for (let i = 0; i < lines.length; i += 1) {
    status.counts.total += 1;
    status.counts.error += 1;
    status.lastOutcome = 'error';
    status.lastError = 'OUTER_NODE_FAILED';
    status.lastErrorAt = now;
  }
}

/**
 * Does a PreToolUse payload look like a genuine Claude Code engine
 * invocation rather than a hand-built CLI call (#1400 Round 3 finding 2,
 * tightened Round 4 finding 1 / AC8)? Requires `hook_event_name ===
 * 'PreToolUse'` together with non-empty `session_id`, `transcript_path` and
 * `cwd` — fields nobody constructing a payload by hand (a test, a curious
 * operator) would think to add — AND that `transcript_path` resolves to a
 * REAL, EXISTING regular `.jsonl` file whose basename matches `session_id`.
 * The on-disk check is what makes this resistant to a payload that merely
 * COPIES realistic-looking field names: a self-test or a hand-built call
 * cannot cheaply fabricate a transcript file matching a session id, since
 * doing so is indistinguishable from manufacturing the very engine
 * heartbeat AC8 forbids self-test from causing.
 *
 * @param {object} parsed - Already-parsed stdin JSON.
 * @returns {boolean}
 */
function looksLikeEngineEnvelope(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (parsed.hook_event_name !== 'PreToolUse') return false;
  if (typeof parsed.session_id !== 'string' || !parsed.session_id.trim()) return false;
  if (typeof parsed.transcript_path !== 'string' || !parsed.transcript_path.trim()) return false;
  if (typeof parsed.cwd !== 'string' || !parsed.cwd.trim()) return false;

  const tp = parsed.transcript_path.trim();
  let st;
  try {
    st = fs.statSync(tp);
  } catch (err) {
    return false;
  }
  if (!st.isFile()) return false;
  if (!tp.endsWith('.jsonl')) return false;
  return path.basename(tp, '.jsonl') === String(parsed.session_id).trim();
}

/**
 * Should THIS invocation count toward `engineInvocations`? Never for a
 * self-test probe (same posture as every other genuine/probe split in this
 * file), and only when the raw payload parses and looks engine-shaped.
 *
 * @param {string} raw - Raw stdin bytes.
 * @param {boolean} probe - Whether this is a self-test probe invocation.
 * @returns {boolean}
 */
function isGenuineEngineInvocation(raw, probe) {
  if (probe) return false;
  try {
    return looksLikeEngineEnvelope(JSON.parse(raw));
  } catch (err) {
    return false;
  }
}

/**
 * Turn a spawn/execution failure into a SHORT, SAFE classification.
 *
 * Telemetry "must not contain raw commands, target paths, or secrets"
 * (#1400's own Security criterion). `err.message` from a failed
 * `execFileSync` routinely contains the absolute script path or echoes
 * stderr, either of which can carry both. `err.code` (`ENOENT`, `EACCES`),
 * the child's own exit code, and its signal are already a bounded,
 * path-free vocabulary — small enough to reason about, and that is the
 * point.
 *
 * @param {object} err - Error thrown by `execFileSync`.
 * @returns {string} A bounded code, never the raw message.
 */
function boundedErrorCode(err) {
  if (err && typeof err.code === 'string' && err.code) return err.code;
  if (err && typeof err.status === 'number') return `exit-${err.status}`;
  if (err && err.signal) return `signal-${err.signal}`;
  return 'crash';
}

/**
 * Read all of stdin synchronously.
 *
 * `--invoke` is reached only through the wired hook command, where stdin is
 * always a pipe carrying the harness's PreToolUse JSON — synchronous is the
 * right call here the same way it would be wrong in a long-lived server.
 *
 * @returns {string} Raw stdin bytes, or '' when none could be read.
 */
function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (err) {
    return '';
  }
}

/**
 * Best-effort tool name for telemetry's `lastHook`, read from the SAME bytes
 * forwarded to the inner guard.
 *
 * Never throws and never blocks forwarding: a payload this cannot parse is
 * the inner guard's own problem to fail open on (it already does), not a
 * reason to withhold telemetry about the attempt.
 *
 * @param {string} raw - Raw stdin bytes.
 * @returns {string} The tool name, or 'unknown'.
 */
function inferredHook(raw) {
  try {
    const parsed = JSON.parse(raw);
    const name = parsed.tool_name;
    // Bounded against `HOOK_NAME_RE`, not merely "is it a string" (#1400
    // Round 2 finding 3 / AC7): `tool_name` is harness-supplied and normally
    // one of a short fixed set, but telemetry security requires never
    // persisting a raw command, path or secret, and a bare type check lets
    // whatever this field is through unexamined. A value that fails the
    // pattern is treated the same as an absent one.
    return typeof name === 'string' && HOOK_NAME_RE.test(name) ? name : 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

/**
 * Run the inner guard as a CHILD process and classify what came back.
 *
 * A child, not a `require()` — the one choice that makes `--invoke` a STABLE
 * outer runner rather than a second copy of the same failure mode it exists
 * to catch. A syntax error in `guard-primary-checkout.js` would make a
 * same-process `require()` throw from the IMPORT itself, before any of this
 * file's own code could run at all; a child process isolates that crash in a
 * process THIS one can observe, classify and survive. The reverse is not
 * true — a syntax error in this file is still caught only by the wired
 * command's trailing `|| true` — but that is the rarer failure mode: this
 * file changes far less often than the policy script it wraps.
 *
 * Never alters the decision it forwards: an anomalous (non-deny,
 * non-empty) outcome is still forwarded byte-for-byte, just flagged in
 * telemetry as `error` rather than silently read as a clean refusal or a
 * clean fall-through.
 *
 * @param {string} guardPath - Absolute path to `guard-primary-checkout.js`.
 * @param {string} raw - Raw stdin bytes to forward unchanged.
 * @returns {{outcome:'allow'|'refusal'|'error', stdout:string, errorCode:string|null}}
 */
function runInner(guardPath, raw) {
  let stdout;
  try {
    // `timeout`/`killSignal` (#1400 Round 2 finding 1): without a bound, a
    // hung inner script would block this call — and the hook invocation it
    // is answering for — indefinitely. `execFileSync`'s own timeout throws
    // with `err.signal` set, which `boundedErrorCode` already classifies.
    stdout = execFileSync(process.execPath, [guardPath],
      { input: raw, encoding: 'utf8', timeout: innerTimeoutMs(), killSignal: 'SIGKILL' });
  } catch (err) {
    return { outcome: 'error', stdout: '', errorCode: boundedErrorCode(err) };
  }
  if (!stdout || !stdout.trim()) return { outcome: 'allow', stdout: '', errorCode: null };
  try {
    const parsed = JSON.parse(stdout);
    const decision = parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision;
    if (decision === 'deny') return { outcome: 'refusal', stdout, errorCode: null };
    return { outcome: 'error', stdout, errorCode: 'unexpected-decision' };
  } catch (err) {
    return { outcome: 'error', stdout, errorCode: 'unparseable-output' };
  }
}

/**
 * Update liveness telemetry for one invocation. Never throws.
 *
 * "Telemetry write failures must not alter the decision" (#1400 requirement
 * 3) is enforced by STRUCTURE, not by hoping every call site remembers a
 * try/catch: this is the only place `--invoke` writes the status file, and it
 * swallows every failure itself, after the decision has already been
 * computed by `runInner`.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @param {object} info - `{hook, outcome, errorCode, probe}`.
 * @returns {void}
 */
function recordInvocation(primary, info) {
  try {
    updateStatus(primary, (current) => {
      // Clears the `pending` entry `recordInvocationStart` opened for this
      // SAME invocation — this call reaching here at all means the outer
      // runner did not crash before finishing (#1400 Round 2 finding 1).
      if (info.pendingId) delete current.pending[info.pendingId];
      const now = new Date().toISOString();
      const bucket = info.probe ? current.selfTest.counts : current.counts;
      bucket.total += 1;
      if (info.outcome === 'allow') bucket.allow += 1;
      else if (info.outcome === 'refusal') bucket.refusal += 1;
      else bucket.error += 1;

      if (info.probe) {
        current.selfTest.lastAt = now;
      } else {
        current.lastInvokedAt = now;
        current.lastHook = info.hook;
        current.lastOutcome = info.outcome;
        if (info.engineInvocation) {
          current.engineInvocations += 1;
          // The heartbeat `--self-test` requires EXISTING proof of before it
          // will even run its own probes (#1400 Round 4 finding 1) — set
          // only by a GENUINE engine-shaped invocation, never a probe.
          current.lastEngineHeartbeatAt = now;
        }
      }
      if (info.outcome === 'error') {
        current.lastError = info.errorCode;
        current.lastErrorAt = now;
      }
    });
  } catch (err) { // prawduct:allow prawduct/broad-except -- telemetry is strictly best-effort; the decision runInner already computed must reach the harness whether or not this write succeeds, and there is no operator reading this stream for a more specific message to help.
    process.stderr.write(`install-primary-guard: telemetry write failed: ${boundedErrorCode(err)}\n`);
  }
}

/**
 * Record that an invocation STARTED, before `runInner` even runs (#1400
 * Round 2 finding 1). The one write that can survive the OUTER `--invoke`
 * process itself being killed before `recordInvocation` ever runs: without
 * it, a hung-then-killed invocation leaves no trace at all, indistinguishable
 * from one that never fired. `reclaimStalePending` is what eventually turns
 * an entry nothing ever closed into a counted `error`.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @param {string} hook - Already-bounded hook name from `inferredHook`.
 * @param {boolean} probe - Whether this is a self-test probe invocation.
 * @returns {string|null} The pending entry's id, to hand back to
 *   `recordInvocation`, or null if even this best-effort write failed.
 */
function recordInvocationStart(primary, hook, probe) {
  try {
    const id = updateStatus(primary, (current) => {
      reclaimStalePending(current);
      const freshId = newPendingId();
      current.pending[freshId] = { startedAt: new Date().toISOString(), hook, probe };
      return freshId;
    });
    return id === undefined ? null : id;
  } catch (err) { // prawduct:allow prawduct/broad-except -- same best-effort posture as `recordInvocation`: a failed start-marker write must never block the decision that follows.
    process.stderr.write(`install-primary-guard: telemetry write failed: ${boundedErrorCode(err)}\n`);
    return null;
  }
}

/**
 * `--invoke` — the STABLE OUTER RUNNER the wired hook command actually calls
 * (#1400).
 *
 * Wired instead of `guard-primary-checkout.js` directly. A hook command that
 * invokes the policy script in-process has no way to witness that script
 * failing to even START — a syntax error, a missing dependency — because the
 * thing crashing is the thing that would have reported the crash. Spawning it
 * as a child (`runInner`) moves the observation point one process up, where a
 * crash is a catchable exception rather than a silent `|| true`.
 *
 * Exits 0 unconditionally. That guarantee is now this function's OWN, not
 * borrowed from the wired command's trailing `|| true` (which stays, as
 * belt-and-braces, for the one failure mode this function cannot see: this
 * very file failing to parse).
 *
 * @returns {number} Always 0.
 */
function invoke() {
  const raw = readStdinSync();
  const located = locateCheckouts(path.join(__dirname, '..'));
  if (!located) {
    // Cannot even find the primary to locate the status file against. There
    // is nowhere safe to record this and nothing policy-relevant to decide —
    // fail open silently, exactly as the inner guard does for the same
    // precondition (`could not establish the checkout layout`).
    return 0;
  }
  const primary = located.primary;
  // The outer-failure sentinel (#1400 Round 3 finding 1) is folded inside
  // `updateStatus`'s own lock, via `recordInvocationStart` below — not here
  // as a separate unlocked pre-step (#1400 Round 4 finding 2 fixed exactly
  // that gap).
  const guardPath = path.join(primary, GUARD_REL);
  const probeInvocation = Boolean(process.env[PROBE_ENV]);
  const hook = inferredHook(raw);
  const engineInvocation = isGenuineEngineInvocation(raw, probeInvocation);
  // Recorded BEFORE `runInner`, not after (#1400 Round 2 finding 1): if this
  // whole process is killed while `runInner` is blocked, this is the only
  // telemetry write that already happened.
  const pendingId = recordInvocationStart(primary, hook, probeInvocation);
  const result = runInner(guardPath, raw);
  recordInvocation(primary, {
    hook, outcome: result.outcome, errorCode: result.errorCode, probe: probeInvocation, pendingId,
    engineInvocation
  });
  if (result.stdout) process.stdout.write(result.stdout);
  return 0;
}

/**
 * Commit count in the primary — an activity signal the guard cannot
 * influence (#1400 requirement 4). The guard's invocations are driven by
 * tool calls, not by commits, so a session editing without committing moves
 * neither number: this is a deliberately coarse, conservative proxy for
 * "real work happened here", not a tripwire for every tool call.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {number|null} Commit count, or null when git could not answer.
 */
function commitActivitySignal(primary) {
  try {
    return parseInt(execFileSync('git', ['-C', primary, 'rev-list', '--count', 'HEAD'],
      { encoding: 'utf8' }).trim(), 10);
  } catch (err) {
    return null;
  }
}

/**
 * Compare the independent activity signal against invocation telemetry since
 * the last check, and advance the stored baseline either way.
 *
 * Three rules, taken directly from #1400's own acceptance criteria, each one
 * a case this must not get backwards:
 *   - "do not alarm from wall-clock age alone" — nothing here reads a clock;
 *     only count DELTAS since the last check.
 *   - "do not interpret zero outcome counters as proof of health" — a count
 *     sitting at zero is never, by itself, compared against anything.
 *   - "an intentionally idle install, where neither signal advances, remains
 *     quiet" — the warning fires only on commits-without-invocations, never
 *     on neither-advancing.
 *
 * @param {object} status - Current status; `status.activity` is MUTATED to the new baseline.
 * @param {number|null} currentActivity - This check's commit count.
 * @returns {boolean} True when commits advanced since the last check but genuine invocations did not.
 */
function updateActivityAndWarn(status, currentActivity) {
  const baseline = status.activity;
  const haveBaseline = baseline.lastCheckedCommitCount !== null && baseline.countsTotalAtLastCheck !== null;
  let warn = false;
  if (haveBaseline && currentActivity !== null) {
    const commitsAdvanced = currentActivity > baseline.lastCheckedCommitCount;
    const invocationsAdvanced = status.counts.total > baseline.countsTotalAtLastCheck;
    warn = commitsAdvanced && !invocationsAdvanced;
  }
  if (currentActivity !== null) baseline.lastCheckedCommitCount = currentActivity;
  baseline.countsTotalAtLastCheck = status.counts.total;
  return warn;
}

/**
 * Does the TRACKED, shared `.claude/settings.json` declare its own
 * `PreToolUse` entry for one of this guard's two exact matchers, that is not
 * this guard's own entry (#1400 Round 2 finding 4, partial AC8)?
 *
 * Deliberately narrow, and the limit is stated rather than hidden: this
 * checks for an EXACT matcher collision (`'Bash'` or `WRITE_MATCHER`
 * verbatim), not general regex overlap between two different matcher
 * strings — real overlap detection between two hook-matcher patterns is a
 * harder problem than this check claims to solve, and a check that
 * overclaimed would be worse than one that is honest about its scope. It is
 * still a genuine, checkable fact: this repo's own contract says
 * `settings.json` carries no `hooks` block at all (`test/repo-governance-
 * reference.test.js`), so ANY `PreToolUse` entry appearing there for this
 * guard's exact matchers is already anomalous by that contract, whatever
 * wrote it.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {string[]} Matchers where `settings.json` declares a competing,
 *   non-guard `PreToolUse` entry. Empty when none does, or the file cannot
 *   be read.
 */
function sharedSettingsHookConflicts(primary) {
  const shared = tolerantReadSettings(path.join(primary, '.claude', 'settings.json'));
  const entries = (shared && shared.hooks && shared.hooks.PreToolUse) || [];
  if (!Array.isArray(entries)) return [];
  const conflicts = [];
  for (const entry of entries) {
    if (isGuardEntry(entry)) continue;
    if (entry && (entry.matcher === 'Bash' || entry.matcher === WRITE_MATCHER)) {
      conflicts.push(entry.matcher);
    }
  }
  return conflicts;
}

/**
 * `readSettings`, but tolerant of absence or malformed JSON — the right
 * posture for a READ-ONLY diagnostic (`--self-test`/`--status`), unlike
 * `readSettings`'s own refuse-to-clobber contract, which exists for the
 * WRITE path (`apply`) where silently starting from `{}` would risk
 * discarding the operator's real permissions block.
 *
 * @param {string} file - Absolute path.
 * @returns {object} Parsed settings, or `{}` on absence or any read/parse failure.
 */
function tolerantReadSettings(file) {
  try {
    return readSettings(file);
  } catch (err) {
    return {};
  }
}

/**
 * The merged view `--self-test` checks against (#1400 Round 3 finding 2 /
 * AC8): whether `disableAllHooks` is set in EITHER settings file (which
 * disables every hook, this guard included, regardless of what is wired),
 * and the union of both files' `PreToolUse` entries — Claude Code loads
 * hooks from both `.claude/settings.json` and `.claude/settings.local.json`
 * additively, so the union is the honest model of "what the engine actually
 * has to work with", not a guess at precedence between them (there is none
 * to guess at for two files that both contribute, rather than one
 * overriding the other).
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {{disableAllHooks:boolean, entries:object[]}}
 */
function mergedSettingsState(primary) {
  const shared = tolerantReadSettings(path.join(primary, '.claude', 'settings.json'));
  const local = tolerantReadSettings(path.join(primary, '.claude', 'settings.local.json'));
  const disableAllHooks = shared.disableAllHooks === true || local.disableAllHooks === true;
  const sharedEntries = (shared.hooks && Array.isArray(shared.hooks.PreToolUse)) ? shared.hooks.PreToolUse : [];
  const localEntries = (local.hooks && Array.isArray(local.hooks.PreToolUse)) ? local.hooks.PreToolUse : [];
  return { disableAllHooks, entries: [...sharedEntries, ...localEntries] };
}

/**
 * `--status` (and `--status --json`): print liveness telemetry and the
 * actionable flags #1400 asks this surface to expose.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @param {boolean} asJson - Print machine-readable JSON instead of prose.
 * @returns {number} 0 ordinarily; 1 when something here is actionable.
 */
function reportStatus(primary, asJson) {
  // Computed OUTSIDE the lock: a `git` subprocess has no business holding up
  // a concurrent `--invoke`'s own telemetry write.
  const activitySignal = commitActivitySignal(primary);
  let staleWarning = false;
  let current;
  try {
    // The sentinel fold now happens INSIDE `updateStatus`'s own lock (#1400
    // Round 4 finding 2), so a single locked pass here both folds it and
    // advances the activity baseline — no separate unlocked pre-step.
    current = updateStatus(primary, (status) => {
      reclaimStalePending(status);
      staleWarning = updateActivityAndWarn(status, activitySignal);
      return status;
    });
  } catch (err) { // prawduct:allow prawduct/broad-except -- a failed locked update must not block printing a best-effort status the operator asked for.
    process.stderr.write(`install-primary-guard: could not save the activity baseline: ${boundedErrorCode(err)}\n`);
  }
  if (!current) {
    // `undefined` means the lock was contended (skipped, #1400 Round 3
    // finding 3) or the try above threw before `current` was ever set —
    // answer with a best-effort READ rather than crash dereferencing a
    // field on `undefined` (#1400 Round 4 finding 3). The sentinel fold and
    // the activity-baseline advance did not run in this path.
    current = readStatus(statusFilePath(primary));
  }
  // "Any crash since the last successful wired-path self-test must be
  // flagged as actionable" (#1400 requirement 5) — a crash recorded before
  // the last successful self-test is old news a passing self-test already
  // re-covered; one recorded after it is new.
  const crashSinceLastSelfTest = Boolean(current.lastErrorAt
    && (!current.selfTest.lastSuccessfulAt || current.lastErrorAt > current.selfTest.lastSuccessfulAt));
  // "has a GENUINE, engine-shaped invocation ever produced a real decision"
  // (#1400 Round 3 finding 2) — narrower than Round 2's `counts.allow +
  // counts.refusal > 0`, which a hand-built CLI call without
  // `PROBE_ENV` set could also satisfy; `engineInvocations` only counts a
  // payload that actually looks like Claude Code's own PreToolUse envelope.
  const liveEngineVerified = current.engineInvocations > 0;
  const sharedConflicts = sharedSettingsHookConflicts(primary);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      ...current, staleWarning, crashSinceLastSelfTest, liveEngineVerified,
      sharedSettingsHookConflicts: sharedConflicts
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`invocations: ${current.counts.total} (allow ${current.counts.allow}, `
      + `refusal ${current.counts.refusal}, error ${current.counts.error})\n`);
    process.stdout.write(`last invoked: ${current.lastInvokedAt || 'never'} `
      + `(${current.lastHook || 'n/a'}, ${current.lastOutcome || 'n/a'})\n`);
    if (current.lastError) {
      process.stdout.write(`last error: ${current.lastError} at ${current.lastErrorAt}\n`);
    }
    process.stdout.write(`self-test: ${current.selfTest.counts.total} run(s), last success `
      + `${current.selfTest.lastSuccessfulAt || 'never'}\n`);
    process.stdout.write(`live-engine-verified: ${liveEngineVerified}\n`);
    if (crashSinceLastSelfTest) {
      process.stdout.write('ACTIONABLE: a crash was recorded since the last successful --self-test.\n');
    }
    if (staleWarning) {
      process.stdout.write('ACTIONABLE: the primary gained commits since the last --status check, but '
        + 'no genuine guard invocation was recorded in that window — the hook may be unwired.\n');
    }
    if (sharedConflicts.length) {
      process.stdout.write('ACTIONABLE: .claude/settings.json declares its own PreToolUse entry for '
        + `matcher(s) ${sharedConflicts.join(', ')}, which this repo's own contract says it should not `
        + '— it may shadow or conflict with this guard\'s entry in settings.local.json.\n');
    }
  }
  return (crashSinceLastSelfTest || staleWarning || sharedConflicts.length > 0) ? 1 : 0;
}

/**
 * Drive the WIRED command through three cases and confirm the liveness
 * heartbeat moves as a side effect of doing so (#1400 requirements 1 and 2).
 *
 * The THIRD case — a broken or missing inner script surfaced as `error`
 * rather than silently passing — is deliberately NOT probed here against the
 * real primary: that would require corrupting the real policy script just to
 * test it. It is covered instead by `test/primary-checkout-guard.test.js`
 * against a disposable fixture, which can safely break a COPY of the script.
 *
 * @param {string} command - The wired command string.
 * @param {string} primary - Absolute primary checkout root.
 * @returns {{ok:boolean, detail:string}}
 */
function selfTest(command, primary) {
  // Named first (#1400 Round 2 finding 5): without it, a missing/broken
  // `node` surfaces only as `runProbe`'s generic "the wired command failed
  // to run" — true, but it makes the operator infer the real cause from a
  // shell error instead of being told it directly. The OUTER wired
  // command's own `node` resolving at all is no longer undetectable in
  // PRODUCTION either (#1400 Round 3 finding 1: `guardCommand`'s shell-level
  // sentinel, folded inside `updateStatus`) — this check is the immediate,
  // on-demand version of the same question, for the one piece `--self-test`
  // can ask about directly: whether the node binary this process would
  // re-spawn as the inner guard actually runs, right now.
  const nodeCheck = checkNodeResolvable();
  if (!nodeCheck.ok) return nodeCheck;

  // Merged-settings check (#1400 Round 3 finding 2 / AC8): `disableAllHooks`
  // in EITHER file disables this guard regardless of what is wired, and
  // settings.local.json alone would never show a flag set only in the
  // shared settings.json.
  const merged = mergedSettingsState(primary);
  if (merged.disableAllHooks) {
    return { ok: false, detail: 'disableAllHooks is set in the merged settings hierarchy '
      + '(.claude/settings.json or settings.local.json) — every hook, including this guard, is '
      + 'disabled regardless of what is wired' };
  }
  if (!merged.entries.some((e) => isGuardEntry(e))) {
    // Reached only if settings.local.json's own PreToolUse array (already
    // confirmed wired, or `command` would be null before `selfTest` is even
    // called) somehow disagrees with what `mergedSettingsState` reads from
    // the SAME file — defensive insurance against future drift between the
    // two readers, not a case this file's own code can currently produce.
    return { ok: false, detail: 'this guard\'s entry is wired in settings.local.json but does not '
      + 'appear in the merged PreToolUse hierarchy across .claude/settings.json and '
      + 'settings.local.json' };
  }

  const statusFile = statusFilePath(primary);
  const before = readStatus(statusFile);

  // AC8's own text: "Proof that the hook is on the live route must come
  // from a heartbeat the engine's own invocation produced, never from one
  // the self-test caused. A check that cannot be made is a failure, not a
  // skip." (#1400 Round 4 finding 1 — Round 3's `runEngineEnvelopeProbe`
  // violated exactly this by having self-test manufacture an engine-shaped
  // heartbeat itself; removed rather than patched.) Self-test may only
  // check for EXISTING proof — it must fail closed, not skip the check,
  // when none exists yet.
  if (!(before.engineInvocations > 0 && before.lastEngineHeartbeatAt)) {
    return { ok: false, detail: 'no genuine, engine-produced PreToolUse heartbeat has been observed '
      + 'yet (engineInvocations is 0) — self-test cannot manufacture that proof itself (#1400 AC8); '
      + 'this is a failure, not a skip, until real tool-call traffic reaches the guard at least once' };
  }

  const refused = runProbe(command, primary, path.join(primary, 'server.js'), true);
  if (!refused.ok) return refused;

  const allowed = runProbe(command, primary, path.join(primary, 'package.json'), false);
  if (!allowed.ok) return allowed;

  const after = readStatus(statusFile);
  // Self-test's OWN probes must never move `engineInvocations`, whatever
  // shape their payload takes — the explicit proof, not just an inference
  // from `runProbe` always setting `PROBE_ENV`.
  if (after.engineInvocations !== before.engineInvocations) {
    return { ok: false, detail: 'self-test\'s own probes advanced engineInvocations, which must '
      + 'never happen — self-test traffic is never genuine traffic (#1400 AC8)' };
  }
  const advanced = after.selfTest.counts.total > before.selfTest.counts.total
    && after.selfTest.lastAt && after.selfTest.lastAt !== before.selfTest.lastAt;
  if (!advanced) {
    return { ok: false, detail: 'the wired command ran and decided correctly, but the liveness '
      + `heartbeat at ${statusFile} did not advance — the self-test cannot prove the outer runner `
      + 'is the one actually live on this path' };
  }

  try {
    updateStatus(primary, (status) => {
      status.selfTest.lastSuccessfulAt = new Date().toISOString();
    });
  } catch (err) { // prawduct:allow prawduct/broad-except -- a failed success-stamp write must not fail an otherwise-passing self-test; `--status`'s crash-since-last-success check degrades gracefully to "never" rather than wrongly.
    process.stderr.write(`install-primary-guard: could not stamp self-test success: ${boundedErrorCode(err)}\n`);
  }

  return { ok: true, detail: 'the wired command refused a write to the live surface, allowed an '
    + 'ordinary one, a genuine engine heartbeat was already on record, and the liveness heartbeat '
    + 'advanced' };
}

/**
 * Confirm the node binary this process would re-spawn as the inner guard
 * (`runInner`) actually runs, BEFORE `selfTest` drives any probe through it
 * (#1400 Round 2 finding 5).
 *
 * @returns {{ok:boolean, detail:string}}
 */
function checkNodeResolvable() {
  try {
    execFileSync(process.execPath, ['--version'], { encoding: 'utf8' });
    return { ok: true, detail: '' };
  } catch (err) {
    return { ok: false, detail: `the node binary this runner would re-spawn as the inner guard `
      + `could not be invoked: ${boundedErrorCode(err)}` };
  }
}

/**
 * Drive the wired command once with a synthetic PreToolUse payload and check
 * the decision matches what is expected.
 *
 * @param {string} command - The wired command string.
 * @param {string} primary - Absolute primary checkout root.
 * @param {string} filePath - Payload `tool_input.file_path`. Never actually
 *   written — the guard only reads the payload to decide.
 * @param {boolean} expectDeny - True for the refusal case, false for the allow case.
 * @returns {{ok:boolean, detail:string}}
 */
function runProbe(command, primary, filePath, expectDeny) {
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath }, cwd: primary });
  let stdout;
  try {
    stdout = execFileSync('/bin/sh', ['-c', command], {
      input: payload,
      encoding: 'utf8',
      env: {
        ...process.env, CLAUDE_PROJECT_DIR: primary, TANGLECLAW_ALLOW_PRIMARY_WRITE: '', [PROBE_ENV]: '1'
      }
    });
  } catch (err) {
    return { ok: false, detail: `the wired command failed to run: ${err.message}` };
  }
  if (expectDeny) {
    if (!stdout.trim()) {
      return { ok: false, detail: `the wired command produced NO decision for a write to ${filePath} `
        + `— it should have refused. A sentinel at ${path.join(primary, OVERRIDE_FILE)} would also `
        + 'explain this.' };
    }
    try {
      const parsed = JSON.parse(stdout);
      const d = parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision;
      if (d !== 'deny') return { ok: false, detail: `decision was ${JSON.stringify(d)}, not "deny"` };
    } catch (err) {
      return { ok: false, detail: `the wired command emitted unparseable output: ${stdout.slice(0, 200)}` };
    }
    return { ok: true, detail: '' };
  }
  if (stdout.trim()) {
    return { ok: false, detail: `the wired command REFUSED an ordinary write to ${filePath}, which `
      + `should have been allowed: ${stdout.slice(0, 200)}` };
  }
  return { ok: true, detail: '' };
}

/**
 * Entry point.
 *
 * @param {string[]} argv - Process arguments after the script name.
 * @returns {number} Process exit code.
 */
function main(argv) {
  // `--invoke` is the wired entrypoint, not a human-facing mode: it is reached
  // on every real tool call, must never depend on the checks below (which are
  // about the INSTALL, not the hook firing), and must always return 0.
  if (argv.includes('--invoke')) return invoke();

  const located = locateCheckouts(path.join(__dirname, '..'));
  if (!located) {
    process.stderr.write('install-primary-guard: could not locate the primary checkout\n');
    return 1;
  }
  const primary = located.primary;

  // `--status` can and should answer even when the guard script is currently
  // missing or stale — that absence is exactly the kind of thing worth
  // reporting on, not a precondition to enforce first.
  if (argv.includes('--status') || argv.includes('--json')) {
    return reportStatus(primary, argv.includes('--json'));
  }

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

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) { // prawduct:allow prawduct/broad-except -- the operator runs this over ssh from the arming runbook; a raw stack trace with no file named is not an answer they can act on. The message is printed, never swallowed.
    process.stderr.write(`install-primary-guard: ${err && err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  main, apply, isGuardEntry, guardCommand, guardEntries, wiredCommand, pinnedScript, selfTest,
  readSettings, writeSettings, GUARD_REL, WRITE_MATCHER, INSTALLER_REL, PROBE_ENV, STATUS_ENV,
  STATUS_BASENAME, statusFilePath, readStatus, writeStatusAtomic, defaultStatus, emptyCounts,
  recordInvocation, recordInvocationStart, runInner, invoke, boundedErrorCode, commitActivitySignal,
  updateActivityAndWarn, reportStatus, isOwnScriptPath, acquireLock, releaseLock, updateStatus,
  reclaimStalePending, newPendingId, sharedSettingsHookConflicts, checkNodeResolvable,
  INNER_TIMEOUT_ENV, PENDING_STALE_ENV, LOCK_SUFFIX, LOCK_MAX_WAIT_ENV, lockMaxWaitMs,
  outerFailureSentinelPath, foldOuterFailureSentinelLocked, OUTER_FAILURE_BASENAME,
  looksLikeEngineEnvelope, isGenuineEngineInvocation, tolerantReadSettings, mergedSettingsState
};
