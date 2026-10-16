'use strict';

/**
 * HTTP handlers for `/api/merge-queue`.
 *
 * Each handler resolves its caller through `lib/control-auth.js`, asks
 * `lib/merge-queue-store.js` to make the change, and answers
 * `{ status, body }`. A refusal is thrown as a {@link QueueError} carrying its
 * HTTP status and a code; the route in `server.js` writes it.
 *
 * Who may do what:
 *
 * - The Operator, with a proof tier, makes a queue and names its owner, records
 *   an entry's Operator gate, clears a queue's halt, and settles an entry left
 *   `landing` whose outcome the queue could not record. Nobody else can do any
 *   of them.
 * - A verified live launch of the queue's owner project submits, withdraws and
 *   advances. Nobody else can add to a queue or move it, the Operator included.
 * - The Operator, the owner, and a project that shares a group with the owner
 *   read. To anyone else a queue and its entries do not exist.
 *
 * What a submit checks is read from GitHub by this server, never taken from
 * the caller: the pull request is open, targets the queue's base, is not a
 * draft and has the submitted head; the `test` check on that head concluded
 * success; and the pull request changes no release-trigger path. A read that
 * fails refuses the submit. The review, test and base gates are the owner's
 * statements, each with a reference; the queue records them and judges none.
 *
 * An advance moves the front entry one step (`lib/merge-queue.js#advance`): it
 * makes the entry's candidate, or merges its pull request once everything a
 * landing rests on has been read again, or fails it. A withdrawal deletes the
 * two branches of the withdrawn entry's own candidate. Both, and the
 * Operator's settlement of a stuck landing, hold their queue's slot
 * (`lib/merge-queue.js`) from reading the entry's state to recording the
 * change, so no other call that takes the slot can change the entry in between.
 *
 * A submit, a withdrawal and an advance are the owner acting as a coordinator,
 * so each is put to the coordinator epoch gate
 * (`lib/coordinator-rotation.js#gate`) as a control command is: when the
 * request arrives, and again after every wait, immediately before the queue is
 * written, a branch is deleted or a merge is asked for. A context the owner's
 * rotation has replaced, in the same live launch, is refused, and the refusal
 * is logged.
 *
 * @module lib/merge-queue-api
 */

const store = require('./store');
const queueStore = require('./merge-queue-store');
const state = require('./merge-queue-state');
const github = require('./merge-queue-github');
const githubChecks = require('./github-checks');
const controlGate = require('./control-gate');
const coordinatorRotation = require('./coordinator-rotation');
const sharedDocsAccess = require('./shared-docs-access');
const mergeQueue = require('./merge-queue');
const { resolveControlCaller } = require('./control-auth');
const { createLogger } = require('./logger');

const { withQueueSlot, QueueSlotTaken, QUEUE_CALL_IN_FLIGHT } = mergeQueue;

const log = createLogger('merge-queue-api');

const { REFUSALS } = state;

/** The check a pull request's head must have passed before it is queued. */
const HEAD_CHECK_NAME = 'test';

/** The entry ids this API accepts: one name that fits under both branch prefixes. */
const ENTRY_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The longest withdrawal reason, after trimming. It is the limit
 * `merge-queue-store#withdrawEntry` holds a reason to, checked here as well so
 * that a reason the store would refuse is refused before any branch is deleted.
 */
const MAX_WITHDRAW_REASON = 1000;

/** The action the coordinator epoch gate judges a queue's submit, withdrawal and advance as. */
const QUEUE_MUTATE_ACTION = 'merge-queue-mutate';

/** The header `tc` forwards the calling engine thread in. */
const ENGINE_THREAD_HEADER = 'x-tangleclaw-engine-thread';

/** The words `operatorGate` takes on a submit. */
const OPERATOR_GATE_WORDS = Object.freeze({ required: true, none: false });

/**
 * Refusals that belong to the HTTP surface: who is asking, and what GitHub
 * said. The records' own refusals are `merge-queue-state#REFUSALS`.
 */
const API_REFUSALS = Object.freeze({
  CALLER_NOT_VERIFIED: 'CALLER_NOT_VERIFIED',
  OPERATOR_UNVERIFIABLE: 'OPERATOR_UNVERIFIABLE',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  QUEUE_AMBIGUOUS: 'QUEUE_AMBIGUOUS',
  GITHUB_UNAVAILABLE: 'GITHUB_UNAVAILABLE',
  PR_NOT_OPEN: 'PR_NOT_OPEN',
  PR_WRONG_BASE: 'PR_WRONG_BASE',
  PR_HEAD_MOVED: 'PR_HEAD_MOVED',
  PR_DRAFT: 'PR_DRAFT',
  HEAD_CHECK_NOT_GREEN: 'HEAD_CHECK_NOT_GREEN',
  CANDIDATE_NOT_DISCARDED: 'CANDIDATE_NOT_DISCARDED',
  QUEUE_CALL_IN_FLIGHT,
  ENTRY_ID_UNUSABLE: 'ENTRY_ID_UNUSABLE',
  CANDIDATE_REF_EXISTS: mergeQueue.ADVANCE_REFUSALS.CANDIDATE_REF_EXISTS,
  BASE_NOT_GREEN: mergeQueue.ADVANCE_REFUSALS.BASE_NOT_GREEN,
  AUTHORIZER_MESSAGE_UNREAD: mergeQueue.ADVANCE_REFUSALS.AUTHORIZER_MESSAGE_UNREAD,
  AUTHORIZER_INBOX_UNREADABLE: mergeQueue.ADVANCE_REFUSALS.AUTHORIZER_INBOX_UNREADABLE,
  SETTLE_COMMIT_UNREADABLE: 'SETTLE_COMMIT_UNREADABLE',
  SETTLE_NOT_ON_BASE: 'SETTLE_NOT_ON_BASE'
});

/** The HTTP status of each of the records' refusals; any other is a 409. */
const STORE_STATUS = Object.freeze({
  [REFUSALS.INVALID_INPUT]: 400,
  [REFUSALS.GATE_REFERENCE_MISSING]: 400,
  [REFUSALS.NOT_OWNER]: 403,
  [REFUSALS.OPERATOR_ONLY]: 403,
  [REFUSALS.QUEUE_NOT_FOUND]: 404,
  [REFUSALS.ENTRY_NOT_FOUND]: 404
});

/** The queue ids this API looks up: what the path of a queue's own route may carry. */
const QUEUE_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Seams for tests: the GitHub modules' calls this API makes, and the coordinator epoch gate. */
const _internal = {
  rotationGate: (input) => coordinatorRotation.gate(input),
  readPull: (repo, number) => github.readPull(repo, number),
  readPullFiles: (repo, number) => github.readPullFiles(repo, number),
  readCheck: (repo, sha, name) => githubChecks.readCheck(repo, sha, name),
  discardCandidate: (repo, ref) => github.discardCandidate(repo, ref),
  readRefTip: (repo, branch) => github.readRefTip(repo, branch),
  readCommit: (repo, sha) => github.readCommit(repo, sha),
  readCompareFiles: (repo, baseSha, headSha) => github.readCompareFiles(repo, baseSha, headSha),
  readAncestry: (repo, sha, tipSha) => github.readAncestry(repo, sha, tipSha),
  readBranchCheck: (repo, branch, sha, name) => github.readBranchCheck(repo, branch, sha, name),
  createCandidate: (repo, ref, baseSha, headSha) => github.createCandidate(repo, ref, baseSha, headSha),
  mergePull: (repo, number, headSha) => github.mergePull(repo, number, headSha),
  resolveBinding: (req) => sharedDocsAccess.resolveBinding(req),
  // Required lazily, as the coordinator rotation reads the inbox: the
  // switchboard module is not otherwise needed to answer a queue request.
  listenerStatus: (sessionId) => require('./medusa').getStatus(sessionId),
  inbox: (sessionId) => require('./medusa').getMessages(sessionId)
};

/** The GitHub calls an advance makes, each through its seam as it stands when called. */
const ADVANCE_GITHUB = Object.freeze(Object.fromEntries(
  ['readPull', 'readRefTip', 'readCommit', 'readCompareFiles', 'readBranchCheck', 'createCandidate', 'discardCandidate', 'mergePull']
    .map((name) => [name, (...args) => _internal[name](...args)])
));

/** A refusal with its HTTP status, its code and whatever else the caller needs. */
class QueueError extends Error {
  /**
   * @param {number} status - HTTP status
   * @param {string} code - A code from `REFUSALS` or `API_REFUSALS`
   * @param {string} message - What was refused and what to do next
   * @param {object} [details] - Further fields for the response body
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'QueueError';
    this.status = status;
    this.code = code;
    this.details = details || {};
  }
}

/**
 * Throw the refusal a store answer carries, or return the answer.
 * @param {object} answer - A `merge-queue-store` write's answer
 * @returns {object} The answer, when it is not a refusal
 */
function _accepted(answer) {
  if (answer.ok !== false) return answer;
  const { ok: _ok, code, message, ...details } = answer;
  throw new QueueError(STORE_STATUS[code] || 409, code, message, details);
}

/**
 * Resolve the caller or throw the refusal a non-principal gets.
 * @param {object} req - The request
 * @returns {{kind: 'operator'|'project', actor: object, projectId?: number, launchId?: string}}
 */
function _principal(req) {
  const caller = resolveControlCaller(req);
  if (caller.kind === 'operator' || caller.kind === 'project') return caller;
  if (caller.kind === 'operator-unverifiable') {
    throw new QueueError(503, API_REFUSALS.OPERATOR_UNVERIFIABLE,
      'Operator identity cannot be verified on this install. Sign in to the dashboard and repeat the request.');
  }
  throw new QueueError(403, API_REFUSALS.CALLER_NOT_VERIFIED,
    'The merge queue answers only the Operator or a verified launch. Send x-tangleclaw-project-id and '
    + 'x-tangleclaw-launch-id of an active session, or act as the signed-in Operator.');
}

/**
 * The caller as the actor the records keep.
 * @param {object} caller - From {@link _principal}
 * @returns {object}
 */
function _actor(caller) {
  return caller.kind === 'operator'
    ? { kind: 'operator', operatorProof: caller.actor.operatorProof }
    : { kind: 'project', projectId: caller.projectId, launchId: caller.launchId };
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
 * Whether a caller may read a queue: the Operator, the owner, or a project
 * that shares a group with the owner.
 * @param {object} caller - From {@link _principal}
 * @param {object} queue - A queue as the store returns it
 * @returns {boolean}
 */
function _mayRead(caller, queue) {
  if (caller.kind === 'operator') return true;
  if (caller.projectId === queue.ownerProjectId) return true;
  const mine = _groupIds(caller.projectId);
  return _groupIds(queue.ownerProjectId).some((id) => mine.includes(id));
}

/**
 * Require the caller to be a launch of the queue's owner project.
 * @param {object} caller - From {@link _principal}
 * @param {object} queue - A queue as the store returns it
 * @param {string} what - What only the owner does, for the message
 * @returns {void}
 */
function _requireOwner(caller, queue, what) {
  if (caller.kind === 'project' && caller.projectId === queue.ownerProjectId) return;
  throw new QueueError(403, REFUSALS.NOT_OWNER,
    `Only a verified launch of project ${queue.ownerProjectId}, which owns this queue, may ${what}. Ask that project's session to do it.`);
}

/**
 * Who the coordinator epoch gate is to judge for this request: the owner
 * project, the caller's verified launch with its session, and the engine
 * thread `tc` forwarded. Only a project caller reaches a queue mutation, so
 * anything else is passed as unbound and never as the Operator the gate exempts.
 * @param {object} req - The request
 * @param {object} queue - The queue being changed
 * @returns {{projectId: number, access: object, threadId: (string|null)}}
 */
function _epochCaller(req, queue) {
  const access = sharedDocsAccess.resolveAccess(req);
  const thread = req.headers && req.headers[ENGINE_THREAD_HEADER];
  return {
    projectId: queue.ownerProjectId,
    access: access.kind === sharedDocsAccess.KINDS.PROJECT ? access : { kind: sharedDocsAccess.KINDS.UNBOUND },
    threadId: typeof thread === 'string' && thread ? thread : null
  };
}

/**
 * Throw the coordinator epoch gate's refusal, if the owner's rotation does not
 * admit this caller now, and log it as every other gated mutation's refusal
 * is logged. Synchronous: asked immediately before a queue write, a branch
 * deletion or a merge request, nothing can change the rotation between the
 * answer and that step.
 * @param {object} epoch - From {@link _epochCaller}
 * @returns {void}
 */
function _refuseIfFenced(epoch) {
  const refusal = _internal.rotationGate({ ...epoch, action: QUEUE_MUTATE_ACTION });
  if (!refusal) return;
  log.info('Coordinator epoch gate refused a mutation', {
    projectId: epoch.projectId, action: QUEUE_MUTATE_ACTION, code: refusal.body.code, rotationId: refusal.body.rotationId
  });
  const { error, code, ...details } = refusal.body;
  throw new QueueError(refusal.status, code, error, details);
}

/**
 * A queue as a response shows it.
 * @param {object} queue - A queue as the store returns it
 * @returns {object}
 */
function _queueView(queue) {
  const owner = store.projects.get(queue.ownerProjectId);
  return { ...queue, ownerProjectName: owner ? owner.name : null };
}

/**
 * An entry as a response shows it. Each gate says whose word it is: the three
 * owner gates are the owner's statement, the Operator gate is the Operator's
 * record, and `headCheck` is what the queue itself read from GitHub. The
 * launch that submitted it is not shown: a launch id identifies a session to
 * this server and is never handed to a reader.
 * @param {object} entry - An entry as the store returns it
 * @returns {object}
 */
function _entryView(entry) {
  const gates = {};
  for (const name of state.OWNER_GATES) gates[name] = { ...entry.gates[name], source: 'owner-statement' };
  gates.operator = { ...entry.gates.operator, source: 'operator-record' };
  return {
    ...entry,
    gates,
    headCheck: entry.headCheck ? { ...entry.headCheck, name: HEAD_CHECK_NAME, source: 'queue-read' } : null,
    submittedBy: { projectId: entry.submittedBy.projectId },
    openGates: state.gateProblems(entry)
  };
}

/**
 * An event as a response shows it, without the launch that made it.
 * @param {object} event - An event as the store returns it
 * @returns {object}
 */
function _eventView(event) {
  const { launchId: _launchId, ...actor } = event.actor;
  return { ...event, actor };
}

/**
 * Read an entry and its queue for a caller, or throw the 404 a caller who may
 * not read it gets: the same answer as for an entry that does not exist.
 * @param {object} caller - From {@link _principal}
 * @param {*} entryId - The id from the path
 * @returns {{entry: object, queue: object}}
 */
function _readableEntry(caller, entryId) {
  if (typeof entryId !== 'string' || !ENTRY_ID_SHAPE.test(entryId)) {
    throw new QueueError(400, REFUSALS.INVALID_INPUT,
      'That is not a merge queue entry id. Read the ids with GET /api/merge-queue (`tc queue status`).');
  }
  const entry = queueStore.getEntry(entryId);
  const queue = entry ? queueStore.getQueue(entry.queueId) : null;
  if (!entry || !queue || !_mayRead(caller, queue)) {
    throw new QueueError(404, REFUSALS.ENTRY_NOT_FOUND,
      'No such merge queue entry. Read the queue with GET /api/merge-queue (`tc queue status`).');
  }
  return { entry, queue };
}

/**
 * POST /api/merge-queue — make a queue and name its owner (Operator only).
 * @param {object} req - The request
 * @param {object} body - `{ repo, baseBranch, ownerProjectId }`
 * @returns {{status: number, body: object}}
 */
function createQueue(req, body) {
  const caller = _principal(req);
  const b = body || {};
  if (caller.kind !== 'operator') {
    throw new QueueError(403, REFUSALS.OPERATOR_ONLY,
      'Only the Operator makes a merge queue and names its owner. Ask the Operator to run the command in docs/merge-queue.md.');
  }
  if (Number.isSafeInteger(b.ownerProjectId) && b.ownerProjectId > 0 && !store.projects.get(b.ownerProjectId)) {
    throw new QueueError(404, API_REFUSALS.PROJECT_NOT_FOUND,
      `No project has id ${b.ownerProjectId}. Read the ids with GET /api/projects and name the owner again.`);
  }
  const made = _accepted(queueStore.createQueue({
    repo: b.repo, baseBranch: b.baseBranch, ownerProjectId: b.ownerProjectId, actor: _actor(caller)
  }));
  return { status: 201, body: { queue: _queueView(made.queue) } };
}

/**
 * GET /api/merge-queue — every active queue the caller may read, each with its
 * unfinished entries in order.
 * @param {object} req - The request
 * @returns {{status: number, body: object}}
 */
function listQueues(req) {
  const caller = _principal(req);
  const queues = queueStore.listQueues().filter((queue) => _mayRead(caller, queue)).map((queue) => {
    const entries = queueStore.listEntries(queue.queueId, { includeFinished: false });
    const next = state.nextActive(entries);
    return {
      ..._queueView(queue),
      youAreOwner: caller.kind === 'project' && caller.projectId === queue.ownerProjectId,
      nextEntryId: next ? next.entryId : null,
      entries: entries.map(_entryView)
    };
  });
  return { status: 200, body: { queues } };
}

/**
 * GET /api/merge-queue/entries/:id — one entry, its queue and its history.
 * @param {object} req - The request
 * @param {object} params - `{ id }`
 * @returns {{status: number, body: object}}
 */
function getEntry(req, params) {
  const caller = _principal(req);
  const { entry, queue } = _readableEntry(caller, params.id);
  const events = queueStore.listEvents(queue.queueId, { entryId: entry.entryId }).map(_eventView);
  return { status: 200, body: { entry: _entryView(entry), queue: _queueView(queue), events } };
}

/**
 * The queue a submit is for: the one named, or the caller's own when it owns
 * exactly one active queue.
 * @param {object} caller - A project caller
 * @param {*} queueId - `queueId` from the body, if any
 * @returns {object} The queue
 */
function _queueForSubmit(caller, queueId) {
  if (queueId !== undefined && queueId !== null) {
    const queue = typeof queueId === 'string' ? queueStore.getQueue(queueId) : null;
    if (!queue || !_mayRead(caller, queue)) {
      throw new QueueError(404, REFUSALS.QUEUE_NOT_FOUND, 'No such merge queue. Read the queues with GET /api/merge-queue (`tc queue status`).');
    }
    return queue;
  }
  const owned = queueStore.listQueues().filter((queue) => queue.ownerProjectId === caller.projectId);
  if (owned.length === 1) return owned[0];
  if (owned.length === 0) {
    throw new QueueError(404, REFUSALS.QUEUE_NOT_FOUND,
      'This project owns no active merge queue. The Operator makes one and names its owner (docs/merge-queue.md).');
  }
  throw new QueueError(400, API_REFUSALS.QUEUE_AMBIGUOUS,
    'This project owns more than one active merge queue. Name the one you mean with queueId.',
    { queueIds: owned.map((queue) => queue.queueId) });
}

/**
 * The parts of a submit this server can check without asking anyone, or the
 * refusal. The store checks them again when it writes.
 * @param {object} b - The request body
 * @returns {{prNumber: number, headSha: string, gates: object}}
 */
function _submitInput(b) {
  if (!Number.isSafeInteger(b.prNumber) || b.prNumber <= 0) {
    throw new QueueError(400, REFUSALS.INVALID_INPUT, 'prNumber must be the pull request\'s number. Send it as a whole number.');
  }
  if (typeof b.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(b.headSha)) {
    throw new QueueError(400, REFUSALS.INVALID_INPUT,
      'headSha must be the full 40-character commit id of the reviewed head, in lower case (`git rev-parse <branch>`).');
  }
  const stated = b.gates && typeof b.gates === 'object' ? b.gates : {};
  const gates = {};
  for (const name of state.OWNER_GATES) {
    if (typeof stated[name] !== 'string' || !stated[name].trim()) {
      throw new QueueError(400, REFUSALS.GATE_REFERENCE_MISSING,
        `The ${name} gate needs a reference: where its result is recorded (a message id, a run id, a commit). Send gates.${name}.`, { gate: name });
    }
    gates[name] = stated[name];
  }
  if (!Object.hasOwn(OPERATOR_GATE_WORDS, b.operatorGate)) {
    throw new QueueError(400, REFUSALS.INVALID_INPUT,
      'operatorGate must say whether this entry needs the Operator gate: "required" or "none".');
  }
  gates.operatorRequired = OPERATOR_GATE_WORDS[b.operatorGate];
  return { prNumber: b.prNumber, headSha: b.headSha, gates };
}

/**
 * A GitHub read that could not be made, as the refusal a submit answers with.
 * @param {string} what - What was being read
 * @param {{reason: string}} answer - The `unavailable` answer
 * @returns {QueueError}
 */
function _unread(what, answer) {
  return new QueueError(503, API_REFUSALS.GITHUB_UNAVAILABLE,
    `${what} could not be read from GitHub (${answer.reason}). Nothing was queued; submit again once GitHub answers.`,
    { reason: answer.reason });
}

/**
 * Read from GitHub what a submit must be true of, or throw the refusal:
 * the pull request, its head's `test` check, and the paths it changes.
 * @param {object} queue - The queue submitted to
 * @param {{prNumber: number, headSha: string}} input - The submit
 * @returns {Promise<{runId: string, conclusion: string}>} The head check the queue read
 */
async function _readSubmit(queue, input) {
  const { prNumber, headSha } = input;
  const pull = await _internal.readPull(queue.repo, prNumber);
  if (pull.status !== 'read') throw _unread(`Pull request ${prNumber}`, pull);
  if (pull.state !== 'open') {
    throw new QueueError(409, API_REFUSALS.PR_NOT_OPEN,
      `Pull request ${prNumber} is ${pull.merged ? 'already merged' : 'closed'}. Only an open pull request is queued.`);
  }
  if (pull.baseRef !== queue.baseBranch) {
    throw new QueueError(409, API_REFUSALS.PR_WRONG_BASE,
      `Pull request ${prNumber} targets ${pull.baseRef} and this queue lands on ${queue.baseBranch}. Retarget the pull request, or submit it to that branch's queue.`,
      { baseRef: pull.baseRef });
  }
  if (pull.headSha !== headSha) {
    throw new QueueError(409, API_REFUSALS.PR_HEAD_MOVED,
      `Pull request ${prNumber}'s head is ${pull.headSha}, not the submitted ${headSha}. Review and test that head, then submit it.`,
      { headSha: pull.headSha });
  }
  if (pull.draft) {
    throw new QueueError(409, API_REFUSALS.PR_DRAFT, `Pull request ${prNumber} is a draft. Mark it ready for review, then submit it.`);
  }
  const check = await _internal.readCheck(queue.repo, headSha, HEAD_CHECK_NAME);
  if (check.status === 'unavailable') throw _unread(`The ${HEAD_CHECK_NAME} check on ${headSha}`, check);
  if (check.status !== 'concluded' || check.conclusion !== 'success') {
    const read = check.status === 'concluded' ? `concluded "${check.conclusion}"` : (check.status === 'running' ? 'is still running' : 'has not run');
    throw new QueueError(409, API_REFUSALS.HEAD_CHECK_NOT_GREEN,
      `The ${HEAD_CHECK_NAME} check on ${headSha} ${read}. Submit the head once that check has concluded success.`,
      { check: { status: check.status, conclusion: check.conclusion || null, runId: check.runId || null } });
  }
  const files = await _internal.readPullFiles(queue.repo, prNumber);
  if (files.status !== 'read') {
    throw _unread(`The whole list of files pull request ${prNumber} changes, which is what shows it starts no release,`, files);
  }
  if (files.headSha !== headSha) {
    throw new QueueError(409, API_REFUSALS.PR_HEAD_MOVED,
      `Pull request ${prNumber}'s head moved to ${files.headSha} while it was being read. Review and test that head, then submit it.`,
      { headSha: files.headSha });
  }
  const triggers = state.releaseTriggerPaths(files.paths);
  if (triggers.length) {
    throw new QueueError(409, REFUSALS.RELEASE_TRIGGER_CHANGED,
      `Pull request ${prNumber} changes ${triggers.join(' and ')}, and a change to that on ${queue.baseBranch} starts a release. `
      + 'The queue is never a release path: a version bump is merged by hand under the release process (docs/release-process.md).',
      { paths: triggers });
  }
  return { runId: check.runId, conclusion: check.conclusion };
}

/**
 * Throw the refusal a held or stopped lane gets, if the caller's lane is one.
 * @param {object} caller - A project caller
 * @param {string} [surface] - What is about to happen, for the log
 * @returns {void}
 */
function _refuseIfHeld(caller, surface = 'merge-queue-submit') {
  const held = controlGate.checkMutation({ surface, subject: { kind: 'caller', caller } });
  if (held) throw new QueueError(held.status, held.code, held.message, held.details);
}

/**
 * POST /api/merge-queue/entries — the owner submits one pull request at one
 * exact head, with its gates.
 * @param {object} req - The request
 * @param {object} body - `{ queueId?, prNumber, headSha, gates: { review, test, base }, operatorGate: 'required'|'none' }`
 * @returns {Promise<{status: number, body: object}>}
 */
async function submit(req, body) {
  const caller = _principal(req);
  const b = body || {};
  if (caller.kind !== 'project') {
    throw new QueueError(403, REFUSALS.NOT_OWNER,
      'Only a verified launch of the queue\'s owner project submits to it, and the Operator is not that. Ask the owner project\'s session to submit.');
  }
  const queue = _queueForSubmit(caller, b.queueId);
  _requireOwner(caller, queue, 'submit to it');
  const epoch = _epochCaller(req, queue);
  _refuseIfFenced(epoch);
  _refuseIfHeld(caller);
  if (queue.status !== 'active') {
    throw new QueueError(409, REFUSALS.QUEUE_RETIRED, 'This queue is retired. It keeps its history and takes nothing new; the Operator makes a new one.');
  }
  const input = _submitInput(b);
  const waiting = queueStore.listEntries(queue.queueId, { includeFinished: false }).find((e) => e.prNumber === input.prNumber);
  if (waiting) {
    throw new QueueError(409, REFUSALS.DUPLICATE_PR,
      `Pull request ${input.prNumber} already has an unfinished entry (${waiting.entryId}). Withdraw it before submitting a new head.`,
      { entryId: waiting.entryId });
  }
  const headCheck = await _readSubmit(queue, input);
  // Asked again, immediately before the write: the reads above take time, and
  // a HOLD stored or a rotation begun while they ran must still stop the entry.
  _refuseIfHeld(caller);
  _refuseIfFenced(epoch);
  const made = _accepted(queueStore.submitEntry({ queueId: queue.queueId, ...input, headCheck, actor: _actor(caller) }));
  if (!github.isCandidateRef(`${github.CANDIDATE_PREFIX}${made.entry.entryId}`)) {
    // An id no candidate branch can be named after would wait in the queue
    // for ever, so the entry is taken back out before anyone sees it queued.
    const taken = queueStore.withdrawEntry(made.entry.entryId, { reason: 'the entry id cannot name a candidate branch', actor: _actor(caller) });
    throw new QueueError(500, API_REFUSALS.ENTRY_ID_UNUSABLE, taken.ok === false
      ? `The queue made an entry id that cannot name a candidate branch, and could not withdraw the entry (${taken.code}). It is still queued and will never land: read the queue, and report this as a defect.`
      : 'The queue made an entry id that cannot name a candidate branch, and withdrew the entry. Nothing is queued; report this as a defect.',
    { withdrawn: taken.ok !== false });
  }
  return { status: 201, body: { entry: _entryView(made.entry), queue: _queueView(queue) } };
}

/**
 * The candidate branch a withdrawal must remove before the entry may leave
 * the queue, if there can be one: the branch on record, or, for an entry whose
 * candidate is being made and is not recorded yet, the branch named after it.
 * @param {object} entry - An entry as the store returns it
 * @returns {string|null}
 */
function _candidateRefOf(entry) {
  if (entry.candidate && entry.candidate.ref) return entry.candidate.ref;
  return state.isActive(entry.state) ? `${github.CANDIDATE_PREFIX}${entry.entryId}` : null;
}

/**
 * A withdrawal's reason as it will be recorded, or the refusal of one the
 * store would not take.
 * @param {object} body - `{ reason }`
 * @returns {string} The reason, trimmed
 */
function _withdrawReason(body) {
  const reason = body && body.reason;
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new QueueError(400, REFUSALS.INVALID_INPUT, 'A withdrawal needs a reason. Send reason: why the entry is leaving the queue.');
  }
  const trimmed = reason.trim();
  if (trimmed.length > MAX_WITHDRAW_REASON) {
    throw new QueueError(400, REFUSALS.INVALID_INPUT,
      `A withdrawal's reason is at most ${MAX_WITHDRAW_REASON} characters, and this one is ${trimmed.length}. `
      + 'Nothing was changed: send a shorter reason.');
  }
  return trimmed;
}

/**
 * Withdraw one entry, inside its queue's slot: delete its candidate's branches
 * if it can have any, then record it withdrawn. The coordinator epoch gate is
 * asked before the deletion and again before the record: a rotation that
 * begins while GitHub is deleting leaves the entry in the queue, for the
 * replacement context to withdraw again.
 * @param {object} caller - The owner's verified launch
 * @param {object} epoch - From {@link _epochCaller}
 * @param {object} queue - The entry's queue
 * @param {string} entryId - The entry's id
 * @param {string} reason - Why it is leaving
 * @returns {Promise<{status: number, body: object}>}
 */
async function _withdrawInSlot(caller, epoch, queue, entryId, reason) {
  // Read inside the slot: from here to the write, no other call that takes
  // the slot can move the entry.
  const entry = queueStore.getEntry(entryId);
  const allowed = state.checkTransition(entry.state, 'withdrawn');
  if (!allowed.ok) {
    const next = entry.state === 'landing'
      ? ' Its merge has been asked for, and the outcome is read before anything else is decided.'
      : '';
    throw new QueueError(409, allowed.code, `${allowed.message}${next}`);
  }
  const ref = _candidateRefOf(entry);
  let branches = null;
  if (ref) {
    _refuseIfFenced(epoch);
    const discarded = await _internal.discardCandidate(queue.repo, ref);
    branches = { candidate: discarded.candidate, stage: discarded.stage };
    if (discarded.status !== 'discarded') {
      throw new QueueError(503, API_REFUSALS.CANDIDATE_NOT_DISCARDED,
        `The entry is not withdrawn: its candidate's branches could not both be removed (${discarded.reason}). `
        + `${ref} is ${discarded.candidate} and its stage branch is ${discarded.stage}. Withdraw again; repeating it is harmless.`,
        { ref, ...branches, reason: discarded.reason });
    }
  }
  _refuseIfFenced(epoch);
  const done = _accepted(queueStore.withdrawEntry(entry.entryId, { reason, actor: _actor(caller) }));
  return { status: 200, body: { entry: _entryView(done.entry), branches } };
}

/**
 * POST /api/merge-queue/entries/:id/withdraw — the owner takes an entry out of
 * the queue. The reason is checked before anything else is done. An entry with
 * a candidate has both its branches deleted on GitHub first; while either is
 * left the entry stays, and the answer says which. Asking again is harmless.
 * A withdrawal arriving while another call holds the queue's slot changes
 * nothing and is refused.
 * @param {object} req - The request
 * @param {object} params - `{ id }`
 * @param {object} body - `{ reason }`
 * @returns {Promise<{status: number, body: object}>}
 */
async function withdraw(req, params, body) {
  const caller = _principal(req);
  const { entry, queue } = _readableEntry(caller, params.id);
  _requireOwner(caller, queue, 'withdraw its entries');
  const epoch = _epochCaller(req, queue);
  _refuseIfFenced(epoch);
  const reason = _withdrawReason(body);
  try {
    return await withQueueSlot(queue.queueId, () => _withdrawInSlot(caller, epoch, queue, entry.entryId, reason));
  } catch (err) {
    if (!(err instanceof QueueSlotTaken)) throw err;
    throw new QueueError(409, API_REFUSALS.QUEUE_CALL_IN_FLIGHT,
      'Another advance, withdrawal or settlement of this queue is running, so this withdrawal changed nothing. '
      + 'Read `tc queue status`, then withdraw again if the entry is still there.',
      { queueId: queue.queueId, entryId: entry.entryId });
  }
}

/**
 * The owner's inbox, as an advance reads it immediately before a merge request:
 * the in-memory inbox of the session behind the launch this request was
 * verified as, never a session the request names. Synchronous, so the read and
 * the merge request it clears have no wait between them.
 *
 * The binding taken when the request arrived is resolved again here: a launch
 * that has since ended or been replaced cannot be read for, and neither can a
 * session whose listener is not listening, because an inbox that is not being
 * filled reads as empty whatever was sent to it.
 *
 * A message whose envelope `from` is `system` is a server-origin notice and is
 * counted, not judged; every other message is unhandled mail and is answered by
 * its id and sender alone. The test is the envelope's, never the body's: a
 * peer can write any body, while TangleClaw fills `from` from the sending
 * listener's own workspace id. A process that reaches the Bridge's loopback
 * endpoint directly can set `from`, the same boundary the inbox's own drain of
 * system notices accepts.
 * @param {object} req - The advance request
 * @param {{projectId: number, launchId: string, sessionId: number}|null} binding - The verified launch, as read when the request arrived
 * @returns {object} `{ readable: false, reason }`, or `{ readable: true, binding, checkedAt, listenerState, blocking, systemExcluded }`
 */
function _readOwnerInbox(req, binding) {
  if (!binding) return { readable: false, reason: 'the request\'s launch names no session' };
  const now = _internal.resolveBinding(req);
  if (now.kind !== sharedDocsAccess.KINDS.PROJECT || now.projectId !== binding.projectId
    || now.launchId !== binding.launchId || now.sessionId !== binding.sessionId) {
    return { readable: false, reason: 'the launch this request was verified as has ended or been replaced' };
  }
  const listener = _internal.listenerStatus(binding.sessionId) || {};
  if (listener.state !== 'listening') {
    return { readable: false, reason: `the session's Medusa listener is ${listener.state || 'absent'}, not listening` };
  }
  const messages = _internal.inbox(binding.sessionId) || [];
  const blocking = [];
  let systemExcluded = 0;
  for (const m of messages) {
    if (m && m.from === 'system') systemExcluded += 1;
    else blocking.push({ id: m && typeof m.id === 'string' ? m.id : null, from: m && typeof m.from === 'string' ? m.from : null });
  }
  return { readable: true, binding, checkedAt: new Date().toISOString(), listenerState: listener.state, blocking, systemExcluded };
}

/**
 * POST /api/merge-queue/advance — the owner moves its queue's front entry one
 * step: make its candidate, or land it once its candidate's `test` has
 * concluded and everything a landing rests on holds, or fail it. One step per
 * call, inside the queue's slot. The epoch gate and the HOLD are asked when
 * the request arrives and again immediately before every queue write, branch
 * deletion and the merge request. The owner's inbox is read immediately
 * before the merge request ({@link _readOwnerInbox}), and an unread or
 * unhandled message refuses the landing. Nothing calls this but the owner:
 * there is no timer.
 * @param {object} req - The request
 * @param {object} body - `{ queueId? }`
 * @returns {Promise<{status: number, body: object}>} 200 with `step`, `changed`, `message` and the entry it was about
 */
async function advance(req, body) {
  const caller = _principal(req);
  const b = body || {};
  if (caller.kind !== 'project') {
    throw new QueueError(403, REFUSALS.NOT_OWNER,
      'Only a verified launch of the queue\'s owner project advances it, and the Operator is not that. Ask the owner project\'s session to advance.');
  }
  const queue = _queueForSubmit(caller, b.queueId);
  _requireOwner(caller, queue, 'advance it');
  const epoch = _epochCaller(req, queue);
  const guard = () => {
    _refuseIfFenced(epoch);
    _refuseIfHeld(caller, 'merge-queue-advance');
  };
  guard();
  const binding = epoch.access.kind === sharedDocsAccess.KINDS.PROJECT && epoch.access.sessionId != null
    ? { projectId: epoch.access.projectId, launchId: epoch.access.launchId, sessionId: epoch.access.sessionId } : null;
  const inboxCheck = () => _readOwnerInbox(req, binding);
  let outcome;
  try {
    outcome = await withQueueSlot(queue.queueId, () => mergeQueue.advance(queue, { actor: _actor(caller), guard, inboxCheck, github: ADVANCE_GITHUB }));
  } catch (err) {
    if (err instanceof QueueSlotTaken) {
      throw new QueueError(409, API_REFUSALS.QUEUE_CALL_IN_FLIGHT,
        'Another advance, withdrawal or settlement of this queue is running, so this advance changed nothing. Read `tc queue status`, then advance again.',
        { queueId: queue.queueId });
    }
    if (err instanceof mergeQueue.AdvanceRefusal) {
      throw new QueueError(err.status || STORE_STATUS[err.code] || 409, err.code, err.message, { queueId: queue.queueId, ...err.details });
    }
    throw err;
  }
  const entry = outcome.entryId ? queueStore.getEntry(outcome.entryId) : null;
  return { status: 200, body: { ...outcome, entry: entry ? _entryView(entry) : null, queue: _queueView(queueStore.getQueue(queue.queueId)) } };
}

/**
 * POST /api/merge-queue/entries/:id/operator-gate — the Operator records the
 * gate of an entry that was submitted as needing it.
 * @param {object} req - The request
 * @param {object} params - `{ id }`
 * @param {object} body - `{ reference }`
 * @returns {{status: number, body: object}}
 */
function recordOperatorGate(req, params, body) {
  const caller = _principal(req);
  if (caller.kind !== 'operator') {
    throw new QueueError(403, REFUSALS.OPERATOR_ONLY,
      'Only the Operator records the Operator gate. A session saying the Operator agreed is not the Operator: ask them to record it.');
  }
  const { entry } = _readableEntry(caller, params.id);
  const done = _accepted(queueStore.recordOperatorGate(entry.entryId, { reference: body && body.reference, actor: _actor(caller) }));
  return { status: 200, body: { entry: _entryView(done.entry) } };
}

/**
 * POST /api/merge-queue/:id/clear-halt — the Operator clears the halt of a
 * queue that halted itself, saying what was checked or decided. The queue
 * halts when a landed tree is not the tested one, and a person decides what
 * that needs before anything else lands; a session saying the Operator agreed
 * is not the Operator.
 * @param {object} req - The request
 * @param {object} params - `{ id }`, the queue's id
 * @param {object} body - `{ reference }`
 * @returns {{status: number, body: object}}
 */
function clearHalt(req, params, body) {
  const caller = _principal(req);
  if (caller.kind !== 'operator') {
    throw new QueueError(403, REFUSALS.OPERATOR_ONLY,
      'Only the Operator clears a halted merge queue. A session saying the Operator agreed is not the Operator: ask them to clear it.');
  }
  const queue = typeof params.id === 'string' && QUEUE_ID_SHAPE.test(params.id) ? queueStore.getQueue(params.id) : null;
  if (!queue) {
    throw new QueueError(404, REFUSALS.QUEUE_NOT_FOUND, 'No such merge queue. Read the queues with GET /api/merge-queue (`tc queue status`).');
  }
  if (!queue.halt) {
    throw new QueueError(409, REFUSALS.QUEUE_NOT_HALTED, 'This queue is not halted, so there is nothing to clear. Read it with GET /api/merge-queue.');
  }
  const reference = body && body.reference;
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new QueueError(400, REFUSALS.INVALID_INPUT, 'Clearing a halt needs a reference: what was checked or decided about the base branch. Send reference.');
  }
  const done = _accepted(queueStore.clearHalt(queue.queueId, { reference, actor: _actor(caller) }));
  log.info('Merge queue halt cleared by the Operator', { queueId: queue.queueId, haltCode: queue.halt && queue.halt.code });
  return { status: 200, body: { queue: _queueView(done.queue), cleared: queue.halt } };
}

/**
 * The refusal of a settlement for an entry that is not `landing`, before or
 * after the slot was taken: nothing was read and nothing was changed.
 * @param {object} entry - The entry as read
 * @returns {QueueError}
 */
function _notLanding(entry) {
  return new QueueError(409, state.isFinished(entry.state) ? REFUSALS.ENTRY_FINISHED : REFUSALS.TRANSITION_NOT_ALLOWED,
    `Only an entry in landing is settled; entry ${entry.entryId} is ${entry.state}. Nothing was read or changed: read the entry again before deciding.`,
    { entryId: entry.entryId, state: entry.state });
}

/**
 * A GitHub read a settlement needs that could not be made.
 * @param {string} what - What was being read
 * @param {{reason: string}} answer - The `unavailable` answer
 * @param {string} [code] - The refusal's code, `GITHUB_UNAVAILABLE` when not given
 * @returns {QueueError}
 */
function _settleUnread(what, answer, code = API_REFUSALS.GITHUB_UNAVAILABLE) {
  return new QueueError(503, code,
    `${what} could not be read from GitHub (${answer.reason}). Nothing was changed: settle again once GitHub answers.`,
    { reason: answer.reason });
}

/**
 * Read the pull request and the base branch's tip, as every settlement must.
 * Neither read is ever taken as "not merged" when it fails: it refuses.
 * @param {object} queue - The queue
 * @param {object} entry - The `landing` entry
 * @returns {Promise<{pull: object, tip: string, readAt: string}>}
 */
async function _settleReads(queue, entry) {
  const pull = await _internal.readPull(queue.repo, entry.prNumber);
  if (pull.status !== 'read') throw _settleUnread(`Pull request ${entry.prNumber}`, pull);
  const tip = await _internal.readRefTip(queue.repo, queue.baseBranch);
  if (tip.status !== 'read') {
    throw _settleUnread(`The tip of ${queue.baseBranch}`, tip.status === 'not-found' ? { reason: 'GitHub says no such branch exists' } : tip);
  }
  return { pull, tip: tip.sha, readAt: new Date().toISOString() };
}

/**
 * Read what a landed settlement rests on: the commit, the base branch's tip
 * read now, that the commit is reachable from that tip, and the pull request.
 * The tip never stands in for the commit, and a commit that is not on the base
 * is refused.
 * @param {object} queue - The queue
 * @param {object} entry - The `landing` entry
 * @param {string} sha - The commit the Operator names
 * @returns {Promise<{landedSha: string, landedTree: string, readBack: object, provenance: object}>}
 */
async function _readLandedSettlement(queue, entry, sha) {
  const commit = await _internal.readCommit(queue.repo, sha);
  if (commit.status !== 'read') throw _settleUnread(`Commit ${sha}`, commit, API_REFUSALS.SETTLE_COMMIT_UNREADABLE);
  const { pull, tip, readAt } = await _settleReads(queue, entry);
  const ancestry = await _internal.readAncestry(queue.repo, sha, tip);
  if (ancestry.status === 'not-reachable') {
    throw new QueueError(409, API_REFUSALS.SETTLE_NOT_ON_BASE,
      `Commit ${sha} is not on ${queue.baseBranch}: compared with its tip ${tip}, GitHub answers "${ancestry.compareStatus}". `
      + `Nothing was changed. Name the commit ${queue.baseBranch} holds for this pull request, or settle the entry as failed.`,
      { sha, baseTip: tip, compareStatus: ancestry.compareStatus });
  }
  if (ancestry.status !== 'reachable') throw _settleUnread(`Whether ${sha} is on ${queue.baseBranch} at ${tip}`, ancestry);
  const readBack = { merged: pull.merged, state: pull.state, mergeCommitSha: pull.mergeCommitSha };
  return {
    landedSha: sha, landedTree: commit.tree, readBack,
    provenance: {
      readAt, baseBranch: queue.baseBranch, baseTip: tip, compareStatus: ancestry.compareStatus,
      commit: { sha, tree: commit.tree, parents: commit.parents }, parentIsSubmittedHead: commit.parents.includes(entry.headSha),
      submittedHead: entry.headSha, pull: readBack
    }
  };
}

/**
 * What a settlement's answer says happened, in words.
 * @param {object} entry - The entry as it was before
 * @param {object} done - The store's answer
 * @param {object} read - What was read
 * @param {object} asked - What the Operator asked for
 * @returns {{case: string, message: string}}
 */
function _settlementWords(entry, done, read, asked) {
  const pr = `Entry ${entry.entryId} (PR #${entry.prNumber})`;
  let halt = ' No halt stands.';
  if (done.queueHalted && !done.haltKept) halt = ' The queue is now HALTED: nothing advances until the Operator clears the halt.';
  else if (done.haltKept && done.haltReasonRecorded) halt = ' The queue was already halted and its halt is kept; this settlement\'s halt reason is recorded beside it as a further event.';
  else if (done.haltKept) halt = ' The queue was already halted and stays halted, unchanged; this settlement adds no halt reason of its own.';
  if (asked.outcome === 'landed') {
    const tree = done.treeMatches ? 'its tree is the tested candidate\'s' : 'ITS TREE IS NOT THE TESTED CANDIDATE\'S';
    return {
      case: done.treeMatches ? 'landed-tree-matches' : 'landed-tree-mismatch',
      message: `${pr} is SETTLED as landed at ${read.landedSha}, which is on ${read.provenance.baseBranch} at ${read.provenance.baseTip}; ${tree}.${halt}`
    };
  }
  const at = read.provenance.readAt;
  if (read.readBack.merged) {
    return {
      case: 'failed-pull-merged',
      message: `${pr} is SETTLED as failed, but GitHub reported the pull request MERGED at ${at}, so what reached the base is unreconciled.${halt}`
    };
  }
  const disposed = asked.mergeAttempt === state.MERGE_ATTEMPT_UNSUCCESSFUL;
  return {
    case: disposed ? 'failed-attempt-unsuccessful' : 'failed-attempt-undisposed',
    message: `${pr} is SETTLED as failed. GitHub reported the pull request unmerged at ${at}, which is a snapshot and not proof that the merge cannot still complete; `
      + `${disposed ? 'the Operator disposed of the merge request as unsuccessful' : 'the merge request was not disposed of as unsuccessful, so the outcome is unreconciled'}.${halt}`
  };
}

/**
 * Settle one entry inside its queue's slot: read the entry again, read GitHub,
 * record the settlement, then, once it is recorded, remove the candidate's
 * branches if they are the queue's to remove.
 * @param {object} caller - The Operator
 * @param {object} queue - The entry's queue
 * @param {string} entryId - The entry's id
 * @param {object} asked - `{ outcome, sha?, reference, attestation, mergeAttempt? }`
 * @returns {Promise<{status: number, body: object}>}
 */
async function _settleInSlot(caller, queue, entryId, asked) {
  // Read inside the slot: from here to the write, no other call that takes
  // the slot can move the entry, and the store checks the state once more.
  const entry = queueStore.getEntry(entryId);
  if (entry.state !== 'landing') throw _notLanding(entry);
  let read;
  if (asked.outcome === 'landed') {
    read = await _readLandedSettlement(queue, entry, asked.sha);
  } else {
    const { pull, tip, readAt } = await _settleReads(queue, entry);
    const readBack = { merged: pull.merged, state: pull.state, mergeCommitSha: pull.mergeCommitSha };
    read = { readBack, provenance: { readAt, baseBranch: queue.baseBranch, baseTip: tip, pull: readBack } };
  }
  const done = _accepted(queueStore.settleLanding(entry.entryId, {
    actor: _actor(caller), outcome: asked.outcome, reference: asked.reference, attestation: asked.attestation,
    ...(asked.mergeAttempt !== undefined ? { mergeAttempt: asked.mergeAttempt } : {}),
    landedSha: read.landedSha, landedTree: read.landedTree, readBack: read.readBack, provenance: read.provenance
  }));
  const words = _settlementWords(entry, done, read, asked);
  log.info('Merge queue entry settled by the Operator', {
    queueId: queue.queueId, entryId: entry.entryId, prNumber: entry.prNumber, outcome: asked.outcome, case: words.case, queueHalted: done.queueHalted
  });
  const cleanup = await mergeQueue.cleanupFinished(queue, done.entry, queueStore.listEntries(queue.queueId), _internal.discardCandidate);
  const after = {
    removed: ' Its candidate\'s branches are removed.',
    skipped: ` Its candidate's branches were NOT removed [${cleanup.reason}]: only a candidate branch this queue owns, and no other entry records, is ever deleted.`,
    failed: ' Its candidate\'s branches were NOT all removed; the settlement stands, and the next advance removes them before anything else.'
  }[cleanup.status];
  return {
    status: 200,
    body: {
      entry: _entryView(done.entry), queue: _queueView(queueStore.getQueue(queue.queueId)),
      settlement: {
        outcome: asked.outcome, case: words.case, queueHalted: done.queueHalted, haltKept: done.haltKept, haltReasonRecorded: done.haltReasonRecorded,
        ...(asked.outcome === 'landed' ? { treeMatches: done.treeMatches } : { reconciliationHalt: done.reconciliationHalt }),
        readBack: read.readBack, provenance: read.provenance
      },
      cleanup,
      message: `${words.message}${after} Nothing was merged, deployed or released by this call.`
    }
  };
}

/**
 * POST /api/merge-queue/entries/:id/settle-landing — the Operator settles an
 * entry left `landing`: one whose merge was asked for and whose outcome the
 * queue could not record, so nothing behind it advances. Only the Operator,
 * with a reference and an attestation; only an entry in `landing`; inside the
 * queue's slot, so it never runs beside an advance or a withdrawal.
 *
 * `landed` names the commit on the base branch. It is read, the base branch's
 * tip is read now, and the commit must be reachable from that tip. Its tree
 * against the candidate's decides a halt, and an existing halt is kept.
 *
 * `failed` is the Operator's disposition on evidence. The pull request is read
 * now and recorded. It halts the queue on `LANDING_SETTLED_UNRECONCILED`
 * unless the pull request reads back unmerged and the Operator sends
 * `mergeAttempt: 'unsuccessful'`, disposing of the merge request.
 *
 * Every GitHub read is required: one that fails refuses and changes nothing.
 * The candidate's branches are removed only after the settlement is recorded,
 * and only if they are the queue's own.
 * @param {object} req - The request
 * @param {object} params - `{ id }`
 * @param {object} body - `{ outcome: 'landed'|'failed', sha?, mergeAttempt?, reference, attestation }`
 * @returns {Promise<{status: number, body: object}>}
 */
async function settleLanding(req, params, body) {
  const caller = _principal(req);
  if (caller.kind !== 'operator') {
    throw new QueueError(403, REFUSALS.OPERATOR_ONLY,
      'Only the Operator settles an entry stuck in landing. A session saying the Operator agreed is not the Operator: ask them to settle it.');
  }
  const { entry, queue } = _readableEntry(caller, params.id);
  const b = body || {};
  const asked = { outcome: b.outcome, sha: b.sha, reference: b.reference, attestation: b.attestation, mergeAttempt: b.mergeAttempt };
  const refused = queueStore.settleRequestRefusal(asked);
  if (refused) _accepted(refused);
  if (entry.state !== 'landing') throw _notLanding(entry);
  try {
    return await withQueueSlot(queue.queueId, () => _settleInSlot(caller, queue, entry.entryId, asked));
  } catch (err) {
    if (!(err instanceof QueueSlotTaken)) throw err;
    throw new QueueError(409, API_REFUSALS.QUEUE_CALL_IN_FLIGHT,
      'Another advance, withdrawal or settlement of this queue is running, so this settlement read and changed nothing. '
      + 'Read `tc queue status`, then settle again if the entry is still landing.',
      { queueId: queue.queueId, entryId: entry.entryId });
  }
}

module.exports = {
  QueueError,
  API_REFUSALS,
  HEAD_CHECK_NAME,
  MAX_WITHDRAW_REASON,
  createQueue,
  listQueues,
  getEntry,
  submit,
  withdraw,
  advance,
  recordOperatorGate,
  clearHalt,
  settleLanding,
  _internal
};
