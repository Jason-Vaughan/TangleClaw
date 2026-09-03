'use strict';

/*
 * #1178 — the prime must name the host the OPERATOR actually reaches this
 * machine on, not the host this machine calls itself.
 *
 * The operator is almost never on this box. `_localHost()` answers "what is
 * this machine called", which is the right default and the wrong question the
 * moment they arrive through a reverse proxy on some other name: the prime then
 * states a host they are not using, confidently.
 *
 * Two failure modes this file exists to prevent, both seen in a rejected first
 * attempt at this fix:
 *   1. The option is set on the way in and never forwarded to the generator, so
 *      the whole feature is dead code that no test notices.
 *   2. `x-forwarded-host` is believed unconditionally. It is caller-supplied and
 *      what reads it lands in hidden model context, so an ungated read lets
 *      anyone who can reach the port steer the agent's links.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sessionOwnership = require('../lib/session-ownership');
const authIdentity = require('../lib/auth-identity');
const ecosystemPrimer = require('../lib/ecosystem-primer');

const GATE_LIVE = { ingressMode: 'caddy', authEnabled: true };
const GATE_OFF = { ingressMode: 'direct', authEnabled: true };

describe('#1178 isProxyHeaderTrusted — one predicate, two headers', () => {
  it('is live only for caddy ingress WITH the gate enabled', () => {
    assert.equal(authIdentity.isProxyHeaderTrusted(GATE_LIVE), true);
    assert.equal(authIdentity.isProxyHeaderTrusted({ ingressMode: 'caddy', authEnabled: false }), false);
    assert.equal(authIdentity.isProxyHeaderTrusted({ ingressMode: 'direct', authEnabled: true }), false);
    assert.equal(authIdentity.isProxyHeaderTrusted(null), false);
  });

  it('the identity header decides trust through the predicate, not its own copy', () => {
    // Both headers must answer to ONE trust decision. `resolveAuthStatus` also
    // mentions ingressMode, but asks a different question (the auth-status
    // tri-state), so counting the conjunction file-wide measures the wrong
    // thing — pin the trust path itself.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth-identity.js'), 'utf8');
    // Body only: the slice up to the next function also swallows a doc comment
    // that legitimately NAMES ingressMode, which is prose, not a trust decision.
    const from = src.indexOf('function resolveRequestUser');
    const body = src.slice(from, src.indexOf('\n}', from) + 2);
    assert.match(body, /isProxyHeaderTrusted\(config\)/,
      'resolveRequestUser must route its trust decision through the shared predicate');
    assert.doesNotMatch(body, /ingressMode/,
      'resolveRequestUser re-spells the gate instead of calling it');
  });
});

describe('#1178 resolveOperatorHost — measured, gated, and never invented', () => {
  it('prefers the forwarded host when the proxy gate is live', () => {
    const r = sessionOwnership.resolveOperatorHost(
      { 'x-forwarded-host': 'tc.example.com:3102', host: 'inner.local:3102' }, GATE_LIVE);
    assert.deepEqual(r, { host: 'tc.example.com', source: 'forwarded-host' });
  });

  it('IGNORES the forwarded host when the gate is not live', () => {
    // The security property: without a trusted proxy in front, this header is
    // just a string the caller chose, and it ends up in hidden model context.
    const r = sessionOwnership.resolveOperatorHost(
      { 'x-forwarded-host': 'attacker.example.com', host: 'real.example.com:3102' }, GATE_OFF);
    assert.equal(r.host, 'real.example.com');
    assert.equal(r.source, 'host');
  });

  it('strips the port — the consumers append their own', () => {
    // Host headers carry `name:3102`; the primer renders `http://<host>:<port>`,
    // so passing the raw value through produced `host:3102:8080`.
    assert.equal(sessionOwnership.resolveOperatorHost({ host: 'box.ts.net:3102' }, GATE_OFF).host, 'box.ts.net');
  });

  it('takes the first entry of a chained forwarded header', () => {
    const r = sessionOwnership.resolveOperatorHost(
      { 'x-forwarded-host': 'edge.example.com, inner.internal' }, GATE_LIVE);
    assert.equal(r.host, 'edge.example.com');
  });

  it('refuses a duplicated header rather than guessing', () => {
    const r = sessionOwnership.resolveOperatorHost({ host: ['a.example.com', 'b.example.com'] }, GATE_OFF);
    assert.notEqual(r.source, 'host');
  });

  it('refuses a loopback name as an OPERATOR host', () => {
    // "Never hand the operator a localhost link; use http://localhost:<port>"
    // is a sentence that contradicts itself.
    for (const bad of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0']) {
      const r = sessionOwnership.resolveOperatorHost({ host: bad }, GATE_OFF);
      assert.notEqual(r.source, 'host', `${bad} must not be accepted as the operator's host`);
    }
  });

  it('refuses a value that is not hostname-shaped', () => {
    for (const bad of ['$(rm -rf /)', 'a b c', 'x'.repeat(300), '../../etc', '']) {
      const r = sessionOwnership.resolveOperatorHost({ host: bad }, GATE_OFF);
      assert.notEqual(r.source, 'host', `${JSON.stringify(bad)} must not reach a generated sentence`);
    }
  });

  it('keeps a bracketed IPv6 literal intact', () => {
    assert.equal(sessionOwnership.resolveOperatorHost({ host: '[2001:db8::1]:3102' }, GATE_OFF).host, '[2001:db8::1]');
  });

  it('falls back to probing this machine when there is no usable header', () => {
    const r = sessionOwnership.resolveOperatorHost(undefined, GATE_OFF);
    assert.ok(r.source === 'local-probe' || r.host === null);
  });

  it('never returns a loopback host from ANY path', () => {
    // The property, across every input shape — not one example of it.
    const inputs = [undefined, {}, { host: 'localhost' }, { host: '127.0.0.1:3102' },
      { 'x-forwarded-host': 'localhost' }, { host: '::1' }];
    for (const headers of inputs) {
      for (const cfg of [GATE_LIVE, GATE_OFF, null]) {
        const { host } = sessionOwnership.resolveOperatorHost(headers, cfg);
        if (host !== null) {
          assert.ok(!sessionOwnership.NON_OPERATOR_HOSTS.includes(String(host).toLowerCase()),
            `resolved a non-operator host ${host}`);
        }
      }
    }
  });
});

describe('#1178 the primer states the unknown instead of inventing a host', () => {
  const ctx = (operatorHost) => ({ projectId: 1, projectName: 'p', apiOrigin: 'http://api', operatorHost });
  const line = (h) => String(ecosystemPrimer.buildEcosystemPrimerSection(ctx(h)))
    .split('\n').find((l) => l.includes('Never hand the operator'));

  it('names the host when one was established', () => {
    assert.match(line('box.ts.net'), /http:\/\/box\.ts\.net:<port>/);
  });

  it('asks rather than guessing when none was', () => {
    const l = line(null);
    assert.match(l, /could not establish/);
    assert.match(l, /ask them/);
    assert.doesNotMatch(l, /http:\/\/(null|undefined|localhost):/);
  });

  it('renders exactly one operator-host sentence — never two producers', () => {
    // A second block stating the same fact would contradict this one inside a
    // single prime, which is worse than either alone.
    const section = String(ecosystemPrimer.buildEcosystemPrimerSection(ctx('box.ts.net')));
    const hits = section.split('\n').filter((l) => l.includes('Never hand the operator'));
    assert.equal(hits.length, 1);
  });
});

describe('#1178 the value is actually FORWARDED to the generator', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sessions.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('launchSession passes operatorHost into generatePrimePrompt', () => {
    // The defect this pins: the option was set on the way in and the generator
    // call was never touched, so the feature could not run at all and the suite
    // could not tell. Assert the option reaches the ONE call that builds a prime.
    const call = src.match(/generatePrimePrompt\(project, engineProfile, \{[^}]*\}/);
    assert.ok(call, 'the prime generation call moved — re-point this guard');
    assert.match(call[0], /operatorHost/,
      'operatorHost is not forwarded, so the whole path is dead code');
  });

  it('the launch route resolves it from the request, beside the owner', () => {
    assert.match(server, /resolveOperatorHost\(_req\.headers, store\.config\.load\(\)\)/);
    assert.match(server, /^\s*operatorHost,$/m);
  });

  it('server.js can actually reach the resolver', () => {
    // `node --check` passes on an unbound identifier; a missing require here
    // throws only when the route is hit.
    assert.match(server, /^const sessionOwnership = require\('\.\/lib\/session-ownership'\);$/m);
  });

  it('whoami reports the same measured host, not a second probe of the box', () => {
    assert.doesNotMatch(server, /require\('\.\/lib\/session-ownership'\)\._localHost\(\)/,
      'whoami still probes the machine directly instead of using the shared resolver');
  });
});
