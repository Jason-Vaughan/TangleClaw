# TangleClaw

Remote project access system for Cursatory. Access any project from iPhone (or any device) via web browser over VPN — with persistent tmux sessions and auto-launching Claude Code.

## Architecture

```
iPhone (Safari) → VPN → Landing Page (:3101) → ttyd (:3100) → tmux → claude
```

**Three layers:**
1. **tmux** — Session persistence. Each project gets a named session that survives disconnects.
2. **ttyd** — Web terminal. Serves interactive terminals via browser. Single instance routes to projects via URL params.
3. **Landing page** — Project picker UI. Dark-themed, mobile-first. Shows all projects with active session indicators.

## Ports (registered with PortHub)

| Port | Service | Label |
|------|---------|-------|
| 3100 | ttyd (web terminal) | `TangleClaw/ttyd` |
| 3101 | Landing page + API | `TangleClaw/landing-page` |

## Usage

### From iPhone/Browser

1. Connect to VPN
2. Open `http://cursatory:3101` (or use the machine's VPN IP)
3. Tap a project — opens a web terminal with Claude Code running in that project

### Direct ttyd access (skip landing page)

```
http://cursatory:3100?arg=Refuctor-clean
http://cursatory:3100?arg=TiLT%20v2
```

### Manual tmux session management

```bash
# Open/attach to a project session
project-session Refuctor-clean

# Open a second window (multi-agent)
project-session Refuctor-clean 2

# List all sessions
tmux list-sessions

# Kill a specific session
tmux kill-session -t Refuctor-clean
```

## Service Management

Both services run as launchd agents — they auto-start on login and restart if they crash.

```bash
# Stop services
launchctl unload ~/Library/LaunchAgents/com.tangleclaw.ttyd.plist
launchctl unload ~/Library/LaunchAgents/com.tangleclaw.landing.plist

# Start services
launchctl load ~/Library/LaunchAgents/com.tangleclaw.ttyd.plist
launchctl load ~/Library/LaunchAgents/com.tangleclaw.landing.plist

# Check if running
lsof -i :3100 -i :3101 -P -n

# View logs
tail -f ~/Library/Logs/tangleclaw-ttyd.log
tail -f ~/Library/Logs/tangleclaw-landing.log
```

## Files

| File | Purpose |
|------|---------|
| `~/bin/project-session` | Creates/attaches tmux sessions per project |
| `~/bin/start-ttyd` | Launches ttyd with correct flags |
| `~/.tmux.conf` | tmux config (mouse, scrollback, colors) |
| `~/Documents/Projects/TangleClaw/server.js` | Landing page Node.js server |
| `~/Documents/Projects/TangleClaw/public/index.html` | Landing page UI |
| `~/Library/LaunchAgents/com.tangleclaw.ttyd.plist` | ttyd auto-start |
| `~/Library/LaunchAgents/com.tangleclaw.landing.plist` | Landing page auto-start |
| `~/Library/Logs/tangleclaw-*.log` | Service logs |

## Adding New Projects

Just create a directory in `~/Documents/Projects/`. The landing page auto-discovers projects on each load (and refreshes every 10 seconds).

## Multi-Agent Support

The `project-session` script supports window numbers for running multiple Claude Code instances on the same project:

```bash
project-session MyProject      # Window 1 (default)
project-session MyProject 2    # Window 2
project-session MyProject 3    # Window 3
```

The landing page shows window count badges when a project has multiple windows.
