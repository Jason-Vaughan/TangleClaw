'use strict';

/*
 * Contract tests for FEATURES.md itself (backlog DOC-3K7Q).
 *
 * The index's old convention cited `file.js:line` pointers; nothing
 * re-verified them, and they rotted by hundreds of lines. The replacement
 * convention is greppable anchors — `file.js#symbolName` or literal route
 * strings — which these tests keep honest: no line pointers may re-enter,
 * every cited repo path must exist, and every `path#symbol` anchor must
 * actually grep in its file. The seed template in lib/projects.js must
 * prescribe the same convention so newly-seeded projects don't inherit
 * the rotting format.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FEATURES = fs.readFileSync(path.join(ROOT, 'FEATURES.md'), 'utf8');

// Only these first segments are guaranteed present on a fresh clone / CI
// checkout — local-only dirs (.prawduct/, .claude/, .tangleclaw/) are
// deliberately outside the existence contract.
const COMMITTED_ROOTS = new Set([
  'lib', 'public', 'test', 'data', 'deploy', 'scripts', 'docs', '.github'
]);

/**
 * Extract backticked citation tokens that look like committed repo paths,
 * split into `{filePath, symbol}` (symbol null when the token has no `#`).
 * Tokens with globs/placeholders (`*`, `<`, `{`) or non-committed roots
 * are out of contract and skipped.
 * @returns {Array<{token: string, filePath: string, symbol: string|null}>}
 */
function citedPaths() {
  const out = [];
  const re = /`([^`\s]+)`/g;
  let m;
  while ((m = re.exec(FEATURES)) !== null) {
    const token = m[1];
    if (/[*<{]/.test(token)) continue;
    const [filePath, symbol = null] = token.split('#');
    if (!filePath.includes('/')) continue;
    if (!COMMITTED_ROOTS.has(filePath.split('/')[0])) continue;
    out.push({ token, filePath, symbol });
  }
  return out;
}

describe('FEATURES.md citation contract (DOC-3K7Q)', () => {
  it('contains no :line pointers — they rot', () => {
    const lined = FEATURES.match(/[\w./-]+\.(?:js|jsx|ts|tsx|json|md|html|css|sh|ya?ml):\d+/g);
    assert.deepEqual(lined || [], [], `line pointers found: ${(lined || []).join(', ')}`);
  });

  it('every cited committed-repo path exists on disk', () => {
    const missing = citedPaths()
      .filter(({ filePath }) => !fs.existsSync(path.join(ROOT, filePath)))
      .map(({ token }) => token);
    assert.deepEqual(missing, [], `dangling paths: ${missing.join(', ')}`);
  });

  it('every path#symbol anchor greps in its file', () => {
    const broken = [];
    for (const { token, filePath, symbol } of citedPaths()) {
      if (!symbol) continue;
      const target = path.join(ROOT, filePath);
      if (!fs.existsSync(target)) continue; // already reported above
      const source = fs.readFileSync(target, 'utf8');
      const name = symbol.replace(/[[\]()]/g, '');
      if (!source.includes(name)) broken.push(token);
    }
    assert.deepEqual(broken, [], `dangling symbol anchors: ${broken.join(', ')}`);
  });

  it('has no auto-stub TODO backlog sections — stubs get folded, not hoarded', () => {
    assert.ok(!/^## TODO \(auto-stubbed/m.test(FEATURES), 'unfolded auto-stub section present');
  });

  it('seed template prescribes the symbol convention, not :line pointers', () => {
    const { FEATURE_INDEX_TEMPLATE } = require('../lib/projects');
    assert.match(FEATURE_INDEX_TEMPLATE, /NO :line pointers/);
    assert.ok(!/file\.js:line/.test(FEATURE_INDEX_TEMPLATE), 'template still shows the old file.js:line format');
  });
});
