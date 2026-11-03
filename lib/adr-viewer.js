'use strict';

/**
 * ADR Viewer / Shareable Rules Route — core engine (#1259, Architect Ruling
 * A1259, `v5.60.0` Car 60-B Slice 1).
 *
 * A pure projection/rendering library: every function here takes the
 * caller's already-fetched rule/ADR records as plain data and returns a
 * computed result — nothing in this module reads a database, a file, or a
 * network connection. Wiring a real route (`server.js`/`lib/routes/*.js`)
 * or the Settings UI (`public/app.js`, `public/index.html`) to call these
 * functions is Slice 2, deliberately deferred so Car 60-B stays 100%
 * file-disjoint from this wave's other `v5.60.0` cars.
 *
 * Two surfaces:
 *   - {@link projectRulesView} — a normalized, filterable, deep-linkable
 *     view model for an interactive viewer.
 *   - {@link buildShareableRulesView} / {@link renderShareableRulesMarkdown}
 *     — a deterministic, content-addressed snapshot an operator can share
 *     (a URL, a pasted Markdown block) with internal-only fields stripped.
 *
 * @module lib/adr-viewer
 */

const crypto = require('node:crypto');

/** Every status a record may carry; anything else is malformed input. */
const STATUSES = Object.freeze(['active', 'superseded', 'proposed', 'deprecated']);

/** Fields stripped from every record before it ever reaches a shareable
 *  payload or Markdown render — #1259's "strips internal-only secret/token
 *  fields if present". Checked by exact key name, case-insensitively,
 *  against a record's own top-level keys; nested objects are not scanned
 *  (a record carrying structured internal data under a field name not on
 *  this list is a gap the caller's own input shape must not create). */
const INTERNAL_ONLY_FIELDS = Object.freeze([
  'secret', 'secrets', 'token', 'tokens', 'apikey', 'api_key', 'credential', 'credentials', 'password'
]);

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
 * Validate one raw record and normalize it to this module's own shape, or
 * name what's wrong. A record is an ADR when it carries `number` (whatever
 * else it also carries); otherwise it is a rule, addressed by `id`.
 * @param {object} record - Raw input record
 * @param {number} index - Position in the input array, for the error message
 * @returns {{ok: true, record: object}|{ok: false, code: string, message: string}}
 */
function _normalizeRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return _refuse('ADR_VIEWER_RECORD_INVALID', `Record at index ${index} is not an object.`);
  }
  const isAdr = record.number !== undefined && record.number !== null;
  const id = isAdr ? record.number : record.id;
  if (id === undefined || id === null || (typeof id !== 'string' && typeof id !== 'number') || id === '') {
    return _refuse('ADR_VIEWER_RECORD_INVALID',
      `Record at index ${index} has no usable "id" or "number".`);
  }
  if (typeof record.title !== 'string' || !record.title) {
    return _refuse('ADR_VIEWER_RECORD_INVALID', `Record "${id}" has no "title".`);
  }
  if (typeof record.body !== 'string') {
    return _refuse('ADR_VIEWER_RECORD_INVALID', `Record "${id}" has no "body".`);
  }
  if (!STATUSES.includes(record.status)) {
    return _refuse('ADR_VIEWER_RECORD_INVALID',
      `Record "${id}" has status "${record.status}", not one of ${STATUSES.join(', ')}.`);
  }
  const tags = Array.isArray(record.tags) ? record.tags.filter((t) => typeof t === 'string') : [];
  return {
    ok: true,
    record: {
      id: isAdr ? null : id,
      number: isAdr ? id : null,
      title: record.title,
      body: record.body,
      category: typeof record.category === 'string' ? record.category : null,
      scope: typeof record.scope === 'string' ? record.scope : null,
      status: record.status,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
      tags
    }
  };
}

/**
 * A heading/record anchor slug: lowercase, alphanumerics, hyphens for
 * everything else, deduplicated with a counter so two same-titled records
 * both get a distinct, stable anchor.
 * @param {string} text
 * @param {Map<string, number>} used - Slugs already emitted in this call
 * @returns {string}
 */
function _slug(text, used) {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'record';
  const n = used.get(base) || 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

/**
 * This module's deterministic sort order: by `category` (records with no
 * category sort last within their status group), then by `number`/`id`
 * ascending — a scoping decision (#1259's own ruling specifies
 * "deterministic, sorted" without naming the key): grouping by category
 * reads as a table of contents would, and a numeric/lexical tiebreak on the
 * record's own stable identity keeps re-runs byte-identical.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function _compareRecords(a, b) {
  const ac = a.category || '￿';
  const bc = b.category || '￿';
  if (ac !== bc) return ac < bc ? -1 : 1;
  const aId = a.number !== null ? a.number : a.id;
  const bId = b.number !== null ? b.number : b.id;
  if (typeof aId === 'number' && typeof bId === 'number') return aId - bId;
  return String(aId) < String(bId) ? -1 : String(aId) > String(bId) ? 1 : 0;
}

/**
 * Project a normalized, filterable, deep-linkable view model from a set of
 * rule/ADR records (#1259).
 * @param {object[]} records - Raw rule/ADR records
 * @param {object} [options]
 * @param {string[]} [options.status] - Keep only these statuses (default: all)
 * @param {string} [options.search] - Case-insensitive substring match
 *   against `title` and `body`
 * @param {string[]} [options.tags] - Keep only records carrying at least
 *   one of these tags
 * @returns {{ok: true, view: {items: object[], total: number, filtered: number}}
 *   |{ok: false, code: string, message: string}}
 */
function projectRulesView(records, options = {}) {
  if (!Array.isArray(records)) {
    return _refuse('ADR_VIEWER_INPUT_INVALID', 'records must be an array.');
  }
  const normalized = [];
  for (let i = 0; i < records.length; i++) {
    const result = _normalizeRecord(records[i], i);
    if (!result.ok) return result;
    normalized.push(result.record);
  }
  normalized.sort(_compareRecords);

  const statusFilter = Array.isArray(options.status) && options.status.length ? new Set(options.status) : null;
  const tagFilter = Array.isArray(options.tags) && options.tags.length ? new Set(options.tags) : null;
  const search = typeof options.search === 'string' && options.search.trim() ? options.search.trim().toLowerCase() : null;

  const used = new Map();
  const items = [];
  for (const record of normalized) {
    const slug = _slug(record.number !== null ? `adr-${record.number}-${record.title}` : record.title, used);
    const route = record.number !== null ? `/adr/${record.number}` : `/rules/${record.id}`;
    const item = { ...record, slug, route };
    if (statusFilter && !statusFilter.has(item.status)) continue;
    if (tagFilter && !item.tags.some((t) => tagFilter.has(t))) continue;
    if (search && !item.title.toLowerCase().includes(search) && !item.body.toLowerCase().includes(search)) continue;
    items.push(item);
  }

  return { ok: true, view: { items, total: normalized.length, filtered: items.length } };
}

/**
 * Strip every internal-only field from a plain object, by key name,
 * case-insensitively, top-level only.
 * @param {object} obj
 * @returns {object} A shallow copy with internal-only keys removed
 */
function _stripInternalFields(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!INTERNAL_ONLY_FIELDS.includes(key.toLowerCase())) out[key] = value;
  }
  return out;
}

/**
 * Build a deterministic, shareable snapshot of a rule/ADR set: the same
 * normalized, sorted projection {@link projectRulesView} produces, with
 * every internal-only field stripped and a SHA-256 content digest computed
 * over the canonical (stripped, sorted) set (#1259).
 * @param {object[]} records - Raw rule/ADR records
 * @param {object} [options] - As {@link projectRulesView}
 * @returns {{ok: true, payload: {items: object[], digestSha256: string, generatedAt: string}}
 *   |{ok: false, code: string, message: string}}
 */
function buildShareableRulesView(records, options = {}) {
  const projected = projectRulesView(records, options);
  if (!projected.ok) return projected;
  const items = projected.view.items.map(_stripInternalFields);
  const canonical = JSON.stringify(items);
  const digestSha256 = crypto.createHash('sha256').update(canonical).digest('hex');
  return { ok: true, payload: { items, digestSha256, generatedAt: new Date().toISOString() } };
}

/**
 * Render a shareable payload (from {@link buildShareableRulesView}) as
 * deterministic Markdown — one heading per record, grouped by category,
 * carrying its status, scope, deep-link route and anchor slug (#1259).
 * @param {object} payload - A `buildShareableRulesView` payload
 * @returns {{ok: true, markdown: string}|{ok: false, code: string, message: string}}
 */
function renderShareableRulesMarkdown(payload) {
  if (!payload || !Array.isArray(payload.items) || typeof payload.digestSha256 !== 'string') {
    return _refuse('ADR_VIEWER_PAYLOAD_INVALID', 'payload must be a buildShareableRulesView() result.');
  }
  const lines = [
    '# Rules & ADRs',
    '',
    `_Digest \`${payload.digestSha256}\`_`,
    ''
  ];
  let lastCategory = Symbol('none');
  for (const item of payload.items) {
    const category = item.category || 'Uncategorized';
    if (category !== lastCategory) {
      lines.push(`## ${category}`, '');
      lastCategory = category;
    }
    const label = item.number !== null ? `ADR ${item.number}` : `Rule ${item.id}`;
    lines.push(`### ${label}: ${item.title} {#${item.slug}}`, '');
    lines.push(`_Status: ${item.status}${item.scope ? ` · Scope: ${item.scope}` : ''} · ${item.route}_`, '');
    lines.push(item.body, '');
    if (item.tags.length) lines.push(`Tags: ${item.tags.map((t) => `\`${t}\``).join(', ')}`, '');
  }
  return { ok: true, markdown: lines.join('\n') };
}

module.exports = {
  STATUSES,
  INTERNAL_ONLY_FIELDS,
  projectRulesView,
  buildShareableRulesView,
  renderShareableRulesMarkdown
};
