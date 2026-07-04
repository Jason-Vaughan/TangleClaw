#!/bin/sh
# TangleClaw commit-msg hook — strips AI co-author trailers (forward-only).
#
# Forward-only by design: commit-msg hooks fire ONLY on `git commit` for new
# commits. Existing history is never touched. To remove historical AI co-author
# trailers, use a separate `git filter-repo` pass.
#
# Toggle from TC Global Settings → Commit hygiene → "Strip AI co-author
# trailers from commits". Default ON. When OFF, TC's syncGitHooks uninstalls
# this script (drift-aware — only removes when the on-disk content carries the
# TC-OWNED-HOOK marker below at start-of-line in the first 20 lines).
#
# Owned-by-TC marker on the line below is what makes uninstall safe. Do not
# remove or modify this comment if you want TC to manage this hook.
# TC-OWNED-HOOK: strip-ai-coauthors v1

set -u

msg_file="${1:-}"
if [ -z "$msg_file" ] || [ ! -f "$msg_file" ] || [ ! -w "$msg_file" ]; then
  # No message file argument, or it's unreadable/unwritable. Silently pass.
  # Failure here would block all commits in the repo — not acceptable for a
  # cosmetic-cleanup hook. Worst case: the trailer stays in this one commit.
  exit 0
fi

# Two patterns. A trailer that matches EITHER gets stripped.
#
# Pattern A — display-name token: matches an AI-vendor word in the display
# region (between the colon and the `<email>` bracket). Word-boundary is
# enforced by requiring the token to END on whitespace OR the email
# open-bracket OR end-of-line, so substrings inside a longer name
# ("Claudette", "Sage Haiku", "Cursor Wright", "Anna Sonnet") do NOT match.
# `gpt-[0-9]+` accepts multi-digit version numbers (GPT-10, GPT-100, …).
# Leading whitespace and zero-space-after-colon both tolerated, since git's
# trailer parser accepts both and some editors pad continuation lines.
#
# Pattern B — bot-email at AI vendor domain: catches trailers whose display
# name is empty or generic (`<noreply@anthropic.com>`, `Bot <bot@openai.com>`).
# We deliberately constrain the localpart to bot-like words (`noreply`, `bot`,
# `ai`, vendor-name) so a real human email at an AI vendor — e.g.
# `alex@anthropic.com` — still passes through unchanged.
#
# Both patterns are case-insensitive via `grep -iE`. POSIX ERE; tested
# portable across BSD grep (macOS) and GNU grep (Linux).
#
# Catches (canonical examples):
#   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
#   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
#   Co-Authored-By: ChatGPT <noreply@openai.com>
#   Co-Authored-By: GPT-10 <bot@openai.com>
#   Co-Authored-By: Gemini <noreply@google.com>
#   Co-Authored-By: GitHub Copilot <copilot@github.com>
#   Co-Authored-By: Cursor <bot@cursor.sh>
#   Co-Authored-By: Aider <ai@aider.chat>
#   Co-Authored-By:Claude Opus 4.7 <noreply@anthropic.com>   (no space)
#   Co-Authored-By: <noreply@anthropic.com>                  (no display)
#   Co-Authored-By: Bot <bot@openai.com>                     (generic display)
#
# Preserves (canonical examples):
#   Co-Authored-By: Jane Doe <jane@example.com>
#   Co-Authored-By: Alex Engineer <alex@anthropic.com>   (human at AI vendor)
#   Co-Authored-By: Maria Rivera <maria@openai.com>      (human at AI vendor)
#   Co-Authored-By: Claudette Smith <claudette@example.com>  (name contains "claude")
#   Co-Authored-By: Sage Haiku <sage@haiku.dev>          (surname contains AI token)
#   Co-Authored-By: Anna Sonnet <anna@example.com>       (surname contains AI token)

vendor='(claude|opus|sonnet|haiku|gpt-[0-9]+|chatgpt|gemini|antigravity|copilot|aider|cursor)'
vendor_domain='(anthropic\.com|openai\.com|googleapis\.com|deepmind\.com|google\.com|github\.com|cursor\.sh|aider\.chat)'
bot_local='(noreply|no-reply|bot|ai|claude|opus|sonnet|haiku|gpt|chatgpt|gemini|antigravity|copilot|cursor|aider)[a-z0-9._+-]*'

# Pattern A — vendor word in display region, ending on a separator
# (whitespace, `<`, or end-of-line). The leading `[[:space:]]*` tolerates
# indented trailers; the `[[:space:]]*` after the colon tolerates no-space.
# `[^<]*?` would be non-greedy but POSIX ERE has no ungreedy quantifier;
# `[^<a-z0-9]` before vendor enforces a non-letter boundary (handles
# "Anna Sonnet" → Sonnet is preceded by space → matches that boundary;
# "Claudette" → "claude" is followed by "t" not a separator → won't match
# the trailing boundary).
pattern_a="^[[:space:]]*co-authored-by:[[:space:]]*([^<]*[^<a-z0-9])?${vendor}([[:space:]]+|<|\$)"

# Pattern B — bot-shaped localpart at AI vendor domain, regardless of
# display name. The display region is allowed to be empty or any non-`<`
# content.
pattern_b="^[[:space:]]*co-authored-by:[[:space:]]*[^<]*<${bot_local}@${vendor_domain}>[[:space:]]*\$"

# `grep -ivE` against the union of both patterns. Tmp + atomic rename so a
# SIGKILL mid-write doesn't truncate the commit message. `trap` cleans up
# the tmp on any exit path including signals — important because git
# wrappers in IDEs (VS Code, JetBrains) routinely SIGTERM the hook process
# on user cancel, and leaked `.tcfilter.<pid>` files accumulate inside the
# repo's `.git/` if cleanup is conditional.
tmp="${msg_file}.tcfilter.$$"
trap 'rm -f "$tmp"' EXIT INT TERM HUP

grep -ivE "${pattern_a}|${pattern_b}" "$msg_file" > "$tmp" 2>/dev/null
rc=$?

# grep exit codes:
#   0 = some lines kept (mix of strip + passthrough OR all-passthrough — tmp
#       holds the correct end-state, safe to mv).
#   1 = zero lines kept. Two sub-cases:
#       (a) original was empty (already a no-op commit git would reject).
#       (b) every line in the message matched an AI trailer (e.g. malformed
#           amend with body that's nothing but trailers). Overwriting with
#           an empty file would surface as git's generic "empty commit
#           message" abort, with no breadcrumb pointing at this hook.
#           Surface a stderr note so the operator can trace it back here.
#   2+ = grep error (file disappeared, permission denied). Leave message
#       alone — the original is unchanged and the trap will clean up tmp.
if [ "$rc" -eq 0 ]; then
  mv -f "$tmp" "$msg_file"
elif [ "$rc" -eq 1 ]; then
  if [ ! -s "$msg_file" ]; then
    # Original was empty too — overwriting with an empty tmp is a no-op.
    mv -f "$tmp" "$msg_file"
  else
    echo 'tangleclaw commit-msg hook: every line matched an AI co-author trailer; refusing to write an empty commit message. Original message preserved — edit it or unset stripAiCoauthors in TC Global Settings.' >&2
    # Do NOT mv. Leave the original message intact; git will use it as-is.
  fi
fi

exit 0
