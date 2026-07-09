## Session Memory

TangleClaw provides a file-based memory system that persists context across AI sessions. Each project has a `.tangleclaw/memories/` directory.

### How It Works
- **Index**: `.tangleclaw/memories/MEMORY.md` — the entry point; it references any additional memory files.
- **Additional files**: topic-specific `.md` files alongside it (e.g. `ARCHITECTURE.md`, `DECISIONS.md`).

### At Session Start
Read `.tangleclaw/memories/MEMORY.md` to restore prior decisions, progress, open questions, and anything the previous session flagged for you.

### At Session End
Before wrapping, update memory with what the next session needs: key decisions and why, progress on multi-session work, open questions or blockers, and architecture notes or patterns discovered.

### Conventions
- Keep entries concise and actionable; organize by markdown heading.
- Don't duplicate what's already in code, git history, docs, or changelogs.
- Remove or update stale entries — memory should reflect current state.
- Plain markdown, no special syntax required.
