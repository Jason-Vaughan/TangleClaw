'use strict';

/*
 * The owned ttyd runtime's build entry point (#1245, ADR 0018 §2): its inputs
 * are pinned and verified before use. These tests need no network and no
 * compiler; the build itself is exercised by running the script.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const build = require('../scripts/build-ttyd');

const INPUTS = path.join(__dirname, '..', 'deploy', 'ttyd', 'inputs.json');
const load = () => JSON.parse(fs.readFileSync(INPUTS, 'utf8'));

describe('scripts/build-ttyd.js (#1245, ADR 0018)', () => {
  describe('the tracked inputs', () => {
    // THE CONTRACT ON THE REPOSITORY ITSELF: a patch edited without re-pinning
    // its digest, or a source dropped from the list, fails here, not at build time.
    it('inputs.json and every tracked patch are valid as committed', () => {
      assert.deepEqual(build.validateInputs(load()), []);
    });

    it('pins every source the runtime is built from, by https URL and SHA-256', () => {
      const names = load().sources.map((s) => s.name);
      for (const required of build.REQUIRED_SOURCES) assert.ok(names.includes(required), required);
    });

    it('builds libwebsockets without TLS and with no loadable plugins, so nothing can be dlopened from elsewhere', () => {
      const lws = load().build.libwebsockets;
      for (const flag of ['-DLWS_WITH_SSL=OFF', '-DLWS_WITH_SHARED=OFF', '-DLWS_WITH_PLUGINS=OFF', '-DLWS_WITH_EVLIB_PLUGINS=OFF', '-DLWS_UNIX_SOCK=ON']) {
        assert.ok(lws.includes(flag), flag);
      }
    });

    it('allows only the macOS system roots in the runtime\'s load graph, the same ones the verifier defaults to', () => {
      assert.deepEqual(load().closure.systemRoots, ['/usr/lib/', '/System/Library/']);
      // Two declarations of one fact: the build checks against inputs.json, the
      // installer against the verifier's default. They must not drift apart.
      assert.deepEqual(load().closure.systemRoots, [...require('../lib/macho-closure').DEFAULT_SYSTEM_ROOTS]);
    });
  });

  describe('validateInputs', () => {
    let dir;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-build-ttyd-'));
      fs.mkdirSync(path.join(dir, 'patches'));
      fs.writeFileSync(path.join(dir, 'patches', 'a.diff'), 'x\n');
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');

    it('names a patch whose content no longer matches its pinned digest, with the actual digest', () => {
      const inputs = { ...load(), patches: [{ file: 'patches/a.diff', sha256: digest('y\n') }] };
      const problems = build.validateInputs(inputs, dir);
      assert.equal(problems.length, 1);
      assert.match(problems[0], new RegExp(`sha256 is ${digest('x\n')}`));
    });

    it('reports every problem at once: a missing source, an http URL, a short digest, a missing patch file', () => {
      const base = load();
      const inputs = {
        ...base,
        sources: base.sources.filter((s) => s.name !== 'json-c').map((s) => (s.name === 'libuv' ? { ...s, url: 'http://x/y.tgz', sha256: 'abc' } : s)),
        patches: [{ file: 'patches/gone.diff', sha256: digest('z') }]
      };
      const problems = build.validateInputs(inputs, dir).join('\n');
      assert.match(problems, /missing source json-c/);
      assert.match(problems, /libuv: url must be https/);
      assert.match(problems, /libuv: sha256 must be 64 hex/);
      assert.match(problems, /patch patches\/gone\.diff: file not found/);
    });

    it('refuses an input set with no patches, since the runtime exists to carry them', () => {
      assert.match(build.validateInputs({ ...load(), patches: [] }, dir).join(), /no patches listed/);
    });
  });

  describe('fetchVerified — digests are checked before anything is used', () => {
    let cache;
    before(() => { cache = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-build-cache-')); });
    after(() => fs.rmSync(cache, { recursive: true, force: true }));

    it('uses a cached file whose digest matches, without downloading', () => {
      const body = 'pinned tarball bytes';
      const sha = crypto.createHash('sha256').update(body).digest('hex');
      const input = { url: 'https://example.invalid/x-1.0.tar.gz', sha256: sha };
      fs.writeFileSync(path.join(cache, `${sha}-x-1.0.tar.gz`), body);
      assert.equal(build.fetchVerified(input, cache, true), path.join(cache, `${sha}-x-1.0.tar.gz`));
    });

    it('deletes a cached file whose digest does not match, and never returns it', () => {
      const sha = crypto.createHash('sha256').update('the real bytes').digest('hex');
      const input = { url: 'https://example.invalid/y-1.0.tar.gz', sha256: sha };
      const poisoned = path.join(cache, `${sha}-y-1.0.tar.gz`);
      fs.writeFileSync(poisoned, 'tampered bytes');
      assert.throws(() => build.fetchVerified(input, cache, true), /--offline and .* is not in the cache/);
      assert.equal(fs.existsSync(poisoned), false, 'the tampered file is gone from the cache');
    });
  });

  describe('cleanEnv and parseArgs', () => {
    it('builds with no Homebrew, MacPorts or /usr/local on PATH, and no inherited compiler hints', () => {
      const env = build.cleanEnv('/w/venv/bin', '14.0');
      assert.doesNotMatch(env.PATH, /homebrew|\/usr\/local|\/opt\/local/);
      assert.equal(env.PATH.split(':')[0], '/w/venv/bin');
      for (const k of ['CFLAGS', 'LDFLAGS', 'CPPFLAGS', 'PKG_CONFIG_PATH', 'LIBRARY_PATH', 'CPATH']) assert.equal(env[k], undefined, k);
      assert.equal(env.MACOSX_DEPLOYMENT_TARGET, '14.0');
    });

    it('parses its options and refuses an unknown one or a missing value', () => {
      const o = build.parseArgs(['--work', '/tmp/w', '--offline']);
      assert.equal(o.work, '/tmp/w');
      assert.equal(o.offline, true);
      assert.throws(() => build.parseArgs(['--wrok', 'x']), /unknown argument/);
      assert.throws(() => build.parseArgs(['--out']), /needs a value/);
    });
  });
});
