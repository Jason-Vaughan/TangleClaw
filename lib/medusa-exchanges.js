'use strict';

/**
 * Medusa delivery watchdog (#1839): exchange state, the rules.
 *
 * An exchange is one ordinary Medusa message to one recipient. The Hub holds
 * the body; this module holds what happened to it, so a message that was
 * stored but never reached its reader can be seen, aged and escalated instead
 * of waiting silently.
 *
 * Model:
 * - Facts are the truth and are append-only. The exchange row is a projection
 *   of them plus the fixed send-time metadata. Arrival, wake, read, ack and
 *   reply facts can race or arrive out of order, so the projection ranks facts
 *   by kind rather than stepping through a fixed sequence, and `replay`
 *   recomputes it from scratch.
 * - Terminal outcomes (closed, retracted, undeliverable, recipient_retired)
 *   are guarded: each is decided inside one `BEGIN IMMEDIATE` transaction, so
 *   exactly one wins. A fact that lands after a terminal outcome is kept for
 *   audit and changes nothing.
 * - A send is recorded as an intent before the Hub is called, and the Hub id
 *   is bound in a second transaction. The Hub and SQLite cannot commit
 *   together, so a send whose outcome is unknown stays `send_unknown`: visible
 *   to the sender and never retried by this module.
 * - Correlation is by Hub id only. An arrival no send on this host recorded
 *   becomes an explicitly untracked row; a send that later binds the same Hub
 *   id adopts it.
 * - Only ordinary peer mail gets a row. Control notices and escalation
 *   notices come from `system` and never do, which is what keeps HOLD, STOP
 *   and RELEASE out of reach of close and retract.
 * - Priority changes timing and visibility only. Nothing here grants control
 *   authority. Who the caller is comes from the HTTP layer
 *   (`lib/control-auth.js`); this module trusts the caller it is given.
 *
 * @module lib/medusa-exchanges
 */

const crypto = require('node:crypto');
const store = require('./store');

const PRIORITIES = Object.freeze(['normal', 'blocking', 'critical']);

/** Why a sender says it is waiting. Codes, not prose: they are copied into escalation notices. */
const REASON_CODES = Object.freeze(['awaiting-ruling', 'awaiting-review', 'awaiting-dispatch', 'incident', 'question', 'other']);

/** Why a sender withdrew a message. */
const RETRACT_REASONS = Object.freeze(['superseded', 'sent-in-error', 'no-longer-needed', 'other']);

/** Terminal states, each reached through a guarded transition. */
const TERMINAL_STATES = Object.freeze(['closed', 'retracted', 'undeliverable', 'recipient_retired']);

/** Facts that end an exchange, and the state each one ends it in. */
const TERMINAL_FACTS = Object.freeze({
  closed: 'closed', retracted: 'retracted', undeliverable: 'undeliverable',
  send_refused: 'undeliverable', recipient_retired: 'recipient_retired'
});

/** Facts that record a wake attempt's outcome; the newest one sets the wake state. */
const WAKE_FACTS = Object.freeze(['wake_pending', 'wake_blocked', 'wake_attempted', 'wake_not_accepted', 'wake_accepted']);

/** Facts recorded once per exchange: a redelivery, reconnect or second read adds nothing. */
const ONCE_FACTS = Object.freeze(['send_pending', 'hub_accepted', 'arrived', 'read', 'acknowledged', 'replied', 'aged', 'escalated', 'operator_alerted']);

/** Progress ranks for the non-terminal projection. Higher wins, whatever order the facts landed in. */
const PROGRESS = Object.freeze({ send_pending: 0, send_unknown: 1, stored: 2, delivered: 3, wake: 4, read: 5, acknowledged: 6, replied: 7 });

/** States from which a message may still be retracted: nobody has read it yet. */
const RETRACTABLE_STATES = Object.freeze([
  'send_pending', 'send_unknown', 'stored', 'delivered',
  'wake_pending', 'wake_blocked', 'wake_attempted', 'wake_not_accepted'
]);

/** The shortest escalation deadline a sender may ask for. */
const MIN_ESCALATE_AFTER_MS = 2 * 60 * 1000;

/**
 * How long each priority waits before it first escalates, unless a sender
 * shortens it. Normal mail only ever becomes visible as aged. Critical
 * escalates at once, so there is nothing to shorten.
 */
const DEFAULT_FIRST_ESCALATION_MS = Object.freeze({ normal: 30 * 60 * 1000, blocking: 15 * 60 * 1000, critical: 0 });

/** Open blocking messages one sender project may have at once. */
const MAX_OPEN_BLOCKING_PER_SENDER = 5;

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const HUB_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const WORKSPACE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const CODE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * A refusal with the HTTP status and stable code the API returns. `details`
 * carries only bounded facts: ids, states and codes.
 */
class ExchangeError extends Error {
  /**
   * @param {number} status - HTTP status
   * @param {string} code - Stable code
   * @param {string} message - Human-readable reason (no bodies, paths or secrets)
   * @param {object} [details] - Bounded facts
   */
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ExchangeError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Seams for tests. */
const _internal = {
  /** @returns {Date} Server time. Every timestamp and deadline comes from here, never from the client. */
  now: () => new Date()
};

/**
 * A new opaque exchange id.
 * @returns {string}
 */
function _newId() {
  return `mx_${crypto.randomBytes(12).toString('base64url')}`;
}

/**
 * The principal naming a project.
 * @param {number} projectId - Project id
 * @returns {string}
 */
function _projectPrincipal(projectId) {
  return `project:${projectId}`;
}

/**
 * Whether a caller is a verified operator.
 * @param {object|null} caller - Resolved caller
 * @returns {boolean}
 */
function _isOperator(caller) {
  return !!caller && caller.kind === 'operator'
    && (caller.proof === 'verified-session' || caller.proof === 'ambient-open');
}

/**
 * Whether a caller is a verified launch of the given project.
 * @param {object|null} caller - Resolved caller
 * @param {number|null} projectId - Project id the caller must be
 * @returns {boolean}
 */
function _isBoundLaunchOf(caller, projectId) {
  return !!caller && caller.kind === 'project' && Number.isInteger(caller.projectId)
    && projectId != null && caller.projectId === projectId;
}

/**
 * The principal and proof tier a caller is recorded under.
 * @param {object} caller - Resolved caller
 * @returns {{actor: string, proof: (string|null)}}
 */
function _recordedAs(caller) {
  if (!caller) return { actor: null, proof: null };
  if (caller.kind === 'operator') return { actor: 'operator', proof: caller.proof || null };
  if (caller.kind === 'project') return { actor: _projectPrincipal(caller.projectId), proof: 'launch' };
  if (caller.kind === 'system') return { actor: 'system', proof: 'system' };
  return { actor: caller.kind === 'operator-ui' ? 'operator-ui' : null, proof: null };
}

/**
 * Validate the delivery metadata of a new send, and decide what it may claim.
 *
 * A normal send keeps legacy compatibility: an unbound caller may send one,
 * and it is recorded as unverified. Blocking needs a verified launch of the
 * sending project (or the operator). Critical needs operator proof or an
 * in-process system call. A protected priority that cannot be proven is
 * refused, never silently downgraded. Replying (`inReplyTo`) changes an
 * existing exchange, so it needs a verified caller whatever the priority.
 *
 * @param {object} body - Request body: `priority`, `replyRequired`, `escalateAfterMinutes`, `reason`, `inReplyTo`, `requestId`
 * @param {object} caller - Resolved caller: `{kind: 'unbound'|'project'|'operator'|'system', projectId?, proof?}`
 * @param {number|null} senderProjectId - The project the send is made as
 * @param {object} [thresholds] - First-escalation delays per priority, in ms
 * @returns {{priority: string, replyRequired: boolean, escalateAfterMs: (number|null), reasonCode: (string|null), inReplyTo: (string|null), requestId: string, verified: boolean, proof: (string|null)}}
 * @throws {ExchangeError} On any invalid or unprovable field
 */
function validateSendMeta(body, caller, senderProjectId, thresholds = DEFAULT_FIRST_ESCALATION_MS) {
  const b = body && typeof body === 'object' ? body : {};
  const priority = b.priority === undefined || b.priority === null ? 'normal' : b.priority;
  if (!PRIORITIES.includes(priority)) {
    throw new ExchangeError(400, 'PRIORITY_INVALID', 'priority must be normal, blocking or critical');
  }
  const operator = _isOperator(caller);
  const system = !!caller && caller.kind === 'system';
  const boundSender = _isBoundLaunchOf(caller, senderProjectId);
  if (priority === 'critical' && !operator && !system) {
    throw new ExchangeError(403, 'PRIORITY_RESERVED', 'critical is reserved to the operator and TangleClaw. Use blocking if you cannot continue.');
  }
  if (priority === 'blocking' && !operator && !system && !boundSender) {
    throw new ExchangeError(403, 'PRIORITY_BINDING_REQUIRED',
      'A blocking message must come from a verified session launch. Send it with your launch headers (tc message send does this).');
  }

  let replyRequired = priority !== 'normal';
  if (b.replyRequired !== undefined && b.replyRequired !== null) {
    if (typeof b.replyRequired !== 'boolean') throw new ExchangeError(400, 'EXCHANGE_MALFORMED', 'replyRequired must be true or false');
    replyRequired = b.replyRequired;
  }

  let escalateAfterMs = null;
  if (b.escalateAfterMinutes !== undefined && b.escalateAfterMinutes !== null) {
    const max = thresholds[priority];
    const minutes = b.escalateAfterMinutes;
    const ms = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.round(minutes * 60 * 1000) : NaN;
    if (!(max > 0) || !(ms >= MIN_ESCALATE_AFTER_MS && ms <= max)) {
      throw new ExchangeError(400, 'DEADLINE_OUT_OF_RANGE', max > 0
        ? `escalateAfterMinutes must be between 2 and ${Math.floor(max / 60000)} for ${priority} messages`
        : `${priority} messages escalate at once; escalateAfterMinutes cannot shorten that`);
    }
    escalateAfterMs = ms;
  }

  let reasonCode = null;
  if (b.reason !== undefined && b.reason !== null) {
    if (!REASON_CODES.includes(b.reason)) {
      throw new ExchangeError(400, 'REASON_INVALID', `reason must be one of: ${REASON_CODES.join(', ')}`);
    }
    reasonCode = b.reason;
  }

  let inReplyTo = null;
  if (b.inReplyTo !== undefined && b.inReplyTo !== null) {
    if (typeof b.inReplyTo !== 'string' || !HUB_ID_RE.test(b.inReplyTo)) {
      throw new ExchangeError(400, 'EXCHANGE_MALFORMED', 'inReplyTo must be a Medusa message id');
    }
    if (!operator && !boundSender) {
      throw new ExchangeError(403, 'EXCHANGE_BINDING_REQUIRED',
        'Replying to a message must come from a verified session launch. Send it with your launch headers (tc message send does this).');
    }
    inReplyTo = b.inReplyTo;
  }

  let requestId;
  if (b.requestId !== undefined && b.requestId !== null) {
    if (typeof b.requestId !== 'string' || !REQUEST_ID_RE.test(b.requestId)) {
      throw new ExchangeError(400, 'EXCHANGE_MALFORMED', 'requestId must be 1-128 letters, digits or . _ : -');
    }
    requestId = b.requestId;
  } else {
    requestId = `send:${crypto.randomBytes(12).toString('base64url')}`;
  }

  const rec = _recordedAs(caller);
  const verified = operator || system || boundSender;
  return { priority, replyRequired, escalateAfterMs, reasonCode, inReplyTo, requestId, verified, proof: verified ? rec.proof : null };
}

/**
 * Recompute an exchange's projection from its facts. Pure: the same row and
 * facts always give the same projection, whatever order the facts landed in.
 * @param {object} row - The exchange row (only its fixed columns are read)
 * @param {object[]} facts - Its facts, oldest first
 * @returns {object} Projection columns
 */
function project(row, facts) {
  let terminal = null;
  let rank = PROGRESS.send_pending;
  let progressState = 'send_pending';
  let wake = null;
  let hubId = row.origin === 'arrival' ? row.hub_id : null;
  let recipient = row.recipient_workspace_id;
  let escLevel = 'none';
  let rearmCount = 0;
  let nextEligibleAt = null;
  let updatedAt = row.created_at;
  const bump = (r, s) => { if (r > rank) { rank = r; progressState = s; } };
  const escRank = { none: 0, aged: 1, escalated: 2, operator: 3 };
  const raiseEsc = (lvl) => { if (escRank[lvl] > escRank[escLevel]) escLevel = lvl; };

  for (const f of facts) {
    if (f.at > updatedAt) updatedAt = f.at;
    if (terminal) continue;
    const detail = _parseDetail(f.detail_json);
    if (TERMINAL_FACTS[f.fact]) {
      terminal = { state: TERMINAL_FACTS[f.fact], at: f.at, by: f.actor, code: f.code, replacement: detail.replacementHubId || null };
      continue;
    }
    switch (f.fact) {
      case 'send_pending':
        if (detail.to) recipient = detail.to;
        break;
      case 'send_unknown': bump(PROGRESS.send_unknown, 'send_unknown'); break;
      case 'hub_accepted':
        bump(PROGRESS.stored, 'stored');
        if (detail.hubId) hubId = detail.hubId;
        // The Hub refreshed a stale handle and delivered to the peer's current id.
        if (detail.deliveredTo) recipient = detail.deliveredTo;
        break;
      case 'arrived': bump(PROGRESS.delivered, 'delivered'); break;
      case 'read': bump(PROGRESS.read, 'read'); break;
      case 'acknowledged': bump(PROGRESS.acknowledged, 'acknowledged'); break;
      case 'replied': bump(PROGRESS.replied, 'replied'); break;
      case 'rearmed':
        // A re-arm asks the wake monitor to try again through every gate, so
        // until the next attempt the message is waiting on a wake.
        rearmCount += 1;
        if (detail.nextEligibleAt) nextEligibleAt = detail.nextEligibleAt;
        wake = { state: 'wake_pending', code: 'rearmed' };
        break;
      // The ladder moves only on its own rung facts. A notice's delivery facts
      // (queued, accepted, failed, undeliverable) say what became of one
      // notice and never which rung the exchange is on.
      case 'aged': raiseEsc('aged'); break;
      case 'escalated': raiseEsc('escalated'); break;
      case 'operator_alerted': raiseEsc('operator'); break;
      default:
        if (WAKE_FACTS.includes(f.fact)) {
          wake = { state: f.fact, code: f.code || null };
          if (detail.nextEligibleAt) nextEligibleAt = detail.nextEligibleAt;
        }
    }
  }
  if (wake && rank <= PROGRESS.wake) { rank = PROGRESS.wake; progressState = wake.state; }

  // An untracked exchange is never supervised, but what is known about it still
  // shows: an outcome, or a send whose Hub answer was lost.
  let state = terminal ? terminal.state : progressState;
  if (row.tracking === 'untracked' && !terminal && progressState !== 'send_unknown') state = 'untracked';
  return {
    hub_id: hubId,
    recipient_workspace_id: recipient,
    state,
    wake_code: wake ? wake.code : null,
    esc_level: escLevel,
    rearm_count: rearmCount,
    next_eligible_at: nextEligibleAt,
    terminal_at: terminal ? terminal.at : null,
    terminal_by: terminal ? terminal.by : null,
    terminal_code: terminal ? terminal.code : null,
    replacement_hub_id: terminal ? terminal.replacement : null,
    updated_at: updatedAt
  };
}

/**
 * Parse a fact's detail, tolerating its absence.
 * @param {string|null} json - Stored detail
 * @returns {object}
 */
function _parseDetail(json) {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Recompute a row's projection from its facts and write it. Call inside a transaction.
 * @param {string} exchangeId - Exchange id
 * @returns {object} The updated row
 */
function _reproject(exchangeId) {
  const row = store.medusaExchanges.get(exchangeId);
  store.medusaExchanges.writeProjection(exchangeId, project(row, store.medusaExchanges.facts(exchangeId)));
  return store.medusaExchanges.get(exchangeId);
}

/**
 * Append a fact and reproject, inside the caller's transaction. A once-only
 * fact that is already recorded is skipped, so a redelivery, a reconnect or a
 * second read of the same message advances nothing. Reads and acks are once
 * per actor: the dashboard having marked a message handled must not hide the
 * agent doing so afterwards.
 * @param {string} exchangeId - Exchange id
 * @param {string} fact - Fact kind
 * @param {{code?: string|null, actor?: string|null, proof?: string|null, detail?: object|null, at?: string}} [opts]
 * @returns {{row: object, recorded: boolean}}
 */
function _append(exchangeId, fact, opts = {}) {
  if (ONCE_FACTS.includes(fact)) {
    const perActor = fact === 'read' || fact === 'acknowledged';
    const actor = opts.actor ?? null;
    const seen = store.medusaExchanges.facts(exchangeId)
      .some((f) => f.fact === fact && (!perActor || f.actor === actor));
    if (seen) return { row: store.medusaExchanges.get(exchangeId), recorded: false };
  }
  store.medusaExchanges.appendFact({
    exchange_id: exchangeId,
    fact,
    code: opts.code ?? null,
    actor: opts.actor ?? null,
    proof: opts.proof ?? null,
    detail_json: opts.detail ? JSON.stringify(opts.detail) : null,
    at: opts.at || _internal.now().toISOString()
  });
  return { row: _reproject(exchangeId), recorded: true };
}

/**
 * Record a send's intent before the Hub is called. A `requestId` that already
 * made an exchange is refused rather than recorded twice, so a client retry of
 * a send whose outcome it never learned cannot put a second copy on the Hub.
 * @param {object} input
 * @param {ReturnType<typeof validateSendMeta>} input.meta - Validated metadata
 * @param {{projectId: (number|null), sessionId: (string|number|null), workspaceId: (string|null)}} input.sender
 * @param {{workspaceId: string, projectId?: (number|null), sessionId?: (string|number|null)}} input.recipient
 * @param {'tracked'|'untracked'} [input.tracking] - `untracked` for a recipient this host cannot supervise
 * @returns {object} The exchange row
 * @throws {ExchangeError} 400 on a malformed recipient, 404 on an unknown reply target, 409 on a reused requestId,
 *   422 for a protected priority this host cannot supervise, 429 over the blocking limit
 */
function createSendIntent({ meta, sender, recipient, tracking = 'tracked' }) {
  if (!recipient || typeof recipient.workspaceId !== 'string' || !WORKSPACE_ID_RE.test(recipient.workspaceId)) {
    throw new ExchangeError(400, 'EXCHANGE_MALFORMED', 'to must be a workspace id');
  }
  if (tracking === 'untracked' && meta.priority !== 'normal') {
    throw new ExchangeError(422, 'WATCHDOG_UNAVAILABLE_REMOTE',
      `This host cannot supervise delivery to ${recipient.workspaceId}, so it cannot accept a ${meta.priority} message there. Send it as normal, or reach that session through its own host.`);
  }
  return store.medusaExchanges.transaction(() => {
    // A request id that already made an exchange must not reach the Hub again:
    // that send may already exist there, and a resend would duplicate it.
    const existing = store.medusaExchanges.getByRequestId(meta.requestId);
    if (existing) {
      throw new ExchangeError(409, 'SEND_ALREADY_ATTEMPTED',
        'That requestId was already sent. It was not sent again; check its exchange instead.',
        { exchangeId: existing.exchange_id, state: existing.state });
    }
    if (meta.priority === 'blocking' && Number.isInteger(sender.projectId)
      && store.medusaExchanges.countOpenBlockingForSender(sender.projectId) >= MAX_OPEN_BLOCKING_PER_SENDER) {
      throw new ExchangeError(429, 'BLOCKING_LIMIT',
        `You already have ${MAX_OPEN_BLOCKING_PER_SENDER} open blocking messages. Close or wait on those first.`);
    }
    let replyTarget = null;
    if (meta.inReplyTo) {
      replyTarget = store.medusaExchanges.getByHubId(meta.inReplyTo, 'send');
      if (!replyTarget || replyTarget.recipient_project_id == null || replyTarget.recipient_project_id !== sender.projectId) {
        throw new ExchangeError(404, 'REPLY_TARGET_UNKNOWN', 'inReplyTo does not name a message addressed to you');
      }
    }
    const exchangeId = _newId();
    const at = _internal.now().toISOString();
    store.medusaExchanges.insert({
      exchange_id: exchangeId,
      request_id: meta.requestId,
      origin: 'send',
      tracking,
      sender_project_id: sender.projectId ?? null,
      sender_session_id: sender.sessionId == null ? null : String(sender.sessionId),
      sender_workspace_id: sender.workspaceId ?? null,
      sender_verified: meta.verified,
      sender_proof: meta.proof,
      recipient_workspace_id: recipient.workspaceId,
      recipient_project_id: recipient.projectId ?? null,
      recipient_session_id: recipient.sessionId == null ? null : String(recipient.sessionId),
      priority: meta.priority,
      reply_required: meta.replyRequired,
      escalate_after_ms: meta.escalateAfterMs,
      reason_code: meta.reasonCode,
      in_reply_to: replyTarget ? replyTarget.exchange_id : null,
      created_at: at,
      state: 'send_pending'
    });
    return _append(exchangeId, 'send_pending', {
      actor: sender.projectId != null ? _projectPrincipal(sender.projectId) : null,
      proof: meta.proof,
      detail: { to: recipient.workspaceId },
      at
    }).row;
  });
}

/**
 * Bind the Hub's message id to a send, in the transaction after the Hub
 * answered. Adopts an arrival this host recorded for the same Hub id before
 * the answer came back, and records the reply on the exchange this send
 * answers. Idempotent. A Hub id that cannot be stored marks the send
 * `send_unknown` instead.
 * @param {string} exchangeId - Exchange id
 * @param {string} hubId - The Hub's message id
 * @param {{hubStatus?: string, deliveredTo?: string}} [opts] - The Hub's `received`/`queued`
 *   answer, and the workspace it delivered to when it refreshed a stale handle
 * @returns {object} The exchange row
 */
function bindHubId(exchangeId, hubId, opts = {}) {
  // An id nothing can bind leaves the message's existence unknowable from here.
  if (typeof hubId !== 'string' || !HUB_ID_RE.test(hubId)) return markSendUnknown(exchangeId, 'hub-id-invalid');
  return store.medusaExchanges.transaction(() => {
    const row = _mustGet(exchangeId);
    const at = _internal.now().toISOString();
    const hubStatus = typeof opts.hubStatus === 'string' && CODE_RE.test(opts.hubStatus) ? opts.hubStatus : null;
    const deliveredTo = typeof opts.deliveredTo === 'string' && WORKSPACE_ID_RE.test(opts.deliveredTo)
      && opts.deliveredTo !== row.recipient_workspace_id ? opts.deliveredTo : null;
    let out = _append(exchangeId, 'hub_accepted', {
      code: hubStatus, actor: 'system', detail: deliveredTo ? { hubId, deliveredTo } : { hubId }, at
    }).row;

    const arrival = store.medusaExchanges.getByHubId(hubId, 'arrival');
    if (arrival && !arrival.terminal_at) {
      for (const f of store.medusaExchanges.facts(arrival.exchange_id)) {
        if (f.fact === 'arrived' || f.fact === 'read' || f.fact === 'acknowledged') {
          out = _append(exchangeId, f.fact, {
            code: f.code, actor: f.actor, proof: f.proof,
            detail: { ..._parseDetail(f.detail_json), adoptedFrom: arrival.exchange_id }, at: f.at
          }).row;
        }
      }
      _append(arrival.exchange_id, 'closed', { code: 'adopted-by-send', actor: 'system', detail: { exchangeId }, at });
      out = _closeIfSatisfied(exchangeId) || out;
    }

    if (row.in_reply_to) {
      const target = store.medusaExchanges.get(row.in_reply_to);
      if (target) {
        _append(target.exchange_id, 'replied', {
          actor: row.sender_project_id != null ? _projectPrincipal(row.sender_project_id) : null,
          proof: row.sender_proof,
          detail: { replyExchangeId: exchangeId, replyHubId: hubId },
          at
        });
      }
    }
    return out;
  });
}

/**
 * Record that a send's Hub outcome is unknown (timeout, network error, an
 * unparsable answer). The message may or may not exist on the Hub, so it is
 * shown to the sender as unknown and never retried here.
 * @param {string} exchangeId - Exchange id
 * @param {string} code - Why the outcome is unknown
 * @returns {object} The exchange row
 */
function markSendUnknown(exchangeId, code) {
  return store.medusaExchanges.transaction(() => {
    _mustGet(exchangeId);
    return _append(exchangeId, 'send_unknown', { code: _code(code), actor: 'system' }).row;
  });
}

/**
 * Record an explicit Hub refusal: the message does not exist, so the exchange
 * ends as undeliverable.
 * @param {string} exchangeId - Exchange id
 * @param {string} code - The refusal's code
 * @returns {object} The exchange row
 */
function markSendRefused(exchangeId, code) {
  return _terminal(exchangeId, 'send_refused', { code: _code(code), actor: 'system' });
}

/**
 * Record that a message reached a listener on this host. The send that made
 * it gets an `arrived` fact. An arrival no send on this host recorded becomes
 * an untracked row, so a later send binding the same Hub id can adopt it.
 * Messages from `system` (control and escalation notices) never get a row.
 * Idempotent across redelivery and reconnect.
 * @param {object} input
 * @param {string} input.hubId - Hub message id
 * @param {string} input.recipientWorkspaceId - The listener's workspace id
 * @param {number|null} [input.recipientProjectId]
 * @param {string|number|null} [input.recipientSessionId]
 * @param {string|null} [input.senderWorkspaceId] - The envelope's `from`
 * @returns {object|null} The exchange row, or null for a message that is not ordinary correspondence
 */
function recordArrival({ hubId, recipientWorkspaceId, recipientProjectId = null, recipientSessionId = null, senderWorkspaceId = null }) {
  if (typeof hubId !== 'string' || !HUB_ID_RE.test(hubId)) return null;
  if (senderWorkspaceId === 'system' || store.control.getReceiptByNotice(hubId)) return null;
  if (typeof recipientWorkspaceId !== 'string' || !WORKSPACE_ID_RE.test(recipientWorkspaceId)) return null;
  return store.medusaExchanges.transaction(() => {
    const sent = store.medusaExchanges.getByHubId(hubId, 'send');
    if (sent) return _append(sent.exchange_id, 'arrived', { actor: 'recipient' }).row;
    const known = store.medusaExchanges.getByHubId(hubId, 'arrival');
    if (known) return _append(known.exchange_id, 'arrived', { actor: 'recipient' }).row;
    const exchangeId = _newId();
    const at = _internal.now().toISOString();
    store.medusaExchanges.insert({
      exchange_id: exchangeId,
      request_id: `arrival:${hubId}`,
      hub_id: hubId,
      origin: 'arrival',
      tracking: 'untracked',
      sender_workspace_id: typeof senderWorkspaceId === 'string' && WORKSPACE_ID_RE.test(senderWorkspaceId) ? senderWorkspaceId : null,
      recipient_workspace_id: recipientWorkspaceId,
      recipient_project_id: recipientProjectId,
      recipient_session_id: recipientSessionId == null ? null : String(recipientSessionId),
      priority: 'normal',
      reply_required: false,
      created_at: at,
      state: 'untracked'
    });
    return _append(exchangeId, 'arrived', { actor: 'recipient', at }).row;
  });
}

/**
 * The exchange a recipient-side fact about a Hub id belongs to: the send that
 * made it, else the untracked arrival, and only when it was addressed to the
 * workspace reporting the fact. A participant can know Hub ids of mail it sent
 * or overheard; reporting one must not record a read or ack on someone else's mail.
 * @param {string} hubId - Hub message id
 * @param {string|null} recipientWorkspaceId - The reporting participant's workspace
 * @returns {object|null}
 */
function _forRecipientFact(hubId, recipientWorkspaceId) {
  if (typeof hubId !== 'string' || !HUB_ID_RE.test(hubId)) return null;
  if (typeof recipientWorkspaceId !== 'string' || !recipientWorkspaceId) return null;
  const x = store.medusaExchanges.getByHubId(hubId, 'send') || store.medusaExchanges.getByHubId(hubId, 'arrival');
  return x && x.recipient_workspace_id === recipientWorkspaceId ? x : null;
}

/**
 * Who a recipient-side fact is recorded as. A verified launch is the
 * recipient; the dashboard is `operator-ui`; the operator elsewhere is the
 * operator; anyone unproven is recorded as exactly that.
 * @param {object|null} caller - Resolved caller, or `{kind: 'operator-ui'}`
 * @returns {{actor: string, proof: (string|null)}}
 */
function _readerAs(caller) {
  if (caller && caller.kind === 'project') return { actor: 'recipient', proof: 'launch' };
  if (caller && caller.kind === 'operator-ui') return { actor: 'operator-ui', proof: caller.proof || null };
  if (caller && caller.kind === 'operator') return { actor: 'operator', proof: caller.proof || null };
  return { actor: 'unverified-reader', proof: null };
}

/**
 * Record that these messages were fetched from the recipient's inbox, and by whom.
 * @param {string[]} hubIds - Hub ids actually returned to the reader
 * @param {string|null} recipientWorkspaceId - The inbox's workspace; only mail addressed to it is recorded
 * @param {object|null} [caller] - Who fetched them
 * @returns {number} How many exchanges gained a `read` fact
 */
function recordRead(hubIds, recipientWorkspaceId, caller = null) {
  const rec = _readerAs(caller);
  let n = 0;
  for (const hubId of Array.isArray(hubIds) ? hubIds : []) {
    const x = _forRecipientFact(hubId, recipientWorkspaceId);
    if (!x) continue;
    store.medusaExchanges.transaction(() => {
      if (_append(x.exchange_id, 'read', rec).recorded) n += 1;
    });
  }
  return n;
}

/**
 * Record that these messages were marked handled, and by whom. The dashboard
 * inbox panel marks everything it shows handled; that is recorded as
 * `operator-ui`, never as the recipient, so nobody mistakes it for the agent
 * having read the message. A message that needs no reply ends here; one that
 * needs a reply stays open until a bound reply arrives.
 * @param {string[]} hubIds - Hub ids marked handled
 * @param {string|null} recipientWorkspaceId - The inbox's workspace; only mail addressed to it is recorded
 * @param {object} caller - Who marked them: a resolved caller, or `{kind: 'operator-ui'}`
 * @returns {number} How many exchanges gained an `acknowledged` fact
 */
function recordAcknowledged(hubIds, recipientWorkspaceId, caller) {
  const rec = _readerAs(caller);
  let n = 0;
  for (const hubId of Array.isArray(hubIds) ? hubIds : []) {
    const x = _forRecipientFact(hubId, recipientWorkspaceId);
    if (!x) continue;
    store.medusaExchanges.transaction(() => {
      if (_append(x.exchange_id, 'acknowledged', rec).recorded) n += 1;
      _closeIfSatisfied(x.exchange_id);
    });
  }
  return n;
}

/**
 * End a tracked exchange that needs no reply once it has been acknowledged,
 * however the ack arrived: directly, or adopted from an arrival that beat the
 * Hub's answer. The close names who acknowledged first, so a dashboard close is
 * never read as the agent's. Call inside a transaction.
 * @param {string} exchangeId - Exchange id
 * @returns {object|null} The closed row, or null when nothing changed
 */
function _closeIfSatisfied(exchangeId) {
  const row = store.medusaExchanges.get(exchangeId);
  if (!row || row.tracking !== 'tracked' || row.reply_required || row.terminal_at) return null;
  const ack = store.medusaExchanges.facts(exchangeId).find((f) => f.fact === 'acknowledged');
  if (!ack) return null;
  return _append(exchangeId, 'closed', {
    code: ack.actor === 'operator-ui' ? 'acknowledged-in-dashboard' : 'acknowledged',
    actor: 'system'
  }).row;
}

/** States in which a message is still waiting to be read, so a wake is about it. */
const AWAITING_READ = Object.freeze(['stored', 'delivered', 'wake_pending', 'wake_blocked', 'wake_attempted', 'wake_not_accepted']);

/**
 * Open tracked exchanges addressed to a workspace that nobody has read yet:
 * what a wake of that workspace is about.
 * @param {string} workspaceId - Recipient workspace id
 * @returns {object[]} Raw rows
 */
function _awaitingRead(workspaceId) {
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) return [];
  return store.medusaExchanges.listOpenForRecipient(workspaceId)
    .filter((x) => AWAITING_READ.includes(x.state)
      && !store.medusaExchanges.facts(x.exchange_id).some((f) => f.fact === 'read' || f.fact === 'acknowledged'));
}

/**
 * How many messages to a workspace are still waiting to be read.
 * @param {string} workspaceId - Recipient workspace id
 * @returns {number}
 */
function pendingWakeCount(workspaceId) {
  return _awaitingRead(workspaceId).length;
}

/**
 * The newest fact of a kind, or null.
 * @param {object[]} facts - Facts, oldest first
 * @param {string} kind - Fact kind
 * @returns {object|null}
 */
function _newest(facts, kind) {
  for (let i = facts.length - 1; i >= 0; i--) if (facts[i].fact === kind) return facts[i];
  return null;
}

/**
 * Whether an exchange has any fact of the given kinds.
 * @param {string} exchangeId - Exchange id
 * @param {string[]} kinds - Fact kinds
 * @returns {boolean}
 */
function hasFact(exchangeId, kinds) {
  return store.medusaExchanges.facts(exchangeId).some((f) => kinds.includes(f.fact));
}

/**
 * Where an exchange's wake stands, read from its facts rather than from the
 * latest verdict: a listener reconnect or a blocked pane after an attempt
 * does not make the attempt not have happened.
 * @param {object[]} facts - The exchange's facts, oldest first
 * @returns {{attempt: (object|null), outcome: (string|null), rearmPending: boolean, readyAfterAttempt: boolean, blockedAfterAttempt: (object|null)}}
 *   `outcome` is `wake_not_accepted` or `wake_accepted` when a receipt for the
 *   newest attempt has been recorded. `readyAfterAttempt` is a persisted
 *   readiness change newer than the attempt. `blockedAfterAttempt` is the
 *   newest ineligible verdict since the attempt, if any.
 */
function wakeStanding(facts) {
  const attempt = _newest(facts, 'wake_attempted');
  const rearmed = _newest(facts, 'rearmed');
  let outcome = null;
  let readyAfterAttempt = false;
  let blockedAfterAttempt = null;
  if (attempt) {
    for (const f of facts) {
      if (f.fact_seq <= attempt.fact_seq) continue;
      if (f.fact === 'wake_not_accepted' || f.fact === 'wake_accepted') outcome = f.fact;
      if (f.fact === 'readiness_changed') readyAfterAttempt = true;
      if (f.fact === 'wake_blocked') blockedAfterAttempt = f;
    }
  }
  return {
    attempt,
    outcome,
    rearmPending: !!rearmed && (!attempt || rearmed.fact_seq > attempt.fact_seq),
    readyAfterAttempt,
    blockedAfterAttempt
  };
}

/**
 * Exchanges to a workspace whose wake was attempted and has not been settled
 * either way: no read, no receipt, no pending re-arm, no readiness change
 * since. The wake monitor keeps watching the pane for these (without injecting
 * anything) so a readiness change after the attempt can be recorded.
 * @param {string} workspaceId - Recipient workspace id
 * @returns {object[]} Raw rows
 */
function _unsettledAttempts(workspaceId) {
  return _awaitingRead(workspaceId).filter((x) => {
    const st = wakeStanding(store.medusaExchanges.facts(x.exchange_id));
    return st.attempt && !st.rearmPending && !st.outcome && !st.readyAfterAttempt;
  });
}

/**
 * Whether the wake monitor should keep watching a workspace's pane after its
 * nudge, to catch a readiness change.
 * @param {string} workspaceId - Recipient workspace id
 * @returns {boolean}
 */
function awaitingReadiness(workspaceId) {
  return _unsettledAttempts(workspaceId).length > 0;
}

/**
 * Persist a readiness change after an attempt: the gates had found the
 * session ineligible since the nudge (a busy or blocked pane, a listener
 * reconnecting, all recorded as `wake_blocked`), and now find it eligible
 * again. Recorded only where that ineligible verdict is itself on record
 * after the attempt, so the transition is durable on both sides and a restart
 * between them loses nothing. Tied to the attempt's nonce. This, or a
 * negative receipt, is what lets the watchdog re-arm; elapsed time alone never does.
 * @param {string} workspaceId - Recipient workspace id
 * @param {{at?: string}} [opts]
 * @returns {number} How many exchanges gained the fact
 */
function noteReadiness(workspaceId, opts = {}) {
  let n = 0;
  for (const x of _unsettledAttempts(workspaceId)) {
    store.medusaExchanges.transaction(() => {
      const st = wakeStanding(store.medusaExchanges.facts(x.exchange_id));
      if (!st.attempt || st.readyAfterAttempt || !st.blockedAfterAttempt) return;
      _append(x.exchange_id, 'readiness_changed', {
        code: 'ineligible-to-eligible',
        actor: 'system',
        detail: { nonce: _parseDetail(st.attempt.detail_json).nonce || null, from: st.blockedAfterAttempt.code },
        at: opts.at
      });
      n += 1;
    });
  }
  return n;
}

/**
 * Record what the wake monitor did about a workspace's unread mail, on every
 * exchange it concerned. The nudge names no message (it says "N unread"), so
 * one attempt concerns them all. A receipt concerns only the exchanges that
 * attempt reached: pass `attemptNonce` and only exchanges whose newest attempt
 * carried it are touched, so mail that arrived after the nudge is not marked
 * as having missed it. A blocked or pending verdict that has not changed since
 * the last one is not recorded again, because the monitor re-judges every few
 * seconds; every attempt is recorded, each with its own nonce.
 * @param {string} workspaceId - The workspace being woken
 * @param {'wake_pending'|'wake_blocked'|'wake_attempted'|'wake_not_accepted'|'wake_accepted'} fact - What happened
 * @param {{code?: string|null, detail?: object|null, at?: string, attemptNonce?: string}} [opts]
 * @returns {number} How many exchanges gained the fact
 */
function recordWakeForRecipient(workspaceId, fact, opts = {}) {
  if (!WAKE_FACTS.includes(fact)) throw new Error(`not a wake fact: ${fact}`);
  const code = opts.code == null ? null : _code(opts.code);
  let n = 0;
  for (const x of _awaitingRead(workspaceId)) {
    store.medusaExchanges.transaction(() => {
      const row = store.medusaExchanges.get(x.exchange_id);
      if (!row || row.terminal_at) return;
      if (opts.attemptNonce !== undefined) {
        const attempt = _newest(store.medusaExchanges.facts(x.exchange_id), 'wake_attempted');
        if (!attempt || _parseDetail(attempt.detail_json).nonce !== opts.attemptNonce) return;
      }
      const repeat = (fact === 'wake_blocked' || fact === 'wake_pending') && row.state === fact && row.wake_code === code;
      if (repeat) return;
      _append(x.exchange_id, fact, { code, actor: 'system', detail: opts.detail || null, at: opts.at });
      n += 1;
    });
  }
  return n;
}

/**
 * Note that the wake monitor considers a workspace's newest mail already
 * nudged and waiting on the agent. An exchange whose last verdict was a block
 * from before that (a listener reconnecting, a busy pane) would otherwise keep
 * showing a reason that no longer holds.
 * @param {string} workspaceId - Recipient workspace id
 * @returns {number} How many exchanges were updated
 */
function noteAwaitingRead(workspaceId) {
  let n = 0;
  for (const x of _awaitingRead(workspaceId)) {
    if (x.state !== 'wake_blocked') continue;
    const standing = wakeStanding(store.medusaExchanges.facts(x.exchange_id));
    if (!standing.attempt || standing.rearmPending) continue;
    n += recordWakeForExchange(x.exchange_id, 'wake_pending', 'awaiting-read');
  }
  return n;
}

/**
 * Append one wake verdict to one exchange, skipping an unchanged repeat.
 * @param {string} exchangeId - Exchange id
 * @param {string} fact - Wake fact
 * @param {string|null} code - Reason code
 * @returns {number} 1 when recorded, else 0
 */
function recordWakeForExchange(exchangeId, fact, code) {
  return store.medusaExchanges.transaction(() => {
    const row = store.medusaExchanges.get(exchangeId);
    if (!row || row.terminal_at || (row.state === fact && row.wake_code === code)) return 0;
    _append(exchangeId, fact, { code, actor: 'system' });
    return 1;
  });
}

/**
 * Whether the watchdog has re-armed a wake for a workspace that has not been
 * attempted since. The wake monitor asks this before treating an
 * already-nudged inbox as done. Read from the facts, so a verdict recorded
 * after the re-arm (a blocked pane) does not cancel it.
 * @param {string} workspaceId - Recipient workspace id
 * @returns {boolean}
 */
function rearmDue(workspaceId) {
  return _awaitingRead(workspaceId).some((x) => wakeStanding(store.medusaExchanges.facts(x.exchange_id)).rearmPending);
}

/**
 * What would justify re-arming an exchange's newest wake attempt, or null.
 * The one definition of a valid trigger (Architect ruling on R20 A3): a
 * negative receipt, or a persisted readiness change newer than the attempt.
 * Elapsed time is never one. Nothing qualifies once the attempt was accepted,
 * a re-arm is already pending, or the mail has been read.
 * @param {object[]} facts - The exchange's facts, oldest first
 * @returns {'not-accepted'|'readiness-changed'|null}
 */
function rearmTrigger(facts) {
  if (facts.some((f) => f.fact === 'read' || f.fact === 'acknowledged')) return null;
  const st = wakeStanding(facts);
  if (!st.attempt || st.rearmPending || st.outcome === 'wake_accepted') return null;
  if (st.outcome === 'wake_not_accepted') return 'not-accepted';
  return st.readyAfterAttempt ? 'readiness-changed' : null;
}

/**
 * Whether a workspace's unread mail has all been nudged already, read from
 * the durable record: every unread tracked exchange to it has an attempt and
 * no pending re-arm, and together they account for all of its unread mail.
 * The wake monitor asks this when its in-memory watermark has been lost (a
 * server restart), so a restart never sends a wake outside the re-arm budget.
 * @param {string} workspaceId - Recipient workspace id
 * @param {number} unread - The listener's unread count
 * @returns {boolean}
 */
function alreadyAttempted(workspaceId, unread) {
  const pending = _awaitingRead(workspaceId);
  if (pending.length === 0 || pending.length < unread) return false;
  return pending.every((x) => {
    const st = wakeStanding(store.medusaExchanges.facts(x.exchange_id));
    return st.attempt && !st.rearmPending;
  });
}

/**
 * Re-arm one exchange's wake, once, if it has a valid trigger (`rearmTrigger`)
 * and is still at the expected count. Decided inside a transaction, so a duplicate tick or a
 * restart mid-backoff cannot re-arm twice. The re-arm only asks the wake
 * monitor to try again; the monitor still applies every gate before it
 * injects anything.
 * @param {string} exchangeId - Exchange id
 * @param {{expectRearmCount: number, nextEligibleAt: string, at?: string}} opts
 * @returns {object|null} The row, or null when the exchange moved on and nothing was re-armed
 */
function rearm(exchangeId, opts) {
  return store.medusaExchanges.transaction(() => {
    const row = store.medusaExchanges.get(exchangeId);
    if (!row || row.terminal_at || row.tracking !== 'tracked') return null;
    if (!AWAITING_READ.includes(row.state) || row.rearm_count !== opts.expectRearmCount) return null;
    const trigger = rearmTrigger(store.medusaExchanges.facts(exchangeId));
    if (!trigger) return null;
    return _append(exchangeId, 'rearmed', {
      code: trigger, actor: 'system', detail: { nextEligibleAt: opts.nextEligibleAt }, at: opts.at
    }).row;
  });
}

/**
 * Record a watchdog escalation fact (aged, escalation_*, operator_alerted).
 * @param {string} exchangeId - Exchange id
 * @param {string} fact - Fact kind
 * @param {{code?: string|null, detail?: object|null}} [opts]
 * @returns {object} The exchange row
 */
function recordEscalationFact(exchangeId, fact, opts = {}) {
  const allowed = ['aged', 'escalated', 'escalation_queued', 'escalation_accepted', 'escalation_failed', 'escalation_undeliverable', 'operator_alerted'];
  if (!allowed.includes(fact)) throw new Error(`not an escalation fact: ${fact}`);
  return store.medusaExchanges.transaction(() => {
    _mustGet(exchangeId);
    return _append(exchangeId, fact, { code: opts.code == null ? null : _code(opts.code), actor: 'system', detail: opts.detail || null }).row;
  });
}

/**
 * Close an exchange. Only the original sender, proven by a verified launch of
 * the sending project, or the operator may close it.
 * @param {string} exchangeId - Exchange id
 * @param {object} caller - Resolved caller
 * @returns {object} The exchange row
 * @throws {ExchangeError} 403 for anyone else, 409 when another outcome already ended it
 */
function close(exchangeId, caller) {
  const row = _mustGet(exchangeId);
  if (!_isOperator(caller)) {
    if (!caller || caller.kind !== 'project') {
      throw new ExchangeError(403, 'EXCHANGE_BINDING_REQUIRED', 'Closing an exchange must come from a verified session launch or the operator.');
    }
    if (!_isBoundLaunchOf(caller, row.sender_project_id)) {
      throw new ExchangeError(403, 'NOT_INITIATOR', 'Only the sender of a message can close its exchange.');
    }
  }
  const rec = _recordedAs(caller);
  return _terminal(exchangeId, 'closed', { code: 'initiator-closed', actor: rec.actor, proof: rec.proof });
}

/**
 * Retract a message nobody has read yet. The row and every fact stay: a
 * retraction is a tombstone, never a deletion. Only ordinary correspondence
 * can be retracted; a control notice has no exchange and is refused. The
 * route and UI for this belong to #1873; the rules live here so the watchdog
 * already treats a retraction as final.
 * @param {string} hubId - Hub message id of the send to retract
 * @param {object} caller - Resolved caller: the verified sender, or the operator
 * @param {{reason: string, replacementHubId?: (string|null)}} opts
 * @returns {object} The exchange row
 * @throws {ExchangeError} 403, 404, `409 NOT_RETRACTABLE` or `409 CONTROL_NOT_RETRACTABLE`
 */
function retract(hubId, caller, opts = {}) {
  if (typeof hubId === 'string' && store.control.getReceiptByNotice(hubId)) {
    throw new ExchangeError(409, 'CONTROL_NOT_RETRACTABLE',
      'That is a HOLD, STOP or RELEASE notice. Control can only be changed by a newer control command.');
  }
  const row = typeof hubId === 'string' && HUB_ID_RE.test(hubId) ? store.medusaExchanges.getByHubId(hubId, 'send') : null;
  if (!row) throw new ExchangeError(404, 'EXCHANGE_NOT_FOUND', 'No message you sent has that id');
  if (!RETRACT_REASONS.includes(opts.reason)) {
    throw new ExchangeError(400, 'REASON_INVALID', `reason must be one of: ${RETRACT_REASONS.join(', ')}`);
  }
  const replacement = opts.replacementHubId == null ? null : opts.replacementHubId;
  if (replacement !== null && (typeof replacement !== 'string' || !HUB_ID_RE.test(replacement))) {
    throw new ExchangeError(400, 'EXCHANGE_MALFORMED', 'replacementHubId must be a Medusa message id');
  }
  if (!_isOperator(caller) && !_isBoundLaunchOf(caller, row.sender_project_id)) {
    throw new ExchangeError(403, 'NOT_INITIATOR', 'Only the sender of a message can retract it.');
  }
  const rec = _recordedAs(caller);
  return _terminal(row.exchange_id, 'retracted', {
    code: opts.reason, actor: rec.actor, proof: rec.proof, detail: replacement ? { replacementHubId: replacement } : null,
    guard: (current) => RETRACTABLE_STATES.includes(current.state)
      && !store.medusaExchanges.facts(current.exchange_id).some((f) => f.fact === 'read' || f.fact === 'acknowledged' || f.fact === 'replied'),
    refusal: (current) => new ExchangeError(409, 'NOT_RETRACTABLE',
      'That message has already been read or answered. Send a correction instead.', { state: current.state })
  });
}

/**
 * End every open exchange addressed to a workspace that has been retired for
 * good (its session ended and its id was forgotten). The Hub will never
 * deliver to that id again, so waiting would be silence.
 * @param {string} workspaceId - Retired recipient workspace id
 * @returns {object[]} The exchanges this ended
 */
function markRecipientRetired(workspaceId) {
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) return [];
  const ended = [];
  for (const x of store.medusaExchanges.listOpenForRecipient(workspaceId)) {
    try {
      ended.push(_terminal(x.exchange_id, 'recipient_retired', { code: 'workspace-retired', actor: 'system' }));
    } catch (err) {
      if (!(err instanceof ExchangeError && err.code === 'EXCHANGE_TERMINAL')) throw err;
    }
  }
  return ended;
}

/**
 * A guarded terminal transition: decided inside one transaction, so of two
 * racing outcomes exactly one is recorded and the other learns the winner.
 * Repeating the same outcome returns the exchange unchanged.
 * @param {string} exchangeId - Exchange id
 * @param {string} fact - A terminal fact
 * @param {{code?: string|null, actor?: string|null, proof?: string|null, detail?: object|null, guard?: Function, refusal?: Function}} opts
 * @returns {object} The exchange row
 * @throws {ExchangeError} `409 EXCHANGE_TERMINAL` when a different outcome already won
 */
function _terminal(exchangeId, fact, opts) {
  return store.medusaExchanges.transaction(() => {
    const current = _mustGet(exchangeId);
    const wanted = TERMINAL_FACTS[fact];
    if (current.terminal_at) {
      if (current.state === wanted) return current;
      if (opts.refusal) throw opts.refusal(current);
      throw new ExchangeError(409, 'EXCHANGE_TERMINAL', `That exchange already ended as ${current.state}.`,
        { state: current.state, code: current.terminal_code });
    }
    if (opts.guard && !opts.guard(current)) throw opts.refusal(current);
    return _append(exchangeId, fact, opts).row;
  });
}

/**
 * The exchange row, or a 404.
 * @param {string} exchangeId - Exchange id
 * @returns {object}
 */
function _mustGet(exchangeId) {
  const row = typeof exchangeId === 'string' ? store.medusaExchanges.get(exchangeId) : null;
  if (!row) throw new ExchangeError(404, 'EXCHANGE_NOT_FOUND', 'No such exchange');
  return row;
}

/**
 * Bound a code to the stored form, or null.
 * @param {*} code - Candidate code
 * @returns {string|null}
 */
function _code(code) {
  return typeof code === 'string' && CODE_RE.test(code) ? code : null;
}

/**
 * Recompute an exchange's projection from its facts without writing it.
 * @param {string} exchangeId - Exchange id
 * @returns {object} Projection columns
 */
function replay(exchangeId) {
  const row = _mustGet(exchangeId);
  return project(row, store.medusaExchanges.facts(exchangeId));
}

/**
 * The public view of an exchange: ids, metadata, state and outcome. Never the
 * message body, which only the Hub holds.
 * @param {object} row - Exchange row
 * @returns {object}
 */
function view(row) {
  const satisfied = row.state === 'replied' && row.reply_required === 1;
  return {
    exchangeId: row.exchange_id,
    hubId: row.hub_id,
    tracking: row.tracking,
    priority: row.priority,
    replyRequired: row.reply_required === 1,
    reason: row.reason_code,
    state: row.state,
    label: satisfied ? 'satisfied, awaiting initiator close' : row.state.replace(/_/g, ' '),
    wakeCode: row.wake_code,
    escalation: row.esc_level,
    sender: { projectId: row.sender_project_id, workspaceId: row.sender_workspace_id, verified: row.sender_verified === 1 },
    recipient: { projectId: row.recipient_project_id, workspaceId: row.recipient_workspace_id },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ended: row.terminal_at ? { at: row.terminal_at, by: row.terminal_by, code: row.terminal_code, replacementHubId: row.replacement_hub_id } : null
  };
}

module.exports = {
  PRIORITIES,
  REASON_CODES,
  RETRACT_REASONS,
  TERMINAL_STATES,
  MIN_ESCALATE_AFTER_MS,
  DEFAULT_FIRST_ESCALATION_MS,
  MAX_OPEN_BLOCKING_PER_SENDER,
  ExchangeError,
  validateSendMeta,
  project,
  createSendIntent,
  bindHubId,
  markSendUnknown,
  markSendRefused,
  recordArrival,
  recordRead,
  recordAcknowledged,
  recordWakeForRecipient,
  noteAwaitingRead,
  awaitingReadiness,
  noteReadiness,
  pendingWakeCount,
  rearmDue,
  rearm,
  wakeStanding,
  rearmTrigger,
  alreadyAttempted,
  hasFact,
  recordEscalationFact,
  close,
  retract,
  markRecipientRetired,
  replay,
  view,
  _internal
};
