'use strict';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel, getLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('store.activity', () => {
  let tmpDir;
  let projectId;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-activity-'));
    store._setBasePath(tmpDir);
    store.init();

    const project = store.projects.create({
      name: 'activity-test',
      path: '/tmp/activity-test'
    });
    projectId = project.id;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('log', () => {
    it('logs an event with all fields', () => {
      store.activity.log({
        projectId,
        sessionId: null,
        eventType: 'test.event',
        detail: { foo: 'bar' }
      });

      const entries = store.activity.query({ eventType: 'test.event' });
      assert.ok(entries.length >= 1);
      const entry = entries.find((e) => e.detail && e.detail.foo === 'bar');
      assert.ok(entry);
      assert.equal(entry.projectId, projectId);
    });

    it('logs event with minimal fields', () => {
      store.activity.log({ eventType: 'system.test' });

      const entries = store.activity.query({ eventType: 'system.test' });
      assert.ok(entries.length >= 1);
      assert.equal(entries[0].projectId, null);
    });

    it('never throws', () => {
      // Even with bogus data, should not throw
      assert.doesNotThrow(() => {
        store.activity.log({ eventType: 'safe.test' });
      });
    });

    it('handles null detail', () => {
      store.activity.log({ eventType: 'null.detail', detail: null });
      const entries = store.activity.query({ eventType: 'null.detail' });
      assert.ok(entries.length >= 1);
      assert.equal(entries[0].detail, null);
    });
  });

  describe('query', () => {
    it('queries by projectId', () => {
      const entries = store.activity.query({ projectId });
      assert.ok(entries.length >= 1);
      for (const e of entries) {
        assert.equal(e.projectId, projectId);
      }
    });

    it('queries by eventType', () => {
      const entries = store.activity.query({ eventType: 'test.event' });
      assert.ok(entries.length >= 1);
      for (const e of entries) {
        assert.equal(e.eventType, 'test.event');
      }
    });

    it('respects limit', () => {
      // Log multiple events
      for (let i = 0; i < 5; i++) {
        store.activity.log({ eventType: 'limit.test', detail: { i } });
      }
      const entries = store.activity.query({ eventType: 'limit.test', limit: 2 });
      assert.equal(entries.length, 2);
    });

    it('defaults to limit 50', () => {
      const entries = store.activity.query({});
      assert.ok(entries.length <= 50);
    });

    it('orders by created_at DESC', () => {
      const entries = store.activity.query({});
      for (let i = 1; i < entries.length; i++) {
        assert.ok(entries[i - 1].createdAt >= entries[i].createdAt);
      }
    });

    it('has expected fields on entries', () => {
      const entries = store.activity.query({ limit: 1 });
      assert.ok(entries.length > 0);
      const entry = entries[0];
      assert.ok('id' in entry);
      assert.ok('projectId' in entry);
      assert.ok('sessionId' in entry);
      assert.ok('eventType' in entry);
      assert.ok('createdAt' in entry);
    });
  });

  describe('retention (#869)', () => {
    // `created_at` has one-second resolution, so a burst inside one second has no
    // total order by timestamp and `query()`'s ORDER BY created_at DESC is
    // arbitrary among them. Order by `id`, which is what the prune orders by.
    const newestFirst = (eventType) =>
      store.activity.query({ eventType, limit: 100 }).sort((a, b) => b.id - a.id);

    // The `log.warn` is the surface an operator greps, so it is asserted rather
    // than assumed. The suite runs at level `error`, so the level is raised and
    // the stream pinned for the duration — the seam `lib/logger.js` exposes.
    const captureLogs = (fn) => {
      const lines = [];
      const priorLevel = getLevel();
      setLevel('warn');
      setConsoleStream({ write: (s) => lines.push(s) });
      try {
        fn();
      } finally {
        setConsoleStream(null);
        setLevel(priorLevel);
      }
      return lines.filter((l) => /Retention sweep pruned activity log/.test(l));
    };

    afterEach(() => {
      store._setActivityLogRetention(store.ACTIVITY_LOG_RETENTION);
    });

    it('caps a churny type while a rarer type past that volume is untouched', () => {
      store._setActivityLogRetention(3);

      // The forensic row goes in FIRST and is the oldest row in the table, so a
      // time-based TTL or a table-wide cap would evict it first. A per-type cap
      // cannot: eviction never crosses a type boundary.
      store.activity.log({ eventType: 'wrap.auto_pr', detail: { id: 'forensic-1' } });
      for (let i = 1; i <= 4; i++) {
        store.activity.log({ eventType: 'port.leased', detail: { id: `churn-${i}` } });
      }

      const forensic = newestFirst('wrap.auto_pr');
      assert.equal(forensic.length, 1, 'a type below its cap is never pruned, however old its rows');
      assert.equal(forensic[0].detail.id, 'forensic-1');

      const churny = newestFirst('port.leased');
      assert.equal(churny.length, 3, 'the churny type stops at its cap');
      assert.deepEqual(
        churny.map((r) => r.detail.id),
        ['churn-4', 'churn-3', 'churn-2'],
        'the rows kept are the newest, and the oldest is the one dropped'
      );
    });

    it('prunes NULL-project_id rows, which are the whole of the largest type', () => {
      // The Project Master writes rows with no project, and so does every
      // `port.leased`. A project-keyed prune would leave exactly these unbounded
      // — the case `_pruneSessionRuleDeliveries` documents itself as not covering.
      store._setActivityLogRetention(2);

      for (let n = 1; n <= 3; n++) store.activity.log({ eventType: 'master.ping', detail: { n } });

      const pings = newestFirst('master.ping');
      assert.equal(pings.length, 2, 'a NULL-project row is subject to the policy');
      assert.deepEqual(pings.map((r) => r.detail.n), [3, 2]);
      assert.equal(pings[0].projectId, null, 'the rows under test really do carry no project');
    });

    it('stays silent on a steady-state trim, so the report is not itself churn', () => {
      // Each insert past the cap trims exactly one row. Reporting that would
      // write a second row per insert, doubling the table's write rate and
      // making the report the churniest type in the table.
      //
      // Asserted as a SHAPE (no report names this type) rather than as a count
      // delta. `activity.pruned` is itself capped, so once a count reaches the
      // cap it cannot rise, and a count-based assertion would silently stop
      // detecting the very defect it guards — passing for the wrong reason.
      store._setActivityLogRetention(3);

      const warnings = captureLogs(() => {
        for (let i = 0; i < 8; i++) {
          store.activity.log({ eventType: 'steady.churn', detail: { i } });
        }
      });

      assert.equal(newestFirst('steady.churn').length, 3, 'the type is still capped');
      assert.ok(
        !newestFirst(store.ACTIVITY_PRUNE_EVENT)
          .some((r) => r.detail && r.detail.prunedType === 'steady.churn'),
        'eight over-cap inserts wrote no prune report'
      );
      assert.deepEqual(warnings, [], 'and logged no warning — one per insert is the flood');
    });

    it('reports a convergence prune, naming what it displaced and what survived', () => {
      // The case that matters on a real install: the cap meets existing history
      // and one insert deletes a backlog. Built by writing the backlog with the
      // policy disabled, so the trim happens in a single statement — the shape
      // the live table will actually take on the first insert after this ships.
      store._setActivityLogRetention(0);
      for (let i = 0; i < 10; i++) {
        store.activity.log({ eventType: 'converge.test', detail: { i } });
      }
      assert.equal(newestFirst('converge.test').length, 10, 'the backlog exists before the cap applies');

      store._setActivityLogRetention(3);
      const warnings = captureLogs(() => {
        store.activity.log({ eventType: 'converge.test', detail: { i: 'trigger' } });
      });

      assert.equal(newestFirst('converge.test').length, 3, 'the backlog converged to the cap');

      const report = newestFirst(store.ACTIVITY_PRUNE_EVENT)
        .find((r) => r.detail && r.detail.prunedType === 'converge.test');
      assert.ok(report, 'the convergence prune is on the record');
      assert.equal(report.detail.count, 8, 'the report names how many rows it displaced');
      assert.ok(report.detail.retainedFrom, 'and the history horizon it left behind');

      // The durable row is half the report; the other half is the line the
      // operator greps, and it must carry the same three facts.
      assert.equal(warnings.length, 1, 'a converged backlog warns exactly once');
      assert.match(warnings[0], /converge\.test/, 'the warning names the type it pruned');
      assert.match(warnings[0], /count=8/, 'and how many rows it displaced');
      assert.match(warnings[0], /retainedFrom=/, 'and the horizon it left behind');
    });

    it('does not report its own prune, so the report path cannot re-enter itself', () => {
      // `activity.pruned` is written by the report path, so pruning it must not
      // report in turn. Asserting the row COUNT cannot see this — the extra
      // self-report is immediately trimmed back to the cap either way. What
      // distinguishes them is whether any report names the report type itself.
      store._setActivityLogRetention(0);
      for (let i = 0; i < 6; i++) {
        store.activity.log({ eventType: store.ACTIVITY_PRUNE_EVENT, detail: { i } });
      }

      store._setActivityLogRetention(3);
      assert.doesNotThrow(() => {
        store.activity.log({ eventType: store.ACTIVITY_PRUNE_EVENT, detail: { i: 'trigger' } });
      });

      const rows = newestFirst(store.ACTIVITY_PRUNE_EVENT);
      assert.equal(rows.length, 3, 'its own type is capped like any other');
      assert.ok(
        !rows.some((r) => r.detail && r.detail.prunedType === store.ACTIVITY_PRUNE_EVENT),
        'no report names the report type — the path never re-entered'
      );
    });

    it('names the failing step when a write fails, so a broken prune is detectable', () => {
      // The catch swallows deliberately — activity logging must not break its
      // caller — which makes the log line the only evidence. A prune throwing on
      // every insert means the table is growing unbounded again, the condition
      // this policy exists to prevent, and it must not read like one lost event.
      const lines = [];
      const priorLevel = getLevel();
      setLevel('error');
      setConsoleStream({ write: (s) => lines.push(s) });
      try {
        // `event_type` is NOT NULL, so this fails inside the insert.
        assert.doesNotThrow(() => store.activity.log({ eventType: null }));
      } finally {
        setConsoleStream(null);
        setLevel(priorLevel);
      }

      const failure = lines.find((l) => /Activity log write failed/.test(l));
      assert.ok(failure, 'the failure reaches the logger, not a raw stderr write');
      assert.match(failure, /phase=insert/, 'and names which step failed');
    });

    it('keeps everything when retention is disabled, at zero AND below it', () => {
      // The seam documents "<= 0 keeps all", so both halves of that are asserted:
      // a falsy check alone would satisfy 0 while silently pruning on a negative.
      for (const disabled of [0, -1]) {
        const type = `unbounded.test.${disabled}`;
        store._setActivityLogRetention(disabled);
        for (let i = 0; i < 12; i++) store.activity.log({ eventType: type, detail: { i } });
        assert.equal(newestFirst(type).length, 12, `retention ${disabled} keeps all`);
      }
    });
  });
});
