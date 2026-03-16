#!/usr/bin/env bash
# TangleClaw — ttyd session attachment script
# Called by ttyd with --url-arg. The ?arg= query parameter from the iframe URL
# is passed as $1, containing the project/session name to attach to.

session="${1:-tangleclaw}"

# Attach to existing tmux session, or create a new one if it doesn't exist
exec tmux attach-session -t "$session" 2>/dev/null || exec tmux new-session -s "$session"
