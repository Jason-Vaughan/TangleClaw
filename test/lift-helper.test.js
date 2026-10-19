'use strict';

/**
 * Contract for `test/helpers/lift.js`, the shared brace-matcher that lifts
 * shipped browser functions out of `public/*.js` for a test to run (#1903).
 *
 * The helper is the one copy of that matcher because copies drift: one private
 * copy of `esc` accepted fewer types than the shipped one. These cases pin the
 * helper to exactly what the copies it replaced did, limitations included, so a
 * test that lifts through it lifts the same text. The scan at the bottom refuses
 * a new private copy.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lift = require('./helpers/lift');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

describe('test/helpers/lift.js — the shared brace-matcher (#1903)', () => {
  const SRC = [
    'const before = 1;',
    'function outer(a) {',
    '  if (a) { return { a }; }',
    '  return null;',
    '}',
    'function after() { return 2; }'
  ].join('\n');

  it('liftDeclaration returns the declaration through the brace that closes its body', () => {
    assert.equal(lift.liftDeclaration(SRC, 'function outer('),
      'function outer(a) {\n  if (a) { return { a }; }\n  return null;\n}');
  });

  it('liftBody returns the body alone, from its opening brace through its closing one', () => {
    assert.equal(lift.liftBody(SRC, 'function outer('),
      '{\n  if (a) { return { a }; }\n  return null;\n}');
  });

  it('names the declaration when it is missing', () => {
    assert.throws(() => lift.liftDeclaration(SRC, 'function absent('),
      (err) => err instanceof assert.AssertionError && /function absent\( must exist/.test(err.message));
    assert.throws(() => lift.liftBody(SRC, 'function absent('),
      (err) => err instanceof assert.AssertionError && /function absent\( must exist/.test(err.message));
  });

  it('names the declaration when its body never closes', () => {
    const open = 'function broken() { if (x) {';
    assert.throws(() => lift.liftDeclaration(open, 'function broken('),
      (err) => err instanceof assert.AssertionError && /function broken\( body must close/.test(err.message));
    assert.throws(() => lift.liftBody(open, 'function broken('),
      (err) => err instanceof assert.AssertionError && /function broken\( body must close/.test(err.message));
    assert.throws(() => lift.liftDeclaration('function bare()', 'function bare('),
      (err) => err instanceof assert.AssertionError && /body must close/.test(err.message),
      'a declaration with no brace anywhere after it does not close either');
  });

  it('counts a brace inside a string or a comment, as every copy does today', () => {
    // A known limitation, pinned on purpose: changing it would change what a
    // migrated test lifts, and that is its own decision.
    const quoted = "function q() { const s = '}'; return s; }\nfunction next() {}";
    assert.equal(lift.liftDeclaration(quoted, 'function q('), "function q() { const s = '}");
    const commented = 'function c() { /* { */ return 1; }\n}\nlater();';
    assert.equal(lift.liftDeclaration(commented, 'function c('),
      'function c() { /* { */ return 1; }\n}', 'the brace in the comment held the body open one line longer');
  });

  it('lifts the first occurrence when the declaration appears twice', () => {
    const twice = 'function d() { return 1; }\nfunction d() { return 2; }';
    assert.equal(lift.liftDeclaration(twice, 'function d('), 'function d() { return 1; }');
  });

  for (const file of ['landing.js', 'session.js']) {
    describe(`loaders run the esc and jsArg shipped in public/${file}`, () => {
      const shipped = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');

      it('loadEsc encodes as the shipped esc does, and is built from its text', () => {
        const esc = lift.loadEsc(file);
        assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
        assert.equal(esc(7), '7');
        assert.equal(esc({}), '', 'the shipped esc refuses an object');
        assert.equal(esc.toString(), lift.liftDeclaration(shipped, 'function esc('),
          'a re-implemented esc would pass the behaviour checks; this one would not');
      });

      it('loadJsArg encodes a quote and a backslash, and is built from the shipped text', () => {
        const jsArg = lift.loadJsArg(file);
        assert.equal(jsArg("O'Brien"), '&quot;O&#39;Brien&quot;');
        assert.equal(jsArg('a\\b'), '&quot;a\\\\b&quot;');
        assert.equal(jsArg(undefined), 'null');
        assert.equal(jsArg.toString(), lift.liftDeclaration(shipped, 'function jsArg('));
      });
    });
  }

  it('the loaders default to public/landing.js', () => {
    const landing = fs.readFileSync(path.join(PUBLIC_DIR, 'landing.js'), 'utf8');
    assert.equal(lift.loadEsc().toString(), lift.liftDeclaration(landing, 'function esc('));
    assert.equal(lift.loadJsArg().toString(), lift.liftDeclaration(landing, 'function jsArg('));
  });
});

// ── The inventory of private copies ──────────────────────────────────────────
//
// The rule: a line that searches for '{' with `indexOf`, followed within eight
// lines by depth counting over '{' and '}'. Each match is keyed by its file and
// the helper it sits in (a definition within six lines above it), or
// `(inline)` when it is written straight into a test. Keys repeat when one file
// has several inline copies, so the comparison is a multiset.
//
// What the rule does not find: a matcher that locates its brace another way.
// None of that shape was found when the list was taken; the other depth
// counters in `test/` match `${` interpolations or parentheses, not bodies.

/** Rule matches that are not JS-function lifters, each with why. */
const EXCEPTIONS = {
  'button-touch-targets.test.js :: (inline)': 'reads a CSS @media block, not a function',
  'mobile-toolbar-layout.test.js :: mediaBlocks': 'reads CSS @media blocks, not a function',
  'update-beacon-pages.test.js :: beaconConstruction': 'lifts a call\'s object-literal argument, not a declaration'
};

/**
 * Private brace-matcher copies the scan accepts. Empty: every lift in `test/`
 * goes through the shared helper, so any copy the scan finds is new and is
 * refused.
 */
const INITIAL_INVENTORY = [];

/**
 * Find every brace-matcher copy in `test/*.js` by the rule above.
 * @returns {string[]} Keys, `<file> :: <helper>`, sorted.
 */
function scanCopies() {
  const testDir = __dirname;
  const OPEN = /indexOf\(\s*(['"])\{\1/;
  const COUNT_OPEN = /===\s*(['"])\{\1/;
  const CLOSE = /(['"])\}\1/;
  const DEF = /^\s*(?:async\s+)?function\s+(\w+)\s*\(|^\s*(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function\b|\w+\s*=>)/;
  const found = [];
  const files = fs.readdirSync(testDir)
    .filter((f) => f.endsWith('.js') && f !== path.basename(__filename))
    .sort();
  for (const file of files) {
    const lines = fs.readFileSync(path.join(testDir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!OPEN.test(line)) return;
      const ahead = lines.slice(i, i + 8).join('\n');
      if (!COUNT_OPEN.test(ahead) || !CLOSE.test(ahead)) return;
      let name = '(inline)';
      for (let j = i; j >= Math.max(0, i - 6); j--) {
        const m = lines[j].match(DEF);
        if (m) { name = m[1] || m[2]; break; }
      }
      found.push(`${file} :: ${name}`);
    });
  }
  return found.sort();
}

describe('the inventory of private brace-matcher copies (#1903)', () => {
  it('equals the recorded set exactly: a new copy fails, and so does a removed one until the list shrinks', () => {
    const found = scanCopies();
    const expected = [...INITIAL_INVENTORY, ...Object.keys(EXCEPTIONS)].sort();
    const added = found.filter((k) => expected.filter((e) => e === k).length < found.filter((f) => f === k).length);
    const removed = expected.filter((k) => found.filter((f) => f === k).length < expected.filter((e) => e === k).length);
    assert.deepEqual(found, expected,
      `new copies (use test/helpers/lift.js instead): ${JSON.stringify([...new Set(added)])}; `
      + `copies gone (remove them from INITIAL_INVENTORY): ${JSON.stringify([...new Set(removed)])}`);
  });

  it('does not scan the shared helper itself', () => {
    assert.ok(!scanCopies().some((k) => k.startsWith('helpers/')));
  });
});
