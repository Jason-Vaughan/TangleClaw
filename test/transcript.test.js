'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const transcript = require('../lib/transcript');

// A fake AWS key assembled from parts so no contiguous secret literal sits in
// this tracked test file (GitHub push-protection lesson from CC-4).
const FAKE_AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';

describe('transcript (CC-4b #376, Codex #2074)', () => {
  let tmp; // sandbox root
  let home; // fake ~/.claude
  let codexHome; // fake ~/.codex
  let projectPath;
  let realClaudeHome;
  let realCodexHome;

  /** Write a JSONL transcript into the fake ~/.claude for the given cwd. */
  function writeTranscript(dirName, uuid, cwd, extraLines = []) {
    const dir = path.join(home, 'projects', dirName);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'summary', mode: 'x', sessionId: uuid }),
      JSON.stringify({ type: 'message', role: 'user', cwd, content: 'hello' }),
      ...extraLines
    ];
    const file = path.join(dir, `${uuid}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  /**
   * Write a JSONL rollout into the fake `~/.codex/sessions/<datePath>`,
   * shaped exactly like a real Codex rollout's first line (confirmed against
   * real files under `~/.codex/sessions` for #2074): `{type: "session_meta",
   * payload: {id, cwd, timestamp}}`, followed by whatever extra lines a test
   * needs. `datePath` defaults to a fixed partition since the resolver walks
   * every subdirectory regardless of its name.
   */
  function writeCodexRollout({ uuid, cwd, startedAt, datePath = '2026/01/01', extraLines = [] }) {
    const dir = path.join(codexHome, 'sessions', datePath);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: uuid, cwd, timestamp: startedAt } }),
      ...extraLines
    ];
    const file = path.join(dir, `rollout-${startedAt.replace(/[:.]/g, '-')}-${uuid}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-'));
    home = path.join(tmp, 'claude-home');
    codexHome = path.join(tmp, 'codex-home');
    projectPath = path.join(tmp, 'proj');
    fs.mkdirSync(projectPath, { recursive: true });
    realClaudeHome = transcript._internal.claudeHome;
    realCodexHome = transcript._internal.codexHome;
    transcript._internal.claudeHome = () => home;
    transcript._internal.codexHome = () => codexHome;
  });

  afterEach(() => {
    transcript._internal.claudeHome = realClaudeHome;
    transcript._internal.codexHome = realCodexHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('_normalizeHarness', () => {
    it('maps engine ids to adapter keys', () => {
      assert.equal(transcript._normalizeHarness('claude'), 'claude');
      assert.equal(transcript._normalizeHarness('claude-code'), 'claude');
      assert.equal(transcript._normalizeHarness('openclaw:42'), 'openclaw');
      assert.equal(transcript._normalizeHarness('GEMINI'), 'gemini');
      assert.equal(transcript._normalizeHarness(''), 'unknown');
      assert.equal(transcript._normalizeHarness(null), 'unknown');
    });
  });

  describe('resolve (Claude adapter)', () => {
    it('resolves the cwd-matching transcript in the encoded dir', () => {
      const enc = transcript._encodeDir(projectPath);
      const file = writeTranscript(enc, 'aaaaaaaa-1111', projectPath);
      const hit = transcript.resolve('claude', projectPath, { engineId: 'claude' });
      assert.equal(hit, file);
    });

    it('picks the NEWEST cwd-matching transcript', () => {
      const enc = transcript._encodeDir(projectPath);
      const older = writeTranscript(enc, 'old-0000', projectPath);
      const newer = writeTranscript(enc, 'new-9999', projectPath);
      // Force a stale mtime on the older file.
      const past = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(older, past, past);
      assert.equal(transcript.resolve('claude', projectPath, {}), newer);
    });

    it('ignores a transcript whose cwd does not match', () => {
      const enc = transcript._encodeDir(projectPath);
      writeTranscript(enc, 'other-0000', '/some/other/project');
      assert.equal(transcript.resolve('claude', projectPath, {}), null);
    });

    it('falls back to scanning all dirs when the encoded dir is absent', () => {
      // Transcript filed under an unexpected dir name, but cwd still matches.
      const file = writeTranscript('weird-dir-name', 'fallback-1', projectPath);
      assert.equal(transcript.resolve('claude', projectPath, {}), file);
    });

    it('returns null when ~/.claude has no match / is empty', () => {
      assert.equal(transcript.resolve('claude', projectPath, {}), null);
    });

    it('returns null for non-Claude harnesses still backed by a stub (#2074: codex has its own real adapter, tested separately)', () => {
      const enc = transcript._encodeDir(projectPath);
      writeTranscript(enc, 'x-1', projectPath); // present, but harness has no adapter impl
      for (const h of ['gemini', 'aider', 'openclaw', 'unknown']) {
        assert.equal(transcript.resolve(h, projectPath, {}), null, `${h} must resolve null`);
      }
    });
  });

  describe('_parseStoreTimestamp (bare SQLite UTC shape, I-Gate Round 2)', () => {
    it('parses SQLite\'s own datetime(\'now\') shape as UTC, not local time', () => {
      // The exact bug PRR-A caught: Date.parse('2026-11-03 09:00:00') reads
      // local time on a non-UTC host (17:00:00Z on America/Los_Angeles), not
      // the 09:00:00Z the string actually means. Asserting against the known
      // millisecond value (not just "doesn't throw") makes this test fail the
      // same way regardless of which TZ the suite itself runs under.
      const ms = transcript._parseStoreTimestamp('2026-11-03 09:00:00');
      assert.equal(ms, Date.parse('2026-11-03T09:00:00.000Z'));
    });

    it('parses a real ISO string (with its own zone) exactly as Date.parse would, unchanged', () => {
      const iso = '2026-11-03T09:00:00.000Z';
      assert.equal(transcript._parseStoreTimestamp(iso), Date.parse(iso));
    });

    it('returns NaN for null/undefined/non-string input, never throws', () => {
      assert.ok(Number.isNaN(transcript._parseStoreTimestamp(null)));
      assert.ok(Number.isNaN(transcript._parseStoreTimestamp(undefined)));
      assert.ok(Number.isNaN(transcript._parseStoreTimestamp(12345)));
      assert.ok(Number.isNaN(transcript._parseStoreTimestamp('')));
    });
  });

  describe('resolve (Codex adapter, #2074)', () => {
    const START = '2026-06-01T12:00:00.000Z';

    it('resolves against a real SQLite-shaped session.startedAt/endedAt, not just ISO test fixtures (I-Gate Round 2)', () => {
      // Real store rows carry 'YYYY-MM-DD HH:MM:SS', never the ISO strings
      // every other test in this file uses for convenience. This is the one
      // test that uses the store's own real shape end to end, so a future
      // regression in _parseStoreTimestamp fails here even if every
      // ISO-fixture test above it keeps passing (which, on a UTC CI host,
      // they would — the bug is invisible unless the parsed value is checked
      // against the real intended UTC instant).
      const file = writeCodexRollout({ uuid: 'sqlite-shape-1', cwd: projectPath, startedAt: '2026-11-03T09:00:00.000Z' });
      const hit = transcript.resolve('codex', projectPath, {
        engineId: 'codex', startedAt: '2026-11-03 09:00:00', endedAt: '2026-11-03 09:10:00'
      });
      assert.equal(hit, file);
    });

    it('resolves the cwd-matching rollout', () => {
      const file = writeCodexRollout({ uuid: 'aaaa-1111', cwd: projectPath, startedAt: START });
      const hit = transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START });
      assert.equal(hit, file);
    });

    it('ignores a rollout whose cwd does not match', () => {
      writeCodexRollout({ uuid: 'other-0000', cwd: '/some/other/project', startedAt: START });
      assert.equal(transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START }), null);
    });

    it('returns null when ~/.codex/sessions has no match / is empty', () => {
      assert.equal(transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START }), null);
    });

    it('finds a rollout nested several date-partitioned directories deep', () => {
      const file = writeCodexRollout({ uuid: 'deep-1', cwd: projectPath, startedAt: START, datePath: '2026/06/01' });
      assert.equal(transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START }), file);
    });

    it('time-window boundary: a rollout just inside the grace window matches; just outside it does not', () => {
      const windowMs = transcript._internal.codexWindowMs;
      const tcStartedMs = Date.parse(START);

      const justInside = new Date(tcStartedMs - windowMs + 1000).toISOString();
      const insideFile = writeCodexRollout({ uuid: 'inside-1', cwd: projectPath, startedAt: justInside });
      assert.equal(
        transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START }),
        insideFile,
        'a rollout 1s inside the grace window must match'
      );
      fs.rmSync(insideFile);

      const justOutside = new Date(tcStartedMs - windowMs - 1000).toISOString();
      writeCodexRollout({ uuid: 'outside-1', cwd: projectPath, startedAt: justOutside });
      assert.equal(
        transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START }),
        null,
        'a rollout 1s outside the grace window must not match'
      );
    });

    it('fails closed (refuses, does not guess) when two rollouts match the same cwd and time window', () => {
      writeCodexRollout({ uuid: 'amb-1', cwd: projectPath, startedAt: START, datePath: '2026/06/01' });
      writeCodexRollout({ uuid: 'amb-2', cwd: projectPath, startedAt: '2026-06-01T12:05:00.000Z', datePath: '2026/06/01' });
      assert.equal(transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START }), null);
    });

    it('does not fail closed on two same-cwd rollouts when only one falls in the time window', () => {
      // A much earlier, unrelated session at the same cwd must not make a
      // genuinely unambiguous later one refuse.
      writeCodexRollout({ uuid: 'old-session', cwd: projectPath, startedAt: '2026-01-15T00:00:00.000Z' });
      const file = writeCodexRollout({ uuid: 'current-session', cwd: projectPath, startedAt: START });
      assert.equal(transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START }), file);
    });

    it('resolves without a time filter when the TC session carries no startedAt (matches on cwd alone)', () => {
      const file = writeCodexRollout({ uuid: 'no-started-at', cwd: projectPath, startedAt: START });
      assert.equal(transcript.resolve('codex', projectPath, { engineId: 'codex' }), file);
    });

    it('bounds the upper end too: a sole rollout that started after the session ended does not match (I-Gate Round 1)', () => {
      // A lower-bound-only check would never catch this — a LATER rollout is
      // never "too old". Without session.endedAt, "now" stands in for it, so
      // a rollout dated in the future relative to the live clock must also
      // not match a currently-live wrap's session.
      const future = new Date(Date.parse(START) + 2 * transcript._internal.codexWindowMs).toISOString();
      writeCodexRollout({ uuid: 'future-only', cwd: projectPath, startedAt: future });
      assert.equal(transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START, endedAt: START }), null);
    });

    it('backfilling an old [startedAt, endedAt] session does not pick up a newer rollout created after endedAt (I-Gate Round 1)', () => {
      const endedAt = new Date(Date.parse(START) + 5 * 60 * 1000).toISOString();
      const after = new Date(Date.parse(endedAt) + 2 * transcript._internal.codexWindowMs).toISOString();
      const correct = writeCodexRollout({ uuid: 'during-session', cwd: projectPath, startedAt: START });
      writeCodexRollout({ uuid: 'after-session-ended', cwd: projectPath, startedAt: after });
      // Two same-cwd candidates would normally be ambiguous and refuse — the
      // point here is that the upper bound excludes the later one BEFORE
      // ambiguity is even considered, leaving exactly one (correct) match.
      assert.equal(transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START, endedAt }), correct);
    });

    it('fails closed on an invalid native timestamp — never treated as "no filter applies" (I-Gate Round 1)', () => {
      writeCodexRollout({ uuid: 'bad-timestamp', cwd: projectPath, startedAt: 'not-a-real-timestamp' });
      assert.equal(transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START }), null);
    });

    it('honest skip on a rollout whose first line is not valid session_meta JSON', () => {
      const dir = path.join(codexHome, 'sessions', '2026/06/01');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'rollout-corrupt.jsonl'), 'not json at all\n');
      assert.equal(transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START }), null);
    });

    it('a file not ending in .jsonl under the sessions tree is never considered', () => {
      const dir = path.join(codexHome, 'sessions', '2026/06/01');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: projectPath, timestamp: START } }));
      assert.equal(transcript.resolve('codex', projectPath, { engineId: 'codex', startedAt: START }), null);
    });
  });

  describe('snapshot', () => {
    it('copies the transcript + writes a correct meta sidecar', async () => {
      const enc = transcript._encodeDir(projectPath);
      writeTranscript(enc, 'session-uuid-123', projectPath, [
        JSON.stringify({ type: 'message', cwd: projectPath, content: 'no secrets here' })
      ]);
      const r = await transcript.snapshot({ name: 'proj', path: projectPath }, { engineId: 'claude' }, 7);
      assert.equal(r.captured, true);
      assert.equal(r.secretsFlagged, false);
      assert.ok(r.lineCount >= 3);

      const sessDir = require('../lib/continuity').sessionDir(projectPath, 7);
      assert.ok(fs.existsSync(path.join(sessDir, 'transcript.jsonl')), 'transcript copied');
      const meta = JSON.parse(fs.readFileSync(path.join(sessDir, 'transcript.meta.json'), 'utf8'));
      assert.equal(meta.harness, 'claude');
      assert.equal(meta.claudeSessionId, 'session-uuid-123');
      assert.equal(meta.cwd, projectPath);
      assert.equal(meta.secretsFlagged, false);
      assert.ok(meta.bytes > 0 && meta.lineCount >= 3 && meta.capturedAt);
    });

    it('flags a secret in the transcript — types only, never the value', async () => {
      const enc = transcript._encodeDir(projectPath);
      writeTranscript(enc, 'leak-1', projectPath, [
        JSON.stringify({ type: 'message', cwd: projectPath, content: `export K=${FAKE_AWS}` })
      ]);
      const r = await transcript.snapshot({ name: 'proj', path: projectPath }, { engineId: 'claude' }, 9);
      assert.equal(r.captured, true);
      assert.equal(r.secretsFlagged, true);
      assert.ok(r.secretTypes.includes('aws-access-key'));

      const sessDir = require('../lib/continuity').sessionDir(projectPath, 9);
      const metaStr = fs.readFileSync(path.join(sessDir, 'transcript.meta.json'), 'utf8');
      // Privacy invariant: the meta records the TYPE, never the secret value.
      assert.ok(!metaStr.includes(FAKE_AWS), 'meta must not contain the secret value');
    });

    it('copies but skips the scan above the size cap (still captured)', async () => {
      const enc = transcript._encodeDir(projectPath);
      writeTranscript(enc, 'huge-1', projectPath, [
        JSON.stringify({ type: 'message', cwd: projectPath, content: `K=${FAKE_AWS}` })
      ]);
      const origCap = transcript._internal.maxScanBytes;
      transcript._internal.maxScanBytes = 10; // force the over-cap branch
      try {
        const r = await transcript.snapshot({ name: 'proj', path: projectPath }, { engineId: 'claude' }, 4);
        assert.equal(r.captured, true);
        assert.equal(r.scanSkipped, true);
        assert.equal(r.secretsFlagged, false, 'scan skipped → not flagged even though a key is present');
        const sessDir = require('../lib/continuity').sessionDir(projectPath, 4);
        // The transcript is still preserved for CC-5 search.
        assert.ok(fs.existsSync(path.join(sessDir, 'transcript.jsonl')));
        const meta = JSON.parse(fs.readFileSync(path.join(sessDir, 'transcript.meta.json'), 'utf8'));
        assert.equal(meta.scanSkipped, true);
      } finally {
        transcript._internal.maxScanBytes = origCap;
      }
    });

    it('returns captured:false (honest skip) when no transcript resolves', async () => {
      const r = await transcript.snapshot({ name: 'proj', path: projectPath }, { engineId: 'gemini' }, 1);
      assert.equal(r.captured, false);
      assert.ok(r.reason.includes('gemini'));
      // Nothing written to the store.
      const sessDir = require('../lib/continuity').sessionDir(projectPath, 1);
      assert.ok(!fs.existsSync(sessDir));
    });

    it('a stub harness reads as "not supported yet", distinct from an implemented harness finding no match (#2074)', async () => {
      const stubResult = await transcript.snapshot({ name: 'proj', path: projectPath }, { engineId: 'aider' }, 2);
      assert.match(stubResult.reason, /does not support transcript capture yet/);

      const noMatchResult = await transcript.snapshot({ name: 'proj', path: projectPath }, { engineId: 'codex', startedAt: '2026-06-01T12:00:00.000Z' }, 3);
      assert.match(noMatchResult.reason, /no matching transcript found/);
    });

    it('captures a Codex transcript, preserving the same meta contract as Claude', async () => {
      const START = '2026-06-01T12:00:00.000Z';
      const FAKE_SECRET_LINE = JSON.stringify({ type: 'response_item', payload: { content: [{ type: 'input_text', text: `export K=${FAKE_AWS}` }] } });
      writeCodexRollout({ uuid: 'snap-1', cwd: projectPath, startedAt: START, extraLines: [FAKE_SECRET_LINE] });

      const r = await transcript.snapshot({ name: 'proj', path: projectPath }, { engineId: 'codex', startedAt: START }, 11);
      assert.equal(r.captured, true);
      assert.equal(r.secretsFlagged, true);
      assert.ok(r.secretTypes.includes('aws-access-key'));

      const sessDir = require('../lib/continuity').sessionDir(projectPath, 11);
      assert.ok(fs.existsSync(path.join(sessDir, 'transcript.jsonl')));
      const meta = JSON.parse(fs.readFileSync(path.join(sessDir, 'transcript.meta.json'), 'utf8'));
      assert.equal(meta.harness, 'codex');
      assert.equal(meta.cwd, projectPath);
      assert.equal(meta.secretsFlagged, true);
      assert.ok(!fs.readFileSync(path.join(sessDir, 'transcript.meta.json'), 'utf8').includes(FAKE_AWS), 'meta must not contain the secret value');
    });
  });

  describe('backfillTranscript (#2074)', () => {
    const START = '2026-06-01T12:00:00.000Z';

    it('is idempotent: never overwrites or re-scans a session that already has a captured transcript', async () => {
      writeCodexRollout({ uuid: 'bf-1', cwd: projectPath, startedAt: START });
      const project = { name: 'proj', path: projectPath };
      const session = { engineId: 'codex', startedAt: START };

      const first = await transcript.backfillTranscript(project, session, 20);
      assert.equal(first.captured, true);

      const sessDir = require('../lib/continuity').sessionDir(projectPath, 20);
      const metaPath = path.join(sessDir, 'transcript.meta.json');
      const firstMeta = fs.readFileSync(metaPath, 'utf8');

      // A second rollout now also matches this cwd — if backfill re-resolved
      // and re-captured, this would be ambiguous (refused) or simply
      // overwrite; either way the already-captured session must be untouched.
      writeCodexRollout({ uuid: 'bf-2', cwd: projectPath, startedAt: '2026-06-01T12:30:00.000Z' });
      const second = await transcript.backfillTranscript(project, session, 20);
      assert.equal(second.captured, false);
      assert.equal(second.reason, 'already captured');
      assert.equal(fs.readFileSync(metaPath, 'utf8'), firstMeta, 'the existing capture must be byte-for-byte unchanged');
    });

    it('captures a transcript for a previously-wrapped session that has none yet', async () => {
      const file = writeCodexRollout({ uuid: 'bf-3', cwd: projectPath, startedAt: START });
      const r = await transcript.backfillTranscript({ name: 'proj', path: projectPath }, { engineId: 'codex', startedAt: START }, 21);
      assert.equal(r.captured, true);
      const sessDir = require('../lib/continuity').sessionDir(projectPath, 21);
      const meta = JSON.parse(fs.readFileSync(path.join(sessDir, 'transcript.meta.json'), 'utf8'));
      assert.equal(meta.source, file);
    });

    it('never selects an ambiguous source: an unresolved backfill leaves nothing written', async () => {
      writeCodexRollout({ uuid: 'bf-amb-1', cwd: projectPath, startedAt: START });
      writeCodexRollout({ uuid: 'bf-amb-2', cwd: projectPath, startedAt: '2026-06-01T12:01:00.000Z' });
      const r = await transcript.backfillTranscript({ name: 'proj', path: projectPath }, { engineId: 'codex', startedAt: START }, 22);
      assert.equal(r.captured, false);
      assert.match(r.reason, /no matching transcript found/);
      const sessDir = require('../lib/continuity').sessionDir(projectPath, 22);
      assert.ok(!fs.existsSync(sessDir));
    });
  });
});
