# Roll back the owned ttyd runtime

Tier 2: it restarts ttyd. Run by the Operator, or by the PM with the Operator's go-ahead.

## When to use this

The owned ttyd (`~/.tangleclaw/bin/ttyd`) is in service and terminals do not open, ttyd keeps
exiting, or a rebuilt runtime misbehaves. Also use it when `deploy/install.sh` or the ingress
cutover refuses with `the managed ttyd runtime … cannot be used` and you need terminals back before
the cause is fixed.

## Steps

Run everything from the TangleClaw checkout the service runs from.

1. See what can be restored:
   `node scripts/ttyd-runtime.js status`
   → Expected: JSON with `"current"` and `"previous"`. Note `"previous"."ok"`.
   - `"ok": true` → go to step 2 (the previous owned runtime, which keeps the fix).
   - `"ok": false` → go to step 4 (the Homebrew ttyd, without the fix). This includes
     `"stale": true`: after `deploy/ttyd/inputs.json` changes, the previous runtime is refused.

**Back to the previous owned runtime**

2. `node scripts/ttyd-runtime.js rollback`
   → Expected: `restored <sha256>; the replaced runtime is kept at …/ttyd.rolled-back`, then
   `ttyd has NOT been restarted.`
   → If it refuses: go to step 4.

3. Restart ttyd on it:
   `launchctl kickstart -k gui/$(id -u)/com.tangleclaw.ttyd`
   Then go to step 6.

**Back to the Homebrew ttyd (the leak returns)**

4. Check the watcher is on, since it becomes the only mitigation:
   `plutil -extract EnvironmentVariables.TANGLECLAW_TTYD_WATCHER raw ~/Library/LaunchAgents/com.tangleclaw.server.plist`
   → Expected: an error saying the key does not exist, or `on` / `1` / `true`.
   → If it says `off`, `0` or `false`: expect PTYs to leak until ttyd is restarted by hand.

5. Select Homebrew ttyd explicitly. **This restarts ttyd.**
   - Direct mode: `TANGLECLAW_TTYD_RUNTIME=homebrew ./deploy/install.sh`
   - Caddy mode: `TANGLECLAW_TTYD_RUNTIME=homebrew node scripts/ingress-cutover.js --to caddy`

   → Expected: a line starting `WARNING: TANGLECLAW_TTYD_RUNTIME=homebrew: ttyd will run the Homebrew
   binary, WITHOUT the #1245 leak fix.` Caddy mode also prints
   `ttyd: /opt/homebrew/bin/ttyd (the Homebrew ttyd: explicit rollback, the #1245 leak fix is NOT active)`.

   To tell the modes apart:
   `node -p "require(require('os').homedir() + '/.tangleclaw/config.json').ingressMode || 'direct'"`

**Either way**

6. `pgrep -fl ttyd`
   → Expected: one line for the ttyd you chose: `~/.tangleclaw/bin/ttyd` after step 3, or
   `/opt/homebrew/bin/ttyd` after step 5.

7. Open a terminal tab in the dashboard.
   → Expected: a shell prompt.

## Done when

A terminal tab opens, and `pgrep -fl ttyd` shows the ttyd you chose.

## Getting back to the fix

After a Homebrew rollback, run [Roll out the owned ttyd runtime](roll-out-the-owned-ttyd.md) once the
cause is fixed. Make sure `TANGLECLAW_TTYD_RUNTIME` is not set in that shell.

## If this doesn't work

If no terminal opens after either route, the problem is not the ttyd binary. Check
`launchctl print gui/$(id -u)/com.tangleclaw.ttyd`, then see
[Server Won't Start](../user-guide.md#server-wont-start), and report to the PM on #1245.
