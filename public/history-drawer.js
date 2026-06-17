'use strict';

/*
 * History drawer (CC-5) — operator-facing cross-session search.
 *
 * Two-stage funnel over a project's continuity store:
 *   1. Warm global search across the whole history (changelog + wrap summaries)
 *      with five filters — no need to name a session first.
 *   2. Cold drill-down: click a result to deep-search that one session's
 *      transcript (with a secret-flag warning).
 *
 * Depends on the globals from landing.js/ui.js: `api` (fetch→parsed JSON|null)
 * and `esc` (HTML-escape). Wired to the project card's History button.
 */

let historyTarget = null;

/** Open the History drawer for a project and load its full session list. */
function openHistory(name) {
  historyTarget = name;
  document.getElementById('historyTitle').textContent = `Session History — ${name}`;
  document.getElementById('historySearchInput').value = '';
  ['historyDateFrom', 'historyDateTo', 'historyTags', 'historyRefs', 'historyFile'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('historyType').value = '';
  document.getElementById('historyDrill').innerHTML = '';
  document.getElementById('historyDrill').classList.add('hidden');
  document.getElementById('historyModal').classList.add('open');
  runHistorySearch();
}

/** Close the History drawer. */
function closeHistory() {
  document.getElementById('historyModal').classList.remove('open');
  historyTarget = null;
}

/** A short type badge, or '' when the session is type-un-indexed (pre-CC-5). */
function historyTypeBadge(type) {
  return type ? `<span class="badge badge-meth">${esc(type)}</span>` : '';
}

/** Read the filter form into a query string for the search endpoint. */
function historyQueryString() {
  const params = new URLSearchParams();
  const q = document.getElementById('historySearchInput').value.trim();
  if (q) params.set('q', q);
  const map = {
    dateFrom: 'historyDateFrom', dateTo: 'historyDateTo',
    tags: 'historyTags', refs: 'historyRefs', file: 'historyFile'
  };
  for (const [key, id] of Object.entries(map)) {
    const v = document.getElementById(id).value.trim();
    if (v) params.set(key, v);
  }
  const type = document.getElementById('historyType').value;
  if (type) params.set('type', type);
  return params.toString();
}

/** Run the warm global search and render ranked results. */
async function runHistorySearch() {
  if (!historyTarget) return;
  const resultsEl = document.getElementById('historyResults');
  resultsEl.innerHTML = '<div class="form-hint">Searching…</div>';
  const qs = historyQueryString();
  const data = await api(`/api/continuity/${encodeURIComponent(historyTarget)}/search?${qs}`);
  if (!data) {
    resultsEl.innerHTML = '<div class="form-hint" style="color:var(--danger)">Search failed.</div>';
    return;
  }
  renderHistoryResults(data);
}

/** Render the ranked session list + honest un-indexed-filter note. */
function renderHistoryResults(data) {
  const resultsEl = document.getElementById('historyResults');
  const sessions = data.sessions || [];
  const meta = data.meta || { unindexed: {} };

  // Honest gap: sessions wrapped before CC-5 can never match a type/file filter.
  const notes = [];
  const typeFilterOn = !!document.getElementById('historyType').value;
  const fileFilterOn = !!document.getElementById('historyFile').value.trim();
  if (typeFilterOn && meta.unindexed && meta.unindexed.type > 0) {
    notes.push(`${meta.unindexed.type} older session(s) have no recorded type and can't match this filter.`);
  }
  if (fileFilterOn && meta.unindexed && meta.unindexed.file > 0) {
    notes.push(`${meta.unindexed.file} older session(s) have no recorded files and can't match this filter.`);
  }
  const noteHtml = notes.length
    ? `<div class="form-hint" style="margin-bottom:8px">⚠ ${notes.map(esc).join(' ')}</div>` : '';

  if (!sessions.length) {
    resultsEl.innerHTML = `${noteHtml}<div class="form-hint">No matching sessions.</div>`;
    return;
  }

  const rows = sessions.map((s) => {
    const secret = s.secretsFlagged
      ? '<span class="badge badge-drift" title="Transcript flagged for possible secrets (pattern types only)">&#9888; secrets</span>' : '';
    const transcript = s.hasTranscript ? '<span class="badge badge-git" title="Transcript captured">cold</span>' : '';
    const count = s.matchCount ? `<span class="form-hint">${s.matchCount} hit(s)</span>` : '';
    const hits = (s.hits || []).slice(0, 3).map((h) =>
      `<div class="history-hit"><span class="form-hint">${esc(h.section || h.source)}</span> ${esc(h.line)}</div>`
    ).join('');
    return `<div class="history-result" onclick="openHistorySession('${esc(s.sid)}')"
        onkeydown="if(event.key==='Enter')openHistorySession('${esc(s.sid)}')" tabindex="0" role="button">
      <div class="card-row">
        <strong>session ${esc(s.sid)}</strong>
        <span class="form-hint">${esc(s.date || 'undated')}</span>
        ${historyTypeBadge(s.type)} ${transcript} ${secret} ${count}
      </div>
      ${(s.tags || []).length ? `<div class="form-hint">tags: ${esc(s.tags.join(', '))}</div>` : ''}
      ${hits}
    </div>`;
  }).join('');

  resultsEl.innerHTML = `${noteHtml}${rows}`;
}

/** Drill into one session: render wrap summary + uploads + a cold-search box. */
async function openHistorySession(sid) {
  if (!historyTarget) return;
  const drill = document.getElementById('historyDrill');
  drill.classList.remove('hidden');
  drill.innerHTML = '<div class="form-hint">Loading session…</div>';
  const data = await api(`/api/continuity/${encodeURIComponent(historyTarget)}/sessions/${encodeURIComponent(sid)}`);
  if (!data) {
    drill.innerHTML = '<div class="form-hint" style="color:var(--danger)">Failed to load session.</div>';
    return;
  }

  const summary = data.summary;
  const sections = summary && summary.sections ? summary.sections : {};
  const sectionHtml = Object.entries(sections)
    .filter(([, body]) => body)
    .map(([name, body]) => `<div class="history-section"><strong>${esc(name)}</strong><div>${esc(body)}</div></div>`)
    .join('') || '<div class="form-hint">No wrap summary for this session.</div>';

  const t = data.transcript;
  let transcriptHtml;
  if (!t) {
    transcriptHtml = '<div class="form-hint">No transcript captured for this session.</div>';
  } else {
    const secret = t.secretsFlagged
      ? `<div class="form-hint" style="color:var(--danger)">&#9888; This transcript was flagged for possible secrets (${esc((t.secretTypes || []).join(', ') || 'pattern types only')}). Values are never stored.</div>` : '';
    transcriptHtml = `
      ${secret}
      <div class="card-row" style="margin-top:6px">
        <input type="text" class="form-input" id="historyTranscriptQuery"
               placeholder="Search this session's transcript…" style="flex:1">
        <button class="btn btn-compact btn-primary" onclick="runTranscriptSearch('${esc(sid)}')">Search</button>
      </div>
      <div id="historyTranscriptResults"></div>`;
  }

  const uploads = (data.uploads || []);
  const uploadsHtml = uploads.length
    ? `<div class="history-section"><strong>Uploads (${uploads.length})</strong>${uploads.map((u) =>
        `<div class="form-hint">${esc(u.name || u.path || '')}</div>`).join('')}</div>`
    : '';

  drill.innerHTML = `
    <div class="card-row">
      <h4 style="margin:0">Session ${esc(String(sid))}</h4>
      <button class="btn btn-compact" onclick="closeHistoryDrill()">Close</button>
    </div>
    ${sectionHtml}
    ${uploadsHtml}
    <div class="history-section"><strong>Transcript (cold tier)</strong>${transcriptHtml}</div>`;
  drill.scrollIntoView({ block: 'nearest' });
}

/** Collapse the drill-down panel. */
function closeHistoryDrill() {
  const drill = document.getElementById('historyDrill');
  drill.innerHTML = '';
  drill.classList.add('hidden');
}

/** Cold-tier deep search inside one session's transcript. */
async function runTranscriptSearch(sid) {
  const q = document.getElementById('historyTranscriptQuery').value.trim();
  const out = document.getElementById('historyTranscriptResults');
  if (!q) { out.innerHTML = '<div class="form-hint">Enter a search term.</div>'; return; }
  out.innerHTML = '<div class="form-hint">Searching transcript…</div>';
  const data = await api(`/api/continuity/${encodeURIComponent(historyTarget)}/sessions/${encodeURIComponent(sid)}/transcript/search?q=${encodeURIComponent(q)}`);
  if (!data) { out.innerHTML = '<div class="form-hint" style="color:var(--danger)">Transcript search failed.</div>'; return; }
  if (!data.available) {
    out.innerHTML = `<div class="form-hint">${esc(data.reason || 'No transcript available.')}</div>`;
    return;
  }
  if (!data.excerpts.length) {
    out.innerHTML = '<div class="form-hint">No matches in this transcript.</div>';
    return;
  }
  const trunc = data.truncated ? `<div class="form-hint">Showing first ${data.excerpts.length} matches (more exist).</div>` : '';
  out.innerHTML = trunc + data.excerpts.map((e) =>
    `<div class="history-hit"><span class="form-hint">${esc(e.role)}${e.timestamp ? ' · ' + esc(e.timestamp) : ''}</span> ${esc(e.snippet)}</div>`
  ).join('');
}
