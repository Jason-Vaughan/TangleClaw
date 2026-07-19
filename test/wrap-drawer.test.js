'use strict';

/*
 * Unit tests for the pure helpers in `public/wrap-drawer.js` (#139 Chunk 10).
 *
 * The helpers translate the runner's `pipelineResult` shape into a view
 * model that the drawer renders, plus collect retry-options out of the
 * decision-widget DOM. Mirrors the vm-sandbox pattern from
 * `frontend-api-errors.test.js` — load the helper into a sandbox once,
 * exercise the exported functions. DOM is unavailable here, but the
 * helpers are intentionally DOM-free so they're testable in pure Node.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HELPER_PATH = path.join(__dirname, '..', 'public', 'wrap-drawer.js');
const HELPER_SRC = fs.readFileSync(HELPER_PATH, 'utf8');

/**
 * Build a sandbox with a `window` shim and evaluate wrap-drawer.js into
 * it. Returns the `tcWrapDrawerHelpers` namespace attached to window.
 * @returns {object} helpers
 */
function loadHelpers() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(HELPER_SRC, sandbox);
  return sandbox.window.tcWrapDrawerHelpers;
}

/**
 * Strip vm-context Object.prototype identity so `assert.deepStrictEqual`
 * compares structurally. Objects produced inside the vm sandbox have a
 * different `Object.prototype` than the outer test context, which
 * deepStrictEqual rejects as not-reference-equal.
 * @template T
 * @param {T} v
 * @returns {T}
 */
function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

describe('wrap-drawer helpers — buildStepRow', () => {
  const H = loadHelpers();

  it('translates a done step', () => {
    const row = H.buildStepRow({
      stepId: 'commit',
      kind: 'commit',
      status: 'done',
      output: { commitSha: 'abc123def4567' },
      blockers: []
    }, { blockedAt: null });
    assert.equal(row.id, 'commit');
    assert.equal(row.kind, 'commit');
    assert.equal(row.kindLabel, 'Commit');
    assert.equal(row.status, 'done');
    assert.equal(row.statusLabel, 'Done');
    assert.equal(row.statusTone, 'done');
    assert.equal(row.detail, 'abc123def456'); // 12-char prefix
    assert.equal(row.isBlocker, false);
    assert.equal(row.warning, false);
  });

  it('#467 — commit detail appends the auto-PR outcome when autoPr is present', () => {
    const mk = (autoPr) => H.buildStepRow({
      stepId: 'commit', kind: 'commit', status: 'done',
      output: { commitSha: 'abc123def4567', autoPr }, blockers: []
    }, { blockedAt: null }).detail;

    assert.equal(
      mk({ autoMergeArmed: true, prUrl: 'https://x/pull/1', error: null, skippedReason: null }),
      'abc123def456 · wrap PR auto-merge armed');
    assert.equal(
      mk({ autoMergeArmed: false, prUrl: 'https://x/pull/1', error: 'merge arm failed', skippedReason: null }),
      'abc123def456 · wrap PR opened (auto-merge NOT armed)');
    assert.equal(
      mk({ autoMergeArmed: false, prUrl: null, error: 'git push failed', skippedReason: null }),
      'abc123def456 · wrap PR failed — branch dangling');
    assert.equal(
      mk({ autoMergeArmed: false, prUrl: null, error: null, skippedReason: 'no origin remote — nowhere to land the wrap branch' }),
      'abc123def456 · wrap PR skipped: no origin remote — nowhere to land the wrap branch');
    assert.equal(mk(null), 'abc123def456',
      'autoPr:null (no auto-branch) keeps the bare SHA detail');
  });

  it('flags the blocking step when stepId matches blockedAt', () => {
    const row = H.buildStepRow({
      stepId: 'test',
      kind: 'test',
      status: 'blocked',
      output: { exitCode: 1 },
      blockers: ['Test suite failed (exit 1)']
    }, { blockedAt: 'test' });
    assert.equal(row.isBlocker, true);
    assert.equal(row.statusTone, 'blocked');
    assert.deepEqual(row.blockers, ['Test suite failed (exit 1)']);
  });

  it('flags warning rows from output.warning regardless of kind', () => {
    // `output.warning` is a kind-agnostic channel — any handler may set it.
    const row = H.buildStepRow({
      stepId: 'some-step',
      kind: 'project-map',
      status: 'done',
      output: { warning: true },
      blockers: []
    }, {});
    assert.equal(row.warning, true);
    assert.equal(row.isBlocker, false);
  });

  it('falls back to raw kind for unknown step kinds', () => {
    const row = H.buildStepRow({
      stepId: 'custom-1',
      kind: 'custom-future-kind',
      status: 'done',
      output: null,
      blockers: []
    }, {});
    assert.equal(row.kindLabel, 'custom-future-kind');
  });

  it('handles missing output gracefully', () => {
    const row = H.buildStepRow({
      stepId: 'lint',
      kind: 'lint',
      status: 'done',
      output: null,
      blockers: []
    }, {});
    assert.equal(row.detail, null);
    assert.equal(row.warning, false);
  });

  it('builds pr-check detail from session-scope + other-open counts', () => {
    const row = H.buildStepRow({
      stepId: 'prs',
      kind: 'pr-check',
      status: 'done',
      output: { counts: { sessionScoped: 2, otherOpen: 5 } },
      blockers: []
    }, {});
    assert.equal(row.detail, '2 session PRs, 5 other open');
  });

  it('singularizes the pr-check detail correctly', () => {
    const row = H.buildStepRow({
      stepId: 'prs',
      kind: 'pr-check',
      status: 'done',
      output: { counts: { sessionScoped: 1, otherOpen: 0 } },
      blockers: []
    }, {});
    assert.equal(row.detail, '1 session PR');
  });

  it('surfaces priming-roll target chunk in detail', () => {
    const row = H.buildStepRow({
      stepId: 'priming',
      kind: 'priming-roll',
      status: 'done',
      output: { current: '10', allDone: false },
      blockers: []
    }, {});
    assert.equal(row.detail, '→ chunk 10');
  });

  it('surfaces ai-content captured field count', () => {
    const row = H.buildStepRow({
      stepId: 'memory-update',
      kind: 'ai-content',
      status: 'done',
      output: { capturedText: 'foo', parsedFields: { summary: 'x', nextSteps: 'y', learnings: 'z' } },
      blockers: []
    }, {});
    assert.equal(row.detail, 'captured 3 fields');
  });

  it('surfaces ai-content singular field count', () => {
    const row = H.buildStepRow({
      stepId: 'memory-update',
      kind: 'ai-content',
      status: 'done',
      output: { capturedText: 'foo', parsedFields: { summary: 'x' } },
      blockers: []
    }, {});
    assert.equal(row.detail, 'captured 1 field');
  });

  it('surfaces ai-content captured (no parsedFields) when text present', () => {
    const row = H.buildStepRow({
      stepId: 'memory-update',
      kind: 'ai-content',
      status: 'done',
      output: { capturedText: 'some text', parsedFields: null },
      blockers: []
    }, {});
    assert.equal(row.detail, 'captured');
  });

  it('surfaces version-bump from→to when both present', () => {
    const row = H.buildStepRow({
      stepId: 'version',
      kind: 'version-bump',
      status: 'done',
      output: { from: '3.16.2', to: '3.17.0' },
      blockers: []
    }, {});
    assert.equal(row.detail, '3.16.2 → 3.17.0');
  });

  it('surfaces version-bump skipped reason from status, with no output.skipped flag (#204)', () => {
    const row = H.buildStepRow({
      stepId: 'version',
      kind: 'version-bump',
      status: 'skipped',
      output: { reason: 'No [Unreleased] entries', detail: 'No [Unreleased] entries' },
      blockers: []
    }, {});
    assert.equal(row.detail, 'No [Unreleased] entries');
  });

  it('derives skip detail from status for any kind, even those with no skip branch (#204)', () => {
    // lint/test/ai-content previously had no `output.skipped` branch;
    // the canonical status check now surfaces their skip reason uniformly.
    const mk = (kind, output) => H.buildStepRow({ stepId: kind, kind, status: 'skipped', output, blockers: [] }, {}).detail;
    assert.equal(mk('lint', { reason: 'no lintCommand configured' }), 'no lintCommand configured');
    assert.equal(mk('test', { override: true, reason: 'user opted to skip tests' }), 'user opted to skip tests');
    assert.equal(mk('commit', { reason: 'no changes to commit' }), 'no changes to commit');
    // detail wins over reason; bare skip with no output → 'Skipped'.
    assert.equal(mk('pr-check', { detail: 'Skipped', reason: 'ignored' }), 'Skipped');
    assert.equal(mk('ai-content', null), 'Skipped');
  });

  it('does not treat a stale output.skipped on a non-skipped step as a skip (#204)', () => {
    // Canonical signal is status, not the (now-removed) output.skipped flag.
    const row = H.buildStepRow({
      stepId: 'commit', kind: 'commit', status: 'done',
      output: { skipped: true, commitSha: 'abc123def456' }, blockers: []
    }, {});
    assert.equal(row.detail, 'abc123def456'.slice(0, 12));
  });
});

describe('wrap-drawer helpers — KIND_DESCRIPTIONS (per-step help)', () => {
  const H = loadHelpers();
  // The canonical wrap-step kinds (mirrors test/wrap-pipeline.test.js realKinds).
  const CANONICAL_KINDS = [
    'lint', 'test', 'ai-content', 'learnings-db-write', 'priming-roll',
    'pr-check', 'commit', 'version-bump', 'features-toc',
    'project-map', 'index-describe', 'continuity-write'
  ];

  it('has a non-empty help description for every canonical wrap-step kind (drift guard)', () => {
    for (const k of CANONICAL_KINDS) {
      const d = H.KIND_DESCRIPTIONS[k];
      assert.ok(typeof d === 'string' && d.trim().length > 0,
        `KIND_DESCRIPTIONS is missing a description for kind "${k}"`);
    }
  });

  it('buildStepRow surfaces the kind description as kindTooltip', () => {
    const row = H.buildStepRow(
      { stepId: 'next-session-prime', kind: 'priming-roll', status: 'skipped' }, {});
    assert.equal(row.kindTooltip, H.KIND_DESCRIPTIONS['priming-roll']);
    assert.ok(row.kindTooltip.length > 0);
  });

  it('buildStepRow returns an empty kindTooltip for an unknown kind (no crash)', () => {
    const row = H.buildStepRow({ stepId: 'x', kind: 'totally-unknown', status: 'done' }, {});
    assert.equal(row.kindTooltip, '');
  });
});

describe('wrap-drawer helpers — summarizePipelineStatus', () => {
  const H = loadHelpers();

  it('returns success + commit sha when all steps clean', () => {
    const s = H.summarizePipelineStatus({
      ok: true,
      blockedAt: null,
      results: [{ stepId: 'commit', kind: 'commit', status: 'done', output: {}, blockers: [] }],
      commitSha: 'a1b2c3d4e5f6g7h8',
      summary: null,
      error: null
    });
    assert.equal(s.tone, 'success');
    assert.equal(s.label, 'Wrap committed');
    assert.equal(s.detail, 'a1b2c3d4e5f6');
  });

  it('returns success without sha when no commit produced', () => {
    const s = H.summarizePipelineStatus({
      ok: true,
      blockedAt: null,
      results: [],
      commitSha: null,
      summary: null,
      error: null
    });
    assert.equal(s.tone, 'success');
    assert.equal(s.label, 'Wrap completed (no changes to commit)');
  });

  it('returns blocked + reason when blockedAt is set', () => {
    const s = H.summarizePipelineStatus({
      ok: false,
      blockedAt: 'test',
      results: [{ stepId: 'test', kind: 'test', status: 'blocked', output: { exitCode: 1 }, blockers: ['Test suite failed'] }],
      commitSha: null,
      summary: null,
      error: null
    });
    assert.equal(s.tone, 'blocked');
    assert.equal(s.label, 'Blocked at "test"');
    assert.equal(s.detail, 'Test suite failed');
  });

  it('returns warning when ok:true but a step has output.warning', () => {
    const s = H.summarizePipelineStatus({
      ok: true,
      blockedAt: null,
      results: [
        { stepId: 'project-map', kind: 'project-map', status: 'done', output: { warning: true }, blockers: [] },
        { stepId: 'commit', kind: 'commit', status: 'done', output: { commitSha: 'abc' }, blockers: [] }
      ],
      commitSha: 'abc',
      summary: null,
      error: null
    });
    assert.equal(s.tone, 'warning');
    assert.equal(s.label, 'Wrap completed with warnings');
    assert.match(s.detail, /project-map/);
  });

  it('returns error when top-level error is set without blockedAt', () => {
    const s = H.summarizePipelineStatus({
      ok: false,
      blockedAt: null,
      results: [],
      commitSha: null,
      summary: null,
      error: 'wrap pipeline threw: ENOENT'
    });
    assert.equal(s.tone, 'error');
    assert.match(s.label, /failed/i);
    assert.match(s.detail, /ENOENT/);
  });

  it('returns error when input is malformed', () => {
    assert.equal(H.summarizePipelineStatus(null).tone, 'error');
    assert.equal(H.summarizePipelineStatus(undefined).tone, 'error');
  });
});

describe('wrap-drawer helpers — decisionWidgetForBlockedStep', () => {
  const H = loadHelpers();

  it('returns checkbox widget for blocked test step', () => {
    const w = H.decisionWidgetForBlockedStep({
      isBlocker: true,
      kind: 'test'
    });
    assert.equal(w.kind, 'test');
    assert.equal(w.inputType, 'checkbox');
    assert.equal(w.optionsKey, 'skipTests');
  });

  it('returns null for non-blocked rows', () => {
    const w = H.decisionWidgetForBlockedStep({
      isBlocker: false,
      kind: 'test'
    });
    assert.equal(w, null);
  });

  it('returns null for blocked steps with no recovery widget', () => {
    // lint blocked → user must fix outside drawer; no override
    const w = H.decisionWidgetForBlockedStep({
      isBlocker: true,
      kind: 'lint'
    });
    assert.equal(w, null);
  });

  it('returns a step-scoped checkbox widget for a blocked ai-content step (#328)', () => {
    const w = H.decisionWidgetForBlockedStep({
      isBlocker: true,
      kind: 'ai-content',
      id: 'memory-update'
    });
    assert.equal(w.kind, 'ai-content');
    assert.equal(w.inputType, 'checkbox');
    assert.equal(w.optionsKey, 'skipAiContent');
    assert.equal(w.stepId, 'memory-update', 'widget carries the blocked step id so retry can scope the skip');
  });

  it('returns null when stepRow is missing', () => {
    assert.equal(H.decisionWidgetForBlockedStep(null), null);
    assert.equal(H.decisionWidgetForBlockedStep(undefined), null);
  });
});

describe('wrap-drawer helpers — prCheckResolutionWidget', () => {
  const H = loadHelpers();

  it('still offers the resolution list when the step BLOCKED on it', () => {
    // The blocked pr-check IS the unresolved-PR gate — if the widget stopped
    // rendering for blocked rows the operator would have no way to answer it.
    const w = H.prCheckResolutionWidget(
      { kind: 'pr-check', status: 'blocked', isBlocker: true },
      {
        sessionScoped: [{ number: 42, title: 'feat: x', url: 'https://x', headRefName: 'feat/x' }],
        resolutions: {}
      }
    );
    assert.ok(w, 'a blocked pr-check must still produce its resolution widget');
    assert.equal(w.prs[0].number, 42);
  });

  it('returns prs to resolve when session-scoped + unresolved', () => {
    const w = H.prCheckResolutionWidget(
      { kind: 'pr-check' },
      {
        sessionScoped: [
          { number: 42, title: 'feat: x', url: 'https://x', headRefName: 'feat/x' },
          { number: 43, title: 'fix: y', url: 'https://y', headRefName: 'fix/y' }
        ],
        resolutions: {}
      }
    );
    assert.equal(w.kind, 'pr-check');
    assert.equal(w.optionsKey, 'prHandling');
    assert.equal(w.prs.length, 2);
    assert.equal(w.prs[0].number, 42);
    assert.equal(w.prs[0].branch, 'feat/x');
  });

  it('filters out already-resolved prs', () => {
    const w = H.prCheckResolutionWidget(
      { kind: 'pr-check' },
      {
        sessionScoped: [
          { number: 42, title: 'a' },
          { number: 43, title: 'b' }
        ],
        resolutions: { '42': 'merge' }
      }
    );
    assert.equal(w.prs.length, 1);
    assert.equal(w.prs[0].number, 43);
  });

  it('returns null when no session-scoped prs', () => {
    const w = H.prCheckResolutionWidget(
      { kind: 'pr-check' },
      { sessionScoped: [], resolutions: {} }
    );
    assert.equal(w, null);
  });

  it('returns null when all prs are already resolved', () => {
    const w = H.prCheckResolutionWidget(
      { kind: 'pr-check' },
      {
        sessionScoped: [{ number: 42, title: 'a' }],
        resolutions: { '42': 'defer' }
      }
    );
    assert.equal(w, null);
  });

  it('returns null for non-pr-check kinds', () => {
    const w = H.prCheckResolutionWidget(
      { kind: 'test' },
      { sessionScoped: [{ number: 1 }] }
    );
    assert.equal(w, null);
  });
});

describe('wrap-drawer helpers — planPickerWidget (#428)', () => {
  const H = loadHelpers();

  it('returns candidates for a blocked priming-roll with candidates', () => {
    const w = H.planPickerWidget(
      { kind: 'priming-roll', status: 'blocked' },
      { candidates: ['one.md', 'two.md'], remediation: '...' }
    );
    assert.equal(w.kind, 'priming-roll');
    assert.deepEqual(w.candidates, ['one.md', 'two.md']);
  });

  it('filters out blank/non-string candidate entries', () => {
    const w = H.planPickerWidget(
      { kind: 'priming-roll', status: 'blocked' },
      { candidates: ['ok.md', '', '   ', 5, null, 'two.md'] }
    );
    assert.deepEqual(w.candidates, ['ok.md', 'two.md']);
  });

  it('returns null when the priming-roll step is not blocked', () => {
    const w = H.planPickerWidget(
      { kind: 'priming-roll', status: 'done' },
      { candidates: ['one.md'] }
    );
    assert.equal(w, null);
  });

  it('returns null when there are no candidates', () => {
    assert.equal(H.planPickerWidget({ kind: 'priming-roll', status: 'blocked' }, { remediation: 'x' }), null);
    assert.equal(H.planPickerWidget({ kind: 'priming-roll', status: 'blocked' }, { candidates: [] }), null);
  });

  it('returns null for a non-priming-roll kind', () => {
    const w = H.planPickerWidget(
      { kind: 'pr-check', status: 'blocked' },
      { candidates: ['one.md'] }
    );
    assert.equal(w, null);
  });

  it('returns null on missing/invalid rawOutput', () => {
    assert.equal(H.planPickerWidget({ kind: 'priming-roll', status: 'blocked' }, null), null);
    assert.equal(H.planPickerWidget(null, { candidates: ['x.md'] }), null);
  });
});

describe('wrap-drawer helpers — collectOptionsFromAccessors', () => {
  const H = loadHelpers();

  it('collects skipTests when checkbox is checked', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => true,
      prHandling: () => null
    });
    assert.deepEqual(plain(opts), { skipTests: true });
  });

  it('omits skipTests when checkbox is unchecked', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => false,
      prHandling: () => null
    });
    assert.deepEqual(plain(opts), {});
  });

  it('builds skipAiContent map from the blocked step id (#328)', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => false,
      skipAiContent: () => 'memory-update'
    });
    assert.deepEqual(plain(opts), { skipAiContent: { 'memory-update': true } });
  });

  it('omits skipAiContent when the accessor returns null (box unchecked) (#328)', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => false,
      skipAiContent: () => null
    });
    assert.deepEqual(plain(opts), {});
  });
});

describe('wrap-drawer helpers — accumulateAiContentSkips (#328)', () => {
  const H = loadHelpers();

  it('persists an earlier skip across a later retry that skips a different step', () => {
    const acc = {};
    // Retry 1: changelog-update blocked → skipped.
    const opts1 = { skipAiContent: { 'changelog-update': true } };
    H.accumulateAiContentSkips(acc, opts1);
    assert.deepEqual(plain(opts1.skipAiContent), { 'changelog-update': true });
    // Retry 2: memory-update blocked → skipped; changelog-update must survive.
    const opts2 = { skipAiContent: { 'memory-update': true } };
    H.accumulateAiContentSkips(acc, opts2);
    assert.deepEqual(plain(opts2.skipAiContent), {
      'changelog-update': true,
      'memory-update': true
    });
  });

  it('reflects the accumulated set even on a retry that adds no new skip', () => {
    const acc = { 'changelog-update': true };
    const opts = {}; // user retried (e.g. after a manual MEMORY edit) without ticking a box
    H.accumulateAiContentSkips(acc, opts);
    assert.deepEqual(plain(opts.skipAiContent), { 'changelog-update': true });
  });

  it('leaves options untouched when nothing has ever been skipped', () => {
    const acc = {};
    const opts = { skipTests: true };
    H.accumulateAiContentSkips(acc, opts);
    assert.deepEqual(plain(opts), { skipTests: true });
    assert.equal(opts.skipAiContent, undefined);
  });

  it('returns the (mutated) accumulator', () => {
    const acc = {};
    const out = H.accumulateAiContentSkips(acc, { skipAiContent: { 'memory-update': true } });
    assert.equal(out, acc);
    assert.deepEqual(plain(acc), { 'memory-update': true });
  });

  it('collects prHandling map filtering out empty selections', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => false,
      prHandling: () => ({ '42': 'merge', '43': '', '44': 'defer' })
    });
    assert.deepEqual(plain(opts.prHandling), { '42': 'merge', '44': 'defer' });
  });

  it('omits prHandling key when no PRs have a resolution', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => false,
      prHandling: () => ({ '42': '', '43': '' })
    });
    assert.equal(opts.prHandling, undefined);
  });

  it('combines every option when all are present', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => true,
      prHandling: () => ({ '99': 'ignore' })
    });
    assert.deepEqual(plain(opts), {
      skipTests: true,
      prHandling: { '99': 'ignore' }
    });
  });

  it('tolerates missing accessor keys', () => {
    const opts = H.collectOptionsFromAccessors({});
    assert.deepEqual(plain(opts), {});
  });
});

describe('wrap-drawer helpers — buildReportText (#268)', () => {
  const H = loadHelpers();

  it('serializes a blocked pipeline with the full step output', () => {
    const text = H.buildReportText({
      blockedAt: 'commit',
      results: [
        { stepId: 'test', kind: 'test', status: 'done', output: { exitCode: 0 }, blockers: [] },
        {
          stepId: 'commit',
          kind: 'commit',
          status: 'blocked',
          output: {},
          blockers: ['git commit failed (exit 1)', 'FAIL src/medusa/medusa-server.test.js']
        }
      ]
    });
    // Header carries the blocked status + reason (first blocker of the blocked step).
    assert.match(text, /Session Wrap — Blocked at "commit"/);
    assert.match(text, /git commit failed \(exit 1\)/);
    // Every step appears, with its status label.
    assert.match(text, /\[Done\] Run tests — test/);
    assert.match(text, /\[Blocked\] Commit — commit/);
    // The full failure output (not just the first line) is captured.
    assert.match(text, /FAIL src\/medusa\/medusa-server\.test\.js/);
  });

  it('does not throw on a malformed / empty pipeline result', () => {
    assert.match(H.buildReportText(null), /Wrap result unavailable/);
    assert.match(H.buildReportText({}), /Session Wrap —/);
    // No results array → header only, no step blocks.
    assert.equal(H.buildReportText({ commitSha: 'abc123def456' }).split('\n\n').length, 1);
  });
});

describe('wrap-drawer helpers — shouldStartEndedCountdown (#268)', () => {
  const H = loadHelpers();

  it('suppresses the auto-redirect countdown while the drawer is open', () => {
    assert.equal(H.shouldStartEndedCountdown({ wrapDrawerOpen: true }), false);
  });

  it('allows the countdown when the drawer is closed or state is absent', () => {
    assert.equal(H.shouldStartEndedCountdown({ wrapDrawerOpen: false }), true);
    assert.equal(H.shouldStartEndedCountdown({}), true);
    assert.equal(H.shouldStartEndedCountdown(undefined), true);
  });
});

describe('wrap-drawer helpers — wrapWatchDecision (#583)', () => {
  const H = loadHelpers();

  it('a running run is watched', () => {
    assert.equal(H.wrapWatchDecision({ running: true, result: null, finishedAt: null }, 1000), 'watch');
    // running wins even when a stale result rides along in the payload
    assert.equal(H.wrapWatchDecision({ running: true, result: { ok: true }, finishedAt: 1 }, 1000), 'watch');
  });

  it('a finished run at/after the POST instant renders as this wrap\'s outcome', () => {
    const result = { ok: true, pipelineResult: {} };
    assert.equal(H.wrapWatchDecision({ running: false, result, finishedAt: 1000 }, 1000), 'render');
    assert.equal(H.wrapWatchDecision({ running: false, result, finishedAt: 5000 }, 1000), 'render');
  });

  it('THE STALE PIN: a result older than the POST must never render as this wrap\'s', () => {
    const result = { ok: true, pipelineResult: {} };
    assert.equal(H.wrapWatchDecision({ running: false, result, finishedAt: 999 }, 1000), 'error');
  });

  it('nothing to reattach to → error (no run, no result, bad shapes)', () => {
    assert.equal(H.wrapWatchDecision(null, 1000), 'error');
    assert.equal(H.wrapWatchDecision(undefined, 1000), 'error');
    assert.equal(H.wrapWatchDecision('not-an-object', 1000), 'error');
    assert.equal(H.wrapWatchDecision({ running: false, result: null, finishedAt: null }, 1000), 'error');
    assert.equal(H.wrapWatchDecision({ running: false, result: { ok: true }, finishedAt: null }, 1000), 'error');
    // a non-number postStartedAtMs can't prove freshness — refuse to render
    assert.equal(H.wrapWatchDecision({ running: false, result: { ok: true }, finishedAt: 5000 }, undefined), 'error');
  });
});

describe('wrap-drawer helpers — status tooltips (#222)', () => {
  const H = loadHelpers();

  it('every known status has a non-empty tooltip', () => {
    for (const status of ['pending', 'running', 'done', 'blocked', 'skipped']) {
      const row = H.buildStepRow({ stepId: 's', kind: 'test', status, output: null, blockers: [] });
      assert.equal(typeof row.statusTooltip, 'string');
      assert.ok(row.statusTooltip.length > 0, `${status} must carry a tooltip`);
    }
  });

  it('unknown status falls back to an empty tooltip without throwing', () => {
    const row = H.buildStepRow({ stepId: 's', kind: 'test', status: 'weird', output: null, blockers: [] });
    assert.equal(row.statusTooltip, '');
    assert.equal(row.statusLabel, 'weird');
  });
});

describe('wrap-drawer helpers — remediation surfacing (#223)', () => {
  const H = loadHelpers();

  it('surfaces output.remediation on a blocked step', () => {
    const row = H.buildStepRow({
      stepId: 'commit',
      kind: 'commit',
      status: 'blocked',
      output: { remediation: 'Fix the pre-commit hook output, then re-run.' },
      blockers: ['git commit failed']
    });
    assert.equal(row.remediation, 'Fix the pre-commit hook output, then re-run.');
  });

  it('trims remediation and treats blank/absent/non-string as null (back-compat)', () => {
    const mk = (output) => H.buildStepRow({ stepId: 's', kind: 'test', status: 'blocked', output, blockers: [] }).remediation;
    assert.equal(mk({ remediation: '  spaced  ' }), 'spaced');
    assert.equal(mk({ remediation: '   ' }), null);
    assert.equal(mk({ remediation: 42 }), null);
    assert.equal(mk({}), null);
    assert.equal(mk(null), null);
  });

  it('buildReportText appends a "How to fix" line when remediation is present', () => {
    const text = H.buildReportText({
      blockedAt: 'commit',
      results: [
        { stepId: 'commit', kind: 'commit', status: 'blocked', output: { remediation: 'Do the thing.' }, blockers: ['boom'] }
      ]
    });
    assert.match(text, /How to fix: Do the thing\./);
  });

  it('buildReportText omits the "How to fix" line when remediation is absent', () => {
    const text = H.buildReportText({
      blockedAt: 'commit',
      results: [
        { stepId: 'commit', kind: 'commit', status: 'blocked', output: {}, blockers: ['boom'] }
      ]
    });
    assert.equal(/How to fix:/.test(text), false);
  });
});
