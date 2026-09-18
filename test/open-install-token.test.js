'use strict';

/**
 * The open-install page token (Train 21, #1587).
 *
 * The property under test: a token is only ever accepted if this process minted
 * it and it has not expired — and the bound on how many are held cannot be used
 * to evict a live one while dead ones are still in the map.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const openInstallToken = require('../lib/open-install-token');

describe('open-install page token (Train 21, #1587)', () => {
  beforeEach(() => openInstallToken.reset());

  it('accepts a token it minted and nothing else', () => {
    const token = openInstallToken.mint();
    assert.equal(openInstallToken.verify(token), true);
    assert.equal(openInstallToken.verify(`${token}x`), false);
    assert.equal(openInstallToken.verify(token.slice(0, -1)), false);
    assert.equal(openInstallToken.verify('a'.repeat(token.length)), false,
      'a forgery of the right shape is still a forgery');
  });

  it('refuses everything that is not a non-empty string', () => {
    for (const value of [null, undefined, '', 0, 42, {}, [], true]) {
      assert.equal(openInstallToken.verify(value), false, `${JSON.stringify(value)} is not a token`);
    }
  });

  it('mints a distinct token per page', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => openInstallToken.mint()));
    assert.equal(tokens.size, 50);
  });

  it('stops accepting a token once its lifetime has passed', () => {
    const realNow = Date.now;
    const token = openInstallToken.mint();
    try {
      Date.now = () => realNow() + openInstallToken.TOKEN_TTL_MS + 1;
      assert.equal(openInstallToken.verify(token), false);
      assert.equal(openInstallToken.size(), 0, 'an expired token is dropped, not merely refused');
    } finally {
      Date.now = realNow;
    }
  });

  it('holds no more than its cap, and evicts oldest-first', () => {
    const first = openInstallToken.mint();
    for (let i = 0; i < openInstallToken.MAX_TOKENS; i++) openInstallToken.mint();
    assert.ok(openInstallToken.size() <= openInstallToken.MAX_TOKENS);
    assert.equal(openInstallToken.verify(first), false, 'the oldest token is the one that goes');
  });

  it('prunes expired tokens before it evicts a live one', () => {
    // The order matters: a burst of reloads must not be able to push out a token
    // that is still doing its job while the map is full of dead ones.
    const realNow = Date.now;
    try {
      for (let i = 0; i < openInstallToken.MAX_TOKENS; i++) openInstallToken.mint();
      Date.now = () => realNow() + openInstallToken.TOKEN_TTL_MS + 1;
      const live = openInstallToken.mint();
      assert.equal(openInstallToken.size(), 1, 'the dead ones went, so nothing live had to');
      assert.equal(openInstallToken.verify(live), true);
    } finally {
      Date.now = realNow;
    }
  });

  it('forgets everything on reset, which is what arming the gate must do', () => {
    const token = openInstallToken.mint();
    openInstallToken.reset();
    assert.equal(openInstallToken.verify(token), false);
    assert.equal(openInstallToken.size(), 0);
  });
});
