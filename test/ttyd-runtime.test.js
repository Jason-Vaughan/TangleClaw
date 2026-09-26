'use strict';

/*
 * The owned ttyd runtime (#1245, ADR 0018 §1, §4): one resolver, fail-closed
 * selection, an explicit and loud Homebrew rollback, and a transactional
 * install that keeps the last known good. Host checks (the Mach-O closure, the
 * binary's own --version) are injected, so every rule runs in a scratch base
 * directory on any platform; the digest check is real.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const runtime = require('../lib/ttyd-runtime');
const cli = require('../scripts/ttyd-runtime');

const REPO = path.join(__dirname, '..');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// The pinned inputs a runtime must have been built from (stands in for
// deploy/ttyd/inputs.json: the file's own digest, and the sources and patches
// it pins), and a manifest's record of building from them.
const EXPECTED = { inputsJsonSha256: '1'.repeat(64), sources: [{ name: 'ttyd', sha256: 'a'.repeat(64) }, { name: 'libwebsockets', sha256: 'b'.repeat(64) }], patches: ['c'.repeat(64), 'd'.repeat(64)] };
const BUILT_FROM = { inputsJsonSha256: EXPECTED.inputsJsonSha256, sources: EXPECTED.sources, patches: EXPECTED.patches.map((d) => ({ sha256: d })) };
// The same checkout after inputs.json changed only outside the sources and
// patches (a build flag, the CMake pin, the deployment target).
const REPINNED = { ...EXPECTED, inputsJsonSha256: '2'.repeat(64) };

/**
 * Host operations for tests: a "binary" is a file whose text is its version
 * line; one containing "homebrew" fails the closure; one containing "broken"
 * does not run. The build is refused unless a test supplies one.
 * @param {string|null} [homebrew] - What the Homebrew lookup returns.
 * @param {object} [expected] - The pinned inputs this "checkout" tracks.
 * @returns {object}
 */
function deps(homebrew = null, expected = EXPECTED) {
  return {
    ...runtime.defaultDeps(),
    verifyClosure: (bin) => (fs.readFileSync(bin, 'utf8').includes('homebrew')
      ? { ok: false, graph: [], violations: [{ ref: '/opt/homebrew/opt/libwebsockets/lib/libwebsockets.21.dylib', reason: 'absolute path outside the macOS system roots' }] }
      : { ok: true, graph: [], violations: [] }),
    version: (bin) => {
      const text = fs.readFileSync(bin, 'utf8').trim();
      if (text.includes('broken')) throw new Error('dyld: Library not loaded');
      return text;
    },
    homebrewTtyd: () => homebrew,
    expectedInputs: () => expected,
    build: () => { throw new Error('this test does not expect a build'); }
  };
}

/**
 * Write a staged runtime the way build-ttyd.js does.
 * @param {string} dir - Stage directory.
 * @param {string} content - The binary's bytes (and version line).
 * @param {object} [manifestOverride] - Replace fields of the manifest.
 * @returns {string} The binary's sha256.
 */
function stage(dir, content, manifestOverride = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ttyd'), content, { mode: 0o755 });
  const digest = sha(content);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema: 1, binary: { file: 'ttyd', sha256: digest, version: content.trim() }, inputs: BUILT_FROM, ...manifestOverride
  }));
  return digest;
}

describe('lib/ttyd-runtime (#1245, ADR 0018)', () => {
  let base;
  let scratch;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ttyd-runtime-'));
    base = path.join(scratch, 'base');
    fs.mkdirSync(base);
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const P = () => runtime.runtimePaths(base);

  describe('resolveTtydPath — fail closed, never a silent fallback', () => {
    it('refuses when no managed runtime is installed, names the repair, and does NOT pick Homebrew', () => {
      assert.throws(
        () => runtime.resolveTtydPath({ baseDir: base, env: {}, deps: deps('/opt/homebrew/bin/ttyd') }),
        (err) => err instanceof runtime.RuntimeUnavailableError
          && /missing or not executable/.test(err.message)
          && err.message.includes('node scripts/build-ttyd.js')
          && err.message.includes('TANGLECLAW_TTYD_RUNTIME=homebrew')
      );
    });

    it('selects a managed runtime that verifies', () => {
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: (stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n'), deps()) });
      assert.deepEqual(runtime.resolveTtydPath({ baseDir: base, env: {}, deps: deps() }), { path: P().ttyd, managed: true, warning: null });
    });

    it('refuses a managed runtime whose bytes no longer match its manifest', () => {
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: (stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n'), deps()) });
      fs.writeFileSync(P().ttyd, 'ttyd version 1.7.7-a\n# tampered\n');
      assert.throws(() => runtime.resolveTtydPath({ baseDir: base, env: {}, deps: deps() }), /its sha256 is .* the manifest records/);
    });

    it('refuses a managed runtime that is not self-contained, or does not run, or has no manifest', () => {
      const cases = [
        ['linked against homebrew\n', /not self-contained: \/opt\/homebrew/],
        ['broken\n', /it does not run: dyld/]
      ];
      for (const [content, pattern] of cases) {
        fs.mkdirSync(P().bin, { recursive: true });
        fs.writeFileSync(P().ttyd, content, { mode: 0o755 });
        fs.writeFileSync(P().manifest, JSON.stringify({ schema: 1, binary: { sha256: sha(content), version: content.trim() }, inputs: BUILT_FROM }));
        assert.throws(() => runtime.resolveTtydPath({ baseDir: base, env: {}, deps: deps() }), pattern, content);
      }
      fs.rmSync(P().manifest);
      assert.throws(() => runtime.resolveTtydPath({ baseDir: base, env: {}, deps: deps() }), /manifest .* missing or unreadable/);
    });

    // `--version` cannot tell builds apart: every static build says
    // `1.7.7-unknown`. A runtime built without the fix, or before a patch
    // changed, must not be selected as the fix.
    it('refuses a runtime built without the pinned patches, or from different sources', () => {
      const s = path.join(scratch, 'nofix');
      stage(s, 'ttyd version 1.7.7-unknown\n', { inputs: { sources: BUILT_FROM.sources, patches: [{ sha256: 'c'.repeat(64) }] } });
      assert.throws(() => runtime.installRuntime({ baseDir: base, stageDir: s, deps: deps() }), /not built with exactly the patches pinned/);
      const s2 = path.join(scratch, 'othersrc');
      stage(s2, 'ttyd version 1.7.7-unknown\n', { inputs: { sources: [{ name: 'ttyd', sha256: 'e'.repeat(64) }, BUILT_FROM.sources[1]], patches: BUILT_FROM.patches } });
      assert.throws(() => runtime.installRuntime({ baseDir: base, stageDir: s2, deps: deps() }), /not built from the pinned ttyd/);
      const s3 = path.join(scratch, 'noprov');
      stage(s3, 'ttyd version 1.7.7-unknown\n', { inputs: undefined });
      assert.throws(() => runtime.installRuntime({ baseDir: base, stageDir: s3, deps: deps() }), /not built from the pinned/);
    });

    it('the real expected inputs are the ones in deploy/ttyd/inputs.json', () => {
      const inputs = JSON.parse(fs.readFileSync(path.join(REPO, 'deploy', 'ttyd', 'inputs.json'), 'utf8'));
      const expected = runtime.defaultDeps().expectedInputs();
      assert.deepEqual(expected.patches, inputs.patches.map((p) => p.sha256));
      assert.deepEqual(expected.sources.map((s) => s.name), inputs.sources.map((s) => s.name));
    });

    it('selects Homebrew ONLY when the operator asks, and says the fix is off', () => {
      const r = runtime.resolveTtydPath({ baseDir: base, env: { TANGLECLAW_TTYD_RUNTIME: 'homebrew' }, deps: deps('/opt/homebrew/bin/ttyd') });
      assert.equal(r.path, '/opt/homebrew/bin/ttyd');
      assert.equal(r.managed, false);
      assert.match(r.warning, /WITHOUT the #1245 leak fix/);
      assert.match(r.warning, /watcher is again the only mitigation/);
    });

    it('refuses an explicit Homebrew rollback when no Homebrew ttyd exists, and an unknown mode', () => {
      assert.throws(() => runtime.resolveTtydPath({ baseDir: base, env: { TANGLECLAW_TTYD_RUNTIME: 'homebrew' }, deps: deps(null) }), /no Homebrew ttyd is installed/);
      assert.throws(() => runtime.resolveTtydPath({ baseDir: base, env: { TANGLECLAW_TTYD_RUNTIME: 'auto' }, deps: deps('/opt/homebrew/bin/ttyd') }), /is not "managed" or "homebrew"/);
    });
  });

  describe('installRuntime — transactional, keeps the last known good', () => {
    it('refuses a staged runtime that does not verify, and changes nothing', () => {
      const s = path.join(scratch, 'bad');
      stage(s, 'linked against homebrew\n');
      assert.throws(() => runtime.installRuntime({ baseDir: base, stageDir: s, deps: deps() }), /does not verify; nothing was changed/);
      assert.equal(fs.existsSync(P().bin) && fs.readdirSync(P().bin).length > 0, false, 'nothing written');
    });

    it('a failed install leaves the current runtime and its last known good exactly as they were', () => {
      const s1 = path.join(scratch, 's1');
      const s2 = path.join(scratch, 's2');
      const s3 = path.join(scratch, 's3');
      const d1 = stage(s1, 'ttyd version 1.7.7-a\n');
      const d2 = stage(s2, 'ttyd version 1.7.7-b\n');
      runtime.installRuntime({ baseDir: base, stageDir: s1, deps: deps() });
      runtime.installRuntime({ baseDir: base, stageDir: s2, deps: deps() });
      stage(s3, 'ttyd version 1.7.7-c\n', { binary: { sha256: 'f'.repeat(64), version: 'x' } });
      assert.throws(() => runtime.installRuntime({ baseDir: base, stageDir: s3, deps: deps() }));
      assert.equal(runtime.runtimeStatus({ baseDir: base, deps: deps() }).current.sha256, d2);
      assert.equal(runtime.runtimeStatus({ baseDir: base, deps: deps() }).previous.sha256, d1);
      assert.equal(fs.existsSync(P().staging), false, 'no staging file left behind');
    });

    it('keeps the replaced runtime as the last known good', () => {
      const d1 = stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      const d2 = stage(path.join(scratch, 's2'), 'ttyd version 1.7.7-b\n');
      const first = runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: deps() });
      assert.deepEqual(first, { installed: d1, previous: null, keptPrevious: false });
      const second = runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's2'), deps: deps() });
      assert.deepEqual(second, { installed: d2, previous: d1, keptPrevious: true });
    });

    it('never overwrites a good last-known-good with a current runtime that does not verify', () => {
      const d1 = stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      stage(path.join(scratch, 's2'), 'ttyd version 1.7.7-b\n');
      stage(path.join(scratch, 's3'), 'ttyd version 1.7.7-c\n');
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: deps() });
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's2'), deps: deps() });
      fs.writeFileSync(P().ttyd, 'ttyd version 1.7.7-b\n# corrupted\n');
      const r = runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's3'), deps: deps() });
      assert.equal(r.keptPrevious, false);
      assert.equal(runtime.runtimeStatus({ baseDir: base, deps: deps() }).previous.sha256, d1, 'the good fallback survived');
    });
  });

  describe('the last known good is never written in place', () => {
    // A signed binary modified in place can be killed by macOS when it next
    // runs, and rollback runs the last known good to verify it.
    it('install replaces ttyd.prev with a new file rather than rewriting it', () => {
      for (const n of ['a', 'b', 'c']) stage(path.join(scratch, n), `ttyd version 1.7.7-${n}\n`);
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 'a'), deps: deps() });
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 'b'), deps: deps() });
      const before = fs.statSync(P().prev).ino;
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 'c'), deps: deps() });
      assert.notEqual(fs.statSync(P().prev).ino, before);
      assert.equal(fs.existsSync(`${P().prev}.tmp`), false, 'no temporary copy is left behind');
    });

    it('rollback replaces ttyd.rolled-back with a new file rather than rewriting it', () => {
      for (const n of ['a', 'b']) stage(path.join(scratch, n), `ttyd version 1.7.7-${n}\n`);
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 'a'), deps: deps() });
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 'b'), deps: deps() });
      runtime.rollbackRuntime({ baseDir: base, deps: deps() });
      const before = fs.statSync(P().discarded).ino;
      runtime.rollbackRuntime({ baseDir: base, deps: deps() });
      assert.notEqual(fs.statSync(P().discarded).ino, before);
    });
  });

  describe('rollbackRuntime', () => {
    it('restores the last known good and sets the replaced runtime aside', () => {
      const d1 = stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      stage(path.join(scratch, 's2'), 'ttyd version 1.7.7-b\n');
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: deps() });
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's2'), deps: deps() });
      const r = runtime.rollbackRuntime({ baseDir: base, deps: deps() });
      assert.equal(r.restored, d1);
      assert.equal(r.setAside, P().discarded);
      assert.equal(runtime.resolveTtydPath({ baseDir: base, env: {}, deps: deps() }).path, P().ttyd);
      assert.equal(runtime.runtimeStatus({ baseDir: base, deps: deps() }).current.sha256, d1);
    });

    it('refuses when there is no verified last known good', () => {
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: (stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n'), deps()) });
      assert.throws(() => runtime.rollbackRuntime({ baseDir: base, deps: deps() }), /no verified last-known-good/);
    });
  });

  // A runtime is current only when it was built from the very inputs.json this
  // checkout tracks. Its sources and patches can all match and it is still
  // stale when a build flag, the CMake pin or the deployment target changed.
  describe('currency — the whole deploy/ttyd/inputs.json, not a subset of it', () => {
    it('refuses a runtime built from a different inputs.json even when every source and patch matches', () => {
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: (stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n'), deps()) });
      const v = runtime.verifyRuntime(P().ttyd, P().manifest, deps(null, REPINNED));
      assert.equal(v.ok, false);
      assert.equal(v.stale, true);
      assert.equal(v.reasons.length, 1, 'only the input set differs');
      assert.match(v.reasons[0], /it is stale: it was built from deploy\/ttyd\/inputs\.json 1{64}, and this checkout pins 2{64}/);
      assert.throws(() => runtime.resolveTtydPath({ baseDir: base, env: {}, deps: deps(null, REPINNED) }), /it is stale/);
    });

    it('refuses a runtime whose manifest records no input set as stale', () => {
      const s = path.join(scratch, 'old');
      stage(s, 'ttyd version 1.7.7-a\n', { inputs: { sources: BUILT_FROM.sources, patches: BUILT_FROM.patches } });
      const v = runtime.verifyRuntime(path.join(s, 'ttyd'), path.join(s, 'manifest.json'), deps());
      assert.equal(v.stale, true);
      assert.match(v.reasons.join('\n'), /inputs\.json an unrecorded input set/);
    });

    it('a current runtime is not stale', () => {
      const s = path.join(scratch, 's1');
      stage(s, 'ttyd version 1.7.7-a\n');
      assert.deepEqual(runtime.verifyRuntime(path.join(s, 'ttyd'), path.join(s, 'manifest.json'), deps()).stale, false);
    });

    it('the real input set is the SHA-256 of deploy/ttyd/inputs.json itself', () => {
      const file = fs.readFileSync(path.join(REPO, 'deploy', 'ttyd', 'inputs.json'));
      assert.equal(runtime.defaultDeps().expectedInputs().inputsJsonSha256, sha(file));
    });

    // The builder and the resolver read the digest through one helper, and a
    // build records the digest of the bytes it read, even if the file changes
    // while it runs.
    it('readPinnedInputs hashes exactly the bytes it parsed', () => {
      const file = path.join(scratch, 'inputs.json');
      const text = JSON.stringify({ sources: [{ name: 'ttyd', sha256: 'a'.repeat(64) }], patches: [] });
      fs.writeFileSync(file, text);
      const pinned = runtime.readPinnedInputs(file);
      assert.equal(pinned.sha256, sha(text));
      assert.deepEqual(pinned.inputs.sources, [{ name: 'ttyd', sha256: 'a'.repeat(64) }]);
    });

    it('a build records the digest it read, not the file as it is when the build ends', () => {
      const { manifestInputs } = require('../scripts/build-ttyd');
      const file = path.join(scratch, 'inputs.json');
      const before = JSON.stringify({ sources: [{ name: 'ttyd', version: '1', url: 'u', sha256: 'a'.repeat(64) }], patches: [], cmake: { version: '3', sha256: 'c'.repeat(64) } });
      fs.writeFileSync(file, before);
      const pinned = runtime.readPinnedInputs(file);
      fs.writeFileSync(file, before.replace('"1"', '"2"'));
      assert.equal(manifestInputs(pinned).inputsJsonSha256, sha(before));
    });

    it('a manifest from the builder\'s record is current for the resolver reading the same inputs.json', () => {
      const { manifestInputs } = require('../scripts/build-ttyd');
      const pinned = runtime.readPinnedInputs();
      const recorded = manifestInputs(pinned);
      const s = path.join(scratch, 'real');
      stage(s, 'ttyd version 1.7.7-real\n', { inputs: recorded });
      const v = runtime.verifyRuntime(path.join(s, 'ttyd'), path.join(s, 'manifest.json'), { ...deps(), expectedInputs: runtime.defaultDeps().expectedInputs });
      assert.equal(v.stale, false);
      assert.deepEqual(v.reasons, []);
    });

    it('after a pin change, rollback refuses the stale last known good and names the Homebrew way back', () => {
      stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      stage(path.join(scratch, 's2'), 'ttyd version 1.7.7-b\n');
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: deps() });
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's2'), deps: deps() });
      assert.throws(
        () => runtime.rollbackRuntime({ baseDir: base, deps: deps(null, REPINNED) }),
        (err) => err instanceof runtime.RuntimeUnavailableError
          && /no verified last-known-good/.test(err.message)
          && /it is stale/.test(err.message)
          && /set TANGLECLAW_TTYD_RUNTIME=homebrew/.test(err.message)
      );
    });

    it('the refusal of a broken runtime names the rollback when a verified last known good is kept', () => {
      const d1 = stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      stage(path.join(scratch, 's2'), 'ttyd version 1.7.7-b\n');
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: deps() });
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's2'), deps: deps() });
      fs.writeFileSync(P().ttyd, 'ttyd version 1.7.7-b\n# corrupted\n');
      assert.throws(() => runtime.resolveTtydPath({ baseDir: base, env: {}, deps: deps() }),
        (err) => err.message.includes(`a verified last-known-good runtime (${d1})`) && err.message.includes('node scripts/ttyd-runtime.js rollback'));
    });

    // install.sh rewrites the ttyd plist for direct mode, so it is the wrong
    // repair on a caddy-mode host: the refusal leads with provision and names
    // the switch for each mode.
    it('the refusal leads with provision and names the right switch for each ingress mode', () => {
      assert.throws(() => runtime.resolveTtydPath({ baseDir: base, env: {}, deps: deps() }), (err) => {
        const repair = err.message.slice(err.message.indexOf(runtime.REPAIR));
        assert.ok(repair.startsWith('Run `node scripts/ttyd-runtime.js provision`'), repair);
        assert.match(repair, /direct mode: `\.\/deploy\/install\.sh`/);
        assert.match(repair, /caddy mode: `node scripts\/ingress-cutover\.js --to caddy`/);
        assert.match(repair, /never deploy\/install\.sh/);
        return true;
      });
    });
  });

  // deploy/install.sh is the provisioner: it builds only when the installed
  // runtime is absent, invalid or stale, and never under the Homebrew rollback.
  describe('provisionRuntime — what install.sh runs', () => {
    /**
     * Deps whose build stages a runtime (and records each call).
     * @param {string} content - The binary the build produces.
     * @param {object} [expected] - The pinned inputs.
     * @param {object} [manifestOverride] - Replace fields of the built manifest.
     * @returns {{d: object, calls: Array<{work: string, out: string}>}}
     */
    function building(content, expected = EXPECTED, manifestOverride = {}) {
      const calls = [];
      const d = deps(null, expected);
      d.build = ({ work, out }) => {
        calls.push({ work, out });
        stage(out, content, { inputs: { ...BUILT_FROM, inputsJsonSha256: expected.inputsJsonSha256 }, ...manifestOverride });
      };
      return { d, calls };
    }

    it('builds and installs a runtime when none is installed, then selects it', () => {
      const { d, calls } = building('ttyd version 1.7.7-built\n');
      const r = runtime.provisionRuntime({ baseDir: base, env: {}, deps: d });
      assert.equal(calls.length, 1);
      assert.equal(r.built, true);
      assert.equal(r.installed, sha('ttyd version 1.7.7-built\n'));
      assert.deepEqual({ path: r.path, managed: r.managed, warning: r.warning }, { path: P().ttyd, managed: true, warning: null });
      assert.equal(fs.existsSync(path.dirname(calls[0].out)), false, 'the temporary build is removed after a successful install');
    });

    it('keeps a runtime that verifies and is current, without building', () => {
      const d1 = stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: deps() });
      const r = runtime.provisionRuntime({ baseDir: base, env: {}, deps: deps() });
      assert.deepEqual(r, { path: P().ttyd, managed: true, warning: null, built: false, installed: null });
      assert.equal(runtime.runtimeStatus({ baseDir: base, env: {}, deps: deps() }).current.sha256, d1);
    });

    it('rebuilds a stale runtime, and the stale one is not kept as the last known good', () => {
      const d1 = stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: deps() });
      const { d, calls } = building('ttyd version 1.7.7-repinned\n', REPINNED);
      const r = runtime.provisionRuntime({ baseDir: base, env: {}, deps: d });
      assert.equal(calls.length, 1);
      assert.equal(r.built, true);
      const st = runtime.runtimeStatus({ baseDir: base, env: {}, deps: d });
      assert.equal(st.current.sha256, sha('ttyd version 1.7.7-repinned\n'));
      assert.equal(st.current.ok, true);
      assert.notEqual(st.previous.sha256, d1, 'a stale runtime does not become the last known good');
    });

    it('rebuilds an invalid runtime', () => {
      stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: deps() });
      fs.writeFileSync(P().ttyd, 'ttyd version 1.7.7-a\n# tampered\n');
      const { d, calls } = building('ttyd version 1.7.7-rebuilt\n');
      assert.equal(runtime.provisionRuntime({ baseDir: base, env: {}, deps: d }).built, true);
      assert.equal(calls.length, 1);
      assert.equal(runtime.resolveTtydPath({ baseDir: base, env: {}, deps: d }).path, P().ttyd);
    });

    it('never builds under the explicit Homebrew rollback, and warns', () => {
      const { d, calls } = building('ttyd version 1.7.7-built\n');
      d.homebrewTtyd = () => '/opt/homebrew/bin/ttyd';
      const r = runtime.provisionRuntime({ baseDir: base, env: { TANGLECLAW_TTYD_RUNTIME: 'homebrew' }, deps: d });
      assert.equal(calls.length, 0);
      assert.equal(r.path, '/opt/homebrew/bin/ttyd');
      assert.equal(r.managed, false);
      assert.match(r.warning, /WITHOUT the #1245 leak fix/);
    });

    it('never builds for an unknown mode', () => {
      const { d, calls } = building('ttyd version 1.7.7-built\n');
      assert.throws(() => runtime.provisionRuntime({ baseDir: base, env: { TANGLECLAW_TTYD_RUNTIME: 'auto' }, deps: d }), /is not "managed" or "homebrew"/);
      assert.equal(calls.length, 0);
    });

    it('a failed build installs nothing, keeps the build for inspection, and refuses with the repair', () => {
      const d = deps();
      let work = null;
      d.build = ({ work: w }) => { work = path.dirname(w); throw new Error('cmake exited 1'); };
      assert.throws(() => runtime.provisionRuntime({ baseDir: base, env: {}, deps: d }),
        (err) => err instanceof runtime.RuntimeUnavailableError
          && /building the owned ttyd runtime failed \(cmake exited 1\); nothing was installed/.test(err.message)
          && err.message.includes(work)
          && err.message.includes(runtime.REPAIR));
      assert.equal(fs.existsSync(work), true, 'the failed build is kept');
      assert.equal(fs.existsSync(P().ttyd), false, 'nothing installed');
      fs.rmSync(work, { recursive: true, force: true });
    });

    it('when the install of a verified build fails, the build is kept and the refusal says how to install it', () => {
      const d = deps();
      let stageDir = null;
      d.build = ({ out }) => { stageDir = out; stage(out, 'ttyd version 1.7.7-built\n'); };
      const realRename = d.fs.renameSync;
      d.fs.renameSync = (from, to) => { if (to === P().ttyd) throw new Error('EIO: i/o error'); realRename(from, to); };
      assert.throws(() => runtime.provisionRuntime({ baseDir: base, env: {}, deps: d }),
        (err) => err instanceof runtime.RuntimeUnavailableError
          && err.message.includes(`The build is kept at ${stageDir}`)
          && err.message.includes(`node scripts/ttyd-runtime.js install --from ${stageDir}`));
      assert.equal(fs.existsSync(path.join(stageDir, 'ttyd')), true, 'the build is kept');
      fs.rmSync(path.dirname(stageDir), { recursive: true, force: true });
    });

    it('a build that produces a runtime which does not verify installs nothing and keeps the current one', () => {
      const d1 = stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: deps() });
      const { d, calls } = building('linked against homebrew\n', REPINNED);
      assert.throws(() => runtime.provisionRuntime({ baseDir: base, env: {}, deps: d }), /the staged runtime in .* does not verify; nothing was changed/);
      assert.equal(runtime.runtimeStatus({ baseDir: base, env: {}, deps: deps() }).current.sha256, d1);
      fs.rmSync(path.dirname(calls[0].out), { recursive: true, force: true });
    });
  });

  describe('runtimeStatus — says which ttyd is selected', () => {
    it('reports the managed runtime as selected when it verifies', () => {
      stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: deps() });
      const st = runtime.runtimeStatus({ baseDir: base, env: {}, deps: deps() });
      assert.deepEqual(st.selected, { path: P().ttyd, managed: true, warning: null, refused: null });
      assert.equal(st.current.stale, false);
    });

    it('reports the refusal, not a path, when nothing can be selected', () => {
      const st = runtime.runtimeStatus({ baseDir: base, env: {}, deps: deps() });
      assert.equal(st.selected.path, null);
      assert.match(st.selected.refused, /missing or not executable/);
    });

    it('reports the Homebrew rollback as selected, with its warning', () => {
      const st = runtime.runtimeStatus({ baseDir: base, env: { TANGLECLAW_TTYD_RUNTIME: 'homebrew' }, deps: deps('/opt/homebrew/bin/ttyd') });
      assert.equal(st.selected.path, '/opt/homebrew/bin/ttyd');
      assert.equal(st.selected.managed, false);
      assert.match(st.selected.warning, /WITHOUT the #1245 leak fix/);
    });

    it('reports a stale runtime as stale', () => {
      stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 's1'), deps: deps() });
      const st = runtime.runtimeStatus({ baseDir: base, env: {}, deps: deps(null, REPINNED) });
      assert.equal(st.current.stale, true);
      assert.match(st.selected.refused, /it is stale/);
    });
  });

  // A binary and its manifest are two filesystem entries, so the pair cannot be
  // replaced atomically. The guarantee instead: interrupted at ANY copy, chmod
  // or rename, either the selected pair verifies, or the resolver refuses the
  // partial state and a verified last-known-good pair survives for rollback.
  describe('fault injection at every copy, chmod and rename boundary', () => {
    /**
     * Deps whose mutating filesystem calls are logged and, at call number
     * `failAt` (1-based), fail: a copy leaves a truncated file first (a full
     * disk), a rename or chmod just fails.
     * @param {number} failAt - Which mutating call fails (0 = none).
     * @returns {{d: object, ops: string[], fired: () => boolean}}
     */
    function faulty(failAt) {
      const d = deps();
      const ops = [];
      let fired = false;
      const at = (label) => {
        ops.push(label);
        if (ops.length === failAt) { fired = true; return true; }
        return false;
      };
      const rel = (f) => path.relative(base, f) || f;
      d.fs = {
        copyFileSync: (from, to) => {
          if (at(`copy ${path.basename(from)} -> ${rel(to)}`)) {
            const bytes = fs.readFileSync(from);
            fs.writeFileSync(to, bytes.subarray(0, Math.floor(bytes.length / 2)));
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          }
          fs.copyFileSync(from, to);
        },
        renameSync: (from, to) => {
          if (at(`rename ${rel(from)} -> ${rel(to)}`)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
          fs.renameSync(from, to);
        },
        chmodSync: (file, mode) => {
          if (at(`chmod ${rel(file)}`)) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
          fs.chmodSync(file, mode);
        }
      };
      return { d, ops, fired: () => fired };
    }

    /** Current runtime B, last known good A; returns their digests and a third staged runtime C. */
    function twoInstalled() {
      const A = stage(path.join(scratch, 'sA'), 'ttyd version 1.7.7-A\n');
      const B = stage(path.join(scratch, 'sB'), 'ttyd version 1.7.7-B\n');
      const C = stage(path.join(scratch, 'sC'), 'ttyd version 1.7.7-C\n');
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 'sA'), deps: deps() });
      runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 'sB'), deps: deps() });
      return { A, B, C };
    }

    /**
     * The recoverability guarantee after an interrupted mutation.
     * @param {string[]} selectable - Digests the resolver may select.
     * @param {string[]} restorable - Digests a rollback may restore when it refuses.
     * @param {string} label - What was interrupted.
     */
    function assertRecoverable(selectable, restorable, label) {
      let selected = null;
      try {
        selected = runtime.resolveTtydPath({ baseDir: base, env: {}, deps: deps() });
      } catch (err) {
        assert.ok(err instanceof runtime.RuntimeUnavailableError, `${label}: a typed refusal`);
        assert.match(err.message, /node scripts\/ttyd-runtime\.js rollback/, `${label}: the refusal names the rollback`);
        const r = runtime.rollbackRuntime({ baseDir: base, deps: deps() });
        assert.ok(restorable.includes(r.restored), `${label}: rollback restored ${r.restored}`);
        selected = runtime.resolveTtydPath({ baseDir: base, env: {}, deps: deps() });
      }
      const sel = runtime.runtimeStatus({ baseDir: base, env: {}, deps: deps() }).current.sha256;
      assert.equal(selected.path, P().ttyd, label);
      assert.ok(selectable.includes(sel) || restorable.includes(sel), `${label}: selected ${sel}`);
    }

    /** Run `fn(failAt)` for every boundary a clean run crosses. */
    function everyBoundary(setup, act, check) {
      const clean = faulty(0);
      const fresh = () => { fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(base); return setup(); };
      const ctx0 = fresh();
      act(ctx0, clean.d);
      const total = clean.ops.length;
      for (let k = 1; k <= total; k++) {
        const ctx = fresh();
        const f = faulty(k);
        assert.throws(() => act(ctx, f.d), (err) => err instanceof runtime.RuntimeUnavailableError, `boundary ${k} (${f.ops[k - 1]}) refuses with the typed error`);
        assert.ok(f.fired(), `boundary ${k} was reached`);
        check(ctx, `interrupted at ${f.ops[k - 1]}`);
      }
      return clean.ops;
    }

    it('install: every boundary leaves the old or new runtime selected, or a verified last known good to roll back to', () => {
      const ops = everyBoundary(
        twoInstalled,
        (ctx, d) => runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 'sC'), deps: d }),
        (ctx, label) => assertRecoverable([ctx.B, ctx.C], [ctx.B, ctx.A], label)
      );
      // Not vacuous: the run crosses the staging copies, the last-known-good
      // copies and both renames.
      assert.deepEqual(ops, [
        'copy ttyd -> bin/ttyd.new', 'chmod bin/ttyd.new', 'copy manifest.json -> bin/ttyd.new.manifest.json',
        'copy ttyd -> bin/ttyd.prev.tmp', 'chmod bin/ttyd.prev.tmp', 'copy ttyd.manifest.json -> bin/ttyd.prev.manifest.json.tmp',
        'rename bin/ttyd.prev.manifest.json.tmp -> bin/ttyd.prev.manifest.json', 'rename bin/ttyd.prev.tmp -> bin/ttyd.prev',
        'rename bin/ttyd.new.manifest.json -> bin/ttyd.manifest.json', 'rename bin/ttyd.new -> bin/ttyd'
      ]);
    });

    it('first install: every boundary leaves either the new runtime or no runtime, never a selectable partial one', () => {
      const ops = everyBoundary(
        () => ({ C: stage(path.join(scratch, 'sC'), 'ttyd version 1.7.7-C\n') }),
        (ctx, d) => runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 'sC'), deps: d }),
        (ctx, label) => {
          const st = runtime.runtimeStatus({ baseDir: base, env: {}, deps: deps() });
          assert.ok(st.selected.path === null || st.current.sha256 === ctx.C, `${label}: nothing partial is selected`);
        }
      );
      assert.equal(ops.at(-1), 'rename bin/ttyd.new -> bin/ttyd');
    });

    it('rollback: every boundary leaves the current or restored runtime selected, or the last known good still verified', () => {
      const ops = everyBoundary(
        twoInstalled,
        (ctx, d) => runtime.rollbackRuntime({ baseDir: base, deps: d }),
        (ctx, label) => {
          assert.equal(runtime.runtimeStatus({ baseDir: base, env: {}, deps: deps() }).previous.sha256, ctx.A, `${label}: the last known good is intact`);
          assertRecoverable([ctx.B, ctx.A], [ctx.A], label);
        }
      );
      assert.deepEqual(ops, [
        'copy ttyd.prev -> bin/ttyd.new', 'chmod bin/ttyd.new', 'copy ttyd.prev.manifest.json -> bin/ttyd.new.manifest.json',
        'copy ttyd -> bin/ttyd.rolled-back.tmp', 'chmod bin/ttyd.rolled-back.tmp', 'copy ttyd.manifest.json -> bin/ttyd.rolled-back.manifest.json.tmp',
        'rename bin/ttyd.rolled-back.manifest.json.tmp -> bin/ttyd.rolled-back.manifest.json', 'rename bin/ttyd.rolled-back.tmp -> bin/ttyd.rolled-back',
        'rename bin/ttyd.new.manifest.json -> bin/ttyd.manifest.json', 'rename bin/ttyd.new -> bin/ttyd'
      ]);
    });

    it('a staging copy that fails leaves no staging file behind', () => {
      twoInstalled();
      const f = faulty(1);
      assert.throws(() => runtime.installRuntime({ baseDir: base, stageDir: path.join(scratch, 'sC'), deps: f.d }), /installation was interrupted \(ENOSPC/);
      assert.equal(fs.existsSync(P().staging), false);
      assert.equal(fs.existsSync(P().stagingManifest), false);
    });
  });

  describe('scripts/ttyd-runtime.js', () => {
    /**
     * Run the CLI in-process.
     * @param {string[]} argv
     * @param {object} [env]
     * @param {string|null} [homebrew]
     * @returns {{code: number, out: string, err: string}}
     */
    function run(argv, env = {}, homebrew = null) {
      const out = [];
      const err = [];
      const code = cli.main(argv, { baseDir: base, env, deps: deps(homebrew), out: (s) => out.push(s), err: (s) => err.push(s) });
      return { code, out: out.join('\n'), err: err.join('\n') };
    }

    it('resolve prints only the path on stdout, and exits 3 with the repair when nothing fits', () => {
      const miss = run(['resolve']);
      assert.equal(miss.code, 3);
      assert.equal(miss.out, '');
      assert.match(miss.err, /node scripts\/build-ttyd\.js/);
      stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      assert.equal(run(['install', '--from', path.join(scratch, 's1')]).code, 0);
      assert.deepEqual(run(['resolve']), { code: 0, out: runtime.runtimePaths(base).ttyd, err: '' });
    });

    it('resolve under the explicit Homebrew rollback warns on stderr, keeping stdout a bare path', () => {
      const r = run(['resolve'], { TANGLECLAW_TTYD_RUNTIME: 'homebrew' }, '/opt/homebrew/bin/ttyd');
      assert.equal(r.code, 0);
      assert.equal(r.out, '/opt/homebrew/bin/ttyd');
      assert.match(r.err, /^WARNING: .*WITHOUT the #1245 leak fix/);
    });

    it('--base-dir overrides the default base, wherever it appears', () => {
      const other = path.join(scratch, 'other');
      fs.mkdirSync(other);
      stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      const out = [];
      const code = cli.main(['--base-dir', other, 'install', '--from', path.join(scratch, 's1')], { baseDir: base, env: {}, deps: deps(), out: (s) => out.push(s), err: () => {} });
      assert.equal(code, 0);
      assert.equal(fs.existsSync(runtime.runtimePaths(other).ttyd), true, 'installed under --base-dir');
      assert.equal(fs.existsSync(runtime.runtimePaths(base).ttyd), false, 'not under the default');
      assert.equal(cli.main(['resolve', '--base-dir'], { baseDir: base, env: {}, deps: deps(), out: () => {}, err: () => {} }), 2);
    });

    // install.sh writes provision's stdout into the plist as the ttyd path, so
    // stdout must be exactly one bare path, whatever else happens.
    it('provision prints only the bare path on stdout when it builds, logging to stderr', () => {
      const d = deps();
      d.build = ({ out }) => stage(out, 'ttyd version 1.7.7-built\n');
      const out = [];
      const err = [];
      const code = cli.main(['provision'], { baseDir: base, env: {}, deps: d, out: (x) => out.push(x), err: (x) => err.push(x) });
      assert.equal(code, 0);
      assert.deepEqual(out, [runtime.runtimePaths(base).ttyd]);
      assert.match(err.join('\n'), /must be built/);
      assert.match(err.join('\n'), /built and installed the owned ttyd runtime [0-9a-f]{64}/);
    });

    it('provision prints only the bare path when the runtime is already current', () => {
      stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      run(['install', '--from', path.join(scratch, 's1')]);
      assert.deepEqual(run(['provision']), { code: 0, out: runtime.runtimePaths(base).ttyd, err: '' });
    });

    it('provision under the Homebrew rollback prints only the path, with the warning on stderr', () => {
      const r = run(['provision'], { TANGLECLAW_TTYD_RUNTIME: 'homebrew' }, '/opt/homebrew/bin/ttyd');
      assert.equal(r.code, 0);
      assert.equal(r.out, '/opt/homebrew/bin/ttyd');
      assert.match(r.err, /^WARNING: .*WITHOUT the #1245 leak fix/);
    });

    it('provision prints nothing on stdout when it refuses', () => {
      const d = deps();
      d.build = () => { throw new Error('no compiler'); };
      const out = [];
      const code = cli.main(['provision'], { baseDir: base, env: {}, deps: d, out: (x) => out.push(x), err: () => {} });
      assert.equal(code, 3);
      assert.deepEqual(out, []);
    });

    // A real build prints progress on stdout; install.sh captures provision's
    // stdout as the plist's ttyd path, so the default build must send its
    // output to stderr. Runs the default build in a child process with a
    // stand-in builder and looks at what reaches that process's stdout.
    it('the default build sends the builder\'s output to stderr, never stdout', () => {
      const fake = path.join(scratch, 'fake-build.js');
      fs.writeFileSync(fake, "console.log('[build-ttyd] noisy progress line'); console.error('[build-ttyd] to stderr');\n");
      const driver = `require(${JSON.stringify(path.join(REPO, 'lib', 'ttyd-runtime'))}).defaultDeps().build({ work: ${JSON.stringify(path.join(scratch, 'w'))}, out: ${JSON.stringify(path.join(scratch, 'o'))}, script: ${JSON.stringify(fake)} })`;
      const r = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '', 'nothing from the build reaches stdout');
      assert.match(r.stderr, /noisy progress line/);
    });

    // Every message that sends the operator on to selecting the runtime uses
    // the one per-mode text, so none can send a caddy host to install.sh.
    it('install, rollback and the refusal all name the per-mode switch', () => {
      stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      stage(path.join(scratch, 's2'), 'ttyd version 1.7.7-b\n');
      assert.ok(run(['install', '--from', path.join(scratch, 's1')]).out.includes(runtime.SELECT_BY_MODE));
      run(['install', '--from', path.join(scratch, 's2')]);
      assert.ok(run(['rollback']).out.includes(runtime.SELECT_BY_MODE));
      assert.ok(runtime.REPAIR.includes(runtime.SELECT_BY_MODE));
      assert.match(runtime.SELECT_BY_MODE, /direct mode: `\.\/deploy\/install\.sh`; caddy mode: `node scripts\/ingress-cutover\.js --to caddy` \(never deploy\/install\.sh/);
    });

    it('install says ttyd was not restarted', () => {
      stage(path.join(scratch, 's1'), 'ttyd version 1.7.7-a\n');
      assert.match(run(['install', '--from', path.join(scratch, 's1')]).out, /NOT been restarted/);
    });
  });

  // The two writers of the ttyd plist ask the one resolver; neither may
  // rediscover ttyd on PATH, which would quietly reinstate the leaking build.
  describe('wiring: install.sh and the ingress cutover (ADR 0018 §1)', () => {
    const installSh = fs.readFileSync(path.join(REPO, 'deploy', 'install.sh'), 'utf8');
    const cutover = fs.readFileSync(path.join(REPO, 'scripts', 'ingress-cutover.js'), 'utf8');

    // install.sh is the runtime's provisioner (ADR 0018 §4): it builds and
    // installs a current runtime when needed, then selects it through the
    // same resolver. `provision` prints the resolved path exactly as
    // `resolve` does.
    it('install.sh provisions TTYD_PATH through the resolver, never from PATH, and stops before writing any plist', () => {
      assert.match(installSh, /TTYD_PATH="\$\(node "\$\{REPO_DIR\}\/scripts\/ttyd-runtime\.js" provision --base-dir "\$HOME\/\.tangleclaw"\)" \|\| \{/);
      assert.doesNotMatch(installSh, /TTYD_PATH="\$\(command -v ttyd\)"/);
      assert.ok(installSh.indexOf('ttyd-runtime.js" provision') < installSh.indexOf('__TTYD_PATH__'),
        'the runtime is provisioned before the plist is generated');
      assert.match(installSh.slice(installSh.indexOf('ttyd-runtime.js" provision')), /^\s+exit 1$/m);
    });

    it('the cutover declares the selected runtime before any exit can report it', () => {
      assert.ok(cutover.indexOf('let ttydRuntime = null;') !== -1 && cutover.indexOf('let ttydRuntime = null;') < cutover.indexOf('const finish = '),
        'declared before finish, so an early refusal reports null instead of throwing');
      assert.match(cutover, /ok: !error, code, target, error: error \|\| null, ttydRuntime, \.\.\.extra/);
    });

    it('the ingress cutover resolves through the same library and never calls which(\'ttyd\')', () => {
      assert.doesNotMatch(cutover, /which\('ttyd'\)/);
      assert.match(cutover, /ttydRuntimeLib\.resolveTtydPath\(\{ baseDir \}\)/);
      assert.match(cutover, /TTYD_RUNTIME_UNAVAILABLE: 'ttyd-runtime-unavailable'/);
      assert.match(cutover, /finish\(CUTOVER_CODES\.TTYD_RUNTIME_UNAVAILABLE, err\.message\)/);
      assert.match(cutover, /ttydPath: ttydRuntime\.path/);
    });
  });
});
