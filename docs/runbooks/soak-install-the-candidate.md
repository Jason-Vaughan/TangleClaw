# Install and start the pinned candidate in the soak guest

The Operator runs this runbook. It creates a VM, installs software in it, and ends by cutting the guest
off the network. Builders never run it.

## When to use this

A release candidate is pinned to one 40-character SHA for the #2020 soak, and you need a fresh guest
running exactly that SHA. Run it again for every certifying run and after every destructive-phase run:
a certification starts from a pristine guest.

**Not this runbook:** the guest is already set up and you want to run the soak. Use
[Run, sample and bundle the soak](soak-run-sample-and-bundle.md).

## Before you start

- **Everything the guest needs comes from the network before step 11.** Step 11 loads the default-deny
  profile, and after that the guest cannot reach GitHub or Homebrew.
- **Unverified until the first dry run:** steps 4, 8, 9, 10 and 12 have not yet been run in a real guest.
  Record what each one printed with the run's evidence.
- **The workload user gets a login secret, inside the guest only** (Architect ruling A1 on #2020).
  launchd runs the server and ttyd in that user's GUI session, which needs a login. The secret is
  generated in the guest and must never appear in a command line, a log, the evidence, the repo or
  Medusa. Nobody, the Operator included, ever sees it.

## Steps

On the host, from a TangleClaw checkout:

1. Pin the candidate:
   `export SOAK_SHA=<the pinned 40-hex SHA>; [[ $SOAK_SHA =~ ^[0-9a-f]{40}$ ]] && echo pinned`
   → Expected: `pinned`.

2. Preview the VM:
   `bash deploy/soak/guest/host-provision.sh`
   → Expected: the `tart clone`, `tart set` and `tart run` commands it would run, and nothing else.
   - `SOAK_TART_DISPLAY=vnc` gives the guest a real framebuffer (reached over VNC, no host window)
     instead of none. Browser events need a page the guest actually draws. A page that is never drawn
     records `PAGE_HIDDEN`, so choose the display before the dry run and keep it for the certifying run.
     Record the choice: step 11b restarts the guest and must be given the same display.
   → If it refuses: it names the setting it rejected. Fix that in the environment and run it again.

3. Create and start the VM:
   `SOAK_OPERATOR_APPROVED=1 bash deploy/soak/guest/host-provision.sh --execute`
   → Expected: the same three commands, then a running VM named `tc-soak-guest`.

In the guest, as its admin user over SSH:

4. Install the tools (network still open): the Xcode Command Line Tools, Homebrew, then
   `brew install node tmux ttyd mkcert caddy`
   → Expected: `node --version` prints `v22` or later.

5. Check out the pin into a root-owned tree that the workload user can read and nobody else can write:
   `sudo git clone --no-checkout https://github.com/Jason-Vaughan/TangleClaw.git /opt/tangleclaw-soak && sudo git -C /opt/tangleclaw-soak checkout --detach "$SOAK_SHA"`

6. Confirm the checkout, and let the admin's git read it:
   `git config --global --add safe.directory /opt/tangleclaw-soak; sudo git -C /opt/tangleclaw-soak rev-parse HEAD; stat -f '%Su %Lp' /opt/tangleclaw-soak`
   → Expected: exactly `$SOAK_SHA`, then `root 755`.
   - The tree is root-owned, so without `safe.directory` the admin's git refuses it as dubious
     ownership. The release-certification judge runs as the admin and probes this worktree, and it
     reports `PROBE_UNKNOWN` until git will read it. `soakrun` gets the same setting in step 9.
   → If not: delete `/opt/tangleclaw-soak` and go back to step 5.

7. Create the workload user:
   `cd /opt/tangleclaw-soak && bash deploy/soak/guest/guest-setup.sh --bootstrap-user`
   → Expected: the last line is
   `workload user soakrun is ready. Next: start the pinned TangleClaw as soakrun on 127.0.0.1:3102, then run guest-setup.sh`.

8. Give `soakrun` a GUI session that logs in by itself:
   - **Unverified: the dry run proves the commands for this, and records them here.** Set a random
     password for `soakrun`, generated in the guest, and write the matching `/etc/kcpassword`
     (root, `0600`), without the password ever appearing in a command line. If no way is found that
     keeps it out of every command line, stop: fail closed and report on #2020. Never weaken this.
   - Then: `sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser soakrun && sudo shutdown -r now`
   - After the reboot, over SSH as the admin: `sudo launchctl print "gui/$(id -u soakrun)" | head -1`
   → Expected: `gui/<uid> = {`, with `soakrun`'s uid.
   → If it prints `Could not find domain`: the session did not start. Stop and report the output on
     #2020. Do not start the candidate any other way: without launchd, the restart and ttyd gates cannot
     pass.

As `soakrun`, in that GUI session:

9. Install and start the candidate:
   `git config --global --add safe.directory /opt/tangleclaw-soak && cd /opt/tangleclaw-soak && bash deploy/install.sh`
   → Expected: the install finishes with its summary banner. If `mkcert -install` asks for a password
   and fails, the install says so and carries on; that is fine here.

10. Confirm launchd runs both services, and the server runs the pin with the gate off:
    `launchctl print "gui/$(id -u)/com.tangleclaw.server" | grep -m1 'state ='`,
    `launchctl print "gui/$(id -u)/com.tangleclaw.ttyd" | grep -m1 'state ='`,
    `curl -s http://127.0.0.1:3102/api/server-info` and
    `node -p "require(process.env.HOME + '/.tangleclaw/config.json').authEnabled === true"`
    → Expected: `state = running` twice, then `"startupSha"` equal to `$SOAK_SHA`, then `false`.
    → If the gate is on: browser events cannot log in. Turn the gate off before continuing.

As the admin again:

> ⚠️ **Step 11 cuts the guest off the network.** Anything it still needs must already be installed.
> **Proceed only if:** steps 9 and 10 passed. **Abort if:** anything is missing. Aborting costs
> nothing; after step 11 it costs a new guest.

11. Let `soakrun` drive Safari, name the DHCP server pf will allow, run the egress positive control,
    then set the guest up.
    - `sudo safaridriver --enable && sudo dseditgroup -o edit -a soakrun -t user _webdeveloper`, then
      `dseditgroup -o checkmember -m soakrun _webdeveloper`
      → Expected: `yes soakrun is a member of _webdeveloper`.
      `safaridriver --enable` alone does not authorize a user who is not an admin: macOS allows
      WebDriver to an admin or a member of `_webdeveloper`. Do this before setup, because setup
      attests the workload user's groups, and the judge treats a later change as a different workload.
      `_webdeveloper` is neither `admin` nor `wheel`, so the workload verifier still accepts `soakrun`.
    - Setup and every admin verification refuse without `SOAK_DHCP_SERVER`. A server read from the
      lease alone is not trusted, so the host has to confirm it. In the guest,
      `ipconfig getpacket en0 | grep server_identifier` prints the lease's server. On the host,
      `ifconfig | grep "inet <that address> "` must print exactly one line, which shows the host owns
      the address. Then, in the guest's shell:
      `export SOAK_DHCP_SERVER=<that address>`
      → If the host doesn't own that address: stop and report both outputs on #2020.
      **Unverified until the first dry run:** that the host's vmnet bridge carries the lease's server
      address.
    - `cd /opt/tangleclaw-soak && sudo -u soakrun -H bash deploy/soak/guest/guest-setup.sh --verify-workload`, then
      `nohup bash deploy/soak/guest/guest-setup.sh > ~/setup.log 2>&1; echo "exit $?" >> ~/setup.log`
    → Expected: the first exits 3 and its line names `egress-permitted`. pf is not loaded yet, so the
    probes can answer, which proves they can detect egress. The second writes to `~/setup.log`, whose last
    two lines are
    `guest ready: workload user soakrun, default-deny network attested on both planes, stub engine, projects soak-a,soak-b,soak-c`
    and `exit 0`.
    → If the first exits 0: the probes cannot detect egress, so their later denial proves nothing.
    Stop and report it on #2020.
    → If the SSH session running setup stops responding once pf loads: that is expected. pf keeps no
    state for a connection opened before it loaded, so the session that ran `pfctl -E` hangs, while new
    SSH sessions are accepted. That is why setup writes to a log under `nohup`: open a new session and
    read `~/setup.log`.
    - The setup caches the admin's sudo credentials with `sudo true`. It doesn't use `sudo -v`, which
      asks for a password on macOS 26 even under a `NOPASSWD` rule. When setup creates `soakrun` over
      SSH, `sysadminctl` doesn't make its home directory, so setup runs `createhomedir` for it.
    - Setup also finishes the candidate's first-run setup (no login, `projectsDir` set to the soak's
      projects root) before it attaches the projects. On a refusal it names the server's reason.

> ⚠️ **Step 11b restarts the guest.** pf does not survive a restart, so setup runs again after it.
> **Proceed only if:** step 11's `~/setup.log` ends in `guest ready` and `exit 0`.

11b. Close the host side (Architect ruling A7). softnet then drops everything the guest sends except
    replies to connections the host opens, so SSH from the host keeps working.
    - On the host, with the display chosen in step 2:
      `SOAK_TART_DISPLAY=<no-graphics or vnc, as in step 2> SOAK_OPERATOR_APPROVED=1 bash deploy/soak/guest/host-provision.sh --closure --execute`
      → Expected: `tart stop`, then a `tart run` carrying the same display flag as step 3,
      `--net-softnet --net-softnet-block=0.0.0.0/0 --net-softnet-allow=in @host` and the same share.
      Preview it first without `--execute`. The soak's counted boot is this one, so a display that
      differs from step 3's changes what every browser event sees.
    - The guest's address can change on this boot, and `tart ip` can report the previous one. Find the
      address from the host's ARP table for the softnet bridge, and SSH to it as the admin.
    - Repeat step 11's DHCP check on this boot. The lease's server is softnet's own now, so export that
      `SOAK_DHCP_SERVER`. Then run setup again:
      `cd /opt/tangleclaw-soak && nohup bash deploy/soak/guest/guest-setup.sh > ~/setup-closure.log 2>&1; echo "exit $?" >> ~/setup-closure.log`
      → Expected: the same last two lines as step 11. Setup is safe to repeat: it reloads pf, attests
      both planes and finds setup and the projects already done.
    - The boot identity has changed, so only attestations from this boot count. No soak time counts
      before it.

12. **Dry run only:** show that the guest keeps its address and SSH under the closure (Architect ruling
    A8). softnet's DHCP lease does not expire, so no renewal happens and none is waited for. What the
    dry run proves instead is that nothing about the management path changes over the run.
    Both commands run from the checkout, with this boot's `SOAK_DHCP_SERVER` exported. A new SSH login
    starts in the home directory and doesn't inherit that variable, and the verifier then refuses for
    that reason alone.
    At the start of the dry run, as the admin, record the lease:
    `cd /opt/tangleclaw-soak && SOAK_DHCP_SERVER=<this boot's server> bash deploy/soak/guest/guest-setup.sh --verify-admin | tee ~/lease-before.json`
    At the end of the dry run, SSH from the host to the same address as the admin and run it again:
    `cd /opt/tangleclaw-soak && SOAK_DHCP_SERVER=<this boot's server> bash deploy/soak/guest/guest-setup.sh --verify-admin | tee ~/lease-after.json`
    → Expected: the SSH login works; the second command exits 0; `interface.address`, `dhcp.leaseSeconds`
    and `dhcp.leaseStartEpoch` are the same in both files; and the boot identity is unchanged.
    → If either command names a refusal other than the lease (for example `set SOAK_DHCP_SERVER`): fix
    the invocation and run it again. That is not a result.
    → If SSH fails, the address changed, or the lease changed: record both files and report on #2020.
    The management path is not stable under the closure, and a certifying run must not start.

## If it fails

Anything not covered above: stop, keep the guest as it is, and report the step number and its output on
#2020. Do not reuse a guest that failed partway: create a new one from step 2.
