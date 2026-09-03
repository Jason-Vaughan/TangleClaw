# TangleClaw User Guide

This guide walks you through using TangleClaw — from first launch to managing AI development sessions on your projects.

## Getting Started

### Prerequisites

- **Node.js 22+** — required for `node:sqlite` and `node:test`
- **ttyd** — browser-based terminal emulator (`brew install ttyd`)
- **tmux** — terminal multiplexer (`brew install tmux`)
- At least one AI engine installed (e.g., `claude`, `codex`, or `aider`)

### Installation

Follow the **[Quick Start in the README](../README.md#quick-start)** — it is the single maintained
copy of the install steps, including which release to clone and the one prerequisite you must
install yourself.

This page used to repeat the commands here, cloning the default branch:

```bash
git clone https://github.com/Jason-Vaughan/TangleClaw.git   # ← don't: this takes main
```

which is exactly what the README warns against, because `main` carries partly-finished work on
authentication and network binding. Anyone who arrived here from the README's "How Do I…?" table
never saw that warning. Pointing at one copy is the fix; two copies is how they drifted apart.

The install script verifies prerequisites, generates launchd plists, loads the services, and runs a health check. On success, you'll see:

- **Landing page**: http://localhost:3102 on a new or HTTP-only install, or
  https://localhost:3102 when HTTPS is configured
- **Terminal (ttyd)**: http://localhost:3100

Both services auto-restart on crash via launchd KeepAlive.

### First Run

On first launch, TangleClaw creates `~/.tangleclaw/` with:

- `config.json` — global configuration (editable)
- `engines/` — engine profile JSON files
- `tangleclaw.db` — SQLite database for runtime state

Open http://localhost:3102 in your browser. On a fresh install, a **setup wizard** will guide you
through initial configuration:

1. **Welcome** — overview of what TangleClaw does
2. **Projects Directory** — set where your project folders live (defaults to `~/Documents/Projects`).
   If that folder does not exist yet — it does not on a fresh Mac — the wizard offers to create it.
   On macOS it also warns you when the path is under `~/Documents`, `~/Desktop` or `~/Downloads`,
   which the system keeps background services out of (see below).
3. **Detect Projects** — scans the directory for existing projects (a git branch, a
   `.tangleclaw/project.json`, or a common project manifest) and lets you select which to attach
4. **Engines** — shows which AI engines are detected and lets you pick a default. **Setup stops
   here when TangleClaw can confirm none are installed**: its job is running an AI coding CLI, so
   an install without one could not launch anything. It shows the install command for each engine
   and a **Check again** button — install one in a terminal, press it, and setup continues.

   If TangleClaw cannot *read* your shell's PATH it says so and offers **Continue anyway** instead,
   because "not installed" would then be a guess rather than a finding — and being wrong about it
   would lock you out of your own setup.
5. **Preferences** — delete protection password, idle chime toggle
6. **HTTPS** — generate or select a certificate, or keep local HTTP
7. **Admin Login** — the username and password you will sign in with (see below; this step is not always shown)
8. **Confirm** — summary of all selections, then "Complete Setup"

The wizard only appears once; subsequent launches go straight to the landing page.

#### The login step, and when it appears

TangleClaw puts a login in front of itself by default. There is **no default credential** — you set
one during setup, or setup does not finish. The gate is enforced by Caddy, which TangleClaw
configures for you at the end of setup.

The **Admin Login** step appears whenever this machine can actually run that gate. It is skipped —
deliberately, not as a convenience — in the cases where a password would be collected with nothing
to enforce it:

| Situation | What the wizard does |
|---|---|
| No Caddy config yet, or one TangleClaw generated | Asks for a login, then configures Caddy and puts it in force |
| A Caddy config you maintain, with exactly one login, and Caddy is the active ingress | Keeps your login. Asks for nothing |
| A Caddy config you maintain that TangleClaw must not touch (several logins, no login, or unreadable) | Asks for nothing, and finishes saying no login is in force |
| Caddy is not installed | Asks for nothing, and tells you the two commands that fix it |

When the login step is shown, **Skip is not offered** — skipping it would be a way past the gate.
Skip is available in the cases above where no credential is being collected.

#### What you see at the end

After *Complete Setup*, if TangleClaw is configuring the gate it restarts itself, so the wizard
waits and then tells you one of five things:

- **Your login is in force** — with the address to open and sign in at. Note this is **not** the
  address you started on: the gate answers on `https://<your-host>:8443` by default, and TangleClaw
  itself moves to plain HTTP behind it. Use the address on screen.
- **Started, but this page can't see the result** — the expected outcome when you ran setup from
  anything other than `http://localhost:3102`, because the restart closes the address this page was
  served from. Open the address it names: **if it asks for a username and password, your login is in
  force.** If it loads without asking, it is not.
- **Started, but it hasn't reported back** — TangleClaw is still reachable here and the gate setup
  has not said how it ended. Same check applies.
- **Applied, but the login could not be confirmed** — the gate was put in place, and TangleClaw
  then could not reach the gated address to check that it answers. Different from the one above:
  the setup *did* report back. Same check settles it — open the address it names and see whether
  it asks.
- **No login is in force** — said plainly, with what to run. TangleClaw is reachable from this
  machine only unless you have opted into a wider binding (see *Network Exposure* in Global
  Settings).

If nothing loads at all after a cutover, `node scripts/ingress-cutover.js --rollback` puts
TangleClaw back the way it was.

### PWA Installation (Mobile)

TangleClaw works as a Progressive Web App:

- **iPhone Safari**: Tap Share → "Add to Home Screen"
- **Android Chrome**: Tap the three-dot menu → "Add to Home screen"

This gives you a full-screen app experience with no browser chrome.

## The Landing Page

The landing page is your dashboard for managing projects and launching sessions.

### Header

The header shows the TangleClaw logo (served from `public/logo.png`, with app icons in `public/icons/`), version, and a collapsible system stats panel (CPU, Memory, Disk, Uptime). Tap the stats area to expand or collapse it.

### PortHub Lease Import Banner

If TangleClaw detects an existing PortHub installation with active leases that haven't been imported yet, a banner appears at the top of the landing page offering to import those leases into TangleClaw's built-in port registry. This is a one-time migration convenience — once imported, TangleClaw manages ports directly.

### Ports Panel

Below the system stats, there's a collapsible **Ports** panel. Tap it to see all active port leases grouped by project. Each lease shows:

- **Port number** — the assigned port (e.g., 3100)
- **Service** — what the port is used for (e.g., "ttyd", "server")
- **Type badge** — "permanent" for infrastructure ports, "TTL" for time-limited leases

TangleClaw manages port assignments directly in its SQLite database. Leases survive server restarts (unlike the old PortHub daemon). The panel auto-refreshes every 30 seconds.

TangleClaw also periodically scans the system for listening TCP ports using `lsof`. When you check a port's availability (via API or internally), TangleClaw will detect conflicts with ports bound by processes outside its registry — even if no lease exists for that port. This helps prevent "port already in use" errors when launching services.

### Global Rules

Below the ports panel, there's a collapsible **Global Rules** panel. These are markdown rules that apply to every project across all engines. When TangleClaw generates an engine config file (e.g., `CLAUDE.md`, `.codex.yaml`), global rules are included automatically.

- **Edit**: Expand the panel, modify the textarea, and tap **Save**
- **Revert**: restore it from git (`data/global-rules.md` is tracked). There is no Reset button: the old one called an endpoint that, since the canonical-source model (#240), returns the current content unchanged, so it looked like a revert and did nothing (#243)
- **API**: `GET /api/rules/global`, `PUT /api/rules/global`. `POST /api/rules/global/reset` still exists as a back-compat no-op since #240 — it returns the current content unchanged

Global rules live in one git-tracked file, `data/global-rules.md` in the TangleClaw repo (#240). Saving from the panel writes that file directly; there is no bundled default and no per-install copy under `~/.tangleclaw/`. A leftover `~/.tangleclaw/global-rules.md` from an older install is ignored — if its content differs, TangleClaw backs it up next to itself and logs a warning on startup so you can merge what you still want.

### Toolbar

- **Session count**: Shows how many active sessions are running. If TangleClaw could not reach the
  tmux server for some of them, it adds "· N unknown" rather than counting those as inactive — the
  count never asserts a number it could not establish
- **Filter**: Opens the search/filter panel
- **+ New**: Opens the create project drawer

### Project Cards

Projects are displayed as compact cards. Each card shows:

- **Name** — the project directory name
- **Version badge** — the project's current version (if available), shown as a subtle badge
- **Engine badge** — which AI engine is selected (e.g., "Claude Code")
- **Git info** — branch, dirty state, last commit age. A `?` after the branch name means the
  working tree could not be read, which is **not** the same as clean — hover or tap the badge for
  the reason
- **Session indicator** — a green breathing dot when a session is active, nothing when there is no
  session, and a `?` dot when TangleClaw could not reach tmux to find out. The three are
  deliberately distinct: an unreadable state is never drawn as an absent one
- **Unreadable badge** — a ⚠ marker when the project's own folder did not answer. Its git, engine
  and version details are missing rather than absent, and the badge carries the reason and, where
  there is one, the remedy
- **Peek icon** — an eye icon to quickly peek at session output without entering the session wrapper
- **Delete button** — a subtle "x" on the card (password required if configured)
- **Launch** — tap the card or launch button to enter the session

### Searching and Filtering

Use the search bar to filter projects by name. Tag pills appear below the search bar — tap a tag to filter projects with that tag.

### Creating a Project

Tap **+ New** to open the create project drawer:

1. **Name** — enter a project name (letters, numbers, hyphens, underscores only)
2. **Engine** — select an AI engine from the dropdown
3. **Tags** — optional tags for organization

The project is created in your configured `projectsDir` (default: `~/Documents/Projects`). TangleClaw scaffolds the project directory, registers ports with PortHub (if available), and generates the engine-specific config file. See the [Engine Guide](engine-guide.md) for details on custom engines.

### Deleting a Project

Tap the delete button on a project card. If a `deletePassword` is configured, you'll need to enter it. Deletion releases registered ports and removes the project from TangleClaw's database. The project directory itself is preserved on disk.

### Attaching Existing Projects

TangleClaw shows every directory in your `projectsDir` on the landing page — not just registered ones. Unregistered directories appear with a muted style and an **Attach** button.

If the list is ever *short* — the folder could not be read, or it holds more directories than one scan can check in time — the ROOT panel says so, gives the reason and the remedy, and the count changes from "total" to "listed". A short list is never presented silently as a complete one.

Tap **Attach** to register a directory as a TangleClaw project. This:
- Reads any existing `.tangleclaw/project.json` for engine settings
- Registers the project in the database
- Creates a `.tangleclaw/project.json` if one doesn't exist

You can also attach projects in bulk during the first-run setup wizard, or via the API: `POST /api/projects/attach { "name": "project-dir-name" }`.

### Auto-Detection of Existing Projects

During the setup wizard, TangleClaw scans your `projectsDir` for directories that have:

- A `.tangleclaw/project.json` file
- A git repository (one with a branch)
- A common project manifest — `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`,
  `Makefile`, `Gemfile`, `pom.xml`, `build.gradle`, `CMakeLists.txt`, `setup.py`,
  `composer.json` or `mix.exs`

These are pre-ticked for batch attachment during setup. Every other subdirectory is still listed,
just unticked — so you can attach something the markers do not recognise.

**macOS: if the scan reports that the directory did not respond.** `~/Documents`, `~/Desktop` and
`~/Downloads` are protected by macOS privacy controls (TCC). TangleClaw runs as a background
service, which has no way to ask you for access, so a read of a protected directory does not fail —
it simply never finishes. Either grant Full Disk Access to your `node` binary (System Settings →
Privacy & Security → Full Disk Access), or keep your projects somewhere outside those three
directories. The scan gives up after five seconds and tells you which it was, rather than waiting
forever.

**After you grant access, you may wait up to half a minute for the dashboard to notice.** The
project list stops re-reading a directory that has not answered — otherwise it would retry every
ten seconds forever, and each attempt leaves a stuck process behind. It tries again on its own,
starting half a minute after the last failure and backing off to at most five minutes if the
directory keeps failing. **You do not need to restart anything**; the list fills in by itself on
the next attempt that succeeds. The wizard's Scan and Create buttons are not affected — those
always read the directory for real, because you just asked them to.

## Sessions

Sessions are the core of TangleClaw — they're how you interact with AI engines on your projects.

### Launching a Session

Tap the **Launch** button on a project card. TangleClaw:

1. Generates a prime prompt from project state, active learnings, and last session summary
2. Creates a tmux session
3. Launches the selected AI engine inside it
4. Injects the prime prompt (if the engine supports it)
5. Redirects you to the session wrapper

### The Session Wrapper

The session wrapper is your interface to the running AI session.

#### Banner

The top banner shows:

- **Back link** — return to the landing page
- **Project name** and **version**
- **Status dot** — green (connected), red (disconnected), with a breathing animation
- **Engine badge** — which engine is running

#### Terminal Viewport

The terminal fills the main area, showing the ttyd-powered terminal where your AI engine is running. Interact with it directly — type commands, paste text, scroll output.

#### Command Bar

Below the terminal, the command bar lets you inject commands without touching the terminal:

- Type a command and tap **Send** (or press Enter)
- **Quick command pills** appear below the input — tap to inject common commands
- Engine-specific slash commands are included as pills (e.g., `/compact`, `/review` for Claude Code)
- Commands are sent to the tmux session via `send-keys`

#### Peek

Tap **Peek** to open a bottom drawer showing the last few lines of terminal output. This lets you check on progress without scrolling through the terminal. Tap refresh to update. The drawer's **Copy** button puts the whole peek text on your device's clipboard — on a phone, where the terminal itself can't be selected, this is the way to grab output (#438).

#### Copy

Tap **Copy** in the banner to put the last terminal selection on *your* device's clipboard (#438). A drag inside the terminal is copied by the engine's TUI on the TangleClaw host — it lands in the host's clipboard and in a tmux buffer, never on the phone or laptop you are viewing from. Desktop has the Option-drag gesture for a local copy (#431); touch devices have no Option key, so **Copy** reads that newest tmux buffer (`tmux show-buffer`) and hands it to the browser, then reports how many characters it copied. Nothing copied yet — or nothing since the tmux server started — shows "Nothing to copy yet" rather than an empty success. The buffer belongs to the tmux server, not to one session: it is the most recent copy from any TangleClaw session on the host, and TangleClaw's own command injections delete their delivery buffers so they never show up here. On an install upgraded from a version that did not delete them, the first press may return an older buffer (typically a switchboard nudge or command-bar send) until a fresh copy is made in the terminal — TangleClaw does not clear existing buffers, since nothing distinguishes an old delivery from something you copied.

#### Select

Tap **Select** to enable text selection in the terminal, and tap **Done** to leave it. Select mode adjusts tmux mouse mode so normal touch/click-drag gestures select text instead of reaching the terminal app (on desktop it turns mouse mode off; on touch devices it turns it on). It stays on until you tap Done — there is no auto-revert timer (#574; timer-driven UI reverts are banned by #98/#268) — and leaving select mode restores the mouse configuration you had before entering: an explicit per-session setting is set back, and a state inherited from the global config is restored by removing the session-level override entirely (#579), so a Select round-trip leaves no residue. If the page is reloaded or closed while Select mode is still on, the restore is replayed automatically the next time you open that session (UI-8W3D) — an interrupted Select can't permanently strand the terminal's mouse state. On touch devices you can also long-press to select without Select mode at all (a Copy pill appears on release).

#### Paste (touch devices)

On iPhone and other touch devices a **Paste** button appears in the session banner (#402) — iOS has no Cmd-V, and its native long-press Paste menu can't reach the terminal's hidden input, so this button is the paste path. Tap it and the clipboard is read directly (iOS shows its permission bubble the first time) and inserted into the terminal as a proper paste — multi-line text gets the same bracketed-paste framing a desktop Cmd-V would. When the clipboard can't be read directly (plain-HTTP setups have no clipboard API, or you decline the permission), a small **Paste into terminal** box opens instead: long-press the box, choose Paste from the iOS menu, and tap **Insert**. The button only appears on touch devices with a tmux-backed session — desktop keeps its normal Cmd-V.

#### Upload

Tap **Upload** to send a file into the project directory. A file picker opens where you can choose any file (up to 15 MB). For image files, a preview is shown before confirming. The file is base64-encoded and sent via `POST /api/upload`. On success, the upload path is displayed so you can reference it when talking to the AI assistant (e.g., "look at `uploads/screenshot.png`"). Uploaded files are stored in the project's working directory under a managed location.

#### Chime System

When enabled, TangleClaw plays an audio chime when the session stops working and is waiting for you.

It does not simply time silence. TangleClaw reads the pane for the engine's own signals — a turn in flight, a running agent fleet — and additionally requires the transcript to have stopped changing, across consecutive polls and for at least ten seconds. A session blocked on a permission prompt counts as waiting for you, and chimes — on Claude. On antigravity/Gemini CLI a dialog also hides that engine's own at-rest marker, so those sessions still read as working until the dialog clears; that is a limit of what the terminal shows, not a setting.

Two limits worth knowing:

- **A tool call that prints nothing looks exactly like a session waiting**, to this or any reader of the terminal. The chime can still ring early during a long silent step.
- **Engines with no captured idle signature** (anything outside Claude and antigravity/Gemini CLI) fall back to the older behaviour: silence for ten seconds. The session status reports `idleReason` beginning `staleness:` when that is what answered, so the fallback is visible rather than assumed.

- Uses Web Audio API for reliable mobile playback
- Toggle via the Settings modal
- Works on both iOS and Android

#### Settings

The settings modal lets you configure:

- **Chime toggle** — enable/disable idle chime
- **Poll interval** — how often to check session status (2s–30s)
- **Engine selector** — switch engine for next session
- **Mouse mode** — toggle tmux mouse mode on/off
- **Login** — change the password you sign in with (see below)

#### Changing your login

Global settings has a **Login** section for changing the password set during setup. It appears only
on an install where a login is actually in force — where none is, it says so and names the command
that puts one in place, rather than offering a change that would not take.

Two things to know before you use it:

- **Saving signs you out.** The login is enforced by Caddy, and a browser cannot be handed new
  credentials, so the next page you load asks for the new password. Have it to hand before saving.
- **The username cannot be changed here.** It names *which* login to re-hash rather than setting one,
  so changing it in this form would leave the gate on the old name. To change a username, or to
  recover a login you have lost entirely, run `node scripts/reset-admin.js` at a terminal on the
  machine — recovery deliberately requires physical access, because a reset that lives behind the
  gate cannot help someone the gate has locked out.

There is no "current password" field, and that is deliberate rather than an oversight: the tools
available here can hash a password but cannot verify one against a stored hash, and a field that
does not check anything is theatre. What authenticates the change is that Caddy already asked you
for the current password to let you reach this screen.

See the [Configuration Reference](configuration-reference.md) for all config fields and API endpoints.

#### Wrapping a Session

Tap **Wrap** to trigger the session wrap. This:

1. Executes the wrap pipeline's steps
2. Captures session output (summary, next steps, learnings)
3. Records the wrap in the database
4. Ends the session
5. Redirects to the landing page after a countdown

If a `deletePassword` is configured, you'll need to enter it to wrap.

**Choosing the version bump.** The wrap dialog has a **Version bump** selector: *Auto*, *Patch*, *Minor*, or *Major*. Auto (the default) derives the bump from your `CHANGELOG.md` `[Unreleased]` content — `### Added`/`### Changed` mean minor, `### Fixed`-only means patch, a `BREAKING` marker means major. Pick an explicit level when the CHANGELOG can't imply what you want — for example a release train where the bump belongs at promote time rather than at session end. Your choice is reapplied if the wrap blocks and you retry, and resets to Auto the next time you open the dialog.

**Did it actually ship?** A wrap that commits has not necessarily *released*. When the wrap opens a PR (see protected branches below), the version bump and CHANGELOG promotion only reach `main` once that PR merges — which happens after its checks pass, and never if a required check fails. The drawer says which of these is true:

- **Wrap shipped — PR merged** — the release landed.
- **Release pending checks** — the PR hasn't merged yet; it lands when its checks pass. A PR whose required check is still *running* shows this, not "blocked" — armed auto-merge will land it once the check goes green.
- **Release BLOCKED, did not ship** — a required check actually *failed*, or the branch has merge conflicts. **This is a failure**: the wrap's version bump is stranded on an unmerged branch. Fix the PR, then merge it.
- **Release not confirmed** — TangleClaw couldn't reach GitHub (no `gh`, not signed in). The outcome is genuinely unknown, not assumed good.

Use **Recheck release** in the drawer to re-query at any time — checks usually take longer than the wrap itself, so "pending" right after a wrap is normal, and Recheck flips it to "shipped" once the check passes and auto-merge lands.

**Steps that were skipped.** If any wrap steps skipped, the drawer shows *"Skipped N of M steps"* with the reason for each, so a wrap that quietly did nothing doesn't look the same as one that did everything.

**When a step insists a file changed.** The steps that write your `CHANGELOG.md` and `.tangleclaw/memories/learnings.md` now check that the file actually changed. If the AI reports done without editing it, the wrap stops and asks you to decide rather than reporting success. If there's genuinely nothing to record, tick **Skip & note** — the skip is recorded in the commit body. (Retry only helps if the AI never acted; a retry looks for a *new* change, so it will stop again on an edit that already landed — and any edit already on disk still gets committed.)

**Wrap commits and protected branches.** When a wrap fires while the project is checked out on `main`/`master`, the commit step auto-branches to `wrap/<timestamp>-<project>` and commits there — and then closes the loop automatically: it pushes the wrap branch, opens a PR back to the original branch, and arms GitHub auto-merge (`--auto --squash --delete-branch`; branch protection still gates). The commit row in the wrap drawer shows the outcome (e.g. `wrap PR auto-merge armed`). If any part fails — no `origin` remote, `gh` missing, auto-merge disabled on the repo — the wrap still completes and the drawer shows what to do; the checkout stays on the wrap branch so the dangling commit is visible. Opt out per project with `wrapAutoPrEnabled: false` in `<project>/.tangleclaw/project.json` if a project must never have automated pushes or PRs.

**One wrap at a time, and it survives your connection.** A wrap can run for several minutes (the AI writes changelog, learnings, and memory content mid-pipeline), and it runs entirely server-side — if your connection drops, your phone locks, or you reload the page, **the wrap keeps going**. Don't re-tap Wrap: the page automatically reattaches to the running wrap (you'll see the wrapping bar; the terminal shows the wrap happening) and opens the results drawer when it finishes. Triggering a wrap while one is already running is refused ("wrap already in progress") — that's the guard working, not an error to fight. Restarting TangleClaw while a wrap is running is likewise refused with a confirmation; forcing it kills the wrap mid-run (nothing is committed — the commit step runs last), and the session page will tell you a killed wrap is safe to retry.

#### Killing a Session

Tap **Kill** to forcefully terminate a session without wrapping. Use this when a session is stuck or you don't need wrap data. Password required if configured. Kill is also available from the project card on the landing page — look for the stop icon in the card row when a session is active.

### Session Switchboard (Medusa)

TangleClaw's switchboard lets sessions message **each other** — agent to agent — instead of routing every cross-project question through you.

**Turning it on.** In a project's settings, flip **Enable Medusa session comms** (default off). New sessions of that project then register a switchboard identity at launch; the two-head control in the session banner is the per-session view. Session end (wrap or kill) tears the listener down, so nothing lingers.

**The banner control.** The two facing heads carry listener state — off / connecting / listening / error — with an accessible label (never color alone), an unread badge for inbound mail, and heads that light on arrivals and successful sends. Tap ➤ to compose: the target picker is built from the live roster of other opted-in sessions, and the result is reported honestly — **delivered**, or **queued** when the recipient is offline, never a blanket "sent".

**What the agents themselves do.** Each opted-in session is primed at launch with its workspace id and the API to read mail, mark it handled, send, and list peers. Handled mail leaves the inbox and is acknowledged upstream, so nothing re-delivers after a restart. If a peer session restarted and its workspace id rotated, sends re-resolve against the live roster and retry automatically.

**Wake nudges.** When mail arrives for a session that is sitting idle, a wake monitor types a short nudge into its terminal telling it to check the inbox — but only when the pane is *provably* idle: a moving transcript, a running subagent fleet, or a half-typed line in the composer all block the nudge (your unsent draft is preserved, not submitted). A busy session is never interrupted; it simply finds its mail when it next checks.

**Nothing goes missing silently.** Every nudge outcome — delivered, failed, or skipped and why — lands in a delivery ledger. `GET /api/medusa/deliveries` answers the fleet question "whose newest mail was never announced," so an unannounced inbox and an empty one are distinguishable.

The **Project Master** participates too: its control bar mounts the same switchboard control on its own workspace id, with outbound messaging gated by the Master's access level.

### Session History

Each project maintains a session history showing:

- Start time and duration
- Engine used
- Session status (wrapped, killed, crashed)
- Wrap summary (if wrapped)

For OpenClaw remote sessions, see the [OpenClaw Setup Guide](openclaw-setup.md).

## Project Groups and Shared Documents

### Groups

Project groups let you relate projects that share infrastructure or documentation. Create groups from the landing page's Groups panel (collapsible section in the dashboard bar).

### Shared Directory (Auto-Discover)

Each group can have a `sharedDir` — a directory path containing shared `.md` files. On session launch, TangleClaw scans this directory and auto-registers any new markdown files as shared documents. Already-registered files are skipped.

To set up auto-discover:
1. Edit a group and enter the shared directory path
2. Click "Sync" to trigger immediate discovery
3. New `.md` files are registered with `injectIntoConfig: true` and `injectMode: reference`

File names become document names (e.g., `NETWORK.md` becomes "NETWORK").

You can also trigger sync via the API:
```
POST /api/groups/<group-id>/sync
```

### Shared Documents

Shared documents are markdown files registered to a group. When a project belongs to a group, injectable shared docs appear in the project's engine config at session launch.

### Document Locking

Before editing a shared document, lock it to prevent conflicts:
```
POST /api/shared-docs/<doc-id>/lock
{ "sessionId": <id>, "projectName": "my-project" }
```
Locks expire after 30 minutes and are auto-released when sessions wrap or are killed.

### Served Plan Documents

Every plan or design doc a session writes to `<project>/.tangleclaw/plans/<name>.md` (or the legacy `.claude/plans/`) is served by TangleClaw at a stable URL — `/plans/<projectId>/<name>.md` — rendered as a page that follows your device's light/dark theme, with tables and code scrolling sideways inside their own box rather than the whole page. It sits behind the same access gate as the dashboard (the Caddy login in caddy mode; loopback/tailnet reach in direct mode), so the link opens from your phone and from nowhere it shouldn't. This is the floor every engine gets: a Gemini, Codex or Antigravity session can hand back a link, not just a file path, and Claude Code may still publish its richer Artifacts on top.

- The link stays the same as the file changes; reload to read the latest.
- A plan moved to `plans/archive/` answers 404 with **Plan archived**, so a stale link says why it stopped working.
- A plan is addressed by its file name alone — a path, `..`, or a symlink pointing outside the plans directory is refused.
- Sessions discover the links with `GET /api/projects/<projectId>/plans` (numeric id or project name), which returns every plan with its URL on the host you reach TangleClaw on — never `localhost`, and `url: null` with a note when TangleClaw cannot tell which host that is. `tc capabilities` names the endpoint.

## Mobile Tips

### iPhone Safari

- Use PWA mode (Add to Home Screen) for the best experience
- The command bar appears above the keyboard when focused
- Touch targets are 44px minimum for comfortable tapping
- The dashboard works in portrait: below 600px the header pills, the toolbar (filters drop under the session count) and each card's action row wrap instead of overlapping or running off the screen edge
- Safe area insets are respected for notch/home indicator

### Android (Pixel Fold 9)

- Works in both folded and unfolded configurations
- Chrome PWA mode supported
- Scroll behavior is fixed (v2 bug resolved)

### Touch Patterns

- **Tap** — buttons, pills, cards
- **Swipe down** — pull to refresh on landing page
- **Drag** — peek drawer handle to resize
- **Long press** — not used (avoids conflicts with browser gestures)

## Troubleshooting

### TangleClaw Says Your Dashboard Is Exposed

If TangleClaw warns — on the dashboard, and in
`~/.tangleclaw/logs/tangleclaw.log` on every start — that it is reachable from
your whole network with no password, that warning is accurate and worth acting
on. The dashboard can open terminal sessions, so anyone who can reach the
machine can run commands as you.

This affects installs created before TangleClaw pinned its listener to
`127.0.0.1`. **Updating does not close it for you.** Closing it automatically
would take away the remote access you may be using right now, before there is a
password to put in its place — so TangleClaw keeps your binding as it was and
tells you instead. New installs are loopback-only from the start.

Confirm what you are actually bound to:

```bash
lsof -nP -iTCP:3102 -sTCP:LISTEN
```

`*:3102` means every interface. `127.0.0.1:3102` means loopback only — that is
the protected state, not a fault; do not "fix" it by widening it.

There are two ways to resolve it, and the first is better because it keeps
remote access:

1. **Set up the login gate** — a reverse proxy that puts TLS and a password in
   front of the dashboard, terminals, and APIs. See
   [deploy/INGRESS.md](../deploy/INGRESS.md). Once it is running, TangleClaw
   binds loopback automatically, because the gate is in front of it.
2. **Close the door entirely**, if you only ever use TangleClaw from the machine
   it runs on. In Settings → Network Exposure, turn *off* "Accept connections
   from the network", or set it directly:

```bash
# ~/.tangleclaw/config.json
"bindAllInterfaces": false
```

Either way, restart TangleClaw afterwards — the socket is bound once at startup,
so the change does not take effect until the process restarts.

**The terminal port is already closed.** Separately from the above, `ttyd` (port
3100) is pinned to `127.0.0.1` on every install, new or upgraded, and TangleClaw
re-pins it at startup if it finds it otherwise. Nothing addresses it directly —
TangleClaw proxies to it — so this costs you nothing and needs no action.

### Update Refuses to Run from the Current Branch

**Update now** deliberately refuses to move a development or recovery
branch. An error such as:

```text
Update not applied: refusing to update from "docs/example-recovery"
— checkout main (or a release tag) first
```

means the TangleClaw source checkout is on a branch that the self-updater will
not replace. This protects branch work; it does not mean the release is broken.

First find the TangleClaw source checkout, then inspect it before changing
branches:

```bash
cd /path/to/TangleClaw
git status --short --branch
git branch --show-current
```

Commit or stash any work reported by `git status`. If the tree is clean, return
to `main`, update it without creating a merge commit, and verify the result:

```bash
git checkout main
git fetch origin main --tags
git merge --ff-only origin/main
git status --short --branch
```

The final status should name `main` and report no modified, staged, or untracked
files. Retry **Update now**; it can then check out the advertised release
tag and restart TangleClaw.

On older 4.32-era checkouts, switching from a recovery branch to a stale local
`main` may reveal an untracked generated engine file such as `.codex.yaml`.
Current `main` ignores TangleClaw-generated engine configs, so the fast-forward
above should make the tree clean without deleting the generated file. If other
files remain, inspect and commit or stash them rather than bypassing the
updater's clean-tree guard.

### "Press to Reconnect" After an Interrupted Project Move

Moving the TangleClaw source directory while the server is running can unload
the `com.tangleclaw.server` LaunchAgent before the destination is ready. The
terminal helper may remain running, but the dashboard cannot reconnect because
the main server on port 3102 is stopped.

First, verify which copy is complete. Do not delete the original directory when
the destination is empty or only partially copied:

```bash
ls -la /path/to/original/TangleClaw
ls -la /path/to/destination/TangleClaw
plutil -p ~/Library/LaunchAgents/com.tangleclaw.server.plist
```

The plist's `WorkingDirectory` must point to a complete TangleClaw directory
containing `server.js`. If it still points to the intact original directory,
restore the unloaded service with:

```bash
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.tangleclaw.server.plist
launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server
```

If `bootstrap` reports that the service is already loaded, run only the
`kickstart` command. Confirm recovery before retrying the move:

```bash
launchctl print gui/$(id -u)/com.tangleclaw.server
curl -s http://localhost:3102/api/health | python3 -m json.tool
tail -20 ~/.tangleclaw/logs/tangleclaw.log
```

A healthy response reports `"status": "ok"` and the log reports that TangleClaw
is listening on port 3102. Refresh the dashboard once if its reconnect banner
remains stale.

Before completing a later move, update or reinstall the LaunchAgent so its
`WorkingDirectory` refers to the final, fully copied location. Keep the original
copy until the health check succeeds from that location.

### Dashboard Loads Blank — No Project List, Session Tabs Still Work

The page renders its chrome but no projects appear and nothing recovers, while
already-open session tabs keep working. The server is fine — it is the cached
dashboard shell in *this browser* that did not run. Every load that does boot
leaves a `Dashboard booted` line in `~/.tangleclaw/logs/tangleclaw.log` on the
server box; a `GET /` with no such line after it is the fault, seen from the
server side.

Follow [the runbook](runbooks/dashboard-blank.md) **before** reloading or
clearing anything: the browser-side evidence (console, Cache Storage, the
service worker's state) is gone the moment the condition clears, which it does
on its own. The runbook also says why bumping the service worker's
`CACHE_NAME` is not the fix.

### Dashboard Constantly Refreshes After Enabling HTTPS

Port 3102 serves either HTTP or HTTPS, not both. If HTTPS is enabled but the
browser opens `http://localhost:3102`, the server receives plain HTTP on its TLS
socket and returns an empty response. The dashboard can look as though it is
constantly refreshing while its requests retry.

First, open https://localhost:3102. If the browser warns about the certificate,
install/trust the mkcert root CA or accept the local certificate as appropriate.

To return a localhost-only installation to HTTP instead:

1. Set `"httpsEnabled": false` in `~/.tangleclaw/config.json`.
2. Restart the service:

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server
   ```

3. Verify the configured protocol in `~/.tangleclaw/logs/tangleclaw.log`, then
   open http://localhost:3102:

   ```bash
   tail -20 ~/.tangleclaw/logs/tangleclaw.log
   curl -s http://localhost:3102/api/health | python3 -m json.tool
   ```

Do not disable HTTPS for access from another machine; use HTTPS or the Caddy
ingress for non-localhost traffic.

### Server Won't Start

```bash
# Check if Node 22+ is available
node --version

# Check service status
launchctl list | grep tangleclaw

# View server logs
tail -50 ~/.tangleclaw/logs/tangleclaw.log

# Health check
curl -s http://localhost:3102/api/health | python3 -m json.tool
```

### Leftover `dir-scanner-child` Processes

TangleClaw reads your project folders in a small helper process rather than in the server, so
a folder that never responds cannot take the whole dashboard down with it. If a folder does
stop responding, that helper is killed — but a process stuck waiting on the operating system
cannot always be killed immediately, and those can pile up.

**This is a symptom, not the problem. Fix the folder and the pile-up stops.**

```bash
# How many are there? Two is normal — one for the dashboard, one for the setup wizard.
pgrep -fl dir-scanner-child

# Which folder is not responding, and how often it has failed
grep -E "did not answer|did not exit after SIGKILL" ~/.tangleclaw/logs/tangleclaw.log | tail -20
```

The fix is whatever the log names: usually granting Full Disk Access to your `node` binary
(System Settings → Privacy & Security → Full Disk Access), or moving your projects folder
outside `~/Documents`, `~/Desktop` and `~/Downloads`. While a folder stays unreadable,
TangleClaw backs off and retries at most once every 30 seconds, widening to 5 minutes — so
the pile-up is slow, not runaway.

To clear the ones already there, restart the server. Nothing else releases them:

```bash
launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server
```

### Terminal Not Connecting

```bash
# Check ttyd is running
launchctl list | grep ttyd

# View ttyd logs (ttyd has no app-level log; check launchd output if needed)
launchctl list | grep ttyd

# Test ttyd directly
curl -s http://localhost:3100
```

### Session Won't Launch

- Verify the selected engine is installed: check the engine badge on the landing page (shows "available" or "not found")
- Check tmux is running: `tmux ls`
- Check server logs for error details

### Chime Not Working on Mobile

- Tap anywhere on the page first — browsers require user interaction before playing audio
- Check the chime toggle in session settings
- Verify your device isn't in silent mode (iOS)

### A Project Script Cannot Reach Calendar, Contacts or a Protected Folder

A script run from inside a session cannot obtain a macOS privacy (TCC) grant: the session is a
launchd chain (`ttyd` → `tmux` → engine) whose responsible process is `ttyd`: a grant would
attach to that shared binary for every session of every project, and a grant keyed to its path
is dropped on its next upgrade — the same mechanism as the Full Disk Access hang above. The supported pattern is a project-owned
LaunchAgent that runs the script as its own process, verified with `launchctl kickstart` and the
job's own log. [macOS automations that need a privacy grant](macos-tcc-automations.md) walks
through it.

Because such a plist carries the project's absolute path, **renaming a project** in the Settings
modal reports every LaunchAgent that still names the old path in a banner on the dashboard (it
stays until dismissed). TangleClaw does not edit the plists; the page above shows the
edit-then-reload sequence.

### Resetting TangleClaw

To reset all configuration and state:

```bash
rm -rf ~/.tangleclaw
launchctl kill SIGTERM gui/$(id -u)/com.tangleclaw.server
```

TangleClaw will recreate the default config on next start.
