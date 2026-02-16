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

## Developer Experience
- **Plugin system** — Custom widgets on cards (e.g., test status, CI badge)
- **Webhook integrations** — POST to external services on session events
- **REST API auth** — Optional API key for non-VPN deployments
- **Config UI** — Edit `~/.tangleclaw/config.json` from the browser
