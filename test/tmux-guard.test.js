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
    assert.equal(tmuxGuard.ISOLATED_SOCKET_RE.test('__tc_test_foo'), true);
    assert.equal(tmuxGuard.ISOLATED_SOCKET_RE.test('tangleclaw-tcc-authorized'), false);
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

  it('refuses "tmux kill-server" against a named socket that is neither isolated nor TCC-authorized', () => {
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: 'tmux -L some-other-real-socket kill-server' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN');
    assert.match(r.message, /some-other-real-socket/);
  });

  it('allows "tmux kill-server" against an isolated -L __tc_test_* socket', () => {
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: 'tmux -L __tc_test_tcc_sock_123_abcdef_1__ kill-server' });
    assert.equal(r.ok, true);
    assert.equal(r.result.allowed, true);
  });

  it('allows "tmux kill-server" against a -S path under a real temp directory', () => {
    const scratchSocket = path.join(os.tmpdir(), 'tc-tmux-guard-scratch', 'sock');
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: `tmux -S ${scratchSocket} kill-server` });
    assert.equal(r.ok, true);
  });

  it('allows "tmux kill-server" against a -S path whose basename follows the __tc_test_ convention, even outside tmpdir', () => {
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: 'tmux -S /some/dir/__tc_test_scratch_sock kill-server' });
    assert.equal(r.ok, true);
  });

  it('refuses "tmux kill-server" against a -S path that is neither a scratch dir nor __tc_test_-named', () => {
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: 'tmux -S /Users/someone/.tmux-prod-socket kill-server' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TMUX_KILL_SERVER_FORBIDDEN');
  });

  it('strips quotes around a quoted -L target before comparing it', () => {
    const r = tmuxGuard.evaluateTmuxKillGuard({ commandText: "tmux -L '__tc_test_quoted' kill-server" });
    assert.equal(r.ok, true);
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
});
