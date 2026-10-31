'use strict';

/**
 * Codex model-vs-auth-mode pre-flight check (#260).
 *
 * Codex auto-migrates between models over time (`gpt-5.3-codex` ->
 * `gpt-5.4`, retired from ChatGPT sign-in 2026-08-31; `gpt-5.5`, retired
 * 2026-10-14), and ChatGPT-sign-in auth has historically lagged API-key
 * auth on model availability. A configured model Codex no longer serves
 * under the user's auth mode fails every prompt with a raw 400 from the
 * OpenAI API rather than anything TangleClaw surfaces — this module exists
 * to warn before that happens, not to prevent it (non-blocking).
 *
 * Both signals are read conservatively, not from the obvious-looking source:
 *
 * - Auth mode comes from `codex login status` — the CLI's own documented,
 *   token-free status command — never from `auth.json`'s contents. Codex's
 *   credential storage is controlled by `cli_auth_credentials_store`
 *   (`file` / `keyring` / `auto` / `ephemeral`), so `auth.json`'s presence
 *   does not even reliably indicate the active method, and its own docs
 *   warn against handling that file's contents at all.
 * - `~/.codex/models_cache.json` was read directly against a real
 *   installation (not assumed) to check whether it carries a per-model,
 *   auth-mode-specific availability flag it could serve as a live signal.
 *   It does not: each entry carries `supported_in_api` (API-key
 *   eligibility) with no equivalent ChatGPT-sign-in flag, so it cannot
 *   answer "is this unsupported under ChatGPT auth specifically." The dated
 *   table below is therefore the sole mechanism for that question — not a
 *   fallback behind a cache signal that turned out not to exist.
 *
 * Unknown stays unknown: every branch that cannot be determined with
 * confidence returns `null`, never a guessed warning.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createLogger } = require('../logger');

const log = createLogger('codex-preflight');

/**
 * The model-vs-auth incompatibilities known at the time this table was
 * checked against Codex's own docs. This WILL go stale — Codex ships model
 * migrations on a timescale of weeks, not quarters — so it is kept
 * intentionally small, and every entry is dated and sourced rather than
 * extended on assumption.
 *
 * Verified against https://learn.chatgpt.com/docs/models on 2026-10-31:
 *   `gpt-5.4`, `gpt-5.4-mini` — retired from ChatGPT sign-in 2026-08-31
 *   `gpt-5.5`                 — retired from ChatGPT sign-in 2026-10-14
 * That page states API-key auth is unaffected by either retirement, so
 * this table is consulted only when auth mode is confidently `'chatgpt'`.
 * Re-verify against the live page before extending this table — do not
 * add an entry from memory or inference.
 */
const KNOWN_CHATGPT_SIGNIN_RETIRED = {
  'gpt-5.4': '2026-08-31',
  'gpt-5.4-mini': '2026-08-31',
  'gpt-5.5': '2026-10-14'
};

/** How long a resolved auth-mode read is trusted before re-checking (#260 build review: a status poll at the default 5s interval must not spawn `codex` on every tick). */
const AUTH_STATUS_CACHE_TTL_MS = 60000;

/** How long `codex login status` is given to answer before it is treated as unknown. */
const AUTH_STATUS_TIMEOUT_MS = 2000;

let _authStatusCache = { value: null, atMs: -Infinity };

/** Test seam: discard the cached auth-mode read. */
function _clearAuthStatusCache() {
  _authStatusCache = { value: null, atMs: -Infinity };
}

/**
 * Codex's config/data home.
 * @returns {string}
 */
function _codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * The model Codex is configured to use, from `config.toml`'s top-level
 * `model` key.
 *
 * A minimal line scan, not a TOML parser: this project carries no
 * third-party dependencies, and only one flat top-level key is needed.
 * Stops at the first `[section]` header, so a `model` key nested under a
 * table — none exists in the file today, but nothing guarantees that is
 * permanent — is never mistaken for the global setting. Never throws: a
 * missing or unreadable file, or a file with no such key, is `null`.
 *
 * @param {string} codexHome
 * @returns {string|null}
 */
function readCodexConfigModel(codexHome) {
  let text;
  try {
    text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    const m = /^model\s*=\s*"([^"]*)"/.exec(trimmed);
    if (m) return m[1] || null;
  }
  return null;
}

/**
 * Parse `codex login status`'s stdout into the mode it reports.
 * @param {string} output
 * @returns {'chatgpt'|'apikey'|null}
 */
function _parseAuthStatus(output) {
  const text = String(output || '');
  if (/logged in using chatgpt/i.test(text)) return 'chatgpt';
  if (/logged in using api key/i.test(text)) return 'apikey';
  return null; // "Not logged in", unrecognized output, or empty.
}

/**
 * Codex's currently active auth mode, via the CLI's own status command —
 * never by reading `auth.json`. Cached for `AUTH_STATUS_CACHE_TTL_MS`: this
 * is read from a session-status poll at the default 5s interval, and a
 * synchronous subprocess on every tick would both slow the poll and spawn
 * Codex repeatedly for no reason. Measured on a real installation:
 * `spawnSync('codex', ['login', 'status'])` takes ~90ms; bounded by the
 * cache to at most once per `AUTH_STATUS_CACHE_TTL_MS`, this keeps the poll
 * responsive while still noticing an auth change within one TTL window.
 *
 * @param {object} [options]
 * @param {function} [options.spawnSyncFn] - Injected for tests.
 * @param {boolean} [options.force] - Bypass the cache (tests only).
 * @returns {'chatgpt'|'apikey'|null}
 */
function readCodexAuthMode(options = {}) {
  const spawn = options.spawnSyncFn || spawnSync;
  const now = Date.now();
  if (!options.force && (now - _authStatusCache.atMs) < AUTH_STATUS_CACHE_TTL_MS) {
    return _authStatusCache.value;
  }
  let result;
  try {
    result = spawn('codex', ['login', 'status'], { timeout: AUTH_STATUS_TIMEOUT_MS, encoding: 'utf8' });
  } catch (err) {
    log.warn('codex-preflight: codex login status threw', { error: err.message });
    result = null;
  }
  if (result && result.error) {
    log.warn('codex-preflight: codex login status failed', { error: result.error.message });
  }
  const value = (result && !result.error && result.status === 0)
    ? _parseAuthStatus(result.stdout)
    : null;
  _authStatusCache = { value, atMs: now };
  return value;
}

/**
 * Whether the configured Codex model is known to be unsupported under the
 * detected auth mode. `compatible: false` only on a confident, dated,
 * sourced match against `KNOWN_CHATGPT_SIGNIN_RETIRED` — every other case
 * (auth mode unknown, model unknown, model not in that table, or
 * `codex login status` failed) is `null`, never a guessed warning.
 *
 * @param {object} [options]
 * @param {string} [options.codexHome]
 * @param {function} [options.spawnSyncFn] - Injected for tests.
 * @param {boolean} [options.force] - Bypass the auth-mode cache (tests only).
 * @returns {{compatible: boolean|null, model: string|null, authMode: 'chatgpt'|'apikey'|null, reason: string|null}}
 */
function checkCodexModelCompatibility(options = {}) {
  const codexHome = options.codexHome || _codexHome();
  const model = readCodexConfigModel(codexHome);
  const authMode = readCodexAuthMode(options);
  if (!model || authMode !== 'chatgpt') {
    return { compatible: null, model, authMode, reason: null };
  }
  const retiredAt = KNOWN_CHATGPT_SIGNIN_RETIRED[model];
  if (!retiredAt) {
    return { compatible: null, model, authMode, reason: null };
  }
  return {
    compatible: false,
    model,
    authMode,
    reason: `${model} retired from Codex ChatGPT sign-in on ${retiredAt} (learn.chatgpt.com/docs/models, verified 2026-10-31); API-key auth is unaffected.`
  };
}

/**
 * Map a compatibility result to the shape a session-status payload serves
 * (and the banner renders), or `null` on every path that is not a
 * confirmed incompatibility.
 *
 * @param {{compatible: boolean|null, model: string|null, authMode: string|null, reason: string|null}|null|undefined} result
 * @returns {{model: string, authMode: string|null, reason: string}|null}
 */
function toCodexModelWarning(result) {
  if (!result || result.compatible !== false) return null;
  return { model: result.model, authMode: result.authMode, reason: result.reason };
}

module.exports = {
  _codexHome,
  _clearAuthStatusCache,
  AUTH_STATUS_CACHE_TTL_MS,
  KNOWN_CHATGPT_SIGNIN_RETIRED,
  readCodexConfigModel,
  readCodexAuthMode,
  checkCodexModelCompatibility,
  toCodexModelWarning
};
