'use strict';

/**
 * Multi-file upload queue state and auto-appending Attachment Pills (#1577,
 * Architect Ruling A1577, `v5.60.0` Car 60-D Slice 1).
 *
 * A pure queue/serializer library: every function takes the caller's own
 * current pill list (or files to add) as plain data and returns the next
 * list or a computed result -- nothing here touches the filesystem, starts
 * an upload, or renders a pill. Wiring this into the real upload flow and
 * the composer UI (`public/app.js`) is Slice 2, deliberately deferred so
 * Car 60-D stays 100% file-disjoint from this wave's other `v5.60.0` cars.
 * `public/upload-pills.js` (also in this ruling's envelope) is the Slice 1
 * DOM component that will render this module's pill state -- it has no
 * logic of its own to duplicate here.
 *
 * @module lib/upload-pills
 */

const { MAX_UPLOAD_BYTES } = require('./uploads');

/** Every state an attachment pill passes through (#1577). */
const PILL_STATES = Object.freeze(['queued', 'uploading', 'ready', 'failed']);

/** Valid pill state transitions. `failed -> queued` is a retry. */
const PILL_TRANSITIONS = Object.freeze({ queued: ['uploading', 'failed'], uploading: ['ready', 'failed'], ready: [], failed: ['queued'] });

/**
 * How many files one batch may queue at once -- a scoping decision, since
 * the ruling names "file-count... bounds" without a number. `10`: generous
 * for a handful of screenshots/logs attached to one message, small enough
 * that a batch can't silently balloon the composer payload.
 * @type {number}
 */
const MAX_FILES_PER_BATCH = 10;

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * The identity {@link enqueueUploads} dedupes on -- same name, same size.
 * @param {string} filename
 * @param {number} sizeBytes
 * @returns {string}
 */
function _dedupeKey(filename, sizeBytes) {
  return `${filename}::${sizeBytes}`;
}

/**
 * Add candidate files to an existing pill queue (#1577): identical
 * attachments (same `filename` + `sizeBytes`, against both the existing
 * queue and earlier files in this same call) are deduplicated rather than
 * queued twice; a file over {@link module:lib/uploads.MAX_UPLOAD_BYTES} or
 * a batch that would exceed {@link MAX_FILES_PER_BATCH} total pills is
 * rejected per-file rather than refusing the whole call -- one bad file in
 * a batch of ten should not block the other nine.
 * @param {object} input
 * @param {object[]} input.existingPills - The caller's current queue
 * @param {object[]} input.files - Candidates: `{filename, sizeBytes, mimeType?}`
 * @param {string} [input.now] - ISO timestamp, for pill id generation
 * @returns {{ok: true, result: {pills: object[], added: object[],
 *   duplicates: object[], rejected: object[]}}|{ok: false, code: string, message: string}}
 */
function enqueueUploads(input) {
  if (!input || typeof input !== 'object') return _refuse('UPLOAD_PILLS_INVALID', 'input must be an object.');
  if (!Array.isArray(input.existingPills)) return _refuse('UPLOAD_PILLS_INVALID', 'input.existingPills must be an array.');
  if (!Array.isArray(input.files) || input.files.length === 0) {
    return _refuse('UPLOAD_PILLS_INVALID', 'input.files must be a non-empty array.');
  }
  for (let i = 0; i < input.files.length; i++) {
    const f = input.files[i];
    if (!f || typeof f !== 'object' || typeof f.filename !== 'string' || !f.filename) {
      return _refuse('UPLOAD_PILLS_INVALID', `files[${i}] has no "filename".`);
    }
    if (!Number.isFinite(f.sizeBytes) || f.sizeBytes <= 0) {
      return _refuse('UPLOAD_PILLS_INVALID', `files[${i}].sizeBytes must be a positive number.`);
    }
  }

  const now = typeof input.now === 'string' && input.now ? input.now : new Date().toISOString();
  const seen = new Set(input.existingPills.map((p) => _dedupeKey(p.filename, p.sizeBytes)));
  let slotsUsed = input.existingPills.length;

  const added = [];
  const duplicates = [];
  const rejected = [];
  for (const file of input.files) {
    const key = _dedupeKey(file.filename, file.sizeBytes);
    if (seen.has(key)) {
      duplicates.push({ filename: file.filename, sizeBytes: file.sizeBytes });
      continue;
    }
    if (file.sizeBytes > MAX_UPLOAD_BYTES) {
      rejected.push({ filename: file.filename, sizeBytes: file.sizeBytes, reason: `exceeds the ${MAX_UPLOAD_BYTES}-byte size bound` });
      continue;
    }
    if (slotsUsed >= MAX_FILES_PER_BATCH) {
      rejected.push({ filename: file.filename, sizeBytes: file.sizeBytes, reason: `exceeds the ${MAX_FILES_PER_BATCH}-file batch bound` });
      continue;
    }
    seen.add(key);
    slotsUsed += 1;
    added.push({
      pillId: `pill_${key.replace(/[^a-zA-Z0-9]/g, '_')}_${now}_${added.length}`,
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      mimeType: typeof file.mimeType === 'string' ? file.mimeType : null,
      state: 'queued',
      remotePath: null
    });
  }

  return { ok: true, result: { pills: [...input.existingPills, ...added], added, duplicates, rejected } };
}

/**
 * Transition one pill's upload state (#1577's "individual pill... retry"):
 * `failed -> queued` is how a retry is expressed. Reaching `ready` requires
 * a `remotePath`; leaving it (via retry) clears the stale one.
 * @param {object} input
 * @param {object} input.pill - `{pillId, filename, sizeBytes, mimeType, state, remotePath}`
 * @param {string} input.toState - Must be a transition {@link PILL_TRANSITIONS} allows
 * @param {string} [input.remotePath] - Required when `toState` is `'ready'`
 * @returns {{ok: true, pill: object}|{ok: false, code: string, message: string}}
 */
function transitionPill(input) {
  if (!input || !input.pill || typeof input.pill !== 'object' || typeof input.pill.pillId !== 'string' || !input.pill.pillId) {
    return _refuse('UPLOAD_PILLS_INVALID', 'input.pill must carry a "pillId".');
  }
  if (!PILL_STATES.includes(input.toState)) {
    return _refuse('UPLOAD_PILLS_INVALID', `"${input.toState}" is not a recognized pill state.`);
  }
  const allowed = PILL_TRANSITIONS[input.pill.state] || [];
  if (!allowed.includes(input.toState)) {
    return _refuse('UPLOAD_PILL_CONFLICT', `Cannot transition a pill from "${input.pill.state}" to "${input.toState}".`);
  }
  if (input.toState === 'ready' && (typeof input.remotePath !== 'string' || !input.remotePath)) {
    return _refuse('UPLOAD_PILLS_INVALID', 'input.remotePath is required when transitioning to "ready".');
  }
  return {
    ok: true,
    pill: {
      ...input.pill,
      state: input.toState,
      remotePath: input.toState === 'ready' ? input.remotePath : (input.toState === 'queued' ? null : input.pill.remotePath)
    }
  };
}

/**
 * Remove one pill from the queue by id (#1577's "individual pill removal").
 * @param {object[]} pills
 * @param {string} pillId
 * @returns {{ok: true, pills: object[]}|{ok: false, code: string, message: string}}
 */
function removePill(pills, pillId) {
  if (!Array.isArray(pills)) return _refuse('UPLOAD_PILLS_INVALID', 'pills must be an array.');
  if (typeof pillId !== 'string' || !pillId) return _refuse('UPLOAD_PILLS_INVALID', 'pillId is required.');
  const index = pills.findIndex((p) => p.pillId === pillId);
  if (index === -1) return _refuse('UPLOAD_PILL_NOT_FOUND', `No pill with id "${pillId}".`);
  return { ok: true, pills: pills.filter((_, i) => i !== index) };
}

/**
 * Deterministically serialize every `ready` pill into composer prompt
 * tokens/references for auto-appending to the outgoing message (#1577's
 * "automatically append the absolute paths of all attached files"). Order
 * is preserved from `pills`; nothing here reorders or dedupes further --
 * {@link enqueueUploads} already owns deduplication.
 * @param {object[]} pills
 * @returns {{ok: true, result: {references: object[], promptText: string}}|{ok: false, code: string, message: string}}
 */
function serializeReadyPills(pills) {
  if (!Array.isArray(pills)) return _refuse('UPLOAD_PILLS_INVALID', 'pills must be an array.');
  const references = pills
    .filter((p) => p.state === 'ready')
    .map((p) => ({ pillId: p.pillId, filename: p.filename, remotePath: p.remotePath, token: `[attachment:${p.remotePath}]` }));
  return { ok: true, result: { references, promptText: references.map((r) => r.token).join(' ') } };
}

module.exports = {
  PILL_STATES,
  PILL_TRANSITIONS,
  MAX_FILES_PER_BATCH,
  enqueueUploads,
  transitionPill,
  removePill,
  serializeReadyPills
};
