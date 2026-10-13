'use strict';

/**
 * HTTP handlers for `/api/tc/check-watches`.
 *
 * Each handler resolves its caller through `lib/control-auth.js`, asks
 * `lib/check-watch-store.js` to make the change, and answers
 * `{ status, body }`. A refusal is thrown as a {@link WatchError} carrying its
 * HTTP status and a code; the route in `server.js` writes it.
 *
 * Who may do what:
 *
 * - A verified live launch registers a watch, and only for its own project.
 *   It cancels a watch of its own project. Nobody else can do either, the
 *   Operator included: a watch says which session is to be woken, and only
 *   that project can say it wants to be.
 * - The project itself, the Operator, and a project that shares a group with
 *   it read its watches. To anyone else they do not exist.
 *
 * The repository a watch is on is not taken from the request. It is the
 * `origin` remote of the project's own folder, read by this server. That is
 * not a boundary against the project's own session: the session can write
 * that folder's git config, and so can change which repository is recorded.
 *
 * A watch's state is derived on every read by `lib/check-watch-state.js#derive`
 * and is never stored. Nothing here reads GitHub or sends anything: the
 * monitor (`lib/check-watch.js`) does both. `monitored` in every answer says
 * whether this server reads a watch's check and wakes its project, and a
 * reader that sees `false` must read the check itself.
 *
 * What became of a watch's two messages is derived too, from the switchboard's
 * own facts about the exchanges that carried them, and never from what the
 * monitor believed when it sent: see {@link DELIVERY_STATES}.
 *
 * @module lib/check-watch-api
 */

const store = require('./store');
const watchStore = require('./check-watch-store');
const state = require('./check-watch-state');
const githubChecks = require('./github-checks');
const strandedCheck = require('./stranded-check');
const { execFileArgs, didNotRun } = require('./exec');
const { resolveControlCaller } = require('./control-auth');
const checkWatch = require('./check-watch');

const { REFUSALS } = state;

/** Whether this server reads a watch's check from GitHub and wakes its project. */
const MONITORED = true;

/**
 * What a read says became of one of a watch's two messages.
 *
 * Before any send: `not-owed` (the watch has not reached the point where the
 * message exists, or was cancelled), `owed` (it has, and no send has been
 * made), `undeliverable` (it is owed and the project had nobody to send it to;
 * it is sent when it has).
 *
 * After a send, the furthest any attempt got, in this order: `refused` (the
 * Hub declined it; final), `unconfirmed` (no proof the Hub ever took it),
 * `accepted` (the Hub took it), `arrived` (it reached the recipient's
 * listener), `read` (the recipient fetched it), `acknowledged` (the recipient
 * marked it handled).
 */
const DELIVERY_STATES = Object.freeze([
  'not-owed', 'owed', 'undeliverable', 'refused', 'unconfirmed', 'accepted', 'arrived', 'read', 'acknowledged'
]);

/** The most watches one list answers with, newest first. */
const LIST_LIMIT = 50;

/** How long the read of a project folder's `origin` may take. Well inside the ten seconds `tc` waits for an answer. */
const ORIGIN_TIMEOUT_MS = 4000;

/** The furthest ahead a due time may be set, in minutes. */
const MAX_DUE_MINUTES = state.MAX_DUE_AHEAD_MS / 60000;

const WATCH_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** Refusals that belong to the HTTP surface: who is asking, and which repository. */
const API_REFUSALS = Object.freeze({
  CALLER_NOT_VERIFIED: 'CALLER_NOT_VERIFIED',
  OPERATOR_UNVERIFIABLE: 'OPERATOR_UNVERIFIABLE',
  LAUNCH_ONLY: 'CHECK_WATCH_LAUNCH_ONLY',
  PROJECT_NOT_FOUND: 'CHECK_WATCH_PROJECT_NOT_FOUND',
  REPO_UNKNOWN: 'CHECK_WATCH_REPO_UNKNOWN',
  REPO_UNREADABLE: 'CHECK_WATCH_REPO_UNREADABLE'
});

/** The HTTP status of each of the records' refusals; any other is a 409. */
const STORE_STATUS = Object.freeze({
  [REFUSALS.MALFORMED]: 400,
  [REFUSALS.DUE_OUT_OF_RANGE]: 400,
  [REFUSALS.NOT_OWNER]: 403,
  [REFUSALS.NOT_FOUND]: 404
});

/** Seams for tests: the clock, and the read of a project folder's `origin`. */
const _internal = {
  now: () => Date.now(),
  readOrigin: (cwd) => execFileArgs('git', ['remote', 'get-url', 'origin'], { cwd, timeoutMs: ORIGIN_TIMEOUT_MS, maxBufferBytes: 64 * 1024 })
};

/** A refusal with its HTTP status, its code and whatever else the caller needs. */
class WatchError extends Error {
  /**
   * @param {number} status - HTTP status
   * @param {string} code - A code from `REFUSALS` or `API_REFUSALS`
   * @param {string} message - What was refused and what to do next
   * @param {object} [details] - Further fields for the response body
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'WatchError';
    this.status = status;
    this.code = code;
    this.details = details || {};
  }
}

/**
 * Throw the refusal a store answer carries, or return the answer.
 * @param {object} answer - A `check-watch-store` write's answer
 * @returns {object} The answer, when it is not a refusal
 */
function _accepted(answer) {
  if (answer.ok !== false) return answer;
  const { ok: _ok, code, message, fact: _fact, ...details } = answer;
  throw new WatchError(STORE_STATUS[code] || 409, code, message, details);
}

/**
 * Resolve the caller or throw the refusal a non-principal gets.
 * @param {object} req - The request
 * @returns {{kind: 'operator'|'project', projectId?: number, launchId?: string}}
 */
function _principal(req) {
  const caller = resolveControlCaller(req);
  if (caller.kind === 'operator' || caller.kind === 'project') return caller;
  if (caller.kind === 'operator-unverifiable') {
    throw new WatchError(503, API_REFUSALS.OPERATOR_UNVERIFIABLE,
      'Operator identity cannot be verified on this install. Sign in to the dashboard and repeat the request.');
  }
  throw new WatchError(403, API_REFUSALS.CALLER_NOT_VERIFIED,
    'Check watches answer only the Operator or a verified launch. Send x-tangleclaw-project-id and '
    + 'x-tangleclaw-launch-id of an active session (`tc check` sends them), or act as the signed-in Operator.');
}

/**
 * Require the caller to be a verified launch, which is the only caller that
 * registers or cancels a watch.
 * @param {object} caller - From {@link _principal}
 * @param {string} what - What only a launch does, for the message
 * @returns {void}
 */
function _requireLaunch(caller, what) {
  if (caller.kind === 'project') return;
  throw new WatchError(403, API_REFUSALS.LAUNCH_ONLY,
    `Only a verified launch may ${what}, and only for its own project; the Operator is not that. Ask that project's session to run \`tc check\`.`);
}

/**
 * The ids of the groups a project belongs to.
 * @param {number} projectId - Project id
 * @returns {string[]}
 */
function _groupIds(projectId) {
  return store.projectGroups.getByProject(projectId).map((group) => group.id);
}

/**
 * Whether a caller may read a project's watches: the Operator, the project
 * itself, or a project that shares a group with it.
 * @param {object} caller - From {@link _principal}
 * @param {number} projectId - The project whose watches are asked for
 * @returns {boolean}
 */
function _mayRead(caller, projectId) {
  if (caller.kind === 'operator' || caller.projectId === projectId) return true;
  const mine = _groupIds(caller.projectId);
  return _groupIds(projectId).some((id) => mine.includes(id));
}

/**
 * What became of one attempt to send a message, from its exchange's facts. A
 * read or an acknowledgement counts only when the recipient itself made it:
 * the dashboard marking a message handled is not the session having seen it.
 * @param {object} exchange - The attempt's exchange row
 * @param {1|2} attempt - Which attempt
 * @returns {{attempt: number, state: string, exchangeId: string, to: string, sentAt: string}}
 */
function _attemptView(exchange, attempt) {
  const facts = store.medusaExchanges.facts(exchange.exchange_id);
  const has = (fact, actor) => facts.some((f) => f.fact === fact && (!actor || f.actor === actor));
  let reached = 'unconfirmed';
  if (has('acknowledged', 'recipient')) reached = 'acknowledged';
  else if (has('read', 'recipient')) reached = 'read';
  else if (has('arrived')) reached = 'arrived';
  else if (exchange.hub_id) reached = 'accepted';
  else if (has('send_refused')) reached = 'refused';
  return { attempt, state: reached, exchangeId: exchange.exchange_id, to: exchange.recipient_workspace_id, sentAt: exchange.created_at };
}

/**
 * Whether a watch has reached the point where one of its messages exists: a
 * wake needs a result, an alarm a due time that passed with none. A cancelled
 * watch owes nothing.
 * @param {object} watch - The watch
 * @param {'wake'|'alarm'} kind - Which message
 * @param {number} now - The time now, in milliseconds
 * @returns {boolean}
 */
function _owes(watch, kind, now) {
  if (watch.cancelled) return false;
  return kind === 'wake' ? Boolean(watch.result) : !watch.result && now >= Date.parse(watch.dueAt);
}

/**
 * What became of one of a watch's two messages: a state from
 * {@link DELIVERY_STATES}, each attempt made, whether there was a second, and
 * the record of a time it had nobody to go to.
 * @param {object} watch - The watch
 * @param {'wake'|'alarm'} kind - Which message
 * @param {object[]} facts - The watch's history
 * @param {number} now - The time now, in milliseconds
 * @returns {{state: string, secondAttempt: boolean, attempts: object[], undeliverable: (object|null)}}
 */
function _delivery(watch, kind, facts, now) {
  const { first, second } = checkWatch.exchangesOf(watch.watchId, kind);
  const attempts = [];
  if (first) attempts.push(_attemptView(first, 1));
  if (second) attempts.push(_attemptView(second, 2));
  const nobody = facts.find((f) => f.kind === watchStore.MESSAGE_FACTS[kind].undeliverable) || null;
  let reached;
  if (attempts.length) {
    reached = attempts.map((a) => a.state).sort((a, b) => DELIVERY_STATES.indexOf(b) - DELIVERY_STATES.indexOf(a))[0];
  } else if (!_owes(watch, kind, now)) {
    reached = 'not-owed';
  } else {
    reached = nobody ? 'undeliverable' : 'owed';
  }
  return {
    state: reached,
    secondAttempt: Boolean(second),
    attempts,
    undeliverable: nobody ? { code: nobody.code, at: nobody.at } : null
  };
}

/**
 * A watch as a response shows it, with the state derived now. The launches
 * that registered and cancelled it are not shown: a launch id identifies a
 * session to this server and is never handed to a reader.
 * @param {object} watch - A watch as the store returns it
 * @param {number} now - The time to derive the state at, in milliseconds
 * @returns {object}
 */
function _watchView(watch, now) {
  const { state: derived, reasons } = state.derive(watch, now);
  const facts = watchStore.listFacts(watch.watchId);
  return {
    watchId: watch.watchId,
    projectId: watch.projectId,
    repo: watch.repo,
    prNumber: watch.prNumber,
    headSha: watch.headSha,
    checkName: watch.checkName,
    dueAt: watch.dueAt,
    registeredAt: watch.registeredAt,
    registeredBy: { sessionId: watch.registeredBy.sessionId },
    state: derived,
    reasons,
    open: !watch.result && !watch.cancelled && !watch.expired,
    result: watch.result,
    lastRead: watch.lastRead,
    cancelled: watch.cancelled ? { at: watch.cancelled.at, projectId: watch.cancelled.projectId } : null,
    expired: watch.expired,
    delivery: { wake: _delivery(watch, 'wake', facts, now), alarm: _delivery(watch, 'alarm', facts, now) }
  };
}

/**
 * A fact of a watch's history as a response shows it, without any launch id.
 * @param {object} fact - A fact as the store returns it
 * @returns {object}
 */
function _factView(fact) {
  let detail = fact.detail;
  if (detail && typeof detail === 'object') {
    const { launchId: _launchId, ...rest } = detail;
    detail = Object.keys(rest).length ? rest : null;
  }
  return { kind: fact.kind, code: fact.code, at: fact.at, exchangeId: fact.exchangeId, workspaceId: fact.workspaceId, detail };
}

/**
 * Read a watch for a caller, or throw the 404 a caller who may not read it
 * gets: the same answer as for a watch that does not exist.
 * @param {object} caller - From {@link _principal}
 * @param {*} watchId - The id from the path
 * @returns {object} The watch as the store returns it
 */
function _readableWatch(caller, watchId) {
  if (typeof watchId !== 'string' || !WATCH_ID_SHAPE.test(watchId)) {
    throw new WatchError(400, REFUSALS.MALFORMED,
      'That is not a check watch id. Read the ids with GET /api/tc/check-watches (`tc check list`).');
  }
  const watch = watchStore.getWatch(watchId);
  if (!watch || !_mayRead(caller, watch.projectId)) {
    throw new WatchError(404, REFUSALS.NOT_FOUND,
      'No such check watch. Read the watches with GET /api/tc/check-watches (`tc check list`).');
  }
  return watch;
}

/**
 * The GitHub repository a project's folder is a checkout of, as `owner/name`,
 * or the refusal: no folder, no `origin`, an `origin` that is not on
 * github.com, or a read that did not finish.
 * @param {object} project - The project record
 * @returns {Promise<string>}
 */
async function _repoOf(project) {
  if (!project.path) {
    throw new WatchError(409, API_REFUSALS.REPO_UNKNOWN,
      'This project has no folder, so there is no repository to watch a check on.');
  }
  let read;
  try {
    read = await _internal.readOrigin(project.path);
  } catch (err) {
    read = { exitCode: 1, stdout: '', error: err && err.message ? err.message : 'unknown error', errorCode: 'THROWN', timedOut: false };
  }
  // A spawn that failed or was cut short said nothing about the remote; git's own exit did.
  if (didNotRun(read)) {
    // Node reports a missing folder and a missing git the same way, and repeating the request mends neither.
    const why = read.errorCode === 'ENOENT'
      ? `the project folder (${project.path}) or git itself is missing, so repeating the request will not help until that is put right`
      : `${read.timedOut ? 'git did not answer in time' : read.error || read.errorCode || `git was stopped by ${read.signal}`}; repeat the request`;
    throw new WatchError(503, API_REFUSALS.REPO_UNREADABLE,
      `The project folder's origin remote could not be read: ${why}. Nothing was registered.`);
  }
  const host = read.exitCode === 0 ? strandedCheck.repoOf(read.stdout) : null;
  if (!host) {
    throw new WatchError(409, API_REFUSALS.REPO_UNKNOWN,
      'This project\'s folder has no origin remote on github.com, so there is no repository to watch a check on. '
      + 'A watch is always on the repository the project is a checkout of.');
  }
  return host.slice(host.indexOf('/') + 1);
}

/**
 * The parts of a registration this server can check without the records, or
 * the refusal. The store checks them again when it writes.
 * @param {object} b - The request body
 * @returns {{prNumber: number, headSha: string, checkName: string, dueInMinutes: number}}
 */
function _registerInput(b) {
  if (!Number.isSafeInteger(b.prNumber) || b.prNumber <= 0) {
    throw new WatchError(400, REFUSALS.MALFORMED, 'prNumber must be the pull request\'s number. Send it as a whole number.');
  }
  // The reader's own rule for a commit and a check name, asked of a repository that is always well formed.
  const invalid = githubChecks.invalidRequest('owner/name', b.headSha, b.checkName);
  if (invalid) {
    throw new WatchError(400, REFUSALS.MALFORMED,
      `A watch cannot be read as asked: ${invalid}. Send headSha (\`git rev-parse <branch>\`) and checkName exactly as GitHub shows it.`);
  }
  if (!Number.isSafeInteger(b.dueInMinutes) || b.dueInMinutes < 1 || b.dueInMinutes > MAX_DUE_MINUTES) {
    throw new WatchError(400, REFUSALS.DUE_OUT_OF_RANGE,
      `Every watch needs a due time: send dueInMinutes, a whole number from 1 to ${MAX_DUE_MINUTES}. `
      + 'At that time an unresolved check stops reading as waiting.', { maxDueInMinutes: MAX_DUE_MINUTES });
  }
  return { prNumber: b.prNumber, headSha: b.headSha, checkName: b.checkName, dueInMinutes: b.dueInMinutes };
}

/**
 * POST /api/tc/check-watches — a verified launch asks to be told when one
 * named check finishes on one exact commit of a pull request.
 * @param {object} req - The request
 * @param {object} body - `{ prNumber, headSha, checkName, dueInMinutes }`
 * @returns {Promise<{status: number, body: object}>}
 */
async function register(req, body) {
  const caller = _principal(req);
  _requireLaunch(caller, 'register a check watch');
  const input = _registerInput(body || {});
  const project = store.projects.get(caller.projectId);
  if (!project) {
    throw new WatchError(404, API_REFUSALS.PROJECT_NOT_FOUND, `No project has id ${caller.projectId}.`);
  }
  const repo = await _repoOf(project);
  const session = store.sessions.getActive(caller.projectId);
  const now = _internal.now();
  const made = _accepted(watchStore.registerWatch({
    projectId: caller.projectId,
    sessionId: session ? session.id : null,
    launchId: caller.launchId,
    repo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    checkName: input.checkName,
    dueAt: now + input.dueInMinutes * 60000
  }));
  return { status: 201, body: { watch: _watchView(made.watch, now), monitored: MONITORED } };
}

/**
 * GET /api/tc/check-watches — a project's watches, newest first, each with
 * its state derived now. `projectId` names the project; a launch that sends
 * none reads its own.
 * @param {object} req - The request
 * @param {object} query - `{ projectId? }`
 * @returns {{status: number, body: object}}
 */
function list(req, query) {
  const caller = _principal(req);
  const asked = query && query.projectId;
  let projectId;
  if (asked === undefined || asked === '') {
    if (caller.kind !== 'project') {
      throw new WatchError(400, REFUSALS.MALFORMED, 'Name the project whose watches you want: send projectId.');
    }
    projectId = caller.projectId;
  } else {
    projectId = /^[1-9]\d{0,14}$/.test(String(asked)) ? Number(asked) : null;
    if (projectId === null) throw new WatchError(400, REFUSALS.MALFORMED, 'projectId must be a project\'s numeric id.');
  }
  const project = store.projects.get(projectId);
  if (!project || !_mayRead(caller, projectId)) {
    throw new WatchError(404, API_REFUSALS.PROJECT_NOT_FOUND,
      'No such project, or none whose check watches this caller may read: a project reads its own and those of a project it shares a group with.');
  }
  const now = _internal.now();
  const all = watchStore.listWatches(projectId);
  return {
    status: 200,
    body: {
      projectId,
      projectName: project.name,
      yours: caller.kind === 'project' && caller.projectId === projectId,
      openCount: watchStore.countOpen(projectId),
      maxOpen: state.MAX_OPEN_PER_PROJECT,
      total: all.length,
      watches: all.slice(0, LIST_LIMIT).map((watch) => _watchView(watch, now)),
      monitored: MONITORED
    }
  };
}

/**
 * GET /api/tc/check-watches/:id — one watch, its derived state and its history.
 * @param {object} req - The request
 * @param {object} params - `{ id }`
 * @returns {{status: number, body: object}}
 */
function show(req, params) {
  const caller = _principal(req);
  const watch = _readableWatch(caller, params.id);
  const project = store.projects.get(watch.projectId);
  return {
    status: 200,
    body: {
      watch: _watchView(watch, _internal.now()),
      projectName: project ? project.name : null,
      facts: watchStore.listFacts(watch.watchId).map(_factView),
      monitored: MONITORED
    }
  };
}

/**
 * POST /api/tc/check-watches/:id/cancel — a verified launch cancels a watch of
 * its own project. A cancelled watch is never read again and is sent nothing more.
 * @param {object} req - The request
 * @param {object} params - `{ id }`
 * @returns {{status: number, body: object}}
 */
function cancel(req, params) {
  const caller = _principal(req);
  _requireLaunch(caller, 'cancel a check watch');
  const watch = _readableWatch(caller, params.id);
  const done = _accepted(watchStore.cancelWatch(watch.watchId, { projectId: caller.projectId, launchId: caller.launchId }));
  return { status: 200, body: { watch: _watchView(done.watch, _internal.now()), monitored: MONITORED } };
}

module.exports = {
  WatchError,
  API_REFUSALS,
  MONITORED,
  DELIVERY_STATES,
  LIST_LIMIT,
  MAX_DUE_MINUTES,
  register,
  list,
  show,
  cancel,
  _internal
};
