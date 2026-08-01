# Setting up TangleClaw safely

This guide is for setting up TangleClaw for the first time, or for checking that an
existing install is set up the way you think it is. It assumes no background in web
servers, TLS, or reverse proxies — where a term matters, it is explained where it
first appears.

If you already know what a reverse proxy is and want flags, tables and rollback
commands, read [deploy/INGRESS.md](../deploy/INGRESS.md) instead. This guide and that
one describe the same machinery for different readers.

---

## The one thing to understand first

TangleClaw gives a web browser the ability to run terminal commands on your computer.
That is the whole point of it — and it means **anyone who can open the dashboard can
run commands as you**. Not "see your data". Run commands.

So the only question that really matters during setup is: *who can reach the
dashboard?* Everything below is about answering that deliberately instead of by
accident.

---

## What a fresh install does on its own

A newly installed TangleClaw listens on `127.0.0.1` — an address that means "this
computer only". Other machines on your network cannot reach it, even if they know
your IP address. This is the default and it needs no decision from you.

During setup the wizard asks you to create a **login** — a username and a password.
There is no default password to change later; you either set one or setup does not
finish. It then puts that login in front of everything TangleClaw serves.

That is the finished, intended state: reachable from this computer, and from
elsewhere only with a password.

---

## Reaching it from your phone or another computer

To open the dashboard from somewhere other than the machine it runs on, something has
to accept connections from the outside. TangleClaw uses **Caddy** for this.

**What Caddy is, in one paragraph.** Caddy is a small, separate program that sits in
front of TangleClaw and answers the network on its behalf. Requests arrive at Caddy;
Caddy checks the password, and only then passes the request along to TangleClaw,
which is still listening only to `127.0.0.1`. That arrangement — one program
answering the outside world and forwarding to another — is what "reverse proxy"
means. Caddy also handles **TLS**, which is what makes the address start with
`https://` and stops other people on the network from reading the traffic.

The advantage of doing it this way is that the password check happens *before*
anything reaches TangleClaw. There is one door, and it is locked.

Setup installs and configures this for you. You do not need to write any Caddy
configuration by hand.

### If setup could not do it

Setup skips the Caddy step in two situations, and says so rather than pretending:

- **Caddy is not installed.** Install it with `brew install caddy` and re-run setup,
  or use the manual path below.
- **There is already a Caddy configuration that TangleClaw did not write.** It will
  not overwrite a file you or another tool maintains. This is deliberate: silently
  replacing it could take down something else you are running.

In both cases the install finishes **with no login**, and TangleClaw tells you so on
the dashboard rather than implying you are protected. Loopback-only is still in force,
so it is not exposed — it just cannot be reached remotely yet.

To set it up afterwards:

```sh
brew install caddy
node scripts/ingress-cutover.js --to caddy --dry-run   # preview, changes nothing
node scripts/ingress-cutover.js --to caddy
```

---

## Checking it actually worked

Do not take the dashboard's word for it. Two checks, from a *different* device than
the one TangleClaw runs on:

1. **Open the dashboard address.** A password prompt should appear before you see
   anything. If you see the dashboard with no prompt, the gate is not in force —
   stop and fix that before going further.
2. **Check a URL that is not the dashboard**, for example `/api/config`. It should
   also ask for the password — the gate is not just on the front page.

   Pick that URL deliberately. Three paths are **exempt by design** and will answer
   without a password: `/api/health` (so an uptime monitor can check liveness without
   a credential), `/openclaw-direct/*` (the OpenClaw gateway does its own token
   authentication) and `/manifest.json` (browsers fetch PWA manifests anonymously).
   Testing one of those and seeing a reply proves nothing about your gate.

If you have a Tailscale or WireGuard tunnel, use the tunnel address for both checks —
that is the perimeter you actually rely on.

---

## If you are locked out

There is always a way back in, and it deliberately requires **physical access to the
machine** rather than a second way in over the network. A "reset my password" link
that worked remotely would be exactly the door the password exists to close.

Open a terminal on the computer TangleClaw runs on and:

```sh
cd /path/to/TangleClaw
node scripts/reset-admin.js
```

It asks for a new password twice, then updates the gate and restarts Caddy.

**Your connection will drop for a few seconds.** That is expected: Caddy is the thing
being restarted, so anything arriving through it — the dashboard, the browser
terminal — is interrupted while it comes back. Reconnect afterwards with the new
password.

Three things worth knowing before you run it — all of them learned by actually doing it:

- **It has to be a genuinely new password, even if you still know the old one.** The tool enforces
  today's rules on whatever you type: at least 12 characters, not a common password, and it must not
  contain your username. A credential set before those rules existed will be **refused**, so if you
  came here intending to reinstate a password you already have, you may not be able to. Decide the
  new one and save it somewhere *before* you start — your connection drops seconds after you confirm
  it, and the very next thing that happens is being asked for it.
- **Get a shell that survives the restart, and notice where you are typing.** If you reach this
  machine through TangleClaw's own browser terminal you are already inside a persistent `tmux`
  session, so anything you run there survives the drop with no extra work. But that session's window
  may be running an AI session rather than a shell, in which case open a second window with
  `Ctrl-b` then `c` and work there. Running `tmux new -s <name>` from inside it does not help — that
  nests one session in another, and fails outright if the name is already taken.
- **It takes a backup first, and tells you the truth about what happened.** In the
  ordinary failure — the new configuration does not validate — the original is put
  back and your existing password keeps working. Two rarer failures cannot promise
  that, and the tool says so plainly rather than reassuring you: if the disk fails
  midway it may report that the gate could not be written *or* restored (fix that by
  hand from the backup path it prints, before restarting Caddy), or that the new
  password is in force and could not be rolled back. Read the last thing it prints;
  it distinguishes these deliberately, because they send you to different places.

To see what it would do without changing anything:

```sh
node scripts/reset-admin.js --dry-run
```

### If there is no login to reset

An install that finished setup before a login was required — and later moved to Caddy
— can end up with no password at all and no obvious way to add one. If
`reset-admin.js` says there is nothing to reset, create the login instead:

```sh
node scripts/reset-admin.js --create-gate --user <name>
```

This only works on a Caddy configuration TangleClaw generated. If you maintain that
file yourself, the tool will refuse rather than rewrite your work — add a
`basic_auth` block to it by hand, then use the ordinary reset above.

**If you typed the username wrong**, you cannot rename it: the ordinary reset changes
a password, not a name, and running `--create-gate` a second time refuses because a
login now exists. Restore the backup the run printed — its path is in the output —
and create it again with the right name.

---

## Where you should and should not run this

**Supported:** on the machine itself; over a private tunnel such as Tailscale or
WireGuard; on a network you fully control, behind the login.

**Not supported:** exposed to the open internet. This is not a strong recommendation,
it is a boundary. The login is a single shared username and password with no rate
limiting, no lockout after repeated guesses, no second factor and no way to revoke a
session — sitting in front of something that runs commands on your computer. Put it
behind a tunnel instead; the reasoning is written up in
[ADR 0009](adr/0009-secure-by-default.md).

---

## Upgrading an older install

If you installed TangleClaw before it defaulted to loopback, your existing network
binding is **left exactly as it was**. Narrowing it automatically would take away
remote access you might be depending on, possibly while you are away from the
machine, and before there is a password to replace it with.

TangleClaw will keep telling you about it — on every start and on the dashboard —
until you resolve it one of two ways:

- **Set up the login** (recommended): you keep remote access, now with a password in
  front of it.
- **Close it**: set `"bindAllInterfaces": false` in `~/.tangleclaw/config.json` and
  restart. Loopback only, no remote access.

Either is a real answer. Leaving it as it is — reachable from the network with no
password — is the one option that is not.

---

## Related documents

- [Ingress Guide](../deploy/INGRESS.md) — the same subject with the flags, tables and rollback commands
- [User Guide](user-guide.md) — using TangleClaw once it is running
- [Configuration Reference](configuration-reference.md) — every config field
- [ADR 0009](adr/0009-secure-by-default.md) — why the posture is what it is
