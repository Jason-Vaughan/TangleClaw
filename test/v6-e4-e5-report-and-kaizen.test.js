'use strict';

/*
 * #3089: the consolidated train report's render helpers
 * (lib/v6/e4-rich-report-presentation.js) and the Kaizen link check for
 * fast-follow major learnings (lib/v6/e5-kaizen-ledger.js), including that a
 * rendered remark table satisfies the validator's Rule 11.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const e4 = require('../lib/v6/e4-rich-report-presentation');
const e5 = require('../lib/v6/e5-kaizen-ledger');
const v3 = require('../lib/v6/sprint-report-validator-v3');
const tracker = require('../lib/native-sprint-tracker');
const store = require('../lib/store');

const ROUTINE = { version: 'v6.2.2', milestone: 69, prs: [3047], issues: [3046], release_tag: 'v6.2.2', summary_remark: 'Chat polish.', major_learning: false };
const MAJOR = {
  version: 'v6.2.9', milestone: 76, prs: [3080], issues: [3077], release_tag: 'v6.2.9',
  summary_remark: 'Fleet isolation.', major_learning: true, kaizen_id: 'kz', postmortem_ref: 'pm-fleet'
};

describe('#3089 renderFastFollowRemarkTable', () => {
  it('renders one row per entry that Rule 11 accepts when placed in #overview', () => {
    const table = e4.renderFastFollowRemarkTable([ROUTINE, MAJOR]);
    const metrics = {
      schema_version: '3.1.0', version: 'v6.3.0',
      diff: { feature_prs_merged: 1, release_prs_merged: 1, total_repo_prs_merged: 2 },
      durations: { total_run_time_display: '1h 00m 00s' },
      scope_taxonomy: { github_feature_issues_closed: 1, chartered_execution_cars_completed: 1, milestone_issues_deferred_external_gated: 0 },
      release_state: ['code_merged_on_main'],
      economics: { measured_tokens: 1, estimated_tokens: 1, subscription_allocated_cost_usd: 1, api_shadow_cost_usd: 1 },
      provenance: { generated_at: 'x', verified_at: 'x', canonical_source_sha256: 'x', git_main_head_sha: 'x', validator_version: '3.1.0' },
      fast_follow_subversions: [ROUTINE, MAJOR]
    };
    const sections = v3.CANONICAL_SECTIONS.map((id) => {
      if (id === 'overview') return `<section id="overview">${table}</section>`;
      if (id === 'postmortem') return '<section id="postmortem"><h3 id="pm-fleet">Fleet isolation</h3></section>';
      return `<section id="${id}"><p>x</p></section>`;
    }).join('');
    const html = `<html><body><script type="application/json" id="tc-canonical-metrics">${JSON.stringify(metrics)}</script>${sections}</body></html>`;
    assert.deepEqual(v3.validateReport(html).findings.filter((f) => f.rule === 11), []);
    assert.match(table, /<a href="#pm-fleet">Major learning<\/a>/);
    assert.match(table, /<td>#3047<\/td>/);
  });

  it('escapes every value, and never links an unsafe postmortem_ref', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const table = e4.renderFastFollowRemarkTable([{
      version: hostile, release_tag: hostile, prs: [hostile], issues: [], summary_remark: `"${hostile}"`,
      major_learning: true, postmortem_ref: '" onmouseover="x'
    }]);
    assert.ok(!table.includes('<img'), 'no markup from data');
    assert.ok(!table.includes('onmouseover="'), 'no attribute breakout');
    assert.match(table, /<td>Major learning<\/td>/, 'an unsafe ref is shown unlinked');
    assert.match(table, /&quot;&lt;img/, 'quotes are escaped too');
  });

  it('refuses a non-array', () => {
    assert.throws(() => e4.renderFastFollowRemarkTable(null), TypeError);
  });
});

describe('#3089 renderConsolidatedTrainSummary', () => {
  const econ = (m) => ({ measured_tokens: m, estimated_tokens: 1, subscription_allocated_cost_usd: 0.5, api_shadow_cost_usd: 2 });

  it('renders the rows and the totals the summary computed, plus the fast-follow table', () => {
    const summary = tracker.buildConsolidatedTrainReportSummary(['v6.2.9', 'v6.3.0'], {
      'v6.2.9': { pullRequests: [{}], economics: econ(10), fastFollowSubversions: [ROUTINE] },
      'v6.3.0': { pullRequests: [{}, {}], economics: econ(20) }
    });
    const html = e4.renderConsolidatedTrainSummary(summary);
    assert.match(html, /<tr><td><code>v6\.2\.9<\/code><\/td><td>1<\/td><td>0<\/td><td>10<\/td>/);
    assert.match(html, /<tr class="train-total"><th>Total<\/th><td>3<\/td><td>0<\/td><td>30<\/td><td>2<\/td><td>1<\/td><td>4<\/td><\/tr>/);
    assert.match(html, /class="fast-follow-subversions"/);
  });

  it('says what it could not count, and shows an unknown total as a dash, never 0', () => {
    const summary = tracker.buildConsolidatedTrainReportSummary(['v6.2.8', 'v6.2.9'], { 'v6.2.9': { pullRequests: [] } });
    const html = e4.renderConsolidatedTrainSummary(summary);
    assert.match(html, /No sprint data for <code>v6\.2\.8<\/code>; not counted\./);
    assert.match(html, /Token economics incomplete for <code>v6\.2\.9<\/code>/);
    assert.match(html, /<th>Total<\/th><td>0<\/td><td>0<\/td><td>—<\/td><td>—<\/td><td>—<\/td><td>—<\/td>/);
    assert.ok(!html.includes('fast-follow-subversions'), 'no empty remark table');
  });

  it('refuses something that is not a consolidated summary', () => {
    assert.throws(() => e4.renderConsolidatedTrainSummary({}), TypeError);
  });
});

describe('#3089 verifyFastFollowKaizenLinks', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-3089-kaizen-'));
    store._setBasePath(tmpDir);
    store.init();
    db = store.getDb();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** @returns {string} A real ledger item's id. */
  function seed() {
    const r = e5.detectItem(db, {
      originSprint: 'v6.2.9', findingId: 'f-1', defectCategory: 'fleet-isolation', rootCause: 'unread registry read as empty',
      correctiveActionSpec: 'fail closed', ownerRole: 'builder', verificationClass: 'A_DETERMINISTIC', targetMetric: 'cross-fleet sends'
    });
    assert.equal(r.ok, true);
    return r.id;
  }

  it('passes a major learning linked to a real ledger item, and skips routine entries', () => {
    const id = seed();
    assert.deepEqual(e5.verifyFastFollowKaizenLinks(db, [ROUTINE, { ...MAJOR, kaizen_id: id }]), { ok: true, checked: 1, missing: [] });
  });

  it('names a major learning whose Kaizen item does not exist, or that names none', () => {
    seed();
    const r = e5.verifyFastFollowKaizenLinks(db, [{ ...MAJOR, kaizen_id: 'no-such-item' }, { ...MAJOR, version: 'v6.2.10', kaizen_id: ' ' }]);
    assert.equal(r.ok, false);
    assert.equal(r.checked, 2);
    assert.deepEqual(r.missing, [{ version: 'v6.2.9', kaizen_id: 'no-such-item' }, { version: 'v6.2.10', kaizen_id: null }]);
  });

  it('refuses a non-array', () => {
    assert.throws(() => e5.verifyFastFollowKaizenLinks(db, null), TypeError);
  });
});
