'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gf = require('../lib/gate-fallback');
const caddy = require('../lib/caddy');
const drift = require('../lib/caddy-drift');
const {
  FIXTURE_CADDYFILES, FIXTURE_SERVER_PORT, FIXTURE_HTTPS_PORT, FIXTURE_HTTP_PORT, FIXTURE_TAILNET_HOST
} = require('./_caddy-drift-fixtures');

// The door checks read committed `caddy adapt` output (test/fixtures), which
// `caddy-drift — against real caddy` re-derives from the same Caddyfiles
// whenever caddy is installed. Synthetic JSON is used only for shapes Caddy's
// Caddyfile adapter cannot be asked to produce from a fixture here (a plugin
// app, a named route, an unknown handler).
const fixture = (name) => JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', `caddy-adapt-${name}.json`), 'utf8')
);
const PORT = FIXTURE_SERVER_PORT;
const proxy = (port = PORT) => ({ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${port}` }] });
const auth = () => ({ handler: 'authentication', providers: { http_basic: { accounts: [] } } });
const site = (routes, extra = {}) => ({
  apps: { http: { servers: { srv0: { listen: [':8443'], tls_connection_policies: [{}], routes, ...extra } } } }
});
const hostRoute = (host, inner) => ({
  match: [{ host: [host] }], handle: [{ handler: 'subroute', routes: inner }], terminal: true
});

describe('lib/gate-fallback — the door TangleClaw may stand down behind (#1420)', () => {
  describe('checkFallbackDoor against real caddy adapt output', () => {
    it('accepts the generated gated file and lists every site to probe', () => {
      const door = gf.checkFallbackDoor(fixture('generated'), PORT);
      assert.equal(door.ok, true, door.reason);
      assert.deepEqual(door.probes, [
        { port: FIXTURE_HTTPS_PORT, tls: true, host: FIXTURE_TAILNET_HOST },
        { port: FIXTURE_HTTPS_PORT, tls: true, host: 'localhost' }
      ]);
    });

    it('refuses the armed file — no gate in front of TangleClaw at all', () => {
      const door = gf.checkFallbackDoor(fixture('armed'), PORT);
      assert.equal(door.ok, false);
      assert.match(door.reason, /without passing Caddy's gate/);
      assert.deepEqual(door.probes, []);
    });

    it('accepts the live install\'s hand-maintained shape when every route is gated', () => {
      const door = gf.checkFallbackDoor(fixture('live-shape-gated'), PORT);
      assert.equal(door.ok, true, door.reason);
      const hosts = door.probes.map((p) => `${p.port}/${p.tls}/${p.host}`).sort();
      assert.deepEqual(hosts, [
        `${FIXTURE_HTTPS_PORT}/true/${FIXTURE_TAILNET_HOST}`,
        `${FIXTURE_HTTPS_PORT}/true/localhost`,
        `${FIXTURE_HTTP_PORT}/false/null`
      ].sort());
    });

    it('refuses that shape with the ungated /openclaw-direct/* handle — the #472 decision', () => {
      // A merged-site reading (the drift check's P1) accepts this file: one gate
      // sits in the same site. Here TangleClaw is about to stop asking, and that
      // handle forwards the gateway token to whoever asks.
      const adapted = fixture('live-shape-own-auth');
      assert.equal(drift.checkGates(drift.summarizeConfig(adapted).sites,
        drift.summarizeConfig(fixture('generated')).sites).status, drift.HOLDS);
      const door = gf.checkFallbackDoor(adapted, PORT);
      assert.equal(door.ok, false);
      assert.match(door.reason, new RegExp(FIXTURE_TAILNET_HOST.replace(/\./g, '\\.')));
      assert.match(door.reason, /openclaw-direct/);
    });

    it('accepts a file whose only TangleClaw site refuses other machines, with nothing to probe', () => {
      const door = gf.checkFallbackDoor(fixture('ungated'), PORT);
      assert.equal(door.ok, true, door.reason);
      assert.deepEqual(door.probes, []);
    });

    it('refuses the pre-guard ungated file — localhost in name only', () => {
      assert.equal(gf.checkFallbackDoor(fixture('ungated-unguarded'), PORT).ok, false);
    });

    it('ignores a site that proxies somewhere other than TangleClaw', () => {
      // The hand-added block fronts another project's port with no gate — P3's to
      // report, and not a way to TangleClaw.
      const door = gf.checkFallbackDoor(fixture('hand-edited'), PORT);
      assert.equal(door.ok, true, door.reason);
    });

    it('judges the port it is given — a different TangleClaw port reaches none of these sites', () => {
      assert.deepEqual(gf.checkFallbackDoor(fixture('armed'), PORT + 1), { ok: true, reason: null, probes: [] });
    });
  });

  describe('checkFallbackDoor — shapes read strictly', () => {
    it('refuses a Caddy app it cannot read', () => {
      const adapted = fixture('generated');
      adapted.apps.layer4 = { servers: {} };
      const door = gf.checkFallbackDoor(adapted, PORT);
      assert.equal(door.ok, false);
      assert.match(door.reason, /layer4/);
    });

    it('refuses named routes, which `invoke` can reach from anywhere', () => {
      const door = gf.checkFallbackDoor(site([hostRoute('a.example', [{ handle: [auth(), proxy()] }])],
        { named_routes: { x: { handle: [proxy()] } } }), PORT);
      assert.equal(door.ok, false);
      assert.match(door.reason, /named routes/);
    });

    it('refuses an unknown handler met before the gate', () => {
      const door = gf.checkFallbackDoor(site([hostRoute('a.example', [
        { handle: [{ handler: 'invoke', name: 'x' }] },
        { handle: [auth(), proxy()] }
      ])]), PORT);
      assert.equal(door.ok, false);
      assert.match(door.reason, /invoke/);
    });

    it('refuses an error route that forwards to TangleClaw ungated', () => {
      const door = gf.checkFallbackDoor(site([hostRoute('a.example', [{ handle: [auth(), proxy()] }])],
        { errors: { routes: [{ handle: [proxy()] }] } }), PORT);
      assert.equal(door.ok, false);
      assert.match(door.reason, /error route/);
    });

    it('a gate narrowed by any matcher but the generator\'s covers only its own route', () => {
      // `not path` is case-insensitive in Caddy, so it is not the generator's
      // gate, and the sibling proxy after it is reachable for the spellings it
      // exempts.
      const narrowed = [
        { match: [{ not: [{ path: ['/api/health'] }] }], handle: [auth()] },
        { handle: [proxy()] }
      ];
      assert.equal(gf.checkFallbackDoor(site([hostRoute('a.example', narrowed)]), PORT).ok, false);
      // A case-sensitive exemption that is wider than TangleClaw's list.
      const widened = [
        { match: [{ not: [{ path_regexp: { pattern: '^/api/.*$' } }] }], handle: [auth()] },
        { handle: [proxy()] }
      ];
      assert.equal(gf.checkFallbackDoor(site([hostRoute('a.example', widened)]), PORT).ok, false);
      const generatorForm = [
        { match: [{ not: [{ path_regexp: { pattern: caddy.bypassPathRegexp() } }] }], handle: [auth()] },
        { handle: [proxy()] }
      ];
      assert.equal(gf.checkFallbackDoor(site([hostRoute('a.example', generatorForm)]), PORT).ok, true);
    });

    it('lets a route matching only TangleClaw\'s own bypass paths proxy ungated', () => {
      const routes = [
        { match: [{ path: ['/api/health', '/manifest.json'] }], handle: [proxy()] },
        { handle: [auth(), proxy()] }
      ];
      assert.equal(gf.checkFallbackDoor(site([hostRoute('a.example', routes)]), PORT).ok, true);
      const withPrefix = [
        { match: [{ path: ['/api/health', '/api/*'] }], handle: [proxy()] },
        { handle: [auth(), proxy()] }
      ];
      assert.equal(gf.checkFallbackDoor(site([hostRoute('a.example', withPrefix)]), PORT).ok, false);
    });

    it('an authentication handler AFTER the proxy in the same route covers nothing', () => {
      assert.equal(gf.checkFallbackDoor(site([hostRoute('a.example', [{ handle: [proxy(), auth()] }])]), PORT).ok,
        false);
    });

    it('reads a gate inside a matched subroute as covering only that route', () => {
      const routes = [
        { match: [{ path: ['/x/*'] }], handle: [{ handler: 'subroute', routes: [{ handle: [auth(), proxy()] }] }] },
        { handle: [proxy()] }
      ];
      assert.equal(gf.checkFallbackDoor(site([hostRoute('a.example', routes)]), PORT).ok, false);
    });

    it('refuses with a reason when it has nothing to read', () => {
      assert.equal(gf.checkFallbackDoor(null, PORT).ok, false);
      assert.equal(gf.checkFallbackDoor(fixture('generated'), null).ok, false);
      assert.equal(gf.checkFallbackDoor(fixture('generated'), '3102').ok, false);
    });
  });

  describe('decideFallback', () => {
    const generated = { ok: true, config: fixture('generated'), reason: null };
    const base = {
      markerPresent: true, listenerAddress: '127.0.0.1', upstreamPort: PORT,
      caddyfileExists: true, adapted: generated, ingressMode: 'caddy'
    };
    const decide = (over) => gf.decideFallback({ ...base, ...over });

    it('honours a marker behind a gated Caddyfile on a loopback listener', () => {
      assert.deepEqual(decide({}), { honoured: true, reason: null });
      assert.equal(decide({ listenerAddress: '::1' }).honoured, true);
      assert.equal(decide({ listenerAddress: '::ffff:127.0.0.1' }).honoured, true);
    });

    it('has nothing to say without a marker', () => {
      for (const markerPresent of [false, undefined, 'yes', 1]) {
        assert.deepEqual(decide({ markerPresent }), { honoured: false, reason: null });
      }
      assert.deepEqual(gf.decideFallback(undefined), { honoured: false, reason: null });
    });

    it('refuses a listener other machines can reach', () => {
      for (const listenerAddress of ['0.0.0.0', '::', '192.168.1.5', null, undefined, '127.0.0.1.evil']) {
        const d = decide({ listenerAddress });
        assert.equal(d.honoured, false, String(listenerAddress));
        assert.match(d.reason, /not loopback/);
      }
    });

    it('refuses when caddy adapt could not read the file, or its door is not gated', () => {
      const failed = decide({ adapted: { ok: false, config: null, reason: 'caddy is not available' } });
      assert.equal(failed.honoured, false);
      assert.match(failed.reason, /caddy is not available/);
      assert.equal(decide({ adapted: null }).honoured, false);
      const armed = decide({ adapted: { ok: true, config: fixture('armed'), reason: null } });
      assert.equal(armed.honoured, false);
      assert.match(armed.reason, /without passing Caddy's gate/);
    });

    it('with no Caddyfile, honours direct mode only', () => {
      assert.equal(decide({ caddyfileExists: false, adapted: null, ingressMode: 'direct' }).honoured, true);
      for (const ingressMode of ['caddy', null, undefined]) {
        const d = decide({ caddyfileExists: false, adapted: null, ingressMode });
        assert.equal(d.honoured, false, String(ingressMode));
        assert.ok(d.reason);
      }
    });

    it('refuses a direct-mode listener on every interface even with no Caddyfile', () => {
      assert.equal(decide({ caddyfileExists: false, adapted: null, ingressMode: 'direct', listenerAddress: '::' })
        .honoured, false);
    });
  });

  describe('the marker file', () => {
    it('is written 0600 under the given home and removed idempotently', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-gate-fallback-'));
      try {
        const file = gf.markerPath(dir);
        assert.equal(file, path.join(dir, 'gate-fallback'));
        gf.writeMarker(file, { createdAt: '2026-09-13T00:00:00.000Z' });
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).createdAt, '2026-09-13T00:00:00.000Z');
        assert.equal(gf.removeMarker(file), true);
        assert.equal(gf.removeMarker(file), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('fixtures', () => {
    it('the live-shape fixtures are the Caddyfiles the committed JSON came from', () => {
      // Guards the pairing the regen script relies on: a fixture entry renamed
      // without regenerating would leave these tests reading stale JSON.
      for (const name of ['live-shape-gated', 'live-shape-own-auth']) {
        assert.ok(FIXTURE_CADDYFILES[name], name);
        assert.ok(fs.existsSync(path.join(__dirname, 'fixtures', `caddy-adapt-${name}.json`)), name);
      }
    });
  });
});
