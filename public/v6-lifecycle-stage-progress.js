'use strict';
/* ── TangleClaw — v6 granular startup & wrap stage visualization (#3277, V6-042 / V6-043) ── */
/*
 * Car V664-W1-C. Pure rendering functions for the sidebar row and central
 * pane's startup/wrap stage display — isolated into its own module
 * (rather than editing `public/v6-shell.js` directly) to stay zero-overlap
 * with concurrent Wave 1 cars already touching that file this version
 * (#3261/#3287/#3291, #3277's own sibling car list) and `public/style.css`
 * (#3260): a later car's integration is the two `tcV6Render*` calls this
 * file's own top documents, the same not-yet-mounted pattern
 * `public/v6-ssot-charter-view.js` and `public/v6-kaizen-reports-view.js`
 * already use.
 *
 * Scope note (#3277 AC1, Never silently drop a requirement): "expose
 * real-time startup stage and wrap/finalize stage telemetry... in the V6
 * session status payload" is, for startup, ALREADY DONE — `lib/sessions.js`'s
 * `startupReadiness()`/`activeStartupReadiness()` already derives
 * `{state, step, blocker}` from `launch_sequences` and `_modelAdmissionBlock`
 * exactly as named, and `lib/projects.js`'s `_liveSession`/`_unknownSession`
 * already carry it (and `wrapping: {step, since, stale}`, from the wrap
 * step runner's own `currentStepId` via `lib/wrap-run-registry.js`) on
 * every session row `public/v6-shell.js`'s `memberIndicators` already
 * reads. What is genuinely new here: `startupReadiness.step` is already a
 * human sentence ("Starting — step 2 of 4"), but `wrapping.step` is a raw
 * pipeline step id ("changelog-update") with no human label anywhere —
 * `WRAP_STEP_LABELS` below supplies one, client-side, grounded in the
 * real, complete step-id list `lib/wrap-default-pipeline.js` ships today
 * (verified by this file's own test against that real file, not a
 * hand-copied guess of it) — no backend change needed for that gap
 * either. Stage PERCENTAGES this file computes (`tcV6StartupStageInfo`'s
 * `progressFraction`) are parsed from that existing "step N of M" text,
 * never fabricated independently of it (the issue's own "never fabricated
 * percentages" requirement).
 */

(function (global) {
  /**
   * Escape a value for safe interpolation into an HTML template string.
   * @param {*} value
   * @returns {string}
   */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Human-readable label for each real wrap pipeline step id
   * (`lib/wrap-default-pipeline.js`'s own, complete and in this order —
   * `test/v6-lifecycle-stage-progress.test.js` pins this list against
   * that real file so a step added there is never silently unlabeled
   * here). An id this map does not recognize (a future step) falls back
   * to a title-cased version of the id itself, in {@link
   * tcV6WrapStageInfo} — never a blank label.
   * @type {Readonly<Object<string,string>>}
   */
  const WRAP_STEP_LABELS = Object.freeze({
    preflight: 'Checking session readiness',
    'session-files': 'Reviewing uncommitted files',
    'open-pr-check': 'Checking for an open PR',
    'changelog-update': 'Writing changelog entry',
    'release-recommendation': 'Checking release readiness',
    'version-bump': 'Bumping version',
    'learnings-capture': 'Capturing learnings',
    'learnings-db-write': 'Saving learnings',
    'rule-proposal': 'Reviewing rule proposals',
    'next-session-prime': 'Priming next session',
    'features-toc': 'Updating features index',
    'project-map': 'Updating project map',
    'index-describe': 'Describing index',
    'memory-update': 'Updating memory',
    commit: 'Committing changes',
    'continuity-write': 'Writing continuity handoff',
    'apply-pr-resolutions': 'Applying PR resolutions',
    'handoff-stage': 'Staging handoff'
  });

  /**
   * A step id this map does not recognize, rendered as a readable label
   * instead of a blank one: `"draining-inbox"` -> `"Draining inbox"`.
   * @param {string} stepId
   * @returns {string}
   */
  function _titleCaseStepId(stepId) {
    return String(stepId).split('-').filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Parse the `"Starting — step N of M"` shape `lib/sessions.js`'s own
   * `startupReadiness()` already produces into a `0..1` fraction, without
   * fabricating one when the text does not actually carry it (#3277's
   * own "never fabricated percentages" requirement) — e.g. `"Verifying
   * launch model"` has no step count and returns `null`, not a guess.
   * @param {string|null} step
   * @returns {number|null}
   */
  function _parseStepFraction(step) {
    const m = typeof step === 'string' ? /step (\d+) of (\d+)/i.exec(step) : null;
    if (!m) return null;
    const n = Number(m[1]);
    const total = Number(m[2]);
    return total > 0 ? Math.max(0, Math.min(1, n / total)) : null;
  }

  /**
   * One session's startup stage, ready for rendering (#3277 AC1/AC2,
   * V6-042). Reads the REAL `startupReadiness` shape `lib/sessions.js`
   * already exposes — `{state, step, blocker}` — and adds nothing this
   * file cannot derive from it.
   * @param {{state?: string, step?: string|null, blocker?: string|null}|null} startupReadiness
   * @returns {{active: boolean, label: string, progressFraction: number|null, needsAttention: boolean}}
   */
  function tcV6StartupStageInfo(startupReadiness) {
    const r = startupReadiness || {};
    if (r.state === 'ready' || !r.state) return { active: false, label: 'Ready', progressFraction: null, needsAttention: false };
    const needsAttention = r.state === 'needs-attention';
    const label = r.step || (needsAttention ? 'Needs attention' : 'Starting');
    return { active: true, label, progressFraction: _parseStepFraction(r.step), needsAttention };
  }

  /**
   * One session's wrap stage, ready for rendering (#3277 AC1/AC2,
   * V6-043). Reads the REAL `wrapping` shape `lib/projects.js` already
   * exposes — `{step, since, stale}` — and supplies the human label
   * {@link WRAP_STEP_LABELS} is missing for the raw step id.
   * @param {false|null|{step?: string|null, since?: number|null, stale?: boolean}} wrapping
   * @returns {{active: boolean, label: string, stale: boolean}}
   */
  function tcV6WrapStageInfo(wrapping) {
    if (!wrapping || typeof wrapping !== 'object') return { active: false, label: '', stale: false };
    const stepId = wrapping.step || null;
    const label = stepId ? (WRAP_STEP_LABELS[stepId] || _titleCaseStepId(stepId)) : 'Wrapping up';
    return { active: true, label, stale: Boolean(wrapping.stale) };
  }

  /**
   * The compact sidebar-row stage indicator (#3277 AC2): a half-filled
   * circle during startup/wrap, a thin progress bar when a real
   * fraction is known, and a stale-wrap warning. Renders nothing (an
   * empty string) once both stages are inactive — a live/offline member
   * keeps its own existing indicator untouched.
   * @param {{startupReadiness?: object|null, wrapping?: (false|null|object)}} session
   * @returns {string} HTML, or `''` when neither stage is active.
   */
  function tcV6RenderLifecycleSidebarMarkup(session) {
    const s = session || {};
    const startup = tcV6StartupStageInfo(s.startupReadiness);
    const wrap = tcV6WrapStageInfo(s.wrapping);
    if (!startup.active && !wrap.active) return '';
    const info = startup.active ? startup : wrap;
    const barClass = startup.active && startup.needsAttention ? 'is-attention' : (wrap.active && wrap.stale ? 'is-stale' : 'is-progress');
    const bar = typeof info.progressFraction === 'number'
      ? `<span class="v6-lifecycle-bar" role="progressbar" aria-valuenow="${Math.round(info.progressFraction * 100)}" `
        + `aria-valuemin="0" aria-valuemax="100"><span class="v6-lifecycle-bar-fill" style="width: ${Math.round(info.progressFraction * 100)}%"></span></span>`
      : '<span class="v6-lifecycle-spinner" aria-hidden="true"></span>';
    return `<span class="v6-lifecycle-stage ${barClass}" title="${escapeHtml(info.label)}">${bar}`
      + `<span class="v6-lifecycle-stage-label">${escapeHtml(info.label)}</span></span>`;
  }

  /**
   * The detailed central-pane stage block (#3277 AC2): the same startup/
   * wrap stage info as the sidebar, but full diagnostics (the blocker
   * code, the wrap's staleness and how long it has run) rather than a
   * compact label alone.
   * @param {{startupReadiness?: object|null, wrapping?: (false|null|object)}} session
   * @param {{nowMs?: number}} [opts]
   * @returns {string} HTML, or an empty-state block when neither stage is active.
   */
  function tcV6RenderLifecycleCentralPaneMarkup(session, opts) {
    const s = session || {};
    const nowMs = opts && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const startup = tcV6StartupStageInfo(s.startupReadiness);
    const wrap = tcV6WrapStageInfo(s.wrapping);
    if (!startup.active && !wrap.active) {
      return '<div class="v6-lifecycle-pane is-idle">No startup or wrap in progress.</div>';
    }
    const parts = [];
    if (startup.active) {
      const blocker = s.startupReadiness && s.startupReadiness.blocker;
      parts.push(`<section class="v6-lifecycle-pane-section is-startup${startup.needsAttention ? ' is-attention' : ''}">`
        + '<h4 class="v6-lifecycle-pane-title">Starting</h4>'
        + `<p class="v6-lifecycle-pane-label">${escapeHtml(startup.label)}</p>`
        + (typeof startup.progressFraction === 'number'
          ? `<span class="v6-lifecycle-bar" role="progressbar" aria-valuenow="${Math.round(startup.progressFraction * 100)}" `
            + `aria-valuemin="0" aria-valuemax="100"><span class="v6-lifecycle-bar-fill" style="width: ${Math.round(startup.progressFraction * 100)}%"></span></span>`
          : '<span class="v6-lifecycle-spinner" aria-hidden="true"></span>')
        + (blocker ? `<p class="v6-lifecycle-pane-blocker">Blocker: ${escapeHtml(blocker)}</p>` : '')
        + '</section>');
    }
    if (wrap.active) {
      const since = s.wrapping && Number.isFinite(s.wrapping.since) ? s.wrapping.since : null;
      const elapsedMin = since != null ? Math.max(0, Math.round((nowMs - since) / 60000)) : null;
      parts.push(`<section class="v6-lifecycle-pane-section is-wrap${wrap.stale ? ' is-stale' : ''}">`
        + '<h4 class="v6-lifecycle-pane-title">Wrapping</h4>'
        + `<p class="v6-lifecycle-pane-label">${escapeHtml(wrap.label)}</p>`
        + '<span class="v6-lifecycle-spinner" aria-hidden="true"></span>'
        + (elapsedMin != null ? `<p class="v6-lifecycle-pane-elapsed">Running ${elapsedMin}m</p>` : '')
        + (wrap.stale ? '<p class="v6-lifecycle-pane-blocker" role="alert">This wrap looks stuck.</p>' : '')
        + '</section>');
    }
    return `<div class="v6-lifecycle-pane">${parts.join('')}</div>`;
  }

  global.tcV6WrapStepLabels = WRAP_STEP_LABELS;
  global.tcV6StartupStageInfo = tcV6StartupStageInfo;
  global.tcV6WrapStageInfo = tcV6WrapStageInfo;
  global.tcV6RenderLifecycleSidebarMarkup = tcV6RenderLifecycleSidebarMarkup;
  global.tcV6RenderLifecycleCentralPaneMarkup = tcV6RenderLifecycleCentralPaneMarkup;
})(typeof window !== 'undefined' ? window : globalThis);
