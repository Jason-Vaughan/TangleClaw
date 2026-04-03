## Session Playbook: Prawduct

This is your operational guide. Follow these procedures — they are not suggestions.

### Phases

**Discovery** — Understand the problem before proposing solutions. Ask clarifying questions scaled to risk: 5-8 for small utilities, 15-25 for critical systems. Produce a problem statement and success criteria. Do not write code in this phase.

**Planning** — Design the solution. Produce artifacts in dependency order (specs before implementation plans). Write a `build-plan.md` with concrete session chunks — each chunk is one session's worth of work. Get user alignment before moving to Building.

**Building** — One chunk per session. Complete the chunk, write tests, update docs, commit, then wrap. Do not start a second chunk in the same session. If a chunk is too large, split it and defer the rest.

### Session Discipline

- **One chunk per session.** Finish it, test it, commit it, wrap it. No partial chunks, no multi-chunk sessions.
- **Always commit after completing a chunk.** Never leave work uncommitted across sessions.
- **Wrap before ending.** Capture summary, next steps, and learnings. The next session reads your wrap to resume context.
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
