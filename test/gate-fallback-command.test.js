'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cmd = require('../scripts/gate-fallback');
const {
  FIXTURE_CADDYFILES, FIXTURE_HASH, fixtureConfig, generatedCaddyfile
} = require('./_caddy-drift-fixtures');

// `scripts/gate-fallback.js` driven through `run` with every side effect
// injected: no caddy, no launchd, no server. `caddy adapt` is answered from the
// committed fixtures (real adapt output for the same Caddyfile text), so the
// door the command checks is the one Caddy itself would read.

const fixtureJson = (name) => JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', `caddy-adapt-${name}.json`), 'utf8')
);
const adaptText = (text) => {
  for (const [name, content] of Object.entries(FIXTURE_CADDYFILES)) {
    if (content === text) return { ok: true, config: fixtureJson(name), reason: null };
  }
  return { ok: false, config: null, reason: 'not a fixture Caddyfile' };
};

describe('scripts/gate-fallback.js (#1420)', () => {
  let dir;
  let caddyfilePath;
  let markerFile;
  let out;
  let err;
  let calls;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-gate-fallback-cmd-'));
    caddyfilePath = path.join(dir, 'Caddyfile');
    markerFile = path.join(dir, 'gate-fallback');
    out = '';
    err = '';
    calls = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const markerExists = () => fs.existsSync(markerFile);

  /**
   * Run the command with fakes. `over.deps` merges into the defaults.
   * @param {object} [over]
   * @returns {Promise<number>}
   */
  function go(over = {}) {
    const deps = {
      adapt: (file) => adaptText(fs.readFileSync(file, 'utf8')),
      adaptContent: adaptText,
      validate: () => ({ ok: true }),
      reload: () => { calls.push('reload'); return { ok: true, error: null, command: 'launchctl kickstart' }; },
      probe: async (target) => { calls.push(`probe:${target.host}`); return { ok: true, detail: 'HTTP 401 (Basic challenge)' }; },
      queryState: async () => { calls.push('query'); return { state: 'fallback', error: null }; },
      sleep: async () => {},
      tries: 3,
      delayMs: 0,
      now: () => new Date('2026-09-13T12:00:00.000Z'),
      ...(over.deps || {})
    };
    return cmd.run({
      caddyfilePath,
      markerFile,
      config: fixtureConfig({ ingressMode: 'caddy', ...(over.config || {}) }),
      intendedGateState: over.intendedGateState || 'armed',
      lanHosts: [null],
      undo: over.undo === true,
      dryRun: over.dryRun === true,
      restore: over.restore || null,
      uid: 501,
      stamp: `2026-09-13T12-00-00-000Z-${Math.random().toString(36).slice(2)}`,
      deps,
      stdout: { write: (t) => { out += t; } },
      stderr: { write: (t) => { err += t; } }
    });
  }

  const writeLive = (name) => fs.writeFileSync(caddyfilePath, FIXTURE_CADDYFILES[name], { mode: 0o600 });
  const live = () => fs.readFileSync(caddyfilePath, 'utf8');
  const noHash = () => {
    assert.equal(out.includes(FIXTURE_HASH), false, 'stdout must not carry the hash');
    assert.equal(err.includes(FIXTURE_HASH), false, 'stderr must not carry the hash');
  };

  describe('falling back', () => {
    it('rebuilds an armed generated file with basic_auth, proves it, and only then writes the marker', async () => {
      writeLive('armed');
      const code = await go({
        deps: {
          probe: async (target) => {
            assert.equal(markerExists(), false, 'the marker must not exist while Caddy is being probed');
            assert.equal(live(), FIXTURE_CADDYFILES.generated, 'the gated file is on disk before the probe');
            calls.push(`probe:${target.host}`);
            return { ok: true, detail: 'HTTP 401' };
          }
        }
      });
      assert.equal(code, cmd.EXIT.OK, err);
      assert.equal(live(), FIXTURE_CADDYFILES.generated);
      assert.deepEqual(calls, ['reload', 'probe:fixture-box.tailnet-example.ts.net', 'probe:localhost', 'query']);
      assert.equal(markerExists(), true);
      assert.equal(fs.statSync(markerFile).mode & 0o777, 0o600);
      assert.match(out, /reports "fallback"/);
      noHash();
    });

    it('leaves a file that already gates every route alone, and still probes it', async () => {
      writeLive('live-shape-gated');
      const code = await go();
      assert.equal(code, cmd.EXIT.OK, err);
      assert.equal(live(), FIXTURE_CADDYFILES['live-shape-gated']);
      assert.equal(calls.includes('reload'), false);
      assert.equal(calls.filter((c) => c.startsWith('probe:')).length, 3);
      assert.equal(markerExists(), true);
    });

    it('refuses the hand-maintained file with an ungated /openclaw-direct/* handle, touching nothing', async () => {
      writeLive('live-shape-own-auth');
      const code = await go();
      assert.equal(code, cmd.EXIT.REFUSED);
      assert.match(err, /openclaw-direct/);
      assert.match(err, /--restore/);
      assert.equal(live(), FIXTURE_CADDYFILES['live-shape-own-auth']);
      assert.deepEqual(calls, []);
      assert.equal(markerExists(), false);
      noHash();
    });

    it('--restore puts a saved gated Caddyfile back and falls back behind it', async () => {
      writeLive('live-shape-own-auth');
      const backup = path.join(dir, 'Caddyfile.saved');
      fs.writeFileSync(backup, FIXTURE_CADDYFILES['live-shape-gated']);
      const code = await go({ restore: backup });
      assert.equal(code, cmd.EXIT.OK, err);
      assert.equal(live(), FIXTURE_CADDYFILES['live-shape-gated']);
      assert.equal(calls[0], 'reload');
      assert.equal(markerExists(), true);
    });

    it('--restore refuses a saved file that does not gate every route', async () => {
      writeLive('armed');
      const backup = path.join(dir, 'Caddyfile.saved');
      fs.writeFileSync(backup, FIXTURE_CADDYFILES['live-shape-own-auth']);
      const code = await go({ restore: backup });
      assert.equal(code, cmd.EXIT.REFUSED);
      assert.equal(live(), FIXTURE_CADDYFILES.armed);
      assert.equal(markerExists(), false);
    });

    it('does not write the marker when a site does not answer with Caddy\'s challenge', async () => {
      writeLive('armed');
      const code = await go({
        deps: { probe: async () => ({ ok: false, detail: 'HTTP 401' }) }
      });
      assert.equal(code, cmd.EXIT.REFUSED);
      assert.match(err, /marker was NOT written/);
      assert.equal(markerExists(), false);
    });

    it('does not write the marker when Caddy cannot be restarted', async () => {
      writeLive('armed');
      const code = await go({
        deps: { reload: () => ({ ok: false, error: 'launchd said no', command: 'launchctl kickstart -k x' }) }
      });
      assert.equal(code, cmd.EXIT.NOT_LIVE);
      assert.equal(markerExists(), false);
      assert.match(err, /NOT live/);
    });

    it('refuses to rebuild with no retained credential — the generator will not emit an ungated remote site', async () => {
      writeLive('armed');
      const code = await go({ config: { basicAuthUser: null, basicAuthHash: null } });
      assert.equal(code, cmd.EXIT.REFUSED);
      assert.equal(live(), FIXTURE_CADDYFILES.armed);
      assert.equal(markerExists(), false);
    });

    it('refuses a generated file this config cannot reproduce', async () => {
      writeLive('armed');
      const code = await go({ config: { caddyTailnetHost: null } });
      assert.equal(code, cmd.EXIT.REFUSED);
      assert.match(err, /cannot reproduce/);
      assert.equal(live(), FIXTURE_CADDYFILES.armed);
    });

    it('says so, and exits non-zero, when TangleClaw does not honour the marker', async () => {
      writeLive('generated');
      const code = await go({ deps: { queryState: async () => ({ state: 'armed', error: null }) } });
      assert.equal(code, cmd.EXIT.NOT_HONOURED);
      assert.match(err, /did NOT honour/);
    });

    it('in direct mode with no Caddyfile, writes the marker with nothing to probe', async () => {
      const code = await go({ config: { ingressMode: 'direct' } });
      assert.equal(code, cmd.EXIT.OK, err);
      assert.deepEqual(calls, ['query']);
      assert.equal(markerExists(), true);
    });

    it('refuses caddy mode with no Caddyfile', async () => {
      const code = await go();
      assert.equal(code, cmd.EXIT.REFUSED);
      assert.equal(markerExists(), false);
    });

    it('--dry-run changes nothing', async () => {
      writeLive('armed');
      const code = await go({ dryRun: true });
      assert.equal(code, cmd.EXIT.OK, err);
      assert.equal(live(), FIXTURE_CADDYFILES.armed);
      assert.deepEqual(calls, []);
      assert.equal(markerExists(), false);
      assert.deepEqual(fs.readdirSync(dir).sort(), ['Caddyfile']);
      assert.match(out, /would probe/);
      noHash();
    });
  });

  describe('--undo', () => {
    const setMarker = () => fs.writeFileSync(markerFile, '{}\n', { mode: 0o600 });

    it('removes the marker first, sees the login enforce, and only then drops basic_auth', async () => {
      writeLive('generated');
      setMarker();
      const code = await go({
        undo: true,
        deps: {
          queryState: async () => {
            assert.equal(markerExists(), false, 'the marker goes before TangleClaw is asked');
            assert.equal(live(), FIXTURE_CADDYFILES.generated, 'basic_auth is still in place while TangleClaw re-arms');
            calls.push('query');
            return { state: 'armed', error: null };
          }
        }
      });
      assert.equal(code, cmd.EXIT.OK, err);
      assert.deepEqual(calls, ['query', 'reload']);
      assert.equal(live(), FIXTURE_CADDYFILES.armed);
      assert.equal(live(), generatedCaddyfile({}, 'armed'));
      noHash();
    });

    it('keeps basic_auth when TangleClaw does not guard the door, or does not answer', async () => {
      for (const answer of [{ state: 'unreadable', error: null }, { state: 'account-required', error: null },
        { state: null, error: 'ECONNREFUSED' }]) {
        writeLive('generated');
        setMarker();
        calls = [];
        const code = await go({ undo: true, deps: { queryState: async () => answer } });
        assert.equal(code, cmd.EXIT.OK, err);
        assert.equal(live(), FIXTURE_CADDYFILES.generated, JSON.stringify(answer));
        assert.equal(calls.includes('reload'), false);
        assert.equal(markerExists(), false);
        assert.match(out, /STAYS/);
      }
    });

    it('keeps basic_auth in a hand-maintained file', async () => {
      writeLive('live-shape-gated');
      setMarker();
      const code = await go({ undo: true, deps: { queryState: async () => ({ state: 'armed', error: null }) } });
      assert.equal(code, cmd.EXIT.OK, err);
      assert.equal(live(), FIXTURE_CADDYFILES['live-shape-gated']);
      assert.equal(markerExists(), false);
      assert.match(out, /stays in front/);
    });

    it('has nothing to do with no marker, and changes nothing', async () => {
      writeLive('generated');
      const code = await go({ undo: true });
      assert.equal(code, cmd.EXIT.OK);
      assert.deepEqual(calls, []);
      assert.equal(live(), FIXTURE_CADDYFILES.generated);
    });

    it('--dry-run keeps the marker', async () => {
      writeLive('generated');
      setMarker();
      assert.equal(await go({ undo: true, dryRun: true }), cmd.EXIT.OK);
      assert.equal(markerExists(), true);
      assert.deepEqual(calls, []);
    });
  });

  describe('the probes, against a real local listener', () => {
    const http = require('node:http');
    /**
     * Serve one fixed answer on an OS-assigned loopback port.
     * @param {number} status
     * @param {object} headers
     * @param {string} [body]
     * @returns {Promise<{ port: number, seen: object[], close: Function }>}
     */
    function serve(status, headers, body = '') {
      const seen = [];
      const server = http.createServer((req, res) => {
        seen.push({ url: req.url, host: req.headers.host, cookie: req.headers.cookie, origin: req.headers.origin });
        res.writeHead(status, headers);
        res.end(body);
      });
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port, seen, close: () => new Promise((r) => server.close(r))
      })));
    }

    it('accepts only a 401 carrying a Basic challenge — TangleClaw\'s own 401 is not Caddy\'s gate', async () => {
      const basic = await serve(401, { 'WWW-Authenticate': 'Basic realm="restricted"' });
      const session = await serve(401, { 'Content-Type': 'application/json' }, '{"code":"UNAUTHENTICATED"}');
      const open = await serve(200, {});
      try {
        const b = await cmd.probeBasicChallenge({ port: basic.port, tls: false, host: 'box.example' });
        assert.equal(b.ok, true, b.detail);
        assert.equal(basic.seen[0].host, 'box.example');
        assert.equal((await cmd.probeBasicChallenge({ port: session.port, tls: false, host: null })).ok, false);
        assert.equal((await cmd.probeBasicChallenge({ port: open.port, tls: false, host: null })).ok, false);
      } finally {
        await Promise.all([basic.close(), session.close(), open.close()]);
      }
      const closed = await cmd.probeBasicChallenge({ port: basic.port, tls: false, host: null }, 500);
      assert.equal(closed.ok, false);
    });

    it('reads the gate state as a local tool, with no browser headers and no cookie', async () => {
      const me = await serve(200, { 'Content-Type': 'application/json' }, '{"gateState":"fallback"}');
      const junk = await serve(200, {}, 'not json');
      try {
        assert.deepEqual(await cmd.queryGateState(me.port), { state: 'fallback', error: null });
        assert.equal(me.seen[0].url, '/api/auth/me');
        assert.equal(me.seen[0].cookie, undefined);
        assert.equal(me.seen[0].origin, undefined);
        assert.equal((await cmd.queryGateState(junk.port, 500)).state, null);
      } finally {
        await Promise.all([me.close(), junk.close()]);
      }
    });
  });

  describe('parseArgs', () => {
    it('reads each flag, and refuses --restore with no file', () => {
      assert.deepEqual(cmd.parseArgs(['--undo', '--dry-run']),
        { dryRun: true, undo: true, restore: null, help: false, unknown: [] });
      assert.equal(cmd.parseArgs(['--restore', '/x/Caddyfile.bak']).restore, '/x/Caddyfile.bak');
      assert.deepEqual(cmd.parseArgs(['--restore']).unknown, ['--restore (needs a file)']);
      assert.deepEqual(cmd.parseArgs(['--restore', '--undo']).unknown, ['--restore (needs a file)']);
      assert.deepEqual(cmd.parseArgs(['--force']).unknown, ['--force']);
    });
  });
});
