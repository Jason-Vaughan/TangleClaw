'use strict';

/*
 * #768 chunk 2 — a shared module that emits markup is not shared until BOTH
 * stylesheets carry its classes.
 *
 * `public/style.css` and `public/session.css` are independent files with no
 * `@import` between them. Chunk 1 moved the Master settings modal's MARKUP into
 * `public/api-helper.js` so both pages could mount it, and left its STYLES in
 * `style.css` — so the modal renders unstyled on the session page. That was
 * invisible while nothing on that page could open it; chunk 2's whole point is
 * that the gear now can, which turns it into a visible defect at exactly the
 * mobile widths `project-preferences.md` makes load-bearing.
 *
 * The rule is point 5 of the Shared Frontend Module Contract in
 * `.prawduct/artifacts/boundary-patterns.md`.
 *
 * This guard DERIVES the class list from the component's own markup rather than
 * restating it. A hand-listed set is the failure mode it exists to prevent: the
 * plan named six classes and the component actually emits well over twice that,
 * so a sweep written against the list would have been narrower than the claim it
 * made — and would have gone green while the modal was still half-unstyled.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const HELPER = pub('api-helper.js');
// Comments stripped: a class merely NAMED in prose would otherwise read as
// declared, and this guard's whole job is to tell those apart.
const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
const STYLE = stripCss(pub('style.css'));
const SESSION_CSS = stripCss(pub('session.css'));

/**
 * Slice a top-level function (declaration + body) out of source by brace match.
 *
 * @param {string} decl - Declaration text to find.
 * @param {string} src - Source to slice from.
 * @returns {string} Declaration plus balanced body.
 */
function lift(decl, src) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist in api-helper.js`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/**
 * Every class token the Master settings component can render.
 *
 * Class attributes here are template literals and some carry a conditional:
 * `class="master-access-option${enabled ? '' : ' master-access-disabled'}"`.
 * A naive extractor that skipped any attribute containing `${` would drop
 * `master-access-disabled` entirely — the disabled state is precisely the one an
 * operator meets when access-level changes are gated, so missing it would leave
 * the guard green over the case most likely to be seen unstyled.
 *
 * So both halves are read: the literal text between interpolations, and the
 * quoted string literals *inside* them. `findsClassesInsideInterpolations` below
 * is the positive control that this second half actually works.
 *
 * @returns {Set<string>} Class names, without the leading dot.
 */
function emittedClasses() {
  const src = lift('function tcMasterSettingsMarkup(', HELPER)
    + '\n' + lift('function tcCreateMasterSettings(deps)', HELPER);
  const found = new Set();
  const addAll = (text) => {
    for (const c of String(text).trim().split(/\s+/)) if (c) found.add(c);
  };
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    const attr = m[1];
    // Literal text outside any ${...}
    addAll(attr.replace(/\$\{[\s\S]*?\}/g, ' '));
    // Quoted strings inside each ${...}
    for (const expr of attr.matchAll(/\$\{([\s\S]*?)\}/g)) {
      for (const s of expr[1].matchAll(/'([^']*)'|"([^"]*)"/g)) addAll(s[1] ?? s[2] ?? '');
    }
  }
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'/g)) found.add(m[1]);
  return found;
}

/** @param {string} css @param {string} cls @returns {boolean} */
const declares = (css, cls) =>
  new RegExp(`\\.${cls.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![\\w-])`).test(css);

describe('#768 the Master settings modal is styled on BOTH pages', () => {
  it('emits a class set worth guarding', () => {
    const classes = emittedClasses();
    // Not an exact count — that would be a number nothing reads, decaying on the
    // next markup edit. The floor only asserts the extractor found real markup
    // rather than silently matching nothing, which is how this guard would go
    // vacuously green.
    assert.ok(classes.size >= 10,
      `expected the component's markup to yield a real class set, got ${classes.size}`);
    assert.ok(classes.has('master-access-option'),
      'a known modal class must be among them, or the extractor is reading the wrong region');
  });

  it('the two stylesheets agree about every class it emits', () => {
    // PARITY, not universal coverage — and the difference is load-bearing.
    //
    // The first draft of this guard demanded a rule for every emitted class. It
    // failed on `session-rule-history`, which is a `<button class="btn btn-small
    // session-rule-history">`: the class is a selector hook for JS, and the
    // button gets its appearance from `btn btn-small`. Adding a rule to satisfy
    // that would have been inventing styling to fit a test.
    //
    // What point 5 of the Shared Frontend Module Contract actually requires is
    // that the two pages render the component the SAME. So the contract is
    // symmetry: a class styled on one page must be styled on the other. A hook
    // styled on neither is fine; a class styled on exactly one is the defect,
    // and it is the defect in both directions rather than only session.css's.
    const asymmetric = [];
    for (const cls of [...emittedClasses()].sort()) {
      const inStyle = declares(STYLE, cls);
      const inSession = declares(SESSION_CSS, cls);
      if (inStyle !== inSession) {
        asymmetric.push(`${cls}: style.css=${inStyle} session.css=${inSession}`);
      }
    }
    assert.deepEqual(asymmetric, [],
      'a shared module that renders its own DOM carries a stylesheet dependency the '
      + '<script> tags do not show; the page lacking these classes renders the modal unstyled');
    // THE MUTATION THIS CATCHES: deleting any ported rule from session.css, or
    // adding a class to the component's markup and styling it on one page only —
    // in either direction.
  });

  it('findsClassesInsideInterpolations', () => {
    // The positive control for the half of the extractor that is easy to get
    // silently wrong. `master-access-disabled` exists ONLY inside a conditional
    // interpolation, so an extractor that skipped `${...}` would still report a
    // healthy-looking class set and a clean parity result — green, and blind to
    // the state an operator actually hits when access-level changes are gated.
    assert.ok(emittedClasses().has('master-access-disabled'),
      'the extractor must read class names out of interpolated expressions, '
      + 'or every guard above is measuring a subset it does not disclose');
  });
});
