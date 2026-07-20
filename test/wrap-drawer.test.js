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

describe('wrap-drawer helpers — pr-merge detail (#570)', () => {
  const H = loadHelpers();

  it('surfaces the reason a single enqueue failed', () => {
    // pr-merge never blocks, so `blockers` is always empty — this line is the
    // only place the failure reaches the operator.
    const row = H.buildStepRow({
      stepId: 'apply-pr-resolutions',
      kind: 'pr-merge',
      status: 'done',
      output: {
        warning: true,
        enqueued: 0,
        failures: ['PR #42: auto-merge could not be enqueued — Auto-merge is not allowed']
      },
      blockers: []
    }, {});
    assert.match(row.detail, /PR #42: auto-merge could not be enqueued/);
  });

  it('summarizes when several failed', () => {
    const row = H.buildStepRow({
      stepId: 'apply-pr-resolutions', kind: 'pr-merge', status: 'done',
      output: { failures: ['a', 'b'], enqueued: 0 }, blockers: []
    }, {});
    assert.equal(row.detail, '2 PRs could not be enqueued');
  });

  it('does not let a partial failure read as a total one', () => {
    const row = H.buildStepRow({
      stepId: 'apply-pr-resolutions', kind: 'pr-merge', status: 'done',
      output: { failures: ['PR #42: nope'], enqueued: 1 }, blockers: []
    }, {});
    assert.match(row.detail, /^1 enqueued; PR #42: nope$/);
  });

  it('reports the count on the happy path', () => {
    const row = H.buildStepRow({
      stepId: 'apply-pr-resolutions', kind: 'pr-merge', status: 'done',
      output: { failures: [], enqueued: 1 }, blockers: []
    }, {});
    assert.equal(row.detail, 'Auto-merge enqueued for 1 PR');
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

// #638 — a blocked wrap PR must not render as success. The commit step arms
// auto-merge and returns; the release lands only when the PR merges, so the
// drawer treats an armed-but-unmerged PR as provisional and resolves the true
// outcome (merged/pending/blocked) via GET /wrap/pr-status.
describe('wrap-drawer helpers — #638 wrap-PR reporting', () => {
  const H = loadHelpers();

  const mkResult = (autoPr) => ({
    ok: true, blockedAt: null, commitSha: 'deadbeefcafe0001', summary: null, error: null,
    results: [{ stepId: 'commit', kind: 'commit', status: 'done', output: { commitSha: 'deadbeefcafe0001', autoPr }, blockers: [] }]
  });

  describe('wrapPrInfo', () => {
    it('returns the armed PR handle when the commit opened a wrap PR', () => {
      const pr = H.wrapPrInfo(mkResult({ prUrl: 'https://github.com/o/r/pull/7', autoMergeArmed: true }));
      assert.equal(pr.prUrl, 'https://github.com/o/r/pull/7');
      assert.equal(pr.armed, true);
    });
    it('returns null when no wrap PR was opened (on-feature-branch or local-only)', () => {
      assert.equal(H.wrapPrInfo(mkResult(null)), null);
      assert.equal(H.wrapPrInfo(mkResult({ skippedReason: 'no origin remote' })), null);
    });
    it('surfaces a close-loop error PR (pushed but arm failed)', () => {
      const pr = H.wrapPrInfo(mkResult({ prUrl: 'u', autoMergeArmed: false, error: 'gh pr merge --auto failed' }));
      assert.equal(pr.error, 'gh pr merge --auto failed');
    });
  });

  describe('summarizePipelineStatus with a wrap PR', () => {
    it('an armed-but-unmerged wrap PR is PROVISIONAL, not success (#638 core)', () => {
      const s = H.summarizePipelineStatus(mkResult({ prUrl: 'https://github.com/o/r/pull/7', autoMergeArmed: true }));
      assert.equal(s.tone, 'provisional');
      assert.match(s.label, /pending PR merge/);
      assert.notEqual(s.tone, 'success');
    });
    it('a close-loop error is a warning naming the failure', () => {
      const s = H.summarizePipelineStatus(mkResult({ prUrl: 'u', autoMergeArmed: false, error: 'arm failed' }));
      assert.equal(s.tone, 'warning');
      assert.match(s.detail, /arm failed/);
    });
    it('a commit with NO wrap PR (local-only) is still plain success', () => {
      const s = H.summarizePipelineStatus(mkResult(null));
      assert.equal(s.tone, 'success');
      assert.equal(s.label, 'Wrap committed');
    });
  });

  describe('prOutcomeBanner', () => {
    it('merged → success', () => {
      assert.equal(H.prOutcomeBanner({ outcome: 'merged' }).tone, 'success');
    });
    it('blocked → error, never success (the #636 red-check case)', () => {
      const b = H.prOutcomeBanner({ outcome: 'blocked', state: 'OPEN', mergeStateStatus: 'BLOCKED' });
      assert.equal(b.tone, 'error');
      assert.match(b.label, /BLOCKED/);
    });
    it('closed-unmerged → error with a closed reason', () => {
      const b = H.prOutcomeBanner({ outcome: 'blocked', state: 'CLOSED' });
      assert.match(b.detail, /closed without merging/);
    });
    it('pending → provisional', () => {
      assert.equal(H.prOutcomeBanner({ outcome: 'pending' }).tone, 'provisional');
    });
    it('unknown → provisional with the probe reason', () => {
      const b = H.prOutcomeBanner({ outcome: 'unknown', reason: 'gh not found' });
      assert.equal(b.tone, 'provisional');
      assert.match(b.detail, /gh not found/);
    });
  });
});

// #571 item 4 — honest skip rollup. A wrap that quietly skipped half its steps
// must say so, not read green.
describe('wrap-drawer helpers — summarizeSkips (#571 item 4)', () => {
  const H = loadHelpers();

  it('counts each status and collects skip reasons', () => {
    const roll = H.summarizeSkips({
      results: [
        { stepId: 'open-pr-check', kind: 'pr-check', status: 'done', output: {}, blockers: [] },
        { stepId: 'version-bump', kind: 'version-bump', status: 'skipped', output: { reason: 'no [Unreleased] entries' }, blockers: [] },
        { stepId: 'features-toc', kind: 'features-toc', status: 'skipped', output: { detail: '40 undescribed stubs' }, blockers: [] },
        { stepId: 'commit', kind: 'commit', status: 'done', output: { commitSha: 'x' }, blockers: [] }
      ]
    });
    assert.equal(roll.total, 4);
    assert.equal(roll.done, 2);
    assert.equal(roll.skipped, 2);
    assert.equal(roll.skips.length, 2);
    assert.equal(roll.skips[0].reason, 'no [Unreleased] entries');
    assert.equal(roll.skips[1].reason, '40 undescribed stubs');
  });

  it('empty/malformed input yields zeroed counts, never throws', () => {
    const roll = H.summarizeSkips(null);
    assert.equal(roll.total, 0);
    assert.equal(roll.skipped, 0);
    assert.equal(roll.skips.length, 0);
  });
});

// #638 — the release probe must never erase a problem the pipeline already
// reported. Without composition, a wrap that "completed with warnings" got
// repainted "Wrap shipped — PR merged", re-opening the false-success class this
// work exists to close.
describe('wrap-drawer helpers — composeReleaseBanner precedence', () => {
  const H = loadHelpers();

  it('a BLOCKED release outranks everything, including a clean pipeline', () => {
    const out = H.composeReleaseBanner(
      { label: 'Wrap committed', tone: 'success', detail: 'abc' },
      { outcome: 'blocked', state: 'OPEN', mergeStateStatus: 'BLOCKED' }
    );
    assert.equal(out.tone, 'error');
    assert.match(out.label, /BLOCKED/);
  });

  it('a pipeline WARNING survives a merged release (not repainted as shipped)', () => {
    const out = H.composeReleaseBanner(
      { label: 'Wrap completed with warnings', tone: 'warning', detail: 'Warnings on: project-map' },
      { outcome: 'merged' }
    );
    assert.equal(out.tone, 'warning', 'the warning is not erased by a green release');
    assert.match(out.label, /warnings/);
    assert.match(out.detail, /release: merged/, 'but the release outcome is still reported');
  });

  it('a close-loop error survives a pending release', () => {
    const out = H.composeReleaseBanner(
      { label: 'Wrap committed — release NOT armed', tone: 'warning', detail: 'arm failed' },
      { outcome: 'pending' }
    );
    assert.equal(out.tone, 'warning');
    assert.match(out.detail, /release: pending/);
  });

  it('a clean pipeline takes the release banner as-is', () => {
    const out = H.composeReleaseBanner(
      { label: 'Wrap committed — release pending PR merge', tone: 'provisional', detail: 'sha' },
      { outcome: 'merged' }
    );
    assert.equal(out.tone, 'success');
    assert.match(out.label, /shipped/);
  });

  it('tolerates a missing base status', () => {
    const out = H.composeReleaseBanner(null, { outcome: 'pending' });
    assert.equal(out.tone, 'provisional');
  });
});
