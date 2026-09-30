# ADR 0021: Release-candidate certification is judged privately on the host and published through an allowlist to a guarded `metrics` branch

**Status:** Accepted (2026-09-27). This records the Architect's rulings on the C02 plan for #1949
(Q2–Q4, relayed by the ProjectManager) and the privacy design they rest on. Q1, which branch C02
builds on, was not ruled.
**Source issue:** #1949 (Train 30: v5.30.0 release-candidate certification and public scorecard).
**Builds on:** the C01 certification core (`lib/release-certification/`), which judges a 72-hour soak
of one exact candidate SHA and keeps its evidence private under
`<tangleclawHome>/release-certification/v1/`.

---

## Context

A release is certified by watching one candidate run for 72 healthy hours. The evidence that
decides it names the host, the candidate's worktree path and the owned ttyd's generation, which
contains a process id. So it lives on the host in a directory only the owner can read.

The decision has to be checkable by people other than that owner, and release promotion (C04) has
to be able to trust it. That creates two problems:

1. **A GitHub Action cannot read the evidence.** It runs in GitHub's cloud, and the evidence never
   leaves the host.
2. **A digest the owner can rewrite binds nothing.** The run's manifest (what is certified, and
   under which thresholds) is fixed by its sha256, stored beside the evidence. That catches an edit
   made out of band, but the owning user can rewrite the manifest and the digest together.

## Decision

1. **The host publishes, and GitHub guards.** The host builds the public documents and pushes them
   to a dedicated `metrics` branch, with no shared history with `main`. A GitHub check re-verifies
   the branch's whole history against the publishing rules (`scripts/scorecard-verify.js`). It runs
   from `main`, every 30 minutes and on demand, not on push to `metrics`: GitHub runs a
   push-triggered workflow from the pushed commit, and the data-only branch neither carries nor may
   carry workflow files. One living on `metrics` could also be edited by whoever pushes there. The most important rule is that an
   admission record, once published, never changes. An owner-configured ruleset on `metrics` forbids
   force-pushes and deletion. Together these put the manifest digest somewhere the host user cannot
   quietly rewrite, which is what makes it binding. Release promotion (C04) runs the same
   validators before it promotes.

2. **Public documents are built from an allowlist, never by deleting from private state.**
   `lib/release-certification/scorecard.js` builds every published document field by field, and its
   validators refuse any field they do not declare, at every nesting level. A field added to the
   private evidence later stays private until someone deliberately publishes it. The following are
   never published:
   - the worktree path, the host and the ttyd generation;
   - raw samples and probe diagnostics;
   - a failure's per-probe reasons (only its code and time are published).

3. **Fail closed at admission (ruling Q2).** `start` refuses until the candidate's admission record
   is published to `metrics` *and* has been read back and verified. No certification run begins
   unpublished. To keep a crash between publishing and committing the run from using up the
   candidate, `start` writes its manifest locally first and reuses it on a retry. Re-publishing the
   identical record is then a no-op, not a collision with the write-once rule.

4. **Publishing failures do not extend the soak (ruling Q3).** The scorecard is a view of the
   evidence, not evidence. After admission, a failed publish is recorded in `publish.json`, emitted
   as a `publish-failed` event (the runner's alert), shown by `rc-cert status`, and retried with
   backoff. Qualified time is unaffected. A final publish that fails when the runner exits is
   retried by hand with `rc-cert publish`. Ruling A1's "GitHub failure extends" applies to the
   GitHub *checks probe*, which judges the candidate, not to the push of our own scorecard. C04
   refuses promotion until every required fact is published.

5. **Unattended publishing is authorized, to `metrics` only (ruling Q4).** The runner may push
   without an operator present during a 72-hour run.
   - **What it pushes:** only the allowlisted documents, only under `release-certification/v1/` on
     `metrics`, never to a source branch and never by force.
   - **How it pushes:** from its own private clone of `metrics` (one per remote, under one lock, so
     runs of different candidates never share a working tree mid-publish), never from the
     candidate's worktree (which must stay exactly the candidate). At most one publish a minute,
     except a final state. The repository's git hooks are off, because
     they govern source work. Commits carry the operator's configured git identity.
   - **When the remote moved first:** a push rejected because another publisher got there first is
     rebuilt from the new tip and retried.

6. **The operator's actor id is published by default.** An acceptance or cancellation publishes the
   identifier the operator chose (for example `jason`), because a public certification should say
   who passed it. `rc-cert start --no-publish-actor` withholds it for that run: only the time is
   published, and the run's commits carry a neutral identity instead of the operator's git name.
   The setting, and the remote the run publishes to, are pinned in the checksummed manifest, so no
   later failure can reset them. Changing this
   default is a privacy decision and should come back here, not happen in code.

7. **One public scorecard, derived from the per-candidate files (Architect ruling, 2026-09-27).** The
   project publishes one combined `scorecard/v1.json`, with a `development` section (C03) and a
   `certification` section. The certification section (`tc.release-certification.summary/v1`: the
   candidate list and the newest candidate's scorecard) is a projection of the per-candidate files,
   built by `certificationSummary` and checked by `validateCertificationSummary`. The per-candidate
   admission, scorecard and event files stay the source of truth, because the write-once admission
   is what makes the manifest digest binding. A later chunk schedules the producer that writes the
   combined file.

8. **Only canonical thresholds certify, and the record says where the checks came from** (PR
   review of #1962, relayed by the PM). `accept` refuses a run judged by non-canonical thresholds,
   and a published `passed` scorecard must carry `canonicalThresholds: true`, so a smoke run can
   never be mistaken for a certification. `requiredChecksSource` (`branch-protection` or
   `operator`) is published with the admission and every scorecard, so an auditor can tell a
   candidate judged by the repository's own rules from one judged by a hand-picked list.

9. **Verification checks that the history is internally consistent, not that a soak happened**
   (cumulative review of C02; narrowed after the PR #1975 review). One transition table in
   `codes.js` is shared by the state machine and the verifier. A published `awaiting-review` or
   `passed` must show its targets met, every state change and transition line must be one the
   table allows, and the times must agree with each other (`TIMELINE_INCONSISTENT`): the run starts
   no earlier than its admission; qualified time is at most `elapsedMs` and at most
   `updatedAt - admittedAt`; `elapsedMs` is the span the scorecard's own times give; transition
   times never go back, begin at the run's start and fall within `[admittedAt, updatedAt]`; and
   an acceptance comes no earlier than the review it accepts. The PR review found a history
   claiming the full 72 qualified hours a minute after admission that passed every earlier rule;
   it now fails. Every time judged is one the publisher wrote, so the verifier refuses a history
   that contradicts itself, not one that is consistent and invented: how long a run really took
   rests on who can push to `metrics` (the ruleset below). The state machine keeps its own output
   inside these rules even when the clock is stepped: earned time never exceeds how far
   `updatedAt` moved, and transition, acceptance and cancellation times are clamped to it. The
   publisher runs the verifier on each commit before pushing it; a violation fails the publish
   (`WOULD_VIOLATE`) instead of landing on a branch whose history is permanent.

10. **A runner with no route to GitHub gets its checks from the host, sample by sample** (#2020,
   Architect rulings Q1, A31 and A32). The certifying soak runs in a guest with no egress and no
   credentials, so a manifest can set `checksSource: host-attested`. The host mints the run's id
   (`rc-cert host-mint`: 128 random bits, recorded with the repository and checks it will judge),
   and the guest's `start --run-id` pins it in the checksummed manifest along with the exchange
   directory. For the admission sample and for every later sample the guest writes a request, and
   the host (`rc-cert host-checks`) reads GitHub and answers with a verdict bound to the candidate
   SHA, the run id, the sample's number and the manifest digest, carrying a digest of its own
   content. The host appends every verdict to its own ledger before the guest can see it. The guest
   accepts a verdict only when every binding matches the sample it is taking; a missing, late,
   unparsable, mismatched or stale verdict reads as GitHub unavailable, which earns no time, and a
   verdict for a run the host never minted is never written. Admission is therefore two-phase: the
   manifest is staged first, and the admission sample is taken bound to its digest, so no run and
   no time exist before a green verdict for that exact manifest. At the end,
   `rc-cert host-finalize` joins the run's exported samples against the ledger (the admission
   sample and every sample that earned time must carry a verdict the host really issued, green for
   every required check), reads the checks once more, and records the outcome; any gap, mismatch,
   non-green verdict or drift fails it, and the outcome is recorded for that run alone, so a later
   run of the same candidate can never overwrite or stand in for it. Freshness is judged on the
   guest's clock only: a verdict must echo the time its own request carried and arrive within the
   guest's bounded wait, and at finalization each sample must have been taken within one sampling
   interval of the request its verdict answers. The host's clock is recorded, never compared.

   **Who reads the finalization.** The guest's `passed` is not a certification of record in this
   mode, because nothing on the guest can prove a verdict came from the host. The host relay
   (`rc-cert host-publish`) is the reader: it makes a host-attested pass certification of record
   only on an `ok` finalization of that exact run and manifest digest. So a public reader can tell
   what a pass owes, the admission record publishes `checksSource` and `runId`, and every scorecard
   publishes `checksSource`. Promotion (C04) must require the host's record for any admission whose
   `checksSource` is `host-attested`. In `gh` mode the runner reads GitHub itself, as before, and
   mints its own run id.

11. **A crash between publishing the admission and committing the run never uses up the
   candidate, even across a reboot** (B1 review, R-3; Architect ruling A47). The run's baseline is
   what the admission sample observes, written once into the run's state with the run itself: the
   ttyd generation and, in a guest, the boot identity, the packet-filter ruleset digest and the
   digests of both isolation attestations. The manifest declares `baselineSource: admission`, and the
   admission record publishes it, so no reader takes the manifest's staging-time values for the
   baseline. A retry before admission may reuse the public manifest, but never an earlier verdict
   or sample. After admission, a changed ttyd generation, boot identity or ruleset fails the run
   irrevocably; the baseline is never rewritten in place.

12. **A guest publishes only to a local repository; the host relays exactly what it published**
   (#2020, Architect rulings Q2 and A31 constraint 4). A host-attested run's manifest must name its
   publish remote by an absolute path, so git cannot turn it into a network transport; a URL,
   `file://` or `host:path` is refused. The guest's publisher, preflight and verifier are the same
   as on a host, pointed at a local bare `metrics`. `rc-cert host-publish` then relays it: the
   host's own `ok` finalization of that run and manifest digest must exist; the guest's whole
   history must pass the branch verifier; the guest's tip is pushed to the public remote as that
   exact commit, fast-forward only and never forced; and the remote is read back, which must name
   that commit and hold the candidate's admission and scorecard byte for byte. Only then does the
   host write its record, and the record says a run is certified only for a `passed` scorecard
   judged by canonical thresholds with an `ok` finalization that holds a passing soak judgement
   bound to that run (point 14). Only the host process ever names the
   public remote, so no credential enters the guest, and GitHub's availability decides when a
   result is published, never how much time a run earned.

   The guest is read exactly once, fetched into the host's relay repository and pinned by commit,
   and every check, the push and the read-back use that one commit: a guest that moves its branch
   mid-relay cannot get an unchecked commit published. Each public remote has its own relay
   repository, held under a lock. The record (`record-<runId>-<oid>.json`) is created once and
   never overwritten (Architect ruling A54): a relay re-run after an interruption returns the
   identical record, and a different one under that name is refused. It binds the read-back commit
   and its tree, the sha256 of the admission, the scorecard and the host's finalization file, the
   run id, the manifest digest, the checks source, the boot identity and the digest of the
   committed sample set, with a digest over all of them. `verifyRecord` re-derives each of those
   from the public remote and the host's finalization, the verdict included (`state`,
   `canonicalThresholds` and `certified`, from the published scorecard and the finalization), since
   a record's own digest can be recomputed by anyone; C04 promotion must use it and never trust a
   record's own fields (A51). The record is written under a temporary name and hard-linked into
   place, so a crash never leaves a partial record.

13. **A guest's network isolation is attested at admission, at every sample and at
   finalization** (#2020, Architect rulings A43 and A44). The workload a soak runs as must be
   refused `pfctl`, so it cannot also read the packet filter: isolation is attested in two joined
   planes. The admin plane covers the packet filter being enabled, its exact normalized ruleset
   digest, the interfaces and addresses, the boot identity and a `host-only` management path
   (inbound SSH admitted only from the configured host, all guest-initiated egress denied; `open` is
   a breach, and a listening SSH is never called closed). The
   workload plane covers its dedicated non-admin identity, `sudo` and `pfctl` refused, the loopback
   API reachable, and IPv4, IPv6 and DNS egress denied. A program pinned in the manifest (Chunk 1's
   `guest-setup.sh --verify-network`) produces both for each sample, echoing that sample's binding
   (candidate, run id, manifest digest, sample number). It runs as the guest admin only, takes one
   fresh raw `--verify-admin` line and one fresh `--verify-workload` line (the latter as the workload
   user, through `sudo -n -u`), and joins them through `lib/soak/attest-bridge.js`, which copies the
   binding into both planes and refuses anything it cannot convert without guessing. Nothing is
   cached or reused. Both must agree on the boot identity. The producer's result is one of exactly
   three (Architect ruling 727dcaaf): a healthy `{admin, workload}` pair; a measured breach, a
   closed `isolation-breach/v1` envelope bound to the same sample that names each plane's unsafe
   fact (`pf-disabled`, `pf-rules-changed`, `privileged-workload`, `sudo-permitted`,
   `pfctl-permitted` or `egress-permitted`) and never fabricates a healthy plane; or unavailable.
   A raw verifier reports a breach only when it positively measured the unsafe fact; a missing
   tool, a timeout, unparsable output or any other inability to measure is unavailable, never a
   breach. An unavailable result keeps a stable failure class and the last 300 printable
   characters of the producer's stderr as a private sample diagnostic, which no scorecard
   publishes. A missing, malformed, unbound or split pair earns no time (`ISOLATION_UNATTESTED`);
   a well-formed pair that shows isolation broken, or a valid bound breach envelope, fails the run
   (`ISOLATION_BREACHED`); so does a boot identity
   or ruleset other than the admission's (`BOOT_CHANGED`, `ISOLATION_CHANGED`). The digests of
   both planes travel with each sample, and the host's finalization requires them, from the
   admitted boot, on the admission sample and on every sample that earned time.

14. **No certification of record without a passing soak judgement bound to the run** (#2020,
   Architect rulings A4 to A7). `rc-cert host-finalize` takes the soak's evidence bundle
   (`--soak-bundle`) and runs the soak's certification judge (`lib/soak/judge.js`) on it for that
   run's candidate SHA, run id, manifest digest and window. The judge re-derives everything from
   the bundle's files and fails closed. Every scheduled event of the certifying 72-hour schedule
   must have run once and succeeded, the log must span the full schedule (the soak driver writes
   `end` only at its horizon), and the integrity samples must cover the whole log with no
   corruption and a healthy server at the end. The bundle must name the candidate it ran as an explicit
   full SHA, which the operator states and nothing infers, and which must equal the run's. An
   ownership-unverified soak log fails and resets unless the Operator accepted exactly its bytes.
   The judgement is recorded in the finalization, which is `ok` only when it passed and is bound
   to the run. `certifiedFrom` checks the same binding again, so a finalization written without a
   judgement never certifies. The relay record binds the finalization's sha256, so it binds the
   judgement and, through its digests, the soak evidence. The judge lives with the soak and
   release certification does not depend on it: they share only the schema name
   `tc.soak-judgement/v1`, and `rc-cert` is where the two meet. This gate is the host-attested
   path's; a local run's `passed` scorecard is unchanged.

## Consequences

- Until the owner creates the `metrics` ruleset, the digest is published but not tamper-proof. The
  C02 PR says so, and C04 must not treat the branch as binding before then.
- On a host (`gh` checks), admission depends on GitHub being reachable. A GitHub outage delays a
  start but never shortens or lengthens a run in progress. In a guest (host-attested), admission
  depends on the host answering its checks and on the local `metrics` repository; GitHub matters
  only when the host relays the result.
- There are three validators (the host before pushing, the branch check, and promotion) but one
  definition. A change to a published shape happens in `scorecard.js`, and all three follow.
- Times are published as epoch milliseconds in UTC. Human formatting, including the registry
  cards' America/Los_Angeles display, is the reader's job.
- **`metrics` is created by the publisher, as an orphan branch** (Architect disposition on PR
  #1975). The publisher's first publish starts from an empty tree, so the branch shares no
  history with `main`. A branch created in GitHub's UI inherits `main`'s source files, which the
  path allowlist forbids; once the ruleset prohibits force-push, that violation is permanent. The
  owner therefore creates the ruleset after the first publish, never the branch itself.
- **The branch holds regular files only.** A symlink, submodule or executable on `metrics` is
  refused by the publisher before it is checked out (`METRICS_TREE_UNSAFE`) and flagged by the
  verifier (`NOT_REGULAR_FILE`), because a clone that checked one out could be pointed at a file
  outside itself.
- **C03 must not publish `scorecard/v1.json` until the path allowlist and the verifier admit it.**
  Point 7 describes the combined file, but today `PUBLISHED_PATH` does not include it, so a
  producer that wrote it would fail every publish (`WOULD_VIOLATE`) and every branch check.
- **C04 judges from the admissions and scorecards, never from `index.json`.** The index is a
  projection the publisher rewrites on every publish; the write-once admission and the
  per-candidate scorecard and transition log are the authority, and promotion re-verifies them.
