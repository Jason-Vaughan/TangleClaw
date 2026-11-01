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

  it('never reads transcript_full.jsonl or anything under logs/chunks/ — a real duplicate of transcript.jsonl, not additional data (#2766 BLOCKING 1/2 root cause, PRR-B Round 2)', () => {
    withTmpDir((dir) => {
      const logsDir = path.join(dir, 'c1', '.system_generated', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.mkdirSync(path.join(logsDir, 'chunks', 'transcript'), { recursive: true });
      fs.mkdirSync(path.join(logsDir, 'chunks', 'transcript_full'), { recursive: true });
      const real = JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-10-15T22:21:40Z', input_tokens: 100, output_tokens: 10 });
      // transcript.jsonl: the one file this is supposed to read.
      fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), real + '\n');
      // Three ways the SAME record could be double-counted if any of these
      // were read too — each written with a DIFFERENT token count so a
      // wrong total (not just a wrong record count) would be caught.
      fs.writeFileSync(path.join(logsDir, 'transcript_full.jsonl'),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-10-15T22:21:40Z', input_tokens: 999, output_tokens: 999 }) + '\n');
      fs.writeFileSync(path.join(logsDir, 'chunks', 'transcript', '00000000.jsonl'),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-10-15T22:21:40Z', input_tokens: 888, output_tokens: 888 }) + '\n');
      fs.writeFileSync(path.join(logsDir, 'chunks', 'transcript_full', '00000000.jsonl'),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-10-15T22:21:40Z', input_tokens: 777, output_tokens: 777 }) + '\n');
      const records = uw.parseAntigravityTranscripts(dir);
      assert.equal(records.length, 1, 'only transcript.jsonl\'s one record, not four copies of it');
      assert.equal(records[0].inputTokens, 100, 'the real file\'s own value, not a duplicate\'s');
    });
  });

  it('never descends into scratch/, .user_uploaded/, or .system_generated/{tasks,messages,steps}/ — only logs/transcript.jsonl is read per conversation', () => {
    withTmpDir((dir) => {
      const convDir = path.join(dir, 'c1');
      fs.mkdirSync(path.join(convDir, '.system_generated', 'logs'), { recursive: true });
      fs.writeFileSync(path.join(convDir, '.system_generated', 'logs', 'transcript.jsonl'),
        JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-10-15T22:21:40Z', input_tokens: 5, output_tokens: 5 }) + '\n');
      // Scratch/artifact subtrees real Antigravity conversations carry,
      // none of them transcripts — a correct implementation never even
      // lists these, let alone reads a `.jsonl` planted inside one.
      for (const sub of ['scratch', '.user_uploaded', path.join('.system_generated', 'tasks'), path.join('.system_generated', 'messages'), path.join('.system_generated', 'steps', '1')]) {
        fs.mkdirSync(path.join(convDir, sub), { recursive: true });
        fs.writeFileSync(path.join(convDir, sub, 'decoy.jsonl'),
          JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-10-15T22:21:40Z', input_tokens: 9999, output_tokens: 9999 }) + '\n');
      }
      const records = uw.parseAntigravityTranscripts(dir);
      assert.equal(records.length, 1);
      assert.equal(records[0].inputTokens, 5, 'the real transcript, none of the decoys planted alongside it');
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
      assert.equal(result.bySession['session-a'].claude['claude-sonnet-5'].fiveHour.inputTokens, 10);
      assert.equal(result.bySession['session-b'].claude['claude-sonnet-5'].fiveHour.inputTokens, 3);
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].fiveHour.inputTokens, 13, 'per-model window combines both sessions');

      const storedSessionA = uw.getStoredAggregates({ sessionId: 'session-a' });
      assert.equal(storedSessionA.claude['claude-sonnet-5'].fiveHour.inputTokens, 10);

      const storedAll = uw.getStoredAggregates();
      assert.equal(storedAll.bySession['session-a'].claude['claude-sonnet-5'].fiveHour.inputTokens, 10);
      assert.equal(storedAll.bySession['session-b'].claude['claude-sonnet-5'].fiveHour.inputTokens, 3);
      assert.equal(storedAll.byModel.claude['claude-sonnet-5'].fiveHour.inputTokens, 13);
    });
  });

  it('getStoredAggregates returns null for a sessionId with no rows on file', () => {
    withTmpDir((dir) => {
      assert.equal(uw.getStoredAggregates({ sessionId: 'no-such-session' }), null);
    });
  });

  it('one session that used two model IDs produces separate per-model breakdowns and separate SQLite rows (PRR-A Round 4 BLOCKING 3, #2599)', () => {
    withTmpDir((dir) => {
      const projectDir = path.join(dir, 'claude', 'p');
      fs.mkdirSync(projectDir, { recursive: true });
      const nowMs = uw.pacificWallClockToUtcMs(2026, 10, 28, 12, 0);
      // One transcript FILE (one sessionId, since the Claude parser derives
      // sessionId from the filename) carrying activity under TWO different
      // models — the exact shape a mid-session model switch (#2598) leaves
      // behind. Grouping by sessionId alone would attribute all 13 input
      // tokens to whichever model the FIRST record named.
      fs.writeFileSync(path.join(projectDir, 'session-mixed.jsonl'), [
        JSON.stringify({
          type: 'assistant', timestamp: new Date(nowMs - 120000).toISOString(),
          message: { model: 'claude-opus-4-6', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
        }),
        JSON.stringify({
          type: 'assistant', timestamp: new Date(nowMs - 60000).toISOString(),
          message: { model: 'claude-sonnet-5', usage: { input_tokens: 3, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
        })
      ].join('\n') + '\n');
      const result = uw.getUsageWindows({
        claudeProjectsDir: projectDir, codexSessionsDir: path.join(dir, 'no-codex'), antigravityBrainDir: path.join(dir, 'no-antigravity'),
        nowMs, sprintStartMs: null
      });
      assert.equal(result.bySession['session-mixed'].claude['claude-opus-4-6'].fiveHour.inputTokens, 10, 'the opus portion must stay separate from the sonnet portion');
      assert.equal(result.bySession['session-mixed'].claude['claude-sonnet-5'].fiveHour.inputTokens, 3);
      // Fleet-wide per-model is unaffected: each model still gets its own
      // row there too (this was never the bug — BLOCKING 3 is specific to
      // the per-session breakdown).
      assert.equal(result.byProviderModel.claude['claude-opus-4-6'].fiveHour.inputTokens, 10);
      assert.equal(result.byProviderModel.claude['claude-sonnet-5'].fiveHour.inputTokens, 3);

      // DB readback: two distinct rows for this one session, not one
      // combined row misattributed to a single model.
      const storedSession = uw.getStoredAggregates({ sessionId: 'session-mixed' });
      assert.equal(storedSession.claude['claude-opus-4-6'].fiveHour.inputTokens, 10);
      assert.equal(storedSession.claude['claude-sonnet-5'].fiveHour.inputTokens, 3);

      const storedAll = uw.getStoredAggregates();
      assert.equal(storedAll.bySession['session-mixed'].claude['claude-opus-4-6'].fiveHour.inputTokens, 10);
      assert.equal(storedAll.bySession['session-mixed'].claude['claude-sonnet-5'].fiveHour.inputTokens, 3);
    });
  });
});

describe('lib/usage-windows — bound-cache & pre-warm (#2766)', () => {
  afterEach(() => {
    uw._resetUsageWindowsCacheForTests();
  });

  it('a warm call never re-scans: the second call for the same key returns the cached result without touching the parsers again', () => {
    uw._resetUsageWindowsCacheForTests();
    let scans = 0;
    const deps = { readdir: () => { scans += 1; return []; } };
    const cold = uw.getUsageWindows({ deps });
    assert.equal(scans, 3, 'the cold call scans all three providers\' directories once each');
    const warm = uw.getUsageWindows({ deps });
    assert.equal(scans, 3, 'the warm call must not scan again — this is the budget #2766 asks for, not a slower-but-still-bounded scan');
    assert.equal(warm, cold, 'the exact cached object is served, not a fresh recomputation that merely looks equal');
  });

  it('a call naming any real-data override (claudeProjectsDir, nowMs, a store, ...) always recomputes fresh, uncached — the caching exists only for the zero-override production shape', () => {
    uw._resetUsageWindowsCacheForTests();
    let scans = 0;
    const deps = { readdir: () => { scans += 1; return []; } };
    uw.getUsageWindows({ deps, nowMs: Date.now() });
    uw.getUsageWindows({ deps, nowMs: Date.now() });
    assert.equal(scans, 6, 'a call that supplies nowMs must bypass the cache every time, exactly like before #2766');
  });

  it('a stale entry (older than USAGE_WINDOWS_CACHE_TTL_MS) is recomputed rather than served indefinitely', () => {
    uw._resetUsageWindowsCacheForTests();
    let scans = 0;
    const deps = { readdir: () => { scans += 1; return []; } };
    uw.getUsageWindows({ deps });
    assert.equal(scans, 3);
    const entry = uw._usageWindowsCacheForTests().get('claude');
    entry.computedAtMs -= (uw.USAGE_WINDOWS_CACHE_TTL_MS + 1);
    uw.getUsageWindows({ deps });
    assert.equal(scans, 6, 'past the TTL, the next call must pay for a fresh scan rather than keep serving stale data forever');
  });

  it('different policyProvider values each get their own cache entry, so one does not shadow the other', () => {
    uw._resetUsageWindowsCacheForTests();
    let scans = 0;
    const deps = { readdir: () => { scans += 1; return []; } };
    uw.getUsageWindows({ deps, policyProvider: 'claude' });
    assert.equal(scans, 3);
    uw.getUsageWindows({ deps, policyProvider: 'codex' });
    assert.equal(scans, 6, 'a different provider key is a cache miss, not a hit against claude\'s entry');
    uw.getUsageWindows({ deps, policyProvider: 'claude' });
    uw.getUsageWindows({ deps, policyProvider: 'codex' });
    assert.equal(scans, 6, 'both keys are now warm');
  });
});

describe('lib/usage-windows — scan budget and per-file cache (#2766 BLOCKING 1/2, PRR-B Round 1)', () => {
  afterEach(() => {
    uw._resetUsageWindowsCacheForTests();
  });

  /**
   * A fake directory listing of `count` files, none of them real — every
   * call here supplies its own `readFile`/`stat`, so nothing under this
   * fake path is ever actually opened.
   * @param {number} count
   * @returns {{name: string, isFile: () => boolean}[]}
   */
  function fakeEntries(count) {
    return Array.from({ length: count }, (_, i) => ({ name: `f${i}.jsonl`, isFile: () => true }));
  }

  /**
   * A true synchronous sleep with no busy-loop CPU burn and no subprocess
   * spawn, so a per-file "slow read" fake is fast to set up and precise.
   * @param {number} ms
   */
  function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  it('a scan deadline stops opening further files once it passes, rather than finishing an unbounded pass', () => {
    // 10 files at 200ms each is 2000ms of unbounded work against a 500ms
    // budget — this must come back having read only SOME of them, not all,
    // and well under what the full set would have cost.
    const deps = {
      readdir: () => fakeEntries(10),
      stat: () => ({ mtimeMs: 1000, size: 1 }),
      readFile: () => { sleepSync(200); return ''; },
      scanDeadlineMs: Date.now() + 500
    };
    const started = Date.now();
    const records = uw.parseClaudeTranscripts('/fake/claude', deps);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1800, `a bounded pass must not run anywhere near the full unbounded 2000ms (took ${elapsed}ms)`);
    assert.ok(records.length < 10, 'at least one file must have been skipped once the deadline passed');
  });

  it('the upfront stat pass itself is bounded, not just the later read-and-parse loop — a huge file COUNT alone cannot block past budget (#2766 BLOCKING 1, PRR-B Round 2)', () => {
    // A slow `stat`, not a slow `readFile`: proves the deadline is checked
    // during the stat-and-sort phase that runs BEFORE any file is read, the
    // exact phase PRR-B's round 2 named as still unbounded.
    const deps = {
      readdir: () => fakeEntries(10),
      stat: () => { sleepSync(200); return { mtimeMs: 1000, size: 1 }; },
      readFile: () => '',
      scanDeadlineMs: Date.now() + 500
    };
    const started = Date.now();
    const records = uw.parseClaudeTranscripts('/fake/claude', deps);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1800, `stat-ing every file must not run anywhere near the full unbounded 2000ms (took ${elapsed}ms)`);
    assert.ok(records.length < 10, 'at least one file must never even have been stat-ed once the deadline passed');
  });

  it('a slow stat pass still converges to complete: true across successive retries — the stat cache lets each one skip what an earlier one already paid for, rather than re-stat-ing from file 0 every time (#2766 BLOCKING 2, PRR-B Round 3)', () => {
    // Without a stat cache this loops forever: every retry re-stats from
    // the start of the list and hits the SAME deadline at the SAME point,
    // never reaching the files that would make the pass complete — exactly
    // what PRR-B's round 3 named. `antigravity` contributes nothing here
    // (`fakeEntries` isn't shaped as conversation directories), so this is
    // really just claude + codex, 10 fake files each, sharing one budget.
    const deps = {
      readdir: () => fakeEntries(10),
      stat: () => { sleepSync(200); return { mtimeMs: 1000, size: 1 }; },
      readFile: () => ''
    };
    let result;
    let calls = 0;
    const CEILING = 10;
    for (; calls < CEILING; calls++) {
      result = uw.getUsageWindows({ deps });
      if (result.complete) break;
    }
    assert.equal(result.complete, true, `must converge to complete within a bounded number of retries (gave up after ${calls + 1})`);
    assert.ok(calls + 1 < CEILING, `should converge comfortably before the ${CEILING}-call ceiling (took ${calls + 1} calls)`);
  });

  it('an unchanged file (same mtimeMs and size) is never re-read on a second pass — the cache that makes a repeat scan cheap', () => {
    let reads = 0;
    const fileRecordCache = new Map();
    const deps = {
      readdir: () => fakeEntries(3),
      stat: () => ({ mtimeMs: 42, size: 7 }),
      readFile: () => { reads += 1; return ''; },
      fileRecordCache
    };
    uw.parseClaudeTranscripts('/fake/claude', deps);
    assert.equal(reads, 3, 'the first pass reads every file once');
    uw.parseClaudeTranscripts('/fake/claude', deps);
    assert.equal(reads, 3, 'the second pass, same (mtimeMs, size) for every file, must not read any of them again');
  });

  it('a file whose mtimeMs or size changed IS re-read — the cache tracks staleness, not just presence', () => {
    let reads = 0;
    let size = 7;
    const fileRecordCache = new Map();
    const deps = {
      readdir: () => fakeEntries(1),
      stat: () => ({ mtimeMs: 42, size }),
      readFile: () => { reads += 1; return ''; },
      fileRecordCache
    };
    uw.parseClaudeTranscripts('/fake/claude', deps);
    assert.equal(reads, 1);
    size = 8; // the file grew — a real append
    uw.parseClaudeTranscripts('/fake/claude', deps);
    assert.equal(reads, 2, 'a changed file must be re-read, not served from the stale cache entry');
  });

  it('getUsageWindows itself stays bounded on a cold call with a lot of slow-to-read history, and honestly reports complete: false — not just the parser in isolation (#2766 BLOCKING 1/2, PRR-B Round 1/2)', () => {
    // The actual BLOCKING 1 finding: the cold path through the cache
    // wrapper, not merely `_scanFiles` on its own, has to honor the
    // budget — this is what a real first `tc usage windows` call after
    // server start goes through. BLOCKING 2: that same call must say so,
    // not look like an ordinary complete snapshot.
    const deps = {
      readdir: () => fakeEntries(20),
      stat: () => ({ mtimeMs: 1000, size: 1 }),
      readFile: () => { sleepSync(300); return ''; }
    };
    const started = Date.now();
    const result = uw.getUsageWindows({ deps });
    const elapsed = Date.now() - started;
    // 20 files * 0.3s * 3 providers would be 18s unbounded; each provider's
    // own scan is bounded by the SAME shared budget
    // (`USAGE_WINDOWS_SCAN_BUDGET_MS`), so the whole cold call must land
    // nowhere near that, comfortably inside `tc usage windows`'s CLI timeout.
    assert.ok(elapsed < uw.USAGE_WINDOWS_SCAN_BUDGET_MS * 3 + 1000,
      `a cold call must stay bounded by the scan budget per provider, not by how much slow history exists (took ${elapsed}ms)`);
    assert.equal(result.complete, false, 'the scan did not finish within budget, and the result must say so');
  });

  it('a forced-stale recompute (what the background warmer also does, on the identical code path) is bounded the same way', () => {
    // The warmer's own `setInterval` tick calls the exact same
    // `_computeUsageWindows({ policyProvider, deps: _boundedScanDeps() })`
    // expression as this recompute does — proving THIS path is bounded is
    // proving the warmer's 20s tick is too, since there is only one such
    // expression in the module, not two.
    const deps = {
      readdir: () => fakeEntries(20),
      stat: () => ({ mtimeMs: 1000, size: 1 }),
      readFile: () => { sleepSync(300); return ''; }
    };
    uw.getUsageWindows({ deps }); // first cold call, populates the cache entry
    const entry = uw._usageWindowsCacheForTests().get('claude');
    entry.computedAtMs -= (uw.USAGE_WINDOWS_CACHE_TTL_MS + 1); // force the next call to recompute
    const started = Date.now();
    uw.getUsageWindows({ deps });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < uw.USAGE_WINDOWS_SCAN_BUDGET_MS * 3 + 1000,
      `a forced recompute must stay bounded exactly like the cold call (took ${elapsed}ms)`);
  });

  it('an ordinary, unbounded-by-nothing-blocking pass reports complete: true', () => {
    const deps = { readdir: () => [], stat: () => ({ mtimeMs: 1, size: 1 }), readFile: () => '' };
    const result = uw.getUsageWindows({ deps });
    assert.equal(result.complete, true);
  });

  it('an incomplete cached entry is not trusted for the TTL — the next call retries immediately rather than serving a known-partial answer for 30s', () => {
    let readdirCalls = 0;
    const deps = {
      readdir: () => { readdirCalls += 1; return fakeEntries(20); },
      stat: () => ({ mtimeMs: 1000, size: 1 }),
      readFile: () => { sleepSync(300); return ''; }
    };
    const first = uw.getUsageWindows({ deps });
    assert.equal(first.complete, false, 'fixture precondition: the first pass must truncate');
    const callsAfterFirst = readdirCalls;
    uw.getUsageWindows({ deps }); // immediately again, well within the 30s TTL
    assert.ok(readdirCalls > callsAfterFirst,
      'an incomplete entry must not be served as a cache hit — the next call must retry rather than wait out the TTL');
  });

  it('a truncated refresh never replaces an existing COMPLETE cached entry with a worse, undercounting one (#2766 BLOCKING 2, PRR-B Round 2)', () => {
    const fastDeps = { readdir: () => [], stat: () => ({ mtimeMs: 1, size: 1 }), readFile: () => '' };
    const complete = uw.getUsageWindows({ deps: fastDeps });
    assert.equal(complete.complete, true, 'fixture precondition: the first pass must complete');
    const entry = uw._usageWindowsCacheForTests().get('claude');
    entry.computedAtMs -= (uw.USAGE_WINDOWS_CACHE_TTL_MS + 1); // force the next call to attempt a refresh
    const slowDeps = {
      readdir: () => fakeEntries(20),
      stat: () => ({ mtimeMs: 1000, size: 1 }),
      readFile: () => { sleepSync(300); return ''; }
    };
    const served = uw.getUsageWindows({ deps: slowDeps });
    assert.equal(served, complete, 'the stale-but-complete snapshot must still be served, not a fresher but truncated one');
    assert.equal(uw._usageWindowsCacheForTests().get('claude').result, complete,
      'the cache entry itself must not have been overwritten with the truncated attempt either');
  });
});
