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

# Why SessionStart fired (#1761): the same stdin read as the prime hook, with
# the same timeout, the same startup default and the same stderr line when a
# stdin that was sent cannot be read. The shard is emitted whatever
# the source, since `/clear` and a compaction drop the rules too; only the
# receipt below depends on it.
HOOK_SOURCE=""
if [ ! -t 0 ]; then
  HOOK_INPUT=""
  IFS= read -r -d '' -t 1 HOOK_INPUT || true
  HOOK_SOURCE="$(printf '%s' "$HOOK_INPUT" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1)"
  if [ -n "$HOOK_INPUT" ] && [ -z "$HOOK_SOURCE" ]; then
    # Said, not swallowed: a stdin the engine sent but this could not read is
    # treated as a startup, and on a /clear that is the wrong answer.
    echo "tangleclaw: SessionStart source unreadable; treating this fire as a startup" >&2
  fi
fi
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
  # Startup only (a missing source counts as startup). The receipt vouches for
  # the launch's delivery, and a re-fire after `/clear` or a compaction is not
  # that event; letting it post would let an unsent startup receipt be claimed
  # by a later re-entry.
  #
  # Best-effort, and silent about it. Every failure mode here — no token, no
  # curl, server down, slow server — must leave the session's rules delivered
  # and the hook exiting 0, because a hook that fails is fed back to the engine
  # as a synthetic turn. An unsent receipt costs a row that stays `written`,
  # which is the honest state anyway.
  RECEIPT_FILE="${CLAUDE_PROJECT_DIR}/.tangleclaw/session-rules-receipt.json"
  if [ "$SHARD" = "1" ] && { [ -z "$HOOK_SOURCE" ] || [ "$HOOK_SOURCE" = "startup" ]; } && [ -r "$RECEIPT_FILE" ] && command -v curl >/dev/null 2>&1; then
    RECEIPT_API="$(sed -n 's/.*"api"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RECEIPT_FILE")"
    if [ -n "$RECEIPT_API" ]; then
      # `-k`: on an HTTPS install the API is served under a mkcert CA that this
      # shell has no reason to trust, and the connection is to the operator's
      # own machine. Without it every row stays `written` forever with nothing
      # anywhere naming TLS as the cause. Same convention the PortHub guide
      # states for these URLs.
      if curl -fsS -k -m 3 -X POST \
          -H 'Content-Type: application/json' \
          -H 'x-tangleclaw-aux: 1' \
          --data-binary "@${RECEIPT_FILE}" \
          "${RECEIPT_API}/api/tc/rule-receipt" >/dev/null 2>&1; then
        # Single use, on success only. This hook fires on every `startup` in
        # the project's own settings, so any later `claude` opened here runs it
        # too; consuming the token stops the ordinary re-post. It does NOT
        # close the case where this session's hook never ran — nothing was
        # posted, so nothing was consumed. The server's freshness window is
        # what bounds that. A failed post deliberately leaves the token, so a
        # real retry still works.
        rm -f "$RECEIPT_FILE" || true
      fi
    fi
  fi
fi

exit 0
