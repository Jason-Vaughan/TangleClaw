# TangleClaw

Mobile-first tmux session manager for remote dev machines. Zero npm dependencies.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List projects with git info + session stats |
| POST | `/api/projects` | Create new project (body: `{name, gitInit, claudeMd, template}`) |
| GET | `/api/config` | Get config from `~/.tangleclaw/config.json` |
| GET | `/api/system` | macOS system stats (CPU, RAM, disk, uptime) |
| GET | `/api/activity` | Recent activity log entries |
| POST | `/api/sessions/:name/kill` | Kill a tmux session |
| GET | `/api/sessions/:name/peek` | Last lines of terminal output |
| POST | `/api/sessions/:name/send` | Send command to session (body: `{command}`) |

## Routes

- `/` — Landing page (static `public/index.html`)
- `/session/:name` — Session wrapper (banner + ttyd iframe), rendered by `lib/session.js`
- `/api/*` — API, dispatched by `lib/api.js`

## Key Conventions

- **No npm dependencies** — stdlib only (http, fs, path, child_process, os)
- **tmux delimiter**: Always use `|` (pipe), never `\t` — tabs get mangled under launchd
- **Session names**: Must match `/^[a-zA-Z0-9_-]+$/`
- **Single-file UI**: `public/index.html` contains all CSS + JS inline (~1380 lines)
- **Config**: Runtime config at `~/.tangleclaw/config.json`, activity log at `~/.tangleclaw/activity.log`
- **Service restart**: `lib/` changes require `sudo launchctl stop/start com.tangleclaw.landing`. Static file changes just need browser refresh.
- **Services**: System-level LaunchDaemons in `/Library/LaunchDaemons/` (start at boot, no login required)
