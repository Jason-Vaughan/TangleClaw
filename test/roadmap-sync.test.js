'use strict';

// #2259 — incremental roadmap sync state, publish gate, budget telemetry.
// gh is faked through `_internal.exec`; nothing here reaches the network.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const roadmapSync = require('../lib/roadmap-sync');

setLevel('error');

describe('loadSyncState / saveSyncState', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-roadmap-sync-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('returns an empty state when no snapshot file exists yet', () => {
    const state = roadmapSync.loadSyncState(path.join(tmpDir, 'missing.json'));
    assert.deepEqual(state, roadmapSync.emptyState());
  });

  it('round-trips a saved state', () => {
    const file = path.join(tmpDir, 'state.json');
    const state = { schema: roadmapSync.SCHEMA, lastRunAt: 1000, lastFullResyncAt: 500, issues: { 1: { updatedAt: 'a', closed: false } } };
    roadmapSync.saveSyncState(file, state);
    assert.deepEqual(roadmapSync.loadSyncState(file), state);
  });

  it('refuses a state file with the wrong schema', () => {
    const file = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 'wrong', issues: {} }));
    assert.throws(() => roadmapSync.loadSyncState(file), roadmapSync.RoadmapSyncError);
  });

  it('refuses malformed JSON rather than guessing an empty state', () => {
    const file = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(file, '{not json');
    assert.throws(() => roadmapSync.loadSyncState(file), roadmapSync.RoadmapSyncError);
  });

  it('refuses saving a state with the wrong schema', () => {
    const file = path.join(tmpDir, 'out.json');
    assert.throws(() => roadmapSync.saveSyncState(file, { schema: 'wrong', issues: {} }), roadmapSync.RoadmapSyncError);
  });
});

describe('computeChangedSince', () => {
  it('a brand-new issue is changed', () => {
    const prev = { issues: {} };
    const r = roadmapSync.computeChangedSince(prev, [{ id: '1', updatedAt: 'a', closed: false }]);
    assert.deepEqual(r.changedIssueIds, ['1']);
  });

  it('an issue with the same updatedAt is not changed', () => {
    const prev = { issues: { 1: { updatedAt: 'a', closed: false } } };
    const r = roadmapSync.computeChangedSince(prev, [{ id: '1', updatedAt: 'a', closed: false }]);
    assert.deepEqual(r.changedIssueIds, []);
    assert.deepEqual(r.newlyLinkedPrIssueIds, []);
  });

  it('a different updatedAt marks the issue changed', () => {
    const prev = { issues: { 1: { updatedAt: 'a', closed: false } } };
    const r = roadmapSync.computeChangedSince(prev, [{ id: '1', updatedAt: 'b', closed: false }]);
    assert.deepEqual(r.changedIssueIds, ['1']);
  });

  it('a newly linked PR marks the issue as newly-linked even though updatedAt is unchanged', () => {
    const prev = { issues: { 1: { updatedAt: 'a', closed: false, linkedPrIds: ['10'] } } };
    const r = roadmapSync.computeChangedSince(prev, [{ id: '1', updatedAt: 'a', closed: false, linkedPrIds: ['10', '20'] }]);
    assert.deepEqual(r.changedIssueIds, []);
    assert.deepEqual(r.newlyLinkedPrIssueIds, ['1']);
  });

  it('a closed issue whose linked PRs are all merged or closed is skippable', () => {
    const prev = {
      issues: {
        1: { updatedAt: 'a', closed: true, linkedPrs: [{ state: 'merged' }, { state: 'closed' }] },
        2: { updatedAt: 'a', closed: true, linkedPrs: [{ state: 'open' }] },
        3: { updatedAt: 'a', closed: false, linkedPrs: [{ state: 'merged' }] }
      }
    };
    const r = roadmapSync.computeChangedSince(prev, []);
    assert.deepEqual(r.skippableClosedIssueIds, ['1']);
  });
});

describe('needsFullResync', () => {
  it('is true when no full resync has ever run', () => {
    assert.equal(roadmapSync.needsFullResync(roadmapSync.emptyState(), 1000), true);
  });

  it('is false inside the interval', () => {
    const prev = { lastFullResyncAt: 1000 };
    assert.equal(roadmapSync.needsFullResync(prev, 1000 + roadmapSync.DEFAULT_FULL_RESYNC_INTERVAL_MS - 1), false);
  });

  it('is true once the interval has fully elapsed', () => {
    const prev = { lastFullResyncAt: 1000 };
    assert.equal(roadmapSync.needsFullResync(prev, 1000 + roadmapSync.DEFAULT_FULL_RESYNC_INTERVAL_MS), true);
  });
});

describe('shouldPublishRoadmap', () => {
  it('publishes when the rendered HTML differs', () => {
    assert.equal(roadmapSync.shouldPublishRoadmap('<html>a</html>', '<html>b</html>', 'ok', 'ok'), true);
  });

  it('does not publish on identical HTML, even when status changed (#2259\'s own regression)', () => {
    assert.equal(roadmapSync.shouldPublishRoadmap('<html>a</html>', '<html>a</html>', 'Refresh failed', 'ok'), false);
  });
});

describe('buildStatusPayload', () => {
  it('builds an ok payload with telemetry', () => {
    const p = roadmapSync.buildStatusPayload({ rateLimitUsedDelta: 42, queriesExecuted: 3, changedIssuesCount: 2, published: true, now: 5000 });
    assert.equal(p.schema, roadmapSync.STATUS_SCHEMA);
    assert.equal(p.status, 'ok');
    assert.equal(p.reason, null);
    assert.equal(p.published, true);
    assert.equal(p.ranFullResync, false);
    assert.deepEqual(p.telemetry, { rateLimitUsedDelta: 42, queriesExecuted: 3, changedIssuesCount: 2 });
  });

  it('builds a failed payload with its reason', () => {
    const p = roadmapSync.buildStatusPayload({ rateLimitUsedDelta: 0, queriesExecuted: 0, changedIssuesCount: 0, published: false, ok: false, reason: 'gh is not installed' });
    assert.equal(p.status, 'failed');
    assert.equal(p.reason, 'gh is not installed');
  });

  it('rejects a negative telemetry value rather than recording a nonsense budget', () => {
    assert.throws(() => roadmapSync.buildStatusPayload({ rateLimitUsedDelta: -1, queriesExecuted: 0, changedIssuesCount: 0, published: false }), roadmapSync.RoadmapSyncError);
  });
});

describe('fetchIssueSummaries', () => {
  let original;
  beforeEach(() => { original = roadmapSync._internal.exec; });
  afterEach(() => { roadmapSync._internal.exec = original; });

  it('reads updatedAt/closed for each issue', async () => {
    const seen = [];
    roadmapSync._internal.exec = async (file, args, opts) => {
      seen.push(args);
      assert.equal(file, 'gh');
      assert.ok(opts && opts.cwd);
      const n = Number(args[1].match(/issues\/(\d+)$/)[1]);
      const answers = { 1: { updatedAt: '2026-01-01T00:00:00Z', state: 'open' }, 2: { updatedAt: '2026-02-02T00:00:00Z', state: 'closed' } };
      return { exitCode: 0, stdout: JSON.stringify(answers[n]), stderr: '', error: null };
    };
    const r = await roadmapSync.fetchIssueSummaries('/repo', [1, 2]);
    assert.equal(r.available, true);
    assert.deepEqual(r.summaries.sort((a, b) => a.id - b.id), [
      { id: '1', updatedAt: '2026-01-01T00:00:00Z', closed: false },
      { id: '2', updatedAt: '2026-02-02T00:00:00Z', closed: true }
    ]);
  });

  it('a 404 is treated as a plain missing summary, not an unavailable batch', async () => {
    roadmapSync._internal.exec = async () => ({ exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n', error: null });
    const r = await roadmapSync.fetchIssueSummaries('/repo', [1]);
    assert.deepEqual(r, { available: true, summaries: [{ id: '1', updatedAt: null, closed: false }] });
  });

  it('gh not installed is unavailable with that reason, never a guessed summary', async () => {
    roadmapSync._internal.exec = async () => ({ exitCode: 1, stdout: '', stderr: '', error: null, errorCode: 'ENOENT', timedOut: false });
    const r = await roadmapSync.fetchIssueSummaries('/repo', [1]);
    assert.deepEqual(r, { available: false, reason: 'gh is not installed' });
  });

  it('ignores duplicates and non-positive-integers', async () => {
    const calls = [];
    roadmapSync._internal.exec = async (file, args) => {
      calls.push(args[1].match(/issues\/(\d+)$/)[1]);
      return { exitCode: 0, stdout: JSON.stringify({ updatedAt: 'x', state: 'open' }), stderr: '', error: null };
    };
    await roadmapSync.fetchIssueSummaries('/repo', [5, '5', 0, -3, 'abc']);
    assert.deepEqual(calls, ['5']);
  });
});

describe('fetchLinkedPrIds', () => {
  let original;
  beforeEach(() => { original = roadmapSync._internal.exec; });
  afterEach(() => { roadmapSync._internal.exec = original; });

  it('reads cross-referenced PR numbers from the timeline', async () => {
    roadmapSync._internal.exec = async (file, args) => {
      assert.equal(file, 'gh');
      assert.match(args[1], /timeline$/);
      return { exitCode: 0, stdout: JSON.stringify([101, 102]), stderr: '', error: null };
    };
    const r = await roadmapSync.fetchLinkedPrIds('/repo', [7]);
    assert.deepEqual(r, { available: true, linkedPrIds: { 7: ['101', '102'] } });
  });

  it('an issue with no cross-referenced PRs yields an empty array, not a failure', async () => {
    roadmapSync._internal.exec = async () => ({ exitCode: 0, stdout: '[]', stderr: '', error: null });
    const r = await roadmapSync.fetchLinkedPrIds('/repo', [7]);
    assert.deepEqual(r, { available: true, linkedPrIds: { 7: [] } });
  });

  it('a lookup that could not run is unavailable, never a guessed empty list', async () => {
    roadmapSync._internal.exec = async () => ({ exitCode: 1, stdout: '', stderr: 'rate limited', error: 'boom', errorCode: null, timedOut: false });
    const r = await roadmapSync.fetchLinkedPrIds('/repo', [7]);
    assert.equal(r.available, false);
  });
});
