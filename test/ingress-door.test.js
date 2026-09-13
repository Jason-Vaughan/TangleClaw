'use strict';

// lib/ingress-door — whether the Caddyfile on disk is a door that keeps
// `authEnabled: false` from opening a caddy-mode install (#1420).
//
// Every adapted config here is real `caddy adapt` output, committed under
// test/fixtures and re-derived by test/caddy-drift.test.js whenever Caddy is on
// PATH. `adapt` is injected in every call, so nothing in this file depends on
// whether the host has Caddy — the difference that once passed three suites
// locally and failed them on CI.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const caddy = require('../lib/caddy');
const ingressDoor = require('../lib/ingress-door');
const { FIXTURE_CADDYFILES } = require('./_caddy-drift-fixtures');

/**
 * The committed `caddy adapt` JSON for a named fixture.
 * @param {string} name - Key of FIXTURE_CADDYFILES.
 * @returns {object}
 */
function adapted(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `caddy-adapt-${name}.json`), 'utf8'));
}

/**
 * An `adapt` stand-in that answers with a fixture's committed JSON for that
 * fixture's exact text, and fails for anything else.
 * @returns {(content: string) => { ok: boolean, config: object|null, reason: string|null }}
 */
function fixtureAdapt() {
  return (content) => {
    for (const [name, text] of Object.entries(FIXTURE_CADDYFILES)) {
      if (text === content) return { ok: true, config: adapted(name), reason: null };
    }
    return { ok: false, config: null, reason: 'not a fixture' };
  };
}

const unavailable = () => ({ ok: false, config: null, reason: 'caddy is not available: ENOENT' });

// What each fixture is, as a door. Both readers must give the same answer for
// every shape the generator or the live install's hand edit writes.
const EXPECTED = {
  generated: { ungatedRemoteSite: false, unguardedLocalSite: false },
  'hand-edited': { ungatedRemoteSite: true, unguardedLocalSite: false },
  ungated: { ungatedRemoteSite: false, unguardedLocalSite: false },
  armed: { ungatedRemoteSite: true, unguardedLocalSite: false },
  'forwarded-for': { ungatedRemoteSite: true, unguardedLocalSite: false },
  'ungated-unguarded': { ungatedRemoteSite: false, unguardedLocalSite: true },
  'no-h1': { ungatedRemoteSite: false, unguardedLocalSite: false },
  'live-shape-gated': { ungatedRemoteSite: false, unguardedLocalSite: false },
  'live-shape-own-auth': { ungatedRemoteSite: true, unguardedLocalSite: false },
  'per-site-gate': { ungatedRemoteSite: true, unguardedLocalSite: false }
};

describe('lib/ingress-door (#1420)', () => {
  it('has an expectation for every committed fixture', () => {
    assert.deepEqual(Object.keys(EXPECTED).sort(), Object.keys(FIXTURE_CADDYFILES).sort());
  });

  describe('describeAdaptedDoor — Caddy\'s parser', () => {
    for (const [name, expected] of Object.entries(EXPECTED)) {
      it(`reads ${name}`, () => {
        assert.deepEqual(ingressDoor.describeAdaptedDoor(adapted(name)), expected);
      });
    }

    it('a site with basic_auth beside an ungated handle is a door — the gate is read in order', () => {
      // The #472 `/openclaw-direct/*` workaround: gated everywhere but one handle.
      assert.equal(ingressDoor.describeAdaptedDoor(adapted('live-shape-own-auth')).ungatedRemoteSite, true);
      assert.equal(ingressDoor.describeAdaptedDoor(adapted('live-shape-gated')).ungatedRemoteSite, false);
    });

    it('counts a guarded site as no door, whatever its host', () => {
      const guarded = adapted('ungated');
      const [server] = Object.values(guarded.apps.http.servers).filter((s) => (s.routes || []).length);
      const route = server.routes.find((r) => JSON.stringify(r).includes('reverse_proxy'));
      route.match = [{ host: ['box.example.com'] }];
      assert.equal(ingressDoor.describeAdaptedDoor(guarded).ungatedRemoteSite, false);
    });

    it('reads a local-host route with no host list in one matcher set as remote', () => {
      const config = adapted('ungated-unguarded');
      for (const server of Object.values(config.apps.http.servers)) {
        for (const route of server.routes || []) {
          if (route.match) route.match.push({ path: ['/x'] });
        }
      }
      assert.equal(ingressDoor.describeAdaptedDoor(config).ungatedRemoteSite, true);
    });

    it('fails toward a door on anything it cannot read', () => {
      assert.equal(ingressDoor.describeAdaptedDoor(null).ungatedRemoteSite, true);
      const withApp = adapted('generated');
      withApp.apps.layer4 = {};
      assert.equal(ingressDoor.describeAdaptedDoor(withApp).ungatedRemoteSite, true, 'an app it cannot read');
      const named = adapted('generated');
      Object.values(named.apps.http.servers)[0].named_routes = { x: {} };
      assert.equal(ingressDoor.describeAdaptedDoor(named).ungatedRemoteSite, true, 'named routes');
      const errorRoute = adapted('ungated');
      const server = Object.values(errorRoute.apps.http.servers)[0];
      server.errors = { routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:3102' }] }] }] };
      assert.equal(ingressDoor.describeAdaptedDoor(errorRoute).ungatedRemoteSite, true, 'an ungated error route');
    });

    it('is no door with no http servers at all', () => {
      assert.deepEqual(ingressDoor.describeAdaptedDoor({ apps: {} }), { ungatedRemoteSite: false, unguardedLocalSite: false });
    });
  });

  describe('describeIngressContent — which reader answers', () => {
    it('no file is no door, and asks nothing', () => {
      let asked = 0;
      const door = ingressDoor.describeIngressContent(null, { adapt: () => { asked++; return unavailable(); } });
      assert.equal(door.ungatedRemoteSite, false);
      assert.equal(door.unguardedLocalSite, false);
      assert.equal(door.source, 'none');
      assert.equal(asked, 0);
    });

    it('answers from caddy adapt when it runs', () => {
      const door = ingressDoor.describeIngressContent(FIXTURE_CADDYFILES['live-shape-own-auth'], { adapt: fixtureAdapt() });
      assert.equal(door.source, 'adapt');
      assert.equal(door.ungatedRemoteSite, true);
    });

    it('adapt outranks the text reader where they disagree', () => {
      // Text that reads as a door (a braceless site) but adapts to no route at all.
      const door = ingressDoor.describeIngressContent('localhost\nrespond ok\n', {
        adapt: () => ({ ok: true, config: { apps: {} }, reason: null })
      });
      assert.equal(door.source, 'adapt');
      assert.equal(door.ungatedRemoteSite, false);
    });

    it('falls back to the text reader when adapt cannot run, and says why', () => {
      for (const [name, expected] of Object.entries(EXPECTED)) {
        const door = ingressDoor.describeIngressContent(FIXTURE_CADDYFILES[name], { adapt: unavailable });
        assert.equal(door.source, 'text', name);
        assert.equal(door.reason, 'caddy is not available: ENOENT', name);
        assert.deepEqual({ ungatedRemoteSite: door.ungatedRemoteSite, unguardedLocalSite: door.unguardedLocalSite },
          expected, `the text reader agrees with Caddy on ${name}`);
      }
    });

    it('a Caddyfile that imports another file is a door, without asking Caddy', () => {
      let asked = 0;
      const text = `${FIXTURE_CADDYFILES.generated}\nimport sites/*.caddy\n`;
      const door = ingressDoor.describeIngressContent(text, { adapt: () => { asked++; return unavailable(); } });
      assert.equal(door.source, 'import');
      assert.equal(door.ungatedRemoteSite, true);
      assert.equal(asked, 0);
    });

    it('a snippet import is not a file import', () => {
      const door = ingressDoor.describeIngressContent(FIXTURE_CADDYFILES['live-shape-gated'], { adapt: fixtureAdapt() });
      assert.equal(door.source, 'adapt');
      assert.equal(door.ungatedRemoteSite, false);
    });
  });

  describe('readIngressDoor — the file on disk', () => {
    it('answers a missing file as no door, reads one that exists, and throws on any other failure', () => {
      // The thunk the gate reads: a throw is what makes it `unreadable`.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-door-'));
      try {
        const file = path.join(dir, 'Caddyfile');
        assert.equal(ingressDoor.readIngressDoor(file, { adapt: unavailable }).ungatedRemoteSite, false);
        fs.writeFileSync(file, FIXTURE_CADDYFILES.armed);
        const door = ingressDoor.readIngressDoor(file, { adapt: fixtureAdapt() });
        assert.equal(door.source, 'adapt');
        assert.equal(door.ungatedRemoteSite, true);
        const asDir = path.join(dir, 'is-a-directory');
        fs.mkdirSync(asDir);
        assert.throws(() => ingressDoor.readIngressDoor(asDir, { adapt: unavailable }), (e) => e.code === 'EISDIR');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('caddy.js no longer carries a second file reader', () => {
    assert.equal(caddy.readIngressDoor, undefined);
  });
});
