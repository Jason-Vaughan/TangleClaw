---
artifact: build-plan
version: 2
scope: train-15-chunk-01
depends_on:
  - artifact: architecture
  - artifact: observability-strategy
  - artifact: project-preferences
  - artifact: nonfunctional-requirements
  - artifact: data-model
governed_by:
  - artifact: architecture
    dispositions:
      - "A dependency's failure degrades TangleClaw, never crashes it — its Retroactivity list names `Bridge → listener backoff` as an implemented isolation point → ENGAGED, and this chunk narrows that claim. The backoff is real but it is not a deadline: Car 3 reproduces a Bridge that accepts the WebSocket upgrade and never answers `register`, and the listener parks in `connecting` indefinitely with no error, no reconnect and no bound. `Bridge → listener backoff` is therefore true only for a Bridge that refuses or drops the connection, and false for one that accepts and stalls. Car 3 makes the named isolation point hold for both, so the Retroactivity line becomes accurate rather than aspirational."
      - "A read that could not be established reports null and names itself, never a plausible default → ENGAGED, and it is the whole of Car 2's second half. `lastError` is a free-text string assembled at four sites, so every consumer that wants to know WHY a listener is not listening must pattern-match English. #1130 records the cost directly: a published `lastError` → bridge-condition mapping drove a port-ownership hypothesis that was entirely wrong. Car 2 adds a classified code beside the prose in the same `SCAN_TIMEOUT`/`SCAN_CACHED` vocabulary the projects scan already speaks, so the two reads describe their failures the same way."
      - "Bounded exception (#1180, chime idle detection) → inapplicable; no car touches idle detection."
  - artifact: observability-strategy
    dispositions:
      - "Logs carry names, never payloads → conforms. Every line this chunk adds carries a workspace id, a bridge URL, a state name, a classification code or a duration. The one new value that could embed operator-controlled text is the resolved Bridge URL from `MEDUSA_BRIDGE_WS_URL` — a host and port the operator set, in the same class as the HTTP side's already-logged `bridgeUrl`, and not a credential."
      - "Every logged error says what failed, why, and what the operator can do → ENGAGED and it is the reason Car 2 exists at all. `Connection closed (code 1006)` names what failed and neither why nor what to do, and on the reporting install it named the wrong `why`. Each classification code this chunk introduces carries an operator-facing hint, and the Bridge-absent case carries the one action that resolves it."
  - artifact: project-preferences
    dispositions:
      - "No npm dependencies, for runtime or for tooling → BINDING on the test design and it forecloses the obvious approach. There is no `ws` package to stand a fake Bridge on, so Car 3's integration probe speaks the RFC 6455 handshake with `node:http` + `node:crypto` (~30 lines, already proven in this session's scratchpad probes) or stays on the existing `wsFactory` seam. No package is added."
      - "CommonJS, 'use strict', no build step → conforms; every file touched is already CommonJS."
      - "Tests are `node:test` + `node:assert/strict`, one file per module, and every API endpoint has them → conforms. Car 2 touches a route, so its route test covers the refusal, not only the happy path."
  - artifact: nonfunctional-requirements
    dispositions:
      - "If it doesn't work on mobile, it doesn't ship → APPLICABLE to Car 2 and deliberately bounded. Car 2 adds a classification code and hint to an existing status payload; whether any surface renders it is a separate decision recorded in the car. If a car ships a visible string, it ships in the existing Medusa control markup at existing sizes — no new interactive element, so the ≥44px floor is not newly engaged."
      - "Accessibility floors are requirements, not aspirations → APPLICABLE with the same bound. Any state Car 2 surfaces is communicated by text, never by color alone."
  - artifact: data-model
    dispositions:
      - "Governance state is derived from disk, never stored → inapplicable; no car stores a governance label."
      - "A project's configuration travels with the project → inapplicable. The Bridge URL is an INSTALL-level fact about a host-local service, not per-project configuration, which is why Car 1 resolves it from the environment beside the HTTP side rather than from `<project>/.tangleclaw/project.json`."
      - "The Project Master has no sessions or projects footprint → APPLICABLE and it is a trap Car 2 must not fall into. `lib/master.js:1971` starts a Medusa listener for the master through the same `startSession`, and the master has no `sessions` row. A preflight or warning keyed on iterating the sessions table would silently skip the singleton — which is exactly the listener the reporting install saw fail first."
last_validated: 2026-09-08
---

## Requirements Confidence

**Level:** High for Cars 1 and 3, Medium for Car 2.

**Why:** All three cars are filed issues with a stated mechanism, and each mechanism was
re-verified against this repo's code before this plan was written rather than taken from the
issue text or from the Coordinator's strategy line
([[feedback_issue_diagnosis_is_a_hypothesis]]). Two verifications changed the plan's shape, and
one of them **disproved the assigned strategy**:

- **#1100 — verified exactly as filed.** `lib/medusa.js:62` resolves the HTTP base from
  `MEDUSA_BRIDGE_HTTP_URL`; `lib/medusa-listener.js:42` hardcodes `ws://localhost:3010` and
  consults no environment. `bridgeUrl` reaches the listener only as a `startSession` option, and a
  grep of every production call site (`lib/master.js:1971`, `lib/projects.js:2446`,
  `lib/sessions.js:3621`, `lib/sessions.js:3682`, `server.js:4540`) shows **not one passes it** —
  so the default is the only reachable value in production and the option is a test seam, precisely
  as the issue states.

- **#1131 — the assigned strategy is WRONG, and a different, reproducible defect is in its
  place.** The Coordinator's strategy and the issue's own investigation note both predict a
  poisoned socket/client object that the reconnect path reuses. It does not exist:
  `_connect()` closes and nulls the prior socket, builds a fresh one through `wsFactory` on every
  attempt, and gates every handler on a socket-identity check.

  A live-loopback probe settles it. With a real Node `WebSocket` against a port where **nothing
  was listening**, the listener failed five times with backoff and then **registered within 5ms of
  a healthy Bridge appearing** — `state: listening`, `lastError: null`. Absent-then-present
  recovery works today, so a fix aimed at rebuilding poisoned state would have shipped green
  tests against a defect that is not there.

  A second probe, differing in exactly one variable, reproduces the reported symptom. When the
  fake Bridge **accepts the WebSocket upgrade and never answers `register`**, the listener sends
  its `register` frame and waits **forever**: it sits in `connecting` past a 20s deadline with no
  error, no close and no reconnect. `_onOpen` starts no timer and nothing else bounds the
  handshake, so the reconnect loop — the mechanism that is supposed to survive a bridge
  outage — is never reached, because from the listener's point of view nothing has failed.

  That is the honest root cause available from the code: **the listener has no deadline on the
  register handshake.** It fits the field report better than the filed hypothesis, which had to
  explain why a retry that demonstrably runs never recovers; a listener parked in `connecting` is
  not retrying at all. It is also the more general defect — a half-started Medusa, a Bridge
  mid-boot, a non-Medusa process owning the port, or an intermediary that upgrades and stalls all
  produce it. **Stated confidence, precisely:** this is a reproduced defect on the reported path,
  not a proven identity with the reporter's incident. Their `lastError` read
  `Connection closed (code 1006)`, which means their socket also closed; this fix bounds the wait
  in both directions, but nobody should record #1131 as explained until an install shows it.

- **#1130 — Medium, and the reason is scope, not mechanism.** The diagnostics half is verified
  and sharp: with nothing listening, this session's probe produced
  `Socket error: Received network error or non-101 status code` in state `error`, which is the
  **first** row of the mapping the issue publishes — while the reporter's install, also with
  nothing listening, reported the **second**. Two installs, one bridge condition, two different
  `lastError` strings: the mapping is not a function of the bridge condition, exactly as the issue
  argues. What is NOT settled is the preflight's blast radius — which callers gate on it, what an
  enable toggle does when the Bridge is absent, and whether the auto-start path should refuse or
  proceed-and-warn. Those are named as open questions in the car rather than assumed, and the car
  is scoped to answer them before it builds.

**What is out of scope for this chunk:** #918 (Chunk 02), and #1112 / #934 / #1025, ejected from
this train by the Coordinator. No car changes the loopback trust model, adds a dependency, or
touches the Bridge's own repo.

## Build Order — a deliberate departure from the Coordinator's listed order

The Coordinator lists #1100, #1130, #1131. This plan builds **#1100 → #1131 → #1130**.

Only the order changes; no car's scope moves. #1130's diagnostics half adds a classification code
to the listener's failure paths, and #1131 adds a new failure path (`REGISTER_TIMEOUT`) that must
carry one. Building #1130 first means editing the same four sites twice and reviewing a
classification set that is knowingly incomplete. #1100 stays first for the reason the Coordinator
gave: it is the cheapest and it de-risks the others by making the URL under test overridable.

## Status

- [ ] Car 1: The listener resolves its Bridge URL the way the HTTP side does (#1100)
- [ ] Car 2: A stalled handshake is a failure, not a wait (#1131)
- [ ] Car 3: A missing Bridge names itself (#1130)

Each car is one branch and one PR, per the train methodology's 1 car = 1 issue = 1 PR. Reviews are
`chunk` per car, with a `cumulative` before the last merge.

**Critic mode:** chunk

---

### Car 1: The listener resolves its Bridge URL the way the HTTP side does (#1100)

**Problem.** An install whose Medusa runs on non-default ports can redirect send/roster
(`MEDUSA_BRIDGE_HTTP_URL`) and cannot redirect the listener. Half a working Switchboard, with no
supported way to finish the job short of editing source.

**Approach.** Resolution moves to `lib/medusa.js`, beside the HTTP side it must agree with, and
reaches the listener through the `bridgeUrl` option that already exists. The listener keeps its
default so it stays independently constructible.

Precedence, most specific first:
1. `MEDUSA_BRIDGE_WS_URL` when set — the dedicated override for an install whose WS port is not
   HTTP + 1.
2. Otherwise **derived from the live HTTP base**: same host, port + 1, `http`→`ws` / `https`→`wss`.
   Derived from the module's current `bridgeHttpUrl` rather than from `process.env` directly, so
   the `_setBridgeHttpUrl` seam moves both halves together and the two gates cannot drift.
3. Otherwise `ws://localhost:3010`.

**The trust model is a constraint on this car, not a casualty of it.** `lib/medusa-listener.js:24`
records the WS path as unauthenticated at the workspace layer, so the URL must stay bound to
loopback. A resolved host that is not loopback (`localhost`, `127.0.0.0/8`, `::1`) is **refused
with a named log line and the default is used** — the override moves a port, never a host. This
does not weaken the HTTP side or add validation to it; the asymmetry is deliberate and recorded,
because the WS side is the unauthenticated one.

**Done when**
- `MEDUSA_BRIDGE_WS_URL` set → listener constructed by `startSession` resolves to it.
- Only `MEDUSA_BRIDGE_HTTP_URL` set → listener resolves to host, port + 1, ws scheme.
- Neither set → `ws://localhost:3010`.
- A non-loopback resolved host → default is used and one log line names the rejected value.
- An explicit `bridgeUrl` passed to `startSession` still wins (the test seam is preserved).
- `docs/configuration-reference.md` documents both variables and the derivation.
- Suite green.

---

### Car 2: A stalled handshake is a failure, not a wait (#1131)

**Problem — reproduced, and not the one filed.** A Bridge that accepts the WebSocket upgrade and
never answers `register` parks the listener in `connecting` indefinitely. No error, no close, no
reconnect: the backoff loop that exists to survive a bridge outage is never entered, because
nothing reports a failure. See Requirements Confidence for the probe and for what it disproved.

**Approach.** One deadline spanning the whole handshake — armed in `_connect()`, cleared in
`_onRegistered()` — so it bounds both halves of the wait: a socket that never opens (a filtered
port swallowing the SYN, which today also hangs forever) and a socket that opens and is never
answered. On expiry: record the failure with its classification, force-close the socket, set
`error`, and enter the existing reconnect path, which the probes show recovers correctly once it
is reached.

Default deadline **10s**, `handshakeTimeoutMs` constructor option. Sized against the two facts to
hand rather than picked: `DEFAULT_HEARTBEAT_MS` is 20s, so the deadline must be well inside one
heartbeat to be the thing that fires; and the local Bridge answers `register` in single-digit
milliseconds on this host, so 10s is three orders of magnitude of headroom for a loopback service
and still bounded far below the 30s backoff ceiling.

**Done when**
- A fake Bridge that accepts the upgrade and never answers `register` drives the listener to
  `error` within the deadline and then to `listening` once it starts answering — the test that
  reds without the fix.
- A socket that never opens is bounded by the same deadline.
- The deadline never fires on a healthy register, and is cleared on `stop()` along with the other
  timers.
- **A regression test pins the recovery that already works** — absent Bridge, backoff, healthy
  Bridge appears, listener registers without a restart — so #1131's reported scenario cannot
  silently regress even though its filed mechanism was not the defect.
- Suite green.

---

### Car 3: A missing Bridge names itself (#1130)

**Problem.** With no Bridge on the host at all, TangleClaw accepted the enable toggle, showed it
green, minted a workspace id, started three listeners and ran an endless generic reconnect loop.
An absent external prerequisite was indistinguishable from a TangleClaw listener defect. Separately
and independently, `lastError` cannot distinguish "no bridge" from "bad bridge" — this session's
probe and the reporter's install produced different strings for the same bridge condition.

**Approach — two halves, and the second is the one that generalizes.**

1. **Classification beside the prose.** A `lastErrorCode` on the listener's status, carried through
   `getStatus()`, in the vocabulary the projects scan already speaks. The prose string stays for
   humans; the code is what a surface or a future check may key on. Codes cover the paths that
   exist after Car 2: connect refused, upgrade rejected, closed abnormally, register timed out,
   malformed frame.

2. **Preflight and a standing warning.** A `checkBridgeHealth()` in `lib/medusa.js` that probes the
   HTTP health endpoint *and* the WS port, returning a classified verdict with an operator-facing
   hint; the enable path consults it and reports *Bridge unavailable* with installation guidance
   instead of a green toggle, and the condition "`medusaEnabled` is true and no Bridge is healthy"
   is reported rather than left to a log nobody tails.

**Open questions this car answers before it builds — named, not assumed.** Whether the enable
toggle **refuses** or **warns-and-proceeds** when the Bridge is absent (refusing is honest but
strands an operator who is about to start Medusa; warning is recoverable but is the current
behavior plus a sentence); which callers gate on the preflight, given that `startSession` has five
production call sites; and where the standing warning surfaces. Each is a decision to record, not
a detail to infer — and the master's listener (`lib/master.js:1971`, no `sessions` row) must be
covered by whatever shape the warning takes.

**Done when**
- Every listener failure path sets a code, and the codes are pinned by tests that name the
  condition, not the string.
- `checkBridgeHealth()` distinguishes absent / HTTP-only / unhealthy / healthy against fakes.
- The enable path's chosen behavior is implemented, tested, and recorded as a decision with its
  alternative.
- The standing warning covers the Project Master, not only sessions-table rows.
- `.prawduct/artifacts/api-notes-medusa.md` reflects the classified status shape.
- Suite green.
