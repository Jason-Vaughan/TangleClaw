'use strict';

/**
 * `version-bump` wrap step (open-queue #3, replaces #139 Chunk-3 no-op
 * stub) — reads the project's `CHANGELOG.md` `[Unreleased]` section
 * and its version file (`version.json`, `package.json` or `pyproject.toml`,
 * or the one `versionFilePath` names), promotes `[Unreleased]` to a dated
 * release, and bumps the semver in that file.
 *
 * **Contract (per ADR 0002 step-kind table):**
 * "If CHANGELOG has [Unreleased] entries and project has version.json,
 * bump and update CHANGELOG. Optional, never blocks."
 *
 * The "never blocks" half is load-bearing: every degraded condition
 * (missing files, malformed `version.json`, empty `[Unreleased]`,
 * unparseable semver) returns `{ok:true, status:'skipped'}` with a
 * `reason` / `detail` in `output` for the wrap drawer to render
 * inline. The single exception is a release decision that is the
 * operator's and hasn't been made (see `releaseMode` below). Proceeding
 * would take that decision for them, so the step halts with
 * `needs-operator` instead.
 *
 * **Fail-closed, not fail-open.** Three conditions stop the step rather than
 * letting it do something other than what was asked (a class of silent
 * wrong-answer bugs, GH #540):
 *
 *  - An `options.bumpLevel` outside the allowed set skips instead of falling
 *    through to the heuristic (`pathc` must not silently become `minor`).
 *  - A configured `versionFilePath` that doesn't resolve skips instead of
 *    falling back to another version file.
 *  - A CHANGELOG whose newest release heading this step can't safely extend —
 *    a foreign scheme (`## [2.85.0.41]`, a calendar version), or semver
 *    carrying a prerelease/build suffix whose ordering is ambiguous. A
 *    changelog with no release heading yet is the unrelated first-release case
 *    and still bumps; a plain 3-octet heading is comparable regardless of
 *    whether it carries a date. All four cases come from one classifier so
 *    they can't disagree — see {@link _classifyTopRelease}.
 *
 * **Whether to cut at all: `releaseMode` (#1492).** Resolved by
 * `lib/project-config.js:resolveReleaseMode`, which also migrates the legacy
 * `versionBumpEnabled: false` to `off` on read.
 *
 *  - `off` skips before anything else is read, including `options.bumpLevel`.
 *  - `auto` and `ask` run every guard below, then meet the readiness gate
 *    (`lib/release-readiness.js`) just before staging. `auto` cuts on a
 *    `ready` verdict. `ask` never cuts by itself. In both, the operator's
 *    decision wins whatever the verdict: `options.release` `cut` (or a picked
 *    `options.bumpLevel`) cuts, and `hold` doesn't.
 *  - In `auto`, the AI's recommendation (the `release-recommendation` step,
 *    `lib/wrap-steps/_release-recommendation.js`) is compared with the verdict.
 *    A `ready` verdict the AI recommends holding, or a `not-ready` one it
 *    recommends cutting, is the operator's call, not the gate's. An `unsure`
 *    or missing recommendation leaves the verdict to decide alone.
 *  - A hold carries `held:true`, `releaseMode`, `readiness` (`verdict`,
 *    `reason`, `signals`), `recommendation`, `needsOperator` and `wouldBump`
 *    (`from`, `to`, `bumpLevel`), plus `decidedBy:'operator'` for a Hold and
 *    `disagreement:true` when the verdict and the recommendation disagree. A
 *    plain hold is a skip. A hold that needs the operator (`ask`; `auto` on an
 *    `unknown` verdict or a disagreement) with no decision made is the one case
 *    this step stops the wrap:
 *    `{ok:false, status:'needs-operator'}`, so the pipeline halts before
 *    `commit` and the drawer asks Cut or Hold. A cut carries `releaseMode`,
 *    `readiness`, `recommendation` and `decidedBy` (`readiness` or `operator`).
 *
 * **Bump-level precedence:**
 *  1. `options.bumpLevel` override (`'patch'` | `'minor'` | `'major'`;
 *     any other value skips the step)
 *  2. `BREAKING` marker anywhere in `[Unreleased]` body → `'major'`
 *  3. Entry-type vote: `### Added` / `### Changed` / `### Removed`
 *     / `### Deprecated` present → `'minor'`; otherwise (only
 *     `### Fixed` / `### Security` / `### Internal`) → `'patch'`.
 *  4. Default fallback: `'patch'`.
 *
 * **`### Internal` subsection** (issue #231). A non-Keep-a-Changelog
 * subsection reserved for refactors, test-only changes, dev tooling,
 * CI tweaks, and doc-only edits that don't change user-facing
 * behavior. Parses like the other subsections (so `_parseUnreleased`
 * surfaces it in `subsections[]`), but is intentionally excluded from
 * `MINOR_TRIGGER_SUBSECTIONS` — entries logged here do not bump
 * minor. Lets a release made up entirely of internal churn stay at a
 * patch bump instead of inflating the minor counter. Mixed with
 * `### Added` or `### Changed`, the user-visible subsection still
 * wins and minor fires (Internal does not "veto" a real feature).
 *
 * **Single-transaction discipline (matches Chunks 5–9).** Handler
 * never writes the filesystem; it stages entries under composite
 * keys so the Chunk-9 `commit` step's `_flushStagedWrites` (duck-typed
 * on `{primingPath, newContent, changed}`) flushes them:
 *
 *   - `staged['version-bump:version-json'] = {primingPath, newContent, changed:true, oldVersion, newVersion, bumpLevel}`
 *   - `staged['version-bump:changelog']    = {primingPath, newContent, changed:true, oldVersion, newVersion, bumpLevel}`
 * The extra `oldVersion` / `newVersion` / `bumpLevel` fields on each
 * staged entry let `lib/wrap-steps/commit.js:_buildBodyLines` emit a
 * `- Bumped <old> → <new> (<level>)` line for the wrap commit body
 * (deduped — emitted once per pipeline run even though two staged
 * entries carry the info).
 *
 * **Banner emoji NOT auto-injected.** Per the project's CHANGELOG
 * convention (`> 🛟` for bug-fix releases, `> 🚀` for feature
 * releases) the banner is a curated decision the operator makes
 * post-bump. The handler promotes `[Unreleased]` content byte-for-byte
 * under the new dated heading; banner insertion is out of scope and
 * tracked separately.
 *
 * **Idempotent on re-wrap.** After a successful bump the `[Unreleased]`
 * body is empty (just the heading + blank line). On the next wrap the
 * handler returns `{ok:true, status:'skipped', output:{reason:'no
 * entries'}}` — no double-bump.
 *
 * **`version.json` write normalization.** The staged content is always
 * `JSON.stringify(obj, null, 2) + '\n'` — 2-space indent + trailing
 * newline. Projects using a different style (4-space, tabs, no
 * trailing newline) will have the bump silently re-normalize.
 * Acceptable for this project (already 2-space) — open follow-up if
 * a project adopts a different style and complains.
 *
 * **This step runs no child process, and that is why it is absent from the
 * killed-vs-failed sweep (#897).** It reads and writes files and parses text;
 * its only requires are `fs`, `path`, `./_date`, `./_config-root`, `../logger`,
 * `../store`, `../project-config`, `../release-readiness` and `../project-paths`,
 * none of which reaches `child_process`. With nothing to
 * kill, there is no timeout that could be mistaken for a failure. Recorded here
 * because #897 listed this file among the offenders on the strength of its
 * eleven `.exec(` matches — every one of them `RegExp.prototype.exec`. Anyone
 * sweeping this family again should check the requires, not the symbol.
 *
 * @module lib/wrap-steps/version-bump
 */

const fs = require('node:fs');
const path = require('node:path');
const { todayIsoLocal } = require('./_date');
const { createLogger } = require('../logger');
const store = require('../store');
const projectConfigModule = require('../project-config');
const releaseReadiness = require('../release-readiness');
const releaseRecommendation = require('./_release-recommendation');
const { configRootOf } = require('./_config-root');
const projectPaths = require('../project-paths');
const projectVersionFiles = require('../project-version-files');

const log = createLogger('wrap-step-version-bump');

const UNRELEASED_LINE_RE = /^## \[Unreleased\]\s*$/;
// Any level-2 heading ends the `[Unreleased]` block. Deliberately NOT `/^## \[/`:
// Keep a Changelog's link-reference style brackets the version, but the plain
// style (`## 1.4.2 - 2026-05-01`) does not, and keying on the bracket meant an
// unbracketed changelog had no section terminator at all — `_parseUnreleased`
// ran `endIdx` to EOF and swept the project's entire release history into the
// body it was about to promote under one new heading.
const NEXT_HEADING_RE = /^## /;
// Version token from a level-2 heading, in either changelog style: the full
// bracket contents (`## [1.4.2] - date` → `1.4.2`), else the first whitespace-
// delimited word (`## 1.4.2 - date` → `1.4.2`). Extracting the WHOLE token and
// classifying it afterwards is deliberate — matching a version pattern directly
// against the line lets `## [2.85.0.41]` satisfy a `\d+\.\d+\.\d+` prefix and
// read as `2.85.0`, which is the original #540 bug wearing a new regex.
const BRACKETED_HEADING_RE = /^## \[([^\]]*)\]/;
const BARE_HEADING_RE = /^## (\S+)/;
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SUFFIXED_SEMVER_RE = /^\d+\.\d+\.\d+[-+]/;
// `Internal` is intentionally listed (#231) so `_parseUnreleased` surfaces
// it in `subsections[]`, but it is NOT in `MINOR_TRIGGER_SUBSECTIONS` below
// — entries under `### Internal` keep the bump at patch (refactors, test-
// only changes, dev tooling, doc-only edits, etc.).
const SUBSECTION_RE = /^### (Added|Changed|Removed|Deprecated|Fixed|Security|Internal)\s*$/i;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
// Tightened from `/\bBREAKING\b/` (PR #202 Critic n1) so casual prose
// like `## NOT BREAKING — just renamed` doesn't falsely force a major
// bump. The marker must look intentional: `BREAKING:` or `BREAKING(`
// (the second form covers `BREAKING(api)` style scoping notes).
const BREAKING_RE = /\bBREAKING(?::|\s*\()/;
const ENTRY_LINE_RE = /^\s*[\-*]\s+\S/;

const BUMP_LEVELS = ['patch', 'minor', 'major'];
// `options.release`: the operator's Cut or Hold. Auto is the absence of both.
const RELEASE_DECISIONS = ['cut', 'hold'];
// **Asymmetry is intentional (#231):** `SUBSECTION_RE` above lists 7
// subsections including `Internal`; this set lists only 4. A future
// maintainer pattern-matching "regex lists 7, set lists 4 — must be a
// bug" should NOT add `Internal` here — doing so silently breaks #231
// (refactor-only releases would re-inflate to minor). The patch
// fallthrough in `_decideBumpLevel` is the correct landing site for
// `Internal`. Per `feedback_symmetric_capability_gates`, this comment
// pins the deliberate asymmetry on the half most likely to be "fixed".
const MINOR_TRIGGER_SUBSECTIONS = new Set(['Added', 'Changed', 'Removed', 'Deprecated']);

/**
 * Parse a semver string. Returns `null` for any non-canonical form
 * (no `v` prefix, no pre-release / build metadata — this is a
 * wrap-bump tool, not a general-purpose semver parser).
 *
 * @param {string} versionString
 * @returns {{major:number, minor:number, patch:number}|null}
 */
function _parseSemver(versionString) {
  const m = SEMVER_RE.exec(String(versionString || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Bump a semver by the named level. Returns `null` for invalid input.
 *
 * @param {string} versionString - e.g. "3.16.2"
 * @param {'patch'|'minor'|'major'} level
 * @returns {string|null}
 */
function _bumpSemver(versionString, level) {
  const sv = _parseSemver(versionString);
  if (!sv) return null;
  if (level === 'major') return `${sv.major + 1}.0.0`;
  if (level === 'minor') return `${sv.major}.${sv.minor + 1}.0`;
  if (level === 'patch') return `${sv.major}.${sv.minor}.${sv.patch + 1}`;
  return null;
}

/**
 * Compare two parsed semvers (`{major,minor,patch}`).
 *
 * @param {{major:number,minor:number,patch:number}} a
 * @param {{major:number,minor:number,patch:number}} b
 * @returns {-1|0|1} negative if a<b, 0 if equal, positive if a>b
 */
function _compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Classify the newest release heading in CHANGELOG text — the first `## [...]`
 * line that isn't `[Unreleased]`.
 *
 * **One function, because two predicates kept disagreeing.** The drift guard
 * (#203) needs to answer two questions about the same heading — "can I compare
 * against it?" and "is this a scheme I recognize?" — and every version of this
 * code that answered them with two independent regexes drifted apart, each time
 * in the same shape and each time caught only in review:
 *
 *  - Keyed solely on a parser requiring `## [X.Y.Z] - YYYY-MM-DD`, the guard
 *    self-skipped on any other format — the original fail-open (#540) that let a
 *    4-octet project bump an unrelated `package.json`.
 *  - Given a separate looser "is it foreign?" check, headings that were valid
 *    semver but undated (`## [1.4.2]`, or an en-dash separator) read as a
 *    foreign scheme and hard-skipped projects whose versioning was fine.
 *  - Widening that check to accept `## [2.0.0-beta.1]` then made the two
 *    disagree the other way: not-foreign, yet still unparseable, so the wrap
 *    fell through the "first release" branch and skipped the guard entirely —
 *    reopening the fail-open one door down.
 *
 * A single classification can't disagree with itself, so the kinds are
 * exhaustive and the caller branches on all of them.
 *
 * @param {string} changelogText
 * @returns {{kind:'none'}
 *   |{kind:'released', version:{major:number,minor:number,patch:number}, raw:string}
 *   |{kind:'unbumpable', raw:string}
 *   |{kind:'foreign', raw:string}}
 *   `none` — no release heading yet (a first release; nothing to compare).
 *   `released` — plain 3-octet semver, comparable. The date is NOT required:
 *   it's a formatting choice, and demanding it is what mis-blamed undated
 *   changelogs on their "versioning scheme".
 *   `unbumpable` — recognized semver carrying a prerelease/build suffix
 *   (`2.0.0-beta.1`, `1.0.0-rc.1+build.5`). Ordering against a plain version is
 *   ambiguous, so this is a stop, not a comparison.
 *   `foreign` — some other scheme entirely (`2.85.0.41`, a calendar version).
 */
function _classifyTopRelease(changelogText) {
  const lines = String(changelogText || '').split('\n');
  for (const line of lines) {
    if (!NEXT_HEADING_RE.test(line)) continue;

    const bracketed = BRACKETED_HEADING_RE.exec(line);
    const bare = bracketed ? null : BARE_HEADING_RE.exec(line);
    const token = bracketed ? bracketed[1].trim() : (bare ? bare[1].trim() : '');
    const raw = line.trim();

    // `## [Unreleased] - TBD` and `## Unreleased` are both still the unreleased
    // heading, not a release.
    if (/^Unreleased$/i.test(token)) continue;

    if (EXACT_SEMVER_RE.test(token)) {
      const parts = token.split('.');
      return {
        kind: 'released',
        version: { major: Number(parts[0]), minor: Number(parts[1]), patch: Number(parts[2]) },
        raw
      };
    }
    if (SUFFIXED_SEMVER_RE.test(token)) {
      return { kind: 'unbumpable', raw };
    }

    // A heading announcing a version in some other scheme. The presence of a
    // DIGIT decides, identically for bracketed and bare forms: `## [2.85.0.41]`,
    // `## [v1.2.3]`, and `## 2026.07-build9` are all version-ish and stop the
    // bump; `## [Yanked]` and `## Migration guide` are prose and keep scanning.
    //
    // Keying on the bracket instead made the two forms asymmetric — a bracketed
    // prose heading like `## [Yanked]` sitting above the real releases would
    // permanently disable the bump, while the identical bare heading was
    // skipped. Digits fail closed on anything that might be a version, which is
    // the half that matters.
    if (/\d/.test(token)) {
      return { kind: 'foreign', raw };
    }

    // Prose section (`## Notes`, `## Migration guide`). Not a release heading,
    // so it neither classifies nor disqualifies — keep scanning. Treating it as
    // foreign would hard-skip changelogs that merely carry commentary.
  }
  return { kind: 'none' };
}

/**
 * Parse the `[Unreleased]` block from CHANGELOG text. Returns the
 * line range, body lines, categorized subsections present, and a
 * `hasEntries` flag.
 *
 * @param {string} changelogText
 * @returns {{ok:boolean, startIdx:number, endIdx:number, bodyLines:string[], subsections:string[], hasEntries:boolean}}
 */
function _parseUnreleased(changelogText) {
  const empty = { ok: false, startIdx: -1, endIdx: -1, bodyLines: [], subsections: [], hasEntries: false };
  if (typeof changelogText !== 'string' || changelogText.length === 0) return empty;
  const lines = changelogText.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (UNRELEASED_LINE_RE.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) return empty;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (NEXT_HEADING_RE.test(lines[i])) { endIdx = i; break; }
  }
  const bodyLines = lines.slice(startIdx + 1, endIdx);
  const subsections = [];
  let hasEntries = false;
  for (const line of bodyLines) {
    const m = SUBSECTION_RE.exec(line);
    if (m) {
      const norm = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
      if (!subsections.includes(norm)) subsections.push(norm);
      continue;
    }
    if (ENTRY_LINE_RE.test(line)) hasEntries = true;
  }
  return { ok: true, startIdx, endIdx, bodyLines, subsections, hasEntries };
}

/**
 * Apply the bump-level precedence rule. `options.bumpLevel` override
 * wins outright (if in the allowed set). `BREAKING` marker anywhere
 * in the [Unreleased] body forces `major`. Otherwise the subsection
 * vote: any `Added` / `Changed` / `Removed` / `Deprecated` → `minor`;
 * else (only `Fixed` / `Security` / `Internal`) → `patch`. The
 * `Internal` bucket (#231) is parsed but intentionally excluded from
 * the minor-trigger set so refactor-only releases stay at patch.
 *
 * @param {{subsections:string[], bodyLines:string[]}} parsed
 * @param {{bumpLevel?:string}} [options]
 * @returns {'patch'|'minor'|'major'}
 */
function _decideBumpLevel(parsed, options) {
  const override = options && options.bumpLevel;
  if (typeof override === 'string' && BUMP_LEVELS.includes(override)) return override;
  const body = (parsed.bodyLines || []).join('\n');
  if (BREAKING_RE.test(body)) return 'major';
  for (const sub of (parsed.subsections || [])) {
    if (MINOR_TRIGGER_SUBSECTIONS.has(sub)) return 'minor';
  }
  return 'patch';
}

/**
 * Promote the `[Unreleased]` section in CHANGELOG text to a dated
 * release. The `[Unreleased]` heading itself stays at the top with an
 * empty body so future sessions have somewhere to accumulate entries;
 * the prior body is duplicated under a new `## [version] - date`
 * heading directly below.
 *
 * Whitespace contract:
 *   - Strip leading/trailing blank lines from the promoted body so
 *     the new dated section is tight ("## [3.17.0] - 2026-05-22\n\n###
 *     Added\n- ...").
 *   - One blank line between `[Unreleased]` and the new dated heading
 *     (matches the rest of the file's heading separators).
 *   - Preserves everything from the next existing release heading
 *     onward byte-for-byte.
 *
 * Returns the original text unchanged if there's no `[Unreleased]`
 * section to promote (caller is expected to skip in that case;
 * defensive no-op here).
 *
 * @param {string} changelogText
 * @param {string} newVersion - Bumped semver
 * @param {string} isoDate - YYYY-MM-DD
 * @returns {string}
 */
function _promoteUnreleased(changelogText, newVersion, isoDate) {
  const parsed = _parseUnreleased(changelogText);
  if (!parsed.ok) return changelogText;
  const lines = changelogText.split('\n');
  // Strip leading/trailing blank lines from the body for the new dated section
  let bs = 0;
  while (bs < parsed.bodyLines.length && parsed.bodyLines[bs].trim() === '') bs++;
  let be = parsed.bodyLines.length;
  while (be > bs && parsed.bodyLines[be - 1].trim() === '') be--;
  const datedBody = parsed.bodyLines.slice(bs, be);
  const before = lines.slice(0, parsed.startIdx + 1);
  const after = lines.slice(parsed.endIdx);
  // Match the changelog's own heading style rather than imposing the bracketed
  // one. A project writing `## 1.4.2 - date` would otherwise get a bracketed
  // heading inserted above its bare ones, quietly mixing two conventions in a
  // file the operator hand-maintains — the same class as reformatting a
  // package.json as a side effect of bumping it.
  const top = _classifyTopRelease(changelogText);
  const bracketed = top.kind === 'none' || /^## \[/.test(top.raw || '');
  const heading = bracketed
    ? `## [${newVersion}] - ${isoDate}`
    : `## ${newVersion} - ${isoDate}`;
  const newSection = [
    heading,
    '',
    ...datedBody,
    ''
  ];
  return [
    ...before,
    '',
    ...newSection,
    ...after
  ].join('\n');
}

/**
 * Step handler. See module docstring for full contract.
 *
 * @param {object} context - Pipeline runner context
 * @param {object} context.project - Project record (`{name, path}`)
 * @param {object} context.step - Step spec from `wrap_pipeline.steps[]`
 * @param {object} context.staged - Single-transaction scratch space
 * @param {object} [context.options] - Runner options (may include `bumpLevel`)
 * @returns {Promise<{ok:boolean, status:string, output:object, blockers:string[]}>}
 */
async function run(context) {
  const { project, staged, options } = context;
  if (!project || !project.path) {
    return _skipped('no project path');
  }
  // Every skip below carries the project, so a refusal is attributable in a log
  // file every project shares.
  const skip = (reason) => _skipped(reason, project.name);

  // The project config decides the release mode and the version file.
  let projConfig = null;
  try {
    projConfig = store.projectConfig.load(configRootOf(project));
  } catch (err) { // prawduct:allow prawduct/broad-except -- config read is advisory; the step must still run for a project with no readable config, but the failure is now reported rather than swallowed
    // Logged, not silent: this read now decides `versionFilePath`, so a
    // malformed `.tangleclaw/project.json` silently drops the configured path
    // and hands control back to the lowercase probe — reintroducing exactly the
    // wrong-file bump this step refuses to make. An operator seeing the probe
    // used when they configured a path needs this line to explain why.
    log.warn('project config unreadable — falling back to the built-in version-file probe', {
      project: project.name,
      error: err.message
    });
    projConfig = null;
  }
  // #1492: `releaseMode` decides whether this wrap may cut at all. `off` stops
  // here, before the bump level is read. `auto` and `ask` carry on through
  // every fail-closed guard below and meet the readiness gate just before
  // anything is staged.
  const releaseMode = projectConfigModule.resolveReleaseMode(projConfig);
  if (releaseMode.warning) {
    log.warn('releaseMode unrecognized', { project: project.name, warning: releaseMode.warning });
  }
  if (releaseMode.mode === 'off') {
    return skip('version-bump disabled for this project: releaseMode is off (manages its own versioning)');
  }

  // #1738 — a release is something the project's methodology authorizes. When
  // the session's engine cannot run that methodology, the wrap holds the cut
  // entirely: no version.json and no CHANGELOG promotion. `[Unreleased]`
  // carries to the next wrap whose engine can run it. Held rather than
  // bumped-but-unmerged, because a bump rides any later manual merge into a
  // tagged release that never had its gates run.
  const methodology = context.methodology || null;
  if (methodology && methodology.disposition === 'capability-unavailable') {
    log.info('release held — methodology unavailable on this engine', { project: project.name, engineId: methodology.engineId });
    return {
      ok: true,
      status: 'capability-unavailable',
      output: {
        engineId: methodology.engineId,
        capability: methodology.capability,
        reason: `release held: ${methodology.reason}. [Unreleased] stays as it is for a wrap on an engine that can run the methodology.`
      },
      blockers: []
    };
  }

  // An out-of-set override used to fall silently through to the heuristic, so
  // an operator who asked for `patch` and typed `pathc` got a minor bump and no
  // signal. Validated before any file is read: a request we can't honor stops
  // the step rather than quietly becoming a different request.
  const requestedLevel = (options || {}).bumpLevel;
  if (requestedLevel !== undefined && requestedLevel !== null
      && !BUMP_LEVELS.includes(requestedLevel)) {
    return skip(`invalid bumpLevel override ${JSON.stringify(requestedLevel)} — expected one of ${BUMP_LEVELS.join(', ')}`);
  }
  // The operator's release decision from the wrap modal or the drawer. Same
  // fail-closed rule as the level: a value we can't read stops the step, and so
  // does a Hold that also names a level to cut at, rather than guessing which
  // half was meant.
  const requestedRelease = (options || {}).release;
  if (requestedRelease !== undefined && requestedRelease !== null
      && !RELEASE_DECISIONS.includes(requestedRelease)) {
    return skip(`invalid release decision ${JSON.stringify(requestedRelease)} — expected one of ${RELEASE_DECISIONS.join(', ')}`);
  }
  if (requestedRelease === 'hold' && requestedLevel !== undefined && requestedLevel !== null) {
    return skip(`contradictory release decision: hold with bumpLevel ${JSON.stringify(requestedLevel)} — send one or the other`);
  }

  const versionPath = path.join(project.path, 'version.json');
  const pkgPath = path.join(project.path, 'package.json');
  const changelogPath = path.join(project.path, 'CHANGELOG.md');

  // A project whose version file isn't lowercase `version.json` (or lives off
  // the project root) names it explicitly; that path then wins outright.
  //
  // The commit step flushes whatever this resolves to, so a value escaping the
  // project root would make a settings field an arbitrary-file write. The API
  // validator applies the same predicate, but this is the actual write site and
  // a hand-edited `.tangleclaw/project.json` never passes through the validator.
  const configured = projectPaths.resolveConfiguredFile(project.path, projConfig, 'versionFilePath');
  if (configured.configured && !configured.ok) {
    return skip(`versionFilePath ${JSON.stringify(configured.raw)} ${configured.reason} — refusing to read or write it`);
  }
  const configuredPath = configured.configured ? configured.path : null;

  // #298: resolve which file holds the version — prefer `version.json`, fall
  // back to `package.json` (Node projects). Everything below is identical
  // regardless; only which file is read + written differs.
  const source = _resolveVersionSource(versionPath, pkgPath, configuredPath);
  if (source.skip) {
    return skip(source.skip);
  }
  const currentVersion = source.currentVersion;

  if (!_internal.existsSync(changelogPath)) {
    return skip('CHANGELOG.md not found');
  }
  let changelogText;
  try {
    changelogText = _internal.readFileSync(changelogPath, 'utf8');
  } catch (err) {
    return skip(`CHANGELOG.md unreadable: ${err.message}`);
  }

  const parsed = _parseUnreleased(changelogText);
  if (!parsed.ok) {
    return skip('[Unreleased] section not found in CHANGELOG.md');
  }
  if (!parsed.hasEntries) {
    return skip('[Unreleased] has no entries to promote (already released or empty)');
  }

  const bumpLevel = _decideBumpLevel(parsed, options || {});
  const newVersion = _bumpSemver(currentVersion, bumpLevel);
  if (!newVersion) {
    // Reached whenever the current version isn't 3-octet semver — a 4-octet
    // counter, a calendar version, a date stamp. The bare "could not bump X"
    // this used to emit named the value but not the problem or the remedy, so
    // an operator reading the drawer couldn't tell a misconfiguration from a
    // project TC simply isn't going to version for them.
    return skip(`refusing to bump: ${JSON.stringify(currentVersion)} in ${source.kind} isn't MAJOR.MINOR.PATCH semver, so this step can't derive the next version. Set releaseMode to off if this project manages its own versioning.`);
  }

  // Drift guard (#203): refuse to bump when the computed version isn't
  // strictly greater than what the CHANGELOG already publishes at top.
  // version.json trailing the changelog (botched manual edit, out-of-order
  // merge, force-push that rolled back version.json but not CHANGELOG) would
  // otherwise produce a smaller-than-top heading that `_promoteUnreleased`
  // inserts directly under [Unreleased] — violating the descending-order
  // invariant `test/changelog-structure.test.js` only catches post-commit.
  // Skip (never block — ADR 0002 step-kind contract); the reason carries the
  // diagnostic so the operator reconciles before re-wrapping.
  // Branch on every kind the classifier can return. Exhaustiveness is the
  // point: the earlier two-predicate version had a combination that matched no
  // branch (recognized-but-unparseable) and fell through to the bump, skipping
  // this guard entirely — the same fail-open, one door down.
  const topRelease = _classifyTopRelease(changelogText);

  if (topRelease.kind === 'foreign') {
    return skip(`refusing to bump: CHANGELOG.md's newest release heading (${topRelease.raw}) isn't MAJOR.MINOR.PATCH, so this project's versioning scheme isn't one this step can extend safely. Set releaseMode to off to silence this, or reconcile the changelog format.`);
  }

  if (topRelease.kind === 'unbumpable') {
    return skip(`refusing to bump: CHANGELOG.md's newest release heading (${topRelease.raw}) carries a prerelease or build suffix, so whether ${newVersion} supersedes it is ambiguous. Promote or reconcile that release manually before re-wrapping.`);
  }

  if (topRelease.kind === 'released') {
    if (_compareSemver(_parseSemver(newVersion), topRelease.version) <= 0) {
      const v = topRelease.version;
      const tr = `${v.major}.${v.minor}.${v.patch}`;
      return skip(`refusing to bump: newVersion (${newVersion}) is not strictly greater than CHANGELOG top released (${tr}). ${source.kind} may have drifted; reconcile manually before re-wrapping.`);
    }
  } else if (topRelease.kind !== 'none') {
    // Unreachable today — every kind above is handled. It exists because the
    // bug fixed twice in this file was always "a case nobody branched on fell
    // through to the bump": relying on a trailing comment to assert
    // exhaustiveness is what let that happen. A new kind must stop here rather
    // than inherit the first-release path by default.
    return skip(`refusing to bump: unrecognized CHANGELOG release-heading classification "${topRelease.kind}" — this is a bug in version-bump; not bumping rather than guessing.`);
  }
  // kind === 'none' — a first release, nothing to compare against. Proceed.

  // #1492 readiness gate. It sits after every guard above on purpose: a
  // project that can never be bumped (a foreign scheme, drift) must hear that,
  // not a hold that hides it until the day the plan is finished.
  const readiness = releaseReadiness.evaluateReleaseReadiness(
    releaseReadiness.gatherReleaseSignals(project.path, {
      changelog: { found: true, sectionFound: parsed.ok, hasEntries: parsed.hasEntries },
      configRoot: configRootOf(project)
    })
  );
  const recommendation = releaseRecommendation.recommendationFrom(context.previousResults);
  const gate = _releaseGate(releaseMode.mode, readiness, { level: requestedLevel, release: requestedRelease }, recommendation);
  const releaseRecord = {
    releaseMode: releaseMode.mode,
    readiness: { verdict: readiness.verdict, reason: readiness.reason, signals: readiness.signals },
    recommendation
  };
  if (releaseMode.warning) releaseRecord.releaseModeWarning = releaseMode.warning;
  if (!gate.cut) {
    const held = {
      ...releaseRecord,
      held: true,
      needsOperator: gate.needsOperator,
      wouldBump: { from: currentVersion, to: newVersion, bumpLevel }
    };
    if (gate.decidedBy) held.decidedBy = gate.decidedBy;
    if (gate.disagreement) held.disagreement = true;
    if (gate.needsOperator) return _needsOperator(gate.reason, project.name, held);
    return _skipped(gate.reason, project.name, held);
  }

  const today = _internal.todayIso();
  const newChangelogText = _promoteUnreleased(changelogText, newVersion, today);

  staged[source.stagedKey] = {
    primingPath: source.path,
    newContent: source.makeContent(newVersion),
    changed: true,
    oldVersion: currentVersion,
    newVersion,
    bumpLevel
  };
  staged['version-bump:changelog'] = {
    primingPath: changelogPath,
    newContent: newChangelogText,
    changed: true,
    oldVersion: currentVersion,
    newVersion,
    bumpLevel
  };

  log.info('version bumped', {
    project: project.name,
    oldVersion: currentVersion,
    newVersion,
    bumpLevel,
    subsections: parsed.subsections
  });

  const output = {
    from: currentVersion,
    to: newVersion,
    bumpLevel,
    versionFile: source.kind,
    subsections: parsed.subsections,
    detail: `${currentVersion} → ${newVersion} (${bumpLevel}, ${source.kind})`,
    ...releaseRecord,
    decidedBy: gate.decidedBy
  };
  if (gate.decidedBy === 'operator' && readiness.verdict !== 'ready') {
    // A Cut with no level used the CHANGELOG heuristic, so it isn't the
    // operator's level to name.
    const decided = requestedLevel ? `the operator's ${bumpLevel} pick` : 'the operator\'s decision';
    output.detail += `; cut on ${decided} (readiness: ${readiness.verdict})`;
  }

  return {
    ok: true,
    status: 'done',
    output,
    blockers: []
  };
}

/**
 * Decide whether this wrap cuts, given the release mode, the readiness verdict,
 * whatever the operator decided in the wrap modal or the drawer, and the AI's
 * recommendation.
 *
 * The operator's decision wins in `auto` and `ask` whatever the verdict: Hold
 * never cuts, and Cut or a picked level always does. The UI sends neither for
 * its Auto choice, so their absence is never read as a decision. `off` never
 * reaches here.
 *
 * In `auto` the recommendation can only stop a cut or a hold, never make one:
 * when it disagrees with the verdict, the decision goes to the operator. The
 * verdict reads files and can't see what the operator said this session; the
 * recommendation can, but it is a model's reading. Neither is trusted to
 * overrule the other. In `ask` every decision is the operator's already, and the
 * recommendation is named in the reason as a hint.
 *
 * `needsOperator` on a hold means the question is the operator's and nobody has
 * answered it, which the step turns into a halt.
 *
 * @param {'auto'|'ask'} mode
 * @param {{verdict:string, reason:string}} readiness
 * @param {{level?:string|null, release?:string|null}} decision - `options.bumpLevel` and
 *   `options.release`, already validated and known not to contradict each other
 * @param {{state:'given', value:string, operatorIntent:string, reason:string}|{state:'absent', reason:string}} [recommendation]
 * @returns {{cut:true, decidedBy:'operator'|'readiness'}|{cut:false, needsOperator:boolean, reason:string, decidedBy?:'operator', disagreement?:true}}
 */
function _releaseGate(mode, readiness, decision, recommendation) {
  const { level, release } = decision || {};
  const advice = recommendation && recommendation.state === 'given' ? recommendation.value : null;
  const checks = `readiness: ${readiness.verdict} — ${readiness.reason}`;
  const verdictIs = `readiness is ${readiness.verdict} — ${readiness.reason}`;
  if (release === 'hold') {
    return {
      cut: false,
      needsOperator: false,
      decidedBy: 'operator',
      reason: `release held on the operator's decision (${checks})`
    };
  }
  if (release === 'cut' || (level !== undefined && level !== null)) {
    return { cut: true, decidedBy: 'operator' };
  }
  if (mode === 'ask') {
    return {
      cut: false,
      needsOperator: true,
      reason: `release decision needed: releaseMode is ask, so this wrap cuts only when you choose Cut (${checks}${_adviceClause(recommendation)})`
    };
  }
  if (readiness.verdict === 'ready') {
    if (advice === 'hold') {
      return {
        cut: false,
        needsOperator: true,
        disagreement: true,
        reason: `release decision needed: the release checks say ready, but the AI recommends holding${_adviceBasis(recommendation)}`
      };
    }
    return { cut: true, decidedBy: 'readiness' };
  }
  if (readiness.verdict === 'not-ready') {
    if (advice === 'cut') {
      return {
        cut: false,
        needsOperator: true,
        disagreement: true,
        reason: `release decision needed: the release checks say not-ready (${readiness.reason}), but the AI recommends cutting${_adviceBasis(recommendation)}`
      };
    }
    return {
      cut: false,
      needsOperator: false,
      reason: `release held: ${verdictIs}. Choose Release: Cut in the wrap modal to cut anyway.`
    };
  }
  // An `unknown` verdict is a signal that couldn't be read, which is the
  // operator's call rather than a plain hold.
  return {
    cut: false,
    needsOperator: true,
    reason: `release decision needed: ${verdictIs}${_adviceClause(recommendation)}`
  };
}

/**
 * What the AI's recommendation rested on, for a disagreement reason: the
 * operator's quoted words when it found any, then its own reason.
 *
 * @param {{operatorIntent:string, reason:string}} recommendation - A given recommendation
 * @returns {string} Leading `: `, or empty when there is nothing to add
 */
function _adviceBasis(recommendation) {
  const parts = [];
  if (recommendation.operatorIntent && recommendation.operatorIntent !== 'none stated') {
    parts.push(`you said ${recommendation.operatorIntent}`);
  }
  if (recommendation.reason) parts.push(recommendation.reason);
  return parts.length > 0 ? `: ${parts.join('; ')}` : '';
}

/**
 * The recommendation as a trailing hint on a reason that doesn't turn on it.
 *
 * @param {object} [recommendation]
 * @returns {string} Leading `; `, or empty when there is no recommendation
 */
function _adviceClause(recommendation) {
  if (!recommendation || recommendation.state !== 'given') return '';
  return `; the AI recommends ${recommendation.value}${_adviceBasis(recommendation)}`;
}

/**
 * Build the step's halt for a release decision that belongs to the operator, and
 * log it.
 *
 * The one case this step stops the wrap (ADR 0002, 2026-09-14 amendment). It is
 * `ok:false` so the runner halts before `commit`, which it does only because the
 * pipeline declares this step `blocker: true`. Nothing is staged, so a Retry
 * re-derives everything and carries the operator's answer as `options.release`.
 *
 * @param {string} reason - Operator-facing explanation, rendered on the row
 * @param {string} projectName - Owning project, for log attribution
 * @param {object} held - The hold record: mode, readiness, wouldBump, needsOperator
 * @returns {{ok:false, status:'needs-operator', output:object, blockers:string[]}}
 */
function _needsOperator(reason, projectName, held) {
  log.info('version bump needs the operator', { project: projectName, reason });
  return {
    ok: false,
    status: 'needs-operator',
    output: {
      ...held,
      reason,
      detail: reason,
      remediation: 'Choose Cut or Hold below, then Retry.'
    },
    blockers: [reason]
  };
}

/**
 * Build the step's canonical skip result, and log the refusal.
 *
 * @param {string} reason - Operator-facing explanation; becomes both
 *   `output.reason` and `output.detail`, which the wrap drawer renders inline.
 * @param {string} [projectName] - Owning project, for log attribution. Omitted
 *   only by the guard that fires when there is no usable project record.
 * @param {object} [extra] - Further output fields (a release hold carries the
 *   mode, the readiness verdict and what would have been cut). They can't
 *   overwrite `reason` or `detail`.
 * @returns {{ok:true, status:'skipped', output:{reason:string, detail:string}, blockers:[]}}
 */
function _skipped(reason, projectName, extra) {
  // Every refusal is logged, not just the success (`version bumped`). Without
  // this a skip is visible only in the live drawer: once it closes, a wrap that
  // deliberately refused to bump and a wrap where the step never ran look
  // identical in the log — which is the question #540 was filed to answer.
  // The project is carried here rather than relied on from the runner: the
  // runner logs `{project, stepId}` only at warn/error (`wrap-pipeline.js`),
  // so on the ordinary path this line would be unattributable in a log file
  // every project shares.
  log.info('version bump skipped', projectName ? { project: projectName, reason } : { reason });
  // Canonical skip signal is `status: 'skipped'` (#204) — the drawer keys off
  // it, so `output.skipped` is no longer set (it was the only handler that did,
  // leaving the drawer's per-kind `output.skipped` branches dead for the rest).
  return {
    ok: true,
    status: 'skipped',
    output: { ...(extra || {}), reason, detail: reason },
    blockers: []
  };
}

/**
 * Skip reason for a version value this step can't bump. Shared by all three
 * resolution branches so the same condition reads the same way and names the
 * same remedy wherever it is hit — the branches had drifted into three
 * different messages for one situation.
 *
 * Neutral, not alarming (#318): a non-MAJOR.MINOR.PATCH value usually means the
 * project runs its own versioning scheme, not that anything is broken.
 *
 * @param {string} label - The file the value came from
 * @param {*} value - The offending version value
 * @returns {{skip:string}}
 */
function _nonSemverSkip(label, value) {
  return { skip: `${label} version ${JSON.stringify(value)} isn't MAJOR.MINOR.PATCH semver, so this step can't derive the next version — expected when a project manages its own versioning. Set releaseMode to off to silence this.` };
}

/**
 * Resolve `package.json` as the version source. Extracted so the configured-path
 * branch can reuse it verbatim: pointing `versionFilePath` at the project's own
 * package.json is allowed, and it must get this byte-preserving surgical swap
 * rather than the normalizing rewrite the other branches use — reformatting a
 * hand-maintained package.json as a side effect of a version bump would be its
 * own silent wrong-answer.
 *
 * @param {string} pkgPath - <project>/package.json
 * @returns {{skip:string}|{kind:string, path:string, currentVersion:string, stagedKey:string, makeContent:(nv:string)=>string}}
 */
function _resolvePackageJson(pkgPath) {
  if (!_internal.existsSync(pkgPath)) {
    return { skip: 'package.json not found' };
  }
  let raw;
  let json;
  try {
    raw = _internal.readFileSync(pkgPath, 'utf8');
    json = projectVersionFiles.parsePackageJsonText(raw);
  } catch (err) {
    return { skip: `package.json unreadable: ${err.message}` };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { skip: 'package.json is not an object' };
  }
  // The same test the version reader uses, so the two skip the same files.
  if (projectVersionFiles.isVersionlessPackageJson(json)) {
    return { skip: 'package.json has no "version" field — nothing to bump', noVersion: true };
  }
  const cv = json.version;
  if (!_parseSemver(cv)) {
    return _nonSemverSkip('package.json', cv);
  }
  return {
    kind: 'package.json',
    path: pkgPath,
    currentVersion: cv,
    stagedKey: 'version-bump:package-json',
    // Surgical swap of ONLY the top-level "version" value — preserves the
    // file's formatting, key order, and remaining bytes. `"version":` is a
    // top-level-only key in package.json (dependencies key on package name),
    // so the match anchored on the current value is the package version.
    // Defensive fallback to a normalized rewrite if the regex doesn't match.
    makeContent: (nv) => {
      const escaped = String(cv).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('("version"\\s*:\\s*")' + escaped + '(")');
      const out = raw.replace(re, `$1${nv}$2`);
      return out === raw ? JSON.stringify({ ...json, version: nv }, null, 2) + '\n' : out;
    }
  };
}

/**
 * Resolve `pyproject.toml` as the version source (#1444): the static PEP 621
 * `[project] version`. Used by the probe and by a configured `versionFilePath`
 * that names a pyproject.toml.
 *
 * The write swaps only the version value on its own line and leaves every other
 * byte as it was. Unlike `package.json` there is no normalizing fallback,
 * because nothing here can serialize TOML. So any shape the scanner cannot edit
 * safely (dynamic version, inline table, a multi-line value) skips here, before
 * the CHANGELOG gates, and the reason names the shape.
 *
 * @param {string} pyPath - Absolute path to the pyproject.toml
 * @returns {{skip:string}|{kind:string, path:string, currentVersion:string, stagedKey:string, makeContent:(nv:string)=>string}}
 */
function _resolvePyproject(pyPath) {
  const label = path.basename(pyPath);
  if (!_internal.existsSync(pyPath)) {
    return { skip: `${label} not found` };
  }
  let raw;
  try {
    raw = _internal.readFileSync(pyPath, 'utf8');
  } catch (err) {
    return { skip: `${label} unreadable: ${err.message}` };
  }
  const parsed = projectVersionFiles.parsePyprojectVersion(raw);
  if (!parsed.ok) {
    return parsed.noVersion
      ? { skip: `${label} ${parsed.reason}`, noVersion: true }
      : { skip: `${label} ${parsed.reason}` };
  }
  if (!_parseSemver(parsed.version)) {
    return _nonSemverSkip(label, parsed.version);
  }
  return {
    kind: label,
    path: pyPath,
    currentVersion: parsed.version,
    stagedKey: 'version-bump:pyproject-toml',
    makeContent: (nv) => raw.slice(0, parsed.start) + nv + raw.slice(parsed.end)
  };
}

/**
 * Resolve the project's `version.json`, which must exist.
 *
 * @param {string} versionPath - <project>/version.json
 * @returns {{skip:string, noVersion?:true}|{kind:string, path:string, currentVersion:string, stagedKey:string, makeContent:(nv:string)=>string}}
 */
function _resolveVersionJson(versionPath) {
  let json;
  try {
    json = JSON.parse(_internal.readFileSync(versionPath, 'utf8'));
  } catch (err) {
    return { skip: `version.json unreadable: ${err.message}` };
  }
  if (!json || typeof json !== 'object') {
    return { skip: 'version.json is not an object' };
  }
  if (json.version === undefined || json.version === null || json.version === '') {
    return { skip: 'version.json has no "version" field — nothing to bump' };
  }
  if (!_parseSemver(json.version)) {
    return _nonSemverSkip('version.json', json.version);
  }
  return {
    kind: 'version.json',
    path: versionPath,
    currentVersion: json.version,
    stagedKey: 'version-bump:version-json',
    makeContent: (nv) => JSON.stringify({ ...json, version: nv }, null, 2) + '\n'
  };
}

/**
 * Resolve which file holds the project version (#298): prefer `version.json`,
 * then `package.json` (Node projects), then `pyproject.toml` (Python projects,
 * #1444). Returns `{skip:<reason>}` when none is usable, else `{kind, path, currentVersion, stagedKey, makeContent}`.
 * `version.json` and a configured path are rewritten normalized (2-space indent,
 * trailing newline); `package.json`'s write is surgical — only the top-level
 * `"version"` value is swapped, byte-preserving the rest of the hand-maintained
 * file.
 *
 * When `configuredPath` is given (project config `versionFilePath`), it is the
 * ONLY candidate: it resolves that file or skips. There is deliberately no
 * fallback, because falling through is how a project whose file is
 * `VERSION.json` ended up bumping an unrelated `package.json` on a
 * case-sensitive filesystem — the lowercase `version.json` probe missed, control
 * fell through, and a bogus release heading landed above the real one. A stated
 * intent that can't be honored is a reason to stop, not to guess.
 *
 * @param {string} versionPath - <project>/version.json
 * @param {string} pkgPath - <project>/package.json
 * @param {string} [configuredPath] - Absolute path from `versionFilePath`
 * @returns {{skip:string}|{kind:string, path:string, currentVersion:string, stagedKey:string, makeContent:(nv:string)=>string}}
 */
function _resolveVersionSource(versionPath, pkgPath, configuredPath) {
  if (configuredPath) {
    const label = path.basename(configuredPath);
    // Pointing `versionFilePath` at the project's own package.json is allowed —
    // the validator and the settings field both accept it — so it must get the
    // byte-preserving surgical swap that file needs, not the normalizing
    // rewrite below. Reformatting someone's package.json as a side effect of a
    // version bump would be its own silent wrong-answer.
    // Existence is checked BEFORE the package.json short-circuit so a missing
    // file still names the configuration as the cause. Ordering it after let a
    // configured-but-absent package.json report a bare "package.json not
    // found", which reads like the probe ran and found nothing rather than like
    // a setting pointing at a file that isn't there.
    if (!_internal.existsSync(configuredPath)) {
      return { skip: `configured versionFilePath ${JSON.stringify(configuredPath)} not found — refusing to fall back to another version file` };
    }
    if (path.resolve(configuredPath) === path.resolve(pkgPath)) {
      return _resolvePackageJson(pkgPath);
    }
    // A configured pyproject.toml gets the TOML line swap; JSON.parse would only
    // refuse it with a syntax error that names neither the file type nor the fix.
    if (label.toLowerCase() === projectVersionFiles.PYPROJECT_FILENAME) {
      return _resolvePyproject(configuredPath);
    }
    let text;
    try {
      text = _internal.readFileSync(configuredPath, 'utf8');
    } catch (err) {
      return { skip: `${label} unreadable: ${err.message}` };
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      return { skip: `${label} unreadable as JSON (${err.message}) — versionFilePath supports a JSON file, package.json or pyproject.toml` };
    }
    if (!json || typeof json !== 'object') {
      return { skip: `${label} is not an object` };
    }
    if (json.version === undefined || json.version === null || json.version === '') {
      return { skip: `${label} has no "version" field — nothing to bump` };
    }
    // Same pre-check the other two branches make, for the same reason: without
    // it a non-semver value survives resolution and fails later in `run()`,
    // AFTER the CHANGELOG gates — so a project with a calendar version and no
    // CHANGELOG.md was told "CHANGELOG.md not found" instead of the real cause.
    if (!_parseSemver(json.version)) {
      return _nonSemverSkip(label, json.version);
    }
    return {
      kind: label,
      path: configuredPath,
      currentVersion: json.version,
      stagedKey: 'version-bump:version-json',
      makeContent: (nv) => JSON.stringify({ ...json, version: nv }, null, 2) + '\n'
    };
  }

  // The built-in probe, in the order and with the stops the version reader
  // uses (`lib/project-version-files.js:readProbedVersion`). Only a package.json
  // that is valid JSON with no `version` field is passed over: a Python repo's
  // tooling-only package.json must not stop the probe short of its
  // pyproject.toml. A version.json with no version stops it, because that
  // file's name says it is the version file. Anything else wrong with a file
  // (unreadable, not an object, a version that isn't semver, a shape the TOML
  // scanner can't edit) stops it too.
  const pyPath = path.join(path.dirname(pkgPath), projectVersionFiles.PYPROJECT_FILENAME);
  const probe = [
    [versionPath, _resolveVersionJson],
    [pkgPath, _resolvePackageJson],
    // Python projects (#1444). Last, so a repo carrying both a versioned
    // package.json and a pyproject.toml keeps bumping the file it bumped before.
    [pyPath, _resolvePyproject]
  ];
  let passedOver = null;
  for (const [candidate, resolve] of probe) {
    if (!_internal.existsSync(candidate)) continue;
    const source = resolve(candidate);
    if (source.noVersion) {
      passedOver = passedOver || source;
      continue;
    }
    return source;
  }
  if (passedOver) return { skip: passedOver.skip };

  // Clearer than the old "version.json not found" — this project simply isn't
  // version-tracked in a form this step bumps.
  return { skip: 'not version-tracked (no version.json, package.json or pyproject.toml with a semver version)' };
}

// `_todayIsoLocal` previously lived inline here (PR #216); extracted
// to `lib/wrap-steps/_date.js` so `features-toc.js` and any future
// date-stamping step share one source of truth. The export below
// preserves the prior public name for the wiring-pin test —
// re-exporting the shared helper keeps `versionBump._todayIsoLocal`
// and `versionBump._internal.todayIso` referentially identical.
const _todayIsoLocal = todayIsoLocal;

const _internal = {
  readFileSync: fs.readFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  todayIso: _todayIsoLocal
};

module.exports = {
  run,
  _parseSemver,
  _bumpSemver,
  _compareSemver,
  _classifyTopRelease,
  _parseUnreleased,
  _decideBumpLevel,
  _releaseGate,
  _promoteUnreleased,
  _resolveVersionSource,
  _resolvePyproject,
  _todayIsoLocal,
  _internal
};
