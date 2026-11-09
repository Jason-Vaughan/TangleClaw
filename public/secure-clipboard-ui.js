'use strict';
/* ── TangleClaw — Secure clipboard / secret uploader modal (#1032) ── */
/*                                                                        */
/* Lets the operator carry a secret, or a file, from THIS device into the */
/* project's own session — either saved as a private file under the      */
/* session's `.tangleclaw/secrets/`, or saved there AND pointed at from   */
/* the live terminal pane with a content-free notice (never the secret    */
/* itself: PRR-B R-Gate finding 2, round 1 — see lib/routes/secure-       */
/* clipboard.js's own docblock for why the earlier "paste the raw text,   */
/* no Enter" design was unsafe). Never echoes the secret back; the only   */
/* things that travel back from the server are byte counts and           */
/* credential-shape names (#1032's own "no exposure in logs" requirement  */
/* extends to this page too).                                            */
/*                                                                        */
/* Calls `api()` directly with `tcOperatorProofHeaders(api)` rather than  */
/* the page's `apiMutate()` (PRR-B R-Gate finding 1, round 1):            */
/* `apiMutate()` only attaches the open-install anti-forgery token for    */
/* one hardcoded `/api/config` case, so every other `apiMutate()` write   */
/* is refused on a no-login install — the same pattern `public/ui.js`     */
/* (lines ~3909, ~4306) already uses for its own `_requireOperatorWrite`  */
/* routes.                                                                */
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
   * @param {string} deps.projectName - This session's project name.
   * @returns {{mount: () => void, open: () => void, isOpen: () => boolean}}
   */
  function create(deps) {
    const { doc, api, projectName } = deps;
    let isOpen = false;
    let busy = false;
    // Set by the file-picker's change handler; cleared whenever the
    // textarea is edited by hand, so the two inputs stay mutually
    // exclusive rather than racing over which one `send()` reads.
    let pickedFile = null; // { base64: string, name: string } | null

    function els() {
      return {
        backdrop: doc.getElementById('secureClipboardModal'),
        text: doc.getElementById('secureClipboardText'),
        filename: doc.getElementById('secureClipboardFilename'),
        fileInput: doc.getElementById('secureClipboardFile'),
        status: doc.getElementById('secureClipboardStatus'),
        files: doc.getElementById('secureClipboardFiles'),
        pasteBtn: doc.getElementById('secureClipboardPasteBtn'),
        saveBtn: doc.getElementById('secureClipboardSaveBtn'),
        cancelBtn: doc.getElementById('secureClipboardCancelBtn')
      };
    }

    /**
     * Headers for every call this modal makes, including its `GET` list
     * read — the backend gates that read with the same operator proof as
     * its writes (see `lib/routes/secure-clipboard.js`'s own docblock for
     * why), so unlike an ordinary `GET` it needs a CSRF token on an armed
     * install too. `tcOperatorProofHeaders` (`public/api-helper.js`, global)
     * covers the open-install token; `tcCsrfToken` (same file, global) is
     * read directly here because `api()`'s own auto-CSRF (`tcWithCsrf`)
     * only fires for POST/PUT/PATCH/DELETE, never for this route's `GET`.
     * Setting it on every call, including the ones `tcFetch` would also add
     * it to, is harmless — same cookie, same value.
     * @returns {Promise<object>}
     */
    async function operatorHeaders() {
      const headers = await global.tcOperatorProofHeaders(api);
      const csrf = global.tcCsrfToken && global.tcCsrfToken();
      if (csrf) headers['X-CSRF-Token'] = csrf;
      return headers;
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
      const data = await api(`/api/sessions/${encodeURIComponent(projectName)}/secure-clipboard`, {
        method: 'GET', headers: await operatorHeaders()
      });
      renderFiles(data && Array.isArray(data.files) ? data.files : []);
    }

    /**
     * Delete one pending secret file and refresh the list.
     * @param {string} filename
     * @returns {Promise<void>}
     */
    async function deleteFile(filename) {
      const result = await api(
        `/api/sessions/${encodeURIComponent(projectName)}/secure-clipboard/${encodeURIComponent(filename)}`,
        { method: 'DELETE', headers: await operatorHeaders() }
      );
      if (!result) {
        const { status } = els();
        if (status) status.textContent = api.lastError || `Could not delete "${filename}".`;
        return;
      }
      await refreshFiles();
    }

    /**
     * Read a chosen file as base64, for `encoding: 'base64'` on the wire.
     * @param {File} file
     * @returns {Promise<string>}
     */
    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error || new Error('could not read the chosen file'));
        reader.readAsDataURL(file);
      });
    }

    /**
     * Send either the picked file or the textarea's text, saved as a
     * workspace file and/or pointed at from the pane.
     * @param {string} mode - 'paste' or 'file'.
     * @returns {Promise<void>}
     */
    async function send(mode) {
      if (busy) return;
      const { text, filename, status } = els();
      const usingFile = pickedFile !== null;
      const value = usingFile ? pickedFile.base64 : (text ? text.value : '');
      if (!value) {
        if (status) status.textContent = 'Paste/type a secret or choose a file first.';
        return;
      }
      if (!filename || !filename.value) {
        if (status) status.textContent = 'A filename is required.';
        return;
      }
      busy = true;
      if (status) status.textContent = 'Sending…';
      const body = { text: value, mode, filename: filename.value, encoding: usingFile ? 'base64' : 'utf8' };
      const result = await api(`/api/sessions/${encodeURIComponent(projectName)}/secure-clipboard`, {
        method: 'POST', headers: await operatorHeaders(), body: JSON.stringify(body)
      });
      busy = false;
      if (!result) {
        if (status) status.textContent = api.lastError || `Could not send (${mode}).`;
        return;
      }
      if (text) text.value = '';
      pickedFile = null;
      const { fileInput } = els();
      if (fileInput) fileInput.value = '';
      if (status) {
        status.textContent = result.secretTypesDetected && result.secretTypesDetected.length
          ? `Sent (${result.bytes} bytes) — flagged as: ${result.secretTypesDetected.join(', ')}`
          : `Sent (${result.bytes} bytes).`;
      }
      await refreshFiles();
    }

    /** Open the modal and refresh its pending-files list. @returns {void} */
    function open() {
      const { backdrop, text, filename, fileInput, status } = els();
      if (!backdrop) return;
      isOpen = true;
      pickedFile = null;
      if (text) text.value = '';
      if (filename) filename.value = '';
      if (fileInput) fileInput.value = '';
      if (status) status.textContent = '';
      backdrop.classList.add('open');
      refreshFiles();
    }

    /** Close the modal. @returns {void} */
    function close() {
      isOpen = false;
      // PRR-B round 2 warning: closing without sending must not leave a
      // typed secret or a picked file's base64 content sitting in the DOM
      // or in this module's memory until the next open() — clear both here
      // too, not only at open().
      pickedFile = null;
      const { backdrop, text, filename, fileInput } = els();
      if (text) text.value = '';
      if (filename) filename.value = '';
      if (fileInput) fileInput.value = '';
      if (backdrop) backdrop.classList.remove('open');
    }

    /** Bind the modal's buttons and file picker. @returns {void} */
    function mount() {
      const { pasteBtn, saveBtn, cancelBtn, backdrop, text, fileInput, filename } = els();
      if (pasteBtn) pasteBtn.addEventListener('click', () => send('paste'));
      if (saveBtn) saveBtn.addEventListener('click', () => send('file'));
      if (cancelBtn) cancelBtn.addEventListener('click', close);
      if (backdrop) {
        backdrop.addEventListener('click', (e) => {
          if (e.target === backdrop) close();
        });
      }
      if (text) {
        text.addEventListener('input', () => {
          pickedFile = null;
          if (fileInput) fileInput.value = '';
        });
      }
      if (fileInput) {
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files && fileInput.files[0];
          const { status } = els();
          if (!file) { pickedFile = null; return; }
          try {
            const base64 = await readFileAsBase64(file);
            pickedFile = { base64, name: file.name };
            if (text) text.value = '';
            if (filename && !filename.value) filename.value = file.name;
            if (status) status.textContent = `Chosen: ${file.name} (${file.size} bytes).`;
          } catch (err) {
            pickedFile = null;
            if (status) status.textContent = err.message || 'Could not read the chosen file.';
          }
        });
      }
    }

    return { mount, open, isOpen: () => isOpen };
  }

  global.tcCreateSecureClipboardModal = create;
})(window);
