#!/usr/bin/env bash
set -euo pipefail

# TangleClaw v3 — Install Script
# Installs launchd services for the TangleClaw server and ttyd.
# Idempotent: safe to re-run.

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
readonly SERVER_PLIST="com.tangleclaw.server.plist"
readonly TTYD_PLIST="com.tangleclaw.ttyd.plist"
readonly TMUX_CONF_SRC="${SCRIPT_DIR}/tmux.conf"
readonly TMUX_CONF_DST="$HOME/.tmux.conf"

# ── Colors ──

red() { printf '\033[0;31m%s\033[0m\n' "$1"; }
green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$1"; }

# ── Prerequisites ──

echo "Checking prerequisites..."

# Node.js 22+
if ! command -v node &>/dev/null; then
  red "ERROR: Node.js not found. Install Node.js 22+ and try again."
  exit 1
fi

NODE_PATH="$(which node)"
NODE_VERSION="$(node --version)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"

if [ "$NODE_MAJOR" -lt 22 ]; then
  red "ERROR: Node.js 22+ required (found $NODE_VERSION)."
  exit 1
fi
green "  Node.js $NODE_VERSION ($NODE_PATH)"

# ttyd
if ! command -v ttyd &>/dev/null; then
  red "ERROR: ttyd not found. Install with: brew install ttyd"
  exit 1
fi
TTYD_PATH="$(which ttyd)"
green "  ttyd ($TTYD_PATH)"

# tmux
if ! command -v tmux &>/dev/null; then
  red "ERROR: tmux not found. Install with: brew install tmux"
  exit 1
fi
TMUX_PATH="$(which tmux)"
green "  tmux ($TMUX_PATH)"

# Build PATH for launchd plists — start from the user's current PATH so that
# engine binaries installed in non-standard locations (e.g. ~/.local/bin,
# ~/.npm-global/bin) are discoverable at runtime for engine detection.
LAUNCHD_PATH="$PATH"
# Ensure system essentials are present
for sys_path in /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
  case ":${LAUNCHD_PATH}:" in
    *":${sys_path}:"*) ;; # already present
    *) LAUNCHD_PATH="${LAUNCHD_PATH}:${sys_path}" ;;
  esac
done
green "  PATH for launchd: $LAUNCHD_PATH"

echo ""

# ── Generate plists ──

echo "Generating launchd plists..."

mkdir -p "$LAUNCH_AGENTS_DIR"

# Server plist
sed \
  -e "s|__NODE_PATH__|${NODE_PATH}|g" \
  -e "s|__REPO_DIR__|${REPO_DIR}|g" \
  -e "s|__HOME__|${HOME}|g" \
  -e "s|__LAUNCHD_PATH__|${LAUNCHD_PATH}|g" \
  "${SCRIPT_DIR}/${SERVER_PLIST}" > "${LAUNCH_AGENTS_DIR}/${SERVER_PLIST}"

green "  ${LAUNCH_AGENTS_DIR}/${SERVER_PLIST}"

# ttyd plist
sed \
  -e "s|__TTYD_PATH__|${TTYD_PATH}|g" \
  -e "s|__REPO_DIR__|${REPO_DIR}|g" \
  -e "s|__HOME__|${HOME}|g" \
  -e "s|__LAUNCHD_PATH__|${LAUNCHD_PATH}|g" \
  "${SCRIPT_DIR}/${TTYD_PLIST}" > "${LAUNCH_AGENTS_DIR}/${TTYD_PLIST}"

green "  ${LAUNCH_AGENTS_DIR}/${TTYD_PLIST}"

echo ""

# ── Install tmux.conf ──

echo "Installing tmux configuration..."

if [ -f "$TMUX_CONF_DST" ]; then
  if cmp -s "$TMUX_CONF_SRC" "$TMUX_CONF_DST"; then
    green "  ${TMUX_CONF_DST} (already up-to-date)"
  else
    BACKUP="${TMUX_CONF_DST}.backup.$(date +%Y%m%d-%H%M%S)"
    cp "$TMUX_CONF_DST" "$BACKUP"
    yellow "  Existing ${TMUX_CONF_DST} backed up to ${BACKUP}"
    cp "$TMUX_CONF_SRC" "$TMUX_CONF_DST"
    green "  ${TMUX_CONF_DST} (updated)"
  fi
else
  cp "$TMUX_CONF_SRC" "$TMUX_CONF_DST"
  green "  ${TMUX_CONF_DST} (installed)"
fi

# Reload tmux config in any running tmux server (best-effort, ignore failures)
if tmux info &>/dev/null; then
  tmux source-file "$TMUX_CONF_DST" 2>/dev/null && green "  Reloaded tmux config in running server" || true
fi

echo ""

# ── Load services ──

echo "Loading services..."

# Unload existing (idempotent — ignore errors if not loaded)
launchctl unload "${LAUNCH_AGENTS_DIR}/${SERVER_PLIST}" 2>/dev/null || true
launchctl unload "${LAUNCH_AGENTS_DIR}/${TTYD_PLIST}" 2>/dev/null || true

# Load
launchctl load "${LAUNCH_AGENTS_DIR}/${SERVER_PLIST}"
green "  Loaded ${SERVER_PLIST}"

launchctl load "${LAUNCH_AGENTS_DIR}/${TTYD_PLIST}"
green "  Loaded ${TTYD_PLIST}"

echo ""

# ── Health check ──

echo "Waiting for server to start..."
sleep 2

HEALTH_STATUS=""
for i in 1 2 3 4 5; do
  HEALTH_STATUS="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3102/api/health 2>/dev/null || true)"
  if [ "$HEALTH_STATUS" = "200" ] || [ "$HEALTH_STATUS" = "503" ]; then
    break
  fi
  sleep 1
done

if [ "$HEALTH_STATUS" = "200" ] || [ "$HEALTH_STATUS" = "503" ]; then
  green "Server is running (health: HTTP $HEALTH_STATUS)"
else
  yellow "WARNING: Server may not be ready yet (health: HTTP ${HEALTH_STATUS:-timeout})"
  yellow "Check logs: tail -f ~/.tangleclaw/logs/tangleclaw.log"
fi

echo ""
echo "======================================"
green "TangleClaw v3 installed successfully!"
echo "======================================"
echo ""
echo "  Landing page:  http://localhost:3102"
echo "  Terminal:       http://localhost:3100"
echo ""
echo "  Logs:           tail -f ~/.tangleclaw/logs/tangleclaw.log"
echo "  Uninstall:      launchctl unload ~/Library/LaunchAgents/com.tangleclaw.*.plist"
echo ""
