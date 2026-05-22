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
 *     `### Fixed` / `### Security`) → `'patch'`.
 *  4. Default fallback: `'patch'`.
 *
 * **Single-transaction discipline (matches Chunks 5–9).** Handler
 * never writes the filesystem; it stages TWO entries under composite
 * keys so the Chunk-9 `commit` step's `_flushStagedWrites` (duck-typed
 * on `{primingPath, newContent, changed}`) flushes both:
 *
 *   - `staged['version-bump:version-json'] = {primingPath, newContent, changed:true, oldVersion, newVersion, bumpLevel}`
 *   - `staged['version-bump:changelog']    = {primingPath, newContent, changed:true, oldVersion, newVersion, bumpLevel}`
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
 * @module lib/wrap-steps/version-bump
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logger');

const log = createLogger('wrap-step-version-bump');

const UNRELEASED_LINE_RE = /^## \[Unreleased\]\s*$/;
const NEXT_HEADING_RE = /^## \[/;
const SUBSECTION_RE = /^### (Added|Changed|Removed|Deprecated|Fixed|Security)\s*$/i;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const BREAKING_RE = /\bBREAKING\b/;
const ENTRY_LINE_RE = /^\s*[\-*]\s+\S/;

const BUMP_LEVELS = ['patch', 'minor', 'major'];
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
 * else `patch`.
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

  const versionPath = path.join(project.path, 'version.json');
  const changelogPath = path.join(project.path, 'CHANGELOG.md');

  if (!_internal.existsSync(versionPath)) {
    return _skipped('version.json not found');
  }
  let versionJson;
  try {
    const txt = _internal.readFileSync(versionPath, 'utf8');
    versionJson = JSON.parse(txt);
  } catch (err) {
    return _skipped(`version.json unreadable: ${err.message}`);
  }
  if (!versionJson || typeof versionJson !== 'object') {
    return _skipped('version.json is not an object');
  }
  const currentVersion = versionJson.version;
  if (!_parseSemver(currentVersion)) {
    return _skipped(`version.json "version" field missing or non-semver (got ${JSON.stringify(currentVersion)})`);
  }

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

  const today = _internal.todayIso();
  const newChangelogText = _promoteUnreleased(changelogText, newVersion, today);
  const newVersionJsonText = JSON.stringify({ ...versionJson, version: newVersion }, null, 2) + '\n';

  staged['version-bump:version-json'] = {
    primingPath: versionPath,
    newContent: newVersionJsonText,
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

  return {
    ok: true,
    status: 'done',
    output: {
      from: currentVersion,
      to: newVersion,
      bumpLevel,
      subsections: parsed.subsections,
      detail: `${currentVersion} → ${newVersion} (${bumpLevel})`
    },
    blockers: []
  };
}

function _skipped(reason) {
  return {
    ok: true,
    status: 'skipped',
    output: { skipped: true, reason, detail: reason },
    blockers: []
  };
}

const _internal = {
  readFileSync: fs.readFileSync.bind(fs),
  existsSync: fs.existsSync.bind(fs),
  todayIso: () => new Date().toISOString().slice(0, 10)
};

module.exports = {
  run,
  _parseSemver,
  _bumpSemver,
  _parseUnreleased,
  _decideBumpLevel,
  _promoteUnreleased,
  _internal
};
