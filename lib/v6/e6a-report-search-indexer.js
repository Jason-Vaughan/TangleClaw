'use strict';

/**
 * v6 (#2989, V6-18 / E6a, Car V60-T3-W1-C): build-time & on-demand report
 * search indexer, producing a `report-search-index.json` shape, plus a
 * deterministic "Ask This Report" lexical citation drawer.
 *
 * Reuses `lib/v6/sprint-report-validator-v3.js`'s own exported
 * `extractSection`/`toPlainText`/`CANONICAL_SECTIONS`
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
 * Three chunk kinds are indexed (Ruling A594-PR3018-R1-HOLD-RECONCILED, per
 * #2989 Deliverables 1 & 2's own "[Section NN]", "[PR #NNNN]", "[KR-ID]"
 * citation shapes): a `section` chunk per canonical section (whole-section
 * text); a `pr` chunk per `PR #NNNN` / bare `#NNNN` occurrence, anchored to
 * the section it appears in; a `kaizen` chunk per `KR-...`/`KAIZEN-...`
 * occurrence, same anchoring. `citeThisReport` ranks across all three and
 * returns each hit's `type` plus its formatted citation badge.
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

/** A `PR #NNNN` mention, or a bare `#NNNN` standing alone -- the "PR #NNNN / #NNNN" shape #2989's dispatch names. */
const PR_PATTERN = /(?:\bPR\s*)?#(\d+)\b/gi;

/** A `KR-...` or `KAIZEN-...` token (case-insensitive), e.g. `KR-01`. */
const KAIZEN_PATTERN = /\b(?:KR|KAIZEN)-[A-Za-z0-9-]+\b/gi;

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
 * The verbatim passage around one regex match's position, bounded to
 * `contextChars` on each side -- used when building a PR/Kaizen chunk,
 * where the match position is already known (unlike {@link _passage},
 * which searches for one at query time).
 * @param {string} text
 * @param {number} at
 * @param {number} contextChars
 * @returns {string}
 */
function _contextAround(text, at, contextChars) {
  const start = Math.max(0, at - contextChars);
  const end = Math.min(text.length, at + contextChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/**
 * Every occurrence of `pattern` in `text`, as an anchored, typed chunk.
 * `identifierTokens` (lowercased) are added to the chunk's own token set
 * ON TOP OF its passage tokens, so a query for the bare identifier (a PR
 * number, a Kaizen ID) matches even when that exact string doesn't appear
 * lowercased inside the surrounding passage window.
 * @param {RegExp} pattern - Must have the `g` flag.
 * @param {string} text
 * @param {(match: RegExpExecArray) => {label: string, identifierTokens: string[], extra?: object}} describe
 *   `extra`'s own fields (e.g. `{issue: 3016}`) are merged onto the returned chunk.
 * @param {number} contextChars
 * @returns {Array<{passage: string, label: string, tokens: string[]}>}
 */
function _chunksFor(pattern, text, describe, contextChars) {
  const chunks = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let m;
  while ((m = re.exec(text))) {
    const { label, identifierTokens, extra = {} } = describe(m);
    const passage = _contextAround(text, m.index, contextChars);
    chunks.push({ ...extra, passage, label, tokens: Array.from(new Set([..._tokenize(passage), ...identifierTokens])) });
  }
  return chunks;
}

/**
 * Build `report-search-index.json`'s content for one report (#2989
 * deliverable 1): every canonical section's anchor/heading/text/tokens,
 * every `PR #NNNN`/bare `#NNNN` occurrence as its own anchored `pr` chunk,
 * every `KR-.../KAIZEN-...` occurrence as its own anchored `kaizen` chunk,
 * plus the deduplicated `Label (#NNNN)` citation list (unchanged shape).
 * @param {string} html - A full report document's raw HTML.
 * @param {{version?: string, contextChars?: number}} [options] - `version`
 *   is this report's own version/range string (e.g. `v5.72.0` or
 *   `v5.57.0-v5.61.0`), carried through verbatim for the index's own
 *   identity; omitted when the caller has not resolved it yet.
 * @returns {{schemaVersion: string, version: string|null, generatedAt: string,
 *   sections: Array<{id: string, anchor: string, heading: string, text: string, tokens: string[]}>,
 *   prChunks: Array<{sectionId: string, anchor: string, issue: number, label: string, passage: string, tokens: string[]}>,
 *   kaizenChunks: Array<{sectionId: string, anchor: string, krId: string, label: string, passage: string, tokens: string[]}>,
 *   citations: Array<{label: string, issue: number}>}}
 */
function buildSearchIndex(html, { version = null, contextChars = 160, now = () => new Date().toISOString() } = {}) {
  const sections = [];
  const prChunks = [];
  const kaizenChunks = [];
  const citations = [];
  const seenIssues = new Set();

  CANONICAL_SECTIONS.forEach((id, index) => {
    const fragment = extractSection(html, id);
    const text = toPlainText(fragment);
    const anchor = `#${id}`;
    sections.push({
      id,
      anchor,
      heading: _headingFor(id, text),
      text,
      tokens: Array.from(new Set(_tokenize(text))),
      sectionNumber: index + 1
    });

    for (const chunk of _chunksFor(PR_PATTERN, text, (m) => ({
      label: `[PR #${m[1]}]`,
      identifierTokens: [m[1], `#${m[1]}`, 'pr'],
      extra: { issue: Number(m[1]) }
    }), contextChars)) {
      prChunks.push({ sectionId: id, anchor, ...chunk });
    }

    for (const chunk of _chunksFor(KAIZEN_PATTERN, text, (m) => ({
      label: `[${m[0].toUpperCase()}]`,
      identifierTokens: [m[0].toLowerCase()],
      extra: { krId: m[0].toUpperCase() }
    }), contextChars)) {
      kaizenChunks.push({ sectionId: id, anchor, ...chunk });
    }

    // Deduplicated by ISSUE NUMBER alone, keeping the first label
    // encountered -- extractCitations' own label capture is greedy back to
    // the start of its enclosing sentence, so the SAME issue cited in two
    // different sentences can carry two different label strings; this
    // index tracks one entry per issue, not one per label/issue pair.
    for (const c of extractCitations(fragment)) {
      if (seenIssues.has(c.issue)) continue;
      seenIssues.add(c.issue);
      citations.push({ label: c.label, issue: c.issue });
    }
  });

  return { schemaVersion: INDEX_SCHEMA_VERSION, version, generatedAt: now(), sections, prChunks, kaizenChunks, citations };
}

/**
 * Score one chunk against a query's tokens: the count of query tokens that
 * appear (as a substring of any indexed token, so a partial word still
 * matches) plus a bonus for an exact phrase (the whole query, lowercased)
 * appearing verbatim in the chunk's own text -- phrase matches rank above
 * scattered-token matches of the same count.
 * @param {{tokens: string[], text: string}} chunk
 * @param {string[]} queryTokens
 * @param {string} queryLower
 * @returns {number}
 */
function _score(chunk, queryTokens, queryLower) {
  let score = 0;
  for (const qt of queryTokens) {
    if (chunk.tokens.some((t) => t.includes(qt))) score++;
  }
  if (queryLower && chunk.text.toLowerCase().includes(queryLower)) score += queryTokens.length + 1;
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
  return _contextAround(text, at, contextChars);
}

/**
 * The deterministic "Ask This Report" lexical citation drawer (#2989
 * deliverable 2): ranks every indexed chunk -- whole sections, `PR #NNNN`
 * occurrences, and `KR-ID` occurrences -- by lexical overlap with `query`,
 * returning each match's exact cited passage, its section anchor link, its
 * `type`, and a formatted citation badge, highest-scoring first. Never
 * calls a model; every passage is a verbatim substring of the report's own
 * indexed text.
 * @param {{sections: Array<object>, prChunks: Array<object>, kaizenChunks: Array<object>}} index - From {@link buildSearchIndex}.
 * @param {string} query
 * @param {{limit?: number, contextChars?: number}} [options]
 * @returns {Array<{type: 'section'|'pr'|'kaizen', sectionId: string, anchor: string,
 *   badge: string, heading?: string, passage: string, score: number}>}
 */
function citeThisReport(index, query, { limit = 5, contextChars = 160 } = {}) {
  const queryLower = String(query || '').trim().toLowerCase();
  const queryTokens = _tokenize(queryLower);
  if (queryTokens.length === 0) return [];

  const candidates = [];
  for (const section of index.sections) {
    candidates.push({
      type: 'section',
      sectionId: section.id,
      anchor: section.anchor,
      heading: section.heading,
      badge: `[Section ${section.sectionNumber}]`,
      text: section.text,
      tokens: section.tokens,
      passageFn: () => _passage(section.text, queryTokens, contextChars)
    });
  }
  for (const chunk of index.prChunks || []) {
    candidates.push({
      type: 'pr', sectionId: chunk.sectionId, anchor: chunk.anchor, badge: chunk.label,
      text: chunk.passage, tokens: chunk.tokens, identifier: String(chunk.issue),
      passageFn: () => chunk.passage
    });
  }
  for (const chunk of index.kaizenChunks || []) {
    candidates.push({
      type: 'kaizen', sectionId: chunk.sectionId, anchor: chunk.anchor, badge: chunk.label,
      text: chunk.passage, tokens: chunk.tokens, identifier: chunk.krId.toLowerCase(),
      passageFn: () => chunk.passage
    });
  }

  // Ruling A598-PR3018-R2-HOLD-RECONCILED: a query that IS a PR number or
  // Kaizen ID (e.g. "3016", "KR-01") must surface its typed pr/kaizen hit
  // even when the SAME identifier also appears, and scores just as well,
  // inside every one of the 12 generic section chunks -- an identifier
  // match gets an overwhelming bonus so it is never pushed out of a small
  // `limit` by section ties, and type itself breaks any remaining tie
  // (pr/kaizen rank ahead of section at equal score).
  const TYPE_RANK = { pr: 0, kaizen: 0, section: 1 };
  const ranked = candidates
    .map((c) => {
      let score = _score(c, queryTokens, queryLower);
      if (c.identifier && (queryLower === c.identifier || queryLower === `#${c.identifier}` || queryTokens.includes(c.identifier))) {
        score += 1000;
      }
      return { c, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || TYPE_RANK[a.c.type] - TYPE_RANK[b.c.type]);

  return ranked.slice(0, limit).map(({ c, score }) => ({
    type: c.type,
    sectionId: c.sectionId,
    anchor: c.anchor,
    badge: c.badge,
    ...(c.heading !== undefined ? { heading: c.heading } : {}),
    passage: c.passageFn(),
    score
  }));
}

module.exports = {
  INDEX_SCHEMA_VERSION,
  buildSearchIndex,
  citeThisReport
};
