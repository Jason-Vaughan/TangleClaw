'use strict';

/**
 * `store.handoffs` — the DB half of the per-attempt handoff (Train 21, #1585).
 *
 * The property under test throughout: every write names ONE attempt, so a late
 * or failed attempt can never borrow a neighbouring one's success. The cases
 * below are the plan's §2.6 acceptance rows that live purely in the DB; the
 * file-coordination rows belong to the lockfile module.
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store.js');

const tmpDirs = [];

/**
 * A store on its own temp directory, so no test ever reads the live install.
 * @returns {void}
 */
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-handoff-store-'));
  tmpDirs.push(dir);
  store._setBasePath(dir);
  store.init();
}

/**
 * Stage an attempt with sensible defaults.
 * @param {object} [over] - Field overrides
 * @returns {object} The staged publication
 */
function stage(over = {}) {
  const attempt = {
    publicationId: `pub-${Math.random().toString(36).slice(2)}`,
    projectId: 14,
    sessionId: 100,
    wrapRunId: 'run-1',
    kind: 'final',
    fileDigest: 'digest-1',
    stagedAt: '2026-09-17T21:00:00.000Z',
    ...over
  };
  return store.handoffs.stage(attempt).publication;
}

beforeEach(freshStore);

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('staging an attempt (#1585)', () => {
  it('records it as staged, not yet eligible', () => {
    const pub = stage();
    assert.equal(pub.state, 'staged');
    assert.equal(pub.eligibleAt, null);
    assert.equal(pub.eligibleVia, null);
  });

  it('gives each attempt a seq that orders it against every other', () => {
    const a = stage({ wrapRunId: 'run-a' });
    const b = stage({ wrapRunId: 'run-b' });
    assert.ok(b.seq > a.seq, 'a later attempt must sort after an earlier one');
  });

  it('is idempotent within one run — a replayed stage returns the first attempt and writes nothing', () => {
    const first = store.handoffs.stage({
      publicationId: 'pub-1', projectId: 14, sessionId: 100, wrapRunId: 'run-1',
      kind: 'final', fileDigest: 'd', stagedAt: '2026-09-17T21:00:00.000Z'
    });
    const replay = store.handoffs.stage({
      publicationId: 'pub-2', projectId: 14, sessionId: 100, wrapRunId: 'run-1',
      kind: 'final', fileDigest: 'd', stagedAt: '2026-09-17T21:05:00.000Z'
    });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.publication.publicationId, 'pub-1', 'the second id must not be minted');
    assert.equal(store.handoffs.listByProject(14).length, 1);
  });

  it('treats a RESUMED wrap as a new attempt, because it is a new run', () => {
    stage({ wrapRunId: 'run-1' });
    const retry = stage({ wrapRunId: 'run-2' });
    assert.equal(store.handoffs.listByProject(14).length, 2);
    assert.equal(retry.state, 'staged');
  });
});

describe('binding eligibility — the attempt-exact proof of completion', () => {
  it('binds the final attempt named by the lifecycle transition', () => {
    const pub = stage();
    const bound = store.handoffs.bindLifecycleEligibility(
      pub.publicationId, 100, 'run-1', '2026-09-17T21:01:00.000Z'
    );
    assert.equal(bound, true);
    const after = store.handoffs.get(pub.publicationId);
    assert.equal(after.eligibleVia, 'lifecycle-wrap');
    assert.ok(after.eligibleAt);
  });

  it('refuses to bind an attempt from a DIFFERENT run, so a later run cannot complete an earlier one', () => {
    const pub = stage({ wrapRunId: 'run-1' });
    const bound = store.handoffs.bindLifecycleEligibility(
      pub.publicationId, 100, 'run-2', '2026-09-17T21:01:00.000Z'
    );
    assert.equal(bound, false);
    assert.equal(store.handoffs.get(pub.publicationId).eligibleAt, null);
  });

  it('returns false rather than throwing when nothing matches, so a legitimate wrap is never rolled back', () => {
    assert.equal(
      store.handoffs.bindLifecycleEligibility('no-such-pub', 100, 'run-1', '2026-09-17T21:01:00.000Z'),
      false
    );
  });

  it('never binds a checkpoint through the lifecycle path, or a final through the checkpoint path', () => {
    const cp = stage({ kind: 'checkpoint', wrapRunId: 'run-cp' });
    assert.equal(
      store.handoffs.bindLifecycleEligibility(cp.publicationId, 100, 'run-cp', '2026-09-17T21:01:00.000Z'),
      false,
      'a checkpoint has no lifecycle transition to be bound by'
    );
    const fin = stage({ kind: 'final', wrapRunId: 'run-fin' });
    assert.equal(
      store.handoffs.markCheckpointComplete(fin.publicationId, 'run-fin', '2026-09-17T21:01:00.000Z'),
      false
    );
  });

  it('binds a checkpoint on its own single write', () => {
    const cp = stage({ kind: 'checkpoint', wrapRunId: 'run-cp' });
    assert.equal(
      store.handoffs.markCheckpointComplete(cp.publicationId, 'run-cp', '2026-09-17T21:01:00.000Z'),
      true
    );
    assert.equal(store.handoffs.get(cp.publicationId).eligibleVia, 'checkpoint-complete');
  });

  it('binds at most once — a replayed bind does not re-stamp the time', () => {
    const pub = stage();
    store.handoffs.bindLifecycleEligibility(pub.publicationId, 100, 'run-1', '2026-09-17T21:01:00.000Z');
    const firstAt = store.handoffs.get(pub.publicationId).eligibleAt;
    const again = store.handoffs.bindLifecycleEligibility(
      pub.publicationId, 100, 'run-1', '2026-09-17T21:09:00.000Z'
    );
    assert.equal(again, false);
    assert.equal(store.handoffs.get(pub.publicationId).eligibleAt, firstAt);
  });

  it('lets at most ONE final attempt per session ever be eligible', () => {
    const a = stage({ wrapRunId: 'run-a' });
    const b = stage({ wrapRunId: 'run-b' });
    assert.equal(store.handoffs.bindLifecycleEligibility(a.publicationId, 100, 'run-a', '2026-09-17T21:01:00.000Z'), true);
    assert.throws(
      () => store.handoffs.bindLifecycleEligibility(b.publicationId, 100, 'run-b', '2026-09-17T21:02:00.000Z'),
      /UNIQUE|constraint/i,
      'the partial unique index must refuse a second eligible final for one session'
    );
  });
});

describe('publishing', () => {
  it('marks this attempt published and the one it replaced superseded', () => {
    const first = stage({ wrapRunId: 'run-a' });
    store.handoffs.bindLifecycleEligibility(first.publicationId, 100, 'run-a', '2026-09-17T21:01:00.000Z');
    store.handoffs.recordPublished(first.publicationId, null, '2026-09-17T21:01:01.000Z');
    assert.equal(store.handoffs.get(first.publicationId).state, 'published');

    const second = stage({ sessionId: 101, wrapRunId: 'run-b' });
    store.handoffs.bindLifecycleEligibility(second.publicationId, 101, 'run-b', '2026-09-17T21:02:00.000Z');
    store.handoffs.recordPublished(second.publicationId, first.publicationId, '2026-09-17T21:02:01.000Z');

    const old = store.handoffs.get(first.publicationId);
    assert.equal(old.state, 'superseded');
    assert.equal(old.supersededBy, second.publicationId);
    assert.equal(store.handoffs.getPublished(14).publicationId, second.publicationId);
  });

  it('answers whether a NEWER publication already won, which is what stops an older attempt overwriting it', () => {
    const older = stage({ wrapRunId: 'run-a' });
    const newer = stage({ sessionId: 101, wrapRunId: 'run-b' });
    store.handoffs.bindLifecycleEligibility(newer.publicationId, 101, 'run-b', '2026-09-17T21:02:00.000Z');
    store.handoffs.recordPublished(newer.publicationId, null, '2026-09-17T21:02:01.000Z');

    assert.equal(store.handoffs.newerPublished(14, older.seq).publicationId, newer.publicationId);
    assert.equal(store.handoffs.newerPublished(14, newer.seq), null);
  });

  it('SUPERSEDES rather than abandons an eligible attempt that lost the race, keeping its eligibility on the record', () => {
    const loser = stage({ wrapRunId: 'run-a' });
    store.handoffs.bindLifecycleEligibility(loser.publicationId, 100, 'run-a', '2026-09-17T21:01:00.000Z');
    const winner = stage({ sessionId: 101, wrapRunId: 'run-b' });

    assert.equal(
      store.handoffs.supersedeBeforePublish(loser.publicationId, winner.publicationId, '2026-09-17T21:03:00.000Z'),
      true
    );
    const row = store.handoffs.get(loser.publicationId);
    assert.equal(row.state, 'superseded');
    assert.equal(row.publishedAt, null, 'it never published');
    assert.ok(row.eligibleAt, 'it DID complete, and the record must still say so');
  });
});

describe('abandoning', () => {
  it('abandons a staged attempt that never became eligible', () => {
    const pub = stage();
    assert.equal(store.handoffs.abandon(pub.publicationId, 'lost-to-kill', '2026-09-17T21:04:00.000Z'), true);
    const row = store.handoffs.get(pub.publicationId);
    assert.equal(row.state, 'abandoned');
    assert.equal(row.abandonedReason, 'lost-to-kill');
  });

  it('REFUSES to abandon an attempt that completed — that one is superseded instead', () => {
    const pub = stage();
    store.handoffs.bindLifecycleEligibility(pub.publicationId, 100, 'run-1', '2026-09-17T21:01:00.000Z');
    assert.equal(store.handoffs.abandon(pub.publicationId, 'whatever', '2026-09-17T21:04:00.000Z'), false);
    assert.equal(store.handoffs.get(pub.publicationId).state, 'staged');
  });

  it('refuses to abandon an already-published attempt', () => {
    const pub = stage();
    store.handoffs.bindLifecycleEligibility(pub.publicationId, 100, 'run-1', '2026-09-17T21:01:00.000Z');
    store.handoffs.recordPublished(pub.publicationId, null, '2026-09-17T21:01:01.000Z');
    assert.equal(store.handoffs.abandon(pub.publicationId, 'too late', '2026-09-17T21:04:00.000Z'), false);
    assert.equal(store.handoffs.get(pub.publicationId).state, 'published');
  });
});

describe('the attempt A / attempt B case the plan calls out by name', () => {
  it('never publishes or repairs attempt A, which staged a final and failed before its lifecycle completed', () => {
    const a = stage({ wrapRunId: 'run-a' });
    // A never binds: its lifecycle did not complete.
    const b = stage({ wrapRunId: 'run-b' });
    store.handoffs.bindLifecycleEligibility(b.publicationId, 100, 'run-b', '2026-09-17T21:05:00.000Z');

    assert.equal(store.handoffs.get(a.publicationId).eligibleAt, null,
      'A is not eligible, whatever B did');
    assert.equal(store.handoffs.get(b.publicationId).eligibleVia, 'lifecycle-wrap');
  });
});
