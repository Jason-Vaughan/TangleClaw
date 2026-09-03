'use strict';

/**
 * Startup rules delivery channel (#749).
 *
 * Operator rules used to ride inside the session prime. That put them in
 * competition with everything else the prime carries — directives, resume
 * state, a feature index — inside a single hook's output, and the engine's
 * cap on that output is enforced by REPLACING the payload with a short
 * preview, not by shortening it. On this repo the rules lost that competition
 * and the agent booted having read part of rule 1 and none of rules 2-4.
 *
 * The fix is not a smaller prime. It is a second channel: rules get their own
 * startup hook with its own allowance, so the two can no longer displace each
 * other, and neither one's growth can harm the other.
 *
 * Where the corpus outgrows one channel it is SHARDED across further hooks of
 * the same kind rather than trimmed — every rule the operator wrote is
 * delivered, and each shard says which slice of the whole it carries so a
 * missing one is visible in what did arrive.
 *
 * This module is deliberately shared by `lib/sessions.js` (which renders and
 * writes the payloads) and `lib/engines.js` (which registers the hooks that
 * read them). `engines` cannot require `sessions` — `sessions` already
 * requires `engines` — so the logic they both need lives here rather than
 * being duplicated on each side and drifting.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./logger');

const log = createLogger('session-rules-channel');

/** Basename stem for a shard payload, suffixed `-<n>.json`. */
const SHARD_STEM = 'session-rules';

/**
 * Fallback channel budget, in characters, for an engine that declares none.
 * Mirrors the historical `PRIME_MAX_TOKENS * 4`; kept here so both the prime
 * and the rules channel resolve budgets through one implementation rather than
 * two that can drift apart.
 */
const FALLBACK_CHANNEL_CHARS = 16000;

/**
 * Resolve the character budget for a startup-injection channel.
 *
 * The limit belongs to the CONSUMER, not to TangleClaw: each engine declares
 * what its startup channel carries via `capabilities.startupInjection.maxChars`.
 * Hard-coding one engine's number would silently impose it on every other.
 *
 * The declared value is an UPSTREAM fact about that engine's harness, so it
 * drifts when the harness changes. Claude Code's 10,000-character hook-output
 * cap was verified against its hooks reference on 2026-07-28. If directives or
 * rules start disappearing again, re-verify that number at the source before
 * tuning anything here — a test comparing this repo against this repo cannot
 * detect that kind of drift (tracked as ENG-7Q3M).
 *
 * @param {object|null} engineProfile - Engine profile; may be null or partial.
 * @param {object} [options]
 * @param {boolean} [options.viaStartupHook=true] - Whether the payload rides
 *   the engine's startup hook. A prime pasted into the terminal never passes
 *   through that hook and must not inherit its limit.
 * @returns {number} Positive character budget.
 */
function resolveChannelBudget(engineProfile, options = {}) {
  if (options.viaStartupHook === false) return FALLBACK_CHANNEL_CHARS;

  const injection = engineProfile
    && engineProfile.capabilities
    && engineProfile.capabilities.startupInjection;
  if (!injection || injection.maxChars === undefined) return FALLBACK_CHANNEL_CHARS;

  const declared = injection.maxChars;
  if (Number.isFinite(declared) && declared > 0) return declared;

  // Declared but unusable. Falling back silently would leave an operator who
  // typo'd the value believing a limit is in force that is not — the same
  // "believed delivered, actually wasn't" failure this module exists to end.
  log.warn('Engine declares an unusable startupInjection.maxChars — ignoring it', {
    engine: engineProfile && engineProfile.id,
    declared,
    using: FALLBACK_CHANNEL_CHARS
  });
  return FALLBACK_CHANNEL_CHARS;
}

/**
 * Reserve for the per-shard header and the JSON envelope, so a shard sized at
 * the channel budget cannot overflow it once wrapped.
 */
const SHARD_OVERHEAD = 320;

/**
 * Split rules into shards that each fit the channel budget.
 *
 * Splits only on rule boundaries: half a rule is worse than a missing one,
 * because it reads as complete. A rule that cannot fit a shard on its own gets
 * a shard to itself and is delivered whole — the engine may still clip it, but
 * that is visible in the shard's own header, whereas silently dropping it is
 * not.
 *
 * Ordering is by rule id, which is stable across launches, so the same corpus
 * always produces the same split. An unstable split would change what each
 * session receives for no reason the operator could see.
 *
 * @param {Array<{id:number, content:string}>} rules - Active startup rules.
 * @param {number} maxChars - Character budget for one channel.
 * @returns {Array<{index:number,total:number,ruleIds:number[],body:string}>}
 *   Empty when there is nothing deliverable.
 */
function buildShards(rules, maxChars) {
  const usable = (rules || [])
    .filter((r) => r && r.content && r.content.trim())
    .slice()
    .sort((a, b) => a.id - b.id);
  if (usable.length === 0) return [];

  const budget = Math.max(1, (Number.isFinite(maxChars) ? maxChars : 0) - SHARD_OVERHEAD);
  const groups = [];
  let current = [];
  let currentLen = 0;

  for (const rule of usable) {
    const entry = `- ${rule.content.trim()}`;
    const cost = entry.length + 1;
    if (current.length > 0 && currentLen + cost > budget) {
      groups.push(current);
      current = [];
      currentLen = 0;
    }
    current.push({ id: rule.id, entry });
    currentLen += cost;
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, i) => ({
    index: i + 1,
    total: groups.length,
    ruleIds: group.map((g) => g.id),
    body: group.map((g) => g.entry).join('\n')
  }));
}

/**
 * Render one shard as the text the engine will insert into the session.
 * @param {object} shard - From `buildShards`.
 * @param {number} ruleTotal - Total active rules across all shards.
 * @returns {string}
 */
function renderShardText(shard, ruleTotal) {
  const lines = [];
  lines.push('## Project Rules');
  lines.push('');
  // The header states the slice even when there is only one, so "part 1 of 1"
  // and "part 1 of 3" read the same way and a missing shard is obvious.
  const first = shard.ruleIds.length > 0 ? (shard.index === 1 ? 1 : null) : null;
  const scope = shard.total === 1
    ? `all ${ruleTotal}`
    : `part ${shard.index} of ${shard.total}`;
  lines.push(
    `Operator-authored rules for this project (${scope}). They apply for the whole `
    + 'session and are binding — read them before acting.'
  );
  if (shard.total > 1 && first === null) {
    lines.push('');
    lines.push(`_(Rules continue from part ${shard.index - 1}.)_`);
  }
  lines.push('');
  lines.push(shard.body);
  lines.push('');
  return lines.join('\n');
}

/**
 * Wrap shard text in the hook-output envelope the engine consumes.
 *
 * `additionalContext` rather than plain stdout: accumulation across several
 * hooks on the same event is documented for `additionalContext` specifically,
 * and this channel exists alongside the prime's own hook. Relying on stdout to
 * accumulate the same way would be an inference at the exact point where being
 * wrong is silent.
 *
 * TangleClaw writes the finished JSON to disk and the hook only `cat`s it, so
 * no shell script ever has to escape operator-authored prose.
 *
 * @param {string} text - Shard text.
 * @returns {string} JSON payload, newline-terminated.
 */
function renderShardPayload(text) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: text
    }
  }) + '\n';
}

/**
 * Absolute path of a shard payload within a project.
 * @param {string} projectPath - Project root.
 * @param {number} index - 1-based shard index.
 * @returns {string}
 */
function shardPath(projectPath, index) {
  return path.join(projectPath, '.tangleclaw', `${SHARD_STEM}-${index}.json`);
}

/**
 * Remove every shard payload from a project, including ones a previous launch
 * wrote and this one does not.
 *
 * A stale shard is worse than a missing one: it is a live hook delivering a
 * rule set the operator has since changed, and nothing in the session would
 * indicate the text is old.
 *
 * @param {string} projectPath - Project root.
 * @param {number} [keepThrough=0] - Keep shards 1..keepThrough; prune the rest.
 * @returns {number} Count removed.
 */
function pruneShards(projectPath, keepThrough = 0) {
  const dir = path.join(projectPath, '.tangleclaw');
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0; // no .tangleclaw dir yet — nothing to prune
  }
  const pattern = new RegExp(`^${SHARD_STEM}-(\\d+)\\.json$`);
  for (const name of entries) {
    const m = name.match(pattern);
    if (!m) continue;
    if (Number(m[1]) <= keepThrough) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch (err) {
      log.warn('Failed to prune a stale rules shard', { file: name, error: err.message });
    }
  }
  return removed;
}

/**
 * Write shard payloads for a project and prune any left from a larger set.
 * @param {string} projectPath - Project root.
 * @param {Array<object>} shards - From `buildShards`.
 * @param {number} ruleTotal - Total active rules.
 * @returns {{written:number, pruned:number, paths:string[]}}
 */
function writeShards(projectPath, shards, ruleTotal) {
  const dir = path.join(projectPath, '.tangleclaw');
  const paths = [];
  let written = 0;
  if (shards.length > 0) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const shard of shards) {
    const file = shardPath(projectPath, shard.index);
    fs.writeFileSync(file, renderShardPayload(renderShardText(shard, ruleTotal)));
    paths.push(file);
    written += 1;
  }
  const pruned = pruneShards(projectPath, shards.length);
  return { written, pruned, paths };
}

/** Filename of the receipt token, beside the shards in `.tangleclaw/`. */
const RECEIPT_STEM = 'session-rules-receipt';

/**
 * Absolute path of a project's receipt token.
 * @param {string} projectPath - Project root.
 * @returns {string}
 */
function receiptTokenPath(projectPath) {
  return path.join(projectPath, '.tangleclaw', `${RECEIPT_STEM}.json`);
}

/**
 * Write the token the rules hook posts back to prove it ran (#1063).
 *
 * The delivery row's own id is the key. The alternative — matching on the rule
 * digest — cannot tell two launches of the same project with the same rule set
 * apart, which is the common case, so a receipt from a session that started an
 * hour ago would upgrade the row belonging to the one starting now. An id
 * cannot be ambiguous, and a stale token points at a row `markDelivered`
 * already refuses to touch.
 *
 * The token is a launch-local pointer, not a credential: it names a row that
 * exists and carries no authority beyond flipping `written` → `delivered`. It
 * is rewritten on every launch, lives beside the shards it describes, and the
 * hook deletes it on a successful post (a failed post leaves it, so a genuine
 * retry still works).
 *
 * Consumption handles the ordinary case and NOT the one that matters: when this
 * session's hook never ran, nothing was posted and nothing was consumed, so the
 * token stands — exactly while the row is still `written`, which is the only
 * state a receipt can act on. What bounds that replay is the freshness window
 * enforced server-side in `store.sessionRuleDeliveries.markDelivered`, where a
 * file on a session's disk cannot reach it. See that function for the residual
 * this leaves.
 *
 * @param {string} projectPath - Project root.
 * @param {{deliveryId: number, api: string}} token - Row id and the API base
 *   the hook should post to.
 * @returns {string|null} The path written, or `null` if it could not be written
 *   (the caller proceeds — a missing token costs a receipt, never a launch).
 */
function writeReceiptToken(projectPath, token) {
  const file = receiptTokenPath(projectPath);
  try {
    fs.mkdirSync(path.join(projectPath, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      deliveryId: token.deliveryId,
      api: token.api
    }) + '\n');
    return file;
  } catch (err) {
    log.warn('Failed to write the rules-hook receipt token — the delivery will stay written', {
      file, error: err.message
    });
    return null;
  }
}

/**
 * Remove a project's receipt token.
 *
 * A token outliving the launch that wrote it points at a row from a previous
 * session, so every path that does NOT write one clears the old one instead of
 * leaving it to be posted by the next hook that runs.
 *
 * @param {string} projectPath - Project root.
 * @returns {boolean} Whether a token was removed.
 */
function clearReceiptToken(projectPath) {
  const file = receiptTokenPath(projectPath);
  try {
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    log.warn('Failed to clear a stale rules-hook receipt token', { file, error: err.message });
    return false;
  }
}

/**
 * Count shards a project's rules currently require, without writing anything.
 * @param {Array<{id:number, content:string}>} rules - Active startup rules.
 * @param {number} maxChars - Channel budget.
 * @returns {number}
 */
function shardCount(rules, maxChars) {
  return buildShards(rules, maxChars).length;
}

module.exports = {
  SHARD_STEM,
  RECEIPT_STEM,
  receiptTokenPath,
  writeReceiptToken,
  clearReceiptToken,
  SHARD_OVERHEAD,
  FALLBACK_CHANNEL_CHARS,
  resolveChannelBudget,
  buildShards,
  renderShardText,
  renderShardPayload,
  shardPath,
  pruneShards,
  writeShards,
  shardCount
};
