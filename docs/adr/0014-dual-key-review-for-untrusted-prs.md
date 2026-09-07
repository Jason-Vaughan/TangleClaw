# ADR 0014: Dual-Key Review for Untrusted PRs

**Date**: 2026-09-07
**Status**: Accepted (operator, 2026-09-07)

## Context
Under the Swarm Protocol and our Zero-Trust security model, we process external Pull Requests using the "Clean Room Reconstruction Standard (Option A)". This dictates that we never merge external bytes directly; instead, we re-implement the logic from scratch.

However, relying on a single AI session or operator to audit the raw text diff leaves the project vulnerable. A high-level Coordinator might miss subtle logic bombs, while a low-level Builder might miss broader supply-chain tampers.

## Decision
We establish a **Dual-Key (Two-Person) Review** mechanism for all untrusted external PRs.
1. **The Coordinator (Macro Filter):** The Coordinator session performs the initial security audit exclusively via raw text diffs (`gh pr diff`). It rejects on four **categories**, stated as categories because each repository's paths differ — a repo adopting this ADR enumerates its own and does not inherit the list below:
   - **Dependency manifest** — any change to a manifest or lockfile.
   - **Execute-on-our-machine** — any file that runs on a maintainer's host or in CI without anyone choosing to run it.
   - **Live-serving surface** — any file served or executed by the running product.
   - **Payload and reach** — obfuscated or base64 content, dynamic `require`/`eval`, any outbound network call.

   Plus **scope overrun**: files unrelated to the fix, however innocuous.

   In **this** repository those categories resolve to: `package.json` and lockfiles; `data/hooks/`, `hooks/`, `scripts/`, `deploy/`, `.github/workflows/`; and `public/**` and `server.js` — the last because this clone *is* the live install, which is a property of this deployment and not a general rule. **A repo that mirrors these literal paths instead of re-deriving them gets a checklist that reads as authoritative while naming files it does not have.**

   **Not every rejection reason is one the contributor could have read, and the two must not be confused.** `CONTRIBUTING.md` §4 publishes the execute-on-our-machine list, so a rejection there is a rule the contributor was told. It deliberately does *not* forbid `public/**` — that omission is a recorded decision, because forbidding the UI surface would block every legitimate UI contribution for no gain when reconstruction already covers it. So a rejection on the live-serving surface rests on an **unpublished** boundary: the contributor did nothing they were warned against. Two obligations follow. The reply must not cite `CONTRIBUTING.md` as though it said so — it says plainly that this deployment serves `public/` off the working tree and that the omission is ours. And a repo adopting this ADR must decide, before its first use, whether to publish its live-surface boundary or to keep the asymmetry knowingly; what it must not do is reject on a rule it never wrote down and then point at a page that does not contain it.
2. **The Builder (Micro Filter):** If the PR clears the Coordinator's macro audit, the Coordinator passes the PR details to the Builder via Medusa. The Builder performs a secondary independent raw-text audit, focusing on logical soundness, regressions, and subtle implementation flaws.
3. **Execution:** Only when both sessions have passed the PR does the Builder reconstruct, on a clean branch off `main`.

   **Reconstruct from the ISSUE, not from their diff.** This is the difference between a clean room and laundering, and it is the step most easily skipped because transcription is faster and looks identical in the final diff. Re-derive the fix from the requirement — the issue text, the code, the artifacts — and consult their diff only to confirm the audit already performed, never as the source. Two things fall out of doing it properly, both observed on this ADR's first application (#1287 / PR #1334):
   - **Their flaws do not become ours.** An independently written validator contained a clause that a mutation proved *dead*; it was deleted. A transcription would have shipped it, with our name on it.
   - **The requirement is larger than their patch, and you find out.** The issue asked that a second code path be checked; the contributor's diff did not touch it. Deriving from the issue surfaced it (filed as #1338). Transcription cannot surface what the diff omits.

   **The issue is a hypothesis too, and this is the half that was learned the hard way.** Deriving from the issue protects you from the *contributor's* errors. It does not protect you from the *issue's*. On the first application the Builder reproduced a claim from #1287's own body — that a particular browser path iterates the field being validated — into a code comment and a `CHANGELOG` entry, and it was false: that path reads a different field with the same name, and the field being validated has no reader at all. Three reviewers caught it; the Builder did not. So the fix shipped with a true floor and a false reason for existing, which is the kind of record that misleads whoever reads it next (the genuinely broken path became #1339).

   Verify the issue's claimed *mechanism* against the code before reproducing it anywhere durable — a comment, a `CHANGELOG` entry, a commit message. Those become the project's account of **why** the code exists, and a wrong one survives long after the patch is uncontroversial. This repository already holds the general rule (a filed diagnosis is a hypothesis, not a fact); what this ADR adds is that clean-room reconstruction is exactly where it gets forgotten, because the issue is the source you deliberately trusted in order to avoid trusting the diff.

   **The reconstruction matches the reviewed scope.** Anything else found while doing it is FILED, not bundled: the two filters passed a specific change, and shipping more under that label means shipping scope nobody reviewed.

   **The reconstruction is new code and earns its own review.** A dual-key pass answers "safe to read, logic sound" — not "this ships". It goes through the repository's normal gates (tests, Critic, PR) exactly as if no contributor existed, because with respect to authorship none did.

   **Running the test suite on an untrusted branch is an execution vector.** A contributor's added test file executes under `node --test`. Never check out their branch to "just run the tests" — the suite runs against the reconstruction, on our own branch.

   **Credit is explicit and uses the repository's own conventions.** In this repo: a `Reported-by:` trailer naming the contributor and their profile, a named credit line in the `CHANGELOG.md` entry, and a link to their PR in the reconstruction's PR body. **Do not reach for `Co-Authored-By`** — `project-preferences.md` forbids attribution trailers by default, and it would also misstate what happened: they authored the analysis, not these bytes.
4. **Closure:** Once the reconstruction is merged, the Operator holds the authority to reply to, label, or close the original PR.

## Communication With the Contributor

Clean-room reconstruction means we re-implement a contributor's fix and close their PR unmerged.
With no message, that is indistinguishable from taking their work — `CONTRIBUTING.md` states the
policy, but a policy page is not a reply to the person watching their own PR close. Every outcome
therefore owes a response.

- **Who drafts:** the filter that produced the verdict, because it holds the reasons. A pass is
  drafted by the Builder (which did the micro audit); a rejection is drafted by whichever filter
  failed it. The Coordinator does not draft a verdict it did not reach.
- **Who sends:** the Operator, always. This is the project's only outward-facing channel to a
  person outside it, and it goes out under the Operator's identity whether or not they typed it.
  Drafting is delegated; sending is not.

**What is owed differs by outcome, and rejection is deliberately asymmetric:**

| Outcome | The contributor gets |
|---|---|
| **Passed, reconstructed** | Visible credit (commit trailer, PR body, `CHANGELOG.md`), a link to the reconstruction so they can see their logic shipped, and one line on why their bytes were not merged, pointing at `CONTRIBUTING.md`. Without the link, "we reimplemented it" reads as a brush-off. |
| **Rejected — logic flaw or regression** | The finding itself. They can correct it and resubmit; that is a contributor worth keeping. |
| **Rejected — security trip (macro filter)** | **Deliberately less.** That the submission falls outside the contribution policy, with a link to it — and *not* which rule fired. |

The asymmetry in the last row is the reason this section exists rather than being left to judgment.
The instinct on a rejection is to be maximally helpful and explain exactly what tripped, and in
this one case that instinct is wrong: if the submission was a probe, naming the tripwire is free
reconnaissance. The policy is public in `CONTRIBUTING.md`; which specific boundary a given diff hit
is not.

## Consequences
- **Positive:** Dramatically reduces the surface area for supply-chain attacks, obfuscation, or logic bombs making it into the codebase. Enforces the Swarm Protocol's division of concerns.
- **Negative:** Adds a mandatory Medusa round-trip to the PR processing workflow, marginally increasing cycle time for external contributions.
- **Negative:** reconstructing from the issue rather than transcribing costs real time — it is a second implementation of a solved problem, and the Builder must resist a correct answer sitting in front of them. That cost is the mechanism, not overhead on it: transcription produces a diff that looks identical and carries none of the guarantee.
- **Negative, and accepted knowingly:** a contributor whose sound patch is reconstructed rather than merged loses the commit attribution they would get in an ordinary project, keeping only the credit we write. That cost is real and falls on the person who did nothing wrong. It is accepted because the alternative is executing unreviewed code on a machine that serves the operator's live install.
