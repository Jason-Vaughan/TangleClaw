# Caddyfile security divergence check (#1394)

**Status: built (2026-09-12). `lib/caddy-drift.js`.**

Related: [ADR 0003 — Ingress model](adr/0003-ingress-model.md),
[ADR 0004 — AUTH-2 basic_auth gate](adr/0004-auth-2-basic-auth-gate.md),
[Auth status surfacing](auth-status-surfacing.md), `lib/caddy.js`, `lib/porthub.js`.

## Problem

TangleClaw generates the Caddyfile and then never looks at it again. The live file is hand-edited
and load-bearing — six recorded incidents of generator drift, and no mechanism that could see any
of them. The most recent put an unauthenticated reverse proxy on a reachable port.

That incident is the one that settles the design. The exposed block was **hand-added**: `lib/caddy.js`
emits exactly one `reverse_proxy` upstream, TC's own server port, and there is no code path by which
it could emit a second (ADR 0003 — Caddy fronts TC, not the services behind it). So no change to the
generator could have prevented it, and no future generator feature will prevent the next one.
**A feature does not prevent a hand-edit. Only something that notices the hand-edit helps.**

## Constraint (why this reports rather than enforces)

The operator hand-edits deliberately, and has twice affirmed that the `:3250` block is fine. A check
that blocked, refused, or rewrote would be wrong about that case and would be disabled within a week.
This is the same record-not-enforce shape as [auth status surfacing](auth-status-surfacing.md): make
the divergence visible and let the operator decide.

## Design

### Caddy's parser is the only parser

Both sides go through `caddy adapt`, and every property is read off the resulting JSON. A text walker
over Caddyfile syntax would be a seventh way to misread the file. (The two text walkers that remain in
`lib/caddy.js` — `scanAccessLog` and `extractTailnetHost` — serve **adoption**, not this audit, and
are not replaced by it; see "What this does not replace" below.)

### Properties are diffed, never documents

Two Caddyfiles that gate identically adapt to structurally different JSON:

| | the gate, as adapted |
|---|---|
| the live hand-edited file | one route holding `[authentication, reverse_proxy]` |
| what TangleClaw generates | a route matching `not path_regexp ^(bypass)$` carrying `authentication`, then a separate unmatched route carrying `reverse_proxy` |

Both are correct gates. A whole-document diff calls that drift. Worse, a naive "was there an auth
handler before the proxy in this handler chain" walk reports **the generator's own output as
ungated**, because there the proxy's chain genuinely contains no authentication handler. So a gate is
recorded as a property of the *site*, not of the proxy route.

### Sites are keyed by listen address, never by server name

`caddy adapt` assigns `srv0`, `srv1`, … itself. Adding the one hand-written block to the live file
moved the HTTPS listener from `srv1` to `srv2`; an assertion keyed to a name would have silently
started asserting against a different server. The fixture pair in `test/fixtures/` pins that fact.

### An unrun check is never clean

Every property answers `holds`, `diverged`, or `not-measured`. Absence of `caddy`, of the Caddyfile,
of a readable baseline, or of a PortHub lease produces the third — never `holds`. The flat `findings`
list carries divergences only, so a caller deciding whether to reassure the operator must read
`measured`, not the emptiness of the list.

## The four properties

| # | Key | Property | `not-measured` when |
|---|---|---|---|
| P1 | `gatedProxies` | No proxying site lacks a gate the generated baseline does not also omit | adapt unavailable, or the config generates no gate at all |
| P2 | `httpsProtocols` | The HTTPS listener negotiates the protocols the baseline pins (`h1`) | adapt unavailable, or the baseline has no HTTPS listener |
| P3 | `knownUpstreams` | No site dials an upstream the generated config does not dial | adapt unavailable |
| P4 | `leaseReach` | No site fronts a port whose PortHub lease declares a narrower `reach` | adapt unavailable, PortHub unreachable, the port has no lease, or the lease has no readable reach |

**P1 is gate PRESENCE, not gate BREADTH.** A hand-widened bypass matcher leaves the site gated and is
not reported. The first implementation did compare matchers and fired on three correctly gated sites,
because deciding which of two matcher sets admits more requests means reimplementing Caddy's matcher
algebra. Tracked as **#1403** rather than approximated — approximating it produces exactly the
false-positive class this check exists to avoid.

**P4 is scoped to the upstreams P3 already found unknown.** The upstreams TangleClaw generates are
fronted by design — TC's own server binds loopback precisely *because* Caddy is the front door — so
cross-referencing those would report the architecture as a fault. P4's value is that it turns
"unknown upstream" into a named owner and a declared intent:

> port 3250 is leased reach:loopback by "TangleBrain-Builder" (knob-gui), but the live Caddyfile fronts it

### The baseline comes from config, not from the live file

`lib/caddy.js#extractGeneratedCaddyfileOptions` could recover generator options from the live file,
and doing so would need no certificate paths. It is the wrong source: the shapes that matter here are
exactly the ones a hand-edit can *remove*, so a baseline recovered from the live file would agree with
whatever that file says and report a deleted gate as correct. `certPath`/`keyPath` participate in no
measured property — they only place a `tls` line — so those alone come from the live file when it is a
shape the extractor reads, and from the staged certificate directory otherwise.

### Credentials never reach a report

`caddy adapt` embeds the bcrypt hash verbatim in its output — four times in the live config — and
`caddy adapt`'s parse errors quote the offending line, which can be `basic_auth <user> <hash>`. Raw
adapt JSON is never logged, every failure reason and every finding passes `caddy.redactHashes`, and
the baseline is adapted through a `0600` file inside a `0700` directory removed in a `finally`,
rather than a predictable path under the system temp root (#821, #870).

## Surface

Measured **once, at boot**, in caddy ingress mode only (direct mode is not behind a Caddyfile
TangleClaw owns), and carried on `GET /api/server-info` as `caddyDriftNotice` —
`serverInfo.setCaddyDriftNotice`, the same shape as `bindNotice` and `ttydNotice`. Deferred past
`listen` with `setImmediate`: it spawns `caddy adapt` twice, and delaying the socket on a subprocess
pair to answer a question nobody is waiting on is the wrong trade. Re-running it per request would
spawn two processes on the route the dashboard polls continuously.

The dashboard renders a **banner** (`public/landing.js#renderCaddyDriftBanner`), not a dash-bar chip.
The chip style truncates at `42ch` and puts the remainder in a `title` attribute; the operator reads
this on a phone, where there is no hover, and the findings *are* the deliverable — a summary they
cannot expand tells them something is wrong and refuses to say what. Findings quote the live
Caddyfile, which is operator-authored text arriving at `innerHTML`, so every one is escaped.

Amber, like the base banner: a hand-edit is usually deliberate, and the stale-server banner stays
the one that reads as urgent when both surface together. State-driven, no dismiss control and no
timer (#98/#268) — the measurement is taken at boot, so it clears when the operator fixes the file
and restarts.

A check that could **not** run still renders, with `severity: 'unknown'`. On an install where a
Caddyfile is expected, "TangleClaw did not look" and "TangleClaw looked and found nothing" are
different facts; showing nothing for both is the collapse the `not-measured` verdict exists to
prevent. A fault in the check itself is caught, logged, and surfaced the same way rather than left
to imply a clean file.

## What this does not replace

`scanAccessLog` and `extractTailnetHost` walk the Caddyfile for **adoption** — reconstructing
`config.caddyAccessLogPath` and `config.caddyTailnetHost` so a future cutover *re-emits* the
operator's hand-edits instead of dropping them. That is a different question from the one this check
asks, and the decisive difference is degradation: this check may honestly answer *not measured* when
`caddy` is absent, and adoption may not. An adoption that silently declined to read the log path would
let the next cutover end the operator's audit trail — which is #846's own outcome. Adoption needs a
caddy-free read path, and those two walkers are it.

## Testing

`test/caddy-drift.test.js`, in two layers.

The **property layer** runs everywhere, against committed `caddy adapt` JSON in `test/fixtures/`
regenerated by `node scripts/regen-caddy-adapt-fixtures.js`. CI has no `caddy` binary, so the logic
that decides what counts as drift would otherwise be untested there; a hand-written imitation of
adapt's JSON would agree with whatever the code already does and prove nothing.

The **integration layer** shells out to `caddy` and skips honestly when it is absent. It re-derives
every fixture and compares, so a Caddy release that changes the JSON shape fails on a developer
machine rather than leaving the committed snapshot describing a Caddy nobody runs.

The fixtures are generated from the real generator (`caddy.buildCaddyfileContent`) and carry a
throwaway bcrypt hash. No live credential is ever written into them.
