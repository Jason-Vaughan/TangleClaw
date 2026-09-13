# Hotfix — Caddy sites without a password refuse other machines

**Advisory:** GHSA-fhgg-4h57-q2f9 (private until the patch release publishes it).
**Ruled by the operator 2026-09-13, in the Builder pane:** patch release on `main` now; the matching
change folds into #1420 (`train-9/cutover`) separately.
**Type:** security bugfix, medium. **Branch:** `fix/caddy-site-peer-guard` off `origin/main`.
**Requirements Confidence:** High. The behaviour and the mitigation are verified on Caddy v2.11.4.

## Problem

A Caddy site is chosen by the request's Host (and SNI), not by the peer, and Caddy listens on every
interface. A generated site without `basic_auth` is therefore not "localhost-only": any machine that
can reach Caddy's port and names that host is served. TangleClaw's served-Host check accepts the name.

## Done when

1. `lib/caddy.js#buildCaddyfileContent` emits, in every site block that proxies without `basic_auth`,
   `@offbox not remote_ip 127.0.0.1/8 ::1` and `abort @offbox` before `reverse_proxy`. Gated sites and
   the redirect block are unchanged.
2. The drift check gains a property: every site that proxies with no gate refuses non-loopback peers
   (read from `caddy adapt` JSON, like the others). Its finding names the fix command.
3. `scripts/guard-ungated-sites.js [--dry-run]` adds the guard to an already-deployed Caddyfile in
   place. It writes only when `caddy adapt` reads the result as the original plus the guard routes; it
   backs up, `caddy validate`s (restores on failure) and restarts Caddy; exit 2 when the file is written
   but Caddy did not restart. A TangleClaw-generated file keeps a valid integrity stamp.
4. Tests: generator (ungated sites guarded, gated sites not, fail-closed guards unchanged), the drift
   property against committed adapt fixtures, the script's `run()` with injected collaborators, and a
   mutation check on each new guard.
5. Docs: `deploy/INGRESS.md` manual steps, `docs/caddy-drift-check.md`, `.prawduct/artifacts/security-model.md`,
   CHANGELOG `### Security`. The generator's "stay localhost-only" comment is corrected.
6. Critic review; PR into `main`; patch release through `docs/release-process.md`; publish the advisory
   with `patched_versions`.

## Out of scope

- Applying the guard automatically at boot (a rewrite + Caddy restart the operator did not ask for).
- The #1420 side: `describeIngressDoor` counts an unguarded site as remote when accounts exist (ruled),
  and the `fallback` door check. Both land on `train-9/cutover`.

## Status
- [ ] Hotfix — generator guard, drift property, in-place script, docs, review
