#!/bin/bash
# TangleClaw startup-rules delivery (#749).
#
# Emits one shard of the project's operator-authored rules as a SessionStart
# hook payload. Rules ride their OWN hook rather than the session prime's:
# the engine's cap on hook output is enforced by replacing the payload with a
# preview, not by shortening it, so anything sharing a channel with a large
# payload can be dropped whole and silently. A second channel means the prime's
# growth and the rule set's growth can no longer harm each other.
#
# Shard number arrives as $1 (1-based). TangleClaw writes the complete JSON
# envelope to disk at launch and this script only cats it — no shell code ever
# has to escape operator-authored prose, which is where a naive version of this
# would corrupt a rule containing a quote or a backslash.
#
# Always exits 0: a session must never fail to start because its rules could
# not be read. The absence is recorded in TangleClaw's delivery ledger instead.

set -u

SHARD="${1:-1}"
RULES_FILE="${CLAUDE_PROJECT_DIR:-}/.tangleclaw/session-rules-${SHARD}.json"

if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$RULES_FILE" ] && [ -r "$RULES_FILE" ]; then
  # `|| true` survives the race where the file vanishes between the readability
  # check and the read.
  cat "$RULES_FILE" || true
fi

exit 0
