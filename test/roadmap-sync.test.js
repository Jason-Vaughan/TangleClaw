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

  /**
   * A fake `gh api repos/{owner}/{repo}/issues --paginate ...`, returning
   * one JSON line per item (what `--jq` on an array actually emits).
   */
  function fakeIssuesList(items) {
    const calls = [];
    const exec = async (file, args, opts) => {
      calls.push({ file, args, opts });
      return { exitCode: 0, stdout: items.map((it) => JSON.stringify(it)).join('\n'), stderr: '', error: null };
    };
    return { exec, calls };
  }

  it('reads updatedAt/closed for every wanted issue with ONE call, not one per issue', async () => {
    const list = fakeIssuesList([
      { number: 1, updatedAt: '2026-01-01T00:00:00Z', state: 'open' },
      { number: 2, updatedAt: '2026-02-02T00:00:00Z', state: 'closed' }
    ]);
    roadmapSync._internal.exec = list.exec;
    const r = await roadmapSync.fetchIssueSummaries('/repo', [1, 2]);
    assert.equal(r.available, true);
    assert.equal(list.calls.length, 1, 'one list call covers every issue, not N per-issue calls');
    assert.equal(list.calls[0].args[1], 'repos/{owner}/{repo}/issues');
    assert.ok(list.calls[0].args.includes('--paginate'));
    assert.deepEqual(r.summaries.sort((a, b) => Number(a.id) - Number(b.id)), [
      { id: '1', updatedAt: '2026-01-01T00:00:00Z', closed: false },
      { id: '2', updatedAt: '2026-02-02T00:00:00Z', closed: true }
    ]);
  });

  it('excludes a pull-request-shaped item from the list — the issues endpoint also returns PRs', async () => {
    const list = fakeIssuesList([
      { number: 1, updatedAt: '2026-01-01T00:00:00Z', state: 'open' },
      { number: 999, updatedAt: '2026-03-03T00:00:00Z', state: 'open', pull_request: {} }
    ]);
    roadmapSync._internal.exec = list.exec;
    const r = await roadmapSync.fetchIssueSummaries('/repo', [1, 999]);
    assert.deepEqual(r.summaries.sort((a, b) => Number(a.id) - Number(b.id)), [
      { id: '1', updatedAt: '2026-01-01T00:00:00Z', closed: false },
      { id: '999', updatedAt: null, closed: false }
    ], '#999 is a PR, excluded from the issues map, so it reads as a plain not-found rather than its PR data leaking through');
  });

  it('passes `since` as a filter and omits an issue GitHub did not return, rather than guessing it unchanged', async () => {
    const list = fakeIssuesList([{ number: 2, updatedAt: '2026-02-02T00:00:00Z', state: 'closed' }]);
    roadmapSync._internal.exec = list.exec;
    const r = await roadmapSync.fetchIssueSummaries('/repo', [1, 2], { since: '2026-02-01T00:00:00Z' });
    assert.ok(list.calls[0].args.includes('since=2026-02-01T00:00:00Z'), 'since is passed through as a filter');
    assert.deepEqual(r.summaries, [{ id: '2', updatedAt: '2026-02-02T00:00:00Z', closed: true }], '#1 is simply absent, not a fabricated unchanged/null entry');
  });

  it('without `since`, a wanted issue GitHub did not return is a plain missing summary (full-resync mode)', async () => {
    roadmapSync._internal.exec = fakeIssuesList([]).exec;
    const r = await roadmapSync.fetchIssueSummaries('/repo', [1]);
    assert.deepEqual(r, { available: true, summaries: [{ id: '1', updatedAt: null, closed: false }] });
  });

  it('gh not installed is unavailable with that reason, never a guessed summary', async () => {
    roadmapSync._internal.exec = async () => ({ exitCode: 1, stdout: '', stderr: '', error: null, errorCode: 'ENOENT', timedOut: false });
    const r = await roadmapSync.fetchIssueSummaries('/repo', [1]);
    assert.deepEqual(r, { available: false, reason: 'gh is not installed' });
  });

  it('ignores duplicates and non-positive-integers, and makes no call at all when nothing is wanted', async () => {
    const list = fakeIssuesList([{ number: 5, updatedAt: 'x', state: 'open' }]);
    roadmapSync._internal.exec = list.exec;
    const r = await roadmapSync.fetchIssueSummaries('/repo', [5, '5', 0, -3, 'abc']);
    assert.equal(list.calls.length, 1);
    assert.deepEqual(r.summaries, [{ id: '5', updatedAt: 'x', closed: false }]);

    const r2 = await roadmapSync.fetchIssueSummaries('/repo', []);
    assert.equal(list.calls.length, 1, 'no numbers wanted means no gh call at all');
    assert.deepEqual(r2, { available: true, summaries: [] });
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
