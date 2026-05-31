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

  it('flags warning rows from output.warning', () => {
    const row = H.buildStepRow({
      stepId: 'critic',
      kind: 'critic-check',
      status: 'done',
      output: { warning: true, isMediumPlus: true, criticRan: false },
      blockers: []
    }, {});
    assert.equal(row.warning, true);
    assert.equal(row.isBlocker, false);
    assert.equal(row.detail, 'Medium+ work without Critic dispatch');
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

  it('surfaces version-bump skipped reason', () => {
    const row = H.buildStepRow({
      stepId: 'version',
      kind: 'version-bump',
      status: 'skipped',
      output: { skipped: true, reason: 'No [Unreleased] entries' },
      blockers: []
    }, {});
    assert.equal(row.detail, 'No [Unreleased] entries');
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
        { stepId: 'critic', kind: 'critic-check', status: 'done', output: { warning: true }, blockers: [] },
        { stepId: 'commit', kind: 'commit', status: 'done', output: { commitSha: 'abc' }, blockers: [] }
      ],
      commitSha: 'abc',
      summary: null,
      error: null
    });
    assert.equal(s.tone, 'warning');
    assert.equal(s.label, 'Wrap completed with warnings');
    assert.match(s.detail, /critic/);
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

  it('returns null when stepRow is missing', () => {
    assert.equal(H.decisionWidgetForBlockedStep(null), null);
    assert.equal(H.decisionWidgetForBlockedStep(undefined), null);
  });
});

describe('wrap-drawer helpers — warningWidgetForStep', () => {
  const H = loadHelpers();

  it('returns textarea widget for critic-check warning', () => {
    const w = H.warningWidgetForStep({
      warning: true,
      kind: 'critic-check'
    });
    assert.equal(w.kind, 'critic-check');
    assert.equal(w.inputType, 'textarea');
    assert.equal(w.optionsKey, 'criticSkipRationale');
  });

  it('returns null when warning is false', () => {
    assert.equal(H.warningWidgetForStep({ warning: false, kind: 'critic-check' }), null);
  });

  it('returns null for warning kinds without a widget', () => {
    assert.equal(H.warningWidgetForStep({ warning: true, kind: 'unknown-kind' }), null);
  });
});

describe('wrap-drawer helpers — prCheckResolutionWidget', () => {
  const H = loadHelpers();

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

describe('wrap-drawer helpers — collectOptionsFromAccessors', () => {
  const H = loadHelpers();

  it('collects skipTests when checkbox is checked', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => true,
      criticSkipRationale: () => '',
      prHandling: () => null
    });
    assert.deepEqual(plain(opts), { skipTests: true });
  });

  it('omits skipTests when checkbox is unchecked', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => false,
      criticSkipRationale: () => '',
      prHandling: () => null
    });
    assert.deepEqual(plain(opts), {});
  });

  it('trims and includes criticSkipRationale when non-empty', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => false,
      criticSkipRationale: () => '  short turn, deferring to next session  ',
      prHandling: () => null
    });
    assert.equal(opts.criticSkipRationale, 'short turn, deferring to next session');
  });

  it('omits empty/whitespace-only rationale', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => false,
      criticSkipRationale: () => '   ',
      prHandling: () => null
    });
    assert.equal(opts.criticSkipRationale, undefined);
  });

  it('collects prHandling map filtering out empty selections', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => false,
      criticSkipRationale: () => '',
      prHandling: () => ({ '42': 'merge', '43': '', '44': 'defer' })
    });
    assert.deepEqual(plain(opts.prHandling), { '42': 'merge', '44': 'defer' });
  });

  it('omits prHandling key when no PRs have a resolution', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => false,
      criticSkipRationale: () => '',
      prHandling: () => ({ '42': '', '43': '' })
    });
    assert.equal(opts.prHandling, undefined);
  });

  it('combines all three when all are present', () => {
    const opts = H.collectOptionsFromAccessors({
      skipTests: () => true,
      criticSkipRationale: () => 'reason',
      prHandling: () => ({ '99': 'ignore' })
    });
    assert.deepEqual(plain(opts), {
      skipTests: true,
      criticSkipRationale: 'reason',
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
