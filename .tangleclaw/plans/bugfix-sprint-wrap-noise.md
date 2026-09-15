# Bugfix Sprint — Wrap Noise, Secrets, Message Size

Status: APPROVED 2026-09-15 by the operator directly ("GO on all of it"). Issues filed by Builder the same day. It runs before Train 20. This is the program-level split; each chunk gets its own build plan when it starts.

## Issues

| Chunk | Issues |
|---|---|
| 01 — TangleClaw-owned path registry + wrap backstop | #1508, #1509 |
| 02 — Move volatile state out of tracked files + heal on launch | #1510, #1511, #1512 |
| 03 — Content-based secret check in the wrap | #1513 |
| 04 — Messaging body limit + clear "too long" errors | #1514 |
| 05 — Wrap friction found 2026-09-15 (added after approval) | #1515 (drawer repaints a Retry as a restart), #1516 (priming-roll drops plans whose issues are all closed) |

Chunk 05 is independent of 01–04. #1515 touches `public/`, so it is built in a worktree. #1516 builds the GitHub issue-state lookup as a shared, cached module that Train 20 Chunk 03 reuses.

## Evidence this plan is built on (measured 2026-09-15, not recalled)

- **Scan across all registered projects** (read-only git status): 36 projects have uncommitted files, and most of those files are TangleClaw's own. `CLAUDE.md` is dirty in 22 projects, `.tangleclaw/project.json` in 20, `.claude/settings.json` in 13, `.tangleclaw/medusa/registry.json` in 13, `continuity/*` in 11, `project-version.txt` in 10, `AGENTS.md` in 7, `ui-wrap-advisory.md` in 7.
- **These are tracked by git:** `.tangleclaw/project.json` in 22 projects and `medusa/registry.json` in 13. An ignore rule can't fix a tracked file.
- **What actually changed**, sampled from diffs in 5 projects:
  - `project.json`: the churn is `lastWrapSha` rewritten on every wrap, plus schema migrations adding keys (a one-time change).
  - `CLAUDE.md`: a ~165–179-line TangleClaw managed block appended.
  - `.claude/settings.json`: −14 to −17 lines, which is TangleClaw removing its own hooks when they moved to `settings.local.json`.
  - All of these are **edits TangleClaw made to files the project tracks, which were never committed.**
- **Message size:** `server.js` sets `MAX_BODY_SIZE = 10 KB`. The send, loop, loops/:id/continue and `/command` routes all use that default. Live test: a ~11 KB body is rejected with 413; ~9 KB passes the size check. `public/` doesn't handle `BODY_TOO_LARGE`.
- **Reusable piece:** `lib/secret-scan.js` already exists (`scanText`), used by `lib/transcript.js`.

## Scope correction (not dropped silently)

The Coordinator's 3-item list left out the item about **why TC's edits to tracked files (CLAUDE.md, .claude/settings.json, project.json key migrations) stay uncommitted**. The evidence shows this is the single largest source of noise, so it's included here as its own issue in Chunk 01. Moving state out of files can't fix it, because those files are supposed to be tracked.

## Advisory

- Order is **backstop first**. Chunk 01 relieves every wrap right away, using only a classification change: no migration, nothing moved on disk. The riskier state move comes second, once the classification it relies on exists.
- Automatically including TangleClaw's own edits in a wrap commit is only safe when the change is **provably TC's**. For example: every changed hunk is inside the `BEGIN/END:tangleclaw` markers, or the settings.json diff only touches TC's hook entries. Anything mixed stays "not this session's" exactly as today. That limit is what keeps the #1406 boundary intact.
- The heal-on-launch step must never create a commit. Removing a file from tracking (`git rm --cached`) is a commit, so it's only ever offered in the wrap, with approval.

## Chunks

### Chunk 01 — TangleClaw-owned path registry + wrap backstop

- **NEW `[bug] The wrap asks the operator about TangleClaw's own files`.**
  - New module that is the single source of truth for TC-owned paths: machine state (`.tangleclaw/project.json` volatile keys, `medusa/registry.json`, `continuity/`, `project-version.txt`, `session-prime.md`, `ui-wrap-advisory.md`, `session-rules-*.json`) plus the managed-block files resolved per engine (`configFormat.filename`, never a hard-coded `CLAUDE.md`).
  - `_file-ownership` treats these as TC-owned, never foreign.
  - Acceptance: a wrap on a tree that only has TC files dirty asks nothing; the operator's own files are still asked about; tests use real `git status` output.
- **NEW `[bug] TangleClaw's edits to tracked files are never committed (managed block, hook removal, config migrations)`.**
  - A change counts as TC maintenance when:
    - every hunk is inside the engine config file's `BEGIN/END:tangleclaw` markers, OR
    - the `.claude/settings.json` diff only removes or adds TC hook entries, OR
    - the `project.json` diff only changes keys TC's migrations own.
  - The wrap commits TC maintenance and names it in the wrap summary. A mixed diff stays foreign.
  - Acceptance: a pure managed-block diff is committed; a diff with one operator line outside the markers is asked about; engine-agnostic (tested with `AGENTS.md` too).

### Chunk 02 — Move volatile state out of tracked files + heal on launch

Depends on 01.

> **Operator ruling 2026-09-15 (Chunk 02 start): only `lastWrapSha` moves.** The other machine-state files stay where they are, handled by the local exclude (#1511) and the one-time un-track offer (#1512). Moving `session-prime.md` would break engine hooks already installed in other projects, and a moved tracked file becomes a deletion nobody commits. Chunk plan (archived with its PR): `.tangleclaw/plans/archive/bugfix-sprint-chunk-02-state-out-of-tracked.md`.
>
> **Owed after merge: `VRF-1512-untrack-offer`.** From a remote browser, check the session-files Stop tracking / Keep tracking prompt: the exact paths shown, neither choice preselected, both themes, phone width. Check that Stop tracking removes the paths in the wrap commit and the files stay on disk. Check that Keep tracking isn't asked again. Check that a launch writes the `BEGIN:tangleclaw-state` exclude block and the `TangleClaw housekeeping:` prime line. #1512 closes on merge, so this line is what keeps the check visible until it is done. The bullet below that says the files move is superseded by this ruling.

- **NEW `[bug] Move TangleClaw's frequently changing machine state out of files projects track`.**
  - `lastWrapSha` and the other volatile keys move from `.tangleclaw/project.json` to an untracked state file TC owns. Durable config stays in `project.json`.
  - `medusa/registry.json` and the other machine-state files move under the same untracked location.
  - Persisted-format questions the data must answer: What is the last wrap boundary for this checkout? Which workspace id does this project hold? Which TC version stamped it? When was it migrated?
  - Every reader goes through one accessor (the existing `_config-root` / `project-config` family). Enumerate every reader of `lastWrapSha`: `grep -rln lastWrapSha lib` hits 10 files today.
  - Acceptance: two consecutive wraps leave `project.json` byte-identical; `wrap-scope` still resolves the boundary from the registered checkout on a worktree wrap.
- **NEW `[feature] Heal TangleClaw state on launch (migrate + local exclude, never commits)`.**
  - At launch: idempotently migrate old keys out of `project.json`, add TC state paths to `.git/info/exclude` (never `.gitignore`), and add a one-line honest report to the prime.
  - Plain git, so identical on every engine. Not a repository → an honest skip reason.
  - Acceptance: a second launch changes nothing; a repo with no `.git` dir (worktree `.git` file) resolves the real git dir; nothing creates a commit.
- **NEW `[feature] One-time offer in the wrap to stop tracking TangleClaw state`.**
  - Where a TC state file is still tracked, the wrap offers a single `git rm --cached` for those paths, shown with the exact paths and needing explicit approval. Declining is remembered.

### Chunk 03 — Content-based secret check in the wrap

- **NEW `[security] Flag likely secrets in files a wrap would commit`.**
  - A mechanical wrap step that runs before commit and reuses `lib/secret-scan.js` on the staged candidate set: this session's files plus TC maintenance and any operator-included files.
  - Flag only: a hit blocks committing THAT file until the operator decides, shows the file and the rule matched (never the secret value), and records the outcome in the activity log.
  - Also scans the "not this session's" list, so a secret sitting in the tree is flagged even when nobody picks Include.
  - Acceptance: a fixture holding a real-format token is flagged and not committed; a binary or oversized file is skipped with a stated reason; the secret value never appears in logs, the drawer or the activity row.

### Chunk 04 — Messaging body limit + clear "too long" errors

Touches `public/`, so it's built in a worktree. Visual change: yes.

- **NEW `[bug] Switchboard and command messages over 10 KB fail with no explanation`.**
  - `maxBodySize: 64 * 1024` on `<prefix>/send`, `<prefix>/loop`, `<prefix>/loops/:loopId/continue` and `/api/sessions/:project/command` (the same pattern the session-rules routes use). Applies to both the project and master prefixes.
  - A 413 response carries `{limitBytes, receivedBytes}`.
  - The UI message box shows a live size count and a warning before sending, and renders the 413 as "message is X KB, limit is 64 KB".
  - `tc message send` reports the same.
  - Acceptance: a 60 KB message is delivered; a 70 KB one gets the clear error on all three surfaces; operator verification from a remote browser (MagicDNS URL).

## Partition

- Chunks 01 → 02 are serial: 02 depends on 01's registry.
- 03 and 04 are independent of both and of each other. They could be delegated in parallel in separate worktrees once 01 has merged. Decide at the start of 02.
- **Decided at the start of 02 (operator, 2026-09-15): 03, 04 and 05 are delegated in parallel worktrees now**, and Builder integrates them. 02 merges first, and the others rebase onto it.

## Docs & bookkeeping (every chunk)

CHANGELOG `[Unreleased]`: `### Fixed` for chunks 01, 02 and 04, `### Security` for 03. Also FEATURES.md where behavior is visible, and a Critic review per chunk.
