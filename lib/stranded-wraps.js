'use strict';

/**
 * Stranded wraps from local records (#868) and their per-item acknowledgement
 * (#1538).
 *
 * A wrap that auto-branches off a protected branch pushes that branch and opens
 * a pull request for it. When the push lands and no pull request follows, the
 * branch is stranded: the wrap's version bump, CHANGELOG promotion and index
 * files sit on the remote and never reach the base branch. The commit step
 * records that moment; this module is the reader, and the only place that
 * decides what counts as a stranded wrap, an older record, or an acknowledged
 * one.
 *
 * Nothing here touches the network. "Stranded" means what the local record
 * says; whether GitHub still agrees is a separate, later check.
 *
 * Two record shapes are read:
 * - `wrap.stranded` — `{remote, branch, headSha}`, written for every stranded
 *   wrap. It is its own event type because `activity_log` keeps a fixed number
 *   of rows per type: a rare type is never pruned in practice, while the busy
 *   `wrap.auto_pr` type would evict a stranded row long before anyone acted on
 *   it.
 * - `wrap.auto_pr` with `stranded: true` and no `wrap.stranded` row for the
 *   same branch — written before the full record existed. These are listed as
 *   `grandfathered`, with no remote or head SHA, and they can still be pruned
 *   with the rest of their type.
 *
 * An acknowledgement is a `wrap.strand_ack` row keyed by
 * (remote, branch, headSha), so it covers the head it was given at: the same
 * branch stranded again at a new SHA is a new, unacknowledged item.
 */

const store = require('./store');

const EVENT_STRANDED = 'wrap.stranded';
const EVENT_AUTO_PR = 'wrap.auto_pr';
const EVENT_ACK = 'wrap.strand_ack';

// Above the per-type retention cap, so a query never stops short of a row the
// table still holds.
const QUERY_LIMIT = 1000;

// The prime section rides a hidden startup channel with a size cap shared by
// every section, so it lists a handful of items and points at the API for the
// rest rather than growing with the backlog.
const PRIME_MAX_ITEMS = 5;
const PRIME_BUDGET_CHARS = 1200;

const _internal = {
  QUERY_LIMIT,
  PRIME_MAX_ITEMS,
  PRIME_BUDGET_CHARS,
  /**
   * Read activity rows; swappable so a test can make the read fail.
   * @param {object} options - `store.activity.query` options
   * @returns {object[]}
   */
  query: (options) => store.activity.query(options)
};

/**
 * Remove any userinfo (`user:token@`) from a remote URL. The remote is served
 * over the API and printed into session context, so a credential embedded in
 * `origin` must never reach the record.
 * @param {string|null|undefined} url - Remote URL as git reports it
 * @returns {string|null} The URL without credentials, or null when absent
 */
function sanitizeRemote(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
}

/**
 * Record a stranded wrap. Called by the commit step when a wrap branch reached
 * the remote with no pull request. Never throws: `store.activity.log` swallows
 * its own failures, so recording can never break a wrap.
 * @param {object} params
 * @param {number} params.projectId - Owning project id
 * @param {number|null} [params.sessionId] - Session that ran the wrap
 * @param {string|null} params.remote - `origin` URL (credentials are stripped here)
 * @param {string} params.branch - The stranded wrap branch
 * @param {string|null} params.headSha - The wrap commit on that branch
 */
function record({ projectId, sessionId = null, remote, branch, headSha }) {
  store.activity.log({
    projectId,
    sessionId,
    eventType: EVENT_STRANDED,
    detail: { remote: sanitizeRemote(remote), branch, headSha: headSha || null }
  });
}

/**
 * SQLite's `datetime('now')` text (UTC, no zone) as ISO 8601 UTC.
 * @param {string} createdAt - e.g. `2026-09-16 21:39:10`
 * @returns {string} e.g. `2026-09-16T21:39:10Z`
 */
function _isoFromSqlite(createdAt) {
  if (typeof createdAt !== 'string') return null;
  return /Z$/.test(createdAt) ? createdAt : `${createdAt.replace(' ', 'T')}Z`;
}

/**
 * The key an acknowledgement is matched on.
 * @param {string|null} remote
 * @param {string} branch
 * @param {string|null} headSha
 * @returns {string}
 */
function _key(remote, branch, headSha) {
  return JSON.stringify([remote || null, branch, headSha || null]);
}

/**
 * Rows of one type for a project, newest first. `activity_log.created_at` has
 * one-second resolution, so the row id — which only grows — breaks ties.
 * @param {number} projectId
 * @param {string} eventType
 * @returns {object[]}
 */
function _rows(projectId, eventType) {
  return _internal.query({ projectId, eventType, limit: QUERY_LIMIT })
    .filter((r) => r && r.detail && typeof r.detail.branch === 'string' && r.detail.branch)
    .sort((a, b) => b.id - a.id);
}

/**
 * List a project's stranded wraps from local records, newest first.
 *
 * For a (remote, branch) stranded more than once, only the newest head is
 * listed: an older head of the same branch is no longer what the branch is at.
 * Throws when the store cannot be read; callers that must not throw (the
 * session prime) catch and say the list could not be read.
 *
 * @param {object} project - Project with `id`
 * @returns {{items: Array<{scope: 'repo', remote: string|null, branch: string,
 *   headSha: string|null, recordedAt: string, sessionId: number|null,
 *   grandfathered: boolean, acknowledged: boolean, acknowledgedBy: string|null,
 *   acknowledgedAt: string|null}>}}
 */
function list(project) {
  const projectId = project.id;
  const full = _rows(projectId, EVENT_STRANDED);
  const fullBranches = new Set(full.map((r) => r.detail.branch));
  const legacy = _rows(projectId, EVENT_AUTO_PR)
    .filter((r) => r.detail.stranded === true && !fullBranches.has(r.detail.branch));

  const acks = new Map();
  // Oldest first, so the newest acknowledgement of a key is the one kept.
  for (const r of _rows(projectId, EVENT_ACK).reverse()) {
    const d = r.detail;
    acks.set(_key(d.remote, d.branch, d.headSha), { by: d.by ?? null, at: d.at || _isoFromSqlite(r.createdAt) });
  }

  const candidates = [
    ...full.map((r) => ({ row: r, grandfathered: false, remote: r.detail.remote || null, headSha: r.detail.headSha || null })),
    ...legacy.map((r) => ({ row: r, grandfathered: true, remote: null, headSha: null }))
  ].sort((a, b) => b.row.id - a.row.id);

  const seen = new Set();
  const items = [];
  for (const c of candidates) {
    const branchKey = JSON.stringify([c.remote, c.row.detail.branch]);
    if (seen.has(branchKey)) continue;
    seen.add(branchKey);
    const ack = acks.get(_key(c.remote, c.row.detail.branch, c.headSha)) || null;
    items.push({
      scope: 'repo',
      remote: c.remote,
      branch: c.row.detail.branch,
      headSha: c.headSha,
      recordedAt: _isoFromSqlite(c.row.createdAt),
      sessionId: c.row.sessionId ?? null,
      grandfathered: c.grandfathered,
      acknowledged: !!ack,
      acknowledgedBy: ack ? ack.by : null,
      acknowledgedAt: ack ? ack.at : null
    });
  }
  return { items };
}

/**
 * Acknowledge one listed stranded wrap at the head it is at now.
 *
 * The item must be in the current list, matched on branch and head SHA (and on
 * remote, when given). A grandfathered item has no head SHA, so it is
 * acknowledged with `headSha: null`; `headSha` must still be sent, so that
 * acknowledging an older record is always a deliberate request.
 *
 * @param {object} project - Project with `id`
 * @param {{branch?: string, headSha?: string|null, remote?: string}} request
 * @param {string|null} by - Signed-in username, or null when not known
 * @returns {{ok: true, item: object} | {ok: false, code: 'BAD_REQUEST'|'NOT_FOUND', error: string}}
 */
function acknowledge(project, request, by) {
  const body = request || {};
  if (typeof body.branch !== 'string' || !body.branch) {
    return { ok: false, code: 'BAD_REQUEST', error: 'branch (non-empty string) is required' };
  }
  if (!(typeof body.headSha === 'string' || body.headSha === null)) {
    return { ok: false, code: 'BAD_REQUEST', error: 'headSha is required: the SHA the item is listed at, or null for an older record with none' };
  }
  if (body.remote !== undefined && typeof body.remote !== 'string') {
    return { ok: false, code: 'BAD_REQUEST', error: 'remote, when given, must be a string' };
  }
  const headSha = body.headSha || null;
  const remote = body.remote === undefined ? undefined : sanitizeRemote(body.remote);

  const match = list(project).items.find((i) => i.branch === body.branch
    && i.headSha === headSha
    && (remote === undefined || i.remote === remote));
  if (!match) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      error: `No stranded wrap is listed for branch "${body.branch}" at ${headSha ? `head ${headSha}` : 'no head SHA'}`
    };
  }

  const at = new Date().toISOString();
  const who = typeof by === 'string' && by ? by : null;
  store.activity.log({
    projectId: project.id,
    eventType: EVENT_ACK,
    detail: { remote: match.remote, branch: match.branch, headSha: match.headSha, by: who, at }
  });
  return { ok: true, item: { ...match, acknowledged: true, acknowledgedBy: who, acknowledgedAt: at } };
}

/**
 * One item as a prime line.
 * @param {object} item
 * @returns {string}
 */
function _itemLine(item) {
  const date = (item.recordedAt || '').slice(0, 10) || 'on an unknown date';
  if (item.grandfathered || !item.headSha) {
    return `- \`${item.branch}\`, recorded ${date} (older record, kept before head SHAs were recorded)`;
  }
  return `- \`${item.branch}\` at \`${item.headSha.slice(0, 7)}\`, recorded ${date}`;
}

/**
 * Render the session-start section. Pure: it takes what `list` returned (or
 * the read error) so its text does not depend on where in the prime it sits.
 *
 * @param {{project: string, items?: object[], error?: string}} state
 * @returns {string[]} Markdown lines, ending with a blank line
 */
function primeLines(state) {
  const name = state && state.project ? String(state.project) : '';
  const apiPath = `/api/projects/${encodeURIComponent(name)}/stranded-wraps`;
  if (state && state.error) {
    return [
      `Stranded wraps: could not be read (${String(state.error).slice(0, 160)}). This is not the same as none; check \`GET ${apiPath}\` on the TangleClaw API.`,
      ''
    ];
  }
  const items = (state && state.items) || [];
  if (items.length === 0) {
    return ['Stranded wraps: none recorded for this project.', ''];
  }
  const open = items.filter((i) => !i.acknowledged);
  const ackedCount = items.length - open.length;
  const ackedNote = ackedCount ? ` (${ackedCount} acknowledged)` : '';
  if (open.length === 0) {
    return [`Stranded wraps: none unacknowledged${ackedNote}. The list is at \`GET ${apiPath}\`.`, ''];
  }

  const lines = [
    '## Stranded wraps',
    `${open.length} wrap branch${open.length === 1 ? ' was' : 'es were'} pushed with no pull request, and nobody has acknowledged ${open.length === 1 ? 'it' : 'them'}${ackedNote}. ${open.length === 1 ? 'Its' : 'Their'} version bump, CHANGELOG promotion and index files have not reached the base branch.`,
    ...open.slice(0, PRIME_MAX_ITEMS).map(_itemLine)
  ];
  if (open.length > PRIME_MAX_ITEMS) {
    lines.push(`- …and ${open.length - PRIME_MAX_ITEMS} more.`);
  }
  lines.push(
    `Tell the operator about ${open.length === 1 ? 'it' : 'them'} before starting new work. The full list is at \`GET ${apiPath}\` on the TangleClaw API. Acknowledging one (\`POST ${apiPath}/ack\` with \`{"branch", "headSha"}\`) is the operator's decision, not yours.`,
    ''
  );
  return lines;
}

/**
 * The session-start section for a project, read from its records. Never
 * throws: a failed read renders as "could not be read".
 * @param {object} project - Project with `id` and `name`
 * @returns {string[]} Markdown lines (empty when there is no project id)
 */
function primeSection(project) {
  if (!project || project.id == null) return [];
  try {
    return primeLines({ project: project.name, items: list(project).items });
  } catch (err) { // prawduct:allow prawduct/broad-except -- the prime must render whatever the store throws, and it says the read failed
    return primeLines({ project: project.name, error: err && err.message ? err.message : String(err) });
  }
}

module.exports = {
  EVENT_STRANDED,
  EVENT_ACK,
  sanitizeRemote,
  record,
  list,
  acknowledge,
  primeLines,
  primeSection,
  _internal
};
