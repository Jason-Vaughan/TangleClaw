'use strict';

/**
 * Mandatory Sprint Reports policy & Gate 4 completion gate (#3266, V6-017,
 * Car V665-W1-B) — `lib/sprint-report-gate.js`, against real HTML shapes
 * `lib/native-sprint-tracker.js#parseSprintReportSettlement` actually
 * parses, not a mocked settlement result. Small tier: pure logic.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { SprintReportGateError, evaluateReportGate, evaluateTrainGate } = require('../lib/sprint-report-gate');

const UNSETTLED_HTML = '<!-- AUTO_GENERATED_LIVE_SPRINT_REPORT --><html><body>Sprint v6.6.1 in progress</body></html>';

const SETTLED_HTML = `<html><body>
  <section id="postmortem">
    <ul id="postmortem-what-worked"><li>Shipped on time</li></ul>
    <ul id="postmortem-what-didnt"><li>One flaky test</li></ul>
    <table id="postmortem-rule-283"><tr data-status="pass"></tr><tr data-status="pass"></tr></table>
  </section>
</body></html>`;

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
