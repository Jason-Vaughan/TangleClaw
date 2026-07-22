'use strict';

/**
 * Shared "is this a source file?" classifier for wrap steps (#659).
 *
 * Two wrap steps need the same notion of a source file — as opposed to vendored
 * code, build output, hidden/bookkeeping state, or a high-churn root doc:
 *
 *   - `features-toc` asks "is this path worth an index stub?" (its original home
 *     for this logic, #207).
 *   - `changelog-coverage` asks "is this dirty path *work* that must be logged, or
 *     the bookkeeping a wrap routinely dirties?" — the discriminator that lets the
 *     gate flag uncommitted work without re-blocking compliant sessions the way the
 *     reverted #645 "any dirty file" rule did.
 *
 * Both are the same question, so the answer lives in ONE place. The leading-dot
 * segment rule is load-bearing for the second caller: it excludes `.prawduct/…`
 * and `.tangleclaw/…` bookkeeping without either needing to be enumerated as a
 * prefix.
 *
 * @module lib/wrap-steps/_source-paths
 */

const path = require('node:path');

/**
 * Extension allowlist — narrow to source-ish files. Future widening belongs in
 * this constant only, and both callers inherit it.
 */
const INDEXABLE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx',
  '.json', '.md', '.html', '.css',
  '.yaml', '.yml', '.sh'
]);

/**
 * Paths whose names match an indexable extension but whose change rate makes them
 * poor source signals (a root changelog/readme/index changes on nearly every
 * session). Matched against the basename. `CHANGELOG.md` is excluded here so the
 * changelog file itself is never counted as unlogged *work* by the coverage gate —
 * its own maintenance is judged by the gate's other routes.
 */
const EXCLUDED_BASENAMES = new Set([
  'CHANGELOG.md',
  'README.md',
  'FEATURES.md'
]);

/**
 * Prefix exclusions — applied to the full relative path. Anything rooted under one
 * of these is not a source file (vendored, build output, git internals, TC state).
 */
const EXCLUDED_PREFIXES = [
  'node_modules/',
  'dist/',
  'coverage/',
  'build/',
  '.git/',
  '.tangleclaw/'
];

/**
 * Decide whether a relative path is a source file. Applies the extension
 * allowlist, prefix exclusions, basename exclusions, and a leading-dot-segment
 * exclusion (top-level dotfiles + any path with a hidden directory in its chain,
 * e.g. `.prawduct/change-log.md` or `foo/.cache/bar.js`).
 *
 * @param {string} relativePath
 * @returns {boolean}
 */
function isSourceFile(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return false;
  for (const prefix of EXCLUDED_PREFIXES) {
    if (relativePath.startsWith(prefix)) return false;
  }
  // Any leading-dot segment signals hidden / bookkeeping content — exclude
  // defensively. This is what keeps `.prawduct/` and `.tangleclaw/` out for the
  // coverage gate without enumerating every such directory.
  for (const segment of relativePath.split('/')) {
    if (segment.startsWith('.') && segment.length > 1) return false;
  }
  const ext = path.extname(relativePath).toLowerCase();
  if (!INDEXABLE_EXTENSIONS.has(ext)) return false;
  const base = path.basename(relativePath);
  if (EXCLUDED_BASENAMES.has(base)) return false;
  return true;
}

module.exports = {
  INDEXABLE_EXTENSIONS,
  EXCLUDED_BASENAMES,
  EXCLUDED_PREFIXES,
  isSourceFile
};
