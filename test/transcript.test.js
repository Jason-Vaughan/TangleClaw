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

describe('transcript (CC-4b #376)', () => {
  let tmp; // sandbox root
  let home; // fake ~/.claude
  let projectPath;
  let realClaudeHome;

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

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-'));
    home = path.join(tmp, 'claude-home');
    projectPath = path.join(tmp, 'proj');
    fs.mkdirSync(projectPath, { recursive: true });
    realClaudeHome = transcript._internal.claudeHome;
    transcript._internal.claudeHome = () => home;
  });

  afterEach(() => {
    transcript._internal.claudeHome = realClaudeHome;
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

    it('returns null for non-Claude harnesses (seam stubs)', () => {
      const enc = transcript._encodeDir(projectPath);
      writeTranscript(enc, 'x-1', projectPath); // present, but harness has no adapter impl
      for (const h of ['gemini', 'codex', 'aider', 'openclaw', 'unknown']) {
        assert.equal(transcript.resolve(h, projectPath, {}), null, `${h} must resolve null`);
      }
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
  });
});
