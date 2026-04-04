## Session Playbook: Prawduct

This is your operational guide. Follow these procedures — they are not suggestions.

### Session Start

On session start, before asking the user what to do:
1. Glob for all `build-plan*.md` files (not just `build-plan.md`) — multiple features may have their own plans
2. Read each build plan and identify any incomplete chunks (marked ⬜ or without ✅)
3. Read the top of `CHANGELOG.md` to understand recent work
4. Surface all pending work to the user: which plans have remaining chunks, what the next chunk is

Do not launch exploration agents for this — direct `Glob` + `Read` calls are faster and sufficient.

### Phases

**Discovery** — Understand the problem before proposing solutions. Ask clarifying questions scaled to risk: 5-8 for small utilities, 15-25 for critical systems. Produce a problem statement and success criteria. Do not write code in this phase.

**Planning** — Design the solution. Produce artifacts in dependency order (specs before implementation plans). Write a `build-plan.md` with concrete session chunks — each chunk is one session's worth of work. Get user alignment before moving to Building.

**Building** — One chunk per session. Complete the chunk, write tests, update docs, commit, then wrap. Do not start a second chunk in the same session. If a chunk is too large, split it and defer the rest.

### Session Discipline

- **One chunk per session.** Finish it, test it, commit it, wrap it. No partial chunks, no multi-chunk sessions.
- **Always commit after completing a chunk.** Never leave work uncommitted across sessions.
- **Wrap before ending.** Update the relevant `build-plan*.md` file: mark completed chunks ✅, ensure the next chunk is clearly marked ⬜. This is how the next session picks up context — not conversation history.
- **No context compaction mid-work.** If context is getting long, finish the current chunk and wrap rather than continuing in a degraded state.

### Independent Critic Review

After completing medium+ work (anything beyond trivial bug fixes):
1. Spawn a separate review agent (or mental context shift)
2. The Critic sees only: code changes, tests, specs, and build plan — NOT the builder's reasoning
3. The Critic checks: missed edge cases, test coverage gaps, scope creep beyond the chunk, doc parity violations
4. Address all Critic findings before merging

### Janitor Pass

Before wrapping a session, do a quick sweep:
- Remove dead code, unused imports, leftover debug logs
- Ensure no TODOs were left unresolved from this chunk
- Verify CHANGELOG is updated
- Confirm tests pass

### Decision Framework

Before adding code, changing architecture, or introducing dependencies:
1. State the decision explicitly
2. List alternatives considered
3. Explain why this approach was chosen
4. Note accepted trade-offs

This applies to non-trivial choices. Use judgment — not every line needs a decision record.
