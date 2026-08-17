# Feature Request: Structured Session View (Terminal Abstraction Layer)

## Summary
Introduce a structured UI layer that sits on top of the existing `ttyd`/`tmux` backend, transforming the raw terminal stream into a modern, browser‑native interaction model while preserving full terminal compatibility. The goal is not to replace `tmux` or PTYs, but to treat them as an implementation detail rather than the primary user interface.

## Problem
Traditional terminals expose a continuous byte stream rather than structured content. While `tmux` and `ttyd` provide excellent process persistence and remote access, they inherit the limitations of terminal emulation:
- Difficult text selection
- No concept of prompts vs. responses
- Cannot copy a single AI response
- Cannot delete or archive portions of a conversation
- Poor browser integration (canvas‑based rendering limits native features)
- Difficult search and navigation through long sessions
- Poor support for rich content (Markdown, code blocks, diffs)

The terminal is an excellent transport layer but a poor UI for AI‑centric workflows.

## Proposed Architecture
```
                 AI Agent
                    │
              PTY / TMUX
                    │
      ┌─────────────┴─────────────┐
      │   PTY Capture Service     │
      └─────────────┬─────────────┘
                    │
        Parse ANSI escape sequences
                    │
     Detect prompts / responses / events
                    │
         Convert into structured JSON
                    │
        React/Vue/Svelte Session UI
```
- The PTY remains the authoritative backend.
- The browser interacts primarily with structured session objects instead of raw terminal output.

## Core Concepts
### Session Objects
Represent interactions as discrete JSON objects, e.g.:
```json
{
  "id": "msg-143",
  "role": "assistant",
  "timestamp": "2026-08-05T22:45:12Z",
  "content": "...",
  "tokenUsage": 1842,
  "duration": 14.2,
  "filesChanged": [...],
  "commandsExecuted": [...]
}
```
### Browser‑Native Interaction
Each prompt and response becomes a normal HTML element, enabling:
- Native text selection & copy/paste
- Context menus
- Browser search
- Accessibility improvements
- Responsive layouts

### Response Actions
Support per‑response UI actions such as:
- Copy / Copy Markdown / Copy Code Block
- Delete / Archive
- Collapse / Expand
- Pin / Export / Share
- Bookmark

### Rich Rendering
Render structured content (Markdown, syntax‑highlighted code, tables, images, mermaid diagrams, ANSI colors, clickable links, file diffs, metadata panels).

### Metadata Panel
Expose per‑interaction metadata (model, runtime, token usage, cost, commands executed, files modified, git branch, working directory, session ID, etc.).

### Timeline Navigation
Navigate by interaction rather than terminal scrollback, e.g.:
```
Prompt 14 → Claude Response → Tool Call → Patch Applied → Git Commit → Next Prompt
```
Allow jumping directly between interactions.

### Integrated Terminal
Provide the raw terminal as an optional collapsible panel for compatibility.

## Implementation Strategy
**Phase 1** – Keep `tmux` unchanged, capture PTY output, parse ANSI sequences, render HTML instead of canvas, preserve bidirectional input.
**Phase 2** – Detect prompts/responses automatically, group output into message objects, enable per‑response actions.
**Phase 3** – Add rich Markdown rendering, diff viewer, file previews, search, bookmarks, metadata, session analytics.

## Optional Future Enhancements
- Multi‑agent conversation view
- Side‑by‑side model comparison
- Timeline playback & session branching
- Prompt version history
- AI‑generated summaries
- Semantic search
- Session export/import
- Token & cost visualisations
- Git commit correlation

## Design Philosophy
The terminal becomes infrastructure, not the UI. `tmux` continues to provide persistence, process management, multiplexing, and recovery. The browser becomes responsible for presentation, interaction, rich editing, navigation, search, and session management.

## Benefits
- Native text selection and copy/paste
- Dramatically improved usability for long AI sessions
- Better accessibility and mobile support
- Rich rendering of Markdown and code
- Enables advanced features without modifying the PTY backend
- Preserves compatibility with existing terminal tooling
- Provides a foundation for future AI‑native workflow features

## Notes
- Does **not** replace `tmux` or `ttyd` – it abstracts them.
- Possible implementation technologies: `xterm.js` (fallback), `hterm`, `wterm`, or a custom PTY parser using `node‑pty` + ANSI‑to‑HTML libraries.
- Aligns with TangleClaw’s unique value proposition of treating the terminal as a transport layer while building a first‑class AI workspace.
