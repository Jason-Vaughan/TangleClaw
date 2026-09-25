# Dual-Builder Pilot: #1311 and #1059

**Baseline Commit:** `417faf510a6b4796d40185e9342e62558f120f35` (frozen and rechecked before dispatch)

## Overview
This is a supervised two-lane pilot running Builder1 and Builder2 simultaneously, validating the ability to coordinate concurrent workflows, test isolated changes, and integrate them serially.

## Lane Configuration
Both lanes must build concurrently from the frozen baseline.

### Lane 2 (Integrates First)
- **Agent:** Builder2
- **Issue:** #1311 ([bug] The kill modal always says "terminates the tmux session")
- **Worktree:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Pilot-B2` (must be registered separately with private mutable task/runtime state)
- **Branch:** `fix/1311-pilot-kill-modal`
- **Files Owned:** `lib/projects.js`, `public/ui.js`
- **Test Files:** `test/projects.test.js`, plus applicable UI test files (e.g. `test/sessions-webui.test.js`)
- **Tasks:** Fix projection of `sessionMode` to front-end and add cross-layer tests. Update `CHANGELOG.md` (`### Fixed`).

### Lane 1 (Integrates Second)
- **Agent:** Builder1
- **Issue:** #1059 (update-checker: back off and test-seam the synchronous origin lookup)
- **Worktree:** `/Users/jasonvaughan/Documents/Projects/TangleClaw-Pilot-B1` (must be registered separately with private mutable task/runtime state)
- **Branch:** `fix/1059-pilot-update-checker`
- **Files Owned:** `lib/update-checker.js`
- **Test Files:** `test/update-checker.test.js`
- **Tasks:** Implement failure back-off for origin lookup. Update `CHANGELOG.md` (`### Fixed`).

## Stop Conditions, Pre-code Acknowledgements & Overridden Permissions
Both projects must run with `releaseMode=off` and `versionBumpEnabled=false`.
**Pre-code acknowledgement:** Before writing any code, both Builders MUST explicitly acknowledge they have read and understood the following revoked permissions and stop conditions.

The following permissions are explicitly **REVOKED** for this pilot. Neither Builder may:
1. Merge their own or the other's PR.
2. Pull/update the live Builder1 checkout (`/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder1`).
3. Restart the live service.
4. Run the final live check against the main instance.
5. Tag, publish, or cut a release.
6. Deploy.

**Full stop conditions:**
*Builder2 stops immediately after opening its Draft PR for #1311.*
*Builder1 may open its Draft PR for #1059 before #1311 merges, but must stop. After #1311 is accepted and merged, Builder1 resumes.*

## Serial Integration & CHANGELOG Collision Protocol
1. **Concurrent Execution:** Both Builders execute and create their respective Draft PRs from the baseline.
2. **Review/Merge 1 (Lane 2):** PM coordinates review. After #1311 is verified, Operator confirms and merges to `main`.
3. **Rebase & Resolve (Lane 1):** After #1311 is accepted, Builder1 fetches `main`, rebases its branch onto the new `main` (containing #1311), and resolves any merge conflicts manually (e.g., `CHANGELOG.md`).
4. **Validation (Lane 1):** Builder1 **must rerun focused checks, the full test suite, and the Critic on the combined target** after the rebase.
5. **Review/Merge 2:** PM coordinates review. After #1059 is verified and clean, Operator confirms and merges to `main`.
6. **Integration/Live Check:** The Operator (not the Builders) performs the final live check and service restart on the main instance.

## Authorization
Authorized by Operator. Dispatch requires confirming the frozen baseline and lane-private workspace evidence.
