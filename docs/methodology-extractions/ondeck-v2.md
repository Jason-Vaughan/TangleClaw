# OnDeck-V2 Methodology Extraction

Extracted from OnDeck-V2's governance files. This project uses a "Minimal" TangleClaw methodology but developed real structural patterns on top of it. Only patterns that are genuinely novel (not AI default behavior, not already covered by TiLT v2 extraction) are documented here.

## Source Files

| File | Lines | Role |
|------|-------|------|
| `docs/ai-config/shared-rules.md` | ~425 | Single source of truth for all AI rules |
| `.claude/CLAUDE.md` | ~878 | Generated from shared-rules.md |
| `.cursor/rules/shared-rules.mdc` | generated | Generated from shared-rules.md |
| `scripts/sync-ai-config.js` | — | Sync script |
| `next_session_priming.md` | — | Session planning file |
| `Progress_log.md` | — | Session history |

## Pattern 1: Critical Incidents Log

**What it does:** A structured table inside the governance file that documents failures, their cost, and the prevention rule each one spawned. Makes the methodology's evolution traceable — you can see *why* every rule exists.

**Why this is unique:** AI agents naturally suggest fixes when things break. They don't naturally build a persistent log linking failures to rule changes. Without this structure, the *why* behind each rule disappears into git history. The log keeps scar tissue visible.

**Format:**

```markdown
| Date | Incident | Time/Cost | Root Cause | Prevention Rule Added |
|------|----------|-----------|------------|----------------------|
| Dec 2025 | Config drift between Cursor/Claude | 2 hours | Manual maintenance of two files | Created sync system (npm run sync-ai-config) |
```

**Trigger criteria:** Bugs, fixes taking >30 minutes, data loss, repeated errors.

**Evidence it works:** The Dec 2025 config drift incident (2 hours wasted) produced the AI config sync system — a real infrastructure change committed as `0bae9df` (16 files, 2,138 insertions). The incident log made this traceable.

**What a template needs:**
- Incidents table with mandatory columns (date, incident, cost, root cause, rule added)
- Trigger threshold (configurable — e.g., >30 min, any data loss)
- Location: inside the governance file, not a separate doc (keeps it visible)
- Session wrap step: "any incidents this session?" before closing

## Pattern 2: AI Config Sync System

**What it does:** A single markdown file (`docs/ai-config/shared-rules.md`) serves as the source of truth for all AI engine rules. A sync script (`npm run sync-ai-config`) programmatically generates engine-specific config files (`.cursor/rules/shared-rules.mdc` and `.claude/CLAUDE.md`) from that source.

**Why this is unique:** Most projects maintain engine configs independently and they drift. TiLT v2 has ~1,095 lines of Cursor rules and ~278 lines of CLAUDE.md that overlap but aren't synchronized. OnDeck solved this with tooling — one file, one script, zero drift.

**How it works:**
1. Edit `docs/ai-config/shared-rules.md` (the source of truth)
2. Run `npm run sync-ai-config`
3. Script generates `.cursor/rules/shared-rules.mdc` and `.claude/CLAUDE.md`
4. Engine-specific sections (e.g., `.cursor/rules/rule-every-chat.mdc`) remain untouched

**Born from:** The Dec 2025 config drift incident (see Pattern 1). Two hours lost because Cursor and Claude Code had different rules. Incident → prevention rule → infrastructure.

**Relationship to TangleClaw:** TangleClaw already does this at the platform level — it generates engine-native config from methodology rules. OnDeck built the same concept independently at the project level before TangleClaw's engine abstraction existed. This validates TangleClaw's approach.

**What a template needs:**
- This pattern is largely solved by TangleClaw's engine abstraction layer
- For TangleMeth: the *principle* (single source of truth for rules) should be a default, not optional
- Projects that predate TangleClaw may need a migration path from project-level sync to TangleClaw-managed config

## Pattern 3: Session Priming Files

**What it does:** Two files with strict discipline around session boundaries:

- **`next_session_priming.md`** — Updated as the *last* step of every session wrap. Contains exactly one main task focus for the next session. Fixed headers, only content changes between sessions.
- **`Progress_log.md`** — Historical record of completed work only. No TODOs. Timestamp must match the session wrap.

**Why this is unique:** TiLT v2 has session wraps with handoff notes, but the priming file is a separate, dedicated artifact with structural rules:
- Timestamp verification required on session start (proves it was updated last session)
- `-MID-SESSION` suffix convention for incomplete sessions
- One main task focus (prevents scope creep across session boundaries)

**How it differs from TiLT's learning sentry:**
- Learning sentry = growing log of insights (accumulates)
- Session priming = single-use planning doc (replaced each session)
- They solve different problems: institutional memory vs session focus

**What a template needs:**
- Session priming file template (configurable sections)
- Timestamp verification rule (warn if priming file is stale)
- "One main task" constraint (on/off — some projects need multi-task sessions)
- Progress log convention (completed work only, no TODOs)
- Mid-session suffix convention for interrupted sessions

---

## Patterns Evaluated and Excluded

| Pattern | Reason for exclusion |
|---------|---------------------|
| Self-improvement directive | AI default behavior given a name — not a structural contribution |
| Compute cost optimization | Interesting but project-specific (Cursor vs Claude Code decision tree). Too tied to specific tooling to generalize. |
| Service management rules | Ops documentation, not methodology |
| Database-backed task management | Good practice but not a methodology pattern — it's a project feature |
| Slash commands (.claude/commands/) | Claude Code built-in feature, not a methodology innovation |

## Observations for TangleMeth

1. **Incidents → rules is the strongest pattern here.** It's a feedback loop: something breaks, it gets logged with cost, a prevention rule gets added, and the log entry links them. This is how real methodologies should evolve — from failures, not from upfront design.

2. **OnDeck independently built what TangleClaw does.** The config sync system validates TangleClaw's engine abstraction approach. When TangleMeth interviews users, it should check if they already have project-level sync tooling and offer to migrate it.

3. **Session priming is complementary to session wraps.** Wraps capture what happened. Priming captures what's next. TiLT has wraps but not priming. A complete methodology template should offer both.
