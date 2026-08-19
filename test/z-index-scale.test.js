'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Parses the z-index scale from a CSS file.
 * Returns a Map of variable names to numeric values.
 */
function extractZScale(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  // Match lines like: --z-drawer: 300;
  const regex = /--z-([a-zA-Z0-9-]+):\s*(\d+);/g;
  const scale = new Map();
  let match;
  while ((match = regex.exec(content)) !== null) {
    scale.set(match[1], parseInt(match[2], 10));
  }
  return scale;
}

describe('z-index scales', () => {
  it('enforces the exact ordering: drawer-backdrop < drawer < modal-backdrop < toast < unreachable', () => {
    const styleCssPath = path.join(__dirname, '..', 'public', 'style.css');
    const sessionCssPath = path.join(__dirname, '..', 'public', 'session.css');
    
    const styleScale = extractZScale(styleCssPath);
    const sessionScale = extractZScale(sessionCssPath);
    
    assert.equal(styleScale.size, 5, `Expected 5 variables in style.css, found ${styleScale.size}`);
    assert.equal(sessionScale.size, 5, `Expected 5 variables in session.css, found ${sessionScale.size}`);
    
    const expectedKeys = ['drawer-backdrop', 'drawer', 'modal-backdrop', 'toast', 'unreachable'];
    for (const key of expectedKeys) {
      assert.ok(styleScale.has(key), `style.css is missing --z-${key}`);
      assert.ok(sessionScale.has(key), `session.css is missing --z-${key}`);
      assert.equal(styleScale.get(key), sessionScale.get(key), `--z-${key} mismatch between files`);
    }

    const db = styleScale.get('drawer-backdrop');
    const d = styleScale.get('drawer');
    const mb = styleScale.get('modal-backdrop');
    const t = styleScale.get('toast');
    const u = styleScale.get('unreachable');
    
    assert.ok(db < d, `drawer-backdrop (${db}) should be < drawer (${d})`);
    assert.ok(d < mb, `drawer (${d}) should be < modal-backdrop (${mb})`);
    assert.ok(mb < t, `modal-backdrop (${mb}) should be < toast (${t})`);
    assert.ok(t < u, `toast (${t}) should be < unreachable (${u})`);
  });
});
