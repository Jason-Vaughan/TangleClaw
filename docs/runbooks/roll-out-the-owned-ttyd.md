# Roll out the owned ttyd runtime

Tier 3: it restarts ttyd, and the first switch needs a macOS permission change at the GUI (step 6).
Run by the Operator, or by the PM with the Operator present. Builders never run it (ADR 0018).

## When to use this

A TangleClaw release that ships the owned ttyd (#1245) is checked out on the host, and launchd still
runs the Homebrew ttyd, so the plist path is not `~/.tangleclaw/bin/ttyd`. Also use it after
`deploy/ttyd/inputs.json` changes, to put a rebuilt runtime in service.

**Not this runbook:** the owned ttyd is already in service and misbehaving. Use
[Roll back the owned ttyd runtime](roll-back-the-owned-ttyd.md).

## Before you start

- **Every open terminal tab disconnects** when ttyd restarts in step 7. Tabs reconnect to their tmux
  sessions, so no session is lost. Pick a moment when nobody is mid-command.
- **The first build takes several minutes.** It needs the Xcode Command Line Tools and network
  access to fetch the pinned sources.

## Steps

Run everything from the TangleClaw checkout the service runs from, for example
`cd ~/Documents/Projects/TangleClaw`.

1. Record the ttyd launchd runs now:
   `plutil -extract ProgramArguments.4 raw ~/Library/LaunchAgents/com.tangleclaw.ttyd.plist`
   → Expected: a path, for example `/opt/homebrew/bin/ttyd`. Write it down, because it is the
   rollback target.

2. Record the ingress mode:
   `node -p "require(require('os').homedir() + '/.tangleclaw/config.json').ingressMode || 'direct'"`
   → Expected: `caddy` or `direct`. Step 7 depends on it.

3. Build and install the runtime (no plist change, no restart):
   `node scripts/ttyd-runtime.js provision`
   → Expected: the last line is your `~/.tangleclaw/bin/ttyd`, for example
   `/Users/you/.tangleclaw/bin/ttyd`. A fresh build also prints
   `built and installed the owned ttyd runtime <sha256>`.
   → If not: it exits non-zero and lists every failing check. Fix what it names and run it again.
   Nothing has been restarted yet.

4. Confirm what will be selected:
   `node scripts/ttyd-runtime.js status`
   → Expected: `"selected"` shows `"managed": true` and your `~/.tangleclaw/bin/ttyd`, with
   `"refused": null`.

5. **Caddy mode only**, preview the switch:
   `node scripts/ingress-cutover.js --to caddy --dry-run`
   → Expected: a line `ttyd runtime:    /Users/…/.tangleclaw/bin/ttyd (the owned runtime)` and no
   `✗ would REFUSE` line. If a `✗ would REFUSE` line appears, stop here: the cutover is refusing for a
   reason of its own, and it names that reason.

6. **First switch only: an Operator-present checkpoint at the Mac.** Open **System Settings → Privacy &
   Security** and look at every section for the step 1 path. Give `~/.tangleclaw/bin/ttyd` exactly the
   grants that path visibly has: the same sections, nothing more.
   → Record which sections, if any, you added it to. That record is the rollout evidence.
   → If you cannot tell what the old path has: stop here and report to the PM.
   Do not add Full Disk Access unless the old path has it. ttyd is meant to run without it (see the
   `#500` note in `deploy/com.tangleclaw.ttyd.plist`), and granting anything broader is a separate
   decision for the Operator to make.

7. Switch launchd to it. **This restarts ttyd.**
   - Direct mode: `./deploy/install.sh`
     → Expected: `ttyd runtime: /Users/…/.tangleclaw/bin/ttyd`, then `Loaded com.tangleclaw.ttyd.plist`.
   - Caddy mode: `node scripts/ingress-cutover.js --to caddy`
     → Expected: `Ingress switched to 'caddy'.`, then `ttyd: /Users/…/.tangleclaw/bin/ttyd (the owned runtime)`.

   Do not run `./deploy/install.sh` on a caddy-mode host: it rewrites the ttyd plist for direct
   mode, and Caddy then has no socket to proxy to.

8. Check the plist now points at it:
   `plutil -extract ProgramArguments.4 raw ~/Library/LaunchAgents/com.tangleclaw.ttyd.plist`
   → Expected: your `~/.tangleclaw/bin/ttyd`.

9. Check it loads only macOS libraries:
   `otool -L ~/.tangleclaw/bin/ttyd`
   → Expected: every line after the first starts with `/usr/lib/` or `/System/Library/`.

10. Check it is the running ttyd:
    `pgrep -fl '.tangleclaw/bin/ttyd'`
    → Expected: exactly one line, a pid followed by that path.
    → If none: `launchctl print gui/$(id -u)/com.tangleclaw.ttyd | grep -E 'state|last exit'`, then
    [roll back](roll-back-the-owned-ttyd.md).

11. Open three terminal tabs in the dashboard, close them, wait one minute, then list ttyd's children:
    `ps -axo ppid,pid,stat,command | awk -v p="$(pgrep -f '.tangleclaw/bin/ttyd')" '$1 == p'`
    → Expected: no line whose third column contains `E` or `Z`.
    → If one stays for more than a minute: the fix is not working. Roll back and report it on #1245.

## Done when

- Steps 8–11 all hold.
- Live certification then runs for at least 72 hours of ordinary use, with tabs opened and closed,
  and the PM records the result. It passes when all of these hold:
  - `grep 'ttyd kickstart receipt' ~/.tangleclaw/logs/tangleclaw.log` shows no kickstart after the
    rollout time;
  - step 11, repeated, still shows no `E` or `Z` child;
  - the system health panel's **Terminal (ttyd) PTY leak** row has not fired, and its PTY count is
    not trending upward.
- #1245 closes after certification. Turning the watcher into a pure safety net is a separate change
  that comes after that.

## If this doesn't work

Anything after step 7 that fails: run [Roll back the owned ttyd runtime](roll-back-the-owned-ttyd.md),
then report the step and its output to the PM on #1245. Before step 7, nothing is in service yet:
stop and report.
