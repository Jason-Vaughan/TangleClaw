'use strict';

/*
 * #243 — the Global Rules editor no longer carries a "Reset to Defaults" button.
 *
 * Under the canonical-source model (#240) `store.globalRules.reset()` is a
 * no-op: `POST /api/rules/global/reset` returns the current content unchanged.
 * A button wired to that route looked like a revert and changed nothing — an
 * operator clicking it expected their customizations to disappear and watched
 * nothing happen. The route stays for back-compat; the UI stops offering it.
 *
 * Two properties, pinned separately: the markup carries no button and no
 * confirmation modal for it, and NO client script calls the route. The
 * second is the one that would regress quietly — a new "revert" affordance
 * that reaches for the same no-op endpoint would look exactly like the bug
 * this removes.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const INDEX = read('index.html');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/**
 * Every client script the pages load — the set that could issue the request.
 * The service worker is excluded on purpose: it caches URLs, it does not call
 * them, and its CACHE_NAME line is not to be touched by a UI test.
 * @returns {Array<{name: string, text: string}>}
 */
function clientScripts() {
  return fs.readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.js') && f !== 'sw.js')
    .map((f) => ({ name: f, text: read(f) }));
}

describe('Global Rules editor Reset button (#243)', () => {
  it('the markup carries no Reset button and no reset confirmation modal', () => {
    assert.doesNotMatch(INDEX, /id="rulesResetBtn"/, 'rulesResetBtn is gone');
    assert.doesNotMatch(INDEX, /Reset to Defaults/, 'the button label is gone');
    assert.doesNotMatch(INDEX, /id="rulesReset(?:Modal|CancelBtn|ConfirmBtn)"/,
      'the confirmation modal and its buttons are gone');
  });

  it('the editor still offers Save — removal did not take the whole action row', () => {
    assert.match(INDEX, /id="rulesSaveBtn"/);
    assert.match(INDEX, /id="rulesEditor"/);
  });

  it('no client script calls POST /api/rules/global/reset or keeps its handler', () => {
    for (const { name, text } of clientScripts()) {
      assert.doesNotMatch(text, /rules\/global\/reset/, `${name} still calls the reset route`);
      assert.doesNotMatch(text, /resetGlobalRules|RulesReset/, `${name} still carries reset handler code`);
    }
  });

  it('the server route stays for back-compat', () => {
    // Removing the button is a UI decision; the endpoint contract is pinned by
    // test/api-globalrules.test.js. This guards the two from drifting together.
    assert.match(SERVER, /route\('POST', '\/api\/rules\/global\/reset'/);
  });
});
