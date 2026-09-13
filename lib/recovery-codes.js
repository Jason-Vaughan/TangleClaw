'use strict';

// One-time recovery codes for TangleClaw's own login (#1420, ADR 0016 "The ruling").
//
// A code lets whoever holds it set a new password for one account from off the
// machine, the way a 2FA backup code does. That makes each one a way past the
// password, so everything here is about keeping a code worth exactly one
// password reset to exactly its holder:
//
//   - long enough that guessing is not an attack (125 bits of CSPRNG output);
//   - stored only as a digest, so a database read hands nobody a code;
//   - forgiving of how a person retypes it from paper, and of nothing else.
//
// Pure functions plus one in-memory limiter. The store owns the rows and
// `server.js` owns the route; neither re-implements anything below.

const crypto = require('node:crypto');

// Crockford base32: no I, L, O or U, so a code read off paper cannot be
// mistyped as a different valid one, and it never spells a word by accident.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters in one code: 25 × 5 bits = 125 bits of entropy. */
const CODE_LENGTH = 25;

/** Characters per displayed group. */
const GROUP_LENGTH = 5;

/** Codes issued per account per generation. */
const CODES_PER_SET = 8;

/**
 * Generate one code as its canonical 25-character string.
 *
 * Built from rejection-free bytes: 256 is divisible by 32, so `byte % 32` (the
 * low five bits) is uniform and no character is likelier than another.
 *
 * @returns {string}
 */
function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

/**
 * Generate a full set of distinct codes.
 * @param {number} [count] - Defaults to {@link CODES_PER_SET}
 * @returns {string[]} Canonical codes
 */
function generateSet(count = CODES_PER_SET) {
  const codes = new Set();
  while (codes.size < count) codes.add(generateCode());
  return [...codes];
}

/**
 * Reduce what a person typed to the canonical code, or null if it cannot be one.
 *
 * Accepts the forms a code really arrives in — lower case, the display hyphens,
 * spaces a phone inserts, and Crockford's look-alikes (`O`→`0`, `I`/`L`→`1`) —
 * and nothing else. A string that is not exactly 25 alphabet characters after
 * that is refused here, before it costs a database read.
 *
 * @param {unknown} input
 * @returns {string|null}
 */
function normalizeCode(input) {
  if (typeof input !== 'string' || input.length > 200) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return s;
}

/**
 * Format a canonical code for display: `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`.
 * @param {string} code - Canonical code
 * @returns {string}
 */
function formatCode(code) {
  const groups = [];
  for (let i = 0; i < code.length; i += GROUP_LENGTH) groups.push(code.slice(i, i + GROUP_LENGTH));
  return groups.join('-');
}

/**
 * The digest a code is stored and looked up under.
 *
 * SHA-256 with no salt, for the reason `auth-session#hashToken` gives: the input
 * is CSPRNG output, so there is no dictionary to stretch against, and a salt
 * would only prevent the indexed lookup. That lookup is also what makes a wrong
 * code and a used one indistinguishable — both are "no unused row under this
 * digest", one query, one answer.
 *
 * @param {string} canonical - A code already passed through {@link normalizeCode}
 * @returns {string} Hex digest
 */
function hashCode(canonical) {
  return crypto.createHash('sha256').update(String(canonical)).digest('hex');
}

/**
 * Which client a failed redemption is counted against.
 *
 * The socket address, except when the request came through the reverse proxy on
 * loopback: every such request shares Caddy's address, so the client is Caddy's
 * `X-Forwarded-For`. Caddy REPLACES a value the client sent (verified on v2.11.4,
 * ADR 0016 "Recorded during #1420 A-02a"), so it names the real peer. A request
 * carrying the header on a NON-loopback socket did not come through Caddy, and
 * its header is the client's own claim, so the socket is used.
 *
 * The last entry is taken, because a proxy appends the peer it saw. A forwarded
 * header with no address in it names nobody, so the socket is used.
 *
 * "Came through the proxy" is `lib/auth-identity.js#cameThroughProxy`, the one
 * spelling of that check, asked rather than re-read here.
 *
 * @param {{ remoteAddress?: string }|null|undefined} socket
 * @param {object} headers - `req.headers`
 * @param {(addr: string|undefined) => boolean} isLoopback
 * @returns {{ key: string, address: string, proxied: boolean }} `key` for the
 *   limiter; `address` the client it names; `proxied` when that address came
 *   from the proxy's header rather than the socket.
 */
function clientKey(socket, headers, isLoopback) {
  // Required on use: `lib/store.js` requires this module, and `auth-identity`
  // reaches `store` through `auth-gate` and `caddy`, so a top-level require here
  // would hand `caddy` a half-built store.
  const { cameThroughProxy } = require('./auth-identity');
  const addr = socket && typeof socket.remoteAddress === 'string' ? socket.remoteAddress : '';
  if (cameThroughProxy(headers) && isLoopback(addr)) {
    const parts = String(headers['x-forwarded-for']).split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      const address = parts[parts.length - 1];
      return { key: `xff:${address}`, address, proxied: true };
    }
  }
  return { key: `sock:${addr}`, address: addr, proxied: false };
}

/**
 * A fixed-window counter of FAILED attempts per client.
 *
 * Only failures count, so the operator redeeming a real code is never slowed by
 * their own success. Per client, not global, so one flood cannot lock everyone
 * out of recovery. Bounded: when the map is full, expired windows are pruned,
 * and if it is still full the oldest entry is evicted — the cost of an attacker
 * cycling addresses is that some of their counters reset, which the code's
 * entropy makes irrelevant; the cost of NOT bounding it is unbounded memory on a
 * route anyone can reach.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxFailures] - Failures allowed per window
 * @param {number} [opts.windowMs] - Window length
 * @param {number} [opts.maxClients] - Map bound
 * @param {() => number} [opts.now] - Clock, injectable for tests
 * @returns {{ isLimited: (key: string) => boolean, recordFailure: (key: string) => void,
 *   size: () => number, reset: () => void }}
 */
function createFailureLimiter({ maxFailures = 10, windowMs = 15 * 60 * 1000, maxClients = 1000,
  now = Date.now } = {}) {
  const entries = new Map();

  /**
   * The live entry for a key, dropping it if its window has passed.
   * @param {string} key
   * @returns {{ count: number, start: number }|null}
   */
  function live(key) {
    const e = entries.get(key);
    if (!e) return null;
    if (now() - e.start >= windowMs) {
      entries.delete(key);
      return null;
    }
    return e;
  }

  return {
    /**
     * Whether a client has used up its failures for this window.
     * @param {string} key
     * @returns {boolean}
     */
    isLimited(key) {
      const e = live(key);
      return !!e && e.count >= maxFailures;
    },
    /**
     * Count one failure against a client.
     * @param {string} key
     */
    recordFailure(key) {
      const e = live(key);
      if (e) {
        e.count += 1;
        return;
      }
      if (entries.size >= maxClients) {
        for (const k of [...entries.keys()]) live(k);
        if (entries.size >= maxClients) entries.delete(entries.keys().next().value);
      }
      entries.set(key, { count: 1, start: now() });
    },
    /** @returns {number} Tracked clients */
    size() { return entries.size; },
    /** Forget every client. */
    reset() { entries.clear(); }
  };
}

module.exports = {
  ALPHABET,
  CODE_LENGTH,
  CODES_PER_SET,
  generateCode,
  generateSet,
  normalizeCode,
  formatCode,
  hashCode,
  clientKey,
  createFailureLimiter
};
