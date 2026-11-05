'use strict';

/**
 * Chunk-boundary HTTP controller handlers (#2836, #1889 Slice 2).
 *
 * `lib/chunk-boundary.js` (Slice 1) names its own Slice 2 scope exactly:
 * "Wiring `validateNextChunkDispatch` into the HTTP session/dispatch
 * routes and the dashboard session-status surface is Slice 2, tracked in
 * #2836." This module is that wiring's controller layer -- one handler per
 * route a future route table would mount, each shaped to take exactly what
 * that route already has (`params`, a parsed `body`) and return exactly
 * what it would write as a JSON response. Mounting them onto real routes
 * (`server.js`, `lib/routes/sessions.js`) is Slice 3, tracked in #2888 and
 * out of this envelope -- these handlers are self-contained and callable
 * today, by a test or an in-process tool, without a route existing yet.
 *
 * Every handler returns `lib/chunk-boundary.js`'s own `{ok, ...}` shape
 * verbatim, with a `statusSurface` key added from `lib/chunk-boundary-ui.js`
 * so a route layer can serve one response that is both the raw record (for
 * a client that wants it) and the display-ready view model (for the
 * dashboard status surface #2836 also names) -- never two separate calls.
 *
 * @module lib/chunk-boundary-http
 */

const chunkBoundary = require('./chunk-boundary');
const chunkBoundaryUi = require('./chunk-boundary-ui');

/**
 * Add this module's own `statusSurface` key to a result that carries a
 * `receipt` (present on both `{ok:true}` and most `{ok:false}` shapes this
 * file's underlying functions return).
 * @param {object} result
 * @returns {object}
 */
function _withStatusSurface(result) {
  return { ...result, statusSurface: chunkBoundaryUi.receiptStatusSurface(result.receipt || null) };
}

/**
 * `POST /.../chunk-boundary` controller: create a receipt.
 * @param {object} body - Parsed request body, forwarded to `createChunkBoundaryReceipt` verbatim
 * @returns {object}
 */
function handleCreateReceipt(body) {
  return _withStatusSurface(chunkBoundary.createChunkBoundaryReceipt(body));
}

/**
 * `GET /.../chunk-boundary/:receiptId` controller: read one receipt.
 * @param {string} receiptId
 * @returns {object}
 */
function handleGetReceipt(receiptId) {
  const receipt = chunkBoundary.getChunkBoundaryReceipt(receiptId);
  if (!receipt) {
    return { ok: false, code: 'CHUNK_BOUNDARY_RECEIPT_NOT_FOUND', message: `No chunk-boundary receipt "${receiptId}".`, statusSurface: chunkBoundaryUi.receiptStatusSurface(null) };
  }
  return { ok: true, receipt, statusSurface: chunkBoundaryUi.receiptStatusSurface(receipt) };
}

/**
 * `GET /.../chunk-boundary?projectId=&assignmentId=&chunkNumber=` controller:
 * read the receipt on record for one (project, assignment, chunk) triple.
 * @param {number} projectId
 * @param {string} assignmentId
 * @param {number} chunkNumber
 * @returns {object}
 */
function handleGetReceiptForChunk(projectId, assignmentId, chunkNumber) {
  const receipt = chunkBoundary.getReceiptForChunk(projectId, assignmentId, chunkNumber);
  return { ok: true, receipt, statusSurface: chunkBoundaryUi.receiptStatusSurface(receipt) };
}

/**
 * `POST /.../chunk-boundary/:receiptId/ready-to-clear` controller.
 * @param {string} receiptId
 * @returns {object}
 */
function handleMarkReadyToClear(receiptId) {
  return _withStatusSurface(chunkBoundary.markReadyToClear(receiptId));
}

/**
 * `POST /.../chunk-boundary/:receiptId/clear-intent` controller.
 * @param {string} receiptId
 * @param {object} body - Parsed request body, forwarded to `recordClearIntent` verbatim
 * @returns {object}
 */
function handleRecordClearIntent(receiptId, body) {
  return _withStatusSurface(chunkBoundary.recordClearIntent(receiptId, body));
}

/**
 * `POST /.../chunk-boundary/:receiptId/clear-outcome` controller.
 * @param {string} receiptId
 * @param {object} body - Parsed request body, forwarded to `recordClearOutcome` verbatim
 * @returns {object}
 */
function handleRecordClearOutcome(receiptId, body) {
  return _withStatusSurface(chunkBoundary.recordClearOutcome(receiptId, body));
}

/**
 * `POST /.../chunk-boundary/:receiptId/ready-after-clear` controller.
 * @param {string} receiptId
 * @param {object} [body] - Parsed request body, forwarded to `acknowledgeReadyAfterClear` verbatim
 * @returns {object}
 */
function handleAcknowledgeReadyAfterClear(receiptId, body) {
  return _withStatusSurface(chunkBoundary.acknowledgeReadyAfterClear(receiptId, body || {}));
}

/**
 * `POST /.../chunk-boundary/:receiptId/supersede` controller.
 * @param {string} receiptId
 * @param {object} body - Parsed request body, forwarded to `supersedeChunkBoundaryReceipt` verbatim
 * @returns {object}
 */
function handleSupersede(receiptId, body) {
  return _withStatusSurface(chunkBoundary.supersedeChunkBoundaryReceipt(receiptId, body));
}

/**
 * `POST /.../chunk-boundary/validate-next-dispatch` controller: the
 * admission gate itself, for a dispatch route to call BEFORE dispatching
 * Chunk N+1. Carries an `admission` status surface (`admitted`/`hold`/...)
 * alongside the raw verdict, for the same one-response reason
 * {@link _withStatusSurface} gives the other handlers.
 * @param {object} candidate - Forwarded to `validateNextChunkDispatch` verbatim
 * @param {object} [opts] - Forwarded to `validateNextChunkDispatch` verbatim
 * @returns {object}
 */
function handleValidateNextChunkDispatch(candidate, opts) {
  const verdict = chunkBoundary.validateNextChunkDispatch(candidate, opts);
  return { ...verdict, admission: chunkBoundaryUi.admissionStatusSurface(verdict) };
}

module.exports = {
  handleCreateReceipt,
  handleGetReceipt,
  handleGetReceiptForChunk,
  handleMarkReadyToClear,
  handleRecordClearIntent,
  handleRecordClearOutcome,
  handleAcknowledgeReadyAfterClear,
  handleSupersede,
  handleValidateNextChunkDispatch
};
