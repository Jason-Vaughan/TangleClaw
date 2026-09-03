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

  # Receipt (#1063). Reaching this line is the only proof that exists that an
  # engine actually ran this hook: TangleClaw records the delivery as `written`
  # when it puts the shards on disk, and ONLY this post upgrades it to
  # `delivered`. Without it a channel that is 100% broken produces a clean
  # ledger — which is what happened during #759, across multiple sessions and
  # two projects, unnoticed.
  #
  # Shard 1 only: the shards of one launch share a delivery row, so every shard
  # posting would be N identical upgrades of the same id.
  #
  # Best-effort, and silent about it. Every failure mode here — no token, no
  # curl, server down, slow server — must leave the session's rules delivered
  # and the hook exiting 0, because a hook that fails is fed back to the engine
  # as a synthetic turn. An unsent receipt costs a row that stays `written`,
  # which is the honest state anyway.
  RECEIPT_FILE="${CLAUDE_PROJECT_DIR}/.tangleclaw/session-rules-receipt.json"
  if [ "$SHARD" = "1" ] && [ -r "$RECEIPT_FILE" ] && command -v curl >/dev/null 2>&1; then
    (
      curl -fsS -m 3 -X POST \
        -H 'Content-Type: application/json' \
        -H 'x-tangleclaw-aux: 1' \
        --data-binary "@${RECEIPT_FILE}" \
        "$(sed -n 's/.*"api"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RECEIPT_FILE")/api/tc/rule-receipt" \
        >/dev/null 2>&1
    ) || true
  fi
fi

exit 0
