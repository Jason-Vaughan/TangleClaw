'use strict';

// Tests for lib/bridge-context.js (CC-7) — the shared ClawBridge sidecar
// resolver extracted from ai-content + wrap-sentinel. The store-backed happy
// path is covered transitively by both consumers' suites; here we pin the
// store-free guard branches (which return before touching the store).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveBridgeContext } = require('../lib/bridge-context');

describe('bridge-context.resolveBridgeContext — guard branches', () => {
  it('returns null for a null/missing session', () => {
    assert.equal(resolveBridgeContext(null, 'proj'), null);
    assert.equal(resolveBridgeContext({}, 'proj'), null);
  });

  it('returns null for a non-openclaw engine (never touches the store)', () => {
    assert.equal(resolveBridgeContext({ engineId: 'claude' }, 'proj'), null);
    assert.equal(resolveBridgeContext({ engineId: 'gemini' }, 'proj'), null);
  });
});
