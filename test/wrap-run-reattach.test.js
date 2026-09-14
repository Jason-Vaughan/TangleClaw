'use strict';

/*
 * #583 — the wrap-run reattach guards that remain source-level. How a page
 * follows a run (409, dropped POST, reload, lost stream) is executed in
 * test/wrap-run-session-wiring.test.js over the real functions, and the
 * decisions are unit-tested in test/wrap-run-controller.test.js; what is
 * pinned here is the countdown rule, the init call, and the restart guard.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  let apiHelperSrc;

  before(() => {
    sessionSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
    landingSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
    apiHelperSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
  });

  describe('session.js', () => {
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

    it('initSession restores the wrap run on load without blocking init on it', () => {
      const body = functionBody(sessionSrc, 'async function initSession()');
      assert.ok(body.includes('restoreWrapRunOnLoad()'), 'init picks up a running or remembered run');
      assert.ok(!body.includes('await restoreWrapRunOnLoad()'), 'and does not wait on a multi-minute wrap');
    });
  });

  describe('the #583 restart guard', () => {
    it('a blocked restart asks, then retries with {force:true} — executed', async () => {
      // The guard's whole value is what it does with the refusal, so this runs
      // the real helper rather than pinning its source: the previous version
      // of this test counted `apiMutate('/api/server/restart'` occurrences in
      // landing.js, which stopped meaning anything the moment the helper moved
      // to api-helper.js (#931) — a pin can go quiet without going red.
      const calls = { confirms: [], bodies: [] };
      const sandbox = {
        console, Response, Headers,
        confirm: (msg) => { calls.confirms.push(msg); return true; },
        fetch: async (url, init) => {
          calls.bodies.push(JSON.parse(init.body));
          return new Response(
            JSON.stringify(calls.bodies.length === 1
              ? { error: 'a wrap is running', code: 'WRAP_RESTART_BLOCKED' }
              : { ok: true }),
            { status: calls.bodies.length === 1 ? 409 : 200,
              headers: { 'Content-Type': 'application/json' } }
          );
        }
      };
      sandbox.window = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(apiHelperSrc, sandbox);
      const resp = await vm.runInContext(`
        const api = tcCreateApi({});
        tcCreateRestartFlow({ api, apiMutate: tcCreateApiMutate(api), win: window })
          .postServerRestart();
      `, sandbox);

      assert.equal(calls.confirms.length, 1, 'forcing past a running wrap is never silent');
      assert.match(calls.confirms[0], /killed mid-pipeline/, 'and says what it costs');
      assert.deepEqual(calls.bodies, [{}, { force: true }], 'the retry carries the force flag');
      assert.equal(resp.ok, true);
    });

    it('declining the force leaves the wrap alone — executed', async () => {
      const bodies = [];
      const sandbox = {
        console, Response, Headers,
        confirm: () => false,
        fetch: async (url, init) => {
          bodies.push(JSON.parse(init.body));
          return new Response(
            JSON.stringify({ error: 'a wrap is running', code: 'WRAP_RESTART_BLOCKED' }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
      };
      sandbox.window = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(apiHelperSrc, sandbox);
      const resp = await vm.runInContext(`
        const api = tcCreateApi({});
        tcCreateRestartFlow({ api, apiMutate: tcCreateApiMutate(api), win: window })
          .postServerRestart();
      `, sandbox);

      assert.deepEqual(bodies, [{}], 'no forced retry');
      assert.equal(resp, null, 'and the caller is told the restart did not happen');
    });

    it('nothing POSTs the restart route outside the shared helper', () => {
      // Both operator flows — the #235 stale-server restart and the #229
      // update-and-restart, which since #931 lives in update-beacon.js and
      // serves BOTH pages — must go through the guard. A direct POST anywhere
      // else is a path that can kill a running wrap without asking.
      const beaconSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'update-beacon.js'), 'utf8');
      for (const [name, src] of [['landing.js', landingSrc], ['session.js', sessionSrc],
        ['update-beacon.js', beaconSrc]]) {
        assert.equal((src.match(/'\/api\/server\/restart'/g) || []).length, 0,
          `${name} must not name the restart route directly`);
      }
      assert.equal((apiHelperSrc.match(/apiMutate\('\/api\/server\/restart'/g) || []).length, 2,
        'exactly the two POSTs inside the helper (initial + forced)');
      assert.ok(functionBody(landingSrc, 'async function triggerServerRestart()')
        .includes('restartFlow.postServerRestart()'), '#235 restart uses the guard helper');
      assert.ok(beaconSrc.includes('restart.postServerRestart()'),
        '#229 update-and-restart uses the guard helper');
    });
  });
});
