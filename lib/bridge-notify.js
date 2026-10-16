'use strict';

/*
 * The operator bridge's typed server notifications (ADR 0023 Decisions 8 and
 * 9): `work-blocked`, `operator-needed`, `fleet-idle`, `lane-silent`,
 * `gateway-down` and `gateway-recovered`.
 *
 * They are transport control the server writes, never anybody's prose. Each
 * is rendered from a fixed template that takes only values this module
 * resolved itself, and goes straight to the helper's mailbox.
 *
 * Nothing calls this when an event happens. A pass reads the records that
 * are the events (a workload receipt, an exchange fact, the lanes' current
 * receipts, a workload nudge fact, the helper's report of its own connection) and enqueues a notification for each one that has none, keyed by
 * the record that caused it. So a notification that could not be enqueued is
 * found again on the next pass under the same key, for as long as its record
 * is inside the lookback, and one that was enqueued is never made twice. Only
 * records written since the bridge was last enabled are considered, so
 * enabling it delivers no backlog.
 */

const store = require('./store');
const bridgeStore = require('./bridge-store');
const { createLogger } = require('./logger');

const log = createLogger('bridge-notify');

/** Setting holding when the bridge was last enabled: nothing older is notified. */
const ENABLED_AT = 'enabled.at';

/**
 * How far back a pass looks for events. A notification is enqueued within one
 * pass of its event, so anything older than this was either notified already
 * or happened while the bridge was off; the bound keeps the scan small.
 */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * How long the helper must have had no connection to Discord before the
 * operator is told. A reconnect normally takes seconds, and a notice for each
 * one would teach them to ignore the notice that matters.
 */
const GATEWAY_DOWN_AFTER_MS = 5 * 60 * 1000;

/** Longest project name a template will show. */
const MAX_NAME = 60;

/** Seams, so tests supply the lanes and the clock. */
const _deps = {
  now: () => new Date().toISOString(),
  /** @returns {string|undefined} The IANA zone a notice's times are shown in; undefined means this host's own. */
  timeZone: () => undefined,
  /** @returns {{sessionId: number, launchId: (string|null), receiptSeq: (number|null), availability: string}[]} */
  lanes: () => [],
  /**
   * How the helper's Discord connection reads now. The gateway requires this
   * module, so it is required when called and not when this file loads.
   * @returns {{reading: string, state: (string|null), since: (string|null), fatalCloseCode: (number|null), reportedAt: (string|null)}}
   */
  discordReading: () => require('./bridge-gateway').discordReading()
};

/**
 * What this process has seen: of the fleet, for telling one idle episode from
 * the next, and of the helper's connection, for when it first read as down.
 */
const _state = { episode: null, beginning: null, primedFor: null, resumed: false, warnedNoEnableTime: false, downSeenAt: null };

/**
 * Tell this module how to read the fleet's lanes. The server owns the
 * activity observer the composition needs, so it supplies the reader.
 * @param {() => object[]} reader - Returns one entry per live lane.
 * @returns {void}
 */
function setLaneReader(reader) {
  _deps.lanes = reader;
}

/**
 * Read every live lane through the fleet's own composition, so this module
 * and the fleet roster can never disagree about whether a lane is clear.
 * @param {(session: object, projectName: (string|null)) => {workload: object, composed: object}} composeLane - The roster's lane composition.
 * @returns {{sessionId: number, launchId: (string|null), receiptSeq: (number|null), availability: string}[]}
 */
function readLanes(composeLane) {
  return store.sessions.listLiveAll().map((session) => {
    const project = store.projects.get(session.projectId);
    const lane = composeLane(session, project ? project.name : null);
    const sequence = store.launchSequences.getBySession(session.id);
    const receipt = lane && lane.workload ? lane.workload.receipt : null;
    return {
      sessionId: session.id,
      launchId: sequence ? sequence.launchId : null,
      receiptSeq: receipt && Number.isInteger(receipt.seq) ? receipt.seq : null,
      availability: lane && lane.composed ? lane.composed.availability : 'UNKNOWN'
    };
  });
}

/**
 * A project's name as a template may show it: printable, single-line, bounded.
 * @param {number|null} projectId - Project id.
 * @returns {string}
 */
function _projectName(projectId) {
  const project = Number.isInteger(projectId) ? store.projects.get(projectId) : null;
  if (!project || typeof project.name !== 'string') return 'a project';
  // eslint-disable-next-line no-control-regex
  const clean = project.name.replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').trim().slice(0, MAX_NAME);
  return clean || 'a project';
}

/**
 * What an operator alert says, by why the watchdog raised it. The watchdog's
 * reason is a closed code and each has its own fixed sentence, so a message
 * nobody has read is not reported as one nobody answered.
 * @type {Readonly<Record<string, string>>}
 */
const OPERATOR_NEEDED = Object.freeze({
  unanswered: 'was read and has gone unanswered long enough to need you.',
  'prolonged-unanswered': 'was read and has gone unanswered long enough to need you.',
  unread: 'has gone unread long enough to need you.',
  'blocking-unread': 'is blocking its sender and has gone unread long enough to need you.',
  'critical-unread': 'is critical and has gone unread long enough to need you.',
  'prolonged-unread': 'has gone unread long enough to need you.',
  'prolonged-actionable': 'has waited long enough on a recipient that should have taken it to need you.',
  'configuration-hold': 'cannot be delivered until its recipient\'s setup is put right, and needs you.',
  'engine-thread-unknown-stalled': 'is stalled: its recipient\'s engine cannot be identified, and it needs you.',
  'no-escalation-route': 'has nobody else it can be escalated to, and needs you.',
  other: 'needs you.'
});

/**
 * What a silent-lane notice says about why no coordinator was told, by the
 * code the workload nudge monitor recorded on the operator route
 * (`lib/workload-nudge.js#ESCALATION_MEANINGS`). The coordinator's name is not
 * shown: it comes from a project's config, which is text somebody typed.
 * @type {Readonly<Record<string, string>>}
 */
const LANE_SILENT = Object.freeze({
  'no-coordinator': 'it names no coordinator.',
  'coordinator-is-self': 'it is its own coordinator.',
  'coordinator-unknown-project': 'the coordinator it names is not a project on this install.',
  'coordinator-no-live-session': 'the coordinator it names has no live session.',
  'coordinator-send-failed': 'the message to its coordinator could not be sent.',
  other: 'no coordinator could be told.'
});

/**
 * Why Discord refused the helper's connection, by the close code the helper
 * reported. These two are the ones an operator can put right from Discord's
 * developer pages; any other code is shown as its number.
 * @type {Readonly<Record<number, string>>}
 */
const GATEWAY_REFUSED = Object.freeze({ 4004: 'the bot token was rejected', 4014: 'Message Content Intent is off' });

/**
 * An instant as a notice shows it: this host's local time with its zone, as
 * `13:03 PDT on 2026-10-11`. The operator reads these on a phone, in the
 * zone they live in. Where the runtime cannot name the zone the time is given
 * in UTC and says so; a time is never shown without a zone.
 * @param {string} iso - An ISO timestamp.
 * @returns {string}
 */
function _when(iso) {
  const at = new Date(iso);
  if (typeof iso !== 'string' || Number.isNaN(at.getTime())) return 'a time that was not recorded';
  const inUtc = `${at.toISOString().slice(11, 16)} UTC on ${at.toISOString().slice(0, 10)}`;
  let parts = null;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: _deps.timeZone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short'
    }).formatToParts(at);
  } catch (err) {
    // An unknown zone is a RangeError; anything else is not this function's to hide.
    if (!(err instanceof RangeError)) throw err;
    return inUtc;
  }
  const part = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  if (!part.timeZoneName || !part.timeZoneName.trim()) return inUtc;
  return `${part.hour}:${part.minute} ${part.timeZoneName} on ${part.year}-${part.month}-${part.day}`;
}

/**
 * A length of time in words, from whole minutes: `5 minutes`, `1 hour 1
 * minute`, `12 hours 12 minutes`. Null for anything that is not a whole
 * number of minutes from zero up, so a sentence leaves the length out rather
 * than print a guess.
 * @param {*} minutes - Whole minutes.
 * @returns {string|null}
 */
function _howLong(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0) return null;
  const count = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes < 60) return count(minutes, 'minute');
  return `${count(Math.floor(minutes / 60), 'hour')} ${count(minutes % 60, 'minute')}`;
}

/**
 * The fixed templates. Each takes only values resolved here.
 * @type {Readonly<Record<string, function(object): string>>}
 */
const TEMPLATES = Object.freeze({
  'lane-silent': ({ project, minutes, why }) => `${project} has gone silent: ${Number.isInteger(minutes)
    ? `its workload report expired and it had reported nothing for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
    : 'its workload report expired and no new one arrived'}. Nobody else was told: ${
    Object.prototype.hasOwnProperty.call(LANE_SILENT, why) ? LANE_SILENT[why] : LANE_SILENT.other}`,
  'work-blocked': ({ project }) => `${project} reports its work is blocked.`,
  'operator-needed': ({ project, why }) => `A message to ${project} ${Object.prototype.hasOwnProperty.call(OPERATOR_NEEDED, why) ? OPERATOR_NEEDED[why] : OPERATOR_NEEDED.other}`,
  'fleet-idle': ({ lanes }) => `Every live session has finished its work and is clear (${lanes} ${lanes === 1 ? 'lane' : 'lanes'}). The fleet is waiting for work.`,
  // A refused connection is not one that is being retried, and is never worded as one: the helper has stopped trying.
  'gateway-down': ({ since, minutes, state, fatalCloseCode }) => {
    if (state === 'fatal') {
      const why = Object.prototype.hasOwnProperty.call(GATEWAY_REFUSED, fatalCloseCode) ? GATEWAY_REFUSED[fatalCloseCode]
        : (Number.isInteger(fatalCloseCode) ? `close code ${fatalCloseCode}` : 'no close code was reported');
      return `Discord has refused the Discord helper's connection since ${_when(since)} (${why}). It will not reconnect by itself: `
        + 'the cause has to be put right and the helper restarted. It can still post here, but it is not receiving what you send, '
        + 'so anything you reply will need sending again once it is fixed.';
    }
    const length = _howLong(minutes);
    return `The Discord helper lost its connection to Discord at ${_when(since)} and has not had one ${length ? `for ${length}` : 'since'}.`
      + `${state === 'connecting' || state === 'reconnecting' ? ' It is still trying.' : ''} It can still post here, but it is not receiving what you send.`;
  },
  // "May not": a short drop that resumes can have what was missed replayed to it.
  'gateway-recovered': ({ since, minutes }) => {
    const length = _howLong(minutes);
    return `The Discord helper is connected to Discord again, since ${_when(since)}.${length ? ` It was not connected for ${length}.` : ''}`
      + ' Anything you sent here in that time may not have arrived: please send it again.';
  }
});

/**
 * Enqueue one notification under its key. Idempotent: a key that already has
 * an item is left alone.
 * @param {string} type - Notification type.
 * @param {string} bound - What it is bound to: part of the key.
 * @param {object} values - Values for the template.
 * @returns {boolean} Whether this call created it.
 */
function _emit(type, bound, values) {
  const idemKey = `notify:${type}:${bound}`;
  const before = store.getDb().prepare('SELECT 1 FROM bridge_outbound WHERE idem_key = ?').get(idemKey);
  if (before) return false;
  const text = TEMPLATES[type](values);
  bridgeStore.outbound.enqueue({
    idemKey, kind: 'notification', notifyType: type, sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text), at: _deps.now()
  });
  return true;
}

/**
 * The instant before which nothing is notified: when the bridge was enabled,
 * or the lookback bound, whichever is later.
 * @returns {string|null} Null when the bridge has no recorded enable time.
 */
function _since() {
  const enabledAt = bridgeStore.settings.get(ENABLED_AT);
  if (!enabledAt) return null;
  const floor = new Date(Date.parse(_deps.now()) - LOOKBACK_MS).toISOString();
  return enabledAt > floor ? enabledAt : floor;
}

/**
 * `work-blocked`: a lane's workload receipt entered `blocked`. Bound to that
 * receipt. A lane that stays blocked and reports again is not a new event.
 * @param {string} since - Earliest receipt time considered.
 * @returns {number} How many were enqueued.
 */
function _workBlocked(since) {
  const rows = store.getDb().prepare(
    "SELECT w.receipt_id, w.project_id FROM workload_receipts w WHERE w.state = 'blocked' AND w.received_at >= ? "
    + "AND NOT EXISTS (SELECT 1 FROM workload_receipts p WHERE p.launch_id = w.launch_id AND p.seq = w.seq - 1 AND p.state = 'blocked') "
    + 'ORDER BY w.receipt_id'
  ).all(since);
  let made = 0;
  for (const row of rows) {
    if (_emit('work-blocked', `receipt:${row.receipt_id}`, { project: _projectName(row.project_id) })) made += 1;
  }
  return made;
}

/**
 * `operator-needed`: the Medusa watchdog raised an exchange to its operator
 * rung. Bound to that exchange.
 * @param {string} since - Earliest fact time considered.
 * @returns {number} How many were enqueued.
 */
function _operatorNeeded(since) {
  const rows = store.getDb().prepare(
    "SELECT f.exchange_id, f.code, x.recipient_project_id, x.origin, x.sender_proof, x.sender_verified, x.sender_project_id, x.sender_session_id, x.request_id, x.priority "
    + 'FROM medusa_exchange_facts f JOIN medusa_exchanges x ON x.exchange_id = f.exchange_id '
    + "WHERE f.fact = 'operator_alerted' AND f.at >= ? ORDER BY f.fact_seq"
  ).all(since);
  let made = 0;
  for (const row of rows) {
    // The bridge's own send to a project is not a session waiting on the
    // operator: its route has its one status notice and nothing more (ADR
    // 0023 Decision 17). The watchdog does not raise such a send, and this
    // holds for a fact an earlier build recorded before that was so. Normal
    // mail only, as the watchdog's own exemption is: an alert about a
    // blocking or critical send is relayed whoever sent it.
    if (row.priority === 'normal' && require('./medusa-exchanges').systemOwnerOf(row)) continue;
    if (_emit('operator-needed', `exchange:${row.exchange_id}`, { project: _projectName(row.recipient_project_id), why: row.code })) made += 1;
  }
  return made;
}

/**
 * The key a silent-lane notice is enqueued under: the fact that caused it.
 * @param {number} factId - A `workload_nudge_facts` row id.
 * @returns {string}
 */
function _laneSilentKey(factId) {
  return `notify:lane-silent:nudge-fact:${factId}`;
}

/**
 * Whole minutes of silence a nudge fact recorded, or null when its detail
 * does not say. The detail is the monitor's own JSON; a row that carries
 * anything else is shown without a number rather than guessed at.
 * @param {string|null} detailJson - The fact's `detail_json`.
 * @returns {number|null}
 */
function _silentMinutes(detailJson) {
  let detail = null;
  try {
    detail = JSON.parse(detailJson);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  const seconds = detail && typeof detail === 'object' ? detail.silentSeconds : null;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds / 60) : null;
}

/**
 * `lane-silent`: the workload nudge monitor escalated a lane's expired report
 * and had no coordinator to tell, so it recorded the escalation on the
 * operator route. Bound to that fact. An escalation that reached a
 * coordinator, and the row saying a coordinator could not be reached, are
 * other rows and raise nothing.
 * @param {string} since - Earliest fact time considered.
 * @returns {number} How many were enqueued.
 */
function _laneSilent(since) {
  let made = 0;
  let after = null;
  for (;;) {
    const page = store.workloadNudgeFacts.listOperatorEscalations({ since, after });
    for (const row of page.rows) {
      const values = { project: _projectName(row.project_id), minutes: _silentMinutes(row.detail_json), why: row.code };
      if (_emit('lane-silent', _laneSilentKey(row.fact_id).slice('notify:lane-silent:'.length), values)) made += 1;
    }
    if (!page.more) return made;
    const last = page.rows[page.rows.length - 1];
    after = { createdAt: last.created_at, factId: last.fact_id };
  }
}

/**
 * What became of the notice for one operator-route fact: the state of its
 * item in the outbound queue (`ready`, `blocked`, `delivered` or `dropped`),
 * or null when no notice was ever enqueued for it. Only `delivered` means the
 * helper took it and reported it posted.
 * @param {number} factId - A `workload_nudge_facts` row id.
 * @returns {string|null}
 */
function laneSilentNotice(factId) {
  const row = store.getDb().prepare('SELECT state FROM bridge_outbound WHERE idem_key = ?').get(_laneSilentKey(factId));
  return row ? row.state : null;
}

/** Lane readings that are evidence a lane is not finished and clear. */
const BUSY = Object.freeze(new Set(['WORKING', 'WAITING', 'BLOCKED', 'HELD', 'STOPPED']));

/**
 * What the fleet's lanes say right now.
 *
 * - `idle`: a non-empty fleet in which every lane is at a known launch with a
 *   current receipt and reads `AVAILABLE`, which the lane composition gives
 *   only to a fresh `complete`, `safe-to-clear` receipt of the live launch
 *   with the engine at rest.
 * - `busy`: there is evidence it is not idle. A lane is working, waiting,
 *   blocked, held or stopped, or there are no lanes at all.
 * - `unknown`: neither. A lane's engine has not been observed at rest yet (as
 *   after a server start), an observation lapsed, or a receipt went stale.
 *
 * The three are kept apart because they mean different things for an
 * episode. Only `idle` can begin one: not knowing is not idle. Only `busy`,
 * or a change of members, can end one: not knowing is not evidence that
 * anything changed.
 * @returns {{reading: ('idle'|'busy'|'unknown'), members: string}} `members`
 *   is the fleet's lanes as sorted `session:launch`, whatever they read.
 */
function _fleetReading() {
  const lanes = _deps.lanes();
  if (!Array.isArray(lanes)) return { reading: 'unknown', members: '' };
  if (lanes.length === 0) return { reading: 'busy', members: '' };
  const members = lanes.map((l) => `${l && l.sessionId}:${l && l.launchId}`).sort().join('\n');
  if (lanes.some((l) => l && BUSY.has(l.availability))) return { reading: 'busy', members };
  const idle = lanes.every((l) => l && l.availability === 'AVAILABLE' && l.launchId && Number.isInteger(l.receiptSeq));
  return { reading: idle ? 'idle' : 'unknown', members };
}

/**
 * The members of the last idle episode that was announced, as the digest its
 * notice was keyed by. The notice is the durable record of an episode: it
 * outlives the process, so an episode's identity survives a restart.
 * @returns {string|null}
 */
function _lastAnnouncedMembers() {
  const row = store.getDb().prepare(
    "SELECT idem_key FROM bridge_outbound WHERE kind = 'notification' AND notify_type = 'fleet-idle' ORDER BY outbound_id DESC LIMIT 1"
  ).get();
  return row ? row.idem_key.slice(row.idem_key.lastIndexOf(':') + 1) : null;
}

/**
 * `fleet-idle`: every live lane has finished and is clear.
 *
 * An episode is one spell of an idle fleet with the same members. It is
 * notified once, when it is seen to begin: the fleet read `idle` after there
 * was evidence it was not, or with different members. A lane that stays
 * finished and reports again is the same episode, and so is a spell in which
 * a reading lapsed and came back.
 *
 * The first reading that says anything, after this process starts or the
 * bridge is enabled, is taken as it is and not announced: an idle fleet found
 * then began its spell before anything here could see it. That is the
 * no-backlog rule for a condition, and while the server was down no lane
 * could have finished.
 * @param {string} enabledAt - When the bridge was last enabled.
 * @returns {number} 1 when a notification was enqueued, else 0.
 */
function _fleetIdle(enabledAt) {
  const now = _fleetReading();
  if (_state.primedFor !== enabledAt) {
    // Until a reading says something, there is nothing to take as the start.
    if (now.reading === 'unknown') return 0;
    _state.primedFor = enabledAt;
    _state.episode = now.reading === 'idle' ? now.members : null;
    _state.beginning = null;
    // The last episode announced is on record in its notice's key. Finding
    // the same members idle again after a start is that episode resumed.
    _state.resumed = now.reading === 'idle' && _lastAnnouncedMembers() === bridgeStore.digest(now.members).slice(0, 16);
    return 0;
  }
  if (_state.episode !== null) {
    // An open episode ends on evidence: a busy lane, or different members.
    const ended = now.reading === 'busy' || (now.members !== '' && now.members !== _state.episode);
    if (!ended) return 0;
    _state.episode = null;
    _state.resumed = false;
  }
  if (now.reading !== 'idle') {
    _state.beginning = null;
    return 0;
  }
  // One key for the episode, kept until its notice exists: a notice that
  // could not be enqueued is tried again under the same key, never a second one.
  if (!_state.beginning || _state.beginning.members !== now.members) {
    _state.beginning = { members: now.members, at: _deps.now() };
  }
  const lanes = now.members.split('\n').length;
  _emit('fleet-idle', `episode:${_state.beginning.at}:${bridgeStore.digest(now.members).slice(0, 16)}`, { lanes });
  _state.episode = now.members;
  _state.beginning = null;
  return 1;
}

/** What the key of a notice about the helper's connection is bound to: the outage, by when the helper said it began. */
const OUTAGE_BOUND = 'since:';

/**
 * The newest notice about the helper's connection, which is the record of
 * whether an outage is open. The queue outlives the process, so an outage's
 * identity survives a restart, as an idle episode's does.
 * @returns {{id: number, type: string, state: string, uncollected: boolean, began: string}|null}
 *   `began` is the outage's beginning as its notice was keyed. `uncollected`
 *   is whether it was let go because nobody collected it, which is not the
 *   same as being withdrawn. Null when there is no notice.
 */
function _lastOutageNotice() {
  const row = store.getDb().prepare(
    "SELECT outbound_id, notify_type, state, drop_code, idem_key FROM bridge_outbound WHERE kind = 'notification' "
    + "AND notify_type IN ('gateway-down','gateway-recovered') ORDER BY outbound_id DESC LIMIT 1"
  ).get();
  if (!row) return null;
  const uncollected = row.state === 'dropped' && row.drop_code === bridgeStore.EXPIRY_REASONS.uncollected;
  return { id: row.outbound_id, type: row.notify_type, state: row.state, uncollected, began: row.idem_key.slice(row.idem_key.indexOf(OUTAGE_BOUND) + OUTAGE_BOUND.length) };
}

/**
 * Whole minutes from one instant to another, or null when either is not a
 * time or the second is before the first.
 * @param {string} from - An ISO timestamp.
 * @param {string} to - An ISO timestamp.
 * @returns {number|null}
 */
function _minutesBetween(from, to) {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 60000) : null;
}

/**
 * `gateway-down` and `gateway-recovered`: the helper has had no connection to
 * Discord for {@link GATEWAY_DOWN_AFTER_MS}, and later has one again.
 *
 * One outage runs from its notice to the next reading that says connected,
 * and the queue's own rows are the record of it: while the newest of the two
 * types is a `gateway-down` the helper could still collect or has posted, an
 * outage is open. A reading of down then raises nothing more, whatever time
 * it carries, so a helper restarted in the middle of an outage is not
 * announced as a second one and a server restart cannot announce twice. A
 * reading of connected raises the one `gateway-recovered`.
 *
 * A `gateway-down` that was let go uncollected was never seen. Letting it go
 * ends that announcement, not the outage. It leaves no outage open, so no
 * recovery is announced for it. If the helper still reports the same outage
 * afterwards, it is announced again as a new notice, with the beginning it
 * always had: otherwise the helper that could not post for a week would come
 * back to an outage nobody is ever told of. The new notice is keyed by the
 * one that was let go, so there is one for each, and no more than one each
 * time the limit for an uncollected notice passes.
 *
 * A `gateway-down` somebody withdrew was a decision, and is final: it holds
 * no outage open either, and that outage is not announced again.
 *
 * The wait is counted from the latest of three times: when the helper says
 * the outage began, when this process first read it as down, and when the
 * bridge was enabled. A helper with a wrong clock, a server just started and
 * a bridge just enabled each cost a delay at most; none can raise a notice
 * for an outage this server has not watched for the whole wait.
 *
 * Only `down` and `connected` are evidence. A helper that polls slowly or is
 * backing off reads as not reported while it runs, so a missing or stale
 * report neither opens an outage nor closes one, and does not restart the
 * wait. A connection Discord refused is down like any other: its sentence
 * says it will not come back by itself.
 * @param {string} enabledAt - When the bridge was last enabled.
 * @returns {number} 1 when a notification was enqueued, else 0.
 */
function _gatewayOutage(enabledAt) {
  const now = _deps.discordReading();
  if (!now || (now.reading !== 'down' && now.reading !== 'connected')) return 0;
  const last = _lastOutageNotice();
  const open = Boolean(last) && last.type === 'gateway-down' && last.state !== 'dropped';
  if (now.reading === 'connected') {
    _state.downSeenAt = null;
    if (!open) return 0;
    const values = { since: now.since, minutes: _minutesBetween(last.began, now.since) };
    return _emit('gateway-recovered', `${OUTAGE_BOUND}${last.began}`, values) ? 1 : 0;
  }
  if (_state.downSeenAt === null) _state.downSeenAt = _deps.now();
  if (open) return 0;
  const from = Math.max(Date.parse(now.since), Date.parse(_state.downSeenAt), Date.parse(enabledAt));
  // A time that cannot be read makes this NaN, and the comparison false: no notice on a wait nobody can count.
  if (!(Date.parse(_deps.now()) - from >= GATEWAY_DOWN_AFTER_MS)) return 0;
  const values = { since: now.since, minutes: _minutesBetween(now.since, _deps.now()), state: now.state, fatalCloseCode: now.fatalCloseCode };
  const letGo = Boolean(last) && last.type === 'gateway-down' && last.uncollected && last.began === now.since;
  return _emit('gateway-down', `${letGo ? `again:${last.id}:` : ''}${OUTAGE_BOUND}${now.since}`, values) ? 1 : 0;
}

/**
 * One pass: enqueue a notification for every event that has none. Does
 * nothing while the bridge is disabled. Each kind is tried apart from the
 * others, and a failure is logged and left for the next pass.
 * @returns {{workBlocked: number, operatorNeeded: number, fleetIdle: number, laneSilent: number, gatewayOutage: number}}
 */
function reconcile() {
  const out = { workBlocked: 0, operatorNeeded: 0, fleetIdle: 0, laneSilent: 0, gatewayOutage: 0 };
  if (!bridgeStore.settings.isEnabled()) return out;
  const since = _since();
  if (!since) {
    if (!_state.warnedNoEnableTime) {
      _state.warnedNoEnableTime = true;
      log.warn('Bridge is enabled with no recorded enable time — no notification will be raised until it is enabled again');
    }
    return out;
  }
  const attempt = (name, work) => {
    try {
      out[name] = work();
    } catch (err) {
      log.warn('Bridge notification pass failed for one kind', { kind: name, error: err.message });
    }
  };
  attempt('workBlocked', () => _workBlocked(since));
  attempt('operatorNeeded', () => _operatorNeeded(since));
  attempt('fleetIdle', () => _fleetIdle(bridgeStore.settings.get(ENABLED_AT)));
  attempt('laneSilent', () => _laneSilent(since));
  attempt('gatewayOutage', () => _gatewayOutage(bridgeStore.settings.get(ENABLED_AT)));
  return out;
}

/**
 * Forget what this process has seen, of the fleet and of the helper's connection. For tests.
 * @returns {void}
 */
function _reset() {
  _state.episode = null;
  _state.beginning = null;
  _state.resumed = false;
  _state.primedFor = null;
  _state.warnedNoEnableTime = false;
  _state.downSeenAt = null;
}

module.exports = {
  ENABLED_AT, LOOKBACK_MS, GATEWAY_DOWN_AFTER_MS, TEMPLATES, LANE_SILENT, GATEWAY_REFUSED, setLaneReader, readLanes, reconcile, laneSilentNotice, _deps, _reset,
  /** An instant as the operator reads it: this host's local time with its zone (see `_when`). */
  when: _when,
  /** @returns {{open: boolean, resumed: boolean}} Whether an episode is open, and whether it was resumed from its notice after a start. */
  episode: () => ({ open: _state.episode !== null, resumed: _state.resumed })
};
