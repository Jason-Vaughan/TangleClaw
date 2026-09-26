---
title: "#1905 The detected MagicDNS name is refused with HOST_NOT_SERVED"
status: COMPLETE. Chunk 1 merged as PR #1919; Chunk 2 on fix/1905-tailnet-cutover, reviewed by cumulative rev-20260926T205207Z-2b1d8491 and verify-resolutions rev-20260926T205721Z-66a3ce57 (0 blocking). The Chunk 2 PR closes #1905.
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-26, message 0f830344 (dispatch to #1905, under R45 and R46). Architect rulings A17–A20, message 2f34bdfe. PM hold, message 3b23132e. Architect approval A21, message 43f5f31e. Chunk 2 dispatch, message d4027d15 (adds the A19 normalization tests).
issues: [1905]
scope: 1905-magicdns-host-inventory
branch: fix/1905-magicdns-host-inventory
partition: serial. Two chunks, one PR each.
critic_mode: cumulative per chunk
---

# #1905 — One normalized host inventory for the tailnet name

Issue: https://github.com/Jason-Vaughan/TangleClaw/issues/1905 (OPEN).
Governing rulings: R45 and R46 on the issue. **A17–A20** from the Architect (Medusa 2f34bdfe),
which this revision answers.
Envelope: plan, fix, local verification, a Critic-reviewed PR and exact-head CI green.
Builder2 does not merge.

## Revision summary (delta against the first plan)

| Ruling | First plan | Revised |
|---|---|---|
| A17 | A detected name is not persisted, and `caddySite: not-configured` is reported | **Unchanged (approved).** |
| A18 | `reconcileTailnet` set the config and minted the cert, and left the Caddyfile "pending" | **Redesigned.** Direct mode: one atomic boundary, documented and tested. Caddy mode: two phases. *Prepare* only mints a transition cert. *Apply* is the cutover transaction, and the config flips only there, with rollback. An ungated install is refused with a named remedy. |
| A19 | An explicit `hosts` list stayed verbatim and reported `covered: false` | **Redesigned.** `hosts` becomes extras. The new `removeHosts` removes carried names. The mandatory canonical hosts are always in the union, and removing one gets a typed 409. |
| A20 | — | This revision. The code that conflicts is listed under "Code already written". |

## A21 — approval and required addenda (Architect, 2026-09-26)

Decisions: (a) the mDNS name is in the mandatory set, because the LAN Caddy site and the
served-host contract depend on it, and `publicDomain` stays separate because its site uses ACME.
(b) The automatic health rollback applies only to `--tailnet-host` cutovers. (c) The serial
two-chunk, two-PR split is approved.

Required addenda:
1. **Strict apply health (Chunk 2).** The `--tailnet-host` apply verifies the local health URL
   **and** the new hostname via 127.0.0.1 with SNI and Host fixed to the candidate. Success means
   the exact healthy response only. The current `pollHealth` semantics, which accept a 503 or a
   degraded 200 body, do not count. When the retries run out, the rollback runs.
2. **Honest rollback result (Chunk 2).** `rolledBack: true` is emitted only when the prior
   Caddyfile, the prior `caddyTailnetHost` and the reload are **all** restored. Any failure in the
   rollback itself is a typed non-success. It reports the residual state and the exact recovery
   command. Injected rollback-failure tests cover it.
3. **Chunk 1 refusal wording.** `409 RECONCILE_NEEDS_CUTOVER` says that caddy-mode prepare is **not
   available in this installed version**. It must not point the operator at a command that has not
   landed.
4. **#1905 stays open through Chunk 2.** Chunk 1's commits and PR use `Refs #1905`, never a closing
   keyword. Otherwise the PM files a follow-up issue and binds it before #1905 closes.

Process: the code stays local until the Critic review passes. Each exact head is returned through
the PM and the Reviewer.

## Root cause (unchanged)

The cert names, the Host allowlist and the Caddy tailnet site read `config.caddyTailnetHost`, which
is null on a default install. Operator links read the `tailscale status` probe. So a link could name a
host that the cert and the allowlist did not carry, and writes to it got `403 HOST_NOT_SERVED`.

## Design

### Inventory (A17, already built and conforming)

`lib/host-inventory.js` provides:
- `normalizeHostName`.
- One overlay-DNS probe behind a provider registry.
- A process-wide observation. A miss is retried after 60 s. A mutation boundary refreshes it.
- `resolveTailnetHost(config, observation)`. It returns `{host, source, configured, observed,
  provider, drift, omission, caddySite}`. The configured name wins. With nothing configured, the
  detected name is used. With neither, the omission is reported and no host is invented.

`certHostUnion`, the served-Host allowlist and the operator-link fallback all read it. A detected
name is never written into `caddyTailnetHost`.

### Mandatory canonical hosts (A19)

`mandatoryCertHosts(config, observation)` in `lib/https-setup.js` returns the names a consumer
depends on the certificate carrying:
- the mkcert defaults (`localhost`, `127.0.0.1`, `::1`), because the direct listener and Caddy's
  local site use them;
- the mDNS name, because it is Caddy's `lanHost` site and the allowlist's LAN name;
- the canonical tailnet host, when there is one.

`publicDomain` is left out, because its site uses ACME, not this certificate.
[ASSUMPTION: this set is what A19 means by "mandatory canonical inventory hosts". Veto if the mDNS
name should be removable.]

### `POST /api/setup/generate-cert` host selection (A19)

- `hosts` means **extras**. They are added to the union, which is the carried SANs, plus the
  mandatory hosts, plus `publicDomain`.
- `removeHosts` means **explicit removals** of carried names.
- A removal that names a mandatory host is refused with
  `409 CANONICAL_HOST_REMOVAL {hosts:[...]}`. The message points to the inventory operation that
  changes it: reconcile for the tailnet name, and machine rename or config for the others.
- The minted list is always a superset of the mandatory hosts. So the old "a replacement list
  quietly drops a canonical name" path cannot happen.
- **Contract change:** `test/api-setup-https.test.js` › "accepts a custom hosts list" pins the old
  verbatim replacement. A19 retires that contract, so the test is rewritten to pin the new one:
  extras are unioned and a removal works. This is a ruled requirement change, not a weakened test.
  The CHANGELOG `### Changed` entry says so.

### Reconcile: direct mode (A18: the narrower atomic boundary)

The ingress mode is `direct` or absent, so there is no live Caddy consumer.
`{"reconcileTailnet": true}` does the following:
1. **Gate check.** `caddyTailnetHost` only feeds a future Caddy site, and the generator throws on an
   ungated one. So if `caddy.tailnetSiteGated(config, gateState)` is false, the request is refused
   with `409 TAILNET_UNGATED` and a named remedy: arm the TangleClaw login, or set a Caddy
   credential. A future cutover can then never fail on it.
2. **Mint** the cert with the union plus the observed name. The old name is kept as a carried SAN.
3. **Save the config last:** `caddyTailnetHost = observed`.
4. **The boundary.** If minting fails, nothing has changed. If the save fails after the mint, the
   cert carries both names and the config still names the old one, so the cert, the allowlist and
   the links still agree on the old canonical host. There is no interval where a canonical host is
   uncovered.
5. **Tests:** parity across the cert union, the allowlist and the operator link, before and after.
   A mint failure leaves the config unchanged. An injected save failure leaves the old canonical
   host consistent across consumers.

### Reconcile: caddy mode (A18: two-phase)

- **Prepare:** `{"reconcileTailnet": "prepare"}` on generate-cert.
  1. Run the gate check. When ungated, refuse with `409 TAILNET_UNGATED`.
  2. Mint a **transition cert** carrying the old and new tailnet names, plus the union.
  3. **The config does not change.** `caddyTailnetHost` and the live Caddyfile still name the old
     host, and so do the allowlist and the links. The transition cert covers both, so nothing that
     currently works stops working.
  4. The response gives the preview: the old host, the new host, and the exact apply command,
     `node scripts/ingress-cutover.js --to caddy --tailnet-host <new>`.
- **`{"reconcileTailnet": true}` in caddy mode** is refused with `409 RECONCILE_NEEDS_CUTOVER`,
  naming prepare and the apply command. No single route call may flip the canonical host there.
- **Apply:** `ingress-cutover.js --to caddy --tailnet-host <name>`. It is the supported cutover
  transaction, extended:
  1. **Validate:** the name normalizes, equals a fresh observation, and is gated. The current cert
     must cover it, otherwise tell the operator to run prepare. Any failure means the ingress is not
     touched.
  2. Build the Caddyfile with `tailnetHost: <name>`. Existing behaviour covers backup, validation
     and the restore of an invalid file.
  3. Put `caddyTailnetHost: <name>` into the same `configPatch`, saved in the cutover's existing
     step 4. **This is the only place the canonical host flips.**
  4. After launchctl, poll health on the local health URL, and on `https://<name>:<port>/api/health`
     through Caddy, resolved to 127.0.0.1 (SNI and Host set to `<name>`), so the new site itself is
     proven.
  5. **Rollback on a failed health check (only for a `--tailnet-host` run):** restore the backed-up
     Caddyfile and the prior `caddyTailnetHost`, then re-run the launchctl reload. The transition
     cert still carries the old name, so the rolled-back site is covered. The result file records
     `rolledBack: true` and the cause.
  - `--dry-run` prints the whole plan, including the config flip and the health targets.

  [DECISION: the rollback-on-health step applies only to `--tailnet-host` runs.] A general
  health-based rollback would change the behaviour of every cutover. That is out of scope and
  would be a separate issue.

### Cross-consumer parity (R46 invariant)

A test proves the host is identical across the cert union, the allowlist, the operator link and
(caddy mode) the Caddy `tailnetHost` option in each of these states:
- detected;
- configured;
- drift before prepare;
- after prepare, where the old host is still canonical everywhere and the cert covers both;
- after apply;
- after a rolled-back apply, where everything is back on the old host.

## Code already written before A21 (historical: local head e2e77407, squashed before Chunk 1 shipped)

This work conforms and stays:
- `lib/host-inventory.js`, including the miss retry.
- `certHostUnion` reading the inventory.
- The allowlist cache key and the trailing-dot strip.
- The operator-link fallback.
- The `session-ownership` seam accessor.
- The generate-cert route's use of `certHostUnion` and its `inventory` response block.
- Its tests.
- The docs for detection.

This work conflicts and will be changed:
- **A18:** the route's `reconcileTailnet: true` flips the config and returns
  `pending: [caddyfile]` in caddy mode. It gets replaced by the design above, including the
  ungated refusal in both modes.
- **A19:** explicit `hosts` is verbatim and returns `covered: false`. The reconcile-with-hosts check
  (it "must include the new name") goes too. Both are replaced by extras, `removeHosts` and the
  mandatory union.
- The tests that pin the rejected behaviour: pending-caddyfile, verbatim-with-`covered: false`, and
  the explicit-hosts reconcile pair.
- The CHANGELOG, `deploy/INGRESS.md` and `configuration-reference.md` text that describes them.

## Chunks

- **Chunk 1 — inventory, host selection and direct-mode reconcile. One PR, which fixes the #1905
  symptom.** It includes:
  - everything in "conforms and stays";
  - A19 in full;
  - direct-mode reconcile with the gate check;
  - caddy mode's `reconcileTailnet: true` refused with `409 RECONCILE_NEEDS_CUTOVER`. The message
    reports the drift and says prepare is not available in this installed version (A21 addendum 3).
  - Commits and PR say `Refs #1905`, never `Fixes` (A21 addendum 4).
  - Tests, docs, and a cumulative Critic review.
- **Chunk 2 — caddy-mode prepare and cutover apply. A second PR.** It includes:
  - `reconcileTailnet: "prepare"`;
  - `ingress-cutover.js --tailnet-host`, with validation, the config flip in the transaction, the
    tailnet-site health check and rollback;
  - `--dry-run` output;
  - the parity test across the prepare, apply and rollback states;
  - strict health (A21 addendum 1) and an honest rollback result with injected rollback-failure
    tests (addendum 2);
  - `Fixes #1905`, or a PM-filed follow-up bound first;
  - docs and a cumulative Critic review.

Builder2 stops and reports to the PM at the end of each chunk.

## Out of scope

- UI changes to the setup wizard.
- Probes for providers other than Tailscale. The registry is the extension point.
- A general health-based rollback for every cutover.
- A route that removes a canonical tailnet name outright. That is `caddyTailnetHost` config plus a
  cutover, as today.

## Status

- [x] Chunk 1: inventory, host selection (A19), direct-mode reconcile (A18), caddy-mode refusal
- [x] Chunk 2: caddy-mode prepare/apply through the cutover, with rollback (A18)
