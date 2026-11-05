'use strict';

/**
 * Bridge action authorization: tiered classification and single-use
 * confirmation cards for sensitive Operator Bridge actions (#2106, #2116,
 * Architect Rulings A2106 and A2116, `v5.59.0` Car 59-C Slice 1).
 *
 * Self-contained, same discipline as `lib/permission-requests.js`: this
 * module owns its own storage. `ensureBridgeConfirmationSchema` applies
 * `bridge_action_confirmations` and `bridge_action_audit` additively via
 * `CREATE TABLE IF NOT EXISTS` on `store.getDb()` — it never touches
 * `lib/store/_schema.js`, so there is no migration number to claim and no
 * startup wiring to add there.
 *
 * Three tiers (`classifyBridgeActionTier`), per the Architect Ruling:
 *   - `ordinary-work` — executes directly within a session's standing
 *     authority; this module adds no refusal or deferral for it.
 *   - `confirmation-card` — requires a confirmation record
 *     ({@link createActionConfirmation}) that whoever presents the action
 *     back must pass to {@link verifyAndConsumeConfirmation}, bound to the
 *     exact operator/guild/channel/action/target/digest and consumable
 *     exactly once.
 *   - `step-up` — requires a short-lived dashboard step-up token, unless the
 *     Operator has recorded an explicit opt-in override for that category
 *     (`opts.stepUpOptIns`), in which case it falls back to
 *     `confirmation-card` rather than bypassing authorization — the
 *     Operator opted into Discord-only RISK for that category, not into no
 *     authorization at all.
 *
 * `verifyAndConsumeConfirmation` is the one state-transition primitive: it
 * does not itself check WHO is presenting the confirmation (same trust-
 * boundary split `lib/permission-requests.js#decidePermissionRequest`
 * documents — proving identity is each caller's own job), only that the
 * confirmation itself is live, unconsumed, and bound to exactly what is
 * being acted on now.
 *
 * Out of this slice's scope (`#2842`, Milestone #45 / `v5.60.0`, per both
 * Architect Rulings): wiring live HTTP endpoint hooks into
 * `lib/bridge-api.js` and the dashboard step-up modal in `public/` — kept
 * out so Car 59-C stays 100% file-disjoint from Car 59-A (`lib/bridge-api.js`)
 * and Car 59-B (`public/*`) this same wave.
 *
 * @module lib/bridge-confirmation
 */

const crypto = require('node:crypto');
const store = require('./store');
const bridgeStore = require('./bridge-store');
const { createLogger } = require('./logger');

const log = createLogger('bridge-confirmation');

/** The three authorization tiers. */
const TIERS = Object.freeze({
  ORDINARY_WORK: 'ordinary-work',
  CONFIRMATION_CARD: 'confirmation-card',
  STEP_UP: 'step-up'
});

/** Executes directly within a session's standing authority (#2116). */
const ORDINARY_WORK_ACTIONS = Object.freeze([
  'investigate', 'plan', 'implement', 'test', 'file-issue', 'file-pr', 'status', 'route', 'dispatch'
]);

/** Requires a single-use confirmation card (#2106, #2116). */
const CONFIRMATION_CARD_ACTIONS = Object.freeze([
  'merge', 'release', 'deploy', 'session-lifecycle', 'launch-consent', 'nickname-mutation'
]);

/** Requires a dashboard step-up token unless opted out per category (#2116). */
const STEP_UP_ACTIONS = Object.freeze([
  'data-deletion', 'credential-change', 'permission-change', 'rule-change'
]);

/** Every `action_kind` a confirmation card may bind to — the union of the
 *  two sensitive tiers' own action lists, since an opted-out step-up action
 *  falls back to carrying a confirmation card (see {@link classifyBridgeActionTier}). */
const CONFIRMABLE_ACTION_KINDS = Object.freeze([...CONFIRMATION_CARD_ACTIONS, ...STEP_UP_ACTIONS]);

/** States a confirmation record passes through. */
const STATES = Object.freeze({ PENDING: 'pending', CONSUMED: 'consumed', EXPIRED: 'expired' });

/**
 * The settings key holding the operator's durable step-up opt-in list
 * (#2842 Slice 2 Round 2, I-Gate Round 1 Finding 1 on PR #2896). A STEP_UP
 * category in this list falls back to `confirmation-card` tier, per
 * {@link classifyBridgeActionTier}'s own documented behavior -- but the
 * SOURCE of that opt-in must be this durable, operator-written record,
 * never a value a Discord-side (helper-authenticated) caller supplies in
 * its own request body, which is exactly the bypass the finding named:
 * the operator did not accept Discord-only risk for anything just because
 * a request claimed they had.
 */
const STEP_UP_OPT_INS_KEY = 'bridge.stepUpOptIns';

/**
 * The operator's durably-recorded step-up opt-ins, filtered to only the
 * real `STEP_UP_ACTIONS` members -- a stale or hand-edited setting can
 * never widen scope by naming something that isn't actually a step-up
 * category.
 * @returns {string[]}
 */
function stepUpOptIns() {
  const raw = bridgeStore.settings.get(STEP_UP_OPT_INS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k) => STEP_UP_ACTIONS.includes(k)) : [];
  } catch {
    return [];
  }
}

/**
 * Set the operator's durable step-up opt-ins. The one write path for the
 * record {@link stepUpOptIns} reads -- callable only from an
 * operator-principal route, never from anything a Discord-side caller can
 * reach.
 * @param {string[]} actionKinds - Any entry not in `STEP_UP_ACTIONS` is dropped, not refused.
 * @returns {string[]} The stored list, filtered and deduplicated.
 */
function setStepUpOptIns(actionKinds) {
  const valid = Array.isArray(actionKinds) ? [...new Set(actionKinds.filter((k) => STEP_UP_ACTIONS.includes(k)))] : [];
  bridgeStore.settings.set(STEP_UP_OPT_INS_KEY, valid.length ? JSON.stringify(valid) : null);
  return valid;
}

/** Seams for tests: the clock and the id/nonce sources. */
const _internal = {
  now: () => new Date().toISOString(),
  id: () => `conf_${crypto.randomBytes(12).toString('hex')}`,
  // Longer than `id()` deliberately: the nonce is the bearer secret a
  // confirmation card is presented with, not a lookup convenience — a
  // caller must not be able to guess one it was never handed.
  nonce: () => crypto.randomBytes(32).toString('hex')
};

/**
 * A refusal, in the one shape every write and read answers with.
 * @param {string} code - One of this module's named failure codes
 * @param {string} message - What was refused and why, for a person
 * @param {object} [extra] - Further fields for the caller
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message, extra) {
  return { ok: false, code, message, ...(extra || {}) };
}

/**
 * The DDL for both tables. Purely additive (`IF NOT EXISTS` throughout) —
 * safe to run on every call, so {@link ensureBridgeConfirmationSchema} never
 * needs to know whether it already ran.
 * @returns {string}
 */
function _tablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS bridge_action_confirmations (
      confirmation_id TEXT    PRIMARY KEY CHECK (length(confirmation_id) BETWEEN 1 AND 64),
      -- A SHA-256 digest of the bearer nonce, never the nonce itself (PRR-A
      -- I-Gate R1 finding 2, #2106): the stated same-user attacker can read
      -- this same user's tangleclaw.db directly (mode 0600 restricts other
      -- users, not this one) -- ordinary file access, not a DB-write
      -- compromise -- so a stored raw nonce would be a usable bearer token
      -- for anyone who can read the file. The raw nonce exists only in
      -- memory at issuance (returned once, never persisted) and in whatever
      -- the caller presents back for verification.
      nonce_hash      TEXT    NOT NULL UNIQUE CHECK (length(nonce_hash) = 64),
      operator_id     TEXT    NOT NULL CHECK (length(operator_id) BETWEEN 1 AND 200),
      guild_id        TEXT    NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 200),
      channel_id      TEXT    NOT NULL CHECK (length(channel_id) BETWEEN 1 AND 200),
      action_kind     TEXT    NOT NULL CHECK (action_kind IN (${CONFIRMABLE_ACTION_KINDS.map((k) => `'${k}'`).join(',')})),
      target_ref      TEXT    NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 500),
      digest_sha      TEXT    NOT NULL CHECK (length(digest_sha) BETWEEN 1 AND 128),
      version         INTEGER NOT NULL,
      state           TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','consumed','expired')),
      expires_at      TEXT    NOT NULL,
      consumed_at     TEXT,
      created_at      TEXT    NOT NULL,
      updated_at      TEXT    NOT NULL,
      CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_bridge_action_confirmations_operator
      ON bridge_action_confirmations(operator_id, state);

    CREATE TABLE IF NOT EXISTS bridge_action_audit (
      audit_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      confirmation_id TEXT    CHECK (confirmation_id IS NULL OR length(confirmation_id) <= 64),
      action_kind     TEXT    NOT NULL CHECK (length(action_kind) BETWEEN 1 AND 100),
      tier            TEXT    NOT NULL CHECK (tier IN ('ordinary-work','confirmation-card','step-up')),
      outcome         TEXT    NOT NULL CHECK (outcome IN ('authorized','rejected')),
      code            TEXT    CHECK (code IS NULL OR length(code) <= 100),
      operator_id     TEXT    CHECK (operator_id IS NULL OR length(operator_id) <= 200),
      guild_id        TEXT    CHECK (guild_id IS NULL OR length(guild_id) <= 200),
      channel_id      TEXT    CHECK (channel_id IS NULL OR length(channel_id) <= 200),
      target_ref      TEXT,
      detail          TEXT,
      recorded_at     TEXT    NOT NULL,
      CHECK ((outcome = 'authorized') = (code IS NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_bridge_action_audit_confirmation
      ON bridge_action_audit(confirmation_id, recorded_at);
  `;
}

/** Whether `ensureBridgeConfirmationSchema` has already run against this exact db handle. */
const _initialized = new WeakSet();

/**
 * Apply this module's schema, additively and idempotently. Safe to call on
 * every public entry point.
 * @param {object} db - An open database handle (`store.getDb()`)
 * @returns {void}
 */
function ensureBridgeConfirmationSchema(db) {
  if (_initialized.has(db)) return;
  db.exec(_tablesDdl());
  _initialized.add(db);
}

/**
 * The open database, with this module's schema guaranteed present.
 * @returns {object}
 * @throws {Error} When the store is not initialized
 */
function _db() {
  const db = store.getDb();
  if (!db) throw new Error('The store is not initialized.');
  ensureBridgeConfirmationSchema(db);
  return db;
}

/**
 * Map a raw row to the shape this module hands callers. There is no raw
 * nonce to include — only its digest is ever stored (PRR-A I-Gate R1
 * finding 2) — so {@link createActionConfirmation} attaches the nonce it
 * generated locally, from memory, never by reading it back off this row.
 * @param {object} row - Raw `bridge_action_confirmations` row
 * @returns {object}
 */
function _rowToConfirmation(row) {
  return {
    confirmationId: row.confirmation_id,
    operatorId: row.operator_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    actionKind: row.action_kind,
    targetRef: row.target_ref,
    digestSha: row.digest_sha,
    version: row.version,
    state: row.state,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Record one audit entry. Never fails closed on its own account — an audit
 * entry is a record of what already happened, not a gate.
 * @param {object} db - Open database handle
 * @param {object} fields
 * @param {string|null} fields.confirmationId
 * @param {string} fields.actionKind
 * @param {string} fields.tier
 * @param {'authorized'|'rejected'} fields.outcome
 * @param {string|null} [fields.code]
 * @param {string|null} [fields.operatorId]
 * @param {string|null} [fields.guildId]
 * @param {string|null} [fields.channelId]
 * @param {string|null} [fields.targetRef]
 * @param {string|null} [fields.detail]
 * @returns {void}
 */
function _recordAudit(db, fields) {
  db.prepare(
    `INSERT INTO bridge_action_audit
       (confirmation_id, action_kind, tier, outcome, code, operator_id, guild_id, channel_id, target_ref, detail, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fields.confirmationId || null, fields.actionKind, fields.tier, fields.outcome, fields.code || null,
    fields.operatorId || null, fields.guildId || null, fields.channelId || null, fields.targetRef || null,
    fields.detail || null, _internal.now()
  );
}

/**
 * Classify a bridge action into its authorization tier (#2116).
 *
 * This function only classifies — it never itself authorizes a
 * `confirmation-card` or `step-up` action. A caller that gets back
 * `tier: 'confirmation-card'` still must obtain and verify a confirmation
 * (via {@link createActionConfirmation} / {@link verifyAndConsumeConfirmation})
 * before acting; `tier: 'step-up'` still must obtain a dashboard step-up
 * token before acting (that token's issuance is Slice 2, `#2842`).
 *
 * @param {string} actionType - One of the action kinds this module knows
 * @param {object} [opts]
 * @param {string[]} [opts.stepUpOptIns] - Step-up categories (from
 *   `STEP_UP_ACTIONS`) the Operator has explicitly recorded an opt-in
 *   override for. An opted-in category falls back to `confirmation-card` —
 *   the Operator accepted Discord-only RISK for it, not zero authorization.
 * @returns {{authorized: boolean, tier: (string|null), code?: string}}
 */
function classifyBridgeActionTier(actionType, opts = {}) {
  if (ORDINARY_WORK_ACTIONS.includes(actionType)) {
    return { authorized: true, tier: TIERS.ORDINARY_WORK };
  }
  if (CONFIRMATION_CARD_ACTIONS.includes(actionType)) {
    return { authorized: false, tier: TIERS.CONFIRMATION_CARD };
  }
  if (STEP_UP_ACTIONS.includes(actionType)) {
    const optedIn = Array.isArray(opts.stepUpOptIns) && opts.stepUpOptIns.includes(actionType);
    return { authorized: false, tier: optedIn ? TIERS.CONFIRMATION_CARD : TIERS.STEP_UP };
  }
  // Fail closed on an action type this module has no policy for, rather
  // than guess a tier — #2106's own acceptance requires the boundary to
  // fail closed, and a silently-ordinary-work default for an unrecognized
  // action is the exact gap this module exists to close.
  log.warn('Bridge action type has no tier policy; refusing rather than guessing', { actionType });
  return { authorized: false, tier: null, code: 'BRIDGE_ACTION_TYPE_UNKNOWN' };
}

/**
 * Create a single-use confirmation card for a `confirmation-card`-tier
 * action (#2106, #2116). The returned record's `nonce` is the bearer secret
 * — hand it to whoever will present the action back for
 * {@link verifyAndConsumeConfirmation}; it is never retrievable again after
 * this call.
 * @param {object} input
 * @param {string} input.operatorId
 * @param {string} input.guildId
 * @param {string} input.channelId
 * @param {string} input.actionKind - Must be in `CONFIRMABLE_ACTION_KINDS`
 * @param {string} input.targetRef
 * @param {string} input.digestSha - The exact SHA/digest of what is being acted on
 * @param {number} input.version
 * @param {number} input.ttlMs - How long the card stays live before it expires
 * @returns {{ok: true, confirmation: object}|{ok: false, code: string, message: string}}
 */
function createActionConfirmation(input) {
  const db = _db();
  for (const field of ['operatorId', 'guildId', 'channelId', 'actionKind', 'targetRef', 'digestSha', 'ttlMs']) {
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      return _refuse('CONFIRMATION_INVALID', `Missing required field "${field}".`);
    }
  }
  if (!CONFIRMABLE_ACTION_KINDS.includes(input.actionKind)) {
    return _refuse('CONFIRMATION_INVALID', `"${input.actionKind}" is not a confirmable action kind.`);
  }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    return _refuse('CONFIRMATION_INVALID', 'Field "ttlMs" must be a positive number.');
  }
  const version = Number.isFinite(input.version) ? input.version : 1;
  const now = _internal.now();
  const confirmationId = _internal.id();
  const nonce = _internal.nonce();
  const nonceHash = digestFor(nonce);
  const expiresAt = new Date(Date.parse(now) + input.ttlMs).toISOString();
  db.prepare(
    `INSERT INTO bridge_action_confirmations
       (confirmation_id, nonce_hash, operator_id, guild_id, channel_id, action_kind, target_ref, digest_sha,
        version, state, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    confirmationId, nonceHash, input.operatorId, input.guildId, input.channelId, input.actionKind,
    input.targetRef, input.digestSha, version, STATES.PENDING, expiresAt, now, now
  );
  const row = db.prepare('SELECT * FROM bridge_action_confirmations WHERE confirmation_id = ?').get(confirmationId);
  _recordAudit(db, {
    confirmationId, actionKind: input.actionKind, tier: TIERS.CONFIRMATION_CARD, outcome: 'authorized',
    operatorId: input.operatorId, guildId: input.guildId, channelId: input.channelId, targetRef: input.targetRef,
    detail: 'created'
  });
  // The nonce is attached from the local variable, never re-read from the
  // row -- only its digest was ever persisted (PRR-A I-Gate R1 finding 2).
  return { ok: true, confirmation: { ..._rowToConfirmation(row), nonce } };
}

/**
 * Apply this confirmation's lazy expiry transition against the current
 * time, persisting it if it fires. A no-op on a row already terminal
 * (`consumed` or `expired`), or one still live.
 * @param {object} db - Open database handle
 * @param {object} row - Raw `bridge_action_confirmations` row
 * @returns {object} The row, raw, after any transition this call applied
 */
function _evaluate(db, row) {
  if (row.state !== STATES.PENDING) return row;
  const now = _internal.now();
  if (row.expires_at <= now) {
    db.prepare('UPDATE bridge_action_confirmations SET state = ?, updated_at = ? WHERE confirmation_id = ?')
      .run(STATES.EXPIRED, now, row.confirmation_id);
    return { ...row, state: STATES.EXPIRED, updated_at: now };
  }
  return row;
}

/**
 * Verify and consume a single-use confirmation card (#2106, #2116). The
 * state-transition primitive: it does not itself check WHO is presenting
 * the confirmation — same trust-boundary split
 * `lib/permission-requests.js#decidePermissionRequest` documents, proving
 * identity is each caller's own job. A nonce is consumable exactly once,
 * ever: a second presentation of the same nonce is rejected
 * (`CONFIRMATION_REPLAYED`), never treated as an idempotent success — unlike
 * a permission-request decision, a confirmation card authorizes an
 * irreversible action and must never be silently reusable.
 *
 * @param {object} presented
 * @param {string} [presented.nonce] - Omit (or empty) to signal no
 *   confirmation was presented at all — refused as
 *   `SAME_USER_CONFIRMATION_REQUIRED`, #2106's own code for a caller that
 *   lacks the bound confirmation nonce entirely, distinct from a nonce that
 *   was presented but does not resolve (`CONFIRMATION_INVALID`).
 * @param {string} presented.operatorId
 * @param {string} presented.guildId
 * @param {string} presented.channelId
 * @param {string} presented.actionKind
 * @param {string} presented.targetRef
 * @param {string} presented.digestSha
 * @param {number} presented.version - Compared against the bound card's own
 *   `version` (PRR-A I-Gate R1 finding 1) — a stale action version is
 *   rejected the same way a mismatched target or digest is.
 * @returns {{ok: true, confirmation: object}|{ok: false, code: string, message: string, confirmation?: object}}
 */
function verifyAndConsumeConfirmation(presented) {
  const db = _db();
  if (!presented || !presented.nonce) {
    _recordAudit(db, {
      confirmationId: null, actionKind: (presented && presented.actionKind) || 'unknown',
      tier: TIERS.CONFIRMATION_CARD, outcome: 'rejected', code: 'SAME_USER_CONFIRMATION_REQUIRED',
      operatorId: presented && presented.operatorId, guildId: presented && presented.guildId,
      channelId: presented && presented.channelId, targetRef: presented && presented.targetRef,
      detail: 'no confirmation nonce presented'
    });
    return _refuse('SAME_USER_CONFIRMATION_REQUIRED',
      'This action requires a bound confirmation card; none was presented.');
  }

  // Looked up by the digest of the presented secret, never by the secret
  // itself -- only the digest is ever persisted (PRR-A I-Gate R1 finding 2).
  const row = db.prepare('SELECT * FROM bridge_action_confirmations WHERE nonce_hash = ?').get(digestFor(presented.nonce));
  if (!row) {
    _recordAudit(db, {
      confirmationId: null, actionKind: presented.actionKind || 'unknown', tier: TIERS.CONFIRMATION_CARD,
      outcome: 'rejected', code: 'CONFIRMATION_INVALID', operatorId: presented.operatorId,
      guildId: presented.guildId, channelId: presented.channelId, targetRef: presented.targetRef,
      detail: 'nonce does not resolve to any confirmation'
    });
    return _refuse('CONFIRMATION_INVALID', 'This confirmation does not exist or was never issued.');
  }

  const _audit = (outcome, code, detail) => _recordAudit(db, {
    confirmationId: row.confirmation_id, actionKind: row.action_kind, tier: TIERS.CONFIRMATION_CARD,
    outcome, code, operatorId: presented.operatorId, guildId: presented.guildId,
    channelId: presented.channelId, targetRef: presented.targetRef, detail
  });

  if (row.state === STATES.CONSUMED) {
    _audit('rejected', 'CONFIRMATION_REPLAYED', 'nonce already consumed');
    return _refuse('CONFIRMATION_REPLAYED', 'This confirmation was already consumed; a confirmation card is single-use.',
      { confirmation: _rowToConfirmation(row) });
  }
  const evaluated = _evaluate(db, row);
  if (evaluated.state === STATES.EXPIRED) {
    _audit('rejected', 'CONFIRMATION_EXPIRED', 'expired before verification');
    return _refuse('CONFIRMATION_EXPIRED', 'This confirmation expired before it was presented.',
      { confirmation: _rowToConfirmation(evaluated) });
  }
  if (!_scopeMatches(evaluated, presented)) {
    // operatorId folded in here, not a separate code (PRR-A I-Gate R1
    // finding 1): WHO this card is bound to and WHERE it was issued are
    // both "scope" in the same sense -- presenting a valid nonce under a
    // different operator is exactly the same class of mismatch as
    // presenting it on a different guild or channel.
    _audit('rejected', 'CONFIRMATION_SCOPE_MISMATCH', 'operator/guild/channel does not match the bound confirmation');
    return _refuse('CONFIRMATION_SCOPE_MISMATCH',
      'This confirmation is bound to a different operator, guild or channel than the one it was presented on.',
      { confirmation: _rowToConfirmation(evaluated) });
  }
  if (!_actionMatches(evaluated, presented)) {
    // version folded in here, not a separate code (PRR-A I-Gate R1 finding
    // 1): a stale action version is "this card does not authorize what is
    // being acted on now", the same class of mismatch as a wrong target or
    // digest, not a new kind of rejection.
    _audit('rejected', 'CONFIRMATION_DIGEST_MISMATCH', 'action/target/digest/version does not match the bound confirmation');
    return _refuse('CONFIRMATION_DIGEST_MISMATCH',
      'This confirmation is bound to a different action, target, digest or version than what is being acted on now.',
      { confirmation: _rowToConfirmation(evaluated) });
  }

  const now = _internal.now();
  db.prepare('UPDATE bridge_action_confirmations SET state = ?, consumed_at = ?, updated_at = ? WHERE confirmation_id = ?')
    .run(STATES.CONSUMED, now, now, evaluated.confirmation_id);
  const consumed = db.prepare('SELECT * FROM bridge_action_confirmations WHERE confirmation_id = ?').get(evaluated.confirmation_id);
  _audit('authorized', null, 'consumed');
  return { ok: true, confirmation: _rowToConfirmation(consumed) };
}

/**
 * Whether a presented action's operator/guild/channel matches what a
 * confirmation row is bound to -- shared by {@link verifyAndConsumeConfirmation}
 * and {@link approveStepUpConfirmation}, which otherwise diverge only in how
 * each proves WHO is presenting (a bearer nonce vs. an operator-principal route).
 * @param {object} row - Raw row, already past its lazy expiry transition.
 * @param {object} presented
 * @returns {boolean}
 */
function _scopeMatches(row, presented) {
  return row.operator_id === presented.operatorId && row.guild_id === presented.guildId && row.channel_id === presented.channelId;
}

/**
 * Whether a presented action's kind/target/digest/version matches what a
 * confirmation row is bound to -- the sibling of {@link _scopeMatches}.
 * @param {object} row - Raw row, already past its lazy expiry transition.
 * @param {object} presented
 * @returns {boolean}
 */
function _actionMatches(row, presented) {
  return row.action_kind === presented.actionKind && row.target_ref === presented.targetRef
    && row.digest_sha === presented.digestSha && row.version === presented.version;
}

/**
 * Pending `step-up`-tier confirmations, newest first, optionally scoped to
 * one operator -- for the dashboard step-up modal (#2842 Slice 2) to show
 * what is awaiting approval. Scoped to `STEP_UP_ACTIONS` action kinds only:
 * a `confirmation-card`-tier item is never approved from the dashboard (it
 * is approved by a Discord reply presenting its nonce), so it is never a
 * candidate here regardless of state. Applies each row's lazy expiry
 * transition before filtering, so an expired-but-not-yet-swept row never
 * reads as pending.
 * @param {object} [filter]
 * @param {string} [filter.operatorId]
 * @returns {object[]}
 */
function listPendingConfirmations(filter = {}) {
  const db = _db();
  const clauses = ['state = ?', `action_kind IN (${STEP_UP_ACTIONS.map(() => '?').join(',')})`];
  const params = [STATES.PENDING, ...STEP_UP_ACTIONS];
  if (filter.operatorId) { clauses.push('operator_id = ?'); params.push(filter.operatorId); }
  const rows = db.prepare(`SELECT * FROM bridge_action_confirmations WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`).all(...params);
  return rows.map((row) => _evaluate(db, row)).filter((row) => row.state === STATES.PENDING).map(_rowToConfirmation);
}

/**
 * Approve a pending `step-up`-tier confirmation from the dashboard (#2842
 * Slice 2). Looked up by `confirmationId` alone -- unlike
 * {@link verifyAndConsumeConfirmation}'s bearer-nonce proof (what a
 * same-user DISCORD-side caller can hold), the proof here is that the
 * caller reached this function at all: only an operator-principal route (a
 * signed-in dashboard session) may call it, which is exactly what a
 * step-up tier exists to require over Discord-only trust -- the route
 * layer is the proof, not a presented secret. Refuses a confirmation whose
 * `actionKind` is not itself a step-up tier action, so this path can never
 * be used to approve a `confirmation-card`-tier item without its nonce.
 * @param {string} confirmationId
 * @param {object} presented
 * @param {string} presented.operatorId
 * @param {string} presented.guildId
 * @param {string} presented.channelId
 * @param {string} presented.actionKind
 * @param {string} presented.targetRef
 * @param {string} presented.digestSha
 * @param {number} presented.version
 * @returns {{ok: true, confirmation: object}|{ok: false, code: string, message: string, confirmation?: object}}
 */
function approveStepUpConfirmation(confirmationId, presented) {
  const db = _db();
  const row = db.prepare('SELECT * FROM bridge_action_confirmations WHERE confirmation_id = ?').get(confirmationId);
  const p = presented || {};
  if (!row) {
    _recordAudit(db, {
      confirmationId: null, actionKind: p.actionKind || 'unknown', tier: TIERS.STEP_UP, outcome: 'rejected',
      code: 'CONFIRMATION_INVALID', operatorId: p.operatorId, guildId: p.guildId, channelId: p.channelId,
      targetRef: p.targetRef, detail: 'confirmationId does not resolve to any confirmation'
    });
    return _refuse('CONFIRMATION_INVALID', 'This confirmation does not exist or was never issued.');
  }
  if (!STEP_UP_ACTIONS.includes(row.action_kind)) {
    return _refuse('CONFIRMATION_INVALID', 'This confirmation is not a step-up tier action.');
  }
  const _audit = (outcome, code, detail) => _recordAudit(db, {
    confirmationId: row.confirmation_id, actionKind: row.action_kind, tier: TIERS.STEP_UP, outcome, code,
    operatorId: p.operatorId, guildId: p.guildId, channelId: p.channelId, targetRef: p.targetRef, detail
  });
  if (row.state === STATES.CONSUMED) {
    _audit('rejected', 'CONFIRMATION_REPLAYED', 'already consumed');
    return _refuse('CONFIRMATION_REPLAYED', 'This confirmation was already consumed.', { confirmation: _rowToConfirmation(row) });
  }
  const evaluated = _evaluate(db, row);
  if (evaluated.state === STATES.EXPIRED) {
    _audit('rejected', 'CONFIRMATION_EXPIRED', 'expired before approval');
    return _refuse('CONFIRMATION_EXPIRED', 'This confirmation expired before it was approved.', { confirmation: _rowToConfirmation(evaluated) });
  }
  if (!_scopeMatches(evaluated, p)) {
    _audit('rejected', 'CONFIRMATION_SCOPE_MISMATCH', 'operator/guild/channel does not match the bound confirmation');
    return _refuse('CONFIRMATION_SCOPE_MISMATCH',
      'This confirmation is bound to a different operator, guild or channel than the one approving it.',
      { confirmation: _rowToConfirmation(evaluated) });
  }
  if (!_actionMatches(evaluated, p)) {
    _audit('rejected', 'CONFIRMATION_DIGEST_MISMATCH', 'action/target/digest/version does not match the bound confirmation');
    return _refuse('CONFIRMATION_DIGEST_MISMATCH',
      'This confirmation is bound to a different action, target, digest or version than what is being approved now.',
      { confirmation: _rowToConfirmation(evaluated) });
  }
  const now = _internal.now();
  db.prepare('UPDATE bridge_action_confirmations SET state = ?, consumed_at = ?, updated_at = ? WHERE confirmation_id = ?')
    .run(STATES.CONSUMED, now, now, evaluated.confirmation_id);
  const consumed = db.prepare('SELECT * FROM bridge_action_confirmations WHERE confirmation_id = ?').get(evaluated.confirmation_id);
  _audit('authorized', null, 'approved via dashboard step-up');
  return { ok: true, confirmation: _rowToConfirmation(consumed) };
}

/**
 * Deny a pending step-up confirmation from the dashboard (#2842 Slice 2) --
 * marks it consumed with a rejected outcome, so it can never later resolve
 * to authorized by any path (the same single-use guarantee a successful
 * approval gives, just recorded as refused rather than granted).
 * @param {string} confirmationId
 * @param {string} [reason]
 * @returns {{ok: true, confirmation: object}|{ok: false, code: string, message: string, confirmation?: object}}
 */
function denyStepUpConfirmation(confirmationId, reason) {
  const db = _db();
  const row = db.prepare('SELECT * FROM bridge_action_confirmations WHERE confirmation_id = ?').get(confirmationId);
  if (!row) return _refuse('CONFIRMATION_INVALID', 'This confirmation does not exist or was never issued.');
  if (row.state === STATES.CONSUMED) {
    return _refuse('CONFIRMATION_REPLAYED', 'This confirmation was already consumed.', { confirmation: _rowToConfirmation(row) });
  }
  const evaluated = _evaluate(db, row);
  if (evaluated.state === STATES.EXPIRED) {
    return _refuse('CONFIRMATION_EXPIRED', 'This confirmation already expired.', { confirmation: _rowToConfirmation(evaluated) });
  }
  const now = _internal.now();
  db.prepare('UPDATE bridge_action_confirmations SET state = ?, consumed_at = ?, updated_at = ? WHERE confirmation_id = ?')
    .run(STATES.CONSUMED, now, now, evaluated.confirmation_id);
  const consumed = db.prepare('SELECT * FROM bridge_action_confirmations WHERE confirmation_id = ?').get(evaluated.confirmation_id);
  _recordAudit(db, {
    confirmationId: evaluated.confirmation_id, actionKind: evaluated.action_kind, tier: TIERS.STEP_UP,
    outcome: 'rejected', code: 'CONFIRMATION_DENIED', operatorId: evaluated.operator_id, guildId: evaluated.guild_id,
    channelId: evaluated.channel_id, targetRef: evaluated.target_ref, detail: reason || 'denied via dashboard step-up'
  });
  return { ok: true, confirmation: _rowToConfirmation(consumed) };
}

/**
 * Compute a SHA-256 hex digest of arbitrary content, for a caller that wants
 * this module's own convention rather than rolling its own (#2106's
 * "exact SHA or digest being acted on"). Not required — `digestSha` is an
 * opaque string this module compares by equality, never recomputed here.
 * @param {string|Buffer} content
 * @returns {string} Hex-encoded SHA-256 digest
 */
function digestFor(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

module.exports = {
  TIERS,
  ORDINARY_WORK_ACTIONS,
  CONFIRMATION_CARD_ACTIONS,
  STEP_UP_ACTIONS,
  CONFIRMABLE_ACTION_KINDS,
  STATES,
  ensureBridgeConfirmationSchema,
  classifyBridgeActionTier,
  stepUpOptIns,
  setStepUpOptIns,
  createActionConfirmation,
  verifyAndConsumeConfirmation,
  listPendingConfirmations,
  approveStepUpConfirmation,
  denyStepUpConfirmation,
  digestFor,
  _internal
};
