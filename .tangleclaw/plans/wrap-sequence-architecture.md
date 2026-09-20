# Wrap Sequence Bottlenecks & Architecture

*Canonical record of the end-of-train wrap sequence friction and the Architect's final design rulings.*

## 1. The Problems Observed

During complex merge cycles, the automated wrap sequence consistently hit several friction points:
1. **The "Stale Branch" Trap**: `gh pr merge --squash` instantly moves `origin/main` ahead of the local checkout. The readiness script blocks on the stale branch, forcing the agent to manually `git pull` repeatedly.
2. **The launchd Desync**: A `git pull` updates disk files (`lib/`, `public/`), but the live `com.tangleclaw.server` holds old code in memory. Agents are forbidden from restarting `launchd`, breaking the automated test cycle.
3. **Chained PR Dependencies**: If a previous session opens a wrap PR (e.g. #1718 for Changelogs), the next session cannot wrap until that PR merges, or else the new wrap branch forks from a stale base.
4. **UI Bugs (#1707/#1708)**: No working cancel button, and cross-session wraps unconditionally kill the target session.

## 2. Architect Rulings

### A. The Wrap Safety Protocol (#1707 / #1708)
*   **Immediate Safety Slice:** Label the wrap drawer action `Hide`, never `Cancel`. Safe lifecycle default applies to every omitted non-modal/cross-session request; session termination requires an explicit recorded choice.
*   **Durable Patch:** A cancel acts only at a safe boundary and reports already-applied effects. Key durable holds by project + runId + action type + target. Re-evaluate at commit, push, PR creation, auto-merge arming/execution, restart, and session kill. Server-side auto-merge is allowed only when a required status check is driven by the durable ledger, so a hold arriving after arming turns the check non-green.
*   **Distinct States:** Preserve distinct states: `upstream-advanced`, `waiting-dependency`, `deployment-pending`, `cancel-requested`, and `held`.

### B. Repository & Branch Management
*   **Fetch vs Pull:** Fetch is automatic; pull is not. At wrap preflight, fetch and classify the delta. Auto-fast-forward requires all #1710 gates: live checkout on clean main, complete delta proven records-only, no wrap in flight, never stash/merge/rebase. Executable, mixed, or unknown means no checkout movement.
*   **Freeze a Base:** Freeze a base after preflight. Name the tuple exactly: baseSha, observed originMainSha, runtime/startupSha, predecessor PR number and expected identity. If origin advances unexpectedly after claim, stop and rerun preflight; never pull mid-run.
*   **Serialize Wrap PRs:** Serialize repository-mutating wrap PRs. The later run remains `waiting-dependency` until that PR is merged at the exact observed merge SHA, then fetch/classify/advance before claiming the new run. Changelog/Roadmap output remains in the predecessor wrap PR; accidental stacked wrap PRs are forbidden, and continuity while waiting uses non-repository checkpoint/publication.

### C. The `launchd` Deployment Lifecycle
*   `launchd` handling is a durable `deployment.pending` state. It is not an ad hoc restart hook. It includes exact candidate SHA, classification, fleet-quiescence evidence, and current runtime identity. No VRF may attest the candidate until the live runtime identity matches the candidate SHA.
*   The PM surfaces exactly one operator question when the full deployment transaction is ready. Decline/no response leaves both disk and process unchanged. The authorized transaction includes update, dependencies/migrations, restart, health check, and runtime-identity verification.

## 3. The #1589 DB Schema Collision Ruling
*   **Constraint Held:** The `no-DB-migration` bound holds. Use existing durable JSON capacity (`launch_sequences` row plus `ready_artifact`/`ready_digest`).
*   **Evidence Record:** Add a versioned `tc.parity-certification/1` evidence record. It must name engine id+version, config/profile fingerprint excluding its evidence subtree, deployed runtime/source identity, scenario/outcome, assistance attribution, and the launch/session/revision/readyDigest anchor. 
*   **Resolver:** A pure resolver compares the binding with current measured inputs and returns explicit result vocabulary: `current`, `stale`, `invalid`, `blocked`, `failed`, and explicit `N/A`. Unknown or unmeasured provenance is invalid/incomplete, never current or N/A. Missing, malformed, or changed measured inputs cannot resolve `current`. Preserve history append-only. 
*   **Contingency:** If this cannot be made mechanically valid with existing JSON, lift the no-migration bound explicitly rather than weakening certification.
