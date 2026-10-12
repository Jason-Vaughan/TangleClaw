# Check watches

*Being built (#2323). A session can register a watch, read it back and cancel it. **Nothing reads
GitHub for a watch yet, and nobody is woken:** a watch reads `waiting` until its due time and
`unknown` after it, whatever the check did. Every answer says so (`monitored: false`). There is no
screen. This page grows with each part as it lands.*

## What a watch is

A watch is a session's request to be told when one named check finishes on one exact commit of a
pull request. It records:

- the project it belongs to, and the session and launch that registered it;
- the repository, the pull request number, the commit (all 40 characters) and the check's name,
  exactly as GitHub shows it;
- a due time, after which silence is itself reported.

The watch belongs to the **project**, not to the launch that registered it, so it is still there
after the session is cleared or relaunched, and after the server restarts.

The repository is never taken from the caller. It is the `origin` remote of the project's own
folder, read by the server with `git`, and it must be on github.com. A project whose folder has no
such remote cannot register a watch (`CHECK_WATCH_REPO_UNKNOWN`).

## The four states

The state is worked out from the record on every read and is never stored.

| State | Means |
|---|---|
| `waiting` | No result is recorded, the last read of GitHub worked (or none has been made), and the due time has not passed |
| `ready` | The recorded result is `success` |
| `failed` | The recorded result is any other conclusion GitHub gives a finished check |
| `unknown` | The server cannot say. `reasons` says why |

**`unknown` is not `failed` and is not done.** A session that reads it must not treat the check as
concluded either way; it reads the check itself. The reasons, of which more than one can hold:

| Reason | Means |
|---|---|
| `past-due` | The due time passed with no result recorded |
| `read-failed` | The last read of GitHub failed, so "still running" cannot be vouched for |
| `cancelled` | The watch was cancelled and is not read again |
| `expired` | The watch ended unresolved and is not read again |
| `unreadable` | The record or a time in it cannot be made sense of |

`ready` and `failed` come only from a recorded result. A watch is **open** while it has no result,
is not cancelled and has not expired. A watch past its due time is still open: a late result is
still its result.

## Who may do what

| Who | May |
|---|---|
| A verified live launch | register a watch for its own project; cancel a watch of its own project; read |
| A project that shares a group with the watch's project | read |
| The Operator | read |
| Anyone else | nothing. A watch they may not read does not exist for them (`404`) |

"Verified live launch" means the request carries `x-tangleclaw-project-id` and
`x-tangleclaw-launch-id` of that project's active session; `tc` sends them. The Operator cannot
register or cancel a watch (`CHECK_WATCH_LAUNCH_ONLY`): a watch says which project's session is to
be woken, and only that project can say it wants to be. A held or stopped lane may still register,
read and cancel: a watch changes nothing outside its own record.

No answer carries a launch id.

## The routes

```
POST /api/tc/check-watches               {prNumber, headSha, checkName, dueInMinutes}   a launch, for its own project
GET  /api/tc/check-watches[?projectId=]  a project's watches, newest first, each with its state
GET  /api/tc/check-watches/:id           one watch, its state and its history
POST /api/tc/check-watches/:id/cancel    {}                                             a launch of the watch's project
```

They are part of the unversioned `/api` family and refuse with its `{error, code}` body. A launch
that sends no `projectId` reads its own project's watches; the Operator must name one. A list
shows the newest 50 and says how many there are in `total`.

`dueInMinutes` is a whole number of minutes from now, counted on the server's clock. A time named
by the caller is not taken.

## From a pane: `tc check`

```
tc check watch <pr> --sha <sha> --name <check> --due <minutes>
tc check list [--project <id>]
tc check show <watch>
tc check cancel <watch>
```

`watch` prints the new watch's id. `list` shows the pane's own project's watches, or those of the
project named, if this project shares a group with it. `show` adds the last read of GitHub and the
watch's history. A refusal exits 2 with the server's code and words; a malformed command exits 1
before any request. The verb is not in the list every pane is primed with: `tc` with no verb lists
it.

## Limits

- **Every watch has a due time**, from 1 minute to 24 hours ahead (1440 minutes).
- **A project holds at most 20 open watches**, and one open watch per check name on a commit. A
  watch that has its result, was cancelled or expired frees its place.
- **A check name is at most 100 characters**, with no surrounding space or control character.
- **Neither table is pruned.** `check_watches` and `check_watch_facts` keep every watch and every
  fact of its history. The limit of 20 bounds open watches only, so the tables grow with use.
- **Registering reads the project folder's `origin` with `git`**, bounded at four seconds. A read
  that does not finish refuses the registration (`503 CHECK_WATCH_REPO_UNREADABLE`); nothing was
  registered, and it can be repeated.
- **Nothing checks that the pull request exists, that the commit is its head, or that a check of
  that name ever runs.** A watch on a name GitHub never reports reads `waiting` until its due time.

## Refusal codes

| Code | Status | When |
|---|---|---|
| `CALLER_NOT_VERIFIED` | 403 | Neither the Operator nor a verified launch |
| `OPERATOR_UNVERIFIABLE` | 503 | The install cannot verify an Operator request; sign in and repeat |
| `CHECK_WATCH_LAUNCH_ONLY` | 403 | The Operator tried to register or cancel |
| `CHECK_WATCH_MALFORMED` | 400 | A pull request number, commit, check name, project id or watch id that is not one |
| `CHECK_WATCH_DUE_OUT_OF_RANGE` | 400 | `dueInMinutes` missing, not a whole number, under 1 or over 1440 |
| `CHECK_WATCH_REPO_UNKNOWN` | 409 | The project's folder has no `origin` remote on github.com |
| `CHECK_WATCH_REPO_UNREADABLE` | 503 | The folder's `origin` could not be read in time, or at all |
| `CHECK_WATCH_DUPLICATE` | 409 | The project already has an open watch on that check of that commit; `watchId` names it |
| `CHECK_WATCH_LIMIT` | 409 | The project already has 20 open watches |
| `CHECK_WATCH_PROJECT_NOT_FOUND` | 404 | No such project, or none whose watches the caller may read |
| `CHECK_WATCH_NOT_FOUND` | 404 | No such watch, or none the caller may read |
| `CHECK_WATCH_NOT_OWNER` | 403 | A project that may read the watch tried to cancel it |
| `CHECK_WATCH_CANCELLED` | 409 | The watch is already cancelled |
| `CHECK_WATCH_UNAVAILABLE` | 503 | The server could not answer; read the watches again before repeating |

## Where it lives

`lib/check-watch-state.js` (the states, the limits, the codes), `lib/check-watch-store.js` (the
records), `lib/check-watch-api.js` (the routes' handlers), `lib/github-checks.js` (the reader of a
commit's check, not yet called for a watch), and the `check` verb in `lib/tc-verbs.js`.
