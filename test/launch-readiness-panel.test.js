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
  // panel renders, and landing.js is what defines `esc` there. A stub with a
  // different contract than the shipped helper makes the assertions below pass
  // against markup the panel cannot produce, which is worse than no test.
  vm.runInContext(liftFunction(LANDING_SRC, 'function esc(str)'), ctx);
  vm.runInContext(liftFunction(API_HELPER_SRC, 'function tcLaunchReadinessClass'), ctx);
  ctx.window.tcLaunchReadinessClass = ctx.tcLaunchReadinessClass;
  // Lifted too, for the same reason the panel itself is: they are what the
  // renderer calls, and a sandbox missing them would report every row as a
  // throw — which is precisely what this file exists to catch on the live
  // install, where the panel renders the moment the file is saved.
  vm.runInContext(liftFunction(UI_SRC, 'function launchClearanceLabel'), ctx);
  vm.runInContext(liftFunction(UI_SRC, 'function launchRecoveryHtml'), ctx);
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
    recovery: 'none',
    recoveryMode: 'operator',
    recoveryRevision: 1,
    recoveryClearance: null,
    recoveryClearedAt: null,
    recoveryClearedBy: null,
    preflightVerdict: 'ok',
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

  describe('recovery (Train 21, #1587)', () => {
    it('says nothing about recovery for a launch that owes none', () => {
      const html = render([row()]);
      assert.doesNotMatch(html, /Recovery/);
      assert.doesNotMatch(html, /data-launch-recovery-clear/);
    });

    it('offers the operator a clear, bound to the launch they are looking at', () => {
      const html = render([row({
        recovery: 'required', recoveryMode: 'operator', recoveryRevision: 3, preflightVerdict: 'handoff-behind'
      })]);
      assert.match(html, /Recovery required/);
      assert.match(html, /handoff-behind/);
      assert.match(html, /the task step is withheld/i);
      assert.match(html, /data-launch-recovery-clear="9"/);
      assert.match(html, /data-session-id="42"/);
      assert.match(html, /data-recovery-revision="3"/,
        'the button carries the revision, so a stale click is refused rather than applied');
    });

    it('offers no button in advisory mode, where the session clears its own', () => {
      const html = render([row({
        recovery: 'required', recoveryMode: 'advisory', preflightVerdict: 'handoff-behind'
      })]);
      assert.match(html, /Recovery required/);
      assert.match(html, /advisory mode/);
      assert.doesNotMatch(html, /data-launch-recovery-clear/,
        'a control the route would refuse is worse than no control');
    });

    it('never words an open install\'s clear as an operator\'s', () => {
      // The whole reason the three clearances are kept apart. An install with no
      // login proved that the click came from its own dashboard and nothing
      // more, and an operator reading this log has to be able to see that.
      const open = render([row({
        recovery: 'cleared', recoveryClearance: 'open-install-unverified',
        recoveryClearedBy: null, recoveryClearedAt: '2026-09-18 08:00:00'
      })]);
      assert.match(open, /install with no login — nobody was identified/);
      assert.doesNotMatch(open, /cleared by/);

      const verified = render([row({
        recovery: 'cleared', recoveryClearance: 'operator-verified',
        recoveryClearedBy: 'rosie', recoveryClearedAt: '2026-09-18 08:00:00'
      })]);
      assert.match(verified, /cleared by rosie/);

      const reconciled = render([row({
        recovery: 'cleared', recoveryClearance: 'agent-reconciled', recoveryClearedBy: null
      })]);
      assert.match(reconciled, /written reconciliation \(advisory mode\)/);
      assert.doesNotMatch(reconciled, /cleared by (?:an operator|null|undefined)/,
        'an agent\'s reconciliation names the mechanism, never a person');
    });

    it('escapes a verdict and a clearer it prints', () => {
      const html = render([row({
        recovery: 'cleared', recoveryClearance: 'operator-verified',
        recoveryClearedBy: '<img src=x onerror=alert(1)>', preflightVerdict: '<script>'
      })]);
      assert.doesNotMatch(html, /<img src=x/);
      assert.doesNotMatch(html, /<script>/);
      assert.match(html, /&lt;img src=x/);
    });
  });

  describe('the clear button reaches the server (Train 21, #1587)', () => {
    /**
     * Run `wireLaunchRecoveryClears` against buttons the panel would have
     * rendered, and report what the handler sent.
     *
     * The markup path cannot be used here — `_mini-dom` extracts ids from
     * assigned `innerHTML` and builds no element tree — so the buttons are the
     * ones `launchRecoveryHtml` names, constructed by hand from the same
     * dataset keys. What this covers is the hop nothing else does: widget →
     * request body. A button that renders and a route that works still leave
     * room for the two to disagree about what a click means.
     * @param {object} [opts]
     * @param {string|null} [opts.openInstallToken] - What `/api/auth/me` answers with
     * @param {object|null} [opts.clearAnswer] - What the clear route answers with
     * @returns {{calls: object[], status: object[], disabled: boolean}}
     */
    function click(opts = {}) {
      const { doc } = makeDocument(['projLaunchSequencesList']);
      const ctx = { document: doc, window: {} };
      vm.createContext(ctx);
      const calls = [];
      const status = [];
      const btn = {
        disabled: false,
        dataset: { launchRecoveryClear: '9', sessionId: '42', recoveryRevision: '3' },
        _click: null,
        addEventListener(type, fn) { if (type === 'click') this._click = fn; }
      };
      ctx.api = async (url, fetchOpts) => {
        calls.push({ url, fetchOpts });
        if (url === '/api/auth/me') {
          return { openInstallToken: opts.openInstallToken === undefined ? 'page-token' : opts.openInstallToken };
        }
        return opts.clearAnswer === undefined ? { ok: true } : opts.clearAnswer;
      };
      ctx.api.lastError = 'The launch moved under the click.';
      ctx.projectRulesTargetId = 7;
      ctx.projectRulesTargetName = 'my project';
      ctx._setProjectRulesStatus = (text, ok) => status.push({ text, ok });
      ctx.refreshProjectLaunchSequences = async () => true;
      vm.runInContext(liftFunction(UI_SRC, 'function wireLaunchRecoveryClears'), ctx);
      ctx.wireLaunchRecoveryClears({ querySelectorAll: () => [btn] });
      return { run: async () => { await btn._click(); return { calls, status, btn }; } };
    }

    it('sends the launch the button was rendered for, as numbers', async () => {
      const { calls } = await (click().run());
      const post = calls.find((c) => c.url.includes('recovery-clear'));
      assert.ok(post, 'the handler posted a clear');
      assert.equal(post.url, '/api/sessions/my%20project/launch/recovery-clear',
        'the project name is escaped into the path');
      assert.equal(post.fetchOpts.method, 'POST');
      assert.deepEqual(JSON.parse(post.fetchOpts.body), { sessionId: 42, sequenceId: 9, recoveryRevision: 3 },
        'the dataset strings reach the server as the numbers it validates');
    });

    it('declares the body as JSON, which the perimeter requires of a browser', async () => {
      // Not cosmetic: `/api/` refuses an undeclared browser body with 415
      // before any route runs (#860), so a clear sent without this header never
      // reaches the route at all and the button silently does nothing.
      for (const openInstallToken of ['page-token', null]) {
        const { calls } = await (click({ openInstallToken }).run());
        const post = calls.find((c) => c.url.includes('recovery-clear'));
        assert.equal(post.fetchOpts.headers['Content-Type'], 'application/json',
          `openInstallToken: ${JSON.stringify(openInstallToken)}`);
      }
    });

    it('carries the page token an open install issued', async () => {
      const { calls } = await (click({ openInstallToken: 'page-token' }).run());
      const post = calls.find((c) => c.url.includes('recovery-clear'));
      assert.equal(post.fetchOpts.headers['X-TC-Open-Token'], 'page-token');
    });

    it('sends no token header on an install that issues none', async () => {
      // An armed install answers `openInstallToken: null`, and `api()`'s own
      // CSRF header is what the route reads there. Sending an empty header
      // would be sending a claim with nothing behind it.
      const { calls } = await (click({ openInstallToken: null }).run());
      const post = calls.find((c) => c.url.includes('recovery-clear'));
      assert.equal(post.fetchOpts.headers['X-TC-Open-Token'], undefined);
    });

    it('re-enables the button and says why when the clear is refused', async () => {
      const { status, btn } = await (click({ clearAnswer: null }).run());
      assert.equal(btn.disabled, false, 'a refused clear leaves the operator able to try again');
      assert.deepEqual(status, [{ text: 'The launch moved under the click.', ok: false }]);
    });

    it('reports success and leaves the button spent', async () => {
      const { status, btn } = await (click().run());
      assert.equal(btn.disabled, true);
      assert.equal(status.length, 1);
      assert.equal(status[0].ok, true);
      assert.match(status[0].text, /Recovery cleared/);
    });
  });
});
