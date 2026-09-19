'use strict';

/**
 * Rule drift between the handoff a previous session wrote and the rules in
 * force at this launch (Train 21 car 21.10, §2.4 step 3).
 *
 * Pure: no store, no filesystem, no clock. The frozen step-3 text and the READY
 * gate both have to state the same drift, and the cheapest way to guarantee
 * that is for both to read one answer computed once from two manifests.
 *
 * The module's whole reason for existing is the distinction between "this
 * source did not change" and "nobody recorded this source". A handoff written
 * before car 21.10 stamped every fingerprint `project` by literal, so it holds
 * no evidence at all about the global rules or the shared documents. Reporting
 * that as "unchanged" would tell an operator that the previous session's shared
 * docs are the ones on disk now — a claim no wrap ever measured. This is the
 * §2.7 three-valued `worktree.dirty` lesson applied one document over.
 */

/** Sources a manifest can describe, in the order a reader should see them. */
const SOURCES = ['project', 'global', 'shared'];

/** Per-source verdicts. `not-recorded` is never merged into `unchanged`. */
const SOURCE_STATES = {
  CHANGED: 'changed',
  UNCHANGED: 'unchanged',
  NOT_RECORDED: 'not-recorded'
};

/**
 * What a document with no `manifestSources` field recorded.
 *
 * Before car 21.10 the wrap called a fingerprint helper that hardcoded
 * `source: 'project'`, so a document from that era describes the project rules
 * and nothing else — whatever its rows happen to say. Read as a fact about the
 * producer, not a default: this is what those wraps actually looked at.
 */
const LEGACY_MANIFEST_SOURCES = ['project'];

/**
 * Which sources a manifest claims to have recorded.
 *
 * @param {object|null} manifest - A `tc.handoff/1` document, or a launch manifest
 * @returns {string[]} The recorded sources, legacy-corrected; empty when there is no manifest
 */
function recordedSources(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  const declared = manifest.manifestSources;
  if (!Array.isArray(declared)) return [...LEGACY_MANIFEST_SOURCES];
  return SOURCES.filter((source) => declared.includes(source));
}

/**
 * Index a manifest's fingerprints by source and id.
 *
 * @param {object|null} manifest - A manifest carrying a `rules` array
 * @returns {Map<string, object>} `"<source>\u0000<id>"` → fingerprint
 */
function _index(manifest) {
  const out = new Map();
  const rows = manifest && Array.isArray(manifest.rules) ? manifest.rules : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const source = SOURCES.includes(row.source) ? row.source : 'project';
    out.set(`${source}\u0000${String(row.id)}`, { ...row, source });
  }
  return out;
}

/**
 * A rule's human label for the step-3 line, never its content.
 *
 * @param {object} row - A fingerprint
 * @returns {string} The label
 */
function _label(row) {
  if (row.label && String(row.label).trim()) return String(row.label).trim();
  return `${row.source} rule ${row.id}`;
}

/**
 * Compare two rule manifests.
 *
 * Only sources BOTH manifests recorded can produce an add, a remove or a
 * change. A source the `before` manifest never looked at yields
 * `not-recorded` and contributes nothing to `hasDrift` — the launch cannot
 * claim a shared document is new when nothing ever wrote down which ones
 * existed.
 *
 * A fingerprint whose `revision` moved but whose `contentHash` did not is NOT
 * drift: the body is what the previous session read, and a no-op version bump
 * changes nothing about what it was governed by.
 *
 * @param {object|null} before - The handoff's manifest (`{rules, manifestSources}`), or null
 * @param {object|null} after - The launch's live manifest, same shape
 * @returns {{recorded: boolean, added: object[], removed: object[], changed: object[],
 *   perSource: Record<string, string>, hasDrift: boolean, comparedSources: string[]}}
 */
function diffRuleManifests(before, after) {
  const beforeSources = recordedSources(before);
  const afterSources = recordedSources(after);
  const comparedSources = SOURCES.filter((s) => beforeSources.includes(s) && afterSources.includes(s));

  const perSource = {};
  for (const source of SOURCES) {
    perSource[source] = comparedSources.includes(source)
      ? SOURCE_STATES.UNCHANGED
      : SOURCE_STATES.NOT_RECORDED;
  }

  const empty = {
    recorded: beforeSources.length > 0,
    added: [],
    removed: [],
    changed: [],
    perSource,
    hasDrift: false,
    comparedSources
  };
  if (comparedSources.length === 0) return empty;

  const beforeRows = _index(before);
  const afterRows = _index(after);
  const compared = new Set(comparedSources);

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, row] of afterRows) {
    if (!compared.has(row.source)) continue;
    if (!beforeRows.has(key)) added.push({ source: row.source, id: row.id, label: _label(row) });
  }
  for (const [key, row] of beforeRows) {
    if (!compared.has(row.source)) continue;
    const now = afterRows.get(key);
    if (!now) {
      removed.push({ source: row.source, id: row.id, label: _label(row) });
      continue;
    }
    // The body decides. `revision` is recorded so a reader can name the
    // version, not so a version bump that changed no text can be reported as a
    // rule the session must reconcile with.
    if (now.contentHash !== row.contentHash) {
      changed.push({
        source: row.source,
        id: row.id,
        label: _label(now),
        fromRevision: row.revision ?? null,
        toRevision: now.revision ?? null
      });
    }
  }

  const bySource = (rows) => new Set(rows.map((r) => r.source));
  const moved = new Set([...bySource(added), ...bySource(removed), ...bySource(changed)]);
  for (const source of moved) perSource[source] = SOURCE_STATES.CHANGED;

  const order = (a, b) => (SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source))
    || String(a.id).localeCompare(String(b.id));

  return {
    recorded: true,
    added: added.sort(order),
    removed: removed.sort(order),
    changed: changed.sort(order),
    perSource,
    hasDrift: added.length > 0 || removed.length > 0 || changed.length > 0,
    comparedSources
  };
}

/**
 * One sentence naming what drifted, for the READY refusal and the log.
 *
 * @param {object} drift - From `diffRuleManifests`
 * @returns {string|null} The summary, or null when there is no drift
 */
function driftSummary(drift) {
  if (!drift || !drift.hasDrift) return null;
  const parts = [];
  if (drift.added.length) parts.push(`${drift.added.length} added`);
  if (drift.removed.length) parts.push(`${drift.removed.length} removed`);
  if (drift.changed.length) parts.push(`${drift.changed.length} changed`);
  const names = [...drift.added, ...drift.removed, ...drift.changed]
    .slice(0, 3).map((r) => r.label).join(', ');
  const more = (drift.added.length + drift.removed.length + drift.changed.length) > 3 ? ', …' : '';
  return `${parts.join(', ')} since the previous session's handoff (${names}${more})`;
}

module.exports = {
  SOURCES,
  SOURCE_STATES,
  LEGACY_MANIFEST_SOURCES,
  recordedSources,
  diffRuleManifests,
  driftSummary
};
