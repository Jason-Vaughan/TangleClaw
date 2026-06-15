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

module.exports = {
  storeDir,
  indexPath,
  renderIndex,
  parseIndex,
  writeIndex,
  readIndex
};
