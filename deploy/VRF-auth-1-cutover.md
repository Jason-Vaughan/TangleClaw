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
> **STATUS 2026-07-30 — 7b/7c/7d/7e have all been run and all read `PASS`, so the #710 chunk 2 gate
> is met.** See "How to score this matrix" at the bottom for the exact standing; Gate 2, the
> document as a whole, is *not* met, and the two must not be conflated.
>
> They could not be run from a session on the developer's machine, which is why they went unrun
> until now: a real cutover rewrites launchd plists and restarts the TangleClaw server, and there
> that server is the live install serving the operator's own dashboard from the same clone. What
> stood in for them meanwhile — unit coverage of the decisions, and an interlock refusing a real
> spawn from a test process — does not observe the detached child surviving the restart and does not
> prove a login is in force. **Chunk 2 must not be ticked, and its PR must not be treated as
> complete, on code review alone.** That bar is now cleared by measurement, not waived. 7c and 7e
> ran on the habitat macOS guest; **7b and 7d do NOT need macOS** — they refuse before any
> `launchctl` step, so they ran in habitat's `tc-cleanroom` Linux container with no egress window
> and no guest.

> **Checkbox legend for this document.** `- [x]` measured on the run named in the execution
> record. `- [~]` **not verified** — reachable only through a browser session this run did not
> have, and NOT claimed by the matrix row above. `- [ ]` not run this pass. A ticked matrix row
> whose boxes are blank is the contradiction this legend exists to prevent.
>
> **Matrix legend — the `Pass?` column takes exactly one of four values, spelled exactly this
> way.** A second spelling for a state is how a partial result gets read as a whole one.
>
> | Value | Meaning |
> |---|---|
> | **PASS** | Every check in the phase was measured, and all of them held. |
> | **PARTIAL** | Some checks were measured and held; others were not run. The qualifier says which — a `PARTIAL` with no explanation is unscoreable and is itself a defect. |
> | **NOT RUN** | No verdict was recorded for this phase on this pass. |
> | **FAIL** | A check was measured and did not hold. |
>
> A row is scored **from the execution records below, not from inference**: walking a phase
> without recording an observation scores `NOT RUN`, even where a neighbouring record implies it
> must have worked. The bias is deliberate — this document may understate what was verified, and
> must never overstate it. `PARTIAL` is **not** a pass; see the criterion under the matrix for
> which values clear which gate.

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

- [x] Exit is **non-zero** and the message names the path and says permissions.
- [x] **No stack trace.** An `EACCES` traceback here is the regression this phase exists for —
      it means the file is being read before it is classified.
- [x] `/tmp/cutover-result.json` exists and reports `"code": "unreadable"`, `"ok": false`:
      ```sh
      python3 -c "import json;d=json.load(open('/tmp/cutover-result.json'));assert d['code']=='unreadable' and d['ok'] is False, d;print('✓', d)"
      ```
- [x] The Caddyfile is **untouched** — nothing written, no backup attempted:
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

- [x] `--force` **still refuses**, with `"code": "unreadable"`. Force applies to a hand-edited
      file (which can be backed up), never to an unreadable one (which cannot).
- [x] Permissions restored to `600` before continuing to the next phase.

## Phase 7c — A successful cutover writes its outcome  ← #710

Catches the mutation of dropping `--result-file` from the executor: the flag would still parse,
the cutover would still work, and every unit test would still pass — while the wizard that polls
for the result would read a successful cutover as a crash, because an absent file means "died".

```sh
rm -f /tmp/cutover-ok.json
node scripts/ingress-cutover.js --to caddy --result-file /tmp/cutover-ok.json ; echo "exit=$?"
python3 -c "import json;d=json.load(open('/tmp/cutover-ok.json'));assert d['ok'] and d['code']=='ok',d;print('✓',d)"
```

- [x] Exit `0`, and the file reports `"ok": true`, `"code": "ok"`.
- [x] `healthUrl` is the HTTPS URL, and `healthOk` is a **boolean, not null** — the health poll
      ran. (`healthOk: false` is a legitimate pass here; it means the cutover applied but the
      service had not come up yet. Only `null` is wrong.)
- [x] `finishedAt` is a timestamp from *this* run, not a stale file from an earlier one.

## Phase 7d — An ungate refusal reports `ungate-refused`, not `failed`  ← #710

The refusal and its tag are unit-tested; the **routing** from tag to reported code is not, and
cannot be — it lives in the executor. Mutation this catches: reporting every `planCutover` throw
as `failed`. The suite stays green, 7b and 7c stay green, and the wizard loses the one signal
that tells it to send the operator to `reset-admin.js` rather than to a generic failure.

> **Fixture corrected 2026-07-30 — the original could not reach this refusal on ANY platform.**
> It cleared config's credential and left the Caddyfile gated, but in `scripts/ingress-cutover.js`
> the `adoptCredentialIntoConfig` call runs *before* the `planCutover` call, and immediately
> re-adopts the single credential it finds — printing "Adopted live Caddyfile state into config".
> The ungate condition therefore never held and `ungate-refused` was unreachable. Caught by
> executing 7b/7d in the `tc-cleanroom` container on 2026-07-30; it would have failed the same
> way on macOS, after a scheduled egress window.
>
> **Order of the gates before the refusal**, all of which must be satisfied for this phase to
> reach its assertion — grep `scripts/ingress-cutover.js` for each in turn rather than trusting a
> line number, which moves: `adoptCredentialIntoConfig` → the `CADDY_MISSING` refusal →
> `httpsSetup.generateCerts` → `planCutover`. So 7d needs a `caddy` binary on PATH and a **valid cert pair already
> configured** — both of which a real run has from Phases 2–3. They are prior state, not part of
> what 7d tests; synthesize them if you run this phase out of sequence.

Arrange a Caddyfile that IS gated while config carries no credential — the #397 shape.

```sh
# 7d.1  Arrange the ungate condition. Clearing config alone is NOT enough — see
#       the note below. The live Caddyfile must be gated AND unadoptable.
cp ~/.tangleclaw/config.json /tmp/config.before.json
cp ~/.tangleclaw/Caddyfile /tmp/Caddyfile.before

# (a) Make the live gate AMBIGUOUS — two basic_auth users. `extractBasicAuthCredential`
#     returns null for a multi-user file, so adoption cannot adopt from it.
node -e '
  const fs=require("fs"),p=process.env.HOME+"/.tangleclaw/Caddyfile";
  let s=fs.readFileSync(p,"utf8");
  const m=s.match(/^(\s*)(\S+)\s+(\$2[aby]\$\S+)\s*$/m);
  if(!m) throw new Error("no basic_auth credential line found to duplicate");
  s=s.replace(m[0], m[0]+"\n"+m[1]+"alex "+m[3]);
  fs.writeFileSync(p,s);
  console.log("live Caddyfile now defines 2 basic_auth users (unadoptable)");
'

# (b) NOW clear config's credential. Adoption runs before the ungate check and would
#     otherwise put it straight back.
node -e '
  const fs=require("fs"),p=process.env.HOME+"/.tangleclaw/config.json";
  const c=JSON.parse(fs.readFileSync(p,"utf8"));
  c.authEnabled=false; c.basicAuthUser=null; c.basicAuthHash=null;
  fs.writeFileSync(p,JSON.stringify(c,null,2));
  console.log("config credential cleared; Caddyfile still gated and unadoptable");
'

# 7d.2  Attempt the cutover
rm -f /tmp/cutover-ungate.json
node scripts/ingress-cutover.js --to caddy --result-file /tmp/cutover-ungate.json ; echo "exit=$?"
python3 -c "import json;d=json.load(open('/tmp/cutover-ungate.json'));assert d['code']=='ungate-refused',d;print('OK',d)"

# 7d.3  Restore config AND the Caddyfile
cp /tmp/config.before.json ~/.tangleclaw/config.json
cp /tmp/Caddyfile.before ~/.tangleclaw/Caddyfile
```

- [x] Refuses with **`"code": "ungate-refused"`** — NOT `"failed"`. A `failed` here is the
      regression this phase exists for.
- [x] The message names `scripts/reset-admin.js` as the way forward.
- [x] The Caddyfile still carries its `basic_auth` block (the gate was never dropped):
      ```sh
      grep -c basic_auth ~/.tangleclaw/Caddyfile   # >= 1
      ```
- [x] Config restored before continuing.

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

- [~] The wizard shows an **Admin Login** step, on an install whose `ingressMode` is `direct`. Its  
      **NOT VERIFIED — browser-only; this run drove `POST /api/setup/complete`, not the UI.**
      absence is the pre-#710 behaviour and the whole defect.
- [~] The confirm step's **Login** row names the credential that will be created.  
      **NOT VERIFIED — browser-only; this run drove `POST /api/setup/complete`, not the UI.**
- [~] **Skip is not offered** anywhere in the flow.  
      **NOT VERIFIED — browser-only; this run drove `POST /api/setup/complete`, not the UI.**
- [~] After *Complete Setup*: a "Putting your login in place…" screen appears, and the response
      arrived — i.e. the browser is not showing a network error. (A response that never arrives means
      the spawn happened before the reply was written.)  
      **PARTIALLY VERIFIED — the response half is measured (HTTP 200 in 1s, so the spawn followed the
      reply); the "screen appears" half is browser-only and was NOT observed.**
- [~] The screen resolves on its own to **"Your login is in force"** without a reload. That is the  
      **NOT VERIFIED — browser-only; this run drove `POST /api/setup/complete`, not the UI.**
      detached child surviving the restart and writing its outcome.
- [x] The outcome file exists and agrees:
      ```sh
      python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.tangleclaw/ingress-cutover-result.json')));assert d['ok'] and d['code']=='ok',d;print('✓',d)"
      ```
- [x] The child was **not** a child of the server any more (it outlived it). The server's PID
      changed across the cutover, which is only survivable detached:
      ```sh
      launchctl print "gui/$(id -u)/com.tangleclaw.server" | grep -m1 pid
      ```
- [x] Opening the address the screen names **prompts for a username and password**, and the
      credential set in the wizard works. Nothing else in this phase substitutes for this check —
      it is the only end-to-end proof that a login is actually in force.
- [x] `http://localhost:3102` now serves plain HTTP behind Caddy (loopback), per
      `bind-policy`'s caddy rule.

Then the honest-failure half, which matters more than the success half:

```sh
# 7e.1  Make provisioning fail in a way the server can observe: remove caddy from
#       the service's PATH so detection fails, and re-run first-run setup.
```

- [ ] With no `caddy` on the service PATH, the wizard shows **no** Admin Login step, and completing  
      *(not run this pass)*
      setup lands on **"TangleClaw has no login"** — naming `brew install caddy` and the cutover
      command. It must NOT collect a password first.
- [ ] That screen does not dismiss itself; it waits for *Continue*.  
      *(not run this pass)*
- [ ] On an install whose `bindAllInterfaces` is `true`, the same screen says TangleClaw is  
      *(not run this pass)*
      **reachable from your network** with no login — not "this machine only".

## Phase 8 — Roll back to direct (reversibility)

```sh
node scripts/ingress-cutover.js --to direct      # or --rollback
```

- [ ] `https://localhost:3102` serves again (direct HTTPS).  
      *(not run this pass)*
- [ ] `lsof -nP -iTCP:3100 -sTCP:LISTEN` → ttyd back on TCP :3100.  
      *(not run this pass)*
- [x] `launchctl list | grep com.tangleclaw.caddy` → **gone** (caddy LaunchAgent unloaded).
- [x] `ingressMode` back to `direct` in config.json.

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

**Execution record — 7b, `tc-cleanroom` Linux container on habitat, 2026-07-30, branch @e20c1a3.**
Deviations, recorded because they change what the result means: the container runs as **root**, and
root bypasses DAC permission checks — a `chmod 000` file is still readable, so the phase would have
passed vacuously. A non-root `tcuser` was created to mirror the macOS operator, with the Caddyfile
root-owned mode 000 as written. `~/.tangleclaw` prior state was generated with
`caddy.buildCaddyfileContent` (real `basic_auth` block, real integrity header,
`classifyIngressState` → `generated`) since `install.sh` refuses on non-Darwin. Measured: exit `1`,
refusal names path and permissions, **no stack trace**, `{"code":"unreadable","ok":false}`, no
backup written, mtime identical before and after, `--force` still refused with `unreadable` at
exit `1`, and permissions were restored to `600` (`-rw------- tcuser`) before moving on. Per the EPERM caveat in the spec, this is re-run in the macOS guest as confirmation and the
guest wins on any disagreement.

**Execution record — 7d, same container and branch, 2026-07-30.** Ran only after the fixture
correction above; the original fixture could not reach the refusal at all. Prior state synthesized
because `install.sh` cannot run on Linux: a real `openssl` self-signed cert pair (so
`validateCertFiles` passes and the `httpsSetup.generateCerts` branch is never entered — the absence
of mkcert there throws untagged, filed as #786) and a `caddy` stub answering `version`, the same
pattern the repo's own suite uses because CI has no Caddy. Neither substitutes for anything 7d
asserts: the refusal is raised inside `planCutover`, before either is used again. Measured: exit `1`,
`{"code":"ungate-refused","ok":false}`, the error names `scripts/reset-admin.js`, the live Caddyfile
still carries its `basic_auth` block, and **no stack trace**. Config and Caddyfile restored after.

**Execution record — Phases 2-5, 7c, 7e and 8, macOS clean-room guest on habitat, 2026-07-30, @4e4e55e.**
Guest: `tc-vrf`, macOS 26.3 build 25D125, cloned from `macos-tahoe-vanilla:26.3`, reached over SSH
through habitat. Genuinely pristine at start — brew/node/npm/tmux/ttyd/caddy/mkcert all absent.

*Before install:* `git clone` — the README's first instruction — **exited 1**, because `/usr/bin/git`
is a Command Line Tools stub and any git invocation raises an install dialog. Filed as **#788**. CLT
was then installed headlessly (`softwareupdate -i`, ~920 MB, ~90s) and the same clone succeeded.

*Phase 2/5 (`install.sh`):* **exit 0, fully unattended.** It bootstrapped Homebrew in
`NONINTERACTIVE` mode and installed node, ttyd, tmux, mkcert and caddy; one sudo access check fired
and a keepalive covered it. **`mkcert -install` completed with no GUI click** — the CA is in the
System keychain — so the "first run needs VNC" assumption this document and its spec both carried is
**wrong for this path**. `launchctl list` shows `com.tangleclaw.server` and `com.tangleclaw.ttyd` at
exit status **0**, not 126, which is Bug 2's condition.

*7c:* exit 0, `{"ok":true,"code":"ok"}`, `healthUrl` HTTPS, `healthOk` a real boolean, `finishedAt`
from this run.

*7e — driven through the API rather than a browser, and this limits what it proves.* `POST
/api/setup/complete` is the request the wizard's *Complete Setup* button issues, so the
server-initiated path is exercised exactly. Response arrived in **1s with HTTP 200** (the spawn
happened after the reply); `provision-status` reported `state: done, ok: true, code: ok`; the server
**PID changed 6053 → 6219**; and the outcome file was written by a child that outlived the parent
that spawned it — the one property no unit test can reach. Then the check nothing substitutes for:
`https://localhost:8443/` returned **401** with no credentials, **401** with wrong ones, and **200**
with the credential the wizard created. `/api/health` stayed open by design; `http://localhost:3102`
serves plain HTTP behind Caddy on loopback. **Not verified, because no VNC session was used:** that
the Admin Login step renders, that Skip is absent from the flow, and that the screen resolves without
a reload. Those are frontend assertions and are covered by `test/setup-wizard-login-gate.test.js`,
but they are not covered *here* and this row does not claim them.

*Phase 8 (rollback):* **failed first, then passed after the fix.** `--to direct` switched the ingress
and then crashed in `pollHealth`, which hardcoded `https.get` while the direct health URL is
`http://` — exit 1 after a successful switch, no result file written. Filed as **#789** and fixed at
`ad280a7`; the client is now chosen from the URL scheme. Re-run on this same guest, rolling back from
the gated install 7e had just created: **exit 0**, no stack trace, health check passed,
`{"ok":true,"code":"ok","target":"direct","healthOk":true}` written, caddy LaunchAgent unloaded,
`ingressMode` back to `direct`, and `http://localhost:3102/api/health` answering 200. The before/after
is the evidence, not the code review.

| Check | Phase | Pass? |
|---|---|---|
| Setup wizard end-to-end (incl. mkcert cert-gen) | 3 | **PARTIAL** — completion + cert-gen exercised via the API; the per-step wizard walk (projects dir / engine / methodology / chime) was NOT run, so its boxes stay blank |
| Dry-run touches nothing | 4 | **NOT RUN** — inside the `Phases 2-5` install walk, but no per-check observation was recorded, so it is not scored |
| Bug 1 — cert staged, launchd Caddy serves 8443 despite TCC-resident source | 5 | **NOT RUN** — `install.sh` and `mkcert -install` are recorded, and 7e observed 8443 answering, but the TCC-resident source condition this phase exists to reproduce was never arranged on the guest |
| Bug 2 — ttyd re-binds Unix socket across restarts | 6 | **PARTIAL** — ttyd observed at exit status 0 (not 126) across the restarts 7c/7e caused; the repeated-kickstart loop this phase specifies was NOT run |
| Bug 3 — clobber-guard backs up + refuses hand-edited Caddyfile | 7 | **NOT RUN** — no execution record covers this phase |
| #710 — unreadable Caddyfile refuses (no stack trace), reports `unreadable`; `--force` refused too | 7b | **PASS** — `tc-cleanroom`, 2026-07-30, @e20c1a3 |
| #710 — a successful cutover writes `"code": "ok"` to its result file | 7c | **PASS** — habitat guest, 2026-07-30, @4e4e55e |
| #710 — an ungate refusal reports `ungate-refused`, not `failed` | 7d | **PASS** — `tc-cleanroom`, 2026-07-30, @e20c1a3 (corrected fixture) |
| #710 — the wizard's detached cutover outlives the restart and reports `ok`; the named address prompts for a login | 7e | **PASS** — server PID 6053→6219, 401/401/200 |
| #710 — with no caddy, setup collects no password and says "no login" (and names real exposure) | 7e.1 | **NOT RUN** — the guest had caddy installed and the run did not re-do first-run setup without it. The *decision* is unit-covered (`test/setup-wizard-login-gate.test.js`, `test/setup-provisioning.test.js`); what is unverified is that the honest-absence screen renders end-to-end — the same browser-only limit as 7e's `[~]` boxes |
| Rollback restores direct mode cleanly | 8 | **PARTIAL** — after the #789 fix, re-run @ad280a7: caddy unloaded, `ingressMode` direct, 3102 answering 200. The direct-HTTPS and ttyd-on-3100 checks were NOT run |

### How to score this matrix

Two gates, scored separately, because they have different consequences. Read every row's `Pass?`
value against the matrix legend at the top of this document and apply:

**Gate 1 — the #710 chunk 2 gate.** Rows **7b, 7c, 7d and 7e** must every one read `PASS`.
Nothing else clears it: `PARTIAL` does not, and neither does unit coverage. These four are the
accepted substitute for coverage that cannot exist in-process (see #772) — 7b/7c/7d cover the
executor's ordering, and **7e is the only end-to-end proof that a login is actually in force**
after the wizard-driven, server-spawned path, because everything in-process stubs that spawn
(a real one restarts the machine's live install). A run that skips any of the four has not
verified the #710 work at all.

**Gate 2 — the document as a whole.** `VRF-auth-1-cutover` PASSES only when **every** row reads
`PASS`. A single `PARTIAL` or `NOT RUN` means it does not — the document is then a record of what
was checked, not a clean bill of health, and must not be cited as one. (Score by reading the rows,
never by trusting a tally: the matrix grows as phases are added, and a stale count is how a phase
gets quietly dropped from the criterion.)

Any `FAIL` → capture the failing command's output + `~/.tangleclaw/logs/`, and stop.

**Standing as of the 2026-07-30 run (@e20c1a3 / @4e4e55e / @ad280a7):**

- **Gate 1 — MET.** 7b, 7c, 7d and 7e all read `PASS`, on the runs their rows name.
- **Gate 2 — NOT MET.** Three rows read `PARTIAL` and four read `NOT RUN`; no row reads `FAIL`.

The largest residual is **7e.1**, the honest-absence half of 7e — and Phase 7e says outright that
it "matters more than the success half", so its being `NOT RUN` is a real gap rather than a
formality. It sits outside Gate 1 because Gate 1 names phases, and 7e's own phase gate — proof
that a login is in force — was measured and held. Tracked as **#802**.
