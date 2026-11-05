'use strict';

/*
 * Governed wrap UI (#2837, #2072 Slice 2) — the Dashboard-side Wrap button,
 * preflight modal, and live progress bar/stream controller for a governed-
 * wrap request (`lib/governed-wrap.js`).
 *
 * Depends on the global `esc` from landing.js/ui.js (HTML-escape), the same
 * dependency `public/history-drawer.js` already declares.
 *
 * No HTTP route serves `lib/governed-wrap.js#createWrapProgressStream` yet
 * (`lib/routes/wrap.js` and server.js are not in this slice's file
 * envelope), so `startGovernedWrapProgressStream` below takes the stream
 * URL as a parameter rather than assuming one exists; wiring a real
 * endpoint to it, and wiring this module's functions into the actual
 * dashboard page, are later slices -- the same split #1350/#1370 Slice 1
 * used for their own primitives.
 */

/**
 * This module's own progress stages, mirroring `lib/governed-wrap.js`'s
 * `PROGRESS_STAGES` one for one. Duplicated rather than shared: a browser
 * script cannot `require()` a `lib/` module, and unlike
 * `public/wrap-stream-events.js` (which predates this feature and already
 * serves both sides), this slice's file envelope has no third
 * shared-vocabulary file to hold one.
 * @type {ReadonlyArray<string>}
 */
const GOVERNED_WRAP_PROGRESS_STAGES = Object.freeze([
  'preflight', 'decision-validated', 'pipeline-running', 'completed', 'failed'
]);

/** Each stage's progress-bar fill and human label, in the order above. */
const GOVERNED_WRAP_PROGRESS_INFO = Object.freeze({
  'preflight': Object.freeze({ percent: 20, label: 'Preparing preflight…' }),
  'decision-validated': Object.freeze({ percent: 40, label: 'Decision recorded, starting the wrap…' }),
  'pipeline-running': Object.freeze({ percent: 70, label: 'Wrap running…' }),
  'completed': Object.freeze({ percent: 100, label: 'Wrap completed' }),
  'failed': Object.freeze({ percent: 100, label: 'Wrap did not complete' })
});

/**
 * The Dashboard's Wrap button for a project: a plain call-to-action, or
 * disabled with its live stage while a governed-wrap request is already
 * open for it (duplicate-run prevention is `lib/governed-wrap.js`'s own
 * job; this just reflects what it already refused to let happen twice).
 * @param {{state: string}|null} openRequest - `governedWrap.getOpenForProject`'s view, or null
 * @returns {string}
 */
function renderGovernedWrapButton(openRequest) {
  if (!openRequest) {
    return '<button type="button" class="btn" onclick="openGovernedWrapModal()">Wrap</button>';
  }
  return `<button type="button" class="btn" disabled title="A governed wrap is already in progress (${esc(openRequest.state)})">Wrap in progress…</button>`;
}

/**
 * The preflight modal body: the facts this request was built against, and
 * the bulk file-policy choice (`lib/governed-wrap.js#FILE_POLICIES`) as two
 * radio buttons rather than a per-file list -- the per-path list is what
 * blows past the drawer's 10 KB decision-body cap on a checkout with
 * hundreds of pre-existing dirty paths (#2072 comment 5); the bulk choice
 * stays small regardless of how many paths it covers.
 * @param {{preflight: {headSha: (string|null), controlState: (string|null)}, expiresAt: string}} request -
 *   `governedWrap.createPreflightRequest`'s/`getRequest`'s view
 * @returns {string}
 */
function renderGovernedWrapPreflightModal(request) {
  const preflight = (request && request.preflight) || {};
  const expiresAt = (request && request.expiresAt) || 'unknown';
  return `
    <div class="governed-wrap-preflight">
      <div class="form-hint">Target head: <code>${esc(preflight.headSha || 'unknown')}</code></div>
      <div class="form-hint">Control state: ${esc(preflight.controlState || 'none')}</div>
      <div class="form-hint">This decision expires at ${esc(expiresAt)}.</div>
      <fieldset class="governed-wrap-file-policy">
        <legend>Pre-existing dirty files not part of this session</legend>
        <label>
          <input type="radio" name="governedWrapFilePolicy" value="leave-all-preexisting" checked>
          Leave all of them (recommended for a large checkout — keeps this decision small)
        </label>
        <label>
          <input type="radio" name="governedWrapFilePolicy" value="include-owned-only">
          Include only this session's own changes; ask about anything else
        </label>
      </fieldset>
    </div>`;
}

/**
 * The live progress bar for one of this module's five stages.
 * @param {string} stage - One of {@link GOVERNED_WRAP_PROGRESS_STAGES}
 * @returns {string}
 */
function renderGovernedWrapProgressBar(stage) {
  const info = GOVERNED_WRAP_PROGRESS_INFO[stage] || { percent: 0, label: 'Unknown' };
  const toneClass = stage === 'failed' ? ' governed-wrap-progress-failed' : '';
  return `<div class="governed-wrap-progress${toneClass}" role="progressbar" aria-valuenow="${info.percent}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(info.label)}">
  <div class="governed-wrap-progress-fill" style="width:${info.percent}%"></div>
  <span class="governed-wrap-progress-label">${esc(info.label)}</span>
</div>`;
}

/**
 * Open a live progress stream for a governed-wrap request and dispatch each
 * stage as it arrives -- the same `EventSource`-with-readyState-check shape
 * `public/session.js#startWrapRunStream` already uses for the plain wrap
 * run, scoped down to this module's five named events. No polling fallback
 * is offered when `EventSource` is unavailable: unlike the plain wrap run,
 * no status endpoint exists yet for this stream to fall back to (tracked as
 * a later slice); the caller is left to render the request's last-known
 * stage until a connection can be made.
 * @param {string} url - The stream URL (no route serves one yet; the caller supplies it)
 * @param {(stage: string, detail: (object|null)) => void} onStage
 * @returns {{close: () => void}}
 */
function startGovernedWrapProgressStream(url, onStage) {
  if (typeof EventSource !== 'function') {
    return { close: () => {} };
  }
  const es = new EventSource(url);
  const handle = (stage) => (msg) => {
    let data = null;
    try {
      data = JSON.parse(msg.data);
    } catch { // a malformed frame changes nothing visible; the next frame (or a reload) still has the truth
      console.warn('[governed-wrap] discarded a malformed progress frame', { stage });
      return;
    }
    onStage(stage, data.detail || null);
    if (stage === 'completed' || stage === 'failed') es.close();
  };
  for (const stage of GOVERNED_WRAP_PROGRESS_STAGES) {
    es.addEventListener(stage, handle(stage));
  }
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      console.warn('[governed-wrap] progress stream closed');
    }
  };
  return { close: () => es.close() };
}
