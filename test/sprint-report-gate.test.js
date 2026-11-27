'use strict';

/**
 * Mandatory Sprint Reports policy & Gate 4 completion gate (#3266, V6-017,
 * Car V665-W1-B) — `lib/sprint-report-gate.js`, against real HTML shapes
 * `lib/native-sprint-tracker.js#parseSprintReportSettlement` actually
 * parses, not a mocked settlement result. Small tier: pure logic.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const {
  SprintReportGateError, evaluateReportGate, evaluateTrainGate,
  extractKaizenFindings, ingestKaizenFromReport, settleReportGate
} = require('../lib/sprint-report-gate');
const store = require('../lib/store');
const e5 = require('../lib/v6/e5-kaizen-ledger');

const UNSETTLED_HTML = '<!-- AUTO_GENERATED_LIVE_SPRINT_REPORT --><html><body>Sprint v6.6.1 in progress</body></html>';

const SETTLED_HTML = `<html><body>
  <section id="postmortem">
    <ul id="postmortem-what-worked"><li>Shipped on time</li></ul>
    <ul id="postmortem-what-didnt"><li>One flaky test</li></ul>
    <table id="postmortem-rule-283"><tr data-status="pass"></tr><tr data-status="pass"></tr></table>
  </section>
</body></html>`;

/** The REAL `TangleClaw-Shared/sprint-reports/` generator's own postmortem shape (#3324). */
const REAL_SHAPE_HTML = `<html><body>
  <section id="postmortem">
    <div class="grid-2">
      <div>
        <div class="pm-item">
          <h4>1. Deterministic Pre-Sprint Fleet Reset</h4>
          <p>All 10 fleet clones verified on clean main.</p>
        </div>
      </div>
      <div>
        <div class="pm-item warn">
          <h4>1. Per-Version Chartering</h4>
          <p>Each version authors its own charter. <strong>Fix / Guardrail:</strong> Gate 0/Gate 4 enforces a co-signed charter.</p>
        </div>
      </div>
    </div>
  </section>
</body></html>`;

/** @returns {import('node:sqlite').DatabaseSync} */
function freshStore() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sprint-report-gate-'));
  store._setBasePath(tmpDir);
  store.init();
  return { db: store.getDb(), tmpDir };
}

function cleanup(tmpDir) {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('evaluateReportGate (#3266)', () => {
  it('passes when not mandatory, with no settlement check at all', () => {
    const result = evaluateReportGate({ scope: 'version', id: 'v6.6.1', mandatory: false, reportHtml: UNSETTLED_HTML });
    assert.equal(result.passed, true);
    assert.equal(result.settlement, null);
    assert.equal(result.exceptionApplied, false);
    assert.match(result.reason, /not mandatory/);
  });

  it('passes on a valid operator exception, without even looking at reportHtml', () => {
    const result = evaluateReportGate({
      scope: 'version', id: 'v6.6.1', mandatory: true, reportHtml: UNSETTLED_HTML,
      operatorException: { grantedBy: 'Jason', reason: 'shipped under time pressure, backfilling next week', at: '2026-11-26T00:00:00Z' }
    });
    assert.equal(result.passed, true);
    assert.equal(result.exceptionApplied, true);
    assert.match(result.reason, /operator-authorized exception: shipped under time pressure/);
  });

  for (const [name, exception] of [
    ['missing entirely', undefined],
    ['null', null],
    ['empty grantedBy', { grantedBy: '', reason: 'x', at: '2026-11-26T00:00:00Z' }],
    ['whitespace-only reason', { grantedBy: 'x', reason: '   ', at: '2026-11-26T00:00:00Z' }],
    ['unparseable at', { grantedBy: 'x', reason: 'y', at: 'not-a-date' }],
    ['not an object', 'approved']
  ]) {
    it(`does not grant an exception that is ${name} -- falls through to the real settlement check`, () => {
      const result = evaluateReportGate({ scope: 'version', id: 'v6.6.1', mandatory: true, reportHtml: SETTLED_HTML, operatorException: exception });
      assert.equal(result.exceptionApplied, false);
      assert.equal(result.passed, true); // SETTLED_HTML genuinely settles, independent of the rejected exception
    });
  }

  it('fails when mandatory and no report exists at all', () => {
    for (const reportHtml of [undefined, null, '']) {
      const result = evaluateReportGate({ scope: 'version', id: 'v6.6.1', mandatory: true, reportHtml });
      assert.equal(result.passed, false);
      assert.equal(result.settlement, null);
      assert.match(result.reason, /no report found/);
    }
  });

  it('fails when mandatory and the report still carries the live-tracker placeholder', () => {
    const result = evaluateReportGate({ scope: 'version', id: 'v6.6.1', mandatory: true, reportHtml: UNSETTLED_HTML });
    assert.equal(result.passed, false);
    assert.equal(result.settlement.settled, false);
    assert.match(result.reason, /still carries the live-tracker placeholder/);
  });

  it('passes when mandatory and the report has genuinely settled, using the REAL settlement parser', () => {
    const result = evaluateReportGate({ scope: 'version', id: 'v6.6.1', mandatory: true, reportHtml: SETTLED_HTML });
    assert.equal(result.passed, true);
    assert.equal(result.settlement.settled, true);
    assert.deepEqual(result.settlement.postMortem.whatWorked, ['Shipped on time']);
    assert.equal(result.settlement.postMortem.rule283PassCount, 2);
  });

  it('carries destinations through untouched, defaulting to an empty array', () => {
    const withDest = evaluateReportGate({ scope: 'version', id: 'v6.6.1', mandatory: false, destinations: ['gh-pages', 'internal-hub'] });
    assert.deepEqual(withDest.destinations, ['gh-pages', 'internal-hub']);
    const withoutDest = evaluateReportGate({ scope: 'version', id: 'v6.6.1', mandatory: false });
    assert.deepEqual(withoutDest.destinations, []);
  });

  it('accepts scope "train" as well as "version"', () => {
    const result = evaluateReportGate({ scope: 'train', id: 'v6.6.1-v6.6.5', mandatory: true, reportHtml: SETTLED_HTML });
    assert.equal(result.scope, 'train');
    assert.equal(result.passed, true);
  });

  for (const [name, input, code] of [
    ['missing scope', { id: 'x', mandatory: true }, 'SCOPE_INVALID'],
    ['invalid scope', { scope: 'fleet', id: 'x', mandatory: true }, 'SCOPE_INVALID'],
    ['missing id', { scope: 'version', mandatory: true }, 'ID_REQUIRED'],
    ['empty id', { scope: 'version', id: '  ', mandatory: true }, 'ID_REQUIRED'],
    ['non-boolean mandatory', { scope: 'version', id: 'x', mandatory: 'yes' }, 'MANDATORY_INVALID'],
    ['non-array destinations', { scope: 'version', id: 'x', mandatory: false, destinations: 'gh-pages' }, 'DESTINATIONS_INVALID'],
    ['destinations with an empty entry', { scope: 'version', id: 'x', mandatory: false, destinations: [''] }, 'DESTINATIONS_INVALID']
  ]) {
    it(`refuses a malformed input: ${name}`, () => {
      assert.throws(() => evaluateReportGate(input), (err) => err instanceof SprintReportGateError && err.code === code);
    });
  }
});

describe('evaluateTrainGate (#3266)', () => {
  it('passes only when every version AND the train retrospective pass', () => {
    const result = evaluateTrainGate({
      versions: [
        { id: 'v6.6.1', mandatory: true, reportHtml: SETTLED_HTML },
        { id: 'v6.6.2', mandatory: true, reportHtml: SETTLED_HTML }
      ],
      trainRetrospective: { id: 'v6.6.1-v6.6.5', mandatory: true, reportHtml: SETTLED_HTML }
    });
    assert.equal(result.passed, true);
    assert.equal(result.versions.length, 2);
    assert.equal(result.trainRetrospective.passed, true);
  });

  it('fails, and names exactly which version, when one version in the train has not settled', () => {
    const result = evaluateTrainGate({
      versions: [
        { id: 'v6.6.1', mandatory: true, reportHtml: SETTLED_HTML },
        { id: 'v6.6.2', mandatory: true, reportHtml: UNSETTLED_HTML }
      ]
    });
    assert.equal(result.passed, false);
    assert.equal(result.versions[0].passed, true);
    assert.equal(result.versions[1].passed, false);
    assert.equal(result.versions[1].id, 'v6.6.2');
  });

  it('fails when every version passes but the train retrospective itself has not settled', () => {
    const result = evaluateTrainGate({
      versions: [{ id: 'v6.6.1', mandatory: true, reportHtml: SETTLED_HTML }],
      trainRetrospective: { id: 'v6.6.1-v6.6.5', mandatory: true, reportHtml: UNSETTLED_HTML }
    });
    assert.equal(result.passed, false);
    assert.equal(result.trainRetrospective.passed, false);
  });

  it('is unaffected by trainRetrospective being omitted entirely', () => {
    const result = evaluateTrainGate({ versions: [{ id: 'v6.6.1', mandatory: true, reportHtml: SETTLED_HTML }] });
    assert.equal(result.passed, true);
    assert.equal(result.trainRetrospective, null);
  });

  it('refuses an empty or missing versions array', () => {
    assert.throws(() => evaluateTrainGate({ versions: [] }), (err) => err instanceof SprintReportGateError && err.code === 'VERSIONS_REQUIRED');
    assert.throws(() => evaluateTrainGate({}), (err) => err instanceof SprintReportGateError && err.code === 'VERSIONS_REQUIRED');
  });
});

describe('extractKaizenFindings (#3324 AC#1)', () => {
  it('extracts synthetic-shape <li> points, preserve before improve, in document order', () => {
    const findings = extractKaizenFindings(SETTLED_HTML);
    assert.deepEqual(findings.map((f) => f.category), ['preserve', 'improve']);
    assert.equal(findings[0].title, 'Shipped on time');
    assert.equal(findings[1].title, 'One flaky test');
    for (const f of findings) assert.equal(f.kaizenId, null);
  });

  it('extracts real-shape .pm-item/.pm-item.warn divs, stripping the leading "N. " from the title', () => {
    const findings = extractKaizenFindings(REAL_SHAPE_HTML);
    assert.deepEqual(findings.map((f) => f.category), ['preserve', 'improve']);
    assert.equal(findings[0].title, 'Deterministic Pre-Sprint Fleet Reset');
    assert.match(findings[0].body, /All 10 fleet clones/);
    assert.equal(findings[1].title, 'Per-Version Chartering');
  });

  it('pulls the "Fix / Guardrail:" callout into correctiveActionSpec when present, else leaves it null', () => {
    const findings = extractKaizenFindings(REAL_SHAPE_HTML);
    assert.equal(findings[0].correctiveActionSpec, null);
    assert.equal(findings[1].correctiveActionSpec, 'Gate 0/Gate 4 enforces a co-signed charter.');
  });

  it('honors an explicit data-kaizen-id/data-kaizen-class tag when the report carries one', () => {
    const tagged = REAL_SHAPE_HTML.replace('<div class="pm-item">', '<div class="pm-item" data-kaizen-id="KZ-v665-07" data-kaizen-class="C_OPERATIONAL_DRILL">');
    const findings = extractKaizenFindings(tagged);
    assert.equal(findings[0].kaizenId, 'KZ-v665-07');
    assert.equal(findings[0].verificationClass, 'C_OPERATIONAL_DRILL');
  });

  it('returns an empty array for an unsettled report with no postmortem content', () => {
    assert.deepEqual(extractKaizenFindings(UNSETTLED_HTML), []);
  });
});

describe('ingestKaizenFromReport (#3324 AC#1)', () => {
  it('upserts each finding into kaizen_items, auto-numbering KZ-<ver>-NN when untagged', (t) => {
    const { db, tmpDir } = freshStore();
    t.after(() => cleanup(tmpDir));
    const result = ingestKaizenFromReport(db, { reportHtml: SETTLED_HTML, originSprint: 'v6.6.5' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ingested.map((i) => i.findingId), ['KZ-v665-01', 'KZ-v665-02']);
    assert.deepEqual(result.skipped, []);
    const stored = e5.listByOriginSprint(db, 'v6.6.5');
    assert.equal(stored.length, 2);
    assert.equal(stored[0].gate0_disposition, 'unreviewed');
    assert.equal(stored[0].defect_category, 'preserve');
    assert.equal(stored[1].defect_category, 'improve');
  });

  it('reserves an explicit id before auto-numbering, so a following untagged finding never collides with it (R-Gate R1 BLOCKING, PR #3337)', (t) => {
    const { db, tmpDir } = freshStore();
    t.after(() => cleanup(tmpDir));
    // The first (preserve) finding is explicitly tagged with exactly the id
    // auto-numbering would otherwise generate for the SECOND (untagged,
    // improve) finding -- the precise collision the finding reports: an
    // explicit KZ-v665-01 followed by an untagged finding that would also
    // generate KZ-v665-01, silently dropping the second finding once the
    // first's id is already in `already`.
    const tagged = REAL_SHAPE_HTML.replace('<div class="pm-item">', '<div class="pm-item" data-kaizen-id="KZ-v665-01">');
    const result = ingestKaizenFromReport(db, { reportHtml: tagged, originSprint: 'v6.6.5' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ingested.map((i) => i.findingId), ['KZ-v665-01', 'KZ-v665-02']);
    assert.deepEqual(result.skipped, [], 'the untagged finding must not be silently dropped');
    const stored = e5.listByOriginSprint(db, 'v6.6.5');
    assert.equal(stored.length, 2, 'both findings must be recorded, not just the explicitly tagged one');
    assert.deepEqual(stored.map((s) => s.finding_id).sort(), ['KZ-v665-01', 'KZ-v665-02']);
  });

  it('is idempotent: settling the same report twice never duplicates a row', (t) => {
    const { db, tmpDir } = freshStore();
    t.after(() => cleanup(tmpDir));
    ingestKaizenFromReport(db, { reportHtml: SETTLED_HTML, originSprint: 'v6.6.5' });
    const second = ingestKaizenFromReport(db, { reportHtml: SETTLED_HTML, originSprint: 'v6.6.5' });
    assert.equal(second.ingested.length, 0);
    assert.deepEqual(second.skipped, ['KZ-v665-01', 'KZ-v665-02']);
    assert.equal(e5.listByOriginSprint(db, 'v6.6.5').length, 2);
  });

  it('uses the real-shape "Fix / Guardrail:" text as correctiveActionSpec, and a preserve-guardrail default otherwise', (t) => {
    const { db, tmpDir } = freshStore();
    t.after(() => cleanup(tmpDir));
    ingestKaizenFromReport(db, { reportHtml: REAL_SHAPE_HTML, originSprint: 'v6.6.5' });
    const stored = e5.listByOriginSprint(db, 'v6.6.5');
    assert.match(stored[0].corrective_action_spec, /Preserve as an active guardrail/);
    assert.equal(stored[1].corrective_action_spec, 'Gate 0/Gate 4 enforces a co-signed charter.');
  });

  it('scopes by logicalProjectId when given', (t) => {
    const { db, tmpDir } = freshStore();
    t.after(() => cleanup(tmpDir));
    ingestKaizenFromReport(db, { reportHtml: SETTLED_HTML, originSprint: 'v6.6.5', logicalProjectId: 'proj-1' });
    const stored = e5.listByOriginSprint(db, 'v6.6.5');
    assert.ok(stored.every((item) => item.logical_project_id === 'proj-1'));
  });

  it('refuses a missing reportHtml or originSprint', (t) => {
    const { db, tmpDir } = freshStore();
    t.after(() => cleanup(tmpDir));
    assert.throws(() => ingestKaizenFromReport(db, { originSprint: 'v6.6.5' }),
      (err) => err instanceof SprintReportGateError && err.code === 'REPORT_HTML_REQUIRED');
    assert.throws(() => ingestKaizenFromReport(db, { reportHtml: SETTLED_HTML }),
      (err) => err instanceof SprintReportGateError && err.code === 'ORIGIN_SPRINT_REQUIRED');
  });
});

describe('settleReportGate (#3324 AC#1)', () => {
  it('ingests Kaizen findings only when the gate genuinely passes on a settled report', (t) => {
    const { db, tmpDir } = freshStore();
    t.after(() => cleanup(tmpDir));
    const result = settleReportGate(db, { scope: 'version', id: 'v6.6.5', mandatory: true, reportHtml: SETTLED_HTML });
    assert.equal(result.passed, true);
    assert.equal(result.kaizenIngestion.ingested.length, 2);
    assert.equal(e5.listByOriginSprint(db, 'v6.6.5').length, 2);
  });

  it('never ingests when the report has not settled', (t) => {
    const { db, tmpDir } = freshStore();
    t.after(() => cleanup(tmpDir));
    const result = settleReportGate(db, { scope: 'version', id: 'v6.6.1', mandatory: true, reportHtml: UNSETTLED_HTML });
    assert.equal(result.passed, false);
    assert.equal(result.kaizenIngestion, null);
    assert.equal(e5.listByOriginSprint(db, 'v6.6.1').length, 0);
  });

  it('never ingests when the gate passes only because it is not mandatory (no real settlement)', (t) => {
    const { db, tmpDir } = freshStore();
    t.after(() => cleanup(tmpDir));
    const result = settleReportGate(db, { scope: 'version', id: 'v6.6.1', mandatory: false, reportHtml: SETTLED_HTML });
    assert.equal(result.passed, true);
    assert.equal(result.kaizenIngestion, null);
  });
});

describe('SprintReportGateError', () => {
  it('carries code, status and detail', () => {
    const err = new SprintReportGateError('SOME_CODE', 'a message', 404, { x: 1 });
    assert.equal(err.name, 'SprintReportGateError');
    assert.equal(err.code, 'SOME_CODE');
    assert.equal(err.status, 404);
    assert.deepEqual(err.detail, { x: 1 });
    assert.ok(err instanceof Error);
  });

  it('defaults status to 400 when not given', () => {
    const err = new SprintReportGateError('SOME_CODE', 'a message');
    assert.equal(err.status, 400);
  });
});
