'use strict';

/*
 * The settings modal's launch-readiness panel (Train 21, car 21.5).
 *
 * `renderProjectLaunchSequences` is RUN here rather than matched as source
 * text, for the reason `test/settings-launch-mode-render.test.js` states: a
 * regex cannot see an undeclared identifier, and this panel renders on the
 * live install the moment the file is saved.
 *
 * What the assertions are about is the one property the panel exists for: the
 * three records stay three. A session with no rule-delivery row and a session
 * whose delivery failed must not read the same, because telling them apart is
 * why the records are kept separately at all (plan §2.5).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeDocument } = require('./_mini-dom');

const PUB = path.join(__dirname, '..', 'public');
const UI_SRC = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');
const API_HELPER_SRC = fs.readFileSync(path.join(PUB, 'api-helper.js'), 'utf8');
const LANDING_SRC = fs.readFileSync(path.join(PUB, 'landing.js'), 'utf8');

/**
 * Slice a top-level function out of source text by brace-matching, so the
 * sandbox runs the REAL code rather than a copy.
 * @param {string} src - File source text
 * @param {string} decl - Declaration to find
 * @returns {string} The declaration plus its balanced body
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
  assert.fail(`${decl} body must close`);
}

/**
 * Render the panel for a list of sequences.
 * @param {object[]} sequences - Rows as `GET /api/launch-sequences` returns them
 * @returns {string} The container's markup
 */
function render(sequences) {
  const { doc } = makeDocument(['projLaunchSequencesList']);
  const ctx = { document: doc, window: {} };
  vm.createContext(ctx);
  // The page's OWN `esc`, lifted from landing.js — index.html is where this
  // panel renders, and landing.js is what defines `esc` there. A hand-written
  // stub is what let #1601 ship: one that coerced with String() printed the
  // numbers the shipped helper blanked, so the assertions below passed against
  // markup the panel could not produce.
  vm.runInContext(liftFunction(LANDING_SRC, 'function esc(str)'), ctx);
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcLaunchReadinessClass'), ctx);
  ctx.window.tcLaunchReadinessClass = ctx.tcLaunchReadinessClass;
  vm.runInContext(liftFunction(UI_SRC, 'function renderProjectLaunchSequences'), ctx);
  ctx.renderProjectLaunchSequences(sequences);
  return doc.getElementById('projLaunchSequencesList').innerHTML;
}

/**
 * A sequence row with every field the panel reads.
 * @param {object} [overrides] - Fields to replace
 * @returns {object}
 */
function row(overrides = {}) {
  return {
    sequenceId: 9,
    sessionId: 42,
    revision: 1,
    applicability: 'applicable',
    notApplicableReason: null,
    createdAt: '2026-09-17 19:00:00',
    cursor: 4,
    of: 4,
    readyAt: null,
    unreadyAt: null,
    nudgeCount: 0,
    lastNudgedAt: null,
    rulesDelivery: null,
    steps: [
      { index: 0, id: 'identity', pageCount: 1, pagesServed: 1, servedAt: '2026-09-17 19:00:05', ackedAt: '2026-09-17 19:00:10', carriedFromRevision: null },
      { index: 1, id: 'governance', pageCount: 2, pagesServed: 2, servedAt: '2026-09-17 19:00:20', ackedAt: '2026-09-17 19:00:30', carriedFromRevision: null },
      { index: 2, id: 'state', pageCount: 1, pagesServed: 1, servedAt: '2026-09-17 19:00:40', ackedAt: null, carriedFromRevision: null },
      { index: 3, id: 'task', pageCount: 1, pagesServed: 0, servedAt: null, ackedAt: null, carriedFromRevision: null }
    ],
    ...overrides
  };
}

describe('the launch-readiness panel renders (Train 21, car 21.5)', () => {
  it('renders without throwing and counts served and acknowledged separately', () => {
    const html = render([row()]);
    assert.match(html, /Served: 3\/4 step\(s\)/, 'served counts the steps that went out');
    assert.match(html, /Acknowledged: 2\/4/, 'acknowledged counts only what came back');
    assert.match(html, /not attested yet/);
  });

  it('tells a missing rule-delivery record apart from one that failed', () => {
    const absent = render([row({ rulesDelivery: null })]);
    assert.match(absent, /no record — nothing recorded a rule delivery for this launch/);

    const failed = render([row({ rulesDelivery: { outcome: 'skipped', channel: 'none', skipReason: 'no prime channel' } })]);
    assert.match(failed, /Rules channel: skipped \(none\): no prime channel/);
    assert.doesNotMatch(failed, /no record/);
  });

  it('marks an attested launch as the only pass', () => {
    const attested = render([row({ readyAt: '2026-09-17 19:05:00' })]);
    assert.match(attested, /rules-status-ok/);
    assert.match(attested, /attested 2026-09-17 19:05:00/);

    const waiting = render([row()]);
    assert.doesNotMatch(waiting, /rules-status-ok/,
      'a launch that has not attested is not a pass');
  });

  it('shows a passed window and the nudge that went with it', () => {
    const html = render([row({ unreadyAt: '2026-09-17 19:10:00', nudgeCount: 1, lastNudgedAt: '2026-09-17 19:10:05' })]);
    assert.match(html, /rules-status-err/);
    assert.match(html, /window passed 2026-09-17 19:10:00/);
    assert.match(html, /nudged 1×, last 2026-09-17 19:10:05/);
  });

  it('says a session was not nudged rather than leaving it blank', () => {
    // A session nobody nudged and a session nobody recorded a nudge for look
    // identical if the absent case renders as nothing.
    assert.match(render([row({ unreadyAt: '2026-09-17 19:10:00' })]), /not nudged/);
  });

  it('explains a launch that got no sequence at all', () => {
    const html = render([row({
      applicability: 'not-applicable',
      notApplicableReason: 'the engine declares no launch-sequence support',
      steps: []
    })]);
    assert.match(html, /no launch sequence/);
    assert.match(html, /the engine declares no launch-sequence support/);
    assert.doesNotMatch(html, /Served:/, 'there is nothing to count');
  });

  it('states the empty case as a fact about the record', () => {
    assert.match(render([]), /No launch sequences recorded for this project\./);
  });

  it('escapes what it prints', () => {
    const html = render([row({ rulesDelivery: { outcome: '<img>', channel: 'none', skipReason: null } })]);
    assert.doesNotMatch(html, /<img>/);
    assert.match(html, /&lt;img&gt;/);
  });

  describe('tcLaunchReadinessClass', () => {
    it('defaults to the cautious class for a row it cannot read', () => {
      const { doc: _doc } = makeDocument([]);
      const ctx = { };
      vm.createContext(ctx);
      vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcLaunchReadinessClass'), ctx);
      assert.equal(ctx.tcLaunchReadinessClass(null), 'rules-status-warn');
      assert.equal(ctx.tcLaunchReadinessClass({ applicability: 'applicable', readyAt: 'x' }), 'rules-status-ok');
      assert.equal(ctx.tcLaunchReadinessClass({ applicability: 'applicable', unreadyAt: 'x' }), 'rules-status-err');
      assert.equal(ctx.tcLaunchReadinessClass({ applicability: 'applicable' }), '');
      assert.equal(ctx.tcLaunchReadinessClass({ applicability: 'not-applicable', unreadyAt: 'x' }), '',
        'a launch with no sequence owes no readiness');
    });
  });
});
