'use strict';

/**
 * `version-bump` wrap step (open-queue #3, replaces #139 Chunk-3 no-op
 * stub) — reads the project's `CHANGELOG.md` `[Unreleased]` section
 * and `version.json`, promotes `[Unreleased]` to a dated release, and
 * bumps the semver in `version.json`.
 *
 * **Contract (per ADR 0002 step-kind table):**
 * "If CHANGELOG has [Unreleased] entries and project has version.json,
 * bump and update CHANGELOG. Optional, never blocks."
 *
 * The "never blocks" half is load-bearing: every degraded condition
 * (missing files, malformed `version.json`, empty `[Unreleased]`,
 * unparseable semver) returns `{ok:true, status:'skipped'}` with a
 * `reason` / `detail` in `output` for the wrap drawer to render
 * inline.
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
 *   - `staged['version-bump:prawduct-change-log']` (WRP-9F2K, only when the
 *     project has a `.prawduct/change-log.md` with `status=merged` tag lines)
 *     = `{primingPath, newContent, changed:true, changeLogFlipped:<n>}`
 *
 * **Prawduct change-log release stamp (WRP-9F2K).** A release promote and
 * the prawduct ledger's merged→shipped flip change state at the same moment
 * for the same reason, so the step couples them: when it promotes
 * `[Unreleased]`, every `<!-- prawduct: ... status=merged ... -->` tag line
 * in the project's `.prawduct/change-log.md` flips to `status=shipped`
 * (blanket, not per-release-scoped — a promote means everything merged is in
 * the release, matching the manual convention this replaces). Statusless tag
 * lines are deliberately NOT flipped — a missing `status=` is the
 * missed-merge-stamp diagnostic (prawduct REL-9F2T) and flipping it would
 * hide the miss; their count is surfaced in `output.changeLog.statusless`
 * instead. A flip failure never fails the step (the never-blocks contract):
 * it degrades to `output.changeLogWarning`. The step does not run prawduct's
 * `regen-views` — the next regen picks the flips up.
 *
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
 * a methodology adopts a different style and complains.
 *
 * @module lib/wrap-steps/version-bump
 */

const fs = require('node:fs');
const path = require('node:path');
const { todayIsoLocal } = require('./_date');
const { createLogger } = require('../logger');
const store = require('../store');
const projectPaths = require('../project-paths');

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
 * methodology-bump tool, not a general-purpose semver parser).
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

    // A heading announcing a version in some other scheme. Bracketed
    // (`## [2.85.0.41]`) or bare (`## 2026.07-build9`) both count — keying only
    // on the bracket is what let an unbracketed foreign scheme read as "no
    // releases yet" and fall through to the bump.
    if (bracketed || /^\d/.test(token)) {
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

// Matches a prawduct change-log tag line (`<!-- prawduct: ... -->`), the
// only line shape whose `status=merged` token the release stamp may flip.
// Anchored to a full comment line so prose in entry bodies that merely
// mentions "status=merged" is never touched.
const PRAWDUCT_TAG_LINE_RE = /^\s*<!--\s*prawduct:.*-->\s*$/;

/**
 * Flip `status=merged` → `status=shipped` on prawduct change-log tag lines
 * (WRP-9F2K). Pure text transform; only lines matching
 * {@link PRAWDUCT_TAG_LINE_RE} are eligible, so body prose is untouched.
 * Tag lines with no `status=` token at all are counted, not flipped — they
 * mark a missed merge-stamp, which this step must surface, not bury.
 *
 * @param {string} changeLogText - Full `.prawduct/change-log.md` content
 * @returns {{newText:string, flipped:number, statusless:number}}
 */
function _flipMergedTagLines(changeLogText) {
  const lines = String(changeLogText || '').split('\n');
  let flipped = 0;
  let statusless = 0;
  const out = lines.map((line) => {
    if (!PRAWDUCT_TAG_LINE_RE.test(line)) return line;
    if (!/\bstatus=/.test(line)) {
      statusless++;
      return line;
    }
    if (!/\bstatus=merged\b/.test(line)) return line;
    flipped++;
    return line.replace(/\bstatus=merged\b/g, 'status=shipped');
  });
  return { newText: out.join('\n'), flipped, statusless };
}

/**
 * Read the project's `.prawduct/change-log.md`, flip merged tag lines, and
 * stage the rewrite for the commit step's flush (WRP-9F2K). Returns the
 * counts for the step output, `null` when the project has no prawduct
 * change-log, or `{warning}` when the read/flip failed — a failure here
 * must degrade, never break the never-blocks version-bump contract.
 *
 * @param {string} projectPath - Project root
 * @param {object} staged - Pipeline single-transaction scratch space
 * @returns {{flipped:number, statusless:number}|{warning:string}|null}
 */
function _stagePrawductChangeLogStamp(projectPath, staged) {
  const changeLogPath = path.join(projectPath, '.prawduct', 'change-log.md');
  try {
    if (!_internal.existsSync(changeLogPath)) return null;
    const text = _internal.readFileSync(changeLogPath, 'utf8');
    const { newText, flipped, statusless } = _flipMergedTagLines(text);
    if (flipped > 0) {
      staged['version-bump:prawduct-change-log'] = {
        primingPath: changeLogPath,
        newContent: newText,
        changed: true,
        changeLogFlipped: flipped
      };
    }
    return { flipped, statusless };
  } catch (err) { // prawduct:allow prawduct/broad-except -- release stamp is best-effort; any failure must degrade to a warning, never fail the never-blocks version-bump step
    log.warn('prawduct change-log release stamp failed', { path: changeLogPath, error: err.message });
    return { warning: `change-log release stamp failed: ${err.message}` };
  }
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

  // #318: per-project opt-out. Projects that manage their own versioning set
  // `versionBumpEnabled: false`; skip cleanly so TC doesn't fight their scheme.
  // Missing/undefined = enabled (preserves existing behavior).
  let projConfig = null;
  try {
    projConfig = store.projectConfig.load(project.path);
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
  if (projConfig && projConfig.versionBumpEnabled === false) {
    return skip('version-bump disabled for this project (manages its own versioning)');
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
    return skip(`refusing to bump: ${JSON.stringify(currentVersion)} in ${source.kind} isn't MAJOR.MINOR.PATCH semver, so this step can't derive the next version. Set versionBumpEnabled:false if this project manages its own versioning.`);
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
    return skip(`refusing to bump: CHANGELOG.md's newest release heading (${topRelease.raw}) isn't MAJOR.MINOR.PATCH, so this project's versioning scheme isn't one this step can extend safely. Set versionBumpEnabled:false to silence this, or reconcile the changelog format.`);
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

  // WRP-9F2K: the promote is staged, so the release is happening this wrap —
  // stamp the prawduct ledger's merged entries shipped in the same transaction.
  const stamp = _stagePrawductChangeLogStamp(project.path, staged);

  log.info('version bumped', {
    project: project.name,
    oldVersion: currentVersion,
    newVersion,
    bumpLevel,
    subsections: parsed.subsections,
    changeLogStamp: stamp
  });

  const output = {
    from: currentVersion,
    to: newVersion,
    bumpLevel,
    versionFile: source.kind,
    subsections: parsed.subsections,
    detail: `${currentVersion} → ${newVersion} (${bumpLevel}, ${source.kind})`
  };
  if (stamp && typeof stamp.flipped === 'number') {
    output.changeLog = { flipped: stamp.flipped, statusless: stamp.statusless };
    if (stamp.flipped > 0) {
      output.detail += `; stamped ${stamp.flipped} change-log ${stamp.flipped === 1 ? 'entry' : 'entries'} shipped`;
    }
  } else if (stamp && stamp.warning) {
    output.changeLogWarning = stamp.warning;
    output.detail += `; ${stamp.warning}`;
  }

  return {
    ok: true,
    status: 'done',
    output,
    blockers: []
  };
}

/**
 * Build the step's canonical skip result, and log the refusal.
 *
 * @param {string} reason - Operator-facing explanation; becomes both
 *   `output.reason` and `output.detail`, which the wrap drawer renders inline.
 * @param {string} [projectName] - Owning project, for log attribution. Omitted
 *   only by the guard that fires when there is no usable project record.
 * @returns {{ok:true, status:'skipped', output:{reason:string, detail:string}, blockers:[]}}
 */
function _skipped(reason, projectName) {
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
    output: { reason, detail: reason },
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
  return { skip: `${label} version ${JSON.stringify(value)} isn't MAJOR.MINOR.PATCH semver, so this step can't derive the next version — expected when a project manages its own versioning. Set versionBumpEnabled:false to silence this.` };
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
    json = JSON.parse(raw);
  } catch (err) {
    return { skip: `package.json unreadable: ${err.message}` };
  }
  const cv = json && json.version;
  if (cv === undefined || cv === null || cv === '') {
    return { skip: 'package.json has no "version" field — nothing to bump' };
  }
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
 * Resolve which file holds the project version (#298): prefer `version.json`,
 * fall back to `package.json` (Node projects). Returns `{skip:<reason>}` when
 * neither is usable, else `{kind, path, currentVersion, stagedKey, makeContent}`.
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
    let json;
    try {
      json = JSON.parse(_internal.readFileSync(configuredPath, 'utf8'));
    } catch (err) {
      return { skip: `${label} unreadable: ${err.message}` };
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

  if (_internal.existsSync(versionPath)) {
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

  if (_internal.existsSync(pkgPath)) {
    return _resolvePackageJson(pkgPath);
  }

  // Clearer than the old "version.json not found" — this project simply isn't
  // version-tracked in a form this step bumps.
  return { skip: 'not version-tracked (no version.json or package.json with a semver version)' };
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
  _flipMergedTagLines,
  _stagePrawductChangeLogStamp,
  _parseSemver,
  _bumpSemver,
  _compareSemver,
  _classifyTopRelease,
  _parseUnreleased,
  _decideBumpLevel,
  _promoteUnreleased,
  _resolveVersionSource,
  _todayIsoLocal,
  _internal
};
