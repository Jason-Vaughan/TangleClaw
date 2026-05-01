#!/bin/bash
# TangleClaw SessionStart prime injection.
# Reads .tangleclaw/session-prime.md from the project root and emits to stdout,
# which Claude Code injects as hidden model context (no scrollback noise).
# Always exits 0 — failure is silent so the session never blocks on this hook.

# set -u: catch typos in $VAR references (the original `set +e` was a no-op since
# errexit is off by default in bash). All env-var dereferences below use ${VAR:-}
# defaults so an unset CLAUDE_PROJECT_DIR does not crash the script.
set -u

PRIME_FILE="${CLAUDE_PROJECT_DIR:-}/.tangleclaw/session-prime.md"
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$PRIME_FILE" ] && [ -r "$PRIME_FILE" ]; then
  # `|| true` survives the unlikely race where the file vanishes between the
  # readability check and cat — the script still exits 0 silently.
  cat "$PRIME_FILE" || true
fi
exit 0
