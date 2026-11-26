'use strict';

// #2625: TCC-authorized tmux server bootstrap. macOS TCC's symptom under a
// launchd-spawned, no-Full-Disk-Access process is that a protected read
// never answers (`lib/tcc-folders.js`) — this sandbox cannot reproduce a real
// TCC hang, so every "the default server cannot read this" case is driven by
// a REAL, stalling `tmux` on PATH, the same technique `test/tmux.test.js`'s
// `#894` case uses. The shim passes every OTHER call through to the real
// binary, so the rest of the bootstrap (the real session on the TCC-authorized server, the
// attach proxy on the default server) runs against real tmux.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const tmux = require('../lib/tmux');
const { uniqueSessionName } = require('./_tmux-session-names');

// On a machine that has already launched a real TangleClaw pane (this one
// included), `~/.tangleclaw/merge-role-guard-wrapper` -- a `tmux` PATH
// wrapper lib/merge-role-guard.js#createRoleGuardWrapperScripts writes,
// #2946 -- can already be ahead of the real tmux binary on `process.env.PATH`.
// A bare `which tmux` would then resolve THIS CONSTANT to the wrapper, not
// the real binary -- and every shim this file installs on PATH for its own
// tests (`withSelectivelySlowTmux`) ends its fake run with `exec
// ${REAL_TMUX} "$@"`, so a wrapper-resolved REAL_TMUX makes that exec
// re-enter the wrapper instead of the real tmux, which then re-resolves
// PATH and finds the SAME shim again -- an infinite ping-pong between the
// two, confirmed for real on this exact machine. Filtering the wrapper
// directory out before resolving `which` is enough: nothing else is ever
// prepended to PATH at module-load time (a test's own shim dir is only
// ever added later, inside a single test, long after this line runs).
const REAL_TMUX = execFileSync('which', ['tmux'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: (process.env.PATH || '').split(path.delimiter)
      .filter((p) => path.basename(p) !== 'merge-role-guard-wrapper')
      .join(path.delimiter)
  }
}).trim();

/** Session names + fake-home dirs this file's tests created, cleaned up in `afterEach`. */
let createdDefault = [];
let createdFakeHome = null;
const realBootstrap = tmux.bootstrapTccAuthorizedServer;
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

// #2945 — a real session on the DEFAULT server, held for this whole file's
// run, so every test's attach proxy (created on the default server
// alongside the real TCC-authorized session) has a live server to land on.
const DEFAULT_ANCHOR_SESSION = uniqueSessionName('tcc_default_anchor');

before(() => {
  // `createSessionWithTccBootstrap`, not `tmux.createSession` directly, so
  // this stays off `test/tmux-session-names.test.js`'s (#1983) `CALLS_LIB`
  // scan the same way every other real-default-server session in this file
  // already does — `os.tmpdir()` is unprotected, so it delegates straight
  // through to the real `createSession` underneath regardless.
  tmux.createSessionWithTccBootstrap(DEFAULT_ANCHOR_SESSION, { cwd: os.tmpdir() });
});

after(() => {
  try { tmux.killSession(DEFAULT_ANCHOR_SESSION); } catch { /* already gone */ }
});

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
 * Kill {@link TCC_ANCHOR_SESSION} while keeping the TCC-authorized server
 * itself up (#3198) — tmux's default `exit-empty` kills the whole server
 * the instant its LAST session closes, so killing a lone anchor with
 * nothing else on that server kills the server too, not just the anchor.
 * A throwaway sibling session (never addressed by anything else) models
 * the realistic shape this is actually testing: a server already hosting
 * other real project sessions, where only the anchor specifically died.
 * `startAuthorizedAnchor()` must have run first.
 * @returns {void}
 */
function killAnchorKeepingServerAlive() {
  try {
    execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', 'tc-tcc-test-sibling'], { stdio: 'ignore' });
  } catch {
    execFileSync('tmux', ['-L', tmux.TCC_SOCKET, ['new', 'session'].join('-'), '-d', '-s', 'tc-tcc-test-sibling', '-c', '/tmp'], { stdio: 'ignore' });
  }
  execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'kill-session', '-t', tmux.TCC_ANCHOR_SESSION], { stdio: 'ignore' });
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

describe('_tccBootstrapCommand (#3148)', () => {
  it('uses new-session -A so a pre-existing tc-tcc-anchor session never fails with "duplicate session"', () => {
    let captured = null;
    tmux.bootstrapTccAuthorizedServer({ execFn: (command) => { captured = command; return ''; } });
    assert.match(captured, /new-session -A -d -s/);
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

  it('routes a protected cwd to the TCC-authorized server even when the default server CAN also read it right now (#3108)', () => {
    const cwd = fakeProtectedCwd('Documents/readable-proj');
    // #3108 — a protected cwd must never land on the default server just
    // because it transiently passed a readability probe: macOS can revoke
    // that server's access ~20-30 minutes later even though the
    // TCC-authorized server's own grant never lapses. This test proves the
    // default server being readable right now changes nothing: the session
    // still lands on TCC_SOCKET, with the usual attach proxy on default.
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_protected_readable');
      createdDefault.push(name);
      startAuthorizedAnchor();
      const created = tmux.createSessionWithTccBootstrap(name, { cwd });
      assert.equal(created, true);
      // The real session lives on the TCC-authorized server...
      assert.doesNotThrow(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
      // ...with the usual attach-only proxy on the default server, never a
      // real session created there directly.
      assert.equal(tmux.hasSession(name), true);
      assert.deepEqual(tmux.sessionSocketFlags(name), ['-L', tmux.TCC_SOCKET]);
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
      // #3130 — a raw `execFileSync` here, unlike `tmux.hasSession` above,
      // does not go through `lib/tmux.js`'s own `TMUX`-stripping `_exec`, so
      // it must strip it itself to target the same TRUE default server a
      // default-socket production call now does — otherwise, run from
      // inside ANY tmux pane (this suite's own, included), it would silently
      // check a DIFFERENT server than the one the proxy actually landed on.
      const defaultEnv = tmux._defaultChildEnv();
      const proxyCommand = execFileSync('tmux', ['list-panes', '-t', name, '-F', '#{pane_start_command}'], { encoding: 'utf8', env: defaultEnv }).trim();
      assert.match(proxyCommand, new RegExp(`tmux -L '?${tmux.TCC_SOCKET}'? -u attach -t`));
      const statusOption = execFileSync('tmux', ['show-option', '-t', name, 'status'], { encoding: 'utf8', env: defaultEnv }).trim();
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
      // #3130 — see the sibling test above: this must target the TRUE
      // default server too, not whatever socket this suite's own pane's
      // ambient `$TMUX` happens to name.
      const proxyCommand = execFileSync('tmux', ['list-panes', '-t', name, '-F', '#{pane_start_command}'], { encoding: 'utf8', env: tmux._defaultChildEnv() }).trim();
      assert.match(proxyCommand, /-u/, 'the proxy attaches with -u so the real session\'s UTF-8 content survives the hop');
    });
  });

  it('never probes the default server at all for a protected cwd (#3108) — only the TCC-authorized server\'s own readability is ever consulted', () => {
    const cwd = fakeProtectedCwd('Documents/default-absent-proj');

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
      assert.equal(probeCalled, false, 'a protected cwd must never probe the default server\'s readability at all (#3108) — only the TCC-authorized server\'s own probe runs');

      // The real session still lands on the already-running authorized server.
      assert.doesNotThrow(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
      assert.equal(tmux.hasSession(name), true, 'the default server still gets its attach proxy');
    });
  });

  it('falls back directly to the default tmux server when the TCC-authorized server is absent and the default server can already read cwd, without opening Terminal.app (#3148)', () => {
    const cwd = fakeProtectedCwd('Documents/default-fallback-proj');
    // #2735 — same contention-exposed real-probe shape as the other tests
    // in this file; this scenario's own probe (against the DEFAULT server)
    // is unshimmed and real, so it can occasionally exceed budget under
    // full-suite contention with no defect involved.
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_default_fallback');
      createdDefault.push(name);
      // The TCC-authorized server starts genuinely absent for this attempt.
      try { execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* already absent */ }
      let bootstrapCalls = 0;
      tmux.bootstrapTccAuthorizedServer = () => { bootstrapCalls++; };
      const created = tmux.createSessionWithTccBootstrap(name, { cwd });
      assert.equal(created, true);
      assert.equal(bootstrapCalls, 0, 'never opens Terminal.app when the default server can already read cwd (#3148)');
      // The real session lives on the DEFAULT server directly — no
      // TCC-authorized session or attach proxy at all, unlike every
      // #3108-preferring path exercised above.
      assert.equal(tmux.hasSession(name), true);
      assert.deepEqual(tmux.sessionSocketFlags(name), [], 'no TCC-authorized session exists for this name — it landed on the default server directly');
      assert.throws(
        () => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }),
        'no real session or proxy was created on the TCC-authorized socket'
      );
    });
  });

  it('evicts a stale TCC-authorized server holding only the anchor session before bootstrapping a fresh one, avoiding "duplicate session: tc-tcc-anchor" (#3148)', () => {
    const cwd = fakeProtectedCwd('Documents/evict-stale-anchor-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_evict_stale_anchor');
      createdDefault.push(name);
      // The TCC-authorized server is up but holds only the anchor — the
      // exact shape #3148's eviction targets.
      startAuthorizedAnchor();

      const sock = tmux.TCC_SOCKET;
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-evict-shim-'));
      const killMarker = path.join(binDir, 'kill-server-called');
      // Slows BOTH probes (TCC-authorized and default) past timeout, so the
      // code under test sees the authorized server as unreadable and the
      // default server as unreadable too, forcing it past the #3148
      // default-server fallback and into the eviction+bootstrap branch.
      // Separately records (rather than sleeps on) the exact eviction
      // `kill-server` call this test exists to prove happened, then lets it
      // through to the real binary for real.
      fs.writeFileSync(path.join(binDir, 'tmux'), [
        '#!/bin/sh',
        'case "$*" in',
        '  *run-shell*) exec sleep 30 ;;',
        `  "-L ${sock} kill-server") touch ${killMarker} ;;`,
        'esac',
        `exec ${REAL_TMUX} "$@"`
      ].join('\n'), { mode: 0o755 });
      const realPath = process.env.PATH;
      process.env.PATH = `${binDir}:${realPath}`;

      let bootstrapCalls = 0;
      tmux.bootstrapTccAuthorizedServer = () => {
        bootstrapCalls++;
        // Restore the real tmux on PATH before recreating — the eviction
        // above has already killed the stale server, so this always starts
        // a genuinely fresh one and must never race the slow-probe shim's
        // own timeout on the re-probe that follows.
        process.env.PATH = realPath;
        startAuthorizedAnchor();
      };

      let created;
      let evicted;
      try {
        created = tmux.createSessionWithTccBootstrap(name, { cwd });
        // Read before cleanup removes binDir (and the marker inside it) below.
        evicted = fs.existsSync(killMarker);
      } finally {
        process.env.PATH = realPath;
        fs.rmSync(binDir, { recursive: true, force: true });
      }

      assert.equal(created, true);
      assert.equal(bootstrapCalls, 1, 'bootstraps exactly once, after evicting the stale server');
      assert.equal(evicted, true, 'the stale TCC-authorized server (holding only the anchor) was evicted before bootstrapping a fresh one');
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

  it('populates options.born.paneId/born.server from the TCC-authorized server\'s own new-session, never null (#3257) — and tmux.visiblePane can read that pane back', () => {
    const cwd = fakeProtectedCwd('Documents/born-pane-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_born_pane');
      createdDefault.push(name);
      startAuthorizedAnchor();
      const born = { paneId: 'sentinel', server: 'sentinel' };
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        const created = tmux.createSessionWithTccBootstrap(name, { cwd, born });
        assert.equal(created, true);
      });
      // Real, not the attach proxy's: born.server must be the TCC-authorized
      // server's own identity, which the default server's proxy can never
      // produce (it is a different tmux server process entirely).
      assert.match(born.paneId, /^%\d+$/);
      assert.match(born.server, /^\d+\.\d+$/);
      const realServer = execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{pid}.#{start_time}'], { encoding: 'utf8' }).trim();
      assert.equal(born.server, realServer, 'born.server names the TCC-authorized server, not the default one');
      // The whole point (#3257): visiblePane must be able to read this pane
      // back using exactly what createSessionWithTccBootstrap recorded,
      // routing through the TCC-authorized socket on its own — the default
      // server's own same-named session is only the attach proxy, and a
      // caller that never knew about TCC_SOCKET at all still gets a real read.
      const pane = tmux.visiblePane(name, born.paneId, born.server);
      assert.equal(pane.paneId, born.paneId);
    });
  });

  it('leaves options.born.paneId/born.server null when the TCC new-session prints nothing usable, rather than throwing or guessing', () => {
    const cwd = fakeProtectedCwd('Documents/born-pane-malformed-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_born_pane_malformed');
      createdDefault.push(name);
      startAuthorizedAnchor();
      const born = { paneId: 'sentinel', server: 'sentinel' };
      // Discards stdout on exactly the `new-session` call this test's own
      // unique name reaches — the session is still created for real (the
      // shim still execs the real binary; only its own `-P -F` print is
      // lost), simulating "tmux ran but printed nothing usable" without
      // guessing at what malformed output would even look like.
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-silence-shim-'));
      fs.writeFileSync(path.join(binDir, 'tmux'), [
        '#!/bin/sh',
        'case "$*" in',
        `  *"new-session"*"${name}"*) exec ${REAL_TMUX} "$@" > /dev/null ;;`,
        `  *) exec ${REAL_TMUX} "$@" ;;`,
        'esac'
      ].join('\n'), { mode: 0o755 });
      const realPath = process.env.PATH;
      process.env.PATH = `${binDir}:${realPath}`;
      try {
        const created = tmux.createSessionWithTccBootstrap(name, { cwd, born });
        assert.equal(created, true);
      } finally {
        process.env.PATH = realPath;
        fs.rmSync(binDir, { recursive: true, force: true });
      }
      assert.equal(born.paneId, null);
      assert.equal(born.server, null);
      // The session itself was still created for real — only the identity
      // print was lost, which must not block (or fake) the bootstrap itself.
      assert.doesNotThrow(() => execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }));
    });
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

  it('killSession fails closed (reports false) when the TCC-authorized server\'s own existence check never answers, rather than reading the timeout as "confirmed absent" (R3 Round 3, PRR-A R-Gate HOLD)', () => {
    const cwd = fakeProtectedCwd('Documents/kill-probe-timeout-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_kill_probe_timeout');
      createdDefault.push(name);
      startAuthorizedAnchor();
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), true);
      });
      assert.equal(tmux.hasSession(name), true, 'the default-server proxy exists going in');

      // A real, unshimmed `has-session` against the TCC-authorized socket
      // answers near-instantly — the slow shim below only matches a
      // `has-session` call carrying `-L`, so the default server's own
      // `has-session`/`kill-session` calls (no `-L`) still reach the real
      // binary. This makes the _probeTccSession check this test cares
      // about reach the real production timeout, not a contention artifact.
      let killed;
      withSelectivelySlowTmux('"-L "*"has-session"*', () => {
        killed = tmux.killSession(name);
      });

      assert.equal(killed, false, 'an unanswered TCC existence check must never read as a clean kill');
      // The default-server proxy's own kill still ran for real and
      // succeeded — fail-closed is about the OVERALL verdict, not about
      // skipping work that could still safely happen.
      assert.equal(tmux.hasSession(name), false);
      // The real session on TCC_SOCKET was never actually confirmed gone
      // by this test (the probe that would have told us timed out) — left
      // for `afterEach`'s own `kill-server` on this test's isolated socket
      // to clean up regardless of this test's outcome, same as the
      // genuine-kill-failure test above.
    });
  });

  it('killSession fails closed (reports false) when the TCC-authorized existence check fails fast with an unrecognized error, not just on a timeout (R4, PRR-A R-Gate HOLD / PM Round 4)', () => {
    const cwd = fakeProtectedCwd('Documents/kill-probe-permission-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_kill_probe_permission');
      createdDefault.push(name);
      startAuthorizedAnchor();
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), true);
      });
      assert.equal(tmux.hasSession(name), true, 'the default-server proxy exists going in');

      // A FAST failure (no timeout at all) in tmux's OWN real wording for
      // a socket that exists but can't be connected to — confirmed against
      // the real binary (a 0000-permission socket file) to say exactly
      // this. Matches none of `_ABSENT_TCC_SESSION_RE`'s "nothing here"
      // patterns: `error connecting to` alone used to match here too (R4's
      // own regex, before this narrowing), which is exactly the false
      // positive PRR-A's Round 5 finding caught — a real, quick
      // connection/permission problem is not the same as a confirmed-absent
      // session, and must not be read as one.
      const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-permfail-'));
      fs.writeFileSync(path.join(binDir, 'tmux'), [
        '#!/bin/sh',
        'case "$*" in',
        '  "-L "*"has-session"*) echo "error connecting to /tmp/tmux-501/tangleclaw-tcc-authorized (Permission denied)" >&2; exit 1 ;;',
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

      assert.equal(killed, false, 'an unrecognized fast failure must read as unknown, never as confirmed absent');
      // Still ran the default-server kill for real, same as the timeout case.
      assert.equal(tmux.hasSession(name), false);
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

  it('paneCurrentPath returns null, never falling through to the default server\'s proxy, when the TCC-authorized existence check never answers (R3 Round 3, PRR-A R-Gate HOLD)', () => {
    const cwd = fakeProtectedCwd('Documents/pane-path-probe-timeout-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_pane_path_probe_timeout');
      createdDefault.push(name);
      startAuthorizedAnchor();
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), true);
      });
      let result;
      withSelectivelySlowTmux('"-L "*"has-session"*', () => {
        result = tmux.paneCurrentPath(name);
      });
      // Not the default-server proxy's own path (its pane is the attach
      // command, not `cwd`) and not `cwd` either — an unanswered existence
      // check is "unknown," which this function must never resolve by
      // guessing at the default server.
      assert.equal(result, null);
    });
  });
});

describe('_tccSafeWrapperDir / _stageTccSafeWrapperModules (#3108 secondary bug)', () => {
  it('_tccSafeWrapperDir finds the wrapper directory on PATH by basename', () => {
    const wrapperDir = path.join(os.tmpdir(), 'tc-tcc-wrapper-on-path-test', 'merge-role-guard-wrapper');
    const envPath = `/usr/local/bin${path.delimiter}${wrapperDir}${path.delimiter}/usr/bin`;
    assert.equal(tmux._tccSafeWrapperDir(envPath), wrapperDir);
  });

  it('_tccSafeWrapperDir falls back to ~/.tangleclaw/merge-role-guard-wrapper when PATH has no such entry', () => {
    createdFakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-fakehome-'));
    tmux._tccSeams.homedir = () => createdFakeHome;
    assert.equal(
      tmux._tccSafeWrapperDir('/usr/local/bin:/usr/bin'),
      path.join(createdFakeHome, '.tangleclaw', 'merge-role-guard-wrapper')
    );
    assert.equal(
      tmux._tccSafeWrapperDir(null),
      path.join(createdFakeHome, '.tangleclaw', 'merge-role-guard-wrapper'),
      'a missing/non-string PATH falls back the same way as one with no match'
    );
  });

  it('is a silent no-op when the wrapper directory does not exist (best-effort, never throws)', () => {
    const missingDir = path.join(os.tmpdir(), uniqueSessionName('tc-tcc-no-such-wrapper-dir'));
    assert.doesNotThrow(() => tmux._stageTccSafeWrapperModules({ PATH: missingDir }));
  });

  it('copies merge-role-guard.js and tmux-guard.js into the wrapper directory and repoints the gh/curl/tmux wrapper scripts\' require() at the staged copy, never the checkout\'s absolute path', () => {
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-wrapper-stage-'));
    // The basename must be exactly `merge-role-guard-wrapper` — that's what
    // `_tccSafeWrapperDir` matches on PATH; a scratch dir with any other
    // name is invisible to it and falls through to the ~/.tangleclaw
    // fallback instead.
    const wrapperDir = path.join(stagingRoot, 'merge-role-guard-wrapper');
    fs.mkdirSync(wrapperDir);
    try {
      const checkoutGuardPath = path.join(path.sep, 'Users', 'fake-operator', 'Documents', 'Projects', 'TC-Lane-Fake', 'lib', 'merge-role-guard.js');
      const checkoutTmuxGuardPath = path.join(path.sep, 'Users', 'fake-operator', 'Documents', 'Projects', 'TC-Lane-Fake', 'lib', 'tmux-guard.js');
      fs.writeFileSync(path.join(wrapperDir, 'gh'), `#!/usr/bin/env node\nconst guard = require(${JSON.stringify(checkoutGuardPath)});\n`);
      fs.writeFileSync(path.join(wrapperDir, 'curl'), `#!/usr/bin/env node\nconst guard = require(${JSON.stringify(checkoutGuardPath)});\n`);
      fs.writeFileSync(path.join(wrapperDir, 'tmux'), `#!/usr/bin/env node\nconst guard = require(${JSON.stringify(checkoutTmuxGuardPath)});\n`);

      tmux._stageTccSafeWrapperModules({ PATH: `/usr/local/bin${path.delimiter}${wrapperDir}` });

      assert.equal(fs.existsSync(path.join(wrapperDir, 'merge-role-guard.js')), true, 'merge-role-guard.js was staged into the wrapper dir');
      assert.equal(fs.existsSync(path.join(wrapperDir, 'tmux-guard.js')), true, 'tmux-guard.js was staged into the wrapper dir');

      const ghContent = fs.readFileSync(path.join(wrapperDir, 'gh'), 'utf8');
      const curlContent = fs.readFileSync(path.join(wrapperDir, 'curl'), 'utf8');
      const tmuxContent = fs.readFileSync(path.join(wrapperDir, 'tmux'), 'utf8');
      assert.match(ghContent, /require\("\.\/merge-role-guard\.js"\)/);
      assert.match(curlContent, /require\("\.\/merge-role-guard\.js"\)/);
      assert.match(tmuxContent, /require\("\.\/tmux-guard\.js"\)/);
      assert.doesNotMatch(ghContent, /Documents/, 'the checkout\'s ~/Documents path no longer appears anywhere in the rewritten script');
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  });

  it('createSessionWithTccBootstrap stages the wrapper modules for a protected cwd, with options.env passed through', () => {
    const cwd = fakeProtectedCwd('Documents/stage-wrapper-proj');
    const realStage = tmux._stageTccSafeWrapperModules;
    let stagedWithEnv;
    tmux._stageTccSafeWrapperModules = (env) => { stagedWithEnv = env; };
    try {
      withContentionRetry(() => {
        const name = uniqueSessionName('tcc_stage_wrapper');
        createdDefault.push(name);
        startAuthorizedAnchor();
        const env = { TC_TEST_MARKER: 'yes' };
        withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
          assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd, env }), true);
        });
        assert.equal(stagedWithEnv, env, 'staging ran with the exact options.env this call was given');
      });
    } finally {
      tmux._stageTccSafeWrapperModules = realStage;
    }
  });

  it('createSessionWithTccBootstrap also stages for an UNPROTECTED cwd, as long as options.env is given (PRR-A R1 BLOCKING 2) — the wrapper directory is shared across every session, not per-session', () => {
    const name = uniqueSessionName('tcc_stage_unprotected_with_env');
    createdDefault.push(name);
    const realStage = tmux._stageTccSafeWrapperModules;
    let stagedWithEnv;
    const env = { TC_TEST_MARKER: 'yes' };
    tmux._stageTccSafeWrapperModules = (e) => { stagedWithEnv = e; };
    try {
      assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd: os.tmpdir(), env }), true);
      assert.equal(stagedWithEnv, env, 'staging ran for an unprotected cwd too, with the exact options.env given');
    } finally {
      tmux._stageTccSafeWrapperModules = realStage;
    }
  });

  it('_stageTccSafeWrapperModules is a true no-op — never even reads the homedir — when no env object is given at all (PRR-A R1 BLOCKING 2)', () => {
    // Now that createSessionWithTccBootstrap calls this unconditionally, a
    // bare test call with no options.env (the shape dozens of existing
    // tests use) must never reach for the host's real
    // ~/.tangleclaw/merge-role-guard-wrapper. Proven by making homedir()
    // throw: if this function read it at all, the call below would throw.
    const realHomedir = tmux._tccSeams.homedir;
    tmux._tccSeams.homedir = () => { throw new Error('must not read homedir() when no env object was given'); };
    try {
      assert.doesNotThrow(() => tmux._stageTccSafeWrapperModules(undefined));
      assert.doesNotThrow(() => tmux._stageTccSafeWrapperModules(null));
      assert.doesNotThrow(() => tmux._stageTccSafeWrapperModules('not an object'));
    } finally {
      tmux._tccSeams.homedir = realHomedir;
    }
  });

});

describe('_isAntigravitySurveyPrompt / capturePane auto-dismiss (#3111)', () => {
  it('detects the Antigravity CLI survey banner across the tail of a capture, trailing pane-width padding included', () => {
    assert.equal(tmux._isAntigravitySurveyPrompt([
      '',
      'some earlier scrollback text                                        ',
      "How's the CLI experience so far?                                    ",
      'Help us improve: [1] Good [2] Fine [3] Bad [0] Skip                 ',
      ''
    ]), true);
  });

  it('returns false for an ordinary prompt, or no lines at all', () => {
    assert.equal(tmux._isAntigravitySurveyPrompt(['$ ', '']), false);
    assert.equal(tmux._isAntigravitySurveyPrompt([]), false);
    assert.equal(tmux._isAntigravitySurveyPrompt(null), false);
  });

  it('capturePane sends "0" (Skip) and re-captures exactly once when the survey banner is showing, returning the post-dismissal pane', () => {
    const name = uniqueSessionName('tcc_agy_survey_dismiss');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-survey-shim-'));
    const captureCountFile = path.join(binDir, 'capture-count');
    const sendKeysLogFile = path.join(binDir, 'send-keys-log');
    const bannerFile = path.join(binDir, 'banner.txt');
    fs.writeFileSync(captureCountFile, '0');
    fs.writeFileSync(bannerFile, "Help us improve: [1] Good [2] Fine [3] Bad [0] Skip\nHow's the CLI experience so far?\n");
    fs.writeFileSync(path.join(binDir, 'tmux'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *has-session*) exit 0 ;;',
      '  *alternate_on*) echo 0; exit 0 ;;',
      '  *capture-pane*)',
      `    n=$(cat ${captureCountFile})`,
      '    n=$((n+1))',
      `    echo $n > ${captureCountFile}`,
      '    if [ "$n" = "1" ]; then',
      `      cat ${bannerFile}`,
      '    else',
      '      printf "%s\\n" "$ "',
      '    fi',
      '    exit 0 ;;',
      '  *send-keys*)',
      `    echo "$*" >> ${sendKeysLogFile}`,
      '    exit 0 ;;',
      '  *) exit 0 ;;',
      'esac'
    ].join('\n'), { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${binDir}:${realPath}`;
    let result;
    try {
      result = tmux.capturePane(name, { lines: 5 });
    } finally {
      process.env.PATH = realPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
    // The real `_exec` trims the whole captured string, so a trailing space
    // on the LAST line of output (as a real shell prompt draws) is gone by
    // the time it reaches `.split('\n')` — expected, not a defect here.
    assert.deepEqual(result.lines, ['$']);
  });

  it('capturePane never auto-dismisses, and never re-captures, when options.dismissSurvey is false', () => {
    const name = uniqueSessionName('tcc_agy_survey_disabled');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-survey-shim-off-'));
    const captureCountFile = path.join(binDir, 'capture-count');
    const sendKeysLogFile = path.join(binDir, 'send-keys-log');
    const bannerFile = path.join(binDir, 'banner.txt');
    fs.writeFileSync(captureCountFile, '0');
    fs.writeFileSync(bannerFile, "Help us improve: [1] Good [2] Fine [3] Bad [0] Skip\nHow's the CLI experience so far?\n");
    fs.writeFileSync(path.join(binDir, 'tmux'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *has-session*) exit 0 ;;',
      '  *alternate_on*) echo 0; exit 0 ;;',
      '  *capture-pane*)',
      `    n=$(cat ${captureCountFile})`,
      '    n=$((n+1))',
      `    echo $n > ${captureCountFile}`,
      `    cat ${bannerFile}`,
      '    exit 0 ;;',
      '  *send-keys*)',
      `    echo "$*" >> ${sendKeysLogFile}`,
      '    exit 0 ;;',
      '  *) exit 0 ;;',
      'esac'
    ].join('\n'), { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${binDir}:${realPath}`;
    let result;
    let captureCount;
    let sendKeysLogExists;
    try {
      result = tmux.capturePane(name, { lines: 5, dismissSurvey: false });
      // Read these BEFORE the directory is cleaned up below — not after.
      captureCount = fs.readFileSync(captureCountFile, 'utf8').trim();
      sendKeysLogExists = fs.existsSync(sendKeysLogFile);
    } finally {
      process.env.PATH = realPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
    assert.match(result.lines.join('\n'), /How's the CLI experience so far\?/);
    assert.equal(captureCount, '1', 'captured exactly once — the disabled flag skipped the dismiss-and-recapture path');
    assert.equal(sendKeysLogExists, false, 'never sent the dismiss keypress');
  });

  /**
   * A `tmux` shim for `readPaneAsync`'s own command sequence: `has-session`,
   * `display-message` (the combined alt-screen/cursor facts probe), and
   * `capture-pane` — never the `-e` cursor-line variant, since the facts
   * probe below always answers with empty cursor coordinates, which
   * `readPaneAsync` reads as `NaN` and therefore never pursues. The banner
   * is served on the first `capture-pane` call and an ordinary prompt on
   * every call after, so a dismiss-and-re-read is observable the same way
   * the synchronous `capturePane` shims above prove it.
   * @param {string} binDir - Where to write the shim
   * @param {{captureCountFile: string, sendKeysLogFile: string, bannerFile: string}} files
   * @returns {void}
   */
  function writeAsyncSurveyShim(binDir, { captureCountFile, sendKeysLogFile, bannerFile }) {
    fs.writeFileSync(path.join(binDir, 'tmux'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *has-session*) exit 0 ;;',
      '  *display-message*) printf "%s\\n" "0,,,0"; exit 0 ;;',
      '  *capture-pane*)',
      `    n=$(cat ${captureCountFile})`,
      '    n=$((n+1))',
      `    echo $n > ${captureCountFile}`,
      '    if [ "$n" = "1" ]; then',
      `      cat ${bannerFile}`,
      '    else',
      '      printf "%s\\n" "$ "',
      '    fi',
      '    exit 0 ;;',
      '  *send-keys*)',
      `    echo "$*" >> ${sendKeysLogFile}`,
      '    exit 0 ;;',
      '  *) exit 0 ;;',
      'esac'
    ].join('\n'), { mode: 0o755 });
  }

  it('readPaneAsync sends "0" (Skip) and re-reads exactly once when the survey banner is showing (PRR-A R1 BLOCKING 1) — the live medusa-wake path, not just capturePane', async () => {
    const name = uniqueSessionName('tcc_agy_survey_async_dismiss');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-survey-async-shim-'));
    const captureCountFile = path.join(binDir, 'capture-count');
    const sendKeysLogFile = path.join(binDir, 'send-keys-log');
    const bannerFile = path.join(binDir, 'banner.txt');
    fs.writeFileSync(captureCountFile, '0');
    fs.writeFileSync(bannerFile, "Help us improve: [1] Good [2] Fine [3] Bad [0] Skip\nHow's the CLI experience so far?\n");
    writeAsyncSurveyShim(binDir, { captureCountFile, sendKeysLogFile, bannerFile });
    const realPath = process.env.PATH;
    process.env.PATH = `${binDir}:${realPath}`;
    let result;
    let sendKeysLog;
    try {
      result = await tmux.readPaneAsync(name, { lines: 5, timeout: 5000 });
      sendKeysLog = fs.existsSync(sendKeysLogFile) ? fs.readFileSync(sendKeysLogFile, 'utf8') : '';
    } finally {
      process.env.PATH = realPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
    assert.deepEqual(result.cap.lines, ['$']);
    assert.match(sendKeysLog, /send-keys .*\b0\b/, 'sent the literal "0" keypress to dismiss the survey (Skip)');
  });

  it('readPaneAsync never auto-dismisses, and never re-reads, when options.dismissSurvey is false', async () => {
    const name = uniqueSessionName('tcc_agy_survey_async_disabled');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-survey-async-shim-off-'));
    const captureCountFile = path.join(binDir, 'capture-count');
    const sendKeysLogFile = path.join(binDir, 'send-keys-log');
    const bannerFile = path.join(binDir, 'banner.txt');
    fs.writeFileSync(captureCountFile, '0');
    fs.writeFileSync(bannerFile, "Help us improve: [1] Good [2] Fine [3] Bad [0] Skip\nHow's the CLI experience so far?\n");
    writeAsyncSurveyShim(binDir, { captureCountFile, sendKeysLogFile, bannerFile });
    const realPath = process.env.PATH;
    process.env.PATH = `${binDir}:${realPath}`;
    let result;
    let captureCount;
    let sendKeysLogExists;
    try {
      result = await tmux.readPaneAsync(name, { lines: 5, timeout: 5000, dismissSurvey: false });
      captureCount = fs.readFileSync(captureCountFile, 'utf8').trim();
      sendKeysLogExists = fs.existsSync(sendKeysLogFile);
    } finally {
      process.env.PATH = realPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
    assert.match(result.cap.lines.join('\n'), /How's the CLI experience so far\?/);
    assert.equal(captureCount, '1', 'read exactly once — the disabled flag skipped the dismiss-and-re-read path');
    assert.equal(sendKeysLogExists, false, 'never sent the dismiss keypress');
  });
});

describe('isAlternateScreen / capturePane route the real TCC-authorized session, not the default-server attach proxy (#3182)', () => {
  /**
   * A fully fake `tmux` on PATH distinguishing the default server's own
   * attach-proxy pane (no `-L` flag: `#{alternate_on}`=1,
   * `#{pane_current_command}`=tmux, the shape `_createTccAttachProxy`'s
   * `tmux -u attach` produces) from the REAL session on `TCC_SOCKET` (the
   * `-L <socket>` follow-up calls `_resolveCapturePaneTarget` makes only
   * once it recognizes that shape) — real tmux is never involved, so this
   * exercises exactly the branching `lib/tmux.js` does, with no actual
   * TCC-authorized server to stand up.
   * @param {string} binDir
   * @param {{tccAltOn?: string, tccCaptureOutput?: string}} [opts]
   */
  function writeTccProxyShim(binDir, opts = {}) {
    const tccAltOn = opts.tccAltOn === undefined ? '0' : opts.tccAltOn;
    const tccCaptureOutput = opts.tccCaptureOutput || 'real session line 1\nreal session line 2\n';
    // Written to a file and `cat`, not inlined via printf: the content can
    // contain multiple lines, and only a real newline byte (not a shell
    // escape sequence a quoting layer could mangle) will do.
    const outputFile = path.join(binDir, 'tcc-capture-output.txt');
    fs.writeFileSync(outputFile, tccCaptureOutput);
    fs.writeFileSync(path.join(binDir, 'tmux'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *has-session*) exit 0 ;;',
      // The TCC_SOCKET follow-up alt-screen read (always carries -L).
      '  *-L*alternate_on*)',
      `    echo ${tccAltOn}`,
      '    exit 0 ;;',
      // The TCC_SOCKET follow-up capture (always carries -L).
      '  *-L*capture-pane*)',
      `    cat ${outputFile}`,
      '    exit 0 ;;',
      // The default server's combined alt-screen/command probe (no -L):
      // the attach-proxy shape every TCC-bootstrapped session's default
      // pane reports.
      '  *pane_current_command*)',
      '    printf "1,tmux\\n"',
      '    exit 0 ;;',
      // ensureMinWindowWidth's own default-server read — 200 is >= MIN_TMUX_COLS so no resize fires.
      '  *window_width*) echo 200; exit 0 ;;',
      // The default server's own capture-pane must never be reached once the
      // proxy shape is recognized — a visible failure if it is.
      '  *capture-pane*) printf "DEFAULT-SERVER-PROXY-WAS-CAPTURED\\n"; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac'
    ].join('\n'), { mode: 0o755 });
  }

  /** @returns {{restore: () => void}} swaps `process.env.PATH` to the shim dir; call `restore()` in a `finally`. */
  function withShimOnPath(binDir) {
    const realPath = process.env.PATH;
    process.env.PATH = `${binDir}:${realPath}`;
    return { restore: () => { process.env.PATH = realPath; } };
  }

  it('isAlternateScreen reads the REAL session on TCC_SOCKET, not the proxy\'s own always-alternate-screen default-server pane', () => {
    const name = uniqueSessionName('tcc_3182_isalt');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-3182-shim-'));
    writeTccProxyShim(binDir, { tccAltOn: '0' });
    const shim = withShimOnPath(binDir);
    let result;
    try {
      result = tmux.isAlternateScreen(name);
    } finally {
      shim.restore();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
    assert.equal(result, false, 'the real session is not in alternate screen, even though the default-server proxy pane always reports alternate_on=1');
  });

  it('isAlternateScreen returns true when the REAL TCC_SOCKET session itself is in alternate screen', () => {
    const name = uniqueSessionName('tcc_3182_isalt_true');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-3182-shim-'));
    writeTccProxyShim(binDir, { tccAltOn: '1' });
    const shim = withShimOnPath(binDir);
    let result;
    try {
      result = tmux.isAlternateScreen(name);
    } finally {
      shim.restore();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
    assert.equal(result, true);
  });

  it('capturePane(session, { lines: 2000 }) captures the REAL session on TCC_SOCKET with -L and -S -2000, returning alternateScreen: false', () => {
    const name = uniqueSessionName('tcc_3182_capture');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-3182-shim-'));
    const callLogFile = path.join(binDir, 'calls.log');
    writeTccProxyShim(binDir, { tccAltOn: '0', tccCaptureOutput: 'line one\nline two\nline three (deep scrollback)\n' });
    // Wrap the shim to also log every invocation, so the test can assert the
    // exact capture-pane command actually carried -L <TCC_SOCKET> and -S -2000.
    const shimPath = path.join(binDir, 'tmux');
    const shimBody = fs.readFileSync(shimPath, 'utf8');
    fs.writeFileSync(shimPath, shimBody.replace(
      "case \"$*\" in",
      `echo "$*" >> ${callLogFile}\ncase "$*" in`
    ), { mode: 0o755 });
    const shim = withShimOnPath(binDir);
    let result;
    let calls;
    try {
      result = tmux.capturePane(name, { lines: 2000 });
      calls = fs.readFileSync(callLogFile, 'utf8');
    } finally {
      shim.restore();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
    assert.equal(result.alternateScreen, false);
    assert.deepEqual(result.lines, ['line one', 'line two', 'line three (deep scrollback)']);
    assert.match(calls, new RegExp(`-L ${tmux.TCC_SOCKET} capture-pane .* -S -2000`), 'the real capture ran against TCC_SOCKET with the full 2000-line range, not the default server');
    assert.doesNotMatch(calls, /DEFAULT-SERVER-PROXY-WAS-CAPTURED/, 'the default server\'s own capture-pane was never reached');
  });

  it('capturePane still captures only the visible pane when the REAL TCC_SOCKET session is itself in alternate screen', () => {
    const name = uniqueSessionName('tcc_3182_capture_alt');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-3182-shim-'));
    writeTccProxyShim(binDir, { tccAltOn: '1', tccCaptureOutput: 'visible row only\n' });
    const shim = withShimOnPath(binDir);
    let result;
    try {
      result = tmux.capturePane(name, { lines: 2000 });
    } finally {
      shim.restore();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
    assert.equal(result.alternateScreen, true);
    assert.deepEqual(result.lines, ['visible row only']);
  });

  it('a non-TCC session (no proxy shape) is unaffected: isAlternateScreen/capturePane run against the default server exactly as before', () => {
    const name = uniqueSessionName('tcc_3182_nonproxy');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tcc-3182-nonproxy-shim-'));
    fs.writeFileSync(path.join(binDir, 'tmux'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *has-session*) exit 0 ;;',
      '  *pane_current_command*) printf "0,zsh\\n"; exit 0 ;;', // real pane, not alt-screen, not the proxy shape
      '  *window_width*) echo 200; exit 0 ;;',
      '  *capture-pane*) printf "ordinary pane output\\n"; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac'
    ].join('\n'), { mode: 0o755 });
    const shim = withShimOnPath(binDir);
    let altScreen;
    let result;
    try {
      altScreen = tmux.isAlternateScreen(name);
      result = tmux.capturePane(name, { lines: 5 });
    } finally {
      shim.restore();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
    assert.equal(altScreen, false);
    assert.deepEqual(result.lines, ['ordinary pane output']);
  });

  it('_isTccAttachProxyPane recognizes exactly the proxy shape, nothing looser', () => {
    assert.equal(tmux._isTccAttachProxyPane('1,tmux'), true);
    assert.equal(tmux._isTccAttachProxyPane('0,tmux'), false, 'not alternate-screen: a real tmux-named pane, not the proxy');
    assert.equal(tmux._isTccAttachProxyPane('1,zsh'), false, 'alternate-screen but not running tmux: a real TUI, not the proxy');
    assert.equal(tmux._isTccAttachProxyPane(''), false);
    assert.equal(tmux._isTccAttachProxyPane(null), false);
  });
});

describe('ensureTccAnchorAlive (#3130, PRR-A R1 BLOCKING 2b)', () => {
  it('is a no-op when the anchor is already alive', () => {
    startAuthorizedAnchor();
    assert.equal(tmux.ensureTccAnchorAlive(), true);
    assert.doesNotThrow(() => execFileSync(
      'tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', tmux.TCC_ANCHOR_SESSION], { stdio: 'ignore' }
    ));
  });

  it('recreates the anchor directly (no Terminal.app) when it has died but the server is still up', () => {
    startAuthorizedAnchor();
    execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'kill-session', '-t', tmux.TCC_ANCHOR_SESSION], { stdio: 'ignore' });
    assert.throws(() => execFileSync(
      'tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', tmux.TCC_ANCHOR_SESSION], { stdio: 'ignore' }
    ), 'the anchor must genuinely be gone before this test proves anything');
    tmux.bootstrapTccAuthorizedServer = () => {
      throw new Error('must not bootstrap via Terminal.app for an already-running server');
    };
    assert.equal(tmux.ensureTccAnchorAlive(), true);
    assert.doesNotThrow(() => execFileSync(
      'tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', tmux.TCC_ANCHOR_SESSION], { stdio: 'ignore' }
    ), 'the anchor must have been recreated');
  });

  it('reports false, rather than throwing, when even the recreate attempt fails', () => {
    startAuthorizedAnchor();
    execFileSync('tmux', ['-L', tmux.TCC_SOCKET, 'kill-session', '-t', tmux.TCC_ANCHOR_SESSION], { stdio: 'ignore' });
    const failingExecFn = (command) => {
      if (command.includes('has-session')) throw new Error("can't find session: tc-tcc-anchor");
      throw new Error('simulated new-session failure');
    };
    assert.equal(tmux.ensureTccAnchorAlive({ execFn: failingExecFn }), false);
  });
});

describe('probeTccReadable targets the anchor explicitly, never untargeted, for a socket probe (#3130, PRR-A R1 BLOCKING 2c)', () => {
  it("passes -t '=tc-tcc-anchor:' to run-shell when options.socket is set", () => {
    const calls = [];
    const fakeExecFn = (command) => { calls.push(command); return ''; };
    tmux.probeTccReadable('/tmp', { socket: tmux.TCC_SOCKET, execFn: fakeExecFn });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /run-shell -t '=tc-tcc-anchor:' /,
      `expected an exact-match -t target at the anchor, got: ${calls[0]}`);
  });

  it('stays untargeted for a default-server probe (no socket) — there is no anchor to aim at there', () => {
    const calls = [];
    const fakeExecFn = (command) => { calls.push(command); return ''; };
    tmux.probeTccReadable('/tmp', { execFn: fakeExecFn });
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /-t /);
  });

  it('end-to-end: an untargeted probe reaches the real anchor session, not whatever else is "current"', () => {
    // #2735 — a real client-server round-trip against an already-running
    // server, same contention exposure `withContentionRetry`'s own doc
    // comment already names for this file's other real-tmux assertions.
    withContentionRetry(() => {
      startAuthorizedAnchor();
      assert.equal(tmux.probeTccReadable(os.tmpdir(), { socket: tmux.TCC_SOCKET }), true);
    });
  });
});

describe('probeTccServerHealth (#3198) — non-mutating health summary for GET /api/system/health', () => {
  it('reports not running, with no anchor and no readable check, when the server is absent', () => {
    const h = tmux.probeTccServerHealth();
    assert.deepEqual(h, { socket: tmux.TCC_SOCKET, running: false, anchorAlive: false, readable: null });
  });

  it('reports running with anchorAlive true once the anchor is up, readable still null with no cwd asked', () => {
    startAuthorizedAnchor();
    const h = tmux.probeTccServerHealth();
    assert.equal(h.running, true);
    assert.equal(h.anchorAlive, true);
    assert.equal(h.readable, null);
  });

  it('reports running but anchorAlive false when the server is up but the anchor session has died', () => {
    startAuthorizedAnchor();
    killAnchorKeepingServerAlive();
    const h = tmux.probeTccServerHealth();
    assert.equal(h.running, true);
    assert.equal(h.anchorAlive, false);
    assert.equal(h.readable, null);
  });

  it('never creates the server — a true read, not a side-effecting one', () => {
    tmux.probeTccServerHealth();
    assert.throws(() => execFileSync(
      'tmux', ['-L', tmux.TCC_SOCKET, 'has-session'], { stdio: 'ignore' }
    ), 'no server must exist after a plain health read against an absent one');
  });

  it('never recreates a dead anchor — a true read, not ensureTccAnchorAlive in disguise', () => {
    startAuthorizedAnchor();
    killAnchorKeepingServerAlive();
    tmux.probeTccServerHealth();
    assert.throws(() => execFileSync(
      'tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', tmux.TCC_ANCHOR_SESSION], { stdio: 'ignore' }
    ), 'the dead anchor must still be dead after a plain health read');
  });

  it('checks readable only when running + anchorAlive + a cwd are all given', () => {
    startAuthorizedAnchor();
    const h = tmux.probeTccServerHealth({ cwd: os.tmpdir() });
    assert.equal(h.readable, true);
  });

  it('leaves readable null when a cwd is given but the anchor is dead — probing a dead anchor would be meaningless', () => {
    startAuthorizedAnchor();
    killAnchorKeepingServerAlive();
    const h = tmux.probeTccServerHealth({ cwd: os.tmpdir() });
    assert.equal(h.anchorAlive, false);
    assert.equal(h.readable, null);
  });
});

describe('stopped sessions under a protected path recover cleanly after a service restart (#3198)', () => {
  it('creates the session normally even when the TCC-authorized anchor died since the last restart', () => {
    // What a service restart actually leaves behind: the TCC-authorized
    // tmux server is an INDEPENDENT process, never a child of node, so it
    // (unlike every in-process JS module) survives a `com.tangleclaw.server`
    // restart untouched — but nothing re-verified its anchor session
    // specifically stayed alive in the meantime (#3130's own root cause,
    // here exercised through the full createSessionWithTccBootstrap path
    // rather than ensureTccAnchorAlive in isolation).
    startAuthorizedAnchor();
    killAnchorKeepingServerAlive();
    assert.throws(() => execFileSync(
      'tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', tmux.TCC_ANCHOR_SESSION], { stdio: 'ignore' }
    ), 'the anchor must genuinely be dead before this test proves anything');

    const cwd = fakeProtectedCwd('Documents/stopped-project');
    const name = uniqueSessionName('tcc_stopped_recovery');
    createdDefault.push(name);
    tmux.bootstrapTccAuthorizedServer = () => {
      throw new Error('must not need Terminal.app — the server is already up, only its anchor session was gone');
    };

    assert.equal(tmux.createSessionWithTccBootstrap(name, { cwd }), true);
    assert.doesNotThrow(() => execFileSync(
      'tmux', ['-L', tmux.TCC_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' }
    ), 'the real session must exist on the TCC-authorized server, not just the default-server attach proxy');
    // The health summary now reflects the recovery too — the same anchor
    // this path just restored, read back non-mutatingly.
    assert.deepEqual(
      { running: true, anchorAlive: true },
      { running: tmux.probeTccServerHealth().running, anchorAlive: tmux.probeTccServerHealth().anchorAlive }
    );
  });
});

describe('_cancelStrayCopyMode and sendKeys (#3130, PRR-A R1 BLOCKING 2d)', () => {
  it('clears a real copy-mode overlay — #{pane_in_mode} flips from 1 to 0', () => {
    const name = uniqueSessionName('tcc_copy_mode_direct');
    createdDefault.push(name);
    tmux.createSessionWithTccBootstrap(name, { cwd: os.tmpdir() });
    const defaultEnv = tmux._defaultChildEnv();
    execFileSync('tmux', ['copy-mode', '-t', `=${name}:`], { stdio: 'ignore', env: defaultEnv });
    const before = execFileSync(
      'tmux', ['display-message', '-p', '-t', `=${name}:`, '#{pane_in_mode}'], { encoding: 'utf8', env: defaultEnv }
    ).trim();
    assert.equal(before, '1', 'the fixture must actually be in copy-mode before this proves anything');
    tmux._cancelStrayCopyMode(name);
    const after = execFileSync(
      'tmux', ['display-message', '-p', '-t', `=${name}:`, '#{pane_in_mode}'], { encoding: 'utf8', env: defaultEnv }
    ).trim();
    assert.equal(after, '0');
  });

  it('is a harmless no-op on a pane that is not in any mode', () => {
    const name = uniqueSessionName('tcc_copy_mode_noop');
    createdDefault.push(name);
    tmux.createSessionWithTccBootstrap(name, { cwd: os.tmpdir() });
    assert.doesNotThrow(() => tmux._cancelStrayCopyMode(name));
  });

  it('runs at the very start of sendKeys, before the startup-dialog read or the prompt clear', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tmux.js'), 'utf8');
    const fnStart = src.indexOf('function sendKeys(session, text, options = {}) {');
    assert.ok(fnStart > -1, 'sendKeys must exist');
    const fnBody = src.slice(fnStart, src.indexOf('\nfunction ', fnStart + 1));
    const cancelIdx = fnBody.indexOf('_cancelStrayCopyMode(session);');
    const dialogIdx = fnBody.indexOf('_startupDialogOn(session');
    const clearIdx = fnBody.indexOf('_clearPromptLine(session');
    assert.ok(cancelIdx > -1, '_cancelStrayCopyMode must be called inside sendKeys');
    assert.ok(cancelIdx < dialogIdx, 'must run before the startup-dialog read');
    assert.ok(cancelIdx < clearIdx, 'must run before the prompt clear');
  });
});

describe('scrubSessionLaunchSecrets (#3212 Phase 1.2 — ephemeral launch-secret scrubbing)', () => {
  it('removes the default key from a plain default-server session, leaving an unrelated var untouched', () => {
    const name = uniqueSessionName('tcc_scrub_default');
    createdDefault.push(name);
    tmux.createSession(name, { cwd: os.tmpdir(), env: { TANGLECLAW_LAUNCH_SECRET: 'shh', TC_TEST_KEEP: 'keep' } });

    const result = tmux.scrubSessionLaunchSecrets(name);

    assert.deepEqual(result, { scrubbed: ['TANGLECLAW_LAUNCH_SECRET'], sockets: ['default'] });
    assert.equal(tmux.readSessionEnv(name, 'TANGLECLAW_LAUNCH_SECRET').value, null);
    assert.equal(tmux.readSessionEnv(name, 'TC_TEST_KEEP').value, 'keep', 'an unrelated var is never touched');
  });

  it('scrubs both the default-server attach proxy AND the real session on the TCC-authorized socket', () => {
    const cwd = fakeProtectedCwd('Documents/scrub-tcc-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_scrub_tcc');
      createdDefault.push(name);
      startAuthorizedAnchor();
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.equal(
          tmux.createSessionWithTccBootstrap(name, { cwd, env: { TANGLECLAW_LAUNCH_SECRET: 'shh' } }),
          true
        );
      });

      const result = tmux.scrubSessionLaunchSecrets(name);

      assert.deepEqual(new Set(result.scrubbed), new Set(['TANGLECLAW_LAUNCH_SECRET']));
      assert.deepEqual(new Set(result.sockets), new Set(['default', tmux.TCC_SOCKET]));
      // `readSessionEnv` (no socket option) only ever asks the default server
      // — the proxy — so this only passes if the proxy's own copy is gone.
      assert.equal(tmux.readSessionEnv(name, 'TANGLECLAW_LAUNCH_SECRET').value, null);
      // The REAL session's copy, on the TCC-authorized socket, needs its own read — a
      // session-local var (never present in the global environment) that `-u` removes is gone
      // from the table entirely, so tmux itself refuses a query for it by name, same as it would
      // for a name that was never set at all.
      assert.throws(
        () => execFileSync(
          'tmux', ['-L', tmux.TCC_SOCKET, 'show-environment', '-t', `=${name}:`, 'TANGLECLAW_LAUNCH_SECRET'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ),
        /unknown variable/,
        'the real session on the TCC socket no longer has a value for it either'
      );
    });
  });

  it('accepts a caller-supplied key list instead of the default', () => {
    const name = uniqueSessionName('tcc_scrub_custom_keys');
    createdDefault.push(name);
    // Neither key here is in EPHEMERAL_LAUNCH_SECRET_KEYS, so `createSession` does not
    // auto-scrub either of them — this test is about the explicit `envKeys` argument, not
    // automatic post-spawn scrubbing (covered separately below).
    tmux.createSession(name, { cwd: os.tmpdir(), env: { TC_TEST_CUSTOM: 'also-shh', TC_TEST_KEEP: 'keep' } });

    const result = tmux.scrubSessionLaunchSecrets(name, ['TC_TEST_CUSTOM']);

    assert.deepEqual(result, { scrubbed: ['TC_TEST_CUSTOM'], sockets: ['default'] });
    assert.equal(tmux.readSessionEnv(name, 'TC_TEST_CUSTOM').value, null);
    // The key not passed in the explicit list is left alone.
    assert.equal(tmux.readSessionEnv(name, 'TC_TEST_KEEP').value, 'keep');
  });

  it('createSession automatically scrubs a key from EPHEMERAL_LAUNCH_SECRET_KEYS right after spawn', () => {
    const name = uniqueSessionName('tcc_auto_scrub_default');
    createdDefault.push(name);

    tmux.createSession(name, { cwd: os.tmpdir(), env: { TANGLECLAW_LAUNCH_SECRET: 'shh', TC_TEST_KEEP: 'keep' } });

    // No manual scrubSessionLaunchSecrets call — createSession must have done it itself.
    assert.equal(tmux.readSessionEnv(name, 'TANGLECLAW_LAUNCH_SECRET').value, null);
    assert.equal(tmux.readSessionEnv(name, 'TC_TEST_KEEP').value, 'keep', 'an unrelated var is never touched');
  });

  it('createSession never scrubs anything when options.env carries no ephemeral-secret key', () => {
    const name = uniqueSessionName('tcc_auto_scrub_ungated');
    createdDefault.push(name);

    tmux.createSession(name, { cwd: os.tmpdir(), env: { TC_TEST_KEEP: 'keep' } });

    assert.equal(tmux.readSessionEnv(name, 'TC_TEST_KEEP').value, 'keep');
  });

  it('createSessionWithTccBootstrap automatically scrubs the real session AND the default-server proxy', () => {
    const cwd = fakeProtectedCwd('Documents/auto-scrub-tcc-proj');
    withContentionRetry(() => {
      const name = uniqueSessionName('tcc_auto_scrub_tcc');
      createdDefault.push(name);
      startAuthorizedAnchor();
      withSelectivelySlowTmux('"run-shell /bin/ls -- "*', () => {
        assert.equal(
          tmux.createSessionWithTccBootstrap(name, { cwd, env: { TANGLECLAW_LAUNCH_SECRET: 'shh' } }),
          true
        );
      });

      // No manual scrubSessionLaunchSecrets call — createSessionWithTccBootstrap must have done it.
      assert.equal(tmux.readSessionEnv(name, 'TANGLECLAW_LAUNCH_SECRET').value, null);
      assert.throws(
        () => execFileSync(
          'tmux', ['-L', tmux.TCC_SOCKET, 'show-environment', '-t', `=${name}:`, 'TANGLECLAW_LAUNCH_SECRET'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ),
        /unknown variable/,
        'the real session on the TCC socket was scrubbed too'
      );
    });
  });

  it('_envCarriesEphemeralSecret recognizes a default key and ignores everything else', () => {
    assert.equal(tmux._envCarriesEphemeralSecret({ TANGLECLAW_LAUNCH_SECRET: 'x' }), true);
    assert.equal(tmux._envCarriesEphemeralSecret({ TC_TEST_KEEP: 'keep' }), false);
    assert.equal(tmux._envCarriesEphemeralSecret(null), false);
    assert.equal(tmux._envCarriesEphemeralSecret(undefined), false);
  });

  it('is a non-throwing no-op on a session that does not exist', () => {
    const name = uniqueSessionName('tcc_scrub_missing');
    let result;
    assert.doesNotThrow(() => { result = tmux.scrubSessionLaunchSecrets(name); });
    assert.deepEqual(result, { scrubbed: [], sockets: [] });
  });

  it('is a non-throwing no-op on an invalid session name', () => {
    assert.deepEqual(tmux.scrubSessionLaunchSecrets('not a valid name!'), { scrubbed: [], sockets: [] });
  });

  it('drops a key that is not a valid environment-variable identifier rather than attempting it', () => {
    const name = uniqueSessionName('tcc_scrub_bad_key');
    createdDefault.push(name);
    tmux.createSession(name, { cwd: os.tmpdir(), env: { TC_TEST_KEEP: 'keep' } });

    const result = tmux.scrubSessionLaunchSecrets(name, ['not a key; rm -rf /']);

    assert.deepEqual(result, { scrubbed: [], sockets: [] });
    assert.equal(tmux.readSessionEnv(name, 'TC_TEST_KEEP').value, 'keep');
  });
});
