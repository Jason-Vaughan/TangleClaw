'use strict';

/**
 * Shared redaction for the text `git` and `gh` print when a REMOTE operation
 * fails.
 *
 * That text is the one class of wrap-step output that can carry a credential.
 * `git push` echoes the remote it could not reach, and a remote can be
 * `https://<token>@host` — the exact form GitHub's own PAT-over-HTTPS
 * instructions tell people to configure. So every string built from the stderr
 * of a remote-touching command is a potential secret until it has been through
 * here.
 *
 * **The redaction belongs to the producer, not the sink.** This module exists
 * because the alternative was tried: one recorder applied the redaction and the
 * log line thirty-five lines above it did not, so the same string reached
 * `~/.tangleclaw/logs/tangleclaw.log` in the clear. `observability-strategy.md`
 * § Direction states the rule this file implements — "a producer of text that
 * can embed a secret owns the redaction; a reporter may add a pass but must
 * never be the only one." Call this where the string is BUILT; then a sink
 * added later inherits the guarantee instead of having to remember it.
 *
 * Scope is deliberately narrow: remote-touching commands only. Local `git`
 * (`status`, `add`, `checkout`, `commit`, `rev-parse`) reaches no network and
 * carries no credential, and routing it through here would say these strings
 * are equally dangerous when they are not.
 */

const secretScan = require('../secret-scan');

/**
 * Longest remote error text any caller keeps. A wrap result and a database row
 * are diagnostics, not archives — the first line is what anyone reads, and the
 * tables holding this text have no retention policy, so an unbounded remote
 * error grows storage with text nobody looks at.
 */
const MAX_CHARS = 200;

/**
 * Redact and bound the output of a failed remote `git`/`gh` command.
 *
 * Three steps, in an order that matters:
 *
 * 1. **Strip `//<userinfo>@`** — with or without a colon. Requiring a colon
 *    would miss `https://<token>@host`, the password-less form and the most
 *    likely credential of all. The pattern cannot run past the authority: a
 *    URL with no credential has no `@` before its first `/`, and userinfo
 *    cannot contain `/`, whitespace or a second `@`, so the rest of the line
 *    is never eaten. It DOES erase a harmless userinfo too — `ssh://git@host`
 *    becomes `//***@host`. That is the intended trade: the host and the error
 *    text carry the diagnostic value, and preserving a username is not worth
 *    narrowing a pattern until it misses a token.
 * 2. **Scan what is left**, and replace it wholesale on a hit — a truncated
 *    secret is still a secret. `scanText` returns pattern *types* and never
 *    values, so naming the types keeps the result diagnostic without
 *    persisting what it found. This is the backstop for credentials that do
 *    not arrive as URL userinfo; it is not a substitute for step 1, whose
 *    `user:password@` and `gho_`/`ghs_`/GitLab/Bitbucket forms match no
 *    pattern the scanner knows.
 * 3. **Cap the length, last.** A size bound is not a redaction, and applying
 *    it first would let a secret be truncated into something the scanner no
 *    longer recognises while still leaking its prefix.
 *
 * @param {string|null|undefined} text - Raw `git`/`gh` output, or null
 * @returns {string|null} Redacted, bounded text; null for any non-string
 */
function redactRemoteOutput(text) {
  if (typeof text !== 'string') return null;
  const deurled = text.replace(/\/\/[^/\s@]+@/g, '//***@');
  const scan = secretScan.scanText(deurled);
  if (scan.flagged) {
    return `[redacted — ${scan.types.join(', ')} detected in remote error output]`;
  }
  return deurled.length > MAX_CHARS ? `${deurled.slice(0, MAX_CHARS)}…` : deurled;
}

/**
 * Build a step's `reason` from a failed remote command's result, redacted.
 *
 * Three call sites assembled `(stderr || stdout || 'exit N').trim()` and capped
 * it by hand, identically. Keeping the assembly here means the fallback chain
 * and the redaction cannot drift apart per site — and a caller cannot reach the
 * raw text by accident, which is how the missed sink happened.
 *
 * @param {{stderr?: string, stdout?: string, exitCode?: number}} res - Exec result
 * @returns {string} Redacted, bounded reason text
 */
function reasonFromFailure(res) {
  const raw = ((res && res.stderr) || (res && res.stdout) || `exit ${res ? res.exitCode : 'unknown'}`).trim();
  return redactRemoteOutput(raw);
}

module.exports = { redactRemoteOutput, reasonFromFailure, MAX_CHARS };
