'use strict';

/**
 * Bounded startup-rules receipt watcher & re-delivery coordinator (#1176).
 *
 * `lib/session-rules-channel.js` upgrades a `rules-hook` delivery from
 * `written` to `delivered` only when the SessionStart hook itself posts a
 * receipt (#1063). A hook that never fires leaves the row `written` forever,
 * with nothing watching for that — the exact silent-channel shape #759 and
 * #1063 exist to end. This module is that watch: for every live session whose
 * most recent rules-hook delivery is still `written` once the session has
 * stood active past a grace window, it disambiguates why (#1150) and, only
 * when nothing local explains the silence, re-delivers the rules a bounded
 * number of times through a caller-supplied open channel.
 *
 * **Sandbox loopback disambiguation (#1150).** The hook's receipt POST and
 * "the hook ran at all" are not the same fact: a managed sandbox that blocks
 * loopback networking (the exact shape #1150 reports for Codex) makes a
 * healthy hook's `curl` fail for a reason that has nothing to do with whether
 * the rules reached the engine — `cat`, which is what actually puts the rules
 * in front of the model, runs and succeeds either way. Treating "no receipt"
 * as "the channel is silent" in that case would re-deliver rules the engine
 * already has, and would misreport a healthy session as broken, which is
 * exactly the false-outage failure #1150 was filed over.
 *
 * The receipt token's mere PRESENCE is not that evidence (PRR-B Round 1
 * correction): `lib/sessions.js` writes it, via
 * `session-rules-channel.js#writeReceiptToken`, BEFORE the engine even
 * starts — so a token that still names this delivery is the shape of EVERY
 * session between launch and its hook's first run, not just the ones whose
 * hook never fires at all. The one piece of local evidence that actually
 * proves the hook ran is a marker ON the token itself (`hookFiredAt`, or
 * `loopbackRefused` for the #1150 case specifically) that a local hook run
 * would stamp before attempting its receipt POST. A token with neither
 * marker, however long it has stood, is simply a session whose hook never
 * ran — the ordinary case this watcher exists to catch — and proceeds to
 * re-delivery like a missing token would. Only a token CARRYING one of those
 * markers withholds re-delivery, because only then does local evidence say
 * the rules already reached the engine.
 *
 * (The writer side of that marker — stamping `hookFiredAt`/`loopbackRefused`
 * into the token from the hook script itself — is a separate, disjoint
 * change (tracked outside this module's own file scope); this module reads
 * for the marker regardless of whether anything yet writes it, so it fails
 * safe — toward re-delivery, never toward silently trusting a stale
 * presence-only token — either way.)
 *
 * **Bounded attempts, durable count (PRR-A Round 3 WARNING 1).** Each
 * attempt is logged to `activity_log` (`EVENT_ATTEMPT`) unconditionally, and
 * the COUNT a later pass bounds against is derived by counting those rows
 * for `(sessionId, deliveryId)` — durable across a server restart, no
 * schema change, and deliberately not a new `session_rule_deliveries` row
 * (see `_durableAttemptCount`'s own doc for why that specific idea does not
 * work). Only the cooldown's `lastAttemptAt` stays in-memory: losing it to a
 * restart costs at most one bounded attempt slightly early, never one past
 * `maxAttempts`, which the durable count alone already guarantees.
 * `deliverViaOpenChannel` defaults to `_defaultDeliverViaOpenChannel` (a
 * tmux pane paste, via `lib/tmux.js#sendKeys`) when a caller does not supply
 * one — tests still override it via `deps.deliverViaOpenChannel` to assert
 * on the attempt without touching a real pane.
 *
 * **A successful paste is not confirmation (PRR-A Round 3 BLOCKING 3).** The
 * only fact that ends the watch for a delivery is its OWN ledger row's
 * `outcome` reaching `'delivered'` — the hook's real receipt, whenever it
 * eventually lands, re-checked fresh at the top of every pass
 * (`_isActuallyDelivered`). A paste that lands is recorded honestly as sent,
 * not confirmed, and the watcher keeps re-checking on later passes (bounded
 * by the durable attempt count above) until either that happens or attempts
 * run out.
 *
 * **Never pastes into a busy pane (PRR-A Round 3 BLOCKING 2).** Before any
 * attempt, `deps.isPaneSafeToDeliver(sessionId)` — when supplied — must
 * answer `true`; production wiring (`lib/activity-observer.js`) supplies
 * one built from its own already-ticked idle/at-rest record, never a fresh
 * capture of its own. A caller that supplies none (most of this module's own
 * tests) is unchanged — the gate is opt-in, the same pattern
 * `deliverViaOpenChannel` already uses.
 */

const fs = require('node:fs');
const { createLogger } = require('./logger');
const store = require('./store');
const rulesChannel = require('./session-rules-channel');
const tmux = require('./tmux');

const log = createLogger('rule-receipt-redelivery');

/** How long a session must have been observed active before its `written` row is judged. */
const DEFAULT_GRACE_MS = 5 * 60 * 1000;

/** Bounded re-delivery attempts per delivery row before giving up. */
const DEFAULT_MAX_ATTEMPTS = 2;

/** Minimum spacing between re-delivery attempts for the same delivery row. */
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

/** `activity_log` event_type for one re-delivery attempt. */
const EVENT_ATTEMPT = 'session.rule_redelivery_attempt';

/** `activity_log` event_type for a delivery that exhausted its attempts unconfirmed. */
const EVENT_EXHAUSTED = 'session.rule_redelivery_exhausted';

/** Per-delivery attempt bookkeeping: deliveryId -> {count, lastAttemptAt, exhausted}. */
const _attempts = new Map();

/**
 * Test seam: drop all in-memory attempt bookkeeping.
 * @returns {void}
 */
function _resetAttemptState() {
  _attempts.clear();
}

/**
 * Read the local rules-hook receipt token for a project and say whether it
 * still names the given delivery, and whether it carries local evidence the
 * hook actually ran (PRR-B Round 1 correction, #1176): the token's mere
 * presence is written by `lib/sessions.js` before the engine even starts, so
 * presence alone proves nothing about whether the hook later fired. Only an
 * explicit `hookFiredAt`/`loopbackRefused` marker ON the token is that
 * evidence — see the module doc.
 * @param {string} projectPath - Project checkout root.
 * @param {number} deliveryId - The `session_rule_deliveries` row id to match.
 * @returns {{exists: boolean, matches: boolean, hookFiredAt: (string|null), loopbackRefused: boolean, readError?: string, parseError?: string}}
 *   `readError` is present only when the token could not be read for a
 *   reason other than it simply not existing (`ENOENT`); `parseError` only
 *   when it was read but was not valid JSON (PRR-A Round 3 WARNING 3) — both
 *   are failures to answer the question, never "no evidence either way".
 */
function probeLocalReceipt(projectPath, deliveryId) {
  const file = rulesChannel.receiptTokenPath(projectPath);
  const empty = { exists: false, matches: false, hookFiredAt: null, loopbackRefused: false };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return empty;
    // A real read failure (EACCES, EIO, …) is not "no token" — it is "the
    // question is unanswerable right now," which must fail closed rather
    // than read as the all-clear a missing file legitimately is.
    log.warn('Failed to read the rules-hook receipt token while disambiguating a written delivery', {
      file, error: err.message
    });
    return { ...empty, readError: err.code || 'ERR' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Same fail-closed posture as a read error, not "exists but no match"
    // (WARNING 3): a token this process cannot actually parse is a token it
    // cannot rule either way, and the old `matches: false` reading let
    // `classifyWrittenDelivery` treat it as 'superseded' — silently correct
    // by accident, never by evidence.
    log.warn('Rules-hook receipt token is not valid JSON', { file, error: err.message });
    return { exists: true, matches: false, hookFiredAt: null, loopbackRefused: false, parseError: err.message };
  }
  const matches = Number(parsed && parsed.deliveryId) === Number(deliveryId);
  return {
    exists: true,
    matches,
    hookFiredAt: matches && parsed && parsed.hookFiredAt ? String(parsed.hookFiredAt) : null,
    loopbackRefused: !!(matches && parsed && parsed.loopbackRefused)
  };
}

/**
 * Classify one `written` rules-hook delivery row against the local receipt
 * token, disambiguating "nothing has explained the silence yet" from "this
 * row is simply stale" (#1150).
 * @param {{id: number}} delivery - A `rules-hook`/`written` delivery row.
 * @param {string} projectPath - The project's checkout root.
 * @param {object} [deps]
 * @param {(projectPath: string, deliveryId: number) => ReturnType<typeof probeLocalReceipt>} [deps.probeLocalReceipt]
 * @returns {{status: 'local-receipt-pending'|'superseded'|'needs-redelivery'|'token-read-error'|'token-parse-error', reason: string}}
 */
function classifyWrittenDelivery(delivery, projectPath, deps = {}) {
  const probe = deps.probeLocalReceipt || probeLocalReceipt;
  const receipt = probe(projectPath, delivery.id);
  if (receipt.readError) {
    return {
      status: 'token-read-error',
      reason: `the rules-hook receipt token could not be read (${receipt.readError}) — failing closed rather `
        + 'than risking a spurious re-delivery, or trusting a token this process cannot actually see'
    };
  }
  if (receipt.parseError) {
    // WARNING 3 (PRR-A Round 3): malformed JSON used to read as "exists,
    // doesn't match" and fall through to 'superseded' — accidentally safe,
    // not evidence-based. Same fail-closed door as a read error.
    return {
      status: 'token-parse-error',
      reason: `the rules-hook receipt token exists but is not valid JSON (${receipt.parseError}) — failing closed `
        + 'rather than guessing at a token this process cannot actually read the shape of'
    };
  }
  if (receipt.exists && receipt.matches) {
    // PRR-B Round 1 BLOCKING: presence-and-match alone used to be read as
    // "the hook may have run, withhold re-delivery" — but `writeReceiptToken`
    // writes this token BEFORE the engine starts, so presence-and-match is
    // also exactly what a hook that never fired at all looks like. Only a
    // marker proving local execution withholds re-delivery now.
    if (receipt.hookFiredAt || receipt.loopbackRefused) {
      return {
        status: 'local-receipt-pending',
        reason: receipt.loopbackRefused
          ? 'the rules-hook ran locally and printed the rules, but its receipt POST was refused by a sandboxed '
            + 'loopback (#1150) — the channel is not silent, only the receipt is, so this is not re-delivered'
          : `the rules-hook ran locally at ${receipt.hookFiredAt} and the receipt token is still awaiting a `
            + 'successful POST — local evidence says the channel already reached the engine, so this is not '
            + 're-delivered yet'
      };
    }
    return {
      status: 'needs-redelivery',
      reason: 'the receipt token still names this delivery, but carries no evidence the hook ever actually ran '
        + '(no hookFiredAt/loopbackRefused marker) — this is the ordinary shape of a hook that never fired, the '
        + 'same as no token at all, not an open question (#1176 PRR-B Round 1 correction)'
    };
  }
  if (receipt.exists && !receipt.matches) {
    return {
      status: 'superseded',
      reason: 'a newer launch has overwritten the receipt token with a different delivery id; this row belongs '
        + 'to a session that is no longer the one being primed'
    };
  }
  return {
    status: 'needs-redelivery',
    reason: 'no local receipt token exists for this delivery and the grace window has elapsed'
  };
}

/**
 * The production open channel (PRR-B Round 1 BLOCKING 2; pane-safety
 * narrowed in PRR-A Round 3 BLOCKING 2): paste the rules straight into the
 * session's own tmux pane via `lib/tmux.js#sendKeys`, rendered exactly as
 * the rules-hook channel itself renders them (`lib/session-rules-channel.js`'s
 * shard renderer), so what the engine sees from a re-delivery reads the same
 * as what it would have seen from the hook.
 *
 * Resolving means only "the paste was sent", never "the engine consumed the
 * rules" (PRR-A Round 3 BLOCKING 3) — `_processOne` records this as an
 * attempt, not a confirmation; only the delivery ledger's own `outcome`
 * upgrading to `'delivered'` (the hook's real receipt, whenever it lands) is
 * that. Throwing (`sendKeys` does, on a missing/blocked pane) is how this
 * reports a FAILED attempt.
 *
 * `clearPrompt: false` (PRR-A Round 3 BLOCKING 2): a redelivery is a
 * best-effort reminder landing in a pane `_processOne` already verified is
 * idle via `deps.isPaneSafeToDeliver` before ever calling this — clearing
 * the prompt line is how `sendKeys` protects against wiping an in-progress
 * DRAFT for a send that expects one might be sitting there, which does not
 * apply here; passing `false` is this call owning the cost of its own
 * gate having already run, not reopening the question `sendKeys` answers
 * for calls that have no such gate of their own.
 *
 * Called as `tmux.sendKeys(...)` (a property read at call time, never
 * destructured at load time) so a test can replace `tmux.sendKeys` itself
 * (`mock.method`) without this module needing its own injectable seam for it.
 *
 * @param {{sessionId: number, projectId: number, rules: object[], attempt: number}} entry
 * @returns {Promise<void>}
 * @throws {Error} When the session has no tmux pane to paste into, or
 *   `tmux.sendKeys` itself throws (missing pane, startup dialog blocking it, …).
 */
async function _defaultDeliverViaOpenChannel(entry) {
  const session = store.sessions.get(entry.sessionId);
  if (!session || !session.tmuxSession) {
    throw new Error(`rule-receipt-redelivery: session ${entry.sessionId} has no tmux pane to deliver through`);
  }
  const budget = rulesChannel.resolveChannelBudget(null, { viaStartupHook: false });
  const shards = rulesChannel.buildShards(entry.rules, budget);
  const text = shards.length > 0
    ? shards.map((shard) => rulesChannel.renderShardText(shard, entry.rules.length)).join('\n\n')
    : rulesChannel.renderNoRulesText({ writtenAt: new Date().toISOString() });
  tmux.sendKeys(session.tmuxSession, text, { engineId: session.engineId, clearPrompt: false, enter: true });
}

/**
 * Every live session whose most recent rules-hook delivery is still `written`.
 * @returns {Array<{delivery: object, session: object}>}
 */
function _defaultListCandidates() {
  const candidates = [];
  for (const session of store.sessions.listLiveAll()) {
    const deliveries = store.sessionRuleDeliveries.listForSession(session.id);
    const latest = deliveries[deliveries.length - 1];
    if (latest && latest.channel === 'rules-hook' && latest.outcome === 'written') {
      candidates.push({ delivery: latest, session });
    }
  }
  return candidates;
}

/**
 * Parse a SQLite `datetime('now')` timestamp (UTC, no zone marker) the same
 * way `store/session-rules.js#markDelivered` does, so grace-window math agrees
 * with the server-side freshness window that already governs this ledger.
 * @param {string} value
 * @returns {number} Milliseconds since epoch, or `NaN` if unparseable.
 */
function _parseSqliteUtc(value) {
  return Date.parse(`${String(value).replace(' ', 'T')}Z`);
}

/**
 * This delivery row's CURRENT outcome, read fresh from the ledger (PRR-A
 * Round 3 BLOCKING 3) — never trusted from the possibly several-passes-stale
 * `delivery` object a caller's `listCandidates` handed in. The only
 * legitimate "this is actually resolved" signal is the row's own `outcome`
 * reaching `'delivered'` (the hook's real receipt, whenever it eventually
 * lands); a successful open-channel paste is never that signal.
 * @param {number} sessionId
 * @param {number} deliveryId
 * @returns {boolean|null} `true` once genuinely delivered, `false` while
 *   still not, or `null` when the store cannot answer (no store initialized)
 *   — treated by the caller as "no new information", never as "delivered".
 */
function _isActuallyDelivered(sessionId, deliveryId) {
  try {
    const rows = store.sessionRuleDeliveries.listForSession(sessionId);
    const row = rows.find((r) => r.id === deliveryId);
    return row ? row.delivered : false;
  } catch (err) {
    return null;
  }
}

/**
 * This delivery's attempt count, durable across a server restart (PRR-A
 * Round 3 WARNING 1): derived by counting this module's own
 * `EVENT_ATTEMPT` activity-log rows already written for
 * `(sessionId, deliveryId)` — no schema change, and deliberately NOT a new
 * `session_rule_deliveries` row: that table's `channel` CHECK constraint has
 * no slot for "redelivery attempt", and a new row there would also corrupt
 * `_defaultListCandidates`, which reads a session's MOST RECENT delivery row
 * to find a candidate in the first place — an attempt-tracking row would
 * make itself the newest row and hide the very `written` delivery it was
 * tracking.
 *
 * Only the COUNT is durable this way; `lastAttemptAt` (cooldown spacing)
 * stays in the in-memory `_attempts` Map, same posture the module doc
 * already states for it: losing that across a restart costs at most one
 * attempt slightly early, never a bound-exceeding one, because the bound is
 * on COUNT, which this does make durable.
 *
 * Falls back to the in-memory `_attempts` Map's own count when the store
 * cannot answer at all (no store initialized — a bare unit-test call with
 * no store); `durable: false` says which source answered.
 * @param {number} deliveryId
 * @param {number} sessionId
 * @returns {{count: number, alreadySurfacedExhaustion: boolean, durable: boolean}}
 */
function _durableAttemptCount(deliveryId, sessionId) {
  try {
    const byThisDelivery = (r) => r.detail && Number(r.detail.deliveryId) === Number(deliveryId);
    const attempts = store.activity.query({ sessionId, eventType: EVENT_ATTEMPT, limit: 1000 }).filter(byThisDelivery);
    const exhaustions = store.activity.query({ sessionId, eventType: EVENT_EXHAUSTED, limit: 50 }).filter(byThisDelivery);
    return { count: attempts.length, alreadySurfacedExhaustion: exhaustions.length > 0, durable: true };
  } catch (err) {
    const mem = _attempts.get(deliveryId);
    return { count: mem ? mem.count : 0, alreadySurfacedExhaustion: mem ? !!mem.exhausted : false, durable: false };
  }
}

/**
 * Surface an exhausted delivery: log it to the activity feed, warn, and run
 * the caller's optional escalation callback. Never throws.
 * @param {object} delivery
 * @param {object} session
 * @param {object} project
 * @param {{count: number}} state
 * @param {object} deps
 * @param {string|null} [reason]
 * @returns {void}
 */
function _surfaceExhaustion(delivery, session, project, state, deps, reason) {
  store.activity.log({
    projectId: project.id,
    sessionId: session.id,
    eventType: EVENT_EXHAUSTED,
    detail: { deliveryId: delivery.id, attempts: state.count, exhausted: true, reason: reason || null }
  });
  log.warn('Rules-hook receipt never confirmed after bounded re-delivery — session may be running undelivered rules', {
    deliveryId: delivery.id, sessionId: session.id, projectId: project.id, attempts: state.count
  });
  if (typeof deps.onExhausted === 'function') {
    try {
      deps.onExhausted({
        sessionId: session.id, projectId: project.id, deliveryId: delivery.id,
        attempts: state.count, reason: reason || null
      });
    } catch (err) {
      log.warn('rule-receipt-redelivery onExhausted escalation callback threw', { error: err.message });
    }
  }
}

/**
 * Judge and, if warranted, re-deliver one candidate delivery.
 * @param {object} delivery
 * @param {object} session
 * @param {{nowMs: number, graceMs: number, maxAttempts: number, cooldownMs: number, getRules: Function, deps: object}} ctx
 * @returns {Promise<object>} One outcome record.
 */
async function _processOne(delivery, session, ctx) {
  const { nowMs, graceMs, maxAttempts, cooldownMs, getRules, deps } = ctx;
  const base = { deliveryId: delivery.id, sessionId: session.id };

  // Re-checked here, not just by `_defaultListCandidates`'s own filter: a
  // caller-supplied `listCandidates` could hand this a row that is not a
  // `written` rules-hook delivery, and `written` is the only outcome a
  // receipt (or this watcher) may ever act on (mirrors the same guard in
  // `store/session-rules.js#markDelivered`).
  if (delivery.channel !== 'rules-hook' || delivery.outcome !== 'written') {
    return { ...base, status: 'not-applicable' };
  }

  const startedAtMs = _parseSqliteUtc(session.startedAt);
  const activeForMs = Number.isFinite(startedAtMs) ? nowMs - startedAtMs : -Infinity;
  if (activeForMs < graceMs) {
    return { ...base, status: 'pending-grace' };
  }

  const project = store.projects.get(session.projectId);
  if (!project) {
    return { ...base, status: 'no-project' };
  }
  const withProject = { ...base, projectId: project.id };

  // PRR-A Round 3 BLOCKING 3: the only genuine "stop" signal is the ledger's
  // OWN outcome, re-read fresh — never a prior pass's successful paste. A
  // `null` (store unreachable) is "no new information", not "delivered";
  // the passed-in `delivery.outcome` (already confirmed 'written' above)
  // stands in for that case, same as it always implicitly has.
  const actuallyDelivered = _isActuallyDelivered(session.id, delivery.id);
  if (actuallyDelivered === true) {
    return { ...withProject, status: 'already-delivered' };
  }

  const classification = classifyWrittenDelivery(delivery, project.path, deps);
  if (classification.status !== 'needs-redelivery') {
    return { ...withProject, status: classification.status, reason: classification.reason };
  }

  const { count, alreadySurfacedExhaustion } = _durableAttemptCount(delivery.id, session.id);
  // Cooldown spacing alone stays in-memory (see `_durableAttemptCount`'s own
  // doc for why only the COUNT needs to survive a restart); a `lastAttemptAt`
  // lost to a restart just means this check under-withholds by one bounded
  // attempt, never over-attempts past `maxAttempts`. Fetched here, before
  // either exhaustion branch below, so both can mark `.exhausted` on it —
  // the fallback `_durableAttemptCount` reads when the store cannot answer.
  const memState = _attempts.get(delivery.id) || { count: 0, lastAttemptAt: 0, exhausted: false };
  if (count >= maxAttempts) {
    if (!alreadySurfacedExhaustion) {
      memState.exhausted = true;
      _attempts.set(delivery.id, memState);
      _surfaceExhaustion(delivery, session, project, { count }, deps);
    }
    return { ...withProject, status: 'exhausted', attempts: count };
  }
  if (count > 0 && nowMs - memState.lastAttemptAt < cooldownMs) {
    return { ...withProject, status: 'cooling-down', attempts: count };
  }

  // PRR-A Round 3 BLOCKING 2: never paste into a pane not verified idle —
  // deferred costs nothing (no attempt consumed, the pane never touched),
  // so this check runs AFTER cooldown/exhaustion (which must not be skipped
  // just because the pane happens to be busy) but BEFORE anything that
  // counts as an attempt.
  if (typeof deps.isPaneSafeToDeliver === 'function' && !deps.isPaneSafeToDeliver(session.id)) {
    return { ...withProject, status: 'deferred', reason: 'pane-not-at-rest', attempts: count };
  }

  const attempt = count + 1;
  const rules = getRules(project.id);
  let pasted = false;
  let detail = null;
  try {
    await deps.deliverViaOpenChannel({ sessionId: session.id, projectId: project.id, rules, attempt });
    pasted = true;
  } catch (err) {
    detail = err.message;
  }

  memState.lastAttemptAt = nowMs;
  _attempts.set(delivery.id, memState);

  store.activity.log({
    projectId: project.id,
    sessionId: session.id,
    eventType: EVENT_ATTEMPT,
    // `pasted`, never `confirmed` (BLOCKING 3): a successful paste proves
    // only that the reminder was SENT. This row is also the durable attempt
    // count's own source (`_durableAttemptCount`), written unconditionally
    // whether the paste succeeded or failed — an attempt is an attempt.
    detail: { deliveryId: delivery.id, attempt, pasted, error: detail }
  });

  if (!pasted) {
    if (attempt >= maxAttempts) {
      memState.exhausted = true;
      _attempts.set(delivery.id, memState);
      _surfaceExhaustion(delivery, session, project, { count: attempt }, deps, detail);
      return { ...withProject, status: 'exhausted', attempts: attempt, reason: detail };
    }
    return { ...withProject, status: 'attempt-failed', attempt, reason: detail };
  }
  // A successful paste never ends the watch here (BLOCKING 3): report it
  // honestly as sent-not-confirmed, and let the NEXT pass's fresh ledger
  // read decide whether the hook's own receipt ever actually landed. If
  // this was the last allowed attempt, the NEXT pass's own
  // `count >= maxAttempts` branch above surfaces exhaustion then — not here,
  // because a paste that just succeeded is not yet known to be "unconfirmed
  // forever", only "unconfirmed so far".
  return { ...withProject, status: 'redelivered', attempt };
}

/**
 * Run one pass of the watcher.
 * @param {object} deps
 * @param {(entry: {sessionId: number, projectId: number, rules: object[], attempt: number}) => Promise<any>} [deps.deliverViaOpenChannel] -
 *   Resolving means the open channel ACCEPTED the paste — never that the
 *   engine consumed it (PRR-A Round 3 BLOCKING 3); throwing (or rejecting)
 *   means the paste itself failed. Defaults to `_defaultDeliverViaOpenChannel`
 *   (a tmux pane paste); tests override it to assert on the attempt without
 *   a real pane.
 * @param {(sessionId: number) => boolean} [deps.isPaneSafeToDeliver] - PRR-A
 *   Round 3 BLOCKING 2: when supplied, a candidate is deferred (no attempt
 *   consumed, the pane never touched) unless this returns `true`. Opt-in,
 *   like `deliverViaOpenChannel`'s own default — omitted, every candidate
 *   is treated as safe, unchanged from before this gate existed.
 * @param {number} [deps.maxCandidatesPerPass] - PRR-A Round 3 WARNING 2:
 *   process at most this many candidates in this call. Defaults to
 *   unbounded; production wiring passes a small explicit bound.
 * @param {() => Array<{delivery: object, session: object}>} [deps.listCandidates] - Test seam; defaults to the live store.
 * @param {(projectId: number) => object[]} [deps.getRules] - Defaults to `store.sessionRules.listActiveForProject`.
 * @param {(projectPath: string, deliveryId: number) => ReturnType<typeof probeLocalReceipt>} [deps.probeLocalReceipt]
 * @param {() => number} [deps.now] - Clock override for tests; defaults to `Date.now`.
 * @param {number} [deps.graceMs] - Defaults to `DEFAULT_GRACE_MS`.
 * @param {number} [deps.maxAttempts] - Defaults to `DEFAULT_MAX_ATTEMPTS`.
 * @param {number} [deps.cooldownMs] - Defaults to `DEFAULT_COOLDOWN_MS`.
 * @param {(entry: {sessionId: number, projectId: number, deliveryId: number, attempts: number, reason: string|null}) => void} [deps.onExhausted] -
 *   Optional escalation hook, run once a delivery exhausts its attempts unconfirmed. Errors from it are logged, never thrown.
 * @returns {Promise<object[]>} One outcome record per candidate examined, up to `maxCandidatesPerPass`.
 */
async function checkAndRedeliver(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const graceMs = Number.isFinite(deps.graceMs) ? deps.graceMs : DEFAULT_GRACE_MS;
  const maxAttempts = Number.isInteger(deps.maxAttempts) && deps.maxAttempts > 0 ? deps.maxAttempts : DEFAULT_MAX_ATTEMPTS;
  const cooldownMs = Number.isFinite(deps.cooldownMs) ? deps.cooldownMs : DEFAULT_COOLDOWN_MS;
  // PRR-A Round 3 WARNING 2: unbounded for a direct/test caller (existing
  // behaviour, unchanged); production wiring (lib/activity-observer.js)
  // passes a small explicit bound so one tick's piggybacked pass stays
  // cheap, never a reason pane capture itself falls behind.
  const maxCandidatesPerPass = Number.isInteger(deps.maxCandidatesPerPass) && deps.maxCandidatesPerPass > 0
    ? deps.maxCandidatesPerPass : Infinity;
  const listCandidates = deps.listCandidates || _defaultListCandidates;
  const getRules = deps.getRules || ((projectId) => store.sessionRules.listActiveForProject(projectId));
  // PRR-B Round 1 BLOCKING 2: a production caller supplies nothing here by
  // default now — resolved once per pass, not per candidate, so every
  // `_processOne` call in this pass sees the exact same function reference.
  const resolvedDeps = {
    ...deps,
    deliverViaOpenChannel: typeof deps.deliverViaOpenChannel === 'function'
      ? deps.deliverViaOpenChannel
      : _defaultDeliverViaOpenChannel
  };
  const nowMs = now();

  const outcomes = [];
  for (const { delivery, session } of listCandidates()) {
    if (outcomes.length >= maxCandidatesPerPass) break;
    outcomes.push(await _processOne(delivery, session, { nowMs, graceMs, maxAttempts, cooldownMs, getRules, deps: resolvedDeps }));
  }
  return outcomes;
}

module.exports = {
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_COOLDOWN_MS,
  EVENT_ATTEMPT,
  EVENT_EXHAUSTED,
  probeLocalReceipt,
  classifyWrittenDelivery,
  checkAndRedeliver,
  _resetAttemptState
};
