'use strict';
/* ── TangleClaw — Secure clipboard / secret uploader modal (#1032) ── */
/*                                                                        */
/* Lets the operator carry a secret from THIS device's clipboard into the */
/* project's own session — either pasted straight into the live terminal  */
/* pane (never auto-submitted: `enter: false` always, server side) or     */
/* saved as a private file under the session's `.tangleclaw/secrets/`.    */
/* Never echoes the secret back; the only things that travel back from    */
/* the server are byte counts and credential-shape names (#1032's own     */
/* "no exposure in logs" requirement extends to this page too).           */
/*                                                                        */
/* This file deliberately does NOT create the modal's DOM — the same      */
/* convention `engine-failover-modal.js` documents for its own modal: the */
/* markup is session.html's, unprefixed, and `mount()` only binds         */
/* listeners to elements it assumes already exist.                        */

(function (global) {
  /**
   * Build the secure clipboard modal controller.
   * @param {object} deps
   * @param {Document} deps.doc - The document to query (tests pass a mini DOM).
   * @param {(url: string) => Promise<object|null>} deps.api - GET helper (null on failure).
   * @param {(url: string, method: string, body: object) => Promise<object|null>} deps.apiMutate - Mutating helper.
   * @param {string} deps.projectName - This session's project name.
   * @returns {{mount: () => void, open: () => void, isOpen: () => boolean}}
   */
  function create(deps) {
    const { doc, api, apiMutate, projectName } = deps;
    let isOpen = false;
    let busy = false;

    function els() {
      return {
        backdrop: doc.getElementById('secureClipboardModal'),
        text: doc.getElementById('secureClipboardText'),
        filename: doc.getElementById('secureClipboardFilename'),
        filenameGroup: doc.getElementById('secureClipboardFilenameGroup'),
        status: doc.getElementById('secureClipboardStatus'),
        files: doc.getElementById('secureClipboardFiles'),
        pasteBtn: doc.getElementById('secureClipboardPasteBtn'),
        saveBtn: doc.getElementById('secureClipboardSaveBtn'),
        cancelBtn: doc.getElementById('secureClipboardCancelBtn')
      };
    }

    /**
     * Render the pending-files list from a `GET .../secure-clipboard` payload.
     * @param {Array<{filename: string, bytes: number}>} list
     * @returns {void}
     */
    function renderFiles(list) {
      const { files } = els();
      if (!files) return;
      if (!list.length) {
        files.textContent = 'No pending secret files in this session\'s workspace.';
        return;
      }
      files.innerHTML = '';
      for (const f of list) {
        const row = doc.createElement('div');
        // No CSS of its own (this file's envelope carries no stylesheet):
        // a plain flex row via inline style rather than an unstyled class.
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0';
        const label = doc.createElement('span');
        label.textContent = `${f.filename} (${f.bytes} bytes)`;
        const del = doc.createElement('button');
        del.className = 'btn btn-small';
        del.textContent = 'Delete';
        del.addEventListener('click', () => deleteFile(f.filename));
        row.appendChild(label);
        row.appendChild(del);
        files.appendChild(row);
      }
    }

    /**
     * Refresh the pending-files list from the server.
     * @returns {Promise<void>}
     */
    async function refreshFiles() {
      const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/secure-clipboard`);
      renderFiles(data && Array.isArray(data.files) ? data.files : []);
    }

    /**
     * Delete one pending secret file and refresh the list.
     * @param {string} filename
     * @returns {Promise<void>}
     */
    async function deleteFile(filename) {
      const result = await apiMutate(
        `/api/sessions/${encodeURIComponent(projectName)}/secure-clipboard/${encodeURIComponent(filename)}`,
        'DELETE', {}
      );
      if (!result) {
        const { status } = els();
        if (status) status.textContent = api.lastError || `Could not delete "${filename}".`;
        return;
      }
      await refreshFiles();
    }

    /**
     * Send the text in the textarea, either pasted into the pane or saved
     * as a workspace file.
     * @param {string} mode - 'paste' or 'file'.
     * @returns {Promise<void>}
     */
    async function send(mode) {
      if (busy) return;
      const { text, filename, status } = els();
      const value = text ? text.value : '';
      if (!value) {
        if (status) status.textContent = 'Paste or type a secret first.';
        return;
      }
      if (mode === 'file' && (!filename || !filename.value)) {
        if (status) status.textContent = 'File mode needs a filename.';
        return;
      }
      busy = true;
      if (status) status.textContent = 'Sending…';
      const body = { text: value, mode };
      if (mode === 'file') body.filename = filename.value;
      const result = await apiMutate(`/api/sessions/${encodeURIComponent(projectName)}/secure-clipboard`, 'POST', body);
      busy = false;
      if (!result) {
        if (status) status.textContent = api.lastError || `Could not send (${mode}).`;
        return;
      }
      if (text) text.value = '';
      if (status) {
        status.textContent = result.secretTypesDetected && result.secretTypesDetected.length
          ? `Sent (${result.bytes} bytes) — flagged as: ${result.secretTypesDetected.join(', ')}`
          : `Sent (${result.bytes} bytes).`;
      }
      if (mode === 'file') await refreshFiles();
    }

    /** Open the modal and refresh its pending-files list. @returns {void} */
    function open() {
      const { backdrop, text, filename, status } = els();
      if (!backdrop) return;
      isOpen = true;
      if (text) text.value = '';
      if (filename) filename.value = '';
      if (status) status.textContent = '';
      backdrop.classList.add('open');
      refreshFiles();
    }

    /** Close the modal. @returns {void} */
    function close() {
      isOpen = false;
      const { backdrop } = els();
      if (backdrop) backdrop.classList.remove('open');
    }

    /** Bind the modal's buttons. @returns {void} */
    function mount() {
      const { pasteBtn, saveBtn, cancelBtn, backdrop } = els();
      if (pasteBtn) pasteBtn.addEventListener('click', () => send('paste'));
      if (saveBtn) saveBtn.addEventListener('click', () => send('file'));
      if (cancelBtn) cancelBtn.addEventListener('click', close);
      if (backdrop) {
        backdrop.addEventListener('click', (e) => {
          if (e.target === backdrop) close();
        });
      }
    }

    return { mount, open, isOpen: () => isOpen };
  }

  global.tcCreateSecureClipboardModal = create;
})(window);
