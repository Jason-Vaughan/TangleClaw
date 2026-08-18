#!/bin/sh
SHARD="$1"
RULES_FILE="${CODEX_PROJECT_DIR}/.tangleclaw/session-rules-${SHARD}.md"
if [ ! -f "$RULES_FILE" ]; then
  exit 0
fi
node -e "
const fs = require('fs');
const content = fs.readFileSync(process.argv[1], 'utf8');
const lines = content.split('\n').slice(1).join('\n').trim();
console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: lines } }));
" "$RULES_FILE"
exit 0
