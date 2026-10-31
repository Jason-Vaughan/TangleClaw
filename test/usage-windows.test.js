'use strict';

/*
 * Multi-provider usage & quota window telemetry (#2599): Pacific-anchored
 * weekly reset math, parsing Claude Code's and Codex's own transcript JSONL
 * shapes (verified against real local logs on the authoring machine before
 * writing these fixtures — see `lib/usage-windows.js`'s own doc comment),
 * calibration, and the Conservation / Use-It-or-Lose-It policy windows.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  it('round-trips through the default in-memory store', () => {
    const result = uw.calibrateUsage({ provider: 'claude', weeklyPct: 42, fiveHourPct: 80 });
    assert.equal(result.ok, true);
    assert.equal(uw.getCalibration('claude').weeklyPct, 42);
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
      const result = uw.getUsageWindows({ claudeProjectsDir: projectDir, codexSessionsDir: path.join(dir, 'no-codex-here'), nowMs });
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].fiveHour.inputTokens, 10);
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].fiveHour.totalTokens, 30);
      assert.equal(result.recommendedPolicy.window, 'use-it-or-lose-it');
      assert.ok(result.resetSchedule.hoursUntilWeeklyReset > 0);
      assert.ok(Date.parse(result.resetSchedule.nextWeeklyResetAt) > nowMs);
      assert.ok('claude' in result.calibration);
      assert.ok('codex' in result.calibration);
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
      const result = uw.getUsageWindows({ claudeProjectsDir: projectDir, codexSessionsDir: path.join(dir, 'no-codex'), nowMs });
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].fiveHour.inputTokens, 0);
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].weekly.inputTokens, 99);
    });
  });
});
