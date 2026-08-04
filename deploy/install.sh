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

# ── Platform guard ──
# Everything below assumes macOS: the services are launchd agents and the
# dependency bootstrap is Homebrew. Without this check a Linux user gets a
# Linuxbrew bootstrap followed by launchd steps that cannot work — a partial
# install instead of the honest refusal the README already documents. Fail
# here, before anything is written or downloaded.
if [ "$(uname -s)" != "Darwin" ]; then
  red "ERROR: TangleClaw requires macOS — it manages its services with launchd."
  red "       Linux support is not yet available (see README → Prerequisites)."
  exit 1
fi

# ── Dependency bootstrap (single-command install) ──
# Make `install.sh` self-sufficient: every runtime dependency is auto-installed
# via Homebrew, and Homebrew itself is bootstrapped if absent. The privileged,
# interactive steps (Homebrew install, mkcert CA trust) belong HERE — install.sh
# runs in a terminal — so the headless launchd server never has to attempt them.

BREW=""
# Resolve a usable Homebrew into $BREW, installing it if missing.
ensure_homebrew() {
  if [ -n "$BREW" ]; then return 0; fi
  if command -v brew &>/dev/null; then BREW="$(command -v brew)"; return 0; fi
  yellow "  Homebrew not found — installing it (needed to auto-install dependencies)."
  yellow "  The Homebrew installer may prompt you for your password."
  # Download and execute as two steps, deliberately. Inlining the command
  # substitution into `bash -c "$(curl …)"` makes a failed download
  # indistinguishable from a successful one: curl writes nothing, `bash -c ""`
  # exits 0, the `||` guard never fires, and the script proceeds to blame PATH
  # for a Homebrew that was never installed — advice that sends the user in a
  # loop, since re-running reproduces it. Each failure mode gets its own message.
  local brew_installer
  brew_installer="$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || { red "ERROR: could not download the Homebrew installer (check your network connection)."; \
         red "       Install Homebrew manually from https://brew.sh and re-run."; exit 1; }
  [ -n "$brew_installer" ] \
    || { red "ERROR: the downloaded Homebrew installer was empty — refusing to run it."; \
         red "       Install Homebrew manually from https://brew.sh and re-run."; exit 1; }
  NONINTERACTIVE=1 /bin/bash -c "$brew_installer" \
    || { red "ERROR: the Homebrew installer failed. Install it from https://brew.sh and re-run."; exit 1; }
  # Prime brew into this shell's PATH (Apple Silicon → /opt/homebrew, Intel → /usr/local).
  if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)";
  elif [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
  command -v brew &>/dev/null \
    || { red "ERROR: Homebrew installed but not on PATH. Open a new terminal and re-run."; exit 1; }
  BREW="$(command -v brew)"
  green "  Homebrew ready ($BREW)"
}

# Ensure <command> is available, installing its Homebrew <formula> if missing.
ensure_dep() {
  local cmd="$1" formula="$2"
  if command -v "$cmd" &>/dev/null; then green "  $cmd ($(command -v "$cmd"))"; return 0; fi
  yellow "  $cmd not found — installing via Homebrew ($formula)…"
  ensure_homebrew
  "$BREW" install "$formula" || { red "ERROR: 'brew install $formula' failed."; exit 1; }
  command -v "$cmd" &>/dev/null || { red "ERROR: $formula installed but '$cmd' is not on PATH."; exit 1; }
  green "  $cmd installed ($(command -v "$cmd"))"
}

# ── Prerequisites ──

echo "Checking prerequisites..."

# Node.js 22+
if ! command -v node &>/dev/null; then
  yellow "  Node.js not found — installing via Homebrew (node)…"
  ensure_homebrew
  "$BREW" install node || { red "ERROR: 'brew install node' failed."; exit 1; }
  command -v node &>/dev/null || { red "ERROR: Node.js still not found after install."; exit 1; }
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

# ttyd — terminal-over-websocket front end
ensure_dep ttyd ttyd
TTYD_PATH="$(command -v ttyd)"

# tmux — session multiplexer
ensure_dep tmux tmux
TMUX_PATH="$(command -v tmux)"

# mkcert — local TLS certs for HTTPS (direct mode + the first-run wizard).
ensure_dep mkcert mkcert
# Trust the local CA NOW, while we have an interactive terminal. This is the
# PRIVILEGED step (it shells out to sudo / `security add-trusted-cert`), so doing
# it here means the headless launchd server never has to: the wizard then only
# GENERATES certs against the already-trusted CA. Idempotent — safe to re-run.
yellow "  Installing the mkcert local CA into your trust store (you may be prompted)…"
if mkcert -install; then
  green "  mkcert local CA trusted"
else
  yellow "  mkcert -install did not complete — HTTPS certs won't be trusted until you run"
  yellow "  'mkcert -install' in a terminal. Continuing (the rest of the install is unaffected)."
fi

# caddy — reverse-proxy ingress for AUTH-1 'caddy' mode. Installed up front so the
# ingress cutover (scripts/ingress-cutover.js) works out of the box; direct mode
# (the default) does not use it.
ensure_dep caddy caddy

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
# Answers "does this path sit under a TCC-protected folder?" for ONE path.
# Kept as a function because two different paths need the same answer and they
# fail in different ways (see below); duplicating the case arms is how the second
# caller drifts from the first.
tcc_protected_path() {
  case "${1%/}/" in
    "$HOME/Documents/"*|"$HOME/Desktop/"*|"$HOME/Downloads/"*) return 0 ;;
  esac
  return 1
}

# Config stores the projects directory as a literal "~/..." string, and a tilde
# inside a quoted shell variable is never expanded by the shell. Passing one
# straight to tcc_protected_path matches no case arm and reports "safe" — the
# quiet wrong answer, on the exact default the check exists for. Separated so it
# can be exercised directly rather than only through its caller.
expand_tilde() {
  case "$1" in
    "~/"*) printf '%s' "$HOME/${1#\~/}" ;;
    "~")   printf '%s' "$HOME" ;;
    *)     printf '%s' "$1" ;;
  esac
}

TCC_PROTECTED=""
TCC_PROJECTS_PROTECTED=""
# Assigned only inside the Darwin branch, but referenced again in the completion
# summary far below. Under `set -u` an unset variable is a fatal error, and the
# guard that keeps that reference unreachable is a different variable — so
# initialize rather than rely on two flags staying in agreement.
PROJECTS_DIR=""
RESOLVED_NODE="$NODE_PATH"
if [ "$(uname)" = "Darwin" ]; then
  # Resolve symlinks (Homebrew node is a symlink) — Full Disk Access is keyed on
  # the real binary path. Use node itself (already validated) for a portable
  # realpath; BSD readlink lacks -f. Hoisted out of the repo branch because the
  # projects-directory warning below names the same binary.
  RESOLVED_NODE="$("$NODE_PATH" -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$NODE_PATH" 2>/dev/null || echo "$NODE_PATH")"

  if tcc_protected_path "$REPO_DIR"; then
    TCC_PROTECTED="yes"
    yellow "NOTE: repo is under a macOS TCC-protected folder:"
    yellow "        $REPO_DIR"
    yellow "      If the server hangs on startup with no log output, node lacks Full Disk Access."
    yellow "      Fix: System Settings > Privacy & Security > Full Disk Access > '+' and add:"
    yellow "        $RESOLVED_NODE"
    yellow "      (That is the REAL binary, not the $NODE_PATH symlink — macOS keys the grant to the"
    yellow "       real path. It carries a version number, so a later 'brew upgrade node' moves it"
    yellow "       and the grant must be given again.)"
    yellow "      (Or move the repo outside ~/Documents, ~/Desktop, ~/Downloads — also fixes the SSH variant.)"
    echo ""
  fi

  # The projects directory is a SEPARATE path from the repo, and it fails later
  # and louder: the repo case hangs node at startup (caught by the health check
  # below), but a protected projects directory lets the whole install succeed —
  # health check included — and then wedges the server on the first request that
  # enumerates projects. That scan is a synchronous readdir on the event loop, so
  # one blocked open() takes down every route, with no error, no log and no
  # recovery, while launchd still reports the process healthy. Nothing downstream
  # can warn about it, which is why it is warned about here.
  PROJECTS_DIR_RAW="$HOME/Documents/Projects"   # mirrors lib/store.js DEFAULT_CONFIG.projectsDir
  if [ -f "$HOME/.tangleclaw/config.json" ]; then
    PROJECTS_DIR_RAW="$("$NODE_PATH" -e '
      try {
        const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.stdout.write(typeof c.projectsDir === "string" && c.projectsDir ? c.projectsDir : "~/Documents/Projects");
      } catch { process.stdout.write("~/Documents/Projects"); }
    ' "$HOME/.tangleclaw/config.json" 2>/dev/null || echo "$HOME/Documents/Projects")"
  fi
  PROJECTS_DIR="$(expand_tilde "$PROJECTS_DIR_RAW")"

  if tcc_protected_path "$PROJECTS_DIR"; then
    TCC_PROJECTS_PROTECTED="yes"
    yellow "NOTE: the projects directory is under a macOS TCC-protected folder:"
    yellow "        $PROJECTS_DIR"
    yellow "      This install can finish and pass its health check, and the server will still"
    yellow "      stop responding the first time anything lists projects — with no error in any log."
    yellow "      Fix: System Settings > Privacy & Security > Full Disk Access > '+' and add:"
    yellow "        $RESOLVED_NODE"
    yellow "      (Or point the projects directory outside ~/Documents, ~/Desktop, ~/Downloads"
    yellow "       in TangleClaw's settings.)"
    echo ""
  fi
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

# ttyd attach script — install OUTSIDE the repo (#500). ttyd opens this file per
# client-connect and ttyd is denied Full Disk Access, so a repo-resident copy
# under ~/Documents freezes ttyd in open() (all sessions black-screen after a
# ttyd restart). ~/.tangleclaw is not TCC-protected. The server also re-syncs
# this at boot (lib/ttyd-attach.js) so an update that bumps the repo script
# refreshes the copy; installing it here means the FIRST ttyd start is already
# safe. Keep this path in lockstep with attachScriptPath() in lib/ttyd-attach.js.
readonly TTYD_ATTACH_DIR="$HOME/.tangleclaw/deploy"
readonly TTYD_ATTACH="${TTYD_ATTACH_DIR}/ttyd-attach.sh"
mkdir -p "$TTYD_ATTACH_DIR"
cp "${SCRIPT_DIR}/ttyd-attach.sh" "$TTYD_ATTACH"
chmod 0755 "$TTYD_ATTACH"
green "  ${TTYD_ATTACH}"

# ttyd plist — install.sh always installs the DIRECT-mode bind, pinned to
# loopback (#710). ttyd serves a --writable terminal that execs `tmux
# attach-session`, and its default interface is ALL of them, so the pre-#710
# `--port 3100` install published an unauthenticated shell to the whole network.
# Every install is loopback-only here, and stays that way: ttyd does NOT follow
# the `bindAllInterfaces` dashboard opt-in, because nothing addresses this port
# directly — TangleClaw proxies to it.
# Caddy mode rebinds ttyd to a Unix socket via scripts/ingress-cutover.js; this
# keeps the default install path unchanged (true rollback target). See AUTH-1.
# (The ttyd plist no longer carries __REPO_DIR__ — the attach script moved out of
# the repo to the non-TCC path above; __REPO_DIR__ lives only in the server plist.)
sed \
  -e "s|__TTYD_PATH__|${TTYD_PATH}|g" \
  -e "s|__TTYD_ATTACH__|${TTYD_ATTACH}|g" \
  -e "s|__HOME__|${HOME}|g" \
  -e "s|__LAUNCHD_PATH__|${LAUNCHD_PATH}|g" \
  -e "s|__TTYD_BIND_KEY__|--interface|g" \
  -e "s|__TTYD_BIND_VAL__|127.0.0.1|g" \
  -e "s|__TTYD_PORT__|3100|g" \
  -e "s|__TTYD_SOCKET__||g" \
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
green "TangleClaw installed successfully!"
echo "======================================"
echo ""

# Repeated here on purpose. The heads-up above is printed before dependency
# installation, which on a machine without Homebrew emits thousands of lines and
# scrolls it far out of view — an operator reads the end of the run, not the
# middle of it. This is the last thing between them and a server that will look
# fine and then stop answering.
if [ -n "$TCC_PROJECTS_PROTECTED" ]; then
  yellow "  HEADS-UP: the projects directory sits under a TCC-protected folder:"
  yellow "    $PROJECTS_DIR"
  yellow "  If the dashboard stops responding after you open it, that is why."
  yellow "  Fix: grant Full Disk Access to the node binary below, or move the projects directory."
  yellow "    $RESOLVED_NODE"
  yellow "  (The REAL binary, not the $NODE_PATH symlink. It carries a version number, so a later"
  yellow "   'brew upgrade node' moves it and the grant must be given again.)"
  echo ""
fi
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
  yellow "  THEN set the login: node scripts/reset-admin.js --create-gate --user <name>"
  yellow "  (the cutover installs the ingress, NOT a password — without the second"
  yellow "   command the dashboard is reachable with no login at all)"
else
  # Deliberately NOT "optional", and deliberately two commands. The cutover on
  # its own configures an ingress with no password, succeeds, and prints a green
  # health check -- docs/setup-guide.md carries the same warning in bold because
  # following the single-command form is how an operator ends up serving an
  # unprotected dashboard while believing the opposite.
  echo "  Put a password and TLS in front of it (2 commands, both needed):"
  echo "    node scripts/ingress-cutover.js --to caddy"
  echo "    node scripts/reset-admin.js --create-gate --user <name>"
  echo "  The first installs the ingress; the SECOND is the login. Run them back to back —"
  echo "  in between, the dashboard is up with no password."
  echo "  (reversible — roll back with: node scripts/ingress-cutover.js --to direct)"
fi
echo ""
