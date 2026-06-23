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

# ── macOS TCC preflight (#324) ──
# The TC server's launchd agent hangs SILENTLY on startup when the repo lives
# under a TCC-protected folder (~/Documents, ~/Desktop, ~/Downloads) AND node
# lacks Full Disk Access: launchd-spawned node blocks in uv_cwd opening its
# working directory, with zero output (stderr → /dev/null hid it historically).
# This bit us once already — a routine re-run took the server down for hours.
# We can't cheaply prove the grant state before reloading (reading the system
# TCC.db itself requires Full Disk Access), so this is a non-blocking heads-up;
# the post-reload health check below escalates to an actionable diagnosis if the
# server doesn't come up. Non-blocking also keeps non-interactive runs working.
TCC_PROTECTED=""
RESOLVED_NODE="$NODE_PATH"
if [ "$(uname)" = "Darwin" ]; then
  case "${REPO_DIR}/" in
    "$HOME/Documents/"*|"$HOME/Desktop/"*|"$HOME/Downloads/"*)
      TCC_PROTECTED="yes"
      # Resolve symlinks (Homebrew node is a symlink) — Full Disk Access is keyed
      # on the real binary path. Use node itself (already validated) for a
      # portable realpath; BSD readlink lacks -f.
      RESOLVED_NODE="$("$NODE_PATH" -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$NODE_PATH" 2>/dev/null || echo "$NODE_PATH")"
      yellow "NOTE: repo is under a macOS TCC-protected folder:"
      yellow "        $REPO_DIR"
      yellow "      If the server hangs on startup with no log output, node lacks Full Disk Access."
      yellow "      Fix: System Settings > Privacy & Security > Full Disk Access > '+' and add:"
      yellow "        $RESOLVED_NODE"
      yellow "      (Or move the repo outside ~/Documents, ~/Desktop, ~/Downloads — also fixes the SSH variant.)"
      echo ""
      ;;
  esac
fi

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

# ttyd plist — install.sh always installs the DIRECT-mode bind (--port 3100).
# Caddy mode rebinds ttyd to a Unix socket via scripts/ingress-cutover.js; this
# keeps the default install path unchanged (true rollback target). See AUTH-1.
sed \
  -e "s|__TTYD_PATH__|${TTYD_PATH}|g" \
  -e "s|__REPO_DIR__|${REPO_DIR}|g" \
  -e "s|__HOME__|${HOME}|g" \
  -e "s|__LAUNCHD_PATH__|${LAUNCHD_PATH}|g" \
  -e "s|__TTYD_BIND_KEY__|--port|g" \
  -e "s|__TTYD_BIND_VAL__|3100|g" \
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

# Ensure the log directory exists before launchd starts the server — the plist's
# StandardErrorPath (#324) points here, and launchd fails to spawn the job if the
# parent directory is missing.
mkdir -p "$HOME/.tangleclaw/logs"

# Unload existing (idempotent — ignore errors if not loaded)
launchctl unload "${LAUNCH_AGENTS_DIR}/${SERVER_PLIST}" 2>/dev/null || true
launchctl unload "${LAUNCH_AGENTS_DIR}/${TTYD_PLIST}" 2>/dev/null || true

# Load
launchctl load "${LAUNCH_AGENTS_DIR}/${SERVER_PLIST}"
green "  Loaded ${SERVER_PLIST}"

launchctl load "${LAUNCH_AGENTS_DIR}/${TTYD_PLIST}"
green "  Loaded ${TTYD_PLIST}"

echo ""

# ── Detect protocol from config ──
# Reads ~/.tangleclaw/config.json to determine whether the running server
# will serve HTTPS. Requires httpsEnabled=true AND both cert paths set —
# matches createServer()'s guard in server.js so the health-check URL is
# consistent with what the server actually binds. Falls back to HTTP when
# the config file is missing (first install) or fields are null.
CONFIG_FILE="$HOME/.tangleclaw/config.json"
PROTOCOL="http"
CURL_OPTS=""
if [ -f "$CONFIG_FILE" ]; then
  PROTOCOL_DETECTED="$(node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (c.httpsEnabled && c.httpsCertPath && c.httpsKeyPath) process.stdout.write("https");
      else process.stdout.write("http");
    } catch { process.stdout.write("http"); }
  ' "$CONFIG_FILE" 2>/dev/null || echo "http")"
  if [ "$PROTOCOL_DETECTED" = "https" ]; then
    PROTOCOL="https"
    CURL_OPTS="-k"
  fi
fi
green "  Server protocol: $PROTOCOL"

# AUTH-1 (#395): detect the configured ingress mode. install.sh only sets up the
# DIRECT path; Caddy ingress is activated/rolled back by scripts/ingress-cutover.js.
INGRESS_MODE="direct"
if [ -f "$CONFIG_FILE" ]; then
  INGRESS_MODE="$(node -e '
    try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(c.ingressMode === "caddy" ? "caddy" : "direct"); }
    catch { process.stdout.write("direct"); }
  ' "$CONFIG_FILE" 2>/dev/null || echo "direct")"
fi

echo ""

# ── Health check ──

echo "Waiting for server to start..."
sleep 2

HEALTH_STATUS=""
for i in 1 2 3 4 5; do
  HEALTH_STATUS="$(curl -s $CURL_OPTS -o /dev/null -w '%{http_code}' "${PROTOCOL}://localhost:3102/api/health" 2>/dev/null || true)"
  if [ "$HEALTH_STATUS" = "200" ] || [ "$HEALTH_STATUS" = "503" ]; then
    break
  fi
  sleep 1
done

if [ "$HEALTH_STATUS" = "200" ] || [ "$HEALTH_STATUS" = "503" ]; then
  green "Server is running (health: HTTP $HEALTH_STATUS)"
else
  yellow "WARNING: Server may not be ready yet (health: HTTP ${HEALTH_STATUS:-timeout})"
  if [ -n "$TCC_PROTECTED" ]; then
    red "  Likely cause (#324): macOS TCC is blocking node from the repo under a"
    red "  protected folder, so the launchd server hangs in uv_cwd with no output."
    red "  Fix: grant Full Disk Access to:"
    red "        $RESOLVED_NODE"
    red "       (System Settings > Privacy & Security > Full Disk Access), then re-run this script."
    red "  Confirm the hang: sample \$(pgrep -f 'node server.js') 1   → shows uv_cwd > __open."
  fi
  yellow "Check logs:    tail -f ~/.tangleclaw/logs/tangleclaw.log"
  yellow "Server stderr: tail -f ~/.tangleclaw/logs/server.err.log"
fi

echo ""
echo "======================================"
green "TangleClaw v3 installed successfully!"
echo "======================================"
echo ""
echo "  Landing page:  ${PROTOCOL}://localhost:3102"
echo "  Terminal:       http://localhost:3100"
echo ""
echo "  Logs:           tail -f ~/.tangleclaw/logs/tangleclaw.log"
echo "  Uninstall:      launchctl unload ~/Library/LaunchAgents/com.tangleclaw.*.plist"
echo ""

# AUTH-1 (#395): ingress mode pointer. Direct is the default; Caddy ingress is
# opt-in and reversible via the cutover script.
if [ "$INGRESS_MODE" = "caddy" ]; then
  yellow "  Ingress mode is 'caddy' but install.sh sets up DIRECT only."
  yellow "  Activate Caddy:   node scripts/ingress-cutover.js --to caddy"
else
  echo "  Caddy ingress (optional): node scripts/ingress-cutover.js --to caddy"
  echo "  (reversible — roll back with: node scripts/ingress-cutover.js --to direct)"
fi
echo ""
