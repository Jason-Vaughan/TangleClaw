'use strict';

/**
 * v6 (#3212 Phase 1.1, Ruling A1042 / Ruling A958, Car V660-W1-B): the
 * Control-Plane GitHub Merge Broker's 4-gate verification.
 *
 * A mechanical readiness check, not a queue: {@link verifyFourGateMergeReadiness}
 * and {@link authorizeControlPlaneMerge} verify that `O-Gate` (observer),
 * `A-Gate` (architect), `R-Gate` (reviewer) and `CI` receipts all carry
 * `PASS` and are pinned to the exact head commit being merged, and that the
 * actor attempting the merge holds an authority class allowed to execute
 * one. Nothing here reads a database, calls GitHub, or persists state — the
 * caller supplies the receipts and reads back a verdict. This module is
 * deliberately separate from the pre-existing top-level `lib/merge-queue*.js`
 * (its own `review`/`test`/`base` gate vocabulary, its own SQLite-backed
 * queue, its own GitHub calls): Phase 1.1's four named gates are a distinct
 * v6 control-plane vocabulary, and this module does not touch that
 * infrastructure.
 *
 * @module lib/v6/c3-merge-queue
 */

/** A typed merge-broker refusal: `code` is stable, `status` is the HTTP status a route should answer with. */
class MergeQueueError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   * @param {object} [detail]
   */
  constructor(code, message, status = 400, detail) {
    super(message);
    this.name = 'MergeQueueError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Throw a {@link MergeQueueError} unless `condition` holds.
 * @param {*} condition
 * @param {string} code
 * @param {string} message
 * @param {number} [status]
 * @param {object} [detail]
 * @returns {void}
 */
function need(condition, code, message, status = 400, detail) {
  if (!condition) throw new MergeQueueError(code, message, status, detail);
}

/** A head commit id: the full 40-character lower-case hex sha, matching this repo's existing `lib/merge-queue-api.js` convention. */
const SHA_SHAPE = /^[0-9a-f]{40}$/;

/**
 * The four gates a merge must clear, in verification order. `keys` lists
 * every property name {@link gateReceipts} may carry this gate's receipt
 * under — CI alone has two accepted spellings (`ci`, `Tests`) because this
 * repo's own records (`LANE_QUEUE.md`) write it both ways; the first key
 * present wins.
 * @type {ReadonlyArray<{label: string, keys: ReadonlyArray<string>}>}
 */
const GATE_SPEC = Object.freeze([
  Object.freeze({ label: 'O-Gate', keys: Object.freeze(['observer']) }),
  Object.freeze({ label: 'A-Gate', keys: Object.freeze(['architect']) }),
  Object.freeze({ label: 'R-Gate', keys: Object.freeze(['reviewer']) }),
  Object.freeze({ label: 'CI', keys: Object.freeze(['ci', 'Tests']) })
]);

/** The authority classes allowed to execute a control-plane merge; everything else, including `builder`, is forbidden. */
const AUTHORIZED_MERGE_ACTOR_CLASSES = Object.freeze(['integrator', 'operator']);

/**
 * `obj[key]` only when `key` is `obj`'s own property — never a prototype's,
 * so a receipt map cannot be spoofed via `constructor`, `toString`, etc.
 * @param {object} obj
 * @param {string} key
 * @returns {*}
 */
function own(obj, key) {
  return obj && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * The first gate's receipt found under any of its accepted keys.
 * @param {object} gateReceipts
 * @param {ReadonlyArray<string>} keys
 * @returns {{receipt: *, key: (string|null)}}
 */
function _findReceipt(gateReceipts, keys) {
  for (const key of keys) {
    const receipt = own(gateReceipts, key);
    if (receipt !== undefined) return { receipt, key };
  }
  return { receipt: undefined, key: null };
}

/**
 * Whether a single gate's receipt satisfies readiness: present, `verdict
 * === 'PASS'`, and pinned to the exact `headSha` being merged. Returns a
 * reason string on failure rather than throwing, so the caller can report
 * every failing gate's `detail` in one refusal instead of only the first.
 * @param {*} receipt
 * @param {string} headSha
 * @returns {{ok: true}|{ok: false, reason: 'missing'|'verdict'|'sha-mismatch'}}
 */
function _gateSatisfied(receipt, headSha) {
  if (receipt === undefined || receipt === null || typeof receipt !== 'object') return { ok: false, reason: 'missing' };
  if (receipt.verdict !== 'PASS') return { ok: false, reason: 'verdict' };
  if (receipt.headSha !== headSha) return { ok: false, reason: 'sha-mismatch' };
  return { ok: true };
}

/**
 * Verify that `item` (anything carrying the `headSha` under review) clears
 * all four gates: `O-Gate`, `A-Gate`, `R-Gate` and `CI`, each a `PASS`
 * receipt pinned to `item.headSha`. A receipt that is missing entirely, not
 * `PASS`, or pinned to a different sha are all the same refusal — stale
 * readiness — since none of the three means the gate actually passed
 * against the commit being merged right now.
 * @param {{headSha: string}} item
 * @param {object} gateReceipts - `{ observer, architect, reviewer, ci|Tests }`, each `{verdict, headSha, ...}`.
 * @returns {{ok: true, headSha: string, gates: {observer: object, architect: object, reviewer: object, ci: object}}}
 * @throws {MergeQueueError} `ITEM_REQUIRED`, `HEAD_SHA_INVALID`, `GATE_RECEIPTS_REQUIRED`, `STALE_GATE_RECEIPT_SHA`.
 */
function verifyFourGateMergeReadiness(item, gateReceipts) {
  need(item && typeof item === 'object', 'ITEM_REQUIRED', 'item is required');
  need(typeof item.headSha === 'string' && SHA_SHAPE.test(item.headSha), 'HEAD_SHA_INVALID',
    'item.headSha must be the full 40-character commit id of the reviewed head, in lower case');
  need(gateReceipts && typeof gateReceipts === 'object', 'GATE_RECEIPTS_REQUIRED', 'gateReceipts is required');

  const { headSha } = item;
  const gates = {};
  const failures = [];
  for (const spec of GATE_SPEC) {
    const { receipt, key } = _findReceipt(gateReceipts, spec.keys);
    const verdict = _gateSatisfied(receipt, headSha);
    if (!verdict.ok) {
      failures.push({ gate: spec.label, key, reason: verdict.reason, receipt: receipt === undefined ? null : receipt });
    } else {
      gates[spec.keys[0]] = receipt;
    }
  }
  need(failures.length === 0, 'STALE_GATE_RECEIPT_SHA',
    `${failures.map((f) => `${f.gate} (${f.reason})`).join(', ')} -- every gate must carry a PASS receipt pinned to ${headSha}`,
    409, { headSha, failures });

  return { ok: true, headSha, gates };
}

/**
 * Authorize a control-plane merge: the actor must hold `integrator` or
 * `operator` authority, and the head commit must clear every gate (see
 * {@link verifyFourGateMergeReadiness}). Authority is checked first, so a
 * `builder` (or any other unauthorized role) attempting merge execution is
 * refused before this function discloses anything about gate state.
 * @param {string} queueId
 * @param {{actorAuthorityClass: string, headSha: string, gateReceipts: object, now?: () => number}} opts
 * @returns {{ok: true, queueId: string, headSha: string, authorizedBy: string, gates: object, authorizedAt: number}}
 * @throws {MergeQueueError} `QUEUE_ID_REQUIRED`, `BUILDER_DIRECT_MERGE_FORBIDDEN`, plus any
 *   {@link verifyFourGateMergeReadiness} refusal.
 */
function authorizeControlPlaneMerge(queueId, { actorAuthorityClass, headSha, gateReceipts, now = () => Date.now() } = {}) {
  need(typeof queueId === 'string' && queueId.length > 0, 'QUEUE_ID_REQUIRED', 'queueId is required');
  need(AUTHORIZED_MERGE_ACTOR_CLASSES.includes(actorAuthorityClass), 'BUILDER_DIRECT_MERGE_FORBIDDEN',
    `actorAuthorityClass must be one of ${AUTHORIZED_MERGE_ACTOR_CLASSES.join(', ')} to execute a control-plane merge, got ${actorAuthorityClass === undefined ? 'undefined' : JSON.stringify(actorAuthorityClass)}`,
    403, { actorAuthorityClass: actorAuthorityClass === undefined ? null : actorAuthorityClass });

  const readiness = verifyFourGateMergeReadiness({ headSha }, gateReceipts);

  return {
    ok: true,
    queueId,
    headSha: readiness.headSha,
    authorizedBy: actorAuthorityClass,
    gates: readiness.gates,
    authorizedAt: now()
  };
}

/**
 * Instance wrapper around {@link verifyFourGateMergeReadiness} and
 * {@link authorizeControlPlaneMerge} for a caller that wants an object to
 * hold a shared `now` clock across calls (e.g. a test harness). Both
 * methods behave identically to the module-level functions; neither holds
 * queue state of its own.
 */
class MergeQueue {
  /** @param {{now?: () => number}} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
  }

  /**
   * @param {{headSha: string}} item
   * @param {object} gateReceipts
   * @returns {{ok: true, headSha: string, gates: object}}
   */
  verifyFourGateMergeReadiness(item, gateReceipts) {
    return verifyFourGateMergeReadiness(item, gateReceipts);
  }

  /**
   * @param {string} queueId
   * @param {{actorAuthorityClass: string, headSha: string, gateReceipts: object}} opts
   * @returns {{ok: true, queueId: string, headSha: string, authorizedBy: string, gates: object, authorizedAt: number}}
   */
  authorizeControlPlaneMerge(queueId, opts) {
    return authorizeControlPlaneMerge(queueId, { ...opts, now: this.now });
  }
}

module.exports = {
  MergeQueue,
  MergeQueueError,
  GATE_SPEC,
  AUTHORIZED_MERGE_ACTOR_CLASSES,
  SHA_SHAPE,
  verifyFourGateMergeReadiness,
  authorizeControlPlaneMerge
};
