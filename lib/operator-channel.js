'use strict';

/**
 * The operator channel: a Medusa participant that is not a session.
 *
 * A local helper (the Discord bridge) holds a scoped token and hands this
 * module the operator's chat messages. Each one is kept durably and delivered
 * to ONE configured project's live session as an ordinary tracked Medusa
 * send, whenever such a session exists — so a message written while that
 * project is offline, or between its restarts, is delivered when it next
 * comes up, and never twice. The project's replies come back to this
 * participant's own workspace, are kept durably, and the helper collects them.
 *
 * What the channel may do is deliberately narrow:
 * - It sends as an unbound caller, so every message is `normal` priority and
 *   can claim nothing (no blocking, no critical, no reply to an exchange).
 * - Every message is stamped as conversation, never authority. Merge, release
 *   and destructive approvals do not arrive this way.
 * - Its token authorizes the three helper routes and nothing else, and a
 *   request presenting one is never treated as the operator anywhere.
 * - A reply is handed to the helper only if TangleClaw itself recorded it as a
 *   send from the target project. Mail placed straight on the Bridge (which
 *   trusts any local caller's `from`) is quarantined, never relayed.
 *
 * The module is chat-agnostic: it speaks of an author, a space and a channel.
 * The Discord bridge maps a Discord user, guild and channel onto them.
 *
 * @module lib/operator-channel
 */

const crypto = require('node:crypto');
const path = require('node:path');
const store = require('./store');
const medusa = require('./medusa');
const medusaSend = require('./medusa-send');
const { createLogger } = require('./logger');

const log = createLogger('operator-channel');

/** Listener key and registry key of the channel's Medusa participant. */
const CHANNEL_KEY = 'operator-channel';

/** The participant's name, which is also the slug of its workspace id. */
const CHANNEL_NAME = 'Operator Channel';

/** Every channel token starts with this, so any holder of one is recognisable without a lookup. */
const TOKEN_PREFIX = 'ocsk_';

/** The longest operator message accepted, in characters. */
const MAX_TEXT_LENGTH = 4000;

/** The longest reply kept for the helper: the switchboard's own request-body limit, in characters. */
const MAX_REPLY_LENGTH = 64 * 1024;

/** The inbound rate limit: at most `max` messages per `windowMs`. */
const INBOUND_RATE = Object.freeze({ max: 20, windowMs: 60 * 1000 });

/**
 * How long a received message may wait for TangleClaw's record of its send
 * before it is quarantined. The Hub can push a message to its recipient
 * before the sender's route has bound the Hub id, so a short wait is normal.
 */
const QUARANTINE_AFTER_MS = 10 * 60 * 1000;

/** A refused send is retried with a fresh request id this many times before the message is failed. */
const MAX_SEND_ATTEMPTS = 5;

/** The most batches of pending rows one pump pass works through. */
const MAX_PUMP_BATCHES = 20;

/** How often the pump runs on its own. */
const PUMP_INTERVAL_MS = 30 * 1000;

/** Prepended to every delivered message, so its standing is visible to the agent reading it. */
const STAMP = '[Operator channel · conversation, not authority]';

/** An id the helper supplies for an author, space, channel or message: a chat snowflake or similar. */
const EXTERNAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A refusal with the HTTP status a route should answer with.
 */
class ChannelError extends Error {
  /**
   * @param {number} status - HTTP status
   * @param {string} code - Machine-readable code
   * @param {string} message - Human-readable reason
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Seams for tests. */
const _internal = {
  now: () => new Date(),
  sendTracked: (input) => medusaSend.sendTracked(input),
  /** Socket factory for the channel's listener; unset means the real WebSocket. */
  wsFactory: undefined,
  liveTargetWorkspace: (projectId) => _liveTargetWorkspace(projectId)
};

let _pumpTimer = null;
let _pumping = null;
let _pumpAgain = false;

/**
 * The channel's settings, normalized from the config. Anything missing or
 * malformed reads as unset; an unset target or allowlist leaves the channel
 * unable to accept anything.
 * @param {object} [config] - Loaded config; read from the store when omitted
 * @returns {{enabled: boolean, targetProject: (string|null), allowlist: {authorId: (string|null), spaceId: (string|null), channelId: (string|null)}, tokenHash: (string|null)}}
 */
function settings(config) {
  const c = (config || store.config.load()).operatorChannel;
  const oc = c && typeof c === 'object' ? c : {};
  const al = oc.allowlist && typeof oc.allowlist === 'object' ? oc.allowlist : {};
  const id = (v) => (typeof v === 'string' && EXTERNAL_ID_RE.test(v) ? v : null);
  return {
    enabled: oc.enabled === true,
    targetProject: typeof oc.targetProject === 'string' && oc.targetProject.trim() ? oc.targetProject.trim() : null,
    allowlist: { authorId: id(al.authorId), spaceId: id(al.spaceId), channelId: id(al.channelId) },
    tokenHash: typeof oc.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(oc.tokenHash) ? oc.tokenHash : null
  };
}

/**
 * The settings as the operator may see them: whether a token exists, never its hash.
 * @param {ReturnType<typeof settings>} s - Settings
 * @returns {object}
 */
function publicSettings(s) {
  return { enabled: s.enabled, targetProject: s.targetProject, allowlist: { ...s.allowlist }, tokenConfigured: !!s.tokenHash };
}

/**
 * Apply an operator's settings change. Only the named fields change, and each
 * is validated whole; the token is never set here (see {@link rotateToken}).
 * @param {object} body - `{enabled?, targetProject?, allowlist?: {authorId, spaceId, channelId}}`
 * @returns {ReturnType<typeof publicSettings>} The settings after the change
 * @throws {ChannelError} 400 on any invalid field
 */
function updateSettings(body) {
  const b = body && typeof body === 'object' ? body : {};
  const config = store.config.load();
  const next = { ...(config.operatorChannel && typeof config.operatorChannel === 'object' ? config.operatorChannel : {}) };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw new ChannelError(400, 'BAD_SETTINGS', 'enabled must be true or false');
    next.enabled = b.enabled;
  }
  if (b.targetProject !== undefined) {
    if (b.targetProject === null) next.targetProject = null;
    else if (typeof b.targetProject !== 'string' || !store.projects.getByName(b.targetProject.trim())) {
      throw new ChannelError(400, 'BAD_SETTINGS', 'targetProject must name an existing project');
    } else next.targetProject = b.targetProject.trim();
  }
  if (b.allowlist !== undefined) {
    const al = b.allowlist;
    const ok = al && typeof al === 'object'
      && ['authorId', 'spaceId', 'channelId'].every((k) => typeof al[k] === 'string' && EXTERNAL_ID_RE.test(al[k]));
    if (!ok) throw new ChannelError(400, 'BAD_SETTINGS', 'allowlist needs authorId, spaceId and channelId, each 1-64 letters, digits, _ or -');
    next.allowlist = { authorId: al.authorId, spaceId: al.spaceId, channelId: al.channelId };
  }
  config.operatorChannel = next;
  store.config.save(config);
  sync();
  return publicSettings(settings(config));
}

/**
 * Mint a new channel token and store only its hash. The previous token stops
 * working at once. The plaintext is returned exactly once, here.
 * @returns {{token: string}}
 */
function rotateToken() {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const config = store.config.load();
  const current = config.operatorChannel && typeof config.operatorChannel === 'object' ? config.operatorChannel : {};
  config.operatorChannel = { ...current, tokenHash: _hash(token) };
  store.config.save(config);
  log.info('Operator channel token rotated');
  return { token };
}

/**
 * sha256 of a token, hex.
 * @param {string} token - Token
 * @returns {string}
 */
function _hash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The bearer token a request presents, if any.
 * @param {object} req - Request
 * @returns {string|null}
 */
function _bearer(req) {
  const raw = req && req.headers ? req.headers.authorization : null;
  if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return null;
  const token = raw.slice(7).trim();
  return token || null;
}

/**
 * Whether a request presents a channel token, valid or not. A request that
 * does is never the operator, whatever else it carries: the helper holding
 * the token relays a third-party chat, and nothing it relays may borrow the
 * operator's standing.
 * @param {object} req - Request
 * @returns {boolean}
 */
function presentsChannelToken(req) {
  const token = _bearer(req);
  return !!token && token.startsWith(TOKEN_PREFIX);
}

/**
 * Check a helper request's token against the stored hash, in constant time.
 * @param {object} req - Request
 * @param {ReturnType<typeof settings>} [s] - Settings; read when omitted
 * @returns {void}
 * @throws {ChannelError} 401 when the token is missing or wrong; 503 when the channel is off
 */
function authorizeHelper(req, s = settings()) {
  const token = _bearer(req);
  if (!token || !token.startsWith(TOKEN_PREFIX) || !s.tokenHash) {
    throw new ChannelError(401, 'UNAUTHORIZED', 'A valid operator channel token is required');
  }
  const a = Buffer.from(_hash(token), 'hex');
  const b = Buffer.from(s.tokenHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ChannelError(401, 'UNAUTHORIZED', 'A valid operator channel token is required');
  }
  if (!s.enabled) throw new ChannelError(503, 'CHANNEL_DISABLED', 'The operator channel is turned off');
}

/**
 * What `lib/medusa.js` needs to run the channel's listener. The workspace id
 * is kept in the Medusa registry under the store's own directory, so it
 * survives restarts and the target project always answers the same address.
 * @returns {{projectPath: string, sessionId: string, name: string}}
 */
function channelTarget() {
  return { projectPath: path.join(store._getBasePath(), 'operator-channel'), sessionId: CHANNEL_KEY, name: CHANNEL_NAME };
}

/**
 * Make the listener match the setting: running exactly while the channel is enabled.
 * @param {object} [options]
 * @param {(url: string) => object} [options.wsFactory] - Socket factory seam (tests)
 * @returns {{state: string, workspaceId: (string|null)}}
 */
function sync(options = {}) {
  if (settings().enabled) {
    return medusa.startSession({ ...channelTarget(), wsFactory: options.wsFactory || _internal.wsFactory });
  }
  medusa.stopSession(CHANNEL_KEY);
  return medusa.getStatus(CHANNEL_KEY);
}

/**
 * Accept one operator message from the helper. Idempotent on the message id:
 * the same id again returns the first record and changes nothing.
 * @param {object} body - `{message: {id, authorId, spaceId, channelId}, text}`
 * @param {ReturnType<typeof settings>} [s] - Settings; read when omitted
 * @returns {{status: number, body: object}}
 * @throws {ChannelError} 400 malformed, 403 not allowlisted, 409 no target, 413 too long, 429 rate limited
 */
function acceptInbound(body, s = settings()) {
  const b = body && typeof body === 'object' ? body : {};
  const m = b.message && typeof b.message === 'object' ? b.message : {};
  for (const k of ['id', 'authorId', 'spaceId', 'channelId']) {
    if (typeof m[k] !== 'string' || !EXTERNAL_ID_RE.test(m[k])) {
      throw new ChannelError(400, 'BAD_MESSAGE', `message.${k} must be 1-64 letters, digits, _ or -`);
    }
  }
  const al = s.allowlist;
  if (!al.authorId || !al.spaceId || !al.channelId) {
    throw new ChannelError(403, 'NOT_ALLOWLISTED', 'The operator channel has no allowlist, so it accepts nothing');
  }
  if (m.authorId !== al.authorId || m.spaceId !== al.spaceId || m.channelId !== al.channelId) {
    throw new ChannelError(403, 'NOT_ALLOWLISTED', 'That author, space or channel is not the allowlisted one');
  }
  // A replay is answered from its record before anything that could have
  // changed since it was first accepted (the text, the target, the rate), so
  // the helper is never told a message it already handed over was refused.
  const replay = store.operatorChannel.getInboundByExternalId(m.id);
  if (replay) return { status: 200, body: { inbound: inboundView(replay), duplicate: true } };
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) throw new ChannelError(400, 'EMPTY_MESSAGE', 'text is required');
  if (text.length > MAX_TEXT_LENGTH) {
    throw new ChannelError(413, 'MESSAGE_TOO_LONG', `text must be at most ${MAX_TEXT_LENGTH} characters`);
  }
  const project = s.targetProject ? store.projects.getByName(s.targetProject) : null;
  if (!project) throw new ChannelError(409, 'NO_TARGET', 'The operator channel has no target project configured');

  const now = _internal.now();
  const since = new Date(now.getTime() - INBOUND_RATE.windowMs).toISOString();
  if (store.operatorChannel.countInboundSince(since) >= INBOUND_RATE.max) {
    throw new ChannelError(429, 'RATE_LIMITED', `At most ${INBOUND_RATE.max} messages a minute`);
  }
  const { row, inserted } = store.operatorChannel.insertInbound({
    external_id: m.id,
    author_id: m.authorId,
    space_id: m.spaceId,
    channel_id: m.channelId,
    target_project_id: project.id,
    text,
    created_at: now.toISOString()
  });
  if (inserted) {
    log.info('Operator channel message accepted', { inboundId: row.id, targetProjectId: project.id });
    schedulePump();
  }
  return { status: inserted ? 202 : 200, body: { inbound: inboundView(row), duplicate: !inserted } };
}

/**
 * An inbound row as the helper and operator see it: never its text.
 * @param {object} row - Raw row
 * @returns {object}
 */
function inboundView(row) {
  return {
    id: row.id,
    messageId: row.external_id,
    state: row.state,
    attempts: row.attempts,
    hubId: row.hub_id,
    exchangeId: row.exchange_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * The target project's live session workspace, or null when there is none to deliver to.
 * @param {number} projectId - Target project id
 * @returns {string|null}
 */
function _liveTargetWorkspace(projectId) {
  const active = store.sessions.getActive(projectId);
  if (!active) return null;
  const status = medusa.getStatus(active.id);
  return status.state !== 'off' && status.workspaceId ? status.workspaceId : null;
}

/**
 * Deliver one pending inbound row.
 *
 * `wait-target` means the row's project has no live session (or its send was
 * refused and will be retried): later rows for that project wait too, so one
 * project's messages keep their order, while other projects' rows still go.
 * `wait-channel` means the channel's own listener is down, and nothing can go.
 * @param {object} row - Pending inbound row
 * @returns {Promise<'done'|'wait-target'|'wait-channel'>}
 */
async function _deliverOne(row) {
  const to = _internal.liveTargetWorkspace(row.target_project_id);
  if (!to) return 'wait-target';
  const at = () => _internal.now().toISOString();
  // A refused send is known not to be on the Hub, so the next attempt may use
  // a fresh request id. An attempt that was interrupted before it settled was
  // never counted, so it retries under the SAME id and meets the exchange
  // record's duplicate guard instead of reaching the Hub a second time.
  const requestId = `operator-channel:${row.external_id}:${row.attempts}`;
  let out;
  try {
    out = await _internal.sendTracked({
      sessionId: CHANNEL_KEY,
      senderProjectId: null,
      caller: { kind: 'unbound' },
      body: { to, message: `${STAMP} ${row.text}`, requestId }
    });
  } catch (err) { // prawduct:allow prawduct/broad-except -- the pump outlives any one send; the row stays pending and the error is kept on it
    // Whether the Hub got it is unknown, so the attempt is not spent: the retry
    // reuses this request id and meets the duplicate guard if an intent exists.
    store.operatorChannel.settleInbound(row.id, { state: 'pending', error: err.message, countAttempt: false, at: at() });
    log.warn('Operator channel send threw; will retry', { inboundId: row.id, error: err.message });
    return 'wait-target';
  }
  const b = out.body || {};
  const ex = b.exchange || null;
  if (out.status === 200 && b.id) {
    store.operatorChannel.settleInbound(row.id, { state: 'sent', hubId: b.id, exchangeId: ex ? ex.exchangeId : null, at: at() });
    log.info('Operator channel message delivered to the Hub', { inboundId: row.id, hubId: b.id });
    return 'done';
  }
  if (b.code === 'NOT_LISTENING') {
    store.operatorChannel.settleInbound(row.id, { state: 'pending', error: 'the operator channel listener is not running', countAttempt: false, at: at() });
    return 'wait-channel';
  }
  if (b.code === 'SEND_ALREADY_ATTEMPTED' || (ex && ex.state === 'send_unknown')) {
    store.operatorChannel.settleInbound(row.id, {
      state: 'send_unknown', exchangeId: ex ? ex.exchangeId : (b.details && b.details.exchangeId) || null,
      error: 'the Hub may or may not have this message; it will not be sent again', at: at()
    });
    log.warn('Operator channel send outcome unknown; not resending', { inboundId: row.id });
    return 'done';
  }
  const retryable = out.status >= 500 || out.status === 409;
  const exhausted = row.attempts + 1 >= MAX_SEND_ATTEMPTS;
  store.operatorChannel.settleInbound(row.id, {
    state: retryable && !exhausted ? 'pending' : 'failed',
    exchangeId: ex ? ex.exchangeId : null,
    error: `${b.code || out.status}: ${b.error || 'send refused'}`,
    at: at()
  });
  log.warn('Operator channel send refused', { inboundId: row.id, status: out.status, code: b.code, failed: !retryable || exhausted });
  return retryable && !exhausted ? 'wait-target' : 'done';
}

/**
 * Record a message the channel's listener received. Called from the server's
 * arrival observer for every listener; anything not addressed to the channel
 * is ignored. The Hub copy is acknowledged once the row is durable, so the
 * Hub stops redelivering it.
 * @param {{sessionKey: string, workspaceId: string, message: object}} arrival
 * @returns {object|null} The outbound row, or null when the arrival is not the channel's
 */
function recordArrival({ sessionKey, message }) {
  if (sessionKey !== CHANNEL_KEY || !message || typeof message.id !== 'string') return null;
  const raw = typeof message.message === 'string' ? message.message : null;
  // Longer than any route lets a session send, so it did not come through
  // TangleClaw; kept as a record without its text, and never relayed.
  const oversized = raw !== null && raw.length > MAX_REPLY_LENGTH;
  const at = _internal.now().toISOString();
  let { row } = store.operatorChannel.insertOutbound({
    hub_id: message.id,
    from_workspace_id: typeof message.from === 'string' ? message.from : null,
    text: oversized ? null : raw,
    received_at: at
  });
  if (oversized) row = store.operatorChannel.resolveOutbound(row.id, { state: 'quarantined', reason: 'too-long', at });
  medusa.markHandled(CHANNEL_KEY, [message.id]);
  return row;
}

/**
 * Decide what each unverified received message is.
 *
 * A message is relayable only when TangleClaw recorded its send as coming
 * from the target project. Anything else — another project, or mail no send
 * on this host made — is quarantined and its text dropped, because the Bridge
 * accepts any local caller's `from` and the helper must never post it.
 * @param {ReturnType<typeof settings>} [s] - Settings; read when omitted
 * @returns {number} How many rows were resolved
 */
function resolveOutbound(s = settings()) {
  const project = s.targetProject ? store.projects.getByName(s.targetProject) : null;
  const now = _internal.now();
  let n = 0;
  for (const row of store.operatorChannel.listOutbound('unverified', 200)) {
    const at = now.toISOString();
    const sent = store.medusaExchanges.getByHubId(row.hub_id, 'send');
    if (sent) {
      const inbound = sent.in_reply_to ? store.operatorChannel.getInboundByExchangeId(sent.in_reply_to) : null;
      // From the current target, or a reply from the project a channel message
      // was actually delivered to: a message accepted before the target changed
      // still goes to its original project, so that project's answer is wanted.
      const fromTarget = project && sent.sender_project_id === project.id;
      const answersOurs = inbound && sent.sender_project_id === inbound.target_project_id;
      if (fromTarget || answersOurs) {
        store.operatorChannel.resolveOutbound(row.id, { state: 'relayable', replyToInboundId: inbound ? inbound.id : null, at });
      } else {
        store.operatorChannel.resolveOutbound(row.id, { state: 'quarantined', reason: 'not-from-target-project', at });
        log.warn('Operator channel quarantined a message from outside the target project', { outboundId: row.id });
      }
      n += 1;
    } else if (now.getTime() - Date.parse(row.received_at) > QUARANTINE_AFTER_MS) {
      store.operatorChannel.resolveOutbound(row.id, { state: 'quarantined', reason: 'no-tracked-send', at });
      log.warn('Operator channel quarantined a message no TangleClaw send made', { outboundId: row.id });
      n += 1;
    }
  }
  return n;
}

/**
 * The replies waiting for the helper, oldest first. Resolves first, so a
 * reply whose send bound a moment ago is not held back a whole tick.
 * @returns {Array<{id: number, text: string, inReplyTo: ({messageId: string}|null), receivedAt: string}>}
 */
function listRelayable() {
  resolveOutbound();
  return store.operatorChannel.listOutbound('relayable', 50).map((row) => {
    const inbound = row.reply_to_inbound_id != null ? store.operatorChannel.getInbound(row.reply_to_inbound_id) : null;
    return { id: row.id, text: row.text, inReplyTo: inbound ? { messageId: inbound.external_id } : null, receivedAt: row.received_at };
  });
}

/**
 * The helper has posted a reply. Only a relayable reply moves, once; a second
 * ack for the same row is answered from its record.
 * @param {number} id - Outbound row id
 * @param {object} body - `{postedId}`: the helper's id for what it posted
 * @returns {{status: number, body: object}}
 * @throws {ChannelError} 400 malformed, 404 unknown, 409 not relayable
 */
function acknowledge(id, body) {
  const postedId = body && body.postedId;
  if (typeof postedId !== 'string' || !EXTERNAL_ID_RE.test(postedId)) {
    throw new ChannelError(400, 'BAD_ACK', 'postedId must be 1-64 letters, digits, _ or -');
  }
  const current = Number.isInteger(id) ? store.operatorChannel.getOutbound(id) : null;
  if (!current) throw new ChannelError(404, 'NOT_FOUND', 'No reply has that id');
  if (current.state === 'delivered') return { status: 200, body: { id, state: 'delivered', duplicate: true } };
  if (current.state !== 'relayable') throw new ChannelError(409, 'NOT_RELAYABLE', `That reply is ${current.state}`);
  const { changed } = store.operatorChannel.deliverOutbound(id, postedId, _internal.now().toISOString());
  return { status: 200, body: { id, state: 'delivered', duplicate: !changed } };
}

/**
 * Deliver what can be delivered and resolve what can be resolved.
 *
 * One pass runs at a time. A call made while a pass is running asks for one
 * more pass after it and returns a promise for both, so a message accepted
 * mid-pass is never left for the next tick by a pass that listed its rows
 * before the message existed.
 * @returns {Promise<{sent: number, resolved: number}>}
 */
function pump() {
  if (_pumping) {
    _pumpAgain = true;
    return _pumping;
  }
  _pumping = (async () => {
    const total = { sent: 0, resolved: 0 };
    try {
      do {
        _pumpAgain = false;
        const pass = await _pumpPass();
        total.sent += pass.sent;
        total.resolved += pass.resolved;
      } while (_pumpAgain);
      return total;
    } finally {
      _pumping = null;
    }
  })();
  return _pumping;
}

/**
 * One pump pass: send pending messages in order until one must wait, then
 * resolve received ones.
 * @returns {Promise<{sent: number, resolved: number}>}
 */
async function _pumpPass() {
  let sent = 0;
  if (!settings().enabled) return { sent, resolved: 0 };
  // Each batch leaves out the projects already found waiting, so however many
  // messages one offline project has queued, the next project's rows are
  // reached. Every row handled either leaves `pending` or adds its project to
  // `waiting`, so each batch makes progress; the cap bounds one pass.
  const waiting = new Set();
  let stopped = false;
  for (let batch = 0; batch < MAX_PUMP_BATCHES && !stopped; batch += 1) {
    const rows = store.operatorChannel.listPendingInbound(50, [...waiting]);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (waiting.has(row.target_project_id)) continue;
      const outcome = await _deliverOne(row);
      if (store.operatorChannel.getInbound(row.id).state === 'sent') sent += 1;
      if (outcome === 'wait-channel') { stopped = true; break; }
      if (outcome === 'wait-target') waiting.add(row.target_project_id);
    }
  }
  return { sent, resolved: resolveOutbound() };
}

/**
 * Run a pump pass soon, without waiting for it.
 * @returns {void}
 */
function schedulePump() {
  setImmediate(() => {
    pump().catch((err) => log.warn('Operator channel pump failed', { error: err.message }));
  });
}

/**
 * Start the listener (when enabled) and the periodic pump. Idempotent.
 * @returns {void}
 */
function start() {
  sync();
  if (_pumpTimer) return;
  _pumpTimer = setInterval(schedulePump, PUMP_INTERVAL_MS);
  if (typeof _pumpTimer.unref === 'function') _pumpTimer.unref();
  schedulePump();
}

/**
 * Stop the periodic pump and the listener.
 * @returns {void}
 */
function stop() {
  if (_pumpTimer) clearInterval(_pumpTimer);
  _pumpTimer = null;
  medusa.stopSession(CHANNEL_KEY);
}

/**
 * The channel's state for the operator: settings (no secrets), the listener,
 * and how many messages sit in each state.
 * @returns {object}
 */
function status() {
  return { settings: publicSettings(settings()), listener: medusa.getStatus(CHANNEL_KEY), counts: store.operatorChannel.counts() };
}

module.exports = {
  CHANNEL_KEY,
  CHANNEL_NAME,
  TOKEN_PREFIX,
  MAX_TEXT_LENGTH,
  INBOUND_RATE,
  QUARANTINE_AFTER_MS,
  MAX_SEND_ATTEMPTS,
  STAMP,
  ChannelError,
  settings,
  publicSettings,
  updateSettings,
  rotateToken,
  presentsChannelToken,
  authorizeHelper,
  channelTarget,
  sync,
  acceptInbound,
  inboundView,
  recordArrival,
  resolveOutbound,
  listRelayable,
  acknowledge,
  pump,
  start,
  stop,
  status,
  _internal
};
