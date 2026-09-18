'use strict';

/**
 * The anti-forgery token an OPEN install issues to its own dashboard
 * (Train 21, #1587).
 *
 * An install whose login is explicitly disabled has no session and therefore no
 * CSRF token — `/api/auth/me` answers `csrfToken: null` when signed out — so a
 * route that must not be reachable cross-site has nothing to check. This mints
 * one per dashboard page load and checks it on the one route that needs it.
 *
 * **What it proves, exactly.** That the caller fetched a token from THIS server
 * in THIS process's lifetime. That is what stops a cross-site page from clearing
 * a recovery, and it is all it stops. It does not prove a human, and it cannot
 * exclude a local process that fetched a token of its own — so a clear carrying
 * it is recorded as `open-install-unverified` and is never counted as an
 * operator's. The honest label is the point: an open install is open.
 *
 * In memory on purpose. A token is worth exactly one browser's page lifetime,
 * and a restart that invalidates every outstanding one costs a dashboard reload
 * — which the dashboard does anyway, because it refetches `/api/auth/me` when it
 * reconnects. Persisting them would buy nothing and would keep a forgery-
 * relevant secret on disk for an install that has no account to protect.
 *
 * @module lib/open-install-token
 */

const crypto = require('node:crypto');

/**
 * How long a minted token stays valid.
 *
 * Long enough that a dashboard left open across a working day still clears a
 * recovery without a reload, short enough that a token leaked out of a browser
 * history or a screen share stops working the same day.
 * @type {number}
 */
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The most tokens held at once.
 *
 * A bound rather than a guess at demand: every page load mints one, and nothing
 * else prunes them until they expire, so an install whose dashboard reloads on a
 * loop must not be able to grow this without limit. Eviction is oldest-first, so
 * the tokens lost are the ones closest to expiring anyway.
 * @type {number}
 */
const MAX_TOKENS = 512;

/** @type {Map<string, number>} token → expiry in epoch ms, in insertion order */
const _tokens = new Map();

/**
 * Drop every token that has expired.
 * @returns {void}
 */
function _prune() {
  const now = Date.now();
  for (const [token, expires] of _tokens) {
    if (expires <= now) _tokens.delete(token);
  }
}

/**
 * Mint a token for one dashboard page.
 * @returns {string} The token to hand the page
 */
function mint() {
  _prune();
  // Oldest-first, and after pruning: eviction only ever reaches live tokens once
  // the expired ones are already gone, so a burst of reloads cannot evict a
  // token that is still doing its job while dead ones sit in the map.
  while (_tokens.size >= MAX_TOKENS) {
    const oldest = _tokens.keys().next();
    if (oldest.done) break;
    _tokens.delete(oldest.value);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  _tokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

/**
 * Whether this token is one this process minted and has not expired.
 *
 * Compared in constant time, and only after the map has answered that a token of
 * that length exists — `timingSafeEqual` throws on a length mismatch, and the
 * length of a token this module mints is not a secret.
 * @param {unknown} token - The token a request presented
 * @returns {boolean}
 */
function verify(token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  _prune();
  const candidate = Buffer.from(token);
  for (const known of _tokens.keys()) {
    const buf = Buffer.from(known);
    if (buf.length === candidate.length && crypto.timingSafeEqual(buf, candidate)) return true;
  }
  return false;
}

/**
 * Forget every token. For tests, and for a gate that has just been armed: an
 * install that now requires a login has no business honouring tokens it minted
 * while it did not.
 * @returns {void}
 */
function reset() {
  _tokens.clear();
}

/**
 * How many tokens are held right now, expired ones excluded.
 * @returns {number}
 */
function size() {
  _prune();
  return _tokens.size;
}

module.exports = { mint, verify, reset, size, TOKEN_TTL_MS, MAX_TOKENS };
