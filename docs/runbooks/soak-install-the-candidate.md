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

6. Confirm the checkout:
   `sudo git -C /opt/tangleclaw-soak rev-parse HEAD; stat -f '%Su %Lp' /opt/tangleclaw-soak`
   → Expected: exactly `$SOAK_SHA`, then `root 755`.
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

11. Name the DHCP server pf will allow, then run the egress positive control, then set the guest up.
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

12. **Dry run only:** watch the guest survive a real DHCP lease renewal. The admin attestation's
    renewal time is `dhcp.renewEpoch`, and `dhcp.timingSource` says whether the lease reported it
    (`lease`) or the verifier derived it from `lease_time` (`derived-rfc2131`). A derived time is not
    evidence that a renewal happens. Only this step is.
    Both commands below run from the checkout, with the `SOAK_DHCP_SERVER` exported in step 11. A new
    SSH login starts in the home directory and doesn't inherit that variable. Without either, the
    verifier refuses for that reason alone, and that refusal says nothing about renewal.
    First, as the admin, record the lease:
    `cd /opt/tangleclaw-soak && SOAK_DHCP_SERVER=<the address exported in step 11> bash deploy/soak/guest/guest-setup.sh --verify-admin | tee ~/lease-before.json`
    Keep the guest running until the clock is past `dhcp.renewEpoch`, and a sample interval beyond it.
    On a one-day lease that is about 12 hours, so plan the dry run long enough. Then, from the host,
    SSH to the guest's address as the admin, and run the same command again:
    `cd /opt/tangleclaw-soak && SOAK_DHCP_SERVER=<the address exported in step 11> bash deploy/soak/guest/guest-setup.sh --verify-admin | tee ~/lease-after.json`
    → Expected: the SSH login works; the second command exits 0; `interface.address` is the same in
    both files; and `dhcp.leaseStartEpoch` in the second is later than it was in the first, because the
    lease was renewed.
    → If either command's line names a refusal other than the lease (for example `set SOAK_DHCP_SERVER`):
    fix the invocation and run it again. That is not a renewal result.
    → If SSH fails, the address changed, or the lease start did not move: the renewal did not happen
    through pf. Record both files and report it on #2020. The certifying run then uses the fallback in
    [`deploy/soak/README.md`](../../deploy/soak/README.md) (**Known limits**, the DHCP allowance): a static
    address or an independently proven tart console path. Don't fall back without this evidence.
    - **Unverified until the first dry run:** that `LeaseStartTime` moves on renewal. If it doesn't,
      record what `ipconfig getsummary` reports before and after, and report it on #2020 rather than
      judging the renewal by it.

## If it fails

Anything not covered above: stop, keep the guest as it is, and report the step number and its output on
#2020. Do not reuse a guest that failed partway: create a new one from step 2.
