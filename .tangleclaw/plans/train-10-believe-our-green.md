# Train 10 — Can We Believe Our Own Green?

**Roadmap:** `TangleClaw-Roadmap/ROADMAP_STATE.md` "Blessed Next Train" — Train 10 runs first and
blocks Trains 11–15. Sequencing is the Roadmap session's; this plan holds the executable cars.
**Working artifact:** https://claude.ai/code/artifact/1f96ad65-92fe-49be-9417-b8716f750cbd
**Critic mode:** chunk per car (each car is its own branch + PR); `final` on the last car.
Cars are numbered as chunks (`Chunk N`) so the record lint can grade each one.

## Why this train exists

Every later train is verified by the suite and by CI's green. Two cars already shipped
(#1029 PID identity, #902 the suite spawned a real engine). What remains is the rest of the
same wound: the suite reads non-deterministically on a developer box (#831, #957), CI reads
green while not running the tests that touch the real world (#844, #835), and one guard
measures host plumbing rather than the behaviour it names (#969). Until these land, a green
run is a hypothesis, not evidence.

## Confidence check

1. **Problem:** a green suite/CI run does not currently mean "everything passed" — it means
   "everything that happened to run on this host passed, and some of it was luck."
2. **Success:** on `main`, CI says plainly what it certified and fails when a test joins the
   not-run set unannounced; the full suite passes on a developer machine with TangleClaw
   running and other work in flight; the upstream-drift check runs on a schedule that can go
   red; the refusal guard fails on the refusal, not on Node's error formatting.
3. **Out of scope:** running the engine-CLI tests on a self-hosted runner (#844 option 2 —
   an operator decision; the ledger records where those tests DO run); the reader's own
   parsing behaviour (#969 is about its guard); weakening any assertion (#957 says so).

## Requirements Confidence

**High.** Every car is a filed issue with an observed failure, a diagnosis the previous
session or this one verified against source, and named options; the two that needed a
choice (#844, #835) were made from the issue's own option lists and ratified by the Roadmap
session. Medium on one point: #957's headroom multipliers are chosen, not measured — the
load run in Chunk 5's Done-when is what confirms them.

## Chunks

### Chunk 1 — #844 CI names what it did not run
- `scripts/test-skip-audit.js` reads the junit report node:test writes and compares every
  skipped/todo test against a committed ledger, `test/skip-ledger.json`. A skip not on the
  ledger fails the step; the summary line states "certified N of M" on stdout and in the
  GitHub step summary.
- Options 1+3 from the issue. Option 2 stays with the operator; each ledger entry names
  where the test does run.
- `test/test-skip-audit.test.js` covers the parser, the audit verdict, the ledger's
  well-formedness, and that the ledger covers the known CI skip set without being a wildcard.
- **Done when:** CI on the PR runs the audit and passes; a synthetic unknown skip is red.

### Chunk 2 — #831 bare `git init` inherits the live template dir
- `test/_temp-repo.js` — one helper (`initRepo(dir, opts)`) that runs `git init` with
  `--template=` so the machine's global `init.templateDir` is never read.
- Every `git init` and `git clone` in `test/` moves to the helper (`initRepo`/`cloneRepo`), in every shape — command string, argv, local wrapper, `-c init.templateDir=`. Exception preserved:
  `test/git-template.test.js` "git init picks up the installed hook" tests the template
  mechanism itself.
- A source-scanning guard keyed on the SUBCOMMAND (init/clone), not a syntax, fails when a test file makes a repository any other way
  (the "one call site is not the family" rule, enforced).
- **Done when:** the guard finds only the helper and the sanctioned exception, and goes red
  when a bare invocation — in any shape — is reintroduced.

### Chunk 3 — #835 upstream drift check never runs in CI
- `.github/workflows/upstream-drift.yml`: daily schedule + `workflow_dispatch`; shallow-clones
  `brookstalley/prawduct` to `~/.claude/plugins/marketplaces/prawduct`, runs
  `test/c1-plugin-migration.test.js` with `TANGLECLAW_REQUIRE_UPSTREAM=1`.
- Under that env the "not installed" branch FAILS instead of skipping, so the scheduled run
  cannot be green by absence. Unset (developer machines, main CI) behaviour is unchanged.
- **Done when:** a manual dispatch of the workflow is green; the env flag makes the absent
  case red in the unit test.

### Chunk 4 — #969 refusal guard asserts on host plumbing
- The embedded Python program catches `ValueError` from `ast.literal_eval` and exits with a
  distinct code and a fixed message; the Node reader turns that exit into a typed error
  (`err.code === 'NON_LITERAL_INSTALL_REFERENCE'`).
- The test asserts on `err.code`. Mutations to run: lenient reader (emit `{}`) → red;
  `literal_eval` → `eval` → red (eval on a node raises `TypeError`, which is not the typed
  refusal).
- **Done when:** both mutations red, suite green on this host and CI.

### Chunk 5 — #957 threadpool assertion fails under load
- `_dir-scanner-pool-demo.js` samples an ordinary readdir BEFORE the workload as well as
  after; the test asserts the after-probe is not stuck and is within a bounded multiple of
  the before-probe rather than under an absolute 1000ms.
- The leak-mode assertion (`readdirStuck === true`) is untouched — it is the regression pin.
- **Done when:** the scanner-mode test passes with a concurrent full suite running on the same
  box; the leak-mode mutation (route scanner mode through the in-process helper) is red.

## Status
- [x] Chunk 1 — #844 (PR #1155, merged 3976a91)
- [x] Chunk 2 — #831 (PR #1156, merged 236bd78)
- [x] Chunk 3 — #835 (PR #1157, merged 5d889e1)
- [ ] Chunk 4 — #969
- [ ] Chunk 5 — #957

## Context
Session 2026-09-02/03, autonomous sprint. Work in `.claude/worktrees/train10`; the primary
checkout stays on `main` (live install). Roadmap session (`tangleclaw-roadmap-9aa2084a`)
notified at start; message after each ship.
