---
artifact: build-plan
version: 1
scope: shared-exec-1561
branch: chore/shared-exec-1561
partition: serial — one runner module and the four callers that switch to it; their tests share the fake result shape
governed_by: []
---

# #1561 — one shared execFile runner for git/gh, with prompts disabled (Train 20 quick win)

**Issue:** #1561. **Authorized:** operator "Take 1,561 as our quick win. Go." in the Builder pane, 2026-09-17.
**Branch / worktree:** `chore/shared-exec-1561`, `.claude/worktrees/shared-exec-1561` (from `main` at `7e1628b7`).
**Critic mode:** cumulative (Type: cumulative-final). **Visual change:** no. **Size:** medium (a module move and
four callers, plus their tests).

## Confidence check

**Problem.** A `git` or `gh` call that reaches a credential prompt waits for its full timeout, because only
`lib/stranded-check.js` disables prompts. Four modules hand-roll the same `execFile` wrapper, and each decides for
itself what a missing binary, a timeout or a signal means.

**Success.**
1. One runner module (`lib/exec.js`) spawns every argv- and shell-form child for these callers. It resolves to
   `{exitCode, stdout, stderr, error, errorCode, timedOut}`, never rejects, and sets `GIT_TERMINAL_PROMPT=0` and
   `GH_PROMPT_DISABLED=1` for every child.
2. `lib/stranded-check.js`, `lib/ci-status.js`, `lib/gh-issue-state.js` and `lib/wrap-pr-status.js` use it, keeping
   their own timeouts, buffer sizes and `_internal.exec` hooks. Their operator-facing reasons are unchanged.
3. `lib/update-checker.js`'s async `git ls-remote origin` no longer waits on a prompt.

**Out of scope.**
- The wrap steps' `defaultExec` functions. They already call the shared runner and only set per-step timeouts
  and test seams; the issue's "each caller keeps its own timeout and hook" is exactly what they are.
- `execFile` users that never run git or gh (launchctl, systemctl, tmux, ttyd, nc, engine probes, openclaw ssh).
- The synchronous `execSync` git calls in `lib/update-checker.js` (`lsRemoteSync`, `gitRemote`), which are a
  different call family.
- `GIT_SSH_COMMAND` batch mode (`lib/behind-origin.js` sets it for its own fetch). Setting it everywhere would
  override an operator's own `GIT_SSH_COMMAND`. `[ASSUMPTION: the two prompt variables are enough for this issue |
  LOW | operator can ask for ssh batch mode]`

**Requirements confidence: HIGH.** The issue names the module, the result shape and the classification.

## Found when checking the issue against the code (2026-09-17)

- The issue's "about ten wrappers" counts the wrap steps' adapters. The spawn and the killed-vs-failed decision
  already live once, in `lib/wrap-steps/_exec-shell.js` (#894, #897). `lib/wrap-scope.js` already requires it from
  outside `wrap-steps/`. The real copies are the four modules named above, plus `session-leftovers`, which borrows
  `stranded-check`'s.
- The shared result's `error` is a string. The four copies return the raw `Error`, and their reasons read
  `.code === 'ENOENT'`, `.killed` and `.signal`. A timed-out shared result exits 124, not 1.

## Decisions

- **D1:** `git mv lib/wrap-steps/_exec-shell.js lib/exec.js`, and update every require. No shim is left behind.
- **D2:** results gain `errorCode`: the non-numeric `err.code` (`ENOENT`, `EACCES`,
  `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), or null. `timedOut` stays the one timeout answer.
- **D3:** `NO_PROMPT_ENV = {GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1'}` is layered over the caller's env (or
  `process.env`) in both runners.
  `[DECISION: for every child, not only git/gh | the server has no terminal, so no child can answer a prompt; the
  shell form runs gh too (pr-merge, pr-check) | none]`
- **D4:** each of the four callers keeps a local `defaultExec` that calls `execFileArgs` with its own timeout and
  buffer, and reads `errorCode` / `timedOut` instead of the raw error. Reason wording is unchanged.
- **D5:** `lib/update-checker.js` `lsRemote` passes `env: {...process.env, ...NO_PROMPT_ENV}`.
- **D6:** `lib/session-leftovers.js#_iso` is replaced by an exported `isoFromSqlite` from `lib/stranded-wraps.js`.

## Decisions made while building (2026-09-17)

- Test doubles for runner results moved to `test/_exec-results.js` (`notFound`, `spawnFailed`, `stopped`,
  `exited`), and `test/exec.test.js` deep-compares each one with a real spawn. Six test files swapped their
  hand-built raw-`Error` doubles for these. Each case asserts what it asserted before; only the double's shape
  changed, because the seam's contract changed.
- `test/exec.test.js` also runs each caller's real default runner and checks that the prompt variables reach the
  child. That is the guard against a module drifting back to its own `execFile`.
- `lib/update-checker.js` gained `_lsRemoteOptions()` (the pattern of `behind-origin.js#_fetchOptions`), so the
  prompt setting is testable without a network call.
- A case that tried to prove "git fails at once instead of prompting" with a real https URL was dropped: a
  refused connection fails fast with prompts on or off, so it could not tell the two apart.
- The gh-issue-state timeout test now carries a 404 in its partial output. Without it, `_isNotFound`'s
  timeout guard was covered by nothing.

- Cumulative Critic (0 blocking, 7 warnings), all fixed in one pass: `signal` on results and `didNotRun` (a
  crash or outside kill is not an answer); one `describeFailure` wording replaces four reason builders (deliberate
  wording changes are listed in the change-log); `wrap-pr-status` names a missing gh or a timeout; the sync git sites
  (`update-applier`, `update-checker`) and `behind-origin` use `NO_PROMPT_ENV`, which reverses the plan's first
  out-of-scope call for the sync update-checker calls; `boundary-patterns.md` and FEATURES updated.

### Chunk 01: shared runner
Type: cumulative-final

1. Tests first: `errorCode` for ENOENT (real spawn) and for a numeric exit (null); the prompt env reaches a
   real child in both runners (read back by `sh -c 'echo $GIT_TERMINAL_PROMPT'` / `node -e`); a caller's env is
   kept.
2. Move the module, add `errorCode` and the env, update requires.
3. Switch the four callers and `session-leftovers`, and update the test doubles to the shared shape.
   Each caller's reason tests keep their assertions.
4. `update-checker` env; `isoFromSqlite`.
5. Deliberately break each rule once.
6. Docs: CHANGELOG `### Fixed` (no more waiting on a prompt) plus `### Internal`, FEATURES citations to the moved
   module, change-log entry.
7. `/prawduct:critic cumulative`, then open a PR with `Fixes #1561` and wait for green CI before asking to merge.

## Done when

- The suite is green (TAP-confirmed), and every deliberate breakage is caught.
- The cumulative Critic has zero blocking findings.
- A PR is open with `Fixes #1561` and its CI is green.

## Status

- [ ] Chunk 01: shared runner
