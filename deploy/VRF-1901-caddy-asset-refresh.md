# VRF-1901 — caddy-mode asset refresh, authenticated (clean-room macOS guest)

Verifies #1901: on a **caddy-mode** host, `./deploy/install.sh` refreshes the deploy assets it owns (the server
launchd plist, `~/.tmux.conf`, the ttyd attach script, the dependencies and the owned ttyd runtime) **without ever
opening an unauthenticated window**, and fails closed when the ingress cutover would refuse.

It runs on a throwaway Tart macOS guest on habitat, never on a machine whose TangleClaw is in use. A real run
rewrites launchd jobs and restarts the server, and TangleClaw's home directory, database and launchd labels are
global per user (see `VRF-auth-1-cutover.md` for why a second install on the same account is not a clean room).

Conventions follow `VRF-auth-1-cutover.md`: every row is scored **PASS / PARTIAL / NOT RUN / FAIL**, only from
the execution records below, never by inference. PARTIAL does not clear the gate.

**Code under test:** branch `fix/1901-caddy-asset-refresh` @ `3db87901`.

---

## Matrix

| Phase | What it proves | Pass? |
|---|---|---|
| C | Clean-room provenance: the guest's state is scrubbed before first boot, and Phase 0 is clean | PASS |
| 1 | A fresh direct install, then caddy mode with a login gate in force | PASS |
| 2 | Deploy assets change the way a release changes them | PASS |
| 3 | **Window probe:** across the whole caddy-mode `install.sh`, no unauthenticated request gets a protected 2xx | PASS |
| 4 | After the refresh: assets refreshed, ttyd on its Unix socket, gate intact, authenticated session works | PASS (re-scored on the security invariant by Architect ruling; see Phase 4) |
| 5 | Fail-closed: a hand-edited Caddyfile makes install.sh refuse at the preflight, with nothing changed | PASS |
| 6 | **G2 live:** a stale owned ttyd runtime is bootstrapped, the full preflight re-runs, and the refresh completes | PASS |
| T | Teardown: only the guest this run created is deleted | PASS |

Release readiness needs every row PASS. Per the Architect's ruling, the Homebrew ttyd
(`TANGLECLAW_TTYD_RUNTIME=homebrew`) may appear here only as a labelled control, never as a substitute for
row 6, and **G2 may not be claimed if row 6 is NOT RUN**.

---

## Phase C — clean-room provenance

### C.1 Why not a fresh base (recorded 2026-09-27)

Egress from habitat, probed 2026-09-27 ~08:35 PDT with `curl -I -m 8`:

| Host | Result |
|---|---|
| `github.com` | 200 |
| `raw.githubusercontent.com` | 301 |
| `formulae.brew.sh` | 200 |
| `registry.npmjs.org` | 200 |
| `ghcr.io/v2/` | **000 (blocked)**: Homebrew bottles |
| `swcdn.apple.com` | **000 (blocked)**: Xcode Command Line Tools |

A fresh `tc-base*` clone therefore can't install TangleClaw's dependencies without an operator egress window.
The Architect ruled (2026-09-27): clone `tc-vrf-v5` **as a stopped, read-only source only**, scrub all copied
state before the clone reaches any network or credential, keep only the generic Homebrew and CLT toolchains,
and prove Phase 0 clean.

### C.2 The clone (recorded)

- Guests before the run: `tc-base`, `tc-base-tailnet`, `tc-c11`, `tc-vrf`, `tc-vrf-a04`, `tc-vrf-v5`, all
  **stopped**; no `tart run` process.
- `tart clone tc-vrf-v5 tc-vrf-1901-20260927`. The source `disk.img` mtime and size were identical before and
  after (`1789337871 50000000000`). The source was never booted.

### C.3 Offline scrub: the clone had never booted (recorded)

The clone's `disk.img` was attached on habitat (`hdiutil attach -nomount`, by the clone's own path), and its APFS
`Data` volume (verified `APFS Physical Store: disk4s2` of that image) was mounted read-only for inventory, then
read-write for the scrub. The guest was not running.

Removed from `/Users/admin`: `.tangleclaw`, the `com.tangleclaw.*` LaunchAgents (caddy, server and ttyd),
`Documents/Projects`, the previous run's `tc/TangleClaw` clone, `tc-scan-probe`, `vrf-802-backup`, `.gitconfig`,
`.zsh_history`, `.zsh_sessions`, `.tmux.conf`, **all of `Library/Keychains`** (including the hidden `.fl*`
entry), `Library/Application Support/mkcert` (the previous run's **local CA private key**), the install logs and
`run-install.exp`. Also removed: `private/tmp/tmux-*`.

Kept: `/opt/homebrew`, `/Library/Developer/CommandLineTools`, and `.ssh/authorized_keys`, which was verified to
equal habitat's own `~/.ssh/tc_cleanroom.pub` exactly. That's the access path, not a copied secret.

Not present in this lineage: Tailscale (no app and no `/Library/Tailscale`), `.git-credentials`, `.config/gh`,
`.netrc`, `.npmrc`, `.claude*`, `.anthropic`, `.codex`, `.gemini` and `.aider`, and no system LaunchDaemon for
TangleClaw.

Verification sweep over `/Users/admin` after the scrub: `grep -rIl` for `tcsk_…`, `ghp_…`, `gho_…`,
`github_pat_`, `sk-ant-…`, `tskey-` and PEM `PRIVATE KEY` blocks gave **zero hits**. The credential-named files
(`find -iname '*token*' …`) are stock macOS system files only (Photos history, CryptoTokenKit scripts, Apple
Private Access Tokens).

### C.4 First boot and isolation

**Recorded 2026-09-27:** an isolated first boot is not available on habitat. `tart run --net-host` failed with
`InitializationFailed(why: "softnet not found in PATH")`; `--net-softnet*` needs the same binary. habitat has
`net.inet.ip.forwarding=1`. The VM didn't start, so the clone had still never booted. The Architect was asked
how to proceed (exchange `mx_BhUFvdPrLk0vaqsO`). The ruling and what followed are recorded below.

**Ruling (2026-09-27, Architect via PM):** the independently recorded offline scrub is the isolation boundary,
since the clone had never booted. Preserve the scrub manifest and disk provenance before the first NAT boot.
Record Phase 0 before any clone, package install, authentication or credential. Clone unauthenticated. Stop and
destroy the clone if any copied identity or state appears. Verify the source is unchanged at the end.

**Provenance before first boot (recorded, habitat `~/tc-vrf-1901/provenance-before-first-boot.txt`):**

| VM | disk.img mtime / size | disk.img sha256 | nvram sha256 |
|---|---|---|---|
| `tc-vrf-1901-20260927` | `1790523845 50000000000` | `520814f0…152110ea6` | `95ba83da…baa4c4fc` |
| `tc-vrf-v5` (source) | `1789337871 50000000000` | `13bf4d2d…c0768539` | `95ba83da…baa4c4fc` |

The scrub manifest (C.3) is saved beside it as `~/tc-vrf-1901/scrub-manifest.md`.

### C.5 Phase 0 on first boot (recorded 2026-09-27T15:58:40Z)

First boot on default NAT networking: `tart run tc-vrf-1901-20260927 --no-graphics`, SSH up after ~10 s at
`192.168.64.9`. Before anything else ran, a read-only audit script (habitat `~/tc-vrf-1901/phase0.txt`) checked:
- no `~/.tangleclaw`;
- no TangleClaw, Tailscale, Caddy or ttyd launch jobs (user or system, loaded or on disk);
- no TangleClaw, ttyd, caddy, tmux or tailscale process;
- no tmux socket directory and no `~/.tmux.conf`;
- no Tailscale app, state or CLI;
- `~/.ssh` holds `authorized_keys` only;
- no `~/.gnupg`;
- none of `.gitconfig`, `.git-credentials`, `.config/gh`, `.netrc`, `.npmrc`, `.claude*`, `.anthropic`, `.codex`,
  `.gemini`, `.aider` or `.config/git`;
- `git config --global --list` is empty;
- no secret-shaped environment variable;
- no github.com internet password in the keychain.

Result: **`PHASE0: CLEAN`**, with no findings.

The login keychain and its UUID directory are **new**: both were created about 20 s before the audit timestamp
and about 14 minutes after the offline scrub (`stat -f %B` 1790524700 and 1790524712), so macOS generated them
at this boot. The item labels, listed with no values, are stock first-boot entries only: Apple Persistent State
Encryption, MetadataKeychain, com.apple.assistant, com.apple.continuity.encryption, TelephonyUtilities and
com.apple.scopedbookmarksagent.xpc.encrypted.

Toolchain kept: `/opt/homebrew/bin/brew`, CLT at `/Library/Developer/CommandLineTools`, node v26.6.0, and Apple
Git 2.50.1.

**Phase C: PASS**, with the source's unchanged state re-verified at teardown (Phase T).

---

## Phase 1 — a fresh direct install, then caddy mode with a login gate

### 1.1 Unauthenticated clone (recorded)

`git clone --branch fix/1901-caddy-asset-refresh --single-branch https://github.com/Jason-Vaughan/TangleClaw.git
~/tc/TangleClaw` gave `HEAD=3db87901abde6745cafb91c1a0aef140a6e8417e`. The repo lives outside the TCC-protected
folders. The only credential-related git setting is the stock CLT system file
(`/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig`: `credential.helper=osxkeychain`), and the
fresh login keychain holds no github.com item, so the clone used no credential.

### 1.2 Owned ttyd runtime: a pinned source behind blocked egress (recorded)

The first direct `./deploy/install.sh` provisioned the owned ttyd runtime (`scripts/build-ttyd.js`): CMake 3.31.6
and libuv 1.52.1 were fetched and verified. It then **hung indefinitely** downloading json-c from
`https://s3.amazonaws.com/json-c_releases/…`, which habitat's egress does not allow. The run was stopped before it
wrote any plist (`~/Library/LaunchAgents` empty; `~/.tangleclaw` held only the build cache).

- **Finding (outside #1901's scope, reported to the PM):** `build-ttyd.js` downloads with `curl -fsSL --retry 2`
  and **no `--max-time`**, so on a network that drops the connection silently, the install hangs with no error
  instead of failing.
- **Workaround (source integrity preserved):** the pinned tarball was fetched on another machine and its SHA-256
  checked against `deploy/ttyd/inputs.json` (`37ad0249…564e26de`, match). It was then placed in the guest's build
  cache under the builder's own cache name. The builder verifies it against the pin again when it uses it. No
  other input was substituted.

### 1.3 Direct install (recorded)

`./deploy/install.sh` exited 0 in ~240 s. The owned ttyd runtime was built from the pinned inputs (both
`patches/0001-…` and `0002-darwin-drain-after-close.diff` applied), staged and installed (`ttyd` SHA-256
`4cf64ce7…3b64d2`). The server plist, the direct ttyd plist, `~/.tmux.conf` and the attach script were written,
and the health check returned HTTP 200.

Environment note: install.sh's own heads-up says the default projects directory `~/Documents/Projects` sits
under a TCC-protected folder, and node has no Full Disk Access in the guest. So `projectsDir` was set to
`~/tc/projects` before the cutover, so an authenticated project listing could not wedge the server and
contaminate the window measurement.

### 1.4 Caddy mode with both doors (recorded)

- `node scripts/ingress-cutover.js --to caddy` gave rc 0: `ttyd: /Users/admin/.tangleclaw/bin/ttyd (the owned
  runtime)`, and the health check passed.
- `node scripts/reset-admin.js --create-gate --user vrfadmin --password-stdin` gave rc 0: a Caddy `basic_auth`
  line was written and Caddy reloaded.
- `node scripts/reset-admin.js --store --user vrfadmin --password-stdin` gave rc 0: TangleClaw's own login is live.

The password is a random 24-character value this run generated and kept only in the throwaway guest
(`~/vrf/pw`, mode 0600). It is never printed.

Gate check (habitat `~/tc-vrf-1901/p1-gatecheck.txt`, `p1-authcheck.txt`):

| Request | Result |
|---|---|
| unauthenticated `/`, `/api/projects`, `/terminal/` | 401 (Caddy, `WWW-Authenticate: Basic`), no dashboard DOM |
| Caddy password only, no TangleClaw session | 401 (TangleClaw's gate) |
| wrong Caddy password on `/` | 401 |
| `/api/health` | 200: the documented gate bypass |
| both doors: Caddy password plus TangleClaw login | login 200; `/` 200 with the dashboard DOM; `/api/projects` 200; `/terminal/` 200 |

ttyd is on its Unix socket (`~/.tangleclaw/run/ttyd.sock`, `srw-rw----`), with **no** TCP :3100 listener, and
`ingressMode=caddy`.

**Phase 1: PASS.**

## Phase 2 — deploy assets change as a release changes them (recorded)

In the guest's checkout, the way a release commit would: `deploy/tmux.conf` gained a marker line, and
`deploy/com.tangleclaw.server.plist` gained an `EnvironmentVariables` key `TANGLECLAW_VRF_1901_MARKER=refreshed`,
whose presence in the *running* server's environment proves the refreshed plist was loaded
(`git diff --stat`: 2 files, 4 insertions; habitat `~/tc-vrf-1901/p2.txt`). **Phase 2: PASS.**

## Phase 3 — the window probe (recorded)

`~/vrf/probe.sh` (in this run's records) sent unauthenticated requests through Caddy's front door, about every
200 ms, to `/` (FAIL if the body holds the dashboard DOM `id="portsGrid"`), `/api/projects` and `/terminal/`
(FAIL on any 2xx), plus `/api/health` as a liveness marker, since it's a documented gate bypass. It started 5 s
before `./deploy/install.sh` and ran until 8 s after it.

- install.sh rc **0** (window 1790525932.154 to 1790525944.095). Narration, in order:
  - the caddy-mode preflight;
  - `Preflight passed`;
  - the refresh of the server plist and `~/.tmux.conf` (backed up);
  - `ttyd and Caddy plists: re-applied by the ingress cutover below`;
  - `Restart 1 of 2 confirmed: the server is up on 127.0.0.1:3102 (health: HTTP 200)`;
  - the cutover (`ttyd: … (the owned runtime)`);
  - `Restart 2 of 2 confirmed: healthy through Caddy`.
- Probe: **264** requests (1790525927.191 to 1790525952.164), **128** of them inside the install window.
  **FAIL lines: 0.** Protected paths answered only 401 (41 each) or 502 (25 each). The 502s are a contiguous
  ~9.5 s run during the restarts: the server down, never an open dashboard.
- Non-fatal and pre-existing: `mkcert -install`'s trust step failed (`security add-trusted-cert`, no sudo in a
  non-interactive session). install.sh continued, as designed.

**Phase 3: PASS.**

## Phase 4 — after the refresh (recorded; one check did not hold)

Held (habitat `~/tc-vrf-1901/p4.txt`, and `p3-before.txt`/`p3-after.txt`):
- `~/.tmux.conf` is byte-identical to the new `deploy/tmux.conf`, with the previous one backed up;
- the server plist carries the marker, and the running server's environment shows
  `TANGLECLAW_VRF_1901_MARKER => refreshed`; the server PID changed (5342 to 7191);
- the attach script is byte-identical to the repo copy;
- the ttyd plist runs `~/.tangleclaw/bin/ttyd` (the owned runtime) on `ttyd.sock`, and **no TCP :3100
  listener** exists;
- `ingressMode=caddy`;
- unauthenticated `/`, `/api/projects` and `/terminal/` get 401 with no dashboard DOM;
- a full login (TangleClaw login through the front door) gets 200 on all three.

**Did not hold — "the Caddyfile still carries the gate":** Caddy's `basic_auth` was **removed** (`basic_auth` lines
1 to 0). The cutover reported `Caddy's basic_auth is NOT written — TangleClaw's login (armed) is the gate for every
site`. That is its existing design (#1420): with TangleClaw's own login armed, Caddy's password is treated as
redundant. The regenerated Caddyfile also serves a LAN-hostname site (`Manageds-Virtual-Machine.local`, behind the
same login) because the certificate covers that name (#863). There was **no unauthenticated window**: TangleClaw's
login refused every protected request throughout. But install.sh now runs the cutover on every caddy-mode
refresh, so a host with both doors becomes a one-door host without being asked, and install.sh's closing line
"the login gate was kept" doesn't say so. Reported to the Architect (via the PM) for a ruling.

Scored **FAIL** on that one check at the time, pending a ruling. All other Phase 4 checks held.

**Ruling (2026-09-27, Architect via PM): accept, conditionally, and re-score Phase 4 PASS on the security
invariant.** The canonical contract: when TangleClaw's login is ARMED, Caddy `basic_auth` is intentionally
omitted; when TangleClaw cannot guard the door, Caddy must carry the fallback gate. Conditions, met on the branch
after this run (tests, not a re-run of this guest):
- install.sh states exactly which gate remains and why (`Login gate now:` with the cutover's `gateNote`, and one
  `Gate change:` line per gate the new file drops). It no longer claims a gate was kept.
- Regression coverage: armed/locked mean no `basic_auth`; open, account-required, unreadable and fallback mean
  `basic_auth` is present; the window is covered by this VRF's Phases 3 and 6 and by install.sh's ordering tests;
  an unprovable gate (unreadable store, no credential, a gated file on disk) is refused (`ungate-refused`).
- A `forward_auth` or `import` gate the generator doesn't produce is reported on `--dry-run` as converging to the
  canonical config.

**Phase 4: PASS** (re-scored by the ruling).

## Phase 5 — fail-closed on a hand-edited Caddyfile (recorded)

A comment line was appended to `~/.tangleclaw/Caddyfile`, then `./deploy/install.sh` ran (habitat
`~/tc-vrf-1901/p5.txt`):
- rc **1**. The output carries the cutover's own reason (`REFUSE (dry run): the real cutover would refuse: the
  Caddyfile is hand-edited …`), then `ERROR: the ingress cutover would refuse (reason above), so nothing was
  refreshed.` and `Nothing was changed.`
- The snapshots before and after are **identical**: the hashes of all three plists, `~/.tmux.conf`, the
  Caddyfile, the attach script, the runtime and `config.json`, plus the server PID. Every file's mtime is still
  from Phase 3.
- The generated Caddyfile was then restored for Phase 6.

**Phase 5: PASS.**

## Phase 6 — G2 live: a stale owned runtime (recorded)

In the guest's checkout, `deploy/ttyd/inputs.json`'s `purpose` text was edited, which changes the file's SHA-256 the
way any release that touches it does, without changing what is built (habitat `~/tc-vrf-1901/p6-report.txt`).

- Precondition: `ingress-cutover --to caddy --dry-run` gave rc **1**, `code=ttyd-runtime-unavailable` (typed, in
  the result file).
- `./deploy/install.sh` gave rc **0**. Narration, in order:
  1. `Caddy mode: checking … before changing anything`;
  2. `The owned ttyd runtime is missing or stale. Provisioning it into ~/.tangleclaw/bin (nothing else is changed),
     then re-running the preflight...`;
  3. `[build-ttyd] ttyd built` and `staged …`;
  4. **`Preflight passed`**, only after the re-run;
  5. the refresh;
  6. `Restart 1 of 2 confirmed`;
  7. the cutover (`ttyd: … (the owned runtime)`);
  8. `Restart 2 of 2 confirmed: healthy through Caddy`.
- The runtime manifest's `inputsJsonSha256` moved from `0c2b8e10…` to `95c50372…`, so a runtime current for the
  new inputs is installed and selected (same binary, `4cf64ce7…`, as expected for a text-only change). The ttyd
  plist still runs `~/.tangleclaw/bin/ttyd` on its socket, with no TCP :3100.
- The window probe ran again throughout: **540** requests, **404** inside the install window, **FAIL: 0**.
  Protected paths answered only 401 or 502 (25–26 each).
- An authenticated session afterwards: login 200; `/`, `/api/projects` and `/terminal/` all 200.

This is the owned-runtime bootstrap measured live. The Homebrew ttyd was not used anywhere in this run.
**Phase 6: PASS.**

## Phase T — teardown (recorded)

- `tart stop` and then `tart delete tc-vrf-1901-20260927`: **only** this run's guest. The guest list before was
  `tc-base`, `tc-base-tailnet`, `tc-c11`, `tc-vrf`, `tc-vrf-1901-20260927` (running), `tc-vrf-a04` and
  `tc-vrf-v5`. After, it is the same five others, all stopped, with no `tart run` process.
- Source re-verified (habitat `~/tc-vrf-1901/source-after-teardown.txt`): `tc-vrf-v5` `disk.img`
  mtime/size `1789337871 50000000000`, SHA-256 `13bf4d2d…c0768539`, and config and NVRAM hashes **identical** to
  the provenance recorded before the clone's first boot.
- The test password lived only in the deleted guest. The pinned json-c tarball copied to habitat was removed.
  This run's text records stay in habitat `~/tc-vrf-1901/`.

**Phase T: PASS.**

---

## How this run scores

Every row is **PASS**. Row 4 was re-scored PASS by the Architect's ruling: the refresh's cutover removed Caddy's
`basic_auth` under its #1420 rule, leaving TangleClaw's login as the gate, and the conditions attached to that
ruling are implemented on the branch. The **window criterion held
throughout**: across two full caddy-mode refreshes, the probe sent 804 unauthenticated requests, 603 of them to protected
paths (198 in Phase 3, 405 in Phase 6), and none returned a 2xx. The gate is cleared.
