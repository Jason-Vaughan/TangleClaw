#!/usr/bin/env bash
# Vercel "Ignored Build Step" entry point (#2258). Vercel runs this command
# before each build; exit 0 skips the build, any other exit code proceeds.
# The decision itself lives in lib/roadmap-vercel-guard.js, which this just
# calls into so the logic stays unit-testable without a shell harness.
#
# Root-level vercel.json wires this script for repository-root evaluation. The
# website-root config carries the equivalent branch check in-place. Because
# gh-pages has no website directory or config file, the Operator must also set
# the project-level branch exclusion described in the #2258 cutover runbook.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if node -e "process.exit(require('./lib/roadmap-vercel-guard').decide() ? 0 : 1)"; then
  echo "vercel-ignore-gh-pages: skipping build (ref=${VERCEL_GIT_COMMIT_REF:-unset})"
  exit 0
fi
echo "vercel-ignore-gh-pages: proceeding with build (ref=${VERCEL_GIT_COMMIT_REF:-unset})"
exit 1
