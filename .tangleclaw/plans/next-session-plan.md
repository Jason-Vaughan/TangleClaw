# Next session — pick-up plan (rewritten 2026-07-29)

**The governing plan is now the v5 Secure Baseline.** Read
`/Users/jasonvaughan/Documents/Projects/TangleClaw/.tangleclaw/plans/v5-secure-baseline.md`
first — it carries the scope, work classification, and execution order. This file is the short
pointer plus the hard-won traps worth keeping.

Hosted mirror, readable from any device:
https://claude.ai/code/artifact/b6bc71e7-6dee-4093-b91a-ffe26530cca1

## State as of 2026-07-29

- **`main` is at v4.38.0** (`68e228c`), released, deployed, and verified running on this box.
- Working tree clean, no open PRs, `[Unreleased]` empty, suite **5100 pass / 0 fail / 1 skip**.
- All stale local branches and both dead worktrees deleted 2026-07-29 — `main` is the only branch.

## What the previous version of this file got wrong

It claimed `main` was at v4.34.0 and that `feat/710-loopback-default` was "built, NOT merged". Both
were false by the time anyone read them: chunk 1 merged as PR #742 and shipped in **v4.35.0**. A
session acting on that text would have rebuilt shipped work. Verify plan claims against the code,
never against the plan.

## Next action

**Chunk 2 of `auth-6-secure-by-default`** — the wizard provisions Caddy and forces a credential as
the default install path. Before writing any code:

1. Read `/prawduct:building`. Skipping it is this project's #1 governance failure.
2. Work in a **worktree**, not this checkout. Chunk 2 is frontend-heavy and this clone is the live
   install — `public/` edits reach the operator instantly, on an unmerged branch, with no restart.
3. Read the hand-edited-Caddyfile guard in the build plan and the `project_caddy_ingress_live_state`
   memory. The generator would clobber the live config currently holding remote access open.

Preceding it, per the v5 plan's step 3: run the clean-room harness against v4.38.0 to establish what
a fresh install actually does. The plan's most load-bearing claim — that a new install is
loopback-only and unauthenticated — is inferred from shipped defaults, not measured.

## Still owed, small

**The #654 port verification from the field install.** Elliot is Codex-only, so the check is
`grep -n "TangleClaw API" <a managed project>/.codex.yaml` → must read **3102** (not `CLAUDE.md`, as
originally asked). All engine writers share one derivation (`lib/engines.js`), so this is expected to
pass; it is the one check this dev box structurally cannot perform, since it already runs on 3102.

Also open: his confirmation that 4.38.0 landed and cleared the #759 hook error. Briefing artifact:
https://claude.ai/code/artifact/bbb4febe-12a1-41e2-a3a8-7eb00b347e73

## Still true, still binding

- **Never hand-tag this repo.** `release.yml` tags on any push to `main` that changes `version.json`.
  See `docs/release-process.md`.
- **The 5.0.0 question:** reaching 5.0.0 from 4.38.0 requires a `BREAKING:` marker in the
  `[Unreleased]` entry — nothing else produces a major. Decision and reasoning are in the v5 plan.
- Tracking issue: **#710**.

## Traps — do not re-learn these

1. **A wrap that runs on a branch whose PR already merged strands its version bump.** `main` then
   ships fixes while reporting the old version, silently in both directions. Check
   `git show origin/main:version.json` before assuming a release is real. (Recovered as PR #719.)
2. **`.prawduct/` is gitignored** — only `change-log.md` is tracked. A durable decision written there
   reaches nobody. That is how the old VPN-as-perimeter posture went stale unnoticed. Durable
   decisions go in `docs/adr/`. **`.tangleclaw/` is gitignored too, including this file** — so this
   plan is machine-local by construction; the ADR is the tracked home.
3. **Rebuilding one artifact page from another silently keeps the old prose.** Re-read rendered
   headings against the body before republishing.
4. **Editing `[Unreleased]` with a pattern that assumes a subsection** fails silently right after a
   release promotes everything out of it. Always `grep -E "^## \[" CHANGELOG.md | head -5` after.
5. **A plan file can outlive its truth.** This file did. When a chunk merges, update the plan in the
   same session — or the next session rebuilds it.
