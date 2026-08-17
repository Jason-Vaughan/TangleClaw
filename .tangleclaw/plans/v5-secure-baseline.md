# TangleClaw v5 Secure Baseline — Plan of Record

**Adopted 2026-07-29** against `68e228c` (v4.38.0), from the Current-State Transition Report
requested by the v5 Secure Baseline Directive.

Hosted mirror (canonical *reading* copy, same content, updated in place):
https://claude.ai/code/artifact/b6bc71e7-6dee-4093-b91a-ffe26530cca1

> **Keep the two in sync.** The operator reads the hosted copy and treats it as the single source of
> truth for where v5 stands. Any change to this plan — chunk status, scope, a decision — updates the
> artifact **in the same turn**, republished to that same URL. Never mint a new one.

**Canonical chunk roster:** `.prawduct/artifacts/build-plan.md`, scope `auth-6-secure-by-default`.
That file's checkboxes are what governance parses — tick them there first, mirror here and in the
artifact second. **Tracking issue: #710.**

---

## Two different questions, kept apart

The first draft of the report ran these together and it caused real confusion. Both are true.

| Question | Answer | Size |
|---|---|---|
| What must finish before v5 can begin? | Nothing substantive — branch cleanup, three stale docs, plan pointer, recorded deferrals. | ~1 hour of bookkeeping |
| **What *is* v5?** | **Chunks 2, 3, 3b, 4.** Not leftovers — the release itself. | **The real build; chunk 2 is largest** |
| What is already done? | Chunk 1, shipped v4.35.0. A fresh install is loopback-only instead of wide open. | Complete |
| How does 5.0.0 get tagged? | A `BREAKING:` marker in `[Unreleased]` + a wrap. `release.yml` does the rest. **Never by hand.** | Automatic, once earned |

## The headline finding

The v5 scope was already ratified under another name. `docs/adr/0009-secure-by-default.md`
(2026-07-27) states the same posture the directive states. Its plan is
`.prawduct/artifacts/build-plan.md`. Chunk 1 shipped. Chunks 2–4 are the v5 scope almost line for
line, so that plan was **adopted** rather than a parallel one authored.

## Scope

**Included:** wizard provisions and configures Caddy as the default install path; credential forced
at setup with no default credential ever; HTTPS via the certs the installer already provisions; all
HTTP/API/WebSocket/terminal routes gated except `/api/health` and two documented exemptions;
provisioning failure degrades to loopback-only, never to unauthenticated-and-exposed; post-setup
redirect on the real scheme and port; a settings surface that can change the credential but never
blank it; break-glass recovery **verified by running it**; install/verify/upgrade/rollback docs.

**Excluded:** multiple users, registration, roles, OAuth, email password recovery, per-user resource
ownership, a full identity system, new engines, UI redesign, unrelated refactors — **and the Session
Switchboard, deliberately withdrawn from the v5 surface (see below).**

### DECIDED 2026-07-31 — the Switchboard is withdrawn from v5, not fixed for it

The operator first raised making a working Switchboard a v5 release requirement, then adopted
withdrawal instead. Recorded here because the reason matters more than the outcome.

**Why not fix it for v5.** The inventory is **28 open issues across two repos** (10 TangleClaw, 18
`Jason-Vaughan/Medusa`) — tracked at #818. Several Medusa ones are foundational rather than polish:
#31 (three disjoint ID namespaces), #25 (`medusa_hook` to a non-existent workspace returns success
and black-holes the message), #22 (presence ≠ deliverability). Taken literally, "bug-free Medusa" is
plausibly a larger body of work than the whole current v5, and it lives substantially in a **different
repo owned by a different session**. The objection was never that it is hard; it is that it is not on
v5's critical path, and v5's headline — the secure baseline — is what the field installer is waiting
on. Gating the release on it risks v5 never shipping.

**Why withdrawal beats shipping a workaround.** A "cheat" — a delivery receipt bolted onto a bus with
unresolved delivery defects — buys the *appearance* of a guarantee. An absent channel is honest; a
channel that reports success while dropping messages is not, and that is the current failure mode
(the operator becomes the transport, #792). So the delivery guarantee stops being a v5 blocker and
becomes the **relaunch gate**: TangleClaw #785, #791, #792, #783, #812 plus Medusa #25, #22.

**Rejected: a long-lived Medusa dev branch.** Proposed and argued down. This clone *is* the live
install and serves `public/` off the working tree, so a long-lived side branch makes a live hazard
permanent — `public/setup.js` was measured differing by 706 lines between `main` and `v5-baseline`
on 2026-07-31, and checking that out in the primary checkout would have swapped the operator's
dashboard mid-incident. It would also conflict on every v5 merge and leave the operator testing a
configuration nobody ships. One codebase, one flag.

**What withdrawal actually costs — measured, and it is not zero.** `medusaEnabled` already defaults
to false (`lib/projects.js:940`), but that governs only whether the *listener autostarts*.
`public/session.js` never references the flag, and `renderMedusaControl()` un-hides the control
before any state branch — so every session page surfaces the control regardless, and one click
starts the channel. Withdrawal therefore needs a real change, filed as **#820**: the flag must gate
the surface, not just the autostart. An earlier claim in this session that "public v5 already ships
no Switchboard surface" was wrong, and #820 records the correction.

**Standing risk to carry into the relaunch.** With the feature off for everyone but the operator, the
operator becomes its sole tester — the same asymmetry that makes the field installer's self-reports
unusable as measurement. The relaunch gate must therefore be a delivery-receipt test that can fail,
not accumulated confidence from daily use.

**Known limitations shipped knowingly:** one shared credential; no rate limiting, lockout, MFA, or
session revocation, in front of a surface that launches shells; two routes exempt from the gate by
necessity. This is why internet exposure stays **unsupported**, not merely discouraged.

## Execution order

1. **Close out and park** — stale branches, stale docs, successor issue, deferral notes. *(done
   2026-07-29)*
2. **Establish the boundary** — repoint `active_build_plan`, settle the `BREAKING:`/5.0.0 question,
   retitle #710 as the v5 tracking issue. *(done 2026-07-29)*
3. ~~**Clean-room baseline against v4.38.0**~~ — **DONE 2026-07-29.** See "Baseline — MEASURED"
   below. Chunk 1 confirmed at the socket; the missing-credential gap measured; zero new issues.
4. **Chunk 2 — DONE 2026-07-30.** Merged to `v5-baseline` as PR #787 (`c29c11b`, a merge commit),
   0 blocking / 0 warning over 8 review facts, clean-room VRF phases 7b/7c/7d/7e all `PASS`. Its
   Status box was derived on 2026-08-01 once a checkout held both the merge and a `status=shipped`
   stamp on the `chunks=2` entry — the stamp was missed at merge, which is why the box read unticked
   for two days while the work was in fact complete. Residuals, tracked and none blocking: #802 (VRF
   7e.1 unrun), #803, #804. **#805 is closed by chunk 3b**, not by chunk 2.

   The slices, for the record: **2-i, 2-ii, 2-iii-a** delivered the six-state Caddyfile classifier —
   failing closed when the file is present but unreadable — the wizard's read-only ingress probe, and
   a machine-readable cutover outcome (`--result-file`). The preserve-or-refuse guard **already
   existed** and already protects this machine's live Caddyfile, which collapsed that slice.
   **2-iii-b** then delivered provisioning, the step-list flip and the degraded fallback together.

   2-iii-a was not in the original plan. It is forced by a constraint found while building: the
   cutover's launchctl sequence **restarts the TangleClaw server**, so the server cannot run it
   in-process — it would die partway and never learn whether provisioning worked, which makes the
   degraded-fallback requirement unimplementable. Provisioning runs in a detached child instead, and
   a detached child has no stdout anyone reads.

   Review lesson worth carrying: **all seven blocking findings across three Critic passes were
   commits describing behaviour the code did not have** — a flag parsed and dropped, a guard that
   could not be reached, a tag with no test, a VRF phase that could not run as written. Not wrong
   logic; overstated claims.
4b. **Chunk 5 — tmux targets match exactly. DONE 2026-07-29 (#774, PR #775 → `v5-baseline`).**
   Added to this plan by operator ruling, not by design work: the bug was hit in production and
   "cannot live into or past v5."

   tmux resolves a `-t <name>` target by exact name, then by a unique **prefix**, then by fnmatch.
   From code that silently retargets another project's session: with no `TangleClaw` session
   running, a relaunch's orphan check matched `TangleClaw-Roadmap` and killed it. The kill was the
   symptom, not the boundary — the same fallback was **measured** on `send-keys`, `capture-pane`
   and `set-option`, and `deploy/ttyd-attach.sh` would have attached the browser terminal to the
   neighbour's live pane.

   Every target now carries tmux's `=` exact-match prefix, in the form `=name:`. The colon is
   load-bearing: a bare `=name` is honoured only by target-session commands (`has-session`,
   `kill-session`, `attach-session`), while `send-keys`, `capture-pane`, `paste-buffer`,
   `set-option`, `show-option(s)` and `set-hook` reject it outright and require the colon —
   measured against tmux 3.6a, including that `set-option -t '=name:'` still writes the session
   option rather than a window one. `display-message` cannot be protected this way at all, since it
   answers for the attached client instead of failing, so its caller checks existence explicitly.

   Also **hot-patched onto the running install** the day it was found (`lib/tmux.js` in the live
   checkout plus the live copy at `~/.tangleclaw/deploy/ttyd-attach.sh`, server restarted and
   verified), because the exposed pairs — `TangleClaw` / `TangleClaw-Roadmap`, `RentalClaw` /
   `RentalClaw-Project` — were live and the box was unattended for a week. That live patch is
   uncommitted on `main`; `main` gets it properly when `v5-baseline` merges at step 8.

5. **Chunks 3 and 3b** — land on a working URL (reuse `effectiveServerPort`/`effectiveServerProtocol`,
   do not re-derive); credential may change, never blank.

   **Chunk 3b — MERGED 2026-08-01** to `v5-baseline` as PR #824 (`1a81951`, a merge commit), after one
   cumulative Critic review and six `verify-resolutions` rounds. Built on `feat/710-chunk3b` off
   `v5-baseline`. Delivers `POST /api/auth/credential` + the settings Login section behind one
   predicate (caddy mode × live gate × existing credential × caddy binary), and **closes #805** by
   removing the credential fields from `PATCH /api/config` rather than guarding them. Two findings
   from the review pass are worth carrying past this chunk:

   - **The reload cannot precede the reply.** The response to a credential change travels back
     through the Caddy the change restarts, so the original order turned a successful change into a
     browser-visible network error. The restart now hangs off the response finishing, and its
     *outcome* is therefore unreportable — every request after it needs the new password. The
     response ships the manual reload command unconditionally instead of claiming a result.
   - **The suite was restarting this machine's live Caddy.** `execFileSync('launchctl', …)` resolves
     through PATH and the shared test stub covered only `caddy`, so every full-suite run kickstarted
     `com.tangleclaw.caddy` and dropped remote access mid-run. Now stubbed and recorded. Worth
     remembering when chunk 4 runs `reset-admin.js` for real: that chunk's whole point is a live run,
     so the boundary between "stubbed in tests" and "executed once, deliberately" has to stay
     explicit.

   A third finding, decided by the operator's delegation and worth carrying: **the credential route
   refuses anything that did not arrive on a loopback connection** (D6). The question filed as #822 —
   should it require `X-Auth-User` to prove the request came through Caddy — was answered *no* by
   reading the mechanism: in caddy mode TC trusts that header, so any caller able to reach the route
   can forge it, and this machine's hand-edited Caddyfile has a gated `reverse_proxy` with no
   `header_up`, so requiring it would have locked the operator out. The connection check closes a
   real path instead: caddy mode pins the listener to loopback at LISTEN time, while `ingressMode` is
   read per request, and a legacy grace-state install has an unauthenticated `PATCH /api/config` that
   accepts `ingressMode`.

   > **⚠ `Closes #N` DOES NOT FIRE on chunk PRs.** GitHub auto-closes only on a merge into the
   > *default* branch, and every chunk PR bases on `v5-baseline`. #824 carried `Closes #805` and #805
   > stayed open — correctly, since `main` still has the hole. **Step 8's integration PR must close
   > them explicitly**, and until then a fixed-but-unshipped issue staying open is the honest state.

   **Chunk 3 — MERGED 2026-08-01** to `v5-baseline` as PR #827 (`15e7af2`, a merge commit). Status
   box derived. **Chunk 4 is now the only unshipped chunk in v5.**

   Chunk 3's lesson is about the plan itself, so it is recorded here rather than only in the
   change-log: **its written instruction would have produced the defect it existed to fix.** The
   paragraph said to reuse `effectiveServerPort`/`effectiveServerProtocol` and not re-derive. Those
   predict what *TC's own listener* serves; in caddy mode that is plain HTTP on the loopback, so they
   compose to `http://host:3102` — the ungated, loopback-only door — and a post-setup redirect there
   walks the operator past the login setup just installed. The instruction was written before chunk 2
   made caddy the default install path and was never re-read against it.

   The general form, worth applying to chunk 4's paragraph before building it: **a plan written
   before an earlier chunk landed may name mechanisms whose meaning that chunk changed.** Re-read the
   chunk's own instruction against the code as it now is, and correct the plan in place before
   writing anything.

   Also filed from chunk 3: **#825** — `wizardComplete` returns on `ingress.protection` before it
   checks `result.restart`, so an install that is both "no login TangleClaw can confirm" and
   "restarting" never reaches the restart overlay and lands on a Continue button that fetches a dying
   server. Reachable on a hand-maintained Caddyfile.
6. **Chunk 4 — DONE 2026-08-01.** Merged to `v5-baseline` as PR #832 (`6ad9147`, a merge commit),
   `status=shipped` stamped and the Status box derived. **All chunks 1–5 are now `[x]`; v5's build
   work is complete.**

   The run happened: `reset-admin.js` executed against the live **hand-edited** Caddyfile. The hash
   moved, the real LaunchAgent restarted (PID 28797 → 36189, exit 0), the gate re-authenticated, and
   the file came out **byte-identical apart from the hash** — still `adoptable`/`safeToWrite: false`,
   so it was not silently re-stamped as generated and the cutover's clobber-guard still protects it.
   `security-model.md` §2 is reconciled to what the run proved rather than edited a third time in
   anticipation of it.

   **Three of this chunk's own premises were stale and were corrected before any code** — the
   doc/wiring contradiction it named had already been resolved on 2026-07-29, the README sharpening
   it asked for was already done, and #806 (the thing that actually needed building) was not in it at
   all. The general form recorded under chunk 3 held again.

   **The venue finding, which the handoff got wrong in a way worth keeping:** the Docker/Debian clean
   room (`deploy/cleanroom/`, `node:22-bookworm`) **cannot** prove the reload — there is no
   `launchctl` on Linux — so a run there would have stopped at the one unproven step while producing
   a green result. Habitat *does* host a **macOS** clean room via `tart` that can; it was still not
   the venue, because a clean room only ever produces a *generated* Caddyfile and the claim under
   test was about the hand-edited shape. Never write "the clean room" unqualified.

   **Two procedural defects only a real run could surface**, both now in `docs/setup-guide.md` and
   `deploy/INGRESS.md`: recovery enforces the *current* password policy, so a credential older than
   the policy cannot be restored (the operator's predated the 12-char minimum and was refused); and
   "run it under tmux" is wrong for an operator arriving through ttyd, whose session is already
   tmux-backed but whose window may run an AI session that cannot be typed into.

   Also delivered: **#806 closed** by `--create-gate`, and a setup guide for a reader with no
   reverse-proxy background. Review: one cumulative (3 blocking, all three reviewers independently
   finding the same defect — a rebuild from an enumerated field list silently dropped a
   `publicDomain` ACME site) → two `verify-resolutions` ending 0/0/0 → PR reviewer 0 blocking.
   Filed, not fixed: **#828**, **#831**.
7. **Verify against the acceptance criteria** — see **§ Acceptance Criteria** below, which is now
   the definition of done for this step. The criteria are **C1–C12**; five need real runs and four
   of those are blocked on **#845** until the generator matches the deployment.

   > **The list this step used to reference did not exist.** Until 2026-08-02 this line read
   > *"criteria 1–3, 8 and 10 need real runs"* — a reference by number to a list that is in no
   > artifact, no issue body or comment, no ADR, and no memory file. The § below was **authored**,
   > not recovered, and **the old numbering cannot be mapped onto it**: C6 here is not "criterion 6"
   > there. If the original ever surfaces, reconcile rather than assume correspondence.
8. **Release** — three freeze reversals happen here, and none of them are optional:
   1. Set `versionBumpEnabled` back to **`true`** for TangleClaw, or nothing can ship.
   2. Move the README install pin to `v5.0.0` and delete the "install from the tag" note, or every
      new install stays stranded on 4.38.0.
   3. If an integration branch was used, merge it to `main` first.

   Then author the `[Unreleased]` entry carrying the `BREAKING:` marker, wrap, and let `release.yml`
   tag and publish. Confirm the published tag's `version.json` matches. Notify the field installer
   *before* he updates.
9. **Architecture Stabilization Sprint 1** — `PROJECT-MAP.md` and `FEATURES.md` are inputs to the
   inventory it calls for, not work to redo.

## Acceptance Criteria

**Ratified 2026-08-02 (operator).** Derived from this plan's Scope paragraph and the five binding
rules of `docs/adr/0009-secure-by-default.md` plus its 2026-07-28 amendment. Each criterion is
written to be **falsifiable** — a statement you can run something against and get a wrong answer
from. Status marks are secondhand unless the criterion says otherwise.

### C1 — A fresh install binds loopback only

A default install is reachable only from the machine it runs on. No interface beyond `127.0.0.1`
is bound unless the operator explicitly opts in.

- **Source:** ADR 0009 rule 3; chunk 1.
- **Verification:** real run — read the listening socket on a fresh install, not a log line.
- **Status: VERIFIED** 2026-07-29, clean-room run against `0bc2b0d`, measured at `/proc/net/tcp`.

### C2 — The terminal listener is pinned for everyone, on every install

ttyd binds `127.0.0.1` (or a Unix socket) unconditionally — not gated on ingress mode, not gated
on an opt-in. No client addresses it directly; TangleClaw proxies to it.

- **Source:** ADR 0009 amendment rule 1 — *"a change that removes an unauthenticated shell at zero cost to the user is not one to stage behind anything."*
- **Verification:** real run — probe `:3100` from another host on the LAN and confirm refusal.
- **Status: ✅ VERIFIED for caddy mode — measured 2026-08-02. Direct mode remains unverified.**
  *Local:* ttyd (PID 23094) runs `--interface /Users/jasonvaughan/.tangleclaw/run/ttyd.sock` — a
  **Unix domain socket, not a TCP port at all**, which is stronger than a loopback pin. `lsof`
  shows no TCP listener owned by ttyd and nothing bound to `:3100`. Socket perms `srw-rw----`,
  owner only.
  *Remote (habitat → cursatory over the tailnet):* `http://cursatory:3100/` returns **000, no
  answer**, against a **validated control** — `:8443` on the same host answers, so the path is
  reachable and the silence on 3100 is ttyd's absence rather than an unroutable network.
  **Scope limit, stated because it is the whole point of the criterion:** this box runs
  `ingressMode: caddy`, where ttyd uses a Unix socket. ADR 0009's amendment rule 1 pins ttyd
  *"immediately, for everyone"* — i.e. **also in direct mode**, where it should bind TCP
  `127.0.0.1:3100`. This box never runs direct mode, so that arm is untested here and belongs to
  the clean-install run.
  *Also measured, not a defect:* an HTTPS request whose `Host` matches no site block (e.g. the bare
  IP) gets `200` with `Content-Length: 0` from Caddy — no upstream reached, no data served. Read
  carelessly, that `200` looks like a gate bypass; it is not.

  **Two instrument failures on the way to this result, recorded because they nearly produced
  wrong answers:** (1) `/dev/tcp` is non-functional on habitat — it reported "refused" even for
  `localhost:22` and `github.com:443`, so an initial round of four clean "refused" readings were
  **false negatives that happened to agree with the desired conclusion**. (2) The bare-IP `200`
  above was briefly read as an unauthenticated bypass of a protected endpoint. Both were caught by
  a control probe. **A negative result is worthless without one.**

### C3 — Setup provisions and configures the gate as the default path

The wizard installs and configures Caddy itself. Reaching a working gate does not require the
operator to run a separate manual cutover.

- **Source:** ADR 0009 rule 1; chunk 2.
- **Verification:** real run — fresh install, wizard to completion, gate answers.
- **Status: VERIFIED** — chunk 2 clean-room VRF phases 7b/7c/7d/7e all `PASS`.

### C4 — No default credential exists, ever; one is forced at setup

No shipped value, no change-me prompt. `POST /api/setup/complete` and the `PATCH /api/config
{setupComplete:true}` skip path both refuse without a credential (`ADMIN_REQUIRED`).

- **Source:** ADR 0009 rule 2 — load-bearing because **this repository is public**, so any default would be readable by anyone and every install pre-compromised from first boot.
- **Verification:** unit-testable for the refusal; real run for "the wizard cannot be completed past it."
- **Status: PARTIAL** — refusal paths tested; end-to-end wizard refusal not separately recorded.

### C5 — HTTPS is served from certs the installer already provisions

No manual cert step. `install.sh` already provisions `caddy` and `mkcert`; the gate terminates TLS
using them.

- **Source:** Scope clause 3.
- **Verification:** real run — fresh install, confirm HTTPS on the ingress port with a cert the installer created.
- **Status: ✅ VERIFIED 2026-08-03** — clean-room run, `tart` guest `tc-vrf-v5` (virgin macOS 26.3 cloned
  from `tc-base`), `v5-baseline` @ `1308bd7`. TangleClaw generated the cert itself during the cutover:
  `~/.tangleclaw/certs/cert.pem` + `key.pem`, hosts `["localhost","127.0.0.1","::1",…]`, expiry
  `Nov 3 2028`. `openssl s_client` against `:8443` returns
  `subject= /O=mkcert development certificate`, `issuer= /O=mkcert development CA` — a real TLS
  handshake on the ingress port with a cert the installer provisioned. No manual cert step was taken.

  **One honest limitation, environmental not product:** `mkcert -install` (trust-store insertion)
  failed in the guest with `SecTrustSettingsSetTrustSettings: The authorization was denied since no
  user interaction was possible` — an artifact of driving a headless SSH session, not a defect.
  `install.sh` handled it correctly: warned, named the one-command fix, and continued. So the cert is
  *provisioned and served*; whether a browser *trusts* it without the operator running
  `mkcert -install` at a real keyboard is untested here.

### C6 — Every HTTP, API, WebSocket and terminal route is gated, except the documented exemptions

All surfaces sit behind the gate. The exemption list is explicit and short.

- **Source:** Scope clause 4.
- **Verification:** real run — enumerate routes and probe each through the perimeter unauthenticated.
- **Status: ✅ VERIFIED 2026-08-03** on the clean-room guest — which is precisely where it *is*
  measurable, because a fresh install's Caddyfile is generator-written with no hand edits to drift
  from. Unauthenticated through the perimeter (`https://localhost:8443`, Host matched):

  | Route | Code |
  |---|---|
  | `/`, `/api/config`, `/api/projects`, `/api/sessions`, `/api/ports`, `/api/shared-docs`, `/dashboard` | **401** |
  | `/api/health`, `/manifest.json` | 200 (documented exemptions) |
  | `/openclaw-direct/x` | 404 — passed the gate, no such route (correct: exempt, not present) |

  Wrong password → **401**. Correct password → 200. The generated file carries exactly the
  documented list: `@protected not path_regexp ^(/api/health|/openclaw-direct/.*|/manifest\.json)$`
  — the anchored RE2 form from #434, matching `lib/caddy.js` `AUTH_BYPASS_PATHS` and `SECURITY.md:28`.

  **Two measurement traps recorded, because both produced a false reading before the real one:**
  (1) Probing `https://127.0.0.1:8443` returns **200 unauthenticated** — this is NOT a bypass. The
  generated Caddyfile defines a single `localhost` site, so any other Host matches no site and Caddy
  answers `200` with `Content-Length: 0` and **zero** TangleClaw content (verified by header + byte
  count; an arbitrary `Host: evil.example` behaves identically). Probe with the Host the site was
  generated for, or every route reads as ungated. (2) The guest's own LAN IP is unreachable on 8443
  from another host — the guest's macOS application firewall denies inbound for `caddy` headlessly.
  That is environmental; do not read it as a product binding guarantee in either direction.

  <details><summary>Superseded 2026-08-01 note: "⚠ UNVERIFIABLE ON THIS BOX"</summary>

  That verdict was correct *about this box* and is now moot: the criterion was always meant to be
  measured on a clean install, where no hand-edited perimeter exists. It is kept because its lesson
  stands — measuring the product against this machine's hand-written Caddyfile produced a false
  finding pointing at a non-existent product defect.
  </details>
  An earlier draft of this criterion read **CONTRADICTED** and offered "implement the exemption or
  amend the criterion." **Both were wrong; the exemption already exists in the product.**
  `lib/caddy.js:127` — `AUTH_BYPASS_PATHS = ['/api/health', '/openclaw-direct/*', '/manifest.json']`;
  `:248` emits `@protected not path_regexp <bypass>` immediately before `basic_auth @protected`;
  #434 hardened that from `path` to an anchored case-sensitive RE2; `SECURITY.md:28` documents it;
  `test/service-token.test.js:84` asserts it. All verified in-tree.
  The **401** I measured comes from the *deployment*: `~/.tangleclaw/Caddyfile` is hand-written,
  predates the generator's gate, contains **zero** occurrences of `api/health`, `@protected` or
  `path_regexp`, and exempts only `/openclaw-direct/*` and `/manifest.json`.
  **This criterion cannot be measured until #845 lands** (the generator does not emit the live
  file's `protocols h1` pin, so a cutover would break every Chrome terminal). Measuring the product
  against this box produces false findings — and this one pointed the safe-looking way, at a
  non-existent product defect.

### C7 — A failed provision degrades to loopback-only, never to unauthenticated-and-exposed

When the gate cannot be provisioned, the install lands loopback-only and **says so**. It never lands
in the pre-v5 state: no gate *and* a wide binding.

- **Source:** ADR 0009 rule 3, second sentence — the single most important failure mode in the release.
- **Verification:** real run — force provisioning to fail (no `caddy` binary), complete setup, then measure the binding from another host.
- **Status: ✅ VERIFIED 2026-08-03** — run first, as recommended. Provisioning was forced to fail by
  removing the `caddy` binary on the clean-room guest, then setup was completed.

  The probe flipped honestly (`plan.action: "refuse"`, with a plain-language reason and a
  `brew install caddy` remedy). `POST /api/setup/complete {}` then returned
  `"protection": "none"`, `"networkExposed": false`, the reason in `warnings`, and — the assertion
  that matters — **no credential was collected**: `basicAuthUser: null`, `basicAuthHash: null`. So it
  never reached credential-collected-but-ungated, the state this criterion exists to forbid.

  End state measured, not inferred: config `ingressMode: direct`, `authEnabled: false`,
  `bindAllInterfaces: false`; `netstat` showed **only** `127.0.0.1.3102` and `127.0.0.1.3100`.
  From habitat (a different host) both refused, **with a live control in the same run** — `ssh:22`
  to the same guest succeeded, proving the network path worked and the refusals were real isolation
  rather than an unroutable address.

### C8 — Post-setup lands the operator on the real front door

The redirect after setup uses the scheme and port actually serving the operator — the ingress in
caddy mode, TangleClaw's own listener otherwise. It never lands them on the ungated loopback door.

- **Source:** Scope clause 6; chunk 3.
- **Verification:** real run — complete setup in caddy mode, follow the redirect.
- **Status: ✅ VERIFIED 2026-08-03 (caddy arm).** Setup completed in caddy mode on the clean-room
  guest returned `ingress.url: "https://127.0.0.1:8443"` — Caddy's HTTPS port, the gated front door.
  It did **not** return TangleClaw's own `:3102`, which is the ungated loopback door the pre-chunk-3
  expression would have produced. The hostname is `127.0.0.1` because setup was driven over loopback,
  which is the designed behaviour: the host comes from the request's `Host` header, never from the
  Caddyfile.

  **Not covered:** the direct-mode arm (no Caddy → TangleClaw's own listener), and the browser
  actually following the redirect — this run drove the API, not a UI. Both are narrower than the
  defect chunk 3 fixed, which was the *derivation*.

### C9 — The credential can be changed but never blanked

A settings surface may change the admin credential. No route — settings, API, or skip path —
produces a "no password" state. The only unprotected state is the deliberate, recorded opt-out.

- **Source:** ADR 0009 rule 4 — *"two routes to 'no password' is one more than this ADR allows."*
- **Verification:** unit-testable per route; the real run is confirming no *combination* reaches it.
- **Status: BUILT, NOT SHIPPED** — chunk 3b closes #805 by removing the credential fields from
  `PATCH /api/config`. **#805 is still open**, correctly: the fix is on `v5-baseline` and `main`
  still has the hole. Closes at step 8.

### C10 — Break-glass recovery works, proven by running it

`scripts/reset-admin.js` restores access from the machine, outside the gate. Verified by executing
it, not by unit tests that stub the reload.

- **Source:** ADR 0009 rule 5; chunk 4. Scope says *"verified by running it"* in those words.
- **Verification:** real run, and it must be a real one — the tests stub `launchctl`.
- **Status: ✅ VERIFIED** 2026-08-01 against the **live hand-edited** Caddyfile: hash moved,
  LaunchAgent restarted (PID 28797 → 36189, exit 0), gate re-authenticated, file byte-identical
  apart from the hash and still classified `adoptable`/`safeToWrite: false`.

### C11 — Install, verify, upgrade and rollback are documented for a reader with no background

A stranger can install, confirm it worked, upgrade, and roll back without prior reverse-proxy
knowledge.

- **Source:** Scope clause 9; chunk 4.
- **Verification:** a **cold-context run**, not judgment. **Operator directive 2026-08-02: the field
  installer is not part of any verification path.** He is told after v5 releases and installs
  unassisted — which raises the bar on this criterion rather than lowering it, because the docs will
  be the only thing between him and a broken install, with no one to ask.
  The falsification test that does not need him: **drive the clean install from a session with no
  project context** — no repo access, no memory, no plan; only the published `docs/setup-guide.md`
  and `deploy/INGRESS.md`, on the clean VM step 7 already requires. Every point where that session
  has to guess, infer, or ask is a doc defect, recorded as one. The operator cannot run this test
  themselves — knowing the system is exactly the disqualification — but a cold agent can, and it is
  the same environment C5/C6/C7/C8 need anyway.
- **Status: DELIVERED** — `docs/setup-guide.md` plus `deploy/INGRESS.md`, including two procedural
  defects only the live run surfaced (recovery enforces the *current* password policy, so an older
  credential cannot be restored; and "run it under tmux" is wrong for an operator arriving via ttyd).

### C12 — A session command can never target a neighbouring project

Every tmux target uses exact-match (`=name:`). No prefix or fnmatch fallback can retarget another
project's session.

- **Source:** operator ruling 2026-07-29 (#774) — *"cannot live into or past v5."* Chunk 5.
- **Verification:** unit-testable (pinned), plus the live hot-patch already applied.
- **Status: SHIPPED** to both `v5-baseline` and `main` (`800045d`), verified in-tree tonight.

---

### Criteria at a glance — UPDATED 2026-08-03 after the clean-room run

| | Criteria |
|---|---|
| ✅ Verified by a real run | C1, C2, C3, **C5**, **C6**, **C7**, **C8**, C10 |
| Shipped / delivered, verification is not a run | C11 (docs exist), C12 |
| Built but not shipped to `main` | C9 — closes at step 8 |
| Partial | C4 — see below, strengthened but not closed |
| **Still needs a run** | **C11 cold-context doc pass** — the only outstanding criterion |

**C1 and C2 were re-verified on the v5 tree in the same run**, not carried forward on the older
evidence. C1: `netstat` on the fresh install showed only `127.0.0.1.3102` / `127.0.0.1.3100`, with
config `ingressMode: direct`, `bindAllInterfaces: false`, `authEnabled: false`, `setupComplete: false`
and no credential. C2: the **generated** Caddyfile carries `servers :8443 { protocols h1 }` — #845's
fix reaching a fresh install end-to-end, which is the direct-mode-arm question the old table
deferred.

**C4 moved from "refusal paths tested" toward closed but is not there yet.** The live validator
refused `adminPassword` containing `adminUser` (`400 Password must not contain the username`) during
the run, and the forced-set path produced a real bcrypt hash in the generated file. The end-to-end
*wizard* refusal — a browser walking the step — is still not separately recorded.

### The blocker — RESOLVED 2026-08-03, and it was narrower than written

The section below said C5/C6/C7/C8 were **BLOCKED until #845 lands**. That conflated two different
claims, and the conflation cost time:

- *True:* those criteria cannot be measured **on this box**, whose perimeter is a hand-edited config
  the product cannot reproduce.
- *False:* that they were blocked outright. Step 7 always specified a **clean install**, where the
  Caddyfile is generator-written and there is nothing to drift from — so generator-vs-this-box parity
  is simply not an input to the measurement.

**#845 is closed** (the h1 pin now emits, and the clean-room Caddyfile proves it). **#846** — the
generator emits no access-log block — was **decided rather than built** on 2026-08-03: access logging
is deliberately **not** generator-owned, because #821 records that ingress logging grows unrotated
and can capture a `basic_auth` hash, so defaulting it on would hand that hazard to every new install.
Recorded in `deploy/INGRESS.md`; #846 did **not** block this run and never should have.

Audit method, unchanged and still binding: audit parity by **diffing** a generated file against the
live one via the cutover's own option assembly — never by grepping `NOTE (manual, …)` markers, the
biased method that made #845 report one drifted setting when there were two.

### How step 7 runs

**C5, C6, C7, C8 and C11 are all deployment-path criteria, and none can be answered on this box.**
They need a clean install — which means **one fresh-install run answers all five**, rather than five
separate exercises.

C11 rides the same install. **Operator directive 2026-08-02: the field installer is not part of any
verification path** — he is told after v5 releases and installs unassisted. So C11's reader is a
**cold-context session** given only the published docs and that clean VM. This is a stricter test
than a knowledgeable human walking it, because a cold agent cannot silently fill a gap from prior
knowledge the way the operator inevitably would; every guess it has to make is a recorded doc
defect. It also removes the last thing in step 7 that depended on someone else's availability.

**Order:**
1. ~~**#845**~~ — **CLOSED.** And it was never a blocker for a *clean-install* measurement; see above.
2. ~~**C2**~~ — **DONE.** Caddy-mode arm 2026-08-02; direct-mode arm folded into the clean install and
   confirmed 2026-08-03 (the generated Caddyfile carries the h1 pin).
3. ~~**One clean install**~~ — **DONE 2026-08-03.** C7 first as recommended, then C5, C6, C8; C1/C2/C4
   re-measured on the way through. All four target criteria PASS.
4. **C11** — cold-context run: a session with only the published docs attempts the install, and every
   gap it hits is logged as a doc defect. **THE ONLY OUTSTANDING CRITERION.**

### What the clean-room run actually cost, and how to redo it

Recorded because the next person should not rediscover any of it:

- **Guest:** `tart clone tc-base tc-vrf-v5`, then `nohup ~/bin/tart run tc-vrf-v5 --no-graphics &`.
  `tart` is at `~/bin/tart` on habitat and is **not** on the non-interactive `PATH`. Licence cap is
  **two running guests** — `tc-vrf` was already running, so the pair was at the ceiling.
- **Guest SSH:** `admin`/`admin`. The `~/.ssh/tc_cleanroom` key on habitat was injected into the old
  `tc-vrf`, **not** into `tc-base`, so a fresh clone needs `ssh-copy-id` driven by `expect`
  (habitat has `expect`, no `sshpass`).
- **A stock guest has no `git`.** `/usr/bin/git` is the Xcode stub, so the README's very first
  command fails with *"No developer tools were found"*. Installed headlessly with the
  `.com.apple.dt.CommandLineTools.installondemand.in-progress` touch-file + `softwareupdate -i`.
  **This is a C11 doc finding**, not just run friction — see below.
- **Driving `install.sh`:** under `expect`, answering `password:` and Homebrew's `[y/n]`. Use **glob**
  patterns, not `-re`; two malformed regexes silently never matched and the install parked at a
  prompt looking like it was working.
- **Runtime: ~35 min** for the full dependency bootstrap (no Homebrew present at all).

### Findings from the run — none are v5 scope regressions

1. **#859 (filed)** — one `GET /api/projects` **permanently wedges the whole server**. Stack:
   `fs::ReadDir` → `uv_fs_scandir` → `open$NOCANCEL`, blocked in-kernel — a *synchronous* readdir on
   the main thread over the default `projectsDir` of `~/Documents/Projects`, which is TCC-protected.
   `/api/health` answered 200 seconds earlier, then 000. No error, no log, no recovery; `launchctl`
   still reports it healthy. **This box cannot reproduce it — node here already has Full Disk Access.**
   Distinct from #324, whose (good) preflight guards the *repo* path, not `projectsDir`.
2. **C11 doc findings:** the stock-Mac `git` prerequisite is undocumented (above); and `install.sh`
   prints `TangleClaw v3 installed successfully!` — stale branding on a v5 tree — and exits **0** with
   a green banner even after printing its red #324 diagnosis.
3. **Corrected mid-run, worth keeping:** `install.sh`'s #324 handling is **good** — an up-front NOTE,
   then on health failure a red block naming the cause, the exact Full Disk Access remedy, the
   resolved node path, and the `sample` command to confirm. An earlier claim in this session that it
   said nothing about the cause was wrong; the grep used to check it simply missed those lines.

**Not the Docker/Debian clean room** — no `launchctl`, so it would produce a green result while
skipping the step under test.

### Questions — all settled 2026-08-02

1. ~~C6 — implement or amend?~~ **Withdrawn.** Neither: the exemption exists and the deployment is
   stale. Superseded by #845.
2. **Is C2 worth a real run?** Recorded as done, never measured, and it is the more dangerous of the
   two listeners — a `--writable` terminal that execs `tmux attach-session`. Recommend yes; it is
   one probe and it does not wait on #845.
3. ~~Does the field installer read C11?~~ **Settled by operator directive 2026-08-02 — no.** He is
   not relied on for anything and is told after v5 releases. C11 is verified by a cold-context run
   instead (see the criterion). Nothing else in this list depends on him.

---

## Decision — the 5.0.0 bump

**Recorded 2026-07-29. Recommendation: take the major.**

Chunk 2 changes a shipped default in a way that can remove an operator's remote access. That is
breaking under any reading, and a major version makes people read release notes before an update
that can take their dashboard away. Mechanically it requires a `BREAKING:` marker in the
`[Unreleased]` entry — the wrap derives the level from changelog content and nothing else produces a
major.

Precedent worth knowing: chunk 1's entry already carried a `BREAKING:` marker, which would have made
it 5.0.0; it shipped as **4.35.0** instead. So this decision has been deferred once. Deferring again
is legitimate, but it should be a decision, not a default.

## Release freeze — how nothing ships until v5 is ready

Two independent holes, two separate controls. Each closes a hole the other does not.

**1. Version freeze — DONE 2026-07-29.** `versionBumpEnabled` is set to **`false`** for the
TangleClaw project. `release.yml` triggers only on `version.json` changing on `main`
(`paths: ['version.json']`), so with the bump step off, **no release can be tagged or published no
matter how many wraps run**. Wraps still do everything else — tests, changelog, commit, PR,
continuity. `[Unreleased]` accumulates entries across every chunk because `changelog-update` still
runs; `version-bump` is only what promotes it. The setting is checked by the step at run time, not
cached at session launch, so it took effect immediately with no relaunch.

> **⚠ STEP 8 DEPENDS ON TURNING THIS BACK ON.** If it stays `false`, v5 finishes and silently never
> ships. Flip `versionBumpEnabled` back to `true` for TangleClaw before the release wrap. Reversal is
> a checkbox in project settings, or
> `curl -X PATCH http://localhost:3102/api/projects/TangleClaw -H 'Content-Type: application/json' -d '{"versionBumpEnabled": true}'`.

**2. Install freeze — the `main` branch question.** `README.md:153` instructs a bare
`git clone https://github.com/Jason-Vaughan/TangleClaw.git` with **no tag and no branch pin**, so a
fresh install takes whatever is on the default branch. Anything merged to `main` is therefore
immediately installable by a stranger, half-built or not. Existing installs are unaffected — the
updater follows release tags — but a *new* install during the freeze would get partial v5.

**Mitigation applied 2026-07-29 (PR #766):** the README Quick Start now clones
`--branch v4.38.0` rather than tracking the default branch, with a note saying why and that it goes
away at the next release.

> **⚠ STEP 8 ALSO DEPENDS ON UNDOING THIS.** Move the README pin to `v5.0.0` and delete the
> accompanying note when the release ships. Left in place, every new install is stranded on 4.38.0
> permanently.

**This is a documentation control, and ADR 0009 says in terms that documentation is not a control.**
It protects everyone who follows the README; a bare `git clone` with no `--branch` still lands on
`main`. The structural half is the branching decision below.

**Consequence for §6's branching advice, corrected 2026-07-29:** the original recommendation
(per-chunk branches merging straight to `main`, no integration branch) weighed the live-serving-tree
hazard and missed that `main` is the documented install source. See "Open decision" below.

## Standing hazards for this work

- **The live Caddyfile is hand-edited.** The generator would overwrite it, including the credential
  and both gate exemptions. Never run the cutover on this box. Build the preserve-or-refuse guard
  before anything that could invoke it. See `project_caddy_ingress_live_state`.
- **This clone is the live install.** Chunks 2 and 3 are frontend-heavy. Use a worktree; keep this
  checkout on `main`.
- **Chunk 3b sits next to the settings-modal backlog** (#755, #756, #758, #764, and now #768 — the
  Master drawer control bar, which surfaces #755/#756). Most likely creep vector. Credential surface
  only. The upload and wrap-feedback issues filed 2026-07-29 (#769, #770, #771) are the same shape:
  real, cheap, adjacent, and deferred.
- **`install.sh` already provisions `caddy` and `mkcert`.** The plan's headline cost is already
  paid — do not reopen the dependency debate.

## DECIDED — all v5 work lands on `v5-baseline`, never on `main`

**Operator decision 2026-07-29.** The integration branch `v5-baseline` exists and is pushed, cut from
`main` at `0bc2b0d`. `main` stays at v4.38.0 for the whole of v5.

### The working rule

| | Branch |
|---|---|
| This checkout (serves the live install) | **stays on `main`** — never check out v5 work here |
| Chunk work | worktree off `v5-baseline`: `git worktree add .claude/worktrees/<name> -b feat/710-chunk2 v5-baseline` |
| Chunk PRs | `gh pr create --base v5-baseline` — **explicitly**; the default base is `main` |
| Final integration | one PR `v5-baseline` → `main`, at step 8, reviewed as a whole |

### Why the wrap cannot leak through this (verified, not assumed)

`lib/wrap-steps/commit.js:632` auto-branches **only** when the current branch is literally `main` or
`master`, and the auto-PR bases on `originalBranch` — the branch the session started on. A wrap run
on `v5-baseline` or on a chunk branch therefore commits *there* and opens no PR against `main`.

Corollary, accepted deliberately: because `v5-baseline` is not a protected branch name, wrap commits
land on it without review. That is the right trade for an integration branch — review happens once,
at the integration PR, where the change can be judged as a whole.

### The one way work can still reach `main` by accident

`gh pr create` defaults its base to the repository default branch. **A chunk PR opened without an
explicit `--base v5-baseline` targets `main`.** That is the single mistake to guard against; nothing
in the tooling prevents it.

### The reasoning behind it

| | Chunk PRs → `main` | Chunk PRs → `v5-baseline` |
|---|---|---|
| A stranger cloning mid-work | **Gets partial v5** | Gets 4.38.0 — `main` never moves |
| This box (serves `main`) | Runs half-built auth code on the operator's live install | Stays on shipped 4.38.0 throughout |
| Version reporting | Says 4.38.0 while running v5 code — confusing | Honest |
| Merge cost | Incremental | One final integration PR |
| Drift risk | None | Real, but small — everything else is deferred, so `main` is quiet |

The drift argument that normally kills long-lived branches is weak here specifically: the v5 plan
defers everything else, so `main` has almost nothing landing on it during the freeze. The second row
decided it — chunk 2 provisions Caddy and rewrites the wizard, and this machine's remote access
depends on a hand-edited Caddyfile. Half-built ingress code has no business on the branch this box
serves.

This supersedes the original §6 recommendation, which weighed the live-serving-tree hazard and
missed that `main` is the documented install source.

## After v5 — how development changes once the tag is live

**Operator direction, recorded 2026-07-29.** v5 is the last release built the current way. Rapid
successive releases — 4.35 → 4.38 in a handful of days, each a small increment pushed straight out —
stop when 5.0.0 ships.

From then on: work happens on **side branches**, merged back deliberately; releases are **batched,
ordered, and less frequent**. The operator's phrasing: *"a complete train with cars, sorted."*

**`v5-baseline` is the prototype, not a one-off.** It was adopted as a freeze measure, but an
integration branch collecting chunk PRs behind one reviewed merge *is* the standing model. Treat v5
as the first instance of the practice rather than an exception to unwind at step 8.

**What does not change:** the release *mechanism*. `release.yml` still tags and publishes on
`version.json` changing on `main`, the bump level is still derived from `[Unreleased]`, and
hand-tagging stays prohibited. What changes is how much accumulates behind one tag, and where it
accumulates while it does.

**The tension, stated now rather than discovered later.** Batching lengthens the feedback loop with
the single external installer — the only place several classes of defect are observable at all.
Under today's cadence his bug was fixed and released the same day (#759); under a batched model it
waits for the next train. So the batched model needs an explicit **fast lane for field-reported
defects** — the same carve-out the freeze already needed, made permanent. Without it, "less frequent
releases" silently means "the only external install waits weeks," which is a different decision than
the one being made.

### The first car: Master control — DECIDED 2026-08-01

**The Project Master's read/write toggle is the next release's headline, and it is NOT in v5.**
Raised by the operator during chunk 4 as the thing they most want ("really hobbling to have read
only access"), considered for v5, and deliberately scheduled behind it. The operator accepted the
recommendation the same day.

Scope: **#755** (make the access-level control functional — `suggest`/`write`, server-enforced),
**#756** (launch-mode selector, hardcoded `null` today), **#768** (master drawer header becomes a
real control bar carrying both mode axes). Tracked together as the first train car.

**Why it waits, and why the ordering is correctness rather than scheduling:**

- **A write-capable Master is materially more dangerous on an install with no login** — which is
  exactly the state v5 exists to eliminate. #755's own design requires server-side enforcement via a
  scoped token, so it wants the hardened, gated baseline underneath it and can build on the AUTH-4
  service-token mechanism. Building a new write-authority surface *during* the release that is still
  establishing the perimeter means reviewing both at once.
- **It is not a flag flip.** `MASTER_ENABLED_ACCESS_LEVELS` is `['read-only']` (`lib/master.js:78`)
  and `PATCH` rejects anything else (`server.js:575`), but widening the list would achieve nothing:
  the Master's home is the data directory `~/.tangleclaw/master/`, so it has **no project checkout to
  write to**. Read-only is enforced by construction today, not merely by instruction. Real work: an
  enumerated mutation set, a scoped token, server-side enforcement, and a confirmation flow for
  `suggest`.
- **Consistency with the Switchboard call.** v5 already declined to absorb a large adjacent want for
  the same reason — shipping the secure baseline the field installer is waiting on beats widening it.
  Reversing that for a second feature would make the withdrawal arbitrary.

**Carry-over risk to watch:** #755 records that this work previously existed *only* as a "successor
work: G2 (post-4.0)" line inside `docs/adr/0008-project-master-session-model.md`, with no issue — so
it was unfindable and the operator correctly remembered asking for it and could not locate it. The
failure mode is losing it again between releases. It is on the train because it is filed, milestoned
and named here; keep all three.

## Baseline — MEASURED 2026-07-29 (clean-room run, step 3 complete)

Ran the `deploy/cleanroom` gate on habitat against a fresh clone of `0bc2b0d` with a virgin
`~/.tangleclaw`. The plan's most load-bearing claim is no longer inferred.

**Chunk 1 confirmed.** A virgin install binds loopback only —
`listening on http://127.0.0.1:3101 ... ingressMode=direct bind=default`. Verified at the socket, not
from the log: `/proc/net/tcp` shows `0100007F:0C1D` and nothing on `00000000`, and connecting to the
container's own non-loopback address is **refused**. Defaults on disk: `ingressMode=direct`,
`bindAllInterfaces=false`, `authEnabled=false`, `setupComplete=false`.

**The v5 gap, measured.** `POST /api/setup/complete {}` returns
`200 {"ok":true,"setupComplete":true,"warnings":[],"redirectUrl":null}`, leaving
`setupComplete=true, authEnabled=false, basicAuthUser=null`. A *completed* install has no credential
and no warning that it has none — `ADMIN_REQUIRED` is gated on caddy mode and never fires. That is
precisely chunk 2's target. `redirectUrl: null` is chunk 3's, also now measured.

**No new issues.** `install.sh` refuses on Linux with an honest message naming the reason, pointing at
the README, exiting 1. `https-check` honestly reports `mkcert not found on PATH`. The gate produced
zero new findings; the one real gap is #710 itself.

The baked image stays on habitat, so re-provisioning to verify chunk 2 needs no egress window.

## Unverified — do not treat as established
- **Break-glass is built and unit-tested but never executed** against a live Caddyfile; the tests
  stub the reload. Chunk 4 resolves this by running it.
- **Category C is largely classification by exclusion** — all 86 open issue titles read, roughly a
  dozen bodies.
- **OpenClaw** is recorded in memory as an active build; no branch, worktree, or uncommitted work
  exists for it. Classified dormant — correct this if wrong.
- ~~**Medusa** classified dormant~~ — **CORRECTED 2026-07-31.** Not dormant: 28 open issues across
  TangleClaw and `Jason-Vaughan/Medusa`, and the operator uses the Switchboard daily. The absence of
  a branch or worktree measured "no work in flight", which is not the same as "no product here" —
  the defects are in shipped code, not in pending changes. Now scoped by the withdrawal decision
  above and tracked at #818; the surface gap is #820.
- ~~**`/api/health` is NOT exempt from the gate today — measured 2026-07-29.**~~ **CORRECTED
  2026-08-02 — this was a wrong reading of a right measurement.** The 401 is real, but it comes from
  the *deployment*, not the product: `~/.tangleclaw/Caddyfile` is hand-written and contains zero
  occurrences of `api/health`, `@protected`, or `path_regexp`. The product exempts it correctly —
  `lib/caddy.js:127` `AUTH_BYPASS_PATHS`, emitted at `:248` as `@protected not path_regexp …`,
  hardened to anchored RE2 by #434, documented at `SECURITY.md:28`, asserted by
  `test/service-token.test.js:84`. There is nothing to implement and nothing to amend; see **#845**
  (the generator does not emit the live file's `protocols h1` pin, so a cutover would break every
  Chrome terminal). **The general lesson, worth more than the correction: this box's perimeter is a
  config the product cannot reproduce, so no perimeter-shaped criterion can be measured here in
  either direction.**
