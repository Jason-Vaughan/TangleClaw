'use strict';

/*
 * #1912, ADR 0020 §10: the dashboard renders the fleet read's composed
 * verdict without re-deriving it. The helpers are lifted out of public/ui.js
 * and run, so the assertions cover the shipped bytes.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
const landing = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');

/**
 * Slice a declaration out of source text by brace-matching.
 * @param {string} src - File source text
 * @param {string} decl - Declaration head
 * @returns {string}
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} must close`);
}

const constStart = ui.indexOf('const WORKLOAD_BADGES = Object.freeze({');
const constEnd = ui.indexOf('});', constStart) + 3;
assert.ok(constStart > -1, 'the badge table must exist');

/**
 * Build the helpers against a given `state`.
 * @param {object} state - Page state with `workload`
 * @returns {{formatWorkloadLine: Function, renderWorkloadBadge: Function, renderWorkloadDetail: Function}}
 */
function helpers(state) {
  const src = [
    liftFunction(landing, 'function esc('),
    ui.slice(constStart, constEnd),
    liftFunction(ui, 'function formatWorkloadLine('),
    liftFunction(ui, 'function renderWorkloadBadge('),
    liftFunction(ui, 'function renderWorkloadDetail(')
  ].join('\n');
  return new Function('state', `${src}\nreturn { formatWorkloadLine, renderWorkloadBadge, renderWorkloadDetail, WORKLOAD_BADGES };`)(state);
}

const lane = (availability, patch = {}) => ({
  projectId: 7,
  composed: { availability, clearance: availability === 'AVAILABLE' ? 'safe-to-clear' : 'do-not-clear', reasons: [] },
  workload: { receipt: { state: 'complete', clearance: 'safe-to-clear', summary: 'Train <2> merged' }, provenance: 'explicit-receipt', ageSeconds: 120 },
  engine: { activity: 'at-rest', reason: 'at-rest' },
  ...patch
});

describe('dashboard workload badge and detail (#1912)', () => {
  it('badges only the states that change the next assignment, with text, never colour alone', () => {
    const shown = { AVAILABLE: 'available', WAITING: 'waiting', BLOCKED: 'blocked', COMPLETE_NOT_CLEAR: 'done, not clear', HELD: 'held', STOPPED: 'stopped' };
    for (const [availability, label] of Object.entries(shown)) {
      const h = helpers({ workload: { 7: lane(availability) } });
      const badge = h.renderWorkloadBadge({ id: 7 });
      assert.match(badge, new RegExp(`>${label}</span>$`), availability);
      assert.match(badge, new RegExp(`badge-workload-${availability.toLowerCase().replace(/_/g, '-')}`));
    }
    for (const availability of ['WORKING', 'UNKNOWN']) {
      assert.equal(helpers({ workload: { 7: lane(availability) } }).renderWorkloadBadge({ id: 7 }), '', availability);
    }
  });

  it('renders nothing for a project with no live lane, or before the first fetch', () => {
    assert.equal(helpers({ workload: {} }).renderWorkloadBadge({ id: 7 }), '');
    assert.equal(helpers({}).renderWorkloadBadge({ id: 7 }), '');
    assert.equal(helpers({}).renderWorkloadDetail({ id: 7 }), '');
  });

  it('the detail row is the same line tc sessions prints, escaped', () => {
    const h = helpers({ workload: { 7: lane('AVAILABLE') } });
    assert.equal(h.renderWorkloadDetail({ id: 7 }),
      'AVAILABLE, safe-to-clear — asserted complete/safe-to-clear, 2m ago: &quot;Train &lt;2&gt; merged&quot;; engine at-rest (at-rest)');
    const { renderLaneLine } = require('../lib/tc-verbs');
    assert.equal(h.formatWorkloadLine(lane('AVAILABLE')), renderLaneLine(lane('AVAILABLE')),
      'the browser line and the CLI line are the same text');
  });

  it('the landing poll keys the fleet read by project, newest live session first, and keeps the last answer on failure', async () => {
    const block = landing.slice(landing.indexOf("const fleet = await api('/api/tc/sessions');"));
    const body = block.slice(0, block.indexOf('state.workload = byProject;') + 'state.workload = byProject;'.length + 4);
    const run = async (reply, prior) => {
      const state = { workload: prior };
      await new Function('api', 'state', `return (async () => { ${body} })();`)(async () => reply, state);
      return state;
    };
    const two = await run({ sessions: [
      { id: 9, projectId: 7, composed: { availability: 'WAITING' } },
      { id: 3, projectId: 7, composed: { availability: 'AVAILABLE' } },
      { id: 4, projectId: 8, composed: { availability: 'UNKNOWN' } }
    ] }, {});
    assert.equal(two.workload[7].id, 9, 'the first (newest) session wins');
    assert.equal(two.workload[8].id, 4);
    assert.deepEqual((await run(null, { 7: 'previous' })).workload, { 7: 'previous' }, 'a failed fetch keeps the last answer');
  });
});
