'use strict';

/**
 * The context re-entry preamble (#1761).
 *
 * Claude Code re-fires SessionStart with `source: clear` or `compact` when
 * `/clear` or a compaction drops a running session's context. The prime hook
 * then puts this text ahead of the prime, so the session gets its identity and
 * rules back AND is told that this is not a new launch: the prime's opening
 * instructions (banner, `tc start next`, resume proposal) were for the start of
 * the session and must not run again mid-way through its work.
 *
 * It must stand on its own. Every matching hook runs in parallel, so where the
 * rules shards' output lands relative to this text is not something it can
 * know; it never points "below" or at "the rules that follow", and names the
 * commands that re-read the rules instead.
 *
 * Pure and store-free, so it can be tested without a launch.
 *
 * @module lib/session-reentry
 */

/**
 * Render the re-entry preamble for a project.
 * @param {{name: string}} project - The project the session belongs to
 * @returns {string} Markdown, ending in a newline
 */
function renderReentryPreamble(project) {
  const name = project && project.name ? project.name : 'this project';
  return [
    `# Context re-entry — ${name}`,
    '',
    'This session\'s context was just cleared (`/clear`) or compacted. This is a context re-entry into a '
      + '**running** session, **not a new launch**.',
    '',
    '- **The launch prime\'s opening instructions do not apply now.** Do not re-emit its banner line, do not '
      + 'restart the launch sequence, and do not re-emit a resume proposal.',
    '- **Re-read before acting.** Run `tc start status`. If it shows READY, re-read the launch context you '
      + 'attested with `tc start review`: it is read-only, so do not re-attest. If it shows steps still '
      + 'unacknowledged, finish them with `tc start next`. If it reports no launch sequence, your context '
      + 'came in the prime alone, and `tc rules` re-reads the project rules.',
    `- **Everything this session was given still binds:** its identity and ownership of **${name}**, its scope `
      + 'guard, the operator\'s project rules and every confirmation gate. `tc rules` re-reads the project '
      + 'rules; `tc start review` re-reads them as attested, with the rest of the launch context.',
    '- **Resume the work in flight, not the launch handoff.** Take it from the forward notes '
      + '(`.prawduct/.handoff-notes.md` where the project is governed) and the operator\'s latest instruction. '
      + 'The launch handoff\'s "next action" describes where the session started, and the work has moved since.',
    ''
  ].join('\n');
}

module.exports = { renderReentryPreamble };
