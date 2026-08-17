# Plan: Complete the update path (#711)

**Status:** RATIFIED 2026-08-14 — operator ruled **git-checkout-based** ("keep what's working"; npm supply-chain risk cited re the recent npm compromise). Chunks below are buildable in order; no code written yet.
**Hosted mirror (keep this link, update in place):** https://claude.ai/code/artifact/74b6f411-89eb-4b46-b2c0-03545970be5a
**Issue:** #711 (OPEN). Last car of the First Install train (#708 ✅ #709 ✅ #401 ✅ all shipped 2026-08-14).
**Author:** dev session 2026-08-14, after the v5.0.0 release and VRF-ub-self-update (verified green:
the current applier correctly moves 4.38.0 → 5.0.0 when no deps changed — the gaps below are about
releases that DO ship more than source).

## The fork — RULED: git-checkout (2026-08-14)

The issue names it: does TangleClaw stay a **git-checkout install** (self-update = fetch/checkout +
now provisioning), or move toward a **packaged artifact** (npm package / release tarball) where
provisioning is the installer's job?

**Recommendation: stay git-checkout-based for now.** Reasons: (1) the entire field reality is one
installer (Elliot) on a git clone — a packaging pivot serves zero current installs and delays fixes
they need; (2) the repo IS the live install on every machine we run (dev box, elkaholic, guests) —
packaging would fork dev from field behavior; (3) `release.yml` and the tag-driven checker already
work; provisioning is the missing 20%, not the model. Revisit packaging when there are installs we
don't personally know about.

## Chunks (assuming git-checkout ruling)

### Chunk 1 — Post-checkout provisioning (Gap 1) — ✅ SHIPPED 2026-08-14 (PR #927 merged, live on 44ee9c9), RE-SCOPED
**RE-SCOPE (recorded 2026-08-14, Critic R-6):** the original sketch ran `npm ci` on a lockfile
change — but TangleClaw is **zero-npm-dep by ratified norm** (`dependency-manifest.md`), no
manifest has ever existed in any commit, and the operator's git-over-packaged ruling cited npm
supply-chain exposure. Running npm from the updater guards a state the norms forbid, at the cost
of an uninventoried runtime dependency and a bounded-but-long event-loop block. **Everything is
detect-and-report; the updater executes nothing:**
- A dependency manifest appearing/changing (`package.json`/`package-lock.json`) → reported as
  `provisioning.manifestChanged` (the forward guard for a norm-reversing release; the operator
  installs manually, informed, before relying on the new version).
- Deploy assets (anything under `deploy/`) → reported as `provisioning.assetsChanged`. Never
  auto-applied — the TCC/FDA silent-hang hazard (#324) rules that out, as the issue itself says.
- **Shipped shape (canonical, chunks 02–04 build against this):**
  `provisioning: { manifestChanged: boolean, assetsChanged: string[], action: 'manual'|null }`,
  and the dashboard alerts the manual steps BEFORE the restart.

### Chunk 2 — Failure containment (Gap 2a) — RE-SCOPED, mostly VOID
With no execution in the provisioning step there is nothing to contain: the only mid-flow
failure is git itself, already reported as `git-error` with `fromSha` for one-line recovery.
Remaining candidate: automatic `git checkout <fromSha>` rollback on a checkout that lands but
fails a sanity probe. Decide at chunk time whether that earns its complexity; skipping it is a
legitimate outcome. (Original npm-ci rollback design was void once chunk 01 re-scoped — its
premise, an npm run to contain, no longer exists; and its "old node_modules still matches"
assumption was wrong anyway: `npm ci` deletes node_modules first.)

### Chunk 3 — A way off a dirty tree (Gap 2b) — ✅ SHIPPED 2026-08-14 (PR #928 merged)
`POST /api/update/apply` refusal for `dirty-tree` grows a structured payload: the actual
`git status --porcelain` list, split into **discardable** (paths TC itself is known to write into a
managed clone: `.tangleclaw/*`, `.claude/settings.json` hook blocks) and **real-work** (everything
else). UI offers "Discard these and update" ONLY when every dirty path is in the discardable set;
any real-work path keeps the hard refusal with the file list shown. The line: TC discards only what
TC wrote. Operator can widen later; we start narrow.

### Chunk 4 — Update honesty (Gap 3) — RE-SCOPED
Under zero-npm-dep there is no node_modules to reconcile. Remaining honesty gap: a manifest
present in the tree with no install performed (post-norm-reversal state) — `/api/update-status`
could surface `pendingManualProvisioning` so the pill renders it instead of clean. Decide at
chunk time; today it cannot occur.

## Open question for the operator (non-blocking)
Unattended `--auto` updates: recommend **no** for now — operator-initiated only, consistent with
the no-surprise norms. The release-train cadence memory already implies deliberate updates.

## Verification
Each chunk lands with regression tests falsified both ways; final VRF on the habitat tart guest
(now resting at v5.0.0 detached — the right starting shape), exercising a lockfile-changing update
end-to-end before Elliot is told to update.
