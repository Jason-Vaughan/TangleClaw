'use strict';

/**
 * Role-scoped TangleClaw operating primers (#2070 Slice 1, Architect Ruling
 * A2070).
 *
 * "Know everything about TangleClaw" does not mean pasting the whole manual
 * into every prompt. It means: a compact, role-appropriate subset of the
 * verb roster, composed from `lib/tc-verbs.js#VERB_ROSTER` itself rather than
 * hand-written prose that can drift from it -- the same "one structured
 * schema as executable truth" `docs/tc-cli-reference.md` (#2299) already
 * holds for the full roster. {@link buildOperatingPrimer} fails loudly if a
 * role names a verb the roster no longer has, so a renamed or removed verb
 * cannot leave a primer silently stale.
 *
 * Slice 2 (#2835) is the AI documentation router and the repo-wide Markdown
 * manifest; this file's own scope is the compact primer and the role subsets
 * it is built from, not the full reference (that is
 * `docs/tc-cli-reference.md`, already shipped).
 *
 * @module lib/operating-primer
 */

const { VERB_ROSTER } = require('./tc-verbs');

/**
 * Which verb ids each role's primer carries, in the order they are printed.
 * Every id here must exist in `VERB_ROSTER` -- {@link buildOperatingPrimer}
 * checks this at build time, not silently.
 * @type {Readonly<Record<string, string[]>>}
 */
const ROLE_VERB_IDS = Object.freeze({
  // A Builder lane: identity, launch onboarding, switchboard, workload
  // reporting, HOLD/STOP, branch safety, and retiring itself when done.
  // Never `rotation` -- a worker is never the coordinator role that runs it.
  worker: ['help', 'whoami', 'capabilities', 'start', 'message', 'workload', 'control', 'branch', 'finalize'],
  // A reviewer lane: the same identity/launch/switchboard/workload/control
  // surfaces as a worker, minus branch safety and finalize -- a reviewer
  // does not retire sessions or judge its own branch.
  reviewer: ['help', 'whoami', 'capabilities', 'start', 'message', 'workload', 'control'],
  // An appointed Architect/PM coordinator: everything a worker has, plus
  // managed rotation -- the one verb this role alone is expected to run.
  coordinator: ['help', 'whoami', 'capabilities', 'start', 'message', 'workload', 'control', 'rotation', 'branch', 'finalize'],
  // The Project Master: fleet-wide session visibility and the operator
  // bridge, not a single lane's own onboarding/workload verbs.
  master: ['help', 'whoami', 'capabilities', 'sessions', 'message', 'bridge', 'control', 'ports']
});

/**
 * The one fact every role's primer states the same way, in the roster's own
 * words (`docs/tc-cli-reference.md`'s "Keeping this page true" section is
 * the fuller, generated-from-the-same-roster reference).
 * @type {string}
 */
const START_NEXT_VS_REVIEW_NOTE = 'New or unattested launch: `tc start next`. '
  + 'Already-attested session after `/clear` or compaction: `tc start review`.';

/**
 * The sandbox note the issue's own acceptance criteria names explicitly,
 * matching `bin/tc`'s real `API_UNREACHABLE_FROM_CONTEXT` error text so the
 * primer never carries a paraphrase the real error can drift away from.
 * @type {string}
 */
const SANDBOX_UNREACHABLE_NOTE = 'An API-unreachable result (exit 2, `API_UNREACHABLE_FROM_CONTEXT`) is not proof '
  + 'the TangleClaw server is down -- a managed sandbox can block localhost even while the host service is '
  + 'healthy. Say so and stop; do not report an outage from this alone.';

/**
 * Build one role's compact operating primer, composed from `VERB_ROSTER`.
 * @param {'worker'|'reviewer'|'coordinator'|'master'} role
 * @returns {string} Markdown text, one trailing newline
 * @throws {Error} When `role` is not one {@link ROLE_VERB_IDS} names, or that
 *   role names a verb id `VERB_ROSTER` no longer has -- a stale role list is
 *   a build-time failure, never a silently thinner primer.
 */
function buildOperatingPrimer(role) {
  const ids = ROLE_VERB_IDS[role];
  if (!ids) {
    throw new Error(`buildOperatingPrimer: unknown role "${role}" (expected one of: ${Object.keys(ROLE_VERB_IDS).join(', ')})`);
  }
  const lines = [`# TangleClaw operating primer -- ${role}`, ''];
  lines.push(START_NEXT_VS_REVIEW_NOTE, '');
  lines.push(SANDBOX_UNREACHABLE_NOTE, '');
  lines.push('## Verbs', '');
  for (const id of ids) {
    const entry = VERB_ROSTER.find((v) => v.id === id);
    if (!entry) {
      throw new Error(`buildOperatingPrimer: role "${role}" names "${id}", which is no longer in VERB_ROSTER -- update ROLE_VERB_IDS`);
    }
    lines.push(`- \`${entry.usage}\` -- ${entry.summary}`);
  }
  lines.push('', 'Full reference: `docs/tc-cli-reference.md`. Machine-readable manifest: `tc help --json`.');
  return lines.join('\n') + '\n';
}

module.exports = {
  ROLE_VERB_IDS,
  START_NEXT_VS_REVIEW_NOTE,
  SANDBOX_UNREACHABLE_NOTE,
  buildOperatingPrimer
};
