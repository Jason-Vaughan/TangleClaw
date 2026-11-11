'use strict';

/**
 * v6 (#2989, V6-18 / E6a, Car V60-T3-W1-C): build-time & on-demand report
 * search indexer, producing a `report-search-index.json` shape, plus a
 * deterministic "Ask This Report" lexical citation drawer.
 *
 * Reuses `lib/v6/sprint-report-validator-v3.js`'s own exported
 * `extractSection`/`toPlainText`/`extractCitations`/`CANONICAL_SECTIONS`
 * (a public contract this car reads, never edits) rather than a second,
 * slightly-different HTML parser over the same report shape E4
 * (`lib/v6/e4-rich-report-presentation.js`, same car) also builds on.
 *
 * "Deterministic... without LLM hallucination" (#2989 deliverable 1) means
 * exactly what it says: {@link citeThisReport} never generates text. Every
 * result is a VERBATIM substring of the indexed section's own plain text,
 * located by case-insensitive token/substring matching, carrying the
 * section's own anchor link (`#<sectionId>`) -- there is no model call
 * anywhere in this module.
 *
 * NOT in this car's envelope (no `server.js`/`public/` files here): the
 * actual citation-drawer DOM and wiring a real report's live file path
 * into an HTTP route (writing `report-search-index.json` to disk at report-
 * build time) — Wave 2's routes car, per the Train 3 Wave 1 dispatch. This
 * module builds the index and answers a query purely in-memory.
 *
 * @module lib/v6/e6a-report-search-indexer
 */

const { extractSection, toPlainText, extractCitations, CANONICAL_SECTIONS } = require('./sprint-report-validator-v3');

/** `report-search-index.json`'s own schema version, bumped only on a breaking shape change. */
const INDEX_SCHEMA_VERSION = '1.0.0';

/** Case-insensitive, punctuation-stripped word split -- deterministic and locale-independent (no stemming, no stopword removal: a lexical index is exact-recall, not approximate). */
function _tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
}

/**
 * The first heading-ish line of a section's plain text, as its human
 * display heading -- a report's own sections carry no separate `<h2>` this
 * contract requires (`docs/SPRINT_REPORT_CONTRACT.md` only names `<section
 * id="...">`), so this falls back to a title-cased section id when the
 * section's text has nothing heading-shaped at its start.
 * @param {string} sectionId
 * @param {string} plainText
 * @returns {string}
 */
function _headingFor(sectionId, plainText) {
  const firstLine = plainText.split(/(?<=[.!?])\s+/)[0] || '';
  if (firstLine && firstLine.length <= 80) return firstLine.trim();
  return sectionId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build `report-search-index.json`'s content for one report (#2989
 * deliverable 1): every canonical section's anchor, heading, plain text,
 * and token set, plus every citation the report makes anywhere.
 * @param {string} html - A full report document's raw HTML.
 * @param {{version?: string}} [options] - `version` is this report's own
 *   version/range string (e.g. `v5.72.0` or `v5.57.0-v5.61.0`), carried
 *   through verbatim for the index's own identity; omitted when the caller
 *   has not resolved it yet.
 * @returns {{schemaVersion: string, version: string|null, generatedAt: string,
 *   sections: Array<{id: string, anchor: string, heading: string, text: string, tokens: string[]}>,
 *   citations: Array<{label: string, issue: number}>}}
 */
function buildSearchIndex(html, { version = null, now = () => new Date().toISOString() } = {}) {
  const sections = CANONICAL_SECTIONS.map((id) => {
    const fragment = extractSection(html, id);
    const text = toPlainText(fragment);
    return {
      id,
      anchor: `#${id}`,
      heading: _headingFor(id, text),
      text,
      tokens: Array.from(new Set(_tokenize(text)))
    };
  });

  // Deduplicated by ISSUE NUMBER alone, keeping the first label encountered
  // -- extractCitations' own label capture is greedy back to the start of
  // its enclosing sentence, so the SAME issue cited in two different
  // sentences can carry two different label strings; this index tracks one
  // entry per issue, not one per label/issue pair.
  const citations = [];
  const seenIssues = new Set();
  for (const id of CANONICAL_SECTIONS) {
    for (const c of extractCitations(extractSection(html, id))) {
      if (seenIssues.has(c.issue)) continue;
      seenIssues.add(c.issue);
      citations.push({ label: c.label, issue: c.issue });
    }
  }

  return { schemaVersion: INDEX_SCHEMA_VERSION, version, generatedAt: now(), sections, citations };
}

/**
 * Score one section against a query's tokens: the count of query tokens
 * that appear (as a substring of any indexed token, so a partial word
 * still matches) plus a bonus for an exact phrase (the whole query,
 * lowercased) appearing verbatim in the section's text -- phrase matches
 * rank above scattered-token matches of the same count.
 * @param {{tokens: string[], text: string}} section
 * @param {string[]} queryTokens
 * @param {string} queryLower
 * @returns {number}
 */
function _score(section, queryTokens, queryLower) {
  let score = 0;
  for (const qt of queryTokens) {
    if (section.tokens.some((t) => t.includes(qt))) score++;
  }
  if (queryLower && section.text.toLowerCase().includes(queryLower)) score += queryTokens.length + 1;
  return score;
}

/**
 * The exact verbatim passage (never a generated summary) surrounding the
 * first match of ANY query token in a section's text, bounded to
 * `contextChars` on each side. Falls back to the section's own leading
 * excerpt when no exact substring match is found (a token-overlap-only
 * hit) -- still verbatim, just not centered on a literal match.
 * @param {string} text
 * @param {string[]} queryTokens
 * @param {number} contextChars
 * @returns {string}
 */
function _passage(text, queryTokens, contextChars) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const qt of queryTokens) {
    const idx = lower.indexOf(qt);
    if (idx !== -1 && (at === -1 || idx < at)) at = idx;
  }
  if (at === -1) return text.length > contextChars * 2 ? `${text.slice(0, contextChars * 2).trimEnd()}…` : text;
  const start = Math.max(0, at - contextChars);
  const end = Math.min(text.length, at + contextChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/**
 * The deterministic "Ask This Report" lexical citation drawer (#2989
 * deliverable 2): ranks every indexed section by lexical overlap with
 * `query`, returning each match's exact cited passage and section anchor
 * link, highest-scoring first. Never calls a model; every passage is a
 * verbatim substring of the report's own indexed text.
 * @param {{sections: Array<object>}} index - From {@link buildSearchIndex}.
 * @param {string} query
 * @param {{limit?: number, contextChars?: number}} [options]
 * @returns {Array<{sectionId: string, anchor: string, heading: string, passage: string, score: number}>}
 */
function citeThisReport(index, query, { limit = 5, contextChars = 160 } = {}) {
  const queryLower = String(query || '').trim().toLowerCase();
  const queryTokens = _tokenize(queryLower);
  if (queryTokens.length === 0) return [];

  const ranked = index.sections
    .map((section) => ({ section, score: _score(section, queryTokens, queryLower) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, limit).map(({ section, score }) => ({
    sectionId: section.id,
    anchor: section.anchor,
    heading: section.heading,
    passage: _passage(section.text, queryTokens, contextChars),
    score
  }));
}

module.exports = {
  INDEX_SCHEMA_VERSION,
  buildSearchIndex,
  citeThisReport
};
