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
 * **Bump-level precedence:**
 *  1. `options.bumpLevel` override (`'patch'` | `'minor'` | `'major'`)
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

const log = createLogger('wrap-step-version-bump');

const UNRELEASED_LINE_RE = /^## \[Unreleased\]\s*$/;
const NEXT_HEADING_RE = /^## \[/;
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
 * Find the top (newest) released-version heading in CHANGELOG text — the
 * first `## [X.Y.Z] - YYYY-MM-DD` line. Used to guard against a drifted
 * `version.json` that trails the changelog (#203): the bump must produce a
 * version strictly greater than what's already published.
 *
 * @param {string} changelogText
 * @returns {{major:number,minor:number,patch:number}|null} null if no
 *   released heading is present (e.g. a changelog with only `[Unreleased]`).
 */
function _topReleasedVersion(changelogText) {
  const lines = String(changelogText || '').split('\n');
  for (const line of lines) {
    const m = /^## \[(\d+)\.(\d+)\.(\d+)\] - \d{4}-\d{2}-\d{2}/.exec(line);
    if (m) return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  }
  return null;
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
  const newSection = [
    `## [${newVersion}] - ${isoDate}`,
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

  // #318: per-project opt-out. Projects that manage their own versioning set
  // `versionBumpEnabled: false`; skip cleanly so TC doesn't fight their scheme.
  // Missing/undefined = enabled (preserves existing behavior).
  let projConfig = null;
  try {
    projConfig = store.projectConfig.load(project.path);
  } catch {
    projConfig = null;
  }
  if (projConfig && projConfig.versionBumpEnabled === false) {
    return _skipped('version-bump disabled for this project (manages its own versioning)');
  }

  const versionPath = path.join(project.path, 'version.json');
  const pkgPath = path.join(project.path, 'package.json');
  const changelogPath = path.join(project.path, 'CHANGELOG.md');

  // #298: resolve which file holds the version — prefer `version.json`, fall
  // back to `package.json` (Node projects). Everything below is identical
  // regardless; only which file is read + written differs.
  const source = _resolveVersionSource(versionPath, pkgPath);
  if (source.skip) {
    return _skipped(source.skip);
  }
  const currentVersion = source.currentVersion;

  if (!_internal.existsSync(changelogPath)) {
    return _skipped('CHANGELOG.md not found');
  }
  let changelogText;
  try {
    changelogText = _internal.readFileSync(changelogPath, 'utf8');
  } catch (err) {
    return _skipped(`CHANGELOG.md unreadable: ${err.message}`);
  }

  const parsed = _parseUnreleased(changelogText);
  if (!parsed.ok) {
    return _skipped('[Unreleased] section not found in CHANGELOG.md');
  }
  if (!parsed.hasEntries) {
    return _skipped('[Unreleased] has no entries to promote (already released or empty)');
  }

  const bumpLevel = _decideBumpLevel(parsed, options || {});
  const newVersion = _bumpSemver(currentVersion, bumpLevel);
  if (!newVersion) {
    return _skipped(`could not bump ${currentVersion} (${bumpLevel})`);
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
  const topReleased = _topReleasedVersion(changelogText);
  if (topReleased && _compareSemver(_parseSemver(newVersion), topReleased) <= 0) {
    const tr = `${topReleased.major}.${topReleased.minor}.${topReleased.patch}`;
    return _skipped(`refusing to bump: newVersion (${newVersion}) is not strictly greater than CHANGELOG top released (${tr}). version.json may have drifted; reconcile manually before re-wrapping.`);
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

function _skipped(reason) {
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
 * Resolve which file holds the project version (#298): prefer `version.json`,
 * fall back to `package.json` (Node projects). Returns `{skip:<reason>}` when
 * neither is usable, else `{kind, path, currentVersion, stagedKey, makeContent}`.
 * `version.json` is rewritten normalized; `package.json`'s write is surgical —
 * only the top-level `"version"` value is swapped, byte-preserving the rest of
 * the hand-maintained file.
 * @param {string} versionPath - <project>/version.json
 * @param {string} pkgPath - <project>/package.json
 * @returns {{skip:string}|{kind:string, path:string, currentVersion:string, stagedKey:string, makeContent:(nv:string)=>string}}
 */
function _resolveVersionSource(versionPath, pkgPath) {
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
      // Neutral, not alarming (#318): a non-MAJOR.MINOR.PATCH value usually
      // means the project runs its own versioning scheme, not that anything
      // is broken. Set versionBumpEnabled:false to silence this entirely.
      return { skip: `version.json version ${JSON.stringify(json.version)} isn't MAJOR.MINOR.PATCH semver — skipping auto-bump (expected when a project manages its own versioning)` };
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
      return { skip: `package.json version ${JSON.stringify(cv)} isn't MAJOR.MINOR.PATCH semver — skipping auto-bump (expected when a project manages its own versioning)` };
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
  _topReleasedVersion,
  _parseUnreleased,
  _decideBumpLevel,
  _promoteUnreleased,
  _resolveVersionSource,
  _todayIsoLocal,
  _internal
};
