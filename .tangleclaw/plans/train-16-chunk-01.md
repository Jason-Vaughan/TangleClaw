---
scope: train-16-chunk-01
lifecycle: active
---

# Train 16 Chunk 01 — The generator can reproduce the live file, and says so when it can't

**Issues:** #846 (generator cannot emit an access log), #848 (nothing detects an already-deployed
unpinned HTTPS listener).

**Critic mode:** chunk

## Why these two are one chunk

They look like separate bugs and are one. #848 asks for a way to notice that a live Caddyfile has
drifted from what the generator would write. Its intuitive remedy — re-run the cutover — is refused
by `caddyfileIsHandEdited`, and if forced is **lossy**, because of #846: the generator cannot emit
the `log { output file … }` block the live tailnet site carries, so a forced cutover silently ends
access logging. Fixing #846 is what makes #848's remediation safe to recommend.

## The confidence check

**Requirements Confidence: High** for C1 — the shape is pinned by four prior instances of the same
pattern (#397, #434) and verified against the operator's own live file. **Low** for C2 until the
Option A/B ruling lands, which is why it is not started.

**Problem.** A TangleClaw-generated Caddyfile and the live one on disk disagree, in ways nothing
reports, and the divergence is not recoverable by regeneration without losing operator edits.

**Success.** (a) `buildCaddyfileContent` can emit an access-log block, and a cutover on a box whose
live file has one re-emits it instead of dropping it. (b) Something reports a live file whose
HTTPS listener is not pinned to h1, keyed on the listen address.

**Out of scope.** Editing the operator's live Caddyfile. Remediating the `:3250` exposure (#1340 —
see "What the audit already found"). The root cause of Chrome's h2/h3 WebSocket abort, which #848
also homes but does not ask this chunk to solve.

## [DECIDED 2026-09-10 — delegated to builder + coordinator] How far does #846 go?

**The operator deferred this**, stating they lack the context to rule on Caddy generator drift and
asking the builder and coordinator to reach consensus. Consensus reached: **build the check, as its
own chunk, and let #846 close as the instance fix it already is.**

Four points, **confirmed by the coordinator 2026-09-10 and filed as #1394 (Train 16 Chunk 04)**:

1. **Build it.** The ledger is five and instance six is otherwise inevitable.
2. **Never parse Caddyfile text.** Run `caddy adapt` on the live and generated files and compare the
   JSON. Caddy's parser is then the parser. This is not a preference — writing THIS chunk's
   fifty-line extractor, I reproduced the defect class three times (line-wise match dropping
   `format`/`level`; matching the global-options logger; taking the per-site block while dropping a
   global one). A hand-rolled parser inside the audit is instance six living in the thing built to
   prevent it.
3. **Diff PROPERTIES, not documents.** The live gate is a `(tcauth)` snippet plus `handle` blocks;
   the generator emits `@protected not path_regexp` with an inline `basic_auth`. Same intent,
   different JSON — so whole-document equality reports drift on every boot on the one install that
   matters, and a check that cries wolf daily trains the operator to dismiss the real one. Three
   security properties instead: every proxying site has a gate (catches `:3250`); the HTTPS listener
   is pinned to h1, **keyed on the listen address** (catches #845's population); no site proxies to
   an upstream config does not know (catches the next hand-added project service).
4. **Honest not-measured.** `caddy` absent or `adapt` failing reports "not measured", never "clean" —
   `architecture.md` § Direction binds a dependency's failure to degrade TC, not crash it, and a
   check claiming clean when it did not run is worse than no check.

Scope: **its own issue and chunk, not this one** — filed as **#1394**, rostered as Train 16
Chunk 04. Chunk 01 is committed and reviewed; bolting a subsystem onto it re-opens everything
already graded.

## [SUPERSEDED — kept for the reasoning] How far does #846 go?

`/prawduct:learnings` returned a ratified rule: *a generator whose output is a hand-edited live
file WILL diverge repeatedly — treat the third occurrence as a class defect and fix the audit, not
the instance.* The ledger stands at **five**: the basic_auth credential (#397), the tailnet site
(#434), the h1 pin (#845), the access log (#846), and the `:3250` block found while scoping this
chunk.

- **Option A (as filed).** Teach the generator the access-log option. One more instance fix.
- **Option B (what the learning prescribes).** Also build the semantic generated-vs-live audit —
  diff `caddy adapt` JSON of the live file against the generated one — which finds the *sixth*
  divergence, and subsumes #848's detection rather than special-casing the h1 pin.

**C1 below is invariant under this ruling and is being built now.** C2 is written against Option B
and is NOT started. If the operator rules Option A, C2 narrows to a listener-pin check only.

**Why a semantic diff and not a text diff:** the live file expresses the gate as a `(tcauth)`
snippet plus `handle` blocks; the generator emits `@protected not path_regexp …` with an inline
`basic_auth`. Both adapt to equivalent JSON. A textual comparison is pure noise here — verified by
reading both.

## Chunks

### Chunk 01: The generator can emit, recover and adopt an access log

- [x] **C1 — The generator can emit, recover and adopt an access log.** Follows the pattern #397
      used for the credential and #434 for the tailnet host, at every site that models the
      generator's option set:
      1. `lib/store.js` — `caddyAccessLogPath: null` default.
      2. `lib/caddy.js` `_pushSiteBlock` / `buildCaddyfileContent` — an `accessLogPath` option,
         validated like every other operator-settable value that lands inside a directive.
      3. `lib/caddy.js` `extractGeneratedCaddyfileOptions` — recover it. **Required, not optional:**
         `lib/admin-credential.js` proves recovery is total by rebuilding and comparing bytes, so an
         option the extractor cannot read back turns a working credential-add into a refusal.
      4. `lib/caddy.js` `computeCaddyfileAdoption` — adopt the live file's log path when config
         lacks it, so the next cutover re-emits it.
      5. `scripts/ingress-cutover.js` — pass it from config in the real option assembly.
      **Done when:** a cutover computed against the live file's own adopted config reproduces its
      access-log block, and the `admin-credential` round-trip still holds byte-for-byte.
      **DONE 2026-09-10.** Verified against the operator's real live Caddyfile: adoption recovers
      `/Users/jasonvaughan/.tangleclaw/logs/caddy.access.log` and a rebuild re-emits it on all
      three proxying sites, where a cutover previously emitted no `log` block at all. Suite green.
      Six mutations run red and restored — emission, recovery, adoption, validation, and the
      cutover call site both dropped and hardcoded. The call-site mutation reddened NOTHING before
      `test/ingress-cutover.test.js` gained a test for it, which is the gap this chunk's plan
      predicted and the project's standing learning names.
      **Self-caught on deep scrub, fixed in `73199379`:** the first cut matched `output file`
      line-wise, so a block carrying `format json` / `level ERROR` / a nested `{ roll_size … }`
      read as though it held only a path — adoption would have stored it and the next cutover
      re-emitted a log stripped of the rest. That is #846's own failure shape reintroduced inside
      its fix. The extractor now walks the block and refuses anything it cannot reproduce.

### Chunk 02: The live file is diffed against what the generator would write

- [ ] **C2 — The live file is diffed against what the generator would write.** NOT STARTED —
      gated on the decision above.

## What the audit already found, before it was built

Running the method the learning prescribes (diff generated-vs-live through the real caller's option
assembly, via `caddy adapt`) against the operator's live file took minutes and surfaced:

- **An ungated site (#1340), confirmed live.** `http://cursatory.tail123678.ts.net:3250` proxies
  to TangleBrain's loopback-only `127.0.0.1:3250` with **no `basic_auth`**, serving its knob panel
  to anything on the tailnet. Its own comment ("Remote access to TangleBrain GUI via tailnet")
  shows it was added deliberately — but it is the only site in the file without a gate, so it is
  inconsistent with the file's own posture rather than merely undocumented. Reported; not touched.
- **#848's population claim is wrong.** It says every pre-fix install is still unpinned. The
  operator's own `:8443` **has** the h1 pin — remediated by hand. Verify the population before
  acting on the issue's framing.
- **#848's detection snippet is already stale.** It keys on the server name `srv1`; the live file
  grew a listener and `:8443` is now `srv2`. Server names are positional — key on `listen`.

## [RULING DELEGATED 2026-09-10] This chunk departs from a recorded decision

`deploy/INGRESS.md` records a decision of **2026-08-03** that access logging is deliberately NOT
generator-owned, in the words "it is not a bug to be fixed by teaching the generator to emit one".
That is branch 2 of the two-branch decision #846's own body sets out. C1 implements branch 1's
shape and so departs from it.

The decision reserved its own re-argument to the operator ("a decision for the operator, not a side
effect of this fix"), so it is **amended in place, not replaced**. The operator has since deferred
the #846 decision to the builder and coordinator, citing a lack of context on Caddy generator drift,
so the re-argument falls to that consensus — which ratifies the narrow departure below and is
recorded above. **Both parties confirmed 2026-09-10**; the operator's reservation is discharged by
their own delegation, not by assumption.

What shipped is narrower than what the decision refused, and the residual argument still holds: the
key defaults to `null`, so TangleClaw never creates a log on a machine whose operator did not ask
for one; it only preserves one an operator added by hand. Rotation stays Caddy's own directive.
Not taken: whether the generator should own logging at all, or default it ON for remote-reachable
sites.

**How this reached a train at all:** the 2026-08-03 decision lives ONLY in `deploy/INGRESS.md`.
#846 is still OPEN with zero comments, so from GitHub it reads as an unfixed bug — which is how
the coordinator rostered it. Whichever way the ruling lands, it belongs on the issue.

## Verification

Suite green on `269cdba0` before this chunk, and green after it — the totals live in the
evidence store (`prawduct-hook test-status`), never copied into prose where they go stale.

Mutation checks this chunk owes, per the project's recurring family-enumeration defect: flip the
`accessLogPath` argument **at the cutover call site** and watch a test go red — a test of
`buildCaddyfileContent` alone does not cover the caller's policy argument.
