'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const loadApiHelperGlobals = require('./_api-helper-globals');

// #3332 (Browser & ttyd Connection Stability): `tcCreateApi`'s `setConnected`
// wrapper can optionally debounce a transient flap -- a single missed poll
// (a slow gateway hiccup) flipping a page to "disconnected" and back on the
// very next successful poll, with no real outage. Both knobs
// (`disconnectThreshold`, `flapWindowMs`) default OFF (PM ruling on this
// car): an existing caller that names neither -- every page today, and
// test/frontend-api-errors.test.js / test/landing-unreachable-state.test.js,
// which this file must never need to change -- sees the exact pre-#3332
// behavior, `setConnected(false)` on the very first failure. RUN, not
// grepped: `test/frontend-csrf.test.js` already runs `public/api-helper.js`
// for real rather than restating its markup/logic, and this file follows
// the same pattern for the connection-state half of the same module.

/**
 * A sandbox whose `fetch` always answers the same canned response, and a
 * `setConnected` spy recording every call the wrapper actually let through.
 * @param {object} response - What every `fetch` call resolves to.
 * @param {object} [extraOpts] - Merged into the `tcCreateApi` opts, beside `setConnected`.
 * @returns {{sandbox: object, connectedCalls: boolean[], opts: object}}
 */
function withFetchAndConnectedSpy(response, extraOpts) {
  const sandbox = loadApiHelperGlobals();
  sandbox.fetch = async () => response;
  const connectedCalls = [];
  const opts = Object.assign({ setConnected: (v) => connectedCalls.push(v) }, extraOpts);
  return { sandbox, connectedCalls, opts };
}

const CACHE_FALLBACK = {
  ok: true, status: 200,
  headers: { get: (name) => (name === 'X-TC-Cache-Fallback' ? 'true' : null) },
  json: async () => ({ ok: true })
};

const GATEWAY_DOWN = {
  ok: false, status: 503,
  headers: { get: () => null },
  json: async () => '<html>Bad Gateway</html>'
};

const HEALTHY = {
  ok: true, status: 200,
  headers: { get: () => null },
  json: async () => ({ ok: true })
};

describe('api-helper setConnected debounce (#3332)', () => {
  describe('default behavior: neither knob named -- 100% backward compatible', () => {
    it('reports disconnected on the very first failed call, exactly as before #3332', async () => {
      const { sandbox, connectedCalls, opts } = withFetchAndConnectedSpy(CACHE_FALLBACK);
      const api = sandbox.tcCreateApi(opts);
      await api('/api/config');
      assert.deepEqual(connectedCalls, [false], 'the default must fire immediately -- no caller named a debounce');
    });

    it('with no setConnected option at all, never throws across a failing-then-recovering run', async () => {
      const sandbox = loadApiHelperGlobals();
      const responses = [CACHE_FALLBACK, HEALTHY];
      let i = 0;
      sandbox.fetch = async () => responses[i++];
      const api = sandbox.tcCreateApi();
      for (let n = 0; n < responses.length; n++) await api('/api/config');
    });
  });

  describe('opt-in disconnectThreshold', () => {
    it('does not report disconnected below the threshold', async () => {
      const { sandbox, connectedCalls, opts } = withFetchAndConnectedSpy(CACHE_FALLBACK, { disconnectThreshold: 3 });
      const api = sandbox.tcCreateApi(opts);
      await api('/api/config');
      await api('/api/config');
      assert.deepEqual(connectedCalls, [], 'two consecutive failures are still under an opted-in threshold of 3');
    });

    it('reports disconnected once a run of consecutive failures crosses the threshold', async () => {
      const { sandbox, connectedCalls, opts } = withFetchAndConnectedSpy(CACHE_FALLBACK, { disconnectThreshold: 3 });
      const api = sandbox.tcCreateApi(opts);
      await api('/api/config');
      await api('/api/config');
      await api('/api/config');
      assert.deepEqual(connectedCalls, [false], 'the third consecutive failure crosses the opted-in threshold');
    });

    it('a success before the threshold resets the run -- no flapping to disconnected afterward', async () => {
      const sandbox = loadApiHelperGlobals();
      const connectedCalls = [];
      const responses = [CACHE_FALLBACK, CACHE_FALLBACK, HEALTHY, CACHE_FALLBACK, CACHE_FALLBACK];
      let i = 0;
      sandbox.fetch = async () => responses[i++];
      const api = sandbox.tcCreateApi({ setConnected: (v) => connectedCalls.push(v), disconnectThreshold: 3 });
      for (let n = 0; n < responses.length; n++) await api('/api/config');
      assert.deepEqual(connectedCalls, [true], 'the success reset the failure run, so the two failures after it never crossed the threshold');
    });

    it('reports connected immediately on the very next success after a real outage was reported', async () => {
      const { sandbox, connectedCalls, opts } = withFetchAndConnectedSpy(CACHE_FALLBACK, { disconnectThreshold: 3 });
      const api = sandbox.tcCreateApi(opts);
      await api('/api/config'); await api('/api/config'); await api('/api/config');
      sandbox.fetch = async () => HEALTHY;
      await api('/api/config');
      assert.deepEqual(connectedCalls, [false, true], 'recovery is never debounced, only the trip to disconnected is');
    });

    it('debounces a gateway-down (502/503/504 non-JSON) failure the same way as the cache-fallback path', async () => {
      const { sandbox, connectedCalls, opts } = withFetchAndConnectedSpy(GATEWAY_DOWN, { disconnectThreshold: 3 });
      const api = sandbox.tcCreateApi(opts);
      await api('/api/config');
      await api('/api/config');
      assert.deepEqual(connectedCalls, [], 'two consecutive gateway-down answers are still under the threshold');
      await api('/api/config');
      assert.deepEqual(connectedCalls, [false], 'the third crosses it');
    });

    it('debounces a thrown fetch-level network failure (TypeError) the same way', async () => {
      const sandbox = loadApiHelperGlobals();
      const connectedCalls = [];
      sandbox.fetch = async () => { throw new TypeError('Failed to fetch'); };
      const api = sandbox.tcCreateApi({ setConnected: (v) => connectedCalls.push(v), disconnectThreshold: 3 });
      await api('/api/config');
      await api('/api/config');
      assert.deepEqual(connectedCalls, [], 'two thrown network failures are still under the threshold');
      await api('/api/config');
      assert.deepEqual(connectedCalls, [false], 'the third crosses it');
    });

    it('ignores a threshold of 1 or less -- the default, immediate-fire behavior', async () => {
      const { sandbox, connectedCalls, opts } = withFetchAndConnectedSpy(CACHE_FALLBACK, { disconnectThreshold: 1 });
      const api = sandbox.tcCreateApi(opts);
      await api('/api/config');
      assert.deepEqual(connectedCalls, [false]);
    });
  });

  describe('opt-in flapWindowMs', () => {
    it('suppresses a single failure arriving shortly after a success on the same instance', async () => {
      const sandbox = loadApiHelperGlobals();
      const connectedCalls = [];
      const responses = [HEALTHY, CACHE_FALLBACK];
      let i = 0;
      sandbox.fetch = async () => responses[i++];
      const api = sandbox.tcCreateApi({ setConnected: (v) => connectedCalls.push(v), flapWindowMs: 60000 });
      await api('/api/config');
      await api('/api/config');
      assert.deepEqual(connectedCalls, [true], 'the lone failure right after a known-good success is treated as a blip');
    });

    it('a SECOND consecutive failure still reports disconnected, even within the flap window', async () => {
      const sandbox = loadApiHelperGlobals();
      const connectedCalls = [];
      const responses = [HEALTHY, CACHE_FALLBACK, CACHE_FALLBACK];
      let i = 0;
      sandbox.fetch = async () => responses[i++];
      const api = sandbox.tcCreateApi({ setConnected: (v) => connectedCalls.push(v), flapWindowMs: 60000 });
      for (let n = 0; n < responses.length; n++) await api('/api/config');
      assert.deepEqual(connectedCalls, [true, false], 'two in a row is no longer a lone blip');
    });

    it('does not suppress a failure before this instance has ever seen a success', async () => {
      const { sandbox, connectedCalls, opts } = withFetchAndConnectedSpy(CACHE_FALLBACK, { flapWindowMs: 60000 });
      const api = sandbox.tcCreateApi(opts);
      await api('/api/config');
      assert.deepEqual(connectedCalls, [false], 'a cold start with no known-good baseline is not a "flap"');
    });

    it('does not suppress a failure once the flap window has elapsed since the last success', async () => {
      const sandbox = loadApiHelperGlobals();
      const connectedCalls = [];
      const responses = [HEALTHY, CACHE_FALLBACK];
      let i = 0;
      sandbox.fetch = async () => responses[i++];
      const api = sandbox.tcCreateApi({ setConnected: (v) => connectedCalls.push(v), flapWindowMs: 1 });
      await api('/api/config');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await api('/api/config');
      assert.deepEqual(connectedCalls, [true, false], 'the window elapsed, so this is treated as a real failure, not a flap');
    });

    it('combines with disconnectThreshold: the larger of the two wins', async () => {
      const sandbox = loadApiHelperGlobals();
      const connectedCalls = [];
      const responses = [HEALTHY, CACHE_FALLBACK, CACHE_FALLBACK, CACHE_FALLBACK];
      let i = 0;
      sandbox.fetch = async () => responses[i++];
      const api = sandbox.tcCreateApi({ setConnected: (v) => connectedCalls.push(v), disconnectThreshold: 3, flapWindowMs: 60000 });
      for (let n = 0; n < responses.length; n++) await api('/api/config');
      assert.deepEqual(connectedCalls, [true, false], 'disconnectThreshold (3) already exceeds what the flap window alone would require (2)');
    });
  });
});
