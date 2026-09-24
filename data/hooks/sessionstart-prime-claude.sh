#!/bin/bash
# TangleClaw SessionStart prime injection.
# Reads .tangleclaw/session-prime.md from the project root and emits to stdout,
# which Claude Code injects as hidden model context (no scrollback noise).
# Always exits 0 — failure is silent so the session never blocks on this hook.

# set -u: catch typos in $VAR references (the original `set +e` was a no-op since
# errexit is off by default in bash). All env-var dereferences below use ${VAR:-}
# defaults so an unset CLAUDE_PROJECT_DIR does not crash the script.
set -u

# Why SessionStart fired (#1761). Claude Code sends the event as JSON on stdin,
# with `source` one of startup|resume|clear|compact. Read with a timeout so a
# caller that never closes stdin cannot hang the session, and parsed with sed
# alone so the hook needs no jq. Anything missing or unparseable reads as a
# startup, which is exactly what this hook did before it read stdin at all.
HOOK_SOURCE=""
if [ ! -t 0 ]; then
  HOOK_INPUT=""
  IFS= read -r -d '' -t 1 HOOK_INPUT || true
  HOOK_SOURCE="$(printf '%s' "$HOOK_INPUT" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1)"
fi

PRIME_FILE="${CLAUDE_PROJECT_DIR:-}/.tangleclaw/session-prime.md"

# After `/clear` or a compaction the prime is re-delivered to a session that is
# already running. The re-entry preamble goes first, so the session reads that
# this is not a new launch before it reads the prime's launch instructions.
REENTRY_FILE="${CLAUDE_PROJECT_DIR:-}/.tangleclaw/session-reentry.md"
if [ "$HOOK_SOURCE" = "clear" ] || [ "$HOOK_SOURCE" = "compact" ]; then
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$PRIME_FILE" ] && [ -f "$REENTRY_FILE" ] && [ -r "$REENTRY_FILE" ]; then
    cat "$REENTRY_FILE" || true
    echo ""
    echo "---"
    echo ""
  fi
fi

if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$PRIME_FILE" ] && [ -r "$PRIME_FILE" ]; then
  # `|| true` survives the unlikely race where the file vanishes between the
  # readability check and cat — the script still exits 0 silently.
  cat "$PRIME_FILE" || true
fi

WRAP_ADVISORY="${CLAUDE_PROJECT_DIR:-}/.tangleclaw/ui-wrap-advisory.md"
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$WRAP_ADVISORY" ] && [ -r "$WRAP_ADVISORY" ]; then
  # Inject the UI Wrap advisory decision heuristic
  echo ""
  echo "---"
  echo ""
  cat "$WRAP_ADVISORY" || true
fi

exit 0
