# Contributing to TangleClaw

Thanks for your interest in contributing to TangleClaw! This document covers how to set up a development environment, run tests, and submit changes.

## Prerequisites

- **macOS** (launchd required for service management)
- **Node.js 22+** (`node:sqlite` and `node:test` are required)
- **ttyd** (`brew install ttyd`)
- **tmux** (`brew install tmux`)
- **python3** (test-only, required) — `test/c1-plugin-migration.test.js` parses Python source with
  `ast` to check TangleClaw's install-reference constant has not drifted from the Prawduct plugin's.
  Ships with macOS; no packages needed. **Its reader tests spawn `python3` unconditionally**,
  against their own fixtures, so a missing interpreter fails them whether or not the plugin is
  installed. Only the drift comparison against the *installed* plugin is conditional, and it skips
  in exactly one case: prawduct **not installed** (no marketplace checkout) — and not even then when
  `TANGLECLAW_REQUIRE_UPSTREAM` is set, which the scheduled `upstream-drift` workflow does (#835).
  Installed-but-relocated, unparseable, or a failing `python3` all **fail** — "I could not read it"
  must never be recorded as "not applicable".

## Getting Started

```bash
git clone https://github.com/Jason-Vaughan/TangleClaw.git
cd TangleClaw
```

TangleClaw has zero npm dependencies — no `npm install` needed. You can run the server directly:

```bash
node server.js
```

Or install as a launchd service:

```bash
./deploy/install.sh
```

## Running Tests

```bash
node --test 'test/*.test.js'
```

The test suite uses `node:test` (built into Node.js 22+). Tests create temporary directories and in-memory SQLite databases — no external services needed.

Some tests can only run where the real thing exists — an installed engine CLI, a non-UTC timezone, a macOS host — and skip elsewhere with a printed reason. CI audits those skips: after the suite, `scripts/test-skip-audit.js` compares every skipped test against `test/skip-ledger.json` and fails on any it does not name, then writes "certified N of M" to the run summary. If you add an environment-gated test, add a ledger entry saying why it cannot run on the runner and where it does run. To see the audit locally:

```bash
node --test --test-reporter=junit --test-reporter-destination=test-results.xml 'test/*.test.js'
node scripts/test-skip-audit.js test-results.xml
```

### The service-worker cache guard

`public/sw.js` serves most `public/*` assets cache-first, so a browser with an active service worker keeps handing out the copy it already has until `CACHE_NAME` changes. Ship a change to one of those files without bumping the generation and it is invisible to operators — who are typically remote, on a phone, with no hard-reload. It has recurred four times (#246, #271, #427, #623), and none of those four files is what the guard watches today — each has since been carved into `NETWORK_FIRST_PATHS`, and not always by its own fix — `ui.js` and `style.css` were carved for #422 some three weeks before #623 was closed by a `CACHE_NAME` bump. It watches whatever is still cache-first, recomputed from `sw.js` on every run, so files added later are covered without anyone maintaining a list.

CI decides this on the pull request, because "did a cache-first asset change" is a question about a diff and no reading of a single tree can answer it. If the check fails, it names the files:

```bash
node scripts/cache-bump-guard.js --base main
```

Two fixes are valid. Bump `CACHE_NAME` in `public/sw.js` — or, if the file should never be served from cache at all, add it to `NETWORK_FIRST_PATHS` instead. Prefer the carve-out for anything whose staleness is itself a bug: a bump tears down and reinstalls the worker in every browser, which behind a basic_auth gate once locked an operator out entirely (#710).

Two limits worth knowing. It reads **committed** history on both sides, so an uncommitted edit is invisible to it — commit, then ask. And it runs on **pull requests only**, because a push has no base to be a diff against; a direct push to `main` is therefore unguarded, which is one more reason the trivial-doc-edit exception for direct commits should stay trivial.

## Project Structure

- `server.js` — HTTP server, API routes, reverse proxy, WebSocket upgrade
- `lib/` — Core modules (store, engines, sessions, wrap pipeline, etc.)
- `public/` — Frontend (HTML, CSS, JS — no build step, no framework)
- `data/engines/` — Bundled engine profiles (JSON)
- `test/` — Test files matching `*.test.js`
- `docs/` — User documentation
- `deploy/` — launchd plists and install script

## Adding a New Engine

1. Create a JSON profile at `data/engines/<id>.json` (see [Engine Guide](docs/engine-guide.md) for the schema)
2. If the engine uses a config file that TangleClaw should generate, add a generator function in `lib/engines.js` and a `case` in `generateConfig()`
3. Run `engines.validateParity()` to verify all engines receive core rules and PortHub references
4. Add tests in `test/engines.test.js`

## Areas Looking for Contributions

These are features we'd love help with. Check the issues tab for related discussions, or open a new issue to propose your approach before starting.

### Authentication

TangleClaw currently has no user authentication — anyone who can reach the server port has full access. Adding an auth layer (session-based, token-based, or OAuth) is the single biggest security improvement the project needs. The `deletePassword` mechanism for destructive operations could serve as a starting point.

### Linux Support

TangleClaw currently requires macOS (launchd for service management). Adding systemd support would open TangleClaw to Linux servers — which is a natural fit for the VPN/SSH remote dev use case.

### Sidecar Controls

The sidecar currently shows read-only process status from [ClawBridge](https://github.com/Jason-Vaughan/ClawBridge). Adding controls — poll/refresh individual processes, show full output, dismiss, terminate — would make it a full process management panel.

### Mobile Terminal Scrollback

The current touch scroll shim for xterm.js works but has edge cases on iOS and Android. Better touch scroll handling or an alternative approach would improve the mobile experience significantly.

## Issues Are Preferred Over Pull Requests

**If you found a problem, please open an issue rather than a fix.** This is the opposite of the usual open-source advice, so here is the reasoning:

- **A fix from an environment we can't reproduce is hard to trust.** TangleClaw drives launchd services, tmux, and real sockets, so much of the suite needs a machine configured the way a real install is. A patch written where the suite can't fully run — a container, a sandboxed agent, a machine mid-install — can't be validated against the contract the tests define, and we'd have to re-derive it anyway.
- **Local fixes make your install diverge from what we ship.** The moment your checkout carries changes, it stops being a clean install, which is exactly what made your report valuable. A modified tree also blocks the in-product self-update, which refuses to run rather than clobber local work — so patching around a bug can strand you on the version that has it.
- **The diagnosis is the scarce part, not the patch.** Once a problem is described precisely, fixing it here is usually quick. Working out *what* is wrong on a machine we've never seen is the expensive step, and only you can do it.

**First-run and install problems are the most valuable reports of all** — we cannot reproduce first-boot state on a machine that is already installed.

Pull requests are still welcome, especially for documentation, typos, and small self-contained changes. Two things to know if you send one:

- **Open an issue first for anything non-trivial**, so we can agree on the approach before you invest the time.
- **Prefer describing a workaround in the issue over documenting it in the repo.** A documented workaround has to be removed again once the underlying bug is fixed, and it can outlive the bug.

## Making Changes

1. Create a branch from `main`
2. Make your changes
3. Run the full test suite: `node --test 'test/*.test.js'`
4. Update `CHANGELOG.md` with a description of your changes — see the subsection convention below
5. Submit a pull request

### CHANGELOG Subsections

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/) with one addition, and the subsection you choose is load-bearing: the release tooling derives the version bump from it.

| Subsection | Use for | Bump |
|---|---|---|
| `### Added` / `### Changed` / `### Removed` / `### Deprecated` | user-visible behavior | minor |
| `### Fixed` / `### Security` | bug and security fixes | patch |
| `### Internal` | refactors, test-only changes, tooling, CI, **documentation** | patch |

Pick by **user-visible impact**, not by how many files changed: a one-line behavior change is `### Changed`, a large refactor nobody notices is `### Internal`. Documentation-only edits go under `### Internal` — still logged for history, but patch-tier so doc churn doesn't inflate the minor version. Any other heading (`### Documentation`, `### Docs`) matches no bump rule and leaves the release tooling unable to derive a level.

### Commit Messages

- First line: concise summary (72 chars max)
- Focus on *why*, not just *what*
- Reference issue numbers where applicable

### Code Style

- Follow the existing code style (no linter configured — match what's there)
- All functions should have JSDoc comments
- Write tests alongside implementation
- Zero external dependencies — use Node.js stdlib only

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- TangleClaw version (`curl localhost:3102/api/version`)
- Node.js version (`node --version`)

### For Install, First-Run, and "It Won't Load" Problems

These are the reports we most want and least able to reproduce, so raw output beats description. Paste whatever of this you can:

```bash
launchctl list | grep tangleclaw          # services: middle column is exit status, '-' PID means not running
cat ~/.tangleclaw/logs/server.err.log     # startup crashes land here
tail -50 ~/.tangleclaw/logs/tangleclaw.log
cat ~/.tangleclaw/config.json             # redact any tokens before pasting
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3102/api/health
pwd                                       # where you cloned — matters on macOS, see below
```

Also worth mentioning:

- **Where the repo is cloned.** On macOS, a clone under `~/Documents` or `~/Desktop` sits behind a privacy boundary the launchd-spawned server may not be able to read, which can make the server fail on startup with nothing obvious on screen.
- **Whether the dashboard shows a banner**, and which one — "newer code on disk" (your checkout moved ahead of the running server) is a different problem from an update-available notification.
- **Which URL you opened**, including `http://` vs `https://`. Port 3102 serves one protocol at a time.
- **A screenshot** of anything visually wrong. It's often faster than describing it.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Security & Contribution Guidelines

TangleClaw launches AI sessions that run with real permissions on real machines, so every incoming
pull request is audited as a potential supply-chain vector. None of this is a judgement about you —
it is the same process for everyone, and it is designed so that a good contribution still gets in.

1. **Scope.** One issue per PR, and nothing outside it. A diff that touches files unrelated to the
   issue is closed regardless of quality: from the outside, scope overrun and probing look identical.

2. **Zero Trust — and you still get the credit.** Maintainers audit pull requests as raw text
   diffs. We do not check out contributor branches or run contributor code on our own machines.
   (CI does run your tests, in an isolated runner with a read-only token and no access to secrets.)
   If your logic is sound, we reconstruct the fix in a clean commit and credit you by name.

3. **Because we reconstruct it, your explanation is worth more than your code.** The most valuable
   pull request describes the bug precisely, says why it happens, and explains the approach. A clear
   description gets reconstructed and shipped. A large, clever, unexplained diff does not, however
   good it is.

4. **Forbidden files.** `data/hooks/`, `hooks/`, `scripts/`, `deploy/` and `.github/workflows/` are
   off-limits unless a maintainer has asked for a change there on a specific issue. These run on
   maintainer machines or in CI *without anyone choosing to run them*, which is what separates them
   from ordinary source. Modifications there are treated as payload and the pull request is closed.

5. **Tests are welcome, and they are executable code.** Please add tests for your change — the suite
   is `node --test 'test/*.test.js'`. They are audited line by line like any other file and
   reconstructed the same way, so keep them small and obvious.

6. **Reviewable text only.** No binary files, and no generated, minified or vendored code: none of
   them can be read as a diff, which is the only review we perform. Source must also contain no
   bidirectional control characters, no zero-width or invisible characters, and no non-ASCII
   homoglyphs standing in for ASCII in identifiers. Those three make a diff *render* differently
   from what it *executes*, which defeats a text audit by construction rather than by degree.
   Ordinary Unicode in prose, comments and string literals is fine — it is the invisible and the
   disguised that are the problem, not the non-English.

7. **No new dependencies.** Adding third-party packages introduces supply-chain risk that this
   project has deliberately designed out. TangleClaw is strictly zero-dependency (ADR 0012): any
   pull request adding a `package.json`, a lockfile, or a `node_modules` reference is rejected
   without further review. Solve it with the Node standard library, or open an issue arguing the
   case before writing code.

Expect a rigorous review and some back-and-forth. That is not hostility — it is the same bar the
maintainers hold themselves to, and a contribution that clears it is genuinely valued.
