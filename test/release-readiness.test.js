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
  it('returns both signals, and a project without a plan can be ready', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-readiness-g-'));
    try {
      const signals = rr.gatherReleaseSignals(root, { changelog: { found: true, sectionFound: true, hasEntries: true } });
      assert.deepEqual(signals.map((s) => s.id), ['unreleased-entries', 'build-plan-status']);
      assert.equal(rr.evaluateReleaseReadiness(signals).verdict, 'ready');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
