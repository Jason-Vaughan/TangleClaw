'use strict';

/*
 * The Login section of the global settings modal (#710).
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

describe('Global settings — Login section (#710)', () => {
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

    it('shows the username READ-ONLY, and says why', () => {
      // It is a selector, not a value: `replaceBasicAuthCredential` re-hashes the
      // line it names and writes the MATCHED name back, so an editable field
      // promised a rename that could only ever throw or silently keep the old name.
      assert.match(section, /value="\$\{esc\(info\.user \|\| ''\)\}" readonly/);
      assert.match(section, /aria-readonly="true"/);
      assert.match(section, /cannot be changed\s*\n?\s*here/, 'and the form must say so');
      assert.match(section, /reset-admin/, 'and name where a rename does happen');
    });

    it('does not send the username back, since the server resolves it from the gate', () => {
      // Sending a read-only value back would be a field the client has no authority
      // over — and a stale one whenever config and the live file have drifted.
      assert.match(section, /apiMutate\('\/api\/auth\/credential', 'POST', \{ password \}\)/);
      assert.doesNotMatch(section, /POST', \{ user/);
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

    it('does not lead with a reassurance the server has stopped leading with', () => {
      // Most refusals here mean "your login was not changed and nothing else
      // happened". One does not: GATE_BROKEN means the Caddy config could not be
      // written or put back. A hard-coded bold "The login was not changed." above
      // that message is the exact framing the server abandoned — a scanning
      // operator reads the bold line and stops.
      // Comments STRIPPED before matching. The previous version of this test
      // searched the raw slice, where the explanatory comment names both codes —
      // so removing one from the actual list left it green. A pin that matches
      // the prose describing the code is not a pin.
      const failure = section
        .slice(section.indexOf('if (!res)'), section.indexOf('Your login is changed'))
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      // Both codes, not just the first one found. DIVERGED is the worse of the
      // two: there the login DID change, so a bold "not changed" would sit
      // directly above a body saying the new password is in force.
      assert.match(failure, /GATE_BROKEN/);
      assert.match(failure, /DIVERGED/,
        'the outcome where the login DID change must not lead with "not changed"');
      // Pins the CONDITIONAL, not the mere presence of an escaped error — the
      // hard-coded version contained `esc(api.lastError` too, so asserting that
      // alone measured nothing it claimed to.
      assert.match(failure, /\?\s*`<strong>\$\{esc\(api\.lastError/,
        'on those codes the server\'s own sentence must BE the bold lead');
    });

    it('does not report a reload outcome the server cannot know', () => {
      // Caddy restarts as the response leaves, and every request after that needs
      // the new password — so no reply can ever carry whether the restart worked.
      // A screen that branches on it would be inventing the answer. An earlier
      // version did branch, on a `reloaded` field the response no longer has.
      const success = section.slice(section.indexOf('Your login is changed'));
      assert.doesNotMatch(success, /res\.reloaded/,
        'the success text must not branch on a reload result the response cannot carry');
      assert.match(success, /will ask for the new password/);
    });

    it('names the symptom of a failed restart, and the command that fixes it', () => {
      // What the operator CAN observe is the absence of the prompt. That symptom
      // and its one remedy are the whole of what this screen can honestly offer
      // about an outcome it never learns.
      const success = section.slice(section.indexOf('Your login is changed'));
      assert.match(success, /If you are never asked/);
      assert.match(success, /old password still works/);
      assert.match(success, /esc\(res\.reloadCommand\)/);
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
