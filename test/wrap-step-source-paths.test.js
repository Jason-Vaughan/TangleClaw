'use strict';

/**
 * Tests for the shared source-file classifier (#659) — the single source of truth
 * `features-toc` (indexing) and `changelog-coverage` (uncommitted-work detection)
 * both rely on. The load-bearing property for the second caller is that tracked
 * bookkeeping (`.prawduct/…`) is NOT a source file, so the gate can flag real work
 * without re-introducing the reverted #645 false-block.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  isSourceFile,
  INDEXABLE_EXTENSIONS,
  EXCLUDED_BASENAMES,
  EXCLUDED_PREFIXES
} = require('../lib/wrap-steps/_source-paths');

describe('_source-paths — isSourceFile', () => {
  it('accepts ordinary source files across the indexable extensions', () => {
    for (const p of ['lib/a.js', 'src/b.ts', 'public/app.jsx', 'x/y.tsx',
      'data/c.json', 'docs/d.md', 'p/e.html', 's/f.css', 'k/g.yaml', 'k/h.yml', 'scripts/i.sh']) {
      assert.equal(isSourceFile(p), true, `${p} should be a source file`);
    }
  });

  it('rejects tracked bookkeeping via the leading-dot-segment rule (keeps #645 fixed)', () => {
    assert.equal(isSourceFile('.prawduct/change-log.md'), false);
    assert.equal(isSourceFile('.tangleclaw/memories/MEMORY.md'), false);
    assert.equal(isSourceFile('foo/.cache/bar.js'), false, 'a hidden dir anywhere in the chain excludes');
    assert.equal(isSourceFile('.github/workflows/ci.yml'), false, 'a leading-dot top segment excludes');
  });

  it('rejects vendored / build output via the prefix list', () => {
    assert.equal(isSourceFile('node_modules/pkg/index.js'), false);
    assert.equal(isSourceFile('dist/bundle.js'), false);
    assert.equal(isSourceFile('coverage/lcov.js'), false);
    assert.equal(isSourceFile('build/out.js'), false);
  });

  it('rejects the high-churn root docs by basename (changelog/readme/index are not "work")', () => {
    assert.equal(isSourceFile('CHANGELOG.md'), false);
    assert.equal(isSourceFile('README.md'), false);
    assert.equal(isSourceFile('FEATURES.md'), false);
  });

  it('rejects non-indexable extensions and extensionless paths', () => {
    assert.equal(isSourceFile('data/schema.sql'), false);
    assert.equal(isSourceFile('docs/logo.png'), false);
    assert.equal(isSourceFile('LICENSE'), false);
    assert.equal(isSourceFile('bin/tool'), false);
  });

  it('is defensive about non-string / empty input', () => {
    assert.equal(isSourceFile(''), false);
    assert.equal(isSourceFile(null), false);
    assert.equal(isSourceFile(undefined), false);
    assert.equal(isSourceFile(42), false);
  });

  it('exposes the constants it classifies with', () => {
    assert.ok(INDEXABLE_EXTENSIONS.has('.js'));
    assert.ok(EXCLUDED_BASENAMES.has('CHANGELOG.md'));
    assert.ok(EXCLUDED_PREFIXES.includes('node_modules/'));
  });
});

describe('_source-paths — shared with features-toc (no drift)', () => {
  it('features-toc._isIndexableCandidate is the same classifier', () => {
    const featuresToc = require('../lib/wrap-steps/features-toc');
    // Same instance re-exported, and same verdicts — the whole point of the extraction.
    assert.equal(featuresToc.INDEXABLE_EXTENSIONS, INDEXABLE_EXTENSIONS);
    assert.equal(featuresToc.EXCLUDED_PREFIXES, EXCLUDED_PREFIXES);
    for (const p of ['lib/a.js', '.prawduct/x.md', 'node_modules/y.js', 'CHANGELOG.md', 'data/z.sql']) {
      assert.equal(featuresToc._isIndexableCandidate(p), isSourceFile(p), `mismatch on ${p}`);
    }
  });
});
