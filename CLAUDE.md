# TangleClaw - Claude Code Context

## Project Identity
- **Project**: TangleClaw — Mobile-first tmux session manager for remote dev machines
- **Philosophy**: "Zero deps. Full control."
- **Zero npm dependencies** — stdlib only (http, fs, path, child_process, os)

## Critical Safety Rules

### Push Rules
- **"push" / "commit"** → Commit locally only, DO NOT push to remote
- **"push to remote" / "push to github"** → Push to origin (explicit permission required)
- **Default is LOCAL COMMITS ONLY.** Never push unless explicitly told.

### Service Restart
- `lib/` changes require: `launchctl stop com.tangleclaw.landing && sleep 1 && launchctl start com.tangleclaw.landing`
- `public/` changes only need browser refresh
- NEVER restart ttyd unless explicitly asked — it drops all active terminal connections

### Destructive Operations
- Confirm before deleting files, killing sessions, or modifying plists
- Never run `rm -rf` on project directories
- Never modify `~/Library/LaunchAgents/` plists without confirmation

---

## Project Navigation

### Key Documentation
| File | Purpose |
|------|---------|
| `CLAUDE.md` | This file — project context, rules, learnings |
| `README.md` | Public-facing project documentation |
| `CHANGELOG.md` | Auto-maintained version changelog |
| `WISHLIST.md` | Deferred feature ideas |

### Code Structure
```
TangleClaw/
  server.js              # Entry point — HTTP server, routing, ttyd reverse proxy
  lib/
    api.js               # API route dispatcher and endpoint handlers
    tmux.js              # tmux interactions (list, kill, peek, send-keys)
    system.js            # macOS stats (CPU via sysctl, RAM via vm_stat, disk via df)
    git.js               # Per-project git info with 10-second cache
    config.js            # Read/write ~/.tangleclaw/config.json
    activity.js          # Append-only JSON Lines activity log
    projects.js          # Project discovery, enrichment, and creation with templates
    session.js           # Session wrapper page renderer
    uploads.js           # File upload save/list (project-specific or global)
  public/
    index.html           # Single-file UI (~1380 lines, all CSS + JS inline)
    sw.js                # Service worker (cache-first static, network-first API)
    manifest.json        # PWA manifest
    logo.png             # Combined logo (serpent + wordmark)
    logo-icon.png        # Serpent icon
    logo-text.png        # "TangleClaw" wordmark
    icons/               # PWA icons (192, 512, apple-touch-icon)
  templates/
    blank/               # Empty project (just template.json)
    node/                # Node.js starter (package.json.tmpl, index.js)
    python/              # Python starter (main.py, requirements.txt)
    rust/                # Rust starter (src/main.rs, cargo init fallback)
    [custom]/            # Drop a folder with template.json to add templates
  hooks/
    pre-commit           # Enforces version.json bump on every commit
    post-commit          # Auto-tags commits with version from version.json
    commit-msg           # Auto-updates CHANGELOG.md with commit summary
  version.json           # Semantic version (major.minor.patch)
  CHANGELOG.md           # Auto-maintained changelog (updated by commit-msg hook)
  com.tangleclaw.*.plist # launchd plist templates
```

### External Files (not in repo)
| File | Purpose |
|------|---------|
| `~/bin/project-session` | Shell script: creates/attaches tmux sessions, launches AI engine |
| `~/bin/start-ttyd` | Shell script: starts ttyd with correct flags |
| `~/.tangleclaw/config.json` | Runtime config (engines, quick commands) |
| `~/.tangleclaw/activity.log` | Activity log (JSON Lines) |
| `~/.tangleclaw/clipboard` | tmux copy-pipe target (for Select mode copy) |
| `~/Library/LaunchAgents/com.tangleclaw.*.plist` | Installed copies of launchd plists |

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List projects with git info + session stats |
| POST | `/api/projects` | Create new project (body: `{name, gitInit, claudeMd, template}`) |
| GET | `/api/config` | Get config from `~/.tangleclaw/config.json` |
| GET | `/api/system` | macOS system stats (CPU, RAM, disk, uptime) |
| GET | `/api/templates` | List available project templates |
| GET | `/api/templates/:id` | Template detail with file list |
| GET | `/api/activity` | Recent activity log entries |
| POST | `/api/sessions/:name/kill` | Kill a tmux session |
| GET | `/api/sessions/:name/peek` | Last lines of terminal output |
| POST | `/api/sessions/:name/send` | Send command to session (body: `{command}`) |
| POST | `/api/upload` | Upload file (body: `{name, data, project?}`) |
| GET | `/api/uploads` | List uploads (`?project=` for project-specific) |
| DELETE | `/api/projects/:name` | Delete project (body: `{password}` if protected) |
| PATCH | `/api/projects/:name` | Rename project (body: `{newName}`) |
| POST | `/api/tmux/mouse` | Toggle tmux mouse mode (body: `{on: bool}`) |
| GET | `/api/clipboard` | Get tmux clipboard text (JSON) |
| GET | `/api/clipboard/view` | Clipboard text as standalone HTML page |
| GET | `/api/version` | Get app version from `version.json` |

## Routes

- `/` — Landing page (static `public/index.html`)
- `/session/:name` — Session wrapper (banner + ttyd iframe), rendered by `lib/session.js`
- `/terminal/*` — Reverse proxy to ttyd (HTTP + WebSocket)
- `/api/*` — API, dispatched by `lib/api.js`

---

## Key Conventions

- **No npm dependencies** — stdlib only. No build step, no bundler, no package.json.
- **tmux delimiter**: Always use `|` (pipe), never `\t` — tabs get mangled under launchd
- **Session names**: Must match `/^[a-zA-Z0-9_-]+$/`
- **Single-file UI**: `public/index.html` contains all CSS + JS inline
- **Config**: Runtime config at `~/.tangleclaw/config.json`, activity log at `~/.tangleclaw/activity.log`
- **Services**: User-level LaunchAgents in `~/Library/LaunchAgents/` (start at login, no sudo needed)
- **Ports**: 3100 (ttyd), 3101 (landing page) — registered with PortHub as permanent leases
- **PortHub (MANDATORY for all projects)**: All port assignments MUST be registered with [PortHub](https://github.com/ishayoyo/porthub) (`npm i -g porthub`). This applies to TangleClaw itself AND every project managed through TangleClaw, regardless of template (including Prawduct). Before assigning or changing any port, run `porthub status` to check for conflicts. Register with `porthub lease <port> --service "<name>" --project "<ProjectName>" --permanent`. When scaffolding a new project that uses ports, register them immediately. When reviewing existing projects, check for unregistered ports and register them.
- **Git-clean CLAUDE.md**: This file is checked into the repo. Keep it generic — no usernames, machine names, personal preferences, or identity sentries. User-specific context belongs in Claude Code auto-memory (`~/.claude/projects/*/memory/`) which is gitignored.
- **File-based templates**: Project templates live in `templates/`. Each template is a directory with a `template.json` manifest and files to copy. Use `{{PROJECT_NAME}}` for substitution. Files ending in `.tmpl` have the extension stripped on copy. Templates with an `init` command in `template.json` try that first, falling back to file copy.
- **Versioning**: Semantic versioning in `version.json`. Every commit MUST include a version bump (enforced by pre-commit hook). Patch for fixes, minor for features, major for breaking changes. Post-commit auto-tags, commit-msg auto-updates `CHANGELOG.md`. Version displayed in UI header, project cards, and session wrapper banner (project version if available, TangleClaw version as fallback).
- **Select mode for copy**: Session wrapper has a Select button that toggles tmux mouse off, allowing native browser text selection and copy. Auto-reverts after 30s. Uses `/api/tmux/mouse` endpoint.
- **Password-protected delete**: Project deletion can be gated by `deletePassword` in `~/.tangleclaw/config.json`. Config endpoint strips the password, exposes only `deleteProtected: bool`.

---

## Mobile Parity (MANDATORY)

**TangleClaw is mobile-first. iPhone Safari is the primary client.**

### Before Making Changes:
- Does this feature work on mobile (320px viewport)?
- Are touch targets at least 44px?
- Does swipe-to-kill still work?
- Does the peek drawer still slide up properly?
- Is the session wrapper usable in Safari (no cross-origin issues)?

### After Making Changes:
- Test at mobile viewport width (375px iPhone)
- Verify touch interactions (swipe, tap, long-press)
- Check that modals/drawers don't overflow on small screens
- Verify the PWA "Add to Home Screen" experience isn't broken

### Known Mobile Considerations:
- Safari blocks WebSocket from cross-port iframes — ttyd MUST be proxied through `/terminal/*`
- iOS Safari has no hover states — all hover tooltips need tap equivalents
- Safe area insets matter for notch/home indicator
- Service worker enables offline fallback for the landing page

---

## Testing Methodology

**"If it handles data, parses output, or makes decisions — it needs a test."**

### When Tests Must Be Created:
1. **API endpoint handlers** — All routes that return data or modify state
2. **tmux output parsing** — Format string parsing, session list parsing
3. **Data transformations** — Git info parsing, system stats parsing
4. **Input validation** — Session names, project names, command injection prevention
5. **Bug fixes** — TDD: Write failing test first, then fix
6. **Proxy logic** — WebSocket upgrade handling, path rewriting

### Testing Approach (Zero Dependencies):
- Use Node.js built-in `node:test` and `node:assert` (Node 18+)
- Test files go in `test/` directory, named `*.test.js`
- Run with `node --test test/`
- No test framework dependencies — consistent with zero-dep philosophy

### Code Quality:
- NO unused imports, variables, or functions
- NO commented-out code blocks (delete it or it doesn't exist)
- NO duplicate logic (DRY principle)
- NO "TODO" comments without a matching WISHLIST.md entry
- NO unnecessary abstractions — three similar lines > premature abstraction

---

## Quick Commands
```bash
# Restart landing page (after lib/ changes)
launchctl stop com.tangleclaw.landing && sleep 1 && launchctl start com.tangleclaw.landing

# Restart ttyd
launchctl stop com.tangleclaw.ttyd && sleep 1 && launchctl start com.tangleclaw.ttyd

# Check services
lsof -i :3100 -i :3101 -P -n

# View logs
tail -f ~/Library/Logs/tangleclaw-landing.log
tail -f ~/Library/Logs/tangleclaw-ttyd.log

# Run tests (49 tests across 17 suites)
node --test 'test/*.test.js'
```

---

## Self-Improvement Directive (Active Every Session)

**This file is a living document. It should be actively maintained by contributors and AI assistants.**

### Learning Protocol

When working on this project, document discoveries as they happen — don't batch them for later. If you wasted time searching for something, hit a gotcha, or learned a project convention, add it to the Learnings Log below immediately.

**What to log:**
- Wasted compute/search time — log where the thing actually was
- Project conventions discovered through trial and error
- Gotchas that would trip up a new contributor
- Failed approaches — log why so they aren't repeated
- Platform-specific quirks (macOS, Safari, launchd, tmux)

**What NOT to log (avoid noise):**
- Trivial facts (file exists at expected location, command ran as expected)
- Things already documented in this file
- Obvious Node.js/stdlib knowledge

### Documentation Parity Protocol (MANDATORY)

**When adding, removing, or changing any feature, the following docs MUST be updated in the same commit:**

1. **`CLAUDE.md`** — Update API endpoints table, code structure tree, key conventions, or external files if affected
2. **`README.md`** — Update feature list, API table, file structure, session wrapper description, or project card description if affected
3. **`CHANGELOG.md`** — Auto-updated by commit-msg hook (no manual action needed)

**Checklist for every feature change:**
- New API endpoint? → Add to both CLAUDE.md and README.md API tables
- New file in lib/, public/, templates/, hooks/? → Add to both code structure trees
- New external file (in ~/.tangleclaw/)? → Add to CLAUDE.md external files table
- New session wrapper button/feature? → Update README.md session wrapper section
- New project card badge/feature? → Update README.md project dashboard section
- New convention or gotcha? → Add to CLAUDE.md key conventions

### Update Protocol:

1. Add findings to the Learnings Log section below
2. Keep entries concise — bullet points preferred
3. Include file paths where relevant
4. Remove outdated learnings when they no longer apply

---

### Learnings Log
<!-- Add new learnings here with date -->

**2026-03-06**: **tmux format strings MUST use `|` as delimiter, not `\t`.** Tabs get mangled when processes run under launchd. This caused silent parsing failures in tmux list output — sessions appeared missing. Fix: `lib/tmux.js` uses pipe throughout.

**2026-03-06**: **Safari blocks WebSocket from cross-port iframes.** Loading ttyd (:3100) in an iframe on the landing page (:3101) fails silently in Safari. Fix: `server.js` reverse-proxies `/terminal/*` to ttyd, keeping everything same-origin.

**2026-03-06**: **git.js had a shared cache bug.** All projects shared a single `_cacheTime` variable, so the 10s cache only worked for whichever project was queried first. Fix: per-project cache timestamps.

**2026-03-06**: **LaunchDaemons don't inherit user TCC permissions.** Every binary (node, git, tmux, ttyd) needs individual FDA grants under LaunchDaemons. Rolled back to LaunchAgents which inherit user permissions automatically.

**2026-03-06**: **tmux server doesn't exist at boot.** The socket at `/private/tmp/tmux-501/default` is only created on login. `lib/tmux.js` handles this with try/catch + piped stdio so the server doesn't crash when tmux isn't available.

**2026-03-06**: **After reboot, node may get EPERM errors.** macOS TCC takes a moment to settle after login. The launchd KeepAlive directive auto-restarts the service, handling this gracefully.

---

*Last Updated: 2026-03-08*
