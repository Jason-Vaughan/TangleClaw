'use strict';

/*
 * #2830 (#2074 Slice 2): the Session History backfill controller
 * (`lib/session-history-backfill.js`) and its UI badge
 * (`public/session-history-ui.js`).
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const continuity = require('../lib/continuity');
const transcript = require('../lib/transcript');
const backfill = require('../lib/session-history-backfill');
const { loadEsc, liftDeclaration } = require('./helpers/lift');

let tmpDir = null;
let projectPath = null;
const SID = 'sess-1';
const PROJECT = { path: null, name: 'bf-proj' };
const SESSION = { engineId: 'claude-code', startedAt: '2026-11-01T00:00:00.000Z' };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-session-history-backfill-'));
  projectPath = path.join(tmpDir, 'proj');
  fs.mkdirSync(projectPath, { recursive: true });
  PROJECT.path = projectPath;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ensureSessionTranscript', () => {
  it('reports an existing transcript as live-pane-capture, unchanged', async () => {
    const dir = continuity.sessionDir(projectPath, SID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.meta.json'), JSON.stringify({
      harness: 'claude', capturedAt: '2026-11-01T00:05:00.000Z', bytes: 42, lineCount: 3,
      secretsFlagged: false, secretTypes: [], scanSkipped: false
    }));

    const real = transcript.backfillTranscript;
    let calledBackfill = false;
    transcript.backfillTranscript = async () => { calledBackfill = true; return { captured: false, reason: 'already captured' }; };
    try {
      const result = await backfill.ensureSessionTranscript(PROJECT, SESSION, SID);
      assert.equal(result.captured, true);
      assert.equal(result.source, 'live-pane-capture');
      assert.equal(result.engine, 'claude');
      assert.equal(result.capturedAt, '2026-11-01T00:05:00.000Z');
      assert.equal(result.bytes, 42);
      assert.equal(result.lineCount, 3);
      assert.equal(result.secretsFlagged, false);
      // The existing capture is read, never re-run through backfillTranscript.
      assert.equal(calledBackfill, false);
    } finally {
      transcript.backfillTranscript = real;
    }
  });

  it('backfills a missing transcript and reports native-log-backfill with a fresh timestamp', async () => {
    const real = transcript.backfillTranscript;
    const realNow = backfill._internal.now;
    transcript.backfillTranscript = async (project, session, sid) => {
      assert.equal(project, PROJECT);
      assert.equal(sid, SID);
      return { captured: true, bytes: 100, lineCount: 7, secretsFlagged: true, secretTypes: ['aws-key'], scanSkipped: false };
    };
    backfill._internal.now = () => '2026-11-05T00:00:00.000Z';
    try {
      const result = await backfill.ensureSessionTranscript(PROJECT, SESSION, SID);
      assert.equal(result.captured, true);
      assert.equal(result.source, 'native-log-backfill');
      assert.equal(result.engine, 'claude');
      assert.equal(result.backfilledAt, '2026-11-05T00:00:00.000Z');
      assert.equal(result.bytes, 100);
      assert.equal(result.lineCount, 7);
      assert.equal(result.secretsFlagged, true);
      assert.deepEqual(result.secretTypes, ['aws-key']);
    } finally {
      transcript.backfillTranscript = real;
      backfill._internal.now = realNow;
    }
  });

  it('reports an honest skip when nothing exists and nothing could be backfilled', async () => {
    const real = transcript.backfillTranscript;
    transcript.backfillTranscript = async () => ({ captured: false, reason: "no matching transcript found for harness 'claude'" });
    try {
      const result = await backfill.ensureSessionTranscript(PROJECT, SESSION, SID);
      assert.equal(result.captured, false);
      assert.equal(result.reason, "no matching transcript found for harness 'claude'");
      assert.equal(result.engine, 'claude');
      assert.equal(result.source, undefined);
    } finally {
      transcript.backfillTranscript = real;
    }
  });

  it('normalizes the engine the same way lib/transcript.js does', async () => {
    const real = transcript.backfillTranscript;
    transcript.backfillTranscript = async () => ({ captured: false, reason: "harness 'openclaw' does not support transcript capture yet" });
    try {
      const result = await backfill.ensureSessionTranscript(PROJECT, { engineId: 'openclaw:abc123' }, SID);
      assert.equal(result.engine, 'openclaw');
    } finally {
      transcript.backfillTranscript = real;
    }
  });
});

describe('public/session-history-ui.js transcriptSourceBadge', () => {
  /** Build the lifted function bound to the page's own `esc`. */
  function loadBadgeFn() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'session-history-ui.js'), 'utf8');
    const esc = loadEsc('landing.js');
    return new Function('esc', `${liftDeclaration(src, 'function transcriptSourceBadge(')}\nreturn transcriptSourceBadge;`)(esc);
  }

  it('renders nothing for a session with no transcript', () => {
    const badge = loadBadgeFn();
    assert.equal(badge(null), '');
    assert.equal(badge({ captured: false }), '');
  });

  it('renders a distinct badge for a native-log backfill, naming the engine and when', () => {
    const badge = loadBadgeFn();
    const html = badge({ captured: true, source: 'native-log-backfill', engine: 'claude', backfilledAt: '2026-11-05T00:00:00.000Z' });
    assert.match(html, /badge-git/);
    assert.match(html, />native-log</);
    assert.match(html, /native log/);
    assert.match(html, /claude/);
    assert.match(html, /2026-11-05T00:00:00\.000Z/);
  });

  it('renders a distinct badge for a live-pane capture', () => {
    const badge = loadBadgeFn();
    const html = badge({ captured: true, source: 'live-pane-capture', engine: 'codex', capturedAt: '2026-11-01T00:05:00.000Z' });
    assert.match(html, /badge-git/);
    assert.match(html, />live-capture</);
    assert.match(html, /Captured live/);
  });

  it('the two provenance badges render different visible text', () => {
    const badge = loadBadgeFn();
    const backfilled = badge({ captured: true, source: 'native-log-backfill', engine: 'claude' });
    const live = badge({ captured: true, source: 'live-pane-capture', engine: 'claude' });
    assert.notEqual(backfilled, live);
  });

  it('escapes the engine name — it is not a fixed enum this code controls', () => {
    const badge = loadBadgeFn();
    const html = badge({ captured: true, source: 'native-log-backfill', engine: '<img onerror=alert(1)>' });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });
});
