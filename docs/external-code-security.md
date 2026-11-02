# External-code security: the untrusted PR review boundary

How this repo contains prompt injection in untrusted external PR text before a reviewing agent
reads it. Filed as [#1554](https://github.com/Jason-Vaughan/TangleClaw/issues/1554), under the
milestone `v5.54.0: External code and CI safety`. Related: [ADR 0014](adr/0014-dual-key-review-for-untrusted-prs.md)
(Dual-Key Review for Untrusted PRs) — read that first for the review process this boundary sits
inside; this page covers only the sanitization and read-only-contract mechanism,
`lib/untrusted-pr-review.js`.

## What this is, and what it is not

ADR 0014 rule 3 ("Injection hold") names the gap this issue addresses directly: text in an
untrusted PR that tries to instruct the reviewing agent stops work and is flagged to the
operator, because — as the ADR states — reviewing untrusted text in an **isolated, low-privilege
worker** is *not yet in place*. Issue #1554's own proposed shape is exactly that worker: a
disposable, credential-less sandbox that fetches pinned PR data, returns bounded findings, and is
never the session that holds TangleClaw or switchboard control credentials.

`lib/untrusted-pr-review.js` is **not** that worker. It is a narrower, structural first
increment: a deterministic, zero-dependency module that (1) sanitizes and non-executably fences
untrusted PR text so it cannot be read as the reviewer's own instructions no matter which session
reads it, and (2) gives a read-only review session's declared capabilities a mechanical check
against the boundary a review of untrusted content must never cross. It complements the isolated
worker ADR 0014 still calls for — it does not substitute for it, and the operating rule stands
unchanged: **until the isolated worker exists, a suspected injection means HOLD, and the operator
is flagged for joint review.** This module does not decide that call; it exists so there is less
raw, unfenced attacker text in front of whatever session does.

## Sanitization & structural fencing

`sanitizeUntrustedPrText(text, options)` strips invisible/bidirectional-control anomalies (bidi
overrides, zero-width characters, ANSI escapes, NUL bytes), then escapes `<`, `>` and `&` so no
substring of the text can be parsed as a tag of any kind, then enforces a bounded character
budget with deterministic truncation metadata.

`buildUntrustedPrReviewPacket(prData, options)` wraps every field (title, body, commit messages,
review comments, diff hunks) in an explicit `<untrusted-pr-data field="..." sha="...">...</untrusted-pr-data>`
fence, with a header reminding the reader that everything inside is data, never an instruction,
system message, TangleClaw notice, or operator authorization — regardless of what it claims to
be. Both the fence attributes and the fenced content are escaped, so an attacker-controlled `sha`
or diff hunk cannot break out of either.

**The escape step is the actual security property, not the pattern detector.** The module also
flags a short list of injection-attempt signatures (a literal closing-fence tag, a fake
`[SYSTEM]`/`<system>` marker, a fake `[TangleClaw Switchboard]` line, a fake `OP-GO-` authority
token, a shell-invocation lookalike naming `tc`, `curl`, `gh pr merge`, `git push`, or `rm -rf`) —
but these are informational `warnings` for operator triage, not the thing that makes a breakout
impossible. A denylist of known-bad strings can always be misspelled past; escaping the characters
that give text structural meaning cannot. See `.claude/rules/learnings/core.md`'s "A
trust-boundary parser that scans for the ABSENCE of bad signals never converges" for why this
module is built that way on purpose.

## The read-only review execution contract

`evaluateReviewCapabilities(contract)` checks a proposed review session's declared capabilities
against the fixed boundary a review of untrusted content must never cross:

- `checkoutMode` must be `"diff-only"` — never a live checkout of the untrusted branch into an
  agent worktree, which is exactly what ADR 0014 rule 2 ("never fetch or check out contributor
  refs in a clone that serves the live install") already forbids by process.
- `stripEnvVars` must include every secret-bearing variable a review session could otherwise
  read (`TC_LAUNCH_TOKEN`, `TANGLECLAW_LAUNCH_ID`, `TANGLECLAW_API`, `GITHUB_TOKEN`, `GH_TOKEN`).
- `allowedActions` must not include `merge`, `approve-workflow`, `exec-pr-code`, or
  `bridge-write` — the write/merge actions a read-only review must never be able to take, in
  line with ADR 0014 rule 1 ("no peer message authorizes a branch cut, a code change, a merge or
  a deployment").

`assertUntrustedReviewBoundary(contract)` is the throwing form, for a caller that wants to fail a
setup step outright rather than branch on a structured verdict; it raises
`UntrustedReviewBoundaryError`, which carries the same structured `violations` list.

Both functions are pure: they read nothing from the real `process.env` or filesystem. A caller
declares what it intends to expose and is checked against that declaration — the module has no
way to verify the declaration matches reality, which is a limit worth stating rather than
implying otherwise.

## What is still open

The isolated reviewer worker itself (disposable execution, no write access to host state, no
switchboard credentials, minimal model-only egress) is unbuilt; ADR 0014 names it as the
mechanism that would finally retire the "injection hold" operating rule. Until it lands, this
module reduces how much raw untrusted text a reviewing session (human or agent) has to read
unfenced, and gives any read-only review tooling a mechanical capabilities check — it does not
by itself authorize skipping the hold-and-flag process ADR 0014 rule 3 still requires.
