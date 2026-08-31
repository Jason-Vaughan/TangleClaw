# Build plan — #1122 Birth-awareness ecosystem primer

**Issue:** https://github.com/Jason-Vaughan/TangleClaw/issues/1122 (operator-ratified scope in body)
**Size:** medium (one new module + wire-in + tests + docs). Single chunk.
**Critic mode:** skipped — routine Critic runs operator-paused (2026-08-19); back-run planned.

## Problem
A brand-new session on a brand-new project wakes up not knowing it lives inside TangleClaw: no API base, no numeric project id (the #1121 trap), no MagicDNS convention, no knowledge the Project Rules store exists or how the learnings loop feeds it. CasaJirafa needed a cross-session tutorial for what should be birth knowledge.

## Success
`generatePrimePrompt` injects a compact `## TangleClaw Ecosystem` section into every prime, rendered from a **declared roster** (data, not prose — operator-endorsed design note), carrying:
1. TC identity: managed-by-TangleClaw + API origin (`_apiOrigin`-equivalent) + the project's **numeric id** with the "APIs key on the id, not the name" warning.
2. MagicDNS: operator-facing links never use `localhost`; interpolate the real host (`session-ownership._localHost()`).
3. Project Rules self-awareness: startup/wrap kinds, `GET/POST /api/session-rules`, AI-authored → `proposed` until operator approval.
4. Learnings pathway: dated entries in `.tangleclaw/memories/learnings.md` at wrap feed the promote loop.
5. PortHub: port needs go through PortHub, never ad-hoc binds.

Adding a future item = one roster entry. Section is budget-aware (`_yieldable`, with a one-line fallback pointer). Engine-agnostic: plain text + HTTP, no engine-specific filenames.

## Out of scope
An on-demand long-form ecosystem guide doc (primer is small enough to be self-contained); changes to the rules-delivery channel (#595); Master prime.

## Chunks
- [x] 01 — `lib/ecosystem-primer.js` (roster + renderer, JSDoc'd) + wire into `generatePrimePrompt` after the startup-rules block + tests (`test/ecosystem-primer.test.js` roster/render/interpolation; prime-level assertion that the section lands and yields under budget) + FEATURES.md + CHANGELOG `### Added`.

## Status
- Context: built 2026-08-31; branch `feat/1122-ecosystem-primer`. Design note honored (declared roster). Yield priority 0 (compresses best — pointer keeps API origin + numeric id); two prime-budget test fixtures re-tuned to the grown floor with assertions unchanged. Mutation-checked (wire-in removal and interpolation break both red).
