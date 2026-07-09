# Session rules & the self-improvement loop (D1, #347)

Session rules are durable **behavioral directives** injected into every harness config at
session launch, cross-model, alongside global-rules. They are distinct from `learnings`
(AI-accumulated observations) and from the structured core/extension toggles.

- **D1a** — the store + cross-model launch injection + CRUD + a global-rules UI.
- **D1b** — the self-improvement loop: version history + rollback, learnings→rule
  promotion, autonomous edits for safe/non-conflicting cases, conflict-surfacing, and an
  independent **Critic gate** for conflicting/autonomous edits.

This doc is the **canonical, git-tracked** reference (TC gitignores `.claude/`, so the
paste-able priming copy at `.claude/priming/d1b-rule-review.md` is per-clone and points
here).

## Data model

- `session_rules` — `id`, nullable `project_id` (NULL = global, applies to every project),
  `content`, `enabled`, `created_by` (`operator` | `ai`), nullable `owner` (auth seam),
  nullable `source_learning_id` (provenance for promoted rules), timestamps.
- `session_rule_versions` — a full snapshot after **every** mutation (`create` / `update` /
  `delete` / `restore`). `version_no` is monotonic per rule; `rule_id` is a logical
  reference (no FK cascade) so **history survives a rule's deletion** for audit.
- `learnings` — `id`, `project_id`, `content`, `tier` (`provisional` | `active`),
  `source_session`, `confirmed_count`, timestamps. Rows are the raw material the promote
  loop turns into rules.

## Learnings ingestion (the DB writer, #466)

The `learnings` table is populated by the **`learnings-db-write`** wrap step
(`lib/wrap-steps/learnings-db-write.js`), which runs right after the AI-driven
`learnings-capture` step. `learnings-capture` has the AI append a
`## YYYY-MM-DD — <title>` entry to `.tangleclaw/memories/learnings.md` (the human-readable
log, the source of truth); `learnings-db-write` then parses that file's **today-dated**
entries, dedups by exact `content` against the project's existing rows (idempotent on wrap
retry), and inserts each via `store.learnings.create(... tier:'provisional' ...)`. The DB
rows are what `generatePrimePrompt` injects as "Active learnings" and what
`POST /api/session-rules/promote {learningId}` promotes into a rule. Before #466 nothing
wrote to the table, so both the prime injection and the promote loop were permanently empty.

## API

| Method & path | Purpose |
|---|---|
| `GET /api/session-rules?scope=global` | List rules |
| `POST /api/session-rules` `{content, projectId?, createdBy?}` | Create |
| `PUT /api/session-rules/:id` `{content?, enabled?, changedBy?}` | Update (snapshots a version) |
| `DELETE /api/session-rules/:id` | Delete (snapshots a tombstone) |
| `GET /api/session-rules/:id/versions` | Version history (newest first) |
| `POST /api/session-rules/:id/restore` `{versionNo}` | Roll back to a prior version |
| `POST /api/session-rules/promote` `{learningId, content?, projectId?}` | Promote a learning → rule (operator-confirmed) |
| `POST /api/session-rules/conflicts` `{content, projectId?}` | Non-authoritative conflict-candidate signal |

`findConflictCandidates` / the `/conflicts` route return active in-scope rules sharing
significant token overlap with a proposed edit. This is a **hint of what to compare**, NOT
a conflict verdict — per the ratified design, conflicts are surfaced for human judgment and
**never auto-resolved**.

## The Critic gate (in-session agent capability)

Conflicting or autonomous (AI-authored) edits must pass an **independent Critic pass**
before they land. The Critic is the `/prawduct:critic` skill — an **in-session agent
capability**; TC's server cannot summon one. On a non-Claude harness there is no in-session
Critic: **fall back to discussion + operator decision**.

### When the gate fires (proportional)
- **Conflicting** edit (`/conflicts` returns candidates, or the AI judges a conflict), OR
- **Autonomous** edit (`createdBy:'ai'`, including `promoteFromLearning`).

Trivial, non-conflicting, **operator-authored** edits skip the gate.

### Procedure (validated empirically against Prawduct 2.1.5)
1. **Detect candidates** via `POST /api/session-rules/conflicts` — a non-authoritative hint,
   not a verdict. Form your own judgment.
2. **Stage the proposal as a git-TRACKED scratch file** (e.g. repo root
   `./.d1b-proposed-rule.md`) — NOT under `.prawduct/` (gitignored → invisible to the
   Critic's `git diff`/`git status`). Include the existing in-scope rules (context), the
   proposed edit, and the three review questions (conflict? weakens a safeguard?
   over-broadens beyond the triggering learning?).
3. **Snapshot** the findings file so a build chunk's record isn't clobbered:
   `cp .prawduct/.critic-findings.json /tmp/critic-findings.bak` (if present).
4. **Invoke** `/prawduct:critic chunk` (Skill tool) — it reviews the staged file.
5. **Capture** `.prawduct/.critic-findings.json` (`findings[]`, `summary`, severities).
   BLOCKING ⇒ do not land; surface to the operator with the findings attached.
6. **Restore** the snapshot and **delete** the scratch file.
7. **Surface = discussion OR decision** (not a forced menu): prose conversation and/or an
   `AskUserQuestion`. Never auto-resolve. Whatever the operator lands is applied via the
   API and auto-versioned.

### Apply paths (all auto-snapshot a version)
- New AI rule: `POST /api/session-rules {content, createdBy:'ai'}`
- Promote: `POST /api/session-rules/promote {learningId, ...}`
- Edit: `PUT /api/session-rules/:id {content?, enabled?, changedBy:'ai'}`
- Roll back: `POST /api/session-rules/:id/restore {versionNo}`

## Rule kinds + the wrap-rule self-critique trigger (CC-6, #381)

CC-6 added a **`kind`** discriminator to `session_rules` so the per-project **Project
Rules modal** can host three rule kinds. The self-improvement engine documented above is
unchanged — CC-6 only widens what it can sink into.

| kind | When it applies | Launch-injected? |
|---|---|---|
| `startup` (default) | session start — custom priming | **yes** (`## Session Rules`) |
| `wrap` | wrap time — custom wrap behavior + the self-learning sink | no |
| `mode` | harness/model posture | no (runtime enforcement = A3 / #209) |

- The launch-injection query (`listActiveForProject`) filters to `kind='startup'`. Rows
  predating CC-6 backfill to `startup`, so injection behavior is unchanged.
- `POST /api/session-rules` and `/promote` accept `kind`; `GET /api/session-rules?kind=`
  filters; `/conflicts` accepts `{kind}` so a proposed wrap rule is only compared against
  other wrap rules. An invalid kind is a 400.

### The wrap-time trigger
At wrap, the AI may notice a recurring wrap-process improvement (e.g. "this project always
needs a lint pass before the wrap commit"). It proposes a **`kind='wrap'`** rule. Because
this is an **autonomous (AI-authored) edit**, it goes through the **same Critic gate** as
any `createdBy:'ai'` edit (procedure above) and is **surfaced user-gated** — never
auto-applied. Apply path: `POST /api/session-rules {content, projectId, kind:'wrap',
createdBy:'ai'}` or `/promote {learningId, kind:'wrap'}`. The accepted rule lands in the
project's **Wrap rules** box in the Project Rules modal and is auto-versioned like any other.

This keeps the contract's "self-improvement suggestions are user-gated, never auto-applied,
and rare/high-signal" rule intact — CC-6 reuses D1b's engine rather than adding a second one.

## Critic-gate provenance on the version snapshot (SR-7K2P)

**Status: built (2026-07-08). Schema v24; `critic_gate` on `session_rule_versions`.**

### Problem
Today "was this AI/autonomous edit actually gated?" is only *inferable* — cross-reference
`changed_by='ai'` on the version snapshot against the activity log and trust the procedure
was followed. There is no explicit, durable proof on the edit itself. This makes the
self-improvement loop's central safeguard (the Critic gate) unauditable without detective work.

### Constraint (why this is *attestation*, not *verification*)
The Critic gate is an **in-session AI capability** — "TC's server cannot summon one" (see
"The Critic gate" above). The server never witnesses the Critic run; the AI runs
`/prawduct:critic`, reads `.critic-findings.json`, and only then calls the apply-path API.
So the provenance is necessarily an **attestation the AI supplies at apply-time**. The
requirement is to **record** that attestation, **not enforce/verify** it (enforcement is
architecturally impossible here). An operator who audits still relies on the attestation's
honesty — but it becomes explicit and queryable rather than implicit.

### Design (decided)
- **Data model.** Add one column to `session_rule_versions` (the per-mutation snapshot — the
  natural home for per-change provenance; the current rule's gate status = its latest
  version's value, so nothing is duplicated onto `session_rules`):

  `critic_gate TEXT NOT NULL DEFAULT 'unknown' CHECK (critic_gate IN ('passed','not-required','unknown'))`

  The three states are deliberately distinct (a bare boolean can't separate them):
  | value | meaning |
  |---|---|
  | `passed` | AI/autonomous edit that the AI attests passed the Critic gate |
  | `not-required` | operator-authored (or trivial, non-conflicting) edit that legitimately skips the gate |
  | `unknown` | backfilled legacy row, or an AI edit applied with no attestation (honest "we don't know") |

  Schema bump **v23→v24**, table-rebuild migration mirroring SR-3MW8's `op` CHECK (SQLite
  can't `ALTER TABLE ADD CHECK`), preserving every row and defaulting existing rows to
  `unknown`, with a `sqlite_master` postcondition.

- **Writer default mapping** (`_snapshotSessionRule`): derive from author unless the caller
  supplies an explicit value — operator-authored → `not-required`; AI-authored → caller's
  attested value, else `unknown`. (A landed AI edit *should* be `passed` since BLOCKING ⇒
  don't land, but the writer never assumes — absence is honestly `unknown`.)

- **API.** The four apply paths accept an optional `criticGate` (enum-validated, 400 on a
  bad value): `POST /api/session-rules`, `PUT /api/session-rules/:id`,
  `POST /api/session-rules/promote`, `POST /api/session-rules/:id/restore`.
  `GET /api/session-rules/:id/versions` returns `critic_gate` per version.

- **UI.** The version-history surface shows a per-version badge (`✓ Critic-reviewed` /
  `— not required` / `? unknown`).

### Out of scope
Server-side enforcement/verification of the gate (impossible — see Constraint); version-history
pruning (SR-5T1J); any change to the gate procedure itself.

## Known upstream gaps (escalated to the Prawduct developer)

The Critic is git-anchored (no inline/DB artifact-review mode) and writes to a single fixed
findings path. The stage-as-tracked-file + snapshot/restore pattern above is the workaround
until/if upstream adds an artifact-review mode and/or an output-path override. See
`.claude/plans/d1b-self-improvement.md` for the full question set.
