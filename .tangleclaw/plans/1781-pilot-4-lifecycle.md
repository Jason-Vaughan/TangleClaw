# Pilot 4: Single-Builder Lifecycle 

**Target Issue:** [TST-5N8W] Switch `test/condition-log.test.js` to `node:assert/strict`

## 1. Reconciliation & Branch Cut
- Pilot-B1 currently has a modified `CLAUDE.md` and untracked `data/tangleclaw.sqlite`.
- **First Step:** B1 will create a new feature branch `fix/tst-5n8w-strict-assert` directly from `origin/main`.
- **Reconciliation:** B1 will commit the modified `CLAUDE.md` to the branch as a chore commit (`chore: sync local CLAUDE.md paths`) to reconcile the dirty state without discarding its contents. The untracked `data/tangleclaw.sqlite` will be left alone as it does not interfere with git.
- **Verification:** B1 will output `git status` proving the task baseline is clean before writing any code.

## 2. Implementation
- B1 will implement the exact scope of `[TST-5N8W]`, converting `assert.equal` calls in `test/condition-log.test.js` to strict equivalents and ensuring the full test suite passes.

## 3. The TangleClaw-Native Wrap
- Before launch, the PM has verified `wrapAutoPrEnabled: false`, `releaseMode: off`, and `versionBumpEnabled: false` in Pilot-B1's `.tangleclaw/project.json`.
- B1 will invoke the TangleClaw-native wrap API exactly once using `curl` to its bound endpoint: `POST /api/sessions/TangleClaw-Pilot-B1/wrap`.
- The exact payload MUST be: `{"options": {"release": "hold", "keepSessionRunning": false}}`.
- B1 will wait for the `202 Accepted` response. After receiving it, B1 must completely stop acting and await termination.

## 4. PM Validation
- The PM will stream the `runId` status until terminal.
- Acceptance requires: `sessionOutcomePlanned: "end"`, `keepSource: "request"`, then a terminal state with `ok: true`, `sessionOutcome: "ended"`, `handoffPublication.state: "published"`, and the session no longer active.
- No push or Draft-PR creation is authorized during the wrap or as evidence for Pilot 4.

