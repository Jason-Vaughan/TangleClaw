'use strict';

// #2625: TCC-authorized tmux server bootstrap. macOS TCC's symptom under a
// launchd-spawned, no-Full-Disk-Access process is that a protected read
// never answers (`lib/tcc-folders.js`) — this sandbox cannot reproduce a real
// TCC hang, so every "the default server cannot read this" case is driven by
// a REAL, stalling `tmux` on PATH, the same technique `test/tmux.test.js`'s
// `#894` case uses. The shim passes every OTHER call through to the real
// binary, so the rest of the bootstrap (the real session on the TCC-authorized server, the
// attach proxy on the default server) runs against real tmux.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const tmux = require('../lib/tmux');
const { uniqueSessionName } = require('./_tmux-session-names');

const REAL_TMUX = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();

/** Session names + fake-home dirs this file's tests created, cleaned up in `afterEach`. */
let createdDefault = [];
let createdFakeHome = null;

afterEach(() => {
  for (const name of createdDefault) {
    try { tmux.killSession(name); } catch { /* already gone */ }
  }
  createdDefault = [];
  if (createdFakeHome) {
    fs.rmSync(createdFakeHome, { recursive: true, force: true });
    createdFakeHome = null;
  }
  delete tmux._tccSeams.homedir;
  tmux._tccSeams.homedir = () => os.homedir();
});

/**
 * Run `fn` with a `tmux` shim prepended to PATH that sleeps past any
 * timeout when its arguments match `pattern`, and otherwise execs the real
 * binary — so everything the bootstrap does beyond the probe itself still
 * runs for real.
 * @param {RegExp} pattern - Matched against the shim's own `$*`
 * @param {() => void} fn
 * @returns {void}
 */
function withSelectivelySlowTmux(pattern, fn) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-shim-'));
  fs.writeFileSync(path.join(binDir, 'tmux'), [
    '#!/bin/sh',
    `case "$*" in`,
    `  ${pattern}) exec sleep 30 ;;`,
    `  *) exec ${REAL_TMUX} "$@" ;;`,
    'esac'
  ].join('\n'), { mode: 0o755 });
  const realPath = process.env.PATH;
  process.env.PATH = `${binDir}:${realPath}`;
  try {
    fn();
  } finally {
    process.env.PATH = realPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

/**
 * Point `tmux._tccSeams.homedir` at a scratch directory and create `rel`
 * (e.g. `Documents/proj`) inside it, real on disk — never inside the actual
 * operator home.
 * @param {string} rel - Relative path under the fake home
 * @returns {string} The absolute path created
 */
function fakeProtectedCwd(rel) {
  createdFakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-fakehome-'));
  tmux._tccSeams.homedir = () => createdFakeHome;
  const full = path.join(createdFakeHome, rel);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

describe('probeTccReadable (#2625)', () => {
  it('reports a normal, real directory as readable', () => {
    assert.equal(tmux.probeTccReadable(os.tmpdir()), true);
  });

  it('reports NOT readable when the server never answers (a real stalling tmux)', () => {
    withSelectivelySlowTmux('*"new-session -d -s tc-tcc-probe-"*', () => {
      assert.equal(tmux.probeTccReadable(os.tmpdir(), { timeoutMs: 300 }), false);
    });
  });

  it('reports readable on a failure that is not a timeout (e.g. no such directory)', () => {
    assert.equal(tmux.probeTccReadable(path.join(os.tmpdir(), 'tc-tcc-no-such-dir-xyz')), true);
  });
});

describe('createSessionWithTccBootstrap (#2625)', () => {
  it('delegates straight to createSession for an unprotected cwd: no tc-tcc server involved', () => {
    const name = uniqueSessionName('tcc_unprotected');
    createdDefault.push(name);
    const created = tmux.createSessionWithTccBootstrap(name, { cwd: os.tmpdir() });
    assert.equal(created, true);
    assert.equal(tmux.hasSession(name), true);
    assert.throws(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
  });

  it('delegates straight to createSession for a protected cwd the default server CAN read', () => {
    const cwd = fakeProtectedCwd('Documents/readable-proj');
    const name = uniqueSessionName('tcc_protected_readable');
    createdDefault.push(name);
    const created = tmux.createSessionWithTccBootstrap(name, { cwd });
    assert.equal(created, true);
    assert.equal(tmux.hasSession(name), true);
    assert.throws(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
  });

  it('bootstraps onto the TCC-authorized server when the cwd is protected AND the default server cannot read it, with an attach proxy on the default server', () => {
    const cwd = fakeProtectedCwd('Documents/blocked-proj');
    const name = uniqueSessionName('tcc_protected_blocked');
    createdDefault.push(name);
    withSelectivelySlowTmux('*"new-session -d -s tc-tcc-probe-"*', () => {
      const created = tmux.createSessionWithTccBootstrap(name, { cwd });
      assert.equal(created, true);
    });
    // The real session lives on the TCC-authorized server...
    assert.doesNotThrow(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
    // ...and the default server has a same-named proxy, attach-only, with its
    // own status line off.
    assert.equal(tmux.hasSession(name), true);
    const proxyCommand = execFileSync('tmux', ['list-panes', '-t', name, '-F', '#{pane_start_command}'], { encoding: 'utf8' }).trim();
    assert.match(proxyCommand, new RegExp(`tmux -L '?${tmux.TCC_SOCKET}'? -u attach -t`));
    const statusOption = execFileSync('tmux', ['show-option', '-t', name, 'status'], { encoding: 'utf8' }).trim();
    assert.equal(statusOption, 'status off');
    // Cleanup: the proxy (afterEach) and the real session on the TCC-authorized server, whose
    // server then exits on its own (tmux's default: no sessions, no server).
    execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'kill-session', '-t', name], { stdio: 'ignore' });
  });

  it('a second call against an already-bootstrapped name is a no-op, like createSession', () => {
    const cwd = fakeProtectedCwd('Documents/blocked-proj-2');
    const name = uniqueSessionName('tcc_protected_blocked_repeat');
    createdDefault.push(name);
    withSelectivelySlowTmux('*"new-session -d -s tc-tcc-probe-"*', () => {
      assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), true);
      assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), false, 'the proxy already exists on the default server');
    });
    execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'kill-session', '-t', name], { stdio: 'ignore' });
  });
});
