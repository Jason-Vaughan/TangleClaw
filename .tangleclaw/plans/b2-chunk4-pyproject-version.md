---
title: "Train B.2 Chunk 4: the wrap's version bump reads and writes pyproject.toml"
status: BUILDING — Architect ruled A1–A6 2026-09-22 (message 93e48010)
authorized_by: TangleClaw-ProjectManager via Medusa, 2026-09-22 (message 72726091)
issues: [1444]
governed_by:
  - docs/adr/0002 step-kind contract (version-bump is optional and never blocks)
  - project rule: ENGINE-AGNOSTIC BY CONSTRUCTION (engaged only as "version math is identical across engines"; this is server-side file handling, no engine surface)
scope: train-b2-chunk4
branch: fix/1444-pyproject-version
partition: serial. One step, one shared reader module, their tests
critic_mode: chunk
---

# Train B.2 Chunk 4: the wrap's version bump reads and writes pyproject.toml

Train B.2's last remaining issue (PM dispatch 2026-09-22). One issue, one chunk.

## Confidence check

1. **Problem.** A Python project keeps its version in `pyproject.toml` and has a Keep a Changelog
   `CHANGELOG.md`. `version-bump` probes only `version.json` and `package.json`, logs
   `not version-tracked` and skips on every wrap. Meanwhile `project-version.txt` is written from
   `CHANGELOG.md`, so the project shows a plausible version and nobody can tell the bump never ran.
2. **Success.** On such a project (TangleBrain's shape), a wrap with `[Unreleased]` entries promotes
   the changelog and rewrites only the `version = "…"` value in `[project]`, leaving every other
   byte of `pyproject.toml` alone. A `pyproject.toml` the step cannot edit safely is a skip whose
   reason says why. The dashboard's version reader agrees with the writer on which file holds the
   version.
3. **Out of scope.** Poetry's `[tool.poetry] version`, `__version__` strings in package source,
   a general TOML parser or dependency, and issue item 3 (see A6).

**Requirements confidence: High.** The issue names the project, the log line and the file shape, and
TangleBrain's real `pyproject.toml` is on this machine to check against. The one open question
(auto-probe vs opt-in) is A1, ruled below.

## What the investigation found (read at `2cc530263`)

- **The issue's "versionFilePath would overwrite pyproject.toml with JSON" is false today.** The
  configured branch of `_resolveVersionSource` runs `JSON.parse` on the file before it stages
  anything, so a TOML file skips with `pyproject.toml unreadable: Unexpected token '['…`. Probed
  directly against `_resolveVersionSource` with a real `pyproject.toml`. That has been true since
  #635 (the fail-closed rework), which predates the 5.23.0 install the issue was filed on. What is
  left is a misleading skip reason, not a destructive write.
- The issue's guard (refuse any `versionFilePath` not ending `.json`) would break a working case:
  a JSON file with another name (`VERSION`, `VERSION.txt`) resolves and bumps correctly today
  (probed).
- **`releaseMode` defaults to `auto`** (`lib/project-config.js:resolveReleaseMode`). So a new probe
  source is not opt-in: every Python project with this shape starts cutting releases on its next
  wrap, subject to the #1492 readiness gate and every fail-closed guard. That is why A1 is an
  Architect decision.
- The commit step flushes staged entries by shape (`{primingPath, newContent, changed}`) and
  recognises a release by `{oldVersion, newVersion, bumpLevel}` (`commit.js:_isReleaseEntry`), so a
  new staged key needs no change there.
- Version *detection* has two ladders that must name the same file: `lib/project-version.js:detectVersion`
  (writes the cache) and `lib/project-version-files.js:detectLiveVersion` (self-heal). Both are
  CHANGELOG → configured `versionFilePath` → `version.json` → `package.json` (→ git tag, writer only).
- The repo has no `package.json` and no dependencies, so a TOML library is not an option.

## Architectural decisions (sent to the Architect at plan-written)

- **A1 — pyproject.toml joins the automatic probe, after `package.json`.** Recommended: yes, same as
  `package.json` joined it in #298. The readiness gate and fail-closed guards still apply, and
  `releaseMode: off` is the opt-out. *Rejected:* only when `versionFilePath` names it (opt-in). Safer,
  but it leaves the silent skip the issue is about in place for everyone who never finds the setting.
- **A2 — Only PEP 621 `[project] version` is read.** A `version` listed in `[project] dynamic`, or no
  static `version`, skips with a reason that names it. *Rejected:* also reading `[tool.poetry]`.
  That is a second table with its own rules, and it can be added later without changing this one.
- **A3 — Leave `versionFilePath` open to any file, and route `pyproject.toml` to the TOML reader.**
  When the configured file's basename is `pyproject.toml` it gets the TOML reader, the same way a
  configured `package.json` gets its surgical reader. Other configured files keep the JSON reader,
  and a non-JSON one skips with a reason saying `versionFilePath` supports JSON files, `package.json`
  and `pyproject.toml`. *Rejected:* the issue's `.json`-extension guard (it breaks working JSON files
  under other names, and the destructive path it guards does not exist).
- **A4 — The write is one surgical line swap, or a skip. There is no fallback rewrite.** The step
  replaces only the quoted value on the `version = "…"` line inside `[project]`. If that line cannot
  be found exactly (for example an inline `project = {…}` table, a multi-line string, or two
  `[project]` headers), it skips at resolve time, before any CHANGELOG gate. *Rejected:* the
  normalizing fallback `package.json` has, because there is no safe TOML serializer here.
- **A5 — The version reader learns the same file.** A `pyproject.toml` rung goes into both detection
  ladders after `package.json`, and `readConfiguredVersion` uses the TOML reader when the configured
  file is `pyproject.toml`. One parser lives in `lib/project-version-files.js` (pure `fs`), and the
  wrap step uses it. *Rejected:* writer-only. The ladders exist so the reader and the writer name
  the same file.
- **A6 — Issue item 3 ("make the skip visible in the wrap output") is out of scope.** Items 1 and 2
  remove the case the issue hit. A skip already renders in the live wrap drawer; making skips
  outlive the drawer is a wider change to every step's reporting. *Rejected:* doing it here.
  (Ruled MODIFY: no follow-up filed. See the rulings below.)

### Architect rulings (2026-09-22, message 93e48010)

- **A1 APPROVE.** pyproject.toml joins the automatic probe after package.json. It stays governed by
  the operator-driven wrap, `releaseMode`, readiness and the Cut/Hold contract, and grants no tag or
  publication authority.
- **A2 APPROVE.** Only the PEP 621 static `[project].version`. Dynamic, absent and ambiguous forms fail
  closed with a specific skip reason.
- **A3 APPROVE.** Arbitrarily named JSON `versionFilePath` files keep working; basename
  `pyproject.toml` dispatches to the TOML reader; unsupported configured content is reported honestly.
- **A4 APPROVE.** A value-only replacement or a skip, with every other byte and line ending preserved.
  No normalizing fallback.
- **A5 APPROVE.** Reader and writer share one parser and the same configured/probe precedence, so the
  displayed and bumped versions cannot diverge.
- **A6 MODIFY.** Durable skip reporting stays out of this chunk, and **no follow-up is filed
  automatically**: item 3 was an alternative in case Python support did not land, and the live drawer
  already reports skips. File one only if a separate, reproduced post-drawer visibility requirement
  remains, and then notify the PM.

## Design

`lib/project-version-files.js` gains `parsePyprojectVersion(text)`, which returns
`{ok:true, version, start, end}` (offsets into the text exactly as given, BOM and CRLF included) or
`{ok:false, reason}`, plus the detection reader `readPyprojectVersion(projectPath)`. It is a line
scanner, not a TOML parser. Lines inside a `"""`/`'''` multi-line string are ignored:

- It finds the `[project]` header (allowing whitespace and a trailing comment), and the section ends
  at the next `[` header.
- Inside the section, the first line matching `version = "X"` or `version = 'X'` (optionally
  followed by a comment) is the version. A second match skips as ambiguous.
- `[project]` missing, `project = {` inline, `"version"` listed in `dynamic`, a `version` key whose
  value isn't a single-line quoted string, or two `[project]` headers all return `{ok:false}` with
  the reason.

`version-bump.js` gains `_resolvePyproject(path)`, beside `_resolvePackageJson`. It applies the same
semver pre-check (`_nonSemverSkip`), and `makeContent` swaps only the value on that one line. The
staged key is `version-bump:pyproject-toml`. `_resolveVersionSource` probes it after
`package.json`, and the configured branch short-circuits to it on basename `pyproject.toml`. The
final skip reason names all three files.

Detection: `readPyprojectVersion` is added as a rung after `package.json` in both ladders, with
`source: 'pyproject.toml'`.

## Critic round 1 (chunk review of `c86f875f`): 0 blocking, 3 warnings, 2 notes, all fixed

- **Only a version-less `package.json` is passed over; the reader and writer now share one probe.** A
  Python repo's tooling-only `package.json` (no `version`) stopped the writer short of
  `pyproject.toml` while the dashboard read past it. Per the Architect's A5 refinement (below), the
  writer passes over a valid `package.json` with no `version` field and nothing else. Both detection
  ladders now go through one function (`readProbedVersion`) that stops where the writer stops, so a
  `version.json` with no usable version, or a malformed `package.json`, no longer lets the dashboard
  show a lower file's version. A real-filesystem test runs the writer and both ladders on each shape.

### Architect ruling on the A5 refinement (2026-09-22, message 9577484c)

- **MODIFY.** Pass over a valid probed `package.json` with no version field, so tooling-only Node
  metadata does not mask `pyproject.toml`. Do not generalize it to `version.json`: its basename is an
  affirmative version-source signal, so a missing version field is ambiguous and stops fail-closed.
  A configured `versionFilePath` stays sole-source with no fallback. Detection and writer source
  selection stay aligned, so the dashboard cannot claim `pyproject.toml` while the bump refuses on
  `version.json`.
- **Multi-line string tracking is TOML-aware.** Delimiters inside single-line strings and comments
  no longer count, so a stray `'''` in a comment cannot hide a table header (a test proves the old
  counter took `[tool.x]`'s version).
- **Checked on real files**: the parser on four real `pyproject.toml` files on this machine (one line
  changes each), a scratch copy of TangleBrain's `pyproject.toml` + `CHANGELOG.md` through `run()`
  (0.25.0 → 0.25.1, only line 43 changes, same byte count), and a real-filesystem test in the suite.
- Requirements-confidence line added. #1444 confirmed OPEN before the PR.

## Tests (written with the code)

New `test/version-bump-pyproject.test.js`:
- Probe: pyproject only, plus a CHANGELOG with `[Unreleased]` entries → staged content differs from
  the input only on the version line (byte comparison of all other lines). Quote style, trailing
  comments, CRLF line endings and a `version` key in another table (`[tool.x] version = …`) are
  preserved or ignored.
- Precedence: `version.json` and `package.json` still win over `pyproject.toml`.
- Skips, each with its reason: no `[project]`; dynamic version; inline `project = {}`; multi-line
  value; duplicate version keys; non-semver; `[project]` with no version.
- Configured `versionFilePath: pyproject.toml` → the TOML reader; configured non-JSON other file →
  the new reason; configured JSON `VERSION.txt` still bumps (a regression lock on A3).
- End-to-end through `run()` with the release gate in `auto` → staged entry and changelog promotion.

`test/project-version-files.test.js` / `test/project-version.test.js`: the pyproject rung in both
ladders, in the same position, and the configured-file case.

## Docs

- `docs/configuration-reference.md` `versionFilePath` row: the probe order and the pyproject case.
- `version-bump.js` header comment (what the step reads), `CHANGELOG.md` under `### Fixed`,
  `FEATURES.md` if it lists the version sources.

## Done when

- The tests above pass, and the full suite is green.
- `/prawduct:critic` shows no unresolved blocking findings.
- The Architect has ruled on A1–A6 before the PR opens.
- The PR closes #1444 and merges. The live checkout is pulled and restarted, and `startupSha` matches.

## Status

- [ ] Chunk 4 (#1444): pyproject.toml as a version source
