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
const os = require('node:os');
const uploadsFs = require('../lib/uploads-fs');

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

  describe('the secret badge reads what the API sends and wears a class that exists (#343, #889)', () => {
    it('branches on the flag field the uploads listing actually produces', () => {
      // BUILD THE CONSUMER'S EXPECTATION FROM THE PRODUCER, never from a literal
      // typed on this side: the badge read `u.secretMatches` and `m.rule`, which
      // `listUploads` has never emitted, so it could not render for any upload
      // and the flag-only scan was invisible on the one surface that shows it.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-upload-badge-'));
      try {
        const saved = uploadsFs.saveUpload(tmp, 'creds.env',
          Buffer.from('api_key=AKIAIOSFODNN7EXAMPLE\n').toString('base64'), 2);
        assert.equal(saved.secretsFlagged, true, 'fixture precondition: a flagged upload');
        const entry = uploadsFs.listUploads(tmp).uploads.find((u) => u.name === saved.name);

        for (const field of ['secretsFlagged', 'secretTypes']) {
          assert.ok(Object.hasOwn(entry, field), `producer emits ${field}`);
          assert.ok(js.includes(`u.${field}`),
            `the badge must read u.${field} — the field the listing emits`);
        }
        // The property is that the badge does not READ a field the payload
        // lacks — not that the string is absent from the file, which a comment
        // could redden for no behavioural reason.
        assert.ok(!/\bu\.secretMatches\b/.test(js),
          'the badge must not read a field the uploads payload does not carry');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('names a badge class that a stylesheet session.html actually loads', () => {
      // The defect this pins is not a typo, it is a SCOPE error: `.badge-secret`
      // was defined only in style.css, which session.html does not load, so the
      // badge would have rendered unstyled even once its field name was fixed.
      // Both halves are derived — the class from the renderer, the sheets from
      // the page — so renaming either side keeps the assertion meaningful.
      const emitted = [...js.matchAll(/class="([a-z-]*badge[a-z-]*)"/g)].map((m) => m[1]);
      assert.ok(emitted.length > 0, 'the upload history renders at least one badge class');

      const sheets = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map((m) => m[1]);
      assert.ok(sheets.length > 0, 'session.html loads at least one stylesheet');
      const css = sheets
        .map((f) => path.join(__dirname, '..', 'public', f))
        .filter((f) => fs.existsSync(f))
        .map((f) => fs.readFileSync(f, 'utf8'))
        .join('\n');

      for (const cls of emitted) {
        assert.ok(new RegExp(`\\.${cls}\\s*[,{]`).test(css),
          `.${cls} is emitted by session.js but defined in no stylesheet session.html loads`);
      }
    });
  });

  describe('an uploads directory that could not be read says so (#889)', () => {
    it('renders a notice from the payload\'s unreadable fields instead of an empty history', () => {
      // `GET /api/uploads` carries `unreadable` / `unreadableHint` for a refused
      // read. Rendering nothing for that case is what told the operator their
      // files were gone.
      assert.match(js, /data\.unreadable/);
      assert.match(js, /data\.unreadableHint/);
      // The notice must survive the empty branch — that is the branch a refused
      // directory lands in, and the one that used to blank the panel.
      assert.match(js, /historyEl\.innerHTML\s*=\s*unreadableHtml\b/);
    });
  });
});
