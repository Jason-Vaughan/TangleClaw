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
  exec tmux attach-session -t "$session"
else
  echo "Session '${session}' is not running."
  echo "Return to TangleClaw to start a new session."
  # Sleep so the message stays visible in the ttyd terminal; ttyd closes
  # the connection when this process exits, which would flash the message
  # too briefly to read. The frontend redirects after ~10s anyway.
  sleep 30
fi
