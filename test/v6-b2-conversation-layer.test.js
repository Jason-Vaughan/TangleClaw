'use strict';

// v6 Train 2 Wave 1-A (#2982, V6-09 / B2, BRIDGE-1c): the conversation_events
// schema (lib/store/_schema.js) plus lib/v6/b2-conversation-layer.js, against
// a real node:sqlite-backed store.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const b2 = require('../lib/v6/b2-conversation-layer');

let tmpDir = null;

/** @returns {import('node:sqlite').DatabaseSync} */
function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-b2-conversation-'));
  store._setBasePath(tmpDir);
  store.init();
  return store.getDb();
}

function cleanup() {
  store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
}

function seedProject(db, name) {
  db.prepare('INSERT INTO projects (name, path, archived) VALUES (?, ?, 0)').run(name, path.join(os.tmpdir(), name));
  return db.prepare('SELECT id FROM projects WHERE name = ?').get(name).id;
}

function seedSession(db, projectId, engineId = 'claude') {
  db.prepare('INSERT INTO sessions (project_id, engine_id) VALUES (?, ?)').run(projectId, engineId);
  return Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
}

describe('classifyAdapterTier (#2982 deliverable 1)', () => {
  it('TIER_A_ADAPTERS/TIER_B_ADAPTERS name exactly the adapters #2982 names', () => {
    assert.deepEqual(b2.TIER_A_ADAPTERS, ['claude', 'codex', 'antigravity']);
    assert.deepEqual(b2.TIER_B_ADAPTERS, ['aider']);
  });

  it('classifies the three Tier-A structured adapters', () => {
    assert.equal(b2.classifyAdapterTier('claude'), 'A');
    assert.equal(b2.classifyAdapterTier('codex'), 'A');
    assert.equal(b2.classifyAdapterTier('antigravity'), 'A');
  });

  it('classifies aider as the Tier-B pane-derived fallback', () => {
    assert.equal(b2.classifyAdapterTier('aider'), 'B');
  });

  it('returns null for an adapter neither tier names', () => {
    assert.equal(b2.classifyAdapterTier('some-future-engine'), null);
  });
});

describe('appendEvent / getEvents (#2982 deliverable 1)', () => {
  it('appends a Tier-A event and reads it back', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-append-a');
      const sessionId = seedSession(db, projectId, 'claude');
      const res = b2.appendEvent(db, {
        projectId, sessionId, launchId: 'launch-1', seq: 1, tier: 'A', adapter: 'claude',
        role: 'assistant', content: 'hello world'
      });
      assert.equal(res.ok, true);
      assert.equal(res.code, 'APPENDED');
      const events = b2.getEvents(db, { sessionId });
      assert.equal(events.length, 1);
      assert.equal(events[0].content, 'hello world');
      assert.equal(events[0].degraded_fidelity, 0, 'Tier A is never degraded');
    } finally {
      cleanup();
    }
  });

  it('a Tier-B event is always recorded degraded_fidelity: 1, derived from tier, never caller-supplied', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-tier-b');
      const sessionId = seedSession(db, projectId, 'aider');
      b2.appendEvent(db, {
        projectId, sessionId, launchId: 'launch-1', seq: 1, tier: 'B', adapter: 'aider',
        role: 'assistant', content: 'pane-derived text', paneCursorWatermark: 0, rollingLineSha256: 'a'.repeat(64)
      });
      const events = b2.getEvents(db, { sessionId });
      assert.equal(events[0].degraded_fidelity, 1);
    } finally {
      cleanup();
    }
  });

  it('refuses INVALID_REQUEST for a bad tier, role, or missing content', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-invalid');
      const sessionId = seedSession(db, projectId);
      const base = { projectId, sessionId, launchId: 'l1', seq: 1, adapter: 'claude', role: 'assistant', content: 'x' };
      assert.equal(b2.appendEvent(db, { ...base, tier: 'C' }).code, 'INVALID_REQUEST');
      assert.equal(b2.appendEvent(db, { ...base, tier: 'A', role: 'narrator' }).code, 'INVALID_REQUEST');
      assert.equal(b2.appendEvent(db, { ...base, tier: 'A', content: undefined }).code, 'INVALID_REQUEST');
    } finally {
      cleanup();
    }
  });

  it('every ROLES entry round-trips through appendEvent/getEvents', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-roles');
      const sessionId = seedSession(db, projectId);
      let seq = 1;
      for (const role of b2.ROLES) {
        b2.appendEvent(db, { projectId, sessionId, launchId: 'l1', seq, tier: 'A', adapter: 'claude', role, content: role });
        seq += 1;
      }
      assert.deepEqual(b2.getEvents(db, { sessionId }).map((e) => e.role), b2.ROLES.slice());
    } finally {
      cleanup();
    }
  });

  it('dedups a repeated (launch_id, pane_cursor_watermark, rolling_line_sha256) — a SIGWINCH/reconnect replay (#2982)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-dedup');
      const sessionId = seedSession(db, projectId, 'aider');
      const payload = {
        projectId, sessionId, launchId: 'launch-9', seq: 1, tier: 'B', adapter: 'aider',
        role: 'assistant', content: 'same pane line', paneCursorWatermark: 5, rollingLineSha256: 'b'.repeat(64)
      };
      const first = b2.appendEvent(db, payload);
      assert.equal(first.code, 'APPENDED');
      const second = b2.appendEvent(db, { ...payload, seq: 2, content: 'same pane line (replayed)' });
      assert.equal(second.ok, true);
      assert.equal(second.code, 'DEDUPED');
      assert.equal(second.id, first.id);
      const events = b2.getEvents(db, { sessionId });
      assert.equal(events.length, 1, 'the dedup must not have inserted a second row');
    } finally {
      cleanup();
    }
  });

  it('does not dedup across a DIFFERENT launch_id, watermark, or hash', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-no-false-dedup');
      const sessionId = seedSession(db, projectId, 'aider');
      const base = { projectId, sessionId, tier: 'B', adapter: 'aider', role: 'assistant', content: 'x', paneCursorWatermark: 1, rollingLineSha256: 'c'.repeat(64) };
      b2.appendEvent(db, { ...base, launchId: 'l1', seq: 1 });
      b2.appendEvent(db, { ...base, launchId: 'l2', seq: 2 });
      b2.appendEvent(db, { ...base, launchId: 'l1', seq: 3, paneCursorWatermark: 2 });
      b2.appendEvent(db, { ...base, launchId: 'l1', seq: 4, rollingLineSha256: 'd'.repeat(64) });
      assert.equal(b2.getEvents(db, { sessionId }).length, 4);
    } finally {
      cleanup();
    }
  });

  it('two Tier-A events with no rolling_line_sha256 never collide with each other (NULL is distinct in the UNIQUE index)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-tier-a-no-hash');
      const sessionId = seedSession(db, projectId, 'claude');
      const base = { projectId, sessionId, launchId: 'launch-1', tier: 'A', adapter: 'claude', role: 'assistant', content: 'x', paneCursorWatermark: 0 };
      const a = b2.appendEvent(db, { ...base, seq: 1 });
      const b = b2.appendEvent(db, { ...base, seq: 2 });
      assert.equal(a.code, 'APPENDED');
      assert.equal(b.code, 'APPENDED');
      assert.equal(b2.getEvents(db, { sessionId }).length, 2);
    } finally {
      cleanup();
    }
  });

  it('refuses SEQ_CONFLICT for a repeated (session_id, seq) that is not itself a dedup hit', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-seq-conflict');
      const sessionId = seedSession(db, projectId);
      b2.appendEvent(db, { projectId, sessionId, launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'assistant', content: 'first' });
      const res = b2.appendEvent(db, { projectId, sessionId, launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'assistant', content: 'different content, same seq' });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'SEQ_CONFLICT');
    } finally {
      cleanup();
    }
  });

  it('refuses INVALID_REQUEST for a malformed paneCursorWatermark or rollingLineSha256 (PRR-A R1 HOLD)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-malformed-watermark-hash');
      const sessionId = seedSession(db, projectId);
      const base = { projectId, sessionId, launchId: 'l1', tier: 'A', adapter: 'claude', role: 'assistant', content: 'x' };
      assert.equal(b2.appendEvent(db, { ...base, seq: 1, paneCursorWatermark: -1 }).code, 'INVALID_REQUEST');
      assert.equal(b2.appendEvent(db, { ...base, seq: 2, paneCursorWatermark: 1.5 }).code, 'INVALID_REQUEST');
      assert.equal(b2.appendEvent(db, { ...base, seq: 3, paneCursorWatermark: 'not-a-number' }).code, 'INVALID_REQUEST');
      assert.equal(b2.appendEvent(db, { ...base, seq: 4, rollingLineSha256: 'too-short' }).code, 'INVALID_REQUEST');
      assert.equal(b2.appendEvent(db, { ...base, seq: 5, rollingLineSha256: 'g'.repeat(64) }).code, 'INVALID_REQUEST');
    } finally {
      cleanup();
    }
  });

  it('accepts a null paneCursorWatermark for a Tier-A event, storing 0', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-null-watermark');
      const sessionId = seedSession(db, projectId);
      const res = b2.appendEvent(db, {
        projectId, sessionId, launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'assistant', content: 'x',
        paneCursorWatermark: null
      });
      assert.equal(res.ok, true);
      assert.equal(b2.getEvents(db, { sessionId })[0].pane_cursor_watermark, 0);
    } finally {
      cleanup();
    }
  });

  it('refuses a tier that disagrees with the adapter\'s own classification (aider cannot claim Tier A) (PRR-A R1 HOLD)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-tier-adapter-mismatch');
      const sessionId = seedSession(db, projectId);
      const res = b2.appendEvent(db, {
        projectId, sessionId, launchId: 'l1', seq: 1, tier: 'A', adapter: 'aider', role: 'assistant', content: 'x',
        paneCursorWatermark: 0, rollingLineSha256: 'a'.repeat(64)
      });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_REQUEST');
      assert.match(res.message, /tier does not match adapter classification/);
    } finally {
      cleanup();
    }
  });

  it('refuses claude claiming Tier B the same way', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-tier-adapter-mismatch-2');
      const sessionId = seedSession(db, projectId);
      const res = b2.appendEvent(db, {
        projectId, sessionId, launchId: 'l1', seq: 1, tier: 'B', adapter: 'claude', role: 'assistant', content: 'x',
        paneCursorWatermark: 0, rollingLineSha256: 'a'.repeat(64)
      });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'INVALID_REQUEST');
    } finally {
      cleanup();
    }
  });

  it('allows an UNRECOGNIZED adapter to declare either tier (classifyAdapterTier returns null, so nothing to disagree with)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-unrecognized-adapter');
      const sessionId = seedSession(db, projectId);
      const res = b2.appendEvent(db, {
        projectId, sessionId, launchId: 'l1', seq: 1, tier: 'A', adapter: 'some-future-engine', role: 'assistant', content: 'x'
      });
      assert.equal(res.ok, true);
    } finally {
      cleanup();
    }
  });

  it('refuses a Tier B event missing paneCursorWatermark or rollingLineSha256, so dedup can never be silently defeated (PRR-A R1 HOLD)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-tier-b-requires-dedup-key');
      const sessionId = seedSession(db, projectId);
      const base = { projectId, sessionId, launchId: 'l1', tier: 'B', adapter: 'aider', role: 'assistant', content: 'x' };
      const missingHash = b2.appendEvent(db, { ...base, seq: 1, paneCursorWatermark: 0 });
      assert.equal(missingHash.ok, false);
      assert.match(missingHash.message, /Tier B pane events require/);
      const missingWatermark = b2.appendEvent(db, { ...base, seq: 2, paneCursorWatermark: null, rollingLineSha256: 'a'.repeat(64) });
      assert.equal(missingWatermark.ok, false);
      assert.match(missingWatermark.message, /Tier B pane events require/);
      const complete = b2.appendEvent(db, { ...base, seq: 3, paneCursorWatermark: 0, rollingLineSha256: 'a'.repeat(64) });
      assert.equal(complete.ok, true);
    } finally {
      cleanup();
    }
  });

  it('refuses a Tier B event that OMITS paneCursorWatermark entirely, rather than silently defaulting it to 0 (PRR-A R2 HOLD)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-tier-b-omitted-watermark');
      const sessionId = seedSession(db, projectId);
      const res = b2.appendEvent(db, {
        projectId, sessionId, launchId: 'l1', seq: 1, tier: 'B', adapter: 'aider', role: 'assistant', content: 'x',
        rollingLineSha256: 'a'.repeat(64)
      });
      assert.equal(res.ok, false);
      assert.match(res.message, /Tier B pane events require/);
    } finally {
      cleanup();
    }
  });

  it('normalizes rollingLineSha256 to lowercase, so an uppercase hash dedupes against its lowercase equivalent (PRR-A R2 HOLD)', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-hash-case-dedup');
      const sessionId = seedSession(db, projectId);
      const base = { projectId, sessionId, launchId: 'l1', tier: 'B', adapter: 'aider', role: 'assistant', content: 'x', paneCursorWatermark: 0 };
      const first = b2.appendEvent(db, { ...base, seq: 1, rollingLineSha256: 'b'.repeat(64) });
      assert.equal(first.code, 'APPENDED');
      const second = b2.appendEvent(db, { ...base, seq: 2, rollingLineSha256: 'B'.repeat(64) });
      assert.equal(second.ok, true);
      assert.equal(second.code, 'DEDUPED');
      assert.equal(second.id, first.id);
      const events = b2.getEvents(db, { sessionId });
      assert.equal(events.length, 1);
      assert.equal(events[0].rolling_line_sha256, 'b'.repeat(64), 'stored in normalized lowercase form');
    } finally {
      cleanup();
    }
  });

  it('getEvents respects sinceSeq and orders by seq ascending', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-since-seq');
      const sessionId = seedSession(db, projectId);
      for (let seq = 1; seq <= 3; seq += 1) {
        b2.appendEvent(db, { projectId, sessionId, launchId: 'l1', seq, tier: 'A', adapter: 'claude', role: 'assistant', content: `turn ${seq}` });
      }
      const events = b2.getEvents(db, { sessionId, sinceSeq: 1 });
      assert.deepEqual(events.map((e) => e.seq), [2, 3]);
    } finally {
      cleanup();
    }
  });
});

describe('softDeleteEvent (#2982 deliverable 3 — schema-level marker only)', () => {
  it('marks an event deleted and excludes it from getEvents by default', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-soft-delete');
      const sessionId = seedSession(db, projectId);
      const { id } = b2.appendEvent(db, { projectId, sessionId, launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'assistant', content: 'secret' });
      const del = b2.softDeleteEvent(db, { id, sessionId });
      assert.equal(del.ok, true);
      assert.equal(del.code, 'DELETED');
      assert.equal(b2.getEvents(db, { sessionId }).length, 0);
      assert.equal(b2.getEvents(db, { sessionId, includeDeleted: true }).length, 1);
    } finally {
      cleanup();
    }
  });

  it('refuses a second delete of the same event', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-soft-delete-twice');
      const sessionId = seedSession(db, projectId);
      const { id } = b2.appendEvent(db, { projectId, sessionId, launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'assistant', content: 'x' });
      b2.softDeleteEvent(db, { id, sessionId });
      const again = b2.softDeleteEvent(db, { id, sessionId });
      assert.equal(again.ok, false);
      assert.equal(again.code, 'NOT_FOUND_OR_ALREADY_DELETED');
    } finally {
      cleanup();
    }
  });

  it('refuses to delete an event belonging to a DIFFERENT session', () => {
    const db = freshStore();
    try {
      const projectId = seedProject(db, 'b2-soft-delete-cross-session');
      const sessionId = seedSession(db, projectId);
      const otherSessionId = seedSession(db, projectId);
      const { id } = b2.appendEvent(db, { projectId, sessionId, launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'assistant', content: 'x' });
      const res = b2.softDeleteEvent(db, { id, sessionId: otherSessionId });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'NOT_FOUND_OR_ALREADY_DELETED');
    } finally {
      cleanup();
    }
  });
});

describe('checkInterruptSupport (#2982 deliverable 2)', () => {
  it('allows an engine that declares interruptContract', () => {
    assert.deepEqual(b2.checkInterruptSupport({ interruptContract: { signal: 'SIGINT' } }), { allowed: true });
  });

  it('fails closed with INTERRUPT_UNSUPPORTED_BY_ENGINE for an engine with no interruptContract', () => {
    const res = b2.checkInterruptSupport({ id: 'aider' });
    assert.equal(res.allowed, false);
    assert.equal(res.code, 'INTERRUPT_UNSUPPORTED_BY_ENGINE');
  });

  it('fails closed for a null/undefined engine profile', () => {
    assert.equal(b2.checkInterruptSupport(null).allowed, false);
    assert.equal(b2.checkInterruptSupport(undefined).allowed, false);
  });
});

// #3107 (Car V650-W1-A, pipelined via Guardrail 06): rich link unfurling &
// inline media/artifact previews. Classification/parsing only — no fetch,
// no route, no public/v6-shell.js rendering (see the module's own header).

describe('classifyMediaOrArtifactLink (#3107)', () => {
  it('classifies a workspace-rooted image, with zoom metadata', () => {
    assert.deepEqual(b2.classifyMediaOrArtifactLink('./shots/foo.png'),
      { kind: 'image', path: './shots/foo.png', source: 'workspace', zoomable: true });
    assert.deepEqual(b2.classifyMediaOrArtifactLink('/Users/x/screenshot.JPG').kind, 'image', 'extension match is case-insensitive');
  });

  it('classifies every documented image extension', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']) {
      assert.equal(b2.classifyMediaOrArtifactLink(`/a.${ext}`).kind, 'image', ext);
    }
  });

  it('classifies a video with its mimeType, preload and controls', () => {
    assert.deepEqual(b2.classifyMediaOrArtifactLink('/Users/x/clip.mp4'),
      { kind: 'video', path: '/Users/x/clip.mp4', source: 'workspace', mimeType: 'video/mp4', preload: 'metadata', controls: true });
    assert.equal(b2.classifyMediaOrArtifactLink('/a.webm').mimeType, 'video/webm');
    assert.equal(b2.classifyMediaOrArtifactLink('/a.mov').mimeType, 'video/quicktime');
  });

  it('classifies a secrets-store reference, mirroring public/v6-shell.js\'s ATTACHED_LINE convention', () => {
    assert.deepEqual(b2.classifyMediaOrArtifactLink('secrets/abc.jpg'),
      { kind: 'image', path: 'abc.jpg', source: 'secrets', zoomable: true });
    assert.equal(b2.classifyMediaOrArtifactLink('.tangleclaw/secrets/clip.mp4').source, 'secrets');
  });

  it('classifies a file:// URL, decoding percent-encoding in the path', () => {
    assert.deepEqual(b2.classifyMediaOrArtifactLink('file:///Users/x/my%20plan.md'),
      { kind: 'artifact', path: '/Users/x/my plan.md', source: 'file-url', fileExtension: 'md', title: 'my plan.md', lineRange: null });
  });

  it('classifies an .md/.html artifact with no line range, and names its title and extension', () => {
    assert.deepEqual(b2.classifyMediaOrArtifactLink('./docs/plan.md'),
      { kind: 'artifact', path: './docs/plan.md', source: 'workspace', fileExtension: 'md', title: 'plan.md', lineRange: null });
    assert.equal(b2.classifyMediaOrArtifactLink('/reports/sprint.html').fileExtension, 'html');
  });

  it('classifies a #L<n>-L<n> code line-range card for ANY extension, not just .md/.html', () => {
    assert.deepEqual(b2.classifyMediaOrArtifactLink('file:///Users/x/app.js#L10-L20'),
      { kind: 'artifact', path: '/Users/x/app.js', source: 'file-url', fileExtension: 'js', title: 'app.js', lineRange: { start: 10, end: 20 } });
  });

  it('a single #L<n> with no end names the same line as both start and end', () => {
    assert.deepEqual(b2.classifyMediaOrArtifactLink('/a.js#L5').lineRange, { start: 5, end: 5 });
  });

  it('refuses a line range on an image or video — a frame range makes no sense for either', () => {
    assert.equal(b2.classifyMediaOrArtifactLink('/a.png#L1-L2'), null);
    assert.equal(b2.classifyMediaOrArtifactLink('/a.mp4#L1-L2'), null);
  });

  it('returns null for ordinary prose, an unrecognized extension with no line range, and non-strings', () => {
    assert.equal(b2.classifyMediaOrArtifactLink('version 2.1 shipped'), null);
    assert.equal(b2.classifyMediaOrArtifactLink('/a.exe'), null);
    assert.equal(b2.classifyMediaOrArtifactLink(''), null);
    assert.equal(b2.classifyMediaOrArtifactLink(null), null);
    assert.equal(b2.classifyMediaOrArtifactLink(42), null);
  });

  it('returns null for a bare relative filename with no path-like prefix, so ordinary word-like tokens are never misread', () => {
    assert.equal(b2.classifyMediaOrArtifactLink('report.md'), null);
  });
});

describe('extractRichPreviewsFromMessage (#3107)', () => {
  it('extracts an Attached: secrets line as its own card, without also token-scanning that line', () => {
    const cards = b2.extractRichPreviewsFromMessage('Attached: secrets/shot.png');
    assert.deepEqual(cards, [{ kind: 'image', path: 'shot.png', source: 'secrets', zoomable: true }]);
  });

  it('extracts a workspace path and a GitHub URL embedded in prose, trimming trailing punctuation', () => {
    const cards = b2.extractRichPreviewsFromMessage('See ./plan.md and https://github.com/a/b/pull/5, please.');
    assert.equal(cards.length, 2);
    assert.equal(cards[0].kind, 'artifact');
    assert.equal(cards[0].path, './plan.md');
    assert.deepEqual(cards[1], { kind: 'github', url: 'https://github.com/a/b/pull/5', owner: 'a', repo: 'b', entityKind: 'pull', number: 5 });
  });

  it('extracts a generic external link as an SSRF-evaluated candidate, never fetched', () => {
    const cards = b2.extractRichPreviewsFromMessage('Check https://example.com/page.');
    assert.deepEqual(cards, [{ kind: 'link-unfurl-candidate', url: 'https://example.com/page', safe: true, unsafeReason: null }]);
  });

  it('flags an unsafe external link candidate with its reason, rather than silently dropping it', () => {
    const cards = b2.extractRichPreviewsFromMessage('http://169.254.169.254/latest/meta-data');
    assert.deepEqual(cards, [{ kind: 'link-unfurl-candidate', url: 'http://169.254.169.254/latest/meta-data', safe: false, unsafeReason: 'LINK_LOCAL' }]);
  });

  it('preserves reference order across multiple lines', () => {
    const cards = b2.extractRichPreviewsFromMessage('./a.png\nsome prose\n./b.mp4');
    assert.deepEqual(cards.map((c) => c.kind), ['image', 'video']);
  });

  it('returns an empty array for text with no reference, and for non-strings', () => {
    assert.deepEqual(b2.extractRichPreviewsFromMessage('just some words'), []);
    assert.deepEqual(b2.extractRichPreviewsFromMessage(''), []);
    assert.deepEqual(b2.extractRichPreviewsFromMessage(null), []);
  });
});

describe('parseGitHubEntityUrl (#3107)', () => {
  it('parses a pull request URL', () => {
    assert.deepEqual(b2.parseGitHubEntityUrl('https://github.com/Jason-Vaughan/TangleClaw/pull/3119'),
      { owner: 'Jason-Vaughan', repo: 'TangleClaw', entityKind: 'pull', number: 3119 });
  });

  it('parses an issue URL', () => {
    assert.deepEqual(b2.parseGitHubEntityUrl('https://github.com/Jason-Vaughan/TangleClaw/issues/3107'),
      { owner: 'Jason-Vaughan', repo: 'TangleClaw', entityKind: 'issue', number: 3107 });
  });

  it('parses a release tag URL, decoding percent-encoding in the tag', () => {
    assert.deepEqual(b2.parseGitHubEntityUrl('https://github.com/a/b/releases/tag/v6.4%2E1'),
      { owner: 'a', repo: 'b', entityKind: 'release', tag: 'v6.4.1' });
  });

  it('parses with a trailing path/query/fragment after the id', () => {
    assert.equal(b2.parseGitHubEntityUrl('https://github.com/a/b/pull/5/files').number, 5);
    assert.equal(b2.parseGitHubEntityUrl('https://github.com/a/b/issues/5?x=1#c1').number, 5);
  });

  it('returns null for a non-matching github.com URL (profile, repo root, blob, commit) and for a non-github URL', () => {
    assert.equal(b2.parseGitHubEntityUrl('https://github.com/a/b'), null);
    assert.equal(b2.parseGitHubEntityUrl('https://github.com/a'), null);
    assert.equal(b2.parseGitHubEntityUrl('https://github.com/a/b/blob/main/x.js'), null);
    assert.equal(b2.parseGitHubEntityUrl('https://example.com/a/b/pull/5'), null);
    assert.equal(b2.parseGitHubEntityUrl(42), null);
  });

  it('returns null for a pull/issue id that is not a positive integer', () => {
    assert.equal(b2.parseGitHubEntityUrl('https://github.com/a/b/pull/not-a-number'), null);
    assert.equal(b2.parseGitHubEntityUrl('https://github.com/a/b/issues/0'), null);
  });
});

describe('evaluateUnfurlTargetSafety (#3107)', () => {
  it('allows an ordinary public hostname', () => {
    assert.deepEqual(b2.evaluateUnfurlTargetSafety('https://example.com/x'), { safe: true, reason: null });
  });

  it('refuses a non-http(s) scheme', () => {
    assert.deepEqual(b2.evaluateUnfurlTargetSafety('ftp://example.com/x'), { safe: false, reason: 'UNSUPPORTED_SCHEME' });
    assert.equal(b2.evaluateUnfurlTargetSafety('file:///etc/passwd').reason, 'UNSUPPORTED_SCHEME');
  });

  it('refuses an unparseable URL and non-string input', () => {
    assert.deepEqual(b2.evaluateUnfurlTargetSafety('not a url'), { safe: false, reason: 'INVALID_URL' });
    assert.equal(b2.evaluateUnfurlTargetSafety('').reason, 'INVALID_URL');
    assert.equal(b2.evaluateUnfurlTargetSafety(null).reason, 'INVALID_URL');
  });

  it('refuses "localhost" by name, and literal IPv4 loopback/link-local/private ranges', () => {
    assert.equal(b2.evaluateUnfurlTargetSafety('http://localhost/x').reason, 'LOOPBACK');
    assert.equal(b2.evaluateUnfurlTargetSafety('http://127.0.0.1/x').reason, 'LOOPBACK');
    assert.equal(b2.evaluateUnfurlTargetSafety('http://127.5.5.5/x').reason, 'LOOPBACK');
    assert.equal(b2.evaluateUnfurlTargetSafety('http://169.254.169.254/latest').reason, 'LINK_LOCAL');
    for (const ip of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '0.0.0.5']) {
      assert.equal(b2.evaluateUnfurlTargetSafety(`http://${ip}/x`).reason, 'PRIVATE_RANGE', ip);
    }
    assert.equal(b2.evaluateUnfurlTargetSafety('http://172.32.0.1/x').reason, null, '172.32/16 is just outside 172.16.0.0/12');
    assert.equal(b2.evaluateUnfurlTargetSafety('http://8.8.8.8/x').reason, null, 'a real public IP stays safe');
  });

  it('refuses literal IPv6 loopback, link-local (fe80::/10), and unique-local (fc00::/7)', () => {
    assert.equal(b2.evaluateUnfurlTargetSafety('http://[::1]/x').reason, 'LOOPBACK');
    assert.equal(b2.evaluateUnfurlTargetSafety('http://[fe80::1]/x').reason, 'LINK_LOCAL');
    assert.equal(b2.evaluateUnfurlTargetSafety('http://[fc00::1]/x').reason, 'PRIVATE_RANGE');
    assert.equal(b2.evaluateUnfurlTargetSafety('http://[fd12:3456::1]/x').reason, 'PRIVATE_RANGE');
    assert.equal(b2.evaluateUnfurlTargetSafety('http://[2001:4860:4860::8888]/x').reason, null, 'a real public IPv6 (Google DNS) stays safe');
  });

  it('refuses an IPv4-mapped IPv6 literal embedding a private address, even though URL normalizes it to hex groups', () => {
    // new URL('http://[::ffff:10.0.0.1]/x').hostname is '[::ffff:a00:1]', never
    // the dotted form — this is the exact case a naive dotted-only regex misses.
    assert.equal(b2.evaluateUnfurlTargetSafety('http://[::ffff:10.0.0.1]/x').reason, 'PRIVATE_RANGE');
    assert.equal(b2.evaluateUnfurlTargetSafety('http://[::ffff:127.0.0.1]/x').reason, 'LOOPBACK');
    assert.equal(b2.evaluateUnfurlTargetSafety('http://[::ffff:8.8.8.8]/x').reason, null, 'a mapped PUBLIC IPv4 stays safe');
  });
});

describe('parseOpenGraphHtml (#3107)', () => {
  it('extracts title, description, image, video and site_name', () => {
    const html = '<meta property="og:title" content="Hello"><meta property="og:description" content="A page">'
      + '<meta property="og:image" content="https://example.com/x.png"><meta property="og:video" content="https://example.com/x.mp4">'
      + '<meta property="og:site_name" content="Example">';
    assert.deepEqual(b2.parseOpenGraphHtml(html), {
      title: 'Hello', description: 'A page', image: 'https://example.com/x.png', video: 'https://example.com/x.mp4', siteName: 'Example'
    });
  });

  it('decodes common HTML entities, including numeric and hex forms, in content', () => {
    const html = '<meta property="og:title" content="Tom &amp; Jerry &#39; s &#x27;Great&#x27; Day">';
    assert.equal(b2.parseOpenGraphHtml(html).title, "Tom & Jerry ' s 'Great' Day");
  });

  it('accepts name= as well as property=, and single-quoted attributes', () => {
    assert.equal(b2.parseOpenGraphHtml("<meta name='og:title' content='Hi'>").title, 'Hi');
  });

  it('keeps only the FIRST occurrence of a field when a page repeats a tag', () => {
    const html = '<meta property="og:title" content="First"><meta property="og:title" content="Second">';
    assert.equal(b2.parseOpenGraphHtml(html).title, 'First');
  });

  it('returns null for HTML with no og: tags, and for non-string/empty input', () => {
    assert.equal(b2.parseOpenGraphHtml('<html><head><title>Plain</title></head></html>'), null);
    assert.equal(b2.parseOpenGraphHtml(''), null);
    assert.equal(b2.parseOpenGraphHtml(null), null);
  });
});
