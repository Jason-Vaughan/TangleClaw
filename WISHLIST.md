# TangleClaw Wishlist

Deferred features and ideas for future versions.

## Session Management
- **Context window %** — Show Claude's context usage per session (requires Claude Code API/output parsing)
- **Session recording** — Record and replay terminal sessions (asciinema-style)
- **Shared clipboard** — Copy/paste between iPhone and tmux sessions via the landing page

## Multi-Host
- **SSH tunneling** — Manage sessions on remote hosts via SSH
- **Multi-host dashboard** — Single landing page for multiple dev machines
- **Linux/Windows support** — Abstract macOS-specific system stats (`vm_stat`, `sysctl`) behind platform modules

## Notifications
- **ntfy.sh push notifications** — Send alerts when sessions go idle, finish tasks, or error out
- **Per-session notification rules** — Configurable triggers (idle > 5m, output contains "error", etc.)
- **iOS Shortcuts integration** — Trigger actions from Siri/Shortcuts

## UI/UX
- **Themes** — Light mode, high contrast, custom color schemes
- **Project groups/tags** — Organize projects into categories (work, personal, experiments)
- **Template library** — Community/user-contributed project templates with git clone support
- **Drag-to-reorder** — Custom project sort order
- **Search/filter** — Filter projects by name, status, or git branch

## Methodology Template Standard
- **Formalize template spec for methodologies** — Expand `template.json` beyond file scaffolding to support full workflow methodologies (like Prawduct). Two template types: `"scaffold"` (files only) and `"methodology"` (workflow + conventions + AI instructions).
- **Generic status contract** — Replace hardcoded `getPrawductPhase()` with a generic `status` command in `template.json` that returns `{ badge, color, detail }`. TangleClaw renders whatever the methodology returns without interpreting it.
- **Methodology detection** — `detect` field in `template.json` (e.g., `".prawduct/project-state.yaml"`) so TangleClaw can identify which methodology an existing project uses.
- **Custom actions** — Methodologies declare actions (e.g., "Next Phase", "Run Retrospective") that show as buttons on project cards or session wrapper. Just `{ label, command }` pairs.
- **Engine-aware methodologies** — Templates declare a `defaults` block and optional `engines` overrides per AI engine (Claude, Codex, Aider). Each engine may need different AI instruction files, hooks, or init commands.
- **Engine adapter layer (Option B)** — TangleClaw abstracts engine differences so methodology authors write once. Methodology declares *what* it wants (instructions, hooks, phases), TangleClaw knows *how* to deliver to each engine (CLAUDE.md vs .codex.yaml vs .aider.conf.yml).
- **Community template library** — Standardized format enables a public repo of downloadable methodology templates. Install by dropping a folder into `templates/` or via a fetch/clone command.

## Developer Experience
- **Plugin system** — Custom widgets on cards (e.g., test status, CI badge)
- **Webhook integrations** — POST to external services on session events
- **REST API auth** — Optional API key for non-VPN deployments
- **Config UI** — Edit `~/.tangleclaw/config.json` from the browser
