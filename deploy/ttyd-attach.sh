#!/usr/bin/env bash
# TangleClaw — ttyd session attachment script
# Called by ttyd with --url-arg. The ?arg= query parameter from the iframe URL
# is passed as $1, containing the project/session name to attach to.

raw="${1:-tangleclaw}"
# Sanitize for tmux: replace spaces with hyphens, strip invalid chars
session=$(echo "$raw" | tr ' ' '-' | sed 's/[^a-zA-Z0-9_-]//g')

# Only attach to existing tmux sessions — never create new ones.
# The old `tmux new-session -A` pattern silently spawned a bare shell when the
# real engine session ended, leaving an orphan that confused TangleClaw's
# session state tracking and showed ulimit errors from .zshrc (fixes #47).
if tmux has-session -t "$session" 2>/dev/null; then
  # Replay scrolled-off history into the fresh xterm.js buffer before attaching
  # (#322). ttyd pipes this script's stdout straight into the browser terminal,
  # so printing the pane history here restores scrollback that a reconnect or a
  # TC/ttyd restart would otherwise lose — the attach below only redraws the
  # current viewport, never the history (tmux itself retains it via
  # history-limit). Flags:
  #   -e        keep colors/escape sequences
  #   -p        print to stdout (into the terminal)
  #   -S -10000 start up to 10000 lines back (matches the xterm scrollback
  #             buffer set via the scrollback client-option in the plist)
  #   -E -1     stop one line ABOVE the visible screen, so the lines the attach
  #             is about to redraw aren't printed twice
  # Errors (e.g. a brand-new pane with no history) are swallowed — the replay is
  # best-effort and must never block the attach.
  tmux capture-pane -e -p -t "$session" -S -10000 -E -1 2>/dev/null || true
  exec tmux attach-session -t "$session"
else
  echo "Session '${session}' is not running."
  echo "Return to TangleClaw to start a new session."
  # Sleep so the message stays visible in the ttyd terminal; ttyd closes
  # the connection when this process exits, which would flash the message
  # too briefly to read. The frontend redirects after ~10s anyway.
  sleep 30
fi
