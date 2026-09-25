# #1858 — Wrap file decisions fail closed, with safe recommendations

*Pilot 4 Builder lane (TangleClaw-Pilot-B1). Branch `fix/1858-wrap-file-safety`, fresh off `origin/main` @5ab699bc.
Dispatched by the PM on 2026-09-25.*

## Status

- [x] Plan written; design items A1–A8 sent to the Architect. **STOP here** (dispatch boundary: "Stop at PLAN WRITTEN")
- [x] Architect has ruled on A1–A8 (2026-09-25: A1, A3, A5, A6 approved; A2 and A4 approved with constraints; A7 modified; A8 rejected. See Rulings). PM go-ahead 2026-09-25
- [x] Chunk 01 — classifier + server enforcement (session-files, commit, changelog-coverage) — 1b4b7e56
- [x] Chunk 02 — drawer: recommendations, Apply-and-retry, manifest, ignore remediation — 2ae024a9
- [ ] Chunk 03 — docs + CHANGELOG, cumulative Critic (`Type: cumulative-final`)

**Pilot envelope (IN FORCE):** no merging any PR, no pulling/updating the live checkout, no restarting the
live service, no tests on the main instance, no tag/publish/release, no deploy.

## Problem

`session-files` (`lib/wrap-steps/session-files.js`) presents every never-committed file
(`untracked-new`, `lib/wrap-steps/_file-ownership.js`) as an equal Include/Leave choice, and it gives no
recommendation (`renderPathDecisionWidget`, `public/session.js`). In the incident, a PM wrap asked about six
new files. The operator chose Include for all six, which put a runtime SQLite file and three
`scratch/` files in the selection. Only the CHANGELOG gate stopped it, and that gate is not a file-safety gate:
an `### Internal` entry would have cleared it. `SECURITY.md` says the runtime database holds remote-service
tokens in plaintext.

What the code has today (verified 2026-09-25):

- **No safety class exists.** `classify` sorts files by *who* changed them (owned/foreign) and never by
  *what* the file is. `lib/` has no SQLite detection at all.
- **Decisions are sanitized, not validated.** `sanitizeDecisions` keeps any `include`/`leave` for any path.
  The commit step (`lib/wrap-steps/commit.js`, re-check block) recomputes classification and the secret scan,
  but it honors any Include it receives.
- **Every Retry re-runs the pipeline from `session-files`**, and the accumulated `pathDecisions` ride along in
  `options` (`H.accumulatePathDecisions`, `public/wrap-drawer.js`). So a gate at `session-files` is
  re-asked on every retry, but only if it actually blocks.
- **The handback** (`lib/wrap-handback.js`) targets only the step the run is blocked at, and only for kinds
  `ai-content`/`preflight`. `changelog-coverage` reads `pathDecisions` to decide which files are "work".
- **Precedents:** `_secret-check.js` withholds a flagged file and folds it into the same decision list.
  `lib/project-heal.js` writes a delimited block into `.git/info/exclude` (never `.gitignore`).

## Confidence check

1. **Problem:** a runtime database or scratch output is one ordinary radio click away from a public wrap
   commit, and nothing tells the operator which choice is safe.
2. **Success:** the issue's seven acceptance tests pass. On the incident tree, only the two plans are
   recommended for Include, applying the recommendations never stages the SQLite or scratch files, and no
   later step or AI fix can get the SQLite file committed.
3. **Out of scope:** the ownership rules (owned/foreign), the secret scan, the un-track offer, and deleting any
   file. Keep-local is Leave, which never touches disk.

Requirements confidence: **Medium**. The behavior is precisely specified. The open questions are shape
(A1–A8), especially whether a protected-file override exists at all (A3).

## Design

### New module `lib/wrap-steps/_file-safety.js` (pure except one bounded header read)

`safetyOf(root, relPath) → { class, reason, why }`, where `class` is one of:

| class | meaning | recommendation | may be Included? |
|---|---|---|---|
| `protected` | runtime state that can hold secrets | **Keep local (required)** | no (see A3) |
| `local` | scratch, temp, cache, logs and similar local artifacts | **Keep local (recommended)** | yes, when the operator explicitly chooses it |
| `durable` | TangleClaw-authored project content | **Include (recommended)** | yes |
| `ambiguous` | everything else, including new source | none; operator decides | yes |

- **protected:**
  - The SQLite file signature (`SQLite format 3\0`, first 16 bytes, read with `fs.openSync` and a 16-byte read)
    on any extension.
  - The extensions `.sqlite`, `.sqlite3`, `.db`, `.db3`.
  - The sidecars `-wal`, `-shm` and `-journal` of any of these (matched by name, since a sidecar has no
    header).
  - The known runtime paths `data/tangleclaw.db` and `data/tangleclaw.sqlite`.
  - A symlink is judged by name only, never followed.
- **local:**
  - Any path segment in `scratch`, `tmp`, `temp`, `.cache`, `cache`, `logs`, `coverage`, `node_modules`.
  - The suffixes `.log`, `.tmp`, `.swp`, `~`.
  - The basenames `.DS_Store` and `Thumbs.db`. `Thumbs.db` is `local`, not protected: it has no SQLite header
    and is not a runtime database.
- **durable:** `.tangleclaw/plans/**/*.md`, `.tangleclaw/priming/*.md`, `.tangleclaw/memories/*.md`.
- The pattern lists are frozen constants with one owner, matched on repo-root-relative forward-slash paths.

### Enforcement

`_file-ownership.classify` gains a safety pass. It runs after the TangleClaw state/maintenance sort and
before the owner rules, the same place `withheldPrefixes` sits today:

1. A `protected` path goes to a new `safetyWithheld` bucket, whatever its owner verdict or its decision.
   It is never stageable and is never offered as Include. It is **reported** (step output and drawer row),
   because a silent withhold looks like a lost file. An `include` decision for it is ignored and recorded as
   `refusedIncludes` on the classification, so the forged or stale Include acceptance test has something to
   assert.
2. For every foreign entry, `safetyOf` attaches `recommendation` (`include` | `leave` | `null`) and a
   plain-language `recommendationWhy` to the `foreignPaths` entry. A decision still has to be made. This is
   what keeps "no preselected default" intact.
3. Because `session-files` and `commit.js` both call `classify`, the commit step re-runs the same check.
   UI state, replayed options or AI output cannot stage a protected path, since none of them reaches past
   `classify` (issue requirement 4).
4. `changelog-coverage` stops counting `safetyWithheld` paths as work files. Adding a CHANGELOG entry can
   then never be what an unsafe file needs (requirement 5, together with A8).

### Drawer (`public/wrap-drawer.js`, `public/session.js`)

- `pathDecisionWidget` carries `recommendation`/`recommendationWhy`. Each fieldset shows it as text
  ("Keep local (recommended): scratch output"), and no radio is checked.
- A single **Apply recommendations and retry** button (A5) fills only the undecided radios that have a
  recommendation, sends the result as an ordinary `pathDecisions` Retry, and says how many ambiguous files
  still need a choice. If any remain, the wrap blocks again, on those files only.
- The `session-files` row detail and the commit row show a **manifest** (A7): files to commit, files kept
  local, files withheld as protected (by path), and any overrides.
- **Ignore remediation** (A6): for each kept-local or withheld path, the drawer shows an anchored,
  exact-path suggestion (`/data/tangleclaw.sqlite`, `/scratch/`). The suggestion names the path's own
  directory only when that directory holds nothing but local artifacts; it never names a directory that
  also holds tracked files (`git ls-files <dir>` non-empty → exact path only). So `data/` is never suggested.

## Rulings (Architect, 2026-09-25) — these override the Design section wherever they differ

- **A1 approved:** keep the separate `_file-safety.js`.
- **A2 approved with constraints.** Protected applies across owned, foreign, tracked and untracked files,
  after the existing TC state/maintenance handling.
  - `Thumbs.db` is a specific `local` exception, checked before the generic `.db` rule.
  - Suffix checks are case-insensitive.
  - A sidecar (`-wal`/`-shm`/`-journal`) is protected only when it is tied to a recognized DB basename.
  - `lstat` comes before any header read, and symlinks are never followed.
  - **Required test:** a protected file that is already staged in the real index is excluded from the wrap's
    pathspec commit, and it stays staged and uncommitted.
- **A3 approved:** no in-wrap override. The remediation must say that the escape is a *separate ordinary
  commit outside the wrap*, not `git add` followed by a wrap.
- **A4 approved with a modification.** Recommendations stay advisory, and no radio is preselected.
  - `scratch`, `tmp`, `temp`, `cache`, `logs` and `coverage` count as `local` only as **root-level**
    directories.
  - `node_modules` and `.cache` count as `local` as any path segment.
  - **Required negative tests:** `lib/cache/adapter.js` and `src/tmp/parser.js` stay `ambiguous`.
  - New source stays ambiguous. `durable` stays limited to `.tangleclaw/{plans,priming,memories}` Markdown.
- **A5 approved:** Apply-and-retry is client-side, over the existing route. It never overwrites an explicit
  operator choice and fills only undecided entries that have a recommendation. Protected paths get no
  radio.
- **A6 approved:** suggestion text only, exact and anchored. A directory suggestion is allowed only when it
  cannot hide tracked **or ambiguous** contents; otherwise the suggestion is the exact file. Nothing writes to
  `.gitignore` or `.git/info/exclude`.
- **A7 modified.** The concise manifest must be visible in the decision surface **before** the operator
  presses Apply-and-retry, and the click is the confirmation. The manifest is repeated on the commit row for
  audit. It shows exact paths under four groups: commit, keep local, protected, and unresolved ambiguous.
- **A8 rejected.** `lib/wrap-handback.js` is out of scope. Refused Includes are recorded in the output and
  audit, and the output says visibly that they were ignored. The client prunes protected paths from its
  accumulated `pathDecisions` map when results return. Forged API options may recur but must never stage a
  file and must never create a handback gate.
- **Assumptions:** all three were approved (the known runtime paths, new source stays ambiguous, and the
  `durable` scope).
- **Standing instruction:** send any newly discovered architectural choice to the Architect before
  implementing it. The stop point is the draft-PR pilot boundary.

## Decisions for the Architect

- **A1 — Four classes in a new `_file-safety.js`, owned by `classify`.**
  *Alternative:* fold them into `_secret-check`, which already reads files. **Recommend** a separate module:
  a secret check is about content, and a file class is about kind, so mixing them would repeat the #1513
  "two questions, one bucket" problem.
- **A2 — Protected applies to every bucket, not only `untracked-new`.** A tracked `.db` that changed this
  session (owned) is withheld too.
  *Cost:* a repo that deliberately commits a DB fixture has to commit it by hand, outside the wrap.
  **Recommend** fail-closed across buckets, because that is the issue's security framing.
  *Alternative:* protect only paths new to the repo (`newToRepo`).
- **A3 — No in-wrap override for protected paths.**
  The issue allows an eyes-open advanced override as an option. **Recommend** not building one:
  - Every override path is a new bypass surface that the commit step has to re-verify.
  - The legitimate case (a fixture DB) is rare and already has a safe exit: `git add` by hand, reviewed as an
    ordinary commit.
  - If the Architect wants an override, the shape would be a separate option,
    `protectedIncludes: [{path, acknowledge: <same path>}]`, from a second confirmation that names the
    path and the risk. The commit step would honor it only when `acknowledge === path`. The manifest would
    list it under "advanced overrides".
- **A4 — The recommendation is advice only.** It never sets a decision server-side, and there is still no
  preselected radio. It sits on `foreignPaths[].recommendation`, and Leave/Include stay the only decision
  values.
- **A5 — "Apply recommendations and retry" is client-side.** It fills radios and then runs the existing Retry,
  which avoids a new server route and a new options key. The server stays the enforcer (it re-classifies on
  every retry).
- **A6 — Ignore remediation is suggestion text only in this issue.** No one-click write.
  *Alternative:* write the lines into a second TC-delimited block in `.git/info/exclude`, in the same way
  `project-heal` does. **Recommend** deferring that to a follow-up issue. Writing into the operator's git
  config from a wrap is a new side effect, and it deserves its own review.
- **A7 — The manifest is non-blocking.**
  With A3 as recommended there are no overrides, so nothing needs an extra confirmation pause. The manifest
  shows on the `session-files` done row and again on the commit row.
  If A3 adds overrides, the commit step blocks `needs-operator` once, with the manifest, whenever an override
  is present.
- **A8 — The handback guard.** Protected paths can never be stageable, so the incident path (a CHANGELOG fix
  covering an unsafe file) cannot happen by construction. As a defense in depth, `wrap-handback` also
  refuses when the run's latest `session-files` output has `refusedIncludes`. The refusal says "resolve the
  file choices first" and points to that step.

## Open assumptions

- [ASSUMPTION: The runtime DB in the incident is TC's own store under another project's `data/`, so both
  `data/tangleclaw.db` and `data/tangleclaw.sqlite` are listed as known runtime paths, beside the generic
  signature and extension rules | MED impact | the Architect can correct]
- [ASSUMPTION: New source files (`lib/foo.js`) are `ambiguous`, not `durable`, because the issue says they
  must remain reviewable | MED impact | the Architect can override to `durable`]
- [ASSUMPTION: `durable` covers only the three `.tangleclaw/` authored-content directories named above, not
  `docs/` | LOW impact | the Architect can widen it]

## Chunks

`partition: serial — 02 renders the fields 01 adds; 03 documents both.`

### Chunk 01 — classifier and server enforcement

The new module `lib/wrap-steps/_file-safety.js`, plus edits to `_file-ownership.js`, `session-files.js`,
`commit.js`, `changelog-coverage.js` and `lib/wrap-handback.js`.

- **Tests:** new `test/wrap-file-safety.test.js`, plus extensions to `test/wrap-file-ownership.test.js`.
  They cover the issue's acceptance tests on server-side fixtures:
  - The incident tree recommends Include for only the two plans.
  - A decisions map with Include for all six stages neither the SQLite file nor its `-wal` sidecar, at
    `session-files` or at `commit`.
  - A forged Include reaches the commit and lands in `refusedIncludes`.
  - `changelog-coverage` ignores withheld paths.
  - The handback refuses.
  - A new `lib/x.js` stays an undecided foreign path with a null recommendation.
  - Leave keeps the files on disk.
- **Proof:** the focused suites, then the full suite in this checkout.

### Chunk 02 — drawer

Edits to `public/wrap-drawer.js` (the descriptor fields, recommendation text, an `applyRecommendations`
helper, the manifest and the ignore-suggestion builder) and `public/session.js` (rendering and the button).

- **Tests:** extensions to `test/wrap-drawer.test.js` and `test/wrap-run-session-wiring.test.js`.
  - No radio is preselected.
  - Apply fills only the recommended radios and leaves ambiguous ones empty.
  - The ignore suggestion is never a broad `data/`.
- **Visual change: yes.** Operator verification entry: the drawer on a fixture tree.

### Chunk 03 — docs, CHANGELOG, cumulative review

`Type: cumulative-final`. Covers the wrap docs (`docs/` wrap/session-files page), `SECURITY.md` (the runtime DB
is withheld from wrap commits), and a `CHANGELOG.md` `### Fixed` entry (it is a bug), plus a
`.prawduct/change-log.md` entry. After that, `/prawduct:critic cumulative`, then a draft PR (the Pilot boundary
means no merge).
