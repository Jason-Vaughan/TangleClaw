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
*   **Immediate Safety Slice:** Label the wrap drawer action `Hide`, never `Cancel`. Omission of lifecycle intent on any cross-session wrap must resolve to `KEEP` the session, never kill it. Ending a session requires an explicit recorded choice.
*   **Durable Patch:** A true cancel feature that stops not-yet-started steps without rollback. Persist action-scoped holds keyed by project + wrapRunId + action type. Auto-merge requires the #1717 status check backed by this ledger.

### B. Repository & Branch Management
*   **Fetch vs Pull:** Fetch is automatic; pull is not. At wrap preflight, fetch and classify the delta. A clean main may fast-forward *only* if the delta is proven records-only. Executable deltas become a pending PM-coordinated deployment transaction.
*   **Freeze a Base:** Freeze a base after preflight (record baseSha, observed originMainSha, runtime/startupSha). Never chase a moving main. If origin advances unexpectedly, stop with `upstream-advanced` and rerun preflight.
*   **Serialize Wrap PRs:** Serialize repository-mutating wrap PRs. A later wrap declares the predecessor wrap PR as a dependency and waits for its exact merge SHA. Do not create accidental stacked wrap PRs.

### C. The `launchd` Deployment Lifecycle
*   `launchd` handling is a durable `deployment.pending` state, not an ad hoc agent restart hook. 
*   It carries candidate SHA, classification, and current runtime identity. 
*   The PM surfaces exactly one operator question when the full deployment transaction is ready. A live VRF cannot attest the candidate until the runtime identity matches it.

## 3. The #1589 DB Schema Collision Ruling
*   **Constraint Held:** The `no-DB-migration` bound holds.
*   **Implementation:** Use existing durable JSON capacity (`launch_sequences` row plus `ready_artifact`/`ready_digest`) rather than migrating.
*   **Evidence Record:** Add a versioned `tc.parity-certification/1` evidence record referencing launchId, sessionId, revision, and readyDigest.
*   **Resolver:** A pure resolver compares the binding with current measured inputs and returns `current`, `stale`, `invalid`, `blocked`, `failed`, or explicit `N/A`.
