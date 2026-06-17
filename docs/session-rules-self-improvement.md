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

## Known upstream gaps (escalated to the Prawduct developer)

The Critic is git-anchored (no inline/DB artifact-review mode) and writes to a single fixed
findings path. The stage-as-tracked-file + snapshot/restore pattern above is the workaround
until/if upstream adds an artifact-review mode and/or an output-path override. See
`.claude/plans/d1b-self-improvement.md` for the full question set.
