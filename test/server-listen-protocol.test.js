'use strict';

// The startup banner must describe the socket that exists, not the config that
// asked for it (#616). On a fresh install the shipped default is
// `httpsEnabled: true` with no certificates, so `createServer` falls back to
// plain HTTP — and the banner, derived from config, announced
// `listening on https://*:3101 … https=true` two lines after logging the
// fallback itself. The first URL a new operator trusts pointed at a scheme the
// server does not speak, sending them to debug certificates never in play.
//
// These tests pin the predicate the banner reads. They are deliberately about
// the FALLBACK paths: that is where intent and reality diverge, and the only
// place the old derivation was wrong.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error'); // the fallback paths log WARNs by design

const { createServer, serverProtocol } = require('../server');

describe('startup protocol reporting (#616)', () => {
  describe('serverProtocol reads the constructed server, not config intent', () => {
    it('reports http for a plain HTTP server', () => {
      assert.equal(serverProtocol(http.createServer()), 'http');
    });

    it('reports https for an HTTPS server', () => {
      // Control: without this, every other assertion here would also pass for a
      // predicate hard-wired to return 'http'. No certificate material is
      // needed — the class of the constructed object is what the banner reads,
      // and binding this to a real keypair would tie the suite to whatever
      // certs happen to exist on the machine.
      assert.equal(serverProtocol(https.createServer()), 'https');
    });
  });

  describe('the fresh-install path: HTTPS requested, no certificates', () => {
    it('falls back to a plain HTTP server', () => {
      const server = createServer({ httpsEnabled: true, certPath: null, keyPath: null });
      assert.ok(!(server instanceof https.Server),
        'no cert/key means the socket cannot serve TLS');
    });

    it('reports http — NOT the https the config asked for', () => {
      // This is the exact regression: config says https, reality is http, and
      // the banner must side with reality.
      const server = createServer({ httpsEnabled: true, certPath: null, keyPath: null });
      assert.equal(serverProtocol(server), 'http',
        'the banner must report the effective protocol after the fallback');
    });
  });

  describe('HTTPS requested with unusable certificate paths', () => {
    it('falls back and reports http', () => {
      const missing = path.join(os.tmpdir(), 'tc-does-not-exist-cert.pem');
      const server = createServer({ httpsEnabled: true, certPath: missing, keyPath: missing });
      assert.equal(serverProtocol(server), 'http',
        'an unreadable cert falls back to HTTP, and the banner must say so');
    });
  });

  describe('HTTPS not requested', () => {
    it('reports http', () => {
      const server = createServer({ httpsEnabled: false });
      assert.equal(serverProtocol(server), 'http');
    });
  });

  // The behavioral tests above pin the predicate; they cannot see whether the
  // banner still USES it. The original defect was precisely a correct fallback
  // paired with a banner that read config instead — so re-deriving the scheme
  // from `effectiveHttps` at the log site would reintroduce #616 with every
  // test above still green. The banner lives inside `require.main === module`
  // and is not reachable from a unit test, so this coupling is pinned at the
  // source level. It is a structural check standing in for an unreachable
  // behavioral one, not a preference about how the line is written.
  describe('the startup banner is wired to the predicate', () => {
    const fs = require('node:fs');
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    it('derives the listen protocol from serverProtocol(server)', () => {
      assert.match(serverSource, /const protocol = serverProtocol\(server\)/,
        'the listen banner must take its scheme from the constructed server');
    });

    it('does not derive the listen protocol from config intent', () => {
      assert.doesNotMatch(serverSource, /const protocol = effectiveHttps/,
        'deriving the banner from config intent is the #616 regression');
    });

    it('flags the divergence when HTTPS was requested but is not being served', () => {
      // Reporting `http` is honest but silent about WHY, and the fallback WARN
      // it points back at scrolls away in a busy startup. The marker is what
      // links the two lines for an operator reading the log after the fact —
      // which is the normal case here, since the operator is rarely at the
      // machine. Structural for the same reason as the pins above: the banner
      // is inside `require.main === module`.
      assert.match(serverSource, /effectiveHttps && !servingHttps \? \{ httpsFallback: true \}/,
        'the banner must mark the intent-vs-reality divergence');
    });
  });

  // Same principle on the port axis (#654): the shared port derivation falls back
  // silently on an unbindable TANGLECLAW_PORT because it also runs on every config
  // regeneration. That silence would otherwise swallow the hard
  // ERR_SOCKET_BAD_PORT the old raw-string `listen()` raised, leaving the server
  // bound where the plist, install.sh's health check, and any Caddy upstream would
  // not find it. Boot is where the noise belongs, so boot is what these pin.
  describe('warnUnbindablePortEnv (#654)', () => {
    const { warnUnbindablePortEnv } = require('../server');

    /** Collect log.error calls instead of emitting them. */
    function spyLogger() {
      const calls = [];
      return { calls, error: (msg, meta) => calls.push({ msg, meta }) };
    }

    it('errors on a non-empty TANGLECLAW_PORT the server could never bind', () => {
      for (const bad of ['abc', '0', '-1', '65536', '3102.5', '0x10', '1e3']) {
        const spy = spyLogger();
        assert.equal(warnUnbindablePortEnv(3101, { TANGLECLAW_PORT: bad }, spy), true,
          `${JSON.stringify(bad)} must be reported`);
        assert.equal(spy.calls.length, 1);
        assert.equal(spy.calls[0].meta.tangleclawPortEnv, bad);
        assert.equal(spy.calls[0].meta.portInUse, 3101,
          'the operator needs the port actually in use, not just the bad value');
        assert.match(spy.calls[0].msg, /com\.tangleclaw\.server\.plist/,
          'must name the file to edit — the plist is where this value comes from');
      }
    });

    it('stays silent when TANGLECLAW_PORT names a bindable port', () => {
      const spy = spyLogger();
      assert.equal(warnUnbindablePortEnv(3102, { TANGLECLAW_PORT: '3102' }, spy), false);
      assert.equal(spy.calls.length, 0);
    });

    it('treats unset or empty as no override, not as a misconfiguration', () => {
      // An empty value is what an unset plist key looks like; warning about it
      // would point the operator at a plist line that is fine.
      for (const env of [{}, { TANGLECLAW_PORT: '' }, { TANGLECLAW_PORT: '   ' }]) {
        const spy = spyLogger();
        assert.equal(warnUnbindablePortEnv(3101, env, spy), false, JSON.stringify(env));
        assert.equal(spy.calls.length, 0);
      }
    });

    it('is wired into boot before the port is used', () => {
      // Structural: the call sits inside `require.main === module`, so it cannot
      // be exercised directly. Pin that it is called with the resolved port and
      // that it precedes the PortHub bootstrap which consumes that port.
      const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
      const callIdx = src.indexOf('warnUnbindablePortEnv(port)');
      const bootstrapIdx = src.indexOf('porthub.bootstrap(');
      assert.ok(callIdx > 0, 'boot must call warnUnbindablePortEnv with the resolved port');
      assert.ok(callIdx < bootstrapIdx,
        'the warning must precede the bootstrap that consumes the port');
    });
  });
});
