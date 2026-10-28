'use strict';

// Release readiness (#1492 L1): the deterministic verdict a wrap consults
// before cutting a release. The aggregation is pure, so it is tested
// exhaustively; the build-plan signal reads real files in a temp project,
// shaped like Prawduct's `project-state.yaml` pointer (relative to
// `.prawduct/`, unset meaning `artifacts/build-plan.md`).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rr = require('../lib/release-readiness');

const sig = (id, state) => ({ id, state, detail: `${id} is ${state}` });

describe('evaluateReleaseReadiness', () => {
  it('is ready when every applicable signal passes', () => {
    const r = rr.evaluateReleaseReadiness([sig('a', 'pass'), sig('b', 'n/a')]);
    assert.equal(r.verdict, 'ready');
    assert.match(r.reason, /a: a is pass/);
  });

  it('is not-ready when any signal fails, even beside an unknown', () => {
    const r = rr.evaluateReleaseReadiness([sig('a', 'pass'), sig('b', 'unknown'), sig('c', 'fail')]);
    assert.equal(r.verdict, 'not-ready');
    assert.equal(r.reason, 'c: c is fail', 'names only the deciding signal');
  });

  it('is unknown when a signal is unknown and none fails', () => {
    const r = rr.evaluateReleaseReadiness([sig('a', 'pass'), sig('b', 'unknown')]);
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.reason, 'b: b is unknown');
  });

  it('is unknown, never ready, when nothing passed', () => {
    assert.equal(rr.evaluateReleaseReadiness([]).verdict, 'unknown');
    assert.equal(rr.evaluateReleaseReadiness([sig('a', 'n/a')]).verdict, 'unknown');
    assert.equal(rr.evaluateReleaseReadiness(undefined).verdict, 'unknown');
  });

  it('is unknown when a signal carries a state it does not define', () => {
    const r = rr.evaluateReleaseReadiness([sig('a', 'pass'), sig('b', 'PASS')]);
    assert.equal(r.verdict, 'unknown');
    assert.match(r.reason, /unrecognized state \(b\)/);
    assert.equal(rr.evaluateReleaseReadiness([sig('a', 'pass'), null]).verdict, 'unknown');
  });

  it('returns the signals it judged', () => {
    const signals = [sig('a', 'pass')];
    assert.deepEqual(rr.evaluateReleaseReadiness(signals).signals, signals);
  });
});

describe('unreleasedEntriesSignal', () => {
  it('passes with entries, fails when empty', () => {
    assert.equal(rr.unreleasedEntriesSignal({ found: true, sectionFound: true, hasEntries: true }).state, 'pass');
    assert.equal(rr.unreleasedEntriesSignal({ found: true, sectionFound: true, hasEntries: false }).state, 'fail');
  });

  it('is unknown without a CHANGELOG or an [Unreleased] section', () => {
    assert.equal(rr.unreleasedEntriesSignal({ found: false }).state, 'unknown');
    assert.equal(rr.unreleasedEntriesSignal({ found: true, sectionFound: false }).state, 'unknown');
    assert.equal(rr.unreleasedEntriesSignal(undefined).state, 'unknown');
  });

  it('passes on pending changelog fragments with an empty [Unreleased] (#1220)', () => {
    const s = rr.unreleasedEntriesSignal({ found: true, sectionFound: true, hasEntries: false, fragments: { ok: true, count: 3 } });
    assert.equal(s.state, 'pass');
    assert.match(s.detail, /3 changelog fragment\(s\) wait under changelog\.d\//);
    const both = rr.unreleasedEntriesSignal({ found: true, sectionFound: true, hasEntries: true, fragments: { ok: true, count: 1 } });
    assert.equal(both.state, 'pass');
    assert.match(both.detail, /1 of them changelog fragment/);
  });

  it('is unknown on a refused fragment set, whatever [Unreleased] holds (#1220)', () => {
    for (const hasEntries of [true, false]) {
      const s = rr.unreleasedEntriesSignal({ found: true, sectionFound: true, hasEntries, fragments: { ok: false, count: 0 } });
      assert.equal(s.state, 'unknown', `hasEntries ${hasEntries}`);
      assert.match(s.detail, /fragment contract refuses/);
    }
  });

  it('still fails when [Unreleased] is empty and no fragment is pending, and without the fragment facts at all', () => {
    assert.equal(rr.unreleasedEntriesSignal({ found: true, sectionFound: true, hasEntries: false, fragments: { ok: true, count: 0 } }).state, 'fail');
    assert.equal(rr.unreleasedEntriesSignal({ found: true, sectionFound: true, hasEntries: false }).state, 'fail');
    // A section with no heading cannot take a compiled fragment, so pending ones do not make it readable.
    assert.equal(rr.unreleasedEntriesSignal({ found: true, sectionFound: false, hasEntries: false, fragments: { ok: true, count: 2 } }).state, 'unknown');
  });
});

describe('buildPlanStatusSignal', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const writeState = (body) => {
    fs.mkdirSync(path.join(root, '.prawduct'), { recursive: true });
    fs.writeFileSync(path.join(root, '.prawduct', 'project-state.yaml'), body);
  };
  const writePlan = (rel, body) => {
    const p = path.join(root, '.prawduct', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  const PLAN = (boxes) => `# Plan\n\n## Status\n\n${boxes}\n\n## Notes\n\n- [ ] not a status box\n`;

  it('is n/a for a project with no project-state file', () => {
    assert.equal(rr.buildPlanStatusSignal(root).state, 'n/a');
  });

  it('is n/a when the pointer is null and there is no default plan', () => {
    writeState('work_in_progress: {}\nactive_build_plan: null  # cleared after merge\n');
    const s = rr.buildPlanStatusSignal(root);
    assert.equal(s.state, 'n/a');
    assert.equal(s.detail, 'no active build plan');
  });

  it('falls back to artifacts/build-plan.md when the pointer is unset', () => {
    writeState('product_identity: {}\n');
    writePlan('artifacts/build-plan.md', PLAN('- [x] one\n- [ ] two'));
    const s = rr.buildPlanStatusSignal(root);
    assert.equal(s.state, 'fail');
    assert.match(s.detail, /1 of 2 Status boxes unticked in \.prawduct\/artifacts\/build-plan\.md/);
  });

  it('resolves the pointer relative to .prawduct/, quoted or bare', () => {
    writePlan('artifacts/build-plan-x.md', PLAN('- [x] one\n- [X] two'));
    for (const spelling of ['artifacts/build-plan-x.md', '"artifacts/build-plan-x.md"',
      "'.prawduct/artifacts/build-plan-x.md'", 'artifacts/build-plan-x.md # current']) {
      writeState(`active_build_plan: ${spelling}\n`);
      const s = rr.buildPlanStatusSignal(root);
      assert.equal(s.state, 'pass', `spelling ${spelling}`);
    }
  });

  it('only counts boxes under ## Status', () => {
    writeState('active_build_plan: artifacts/p.md\n');
    writePlan('artifacts/p.md', PLAN('- [x] done'));
    assert.equal(rr.buildPlanStatusSignal(root).state, 'pass');
  });

  it('ignores an indented active_build_plan key', () => {
    writeState('nested:\n  active_build_plan: artifacts/p.md\n');
    assert.equal(rr.buildPlanStatusSignal(root).state, 'n/a');
  });

  it('is unknown when an explicit pointer names a missing file', () => {
    writeState('active_build_plan: artifacts/gone.md\n');
    const s = rr.buildPlanStatusSignal(root);
    assert.equal(s.state, 'unknown');
    assert.match(s.detail, /does not exist/);
  });

  it('is unknown when the Status section has no boxes', () => {
    writeState('active_build_plan: artifacts/p.md\n');
    writePlan('artifacts/p.md', '# Plan\n\n## Status\n\nIn progress.\n');
    assert.equal(rr.buildPlanStatusSignal(root).state, 'unknown');
  });

  it('is n/a for a plan with no Status section, whatever its other checklists say', () => {
    // The shape of a pre-convention plan found on this machine: per-chunk
    // checklists, a struck-out unticked item, and a bold **Status:** line.
    writeState('product_identity: {}\n');
    writePlan('artifacts/build-plan.md',
      '# Build Plan\n\n**Status:** **APPROVED**\n\n## Chunks\n\n### Chunk 1\n\n- [x] done\n- [ ] ~~descoped~~\n');
    const s = rr.buildPlanStatusSignal(root);
    assert.equal(s.state, 'n/a');
    assert.match(s.detail, /no ## Status section to judge/);
  });

  it('is unknown, and reads nothing, when the pointer escapes the project', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'p.md'), PLAN('- [x] done'));
      writeState(`active_build_plan: ../../${path.basename(outside)}/p.md\n`);
      const s = rr.buildPlanStatusSignal(root);
      assert.equal(s.state, 'unknown');
      assert.doesNotMatch(s.detail, /ticked/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads a plan symlinked in from another checkout, as a worktree carries it', () => {
    const primary = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-primary-'));
    try {
      fs.writeFileSync(path.join(primary, 'p.md'), PLAN('- [x] one\n- [ ] two'));
      writeState('active_build_plan: artifacts/p.md\n');
      fs.mkdirSync(path.join(root, '.prawduct', 'artifacts'), { recursive: true });
      fs.symlinkSync(path.join(primary, 'p.md'), path.join(root, '.prawduct', 'artifacts', 'p.md'));
      const s = rr.buildPlanStatusSignal(root);
      assert.equal(s.state, 'fail', s.detail);
      assert.match(s.detail, /1 of 2 Status boxes unticked/);
    } finally {
      fs.rmSync(primary, { recursive: true, force: true });
    }
  });

  it('treats a suffixed Status heading as the Status section', () => {
    writeState('active_build_plan: artifacts/p.md\n');
    writePlan('artifacts/p.md', '# Plan\n\n## Status — Train 19\n\n- [x] one\n- [ ] two\n');
    assert.equal(rr.buildPlanStatusSignal(root).state, 'fail');
  });

  it('is unknown when project-state.yaml is unreadable', () => {
    fs.mkdirSync(path.join(root, '.prawduct', 'project-state.yaml'), { recursive: true });
    assert.equal(rr.buildPlanStatusSignal(root).state, 'unknown');
  });
});

describe('prawductRootFor', () => {
  let wt; let primary;
  beforeEach(() => {
    wt = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-wt-'));
    primary = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-reg-'));
  });
  afterEach(() => {
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(primary, { recursive: true, force: true });
  });

  it('uses the wrapped checkout when there is no separate registered folder', () => {
    assert.equal(rr.prawductRootFor(wt), wt);
    assert.equal(rr.prawductRootFor(wt, wt), wt);
  });

  it('prefers the worktree when it carries Prawduct state', () => {
    fs.mkdirSync(path.join(wt, '.prawduct'));
    fs.writeFileSync(path.join(wt, '.prawduct', 'project-state.yaml'), 'active_build_plan: null\n');
    assert.equal(rr.prawductRootFor(wt, primary), wt);
  });

  it('falls back to the registered checkout when the worktree has none, so an unfinished plan still holds', () => {
    fs.mkdirSync(path.join(primary, '.prawduct', 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(primary, '.prawduct', 'project-state.yaml'), 'active_build_plan: artifacts/p.md\n');
    fs.writeFileSync(path.join(primary, '.prawduct', 'artifacts', 'p.md'), '## Status\n\n- [ ] open\n');
    assert.equal(rr.prawductRootFor(wt, primary), primary);
    const signals = rr.gatherReleaseSignals(wt, {
      changelog: { found: true, sectionFound: true, hasEntries: true }, configRoot: primary
    });
    assert.equal(rr.evaluateReleaseReadiness(signals).verdict, 'not-ready');
  });
});

describe('gatherReleaseSignals', () => {
  it('includes linked-issue-closed by default (A481-R5), and a project with no plan/issue can still be ready', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-g-'));
    try {
      const signals = rr.gatherReleaseSignals(root, { changelog: { found: true, sectionFound: true, hasEntries: true } });
      assert.deepEqual(signals.map((s) => s.id), ['unreleased-entries', 'build-plan-status', 'linked-issue-closed']);
      assert.equal(signals[2].state, 'n/a', 'no plan on disk means no issue found, so n/a -- never a real gh call');
      assert.equal(rr.evaluateReleaseReadiness(signals).verdict, 'ready');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a project with no linked issue never touches the network, even with no options at all (#1495, A481-R5)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-g2-'));
    const calls = [];
    const orig = rr._internal.execFileSync;
    rr._internal.execFileSync = (...args) => { calls.push(args); throw new Error('must not be called'); };
    try {
      const signals = rr.gatherReleaseSignals(root, { changelog: { found: true, sectionFound: true, hasEntries: true } });
      assert.deepEqual(signals.map((s) => s.id), ['unreleased-entries', 'build-plan-status', 'linked-issue-closed']);
      assert.equal(signals[2].state, 'n/a');
      assert.deepEqual(calls, []);
    } finally {
      rr._internal.execFileSync = orig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('includeLinkedIssue: false omits the third signal entirely', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-g4-'));
    try {
      const signals = rr.gatherReleaseSignals(root, {
        changelog: { found: true, sectionFound: true, hasEntries: true },
        includeLinkedIssue: false
      });
      assert.deepEqual(signals.map((s) => s.id), ['unreleased-entries', 'build-plan-status']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes a linked-issue option straight through to linkedIssueClosedSignal (#1495)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-g3-'));
    try {
      const signals = rr.gatherReleaseSignals(root, {
        changelog: { found: true, sectionFound: true, hasEntries: true },
        issueNumber: 7,
        fetchIssueState: () => ({ state: 'closed' })
      });
      assert.deepEqual(signals.map((s) => s.id), ['unreleased-entries', 'build-plan-status', 'linked-issue-closed']);
      assert.equal(signals[2].state, 'pass');
      assert.equal(rr.evaluateReleaseReadiness(signals).verdict, 'ready');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("production's exact call shape (lib/wrap-steps/version-bump.js:726, no linked-issue options) never calls gh (A481-R5)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-g5-'));
    const orig = rr._internal.execFileSync;
    rr._internal.execFileSync = () => { throw new Error('must not be called: version-bump.js has no plan/issue fixtures'); };
    try {
      const signals = rr.gatherReleaseSignals(root, {
        changelog: { found: true, sectionFound: true, hasEntries: true, fragments: { ok: true, count: 1 } },
        configRoot: root
      });
      assert.deepEqual(signals.map((s) => s.id), ['unreleased-entries', 'build-plan-status', 'linked-issue-closed']);
      assert.equal(signals[2].state, 'n/a');
    } finally {
      rr._internal.execFileSync = orig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('linkedIssueClosedSignal (#1495)', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-issue-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const writeState = (body) => {
    fs.mkdirSync(path.join(root, '.prawduct'), { recursive: true });
    fs.writeFileSync(path.join(root, '.prawduct', 'project-state.yaml'), body);
  };
  const writePlan = (rel, body) => {
    const p = path.join(root, '.prawduct', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  describe('discovery', () => {
    it('is n/a when no issue can be found anywhere', () => {
      const s = rr.linkedIssueClosedSignal(root, { fetchIssueState: () => ({ state: 'closed' }) });
      assert.equal(s.state, 'n/a');
      assert.equal(s.detail, 'no linked issue found');
    });

    it('prefers an explicit issueNumber over everything else', () => {
      writeState('active_build_plan: artifacts/p.md\n');
      writePlan('artifacts/p.md', '# Plan\n\n**Issue:** #111\n');
      const seen = [];
      rr.linkedIssueClosedSignal(root, {
        issueNumber: 222,
        commits: ['Fixes #333'],
        fetchIssueState: (n) => { seen.push(n); return { state: 'closed' }; }
      });
      assert.deepEqual(seen, [222]);
    });

    it('accepts issueNumbers (plural) for multiple linked issues', () => {
      const seen = [];
      const s = rr.linkedIssueClosedSignal(root, {
        issueNumbers: [1, 2],
        fetchIssueState: (n) => { seen.push(n); return { state: 'closed' }; }
      });
      assert.deepEqual(seen.sort(), [1, 2]);
      assert.equal(s.state, 'pass');
    });

    it('falls back to the active plan\'s Issue: header line', () => {
      writeState('active_build_plan: artifacts/p.md\n');
      writePlan('artifacts/p.md', '# Plan\n\n**Issue:** #456\n\nSome body\n');
      const seen = [];
      rr.linkedIssueClosedSignal(root, { fetchIssueState: (n) => { seen.push(n); return { state: 'closed' }; } });
      assert.deepEqual(seen, [456]);
    });

    it('matches the Issue header line in Issue:, **Issue:**, or bare Issue # spellings', () => {
      writeState('active_build_plan: artifacts/p.md\n');
      for (const [spelling, expected] of [
        ['Issue: #10\n', 10],
        ['**Issue:** #11\n', 11],
        ['Issue #12\n', 12]
      ]) {
        writePlan('artifacts/p.md', `# Plan\n\n${spelling}`);
        const seen = [];
        rr.linkedIssueClosedSignal(root, { fetchIssueState: (n) => { seen.push(n); return { state: 'closed' }; } });
        assert.deepEqual(seen, [expected], `spelling ${JSON.stringify(spelling)}`);
      }
    });

    it('resolves to the line\'s OWN issue, not a later cross-reference on the same line (Critic finding, real plan line verbatim)', () => {
      // This repo's actual `Issue:` convention: a bare GitHub URL (no `#`)
      // naming the plan's own issue, followed by prose that can carry its
      // OWN `#N` cross-references (a build-order note, a sibling issue) --
      // verbatim from .prawduct/artifacts/build-plan-2322-integrator-merge-queue.md,
      // whose own issue is #2322 but whose line also mentions "#2323 chunk 01".
      writeState('active_build_plan: artifacts/p.md\n');
      const realLine = 'Issue: https://github.com/Jason-Vaughan/TangleClaw/issues/2322 (OPEN when read 2026-10-11 21:24 PDT; labels `enhancement`, `release:v5.33`; milestone "v5.33.0: Newer Codex versions"; no comments). Planned from `origin/main` `e4dfaf47`. Build order: this plan\'s chunk 01 (v64), then #2323 chunk 01 (v65), then this plan\'s chunk 02.';
      writePlan('artifacts/p.md', `# Plan\n\n${realLine}\n`);
      const seen = [];
      rr.linkedIssueClosedSignal(root, { fetchIssueState: (n) => { seen.push(n); return { state: 'closed' }; } });
      assert.deepEqual(seen, [2322], 'must discover the line\'s own issue (#2322), not the later cross-reference (#2323)');
    });

    it('a bare number is trusted only when it is the entire line, never a stray digit in prose', () => {
      writeState('active_build_plan: artifacts/p.md\n');
      writePlan('artifacts/p.md', '# Plan\n\nIssue: 789\n');
      const seen = [];
      rr.linkedIssueClosedSignal(root, { fetchIssueState: (n) => { seen.push(n); return { state: 'closed' }; } });
      assert.deepEqual(seen, [789]);

      writePlan('artifacts/p.md', '# Plan\n\nIssue: this references 42 other things\n');
      const seen2 = [];
      const s2 = rr.linkedIssueClosedSignal(root, { fetchIssueState: (n) => { seen2.push(n); return { state: 'closed' }; } });
      assert.deepEqual(seen2, [], 'no #/URL marker and not a bare number -- nothing trusted');
      assert.equal(s2.state, 'n/a');
    });

    it('a leading comma-separated run of issues is still discovered in full', () => {
      writeState('active_build_plan: artifacts/p.md\n');
      writePlan('artifacts/p.md', '# Plan\n\nIssue: #100, #200 and other prose mentioning #300\n');
      const seen = [];
      rr.linkedIssueClosedSignal(root, { fetchIssueState: (n) => { seen.push(n); return { state: 'closed' }; } });
      assert.deepEqual(seen.sort((a, b) => a - b), [100, 200], 'the leading run (#100, #200) is trusted; the later #300 in prose is not');
    });

    it('falls back to commits\' Fixes/Closes/Resolves #N when no plan names one', () => {
      const seen = [];
      rr.linkedIssueClosedSignal(root, {
        commits: ['fix: thing\n\nFixes #42', 'docs: note\n\nCloses #43', 'chore: x\n\nResolves #44'],
        fetchIssueState: (n) => { seen.push(n); return { state: 'closed' }; }
      });
      assert.deepEqual(seen.sort(), [42, 43, 44]);
    });

    it('matches Fixes/Closes/Resolves case-insensitively', () => {
      const seen = [];
      rr.linkedIssueClosedSignal(root, {
        commits: ['fixes #5', 'CLOSES #6'],
        fetchIssueState: (n) => { seen.push(n); return { state: 'closed' }; }
      });
      assert.deepEqual(seen.sort(), [5, 6]);
    });

    it('plan takes precedence over commits when both are available', () => {
      writeState('active_build_plan: artifacts/p.md\n');
      writePlan('artifacts/p.md', '# Plan\n\n**Issue:** #900\n');
      const seen = [];
      rr.linkedIssueClosedSignal(root, {
        commits: ['Fixes #901'],
        fetchIssueState: (n) => { seen.push(n); return { state: 'closed' }; }
      });
      assert.deepEqual(seen, [900]);
    });
  });

  describe('states', () => {
    it('is unknown, never pass, when an issue is linked but checkGithub: false disables the lookup', () => {
      const s = rr.linkedIssueClosedSignal(root, { issueNumber: 1, checkGithub: false });
      assert.equal(s.state, 'unknown');
      assert.match(s.detail, /GitHub issue state unavailable/);
    });

    it('is unknown, never pass, when the lookup throws', () => {
      const s = rr.linkedIssueClosedSignal(root, {
        issueNumber: 1,
        fetchIssueState: () => { throw new Error('rate limited'); }
      });
      assert.equal(s.state, 'unknown');
      assert.match(s.detail, /rate limited/);
    });

    it('is unknown on an unrecognized state string', () => {
      const s = rr.linkedIssueClosedSignal(root, {
        issueNumber: 1,
        fetchIssueState: () => ({ state: 'merged' })
      });
      assert.equal(s.state, 'unknown');
      assert.match(s.detail, /unrecognized state/);
    });

    it('is pass when the linked issue is closed, case-insensitively', () => {
      for (const state of ['closed', 'CLOSED', 'Closed']) {
        const s = rr.linkedIssueClosedSignal(root, { issueNumber: 1, fetchIssueState: () => ({ state }) });
        assert.equal(s.state, 'pass');
        assert.equal(s.detail, 'linked issue #1 is closed');
      }
    });

    it('accepts a bare state string from fetchIssueState, not just {state}', () => {
      const s = rr.linkedIssueClosedSignal(root, { issueNumber: 1, fetchIssueState: () => 'closed' });
      assert.equal(s.state, 'pass');
    });

    it('is fail when the linked issue is open, case-insensitively', () => {
      const s = rr.linkedIssueClosedSignal(root, { issueNumber: 1, fetchIssueState: () => ({ state: 'OPEN' }) });
      assert.equal(s.state, 'fail');
      assert.equal(s.detail, 'linked issue #1 is still open');
    });

    it('fails if ANY linked issue is open, even when others are closed', () => {
      const s = rr.linkedIssueClosedSignal(root, {
        issueNumbers: [1, 2],
        fetchIssueState: (n) => ({ state: n === 1 ? 'closed' : 'open' })
      });
      assert.equal(s.state, 'fail');
      assert.match(s.detail, /#2 is still open/);
    });

    it('passes only when ALL linked issues are closed', () => {
      const s = rr.linkedIssueClosedSignal(root, {
        issueNumbers: [1, 2, 3],
        fetchIssueState: () => ({ state: 'closed' })
      });
      assert.equal(s.state, 'pass');
      assert.match(s.detail, /linked issues #1, #2, #3 are closed/);
    });

    it('runs the exact gh issue view command through options.execGh', () => {
      const commands = [];
      const s = rr.linkedIssueClosedSignal(root, {
        issueNumber: 9,
        checkGithub: true,
        execGh: (cmd) => { commands.push(cmd); return JSON.stringify({ state: 'CLOSED' }); }
      });
      assert.deepEqual(commands, ['gh issue view 9 --json state']);
      assert.equal(s.state, 'pass');
    });

    it('execGh alone (without checkGithub) is enough to run the lookup', () => {
      const s = rr.linkedIssueClosedSignal(root, {
        issueNumber: 9,
        execGh: () => JSON.stringify({ state: 'OPEN' })
      });
      assert.equal(s.state, 'fail');
    });

    it('with no injected lookup, defaults to a real `gh issue view <n> --json state` call bounded by a timeout (A481-R5)', () => {
      const calls = [];
      const orig = rr._internal.execFileSync;
      rr._internal.execFileSync = (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return JSON.stringify({ state: 'CLOSED' });
      };
      try {
        const s = rr.linkedIssueClosedSignal(root, { issueNumber: 9 });
        assert.equal(s.state, 'pass');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].cmd, 'gh');
        assert.deepEqual(calls[0].args, ['issue', 'view', '9', '--json', 'state']);
        assert.equal(calls[0].opts.cwd, root);
        assert.equal(calls[0].opts.timeout, rr.GH_ISSUE_VIEW_TIMEOUT_MS);
        assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
      } finally {
        rr._internal.execFileSync = orig;
      }
    });

    it('checkGithub: false disables the default gh call without disabling discovery', () => {
      const orig = rr._internal.execFileSync;
      rr._internal.execFileSync = () => { throw new Error('must not be called'); };
      try {
        const s = rr.linkedIssueClosedSignal(root, { issueNumber: 9, checkGithub: false });
        assert.equal(s.state, 'unknown');
      } finally {
        rr._internal.execFileSync = orig;
      }
    });

    it('a thrown/unparseable default gh call is unknown, never pass', () => {
      const orig = rr._internal.execFileSync;
      rr._internal.execFileSync = () => { throw new Error('gh: command not found'); };
      try {
        const s = rr.linkedIssueClosedSignal(root, { issueNumber: 9 });
        assert.equal(s.state, 'unknown');
        assert.match(s.detail, /gh: command not found/);
      } finally {
        rr._internal.execFileSync = orig;
      }
    });

    it('fetchIssueState takes precedence over the default gh call', () => {
      const orig = rr._internal.execFileSync;
      rr._internal.execFileSync = () => { throw new Error('must not be called'); };
      try {
        const s = rr.linkedIssueClosedSignal(root, { issueNumber: 9, fetchIssueState: () => ({ state: 'closed' }) });
        assert.equal(s.state, 'pass');
      } finally {
        rr._internal.execFileSync = orig;
      }
    });

    it('fetchIssueState takes precedence over execGh when both are given', () => {
      const s = rr.linkedIssueClosedSignal(root, {
        issueNumber: 9,
        fetchIssueState: () => ({ state: 'closed' }),
        execGh: () => { throw new Error('should not be called'); }
      });
      assert.equal(s.state, 'pass');
    });
  });

  it('feeds cleanly into evaluateReleaseReadiness', () => {
    const open = rr.linkedIssueClosedSignal(root, { issueNumber: 1, fetchIssueState: () => ({ state: 'open' }) });
    assert.equal(rr.evaluateReleaseReadiness([open]).verdict, 'not-ready');

    const closed = rr.linkedIssueClosedSignal(root, { issueNumber: 1, fetchIssueState: () => ({ state: 'closed' }) });
    assert.equal(rr.evaluateReleaseReadiness([closed]).verdict, 'ready');

    const notFound = rr.linkedIssueClosedSignal(root, {});
    assert.equal(rr.evaluateReleaseReadiness([notFound]).verdict, 'unknown');

    const noLookup = rr.linkedIssueClosedSignal(root, { issueNumber: 1, checkGithub: false });
    assert.equal(rr.evaluateReleaseReadiness([noLookup]).verdict, 'unknown');
  });
});
