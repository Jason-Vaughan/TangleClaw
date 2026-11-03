'use strict';
/* ── TangleClaw v3 — Attachment Pills view-model helpers (#1577) ── */
/* Pure shape-to-view-model translation for the multi-file upload tray, */
/* mirroring public/wrap-drawer.js's own split: this file turns          */
/* lib/upload-pills.js's own pill/result shapes into what a renderer    */
/* needs to draw one pill and the whole tray; it never touches the DOM  */
/* itself. session.js/app.js own the event wiring and DOM mutation      */
/* (Slice 2, A1577) -- unit-testable via vm sandbox in the meantime.    */

(function (global) {
  /** Short, human label for each pill state (#1577). */
  const STATE_LABELS = Object.freeze({
    queued: 'Queued',
    uploading: 'Uploading…',
    ready: 'Ready',
    failed: 'Failed'
  });

  /**
   * A byte count as a short, human-readable size -- "512 B", "4.2 KB",
   * "1.3 MB". Deterministic: the same input always formats the same way.
   * @param {number} bytes
   * @returns {string}
   */
  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  }

  /**
   * One pill's own view model: everything a renderer needs to draw it,
   * derived once so the renderer never re-derives "can this be removed"
   * or "can this be retried" from the raw state string itself.
   * @param {{pillId: string, filename: string, sizeBytes: number, state: string}} pill
   * @returns {{id: string, filename: string, displaySize: string, state: string,
   *   stateLabel: string, isReady: boolean, isFailed: boolean, canRemove: boolean, canRetry: boolean}}
   */
  function buildPillView(pill) {
    const state = pill && pill.state;
    return {
      id: pill ? pill.pillId : '',
      filename: pill ? pill.filename : '',
      displaySize: formatFileSize(pill ? pill.sizeBytes : NaN),
      state: state || 'queued',
      stateLabel: Object.prototype.hasOwnProperty.call(STATE_LABELS, state) ? STATE_LABELS[state] : state,
      isReady: state === 'ready',
      isFailed: state === 'failed',
      // Removal is always available except mid-upload, where the request is
      // already in flight and removing the pill would orphan it.
      canRemove: state !== 'uploading',
      canRetry: state === 'failed'
    };
  }

  /**
   * The whole tray's own view model (#1577): every pill's view, plus the
   * fleet-level facts a composer's send button needs ("is anything still
   * in flight", "did anything fail") without re-scanning the list itself.
   * @param {object[]} pills - From `lib/upload-pills.js`'s own pill list
   * @returns {{pills: object[], count: number, hasFailed: boolean, hasInFlight: boolean, allReady: boolean}}
   */
  function buildTrayView(pills) {
    const list = Array.isArray(pills) ? pills.map(buildPillView) : [];
    return {
      pills: list,
      count: list.length,
      hasFailed: list.some((p) => p.isFailed),
      hasInFlight: list.some((p) => p.state === 'queued' || p.state === 'uploading'),
      allReady: list.length > 0 && list.every((p) => p.isReady)
    };
  }

  const helpers = {
    STATE_LABELS,
    formatFileSize,
    buildPillView,
    buildTrayView
  };

  // Browser: attach to window so app.js/session.js can call helpers.
  // Node (tests): expose via module.exports.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
  }
  if (global) {
    global.tcUploadPillsHelpers = helpers;
  }
})(typeof window !== 'undefined' ? window : null);
