'use strict';

/**
 * The value formats release-candidate certification shares across modules.
 *
 * The state machine, the store, the probes, the published scorecard and the
 * server each validate the same kinds of value. When each kept its own copy of
 * a pattern, the copies drifted. The checkout digest matters most: the server
 * and the runner must compute it identically, or every certification refuses
 * with SERVER_NOT_IN_WORKTREE. So each format has one definition, here.
 *
 * @module lib/release-certification/formats
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

/** A full 40-character lowercase git SHA. */
const SHA_RE = /^[0-9a-f]{40}$/;
/** A sha256 hex digest. */
const DIGEST_RE = /^[0-9a-f]{64}$/;
/** A run id: 128 random bits, minted once by the host at staging. */
const RUN_ID_RE = /^[0-9a-f]{32}$/;
/** Where a run's required-check verdicts come from. */
const CHECKS_SOURCES = Object.freeze(['gh', 'host-attested']);
/** A GitHub `owner/name`. */
const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
/** A short single-line label: no control characters, 1–256 characters. */
const TEXT_RE = /^[^\u0000-\u001f]{1,256}$/;
/** An operator identifier. */
const ACTOR_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
/**
 * Where a manifest's required checks came from: read from main's branch
 * protection, or named by the operator on the command line. Recorded so an
 * auditor can tell a candidate judged by the repository's own rules from one
 * judged by a hand-picked list.
 * @type {readonly string[]}
 */
const REQUIRED_CHECKS_SOURCES = Object.freeze(['branch-protection', 'operator']);

/** Most required checks a manifest may pin. */
const MAX_REQUIRED_CHECKS = 64;

/**
 * Whether a value is a non-negative safe integer.
 * @param {*} n - Value
 * @returns {boolean} True for 0, 1, 2, ...
 */
function isCount(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

/**
 * Whether a list of required checks is valid: 1–64 unique labels. An empty
 * list would let the GitHub judgement pass vacuously.
 * @param {*} checks - Candidate list
 * @returns {boolean} True when valid
 */
function validRequiredChecks(checks) {
  return Array.isArray(checks) && checks.length > 0 && checks.length <= MAX_REQUIRED_CHECKS
    && checks.every((c) => typeof c === 'string' && TEXT_RE.test(c)) && new Set(checks).size === checks.length;
}

/**
 * The identity of a checkout: sha256 of its real path. The server reports
 * this for the tree it runs from, and admission records it for the worktree
 * it certifies; equality proves they are the same tree without disclosing a
 * path.
 * @param {string} dir - Checkout directory
 * @returns {string} Hex digest
 */
function checkoutDigest(dir) {
  return crypto.createHash('sha256').update(fs.realpathSync(dir)).digest('hex');
}

module.exports = {
  SHA_RE,
  DIGEST_RE,
  RUN_ID_RE,
  CHECKS_SOURCES,
  REPO_RE,
  TEXT_RE,
  ACTOR_RE,
  MAX_REQUIRED_CHECKS,
  REQUIRED_CHECKS_SOURCES,
  isCount,
  validRequiredChecks,
  checkoutDigest
};
