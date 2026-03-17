#!/usr/bin/env bash
# TangleClaw — ttyd session attachment script
# Called by ttyd with --url-arg. The ?arg= query parameter from the iframe URL
# is passed as $1, containing the project/session name to attach to.

raw="${1:-tangleclaw}"
# Sanitize for tmux: replace spaces with hyphens, strip invalid chars
session=$(echo "$raw" | tr ' ' '-' | sed 's/[^a-zA-Z0-9_-]//g')

# Attach to existing tmux session, or create a new one if it doesn't exist.
# Uses -A flag: attach if session exists, otherwise create it.
# (The previous `exec cmd1 || exec cmd2` pattern was broken — exec replaces the
# shell, so the || fallback never runs if the first command exits with an error.)
exec tmux new-session -A -s "$session"
