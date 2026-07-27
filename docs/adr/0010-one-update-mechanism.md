# ADR 0010: One update mechanism — every surface that starts an update calls the applier

**Status:** Accepted (2026-07-27).
**Source issue:** #730 — the update pill injected unguarded git commands that could strand an install off the updater.
**Builds on:** #228/#229 (the self-update action and `lib/update-applier.js`), #711 (the update path's remaining gaps).

---

## Context

TangleClaw shipped two ways to take an update, and only one of them was guarded.

The dashboard pill's **Update & restart** button calls `POST /api/update/apply` →
`lib/update-applier.js`, which fails closed on four conditions before touching anything: not a git
checkout, no newer release, a dirty working tree, and a HEAD that is neither `main` nor a release
tag. It then moves by `git checkout <latest release tag>`.

The session page's update badge did something different. It injected a fixed instruction script into
the live AI session, and that script's third step was `git pull origin main`. No guards, a different
ref, a different mechanism — reaching the same repository.

The guards are not decoration, and the divergence was not cosmetic:

- **It moved working branches.** `git pull origin main` merges into whatever is checked out. Observed
  live on 2026-07-27 against this repository's own session, which was mid-merge on a feature branch.
  The applier refuses this case explicitly, with the comment "so an update can never silently move a
  dev's working branch."
- **It shipped unreleased code.** `main` is not a release ref. An operator who clicked a control
  labelled with a version number received whatever had landed on `main` since.
- **It disabled the updater it belonged to.** A successful apply leaves the checkout *detached at the
  release tag* — the intended post-update state. Pulling a branch from there fast-forwards HEAD to a
  non-tag commit, so `git describe --exact-match --tags HEAD` fails, `_headState()` returns
  `updatable: false`, and every later **Update & restart** refuses with `wrong-ref`. One
  prompt-driven update permanently stranded the install off the in-product path — the failure #711
  exists to prevent, produced by the feature meant to avoid it.

The prior design note (`.prawduct/artifacts/ub-self-update-action.md`) recorded leaving the prompt
"intact as the no-mechanism manual fallback (out of scope to change)." That was the wrong call, and
it was invisible: the artifact lives under `.prawduct/`, which is gitignored, so the reasoning never
reached a fresh clone or a reviewer. This ADR is tracked for that reason.

## Decision

**An update has exactly one implementation. Any surface that starts one calls it, rather than
restating it.**

Concretely:

1. `lib/update-applier.js` is the only thing that mutates the checkout for an update. Its guards and
   its choice of ref are the definition of "taking an update," not one option among several.
2. Surfaces reach it through a caller, never by reproducing its steps:
   - the dashboard button → `POST /api/update/apply`;
   - the injected agent prompt and the documented manual path → `scripts/apply-update.js`, a CLI over
     the same module.
3. **No surface hands a user or an agent raw git for this purpose.** Documentation included — the
   README's manual path previously read `git pull --ff-only`, which fails outright on the
   tag-detached checkout a successful update produces.
4. A refused guard is a **stop, not an obstacle.** Instructions that drive an update must say so
   outright. An agent told merely to "report the error" will often try to *satisfy* the guard by
   stashing or switching branches, destroying exactly what the guard was protecting.
5. Where a surface reports refusal codes, it enumerates all of them (`dirty-tree`, `wrong-ref`,
   `no-update`, `no-tag`, `no-git`, `git-error`). A partial list is worse than none: it tells a
   caller that an unlisted code cannot happen.

## Consequences

- Adding an update surface is cheap and safe — it is a call, not a reimplementation.
- The applier's result object is now a **two-consumer contract** (the HTTP route and the CLI). A new
  refusal code is a contract change that must reach both, plus the prompt text and the docs that
  enumerate codes. `test/update-prompt-guards.test.js` reads the code list out of the applier's
  source rather than restating it, so the omission fails a test instead of shipping.
- The CLI pins console output to stderr (`logger.setConsoleStream`) so stdout stays a parseable
  payload. This is a general hazard, not a local quirk: the logger routes everything below ERROR to
  stdout, which is correct for a server and wrong for any CLI whose stdout is data.
- Restarting stays a separate, explicit act in every path. The applier stages code; it never restarts.
  A restart drops the dashboard and API for everyone connected, so it remains the caller's decision.

## Alternatives considered

- **Make the prompt state-aware** — have `/api/update-status` carry an applicability verdict and let
  the prompt report what blocks the update. Genuinely useful, and #711 wants that verdict anyway for
  the modal that currently refuses *after* the confirm. Rejected as the primary fix because it makes
  the prompt a better *predictor* of the guards while leaving it a second implementation of the
  update — the actual defect.
- **Keep raw git, but change the ref** to `git checkout <latest release tag>`. Fixes the stranding
  and nothing else: still unguarded against a dirty tree, still no server-side trail, and still two
  things to keep in step.
- **Delete the injected-prompt path** and leave only the button. Rejected — the agent adds real value
  around the update (reads the release notes, runs the suite, reports honestly), and the operator
  uses it deliberately. The mechanism was the problem, not the surface.
