'use strict';
/* ── TangleClaw v3 — Composer Attachment Pills UI Controller (#2862, A503-R1) ── */
/* Slice 2 of #1577: wraps lib/upload-pills.js's pure queue state machine and  */
/* public/upload-pills.js's pure view-model helpers into a stateful           */
/* controller a composer can own -- drag-and-drop / file-picker file lists    */
/* in, a tray view model and the ready-pills' serialized prompt tokens out.   */
/* Mounting this inside the real composer (public/app.js) is Milestone #54    */
/* per Ruling A503-R1 point 3; this file is the complete, testable            */
/* controller that mount will instantiate unchanged.                         */

(function (global) {
  /**
   * Translate a DOM `FileList`/`DataTransfer.files` (or any array-like of
   * `File` objects) into the plain `{filename, sizeBytes, mimeType}` shape
   * `enqueueUploads` expects. Pure: reads only the three `File` properties
   * every browser exposes, never touches the network or reads file bytes.
   * @param {{length: number}} fileList - A `FileList`, or any array-like of `{name, size, type}`.
   * @returns {Array<{filename: string, sizeBytes: number, mimeType: (string|null)}>}
   */
  function filesFromFileList(fileList) {
    const out = [];
    const list = fileList || [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f) continue;
      out.push({ filename: f.name, sizeBytes: f.size, mimeType: f.type || null });
    }
    return out;
  }

  /**
   * Create a composer attachment-pills controller. Holds the current pill
   * queue and owns every mutation to it, so a composer never reaches past
   * this controller into `lib/upload-pills.js` directly.
   * @param {object} options
   * @param {Function} options.enqueueUploads - `lib/upload-pills.js#enqueueUploads`.
   * @param {Function} options.transitionPill - `lib/upload-pills.js#transitionPill`.
   * @param {Function} options.removePill - `lib/upload-pills.js#removePill`.
   * @param {Function} options.serializeReadyPills - `lib/upload-pills.js#serializeReadyPills`.
   * @param {Function} [options.buildTrayView] - `public/upload-pills.js`'s own `buildTrayView`; defaults to a minimal `{pills, count}` view when omitted.
   * @param {(view: object) => void} [options.onChange] - Called with {@link getView}'s result after every mutation.
   * @returns {object} The controller.
   */
  function createController(options) {
    const opts = options || {};
    const { enqueueUploads, transitionPill, removePill, serializeReadyPills } = opts;
    const buildTrayView = opts.buildTrayView || ((pills) => ({ pills, count: pills.length }));
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

    if (typeof enqueueUploads !== 'function' || typeof transitionPill !== 'function'
      || typeof removePill !== 'function' || typeof serializeReadyPills !== 'function') {
      throw new Error('createController: enqueueUploads, transitionPill, removePill and serializeReadyPills are all required.');
    }

    let pills = [];

    function getView() {
      return buildTrayView(pills);
    }

    function getPills() {
      return pills.slice();
    }

    function addFiles(files, addOpts) {
      const result = enqueueUploads({ existingPills: pills, files, now: addOpts && addOpts.now });
      if (result.ok === false) return result;
      pills = result.result.pills;
      onChange(getView());
      return result.result;
    }

    function _transition(pillId, toState, extra) {
      const pill = pills.find((p) => p.pillId === pillId);
      if (!pill) return { ok: false, code: 'UPLOAD_PILL_NOT_FOUND', message: `No pill with id "${pillId}".` };
      const result = transitionPill(Object.assign({ pill, toState }, extra || {}));
      if (result.ok === false) return result;
      pills = pills.map((p) => (p.pillId === pillId ? result.pill : p));
      onChange(getView());
      return result;
    }

    function markUploading(pillId) {
      return _transition(pillId, 'uploading');
    }

    function markReady(pillId, remotePath) {
      return _transition(pillId, 'ready', { remotePath });
    }

    function markFailed(pillId) {
      return _transition(pillId, 'failed');
    }

    function retry(pillId) {
      return _transition(pillId, 'queued');
    }

    function remove(pillId) {
      const result = removePill(pills, pillId);
      if (result.ok === false) return result;
      pills = result.pills;
      onChange(getView());
      return result;
    }

    function serialize() {
      return serializeReadyPills(pills);
    }

    /**
     * Wire drag-and-drop and file-picker events on a real DOM element to
     * {@link addFiles}. A no-op guard, not a real DOM dependency of the
     * controller itself: every other method above works with no DOM at
     * all, which is what keeps this controller unit-testable without a
     * browser. Mounting this against the real composer drop zone is
     * Milestone #54's job; this method is what that mount calls.
     * @param {{addEventListener: Function}} dropZone - The drop target element.
     * @param {{fileInput?: {addEventListener: Function}}} [wireOpts] - An optional paired `<input type="file">`.
     * @returns {void}
     */
    function attachDropZone(dropZone, wireOpts) {
      if (!dropZone || typeof dropZone.addEventListener !== 'function') {
        throw new Error('attachDropZone: dropZone must support addEventListener');
      }
      dropZone.addEventListener('dragover', (ev) => {
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
      });
      dropZone.addEventListener('drop', (ev) => {
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        const files = ev.dataTransfer && ev.dataTransfer.files;
        if (files) addFiles(filesFromFileList(files));
      });
      const fileInput = wireOpts && wireOpts.fileInput;
      if (fileInput && typeof fileInput.addEventListener === 'function') {
        fileInput.addEventListener('change', (ev) => {
          const files = ev.target && ev.target.files;
          if (files) addFiles(filesFromFileList(files));
        });
      }
    }

    return {
      getView, getPills, addFiles, markUploading, markReady, markFailed, retry, remove, serialize, attachDropZone
    };
  }

  const controller = { createController, filesFromFileList };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = controller;
  }
  if (global) {
    global.tcUploadPillsUi = controller;
  }
})(typeof window !== 'undefined' ? window : null);
