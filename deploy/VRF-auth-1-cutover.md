# VRF-auth-1-cutover — clean-room smoke test (habitat macOS guest)

Verifies the **#397 production-durability fixes** to the AUTH-1 Caddy ingress cutover
(`scripts/ingress-cutover.js`, `lib/caddy.js`, `deploy/com.tangleclaw.ttyd.plist`) on a
**fresh, throwaway TangleClaw install** — so nothing touches the live cursatory system, its
projects, tags, DB, or hand-edited Caddyfile.

**Why a separate macOS environment:** TC's home dir (`~/.tangleclaw/`), SQLite DB, Caddyfile,
and launchd labels (`com.tangleclaw.{server,ttyd,caddy}`) are all hardcoded/global per user
account. A second install on the *same* macOS user would unload the live services and
share the live DB. A distinct macOS instance is the only no-code-change clean room.

> **Clean room = a Tart macOS guest on habitat, as of 2026-07-30.** elkaholic is **retired**
> from this role by operator directive; it is also currently unreachable from cursatory (host
> key verification failure), so it was not a viable fallback either. Read every `elkaholic`
> below as *the habitat macOS guest*, reached with `tart exec` or SSH through habitat. The
> guest is cloned per run and deleted after, so Phase 0's "confirm no existing state" is
> satisfied by construction rather than by inspection — but run it anyway if you reuse a guest.
>
> **Everything is on habitat, and nothing is split across machines.** Phases 7b and 7d run in
> the `tc-cleanroom` Linux container, which is a container *on the habitat Docker host* — not a
> second machine. 7c and 7e need the macOS guest. One host, two environments.
> Spec: `https://claude.ai/code/artifact/219ca487-dbd5-41ea-a466-b5a8db2829bd`

**What this proves (the three #397 bugs):**
1. **Cert-staging** — launchd Caddy (no Full Disk Access) can read a cert that originated
   under a TCC-protected dir (`~/Documents`), because `caddy.stageCert()` copies it into
   the non-TCC `~/.tangleclaw/certs/`.
2. **ttyd stale-socket** — the ttyd launchd job runs `/bin/bash` (a non-TCC binary) and
   unlinks a stale Unix socket inline before exec'ing ttyd on every restart, so ttyd
   re-binds cleanly in caddy mode across repeated restarts. (The launchd program is
   deliberately **not** a repo-resident script — that would exit 126 under TCC when the
   repo is under `~/Documents`; durability fix folded into #398.)
3. **Caddyfile clobber-guard** — cutover backs up and **refuses to overwrite** a
   hand-edited Caddyfile without `--force` (sha256 integrity header in the generated file).

Plus: the **first-run Setup Wizard** (projects dir / engine / methodology / chime /
**HTTPS mkcert cert-gen**) — only testable on a clean install, since it never re-fires once
configured.

> **Now in scope — and UNRUN.** The forced-admin wizard step (`caddy hash-password`, no default
> credential) shipped, and setup provisions the gate itself — so phases **7b–7e** below cover
> the machine-readable outcome channel and the server-spawned cutover the wizard drives.
> Break-glass recovery is still verified separately.
>
> **STATUS 2026-07-29 — 7b/7c/7d/7e have not been run, deliberately, and running them is the gate
> on #710 chunk 2.** They cannot be run from a session on the developer's machine: a real cutover
> rewrites launchd plists and restarts the TangleClaw server, and there that server is the live
> install serving the operator's own dashboard from the same clone. What stands in for them
> meanwhile — unit coverage of the decisions, and an interlock refusing a real spawn from a test
> process — does not observe the detached child surviving the restart and does not prove a login is
> in force. **Chunk 2 must not be ticked, and its PR must not be treated as complete, on code
> review alone.** Run **7c and 7e** on the habitat macOS guest and fill the report-back matrix. **7b and 7d
> do NOT need macOS** — they refuse before any `launchctl` step, so they run in habitat's
> `tc-cleanroom` Linux container with no egress window and no guest.

---

## Phase 0 — Confirm clean room + prereqs

```sh
# 0.1  Confirm the guest has NO existing TangleClaw state (absent/empty for a clean test).
#      A freshly cloned guest satisfies this by construction; check anyway if reusing one.
ls -la ~/.tangleclaw 2>/dev/null && echo "⚠ EXISTING STATE — stop, this is not a clean room" || echo "✓ clean"
launchctl list | grep tangleclaw && echo "⚠ existing TC services — stop" || echo "✓ no TC services"

# 0.2  Prereqs — NONE to pre-install by hand.
# install.sh (Phase 2) now auto-installs every dependency (node, ttyd, tmux, mkcert,
# caddy) via Homebrew, bootstraps Homebrew itself if it's missing, and runs
# `mkcert -install` to trust the local CA. You only need a Mac with an internet
# connection. (If you happen to already have some of these, install.sh skips them.)
```

If 0.1 shows existing state and you DON'T care about it (a throwaway guest never does),
you can reset with `Phase 9` first — or simply `tart delete` the guest and re-clone, which is
strictly cleaner. If the environment *does* run a real TC, this test is not
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

## Phase 2 — Install (auto-installs deps, direct mode)

```sh
bash deploy/install.sh
```

This now does the full single-command setup: installs any missing dependency via
Homebrew (bootstrapping Homebrew itself if absent) and runs `mkcert -install`. **It may
prompt you for your password** — once for the Homebrew install (if needed) and once for
the mkcert CA trust. That's expected; approve them.

Expect the tail to print:

```
Landing page:  https://localhost:3102
Terminal:      http://localhost:3100
Caddy ingress (optional): node scripts/ingress-cutover.js --to caddy
```

Verify dependencies + direct mode are live:

```sh
for b in node ttyd tmux mkcert caddy; do command -v $b >/dev/null && echo "✓ $b" || echo "✗ $b MISSING"; done
launchctl list | grep tangleclaw          # server + ttyd loaded (ttyd exit status 0, NOT 126)
lsof -nP -iTCP:3100 -sTCP:LISTEN          # ttyd ON :3100 (direct mode)
# Server is HTTP-only until the wizard's cert step runs — use http here, NOT https:
curl -so /dev/null -w "%{http_code}\n" http://localhost:3102   # 200
```

---

## Phase 3 — Start-up wizard (incl. HTTPS cert-gen)  ← wizard test

Open **http://localhost:3102** in a browser on the guest's desktop (**http**, not https — the
server is HTTP-only until the wizard's cert step runs). The first-run Setup Wizard should
appear automatically (it fires only when `~/.tangleclaw/config.json` has no prior setup).

Walk every step and record PASS/FAIL:

- [ ] **Projects dir** — accepts/normalizes a path (default `~/Documents/Projects`).
- [ ] **Default engine** — selectable (claude / others).
- [ ] **Default methodology** — selectable.
- [ ] **Chime toggle** — toggles.
- [ ] **HTTPS step** — detects mkcert (`GET /api/setup/https-check` → `available:true`,
      and now `caInstalled:true` because Phase 2's install.sh already trusted the CA).
      **Generate certificate** should succeed **without** the old
      `mkcert -install … a terminal is required` error (that privileged step moved to
      install.sh), producing `cert.pem` + `key.pem`:
      ```sh
      ls -l ~/.tangleclaw/certs/        # cert.pem (0644) + key.pem (0600)
      ```
- [ ] Wizard **dismisses**, landing page loads projects, no console errors.

> Notes: (1) the wizard writes the cert to `~/.tangleclaw/certs/` (already non-TCC) — the
> happy path; the bug-#1 TCC stall only happens when the *configured* `httpsCertPath`
> points under a protected dir, which Phase 5 arranges explicitly. (2) The CA-trust fix is
> verified by this step succeeding where the first VRF run failed; if `caInstalled:false`
> or Generate still errors on the CA, that's a regression in the install.sh CA step — flag
> it, don't work around it.

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

## Phase 7b — Unreadable Caddyfile refuses, and says so in the result file  ← #710

Both checks here exist because a unit test **cannot** see them: they are properties of the
order `main()` does things in, and the executor is deliberately not unit-tested
(see the header of `scripts/ingress-cutover.js`). Each one names the mutation it catches.

A present-but-unreadable Caddyfile must produce a *refusal*, not a stack trace. It previously
produced a stack trace, because building the cutover context read the same file before the
guard could run.

```sh
# 7b.1  Make the live Caddyfile unreadable (root-owned, mode 000 — a real-world
#       permissions accident, and what a restored-from-backup file can look like)
sudo chmod 000 ~/.tangleclaw/Caddyfile

# 7b.2  Run the cutover, asking for a machine-readable outcome
rm -f /tmp/cutover-result.json
node scripts/ingress-cutover.js --to caddy --result-file /tmp/cutover-result.json ; echo "exit=$?"
cat /tmp/cutover-result.json
```

- [ ] Exit is **non-zero** and the message names the path and says permissions.
- [ ] **No stack trace.** An `EACCES` traceback here is the regression this phase exists for —
      it means the file is being read before it is classified.
- [ ] `/tmp/cutover-result.json` exists and reports `"code": "unreadable"`, `"ok": false`:
      ```sh
      python3 -c "import json;d=json.load(open('/tmp/cutover-result.json'));assert d['code']=='unreadable' and d['ok'] is False, d;print('✓', d)"
      ```
- [ ] The Caddyfile is **untouched** — nothing written, no backup attempted:
      ```sh
      ls -l ~/.tangleclaw/*.bak* 2>/dev/null && echo "UNEXPECTED backup" || echo "OK no backup taken"
      stat -f '%m %N' ~/.tangleclaw/Caddyfile   # mtime must predate this phase
      ```

```sh
# 7b.3  STILL UNREADABLE at this point, deliberately: --force must not rescue a
#       file that cannot be backed up. Do NOT restore permissions before this.
node scripts/ingress-cutover.js --to caddy --force --result-file /tmp/cutover-forced.json ; echo "exit=$?"
python3 -c "import json;d=json.load(open('/tmp/cutover-forced.json'));assert d['code']=='unreadable',d;print('OK', d)"

# 7b.4  NOW restore, and only now
sudo chmod 600 ~/.tangleclaw/Caddyfile
```

- [ ] `--force` **still refuses**, with `"code": "unreadable"`. Force applies to a hand-edited
      file (which can be backed up), never to an unreadable one (which cannot).
- [ ] Permissions restored to `600` before continuing to the next phase.

## Phase 7c — A successful cutover writes its outcome  ← #710

Catches the mutation of dropping `--result-file` from the executor: the flag would still parse,
the cutover would still work, and every unit test would still pass — while the wizard that polls
for the result would read a successful cutover as a crash, because an absent file means "died".

```sh
rm -f /tmp/cutover-ok.json
node scripts/ingress-cutover.js --to caddy --result-file /tmp/cutover-ok.json ; echo "exit=$?"
python3 -c "import json;d=json.load(open('/tmp/cutover-ok.json'));assert d['ok'] and d['code']=='ok',d;print('✓',d)"
```

- [ ] Exit `0`, and the file reports `"ok": true`, `"code": "ok"`.
- [ ] `healthUrl` is the HTTPS URL, and `healthOk` is a **boolean, not null** — the health poll
      ran. (`healthOk: false` is a legitimate pass here; it means the cutover applied but the
      service had not come up yet. Only `null` is wrong.)
- [ ] `finishedAt` is a timestamp from *this* run, not a stale file from an earlier one.

## Phase 7d — An ungate refusal reports `ungate-refused`, not `failed`  ← #710

The refusal and its tag are unit-tested; the **routing** from tag to reported code is not, and
cannot be — it lives in the executor. Mutation this catches: reporting every `planCutover` throw
as `failed`. The suite stays green, 7b and 7c stay green, and the wizard loses the one signal
that tells it to send the operator to `reset-admin.js` rather than to a generic failure.

Arrange a Caddyfile that IS gated while config carries no credential — the #397 shape.

```sh
# 7d.1  Strip the credential from config, leaving the live Caddyfile gated
cp ~/.tangleclaw/config.json /tmp/config.before.json
node -e '
  const fs=require("fs"),p=process.env.HOME+"/.tangleclaw/config.json";
  const c=JSON.parse(fs.readFileSync(p,"utf8"));
  c.authEnabled=false; c.basicAuthUser=null; c.basicAuthHash=null;
  fs.writeFileSync(p,JSON.stringify(c,null,2));
  console.log("config credential cleared; Caddyfile still gated");
'

# 7d.2  Attempt the cutover
rm -f /tmp/cutover-ungate.json
node scripts/ingress-cutover.js --to caddy --result-file /tmp/cutover-ungate.json ; echo "exit=$?"
python3 -c "import json;d=json.load(open('/tmp/cutover-ungate.json'));assert d['code']=='ungate-refused',d;print('OK',d)"

# 7d.3  Restore config
cp /tmp/config.before.json ~/.tangleclaw/config.json
```

- [ ] Refuses with **`"code": "ungate-refused"`** — NOT `"failed"`. A `failed` here is the
      regression this phase exists for.
- [ ] The message names `scripts/reset-admin.js` as the way forward.
- [ ] The Caddyfile still carries its `basic_auth` block (the gate was never dropped):
      ```sh
      grep -c basic_auth ~/.tangleclaw/Caddyfile   # >= 1
      ```
- [ ] Config restored before continuing.

## Phase 7e — The wizard's own provisioning survives the restart it causes  ← #710

The single property no unit test can reach, and the reason the whole detached-child shape exists:
the cutover's last launchctl step restarts the TangleClaw server, so the process that starts the
cutover is the process the cutover kills. Every test stubs the spawn — necessarily, because a real
one rewrites launchd plists and restarts the machine's live install. So what is verified in-process
is that a cutover *would* be started with the right argv and the right detach flags. That it then
**outlives its parent and still writes the outcome** is verified only here.

Mutations this catches, each of which leaves the whole suite green:
dropping `detached: true` (the child dies with the server, no result file is ever written, and the
wizard reports a working gate as a crash); inheriting stdio instead of ignoring it (the child
blocks or dies on closed pipes); and spawning before the response is written (the browser gets no
answer at all, so the wizard cannot even start polling).

Run on the clean-room image, from the setup wizard in a browser — **not** by invoking the CLI. The
point is the server-initiated path.

```sh
# 7e.0  Fresh state: no Caddyfile, setup not complete, no credential.
rm -f ~/.tangleclaw/ingress-cutover-result.json ~/.tangleclaw/Caddyfile
node -e '
  const fs=require("fs"),p=process.env.HOME+"/.tangleclaw/config.json";
  const c=JSON.parse(fs.readFileSync(p,"utf8"));
  c.setupComplete=false; c.ingressMode="direct";
  c.authEnabled=false; c.basicAuthUser=null; c.basicAuthHash=null;
  fs.writeFileSync(p,JSON.stringify(c,null,2)); console.log("reset to first-run");
'
launchctl kickstart -k "gui/$(id -u)/com.tangleclaw.server"
```

Then, in a browser at **`http://localhost:3102`** (deliberately plain-HTTP loopback — the one origin
that survives the restart, so the poll can be observed resolving rather than timing out):

- [ ] The wizard shows an **Admin Login** step, on an install whose `ingressMode` is `direct`. Its
      absence is the pre-#710 behaviour and the whole defect.
- [ ] The confirm step's **Login** row names the credential that will be created.
- [ ] **Skip is not offered** anywhere in the flow.
- [ ] After *Complete Setup*: a "Putting your login in place…" screen appears, and the response
      arrived — i.e. the browser is not showing a network error. (A response that never arrives means
      the spawn happened before the reply was written.)
- [ ] The screen resolves on its own to **"Your login is in force"** without a reload. That is the
      detached child surviving the restart and writing its outcome.
- [ ] The outcome file exists and agrees:
      ```sh
      python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.tangleclaw/ingress-cutover-result.json')));assert d['ok'] and d['code']=='ok',d;print('✓',d)"
      ```
- [ ] The child was **not** a child of the server any more (it outlived it). The server's PID
      changed across the cutover, which is only survivable detached:
      ```sh
      launchctl print "gui/$(id -u)/com.tangleclaw.server" | grep -m1 pid
      ```
- [ ] Opening the address the screen names **prompts for a username and password**, and the
      credential set in the wizard works. Nothing else in this phase substitutes for this check —
      it is the only end-to-end proof that a login is actually in force.
- [ ] `http://localhost:3102` now serves plain HTTP behind Caddy (loopback), per
      `bind-policy`'s caddy rule.

Then the honest-failure half, which matters more than the success half:

```sh
# 7e.1  Make provisioning fail in a way the server can observe: remove caddy from
#       the service's PATH so detection fails, and re-run first-run setup.
```

- [ ] With no `caddy` on the service PATH, the wizard shows **no** Admin Login step, and completing
      setup lands on **"TangleClaw has no login"** — naming `brew install caddy` and the cutover
      command. It must NOT collect a password first.
- [ ] That screen does not dismiss itself; it waits for *Continue*.
- [ ] On an install whose `bindAllInterfaces` is `true`, the same screen says TangleClaw is
      **reachable from your network** with no login — not "this machine only".

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

## Phase 9 — Teardown (optional; `tart delete <guest>` supersedes it)

```sh
launchctl unload ~/Library/LaunchAgents/com.tangleclaw.*.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.tangleclaw.*.plist
rm -rf ~/.tangleclaw
# optionally: rm -rf ~/Documents/Projects/TangleClaw
mkcert -uninstall    # only if you don't want the test CA trusted in the guest
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
| #710 — unreadable Caddyfile refuses (no stack trace), reports `unreadable`; `--force` refused too | 7b | |
| #710 — a successful cutover writes `"code": "ok"` to its result file | 7c | |
| #710 — an ungate refusal reports `ungate-refused`, not `failed` | 7d | |
| #710 — the wizard's detached cutover outlives the restart and reports `ok`; the named address prompts for a login | 7e | |
| #710 — with no caddy, setup collects no password and says "no login" (and names real exposure) | 7e | |
| Rollback restores direct mode cleanly | 8 | |

**Every row above** green → `VRF-auth-1-cutover` PASSES. (Count the rows rather than trusting a
number written here — the matrix grows as phases are added, and a stale count is how a phase gets
quietly dropped from the criterion.)

Phases **7b, 7c, 7d and 7e are not optional**: they are the accepted substitute for unit coverage
that cannot exist in-process (see #772). 7b/7c/7d cover the executor's ordering; **7e is the only
end-to-end proof that a login is actually in force** after the wizard-driven, server-spawned path —
everything in-process stubs that spawn, necessarily, because a real one restarts the machine's live
install. A run that skips any of them has not verified the #710 work at all.
Any red → capture the failing command's output + `~/.tangleclaw/logs/` and stop.
