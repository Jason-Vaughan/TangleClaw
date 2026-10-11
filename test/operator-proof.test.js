'use strict';

/**
 * `server.js#_operatorProofOf`, called directly (#2286).
 *
 * The helper says what an already-admitted operator request rested on, and its
 * answer is what a recovery clear and a recovery-mode decision are recorded
 * with. It reads three things off the request: the login gate's state, the
 * session, and the CSRF token in the header. The routes that call it cannot
 * hold all three conditions: wherever the gate stands down the request handler
 * resolves no session, so a request never reaches the helper with a session
 * and a gate that is not armed. A request object built by hand does, which is
 * why these cases live here and not beside the routes' own tests.
 *
 * The gate states come from `GATE_STATES`, so a state added later is exercised
 * without editing this file.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const authGate = require('../lib/auth-gate');
const { CSRF_HEADER } = require('../lib/auth-session');
const { _operatorProofOf } = require('../server');

const USERNAME = 'the-operator';
const TOKEN = 'a'.repeat(64);
const UNVERIFIED = { clearance: 'open-install-unverified', actor: null };
const VERIFIED = { clearance: 'operator-verified', actor: USERNAME };
const ARMED = authGate.GATE_STATES.ARMED;
const OTHER_STATES = Object.values(authGate.GATE_STATES).filter((state) => state !== ARMED);

/**
 * A request carrying the three things the helper reads, as `handleRequest`
 * would have annotated it. With no overrides it is the fully proven case: an
 * armed gate, a session, and that session's own CSRF token in the header.
 * @param {object} [overrides] - Properties to replace on the proven request
 * @returns {object} The request-shaped object
 */
function provenRequest(overrides = {}) {
  return {
    tcGateState: ARMED,
    tcSession: { username: USERNAME, csrfToken: TOKEN },
    headers: { [CSRF_HEADER]: TOKEN },
    ...overrides
  };
}

/**
 * Assert an answer is one of the helper's two, whole: the two keys and no
 * third, and a word that is one of the two it may say.
 * @param {object} proof - What `_operatorProofOf` returned
 * @param {object} expected - `VERIFIED` or `UNVERIFIED`
 */
function assertProof(proof, expected) {
  assert.deepStrictEqual(Object.keys(proof).sort(), ['actor', 'clearance']);
  assert.deepStrictEqual(proof, expected);
}

describe('_operatorProofOf, called directly (#2286)', () => {
  it('has other gate states to refuse, so the per-state cases below are not vacuous', () => {
    assert.ok(Object.values(authGate.GATE_STATES).includes(ARMED));
    assert.ok(OTHER_STATES.length > 0);
  });

  it('an armed gate, a session and that session\'s CSRF token: operator-verified, naming the session\'s user', () => {
    assertProof(_operatorProofOf(provenRequest()), VERIFIED);
  });

  describe('a gate that is not armed never verifies, whatever else the request carries', () => {
    for (const state of OTHER_STATES) {
      it(`${state}, with a session and its valid CSRF token: open-install-unverified`, () => {
        assertProof(_operatorProofOf(provenRequest({ tcGateState: state })), UNVERIFIED);
      });
    }

    for (const [label, state] of [['a made-up word', 'no-such-gate-state'], ['undefined', undefined], ['null', null]]) {
      it(`a state the helper does not know (${label}), with a session and its valid CSRF token: open-install-unverified`, () => {
        assertProof(_operatorProofOf(provenRequest({ tcGateState: state })), UNVERIFIED);
      });
    }
  });

  describe('an armed gate without a session never verifies', () => {
    for (const [label, session] of [['undefined', undefined], ['null', null]]) {
      it(`session ${label}, with a CSRF token in the header: open-install-unverified`, () => {
        assertProof(_operatorProofOf(provenRequest({ tcSession: session })), UNVERIFIED);
      });
    }
  });

  describe('an armed gate and a session without that session\'s CSRF token never verifies', () => {
    const cases = [
      ['no CSRF header', {}],
      ['an empty CSRF header', { [CSRF_HEADER]: '' }],
      ['a wrong token of another length', { [CSRF_HEADER]: 'not-the-token' }],
      ['a token of the right length and the wrong value', { [CSRF_HEADER]: 'b'.repeat(TOKEN.length) }],
      ['the right token under another header name', { 'x-not-the-csrf-header': TOKEN }]
    ];
    for (const [label, headers] of cases) {
      it(`${label}: open-install-unverified`, () => {
        assertProof(_operatorProofOf(provenRequest({ headers })), UNVERIFIED);
      });
    }

    it('a session that holds no CSRF token of its own: open-install-unverified', () => {
      const request = provenRequest({ tcSession: { username: USERNAME } });
      assertProof(_operatorProofOf(request), UNVERIFIED);
    });
  });
});
