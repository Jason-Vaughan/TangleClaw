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
 * @param {object} [opts] - The renderer's options, as the refresh cycle passes them
 * @returns {string} The container's markup
 */
function render(sequences, opts) {
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
  vm.runInContext(liftFunction(UI_SRC, 'function startupFireLabel'), ctx);
  vm.runInContext(liftFunction(UI_SRC, 'function launchStartupControlHtml'), ctx);
  vm.runInContext(liftFunction(UI_SRC, 'function launchReconciliationControlHtml'), ctx);
  vm.runInContext(liftFunction(UI_SRC, 'function renderProjectLaunchSequences'), ctx);
  if (opts === undefined) ctx.renderProjectLaunchSequences(sequences);
  else ctx.renderProjectLaunchSequences(sequences, opts);
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

  describe('startupControl (#1825 B3)', () => {
    const fire = (over = {}) => ({
      id: 1, sequenceId: 9, outcome: 'applied', reasonCode: null, reason: null, callerKind: 'launch', callerClearance: 'launch-automatic',
      callerProjectId: 3, promptRevision: 2, createdAt: '2026-09-24 03:00:00', acceptedAt: '2026-09-24 03:00:01', settledAt: '2026-09-24 03:00:02', ...over
    });
    const native = (over = {}) => row({
      startupDelivery: 'native',
      startupControl: { channel: { state: 'open', adapter: 'codex', engineId: 'codex', openedAt: '2026-09-24 02:59:00', closedAt: null, closeReason: null, teardown: null }, fires: [fire()], fireable: true },
      ...over
    });

    it('names the path every launch took, with or without the operator\'s block', () => {
      assert.match(render([row({ startupDelivery: 'legacy' })]), /Startup: legacy/);
      assert.match(render([row({ startupDelivery: 'native' })]), /Startup: native/);
      const bare = render([row({ startupDelivery: 'legacy' })]);
      assert.doesNotMatch(bare, /Channel:/, 'no block, no channel line: a bound reader is not shown what it was not sent');
      assert.doesNotMatch(bare, /data-startup-fire/);
    });

    it('shows the channel, each fire with its actor and receipt, and the Fire button only where the server says it applies', () => {
      const html = render([native()]);
      assert.match(html, /Channel: open \(codex\)/);
      assert.match(html, /Fire: <code>applied<\/code> \(automatic at launch, revision 2, 2026-09-24 03:00:02\)/);
      assert.match(html, /data-startup-fire="9"[^>]*data-session-id="42"/);
      assert.match(html, /Fire startup prompt/);
      const notFireable = render([native({ startupControl: { channel: { state: 'open', adapter: 'codex' }, fires: [], fireable: false } })]);
      // #2186: a fire sent despite a missing trust entry says so on its row,
      // whatever it became afterwards, and the note is escaped like any text.
      const noted = render([native({ startupControl: { channel: { state: 'open', adapter: 'codex' }, fireable: false, fires: [
        fire({ dispatchNote: 'Sent without a trust entry in Codex\'s config for /p <x>: TangleClaw did not grant trust.' }),
        fire({ outcome: 'failed', reasonCode: 'turn_failed', reason: 'the engine failed the turn', dispatchNote: 'Sent without a trust entry.' })
      ] } })]);
      assert.match(noted, /Fire: <code>applied<\/code> \([^)]*\) — note: Sent without a trust entry in Codex&#39;s config for \/p &lt;x&gt;: TangleClaw did not grant trust\./);
      assert.match(noted, /<code>failed<\/code> \([^)]*\) — <code>turn_failed<\/code>: the engine failed the turn — note: Sent without a trust entry\./);
      assert.ok(!/note:/.test(html), 'a fire with no note shows none');
      assert.doesNotMatch(notFireable, /data-startup-fire/);
      assert.match(notFireable, /Fires: none recorded for this launch/);
    });

    it('a blocked automatic attempt names its typed reason, and a denied attempt is shown as a refusal with who tried', () => {
      const blocked = fire({ id: 2, outcome: 'blocked', reasonCode: 'pane_not_ready', reason: 'the pane did not become ready within the launch window, so nothing was sent: the at-rest marker never appeared', settledAt: '2026-09-24 03:01:30' });
      const denied = fire({ id: 3, outcome: 'denied', reasonCode: 'fire_scope_denied', reason: 'caller is not a listed firer sharing a project group with the target', callerKind: 'project', callerClearance: 'project-binding', callerProjectId: 11 });
      const html = render([native({ startupControl: { channel: { state: 'closed', adapter: 'codex', closeReason: 'session killed', teardown: 'ok' }, fires: [blocked, denied], fireable: false } })]);
      assert.match(html, /Channel: closed \(codex\): session killed — teardown ok/);
      assert.match(html, /<code>blocked<\/code>.*<code>pane_not_ready<\/code>: the pane did not become ready/);
      assert.match(html, /rules-status-err">Fire: <code>denied<\/code> \(project 11, revision 2/);
      assert.match(html, /<code>fire_scope_denied<\/code>/);
    });

    it('a launch that opened no channel says so, and an operator\'s fire is named as the operator\'s', () => {
      const html = render([row({ startupDelivery: 'legacy', startupControl: { channel: null, fires: [fire({ callerKind: 'operator', callerClearance: 'operator-verified', callerProjectId: null, outcome: 'unsupported', reasonCode: 'engine_declares_none', reason: 'engine claude declares no startupControl channel' })], fireable: false } })]);
      assert.match(html, /Channel: none — the launch opened no native channel/);
      assert.match(html, /<code>unsupported<\/code> \(the operator, revision 2/);
    });

    it('escapes what the engine and the store said', () => {
      const html = render([native({ startupControl: { channel: { state: 'closed', adapter: 'codex', closeReason: '<b>x</b>' }, fires: [fire({ reasonCode: 'trust_required', reason: '<script>alert(1)</script>' })], fireable: false } })]);
      assert.doesNotMatch(html, /<script>/);
      assert.doesNotMatch(html, /<b>x<\/b>/);
      assert.match(html, /&lt;script&gt;/);
    });
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

    it('states the CAUSE, not just the verdict word, so a clear is an informed one', () => {
      // The payload carried the verdict and not the reason, which asked someone
      // to grant `operator-verified` against "Recovery required: not-evaluated"
      // beside a Clear button. A control offered without the cause is a decision
      // taken blind.
      const html = render([row({
        recovery: 'required',
        recoveryMode: 'operator',
        recoveryRevision: 3,
        preflightVerdict: 'not-evaluated',
        preflightReason: 'the handoff directory could not be read (ENOTDIR)',
        preflightEvaluationFailed: true,
        preflightEvaluationMissing: false
      })]);
      assert.match(html, /could not be read \(ENOTDIR\)/, 'the reason reaches the reader');
      assert.match(html, /server log names the error/,
        'a WITNESSED failure sends them somewhere specific');
    });

    it('does not claim nothing ran when it only lacks a result', () => {
      // The weaker claim must stay weaker. Missing evidence means no usable
      // result is available — it does not establish that no evaluation ran, and
      // saying otherwise would repeat the exact error this gate exists to stop.
      const html = render([row({
        recovery: 'required',
        recoveryMode: 'operator',
        recoveryRevision: 3,
        preflightVerdict: 'not-evaluated',
        preflightReason: 'no usable preflight result is available for this launch',
        preflightEvaluationFailed: false,
        preflightEvaluationMissing: true
      })]);
      assert.match(html, /not proof none ran/,
        'absence of a result is not evidence of absence of a run');
      assert.doesNotMatch(html, /server log names the error/,
        'nothing was witnessed, so it must not point at an error nobody saw');
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

  describe('the refresh cycle wires the buttons it just rendered (Train 21, #1587)', () => {
    it('renders and then wires, so a re-rendered panel is never inert', () => {
      // The hop between the two halves. `renderProjectLaunchSequences` replaces
      // the panel's innerHTML, which discards every listener on it, so a render
      // that is not followed by a wire leaves an operator pressing a button that
      // does nothing — the same shape of silent break as the missing
      // Content-Type, and the reason that one shipped was a hop no test read.
      const { doc } = makeDocument(['projLaunchSequencesList']);
      const ctx = { document: doc, window: {} };
      vm.createContext(ctx);
      const order = [];
      ctx.api = async () => ({ sequences: [row({ recovery: 'required', recoveryMode: 'operator' })] });
      ctx.projectRulesTargetId = 7;
      ctx.renderProjectLaunchSequences = () => order.push('render');
      ctx.wireLaunchRecoveryClears = () => order.push('wire');
      ctx.wireLaunchReconciliationReads = () => order.push('wire-reads');
      ctx.wireStartupFires = () => order.push('wire-fires');
      vm.runInContext(liftFunction(UI_SRC, 'async function refreshProjectLaunchSequences'), ctx);
      return ctx.refreshProjectLaunchSequences(7).then((answer) => {
        assert.equal(answer, true);
        assert.deepEqual(order, ['render', 'wire', 'wire-reads', 'wire-fires'],
          'wiring runs after the render that produced the buttons, and runs at all — every button kind');
      });
    });

    it('does not wire when the read failed and no buttons were rendered', () => {
      const { doc } = makeDocument(['projLaunchSequencesList']);
      const ctx = { document: doc, window: { tcRulesUnknownHtml: () => '', tcDegradedRead: () => '' } };
      vm.createContext(ctx);
      const order = [];
      ctx.api = async () => null;
      ctx.api.lastError = 'Connection lost.';
      ctx.projectRulesTargetId = 7;
      ctx.renderProjectLaunchSequences = () => order.push('render');
      ctx.wireLaunchRecoveryClears = () => order.push('wire');
      ctx.wireLaunchReconciliationReads = () => order.push('wire-reads');
      ctx.wireStartupFires = () => order.push('wire-fires');
      vm.runInContext(liftFunction(UI_SRC, 'async function refreshProjectLaunchSequences'), ctx);
      return ctx.refreshProjectLaunchSequences(7).then((answer) => {
        assert.equal(answer, false);
        assert.deepEqual(order, [], 'a degraded read wires nothing, because it rendered nothing');
      });
    });
  });

  describe('the reconciliation readback (#1937)', () => {
    const HOSTILE = '<img src=x onerror=alert(1)> I verified the handoff against </pre><script>steal()</script>';

    /**
     * An answer of the reconciliation route with every field the renderer reads.
     * @param {object} [overrides] - Fields to replace
     * @returns {object}
     */
    function readback(overrides = {}) {
      return {
        schema: 'tc.launch-reconciliation/1',
        sequenceId: 9,
        sessionId: 42,
        revision: 2,
        acceptedAt: '2026-10-06 19:05:00',
        readyDigest: 'abcdef0123456789abcdef0123456789',
        recovery: {
          state: 'cleared', mode: 'advisory', verdict: 'handoff-corrupt', attestedVerdict: 'handoff-corrupt',
          clearance: 'agent-reconciled', clearedAt: '2026-10-06 19:05:00', clearedBy: null
        },
        reconciliation: 'The previous handoff cannot be trusted; I rebuilt context from the plan.',
        provenance: 'agent-authored-unverified',
        ...overrides
      };
    }

    /**
     * Render one readback with the page's own `esc` and clearance wording.
     * @param {object} r - The route's answer
     * @returns {string} Markup
     */
    function renderReadback(r) {
      const ctx = { window: {} };
      vm.createContext(ctx);
      vm.runInContext(liftFunction(LANDING_SRC, 'function esc(str)'), ctx);
      vm.runInContext(liftFunction(UI_SRC, 'function launchClearanceLabel'), ctx);
      const preview = UI_SRC.match(/^const LAUNCH_RECONCILIATION_PREVIEW_CHARS = \d+;$/m);
      assert.ok(preview, 'the preview length is a top-level constant the renderer reads');
      vm.runInContext(preview[0], ctx);
      vm.runInContext(liftFunction(UI_SRC, 'function launchReconciliationHtml'), ctx);
      return ctx.launchReconciliationHtml(r);
    }

    it('offers the read on an attested launch and on no other', () => {
      const attested = render([row({ readyAt: '2026-10-06 19:05:00' })]);
      assert.match(attested, /data-launch-reconciliation="9" data-session-id="42"/);
      assert.match(attested, /data-launch-reconciliation-out="9"/, 'with a place for the answer');
      assert.doesNotMatch(render([row()]), /data-launch-reconciliation/,
        'a launch that has not attested has no accepted text to read');
      assert.doesNotMatch(render([row({ applicability: 'not-applicable', readyAt: '2026-10-06 19:05:00' })]),
        /data-launch-reconciliation/, 'nor has a launch that got no sequence');
    });

    it('offers no button on an install with no login, and says why', () => {
      const html = render([row({ readyAt: '2026-10-06 19:05:00' })], { noLogin: true });
      assert.doesNotMatch(html, /data-launch-reconciliation/, 'a control the server will refuse is not offered');
      assert.doesNotMatch(html, /<button[^>]*>Read the session/);
      assert.match(html, /cannot be read on an install with no login/);
      assert.match(html, /Turn the login on/);
      assert.doesNotMatch(render([row()], { noLogin: true }), /cannot be read on an install/,
        'and a launch that has not attested gets neither');
    });

    it('offers the button unless the server said the gate is open: unknown is not "no login"', () => {
      for (const opts of [{}, { noLogin: false }, { noLogin: undefined }, { noLogin: 'yes' }]) {
        assert.match(render([row({ readyAt: '2026-10-06 19:05:00' })], opts), /data-launch-reconciliation="9"/,
          JSON.stringify(opts));
      }
    });

    it('the refresh cycle tells the renderer whether the install has a login, from the server\'s own word', async () => {
      /**
       * Run one refresh with a given `/api/auth/me` answer and report the options the renderer got.
       * @param {object|null} me - What `/api/auth/me` answers with
       * @returns {Promise<object>} The renderer's second argument
       */
      async function refreshWith(me) {
        const { doc } = makeDocument(['projLaunchSequencesList']);
        const ctx = { document: doc, window: {} };
        vm.createContext(ctx);
        let got;
        ctx.api = async (url) => (url === '/api/auth/me' ? me : { sequences: [row({ readyAt: '2026-10-06 19:05:00' })] });
        ctx.projectRulesTargetId = 7;
        ctx.renderProjectLaunchSequences = (_sequences, opts) => { got = opts; };
        ctx.wireLaunchRecoveryClears = () => {};
        ctx.wireLaunchReconciliationReads = () => {};
        ctx.wireStartupFires = () => {};
        vm.runInContext(liftFunction(UI_SRC, 'async function refreshProjectLaunchSequences'), ctx);
        assert.equal(await ctx.refreshProjectLaunchSequences(7), true);
        return got;
      }
      assert.deepEqual({ ...(await refreshWith({ gateState: 'open', openInstallToken: 'page-token' })) }, { noLogin: true });
      assert.deepEqual({ ...(await refreshWith({ gateState: 'armed', authenticated: true, openInstallToken: null })) }, { noLogin: false });
      assert.deepEqual({ ...(await refreshWith(null)) }, { noLogin: false },
        'a read that failed leaves it unknown, and the server still decides on the click');
    });

    it('never renders the text with the list, whatever a row carries', () => {
      // The list comes from a route every caller may read. If a row ever did
      // carry the text, the panel must still not show it unasked.
      const html = render([row({
        readyAt: '2026-10-06 19:05:00', reconciliation: 'SENTINEL-TEXT', readyArtifact: { reconciliation: 'SENTINEL-TEXT' }
      })]);
      assert.doesNotMatch(html, /SENTINEL-TEXT/);
    });

    it('labels the text as the session\'s own unchecked account, before the text', () => {
      const html = renderReadback(readback());
      const label = html.indexOf('TangleClaw did not check it');
      assert.notEqual(label, -1);
      assert.match(html, /not evidence that the account is true/);
      assert.ok(label < html.indexOf('The previous handoff cannot be trusted'), 'the label comes first');
    });

    it('says which launch the text belongs to, and how its recovery was cleared', () => {
      const html = renderReadback(readback());
      assert.match(html, /Launch sequence 9, revision 2/);
      assert.match(html, /accepted 2026-10-06 19:05:00/);
      assert.match(html, /attestation digest <code>abcdef012345<\/code>/);
      assert.match(html, /Preflight verdict: <code>handoff-corrupt<\/code>/);
      assert.match(html, /cleared by the session's written reconciliation \(advisory mode\)/);
    });

    it('escapes every character of the text', () => {
      const html = renderReadback(readback({ reconciliation: HOSTILE }));
      assert.doesNotMatch(html, /<img src=x/);
      assert.doesNotMatch(html, /<script>/);
      assert.equal(html.split('</pre>').length, 2, 'the text cannot close the element it sits in');
      assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    });

    it('escapes the facts around it too', () => {
      const html = renderReadback(readback({
        acceptedAt: '<b>when</b>', readyDigest: '<i>digest</i>',
        recovery: { state: 'cleared', verdict: '<script>', attestedVerdict: '<em>', clearance: 'operator-verified', clearedBy: '<img>', clearedAt: '<u>' }
      }));
      for (const raw of ['<b>', '<i>', '<script>', '<em>', '<img>', '<u>']) {
        assert.equal(html.includes(raw), false, raw);
      }
    });

    it('keeps long text whole behind a details element, with a preview before it', () => {
      const long = `${'a'.repeat(390)}MIDDLE${'b'.repeat(600)}END`;
      const html = renderReadback(readback({ reconciliation: long }));
      assert.match(html, new RegExp(`<details><summary>Show all ${long.length} characters</summary>`));
      const [before, inside] = html.split('<details>');
      assert.equal(before.includes('END'), false, 'the preview stops short');
      assert.ok(inside.includes(long), 'and the whole text is inside the details');
    });

    it('shows short text whole, with nothing to open', () => {
      const html = renderReadback(readback());
      assert.doesNotMatch(html, /<details>/);
    });

    it('says so when the attestation carried no reconciliation, and claims no text', () => {
      for (const reconciliation of [null, '', undefined]) {
        const html = renderReadback(readback({ reconciliation }));
        assert.match(html, /This attestation carried no reconciliation\./);
        assert.doesNotMatch(html, /<pre/);
        assert.doesNotMatch(html, /Written by the session/, 'no text, so nothing to label as the session\'s');
      }
    });

    it('distinguishes a launch that needed no recovery from one cleared by the operator', () => {
      const none = renderReadback(readback({ recovery: { state: 'none', verdict: 'ok', attestedVerdict: 'ok' } }));
      assert.match(none, /this launch needed no recovery/);
      const operator = renderReadback(readback({
        recovery: { state: 'cleared', verdict: 'stale', attestedVerdict: 'stale', clearance: 'operator-verified', clearedBy: 'rosie' }
      }));
      assert.match(operator, /cleared by rosie/);
      assert.doesNotMatch(operator, /advisory mode/);
      for (const recovery of [undefined, {}, { state: null }]) {
        const unknown = renderReadback(readback({ recovery }));
        assert.match(unknown, /no recovery state was reported/, JSON.stringify(recovery));
        assert.doesNotMatch(unknown, /needed no recovery/, 'an absent state is not reported as none');
      }
    });

    it('shows a verdict the session attested differently from the preflight\'s', () => {
      const html = renderReadback(readback({
        recovery: { state: 'none', verdict: 'stale', attestedVerdict: 'ok' }
      }));
      assert.match(html, /the session attested <code>ok<\/code>/);
    });

    /**
     * Run `wireLaunchReconciliationReads` against a button the panel would
     * have rendered, and report what the handler sent and showed.
     * @param {object} [opts]
     * @param {string|null} [opts.openInstallToken] - What `/api/auth/me` answers with
     * @param {object|null} [opts.answer] - What the route answers with
     * @returns {Promise<{calls: object[], status: object[], btn: object, out: object}>}
     */
    async function clickRead(opts = {}) {
      const ctx = { window: {} };
      vm.createContext(ctx);
      const calls = [];
      const status = [];
      const out = { innerHTML: '' };
      const btn = {
        disabled: false,
        dataset: { launchReconciliation: '9', sessionId: '42' },
        _click: null,
        addEventListener(type, fn) { if (type === 'click') this._click = fn; }
      };
      ctx.api = async (url, fetchOpts) => {
        calls.push({ url, fetchOpts });
        if (url === '/api/auth/me') {
          return { openInstallToken: opts.openInstallToken === undefined ? 'page-token' : opts.openInstallToken };
        }
        return opts.answer === undefined ? readback() : opts.answer;
      };
      ctx.api.lastError = 'Sign in to read a launch reconciliation.';
      ctx.projectRulesTargetId = 7;
      ctx.projectRulesTargetName = 'my project';
      ctx._setProjectRulesStatus = (text, ok) => status.push({ text, ok });
      ctx.launchReconciliationHtml = (r) => `RENDERED:${r.sequenceId}`;
      vm.runInContext(liftFunction(UI_SRC, 'function wireLaunchReconciliationReads'), ctx);
      const selectors = [];
      ctx.wireLaunchReconciliationReads({
        querySelectorAll: () => [btn],
        querySelector: (sel) => { selectors.push(sel); return out; }
      });
      await btn._click();
      return { calls, status, btn, out, selectors };
    }

    it('asks for the launch the button was rendered for, as numbers, in a declared JSON body', async () => {
      const { calls } = await clickRead();
      const post = calls.find((c) => c.url.includes('/launch/reconciliation'));
      assert.ok(post, 'the handler asked');
      assert.equal(post.url, '/api/sessions/my%20project/launch/reconciliation');
      assert.equal(post.fetchOpts.method, 'POST', 'a POST, so the page sends its CSRF token with it');
      assert.equal(post.fetchOpts.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(post.fetchOpts.body), { sessionId: 42, sequenceId: 9 });
    });

    it('sends no page token and makes no other request: the route serves a signed-in operator only', async () => {
      const { calls } = await clickRead({ openInstallToken: 'page-token' });
      assert.deepEqual(calls.map((c) => c.url), ['/api/sessions/my%20project/launch/reconciliation']);
      assert.deepEqual(Object.keys(calls[0].fetchOpts.headers), ['Content-Type']);
    });

    it('renders the answer into that launch\'s own output and leaves the button usable', async () => {
      const { out, btn, status, selectors } = await clickRead();
      assert.equal(out.innerHTML, 'RENDERED:9');
      assert.deepEqual(selectors, ['[data-launch-reconciliation-out="9"]']);
      assert.equal(btn.disabled, false);
      assert.deepEqual(status, [], 'a read that worked is not announced as a change');
    });

    it('shows the server\'s refusal and renders nothing', async () => {
      const { out, btn, status } = await clickRead({ answer: null });
      assert.equal(out.innerHTML, '');
      assert.equal(btn.disabled, false);
      assert.deepEqual(status, [{ text: 'Sign in to read a launch reconciliation.', ok: false }]);
    });

    it('renders nothing for an answer about a different launch', async () => {
      const { out, status } = await clickRead({ answer: readback({ sequenceId: 10 }) });
      assert.equal(out.innerHTML, '');
      assert.equal(status.length, 1);
      assert.equal(status[0].ok, false);
    });
  });
});
