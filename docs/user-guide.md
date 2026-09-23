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
7. **Admin Login** — the username and password you will sign in with, or the choice to finish without one (see below; this step is not always shown)
8. **Confirm** — summary of all selections, then "Complete Setup"

The wizard only appears once; subsequent launches go straight to the landing page.

#### The login step, and when it appears

TangleClaw puts a login in front of itself by default. There is **no default credential**. The login
is TangleClaw's own account, enforced by TangleClaw on every page, terminal and API, so it works with
or without Caddy; where it can, setup also puts Caddy in front for remote access.

The **Admin Login** step appears whenever setup needs a login — which is almost always:

| Situation | What the wizard does |
|---|---|
| No Caddy config yet, or one TangleClaw generated | Asks for a login, then configures Caddy in front |
| Caddy is not installed | Asks for a login; it is in force, and the install stays reachable from this machine only |
| A Caddy config you maintain that TangleClaw must not touch (several logins, no login, or unreadable) | Asks for a login, and leaves that config alone |
| A Caddy config you maintain, with exactly one login, and Caddy is the active ingress | Keeps that login. Asks for nothing |
| A login is already set up (an account created at a terminal beforehand) | Asks for nothing |

**Finish without a login.** Under the login form, the step offers to finish with no login, and says
what that means: **anyone who can reach this address is in**, including the terminals. TangleClaw
records the choice. It is offered only while TangleClaw cannot be reached from other machines; where it
could be (listening on every interface, or a Caddy config that serves it beyond this machine), the
step says so instead of offering it. You can add a login later from global settings (see *Adding a
login later*, below).

**Skip** finishes setup only where a login is already in place; everywhere else it is hidden, and
choosing no login is done on the login step, not by skipping it.

#### What you see at the end

After *Complete Setup*, if setup created your account, the wizard first shows its **recovery codes**
— once, with a *Copy codes* button. Save them somewhere apart from this device, then press *I have
saved these codes*. Nothing moves on until you do.

If TangleClaw is then configuring the gate it restarts itself, so the wizard waits and then tells you
one of six things:

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
- **Caddy was not put in front of TangleClaw** — the Caddy step failed, but your login is in force:
  TangleClaw still asks for it on every page, at the address you are on. It names the command that
  puts Caddy in front.
- **No login is in force** — said plainly, with what to run. TangleClaw is reachable from this
  machine only unless you have opted into a wider binding (see *Network Exposure* in Global
  Settings). This is also what you see after choosing to finish without a login.

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

### System Health Panel

Directly under the header, above the project list, TangleClaw shows a **System health** panel
whenever something machine-wide needs a hand. It is hidden when there is nothing to say — a
dashboard with no problems has no health panel. Each row names one condition, what was measured,
and the one-line fix (with a Copy button, since copying out of a phone terminal is unreliable):

| Condition | What fired it | Fix |
|---|---|---|
| **Terminal (ttyd) PTY leak** | The macOS PTY pool is nearly full, or ttyd has accumulated leaked `tmux attach` clients — the cause of terminals that stop opening | `launchctl kickstart -k gui/$(id -u)/com.tangleclaw.ttyd` |
| **Full Disk Access missing** | A read of `~/Documents` never answered — what a protected folder does when the `node` TangleClaw runs has no Full Disk Access | Grant Full Disk Access to that `node`, restart the server; or keep projects outside `~/Documents`, `~/Desktop`, `~/Downloads` |
| **Server running old code** | The running process is older than the checkout on disk and the commits in between change code it loads. Commits that only touch records (docs, tests, plans) leave it clear with "no restart needed"; when the change cannot be classified it stays fired and says "restart impact unknown". On this page the stale-server banner already shows this with a Restart button, so the panel leaves it to the banner | Restart TangleClaw |
| **Medusa Bridge reachable** | One or more sessions have Medusa enabled but the Bridge is not usable — nothing on either port, only one of its two transports answering, or the Bridge itself reporting `degraded`. Silent when no session has Medusa on, since no Bridge is required then | `curl -sS http://localhost:3009/health`, then start or install the Bridge (see `docs/configuration-reference.md` for pointing TangleClaw at a non-default port) |

A row that begins **Could not check** means the measurement itself failed (ttyd not running under
launchd, `~/Documents` absent, git unreadable) and says why. That is deliberately not hidden: a
check that could not run has not said the machine is healthy. The same verdicts are available
as JSON from `GET /api/system/health`, each condition in one of three states — `fired`, `clear`,
or `unknown` with a reason.

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
  session, and a `?` dot when TangleClaw could not reach tmux to find out. While a session wrap is
  running the dot becomes a spinning pinwheel; if that wrap stops reporting, the pinwheel turns
  amber and freezes, and the card's detail row names the step it stalled on. Every one of these is
  deliberately distinct: an unreadable state is never drawn as an absent one, and a wrap that
  stalled is never drawn as one that finished
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

You can also attach projects in bulk during the first-run setup wizard, or via the API: `POST /api/projects/attach { "name": "project-dir-name" }`. Attaching is the operator's: a call from a session's pane or a plain script gets `403 OPERATOR_ONLY`. Use the dashboard, or send it as the signed-in operator.

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
- **Engine badge** — which engine is running; its colour follows the engine's published status (green operational, amber degraded, red outage)
- **Group pill** — the project group this project belongs to; in two or more groups, one pill counts them ("3 groups") and its popover lists each group with its members
- **Your name** — who is signed in to TangleClaw; click it for **Sign out**. On a phone the pill is the 👤 icon alone. Not shown on an install with no login

Every pill follows one contract: **hover** shows what kind of thing it is (*Project version*, *Session status*, *AI engine*, *Project group*, *Signed in to TangleClaw*), and **click** shows what it currently says — the engine's status message, the session's connection state, a group's member projects, or who is signed in with a Sign out button. On a phone there is no hover; the click popover repeats the label, so nothing is lost.

#### Terminal Viewport

The terminal fills the main area, showing the ttyd-powered terminal where your AI engine is running. Interact with it directly — type commands, paste text, scroll output.

#### Command Bar

Open it from the banner's **⋯** menu → **Command bar** (the ⋯ button stays highlighted while the bar is open). The command bar lets you inject commands without touching the terminal:

- Type a command and tap **Send** (or press Enter)
- **Quick command pills** appear below the input — tap to inject common commands
- Engine-specific slash commands are included as pills (e.g., `/compact`, `/review` for Claude Code)
- Commands are sent to the tmux session via `send-keys`

#### Peek

Tap **⋯** → **Peek** in the session banner (on the dashboard, the eye icon on a project card) to open a bottom drawer showing the last few lines of terminal output. This lets you check on progress without scrolling through the terminal. Tap refresh to update. The drawer's **Copy** button puts the whole peek text on your device's clipboard — on a phone, where the terminal itself can't be selected, this is the way to grab output (#438).

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
- Toggle with the bell in the session banner — one tap, lit while the chime is on
- Global Settings carries a **Global chime mute** that silences every session regardless
- Works on both iOS and Android

#### Settings

The settings modal lets you configure:

- **Poll interval** — how often to check session status (2s–30s)
- **Engine selector** — switch engine for next session
- **Mouse mode** — toggle tmux mouse mode on/off
- **Account** — who is signed in, and **Sign out** (see below)

#### Changing your login

**The password you sign in to TangleClaw with** belongs to your TangleClaw account. Change it in
global settings → **Your account**: enter the current password and a new one (at least 12 characters,
not a common password, not containing your username). This browser stays signed in; every other
browser signed in to your account is signed out. Your recovery codes keep working.

Forgotten the current password? Set a new one with a recovery code from the sign-in page, or at a
terminal on the machine with `node scripts/reset-admin.js --store --user <name>` (see
[Getting back into TangleClaw](recovery.md)). Either one signs out every browser on the account.

#### Adding a login later

On an install with no login — you chose to finish setup without one, or it predates the login —
global settings → **Your account** says no one is signed in and offers **Add a login**. The first press
explains what happens; the second turns the login on and takes you to the sign-in page, where you
create your account (and are shown its recovery codes) or, if an account was already made at a
terminal, sign in with it. From then on every page asks for a password. Turning the login back off is
not offered from settings.

It is refused where the sign-in page could not let you in: every account on the install is disabled,
or the install once had an account that is now missing and you are not on the machine itself. Each
refusal names the terminal command that fixes it.

#### Signing out

**Sign out**, beside your name in the dashboard header (and under **Account** in a session page's
settings), ends this browser's session and goes to the sign-in page. Global settings → **Your account**
→ **Sign out everywhere** ends every session your account holds, this one included — use it after
losing a device or signing in on a machine you do not control.

**Caddy's password** — the browser pop-up that asks before any page loads — exists only on an install
where Caddy's `basic_auth` still stands in front of TangleClaw: before the first account exists, or
during a fallback. Global settings has a **Caddy password** section for changing it. It appears only
where that password is actually in force; where it is not, it says so and names the account routes
above.

Two things to know before you use it:

- **Saving signs you out of Caddy.** A browser cannot be handed new credentials, so the next page you
  load asks for the new password. Have it to hand before saving.
- **The username cannot be changed here.** It names *which* login to re-hash rather than setting one,
  so changing it in this form would leave the gate on the old name. To change a username, or to
  recover a login you have lost entirely, run `node scripts/reset-admin.js` at a terminal on the
  machine — a reset that lives behind the gate cannot help someone the gate has locked out.

There is no "current password" field, and that is deliberate rather than an oversight: the tools
available here can hash a password but cannot verify one against a stored hash, and a field that
does not check anything is theatre. What authenticates the change is that Caddy already asked you
for the current password to let you reach this screen.

#### Recovery codes

If you forget the password you sign in to TangleClaw with, a **recovery code** sets a new one from the
sign-in page — no terminal needed. Follow **Forgot your password? Use a recovery code**, enter one
code and a new password, and you are signed in.

- **You get a set of eight when you create your account.** They are shown once. Save them somewhere
  safe and apart from the device you sign in on — a password manager or printed paper.
- **Each code works once.** Using one signs out every other browser on that account, and the
  dashboard then shows a notice saying a code was used, when, and from where. Choose **That was me**
  to clear it. If it was not you, whoever used the code chose your password: set one only you know
  with another code, or with `node scripts/reset-admin.js --store --user <name>` on the machine, and
  generate new codes straight away.
- **Settings → Recovery codes** shows how many you have left and generates a new set. Generating asks
  for your current password, and the old set stops working at once.
- Accounts created at a terminal or by the setup wizard start with no codes — generate them in
  Settings.
- A code cannot turn a disabled account back on, and it cannot fix a broken login gate. For those,
  and if you lose your codes, see [Getting back into TangleClaw](recovery.md). Resetting an account at
  the terminal (`node scripts/reset-admin.js --store --user <name>`) deletes its codes; generate a new
  set once signed in.

See the [Configuration Reference](configuration-reference.md) for all config fields and API endpoints.

#### Wrapping a Session

Tap **Wrap** to trigger the session wrap. This:

1. Executes the wrap pipeline's steps
2. Captures session output (summary, next steps, learnings)
3. Records the wrap in the database
4. Ends the session
5. Redirects to the landing page after a countdown

If a `deletePassword` is configured, you'll need to enter it to wrap.

**Watching it run.** As soon as the pipeline starts, a panel opens under the **Wrap** button with every step listed and paints each one as it happens — *Running* while a step is in flight, then *Done*, *Skipped*, or *Blocked* with the step's own output — and its banner says which step of how many the wrap is on. The panel does not dim the page, so the terminal stays visible and usable beside it; on a phone it is a sheet over the bottom of the screen. Close it with **×**, Escape or the Wrap button whenever you want the whole terminal: the wrap keeps running, and the Wrap button itself shows the progress, for example **Wrapping 4/12 · 1:42** (the current step, the step count, and how long that step has run). A step still running after two minutes turns the button amber with a ⚠, and its row says *Taking long — check the terminal*. Click the Wrap button to open the panel again. Nothing is decidable until the run ends, so Retry and Done appear only with the final report. If the live feed drops for good, the banner says *live progress unavailable* and the report still arrives, exactly as it would without the feed.

**Keeping the session running.** A wrap that completes ends the session unless it is told to keep it. The wrap dialog's **Keep the session running** box says so for one wrap. The project's **Keep the session running after a wrap** setting (settings modal) is what a wrap inherits when whoever started it did not say, such as another session, the Project Manager or a script. The dialog opens pre-ticked from that setting, and unticking it ends the session for that wrap. From its first moment the panel says what the run will do *if it completes*: "If this wrap completes, it will end the session (project setting)". A wrap that stops, fails or is cancelled always leaves the session running.

**Hiding versus cancelling.** While a wrap runs, **Hide** only closes the panel. The wrap keeps going, and the **Wrap** button reopens it. **Cancel wrap** stops it at the next step boundary. The step already running finishes first, and the panel names it. You can cancel only until the commit step starts. From then on the wrap may already have branched, committed, pushed or opened a PR, so Cancel gives way to "Past the point of cancellation; the wrap continues", naming the step it is on. A cancelled wrap makes no commit, branch, push, PR or auto-merge, and the session stays running. It does **not** undo the steps that already ran, so uncommitted edits or local state they wrote may remain. The report lists those steps.

**New files wait for your answer.** A wrap commits the session's edits to files the project already tracks without asking. A file new to the repository is different, because a scratch script, a query dump and a real new module look the same to a wrap. A new file the session created and never committed appears in the files row as "new to the repository and never committed", and goes into the wrap only if you choose **Include**. **Leave** keeps it on disk, uncommitted. A new file the session staged with `git add` is asked about too, because staging is not a decision to publish. Files a wrap step writes itself, such as the changelog promotion, are not asked about, and neither are the files TangleClaw writes into every project: `.tangleclaw/project.json` and the engine's config file. The wrap commit and its PR list every file they carry beyond the wrap's own: the session's files, and separately the ones you included.

**A draft at the prompt is kept, not lost.** When TangleClaw types into a session (a switchboard nudge, a command-bar send, a wrap prompt), it first clears whatever is typed but not sent, because the paste would otherwise be submitted joined to it. For Claude Code, Codex and Antigravity, a draft it finds there is saved first to a private file under `~/.tangleclaw/drafts/`, one per session attempt, holding the last 20 and deleted 24 hours after the session ends. The log records only a reference to the saved draft (`draftRef`) and its size, never the text. For an engine TangleClaw cannot read the prompt of, such as Aider or OpenClaw, the prompt is still cleared, and the log says the draft could not be captured.

**Wrapping a Prawduct project from another engine.** Prawduct runs only inside Claude Code. When a project that is onboarded to Prawduct is wrapped from a Codex, Aider, Antigravity or other non-Claude session, the wrap is a checkpoint. It commits the session's work and writes the handoff. When the wrap runs on the base branch, it also pushes a wrap branch and opens its PR, as any wrap does. It does not do three things only Prawduct can authorize: it does not check Prawduct's gates (the preflight row reads **Unavailable** and names the engine), it does not cut a release, and it does not merge. Auto-merge is not armed, and PRs you chose to merge are listed rather than merged. It also leaves the project's `.prawduct/` files out of the commit, and the files row says how many. From its first moment the panel says "It will not merge or release", and the finished banner reads **Wrap checkpointed — merge and release withheld**. The handoff records that the gates were not run, so it is marked degraded. The next Claude session on the project is told to run `/prawduct:doctor` (never `/prawduct:onboard`) before any Prawduct work. Nothing merges the checkpoint's PR or cuts its release automatically afterwards. The PR stays open without auto-merge, and any PR merges you chose in that wrap are not carried forward, so merge them, and cut the release, from a Claude session.

**Choosing the version bump.** The wrap dialog has a **Version bump** selector: *Auto*, *Patch*, *Minor*, or *Major*. Auto (the default) derives the bump from your `CHANGELOG.md` `[Unreleased]` content — `### Added`/`### Changed` mean minor, `### Fixed`-only means patch, a `BREAKING` marker means major. Pick an explicit level when the CHANGELOG can't imply what you want — for example a release train where the bump belongs at promote time rather than at session end. Your choice is reapplied if the wrap blocks and you retry, and resets to Auto the next time you open the dialog.

**Did it actually ship?** A wrap that commits has not necessarily *released*. When the wrap opens a PR (see protected branches below), the version bump and CHANGELOG promotion only reach `main` once that PR merges — which happens after its checks pass, and never if a required check fails. The drawer says which of these is true:

- **Wrap shipped — PR merged** — the release landed.
- **Release pending checks** — the PR hasn't merged yet; it lands when its checks pass. A PR whose required check is still *running* shows this, not "blocked" — armed auto-merge will land it once the check goes green.
- **Release BLOCKED, did not ship** — a required check actually *failed*, or the branch has merge conflicts. **This is a failure**: the wrap's version bump is stranded on an unmerged branch. Fix the PR, then merge it.
- **Release not confirmed** — TangleClaw couldn't reach GitHub (no `gh`, not signed in). The outcome is genuinely unknown, not assumed good.

Use **Recheck release** in the drawer to re-query at any time — checks usually take longer than the wrap itself, so "pending" right after a wrap is normal, and Recheck flips it to "shipped" once the check passes and auto-merge lands.

**The governance preflight.** In a project that uses [prawduct](https://github.com/brookstalley/prawduct), the first step of every wrap asks prawduct for the verdict its Stop hook would give at session end — *before* any later step writes to a file. That block used to arrive halfway down the pipeline, after the changelog and version bump had already been written, leaving a half-applied wrap to sort out. **It is advisory by default:** an unmet gate is shown with prawduct's own block text and the wrap goes on, finishing as *completed with warnings*. Nothing needs a retry — the wrap's commit landed. To make an unmet gate stop the wrap instead, set `wrapStepOverrides.preflight.blocker` to `true` in the project's `.tangleclaw/project.json`; the wrap then halts at the door with your files untouched. A project with no `.prawduct/` directory skips the step without running anything.

If TangleClaw can't find prawduct's hook, or the probe is killed or refuses to run, the step reports a **skip that says the gates were not measured** — never a clean verdict for a check that never happened.

When a preflight set to block does stop the wrap, its row offers three ways on: **Ask the session to satisfy this** sends prawduct's block text to the session (see *Handing a fix to the session* below); **Copy block text** copies it for you to act on; and **Wrap anyway** retries past the gate. Wrap anyway holds for the rest of that wrap, is recorded in the commit body as the gates being *passed over*, and never reports them as clear. TangleClaw does not write prawduct's waiver file for you.

**Steps that were skipped.** If any wrap steps skipped, the drawer shows *"Skipped N of M steps"* with the reason for each, so a wrap that quietly did nothing doesn't look the same as one that did everything.

**Handing a fix to the session.** A blocked content step (changelog, learnings, memory) or a blocking preflight has an **Ask the session to fix this** button under *How to fix this*. It sends the fix to the session that ran the wrap and watches the terminal for the session to say it has finished. The row reads *Fixing in the session · 0:42* meanwhile, and so does the Wrap button (*Fixing · 0:42*), so you can close the panel and watch the terminal. When the session prints its completion line, the row says it finished and Retry lights up as **Ready: Retry** — read the session's reply first, since it may have decided the step needs a *Skip & note* rather than an entry. If the terminal goes quiet for a minute without that line, the row says the session **may be waiting on you** (and the Wrap button reads *Check terminal*): a session often stops to ask a question. TangleClaw keeps watching, so when you answer and the session finishes, Retry still lights up. If the session keeps working for five minutes without the line, the row says so and the button lets you send the fix again. Retry always works; the light is only a cue.

**When a step insists a file changed.** The steps that write your `CHANGELOG.md` and `.tangleclaw/memories/learnings.md` now check that the file actually changed. If the AI reports done without editing it, the wrap stops and asks you to decide rather than reporting success. If there's genuinely nothing to record, tick **Skip & note** — the skip is recorded in the commit body. (Retry only helps if the AI never acted; a retry looks for a *new* change, so it will stop again on an edit that already landed — and any edit already on disk still gets committed.)

**Wrap commits and protected branches.** When a wrap fires while the project is checked out on `main`/`master`, the commit step auto-branches to `wrap/<timestamp>-<project>` and commits there — and then closes the loop automatically: it pushes the wrap branch, opens a PR back to the original branch, and arms GitHub auto-merge (`--auto --squash --delete-branch`; branch protection still gates). The commit row in the wrap drawer shows the outcome (e.g. `wrap PR auto-merge armed`). If any part fails — no `origin` remote, `gh` missing, auto-merge disabled on the repo — the wrap still completes and the drawer shows what to do; the checkout stays on the wrap branch so the dangling commit is visible. Opt out per project with `wrapAutoPrEnabled: false` in `<project>/.tangleclaw/project.json` if a project must never have automated pushes or PRs.

**Stranded wraps.** A wrap branch that reached the remote but never got a pull request is *stranded*: its version bump, CHANGELOG promotion and index files are on the remote and haven't reached your base branch. TangleClaw records each one, with the remote, the branch and the wrap commit, and every new session is told about them at start. When there are none, the session is told that in one line. The list for a project is at `GET /api/projects/<id or name>/stranded-wraps`. Once you've dealt with one, acknowledge it with `POST /api/projects/<id or name>/stranded-wraps/ack` and `{"branch": "…", "headSha": "…"}`, using the full commit SHA shown in the list. That call, like the check and open-PR calls, is answered to the operator or to the project's own session, which sends its binding (`x-tangleclaw-project-id`, `x-tangleclaw-launch-id`); a session bound to another project gets `403 OTHER_PROJECT`. The acknowledgement records who you're signed in as and when, and it covers that commit only: if the same branch is stranded again at a new commit, it's listed again. Wraps stranded before this record existed are listed as older records with no commit SHA; acknowledge those with `"headSha": null`. Older records are shown but never counted as blocking (`counts.blocking`).

**Checking against GitHub.** After each launch, TangleClaw asks GitHub about the project's stranded wraps and its `wrap/*` branches, without holding up the launch. A stranded wrap whose branch has since merged, been deleted, or has an open pull request with every check passed is cleared: it leaves the list and stops holding launches. The check also shows two things that never hold anything up: **✕ N red CI** for a wrap pull request with failing checks, and **N no PR** for a `wrap/*` branch on GitHub with no pull request that this machine never recorded (another machine's wrap, for example). The card's detail panel has a **GitHub** row saying when it last checked and what it found, with a **Check now** button. If the check can't run (`gh` isn't installed or signed in, or GitHub can't be reached), nothing is cleared, the card shows **GitHub ?** with the time and reason, and anything shown from an earlier check says when that check was. A project with no `origin`, or one not hosted on github.com, isn't checked and shows no GitHub badge; if it has stranded wraps, the GitHub row says why it can't be checked. The check runs `gh` on the server as the account signed in there.

A stranded wrap nobody has acknowledged holds things up:

- **Launching** the project shows the stranded wraps and one button, **Acknowledge and launch**, which records the acknowledgements and starts the session in one step. Cancel leaves everything as it was. Launches through the API get the same refusal (`409 STRANDED_WRAPS`); see the API reference for the resend.
- **Wrapping** lists them in the wrap dialog, and **Wrap** stays disabled until you tick **Wrap anyway; these stay flagged**. Wrapping anyway doesn't acknowledge them, so they still hold the next launch. If a Retry is refused because a new one appeared, the drawer lists them with the same box.
- **The project card** shows an amber **⚠ N stranded** badge with the number that would hold a launch, and the card's detail panel lists them.

Older records never hold anything up. The Project Master is never held up by a project's stranded wraps.

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

**Why hasn't a peer picked up?** A sending session can ask: `GET /api/sessions/<project>/medusa/peers/<workspace-id>` (or `tc message status <workspace-id>` from its pane) returns the wake monitor's latest verdict on that peer as a reason code with a plain-language `meaning` — never anything from the peer's screen — with when it was first and last observed. The codes a sender most often sees: `pane-no-prompt` (a dialog, menu or scrolled pane is up; the nudge waits for the prompt to return), `pane-composer-has-input` (someone is typing in its input box), `pane-turn-in-flight` / `pane-writing` (it is working), `wake-not-opted-in` (nothing will nudge it), `no-mail` (it has nothing unread), `nudged` (it was told and has not handled the mail yet), `not-observed` (the monitor has not looked yet), and `not-running` for a Project Master the monitor last found stopped. A peer that is not a TangleClaw session on this host answers `local: false` — its screen is not visible from here, so no verdict is guessed. The read is gated exactly like the roster. Ledger rows written before the `pane-no-prompt` / `pane-composer-has-input` split carry the older `pane-no-bare-prompt`, which means either of the two.

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

A session in a project that belongs to the group can also trigger sync via the API, sending its
project binding (see "Who may change shared documents" below):
```
POST /api/groups/<group-id>/sync
```

### Shared Documents

Shared documents are markdown files registered to a group. When a project belongs to a group, injectable shared docs appear in the project's engine config at session launch.

### Document Locking

Before editing a shared document's contents, lock it to prevent conflicts:
```
POST /api/shared-docs/<doc-id>/lock
x-tangleclaw-project-id: $TANGLECLAW_PROJECT_ID
x-tangleclaw-launch-id: $TANGLECLAW_LAUNCH_ID
{ "sessionId": <id>, "projectName": "my-project" }
```
Locks expire after 30 minutes and are auto-released when sessions wrap or are killed.

### Who may change shared documents

A session sends its project binding (the two headers above, both exported into every pane) on
every groups and shared-docs request, and is answered only for the groups its project belongs to;
another group's documents answer `404`. Within its own groups a session can register a document,
lock and unlock one, notify its readers, and sync the shared directory.

Changing a document's registration (its file path, name or injection settings), deleting one, and
creating, changing or deleting a group or its members are yours alone, from the dashboard. A session
that tries gets `403 OPERATOR_ONLY`, because a document's file path decides what is injected into
every member project's engine config. The Project Master reads every group and changes nothing.

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

- **Tap** — buttons, pills, cards. In the terminal, a tap focuses it and brings up the keyboard; a tap on a web address (`http` or `https`) printed in the terminal opens it in a new tab instead, and the keyboard stays down (#1572).
- **Swipe down** — pull to refresh on landing page
- **Drag** — peek drawer handle to resize; one finger in the terminal scrolls it (#443)
- **Long press** — in the terminal, starts a selection; drag to extend it and lift to get a Copy pill (#445). See "Select" above.
- **Keyboard** — while the soft keyboard is up, the page shrinks to what is left visible so the terminal's prompt line stays above it, in the session view and in both Master terminals; dismissing the keyboard restores the layout (#1570).

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

### Update Blocked by Local Changes

**Update now** never moves a checkout that has uncommitted changes someone may
have written. When the source checkout is dirty, the update stops and lists the
files in the way.

It offers to discard files for you in only one case: every file on the list is
one TangleClaw can prove is its own change. Only two files can qualify, and
each needs its proof:

- `CLAUDE.md`, when your copy matches the committed one everywhere outside
  TangleClaw's own marked section.
- `.claude/settings.json`, when the whole change is TangleClaw removing hook
  entries an older version left there.

Discarding restores the committed copy. The updater never deletes a file.

Everything else stays as real work, and you have to commit or stash it
yourself. That includes everything under `.tangleclaw/`: plans, priming
prompts and memories are content someone wrote. Commit them in the TangleClaw
source checkout, then retry **Update now**.

### Your Global Rules Edits Across an Update

Edits you make in **Global Rules** on the dashboard are kept when you update,
even when the new release changes the same file. The update merges your edits
into the release's version, and it saves a copy of your file from before the
update in `~/.tangleclaw/backups/`. It tells you where that copy is before the
restart.

When your edits and the release change the same lines, the update stops before
it changes anything, and the dialog tells you what to do: open Global Rules,
copy your additions somewhere safe, remove them, update, then add them back.

The same dialog lists anything else a release would run into, each with what
to do about it:

- a file marked in git so its local changes are hidden (skip-worktree or
  assume-unchanged) that the release changes;
- a file that is not part of the install, even an ignored one, at a path the
  release adds;
- a backup that could not be saved.

In each case nothing was changed. When some other file blocks an update, the
dialog also lists your edited Global Rules as detected and kept; you do not need
to commit them.

If an update ever fails partway and TangleClaw cannot verify that it put the
install back, the dialog says manual recovery is required. It names the step
that failed and the backup copies, and it shows what it could check: the commit
and branch the install is on now, and whether your file and its git flags match
what they were. Do not update or restart until someone has looked at it.

You no longer need to mark `data/global-rules.md` as skip-worktree to keep your
rules through an update. An install that already has that mark keeps it.

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

### The Dashboard Shows a System Health Panel

The panel (see [System Health Panel](#system-health-panel)) only appears when a known recurring
condition fired or could not be measured. Each row carries its own fix; the background for each:

- **Terminal (ttyd) PTY leak** — on macOS, `tmux attach` clients spawned by ttyd can wedge in the
  kernel's exiting state and hold `/dev/ttys*` slots until ttyd itself restarts. The ttyd watcher
  restarts it automatically once either gate trips (pool ≥ 85% full, or ≥ 20 leaked children);
  the panel shows the same reading so you can act before the watcher's next five-minute tick, or
  when the watcher's own restart did not take — read the note below about a recently restarted ttyd
  first, because acting immediately is not always worth it. Sessions survive the restart — tmux servers are
  separate processes and the browser reconnects.

  A restart makes every open terminal reconnect at once, and that churn leaks children of its own,
  so the leaked-child gate stays quiet until ttyd has been up for 15 minutes — otherwise it trips
  on the reconnect burst a restart just caused and your terminals blank repeatedly for one
  underlying leak. It is keyed to ttyd's own age, so **your** manual `launchctl kickstart` counts
  exactly as the watcher's does; the panel will also tell you when the count it is showing may be a
  recent restart's burst rather than a new leak, so you know another restart may buy nothing. The
  pool gate is **not** held back: a full pool means no terminal can attach at all, which is worth
  an immediate restart whenever it happens. If you see `ttyd orphan gate held down` in the log,
  that is this wait, and it names how long is left.
- **Full Disk Access missing** — the server process cannot read protected folders. A background
  (launchd-spawned) `node` gets no permission prompt; reads under `~/Documents`, `~/Desktop` and
  `~/Downloads` simply never return. Grant Full Disk Access to the exact `node` binary the
  service runs (`which node`, then System Settings → Privacy & Security → Full Disk Access), and
  restart the server so the grant applies. A brew or Node upgrade moves the binary and silently
  drops the grant — if this row reappears after an upgrade, that is why.
- **Could not check …** — the measurement failed and the row says why. It is not an all-clear.

```bash
# The same verdicts the panel renders
curl -s http://localhost:3102/api/system/health | python3 -m json.tool
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
- Check the bell in the session banner — it is lit when the chime is on for this session
- Check that **Global chime mute** is off in Global Settings; it silences every session
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
