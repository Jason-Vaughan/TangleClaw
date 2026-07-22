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
   * breaking the render, which matters if the pipeline gains a kind the
   * drawer has not learned yet.
   * @type {Object<string, string>}
   */
  const KIND_LABELS = {
    'pr-check': 'Check open PRs',
    'pr-merge': 'Apply PR decisions',
    'lint': 'Lint',
    'test': 'Run tests',
    'ai-content': 'AI content',
    'priming-roll': 'Roll priming pointer',
    'version-bump': 'Version bump',
    'rule-proposal': 'Propose rules',
    'commit': 'Commit'
  };

  /**
   * Per-kind "what this step does / why it's here" help text, surfaced as a
   * hover on each step's name in the drawer. Keyed by step KIND (the stable
   * vocabulary), so the three `ai-content` rows share one description.
   * Covers every kind in the wrap pipeline; a drift-guard test keeps it
   * complete as new kinds land.
   * @type {Object<string, string>}
   */
  const KIND_DESCRIPTIONS = {
    'pr-check': 'Checks for open GitHub PRs on this branch and asks you to resolve each one (merge, defer, or ignore). Blocks the wrap until you decide; skips silently when GitHub can\u2019t be reached.',
    'pr-merge': 'Applies the PR decisions you made earlier \u2014 each PR you marked \u201cmerge\u201d gets GitHub auto-merge enabled, so it lands once its checks pass. Runs after the wrap commit. Never blocks.',
    'lint': 'Runs the project’s linter over the working tree.',
    'test': 'Runs the full test suite. A failure here can block the wrap.',
    'version-bump': 'Bumps version.json from the CHANGELOG’s [Unreleased] entries (Added/Changed → minor, Fixed-only → patch, BREAKING → major) and promotes them to a dated release. Skips when there is nothing to promote or the version is not semver.',
    'ai-content': 'The AI captures a piece of wrap content — a changelog line, session learnings, or session memory — into the wrap. Skips when there is nothing to capture.',
    'learnings-db-write': 'Persists the session’s captured learnings to the project’s learnings store.',
    'rule-proposal': 'Proposes rules from recurring learnings. Proposals govern nothing until you approve them.',
    'priming-roll': 'Rolls the build-plan chunk pointer forward so the next session resumes at the current chunk. Skips when there is no chunked plan to roll; if several in-progress plans exist it asks you to pick one.',
    'features-toc': 'Refreshes FEATURES.md — stubs entries for files touched this session and prunes entries for deleted files.',
    'project-map': 'Refreshes the continuity Map (the feature/component index) from the files touched this session.',
    'index-describe': 'Fills in one-line descriptions for empty index stubs so the index stays readable.',
    'commit': 'Commits the wrap’s changes — and, depending on your setup, opens a wrap PR.',
    'continuity-write': 'Writes the continuity index + a per-session wrap summary with a “Next action.” This is what the next session reads to offer “we left off at X — continue?”.'
  };

  /**
   * Status pill labels + tone. Tone maps to CSS class suffix
   * (`.wrap-step-status--<tone>`).
   * @type {Object<string, {label: string, tone: string}>}
   */
  const STATUS_META = {
    pending: {
      label: 'Pending',
      tone: 'pending',
      tooltip: 'Step queued but didn’t run because a blocker:true step earlier in the pipeline failed.'
    },
    running: {
      label: 'Running',
      tone: 'running',
      tooltip: 'Step is currently running.'
    },
    done: {
      label: 'Done',
      tone: 'done',
      tooltip: 'Step completed successfully.'
    },
    blocked: {
      label: 'Blocked',
      tone: 'blocked',
      tooltip: 'Step reported a problem. Whether the wrap continued depends on the step’s blocker flag — see the error message in this row.'
    },
    skipped: {
      label: 'Skipped',
      tone: 'skipped',
      tooltip: 'Step ran but had nothing to do (e.g. ai-content with an empty prompt, version-bump with no [Unreleased] entries). Not a failure.'
    }
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
   *   statusTooltip: string,
   *   blockers: string[],
   *   detail: string|null,
   *   remediation: string|null,
   *   isBlocker: boolean,
   *   warning: boolean
   * }}
   */
  function buildStepRow(stepResult, ctx) {
    const blockedAt = ctx && ctx.blockedAt ? ctx.blockedAt : null;
    const status = stepResult.status || 'pending';
    const meta = STATUS_META[status] || { label: status, tone: 'pending', tooltip: '' };
    const blockers = Array.isArray(stepResult.blockers) ? stepResult.blockers : [];
    const output = stepResult.output && typeof stepResult.output === 'object' ? stepResult.output : null;
    // `output.warning` is the kind-agnostic "ok, but you should look at
    // this" channel in the step contract — checked as a field so any
    // handler can adopt it without a drawer edit.
    const warning = Boolean(output && output.warning === true);
    // Optional `output.remediation` — a handler-supplied "how to fix this"
    // string for a blocked step (#223). Absent/blank falls through to the
    // existing raw-blocker rendering (back-compat with handlers that don't
    // emit it yet).
    const remediation = output && typeof output.remediation === 'string' && output.remediation.trim()
      ? output.remediation.trim()
      : null;
    return {
      id: stepResult.stepId,
      kind: stepResult.kind,
      kindLabel: KIND_LABELS[stepResult.kind] || stepResult.kind,
      kindTooltip: KIND_DESCRIPTIONS[stepResult.kind] || '',
      status,
      statusLabel: meta.label,
      statusTone: meta.tone,
      statusTooltip: meta.tooltip || '',
      blockers,
      detail: deriveDetail(stepResult),
      remediation,
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
    // Canonical skip signal is the step status (#204). Handle it once, above
    // the switch, so every kind's skip renders uniformly from the handler's
    // own `detail`/`reason` — no handler has to redundantly set
    // `output.skipped`, which only `version-bump` ever did and which left the
    // per-case `if (output.skipped)` branches dead for the others.
    if (stepResult.status === 'skipped') {
      return (output && (output.detail || output.reason)) || 'Skipped';
    }
    if (!output) return null;
    switch (stepResult.kind) {
      case 'pr-check': {
        const counts = output.counts || {};
        const parts = [];
        if (counts.sessionScoped) parts.push(`${counts.sessionScoped} session PR${counts.sessionScoped === 1 ? '' : 's'}`);
        if (counts.otherOpen) parts.push(`${counts.otherOpen} other open`);
        return parts.length ? parts.join(', ') : 'No open PRs';
      }
      case 'pr-merge': {
        // This step never blocks, so `blockers` is always empty and the row's
        // detail line is the only place a failed enqueue can surface at all.
        const failures = Array.isArray(output.failures) ? output.failures : [];
        const ok = output.enqueued || 0;
        if (failures.length) {
          const failed = failures.length === 1
            ? failures[0]
            : `${failures.length} PRs could not be enqueued`;
          // A partial failure must not read as a total one — the operator has
          // to know which PRs did land before deciding what to do by hand.
          return ok ? `${ok} enqueued; ${failed}` : failed;
        }
        if (ok) return `Auto-merge enqueued for ${ok} PR${ok === 1 ? '' : 's'}`;
        return null;
      }
      case 'test':
        if (typeof output.exitCode === 'number') return `exit ${output.exitCode}`;
        return null;
      case 'lint':
        if (typeof output.exitCode === 'number') return `exit ${output.exitCode}`;
        return null;
      case 'priming-roll':
        if (output.allDone) return 'All chunks done';
        if (output.current) return `→ chunk ${output.current}`;
        return null;
      case 'commit': {
        if (!output.commitSha) return null;
        const sha = output.commitSha.slice(0, 12);
        // #467 — auto-PR close-loop outcome for auto-branched commits.
        const ap = output.autoPr;
        if (!ap) return sha;
        if (ap.autoMergeArmed) return `${sha} · wrap PR auto-merge armed`;
        if (ap.prUrl) return `${sha} · wrap PR opened (auto-merge NOT armed)`;
        if (ap.error) return `${sha} · wrap PR failed — branch dangling`;
        if (ap.skippedReason) return `${sha} · wrap PR skipped: ${ap.skippedReason}`;
        return sha;
      }
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
        // version-bump emits `{from, to, bumpLevel, detail}` on done. Skips
        // are handled by the status check above (#204).
        if (output.from && output.to) return `${output.from} → ${output.to}`;
        if (output.to) return String(output.to);
        return null;
      case 'rule-proposal': {
        // Without a case here the default drops this to null, and a wrap that
        // proposed rules would look identical to one that proposed none — the
        // silent-loop problem #569 was filed about.
        const n = output.count;
        if (typeof n !== 'number' || n <= 0) return null;
        let text = `${n} rule${n === 1 ? '' : 's'} proposed — awaiting your review`;
        // The provisional backlog rides along so the loop's queue is visible
        // even in sessions that DID propose — "2 proposed, 3 more building
        // recurrence" is the loop's whole state in one line (#569 proposal 3).
        const prov = output.backlog && typeof output.backlog.provisional === 'number'
          ? output.backlog.provisional
          : 0;
        if (prov > 0) {
          text += ` · ${prov} provisional learning${prov === 1 ? '' : 's'} building recurrence`;
        }
        return text;
      }
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
    // ok:true path — check for non-blocking warnings (`output.warning`)
    const warningSteps = (pipelineResult.results || []).filter((r) => r.output && r.output.warning === true);
    if (warningSteps.length > 0) {
      const ids = warningSteps.map((s) => s.stepId).join(', ');
      return { label: 'Wrap completed with warnings', tone: 'warning', detail: `Warnings on: ${ids}`, pr: wrapPrInfo(pipelineResult) };
    }
    if (pipelineResult.commitSha) {
      // #638 — a committed wrap is NOT a shipped release. When the commit step
      // auto-branched and opened a PR, the version bump / CHANGELOG promotion
      // only reach the base branch once GitHub merges that PR. Reporting an
      // armed-but-unmerged PR as plain "success" is the defect (#636: a red
      // required check left the PR blocked and every step still read success).
      const pr = wrapPrInfo(pipelineResult);
      if (pr && pr.error) {
        // The close-loop failed (push/PR-create/auto-merge-arm) — committed but
        // the branch may dangle and nothing is armed to land it.
        return { label: 'Wrap committed — release NOT armed', tone: 'warning', detail: pr.error, pr };
      }
      if (pr && (pr.armed || pr.prUrl)) {
        // Honest provisional state; the drawer resolves merged/pending/blocked
        // via GET /wrap/pr-status after the pipeline returns.
        return {
          label: 'Wrap committed — release pending PR merge',
          tone: 'provisional',
          detail: `${pipelineResult.commitSha.slice(0, 12)} · not yet on the base branch`,
          pr
        };
      }
      return { label: 'Wrap committed', tone: 'success', detail: pipelineResult.commitSha.slice(0, 12), pr: null };
    }
    return { label: 'Wrap completed (no changes to commit)', tone: 'success', detail: null, pr: null };
  }

  /**
   * #638 — extract the wrap-PR the commit step opened (its auto-branch
   * close-loop). Returns the PR handle + armed/error state the drawer needs to
   * decide whether to probe `GET /wrap/pr-status`, or `null` when no wrap PR was
   * opened (on-feature-branch commit, local-only repo, or a clean no-op wrap).
   *
   * @param {object} pipelineResult - Runner return.
   * @returns {{prUrl: string|null, armed: boolean, error: string|null, skippedReason: string|null}|null}
   */
  function wrapPrInfo(pipelineResult) {
    const results = pipelineResult && Array.isArray(pipelineResult.results) ? pipelineResult.results : [];
    for (const r of results) {
      const ap = r && r.output && r.output.autoPr;
      if (ap && (ap.prUrl || ap.autoMergeArmed || ap.error)) {
        return {
          prUrl: ap.prUrl || null,
          armed: ap.autoMergeArmed === true,
          error: ap.error || null,
          skippedReason: ap.skippedReason || null
        };
      }
    }
    return null;
  }

  /**
   * #638 — banner override for a resolved wrap-PR outcome from
   * `GET /wrap/pr-status`. `blocked` (a red required check, a conflict, or a
   * closed-unmerged PR) renders as error and NEVER as success; `unknown` (no
   * gh, probe failure) stays provisional rather than claiming either result.
   *
   * @param {{outcome: string, state?: string, mergeStateStatus?: string, reason?: string}} status
   * @returns {{label: string, tone: 'success'|'error'|'provisional', detail: string}}
   */
  function prOutcomeBanner(status) {
    const outcome = status && status.outcome;
    if (outcome === 'merged') {
      return { label: 'Wrap shipped — PR merged', tone: 'success', detail: 'the release landed on the base branch' };
    }
    if (outcome === 'blocked') {
      // #686: `blocked` now means a genuine dead-end — closed-unmerged, a
      // conflict (DIRTY), or a required check that actually FAILED. Checks that
      // are merely still running classify as `pending`, not here, so this copy
      // no longer has to hedge "failed or still running".
      const why = status.state === 'CLOSED'
        ? 'PR was closed without merging'
        : status.mergeStateStatus === 'DIRTY'
          ? 'the branch has merge conflicts'
          : 'a required check failed';
      return { label: 'Wrap committed — release BLOCKED, did not ship', tone: 'error', detail: why };
    }
    if (outcome === 'pending') {
      // Deliberately does NOT claim auto-merge is armed: the probe reads
      // `state`/`mergeStateStatus` only, so arming is not something this knows.
      return { label: 'Wrap committed — release pending checks', tone: 'provisional', detail: 'the PR has not merged yet; it lands when its checks pass' };
    }
    return { label: 'Wrap committed — release not confirmed', tone: 'provisional', detail: (status && status.reason) || 'could not confirm the PR state' };
  }

  /**
   * Compose the resolved release outcome with the pipeline's own banner, so a
   * release probe can never erase a problem the pipeline already reported.
   *
   * Precedence, most severe first:
   *  1. A BLOCKED release wins outright — the release didn't land, which is the
   *     most severe fact available and the whole point of #638.
   *  2. Otherwise a pipeline-level `warning`/`error` is preserved, with the
   *     release outcome appended as detail. Without this a wrap that "completed
   *     with warnings" (or whose close-loop failed to arm) would be repainted
   *     "Wrap shipped — PR merged", re-opening the false-success class.
   *  3. Otherwise the release banner stands on its own.
   *
   * @param {{label: string, tone: string, detail: string|null}} baseStatus - From `summarizePipelineStatus`.
   * @param {{outcome: string}} prStatus - From `GET /wrap/pr-status`.
   * @returns {{label: string, tone: string, detail: string|null}}
   */
  function composeReleaseBanner(baseStatus, prStatus) {
    const release = prOutcomeBanner(prStatus);
    const base = baseStatus || {};
    if (release.tone === 'error') return release;
    if (base.tone === 'warning' || base.tone === 'error') {
      const outcome = (prStatus && prStatus.outcome) || 'unknown';
      return {
        label: base.label,
        tone: base.tone,
        detail: [base.detail, `release: ${outcome}`].filter(Boolean).join(' · ')
      };
    }
    return release;
  }

  /**
   * Honest skip rollup for the drawer (#571 item 4). A wrap where half the
   * steps quietly did nothing must read as "skipped N of M", not green — a
   * silently-inert wrap trains operators not to press the button. Reasons reuse
   * `deriveDetail`'s skip text so the rollup and each row's detail never
   * diverge.
   *
   * @param {object} pipelineResult - Runner return.
   * @returns {{total: number, done: number, skipped: number, blocked: number, pending: number, skips: Array<{id: string, kind: string, reason: string}>}}
   */
  function summarizeSkips(pipelineResult) {
    const results = pipelineResult && Array.isArray(pipelineResult.results) ? pipelineResult.results : [];
    const out = { total: results.length, done: 0, skipped: 0, blocked: 0, pending: 0, skips: [] };
    for (const r of results) {
      const status = r.status || 'pending';
      if (status === 'done') out.done += 1;
      else if (status === 'blocked') out.blocked += 1;
      else if (status === 'pending') out.pending += 1;
      else if (status === 'skipped') {
        out.skipped += 1;
        out.skips.push({ id: r.stepId, kind: r.kind, reason: deriveDetail(r) || 'Skipped' });
      }
    }
    return out;
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
      case 'ai-content':
        // #328: content ai-content steps (changelog/learnings/memory) are now
        // blockers. When one can't complete, the operator can skip it and wrap
        // without it. Step-scoped (`stepId`) because the skip option is a map
        // keyed by step id — more than one content step may be skipped across
        // retries.
        return {
          kind: 'ai-content',
          optionsKey: 'skipAiContent',
          label: 'Skip this step and note it in the commit body',
          inputType: 'checkbox',
          stepId: stepRow.id
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
   * Descriptor for the inline plan-picker (#428): when priming-roll blocks
   * on multiple in-progress plans it can't auto-pick, surface the candidate
   * filenames so the drawer can render a dropdown. Unlike pr-check, this is a
   * BLOCKED step and the pick is a config write (persist `activePlan`), not a
   * retry option — so it carries no `optionsKey`. Returns `null` unless the
   * step is a blocked priming-roll carrying a non-empty `candidates` array.
   *
   * @param {object} stepRow - View-model from `buildStepRow`.
   * @param {object} rawOutput - Raw `step.output` from the runner.
   * @returns {{kind: 'priming-roll', candidates: string[]}|null}
   */
  function planPickerWidget(stepRow, rawOutput) {
    if (!stepRow || stepRow.kind !== 'priming-roll') return null;
    if (stepRow.status !== 'blocked') return null;
    if (!rawOutput || typeof rawOutput !== 'object') return null;
    const candidates = Array.isArray(rawOutput.candidates)
      ? rawOutput.candidates.filter((c) => typeof c === 'string' && c.trim())
      : [];
    if (candidates.length === 0) return null;
    return { kind: 'priming-roll', candidates };
  }

  /**
   * Descriptor for the rule-proposal review widget (#569): when the wrap
   * proposed rules from recurring learnings, surface each proposal so the
   * operator can approve, edit-then-approve, or reject it inline. Like the
   * plan-picker this is a config write (PUT per rule), not a retry option —
   * so it carries no `optionsKey` and never gates the pipeline: the step is
   * done, the proposals simply await a decision. Returns `null` unless the
   * step is a completed rule-proposal carrying ≥1 well-formed proposal
   * (a `ruleId` to address and `content` to show).
   *
   * @param {object} stepRow - View-model from `buildStepRow`.
   * @param {object} rawOutput - Raw `step.output` from the runner.
   * @returns {{kind: 'rule-proposal', proposals: Array<{ruleId: number, learningId: number|null, content: string}>}|null}
   */
  function ruleProposalWidget(stepRow, rawOutput) {
    if (!stepRow || stepRow.kind !== 'rule-proposal') return null;
    if (stepRow.status !== 'done') return null;
    if (!rawOutput || typeof rawOutput !== 'object') return null;
    const proposed = Array.isArray(rawOutput.proposed) ? rawOutput.proposed : [];
    const proposals = proposed
      .filter((p) => p && typeof p.ruleId === 'number' && typeof p.content === 'string' && p.content.trim())
      .map((p) => ({
        ruleId: p.ruleId,
        learningId: typeof p.learningId === 'number' ? p.learningId : null,
        content: p.content
      }));
    if (proposals.length === 0) return null;
    return { kind: 'rule-proposal', proposals };
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
    // #328 ai-content skip override. The accessor returns the blocked step's
    // id when its "Skip & note" box is ticked (else null). Threaded as a map
    // keyed by step id so the server's ai-content handler can match
    // `options.skipAiContent[step.id]`; session.js merges this across retries
    // so an earlier skip survives a later content step's block.
    if (accessors.skipAiContent) {
      const stepId = accessors.skipAiContent();
      if (typeof stepId === 'string' && stepId.length > 0) {
        options.skipAiContent = { [stepId]: true };
      }
    }
    // #540 ask-mode — the operator's version-bump choice, captured in the wrap
    // modal and replayed on every retry (the pipeline re-runs from step 0, so
    // version-bump needs it each attempt). Empty string = Auto (the CHANGELOG
    // heuristic), which must NOT be sent: version-bump treats any out-of-set
    // value as a reason to skip rather than falling back to the heuristic.
    if (accessors.bumpLevel) {
      const level = accessors.bumpLevel();
      if (typeof level === 'string' && level.length > 0) {
        options.bumpLevel = level;
      }
    }
    return options;
  }

  /**
   * Merge this retry's ai-content skip choice into a persistent accumulator
   * and reflect the full set back onto `options` (#328). The wrap pipeline
   * re-runs from step 0 on every retry and the drawer only shows the
   * currently-blocked step, so an earlier content step's "Skip & note" must
   * persist across retries or it would re-block. Pure (mutates the two args
   * it's handed; no globals/DOM) so it's unit-testable apart from session.js.
   *
   * @param {Object<string, true>} accumulated - Session-level skip map,
   *   retained across retries. Mutated in place with any new skip.
   * @param {object} options - The freshly-collected retry options
   *   (`collectOptionsFromAccessors` output). Its `skipAiContent` is replaced
   *   with the full accumulated set when non-empty.
   * @returns {Object<string, true>} The (mutated) `accumulated` map.
   */
  function accumulateAiContentSkips(accumulated, options) {
    if (options && options.skipAiContent) Object.assign(accumulated, options.skipAiContent);
    if (options && Object.keys(accumulated).length > 0) {
      options.skipAiContent = { ...accumulated };
    }
    return accumulated;
  }

  /**
   * Serialize a pipeline result into a plain-text report the operator can
   * copy to the clipboard (paste into an issue, share with a collaborator).
   * Mirrors what the drawer renders — the status banner plus one block per
   * step (status, label, detail, and the full blocker output) — so the
   * copied text is the same source of truth as the on-screen report (#268).
   *
   * @param {object} pipelineResult - Runner return (`POST /wrap` body).
   * @param {{label: string, detail: (string|null)}} [displayedStatus] - The banner
   *   currently shown in the drawer. When present it heads the report instead of
   *   the pipeline's own verdict, so a report copied after the release resolves
   *   reads "Wrap shipped — PR merged" rather than the frozen "release pending".
   *   Omitted (or malformed) falls back to the pipeline verdict, preserving the
   *   report for a wrap whose banner was never repainted.
   * @returns {string} Multi-line report. Never throws on a malformed shape.
   */
  function buildReportText(pipelineResult, displayedStatus) {
    const status = (displayedStatus && typeof displayedStatus.label === 'string')
      ? displayedStatus
      : summarizePipelineStatus(pipelineResult);
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
      if (row.remediation) lines.push(`  How to fix: ${row.remediation}`);
    }
    return lines.join('\n');
  }

  /**
   * #583 — Decide how to reattach to a server-side wrap run after a wrap
   * POST failed (connection died, page reloaded, or 409 WRAP_IN_PROGRESS).
   * Pure decision over the `GET /wrap/status` payload:
   *
   *   - `'watch'`  — a pipeline is running; poll it to completion.
   *   - `'render'` — a run finished at/after the caller's POST went out;
   *     its retained result IS this wrap's outcome — render the drawer.
   *   - `'error'`  — nothing to reattach to (no run, or only a STALE
   *     result from some previous wrap — which must never render as this
   *     one's). Caller falls back to its own error UI.
   *
   * @param {object|null} status - `GET /wrap/status` body
   *   (`{running, finishedAt, result, …}`), or null on a failed fetch.
   * @param {number} postStartedAtMs - Epoch ms when the caller's wrap POST
   *   went out — the freshness gate for a finished result.
   * @returns {'watch'|'render'|'error'}
   */
  function wrapWatchDecision(status, postStartedAtMs) {
    if (!status || typeof status !== 'object') return 'error';
    if (status.running === true) return 'watch';
    if (
      status.result
      && typeof status.finishedAt === 'number'
      && typeof postStartedAtMs === 'number'
      && status.finishedAt >= postStartedAtMs
    ) {
      return 'render';
    }
    return 'error';
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
    KIND_DESCRIPTIONS,
    STATUS_META,
    buildStepRow,
    deriveDetail,
    summarizePipelineStatus,
    wrapPrInfo,
    prOutcomeBanner,
    composeReleaseBanner,
    summarizeSkips,
    decisionWidgetForBlockedStep,
    prCheckResolutionWidget,
    planPickerWidget,
    ruleProposalWidget,
    collectOptionsFromAccessors,
    accumulateAiContentSkips,
    buildReportText,
    wrapWatchDecision,
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
