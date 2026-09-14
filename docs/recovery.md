# Getting back into TangleClaw

Start here when you cannot sign in, or cannot reach TangleClaw at all. Find your symptom in the
table, then follow its section. Commands run **at a terminal on the machine TangleClaw runs on**,
from the TangleClaw folder. SSH from a phone works. The one exception is a recovery code, which works
from anywhere.

Paths assume the default TangleClaw home, `~/.tangleclaw`. If you set `TANGLECLAW_HOME`, use that
instead.

## Which password is asking?

TangleClaw can have two logins in front of it, and they are recovered differently:

- **TangleClaw's own sign-in page**: a page with username and password fields and a "Forgot your
  password?" link. This is the login on a current install. Its passwords live in TangleClaw's
  database, one per account.
- **Caddy's password**: a small browser pop-up that asks for a username and password before any page
  loads. It exists only when the Caddy ingress carries `basic_auth`: on an install that has not yet
  created its first account, during a fallback, or on an older install upgraded before its Caddy
  password was taken out. On an install whose own login guards it, there is none.

## Symptoms

| What you see | Go to |
|---|---|
| The sign-in page, and you forgot your password | [Forgot your password](#forgot-your-password) |
| The sign-in page says every account is disabled | [Every account is disabled](#every-account-is-disabled) |
| The sign-in page says TangleClaw cannot read its login settings | [The login settings cannot be read](#the-login-settings-cannot-be-read) |
| A page asking you to create the first account | [No account yet](#no-account-yet) |
| You can sign in, but the login misbehaves (errors, loops, crashes) | [The login itself is broken](#the-login-itself-is-broken) |
| The browser pop-up, and you forgot that password | [Forgot Caddy's password](#forgot-caddys-password) |
| Nothing loads at all | [Nothing loads](#nothing-loads) |

To see which state the login is in, ask TangleClaw from the machine itself:

```sh
curl -s http://127.0.0.1:<port>/api/auth/me
```

`<port>` is `serverPort` in `~/.tangleclaw/config.json`. The answer's `gateState` is one of `armed`
(the login works), `locked`, `unreadable`, `account-required`, `fallback`, or `open` (no login is
asked for).

## Forgot your password

**With a recovery code**, from any device: on the sign-in page choose **Forgot your password? Use a
recovery code**, enter one code and a new password. You are signed in, every other browser on that
account is signed out, and the dashboard shows a notice that a code was used. Each code works once.
The link appears only while the login is working (`armed`), the one state a code can succeed in.

**At the terminal**, whether or not you have codes:

```sh
node scripts/reset-admin.js --store --user <name>
```

It asks for the new password twice. It also:

- signs out every browser on that account, so someone holding a stolen session loses it;
- **deletes that account's recovery codes**, so a code someone copied cannot reset the password
  again. Sign in and generate a new set in **Settings → Recovery codes**;
- re-enables the account if it was disabled;
- prints what the login does afterwards. If it says `authEnabled is OFF` and `NO login is enforced`,
  nothing asks for a password; if it names Caddy's password as the only login, that pop-up is what
  protects the install until `authEnabled` is turned on.

Add `--dry-run` to see what it would do without changing anything. The password rules are the same
everywhere: at least 12 characters, not a common password, not containing the username.

## Every account is disabled

The login is `locked`: accounts exist, none can sign in, and a recovery code cannot turn one back on,
because a disabled account is meant to stay off until someone at the machine turns it back on.
TangleClaw has no command to disable an account yet (#1458), so an install reaches this state only
through an edit to its database. Re-enable an account at the terminal by resetting it:

```sh
node scripts/reset-admin.js --store --user <name>
```

The password changes first and the account is re-enabled after, so it is never live under its old
password. The account comes back with no recovery codes.

## The login settings cannot be read

The login is `unreadable`: TangleClaw could not read its config file or its database. It refuses every
sign-in rather than guess, because a login that fails open would hand out shells.

1. Look for the reason in `~/.tangleclaw/logs/tangleclaw.log`. Lines starting `Auth gate could not
   read` name what failed.
2. Fix that: a missing or malformed `~/.tangleclaw/config.json`, or a database file with the wrong
   owner or permissions. A missing `config.json` also refuses: TangleClaw writes one when it starts,
   so a missing file means something removed it.
3. The next request reads it again. There is no restart and nothing to clear.

Setting `authEnabled: false` does not help here, because it is in the file that cannot be read. If you
cannot fix the read, fall back to Caddy's password (next section but one).

## No account yet

The login is `account-required`: no account exists yet, so anyone who can reach this page can create
the first one. Create it on the page, or at the terminal:

```sh
node scripts/reset-admin.js --store --user <name>
```

On the page, if Caddy's password also stands in front, use one browser tab and close the others: a
TangleClaw tab that is not signed in can make the browser ask for Caddy's password over and over.

Then generate recovery codes in **Settings → Recovery codes** (an account created at the terminal has
none).

**If the page answers that this install has had an account** (`ACCOUNT_STORE_LOST`), its account
store was lost — a database deleted, recreated or restored from before the first account — and the
Caddyfile may no longer carry a password of its own. The first account can then only be created from
the machine itself, so nobody else who reaches the page can claim the install: run the
`reset-admin.js --store` command above over SSH. The record that an account existed is the file
`~/.tangleclaw/accounts-established`; leave it in place.

## The login itself is broken

When TangleClaw's own login is what broke (errors, a sign-in loop, a crash on the login path), put
Caddy's password back in front of TangleClaw and let TangleClaw stand down:

```sh
node scripts/gate-fallback.js --dry-run
node scripts/gate-fallback.js
```

Sign in with the Caddy username and password. Once the login works again:

```sh
node scripts/gate-fallback.js --undo
```

The fallback refuses rather than leave a door open. It needs TangleClaw listening only on this
machine, and a Caddyfile that puts Caddy's password in front of every route to TangleClaw. A
hand-maintained Caddyfile is never rewritten, so keep a gated copy ready for `--restore`. What it
checks, its exit codes, and how to rehearse it are in the
[Ingress Guide](../deploy/INGRESS.md#when-tangleclaws-login-is-broken-fall-back-to-caddys-password).

## Forgot Caddy's password

Only when the browser pop-up is asking. At the terminal:

```sh
node scripts/reset-admin.js --dry-run
node scripts/reset-admin.js
```

It patches the password in the Caddyfile, checks the file with `caddy validate` (putting the old one
back if that fails), and restarts Caddy, so **the connection drops for a few seconds**. Run it from a
shell that survives that: TangleClaw's browser terminal already runs in `tmux`, but open a fresh window
(`Ctrl-b` then `c`) if the current one is running an AI session.

If it answers that the install's login is its TangleClaw account, there is no Caddy password to reset.
Use `--store`, above. Details and the rarer failure messages are in the
[Ingress Guide](../deploy/INGRESS.md#admin-credential-reset-break-glass-auth-2).

## Nothing loads

On macOS, TangleClaw, Caddy and the terminal service are LaunchAgents. Check them from the machine:

```sh
launchctl list | grep -i tangleclaw                 # a number in the first column = running
curl -s http://127.0.0.1:<port>/api/health          # TangleClaw itself: expect a JSON answer
```

- **TangleClaw is not answering**: `launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server`, then
  read `~/.tangleclaw/logs/tangleclaw.log`.
- **TangleClaw answers but the address you use does not** (caddy ingress):

  ```sh
  caddy validate --config ~/.tangleclaw/Caddyfile --adapter caddyfile
  launchctl kickstart -k gui/$(id -u)/com.tangleclaw.caddy
  tail -30 ~/.tangleclaw/logs/caddy.err.log
  ```

  A Caddy that stops right after `started background certificate maintenance` without listening
  usually cannot read its certificate. Certificates must live outside `~/Documents`, which macOS
  blocks background services from reading.
- **Pages load but terminals do not connect**: `launchctl kickstart -k gui/$(id -u)/com.tangleclaw.ttyd`.

## Turning the login off

`authEnabled: false` in `~/.tangleclaw/config.json` turns TangleClaw's login off on the next request,
with no restart. That is the deliberate opt-out, and it has one limit. In caddy ingress mode it does
**not** open an install whose Caddyfile serves other machines without a Caddy password of its own:
there the accounts still decide, because turning the login off would leave those sites with nothing in
front of them. It also does not open an install that has accounts and a `localhost` site missing its
guard against other machines. `reset-admin.js --store` reports which of these applies.
