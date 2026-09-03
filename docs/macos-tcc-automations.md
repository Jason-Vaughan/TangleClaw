# macOS automations that need a privacy grant (TCC)

A project script that reads Calendar, Reminders, Contacts, Photos, or a protected folder
(`~/Documents`, `~/Desktop`, `~/Downloads`) needs a macOS privacy grant — what Apple calls TCC.
Run from inside a TangleClaw session, such a script cannot get one, and an agent that tries will
conclude it is blocked and keep rediscovering the same wall (#1148). This page says why that is
so, what the supported pattern is, and how to verify it in the context that actually runs it.

## Why the managed session cannot validate the grant

A TangleClaw session is a process chain started by launchd:

```
launchd → ttyd (com.tangleclaw.ttyd) → tmux → engine (Claude Code, Codex, …) → your script
```

macOS attributes a privacy check to the **responsible process** of that chain, and for a
launchd job that is the job's own program — `ProgramArguments[0]`, here `ttyd` — not the
engine, and not your script. The whole problem is that identity, and two consequences follow
from it; neither is a TangleClaw bug:

1. **A grant keys to the responsible program's path.** Whatever you grant in System Settings
   is recorded against that binary's absolute path — for a Homebrew `ttyd` that is a
   version-stamped Cellar path — so the next `brew upgrade` mints a new path, the old grant
   points at a binary that no longer exists, and the chain is denied again. The grants
   TangleClaw itself depends on (`node`, `ttyd`, `caddy`) all behave this way: #324 was a
   launchd-spawned `node` without Full Disk Access blocking forever on opening its own working
   directory under `~/Documents`, and the project-scan timeout in the
   [user guide](user-guide.md#auto-detection-of-existing-projects) is the same mechanism.
2. **The grant cannot be scoped, so broadening it is the wrong fix.** Granting `ttyd` Calendar
   access would extend it to every session TangleClaw ever launches, for every project. The
   scoping you want — *this* script may read *this* resource — cannot be expressed on the
   shared chain.

So a session can write the script, but it cannot prove the script works. "It is blocked from
here" is the expected result, not a finding.

## The supported pattern: a project-owned LaunchAgent

Give the automation its own responsible process: a per-user LaunchAgent that runs the script
directly. The grant then attaches to that job's binary and nothing else.

- **Keep the plist in the repo** (for example `automations/<label>.plist`) and install a copy
  to `~/Library/LaunchAgents/<label>.plist`. The repo copy is the source of truth; the installed
  copy is derived from it. Use a reverse-DNS label that names the project
  (`com.example.<project>.<job>`).
- **Absolute paths everywhere.** `ProgramArguments`, `WorkingDirectory`, `StandardOutPath` and
  `StandardErrorPath` all take absolute paths — launchd runs the job with no shell, no `$PATH`
  of yours, and no notion of the project directory. Point the log paths at a directory inside
  the project so the job's own output is where the next reader looks.
- **Make the job's program a stable binary.** Same rule as above: the grant keys to the job's
  own program — `ProgramArguments[0]` — not to whatever that program goes on to run. A
  `/bin/sh` wrapper keys the grant to `/bin/sh`, shared with every other shell job on the
  machine; a Homebrew interpreter re-keys it on every upgrade. A compiled helper at a fixed
  path inside the project is its own subject and survives both. If you must use an
  interpreter, expect to re-grant after upgrading it.
- **Dry-run by default; `--apply` to write.** The first launchd run is the one that raises the
  consent dialog, and the job may run several times before the grant lands. A script that only
  reports what it would change until it is passed an explicit `--apply` cannot do harm while
  half-permitted, and its dry-run output is the verification signal below.
- **Keep the state with the project.** The script's config, its logs, and any cursor it keeps
  live under the owning project (its `.tangleclaw/` directory is fine) — never under
  TangleClaw's own data or in a Project Master session. TangleClaw's only knowledge of the job
  is the rename check described at the end of this page.

A minimal plist, with the paths that must be absolute marked:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>              <string>com.example.myproject.calendar-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/me/Projects/myproject/bin/calendar-sync</string>   <!-- absolute; dry-run until --apply is added -->
  </array>
  <key>WorkingDirectory</key>   <string>/Users/me/Projects/myproject</string>            <!-- absolute -->
  <key>StandardOutPath</key>    <string>/Users/me/Projects/myproject/logs/calendar-sync.log</string>
  <key>StandardErrorPath</key>  <string>/Users/me/Projects/myproject/logs/calendar-sync.err.log</string>
  <key>StartInterval</key>      <integer>900</integer>
</dict>
</plist>
```

Install it (a one-time step, from any terminal — the session included, since this only copies
a file and talks to launchd):

```bash
cp automations/com.example.myproject.calendar-sync.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.myproject.calendar-sync.plist
```

## Verifying it in the real launchd context

Running the script by hand in a session proves nothing about the job — the session is a
different responsible process. Ask launchd to run it, then read the job's own log:

```bash
launchctl kickstart -k gui/$(id -u)/com.example.myproject.calendar-sync
tail -40 /Users/me/Projects/myproject/logs/calendar-sync.log
launchctl print gui/$(id -u)/com.example.myproject.calendar-sync | grep -E 'state|last exit'
```

`kickstart -k` starts the job now (killing a running instance first). On the first run macOS
shows the consent dialog for the job's program; grant it, kickstart again, and the log should
turn from a denial into the script's dry-run report. A non-zero `last exit code` with an empty
log usually means a wrong absolute path — launchd could not start the program at all.

Only once the dry-run report reads correctly does the job get to write: add
`<string>--apply</string>` after the program in `ProgramArguments` (in the repo copy, then the
installed copy), reload the plist — launchd does not re-read one on its own — and kickstart
again:

```bash
launchctl bootout gui/$(id -u)/com.example.myproject.calendar-sync
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.myproject.calendar-sync.plist
launchctl kickstart -k gui/$(id -u)/com.example.myproject.calendar-sync
```

The same bootout/bootstrap pair is the reload for any later plist change, including the
path fix after a project rename.

## What TangleClaw does — and does not — do about it

**On a project rename**, TangleClaw scans `~/Library/LaunchAgents/*.plist` for the project's
old absolute path (anywhere in the file — `ProgramArguments`, `WorkingDirectory`, the log
paths) and reports every match in the rename result, by label and plist path:

> 1 LaunchAgent still references the old path /Users/me/Projects/myproject: …

The dashboard shows this as a banner that stays until you dismiss it. A plist the scan could
not read is reported as unread, not as a non-match. TangleClaw **does not rewrite the plists**
— they are yours, and the edit-then-reload sequence above is the fix.

TangleClaw does **not** watch session output for TCC denials and does not track your
automations' state. A guess at "this looks blocked" from terminal text would be exactly the kind
of invented status the dashboard no longer shows; the boundary above, plus the rename warning,
is the whole of what it knows.
