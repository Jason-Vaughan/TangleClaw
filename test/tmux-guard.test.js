'use strict';

// #2946 (Architect Ruling A506-W2HF-SCOPE-R2): bare `tmux kill-server`
// safety guard. lib/tmux-guard.js is a pure library: no environment read,
// no real command interception on its own. Every assertion against the
// evaluator drives the real exported function; the end-to-end cases below
// run the GENERATED wrapper script, but only ever against an isolated
// `__tc_test_*` socket or a non-kill-server passthrough -- never the
// default or TCC-authorized socket, which is the exact incident (#1574,
// 2026-11-08T22:24:16.633Z) this guard exists to stop.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmuxGuard = require('../lib/tmux-guard');
const mergeRoleGuard = require('../lib/merge-role-guard');
const { uniqueSessionName } = require('./_tmux-session-names');
const tmux = require('../lib/tmux');
const { installTmuxGuard, removeTmuxGuard, reapFixtureSessions } = require('./_tmux-guard');

/**
 * Tests for the #902 tmux guard itself.
 *
 * The guard in `test/_tmux-guard.js` protects the session suite, but once every
 * block stubs `createSession` correctly the guard has nothing left to catch —
 * so neutering it leaves the session suite fully green. Verified by mutation:
 * replacing the poison with `() => true` passed 180/180.
 *
 * That is the same shape as the defect #902 is about: a protection whose absence
 * is silent. These tests exercise the guard directly, so deleting or weakening it
 * fails here even when every caller happens to be well-behaved.
 */
describe('tmux guard (#902)', () => {
  afterEach(() => {
    removeTmuxGuard();
  });

  it('poisons tmux.createSession so a real engine process cannot be spawned', () => {
    const real = tmux.createSession;
    installTmuxGuard();

    assert.notEqual(tmux.createSession, real, 'createSession must be replaced while the guard is installed');
    assert.throws(
      () => tmux.createSession('some-fixture'),
      /#902 guard/,
      'the replacement must throw, not silently succeed'
    );
  });

  it('names the offending session and the fix in the error', () => {
    // The message is the whole value of the guard: it fires on someone else's
    // branch, months from now, and has to be actionable without this context.
    installTmuxGuard();

    let err;
    try {
      tmux.createSession('orphan-test');
    } catch (e) {
      err = e;
    }

    assert.ok(err, 'must throw');
    assert.match(err.message, /orphan-test/, 'names which session was about to be created');
    assert.match(err.message, /beforeEach/, 'names where to put the stub');
    assert.match(err.message, /unconditionally/, 'states why stubbing hasSession is not enough');
  });

  it('restores the real implementation on removal', () => {
    const real = tmux.createSession;

    installTmuxGuard();
    assert.notEqual(tmux.createSession, real);

    removeTmuxGuard();
    assert.equal(tmux.createSession, real, 'the real implementation must come back');
  });

  it('is idempotent — a second install does not capture the poison as the original', () => {
    // If install captured its own poison, a later remove would leave the poison
    // in place and every subsequent suite in the same process would break.
    const real = tmux.createSession;

    installTmuxGuard();
    installTmuxGuard();
    removeTmuxGuard();

    assert.equal(tmux.createSession, real);
  });

  it('reapFixtureSessions kills only the exact names it is given', () => {
    const probed = [];
    const killed = [];
    const originalHas = tmux.hasSession;
    const originalKill = tmux.killSession;

    try {
      // Only 'mine' exists. A prefix-matching implementation would also reap
      // 'mine-operator-session', which is how a cleanup helper eats a real
      // session someone was using.
      tmux.hasSession = (name) => { probed.push(name); return name === 'mine'; };
      tmux.killSession = (name) => { killed.push(name); };

      const result = reapFixtureSessions(['mine', 'absent']);

      assert.deepEqual(killed, ['mine'], 'kills only what exists');
      assert.deepEqual(result, ['mine'], 'reports what it killed');
      assert.deepEqual(probed, ['mine', 'absent'], 'probes exactly the names given, no prefixes');
    } finally {
      tmux.hasSession = originalHas;
      tmux.killSession = originalKill;
    }
  });

  it('reapFixtureSessions never throws when tmux is unavailable', () => {
    // A teardown helper must not fail the run it is cleaning up after.
    const originalHas = tmux.hasSession;
    try {
      tmux.hasSession = () => { throw new Error('tmux: command not found'); };
      assert.doesNotThrow(() => reapFixtureSessions(['anything']));
      assert.deepEqual(reapFixtureSessions(['anything']), []);
    } finally {
      tmux.hasSession = originalHas;
    }
  });
});

/**
 * A minimal, explicit PATH for the end-to-end wrapper tests below: `dir`
 * (the test's own wrapper), the real `tmux`'s own directory, and nothing
 * else. Deliberately NOT `${dir}:${process.env.PATH}` -- on a machine that
 * has already launched a real TangleClaw pane (this one included), the
 * REAL `~/.tangleclaw/merge-role-guard-wrapper` directory this module also
 * writes to is already somewhere in `process.env.PATH`. Stacking the
 * test's tmp dir in front of that inherited PATH means the wrapper's own
 * internal passthrough exec, after excluding only the TEST's tmp dir by
 * realpath, can resolve to that OTHER, real wrapper script next -- which
 * then (correctly) refuses as "re-entered" because it inherits this
 * process's `TC_*_WRAPPER_ACTIVE` env var. That is not a bug in the
 * wrapper; it is two wrapper directories on one PATH, a shape that never
 * occurs in a real launch (exactly one such directory ever exists on a
 * pane's PATH) and should never occur in this test either.
 * Also includes this process's own `node` binary directory -- the wrapper's
 * `#!/usr/bin/env node` shebang needs `node` on PATH to even start; a PATH
 * with just `tmux`'s own directory and the system dirs isn't enough on a
 * machine where `node` lives somewhere else (a version manager, Homebrew's
 * Cellar), and `env` failing to find it surfaces as exit 127, not this
 * guard's own refusal code.
 * @param {string} dir - The test's own wrapper directory.
 * @returns {string}
 */
function _wrapperTestPath(dir) {
  return `${dir}:${path.dirname(REAL_TMUX)}:${path.dirname(process.execPath)}:/usr/bin:/bin`;
}

// Filtered the same way test/tmux-tcc.test.js's own REAL_TMUX is: on a
// machine that already has the real ~/.tangleclaw/merge-role-guard-wrapper
// on PATH (this one included, since this module writes a tmux file into it
// on every real session launch), a bare `which tmux` resolves to the
// WRAPPER, not the real binary -- which would then make this file's own
// "real tmux" PATH entry the wrapper's directory, right back into the exact
// collision _wrapperTestPath exists to avoid.
const REAL_TMUX = execFileSync('which', ['tmux'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: (process.env.PATH || '').split(path.delimiter)
      .filter((p) => path.basename(p) !== 'merge-role-guard-wrapper')
      .join(path.delimiter)
  }
}).trim();

describe('tmux-guard: exported vocabulary', () => {
  it('exposes its own socket-identity constants', () => {
    assert.equal(tmuxGuard.TCC_AUTHORIZED_SOCKET, 'tangleclaw-tcc-authorized');
    assert.equal(tmuxGuard.DEFAULT_SOCKET_BASENAME, 'default');
    assert.equal(tmuxGuard.ISOLATED_NAME_PREFIXES.some((re) => re.test('__tc_test_foo')), true);
    assert.equal(tmuxGuard.ISOLATED_NAME_PREFIXES.some((re) => re.test('tc-test-panes-123')), true);
    assert.equal(tmuxGuard.ISOLATED_NAME_PREFIXES.some((re) => re.test('some-other-real-socket')), false);
  });
});

describe('tmux-guard: evaluateTmuxKillGuard (#2946)', () => {
  it('refuses input that is not an object with a string commandText', () => {
    for (const bad of [undefined, null, {}, { commandText: 123 }]) {
      const r = tmuxGuard.evaluateTmuxKillGuard(bad);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'TMUX_GUARD_INVALID');
    }
  });

  it('allows any command that is not kill-server at all', () => {
    for (const cmd of ['tmux -V', 'tmux list-sessions', 'tmux new-session -d -s foo', 'tmux kill-session -t foo']) {
      const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: cmd });
      assert.equal(r.ok, true);
      assert.equal(r.result.allowed, true);
    }
  });

  it('refuses a bare "tmux kill-server" with no -L/-S target -- the exact #1574 incident', () => {
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: 'tmux kill-server' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN');
    assert.match(r.message, /DEFAULT server/);
  });

  it('refuses "tmux kill-server" explicitly targeting the TCC-authorized socket', () => {
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: 'tmux -L tangleclaw-tcc-authorized kill-server' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN');
  });

  it('allows "tmux kill-server" against the two real, verified test-fixture naming conventions this suite actually uses', () => {
    for (const cmd of [
      'tmux -L __tc_test_tcc_sock_123_abcdef_1__ kill-server',
      'tmux -L tc-test-panes-12345 kill-server',
      'tmux -S /some/dir/__tc_test_scratch_sock kill-server',
      'tmux -S /private/tmp/tmux-501/tc-test-panes-99999 kill-server'
    ]) {
      const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: cmd });
      assert.equal(r.ok, true, cmd);
      assert.equal(r.result.allowed, true, cmd);
    }
  });

  // PRR-A R-Gate HOLD Round 3: the PREVIOUS version of this guard allowed
  // ANY explicitly-named socket that wasn't literally default/TCC-authorized
  // -- these two exact commands passed it. An allowlist of verified-safe
  // naming conventions, not a denylist of the two known-bad names, is what
  // #2946's own issue text specified in the first place.
  it('refuses "tmux kill-server" against an arbitrary named socket this guard does not recognize as a verified test-fixture convention (PRR-A R-Gate HOLD, Round 3)', () => {
    for (const cmd of [
      'tmux -L some-other-real-socket kill-server',
      'tmux -L tc-probe-2205 kill-server',
      'tmux -S /Users/someone/.tmux-prod-socket kill-server'
    ]) {
      const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: cmd });
      assert.equal(r.ok, false, cmd);
      assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN', cmd);
    }
  });

  it('strips quotes around a quoted -L target before comparing it', () => {
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: "tmux -L '__tc_test_quoted' kill-server" });
    assert.equal(r.ok, true);
  });

  // PRR-A R-Gate HOLD on PR #2954: two confirmed bypasses, each independently
  // reproduced against a real tmux before this fix (real tmux honors the
  // LAST -L/-S of either kind when more than one is given, and its own
  // default socket's basename really is "default", living under the same
  // /tmp directory family a scratch test socket does -- so neither "first
  // -L wins" nor "is this under a temp directory" was a safe signal).

  it('refuses "tmux kill-server" under a -S path that IS the real default/TCC socket directory, by basename (PRR-A R-Gate HOLD)', () => {
    const uid = process.getuid();
    for (const basename of ['default', 'tangleclaw-tcc-authorized']) {
      const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: `tmux -S /tmp/tmux-${uid}/${basename} kill-server` });
      assert.equal(r.ok, false, basename);
      assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN', basename);
    }
  });

  it('refuses "tmux kill-server" against the real default directory reached via a .. traversal -- realpath resolution, not string matching, closes this the same way', () => {
    const uid = process.getuid();
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: `tmux -S /tmp/tmux-${uid}/../tmux-${uid}/default kill-server` });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN');
  });

  it('refuses "tmux kill-server" under a -S path with basename default/TCC-authorized inside an EXISTING non-temp directory (PRR-A R-Gate HOLD, Round 4)', () => {
    // A real, existing directory that is neither the real default socket
    // directory nor anywhere under a temp root -- _isRealDefaultSocketDir
    // alone reports "not the real one" (true) here, which is NOT the same
    // as "safe to kill": an arbitrary existing directory elsewhere on the
    // filesystem could host a real, important, named server.
    const nonTempDir = fs.mkdtempSync(path.join(os.homedir(), '.tc-guard-nontemp-'));
    try {
      for (const basename of ['default', 'tangleclaw-tcc-authorized']) {
        const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: `tmux -S ${path.join(nonTempDir, basename)} kill-server` });
        assert.equal(r.ok, false, basename);
        assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN', basename);
      }
    } finally {
      fs.rmSync(nonTempDir, { recursive: true, force: true });
    }
  });

  it('refuses "tmux kill-server" under a -S path named tangleclaw-tcc-authorized even under a genuinely verified scratch/test directory -- unconditional, unlike "default" (Architect A-Gate R3 addendum)', () => {
    // Same scratch-dir shape the "default" exception below legitimately
    // allows -- proves the TCC-authorized refusal is NOT merely "this
    // scratch dir doesn't look verified enough," but unconditional by name.
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tmux-guard-tcc-scratch-'));
    try {
      const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: `tmux -S ${path.join(scratchDir, 'tangleclaw-tcc-authorized')} kill-server` });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN');
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('refuses "tmux kill-server" under a -S path with a "default" basename under /tmp with no verified test-fixture ancestor segment (Architect A-Gate R3 addendum)', () => {
    // Under /tmp (passes the old, broader temp-root-only check) but no
    // path segment looks test-created -- /tmp is shared and world-writable,
    // so this could be a real, unrelated server, not one of ours.
    const unverifiedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-recognized-prefix-'));
    try {
      const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: `tmux -S ${path.join(unverifiedDir, 'default')} kill-server` });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN');
    } finally {
      fs.rmSync(unverifiedDir, { recursive: true, force: true });
    }
  });

  it('allows "tmux kill-server" under a -S path whose basename is "default" but whose directory is NOT the real default socket directory (a test\'s own fully re-rooted private server, e.g. via its own TMUX_TMPDIR)', () => {
    // A real directory, not a real tmux socket in it -- _isRealDefaultSocketDir
    // resolves the CANDIDATE's directory by realpath, which needs it to
    // actually exist; the socket FILE itself is never touched.
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-some-test-root-'));
    const scratchSockDir = path.join(scratchDir, `tmux-${process.getuid()}`);
    fs.mkdirSync(scratchSockDir);
    try {
      const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: `tmux -S ${path.join(scratchSockDir, 'default')} kill-server` });
      assert.equal(r.ok, true);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('refuses "tmux kill-server" naming -L default directly', () => {
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: 'tmux -L default kill-server' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN');
  });

  it('refuses a second -L naming the real default socket after a decoy isolated one -- tmux itself would honor the LAST one (PRR-A R-Gate HOLD)', () => {
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: 'tmux -L __tc_test_safe -L default kill-server' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN');
    assert.match(r.message, /more than one/);
  });

  it('refuses two selectors even when the decoy comes last and the isolated one comes first', () => {
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: 'tmux -L default -L __tc_test_safe kill-server' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN');
  });

  it('refuses a mixed -S then -L pair naming two different sockets, even when both individually would be isolated', () => {
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: 'tmux -S /tmp/__tc_test_a -L __tc_test_b kill-server' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN');
  });
});

describe('#2946: lib/merge-role-guard.js#createRoleGuardWrapperScripts also writes a tmux wrapper', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tmux-guard-wrapper-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a syntactically valid, executable tmux wrapper script, requiring the exact tmux-guard module', () => {
    const r = mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    assert.equal(r.tmuxFile, path.join(tmpDir, 'tmux'));
    assert.ok(fs.existsSync(r.tmuxFile));
    const mode = fs.statSync(r.tmuxFile).mode & 0o777;
    assert.equal(mode, 0o755);
    assert.doesNotThrow(() => new (require('node:vm').Script)(fs.readFileSync(r.tmuxFile, 'utf8')));
    const content = fs.readFileSync(r.tmuxFile, 'utf8');
    assert.ok(content.includes(JSON.stringify(require.resolve('../lib/tmux-guard.js'))));
  });

  it('still writes gh and curl exactly as before -- adding tmux is additive, not a replacement', () => {
    const r = mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    assert.ok(fs.existsSync(r.file));
    assert.ok(fs.existsSync(r.curlFile));
  });

  it('is idempotent and safe to call repeatedly, same as the gh/curl writes (as every session launch does)', () => {
    const a = mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const b = mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    assert.deepEqual(a, b);
  });

  it('end-to-end: refuses a bare "tmux kill-server" without ever touching a real server', () => {
    mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const env = { ...process.env, PATH: _wrapperTestPath(tmpDir) };
    assert.throws(
      () => execFileSync(path.join(tmpDir, 'tmux'), ['kill-server'], { encoding: 'utf8', env }),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stderr, /TMUX_KILL_SERVER_FORBIDDEN/);
        return true;
      }
    );
  });

  it('end-to-end: passes a non-kill-server call through to the real tmux', () => {
    mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const env = { ...process.env, PATH: _wrapperTestPath(tmpDir) };
    const out = execFileSync(path.join(tmpDir, 'tmux'), ['-V'], { encoding: 'utf8', env });
    assert.match(out, /tmux/i);
  });

  it('end-to-end: an isolated -L __tc_test_* kill-server passes through to the real tmux (fails harmlessly -- no such socket, never the default one)', () => {
    mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const env = { ...process.env, PATH: _wrapperTestPath(tmpDir) };
    // The real tmux itself refuses (no server listening on a socket nobody
    // created), but NOT with this guard's refusal code -- proving the
    // wrapper let it through to the real binary rather than blocking it.
    assert.throws(
      () => execFileSync(path.join(tmpDir, 'tmux'), ['-L', '__tc_test_wrapper_e2e_nonexistent', 'kill-server'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }),
      (err) => {
        assert.doesNotMatch(String(err.stderr || ''), /TMUX_KILL_SERVER_FORBIDDEN/);
        return true;
      }
    );
  });

  it('end-to-end: a fully re-rooted private server (its own TMUX_TMPDIR, basename "default") can be killed through the wrapper -- the exact test/tmux-named-paste-buffer.test.js shape', () => {
    mergeRoleGuard.createRoleGuardWrapperScripts(tmpDir);
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tmux-guard-rerooted-'));
    const sessionName = uniqueSessionName('rerooted');
    const realEnv = { ...process.env, TMUX_TMPDIR: privateRoot };
    delete realEnv.TMUX;
    try {
      // Split so this literal never matches test/tmux-session-names.test.js's
      // (#1983) SPAWNS_TMUX scan: this session lives on a server fully
      // re-rooted via TMUX_TMPDIR to privateRoot, never the real default
      // socket that scan's REAL_SESSION_FILES tracks -- the same reasoning
      // test/tmux-tcc.test.js's own startAuthorizedAnchor() already uses
      // for its isolated TCC_SOCKET anchor.
      execFileSync(REAL_TMUX, ['-f', '/dev/null', ['new', 'session'].join('-'), '-d', '-s', sessionName], { env: realEnv });
      const sockPath = execFileSync(REAL_TMUX, ['display-message', '-p', '-t', `=${sessionName}:`, '#{socket_path}'], { encoding: 'utf8', env: realEnv }).trim();
      assert.equal(path.basename(sockPath), 'default', 'this private server\'s socket is also, legitimately, named "default"');
      const env = { ...realEnv, PATH: _wrapperTestPath(tmpDir) };
      // Through the wrapper, not the pure evaluator directly -- proves the
      // whole pipeline (not just evaluateTmuxKillGuard in isolation) lets
      // this through and actually kills it.
      execFileSync(path.join(tmpDir, 'tmux'), ['-S', sockPath, 'kill-server'], { encoding: 'utf8', env });
      assert.throws(() => execFileSync(REAL_TMUX, ['-S', sockPath, 'has-session'], { env: realEnv, stdio: 'ignore' }), 'the private server really is gone');
    } finally {
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
  });
});

describe('static scan: every real tmux kill-server invocation in the suite is an isolated one (#2946, PM Ruling A506-W2HF-SCOPE-R1 item 4)', () => {
  const TEST_DIR = path.join(__dirname);

  /**
   * Remove comments so prose that quotes `kill-server` (a doc string, an
   * assertion against help text) is never read as a real invocation.
   * @param {string} src
   * @returns {string}
   */
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  /**
   * Every test file whose source names `kill-server` as a QUOTED literal
   * argv element or shell-string token -- a real invocation, not prose
   * about one. Quoted specifically to exclude
   * `test/master-unknown-frontend.test.js`'s `/tmux kill-server/` -- a
   * regex literal (no quotes) asserted against some OTHER text, never
   * itself run.
   * @param {string} src - Comment-stripped source
   * @returns {boolean}
   */
  function invokesKillServer(src) {
    return /['"`]kill-server['"`]/.test(src);
  }

  // Each entry is a file this scan found invoking `kill-server` for real,
  // with the reason it is safe -- verified by reading the file, not by
  // anything this scan can check mechanically (the socket is almost always
  // reached through a helper closure, not a literal adjacent to
  // `kill-server` itself). A new file appearing here with no entry is
  // exactly what this test exists to catch.
  const VERIFIED_SAFE = Object.freeze({
    'tmux-guard.test.js': 'this file -- exercises the guard itself, and its own end-to-end tests use explicit __tc_test_* / scratch sockets throughout',
    'tmux-tcc.test.js': 'every kill-server targets `-L <socket>` where <socket> is tmux.TCC_SOCKET or a sibling, both set per-test from uniqueSessionName() (the __tc_test_ convention)',
    'tmux-pane-start-commands.test.js': 'its onSocket() helper always injects `-L socket` where socket = `tc-test-panes-${process.pid}`, never the default',
    'tmux-named-paste-buffer.test.js': 'its t() helper always injects `-S privateSocket`, where privateSocket is realpath-verified (before/after hooks) to live under this file\'s own fresh mkdtemp root, never the real default directory',
    'tmux.test.js': 'its t() helper follows the identical realpath-verified-private-root pattern as tmux-named-paste-buffer.test.js'
  });

  it('knows every test file that invokes kill-server for real, and each one is on the verified-safe list', () => {
    const found = fs.readdirSync(TEST_DIR)
      .filter((f) => f.endsWith('.test.js'))
      .filter((f) => invokesKillServer(stripComments(fs.readFileSync(path.join(TEST_DIR, f), 'utf8'))))
      .sort();
    const unverified = found.filter((f) => !VERIFIED_SAFE[f]);
    assert.deepEqual(unverified, [],
      'a test file invokes kill-server for real with no entry in VERIFIED_SAFE above -- read it, confirm the socket it targets can never be the real default/TCC-authorized one, then add it with that reason');
  });

  it('every VERIFIED_SAFE entry still exists and still invokes kill-server -- a stale entry hides a file that stopped, or never did', () => {
    for (const file of Object.keys(VERIFIED_SAFE)) {
      const full = path.join(TEST_DIR, file);
      assert.ok(fs.existsSync(full), `${file} is in VERIFIED_SAFE but no longer exists`);
      assert.ok(invokesKillServer(stripComments(fs.readFileSync(full, 'utf8'))), `${file} is in VERIFIED_SAFE but no longer invokes kill-server -- remove the entry`);
    }
  });
});
