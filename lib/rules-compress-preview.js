'use strict';

/**
 * Compress Rules Preview — core engine (#1604, Architect Ruling A1604,
 * `v5.60.0` Car 60-B Slice 1).
 *
 * A pure, deterministic, read-only text-compression library: given the
 * caller's already-fetched rules text for a scope, {@link buildRulesCompressPreview}
 * computes a proposed shorter rewrite and returns it alongside a diff and
 * token/character savings — it never mutates stored rules, never calls an
 * LLM (deterministic per #1604's own acceptance: the same input always
 * produces the same output), and never reads a database or route. Applying
 * an accepted proposal, and the Settings UI around it, is Slice 2 — kept out
 * so Car 60-B stays 100% file-disjoint from this wave's other `v5.60.0`
 * cars.
 *
 * The compression itself is intentionally conservative and rule-based, not
 * a paraphrase: exact-duplicate clauses are dropped, whitespace is
 * normalized, and a small, fixed list of filler phrases is stripped — never
 * a rewording that could silently change what a rule requires. A clause
 * marked `[PINNED]` or `DO NOT COMPRESS` is copied through completely
 * unmodified, and a clause whose compression would drop a guardrail keyword
 * (`never`, `always`, `must`, `required`, `forbidden`, `prohibited`) is left
 * in place with a warning rather than compressed — #1604's "do not trade
 * readability for a fixed reduction target" and "flag... possible meaning
 * changes separately".
 *
 * @module lib/rules-compress-preview
 */

const crypto = require('node:crypto');

/** Pinned-clause markers; a clause (line) containing either, anywhere,
 *  case-insensitively, is never touched. */
const PIN_MARKERS = Object.freeze([/\[pinned\]/i, /do not compress/i]);

/** A small, fixed, deterministic list of filler phrases this module strips
 *  from a non-pinned clause. Conservative by design: every entry here is
 *  purely decorative connective tissue, never a word that could itself be
 *  an actor, trigger, action, permission, prohibition, exception or limit. */
const FILLER_PHRASES = Object.freeze([
  'please note that ', 'please note, ', 'it is important to note that ', 'it is important that ',
  'as a reminder, ', 'keep in mind that ', 'for the avoidance of doubt, ', 'to be clear, '
]);

/** Guardrail keywords: if compressing a clause would drop one of these
 *  (case-insensitive whole-word match), that clause is left uncompressed
 *  and a warning names it instead — #1604's "flag... possible meaning
 *  changes separately" rather than silently deciding policy. */
const GUARDRAIL_KEYWORDS = Object.freeze(['never', 'always', 'must', 'required', 'forbidden', 'prohibited']);

/**
 * A refusal, in the one shape this module always answers with.
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function _refuse(code, message) {
  return { ok: false, code, message };
}

/**
 * Whether a line is pinned (never compressed).
 * @param {string} line
 * @returns {boolean}
 */
function _isPinned(line) {
  return PIN_MARKERS.some((re) => re.test(line));
}

/**
 * Count whole-word, case-insensitive occurrences of each guardrail keyword
 * in `text`.
 * @param {string} text
 * @returns {Record<string, number>}
 */
function _guardrailCounts(text) {
  const counts = {};
  for (const word of GUARDRAIL_KEYWORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'gi');
    counts[word] = (text.match(re) || []).length;
  }
  return counts;
}

/**
 * Normalize one non-pinned clause: strip filler phrases (case-insensitive,
 * at any position), collapse internal whitespace runs to a single space,
 * trim.
 * @param {string} line
 * @returns {string}
 */
function _normalizeClause(line) {
  let out = line;
  for (const phrase of FILLER_PHRASES) {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, '');
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

/**
 * Rough token-count estimate (characters / 4, the common order-of-magnitude
 * approximation used when an exact tokenizer is not in hand) — a stats
 * figure, never a billing-accurate count.
 * @param {string} text
 * @returns {number}
 */
function _estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Build a deterministic, read-only compression preview for one scope's
 * current rules text (#1604).
 * @param {object} input
 * @param {{type: ('project'|'team-member'), id: string}} input.scope - What
 *   this preview targets, carried through unchanged for the caller's own
 *   display — this module makes no decision based on it.
 * @param {string} input.originalText - The current, concatenated rules
 *   text for this scope, one clause per line.
 * @returns {{ok: true, preview: object}|{ok: false, code: string, message: string}}
 */
function buildRulesCompressPreview(input) {
  if (!input || typeof input !== 'object') {
    return _refuse('COMPRESS_PREVIEW_INPUT_INVALID', 'input must be an object.');
  }
  if (!input.scope || typeof input.scope !== 'object'
    || !['project', 'team-member'].includes(input.scope.type)
    || typeof input.scope.id !== 'string' || !input.scope.id) {
    return _refuse('COMPRESS_PREVIEW_INPUT_INVALID', 'input.scope must be {type: "project"|"team-member", id}.');
  }
  if (typeof input.originalText !== 'string') {
    return _refuse('COMPRESS_PREVIEW_INPUT_INVALID', 'input.originalText must be a string.');
  }

  const originalText = input.originalText;
  const sourceDigestSha256 = crypto.createHash('sha256').update(originalText).digest('hex');
  const lines = originalText.split('\n');

  const warnings = [];
  const diffHunks = [];
  const seenClauses = new Set();
  const outputLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      // Collapse a run of blank lines to one -- recorded as a hunk only
      // when it actually removes one, never for a single already-lone blank.
      if (outputLines.length > 0 && outputLines[outputLines.length - 1] === '') {
        diffHunks.push({ type: 'removed', line: i, originalLine: line, reason: 'blank-run-collapsed' });
        continue;
      }
      outputLines.push('');
      continue;
    }
    if (_isPinned(line)) {
      outputLines.push(line);
      diffHunks.push({ type: 'unchanged', line: i, originalLine: line, reason: 'pinned' });
      continue;
    }
    const dedupeKey = trimmed.toLowerCase().replace(/\s+/g, ' ');
    if (seenClauses.has(dedupeKey)) {
      diffHunks.push({ type: 'removed', line: i, originalLine: line, reason: 'duplicate-clause' });
      continue;
    }
    seenClauses.add(dedupeKey);

    const normalized = _normalizeClause(line);
    const before = _guardrailCounts(line);
    const after = _guardrailCounts(normalized);
    // Unreachable with the CURRENT FILLER_PHRASES list -- every phrase on it
    // was deliberately chosen to never contain a guardrail keyword, so
    // stripping one can never drop one today. Kept as a real check rather
    // than removed: it is the net that catches a future filler phrase added
    // carelessly (one that happens to overlap a guardrail word), the exact
    // silent-meaning-change #1604's own ruling asks this module to never
    // produce. A phrase genuinely free of such overlap is the design goal,
    // not a coincidence this check should stop verifying.
    const droppedKeywords = GUARDRAIL_KEYWORDS.filter((w) => after[w] < before[w]);
    if (droppedKeywords.length > 0) {
      outputLines.push(line);
      warnings.push({
        line: i, keywords: droppedKeywords,
        detail: `Compressing this clause would drop guardrail keyword(s) ${droppedKeywords.join(', ')}; left uncompressed.`
      });
      diffHunks.push({ type: 'unchanged', line: i, originalLine: line, reason: 'guardrail-keyword-preserved' });
      continue;
    }
    outputLines.push(normalized);
    if (normalized !== line) {
      diffHunks.push({ type: 'modified', line: i, originalLine: line, compressedLine: normalized, reason: 'normalized' });
    } else {
      diffHunks.push({ type: 'unchanged', line: i, originalLine: line, reason: 'already-minimal' });
    }
  }

  const compressedText = outputLines.join('\n');
  const originalChars = originalText.length;
  const compressedChars = compressedText.length;
  const charsSaved = originalChars - compressedChars;
  const originalTokensEstimate = _estimateTokens(originalText);
  const compressedTokensEstimate = _estimateTokens(compressedText);

  return {
    ok: true,
    preview: {
      scope: { type: input.scope.type, id: input.scope.id },
      originalText,
      compressedText,
      diffHunks,
      warnings,
      sourceDigestSha256,
      stats: {
        originalChars, compressedChars, charsSaved,
        savingsPercent: originalChars > 0 ? Math.round((charsSaved / originalChars) * 10000) / 100 : 0,
        originalTokensEstimate, compressedTokensEstimate,
        tokensSaved: originalTokensEstimate - compressedTokensEstimate
      }
    }
  };
}

module.exports = {
  PIN_MARKERS,
  FILLER_PHRASES,
  GUARDRAIL_KEYWORDS,
  buildRulesCompressPreview
};
