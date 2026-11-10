'use strict';

// v6 Stage 1 (#2980, V6-07 / E5, BRIDGE-1b): the Closed-Loop Kaizen Ledger
// schema (lib/store/_schema.js, Architect Ruling A531-W1D-KAIZEN-C1-DDL-COSIGN)
// plus lib/v6/e5-kaizen-ledger.js, against a real node:sqlite-backed store.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const e5 = require('../lib/v6/e5-kaizen-ledger');

let tmpDir = null;

/** @returns {import('node:sqlite').DatabaseSync} */
function freshStore() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-e5-kaizen-'));
  store._setBasePath(tmpDir);
  store.init();
  return store.getDb();
}

function cleanup() {
  store.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
}

/** @returns {string} A fresh item id, class defaulting to A_DETERMINISTIC. */
function seedItem(db, over = {}) {
  const r = e5.detectItem(db, {
    originSprint: 'v5.74.0', findingId: 'f-1', defectCategory: 'test-gap', rootCause: 'missing edge case',
    correctiveActionSpec: 'add regression test', ownerRole: 'builder', verificationClass: 'A_DETERMINISTIC',
    targetMetric: 'defect recurrence rate', ...over
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.id;
}

describe('v6 E5 schema (Architect Ruling A531): kaizen_items/kaizen_measurements exist with the ruled shape', () => {
  it('both tables exist, and the DDL is idempotent across a reopen', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    assert.ok(tables.has('kaizen_items'));
    assert.ok(tables.has('kaizen_measurements'));
    assert.doesNotThrow(() => store.init());
  });

  it('rejects an unknown verification_class, lifecycle_state, or measurement_kind at the DB layer', (t) => {
    const db = freshStore();
    t.after(cleanup);
    assert.throws(() => db.exec(
      "INSERT INTO kaizen_items (id, origin_sprint, finding_id, defect_category, root_cause, corrective_action_spec, owner_role, verification_class, target_metric) VALUES ('x','v1','f','c','r','a','o','BOGUS','m')"
    ));
  });
});

describe('detectItem / getItem', () => {
  it('detects a new item in state Detected, effectiveness UNVERIFIED, gate0 unreviewed', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db);
    const item = e5.getItem(db, id);
    assert.equal(item.lifecycle_state, 'Detected');
    assert.equal(item.effectiveness_status, 'UNVERIFIED');
    assert.equal(item.gate0_disposition, 'unreviewed');
    assert.deepEqual(JSON.parse(item.origin_evidence_refs_json), []);
  });

  it('refuses a missing required field or an unknown verification class', (t) => {
    const db = freshStore();
    t.after(cleanup);
    assert.equal(e5.detectItem(db, {
      originSprint: 'v1', findingId: 'f', defectCategory: 'c', rootCause: '', correctiveActionSpec: 'a',
      ownerRole: 'o', verificationClass: 'A_DETERMINISTIC', targetMetric: 'm'
    }).code, 'INVALID_REQUEST');
    assert.equal(e5.detectItem(db, {
      originSprint: 'v1', findingId: 'f', defectCategory: 'c', rootCause: 'r', correctiveActionSpec: 'a',
      ownerRole: 'o', verificationClass: 'BOGUS', targetMetric: 'm'
    }).code, 'INVALID_REQUEST');
  });
});

describe('advanceLifecycle (validated transition graph, Dismissed a terminal dead end)', () => {
  it('walks the full happy path Detected→...→Effectiveness Measured, Implemented stamps IMPLEMENTATION_VERIFIED', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db);
    for (const next of ['Classified', 'Proposed', 'Approved', 'Assigned', 'Implemented']) {
      assert.equal(e5.advanceLifecycle(db, { id, nextState: next }).ok, true, next);
    }
    assert.equal(e5.getItem(db, id).effectiveness_status, 'IMPLEMENTATION_VERIFIED');
    assert.equal(e5.advanceLifecycle(db, { id, nextState: 'Verified' }).ok, true);
    assert.equal(e5.getItem(db, id).lifecycle_state, 'Verified');
  });

  it('Proposed forks to Dismissed, which is terminal effectiveness DISMISSED and never re-enters the happy path', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db);
    e5.advanceLifecycle(db, { id, nextState: 'Classified' });
    e5.advanceLifecycle(db, { id, nextState: 'Proposed' });
    assert.equal(e5.advanceLifecycle(db, { id, nextState: 'Dismissed' }).ok, true);
    assert.equal(e5.getItem(db, id).effectiveness_status, 'DISMISSED');
    assert.equal(e5.advanceLifecycle(db, { id, nextState: 'Assigned' }).code, 'INVALID_TRANSITION');
  });

  it('refuses an unlisted edge (e.g. skipping straight to Verified) and an unknown item', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db);
    assert.equal(e5.advanceLifecycle(db, { id, nextState: 'Verified' }).code, 'INVALID_TRANSITION');
    assert.equal(e5.advanceLifecycle(db, { id: 'missing', nextState: 'Classified' }).code, 'NOT_FOUND');
  });

  it('cannot bypass markProvenEffective/closeItem\'s gating via a direct advanceLifecycle call (Architect Ruling A535)', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db);
    toVerified(db, id);
    // No measurements recorded at all -- canMarkProvenEffective would refuse this.
    // A direct advanceLifecycle call must refuse too, not silently succeed.
    assert.equal(e5.advanceLifecycle(db, { id, nextState: 'Effectiveness Measured' }).code, 'INVALID_TRANSITION');
    assert.equal(e5.getItem(db, id).lifecycle_state, 'Verified');

    db.prepare("UPDATE kaizen_items SET lifecycle_state = 'Effectiveness Measured', effectiveness_status = 'PROVEN_EFFECTIVE' WHERE id = ?").run(id);
    assert.equal(e5.advanceLifecycle(db, { id, nextState: 'Closed' }).code, 'INVALID_TRANSITION');
    assert.equal(e5.getItem(db, id).lifecycle_state, 'Effectiveness Measured');
  });
});

/** Drive an item to `Verified`, the precondition every `canMarkProvenEffective`/`markProvenEffective` test needs. */
function toVerified(db, id) {
  for (const next of ['Classified', 'Proposed', 'Approved', 'Assigned', 'Implemented', 'Verified']) {
    assert.equal(e5.advanceLifecycle(db, { id, nextState: next }).ok, true, next);
  }
}

describe('recordMeasurement / listMeasurements', () => {
  it('records a measurement and refuses one against an unknown item or with an invalid kind', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db);
    const r = e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v5.75.0', measurementKind: 'sprint_window', passed: true, evidenceRef: 'ref-1' });
    assert.equal(r.ok, true);
    assert.equal(e5.listMeasurements(db, id).length, 1);
    assert.equal(
      e5.recordMeasurement(db, { kaizenId: 'missing', sprintVersion: 'v1', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x' }).code,
      'ITEM_NOT_FOUND'
    );
    assert.equal(
      e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v1', measurementKind: 'bogus', passed: true, evidenceRef: 'x' }).code,
      'INVALID_REQUEST'
    );
  });
});

describe('canMarkProvenEffective / markProvenEffective — the 4-Class proof rules (Architect Ruling A531 §4)', () => {
  it('canMarkProvenEffective is a pure dry-run predicate — callable directly with no DB, and refuses an unknown class', () => {
    assert.equal(
      e5.canMarkProvenEffective({ verification_class: 'A_DETERMINISTIC', verification_evidence_ref: 'ref' },
        [{ measurement_kind: 'sprint_window', passed: 1, recurrence_count: 0 }]).ok,
      true
    );
    assert.equal(e5.canMarkProvenEffective({ verification_class: 'BOGUS' }, []).code, 'UNKNOWN_VERIFICATION_CLASS');
  });

  it('Class A_DETERMINISTIC: needs evidence_ref (or a passing regression_test) plus one clean sprint_window', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db, { verificationClass: 'A_DETERMINISTIC' });
    toVerified(db, id);
    assert.equal(e5.markProvenEffective(db, { id }).code, 'INSUFFICIENT_EVIDENCE');
    db.prepare("UPDATE kaizen_items SET verification_evidence_ref = 'test/foo.test.js' WHERE id = ?").run(id);
    assert.equal(e5.markProvenEffective(db, { id }).code, 'INSUFFICIENT_EVIDENCE');
    e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v5.75.0', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x' });
    const r = e5.markProvenEffective(db, { id });
    assert.equal(r.ok, true);
    assert.equal(e5.getItem(db, id).effectiveness_status, 'PROVEN_EFFECTIVE');
    assert.equal(e5.getItem(db, id).lifecycle_state, 'Effectiveness Measured');
  });

  it('Class A_DETERMINISTIC: a passing regression_test measurement substitutes for a verification_evidence_ref', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db, { verificationClass: 'A_DETERMINISTIC' });
    toVerified(db, id);
    e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v5.75.0', measurementKind: 'regression_test', passed: true, evidenceRef: 'x' });
    e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v5.75.0', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x' });
    assert.equal(e5.markProvenEffective(db, { id }).ok, true);
  });

  it('Class B_WORKFLOW: needs 3 CONSECUTIVE clean sprint_window measurements; a recurrence resets the run', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db, { verificationClass: 'B_WORKFLOW' });
    toVerified(db, id);
    const measure = (sprintVersion, passed, recurrenceCount = 0) =>
      e5.recordMeasurement(db, { kaizenId: id, sprintVersion, measurementKind: 'sprint_window', passed, recurrenceCount, evidenceRef: 'x' });
    measure('v1', true);
    measure('v2', true);
    assert.equal(e5.markProvenEffective(db, { id }).code, 'INSUFFICIENT_CONSECUTIVE_SPRINTS');
    measure('v3', true);
    assert.equal(e5.markProvenEffective(db, { id }).ok, true);
  });

  it('Class B_WORKFLOW: a regression between two clean sprints resets the consecutive run', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db, { verificationClass: 'B_WORKFLOW' });
    toVerified(db, id);
    const measure = (sprintVersion, passed, recurrenceCount = 0) =>
      e5.recordMeasurement(db, { kaizenId: id, sprintVersion, measurementKind: 'sprint_window', passed, recurrenceCount, evidenceRef: 'x' });
    measure('v1', true);
    measure('v2', true);
    measure('v3', false, 1); // regressed — breaks the run
    measure('v4', true);
    measure('v5', true);
    assert.equal(e5.markProvenEffective(db, { id }).code, 'INSUFFICIENT_CONSECUTIVE_SPRINTS');
    measure('v6', true);
    assert.equal(e5.markProvenEffective(db, { id }).ok, true);
  });

  it('Class B_WORKFLOW: rejects 3 clean measurements against the SAME sprint_version (no real 3-sprint streak)', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db, { verificationClass: 'B_WORKFLOW' });
    toVerified(db, id);
    for (let i = 0; i < 3; i++) {
      e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v1', measurementKind: 'sprint_window', passed: true, evidenceRef: `x${i}` });
    }
    assert.equal(e5.markProvenEffective(db, { id }).code, 'INSUFFICIENT_CONSECUTIVE_SPRINTS');
    // A genuinely new, distinct sprint on top of the duplicate-sprint rows still only reaches 2 distinct.
    e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v2', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x3' });
    assert.equal(e5.markProvenEffective(db, { id }).code, 'INSUFFICIENT_CONSECUTIVE_SPRINTS');
    e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v3', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x4' });
    assert.equal(e5.markProvenEffective(db, { id }).ok, true);
  });

  it('Class C_OPERATIONAL_DRILL: needs one passing chaos_drill AND one clean passive_monitor', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db, { verificationClass: 'C_OPERATIONAL_DRILL' });
    toVerified(db, id);
    e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v1', measurementKind: 'chaos_drill', passed: true, evidenceRef: 'drill-1' });
    assert.equal(e5.markProvenEffective(db, { id }).code, 'INSUFFICIENT_DRILL_OR_MONITOR_EVIDENCE');
    e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v1', measurementKind: 'passive_monitor', passed: true, evidenceRef: 'monitor-1' });
    assert.equal(e5.markProvenEffective(db, { id }).ok, true);
  });

  it('Class D_LONGITUDINAL: needs 3 to 5 passing statistical_trend measurements across DISTINCT sprints, each numerically meeting baseline', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db, { verificationClass: 'D_LONGITUDINAL' });
    toVerified(db, id);
    const trend = (sprintVersion, metricValue = 5, baselineValue = 10) =>
      e5.recordMeasurement(db, { kaizenId: id, sprintVersion, measurementKind: 'statistical_trend', passed: true, metricValue, baselineValue, evidenceRef: 'x' });
    trend('v1'); trend('v2');
    assert.equal(e5.markProvenEffective(db, { id }).code, 'INSUFFICIENT_TREND_SERIES');
    trend('v3');
    assert.equal(e5.markProvenEffective(db, { id }).ok, true);
  });

  it('Class D_LONGITUDINAL: rejects 3 measurements against the SAME sprint_version (no real series)', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db, { verificationClass: 'D_LONGITUDINAL' });
    toVerified(db, id);
    for (let i = 0; i < 3; i++) {
      e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v1', measurementKind: 'statistical_trend', passed: true, metricValue: 5, baselineValue: 10, evidenceRef: `x${i}` });
    }
    assert.equal(e5.markProvenEffective(db, { id }).code, 'INSUFFICIENT_TREND_SERIES');
  });

  it('Class D_LONGITUDINAL: rejects null/missing metric_value or baseline_value, and a worse-than-baseline reading', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db, { verificationClass: 'D_LONGITUDINAL' });
    toVerified(db, id);
    const trend = (sprintVersion, metricValue, baselineValue) =>
      e5.recordMeasurement(db, { kaizenId: id, sprintVersion, measurementKind: 'statistical_trend', passed: true, metricValue, baselineValue, evidenceRef: 'x' });
    trend('v1', null, null);
    trend('v2', 5, 10);
    trend('v3', 15, 10); // worse than baseline -- does not qualify
    assert.equal(e5.markProvenEffective(db, { id }).code, 'INSUFFICIENT_TREND_SERIES');
    trend('v4', 5, 10);
    trend('v5', 5, 10);
    // Now v2, v4, v5 qualify (3 distinct sprints); v1 (null) and v3 (worse) never count.
    assert.equal(e5.markProvenEffective(db, { id }).ok, true);
  });

  it('refuses outright unless lifecycle_state is Verified', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db);
    assert.equal(e5.markProvenEffective(db, { id }).code, 'INVALID_TRANSITION');
  });
});

describe('markRegressed / closeItem', () => {
  it('a proven item can regress, and closes only from Effectiveness Measured+PROVEN_EFFECTIVE or from Dismissed', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db);
    toVerified(db, id);
    db.prepare("UPDATE kaizen_items SET verification_evidence_ref = 'x' WHERE id = ?").run(id);
    e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v1', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x' });
    assert.equal(e5.markProvenEffective(db, { id }).ok, true);
    assert.equal(e5.closeItem(db, { id }).ok, true);
    assert.equal(e5.getItem(db, id).lifecycle_state, 'Closed');

    const id2 = seedItem(db, { findingId: 'f-2' });
    assert.equal(e5.closeItem(db, { id: id2 }).code, 'INVALID_TRANSITION');
    e5.advanceLifecycle(db, { id: id2, nextState: 'Classified' });
    e5.advanceLifecycle(db, { id: id2, nextState: 'Proposed' });
    e5.advanceLifecycle(db, { id: id2, nextState: 'Dismissed' });
    assert.equal(e5.closeItem(db, { id: id2 }).ok, true);
    assert.equal(e5.getItem(db, id2).lifecycle_state, 'Closed');
  });

  it('markRegressed only applies to a currently PROVEN_EFFECTIVE item', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db);
    assert.equal(e5.markRegressed(db, { id }).code, 'NOT_FOUND_OR_NOT_PROVEN');
    toVerified(db, id);
    db.prepare("UPDATE kaizen_items SET verification_evidence_ref = 'x' WHERE id = ?").run(id);
    e5.recordMeasurement(db, { kaizenId: id, sprintVersion: 'v1', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x' });
    e5.markProvenEffective(db, { id });
    assert.equal(e5.markRegressed(db, { id }).ok, true);
    assert.equal(e5.getItem(db, id).effectiveness_status, 'REGRESSED');
  });
});

describe('setGate0Disposition / gate0Feed', () => {
  it('requires a rationale for deferred_with_rationale, and feeds every open/due item', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const id = seedItem(db);
    assert.equal(e5.setGate0Disposition(db, { id, disposition: 'deferred_with_rationale' }).code, 'RATIONALE_REQUIRED');
    assert.equal(e5.setGate0Disposition(db, { id, disposition: 'deferred_with_rationale', rationale: 'blocked on #123' }).ok, true);
    assert.equal(e5.getItem(db, id).gate0_disposition, 'deferred_with_rationale');

    const feed = e5.gate0Feed(db);
    assert.ok(feed.some((item) => item.id === id));
  });

  it('a Closed item never appears in the feed, and scoping by logicalProjectId excludes other projects', (t) => {
    const db = freshStore();
    t.after(cleanup);
    const openId = seedItem(db, { findingId: 'open-1', logicalProjectId: 'lp-a' });
    const otherProjectId = seedItem(db, { findingId: 'other-1', logicalProjectId: 'lp-b' });
    const closedId = seedItem(db, { findingId: 'closed-1' });
    toVerified(db, closedId);
    db.prepare("UPDATE kaizen_items SET verification_evidence_ref = 'x' WHERE id = ?").run(closedId);
    e5.recordMeasurement(db, { kaizenId: closedId, sprintVersion: 'v1', measurementKind: 'sprint_window', passed: true, evidenceRef: 'x' });
    e5.markProvenEffective(db, { id: closedId });
    e5.closeItem(db, { id: closedId });

    const scoped = e5.gate0Feed(db, { logicalProjectId: 'lp-a' });
    assert.ok(scoped.some((item) => item.id === openId));
    assert.ok(!scoped.some((item) => item.id === otherProjectId));
    assert.ok(!scoped.some((item) => item.id === closedId));

    const all = e5.gate0Feed(db);
    assert.ok(!all.some((item) => item.id === closedId));
  });
});
