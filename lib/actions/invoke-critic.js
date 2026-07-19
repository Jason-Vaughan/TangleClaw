'use strict';

/**
 * `invoke-critic` action handler — spawns an Independent Critic
 * review and records its findings, or falls back to ack-only mode
 * when real invocation isn't possible (no active session, unsupported
 * engine).
 *
 * Originally (#139 Chunk 11b) this was ack-only: it appended an entry
 * to `.tangleclaw/critic-runs.json` so a wrap gate could detect that an
 * operator had run the Critic externally. That mismatched operator
 * expectation (the "Run Critic" button should run the Critic); #267
 * closed the gap. The wrap gate itself is gone (#570 — governance moved
 * to the Prawduct plugin), so the file is now a branch-keyed audit
 * record of dispatches rather than input to any gate.
 *
 * **Two execution paths:**
 *
 * 1. **Real invocation (preferred when supported):** Send `/critic`
 *    via tmux to the active Claude session, poll for AI idle, read
 *    structured findings from `.prawduct/.critic-findings.json` (the
 *    Critic skill's documented output path per
 *    `.claude/skills/critic/SKILL.md:39`), append a `ranAt: "actual"`
 *    entry to `.tangleclaw/critic-runs.json` with the findings.
 *
 * 2. **Ack-only fallback:** When the real path is unavailable
 *    (engine != Claude, no active session, tmux send fails, idle
 *    timeout, findings file missing/malformed), append a
 *    `ranAt: "ack"` entry without findings, so the audit record still
 *    shows that a dispatch was attempted on this branch.
 *
 * **Schema for `.tangleclaw/critic-runs.json` entries (additive):**
 *   `{branchName: string, timestamp: ISO string, ranAt?: "actual"|"ack",
 *     criticFindingsRef?: string, findings?: Array<object>}`
 *
 * Old entries without `ranAt` are treated as `"ack"` by readers.
 *
 * **Engine matrix (deferred to Chunk 12 of ADR 0002):** Real invocation
 * currently assumes Claude as the active engine. Gemini/Codex/etc.
 * sessions fall through to ack-only with a `degradedEngine` reason in
 * the returned `output.fallbackReason` so the UI can surface it.
 *
 * **Concurrent-write race.** Single-process Node, no `await` between
 * load and write of critic-runs.json. Atomic temp+rename guarantees
 * readers see either pre-write or post-write content, never partial.
 *
 * **Containment.** `project.path` is the only filesystem-rooting input;
 * the handler refuses an empty path and never writes outside
 * `<project.path>/.tangleclaw/`. The findings-file READ at
 * `<project.path>/.prawduct/.critic-findings.json` is bounded to the
 * project root by the same path construction.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createLogger } = require('../logger');

const log = createLogger('actions:invoke-critic');

const CRITIC_RUNS_RELPATH = path.join('.tangleclaw', 'critic-runs.json');
const CRITIC_FINDINGS_RELPATH = path.join('.prawduct', '.critic-findings.json');

// Real-invocation timing constants. Mirror lib/wrap-steps/ai-content.js
// values so behavior is consistent with the wrap pipeline's Critic
// dispatch path. A standalone "Run Critic" button click and a wrap-time
// Critic dispatch are the same operation under the hood; using
// different timeouts would surface as inconsistent operator experience.
const INITIAL_SETTLE_MS = 3000;
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 min cap — matches ai-content.js
const CRITIC_COMMAND = '/critic';

/**
 * Internal seam dictionary — tests override these to inject behavior
 * without monkey-patching require cache. Production code paths never
 * mutate `_internal` after module load.
 */
const _internal = {
  sendKeys: null,    // (tmuxSession, text, {enter}) => void; resolved lazily
  detectIdle: null,  // (tmuxSession) => {idle: boolean, ...}; resolved lazily
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  resolveBranch: defaultResolveBranchName,
  readFile: fs.readFileSync,
  fileExists: fs.existsSync
};

/**
 * Resolve the current git branch in `cwd`. Returns `null` for detached
 * HEAD, non-repo, missing git, or any other failure.
 * @param {string} cwd
 * @returns {string|null}
 */
function defaultResolveBranchName(cwd) {
  try {
    const out = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    }).trim();
    if (!out || out === 'HEAD') return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * Read existing critic-runs.json into an array. Tolerant of missing
 * file, malformed JSON, non-array root — all yield `[]`.
 * @param {string} filePath
 * @returns {object[]}
 */
function loadExisting(filePath) {
  if (!fs.existsSync(filePath)) return [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    log.warn('failed to read critic-runs.json before append', { filePath, error: err.message });
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('critic-runs.json malformed; rebuilding from empty', { filePath, error: err.message });
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Read and parse `.prawduct/.critic-findings.json`. Returns the parsed
 * object on success, or `null` if missing/unreadable/malformed. The
 * Critic skill writes this file as part of its protocol; absence after
 * a `/critic` dispatch means the Critic didn't complete cleanly.
 * @param {string} findingsPath
 * @returns {object|null}
 */
function _readCriticFindings(findingsPath) {
  if (!_internal.fileExists(findingsPath)) return null;
  let raw;
  try {
    raw = _internal.readFile(findingsPath, 'utf8');
  } catch (err) {
    log.warn('failed to read critic-findings.json', { findingsPath, error: err.message });
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.warn('critic-findings.json malformed', { findingsPath, error: err.message });
    return null;
  }
}

/**
 * Atomically write the updated critic-runs entries array. Temp+rename
 * pattern guarantees readers see either pre-write or post-write, never
 * a partial file.
 * @param {string} filePath
 * @param {object[]} entries
 * @throws on filesystem failure
 */
function _atomicWriteRuns(filePath, entries) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2) + '\n', { encoding: 'utf8' });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* tmp may not exist */ }
    throw err;
  }
}

/**
 * Attempt the real-Critic-invocation path. Sends `/critic` via tmux,
 * polls for AI idle, reads the findings file. Returns
 * `{ok: true, findings, rawSummary}` on success or
 * `{ok: false, reason}` on any failure (caller falls back to ack-only).
 *
 * @param {object} project - {path, name}
 * @param {object} session - {tmuxSession, engine}
 * @returns {Promise<{ok: boolean, findings?: object[], rawSummary?: string, reason?: string}>}
 */
async function _attemptRealInvocation(project, session) {
  if (!session || !session.tmuxSession) {
    return { ok: false, reason: 'noActiveSession' };
  }

  // Engine check — matrix support deferred (ADR 0002 Chunk 12).
  // The production session record from `store.sessions.getActive`
  // surfaces the engine identifier as `engineId` (see
  // `_rowToSession` in lib/store.js). Test-injected stubs sometimes
  // use `engine` (legacy/shorthand) or `engineProfile.id` (older
  // record shape). Probe all three to be robust to the input shape;
  // any value other than `'claude'` (including engine prefixes like
  // `openclaw:<connection>`) is treated as degraded — only the
  // literal Claude Code engine has the `/critic` skill that this
  // dispatch path depends on.
  const engine = session.engineId
    || session.engine
    || (session.engineProfile && session.engineProfile.id)
    || null;
  if (engine !== 'claude') {
    return { ok: false, reason: `degradedEngine:${engine || 'unknown'}` };
  }

  // Lazy-resolve tmux/sessions to avoid eager module-load cycle —
  // `lib/sessions.js` requires this module indirectly via the action
  // dispatcher's load path. Mirrors `lib/wrap-steps/ai-content.js:51`
  // rationale.
  if (!_internal.sendKeys) {
    _internal.sendKeys = require('../tmux').sendKeys;
  }
  if (!_internal.detectIdle) {
    _internal.detectIdle = require('../sessions').detectIdle;
  }

  try {
    _internal.sendKeys(session.tmuxSession, CRITIC_COMMAND, { enter: true });
  } catch (err) {
    log.warn('failed to send /critic via tmux', { tmuxSession: session.tmuxSession, error: err.message });
    return { ok: false, reason: 'tmuxSendFailed' };
  }

  log.info('invoke-critic dispatched /critic', { project: project.name, tmuxSession: session.tmuxSession });

  const startedAt = Date.now();
  await _internal.sleep(INITIAL_SETTLE_MS);

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    let idleInfo;
    try {
      idleInfo = _internal.detectIdle(session.tmuxSession);
    } catch (err) {
      log.warn('detectIdle threw during /critic poll', { error: err.message });
      return { ok: false, reason: 'idleDetectFailed' };
    }
    if (idleInfo && idleInfo.idle) break;
    await _internal.sleep(POLL_INTERVAL_MS);
  }

  if (Date.now() - startedAt >= MAX_WAIT_MS) {
    return { ok: false, reason: 'idleTimeout' };
  }

  // AI went idle — read findings file
  const findingsPath = path.join(project.path, CRITIC_FINDINGS_RELPATH);
  const parsedFindings = _readCriticFindings(findingsPath);
  if (!parsedFindings) {
    return { ok: false, reason: 'noFindingsFile' };
  }

  // The Critic's documented output (per .claude/skills/critic/SKILL.md
  // and .prawduct/critic-review.md) writes `{mode, mode_chosen_by,
  // findings: [...]}`. Defensive — accept a plain array as a fallback
  // shape; the wrap pipeline's reader is similarly tolerant.
  let findingsArray = [];
  if (Array.isArray(parsedFindings)) {
    findingsArray = parsedFindings;
  } else if (Array.isArray(parsedFindings.findings)) {
    findingsArray = parsedFindings.findings;
  }

  return {
    ok: true,
    findings: findingsArray,
    rawSummary: parsedFindings
  };
}

/**
 * Append a critic-run entry for `project`. The handler tries the real-
 * invocation path first; on any failure, falls back to ack-only mode so
 * the run is still recorded and the session UI can surface its findings.
 *
 * @param {{path: string, name?: string}} project
 * @param {object} [options]
 * @param {string} [options.branchName] - Pre-resolved branch (tests).
 * @param {object} [options.session] - Active session record
 *   `{tmuxSession, engine}`; when omitted or lacking `tmuxSession`,
 *   handler falls back to ack-only. The dispatcher in
 *   `lib/actions.js` is responsible for looking this up.
 * @param {() => Date} [options.now] - Time-injection seam (tests).
 * @param {boolean} [options.ackOnly] - Skip real invocation, write ack
 *   directly. Used by tests and by the wrap pipeline for back-compat.
 * @returns {Promise<{ok: boolean, output: object|null, error: string|null}>}
 */
async function run(project, options = {}) {
  if (!project || typeof project.path !== 'string' || !project.path.trim()) {
    return { ok: false, output: null, error: 'invoke-critic requires a non-empty project.path' };
  }

  const branchName = (typeof options.branchName === 'string' && options.branchName.trim())
    ? options.branchName.trim()
    : _internal.resolveBranch(project.path);

  if (!branchName) {
    return {
      ok: false,
      output: null,
      error: 'could not resolve current git branch (detached HEAD, not a git repo, or git missing)'
    };
  }

  const tangleclawDir = path.join(project.path, '.tangleclaw');
  const filePath = path.join(tangleclawDir, 'critic-runs.json');

  try {
    fs.mkdirSync(tangleclawDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      output: null,
      error: `failed to create .tangleclaw directory: ${_redactProjectPath(err.message, project.path)}`
    };
  }

  // Try real invocation unless tests/wrap-pipeline forced ack-only
  let realResult = { ok: false, reason: 'skipped' };
  let mode = 'ack';
  let findings = [];
  let criticFindingsRef = null;
  let fallbackReason = null;

  if (!options.ackOnly) {
    realResult = await _attemptRealInvocation(project, options.session || null);
    if (realResult.ok) {
      mode = 'actual';
      findings = realResult.findings;
      criticFindingsRef = CRITIC_FINDINGS_RELPATH;
    } else {
      fallbackReason = realResult.reason;
    }
  }

  const now = typeof options.now === 'function' ? options.now() : _internal.now();
  const entry = {
    branchName,
    timestamp: now.toISOString(),
    ranAt: mode
  };
  if (criticFindingsRef) {
    entry.criticFindingsRef = criticFindingsRef;
  }
  if (findings.length > 0) {
    entry.findings = findings;
  }

  const existing = loadExisting(filePath);
  const updated = existing.concat([entry]);

  try {
    _atomicWriteRuns(filePath, updated);
  } catch (err) {
    return {
      ok: false,
      output: null,
      error: `failed to write critic-runs.json: ${_redactProjectPath(err.message, project.path)}`
    };
  }

  log.info('invoke-critic recorded critic run', {
    project: project.name,
    branchName,
    mode,
    findingCount: findings.length,
    totalRuns: updated.length,
    ...(fallbackReason ? { fallbackReason } : {})
  });

  return {
    ok: true,
    output: {
      entry,
      mode,
      findings,
      findingCount: findings.length,
      totalRuns: updated.length,
      filePath: CRITIC_RUNS_RELPATH,
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(realResult.rawSummary ? { criticSummary: realResult.rawSummary } : {})
    },
    error: null
  };
}

/**
 * Replace absolute `projectPath` occurrences in an error message with
 * the literal `<project>` placeholder so server filesystem layout
 * doesn't leak through the HTTP API.
 *
 * @param {string} message
 * @param {string} projectPath
 * @returns {string}
 */
function _redactProjectPath(message, projectPath) {
  if (typeof message !== 'string' || !projectPath) return message;
  return message.split(projectPath).join('<project>');
}

module.exports = {
  run,
  loadExisting,
  defaultResolveBranchName,
  CRITIC_RUNS_RELPATH,
  CRITIC_FINDINGS_RELPATH,
  _redactProjectPath,
  _internal // exposed for tests
};
