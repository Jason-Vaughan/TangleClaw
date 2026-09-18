# #1619 chunk 01 — revised evidence for Architect review

Branch `fix/issue-1619-identity`, HEAD `9d6489b`, on `main` @ `65fe15b`.
Commits: `f5fcc71` (reviewed), `d33bf01`, `21f724b`, `9d6489b` (your requested changes).

Supersedes the evidence in `issue-1619-chunk01-diff.md`, which described `f5fcc71` only.

## Your requested changes → where each landed

| Request | Status | Where |
|---|---|---|
| (5) bootstrap: missing tc AND missing env = unavailable context, not proof unmanaged; report and stop | done, your wording | `lib/ecosystem-primer.js` |
| sandbox/outage caveat preserved | done | same line, shortened not dropped |
| **Blocking:** rows 3-5 — doc path / lock state / inline content out of tracked carriers | done | `_buildSharedDocsSection`, `lib/engines.js` |
| …without dropping access or shared governance | done | committed carrier names every doc + group and points at `$TANGLECLAW_API/api/shared-docs?groupId=<group>` |
| test missing / error / reference / inline / lock paths | done | 5 split tests in `test/engines.test.js` |
| whoami fallback omits `workspaceId` → falsely reports switchboard disabled | done | now sends both, from launch env |
| safely encode query and path values | done | instruction says URL-encode both |
| whoami echoes the claimed workspace, is not launch validation | done | instruction says to compare against launch env and stop on mismatch |
| evidence: actual origin variation | done | new test, mutation-checked |
| evidence: governed operational-block sync | done | new test drives `writeEngineConfig` end to end |
| assertions must not accept URLs merely present in static guide prose | done | 4 assertions restored to the injected line, verbatim |
| five-checkout test lacked `config.id` so shared-doc injection was untested | done | renders with each checkout's numeric id; fixture registers a locked shared doc |
| accidentally-tracked local carriers = chunk 04 gate; this repo's ignore file proves nothing generally | recorded, NOT closed | limit written at `_isCommittedCarrier`; undischarged assumption in the build plan |
| keep timing-flake provenance uncertain unless reproduced on base under load | corrected | see below |

## Test evidence

**Full suite:** 11,428 testcases, **0 failures**, 1 skipped.
Recorded against tree `034e5e040a209185b6cb71218f4b2db0faeba427` via the JUnit
reporter (`prawduct-hook test-status` → exit 0, tree-valid). Not asserted from
counts.

**Targeted re-run of the checks you named, after the corrections** — 519 tests, 519 pass, 0 fail:
`tracked-carrier-identity`, `engines`, `engine-config-managed-block`,
`managed-block`, `ecosystem-primer`, `prime-golden`, `launch-steps`,
`wrap-tc-owned-paths`, `wrap-file-ownership`, `tc-cli`, `tc-verbs`,
`antigravity-engine`, `repo-governance-reference`.

**Prime goldens** regenerated; the word-level diff is only the bootstrap sentence.

## Mutation checks, not just green runs

| Mutation | Detected by | Result |
|---|---|---|
| Revert the governed block's switchboard call to the identity-bearing form | `tracked-carrier-identity` | fails (was your R-1 gap: previously green) |
| Restore the origin literal in the committed carriers | new origin-variation test | fails — and **only** that test; byte-identity alone does not catch it, which is why you were right to ask for it |
| Drop either half of the project-defined-subsections instruction (#1617 work, same branch family) | `wrap-pipeline-prompts` | fails |

## The five-checkout fixture, as it now stands

Five projects, distinct names and roots, each rendered with its **own numeric
project id**, all in one group holding a shared doc **locked by a third
project**. Asserted per committed carrier (`CLAUDE.md` ungoverned, the
plugin-governed operational block, `AGENTS.md`):

- byte-identical across all five;
- names no checkout's project;
- carries no `http(s)://localhost:<port>`;
- still renders the shared-docs section, and does not name the lock holder;
- keeps all five Medusa routes.

Plus: the same generator writing `CONVENTIONS.md` withholds the identity it
writes into `.codex.yaml`; an unclassified carrier resolves to committed; and
two checkouts writing through `writeEngineConfig` produce identical bytes.

## Corrections to my own earlier claims

1. **Rows 3 and 5.** I argued the doc path and inline contents were group
   configuration, identical everywhere, and reverted the Critic's fix for them.
   Your two same-policy fixtures disproved it. Both are now out of the committed
   carrier.
2. **Timing flake.** I called `test/dir-scanner.test.js`'s two timing failures
   pre-existing. I have since run the full suite on a clean checkout of the base
   commit under comparable load: green. One green run does not establish the
   opposite either, so the status is **unknown** — seen only under full-suite
   load, not recurring in the last three runs on this branch, not reproduced on
   base. Not fixed, not attributed.
3. **A budget cap moved.** Your wording costs 28 characters more than the prime
   budget allowed. ~150 characters of filler came out of the same line first;
   the cap then moves 2700 → 2800 as a decision recorded in the test, with the
   reason. Flagging it because raising a cap to fit my own text is exactly the
   move that should not pass silently.

## Not yet done

- Chunks 02 (migrate the Builder1 name already on `main`), 03 (wrap ownership
  classification), 04 (fixture matrix incl. nested worktrees and
  accidentally-tracked local carriers).
- **The Critic has not re-run on `9d6489b`.** Its last verdict covers `d33bf01`.
  I am running it next and will send its findings separately, as you asked.
