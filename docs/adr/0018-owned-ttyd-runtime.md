# ADR 0018: The patched ttyd runtime is self-contained, stable-path, and fail-closed

**Status:** Accepted (2026-09-25, Architect ruling for #1245). Packaging and repository work are
approved by this ADR; installation, TCC approval, live restart, rollback and certification remain
Operator/ProjectManager actions.
**Source issue:** #1245 — macOS ttyd children can deadlock while exiting and leak PTYs until ttyd
restarts.
**Builds on:** ADR 0010 (one implementation behind every surface that applies a change) and the
#1245 R22 acceptance contract.

---

## Context

The accepted A3c candidate fixes the leak at the boundary that owns it: after the websocket closes,
ttyd continues reading and discarding the Darwin PTY's output until EOF, allowing the session leader
to finish exiting. The exact candidate passed 2,000 guarded close cycles and a two-hour isolated
soak with 2,000 children started and reaped, no confirmed wedge, no lingering child and no ttyd
restart. The script-side A1 candidate still wedged six children in 1,500 cycles and is rejected as a
shipping fix.

The accepted scratch binary is not yet a deliverable. It dynamically loads libraries through
Homebrew's `opt` paths. A later Homebrew dependency upgrade can change an install name (for example,
`libwebsockets.21` to `.22`) and make that binary fail before `main`. Conversely, installing a local
tap formula leaves the executable in a versioned Cellar path. macOS Full Disk Access is granted to
the resolved executable, so moving that path makes routine upgrades an operator permission event.

The existing Homebrew ttyd must remain available as an explicit rollback target, but silently using
it when the patched runtime is missing would restore the leak while presenting the rollout as
healthy. That is not graceful degradation; it is an unannounced reversal of the fix.

## Decision

### 1. TangleClaw owns one stable ttyd executable path

The installed patched executable lives at `~/.tangleclaw/bin/ttyd`. The launchd plist and every
ingress mode obtain the ttyd executable from one shared resolver; `install.sh` and
`scripts/ingress-cutover.js` may not independently rediscover it with `command -v` / `which` after
the managed runtime has been selected.

The path is stable across TangleClaw and Homebrew upgrades. The first migration to it requires the
Operator's one-time macOS permission action. Builders never grant TCC access, edit the live plist or
restart the live job.

### 2. The runtime is reproducible from tracked inputs, not committed as a binary

The repository carries:

- a deterministic build/package entry point;
- the pinned ttyd 1.7.7 source URL and digest;
- upstream PR #1573 at its pinned revision and digest;
- the accepted Darwin A3c patch and digest; and
- a machine-readable provenance record for the compiler, build flags and dependency closure.

The executable itself is not committed. The builder verifies every fetched input before applying or
executing it, builds outside the repository and installs from a staging directory only after all
checks pass.

### 3. "Self-contained" is an acceptance property

The installed runtime must not depend on Homebrew, MacPorts, a temporary build directory or a
versioned Cellar path at process start. System libraries and frameworks shipped by macOS are allowed.
The implementation may use static libraries or a private, stable runtime bundle under
`~/.tangleclaw/`; the contract is the resolved load graph, not the packaging technique.

Before installation, an automated verifier walks the complete Mach-O dependency graph and refuses
anything outside the staged private bundle and the macOS system roots. A shallow check of the main
binary alone is insufficient because one private library can still point back into Homebrew.

Changing the link closure changes the shippable artifact. Therefore the final packaged binary—not
the earlier Homebrew-linked scratch binary—must pass the same #1245 candidate contract: 2,000 guarded
cycles, every close mode, a full two-hour isolated soak, zero confirmed wedges, zero lingering
children, zero restarts, and run-owned resources restored. Its digest and load graph become the
release provenance.

### 4. Installation is transactional and failure is visible

Build and verification happen before the installed runtime or plist is changed. Installation uses a
staged file/bundle and atomic replacement, retains the last known-good managed runtime for rollback,
and verifies executable digest, loadability and provenance before selecting it.

If the managed runtime is absent or invalid, installation/cutover refuses before restarting ttyd and
names the repair. It must not silently select `/opt/homebrew/bin/ttyd`. An explicit operator rollback
may select the Homebrew binary; the result must say that the permanent fix is no longer active and
that the watcher is again the mitigation.

### 5. One product PR; upstream is parallel and non-blocking

The #1245 product PR contains the accepted source patch, build/package/verifier path, shared runtime
resolver, installer and ingress integration, watcher/health work, harness, this ADR, rollout/rollback
instructions and corrected changelog text. The rejected A1 wrapper and its tests are reverted from
the final product tree; its failure evidence stays.

The generic A3c fix is offered upstream separately. An upstream merge does not remove the managed
runtime. TangleClaw returns to an upstream/Homebrew ttyd only after a released upstream artifact has
passed the same acceptance contract and the Operator approves a migration.

## Consequences

- TangleClaw temporarily owns a small native runtime supply chain. Pinned sources, dependency
  provenance and the full-graph verifier make that ownership explicit and testable.
- Homebrew can upgrade independently without stranding ttyd on an obsolete dylib install name.
- The executable path does not move on each formula revision, avoiding repeated path churn at the
  TCC boundary.
- A packaging failure preserves the currently selected runtime and refuses the restart. Availability
  is not bought by silently reintroducing a known leak.
- Rollback remains quick but deliberate: select the retained Homebrew ttyd, regenerate the plist,
  restart under Operator/PM authority, and leave the watcher armed. Rollback restores service, not
  the root fix.

## Rejected alternatives

- **Local Homebrew tap (D2):** dependency upgrades are convenient, but the executable remains in a
  moving Cellar path and makes TCC approval part of ordinary formula revisions.
- **Dynamic custom binary plus automatic Homebrew fallback:** a dependency break would quietly
  reactivate the known leak, defeating both the fix and its health claim.
- **Manual archive/copy of the accepted scratch binary:** it remains coupled to the current Homebrew
  ABI and has no reproducible installation or upgrade contract.
- **Wait only for upstream (D3 alone):** the production leak is recurring now; upstream timing is
  unknown, and the watcher is a safety net rather than a permanent root fix.
