# Pilot 4: Single-Builder Lifecycle 

**Target Issue:** [TST-5N8W] Switch `test/condition-log.test.js` to `node:assert/strict`

## 1. Clean Task Baseline
- Pilot-B1's previously dirty `CLAUDE.md` and untracked `data/tangleclaw.sqlite` were reconciled via a separate maintenance disposition (PR #1854).
- **First Step:** B1 will pull `main`, cut the `fix/tst-5n8w-strict-assert` branch, and output `git status --porcelain` to explicitly prove the task baseline is perfectly clean before starting implementation.

## 2. Implementation & Testing
- B1 will implement the ticket scope (strict assertions).
- B1 must run the focused test AND the full backlog-required test suite (`node --test`), ensuring 100% pass before proceeding.

## 3. The TangleClaw-Native Wrap
- The PM has locally verified `wrapAutoPrEnabled: false`, `releaseMode: off`, and `versionBumpEnabled: false` prior to launch.
- B1 will invoke the **TangleClaw-native wrap API** exactly once: `POST /api/sessions/TangleClaw-Pilot-B1/wrap`.
- **API Authorization Scope:** This exact loopback POST is a one-shot Operator-authorized call scoped entirely by the pilot rule to `TangleClaw-Pilot-B1`. It proves the wrap lifecycle only and grants NO durable agent-callable authority.
- **Payload:** `{"options": {"release": "hold", "keepSessionRunning": false}}`.
- B1 must stop initiating actions immediately after receiving the `202 Accepted` response. Any refusal, needs-operator, failure, stale run, or uncertain remote outcome stops for reconciliation; no blind retry is authorized.

## 4. PM Validation
- The PM will follow the returned `runId` via stream/status.
- **Acceptance Gate:**
  1. The 202 must return a `runId`, `sessionOutcomePlanned: "end"`, and `keepSource: "request"`.
  2. The terminal run state must be: `ok: true`, `sessionOutcome: "ended"`, `handoffPublication.state: "published"`.
  3. The session must no longer be active.
- No push or PR creation is Pilot 4 evidence.
