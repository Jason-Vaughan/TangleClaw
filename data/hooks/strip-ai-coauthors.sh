#!/bin/sh
# TangleClaw commit-msg hook — strips AI co-author trailers (forward-only).
#
# Forward-only by design: commit-msg hooks fire ONLY on `git commit` for new
# commits. Existing history is never touched. To remove historical AI co-author
# trailers, use a separate `git filter-repo` pass.
#
# Toggle from TC Global Settings → Commit hygiene → "Strip AI co-author
# trailers from commits". Default ON. When OFF, TC's syncGitHooks uninstalls
# this script (drift-aware — only removes when the on-disk content is
# byte-for-byte ours; operator hand-edits are preserved with a warning).
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

# Pattern matches `Co-Authored-By:` lines naming an AI coding assistant.
# Case-insensitive across the trailer prefix and the assistant identity.
# Human co-authors (including humans with @anthropic.com / @openai.com etc.
# emails) pass through — the pattern requires an AI-vendor token in the
# NAME or DISPLAY portion of the line, not just the email domain.
#
# Catches (canonical examples):
#   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
#   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
#   Co-Authored-By: ChatGPT <noreply@openai.com>
#   Co-Authored-By: GPT-4 <bot@openai.com>
#   Co-Authored-By: Gemini <noreply@google.com>
#   Co-Authored-By: GitHub Copilot <copilot@github.com>
#   Co-Authored-By: Cursor <bot@cursor.sh>
#   Co-Authored-By: Aider <ai@aider.chat>
#
# Preserves (canonical examples):
#   Co-Authored-By: Jane Doe <jane@example.com>
#   Co-Authored-By: Alex Engineer <alex@anthropic.com>   (human at AI vendor)
#   Co-Authored-By: Maria Rivera <maria@openai.com>      (human at AI vendor)

# POSIX ERE via grep -iE. Anchored to start-of-line; the assistant token is
# required AFTER the colon BEFORE the email open-bracket (display name
# region) so a human email at an AI vendor domain doesn't false-positive.
# -i is case-insensitive across the whole pattern; the assistant token
# alternation is intentionally lowercase since -i covers the casing.
pattern='^co-authored-by:[[:space:]]+([^<]*)?(claude|opus|sonnet|haiku|gpt-[0-9]|chatgpt|gemini|copilot|aider|cursor)'

# `grep -v -E` writes only non-matching lines. Tmp + atomic rename so a
# SIGKILL mid-write doesn't truncate the commit message.
#
# grep exit codes: 0 = lines kept (some filtered or all-passthrough — both
# safe to mv since tmp contains the correct end-state); 1 = no lines kept
# (an empty-result file — happens only if the original was EMPTY, which is
# already a no-op commit git would reject — safe to mv); 2 = grep error
# (file disappeared, permission denied) — leave the message alone.
tmp="${msg_file}.tcfilter.$$"
grep -ivE "$pattern" "$msg_file" > "$tmp" 2>/dev/null
rc=$?
if [ $rc -le 1 ]; then
  mv -f "$tmp" "$msg_file"
else
  rm -f "$tmp"
fi

exit 0
