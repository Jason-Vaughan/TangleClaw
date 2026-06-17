'use strict';

/**
 * Continuity store (CC-1) — the per-project "hot tier" of the Continuity
 * Contract (`.claude/plans/continuity-contract.md`). This is the thin
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
const { createLogger } = require('./logger');

const log = createLogger('continuity');

const STORE_SUBDIR = '.tangleclaw';
const STORE_LEAF = 'continuity';
const INDEX_FILENAME = 'index.md';
const CHANGELOG_FILENAME = 'changelog.md';
const WRAPS_LEAF = 'wraps';

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
 * @param {object} [fields.freshness] - Verify-before-trusting stamp
 * @param {string} [fields.freshness.sha] - HEAD short sha at write time
 * @param {string} [fields.freshness.branch] - Branch at write time
 * @param {string} [fields.freshness.writtenAt] - ISO date (YYYY-MM-DD)
 * @returns {string} Markdown document
 */
function renderIndex(fields = {}) {
  const f = fields || {};
  const fresh = f.freshness || {};
  const currentState = (f.currentState || '').trim();
  const nextAction = (f.nextAction || '').trim();

  const lines = [];
  lines.push(`# Continuity Index${f.project ? ` — ${f.project}` : ''}`);
  lines.push('');
  lines.push('## Current state');
  lines.push(currentState || '_⚠ not captured this wrap_');
  lines.push('');
  lines.push('## Next action');
  lines.push(nextAction || '_⚠ not captured this wrap_');
  lines.push('');
  lines.push('## Freshness');
  lines.push(`- written-at: ${(fresh.writtenAt || '').trim() || 'unknown'}`);
  lines.push(`- sha: ${(fresh.sha || '').trim() || 'unknown'}`);
  lines.push(`- branch: ${(fresh.branch || '').trim() || 'unknown'}`);
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
 * @returns {{currentState:string, nextAction:string, freshness:{sha:string, branch:string, writtenAt:string}}}
 */
function parseIndex(text) {
  const out = {
    currentState: '',
    nextAction: '',
    freshness: { sha: '', branch: '', writtenAt: '' }
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

  const freshBlock = sections['freshness'] || '';
  out.freshness.writtenAt = _bullet(freshBlock, 'written-at');
  out.freshness.sha = _bullet(freshBlock, 'sha');
  out.freshness.branch = _bullet(freshBlock, 'branch');

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
 * @returns {string} A single entry (no trailing newline)
 */
function renderChangelogEntry(fields = {}) {
  const f = fields || {};
  const date = (f.date || '').trim() || 'unknown';
  const sid = String(f.sid == null ? '' : f.sid).trim() || 'unknown';
  const line = (f.line || '').trim() || NOT_CAPTURED;
  const tags = (f.tags || '').trim();
  const refs = (f.refs || '').trim();

  const out = [`- ${date} (session:${sid}) ${line}`];
  if (tags) out.push(`  tags: ${tags}`);
  if (refs) out.push(`  refs: ${refs}`);
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
 * @param {object} [fields.meta] - Frontmatter: session, date, project, methodology, harness, branch, sha, tags
 * @param {object} [fields.sections] - Map of section name → body (keys matched case-insensitively against WRAP_SECTIONS)
 * @returns {string} Markdown document
 */
function renderWrapSummary(fields = {}) {
  const meta = (fields && fields.meta) || {};
  const sections = (fields && fields.sections) || {};

  // Case-insensitive lookup so callers can pass 'where we are' or 'Where we are'.
  const byLower = {};
  for (const [k, v] of Object.entries(sections)) byLower[k.toLowerCase()] = v;

  const metaKeys = ['session', 'date', 'project', 'methodology', 'harness', 'branch', 'sha', 'tags'];
  const lines = ['---'];
  for (const key of metaKeys) {
    const val = meta[key] == null ? '' : String(meta[key]).trim();
    if (val) lines.push(`${key}: ${val}`);
  }
  lines.push('---');

  for (const section of WRAP_SECTIONS) {
    const body = (byLower[section.toLowerCase()] || '').trim();
    lines.push(`## ${section}`);
    lines.push(body || NOT_CAPTURED);
    lines.push('');
  }
  return lines.join('\n');
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

module.exports = {
  storeDir,
  indexPath,
  renderIndex,
  parseIndex,
  writeIndex,
  readIndex,
  // CC-2 — warm tier
  WRAP_SECTIONS,
  changelogPath,
  wrapsDir,
  wrapSummaryPath,
  renderChangelogEntry,
  appendChangelogEntry,
  renderWrapSummary,
  parseWrapSummary,
  writeWrapSummary,
  readWrapSummary,
  search
};
