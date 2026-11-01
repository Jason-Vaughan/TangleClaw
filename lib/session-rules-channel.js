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
const { displayRuleText } = require('./rule-label');
const { isUsableRule } = require('./launch-rule-drift');

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
    .filter(isUsableRule)
    .slice()
    .sort((a, b) => a.id - b.id);
  if (usable.length === 0) return [];

  const budget = Math.max(1, (Number.isFinite(maxChars) ? maxChars : 0) - SHARD_OVERHEAD);
  const groups = [];
  let current = [];
  let currentLen = 0;

  for (const rule of usable) {
    // Labelled from the DB id (#2029), exactly as the inline prime renders it.
    const entry = `- ${displayRuleText(rule)}`;
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

/**
 * The sentence a rewritten block carries so a reader can settle a disagreement.
 * The prime and the re-entry text state a rule count written at launch; a block
 * rewritten after a rule change can differ from it, and without this the reader
 * has two numbers and no way to tell which is stale.
 */
const CURRENT_STATEMENT = 'This block was rewritten when the rules last changed and is the current '
  + 'statement: where a count elsewhere in this session differs, this one is right.';

/**
 * Name the rules a block could not carry, shortened to `shown` names.
 * @param {number[]} ids - Rule ids left out of the block.
 * @param {number} shown - How many to name before summarising the rest.
 * @returns {string}
 */
function _omittedNames(ids, shown) {
  const named = ids.slice(0, shown).map((id) => `Rule #${id}`);
  const rest = ids.length - named.length;
  if (rest > 0) named.push(named.length > 0 ? `and ${rest} more` : `${rest} of them`);
  return named.join(', ');
}

/**
 * Render one slot of a rewritten rule set.
 *
 * Kept apart from `renderShardText`, which is the launch's rendering and must
 * not move: a rewritten block says more (the count in force, when it was
 * written, and which rules it could not carry), and the launch says none of it.
 *
 * @param {object} slot
 * @param {number} slot.index - 1-based slot number.
 * @param {number} slot.total - Slots in the set.
 * @param {string[]} slot.entries - Rendered rule lines, in order.
 * @param {number[]} slot.omittedIds - Rules in force this set does not print.
 * @param {number} [slot.namedCount] - How many omitted ids to name (default all).
 * @param {{ruleTotal:number, writtenAt:string}} ctx - Rules in force, and when.
 * @returns {string}
 */
function _renderRefreshedText(slot, ctx) {
  const omitted = slot.omittedIds || [];
  let scope = `part ${slot.index} of ${slot.total}`;
  if (slot.total === 1) {
    scope = omitted.length === 0 ? `all ${ctx.ruleTotal}` : `${slot.entries.length} of ${ctx.ruleTotal}`;
  }
  const lines = [
    '## Project Rules',
    '',
    `Operator-authored rules for this project (${scope}). They apply for the whole `
      + 'session and are binding — read them before acting.',
    '',
    `_Rules in force: ${ctx.ruleTotal}, as of ${ctx.writtenAt}. ${CURRENT_STATEMENT}_`
  ];
  if (slot.index > 1) {
    lines.push('', `_(Rules continue from part ${slot.index - 1}.)_`);
  }
  if (slot.entries.length > 0) lines.push('', slot.entries.join('\n'));
  if (omitted.length > 0) {
    const shown = slot.namedCount === undefined ? omitted.length : slot.namedCount;
    lines.push(
      '',
      `**Rules in force: ${ctx.ruleTotal}. Not carried in this block: ${_omittedNames(omitted, shown)}.** `
        + 'Each binds this session all the same; run `tc rules` for their text.'
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Fill up to `limit` slots with whole rules, in order.
 * @param {Array<{id:number, entry:string}>} entries - Rendered rules, by id.
 * @param {number} limit - Most slots to fill.
 * @param {function(Array<object>, number): boolean} fits - Whether a group
 *   fits the slot at the given 1-based index.
 * @returns {{groups: Array<Array<object>>, rest: Array<object>}} `rest` holds
 *   what was not placed: a rule too large for a slot of its own, and everything
 *   after the last slot filled up.
 */
function _fillSlots(entries, limit, fits) {
  const groups = [];
  const rest = [];
  let current = [];
  for (const entry of entries) {
    if (groups.length >= limit) { rest.push(entry); continue; }
    if (fits([...current, entry], groups.length + 1)) { current.push(entry); continue; }
    if (current.length === 0) { rest.push(entry); continue; }
    groups.push(current);
    current = [];
    if (groups.length < limit && fits([entry], groups.length + 1)) current.push(entry);
    else rest.push(entry);
  }
  if (current.length > 0) groups.push(current);
  return { groups, rest };
}

/**
 * Pack a rule set into a FIXED number of slots, naming what does not fit.
 *
 * `buildShards` answers "how many channels does this set need" and is right at
 * launch, when the hooks are registered to match. After launch the number of
 * channels is whatever was registered, so the question inverts: given this many
 * slots, what can each carry. Three things differ from the launch's packing:
 *
 * - The number of slots never exceeds `slots`. A rule set that outgrew them is
 *   not trimmed silently: the last slot names every rule it could not carry,
 *   gives the count in force, and points at `tc rules`.
 * - No slot exceeds the budget. The engine enforces its cap by replacing an
 *   oversized payload with a preview, which loses the whole block, so a rule
 *   too large for a slot of its own is named rather than printed. Sizes are
 *   measured on the finished payload, not estimated.
 * - Each slot states the count in force and when it was written.
 *
 * @param {Array<{id:number, content:string}>} rules - Rules in force.
 * @param {number} maxChars - Character budget for one slot's payload.
 * @param {number} slots - Slots available.
 * @param {{writtenAt:string}} options - When the set is being written.
 * @returns {Array<{index:number,total:number,ruleIds:number[],omittedIds:number[],text:string}>}
 *   Empty when there is no slot or nothing deliverable (see `renderNoRulesText`).
 */
function packFixedSlots(rules, maxChars, slots, options) {
  const entries = (rules || [])
    .filter(isUsableRule)
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((r) => ({ id: r.id, entry: `- ${displayRuleText(r)}` }));
  if (entries.length === 0 || !Number.isInteger(slots) || slots < 1) return [];

  const ctx = { ruleTotal: entries.length, writtenAt: options.writtenAt };
  // Measured against the largest `total` the header can state, so a set that
  // ends up using fewer slots can only come out shorter than what was measured.
  const render = (group, index, total, omittedIds, namedCount) => _renderRefreshedText({
    index, total, entries: group.map((g) => g.entry), omittedIds, namedCount
  }, ctx);
  const within = (text) => renderShardPayload(text).length <= maxChars;
  const fitsPlain = (group, index) => within(render(group, index, slots, []));

  let { groups, rest } = _fillSlots(entries, slots, fitsPlain);
  if (rest.length === 0) {
    return groups.map((group, i) => ({
      index: i + 1,
      total: groups.length,
      ruleIds: group.map((g) => g.id),
      omittedIds: [],
      text: render(group, i + 1, groups.length, [])
    }));
  }

  // Something does not fit. Keep the last slot for the line that says so, and
  // print in it as many of the remaining rules as still leave room for the line.
  ({ groups, rest } = _fillSlots(entries, slots - 1, fitsPlain));
  const lastIndex = groups.length + 1;
  const last = [];
  for (const candidate of rest) {
    const trial = [...last, candidate];
    const left = rest.filter((r) => !trial.includes(r)).map((r) => r.id);
    if (within(render(trial, lastIndex, slots, left))) last.push(candidate);
  }
  const omittedIds = rest.filter((r) => !last.includes(r)).map((r) => r.id);
  // A list of names long enough to break the budget on its own is shortened
  // rather than allowed to cost the block: the count still says how many.
  let namedCount = omittedIds.length;
  while (namedCount > 0 && !within(render(last, lastIndex, slots, omittedIds, namedCount))) {
    namedCount -= 1;
  }

  const total = lastIndex;
  const packed = groups.map((group, i) => ({
    index: i + 1,
    total,
    ruleIds: group.map((g) => g.id),
    omittedIds: [],
    text: render(group, i + 1, total, [])
  }));
  packed.push({
    index: lastIndex,
    total,
    ruleIds: last.map((g) => g.id),
    omittedIds,
    text: render(last, lastIndex, total, omittedIds, namedCount)
  });
  return packed;
}

/**
 * Render the block for a project whose last rule in force has gone.
 *
 * The block is kept rather than removed because the prime tells the session
 * that a missing "Project Rules" block means delivery failed. An empty rule set
 * is a correct state, and deleting the file would make it read as a failure.
 *
 * @param {{writtenAt:string}} options - When the block is being written.
 * @returns {string}
 */
function renderNoRulesText(options) {
  return [
    '## Project Rules',
    '',
    `No operator-authored rule is in force for this project, as of ${options.writtenAt}. `
      + `${CURRENT_STATEMENT} \`tc rules\` confirms it.`,
    ''
  ].join('\n');
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
  shardCount,
  packFixedSlots,
  renderNoRulesText
};
