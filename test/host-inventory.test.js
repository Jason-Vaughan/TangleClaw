'use strict';

// #1905 (R45/R46): the tailnet name every consumer serves comes from ONE
// normalized inventory. These pin the probe's handling of each Tailscale output
// shape, the normalization, the configured/detected/drift/omission resolution,
// that the certificate union stays additive, and the invariant: the cert names,
// the served-Host allowlist and the operator link all name the same host.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const hostInventory = require('../lib/host-inventory');
const httpsSetup = require('../lib/https-setup');
const sessionOwnership = require('../lib/session-ownership');

setLevel('error');

const TS_NAME = 'box.tail123.ts.net';

/**
 * Make the overlay probe answer with `stdout`, or throw when given an Error.
 * @param {string|Error} stdout - What `tailscale status --json` prints.
 * @returns {void}
 */
function stubProbe(stdout) {
  hostInventory._internal.execSync = () => {
    if (stdout instanceof Error) throw stdout;
    return stdout;
  };
  sessionOwnership._resetHostCacheForTest();
}

/**
 * Tailscale's status JSON with the given Self.DNSName.
 * @param {string} dnsName - The DNSName to report.
 * @returns {string}
 */
function statusJson(dnsName) {
  return JSON.stringify({ BackendState: 'Running', Self: { DNSName: dnsName } });
}

describe('host-inventory', () => {
  let realExec;
  let tmpDir;

  before(() => {
    realExec = hostInventory._internal.execSync;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-host-inventory-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    hostInventory._internal.execSync = realExec;
    sessionOwnership._resetHostCacheForTest();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    hostInventory._internal.execSync = realExec;
    sessionOwnership._resetHostCacheForTest();
  });

  describe('normalizeHostName', () => {
    it('strips trailing dots, trims and lowercases', () => {
      assert.equal(hostInventory.normalizeHostName('  Box.Tail123.TS.net. '), TS_NAME);
      assert.equal(hostInventory.normalizeHostName('box.tail123.ts.net..'), TS_NAME);
    });

    for (const [label, value] of [
      ['an empty string', ''],
      ['a lone dot', '.'],
      ['a non-string', 42],
      ['an IPv4 literal', '100.64.0.1'],
      ['an IPv6 literal', 'fd7a:115c::1'],
      ['a name with a port', 'box.ts.net:3102'],
      ['a URL', 'https://box.ts.net'],
      ['a label starting with a hyphen', '-box.ts.net'],
      ['an empty label', 'box..ts.net'],
      ['a 64-character label', `${'a'.repeat(64)}.ts.net`]
    ]) {
      it(`returns null for ${label}`, () => {
        assert.equal(hostInventory.normalizeHostName(value), null);
      });
    }
  });

  describe('probeOverlayDns — Tailscale output shapes', () => {
    it('present: reads Self.DNSName and normalizes the trailing dot', () => {
      stubProbe(statusJson('Box.Tail123.ts.net.'));
      assert.deepEqual(hostInventory.probeOverlayDns(),
        { host: TS_NAME, provider: 'tailscale', reason: null });
    });

    it('absent: a missing binary is an omission with a reason, never a throw', () => {
      stubProbe(new Error('command not found: tailscale'));
      const obs = hostInventory.probeOverlayDns();
      assert.equal(obs.host, null);
      assert.match(obs.reason, /tailscale: unavailable/);
    });

    it('malformed: output that is not JSON is an omission', () => {
      stubProbe('not json');
      const obs = hostInventory.probeOverlayDns();
      assert.equal(obs.host, null);
      assert.match(obs.reason, /unreadable output/);
    });

    it('stopped daemon: JSON with no Self is an omission', () => {
      stubProbe('{"BackendState":"Stopped"}');
      const obs = hostInventory.probeOverlayDns();
      assert.equal(obs.host, null);
      assert.match(obs.reason, /reported no name/);
    });

    it('an invalid DNSName is refused rather than trusted', () => {
      stubProbe(statusJson('evil name;rm -rf.ts.net.'));
      const obs = hostInventory.probeOverlayDns();
      assert.equal(obs.host, null);
      assert.match(obs.reason, /invalid name/);
    });
  });

  describe('observeOverlayDns', () => {
    it('memoizes, and refresh probes again', () => {
      let calls = 0;
      hostInventory._internal.execSync = () => { calls += 1; return statusJson(`h${calls}.ts.net.`); };
      hostInventory._resetForTest();
      assert.equal(hostInventory.observeOverlayDns().host, 'h1.ts.net');
      assert.equal(hostInventory.observeOverlayDns().host, 'h1.ts.net');
      assert.equal(calls, 1, 'a second read reuses the observation');
      assert.equal(hostInventory.observeOverlayDns({ refresh: true }).host, 'h2.ts.net');
      assert.equal(hostInventory.observeOverlayDns().host, 'h2.ts.net',
        'every later reader sees the refreshed answer');
    });

    it('retries a miss after MISS_RETRY_MS, so a daemon that starts after the server is picked up', () => {
      const realNow = hostInventory._internal.now;
      let now = 1_000_000;
      let up = false;
      let calls = 0;
      hostInventory._internal.now = () => now;
      hostInventory._internal.execSync = () => {
        calls += 1;
        if (!up) throw new Error('tailscale: daemon not running');
        return statusJson(`${TS_NAME}.`);
      };
      hostInventory._resetForTest();
      try {
        assert.equal(hostInventory.observeOverlayDns().host, null, 'boot: the daemon is not up yet');
        up = true;
        now += hostInventory.MISS_RETRY_MS - 1;
        assert.equal(hostInventory.observeOverlayDns().host, null, 'a miss is trusted until the interval passes');
        assert.equal(calls, 1);
        now += 1;
        assert.equal(hostInventory.observeOverlayDns().host, TS_NAME, 'then probed again');
        now += hostInventory.MISS_RETRY_MS * 10;
        assert.equal(hostInventory.observeOverlayDns().host, TS_NAME);
        assert.equal(calls, 2, 'a found name is kept, not re-probed on a timer');
      } finally {
        hostInventory._internal.now = realNow;
      }
    });
  });

  describe('resolveTailnetHost', () => {
    const observed = { host: TS_NAME, provider: 'tailscale', reason: null };
    const none = { host: null, provider: null, reason: 'tailscale: unavailable' };

    it('detected: with nothing configured, the observed name is canonical', () => {
      const r = hostInventory.resolveTailnetHost({ caddyTailnetHost: null }, observed);
      assert.equal(r.host, TS_NAME);
      assert.equal(r.source, 'detected');
      assert.equal(r.provider, 'tailscale');
      assert.equal(r.caddySite, 'not-configured',
        'a detected name is never written into the Caddy site: that needs a gate');
      assert.equal(r.drift, null);
    });

    it('configured: the configured name wins and is normalized', () => {
      const r = hostInventory.resolveTailnetHost({ caddyTailnetHost: 'Box.Tail123.ts.net.' }, observed);
      assert.equal(r.host, TS_NAME);
      assert.equal(r.source, 'configured');
      assert.equal(r.caddySite, 'configured');
      assert.equal(r.drift, null, 'the same name after normalization is not drift');
    });

    it('drift: a configured name that differs from the observed one stays canonical and is reported', () => {
      const r = hostInventory.resolveTailnetHost({ caddyTailnetHost: 'old.tail123.ts.net' }, observed);
      assert.equal(r.host, 'old.tail123.ts.net');
      assert.deepEqual(r.drift, { configured: 'old.tail123.ts.net', observed: TS_NAME });
    });

    it('omission: with neither, no host is invented and the reason is reported', () => {
      const r = hostInventory.resolveTailnetHost({}, none);
      assert.equal(r.host, null);
      assert.equal(r.source, null);
      assert.match(r.omission, /tailscale: unavailable/);
      assert.match(r.omission, /generate-cert/, 'explicit host entry is named as the way forward');
    });
  });

  describe('certHostUnion', () => {
    it('adds the tailnet name and keeps the defaults, mDNS name and publicDomain', () => {
      const union = httpsSetup.certHostUnion(null, { publicDomain: 'tc.example.com' },
        { observation: { host: TS_NAME, provider: 'tailscale' } });
      for (const h of [...httpsSetup.MKCERT_HOSTS_DEFAULT, 'tc.example.com', TS_NAME]) {
        assert.ok(union.includes(h), `${h} must be carried`);
      }
      assert.ok(union.includes(httpsSetup.mdnsHostFor(os.hostname())));
    });

    it('adds nothing for the tailnet when detection is absent', () => {
      const union = httpsSetup.certHostUnion(null, {},
        { observation: { host: null, reason: 'tailscale: unavailable' } });
      assert.ok(!union.some((h) => h.endsWith('.ts.net')));
    });
  });

  describe('mandatoryCertHosts', () => {
    it('is the mkcert defaults, the mDNS name and the canonical tailnet host, never publicDomain', () => {
      const m = httpsSetup.mandatoryCertHosts({ publicDomain: 'tc.example.com' },
        { observation: { host: TS_NAME, provider: 'tailscale' }, hostname: 'Studio' });
      assert.deepEqual(m, ['localhost', '127.0.0.1', '::1', 'studio.local', TS_NAME]);
    });

    it('follows a configured tailnet host over a detected one', () => {
      const m = httpsSetup.mandatoryCertHosts({ caddyTailnetHost: 'old.tail123.ts.net' },
        { observation: { host: TS_NAME }, hostname: 'Studio' });
      assert.ok(m.includes('old.tail123.ts.net'));
      assert.ok(!m.includes(TS_NAME), 'the drifted observed name is not canonical');
    });
  });

  describe('invariant: one host across every consumer', () => {
    // The consumers R46 names: certificate generation (certHostUnion), the
    // served-Host allowlist, and the reported operator origin. The Caddy site
    // reads the configured name, which is the canonical host whenever one is set.
    const cases = [
      { label: 'detected', config: {}, probe: statusJson('Box.Tail123.ts.net.'), expect: TS_NAME },
      { label: 'configured', config: { caddyTailnetHost: TS_NAME }, probe: new Error('no tailscale'), expect: TS_NAME },
      { label: 'drift', config: { caddyTailnetHost: 'old.tail123.ts.net' }, probe: statusJson(`${TS_NAME}.`), expect: 'old.tail123.ts.net' }
    ];
    for (const c of cases) {
      it(`${c.label}: cert union, allowlist and operator link name the same host`, () => {
        stubProbe(c.probe);
        const canonical = hostInventory.resolveTailnetHost(c.config).host;
        assert.equal(canonical, c.expect);
        assert.ok(httpsSetup.certHostUnion(null, c.config).includes(canonical), 'cert union');
        assert.ok(httpsSetup.servedHostAllowlist(c.config).has(canonical), 'allowlist');
        assert.equal(sessionOwnership.resolveOperatorHost({}, c.config).host, canonical, 'operator link');
        if (c.config.caddyTailnetHost) {
          assert.equal(hostInventory.normalizeHostName(c.config.caddyTailnetHost), canonical, 'Caddy site');
        }
      });
    }

    it('drift: the observed name is in none of them until reconciled', () => {
      stubProbe(statusJson(`${TS_NAME}.`));
      const config = { caddyTailnetHost: 'old.tail123.ts.net' };
      assert.ok(!httpsSetup.certHostUnion(null, config).includes(TS_NAME));
      assert.ok(!httpsSetup.servedHostAllowlist(config).has(TS_NAME));
    });
  });
});

describe('session-ownership keeps its probe seam', () => {
  let realExec;
  beforeEach(() => { realExec = hostInventory._internal.execSync; });
  afterEach(() => {
    hostInventory._internal.execSync = realExec;
    sessionOwnership._resetHostCacheForTest();
  });

  it('stubbing sessionOwnership._internal.execSync stubs the shared probe', () => {
    sessionOwnership._internal.execSync = () => statusJson('Seam.ts.net.');
    assert.equal(hostInventory._internal.execSync, sessionOwnership._internal.execSync);
    assert.equal(hostInventory.probeOverlayDns().host, 'seam.ts.net');
  });

  it('_localHost reads the same observation the allowlist does', () => {
    sessionOwnership._internal.execSync = () => statusJson('Seam.ts.net.');
    sessionOwnership._resetHostCacheForTest();
    assert.equal(sessionOwnership._localHost(), 'seam.ts.net');
    assert.equal(hostInventory.observeOverlayDns().host, 'seam.ts.net');
  });
});
