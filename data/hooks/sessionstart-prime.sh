#!/bin/bash
# TangleClaw SessionStart prime injection.
# Reads .tangleclaw/session-prime.md from the project root and emits to stdout,
# which Claude Code injects as hidden model context (no scrollback noise).
# Always exits 0 — failure is silent so the session never blocks on this hook.

set +e
PRIME_FILE="${CLAUDE_PROJECT_DIR}/.tangleclaw/session-prime.md"
if [ -n "${CLAUDE_PROJECT_DIR}" ] && [ -f "$PRIME_FILE" ] && [ -r "$PRIME_FILE" ]; then
  cat "$PRIME_FILE"
fi
exit 0
