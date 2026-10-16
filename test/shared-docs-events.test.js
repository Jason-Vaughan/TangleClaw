'use strict';

/*
 * #2389: the shared-document revision record. Every distinct digest observed
 * of a doc is one revision, classified against the persisted baseline: which
 * member rows changed (`row`), whether anything else did (`unknown`), or
 * whether only formatting did. Nothing here is delivered: who the row-aware
 * rule WOULD tell is a shadow, and an unknown author selects no one.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const sharedDocs = require('../lib/shared-docs');

const MEMBERS = [{ id: 11, name: 'TC-Lane-A' }, { id: 12, name: 'TC-Lane-B' }, { id: 13, name: 'TC-Lane-INT' }];
const KEYS = sharedDocs.memberKeys(MEMBERS);

/**
 * A lane-queue-shaped doc: prose, a keyed Lanes table and a Clears table in
 * which one project has several rows.
 * @param {object} [o] - Overrides of the row texts and prose
 * @returns {string}
 */
function laneDoc(o = {}) {
  return [
    '# Lane queue',
    '',
    o.prose || 'Batch running.',
    '',
    '## Lanes',
    '',
    '| Lane | State |',
    '|---|---|',
    `| TC-Lane-A | ${o.a || 'building'} |`,
    `| TC-Lane-B | ${o.b || 'planning'} |`,
    '',
    '## Clears',
    '',
    '| Lane | When |',
    '|:--|--:|',
    ...(o.clears || ['| TC-Lane-A | 19:22 |', '| TC-Lane-A | 18:59 |', '| TC-Lane-B | 18:40 |']),
    ''
  ].join('\n');
}

/**
 * Classify `next` against `prior` with the lane members.
 * @param {string} prior - Prior content
 * @param {string} next - New content
 * @returns {object}
 */
function diff(prior, next) {
  return sharedDocs.classify({ content: prior }, next, KEYS);
}

describe('shared-doc revisions: classification (#2389)', () => {
  it('one keyed row changed: class row, that project only, attribution complete', () => {
    const r = diff(laneDoc(), laneDoc({ a: 'ready' }));
    assert.deepEqual(r.classes, ['row']);
    assert.deepEqual(r.changedProjectIds, [11]);
    assert.equal(r.attribution, 'complete');
    assert.equal(r.changedRowCount, 2);
    assert.match(r.excerpt, /\+ \| TC-Lane-A \| ready \|/);
  });

  it('two keyed rows changed: both ids', () => {
    assert.deepEqual(diff(laneDoc(), laneDoc({ a: 'ready', b: 'blocked' })).changedProjectIds, [11, 12]);
  });

  it('prose changed: unknown, no project', () => {
    const r = diff(laneDoc(), laneDoc({ prose: 'Batch paused.' }));
    assert.deepEqual(r.classes, ['unknown']);
    assert.deepEqual(r.changedProjectIds, []);
  });

  it('a row and prose changed together: both classes, the row still named', () => {
    const r = diff(laneDoc(), laneDoc({ a: 'ready', prose: 'Batch paused.' }));
    assert.deepEqual(r.classes, ['row', 'unknown']);
    assert.deepEqual(r.changedProjectIds, [11]);
  });

  it('whitespace, bold and separator alignment only: formatting', () => {
    const prior = laneDoc();
    const next = prior
      .replace('| TC-Lane-A | building |', '|   **TC-Lane-A**   |  building   |')
      .replace('Batch running.', 'Batch   **running.**')
      .replace('|:--|--:|', '|---|---|')
      .replace('## Lanes\n', '## Lanes\n\n');
    assert.notEqual(prior, next);
    assert.deepEqual(diff(prior, next).classes, ['formatting']);
  });

  it('a removed table: unknown, and its rows are named as changed', () => {
    const prior = laneDoc();
    const next = prior.split('## Clears')[0];
    const r = diff(prior, next);
    assert.ok(r.classes.includes('unknown'));
    assert.deepEqual(r.changedProjectIds, [11, 12]);
  });

  it('a row moved, or same-key rows reordered: no change for that key', () => {
    const prior = laneDoc();
    const reordered = laneDoc({ clears: ['| TC-Lane-B | 18:40 |', '| TC-Lane-A | 18:59 |', '| TC-Lane-A | 19:22 |'] });
    assert.deepEqual(diff(prior, reordered).classes, ['formatting']);
  });

  it('a row moved between two tables with the same header under different headings: that key changes', () => {
    const doc = (activeA) => [
      '## Active', '', '| Lane | State |', '|---|---|',
      ...(activeA ? ['| TC-Lane-A | building |'] : []), '| TC-Lane-B | planning |', '',
      '## Done', '', '| Lane | State |', '|---|---|',
      ...(activeA ? [] : ['| TC-Lane-A | building |']), ''
    ].join('\n');
    const r = diff(doc(true), doc(false));
    assert.ok(r.classes.includes('row'), 'a lane moved from Active to Done is a change to that lane, never formatting');
    assert.deepEqual(r.changedProjectIds, [11]);
  });

  it('renaming a heading over a keyed table over-reports its rows rather than hiding anything', () => {
    const r = diff(laneDoc(), laneDoc().replace('## Lanes', '## Lane states'));
    assert.deepEqual(r.classes, ['row', 'unknown']);
    assert.deepEqual(r.changedProjectIds, [11, 12]);
  });

  it('a new row added under a key with several rows: only that key changes', () => {
    const next = laneDoc({ clears: ['| TC-Lane-A | 19:22 |', '| TC-Lane-A | 18:59 |', '| TC-Lane-A | 20:01 |', '| TC-Lane-B | 18:40 |'] });
    const r = diff(laneDoc(), next);
    assert.deepEqual(r.classes, ['row']);
    assert.deepEqual(r.changedProjectIds, [11]);
    assert.equal(r.changedRowCount, 1);
  });

  it('a key in backticks or bold resolves; a key naming no member is unknown', () => {
    const prior = laneDoc();
    assert.deepEqual(diff(prior, prior.replace('| TC-Lane-A | building |', '| `TC-Lane-A` | building |')).classes, ['formatting']);
    const r = diff(prior, prior.replace('| TC-Lane-B | 18:40 |', '| TC-Lane-Z | 18:40 |'));
    assert.deepEqual(r.changedProjectIds, [12]);
    assert.ok(r.classes.includes('unknown'), 'a row whose key names nobody is outside every keyed row');
  });

  it('a name two members share is ambiguous and keys nothing', () => {
    const keys = sharedDocs.memberKeys([...MEMBERS, { id: 99, name: 'TC-Lane-A' }]);
    const r = sharedDocs.classify({ content: laneDoc() }, laneDoc({ a: 'ready' }), keys);
    assert.deepEqual(r.changedProjectIds, []);
    assert.deepEqual(r.classes, ['unknown']);
  });

  it('no baseline: first-seen, nothing changed claimed', () => {
    const r = sharedDocs.classify(null, laneDoc(), KEYS);
    assert.deepEqual(r.classes, ['first-seen']);
    assert.deepEqual(r.changedProjectIds, []);
  });

  it('either side without its full content: digest-only, unknown, incomplete, empty set', () => {
    for (const [prior, next] of [[{ content: null }, laneDoc({ a: 'ready' })], [{ content: laneDoc() }, null]]) {
      const r = sharedDocs.classify(prior, next, KEYS);
      assert.deepEqual(r.classes, ['unknown']);
      assert.equal(r.attribution, 'incomplete');
      assert.equal(r.baseline, 'digest-only');
      assert.deepEqual(r.changedProjectIds, []);
    }
  });

  it('the excerpt is bounded and says when it was cut', () => {
    const big = laneDoc({ prose: 'x '.repeat(5000) });
    const r = diff(laneDoc(), big);
    assert.ok(Buffer.byteLength(r.excerpt) <= sharedDocs.limits.excerptBytes);
    assert.equal(r.excerptTruncated, true);
  });
});

describe('shared-doc revisions: the shadow selection (#2389)', () => {
  const row = { classes: ['row'], attribution: 'complete', changedProjectIds: [11, 13] };

  it('a known author: the changed rows\' owners, the author excluded', () => {
    assert.deepEqual(sharedDocs.wouldSelect(row, 13), [11]);
  });

  it('an unknown author, an incomplete set, or no changed rows: no one', () => {
    assert.deepEqual(sharedDocs.wouldSelect(row, null), []);
    assert.deepEqual(sharedDocs.wouldSelect({ ...row, attribution: 'incomplete' }, 13), []);
    assert.deepEqual(sharedDocs.wouldSelect({ ...row, classes: ['unknown'] }, 13), []);
  });
});

describe('shared-doc revisions: the record (#2389)', () => {
  let tmpDir;
  let group;
  let docId;
  let file;
  let projects;

  /** Open the store on this test's directory. */
  const open = () => { store._setBasePath(tmpDir); store.init(); };

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shared-doc-events-'));
    open();
    projects = ['TC-Lane-A', 'TC-Lane-B', 'TC-Lane-INT'].map((name) => {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir, { recursive: true });
      return store.projects.create({ name, path: dir, engine: 'claude' });
    });
    group = store.projectGroups.create({ name: 'lanes' });
    for (const p of projects) store.projectGroups.addMember(group.id, p.id);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    file = path.join(tmpDir, `QUEUE-${Math.random().toString(36).slice(2)}.md`);
    fs.writeFileSync(file, laneDoc());
    docId = store.sharedDocs.create({ groupId: group.id, name: path.basename(file), filePath: file }).id;
    sharedDocs.limits.baselineCapBytes = 8 * 1024 * 1024;
  });

  it('the first observation is first-seen; the same bytes again are a duplicate, not a revision', async () => {
    const first = await sharedDocs.observe(docId, { source: 'watch' });
    assert.equal(first.duplicate, false);
    assert.deepEqual(first.revision.classes, ['first-seen']);
    assert.equal(first.revision.seq, 1);
    const again = await sharedDocs.observe(docId, { source: 'notify' });
    assert.equal(again.duplicate, true);
    assert.equal(again.revision.seq, 1);
    assert.equal(again.revision.duplicateObservations, 1);
  });

  it('an unattested row edit: author unknown, the lock holder kept only as a hint, no one selected', async () => {
    await sharedDocs.observe(docId, { source: 'watch' });
    const int = projects[2];
    store.documentLocks.acquire(docId, 4242, int.name);
    fs.writeFileSync(file, laneDoc({ a: 'ready' }));
    const { revision } = await sharedDocs.observe(docId, { source: 'watch' });
    assert.equal(revision.authorSource, 'unknown');
    assert.equal(revision.authorProjectId, null);
    assert.deepEqual(revision.lockHolderHint, { sessionId: 4242, project: int.name });
    assert.deepEqual(revision.changedProjectIds, [projects[0].id]);
    assert.deepEqual(revision.shadowWouldSelect, []);
    store.documentLocks.release(docId);
  });

  it('a restart between two edits: the second is classified against the persisted baseline, prose included', async () => {
    await sharedDocs.observe(docId, { source: 'watch' });
    store.close();
    open();
    fs.writeFileSync(file, laneDoc({ prose: 'Batch paused.' }));
    const { revision } = await sharedDocs.observe(docId, { source: 'watch' });
    assert.equal(revision.seq, 2);
    assert.deepEqual(revision.classes, ['unknown']);
    assert.equal(revision.attribution, 'complete');
  });

  it('a doc over the baseline cap: digest-only, unknown, incomplete, no one selected, and still incomplete on the way back under', async () => {
    await sharedDocs.observe(docId, { source: 'watch' });
    sharedDocs.limits.baselineCapBytes = 64;
    fs.writeFileSync(file, laneDoc({ a: 'ready' }));
    const over = (await sharedDocs.observe(docId, { source: 'watch' })).revision;
    assert.deepEqual(over.classes, ['unknown']);
    assert.equal(over.attribution, 'incomplete');
    assert.equal(over.baseline, 'digest-only');
    assert.deepEqual(over.changedProjectIds, []);
    assert.equal(store.sharedDocEvents.getBaseline(docId).complete, false);

    sharedDocs.limits.baselineCapBytes = 8 * 1024 * 1024;
    fs.writeFileSync(file, laneDoc({ a: 'done' }));
    const back = (await sharedDocs.observe(docId, { source: 'watch' })).revision;
    assert.equal(back.attribution, 'incomplete', 'an over-cap prior never yields a complete changed set');
    assert.deepEqual(back.changedProjectIds, []);
    assert.equal(store.sharedDocEvents.getBaseline(docId).complete, true);
  });

  it('two concurrent observations of different bytes get consecutive seqs with the right prior digests', async () => {
    const base = await sharedDocs.observe(docId, { source: 'watch' });
    const one = Buffer.from(laneDoc({ a: 'one' }));
    const two = Buffer.from(laneDoc({ a: 'two' }));
    // The first read is the slower one: without the serializer the second
    // would be recorded first, against the same prior.
    const slow = () => new Promise((resolve) => setTimeout(() => resolve(one), 40));
    const [r1, r2] = await Promise.all([
      sharedDocs.observe(docId, { source: 'watch', read: slow }),
      sharedDocs.observe(docId, { source: 'notify', read: async () => two })
    ]);
    assert.equal(r1.revision.seq, 2);
    assert.equal(r1.revision.priorSha256, base.revision.sha256);
    assert.equal(r2.revision.seq, 3);
    assert.equal(r2.revision.priorSha256, sharedDocs.sha256(one));
  });

  it('a failed read does not stop the doc\'s queue', async () => {
    const failing = sharedDocs.observe(docId, { source: 'watch', read: async () => { throw new Error('boom'); } });
    const ok = sharedDocs.observe(docId, { source: 'watch' });
    await assert.rejects(failing, /boom/);
    assert.equal((await ok).revision.seq, 1);
  });

  it('a missing file is refused as unreadable and records nothing', async () => {
    fs.rmSync(file);
    await assert.rejects(sharedDocs.observe(docId, { source: 'watch' }), (e) => e.code === 'UNREADABLE');
    assert.equal(store.sharedDocEvents.latest(docId), null);
  });

  it('a base capture records the observation it answers', async () => {
    const base = await sharedDocs.captureBase(docId);
    assert.equal(base.seq, 1);
    assert.equal(base.sha256, sharedDocs.sha256(fs.readFileSync(file)));
    assert.equal(store.sharedDocEvents.latest(docId).source, 'base');
  });

  describe('attestation, below the route', () => {
    const caller = () => ({ projectId: projects[2].id, sessionId: 777 });

    it('binds the edit that followed the base, with the session and the shadow selection', async () => {
      const base = await sharedDocs.captureBase(docId);
      fs.writeFileSync(file, laneDoc({ a: 'ready' }));
      const out = await sharedDocs.attest(docId, {
        ...caller(), baseSha256: base.sha256, sha256: sharedDocs.sha256(fs.readFileSync(file)), recheck: () => null
      });
      assert.equal(out.status, 200);
      assert.equal(out.revision.authorSource, 'attested');
      assert.equal(out.revision.authorProjectId, projects[2].id);
      assert.equal(out.revision.authorSessionId, 777);
      assert.deepEqual(out.revision.shadowWouldSelect, [projects[0].id]);
      assert.equal(out.revision.source, 'attest');
    });

    it('a no-op (the base digest named as the edit) is refused and claims nothing', async () => {
      const base = await sharedDocs.captureBase(docId);
      const out = await sharedDocs.attest(docId, { ...caller(), baseSha256: base.sha256, sha256: base.sha256, recheck: () => null });
      assert.equal(out.code, 'NO_CHANGE');
      assert.equal(store.sharedDocEvents.latest(docId).authorSource, 'unknown');
    });

    it('a recheck that fails after the read leaves the binding as it was', async () => {
      const base = await sharedDocs.captureBase(docId);
      fs.writeFileSync(file, laneDoc({ a: 'ready' }));
      const sha = sharedDocs.sha256(fs.readFileSync(file));
      const out = await sharedDocs.attest(docId, {
        ...caller(), baseSha256: base.sha256, sha256: sha,
        recheck: () => ({ status: 409, code: 'NOT_LOCK_HOLDER', message: 'the lock has expired' })
      });
      assert.equal(out.code, 'NOT_LOCK_HOLDER');
      const latest = store.sharedDocEvents.latest(docId);
      assert.equal(latest.authorSource, 'unknown');
      assert.equal(latest.seq, 1, 'refused before recording: the base is still the newest revision');
    });

    it('a recheck runs after the read, not before it', async () => {
      const base = await sharedDocs.captureBase(docId);
      fs.writeFileSync(file, laneDoc({ a: 'ready' }));
      let read = false;
      let readBeforeRecheck = null;
      await sharedDocs.attest(docId, {
        ...caller(), baseSha256: base.sha256, sha256: sharedDocs.sha256(fs.readFileSync(file)),
        read: async (doc) => { const b = fs.readFileSync(doc.filePath); read = true; return b; },
        recheck: () => { readBeforeRecheck = read; return null; }
      });
      assert.equal(readBeforeRecheck, true);
    });
  });
});

describe('shared-doc revisions: retention (#2389)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shared-doc-retention-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Register a doc and record `n` revisions observed at `at`.
   * @param {number} n - How many
   * @param {string} at - ISO time
   * @returns {string} Doc id
   */
  function docWith(n, at) {
    const group = store.projectGroups.create({ name: `r-${Math.random().toString(36).slice(2)}` });
    const file = path.join(tmpDir, `${group.id}.md`);
    fs.writeFileSync(file, 'x');
    const docId = store.sharedDocs.create({ groupId: group.id, name: 'R', filePath: file }).id;
    for (let i = 0; i < n; i++) {
      store.sharedDocEvents.recordRevision({
        docId, observedAt: at, sha256: sharedDocs.sha256(String(i)), classes: ['unknown'], attribution: 'complete',
        baseline: 'full', changedProjectIds: [], changedRowCount: 0, source: 'watch'
      }, { content: String(i), byteLength: 1 });
    }
    return docId;
  }

  it('old revisions beyond the newest kept are pruned, and a reader behind them is told of the gap', () => {
    const old = new Date(Date.now() - (store.SHARED_DOC_EVENTS_KEEP_DAYS + 5) * 86400000).toISOString();
    const docId = docWith(store.SHARED_DOC_EVENTS_KEEP + 3, old);
    const page = store.sharedDocEvents.list(docId, { sinceSeq: 0, limit: 1 });
    assert.equal(page.oldestRetainedSeq, 4);
    assert.equal(page.latest.seq, store.SHARED_DOC_EVENTS_KEEP + 3);
    assert.equal(page.gap, true);
    assert.equal(page.events[0].seq, 4);
    assert.equal(store.sharedDocEvents.list(docId, { sinceSeq: 3, limit: 1 }).gap, false);
  });

  it('revisions inside the kept days survive past the count', () => {
    const docId = docWith(store.SHARED_DOC_EVENTS_KEEP + 3, new Date().toISOString());
    assert.equal(store.sharedDocEvents.list(docId, { limit: 1 }).oldestRetainedSeq, 1);
  });
});
