# Moving TangleClaw to another machine

This guide is for moving a TangleClaw install to a new machine, and for recovering when a machine was
copied by accident. It is a checklist for the operator. Nothing in it runs by itself, and TangleClaw
makes none of these changes for you.

It uses placeholders only: `<service-name>`, `<old-name>`, `<tailnet>.ts.net`, `100.64.0.10`,
`<project-route>` and `<backup-dir>`. Put your own values in a private copy, never in a public one.

What this guide does **not** cover:
- timed recovery, locking and atomic certificate activation. Those belong to a later ingress
  transaction, which TangleClaw does not ship yet;
- the private recovery runbook for your own install, which holds values that must never be public.

## Two layers: a name that resolves, and a name TangleClaw answers to

A migration touches two separate things:

1. **Whether a device can find this machine by a name.** That is DNS. On a tailnet it is the
   machine's MagicDNS name, `<service-name>.<tailnet>.ts.net`, and Tailscale owns it.
2. **Whether TangleClaw answers to that name.** That is the certificate (its names) and, in Caddy
   mode, the Caddyfile's sites.

Fixing one layer never fixes the other. In particular, adding an old name to the certificate or to a
Caddy site does **not** keep that name resolving after you rename the machine on the tailnet. A
certificate name nobody can resolve is answered by nobody.

## Two different migrations: keep them apart

**A planned move, with a fresh identity.** The new machine joins the tailnet as a new node. Leave the
old machine's Tailscale identity out of what you copy, so there is never a second live machine with the
same identity. There is no re-key afterwards, because no key was copied.

**Recovery after an accidental clone.** If the new machine was made from a full copy of the old one,
both carry the same Tailscale identity:
- keep the source machine **offline**, and keep its recovery path;
- **never log the source out of Tailscale, and never revoke it, while it shares the destination's node
  identity.** Keep the source offline until it is wiped;
- re-key the destination only as an attended, approved step, and only **after** the source is wiped
  and cannot rejoin.

Do not mix the two. A planned move never needs the clone recovery, and the clone recovery is never a
shortcut for a planned move.

## Before the move

1. Choose the permanent service name and record it as the migration target.
2. Prepare the destination's fresh identity (above), unless you are recovering from a clone.
3. Make a checkpoint of the work in flight: active sessions, control state, port leases, messages,
   Git state, and the next safe action. A checkpoint records what was in flight. It is **not** a
   backup of the database.
4. Back up TangleClaw's database: `tangleclaw.db` in TangleClaw's base directory, and any other
   database file there. Never copy the live file while TangleClaw runs: a plain file copy of a database
   in use can be inconsistent. Use SQLite's own online backup, then check the copy:

   The commands assume the default base directory, `~/.tangleclaw`; use `TANGLECLAW_HOME` if you set it.

   ```sh
   sqlite3 ~/.tangleclaw/tangleclaw.db ".backup '<backup-dir>/tangleclaw.db'"
   sqlite3 '<backup-dir>/tangleclaw.db' "PRAGMA integrity_check;"   # must print: ok
   sqlite3 '<backup-dir>/tangleclaw.db' ".tables"                   # must list the tables
   ```

   Keep the copy encrypted, with access restricted to the operator, for as long as the migration can
   still be rolled back.
5. Back up the configuration, the ingress configuration, the certificates, the service definitions,
   the recovery notes and the local CA's private key, with the database copy. Use encrypted storage
   with access control. Never put secrets in the migration notes or in this guide.
6. Record the active Tailscale serve routes and any machine-wide ingress entries.
7. Record active worktrees. Sort generated files, temporary files, operational documents and history
   apart before moving anything.
8. Confirm a recovery path that does not depend on the destination's new name or on a browser session
   you are about to move.
9. Run the host check on the source machine and keep its output **privately** (see below).

## The host check

The host check reads this machine's names, configuration, Caddyfile, certificates, serve routes and
local trust, and compares them. It changes nothing.

```sh
node scripts/host-check.js            # redacted output, safe to share
node scripts/host-check.js --reveal   # real values, for your own terminal only
```

It reads TangleClaw's base directory (`TANGLECLAW_HOME`, else `~/.tangleclaw`). It runs as its own
process, so it works right after a deploy with no server restart.

**Redaction.** By default, names, addresses, paths, URLs and project names are replaced with tokens.
`--reveal` shows them, and its output starts with a warning not to paste it publicly. Some things are
never printed, even with `--reveal`:
- credentials, password hashes and key material, which the check never reads;
- an error's message. A failing row shows only the error's class and code;
- an error code that is not on the check's fixed list of known codes. Any other code prints as fixed
  text instead: `internal-error`, or `lookup-failed` for a name that did not resolve;
- an unexpected value from a file. For example, an `ingressMode` that is neither `direct` nor `caddy`
  prints as `unsupported`, and its row reads `unknown`.

**It is not network-silent.** It opens one socket of its own, a single loopback request for
`/api/ports`. But name lookups use the system resolver, `tailscale` talks to its own daemon, and
macOS's `security` may consult trust services. The output says so.

**Each row ends in one state:**

| State | Meaning |
|---|---|
| `ok` | Measured, and it agrees with what was expected |
| `drift` | Measured, and it disagrees: something to diagnose |
| `ambiguous` | Measured, but more than one reading fits, and nothing says which is meant |
| `observed` | Measured and reported as a fact, with no expectation to compare it to |
| `unknown` | Not measured. The reason says why. It is never dressed up as `ok` or `drift` |

**Exit codes:**

| Exit | Meaning |
|---|---|
| `0` | Every row is `ok` or `observed` |
| `3` | At least one row is `drift` or `ambiguous` |
| `4` | At least one row could not be measured, or the check itself failed |
| `2` | A usage error |

**A direct-mode HTTPS install may read `unknown` on its routes row.** The routes row compares
Tailscale's serve routes with TangleClaw's port leases, which it reads with one loopback request to
`127.0.0.1`. The check verifies that request's certificate as Node does, with no insecure retry. When
Node cannot validate it, the row reads `[unknown] Observed routes: lease comparison: tls-unverified`,
and the routes themselves are still listed. This is the check refusing to read lease data over a
connection it cannot verify. On its own it is not a diagnosis.

`tls-unverified` means only that validation failed. Common causes include:
- Node not trusting the root that issued the certificate;
- an expired certificate;
- a certificate that does not carry `127.0.0.1`;
- another validation failure.

Diagnose which one before acting: check the certificate's trust, its validity dates, and the names
it carries. The host check reads certificates only through the Caddyfile's sites, so on a direct-mode
install with no Caddyfile it shows none of these. Check them by hand on the certificate TangleClaw
serves, the file `httpsCertPath` names in the configuration. Do not re-mint because of this row alone.

## On the new machine: diagnose first, then change only what a row shows

Run the host check before changing anything. Every change below is **conditional**: make it only when
a host-check row shows the problem, and only with the operator's approval. Each change starts with a
snapshot of the exact state it replaces, and its rollback restores that exact state, not an
approximation of it.

| Change | Make it when | Snapshot first | Rollback restores |
|---|---|---|---|
| Re-trust the existing local CA | The trust row is `drift` and says `trusted: no (CSSMERR_TP_NOT_TRUSTED)` | The CA root's current trust settings, exported: the user-domain settings, and any domain the re-trust will write | Those exact settings, re-imported. Not merely removing the new entry |
| Mint a new certificate from the same CA | The coverage row is `drift`: a site is not covered by its own certificate, or the certificate row shows it expired | The certificate and key files, byte for byte, kept with private permissions | Those files, checked by hash |
| Change a Tailscale serve route | The routes row lists a route that is wrong for this machine | The full output of `tailscale serve status --json` | That exact configuration, checked by reading it back |
| Change the Caddyfile (today, a hand edit) | The Caddyfile or coverage row is `drift` or `ambiguous` | The file, byte for byte | That file, then a Caddy-only restart and a health check |

The certificate, coverage and trust rows read certificates through the Caddyfile's sites. On a
direct-mode install with no Caddyfile they report `observed` (nothing to compare), so these triggers
never fire there.

How each change is made:
- **Re-trust:** `mkcert -install` in a terminal. It asks for an administrator password. Then restart
  the browser that opens the dashboard.
- **Mint:** `POST /api/setup/generate-cert`, which mints from the same local CA. A name to add goes in
  `{"hosts": [...]}`. Moving the canonical tailnet name has its own steps: see `caddyTailnetHost` in
  [the configuration reference](configuration-reference.md) and [deploy/INGRESS.md](../deploy/INGRESS.md).
  In Caddy mode, Caddy picks the new certificate up on a Caddy-only restart. In direct mode, TangleClaw
  serves the certificate it loaded when it started, and this guide prescribes no TangleClaw restart:
  that restart is a separate, approved step.
- **Caddyfile:** before any Caddy-only restart, have three things in place:
  - a tested recovery path that does not depend on TangleClaw or on Caddy answering (for example, a
    terminal on the machine itself);
  - a plan for checking the result, both on the machine and from another device;
  - a plan for restoring the snapshot if either check fails.

  `caddy validate` only checks that the file parses. It does not prove that you will still be able to
  reach the service after the restart. Then check the edited file, and restart Caddy alone:

  ```sh
  caddy validate --config ~/.tangleclaw/Caddyfile --adapter caddyfile
  launchctl kickstart -k gui/$(id -u)/com.tangleclaw.caddy
  ```

  A hand-edited Caddyfile is no longer the generated one: the host check reports its origin as
  `hand-edited`. A later cutover refuses to overwrite it, and its `--force` replaces the file whole,
  dropping your edits.

Never:
- a blanket reset;
- a re-mint nobody diagnosed;
- a TangleClaw server restart as a way to "see if it helps".

The host check itself performs none of these changes: no certificate, trust, route, Caddyfile or
rollback action. It only reads.

## Proof, for every name

A name is done only when all of these pass for it, checked from **another device**:
- an unauthenticated HTTP request is refused;
- an unauthenticated WebSocket is refused;
- an authenticated HTTP request succeeds in the operator's browser;
- an authenticated WebSocket (a terminal) connects in the operator's browser.

An item you did not check stays pending. It is not a pass.

## Renaming

Do not rename anything until both the old and the new name resolve from another device and pass the
proof above.

Keeping `<old-name>.<tailnet>.ts.net` resolving after a rename needs something at the DNS layer: another
node that keeps the old name, Tailscale Services, or another DNS record. A certificate or Caddy alias
cannot do it (see "Two layers"). This guide names those options but does not prescribe one.

## After the move

1. Confirm the Tailscale identity:
   - **After a planned move:** the source and the destination are different nodes. Confirm the
     destination is the one meant to serve the service name.
   - **During clone recovery:** only one machine holding the shared identity may be **online**. The
     source stays offline; nothing is logged out or revoked.
   - **At the end of clone recovery:** after the source is wiped and the destination is re-keyed,
     confirm that exactly one machine holds the identity, and that the source is gone from the tailnet.
2. Confirm the service name resolves the same way from every network you intend to use.
3. Check service status and logs for start-up failures, trust errors, stale paths and port conflicts.
4. Reconcile worktrees without deleting a branch or a file until its owner confirms it can go.
5. Watch the service name and any alias through a defined soak period.
6. Retire the source only after the soak passes: stable name, certificate and login checks, no
   unexplained service errors, a tested recovery path and an accepted checkpoint.
7. After a planned move with a fresh identity, no re-key is needed: update the certificates, serve
   routes and recovery records for the new identity. After an accidental clone, re-key the destination
   only once the source is wiped and cannot rejoin.

## When to roll back

Roll a staged change back to its snapshot if:
- the certificate does not validate;
- it is unclear which site or route answers a name;
- an authenticated HTTP or WebSocket check fails;
- an unauthenticated request succeeds;
- you cannot complete the check from another device;
- the recovery path is unavailable;
- service health gets worse for a reason you do not understand.

Then run the host check and the proof again before retrying.

## Today's limits

- The Caddyfile generator emits one tailnet name. Serving more than one tailnet name from it waits on
  later work.
- A hand edit makes the Caddyfile non-generated. A cutover then refuses to overwrite it unless forced,
  and a forced cutover drops the edit.
- A project's own Tailscale HTTPS route on another port is valid, and the host check lists it as an
  `observed` route.

## Safety rules

- Never log out of, or revoke, a Tailscale identity that two machines share. Do not rename a shared
  identity casually either.
- Do not delete old configuration or generated records just because they mention the old name.
- Treat ingress, credentials, service restarts and account changes as explicit approval gates.

See also: [Getting back into TangleClaw](recovery.md), [Ingress modes](../deploy/INGRESS.md).
