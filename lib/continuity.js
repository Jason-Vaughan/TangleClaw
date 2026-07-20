'use strict';

/**
 * Continuity store (CC-1) — the per-project "hot tier" of the Continuity
 * Contract (`.claude/plans/archive/continuity-contract.md`). This is the thin
 * vertical slice that proves the WRITE→READ loop end-to-end: a wrap step
 * writes a curated **index** carrying a `Next action`, and the next
 * session's prime reads it back to offer a visible "we left off at X —
 * continue?" resume (`lib/sessions.js:generatePrimePrompt`).
 *
 * **Storage.** One curated `index.md` per project, REWRITTEN each wrap so
 * it stays tight (KB), under `<project>/.tangleclaw/continuity/`. That
 * directory is gitignored (TC's `.gitignore` ignores `.tangleclaw/`), so
 * the index is local continuity state — present on disk for the next
 * session's prime to read, never swept into the wrap commit. This is the
 * `.tangleclaw/`-rooted store the later chunks (CC-2 changelog + grep,
 * CC-3 the Map, CC-4 consolidated store) build on; CC-1 keeps it to the
 * three fields the resume loop needs.
 *
 * **Format is fixed Markdown** (grep-friendly, human-readable) — the v1
 * retrieval contract. Sections are matched case-insensitively by their
 * `## Heading`, mirroring the `ai-content` parser so the convention stays
 * uniform across the codebase.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { createLogger } = require('./logger');
const { makePathTokenRegex } = require('./path-tokens');

const log = createLogger('continuity');

const STORE_SUBDIR = '.tangleclaw';
const STORE_LEAF = 'continuity';
const INDEX_FILENAME = 'index.md';
const CHANGELOG_FILENAME = 'changelog.md';
const WRAPS_LEAF = 'wraps';
const SESSIONS_LEAF = 'sessions';

// Cold-tier filenames (CC-4b store layout). Mirrored here — not imported from
// `lib/transcript.js` — because transcript.js depends on this module for the
// store paths, so importing back would be circular. The names are a store-
// layout contract; keep them in sync with transcript.js's TRANSCRIPT_FILENAME /
// META_FILENAME.
const TRANSCRIPT_FILENAME = 'transcript.jsonl';
const TRANSCRIPT_META_FILENAME = 'transcript.meta.json';

/** Per-line cap (bytes) on transcript text scanned for a cold-search match — a
 *  pathological tool-result line can be MBs; we still match within the cap but
 *  never lowercase an unbounded string. Mirrors transcript.js's MAX_LINE_SCAN. */
const MAX_TRANSCRIPT_LINE_SCAN = 256 * 1024;

/** Default cap on cold-search excerpts returned for one transcript (UI-bounded;
 *  `truncated:true` signals more matches exist beyond the cap). */
const TRANSCRIPT_EXCERPT_CAP = 200;

/** Max transcripts streamed concurrently by the project-wide search — bounds open
 *  file descriptors on a long-lived project (one transcript dir per wrapped
 *  session, no pruning). Guards against fd exhaustion (cf. #94). */
const TRANSCRIPT_SEARCH_CONCURRENCY = 8;

/**
 * The wrap summary's fixed section vocabulary (CC-2). Order is the render
 * order; the contract (`continuity-contract.md` §"Wrap summary") fixes both
 * the set and the spelling so a section-scoped grep is uniform across every
 * project. `Next action` is the keystone; `Freshness` is the verify-before-
 * trusting stamp. The middle four are honest-flagged when uncaptured.
 * @type {string[]}
 */
const WRAP_SECTIONS = [
  'Where we are',
  'Next action',
  'Delta',
  'Open threads',
  'Decisions',
  'Landmines',
  'Pointers',
  'Freshness'
];

/** Flagged-empty placeholder for a section/field not captured this wrap. */
const NOT_CAPTURED = '_⚠ not captured_';

/** Placeholder for a continuity-index `## Map` with no entries yet (CC-3). */
const MAP_EMPTY = '_no entries yet_';

/**
 * Absolute path to a project's continuity store directory.
 * @param {string} projectPath - Absolute project root
 * @returns {string}
 */
function storeDir(projectPath) {
  return path.join(projectPath, STORE_SUBDIR, STORE_LEAF);
}

/**
 * Absolute path to a project's hot index file.
 * @param {string} projectPath - Absolute project root
 * @returns {string}
 */
function indexPath(projectPath) {
  return path.join(storeDir(projectPath), INDEX_FILENAME);
}

/**
 * Render the hot index to its fixed Markdown shape. Pure — no I/O — so it
 * is trivially unit-testable and the write path is a thin fs wrapper over
 * it. Empty fields render as a flagged-empty marker rather than being
 * dropped: honest emptiness the next session can see beats a silent gap
 * (the "mechanical floor" / honest-labeling principle from the contract).
 *
 * @param {object} fields
 * @param {string} [fields.project] - Project name (header anchor only)
 * @param {string} [fields.currentState] - One-paragraph "where we are"
 * @param {string} [fields.nextAction] - "stopped at X · next is Y · open <artifact>"
 * @param {string} [fields.map] - Curated feature/component Map body (CC-3), preserved verbatim
 * @param {object} [fields.freshness] - Verify-before-trusting stamp
 * @param {string} [fields.freshness.sha] - HEAD short sha at write time
 * @param {string} [fields.freshness.branch] - Branch at write time
 * @param {string} [fields.freshness.writtenAt] - ISO date (YYYY-MM-DD)
 * @param {string} [fields.freshness.tier] - CC-7 degraded-wrap tier (`full` / `no-plugin` / `mechanical-only`)
 * @returns {string} Markdown document
 */
function renderIndex(fields = {}) {
  const f = fields || {};
  const fresh = f.freshness || {};
  const currentState = (f.currentState || '').trim();
  const nextAction = (f.nextAction || '').trim();
  const map = (f.map || '').trim();

  const lines = [];
  lines.push(`# Continuity Index${f.project ? ` — ${f.project}` : ''}`);
  lines.push('');
  lines.push('## Current state');
  lines.push(currentState || '_⚠ not captured this wrap_');
  lines.push('');
  lines.push('## Next action');
  lines.push(nextAction || '_⚠ not captured this wrap_');
  lines.push('');
  // The Map (CC-3) is curated/accreted across wraps — unlike the two
  // sections above it is preserved verbatim, not regenerated. `MAP_EMPTY`
  // (not the ⚠ marker) renders for a project with no entries yet: an empty
  // Map is a normal early state, not a degraded capture.
  lines.push('## Map');
  lines.push(map || MAP_EMPTY);
  lines.push('');
  lines.push('## Freshness');
  lines.push(`- written-at: ${(fresh.writtenAt || '').trim() || 'unknown'}`);
  lines.push(`- sha: ${(fresh.sha || '').trim() || 'unknown'}`);
  lines.push(`- branch: ${(fresh.branch || '').trim() || 'unknown'}`);
  // CC-7: stamp the degraded-wrap tier so the next session reads it at resume
  // ("verify before trusting"). `unknown` for callers that don't compute it.
  lines.push(`- tier: ${(fresh.tier || '').trim() || 'unknown'}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Parse a rendered index back into its fields. Pure — operates on a
 * string, not a file — and tolerant: unknown headings are ignored, a
 * flagged-empty marker (`_⚠ not captured…_`) parses back to an empty
 * string, and missing sections yield empty values rather than throwing.
 *
 * @param {string} text - Index Markdown
 * @returns {{currentState:string, nextAction:string, map:string, freshness:{sha:string, branch:string, writtenAt:string, tier:string}}}
 */
function parseIndex(text) {
  const out = {
    currentState: '',
    nextAction: '',
    map: '',
    freshness: { sha: '', branch: '', writtenAt: '', tier: '' }
  };
  if (!text || typeof text !== 'string') return out;

  const sections = {};
  let current = null;
  let buf = [];
  for (const line of text.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (current) sections[current] = buf.join('\n').trim();
      current = heading[1].toLowerCase();
      buf = [];
      continue;
    }
    if (current) buf.push(line);
  }
  if (current) sections[current] = buf.join('\n').trim();

  out.currentState = _unflag(sections['current state']);
  out.nextAction = _unflag(sections['next action']);

  // Map is preserved verbatim (curated prose + stubs); only the empty
  // placeholder collapses back to ''.
  const mapBody = (sections['map'] || '').trim();
  out.map = mapBody === MAP_EMPTY ? '' : mapBody;

  const freshBlock = sections['freshness'] || '';
  out.freshness.writtenAt = _bullet(freshBlock, 'written-at');
  out.freshness.sha = _bullet(freshBlock, 'sha');
  out.freshness.branch = _bullet(freshBlock, 'branch');
  out.freshness.tier = _bullet(freshBlock, 'tier'); // CC-7 degraded-wrap tier

  return out;
}

/**
 * Collapse the flagged-empty placeholder back to an empty string so
 * consumers treat "not captured" as absent rather than as real content.
 * @param {string} [value]
 * @returns {string}
 */
function _unflag(value) {
  const v = (value || '').trim();
  if (!v || /^_⚠.*_$/.test(v)) return '';
  return v;
}

/**
 * Extract `- <key>: <value>` from a bullet block. Returns '' for the
 * `unknown` sentinel renderIndex writes when a stamp field is missing.
 * @param {string} block - The `## Freshness` section body
 * @param {string} key - Bullet key (e.g. 'sha')
 * @returns {string}
 */
function _bullet(block, key) {
  const re = new RegExp(`^-\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'im');
  const m = block.match(re);
  const v = m ? m[1].trim() : '';
  return v === 'unknown' ? '' : v;
}

/**
 * Write (rewrite) the project's hot index. Creates the store directory if
 * absent. Throws on a real fs error so the caller (the wrap step) can
 * record a blocker — but a wrap should never *halt* on continuity, so the
 * step treats failure as a non-blocking note.
 *
 * @param {string} projectPath - Absolute project root
 * @param {object} fields - See `renderIndex`
 * @returns {string} Absolute path to the written index
 */
function writeIndex(projectPath, fields) {
  const dir = storeDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const file = indexPath(projectPath);
  fs.writeFileSync(file, renderIndex(fields));
  log.debug('Wrote continuity index', { projectPath, file });
  return file;
}

/**
 * Read and parse the project's hot index. Non-throwing by design: the
 * prime must never fail to launch a session because continuity is
 * missing or corrupt. Returns `null` when the index is absent or
 * unreadable, or when it carries neither a current-state nor a
 * next-action (a degraded/empty index offers nothing to resume from).
 *
 * @param {string} projectPath - Absolute project root
 * @returns {{currentState:string, nextAction:string, freshness:object}|null}
 */
function readIndex(projectPath) {
  let raw;
  try {
    raw = fs.readFileSync(indexPath(projectPath), 'utf8');
  } catch {
    return null; // absent index is the common case (no wrap yet) — silent
  }
  try {
    const parsed = parseIndex(raw);
    if (!parsed.currentState && !parsed.nextAction) return null;
    return parsed;
  } catch (err) {
    log.warn('Failed to parse continuity index', { projectPath, error: err.message });
    return null;
  }
}

// ── CC-2: warm tier — append-only changelog + per-session wrap summary + grep ──

/**
 * Absolute path to a project's append-only continuity changelog.
 * @param {string} projectPath - Absolute project root
 * @returns {string}
 */
function changelogPath(projectPath) {
  return path.join(storeDir(projectPath), CHANGELOG_FILENAME);
}

/**
 * Absolute path to the per-session wrap-summary archive directory.
 * @param {string} projectPath - Absolute project root
 * @returns {string}
 */
function wrapsDir(projectPath) {
  return path.join(storeDir(projectPath), WRAPS_LEAF);
}

/**
 * Absolute path to one session's wrap summary.
 * @param {string} projectPath - Absolute project root
 * @param {string|number} sid - Session id (the `session:<sid>` pointer)
 * @returns {string}
 */
function wrapSummaryPath(projectPath, sid) {
  return path.join(wrapsDir(projectPath), `${sid}.md`);
}

/**
 * Absolute path to one session's directory in the consolidated per-project
 * store (CC-4). The store is `<project>/.tangleclaw/continuity/`; each session
 * gets a sub-tree `sessions/<sid>/` that co-locates everything that session
 * produced (uploads now; the transcript snapshot in CC-4b). `sid` is the same
 * integer session id used as the `session:<sid>` pointer elsewhere in the
 * store (`wrapSummaryPath`, the changelog token), so retrieval stays uniform.
 * This is the single root the repo-rename chunk (R/#183) re-keys.
 * @param {string} projectPath - Absolute project root
 * @param {string|number} sid - Session id (the `session:<sid>` pointer)
 * @returns {string}
 */
function sessionDir(projectPath, sid) {
  return path.join(sessionsRoot(projectPath), String(sid));
}

/**
 * Absolute path to the consolidated store's `sessions/` root — the parent of
 * every per-session sub-tree (CC-4). Exposed so consumers (e.g. `listUploads`)
 * can enumerate session dirs without reconstructing the path from a sentinel
 * sid or hardcoding the `sessions` leaf.
 * @param {string} projectPath - Absolute project root
 * @returns {string}
 */
function sessionsRoot(projectPath) {
  return path.join(storeDir(projectPath), SESSIONS_LEAF);
}

/**
 * Absolute path to one session's uploads directory in the consolidated store
 * (CC-4). Uploads were a flat, session-unattributed `<project>/.uploads/`
 * pile; relocating them here makes a session's screenshots/files part of its
 * durable record and cascade-deletable with the project.
 * @param {string} projectPath - Absolute project root
 * @param {string|number} sid - Session id (the `session:<sid>` pointer)
 * @returns {string}
 */
function sessionUploadsDir(projectPath, sid) {
  return path.join(sessionDir(projectPath, sid), 'uploads');
}

/**
 * Split a comma/whitespace-delimited list value into trimmed, non-empty tokens.
 * Tolerant of a `null`/array/string input so it can normalize both rendered
 * markdown (`"a, b, c"`) and a caller-passed array. Pure.
 * @param {string|string[]|null|undefined} val
 * @returns {string[]}
 */
function _splitList(val) {
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  if (val == null) return [];
  return String(val)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Normalize a list value (array or comma-string) to a clean comma-joined string
 * for rendering. Empty → `''` so callers omit the line entirely. Pure.
 * @param {string|string[]|null|undefined} val
 * @returns {string}
 */
function _normalizeListString(val) {
  return _splitList(val).join(', ');
}

/**
 * Render one changelog entry — warm tier, append-only, one per session
 * (`continuity-contract.md` §1). The `session:<sid>` token is the stable
 * pointer into the wrap-summary archive; `tags:` is the primary grep target.
 * Pure (no I/O). `tags`/`refs` lines are omitted when empty — honest absence
 * rather than an empty-label line that pollutes grep hits.
 *
 * @param {object} fields
 * @param {string} fields.date - ISO date `YYYY-MM-DD`
 * @param {string|number} fields.sid - Session id
 * @param {string} [fields.line] - One-line "what + why"
 * @param {string} [fields.tags] - Comma-separated lowercase-kebab keywords
 * @param {string} [fields.refs] - Issue/PR refs (e.g. `#352, #160`)
 * @param {string} [fields.type] - Session work type (e.g. `feat`/`fix`/`chore`/`docs`/`refactor`),
 *   rendered as a `[type]` token after the session pointer — the CC-5 type filter's grep target.
 * @param {string|string[]} [fields.files] - Files this session touched, rendered as a `files:` line —
 *   the CC-5 file-touched filter's grep target. Accepts a comma-joined string or an array.
 * @returns {string} A single entry (no trailing newline)
 */
function renderChangelogEntry(fields = {}) {
  const f = fields || {};
  const date = (f.date || '').trim() || 'unknown';
  const sid = String(f.sid == null ? '' : f.sid).trim() || 'unknown';
  // Collapse internal whitespace/newlines: a changelog entry is a single line
  // (the captured `summary` can be multi-line prose) so a stray newline can't
  // spill un-prefixed text into the append-only file and break the one-entry-
  // per-line grep contract. The full detail lives in the session's wrap summary.
  const line = (f.line || '').replace(/\s+/g, ' ').trim() || NOT_CAPTURED;
  const tags = (f.tags || '').replace(/\s+/g, ' ').trim();
  const refs = (f.refs || '').replace(/\s+/g, ' ').trim();
  const type = (f.type || '').replace(/[^A-Za-z0-9_-]/g, '').trim();
  const files = _normalizeListString(f.files);

  // `[type]` rides on the main line right after the session pointer so the
  // existing `(session:N)` grep is untouched and a type token is one regex away.
  const head = `- ${date} (session:${sid})${type ? ` [${type}]` : ''} ${line}`;
  const out = [head];
  if (tags) out.push(`  tags: ${tags}`);
  if (refs) out.push(`  refs: ${refs}`);
  if (files) out.push(`  files: ${files}`);
  return out.join('\n');
}

/**
 * Append a changelog entry to the project's continuity changelog, creating
 * the store dir + a titled file on first write. Append-only: the file is
 * never rewritten, so it never lies about the past. Most-recent-last (entries
 * accrete in chronological order — `search` sorts on read when needed).
 *
 * @param {string} projectPath - Absolute project root
 * @param {object} fields - See `renderChangelogEntry`
 * @returns {string} Absolute path to the changelog
 */
function appendChangelogEntry(projectPath, fields) {
  const dir = storeDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const file = changelogPath(projectPath);
  const entry = renderChangelogEntry(fields);
  if (fs.existsSync(file)) {
    fs.appendFileSync(file, `\n${entry}\n`);
  } else {
    fs.writeFileSync(file, `# Continuity Changelog\n\n${entry}\n`);
  }
  log.debug('Appended continuity changelog entry', { projectPath, file });
  return file;
}

/**
 * Render a per-session wrap summary — warm tier, one doc per session
 * (`continuity-contract.md` §2): YAML frontmatter (greppable keys) + the
 * eight fixed `## sections`. Pure. A missing section renders honest-empty
 * (`NOT_CAPTURED`) rather than being dropped — the mechanical-floor rule.
 * Frontmatter keys are emitted only when present (no `key:` clutter for
 * fields a degraded wrap couldn't fill).
 *
 * @param {object} fields
 * @param {object} [fields.meta] - Frontmatter: session, date, project, harness, branch,
 *   sha, tags, type, files, tier. `type` + `files` (CC-5) feed the operator-search type / file-touched
 *   filters; `files` accepts a comma-string or an array (normalized to a comma-joined string). `tier`
 *   (CC-7) records which degraded-wrap tier ran (`full` / `no-plugin` / `mechanical-only`) so a grep
 *   or the next session can see at a glance how much judgment this wrap could capture.
 * @param {object} [fields.sections] - Map of section name → body (keys matched case-insensitively against WRAP_SECTIONS)
 * @param {string[]|null} [fields.enabledSections] - CC-6 (#381): which sections to render.
 *   null/undefined ⇒ all 8 (the deep default). An array renders only its members,
 *   in canonical order; `Next action` is ALWAYS rendered (the keystone) regardless.
 * @param {string} [fields.uncapturedReason] - CC-7: when judgment was uncaptured for a known
 *   reason (e.g. `no AI channel`), flag the empty sections WITH that reason
 *   (`_⚠ not captured (no AI channel)_`) instead of the bare placeholder — honest labeling so the
 *   next session sees WHY a section is empty, not just that it is. Omitted ⇒ bare `NOT_CAPTURED`.
 * @returns {string} Markdown document
 */
function renderWrapSummary(fields = {}) {
  const meta = (fields && fields.meta) || {};
  const sections = (fields && fields.sections) || {};

  // Case-insensitive lookup so callers can pass 'where we are' or 'Where we are'.
  const byLower = {};
  for (const [k, v] of Object.entries(sections)) byLower[k.toLowerCase()] = v;

  const metaKeys = ['session', 'date', 'project', 'harness', 'branch', 'sha', 'tags', 'type', 'files', 'tier'];
  const lines = ['---'];
  for (const key of metaKeys) {
    // `files` may arrive as an array — normalize to a comma-joined string so the
    // frontmatter stays single-line and greppable, matching the `tags` shape.
    const raw = key === 'files' ? _normalizeListString(meta[key]) : meta[key];
    const val = raw == null ? '' : String(raw).trim();
    if (val) lines.push(`${key}: ${val}`);
  }
  lines.push('---');

  // CC-7 degraded-wrap honest labeling: a reason-bearing flag still matches
  // `_unflag`'s `/^_⚠.*_$/`, so a re-parse collapses it back to '' — the
  // round-trip the warm tier relies on is preserved.
  const reason = typeof fields.uncapturedReason === 'string' ? fields.uncapturedReason.trim() : '';
  const flag = reason ? `_⚠ not captured (${reason})_` : NOT_CAPTURED;

  for (const section of effectiveWrapSections(fields.enabledSections)) {
    const body = (byLower[section.toLowerCase()] || '').trim();
    lines.push(`## ${section}`);
    lines.push(body || flag);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Resolve a project's wrap-section selection (CC-6, #381) to the ordered list of
 * sections that should render. Pure + reusable so the wrap step and the UI agree.
 * - null/undefined ⇒ all 8 (`WRAP_SECTIONS`) — the deep default.
 * - an array ⇒ only its members, but always preserving canonical order and
 *   ALWAYS including `Next action` (unchecking the keystone would recreate the
 *   thin-wrap failure the Continuity Contract exists to fix).
 * Unknown names in the array are ignored (they can't match a real section).
 *
 * @param {string[]|null} [enabledSections]
 * @returns {string[]}
 */
function effectiveWrapSections(enabledSections) {
  if (!Array.isArray(enabledSections)) return [...WRAP_SECTIONS];
  return WRAP_SECTIONS.filter((s) => s === 'Next action' || enabledSections.includes(s));
}

/**
 * Parse a wrap summary back into `{ meta, sections }`. Pure + tolerant:
 * unknown frontmatter keys and unknown headings are preserved; a flagged-empty
 * body parses back to `''`; a missing frontmatter block yields empty meta.
 *
 * @param {string} text - Wrap summary Markdown
 * @returns {{meta:object, sections:object}}
 */
function parseWrapSummary(text) {
  const out = { meta: {}, sections: {} };
  if (!text || typeof text !== 'string') return out;

  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (m) out.meta[m[1].trim()] = m[2].trim();
    }
    body = text.slice(fm[0].length);
  }

  let current = null;
  let buf = [];
  for (const line of body.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (current !== null) out.sections[current] = _unflag(buf.join('\n').trim());
      current = heading[1].trim();
      buf = [];
      continue;
    }
    if (current !== null) buf.push(line);
  }
  if (current !== null) out.sections[current] = _unflag(buf.join('\n').trim());

  return out;
}

/**
 * Write (overwrite) one session's wrap summary into the archive, creating the
 * `wraps/` dir if absent. One file per session id; a re-wrap of the same
 * session overwrites its own doc (the changelog, by contrast, is append-only).
 *
 * @param {string} projectPath - Absolute project root
 * @param {string|number} sid - Session id
 * @param {object} fields - See `renderWrapSummary`
 * @returns {string} Absolute path to the written summary
 */
function writeWrapSummary(projectPath, sid, fields) {
  const dir = wrapsDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const file = wrapSummaryPath(projectPath, sid);
  fs.writeFileSync(file, renderWrapSummary(fields));
  log.debug('Wrote continuity wrap summary', { projectPath, sid, file });
  return file;
}

/**
 * Read + parse one session's wrap summary. Non-throwing: returns `null` when
 * absent or unparseable (a consumer should degrade, never crash).
 *
 * @param {string} projectPath - Absolute project root
 * @param {string|number} sid - Session id
 * @returns {{meta:object, sections:object}|null}
 */
function readWrapSummary(projectPath, sid) {
  let raw;
  try {
    raw = fs.readFileSync(wrapSummaryPath(projectPath, sid), 'utf8');
  } catch {
    return null;
  }
  try {
    return parseWrapSummary(raw);
  } catch (err) {
    log.warn('Failed to parse wrap summary', { projectPath, sid, error: err.message });
    return null;
  }
}

/**
 * Grep-over-markdown retrieval (CC-2 v1 — `continuity-contract.md`
 * §"Retrieval mechanism"). Scans the changelog + every wrap summary for a
 * case-insensitive substring, returning structured matches that carry the
 * `session:<sid>` pointer so a "this broke again" query resolves to the
 * session whose summary explains the fix.
 *
 * Pure JS scan (no shell, no ripgrep) — model-agnostic, zero-infra, and the
 * `rg` on this machine is only a shell alias, not a guaranteed binary.
 * SQLite FTS stays the reserved scale option if grep ever gets slow. Never
 * throws: a missing store yields `[]`.
 *
 * @param {string} projectPath - Absolute project root
 * @param {string} query - Case-insensitive substring to match
 * @param {object} [opts]
 * @param {string} [opts.section] - Restrict wrap-summary hits to one `## heading` (case-insensitive)
 * @returns {Array<{source:'changelog'|'wrap-summary', sid:string|null, section:string|null, line:string}>}
 */
function search(projectPath, query, opts = {}) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const sectionFilter = (opts && opts.section || '').trim().toLowerCase();
  const results = [];

  // Changelog: match per line; carry the most-recent `session:<sid>` token seen
  // at or above the matching line (entries are `- … (session:N) …`).
  try {
    const text = fs.readFileSync(changelogPath(projectPath), 'utf8');
    let lastSid = null;
    for (const line of text.split('\n')) {
      const sidMatch = line.match(/\(session:([^)]+)\)/);
      if (sidMatch) lastSid = sidMatch[1].trim();
      if (!sectionFilter && line.toLowerCase().includes(q)) {
        results.push({ source: 'changelog', sid: lastSid, section: null, line: line.trim() });
      }
    }
  } catch { /* no changelog yet — skip */ }

  // Wrap summaries: scan each archived doc; tag every hit with its sid + section.
  let files = [];
  try {
    files = fs.readdirSync(wrapsDir(projectPath)).filter((f) => f.endsWith('.md')).sort();
  } catch { files = []; }
  for (const f of files) {
    let parsed;
    try {
      parsed = parseWrapSummary(fs.readFileSync(path.join(wrapsDir(projectPath), f), 'utf8'));
    } catch { continue; }
    const sid = parsed.meta.session || f.replace(/\.md$/, '');
    for (const [name, body] of Object.entries(parsed.sections)) {
      if (sectionFilter && name.toLowerCase() !== sectionFilter) continue;
      if (!body) continue;
      for (const line of body.split('\n')) {
        if (line.toLowerCase().includes(q)) {
          results.push({ source: 'wrap-summary', sid: String(sid), section: name, line: line.trim() });
        }
      }
    }
  }

  return results;
}

// ── CC-3: the Map — self-maintained feature/component index ──

/**
 * Path-like token matcher for Map entries — the SAME matcher the `features-toc`
 * tokenizer uses (shared via `lib/path-tokens`, CON-8H3Z), so an entry written
 * `\`lib/foo.js:42\`` or `lib/foo.js (added)` both register the file and the two
 * surfaces can't drift their extension allowlists. Own module-scope instance so
 * its `.lastIndex` is isolated from the features-toc consumer's. Used to decide
 * which entries a deletion prunes.
 */
const MAP_PATH_TOKEN_RE = makePathTokenRegex();

/**
 * Extract the path tokens referenced by one Map entry line.
 * @param {string} line
 * @returns {string[]}
 */
function _mapEntryPaths(line) {
  const out = [];
  MAP_PATH_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = MAP_PATH_TOKEN_RE.exec(line)) !== null) out.push(m[1]);
  return out;
}

/**
 * Read + parse the project's continuity index, returning the FULL parsed
 * shape (incl. the Map) or `null` only when the file is absent/unreadable.
 *
 * Distinct from `readIndex`, which additionally returns `null` for a
 * degraded index carrying no judgment content — fine for the resume read,
 * but wrong for the wrap's Map maintenance, which must recover an existing
 * Map even when this wrap hasn't captured a state/next-action yet.
 *
 * @param {string} projectPath - Absolute project root
 * @returns {{currentState:string, nextAction:string, map:string, freshness:object}|null}
 */
function readIndexRaw(projectPath) {
  let raw;
  try {
    raw = fs.readFileSync(indexPath(projectPath), 'utf8');
  } catch {
    return null;
  }
  try {
    return parseIndex(raw);
  } catch (err) {
    log.warn('Failed to parse continuity index (raw)', { projectPath, error: err.message });
    return null;
  }
}

/**
 * Self-maintain the Map (CC-3) — the generalized `features-toc` pattern.
 * Pure: given the existing Map body + the files this session touched and
 * deleted, return the new Map body.
 *
 *   - **Stub** a `- **TBD** — \`<path>\` <!-- describe -->` entry for each
 *     `touched` path not already referenced by a surviving entry (the AI
 *     later groups stubs into feature entries + fills descriptions).
 *   - **Prune** an entry only when EVERY path it references is in `deleted`
 *     — so an AI-curated multi-file feature entry survives if any of its
 *     files remain. Entries with no path tokens (pure prose headers) are
 *     never pruned.
 *
 * Operates line-by-line on `- ` bullet entries; non-entry lines (blank,
 * prose) are preserved in place. Idempotent: a touched file already in the
 * Map produces no new stub.
 *
 * @param {string} existingMapText - Prior Map body ('' when none yet)
 * @param {object} delta
 * @param {string[]} [delta.touched] - Added/modified indexable paths
 * @param {string[]} [delta.deleted] - Deleted indexable paths
 * @returns {string} New Map body
 */
function updateMap(existingMapText, delta = {}) {
  const touched = Array.isArray(delta.touched) ? delta.touched : [];
  const deleted = new Set(Array.isArray(delta.deleted) ? delta.deleted : []);

  const lines = String(existingMapText || '').split('\n');
  const kept = [];
  const referenced = new Set();

  for (const line of lines) {
    const isEntry = /^\s*-\s+/.test(line);
    if (!isEntry) {
      // Preserve non-entry lines (prose/headers) verbatim, except blanks
      // which we normalize out so the rebuilt body stays tight.
      if (line.trim()) kept.push(line);
      continue;
    }
    const paths = _mapEntryPaths(line);
    // Prune only when the entry references ≥1 path and ALL are deleted.
    if (paths.length > 0 && paths.every((p) => deleted.has(p))) continue;
    kept.push(line);
    for (const p of paths) referenced.add(p);
  }

  const stubs = [];
  for (const p of touched) {
    if (!referenced.has(p)) {
      stubs.push(`- **TBD** — \`${p}\` <!-- describe -->`);
      referenced.add(p); // guard against dup touched entries
    }
  }

  return [...kept, ...stubs].join('\n').trim();
}

// ── CC-5: operator-facing cross-session search (#344) ──
//
// Two-stage funnel over the warm + cold tiers:
//   1. searchSessions() — warm global search (changelog + wrap summaries) with
//      five filters + recency ranking, grouped by session. The default view:
//      search the whole history without naming a session first.
//   2. searchTranscript() — cold drill-down inside one session's raw transcript.
// Both reuse the lower-level primitives (`search`, the store paths) and never
// throw — a missing store / transcript yields an empty-but-honest result.

/** Add items to a target array, de-duplicating by value. @returns {void} */
function _addUnique(target, items) {
  for (const it of items) if (!target.includes(it)) target.push(it);
}

/** Compare two session ids: numerically when both are numeric, else lexically. */
function _sidCompare(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

/**
 * The canonical session-result ordering, shared by `listSessions`,
 * `searchSessions`, and `searchProjectTranscripts`: recency desc (undated `''`
 * sorts last) → match-count desc → sid (via `_sidCompare`). Records without a
 * `matchCount` (e.g. `listSessions`) leave that tier a no-op (`undefined !==
 * undefined` is false), so the same comparator orders both ranked search hits
 * and the unranked session list identically to the three inline copies it
 * replaces.
 * @param {{date?:string, matchCount?:number, sid:*}} a
 * @param {{date?:string, matchCount?:number, sid:*}} b
 * @returns {number}
 */
function _byRecencyMatchSid(a, b) {
  const da = a.date || '';
  const db = b.date || '';
  if (da !== db) return db.localeCompare(da);
  if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
  return _sidCompare(b.sid, a.sid);
}

/**
 * Build the forward-only `unindexed` meta block: how many of `sessions` can
 * never match a `type`/`file` filter because they were wrapped before CC-5
 * recorded those fields. Shared by `searchSessions` and
 * `searchProjectTranscripts` so the drawer's "honest gap" labels stay
 * consistent.
 * @param {Array<{type?:string, files?:Array}>} sessions
 * @returns {{type:number, file:number}}
 */
function _unindexedMeta(sessions) {
  return {
    type: sessions.filter((s) => !s.type).length,
    file: sessions.filter((s) => !s.files.length).length
  };
}

/**
 * Parse the append-only changelog into per-session entries. Each entry line is
 * `- <date> (session:<sid>) [<type>] <summary>` followed by optional indented
 * `tags:` / `refs:` / `files:` lines (the CC-2 + CC-5 schema). Tolerant: lines
 * that don't match a known shape are ignored. Pure.
 * @param {string} text - Raw changelog markdown
 * @returns {Array<{date:string, sid:string, type:string|null, summary:string,
 *   tags:string[], refs:string[], files:string[]}>}
 */
function _parseChangelogEntries(text) {
  const entries = [];
  if (!text || typeof text !== 'string') return entries;
  let cur = null;
  for (const line of text.split('\n')) {
    const head = line.match(/^- (\S+) \(session:([^)]+)\)(?:\s+\[([^\]]+)\])?\s*(.*)$/);
    if (head) {
      cur = {
        date: head[1].trim(),
        sid: head[2].trim(),
        type: (head[3] || '').trim() || null,
        summary: (head[4] || '').trim(),
        tags: [],
        refs: [],
        files: []
      };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    const tagm = line.match(/^\s+tags:\s*(.+)$/);
    if (tagm) { cur.tags = _splitList(tagm[1]); continue; }
    const refm = line.match(/^\s+refs:\s*(.+)$/);
    if (refm) { cur.refs = _splitList(refm[1]); continue; }
    const filem = line.match(/^\s+files:\s*(.+)$/);
    if (filem) { cur.files = _splitList(filem[1]); continue; }
  }
  return entries;
}

/**
 * Read + parse one session's cold-tier transcript meta envelope
 * (`sessions/<sid>/transcript.meta.json`, CC-4b). Non-throwing: returns `null`
 * when absent or unparseable.
 * @param {string} projectPath - Absolute project root
 * @param {string|number} sid - Session id
 * @returns {object|null}
 */
function readTranscriptMeta(projectPath, sid) {
  try {
    const raw = fs.readFileSync(path.join(sessionDir(projectPath, sid), TRANSCRIPT_META_FILENAME), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Build the per-session metadata index the operator-search drawer browses and
 * the filters predicate against. Merges three sources keyed by session id:
 * wrap-summary frontmatter (date/tags/type/files), the changelog entry
 * (date/tags/refs/type/files), and the cold-tier transcript meta (secret flag,
 * harness, byte size). Sessions that exist only as a transcript dir still
 * surface. Recency-sorted (newest date first; undated last). Never throws.
 * @param {string} projectPath - Absolute project root
 * @returns {Array<object>} Per-session records
 */
function listSessions(projectPath) {
  const bySid = new Map();
  const ensure = (sid) => {
    const key = String(sid).trim();
    if (!bySid.has(key)) {
      bySid.set(key, {
        sid: key, date: null, type: null,
        tags: [], refs: [], files: [],
        hasWrap: false, hasTranscript: false,
        secretsFlagged: false, secretTypes: [],
        harness: null, transcriptBytes: 0
      });
    }
    return bySid.get(key);
  };

  // Wrap summaries — frontmatter date/tags/type/files.
  let wrapFiles = [];
  try {
    wrapFiles = fs.readdirSync(wrapsDir(projectPath)).filter((f) => f.endsWith('.md'));
  } catch { wrapFiles = []; }
  for (const f of wrapFiles) {
    let parsed;
    try {
      parsed = parseWrapSummary(fs.readFileSync(path.join(wrapsDir(projectPath), f), 'utf8'));
    } catch (err) {
      log.debug('Skipping unreadable wrap summary in listSessions', { projectPath, file: f, error: err.message });
      continue;
    }
    const sid = (parsed.meta.session || f.replace(/\.md$/, '')).trim();
    const rec = ensure(sid);
    rec.hasWrap = true;
    if (parsed.meta.date) rec.date = rec.date || parsed.meta.date;
    if (parsed.meta.type) rec.type = rec.type || parsed.meta.type;
    _addUnique(rec.tags, _splitList(parsed.meta.tags));
    _addUnique(rec.files, _splitList(parsed.meta.files));
  }

  // Changelog — per-session entry tokens (the only source of `refs`).
  try {
    const entries = _parseChangelogEntries(fs.readFileSync(changelogPath(projectPath), 'utf8'));
    for (const e of entries) {
      const rec = ensure(e.sid);
      rec.date = rec.date || e.date;
      if (e.type) rec.type = rec.type || e.type;
      _addUnique(rec.tags, e.tags);
      _addUnique(rec.refs, e.refs);
      _addUnique(rec.files, e.files);
    }
  } catch { /* no changelog yet */ }

  // Cold tier — transcript meta (also surfaces transcript-only sessions).
  let sessDirs = [];
  try {
    sessDirs = fs.readdirSync(sessionsRoot(projectPath), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { sessDirs = []; }
  for (const sid of sessDirs) {
    const rec = ensure(sid);
    const meta = readTranscriptMeta(projectPath, sid);
    if (meta) {
      rec.hasTranscript = true;
      rec.secretsFlagged = !!meta.secretsFlagged;
      rec.secretTypes = Array.isArray(meta.secretTypes) ? meta.secretTypes : [];
      rec.harness = meta.harness || null;
      rec.transcriptBytes = Number(meta.bytes) || 0;
      if (!rec.date && meta.capturedAt) rec.date = String(meta.capturedAt).slice(0, 10);
    }
  }

  const arr = Array.from(bySid.values());
  arr.sort(_byRecencyMatchSid); // recency desc; '' (undated) sorts last; no matchCount here
  return arr;
}

/**
 * Build the shared five-filter predicate (date range / type / tags / refs /
 * file) over a `listSessions` record. Extracted so both the warm summary search
 * and the cold project-wide transcript search narrow the session set the same
 * way. Filters AND across types; multi-value `tags`/`refs` require all present.
 * @param {object} [opts] - See `searchSessions`
 * @returns {(s:object)=>boolean}
 */
function _buildSessionFilter(opts = {}) {
  const o = opts || {};
  const dateFrom = (o.dateFrom || '').trim();
  const dateTo = (o.dateTo || '').trim();
  const typeF = (o.type || '').trim().toLowerCase();
  const tagsF = _splitList(o.tags).map((t) => t.toLowerCase());
  const refsF = _splitList(o.refs).map((r) => r.replace(/^#/, '').toLowerCase());
  const fileF = (o.file || '').trim().toLowerCase();
  return (s) => {
    if (dateFrom && (!s.date || s.date < dateFrom)) return false;
    if (dateTo && (!s.date || s.date > dateTo)) return false;
    if (typeF && (!s.type || s.type.toLowerCase() !== typeF)) return false;
    if (tagsF.length) {
      const lc = s.tags.map((t) => t.toLowerCase());
      if (!tagsF.every((t) => lc.includes(t))) return false;
    }
    if (refsF.length) {
      const lc = s.refs.map((r) => r.replace(/^#/, '').toLowerCase());
      if (!refsF.every((r) => lc.includes(r))) return false;
    }
    if (fileF && !s.files.some((f) => f.toLowerCase().includes(fileF))) return false;
    return true;
  };
}

/**
 * Warm global search across a project's session history (CC-5). Reuses the
 * grep-over-markdown `search()` for raw hits, then applies the five operator
 * filters, groups hits by session, and ranks recency-primary / match-count-
 * secondary. With an empty query but active filters, returns all filter-matching
 * sessions (browse mode). Filters AND across types; multi-value `tags`/`refs`
 * require all values present. Never throws.
 *
 * @param {string} projectPath - Absolute project root
 * @param {string} query - Case-insensitive substring (empty ⇒ browse)
 * @param {object} [opts]
 * @param {string} [opts.dateFrom] - Inclusive `YYYY-MM-DD` lower bound
 * @param {string} [opts.dateTo] - Inclusive `YYYY-MM-DD` upper bound
 * @param {string} [opts.type] - Exact work-type match (case-insensitive)
 * @param {string|string[]} [opts.tags] - Require all these tags
 * @param {string|string[]} [opts.refs] - Require all these refs (`#` optional)
 * @param {string} [opts.file] - Substring match against a touched file path
 * @param {string} [opts.section] - Restrict query hits to one wrap-summary section
 * @param {number} [opts.limit] - Cap returned sessions (0/absent ⇒ all)
 * @returns {{sessions:Array<object>, meta:{scanned:number, matched:number,
 *   returned:number, unindexed:{type:number, file:number}}}}
 */
function searchSessions(projectPath, query, opts = {}) {
  const o = opts || {};
  const sessions = listSessions(projectPath);
  const q = (query || '').trim();

  const filtered = sessions.filter(_buildSessionFilter(o));

  let results;
  if (q) {
    const hitsBySid = new Map();
    for (const h of search(projectPath, q, { section: o.section })) {
      const key = String(h.sid == null ? '' : h.sid);
      if (!hitsBySid.has(key)) hitsBySid.set(key, []);
      hitsBySid.get(key).push(h);
    }
    results = filtered
      .filter((s) => hitsBySid.has(s.sid))
      .map((s) => ({ ...s, hits: hitsBySid.get(s.sid), matchCount: hitsBySid.get(s.sid).length }));
  } else {
    results = filtered.map((s) => ({ ...s, hits: [], matchCount: 0 }));
  }

  results.sort(_byRecencyMatchSid);

  const limit = Number.isFinite(o.limit) ? o.limit : 0;
  const limited = limit > 0 ? results.slice(0, limit) : results;

  return {
    sessions: limited,
    meta: {
      scanned: sessions.length,
      matched: results.length,
      returned: limited.length,
      // Forward-only field: how many sessions can never match a type/file filter
      // because they were wrapped before CC-5 (drawer labels this honest gap).
      unindexed: _unindexedMeta(sessions)
    }
  };
}

/** Build a single-line snippet window around a match, whitespace-collapsed and
 *  ellipsis-marked when clipped. @returns {string} */
function _snippet(text, idx, qlen, radius = 100) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + qlen + radius);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = `…${s}`;
  if (end < text.length) s = `${s}…`;
  return s;
}

/** JSON.stringify that never throws (circular / exotic input ⇒ ''). */
function _safeStringify(v) {
  try { return JSON.stringify(v) || ''; } catch { return ''; }
}

/** Flatten a tool_result block's `content` (string or array of text blocks) to text. */
function _toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}

/**
 * Extract the searchable text of one transcript line. Returns `{role, text}` for
 * the message-bearing line types and `null` for structural lines (snapshots,
 * attachments, pr-link, …). Built against the observed Claude JSONL shape
 * (verify-api 2026-06-17): assistant text/thinking/tool_use, user string-or-
 * blocks, system content.
 * @param {object} obj - One parsed JSONL line
 * @returns {{role:string, text:string}|null}
 */
function _extractTranscriptText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'system') {
    return { role: 'system', text: typeof obj.content === 'string' ? obj.content : '' };
  }
  if (obj.type === 'user' || obj.type === 'assistant') {
    const msg = obj.message || {};
    const role = msg.role || obj.type;
    const content = msg.content;
    if (typeof content === 'string') return { role, text: content };
    if (!Array.isArray(content)) return { role, text: '' };
    const parts = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push(b.thinking);
      else if (b.type === 'tool_use') parts.push(`${b.name || ''} ${_safeStringify(b.input)}`.trim());
      else if (b.type === 'tool_result') parts.push(_toolResultText(b.content));
    }
    return { role, text: parts.join('\n') };
  }
  return null;
}

/**
 * Cold-tier drill-down: deep-search inside ONE session's raw transcript
 * (`sessions/<sid>/transcript.jsonl`, CC-4b). Streams the JSONL line-by-line
 * (bounded memory), extracts searchable text per line, and returns excerpts with
 * role + timestamp + line number. Surfaces the transcript's secret flag from the
 * meta envelope so the UI can warn before showing content (pattern types only,
 * never values). Honest stub for non-Claude harnesses (only the Claude payload
 * is stored) and for sessions with no captured transcript. Never throws.
 *
 * @param {string} projectPath - Absolute project root
 * @param {string|number} sid - Session id
 * @param {string} query - Case-insensitive substring (empty ⇒ availability probe only)
 * @param {object} [opts]
 * @param {number} [opts.cap] - Max excerpts before `truncated` (default TRANSCRIPT_EXCERPT_CAP)
 * @returns {Promise<{available:boolean, reason:string|null, harness:string|null,
 *   secretsFlagged:boolean, secretTypes:string[], excerpts:Array<{role:string,
 *   timestamp:string|null, lineNo:number, snippet:string}>, truncated:boolean,
 *   scannedLines:number}>}
 */
function searchTranscript(projectPath, sid, query, opts = {}) {
  return new Promise((resolveP) => {
    const o = opts || {};
    const cap = Number.isFinite(o.cap) && o.cap > 0 ? o.cap : TRANSCRIPT_EXCERPT_CAP;
    const meta = readTranscriptMeta(projectPath, sid);
    const result = {
      available: false,
      reason: null,
      harness: meta ? (meta.harness || null) : null,
      secretsFlagged: meta ? !!meta.secretsFlagged : false,
      secretTypes: meta && Array.isArray(meta.secretTypes) ? meta.secretTypes : [],
      excerpts: [],
      truncated: false,
      scannedLines: 0
    };

    // Only the Claude payload is snapshotted (CC-4b); other harnesses are stubs.
    if (meta && meta.harness && meta.harness !== 'claude') {
      result.reason = `no transcript for harness '${meta.harness}'`;
      resolveP(result);
      return;
    }

    const file = path.join(sessionDir(projectPath, sid), TRANSCRIPT_FILENAME);
    if (!fs.existsSync(file)) {
      result.reason = 'no transcript captured';
      resolveP(result);
      return;
    }
    result.available = true;

    const q = (query || '').trim().toLowerCase();
    if (!q) { resolveP(result); return; } // availability probe only

    let stream;
    try {
      stream = fs.createReadStream(file, 'utf8');
    } catch (err) {
      // A read failure is NOT a clean no-match — record a distinct reason so the
      // operator isn't shown "no results" for an I/O error.
      result.reason = 'transcript read error';
      log.warn('Transcript read failed', { projectPath, sid, error: err.message });
      resolveP(result);
      return;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    rl.on('line', (line) => {
      lineNo++;
      if (result.excerpts.length >= cap) { result.truncated = true; return; }
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      const ex = _extractTranscriptText(obj);
      if (!ex || !ex.text) return;
      const scanText = ex.text.length > MAX_TRANSCRIPT_LINE_SCAN
        ? ex.text.slice(0, MAX_TRANSCRIPT_LINE_SCAN) : ex.text;
      const idx = scanText.toLowerCase().indexOf(q);
      if (idx === -1) return;
      result.excerpts.push({
        role: ex.role,
        timestamp: obj.timestamp || null,
        lineNo,
        snippet: _snippet(scanText, idx, q.length)
      });
    });
    rl.on('close', () => { result.scannedLines = lineNo; resolveP(result); });
    stream.on('error', (err) => {
      // Mid-stream error: keep any excerpts gathered, but flag the partial read.
      result.scannedLines = lineNo;
      result.reason = result.reason || 'transcript read error';
      log.warn('Transcript stream error during search', { projectPath, sid, error: err.message });
      resolveP(result);
    });
  });
}

/**
 * Project-wide cold transcript search (CC-5, operator-requested fold-in). Greps
 * EVERY session's captured transcript in THIS project at once — the direct
 * "search my old transcripts" path that doesn't require finding the session via
 * its summary first. Honors the same five filters (to narrow which sessions get
 * searched) and returns the same per-session result shape as `searchSessions`,
 * with transcript excerpts mapped into `hits` so the drawer renders them
 * uniformly (highlighting included). Scoped to `projectPath` by construction —
 * the store is per-project. Cheap because this is text grep over files, never
 * loading a transcript into an LLM context. Never throws.
 *
 * @param {string} projectPath - Absolute project root
 * @param {string} query - Case-insensitive substring (empty ⇒ no excerpts)
 * @param {object} [opts] - Same filters as `searchSessions`, plus `cap`/`limit`
 * @returns {Promise<{sessions:Array<object>, meta:object}>}
 */
async function searchProjectTranscripts(projectPath, query, opts = {}) {
  const o = opts || {};
  const all = listSessions(projectPath);
  const filtered = all.filter(_buildSessionFilter(o));
  const candidates = filtered.filter((s) => s.hasTranscript);
  const q = (query || '').trim();

  let results = [];
  if (q) {
    // Stream transcripts in bounded batches so a project with many wrapped
    // sessions can't open an unbounded number of file descriptors at once.
    const searched = [];
    for (let i = 0; i < candidates.length; i += TRANSCRIPT_SEARCH_CONCURRENCY) {
      const batch = candidates.slice(i, i + TRANSCRIPT_SEARCH_CONCURRENCY);
      const part = await Promise.all(batch.map((s) =>
        searchTranscript(projectPath, s.sid, q, { cap: o.cap }).then((r) => ({ s, r }))
      ));
      searched.push(...part);
    }
    results = searched
      .filter(({ r }) => r.available && r.excerpts.length)
      .map(({ s, r }) => ({
        ...s,
        // Shape excerpts as `hits` (source 'transcript', role+timestamp as the
        // location tag) so renderHistoryResults treats them like warm hits.
        hits: r.excerpts.map((e) => ({
          source: 'transcript',
          section: `${e.role}${e.timestamp ? ` · ${e.timestamp}` : ''}`,
          line: e.snippet
        })),
        matchCount: r.excerpts.length,
        truncated: r.truncated
      }));
  }

  results.sort(_byRecencyMatchSid);

  const limit = Number.isFinite(o.limit) ? o.limit : 0;
  const limited = limit > 0 ? results.slice(0, limit) : results;
  return {
    sessions: limited,
    meta: {
      scope: 'transcripts',
      scanned: all.length,
      withTranscript: candidates.length,
      matched: results.length,
      returned: limited.length,
      unindexed: _unindexedMeta(all)
    }
  };
}

module.exports = {
  storeDir,
  indexPath,
  renderIndex,
  parseIndex,
  writeIndex,
  readIndex,
  readIndexRaw,
  updateMap,
  MAP_EMPTY,
  // CC-2 — warm tier
  WRAP_SECTIONS,
  effectiveWrapSections,
  changelogPath,
  wrapsDir,
  wrapSummaryPath,
  renderChangelogEntry,
  appendChangelogEntry,
  renderWrapSummary,
  parseWrapSummary,
  writeWrapSummary,
  readWrapSummary,
  search,
  // CC-4 — consolidated per-project store (session-linked cold tier)
  sessionsRoot,
  sessionDir,
  sessionUploadsDir,
  // CC-5 — operator-facing cross-session search
  listSessions,
  searchSessions,
  searchTranscript,
  searchProjectTranscripts,
  readTranscriptMeta,
  TRANSCRIPT_FILENAME,
  TRANSCRIPT_META_FILENAME
};
