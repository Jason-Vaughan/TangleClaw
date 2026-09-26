# Roll out the owned ttyd runtime

Tier 3: it restarts ttyd, and the first switch and every rebuild need a macOS permission checkpoint at
the Mac (step 7).
Run by the Operator, or by the PM with the Operator present. Builders never run it (ADR 0018).

## When to use this

A TangleClaw release that ships the owned ttyd (#1245) is checked out on the host, and launchd still
runs the Homebrew ttyd, so the plist path is not `~/.tangleclaw/bin/ttyd`. Also use it after
`deploy/ttyd/inputs.json` changes, to put a rebuilt runtime in service.

**Not this runbook:** the owned ttyd is already in service and misbehaving. Use
[Roll back the owned ttyd runtime](roll-back-the-owned-ttyd.md).

## Before you start

- **Every open terminal tab disconnects** when ttyd restarts in step 8. Tabs reconnect to their tmux
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
   → Expected: `caddy` or `direct`. Step 8 depends on it.

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

6. Record the new binary's identity, which is part of the rollout evidence:
   `node scripts/ttyd-runtime.js status`, then `codesign -dv ~/.tangleclaw/bin/ttyd`
   → Expected: `"current"` shows `"ok": true` and a `"sha256"`, and `codesign` prints lines including
   `Identifier=` and `Signature=`. Record the sha256 and those two lines.

7. **Permission checkpoint, with the Operator at the Mac.** Needed on the first switch, and whenever
   step 3 printed `built and installed`: a new binary may not keep the old grants. Open **System
   Settings → Privacy & Security** and look at every section for the step 1 path (on a re-run, the
   owned path as it stood before). Give `~/.tangleclaw/bin/ttyd` exactly the grants that path visibly
   has: the same sections, nothing more.
   → Record which sections, if any, it now has. That is rollout evidence, not proof the grants will
   hold.
   → If you cannot tell what the old path has: stop here and report to the PM.
   Do not add Full Disk Access unless the old path has it. ttyd is meant to run without it (see the
   `#500` note in `deploy/com.tangleclaw.ttyd.plist`), and any broader grant is a separate decision
   for the Operator to make.

8. Switch launchd to it. **This restarts ttyd.**
   - Direct mode: `./deploy/install.sh`
     → Expected: `ttyd runtime: /Users/…/.tangleclaw/bin/ttyd`, then `Loaded com.tangleclaw.ttyd.plist`.
   - Caddy mode: `node scripts/ingress-cutover.js --to caddy`
     → Expected: `Ingress switched to 'caddy'.`, then `ttyd: /Users/…/.tangleclaw/bin/ttyd (the owned runtime)`.

   Do not run `./deploy/install.sh` on a caddy-mode host: it rewrites the ttyd plist for direct
   mode, and Caddy then has no socket to proxy to.

9. Check the plist now points at it:
   `plutil -extract ProgramArguments.4 raw ~/Library/LaunchAgents/com.tangleclaw.ttyd.plist`
   → Expected: your `~/.tangleclaw/bin/ttyd`.

10. Check it loads only macOS libraries:
    `otool -L ~/.tangleclaw/bin/ttyd`
    → Expected: every line after the first starts with `/usr/lib/` or `/System/Library/`.

11. Check it is the running ttyd:
    `pgrep -fl '.tangleclaw/bin/ttyd'`
    → Expected: exactly one line, a pid followed by that path.
    → If none: `launchctl print gui/$(id -u)/com.tangleclaw.ttyd | grep -E 'state|last exit'`, then
    [roll back](roll-back-the-owned-ttyd.md).

12. Live access check. Open a terminal tab in the dashboard for a project whose folder is under
    `~/Documents`, and run `ls`.
    → Expected: the project's files are listed.
    → If it prints `Operation not permitted`, or you cannot tell: stop. The grants from step 7 are
    not enough. [Roll back](roll-back-the-owned-ttyd.md) and report the step 7 record to the PM. Do
    not widen the grants yourself.

13. Close that tab and two more you open, wait one minute, then list ttyd's children:
    `ps -axo ppid,pid,stat,command | awk -v p="$(pgrep -f '.tangleclaw/bin/ttyd')" '$1 == p'`
    → Expected: no line whose third column contains `E` or `Z`.
    → If one stays for more than a minute: the fix is not working. Roll back and report it on #1245.

## Done when

- Steps 9–13 all hold, and the step 6 and 7 records are sent to the PM.
- Live certification then runs for at least 72 hours of ordinary use, with tabs opened and closed,
  and the PM records the result. It passes when all of these hold:
  - `grep 'ttyd kickstart receipt' ~/.tangleclaw/logs/tangleclaw.log` shows no kickstart after the
    rollout time;
  - step 13, repeated, still shows no `E` or `Z` child;
  - the system health panel's **Terminal (ttyd) PTY leak** row has not fired, and its PTY count is
    not trending upward.
- #1245 closes after certification. Turning the watcher into a pure safety net is a separate change
  that comes after that.

## If this doesn't work

Anything after step 8 that fails: run [Roll back the owned ttyd runtime](roll-back-the-owned-ttyd.md),
then report the step and its output to the PM on #1245. Before step 8, nothing is in service yet:
stop and report.
