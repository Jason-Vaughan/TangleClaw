'use strict';

/*
 * `lib/auth-gate.js#isMachineClient`'s opt-in service-token requirement
 * (#1973, Ruling A491-W1D-R2).
 *
 * #1973 was filed assuming #1957 REQ2 (a Codex Full Auto permission profile
 * that grants a sandboxed agent every loopback port) had shipped; it never
 * did — built only on the orphaned branch `fix/1836-codex-fullauto-loopback`,
 * never merged to `main`. Ruling A483 (PR #2709) rejected that profile
 * outright instead ("declare it, don't silently fix it"). So the fleet
 * carve-out's four existing conditions (`test/auth-gate.test.js`) are
 * untouched; this file covers only the fifth, OPT-IN condition Ruling
 * A491-W1D-R2 scoped #1973 down to: `requireServiceToken` /
 * `serviceTokenValid`, inert by default (`MACHINE_CLIENT_REQUIRES_SERVICE_TOKEN
 * === false`) so nothing already depending on the carve-out (`bin/tc`, hooks,
 * PortHub, the switchboard) breaks. Flipping the exported constant to `true`
 * is a `server.js` change, out of this car's file envelope.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const authGate = require('../lib/auth-gate');

const S = authGate.GATE_STATES;

// Same fixture shape as `test/auth-gate.test.js`'s own `local` — a loopback,
// unproxied, non-browser, cookieless request, the one shape the four
// existing conditions all pass.
const local = { loopback: true, proxied: false, browserShaped: false, hasSessionCookie: false };

describe('lib/auth-gate — isMachineClient\'s opt-in service-token requirement (#1973, Ruling A491-W1D-R2)', () => {
  it('MACHINE_CLIENT_REQUIRES_SERVICE_TOKEN defaults to false', () => {
    assert.equal(authGate.MACHINE_CLIENT_REQUIRES_SERVICE_TOKEN, false);
  });

  it('with requireServiceToken omitted, behavior is identical to before this option existed — the four existing conditions decide alone', () => {
    assert.equal(authGate.isMachineClient(local), true);
    assert.equal(authGate.isMachineClient({ ...local, loopback: false }), false);
    assert.equal(authGate.isMachineClient({ ...local, proxied: true }), false);
    assert.equal(authGate.isMachineClient({ ...local, browserShaped: true }), false);
    assert.equal(authGate.isMachineClient({ ...local, hasSessionCookie: true }), false);
  });

  it('with requireServiceToken explicitly false, behaves identically too — an explicit false is not a different code path from the default', () => {
    assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: false }), true);
    assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: false, serviceTokenValid: true }), true,
      'a valid token offered when none was required must not somehow refuse');
  });

  describe('requireServiceToken: true', () => {
    it('refuses an otherwise-qualifying loopback machine caller with no token proof', () => {
      assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: true }), false);
    });

    it('refuses when serviceTokenValid is explicitly false', () => {
      assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: false }), false);
    });

    it('refuses a non-boolean serviceTokenValid — fails closed, never coerced to truthy', () => {
      for (const bad of ['true', 1, {}, [], 'yes']) {
        assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: bad }), false, JSON.stringify(bad));
      }
    });

    it('allows only when serviceTokenValid === true AND all four loopback/non-proxied/non-browser/no-cookie conditions hold', () => {
      assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: true }), true);
      // A valid token does not excuse any of the other four — the token adds
      // a requirement, it never substitutes for one.
      assert.equal(authGate.isMachineClient({ ...local, loopback: false, requireServiceToken: true, serviceTokenValid: true }), false);
      assert.equal(authGate.isMachineClient({ ...local, proxied: true, requireServiceToken: true, serviceTokenValid: true }), false);
      assert.equal(authGate.isMachineClient({ ...local, browserShaped: true, requireServiceToken: true, serviceTokenValid: true }), false);
      assert.equal(authGate.isMachineClient({ ...local, hasSessionCookie: true, requireServiceToken: true, serviceTokenValid: true }), false);
    });
  });

  describe('a malformed requireServiceToken — fails closed, same as an explicit true', () => {
    for (const malformed of ['no', 1, {}, [], 'false']) {
      it(`${JSON.stringify(malformed)} requires serviceTokenValid === true, exactly like true does`, () => {
        assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: malformed }), false);
        assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: malformed, serviceTokenValid: true }), true);
        assert.equal(authGate.isMachineClient({ ...local, requireServiceToken: malformed, serviceTokenValid: false }), false);
      });
    }
  });

  describe('evaluate — the isMachineClient verdict flows through unchanged either way', () => {
    const base = {
      method: 'GET', rawUrl: '/api/ports', pathname: '/api/ports',
      gateState: S.ARMED, session: null, submittedCsrf: null
    };

    it('allows a loopback machine call when requireServiceToken is false (today\'s behavior, unchanged)', () => {
      const machineClient = authGate.isMachineClient({ ...local, requireServiceToken: false });
      assert.deepEqual(authGate.evaluate({ ...base, machineClient }), { action: 'allow' });
    });

    it('challenges the same call when requireServiceToken is true and no token was presented', () => {
      const machineClient = authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: false });
      const result = authGate.evaluate({ ...base, machineClient });
      assert.equal(result.action, 'challenge');
    });

    it('allows the same call when requireServiceToken is true and the token validated', () => {
      const machineClient = authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: true });
      assert.deepEqual(authGate.evaluate({ ...base, machineClient }), { action: 'allow' });
    });
  });

  describe('evaluateUpgrade — the same verdict on the WebSocket handshake path', () => {
    const base = { gateState: S.ARMED, session: null };

    it('allows a loopback machine upgrade when requireServiceToken is false (today\'s behavior, unchanged)', () => {
      const machineClient = authGate.isMachineClient({ ...local, requireServiceToken: false });
      assert.deepEqual(authGate.evaluateUpgrade({ ...base, machineClient }), { action: 'allow' });
    });

    it('refuses the same upgrade when requireServiceToken is true and no token was presented', () => {
      const machineClient = authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: false });
      assert.deepEqual(authGate.evaluateUpgrade({ ...base, machineClient }), { action: 'refuse' });
    });

    it('allows the same upgrade when requireServiceToken is true and the token validated', () => {
      const machineClient = authGate.isMachineClient({ ...local, requireServiceToken: true, serviceTokenValid: true });
      assert.deepEqual(authGate.evaluateUpgrade({ ...base, machineClient }), { action: 'allow' });
    });
  });
});
