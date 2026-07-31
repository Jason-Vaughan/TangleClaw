'use strict';

/*
 * The Login section of the global settings modal (#710 chunk 3b).
 *
 * `public/ui.js` renders via innerHTML strings and carries many top-level
 * dependencies (state, esc, api, apiMutate), so structural source assertions are
 * this repo's established way to pin its contracts — the same pattern used for the
 * silentPrime toggle and for session.js.
 *
 * What is pinned here is deliberately not "the form renders". It is the set of
 * decisions that would be quietly undone by a well-meaning edit: that the form is
 * drawn only on the server's say-so, that there is no current-password field, that
 * the sign-out warning arrives BEFORE the operator commits, and that no part of
 * this screen moves on a timer.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Global settings — Login section (#710 chunk 3b)', () => {
  let src;
  /** Just the credential loader, so assertions cannot pass on unrelated code. */
  let section;

  before(() => {
    src = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    const start = src.indexOf('async function _loadCredentialSection');
    assert.ok(start > -1, '_loadCredentialSection must exist');
    const end = src.indexOf('function openGlobalSettings', start);
    assert.ok(end > start, 'could not bound the credential section');
    section = src.slice(start, end);
  });

  describe('the server decides whether the form exists', () => {
    it('asks the endpoint before drawing anything', () => {
      assert.match(section, /await api\('\/api\/auth\/credential'\)/);
    });

    it('renders the form only when the server says changeable, and returns otherwise', () => {
      // The negative branch must RETURN, and the return must come BEFORE the form
      // markup — falling through would draw a form for an install the POST is
      // going to refuse, which is the client-vs-server disagreement about one
      // machine that the wizard step list already had to fix.
      //
      // Scoped to the slice rather than matched with a lazy [\s\S]*? across the
      // whole function: that form of the assertion passes by finding any later
      // `return;` in the click handler, so deleting this one leaves it green.
      // Verified by doing exactly that.
      const formStart = section.indexOf('box.innerHTML = `\n    <label');
      assert.ok(formStart > -1, 'could not locate the form markup');
      const negative = section.slice(section.indexOf('if (!info.changeable)'), formStart);
      assert.match(negative, /return;/,
        'the refusal branch must return before the form is rendered');
      assert.doesNotMatch(negative, /gsCredPassword/,
        'the refusal branch must not contain a password field');
    });

    it('shows the server\'s own reason and remedy rather than inventing copy', () => {
      // Same words the POST would refuse with, so the two can never disagree.
      assert.match(section, /esc\(info\.reason/);
      assert.match(section, /esc\(info\.remedy\)|info\.remedy \?/);
    });
  });

  describe('the fields, and the one that is deliberately absent', () => {
    it('has NO current-password field', () => {
      // Not an oversight. `caddy hash-password` has no verify mode and no --salt,
      // so a stored bcrypt hash cannot be reproduced for comparison, and Node's
      // stdlib has no bcrypt — the server cannot check a typed current password,
      // and a field that does not verify is theatre. If someone adds one later,
      // this test is where they find out why it cannot work.
      assert.doesNotMatch(section, /gsCredCurrent|current-password|currentPassword/i,
        'a current-password field would imply a verification the server cannot perform');
    });

    it('has a confirm field, and compares it in the browser where it CAN be checked', () => {
      // Unlike a current-password field, this one is verifiable client-side, and
      // it earns its place: a mistyped password locks the operator out of their own
      // dashboard with only a terminal to get back in.
      assert.match(section, /id="gsCredConfirm"/);
      assert.match(section, /password\s*!==\s*confirm/);
    });

    it('uses password inputs and the 44px-min form-input class on every field', () => {
      // Mobile-first is a project rule and the operator is almost never at this
      // machine — `.form-input` carries min-height 44px.
      assert.match(section, /type="password" class="form-input" id="gsCredPassword"/);
      assert.match(section, /type="password" class="form-input" id="gsCredConfirm"/);
      assert.match(section, /type="text" class="form-input" id="gsCredUser"/);
    });

    it('prefills the username so a password change does not require retyping it', () => {
      assert.match(section, /value="\$\{esc\(info\.user \|\| ''\)\}"/);
    });
  });

  describe('the sign-out is stated before it happens', () => {
    it('warns inside the FORM, not only after submitting', () => {
      // Caddy reloads with the new hash and basic_auth cannot hand a browser new
      // credentials, so the re-prompt is certain. Told after the fact it reads as
      // a fault; told before, it is an instruction to have the password ready.
      const form = section.slice(section.indexOf('id="gsCredUser"'),
        section.indexOf('gsCredSaveBtn'));
      assert.match(form, /signs you out/i);
      assert.match(form, /reset-admin/, 'and names the way back if they lose it');
    });
  });

  describe('submission', () => {
    it('posts to the guarded route, never to PATCH /api/config', () => {
      assert.match(section, /apiMutate\('\/api\/auth\/credential',\s*'POST'/);
      assert.doesNotMatch(section, /\/api\/config/,
        'the config route no longer accepts credentials and must not be called');
    });

    it('reports the change without moving the screen', () => {
      // #98/#268: no timer-driven UI lifecycle. The operator is about to be asked
      // for a password — a screen that redirects or dismisses itself takes away the
      // moment they need to read which one.
      assert.doesNotMatch(section, /setTimeout|setInterval|location\.href|location\.reload/,
        'this screen must not move on its own');
    });

    it('names the finishing command when Caddy could not be reloaded', () => {
      // The change HAS taken but the OLD password is still in force, which is the
      // one outcome an operator must not have to infer.
      assert.match(section, /res\.reloaded === false/);
      assert.match(section, /esc\(res\.reloadCommand/);
    });

    it('escapes every server-supplied value it interpolates', () => {
      // innerHTML with unescaped server strings is an injection surface; these all
      // originate server-side.
      for (const expr of ['esc(info.user', 'esc(info.reason', 'esc(res.reloadCommand', 'esc(api.lastError']) {
        assert.ok(section.includes(expr), `${expr} must be escaped before interpolation`);
      }
    });

    it('re-enables the button after a failure, so a refusal is not a dead end', () => {
      // Disabling during flight is right; leaving it disabled would strand the
      // operator on a fixable error (a weak password, a mismatch) with no retry.
      assert.match(section, /saveBtn\.disabled = true;[\s\S]*?saveBtn\.disabled = false;/);
    });
  });

  describe('the section is wired into the modal', () => {
    it('loads when global settings opens', () => {
      assert.match(src, /_loadCredentialSection\(\);/);
      assert.match(src, /id="gsCredentialSection"/);
    });
  });
});
