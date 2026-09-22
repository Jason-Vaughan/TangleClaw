---
title: "Train B.2 Chunk 2: PortHub stops granting a port it can see is taken, and stops deleting leases it cannot classify"
status: ACTIVE. Planned 2026-09-22, not yet built
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-22 (message f260c147)
issues: [814, 853, 1381]
governed_by:
  - data/porthub-guide.md       # the injected guide every managed project reads
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION
  - v5 bridge manifest B2 note: probe with fixtures only, never the live registry destructively
scope: train-b2-chunk2
branch: fix/b2-chunk2-porthub
partition: serial. The three issues share lib/porthub.js, the port_leases table and the /api/ports route block
critic_mode: chunk
---

# Train B.2 Chunk 2: PortHub stops granting a port it can see is taken, and stops deleting leases it cannot classify

Train B.2 (fail-closed security investigation and patch) is split into chunks of at most four
issues. Chunk 1 (#1739, #1746, #1261) shipped as PR #1754. This is Chunk 2. Chunk 3 is #1484.

## What the investigation found (read at `b512cafce`)

1. **#814. The lease route skips the machine check, and the check only warns anyway.**
   `POST /api/ports/lease` (`server.js`, `/api/ports` block) calls `store.portLeases.lease` directly.
   `porthub.registerPort` does consult `portScanner.isPortInUseBySystem`, but only to log a warning
   and register anyway. It also reads the scanner's **cached** last scan, which is empty before the
   first scan and permanently empty when `portScannerEnabled` is false. So routing the route through
   `registerPort` alone would change nothing. Contributing factors, both confirmed:
   - `bootstrap()` enrols `ttydPort` and `serverPort` only. Caddy's ports are not enrolled. On this
     install they are registered by hand today (`localhost:8080`/`8443`, service `caddy-*-ingress`,
     reach `loopback`), which is why the incident cannot recur *here*, but a fresh caddy install has
     no such rows.
   - `GET /api/ports` returns `systemPortCount`, a bare number. A caller cannot see which ports are held.
2. **#853. Leases are keyed on `(host, port)`; the guide never says so.** `data/porthub-guide.md`
   shows both `lease` and `release` without `host`, and every route defaults `host` to `localhost`.
   The live registry holds the same port on two hosts under different owners (`habitat:3203`
   RentalClaw, `localhost:3203` Medusa). A host-less release from the RentalClaw side deletes
   Medusa's row, unverified when `project` is omitted and answered `{ok:true}`.
3. **#1381. Two paths delete a correct lease for a non-project owner. The issue names one.**
   - `POST /api/projects/import` releases every lease of a name whose directory is missing (the
     issue's path: the dashboard's Import button on a `brew services` Postgres lease).
   - **Not in the issue:** `porthub._cleanupOrphanLeases()` runs on **every boot** and releases every
     lease whose project is neither registered nor a directory under `projectsDir`. A lease for
     "Homebrew" is deleted at the next restart whether or not anyone clicks anything. A fix to the
     import route alone would leave the boot sweep deleting the same row.
   - The banner (`public/landing.js#checkPortImports`) compares `lease.project` against project
     names with no notion of a non-project owner. Its only safe control is the localStorage
     ignore list (#1383), which is per-browser and hides rather than records.

**Callers inventory.** `registerPort` in-process callers: `bootstrap` (ttyd/server), `lib/tunnel.js`
(after the tunnel is live), and `server.js`'s OpenClaw connection create/update (ports TangleClaw's
own tunnel will bind). `POST /api/ports/lease` is used by every managed agent per the guide.
`_cleanupOrphanLeases` is called only from `bootstrap`. `/api/projects/import` is called by the banner.

## Design

### #814: the lease path asks the machine, and refuses an unleased listener

- **`POST /api/ports/lease` goes through `porthub.registerPort`.** `registerPort` gains the route's
  pass-through fields (`autoRenew`) and returns the stored lease, so the route answers exactly the
  row it answered before. The HTTP default `permanent: false` is preserved by the route passing it
  explicitly; `registerPort`'s own default is unchanged.
- **A fresh probe, not the cache.** `portScanner.probePort(port)` runs `lsof -nP -iTCP:<port>
  -sTCP:LISTEN` for that one port. When lsof cannot run, it falls back to the cached scan and says so.
- **Refusal rule.** On `localhost`, when the port has a listener and **no live lease for this project**
  exists on it, the lease is refused: `409 PORT_IN_USE` with `listener: {port, pid, command}`. A
  renewal (this project already holds the lease) never probes, which keeps the documented
  idempotent re-register-on-boot path working. Another project's live lease is still the existing
  `409 PORT_CONFLICT`, checked first.
- **`adoptListener: true`** says "the listener on this port is mine" (registered after binding). It
  is a separate flag from `force` on purpose: `force` takes over another project's lease, and an
  agent that set `force` to register its own server would silently steal a leased port too.
- **Every in-process caller passes `adoptListener: true`** with the reason at the call site: each
  registers a port TangleClaw itself binds (ttyd, the server, Caddy, its own SSH tunnels). Their
  behaviour is unchanged.
- **Where the check cannot run, the answer says so.** The 201 body carries `listenerCheck`:
  `clear`, `adopted`, `renewal`, `not-local` (a non-localhost host; this machine cannot see it) or
  `unavailable` (no lsof, empty cache). The grant is not refused for `unavailable`, and a warning
  is logged.
- **Bootstrap enrols Caddy's listeners** (`caddyHttpPort`, `caddyHttpsPort`) as permanent leases
  under TangleClaw's own name when `ingressMode === 'caddy'`, with `force` for the reason the
  ttyd/server rows already carry and `reach: 'tailnet'` (Caddy's global `https_port` binds every
  interface, and remote operator access is its purpose).
- **`GET /api/ports` lists unleased listeners**: `systemPorts: [{port, pid, command}]` beside the
  existing `systemPortCount`, from the cached scan.

### #853: say that host is part of the key, and refuse the ambiguous release

- The guide shows `host` in the lease, release and heartbeat examples, says it defaults to
  `localhost`, and adds a Conflict Resolution line: leases are keyed on `(host, port)`, and the same
  port number can belong to different projects on different hosts.
- **`POST /api/ports/release` with no `host`** is refused `400 HOST_REQUIRED` when a lease for that
  port exists on any host other than `localhost`. The message names the hosts. An explicit
  `host: "localhost"` still releases localhost's row. Heartbeat is not changed: renewing the wrong
  row deletes nothing.

### #1381: a lease can say its owner is not a TangleClaw project

- **Schema v43→v44:** `port_leases.owner_kind TEXT NOT NULL DEFAULT 'project' CHECK (owner_kind IN
  ('project','external'))`. Existing rows become `project`, which is what every consumer assumes today.
- **Omitting `ownerKind` on a renewal keeps the stored value.** This deliberately differs from
  `reach` (which resets to loopback when omitted): an agent that forgets the field must not turn an
  external lease back into a project lease, because that re-arms the banner and the boot sweep.
- **The boot orphan sweep never touches an `external` lease.**
- **The import route no longer releases anything.** A missing directory is a warning that names the
  leases it left in place and says how to mark the owner as not a project. The boot sweep remains
  the one path that removes genuine orphans of deleted projects.
- **`POST /api/ports/owner-kind` `{project, host?, ownerKind}`** marks every lease of that owner
  name (optionally on one host). This is the dashboard's control; agents can also set `ownerKind` on
  `lease`.
- **The banner** skips `external` leases and gains a **Not a project** button that calls the route
  and re-renders. Import and Ignore stay. The widget, collector, POST and server are traced end to
  end in the tests (project rule: trace every new option through each hop).

## Decisions (each one vetoable)

- **[DECISION] Refuse an unleased listener rather than warn**, with `adoptListener` as the escape.
  The issue's own proposal ("reject when bound by a different project") cannot be computed for an
  unleased listener, because nothing says which project it belongs to. Refusing by default and
  letting the owner claim it is the only shape that closes the WheresMy incident.
- **[DECISION] `adoptListener`, not `force`**, for the reason in the design above.
- **[DECISION] Fail open with `listenerCheck: 'unavailable'` when lsof cannot run.** Failing closed
  would make every lease on an install without lsof (some Linux images) a 409 no caller can clear.
- **[DECISION] Value name `external`, not `infrastructure`.** "Infrastructure" already names
  TangleClaw's own ttyd/server/Caddy leases, which are project leases under TangleClaw's name.
- **[DECISION] The import route stops releasing, even for a genuine orphan.** Import is a
  registration action; deleting registry rows from it was the defect. The boot sweep keeps that job.
- **[DECISION] Depart from the fleet-surface "additive only" working rule** (`api-contract.md`,
  descriptive, not ratified). `PORT_IN_USE` and `HOST_REQUIRED` can reach a session primed with the
  older guide. Both refusals name their fix, so such a session recovers without a relaunch. Keeping
  the old form working would keep the defect. The departure is recorded in the contract.
- **[DECISION] `listenerCheck` also reports `takeover` and `refused`**, beyond the five values
  planned: a forced takeover defers to the lease it displaces (the listener is that lease's), and
  the refusal carries its own value.
- **[DECISION] Import stops auto-ignoring names it could not import.** The auto-ignore hid the
  warning that the owner may not be a project, and hid the row whose **Not a project** button
  records that.
- **[DECISION] `owner-kind` is not operator-gated**, matching the other `/api/ports` routes (behind
  the M2M token when it is on). Marking a lease external only hides it from the banner and the sweep.

## Out of scope

- The heartbeat route's host default (harmless: a wrong-row heartbeat deletes nothing).
- Authenticating `/api/ports` callers beyond the existing M2M token. The guide already states that
  nothing binds a caller to the project name it sends.
- Removing the per-browser ignore list; it stays as a display preference.

## Requirements Confidence: **High** for #814 and #853, **Medium** for #1381

#1381 is `stage:design`. The field, its name and the renewal semantics are this plan's choice.

## Chunks

### Chunk 2: PortHub guard, host key, non-project owners (#814, #853, #1381)

Done when:
- A lease on a localhost port with an unleased listener answers 409 `PORT_IN_USE` naming the
  listener, and nothing is stored. The same request with `adoptListener: true` is granted
  (`listenerCheck: 'adopted'`). A renewal by the holding project is granted without probing. Another
  project's lease still answers `PORT_CONFLICT`. A non-localhost host answers `not-local`, and a
  failed probe answers `unavailable`. Tests stub the probe, and no test binds a real port it does not own.
- In-process callers still register their own bound ports (tests for bootstrap and the tunnel path).
- Bootstrap enrols Caddy's two ports in caddy mode and not in direct mode.
- `GET /api/ports` includes `systemPorts` with `port`, `pid`, `command`.
- A host-less release is refused `HOST_REQUIRED` when another host holds that port, and deletes
  nothing. An explicit localhost release still works.
- Migration v43→v44 adds `owner_kind` with its CHECK (read back from the DDL, like v35), and
  existing rows read `project`. A renewal without `ownerKind` keeps `external`.
- The boot sweep leaves an `external` lease for a missing project in place. Import with a missing
  directory releases nothing. The banner hides `external` leases, and **Not a project** marks them
  through the route (widget → collector → POST → server test).
- `data/porthub-guide.md`, `.prawduct/artifacts/api-contract.md` and `data-model.md` describe the
  behaviour. The CHANGELOG has entries in the right subsections.
- `/prawduct:critic` has run clean of blocking findings.

## Status

- [ ] Chunk 2: PortHub guard, host key, non-project owners (#814, #853, #1381)
