# Check watches

*Being built (#2323). A session can register a watch, read it back and cancel it, and the server
reads the check from GitHub about once a minute and records its result. **Results are read; nobody
is woken yet:** a session finds the result by reading its watch. Every answer still says
`monitored: false`, which here means "you will not be woken". There is no screen. This page grows
with each part as it lands.*

## What a watch is

A watch is a session's request to be told when one named check finishes on one exact commit of a
pull request. It records:

- the project it belongs to, and the session and launch that registered it;
- the repository, the pull request number, the commit (all 40 characters) and the check's name,
  exactly as GitHub shows it;
- a due time, after which silence is itself reported.

The watch belongs to the **project**, not to the launch that registered it, so it is still there
after the session is cleared or relaunched, and after the server restarts.

The repository is not taken from the request. It is the `origin` remote of the project's own
folder, read by the server with `git`, and it must be on github.com. A project whose folder has no
such remote cannot register a watch (`CHECK_WATCH_REPO_UNKNOWN`). This is not a boundary against
the project's own session: a session can write its folder's git config, so it can change which
repository its next watch records.

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
| `expired` | The watch stayed unresolved for 24 hours past its due time and is not read again |
| `unreadable` | The record or a time in it cannot be made sense of |

`ready` and `failed` come only from a recorded result. A watch is **open** while it has no result,
is not cancelled and has not expired. A watch past its due time is still open: a late result is
still its result.

## The monitor

The server reads every open watch's check from GitHub itself, on a timer, and records what it
reads. Nobody has to ask.

- **About once a minute.** The timer runs a pass every 60 seconds, and that is what sets the rate:
  one read per watch per minute. A result is therefore recorded up to a minute after the check
  ends, never at the instant it ends. A second guard stops a watch being read twice within 45
  seconds; it only matters when passes come faster than the timer, as after a restart.
- **A result is written once.** The first read that finds the check finished records its
  conclusion, the run's id and when it completed. The watch then reads `ready` or `failed`, is no
  longer open and is not read again.
- **A read that fails writes no result.** The watch reads `unknown` with `read-failed` until a read
  works again. Its history gains one `read-failed` when reads start failing and one
  `read-recovered` when they work, not one per read.
- **Expiry.** A watch still unresolved 24 hours after its due time is read one last time and, if
  that read finds no result, expired: it is not read again, it no longer counts as open, and it
  goes on reading `unknown`, now with `expired`. A result found at that last read wins and is
  recorded instead. A last read that could not reach GitHub does not hold the expiry back. To
  watch the check again, register a new watch.
- **Nobody is told.** The monitor sends no message and types into no pane. Waking the session is
  a later part of #2323.

The read is one `gh api` call made under **the server's own GitHub identity**, for whatever
repository the project folder's `origin` named when the watch was registered. Nothing limits which
repository that is. What is limited is how much the server reads with nobody asking: see Limits.

`tc check` ends each answer with a NOT MONITORED line for as long as this is so: the server reads
GitHub for the watch and records the result, but wakes nobody, so read the watch or the check
yourself.

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
- **The server reads at most 30 watches in one pass, across every project**, at most 4 at a time.
  With more than 30 open watches due a read, the ones read longest ago go first and the rest wait
  for a later pass, so every watch is still read but less often: 60 open watches are each read
  about every two minutes. The server log says when this starts and when it stops.
- **A watch is read for at most 24 hours past its due time**, then expired (see The monitor).
- **Neither table is pruned.** `check_watches` and `check_watch_facts` keep every watch and every
  fact of its history. The limit of 20 bounds open watches only, so the tables grow with use.
- **Registering reads the project folder's `origin` with `git`**, bounded at four seconds. A read
  that does not finish refuses the registration (`503 CHECK_WATCH_REPO_UNREADABLE`); nothing was
  registered, and it can be repeated. The same code answers when the folder or `git` itself is
  missing, and says that repeating will not help.
- **Nothing checks that the pull request exists, that the commit is its head, or that a check of
  that name ever runs.** A watch on a name GitHub never reports reads `waiting` until its due time,
  `unknown` after it, and is expired 24 hours later.

## Refusal codes

| Code | Status | When |
|---|---|---|
| `CALLER_NOT_VERIFIED` | 403 | Neither the Operator nor a verified launch |
| `OPERATOR_UNVERIFIABLE` | 503 | The install cannot verify an Operator request; sign in and repeat |
| `CHECK_WATCH_LAUNCH_ONLY` | 403 | The Operator tried to register or cancel |
| `CHECK_WATCH_MALFORMED` | 400 | A pull request number, commit, check name, project id or watch id that is not one |
| `CHECK_WATCH_DUE_OUT_OF_RANGE` | 400 | `dueInMinutes` missing, not a whole number, under 1 or over 1440 |
| `CHECK_WATCH_REPO_UNKNOWN` | 409 | The project's folder has no `origin` remote on github.com |
| `CHECK_WATCH_REPO_UNREADABLE` | 503 | The folder's `origin` could not be read in time, or the folder or `git` is missing |
| `CHECK_WATCH_DUPLICATE` | 409 | The project already has an open watch on that check of that commit; `watchId` names it |
| `CHECK_WATCH_LIMIT` | 409 | The project already has 20 open watches |
| `CHECK_WATCH_PROJECT_NOT_FOUND` | 404 | No such project, or none whose watches the caller may read |
| `CHECK_WATCH_NOT_FOUND` | 404 | No such watch, or none the caller may read |
| `CHECK_WATCH_NOT_OWNER` | 403 | A project that may read the watch tried to cancel it |
| `CHECK_WATCH_CANCELLED` | 409 | The watch is already cancelled |
| `CHECK_WATCH_UNAVAILABLE` | 503 | The server could not answer; read the watches again before repeating |

## Where it lives

`lib/check-watch-state.js` (the states, the limits, the codes), `lib/check-watch-store.js` (the
records), `lib/check-watch-api.js` (the routes' handlers), `lib/check-watch.js` (the monitor,
started and stopped by `server.js`), `lib/github-checks.js` (the reader of a commit's check), and
the `check` verb in `lib/tc-verbs.js`.
