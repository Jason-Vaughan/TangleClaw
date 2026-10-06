<!-- prawduct: version=3.5.0 | archived=2026-09-19 -->

## Wrap prompt compression (#1617, PR #1620)

Delivered: the four standard ai-content wrap prompts and the conditional
index prompt rewritten as instructions rather than explanations —
1,664 → 1,310 words across the four, 442 → 381 for the index prompt at a
both-modes render. No contract moved.

What the Critic caught that I did not:

- The one instruction the change ADDED (consult the project config for
  CHANGELOG subsections beyond the standard six) was unpinned. Everything
  else in the diff was subtraction, so I had been thinking about the change
  as "can't break anything" — but a prompt that silently loses an
  instruction produces a worse artifact and no error, which is the failure
  mode the test file's own header describes. Compression work needs a pin
  on whatever it adds, precisely because the rest of the diff is safe.
- One clarity regression in my own compression: learnings-capture step 1
  traded "if it exists … if it does not exist" for "or create it", turning
  a condition into a choice. Shortening conditionals is where compression
  actually costs meaning; the other four prompts survived intact.

What surprised me: the biggest finding of the session was not in the diff
at all. The first Critic pass reviewed the working tree, which held only
TangleClaw's generated CLAUDE.md drift from this being a second checkout —
and traced it to a real bug (#1619): the wrap classifies a managed-block-only
diff on a TRACKED carrier as maintenance and commits it unasked. I had
noticed the drift and excluded it from the commit, and stopped there. The
Critic asked the next question — what happens at the next wrap — which is
the one that mattered.

Also worth remembering: a 22% cut was the honest answer here, not a
disappointing one. These templates were mostly instruction already; the
compressible mass was history and source paths, and there was no more to
take without losing contract.


---

<!-- prawduct: version=3.5.0 | archived=2026-09-20 -->

## #1628 — status-row provenance for the codex readiness gate (2026-09-19)

**Delivered.** Readiness for an engine that declares `idleMarkerRow` is read from
the status row only — the capture's last non-empty line, matched as a whole
space-delimited segment — instead of `includes()` over the whole tail. One
exported `readReadiness` owns the choice, so the wake monitor and the launch
readiness gate cannot drift. Four fail-closed refusals replace one
undifferentiated `not-at-rest`. Codex's marker re-measured against 0.155.1 in two
disposable probes; confinement is opt-in so claude and antigravity are untouched.
Committed as c2c66c7, unpushed by instruction.

**What the Critic caught, in order, and what each one taught.**

*Round 1, blocking:* the launch gate's new branch shipped untested — the existing
readiness suite only ran engines on the branch I had NOT changed, so it was green
regardless. The lesson is not "write more tests": it is that a suite covering a
function is not a suite covering the branch you added to it, and the only way to
know is to name which arm each existing case takes.

*Round 1, best catch:* my profile guard ACCEPTED two combinations that silently
disabled the feature — `idleMarkerRow` with a null `idleMarker` fell through to
the most permissive reading. I had validated each field and never the
combination. A guard that fails open is worse than no guard, because the profile
now asserts a confinement it does not have.

*Round 2, blocking:* the refusals I added in round 1 shipped untested, in the one
suite that pins every sibling rule. A fix for a review finding is new code and
carries the same obligation as the original; I treated it as a patch instead.

**The recurring shape across all three.** Every blocking finding was the same
error: I verified the thing I wrote and not the boundary around it. Not one was a
wrong idea — they were untested edges of right ideas.

**Two of my own artifacts had gone false while I wrote them.** The changelog
headline claimed the truncated operator gets their mail, which they do not until
they reorder their status line; and a JSDoc clause stopped being true inside the
same round that an extraction changed it. Durable prose decays fastest while the
code under it is still moving.

**Surprise worth carrying.** The defect had two opposite faces from one cause,
and the incident report had only ever seen one. The false idle was discoverable
only because the pane happened to be displaying prose ABOUT the marker — i.e.
discussing the bug could trigger it. Where a gate matches free text over a whole
capture, the text a session is reading is part of its input.

## Handoff close — #1628 transferred to Builder1 (2026-09-19)

**What the peer review caught that three Critic rounds did not.** The Critic
found untested branches and a fail-open guard. Builder1 found something
different in kind: a wrong SAFETY CLAIM, in a tracked file, that I had
*independently corroborated*. It raised a rollout hazard, I verified "both
sides" and agreed, and we were both wrong the same way — we reasoned correctly
about what `includes()` would do and neither of us asked whether it RUNS. The
old validator rejects unknown fields, so codex never enters the wake table and
that line is unreachable.

**A correct inference from a false premise is the dangerous shape**, because it
survives review by anyone checking the reasoning instead of the premise. Two
builders agreeing made it worse, not better — corroboration of an unchecked
premise is not evidence.

**The lesson that generalises: verify the premise, not just the inference.**
When I finally checked, I ran the old validator over the new profile rather than
reading the code and reasoning about it. Execution beat inspection, again.

**Second instance, same session, same class.** The Architect caught me reporting
`104x41` as a capture's geometry when only the WIDTH was provable from the
bytes; the height came from a separate later reading I had silently equated with
file metadata. In a document whose entire purpose is separating measured from
reasoned, that is the same error as the one Builder1 had just caught.

**What I did right and would repeat:** re-derived Builder1's retraction instead
of accepting it, kept both retractions VISIBLE in the files rather than editing
them away, and declined to add a code comment I agreed with because it would
have broken the "code untouched since a7a8efc" property a reviewer had just
verified mechanically. Saying why I declined beat silently complying or silently
not.
