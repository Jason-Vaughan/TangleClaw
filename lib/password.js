'use strict';

// One owner for TangleClaw's own password hashing (ADR 0015).
//
// TangleClaw has TWO password mechanisms and they are not interchangeable —
// confusing them on the auth path is the reason this module is named for the
// algorithm it is not:
//
//   - `caddy.hashPassword` produces a BCRYPT hash by shelling out to
//     `caddy hash-password`. It is what the Caddy `basic_auth` gate reads, and
//     it has no verify mode — which is exactly why TangleClaw cannot check a
//     password it stores today (`server.js`: "What authenticates this request is
//     that Caddy already did").
//   - this module produces a SCRYPT hash from Node's standard library, which
//     TangleClaw can both write and verify. It is what TangleClaw's own front
//     door uses.
//
// A scrypt hash will never validate against Caddy and a bcrypt hash will never
// validate here. That is the migration ADR 0015 describes, not a bug.
//
// The primitives lived in `lib/projects.js`, guarding project deletion, and were
// moved here when the front door made them shared. A second copy of a hash
// function is a security defect rather than a tidiness one: the two drift, and
// the surface that gets the weaker copy is the one nobody was watching.

const crypto = require('node:crypto');

// Stored format is `salt:hash`, both hex. Kept as-is because it is already
// persisted in `config.deletePassword` on every live install, so changing it
// would be a migration that buys nothing.
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * Hash a password using scrypt with a random per-password salt.
 * @param {string} password - Plaintext password
 * @returns {string} - Format: salt:hash (both hex-encoded)
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_BYTES).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a stored `salt:hash` value.
 *
 * Returns false for anything malformed rather than throwing. That is the whole
 * reason the length check exists: `crypto.timingSafeEqual` THROWS on unequal
 * buffer lengths, and `Buffer.from(str, 'hex')` silently truncates at the first
 * invalid pair — so a corrupt, truncated or hand-edited stored value produced a
 * RangeError instead of a `false`. On a delete-confirmation prompt that is a
 * 500; on the login route it is a crash serving a malformed row. Comparing
 * lengths first leaks nothing: the length of a stored hash is not the secret,
 * and for a well-formed value it is the constant 64 bytes.
 *
 * @param {string} password - Plaintext password to verify
 * @param {string} stored - Stored hash in salt:hash format
 * @returns {boolean} - true only on a well-formed match
 */
function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  if (typeof stored !== 'string' || typeof password !== 'string') return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const derived = crypto.scryptSync(password, salt, KEY_BYTES);
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

module.exports = { hashPassword, verifyPassword, SALT_BYTES, KEY_BYTES };
