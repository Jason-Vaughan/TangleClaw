'use strict';

/**
 * The merge queue: its vocabulary and its rules, with no I/O.
 *
 * A queue belongs to one repository and base branch and has one owner project.
 * An entry is one pull request at one exact head commit. One entry at a time
 * is "active": the queue is assembling its candidate, waiting for the
 * candidate's test, or landing it. Everything else waits in submission order.
 *
 * This module says which states exist, which moves between them are allowed,
 * which entry is next, and what is still wrong with an entry's gates. The
 * tables' CHECK constraints are built from the lists here when a table is
 * created, and a CHECK is fixed from then on: adding or renaming a word in
 * `STATES`, `QUEUE_STATUSES`, the gate statuses, `ACTOR_KINDS` or `EVENTS`
 * needs a schema number and a rebuild of the table that holds it, or an
 * existing store refuses the new word. `test/merge-queue-state.test.js` pins
 * the lists for that reason. `lib/merge-queue-store.js` is the only writer and
 * asks this module before every change.
 *
 * @module lib/merge-queue-state
 */

/** Every state an entry can be in. */
const STATES = Object.freeze(['queued', 'assembling', 'testing', 'landing', 'landed', 'failed', 'withdrawn']);

/** States in which an entry holds the queue: at most one entry per queue is in any of these. */
const ACTIVE_STATES = Object.freeze(['assembling', 'testing', 'landing']);

/** States an entry never leaves. */
const FINISHED_STATES = Object.freeze(['landed', 'failed', 'withdrawn']);

/**
 * The allowed moves. Anything not listed is refused.
 *
 * - `testing → assembling` and `landing → assembling`: the base moved after
 *   the candidate was made, so the candidate is discarded and made again. Not
 *   a failure.
 * - `landing → testing`: the merge was not made (its outcome was read and the
 *   pull request is still open), so the entry goes back to waiting with its
 *   candidate intact.
 * - `landing → withdrawn` is absent on purpose: once the merge has been asked
 *   for, its outcome is read before anything else may be decided.
 */
const TRANSITIONS = Object.freeze({
  queued: Object.freeze(['assembling', 'failed', 'withdrawn']),
  assembling: Object.freeze(['testing', 'failed', 'withdrawn']),
  testing: Object.freeze(['landing', 'assembling', 'failed', 'withdrawn']),
  landing: Object.freeze(['landed', 'testing', 'assembling', 'failed']),
  landed: Object.freeze([]),
  failed: Object.freeze([]),
  withdrawn: Object.freeze([])
});

/** A queue's own status. A retired queue keeps its history and takes nothing new. */
const QUEUE_STATUSES = Object.freeze(['active', 'retired']);

/** The three gates the owner states when it submits, each with a reference. */
const OWNER_GATES = Object.freeze(['review', 'test', 'base']);

/** What an owner-stated gate can read. */
const OWNER_GATE_STATUSES = Object.freeze(['missing', 'recorded']);

/**
 * What the Operator gate can read. `required` is open: the entry cannot land
 * until the Operator records it. Only the Operator moves it to `recorded`.
 */
const OPERATOR_GATE_STATUSES = Object.freeze(['not-required', 'required', 'recorded']);

/** Who can be the actor of a recorded change: the Operator, or a project's verified launch. */
const ACTOR_KINDS = Object.freeze(['operator', 'project']);

/** Every event the history can hold. */
const EVENTS = Object.freeze([
  'queue-created', 'queue-retired', 'queue-halted', 'queue-halt-cleared',
  'submitted', 'operator-gate-recorded',
  'assembly-started', 'candidate-made', 'candidate-discarded',
  'landing-started', 'landing-not-made', 'landed', 'failed', 'withdrawn'
]);

/** The event each allowed move is recorded as. */
const TRANSITION_EVENTS = Object.freeze({
  'queued>assembling': 'assembly-started',
  'assembling>testing': 'candidate-made',
  'testing>assembling': 'candidate-discarded',
  'landing>assembling': 'candidate-discarded',
  'testing>landing': 'landing-started',
  'landing>testing': 'landing-not-made',
  'landing>landed': 'landed'
});

/** Named refusals. Callers match on the code; the message is for a person. */
const REFUSALS = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  UNKNOWN_STATE: 'UNKNOWN_STATE',
  TRANSITION_NOT_ALLOWED: 'TRANSITION_NOT_ALLOWED',
  ENTRY_FINISHED: 'ENTRY_FINISHED',
  QUEUE_NOT_FOUND: 'QUEUE_NOT_FOUND',
  QUEUE_EXISTS: 'QUEUE_EXISTS',
  QUEUE_RETIRED: 'QUEUE_RETIRED',
  QUEUE_HALTED: 'QUEUE_HALTED',
  QUEUE_NOT_HALTED: 'QUEUE_NOT_HALTED',
  QUEUE_NOT_EMPTY: 'QUEUE_NOT_EMPTY',
  QUEUE_BUSY: 'QUEUE_BUSY',
  NOT_FRONT: 'NOT_FRONT',
  ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
  DUPLICATE_PR: 'DUPLICATE_PR',
  NOT_OWNER: 'NOT_OWNER',
  OPERATOR_ONLY: 'OPERATOR_ONLY',
  GATE_NOT_RECORDED: 'GATE_NOT_RECORDED',
  GATE_REFERENCE_MISSING: 'GATE_REFERENCE_MISSING',
  OPERATOR_GATE_OPEN: 'OPERATOR_GATE_OPEN',
  OPERATOR_GATE_NOT_REQUIRED: 'OPERATOR_GATE_NOT_REQUIRED',
  OPERATOR_GATE_ALREADY_RECORDED: 'OPERATOR_GATE_ALREADY_RECORDED',
  GATES_NOT_MET: 'GATES_NOT_MET',
  CANDIDATE_NOT_GREEN: 'CANDIDATE_NOT_GREEN'
});

/**
 * Whether an entry in this state holds the queue.
 * @param {string} state - An entry state
 * @returns {boolean}
 */
function isActive(state) {
  return ACTIVE_STATES.includes(state);
}

/**
 * Whether an entry in this state is done and will never move again.
 * @param {string} state - An entry state
 * @returns {boolean}
 */
function isFinished(state) {
  return FINISHED_STATES.includes(state);
}

/**
 * Whether an entry may move from one state to another.
 * @param {string} from - The state the entry is in
 * @param {string} to - The state asked for
 * @returns {{ok: true, event: string}|{ok: false, code: string, message: string}}
 *   `event` is the name the move is recorded under.
 */
function checkTransition(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to)) {
    return { ok: false, code: REFUSALS.UNKNOWN_STATE, message: `"${STATES.includes(from) ? to : from}" is not a merge queue entry state.` };
  }
  if (isFinished(from)) {
    return { ok: false, code: REFUSALS.ENTRY_FINISHED, message: `The entry is ${from} and cannot change. Submit the pull request again to queue it anew.` };
  }
  if (!TRANSITIONS[from].includes(to)) {
    return { ok: false, code: REFUSALS.TRANSITION_NOT_ALLOWED, message: `An entry cannot go from ${from} to ${to}.` };
  }
  return { ok: true, event: TRANSITION_EVENTS[`${from}>${to}`] || to };
}

/**
 * The entry that holds the queue or is next to: the active one when there is
 * one, otherwise the queued entry submitted first. Finished entries never
 * count, so a withdrawal in the middle leaves the others in their order.
 * @param {Array<{state: string, position: number}>} entries - One queue's entries
 * @returns {object|null} The entry, or null when nothing is waiting
 */
function nextActive(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const active = list.find((e) => isActive(e.state));
  if (active) return active;
  const queued = list.filter((e) => e.state === 'queued');
  if (!queued.length) return null;
  return queued.reduce((first, e) => (e.position < first.position ? e : first));
}

/**
 * What still stops an entry landing, read from its recorded gates.
 * @param {object} entry - An entry as the store returns it (`gates.review`, `gates.test`, `gates.base`, `gates.operator`)
 * @returns {Array<{gate: string, code: string, message: string}>} Empty when every gate is met
 */
function gateProblems(entry) {
  const gates = (entry && entry.gates) || {};
  const problems = [];
  for (const name of OWNER_GATES) {
    const gate = gates[name] || {};
    if (gate.status !== 'recorded') {
      problems.push({ gate: name, code: REFUSALS.GATE_NOT_RECORDED, message: `The ${name} gate is not recorded.` });
    } else if (typeof gate.reference !== 'string' || !gate.reference.trim()) {
      problems.push({ gate: name, code: REFUSALS.GATE_REFERENCE_MISSING, message: `The ${name} gate has no reference.` });
    }
  }
  const operator = gates.operator || {};
  if (operator.status === 'required') {
    problems.push({ gate: 'operator', code: REFUSALS.OPERATOR_GATE_OPEN, message: 'The Operator gate is required and the Operator has not recorded it.' });
  } else if (operator.status === 'recorded') {
    if (typeof operator.reference !== 'string' || !operator.reference.trim()) {
      problems.push({ gate: 'operator', code: REFUSALS.GATE_REFERENCE_MISSING, message: 'The Operator gate has no reference.' });
    }
  } else if (operator.status !== 'not-required') {
    problems.push({ gate: 'operator', code: REFUSALS.GATE_NOT_RECORDED, message: 'The Operator gate has no readable status.' });
  }
  return problems;
}

module.exports = {
  STATES,
  ACTIVE_STATES,
  FINISHED_STATES,
  TRANSITIONS,
  TRANSITION_EVENTS,
  QUEUE_STATUSES,
  OWNER_GATES,
  OWNER_GATE_STATUSES,
  OPERATOR_GATE_STATUSES,
  ACTOR_KINDS,
  EVENTS,
  REFUSALS,
  isActive,
  isFinished,
  checkTransition,
  nextActive,
  gateProblems
};
