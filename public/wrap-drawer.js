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
    'preflight': 'Preflight',
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
    'preflight': 'Asks prawduct for its session-end verdict before the wrap writes to any file: in a prawduct-governed project it runs the Stop hook and shows the block text if a gate (Critic review, reflection) is unmet. Advisory by default — the wrap continues; a project can make it blocking in its wrap step settings. Skips in projects without .prawduct/.',
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
    },
    // #429 — distinct from `blocked` because the recovery is distinct: a
    // blocked step may be retryable, skippable, or fixable by the session,
    // while this one is waiting on something only a person at the keyboard can
    // do (exit plan mode). Rendering it as `blocked` would offer the operator
    // the wrong affordances for the wrong reason.
    'needs-operator': {
      label: 'Needs you',
      tone: 'needs-operator',
      tooltip: 'Step stopped because the session is in a state only you can change (e.g. plan mode is read-only and content steps must edit files). The row says what to do; then Retry.'
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
   *   agentResolvable: boolean,
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
      // #702 — is THIS block one the owning session can resolve by writing
      // content (a changelog/learnings/memory entry)? Only the `ai-content`
      // kind authors content; a block on a structural step (a failed test, a
      // merge conflict, a PortHub clash) is NOT something a retry-prompt to the
      // session can fix, so the "Ask the session to fix this" affordance stays
      // scoped to ai-content blocks. Requires `isBlocker` so it never shows on a
      // historical/non-active row.
      // #429 — and NOT when the block is `needs-operator`: that status exists
      // precisely because the session cannot act (a read-only pane discards
      // the fix prompt exactly as it discarded the wrap prompt), so offering
      // "Ask the session to fix this" would promise a recovery that cannot
      // happen and send the operator round the same five-minute loop.
      agentResolvable: blockedAt !== null && stepResult.stepId === blockedAt
        && stepResult.kind === 'ai-content' && status !== 'needs-operator',
      warning
    };
  }

  /**
   * #702 — compose the single-line prompt the "Ask the session to fix this"
   * button injects into the owning Claude session. Built from the blocked
   * step's own remediation so the session gets the exact fix instructions the
   * drawer shows the operator, plus a genuine-fix guard so the session writes a
   * real entry rather than a placeholder to make the gate pass (Tests Are
   * Contracts — the injected fix must not weaken the gate it satisfies).
   *
   * The result is deliberately ONE line: `injectCommand` sends it via tmux
   * send-keys, where an embedded newline is an Enter that would submit the
   * prompt half-typed — so every newline in the remediation is flattened to a
   * space. Capped to stay well under injectCommand's 4096-char limit.
   *
   * @param {{id: string, kindLabel: string, remediation: string|null}} stepRow
   *   A row view-model from `buildStepRow` (expected `agentResolvable`).
   * @returns {string} A single-line prompt (no newlines), length-capped.
   */
  function composeHandbackPrompt(stepRow) {
    const flatten = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const step = flatten(stepRow && (stepRow.kindLabel || stepRow.id) ? (stepRow.kindLabel || stepRow.id) : 'a wrap step');
    const stepId = flatten(stepRow && stepRow.id ? stepRow.id : '');
    const fix = flatten(stepRow && stepRow.remediation ? stepRow.remediation : '');
    const parts = [
      `Your session wrap is blocked at the ${step}${stepId && stepId !== step ? ` (${stepId})` : ''} step.`,
      fix ? `How to fix it: ${fix}` : '',
      'Please resolve it properly — write a genuine entry, never a placeholder just to pass the gate; if the work truly warrants no entry, that is a decision to note, not to fake.',
      'Then stop — do NOT trigger the wrap yourself; the operator will hit Retry.'
    ].filter(Boolean);
    const prompt = parts.join(' ');
    // Hard cap below injectCommand's 4096 limit, leaving headroom.
    return prompt.length > 3800 ? `${prompt.slice(0, 3797)}...` : prompt;
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
      case 'preflight':
        // #854 — a clear probe names itself; an advisory block says the wrap
        // went on, so the blocked badge on a completed wrap is not read as
        // the wrap having stopped. A halting block needs no line: the row IS
        // the blocker and the banner says so.
        if (output.exitCode === 0) return output.detail || 'prawduct gates clear';
        if (output.advisory === true) return 'advisory — the wrap continued';
        return null;
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
        // #867 — a pushed branch with no PR is stranded, not skipped. It used
        // to fall through to the neutral `skipped` line below and read exactly
        // like the deliberate `wrapAutoPrEnabled:false` opt-out, so the one
        // surface the operator is actually watching — in the one moment the
        // branch can still be rescued — called the failure benign. Mirrors
        // `_isStranded` in `lib/wrap-steps/commit.js`; a test pins them equal.
        if (isStrandedWrap(ap)) {
          return `${sha} · wrap PR NOT opened — branch left on origin: ${ap.skippedReason || 'no PR was created'}`;
        }
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
   * @returns {{label: string, tone: 'success'|'blocked'|'needs-operator'|'warning'|'error', detail: string|null}}
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
      // #429 — the banner is the first thing read, and the copied report's
      // first line. Keying it on `blockedAt` alone made a `needs-operator`
      // halt announce itself as "Blocked at …" in red: the exact framing the
      // status was added to replace, on the one surface that sets the
      // operator's expectation before they read a row. The halting step's own
      // status decides the words.
      if (blocked && blocked.status === 'needs-operator') {
        return { label: `Waiting on you at "${pipelineResult.blockedAt}"`, tone: 'needs-operator', detail: reason };
      }
      return { label: `Blocked at "${pipelineResult.blockedAt}"`, tone: 'blocked', detail: reason };
    }
    // ok:true path. Non-blocking warnings (`output.warning`) are reported only
    // where they do not displace a RELEASE-STATE banner. This check used to run
    // first, so one advisory step — `preflight` is advisory by default and warns
    // on any unmet governance gate (#854) — hid "release NOT armed" (#638),
    // "branch left on origin, no PR" (#867) and "release pending PR merge"
    // behind "completed with warnings". Those say the work did not ship; a
    // warning says it shipped with something to read. The more consequential
    // fact wins the banner, and the warning still shows on its own step row.
    const warningSteps = (pipelineResult.results || []).filter((r) => r.output && r.output.warning === true);
    const warningDetail = () => `Warnings on: ${warningSteps.map((s) => s.stepId).join(', ')}`;
    /**
     * Append the warning note to a release-state detail line, COMPOSING the two
     * facts instead of choosing between them. Ordering these wrongly is a
     * two-sided defect and both sides have been live: with the warning check
     * first it hid "release NOT armed"; with it merely moved below, a governed
     * project whose gate is unmet and whose PR merged read as plain success,
     * with no trace of the gate anywhere. Release state leads because it says
     * whether the work shipped; the warning rides along because it is the only
     * place an advisory `preflight` block reaches the banner at all.
     * @param {string|null} detail - The release-state detail.
     * @returns {string|null} The detail, with the warnings noted.
     */
    const withWarnings = (detail) => {
      if (warningSteps.length === 0) return detail;
      return detail ? `${detail} · ${warningDetail()}` : warningDetail();
    };
    /** Warning step ids, carried as a FIELD so a later composer can re-append
     * them. In the detail string alone they are unrecoverable the moment that
     * string is dropped — which is exactly what `composeReleaseBanner` does to
     * a `provisional` base once the release probe answers. */
    const warnIds = warningSteps.map((st) => st.stepId);
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
        return { label: 'Wrap committed — release NOT armed', tone: 'warning', detail: withWarnings(pr.error), pr, warnings: warnIds };
      }
      if (pr && pr.stranded) {
        // #867 — pushed, but no PR exists and none is armed. Without this the
        // shape fell through to the plain-success return below, which also
        // discards `pr`: the banner said "Wrap committed" in success tone for a
        // branch nothing will ever land. It is the same class as the `pr.error`
        // case above — committed, with nothing to merge it — so it reads the
        // same way, and only the operator can rescue it.
        return {
          label: 'Wrap committed — branch left on origin, no PR',
          tone: 'warning',
          detail: withWarnings(pr.skippedReason || 'the wrap branch was pushed but no PR was opened'),
          pr,
          warnings: warnIds
        };
      }
      if (pr && (pr.armed || pr.prUrl)) {
        // Honest provisional state; the drawer resolves merged/pending/blocked
        // via GET /wrap/pr-status after the pipeline returns.
        return {
          label: 'Wrap committed — release pending PR merge',
          tone: 'provisional',
          detail: withWarnings(`${pipelineResult.commitSha.slice(0, 12)} · not yet on the base branch`),
          pr,
          warnings: warnIds
        };
      }
      // Nothing about the release needs saying — so a warning, if there is one,
      // is the most important thing left.
      if (warningSteps.length > 0) {
        // Wording unchanged — `test/wrap-drawer.test.js` pins it as an
        // operator-facing contract, and R-8 was about the warning being
        // DISCARDED on the PR paths, not about this label.
        return { label: 'Wrap completed with warnings', tone: 'warning', detail: warningDetail(), pr: null };
      }
      return { label: 'Wrap committed', tone: 'success', detail: pipelineResult.commitSha.slice(0, 12), pr: null };
    }
    if (warningSteps.length > 0) {
      return { label: 'Wrap completed with warnings', tone: 'warning', detail: warningDetail(), pr: wrapPrInfo(pipelineResult) };
    }
    return { label: 'Wrap completed (no changes to commit)', tone: 'success', detail: null, pr: null };
  }

  /**
   * Is this close-loop result a *stranded* wrap — a branch pushed to the remote
   * that no PR will ever land?
   *
   * Mirror of `_isStranded` in `lib/wrap-steps/commit.js`, which is the server's
   * definition; `test/wrap-drawer.test.js` pins the two to the same verdict, so
   * a change to one that is not made to the other fails rather than silently
   * letting the drawer and the log disagree about the same wrap.
   *
   * @param {{pushed:boolean, prUrl:string|null, autoMergeArmed:boolean}} ap
   * @returns {boolean}
   */
  function isStrandedWrap(ap) {
    if (!ap) return false;
    return ap.pushed === true && !ap.prUrl && ap.autoMergeArmed !== true;
  }

  /**
   * #638 — extract the wrap-PR the commit step opened (its auto-branch
   * close-loop). Returns the PR handle + armed/error state the drawer needs to
   * decide whether to probe `GET /wrap/pr-status`, or `null` when nothing was
   * left behind to chase: an on-feature-branch commit, a local-only repo, a
   * clean no-op wrap, or a deliberate opt-out.
   *
   * #867 — a stranded wrap also returns a handle. It has no `prUrl` to probe,
   * but it is the case most in need of a banner: the branch is on the remote
   * and only the operator can rescue it. Returning `null` here left the banner
   * reading `Wrap committed` in plain success tone, which is how one sat
   * unnoticed for five days.
   *
   * @param {object} pipelineResult - Runner return.
   * @returns {{prUrl: string|null, armed: boolean, error: string|null, skippedReason: string|null, stranded: boolean}|null}
   */
  function wrapPrInfo(pipelineResult) {
    const results = pipelineResult && Array.isArray(pipelineResult.results) ? pipelineResult.results : [];
    for (const r of results) {
      const ap = r && r.output && r.output.autoPr;
      if (ap && (ap.prUrl || ap.autoMergeArmed || ap.error || isStrandedWrap(ap))) {
        return {
          prUrl: ap.prUrl || null,
          armed: ap.autoMergeArmed === true,
          error: ap.error || null,
          skippedReason: ap.skippedReason || null,
          stranded: isStrandedWrap(ap)
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
   * @param {boolean} [armed] - Whether the commit step armed GitHub auto-merge
   *   for this wrap PR (known from the pipeline's own `pr.armed`, not the probe).
   *   When true, a `pending` release is a done deal — GitHub lands it server-side
   *   the instant checks pass, no operator action — so the copy says so rather
   *   than implying a manual step (#700). When false/unknown, the honest hedge
   *   stands: arming is not something the read-only probe can see on its own.
   * @returns {{label: string, tone: 'success'|'error'|'provisional', detail: string}}
   */
  function prOutcomeBanner(status, armed) {
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
      // #700 — when auto-merge is armed, a pending release needs NO operator
      // action: GitHub merges the PR the instant its checks pass. Say so, so the
      // provisional banner reads as "done, just waiting" instead of "a manual
      // step remains" (the false-alarm the imperative "Recheck release" button
      // trained). Arming comes from the pipeline (`pr.armed`), threaded in by
      // `composeReleaseBanner` — the read-only probe can't see it on its own, so
      // an unknown/unarmed pending keeps the honest hedge.
      if (armed) {
        return { label: 'Wrap committed — release pending checks', tone: 'provisional', detail: 'auto-merge is armed — the PR lands on its own when its checks pass. Nothing more to do; you can close this.' };
      }
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
   *  3. Otherwise the release banner stands on its own — but it still carries
   *     forward `base.warnings`, because a `provisional` base is not covered by
   *     rule 2 and its detail string is dropped here. That is how an advisory
   *     `preflight` gate vanished behind "Wrap shipped — PR merged": the fact
   *     was in the detail, and this function keeps none of it.
   *
   * @param {{label: string, tone: string, detail: string|null}} baseStatus - From `summarizePipelineStatus`.
   * @param {{outcome: string}} prStatus - From `GET /wrap/pr-status`.
   * @returns {{label: string, tone: string, detail: string|null}}
   */
  function composeReleaseBanner(baseStatus, prStatus) {
    const base = baseStatus || {};
    // #700 — a pending release with auto-merge armed needs no operator action;
    // pass the pipeline's own arming knowledge (the probe can't see it) so the
    // banner can say "lands on its own" instead of implying a manual step.
    const armed = !!(base.pr && base.pr.armed);
    const release = prOutcomeBanner(prStatus, armed);
    if (release.tone === 'error') return release;
    if (base.tone === 'warning' || base.tone === 'error') {
      const outcome = (prStatus && prStatus.outcome) || 'unknown';
      return {
        label: base.label,
        tone: base.tone,
        detail: [base.detail, `release: ${outcome}`].filter(Boolean).join(' · ')
      };
    }
    // A provisional base takes the release banner, but its warnings are not the
    // release's to discard — they are the only place an advisory step reaches
    // the operator at all.
    const carried = Array.isArray(base.warnings) ? base.warnings : [];
    if (carried.length > 0) {
      return {
        ...release,
        tone: release.tone === 'success' ? 'warning' : release.tone,
        detail: [release.detail, `Warnings on: ${carried.join(', ')}`].filter(Boolean).join(' · ')
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
   * The buckets are EXHAUSTIVE over `wrapPipeline.STEP_STATUSES` — a status
   * counted in `total` and in no bucket makes the digest under-report the very
   * thing it exists to surface. `test/wrap-step-status-vocabulary.test.js`
   * fails when a declared status has no bucket here (#429 R-6); it caught
   * `running`, unbucketed since this rollup shipped. No handler emits `running`
   * today — it is declared so the vocabulary and `STATUS_META` stay in
   * bijection, and bucketed so the first producer does not have to remember
   * this file.
   *
   * @returns {{total: number, done: number, skipped: number, blocked: number, pending: number, running: number, skips: Array<{id: string, kind: string, reason: string}>}}
   */
  function summarizeSkips(pipelineResult) {
    const results = pipelineResult && Array.isArray(pipelineResult.results) ? pipelineResult.results : [];
    const out = { total: results.length, done: 0, skipped: 0, blocked: 0, pending: 0, running: 0, skips: [] };
    for (const r of results) {
      const status = r.status || 'pending';
      if (status === 'done') out.done += 1;
      // #429 — `needs-operator` counts as blocked: it is a step that reported a
      // problem and halted the wrap. It keeps its own badge and banner wording,
      // where the distinction changes what the operator does; here the question
      // is only "how many steps failed to complete".
      else if (status === 'blocked' || status === 'needs-operator') out.blocked += 1;
      else if (status === 'running') out.running += 1;
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
   * Mirrors what the drawer renders — the status banner, the honest skip
   * rollup, and one block per step (status, label, detail, and the full
   * blocker output) — so the copied text is the same source of truth as the
   * on-screen report (#268, #693). The skip rollup reuses `summarizeSkips`,
   * the same helper `renderSkipRoll` paints from, so copy and render can't
   * diverge.
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

    // #693 — mirror the drawer's skip rollup (`renderSkipRoll`) so the copied
    // report is a faithful text twin, not a subset that drops the "N of M
    // skipped, and why" digest a pasting operator relies on.
    const skips = summarizeSkips(pipelineResult);
    if (skips.skipped > 0) {
      lines.push('');
      lines.push(`Skipped ${skips.skipped} of ${skips.total} steps:`);
      for (const s of skips.skips) {
        lines.push(`- ${KIND_LABELS[s.kind] || s.kind} (${s.id}) — ${s.reason}`);
      }
    }

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

  /**
   * #185 — the empty live view of a wrap whose stream has delivered nothing
   * yet. `results` is `pipelineResult.results`-shaped on purpose: every row
   * goes through the same `buildStepRow` the final render uses, so the live
   * drawer and the final drawer cannot disagree about what a status looks
   * like.
   * @returns {{results: object[], blockedAt: string|null, currentStepId: string|null, started: boolean, done: boolean, result: object|null}}
   */
  function emptyWrapLive() {
    return { results: [], blockedAt: null, currentStepId: null, started: false, done: false, result: null };
  }

  /**
   * Find the live row for a step, creating a pending one when the stream
   * never announced it (a `run-start` lost to a reconnect, or a pipeline
   * variant that starts a step it did not list). Mutates `results`.
   * @param {object[]} results - Live rows
   * @param {{stepId: string, kind?: string}} event - The event naming the step
   * @returns {object} The row
   */
  function upsertLiveRow(results, event) {
    let row = results.find((r) => r.stepId === event.stepId);
    if (!row) {
      row = { stepId: event.stepId, kind: typeof event.kind === 'string' ? event.kind : '', status: 'pending', output: null, blockers: [] };
      results.push(row);
    }
    return row;
  }

  /**
   * #185 — fold one wrap-stream event into the live view of a running wrap.
   * Pure: returns a new state, never mutates `live`. The event is the decoded
   * `data` of one SSE frame with the frame's `event` name as `type`:
   *
   *   - `run-start` `{steps}` — every listed step becomes a pending row (the
   *     drawer paints the whole pipeline before the first step moves);
   *   - `step-start` `{stepId, kind}` — that row turns `running` — the tone
   *     the drawer reserved and nothing produced until now;
   *   - `step-done` / `step-blocked` `{stepId, status, output, blockers,
   *     halted}` — the row settles to the runner's own status with the same
   *     output and blockers the final result will carry; `halted:true` marks
   *     the pipeline as stopped there, so the row renders as THE blocker;
   *   - `run-done` `{result}` — the run is over; `result` is the wrap POST's
   *     payload, which the caller renders exactly as a POST return.
   *
   * Unknown types and malformed events leave the state unchanged: the final
   * result is the truth, and a spectator's confusion must not corrupt it.
   *
   * @param {object|null} live - Prior live state, or null before the first event
   * @param {{type: string}} event - One stream event
   * @returns {{results: object[], blockedAt: string|null, currentStepId: string|null, started: boolean, done: boolean, result: object|null}}
   */
  function applyWrapStreamEvent(live, event) {
    const prev = live && typeof live === 'object' && Array.isArray(live.results) ? live : emptyWrapLive();
    const next = { ...prev, results: prev.results.map((r) => ({ ...r })) };
    if (!event || typeof event.type !== 'string') return next;
    switch (event.type) {
      case 'run-start': {
        const steps = Array.isArray(event.steps) ? event.steps : [];
        next.results = steps
          .filter((s) => s && typeof s.stepId === 'string')
          .map((s) => ({ stepId: s.stepId, kind: typeof s.kind === 'string' ? s.kind : '', status: 'pending', output: null, blockers: [] }));
        next.started = true;
        next.blockedAt = null;
        next.currentStepId = null;
        return next;
      }
      case 'step-start': {
        if (typeof event.stepId !== 'string') return next;
        const row = upsertLiveRow(next.results, event);
        row.status = 'running';
        next.currentStepId = event.stepId;
        next.started = true;
        return next;
      }
      case 'step-done':
      case 'step-blocked': {
        if (typeof event.stepId !== 'string') return next;
        const row = upsertLiveRow(next.results, event);
        row.status = typeof event.status === 'string' && event.status
          ? event.status
          : (event.type === 'step-blocked' ? 'blocked' : 'done');
        row.output = event.output === undefined ? null : event.output;
        row.blockers = Array.isArray(event.blockers) ? event.blockers : [];
        if (event.halted === true) next.blockedAt = event.stepId;
        if (next.currentStepId === event.stepId) next.currentStepId = null;
        next.started = true;
        return next;
      }
      case 'run-done':
        next.done = true;
        next.result = event.result && typeof event.result === 'object' ? event.result : null;
        next.currentStepId = null;
        return next;
      default:
        return next;
    }
  }

  /**
   * #185 — the live view as a `pipelineResult`, so the rows render through
   * `buildStepRow` and "Copy report" serialises the run so far through
   * `buildReportText`, both unchanged. `ok` mirrors "has it halted", the way
   * the runner's own `ok` is `blockedAt === null`; `commitSha` stays null
   * because nothing has committed until the final result says so.
   *
   * @param {object|null} live - Live state from `applyWrapStreamEvent`
   * @returns {{ok: boolean, blockedAt: string|null, results: object[], commitSha: null, summary: null, error: null}}
   */
  function liveWrapAsPipelineResult(live) {
    const state = live && typeof live === 'object' && Array.isArray(live.results) ? live : emptyWrapLive();
    return {
      ok: state.blockedAt === null,
      blockedAt: state.blockedAt,
      results: state.results.map((r) => ({ ...r })),
      commitSha: null,
      summary: null,
      error: null
    };
  }

  /**
   * #185 — the drawer banner while a wrap is running: which step it is on,
   * out of how many. Always the `running` tone — a live wrap has no verdict
   * yet, and painting a provisional success or failure on a run that is
   * still moving is the false-report class this drawer exists to end. A halt
   * seen mid-stream is named, but still as "wrapping": the final report is
   * the runner's to deliver.
   *
   * @param {object|null} live - Live state from `applyWrapStreamEvent`
   * @returns {{label: string, tone: 'running', detail: string|null}}
   */
  function summarizeLiveStatus(live) {
    const state = live && typeof live === 'object' && Array.isArray(live.results) ? live : emptyWrapLive();
    if (!state.started) return { label: 'Wrapping — starting…', tone: 'running', detail: null };
    const total = state.results.length;
    const current = state.currentStepId ? state.results.find((r) => r.stepId === state.currentStepId) : null;
    if (current) {
      const ordinal = state.results.indexOf(current) + 1;
      return {
        label: `Wrapping — step ${ordinal} of ${total}`,
        tone: 'running',
        detail: `${KIND_LABELS[current.kind] || current.kind || 'step'} (${current.stepId})`
      };
    }
    if (state.blockedAt) {
      return { label: `Wrapping — stopped at "${state.blockedAt}"`, tone: 'running', detail: 'waiting for the final report' };
    }
    const settled = state.results.filter((r) => r.status !== 'pending' && r.status !== 'running').length;
    return { label: `Wrapping — ${settled} of ${total} steps settled`, tone: 'running', detail: null };
  }

  /**
   * #185 — the banner when the stream failed for good mid-wrap. The wrap is
   * unaffected (the pipeline never waits on a spectator) and the blocking
   * POST still delivers the report; the drawer says so rather than leaving
   * a frozen "step 4 of 14" that reads as a hung wrap.
   * @returns {{label: string, tone: 'running', detail: string}}
   */
  function streamUnavailableStatus() {
    return {
      label: 'Wrapping — live progress unavailable',
      tone: 'running',
      detail: 'the wrap is still running; the report opens when it finishes'
    };
  }

  /**
   * #185 — the stream URL for a run, encoded the way the other wrap routes
   * are addressed.
   * @param {string} projectName
   * @param {string} runId - From the wrap POST / `GET /wrap/status`
   * @returns {string}
   */
  function wrapStreamUrl(projectName, runId) {
    return `/api/sessions/${encodeURIComponent(projectName)}/wrap/stream/${encodeURIComponent(runId)}`;
  }

  const helpers = {
    KIND_LABELS,
    KIND_DESCRIPTIONS,
    STATUS_META,
    buildStepRow,
    composeHandbackPrompt,
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
    shouldStartEndedCountdown,
    isStrandedWrap,
    applyWrapStreamEvent,
    liveWrapAsPipelineResult,
    summarizeLiveStatus,
    streamUnavailableStatus,
    wrapStreamUrl
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
