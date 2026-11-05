'use strict';

/*
 * `lib/tc-docs-scorecard-merge-wiring.js` (#2887, #2878, #2883, #2877,
 * Architect Ruling A502-W1C-R2, Car 65-C) — the library/verb adapter
 * surface composing lib/product-manual.js + lib/doc-router.js,
 * lib/merge-inbox-gate.js, lib/scorecard-producer.js, and
 * lib/roadmap-admission.js + lib/roadmap-sync.js into the exact call
 * shapes a `tc` verb or a future route needs. Every opt-in hook is tested
 * both for its disabled-by-default no-op and for its enabled behavior with
 * an injected seam — never a real network or git call.
 */

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wiring = require('../lib/tc-docs-scorecard-merge-wiring');
const mergeGate = require('../lib/merge-inbox-gate');
const roadmapSync = require('../lib/roadmap-sync');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-docs-scorecard-merge-wiring-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// #2887 -- docs
// ---------------------------------------------------------------------------

describe('docsManualList / docsManualResolve (#2887)', () => {
  function writeManifest() {
    const file = path.join(dir, 'manual-manifest.json');
    fs.writeFileSync(file, JSON.stringify({
      schema: 'tc.manual-manifest/v1',
      pages: [{
        id: 'user-guide',
        path: 'docs/user-guide.md',
        title: 'User Guide',
        audience: ['human'],
        surfaces: ['docs/user-guide.md'],
        sections: [{ anchor: 'intro', heading: 'Intro' }]
      }]
    }, null, 2));
    return file;
  }

  it('lists every page with its sections', () => {
    const pages = wiring.docsManualList(writeManifest());
    assert.deepEqual(pages, [{
      id: 'user-guide', path: 'docs/user-guide.md', title: 'User Guide',
      sections: [{ anchor: 'intro', heading: 'Intro' }]
    }]);
  });

  it('resolves a page#anchor reference', () => {
    const result = wiring.docsManualResolve(writeManifest(), 'user-guide#intro');
    assert.equal(result.found, true);
    assert.equal(result.section.anchor, 'intro');
  });

  it('reports not-found for an unknown page, rather than throwing', () => {
    const result = wiring.docsManualResolve(writeManifest(), 'no-such-page');
    assert.equal(result.found, false);
  });

  it('throws the underlying library error for a missing manifest file', () => {
    assert.throws(() => wiring.docsManualList(path.join(dir, 'missing.json')));
  });
});

describe('docsRouterResolve (#2887)', () => {
  function writeManifest() {
    const file = path.join(dir, 'ai-doc-manifest.json');
    fs.writeFileSync(file, JSON.stringify({
      schema: 'tc.ai-doc-manifest/v1',
      topics: [{
        id: 'how-to-branch', path: 'docs/branching.md', anchor: 'how-to-branch',
        audience: ['human'], lifecycleState: 'current',
        roles: ['builder'], commands: ['tc branch check']
      }]
    }, null, 2));
    return file;
  }

  it('resolves by topicId', () => {
    const result = wiring.docsRouterResolve(writeManifest(), { topicId: 'how-to-branch' });
    assert.equal(result.found, true);
    assert.equal(result.entry.id, 'how-to-branch');
  });

  it('resolves by role', () => {
    const result = wiring.docsRouterResolve(writeManifest(), { role: 'builder' });
    assert.equal(result.found, true);
    assert.equal(result.entries.length, 1);
  });

  it('resolves by command', () => {
    const result = wiring.docsRouterResolve(writeManifest(), { command: 'tc branch check' });
    assert.equal(result.found, true);
    assert.equal(result.entries[0].id, 'how-to-branch');
  });

  it('throws WiringError when the query names none of topicId, role or command', () => {
    assert.throws(() => wiring.docsRouterResolve(writeManifest(), {}), wiring.WiringError);
  });
});

// ---------------------------------------------------------------------------
// #2878 -- merge-gate
// ---------------------------------------------------------------------------

describe('merge-gate pass-throughs (#2878)', () => {
  let file;
  beforeEach(() => { file = path.join(dir, 'holds.json'); });

  it('mergeGateIssueHold / mergeGateListHolds delegate to the real library', () => {
    const issued = wiring.mergeGateIssueHold(file, { repo: 'o/r', pr: 1, reason: 'why', issuedBy: 'me' });
    assert.equal(issued.ok, true);
    const listed = wiring.mergeGateListHolds(file, { repo: 'o/r' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].holdId, issued.hold.holdId);
  });

  it('mergeGateAcknowledgeHold / mergeGateOverrideHold delegate to the real library', () => {
    const issued = wiring.mergeGateIssueHold(file, { repo: 'o/r', pr: 1, reason: 'why', issuedBy: 'me' });
    const ack = wiring.mergeGateAcknowledgeHold(file, issued.hold.holdId, { by: 'me' });
    assert.equal(ack.ok, true);
    assert.equal(ack.hold.status, 'acknowledged');

    const issued2 = wiring.mergeGateIssueHold(file, { repo: 'o/r', pr: 2, reason: 'why', issuedBy: 'me' });
    const over = wiring.mergeGateOverrideHold(file, issued2.hold.holdId, { by: 'me', reason: 'override reason', action: 'merge' });
    assert.equal(over.ok, true);
    assert.equal(over.hold.overrides.length, 1);
  });

  it('mergeGateEvaluate delegates to evaluateMergeGate, statusCheck included', () => {
    wiring.mergeGateIssueHold(file, { repo: 'o/r', pr: 3, reason: 'why', issuedBy: 'me' });
    const result = wiring.mergeGateEvaluate({ file, identity: { repo: 'o/r', pr: 3 } });
    assert.equal(result.allowed, false);
    assert.equal(result.statusCheck.state, 'failure');
  });
});

describe('publishMergeGateStatusCheck (#2878)', () => {
  let file;
  beforeEach(() => { file = path.join(dir, 'holds.json'); });

  it('is a no-op unless enabled is explicitly true', async () => {
    const exec = mock.fn(async () => ({ exitCode: 0 }));
    const result = await wiring.publishMergeGateStatusCheck({ file, identity: { repo: 'o/r', pr: 1 }, sha: 'deadbeef', exec });
    assert.deepEqual(result, { published: false, reason: 'disabled' });
    assert.equal(exec.mock.calls.length, 0);
  });

  it('publishes state=success with no active holds, through the injected exec seam', async () => {
    const exec = mock.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const result = await wiring.publishMergeGateStatusCheck({
      file, identity: { repo: 'o/r', pr: 1 }, sha: 'deadbeef', enabled: true, exec
    });
    assert.deepEqual(result, { published: true, state: 'success' });
    assert.equal(exec.mock.calls.length, 1);
    const args = exec.mock.calls[0].arguments[0];
    assert.equal(args[0], 'api');
    assert.equal(args[1], 'repos/o/r/statuses/deadbeef');
    assert.ok(args.includes('state=success'));
  });

  it('publishes state=failure while a hold is active', async () => {
    wiring.mergeGateIssueHold(file, { repo: 'o/r', pr: 1, reason: 'why', issuedBy: 'me' });
    const exec = mock.fn(async () => ({ exitCode: 0 }));
    const result = await wiring.publishMergeGateStatusCheck({
      file, identity: { repo: 'o/r', pr: 1 }, sha: 'deadbeef', enabled: true, exec
    });
    assert.equal(result.published, true);
    assert.equal(result.state, 'failure');
    const args = exec.mock.calls[0].arguments[0];
    assert.ok(args.includes('state=failure'));
  });

  it('fails closed on a corrupt store, never publishing', async () => {
    fs.writeFileSync(file, 'not json at all {{{');
    const exec = mock.fn(async () => ({ exitCode: 0 }));
    const result = await wiring.publishMergeGateStatusCheck({
      file, identity: { repo: 'o/r', pr: 1 }, sha: 'deadbeef', enabled: true, exec
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CORRUPT_STORE');
    assert.equal(exec.mock.calls.length, 0);
  });

  it('reports gh-api-failed when the injected exec seam returns a non-zero exit', async () => {
    const exec = mock.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }));
    const result = await wiring.publishMergeGateStatusCheck({
      file, identity: { repo: 'o/r', pr: 1 }, sha: 'deadbeef', enabled: true, exec
    });
    assert.equal(result.published, false);
    assert.equal(result.reason, 'gh-api-failed');
  });

  it('throws WiringError when input.sha is missing', async () => {
    await assert.rejects(
      () => wiring.publishMergeGateStatusCheck({ file, identity: { repo: 'o/r', pr: 1 }, enabled: true }),
      wiring.WiringError
    );
  });
});

// ---------------------------------------------------------------------------
// #2883 -- scorecard
// ---------------------------------------------------------------------------

describe('refreshScorecardCache (#2883)', () => {
  it('is a no-op unless enabled is explicitly true', async () => {
    const produce = mock.fn(async () => ({ available: true, document: {} }));
    const write = mock.fn();
    const result = await wiring.refreshScorecardCache({ repoDir: dir, baseDir: dir, produce, write });
    assert.deepEqual(result, { refreshed: false, reason: 'disabled' });
    assert.equal(produce.mock.calls.length, 0);
  });

  it('writes the cache on a successful produce', async () => {
    const document = { generatedAt: 1000, freshUntil: 2000 };
    const produce = mock.fn(async () => ({ available: true, document }));
    const write = mock.fn();
    const result = await wiring.refreshScorecardCache({ repoDir: dir, baseDir: dir, enabled: true, produce, write });
    assert.equal(result.refreshed, true);
    assert.equal(result.generatedAt, 1000);
    assert.equal(write.mock.calls.length, 1);
    assert.equal(write.mock.calls[0].arguments[1], document);
  });

  it('reports the reason when figures could not be gathered, without writing', async () => {
    const produce = mock.fn(async () => ({ available: false, reason: 'no gh token' }));
    const write = mock.fn();
    const result = await wiring.refreshScorecardCache({ repoDir: dir, baseDir: dir, enabled: true, produce, write });
    assert.deepEqual(result, { refreshed: false, reason: 'no gh token' });
    assert.equal(write.mock.calls.length, 0);
  });

  it('reports write-refused when the write seam throws', async () => {
    const produce = mock.fn(async () => ({ available: true, document: {} }));
    const write = mock.fn(() => { throw new Error('refused: too large'); });
    const result = await wiring.refreshScorecardCache({ repoDir: dir, baseDir: dir, enabled: true, produce, write });
    assert.equal(result.refreshed, false);
    assert.equal(result.reason, 'write-refused');
    assert.match(result.detail, /too large/);
  });
});

describe('scheduleScorecardRefresh (#2883)', () => {
  it('is a no-op unless enabled is explicitly true -- no timer, no call to setIntervalFn', () => {
    const setIntervalFn = mock.fn();
    const result = wiring.scheduleScorecardRefresh({ setIntervalFn });
    assert.deepEqual(result, { scheduled: false, reason: 'disabled' });
    assert.equal(setIntervalFn.mock.calls.length, 0);
  });

  it('arms the injected timer at the given interval, and running it refreshes the cache', async () => {
    let scheduledFn;
    const setIntervalFn = mock.fn((fn) => { scheduledFn = fn; return 'timer-handle'; });
    const produce = mock.fn(async () => ({ available: true, document: { generatedAt: 1, freshUntil: 2 } }));
    const write = mock.fn();
    const result = wiring.scheduleScorecardRefresh({
      enabled: true, intervalMs: 5000, setIntervalFn, repoDir: dir, baseDir: dir, produce, write
    });
    assert.equal(result.scheduled, true);
    assert.equal(result.intervalMs, 5000);
    assert.equal(result.timer, 'timer-handle');
    assert.equal(setIntervalFn.mock.calls[0].arguments[1], 5000);

    await scheduledFn();
    assert.equal(produce.mock.calls.length, 1);
  });

  it('routes a refresh rejection to onError rather than throwing unhandled', async () => {
    let scheduledFn;
    const setIntervalFn = mock.fn((fn) => { scheduledFn = fn; });
    const produce = mock.fn(async () => { throw new Error('gh unreachable'); });
    const onError = mock.fn();
    wiring.scheduleScorecardRefresh({ enabled: true, setIntervalFn, repoDir: dir, baseDir: dir, produce, write: mock.fn(), onError });

    await scheduledFn();
    assert.equal(onError.mock.calls.length, 1);
    assert.match(onError.mock.calls[0].arguments[0].message, /gh unreachable/);
  });
});

describe('publishScorecardToMetricsBranch (#2883)', () => {
  const document = { schema: 'tc.scorecard/v1', generatedAt: 1 };

  it('is a no-op unless enabled is explicitly true', async () => {
    const exec = mock.fn(async () => ({ exitCode: 0 }));
    const result = await wiring.publishScorecardToMetricsBranch({ repoDir: dir, document, exec });
    assert.deepEqual(result, { published: false, reason: 'disabled' });
    assert.equal(exec.mock.calls.length, 0);
  });

  /**
   * A scripted git double: `hash-object` and the three index-building calls
   * succeed; `fetch` is the one call whose exit code the test controls, to
   * exercise both the branch-exists and branch-does-not-exist-yet paths.
   * @param {object} [opts]
   * @returns {{exec: Function, calls: object[]}}
   */
  function gitDouble({ fetchExitCode = 0 } = {}) {
    const calls = [];
    const exec = mock.fn(async (args) => {
      calls.push(args);
      const cmd = args[0];
      if (cmd === 'hash-object') return { exitCode: 0, stdout: 'blobsha\n', stderr: '' };
      if (cmd === 'fetch') return { exitCode: fetchExitCode, stdout: '', stderr: fetchExitCode === 0 ? '' : 'no such branch' };
      if (cmd === 'read-tree') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'update-index') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'write-tree') return { exitCode: 0, stdout: 'treesha\n', stderr: '' };
      if (cmd === 'commit-tree') return { exitCode: 0, stdout: 'commitsha\n', stderr: '' };
      if (cmd === 'push') return { exitCode: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected git ${cmd}`);
    });
    return { exec, calls };
  }

  it('publishes against an existing branch: read-tree runs, commit gets a parent', async () => {
    const { exec, calls } = gitDouble({ fetchExitCode: 0 });
    const result = await wiring.publishScorecardToMetricsBranch({ repoDir: dir, document, enabled: true, exec });
    assert.deepEqual(result, { published: true, branch: 'metrics', commit: 'commitsha' });
    assert.ok(calls.some((a) => a[0] === 'read-tree'));
    const commitArgs = calls.find((a) => a[0] === 'commit-tree');
    assert.ok(commitArgs.includes('-p'));
    assert.ok(commitArgs.includes('origin/metrics'));
  });

  it('publishes a first-ever branch: no read-tree, no commit parent', async () => {
    const { exec, calls } = gitDouble({ fetchExitCode: 1 });
    const result = await wiring.publishScorecardToMetricsBranch({ repoDir: dir, document, enabled: true, exec, branch: 'metrics' });
    assert.equal(result.published, true);
    assert.ok(!calls.some((a) => a[0] === 'read-tree'));
    const commitArgs = calls.find((a) => a[0] === 'commit-tree');
    assert.ok(!commitArgs.includes('-p'));
  });

  it('cleans up its scratch content and index files whether it succeeds or fails', async () => {
    const seen = [];
    const exec = mock.fn(async (args, options) => {
      if (args[0] === 'hash-object') { seen.push(args[1]); return { exitCode: 0, stdout: 'blobsha\n', stderr: '' }; }
      if (options && options.env && options.env.GIT_INDEX_FILE) seen.push(options.env.GIT_INDEX_FILE);
      if (args[0] === 'fetch') return { exitCode: 1, stdout: '', stderr: '' };
      if (args[0] === 'update-index') return { exitCode: 1, stdout: '', stderr: 'refused' };
      throw new Error(`unexpected ${args[0]}`);
    });
    const result = await wiring.publishScorecardToMetricsBranch({ repoDir: dir, document, enabled: true, exec });
    assert.equal(result.published, false);
    assert.equal(result.reason, 'update-index-failed');
    for (const p of seen) assert.equal(fs.existsSync(p), false);
  });

  it('short-circuits with hash-object-failed without calling fetch', async () => {
    const exec = mock.fn(async (args) => {
      if (args[0] === 'hash-object') return { exitCode: 1, stdout: '', stderr: 'disk full' };
      throw new Error(`unexpected ${args[0]}`);
    });
    const result = await wiring.publishScorecardToMetricsBranch({ repoDir: dir, document, enabled: true, exec });
    assert.equal(result.reason, 'hash-object-failed');
    assert.equal(exec.mock.calls.length, 1);
  });

  it('short-circuits with push-failed after a successful commit', async () => {
    const { exec, calls } = gitDouble({ fetchExitCode: 0 });
    exec.mock.mockImplementation(async (args) => {
      calls.push(args);
      const cmd = args[0];
      if (cmd === 'hash-object') return { exitCode: 0, stdout: 'blobsha\n', stderr: '' };
      if (cmd === 'fetch') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'read-tree') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'update-index') return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd === 'write-tree') return { exitCode: 0, stdout: 'treesha\n', stderr: '' };
      if (cmd === 'commit-tree') return { exitCode: 0, stdout: 'commitsha\n', stderr: '' };
      if (cmd === 'push') return { exitCode: 1, stdout: '', stderr: 'remote rejected' };
      throw new Error(`unexpected ${cmd}`);
    });
    const result = await wiring.publishScorecardToMetricsBranch({ repoDir: dir, document, enabled: true, exec });
    assert.equal(result.published, false);
    assert.equal(result.reason, 'push-failed');
  });
});

// ---------------------------------------------------------------------------
// #2877 -- roadmap
// ---------------------------------------------------------------------------

describe('roadmapCheckTrainAdmission (#2877)', () => {
  const candidate = { trainId: 'train:10', issues: ['#100'] };
  const facts = { issues: { '#100': { state: 'open' } }, trains: {} };

  it('admits an executable train with fresh matching facts', () => {
    const result = wiring.roadmapCheckTrainAdmission({
      candidate, facts, currentFacts: { ...facts, conflicts: { 'train:10': [] } }
    });
    assert.equal(result.classification, 'executable');
    assert.equal(result.admission.admitted, true);
  });

  it('reuses a given manifest instead of rebuilding it', () => {
    const manifest = wiring.roadmapCheckTrainAdmission({ candidate, facts, currentFacts: { ...facts, conflicts: { 'train:10': [] } } }).manifest;
    const spy = mock.method(require('../lib/roadmap-admission'), 'buildTrainAdmissionManifest');
    try {
      const result = wiring.roadmapCheckTrainAdmission({
        candidate, manifest, currentFacts: { ...facts, conflicts: { 'train:10': [] } }
      });
      assert.equal(result.admission.admitted, true);
      assert.equal(spy.mock.calls.length, 0);
    } finally {
      spy.mock.restore();
    }
  });

  it('refuses admission when a fresh conflict snapshot is missing', () => {
    const result = wiring.roadmapCheckTrainAdmission({ candidate, facts, currentFacts: facts });
    assert.equal(result.admission.admitted, false);
    assert.equal(result.admission.reason, 'conflict-snapshot-missing');
  });
});

describe('roadmapRunSyncCycle (#2877)', () => {
  let file;
  beforeEach(() => { file = path.join(dir, 'sync-state.json'); });

  it('persists the new state and reports published:true when the rendered roadmap changed', async () => {
    const liveSummaries = [{ id: '1', updatedAt: '2026-01-01T00:00:00Z' }];
    const renderRoadmap = mock.fn(async (prevState) => ({
      prevHtml: '<old>', nextHtml: '<new>',
      nextState: { ...prevState, lastRunAt: 1000 }
    }));
    const result = await wiring.roadmapRunSyncCycle({ file, liveSummaries, renderRoadmap });
    assert.equal(result.published, true);
    assert.deepEqual(result.changed.changedIssueIds, ['1']);
    const persisted = roadmapSync.loadSyncState(file);
    assert.equal(persisted.lastRunAt, 1000);
  });

  it('reports published:false when the rendered roadmap did not change, but still persists state', async () => {
    const renderRoadmap = mock.fn(async (prevState) => ({
      prevHtml: '<same>', nextHtml: '<same>', nextState: { ...prevState, lastRunAt: 2000 }
    }));
    const result = await wiring.roadmapRunSyncCycle({ file, liveSummaries: [], renderRoadmap });
    assert.equal(result.published, false);
    assert.equal(roadmapSync.loadSyncState(file).lastRunAt, 2000);
  });

  it('never persists a state when renderRoadmap itself rejects', async () => {
    const renderRoadmap = mock.fn(async () => { throw new Error('render failed'); });
    await assert.rejects(() => wiring.roadmapRunSyncCycle({ file, liveSummaries: [], renderRoadmap }), /render failed/);
    assert.equal(fs.existsSync(file), false);
  });
});

// ---------------------------------------------------------------------------
// Dead-exports guard: constants read only internally still count as dead per
// scripts/audit-dead-exports.js, so each one gets a direct read here.
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it('DEFAULT_STATUS_CONTEXT names the merge-inbox-gate status context', () => {
    assert.equal(wiring.DEFAULT_STATUS_CONTEXT, 'tangleclaw/merge-inbox-gate');
  });

  it('DEFAULT_SCORECARD_REFRESH_INTERVAL_MS is a positive number of milliseconds', () => {
    assert.ok(Number.isInteger(wiring.DEFAULT_SCORECARD_REFRESH_INTERVAL_MS) && wiring.DEFAULT_SCORECARD_REFRESH_INTERVAL_MS > 0);
  });

  it('_internal exposes the real default exec seams, for completeness of the injectable-seam contract', () => {
    assert.equal(typeof wiring._internal.defaultGhExec, 'function');
    assert.equal(typeof wiring._internal.defaultGitExec, 'function');
  });
});

// ---------------------------------------------------------------------------
// tc-verbs.js wiring: `tc docs manual` / `tc docs router` (#2887)
// ---------------------------------------------------------------------------

describe('tc docs manual / tc docs router verb wiring (#2887)', () => {
  const { VERB_ROSTER } = require('../lib/tc-verbs');
  const docsVerb = VERB_ROSTER.find((v) => v.id === 'docs');

  function writeManualManifest(targetDir) {
    fs.mkdirSync(path.join(targetDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'docs', 'manual-manifest.json'), JSON.stringify({
      schema: 'tc.manual-manifest/v1',
      pages: [{ id: 'p1', path: 'docs/p1.md', title: 'P1', audience: ['human'], surfaces: ['docs/p1.md'], sections: [] }]
    }));
  }

  it('is registered on the existing docs verb, not a new top-level verb', () => {
    assert.ok(docsVerb, 'docs verb must exist in VERB_ROSTER');
    assert.match(docsVerb.usage, /manual list\|show/);
    assert.match(docsVerb.usage, /router topic/);
  });

  it('tc docs manual list reads the default manifest relative to ctx.cwd', async () => {
    writeManualManifest(dir);
    const result = await docsVerb.run({ argv: ['manual', 'list'], cwd: dir });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed[0].id, 'p1');
  });

  it('tc docs manual list --file <path> overrides the default location', async () => {
    const custom = path.join(dir, 'custom-manifest.json');
    fs.writeFileSync(custom, JSON.stringify({ schema: 'tc.manual-manifest/v1', pages: [] }));
    const result = await docsVerb.run({ argv: ['manual', 'list', '--file', custom], cwd: dir });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), []);
  });

  it('tc docs manual show <ref> exits 2 for a reference that is not found', async () => {
    writeManualManifest(dir);
    const result = await docsVerb.run({ argv: ['manual', 'show', 'no-such-page'], cwd: dir });
    assert.equal(result.code, 2);
  });

  it('tc docs manual with an unknown form exits 1 with usage', async () => {
    const result = await docsVerb.run({ argv: ['manual', 'bogus'], cwd: dir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /docs manual needs/);
  });

  it('tc docs manual exits 2 with the library error for a missing manifest file', async () => {
    const result = await docsVerb.run({ argv: ['manual', 'list'], cwd: dir });
    assert.equal(result.code, 2);
  });

  it('tc docs router role <role> exits 0 with an empty match rather than erroring', async () => {
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'ai-doc-manifest.json'), JSON.stringify({ schema: 'tc.ai-doc-manifest/v1', topics: [] }));
    const result = await docsVerb.run({ argv: ['router', 'role', 'builder'], cwd: dir });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { found: true, entries: [] });
  });

  it('tc docs router with no form/value exits 1 with usage', async () => {
    const result = await docsVerb.run({ argv: ['router'], cwd: dir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /docs router needs/);
  });

  it('existing docs subcommands (lock/unlock/base/attest/notice forms) are unaffected', async () => {
    const result = await docsVerb.run({ argv: ['bogus-form'], cwd: dir, getJson: async () => ({ docs: [] }) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown docs form/);
  });
});
