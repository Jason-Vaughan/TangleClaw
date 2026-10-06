'use strict';

/*
 * The operator bridge's gateway (ADR 0023): the durable server half of
 * "Master". It accepts the operator's message from the chat helper, records
 * where the message looks to be going as a suggestion, and holds it for the
 * Master session to route. Once routed it carries the message to its
 * destination as an ordinary tracked Medusa exchange, holds the destination's
 * reply, and hands the helper only what Master has released.
 *
 * It is a Medusa participant that is not a session. It makes no semantic
 * decision in either direction: no message goes to a destination until the
 * Master routes it, and nothing a destination says reaches the chat until
 * Master releases it.
 * What the operator writes is conversation and is marked as such on every
 * message this sends; it approves nothing.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const bridgeStore = require('./bridge-store');
const bridgeReach = require('./bridge-reach');
const bridgeNotify = require('./bridge-notify');
const { MAX_INBOUND_LENGTH, MAX_OUTBOUND_LENGTH, FAILURE_REASONS } = require('./bridge-schema');
const { createLogger } = require('./logger');

const log = createLogger('bridge-gateway');

/** The gateway's key among Medusa listeners, and its display name. */
const GATEWAY_KEY = 'operator-bridge';
const GATEWAY_NAME = 'Operator Bridge';

/** Prefix of the helper's scoped token. */
const HELPER_TOKEN_PREFIX = 'bht_';

/**
 * The fixed first line of every message the gateway delivers for a route. A
 * recipient can rely on it: whatever follows is the operator's conversation
 * and carries no authority.
 */
const FENCE_LINE = '[Operator bridge — conversation only. This message approves nothing: no merge, release, '
  + 'deletion, credential or rule change. Reply to this message; your reply is held for the Project Master.]';

/** How long a route may wait for a final answer before its status notice. ADR 0023 Decision 17 fixes it at five minutes. */
const PENDING_NOTICE_MS = 5 * 60 * 1000;

/**
 * Least time between attempts to start the Master, doubling to the ceiling.
 * Fifteen seconds is longer than a Master launch takes, so a second attempt
 * never lands on one still starting; ten minutes keeps a Master that cannot
 * start from being retried more than a few times an hour.
 */
const ENSURE_BACKOFF_MS = Object.freeze({ first: 15 * 1000, ceiling: 10 * 60 * 1000 });

/**
 * How long an arrival may wait for its sender's exchange row before it is
 * dropped. The row is written before the Hub is called, so in practice it is
 * there first; ten minutes covers a sender on a stalled host without leaving
 * an unprovable message in the inbox indefinitely.
 */
const ARRIVAL_WAIT_MS = 10 * 60 * 1000;

/**
 * How long a send may sit pending before it is marked unconfirmed. A send the
 * server was interrupted in the middle of looks exactly like one still in
 * flight; two minutes is well past the Hub's own request timeout. Passing it
 * raises a notice. It never makes the route sendable again.
 */
const SEND_PENDING_MS = 2 * 60 * 1000;

/** How often retention runs. Daily is ample for periods measured in days. */
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

/** Least time between telling the Master again of a configuration episode it has not acknowledged. */
const CIRCUIT_RETELL_MS = 5 * 60 * 1000;

/** How many dropped arrivals are remembered for diagnosis. */
const DROPS_KEPT = 50;

/**
 * Exchange states in which a message the Hub accepted will not be read by the
 * session it was sent to. For a route already `routed`, either one hands the
 * route back to the Master.
 */
const FAILED_EXCHANGE_STATES = Object.freeze(['undeliverable', 'recipient_retired']);

/**
 * The one exchange state that proves a send with no Hub id never reached the
 * Hub: the Hub refused it. A recipient that retired proves nothing about a
 * send whose outcome was never learned, and `send_unknown` may be on the Hub.
 */
const REFUSED_BY_HUB = 'undeliverable';

/** The failure code of a route whose send could not be confirmed either way. */
const SEND_UNCONFIRMED = 'send-unconfirmed';

/** The address that always means the Project Master. No alias may take it. */
const RESERVED_ADDRESS = 'master';

/** The shape of a Hub message id an exchange can carry. */
const HUB_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Chat ids are short opaque strings. */
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Seams, so tests drive the real logic without a Hub, tmux or a clock. */
const _deps = {
  /**
   * The launch route's own warm-up, done before the bridge launches: it reads
   * the network and can take many seconds, so nothing is decided across it.
   * @param {object} project - The project row.
   * @returns {Promise<void>}
   */
  warmForLaunch: (project) => require('./launch-warmup').warmForLaunch(project),
  /**
   * Start a session for a project through the function the launch route
   * calls, as that route would for a request with no body: the project's
   * saved engine, mode and settings, and no override of any of them.
   * Synchronous, so that the checks made immediately before it still hold
   * when it runs.
   * @param {object} project - The project row.
   * @returns {object} What `sessions.launchSession` returned.
   */
  launchSession: (project) => require('./sessions').launchSession(project.name, { primePrompt: true, owner: null }),
  sessions: () => require('./sessions'),
  controlState: () => require('./control-state'),
  medusa: () => require('./medusa'),
  medusaSend: () => require('./medusa-send'),
  exchanges: () => require('./medusa-exchanges'),
  master: () => require('./master'),
  now: () => new Date().toISOString(),
  /** The machine's own clock, in ms: for how long this process has been at something, which a test's moved clock must not shorten. */
  wallClock: () => Date.now(),
  id: (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`
};

const _state = {
  ensureNextAt: 0, ensureDelay: 0, lastPruneAt: 0, arrivalsFirstSeen: new Map(), mastersTold: new Set(), noListenerLogged: new Set(),
  inFlight: new Map(), dropped: 0, drops: [],
  /**
   * When the pass over the launches now running began, or 0 when none is. A
   * second pass does not start beside it, unless it has run past any length a
   * pass can honestly take: one that never returns must not stop all the rest.
   */
  launchingSince: 0
};

/** Longer than a launch pass can honestly take: its warm-up is bounded in seconds, and the rest is synchronous. */
const LAUNCH_PASS_MAX_MS = 5 * 60 * 1000;

/**
 * The conversation a route belongs to: its channel, and its thread when it has one.
 * @param {{channelId: string, threadId: (string|null)}} context - A route's chat context.
 * @returns {string}
 */
function conversationKey(context) {
  return context.threadId ? `${context.channelId}:${context.threadId}` : context.channelId;
}

/**
 * The operator's allowlist: the one author, space and channel the bridge
 * accepts. Null until all three are set.
 * @returns {{authorId: string, spaceId: string, channelId: string}|null}
 */
function allowlist() {
  const authorId = bridgeStore.settings.get('allow.author');
  const spaceId = bridgeStore.settings.get('allow.space');
  const channelId = bridgeStore.settings.get('allow.channel');
  return authorId && spaceId && channelId ? { authorId, spaceId, channelId } : null;
}

/**
 * Mint a helper token. Only its hash is stored; the caller shows the value once.
 * @returns {{tokenId: string, token: string}}
 */
function mintHelperToken() {
  const tokenId = _deps.id('bht');
  const token = HELPER_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  bridgeStore.helperTokens.replace(tokenId, bridgeStore.digest(token), { at: _deps.now() });
  return { tokenId, token };
}

/**
 * Whether a presented helper token is the active one.
 * @param {*} presented - The header value as received.
 * @returns {{tokenId: string}|null}
 */
function verifyHelperToken(presented) {
  if (typeof presented !== 'string' || !/^bht_[A-Za-z0-9_-]{43}$/.test(presented)) return null;
  return bridgeStore.helperTokens.findActive(bridgeStore.digest(presented));
}

/**
 * Where the gateway's Medusa registry lives.
 * @returns {{projectPath: string, sessionId: string, name: string}}
 */
function gatewayTarget() {
  return { projectPath: path.join(store._getBasePath(), 'bridge-gateway'), sessionId: GATEWAY_KEY, name: GATEWAY_NAME };
}

/**
 * Make the gateway's listener match the one rule it follows: it listens
 * exactly while the bridge is enabled.
 * @param {object} [options]
 * @param {Function} [options.wsFactory] - Socket factory seam (tests).
 * @returns {{state: string, workspaceId: (string|null)}}
 */
function syncListener(options = {}) {
  const medusa = _deps.medusa();
  if (bridgeStore.settings.isEnabled()) {
    return medusa.startSession({ ...gatewayTarget(), wsFactory: options.wsFactory });
  }
  medusa.stopSession(GATEWAY_KEY);
  return medusa.getStatus(GATEWAY_KEY);
}

/**
 * The gateway's own workspace id, or null when it is not listening.
 * @returns {string|null}
 */
function gatewayWorkspaceId() {
  return _deps.medusa().getStatus(GATEWAY_KEY).workspaceId || null;
}

/**
 * Apply a transition the gateway itself decides. The request id is derived
 * from the route and its version, so a step repeated after a restart is the
 * same request and is applied once.
 * @param {string} op - Operation name.
 * @param {object} route - The route as last read.
 * @param {(route: object) => object} change - The decision.
 * @param {object} [options]
 * @param {string} [options.actor='gateway'] - Who acted.
 * @param {string} [options.proof='gateway'] - How the actor was verified.
 * @returns {{outcome: string, replayed: boolean, route: (object|null)}}
 */
function _step(op, route, change, options = {}) {
  const result = bridgeStore.applyRouteWrite({
    op,
    requestId: `gw:${op}:${route.routeId}:v${route.version}`,
    routeId: route.routeId,
    expectedVersion: route.version,
    actor: options.actor || 'gateway',
    proof: options.proof || 'gateway',
    at: _deps.now(),
    change
  });
  // The route has moved: whatever send it no longer waits on is ended now.
  if (result.outcome === 'applied') settleSends(route.routeId);
  return result;
}

/** What every request id the gateway sends begins with. */
const SEND_REQUEST_PREFIX = 'bridge:';

/**
 * The route a gateway send was for, from its request id.
 * @param {string} requestId - `bridge:<route id>:send<n>`.
 * @returns {string|null}
 */
function _routeOfSend(requestId) {
  const m = /^bridge:(.+):send\d+$/.exec(String(requestId || ''));
  return m ? m[1] : null;
}

/**
 * Whether a route is still waiting on one of the gateway's own sends.
 *
 * It is while the send is the route's current attempt: either the route is
 * still `accepted` and this is the attempt being resolved (its Hub id may yet
 * bind), or the route is `routed` on exactly this message. Then the exchange
 * has to stay open, because the wake monitor nudges a session only for open
 * mail and a retired recipient is recorded only on an open exchange, and both
 * are how the route learns what became of it.
 * @param {object} exchange - One of the gateway's own send exchanges.
 * @returns {boolean}
 */
function _routeWaitsOn(exchange) {
  const routeId = _routeOfSend(exchange.request_id);
  const route = routeId ? bridgeStore.routes.get(routeId) : null;
  if (!route) return false;
  if (route.state === 'accepted') return exchange.request_id === _sendRequestId(routeId);
  if (route.state !== 'routed') return false;
  const sent = bridgeStore.proofs.latestToTarget(routeId);
  return Boolean(sent && exchange.hub_id && sent.hubId === exchange.hub_id);
}

/**
 * End the gateway's own Medusa exchanges that no route is waiting on.
 *
 * The gateway sends an operator's message to a project as a tracked Medusa
 * exchange, and it is the gateway, not a session, that sent it: nobody else
 * may close it and nothing else will. Once the route has moved on (its reply
 * is held, it was rerouted, the Master answered or closed it, or it is gone)
 * the exchange is closed, so nothing is left open that no one is waiting on.
 * The row and its facts stay: a reply that names the message still finds it.
 *
 * Called after every route write the gateway or the Master makes, for that
 * route, and on every pass for all of them, which is also what closes a row a
 * crash left open between the write and the close. Idempotent.
 * @param {string} [routeId] - Only this route's sends; all of them when omitted.
 * @returns {number} How many exchanges were closed.
 */
function settleSends(routeId) {
  let closed = 0;
  let owned;
  try {
    owned = _deps.exchanges().openSystemOwned(GATEWAY_KEY);
  } catch (err) {
    log.warn('Bridge could not list its own exchanges', { error: err.message });
    return 0;
  }
  for (const exchange of owned) {
    if (routeId && _routeOfSend(exchange.request_id) !== routeId) continue;
    try {
      if (_routeWaitsOn(exchange)) continue;
      _deps.exchanges().closeAsSystemOwner(exchange.exchange_id, { kind: 'system', sessionKey: GATEWAY_KEY });
      closed += 1;
    } catch (err) {
      // Ended some other way in the meantime is the same result.
      if (err.code !== 'EXCHANGE_TERMINAL') log.warn('Bridge could not close its own exchange', { exchangeId: exchange.exchange_id, error: err.code || err.message });
    }
  }
  return closed;
}

/**
 * Queue one delivery-failure notice about a route for the operator.
 * Idempotent on its key, so it is posted once however often the condition is seen.
 * @param {string} routeId - Route id.
 * @param {string} what - Which notice: part of the idempotency key.
 * @param {string} text - What to post.
 * @returns {object} The outbound item.
 */
function _notice(routeId, what, text) {
  return bridgeStore.outbound.enqueue({
    idemKey: `route:${routeId}:${what}`, kind: 'failure', routeId, sourceLabel: 'TangleClaw',
    text, digest: bridgeStore.digest(text), at: _deps.now()
  });
}

/**
 * A delivery-failure notice as part of a route write: queued by the same
 * transaction that records the failure, so the two cannot come apart. A
 * server that stops between them would otherwise leave a route that has
 * already failed and an operator who is never told, because no later pass
 * makes that write again.
 * @param {string} routeId - Route id.
 * @param {string} what - Which notice: part of the idempotency key.
 * @param {string} text - What to post.
 * @returns {{idemKey: string, kind: string, sourceLabel: string, text: string, digest: string}} A decision's `outbound`.
 */
function _noticeWith(routeId, what, text) {
  return { idemKey: `route:${routeId}:${what}`, kind: 'failure', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text) };
}

/**
 * Give a route its one status notice, if it has not had one. A route gets a
 * single such notice in its life, whichever reason comes first: that Master
 * is unavailable, or that five minutes have passed.
 * @param {string} routeId - Route id.
 * @param {('pending'|'master-unavailable')} which - Which fixed notice.
 * @returns {boolean} True when this call created it.
 */
function _status(routeId, which) {
  return bridgeStore.outbound.enqueueStatus(routeId, which, { at: _deps.now() }).created;
}

/**
 * Where a message looks to be going, as a suggestion for the Master. It
 * decides nothing: every inbound waits for the Master's own route write, and
 * what is found here is only shown to it (operator ruling, 2026-10-05).
 *
 * In order: an explicit leading `@name`; the route of the message this one
 * replies to, or Master when it replies to a posted message that has no
 * route; a pin on the conversation; the default, which is Master itself.
 * An `@name` that matches nothing, or more than one destination, is never
 * guessed at: there is no suggestion, and the reason is given. A chat
 * application's own mention syntax (`<@123>`) is not an address.
 * @param {object} route - The accepted route.
 * @param {string} text - The operator's message.
 * @returns {{resolvedBy: string, destination: {kind: string, projectId: (number|null)}}|{awaitingMaster: string}}
 */
function suggestDestination(route, text) {
  const addressed = /^@([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?=\s|$)/.exec(String(text).trim());
  if (addressed) {
    const found = _addressed(addressed[1]);
    // The reserved word itself is recorded as that: only a message the operator wrote to @master by
    // name can authorise a nickname change, and a nickname that means the Master is not that.
    if (addressed[1].toLowerCase() === RESERVED_ADDRESS) return { resolvedBy: 'alias', destination: found[0], reserved: true };
    if (found.length === 1) return { resolvedBy: 'alias', destination: found[0] };
    if (found.length) return { awaitingMaster: 'address-ambiguous' };
    // A name that would mean something, were its project within reach, says so: it is not an unknown name.
    return { awaitingMaster: bridgeReach.whyUnnamed(addressed[1]) ? 'address-out-of-reach' : 'address-unresolved' };
  }
  // A reply or a pin can point at a project the bridge may no longer reach.
  // That is not suggested: a suggestion is always something that can be routed to.
  const reachableOrNothing = (resolvedBy, destination) => (
    destination.kind === 'project' && bridgeReach.outOfReach(store.projects.get(destination.projectId))
      ? { awaitingMaster: 'destination-out-of-reach' }
      : { resolvedBy, destination }
  );
  if (route.context.replyToExternalId) {
    // A reply to the operator's own earlier message, or to any message the
    // helper posted for a route, goes where that route went.
    const answered = route.replyContext;
    // A reply to a question the Master asked is the Master's to read, whatever
    // has become of the message it was asked about since.
    if (answered && answered.kind === 'question') return { resolvedBy: 'question-answer', destination: { kind: 'master', projectId: null } };
    const earlier = bridgeStore.routes.getByExternalId(route.context.replyToExternalId)
      || (answered && answered.routeId ? bridgeStore.routes.get(answered.routeId) : null);
    if (earlier && earlier.destination) {
      return reachableOrNothing('reply-inheritance', { kind: earlier.destination.kind, projectId: earlier.destination.projectId });
    }
    // A reply to a posted message that belongs to no route still held (a
    // milestone, a notification, an answer whose route has been removed) is
    // the Master's, as a reply to that item. It is the durable record of the
    // posted message that says what it answers, not a live route, and the
    // resolution says so. It is not an unaddressed message, and a
    // conversation pin does not send it elsewhere.
    if (answered) return { resolvedBy: 'outbound-correlation', destination: { kind: 'master', projectId: null } };
  }
  const pin = bridgeStore.pins.forConversation(conversationKey(route.context));
  if (pin) return reachableOrNothing('pin', pin.destination);
  return { resolvedBy: 'default', destination: { kind: 'master', projectId: null } };
}

/**
 * Every distinct destination an explicit address names, among what the bridge
 * may reach: the reserved `master`, a nickname, a project by its exact name
 * without regard to case, by its slug, or by its id. One result is an
 * address; none or several is not. The same resolver the Master's own route
 * write is held to, so what is suggested is something that can be routed to.
 * @param {string} name - The token after `@`.
 * @returns {{kind: string, projectId: (number|null)}[]}
 */
function _addressed(name) {
  if (name.toLowerCase() === RESERVED_ADDRESS) return [{ kind: 'master', projectId: null }];
  return bridgeReach.named(name);
}

/**
 * Accept one inbound operator message from the helper.
 *
 * Refused before anything is stored when the bridge is disabled or the
 * message is not from the allowlisted author, space and channel. Idempotent
 * on the chat's own message id: a replay returns the same route.
 * @param {object} message
 * @param {string} message.externalId - The chat's own message id.
 * @param {string} message.authorId - Chat author id.
 * @param {string} message.spaceId - Chat space id.
 * @param {string} message.channelId - Chat channel id.
 * @param {string|null} [message.threadId] - Chat thread id.
 * @param {string|null} [message.replyToExternalId] - Message this one answers.
 * @param {string} message.text - The message.
 * @returns {Promise<{status: number, body: object}>}
 */
async function acceptInbound(message) {
  const refuse = (status, code, error) => {
    // A refusal leaves a trace, by code alone: never the message or who sent it.
    if (code !== 'BRIDGE_DISABLED') log.warn('Bridge refused an inbound message', { code });
    return { status, body: { error, code } };
  };
  if (!bridgeStore.settings.isEnabled()) return refuse(409, 'BRIDGE_DISABLED', 'The operator bridge is disabled.');
  const allowed = allowlist();
  if (!allowed) return refuse(409, 'ALLOWLIST_NOT_SET', 'The operator has not set the bridge allowlist.');
  const m = message || {};
  for (const field of ['externalId', 'authorId', 'spaceId', 'channelId']) {
    if (typeof m[field] !== 'string' || !CHAT_ID.test(m[field])) return refuse(400, 'BAD_INBOUND', `Missing or malformed ${field}.`);
  }
  for (const field of ['threadId', 'replyToExternalId']) {
    if (m[field] != null && (typeof m[field] !== 'string' || !CHAT_ID.test(m[field]))) return refuse(400, 'BAD_INBOUND', `Malformed ${field}.`);
  }
  if (m.authorId !== allowed.authorId || m.spaceId !== allowed.spaceId || m.channelId !== allowed.channelId) {
    // Counted, and nothing of the message kept.
    bridgeStore.audit.append({ op: 'inbound', actor: 'helper', proof: 'helper-token', outcome: 'not-allowlisted', at: _deps.now() });
    return refuse(403, 'NOT_ALLOWLISTED', 'That author, space or channel is not on the bridge allowlist.');
  }
  if (typeof m.text !== 'string' || !m.text.trim()) return refuse(400, 'BAD_INBOUND', 'The message has no text.');
  if (m.text.length > MAX_INBOUND_LENGTH) return refuse(413, 'INBOUND_TOO_LONG', `A message may be at most ${MAX_INBOUND_LENGTH} characters.`);

  // A message cannot carry the id of one the helper itself posted.
  if (bridgeStore.parts.find(m.externalId)) {
    return refuse(409, 'EXTERNAL_ID_COLLISION', 'That message id belongs to a message the bridge posted.');
  }
  const accepted = bridgeStore.routes.accept({
    routeId: _deps.id('rt'), externalId: m.externalId, authorId: m.authorId, spaceId: m.spaceId, channelId: m.channelId,
    threadId: m.threadId ?? null, replyToExternalId: m.replyToExternalId ?? null,
    text: m.text, digest: bridgeStore.digest(m.text), at: _deps.now()
  });
  if (accepted.mismatch) {
    return refuse(409, 'EXTERNAL_ID_MISMATCH', 'That message id was already received with a different body or from a different place.');
  }
  if (!accepted.created) return { status: 200, body: { routeId: accepted.route.routeId, state: accepted.route.state, replayed: true } };

  bridgeStore.audit.append({
    op: 'inbound', actor: 'helper', proof: 'helper-token', routeId: accepted.route.routeId, outcome: 'accepted', at: _deps.now()
  });
  const route = await advance(accepted.route.routeId);
  return { status: 202, body: { routeId: route.routeId, state: route.state, replayed: false } };
}

/**
 * Carry a route as far as it can go without Master: hand an undecided one to
 * the Master with a suggestion, and dispatch one the Master has routed. Safe to call at any time and after a restart;
 * every step is applied once.
 *
 * One route is advanced by one caller at a time. Dispatch waits on the Hub
 * between reading the route and recording what happened, and the helper's
 * request, Master's routing and the periodic pass can all arrive for the same
 * route; without this a second caller would act on a send still in flight.
 * @param {string} routeId - Route id.
 * @returns {Promise<object|null>} The route afterwards.
 */
function advance(routeId) {
  const before = _state.inFlight.get(routeId) || Promise.resolve();
  const run = before.catch(() => {}).then(() => _advance(routeId));
  _state.inFlight.set(routeId, run);
  return run.finally(() => {
    if (_state.inFlight.get(routeId) === run) _state.inFlight.delete(routeId);
  });
}

/**
 * The work of {@link advance}, for one caller at a time.
 * @param {string} routeId - Route id.
 * @returns {Promise<object|null>} The route afterwards.
 */
async function _advance(routeId) {
  let route = bridgeStore.routes.get(routeId);
  if (!route) return null;
  // A route nobody has decided goes to the Master, every time. Where it looks
  // to be going is recorded beside it as a suggestion and nothing more: an
  // address, a reply, a pin and the default never send a message anywhere.
  // Only the Master's route write gives a route a destination, and that
  // decision is never second-guessed here.
  if (route.state === 'accepted' && !route.destination) {
    const inbound = bridgeStore.routes.body(routeId, 'inbound');
    const found = suggestDestination(route, inbound && inbound.text ? inbound.text : '');
    route = _step('suggest', route, () => ({
      set: { state: 'awaiting-master', failure_code: found.awaitingMaster || null },
      detail: found.awaitingMaster
        ? { by: null, to: null, projectId: null, reason: found.awaitingMaster }
        : { by: found.resolvedBy, to: found.destination.kind, projectId: found.destination.kind === 'project' ? found.destination.projectId : null, reason: null, ...(found.reserved ? { reserved: true } : {}) }
    })).route;
  }
  if (route.state === 'accepted' && route.destination) route = await dispatch(route);
  if (_needsMaster(route)) route = await _summonMaster(route);
  return route;
}

/**
 * Whether a route is waiting on the Master session: to route it, to answer it
 * as its destination, or to release a reply held for it.
 * @param {object} route - A route.
 * @returns {boolean}
 */
function _needsMaster(route) {
  return route.state === 'awaiting-master' || route.state === 'queued-master-unavailable' || route.state === 'reply-held'
    || (route.state === 'routed' && !!route.destination && route.destination.kind === 'master')
    || (route.state === 'accepted' && route.failureCode === SEND_UNCONFIRMED);
}

/**
 * Apply a gateway step to a route whose version may have moved while the
 * gateway was waiting on the Hub (Master can pin a conversation at any time).
 * The step is re-decided against the route as it now is, a bounded number of
 * times.
 * @param {string} op - Operation name.
 * @param {string} routeId - Route id.
 * @param {(route: object) => object} change - The decision; it sees the current route.
 * @returns {{outcome: string, replayed: boolean, route: (object|null)}}
 */
function _stepCurrent(op, routeId, change) {
  let result = { outcome: 'route-not-found', replayed: false, route: null };
  for (let attempt = 0; attempt < 3; attempt++) {
    const route = bridgeStore.routes.get(routeId);
    if (!route) return result;
    result = _step(op, route, change);
    if (result.outcome !== 'version-conflict') return result;
  }
  return result;
}

/**
 * The request id of a route's current send attempt. It moves on only when an
 * attempt is settled: recorded as sent, or proven not to have been delivered.
 * A send whose outcome is unknown is never settled, so its id stays, the
 * existing exchange is found under it at every later pass and after every
 * restart, and the message is never sent a second time.
 * @param {string} routeId - Route id.
 * @returns {string}
 */
function _sendRequestId(routeId) {
  const settled = bridgeStore.audit.forRoute(routeId).filter((a) => (a.op === 'dispatch' || a.op === 'target-failed') && a.outcome === 'applied').length;
  return `${SEND_REQUEST_PREFIX}${routeId}:send${settled + 1}`;
}

/**
 * Send a resolved route to its destination. A project destination gets a
 * tracked, reply-required Medusa message; Master as the destination gets the
 * route itself, to answer through `tc bridge`.
 *
 * Exactly once. The send is looked up before it is made, and what is found
 * decides what happens:
 * - no exchange after trying: nothing was sent, and the route goes back to
 *   Master to route again;
 * - an exchange with a Hub id: the message is on the Hub, and it is recorded;
 * - a Hub id in the send's own answer that the row could not take: the id is
 *   kept, the row is bound again on this and every later pass, and the route
 *   is recorded as sent once it is;
 * - an exchange the Hub refused: the route goes back to Master;
 * - anything else: the outcome is not known. The route stays where it is,
 *   marked unconfirmed after two minutes, and is not sent again by anybody.
 *   Master can answer it or close it; only a proven failure reopens routing.
 *
 * Only an exchange the gateway itself sent counts. One found under the
 * attempt's request id that the gateway does not own was made by somebody
 * else: it is never adopted, no proof is recorded from it, and the route goes
 * back to Master. The next attempt has a new request id.
 * @param {object} route - A resolved route in `accepted`.
 * @returns {Promise<object>} The route afterwards.
 */
async function dispatch(route) {
  if (route.destination.kind === 'master') {
    return _step('dispatch', route, () => ({ set: { state: 'routed' }, detail: { to: 'master' } })).route || route;
  }
  const requestId = _sendRequestId(route.routeId);
  let exchange = store.medusaExchanges.getByRequestId(requestId);
  if (exchange && !_isOwnSend(exchange)) return _notOurSend(route, exchange);
  let answeredHubId = null;
  let target = null;
  if (!exchange) {
    // Asked again at the send: a route can sit accepted across a restart, and
    // its project can have gone out of reach in between.
    if (bridgeReach.outOfReach(store.projects.get(route.destination.projectId))) {
      return _returnToMaster(route, 'destination-out-of-reach', 'could not be sent: its project is no longer within reach of the bridge');
    }
    target = _targetWorkspace(route.destination.projectId);
    if (!target && bridgeReach.liveness(route.destination.projectId).state === 'several-live') {
      return _returnToMaster(route, 'target-ambiguous', 'could not be sent: its project has more than one live session');
    }
    if (!target) return _returnToMaster(route, 'target-offline', 'has no live session to receive it');
    // A message sent on by a consented launch goes to the session that
    // launch waited for, and to no other that has taken its place since. This
    // binds that one send, by the record: the write that put the route where
    // it is now is that launch's own. A later decision of the Master's about
    // the same message is a new write, and is not held to a launch long over.
    const moved = bridgeStore.audit.lastApplied(route.routeId);
    const launched = moved && moved.op === 'launch-dispatch' ? bridgeStore.launches.get(moved.detail.launchSeq) : null;
    if (launched && launched.state === 'dispatched' && launched.routeId === route.routeId
      && launched.projectId === route.destination.projectId
      && (target.sessionId !== launched.sessionId || target.launchId !== launched.launchId)) {
      return _returnToMaster(route, 'identity-changed', 'could not be sent to the session that was launched for it');
    }
    const inbound = bridgeStore.routes.body(route.routeId, 'inbound');
    try {
      const sent = await _deps.medusaSend().sendTracked({
        sessionId: GATEWAY_KEY,
        senderProjectId: null,
        caller: { kind: 'system' },
        body: { to: target.workspaceId, message: `${FENCE_LINE}\n\n${inbound ? inbound.text : ''}`, replyRequired: true, requestId }
      });
      // The Hub's own answer names the message even when the exchange row
      // could not be updated to say so.
      if (sent && sent.status === 200 && sent.body && typeof sent.body.id === 'string') answeredHubId = sent.body.id;
      else if (sent && sent.body && sent.body.code) log.warn('Bridge dispatch was not accepted', { routeId: route.routeId, code: sent.body.code });
    } catch (err) {
      log.warn('Bridge dispatch failed', { routeId: route.routeId, error: err.code || err.message });
    }
    exchange = store.medusaExchanges.getByRequestId(requestId);
    if (exchange && !_isOwnSend(exchange)) return _notOurSend(route, exchange);
  }
  // No exchange was ever made for this attempt: the send was refused before
  // the Hub was called, so nothing can be on it.
  if (!exchange) return _returnToMaster(route, 'send-failed', 'could not be sent');

  if (!exchange.hub_id) {
    // The Hub may have named the message in an answer the exchange row never
    // took: now, or on an earlier pass that recorded it. A route may rest in
    // `routed` only on an exchange that carries its Hub id, because the
    // target's reply and every later failure are found through that id. So
    // the row is bound first, and the route waits unconfirmed until it is.
    // An id the exchange could never store is not kept and not retried:
    // binding it would fail again on every pass, each time leaving a fact.
    const storable = answeredHubId && HUB_ID.test(answeredHubId) ? answeredHubId : null;
    if (answeredHubId && !storable) log.warn('Bridge was answered with a message id it cannot store', { routeId: route.routeId });
    const known = storable || _answeredHubId(route.routeId, requestId);
    if (known) {
      if (storable) _rememberHubAnswer(route, requestId, storable);
      try {
        _deps.exchanges().bindHubId(exchange.exchange_id, known, { hubStatus: 'received', deliveredTo: exchange.recipient_workspace_id });
        exchange = store.medusaExchanges.getByRequestId(requestId);
      } catch (err) {
        log.warn('Bridge could not bind a sent message to its exchange', { routeId: route.routeId, error: err.message });
      }
    }
  }
  const hubId = exchange.hub_id;
  if (!hubId) {
    if (exchange.state === REFUSED_BY_HUB) {
      return _returnToMaster(route, 'exchange-undeliverable', 'did not reach its destination');
    }
    const waited = Date.parse(_deps.now()) - Date.parse(exchange.created_at);
    if (exchange.state === 'send_pending' && waited < SEND_PENDING_MS && !answeredHubId) return bridgeStore.routes.get(route.routeId) || route;
    return _markUnconfirmed(route);
  }

  // Who it went to is what the exchange recorded when it was sent, not who
  // the project's live session happens to be now.
  const sentTo = target && target.workspaceId === exchange.recipient_workspace_id ? target : _recipientOf(exchange);
  // On the Hub, but to nobody the gateway can name now: a reply could never be
  // matched to the session it was sent to, so the route cannot rest in `routed`.
  if (!sentTo) return _markUnconfirmed(route, 'recipient-unknown');
  const recorded = _stepCurrent('dispatch', route.routeId, (current) => {
    if (current.state !== 'accepted' || !current.destination || current.destination.projectId !== route.destination.projectId) {
      return { refuse: 'no-longer-dispatchable', detail: { state: current.state } };
    }
    return {
      set: { state: 'routed', destination_workspace_id: sentTo.workspaceId, failure_code: null },
      proof: {
        direction: 'to-target', hubId, exchangeId: exchange.exchange_id, senderProof: 'gateway',
        targetProjectId: route.destination.projectId, targetWorkspaceId: sentTo.workspaceId,
        targetSessionId: sentTo.sessionId, targetLaunchId: sentTo.launchId
      },
      detail: { to: 'project', projectId: route.destination.projectId }
    };
  });
  return recorded.route || route;
}

/**
 * Whether an exchange is one the gateway itself sent: verified system
 * provenance, the gateway's listener as sender, and a request id it makes.
 * @param {object} exchange - An exchange row.
 * @returns {boolean}
 */
function _isOwnSend(exchange) {
  return _deps.exchanges().systemOwnerOf(exchange) === GATEWAY_KEY;
}

/**
 * An exchange somebody else made sits under a route's send request id. The
 * route is returned to Master and nothing is taken from that exchange: not its
 * Hub id, not its recipient, and no proof.
 * @param {object} route - The route being dispatched.
 * @param {object} exchange - The exchange that is not the gateway's.
 * @returns {Promise<object>} The route afterwards.
 */
function _notOurSend(route, exchange) {
  log.warn('Bridge found an exchange it did not send under a route\'s request id', { routeId: route.routeId, exchangeId: exchange.exchange_id });
  return _returnToMaster(route, 'request-id-collision', 'could not be sent');
}

/**
 * Record, durably, the message id the Hub answered a send with when the
 * exchange row could not take it. The audit is the one place that survives a
 * restart and is never compacted while the route is open.
 * @param {object} route - The route.
 * @param {string} requestId - The attempt's request id.
 * @param {string} hubId - The Hub's id for the message.
 * @returns {void}
 */
function _rememberHubAnswer(route, requestId, hubId) {
  if (_answeredHubId(route.routeId, requestId)) return;
  bridgeStore.audit.append({
    op: 'hub-answer', actor: 'gateway', proof: 'gateway', routeId: route.routeId, outcome: 'recorded',
    detail: { requestId, hubId }, at: _deps.now()
  });
}

/**
 * The message id the Hub answered an attempt with, if one was recorded.
 * @param {string} routeId - Route id.
 * @param {string} requestId - The attempt's request id.
 * @returns {string|null}
 */
function _answeredHubId(routeId, requestId) {
  const row = bridgeStore.audit.forRoute(routeId).find((a) => a.op === 'hub-answer' && a.detail && a.detail.requestId === requestId);
  return row ? row.detail.hubId : null;
}

/**
 * Exactly who an exchange was sent to, from the exchange itself.
 * @param {object} exchange - A `medusa_exchanges` row the gateway sent.
 * @returns {{workspaceId: string, sessionId: number, launchId: string}|null}
 *   Null when the row does not name a session with a known launch.
 */
function _recipientOf(exchange) {
  const sessionId = Number(exchange.recipient_session_id);
  if (!exchange.recipient_workspace_id || !Number.isInteger(sessionId) || sessionId <= 0) return null;
  const launchId = _launchOf(sessionId);
  return launchId ? { workspaceId: exchange.recipient_workspace_id, sessionId, launchId } : null;
}

/**
 * Mark a route's send as unconfirmed, once. The route keeps its destination
 * and its place: this records that nobody knows whether the message arrived,
 * and it does not make the route routable again.
 *
 * There are two ways to get here and the operator is told which. Either the
 * outcome of the send is not known, or the send is known to have reached the
 * switchboard but the session it went to can no longer be named, so a reply
 * could not be accepted from it. Neither is sent again.
 * @param {object} route - The route.
 * @param {('outcome-unknown'|'recipient-unknown')} [cause] - Why the send cannot be confirmed.
 * @returns {object} The route afterwards.
 */
function _markUnconfirmed(route, cause = 'outcome-unknown') {
  if (route.failureCode === SEND_UNCONFIRMED) return route;
  const result = _stepCurrent('send-unconfirmed', route.routeId, (current) => (
    current.state !== 'accepted' || current.failureCode === SEND_UNCONFIRMED
      ? { refuse: 'not-applicable' }
      : {
        set: { failure_code: SEND_UNCONFIRMED },
        outbound: _noticeWith(route.routeId, 'send-unconfirmed', UNCONFIRMED_NOTICE[cause]),
        detail: { cause }
      }
  ));
  return result.route || route;
}

/** What the operator is told when a send cannot be confirmed, by cause. */
const UNCONFIRMED_NOTICE = Object.freeze({
  'outcome-unknown': 'It is not known whether your message reached its destination. It has not been sent again. The Project Master will follow up.',
  'recipient-unknown': 'Your message was handed over, but the session it went to can no longer be identified, so its reply could not be accepted. '
    + 'It has not been sent again. The Project Master will follow up.'
});

/**
 * The launch a session is running under, as the server recorded it.
 * @param {number|string} sessionId - Session id.
 * @returns {string|null}
 */
function _launchOf(sessionId) {
  const sequence = store.launchSequences.getBySession(Number(sessionId));
  return sequence ? sequence.launchId : null;
}

/**
 * Exactly who a project's message would go to: its live session's workspace,
 * that session and its launch. Null unless all three are known, because a
 * reply can only be accepted from a target that was fully named.
 * @param {number} projectId - Project id.
 * @returns {{workspaceId: string, sessionId: number, launchId: string}|null}
 */
function _targetWorkspace(projectId) {
  // The one answer to "can a message be sent to this project": exactly one
  // session with a listener and a launch record. None, or more than one, and
  // nothing is named: which of two a message is for is never guessed.
  const standing = bridgeReach.liveness(projectId);
  if (standing.state !== 'live') return null;
  const sessionId = standing.listening[0];
  const workspaceId = _deps.medusa().getStatus(sessionId).workspaceId;
  const launchId = _launchOf(sessionId);
  return workspaceId && launchId ? { workspaceId, sessionId, launchId } : null;
}

/**
 * Hand a route that could not be delivered back to Master, and tell the
 * operator once. The destination is cleared so Master names the next one.
 * @param {object} route - The route.
 * @param {string} code - Closed failure code.
 * @param {string} words - How the notice describes it.
 * @returns {Promise<object>} The route afterwards.
 */
async function _returnToMaster(route, code, words) {
  const result = _stepCurrent('target-failed', route.routeId, (current) => {
    if (current.state === 'closed' || current.state === 'released') return { refuse: 'already-answered' };
    return {
      set: {
        state: 'awaiting-master', failure_code: code, resolved_by: null, destination_kind: null,
        destination_project_id: null, destination_workspace_id: null, resolved_generation: null
      },
      // Keyed on the version this write makes, so each failure of a message
      // that is routed again has a notice of its own.
      outbound: _noticeWith(route.routeId, `failure:${code}:v${current.version + 1}`,
        `Your message ${words}. It is waiting for the Project Master to route it.`),
      detail: { code }
    };
  });
  return result.route || route;
}

// One listener map for both: a test that stands in for the Hub here stands in for it there too.
bridgeReach._deps.medusa = () => _deps.medusa();

/** The closed launch code for each reason a project is out of the bridge's reach. */
const LAUNCH_UNREACHABLE = Object.freeze({
  unknown: 'project-gone', archived: 'project-archived', 'opted-out': 'project-opted-out',
  'out-of-scope': 'project-out-of-scope', 'scope-unresolved': 'scope-unresolved'
});

/** How long a launched session has to become READY before the launch is given up (operator ruling, 2026-10-05). */
const READY_WAIT_MS = 10 * 60 * 1000;

/**
 * The fixed sentence the operator is sent when a consented launch did not end
 * in their message being sent on. The code is one of a closed list; nothing
 * anybody typed is in it.
 * @param {string} code - The closed failure code.
 * @returns {string}
 */
function _launchFailedText(code) {
  return `I could not get a session ready for your message (${code}). Your message is still held, and nothing was sent on.`;
}

/**
 * Why a session must not be launched for a project, or waited on, right now:
 * a closed code, or null when nothing stands in the way. Asked immediately
 * before a launch and again on every pass while one is awaited, because any of
 * these can change in between.
 * @param {number} projectId - The project consent was given for.
 * @returns {{code: string, project: null}|{code: null, project: object}}
 */
function _launchRefusal(projectId) {
  const project = store.projects.get(projectId);
  // The one answer to "may the bridge reach this project", asked afresh.
  const why = bridgeReach.outOfReach(project);
  if (why) return { code: LAUNCH_UNREACHABLE[why], project: null };
  let lane;
  try {
    lane = _deps.controlState().blockingOf(store.control.getOpenForProject(projectId));
  // prawduct:allow prawduct/broad-except -- a control store that cannot be read is one answer here: not proven clear, so nothing is launched
  } catch {
    return { code: 'control-unavailable', project: null };
  }
  if (lane && lane.blocked) return { code: lane.stopped ? 'stopped' : 'held', project: null };
  const wrap = _deps.sessions().getWrapRunStatus(project.name);
  if (wrap && wrap.running) return { code: 'wrap-running', project: null };
  return { code: null, project };
}

/**
 * End a launch as failed: the operator and the Master are told the closed
 * code, the message goes back to waiting for the Master with that code on it,
 * and no other target is tried. A session that did start is left running.
 * @param {object} launch - The launch.
 * @param {string} code - The closed failure code.
 * @returns {void}
 */
function _launchFailed(launch, code) {
  if (!bridgeStore.launches.end(launch.launchSeq, 'failed', code, _deps.now())) return;
  log.warn('Bridge launch failed', { routeId: launch.routeId, launchSeq: launch.launchSeq, projectId: launch.projectId, code });
  const moved = _stepCurrent('launch-failed', launch.routeId, (current) => (
    bridgeStore.HELD_ROUTE_STATES.includes(current.state)
      ? { set: { failure_code: code.slice(0, 40) }, detail: { launchSeq: launch.launchSeq, code } }
      : { refuse: 'not-held' }
  ));
  if (moved.outcome === 'applied' && !moved.replayed) _notice(launch.routeId, `launch-failed:${launch.launchSeq}`, _launchFailedText(code));
}

/**
 * Take the next consented launch in turn and start it: launch a session for
 * its project, or take the one already live as the one to wait for. Every
 * condition is asked again here, immediately before acting.
 * @param {object} launch - A queued launch.
 * @returns {Promise<void>}
 */
async function _beginLaunch(launch) {
  // Asked once before the warm-up, only so that a launch already known to be
  // refused costs no network; what decides is the asking after it.
  const early = _launchRefusal(launch.projectId);
  if (early.code) return _launchFailed(launch, early.code);
  try {
    await _deps.warmForLaunch(early.project);
  // prawduct:allow prawduct/broad-except -- the warm-up never rejects by contract; if it does, the launch is not made on facts it could not gather
  } catch (err) {
    log.warn('Bridge launch warm-up threw', { routeId: launch.routeId, launchSeq: launch.launchSeq, error: err && (err.code || err.name) });
    return _launchFailed(launch, 'launch-error');
  }
  // From here to the launch itself nothing is awaited: every condition is
  // asked immediately before the launch, in the same synchronous step, so
  // none can change in between.
  // A message that stopped being held during the warm-up took its launch
  // with it: the store abandons a launch in the write that takes its route
  // out of the Master's hands. So the launch's own row is what is read here.
  const current = bridgeStore.launches.get(launch.launchSeq);
  if (!current || current.state !== 'queued') return;
  if (!bridgeStore.settings.isEnabled()) {
    bridgeStore.launches.end(launch.launchSeq, 'abandoned', 'bridge-disabled', _deps.now());
    return;
  }
  const { code, project } = _launchRefusal(launch.projectId);
  if (code) return _launchFailed(launch, code);
  // A session that is already live (a manual start won the race, or an
  // earlier launch for another message did) is waited on, and nothing is launched.
  const live = store.sessions.getActive(launch.projectId);
  if (live) {
    const launchId = _launchOf(live.id);
    if (!launchId) return _launchFailed(launch, 'identity-unknown');
    bridgeStore.launches.begin(launch.launchSeq, { sessionId: live.id, launchId, startedSession: false, at: _deps.now() });
    return;
  }
  let result;
  try {
    result = _deps.launchSession(project);
  // prawduct:allow prawduct/broad-except -- whatever the launch threw, the answer is one closed code and no retry
  } catch (err) {
    log.warn('Bridge launch threw', { routeId: launch.routeId, launchSeq: launch.launchSeq, error: err && (err.code || err.name) });
    return _launchFailed(launch, 'launch-error');
  }
  // What `sessions.launchSession` answers: `session` on success, `error` (and
  // sometimes a `code`) on a refusal, `webui` for an engine that is not a pane.
  // Only its own closed code is passed on; its prose is not.
  const sessionId = result && result.session ? result.session.id : null;
  if (!result || result.error || result.webui || !Number.isInteger(sessionId)) {
    const why = result && result.webui ? 'WEBUI_ENGINE' : (result && typeof result.code === 'string' && /^[A-Z_]{1,40}$/.test(result.code) ? result.code : 'REFUSED');
    return _launchFailed(launch, `launch-refused:${why}`);
  }
  const launchId = _launchOf(sessionId);
  if (!launchId) {
    // The session exists and the launch record cannot name it: said in the log, since the failed row has no session.
    log.warn('Bridge started a session it cannot bind to a launch', { routeId: launch.routeId, launchSeq: launch.launchSeq, sessionId });
    return _launchFailed(launch, 'identity-unknown');
  }
  try {
    bridgeStore.launches.begin(launch.launchSeq, { sessionId, launchId, startedSession: true, at: _deps.now() });
  } catch (err) {
    // The session is running and could not be recorded as the one waited for. Said, with its id, and thrown on:
    // the caller ends the launch, and the session is left as it is.
    log.warn('Bridge started a session and could not record it', { routeId: launch.routeId, launchSeq: launch.launchSeq, sessionId, error: err.code || err.message });
    throw err;
  }
}

/**
 * Judge the launch in flight. The message is sent on only when all of these
 * hold at once: nothing refuses the project; the session the launch names is
 * still the project's active one; its launch sequence carries the launch id
 * recorded and is READY; its recovery gate is not withheld; and the server
 * itself holds a Medusa listener for it. READY is an unauthenticated
 * attestation, so it is one condition and never the proof alone: the identity
 * is the session row the server wrote and the listener the server holds.
 * @param {object} launch - The launch in `waiting-ready`.
 * @returns {Promise<boolean>} True when the message was sent on.
 */
async function _awaitLaunch(launch) {
  const { code } = _launchRefusal(launch.projectId);
  if (code) { _launchFailed(launch, code); return false; }
  const active = store.sessions.getActive(launch.projectId);
  if (!active || active.id !== launch.sessionId) { _launchFailed(launch, 'identity-changed'); return false; }
  const sequence = store.launchSequences.getBySession(launch.sessionId);
  if (!sequence || sequence.launchId !== launch.launchId) { _launchFailed(launch, 'identity-changed'); return false; }
  // A session whose launch has no sequence to attest can never say it is
  // READY. Said at once, not after the wait: the session is running, and the
  // Master can route to it by its own decision.
  if (sequence.applicability !== 'applicable') { _launchFailed(launch, 'ready-not-applicable'); return false; }
  const target = _targetWorkspace(launch.projectId);
  const ready = Boolean(sequence.readyAt)
    && !(sequence.recovery === 'required' && sequence.recoveryMode !== 'advisory')
    && Boolean(target) && target.sessionId === launch.sessionId && target.launchId === launch.launchId;
  if (!ready) {
    if (Date.parse(_deps.now()) - Date.parse(launch.startedAt) > READY_WAIT_MS) _launchFailed(launch, 'ready-timeout');
    return false;
  }
  // The Master's decision, made when it adopted the consent, takes effect
  // now: the original message goes to that project, as it was written.
  const sent = _stepCurrent('launch-dispatch', launch.routeId, (current) => {
    if (!bridgeStore.HELD_ROUTE_STATES.includes(current.state)) return { refuse: 'not-held' };
    return {
      set: {
        state: 'accepted', resolved_by: 'master', destination_kind: 'project', destination_project_id: launch.projectId,
        resolved_generation: launch.masterGeneration, failure_code: null
      },
      settleLaunch: { launchSeq: launch.launchSeq },
      detail: { to: 'project', projectId: launch.projectId, sessionId: launch.sessionId }
    };
  });
  if (sent.outcome !== 'applied') return false;
  await advance(launch.routeId);
  return true;
}

/**
 * One pass over the consented launches: judge the one in flight, and if none
 * is, begin the next in the order consent was adopted. One launch is in
 * flight on the install at a time; the rest wait their turn, and each is
 * judged afresh when its turn comes.
 * @returns {Promise<{begun: number, dispatched: number}>}
 */
async function _advanceLaunches() {
  const out = { begun: 0, dispatched: 0 };
  // A launch's warm-up can outlast the interval between passes. A pass that
  // found another still at work would begin the same launch beside it.
  const started = _deps.wallClock();
  if (_state.launchingSince && started - _state.launchingSince < LAUNCH_PASS_MAX_MS) return out;
  if (_state.launchingSince) log.warn('Bridge launch pass did not return; another is starting', { since: new Date(_state.launchingSince).toISOString() });
  _state.launchingSince = started;
  try {
    const flying = bridgeStore.launches.unsettled().find((l) => l.state === 'waiting-ready');
    if (flying) {
      try {
        if (await _awaitLaunch(flying)) out.dispatched += 1;
      } catch (err) {
        // Whatever kept it from being judged, a launch does not outlive its wait: nothing behind it is held up for good.
        log.warn('Bridge could not judge a launch', { routeId: flying.routeId, launchSeq: flying.launchSeq, error: err.code || err.message });
        if (Date.parse(_deps.now()) - Date.parse(flying.startedAt) > READY_WAIT_MS) _launchFailed(flying, 'launch-error');
      }
    }
    // One at a time: the next begins only once nothing is in flight. Each
    // queued launch is looked at once in a pass, in order. One that could not
    // be begun is ended, like any other failure, and the next takes its turn;
    // if even that cannot be written, the pass stops and the next one tries again.
    for (const next of bridgeStore.launches.unsettled().filter((l) => l.state === 'queued')) {
      if (bridgeStore.launches.unsettled().some((l) => l.state === 'waiting-ready')) break;
      try {
        await _beginLaunch(next);
        out.begun += 1;
      } catch (err) {
        log.warn('Bridge could not begin a launch', { routeId: next.routeId, launchSeq: next.launchSeq, error: err.code || err.message });
        try {
          _launchFailed(next, 'launch-error');
        } catch (again) {
          log.warn('Bridge could not end a launch it could not begin', { launchSeq: next.launchSeq, error: again.code || again.message });
          break;
        }
      }
    }
  } finally {
    // Only the pass that holds the mark clears it: one that was given up on must not clear its successor's.
    if (_state.launchingSince === started) _state.launchingSince = 0;
  }
  return out;
}

/**
 * Record, once each time it changes, whether the Master's scope can be
 * resolved. An unresolved scope reaches no project, and that is put on the
 * audit and in the log so that an empty list of destinations is never the
 * only sign of it.
 * @returns {void}
 */
function _noteScope() {
  const read = bridgeReach.scope();
  const now = read.kind === 'unresolved' ? 'scope-unresolved' : 'scope-resolved';
  // The record is read once per process; after that what this process last
  // wrote is what the record says, and a pass costs no query.
  if (_state.scopeNoted === undefined) _state.scopeNoted = bridgeStore.audit.lastScope();
  const was = _state.scopeNoted;
  // Never recorded and resolved is the ordinary state of things: nothing to say.
  if (was === now || (was === null && now === 'scope-resolved')) return;
  bridgeStore.audit.append({
    op: 'scope', actor: 'gateway', proof: 'gateway', outcome: now,
    detail: { reachable: bridgeReach.reachable().projects.length, cause: read.cause || null }, at: _deps.now()
  });
  _state.scopeNoted = now;
  if (now === 'scope-unresolved') log.warn('Bridge scope is unresolved, so no project is reachable', { cause: read.cause });
  else log.info('Bridge scope is resolved again');
}

/**
 * Make sure the Master session exists and knows a route is waiting. Rate
 * limited and backed off, never a restart loop; when Master cannot be had a
 * route awaiting its decision is queued, and the operator is told once.
 * @param {object} route - A route that needs the Master session.
 * @returns {Promise<object>} The route afterwards.
 */
async function _summonMaster(route) {
  const master = _deps.master();
  const now = Date.parse(_deps.now());
  let live = master.masterLiveness().live === true;
  if (!live && now >= _state.ensureNextAt) {
    _state.ensureDelay = _state.ensureDelay ? Math.min(_state.ensureDelay * 2, ENSURE_BACKOFF_MS.ceiling) : ENSURE_BACKOFF_MS.first;
    _state.ensureNextAt = now + _state.ensureDelay;
    const ensured = master.ensureMasterSession();
    live = !ensured.error;
    if (ensured.error) log.warn('Bridge could not ensure the Project Master', { error: ensured.error });
  }
  if (live) _state.ensureDelay = 0;

  if (!live) {
    _status(route.routeId, 'master-unavailable');
    if (route.state !== 'awaiting-master') return route;
    return _step('queue', route, () => ({ set: { state: 'queued-master-unavailable' } })).route || route;
  }
  let current = route;
  if (route.state === 'queued-master-unavailable') {
    current = _step('unqueue', route, () => ({ set: { state: 'awaiting-master' } })).route || route;
  }
  await _tellMaster(current);
  return current;
}

/**
 * Tell the Master session what a route needs of it. Told once for each state
 * a route reaches: a route handed back to Master, or one whose reply has just
 * been held, is a new reason and is told again. A notice that could not be
 * sent is not remembered, so the next pass tries again.
 * @param {object} route - A route that needs the Master.
 * @returns {Promise<boolean>} Whether Master has been told of this state.
 */
async function _tellMaster(route) {
  const key = `${route.routeId}:v${route.version}`;
  if (_state.mastersTold.has(key)) return true;
  const workspaceId = _deps.master().getMasterMedusaStatus().workspaceId;
  if (!workspaceId) {
    // Once for each state a route reaches, not on every pass.
    if (!_state.noListenerLogged.has(key)) {
      _state.noListenerLogged.add(key);
      log.warn('Bridge cannot notify the Project Master — it has no Medusa listener', { routeId: route.routeId, state: route.state });
    }
    return false;
  }
  const answers = route.replyContext && !route.replyContext.routeId
    ? ` It is the operator's reply to a posted ${route.replyContext.candidateKind || route.replyContext.notifyType || route.replyContext.kind}.` : '';
  const what = `${route.state === 'reply-held' ? 'has a reply held for your release' : 'is waiting for you'}.${answers}`;
  try {
    await _deps.medusa().sendSystemMessage({
      to: workspaceId,
      message: `Operator bridge: route ${route.routeId} ${what} Run \`tc bridge read ${route.routeId}\`.`
    });
  } catch (err) {
    log.warn('Bridge could not notify the Project Master', { routeId: route.routeId, error: err.code || err.message });
    return false;
  }
  _state.mastersTold.add(key);
  bridgeStore.routes.noteMasterTold(route.routeId, { at: _deps.now() });
  return true;
}

/**
 * How many routes are waiting on the Master without the Master having been
 * told of the state they are in now. A route is told again for each state it
 * reaches, so one told of an earlier state and since moved on is untold.
 * @returns {number}
 */
function routesMasterNotTold() {
  return bridgeStore.routes.list({ states: ['awaiting-master', 'queued-master-unavailable', 'reply-held'] })
    .filter((r) => !r.masterWakeAt || r.masterWakeAt < r.updatedAt).length;
}

/**
 * Tell the Project Master that the configuration circuit is open, until it
 * says it has taken that up. The Master goes on releasing answers while the
 * chat is closed unless it knows, and a release made then is not a delivery.
 *
 * Told at once when an episode is found unacknowledged, then again every
 * {@link CIRCUIT_RETELL_MS} until the Master acknowledges. Both are about the
 * Master generation that is live now. One launched since the last telling is
 * told on the next pass, whether or not its predecessor acknowledged, and
 * until it acknowledges for itself; only repeats to the same generation wait
 * out the interval. Which generation was told is in the store, so a restart
 * neither repeats a notice early nor forgets who has not had one. The notice is a
 * fixed sentence with the episode's number and reason: it carries no text of
 * anything that was to be posted. When the Master has no listener it cannot
 * be told this way; that is logged once per episode, and `tc bridge status`
 * still shows the episode.
 * @returns {Promise<boolean>} Whether the Master was told on this call.
 */
async function _tellMasterOfCircuit() {
  const episode = bridgeStore.circuit.open();
  if (!episode) return false;
  // An acknowledgement is what one Master generation knows. A Master launched
  // since holds none of it, so it is told as one that never acknowledged.
  const live = bridgeStore.masterCredentials.live();
  const acked = episode.masterAckedGeneration !== null && Boolean(live) && episode.masterAckedGeneration === live.generation;
  if (acked) return false;
  const now = Date.parse(_deps.now());
  // The retell interval paces repeats to the same Master. A generation that
  // was not the one told is told on this pass, whatever was told before it.
  const liveGeneration = live ? live.generation : null;
  const toldThisMaster = Boolean(episode.masterToldAt) && episode.masterToldGeneration === liveGeneration;
  if (toldThisMaster && now - Date.parse(episode.masterToldAt) < CIRCUIT_RETELL_MS) return false;
  const workspaceId = _deps.master().getMasterMedusaStatus().workspaceId;
  if (!workspaceId) {
    const key = `circuit:${episode.episodeId}`;
    if (!_state.noListenerLogged.has(key)) {
      _state.noListenerLogged.add(key);
      log.warn('Bridge cannot tell the Project Master of the open configuration circuit: it has no Medusa listener', { episodeId: episode.episodeId });
    }
    return false;
  }
  await _deps.medusa().sendSystemMessage({
    to: workspaceId,
    message: `Operator bridge: the configuration circuit is OPEN (episode ${episode.episodeId}, ${episode.reason}). The chat is not taking posts. `
      + 'Anything you release now only queues: a release is not a delivery. Tell the operator at the workstation, then run '
      + `\`tc bridge circuit ack ${episode.episodeId}\`. It is reset with \`tc bridge reset\` once the chat's configuration is put right.`
  });
  bridgeStore.circuit.noteMasterTold(episode.episodeId, liveGeneration, { at: _deps.now() });
  return true;
}

/**
 * Decide what a message that arrived at the gateway's listener is.
 *
 * It is a route's reply only when the sender's own exchange row proves it: a
 * verified launch, addressed to the gateway, answering exactly the message
 * the bridge last sent for that route, from the very workspace, session and
 * launch that message was sent to. Another session of the same project does
 * not qualify; reaching one takes an explicit reroute. Then
 * it is stored and held. Everything else is dropped and counted; nothing is
 * relayed from here.
 * @param {{id: string, from: string, message?: string, content?: string}} message - The arrived message.
 * @returns {('held'|'waiting'|'dropped')} `waiting` when the sender's row has not bound yet, or the route moved while the reply was being stored.
 */
function considerArrival(message) {
  const drop = (reason, routeId = null) => {
    _state.dropped += 1;
    const entry = { reason, hubId: message && typeof message.id === 'string' ? message.id : null, from: (message && message.from) || null, routeId };
    _state.drops.push(entry);
    if (_state.drops.length > DROPS_KEPT) _state.drops.shift();
    // The message itself is never logged; what identifies it is.
    log.info('Bridge dropped an arrival that is not a route reply', entry);
    return 'dropped';
  };
  if (!message || typeof message.id !== 'string') return drop('malformed');
  if (message.from === 'system') return drop('system-notice');
  if (bridgeStore.proofs.byHubId(message.id)) return 'held';

  const sent = store.medusaExchanges.getByHubId(message.id, 'send');
  if (!sent) {
    const first = _state.arrivalsFirstSeen.get(message.id) || Date.parse(_deps.now());
    _state.arrivalsFirstSeen.set(message.id, first);
    return Date.parse(_deps.now()) - first > ARRIVAL_WAIT_MS ? drop('no-sender-exchange') : 'waiting';
  }
  if (sent.sender_verified !== 1 || sent.sender_proof !== 'launch') return drop('sender-not-a-verified-launch');
  if (sent.recipient_workspace_id !== gatewayWorkspaceId()) return drop('not-addressed-to-the-gateway');
  // A reply names the exchange it answers, not a Hub id: the sender's row
  // was bound to the bridge's own exchange when the reply was sent.
  if (!sent.in_reply_to) return drop('not-a-reply');
  const asked = bridgeStore.proofs.byExchangeId(sent.in_reply_to);
  if (!asked || asked.direction !== 'to-target') return drop('answers-nothing-the-bridge-sent');
  const route = bridgeStore.routes.get(asked.routeId);
  if (!route || route.state !== 'routed') return drop('route-not-awaiting-a-reply', asked.routeId);
  const latest = bridgeStore.proofs.latestToTarget(route.routeId);
  if (!latest || latest.hubId !== asked.hubId) return drop('answers-a-superseded-message', route.routeId);
  // The exact target, not merely its project: the session and launch the
  // message was sent to, speaking from the workspace it was sent to.
  if (!route.destination || route.destination.kind !== 'project' || sent.sender_project_id !== asked.targetProjectId) {
    return drop('sender-is-another-project', route.routeId);
  }
  if (Number(sent.sender_session_id) !== asked.targetSessionId) return drop('sender-is-another-session', route.routeId);
  if (sent.sender_workspace_id !== asked.targetWorkspaceId) return drop('sender-is-another-workspace', route.routeId);
  const launchId = _launchOf(sent.sender_session_id);
  if (!launchId || launchId !== asked.targetLaunchId) return drop('sender-is-another-launch', route.routeId);

  const text = String(message.message ?? message.content ?? '').slice(0, MAX_OUTBOUND_LENGTH);
  if (!text.trim()) return drop('empty-reply', route.routeId);
  const result = _step('reply-held', route, () => ({
    set: { state: 'reply-held' },
    body: { role: 'reply', text, digest: bridgeStore.digest(text) },
    proof: {
      direction: 'from-target', hubId: message.id, exchangeId: sent.exchange_id, inReplyToHubId: asked.hubId,
      senderProof: 'launch', senderProjectId: sent.sender_project_id, senderLaunchId: launchId
    },
    detail: { projectId: sent.sender_project_id }
  }), { actor: 'session', proof: 'launch' });
  if (result.outcome === 'applied' || result.replayed) return 'held';
  // The route moved between being read and being written. That says nothing
  // against the reply: it stays in the inbox and is judged again, against the
  // route as it then is, on the next pass.
  if (result.outcome === 'version-conflict') return 'waiting';
  return drop(`not-applied:${result.outcome}`, route.routeId);
}

/**
 * Go through the gateway's inbox: hold what is a reply, drop what is not, and
 * leave what cannot be judged yet. Called on every arrival and every tick, so
 * a reply whose sender row binds late is picked up without a second message.
 * @returns {{held: number, dropped: number, waiting: number}}
 */
function drainInbox() {
  const medusa = _deps.medusa();
  const counts = { held: 0, dropped: 0, waiting: 0 };
  const settled = [];
  const held = [];
  for (const message of medusa.getMessages(GATEWAY_KEY) || []) {
    const verdict = considerArrival(message);
    counts[verdict] += 1;
    if (verdict !== 'waiting') {
      settled.push(message.id);
      _state.arrivalsFirstSeen.delete(message.id);
    }
    if (verdict === 'held') held.push(message.id);
  }
  if (settled.length) medusa.markHandled(GATEWAY_KEY, settled);
  for (const hubId of held) {
    const proof = bridgeStore.proofs.byHubId(hubId);
    // A held reply waits for Master's release: a new reason to tell it.
    if (proof) advance(proof.routeId).catch((err) => log.warn('Bridge could not advance a held route', { routeId: proof.routeId, error: err.message }));
  }
  return counts;
}

/**
 * The periodic pass: drain the inbox, carry on any route a restart
 * interrupted, turn delivery failures into a notice and a decision for
 * Master, keep Master told, raise the one status notice, enqueue the typed
 * server notifications, and run retention.
 *
 * While the bridge is disabled nothing is sent, started or resolved. Two
 * things still run: retention, so what has outlived it still leaves, and the
 * settling of the gateway's own exchanges that no route waits on. Each route is
 * handled apart from the others, so one that fails does not hold up the rest.
 * @returns {Promise<{advanced: number, failed: number, pendingNotices: number, settled?: number, circuitTold?: boolean, notifications?: object}>}
 */
async function tick() {
  const out = { advanced: 0, failed: 0, pendingNotices: 0 };
  const now = Date.parse(_deps.now());
  try {
    _noteScope();
  } catch (err) {
    log.warn('Bridge could not record its scope', { error: err.message });
  }
  try {
    bridgeStore.expire({ now: _deps.now() });
  } catch (err) {
    log.warn('Bridge could not expire what waited too long', { error: err.message });
  }
  if (now - _state.lastPruneAt >= PRUNE_EVERY_MS) {
    _state.lastPruneAt = now;
    try {
      bridgeStore.prune({ now: _deps.now() });
    } catch (err) {
      log.warn('Bridge retention pass failed', { error: err.message });
    }
  }
  if (!bridgeStore.settings.isEnabled()) {
    // Disabled, nothing is sent, started or resolved. A send no route waits
    // on is still ended: a route that was closed, or let go by retention,
    // while the bridge is off must not leave its exchange open with nobody
    // watching it. A route still waiting on its send keeps it, as when enabled.
    out.settled = settleSends();
    // Nothing is launched for a bridge that is off. A session already started is left as it is.
    for (const launch of bridgeStore.launches.unsettled()) bridgeStore.launches.end(launch.launchSeq, 'abandoned', 'bridge-disabled', _deps.now());
    return out;
  }

  const each = async (routes, work) => {
    for (const route of routes) {
      try {
        await work(route);
      } catch (err) {
        log.warn('Bridge pass failed for a route', { routeId: route.routeId, state: route.state, error: err.message });
      }
    }
  };
  try {
    out.circuitTold = await _tellMasterOfCircuit();
  } catch (err) {
    log.warn('Bridge could not tell the Project Master of the open configuration circuit', { error: err.code || err.message });
  }
  try {
    drainInbox();
  } catch (err) {
    log.warn('Bridge could not drain its inbox', { error: err.message });
  }
  // Before anything is judged: a send no route waits on is ended, including
  // one a crash left open, so it is not re-armed or reported this pass.
  out.settled = settleSends();
  out.notifications = bridgeNotify.reconcile();

  await each(bridgeStore.routes.list({ states: ['routed'] }), async (route) => {
    if (!route.destination || route.destination.kind !== 'project') return;
    const sent = bridgeStore.proofs.latestToTarget(route.routeId);
    const exchange = sent ? store.medusaExchanges.getByHubId(sent.hubId, 'send') : null;
    if (exchange && FAILED_EXCHANGE_STATES.includes(exchange.state)) {
      await _returnToMaster(route, `exchange-${exchange.state.replace(/_/g, '-')}`, 'did not reach its destination');
      out.failed += 1;
    }
  });

  try {
    out.launches = await _advanceLaunches();
  } catch (err) {
    log.warn('Bridge could not advance its launches', { error: err.code || err.message });
  }

  const open = ['accepted', 'awaiting-master', 'queued-master-unavailable', 'routed', 'reply-held'];
  await each(bridgeStore.routes.list({ states: open }), async (route) => {
    const before = `${route.state}:${route.version}`;
    const after = await advance(route.routeId);
    if (after && `${after.state}:${after.version}` !== before) out.advanced += 1;
  });

  await each(bridgeStore.routes.list({ states: open }), async (route) => {
    if (now - Date.parse(route.createdAt) < PENDING_NOTICE_MS) return;
    // While a question about this message is open, "still waiting" would be
    // about the wrong party; once one has run out, its own notice has already
    // said the message is still held. A question that was answered, ended or
    // never posted says nothing of the kind, and does not stand in for this notice.
    if (bridgeStore.questions.operatorWasTold(route.routeId)) return;
    if (_status(route.routeId, 'pending')) out.pendingNotices += 1;
  });

  // What was remembered about routes that are no longer open is of no further use.
  const stillOpen = new Set(bridgeStore.routes.list({ states: [...open, 'released'] }).map((r) => r.routeId));
  const episode = bridgeStore.circuit.open();
  for (const told of [_state.mastersTold, _state.noListenerLogged]) {
    for (const key of told) {
      if (key.startsWith('circuit:') ? !(episode && key === `circuit:${episode.episodeId}`) : !stillOpen.has(key.slice(0, key.lastIndexOf(':v')))) told.delete(key);
    }
  }
  return out;
}

/**
 * An outbound item as the helper needs it: what to post and where.
 * @param {object} item - A stored outbound item.
 * @returns {object}
 */
function _forHelper(item) {
  const route = item.routeId ? bridgeStore.routes.get(item.routeId) : null;
  return {
    outboundId: item.outboundId, kind: item.kind, sourceLabel: item.sourceLabel, text: item.text,
    inReplyTo: route ? { externalId: route.externalId, channelId: route.context.channelId, threadId: route.context.threadId } : null
  };
}

/**
 * Hand the helper what to post next, each item under a lease of its own. The
 * helper has until the lease lapses to post the item and acknowledge it; an
 * item whose lease lapses is handed over again on a later claim.
 *
 * Repeating a claim exactly returns the leases it issued the first time. Only
 * a lease still live carries its item: a helper that asks again must not post
 * what it may no longer acknowledge, and a lease that has lapsed learns
 * nothing of what became of its item.
 * @param {{tokenId: string}} helper - The verified helper token.
 * @param {string} nonce - The request's nonce.
 * @param {object} [options]
 * @param {number} [options.limit] - At most this many.
 * @returns {{status: number, body: object}}
 */
function claimOutbound(helper, nonce, options = {}) {
  if (options.limit !== undefined && !(Number.isInteger(options.limit) && options.limit >= 1 && options.limit <= bridgeStore.MAX_CLAIM)) {
    return { status: 400, body: { error: `A claim's limit is a whole number from 1 to ${bridgeStore.MAX_CLAIM}.`, code: 'BAD_CLAIM' } };
  }
  // While the chat itself is not taking posts, nothing is handed over. This is
  // answered before the claim touches anything: no lease, no hand-over count,
  // no expiry, no nonce spent. A poll in this state changes nothing at all.
  const episode = bridgeStore.circuit.open();
  if (episode) {
    return {
      status: 409,
      body: {
        error: 'The chat is not taking posts. Nothing is handed over until the Project Master or the operator resets the bridge\'s configuration circuit.',
        code: 'BRIDGE_CONFIGURATION_BLOCKED', episodeId: episode.episodeId, reason: episode.reason, since: episode.openedAt
      }
    };
  }
  const claimed = bridgeStore.leases.claim({ nonce, tokenId: helper.tokenId, limit: options.limit, at: _deps.now() });
  if (claimed.outcome === 'nonce-conflict') {
    return { status: 409, body: { error: 'That nonce was already used for a different request.', code: 'NONCE_REUSED' } };
  }
  const items = claimed.leases.map((lease) => {
    const live = lease.state === 'live';
    // A lease that is no longer live comes back as that and nothing more: not
    // the text, not which parts anyone has posted since, not how often the
    // item has been handed over. `used` says only that this very lease sealed
    // its delivery, which is that lease's own receipt.
    if (!live) return { outboundId: lease.item.outboundId, leaseId: lease.leaseId, leaseState: lease.state };
    return {
      ..._forHelper(lease.item),
      leaseId: lease.leaseId, leaseState: lease.state, issuedAt: lease.issuedAt, expiresAt: lease.expiresAt, digest: lease.itemDigest,
      // What an earlier holder already posted, so this one carries on from
      // there, and how many times the item has been handed over.
      postedParts: bridgeStore.parts.forItem(lease.item.outboundId), partCount: bridgeStore.parts.countFor(lease.item.outboundId),
      attempts: lease.item.attempts
    };
  });
  return { status: 200, body: { replayed: claimed.outcome === 'replayed', items } };
}

/**
 * Each way a helper's write about an item is refused: the status and code it
 * answers with, and why. None of them says what became of the item. A caller
 * that does not hold the lease, or holds one that is no longer live, learns
 * nothing of it.
 */
const ITEM_REFUSALS = Object.freeze({
  'lease-not-found': [404, 'LEASE_NOT_FOUND', 'No such lease on that item. A write about an item names the lease it was claimed under.'],
  'lease-not-yours': [403, 'LEASE_NOT_YOURS', 'That lease was issued to a different helper token.'],
  'reference-mismatch': [409, 'ACK_MISMATCH', 'That item was already acknowledged with different messages.'],
  'part-mismatch': [409, 'PART_MISMATCH', 'That does not agree with a part already recorded for the item.'],
  'part-out-of-order': [409, 'PART_OUT_OF_ORDER', 'Parts are recorded in order; an earlier part is missing.'],
  'part-collision': [409, 'PART_ID_COLLISION', 'That message id is already known to the bridge as another message.'],
  // The one answer for every lease that is not live, whatever became of its
  // item: delivered by another, set aside, withdrawn, let go or still waiting.
  'lease-lapsed': [409, 'LEASE_LAPSED', 'That lease is no longer live. If its item is still waiting, it will be handed over again.']
});

/**
 * The refusal a verdict answers with.
 * @param {string} verdict - A key of {@link ITEM_REFUSALS}.
 * @returns {{status: number, body: object}}
 */
function _itemRefusal(verdict) {
  const [status, code, error] = ITEM_REFUSALS[verdict];
  return { status, body: { error, code } };
}

/**
 * Whether a value is a lease id.
 * @param {*} value - Candidate.
 * @returns {boolean}
 */
function _isLeaseId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

const LEASE_REQUIRED = Object.freeze({ status: 400, body: { error: 'A write about an item names the lease it was claimed under.', code: 'LEASE_REQUIRED' } });

/**
 * Record one posted message for an item, the moment the chat confirms it.
 * From then on a reply to that message is known for what it answers, and a
 * helper that picks the item up again is told the part is already posted.
 * @param {number} outboundId - Item id.
 * @param {object} report
 * @param {string} report.leaseId - The lease the item was claimed under.
 * @param {string} report.tokenId - The helper token presenting it.
 * @param {number} report.partIndex - The part's position, from 0.
 * @param {number} report.partCount - How many parts the item is posted as.
 * @param {string} report.externalId - The chat's id for the posted message.
 * @returns {{status: number, body: object}}
 */
function recordPart(outboundId, report = {}) {
  const { partIndex, partCount, externalId } = report;
  if (!Number.isInteger(partCount) || partCount < 1 || partCount > bridgeStore.MAX_PARTS
    || !Number.isInteger(partIndex) || partIndex < 0 || partIndex >= partCount
    || typeof externalId !== 'string' || !CHAT_ID.test(externalId)) {
    return { status: 400, body: { error: `A part names its position, the number of parts (1 to ${bridgeStore.MAX_PARTS}) and the chat's id for the message.`, code: 'BAD_PART' } };
  }
  if (!_isLeaseId(report.leaseId)) return LEASE_REQUIRED;
  const at = _deps.now();
  bridgeStore.leases.lapse({ at });
  const outcome = bridgeStore.transaction(() => bridgeStore.parts.receipt(
    outboundId, { index: partIndex, count: partCount, externalId }, { leaseId: report.leaseId, tokenId: report.tokenId, at }
  ));
  if (outcome !== 'recorded' && outcome !== 'replayed') return _itemRefusal(outcome);
  return { status: 200, body: { outboundId, partIndex, partCount, replayed: outcome === 'replayed' } };
}

/** The fixed sentence the operator is sent when an item is set aside. The server wrote it; it carries nobody's prose. */
const BLOCKED_NOTICE = 'Something for you could not be posted here and has been set aside. The Project Master can put it back or withdraw it.';

/** The fixed sentence recorded for the operator when the chat itself stops taking posts. */
const CIRCUIT_NOTICE = 'The bridge cannot post to its chat channel: the channel or server is missing, or the bot may not post there. Nothing more will be sent until that is put right and the bridge is reset.';

/**
 * Take the helper's report that it could not post an item.
 *
 * The reason is one of a closed list. A reason a retry may fix leaves the
 * item waiting, under the lease it is held under. A reason a retry will not
 * fix sets the item aside and raises one `operator-needed` notice; it stays
 * set aside until the Project Master or the operator puts it back or
 * withdraws it. The helper cannot discard anything.
 *
 * A reason that says the chat itself is not taking posts does more. In the
 * same transaction it sets the item aside and opens the configuration
 * circuit: one episode, one notice for the episode, and from then on no claim
 * hands anything over. A second such report while the episode is open sets
 * its own item aside and raises nothing. The episode ends only when the
 * Project Master or the operator resets it.
 *
 * The parts the helper did post come with the report and are recorded like
 * any other, so a reply to one of them is still known for what it answers.
 * For a refusal of the item itself, the notice raised for an item that was
 * set aside is never itself set aside: a helper that cannot post it either
 * keeps trying. When the chat is closed to everything, whatever was in hand
 * is set aside, that notice included.
 * @param {number} outboundId - Item id.
 * @param {object} report
 * @param {string} report.leaseId - The lease the item was claimed under.
 * @param {string} report.tokenId - The helper token presenting it.
 * @param {string} report.reason - One of `FAILURE_REASONS`.
 * @param {string[]} [report.parts] - The chat's id for each message that did post, in order.
 * @param {number} [report.partCount] - How many parts the item is posted as; required with `parts`.
 * @returns {{status: number, body: object}}
 */
function reportFailure(outboundId, report = {}) {
  const bad = (error) => ({ status: 400, body: { error, code: 'BAD_FAILURE' } });
  const tripping = FAILURE_REASONS.circuit.includes(report.reason);
  const blocking = tripping || FAILURE_REASONS.blocking.includes(report.reason);
  if (!blocking && !FAILURE_REASONS.retryable.includes(report.reason)) {
    return bad(`A failure names its reason: one of ${[...FAILURE_REASONS.retryable, ...FAILURE_REASONS.blocking, ...FAILURE_REASONS.circuit].join(', ')}.`);
  }
  const posted = report.parts === undefined ? [] : report.parts;
  if (!Array.isArray(posted) || posted.length > bridgeStore.MAX_PARTS || posted.some((id) => typeof id !== 'string' || !CHAT_ID.test(id))
    || new Set(posted).size !== posted.length) {
    return bad('The parts that did post are named by the chat\'s id for each, once, in order.');
  }
  if (posted.length && !(Number.isInteger(report.partCount) && report.partCount > posted.length - 1 && report.partCount <= bridgeStore.MAX_PARTS)) {
    return bad('With the parts that posted, a failure says how many parts the item has.');
  }
  if (!_isLeaseId(report.leaseId)) return LEASE_REQUIRED;
  const at = _deps.now();
  const ack = { leaseId: report.leaseId, tokenId: report.tokenId, at };
  bridgeStore.leases.lapse({ at });
  /** A part the bridge will not record: it ends the report, and the transaction undoes whatever the report had written. */
  class PartRefused extends Error {
    /** @param {{status: number, body: object}} refusal - What to answer. */
    constructor(refusal) {
      super('part refused');
      this.refusal = refusal;
    }
  }
  try {
    return _applyFailure();
  } catch (err) {
    if (err instanceof PartRefused) return err.refusal;
    throw err;
  }

  /**
   * Apply the report in one transaction.
   * @returns {{status: number, body: object}}
   */
  function _applyFailure() {
    return bridgeStore.transaction(() => {
    const lease = bridgeStore.outbound.binding(outboundId, ack);
    if (typeof lease === 'string') return _itemRefusal(lease);
    if (!bridgeStore.outbound.live(lease, at)) return _itemRefusal('lease-lapsed');
    for (const [index, externalId] of posted.entries()) {
      const outcome = bridgeStore.parts.receipt(outboundId, { index, count: report.partCount, externalId }, ack);
      if (outcome !== 'recorded' && outcome !== 'replayed') throw new PartRefused(_itemRefusal(outcome));
    }
    const item = bridgeStore.outbound.get(outboundId);
    // For a refusal of the item itself, the notice about a blocked item is
    // the one thing that is never blocked. When the chat is closed to
    // everything, whatever was in hand is set aside, notices included.
    const setAside = blocking && (tripping || !item.idemKey.startsWith('outbound-blocked:'))
      && bridgeStore.outbound.block(outboundId, report.reason, { at });
    const notice = (idemKey, text) => bridgeStore.outbound.enqueue({
      idemKey, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text), at
    });
    const detail = { outboundId, reason: report.reason, leaseId: report.leaseId, parts: posted.length };
    const body = { outboundId, state: setAside ? 'blocked' : 'ready', reason: report.reason };
    if (setAside && tripping) {
      const tripped = bridgeStore.circuit.trip(report.reason, outboundId, { at });
      // One notice for the episode, however many items it catches: the
      // notice is keyed on the episode, and a key that has an item is left alone.
      notice(bridgeStore.circuitNoticeKey(tripped.episode.episodeId), CIRCUIT_NOTICE);
      detail.episodeId = tripped.episode.episodeId;
      detail.opened = tripped.opened;
      if (tripped.opened) {
        log.warn('Bridge configuration circuit OPEN: the chat is not taking posts; nothing is handed to the helper until it is reset', {
          episodeId: tripped.episode.episodeId, reason: report.reason, outboundId
        });
      }
      body.circuit = { episodeId: tripped.episode.episodeId, opened: tripped.opened };
    } else if (setAside) {
      notice(`outbound-blocked:${outboundId}:${item.attempts}`, BLOCKED_NOTICE);
    }
    bridgeStore.audit.append({
      op: 'helper-failure', actor: 'helper', proof: 'helper-token', routeId: item.routeId, outcome: setAside ? 'blocked' : 'retryable', detail, at
    });
    return { status: 200, body };
    });
  }
}

/**
 * Record that the chat confirmed an item was posted. The acknowledgement
 * names the lease the item was claimed under and every message the chat made
 * for it, in order, and is good only from the token that lease was issued to
 * and inside the lease's window. A delivered answer closes its route and
 * clears what was held for it.
 *
 * The set must be whole: as many ids as the count says, each one the chat's
 * id for a message, none twice. One message is the common case, and naming
 * it alone as `deliveredRef` means exactly that.
 * @param {number} outboundId - Item id.
 * @param {string} [deliveredRef] - The chat's id for the first posted message.
 * @param {object} ack
 * @param {string} ack.leaseId - The lease the item was claimed under.
 * @param {string} ack.tokenId - The helper token presenting it.
 * @param {string[]} [ack.parts] - The chat's id for each posted message, in order; `[deliveredRef]` by default.
 * @param {number} [ack.partCount] - How many messages the item was posted as; required with `parts`.
 * @returns {{status: number, body: object}}
 */
function acknowledgeOutbound(outboundId, deliveredRef, ack = {}) {
  const bad = (error) => ({ status: 400, body: { error, code: 'BAD_ACK' } });
  const partIds = ack.parts === undefined ? [deliveredRef] : ack.parts;
  if (!Array.isArray(partIds) || partIds.length < 1 || partIds.length > bridgeStore.MAX_PARTS
    || partIds.some((id) => typeof id !== 'string' || !CHAT_ID.test(id))) {
    return bad(`An acknowledgement names the chat's id for each posted message: 1 to ${bridgeStore.MAX_PARTS} of them.`);
  }
  if (new Set(partIds).size !== partIds.length) return bad('An acknowledgement names each posted message once.');
  if (ack.parts !== undefined && ack.partCount !== partIds.length) {
    return bad('An acknowledgement gives every part: the count and the number of message ids must agree.');
  }
  if (deliveredRef !== undefined && deliveredRef !== partIds[0]) return bad('The first message id is the item\'s reference.');
  if (!_isLeaseId(ack.leaseId)) return LEASE_REQUIRED;
  const at = _deps.now();
  const lease = { leaseId: ack.leaseId, tokenId: ack.tokenId, at };
  bridgeStore.leases.lapse({ at });
  const verdict = bridgeStore.outbound.ackVerdict(outboundId, partIds, lease);
  const done = (replayed) => ({ status: 200, body: { outboundId, state: 'delivered', replayed, parts: partIds.length } });
  if (verdict === 'already-delivered') return done(true);
  if (verdict !== 'deliverable') return _itemRefusal(verdict);

  const item = bridgeStore.outbound.get(outboundId);
  const route = item.kind === 'reply' && item.routeId ? bridgeStore.routes.get(item.routeId) : null;
  if (route && route.state === 'released') {
    // One transaction: the item is delivered, its lease settled and its route
    // closed and cleared together, or none of it is.
    const result = bridgeStore.applyRouteWrite({
      op: 'delivered', requestId: `gw:delivered:${route.routeId}:${outboundId}`, routeId: route.routeId,
      expectedVersion: route.version, actor: 'helper', proof: 'helper-token', at,
      change: () => ({
        set: { state: 'closed', closed_by: 'gateway', closed_at: at },
        deliver: { outboundId, partIds, leaseId: ack.leaseId, tokenId: ack.tokenId }, clearBodies: true,
        detail: { outboundId, leaseId: ack.leaseId, parts: partIds.length }
      })
    });
    if (result.outcome !== 'applied') {
      // On the record like the other path below, by ids and outcome only.
      log.warn('Bridge acknowledgement was not applied', { outboundId, routeId: route.routeId, outcome: result.outcome });
      return { status: 409, body: { error: `The acknowledgement was not applied: ${result.outcome}.`, code: 'ACK_NOT_APPLIED' } };
    }
    return done(result.replayed);
  }
  // Only what the store says happened is reported: an item that was not there
  // to be delivered is never answered as delivered.
  const marked = bridgeStore.transaction(() => bridgeStore.outbound.markDelivered(outboundId, partIds, lease));
  if (marked.outcome !== 'delivered') {
    // On the record, by id and outcome only: the helper reads this answer as the item no longer being its to deliver.
    log.warn('Bridge acknowledgement was not applied', { outboundId, outcome: marked.outcome });
    return { status: 409, body: { error: `The acknowledgement was not applied: ${marked.outcome}.`, code: 'ACK_NOT_APPLIED' } };
  }
  return done(false);
}

/**
 * Forget what the gateway holds in memory. For tests.
 * @returns {void}
 */
function _reset() {
  _state.ensureNextAt = 0;
  _state.ensureDelay = 0;
  _state.lastPruneAt = 0;
  _state.arrivalsFirstSeen.clear();
  _state.mastersTold.clear();
  _state.noListenerLogged.clear();
  _state.inFlight.clear();
  _state.dropped = 0;
  _state.drops = [];
  _state.launchingSince = 0;
  _state.scopeNoted = undefined;
}

// The gateway owns the exchanges it sends: it ends them itself, and the
// watchdog does not raise them while they are normal mail, which is all the
// gateway sends (ADR 0023 Decision 17).
require('./medusa-exchanges').declareSystemOwner(GATEWAY_KEY, { requestIdPrefix: SEND_REQUEST_PREFIX });

module.exports = {
  GATEWAY_KEY,
  FENCE_LINE,
  PENDING_NOTICE_MS,
  SEND_PENDING_MS,
  SEND_UNCONFIRMED,
  HELPER_TOKEN_PREFIX,
  CHAT_ID,
  conversationKey,
  allowlist,
  droppedArrivals: () => ({ count: _state.dropped, recent: _state.drops.slice() }),
  mintHelperToken,
  verifyHelperToken,
  gatewayTarget,
  syncListener,
  gatewayWorkspaceId,
  suggestDestination,
  liveTarget: (projectId) => _targetWorkspace(projectId),
  READY_WAIT_MS,
  acceptInbound,
  advance,
  dispatch,
  considerArrival,
  drainInbox,
  tick,
  settleSends,
  claimOutbound,
  recordPart,
  reportFailure,
  BLOCKED_NOTICE,
  CIRCUIT_NOTICE,
  CIRCUIT_RETELL_MS,
  routesMasterNotTold,
  acknowledgeOutbound,
  _deps,
  _state,
  _reset
};
