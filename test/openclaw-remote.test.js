'use strict';

/*
 * #1529 — the non-blocking runners behind the OpenClaw routes that reach a
 * remote host. Driven with REAL processes: the error shapes async `exec` and
 * `execFile` produce are exactly what this repo has modelled wrongly before
 * (lib/exec-timeout.js), so a stub would only assert our own assumptions.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const remote = require('../lib/openclaw-remote');
const { wasTimedOut } = require('../lib/exec-timeout');

describe('openclaw-remote runShell (#1529)', () => {
  it('writes input to stdin and resolves stdout', async () => {
    const { stdout } = await remote._runShell('cat', { input: 'discovery script\n' });
    assert.equal(stdout, 'discovery script\n');
  });

  it('rejects a failing command with its stderr and numeric exit code', async () => {
    await assert.rejects(
      remote._runShell('echo nope >&2; exit 3'),
      (err) => {
        assert.equal(err.code, 3);
        assert.equal(err.stderr, 'nope\n');
        assert.equal(wasTimedOut(err), false, 'an ordinary failure is not a timeout');
        return true;
      }
    );
  });

  it('kills a command that outlives its timeout and names the timeout', async () => {
    await assert.rejects(
      remote._runShell('sleep 5', { timeout: 100 }),
      (err) => {
        assert.equal(wasTimedOut(err), true);
        assert.equal(err.timedOut, true);
        assert.equal(err.message, 'timed out after 100ms');
        assert.equal(err.stderr, '', 'nothing was said, so the message carries the timeout');
        return true;
      }
    );
  });

  it('keeps what a timed-out command said, and still names the timeout', async () => {
    await assert.rejects(
      remote._runShell('echo connecting >&2; sleep 5', { timeout: 300 }),
      (err) => {
        assert.equal(err.stderr, 'connecting (timed out after 300ms)');
        return true;
      }
    );
  });

  it('never echoes the command line in a failure message', async () => {
    await assert.rejects(
      remote._runShell('exit 4 # -i /secret/key/path'),
      (err) => {
        assert.equal(err.message, 'exited with status 4');
        assert.doesNotMatch(err.message, /secret/);
        return true;
      }
    );
  });

  it('does not hold the event loop while the command runs', async () => {
    let settled = false;
    const pending = remote._runShell('sleep 0.3').then(() => { settled = true; });
    const ranWhilePending = await new Promise((resolve) => setTimeout(() => resolve(!settled), 20));
    assert.equal(ranWhilePending, true, 'a timer ran while the child was still running');
    await pending;
  });

  it('tolerates a child that exits without reading its input', async () => {
    const { stdout } = await remote._runShell('echo done', { input: 'x'.repeat(1 << 20) });
    assert.equal(stdout, 'done\n');
  });
});

describe('openclaw-remote resolveReachableHost (#1531)', () => {
  const orig = remote._internal.probePort;
  afterEach(() => {
    remote._internal.probePort = orig;
    remote._resolved.clear();
  });

  it('returns immediately with no probing for a connection with no fallbackHosts — zero overhead', async () => {
    let probed = false;
    remote._internal.probePort = () => { probed = true; return Promise.resolve(true); };
    const r = await remote.resolveReachableHost({ id: 'c1', host: 'h1', fallbackHosts: [] });
    assert.deepEqual(r, { host: 'h1', fallbackUsed: false, candidatesTried: ['h1'] });
    assert.equal(probed, false, 'no fallbackHosts means no probe at all');
  });

  it('also skips probing when fallbackHosts is absent entirely (undefined)', async () => {
    let probed = false;
    remote._internal.probePort = () => { probed = true; return Promise.resolve(true); };
    const r = await remote.resolveReachableHost({ id: 'c2', host: 'h1' });
    assert.deepEqual(r, { host: 'h1', fallbackUsed: false, candidatesTried: ['h1'] });
    assert.equal(probed, false);
  });

  it('probes every candidate IN PARALLEL and picks the highest-priority one that answered', async () => {
    const started = [];
    remote._internal.probePort = (host) => {
      started.push(host);
      // h1 (primary) never answers; h2 and h3 both do, h2 is higher priority.
      return new Promise((resolve) => setImmediate(() => resolve(host !== 'h1')));
    };
    const r = await remote.resolveReachableHost({ id: 'c3', host: 'h1', fallbackHosts: ['h2', 'h3'] });
    assert.deepEqual(started, ['h1', 'h2', 'h3'], 'all three candidates were probed before any answer was known');
    assert.deepEqual(r, { host: 'h2', fallbackUsed: true, candidatesTried: ['h1', 'h2', 'h3'] });
  });

  it('a slower higher-priority candidate still wins over a faster lower-priority one', async () => {
    remote._internal.probePort = (host) => {
      if (host === 'h1') return new Promise((resolve) => setTimeout(() => resolve(true), 15)); // slow but highest priority
      return Promise.resolve(true); // h2 answers instantly
    };
    const r = await remote.resolveReachableHost({ id: 'c4', host: 'h1', fallbackHosts: ['h2'] });
    assert.equal(r.host, 'h1', 'priority order wins, not speed');
  });

  it('falls back to the primary host when nothing answers, rather than inventing a diagnosis', async () => {
    remote._internal.probePort = () => Promise.resolve(false);
    const r = await remote.resolveReachableHost({ id: 'c5', host: 'h1', fallbackHosts: ['h2'] });
    assert.deepEqual(r, { host: 'h1', fallbackUsed: false, candidatesTried: ['h1', 'h2'] });
  });

  it('dedupes a fallback that repeats the primary host (or another fallback)', async () => {
    remote._internal.probePort = (host) => Promise.resolve(host === 'h1');
    const r = await remote.resolveReachableHost({ id: 'c6', host: 'h1', fallbackHosts: ['h1', 'h2', 'h2'] });
    assert.deepEqual(r.candidatesTried, ['h1', 'h2']);
  });

  it('caches the resolution per connection id for the TTL — a second call does not re-probe', async () => {
    let calls = 0;
    remote._internal.probePort = (host) => { calls++; return Promise.resolve(host === 'h2'); };
    const first = await remote.resolveReachableHost({ id: 'c7', host: 'h1', fallbackHosts: ['h2'] });
    const callsAfterFirst = calls;
    const second = await remote.resolveReachableHost({ id: 'c7', host: 'h1', fallbackHosts: ['h2'] });
    assert.deepEqual(second, first);
    assert.equal(calls, callsAfterFirst, 'no new probes on the cached call');
  });

  it('re-probes once the TTL has elapsed', async () => {
    let calls = 0;
    remote._internal.probePort = (host) => { calls++; return Promise.resolve(host === 'h2'); };
    await remote.resolveReachableHost({ id: 'c8', host: 'h1', fallbackHosts: ['h2'] }, { ttlMs: 10 });
    const callsAfterFirst = calls;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await remote.resolveReachableHost({ id: 'c8', host: 'h1', fallbackHosts: ['h2'] }, { ttlMs: 10 });
    assert.ok(calls > callsAfterFirst, 'the stale cache entry triggered a fresh probe');
  });

  it('accepts an injected probePortImpl per call, independent of the cached default', async () => {
    const r = await remote.resolveReachableHost(
      { id: 'c9', host: 'h1', fallbackHosts: ['h2'] },
      { probePortImpl: (host) => Promise.resolve(host === 'h2') }
    );
    assert.equal(r.host, 'h2');
  });
});

describe('openclaw-remote invalidateResolvedHost / getActiveRoute (#1531)', () => {
  afterEach(() => { remote._resolved.clear(); });

  it('getActiveRoute reads back the cached resolution', async () => {
    await remote.resolveReachableHost(
      { id: 'c10', host: 'h1', fallbackHosts: ['h2'] },
      { probePortImpl: (host) => Promise.resolve(host === 'h2') }
    );
    const route = remote.getActiveRoute('c10');
    assert.equal(route.activeHost, 'h2');
    assert.equal(route.fallbackUsed, true);
    assert.equal(typeof route.resolvedAt, 'number');
  });

  it('getActiveRoute is null for an unknown or never-resolved connection', () => {
    assert.equal(remote.getActiveRoute('nonexistent'), null);
    assert.equal(remote.getActiveRoute(undefined), null);
  });

  it('invalidateResolvedHost clears the cache, forcing the next call to re-probe', async () => {
    let calls = 0;
    await remote.resolveReachableHost(
      { id: 'c11', host: 'h1', fallbackHosts: ['h2'] },
      { probePortImpl: (host) => { calls++; return Promise.resolve(host === 'h2'); } }
    );
    const callsAfterFirst = calls;
    remote.invalidateResolvedHost('c11');
    assert.equal(remote.getActiveRoute('c11'), null);
    await remote.resolveReachableHost(
      { id: 'c11', host: 'h1', fallbackHosts: ['h2'] },
      { probePortImpl: (host) => { calls++; return Promise.resolve(host === 'h2'); } }
    );
    assert.ok(calls > callsAfterFirst, 're-probed after invalidation');
  });

  it('invalidateResolvedHost on an unknown id is a no-op, never throws', () => {
    assert.doesNotThrow(() => remote.invalidateResolvedHost('nonexistent'));
    assert.doesNotThrow(() => remote.invalidateResolvedHost(undefined));
  });
});

describe('openclaw-remote _probePort — the real TCP probe, against a real listener (#1531)', () => {
  it('resolves true for a host:port actually accepting connections', async () => {
    const net = require('node:net');
    const srv = net.createServer((sock) => sock.end());
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    try {
      const ok = await remote._internal.probePort('127.0.0.1', port, 1000);
      assert.equal(ok, true);
    } finally {
      srv.close();
    }
  });

  it('resolves false for a port nothing is listening on', async () => {
    // Port 1 is a privileged port essentially never bound in test environments.
    const ok = await remote._internal.probePort('127.0.0.1', 1, 300);
    assert.equal(ok, false);
  });

  it('resolves false (not rejects) on a connect timeout against a non-routable address', async () => {
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737) — reserved, never routable.
    const ok = await remote._internal.probePort('192.0.2.1', 22, 200);
    assert.equal(ok, false);
  });
});

describe('openclaw-remote runFile (#1529)', () => {
  it('passes arguments verbatim, with no shell in between', async () => {
    const hostile = 'a; echo PWNED $(whoami)';
    const { stdout } = await remote._runFile('printf', ['%s', hostile]);
    assert.equal(stdout, hostile);
  });

  it('rejects with the exit code and stderr', async () => {
    await assert.rejects(
      remote._runFile('sh', ['-c', 'echo denied >&2; exit 255']),
      (err) => {
        assert.equal(err.code, 255);
        assert.equal(err.stderr, 'denied\n');
        return true;
      }
    );
  });

  it('reports a timeout it caused, by name', async () => {
    await assert.rejects(
      remote._runFile('sleep', ['5'], { timeout: 100 }),
      (err) => wasTimedOut(err) && typeof err.code !== 'number' && err.message === 'timed out after 100ms'
    );
  });
});
