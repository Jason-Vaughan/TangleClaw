'use strict';

/**
 * Shared path-token matcher (CON-8H3Z).
 *
 * The continuity Map (`lib/continuity.js`) and the features-toc wrap step
 * (`lib/wrap-steps/features-toc.js`) both pull path-like tokens out of arbitrary
 * markdown, and their extension allowlists MUST stay in sync — a file type
 * recognized by one but not the other would silently drift the Map's coverage
 * from FEATURES.md's. Before this module each carried a character-identical
 * copy of the regex; this is now the single source for the allowlist.
 *
 * The matcher is deliberately loose on the anchor — it matches inside backticks,
 * free text, link targets, and comments. The trailing `(?:\b|:)` lets a `:42`
 * line ref register the path without the colon entering the captured group
 * (group 1 is the path).
 *
 * @module lib/path-tokens
 */

/**
 * File extensions the path-token matcher recognizes. Kept as a named array so
 * the allowlist is greppable and testable independently of the compiled regex —
 * adding a type here updates every consumer at once.
 * @type {string[]}
 */
const PATH_TOKEN_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'json', 'md', 'html', 'css', 'yaml', 'yml', 'sh'];

/**
 * Build a FRESH stateful (global, case-insensitive) path-token regex. Consumers
 * reset `.lastIndex` and drive `.exec()` in a loop; returning a new instance per
 * call keeps each consumer's iteration state isolated, so a shared instance's
 * `lastIndex` can never leak across modules. The captured group 1 is the path.
 * @returns {RegExp}
 */
function makePathTokenRegex() {
  return new RegExp(`([A-Za-z0-9_./-]+\\.(?:${PATH_TOKEN_EXTENSIONS.join('|')}))(?:\\b|:)`, 'gi');
}

module.exports = { makePathTokenRegex, PATH_TOKEN_EXTENSIONS };
