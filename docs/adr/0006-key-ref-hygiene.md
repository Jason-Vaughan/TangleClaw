# ADR 0006: Key-Ref Hygiene — Detecting the Master-Key Footgun

**Status:** Accepted (2026-06-29, TB-2 / #189). A launch-time, warn-only guard; no config flag, inert until a hardcoded key literal is present.
**Source issue:** #189 — Replace Aider's LiteLLM master key with a scoped virtual key.
**Builds on:** TB-1 (#357 / ADR-less) which laid the orchestration-profile `keyRef` (`file:`/`env:`) + `resolveKeyRef` resolver. TB-1 deferred "retire the master key" to here. **Closes** the TB key-hygiene concern; TB-3/TB-4 are unrelated seams.

---

## Context

The sanctioned way to give a harness a LiteLLM / OpenAI-compatible secret is an
orchestration-profile **`keyRef`** (TB-1): TC stores only a *reference*, resolves the secret at
launch, and overlays it onto the launch env for **one launch only** — the secret is never written
into an engine config file. The footgun #189 surfaced is the opposite: a LiteLLM key (originally
the unrestricted **master** key) pasted directly into an engine config's static
`launch.env.OPENAI_API_KEY`, where it is inherited by every session that launches that engine and
carries far broader authority than any one engine/project needs.

The one-time *swap* (replace the master key with the scoped key in the operator-owned
`~/.tangleclaw/engines/aider.json`) was already effectively done on the live host (its `launch.env`
is `{}`, and the bundled `direct` profile already references the scoped key). The durable problem
is **recurrence**: nothing structurally stops a future hardcoded key from reappearing in a config.

## Decision

Add a pure detector `detectHardcodedKeys(engineProfile)` in `lib/orchestration.js` and call it at
the session-launch seam (`lib/sessions.js`), scanning the **static, pre-overlay** engine config.
It flags an env entry when either:

- the **value** matches a LiteLLM/OpenAI secret-key shape (`^sk-[A-Za-z0-9_-]{16,}$`), or
- the **name** is `LITELLM_MASTER_KEY` with a non-empty value.

A finding produces a **redacted** (`sk-ab…(redacted, N chars)`), **non-blocking** `log.warn`
naming the engine, env var, and remediation (use a profile keyRef). The launch proceeds.

Three deliberate choices:

1. **Detect literals, not "the master key value."** TC never holds the master key and cannot
   compare against it. It doesn't need to: any `sk-…` literal in a config is wrong because the
   sanctioned delivery path is a keyRef. This makes the invariant enforceable without TC ever
   holding the secret.
2. **Scan pre-overlay.** `applyLaunchOverlay` legitimately injects the resolved scoped key into
   the launch env. Scanning the post-overlay env would flag the sanctioned key. The guard targets
   hardcoded literals in the *source* config, which keyRef resolution never produces.
3. **Warn, not refuse.** The operator owns their engine configs; a hardcoded key may be an
   intentional stopgap, and hard-blocking would brick a launch they configured. Warn-only surfaces
   the footgun every launch without removing operator control. `detectHardcodedKeys` is exported,
   so a future refuse mode or config-validation call site can reuse it without re-wiring.

## Consequences

- "No master key in launch env" shifts from a hand-maintained state to a **structurally surfaced**
  invariant: any reintroduced literal warns, redacted, on the next launch of that engine.
- The guard is **silent on clean configs and on the keyRef/overlay path** — zero noise for the
  sanctioned setup, so it won't train operators to ignore it.
- It does **not** edit operator configs or mint/rotate keys. Replacing a flagged literal, and the
  Monad-side key minting/revocation, remain operator/Monad actions (captured as
  `VRF-tb-2-scoped-key`).
- A scoped key *pasted as a literal* would also be flagged — intentionally: the message is "use a
  keyRef," which is correct even for a scoped key.

## Alternatives considered

- **Hard-refuse on detection.** Rejected as the default: could brick a launch the operator
  deliberately configured; the operator owns these files. Left as an exported-function-enabled
  future opt-in if a real need surfaces.
- **Validate at engine-config load (`validateProfile`).** Returning a hard validation *error* there
  would break loads; a warn path is possible but launch-time is the highest-signal moment (the
  literal is about to be injected) and is a single, non-breaking seam. The exported detector keeps
  the load-time call site cheap to add later.
- **Compare against the actual master key.** Impossible (TC never holds it) and unnecessary given
  the literal-vs-keyRef distinction.
