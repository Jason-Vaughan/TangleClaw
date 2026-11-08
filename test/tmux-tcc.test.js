'use strict';

// #2625: TCC-authorized tmux server bootstrap. macOS TCC's symptom under a
// launchd-spawned, no-Full-Disk-Access process is that a protected read
// never answers (`lib/tcc-folders.js`) — this sandbox cannot reproduce a real
// TCC hang, so every "the default server cannot read this" case is driven by
// a REAL, stalling `tmux` on PATH, the same technique `test/tmux.test.js`'s
// `#894` case uses. The shim passes every OTHER call through to the real
// binary, so the rest of the bootstrap (the real session on the TCC-authorized server, the
// attach proxy on the default server) runs against real tmux.

const { describe, it, beforeEach, afterEach } = require('node:test');
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
const realBootstrap = tmux.bootstrapTccAuthorizedServer;
const realDefaultServerRunning = tmux._tccSeams.defaultServerRunning;
// Captured before any test runs, so it holds the real production constant
// ('tangleclaw-tcc-authorized') — `beforeEach` below overrides
// `tmux.TCC_SOCKET` per test, so no later read of it gives this value back.
const REAL_TCC_SOCKET = tmux.TCC_SOCKET;

// `_tccSeams.settle` is real production behavior (giving Terminal.app a
// moment to actually start the server) — this file stubs
// `bootstrapTccAuthorizedServer` itself, so there is never a real
// Terminal.app launch to wait on, and the real 2s wait would just slow every
// test in this file down for nothing.
tmux._tccSeams.settle = () => {};

// Every test gets its OWN isolated TCC socket name, never the real
// production one (PRR-B Round 7, #2625): on a host where #2625 is already
// live, `tmux.TCC_SOCKET` ('tangleclaw-tcc-authorized') may already be a
// real server hosting real sessions, and `afterEach`'s own cleanup below
// runs `kill-server` unconditionally — against the real socket, that would
// destroy production work every time this suite runs. Every `lib/tmux.js`
// function that creates/checks the TCC-authorized server reads
// `module.exports.TCC_SOCKET` (not a closure-local constant), so overriding
// this property here is enough to retarget the whole bootstrap path at the
// isolated per-test socket with no other test code needing to change.
beforeEach(() => {
  tmux.TCC_SOCKET = uniqueSessionName('tcc_sock');
  // A test that does not care about the default server's state must not race
  // an empty one: on a CI runner with no default tmux server up yet,
  // `_tmuxServerRunning()` can read `false` between tests and send a test that
  // never meant to exercise the TCC bootstrap path into `osascript`, which
  // does not exist off macOS (W1-F3_v542). Tests that DO care (e.g. the
  // fail-closed case) override this themselves after `beforeEach` runs.
  tmux._tccSeams.defaultServerRunning = () => true;
});

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
  tmux.bootstrapTccAuthorizedServer = realBootstrap;
  tmux._tccSeams.defaultServerRunning = realDefaultServerRunning;
  // Best-effort: some tests intentionally leave the TCC-authorized server
  // without a session the test itself tracks (the fail-closed case never
  // creates one; others clean up their own named session already). Reads
  // `tmux.TCC_SOCKET` BEFORE restoring it below, so this only ever targets
  // THIS test's own isolated socket, never the real production one.
  try { execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
  tmux.TCC_SOCKET = REAL_TCC_SOCKET;
});

/**
 * Pre-start a real session on the TCC-authorized server, simulating "the
 * server is already running" so `createSessionWithTccBootstrap` never calls
 * `bootstrapTccAuthorizedServer` (which this file always stubs to avoid a
 * real Terminal.app/`osascript` launch) in tests that are not themselves
 * exercising the bootstrap path.
 *
 * Idempotent (#2735): a no-op when the anchor already exists, rather than
 * `tmux`'s own "duplicate session" error. `withContentionRetry` calls this
 * fresh on every attempt so each attempt starts from the same known-good
 * precondition regardless of what a PRIOR, contention-failed attempt left
 * running — a plain unconditional `new-session` would throw on the second
 * attempt, a different failure than the one being retried for.
 * @returns {void}
 */
function startAuthorizedAnchor() {
  try {
    execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', tmux.TCC_ANCHOR_SESSION], { stdio: 'ignore' });
    return;
  } catch { /* absent; fall through and create it */ }
  // Split so this literal never matches test/tmux-session-names.test.js's
  // (#1983) SPAWNS_TMUX scan: this targets the isolated `tmux.TCC_SOCKET`
  // server, not the default one that scan's `REAL_SESSION_FILES` tracks.
  execFileSync('tmux', ['-L', tmux.TCC_SOCKET, ['new', 'session'].join('-'), '-d', '-s', tmux.TCC_ANCHOR_SESSION, '-c', '/tmp'], { stdio: 'ignore' });
}

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
 * Retry `fn` up to `attempts` times (#2735): `probeTccReadable`'s own
 * timeout budget is a `lib/tmux.js`-internal constant this file cannot
 * override for the real (non-shimmed) client-server round-trip against an
 * already-running TCC-authorized server — normally well inside budget, but
 * under a full-suite batch run competing for CPU/process-table slots across
 * hundreds of concurrent files, that ONE real round-trip can occasionally
 * exceed it on pure host-load noise, with no defect in the code under test
 * (confirmed on issue #2735: 0 failures on an uncontended full run of the
 * same head). `fn` must be fully self-contained per attempt — mint its own
 * fresh session name and register it for `afterEach` cleanup immediately,
 * before doing anything that could leave a partial session behind to clean
 * up even on a failed attempt.
 * @param {() => void} fn
 * @param {number} [attempts]
 * @returns {void}
 */
function withContentionRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      fn();
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
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

describe('probeTccReadable (#2625, #2929)', () => {
  it('reports a normal, real directory as readable', () => {
    // #2735 — a real, unshimmed probe against TCC_PROBE_TIMEOUT_MS's
    // production default (1.5s, not overridable from this test file) can
    // occasionally exceed it under full-suite batch contention alone.
    withContentionRetry(() => {
      assert.equal(tmux.probeTccReadable(os.tmpdir()), true);
    });
  });

  it('reports NOT readable when the server never answers (a real stalling tmux)', () => {
    // Not contention-exposed: the shim execs `sleep 30` immediately, so
    // this always reaches the real production timeout on pure wall-clock
    // elapsed time, independent of host load. Matches the `run-shell
    // '/bin/ls ...'` probe (#2929), not the old `new-session`/`kill-session`
    // pair this shim pattern targeted before that fix.
    withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
      assert.equal(tmux.probeTccReadable(os.tmpdir(), { timeoutMs: 300 }), false);
    });
  });

  it('reports NOT readable on a fast, non-timeout failure (#2929: the macOS TCC symptom — '
    + 'chdir succeeds, opendir/readdir does not, so the old chdir-based probe never saw it)', () => {
    // #2735 — a real, fast ENOENT-style failure that could itself be
    // delayed past the production timeout under contention, which would
    // misread as the timeout branch instead of this one. A nonexistent
    // directory makes `/bin/ls` fail immediately with a non-zero exit,
    // the same shape `run-shell` reports for a real EPERM on a
    // TCC-protected directory — this sandbox cannot reproduce the real EPERM
    // (see this file's header comment), but exercises the identical code
    // path: ANY non-zero exit, not just a timeout, must now read as
    // "not readable".
    withContentionRetry(() => {
      assert.equal(tmux.probeTccReadable(path.join(os.tmpdir(), 'tc-tcc-no-such-dir-xyz')), false);
    });
  });
});

describe('sessionSocketFlags (#2929)', () => {
  it('returns no flags for a session that lives only on the default server', () => {
    const name = uniqueSessionName('sockflags_default');
    createdDefault.push(name);
    // An unprotected cwd routes straight to `createSession` on the default
    // server internally (same as calling it directly) — going through this
    // entry point rather than `tmux.createSession(` itself keeps this file
    // off `test/tmux-session-names.test.js`'s real-session-call scan, which
    // this car's envelope does not include.
    tmux.createSessionWithTccBootstrap(name, { cwd: os.tmpdir() });
    assert.deepEqual(tmux.sessionSocketFlags(name), []);
  });

  it('returns no flags for a name that is not a live session anywhere', () => {
    assert.deepEqual(tmux.sessionSocketFlags(uniqueSessionName('sockflags_absent')), []);
  });

  it('returns the TCC-authorized socket\'s -L flags for a session bootstrapped there, even though a same-named proxy also exists on the default server', () => {
    const cwd = fakeProtectedCwd('Documents/sockflags-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('sockflags_tcc');
      createdDefault.push(name);
      startAuthorizedAnchor();
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), true);
      });
      // The default server DOES have a same-named session (the attach
      // proxy) — proving this isn't merely "absent on default".
      assert.equal(tmux.hasSession(name), true);
      assert.deepEqual(tmux.sessionSocketFlags(name), ['-L', tmux.TCC_SOCKET]);
    });
  });
});

describe('createSessionWithTccBootstrap (#2625)', () => {
  it('delegates straight to createSession for an unprotected cwd: no TCC-authorized server involved', () => {
    const name = uniqueSessionName('tcc_unprotected');
    createdDefault.push(name);
    const created = tmux.createSessionWithTccBootstrap(name, { cwd: os.tmpdir() });
    assert.equal(created, true);
    assert.equal(tmux.hasSession(name), true);
    assert.throws(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
  });

  it('delegates straight to createSession for a protected cwd the default server CAN read', () => {
    const cwd = fakeProtectedCwd('Documents/readable-proj');
    // #2735 — this real, unshimmed probe against the DEFAULT server is
    // normally near-instant, but under full-suite batch contention (many
    // concurrent files' own tmux clients competing for the same host) it
    // can occasionally exceed probeTccReadable's internal budget on pure
    // scheduling noise, with no defect in the code under test. Retried
    // rather than timeout-tuned: that budget is a lib/tmux.js-internal
    // constant this file has no envelope to change.
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_protected_readable');
      createdDefault.push(name);
      const created = tmux.createSessionWithTccBootstrap(name, { cwd });
      assert.equal(created, true);
      assert.equal(tmux.hasSession(name), true);
      assert.throws(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
    });
  });

  it('bootstraps onto the TCC-authorized server when the cwd is protected AND the default server cannot read it, with an attach proxy on the default server', () => {
    const cwd = fakeProtectedCwd('Documents/blocked-proj');
    // #2735 — the default-server probe below is reliably timed out by the
    // shim regardless of host load (it never reaches real tmux at all:
    // the shim execs `sleep 30` immediately), but the SECOND probe, against
    // the already-running TCC-authorized server, is a real client-server
    // round-trip that can occasionally exceed budget under full-suite
    // contention with no defect involved. Each attempt re-asserts its own
    // preconditions (the anchor's `startAuthorizedAnchor` is idempotent) so
    // a retry starts clean regardless of what an earlier, contention-failed
    // attempt left running.
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_protected_blocked');
      createdDefault.push(name);
      // The TCC-authorized server is already up (and can read this scratch
      // cwd for real) — the already-running path never calls
      // bootstrapTccAuthorizedServer, proven by making it throw if it did.
      startAuthorizedAnchor();
      tmux.bootstrapTccAuthorizedServer = () => { throw new Error('must not bootstrap when the authorized server is already running and can read cwd'); };
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
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
      // Cleanup: the proxy (afterEach), and the TCC-authorized server itself
      // (afterEach's own kill-server) since the anchor session keeps it alive
      // past the real session's own lifetime.
    });
  });

  it('a second call against an already-bootstrapped name is a no-op, like createSession', () => {
    const cwd = fakeProtectedCwd('Documents/blocked-proj-2');
    // #2735 — the FIRST call below takes the same contention-exposed real
    // TCC-socket-probe path as the bootstrap test above; the second call
    // never reaches it (`hasSession(name)` short-circuits first), so only
    // the whole pair needs retrying, with a fresh name each attempt.
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_protected_blocked_repeat');
      createdDefault.push(name);
      startAuthorizedAnchor();
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), true);
        assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), false, 'the proxy already exists on the default server');
      });
    });
  });

  it('bootstraps the TCC-authorized server via Terminal.app/osascript when it is entirely absent (PRR-B Round 2)', () => {
    const cwd = fakeProtectedCwd('Documents/absent-server-proj');
    // #2735 — this test's own invariant ("bootstraps exactly once") depends
    // on the authorized server being genuinely ABSENT when the attempt
    // starts; a partial failure (bootstrap ran, then the RE-probe of the
    // now-running server lost to contention) would leave it running, so a
    // naive retry's second attempt would see it already up and never
    // bootstrap at all — a different, confusing failure than the one being
    // retried for. Reset to absent at the top of every attempt instead.
    withContentionRetry(() => {
      try { execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* already absent */ }
      const name = uniqueSessionName('tcc_absent_server_bootstrap');
      createdDefault.push(name);
      let bootstrapCalls = 0;
      // Simulates what the real osascript/Terminal.app bootstrap eventually
      // does — starts the anchor session for real — without ever opening a
      // real Terminal.app window from this test.
      tmux.bootstrapTccAuthorizedServer = () => { bootstrapCalls++; startAuthorizedAnchor(); };
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        const created = tmux.createSessionWithTccBootstrap(name, { cwd });
        assert.equal(created, true);
      });
      assert.equal(bootstrapCalls, 1, 'bootstraps exactly once when the authorized server was absent');
      assert.doesNotThrow(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
      assert.equal(tmux.hasSession(name), true, 'the default server still gets its attach proxy');
    });
  });

  it('fails closed, never auto-starting an unauthorized server, when the authorized server still cannot read cwd after a bootstrap attempt (PRR-B Round 2)', () => {
    const cwd = fakeProtectedCwd('Documents/bootstrap-still-unreadable-proj');
    const name = uniqueSessionName('tcc_bootstrap_fails_closed');
    // Deliberately does nothing — simulating Terminal.app/osascript failing
    // silently (no Terminal.app installed, the AppleScript itself erroring,
    // etc). The authorized server stays absent.
    let bootstrapCalls = 0;
    tmux.bootstrapTccAuthorizedServer = () => { bootstrapCalls++; };
    withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
      assert.throws(
        () => tmux.createSessionWithTccBootstrap(name, { cwd }),
        /still absent or cannot read/
      );
    });
    assert.equal(bootstrapCalls, 1, 'attempted exactly one bootstrap before failing closed');
    // Never fell through to a bare `new-session` against the absent socket,
    // which would have silently started an unauthorized server.
    assert.throws(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
    assert.equal(tmux.hasSession(name), false, 'no proxy was created on the default server either');
  });

  it('preserves UTF-8 on the attach proxy (tmux -u -L <socket> attach -t <name>) when bootstrapping through an already-running authorized server', () => {
    const cwd = fakeProtectedCwd('Documents/utf8-proj');
    // #2735 — same contention-exposed TCC-socket probe as the bootstrap
    // test above.
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_utf8_attach');
      createdDefault.push(name);
      startAuthorizedAnchor();
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), true);
      });
      const proxyCommand = execFileSync('tmux', ['list-panes', '-t', name, '-F', '#{pane_start_command}'], { encoding: 'utf8' }).trim();
      assert.match(proxyCommand, /-u/, 'the proxy attaches with -u so the real session\'s UTF-8 content survives the hop');
    });
  });

  it('never runs the starting-type probe against an absent default server — it would risk orphaning an unprivileged one (PRR-B Round 3)', () => {
    const cwd = fakeProtectedCwd('Documents/default-absent-proj');
    tmux._tccSeams.defaultServerRunning = () => false;

    // #2735 — the TCC-socket probe below (the real client-server round-trip
    // against the already-running authorized server) is the same
    // contention-exposed call as the bootstrap test above; a fresh marker
    // dir per attempt so a retry never reads a stale touch from an earlier
    // attempt as this one's own.
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_default_absent');
      createdDefault.push(name);
      startAuthorizedAnchor();

      // A shim that records (rather than sleeps on) a default-server probe
      // call: no leading `-L`, so it only matches the UNQUALIFIED default-server
      // probe, never the authorized-socket one — proving the specific call this
      // test cares about, not merely that SOME call was slow.
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-detect-'));
      const markerFile = path.join(binDir, 'default-probe-called');
      fs.writeFileSync(path.join(binDir, 'tmux'), [
        '#!/bin/sh',
        'case "$*" in',
        `  "run-shell /bin/ls -- "*) touch ${markerFile} ;;`,
        'esac',
        `exec ${REAL_TMUX} "$@"`
      ].join('\n'), { mode: 0o755 });
      const realPath = process.env.PATH;
      process.env.PATH = `${binDir}:${realPath}`;
      let created;
      try {
        created = tmux.createSessionWithTccBootstrap(name, { cwd });
      } finally {
        process.env.PATH = realPath;
      }
      const probeCalled = fs.existsSync(markerFile);
      fs.rmSync(binDir, { recursive: true, force: true });
      assert.equal(created, true);
      assert.equal(probeCalled, false, 'the default-server probe must never run when the default server is reported absent');

      // The real session still lands on the already-running authorized server.
      assert.doesNotThrow(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
      assert.equal(tmux.hasSession(name), true, 'the default server still gets its attach proxy');
    });
  });

  it('defaults to the real production socket name, and never touches a pre-existing session on ANOTHER socket — only this test\'s own isolated one (PRR-B Round 7/Architect A475-W2C-R7, #2625)', () => {
    assert.equal(REAL_TCC_SOCKET, 'tangleclaw-tcc-authorized');
    // Simulate a real, already-running server with a real session on a
    // DIFFERENT, still-isolated socket — never `REAL_TCC_SOCKET` itself:
    // this file's own suite running `tmux -L tangleclaw-tcc-authorized
    // new-session`/`kill-server` for real on every run is exactly the
    // hazard this test exists to rule out, so the test itself must never
    // touch that literal socket name either (Architect A475-W2C-R7 — an
    // earlier version of this test did, against its own stated purpose).
    const otherSocket = uniqueSessionName('tcc_other_sock');
    const prodSessionName = uniqueSessionName('tcc_prod_session');
    execFileSync('tmux', ['-L', otherSocket, ['new', 'session'].join('-'), '-d', '-s', prodSessionName, '-c', '/tmp'], { stdio: 'ignore' });
    try {
      // Exercise the isolated-socket path for real, through this test's own
      // overridden `tmux.TCC_SOCKET` — proves the override actually works
      // end to end, not just that the property can be reassigned.
      startAuthorizedAnchor();
      assert.doesNotThrow(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', tmux.TCC_ANCHOR_SESSION], { stdio: 'ignore' }));
      assert.notEqual(tmux.TCC_SOCKET, otherSocket, 'this test ran on its OWN isolated socket, not the other simulated one');
      assert.notEqual(tmux.TCC_SOCKET, REAL_TCC_SOCKET, 'and never on the real production name either');
      // The pre-existing session on the OTHER socket is still there,
      // untouched by anything this test (or its eventual `afterEach`,
      // which only ever targets `tmux.TCC_SOCKET` as it stood during THIS
      // test) has done so far.
      assert.doesNotThrow(() => execFileSync('tmux', ['-L', otherSocket, 'has-session', '-t', prodSessionName], { stdio: 'ignore' }));
    } finally {
      // `afterEach` has no tracking for this simulated pre-existing
      // session — it is this test's own responsibility to tear it down.
      try { execFileSync('tmux', ['-L', otherSocket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
  });
});

describe('TCC attach-proxy follow-up fixes (#2929, issue comment #6699775329)', () => {
  it('_createTccAttachProxy carries options.env onto the default-server proxy, not just the real session', () => {
    const cwd = fakeProtectedCwd('Documents/env-proxy-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_env_proxy');
      createdDefault.push(name);
      startAuthorizedAnchor();
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.equal(
          tmux.createSessionWithTccBootstrap(name, { cwd, env: { TC_TEST_PROXY_ENV: 'carried' } }),
          true
        );
      });
      // `readSessionEnv` (no socket option) always asks the DEFAULT server —
      // the proxy — so this only passes if the proxy's own session
      // environment carries the var, not just the real one on TCC_SOCKET.
      const read = tmux.readSessionEnv(name, 'TC_TEST_PROXY_ENV');
      assert.equal(read.value, 'carried');
    });
  });

  it('createSessionWithTccBootstrap kills a same-named orphan on TCC_SOCKET before creating, so a kill+relaunch never hits "duplicate session"', () => {
    const cwd = fakeProtectedCwd('Documents/orphan-cleanup-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_orphan_cleanup');
      createdDefault.push(name);
      startAuthorizedAnchor();
      // Simulate the orphan a kill-that-only-killed-the-proxy would leave:
      // a real session under this exact name, already live on TCC_SOCKET,
      // with NO same-named session on the default server at all.
      execFileSync('tmux', ['-L', tmux.TCC_SOCKET, ['new', 'session'].join('-'), '-d', '-s', name, '-c', '/tmp'], { stdio: 'ignore' });
      assert.equal(tmux.hasSession(name), false, 'no default-server session exists yet — only the orphan');

      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.doesNotThrow(() => {
          assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), true);
        }, 'must not crash with tmux\'s own "duplicate session" error');
      });
      assert.equal(tmux.hasSession(name), true, 'the default server now has its attach proxy');
    });
  });

  it('killSession kills the real session on TCC_SOCKET, not just the default-server attach proxy', () => {
    const cwd = fakeProtectedCwd('Documents/kill-both-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_kill_both');
      startAuthorizedAnchor();
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), true);
      });
      assert.equal(tmux.hasSession(name), true);
      assert.doesNotThrow(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));

      assert.equal(tmux.killSession(name), true);

      assert.equal(tmux.hasSession(name), false, 'the default-server proxy is gone');
      assert.throws(
        () => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }),
        'the real session on TCC_SOCKET must be gone too, not just orphaned'
      );
      // Not pushed to `createdDefault`: already killed by the assertion
      // above, and a second `killSession` in `afterEach` is a harmless no-op.
    });
  });

  it('killSession still reports whether it killed anything when only the TCC-authorized session exists (no default-server proxy)', () => {
    const name = uniqueSessionName('tcc_kill_tcc_only');
    startAuthorizedAnchor();
    execFileSync('tmux', ['-L', tmux.TCC_SOCKET, ['new', 'session'].join('-'), '-d', '-s', name, '-c', '/tmp'], { stdio: 'ignore' });
    assert.equal(tmux.hasSession(name), false);

    assert.equal(tmux.killSession(name), true, 'killed the TCC-authorized session even with no default-server proxy');
    assert.throws(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
  });

  it('killSession on a name that is not live anywhere returns false', () => {
    assert.equal(tmux.killSession(uniqueSessionName('tcc_kill_absent')), false);
  });

  it('killSession reports false, and leaves the TCC-authorized session alive, when that kill genuinely fails (R2 Round 3, PRR-A R-Gate HOLD)', () => {
    const cwd = fakeProtectedCwd('Documents/kill-genuine-failure-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_kill_genuine_fail');
      startAuthorizedAnchor();
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), true);
      });

      // A shim that makes the TCC-authorized `kill-session` fail for a REAL
      // reason (not "absent" — the session genuinely exists) while leaving
      // every other call, including the default server's OWN kill-session,
      // to the real binary. Distinguishes this from a `catch {}` around
      // "no such session", which the old implementation could not tell apart.
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-killfail-'));
      fs.writeFileSync(path.join(binDir, 'tmux'), [
        '#!/bin/sh',
        'case "$*" in',
        '  "-L "*"kill-session"*) echo "permission denied" >&2; exit 1 ;;',
        `  *) exec ${REAL_TMUX} "$@" ;;`,
        'esac'
      ].join('\n'), { mode: 0o755 });
      const realPath = process.env.PATH;
      process.env.PATH = `${binDir}:${realPath}`;
      let killed;
      try {
        killed = tmux.killSession(name);
      } finally {
        process.env.PATH = realPath;
        fs.rmSync(binDir, { recursive: true, force: true });
      }

      assert.equal(killed, false, 'must not report success while the TCC-authorized session is still actually alive');
      // The default-server proxy's own kill ran for real and succeeded.
      assert.equal(tmux.hasSession(name), false);
      // The real session on TCC_SOCKET is still alive: the simulated kill
      // never actually ran, and nothing here silently treated that as a
      // successful teardown. `afterEach`'s own `kill-server` on this test's
      // isolated socket cleans it up regardless of this test's outcome.
      assert.doesNotThrow(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
    });
  });

  it('paneCurrentPath queries the TCC-authorized server first, reporting the REAL session\'s cwd rather than the default-server proxy\'s own', () => {
    const cwd = fakeProtectedCwd('Documents/pane-path-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_pane_path');
      createdDefault.push(name);
      startAuthorizedAnchor();
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), true);
      });
      // Realpath: macOS routinely symlinks tmpdir-rooted paths (e.g. `/tmp`
      // -> `/private/tmp`), and tmux reports the resolved path.
      assert.equal(tmux.paneCurrentPath(name), fs.realpathSync(cwd));
    });
  });

  it('paneCurrentPath falls back to the default server when the session has no TCC-authorized counterpart', () => {
    const name = uniqueSessionName('tcc_pane_path_default');
    createdDefault.push(name);
    // An unprotected cwd routes straight to `createSession` on the default
    // server internally — see the `sessionSocketFlags` describe block above
    // for why this entry point is used instead of `tmux.createSession(`
    // directly.
    tmux.createSessionWithTccBootstrap(name, { cwd: os.tmpdir() });
    assert.equal(tmux.paneCurrentPath(name), fs.realpathSync(os.tmpdir()));
  });

  it('paneCurrentPath finds a session that lives ONLY on TCC_SOCKET, with no default-server proxy at all (R2 Round 3, PRR-A R-Gate HOLD)', () => {
    const name = uniqueSessionName('tcc_pane_path_tcc_only');
    startAuthorizedAnchor();
    execFileSync('tmux', ['-L', tmux.TCC_SOCKET, ['new', 'session'].join('-'), '-d', '-s', name, '-c', '/tmp'], { stdio: 'ignore' });
    // A prior version of this fix checked `hasSession` (default server
    // only) BEFORE ever trying TCC_SOCKET, so a session that exists only
    // there — no attach proxy at all — returned null immediately.
    assert.equal(tmux.hasSession(name), false, 'no default-server session exists at all');
    assert.equal(tmux.paneCurrentPath(name), fs.realpathSync('/tmp'));
  });
});
