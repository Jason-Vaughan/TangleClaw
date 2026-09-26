# Configuration Reference

TangleClaw uses a layered configuration system: global config for system-wide settings, per-project config for project-specific settings, and engine profiles for behavior definitions.

## File Locations

| File | Purpose |
|------|---------|
| `~/.tangleclaw/config.json` | Global configuration |
| `~/.tangleclaw/engines/*.json` | Engine profiles |
| `<tangleclaw-repo>/data/global-rules.md` | Global rules (applied to all projects; git-tracked, see below) |
| `~/.tangleclaw/tangleclaw.db` | SQLite database (runtime state) |
| `~/.tangleclaw/drafts/<attempt>.jsonl` | Drafts cleared from a session's prompt before TangleClaw pasted into it, one file per session attempt (`session-<id>`, or `<tmux-name>@<created>` for the Project Master): the last 20, one JSON object per line (`id`, `at`, `engineId`, `complete`, `text`). Private (directory `0700`, file `0600`, never written through a symlink). Deleted 7 days after the attempt ends. The log carries only an opaque `draftRef` (`<attempt>:<id>`) with the row and character counts, never the text (#1507) |
| `<project>/.tangleclaw/project.json` | Per-project configuration |
| `<project>/.tangleclaw/state.json` | Per-checkout wrap state: the last wrap boundary and a declined un-track offer. Untracked and never committed; `project.json` no longer holds `lastWrapSha` (#1510, #1512) |

### Relocating the base directory (`TANGLECLAW_HOME`)

Everything in the table above that begins `~/.tangleclaw/` hangs off one base
directory, derived in one place (`lib/tangleclaw-home.js`). Set `TANGLECLAW_HOME`
to move all of it at once — the database, `config.json`, engine and orchestration
profiles, logs, the PID file, master state, the git template, and the ttyd attach
script:

```bash
TANGLECLAW_HOME=/tmp/tc-rehearsal node server.js
```

The variable names the **base directory itself**, not a home directory: with the
value above the database is at `/tmp/tc-rehearsal/tangleclaw.db`, with no
`.tangleclaw` segment appended. A blank value is ignored rather than treated as
the current directory. Unset, the base directory is `~/.tangleclaw`.

**What it does not move.** The variable is read by the Node process and by
nothing else, so two families stay put:

*The ingress, which is machine-global by construction* — the launchd jobs under
`~/Library/LaunchAgents` (launchd reads a fixed per-user location, and the job
labels are constants), the Caddy site label, and the ingress ports, which default
to 8443/8080.

*State derived outside the Node process* — `deploy/install.sh` hardcodes
`$HOME/.tangleclaw` when it reads `config.json`, creates `logs/`, and installs
the ttyd attach script; the launchd plists hardcode `__HOME__/.tangleclaw` for
their stderr logs and Caddy's data directory. These are **state**, not ingress,
and that is why they are called out separately: applying the variable to an
installed service would put `tangleclaw.log` under the new base and
`server.err.log` under the old one.

**So use it for a scratch process, not for a second install.** Running
`node server.js` or the test suite under an override is what it is for. Running
`deploy/install.sh`, or the ingress cutover, is not: the cutover **refuses** to
run while the variable is set, because it bakes paths into launchd jobs that no
override can relocate, and a rehearsal that repointed the live ttyd job at a
scratch directory would take every terminal down when that directory was
removed. Issue #1283 carries what it would take to make a genuine second install
possible.

Overriding `HOME` instead is not supported and never was: it moves anything
derived from the home directory, TangleClaw's and the operating system's alike,
and an attempt to sandbox that way migrated the live database on 2026-07-20.

### Pointing at a Medusa Bridge on non-default ports

The Medusa Bridge is a host-local service TangleClaw talks to over two
transports, and each has an environment override. They are read by the Node
process only.

| Variable | Default | What it sets |
|---|---|---|
| `MEDUSA_BRIDGE_HTTP_URL` | `http://localhost:3009` | The HTTP base used for send, roster and loops. |
| `MEDUSA_BRIDGE_WS_URL` | derived, see below | The WebSocket URL each session listener registers against. |

**One knob is usually enough.** Medusa serves its WebSocket on its HTTP port + 1
(`medusa-server.js` uses `protocolPort + 1`), so with only `MEDUSA_BRIDGE_HTTP_URL`
set the listener URL is derived from it: same host, port + 1, `http`→`ws` and
`https`→`wss`. Setting the HTTP base to `http://localhost:4009` gives listeners
`ws://localhost:4010` with nothing else to configure. `MEDUSA_BRIDGE_WS_URL` is
for the installs where that relationship does not hold; when set, it wins.

**A resolved WebSocket URL must be loopback.** The WS path is unauthenticated at
the workspace layer — anything that can reach the port can register as any
workspace, spoof a `from`, and drain another workspace's queue — so the override
moves a *port*, not a host. A resolved host that is not `localhost`,
`127.0.0.0/8` or `::1` is refused, the loopback default is used, and the refusal
is logged once per distinct value, naming the value and the variable that carried
it. To reach a Bridge on another machine, tunnel it to loopback.

**The HTTP side is not guarded, and is not safer.** `MEDUSA_BRIDGE_HTTP_URL` will
accept a remote base today. That is a gap, not a reassurance: the Bridge's HTTP
endpoints TangleClaw uses (`POST /messages/direct`, `GET /workspaces`) are
**equally unauthenticated**, and `from` is taken from the request body, so
pointing the HTTP base at a remote host ships spoofable traffic off loopback. The
Bridge's `A2A_SECRET` HMAC gates only its `/a2a/*` mesh layer, which TangleClaw
never calls. The whole integration is trusted-local loopback; only one of the two
gates currently enforces it.

**A remote HTTP base therefore leaves a SPLIT install.** Send, roster and loops
follow the remote base while the listener refuses to derive a remote URL and
falls back to `ws://localhost:3010` — half the Switchboard pointing at each
Bridge. The refusal log line says so in those words rather than leaving it to be
inferred.

**A base with no explicit port is refused rather than derived from.** `+ 1` on a
scheme default would give `http://localhost` → port 81 and `https://localhost` →
port 444: arithmetic on a number the operator never chose, and a port no Medusa
serves. Give the HTTP base an explicit port, or set `MEDUSA_BRIDGE_WS_URL`.

**Every refusal falls back rather than throwing**, so a typo cannot stop the
Switchboard from starting — including a value the WebSocket client itself would
reject (a `#fragment`, a non-`ws` scheme, a port past 65535), which would
otherwise be retried on a reconnect loop forever. The cost is that the default is
a normal-looking value for a read that did not succeed, so the log line is the
operator's only signal that an override was ignored.

### Turning off or tuning the ttyd watcher (macOS)

The ttyd watcher (`lib/ttyd-watcher.js`) restarts the terminal service when its PTY pool fills or
it collects leaked `tmux attach` children. Two environment variables, read when the server starts,
are the rollback levers for it:

| Variable | Values | Effect |
|---|---|---|
| `TANGLECLAW_TTYD_WATCHER` | `off` / `0` / `false` to disable; `on` / `1` / `true` (or unset) to enable | Disabled, the watcher never restarts ttyd and logs `ttyd watcher DISABLED` at warn on every start. The system health panel then shows a healthy reading as **Could not check**, never clear; a full pool or leaked children still show as fired, with a note to restart ttyd by hand. Any other value is logged at warn, and the watcher stays enabled. |
| `TANGLECLAW_TTYD_ORPHAN_THRESHOLD` | An integer from 5 to 200 (default 20) | How many confirmed leaked children trip a restart. The value in force is logged at warn when it is not the default. Anything outside the range, or not an integer, is logged at warn and the default is used. |

For a launchd install, set them in the server's plist (`EnvironmentVariables`) and restart the
server; they are not read from `config.json`.

### The ttyd runtime launchd runs (macOS)

launchd runs a TangleClaw-owned, self-contained ttyd at `~/.tangleclaw/bin/ttyd`, not the Homebrew one.
The Homebrew build leaks a pseudo-terminal each time a terminal tab closes (#1245); the owned runtime
carries the fix. `deploy/install.sh` and `scripts/ingress-cutover.js` both get the path from one
resolver (`lib/ttyd-runtime.js`), never from the PATH.

- **`deploy/install.sh` provisions the runtime.** When the owned runtime is missing, does not verify,
  or is stale, the installer builds it from `deploy/ttyd/inputs.json` into a temporary directory,
  installs the verified result, and only then writes the ttyd plist. A runtime that verifies and is
  current is kept without rebuilding. The build needs the Xcode Command Line Tools and, the first time,
  network access to fetch the pinned sources (they are cached under
  `~/.tangleclaw/cache/ttyd-build`). A failed build installs nothing, stops the install before any plist
  is written, and keeps its build directory for inspection.
- **The ingress cutover never builds.** When the runtime is missing, invalid or stale it stops before
  its first write, with the code `ttyd-runtime-unavailable`. The refusal tells you to run
  `node scripts/ttyd-runtime.js provision` and then select the runtime for your ingress mode:
  `./deploy/install.sh` in direct mode, the cutover itself in caddy mode. `deploy/install.sh`
  rewrites the ttyd plist for direct mode, so on a caddy-mode host it refuses before changing
  anything and names the cutover instead.
- **Stale** means built from a different `deploy/ttyd/inputs.json`: a runtime is current only when its
  manifest records that file's exact SHA-256. Changing a build flag, the CMake pin or the deployment
  target makes the installed runtime stale just as a new source or patch does.

| Variable | Values | Effect |
|---|---|---|
| `TANGLECLAW_TTYD_RUNTIME` | `managed` (default) or `homebrew` | `homebrew` is the explicit rollback: launchd runs `/opt/homebrew/bin/ttyd` (or `/usr/local/bin/ttyd`), and every install and cutover prints a warning that the #1245 fix is not active and the ttyd watcher is again the only mitigation. It is never chosen automatically. Any other value is refused. |

Set `TANGLECLAW_TTYD_RUNTIME` where the plist is written. For `deploy/install.sh`, or a cutover you
run yourself, set it in that shell. For a cutover started from the setup wizard, set it in the
TangleClaw server's plist (`EnvironmentVariables`) and restart the server, because the server passes its
own environment to the cutover. The ttyd row of the system health panel says which binary launchd is
actually running, and notes when it is not the owned runtime.

Putting the owned runtime into service, and taking it out again, are Operator procedures with
their own runbooks: [Roll out the owned ttyd runtime](runbooks/roll-out-the-owned-ttyd.md) and
[Roll back the owned ttyd runtime](runbooks/roll-back-the-owned-ttyd.md).

Build and manage the owned runtime by hand (none of these edit a plist or restart ttyd):

```
node scripts/ttyd-runtime.js provision                  # what install.sh runs: build and install only if needed
node scripts/build-ttyd.js --out <stage-dir>            # build from deploy/ttyd/inputs.json, verified
node scripts/ttyd-runtime.js install --from <stage-dir> # install; keeps the previous one as last known good
node scripts/ttyd-runtime.js rollback                   # restore the last known good
node scripts/ttyd-runtime.js status                     # which ttyd is selected, and whether each runtime verifies
```

`status` prints JSON. `selected` is the ttyd the resolver picks right now (with `managed: false` and a
warning under the Homebrew rollback), or `refused` with the reason when it picks none. `current` and
`previous` report the installed runtime and the last known good, each with `ok`, `stale` and every
failing check. A completed cutover prints the ttyd it selected and records it in its result file as
`ttydRuntime` (`{path, managed}`).

A runtime verifies when its digest matches its manifest, it is current (see above), its manifest
records exactly the sources and patches pinned in `deploy/ttyd/inputs.json`, its whole load graph
stays within macOS system libraries, and it runs. macOS permissions follow the executable, so the first
switch to `~/.tangleclaw/bin/ttyd`, and every rebuild that changes its sha256, needs the Operator's
permission checkpoint in [the rollout runbook](runbooks/roll-out-the-owned-ttyd.md). Do not assume a
grant survives a rebuild.

**What an interrupted install or rollback leaves.** A runtime is two files, the binary and its
manifest, so replacing one cannot be atomic. Both operations copy the incoming pair in beside the
current one as `ttyd.new`, verify it there, and then rename the manifest and, last, the binary into
place; the runtime being replaced is first copied to `ttyd.prev` (only if it verifies). Rollback
copies `ttyd.prev`, never moves it, and copies the runtime it replaces to `ttyd.rolled-back`. Those
copies are written to a `.tmp` name and renamed into place, never written over the old file, so an
interrupted copy cannot damage the last known good. Whatever step fails, one of these holds:

- the runtime the resolver selects verifies (the old one, or the new one), or
- the resolver refuses the half-replaced pair. If a last known good verified before the failure, it
  still verifies, and the refusal names it and `node scripts/ttyd-runtime.js rollback`, which
  restores it.

Nothing ever selects a partial runtime. When there is no verified last known good (a first install,
or one that is stale after a pin change), `node scripts/ttyd-runtime.js provision` builds a current
runtime instead.

**Rolling back after `deploy/ttyd/inputs.json` changes.** The last known good was built from the old
inputs, so it is stale and `rollback` refuses it, saying so. The way back is then the Homebrew ttyd:
set `TANGLECLAW_TTYD_RUNTIME=homebrew` and select it for your ingress mode (`./deploy/install.sh` in
direct mode, `node scripts/ingress-cutover.js --to caddy` in caddy mode); either restarts ttyd, under
Operator/PM authority. This brings the leak back, the watcher is again the only mitigation, and every
install and cutover says so. To return to the fix, unset the variable and follow
[the rollout runbook](runbooks/roll-out-the-owned-ttyd.md), which builds a current runtime.

## Global Configuration (`config.json`)

Auto-created on first run with defaults. Editable directly or via `PATCH /api/config`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serverPort` | number | `3101` | Landing page HTTP server port. The install script sets `TANGLECLAW_PORT=3102` via launchd, so the effective default after installation is **3102**. |
| `updateCheckIntervalMs` | number | `1800000` (30m) | How often a running server re-checks origin for a new release. The first check runs 60s after boot regardless. Values below 60000 (1 minute), or non-numbers, are rejected with a logged warning and the default is used — a typo must not become a tight poll against origin. This is the **floor for when nobody is looking**, not the only path: the dashboard re-checks on page load and whenever its tab regains focus (#716), every open session re-checks on its own poll (#954), and the header version is a button that checks on demand. Because those paths are throttled server-side at a much shorter floor, lowering this value only affects installs nobody has open — it is rarely worth changing. |
| `behindOriginCheckEnabled` | boolean | `true` | Whether the dashboard checks if the local clone is behind `origin/main` and shows an info banner ("N new commit(s) upstream on origin/main. This checkout is behind — pull them when convenient."). Installs pinned to a release tag should update through *Update now* rather than a raw pull, which would move HEAD off the tag. **This is a network call to GitHub** — a `git fetch --quiet origin` — so it is documented here for operators on metered or privacy-conscious connections. It runs at most once per 15 minutes, and only while a dashboard is polling `/api/server-info`; the answer is cached in memory and the route never waits on the fetch. No remote, an offline machine or a failed fetch yields `commitsAhead: 0` with `state: "unknown"` and a `reason`, and the dashboard's live-checkout banner says origin/main was not checked, rather than implying the checkout is up to date (#1678). No git at all yields 0 and no banner. An install whose HEAD is not on a branch — the healthy state the self-updater leaves behind, detached at a release tag — is skipped without any fetch (`skipped: "detached-head"` in the payload), because a tag is behind `main` by construction and *Update now* is the right path there. The fetch runs with `GIT_TERMINAL_PROMPT=0` and ssh batch mode, so a remote that wants credentials fails at once rather than waiting on a prompt nobody can answer. Set to `false` to skip the check entirely (no fetch is ever started); only a real boolean is accepted via `PATCH /api/config`, and only a literal `false` disables it. The environment variable `TC_BEHIND_ORIGIN_DISABLED=1` does the same from outside the config, for CI, sandboxes, or any process that must not call out (`0` or empty means not set). The same switch governs the per-repository upstream observation that session pages and launch primes compare against (#1678): a `git ls-remote origin refs/heads/main`, run at most once per repository every 5 minutes from one of its clones, which writes nothing into any clone. With the check off, no observation is made and the checkout reads "upstream not observed". The same switch also governs the wrap's one refresh of a project's default branch (#1868). With it off, the wrap compares against the ref as last fetched and says so. No restart needed. |
| `ttydPort` | number | `3100` | ttyd terminal emulator port. Pinned to `127.0.0.1` on every install — nothing addresses it directly, because TangleClaw proxies to it and the browser only ever loads a same-origin terminal route. In `caddy` ingress mode `ingress-cutover.js` swaps it for a Unix socket so ttyd is reachable only through the proxy. |
| `bindAllInterfaces` | boolean\|null | `false` | Accept dashboard connections from every network interface instead of `127.0.0.1` only. **This is the deliberate opt-out from the protection, not a convenience toggle** — the dashboard can open terminal sessions, so anyone who can reach the machine gets shell access as you. Prefer the Caddy login gate, which keeps remote access behind a password. Ignored (and logged) in `caddy` ingress mode, where Caddy fronts the server and a wide Node socket would sit beside the gate rather than behind it. Only a real boolean is accepted; a quoted `"true"` is refused and logged rather than silently treated as false. `null` is written once, automatically, on an install that predates this setting: it means "never chosen", keeps that install's existing wide binding so an update cannot take away remote access, and is reported on every boot and on the dashboard until resolved. Requires a restart. See [ADR 0009](adr/0009-secure-by-default.md). |
| `defaultEngine` | string | `"claude"` | Preferred engine for new projects. **Used only when that engine is actually installed** — otherwise TangleClaw falls back to the first installed engine (alphabetically by id, so the choice is stable across machines) and logs the substitution. With no engine installed, the Project Master refuses to launch and says so, while project create/attach/import record the configured intent anyway (registering a project is bookkeeping and must not require a binary). An id matching no known engine profile is passed through unchanged, so a typo here is reported by name rather than silently replaced. |
| `projectsDir` | string | `"~/Documents/Projects"` | Root directory for managed projects |
| `deletePassword` | string\|null | `null` | Password for destructive operations (hashed via scrypt when saved) |
| `quickCommands` | array | see below | Global quick command buttons |
| `theme` | string | `"dark"` | UI theme: `"dark"`, `"light"`, `"high-contrast"` |
| `chimeEnabled` | boolean | `true` | Play audio chime when session goes idle |
| `peekMode` | string | `"drawer"` | Peek UI mode: `"drawer"`, `"modal"`, `"alert"` |
| `setupComplete` | boolean | `false` | Whether the first-run wizard has been completed. Set to `true` automatically for existing installs that lack this field. |
| `httpsEnabled` | boolean | `true` | Enable HTTPS on TangleClaw's own listener. Has no effect in `caddy` ingress mode, where Caddy terminates TLS and TangleClaw serves plain HTTP on the loopback behind it. |
| `httpsCertPath` | string\|null | `null` | Path to TLS certificate file (PEM) |
| `httpsKeyPath` | string\|null | `null` | Path to TLS private key file (PEM) |
| `master` | object | see below | Project Master settings — see **The Project Master** below. Contains the switch that grants a persistent fleet-wide agent write access. |
| `medusaWatchdog` | object | absent (defaults) | The Medusa delivery watchdog's switch and thresholds (#1839): `enabled`, `tickMs`, `rearmAfterMs`, `backoffMs`, `maxRearms`, and the escalation thresholds (`agedNormalMs`, `agedBlockingMs`, `escalateBlockingMs`, `operatorBlockingMs`, `operatorCriticalMs`, `replyBlockingMs`, `replyCriticalMs`). Every key is optional and bounded. A `PATCH /api/config` value merges over what is stored and refuses unknown keys and out-of-range numbers. A bad value already on disk is ignored, with a logged warning. `enabled: false` stops re-arms and escalation but not recording. `tickMs` applies at the next start. Defaults and meanings: [docs/medusa-delivery.md](medusa-delivery.md#settings). |

### The Project Master (`master`)

Absent from this reference until 2026-08-17, which mattered once `master.accessLevel` stopped
being decorative: it is the switch that decides what a persistent agent with no working tree of its
own may write across every project it can reach. Patch it via `PATCH /api/config { master: {...} }`
(merge-then-validate: partial patches merge onto current settings), or from the access toggle on the
Master's control bar.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `master.accessLevel` | string | `"read-only"` | `"read-only"` · `"suggest"` · `"write"`. **`read-only`** refuses every file edit outside the Master's own `memory/` directory. **`suggest`** turns each such edit into a confirmation in the Master's terminal — and that confirmation stands even under the `bypassPermissions` launch mode, because a hook decision is evaluated separately from the permission-rules gate (probed, not assumed). **`write`** permits edits anywhere the Master can reach, across every project, without asking. Changing this is what the access toggle does. |
| `master.engine` | string\|null | `null` | Pin the Master to one engine; `null` follows `defaultEngine`. Applies at the next master start. |
| `master.launchMode` | string\|null | `null` | The Master session's own prompting mode (#756) — separate from `accessLevel`, which bounds what it may DO. A mode the resolved engine cannot honor is kept and reconciled to `default` at launch. |
| `master.scope` | `"all"`\|object | `"all"` | A focus setting rendered into the Master's identity (`{type:'group', groupId}` narrows it). **Not a security boundary.** |
| `master.autoStart` | boolean | `false` | Launch the Master at TangleClaw boot instead of on first open. |

**Enforcement is engine-dependent, and the difference is real.** On the Claude engine the level is
STRUCTURAL: a generated `PreToolUse` hook reads it from `<master home>/.access-level` on every tool
call, so the GUARD applies a change on the Master's next write attempt, and every way of failing to
read it degrades to read-only. **The running Master is a separate question:** it reads its own
instructions once, at launch, so it keeps acting on the level it started with until it restarts —
the guard will permit a write the Master itself still believes it may not make. Restart the Master
after changing this. On every other engine it is INSTRUCTIONAL — the level is prose in
the regenerated identity, so it arrives at the next master start and nothing structurally enforces
it. `GET /api/master/status` reports which of the two is running, and both the control bar and the
settings modal show it, so the weaker case is never displayed as the stronger one.

**If you roll TangleClaw back to a build older than #755, set `accessLevel` to `read-only` first.**
`PATCH /api/config { master: … }` validates the *merged* settings object, so an older build — whose
enabled set is `['read-only']` — rejects **every** master patch while `suggest` or `write` is stored,
including one that only toggles `autoStart`. The Master settings modal is then unsavable until you
edit this file by hand. The boundary itself stays safe (an older build's guard is baked read-only),
so this is a usability trap rather than a security one. Two other artifacts simply go inert on a
rollback and need no action: `<master home>/.access-level`, which an older guard does not read, and
the level-derived Hard rule, whose previous text is recoverable through the rule's version history.

**Editing this file by hand to raise the level is refused from inside the Master.** Below the `write`
tier the guard denies writes to its own control surface, and that includes this file — otherwise one
`suggest` confirmation here would buy permanent write at the next ensure.

### Ingress and login gate

These were absent from this reference until 2026-08-04 — the whole v5 authentication surface was
undocumented here while the README pointed at this file for "all fields, types, and defaults".
Defaults below are read from `DEFAULT_CONFIG` in `lib/store.js`.

| Field | Type | Default | Description |
|---|---|---|---|
| `ingressMode` | string | `"direct"` | `"direct"` — TangleClaw serves its own port. `"caddy"` — Caddy fronts it and owns TLS, and carries a password of its own only while TangleClaw's login cannot guard the door (before the first account, or during a fallback); TangleClaw binds loopback only. **Do not edit this by hand to switch modes** — it does not move ports, plists or the Caddyfile. Use `node scripts/ingress-cutover.js --to caddy` (or `--to direct`), which is reversible and previews with `--dry-run`. |
| `authEnabled` | boolean | `false` | The master switch for **both** doors this install can have. **(1) TangleClaw's own session gate** (#1418, #1420): enforced in-process on *every* ingress mode **whenever this flag is true**. With no account in the `users` table the install is `account-required` — closed, and a browser is shown a page that creates the first account (or run `node scripts/reset-admin.js --store --user <name>`). With accounts that are all disabled it is `locked` — closed, recovered with the same command. A store or config read failure also enforces. **(2) Caddy's `basic_auth` gate**, which exists only in caddy ingress mode. The cutover writes it while TangleClaw's login does not guard the door by itself (`account-required`, `unreadable`, or no state) and leaves it out once the login is `armed` or `locked` (`lib/auth-gate.js#guardsTheDoor`); a hand-edited Caddyfile keeps whatever it has until you change it. So "is a login enforced here?" is answered by asking both — `GET /api/auth/me` reports (1) as `gateState` (`open`, `account-required`, `armed`, `locked`, `unreadable`, or `fallback` while `scripts/gate-fallback.js` has stood the login down behind Caddy's password), and its `gateActive` is true for every state except `open` and `fallback`. Setting this **false** in a readable config file is the way out of a misconfigured TangleClaw gate, and it takes effect on the next request — **except in caddy mode while the Caddyfile on disk serves a site beyond `localhost` that forwards a request before any `basic_auth`** (what the cutover writes for an armed install; also a site gated everywhere but one handle, a Caddyfile that imports another file, or one `caddy adapt` cannot read — for instance when `caddy` is not on TangleClaw's PATH; see `lib/ingress-door.js`), **or, on an install with accounts, a `localhost` site with no `basic_auth` and no peer guard** (another machine asking for `localhost` reaches it). There TangleClaw's login stays on, because turning it off would leave those sites with no gate at all. To finish turning it off, re-run `node scripts/ingress-cutover.js --to caddy` with only a `localhost` site configured — it writes for the configured `authEnabled: false`, so the new site carries the peer guard — or run `node scripts/guard-ungated-sites.js` on a file that has only local sites. `node scripts/reset-admin.js --store --user <name>` recovers the login instead. **Not settable through `PATCH /api/config`** — that route answers `409 CREDENTIAL_ROUTE_MOVED` for this field and the two below. Change the login via the settings surface, or `node scripts/reset-admin.js`. Meaning ratified in ADR 0016 OQ3. |
| `basicAuthUser` | string\|null | `null` | Admin username in the gate. Read-only from the API; changed via `reset-admin.js`, since renaming means re-hashing the matched line. |
| `basicAuthHash` | string\|null | `null` | bcrypt hash from `caddy hash-password`. Never returned by any API, never logged. |
| `caddyHttpsPort` | number | `8443` | Port Caddy serves HTTPS on — **the operator's front door in caddy mode**, not `serverPort`. |
| `caddyHttpPort` | number | `8080` | Port Caddy serves plain HTTP on; redirects to the HTTPS site. |
| `caddyRemoteHttp` | boolean | `false` | Emit an additional gated **plain-HTTP** catch-all site (gated by Caddy's `basic_auth`, or by TangleClaw's login once it guards the door), for reaching the dashboard over an already-encrypted tunnel (WireGuard, Tailscale). Off by default because the password crosses the wire in the clear — only enable it when the transport is doing the encrypting. Set it here, then re-run the cutover to regenerate the Caddyfile. |
| `caddyTailnetHost` | string\|null | `null` | Tailnet FQDN to emit as an additional gated HTTPS site. The generator refuses to emit this site without a gate — Caddy's `basic_auth`, or TangleClaw's login in `armed`/`locked` — because an ungated remote HTTPS door is not a supported state. Re-run the cutover after setting it. |
| `caddyAccessLogPath` | string\|null | `null` | Absolute path for a `log { output file … }` block on every generated site that proxies to TangleClaw (never on the plain redirect site). `null` emits no log at all — TangleClaw does not start an access log you did not ask for. Normally set for you: it is adopted automatically from a live Caddyfile that already carries a per-site log block, so a cutover preserves an audit trail you added by hand instead of dropping it. Adoption refuses anything it cannot re-emit exactly — a block that also carries `format`/`level`, a destination with its own `{ roll_size … }`, a logger in the global options block, or two sites naming different files — and says so rather than silently adopting half of it. Rotation is Caddy's `log` directive, not TangleClaw's. |
| `publicDomain` | string\|null | `null` | Public domain for an ACME/Let's Encrypt site on 443/80. Requires real DNS pointing at this machine and relocates Caddy to a root LaunchDaemon — see [deploy/INGRESS.md](../deploy/INGRESS.md). Not needed for LAN or tailnet access. |

> **Reaching the dashboard from another device.** A gated caddy-mode install serves the machine's
> own mDNS name (`<hostname>.local`) alongside `localhost`, so a phone or laptop on the same network
> can reach it at `https://<hostname>.local:8443` and is asked for the password (#863). This is
> automatic — there is no setting for it — and it applies **only** when a login exists. An install
> with no credential names only `localhost`, and because a site name alone keeps no one out (Caddy
> listens on every interface and picks a site by the name the client sends), each of its sites also
> drops connections from any other machine — see "Sites without a password answer only this
> machine" in [deploy/INGRESS.md](../deploy/INGRESS.md). The certificate is regenerated if it does not already cover the name.
>
> Because the certificate is issued by your machine's own local authority, another device will warn
> the first time until that authority is trusted on it; `mkcert -install` covers the machine
> TangleClaw runs on, and other devices need the root certificate installed separately.
>
> For access beyond the local network, `caddyTailnetHost` (tailnet HTTPS), `caddyRemoteHttp`
> (plain HTTP over an already-encrypted tunnel) and `publicDomain` (public ACME certificate) remain
> the three options; each needs a cutover re-run after being set.

### Default Quick Commands

```json
[
  { "label": "git status", "command": "git status" },
  { "label": "git log", "command": "git log --oneline -5" },
  { "label": "ls", "command": "ls -la" }
]
```

### Password Protection

When `deletePassword` is set, the following operations require the password:

- Deleting a project
- Killing a session
- Wrapping a session

The password is hashed with scrypt before storage. Plaintext passwords from v2 are auto-upgraded on first verification.

## Global Rules (`data/global-rules.md`)

Editable markdown rules that apply to all projects across all engines. When an engine config is generated (e.g., `CLAUDE.md`, `.codex.yaml`), global rules are included as a `## Global Rules` section.

- **File**: `data/global-rules.md` in the TangleClaw repo — the single canonical source since #240, tracked in git. UI/API saves and PR-driven edits both land in this one file; there is no separate bundled default and no per-install copy
- **Legacy `~/.tangleclaw/global-rules.md`**: no longer read. On startup, if one exists and differs from the canonical file, TangleClaw backs it up beside itself (`.pre-240-backup` suffix) and logs a warning with recovery steps; merge wanted sections by hand via the editor
- **Edit via**: Landing page "Global Rules" panel, or `PUT /api/rules/global`
- **Revert**: restore it from git (`data/global-rules.md` is tracked). There is no Reset button (#243): under the canonical-source model (#240) `POST /api/rules/global/reset` is a back-compat no-op that returns the current content unchanged, so a button wired to it looked like a revert and changed nothing.

## Per-Project Configuration (`project.json`)

Stored in `<project>/.tangleclaw/project.json`. Created when a project is added to TangleClaw.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `engine` | string\|null | `null` | Engine ID for this project |
| `rules.core` | object | all `true` | Core enforcement rules (not editable) |
| `rules.extensions` | object | all `false` | Opt-in extension rules |
| `ports` | object | `{}` | Registered port assignments |
| `quickCommands` | array | `[]` | Project-specific quick command buttons |
| `tags` | array | `[]` | Project tags for filtering |
| `silentPrime` | boolean | `true` | Deliver the session prime silently rather than as typed input |
| `launchSequence` | object | `{"pasteRules": "pull", "unreadyWindowMinutes": 10, "recoveryMode": "operator"}` | The launch sequence's per-project settings (#1584, #1583). `pasteRules` decides where a PASTE-ONLY engine's project rules come from: `pull` (the default) leaves them to the sequence's governance step, which serves them in full and records that the session read them, and the prime carries a pointer instead; `paste` keeps the rule text in the prime. On an engine that delivers a hidden prime the rules ride their own hook and this setting changes nothing, and the paste stands wherever no sequence exists — an unrecognised value also reads as `paste`, so a typo can never be why a session runs without its rules. `unreadyWindowMinutes` (1–1440) is how long a session has to attest READY before TangleClaw records it as unready and nudges it once; it gates nothing. `recoveryMode` decides what a launch does when its handoff preflight says the project's state needs recovering (#1587): `operator` (the default) withholds the task step and refuses READY until a person clears it from the project's Launch readiness panel, and `advisory` serves the task step behind a warning and lets the session clear its own recovery by attesting with a written reconciliation. The mode is frozen with each launch, so editing it does not change the rules a pane already in flight is playing by, and an unrecognised value reads as `operator` — a typo can never be why a bad handoff went unnoticed. A key this object does not define is refused rather than stored |
| `releaseMode` | `"off"`\|`"auto"`\|`"ask"`\|null | `null` | Whether a wrap may cut a release (#1492). `off`: never; the project versions itself. `auto`: only when release readiness is `ready` (see below). `ask`: never by itself; a wrap with a release to cut stops at `version-bump` and asks you to choose Cut or Hold. `auto` asks the same way when readiness is `unknown`, and when the AI's release recommendation disagrees with it (readiness `ready` but the AI recommends hold, or `not-ready` but it recommends cut). The `release-recommendation` wrap step asks the session for that recommendation just before `version-bump`, based first on what you said in the conversation about the wrap. It sends no prompt when the mode is `off`, when you already chose Cut or Hold, or when `[Unreleased]` is empty. Disable it with `wrapStepOverrides` (`{"release-recommendation": {"enabled": false}}`) to have `auto` decide on readiness alone. In `auto` and `ask`, the wrap modal's Release: Cut or Hold decides whatever the readiness says; `off` hides that control, and the step reads no choice. Set it in the settings modal's **Release mode** select. `null` derives the mode: `off` when `versionBumpEnabled` is `false`, `auto` otherwise. An unrecognized value is treated as `ask`, with a warning in the step's output |
| `versionBumpEnabled` | boolean | `true` | Legacy switch `releaseMode` replaces, still read when `releaseMode` is unset: `false` means `off`. A settings save carrying either key writes both, with `versionBumpEnabled` `true` only for `auto`, so an older TangleClaw reading only this key holds rather than cuts |
| `versionFilePath` | string\|null | `null` | Explicit version file, relative to the project root (e.g. `VERSION.json`). `null` probes `version.json`, then `package.json`, then `pyproject.toml` (its static `[project] version`). A configured `pyproject.toml` is read and written as TOML, changing only that one value; any other configured file must hold JSON. Set it when the file has a different name or case — the probe only tests the lowercase name, so on a case-sensitive filesystem it would otherwise miss and bump `package.json` instead. Must stay inside the project — enforced after resolving symlinks, at both the API and the write site, since a hand-edited `project.json` never passes through the API. The wrap's version-bump **refuses** if a configured path is unusable — it never falls back to another file. Version *detection* (what the dashboard shows) is more forgiving: it prefers `CHANGELOG.md`, then this file, then the probe, warning and degrading rather than refusing. So an unusable value can show a probe-derived version while the wrap declines to bump |
| `releasePrepareCommand` | string\|null | `null` | Shell command a wrap runs when it cuts a release (#1502), for the files the release needs besides the version file and `CHANGELOG.md`, such as README install pins or a lockfile. The `commit` step runs it in the project root after the bump and CHANGELOG promotion are written and before anything is committed, with `TANGLECLAW_RELEASE_VERSION` and `TANGLECLAW_RELEASE_PREVIOUS` set. Files it changes go into the wrap commit, under the same Include / Leave rules as the wrap's own files, and the commit body lists them. A non-zero exit, or running past 5 minutes, stops the commit, shows the command's output, and puts the version file and CHANGELOG back so Retry cuts again. A wrap that cuts no release doesn't run it. The commit row in the wrap popover shows the outcome on every cut, including when it was not run and why (unset, not a string, or an unreadable `.tangleclaw/project.json`), and the auto-PR body lists the files. Not in the settings modal: set it in `.tangleclaw/project.json`. This repo uses `node scripts/release-prepare.js` |
| `featureIndexEnabled` | boolean | `false` | Maintain `FEATURES.md` during wrap |
| `projectMapEnabled` | boolean | `false` | Maintain `PROJECT-MAP.md` during wrap |
| `wrapAutoPrEnabled` | boolean | `true` | After an auto-branched wrap commit, push and open a PR back to the original branch |
| `wrapKeepSessionRunning` | boolean\|null | `null` | What a completed wrap does to the session when whoever started it did not say (#1708): another session's or the Project Manager's `POST /wrap`, a script. `true` keeps the session running, `false` ends it, and `null` (never set) ends it, as a wrap always has. A request's own boolean `options.keepSessionRunning` wins. A wrap that stops, fails or is cancelled leaves the session running either way. A value that is not a boolean, or a `project.json` that cannot be read, refuses a wrap that does not decide for itself, with **409** `WRAP_KEEP_SETTING_INVALID`, rather than guessing. Set it in the settings modal's **Keep the session running after a wrap** toggle; the wrap dialogs open pre-ticked from it |
| `wrapSections` | array\|null | `null` | Which continuity wrap-summary sections render. `null` = all of them |
| `wrapStepOverrides` | object | `{}` | Per-step wrap overrides, keyed by step id. `{}` means no overrides, so the project runs the **full** shipped pipeline — see [Wrap step overrides](#wrap-step-overrides) below |
| `provenanceWatermark` | object\|null | `null` | An opt-in provenance comment (ADR 0019): `{"enabled": true, "template": null}` puts a line such as `<!-- tangleclaw:provenance Built by TangleClaw (Project: my-app) -->` at the top of the private files TangleClaw generates whole for this project. It covers `.tangleclaw/session-prime.md`, `.tangleclaw/session-reentry.md` and `.tangleclaw/ui-wrap-advisory.md`. It also covers `.codex.yaml` and `.aider.conf.yml` while git ignores them. There the line goes directly beneath the `Generated by TangleClaw` header, and a carrier that becomes tracked loses the line at its next regeneration. `null` (the default) and `enabled: false` leave every file exactly as it would otherwise be. `template` overrides the default `Built by TangleClaw (Project: {project})`. It is at most 120 characters, it may use only `{project}` and `{engine}`, and it may contain no line break, comment delimiter or TangleClaw ownership marker. A missing, `null` or blank template means the default, so clearing it is the reset. A project or engine name that would break the comment or form a marker is neutralized, and the line falls back to `Built by TangleClaw`. Changes apply as each file is next regenerated, never by rewriting files when the setting is saved. The prime and re-entry files are written only while silent prime is on, so on an engine without it, or with it off, only the advisory and a git-ignored carrier carry the line. Set it in Project Settings (a toggle, and a line field whose blank is the default), through `PATCH /api/projects/:name`, which refuses unknown keys, or in `.tangleclaw/project.json`. `tc capabilities` reports it read-only as `provenance-watermark`, naming the surfaces by id. A hand-edited template the API would refuse falls back to the default |
| `medusaEnabled` | boolean | `false` | Auto-start this project's sessions on the Medusa switchboard |
| `medusaWake` | boolean | `false` | Wake an idle session on inbound switchboard messages |
| `defaultLaunchMode` | string | `"default"` | Engine launch-mode key this project launches in by default |
| `showLaunchModePicker` | boolean | `true` | Show the launch-mode picker instead of launching directly in the default mode |

### Core Rules (Always `true`)

| Rule | Description |
|------|-------------|
| `changelogPerChange` | Changelog updated with every code change |
| `jsdocAllFunctions` | All functions have JSDoc documentation |
| `unitTestRequirements` | Code has accompanying tests |
| `sessionWrapProtocol` | Sessions are properly wrapped |
| `porthubRegistration` | Port assignments go through PortHub |

### Extension Rules

| Rule | Type | Default | Description |
|------|------|---------|-------------|
| `identitySentry` | boolean | `false` | Identity verification checks |
| `docsParity` | boolean | `false` | Docs must match code changes |
| `decisionFramework` | boolean | `false` | Decisions follow the decision framework |
| `loggingLevel` | string | `"info"` | Minimum logging level |
| `zeroDebtProtocol` | boolean | `false` | No technical debt allowed |
| `independentCritic` | boolean | `false` | Independent Critic review required |
| `adversarialTesting` | boolean | `false` | Adversarial test cases required |

A boolean rule is rendered into every generated engine config when it is `true`. A rule that
carries a **value** rather than a switch — `loggingLevel` is the one shipped that way — renders
with its value, on every generator, including at its default. Codex and Aider additionally get a
native field (`logging_level:` / `verbose:`) their engines act on directly.

### Wrap Step Overrides

`wrapStepOverrides` turns off or reconfigures an individual wrap step for one project. It is
keyed by the step's `id` from the code-owned wrap pipeline (`lib/wrap-default-pipeline.js` —
one shared pipeline that every project runs):

```json
"wrapStepOverrides": {
  "version-bump":     { "enabled": false },
  "changelog-update": { "blocker": false }
}
```

The pipeline's step list ships in code and cannot be edited per project; overrides in
`project.json` — a file only the project owns — are the per-project configuration surface.

**The default is the full pipeline.** A project created or attached with no overrides runs
every step in the shipped list — including the steps that block on an unsatisfied
verification (`open-pr-check`, `changelog-update`, `learnings-capture`, `memory-update`). A
project that should wrap more lightly says so here, per step; there is no lighter starting
template to pick at creation time. This is a deliberate reversal of the pre-#652 default,
where a new project began life running a commit-only wrap and had to be opted *into* the
rest.

The practical consequence worth knowing before you attach a repo: on a project with no
`CHANGELOG.md` and no `.tangleclaw/memories/`, the steps that verify those files changed
will stop the wrap and ask you to confirm the skip. That is the verification working as
designed — a no-op is an operator's explicit decision, not something the wrap reports as
done — but on a project that will never keep a changelog, disable those steps here once
rather than ratifying the same skip every session.

Projects whose wrap was commit-only before the pipeline became code-owned were migrated
automatically: TangleClaw seeded overrides disabling every step except `commit`, plus a
`wrapOverridesSeeded: true` marker. The marker makes the seeding one-shot — clear
the overrides map (leave the marker) to opt the project into the full pipeline; it will
not be re-seeded. That migration covered the projects that existed at the cutover only;
it is not a default for new ones.

| Field | Type | Effect |
|-------|------|--------|
| `enabled` | boolean | `false` skips the step. It still appears in the wrap drawer as a skip with its reason, rather than disappearing from the run |
| `blocker` | `true` \| `false` \| `"errors-only"` | Whether a failed step halts the rest of the wrap. `false` means the step still runs, still reports failure, and the wrap continues. **`"errors-only"` halts** (it is a stricter form of `true`, not a softer one) — use `false` to stop a step halting your wrap |
| `prompt` | string | Replaces the instruction text for an `ai-content` step. An empty string makes the step skip itself |
| `coveragePaths` | `string[]` | Extra changelog paths (globs) the `changelog-update` coverage check accepts, on top of `verifyChanged`. For monorepos that keep a changelog per package — e.g. `["skills/*/CHANGELOG.md"]`. **Additive only:** it widens what counts as a logged commit, never narrows, and is inert on steps without that check. Glob syntax: `*` within one path segment, `**` across segments, a `**`-then-slash prefix also matching the repo-root file |

**The `preflight` step.** `preflight` is the pipeline's first step and the one override worth
knowing about by name: it asks prawduct for the verdict its session-end Stop hook would give,
and it ships **advisory** (`blocker: false`) so an unmet gate is reported and the wrap
continues. Three reasons it is not blocking out of the box: prawduct's reflection gate wants
the narrative the wrap's own content steps produce, so a blocking preflight would deadlock
against it; its Critic gate is minutes of agent time and belongs opted into per project; and
the escape hatch means writing another framework's state. A project that wants the door shut
sets `{"preflight": {"blocker": true}}` — the wrap then halts before any step writes to the
tree. The step skips itself in a project with no `.prawduct/` directory.

**What you cannot change.** Step *order and membership* are framework-owned — no adding,
removing, or reordering. Order carries correctness contracts between steps (the changelog must
be written before the version bump reads it to choose a level), guaranteed by one check against
the shared pipeline; per-project ordering would turn that into a promise nothing verifies.
There is no "different pipeline": per-project variation is exactly these overrides plus the
dedicated effect toggles below.

Fields outside the table above are ignored, and the API rejects them with the field named. Three
are worth calling out:

- **`verifyChanged` cannot be overridden.** It lists the files a step must actually have changed
  to count as done. Blanking it would leave the check reporting success while verifying nothing.
  Its additive companion `coveragePaths` (in the table above) only *widens* what the
  `changelog-update` coverage check accepts, so it carries no such risk.
- **`precondition` cannot be overridden.** It names the check that stops a content step from
  prompting when its answer could change nothing (`release-recommendation` uses it). Disable the
  step instead if you don't want it.
- **The `commit` step cannot be disabled.** Every other step stages its writes in memory; the
  commit step is the only one that flushes them to disk. Turning it off would leave the version
  bump and changelog update reporting success with nothing landing. You may still set its
  `blocker`.

**Relationship to the individual toggles.** `releaseMode` (and its legacy `versionBumpEnabled`), `featureIndexEnabled`, and
`projectMapEnabled` are independent of this map: each is checked by its own step at run time, so
either switch turning a step off is enough to skip it. There is no precedence to reason about —
they cannot contradict, only agree or disagree about which one did the skipping. Prefer the
dedicated toggle where one exists; it is the surfaced setting.

## Project Groups

Groups are stored in the `project_groups` SQLite table. Managed via the API or landing page UI.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | auto-generated | UUID primary key |
| `name` | string | required | Unique group name |
| `description` | string\|null | `null` | Group description |
| `sharedDir` | string\|null | `null` | Absolute path to a directory of shared `.md` files. On session launch, TangleClaw scans this directory and auto-registers new files as shared documents. |
| `created_at` | string | auto | ISO 8601 timestamp |

### sharedDir Auto-Discover

When `sharedDir` is set on a group, TangleClaw scans the directory for `.md` files at two times:
1. **Session launch** — before generating the engine config, all groups for the project are synced
2. **Manual sync** — via `POST /api/groups/:id/sync`

New files are registered with `injectIntoConfig: true` and `injectMode: 'reference'`. Already-registered files (matched by `file_path`) are skipped.

## Engine Profile JSON Schema

Engine profiles define how TangleClaw interacts with an AI engine. See the [Engine Guide](engine-guide.md) for full details on creating custom profiles.

```json
{
  "id": "string — unique identifier",
  "name": "string — display name",
  "command": "string|null — CLI command",
  "interactionModel": "string — 'session' or 'persistent'",
  "configFormat": {
    "filename": "string|null — config file name",
    "absentReason": "string — one operator-facing sentence saying WHY this engine has no config file, rendered in the settings modal beside the engine picker when filename is null. Declared here so a sixth carrier-less engine states its own case without a code change in either realm; omit it on an engine that has a config file. See docs/engine-guide.md → Capabilities.",
    "syntax": "string|null — 'markdown', 'yaml', 'toml', or null",
    "generator": "string|null — config generator id",
    "mergeStrategy": "string|null — 'whole-file' (default) or 'managed-block'",
    "discovery": {
      "verifiedOn": "string — ISO date the filename claim was checked upstream",
      "source": "string — the upstream doc consulted",
      "note": "string|null — what it said"
    }
  },
  "coAuthorFormat": "string|null — git co-author pattern",
  "commands": [
    { "label": "string", "input": "string", "description": "string" }
  ],
  "detection": {
    "strategy": "string — 'which' or 'custom'",
    "target": "string|null — binary name"
  },
  "launch": {
    "shellCommand": "string",
    "args": ["array of string"],
    "env": { "ENV_VAR": "value" },
    "startupDelay": "number|null — ms to wait before the blind prime paste. Required for a paste-path engine (supportsPrimePrompt, no supportsSilentPrime) whose capabilities.wake block declares no positive at-rest idleMarker; engines WITH one are readiness-gated instead and ignore this. See docs/engine-guide.md → Prime paste readiness."
  },
  "persistent": "object|null — persistent engine config",
  "capabilities": {
    "supportsSlashCommands": "boolean",
    "supportsPrimePrompt": "boolean",
    "supportsConfigFile": "boolean",
    "supportsCoAuthor": "boolean",
    "supportsSilentPrime": "boolean",
    "startupInjection": {
      "maxChars": "number — characters this engine's startup channel carries before the engine itself truncates. Omit to keep the 16,000 fallback. See docs/engine-guide.md → Capabilities.",
      "evidence": {
        "verifiedOn": "string — ISO date maxChars was measured upstream (required when maxChars is declared; the profile guard suite fails an unevidenced value)",
        "source": "string — where it was measured (upstream doc / probe)"
      }
    },
    "readOnlyModeMarker": {
      "modeLine": "string — the mode-line signature this engine's TUI draws in EVERY mode; locates the line. Required.",
      "marker": "string — the mode line as it reads in the read-only mode; decides. Required, and must not equal modeLine.",
      "label": "string — how the mode is named in operator copy (default: 'read-only mode')",
      "exit": "string — the keystroke that leaves it, for the remediation line",
      "evidence": {
        "verifiedOn": "string — ISO date the marker was measured against the live engine",
        "source": "string — how it was measured"
      }
    },
    "wake": {
      "busyMarker": "string — substring present iff a turn is in flight. Required.",
      "promptPattern": "string — regex SOURCE matching a bare prompt line; compiled when the profile is read. Required.",
      "promptGlyph": "string — the composer's glyph, used to locate the composer line. Required.",
      "promptPad": "string|null — the separator the prompt draws before the first input column; null when never measured. Required (null counts).",
      "placeholderSgr": "array of number — SGR attributes this engine renders text the operator did NOT type in. Required.",
      "idleMarker": "string|null — a positive at-rest signal; null when nothing was found that is present at rest and absent mid-turn. Required (null counts).",
      "decorativePattern": "string — OPTIONAL. Regex source matching cells this engine ANIMATES while idle (decoration the operator did not type). Both idle gates test it one cell at a time: the transcript digest blanks each matching cell to one space, the composer scan skips them. Declared only where an idle pane was watched and seen to move — codex's braille shimmer (#1344). Refused unless it matches decoration only: a pattern matching the empty string, any printable ASCII character, or a sample of common non-ASCII letters is rejected (that is what an operator types), so it cannot disable both gates silently.",
      "pasteRejectedMarker": "string — the engine's own words when it discards a submission. Optional; declared only where that was observed.",
      "evidence": {
        "<field>": {
          "verifiedOn": "string|null — ISO date this field was measured, or null for a value nobody has measured",
          "source": "string — where and how it was measured"
        }
      }
    }
  }
}
```

Omit `readOnlyModeMarker` and the wrap's read-only pre-check does nothing for that engine (the
honest default — the step behaves as it did before the check existed). See
`docs/engine-guide.md` → Capabilities for why locating and deciding are separate fields.

Omit `wake` and the engine is never idle-judged or nudged (skipped and logged, never woken against
a guessed signature). Its `evidence` map must cover the declared fields in both directions, and a
malformed block is refused when the profile is read — see `docs/engine-guide.md` → `wake`.

## SQLite Database

The SQLite database at `~/.tangleclaw/tangleclaw.db` stores runtime state. You should not need to edit it directly — use the API instead.

**Tables**: enumerated by the schema in `lib/store.js` (inspect a live DB with `sqlite3 ~/.tangleclaw/tangleclaw.db .tables`). A list copied here went stale twice — the schema is the source of truth.

Current schema version: `CURRENT_SCHEMA_VERSION` in `lib/store.js` (a literal copied here went stale within months; the constant is the source of truth).

### Port Leases Table

The `port_leases` table stores all managed port assignments. TangleClaw is the authoritative port registry — leases survive restarts.

**Columns**: defined by the `port_leases` DDL in `lib/store.js`. A copy lived here and went stale twice over — it still documented `port` as the sole primary key after v7→v8 made it `(host, port)`, and it missed `reach` entirely (v34→v35, #1394). Both omissions describe the exact shape of a bug this table's own subject shipped: matching a lease by port while ignoring the host half of its key. The schema is the source of truth, the same rule this page already applies to the table list and the schema version above.

## API Overview

TangleClaw's HTTP API lives under `/api/`; the tables below are the reference. All endpoints accept and return JSON. Error responses use the format:

```json
{ "error": "Human-readable message", "code": "MACHINE_READABLE_CODE" }
```

**Request body limits.** A request body is capped at 10 KB unless its route sets its own cap. Every route that carries prose someone wrote into a session allows 64 KB: the switchboard `send`, `loop` and `loops/:loopId/continue` routes (under both `/api/sessions/:project/medusa` and `/api/master/medusa`), `/api/sessions/:project/command`, `/api/sessions/:project/wrap/handback` and `/api/sessions/:project/wrap/complete`. A route's own content cap still applies on top — `/command` refuses a `command` over 4096 characters with a **400**. An over-limit body is a **413** `BODY_TOO_LARGE` carrying `limitBytes` and `receivedBytes`, plus `receivedBytesIsLowerBound: true` when the request had no `Content-Length`, so the count is a floor rather than the total.

### Core

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Service health check |
| `/api/version` | GET | Version info |
| `/api/system` | GET | CPU, memory, disk stats |
| `/api/config` | GET | Global config (password redacted) |
| `/api/config` | PATCH | Update config fields |
| `/api/models/status` | GET | Upstream API status for all engines |
| `/api/update-status` | GET | Last update-check result, from cache — no network, no side effect. `checkedAt: null` means never measured (the window after every boot) and `checkOk: false` means the last attempt failed; neither is "you are up to date" |
| `/api/update/check` | POST | Measure now. `{"manual": true}` takes the 10s staleness floor, anything else the 5m one. Throttled and single-flight, so reloads and open tabs cannot multiply `git ls-remote` calls against `origin` |

### Engines

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/engines` | GET | List engines with availability |
| `/api/engines/:id` | GET | Engine profile details |

### Projects

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/projects` | GET | List projects (filterable). Shaped for the caller (#1739): the operator and the bound Project Master see every row whole, a bound project sees its own whole, and every other row is the public projection `{id, name, registered, archived, tags, engine: {id, name}, session: {active, status, startedAt}, restricted: true}`; `scan` then omits `dir` and `hint`. Each whole row carries `stranded` — `{total, unacknowledged, grandfathered, blocking, github}` — or `stranded: null` with `strandedError` when the records could not be read (#1541). `github` is the latest GitHub check's counts: `{state, lastOkAt, lastAttemptAt, reason, redCi, noPr, unchecked}` (#1542, #1543). Each project also carries `sessionHealth` (#1544): `null` when a session is active or the latest one did not end `killed` or `crashed`; otherwise `{scope: 'session', sessionId, status, endedAt, state, checkedAt, reason, newPaths, newPathCount, unpushed, snapshotComplete}`, where `state` is `left-work` (paths changed that were not changed at launch, or commits since launch on no remote-tracking ref), `clean`, `unknown` (with `reason`), or `checking` (read in the background; the next poll has it). `newPaths` holds at most five; `snapshotComplete: false` means the launch list was not captured or was truncated, so every changed path counts. A store that cannot be read gives `state: 'unknown'` with `status: null` |
| `/api/projects/:name` | GET | Single project detail, shaped for the caller like the list (#1739) |
| `/api/projects` | POST | Create project. Operator-only (#1752) |
| `/api/projects/attach` | POST | Attach existing directory as project. Operator-only (#1752) |
| `/api/projects/import` | POST | Import project from external source. Operator-only (#1752) |
| `/api/projects/:name` | PATCH | Update project. The operator, or the project's own bound session; another project's session gets `403 OTHER_PROJECT`, and a rename is operator-only (#1752). The Project Master is refused at every access level (`403 PROJECT_READ_ONLY`): its level governs file edits, not API authority (#966) |
| `/api/projects/:name` | DELETE | Delete project. Operator-only: any other caller gets `403 OPERATOR_ONLY`; a configured delete password is also required (#1746) |
| `/api/projects/:project/stranded-wraps` | GET | Stranded wraps from local records (id or name), minus those a GitHub check cleared: `items`, and `counts` with `total`, `unacknowledged`, `grandfathered` and `blocking` (unacknowledged and not grandfathered). `github` is what the latest recorded check said, without calling GitHub: `state` (`ok`, `failed` — the latest check could not run, `never` — none on record, `none` — no origin or not a github.com remote), `lastOkAt`, `lastAttemptAt`, `reason` (for `failed`/`none`), `findings` (`[{kind: 'red-ci'\|'no-pr', scope, branch, headSha, prNumber, prUrl}]`, from the latest `ok` check only, at most 20), `findingsTotal`, `redCiTotal`, `noPrTotal`, `unchecked` (wrap branches not looked up). Findings never block. Each item carries `prOpened`: `{url, by, at}` for the newest PR opened for it from the cleanup path at the same head, else `null` (#1545) |
| `/api/projects/:project/stranded-wraps/check` | POST | The operator or the project's own session (#1752). Run the GitHub check now (#1542): clears items whose branch merged, was deleted, or has an open PR with every check passed, and records the attempt as `wrap.strand_check`. **200** with `check` (`{ok, state, reason, at, remote, cleared: [{remote, branch, headSha, reason, prUrl}], findings, unchecked}`) and the GET's body; a check that could not run is still **200** with `check.state: 'failed'`. A request while one is running joins it. A successful launch starts the same check without waiting (skipped within five minutes of an `ok` or `none` check) |
| `/api/projects/:project/stranded-wraps/open-pr` | POST | The operator or the project's own session (#1752). Open a pull request for one listed item (#1545): `{branch, headSha, remote?, confirm: true}`, matched as for `ack`. Reads `origin`, the branch's head on it and its open PRs before creating; targets the repository's default branch and does not merge. **201** `{ok, prUrl, item}` with `item.prOpened`, recorded as `wrap.strand_pr_opened` `{remote, branch, headSha, prUrl, by, at}` with the signed-in user. **400** `BAD_REQUEST` (no `confirm: true`, bad fields), **404** not listed, **409** `IN_PROGRESS` / `REMOTE_MISMATCH` (origin is not the recorded remote) / `BRANCH_GONE` / `BRANCH_MOVED` (origin head is not the listed SHA) / `PR_EXISTS` (with `prUrl`), **422** `NOT_GITHUB`, **502** `READ_FAILED` / `CREATE_FAILED`, **500** `WRITE_FAILED` (the PR was opened, `prUrl` given, but not recorded). Nothing is recorded on any refusal. Never deletes a branch |
| `/api/projects/:project/stranded-wraps/ack` | POST | The operator or the project's own session (#1752). Acknowledge one listed item at its current head: `{branch, headSha, remote?}` with the full SHA (`null` only for an older record) and the remote as listed (`null` for an item listed with none). **201** recorded, **200** already acknowledged, **404** not listed at that head, **500** not saved. Records the signed-in user |

### Sessions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions/:project` | POST | Launch session. **409** `STRANDED_WRAPS` with `items` when unacknowledged stranded wraps hold the launch (grandfathered ones never do); nothing is written to the project. Resend with `acknowledgeStranded: [{remote, branch, headSha}]` covering every listed item to acknowledge them as the signed-in user and launch in one request. A resend that still leaves one uncovered, or one that appeared meanwhile, gets **409** again with the current items. An acknowledgement that fails keeps its own status: **400** `BAD_REQUEST`, **404** `NOT_FOUND` (not listed at that head), **500** `WRITE_FAILED`; acknowledgements already recorded stay. The **201** carries `strandedUnchecked`: null when the check ran, or the reason it was skipped because the records could not be read (the launch goes ahead then) |
| `/api/sessions/:project` | DELETE | Kill session |
| `/api/sessions/:project/status` | GET | Session status |
| `/api/sessions/:project/command` | POST | Inject command. Body `{command, enter?}`; `command` is at most 4096 characters (**400**), and the body at most 64 KB (**413** `BODY_TOO_LARGE`, see Request body limits above) |
| `/api/sessions/:project/wrap` | POST | Start the wrap pipeline. Answers `202` with the run's `runId`, `statusUrl` and `streamUrl` once the run is claimed; the outcome is read from the stream's `run-done` or `/wrap/status`. 409 `WRAP_IN_PROGRESS` names the running run's `runId`. `options.pathDecisions` (`{[path]: 'include'\|'leave'}`) answers the wrap's question about uncommitted files the session did not change (#1406), about files new to the repository (foreign reason `untracked-new`: never committed, whether or not staged, first seen after launch, and written neither by a wrap step nor by TangleClaw itself, which writes `.tangleclaw/project.json` and the engine config files; #1724), and, on the same key, about files whose contents match a credential pattern (#1513) — those may be files the session *did* change, and `output.foreignPaths[].secretRules` names the rules matched (never the matched text). A flagged file with no decision stops both `session-files` and `commit` with `needs-operator`; `include` commits it as it is, `leave` keeps it uncommitted, and removing the credential clears the block with no decision. A SQLite database (by header, extension or `-wal`/`-shm`/`-journal` sidecar) is never committed by a wrap and never listed as a choice (#1858): it is reported in `output.safetyWithheld`, and an `include` sent for one is ignored and named in `output.refusedIncludes`. Each `foreignPaths[]` entry also carries `kind` (`local`\|`durable`\|`ambiguous`), an advisory `recommendation` (`'include'`\|`'leave'`\|`null`, never `include` for a secret match) and `recommendationWhy`. No answer is filled in by the server. Both steps emit `output.manifest` (`{commit, keepLocal, protected, alreadyUpstream, unresolved, refusedIncludes}`, exact paths), and `session-files` emits `output.ignoreSuggestions`, anchored ignore lines offered as text only. **Upstream provenance (#1868).** Before that advice, `session-files` compares every uncommitted file with the upstream default branch (`<remote>/HEAD`, else `main` or `master`): one bounded refresh of that single remote-tracking ref (no tags, no prune; governed by `behindOriginCheckEnabled` / `TC_BEHIND_ORIGIN_DISABLED`), reported in `output.provenance` (`state` `established`\|`stale`\|`unavailable`\|`no-remote`, `ref`, `refSha`, `refresh`, `observedAt`, `ahead`, `behind`, `problem`) and the sentence `output.provenanceHeadline`. A file whose content upstream already holds byte for byte is listed in `output.alreadyUpstream`, never staged or asked about; an `include` sent for one is ignored and named in `output.provenanceRefusedIncludes`. A file upstream tracks with other content, when this checkout never committed it or upstream changed it after the checkout forked, is asked about with foreign reason `upstream-owns` and `recommendation: 'leave'`. When upstream could not be checked well enough, every file needing a decision is advised `leave`. Each `foreignPaths[]` entry carries `upstream` (`equal`\|`different`\|`absent`\|`unknown`), `upstreamVerdict` and `branchChanged`. A path that commits unique to this branch changed since it split (proven from history, never an untracked path) is the branch's own work: matching upstream there undoes the branch's change and is committed, and one upstream changed too is committed as usual and named in `output.provenanceDiverged`. The commit step re-judges the tree as it then is against the same recorded commit, and the newer one if the local ref moved, with no network call; the changelog check reuses `session-files`' verdicts (`output.provenanceVerdicts`). `options.pathDecisionBasis` (`{[path]: verdict}`) echoes the verdict each answer was given against, and an `include` given against a weaker verdict than the current one is not carried forward: the path is named in `output.provenanceChanged` and asked again. A repository with no remote has nothing upstream, so its advice is unchanged. `options.release` (`'cut'\|'hold'`, absent for Auto) is the operator's release decision (#1492). Without it, an `ask` project, or an `auto` project whose release readiness is `unknown`, stops at `version-bump` with `needs-operator` before `commit`, and a Retry carrying `release` answers it. `options.bumpLevel` (`'patch'\|'minor'\|'major'`) picks the level for a cut, and sent alone still means cut. `options.skipPreflight: true` wraps past a halting preflight (#1229). `options.untrackState` (`'approve'\|'decline'`) answers the one-time offer to stop tracking TangleClaw state files (#1512): without it, a project that tracks one stops at `session-files` with `needs-operator` and `output.untrackOffer.paths`; `approve` removes exactly those paths from tracking in the wrap commit, `decline` is remembered in `.tangleclaw/state.json`. **409** `STRANDED_WRAPS` with `items` (and no `runId`) when unacknowledged stranded wraps exist and no run is in progress; nothing is claimed (#1540). `options.proceedPastStranded: [{remote, branch, headSha}]` covering every listed item starts the wrap anyway and acknowledges nothing, so the items still hold the next launch; it is kept with the run's options and replayed on Retry. **400** `BAD_REQUEST` when it is not an array. The **202** carries `strandedUnchecked`, as the launch's **201** does. A run that finishes (`ok`) ends the session, with or without a commit; a run that stops, fails, throws or is cancelled leaves it open (#1558). `options.keepSessionRunning` (`true` or `false`) decides that for this wrap; **400** `BAD_REQUEST` when it is present and not a boolean. Without it the project's `wrapKeepSessionRunning` decides (#1708), except that a Retry of this session's unfinished run keeps the answer that run resolved, and its source, unless the request sends a different boolean. The server resolves the answer once, before the run is claimed, and records it in the run's options. **409** `WRAP_KEEP_SETTING_INVALID` when the request does not decide and the project setting is not a boolean or `project.json` cannot be read; nothing is claimed. `keepSource` and `sessionOutcomePlanned` in a request are ignored. The **202** carries `sessionOutcomePlanned` (`end`\|`keep`: what the run will do to the session **if it completes**), `keepSource` (`request`\|`project`\|`default`) and `cancelUrl`. A finished run's `result` carries `sessionOutcome`: `ended` (the wrap was recorded and the session ended), `kept` (kept on request, and still the active session), or `null` (the run did not finish, or the session had ended another way, such as a Kill during the wrap). It also carries `handoffPublication` (#1675): `{state, publicationId, digest, kind, reason, supersededId, supersededById}`, where `state` is `published` (this run's handoff was current when the run finalized it, which does not promise it is still current at the next launch; `digest` is the sha256 of its bytes), `not-published` (it completed but the publish was refused, with the refusal as `reason`; it stays eligible for the next launch's repair), `abandoned` (`reason` is the store's: `pipeline-failed`, `lifecycle-incomplete`, `eligibility-not-bound` or `checkpoint-not-bound`) or `not-staged` (no handoff was staged; `reason` says why, including that the run stopped before the step). Supersession is directional: `supersededId` is the publication this one displaced as current, and `supersededById` is the newer publication it lost to. It is not on the **202**, which is sent before anything is staged. A step's `status` may also be `not-applicable` (the step has no subject in this project) or `capability-unavailable` (it applies, but the session's engine cannot perform it, so its evidence was not produced). Neither stops the run, and a handoff never counts `capability-unavailable` as evidence produced (#1738). The run resolves once, from the **session's** engine, whether that engine can run the project's Prawduct methodology. The `run-start` event and the finished `result` carry `methodologyAuthority` (`{state: 'granted'\|'withheld', engineId, reason}`), and the `result` also carries the resolved `methodology`. When it is `withheld`, meaning the project is onboarded and the engine is not Claude, `preflight` does not run `prawduct-hook` and `version-bump` cuts no release. `commit` still pushes and opens the wrap PR where a wrap would (on the base branch), but does not arm auto-merge, and leaves `.prawduct/` paths out of the commit, listing them as `output.methodologyWithheld`. `apply-pr-resolutions` enqueues no merge and lists the PRs in `output.notEnqueued`. |
| `/api/sessions/:project/wrap/cancel` | POST | Stop a running wrap at its next step boundary (#1707). Body `{runId}`, required, so a cancel lands only on the run the caller is watching; **400** `BAD_REQUEST` without it. Gated like `POST /wrap`, and not blocked by `wrapDisabled`. Honoured only before the run's `commit` step: **202** `{cancelRequested: true, willStopBefore, finishingStepId, note}`, where `willStopBefore` is the first step that has not started and `finishingStepId` the step still running (it always finishes; nothing is interrupted mid-step). Repeating it answers the same. **409** `WRAP_NOT_CANCELLABLE` with `currentStepId` once `commit` has started: from there the run may have branched, committed, pushed, opened a PR or armed auto-merge, so it runs to its end. **404** `WRAP_RUN_NOT_FOUND` when `runId` is not the project's live run, **404** `NOT_FOUND` for an unknown project. Accepting a cancel and admitting the `commit` step are one decision, so a **202** can never race the commit starting. A cancelled run ends with `ok: false`, `blockedAt: null`, `cancelledAt` (the first step it did not start, later steps `pending`) and `outcome: 'cancelled'` (the result's `status` is `cancelled`), and the session stays running whatever `sessionOutcomePlanned` said. It offers no Retry or Skip. If a cancel was accepted while a step ran and that step then halted, the run ends cancelled and the step's blocked result stays in the results. What a cancel guarantees is no commit, branch, push, PR or auto-merge; it does **not** undo the steps that ran, so uncommitted edits or local state they wrote may remain |
| `/api/sessions/:project/wrap/complete` | POST | Complete wrap with captured data. Records the wrap and ends the session; commits nothing |
| `/api/sessions/:project/wrap/status` | GET | The wrap-run registry's view of the project (#583): `running`, `stale`, `runId`, `currentStepId` with `currentStepStartedAt` (server epoch ms), a finished run's `result` (the same payload the stream's `run-done` frame carries), `options` — a copy of the options the run was started with, so a reloaded page replays the operator's choices on Retry (#1492) — `sessionOutcomePlanned` and `keepSource` — the run's resolved keep-running answer (#1708), `null` for no run —, `cancellable` — whether `POST /wrap/cancel` would still be honoured — and `cancelRequested` (#1707), and `handback` — the fix sent to the session for this run's blocked step, or `null`; it is not on the run stream, which has closed by the time a fix is sent. This is where a page that reloaded, or lost its stream, finds the outcome, and where a client that did not start the run learns its `runId`. A run claimed and never settled reports `running: false` with `stale: true`, so a consumer that only asks whether a wrap is in progress gets the safe answer without knowing staleness exists (#1314) |
| `/api/sessions/:project/wrap/stream/:runId` | GET | Live pipeline progress as `text/event-stream` (#185). Replays every event the run has already emitted, then streams live ones, and closes on the terminal `run-done`. `Last-Event-ID` resumes after that seq. An unknown or foreign `runId` is **404 `WRAP_RUN_NOT_FOUND`**, not an empty stream — a client that gets it falls back to polling `/wrap/status`. Read-only and starts nothing, so the wrap POST's password gate is not re-applied; it sits behind every perimeter gate the POST does |
| `/api/sessions/:project/wrap/handback` | POST | Ask the session to fix the step its settled wrap blocked on, and watch for it to finish (#1312). Body `{stepId, prompt}` (one line, ≤3800 chars); the server appends the completion instruction with a fresh nonce and answers **202** with `handbackId`, `handback` and `streamUrl`. **409** `WRAP_NOT_SETTLED` / `WRAP_STEP_NOT_BLOCKED` / `WRAP_STEP_NEEDS_OPERATOR` when there is no settled halt at that step, **409** `WRAP_STEP_NOT_RESOLVABLE` for a block a prompt cannot fix (only content and preflight blocks can be handed back), **400** on a bad prompt, **404** `NOT_FOUND` when the wrap's session record is gone, and **404**/**409** `HANDBACK_NOT_SENT` when sending the prompt failed. While watched, `handback.state` is `working`, or `quiet` once the terminal has not changed for 60s with no line (the session may be waiting on the operator; `completionNote` says so) — `quiet` goes back to `working` when the terminal moves, and still becomes `ready` if the line appears. It ends as `ready` (the session printed its completion line), `timed-out` (still working after 5 minutes), `quiet` (still quiet 30 minutes after going quiet), `failed` (the terminal could not be read) or `superseded` (another handback, or a new wrap run, replaced it). Gated like `/command` |
| `/api/sessions/:project/wrap/handback/stream/:handbackId` | GET | The handback's watch as `text/event-stream`: `handback-start`, a `handback-update` each time it turns `quiet` or back to `working`, then one terminal `handback-done`, then close. An ended handback replays both and closes at once; an unknown id is **404 `HANDBACK_NOT_FOUND`** |
| `/api/sessions/:project/wrap/pr-status` | GET | Whether the wrap's PR actually merged (#638) — `merged` / `pending` / `blocked` / `unknown` |
| `/api/sessions/:project/peek` | GET | Peek at output |
| `/api/sessions/:project/clipboard` | GET | Newest tmux buffer (the last terminal copy); 404 `NO_BUFFER` when nothing has been copied, `TMUX_UNAVAILABLE` when tmux cannot answer |
| `/api/sessions/:project/history` | GET | Session history |

### Ports

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ports` | GET | List all port leases |
| `/api/ports/lease` | POST | Create or renew a port lease |
| `/api/ports/release` | POST | Release a port lease |
| `/api/ports/heartbeat` | POST | Heartbeat a TTL lease |
| `/api/ports/owner-kind` | POST | Mark an owner name's leases as a TangleClaw project or `external` (#1381) |
| `/api/ports/sync` | POST | Sync port leases with system state |

### Rules & Config

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/rules/global` | GET | Get global rules content |
| `/api/rules/global` | PUT | Save global rules content |
| `/api/rules/global/reset` | POST | Back-compat no-op since #240: returns the current content unchanged (the UI no longer calls it, #243) |
| `/api/activity` | GET | Activity log |
| `/api/upload` | POST | Upload a file to a project directory (15 MB limit) |
| `/api/uploads` | GET | List uploads for a project (`?project=name`) |
| `/api/tmux/mouse/:session` | GET | Get mouse mode |
| `/api/tmux/mouse` | POST | Set mouse mode |

### Setup

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/setup/scan` | POST | Scan projects directory for attachable projects |
| `/api/setup/complete` | POST | Complete first-run setup wizard |

### Groups & Shared Documents

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/groups` | GET | List project groups |
| `/api/groups` | POST | Create a group |
| `/api/groups/:id` | GET | Get group details |
| `/api/groups/:id` | PUT | Update a group |
| `/api/groups/:id` | DELETE | Delete a group |
| `/api/groups/:id/members` | GET | List group members |
| `/api/groups/:id/members` | POST | Add member to group |
| `/api/groups/:id/members/:projectId` | DELETE | Remove member from group |
| `/api/shared-docs` | GET | List shared documents |
| `/api/shared-docs` | POST | Register a shared document |
| `/api/shared-docs/:id` | GET | Get shared document details |
| `/api/shared-docs/:id` | PUT | Update a shared document |
| `/api/shared-docs/:id` | DELETE | Delete a shared document |
| `/api/shared-docs/:id/lock` | GET | Check document lock status |
| `/api/shared-docs/:id/lock` | POST | Lock a shared document |
| `/api/shared-docs/:id/lock` | DELETE | Unlock a shared document |

### OpenClaw

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/openclaw/connections` | GET | List all connections |
| `/api/openclaw/connections` | POST | Create a connection |
| `/api/openclaw/connections/:id` | GET | Get connection details |
| `/api/openclaw/connections/:id` | PUT | Update a connection |
| `/api/openclaw/connections/:id` | DELETE | Delete a connection |
| `/api/openclaw/connections/:id/tunnel` | POST | Start SSH tunnel |
| `/api/openclaw/connections/:id/tunnel` | DELETE | Stop SSH tunnel |
| `/api/openclaw/connections/:id/approve-pending` | POST | Auto-approve device pairing |
| `/api/openclaw/test` | POST | Test SSH + gateway connectivity |

### Sidecar

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sidecar/:project/processes` | GET | Get background processes for a project |
| `/api/sidecar/connection/:connId/processes` | GET | Get background processes by connection ID |

### Eval Audit

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/audit/telemetry` | GET | Get audit telemetry |
| `/api/audit/ingest` | POST | Ingest exchange data for evaluation. Stored under the project bound to the authenticated connection; `409 CONNECTION_UNBOUND` when none is (#1261) |
| `/api/audit/heartbeat` | POST | Heartbeat for audit sessions |
| `/api/audit/retention/run` | POST | Run retention cleanup |
| `/api/audit/:project/scores` | GET | Get evaluation scores |
| `/api/audit/:project/scores/:id/human` | POST | Submit human review of a score |
| `/api/audit/:project/anomalies` | GET | Get detected anomalies |
| `/api/audit/:project/summary` | GET | Get audit summary |
| `/api/audit/:project/baseline` | GET | Get quality baseline |
| `/api/audit/:project/baseline/recompute` | POST | Recompute baseline |
| `/api/audit/:project/trends` | GET | Get quality trends |
| `/api/audit/:project/wrap-quality` | GET | Get wrap quality metrics |
| `/api/audit/:project/incidents` | GET | List incidents |
| `/api/audit/:project/incidents/:id` | GET | Get incident details |
| `/api/audit/:project/incidents/:id` | PUT | Update incident |

### Per-Route Body Size Limits

The server enforces per-route body size limits rather than a single global limit. Most API routes use the default JSON body limit, while the upload endpoint allows larger payloads to accommodate base64-encoded files.

| Route | Max Body Size | Notes |
|-------|--------------|-------|
| `POST /api/upload` | 15 MB | Accommodates base64-encoded files (overhead ~33% over raw file size) |
| All other routes | Default (100 KB) | Standard JSON payloads |

These limits are configured in `server.js` using per-route middleware.

### Upload System

The upload system (`lib/uploads.js`) allows files to be sent into project directories from the session wrapper UI.

- **Endpoint**: `POST /api/upload` — accepts a JSON body with `project`, `filename`, and `data` (base64-encoded file content)
- **Endpoint**: `GET /api/uploads?project=name` — lists previously uploaded files for a project
- **Size limit**: 15 MB per upload — `lib/uploads.js#MAX_UPLOAD_BYTES`, which the route reads rather than restating, because the save deadline is derived from it
- **File types**: **any** (#338). There is no extension allowlist. Uploads are only ever referenced by local path — never served over HTTP or executed — so the type carries no execution vector; the safety boundary is the filename sanitisation, which strips path separators and reduces the extension to alphanumerics
- **Storage**: with an active session, `<project>/.tangleclaw/continuity/sessions/<sid>/uploads/` (CC-4), so a session's files are part of its durable record and cascade-delete with the project; with no active session, the legacy flat `<project>/.uploads/` as a fallback. Filenames are timestamped (e.g. `20260314-143022-screenshot.png`) and the response carries the full path so it can be handed to an AI assistant
- **Off the event loop** (#889): every filesystem call happens in the forked scanner child (`lib/uploads-fs.js`, driven through `lib/dir-scanner.js`'s *interactive* scanner), so a TCC-protected or stalled-mount project directory cannot wedge the server. Both writers stage-and-rename via `lib/staged-write.js`. `GET /api/uploads` distinguishes "nothing uploaded" from "could not read" (`unreadable` / `unreadableHint` / `unreadableCode`), and `POST /api/upload` distinguishes a project directory that is **gone** (400) from one that is **there and refused** (500) — reporting a refusal as a deletion is the misdiagnosis the scanner exists to remove
