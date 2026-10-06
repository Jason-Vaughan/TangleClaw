---
artifact: build-plan
version: 2
scope: 2020-dryrun-a1-tooling
---

# Build plan: #2020 dry-run attempt-1 tooling fixes (candidate aebd6960)

Dispatch: PM, 2026-09-30 19:14Z (Medusa 7e0a4059), with Architect authorisation under the self-healing loop.
Scope: triage TC-RM09's attempt-1 handoff (Medusa 50a7bf0e). Fix every tooling or test-bed cause inside the
Rule #153 (b) allowlist. Report anything that is candidate application behaviour, unfixed. Do not merge.
Branch: fix/2020-dryrun-a1-tooling from origin/main aebd6960.
Evidence: /Users/jasonvaughan/tc-soak-530-aebd6960-judge/dry/attempt-1-evidence/

Allowlist (Rule #153 b): deploy/soak/**, lib/soak/**, scripts/soak.js, scripts/rc-cert.js,
lib/release-certification/**, docs/runbooks/soak-*, deploy/soak/README.md, test/soak-*,
test/release-certification*, test/_release-certification-*, test/rc-cert*, CHANGELOG.md, .prawduct/**.
This plan lives in .prawduct/ rather than .tangleclaw/plans/ because the allowlist excludes the latter.

## Triage

T = tooling or test-bed. E = environment. C = candidate application behaviour.

| # | Failure | Class | Root cause | Fix |
|---|---|---|---|---|
| 1 | engine.session.medusa-cycle NOT_LISTENING 6/6 | T | Seeded project.json lacks `medusaEnabled` (lib/soak/repos.js seedFiles), so no listener ever starts. Also, no Medusa hub is provisioned in the offline guest, although the README's target prerequisites require one. | Seed half: Chunk 01. Hub half: Chunk 03 (stub hub, PM Option B). |
| 2a | browser.dashboard.load NOT_RENDERED 12/12 | T | Fresh install has `setupComplete:false`. The first-run wizard returns before loadStats, so `#statUptime` never fills. Guest setup never completes setup. | Chunk 1: guest-setup finishes setup (POST /api/setup/complete). Chunk 2: distinct SETUP_WIZARD code. |
| 2b | browser.terminal.attach NOT_RENDERED 8/8 | E (medium) | session.js sets the iframe src inside requestAnimationFrame, which never ran. The page is hidden or undrawn: host-provision boots `--no-graphics`, and display sleep or lock may also apply. No /terminal/ request was ever made. | Chunk 2: provision with a display, keep it awake, and add a PAGE_HIDDEN preflight code in browser.js. |
| 3 | engine.session.wrap-cycle WRAP_BLOCKED at session-files 8/8 | T | The startup project sync scaffolds an untracked `.tangleclaw/memories/MEMORY.md`. session-files correctly treats it as not the session's file. | Chunk 1: seed MEMORY.md with the exact scaffold text (the same move as the CHANGELOG seed). |
| 4 | api.plans.read NOT_LISTED 4/4 | T | Nothing creates `.tangleclaw/plans/soak-plan.md`, although the README lists it as a prerequisite. | Chunk 1: seed it. |
| a | no /usr/local/bin | T | guest-setup installs into SOAK_BIN_DIR without creating it. | Chunk 1. |
| b | projectsDir ~/Documents/Projects (TCC hang) | T | The install seeds no config.json, so the app default wins. | Chunk 1: guest-setup step 5 finishes setup with projectsDir set to SOAK_PROJECTS_ROOT, then checks it. |
| c | admin git safe.directory | T | The runbook sets it for soakrun only. The rc-cert start step is also missing from the runbooks. | Chunk 2. |
| d | safaridriver for non-admin needs _webdeveloper | T | Runbook step 3 `sudo safaridriver --enable` is not enough. | Chunk 2: dseditgroup step, and let the workload verifier allow the group. |
| e | softnet closure (A7) and infinite lease (A8) | T | host-provision and the README do not have the softnet flags. The DHCP gate assumes a renewal. | Chunk 2. |
| f | Screen Sharing on in base (5900) | not exposed | pf `block drop all` and only TCP 22 from the host pass. | Chunk 2: document it. |
| g | rc-cert publish INVALID_SAMPLE | T | runner.js mono clock is fractional `performance.now()`, and qualifiedMs must be an integer count (scorecard isCount). Every publish after the first fails. | Chunk 1: integer monotonic clock, with a regression test. |
| h | reboot resets pf | T | The runbook never says to re-run guest-setup after the closure boot. | Chunk 2. |
| S | dir-scanner probes ~/Documents | C, by design | The system-health Full Disk Access detector probes `homedir()/Documents` on purpose (lib/system-health.js TCC_PROBE_SUBDIR) and ignores projectsDir. It times out and backs off. | Not fixable here. Report it for the verdict taxonomy. Granting Full Disk Access in the guest would be a security change and needs an Architect ruling. |

## Chunks

### Chunk 01: Harness code — seed, guest setup, rc-cert clock

- **Description:** The seed and guest setup give the load the target the executors read, and rc-cert publishes whole-ms qualified time. Guest setup uses the setup wizard's Finish route: Skip refuses a loginless install with ADMIN_REQUIRED.
- **Branch / PR:** fix/2020-dryrun-a1-tooling, PR #2066
- **Deliverables:**
  - `lib/soak/repos.js`: the seed gains medusaEnabled, wrapAutoPrEnabled, releaseMode, soak-plan.md and MEMORY.md.
  - `deploy/soak/guest/guest-setup.sh`: creates SOAK_BIN_DIR, and finishes setup through POST /api/setup/complete with noLogin and projectsDir, then checks it; a refusal names its code.
  - `lib/release-certification/runner.js` and `state-machine.js`: a whole-ms clock, and a whole-ms monoAt.
  - New `test/soak-repos-attach.test.js`; updates to the soak-guest and release-certification tests.
- **Acceptance criteria:** the regression tests fail before the fix; the suite is green; the Critic finds no blocking; the PR is open.
- **Done when:** the PR is open with a clean review.

### Chunk 02: Provisioning, runbooks, browser codes

- **Description:** Item (e) follows A8: an infinite lease, so the lease value is recorded and IP/SSH stability monitored, with no renewal expected. The terminal E item is RM09's environment remediation; the tracked side is the PAGE_HIDDEN code and the display setting.
- **Branch / PR:** fix/2020-dryrun-a1-runbooks, stacked on #2066
- **Deliverables:**
  - `deploy/soak/guest/host-provision.sh`: `--closure` (the A7 softnet flags) and SOAK_TART_DISPLAY; the default goes in `deploy/soak/guest/guest.conf`.
  - `lib/soak/browser.js`: SETUP_WIZARD and PAGE_HIDDEN via PAGE_STATE_PROBE.
  - `docs/runbooks/soak-install-the-candidate.md`: steps 2, 6, 11, 11b (new) and 12.
  - `docs/runbooks/soak-run-sample-and-bundle.md`: steps 3 and 3b (new).
  - `deploy/soak/README.md`: the closure, the display, known limits (two isolation layers, a pre-T+0 restart, Screen Sharing, A8) and the browser codes.
  - `test/soak-browser.test.js` and `test/soak-guest.test.js`.
- **Acceptance criteria:** the new tests fail before the change; the suite is green; the Critic finds no blocking; the PR is open.
- **Done when:** the PR is open with a clean review.

### Chunk 03: Medusa stub hub

- **Description:** The PM chose Option B (Medusa ff69a0a1): a minimal loopback stub hub under deploy/soak/ that speaks what lib/medusa-listener.js expects. Spec: `.prawduct/artifacts/2020-medusa-stub-hub-spec.md`. The ~/Documents probe and the setup wizard are settled; leave the probe as-is.
- **Branch / PR:** its own branch, stacked on Chunk 02
- **Deliverables:**
  - `deploy/soak/medusa-stub/`: an HTTP server plus an RFC 6455 WebSocket server, bound to loopback.
  - `deploy/soak/guest/guest-setup.sh`: starts the stub and leases its ports in the guest's PortHub.
  - README and runbook updates.
  - `test/soak-medusa-stub.test.js`: drives the real TangleClaw listener against the stub.
- **Acceptance criteria:** a TangleClaw listener reaches `listening` against the stub, and a direct message is delivered and read (the medusa-cycle contract); the suite is green; the Critic finds no blocking; the PR is open.
- **Done when:** the PR is open with a clean review.

## Status

- [x] Chunk 01: Harness code — seed, guest setup, rc-cert clock (PR #2066)
- [x] Chunk 02: Provisioning, runbooks, browser codes (PR #2067)
- [x] Chunk 03: Medusa stub hub (PR #2068)
