'use strict';

/*
 * Frontend structural tests for #338 — the Upload modal now (1) accepts any
 * file type (the restrictive `accept` allowlist is gone) and (2) makes each
 * RECENT UPLOADS history item click-to-copy its local path, mirroring the
 * post-upload "Tell your AI assistant: <path>" affordance.
 *
 * public/session.js / session.html render DOM via innerHTML strings with many
 * top-level deps, so source-level structural assertions are the pragmatic
 * contract lock-in — same pattern as test/settings-modal-silentprime.test.js
 * and test/openclaw-version-row.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Upload modal — any file type + copyable history links (#338)', () => {
  let js;
  let html;

  before(() => {
    js = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
    html = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.html'), 'utf8');
  });

  describe('any file type', () => {
    it('the upload file input no longer pins a restrictive accept allowlist', () => {
      // Lock in the removal: the old allowlist (.png,.jpg,…,.yml) must not return.
      assert.ok(/id="uploadFile"/.test(html), 'the upload file input still exists');
      assert.ok(!/accept="\.png[^"]*"/.test(html), 'the image/doc accept allowlist must be gone');
      assert.ok(!/accept="[^"]*\.yml/.test(html), 'no extension-allowlist accept attribute');
    });
  });

  describe('history items are click-to-copy', () => {
    it('renders each history item as an accessible button carrying its path', () => {
      assert.match(js, /class="upload-history-item"[^`]*role="button"/);
      assert.match(js, /tabindex="0"/);
      assert.match(js, /data-path="\$\{esc\(u\.path\)\}"/);
    });

    it('wires click + keyboard (Enter/Space) to copy the item path', () => {
      assert.match(js, /historyEl\.onclick\s*=/);
      assert.match(js, /historyEl\.onkeydown\s*=/);
      assert.match(js, /e\.key\s*===\s*'Enter'\s*\|\|\s*e\.key\s*===\s*' '/);
      // closest() resolves the item from the actual click target.
      assert.match(js, /closest\(['"]\.upload-history-item['"]\)/);
    });

    it('clears the handlers when there is no history (no stale listeners)', () => {
      assert.match(js, /historyEl\.onclick\s*=\s*null/);
      assert.match(js, /historyEl\.onkeydown\s*=\s*null/);
    });

    it('copyUploadPath writes the path to the clipboard with toast feedback', () => {
      assert.match(js, /async function copyUploadPath\(/);
      // #430 routed every copy site through the shared secure-context-aware
      // `tcCopyToClipboard` helper (HTTPS Clipboard API + plain-HTTP fallback)
      // instead of calling `navigator.clipboard.writeText` directly.
      assert.match(js, /tcCopyToClipboard\(pathStr\)/);
      assert.match(js, /Upload path copied to clipboard/);
    });
  });
});
