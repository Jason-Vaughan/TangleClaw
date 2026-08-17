# First-Install Hardening — state as of 2026-07-27 00:30

**Origin:** a friend ("Elliot", GitHub `GURULifeline`) installed TangleClaw for the first time on 2026-07-26. Six real defects fell out of one install. This plan tracks the workstream to completion, and the release path that gets the fixes to him **and to everyone who installs TC from here on**.

**Why this file exists:** the fixes are only half the job. Until the release/notify chain is dependable, a fix on `main` reaches nobody. Read the "Release path" section before assuming a merged fix is delivered.

---

## Shipped and merged

| # | What | State |
|---|---|---|
| **#654** (PR #714) | Server port derived from one place — `httpsSetup.effectiveServerPort(config)`. Three *reporting* sites named a dead port; the listen call was already correct. | merged |
| **#712** | Elliot's docs PR — HTTP/HTTPS refresh-loop recovery. Change-log heading corrected `### Documentation` → `### Internal` on his branch before merge. | merged |
| **#715** | `CONTRIBUTING.md`: issues preferred over PRs (with reasoning), install/first-run reporting checklist, CHANGELOG subsection→bump table. | merged |
| **#718** | `.gitignore` for generated engine configs (`.codex.yaml`, `.aider.conf.yml`, `.antigravity.md`) — containment for #708. `CLAUDE.md` deliberately excluded (plugin-governed, tracked). | merged |
| — | **`v4.32.0` tagged + GitHub Release created** at `0a8341a`. First tag since `v4.31.1`. | done |
| **#719** | Landed the stranded 4.32.1 version bump. The 2026-07-26 wrap ran on the #708 branch *after* PR #718 had auto-merged, so its bookkeeping commit (`version.json` 4.32.0 → 4.32.1, `[Unreleased]` → `## [4.32.1]`) sat unpushed on a closed-PR branch while `main` carried the #654 and #708 fixes still reporting 4.32.0. Cherry-picked onto `main`. | merged |
| — | **`v4.32.1` tagged + GitHub Release created** at `7da67de` (the #719 merge commit, verified to carry `version.json` 4.32.1 before tagging). Delivers #654 + #708. | done |

## In flight

**PR #717 — #707 default-engine availability.** CI green. Both Critic BLOCKING findings fixed (retired-engine copy naming Gemini; `_masterRuntime` bypassing the injected `enginesLib`). **18 warnings remain — do not merge as-is.** Outstanding:

1. **The fix is incomplete against its own purpose.** The Create-project drawer POSTs `config.defaultEngine` explicitly, short-circuiting `data.engine || resolveDefaultEngine(config)`; Master settings can pin `settings.engine`, which `_masterRuntime` honors unconditionally. Both reproduce the original symptom.
2. **Asymmetric picker gating.** The wizard disables uninstalled options; `buildEngineOptions` (`public/ui.js:18`, used by Settings / per-project / Create) labels but leaves them selectable; the Master picker does neither. Note `buildEngineOptions` already existed — the wizard's is a fourth hand-rolled `<option>` builder and should probably converge.
3. **Five of six wired call sites untested** (`createProject`, `attachProject`, `syncAllProjects` hoist+skip, both HTTP routes).
4. **Per-item detection shellouts** — `resolveDefaultEngine` is called inside the loops at `server.js:1071` and `:1800`, unconditionally in `attachProject`, and on every `GET /api/master/status`. The `engineList` param exists for this and is currently test-only. `syncAllProjects` in the same commit hoists it and documents the cost.
5. **`syncAllProjects` edit may be dead** — `engine_id TEXT NOT NULL DEFAULT 'claude'` means `project.engineId` is never falsy, so `if (!engineId) continue` is unreachable; and were it live it would skip the #247 git-hooks sync, whose comment says it is deliberately NOT gated. Existing `claude` rows also get no repair.
6. **Bulk-route skips are invisible** — `public/setup.js` never reads `result.warnings`; the import path logs to `console.warn` only; no server-side log at either site.
7. **`available[0]` is `readdirSync` order** — unsorted, unpinned, unlogged.
8. **Doc drift** — `docs/configuration-reference.md:23` and `README.md:245` still describe `defaultEngine` as the value that gets used, with no effective-vs-shipped note (that table already carries one for `serverPort`/`ttydPort`).

Full findings: `.prawduct/.critic-findings.json` (review `rev-20260727T000051Z-99078162`). After fixes run `/prawduct:critic verify-resolutions`, not a full re-review.

## Open issues, in recommended order

1. **#713 — wrap bumps the version but never tags the release.** *Highest leverage.* The 14-step wrap has `version-bump` and no tag step, so tagging is a manual suggestion that was skipped for 4.31.2 → 4.32.0 (five releases). Nothing in the update chain has input without it. Until this lands, **every release needs a manual tag** or nobody is notified.
2. **#711 — update path incomplete.** Moves source only (no deploy-asset/system-dep provisioning; note there is no `package.json` — TC is zero-dependency, so this is *not* an `npm ci` step). Fails closed on a dirty tree with no in-product way out. Plus the **fork-origin trap**: `checkForUpdate()` polls `git ls-remote --tags origin`, and a fork's tags are frozen at creation — a fork install reports "up to date" forever.
3. **#716 — notification isn't dependable.** Reports "up to date" before any check has run (`checkedAt: null` unconsumed); 24h-only cadence with no on-demand or on-focus check; no manual "check now". Also: apply→restart is client-chained, so a closed tab splits the two halves.
4. **#709 — a dead server renders as an endless "Connection lost. Retrying…" loop** behind the SW-cached shell. Every cause of "server down" collapses into one unreadable symptom. This is the diagnosability multiplier that cost this session hours.
5. **#710 — HTTPS + login gate from a standard install** (currently behind the manual Caddy cutover). Has open design questions: does the wizard drive the cutover, or does direct mode grow its own auth? Decide before coding.
6. **#708 — the scan attaches TC's own clone.** Containment shipped (#718); the exclusion itself is still open. Key on the repo's own path (`path.resolve(__dirname, '..')`, as `lib/update-applier.js:20` does), not on marker absence — this repo has no `package.json`, so the git branch alone matched.
7. **#707 — finish PR #717** per the list above.

## Release path (read before assuming a merged fix is delivered)

The chain is **detect → notify → operator clicks → apply + restart**. Verified working end-to-end in a scratch clone on 2026-07-26: pinned a clone at `v4.31.1`, `checkForUpdate()` reported `4.31.1 → 4.32.0` with the correct release URL, `applyUpdate()` fetched and checked out `v4.32.0`, `version.json` confirmed. **The mechanism was never broken — it was starved of tags.**

To cut 4.32.1:

1. **Operator runs Session Wrap from the dashboard.** This is the only thing that bumps `version.json` and promotes `[Unreleased]`; merging PRs does not. It opens its own `wrap/…` PR that must merge first.
2. Tag the commit that carries the bumped `version.json`:
   ```bash
   git tag -a v4.32.1 <wrap-commit> -m "TangleClaw v4.32.1"
   git push origin v4.32.1
   gh release create v4.32.1 --title "v4.32.1" -F <notes-from-CHANGELOG-section>
   ```
3. **Tag/version must agree.** Tagging a tree whose `version.json` still says 4.32.0 would make every install see a permanent phantom "update available" — it would apply the update and still read the old version.

## Elliot's machine — state and what he owes

- `origin` → `Jason-Vaughan/TangleClaw` ✅ (**not** a fork, so the fork-origin trap does not apply — he is reachable).
- Installed version **4.32.0**; newest release is now **v4.32.1** (released 2026-07-27 00:53 UTC) → **an update pill is now the correct reading.** Verified against the real remote: `findLatestVersion(parseTagsOutput(git ls-remote --tags origin))` → `v4.32.1`, and `compareSemver` against a 4.32.0 install returns `updateAvailable: true` with `releaseUrl` resolving.
- **Two separate things gate whether he sees and can take it**, and only the second needs action from him:
  1. *Detection* — `startChecker` (`lib/update-checker.js:252`) checks 60s after boot, then only every 24h. A long-running server can lag up to a day; a restart forces a check within a minute. No manual "check now" exists — that is #716.
  2. *Application* — the applier fails closed on two guards he currently trips: dirty tree (`_fail('dirty-tree', …)`, `lib/update-applier.js:102`) and non-`main` HEAD (branch check, `lib/update-applier.js:66`). **Update & restart would refuse even with the pill showing** until he runs the cleanup below.
- Self-healing note: 4.32.1 contains the #718 `.gitignore` fix, so once he is on it, TC generating `.codex.yaml` into its own clone stops re-dirtying the tree and stops re-blocking future updates.
- `config.serverPort: 3101`, `httpsEnabled: false`, while the service runs on **3102** (the plist's `TANGLECLAW_PORT`). **This is #654 live**: every managed project's `CLAUDE.md` currently tells its agent the API is at `:3101`, so all PortHub/shared-docs calls fail silently.
- Working tree **dirty** (untracked `.codex.yaml` — TC generated it, see #708) and HEAD on `docs/http-https-refresh-loop`. Both trip the updater's guards, so **Update & restart would refuse** until he cleans up. His branch work is already merged via #712, so nothing is lost.
- His Codex agent is **sandboxed without loopback access** — network probes return `000` while the dashboard works fine. Local git commands succeed. Never read an agent's failed curl as "server down" here.

His steps, before the release:
```bash
cd <his TangleClaw clone>
git stash push -m "codex install fixes"
git checkout main && git pull
launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server
```

**Verification owed (closes PR #714's one acknowledged coverage gap).** This dev machine has `serverPort: 3102`, so it *cannot* reproduce the drift. His can. After he updates and restarts:
```bash
grep -n "API base URL" <any managed project>/CLAUDE.md   # must read :3102, not :3101
```

Then: **v4.32.1 is now tagged and released**, so a restart on his side should surface a pill reading **"v4.32.1 available — [Update & restart]"** within ~60s. One click should fetch, check out, restart, and reload. That run is the first end-to-end proof of the update path on a second machine.

**A lesson worth keeping from the #719 stranding.** A wrap that runs on a branch whose PR has already merged leaves its bookkeeping commit orphaned — the branch is closed, so nothing carries the version bump to `main`, and `main` ends up shipping fixes while still reporting the previous version. The failure is silent in both directions: no PR is open to notice, and the release looks tag-able because `main` has the code. Check `git show origin/main:version.json` against the intended release number *before* tagging, every time. #713 (wrap tags the release) should tag from the same commit it bumps, which structurally closes this gap too.

## Method notes worth reusing

- **Tests in a TC-launched session inherit the server's environment.** This session's shell carried `TANGLECLAW_PORT=3102` from the server process that spawned the tmux session, which silently overrode config-driven assertions in three test files. Invisible in CI, which has no such parent. Affected files now clear the ambient value at module load.
- **To reproduce a bare machine locally:** `env PATH=/usr/bin:/bin node --test 'test/*.test.js'` → zero engines detected. To attribute failures, diff failing-test *names* against `origin/main` in a `git worktree` under the same conditions. This found 9 branch-only failures on #707 that CI (which has git but also no engines) would have surfaced only partially.
- **Run the suite in both environments** for anything reading `process.env` or shelling out to detect tooling. CI exercises exactly one.
