# VRF-auth-1-cutover — clean-room smoke test (elkaholic)

Verifies the **#397 production-durability fixes** to the AUTH-1 Caddy ingress cutover
(`scripts/ingress-cutover.js`, `lib/caddy.js`, `deploy/ttyd-launch.sh`) on a **fresh,
throwaway TangleClaw install** — so nothing touches the live cursatory system, its
projects, tags, DB, or hand-edited Caddyfile.

**Why a separate machine:** TC's home dir (`~/.tangleclaw/`), SQLite DB, Caddyfile, and
launchd labels (`com.tangleclaw.{server,ttyd,caddy}`) are all hardcoded/global per user
account. A second install on the *same* macOS user would unload the live services and
share the live DB. A different Mac is the only no-code-change clean room.

**What this proves (the three #397 bugs):**
1. **Cert-staging** — launchd Caddy (no Full Disk Access) can read a cert that originated
   under a TCC-protected dir (`~/Documents`), because `caddy.stageCert()` copies it into
   the non-TCC `~/.tangleclaw/certs/`.
2. **ttyd stale-socket** — `deploy/ttyd-launch.sh` unlinks a stale Unix socket on every
   restart, so ttyd re-binds cleanly in caddy mode across repeated restarts.
3. **Caddyfile clobber-guard** — cutover backs up and **refuses to overwrite** a
   hand-edited Caddyfile without `--force` (sha256 integrity header in the generated file).

Plus: the **first-run Setup Wizard** (projects dir / engine / methodology / chime /
**HTTPS mkcert cert-gen**) — only testable on a clean install, since it never re-fires once
configured.

> **Not in scope (doesn't exist on this branch):** the AUTH-2 forced-admin wizard step
> (`caddy hash-password`, no-default-creds, break-glass). This box becomes its test bed
> once AUTH-2 is built.

---

## Phase 0 — Confirm clean room + prereqs

```sh
# 0.1  Confirm elkaholic has NO existing TangleClaw state (must be absent/empty for a clean test)
ls -la ~/.tangleclaw 2>/dev/null && echo "⚠ EXISTING STATE — stop, this is not a clean room" || echo "✓ clean"
launchctl list | grep tangleclaw && echo "⚠ existing TC services — stop" || echo "✓ no TC services"

# 0.2  Prereqs (Homebrew)
brew install node ttyd tmux mkcert caddy
node --version    # expect a current LTS
caddy version
mkcert -version
```

If 0.1 shows existing state and you DON'T care about it (elkaholic has no real TC use),
you can reset with `Phase 9` first. If elkaholic *does* run a real TC, this test is not
safe there either — use a VM instead.

---

## Phase 1 — Clone the #397 branch, arrange the TCC condition

The fix is **not merged** — clone the PR branch, not `main`.

```sh
mkdir -p ~/Documents/Projects && cd ~/Documents/Projects
git clone https://github.com/Jason-Vaughan/TangleClaw.git
cd TangleClaw
git checkout fix/auth-1-cutover-durability
git log --oneline -3      # top 3 are the #397 fix commits (production-durable cutover +
                          # clobber-guard/timestamped-backup + CHANGELOG note)
```

Cloning under `~/Documents/Projects` is deliberate: it puts the repo (and any cert we
place beside it) inside a **TCC-protected** tree, reproducing the cursatory condition that
broke bug #1.

---

## Phase 2 — Install (direct mode)

```sh
bash deploy/install.sh
```

Expect the tail to print:

```
Landing page:  https://localhost:3102
Terminal:      http://localhost:3100
Caddy ingress (optional): node scripts/ingress-cutover.js --to caddy
```

Verify direct mode is live:

```sh
launchctl list | grep tangleclaw          # server + ttyd loaded
lsof -nP -iTCP:3100 -sTCP:LISTEN          # ttyd ON :3100 (direct mode)
curl -k -so /dev/null -w "%{http_code}\n" https://localhost:3102   # 200 (after wizard, see Phase 3)
```

---

## Phase 3 — Start-up wizard (incl. HTTPS cert-gen)  ← wizard test

Open **https://localhost:3102** in a browser on elkaholic. The first-run Setup Wizard
should appear automatically (it fires only when `~/.tangleclaw/config.json` has no prior
setup).

Walk every step and record PASS/FAIL:

- [ ] **Projects dir** — accepts/normalizes a path (default `~/Documents/Projects`).
- [ ] **Default engine** — selectable (claude / others).
- [ ] **Default methodology** — selectable.
- [ ] **Chime toggle** — toggles.
- [ ] **HTTPS step** — detects mkcert (`GET /api/setup/https-check` → available), and
      **Generate certificate** produces `cert.pem` + `key.pem`:
      ```sh
      ls -l ~/.tangleclaw/certs/        # cert.pem (0644) + key.pem (0600)
      ```
- [ ] Wizard **dismisses**, landing page loads projects, no console errors.

> Note: the wizard writes the cert to `~/.tangleclaw/certs/` (already non-TCC). That is the
> happy path. The TCC stall (bug #1) only happens when the *configured* `httpsCertPath`
> points under a protected dir — which Phase 5 arranges explicitly.

---

## Phase 4 — Dry-run the cutover (touches nothing)

```sh
node scripts/ingress-cutover.js --to caddy --dry-run
```

- [ ] Prints the plan: Caddyfile path (`~/.tangleclaw/Caddyfile`), staged cert paths,
      ttyd socket (`~/.tangleclaw/run/ttyd.sock`), the plists, and the launchctl steps.
- [ ] **Mutates nothing** — re-check `lsof -nP -iTCP:3100` still shows ttyd on TCP, and
      `~/.tangleclaw/Caddyfile` does not exist yet.

---

## Phase 5 — Reproduce the TCC condition, then cut over  ← #397 bug 1

Arrange a cert **under the TCC-protected repo tree**, point config at it, and confirm the
launchd Caddy (no Full Disk Access) still comes up because the cutover **stages** it out.

```sh
# 5.1  Put an mkcert cert inside the repo (a TCC-protected location)
mkdir -p tcc-cert
mkcert -cert-file tcc-cert/cert.pem -key-file tcc-cert/key.pem localhost 127.0.0.1
ABS=$(pwd)

# 5.2  Point TC config at the TCC-resident cert (mimics cursatory's broken setup)
node -e '
  const fs=require("fs"),p=process.env.HOME+"/.tangleclaw/config.json";
  const c=JSON.parse(fs.readFileSync(p,"utf8"));
  c.httpsEnabled=true;
  c.httpsCertPath=process.argv[1]+"/tcc-cert/cert.pem";
  c.httpsKeyPath =process.argv[1]+"/tcc-cert/key.pem";
  fs.writeFileSync(p,JSON.stringify(c,null,2));
  console.log("set httpsCertPath →",c.httpsCertPath);
' "$ABS"

# 5.3  Cut over to caddy
node scripts/ingress-cutover.js --to caddy
```

Verify the cutover + bug-1 fix:

```sh
# Cert was STAGED out of the TCC tree into the store dir:
ls -l ~/.tangleclaw/certs/                       # cert.pem + key.pem present (staged copies)

# Caddy (launchd user agent, NO Full Disk Access) came up and reads the staged cert:
launchctl list | grep com.tangleclaw.caddy       # present, exit status 0 (not 78/crash-looping)
lsof -nP -iTCP:8443 -sTCP:LISTEN                  # caddy LISTENING on 8443
curl -k -so /dev/null -w "%{http_code}\n" https://localhost:8443    # 200

# ingress flipped:
node -e 'console.log("ingressMode=",JSON.parse(require("fs").readFileSync(process.env.HOME+"/.tangleclaw/config.json")).ingressMode)'   # caddy
```

- [ ] **PASS bug 1** if Caddy is up on 8443 and serving — *without* a TCC stall — despite
      the original cert living under `~/Documents`. (Pre-fix, launchd caddy would hang/fail
      reading the Documents-resident cert.)

Open **https://localhost:8443** in the browser — the UI should load over Caddy's TLS.

---

## Phase 6 — ttyd stale-socket resilience  ← #397 bug 2

In caddy mode ttyd binds a Unix socket. Confirm it re-binds across restarts (the wrapper
unlinks the stale inode each time).

```sh
ls -l ~/.tangleclaw/run/ttyd.sock                # socket exists
lsof -nP -iTCP:3100 -sTCP:LISTEN || echo "✓ ttyd NOT on TCP :3100 (correct for caddy mode)"

# Restart ttyd twice; it must re-bind cleanly each time (no 'address already in use'):
launchctl kickstart -k gui/$UID/com.tangleclaw.ttyd
sleep 2; ls -l ~/.tangleclaw/run/ttyd.sock
launchctl kickstart -k gui/$UID/com.tangleclaw.ttyd
sleep 2; ls -l ~/.tangleclaw/run/ttyd.sock
launchctl list | grep com.tangleclaw.ttyd        # exit status 0, not a crash loop

# Terminal still reachable through the proxy chain:
curl -k -so /dev/null -w "%{http_code}\n" https://localhost:8443/   # 200
```

- [ ] **PASS bug 2** if ttyd re-binds the socket on every kickstart with no stale-socket
      error and the terminal stays reachable via 8443.

---

## Phase 7 — Caddyfile clobber-guard  ← #397 bug 3

Hand-edit the generated Caddyfile (breaking its integrity header), then re-run the cutover
and confirm it **backs up and refuses** rather than clobbering your edit.

```sh
# 7.1  Make a "hand edit"
cp ~/.tangleclaw/Caddyfile /tmp/caddyfile.before
printf '\n# HAND EDIT — operator added this line\n' >> ~/.tangleclaw/Caddyfile

# 7.2  Re-run cutover WITHOUT --force
node scripts/ingress-cutover.js --to caddy ; echo "exit=$?"
```

- [ ] Cutover **refuses** (non-zero exit / explicit "hand-edited, refusing without --force").
- [ ] A **timestamped backup** was written next to the Caddyfile:
      ```sh
      ls -l ~/.tangleclaw/Caddyfile* ~/.tangleclaw/*.bak* 2>/dev/null
      ```
- [ ] Your hand-edited line is **still present** (not overwritten):
      ```sh
      grep "HAND EDIT" ~/.tangleclaw/Caddyfile && echo "✓ edit preserved"
      ```

> Do **not** pass `--force` here — refusing is the pass condition. (`--force` is the
> documented escape hatch; this test proves the default protects the live-style file.)

Restore the clean generated file before rollback:
```sh
cp /tmp/caddyfile.before ~/.tangleclaw/Caddyfile
```

---

## Phase 8 — Roll back to direct (reversibility)

```sh
node scripts/ingress-cutover.js --to direct      # or --rollback
```

- [ ] `https://localhost:3102` serves again (direct HTTPS).
- [ ] `lsof -nP -iTCP:3100 -sTCP:LISTEN` → ttyd back on TCP :3100.
- [ ] `launchctl list | grep com.tangleclaw.caddy` → **gone** (caddy LaunchAgent unloaded).
- [ ] `ingressMode` back to `direct` in config.json.

```sh
curl -k -so /dev/null -w "%{http_code}\n" https://localhost:3102   # 200
lsof -nP -iTCP:8443 -sTCP:LISTEN || echo "✓ nothing on 8443 (caddy stopped)"
```

---

## Phase 9 — Teardown (optional, leaves elkaholic clean)

```sh
launchctl unload ~/Library/LaunchAgents/com.tangleclaw.*.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.tangleclaw.*.plist
rm -rf ~/.tangleclaw
# optionally: rm -rf ~/Documents/Projects/TangleClaw
mkcert -uninstall    # only if you don't want the test CA trusted on elkaholic
```

---

## Result matrix (report back)

| Check | Phase | Pass? |
|---|---|---|
| Setup wizard end-to-end (incl. mkcert cert-gen) | 3 | |
| Dry-run touches nothing | 4 | |
| Bug 1 — cert staged, launchd Caddy serves 8443 despite TCC-resident source | 5 | |
| Bug 2 — ttyd re-binds Unix socket across restarts | 6 | |
| Bug 3 — clobber-guard backs up + refuses hand-edited Caddyfile | 7 | |
| Rollback restores direct mode cleanly | 8 | |

All six green → `VRF-auth-1-cutover` PASSES → merge PR #398 → close #397 → close #395.
Any red → capture the failing command's output + `~/.tangleclaw/logs/` and stop.
