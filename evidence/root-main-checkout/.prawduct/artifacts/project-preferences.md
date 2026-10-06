# Project Preferences — TangleClaw

Status: **inferred, not ratified.** Drafted 2026-09-30 by the Builder2 session from the code,
`CONTRIBUTING.md`, `CLAUDE.md` and CI config on `origin/main`, because the governance hook found
no preferences file. Every line below is a vetoable inference about how the code is already
written; none of it is a new rule. The operator can correct or strike any of it.

## Language & Runtime

- JavaScript (CommonJS, `'use strict'` at the top of each file), run directly by Node.js.
- Node.js 22+ is required (`.node-version` pins 22): the code uses `node:sqlite` and `node:test`.
- Standard-library modules are imported with the `node:` prefix (`require('node:path')`).
- **Zero external dependencies** (ADR 0012). The root has no `package.json`, lockfile or
  `node_modules`, and a change adding one is rejected. `website/` is a separate TypeScript
  project with its own `package.json` and is the only exception.
- `python3` is needed by a few tests only; it is not a runtime dependency.
- No feature may require one AI engine. Paths, config filenames and prompt instructions are
  resolved for the selected engine, never hardcoded to `.claude/`.

## Code Style

- No linter or formatter is configured for the root project: match the surrounding code.
- Every function has a JSDoc comment with `@param` and `@returns` types.
- Comments explain why, not what, and carry the reasoning inline rather than pointing at a
  chunk number that may be renumbered. Issue references (`#1463`) are used.
- Two-space indent, single quotes, semicolons, `const` by default.
- Module-private helpers and state are prefixed with an underscore (`_checkListener`).
- Functions are short and single-purpose.
- Catch specific errors; do not swallow errors silently.
- Front end (`public/`): hide interactive overlays with `visibility`/`pointer-events`, and
  animate only `opacity`/`transform`.

## Testing

- Framework: `node:test` with `node:assert/strict`. No third-party test tooling.
- Tests live flat in `test/` as `<subject>.test.js`; fixtures in `test/fixtures/`.
- Run the suite with `node --test 'test/*.test.js'`.
- Tests are written alongside the implementation, and are contracts: fix the code, never
  weaken a test.
- Tests use temporary directories and in-memory SQLite; no external services.
- UI code is tested by running the real `public/*.js` source against a DOM stub in `node:vm`.
- A test that can only run in a particular environment skips with a printed reason and must
  have an entry in `test/skip-ledger.json`; CI fails on an unlisted skip
  (`scripts/test-skip-audit.js`).
- Never run tests against the live server instance.

## Architecture Patterns

- `server.js` is the entry point; server modules are in `lib/`, the dashboard in `public/`
  (served directly, no build step), CLIs in `bin/`, operational scripts in `scripts/`.
- Persistence goes through `lib/store` (SQLite); logging through `createLogger('<module>')`.
- All port assignments go through PortHub; ports are never hardcoded.
- `public/sw.js` serves most assets cache-first, so a change to a cache-first asset needs a
  `CACHE_NAME` bump (`scripts/cache-bump-guard.js` checks this on pull requests).
- Trace a new option through every step: widget → collector → POST → server.
- `FEATURES.md` and `PROJECT-MAP.md` are the maps of where things live; consult them first.

## Tooling

- CI: `.github/workflows/test.yml` (conflict-marker scan, suite, skip audit, cache-bump guard).
- Releases are cut by `.github/workflows/release.yml`; tags are never made by hand
  (`docs/release-process.md`).
- `CHANGELOG.md` is updated with every change, in Keep a Changelog format. The subsection
  chosen under `[Unreleased]` sets the version bump (`### Internal` is patch-tier).
- Docs are updated in the same commit as the code they describe.
- Branch names: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/` + short name. Commit messages
  explain why.
- Plans live in `.tangleclaw/plans/`; shipped plans move to `.tangleclaw/plans/archive/`.
- Branch work on `public/` or `server.js` happens in a worktree under `.claude/worktrees/`.

## Not set here (operator's call)

`PR merge strategy`, `Commit attribution` and `Delegation` are deliberately left unset, so the
governance defaults apply. Observed fact, for whoever sets it: recent merges on `main` are
squash merges (`… (#2069)`), while the governance default is a merge commit.
