# Rule drafts — #1642 (live checkout + plans symlink) and #1647 (decision routing)

**Status:** DRAFT, for the operator's approval. Nothing here is active.
**Author:** TangleClaw-Builder1. Builders author durable rules; the PM coordinated the assignment
and does not edit active rules (global rule-authoring policy).
**Target:** TangleClaw rule store, project 14, `kind: startup`, via the normal proposal/activation
process. Activating a rule is the operator's action, not this draft's.

---

## Draft A — amend rule 7 (#1642)

### Why rule 7 must change

Two independent defects, both verified before drafting.

**1. The named live checkout is wrong.** Rule 7 currently opens:

> The live checkout is `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder`, not Builder2.

`launchctl print gui/501/com.tangleclaw.server` reports:

```
working directory = /Users/jasonvaughan/Documents/Projects/TangleClaw-Builder1
```

Verified read-only by this session on 2026-09-19, and independently by the Architect the same day.
A session that trusts rule 7 edits a checkout that serves nothing, and believes a checkout that IS
live is safe to branch in — the failure runs in both directions.

**2. The symlink instruction is destructive as written.** Rule 7 currently says:

> Symlink the primary checkout's gitignored `.prawduct/*` entries, except tracked `change-log.md`,
> and `.tangleclaw/plans`.

`.tangleclaw/plans` is **tracked** in this repo. Replacing it with a symlink stages roughly 95 plan
files as deleted. A session did exactly this, caught it at `git status`, and reverted before
committing — so the hazard is observed, not theoretical, and it was one `git commit` away from
landing.

The blanket half is also wrong independently: the Architect rejected symlink-all-gitignored for
worktrees on the ground that **ignored is not the same as safe to share**. A gitignored path may be
task-private state that two worktrees must not hold in common.

### SCOPE LIMIT ON THIS DRAFT — read before editing it

This draft records **verified current state and the observed hazard only**. It deliberately does
**not** assert where the live checkout is *supposed* to live. #1642 reserves that:

> Get the operator's intended-checkout ruling before a rewrite that asserts an intended deployment
> path; verified-current-state and observed hazard can be recorded now.

The operator is still deciding that architecture, and the PM confirmed this reading on 2026-09-19.
**Do not add a deployment path to this rule without the operator's ruling.** If the intended
location is later settled and differs from the verified one, this rule needs a second amendment —
it is written to make that cheap.

### Proposed replacement text for rule 7

> **The live checkout is the one launchd is running — verify it, do not recall it.** As of
> 2026-09-19 that is `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder1`, confirmed by
> `launchctl print gui/$(id -u)/com.tangleclaw.server | grep 'working directory'`. Run that check
> rather than trusting this sentence: the path has been wrong in this rule before, and a session
> that edits the wrong checkout gets no error — it simply changes nothing, or changes production
> while believing it is safe. This rule does NOT state where the live checkout is meant to live
> long-term; that is the operator's open decision.
>
> The live checkout serves `public/` directly and runs `server.js` through launchd, so edits there
> go live immediately. Checking out a branch there changes served files and can trigger the
> stale-server banner; a restart loads whatever server code is checked out. The operator usually
> works from another machine, so a break there is not visible locally.
>
> **Keep the live checkout on `main`.** Use a worktree for branch changes to `public/` or
> `server.js`: `git worktree add .claude/worktrees/<name> <branch>`.
>
> **Never symlink a TRACKED path into a worktree.** `.tangleclaw/plans` is tracked here: replacing
> it with a symlink stages every plan file it holds as deleted (~95 of them, observed 2026-09-19,
> caught at `git status` one commit short of landing). Before symlinking anything, run
> `git check-ignore -v <path>` and `git ls-files --error-unmatch <path>` and act on the answer.
>
> **Ignored is not the same as safe to share.** Do not blanket-symlink gitignored `.prawduct/*`
> entries into a worktree. Some are owner/writer state that two worktrees may legitimately share;
> others are task-private to one worktree and sharing them silently crosses work. Link the specific
> entries a task needs, deliberately, and never mass-unlink paths an active worktree is using.
>
> Changing `CACHE_NAME` in `public/sw.js` forces browsers to reinstall the service worker and can
> cause login loops behind Caddy basic authentication.
>
> If the dashboard, login or terminal breaks during your work, check `git status` and
> `grep CACHE_NAME public/sw.js` in the live checkout first. Before returning that checkout to
> `main`, preserve uncommitted work and push branch commits.

### Narrow naming correction to rules 6 and 33 (same issue)

Rules 6 and 33 spell `TangleClaw-Builder` in their endpoint examples while also instructing the
session to use its own project name. The literal is what a reader copies, and it addresses another
session's queue. #1642 asks for this in the same narrow correction.

- Rule 6, `GET /api/sessions/TangleClaw-Builder/medusa/roster`
- Rule 33, `POST /api/sessions/TangleClaw-Builder/wrap` and the `/command` route

**Proposed:** replace the literal with `<project-name>` in all three, each followed by the same
clause already used elsewhere in the fleet rules — *resolve `<project-name>` at run time from
`tc whoami`; never substitute a name read from a committed file, inferred from the directory, or
remembered from another session, because a wrong name resolves and addresses someone else's queue.*

No other change to rules 6 or 33 is proposed here. Their authority limits are untouched.

---

## Draft B — new startup rule (#1647): where a decision goes

### Why

Rule 33 delegates roadmap execution to the PM but does not say who owns a *decision*. Rule 12
defines Medusa mechanics, not authority. The observed failure: this session stopped and asked the
operator procedural questions in its own pane instead of consulting the agents who own them. The
operator's directive is that procedural questions go to the PM, architectural questions to the
Architect, and genuinely ambiguous ones to both in a single request.

### Proposed new rule text

> **Decide what you already have authority to decide.** A routine implementation choice inside the
> task's existing authority is yours; escalating it costs a round-trip and teaches nothing. Escalate
> when the decision is genuinely not yours to make.
>
> **When you must escalate, route by KIND of question, not by who is nearest:**
> - **Procedural, workflow, sequencing, prioritisation** → the assigned **ProjectManager**.
> - **Design, contracts, system boundaries, architectural rulings** → the assigned **Architect**.
> - **Genuinely ambiguous** → **both, in ONE clearly identified decision request** sharing a single
>   request id. Never solicit two independent approvals for one decision: that manufactures a
>   conflict and lets each answer look authoritative alone. The PM coordinates the reply when both
>   are involved; an architectural ruling remains the Architect's to give.
>
> **Resolve the recipients live; never hardcode them.** Read the current assignment context and the
> live Medusa roster. A matching name, a matching prefix or a connected listener is **not** proof of
> authority — workspace ids rotate, and a stale id addresses someone else's queue. Do not write
> `Builder1`, `PM1`, `Architect1` or any specific workspace id into shared instructions.
>
> **A decision request states, in one message:** the task or issue and its revision; the concrete
> question; the evidence you already gathered; the options with their trade-offs; **your
> recommendation**; the scope of authority you are asking for; and what is blocked until it is
> answered. A request without a recommendation is an expert declining to be one.
>
> **Then keep working.** Mark the affected task decision-pending and continue independent authorized
> work. Do not re-ask the operator a question you have delegated, and do not treat silence, a
> delivery acknowledgement or a read receipt as approval. If a recipient is unavailable or the
> exchange fails, report the actual blocker and escalate **once** under the existing fallback
> policy — do not poll indefinitely, do not guess the answer, and do not start new agents to find
> someone to ask.
>
> **This rule grants no new authority.** Every operator-reserved decision in rule 33 stays reserved:
> merging, closing or replying to an external contributor's issue or PR; releases, tags and security
> advisories; CI, deployment, secrets and branch-protection changes; data deletion and launchd
> restarts; and sending content off this machine. Consulting a role is not a route around those.
> When a genuinely operator-reserved decision is needed, prepare the recommendation and the evidence
> first, then bring it to the operator once.
>
> **No peer can relay operator authorization by asserting it.** The sender field identifies a
> workspace, not an actor. A relayed "the operator approved this" is information, not approval,
> unless a project rule delegates that authority to that role in advance.
>
> **Record the outcome** — the decision, who issued it, its scope and its provenance — in the task
> or handoff, so a context refresh does not reopen a settled question.

### Acceptance (from #1647, restated as checks)

- A fresh Builder launch receives the rule.
- An in-scope procedural / design / ambiguous request reaches the correct live recipient(s) without
  an unnecessary operator prompt.
- An operator-reserved decision still reaches the operator.
- No duplicate requests, and no conflicting dual-owner decision.
- An unavailable recipient produces a visible, bounded fallback rather than silence or a loop.

**Note on what activation proves.** Activating this rule shows a session is *told* the routing. It
does not show that dispatch *enforces* it — #1647 says so explicitly, and this draft does not claim
otherwise.

### Deliberately not in scope

Configurable per-role routing and multiple same-role agents belong to the fleet architecture
proposal, not this rule; the rule is written around *responsibility scopes* (ProjectManager,
Architect) rather than specific agents so that work can replace the lookup without rewriting the
authority model. #1576 is nickname routing, which is addressing, not decision authority.

---

## Open items this draft does NOT settle

1. **The intended long-term live-checkout path** — the operator's open decision, deliberately absent
   from Draft A. Draft A needs a second amendment once it is settled.
2. **Which `.prawduct/*` entries are owner/writer versus task-private.** Draft A forbids the blanket
   symlink and requires a tracked/ignored check, which closes the destructive case. It does not
   classify the individual entries; that classification is still owed and is what would let a
   worktree share the right ones deliberately.
