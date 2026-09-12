# Train 16 — Chunk 04: Caddyfile security divergence check

**Issues:** #1394 (build), #1373 (docs)
**Branch:** `feat/1394-caddy-drift-check`
**Worktree:** `.claude/worktrees/train16-c04` — mandatory, this chunk touches `public/` and `server.js`
**Critic mode:** cumulative
**Size:** medium
**Baseline:** suite green at `4e9a157f` (0 fail, exit 0)

---

## Confidence check

**Problem.** TangleClaw generates the Caddyfile but never looks at it again. The live file is
hand-edited and load-bearing, and six recorded incidents of generator drift have gone unnoticed
because nothing compares what is running against what the generator would produce. The current
live file fronts `:3250` with no gate; no mechanism in the system can see that.

**Success.** On boot, TangleClaw reports — neutrally, in the dashboard the operator actually
reads — each security property the live Caddyfile does not hold, or reports the property as
*not measured* when it could not be determined. Running it against the live `cursatory` Caddyfile
names the `:3250` block.

**Out of scope.** Blocking, refusing, or rewriting anything. Generating per-port proxy sites
(#1340, deferred behind tier 1). Re-founding adoption on `caddy adapt` (see D6).

---

## Discovery findings (verified against the live install, not recalled)

Run: `caddy adapt --config ~/.tangleclaw/Caddyfile` on cursatory, caddy v2.11.4.

**F1 — The live file already fails three of the four properties.** `srv0` listens `:3250`,
reverse-proxies `127.0.0.1:3250`, carries no `authentication` handler, and `:3250` is a port the
TC config knows nothing about. This is the hand-added block from the incident. It is the chunk's
end-to-end fixture and its acceptance case.

**F2 — An absolute "every proxying site has a gate" fires on TangleClaw's own correct output.**
`_pushSiteBlock` deliberately emits an ungated route for `AUTH_BYPASS_PATHS`
(`/openclaw-direct/*`, `/manifest.json`, `/api/health`), and `_pushRedirectBlock` emits an
ungated `http://<tailnet>` redirect site. Both appear in the adapt JSON as routes with a handler
and no `authentication`. The property must therefore be evaluated as a **difference from the
baseline's own property value**, which is exactly what the issue means by "diff properties, not
documents" — it is not only about cosmetic noise.

**F3 — `caddy adapt` output embeds the bcrypt hash verbatim.** It appears four times in the live
adapt JSON as `http_basic.accounts[].password`. Anything derived from adapt output that reaches a
log, an API response, or the dashboard must pass `caddy.redactHashes` first (#821), and no raw
adapt JSON is ever logged.

**F4 — Server names are positional and shift.** adapt assigns `srv0/srv1/srv2` in file order. The
hand-added `:3250` block took `srv0` and pushed the HTTPS server from `srv1` to `srv2`. Keying the
h1 assertion to a server *name* would silently have moved it onto the wrong server. This is why
the issue says "by listen address, not server name"; it is now confirmed on real output.

**F5 — SQLite takes the `reach` column in one statement.** `ALTER TABLE port_leases ADD COLUMN
reach TEXT NOT NULL DEFAULT 'loopback' CHECK(reach IN ('loopback','tailnet','lan'))` succeeds,
backfills existing rows to `'loopback'`, and enforces the CHECK. No table rebuild (contrast the
v7→v8 rename-and-copy migration).

---

## Decisions

**D1 — Diff property VALUES, live against baseline.** Baseline = `buildCaddyfileContent()` fed
from live config. Both sides go through `caddy adapt`. A property is divergent when the live value
is *weaker* than the baseline value, never when it merely differs. Rationale: F2.

**D2 — Caddy's parser is the only parser.** No new text walking, no regex over Caddyfile syntax.
Both sides adapt; the check reads JSON only.

**D3 — Redact before anything leaves the module.** Every message and log payload passes
`caddy.redactHashes`. Raw adapt JSON never reaches a log. Rationale: F3.

**D4 — Honest degradation is per-property, not global.** `caddy` absent or `adapt` non-zero on
either side ⇒ all four properties `not-measured` with the reason. PortHub unreachable, or a lease
carrying no `reach` ⇒ **only P4** is `not-measured`. No path produces `clean` from an unrun check
(the #1395 failure shape).

**D5 — Listeners are identified by listen address.** Rationale: F4.

**D6 — `scanAccessLog` and `extractTailnetHost` are NOT retired.** Scope rule 4, answered:

Both are consumed by `computeCaddyfileAdoption` (`lib/caddy.js:1231`, `1242`), which reconstructs
`config.caddyTailnetHost` and `config.caddyAccessLogPath` so a future cutover **re-emits** the
operator's hand-edits. That is a different question from the one this check asks. The check asks
"does the live file hold property X"; adoption asks "what value must the generator carry forward".

The decisive constraint is degradation. This check is allowed to answer *not measured* when caddy
is absent — adoption is not. An adoption that silently declined to read the log path would let the
next cutover drop the operator's audit trail, which is #846's own outcome. So adoption needs a
caddy-free read path, and the walkers are it. The deferral is resolved as **keep**, not deferred
again.

**D7 — Surfaced as a boot-time notice on `/api/server-info` plus a dashboard notice**, mirroring
`serverInfo.setBindNotice` / `setTtydNotice`. A log line is the wrong channel: the operator is
almost never on this machine. State-driven, self-clearing on the next boot, no dismiss control and
no timer (#98/#268).

**D8 — Reports, never blocks.** The `:3250` block is a deliberate operator choice, affirmed twice.
Neutral wording names the missing property; it does not attribute a mistake.

**D9 — P1 checks gate PRESENCE, not gate BREADTH. Scope stated, not silently dropped.**

The first implementation also compared the live gate's matcher signature against the baseline's and
reported any difference. Run against the real live Caddyfile it produced three findings on three
CORRECTLY GATED sites — the exact false-positive class the issue's "diff properties, not documents"
requirement exists to prevent, and my own D1 forbids (report weaker, never merely different).

The cause is structural, not a bug in the comparison. The live file states its gate as one route
holding `[authentication, reverse_proxy]`; the generator states the same gate as a route matching
`not path_regexp ^(bypass)$` carrying `authentication`, followed by an unmatched `reverse_proxy`.
Deciding which of two matcher sets admits more requests means reimplementing Caddy's matcher
algebra, which is a different and much larger piece of work than this issue asks for.

The issue's stated property is "Every site that proxies has a gate." That is what ships. Drift in
the BREADTH of a gate — a hand-widened bypass regexp — is **not covered** and is filed as its own
issue rather than approximated. Recorded here because a reader of the shipped check would otherwise
reasonably assume it catches a widened bypass. Filed as #1403.

---

## The four properties

| # | Property | Measured from | Degrades to `not-measured` when |
|---|---|---|---|
| P1 | No proxying site lacks a gate the baseline does not also omit (presence, not breadth — D9) | gates + proxies per site, keyed by listen address and host | adapt unavailable, or config generates no gate at all |
| P2 | The HTTPS listener negotiates `h1` only | `servers[].protocols` keyed by listen address = `httpsPort` | adapt unavailable, or no listener on `httpsPort` |
| P3 | No upstream `dial` target outside the set the baseline dials | `reverse_proxy.upstreams[].dial` | adapt unavailable |
| P4 | No site fronts a port whose PortHub lease declares a narrower `reach` | P3's dial set × `port_leases.reach` | adapt unavailable, PortHub unreachable, or the lease has no `reach` |

---

## Status

- [x] **04a — `reach` on the PortHub lease.** Schema v34→v35 (F5), `registerPort` option,
      `/api/ports/lease` passthrough, `getLeases` exposure. Tests: migration backfills existing
      rows to `loopback`; CHECK rejects an unknown value; an old lease reads `loopback`;
      round-trip through the HTTP API.
- [x] **04b — `lib/caddy-drift.js`.** `adaptCaddyfile(path)` / `adaptCaddyfileContent(text)`,
      `summarizeConfig` to reduce adapt JSON to sites and listeners, and one checker per property
      (`checkGates`, `checkHttpsProtocols`, `checkUpstreams`, `checkLeaseReach`) each returning
      `{ status, findings }` where status is `holds | diverged | not-measured`; `checkCaddyDrift`
      composes them. (Planned as a single `compareProperties` returning `{ status, detail }` — split
      per property because each degrades for its own reasons, and named `findings` because the
      operator-facing strings are plural per property.) Tests built from the REAL live Caddyfile shape, with
      the `:3250` block as the divergence fixture and TC's own generated output as the must-stay-
      clean fixture (F2). Mutation-check each property: break it, watch it go red.
- [x] **04c — Wiring + surfacing.** Boot-time run, `serverInfo.setCaddyDriftNotice`,
      `/api/server-info` field, dashboard notice in `public/landing.js` + `public/style.css`.
- [x] **04d — Docs + #1373.** `docs/caddy-drift-check.md`; FEATURES.md entry; CHANGELOG.
      Separately: amend `docs/adr/0014-dual-key-review-for-untrusted-prs.md` to record that
      reading (b) governs the live-serving category, reconcile the "Rejected — security trip"
      table row, and state the published-boundary asymmetry decision the ADR says must be made
      before first use (it has now been used twice without it).

### Critic record

`cumulative` rev-20260912T033048Z-bf760c55 — 1 blocking, 9 warnings, 12 notes. All fixed or
accepted in one pass (`cba84ec6`). **Four** `verify-resolutions` rounds followed, each returning
0 blocking / 0 warning / 0 note: the first verified all ten findings from the tree, then one per
post-review commit (the record-closing delta, the PR-review fixes, the skip-ledger fix).

**Three of those rounds were self-inflicted and the pattern is worth naming**: each time, a
judgeable change was committed after a clean review. The gate priced it every time
(`cost-of-commit`), and "one more small fix" kept getting treated as free when it had already been
told it was not. The habit to keep instead: batch every judgeable fix before the review, and take
the free path (`.prawduct/` records, non-governance prose) for anything that lands after it.

The blocking one is worth keeping here: `describeDrift` derived the operator notice from the
divergence-only `findings` list, so a `not-measured` property with nothing diverged returned null —
silence, plus a boot log calling the file clean. The tri-state was built through four checkers,
tested on every one of them, and asserted in D4, the module JSDoc and the design doc; it was thrown
away at the single surface that reaches a human. **A property modeled mid-pipeline is only real if
something asserts it at the EXIT.**

Two observations deliberately NOT actioned, recorded so they read as decisions:

- **`tc ports` keeps a literal `loopback|tailnet|lan` in its help text** rather than joining
  `store.LEASE_REACHES`. `lib/tc-verbs.js` is dependency-free and `lib/store.js` requires
  `node:sqlite` at module scope, which prints an ExperimentalWarning to stderr on load — the import
  would put a Node warning in front of an agent on every `tc` verb. Verified, not assumed. A third
  prose copy of three words costs less; the reasoning is inline at the call site.
- **`checkLeaseReach` drops its `unmeasured` reasons when any dial diverged.** The property still
  reports DIVERGED, so nothing reads as clean; only the unattributable-dial detail is lost, and
  carrying both would need a third field on every property's return shape.

**Tick after the Critic, not before** — the last tick disarms the Stop gates.

**Done when:** all four ticked, suite green, `/prawduct:critic cumulative` clean, and the check
run against the real `~/.tangleclaw/Caddyfile` names the `:3250` block by its missing properties.

## Operator verification

Visual change: yes (04c dashboard notice). Enqueue in `.prawduct/operator-verification.md`.
