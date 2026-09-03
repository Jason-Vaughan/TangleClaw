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
    assert.match(line('box.ts.net'), /http\(s\):\/\/box\.ts\.net:<port>/);
  });

  it('asks rather than guessing when none was', () => {
    const l = line(null);
    assert.match(l, /could not establish which host/);
    assert.match(l, /ask, do not guess/);
    assert.doesNotMatch(l, /http\(?s?\)?:\/\/(null|undefined|localhost):/);
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

  it('the primerCtx honours the forwarded value instead of re-probing', () => {
    // R-2: the forwarding guard pins the CALL, so replacing the decision with a
    // bare `resolveOperatorHost().host` kills the feature while staying green —
    // the request's measurement is silently discarded and the box is probed
    // again. Pin the decision, not just the argument list.
    const decision = src.slice(src.indexOf('const primerCtx = {'), src.indexOf('sections.push(_yieldable(0,'));
    assert.match(decision, /options\.operatorHost !== undefined/,
      'the primerCtx must prefer the request-measured host over a fresh probe');
    assert.match(decision, /options\.operatorHost\s*$/m);
  });

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

describe('#1178 the operator-link directive has ONE producer', () => {
  const files = ['lib/ecosystem-primer.js', 'server.js', 'lib/tc-verbs.js'];

  it('no consumer interpolates the host into a URL itself', () => {
    // The defect: `.host` became nullable and only the primer learned the null
    // branch, so `tc whoami` rendered `http(s)://null:<port>` — a fabricated
    // URL in generated instruction text. A hand-built copy of this sentence is
    // a branch someone will get wrong, so there must not be one.
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert.doesNotMatch(src, /http\(s\)?:\/\/\$\{operatorHost\}/,
        `${f} composes the operator URL itself instead of using operatorLinkDirective`);
      assert.doesNotMatch(src, /http:\/\/\$\{ctx\.operatorHost\}/,
        `${f} composes the operator URL itself instead of using operatorLinkDirective`);
    }
  });

  it('the unknown branch never yields a URL at all', () => {
    const unknown = sessionOwnership.operatorLinkDirective(null);
    assert.doesNotMatch(unknown, /http/, 'the unknown case must not name any URL');
    assert.match(unknown, /could not establish which host/);
    assert.match(unknown, /ask, do not guess/);
  });

  it('the known branch names the host exactly once, with a port placeholder', () => {
    const known = sessionOwnership.operatorLinkDirective('box.ts.net');
    assert.match(known, /http\(s\):\/\/box\.ts\.net:<port>/);
    assert.doesNotMatch(known, /box\.ts\.net:<port>.*box\.ts\.net/);
  });

  it('every consumer renders BOTH branches without printing null', () => {
    const so = sessionOwnership;
    for (const host of ['box.ts.net', null]) {
      const primer = String(ecosystemPrimer.buildEcosystemPrimerSection(
        { projectId: 1, projectName: 'p', apiOrigin: 'http://api', operatorHost: host }));
      assert.doesNotMatch(primer, /null|undefined/);
      const note = so.operatorLinkDirective(host);
      assert.doesNotMatch(note, /null|undefined/);
    }
  });
});

describe('#1178 the probe path is held to the same rule as the header path', () => {
  it('returns null rather than a loopback name when the probe yields one', () => {
    // On a machine with tailscale this branch never runs, so the check that
    // guards it was unexercised: deleting it stayed green. Force the probe to
    // produce exactly the value that must be refused.
    const realExec = sessionOwnership._internal.execSync;
    const realHostname = sessionOwnership._internal.hostname;
    sessionOwnership._internal.execSync = () => { throw new Error('no tailscale'); };
    sessionOwnership._internal.hostname = () => 'localhost';
    sessionOwnership._resetHostCacheForTest();
    try {
      const r = sessionOwnership.resolveOperatorHost({}, { ingressMode: 'direct' });
      assert.equal(r.host, null, 'a loopback probe result must not become the operator host');
      assert.equal(r.source, null);
    } finally {
      sessionOwnership._internal.execSync = realExec;
      sessionOwnership._internal.hostname = realHostname;
      sessionOwnership._resetHostCacheForTest();
    }
  });

  it('accepts a real probed name', () => {
    const realExec = sessionOwnership._internal.execSync;
    const realHostname = sessionOwnership._internal.hostname;
    sessionOwnership._internal.execSync = () => { throw new Error('no tailscale'); };
    sessionOwnership._internal.hostname = () => 'box.local';
    sessionOwnership._resetHostCacheForTest();
    try {
      const r = sessionOwnership.resolveOperatorHost({}, { ingressMode: 'direct' });
      assert.equal(r.host, 'box.local');
      assert.equal(r.source, 'local-probe');
    } finally {
      sessionOwnership._internal.execSync = realExec;
      sessionOwnership._internal.hostname = realHostname;
      sessionOwnership._resetHostCacheForTest();
    }
  });
});

describe('#1178 tc whoami never prints a fabricated host', () => {
  const tcVerbs = require('../lib/tc-verbs.js');
  const payload = (host) => ({
    project: { name: 'p', id: 1 },
    sessionId: 's1',
    api: { origin: 'http://localhost:3102', note: 'n' },
    operator: { host, note: sessionOwnership.operatorLinkDirective(host) },
    capabilities: []
  });

  it('renders the host when there is one', () => {
    const out = tcVerbs.renderWhoami(payload('box.ts.net'));
    assert.match(out, /Operator host: box\.ts\.net/);
  });

  it('says unknown rather than printing null', () => {
    // The CLI line interpolated `.host` directly, so the nullable resolver
    // surfaced as the literal string "null" beside a note saying nothing
    // could be established.
    const out = tcVerbs.renderWhoami(payload(null));
    assert.doesNotMatch(out, /Operator host: null/);
    assert.doesNotMatch(out, /undefined/);
    assert.match(out, /Operator host: unknown/);
    assert.match(out, /ask, do not guess/);
  });
});

describe('#1178 the fact is Tailscale-INDEPENDENT', () => {
  /** Run fn with the local probe forced to a no-tailscale machine. */
  function withoutTailscale(hostname, fn) {
    const realExec = sessionOwnership._internal.execSync;
    const realHostname = sessionOwnership._internal.hostname;
    sessionOwnership._internal.execSync = () => { throw new Error('tailscale: command not found'); };
    sessionOwnership._internal.hostname = () => hostname;
    sessionOwnership._resetHostCacheForTest();
    try { return fn(); } finally {
      sessionOwnership._internal.execSync = realExec;
      sessionOwnership._internal.hostname = realHostname;
      sessionOwnership._resetHostCacheForTest();
    }
  }

  it('works for every way an operator without Tailscale reaches this box', () => {
    // Most installs have no MagicDNS name. A MagicDNS name is one possible
    // VALUE of this fact, reached only by the last-resort probe — never the
    // mechanism the feature depends on.
    withoutTailscale('Jasons-MacBook.local', () => {
      const cases = [
        ['192.168.20.5:3102', '192.168.20.5'],
        ['jasons-macbook.local:3102', 'jasons-macbook.local'],
        ['tc.myhomelab.dev', 'tc.myhomelab.dev'],
        ['10.0.0.7', '10.0.0.7']
      ];
      for (const [sent, expected] of cases) {
        const r = sessionOwnership.resolveOperatorHost({ host: sent }, { ingressMode: 'direct' });
        assert.equal(r.host, expected, `Host: ${sent}`);
        assert.equal(r.source, 'host');
      }
    });
  });

  it('falls back to the plain OS hostname when there is no Tailscale and no header', () => {
    withoutTailscale('jasons-macbook.local', () => {
      const r = sessionOwnership.resolveOperatorHost({}, { ingressMode: 'direct' });
      assert.equal(r.host, 'jasons-macbook.local');
      assert.equal(r.source, 'local-probe');
    });
  });

  it('renders a non-Tailscale host into the primer normally', () => {
    const section = String(ecosystemPrimer.buildEcosystemPrimerSection(
      { projectId: 1, projectName: 'p', apiOrigin: 'http://api', operatorHost: '192.168.20.5' }));
    assert.match(section, /http\(s\):\/\/192\.168\.20\.5:<port>/);
    assert.doesNotMatch(section, /ts\.net/);
  });
});
