'use strict';

/*
 * #583 — structural pins for the wrap-run reattach wiring in the browser
 * globals (`public/session.js`, `public/landing.js`). The decision logic
 * itself is pure and behaviorally tested (`wrapWatchDecision` in
 * test/wrap-drawer.test.js); these pins assert the call sites route
 * through it — the same source-probe approach as
 * test/landing-wrap-single-flight.test.js, because these files touch
 * `window` at load and cannot be require()d.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Slice out a top-level function body by brace-matching from its declaration.
 * @param {string} src full source text
 * @param {string} decl the function declaration to find (e.g. `async function confirmWrap()`)
 * @returns {string} the function body including its braces
 */
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start !== -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  assert.fail(`unbalanced braces after ${decl}`);
}

describe('wrap-run reattach wiring (#583)', () => {
  let sessionSrc;
  let landingSrc;

  before(() => {
    sessionSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
    landingSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
  });

  describe('session.js', () => {
    it('confirmWrap probes/reattaches on a failed POST before showing an error', () => {
      const body = functionBody(sessionSrc, 'async function confirmWrap()');
      const failBranch = body.slice(body.indexOf('if (!data)'));
      assert.ok(failBranch.includes('watchWrapRun('),
        'the !data branch must attempt reattach — a failed POST does not mean no wrap is running');
      assert.ok(body.indexOf('watchWrapRun(') < body.indexOf("wrapError').textContent"),
        'reattach is attempted BEFORE the error is rendered');
    });

    it('retryWrap reattaches on a failed retry POST and captures the password before the drawer can close', () => {
      const body = functionBody(sessionSrc, 'async function retryWrap()');
      assert.ok(body.includes('watchWrapRun('), 'retry failure path must attempt reattach');
      const pwCapture = body.indexOf('const retryPassword = currentWrapPassword');
      assert.ok(pwCapture !== -1, 'password captured into a local before any close can clear it');
      assert.ok(pwCapture < body.indexOf('apiMutate'),
        'password capture precedes the POST (closeWrapDrawer clears currentWrapPassword)');
    });

    it('watchWrapRun routes through the tested pure decision and polls the status endpoint', () => {
      const body = functionBody(sessionSrc, 'async function watchWrapRun(');
      assert.ok(body.includes('wrapWatchDecision('),
        'the watch loop must use the pure, unit-tested decision — no ad-hoc freshness logic');
      assert.ok(body.includes('/wrap/status'), 'watches the wrap-run status endpoint');
      assert.ok(body.includes('clearWrappingState()'),
        'a blocked (still-active-session) outcome restores the action buttons');
      assert.ok(body.includes('wrapWatchInFlight'),
        'single watch loop at a time — a concurrent caller must not start a duplicate poller');
    });

    it('opening the drawer cancels a ticking ended-countdown (#268 rule holds on the reattach race)', () => {
      // On the reattach path the drawer can open AFTER handleSessionEnded
      // started its 10s auto-redirect — the countdown must die, not navigate
      // the report away mid-read.
      const drawerBody = functionBody(sessionSrc, 'function openWrapDrawer(');
      assert.ok(drawerBody.includes('cancelEndedCountdown()'),
        'openWrapDrawer cancels an already-ticking countdown');
      const noticeBody = functionBody(sessionSrc, 'function openWrapDrawerNotice(');
      assert.ok(noticeBody.includes('cancelEndedCountdown()'),
        'the notice variant cancels it too');
      const cancelBody = functionBody(sessionSrc, 'function cancelEndedCountdown()');
      assert.ok(cancelBody.includes('clearInterval(countdownTimer)'),
        'cancel clears the interval, not just the label');
    });

    it('initSession reattaches only to a RUNNING run (a finished one is a previous page-load\'s business)', () => {
      const body = functionBody(sessionSrc, 'async function initSession()');
      const probe = body.slice(body.indexOf('/wrap/status'));
      assert.ok(probe.length > 12, 'init probes the wrap-run status');
      assert.ok(probe.includes('running === true'),
        'init-time reattach gates on running === true, never on a retained result');
      assert.ok(probe.includes('watchWrapRun('), 'a running run is watched from init');
    });
  });

  describe('landing.js', () => {
    it('every restart POST routes through the wrap-guard helper', () => {
      assert.equal((landingSrc.match(/apiMutate\('\/api\/server\/restart'/g) || []).length, 2,
        'exactly the two POSTs inside postServerRestart (initial + forced) hit the endpoint directly');
      const helperBody = functionBody(landingSrc, 'async function postServerRestart()');
      assert.ok(helperBody.includes("api.lastErrorCode === 'WRAP_RESTART_BLOCKED'"),
        'helper recognizes the #583 guard refusal');
      assert.ok(helperBody.includes('window.confirm'),
        'forcing past a running wrap requires an explicit operator confirmation');
      assert.ok(helperBody.includes('force: true'),
        'the forced retry carries {force:true}');
      // Both operator flows use the helper.
      const restartFlow = functionBody(landingSrc, 'async function triggerServerRestart()');
      const updateFlow = functionBody(landingSrc, 'async function applyUpdateAndRestart(');
      assert.ok(restartFlow.includes('postServerRestart()'), '#235 restart uses the guard helper');
      assert.ok(updateFlow.includes('postServerRestart()'), '#229 update-and-restart uses the guard helper');
    });
  });
});
