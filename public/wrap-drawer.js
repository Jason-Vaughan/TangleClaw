'use strict';
/* ── TangleClaw v3 — Wrap pipeline drawer helpers (#139 Chunk 10) ── */
/* Pure rendering + state-derivation helpers for the multi-step wrap   */
/* drawer. session.js owns the event wiring and DOM mutation; this     */
/* file owns the shape-to-view-model translation so the logic stays    */
/* unit-testable via vm sandbox (mirrors api-helper.js pattern).       */

(function (global) {
  /**
   * Human-readable label for each step kind. Kinds not in the table
   * fall back to the raw kind string — surfaces unknown kinds without
   * breaking the render, which matters because methodologies can
   * declare custom kinds.
   * @type {Object<string, string>}
   */
  const KIND_LABELS = {
    'pr-check': 'Check open PRs',
    'lint': 'Lint',
    'test': 'Run tests',
    'critic-check': 'Critic verification',
    'ai-content': 'AI content',
    'priming-roll': 'Roll priming pointer',
    'version-bump': 'Version bump',
    'commit': 'Commit'
  };

  /**
   * Status pill labels + tone. Tone maps to CSS class suffix
   * (`.wrap-step-status--<tone>`).
   * @type {Object<string, {label: string, tone: string}>}
   */
  const STATUS_META = {
    pending: { label: 'Pending', tone: 'pending' },
    running: { label: 'Running', tone: 'running' },
    done: { label: 'Done', tone: 'done' },
    blocked: { label: 'Blocked', tone: 'blocked' },
    skipped: { label: 'Skipped', tone: 'skipped' }
  };

  /**
   * Translate one `pipelineResult.results[i]` entry plus optional
   * pipeline-wide context into a view-model the renderer consumes.
   *
   * @param {object} stepResult - Entry from `pipelineResult.results[]`.
   *   Required shape: `{stepId, kind, status, output, blockers}`.
   * @param {object} [ctx]
   * @param {string|null} [ctx.blockedAt] - `pipelineResult.blockedAt`. If
   *   it matches `stepResult.stepId`, the row is flagged as the active
   *   blocker (drives decision-widget rendering).
   * @returns {{
   *   id: string,
   *   kind: string,
   *   kindLabel: string,
   *   status: string,
   *   statusLabel: string,
   *   statusTone: string,
   *   blockers: string[],
   *   detail: string|null,
   *   isBlocker: boolean,
   *   warning: boolean
   * }}
   */
  function buildStepRow(stepResult, ctx) {
    const blockedAt = ctx && ctx.blockedAt ? ctx.blockedAt : null;
    const status = stepResult.status || 'pending';
    const meta = STATUS_META[status] || { label: status, tone: 'pending' };
    const blockers = Array.isArray(stepResult.blockers) ? stepResult.blockers : [];
    const output = stepResult.output && typeof stepResult.output === 'object' ? stepResult.output : null;
    // Warning flag is currently emitted by `critic-check` (blocker:false
    // step that surfaces medium+ work without Critic). Other kinds may
    // adopt the same pattern; check the field, don't hard-code the kind.
    const warning = Boolean(output && output.warning === true);
    return {
      id: stepResult.stepId,
      kind: stepResult.kind,
      kindLabel: KIND_LABELS[stepResult.kind] || stepResult.kind,
      status,
      statusLabel: meta.label,
      statusTone: meta.tone,
      blockers,
      detail: deriveDetail(stepResult),
      isBlocker: blockedAt !== null && stepResult.stepId === blockedAt,
      warning
    };
  }

  /**
   * Short per-step detail string for the row's secondary line. Pulled
   * from `output` shape based on kind. Returns `null` if nothing useful
   * to surface — caller hides the secondary line.
   *
   * @param {object} stepResult - `{kind, status, output}` entry.
   * @returns {string|null}
   */
  function deriveDetail(stepResult) {
    const output = stepResult.output && typeof stepResult.output === 'object' ? stepResult.output : null;
    if (!output) return null;
    switch (stepResult.kind) {
      case 'pr-check': {
        if (output.skipped) return output.detail || 'Skipped';
        const counts = output.counts || {};
        const parts = [];
        if (counts.sessionScoped) parts.push(`${counts.sessionScoped} session PR${counts.sessionScoped === 1 ? '' : 's'}`);
        if (counts.otherOpen) parts.push(`${counts.otherOpen} other open`);
        return parts.length ? parts.join(', ') : 'No open PRs';
      }
      case 'test':
        if (output.skipped) return 'Skipped via override';
        if (typeof output.exitCode === 'number') return `exit ${output.exitCode}`;
        return null;
      case 'lint':
        if (typeof output.exitCode === 'number') return `exit ${output.exitCode}`;
        return null;
      case 'critic-check': {
        if (output.warning) return 'Medium+ work without Critic dispatch';
        if (output.isMediumPlus) return 'Medium+ work (Critic ran)';
        return 'Below medium-plus threshold';
      }
      case 'priming-roll':
        if (output.skipped) return output.detail || 'Skipped';
        if (output.allDone) return 'All chunks done';
        if (output.current) return `→ chunk ${output.current}`;
        return null;
      case 'commit':
        if (output.skipped) return output.detail || 'Clean — no commit';
        if (output.commitSha) return output.commitSha.slice(0, 12);
        return null;
      case 'ai-content': {
        // `parsedFields` is an object whose keys are captureFields the
        // step extracted. Surface field count when present so the user
        // sees "captured 3 fields" rather than a blank row.
        const pf = output.parsedFields;
        if (pf && typeof pf === 'object') {
          const keys = Object.keys(pf);
          if (keys.length > 0) return `captured ${keys.length} field${keys.length === 1 ? '' : 's'}`;
        }
        if (typeof output.capturedText === 'string' && output.capturedText.trim().length > 0) {
          return 'captured';
        }
        return null;
      }
      case 'version-bump':
        // version-bump emits `{from, to, bumpLevel, detail}` on done,
        // `{skipped, reason, detail}` on skip — open-queue #3 (post-#139).
        if (output.skipped) return output.detail || output.reason || 'Skipped';
        if (output.from && output.to) return `${output.from} → ${output.to}`;
        if (output.to) return String(output.to);
        return null;
      default:
        return null;
    }
  }

  /**
   * Top-of-drawer status banner derivation. Single source of truth for
   * "did this wrap succeed, block, or partially succeed with warnings."
   *
   * @param {object} pipelineResult - Runner return.
   * @returns {{label: string, tone: 'success'|'blocked'|'warning'|'error', detail: string|null}}
   */
  function summarizePipelineStatus(pipelineResult) {
    if (!pipelineResult || typeof pipelineResult !== 'object') {
      return { label: 'Wrap result unavailable', tone: 'error', detail: null };
    }
    if (pipelineResult.error && !pipelineResult.blockedAt) {
      return { label: 'Wrap failed', tone: 'error', detail: pipelineResult.error };
    }
    if (pipelineResult.blockedAt) {
      const blocked = (pipelineResult.results || []).find((r) => r.stepId === pipelineResult.blockedAt);
      const reason = blocked && blocked.blockers && blocked.blockers[0] ? blocked.blockers[0] : 'See blocked step below';
      return { label: `Blocked at "${pipelineResult.blockedAt}"`, tone: 'blocked', detail: reason };
    }
    // ok:true path — check for non-blocking warnings (e.g. critic-check warning)
    const warningSteps = (pipelineResult.results || []).filter((r) => r.output && r.output.warning === true);
    if (warningSteps.length > 0) {
      const ids = warningSteps.map((s) => s.stepId).join(', ');
      return { label: 'Wrap completed with warnings', tone: 'warning', detail: `Warnings on: ${ids}` };
    }
    if (pipelineResult.commitSha) {
      return { label: 'Wrap committed', tone: 'success', detail: pipelineResult.commitSha.slice(0, 12) };
    }
    return { label: 'Wrap completed (no changes to commit)', tone: 'success', detail: null };
  }

  /**
   * Describe the decision widget to render for a blocked step. Returns
   * `null` when the kind has no interactive recovery (e.g. lint errors,
   * commit hook fail) — the user must fix outside the drawer and retry.
   *
   * @param {object} stepRow - View-model from `buildStepRow`.
   * @returns {{kind: string, optionsKey: string, label: string, inputType: 'checkbox'|'textarea'|'pr-list'}|null}
   */
  function decisionWidgetForBlockedStep(stepRow) {
    if (!stepRow || !stepRow.isBlocker) return null;
    switch (stepRow.kind) {
      case 'test':
        return {
          kind: 'test',
          optionsKey: 'skipTests',
          label: 'Override: skip tests and record the override in the commit body',
          inputType: 'checkbox'
        };
      default:
        return null;
    }
  }

  /**
   * Describe the warning widget to render for an ok:true step that
   * surfaced `output.warning === true`. Currently only `critic-check`
   * triggers this; the shape is open so future kinds can adopt it.
   *
   * @param {object} stepRow - View-model from `buildStepRow`.
   * @returns {{kind: string, optionsKey: string, label: string, inputType: 'textarea'}|null}
   */
  function warningWidgetForStep(stepRow) {
    if (!stepRow || !stepRow.warning) return null;
    switch (stepRow.kind) {
      case 'critic-check':
        return {
          kind: 'critic-check',
          optionsKey: 'criticSkipRationale',
          label: 'Skip rationale (recorded in commit body — required to clear the warning):',
          inputType: 'textarea'
        };
      default:
        return null;
    }
  }

  /**
   * Describe the pr-check resolution widget. Surfaces session-scoped
   * PRs that haven't been resolved yet so the user can pick per-PR
   * handling on retry. Returns `null` if pr-check produced nothing to
   * resolve (no session-scoped PRs, or all already resolved).
   *
   * @param {object} stepRow - View-model from `buildStepRow`.
   * @param {object} rawOutput - Raw `step.output` from the runner.
   * @returns {{kind: 'pr-check', optionsKey: 'prHandling', prs: Array<{number, title, url, branch}>}|null}
   */
  function prCheckResolutionWidget(stepRow, rawOutput) {
    if (!stepRow || stepRow.kind !== 'pr-check') return null;
    if (!rawOutput || typeof rawOutput !== 'object') return null;
    const sessionScoped = Array.isArray(rawOutput.sessionScoped) ? rawOutput.sessionScoped : [];
    if (sessionScoped.length === 0) return null;
    // If every session-scoped PR already has a resolution, no widget needed.
    const resolutions = rawOutput.resolutions && typeof rawOutput.resolutions === 'object' ? rawOutput.resolutions : {};
    const unresolved = sessionScoped.filter((pr) => !resolutions[String(pr.number)]);
    if (unresolved.length === 0) return null;
    return {
      kind: 'pr-check',
      optionsKey: 'prHandling',
      prs: unresolved.map((pr) => ({
        number: pr.number,
        title: pr.title || '',
        url: pr.url || '',
        branch: pr.headRefName || pr.branch || ''
      }))
    };
  }

  /**
   * Read the drawer's decision-widget DOM and assemble an `options`
   * object suitable for the retry POST body. Pure aside from the DOM
   * reads, which take a document-like accessor so tests can stub.
   *
   * @param {object} accessors - Bag of `{checked, value, prSelections}`
   *   getter functions, each returning the corresponding raw value.
   *   `prSelections` returns `{[prNumber]: 'merge'|'defer'|'ignore'}` or
   *   `null` if pr-check widget isn't present.
   * @returns {object} options payload (only keys with concrete user input)
   */
  function collectOptionsFromAccessors(accessors) {
    const options = {};
    if (accessors.skipTests && accessors.skipTests() === true) {
      options.skipTests = true;
    }
    if (accessors.criticSkipRationale) {
      const v = accessors.criticSkipRationale();
      if (typeof v === 'string' && v.trim().length > 0) {
        options.criticSkipRationale = v.trim();
      }
    }
    if (accessors.prHandling) {
      const v = accessors.prHandling();
      if (v && typeof v === 'object') {
        const keys = Object.keys(v).filter((k) => typeof v[k] === 'string' && v[k].length > 0);
        if (keys.length > 0) {
          options.prHandling = {};
          for (const k of keys) options.prHandling[k] = v[k];
        }
      }
    }
    return options;
  }

  /**
   * Serialize a pipeline result into a plain-text report the operator can
   * copy to the clipboard (paste into an issue, share with a collaborator).
   * Mirrors what the drawer renders — the status banner plus one block per
   * step (status, label, detail, and the full blocker output) — so the
   * copied text is the same source of truth as the on-screen report (#268).
   *
   * @param {object} pipelineResult - Runner return (`POST /wrap` body).
   * @returns {string} Multi-line report. Never throws on a malformed shape.
   */
  function buildReportText(pipelineResult) {
    const status = summarizePipelineStatus(pipelineResult);
    const lines = [`Session Wrap — ${status.label}`];
    if (status.detail) lines.push(status.detail);

    const results = pipelineResult && Array.isArray(pipelineResult.results)
      ? pipelineResult.results
      : [];
    const blockedAt = pipelineResult && pipelineResult.blockedAt ? pipelineResult.blockedAt : null;
    for (const r of results) {
      const row = buildStepRow(r, { blockedAt });
      lines.push('');
      lines.push(`[${row.statusLabel}] ${row.kindLabel} — ${row.id}`);
      if (row.detail) lines.push(`  ${row.detail}`);
      for (const b of row.blockers) lines.push(`  ${b}`);
    }
    return lines.join('\n');
  }

  /**
   * Whether `handleSessionEnded`'s auto-redirect countdown should start.
   * When the wrap drawer is open it is showing the operator's blocked /
   * warning report — the report is the primary source of truth for why a
   * wrap halted and must stay readable until the operator dismisses it, so
   * the page must NOT navigate away on its own (#268). Returns false in
   * that case; the ended bar is shown without a countdown instead.
   *
   * @param {object} state - `{wrapDrawerOpen: boolean}`.
   * @returns {boolean}
   */
  function shouldStartEndedCountdown(state) {
    return !(state && state.wrapDrawerOpen === true);
  }

  const helpers = {
    KIND_LABELS,
    STATUS_META,
    buildStepRow,
    deriveDetail,
    summarizePipelineStatus,
    decisionWidgetForBlockedStep,
    warningWidgetForStep,
    prCheckResolutionWidget,
    collectOptionsFromAccessors,
    buildReportText,
    shouldStartEndedCountdown
  };

  // Browser: attach to window so session.js can call helpers.
  // Node (tests): expose via module.exports.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
  }
  if (global) {
    global.tcWrapDrawerHelpers = helpers;
  }
})(typeof window !== 'undefined' ? window : null);
