---
scope: train-16-chunk-03
lifecycle: completed
---

# Train 16 Chunk 03 — Two invariants get one owner each

**Issues:** #870 (pr-merge.js caps raw push stderr without redacting it), #1062 (engines: own
shell-safety for generated hook commands in one place).

**Critic mode:** chunk

## Why these two are one chunk

Both are the same shape: **an invariant that is restated at each call site instead of owned by
one.** #870 has redaction spelled out at one recorder in `commit.js` and absent from every producer
feeding it; #1062 has shell-quoting spelled out at each of two hook-emission sites. In both cases
the next call site added is the one that gets it wrong, which is what happened in #759 — the issue
#1062 was raised against, and what has already happened to #870 (see the mid-build amendment: one
of #870's sinks leaks today).

They touch different files and could ship apart. Pairing them is deliberate: the fix for each is
"move the invariant into the thing that produces the value," so reviewing them together makes the
shared shape visible, and the chunk is small enough that one Critic pass covers both.

## The confidence check

**Requirements Confidence: High** for both, and higher after the sweep than before it — the
pre-implementation sweep replaced #870's inferred scope with an enumerated one. Each issue names its
own files and functions, both were read directly, and neither depends on an unresolved ruling.

**Problem.** Two invariants have no owner. (a) `lib/wrap-steps/pr-merge.js` `_ensurePushed` takes
raw `git push` stderr — which can contain `https://<token>@host` — and applies a 200-character cap
and nothing else, while its sibling in `commit.js` applies userinfo-stripping and a secret scan to
the same class of text. (b) `lib/engines.js` `_buildBaselineHooks` wraps each emitted hook command
in double quotes at the call site; double quotes do not stop `$VAR` or `$(…)` expansion under
`/bin/sh`, and a literal `"` or `\` in a directory name breaks the quoting outright. All are legal
in a macOS directory name.

**Success.** (a) Every producer of remote error text routes it through **one** helper, so a `git
push` failure whose stderr carries a credentialed URL reaches no sink — log line, `activity_log`
row, or `_ensurePushed` reason — with the credential intact, proved by tests that fail before the
change. (b) A TangleClaw installed under a directory containing a space, a
`$`, a `"`, a `` ` `` and a `\` emits hook commands that `/bin/sh` runs as the intended single
argument, proved by tests that fail before the change.

**Out of scope.**
- Changing what `_ensurePushed` **decides**. It refuses to enqueue on any uncertainty; that
  contract is untouched. Only the text of its `reason` changes.
- Adding a NEW durable sink for `pr-merge`'s text. #870 records that this file has none, and that
  stays true — the leak the amendment found is in `commit.js`, which already had one.
- `activity_log` retention (#869).
- Which hooks `_buildBaselineHooks` emits, or when. Only how their command strings are built.
- #1395's build-plan chunk parser. Same session, unrelated mechanism.

## [REQUIREMENT SURFACED MID-BUILD 2026-09-11] #870 is a bug, and the fix is the producer

Found during the pre-implementation sweep the `#749/#759` learning requires (*"grep the pattern the
reason describes across the file, not the symbol you touched"*). The sweep was for #870's siblings;
what it found changes the chunk.

**`lib/wrap-steps/commit.js:1093` logs the raw stderr.**

```js
log.warn('wrap auto-PR close-loop degraded', { …, error: autoPr.error })   // raw
…
store.activity.log({ …, detail: { …, error: _truncateForRecord(autoPr.error) } })   // redacted
```

The same string, two sinks, thirty-five lines apart, one redacted. `log.warn` writes to
`~/.tangleclaw/logs/tangleclaw.log` (`lib/logger.js`, rotated across three files) — a durable sink.
A `git push` to `https://<token>@github.com/…` that fails puts the token in `pushRes.stderr`, which
becomes `result.error`, which reaches that file in plaintext.

**This is the failure `observability-strategy.md` § Direction already forbids.** Two clauses bind:

- *"No log line at any level may contain … an API key/token."*
- The #821 amendment: *"A producer of text that can embed a secret owns the redaction; a reporter
  may add a pass but must never be the only one."* Its stated evidence was one string, three sinks,
  one redacted. This is the same shape in a different file.

**Why #870 says there is no leak, and why that was reasonable.** The Critic that filed it looked for
a durable sink for **`pr-merge.js`'s** text and correctly found none. The conclusion was scoped to
the file it examined; the sibling's log sink was never in frame. This is the standing
*"a sweep's conclusion may never be stated more broadly than its own file glob"* correction
(observability-strategy, 2026-08-03) appearing from the other direction — a conclusion that was
narrow enough, read later as general.

**What changes.** #870 is a **bug**, not a chore. C1 no longer routes one function's text through a
helper; it moves redaction to the **producer**, so every sink inherits it and the next sink added
inherits it too. The producers are the eight sites where `detail` / `raw` is built from
`res.stderr` in `commit.js`, `pr-merge.js` and `pr-check.js`.

**Not in scope even so:** changing what any of those steps decides, their remediation text, or
`activity_log` retention (#869). The `activity_log` pass stays — the norm permits a reporter to add
one, and removing it would make the row depend on every producer being right forever.

## Chunks

### Chunk C1: Remote error text is redacted where it is produced

- [x] **C1 — Every producer of `git`/`gh` stderr redacts before the string escapes, so no sink has
      to remember.** Supersedes the narrower "extract the helper and call it from `_ensurePushed`"
      framing this plan opened with; see the amendment above.
      1. Move `_truncateForRecord` out of `lib/wrap-steps/commit.js` into a module the wrap steps
         share. Its order is already right — strip `//<userinfo>@`, run `secretScan.scanText`, then
         cap; the cap last because it is a size bound, not a redaction.
      2. Apply it at **every producer**, which the sweep enumerates rather than samples:
         - `commit.js` — the `git push`, `gh pr create` and `gh pr merge` failure sites, where
           `detail` is built from `res.stderr` and lands in `result.error`.
         - `pr-merge.js` `_ensurePushed` — #870's named site, replacing its bare `.slice(0, 200)`.
         - `pr-merge.js` and `pr-check.js` — the sibling `(r.stderr || r.stdout || …)` sites, which
           handle the same class of text from the same remotes.
      3. **Rewrite the two comments that die with the move.** `commit.js`'s helper says *"The length
         cap mirrors the one `pr-merge.js` `_ensurePushed` applies"* and the `activity_log` row says
         *"bounded the same way `pr-merge.js` `_ensurePushed` bounds it"* — both describe a
         duplication that no longer exists, and both point at a file that no longer has its own cap.
      4. **Local-only `git` sites are deliberately left alone** (`status`, `add`, `checkout`,
         `commit`, `rev-parse`). They touch no remote and carry no credential, and widening the
         change to them would bury the security-relevant edits in noise. Named here so the omission
         reads as a decision rather than a miss.
      **Done when:** a `git push` failure whose stderr carries a credentialed URL produces neither
      the userinfo nor the token in `log.warn`'s argument, in `activity_log`'s row, or in
      `_ensurePushed`'s `reason` — and the redaction contract's existing assertions still hold.
      **DONE 2026-09-11.** Suite green. All six producers mutated one at a time; five reddened a
      guard, and **`commit.js`'s `gh pr merge` site reddened nothing** — the push and create cases
      never reach it, so the guard was sampled rather than enumerated, exactly the shape the #749
      learning names. A test for that site was added and the mutation re-run red.
      Two further mutations pin the layering: reverting the producer alone, or the log's own pass
      alone, each stays green because the other still covers it; reverting BOTH reddens the log
      assertion. That is the property the Direction asks for — at least one pass always applies.
      The relocated assertions moved to `test/remote-output.test.js` with the function;
      they are the same contract under a new owner, not a weakened one.

### Chunk C2: The placeholder resolver owns shell safety

- [x] **C2 — `_resolveHookPlaceholders` escapes what it substitutes, so no call site restates it.**
      Per #1062's stated direction. What makes this safe to do *inside the resolver* rather than
      behind a separate quoting helper: `_resolveHooksObject` has exactly one caller, and its input
      comes only from `_buildBaselineHooks` — the template-declared-hooks path is dead since the
      methodology axis was removed, so the resolver sees no string it did not itself help build.
      1. `_resolveHookPlaceholders` substitutes a **shell-safe** rendering of the install directory.
      2. `_buildBaselineHooks` drops its own quotes at both sites, and the near-duplicate hazard
         comment goes with them — the invariant is now readable in one place.
      3. Both functions are exported (`lib/engines.js` module.exports), so their tests pin the
         contract and move with it.
      **Done when:** for an install directory containing a space, `$`, `"`, `` ` `` and `\`, the
      emitted `SessionStart` command runs under `/bin/sh -c` and receives the script path as one
      argument with no expansion — asserted against a real `sh` invocation, not a string comparison,
      because a string comparison would pass against whatever quoting the implementation happens to
      choose.
      **DONE 2026-09-11.** Suite green. Single-quoting chosen over escaping inside double quotes:
      it is the only quoting that is total, and it is the only option that lets the emission sites
      carry NO quotes, which is what actually moves the invariant. Two mutations run red — the
      resolver substituting bare, and the resolver substituting double-quoted, i.e. the form that
      shipped.
      **Eleven existing assertions had to be rewritten, and that is the finding.** Several matched
      on the command starting with a double quote, or on a double-quoted script path — both true of
      a double-quoted string carrying a variable reference, which still expands — so they passed
      against the defect, the same way the `endsWith(...)` assertions did in #759. They are replaced by `test/engines-hook-shell-safety.test.js`, which runs every
      command the producer emits through a real `/bin/sh` from a directory carrying all six hostile
      characters and asserts what the script RECEIVED.
      **The #759 guard had stopped testing its subject.** It resolved the placeholder with a
      hand-written `String.replace` instead of calling `_resolveHookPlaceholders`, so it
      reimplemented the very thing under test and stayed green while the resolver changed beneath
      it. It now calls the real one. The two files are kept apart deliberately: #759's enters at
      `_resolveHookPlaceholders`, this chunk's at `_resolveHooksObject` — the write path — and one
      call site is not the family.
      **Migration checked, not assumed.** Every install configured before this carries the
      double-quoted form on disk. Ownership is a substring match on the script's `data/hooks/`
      path and never looked at quoting, so the old entry is still recognised and replaced instead
      of preserved beside the new one — which would have given every existing project two prime
      hooks. Nothing proved that; a test does now.

## The mutation checks this chunk owes

The project's standing defect is a test that passes because it never exercised the real caller
("one call site is not the family"). Both chunks are exactly that shape, so both owe a mutation:

- **C1** — revert each producer to its raw form, one at a time, and watch a test go red for each.
  A test of the shared helper alone proves nothing about who calls it, and a single test covering
  one producer is the sampled guard the `#749` learning names. The log sink needs its own assertion
  on what `log.warn` RECEIVED — asserting on `activity_log` alone passes today, against the leak.
- **C2** — drop the escaping inside the resolver and watch a test go red **through
  `_buildBaselineHooks`**, not only through a direct call to the resolver. The hostile characters
  must reach `sh`.

## [POST-REVIEW 2026-09-11] The sweep was scoped by directory, not by the property

`rev-20260911T193806Z-b30dd7d0` — 0 blocking, 9 warning, 8 note. **All three reviewers
independently found the same thing**, which is the finding worth keeping:

**C1's sweep enumerated `lib/wrap-steps/` while its docstring, CHANGELOG and FEATURES entry all
stated the guarantee as repo-wide.** Five callers outside that glob still built text from failed
`git`/`gh` output with no pass — `wrap-pr-status`, `ci-status`, `update-checker`, `update-applier`,
`behind-origin` — and TWO of them logged it, the exact end state #870 closed. This is the chunk's
own "a sweep's conclusion may never be stated more broadly than its own file glob" correction
arriving from the other direction: the conclusion was narrow, the sentence was not.

Fixed by scope rather than by patch: the helper moved to `lib/remote-output.js`, because a module
whose contract is a PROPERTY cannot sit inside one of the directories that holds it. All five
callers now redact, each pinned by a guard that reddens when that site alone is reverted. Reading
`behind-origin` for the fix found a sixth site the review had not named — the same file builds three
reasons and only `gitFetch` reaches a remote.

**C2 had the identical shape.** `scripts/install-primary-guard.js#guardCommand` is the only other
generator of a `hooks[].command` and carried the same double-quoted defect; it was missed because it
lives in `scripts/`. The quoter moved to `lib/shell-word.js` and both generators share it.

**And fixing that exposed a coupling neither half's tests could see.** The same file READS the wired
command back to report what is installed, with a regex that hunted for double quotes — so changing
the generator made `--check` call a freshly-wired install STALE. Generator and reader are two halves
of one invariant. The reader now parses with `firstWord`, the quoter's own inverse, and a test
round-trips the pair over the hostile set. Writing that inverse turned up one more: `shellWord`
emits `'` → `'\''`, so the reader had to understand a backslash escape outside quotes or it was not
actually an inverse — a path containing an apostrophe lost the apostrophe.

Also fixed from the review: a wholesale redaction was taking the exit code away with the secret, so
a standalone reason read only `[redacted — …]`; the `_autoPrCloseLoop` JSDoc left floating by the
deletion; `data-model.md`'s pointer at the deleted `_truncateForRecord`; `prime-delivery-direction.md`'s
claim that hooks are replaced wholesale, which #752 stopped being true; and the undocumented `dir`
parameter.

**Accepted, not fixed:** three further byte-identical single-quote escapers remain
(`tmux.js#_escapeArg`, `openclaw-approve.js#shellQuote`, `wrap-steps/lint.js#_shellQuote`, plus an
inline one in `git.js`). None is defective — they are duplication, not a bug — and rewiring three
working call sites with their own test surfaces is a refactor of its own, not a finding-fix. Filed
rather than folded in. Likewise `guardCommand`'s `|| true`, which makes a guard failure silent: a
real question about that guard's behaviour, and nothing to do with quoting.

## [POST-VERIFY 2026-09-11] The finding-fix was the one line no test could see

`rev-20260911T200331Z-9d76ef8d` closed 13 of the 14 fixes and raised **one blocking finding against
a fix from the round before it**: the branch added for R-14 — keeping the exit code beside a
wholesale redaction — was reachable from no test. `REDACTED_PREFIX` appeared in the module and in no
test file; every scanner-hit assertion targeted `redactRemoteOutput`, which does not carry the
branch. Deleting the two lines left the suite green with the reviewed defect restored exactly as
filed. **Confirmed by mutation before fixing**, not taken on trust.

This is the project's standing "a finding-fix is new code" rule, and the reason it keeps recurring
is visible here: a fix written to satisfy a review is the code least likely to be mutated, because
it feels already-reviewed. It is the opposite — it is the newest code on the branch.

Pinned now by a falsifying PAIR, since one case cannot tell the branch from an unconditional
append: a scanner-flagged stderr must carry both the `[redacted` prefix and `(exit 128)`, and
ordinary text must carry no exit code at all. Both mutations run red.

Also batched in, per the review's instruction to decide everything in one pass: exact-sentence
assertions for the silent-exit and killed-push paths (the substring matches that stood could not see
a trailing `: exit N`, which is the R-1 defect's actual shape), `test/remote-output-callers.test.js`
added to the FEATURES suite index, the test header's stale pre-move path, and a CHANGELOG run-on.

## Verification

Suite green before and after; totals live in the evidence store (`prawduct-hook test-status`),
never copied into prose where they go stale.

C2's assertion runs a real `/bin/sh`. That is the point — the failure mode is "the string looked
quoted", and only a shell can say whether it was.
