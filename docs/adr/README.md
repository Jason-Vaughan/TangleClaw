# Architecture Decision Records

Durable design decisions, each in its own file. An ADR's own **Status** line (near the top
of the file) is the authority on whether it is still in force, amended, or superseded — this
index exists only so a reader can find the right one; it does not restate the full status.

| # | Title | Status (summary) |
|---|---|---|
| [0001](0001-symmetric-capability-gates.md) | Symmetric Capability Gates | Accepted, extended twice |
| [0002](0002-wrap-pipeline-contract.md) | Wrap Pipeline Contract | Accepted, extended repeatedly |
| [0003](0003-ingress-model.md) | Reverse-Proxy Ingress (Caddy), Reversibly | Accepted |
| [0004](0004-auth-2-basic-auth-gate.md) | Authentication Gate — Caddy `basic_auth`, Forced Setup, Break-Glass Recovery | Accepted; conditionally superseded by ADR 0015 |
| [0005](0005-service-tokens.md) | M2M Service Token — Gating the Localhost PortHub & Shared-Docs APIs | Accepted |
| [0006](0006-key-ref-hygiene.md) | Key-Ref Hygiene — Detecting the Master-Key Footgun | Accepted |
| [0007](0007-project-map-freshness.md) | Project Map Freshness — Section-Scoped, Curation-Preserving, Idempotent Refresh | Accepted |
| [0008](0008-project-master-session-model.md) | Project Master — Harness-Session Singleton with a Tiered Write Boundary | Accepted; amended by ADR 0023, and by ADR 0026 (Decision 6 superseded) |
| [0009](0009-secure-by-default.md) | Secure by Default — a password out of the box, opt-out not opt-in | Accepted; supersedes ADR 0003's and ADR 0004's perimeter framing |
| [0010](0010-one-update-mechanism.md) | One update mechanism — every surface that starts an update calls the applier | Accepted |
| [0011](0011-prawduct-boundary.md) | The Prawduct boundary — TangleClaw owns the plumbing, consumes the governance | Accepted; amended |
| [0012](0012-enforcement-adds-no-install-step.md) | A norm's enforcement mechanism adds no installation step | Accepted |
| [0013](0013-settings-take-effect-or-say-why-not.md) | A Setting TangleClaw Offers Must Take Effect, Or Say Why It Does Not | Accepted |
| [0014](0014-dual-key-review-for-untrusted-prs.md) | Dual-Key Review for Untrusted PRs | Accepted; amended |
| [0015](0015-tangleclaw-owns-authentication.md) | TangleClaw owns authentication — the gate moves out of Caddy | Accepted |
| [0016](0016-tier-1-auth-build-decisions.md) | Tier 1 auth — the build decisions ADR 0015 left open | Accepted |
| [0017](0017-phased-launch.md) | Phased launch — a session's context is served, acknowledged and attested, not pushed once | Accepted |
| [0018](0018-owned-ttyd-runtime.md) | The patched ttyd runtime is self-contained, stable-path, and fail-closed | Accepted |
| [0019](0019-generated-file-provenance.md) | Generated-file provenance is opt-in, per-project, and ownership-scoped | Accepted |
| [0020](0020-session-workload-receipts.md) | A session's workload is a launch-bound receipt it asserts, composed fail-closed with what the engine is observed doing | Accepted |
| [0021](0021-public-release-certification-scorecard.md) | Release-candidate certification is judged privately on the host and published through an allowlist to a guarded `metrics` branch | Accepted |
| 0022 | *(number not in use)* | Drafted (`docs/adr/0022-operator-channel-schema.md`, #2031 — "Fold the operator channel's two stack migrations into one final schema") on a branch that never merged to `main`; the number is retired rather than reused, so this gap is deliberate and not a missing file. |
| [0023](0023-master-mediated-operator-bridge.md) | The Discord operator bridge is Master-mediated — a durable gateway carries the message, the Master session routes it, and neither is authority | Accepted for architecture only |
| [0024](0024-roadmap-release-grouping.md) | Release Versions group one or more Trains, superseding one-train-one-release | Accepted; amended |
| [0025](0025-codex-cold-start-wake-and-pane-refusal.md) | Codex cold-start wake and pane refusal | Accepted |
| [0026](0026-native-conversation-layer-and-open-hood-contract.md) | Native Conversation Layer over Persistent Harness Sessions and the "Open Hood" Non-Interference Contract | Ratified; amends ADR 0008 Decision 6 |

## Adding an ADR

Number it one past the highest number in use (checking this index, not just the directory —
a number can be retired without a file ever landing on `main`, as 0022 shows above). Add its
row here in the same commit that adds the file; don't leave the index to drift behind
`docs/adr/`.
