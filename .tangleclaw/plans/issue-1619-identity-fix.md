# #1619 — keep session identity out of tracked instruction files

Branch `fix/issue-1619-identity`, cut from `main` @ `65fe15b`. Implements the
Architect's brief at
`/Users/jasonvaughan/Documents/Projects/TangleClaw-Architect/.tangleclaw/plans/tracked-instructions-identity-fix.md`.

## The defect is live, not hypothetical

PR #1618 (Builder1's wrap, merged at `65fe15b`) committed Builder1's identity
into tracked `CLAUDE.md` on `main`:

```
-| inbox | GET .../api/sessions/TangleClaw-Builder/medusa/messages |
+| inbox | GET .../api/sessions/TangleClaw-Builder1/medusa/messages |
```

Measured: `/api/sessions/TangleClaw-Builder1/medusa/roster` → **200**. The name
on `main` resolves, so committed instructions currently point any reader who
does not regenerate locally at Builder1's live queue. This is the resolving-name
case, not the benign 404 the issue was first filed as.

## Confidence check

- **Problem:** tracked instruction carriers are generated with per-checkout and
  per-machine values, so every checkout produces a real diff on shared bytes —
  and the wrap commits it silently.
- **Success:** five simulated checkouts with different names, roots and API
  origins generate **byte-identical** tracked carriers; each session still
  addresses its own project, resolved at runtime; a wrap never silently stages
  identity data; the already-committed Builder1 name is gone from `main`.
- **Out of scope:** a new identity schema, rewriting route shapes, engine-private
  carriers that are gitignored, Train 21 chunks, and the merge/rollout itself.

## What actually leaks into tracked carriers

From a full read of `lib/engines.js` generation. Tracked carriers are the
governed `CLAUDE.md` operational block (`_generateOperationalBlock:2209`) and the
shared-convention carriers `AGENTS.md` / `GEMINI.md` / `CONVENTIONS.md`
(`SHARED_CONVENTION_CARRIERS:37`, `_generateGeminiMd:2421`). Engine-private
`.codex.yaml` / `.aider.conf.yml` are gitignored and out of scope.

| # | Leak | Source | Emitted by |
|---|---|---|---|
| 1 | Project **name** in the Medusa route | `store.projects.getByPath()` `:1963-1972` | `_medusaSwitchboardLines:2051` |
| 2 | `serverProtocol` + `serverPort` in the API base URL | `:1945-1946` | operational block `:2213`, gemini `:2454` |
| 3 | Shared-docs **absolute machine paths** (`~/…`) | `:2531,2534,2546` | `_buildSharedDocsSection:2497` |
| 4 | Shared-docs **lock holder — another project's name** | `:2517` | same |
| 5 | Shared-docs **inline file contents** of machine-local docs | `:2528-2529` | same |
| 6 | The `committedCarrier` service-token pointer still inlines protocol+port | `:2000-2012` | the precedent itself |

Rows 3-5 are a larger surface than the name that triggered the issue, and the
same argument condemns them: they differ per machine and land in shared bytes.

## The shape of the fix

The repo already contains the doctrine, at `_serviceTokenAuthLines(..., {
committedCarrier: true })` (`:1991-2012`), whose comment reads "a pointer costs
one call, a committed secret costs a rotation." Generalise it from *secrets* to
*identity*: a tracked carrier carries a **stable discovery instruction**; the
value arrives at runtime.

The runtime side already exists and needs no new schema (brief, point 2):
`lib/sessions.js:526-539` injects `TANGLECLAW_PROJECT_ID` (numeric),
`TANGLECLAW_WORKSPACE_ID`, `TANGLECLAW_LAUNCH_ID` and `TANGLECLAW_API`, and
`tc whoami` (`lib/tc-verbs.js:666`, `server.js:4483`) returns project id + name,
session id, workspace id and the API origin.

**The discovery instruction must not assume `tc` is on PATH.** Verified on this
host: `PATH` carries `/Users/.../TangleClaw-Builder/bin`, the pre-rename install
directory, which no longer exists — the running server was started before the
rename and `lib/sessions.js:527` prepends its own `__dirname`-derived path. So a
stale PATH is a live failure mode, and the brief's "a pointer to unavailable
tooling is not a fix" is a real constraint, not a precaution. The instruction
therefore names `tc` **and** the `TANGLECLAW_API` + endpoint fallback, and says
to refuse identity-dependent actions when neither resolves rather than guess.

Per the Architect's 2026-09-18 addendum, the recovery path for an
already-running session with a stale PATH must itself be checkout-neutral: the
shared bytes may name `$TANGLECLAW_API` and documented endpoints, but **never**
a checkout-specific fallback such as a literal `./bin/tc` or an install path.
That is the same rule the fix exists to enforce, applied to its own escape
hatch.

## Chunks

### Chunk 01 — generation: tracked carriers stop carrying identity
`lib/engines.js`. Route **all six rows** through the committed-carrier path.

I argued once that rows 3 and 5 — the doc path and its inline contents — were
group configuration, identical everywhere, and left them in. The Architect
disproved it with two same-policy fixtures differing only in a document
reference path, whose tracked carriers differed and contained that path. A path
is install state: it moves with the machine, the group's shared directory and
the operator's layout. Inline contents are that file's bytes at generation
time. Both are out of the committed carrier now.

**Access is preserved, not dropped** (brief, point 4): the committed carrier
names every doc and its group and points at
`$TANGLECLAW_API/api/shared-docs?groupId=<group>`, which serves the path and
the content to whoever asks. What leaves the shared bytes is the value, never
the capability. The engine-private carrier keeps path, contents, existence
check and lock holder, where each is actionable.
Tracked carriers get one discovery block; engine-private carriers keep inline
values. **Done when:** five synthetic projects differing in name, root and
origin produce byte-identical tracked carriers, and a sixth differing only in
engine still gets its own correct private config. Critic per chunk.

### Chunk 02 — migration: clean what is already committed
One reviewed change removing the Builder1 name and any other stale TC-owned
identity text from tracked carriers, preserving the `data/global-rules.md`
mirror (pinned by `test/repo-governance-reference.test.js`) and every
operator-authored line. No blanket deletion; no `.gitignore`-based "untracking",
which does not untrack.

### Chunk 03 — wrap ownership: a managed block is not proof of safety
`lib/wrap-steps/_tc-owned-paths.js:410-443`. Today `judge` returns `MAINTENANCE`
for any carrier diff confined to the managed block, and
`_file-ownership.js:183` stages maintenance **silently**. Add the missing
question — is the diff free of identity-shaped content — so a carrier diff that
still carries identity is surfaced rather than committed. Must not prompt on an
ordinary wrap (brief, point 6): after Chunk 01 the ordinary diff is empty, so
the guard fires only on the anomaly.

### Chunk 03 design (decided 2026-09-18)

`judge()` returns `MAINTENANCE` for any carrier diff confined to the managed
block, and `_file-ownership.js` stages maintenance **silently**. The brief says a
managed block is not proof that a diff is safe, and that the guard must not
prompt on an ordinary wrap.

Both hold if the guard asks one more question: *does the new block contain
identity?* After chunk 01 the ordinary regenerated block contains none, so the
guard is silent on every normal wrap and fires only on the anomaly — a carrier
written by a pre-fix server, an override, or a hand edit.

`_carriesIdentity(text)` returns the first pattern that matches, or null:

| Pattern | Why |
|---|---|
| `https?://<host>:<port>` | a machine origin; the neutral block names none |
| `/api/sessions/<name>/medusa` | a name-scoped route — the #1619 defect verbatim |
| `Authorization: Bearer` followed by anything but the `<token>` placeholder | a live credential |

A match downgrades `MAINTENANCE` to `null` — "not provably ours" — which is the
existing path for a diff TangleClaw cannot vouch for, so the operator is asked
rather than the change being staged. No new status, no new prompt shape.

Deliberately a **detector, not a fixer**: it must not rewrite the carrier, because
the correct content depends on the generator, and a wrap is the wrong place to
regenerate. It reports and hands the decision over.

### Chunk 04 — regression fixtures
Five simulated checkouts sharing one committed baseline; generate/sync/wrap
repeatedly; assert no tracked diff, no silent staging, no loss of authored
edits. Include a nested-worktree case and an accidentally-tracked local carrier.

## For the PR body, when chunk 02 is done

Two sentences the reviewer needs and the diff does not show:

1. **The leak is still producing commits.** `65fe15b` (PR #1618) put Builder1's
   Medusa routes into the tracked `CLAUDE.md` on `main`, and the same mechanism
   fired again on this branch: a pre-fix server regenerated the file and
   `git add -A` swept it into `fbdeaa6`. That commit was reverted in the
   following one. Generation is fixed here; what is already committed is chunk
   02's work, and until the fix reaches the running server every launch keeps
   re-dirtying the file.
2. **Never stage this branch with `git add -A`.** Use
   `git commit -- <paths>`. The carrier is regenerated by the running server
   mid-session, so a blanket stage picks up an identity change that has nothing
   to do with the commit — which is how `fbdeaa6` came to contain the very
   defect its title says it ends.

## Verification ceiling

Targeted: `test/engines.test.js`, `test/engine-config-managed-block.test.js`,
`test/managed-block.test.js`, `test/wrap-tc-owned-paths.test.js`,
`test/wrap-file-ownership.test.js`, `test/tc-cli.test.js`,
`test/tc-verbs.test.js`, `test/antigravity-engine.test.js`,
`test/repo-governance-reference.test.js`. Then the full suite before the diff
goes to the Architect.

## Assumptions to re-check as code reveals facts

- `[ASSUMPTION — NOT YET DISCHARGED, chunk 04 gate]` Engine-private carriers
  (`.codex.yaml`, `.aider.conf.yml`) are gitignored in every managed project.
  **This repo's `.gitignore` proves it only for this repo.** A project that
  tracks its `.codex.yaml` would have this fix's classifier call it private and
  keep inlining the live bearer token into a tracked file — the same defect
  class, one carrier over. The Architect has made accidentally-tracked local
  carriers a required chunk 04 gate. The durable answer is to ask git for the
  carrier's actual tracked/ignored state at the write boundary rather than
  consult a hardcoded list; until then the list is a default, not a guarantee,
  and `_isCommittedCarrier` is documented as such.
- `[ASSUMPTION]` No consumer parses the switchboard rows out of a carrier file
  expecting a literal URL. Grep before changing the shape.
