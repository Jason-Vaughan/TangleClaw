'use strict';

/**
 * v6 (#2982, V6-09 / B2, Car V60-T2-W1-A, BRIDGE-1c): the Native
 * Conversation Layer's ledger — append/read/soft-delete over
 * `conversation_events` (DDL in `lib/store/_schema.js#_v6B2ConversationLayerDdl`,
 * not here), the Tier-A/B adapter classifier, and the interrupt-support
 * decision #2982 deliverable 2 names.
 *
 * Issue #2982 is large (4 deliverables: the ledger itself; queue-priority
 * vs. engine-verified interrupt; pre-persistence redaction and SQLite
 * secure-overwrite deletion; lazy Open Hood/ttyd). This car's envelope is
 * `lib/store/_schema.js` (additive only) + `lib/v6/b2-conversation-layer.js`
 * + tests — zero `server.js`, zero `lib/secret-redactor.js`, zero
 * `lib/tmux.js` edits. So this module ships:
 *
 * - {@link appendEvent} / {@link getEvents} / {@link softDeleteEvent} — the
 *   ledger's own read/write/soft-delete, decoupled from any route. Redaction
 *   is the CALLER's job (`lib/secret-redactor.js`, out of this car's
 *   envelope) before it ever calls `appendEvent`; this module only records
 *   whether that happened (`redacted`).
 * - {@link classifyAdapterTier} — the Tier-A (`claude`, `codex`,
 *   `antigravity`) / Tier-B (`aider`) mapping #2982 names.
 * - {@link checkInterruptSupport} — the exact decision #2982 deliverable 2
 *   describes (fail closed with `INTERRUPT_UNSUPPORTED_BY_ENGINE` absent an
 *   `interruptContract`), decoupled from the HTTP route that will call it.
 *
 * NOT in this car: the `.../messages/:id/prioritize` and `.../conversation/
 * interrupt` HTTP routes, the real Tier-A/B adapter implementations wired to
 * live engines, the secure-overwrite `DELETE` route (`PRAGMA secure_delete`,
 * `tmux clear-history`, `residual_locations[]`), and Open Hood/ttyd — all
 * named in #2982 as `BRIDGE-1`/`BRIDGE-2`/`BRIDGE-4`/`BRIDGE-5` work.
 *
 * `{ok, code}` returns, injectable `now`, same house style
 * `lib/v6/c1-logical-projects.js`/`lib/v6/e5-kaizen-ledger.js` already share
 * — this is the first module in this wave that actually mutates a database.
 *
 * @module lib/v6/b2-conversation-layer
 */

/** Structured, engine-native adapters (#2982 deliverable 1). */
const TIER_A_ADAPTERS = Object.freeze(['claude', 'codex', 'antigravity']);
/** Pane-derived fallback adapters, "Terminal-Derived (Degraded Fidelity)" (#2982 deliverable 1). */
const TIER_B_ADAPTERS = Object.freeze(['aider']);

const ROLES = Object.freeze(['user', 'assistant', 'system', 'tool']);

/**
 * Which tier an adapter belongs to.
 * @param {string} adapter
 * @returns {'A'|'B'|null} `null` for an adapter neither list names — the
 *   caller decides whether that is a refusal or a to-be-classified gap, not
 *   this function silently guessing.
 */
function classifyAdapterTier(adapter) {
  if (TIER_A_ADAPTERS.includes(adapter)) return 'A';
  if (TIER_B_ADAPTERS.includes(adapter)) return 'B';
  return null;
}

/**
 * Append one conversation event, deduplicating Tier-B pane-derived rows by
 * the exact `(launch_id, pane_cursor_watermark, rolling_line_sha256)` key
 * #2982 names — a replay of the same pane line across a `SIGWINCH`/
 * reconnect is reported `DEDUPED` (not an error) rather than inserted
 * twice. `degraded_fidelity` is derived from `tier`, never caller-supplied,
 * so a record can't claim Tier A while also being marked degraded.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{projectId: number, sessionId: number, launchId: string, seq: number,
 *   tier: ('A'|'B'), adapter: string, role: ('user'|'assistant'|'system'|'tool'),
 *   content: string, paneCursorWatermark?: number, rollingLineSha256?: string|null,
 *   redacted?: boolean, now?: Function}} args
 * @returns {{ok: boolean, code: string, id?: number}}
 */
function appendEvent(db, {
  projectId, sessionId, launchId, seq, tier, adapter, role, content,
  paneCursorWatermark = 0, rollingLineSha256 = null, redacted = false,
  now = () => new Date().toISOString()
}) {
  if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(sessionId) ||
    typeof launchId !== 'string' || !launchId || launchId.length > 128 ||
    !Number.isSafeInteger(seq) || seq < 1 || !['A', 'B'].includes(tier) ||
    typeof adapter !== 'string' || !adapter || adapter.length > 40 ||
    !ROLES.includes(role) || typeof content !== 'string') {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  if (rollingLineSha256 != null) {
    const dup = db.prepare(
      'SELECT id FROM conversation_events WHERE launch_id = ? AND pane_cursor_watermark = ? AND rolling_line_sha256 = ?'
    ).get(launchId, paneCursorWatermark, rollingLineSha256);
    if (dup) return { ok: true, code: 'DEDUPED', id: dup.id };
  }
  const seqTaken = db.prepare('SELECT id FROM conversation_events WHERE session_id = ? AND seq = ?').get(sessionId, seq);
  if (seqTaken) return { ok: false, code: 'SEQ_CONFLICT' };
  const degradedFidelity = tier === 'B' ? 1 : 0;
  const info = db.prepare(
    'INSERT INTO conversation_events (project_id, session_id, launch_id, seq, tier, adapter, role, content, '
    + 'degraded_fidelity, pane_cursor_watermark, rolling_line_sha256, redacted, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(projectId, sessionId, launchId, seq, tier, adapter, role, content, degradedFidelity,
    paneCursorWatermark, rollingLineSha256, redacted ? 1 : 0, now());
  return { ok: true, code: 'APPENDED', id: Number(info.lastInsertRowid) };
}

/**
 * Replay a session's events in seq order.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sessionId: number, sinceSeq?: number, includeDeleted?: boolean}} args
 * @returns {Array<object>}
 */
function getEvents(db, { sessionId, sinceSeq = 0, includeDeleted = false }) {
  const clause = includeDeleted ? '' : 'AND deleted_at IS NULL';
  return db.prepare(
    `SELECT * FROM conversation_events WHERE session_id = ? AND seq > ? ${clause} ORDER BY seq ASC`
  ).all(sessionId, sinceSeq);
}

/**
 * Soft-delete one event by stamping `deleted_at` — the schema-level marker
 * a future secure-overwrite DELETE route (`PRAGMA secure_delete = ON` +
 * `wal_checkpoint(TRUNCATE)` + `tmux clear-history`, out of this car's
 * envelope) would act on. This function does not itself overwrite or purge
 * row content.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id: number, sessionId: number, now?: Function}} args
 * @returns {{ok: boolean, code: string}}
 */
function softDeleteEvent(db, { id, sessionId, now = () => new Date().toISOString() }) {
  const changed = db.prepare(
    'UPDATE conversation_events SET deleted_at = ? WHERE id = ? AND session_id = ? AND deleted_at IS NULL'
  ).run(now(), id, sessionId).changes;
  return changed === 1 ? { ok: true, code: 'DELETED' } : { ok: false, code: 'NOT_FOUND_OR_ALREADY_DELETED' };
}

/**
 * The interrupt-support decision (#2982 deliverable 2): engine-verified
 * interruption requires the engine's own `interruptContract`; absent one,
 * fail closed with the exact code #2982 names, rather than attempting a
 * signal an engine never promised to honor.
 * @param {{interruptContract?: *}|null|undefined} engineProfile
 * @returns {{allowed: boolean, code?: string}}
 */
function checkInterruptSupport(engineProfile) {
  if (engineProfile && engineProfile.interruptContract) return { allowed: true };
  return { allowed: false, code: 'INTERRUPT_UNSUPPORTED_BY_ENGINE' };
}

module.exports = {
  TIER_A_ADAPTERS,
  TIER_B_ADAPTERS,
  ROLES,
  classifyAdapterTier,
  appendEvent,
  getEvents,
  softDeleteEvent,
  checkInterruptSupport
};
