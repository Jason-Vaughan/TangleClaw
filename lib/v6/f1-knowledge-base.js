'use strict';

/**
 * v6.1 (#2997, V6-27 / F1, Car V61-W1-C): the built-in, version-aware
 * searchable knowledge base and contextual help — the selective-retrieval
 * core behind `GET /api/docs/search` (P27 `11bfd8ed4c32`; reference contract
 * in the Phase 4 `kb-search` module), replacing startup prompt stuffing with
 * a bounded fetch of only the sections a question needs.
 *
 * Built on #811's manual rather than beside it: `docs/manual-manifest.json`
 * (`lib/product-manual.js`) already names every page, its audience, its
 * stable section anchors (GitHub's own slug rule, `extractHeadings`) and the
 * code surfaces it documents. This module turns that manifest plus the
 * pages' Markdown into an in-memory snapshot of addressable sections, then
 * answers three questions over it:
 *
 * - {@link search} — lexical, deterministic, filter-before-rank (audience
 *   is applied before anything is scored, so a section the caller may not
 *   read is never a candidate) and bounded by a token budget no larger than
 *   4096. Every result carries a stable `pageId#anchor` citation and the
 *   version it was read from.
 * - {@link contextualHelp} — the sections whose page documents a given
 *   surface (a UI file, a route module), via `findStaleSurfaces`' own glob
 *   rule, so a settings screen can show the settings reference.
 * - {@link getSection} — one cited section, re-checking audience on the
 *   fetch rather than trusting that a citation came from a permitted search.
 *
 * Version-aware means each snapshot is built for one TangleClaw version and
 * a knowledge base may hold several. A request names the version it wants;
 * it gets that snapshot exactly, or the nearest older one with
 * `usedFallback: true` — the same explicit-fallback rule
 * `lib/doc-router.js#resolveTopic` already uses — and never a newer one,
 * which could describe behaviour the caller's version does not have.
 *
 * Pure and in-memory: no filesystem reads (callers pass page text), no
 * store, no HTTP. Mounting `GET /api/docs/search` and the in-product reader
 * is Wave 2's routes car (`Car V61-W2-ROUTES`), which owns `server.js` and
 * `public/v6-shell.js`.
 *
 * @module lib/v6/f1-knowledge-base
 */

const productManual = require('../product-manual');
const { compareSemver } = require('../doc-router');

/** Search result schema id. */
const SEARCH_SCHEMA = 'tc.kb-search/v1';

/** The token budget ceiling a single retrieval may ask for (Phase 4 `kb-search` contract). */
const MAX_BUDGET_TOKENS = 4096;

/** Query bounds (Phase 4 `kb-search` contract): 1..12 distinct terms, at most 160 characters. */
const MAX_QUERY_TERMS = 12;
const MAX_QUERY_CHARS = 160;

/** A `MAJOR.MINOR.PATCH` version. */
const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Rough token estimate, four characters per token rounded up — the same rule
 * the Phase 4 reference contract and `lib/v6/e6b-report-narrative-synthesizer.js` use.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

/**
 * Distinct lowercase alphanumeric terms of a string.
 * @param {string} s
 * @returns {string[]}
 */
function _terms(s) {
  return [...new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) || [])];
}

/**
 * Whole-word occurrences of `word` in already-lowercased `text`.
 * @param {string} text
 * @param {string} word - Alphanumeric only, so it needs no regex escaping.
 * @returns {number}
 */
function _count(text, word) {
  return (text.match(new RegExp(`\\b${word}\\b`, 'g')) || []).length;
}

/**
 * Split one page's Markdown into sections at every heading of level
 * `sectionDepth` or shallower, each with the anchor `extractHeadings`
 * assigns. A section's text runs to the next such heading; deeper headings
 * stay inside it. Lines inside fenced code blocks are never headings, by
 * the same fence rule `extractHeadings` applies.
 * @param {string} markdown
 * @param {number} sectionDepth
 * @returns {Array<{anchor: string, heading: string, level: number, text: string}>}
 */
function sectionsOf(markdown, sectionDepth = 2) {
  const headings = productManual.extractHeadings(markdown);
  const lines = markdown.split('\n');
  // Locate each heading's line by replaying extractHeadings' own scan, so
  // the anchors (including repeated-heading `-1` suffixes) are exactly its.
  const positions = [];
  let fence = null;
  let h = 0;
  lines.forEach((line, i) => {
    const fenceMatch = /^(```+|~~~+)/.exec(line.trim());
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (line.trim()[0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    if (/^(#{1,6})\s+(.+?)\s*$/.test(line)) positions.push({ line: i, ...headings[h++] });
  });

  const cuts = positions.filter((p) => p.level <= sectionDepth);
  return cuts.map((p, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1].line : lines.length;
    const text = lines.slice(p.line + 1, end).join('\n').trim();
    return { anchor: p.anchor, heading: p.text, level: p.level, text };
  });
}

/**
 * Build one version's snapshot from a validated manual manifest and its
 * pages' Markdown. A page whose text was not supplied is reported in
 * `missingPages`, never silently indexed as empty.
 * @param {object} manifest - A `tc.manual-manifest/v1` document; validated here.
 * @param {Record<string, string>} contentsByPath - Repo-relative page path -> Markdown.
 * @param {string} version - The TangleClaw version these pages describe, `MAJOR.MINOR.PATCH`.
 * @returns {{version: string, sections: Array<object>, pages: Array<object>, missingPages: string[], corpusTokens: number}}
 * @throws {TypeError} When `version` is malformed.
 * @throws {import('../product-manual').ProductManualError} When the manifest is invalid.
 */
function buildSnapshot(manifest, contentsByPath, version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) throw new TypeError('version must be MAJOR.MINOR.PATCH');
  productManual.validateManualManifest(manifest);
  const sections = [];
  const pages = [];
  const missingPages = [];
  for (const page of manifest.pages) {
    const markdown = contentsByPath && contentsByPath[page.path];
    if (typeof markdown !== 'string') {
      missingPages.push(page.id);
      continue;
    }
    pages.push({ id: page.id, path: page.path, title: page.title, audience: [...page.audience], surfaces: [...page.surfaces] });
    for (const s of sectionsOf(markdown, page.sectionDepth || 2)) {
      sections.push({
        citation: `${page.id}#${s.anchor}`,
        pageId: page.id,
        pageTitle: page.title,
        path: page.path,
        anchor: s.anchor,
        heading: s.heading,
        text: s.text,
        audience: [...page.audience],
        version
      });
    }
  }
  const corpusTokens = sections.reduce((n, s) => n + estimateTokens(s.text), 0);
  return { version, sections, pages, missingPages, corpusTokens };
}

/**
 * A knowledge base: one or more version snapshots, newest first.
 * @param {Array<ReturnType<typeof buildSnapshot>>} snapshots
 * @returns {{snapshots: Array<object>}}
 * @throws {TypeError} When empty or when two snapshots share a version.
 */
function createKnowledgeBase(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) throw new TypeError('at least one snapshot is required');
  const seen = new Set();
  for (const s of snapshots) {
    if (!s || typeof s.version !== 'string' || !SEMVER.test(s.version) || !Array.isArray(s.sections)) {
      throw new TypeError('every snapshot must come from buildSnapshot');
    }
    if (seen.has(s.version)) throw new TypeError(`version ${s.version} has two snapshots`);
    seen.add(s.version);
  }
  return { snapshots: [...snapshots].sort((a, b) => compareSemver(b.version, a.version)) };
}

/**
 * The snapshot that answers for `version`: exact, else the nearest older
 * one. A version older than every snapshot has no answer; a newer snapshot
 * is never substituted, since it may document behaviour that version lacks.
 * Omitting `version` selects the newest snapshot.
 * @param {{snapshots: Array<object>}} kb
 * @param {string} [version]
 * @returns {{ok: true, snapshot: object, usedFallback: boolean}|{ok: false, code: string, reason: string}}
 */
function resolveSnapshot(kb, version) {
  if (version === undefined || version === null) return { ok: true, snapshot: kb.snapshots[0], usedFallback: false };
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    return { ok: false, code: 'VERSION_INVALID', reason: 'version must be MAJOR.MINOR.PATCH' };
  }
  const match = kb.snapshots.find((s) => compareSemver(s.version, version) <= 0);
  if (!match) return { ok: false, code: 'VERSION_NOT_COVERED', reason: `no documentation snapshot is as old as ${version}` };
  return { ok: true, snapshot: match, usedFallback: match.version !== version };
}

/**
 * Check the shared retrieval context: audience and budget.
 * @param {{audience?: string, budgetTokens?: number}} ctx
 * @returns {{ok: true}|{ok: false, code: string, reason: string}}
 */
function _checkContext(ctx) {
  if (!ctx || !productManual.AUDIENCES.includes(ctx.audience)) {
    return { ok: false, code: 'AUDIENCE_INVALID', reason: `audience must be one of ${productManual.AUDIENCES.join(', ')}` };
  }
  if (!Number.isSafeInteger(ctx.budgetTokens) || ctx.budgetTokens < 1 || ctx.budgetTokens > MAX_BUDGET_TOKENS) {
    return { ok: false, code: 'BUDGET_INVALID', reason: `budgetTokens must be a whole number from 1 to ${MAX_BUDGET_TOKENS}` };
  }
  return { ok: true };
}

/**
 * Pack ranked sections into a token budget. A section larger than what is
 * left is cut to fit and marked `truncated`; one whose citation header alone
 * no longer fits is skipped and counted in `omittedForBudget`.
 * @param {Array<{section: object, score: number}>} ranked
 * @param {number} budgetTokens
 * @returns {{results: Array<object>, usedTokens: number, omittedForBudget: number}}
 */
function _pack(ranked, budgetTokens) {
  const results = [];
  let usedTokens = 0;
  let omittedForBudget = 0;
  for (const { section, score } of ranked) {
    const header = `${section.citation} — ${section.heading}\n`;
    const remaining = budgetTokens - usedTokens - estimateTokens(header);
    if (remaining < 1) {
      omittedForBudget++;
      continue;
    }
    const maxChars = remaining * 4;
    const text = section.text.length <= maxChars ? section.text : section.text.slice(0, maxChars);
    usedTokens += estimateTokens(header) + estimateTokens(text);
    results.push({
      citation: section.citation,
      pageId: section.pageId,
      pageTitle: section.pageTitle,
      path: section.path,
      anchor: section.anchor,
      heading: section.heading,
      version: section.version,
      score,
      text,
      truncated: text.length < section.text.length
    });
  }
  return { results, usedTokens, omittedForBudget };
}

/**
 * Search the knowledge base (#2997's selective retrieval). Sections the
 * caller's audience may not read are dropped before scoring. Scoring is
 * lexical: a term in the page title or section heading weighs 5, a term in
 * the body up to 3, and the whole query appearing as a phrase adds 4. Ties
 * break by citation, so the same query always returns the same bytes.
 * @param {{snapshots: Array<object>}} kb
 * @param {string} query
 * @param {{audience: 'human'|'nhe', budgetTokens: number, version?: string}} ctx
 * @returns {{ok: true, schema: string, query: string, version: string, usedFallback: boolean,
 *   budgetTokens: number, usedTokens: number, results: Array<object>, omittedForBudget: number,
 *   tokenReduction: {corpusTokens: number, usedTokens: number, ratio: number}}
 *   |{ok: false, code: string, reason: string}}
 */
function search(kb, query, ctx) {
  const context = _checkContext(ctx);
  if (!context.ok) return context;
  const q = _terms(query);
  if (q.length === 0 || q.length > MAX_QUERY_TERMS || String(query).length > MAX_QUERY_CHARS) {
    return { ok: false, code: 'QUERY_INVALID', reason: `a query is 1 to ${MAX_QUERY_TERMS} terms and at most ${MAX_QUERY_CHARS} characters` };
  }
  const resolved = resolveSnapshot(kb, ctx.version);
  if (!resolved.ok) return resolved;
  const { snapshot, usedFallback } = resolved;

  const phrase = q.join(' ');
  const readable = snapshot.sections.filter((s) => s.audience.includes(ctx.audience));
  const ranked = [];
  for (const section of readable) {
    const title = `${section.pageTitle} ${section.heading}`.toLowerCase();
    const body = section.text.toLowerCase();
    let score = 0;
    for (const word of q) score += 5 * Math.min(1, _count(title, word)) + Math.min(3, _count(body, word));
    if (q.length > 1 && body.includes(phrase)) score += 4;
    if (score > 0) ranked.push({ section, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.section.citation.localeCompare(b.section.citation));

  const packed = _pack(ranked, ctx.budgetTokens);
  const corpusTokens = readable.reduce((n, s) => n + estimateTokens(s.text), 0);
  return {
    ok: true,
    schema: SEARCH_SCHEMA,
    query: String(query),
    version: snapshot.version,
    usedFallback,
    budgetTokens: ctx.budgetTokens,
    usedTokens: packed.usedTokens,
    results: packed.results,
    omittedForBudget: packed.omittedForBudget,
    tokenReduction: {
      corpusTokens,
      usedTokens: packed.usedTokens,
      ratio: corpusTokens === 0 ? 0 : Number((1 - packed.usedTokens / corpusTokens).toFixed(4))
    }
  };
}

/**
 * Contextual help for a surface: the sections of every page that documents
 * it, in page then document order, packed into the budget. A surface is a
 * repo-relative path (`public/settings.js`, `lib/engines.js`), matched
 * against each page's declared `surfaces` globs by #811's own rule.
 * @param {{snapshots: Array<object>}} kb
 * @param {string} surface
 * @param {{audience: 'human'|'nhe', budgetTokens: number, version?: string}} ctx
 * @returns {{ok: true, surface: string, version: string, usedFallback: boolean, pages: string[],
 *   usedTokens: number, results: Array<object>, omittedForBudget: number}|{ok: false, code: string, reason: string}}
 */
function contextualHelp(kb, surface, ctx) {
  const context = _checkContext(ctx);
  if (!context.ok) return context;
  if (typeof surface !== 'string' || surface.length === 0 || surface.startsWith('/') || surface.split('/').includes('..')) {
    return { ok: false, code: 'SURFACE_INVALID', reason: 'a surface is a repo-relative path' };
  }
  const resolved = resolveSnapshot(kb, ctx.version);
  if (!resolved.ok) return resolved;
  const { snapshot, usedFallback } = resolved;

  const matched = productManual.findStaleSurfaces({ pages: snapshot.pages }, [surface]);
  const pageIds = snapshot.pages.filter((p) => matched[p.id] && p.audience.includes(ctx.audience)).map((p) => p.id);
  const ranked = snapshot.sections
    .filter((s) => pageIds.includes(s.pageId) && s.audience.includes(ctx.audience))
    .map((section) => ({ section, score: 0 }));
  const packed = _pack(ranked, ctx.budgetTokens);
  return {
    ok: true,
    surface,
    version: snapshot.version,
    usedFallback,
    pages: pageIds,
    usedTokens: packed.usedTokens,
    results: packed.results,
    omittedForBudget: packed.omittedForBudget
  };
}

/**
 * Fetch one cited section, whole. Audience is checked again here: a
 * citation is an address, not a permission.
 * @param {{snapshots: Array<object>}} kb
 * @param {string} citation - `pageId#anchor`.
 * @param {{audience: 'human'|'nhe', version?: string}} ctx
 * @returns {{ok: true, section: object, version: string, usedFallback: boolean}|{ok: false, code: string, reason: string}}
 */
function getSection(kb, citation, ctx) {
  if (!ctx || !productManual.AUDIENCES.includes(ctx.audience)) {
    return { ok: false, code: 'AUDIENCE_INVALID', reason: `audience must be one of ${productManual.AUDIENCES.join(', ')}` };
  }
  const resolved = resolveSnapshot(kb, ctx.version);
  if (!resolved.ok) return resolved;
  const section = resolved.snapshot.sections.find((s) => s.citation === citation);
  // Not-found and not-permitted answer alike, so a citation cannot be used
  // to probe for sections the caller may not read.
  if (!section || !section.audience.includes(ctx.audience)) {
    return { ok: false, code: 'SECTION_NOT_FOUND', reason: `no section ${String(citation)} in version ${resolved.snapshot.version}` };
  }
  const out = { ...section };
  delete out.audience;
  return { ok: true, section: out, version: resolved.snapshot.version, usedFallback: resolved.usedFallback };
}

module.exports = {
  SEARCH_SCHEMA,
  MAX_BUDGET_TOKENS,
  sectionsOf,
  buildSnapshot,
  createKnowledgeBase,
  resolveSnapshot,
  search,
  contextualHelp,
  getSection
};
