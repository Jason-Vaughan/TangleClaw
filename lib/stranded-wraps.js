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
const { stripRemoteCredentials } = require('./remote-output');
const { createLogger } = require('./logger');

const log = createLogger('stranded-wraps');

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
  query: (options) => store.activity.query(options),
  /**
   * Write an activity row; swappable so a test can make the write fail. The
   * store's own `log` swallows failures, so callers that promise a write
   * confirm it by reading back.
   * @param {object} event - `store.activity.log` event
   */
  log: (event) => store.activity.log(event)
};

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
  _internal.log({
    projectId,
    sessionId,
    eventType: EVENT_STRANDED,
    detail: { remote: stripRemoteCredentials(remote), branch, headSha: headSha || null }
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
 * acknowledging an older record is always a deliberate request. The full
 * 40-character SHA is required, as listed.
 *
 * @param {object} project - Project with `id`
 * @param {{branch?: string, headSha?: string|null, remote?: string}} request
 * @param {string|null} by - Signed-in username, or null when not known
 * @returns {{ok: true, created: boolean, item: object} |
 *   {ok: false, code: 'BAD_REQUEST'|'NOT_FOUND'|'WRITE_FAILED', error: string}}
 *   `created` is false when the item was already acknowledged at that head.
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
  const remote = body.remote === undefined ? undefined : stripRemoteCredentials(body.remote);

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

  // Acknowledging what is already acknowledged records nothing new: repeats
  // would only add rows to a type the store prunes at a fixed count.
  if (match.acknowledged) {
    return { ok: true, created: false, item: match };
  }

  const at = new Date().toISOString();
  const who = typeof by === 'string' && by ? by : null;
  _internal.log({
    projectId: project.id,
    eventType: EVENT_ACK,
    detail: { remote: match.remote, branch: match.branch, headSha: match.headSha, by: who, at }
  });
  // The store swallows write failures, so read back: an acknowledgement that
  // was not saved must not be reported as made.
  const saved = list(project).items.find((i) => i.branch === match.branch
    && i.headSha === match.headSha && i.remote === match.remote);
  if (!saved || !saved.acknowledged) {
    log.error('Stranded-wrap acknowledgement was not saved', { project: project.name, branch: match.branch });
    return { ok: false, code: 'WRITE_FAILED', error: 'The acknowledgement could not be saved; nothing was recorded. Try again.' };
  }
  return { ok: true, created: true, item: saved };
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
  return `- \`${item.branch}\` at \`${item.headSha}\`, recorded ${date}`;
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
    const message = err && err.message ? err.message : String(err);
    log.warn('Stranded wraps could not be read for the session prime', { project: project.name, error: message });
    return primeLines({ project: project.name, error: message });
  }
}

/**
 * Whether an item should hold up work: unacknowledged and fully recorded.
 * Grandfathered items are shown but never block (the program plan's locked
 * decision 4), so every count or gate that means "needs attention before
 * continuing" goes through here.
 * @param {object} item - An item from {@link list}
 * @returns {boolean}
 */
function isBlocking(item) {
  return !!item && !item.acknowledged && !item.grandfathered;
}

/**
 * Who the stranded-wrap gates apply to. The Master session is exempt: it
 * belongs to no one project, so no project's stranded branch is its to answer
 * for. Every other session is gated, including a role this function does not
 * name yet, so a new role is gated unless someone decides otherwise here.
 * @param {{role?: string}} [session]
 * @returns {boolean}
 */
function gateAppliesTo(session) {
  return !(session && session.role === 'master');
}

/**
 * The items that should hold up work right now.
 * Throws when the store cannot be read, like {@link list}.
 * @param {object} project - Project with `id`
 * @returns {object[]} Items from {@link list} that {@link isBlocking} keeps
 */
function blockingItems(project) {
  return list(project).items.filter(isBlocking);
}

/**
 * Counts over a list of items, for the API and the project list.
 * @param {object[]} items - Items from {@link list}
 * @returns {{total: number, unacknowledged: number, grandfathered: number, blocking: number}}
 */
function counts(items) {
  return {
    total: items.length,
    unacknowledged: items.filter((i) => !i.acknowledged).length,
    grandfathered: items.filter((i) => i.grandfathered).length,
    blocking: items.filter(isBlocking).length
  };
}

/**
 * The items no key covers. A key covers an item only when remote, branch and
 * head SHA all match: the same branch on another remote, or stranded again at a
 * new head, is a different item. Remotes are compared with credentials
 * removed, as {@link record} stores them.
 * @param {object[]} items - Items from {@link list}
 * @param {Array<{remote?: string|null, branch?: string, headSha?: string|null}>} keys
 * @returns {object[]}
 */
function uncovered(items, keys) {
  const given = new Set((Array.isArray(keys) ? keys : [])
    .filter((k) => k && typeof k === 'object' && !Array.isArray(k))
    .map((k) => _key(typeof k.remote === 'string' ? stripRemoteCredentials(k.remote) : null, k.branch, k.headSha)));
  return items.filter((i) => !given.has(_key(i.remote, i.branch, i.headSha)));
}

/**
 * A refusal naming the blocking items.
 * @param {object[]} items - Blocking items
 * @param {string} action - What was refused, e.g. `launch`
 * @param {string} remedy - What lets it through
 * @returns {{ok: false, code: 'STRANDED_WRAPS', items: object[], error: string}}
 */
function _refusal(items, action, remedy) {
  const names = items.slice(0, 3).map((i) => i.branch).join(', ');
  const more = items.length > 3 ? ` and ${items.length - 3} more` : '';
  return {
    ok: false,
    code: 'STRANDED_WRAPS',
    items,
    error: `Not starting the ${action}: ${items.length} wrap branch${items.length === 1 ? ' was' : 'es were'} pushed `
      + `with no pull request and nobody has acknowledged ${items.length === 1 ? 'it' : 'them'} (${names}${more}). ${remedy}`
  };
}

/**
 * The blocking items, or the reason they could not be read. The gates let
 * work through on a failed read and say so: the store that failed is the one
 * every other launch and wrap step also needs, so refusing here would only
 * trade that failure's own error for a misleading one.
 * @param {object} project
 * @returns {{items: object[], unchecked: string|null}}
 */
function _readBlocking(project) {
  try {
    return { items: blockingItems(project), unchecked: null };
  } catch (err) { // prawduct:allow prawduct/broad-except -- a gate must answer whatever the store throws, and it reports the read as unchecked
    const message = err && err.message ? err.message : String(err);
    log.warn('Stranded wraps could not be read; not gating on them', { project: project.name, error: message });
    return { items: [], unchecked: message };
  }
}

/**
 * The launch gate. Refuses while a blocking item exists, unless the request
 * acknowledges it. Each acknowledgement goes through {@link acknowledge}, so it
 * is recorded, attributed and matched exactly as the acknowledge route does it.
 * An acknowledgement that was recorded stays recorded even if the launch is
 * still refused: it is a decision the operator made.
 *
 * @param {object} project - Project with `id` and `name`
 * @param {{acknowledge?: object[], by?: string|null, role?: string}} [request]
 * @returns {{ok: true, acknowledged: number, unchecked?: string} |
 *   {ok: false, code: string, error: string, items?: object[]}}
 */
function launchGate(project, request) {
  const req = request || {};
  if (!gateAppliesTo({ role: req.role })) return { ok: true, acknowledged: 0 };
  if (req.acknowledge !== undefined && !Array.isArray(req.acknowledge)) {
    return { ok: false, code: 'BAD_REQUEST', error: 'acknowledgeStranded, when given, must be an array of {remote, branch, headSha}' };
  }
  const entries = req.acknowledge || [];
  if (entries.some((e) => !e || typeof e !== 'object' || Array.isArray(e))) {
    return { ok: false, code: 'BAD_REQUEST', error: 'each acknowledgeStranded entry must be an object {remote, branch, headSha}' };
  }
  let acknowledged = 0;
  for (const entry of entries) {
    const result = acknowledge(project, entry, req.by);
    if (!result.ok) return { ok: false, code: result.code, error: result.error };
    if (result.created) acknowledged += 1;
  }
  const { items, unchecked } = _readBlocking(project);
  if (items.length > 0) {
    return _refusal(items, 'session',
      'Acknowledge each one to launch (send acknowledgeStranded with its remote, branch and headSha).');
  }
  return unchecked ? { ok: true, acknowledged, unchecked } : { ok: true, acknowledged };
}

/**
 * The new-wrap soft block. Refuses while a blocking item exists that the
 * request does not say to proceed past. Proceeding records nothing about the
 * items: they stay unacknowledged and still block the next launch. The
 * refusal lists every blocking item, not only the uncovered ones, so a client
 * that resends what it was shown covers them all.
 *
 * @param {object} project - Project with `id` and `name`
 * @param {object[]|undefined} proceedPast - Keys the operator chose to wrap past
 * @param {{role?: string}} [session]
 * @returns {{ok: true, proceededPast: number, unchecked?: string} |
 *   {ok: false, code: string, error: string, items?: object[]}}
 */
function wrapGate(project, proceedPast, session) {
  if (!gateAppliesTo(session)) return { ok: true, proceededPast: 0 };
  if (proceedPast !== undefined && !Array.isArray(proceedPast)) {
    return { ok: false, code: 'BAD_REQUEST', error: 'options.proceedPastStranded, when given, must be an array of {remote, branch, headSha}' };
  }
  const { items, unchecked } = _readBlocking(project);
  if (unchecked) return { ok: true, proceededPast: 0, unchecked };
  if (uncovered(items, proceedPast).length > 0) {
    return _refusal(items, 'wrap',
      'Confirm to wrap anyway (send options.proceedPastStranded with each one\'s remote, branch and headSha); they stay unacknowledged.');
  }
  if (items.length > 0) {
    log.info('Wrap started past unacknowledged stranded wraps', {
      project: project.name, items: items.map((i) => ({ remote: i.remote, branch: i.branch, headSha: i.headSha }))
    });
  }
  return { ok: true, proceededPast: items.length };
}

module.exports = {
  EVENT_STRANDED,
  EVENT_ACK,
  isBlocking,
  gateAppliesTo,
  blockingItems,
  counts,
  uncovered,
  launchGate,
  wrapGate,
  record,
  list,
  acknowledge,
  primeLines,
  primeSection,
  _internal
};
