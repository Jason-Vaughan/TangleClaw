---
title: "Train B.2 Chunk 3: a fresh install with a hand-seeded config stays on loopback"
status: COMPLETE — built and reviewed; archive with the PR that closes #1484. The post-merge live check is run and reported by the merging session
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-22 (message d95fcac1)
issues: [1484]
governed_by:
  - docs/adr/0009-secure-by-default.md   # grace state (2026-07-28 amendment); "an install that never had remote reach narrows immediately"
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION (not engaged: server-side bind policy only)
scope: train-b2-chunk3
branch: fix/b2-chunk3-fresh-install-bind
partition: serial. One decision function, its three callers and one store query
critic_mode: chunk
---

# Train B.2 Chunk 3: a fresh install with a hand-seeded config stays on loopback

Train B.2 (fail-closed security investigation and patch) is split into chunks of at most four
issues. Chunks 1 and 2 shipped as PR #1754 and PR #1769. This is Chunk 3, the last one: #1484.

## Confidence check

1. **Problem.** Someone writes `~/.tangleclaw/config.json` by hand before the first boot and leaves
   out `bindAllInterfaces`. Boot reads the missing key as "a legacy install that was bound wide",
   records the grace state (`null`), and listens on every interface (`*:3101`) before any login
   exists. That is an unauthenticated shell on the network.
2. **Success.** That install boots on `127.0.0.1:3101`, records `bindAllInterfaces: false`, and
   shows no grace/exposure notice. A real legacy install (one with evidence it was used) still gets
   grace exactly as before.
3. **Out of scope.** The grace state itself, the notice text, caddy mode, the ttyd listener, the
   wizard's own exposure controls, and `store.config.load()`'s treatment of a missing
   `setupComplete` (it stays `true`; ADR 0009's amendment depends on it).

## What the investigation found (read at `c2adf95d9`)

- `server.js` boot calls `bindPolicy.migrateLegacyBind(config, isKeyPersisted('bindAllInterfaces'))`.
  With the key absent in direct mode it writes `null`, and `describeBindState` makes `null` wide on
  purpose (`reason: 'grace'`).
- A normal first boot never reaches that: `store.init()` writes `DEFAULT_CONFIG`, which persists
  `bindAllInterfaces: false`. Only a config file that exists before first boot and lacks the key does.
- The migration runs at **three** sites, and all three must decide the same way: boot (persists),
  `GET /api/config` via `_withBindState` (in memory, so the settings UI describes the socket), and
  `PATCH /api/config` (before it saves, so a failed boot persist cannot be overwritten with `false`).
- **The issue's proposed signal, "setupComplete missing", cannot be used.** `store.config.load()`
  deliberately reads a file with no `setupComplete` as `true`, because legacy installs predate that
  field. Keying on "missing" would narrow exactly the installs ADR 0009's amendment protects.
- On a fresh store at boot, `projects`, `sessions` and `users` are all empty (probed with
  `store._setBasePath` + `store.init()` in a scratch directory). Boot writes port leases for its own
  ports before the migration runs, so leases are **not** usable as evidence of use.

### Chunk 03: A fresh install with a hand-seeded config stays on loopback

## Design

`migrateLegacyBind(config, keyPersisted, priorUse)` grants grace only on evidence the install was
used. When the key is absent in direct mode:

- **`config.setupComplete === false`** → record `false` (loopback), reason `fresh-install`. After
  `load()`, `false` can only come from a file that persists it (or no file at all), so this is a
  fresh install that has never finished setup. There is no operator relying on a wide bind, and the
  wizard is what authorizes wider exposure.
- **`priorUse === false`** → record `false`, reason `fresh-install`. No project, session or user
  row exists and no project was ever deleted, so there is no dashboard in use to strand. ADR 0009 already says an install
  with no prior remote reach narrows immediately.
- **Otherwise** → record `null` (grace), reason `legacy-direct-install`, unchanged. That includes
  `priorUse` omitted: the evidence is optional, and a missing answer keeps today's behavior rather
  than stranding someone. All three `server.js` callers pass it, which a wiring test asserts.

`store.hasPriorUse()` answers the evidence question with one query: does any `projects` (archived
included), `sessions` or `users` row exist, or a `project.deleted` activity row. It fails toward "used" (`true`) if the query throws,
because the cost of a wrong "unused" is stranding a remote operator.

Boot logs the fresh-install case as its own line ("recorded as a fresh install; listening on
loopback") instead of the legacy-grace line.

**The evidence is fixed at boot.** `server.js#_installPriorUse` asks the store once, at boot before
the server listens, and `GET`/`PATCH /api/config` reuse that answer. Asking live was wrong: creating a
project or a login changes the store's answer, so on a fresh install whose boot save of `false`
failed, `GET` would report grace and `PATCH` would persist it, and the next restart would bind wide
with nobody choosing it. The old design had no such risk, because its inputs were all fixed after boot.

**Accepted edge.** The fixed answer lasts one run. If the fresh `false` never reaches disk and the
install is then used, the next boot re-reads the evidence and grants grace. That needs `config.json`
unwritable for a whole run (every settings save fails too). Closing it would need the fresh decision
recorded in a second store. Recorded in ADR 0009's #1484 note.

**Deleted projects count as use.** Deleting a project deletes its sessions, so an install whose
operator removed every project would have looked unused and been narrowed on upgrade. The
`project.deleted` activity row is written only by that delete, never at boot, and the activity log
keeps the newest rows of each type, so it remains as evidence.

## Tests (written with the code)

`test/bind-policy.test.js`:
- A hand-seeded direct config with no key and `setupComplete: false` records `false`, and
  `resolveBind` returns loopback with `grace: false`.
- No key and `priorUse: false` records `false`, even with `setupComplete: true` (a hand-seeded file
  that omits `setupComplete`, which `load()` reads as `true`).
- No key and `priorUse: true` still records `null` (the legacy grace state is not narrowed).
- `priorUse` omitted keeps the legacy behavior (existing tests stay as they are).
- An already-recorded key and caddy mode are unchanged by either signal.
- `describeNarrowing` issues no notice for the fresh-install result.

`test/api-config.test.js`:
- The legacy `bindState` case now builds a legacy install (a project, no `setupComplete`); its
  assertions are unchanged. Its old fixture persisted `setupComplete: false` on an empty store, which
  is the fresh install this chunk closes.
- A keyless config with `setupComplete: false` reports closed.
- Boot answered "fresh" and its save failed; a project created afterwards does not flip `GET` to
  grace, and an unrelated `PATCH` persists `false`.

`test/bind-policy-wiring.test.js`:
- All three `migrateLegacyBind(` call sites in `server.js` pass `_installPriorUse()`, boot's fixed answer.
- `store.hasPriorUse()`: false on a fresh store; true after a project is created; true with only an
  archived project; true with only a user.
- A deleted project still counts as use.
- An end-to-end boot-shaped check: a hand-seeded config file (no key, no `setupComplete`) plus an
  empty store yields a persisted `false` and a loopback bind.

## Docs

- `docs/adr/0009-secure-by-default.md`: a dated note under the grace rule saying grace needs
  evidence of use, and why "setupComplete missing" was rejected as the signal.
- `.prawduct/artifacts/security-model.md` HTTP server row: grace applies only to a legacy install
  with evidence of use.
- `FEATURES.md` bind-policy test line, and `CHANGELOG.md` under `### Security`.

## Done when

- The tests above pass, and the full suite is green.
- `/prawduct:critic` shows no unresolved blocking findings.
- The PR closes #1484 and merges. The live checkout is pulled and restarted, `startupSha` matches,
  and the live server still listens exactly as before (this install has the key recorded).

## Status

- [x] Chunk 03 (#1484): fresh installs stay on loopback
