# ADR 0024: Release Versions group one or more Trains, superseding one-train-one-release

**Status:** Accepted (2026-10-07). **Decisions 2, 4 and 5 are amended by Amendment 1 below** (2026-10-07, Architect rulings A86 and A87), which supersedes their wording where the two conflict. Records the Architect's ruling A84 on an Operator-directed
roadmap restructuring proposal. Amended same day, before merge, per the Architect's PR review of
this ADR: fixed a contradiction in Decision 4 (bucket/unscoped Trains stay visible in the unchanged
Train view, excluded only from the new Release view, not hidden in some third "backlog"), added
`target_release` canonicalization against existing `release:vX.Y` labels (Decision 1), and labeled
the Release view as planned targets rather than a shipped-version index (Decision 4). Implementation
(schema/generator changes, the train/issue sweep) is tracked separately and has not started.
**Source:** Operator request, relayed by the ProjectManager; ruled by the Architect as A84.
**Supersedes:** the shipping model ratified 2026-07-30 ("each version ships ONE train with all its
cars, v5.1 is one complete train, v5.2 the next"), where it conflicts — see Decision 2.
**Does not touch:** the Permanent Train Identity policy (#1942) — Train `id` remains immutable,
never derived from version, order, or status.

---

## Context

Two planning signals currently exist and don't agree with each other:

1. **Trains** (`board-data.json`, rendered by `build-board.py`) group issues thematically — Train
   1 "First Install, Completed", Train 3 "Session Switchboard", etc. Train membership is read live
   from each issue's GitHub **milestone** assignment, not stored in `board-data.json` itself; the
   file holds only each Train's identity and metadata (`id`, `kind`, `milestone`, `thesis`,
   `sequencing`, `verified`, `display_order`, `aliases`). Ten-plus Trains are assembled
   concurrently today.
2. **Release labels** (`release:v5.32`, `release:v5.40`, etc.) sit directly on individual issues,
   independent of Trains. As of this writing, 6 open issues carry `release:v5.32` and 12 carry
   `release:v5.40`, and none of those 18 belong to any assembled Train.

Under the 2026-07-30 shipping model, a Train *is* a release — so the model offers no way to
express "these three Trains together make up v5.40" or "this Train isn't scoped to a release yet,"
and the two signals above have drifted apart in practice. What actually ships in a given version is
decided separately, by what has merged and landed under `[Unreleased]` in `CHANGELOG.md` by the
time someone cuts a release — not by which Train is "done."

## Decision

1. **Add `target_release` to the Train schema in `board-data.json`.** A new, nullable, mutable
   string field, canonical form `"X.Y.Z"` (full semver, e.g. `"5.32.0"` — not `"v5.32"`). `null`
   means unscoped — not yet assigned to a release. This is a planning field, not a new identity
   field; it does not join, rename, or renumber anything the Permanent Train Identity policy
   governs.
   - **Normalization against existing `release:vX.Y` issue labels:** a label names a minor line
     (e.g. `release:v5.32`), not a patch; it maps to that line's next unreleased version at the
     time of reconciliation (typically `X.Y.0`) and is re-checked at sweep time, not assumed fixed.
     The label and `target_release` are never required to carry identical text — the label lives on
     the issue, `target_release` on the Train that issue ends up in.

2. **Cardinality, and the resulting policy supersession:**
   - One Train → **zero or one** `target_release`. A Train is never split across two releases; if
     a Train's cars span more than one intended release, it is **split into new, permanent Train
     IDs** (next unused integer per #1942 — never reuse, renumber, or retire the original's
     history).
   - One release → **one or many** Trains.
   - This second half — multiple Trains composing one release — is incompatible with the
     2026-07-30 model's "each version ships ONE train" wording. That clause is **superseded** by
     this ADR. The stale `release_gate` note and the generated board's intro copy must be updated
     to match before the Release view is presented as authoritative (tracked in the follow-up
     issue, not done by this ADR).

3. **`target_release` is forecast, not proof.** It states current planning intent. It is never
   evidence of what a release actually contains — that remains merged PRs, `CHANGELOG.md`, the git
   tag, or the release manifest. Nothing reads `target_release` as a release's shipped contents.

4. **Two views over one dataset.** The existing Train view (thematic) is **unchanged**:
   `build-board.py` continues to render every configured Train and bucket entry there exactly as it
   does today, regardless of `target_release`. The new Release view is additional, not a
   replacement — it groups Trains by `target_release` and rolls up their live-derived cars, and its
   index is the release-version list the Operator asked for. The Release view **excludes**
   `kind: "bucket"` entries and unscoped (`target_release: null`) Trains; excluded means **absent
   from this one new view**, not hidden anywhere else — they stay exactly as visible in the
   (unchanged) Train view as every other configured entry. The Release view is labeled as **planned
   targets**, not a complete or authoritative shipped-version index — see Decision 3; it shows
   intent, and actual release membership is still tag/CHANGELOG/manifest-derived.

5. **The 18 currently-orphaned labeled issues are reconciled individually**, not bulk-retargeted.
   A `release:vX.Y` label on an issue is a proposal to consider, never authority to force that
   issue into a Train or to silently set a Train's `target_release`. Each is folded into an
   existing Train that fits its theme, or becomes the seed of a new Train, on its own merits.

6. **Never rewrite historical shipped releases.** This ADR's mechanism is forward-looking; past
   Trains and the releases already cut from them are not retargeted or reorganized retroactively.

7. **Ownership, per `roadmap-board/RULES.md`:** the ProjectManager is the roadmap's primary
   maintainer and owns this ADR, the policy text, the Train/issue sweep, and Operator-escalated
   decisions on ambiguous targets; the PM may own the `board-data.json`/`build-board.py` schema and
   generator changes directly. **Builders remain strictly read-only on the roadmap** — the one
   standing exception (Pilot-B2, 2026-09-27) is scoped only to #1942 and does not cover this work.
   No Builder is assigned any part of this until a new, separately scoped `RULES.md` exception is
   recorded. The Architect may review disputed Train/version mappings but, under Rule #71, does not
   write the live checkout or run the generator itself.

## Consequences

- The board gains a second, release-grouped view without breaking the existing thematic one or the
  Train Identity policy.
- `build-board.py` needs a validated path from "Trains carrying the same `target_release`" to "a
  release's rolled-up car list," reconciled against live GitHub milestone membership rather than
  any stored car list.
- Some existing Trains whose cars genuinely span two release targets will be split into new Train
  IDs as part of the sweep; their history is preserved, not deleted.
- The stale one-train-one-release wording in the generated board's intro and in any other place it
  is asserted as current policy must be corrected once the Release view ships, so the two no longer
  contradict each other.

## Follow-up (tracked separately, not part of this ADR)

Tracked as [#2157](https://github.com/Jason-Vaughan/TangleClaw/issues/2157).


- Schema change to `board-data.json` (add `target_release`) and the corresponding `build-board.py`
  generator work for the Release view.
- The one-time sweep: assign or explicitly unscope `target_release` for every currently assembled
  Train (1–7, 16, 31, 32 at time of writing).
- Individual reconciliation of the 18 orphaned `release:v5.32`/`release:v5.40` issues.
- Update the board's generated intro copy once the above lands.

---

## Amendment 1 (2026-10-07): the release view holds a release's whole workload

**Source:** Operator direction on the roadmap's shape, 2026-10-07; ruled by the Architect as A86
(release panel contents) and A87 (workstream identity). **Amends:** Decision 4 in full, and the
parts of Decisions 2 and 5 named below. Decisions 1, 3, 6 and 7 stand as written.

### What changed, and why

Decision 4 said the Release view excludes `kind: "bucket"` entries and unscoped Trains, and that
the Train view is unchanged. Both halves met a fact the decision did not anticipate.

The Operator reviewed the release-grouped board and asked for a different shape: the release
version at the top of the hierarchy, each release made of one or more **workstreams** that can be
built in parallel, and each workstream's issues in the order they need to be built. That document
now exists beside the thematic board as **Roadmap 2**. The Architect then sorted every open issue
into it and the Operator accepted the result.

In that sort most workstreams have no permanent Train id. They are real, release-scoped work, but
nobody has yet decided that each is a stable Train. Under Decision 4 as written they would be
buckets, and so excluded from their own release: release 5.32.0 would have shown 4 of its 17 cars.

### Decision 4, as amended

1. **Two documents over one live dataset.** The thematic board (Trains read from GitHub
   milestones) continues unchanged. Roadmap 2 is the release-planning view. Neither replaces the
   other, and both read issue state from GitHub on every build.
2. **In Roadmap 2 a release holds every workstream planned into it.** A workstream is either a
   numbered Train, carrying its permanent id, or a release-scoped **bucket**, which carries none.
   Both appear inside the release, and both count toward its totals.
3. **A bucket in a release is not a Train and is not given a Train number.** Placing work in a
   release ratifies a forecast, not an identity. No id is invented from a release, a position or
   a name, and two buckets that share a name in different releases are not thereby one Train.
4. **A bucket becomes a numbered Train only by a recorded act**, one candidate at a time: a stable
   objective, its exact set of issues, its dependency boundary, its relation to any existing
   Train, and a decision to keep it a bucket, join a Train, split, or take a new id. Only then is
   the next unused id allocated under the Permanent Train Identity policy (#1942). Bulk
   allocation waits until the release view can show the candidates in context.
5. **Unscoped Trains, pilots and milestones with no configuration stay outside release panels**
   and remain visible where they are today.
6. **Dependencies stay structured and visible.** Which workstream starts after which, and which
   issue waits on which, are recorded as data, and each release shows a summary of them without
   the reader having to open anything. A condition that is not an issue may be listed as a
   display-only gate naming who decides it and what evidence settles it. Nothing in the roadmap
   enforces dispatch.
7. **Decision 3 is unchanged and applies to everything above:** a release target is a forecast.
   What a version shipped is its tag, `CHANGELOG.md` and the release manifest.

### Decision 2, as amended

Decision 2 said one release holds one or many **Trains**, and that a Train whose cars span more
than one release is split into new permanent Train ids. Two parts of that change.

- **A release holds one or more workstreams**, each a numbered Train or a release-scoped bucket.
  The rule that a Train rides at most one release, and is never split across two, stands.
- **A Train whose cars span releases is not split automatically.** It is a candidate for the
  identity review in item 4 above, decided on its own evidence under #1942. Until that review, the
  cars that belong to another release may ride it as a bucket. No Train id is allocated in bulk
  as a side effect of sorting.

### Decision 5, as amended

Decision 5 said each release-labelled issue outside a Train is folded into an existing Train or
becomes the seed of a new one. Placing an issue in a release now answers a different question.

- **Release placement reconciles the forecast only.** The sort put every open issue in a release
  or in a named group of unscheduled work. That settles which version each is planned for. It
  does not settle which Train an issue belongs to, and most were placed in buckets.
- **The Train disposition Decision 5 asks for is still owed** for each such issue, and is made
  through the same candidate-by-candidate identity review, not by the sort.
- A `release:` label remains a proposal, never an assignment, as Decision 5 says.

### Consequences

- The release panel in the plan renderer admits buckets as well as numbered Trains, each
  validated by the same rules as a stand-alone train card (#2165).
- Roadmap 2's editorial data is the place release membership is recorded. GitHub milestones and
  `release:` labels are not changed by this amendment and are not required to match it.
- Sorting the roadmap by release did not complete Decision 5: the Train identity of the issues it
  placed in buckets is open, and is tracked with the identity review above.
