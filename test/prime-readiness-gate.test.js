'use strict';

/**
 * Readiness-gated prime paste + honest delivery ledger (#999, #1063, #1106).
 *
 * The prime used to be pasted a fixed 1500ms after launch — adequate until
 * 2026-08-18, silently inadequate after, when antigravity boots stretched past
 * 41 seconds and the paste landed before the agent process existed. The ledger
 * then recorded `delivered` because `tmux send-keys` did not throw, so eight
 * projects ran with no operational guide and a clean ledger for 12 days.
 *
 * These tests pin the replacement: a paste gated on TWO independent readiness
 * signals (the engine's positive at-rest marker AND a settled transcript
 * digest), and a ledger where `delivered` is reserved for a paste whose pane
 * was observed ready — everything blind records `unverified` with the reason.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const sessions = require('../lib/sessions');
const { ENGINE_WAKE_PROFILES } = require('../lib/medusa-wake');

/**
 * Build the injected seams for one `_awaitPaneReady` run: a scripted capture
 * sequence, a clock that advances only when the poll sleeps, and an immediate
 * sleep so the test owns time entirely (no host-scheduling dependence).
 * @param {Array<string[]|Error>} frames - One entry per poll: pane lines, or an
 *   Error to throw from capture. The last entry repeats once exhausted.
 * @param {object} [over] - Option overrides (pollMs, timeoutMs, profiles)
 * @returns {{opts: object, calls: () => number}}
 */
function scriptedPane(frames, over = {}) {
  let t = 0;
  let i = 0;
  const pollMs = over.pollMs ?? 100;
  const opts = {
    pollMs,
    timeoutMs: over.timeoutMs ?? 1000,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    capture: () => {
      const frame = frames[Math.min(i, frames.length - 1)];
      i += 1;
      if (frame instanceof Error) throw frame;
      return { lines: frame };
    },
    ...(over.profiles ? { profiles: over.profiles } : {})
  };
  return { opts, calls: () => i };
}

// A pane at rest for the real antigravity profile: bare `>` composer plus the
// positive at-rest marker, matching the #560 live-spike shape.
const AGY_READY = ['transcript line', '> ', '? for shortcuts'];
// The 2026-08-18 regression pane: STATIC (digest holds byte-identical) with no
// marker — a boot stalled on account verification that reads like a prompt.
const AGY_VERIFYING = ['Verifying your account...', '', ''];

describe('_awaitPaneReady (#999) — two signals, honest degradation', () => {
  it('is not gated for an engine with no wake profile, and says so', async () => {
    const res = await sessions._awaitPaneReady('t', 'aider');
    assert.equal(res.gated, false);
    assert.match(res.reason, /no wake profile/);
  });

  it('is not gated for an engine whose idleMarker is null (Claude — #1106 measured, not assumed)', async () => {
    assert.equal(ENGINE_WAKE_PROFILES.claude.idleMarker, null,
      'precondition: Claude still has no positive at-rest marker');
    const res = await sessions._awaitPaneReady('t', 'claude');
    assert.equal(res.gated, false);
    assert.match(res.reason, /no positive at-rest marker/);
  });

  it('reports ready when the marker renders over a settled transcript', async () => {
    const { opts } = scriptedPane([AGY_READY, AGY_READY]);
    const res = await sessions._awaitPaneReady('t', 'antigravity', opts);
    assert.equal(res.gated, true);
    assert.equal(res.ready, true);
    assert.ok(Number.isFinite(res.waitedMs));
  });

  it('needs TWO consecutive identical digests — a single marker sighting is not readiness', async () => {
    // Marker visible from the first frame, but the transcript is still moving:
    // readiness may only be declared once the digest holds across two polls.
    const moving1 = ['boot line 1', '> ', '? for shortcuts'];
    const moving2 = ['boot line 1', 'boot line 2', '> ', '? for shortcuts'];
    const { opts, calls } = scriptedPane([moving1, moving2, moving2]);
    const res = await sessions._awaitPaneReady('t', 'antigravity', opts);
    assert.equal(res.ready, true);
    assert.ok(calls() >= 3, `a moving pane must not pass on the marker alone (captured ${calls()} frames)`);
  });

  it('times out on the regression pane: static but MARKERLESS ("Verifying your account…")', async () => {
    // This is the exact failure the gate exists for. The pane is byte-identical
    // across polls — a digest-only gate would call it ready — but the marker
    // never renders, so the paste may not claim delivery.
    const { opts } = scriptedPane([AGY_VERIFYING]);
    const res = await sessions._awaitPaneReady('t', 'antigravity', opts);
    assert.equal(res.gated, true);
    assert.equal(res.ready, false);
    assert.match(res.reason, /\? for shortcuts.*never rendered/);
  });

  it('a persistent capture failure terminates at the timeout with the error in the reason', async () => {
    // The wait must stay falsifiable: a dead pane is "timed out, and here is
    // why", never an infinite spin or a silent success.
    const { opts } = scriptedPane([new Error('no such pane')]);
    const res = await sessions._awaitPaneReady('t', 'antigravity', opts);
    assert.equal(res.ready, false);
    assert.match(res.reason, /capture kept failing/);
    assert.match(res.reason, /no such pane/);
  });

  it('recovers when captures start succeeding after early failures (pane not yet created)', async () => {
    const { opts } = scriptedPane([new Error('starting'), AGY_READY, AGY_READY, AGY_READY]);
    const res = await sessions._awaitPaneReady('t', 'antigravity', opts);
    assert.equal(res.ready, true);
  });
});

describe('_primePasteOutcome (#1063) — delivered is reserved for an observed-ready pane', () => {
  it('maps a ready gate to delivered with no reason', () => {
    assert.deepEqual(
      sessions._primePasteOutcome({ gated: true, ready: true, waitedMs: 1500 }),
      { outcome: 'delivered' }
    );
  });

  it('maps a timed-out gate to unverified, carrying the gate reason', () => {
    const res = sessions._primePasteOutcome({ gated: true, ready: false, reason: 'marker never rendered' });
    assert.equal(res.outcome, 'unverified');
    assert.equal(res.skipReason, 'marker never rendered');
  });

  it('maps a blind (ungated) paste to unverified', () => {
    const res = sessions._primePasteOutcome({ gated: false, reason: 'no at-rest marker — pasted blind' });
    assert.equal(res.outcome, 'unverified');
    assert.match(res.skipReason, /pasted blind/);
  });

  it('never invents delivery from a malformed readiness result', () => {
    for (const bad of [null, undefined, {}, { gated: true }]) {
      const res = sessions._primePasteOutcome(bad);
      assert.equal(res.outcome, 'unverified');
      assert.ok(res.skipReason, 'an unverified row always says why');
    }
  });
});

describe('delivery ledger accepts and constrains the unverified outcome (#1063)', () => {
  let tmpDir;
  let store;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-unverified-ledger-'));
    // Fresh require so this suite's DB doesn't collide with other files' state.
    store = require('../lib/store');
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records unverified with a reason; the mapped row reads delivered=false', () => {
    const row = store.sessionRuleDeliveries.record({
      sessionId: 1, projectId: null, engineId: 'antigravity',
      channel: 'prime-paste', outcome: 'unverified',
      skipReason: 'at-rest marker never rendered within 90000ms', digest: ''
    });
    assert.equal(row.outcome, 'unverified');
    assert.equal(row.delivered, false);
    assert.match(row.skipReason, /never rendered/);
  });

  it('refuses unverified with no reason — it would record a failure while discarding why', () => {
    assert.throws(() => store.sessionRuleDeliveries.record({
      engineId: 'antigravity', channel: 'prime-paste', outcome: 'unverified', digest: ''
    }), /skipReason is required/);
  });

  it('refuses an unverified SEND through no channel — a state that cannot be true', () => {
    assert.throws(() => store.sessionRuleDeliveries.record({
      engineId: 'antigravity', channel: 'none', outcome: 'unverified',
      skipReason: 'x', digest: ''
    }), /cannot be unverified/);
  });

  it('an unverified-only project still counts as undelivered — surfacing it is the point', () => {
    const project = store.projects.create({ name: `unv-${Date.now()}`, path: path.join(tmpDir, 'unv') });
    try {
      store.sessionRules.create({ content: 'a rule', projectId: project.id });
      store.sessionRuleDeliveries.record({
        sessionId: 2, projectId: project.id, engineId: 'aider',
        channel: 'prime-paste', outcome: 'unverified',
        skipReason: 'pasted blind after a fixed 5000ms delay', digest: 'd'
      });
      const undelivered = store.sessionRuleDeliveries.projectsWithUndeliveredRules();
      const hit = undelivered.find((p) => p.projectId === project.id);
      assert.ok(hit, 'a project whose only rows are unverified has not verifiably received its rules');
      assert.equal(hit.lastOutcome, 'unverified');
    } finally {
      for (const rule of store.sessionRules.list({ projectId: project.id })) store.sessionRules.delete(rule.id);
      store.projects.delete(project.id);
    }
  });
});

describe('schema v30→v31 — outcome CHECK widened on a REAL old DB', () => {
  it('preserves old rows verbatim and accepts unverified after migration', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v31-mig-'));
    const store = require('../lib/store');
    try {
      const { DatabaseSync } = require('node:sqlite');
      const seed = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (30);
        CREATE TABLE session_rule_deliveries (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   INTEGER,
          project_id   INTEGER,
          engine_id    TEXT    NOT NULL,
          kind         TEXT    NOT NULL DEFAULT 'startup',
          channel      TEXT    NOT NULL CHECK (channel IN ('prime-file','prime-paste','rules-hook','none')),
          outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped')),
          skip_reason  TEXT,
          rule_ids     TEXT    NOT NULL DEFAULT '[]',
          rule_count   INTEGER NOT NULL DEFAULT 0,
          digest       TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (outcome != 'delivered' OR channel != 'none'),
          CHECK (outcome != 'skipped'   OR skip_reason IS NOT NULL)
        );
        INSERT INTO session_rule_deliveries
          (session_id, engine_id, channel, outcome, skip_reason, rule_ids, rule_count, digest)
        VALUES
          (7, 'claude', 'rules-hook', 'delivered', NULL, '[1]', 1, 'aaaa'),
          (8, 'codex',  'prime-paste', 'skipped', 'tmux send-keys failed', '[]', 0, '');
      `);
      seed.close();

      store._setBasePath(tmpDir);
      store.init();

      const db = store.getDb();
      assert.equal(
        db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get().version,
        store.CURRENT_SCHEMA_VERSION
      );
      // Old rows survive the rebuild verbatim — the audit trail's whole value
      // is outliving what it describes.
      const rows = store.sessionRuleDeliveries.listForSession(7);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].outcome, 'delivered');
      assert.equal(rows[0].digest, 'aaaa');
      const skipped = store.sessionRuleDeliveries.listForSession(8);
      assert.equal(skipped[0].skipReason, 'tmux send-keys failed');
      // And the rebuilt CHECK accepts the value the rebuild exists to allow.
      const fresh = store.sessionRuleDeliveries.record({
        sessionId: 9, engineId: 'antigravity', channel: 'prime-paste',
        outcome: 'unverified', skipReason: 'gate timed out', digest: ''
      });
      assert.equal(fresh.outcome, 'unverified');
    } finally {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
