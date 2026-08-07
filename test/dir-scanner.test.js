'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const dirScanner = require('../lib/dir-scanner');
const { _plainDirent, _plainError } = require('../lib/dir-scanner-child');

const HANG_CHILD = path.join(__dirname, '_dir-scanner-hang-child.js');
const POOL_DEMO = path.join(__dirname, '_dir-scanner-pool-demo.js');

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dir-scanner-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * A fresh scratch directory, so no test can see another's entries.
 * @param {string} name - Distinguishing name.
 * @returns {string} Absolute path.
 */
function scratch(name) {
  const p = path.join(tmpRoot, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/**
 * Is a process still in the process table?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything — the standard way to ask "is this pid alive" without disturbing it.
 *
 * @param {number} pid - Process to test.
 * @returns {boolean}
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Wait for a pid to leave the process table.
 *
 * Polled rather than awaited on an event: the pid belongs to a process this test
 * did not spawn directly, so there is no exit event to listen for — only the
 * table to ask.
 *
 * @param {number} pid - Process expected to die.
 * @param {number} [timeoutMs] - How long to allow.
 * @returns {Promise<boolean>} Whether it died in time.
 */
async function waitForDeath(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return !alive(pid);
}

/**
 * Assert a promise rejects, and hand back the error for inspection.
 *
 * `assert.rejects` checks the shape but does not return the error, and every
 * rejection in this module carries flags (`tcTimedOut`, `tcAborted`) that the
 * assertions are actually about.
 *
 * @param {Promise<any>} promise - Work expected to fail.
 * @returns {Promise<Error>}
 */
async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected the request to reject, but it resolved');
}

describe('lib/dir-scanner — the healthy round trip', () => {
  test('answers, and reuses ONE child across requests', async () => {
    const scanner = dirScanner.createScanner();
    try {
      const first = await scanner.request('ping');
      const second = await scanner.request('ping');

      assert.equal(typeof first.pid, 'number');
      // The point of a supervised long-lived child: the dashboard polls this
      // route every ten seconds, and forking a node process per poll would be a
      // permanent cost paid to guard a failure almost no install hits.
      assert.equal(second.pid, first.pid, 'consecutive requests should share one child');
      assert.equal(scanner.childPid(), first.pid);
    } finally {
      await scanner.shutdown();
    }
  });

  test('does not fork a child until the first request', () => {
    const scanner = dirScanner.createScanner();
    assert.equal(scanner.childPid(), null);
  });

  test('reads a directory and reports which entries are directories', async () => {
    const dir = scratch('readdir');
    fs.mkdirSync(path.join(dir, 'a-project'));
    fs.writeFileSync(path.join(dir, 'a-file.txt'), 'x');

    const scanner = dirScanner.createScanner();
    try {
      const { entries } = await scanner.request('readdir', { dir });
      const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

      assert.deepEqual(Object.keys(byName).sort(), ['a-file.txt', 'a-project']);
      // Flattened booleans, not Dirent methods: a method does not survive the
      // IPC hop, and a caller reading `entry.isDirectory` on the far side would
      // get `undefined` and silently classify every entry as a file.
      assert.equal(byName['a-project'].isDirectory, true);
      assert.equal(byName['a-file.txt'].isDirectory, false);
      assert.equal(byName['a-file.txt'].isFile, true);
    } finally {
      await scanner.shutdown();
    }
  });
});

describe('lib/dir-scanner — failures that are not hangs', () => {
  test('preserves the error code across the process boundary', async () => {
    const scanner = dirScanner.createScanner();
    try {
      const err = await rejection(
        scanner.request('readdir', { dir: path.join(tmpRoot, 'does-not-exist') })
      );
      // The wizard offers to CREATE a directory on ENOENT. If the condition did
      // not survive IPC as a value, that button would depend on matching prose.
      assert.equal(err.code, 'ENOENT');
      assert.ok(!err.tcTimedOut, 'a missing directory is not an unresponsive one');
    } finally {
      await scanner.shutdown();
    }
  });

  test('refuses an unknown operation instead of hanging on it', async () => {
    const scanner = dirScanner.createScanner();
    try {
      const err = await rejection(scanner.request('rmdir-everything'));
      assert.equal(err.code, 'ENOSYS');
    } finally {
      await scanner.shutdown();
    }
  });

  test('a child that cannot even start fails the request instead of hanging it', async () => {
    const scanner = dirScanner.createScanner({
      childPath: path.join(tmpRoot, 'no-such-child.js'),
      timeoutMs: 4000
    });
    try {
      // A broken install is the realistic cause. The request must come back on
      // the child's exit — well inside the deadline — because a supervisor that
      // let it run the full timeout would report a missing file as an
      // unresponsive directory, and send the operator to grant Full Disk Access
      // for it.
      const started = Date.now();
      const err = await rejection(scanner.request('ping'));
      assert.ok(err.tcAborted, 'a child that never started is not a timed-out path');
      assert.ok(!err.tcTimedOut);
      assert.ok(Date.now() - started < 3000, 'should fail on exit, not on the deadline');
    } finally {
      await scanner.shutdown();
    }
  });

  test('a child that dies is replaced on the next request', async () => {
    const scanner = dirScanner.createScanner({ childPath: HANG_CHILD });
    try {
      const before = await scanner.request('ping');
      await rejection(scanner.request('crash'));

      const after = await scanner.request('ping');
      // A supervisor that gave up once would turn a single crash into a
      // permanently broken route.
      assert.notEqual(after.pid, before.pid, 'a replacement child should have been forked');
      assert.ok(!alive(before.pid), 'the crashed child should be gone');
    } finally {
      await scanner.shutdown();
    }
  });
});

describe('lib/dir-scanner — the deadline kills, it does not merely give up', () => {
  test('a request that never answers rejects as timed out AND kills the child', async () => {
    const fifoDir = scratch('deadline');
    const fifo = path.join(fifoDir, 'pipe');
    execFileSync('mkfifo', [fifo]);

    const scanner = dirScanner.createScanner({
      childPath: HANG_CHILD,
      timeoutMs: 300,
      exitGraceMs: 0
    });
    try {
      await scanner.request('ping');
      const pid = scanner.childPid();
      assert.ok(pid, 'a child should be running before the hang');

      const err = await rejection(scanner.request('hang', { fifo }, { what: `reading ${fifo}` }));

      // `tcTimedOut` is what earns the Full Disk Access hint. It belongs to the
      // request whose own deadline expired and to nothing else.
      assert.ok(err.tcTimedOut, 'the hung request should be reported as unresponsive');
      assert.match(err.message, /reading /);

      // The whole reason this module exists. Abandoning the promise would leave
      // the blocked thread in place; only the death of the process that owns it
      // returns the resource.
      assert.ok(await waitForDeath(pid), 'the hung child should have been killed');
      assert.equal(scanner.childPid(), null);
    } finally {
      await scanner.shutdown();
    }
  });

  test('collateral requests are abandoned, NOT reported as timed out', async () => {
    const fifoDir = scratch('collateral');
    const slow = path.join(fifoDir, 'slow');
    const healthy = path.join(fifoDir, 'healthy');
    execFileSync('mkfifo', [slow]);
    execFileSync('mkfifo', [healthy]);

    const scanner = dirScanner.createScanner({
      childPath: HANG_CHILD,
      timeoutMs: 400,
      exitGraceMs: 0
    });
    try {
      // Both hang, but the first one's deadline expires first, and its kill is
      // what ends the second.
      const first = scanner.request('hang', { fifo: slow }, { timeoutMs: 300 });
      const second = scanner.request('hang', { fifo: healthy }, { timeoutMs: 5000 });

      const firstErr = await rejection(first);
      const secondErr = await rejection(second);

      assert.ok(firstErr.tcTimedOut, 'the request that owned the deadline timed out');
      // This distinction is the point. The second request's path may be
      // perfectly healthy — it died because a sibling forced a kill. Calling it
      // timed out would resurrect exactly the misdiagnosis this change removes:
      // the operator sent to grant Full Disk Access for a directory that was
      // never protected.
      assert.ok(secondErr.tcAborted, 'collateral work should be reported as abandoned');
      assert.ok(!secondErr.tcTimedOut, 'collateral work must NOT claim the path was unresponsive');
    } finally {
      await scanner.shutdown();
    }
  });

  test('a kill does not take the NEXT request down with it', async () => {
    const fifoDir = scratch('successor');
    const fifo = path.join(fifoDir, 'pipe');
    execFileSync('mkfifo', [fifo]);

    const scanner = dirScanner.createScanner({
      childPath: HANG_CHILD,
      timeoutMs: 300,
      exitGraceMs: 0
    });
    try {
      await rejection(scanner.request('hang', { fifo }));

      // The killed child's `exit` event lands while this request is still in
      // flight on its replacement — forking a node process takes longer than
      // reaping a SIGKILLed one. A supervisor that failed everything pending on
      // any child's exit, rather than only the current child's, would reject
      // this healthy request and read as a flaky scanner.
      const reply = await scanner.request('ping');
      assert.equal(typeof reply.pid, 'number');
    } finally {
      await scanner.shutdown();
    }
  });

  test('shutdown kills the child and refuses further work', async () => {
    const scanner = dirScanner.createScanner();
    await scanner.request('ping');
    const pid = scanner.childPid();

    await scanner.shutdown();

    assert.ok(await waitForDeath(pid), 'shutdown should leave no child behind');
    assert.equal(scanner.childPid(), null);
    const err = await rejection(scanner.request('ping'));
    assert.ok(err.tcAborted);
  });
});

describe('lib/dir-scanner — the threadpool leak (#883)', () => {
  /**
   * Run the pool demo in one mode and read its verdict.
   *
   * SIGKILLed rather than awaited: in `leak` mode the demo has destroyed its own
   * threadpool by design, and a process with threads blocked in the kernel does
   * not finish exiting — `process.exit(0)` returns to a runtime that cannot
   * tear libuv down. Measured, not assumed; it is the same property that makes
   * the bug permanent in the server.
   *
   * @param {string} mode - `leak` or `scanner`.
   * @param {string} fifoDir - Scratch directory for the FIFOs.
   * @returns {Promise<{mode: string, rejections: number, readdirMs: number|null, readdirStuck: boolean}>}
   */
  function runDemo(mode, fifoDir) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [POOL_DEMO, mode, fifoDir],
        // A deliberately tiny pool, so the cliff is crossed in three calls
        // rather than five and the test stays fast. The demo reads the size
        // from here rather than hard-coding one.
        { env: { ...process.env, UV_THREADPOOL_SIZE: '2' }, timeout: 30000 },
        () => {}
      );

      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
        const line = out.split('\n').find((l) => l.trim().startsWith('{'));
        if (!line) return;
        child.kill('SIGKILL');
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      });
      child.on('error', reject);
      child.on('exit', () => {
        if (!out.includes('{')) reject(new Error(`demo produced no verdict: ${out}`));
      });
    });
  }

  test('the shipped in-process deadline DOES exhaust the pool — the defect, reproduced', async () => {
    const verdict = await runDemo('leak', path.join(tmpRoot, 'demo-leak'));

    // Every call rejected on time. That is exactly what made this invisible:
    // `_withTimeout` did its job, the request was answered, and the resource was
    // gone anyway.
    assert.equal(verdict.rejections, 3, 'all three bounded calls should have rejected on time');

    // And yet an ordinary directory read, on a path that has nothing to do with
    // the blocked ones, never completes again for the life of the process. This
    // is the assertion that must fail if the leak is ever really fixed
    // in-process; it passes today because abandoning a promise does not cancel
    // a syscall.
    assert.equal(verdict.readdirStuck, true,
      'an unrelated readdir should be permanently stuck once the pool is gone');
  });

  test('the same workload through the scanner leaves this process untouched', async () => {
    const verdict = await runDemo('scanner', path.join(tmpRoot, 'demo-scanner'));

    assert.equal(verdict.rejections, 3, 'all three hung scans should have been reported');
    assert.equal(verdict.readdirStuck, false,
      'the parent threadpool should survive more hung scans than it has threads');
    assert.ok(verdict.readdirMs < 1000,
      `an ordinary readdir should still be prompt, took ${verdict.readdirMs}ms`);
  });
});

describe('lib/dir-scanner-child — serialisation helpers', () => {
  test('_plainDirent flattens the methods IPC would drop', () => {
    const dir = scratch('dirent');
    fs.mkdirSync(path.join(dir, 'sub'));
    const [entry] = fs.readdirSync(dir, { withFileTypes: true });

    assert.deepEqual(_plainDirent(entry), {
      name: 'sub', isDirectory: true, isFile: false, isSymbolicLink: false
    });
  });

  test('_plainError keeps the code, which callers branch on', () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
    assert.deepEqual(_plainError(err), { message: 'nope', code: 'ENOENT' });
  });

  test('_plainError survives something that is not an Error', () => {
    assert.deepEqual(_plainError('just a string'), { message: 'just a string', code: undefined });
  });
});
