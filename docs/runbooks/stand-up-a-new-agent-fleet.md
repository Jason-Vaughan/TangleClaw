# Stand up a multi-agent TangleClaw development fleet

Tier 2. Owner: the operator. Steps 1, 4 and 7 create directories; steps 5–11 mutate durable
TangleClaw state. **Step 3 is a live cutover of the host's control-plane daemon — it is the only
step that interrupts the running fleet, and the only one with a rollback of its own (3b).**

**This provisions a fleet that develops TangleClaw itself**, or a compatible fork. It is not a
generic fleet procedure: phase 1 repoints `com.tangleclaw.server`, which only makes sense when the
product *is* the control plane. A fleet building some other product needs a shared runtime only if
that product has one, and its launch mechanism will not be this.

## When to use this

You are starting a TangleClaw development project that several agents will work on at once — a PM,
an Architect, some Builders, a PR reviewer — on a machine that already runs TangleClaw.

**Not this runbook:** adding one agent to a fleet that already exists — see
[Adding one agent later](#adding-one-agent-later).

## Before you start

- `echo $TANGLECLAW_API` prints a URL. If it is empty you are not in a launched pane.
- Choose the fleet prefix now (`Acme` below). **Renaming a project later rotates its switchboard
  workspace id and silently orphans mail sent to the old one.**
- Phase 1 is the recommended first phase and a **hard gate before concurrent Builder dispatch or
  any smoke test against the shared server**. Naming projects, writing canon, provisioning agents
  and isolated work that does not touch the shared runtime may precede it.

## Phase 1 — the shared runtime

1. Clone into a directory **no agent will ever work in**:
   `git clone https://github.com/Jason-Vaughan/TangleClaw.git ~/Documents/Projects/Acme-Core`
   Expected: the final line reads `Resolving deltas: 100% (…), done.`

2. Record what you are about to change, and back it up to **one named file**. Absolute paths only —
   launchd does not expand `~`, and neither does PlistBuddy inside a quoted argument:

   ```sh
   CORE_DIR="$HOME/Documents/Projects/Acme-Core"
   PLIST="$HOME/Library/LaunchAgents/com.tangleclaw.server.plist"
   BACKUP="$PLIST.bak.$(date +%Y%m%dT%H%M%S)"
   cp -p "$PLIST" "$BACKUP" && cmp "$PLIST" "$BACKUP" && echo "BACKUP_OK $BACKUP"
   OLD_WD=$(launchctl print gui/$(id -u)/com.tangleclaw.server | grep 'working directory'); echo "$OLD_WD"
   curl -fsS -o /dev/null -w 'health %{http_code}\n' "$TANGLECLAW_API/api/health"
   ```
   Expected — all of:
   - `BACKUP_OK` followed by the backup path (`cmp` printing nothing means it matched)
   - the `working directory` line names the **current** checkout — this is your rollback target
   - `health 200`

   **Abort if `BACKUP_OK` did not print, or health is not 200.** Do not cut over onto an already
   broken runtime — afterwards you cannot tell your damage from what was there.

3. **Cut over. This stops the daemon the whole fleet depends on.** Validate a *candidate* copy and
   only then replace the live plist — PlistBuddy edits in place, so validating after the edit
   leaves an invalid live plist on disk:

   ```sh
   CAND="$(mktemp -t tcplist)" && cp -p "$PLIST" "$CAND" \
     && /usr/libexec/PlistBuddy -c "Set :WorkingDirectory $CORE_DIR" "$CAND" \
     && plutil -lint "$CAND" \
     && cp -p "$CAND" "$PLIST" && echo "PLIST_REPLACED"
   ```
   Expected: `plutil -lint` prints `… : OK`, then `PLIST_REPLACED`.
   If either is missing: the live plist is untouched and the daemon is still up — fix the candidate
   and repeat this step. Do not proceed.

3a. Reload, then poll until both conditions hold or the window expires:

   ```sh
   launchctl bootout gui/$(id -u)/com.tangleclaw.server 2>/dev/null
   launchctl bootstrap gui/$(id -u) "$PLIST"
   for i in $(seq 1 30); do
     WD=$(launchctl print gui/$(id -u)/com.tangleclaw.server 2>/dev/null | grep 'working directory')
     HC=$(curl -s -o /dev/null -w '%{http_code}' "$TANGLECLAW_API/api/health")
     case "$WD:$HC" in *Acme-Core*:200) echo "CUTOVER_OK"; break;; esac
     sleep 1
   done
   ```
   Expected: `CUTOVER_OK` within the loop.
   If the loop ends without it: **roll back now with step 3b.**

3b. **Rollback.** Best-effort bootout — the job may be absent if the bootstrap failed, and that is
   not an error here:

   ```sh
   launchctl bootout gui/$(id -u)/com.tangleclaw.server 2>/dev/null
   if cp -p "$BACKUP" "$PLIST" && plutil -lint "$PLIST"; then
     launchctl bootstrap gui/$(id -u) "$PLIST"
     for i in $(seq 1 30); do
       WD=$(launchctl print gui/$(id -u)/com.tangleclaw.server 2>/dev/null | grep 'working directory')
       HC=$(curl -s -o /dev/null -w '%{http_code}' "$TANGLECLAW_API/api/health")
       if [ "$WD" = "$OLD_WD" ] && [ "$HC" = "200" ]; then echo "ROLLBACK_OK"; break; fi
       sleep 1
     done
   else
     echo "BACKUP_INVALID — stop here, do not bootstrap, call the operator"
   fi
   ```
   Expected: `ROLLBACK_OK`.
   If `BACKUP_INVALID` printed: nothing further in this block ran, and the daemon is down with an
   unusable backup. Stop and call the operator — do not improvise a plist.
   If the loop expired with neither: the old runtime did not come back. Stop and call the operator.

   > The poll matches 3a's deliberately: an immediate `launchctl`/`curl` can report failure while
   > the old server is still starting, and a rollback that reports false failure invites a second,
   > worse intervention.

   Do not re-attempt the cutover until you know why it failed.

## Phase 2 — the agents

4. Resolve the configured projects directory, then clone one per role into it. Do not assume
   `~/Documents/Projects` — that is only the default, and the store records a tilde it does not
   expand for you:

   ```sh
   PROJECTS_DIR=$(curl -fsS "$TANGLECLAW_API/api/config" \
     | python3 -c 'import json,sys;print(json.load(sys.stdin)["projectsDir"])')
   PROJECTS_DIR="${PROJECTS_DIR/#\~/$HOME}"
   case "$PROJECTS_DIR" in /*) [ -d "$PROJECTS_DIR" ] && echo "PROJECTS_DIR_OK $PROJECTS_DIR";; esac
   ```
   Expected: `PROJECTS_DIR_OK` followed by an absolute path that exists.
   If nothing prints: the path is relative or missing — resolve it with the operator before cloning.

   ```sh
   for role in PM Architect Builder1 Builder2 Builder3 Reviewer; do
     git clone https://github.com/Jason-Vaughan/TangleClaw.git "$PROJECTS_DIR/Acme-$role" || break
   done
   ```
   Expected: six clones, each ending `done.` The `|| break` stops the loop on the first failure
   rather than leaving a half-built fleet behind a wall of output.

5. Attach each directory as a project — **attach, not create.** `POST /api/projects` makes and
   scaffolds its own directory, so it cannot take one that already holds a clone:

   ```sh
   for role in PM Architect Builder1 Builder2 Builder3 Reviewer; do
     curl -fsS -X POST "$TANGLECLAW_API/api/projects/attach" \
       -H 'Content-Type: application/json' -d "{\"name\":\"Acme-$role\"}" || break
     echo
   done
   ```
   Expected: six responses, each carrying an `"id"`.
   If the loop stops early: the last line printed is the failure — a `"code":"CONFLICT"` means that
   name is already registered, so pick another and re-run for the remaining roles.

   > `|| break` before the `echo`, not after: a trailing `; echo` becomes the loop body's last
   > command and returns 0, so the loop would sail past a failed attach. `-f` surfaces the failure;
   > it does not stop the loop. The same applies to every loop below.

6. Set each project's engine, because attach resolves the installed default rather than your
   intent: `PATCH $TANGLECLAW_API/api/projects/Acme-<role>` with `{"engine":"claude"}`.
   Expected: `curl -fsS "$TANGLECLAW_API/api/projects" | grep Acme-` shows the engine you chose.

## Phase 3 — canon and guardrails

7. Create the canon directory and the group in one step. **Absolute path — the store does not
   expand `~`:**

   ```sh
   mkdir -p "$HOME/Documents/Projects/Acme-Shared"
   GID=$(curl -fsS -X POST "$TANGLECLAW_API/api/groups" -H 'Content-Type: application/json' \
     -d "{\"name\":\"Acme-Shared\",\"sharedDir\":\"$HOME/Documents/Projects/Acme-Shared\"}" \
     | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
   curl -fsS "$TANGLECLAW_API/api/groups/$GID"
   ```
   Expected: the response contains `"sharedDir"` with the absolute path you set.
   If it is absent or empty: set it with `PUT $TANGLECLAW_API/api/groups/$GID` and body
   `{"sharedDir":"<absolute path>"}`, then re-read.

8. Add every project from step 5 — `POST $TANGLECLAW_API/api/groups/$GID/members` with
   `{"projectId": <id>}` for each.
   Expected: `curl -fsS "$TANGLECLAW_API/api/groups/$GID/members"` lists all six.

9. Put the fleet canon (`.md` files) in the shared directory, then register it:
   `curl -fsS -X POST "$TANGLECLAW_API/api/groups/$GID/sync"`
   Expected: the response names each `.md` file found.
   If it returns `"Group has no sharedDir configured"`: step 7's verification was skipped — go back.

10. Give **each** fleet project its own copy of the live-checkout rule naming `Acme-Core`, via the
    dashboard's rules panel or `POST $TANGLECLAW_API/api/session-rules`.
    Expected: `tc rules` in a launched pane of each project prints it.

    > Repeating it per project is correct, not duplication. Global Rules bind *every* project on
    > this install, which this does not; a shared doc is canon, not a Project Rule. Until
    > group-scoped rule enforcement exists, a binding fleet directive has to be carried per project.
    > **Approving a replacement rule does not retire the one it replaces (#1696)** — disable the old
    > one explicitly, or both are delivered and they will contradict each other.

10a. Nominate exactly **one Integration/Release Owner** — normally the Reviewer, if the operator
    assigns that duty. Set `releaseMode` on every project accordingly, via
    `PATCH $TANGLECLAW_API/api/projects/Acme-<role>`:

    | project | `releaseMode` | why |
    |---|---|---|
    | the release owner | `ask` | authors the version bump, with a prompt rather than silently |
    | every other project, **including PM and Architect** | `off` | they contribute changelog entries, never version files |

    Verify against the group's **actual members**, not a name prefix, and read the mode from
    `GET /api/projects` — the PATCH response omits `releaseMode`, so it cannot confirm this:

    ```sh
    curl -fsS "$TANGLECLAW_API/api/groups/$GID/members" -o /tmp/tc-members.json
    curl -fsS "$TANGLECLAW_API/api/projects" -o /tmp/tc-projects.json
    python3 - /tmp/tc-members.json /tmp/tc-projects.json <<'EOF'
    import json,sys
    members=json.load(open(sys.argv[1]))["members"]
    projects={p["id"]:p for p in json.load(open(sys.argv[2]))["projects"]}
    missing=[m["id"] for m in members if m["id"] not in projects]
    rows=[(m["name"], projects[m["id"]].get("releaseMode")) for m in members if m["id"] in projects]
    for n,mode in rows: print(f"  {n}: {mode}")
    owners=[n for n,mode in rows if mode in ("ask","auto")]
    bad=[(n,mode) for n,mode in rows if mode not in ("ask","auto") and mode != "off"]
    if missing or len(owners)!=1 or bad:
        print("OWNER_CONFLICT", {"unresolved":missing,"owners":owners,"not_off":bad}); sys.exit(1)
    print("OWNERS_OK")
    EOF
    ```
    Expected: each member listed with its mode, then `OWNERS_OK`.
    If `OWNER_CONFLICT` prints, the payload says which of the three conditions failed — a member id
    that resolves to no project, more or fewer than one owner, or a non-owner whose mode is not
    `off` (a `null` or unrecognised mode counts). Fix it before any Builder wraps.
    Valid values are `off`, `auto`, `ask`; anything else is treated as `ask` with a warning, which
    is itself how a second owner appears by accident.

    Leave changelog updating **enabled everywhere**: each Builder still writes its own entry under
    `[Unreleased]`. Only the promotion of those entries and the `version.json` bump belong to the
    owner, who updates from `origin/main` and opens one release PR. When it merges,
    `.github/workflows/release.yml` tags and publishes — it triggers on `version.json` changing on
    `main`, not on a wrap having run.

    Core then promotes to **either a published tag or an exact accepted `main` SHA** — a release is
    the production-grade path, an accepted SHA is the integration path for shared smoke-testing
    before a release exists. Record the SHA either way. Core authors neither.

    > **This is convention, not enforcement.** Nothing in the product stops a second project being
    > set to `ask` or `auto`, and `version-bump` compares against the *local* changelog rather than
    > `origin/main` — so two owners produce colliding bumps that surface as merge conflicts. One
    > owner is the whole mechanism. Group-aware release ownership is filed as **#1697**.
    >
    > This is not hypothetical: the first run of this check against TangleClaw's own fleet found
    > **three** owners (2026-09-20). Run it on an existing fleet, not only a new one.

11. Register any port a fleet service will bind, before binding it:
    `POST $TANGLECLAW_API/api/ports/lease` with
    `{"port":<n>,"project":"Acme-<role>","service":"<what>"}`
    Expected: HTTP `201`. On `409` the response names the current owner — pick another port in the
    same range.

## Done when

- `launchctl print gui/$(id -u)/com.tangleclaw.server | grep 'working directory'` names `Acme-Core`.
- `curl -s -o /dev/null -w '%{http_code}\n' "$TANGLECLAW_API/api/health"` prints `200`.
- `curl -fsS "$TANGLECLAW_API/api/groups/$GID/members"` lists every fleet project.
- `tc rules` in one Builder's launched pane prints the live-checkout rule, and it names `Acme-Core`
  — not that Builder's own path.
- 10a's check prints `OWNERS_OK`: **exactly one** group member is `ask` (or `auto`) and every other
  member is `off`. Inspecting a single project does not establish this.

## Adding one agent later

Steps 4 (one clone), 5 (attach), 6 (engine), 8 (group membership), 10 (the rule) **and 10a**. The
group and the runtime already exist; do not repeat phases 1 or 7.

**10a is not optional here.** A newly attached project takes the installed default `releaseMode`,
which may not be `off` — that is exactly how the second release owner #1697 warns about appears.
Set the new project to `off` explicitly and re-run 10a's `OWNERS_OK` check across the whole group.
Only an operator-approved transfer of release ownership makes a new agent anything but `off`, and
that transfer must set the outgoing owner to `off` in the same change.

## If this doesn't work

**Before any agent has worked in the fleet**, a failed bootstrap is safe to unwind: roll back the
plist per step 3, then delete the clones and their projects.

**Once any agent has worked**, deleting directories destroys unpushed work and is not a rollback.
Roll back only the step that failed, leave the rest, and ask the operator.

If reality does not match this document — a route 404s, a field is rejected — stop and say so
rather than improvising. This procedure is derived from one install and the routes can move.

---

## Why it is shaped this way

**Core is a promotion target, not a collaborator.** No agent session works there. It advances only
from a named accepted commit or release, with a health check and a rollback. A separate clone alone
does not stop drift without those ownership rules.

**Core gates concurrency, not bootstrap.** It must exist before concurrent fleet execution against
the shared server — retrofitting means unwinding path assumptions every role has already learned.
That is #1672, still open on this install.

**One clone per agent** — isolation from shared repo-wide mutable state, and a smaller failure
radius. Worktrees stay a single agent's tool for its own branches.

Roles are convention: the `projects` table has no role column, so nothing stops a Builder editing
Core. Train 22 decides the agent-role model.

> 🚧 **UNVERIFIED** — no fleet has been stood up with this procedure end to end. Commands are
> derived from this install (`server.js` routes, `lib/projects.js`, `lib/launchagent-scan.js`), and
> the step 3 reload shape follows the repository's documented bootout/bootstrap rather than the
> `kickstart` used ad hoc on 2026-09-20. Execute it once, on a disposable fleet name, before
> relying on it.
