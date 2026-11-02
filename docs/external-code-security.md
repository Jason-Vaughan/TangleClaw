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
or diff hunk cannot break out of either. When the assembled packet would exceed `totalCharBudget`,
it is cut at a whole-fence boundary — never mid-tag — and the header is never dropped to make room:
a `totalCharBudget` too small to hold both the header and a truncation marker throws `RangeError`
rather than ever shipping a packet missing its safety framing (Round 2/3). An array field
(`commitMessages`, `reviewComments`, `diffHunks`) is additionally bounded by a hard element-count
ceiling (`maxArrayItems`, default 50) independent of the character budget, charged by each
element's full fenced length rather than its sanitized text alone — otherwise an array of
thousands of empty or near-empty elements would still be iterated in full before a budget keyed
only on text length ever noticed (Round 3).

**The escape step is the actual security property, not the pattern detector.** The module also
flags a short list of injection-attempt signatures (a literal closing-fence tag, a fake
`[SYSTEM]`/`<system>` marker, a fake `[TangleClaw Switchboard]` line, a fake `OP-GO-` authority
token, a shell-invocation lookalike naming `tc`, `curl`, `gh pr merge`, `git push`, or `rm -rf`) —
but these are informational `warnings` for operator triage, not the thing that makes a breakout
impossible. A denylist of known-bad strings can always be misspelled past; escaping the characters
that give text structural meaning cannot. See `.claude/rules/learnings/core.md`'s "A
trust-boundary parser that scans for the ABSENCE of bad signals never converges" for why this
module is built that way on purpose.

**WARNING — escaping closes a structural gap, not a semantic one.** Escaping `<`, `>` and `&`
guarantees that no substring of untrusted text can be parsed as a tag: it cannot splice content
out of its fence, close the fence early, or open a fake one, however it is spelled. It makes no
claim about, and cannot prevent, a reviewer being influenced by the ORDINARY-LANGUAGE CONTENT
inside a still-intact fence — persuasive, authoritative-sounding, or urgent-sounding prose needs
no tag-shaped character at all to attempt that, and no escaping step touches it. That is exactly
why the fence is paired with the read-only review execution contract below (and, since Round 2,
`buildIsolatedReviewWorkerSpec`'s isolated, diff-only worker invocation spec): the fence keeps the
data structurally inert, and the contract keeps whatever reads it unable to act on what it reads,
however persuasive. Neither half substitutes for the other.

## The read-only review execution contract

`evaluateReviewCapabilities(contract)` checks a proposed review session's declared capabilities
against the fixed boundary a review of untrusted content must never cross:

- `checkoutMode` must be `"diff-only"` — never a live checkout of the untrusted branch into an
  agent worktree, which is exactly what ADR 0014 rule 2 ("never fetch or check out contributor
  refs in a clone that serves the live install") already forbids by process.
- `stripEnvVars` must include every secret-bearing variable a review session could otherwise
  read (`TC_LAUNCH_TOKEN`, `TANGLECLAW_LAUNCH_ID`, `TANGLECLAW_API`, `GITHUB_TOKEN`, `GH_TOKEN`).
- `allowedActions` must be an array, and every entry must be in the read-only **allowlist**
  (`ALLOWED_READ_ONLY_ACTIONS`: `read-diff`, `emit-review`, `read-packet`) — not merely absent
  from a denylist of specifically named dangerous actions (Round 3). A denylist (`FORBIDDEN_ACTIONS`:
  `merge`, `approve-workflow`, `exec-pr-code`, `bridge-write`) is kept alongside it for its precise
  per-action violation code, in line with ADR 0014 rule 1 ("no peer message authorizes a branch
  cut, a code change, a merge or a deployment") — but the allowlist is what actually decides
  admission, so an action this module has never named (`write-files`, `shell`, anything not yet
  invented) is rejected by default rather than passed through for merely not matching a known-bad
  name.

`assertUntrustedReviewBoundary(contract)` is the throwing form, for a caller that wants to fail a
setup step outright rather than branch on a structured verdict; it raises
`UntrustedReviewBoundaryError`, which carries the same structured `violations` list.

Both functions are pure: they read nothing from the real `process.env` or filesystem. A caller
declares what it intends to expose and is checked against that declaration — the module has no
way to verify the declaration matches reality, which is a limit worth stating rather than
implying otherwise.

## Isolated reviewer worker invocation spec

`buildIsolatedReviewWorkerSpec(packet, options)` assembles the concrete invocation spec for the
isolated reviewer worker ADR 0014 and issue #1554 call for: `checkoutMode: "diff-only"`,
credential-stripped (`stripEnvVars` always includes `REQUIRED_STRIPPED_ENV_VARS`, plus any
caller-supplied `extraStripEnvVars`), `allowedActions: ["read-diff", "emit-review"]` by default,
`readOnlyFilesystem: true`, and the already-fenced `packet` a caller built with
`buildUntrustedPrReviewPacket`. It validates the spec it assembles against
`assertUntrustedReviewBoundary` before returning it, so a caller never receives a spec that
itself violates the boundary.

**`packet` itself is validated, not merely passed through (Round 3).** `buildIsolatedReviewWorkerSpec`
throws `TypeError` unless `packet` carries the canonical safety header and every
`<untrusted-pr-data>` fence in it is balanced — the same structural shape
`buildUntrustedPrReviewPacket` always produces. This is a sanity check, not a guarantee of origin
(nothing stops a caller from handing in a string merely shaped like a packet), but it catches the
mistake this function exists to prevent: handing the isolated worker raw, unfenced attacker text
under the assurance that it has already been sanitized and fenced.

This is the SPEC for the worker, not the worker: nothing here spawns a process, a container, or
any execution environment. It gives whatever eventually runs the isolated worker a concrete,
already-validated invocation contract to launch it with, deterministically, from pure data.

## What is still open

The isolated reviewer worker's EXECUTION — an actual disposable process or container that runs
with no write access to host state, no switchboard credentials, and minimal model-only egress —
is unbuilt. `buildIsolatedReviewWorkerSpec` above gives it a concrete, pre-validated invocation
spec to launch with once it exists, but nothing in this module spawns, sandboxes, or runs
anything. ADR 0014 names the worker's execution as the mechanism that would finally retire the
"injection hold" operating rule. Until it lands, this module reduces how much raw untrusted text a
reviewing session (human or agent) has to read unfenced, and gives any read-only review tooling a
mechanical capabilities check — it does not by itself authorize skipping the hold-and-flag process
ADR 0014 rule 3 still requires.
