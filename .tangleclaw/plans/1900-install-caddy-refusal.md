# #1900 — install.sh refuses on a caddy-mode host

Dispatched by the ProjectManager on 2026-09-26 (Medusa, under Architect ruling R43).
Branch: `fix/1900-install-caddy-refusal`. Archive this plan when #1900 closes.

## Confidence check

- **Problem:** `deploy/install.sh` always writes the DIRECT-mode ttyd plist (TCP 3100) and
  reloads it. On a host whose persisted `ingressMode` is `caddy`, the server expects ttyd on a
  Unix socket, so the dashboard answers 502 afterwards.
- **Success:** on a caddy-mode host the installer exits non-zero with nothing changed. It prints
  the mode-appropriate repair, and a regression test proves both by running the real script.
- **Out of scope:** changes to `scripts/ingress-cutover.js` or the ttyd runtime, a live rollout,
  and running install.sh on this host.

## Design

- The guard runs right after the Node.js check. It needs node to parse `config.json`, and at that
  point nothing has been installed, built or written. A missing config, or one without
  `ingressMode`, means direct, matching the store default.
- `ingressMode === 'caddy'` refuses with two commands: `node scripts/ingress-cutover.js --to caddy`
  re-applies the caddy-mode ttyd and Caddy plists, and `--to direct` switches the host. The refusal
  and the README say that the other install.sh assets have no caddy-mode refresh yet (#1901). Neither command points a
  caddy host back at the installer, which matches ADR 0018 §4.
- A config that exists but cannot be parsed also refuses. The mode is unknown, and `store.load()`
  throws `CONFIG_LOAD_FAILED` on the same file, so the server would not start either.
- The older post-restart mode detection and the closing "caddy but install.sh sets up DIRECT only"
  branch are removed. That branch can no longer be reached.

**[DECISION: "direct mode explicitly selected" means the persisted mode was switched with
`ingress-cutover.js --to direct`; install.sh gets no override flag.]** An install.sh flag that
went ahead on a caddy config would install the direct plist while the server still expects the
socket, which is the #1900 outage again. The cutover is the only writer of `ingressMode`, and it
already rewrites the plist and restarts. Ratified by the PM over Medusa on 2026-09-26 (no veto).

## Tests

`test/install-sh.test.js` › "ingress-mode guard (#1900, executed)". These tests run the real
script in a sandbox: real node and `which`, and stubs for `brew`, `curl` and `launchctl` that log
their calls and fail.
- An interlock asserts the guard precedes every install, build, plist write and launchctl call.
- Caddy, and an unparseable config: exit 1, HOME byte-identical, no stub called, repair named.
- Persisted direct, no `ingressMode`, and no config: the script gets past the guard and stops at
  `brew install ttyd`. An interlock asserts that happens before the real runtime build.

## Status

- [x] Guard, tests, docs (configuration reference, rollout runbook, FEATURES) and CHANGELOG
- [x] Full suite green on 46b2798d. Critic: cumulative plus verify-resolutions, 0 blocking. PR review: 0 blocking.
- [ ] PR merged (not by B1: the pilot envelope forbids B1 from merging). Archive this plan when #1900 closes.
