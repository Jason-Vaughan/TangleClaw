## Session Memory

TangleClaw provides a file-based memory system that persists context across AI sessions. Each project has a `.tangleclaw/memories/` directory where you can store and retrieve memories.

### How It Works

- **Index file**: `.tangleclaw/memories/MEMORY.md` — read this at session start to restore context
- **Additional files**: Create topic-specific `.md` files in the same directory (e.g., `ARCHITECTURE.md`, `DECISIONS.md`)
- `MEMORY.md` serves as the index — it should reference any additional memory files

### At Session Start

Read `.tangleclaw/memories/MEMORY.md`. Use it to understand prior decisions, progress, open questions, and anything the previous session flagged for you.

### At Session End

Before wrapping, update memory files with anything the next session should know:
- Key decisions made and why
- Progress on multi-session work
- Open questions or blockers
- Architecture notes or patterns discovered

### Conventions

- Keep entries concise and actionable
- Use markdown headings to organize by topic
- Don't duplicate what's already in code, git history, docs, or changelogs
- Remove or update stale entries — memories should reflect current state
- Memory files are plain markdown — no special syntax required
