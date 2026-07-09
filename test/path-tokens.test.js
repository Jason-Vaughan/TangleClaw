'use strict';

/*
 * CON-8H3Z — the path-token matcher shared by the continuity Map
 * (lib/continuity.js) and the features-toc wrap step
 * (lib/wrap-steps/features-toc.js). Before extraction each carried a
 * character-identical copy; these tests pin the shared factory's behavior so
 * the dedup is provably behavior-preserving and future edits to the allowlist
 * update both consumers at once.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makePathTokenRegex, PATH_TOKEN_EXTENSIONS } = require('../lib/path-tokens');

// The exact literal both modules carried before CON-8H3Z — the regression pin.
const HISTORICAL = /([A-Za-z0-9_./-]+\.(?:js|jsx|ts|tsx|json|md|html|css|yaml|yml|sh))(?:\b|:)/gi;

describe('path-tokens.makePathTokenRegex (CON-8H3Z)', () => {
  it('compiles byte-identically to the pre-dedup literal', () => {
    const re = makePathTokenRegex();
    assert.equal(re.source, HISTORICAL.source, 'regex source must match the historical literal');
    assert.equal(re.flags, HISTORICAL.flags, 'flags must be "gi"');
    assert.equal(re.global, true);
    assert.equal(re.ignoreCase, true);
  });

  it('returns a fresh instance each call (isolated lastIndex — no cross-module leak)', () => {
    const a = makePathTokenRegex();
    const b = makePathTokenRegex();
    assert.notEqual(a, b, 'each call returns a distinct RegExp object');
    // Advancing one does not move the other.
    a.exec('lib/foo.js');
    assert.equal(a.lastIndex > 0, true);
    assert.equal(b.lastIndex, 0);
  });

  it('captures the path in group 1, excluding a trailing :line ref', () => {
    const re = makePathTokenRegex();
    const m = re.exec('see `lib/foo.js:42` for details');
    assert.equal(m[1], 'lib/foo.js');
  });

  it('matches inside backticks, free text, and link targets (loose anchor)', () => {
    const extract = (text) => {
      const re = makePathTokenRegex();
      const out = [];
      let m;
      while ((m = re.exec(text)) !== null) out.push(m[1]);
      return out;
    };
    assert.deepEqual(extract('`lib/a.js` and lib/b.ts (added)'), ['lib/a.js', 'lib/b.ts']);
    assert.deepEqual(extract('[docs](docs/guide.md)'), ['docs/guide.md']);
  });

  it('recognizes exactly the declared extension allowlist', () => {
    const re = makePathTokenRegex();
    for (const ext of PATH_TOKEN_EXTENSIONS) {
      re.lastIndex = 0;
      assert.equal(re.test(`file.${ext}`), true, `.${ext} should match`);
    }
    // A type NOT in the allowlist does not match (e.g. a Python file).
    re.lastIndex = 0;
    assert.equal(re.test('script.py'), false, '.py is intentionally not in the allowlist');
  });

  it('exposes the allowlist compiled into the regex source', () => {
    const re = makePathTokenRegex();
    for (const ext of PATH_TOKEN_EXTENSIONS) {
      assert.match(re.source, new RegExp(`\\b${ext}\\b`), `source should contain ${ext}`);
    }
  });
});
