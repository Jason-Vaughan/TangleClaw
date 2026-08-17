# Build plan — First-run must not dead-end (v5 release scope)

**Issue:** #859 (the scan wedge) opened this; tracing the first-run path found three more
ways a brand-new install stops with no way forward. All of it ships in v5.

**Branch:** `fix/859-first-run-hardening` · **Critic mode:** cumulative

## The requirement, stated

A person installing TangleClaw for the first time is at their own Mac, in a terminal and a
browser on that machine. **The wizard must never leave them at a step with no action available
inside the product.** Where the product cannot fix something itself, it says exactly what to
run, and re-checks on demand.

New product rule, ratified in conversation 2026-08-06: **setup cannot be completed with no
LLM engine installed.** TangleClaw orchestrates engines; an install with none is a product
that cannot do its one job. The wizard parks until at least one is present.

## Slices

### 1. Detection must see the operator's PATH (#346) — PREREQUISITE

`_detectWhich` runs `which <target>` in the server's own environment. The server is
launchd-spawned, so `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin` — nothing from npm-global, nvm,
volta, Homebrew or `~/.local/bin`. An installed engine reports "not installed".

Today that is cosmetic. Slice 2 turns it into a first-run brick, so it lands first.

- Resolve the login shell's PATH ONCE per probe cycle (`$SHELL -lc`), cache it, and use it for
  every engine — one shell spawn, not one per engine.
- **Augment, never replace**: merged PATH = login PATH + the server's own. An engine detected
  today must still be detected.
- Bounded: a login shell that hangs on a profile must not hang the server.
- Explicit re-check busts the cache — that is the whole point of "Check again".

**Done when:** an engine on the login PATH but not the launchd PATH is detected; nothing
previously detected stops being detected; a hanging shell degrades to the old behaviour.

### 2. Setup parks until an engine exists

- The engine step blocks Next while zero engines are detected.
- A park screen states what is missing, why it is needed, the exact install command per engine
  with a Copy button, and a **Check again** button that re-probes (cache-busting).
- **`POST /api/setup/complete` refuses too.** The button is not the rule; a client that skips
  the step must not finish setup either.

**Done when:** zero engines cannot reach the dashboard by any route; installing one and
pressing Check again releases the gate without a page reload.

### 3. A missing projects directory offers to create itself

`~/Documents/Projects` does not exist on a stock Mac and nothing creates it, so the default
path dead-ends at step 2 with an accurate, useless message.

- The "does not exist" error gains a **Create it** button.
- New route creating ONE directory, constrained: resolves under `$HOME`, no traversal, parent
  must exist, no recursive creation of an arbitrary tree.
- Pre-auth by necessity (first run has no credential), so the constraint IS the security
  boundary — write it as such and test it as such.

**Done when:** the default path on a fresh Mac is one click from working; a traversal or
outside-`$HOME` path is refused.

### 4. mkcert: unknown is not absent

`renderHttpsSetup` sets `mkcertAvailable = false` when the probe FAILS, rendering "mkcert not
installed" to someone who has it — an unknown reported as a known absence (#861's shape).

- Distinguish probe-failed from probe-said-no.
- Where genuinely absent: the install command, a Copy button, and Check again.
- **Non-blocking** (unlike slice 2): TangleClaw runs over plain HTTP on localhost, and the
  login gate is a separate mechanism. A loud caution, not a wall.
- The server does NOT install it: a launchd daemon has no TTY, `brew install` can prompt and
  `mkcert -install` needs sudo. Privileged/interactive work stays in the human-run installer
  (ratified after #397/#399).

**Done when:** a failed probe never claims mkcert is absent; a real absence gives a runnable
command; the server never shells a privileged install.

## Out of scope, deliberately

- Converting the rest of the synchronous project-path readers (`continuity.listSessions` and
  friends) — filed separately; the answer there is not to default `projectsDir` into the
  TCC-protected tree at all.
- Installing engines or mkcert on the operator's behalf.
