'use strict';

/**
 * The indexable product manual (#811): a git-backed manual with two
 * readers, each with a different need —
 *
 * - **A human** wants a table of contents and narrative pages.
 * - **An NHE** (non-human entity: an AI agent) wants stable addressable
 *   chunks and no ambiguity about which section governs a given surface.
 *   It retrieves *fragments*, never the whole page — `FEATURES.md` already
 *   learned this lesson the hard way (`lib/feature-index-prime.js`'s
 *   summarizer replaced inlining the whole file).
 *
 * Two rules follow directly, the first already written down in
 * `FEATURES.md`'s own header:
 * - Address by **stable anchors** (`user-guide#the-landing-page`), never
 *   line numbers — nothing re-verifies a line number, so it rots.
 * - Every page declares the **surface(s)** it documents (as path globs,
 *   the same convention `docs/areas.json` already uses), so parity is
 *   checkable rather than a vibe.
 *
 * `docs/manual-manifest.json` (`tc.manual-manifest/v1`) is the manual's
 * index: one entry per page, each page's declared sections (anchor +
 * heading), and the surfaces it documents. This module is pure logic over
 * that manifest and the docs' own Markdown text — it never fetches, never
 * renders, and (per Architect Ruling A501-W1A-R1) never wires into `tc`,
 * `server.js`, or any UI; that mounting is #2887's Slice 2.
 *
 * The parity mechanism this module serves — "which documented surfaces did
 * this touch, which pages are now stale" — is meant to ride the wrap step
 * that already stubs `FEATURES.md` entries (`lib/wrap-steps/features-toc
 * .js`), not grow a parallel hook. This module supplies the two primitives
 * that wiring needs ({@link verifyManifestParity}, {@link
 * findStaleSurfaces}); it does not call the wrap step itself.
 *
 * The HITL escape #811 asks for (a gap the machine cannot close — a stale
 * screenshot, say — becomes filed work, never silently left stale) is also
 * out of this module's scope: it has no file-watching or issue-filing
 * logic. {@link verifyManifestParity}'s result is what a caller (the wrap
 * step, in a later car) would file a gap FROM.
 *
 * @module lib/product-manual
 */

const fs = require('node:fs');

/** Error for manual-manifest input that does not match this module's contract. */
class ProductManualError extends Error {}

function _need(cond, msg) {
  if (!cond) throw new ProductManualError(msg);
}

/** Schema tag of the manual manifest. */
const SCHEMA = 'tc.manual-manifest/v1';

/** The two readers a page may declare it serves. */
const AUDIENCES = Object.freeze(['human', 'nhe']);

/**
 * Strip inline code spans' backtick markers (keeping their text), the only
 * Markdown inline syntax this repo's headings are observed to use.
 * @param {string} text
 * @returns {string}
 */
function _stripInlineCode(text) {
  return text.replace(/`([^`]*)`/g, '$1');
}

/**
 * A heading's anchor, by the same rule GitHub's own Markdown renderer
 * uses: lowercase, strip anything but letters/digits/underscore/hyphen/
 * space, then turn spaces into hyphens. Best-effort for this repo's plain
 * ASCII headings — not a byte-exact reimplementation of GFM's Unicode
 * handling, which none of this repo's headings exercise.
 * @param {string} text - Heading text, backticks and all.
 * @returns {string}
 */
function slugifyHeading(text) {
  return _stripInlineCode(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Every heading in a Markdown document, in order, each with the anchor
 * GitHub would assign it — including the `-1`, `-2`, … GitHub appends when
 * the same heading text repeats on one page.
 *
 * Tracks fenced code blocks (``` or ~~~) and never reads a line inside one
 * as a heading — a shell comment (`# Check service status`) inside a
 * ```bash fence is not a section, and this repo's own docs have several.
 * @param {string} markdown
 * @returns {Array<{level: number, text: string, anchor: string}>}
 */
function extractHeadings(markdown) {
  const seen = new Map();
  const headings = [];
  let fence = null; // the fence marker (``` or ~~~) currently open, or null
  for (const line of markdown.split('\n')) {
    const fenceMatch = /^(```+|~~~+)/.exec(line.trim());
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]; // remember which character opened it
      else if (line.trim()[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    const text = m[2];
    const base = slugifyHeading(text);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    const anchor = count === 0 ? base : `${base}-${count}`;
    headings.push({ level, text, anchor });
  }
  return headings;
}

/**
 * Compile one path glob to a regex — `**` spans directories, `*` stays
 * within one segment, everything else is literal. Same convention
 * `docs/areas.json`'s own glob paths already use (`test/areas-map.test.js`
 * compiles them identically).
 * @param {string} glob
 * @returns {RegExp}
 */
function _globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else {
      out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

function _needShape(obj, where, required, optional = []) {
  _need(obj !== null && typeof obj === 'object' && !Array.isArray(obj), `${where} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) _need(allowed.has(key), `${where} has unknown key "${key.slice(0, 40)}"`);
  for (const key of required) _need(obj[key] !== undefined, `${where}.${key} is missing`);
}

/**
 * Validate one manifest page.
 * @param {*} page
 * @param {string} where
 * @returns {void}
 */
function _validatePage(page, where) {
  _needShape(page, where, ['id', 'path', 'title', 'audience', 'surfaces', 'sections'], ['sectionDepth']);
  _need(typeof page.id === 'string' && page.id.length > 0, `${where}.id must be a non-empty string`);
  _need(typeof page.path === 'string' && page.path.length > 0, `${where}.path must be a non-empty string`);
  _need(typeof page.title === 'string' && page.title.length > 0, `${where}.title must be a non-empty string`);
  if (page.sectionDepth !== undefined) {
    _need(Number.isInteger(page.sectionDepth) && page.sectionDepth >= 1 && page.sectionDepth <= 6,
      `${where}.sectionDepth must be a heading level from 1 to 6`);
  }
  _need(Array.isArray(page.audience) && page.audience.length > 0 && page.audience.every((a) => AUDIENCES.includes(a)),
    `${where}.audience must be a non-empty array drawn from ${AUDIENCES.join(', ')}`);
  _need(Array.isArray(page.surfaces) && page.surfaces.every((s) => typeof s === 'string' && s.length > 0),
    `${where}.surfaces must be an array of non-empty path globs`);
  _need(Array.isArray(page.sections), `${where}.sections must be an array`);
  const seenAnchors = new Set();
  page.sections.forEach((s, i) => {
    _needShape(s, `${where}.sections[${i}]`, ['anchor', 'heading'], ['summary']);
    _need(typeof s.anchor === 'string' && s.anchor.length > 0, `${where}.sections[${i}].anchor must be a non-empty string`);
    _need(!seenAnchors.has(s.anchor), `${where}.sections[${i}].anchor "${s.anchor}" is declared twice`);
    seenAnchors.add(s.anchor);
    _need(typeof s.heading === 'string' && s.heading.length > 0, `${where}.sections[${i}].heading must be a non-empty string`);
    if (s.summary !== undefined) _need(typeof s.summary === 'string', `${where}.sections[${i}].summary must be a string`);
  });
}

/**
 * Validate a manual manifest document.
 * @param {*} doc
 * @returns {void}
 * @throws {ProductManualError}
 */
function validateManualManifest(doc) {
  _needShape(doc, 'manifest', ['schema', 'pages']);
  _need(doc.schema === SCHEMA, `manifest.schema must be ${SCHEMA}`);
  _need(Array.isArray(doc.pages), 'manifest.pages must be an array');
  const seenIds = new Set();
  doc.pages.forEach((p, i) => {
    _validatePage(p, `manifest.pages[${i}]`);
    _need(!seenIds.has(p.id), `manifest.pages[${i}].id "${p.id}" is declared twice`);
    seenIds.add(p.id);
  });
}

/**
 * Read and validate a manual manifest from disk.
 * @param {string} file
 * @returns {object}
 * @throws {ProductManualError}
 */
function readManualManifest(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ProductManualError(`could not read manual manifest ${file} (${err.code || 'error'})`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new ProductManualError(`manual manifest ${file} is not valid JSON`);
  }
  validateManualManifest(doc);
  return doc;
}

/**
 * Check one page's declared sections against the real headings of its own
 * Markdown text — the structural half of "stays in parity with the code"
 * (the other half, which code surfaces a page covers, is {@link
 * findStaleSurfaces}).
 *
 * A page may declare `sectionDepth` (1-6): headings deeper than that are
 * excluded from `undeclaredHeadings` entirely — the manual indexes down to
 * that level, deliberately, and a sub-point one level deeper is not a
 * parity gap. `missingAnchors` is never filtered by depth: a declared
 * section whose anchor stopped existing is stale regardless of its level.
 * @param {object} page - A validated manifest page.
 * @param {string} markdown - The page's own file contents.
 * @returns {{ok: boolean, missingAnchors: string[], undeclaredHeadings: Array<{anchor:string, heading:string}>}}
 *   `missingAnchors`: declared sections whose anchor no longer matches any
 *   real heading (the doc moved or removed that section — the manifest is
 *   stale). `undeclaredHeadings`: real headings the manifest never
 *   declared (the doc grew a section the manual doesn't know about yet).
 */
function verifyPageParity(page, markdown) {
  const allHeadings = extractHeadings(markdown);
  const realAnchors = new Set(allHeadings.map((h) => h.anchor));
  const declaredAnchors = new Set(page.sections.map((s) => s.anchor));
  const missingAnchors = page.sections.map((s) => s.anchor).filter((a) => !realAnchors.has(a));
  const depth = page.sectionDepth || 6;
  const undeclaredHeadings = allHeadings
    .filter((h) => h.level <= depth)
    .filter((h) => !declaredAnchors.has(h.anchor));
  return { ok: missingAnchors.length === 0 && undeclaredHeadings.length === 0, missingAnchors, undeclaredHeadings };
}

/**
 * {@link verifyPageParity}, for every page in a manifest.
 * @param {object} manifest - A validated manual manifest.
 * @param {Object<string, string>} fileContentsByPath - Each page's `path` → its current file contents.
 * @returns {{ok: boolean, pages: Object<string, {ok:boolean, missingAnchors:string[], undeclaredHeadings:Array, missingFile?:boolean}>}}
 */
function verifyManifestParity(manifest, fileContentsByPath) {
  const pages = {};
  let ok = true;
  for (const page of manifest.pages) {
    const markdown = fileContentsByPath[page.path];
    if (markdown === undefined) {
      pages[page.id] = { ok: false, missingAnchors: [], undeclaredHeadings: [], missingFile: true };
      ok = false;
      continue;
    }
    const result = verifyPageParity(page, markdown);
    pages[page.id] = result;
    if (!result.ok) ok = false;
  }
  return { ok, pages };
}

/**
 * Which manifest pages document a surface that a set of changed paths
 * touches — "which documented surfaces did this touch, which pages are
 * now stale," #811's own framing of the parity pass.
 * @param {object} manifest - A validated manual manifest.
 * @param {string[]} changedPaths - Repo-relative paths that changed.
 * @returns {Object<string, string[]>} Page id → the surface glob(s) of its own that matched, for pages with at least one match.
 */
function findStaleSurfaces(manifest, changedPaths) {
  const stale = {};
  for (const page of manifest.pages) {
    const matched = page.surfaces.filter((glob) => {
      const re = _globToRegExp(glob);
      return changedPaths.some((p) => re.test(p));
    });
    if (matched.length > 0) stale[page.id] = matched;
  }
  return stale;
}

/**
 * The human table of contents: every page's id, title and section headings,
 * in manifest order — the "narrative, with a table of contents" half of
 * the dual-audience requirement.
 * @param {object} manifest - A validated manual manifest.
 * @returns {Array<{id:string, path:string, title:string, sections:Array<{anchor:string, heading:string}>}>}
 */
function listPages(manifest) {
  return manifest.pages.map((p) => ({
    id: p.id,
    path: p.path,
    title: p.title,
    sections: p.sections.map((s) => ({ anchor: s.anchor, heading: s.heading }))
  }));
}

/**
 * Resolve a stable reference — `"<pageId>"` or `"<pageId>#<anchor>"` — to
 * the one fragment it names, never the whole page: the NHE retrieval
 * interface.
 * @param {object} manifest - A validated manual manifest.
 * @param {string} ref - `"user-guide"` or `"user-guide#the-landing-page"`.
 * @returns {{found: true, page: object, section?: object} | {found: false, reason: string}}
 */
function resolveAnchor(manifest, ref) {
  const [pageId, anchor] = ref.split('#');
  const page = manifest.pages.find((p) => p.id === pageId);
  if (!page) return { found: false, reason: `no page with id "${pageId}"` };
  if (anchor === undefined) return { found: true, page };
  const section = page.sections.find((s) => s.anchor === anchor);
  if (!section) return { found: false, reason: `page "${pageId}" has no section anchored "${anchor}"` };
  return { found: true, page, section };
}

module.exports = {
  ProductManualError,
  SCHEMA,
  AUDIENCES,
  slugifyHeading,
  extractHeadings,
  validateManualManifest,
  readManualManifest,
  verifyPageParity,
  verifyManifestParity,
  findStaleSurfaces,
  listPages,
  resolveAnchor,
  _internal: { globToRegExp: _globToRegExp }
};
