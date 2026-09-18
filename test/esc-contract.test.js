'use strict';

/*
 * The escape helpers' contract, asserted against the REAL shipped functions.
 *
 * Every case lifts its subject out of the page source, so a test-local stub
 * can never stand in for one. That substitution is what lets an escaping
 * change ship green: a stub with a different contract than the shipped helper
 * makes assertions pass against markup the product cannot emit.
 *
 * `esc` in landing.js, `esc` in session.js and `tcEscapeHtml` in api-helper.js
 * are pinned together here because api-helper renders shared markup with
 * whichever one its host page hands it, which makes their agreement a
 * contract rather than a coincidence. Three more escapers exist and are NOT
 * covered — `escapeHtml` in session.js, openclaw-view.js and health-panel.js,
 * which serve their own files and share no caller with these. Collapsing all
 * six onto one owner is #1605.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', 'public');

/**
 * Slice a top-level function out of source text by brace-matching, so the
 * assertions run the shipped code rather than a copy of it.
 * @param {string} src - File source text
 * @param {string} decl - Declaration to find, e.g. `function esc(str)`
 * @returns {string} The declaration plus its balanced body
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/**
 * Run one lifted escape helper and hand back a callable.
 * @param {string} file - Filename under public/
 * @param {string} decl - Its declaration
 * @param {string} name - The identifier to return
 * @returns {function(*): string}
 */
function liftEscaper(file, decl, name) {
  const ctx = vm.createContext({});
  vm.runInContext(liftFunction(fs.readFileSync(path.join(PUB, file), 'utf8'), decl), ctx);
  return ctx[name];
}

const ESCAPERS = [
  ['landing.js esc', liftEscaper('landing.js', 'function esc(str)', 'esc')],
  ['session.js esc', liftEscaper('session.js', 'function esc(str)', 'esc')],
  ['api-helper.js tcEscapeHtml', liftEscaper('api-helper.js', 'function tcEscapeHtml(str)', 'tcEscapeHtml')]
];

describe('the page escape helpers', () => {
  for (const [label, escape] of ESCAPERS) {
    describe(label, () => {
      it('escapes every character that could break out of markup', () => {
        assert.equal(escape('<script>'), '&lt;script&gt;');
        assert.equal(escape('a & b'), 'a &amp; b');
        assert.equal(escape('say "hi"'), 'say &quot;hi&quot;');
        assert.equal(escape('<img src=x onerror=alert(1)>'),
          '&lt;img src=x onerror=alert(1)&gt;');
      });

      it("escapes the apostrophe, which a double-quoted attribute alone does not force", () => {
        // Call sites interpolate this into a single-quoted JS string INSIDE a
        // double-quoted attribute — `onclick="f(this, '${esc(id)}')"` at
        // public/session.js:694 is one. There `"` escaping is not enough: a
        // bare `'` closes the JS string and the rest of the value is parsed as
        // code. Asserted per-escaper rather than only across them, because
        // three helpers that drop it together still agree with each other.
        assert.equal(escape("it's"), 'it&#39;s');
        assert.equal(escape("');alert(1);//"), '&#39;);alert(1);//');
      });

      it('escapes & first, so an escape is never double-escaped into a literal entity', () => {
        // '&lt;' arriving as DATA must render as the visible text '&lt;', which
        // needs its own ampersand escaped. Replacing '<' before '&' would emit
        // '&amp;lt;' for a real '<' instead.
        assert.equal(escape('&lt;'), '&amp;lt;');
      });

      it('renders numbers, including zero', () => {
        // The defect: ids, counts and revisions arrive from the API as JSON
        // numbers. Zero is called out because it is the value a truthiness
        // guard would drop even after a coercion fix.
        assert.equal(escape(42), '42');
        assert.equal(escape(0), '0');
        assert.equal(escape(-1), '-1');
      });

      it('renders booleans and bigints', () => {
        assert.equal(escape(true), 'true');
        assert.equal(escape(false), 'false');
        assert.equal(escape(10n), '10');
      });

      it('renders nothing for an absent value', () => {
        // Callers pass legitimately-missing fields and want the empty cell.
        assert.equal(escape(null), '');
        assert.equal(escape(undefined), '');
      });

      it('renders nothing for a value it has no text form for', () => {
        // Whatever each helper decides here, it must decide it the same way
        // for every shape — a helper that blanked `{}` and coerced `[]` would
        // be the inconsistency this file exists to catch. Which of the two
        // answers is right across helpers is the subject of the last case.
        const blanked = escape({}) === '';
        assert.equal(escape([1, 2]) === '', blanked, 'arrays and objects take the same branch');
        assert.equal(escape(() => {}) === '', blanked, 'functions take it too');
      });
    });
  }

  it('agrees across all three on every value a caller actually passes', () => {
    // api-helper builds shared markup with whichever escaper its host page
    // hands it, so the same row rendered on the dashboard and in a session
    // must escape identically. The values are the ones that reach these call
    // sites: text, the JSON scalars an API row carries, and an absent field.
    const values = ['<a&b>', '', 'plain', '&lt;', '"\'`',
      42, 0, -1, 3.5, true, false, 10n, null, undefined];
    const [first, ...rest] = ESCAPERS;
    for (const value of values) {
      for (const [label, escape] of rest) {
        assert.equal(escape(value), first[1](value),
          `${label} must agree with ${first[0]} on ${String(value)}`);
      }
    }
  });

  it('records where the three still diverge, so the gap is tracked and not rediscovered', () => {
    // A plain object reaches none of these call sites; it would be a bug at
    // the caller either way. The two contracts disagree about how loudly to
    // fail, and neither answer is asserted as correct here — asserting one
    // would silently re-contract a helper this change is not about. Tracked
    // as #1605; this case FAILS the day someone unifies them, which is the
    // prompt to delete it.
    const byLabel = Object.fromEntries(ESCAPERS);
    assert.equal(byLabel['landing.js esc']({}), '', 'esc blanks a value it cannot render');
    assert.equal(byLabel['session.js esc']({}), '', 'both esc copies agree');
    assert.equal(byLabel['api-helper.js tcEscapeHtml']({}), '[object Object]',
      'tcEscapeHtml coerces it instead');
    assert.equal(byLabel['landing.js esc']([1, 2]), '');
    assert.equal(byLabel['api-helper.js tcEscapeHtml']([1, 2]), '1,2');
  });
});
