'use strict';

// Car 67-A (v5.67.0, Architect Ruling A504-W1A-R2): the Slice 2 wiring for
// #2866, #2877 and #2878. Each underlying library (lib/merge-role-guard.js,
// lib/roadmap-admission.js, lib/roadmap-sync.js, lib/merge-inbox-gate.js)
// already has its own test file proving its own logic; this file covers the
// NEW wiring only:
//   #2866 — the new createRoleGuardWrapperScripts/recordBlockedAttempt
//     exports on lib/merge-role-guard.js, and lib/sessions.js's
//     _mergeRoleGuardWrapperDir/_withPathFloor wiring that puts the
//     generated `gh` wrapper on every launched pane's PATH.
//   #2877 — the `tc roadmap` verb (lib/tc-verbs.js), a thin local mount of
//     scripts/roadmap-sync-check.js.
//   #2878 — the `tc merge-gate` verb and the
//     /api/sessions/:project/merge-gate/* routes (lib/routes/sessions.js),
//     both over lib/tc-docs-scorecard-merge-wiring.js's mergeGate* adapters.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const sessions = require('../lib/sessions');
const mergeRoleGuard = require('../lib/merge-role-guard');
const { VERB_ROSTER } = require('../lib/tc-verbs');
const { createServer } = require('../server');
const { bindProject, sendAs, operatorOf, operatorHeaders } = require('./_shared-docs-callers');

const roadmapVerb = VERB_ROSTER.find((v) => v.id === 'roadmap');
const mergeGateVerb = VERB_ROSTER.find((v) => v.id === 'merge-gate');

/**
 * Whether `gh` is actually installed on this host -- same convention
 * `test/engine-launch-flags.test.js#resolveBinary` uses. Only the ONE test
 * below that needs the wrapper's pass-through to reach a REAL `gh` needs
 * this; every refusal-path test returns before the wrapper ever execs it.
 * @returns {boolean}
 */
function _ghAvailable() {
  try {
    return Boolean(require('node:child_process').execFileSync('which', ['gh'], { encoding: 'utf8', timeout: 5000 }).trim());
  } catch {
    return false;
  }
}

/** Same convention as {@link _ghAvailable}, for the curl wrapper's own real-binary pass-through test. */
function _curlAvailable() {
  try {
    return Boolean(require('node:child_process').execFileSync('which', ['curl'], { encoding: 'utf8', timeout: 5000 }).trim());
  } catch {
    return false;
  }
}

describe('#2866: lib/merge-role-guard.js#createRoleGuardWrapperScripts + recordBlockedAttempt', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-guard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a syntactically valid, executable gh wrapper script', () => {
    const r = mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    assert.equal(r.dir, tmpDir);
    assert.equal(r.file, path.join(tmpDir, 'gh'));
    assert.ok(fs.existsSync(r.file));
    const mode = fs.statSync(r.file).mode & 0o777;
    assert.equal(mode, 0o755);
    // The generated script must itself be valid JS -- a template-escaping
    // bug here is exactly how #2866 shipped a real fork bomb during this
    // car's own development (see the module's own comment on the realpath
    // fix); this is the regression that catches a repeat.
    assert.doesNotThrow(() => new (require('node:vm').Script)(fs.readFileSync(r.file, 'utf8')));
  });

  it('requires the EXACT file that generated it, never a relative or guessed path', () => {
    mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'gh'), 'utf8');
    assert.ok(content.includes(JSON.stringify(require.resolve('../lib/merge-role-guard.js'))));
  });

  it('is idempotent and safe to call repeatedly (as every session launch does)', () => {
    const a = mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const b = mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    assert.deepEqual(a, b);
  });

  it('creates the target directory if missing', () => {
    const nested = path.join(tmpDir, 'nested', 'deeper');
    mergeRoleGuard.createRoleGuardWrapperScripts(nested);
    assert.ok(fs.existsSync(path.join(nested, 'gh')));
  });

  it('runs correctly end-to-end: passes through a non-merge command', (t) => {
    if (!_ghAvailable()) {
      t.skip('gh not installed on this host');
      return;
    }
    mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const out = require('node:child_process').execFileSync(
      process.execPath, [path.join(tmpDir, 'gh'), '--version'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` } }
    );
    assert.match(out, /gh version/);
  });

  it('runs correctly end-to-end: refuses a PR merge when no tmux session can be resolved (fails closed, never open)', () => {
    mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const { execFileSync } = require('node:child_process');
    const env = { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` };
    delete env.TMUX; // outside any tmux pane -- lane is unresolvable
    assert.throws(
      () => execFileSync(process.execPath, [path.join(tmpDir, 'gh'), 'pr', 'merge', '123', '--squash'], { encoding: 'utf8', env }),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stderr, /MERGE_ROLE_FORBIDDEN/);
        return true;
      }
    );
  });

  // A real-tmux-session variant (asserting a SPECIFIC "TC-Lane-X" session
  // name maps to the builder role) was deliberately not added here: this
  // repo's own test/_tmux-session-names.js convention requires every real
  // tmux session a test creates to come from uniqueSessionName (collision-
  // proof, randomized names) -- which is fundamentally incompatible with
  // needing one exact recognizable lane name. The lane-name -> role mapping
  // itself is already covered directly by test/merge-role-guard.test.js;
  // the no-tmux-available case above already proves the WRAPPER's own
  // fail-closed integration. Verified manually instead (see the PR body):
  // a real "TC-Lane-D" tmux session running the generated wrapper refuses
  // `gh pr merge` with MERGE_ROLE_FORBIDDEN, naming that exact lane.

  it('recordBlockedAttempt appends one JSON line per call and never throws on a bad target', () => {
    const file = path.join(tmpDir, 'nested', 'audit.jsonl');
    const ok = mergeRoleGuard.recordBlockedAttempt(file, {
      commandText: 'gh pr merge 1 --squash', lane: 'TC-Lane-D', code: 'MERGE_ROLE_FORBIDDEN', message: 'nope'
    });
    assert.equal(ok, true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.lane, 'TC-Lane-D');
    assert.equal(parsed.code, 'MERGE_ROLE_FORBIDDEN');
    assert.ok(parsed.at);

    mergeRoleGuard.recordBlockedAttempt(file, { commandText: 'x', code: 'Y', message: 'z' });
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);

    // A target that cannot possibly be created (a file component in the
    // middle of the path) must degrade to false, never throw -- an audit
    // write is advisory, per the function's own doc.
    const impossible = path.join(file, 'cannot-have-children-under-a-file');
    assert.equal(mergeRoleGuard.recordBlockedAttempt(impossible, { commandText: 'x', code: 'Y', message: 'z' }), false);
  });

  // I-Gate R1 BLOCKING 4: the raw REST merge shape (`curl -X PUT
  // .../pulls/<n>/merge`) detectMergeInvocation already recognizes needs
  // its own PATH interception, not just `gh pr merge`/`gh api`.
  it('also writes a syntactically valid, executable curl wrapper script, requiring the exact guard module', () => {
    const r = mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    assert.equal(r.curlFile, path.join(tmpDir, 'curl'));
    assert.ok(fs.existsSync(r.curlFile));
    const mode = fs.statSync(r.curlFile).mode & 0o777;
    assert.equal(mode, 0o755);
    assert.doesNotThrow(() => new (require('node:vm').Script)(fs.readFileSync(r.curlFile, 'utf8')));
    const content = fs.readFileSync(r.curlFile, 'utf8');
    assert.ok(content.includes(JSON.stringify(require.resolve('../lib/merge-role-guard.js'))));
  });

  it('curl wrapper runs correctly end-to-end: passes a non-merge call through to the real curl', (t) => {
    if (!_curlAvailable()) {
      t.skip('curl not installed on this host');
      return;
    }
    mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(
      process.execPath, [path.join(tmpDir, 'curl'), '--version'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` } }
    );
    assert.match(out, /curl/i);
  });

  it('curl wrapper runs correctly end-to-end: refuses a raw REST PUT merge when no tmux session can be resolved (fails closed)', () => {
    mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const { execFileSync } = require('node:child_process');
    const env = { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` };
    delete env.TMUX; // outside any tmux pane -- lane is unresolvable
    assert.throws(
      () => execFileSync(
        process.execPath,
        [path.join(tmpDir, 'curl'), '-X', 'PUT', 'https://api.github.com/repos/org/repo/pulls/42/merge'],
        { encoding: 'utf8', env }
      ),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stderr, /MERGE_ROLE_FORBIDDEN/);
        return true;
      }
    );
  });
});

describe('#2866: lib/sessions.js wiring — the gh wrapper reaches every launched pane\'s PATH', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-sessions-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('_withPathFloor itself is completely unchanged by #2866 -- its exact output shape is pinned by test/tc-cli.test.js\'s own #1140 regression coverage', () => {
    const binDir = path.join(__dirname, '..', 'bin');
    assert.equal(sessions._withPathFloor('echo hi'), `export PATH="${binDir}:$PATH"; echo hi`);
    assert.equal(sessions._withPathFloor('echo hi', '/fake/bin'), 'export PATH="/fake/bin:$PATH"; echo hi');
  });

  it('_withMergeGuardFloor combines both dirs into ONE export, never two stacked ones', () => {
    const wrapped = sessions._withMergeGuardFloor('echo hi');
    const guardDir = path.join(store._getBasePath(), 'merge-role-guard-wrapper');
    const binDir = path.join(__dirname, '..', 'bin');
    // ONE `export PATH=...; ` prefix, not two: lib/recorded-launch-command.js's
    // #_withoutPathFloor deliberately strips only a single such prefix
    // (test/recorded-launch-command.test.js's own #2228 regression coverage
    // for exactly this), so the two directories ride together in the one
    // combined floor _withPathFloor's own binDirOverride seam already
    // accepts a `:`-joined string for.
    assert.equal(wrapped, `export PATH="${binDir}:${guardDir}:$PATH"; echo hi`);
    assert.ok(fs.existsSync(path.join(guardDir, 'gh')), 'the wrapper script must actually have been written as a side effect');
  });

  it('_withMergeGuardFloor returns the input unchanged for an empty/undefined command', () => {
    assert.equal(sessions._withMergeGuardFloor(undefined), undefined);
    assert.equal(sessions._withMergeGuardFloor(''), '');
  });
});

describe('#2877: tc roadmap verb (lib/tc-verbs.js)', () => {
  it('is registered on the verb roster', () => {
    assert.ok(roadmapVerb);
    assert.equal(typeof roadmapVerb.run, 'function');
  });

  it('refuses an unknown subverb without spawning anything', async () => {
    const r = await roadmapVerb.run({ argv: ['bogus'] });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /needs a subverb/);
  });

  it('admission: runs the real script end-to-end and surfaces an executable classification', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-roadmap-'));
    try {
      const candidateFile = path.join(tmpDir, 'candidate.json');
      const factsFile = path.join(tmpDir, 'facts.json');
      fs.writeFileSync(candidateFile, JSON.stringify({ trainId: 'train:car67a-test', issues: ['#2866'] }));
      fs.writeFileSync(factsFile, JSON.stringify({ issues: { '#2866': { state: 'open' } }, conflicts: [] }));
      const r = await roadmapVerb.run({ argv: ['admission', '--candidate', candidateFile, '--facts', factsFile] });
      assert.equal(r.code, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.classification, 'executable');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // I-Gate R1 BLOCKING 1 (PR #2908): the original renderRoadmap called
  // `changed.map(...)`, but computeChangedSince returns
  // `{changedIssueIds, newlyLinkedPrIssueIds, skippableClosedIssueIds}`, not
  // an array -- every real `tc roadmap sync` call threw TypeError. This
  // drives the REAL script end-to-end (as a subprocess, via the verb, same
  // as a real caller would) against a fake `gh` on PATH, so no real
  // network/timeout risk, across an initial run and an unchanged second run.
  it('sync: an initial run publishes, an unchanged second run does not, and state persists across the two (I-Gate R1 BLOCKING 1)', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-roadmap-sync-'));
    const fakeGhDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-fake-gh-'));
    t.after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(fakeGhDir, { recursive: true, force: true });
    });
    // A minimal fake `gh` answering exactly the one real `gh api` shape
    // lib/roadmap-sync.js#fetchIssueSummaries invokes: one issue, fixed
    // updatedAt, never changing across calls.
    fs.writeFileSync(path.join(fakeGhDir, 'gh'), [
      '#!/usr/bin/env node',
      "if (process.argv[2] === 'api') {",
      "  process.stdout.write(JSON.stringify({number: 1, updatedAt: '2026-01-01T00:00:00Z', state: 'open', pull_request: false}) + '\\n');",
      '  process.exit(0);',
      '}',
      'process.exit(1);'
    ].join('\n'), { mode: 0o755 });

    const stateFile = path.join(tmpDir, 'state.json');
    const exec = (cmd, args) => require('node:child_process').execFileSync(cmd, args, {
      encoding: 'utf8', env: { ...process.env, PATH: `${fakeGhDir}:${process.env.PATH}` }
    });

    const r1 = await roadmapVerb.run({ argv: ['sync', '--state', stateFile, '--issues', '1', '--repo', tmpDir], execFile: exec });
    assert.equal(r1.code, 0, r1.stderr);
    const result1 = JSON.parse(r1.stdout);
    assert.equal(result1.published, true, 'first run (no prior state) must publish');

    const r2 = await roadmapVerb.run({ argv: ['sync', '--state', stateFile, '--issues', '1', '--repo', tmpDir], execFile: exec });
    assert.equal(r2.code, 0, r2.stderr);
    const result2 = JSON.parse(r2.stdout);
    assert.equal(result2.published, false, 'second run, nothing changed on GitHub, must NOT publish');
    assert.equal(result2.state.issues['1'].updatedAt, '2026-01-01T00:00:00Z', 'the fetched issue summary was actually persisted into state');
  });

  // I-Gate R2 (PR #2908): `computeChangedSince`'s `skippableClosedIssueIds`
  // names issues that were ALREADY closed in prior state -- it is non-empty
  // on every run once any closed issue exists there, regardless of whether
  // anything changed THIS run. Including it in the publish-decision proxy
  // made a closed issue publish forever. This drives two real sync runs of
  // the SAME unchanged closed issue and proves run 2 does not publish.
  it('sync: an unchanged CLOSED issue does not publish on the second run (I-Gate R2)', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-roadmap-closed-'));
    const fakeGhDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-fake-gh-closed-'));
    t.after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(fakeGhDir, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(fakeGhDir, 'gh'), [
      '#!/usr/bin/env node',
      "if (process.argv[2] === 'api') {",
      "  process.stdout.write(JSON.stringify({number: 1, updatedAt: '2026-01-01T00:00:00Z', state: 'closed', pull_request: false}) + '\\n');",
      '  process.exit(0);',
      '}',
      'process.exit(1);'
    ].join('\n'), { mode: 0o755 });

    const stateFile = path.join(tmpDir, 'state.json');
    const exec = (cmd, args) => require('node:child_process').execFileSync(cmd, args, {
      encoding: 'utf8', env: { ...process.env, PATH: `${fakeGhDir}:${process.env.PATH}` }
    });

    const r1 = await roadmapVerb.run({ argv: ['sync', '--state', stateFile, '--issues', '1', '--repo', tmpDir], execFile: exec });
    assert.equal(r1.code, 0, r1.stderr);
    const result1 = JSON.parse(r1.stdout);
    assert.equal(result1.published, true, 'first run (no prior state) must publish');
    assert.equal(result1.state.issues['1'].closed, true);

    const r2 = await roadmapVerb.run({ argv: ['sync', '--state', stateFile, '--issues', '1', '--repo', tmpDir], execFile: exec });
    assert.equal(r2.code, 0, r2.stderr);
    const result2 = JSON.parse(r2.stdout);
    // Before the fix: skippableClosedIssueIds named issue '1' on this second
    // run (closed in prior state), which the publish proxy included, so this
    // read `published: true` forever -- the exact bug I-Gate R2 reported.
    assert.equal(result2.published, false, 'second run of the SAME unchanged closed issue must NOT publish');
    assert.deepEqual(result2.changed.changedIssueIds, [], 'nothing actually changed');
    assert.deepEqual(result2.changed.skippableClosedIssueIds, ['1'], 'the issue is still reported skippable -- that signal is real, just excluded from the publish decision');

    const r3 = await roadmapVerb.run({ argv: ['sync', '--state', stateFile, '--issues', '1', '--repo', tmpDir], execFile: exec });
    assert.equal(JSON.parse(r3.stdout).published, false, 'a third run is just as unchanged');
  });

  // Architect Ruling A504-W1A-R4, I-Gate R2 Blocker 2's second half:
  // linkedPrIds/linkedPrs must not be silently dropped on a run that
  // persists `nextState.issues`. This script itself never populates either
  // field (fetchLinkedPrIds stays out of scope), so the only way to prove
  // "not dropped" is to seed state that already has them -- as a future
  // caller that DOES populate them would leave behind -- and show a sync
  // run preserves rather than wipes it.
  it('sync: linkedPrIds/linkedPrs already in prior state are carried forward, not dropped (I-Gate R2 Blocker 2 / Ruling A504-W1A-R4)', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-roadmap-linked-'));
    const fakeGhDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-fake-gh-linked-'));
    t.after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(fakeGhDir, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(fakeGhDir, 'gh'), [
      '#!/usr/bin/env node',
      "if (process.argv[2] === 'api') {",
      "  process.stdout.write(JSON.stringify({number: 1, updatedAt: '2026-01-01T00:00:00Z', state: 'closed', pull_request: false}) + '\\n');",
      '  process.exit(0);',
      '}',
      'process.exit(1);'
    ].join('\n'), { mode: 0o755 });

    const stateFile = path.join(tmpDir, 'state.json');
    // Seed prior state as a future `fetchLinkedPrIds`-aware caller (or a
    // manual backfill) would leave it -- this script's own sync runs never
    // write a populated linkedPrIds/linkedPrs today.
    fs.writeFileSync(stateFile, JSON.stringify({
      schema: 'tc.roadmap-sync-state/v1', lastRunAt: null, lastFullResyncAt: null,
      issues: {
        1: {
          updatedAt: '2026-01-01T00:00:00Z', closed: true,
          linkedPrIds: ['501'], linkedPrs: [{ id: '501', state: 'merged' }]
        }
      }
    }));

    const exec = (cmd, args) => require('node:child_process').execFileSync(cmd, args, {
      encoding: 'utf8', env: { ...process.env, PATH: `${fakeGhDir}:${process.env.PATH}` }
    });
    const r = await roadmapVerb.run({ argv: ['sync', '--state', stateFile, '--issues', '1', '--repo', tmpDir], execFile: exec });
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.published, false, 'the issue is unchanged and already closed -- nothing to publish');
    assert.deepEqual(result.state.issues['1'].linkedPrIds, ['501'], 'linkedPrIds survives the run, not reset to []');
    assert.deepEqual(result.state.issues['1'].linkedPrs, [{ id: '501', state: 'merged' }], 'linkedPrs survives the run, not reset to []');
  });

  // The exact reproduction from I-Gate R3 (#pullrequestreview-5792619192):
  // a closed issue whose linked PR is still OPEN must never be reported
  // skippable. The bug was specifically a TWO-RUN corruption: run 1 (before
  // this fix) erased `linkedPrs` when persisting `nextState.issues`, so run
  // 2's `computeChangedSince` -- which reads `prevState` fresh off disk --
  // saw no `linkedPrs` at all and, by `_allLinkedPrsSettled`'s vacuous-true
  // default, wrongly called the issue skippable despite its PR being open.
  it('sync: a closed issue with an OPEN linked PR is never skippable, across two runs (I-Gate R3 exact repro, Ruling A504-W1A-R4 Item 2)', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-roadmap-open-link-'));
    const fakeGhDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-fake-gh-open-link-'));
    t.after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(fakeGhDir, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(fakeGhDir, 'gh'), [
      '#!/usr/bin/env node',
      "if (process.argv[2] === 'api') {",
      "  process.stdout.write(JSON.stringify({number: 1, updatedAt: '2026-01-01T00:00:00Z', state: 'closed', pull_request: false}) + '\\n');",
      '  process.exit(0);',
      '}',
      'process.exit(1);'
    ].join('\n'), { mode: 0o755 });

    const stateFile = path.join(tmpDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      schema: 'tc.roadmap-sync-state/v1', lastRunAt: null, lastFullResyncAt: null,
      issues: { 1: { updatedAt: '2026-01-01T00:00:00Z', closed: true, linkedPrIds: ['42'], linkedPrs: [{ state: 'open' }] } }
    }));

    const exec = (cmd, args) => require('node:child_process').execFileSync(cmd, args, {
      encoding: 'utf8', env: { ...process.env, PATH: `${fakeGhDir}:${process.env.PATH}` }
    });

    const r1 = await roadmapVerb.run({ argv: ['sync', '--state', stateFile, '--issues', '1', '--repo', tmpDir], execFile: exec });
    assert.equal(r1.code, 0, r1.stderr);
    const result1 = JSON.parse(r1.stdout);
    assert.deepEqual(result1.state.issues['1'].linkedPrIds, ['42'], 'run 1 must not erase linkedPrIds while persisting');
    assert.deepEqual(result1.state.issues['1'].linkedPrs, [{ state: 'open' }], 'run 1 must not erase linkedPrs while persisting');

    const r2 = await roadmapVerb.run({ argv: ['sync', '--state', stateFile, '--issues', '1', '--repo', tmpDir], execFile: exec });
    assert.equal(r2.code, 0, r2.stderr);
    const result2 = JSON.parse(r2.stdout);
    // The bug's actual symptom: run 2 reads run 1's PERSISTED state fresh.
    // Before this fix, run 1 had already wiped linkedPrs, so this read
    // skippableClosedIssueIds: ['1'] despite the PR being open.
    assert.deepEqual(result2.changed.skippableClosedIssueIds, [], 'the issue\'s linked PR is still open -- it must never be reported skippable');
    assert.deepEqual(result2.state.issues['1'].linkedPrs, [{ state: 'open' }], 'linkedPrs is still intact after a second run');
    assert.equal(result2.published, false);
  });

  it('admission: a hard-open prerequisite blocks, surfaced through the verb unchanged from the script', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-car67a-roadmap-'));
    try {
      const candidateFile = path.join(tmpDir, 'candidate.json');
      const factsFile = path.join(tmpDir, 'facts.json');
      fs.writeFileSync(candidateFile, JSON.stringify({ trainId: 'train:car67a-test-2', issues: ['#2877'], prereqs: ['#1'] }));
      fs.writeFileSync(factsFile, JSON.stringify({ issues: { '#1': { state: 'open' }, '#2877': { state: 'open' } } }));
      const r = await roadmapVerb.run({ argv: ['admission', '--candidate', candidateFile, '--facts', factsFile] });
      assert.equal(r.code, 0);
      assert.equal(JSON.parse(r.stdout).classification, 'blocked');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('admission: missing required files refuses with exit 1 before spawning', async () => {
    const r = await roadmapVerb.run({ argv: ['admission', '--candidate', '/nonexistent/x.json'] });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--candidate and --facts are required/);
  });

  it('uses the injected ctx.execFile seam rather than always spawning a real process', async () => {
    let seenArgs = null;
    const r = await roadmapVerb.run({
      argv: ['sync', '--state', '/tmp/x.json', '--issues', '1,2'],
      execFile: (cmd, args) => { seenArgs = args; return 'STUBBED\n'; }
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'STUBBED\n');
    assert.ok(seenArgs.includes('sync'));
    assert.ok(seenArgs.includes('--state'));
  });

  it('propagates the script\'s own exit code and stderr on failure', async () => {
    const r = await roadmapVerb.run({
      argv: ['sync', '--state', '/tmp/x.json', '--issues', '1'],
      execFile: () => { const err = new Error('boom'); err.status = 2; err.stderr = 'script refused\n'; throw err; }
    });
    assert.equal(r.code, 2);
    assert.equal(r.stderr, 'script refused\n');
  });
});

describe('#2878: tc merge-gate verb (lib/tc-verbs.js)', () => {
  it('is registered on the verb roster', () => {
    assert.ok(mergeGateVerb);
    assert.equal(typeof mergeGateVerb.run, 'function');
  });

  it('refuses an unknown subverb', async () => {
    const r = await mergeGateVerb.run({ argv: ['bogus'] });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /needs a subverb/);
  });

  it('refuses a missing project before making any HTTP call', async () => {
    let called = false;
    const r = await mergeGateVerb.run({ argv: ['list'], getJson: () => { called = true; } });
    assert.equal(r.code, 1);
    assert.equal(called, false);
  });

  it('hold: posts the right body to the right path and reports the new hold', async () => {
    let seenPath = null;
    let seenBody = null;
    const r = await mergeGateVerb.run({
      argv: ['hold', 'my-project', '--repo', 'org/repo', '--reason', 'investigating', '--issued-by', 'TC-Lane-Arc', '--pr', '42'],
      postJson: async (p, body) => { seenPath = p; seenBody = body; return { hold: { holdId: 'hold_1', sequence: 3 } }; }
    });
    assert.equal(r.code, 0);
    assert.equal(seenPath, '/api/sessions/my-project/merge-gate/holds');
    assert.deepEqual(seenBody, {
      repo: 'org/repo', pr: '42', branch: undefined, issue: undefined, reason: 'investigating', issuedBy: 'TC-Lane-Arc', supersedes: undefined
    });
    assert.match(r.stdout, /hold_1/);
  });

  it('list: renders "No holds recorded." when the server returns an empty list', async () => {
    const r = await mergeGateVerb.run({
      argv: ['list', 'my-project'],
      getJson: async () => ({ holds: [] })
    });
    assert.equal(r.stdout, 'No holds recorded.\n');
  });

  it('evaluate: exits 2 (not 0) when the server reports allowed:false', async () => {
    const r = await mergeGateVerb.run({
      argv: ['evaluate', 'my-project', '--repo', 'org/repo', '--pr', '7'],
      getJson: async () => ({ allowed: false, status: 'hold-active', holds: [{ holdId: 'h1' }] })
    });
    assert.equal(r.code, 2);
  });

  it('a server refusal (err.body.code) is reported as a stable, parseable refusal, not an uncaught throw', async () => {
    const r = await mergeGateVerb.run({
      argv: ['ack', 'my-project', 'hold_x', '--by', 'someone'],
      postJson: async () => { const err = new Error('refused'); err.body = { code: 'HOLD_NOT_FOUND', error: 'no such hold' }; throw err; }
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /HOLD_NOT_FOUND/);
  });
});

describe('#2878: /api/sessions/:project/merge-gate/* routes (lib/routes/sessions.js)', () => {
  let tmpDir;
  let server;
  let project;
  let binding;
  let writeHeaders;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-merge-gate-'));
    store._setBasePath(tmpDir);
    store.init();

    const dir = path.join(tmpDir, 'proj-dir');
    fs.mkdirSync(dir, { recursive: true });
    project = store.projects.create({ name: 'merge-gate-route-project', path: dir, engine: 'claude' });
    binding = bindProject(project);

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    writeHeaders = await operatorOf(server)();
    const me = await sendAs(server, 'GET', '/api/auth/me', undefined, operatorHeaders(server));
    if (me.data && me.data.openInstallToken) writeHeaders = { ...writeHeaders, 'x-tc-open-token': me.data.openInstallToken };
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const base = () => `/api/sessions/${encodeURIComponent(project.name)}/merge-gate`;

  function issueHold(overrides = {}) {
    return sendAs(server, 'POST', `${base()}/holds`, {
      repo: 'org/repo', reason: 'testing', issuedBy: 'test-suite', ...overrides
    }, writeHeaders);
  }

  it('404s for an unknown project', async () => {
    const r = await sendAs(server, 'GET', '/api/sessions/does-not-exist/merge-gate/holds', undefined, writeHeaders);
    assert.equal(r.status, 404);
  });

  it('the project\'s own verified launch may issue a hold', async () => {
    const r = await sendAs(server, 'POST', `${base()}/holds`, {
      repo: 'org/repo', pr: '9', reason: 'reviewing', issuedBy: 'test-suite'
    }, binding.headers);
    assert.equal(r.status, 200);
    assert.ok(r.data.hold.holdId);
    assert.equal(r.data.hold.status, 'active');
  });

  it('a read with no verified access at all is refused', async () => {
    const r = await sendAs(server, 'GET', `${base()}/holds`, undefined, {});
    assert.ok([401, 403].includes(r.status));
  });

  it('issue -> list -> show -> ack round trip, through the real HTTP routes', async () => {
    const issued = await issueHold({ pr: '101' });
    assert.equal(issued.status, 200);
    const holdId = issued.data.hold.holdId;

    const listed = await sendAs(server, 'GET', `${base()}/holds?repo=org/repo`, undefined, writeHeaders);
    assert.equal(listed.status, 200);
    assert.ok(listed.data.holds.some((h) => h.holdId === holdId));

    const shown = await sendAs(server, 'GET', `${base()}/holds/${holdId}`, undefined, writeHeaders);
    assert.equal(shown.status, 200);
    assert.equal(shown.data.hold.holdId, holdId);

    const acked = await sendAs(server, 'POST', `${base()}/holds/${holdId}/ack`, { by: 'test-suite' }, writeHeaders);
    assert.equal(acked.status, 200);
    assert.equal(acked.data.hold.status, 'acknowledged');
  });

  it('showing an unknown hold id 404s with HOLD_NOT_FOUND', async () => {
    const r = await sendAs(server, 'GET', `${base()}/holds/does-not-exist`, undefined, writeHeaders);
    assert.equal(r.status, 404);
    assert.equal(r.data.code, 'HOLD_NOT_FOUND');
  });

  it('evaluate reflects an active hold as not allowed, and clears once acknowledged', async () => {
    const issued = await issueHold({ pr: '202' });
    const holdId = issued.data.hold.holdId;

    const blocked = await sendAs(server, 'GET', `${base()}/evaluate?repo=org/repo&pr=202`, undefined, writeHeaders);
    assert.equal(blocked.status, 200);
    assert.equal(blocked.data.allowed, false);

    await sendAs(server, 'POST', `${base()}/holds/${holdId}/ack`, { by: 'test-suite' }, writeHeaders);

    const clear = await sendAs(server, 'GET', `${base()}/evaluate?repo=org/repo&pr=202`, undefined, writeHeaders);
    assert.equal(clear.status, 200);
    assert.equal(clear.data.allowed, true);
  });

  it('override scopes the release to one action only — a different action is still blocked', async () => {
    const issued = await issueHold({ pr: '303' });
    const holdId = issued.data.hold.holdId;

    const overridden = await sendAs(server, 'POST', `${base()}/holds/${holdId}/override`, {
      by: 'test-suite', reason: 'manual review done', action: 'merge'
    }, writeHeaders);
    assert.equal(overridden.status, 200);

    const mergeGate = await sendAs(server, 'GET', `${base()}/evaluate?repo=org/repo&pr=303`, undefined, writeHeaders);
    assert.equal(mergeGate.data.allowed, true);

    const autoMergeGate = await sendAs(server, 'GET', `${base()}/evaluate?repo=org/repo&pr=303&autoMerge=true`, undefined, writeHeaders);
    assert.equal(autoMergeGate.data.allowed, false, 'the override named "merge" only, not "auto-merge"');
  });

  it('publish-status is inert without enabled:true, and reports why', async () => {
    const r = await sendAs(server, 'POST', `${base()}/publish-status`, {
      repo: 'org/repo', pr: '404', sha: 'abc123'
    }, writeHeaders);
    assert.equal(r.status, 200);
    assert.equal(r.data.published, false);
    assert.equal(r.data.reason, 'disabled');
  });

  it('a project launch bound to a DIFFERENT project may still issue a hold (authority travels across lanes, #1717)', async () => {
    const otherDir = path.join(tmpDir, 'other-proj-dir');
    fs.mkdirSync(otherDir, { recursive: true });
    const otherProject = store.projects.create({ name: 'other-merge-gate-project', path: otherDir, engine: 'claude' });
    const otherBinding = bindProject(otherProject);
    const r = await sendAs(server, 'POST', `${base()}/holds`, {
      repo: 'org/repo', pr: '505', reason: 'cross-lane hold', issuedBy: 'other-lane'
    }, otherBinding.headers);
    assert.equal(r.status, 200);
  });

  // I-Gate R1 BLOCKING 3: a non-operator caller's `issuedBy`/`by` claim is
  // never trusted verbatim, and only the issuer (or an operator/master, or an
  // architect/pm/integrator lane for override) may ack/override a hold.
  describe('hold authority separation (I-Gate R1 BLOCKING 3)', () => {
    let reviewerProject;
    let reviewerBinding;
    let builderProject;
    let builderBinding;
    let integratorProject;
    let integratorBinding;

    before(() => {
      const reviewerDir = path.join(tmpDir, 'reviewer-proj-dir');
      fs.mkdirSync(reviewerDir, { recursive: true });
      reviewerProject = store.projects.create({ name: 'TC-Lane-PRR-A', path: reviewerDir, engine: 'claude' });
      reviewerBinding = bindProject(reviewerProject);

      const builderDir = path.join(tmpDir, 'builder-proj-dir');
      fs.mkdirSync(builderDir, { recursive: true });
      builderProject = store.projects.create({ name: 'TC-Lane-C', path: builderDir, engine: 'claude' });
      builderBinding = bindProject(builderProject);

      const integratorDir = path.join(tmpDir, 'integrator-proj-dir');
      fs.mkdirSync(integratorDir, { recursive: true });
      integratorProject = store.projects.create({ name: 'TC-Lane-INT', path: integratorDir, engine: 'claude' });
      integratorBinding = bindProject(integratorProject);
    });

    it('records issuedBy from the issuing project\'s own verified identity, never the body claim', async () => {
      const r = await sendAs(server, 'POST', `${base()}/holds`, {
        repo: 'org/auth-repo', pr: '601', reason: 'authority test', issuedBy: 'someone-else-entirely'
      }, reviewerBinding.headers);
      assert.equal(r.status, 200);
      assert.equal(r.data.hold.issuedBy, 'TC-Lane-PRR-A');
    });

    it('a different (builder) lane may not acknowledge a reviewer\'s hold', async () => {
      const issued = await sendAs(server, 'POST', `${base()}/holds`, {
        repo: 'org/auth-repo', pr: '602', reason: 'ack authority test'
      }, reviewerBinding.headers);
      const holdId = issued.data.hold.holdId;

      const r = await sendAs(server, 'POST', `${base()}/holds/${holdId}/ack`, {
        by: 'claiming-to-be-the-issuer'
      }, builderBinding.headers);
      assert.equal(r.status, 403);

      const stillActive = await sendAs(server, 'GET', `${base()}/holds/${holdId}`, undefined, writeHeaders);
      assert.equal(stillActive.data.hold.status, 'active');
    });

    it('a different (builder) lane may not override a reviewer\'s hold', async () => {
      const issued = await sendAs(server, 'POST', `${base()}/holds`, {
        repo: 'org/auth-repo', pr: '603', reason: 'override authority test'
      }, reviewerBinding.headers);
      const holdId = issued.data.hold.holdId;

      const r = await sendAs(server, 'POST', `${base()}/holds/${holdId}/override`, {
        reason: 'i say so', action: 'merge'
      }, builderBinding.headers);
      assert.equal(r.status, 403);
    });

    it('the issuing lane may acknowledge its own hold, with `by` derived from its verified identity', async () => {
      const issued = await sendAs(server, 'POST', `${base()}/holds`, {
        repo: 'org/auth-repo', pr: '604', reason: 'self-ack test'
      }, reviewerBinding.headers);
      const holdId = issued.data.hold.holdId;

      const r = await sendAs(server, 'POST', `${base()}/holds/${holdId}/ack`, {
        by: 'ignored-body-claim'
      }, reviewerBinding.headers);
      assert.equal(r.status, 200);
      assert.equal(r.data.hold.resolution.by, 'TC-Lane-PRR-A');
    });

    it('an integrator lane may override a reviewer\'s hold despite not being the issuer', async () => {
      const issued = await sendAs(server, 'POST', `${base()}/holds`, {
        repo: 'org/auth-repo', pr: '605', reason: 'integrator override test'
      }, reviewerBinding.headers);
      const holdId = issued.data.hold.holdId;

      const r = await sendAs(server, 'POST', `${base()}/holds/${holdId}/override`, {
        reason: 'integrator authority', action: 'merge'
      }, integratorBinding.headers);
      assert.equal(r.status, 200);
      assert.equal(r.data.hold.overrides.at(-1).by, 'TC-Lane-INT');
    });

    it('an unknown hold id 404s before any authority check runs', async () => {
      const r = await sendAs(server, 'POST', `${base()}/holds/does-not-exist/ack`, { by: 'whoever' }, builderBinding.headers);
      assert.equal(r.status, 404);
      assert.equal(r.data.code, 'HOLD_NOT_FOUND');
    });
  });
});
