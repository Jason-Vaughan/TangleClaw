'use strict';

/**
 * The history drawer's half of the honest uploads empty-state (#889).
 *
 * `public/session.js`'s half is pinned in `test/upload-modal-frontend.test.js`;
 * this is the sibling surface, and it reads a DIFFERENT set of field names —
 * `GET /api/continuity/:project/sessions/:sid` prefixes them (`uploadsUnreadable`)
 * because that payload carries several other things that could be unreadable.
 * Two names for one concept is exactly where a consumer drifts from its
 * producer, which is the defect the badge in the other file demonstrates: it
 * branched on `u.secretMatches`, a field the payload has never carried, and
 * rendered for nobody while every test passed.
 *
 * So both halves are DERIVED. The field names come from `server.js`'s own route
 * body rather than from literals typed here, so renaming one side without the
 * other reddens this rather than silently disconnecting the surface.
 *
 * `public/history-drawer.js` builds DOM from innerHTML strings with page-level
 * dependencies, so source-level structural assertions are the pragmatic contract
 * lock-in here — the same pattern `test/upload-modal-frontend.test.js` and
 * `test/master-drawer-frontend.test.js` use, for the same reason.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('history drawer — a session whose uploads could not be read (#889)', () => {
  let js;
  let server;

  before(() => {
    js = fs.readFileSync(path.join(__dirname, '..', 'public', 'history-drawer.js'), 'utf8');
    server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  });

  it('reads exactly the field names the drill-down route emits', () => {
    // The producer side: the keys server.js actually puts on the drill-down
    // body. Derived, so a rename on the server reddens this test rather than
    // quietly disconnecting the drawer from its own payload.
    const emitted = [...server.matchAll(/^\s{4}(uploadsUnreadable\w*):/gm)].map((m) => m[1]);
    assert.ok(emitted.length >= 2,
      `the drill-down route must emit the unreadable fields (found ${emitted.join(', ') || 'none'})`);
    assert.ok(emitted.includes('uploadsUnreadable'), 'the reason itself is emitted');

    // The consumer must read the reason and the remedy. It deliberately does NOT
    // read the code — same as the upload modal, which leaves the machine-readable
    // classification to API consumers.
    for (const field of ['uploadsUnreadable', 'uploadsUnreadableHint']) {
      assert.ok(emitted.includes(field), `producer emits ${field}`);
      assert.ok(js.includes(`data.${field}`), `the drawer must read data.${field}`);
    }
  });

  it('renders the Uploads section for a refusal even when the filtered list is empty', () => {
    // THE MUTATION THIS CATCHES: gate the section on `uploads.length` alone. A
    // session whose uploads directory refused to be read then renders no Uploads
    // section at all — indistinguishable from a session that never had any,
    // which is the lie this change exists to remove.
    assert.match(js, /uploads\.length\s*\|\|\s*uploadsUnreadable/);
  });

  it('claims only what the payload supports — the project may be incomplete, not this session', () => {
    // `listUploads` walks the legacy pile and every session directory and reports
    // the FIRST refusal it met, so the directory that refused may belong to a
    // different session and this session's list may be complete. A sentence
    // naming THIS session would be more useful and sometimes false.
    const notice = js.slice(js.indexOf('uploadsUnreadable ='), js.indexOf('const uploadsHtml'));
    assert.match(notice, /Some of this project's uploads/,
      'the sentence must be about the project, which is what the payload knows');
    assert.ok(!/could not read this session/i.test(notice),
      'claiming this session refused is a stronger fact than listUploads reports');
  });

  it('escapes both interpolated values — they carry a filesystem message', () => {
    const notice = js.slice(js.indexOf('uploadsUnreadable ='), js.indexOf('const uploadsHtml'));
    assert.match(notice, /esc\(data\.uploadsUnreadable\)/);
    assert.match(notice, /esc\(data\.uploadsUnreadableHint\)/);
  });
});
