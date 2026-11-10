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
