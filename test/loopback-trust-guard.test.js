'use strict';

/*
 * #1957: the guard that decides whether a sandboxed agent may be given
 * loopback. It must grant only when every fact is present and exactly the
 * value that grants, and withhold on anything missing, malformed or unknown.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../lib/loopback-trust-guard');
const authGate = require('../lib/auth-gate');
const { grantingFacts, SOCKET } = require('./_loopback-trust');

/**
 * The verdict for the granting facts with one change applied.
 * @param {(f: object) => void} mutate - Edits a fresh copy of the facts.
 * @returns {object}
 */
function assessWith(mutate) {
  const facts = grantingFacts();
  facts.config = { ...facts.config };
  facts.ttydArgs = [...facts.ttydArgs];
  mutate(facts);
  return guard.assessLoopbackTrust(facts);
}

describe('lib/loopback-trust-guard.js (#1957)', () => {
  it('grants only when ttyd is on the caddy socket and loopback API access needs the service token', () => {
    const v = guard.assessLoopbackTrust(grantingFacts());
    assert.equal(v.granted, true);
    assert.equal(v.code, guard.CODES.GRANTED);
    assert.equal(guard.isGranted(v), true);
    assert.ok(Object.isFrozen(v));
  });

  it('withholds when the facts, or the config, are missing', () => {
    for (const facts of [undefined, null, 'facts', 42]) {
      assert.equal(guard.assessLoopbackTrust(facts).code, guard.CODES.FACTS_UNKNOWN, String(facts));
    }
    for (const config of [null, undefined, 'caddy', 0]) {
      assert.equal(assessWith((f) => { f.config = config; }).code, guard.CODES.FACTS_UNKNOWN, String(config));
    }
  });

  it('withholds unless ingress mode is exactly caddy', () => {
    for (const mode of ['direct', undefined, null, 'Caddy', ' caddy', true]) {
      const v = assessWith((f) => { f.config.ingressMode = mode; });
      assert.equal(v.code, guard.CODES.TTYD_ON_TCP, String(mode));
      assert.equal(guard.isGranted(v), false);
    }
  });

  it('withholds when the installed ttyd job cannot be read or is not a list of strings', () => {
    for (const args of [null, undefined, 'args', [SOCKET, 3100], {}]) {
      assert.equal(assessWith((f) => { f.ttydArgs = args; }).code, guard.CODES.TTYD_BIND_UNKNOWN, JSON.stringify(args));
    }
  });

  it('withholds when the installed job is on TCP, on any interface, or on a socket TangleClaw does not manage', () => {
    const cases = [
      ['/opt/ttyd', '--writable', '--port', '3100'],
      ['/opt/ttyd', '--interface', '127.0.0.1', '--port', '3100'],
      ['/opt/ttyd', '--interface', '0.0.0.0'],
      ['/opt/ttyd', '--interface', 'lo0'],
      ['/opt/ttyd', '--interface', '/tmp/somewhere-else.sock'],
      ['/opt/ttyd', '--interface']
    ];
    for (const args of cases) {
      assert.equal(assessWith((f) => { f.ttydArgs = args; }).code, guard.CODES.TTYD_ON_TCP, args.join(' '));
    }
  });

  it('withholds when the socket path to check against is unknown', () => {
    for (const p of [null, undefined, '', 'run/ttyd.sock']) {
      assert.equal(assessWith((f) => { f.ttydSocketPath = p; }).code, guard.CODES.TTYD_BIND_UNKNOWN, String(p));
    }
  });

  it('withholds unless the service-token gate is on with a token', () => {
    const cases = [
      (f) => { f.config.serviceTokenEnabled = false; },
      (f) => { delete f.config.serviceTokenEnabled; },
      (f) => { f.config.serviceTokenEnabled = 'true'; },
      (f) => { f.config.serviceToken = ''; },
      (f) => { f.config.serviceToken = null; },
      (f) => { delete f.config.serviceToken; }
    ];
    for (const mutate of cases) {
      assert.equal(assessWith(mutate).code, guard.CODES.LOOPBACK_API_UNAUTHENTICATED, mutate.toString());
    }
  });

  it('withholds unless the API demands the token of a loopback machine client, and treats unknown as no', () => {
    for (const v of [false, undefined, null, 'true', 1]) {
      assert.equal(assessWith((f) => { f.machineClientRequiresServiceToken = v; }).code, guard.CODES.LOOPBACK_API_UNAUTHENTICATED, String(v));
    }
  });

  it('recognises only grants it issued: not a lookalike, a copy, or a withheld verdict', () => {
    const real = guard.assessLoopbackTrust(grantingFacts());
    const withheld = assessWith((f) => { f.machineClientRequiresServiceToken = false; });
    for (const v of [undefined, null, true, {}, { granted: true }, { ...real }, Object.assign(Object.create(real), {}), withheld]) {
      assert.equal(guard.isGranted(v), false, JSON.stringify(v));
    }
  });
});

describe('MACHINE_CLIENT_REQUIRES_SERVICE_TOKEN matches what the gate does (#1957)', () => {
  it('is false exactly while evaluate admits a loopback machine client with no token', () => {
    // An enforcing gate, no session, no token, a privileged route.
    const verdict = authGate.evaluate({
      method: 'POST', rawUrl: '/api/config', pathname: '/api/config',
      gateState: authGate.GATE_STATES.LOCKED, session: null, submittedCsrf: null, machineClient: true
    });
    const admitsWithoutToken = verdict.action === 'allow';
    assert.equal(authGate.MACHINE_CLIENT_REQUIRES_SERVICE_TOKEN, !admitsWithoutToken,
      'change the declaration together with the behaviour: the loopback profile relies on it');
  });
});
