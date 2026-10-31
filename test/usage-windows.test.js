'use strict';

/*
 * Multi-provider usage & quota window telemetry (#2599): Pacific-anchored
 * weekly reset math, parsing Claude Code's and Codex's own transcript JSONL
 * shapes (verified against real local logs on the authoring machine before
 * writing these fixtures — see `lib/usage-windows.js`'s own doc comment),
 * calibration, and the Conservation / Use-It-or-Lose-It policy windows.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const uw = require('../lib/usage-windows');

/**
 * A scratch directory this test owns, removed after the callback runs.
 * @param {(dir: string) => void} fn
 * @returns {void}
 */
function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-usage-windows-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A fresh (temp) store for every test in this file: any call that omits
// `deps.calibrationStore` reaches the default store, `store.usageCalibration`
// (schema v75), which needs an initialized database — even in tests that are
// not about calibration at all (`windowKind` reads it to decide the policy
// window). Per-test, not per-file, so a calibration one test writes can
// never leak into the next.
let _storeTmpDir;

beforeEach(() => {
  _storeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-usage-windows-store-'));
  store._setBasePath(_storeTmpDir);
  store.init();
});

afterEach(() => {
  store.close();
  fs.rmSync(_storeTmpDir, { recursive: true, force: true });
});

describe('lib/usage-windows — Pacific time math', () => {
  it('nextWeeklyResetAtMs lands on Thursday 06:00 Pacific', () => {
    const now = Date.UTC(2026, 9, 31, 20, 0); // Sat Oct 31 2026, 13:00 PT
    const reset = uw.nextWeeklyResetAtMs(now);
    const parts = uw.pacificParts(reset);
    assert.equal(parts.weekday, 4); // Thursday
    assert.equal(parts.hour, 6);
    assert.equal(parts.minute, 0);
    assert.ok(reset > now);
  });

  it('rolls to next week when already past Thursday 06:00 Pacific', () => {
    const thu7am = uw.pacificWallClockToUtcMs(2026, 10, 29, 7, 0);
    const reset = uw.nextWeeklyResetAtMs(thu7am);
    const parts = uw.pacificParts(reset);
    assert.equal(parts.day, 5); // the FOLLOWING Thursday, Nov 5
    assert.equal(parts.month, 11);
  });

  it('stays on the same Thursday when still before 06:00 Pacific', () => {
    const thu5am = uw.pacificWallClockToUtcMs(2026, 10, 29, 5, 0);
    const reset = uw.nextWeeklyResetAtMs(thu5am);
    const parts = uw.pacificParts(reset);
    assert.equal(parts.day, 29);
    assert.equal(parts.month, 10);
  });

  it('pacificWallClockToUtcMs round-trips through pacificParts', () => {
    const ms = uw.pacificWallClockToUtcMs(2026, 7, 4, 15, 30); // a DST (PDT) date
    const parts = uw.pacificParts(ms);
    assert.deepEqual(parts, { year: 2026, month: 7, day: 4, hour: 15, minute: 30, weekday: 6 });
  });

  it('pacificWallClockToUtcMs handles a winter (PST) date correctly too', () => {
    const ms = uw.pacificWallClockToUtcMs(2026, 1, 15, 9, 0);
    const parts = uw.pacificParts(ms);
    assert.equal(parts.hour, 9);
    assert.equal(parts.minute, 0);
  });

  it('previousWeeklyResetAtMs is the most recent Thursday 06:00 Pacific at or before now', () => {
    const wedNoon = uw.pacificWallClockToUtcMs(2026, 10, 28, 12, 0);
    const prev = uw.previousWeeklyResetAtMs(wedNoon);
    assert.deepEqual(uw.pacificParts(prev), { year: 2026, month: 10, day: 22, hour: 6, minute: 0, weekday: 4 });
  });

  it('previousWeeklyResetAtMs on Thursday before 06:00 lands on the PRIOR week\'s reset', () => {
    const thu5am = uw.pacificWallClockToUtcMs(2026, 10, 29, 5, 0);
    const prev = uw.previousWeeklyResetAtMs(thu5am);
    assert.equal(uw.pacificParts(prev).day, 22);
  });

  it('previousWeeklyResetAtMs on Thursday at/after 06:00 lands on TODAY\'s reset', () => {
    const thu7am = uw.pacificWallClockToUtcMs(2026, 10, 29, 7, 0);
    const prev = uw.previousWeeklyResetAtMs(thu7am);
    assert.equal(uw.pacificParts(prev).day, 29);
  });

  it('previousWeeklyResetAtMs stays exactly on 06:00 Pacific across the fall-back DST transition (not off by an hour)', () => {
    // Nov 1 2026 is when America/Los_Angeles falls back from PDT to PST, so
    // the week Thu Oct 29 06:00 PDT -> Thu Nov 5 06:00 PST spans 169 real
    // hours, not the 168 a fixed-millisecond subtraction would assume.
    const beforeNov5Reset = uw.pacificWallClockToUtcMs(2026, 11, 5, 3, 0);
    const prev = uw.previousWeeklyResetAtMs(beforeNov5Reset);
    assert.deepEqual(uw.pacificParts(prev), { year: 2026, month: 10, day: 29, hour: 6, minute: 0, weekday: 4 });
  });

  it('previousWeeklyResetAtMs at the exact reset instant returns that same instant, not a week earlier', () => {
    const exactReset = uw.pacificWallClockToUtcMs(2026, 10, 29, 6, 0);
    assert.equal(uw.previousWeeklyResetAtMs(exactReset), exactReset);
  });
});

describe('lib/usage-windows — windowKind policy', () => {
  it('is use-it-or-lose-it on Wednesday', () => {
    const wedNoon = uw.pacificWallClockToUtcMs(2026, 10, 28, 12, 0);
    assert.equal(uw.windowKind(wedNoon, 'claude', 15, {}), 'use-it-or-lose-it');
  });

  it('is use-it-or-lose-it on Thursday before 06:00', () => {
    const thu5am = uw.pacificWallClockToUtcMs(2026, 10, 29, 5, 0);
    assert.equal(uw.windowKind(thu5am, 'claude', 15, {}), 'use-it-or-lose-it');
  });

  it('is conservation on Thursday at/after 06:00 (right after reset)', () => {
    const thu7am = uw.pacificWallClockToUtcMs(2026, 10, 29, 7, 0);
    assert.equal(uw.windowKind(thu7am, 'claude', 15, {}), 'conservation');
  });

  it('is conservation Friday through Tuesday', () => {
    for (const [y, m, d] of [[2026, 10, 30], [2026, 10, 31], [2026, 11, 1], [2026, 11, 2], [2026, 11, 3]]) {
      const noon = uw.pacificWallClockToUtcMs(y, m, d, 12, 0);
      assert.equal(uw.windowKind(noon, 'claude', 15, {}), 'conservation', `${y}-${m}-${d}`);
    }
  });

  it('falls back to conservation inside the use-it slot when calibrated weekly headroom is low', () => {
    const wedNoon = uw.pacificWallClockToUtcMs(2026, 10, 28, 12, 0);
    const calStore = { get: () => ({ provider: 'claude', weeklyPct: 5, fiveHourPct: null, calibratedAt: 0 }), set: () => {} };
    assert.equal(uw.windowKind(wedNoon, 'claude', 15, { calibrationStore: calStore }), 'conservation');
  });

  it('recommendedPolicy reserves the higher tiers in conservation and offers them in use-it-or-lose-it', () => {
    const cons = uw.recommendedPolicy('conservation');
    assert.deepEqual(cons.recommendedModels, ['claude-sonnet-5']);
    assert.deepEqual(cons.reservedModels, ['claude-opus-5-5', 'claude-fable-5-1']);
    const useIt = uw.recommendedPolicy('use-it-or-lose-it');
    assert.deepEqual(useIt.recommendedModels, ['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1']);
    assert.deepEqual(useIt.reservedModels, []);
  });
});

describe('lib/usage-windows — calibration', () => {
  it('round-trips through the default store (schema v75 usage_calibration, durable across a restart)', () => {
    const result = uw.calibrateUsage({ provider: 'claude', weeklyPct: 42, fiveHourPct: 80 });
    assert.equal(result.ok, true);
    assert.equal(uw.getCalibration('claude').weeklyPct, 42);
    // Durable, not an in-memory cache: a fresh read through the store facade
    // directly sees the same row, not a process-local Map.
    assert.equal(store.usageCalibration.get('claude').weeklyPct, 42);
  });

  it('default store replaces a calibration in place rather than accumulating rows', () => {
    uw.calibrateUsage({ provider: 'claude', weeklyPct: 42 });
    uw.calibrateUsage({ provider: 'claude', weeklyPct: 7 });
    assert.equal(uw.getCalibration('claude').weeklyPct, 7);
  });

  it('round-trips through an injected store without touching the default one', () => {
    const store = new Map();
    const calibrationStore = { get: (p) => store.get(p) || null, set: (p, v) => store.set(p, v) };
    uw.calibrateUsage({ provider: 'codex', weeklyPct: 10 }, { calibrationStore });
    assert.equal(uw.getCalibration('codex', { calibrationStore }).weeklyPct, 10);
    assert.equal(store.size, 1);
  });

  it('rejects an unknown provider', () => {
    const result = uw.calibrateUsage({ provider: 'bogus', weeklyPct: 10 });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /provider must be one of/);
  });

  it('rejects a percentage out of 0-100', () => {
    const result = uw.calibrateUsage({ provider: 'claude', weeklyPct: 150 });
    assert.equal(result.ok, false);
  });

  it('requires at least one percentage field', () => {
    const result = uw.calibrateUsage({ provider: 'claude' });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /at least one of/);
  });
});

describe('lib/usage-windows — parseClaudeTranscripts', () => {
  it('sums usage from an assistant turn, ignoring other line types', () => {
    withTmpDir((dir) => {
      const projectDir = path.join(dir, 'some-project-slug');
      fs.mkdirSync(projectDir);
      const lines = [
        JSON.stringify({ type: 'user', timestamp: '2026-10-28T12:00:00.000Z' }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-28T12:00:01.000Z',
          message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 } }
        }),
        JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
        'not even json'
      ];
      fs.writeFileSync(path.join(projectDir, 'abc.jsonl'), lines.join('\n') + '\n');
      const records = uw.parseClaudeTranscripts(dir);
      assert.equal(records.length, 1);
      assert.equal(records[0].provider, 'claude');
      assert.equal(records[0].model, 'claude-sonnet-5');
      assert.equal(records[0].inputTokens, 10);
      assert.equal(records[0].outputTokens, 20);
      assert.equal(records[0].cacheCreationInputTokens, 5);
      assert.equal(records[0].cacheReadInputTokens, 3);
    });
  });

  it('answers with no records for a directory that does not exist', () => {
    const records = uw.parseClaudeTranscripts('/nonexistent/path/for/this/test');
    assert.deepEqual(records, []);
  });
});

describe('lib/usage-windows — parseCodexSessions', () => {
  it('attributes token_usage_record entries to the most recently seen world_state model', () => {
    withTmpDir((dir) => {
      const sessionDir = path.join(dir, '2026', '10', '31');
      fs.mkdirSync(sessionDir, { recursive: true });
      const lines = [
        JSON.stringify({ type: 'session_meta', timestamp: '2026-10-31T17:00:00.000Z', payload: {} }),
        JSON.stringify({
          type: 'token_usage_record', timestamp: '2026-10-31T17:00:01.000Z',
          payload: { usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0 } }
        }),
        JSON.stringify({
          type: 'world_state', timestamp: '2026-10-31T17:00:02.000Z',
          payload: { state: { collaboration_mode: { model: 'gpt-6-sol' } } }
        }),
        JSON.stringify({
          type: 'token_usage_record', timestamp: '2026-10-31T17:00:03.000Z',
          payload: { usage: { input_tokens: 200, output_tokens: 20, cached_input_tokens: 50, cache_write_input_tokens: 5 } }
        })
      ];
      fs.writeFileSync(path.join(sessionDir, 'rollout-x.jsonl'), lines.join('\n') + '\n');
      const records = uw.parseCodexSessions(dir);
      assert.equal(records.length, 2);
      assert.equal(records[0].model, 'unknown');
      assert.equal(records[0].inputTokens, 100);
      assert.equal(records[1].model, 'gpt-6-sol');
      assert.equal(records[1].inputTokens, 200);
      assert.equal(records[1].cacheReadInputTokens, 50);
      assert.equal(records[1].cacheCreationInputTokens, 5);
    });
  });
});

describe('lib/usage-windows — parseAntigravityTranscripts', () => {
  it('sums usage from a PLANNER_RESPONSE step, ignoring steps with no token fields', () => {
    withTmpDir((dir) => {
      const conversationDir = path.join(dir, 'f833a8a9-dfab-4a30-b0b3-76ddd81fc9a1', '.system_generated', 'logs');
      fs.mkdirSync(conversationDir, { recursive: true });
      const lines = [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-10-15T22:21:40Z', content: 'hello' }),
        JSON.stringify({
          step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-10-15T22:21:40Z',
          input_tokens: 15862, cache_read_tokens: 0, output_tokens: 100
        }),
        'not even json'
      ];
      fs.writeFileSync(path.join(conversationDir, 'transcript.jsonl'), lines.join('\n') + '\n');
      const records = uw.parseAntigravityTranscripts(dir);
      assert.equal(records.length, 1);
      assert.equal(records[0].provider, 'antigravity');
      assert.equal(records[0].model, 'unknown');
      assert.equal(records[0].inputTokens, 15862);
      assert.equal(records[0].outputTokens, 100);
      assert.equal(records[0].cacheReadInputTokens, 0);
      assert.equal(records[0].cacheCreationInputTokens, 0, 'Antigravity has no cache-write field at all');
    });
  });

  it('answers with no records for a directory that does not exist', () => {
    assert.deepEqual(uw.parseAntigravityTranscripts('/nonexistent/path/for/this/test'), []);
  });
});

describe('lib/usage-windows — getUsageWindows composition', () => {
  it('composes windows, reset schedule, calibration and a recommended policy', () => {
    withTmpDir((dir) => {
      const projectDir = path.join(dir, 'claude', 'p');
      fs.mkdirSync(projectDir, { recursive: true });
      const nowMs = uw.pacificWallClockToUtcMs(2026, 10, 28, 12, 0); // Wednesday noon PT — use-it slot
      fs.writeFileSync(path.join(projectDir, 'a.jsonl'), JSON.stringify({
        type: 'assistant', timestamp: new Date(nowMs - 60000).toISOString(),
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
      }) + '\n');
      const result = uw.getUsageWindows({
        claudeProjectsDir: projectDir, codexSessionsDir: path.join(dir, 'no-codex-here'), antigravityBrainDir: path.join(dir, 'no-antigravity-here'),
        nowMs, sprintStartMs: null // opted out — this test is not about the sprint window; see the dedicated describe block for it
      });
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].fiveHour.inputTokens, 10);
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].fiveHour.totalTokens, 30);
      assert.equal(result.recommendedPolicy.window, 'use-it-or-lose-it');
      assert.ok(result.resetSchedule.hoursUntilWeeklyReset > 0);
      assert.ok(Date.parse(result.resetSchedule.nextWeeklyResetAt) > nowMs);
      assert.ok('claude' in result.calibration);
      assert.ok('codex' in result.calibration);
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].sprint, null, 'explicit null opt-out');
    });
  });

  describe('sprintStartMs auto-default', () => {
    it('resolves the default from the latest git tag\'s commit time when none is given', () => {
      withTmpDir((dir) => {
        const projectDir = path.join(dir, 'claude', 'p');
        fs.mkdirSync(projectDir, { recursive: true });
        const nowMs = Date.now();
        const tagTimeMs = nowMs - 5 * 86400000;
        fs.writeFileSync(path.join(projectDir, 'a.jsonl'), JSON.stringify({
          type: 'assistant', timestamp: new Date(tagTimeMs + 60000).toISOString(),
          message: { model: 'claude-sonnet-5', usage: { input_tokens: 42, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
        }) + '\n');
        const calls = [];
        const execGit = (args) => {
          calls.push(args);
          if (args[0] === 'describe') return 'v9.9.9\n';
          return `${Math.floor(tagTimeMs / 1000)}\n`;
        };
        const result = uw.getUsageWindows({
          claudeProjectsDir: projectDir, codexSessionsDir: path.join(dir, 'no-codex'), antigravityBrainDir: path.join(dir, 'no-antigravity'),
          nowMs, deps: { execGit, repoRoot: '/irrelevant-for-this-test' }
        });
        assert.deepEqual(calls[0], ['describe', '--tags', '--abbrev=0']);
        assert.deepEqual(calls[1], ['log', '-1', '--format=%ct', 'v9.9.9']);
        assert.equal(result.byProviderModel.claude['claude-sonnet-5'].sprint.inputTokens, 42);
      });
    });

    it('falls back to now - 24h when git is unavailable or there is no tag', () => {
      withTmpDir((dir) => {
        const projectDir = path.join(dir, 'claude', 'p');
        fs.mkdirSync(projectDir, { recursive: true });
        const nowMs = Date.now();
        // One record just inside the 24h fallback, one just outside it.
        fs.writeFileSync(path.join(projectDir, 'a.jsonl'), [
          JSON.stringify({ type: 'assistant', timestamp: new Date(nowMs - 23 * 3600000).toISOString(), message: { model: 'claude-sonnet-5', usage: { input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
          JSON.stringify({ type: 'assistant', timestamp: new Date(nowMs - 25 * 3600000).toISOString(), message: { model: 'claude-sonnet-5', usage: { input_tokens: 99, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
        ].join('\n') + '\n');
        const result = uw.getUsageWindows({
          claudeProjectsDir: projectDir, codexSessionsDir: path.join(dir, 'no-codex'), antigravityBrainDir: path.join(dir, 'no-antigravity'),
          nowMs, deps: { execGit: () => { throw new Error('fatal: not a git repository'); } }
        });
        assert.equal(result.byProviderModel.claude['claude-sonnet-5'].sprint.inputTokens, 7, 'only the record inside the 24h fallback window counts');
      });
    });
  });

  it('includes a sprint window, summed from the given sprintStartMs, only when one is given', () => {
    withTmpDir((dir) => {
      const projectDir = path.join(dir, 'claude', 'p');
      fs.mkdirSync(projectDir, { recursive: true });
      const nowMs = uw.pacificWallClockToUtcMs(2026, 10, 28, 12, 0);
      const sprintStartMs = nowMs - 3 * 86400000;
      fs.writeFileSync(path.join(projectDir, 'a.jsonl'), [
        JSON.stringify({ type: 'assistant', timestamp: new Date(sprintStartMs - 60000).toISOString(), message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
        JSON.stringify({ type: 'assistant', timestamp: new Date(sprintStartMs + 60000).toISOString(), message: { model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
      ].join('\n') + '\n');
      const result = uw.getUsageWindows({ claudeProjectsDir: projectDir, codexSessionsDir: path.join(dir, 'no-codex'), antigravityBrainDir: path.join(dir, 'no-antigravity'), nowMs, sprintStartMs });
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].sprint.inputTokens, 5, 'only the record AT/AFTER sprintStartMs counts');
    });
  });

  it('excludes a record outside the 5-hour window but keeps it in the weekly window', () => {
    withTmpDir((dir) => {
      const projectDir = path.join(dir, 'claude', 'p');
      fs.mkdirSync(projectDir, { recursive: true });
      const nowMs = uw.pacificWallClockToUtcMs(2026, 10, 28, 12, 0);
      const sixHoursAgo = new Date(nowMs - 6 * 3600000).toISOString();
      fs.writeFileSync(path.join(projectDir, 'a.jsonl'), JSON.stringify({
        type: 'assistant', timestamp: sixHoursAgo,
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 99, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
      }) + '\n');
      const result = uw.getUsageWindows({ claudeProjectsDir: projectDir, codexSessionsDir: path.join(dir, 'no-codex'), antigravityBrainDir: path.join(dir, 'no-antigravity'), nowMs });
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].fiveHour.inputTokens, 0);
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].weekly.inputTokens, 99);
    });
  });

  it('the weekly window excludes a record from just before the Thursday 06:00 reset, across the fall-back DST transition', () => {
    withTmpDir((dir) => {
      const projectDir = path.join(dir, 'claude', 'p');
      fs.mkdirSync(projectDir, { recursive: true });
      // now = Thu Nov 5 2026 03:00 PST, inside the week that spans the Nov 1
      // fall-back transition. The correct weekly window starts Thu Oct 29
      // 06:00 PDT; a record one minute before THAT reset belongs to the
      // PRIOR week and must be excluded, even though a fixed-168h
      // subtraction from the next reset would have included it.
      const nowMs = uw.pacificWallClockToUtcMs(2026, 11, 5, 3, 0);
      const justBeforePriorReset = new Date(uw.pacificWallClockToUtcMs(2026, 10, 29, 5, 59)).toISOString();
      const justAfterPriorReset = new Date(uw.pacificWallClockToUtcMs(2026, 10, 29, 6, 1)).toISOString();
      fs.writeFileSync(path.join(projectDir, 'a.jsonl'), [
        JSON.stringify({ type: 'assistant', timestamp: justBeforePriorReset, message: { model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
        JSON.stringify({ type: 'assistant', timestamp: justAfterPriorReset, message: { model: 'claude-sonnet-5', usage: { input_tokens: 2, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
      ].join('\n') + '\n');
      const result = uw.getUsageWindows({ claudeProjectsDir: projectDir, codexSessionsDir: path.join(dir, 'no-codex'), antigravityBrainDir: path.join(dir, 'no-antigravity'), nowMs });
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].weekly.inputTokens, 2, 'only the record AFTER the correct reset instant counts');
    });
  });

  it('upserts every computed window into usage_window_aggregates (schema v76), readable back via getStoredAggregates', () => {
    withTmpDir((dir) => {
      const projectDir = path.join(dir, 'claude', 'p');
      fs.mkdirSync(projectDir, { recursive: true });
      const nowMs = uw.pacificWallClockToUtcMs(2026, 10, 28, 12, 0);
      fs.writeFileSync(path.join(projectDir, 'a.jsonl'), JSON.stringify({
        type: 'assistant', timestamp: new Date(nowMs - 60000).toISOString(),
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 11, output_tokens: 22, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
      }) + '\n');
      uw.getUsageWindows({
        claudeProjectsDir: projectDir, codexSessionsDir: path.join(dir, 'no-codex'), antigravityBrainDir: path.join(dir, 'no-antigravity'),
        nowMs, sprintStartMs: null
      });
      // Reads through the REAL store (this file's own beforeEach initializes
      // one fresh per test) — no injected aggregatesStore here on purpose,
      // proving the default path actually persists.
      const stored = uw.getStoredAggregates();
      assert.equal(stored.byModel.claude['claude-sonnet-5'].fiveHour.inputTokens, 11);
      assert.equal(stored.byModel.claude['claude-sonnet-5'].fiveHour.outputTokens, 22);
      assert.equal(stored.byModel.claude['claude-sonnet-5'].weekly.inputTokens, 11);
      assert.equal(stored.byModel.claude['claude-sonnet-5'].sprint, undefined, 'opted out of the sprint window, so no sprint row to store');
    });
  });

  it('re-computing upserts in place rather than accumulating duplicate rows', () => {
    withTmpDir((dir) => {
      const projectDir = path.join(dir, 'claude', 'p');
      fs.mkdirSync(projectDir, { recursive: true });
      const nowMs = uw.pacificWallClockToUtcMs(2026, 10, 28, 12, 0);
      const write = (tokens) => fs.writeFileSync(path.join(projectDir, 'a.jsonl'), JSON.stringify({
        type: 'assistant', timestamp: new Date(nowMs - 60000).toISOString(),
        message: { model: 'claude-sonnet-5', usage: { input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
      }) + '\n');
      const opts = { claudeProjectsDir: projectDir, codexSessionsDir: path.join(dir, 'no-codex'), antigravityBrainDir: path.join(dir, 'no-antigravity'), nowMs, sprintStartMs: null };
      write(5);
      uw.getUsageWindows(opts);
      write(9);
      uw.getUsageWindows(opts);
      assert.equal(uw.getStoredAggregates().byModel.claude['claude-sonnet-5'].fiveHour.inputTokens, 9);
    });
  });

  it('upserts distinct per-session aggregates alongside combined per-model aggregates for two sessions on the same model', () => {
    withTmpDir((dir) => {
      const projectDir = path.join(dir, 'claude', 'p');
      fs.mkdirSync(projectDir, { recursive: true });
      const nowMs = uw.pacificWallClockToUtcMs(2026, 10, 28, 12, 0);
      fs.writeFileSync(path.join(projectDir, 'session-a.jsonl'), JSON.stringify({
        type: 'assistant', timestamp: new Date(nowMs - 60000).toISOString(),
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
      }) + '\n');
      fs.writeFileSync(path.join(projectDir, 'session-b.jsonl'), JSON.stringify({
        type: 'assistant', timestamp: new Date(nowMs - 60000).toISOString(),
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 3, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
      }) + '\n');
      const result = uw.getUsageWindows({
        claudeProjectsDir: projectDir, codexSessionsDir: path.join(dir, 'no-codex'), antigravityBrainDir: path.join(dir, 'no-antigravity'),
        nowMs, sprintStartMs: null
      });
      assert.equal(result.bySession['session-a'].windows.fiveHour.inputTokens, 10);
      assert.equal(result.bySession['session-b'].windows.fiveHour.inputTokens, 3);
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].fiveHour.inputTokens, 13, 'per-model window combines both sessions');

      const storedSessionA = uw.getStoredAggregates({ sessionId: 'session-a' });
      assert.equal(storedSessionA.provider, 'claude');
      assert.equal(storedSessionA.model, 'claude-sonnet-5');
      assert.equal(storedSessionA.windows.fiveHour.inputTokens, 10);

      const storedAll = uw.getStoredAggregates();
      assert.equal(storedAll.bySession['session-a'].windows.fiveHour.inputTokens, 10);
      assert.equal(storedAll.bySession['session-b'].windows.fiveHour.inputTokens, 3);
      assert.equal(storedAll.byModel.claude['claude-sonnet-5'].fiveHour.inputTokens, 13);
    });
  });

  it('getStoredAggregates returns null for a sessionId with no rows on file', () => {
    withTmpDir((dir) => {
      assert.equal(uw.getStoredAggregates({ sessionId: 'no-such-session' }), null);
    });
  });
});
