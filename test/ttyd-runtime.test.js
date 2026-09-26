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

const runtime = require('../lib/ttyd-runtime');
const cli = require('../scripts/ttyd-runtime');

const REPO = path.join(__dirname, '..');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// The pinned inputs a runtime must have been built from (stands in for
// deploy/ttyd/inputs.json), and a manifest's record of building from them.
const EXPECTED = { sources: [{ name: 'ttyd', sha256: 'a'.repeat(64) }, { name: 'libwebsockets', sha256: 'b'.repeat(64) }], patches: ['c'.repeat(64), 'd'.repeat(64)] };
const BUILT_FROM = { sources: EXPECTED.sources, patches: EXPECTED.patches.map((d) => ({ sha256: d })) };

/**
 * Host operations for tests: a "binary" is a file whose text is its version
 * line; one containing "homebrew" fails the closure; one containing "broken"
 * does not run.
 * @param {string|null} [homebrew] - What the Homebrew lookup returns.
 * @returns {object}
 */
function deps(homebrew = null) {
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
    expectedInputs: () => EXPECTED
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

    it('install.sh takes TTYD_PATH from the resolver, never from PATH, and stops before writing any plist', () => {
      assert.match(installSh, /TTYD_PATH="\$\(node "\$\{REPO_DIR\}\/scripts\/ttyd-runtime\.js" resolve --base-dir "\$HOME\/\.tangleclaw"\)" \|\| \{/);
      assert.doesNotMatch(installSh, /TTYD_PATH="\$\(command -v ttyd\)"/);
      assert.ok(installSh.indexOf('ttyd-runtime.js" resolve') < installSh.indexOf('__TTYD_PATH__'),
        'the runtime is resolved before the plist is generated');
      assert.match(installSh.slice(installSh.indexOf('ttyd-runtime.js" resolve')), /^\s+exit 1$/m);
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
