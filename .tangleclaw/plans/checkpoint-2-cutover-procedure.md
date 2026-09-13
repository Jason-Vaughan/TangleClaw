# Checkpoint 2 — merging the Tier 1 cutover and switching the live install

For #1420 (`train-9/cutover` → `main`). Written 2026-09-13 at the end of A-VRF. The operator
works from a phone or elkaholic; every step says who runs it and where.

## Where A-VRF stands

| Gate (plan, Checkpoint 2) | State |
|---|---|
| Cumulative Critic on the integration branch | `rev-20260913T221551Z-6e419eca`: 0 blocking. Its six warnings fixed or filed (#1457, #1458); the fixes' verify pass is clean |
| VRF on a live-shaped install | **PASS**, on the macOS/tart guest (see "Venue" below), after three bugs it found were fixed |
| Recovery drill: broken gate over SSH | **PASS** twice on the guest (`drill-gate-fallback.js`), run by the Builder over SSH |
| Recovery drill: password reset with a code, **from the operator's phone** | Not run. Needs your decision (Q1) |
| Operator says "merge" | Not yet |

**What the VRF found and what was fixed** (all on `fix/1420-avrf-critic`, PR into `train-9/cutover`):

1. **A lost account store let anyone claim the install.** Once Caddy's password is out, a database
   deleted or restored from before the first account left the first-account page open to any
   machine. I reproduced it: a request from another machine created the only account. Fixed: an
   `accounts-established` marker, after which only the machine itself can create the first account.
2. **The fallback tools used the wrong port.** Config says 3101, the service binds 3102. That is
   every standard install, though not yours, where both are 3102. `gate-fallback.js` treated a
   Caddyfile with no password as already gated. TangleClaw refused the marker, so nothing opened,
   but recovery did not work.
3. **The drill reported "no answer" after a successful undo.** Its check reused a closed connection.

**Venue.** The plan said elkaholic, which is your workstation, and its SSH key is refused today.
The VRF ran on a clone of the habitat macOS guest (`tc-vrf-a04`) instead. It has launchd services,
Caddy 2.11.4 on the service PATH (the same version as the live install), caddy mode, and a bcrypt
credential. It was upgraded v5.0.0 → v5.23.0 → the cutover branch, and checked for:
- the migration to `account-required`, then creating the account behind Caddy's password (8 codes issued);
- dropping `basic_auth` with the cutover;
- sign-in (a wrong password gets 401);
- the dashboard, API and terminal WebSocket (101 signed in, 401 without);
- a forged `X-Auth-User` being ignored;
- a machine-shaped or spoofed-`X-Forwarded-For` request through Caddy being refused;
- `/api/health` staying public;
- off-box requests getting TangleClaw's sign-in, not the dashboard;
- PortHub lease and release, and `tc` from a shell.

**Not verified anywhere:** the `/openclaw-direct/*` iframe against a real OpenClaw (the guest has
none). That check moves to the live install, step 7.

**Live-install facts, read today (read-only):** Caddy v2.11.4. Nothing else fronts port 3102:
Tailscale Serve proxies 3320 and 3330, and no cloudflared or nginx is running. `authEnabled` is on,
the bcrypt credential for `jason` is present, there are 0 accounts, and the ports agree (3102). The
Caddyfile is hand-maintained with an ungated `handle @ownauth` for `/openclaw-direct/*` and
`/manifest.json`.

## Decisions for you

**Q1 — Where do the phone drills run?** The plan puts both before the merge. No install running
the branch is reachable from your phone: the guest is not on the tailnet (#808).
- **(a) Recommended: on the live install, right after steps 1–7**, before Checkpoint 2 closes. The
  SSH drill has already passed twice on a live-shaped install. What the phone adds is your device
  and your hands, and the live install is the real test of that. Rollback (step R) is a file copy
  plus a script that has already been proven.
- (b) Put the guest on the tailnet first (#808). Needs an egress window for the Tailscale package.
- (c) Run the branch on elkaholic. You would turn on Remote Login and re-authorize my key.

**Q2 — Merge strategy for `train-9/cutover` → `main`.** The default is a merge commit, which keeps
each car's PR visible.

**Vetoable decisions made during the build** (each recorded in ADR 0016):
- A Caddyfile that `caddy adapt` cannot read, or one gated everywhere except a single handle, counts
  as a door. So `authEnabled: false` does not open that install.
- `reset-admin --store` deletes the account's recovery codes when it resets the password.
- The setup wizard issues no recovery codes (#803). There is no change-password form (#1457) and
  no disable command (#1458); the docs say so.
- A lost account store is claimable only from the machine itself. Losing the whole `~/.tangleclaw`
  directory is an accepted risk.

## The procedure

**0. Before merging (Builder, on cursatory).** Back up the live state:
```sh
cp ~/.tangleclaw/Caddyfile ~/.tangleclaw/Caddyfile.pre-tier1-2026-09-XX.bak
cp ~/.tangleclaw/tangleclaw.db ~/.tangleclaw/tangleclaw.db.pre-tier1-2026-09-XX.bak
cp ~/.tangleclaw/config.json ~/.tangleclaw/config.json.pre-tier1-2026-09-XX.bak
```
Also write a **gated copy for `--restore`**: the live file with the `handle @ownauth { … }` block
removed, so `import tcauth` covers `/openclaw-direct/*`. The fallback refuses today's file, and this
copy is what it will accept. Check it with `caddy validate`. Do not install it.

**1. Merge and release.** Operator says "merge", then the Builder merges with the strategy from Q2.
`.github/workflows/release.yml` tags and publishes the release. Don't tag by hand (see
`docs/release-process.md`). Close #1055 and #1420.

**2. Update the live install (Builder).** Pull the release in the primary checkout, restart the
server, and confirm the version. Then check:
- `curl -s http://127.0.0.1:3102/api/auth/me` answers `gateState: "account-required"`;
- `~/.tangleclaw/accounts-established` does not exist yet.

From here until step 3, remote access works only with Caddy's password *and* the first-account page.
The OpenClaw iframe returns 401 until the account exists.

**3. Create the account (operator, from the phone).** Open
`https://cursatory.tail123678.ts.net:8443` and enter Caddy's password (`jason`) as today. The
**Create your account** page appears. Set the password (12+ characters, not containing the
username). **Save the 8 recovery codes** away from the phone. You are signed in.

**4. Check it holds, with Caddy's password still in front (operator).** The dashboard loads, a
terminal opens, and the "Logged in as" chip shows your name.

**5. Take Caddy's password out of the hand-maintained file (Builder, after your go).** Edit
`~/.tangleclaw/Caddyfile`:
- delete the `(tcauth)` snippet and every `import tcauth`;
- collapse the `handle @ownauth` / `handle` split on the tailnet site back into one `reverse_proxy`;
- delete the inert `header_up X-Auth-User` lines.

Keep the localhost site, the tailnet HTTPS site, the tailnet redirect and the `http://` catch-all.
Then:
```sh
caddy validate --config ~/.tangleclaw/Caddyfile --adapter caddyfile
launchctl kickstart -k gui/$(id -u)/com.tangleclaw.caddy
```

**6. Verify (operator, from the phone; Builder, on cursatory).**
- Phone: no Caddy prompt; TangleClaw's sign-in page appears. Sign in.
- Builder: without a session, `/api/config` through Caddy answers 401; `/api/health` answers 200.
- Builder: `tc` and a PortHub lease work from a pane; the Caddyfile drift banner is quiet.

**7. OpenClaw (operator).** Open a project's OpenClaw UI. The iframe loads with no password prompt
loop: #472 cannot come back, because nothing sends `basic_auth` any more.

**8. The drills (operator, from the phone), if Q1 = (a).**
- **Code reset:** sign out, then choose **Forgot your password? Use a recovery code**. Enter one code
  and a new password. You are signed in and the dashboard shows the notice; choose **That was me**.
  Then **Settings → Recovery codes → generate new set** and save it.
- **Broken gate over SSH:** from the phone's SSH client, on cursatory:
  `echo '<Caddy password>' | node scripts/drill-gate-fallback.js --user jason --password-stdin --restore <gated copy from step 0>`.
  It must end `Drill PASSED.` It restores Caddy's password, proves it, and puts the file back byte for byte.

**9. Close out (Builder).**
- Run the memory `project_caddy_ingress_live_state` cleanup check. The file stays hand-maintained, so
  update the memo rather than deleting it.
- Publish advisory GHSA-fhgg-4h57-q2f9 with the release.
- Report to the Coordinator.

**R. Rollback, at any step.**
- **Caddy side:** `cp ~/.tangleclaw/Caddyfile.pre-tier1-*.bak ~/.tangleclaw/Caddyfile`, then kickstart Caddy.
- **The login broke after step 5:** `node scripts/gate-fallback.js --restore <gated copy>`. Undo it
  later with `--undo --restore <step-5 file>`.
- **Code:** check out v5.23.0 in the primary checkout and restart. The database migrations are
  additive: `users`, `auth_sessions` and `recovery_codes` stay and are ignored.
