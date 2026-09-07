# ADR 0014: Dual-Key Review for Untrusted PRs

**Date**: 2026-09-07
**Status**: Accepted (operator, 2026-09-07)

## Context
Under the Swarm Protocol and our Zero-Trust security model, we process external Pull Requests using the "Clean Room Reconstruction Standard (Option A)". This dictates that we never merge external bytes directly; instead, we re-implement the logic from scratch.

However, relying on a single AI session or operator to audit the raw text diff leaves the project vulnerable. A high-level Coordinator might miss subtle logic bombs, while a low-level Builder might miss broader supply-chain tampers.

## Decision
We establish a **Dual-Key (Two-Person) Review** mechanism for all untrusted external PRs.
1. **The Coordinator (Macro Filter):** The Coordinator session performs the initial security audit exclusively via raw text diffs (`gh pr diff`). It explicitly checks for and rejects:
   - Modifications to `package.json` or lockfiles.
   - Any edits to `data/hooks/`, `hooks/`, `scripts/`, `deploy/`, `.github/workflows/` (execute-on-our-machine category).
   - Any edits to `public/**` or `server.js` (live-serving surface).
   - Obfuscated or base64 payloads, dynamic require/eval, and hidden network requests.
   - Scope overrun (files unrelated to the fix, however innocuous).
2. **The Builder (Micro Filter):** If the PR clears the Coordinator's macro audit, the Coordinator passes the PR details to the Builder via Medusa. The Builder performs a secondary independent raw-text audit, focusing on logical soundness, regressions, and subtle implementation flaws.
3. **Execution:** Only when both sessions have passed the PR does the Builder proceed to manually reconstruct the logic on a clean branch off `main`, crediting the contributor. **Note: Running the test suite on an untrusted branch is an execution vector. Maintainers must never checkout the branch to "just run the tests".**
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
- **Negative, and accepted knowingly:** a contributor whose sound patch is reconstructed rather than merged loses the commit attribution they would get in an ordinary project, keeping only the credit we write. That cost is real and falls on the person who did nothing wrong. It is accepted because the alternative is executing unreviewed code on a machine that serves the operator's live install.
