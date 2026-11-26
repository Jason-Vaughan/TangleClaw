'use strict';

/**
 * The Kaizen & Reports workspace tab's viewer (#3266, V6-017/V6-034, Car
 * V665-W1-B) — `public/v6-kaizen-reports-view.js`. Small tier: pure
 * markup-string functions, no subprocess, no database, no socket.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const view = require('../public/v6-kaizen-reports-view');
const { evaluateReportGate } = require('../lib/sprint-report-gate');

const SETTLED_HTML = `<html><body>
  <section id="postmortem">
    <ul id="postmortem-what-worked"><li>Shipped on time</li></ul>
    <ul id="postmortem-what-didnt"><li>One flaky test</li></ul>
    <table id="postmortem-rule-283"><tr data-status="pass"></tr></table>
  </section>
</body></html>`;

describe('versionPickerMarkup', () => {
  it('renders one option per catalog entry, with its kind label', () => {
    const catalog = [
      { id: 'v6.6.1', version: 'v6.6.1', title: 'v6.6.1 Sprint Report', url: '/v6.6.1/', kind: 'report' },
      { id: 'v6.6.1-v6.6.5', version: null, title: 'v6.6.1-v6.6.5 Retrospective', url: '/retro/', kind: 'retrospective' }
    ];
    const html = view.versionPickerMarkup(catalog, null);
    assert.match(html, /<option value="v6\.6\.1">v6\.6\.1 Sprint Report \(Sprint Report\)<\/option>/);
    assert.match(html, /<option value="v6\.6\.1-v6\.6\.5">v6\.6\.1-v6\.6\.5 Retrospective \(Train Retrospective\)<\/option>/);
  });

  it('marks the selected entry', () => {
    const catalog = [{ id: 'a', version: 'a', title: 'A', url: null, kind: 'report' }, { id: 'b', version: 'b', title: 'B', url: null, kind: 'report' }];
    const html = view.versionPickerMarkup(catalog, 'b');
    assert.match(html, /<option value="b" selected>/);
    assert.doesNotMatch(html, /<option value="a" selected>/);
  });

  it('shows an empty-state message for an empty or missing catalog', () => {
    assert.match(view.versionPickerMarkup([], null), /No sprint reports are published yet\./);
    assert.match(view.versionPickerMarkup(null, null), /No sprint reports are published yet\./);
  });

  it('escapes a title containing HTML', () => {
    const html = view.versionPickerMarkup([{ id: 'x', version: 'x', title: '<script>alert(1)</script>', url: null, kind: 'report' }], null);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('reportContentMarkup', () => {
  it('shows a placeholder when nothing has been evaluated yet', () => {
    assert.match(view.reportContentMarkup(null), /Choose a report above to view it\./);
  });

  it('shows the gate\'s own reason when the report has not settled (or none was found)', () => {
    const notFound = evaluateReportGate({ scope: 'version', id: 'v6.6.1', mandatory: true, reportHtml: null });
    assert.match(view.reportContentMarkup(notFound), /no report found/);

    const unsettled = evaluateReportGate({ scope: 'version', id: 'v6.6.1', mandatory: true, reportHtml: '<!-- AUTO_GENERATED_LIVE_SPRINT_REPORT -->' });
    assert.match(view.reportContentMarkup(unsettled), /still carries the live-tracker placeholder/);
  });

  it('shows the gate\'s own reason even when it PASSED with no settlement at all (not mandatory, or an exception)', () => {
    const notMandatory = evaluateReportGate({ scope: 'version', id: 'v6.6.1', mandatory: false });
    assert.equal(notMandatory.passed, true);
    assert.match(view.reportContentMarkup(notMandatory), /not mandatory under the configured policy/);

    const excepted = evaluateReportGate({
      scope: 'version', id: 'v6.6.1', mandatory: true,
      operatorException: { grantedBy: 'Jason', reason: 'backfilling later', at: '2026-11-26T00:00:00Z' }
    });
    assert.equal(excepted.passed, true);
    assert.match(view.reportContentMarkup(excepted), /operator-authorized exception: backfilling later/);
  });

  it('renders what-worked, what-didn\'t and the Rule #283 pass count for a settled report', () => {
    const gateResult = evaluateReportGate({ scope: 'version', id: 'v6.6.1', mandatory: true, reportHtml: SETTLED_HTML });
    const html = view.reportContentMarkup(gateResult);
    assert.match(html, /<li>Shipped on time<\/li>/);
    assert.match(html, /<li>One flaky test<\/li>/);
    assert.match(html, /Rule #283: 1 passing/);
  });

  it('shows "nothing recorded" for an empty what-worked/what-didn\'t list', () => {
    const emptyPostmortem = '<html><body><section id="postmortem"></section></body></html>';
    const gateResult = evaluateReportGate({ scope: 'version', id: 'v6.6.1', mandatory: true, reportHtml: emptyPostmortem });
    const html = view.reportContentMarkup(gateResult);
    assert.match(html, /Nothing recorded\./);
  });
});

describe('kaizenLedgerMarkup / kaizenItemMarkup', () => {
  const item = {
    id: 'kz_1', origin_sprint: 'v6.5.9', finding_id: '#3213', defect_category: 'single-stream-drift',
    corrective_action_spec: 'Add the parallelization guard', owner_role: 'TC-Lane-B', lifecycle_state: 'Detected',
    effectiveness_status: 'UNVERIFIED', linked_issue_id: 3213
  };

  it('renders one card per item with its lifecycle state as a CSS modifier', () => {
    const html = view.kaizenLedgerMarkup([item]);
    assert.match(html, /class="v6-kaizen-item is-detected"/);
    assert.match(html, /data-kaizen-id="kz_1"/);
    assert.match(html, /single-stream-drift/);
    assert.match(html, /#3213/);
  });

  it('kebab-cases a multi-word lifecycle state for the CSS modifier', () => {
    const html = view.kaizenItemMarkup({ ...item, lifecycle_state: 'Effectiveness Measured' });
    assert.match(html, /class="v6-kaizen-item is-effectiveness-measured"/);
  });

  it('omits the issue badge when linked_issue_id is null', () => {
    const html = view.kaizenItemMarkup({ ...item, linked_issue_id: null });
    assert.doesNotMatch(html, /v6-kaizen-item-issue/);
  });

  it('shows an empty-state message for an empty or missing item list', () => {
    assert.match(view.kaizenLedgerMarkup([]), /No Kaizen items recorded\./);
    assert.match(view.kaizenLedgerMarkup(null), /No Kaizen items recorded\./);
  });

  it('escapes a corrective action spec containing HTML', () => {
    const html = view.kaizenItemMarkup({ ...item, corrective_action_spec: '<img src=x onerror=alert(1)>' });
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img/);
  });
});

describe('escapeHtml', () => {
  it('escapes every reserved character and treats null/undefined as empty', () => {
    assert.equal(view.escapeHtml('<a href="x">\'&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.equal(view.escapeHtml(null), '');
    assert.equal(view.escapeHtml(undefined), '');
  });
});
