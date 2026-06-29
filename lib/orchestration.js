'use strict';

/**
 * TB-1 (#357) — Launch-binder orchestration resolver.
 *
 * Resolves `project → orchestration profile → (base_url, key_ref, model)` at
 * session launch and produces a launch-time overlay onto an engine profile,
 * so an engine can be pointed at a different OpenAI-compatible endpoint
 * (LiteLLM `direct`, a future `smart-fallback` group, a `semantic-route`
 * LangGraph host) PER PROJECT without editing the global engine config.
 *
 * All functions here are pure: I/O (reading a key file) is delegated through
 * injected `deps`, so the resolver is unit-testable without touching disk.
 * The secret itself is never stored by TC — only a key REFERENCE — and is
 * resolved at launch, so a rotated key is picked up with no TC config change.
 * Full master-key retirement is TB-2 (#189); TB-1 lays the field + resolver.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Expand a leading `~` to the user's home directory.
 * @param {string} p - A filesystem path possibly starting with `~`.
 * @returns {string} The expanded path.
 */
function _expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a key reference (`file:<path>` or `env:<NAME>`) to its secret value.
 * @param {string|null} keyRef - Reference, e.g. `file:~/.config/monad/x.key` or `env:OPENAI_API_KEY`.
 * @param {object} [deps] - Injected for testability.
 * @param {(p: string) => string} [deps.readFile] - Reads a file to a string (defaults to fs.readFileSync utf8).
 * @param {object} [deps.env] - Environment map (defaults to process.env).
 * @returns {{ value: string }|{ error: string }} The resolved secret, or a typed error.
 */
function resolveKeyRef(keyRef, deps = {}) {
  const env = deps.env || process.env;
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));

  if (typeof keyRef !== 'string' || keyRef.length === 0) {
    return { error: 'missing keyRef' };
  }
  const sep = keyRef.indexOf(':');
  if (sep === -1) {
    return { error: `malformed keyRef (expected file:<path> or env:<NAME>): ${keyRef}` };
  }
  const scheme = keyRef.slice(0, sep);
  const rest = keyRef.slice(sep + 1);

  if (scheme === 'env') {
    const v = env[rest];
    if (!v) return { error: `env var not set: ${rest}` };
    return { value: v };
  }
  if (scheme === 'file') {
    let raw;
    try {
      raw = readFile(_expandHome(rest));
    } catch (err) {
      return { error: `key file unreadable: ${rest} (${err.message})` };
    }
    const v = String(raw).trim();
    if (!v) return { error: `key file empty: ${rest}` };
    return { value: v };
  }
  return { error: `unknown keyRef scheme "${scheme}" (expected file: or env:)` };
}

/**
 * Resolve a project's launch-time orchestration profile into concrete values.
 *
 * Returns one of:
 *  - `null` — the project has no binding (today's behavior; zero injection).
 *  - `{ refused: true, reason, profileName }` — bound but NOT injectable
 *    (unknown profile, `null` baseUrl for a not-yet-landed endpoint, missing
 *    model, or an unresolvable keyRef). The caller logs and launches with NO
 *    injection — honest degradation, never a silent fallback to a different
 *    endpoint.
 *  - `{ baseUrl, model, apiKey, profileName }` — fully resolved.
 *
 * @param {object} project - Project record (reads `orchestrationProfile`).
 * @param {object} projConfig - Per-project config blob (reads optional `orchestrationKeyRef` override).
 * @param {object} profilesConfig - Parsed orchestration-profiles.json (`{ profiles: {...} }`).
 * @param {object} [deps] - Injected for testability (passed through to resolveKeyRef).
 * @param {Function} [deps.resolveKeyRef] - Override the key resolver (defaults to this module's).
 * @returns {null|{refused:true,reason:string,profileName:string}|{baseUrl:string,model:string,apiKey:string,profileName:string}}
 */
function resolveLaunchProfile(project, projConfig, profilesConfig, deps = {}) {
  const profileName = project && project.orchestrationProfile;
  if (!profileName) return null;

  const profiles = (profilesConfig && profilesConfig.profiles) || {};
  const profile = profiles[profileName];
  if (!profile) {
    return { refused: true, reason: `unknown profile "${profileName}"`, profileName };
  }
  if (!profile.baseUrl) {
    return {
      refused: true,
      reason: `profile "${profileName}" has no baseUrl (endpoint not yet landed)`,
      profileName
    };
  }
  if (!profile.model) {
    return { refused: true, reason: `profile "${profileName}" has no model`, profileName };
  }

  // Per-(project,profile) key override wins over the profile's default keyRef
  // (isolated metering / budget / revocation for a project that needs its own key).
  const keyRef = (projConfig && projConfig.orchestrationKeyRef) || profile.keyRef;
  const resolveRef = deps.resolveKeyRef || resolveKeyRef;
  const keyResult = resolveRef(keyRef, deps);
  if (keyResult.error) {
    return {
      refused: true,
      reason: `key unresolved for "${profileName}": ${keyResult.error}`,
      profileName
    };
  }

  return {
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: keyResult.value,
    profileName
  };
}

/**
 * Produce a SHALLOW CLONE of an engine profile with the resolved orchestration
 * values overlaid onto `launch.args` (`--model <model>`) and `launch.env`
 * (`OPENAI_API_BASE`, `OPENAI_API_KEY`).
 *
 * NEVER mutates the input. The engine profile object is shared/cached by the
 * store, so in-place mutation would leak the injected key + model into every
 * later launch of that engine (including other projects). The clone is used
 * for one launch only.
 *
 * @param {object} engineProfile - Base engine profile (with `.launch`).
 * @param {{baseUrl:string,model:string,apiKey:string}} resolved - Output of resolveLaunchProfile.
 * @returns {object} A new engine-profile object safe to use for this launch only.
 */
function applyLaunchOverlay(engineProfile, resolved) {
  const baseLaunch = engineProfile.launch || {};
  const baseArgs = Array.isArray(baseLaunch.args) ? baseLaunch.args : [];
  const baseEnv = baseLaunch.env || {};
  return {
    ...engineProfile,
    launch: {
      ...baseLaunch,
      args: [...baseArgs, '--model', resolved.model],
      env: {
        ...baseEnv,
        OPENAI_API_BASE: resolved.baseUrl,
        OPENAI_API_KEY: resolved.apiKey
      }
    }
  };
}

/**
 * Master-key footgun detector (TB-2 #189).
 *
 * The sanctioned way to deliver a LiteLLM / OpenAI-compatible secret to a
 * harness is an orchestration-profile `keyRef` (file:/env:), resolved at launch
 * by resolveKeyRef and overlaid onto the launch env for ONE launch only — the
 * secret is never written into an engine config file. Therefore any LiteLLM-
 * shaped key LITERAL sitting in an engine config's static `launch.env` is the
 * footgun #189 describes: a hardcoded, unscoped, often master-level credential
 * inherited by every session that launches that engine.
 *
 * Scans a STATIC engine profile (pre-overlay): scanning the post-overlay env
 * would flag the legitimately-resolved scoped key, which is exactly what we want
 * to allow. NEVER throws and NEVER blocks a launch — the caller logs. Pure (no
 * I/O, no logging). Flagged secret values are REDACTED so the guard's own output
 * cannot leak them.
 *
 * @param {object} engineProfile - A base engine profile (with `.launch.env`), pre-overlay.
 * @returns {Array<{envVar:string, reason:string, redacted:string}>} Findings (empty = clean).
 */
function detectHardcodedKeys(engineProfile) {
  const env = (engineProfile && engineProfile.launch && engineProfile.launch.env) || {};
  const findings = [];
  // LiteLLM / OpenAI secret keys are `sk-` + a long random tail. Scoped keys
  // share the shape, but a properly-delivered scoped key is never a literal in a
  // config (it arrives via a keyRef) — so any sk-* literal here is the footgun.
  const keyShape = /^sk-[A-Za-z0-9_-]{16,}$/;
  for (const [envVar, rawValue] of Object.entries(env)) {
    const value = typeof rawValue === 'string' ? rawValue : '';
    if (!value) continue;
    if (envVar === 'LITELLM_MASTER_KEY') {
      findings.push({
        envVar,
        reason: 'LITELLM_MASTER_KEY is hardcoded in launch.env — use an orchestration-profile keyRef',
        redacted: _redactSecret(value)
      });
      continue;
    }
    if (keyShape.test(value)) {
      findings.push({
        envVar,
        reason: 'value is a hardcoded LiteLLM-shaped key literal — use an orchestration-profile keyRef',
        redacted: _redactSecret(value)
      });
    }
  }
  return findings;
}

/**
 * Redact a secret to a short, non-recoverable hint (prefix + length only).
 * @param {string} value - The secret string.
 * @returns {string} e.g. `sk-ab…(redacted, 51 chars)`.
 */
function _redactSecret(value) {
  const prefix = value.slice(0, 5);
  return `${prefix}…(redacted, ${value.length} chars)`;
}

module.exports = { resolveKeyRef, resolveLaunchProfile, applyLaunchOverlay, detectHardcodedKeys };
