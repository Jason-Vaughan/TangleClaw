'use strict';

/**
 * What the Claude Code SessionStart prime hook prints, composed in Node.
 *
 * `data/hooks/sessionstart-prime-claude.sh` prints more than the prime. On
 * every fire it follows the prime with the UI wrap advisory, and on a `/clear`
 * or compaction fire it puts the re-entry preamble ahead of it. The engine caps
 * the hook's whole output (`capabilities.startupInjection.maxChars`); over the
 * cap, it injects a short preview instead, and the session starts without its
 * prime. So the prime is budgeted against the cap MINUS everything else the
 * hook prints, and this module is the one place that knows what that is.
 *
 * The framing here mirrors the script byte for byte, and
 * `test/prime-hook-output.test.js` runs the real script against these
 * functions, so the two cannot drift apart unnoticed.
 *
 * The companion files' CONTENT is defined here too, including their provenance
 * line (ADR 0019): the writers and the budget both read it from this module, so
 * what is written and what is reserved come from one calculation.
 *
 * @module lib/prime-hook-output
 */

const provenance = require('./provenance');
const { renderReentryPreamble } = require('./session-reentry');

/** What the script prints between a companion and the prime: `echo ""; echo "---"; echo ""`. */
const SEPARATOR = '\n---\n\n';

/** The UI wrap capability note written beside the engine config on every sync. */
const UI_WRAP_ADVISORY_TEXT = `**Platform Capability: UI Wrap**
TangleClaw provides a "Session Wrap" UI button. At a chunk-close or stopping place, intelligently decide whether to recommend \`/clear\` or "UI Wrap":
- Recommend **UI Wrap** if the work represents a completed milestone, requires a version bump, needs changelog entries, or needs a continuity record.
- Recommend **\`/clear\`** if you just need to drop context mid-task (e.g., memory is getting full) but aren't ready to run the full wrap protocol.
When signaling the stopping place, explicitly state which one the operator should use and why.`;

/**
 * The advisory file's content for a project, provenance line included.
 *
 * @param {{config?: object, project?: string, engine?: string}} ctx - As for `provenance.applyProvenance`.
 * @returns {string}
 */
function renderAdvisoryFile(ctx = {}) {
  return provenance.applyProvenance('ui-wrap-advisory', UI_WRAP_ADVISORY_TEXT, ctx);
}

/**
 * The re-entry preamble file's content for a project, provenance line included.
 *
 * @param {{name: string}} project - The project record.
 * @param {{config?: object, project?: string, engine?: string}} ctx - As for `provenance.applyProvenance`.
 * @returns {string}
 */
function renderReentryFile(project, ctx = {}) {
  return provenance.applyProvenance('session-reentry', renderReentryPreamble(project), ctx);
}

/**
 * Exactly what the hook prints for one fire, given the three files' contents.
 * A file passed as null is one the hook would find absent.
 *
 * Mirrors the script's conditions: the re-entry preamble only on a `clear` or
 * `compact` fire and only when the prime file exists too; the advisory whenever
 * it exists.
 *
 * @param {{source?: string, reentry?: string|null, prime?: string|null, advisory?: string|null}} files
 * @returns {string}
 */
function composeHookOutput({ source = 'startup', reentry = null, prime = null, advisory = null } = {}) {
  let out = '';
  if ((source === 'clear' || source === 'compact') && prime !== null && reentry !== null) {
    out += reentry + SEPARATOR;
  }
  if (prime !== null) out += prime;
  if (advisory !== null) out += SEPARATOR + advisory;
  return out;
}

/**
 * The characters the hook prints besides the prime, in its worst case: a
 * `/clear` or compaction fire, which prints both companions.
 *
 * @param {{name: string}} project - The project record.
 * @param {{config?: object, project?: string, engine?: string}} ctx - As for `provenance.applyProvenance`.
 * @returns {number}
 */
function companionOverhead(project, ctx = {}) {
  return composeHookOutput({
    source: 'clear',
    reentry: renderReentryFile(project, ctx),
    prime: '',
    advisory: renderAdvisoryFile(ctx)
  }).length;
}

/**
 * How many characters the prime must leave free inside the hook's cap: the
 * companions, plus the provenance line written into the prime file itself.
 *
 * @param {{name: string}} project - The project record.
 * @param {{config?: object, project?: string, engine?: string}} ctx - As for `provenance.applyProvenance`.
 * @returns {number}
 */
function primeReserve(project, ctx = {}) {
  return companionOverhead(project, ctx) + provenance.lineOverhead('session-prime', ctx);
}

module.exports = {
  SEPARATOR,
  UI_WRAP_ADVISORY_TEXT,
  renderAdvisoryFile,
  renderReentryFile,
  composeHookOutput,
  companionOverhead,
  primeReserve
};
