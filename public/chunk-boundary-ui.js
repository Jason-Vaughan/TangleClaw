'use strict';

/*
 * Chunk-boundary status surface, browser side (#2888, #2070/#1889 Slice 3).
 *
 * `lib/chunk-boundary-ui.js` already turns a receipt into a plain view
 * model (status/label/tone); every route `lib/routes/sessions.js` mounts
 * under `/api/sessions/:project/chunk-boundary*` already attaches it as
 * `statusSurface` on its JSON response. This is the thinnest possible
 * browser-side consumer of that model: a renderer plus a fetch helper for
 * the one read-only lookup (by assignment + chunk number) a status display
 * needs. Placing this onto an actual dashboard section is a later slice --
 * this module is "ready before anything calls it", the same shape
 * `public/governed-wrap-ui.js#startGovernedWrapProgressStream` shipped in
 * before any route served its stream.
 *
 * Depends on the global `esc` (landing.js/ui.js on index.html, session.js
 * on session.html) and the global `api` helper (api-helper.js, loaded on
 * both pages) -- the same two conventions every sibling UI file here
 * declares.
 */

/**
 * Each status surface tone's badge class. Reuses the existing badge
 * variants other UI files already rely on (`badge-git` for "good",
 * `badge-drift` for "hold") rather than inventing a new CSS class this
 * module's own envelope does not include `public/style.css` to define --
 * `info` has no distinct existing variant, so it reads as the plain badge.
 * @type {Readonly<Record<string, string>>}
 */
const CHUNK_BOUNDARY_TONE_CLASS = Object.freeze({
  neutral: 'badge', info: 'badge', good: 'badge badge-git', hold: 'badge badge-drift', none: 'badge'
});

/**
 * One chunk-boundary receipt's status, as a small inline badge.
 * @param {{status: string, label: string, tone: string, chunkNumber: (number|null),
 *   builder: (string|null), lane: (string|null), clearAttempts: (number|null),
 *   readyAfterClearAt: (string|null), superseded: boolean}|null} statusSurface -
 *   `lib/chunk-boundary-ui.js#receiptStatusSurface`'s shape, exactly as every
 *   `/api/sessions/:project/chunk-boundary*` route already attaches it.
 * @returns {string}
 */
function renderChunkBoundaryBadge(statusSurface) {
  if (!statusSurface) return '';
  const cls = CHUNK_BOUNDARY_TONE_CLASS[statusSurface.tone] || CHUNK_BOUNDARY_TONE_CLASS.neutral;
  const title = statusSurface.chunkNumber != null ? ` title="Chunk ${esc(String(statusSurface.chunkNumber))}"` : '';
  const supersededMark = statusSurface.superseded ? ' (superseded)' : '';
  return `<span class="${cls}"${title}>${esc(statusSurface.label)}${esc(supersededMark)}</span>`;
}

/**
 * The receipt on record for one (project, assignment, chunk) triple, as its
 * status surface -- `null` when none exists or the read fails (never
 * throws; a status badge that cannot load renders nothing rather than
 * breaking the page it sits on).
 * @param {string} project
 * @param {string} assignmentId
 * @param {number} chunkNumber
 * @returns {Promise<object|null>}
 */
async function fetchChunkBoundaryStatus(project, assignmentId, chunkNumber) {
  const data = await api(
    `/api/sessions/${encodeURIComponent(project)}/chunk-boundary`
    + `?assignmentId=${encodeURIComponent(assignmentId)}&chunkNumber=${encodeURIComponent(String(chunkNumber))}`
  );
  return data ? data.statusSurface || null : null;
}
