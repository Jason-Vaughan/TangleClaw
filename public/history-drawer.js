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

/*
 * Whitelist a session id for inlining into an onclick JS-string. `esc()` is
 * HTML-escaping — wrong for a JS-string sink — so a sid sourced from a wrap
 * filename could otherwise break out. Sids are the server's safe charset
 * (`[A-Za-z0-9_-]`); strip anything else defensively.
 */
function safeSid(sid) {
  return String(sid).replace(/[^A-Za-z0-9_-]/g, '');
}

/*
 * HTML-escape `text`, then wrap each case-insensitive occurrence of `query` in
 * a <mark> so the operator can see *where* a result matched — the core search
 * affordance. XSS-safe: both text and query are escaped first, so only literal
 * <mark> tags are ever injected around already-escaped content.
 */
function highlight(text, query) {
  const safe = esc(text == null ? '' : text);
  const q = (query || '').trim();
  if (!q) return safe;
  const pattern = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return safe.replace(new RegExp(pattern, 'gi'), '<mark class="history-mark">$&</mark>');
  } catch {
    return safe;
  }
}

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
  const summaryScope = document.querySelector('input[name="historyScope"][value="summaries"]');
  if (summaryScope) summaryScope.checked = true;
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
  if (historyScope() === 'transcripts') params.set('scope', 'transcripts');
  return params.toString();
}

/** The selected search scope: 'summaries' (default) or 'transcripts'. */
function historyScope() {
  const el = document.querySelector('input[name="historyScope"]:checked');
  return el ? el.value : 'summaries';
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

  const isTranscript = (meta.scope === 'transcripts') || historyScope() === 'transcripts';
  const q = document.getElementById('historySearchInput').value.trim();

  if (!sessions.length) {
    const empty = isTranscript && !q
      ? 'Type a word to search the full transcripts of every saved session in this project.'
      : isTranscript
        ? 'No transcript matches.'
        : 'No matching sessions.';
    resultsEl.innerHTML = `${noteHtml}<div class="form-hint">${empty}</div>`;
    return;
  }

  // The query the matched lines are highlighted against (the executed search).
  const totalHits = sessions.reduce((n, s) => n + (s.matchCount || 0), 0);
  const noun = isTranscript ? 'transcript hit(s)' : 'hit(s)';
  const summary = q
    ? `<div class="history-summary">${sessions.length} session(s) · ${totalHits} ${noun} for “${esc(q)}”</div>`
    : `<div class="history-summary">${sessions.length} session(s) — newest first</div>`;

  const rows = sessions.map((s) => {
    const secret = s.secretsFlagged
      ? '<span class="badge badge-drift" title="Transcript flagged for possible secrets (pattern types only)">&#9888; secrets</span>' : '';
    const transcript = s.hasTranscript ? '<span class="badge badge-git" title="Transcript captured">cold</span>' : '';
    const count = s.matchCount ? `<span class="form-hint">${s.matchCount} hit(s)</span>` : '';
    const hits = (s.hits || []).slice(0, 3).map((h) =>
      `<div class="history-hit"><span class="history-hit-loc">${esc(h.section || h.source)}</span> ${highlight(h.line, q)}</div>`
    ).join('');
    const more = (s.hits || []).length > 3 ? `<div class="form-hint">+${s.hits.length - 3} more match(es) — open to see all</div>` : '';
    return `<div class="history-result" id="hist-result-${safeSid(s.sid)}"
        onclick="openHistorySession('${safeSid(s.sid)}')"
        onkeydown="if(event.key==='Enter')openHistorySession('${safeSid(s.sid)}')" tabindex="0" role="button">
      <div class="card-row">
        <strong>session ${esc(s.sid)}</strong>
        <span class="form-hint">${esc(s.date || 'undated')}</span>
        ${historyTypeBadge(s.type)} ${transcript} ${secret} ${count}
      </div>
      ${(s.tags || []).length ? `<div class="form-hint">tags: ${esc(s.tags.join(', '))}</div>` : ''}
      ${hits}${more}
    </div>`;
  }).join('');

  resultsEl.innerHTML = `${noteHtml}${summary}${rows}`;
}

/** Drill into one session: render wrap summary + uploads + a cold-search box. */
async function openHistorySession(sid) {
  if (!historyTarget) return;
  // Mark which result is being viewed (resolves the "where am I" ambiguity).
  document.querySelectorAll('.history-result.selected').forEach((el) => el.classList.remove('selected'));
  const row = document.getElementById(`hist-result-${safeSid(sid)}`);
  if (row) row.classList.add('selected');

  const drill = document.getElementById('historyDrill');
  drill.classList.remove('hidden');
  drill.innerHTML = '<div class="form-hint">Loading session…</div>';
  const data = await api(`/api/continuity/${encodeURIComponent(historyTarget)}/sessions/${encodeURIComponent(sid)}`);
  if (!data) {
    drill.innerHTML = '<div class="form-hint" style="color:var(--danger)">Failed to load session.</div>';
    return;
  }

  // Highlight the warm search term inside the full section bodies too, so the
  // reason the session surfaced is visible at a glance in the drill.
  const q = document.getElementById('historySearchInput').value.trim();
  const summary = data.summary;
  const sections = summary && summary.sections ? summary.sections : {};
  const sectionHtml = Object.entries(sections)
    .filter(([, body]) => body)
    .map(([name, body]) => `<div class="history-section"><strong>${esc(name)}</strong><div>${highlight(body, q)}</div></div>`)
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
        <button class="btn btn-compact btn-primary" onclick="runTranscriptSearch('${safeSid(sid)}')">Search</button>
      </div>
      <div id="historyTranscriptResults"></div>`;
  }

  const uploads = (data.uploads || []);
  const uploadsHtml = uploads.length
    ? `<div class="history-section"><strong>Uploads (${uploads.length})</strong>${uploads.map((u) =>
        `<div class="form-hint">${esc(u.name || u.path || '')}</div>`).join('')}</div>`
    : '';

  drill.innerHTML = `
    <div class="card-row history-drill-head">
      <h4 style="margin:0;flex:1">Session ${esc(String(sid))} — detail</h4>
      <button class="btn btn-compact" onclick="closeHistoryDrill()">&times; Close session</button>
    </div>
    ${sectionHtml}
    ${uploadsHtml}
    <div class="history-section"><strong>Transcript (cold tier)</strong>${transcriptHtml}</div>`;
  drill.scrollIntoView({ block: 'nearest' });
}

/** Collapse the drill-down panel and clear the selected-result highlight. */
function closeHistoryDrill() {
  const drill = document.getElementById('historyDrill');
  drill.innerHTML = '';
  drill.classList.add('hidden');
  document.querySelectorAll('.history-result.selected').forEach((el) => el.classList.remove('selected'));
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
  const head = `<div class="history-summary">${data.excerpts.length} match(es)${data.truncated ? ' (showing first batch — more exist)' : ''}</div>`;
  out.innerHTML = head + data.excerpts.map((e) =>
    `<div class="history-hit"><span class="history-hit-loc">${esc(e.role)}${e.timestamp ? ' · ' + esc(e.timestamp) : ''}</span> ${highlight(e.snippet, q)}</div>`
  ).join('');
}
