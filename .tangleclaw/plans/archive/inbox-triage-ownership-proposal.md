# Proposal: the Coordinator owns the GitHub inbox check

**Status:** APPLIED 2026-09-16 (Builder rule #6 replaced; Coordinator rule #30 added). Originally PROPOSED 2026-09-16. The Coordinator ACCEPTED it on 2026-09-16 with no edits to Draft B, and
its `gh -R` test passed. After that, the Builder amended both drafts (see "Amendments after
acceptance"), and the Coordinator accepted those too, on 2026-09-16. The text below is final. Waiting on the operator to approve and make
the rule edits. Nothing is changed until then. Both rules below are operator-owned, and the operator
makes the edits.

## Why

Builder rule #6 makes the Builder check GitHub's open issues and PRs at session start and rank them.
Ranking new reports against the roadmap is sequencing, and sequencing is the Coordinator's job. The
Builder can list what arrived, but it cannot say where an item fits among the trains. Some of the
follow-up still needs this repo's code: checking a report's claimed cause against the code, and
handling an outside PR under ADR 0014. That part stays with the Builder.

## Division of work

| Work | Owner |
|---|---|
| Check open issues and PRs; rank outside reporters first; note how long each has waited | Coordinator |
| Decide an item's milestone or train, or whether it jumps the queue | Coordinator (operator ratifies) |
| Send issue numbers to the Builder over the switchboard | Coordinator |
| Check a report's claimed cause against the code | Builder |
| Handle an outside PR (ADR 0014: read the diff without running it, rebuild from the issue) | Builder |
| Check that an issue is still open before starting its chunk (rule #9, unchanged) | Builder |
| Reply to, label, close or merge on GitHub | Operator, always |
| Fallback inbox check when the Coordinator is not running | Builder |

## Draft A: replaces Builder rule #6 (project 14)

> GITHUB INBOX: THE COORDINATOR CHECKS IT, AND THE BUILDER HANDLES WHAT IT IS SENT. TangleClaw has
> installers other than the operator, so GitHub is a support queue, not just a backlog. The
> TangleClaw-Coordinator session checks the inbox and ranks new items, and sends the Builder any
> issue or PR that needs code work over the switchboard.
>
> At session start, check the switchboard roster
> (`GET /api/sessions/TangleClaw-Builder/medusa/roster`). If the workspace named
> `tangleclaw-coordinator` is listed with `connected: true`, do not repeat its check; say in one line
> that the Coordinator owns the inbox. If it is missing or not connected, check the inbox yourself so
> outside reports do not wait unseen:
>
>     gh issue list --state open --limit 30 --json number,title,labels,author,createdAt,updatedAt
>     gh pr list --state open --json number,title,author,isDraft,reviewDecision
>
> Surface anything authored by someone other than the repo owner first, with how long it has waited.
> Then send what you found to `tangleclaw-coordinator` over the switchboard; it will be read when that
> session next runs.
>
> When the Coordinator sends an issue: treat its stated cause as a guess, and check it against the
> code before repeating it anywhere.
>
> Report and recommend; do not act outward unprompted. Replying to, labelling, closing, or merging
> someone else's issue or PR is the operator's call: ask first, then do it. Filing a NEW issue
> follows the normal Issues rule (search for a duplicate first).
>
> AN EXTERNAL PULL REQUEST IS NEVER MERGED. It is rebuilt from scratch without reusing the
> contributor's code. Read `docs/adr/0014-dual-key-review-for-untrusted-prs.md` in full the moment one
> is sent to you or you find one, and follow it. This rule only points you to the ADR; it does not
> summarise it.
>
> The three things that get lost without the ADR in front of you:
> - Read the diff with `gh pr diff`, never `gh pr checkout`. Do not run the suite on their branch: a
>   contributor's added test file executes under `node --test`, which is the execution vector the
>   whole policy exists to close.
> - Rebuild from the ISSUE, not from their diff. Copying their code into the rebuild defeats the
>   point of rebuilding. And the issue's stated cause is only a guess: check it against the code
>   before repeating it in a comment, a CHANGELOG entry or a commit message, because those become the
>   project's record of WHY the code exists.
> - Credit them (a `Reported-by:` trailer, a named CHANGELOG line, their PR linked from the rebuild)
>   and file anything found that falls outside the reviewed scope rather than bundling it.
>
> Closing their PR and replying to them stay the operator's call, but draft the reply and say it is
> ready, because closing silently after shipping someone's analysis is what this rule guards against.

## Draft B: new Coordinator rule (project 74)

> CHECK TANGLECLAW'S GITHUB INBOX AT SESSION START, AND AGAIN BEFORE RECOMMENDING WHAT TO DO NEXT.
> TangleClaw has installers other than the operator, so its GitHub is a support queue. This session can
> stay open for days, so one check at session start is not enough: check again whenever you are about
> to recommend sequencing or send the Builder new work. Pass the repo explicitly, because this session
> does not run in its clone:
>
>     gh issue list -R Jason-Vaughan/TangleClaw --state open --limit 30 --json number,title,labels,author,createdAt,updatedAt
>     gh pr list -R Jason-Vaughan/TangleClaw --state open --json number,title,author,isDraft,reviewDecision
>
> Surface the findings in your opening summary without being asked, newest first. Anything authored by
> someone OTHER than the repo owner ranks highest: it is a real install failing in a way the
> developer's own machine cannot reproduce. Say plainly how long each one has waited. When nothing
> new has arrived, say so in one line.
>
> For each new item, propose where it goes: a milestone, a train, or a jump in the queue. The
> operator ratifies. Send the Builder only the issue numbers that need code work, over the switchboard.
>
> Read only: do not run a contributor's code and do not check out their branch. An external PR is
> never merged. Send it to the Builder, which rebuilds it under ADR 0014. Replying to, labelling,
> closing, or merging anything on GitHub is the operator's call.

## Amendments after acceptance (2026-09-16, Builder)

1. **Draft A: the Coordinator's name.** The roster lists the Coordinator's workspace as lowercase
   `tangleclaw-coordinator` (checked live), so the draft now uses that exact name, together with
   `connected: true`.
2. **Draft A: where fallback findings go.** "Tell the Coordinator when it next comes up" was vague;
   the draft now sends them over the switchboard.
3. **Draft B: when the Coordinator checks.** The Coordinator session can stay open for days, so a
   check only at session start would go stale. It now also checks before recommending what to do
   next or sending the Builder work.
