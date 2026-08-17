# 702 — "Ask the session to fix this" button on content-authoring wrap blocks

Issue: https://github.com/Jason-Vaughan/TangleClaw/issues/702
Type: feature (small, frontend-only). Branch: feat/702-handback-to-session

## Problem
When a wrap blocks on a content-authoring step (ai-content: changelog-update /
learnings-capture / memory-update), the operator must leave the drawer, go to the
session pane, and hand-type the fix. Painful on mobile. (Lived on TiLT 2026-07-24.)

## Design (frontend-only — reuses POST /api/sessions/:project/command)
1. wrap-drawer.js — add `agentResolvable` to the row view-model:
   `isBlocker && kind === 'ai-content'`. Add `composeHandbackPrompt(row)` — single-line
   (flatten newlines; tmux send-keys splits on newline), length-capped, includes stepId +
   remediation + a "genuine fix, not gate-appeasement" instruction. Both testable/exported.
2. session.js — in buildStepRowEl, when `row.agentResolvable`, render an
   "Ask the session to fix this" button inside the remediation panel. onClick → POST the
   composed prompt to /api/sessions/<project>/command; on ok → button "Sent — resolve in the
   session, then Retry" (disabled); on error → toast (injectCommand already checks liveness).
3. session.css — button style.
4. Tests (wrap-drawer.test.js) — agentResolvable matrix; composer flattens/caps/includes.
5. CHANGELOG.md (### Added) + .prawduct/change-log.md (scope=wrap-702) + Fixes #702.

## Guardrails (from the issue)
1. content blocks only → `kind === 'ai-content'` gate.
2. liveness → injectCommand checks active+tmux; button only shows on a BLOCKED step
   (pipeline halted → no live capture to collide with). Errors surface via toast.
3. genuine fix, not gate-gaming → prompt wording.
4. v1 = operator still taps Retry; no auto-retry loop (deferred to v2 + loop guard).

## Done when
Blocked ai-content step shows the button; click injects the composed prompt into the
owning session; non-ai-content / non-blocked rows never show it; unit tests green; Critic clean.
