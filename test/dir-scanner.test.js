'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const dirScanner = require('../lib/dir-scanner');
const { _plainError } = require('../lib/dir-scanner-child');

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

  test('carries tcTruncated across the REAL hop, not just in principle', async () => {
    // The one protocol field with no end-to-end coverage: both sides agreed by
    // inspection, and the parent-side test synthesises the flag. Delete the
    // rehydrate line for it and every other test stays green while the wizard
    // silently loses its distinct "big folder, slow disk" sentence and starts
    // telling operators to grant Full Disk Access instead.
    const dir = scratch('truncate-hop');
    for (let i = 0; i < 40; i++) fs.mkdirSync(path.join(dir, `proj-${i}`));

    const scanner = dirScanner.createScanner();
    try {
      // A budget of 0 makes the walk give up at its first entry check, which is
      // the truncation path, without depending on how fast the machine is.
      const err = await rejection(
        scanner.request('scanEntries', { dir, budgetMs: 0 }, { timeoutMs: 10000 })
      );
      assert.equal(err.tcTruncated, true, 'the flag must survive the process boundary');
      assert.ok(!err.tcTimedOut, 'a walk that was being answered is not an unresponsive path');
      assert.match(err.message, /checked \d+ of 40 subdirectories/);
    } finally {
      await scanner.shutdown();
    }
  });

  test('carries a real walk result back across the process boundary', async () => {
    const dir = scratch('walk');
    fs.mkdirSync(path.join(dir, 'a-project'));
    fs.writeFileSync(path.join(dir, 'a-file.txt'), 'x');

    const scanner = dirScanner.createScanner();
    try {
      const { unregistered, truncated } = await scanner.request(
        'listUnregistered', { dir, skipNames: [], budgetMs: 4000 }
      );

      // The walk's own behavior is pinned in test/dir-scanner-child.test.js.
      // What THIS asserts is that a structured result survives the hop intact —
      // the file excluded, the directory kept, the fields populated.
      assert.deepEqual(unregistered.map(u => u.name), ['a-project']);
      assert.equal(truncated, false);
      assert.equal(unregistered[0].path, path.join(dir, 'a-project'));
      assert.equal(unregistered[0].registered, false);
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
        scanner.request('scanEntries',
          { dir: path.join(tmpRoot, 'does-not-exist'), budgetMs: 4000 })
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

  test('a child that closed its channel is written off, not forked past', async () => {
    const { EventEmitter } = require('node:events');
    const made = [];
    const forkFn = () => {
      const fake = new EventEmitter();
      fake.pid = 900000 + made.length;
      fake.connected = true;
      fake.channel = null;
      fake.stderr = null;
      fake.exitCode = null;
      fake.signalCode = null;
      fake.killed = false;
      fake.unref = () => {};
      fake.kill = () => { fake.killed = true; };
      fake.send = () => true; // accepts the request and never answers it
      made.push(fake);
      return fake;
    };

    const scanner = dirScanner.createScanner({ forkFn, timeoutMs: 5000, exitGraceMs: 0 });
    try {
      const stranded = scanner.request('ping');

      // Node does not guarantee `exit` precedes the channel close. This is the
      // window: the child is unusable, but nothing has announced its death.
      made[0].connected = false;

      const successor = scanner.request('ping');
      successor.catch(() => {}); // never answered either; shutdown settles it

      const started = Date.now();
      const err = await rejection(stranded);

      // Left to the old behavior this request waited out its full deadline and
      // was then labelled `tcTimedOut` — the Full Disk Access misdiagnosis this
      // module exists to remove, on a path that was never even read.
      assert.ok(err.tcAborted, 'stranded work should be abandoned, not timed out');
      assert.ok(!err.tcTimedOut, 'a closed channel is not an unresponsive directory');
      assert.ok(Date.now() - started < 3000, 'should fail immediately, not on the deadline');

      // And the orphan must actually be killed: leaving it alive leaves the
      // blocked thread this whole module exists to reclaim.
      assert.ok(made[0].killed, 'the superseded child should have been killed');
      assert.equal(made.length, 2, 'a replacement should have been forked');
    } finally {
      await scanner.shutdown();
    }
  });

  test('a fork that emits an error fails the request rather than hanging it', async () => {
    const { EventEmitter } = require('node:events');

    // A fork can fail without ever producing a process — EMFILE, a spawn the OS
    // refuses. The supervisor only learns via the `error` event, and if it did
    // not translate that into a rejection the caller would wait out the full
    // deadline and then be told the DIRECTORY was unresponsive.
    const forkFn = () => {
      const fake = new EventEmitter();
      fake.pid = undefined;
      fake.connected = true;
      fake.channel = null;
      fake.stderr = null;
      fake.exitCode = null;
      fake.signalCode = null;
      fake.unref = () => {};
      fake.kill = () => {};
      fake.send = () => true;
      setImmediate(() => fake.emit('error', new Error('spawn EMFILE')));
      return fake;
    };

    const scanner = dirScanner.createScanner({ forkFn, timeoutMs: 4000 });
    try {
      const started = Date.now();
      const err = await rejection(scanner.request('ping'));
      assert.ok(err.tcAborted, 'a fork that failed is not an unresponsive path');
      assert.ok(!err.tcTimedOut);
      assert.ok(Date.now() - started < 3000, 'should fail on the error event, not the deadline');
    } finally {
      await scanner.shutdown();
    }
  });

  test('a request whose send fails is rejected, not left outstanding', async () => {
    const { EventEmitter } = require('node:events');

    const forkFn = () => {
      const fake = new EventEmitter();
      fake.pid = 424242;
      fake.connected = true;
      fake.channel = null;
      fake.stderr = null;
      fake.exitCode = null;
      fake.signalCode = null;
      fake.unref = () => {};
      fake.kill = () => {};
      // The channel closed between the liveness check and the write.
      fake.send = (_msg, cb) => { setImmediate(() => cb(new Error('channel closed'))); return false; };
      return fake;
    };

    const scanner = dirScanner.createScanner({ forkFn, timeoutMs: 4000 });
    try {
      const err = await rejection(scanner.request('ping'));
      assert.ok(err.tcAborted);
      assert.match(err.message, /could not be reached/);
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

  test('an idle scanner does not hold the process open', async () => {
    // Every stdio handle has to be unref'd, not just the child and the IPC
    // channel: a piped stderr is a socket, and a socket with a `data` listener
    // keeps the event loop alive by itself. When that was missed, every process
    // that forked a scanner and did not explicitly shut it down simply never
    // exited — the work finished, the assertions passed, and the runner hung
    // afterwards with nothing failing to point at. A whole test file was lost to
    // it before the cause was found, which is why this is pinned in a real
    // process rather than by inspecting handles.
    const script = `
      const s = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'dir-scanner'))});
      s.request('ping').then(() => {});
    `;
    const exited = await new Promise((resolve) => {
      const child = execFile(process.execPath, ['-e', script], { timeout: 15000 },
        (err) => resolve(!err));
      child.on('error', () => resolve(false));
    });
    assert.ok(exited, 'a process that used the scanner and never shut it down must still exit');
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

describe('lib/dir-scanner — the failure backoff (#883 chunk 3)', () => {
  /**
   * A fork stand-in whose children answer according to a script.
   *
   * Real children are not usable here: the questions are about how MANY child
   * processes a sequence of requests costs, and about time, and a real fork adds
   * tens of milliseconds of noise to both. Each script entry is `'hang'` (never
   * reply — the case the backoff exists for), `{ok: value}`, or `{err: {...}}`;
   * the script is consumed per child, and it repeats its last entry once
   * exhausted so a test only has to state the part it cares about.
   *
   * @param {Array<'hang'|{ok?: any, err?: object}>} script - Behavior per child.
   * @returns {Function} A `forkFn`, carrying `.made` — the children it created.
   */
  function scriptedForkFn(script) {
    const made = [];
    const fn = () => {
      const index = made.length;
      const fake = new (require('node:events').EventEmitter)();
      fake.pid = 700000 + index;
      fake.connected = true;
      fake.channel = null;
      fake.stderr = null;
      fake.exitCode = null;
      fake.signalCode = null;
      fake.unref = () => {};
      fake.kill = () => { fake.connected = false; };
      fake.send = (msg) => {
        const step = script[Math.min(index, script.length - 1)];
        if (step === 'hang') return true;
        setImmediate(() => fake.emit('message', step.err
          ? { id: msg.id, ok: false, error: step.err }
          : { id: msg.id, ok: true, value: step.ok }));
        return true;
      };
      made.push(fake);
      return fake;
    };
    fn.made = made;
    return fn;
  }

  /**
   * A scanner wired for fast, deterministic backoff tests.
   * @param {Function} forkFn - From scriptedForkFn.
   * @param {object} [over] - Option overrides.
   * @returns {object} The scanner.
   */
  function backoffScanner(forkFn, over = {}) {
    return dirScanner.createScanner({
      forkFn, timeoutMs: 60, exitGraceMs: 0,
      pathFailureTtlMs: 200, pathFailureMaxTtlMs: 800, ...over
    });
  }

  const KEY = '/some/protected/dir';

  test('a path that did not answer is refused without costing another process', async () => {
    const forkFn = scriptedForkFn(['hang']);
    const scanner = backoffScanner(forkFn);
    try {
      const first = await rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));
      assert.ok(first.tcTimedOut);
      assert.ok(!first.tcCached, 'the first failure is observed, not remembered');
      assert.equal(forkFn.made.length, 1);

      const started = Date.now();
      const second = await rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));

      // The whole point: no second child, and no five-second wait to find out.
      assert.equal(forkFn.made.length, 1, 'a known-bad path must not cost another process');
      assert.ok(Date.now() - started < 40, 'and must be refused promptly, not on the deadline');

      // The CONDITION is unchanged, so the operator still gets the Full Disk
      // Access remedy — `_scanFailureHint` keys on exactly this flag.
      assert.ok(second.tcTimedOut, 'a remembered refusal is still an unresponsive path');
      assert.ok(second.tcCached, 'but callers must be able to tell it cost nothing');
    } finally {
      await scanner.shutdown();
    }
  });

  test('exactly one real attempt per backoff interval, however often it is asked', async () => {
    const forkFn = scriptedForkFn(['hang']);
    const scanner = backoffScanner(forkFn, { pathFailureTtlMs: 250 });
    try {
      for (let i = 0; i < 6; i++) {
        await rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));
      }
      assert.equal(forkFn.made.length, 1, 'six requests inside one interval is one attempt');

      await new Promise((r) => setTimeout(r, 300));
      await rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));
      assert.equal(forkFn.made.length, 2, 'and one more once the interval has passed');
    } finally {
      await scanner.shutdown();
    }
  });

  test('concurrent requests during the retry do not each become a retry', async () => {
    // The interval is shorter than the deadline here on purpose. A probe that is
    // still outstanding when the next poll arrives would let a second process be
    // forked if the door were only pushed shut after the probe returned.
    const forkFn = scriptedForkFn(['hang']);
    const scanner = backoffScanner(forkFn, { timeoutMs: 300, pathFailureTtlMs: 100 });
    try {
      await rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));
      assert.equal(forkFn.made.length, 1);

      await new Promise((r) => setTimeout(r, 150));
      const probe = rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));
      await new Promise((r) => setTimeout(r, 30));
      const overlapping = await rejection(
        scanner.request('listUnregistered', {}, { pathKey: KEY })
      );

      assert.ok(overlapping.tcCached, 'the overlapping request must be served from memory');
      assert.equal(forkFn.made.length, 2, 'the in-flight probe is the only new process');
      await probe;
    } finally {
      await scanner.shutdown();
    }
  });

  test('a directory that starts working recovers with no restart', async () => {
    // The first child hangs; the second answers. Nothing intervenes — no
    // operator action inside the product, no process restart.
    const forkFn = scriptedForkFn(['hang', { ok: { unregistered: [], truncated: false } }]);
    const scanner = backoffScanner(forkFn, { pathFailureTtlMs: 120 });
    try {
      await rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));
      await new Promise((r) => setTimeout(r, 160));

      const recovered = await scanner.request('listUnregistered', {}, { pathKey: KEY });
      assert.deepEqual(recovered, { unregistered: [], truncated: false });

      // And the memory of the failure is gone, not merely expired: the very next
      // request goes straight through rather than waiting out another interval.
      const after = await scanner.request('listUnregistered', {}, { pathKey: KEY });
      assert.deepEqual(after, { unregistered: [], truncated: false });
    } finally {
      await scanner.shutdown();
    }
  });

  test('an ordinary error clears the memory too — the path ANSWERED', async () => {
    // ENOENT is not a hang, it is a reply. Caching it would break the wizard
    // outright: its Create button turns ENOENT into a directory, and the scan
    // immediately afterwards has to see the folder that was just made.
    const forkFn = scriptedForkFn(['hang', { err: { message: 'nope', code: 'ENOENT' } }]);
    const scanner = backoffScanner(forkFn, { pathFailureTtlMs: 120 });
    try {
      await rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));
      await new Promise((r) => setTimeout(r, 160));

      const answered = await rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));
      assert.equal(answered.code, 'ENOENT');

      const next = await rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));
      // Reaching the child is what matters, and these two prove it: a remembered
      // refusal would carry `tcTimedOut` and `tcCached`, never an errno.
      assert.equal(next.code, 'ENOENT', 'not a remembered timeout');
      assert.ok(!next.tcCached, 'a path that replies is not a path being backed off');

      // Two children, not three — and that is correct rather than a miss. Only
      // the hung one was killed; the one that answered ENOENT is healthy, so the
      // third request reuses it. That reuse is the long-lived child doing its
      // job, and counting forks here would punish it.
      assert.equal(forkFn.made.length, 2);
    } finally {
      await scanner.shutdown();
    }
  });

  test('collateral does NOT mark a path as bad', async () => {
    // The killed request's path may be perfectly healthy — it died because a
    // SIBLING forced a kill. Recording that would let one bad directory blame a
    // good one, which is the misdiagnosis this whole issue exists to remove.
    const forkFn = scriptedForkFn(['hang']);
    const scanner = backoffScanner(forkFn, { timeoutMs: 5000 });
    try {
      const doomed = rejection(scanner.request('a', {}, { pathKey: '/bad', timeoutMs: 60 }));
      const bystander = rejection(scanner.request('b', {}, { pathKey: '/healthy' }));

      assert.ok((await doomed).tcTimedOut);
      const collateral = await bystander;
      assert.ok(collateral.tcAborted, 'and it is reported as collateral, not as a timeout');

      // The bystander's path must be untouched: the next request for it is a
      // real attempt, not a remembered refusal.
      const forksBefore = forkFn.made.length;
      const retry = await rejection(
        scanner.request('b', {}, { pathKey: '/healthy', timeoutMs: 60 })
      );
      assert.ok(!retry.tcCached, '/healthy must not have been marked bad by /bad\'s kill');
      assert.ok(forkFn.made.length > forksBefore, 'it must really have been tried');
    } finally {
      await scanner.shutdown();
    }
  });

  test('collateral does not ERASE an existing backoff either', async () => {
    // The other direction of the same rule, and the one that actually costs
    // something. A probe for an already-bad path can be killed by an unrelated
    // path's deadline; if that abort were read as "this path is fine now", the
    // backoff would be dropped and the next poll would fork again — the rate
    // bound quietly gone, with nothing failing to show it.
    const forkFn = scriptedForkFn(['hang']);
    const scanner = backoffScanner(forkFn, { pathFailureTtlMs: 200 });
    try {
      await rejection(scanner.request('b', {}, { pathKey: '/b', timeoutMs: 60 }));
      await new Promise((r) => setTimeout(r, 250));

      // /b's retry goes out, then /a's deadline kills the child under it.
      const probe = rejection(scanner.request('b', {}, { pathKey: '/b', timeoutMs: 5000 }));
      const doomed = rejection(scanner.request('a', {}, { pathKey: '/a', timeoutMs: 60 }));
      assert.ok((await doomed).tcTimedOut);
      assert.ok((await probe).tcAborted, 'the retry must have died as collateral');

      const after = await rejection(scanner.request('b', {}, { pathKey: '/b' }));
      assert.ok(after.tcCached,
        '/b must still be backed off — an abort is not evidence that it recovered');
    } finally {
      await scanner.shutdown();
    }
  });

  test('the backoff escalates, and the escalation is visible', async () => {
    const forkFn = scriptedForkFn(['hang']);
    const scanner = backoffScanner(forkFn, { pathFailureTtlMs: 100, pathFailureMaxTtlMs: 100 });
    try {
      await rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));
      const firstRefusal = await rejection(
        scanner.request('listUnregistered', {}, { pathKey: KEY })
      );
      assert.match(firstRefusal.message, /the last 1 time\(s\)/);

      await new Promise((r) => setTimeout(r, 140));
      await rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));
      const secondRefusal = await rejection(
        scanner.request('listUnregistered', {}, { pathKey: KEY })
      );
      // The count rises, which is what makes a persistent failure legible in the
      // log as a trend rather than as a repeated incident.
      assert.match(secondRefusal.message, /the last 2 time\(s\)/);

      // Capped: with max == ttl, the third interval is still ~100ms rather than
      // having doubled to 400. Without a ceiling, a directory fixed after a few
      // failures would stay unnoticed for an unbounded time.
      await new Promise((r) => setTimeout(r, 140));
      const forksBefore = forkFn.made.length;
      await rejection(scanner.request('listUnregistered', {}, { pathKey: KEY }));
      assert.ok(forkFn.made.length > forksBefore,
        'the backoff must not have grown past its ceiling');
    } finally {
      await scanner.shutdown();
    }
  });

  test('without a pathKey nothing is remembered — the backoff is opt-in', async () => {
    // A generic supervisor silently declining to do what it was asked would be a
    // bad surprise. Only a caller that says "a repeat of this is not worth a
    // second process" gets short-circuited.
    const forkFn = scriptedForkFn(['hang']);
    const scanner = backoffScanner(forkFn);
    try {
      await rejection(scanner.request('listUnregistered', { dir: KEY }));
      await rejection(scanner.request('listUnregistered', { dir: KEY }));
      assert.equal(forkFn.made.length, 2, 'both were really attempted');
    } finally {
      await scanner.shutdown();
    }
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
   * @returns {Promise<{mode: string, rejections: number, baselineMs: number, baselineMaxMs: number, baselineSamples: number, budgetMs: number, readdirMs: number|null, readdirStuck: boolean}>}
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

  test('the in-process deadline that shipped before this branch DOES exhaust the pool', async () => {
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

  // Headroom for the after-probe over the WORST readdir the demo observed
  // while its workload ran. The scanner is answerable for the delta, not for
  // the machine's speed (#957): the baseline is sampled across the workload
  // so it has the same exposure to a bursty stall as the after-probe. The
  // floor keeps a sub-millisecond baseline from turning ordinary jitter into a
  // failure; the multiplier is generous because the leak this guards is not a
  // slowdown but a readdir that never returns, which `readdirStuck` catches.
  const AFTER_PROBE_FLOOR_MS = 1000;
  const AFTER_PROBE_HEADROOM = 10;

  test('the same workload through the scanner leaves this process untouched', async () => {
    const verdict = await runDemo('scanner', path.join(tmpRoot, 'demo-scanner'));

    assert.equal(verdict.rejections, 3, 'all three hung scans should have been reported');
    const detail = `baseline median ${verdict.baselineMs}ms, worst ${verdict.baselineMaxMs}ms over `
      + `${verdict.baselineSamples} in-workload samples, stuck budget ${verdict.budgetMs}ms`;
    assert.equal(verdict.readdirStuck, false,
      `the parent threadpool should survive more hung scans than it has threads (${detail})`);
    // The demo measured the machine while the workload ran. That is what the
    // after-probe is judged against — and it must be a number in its own
    // right, so this assertion stands without the one above it.
    assert.equal(typeof verdict.baselineMaxMs, 'number', 'the demo must report the baseline it measured');
    assert.ok(verdict.baselineSamples > 0, 'the baseline must rest on at least one sample');
    assert.equal(typeof verdict.readdirMs, 'number', `the after-probe must have completed (${detail})`);
    const bound = Math.max(AFTER_PROBE_FLOOR_MS, verdict.baselineMaxMs * AFTER_PROBE_HEADROOM);
    assert.ok(verdict.readdirMs <= bound,
      `an ordinary readdir should still be about as prompt as the machine was during the workload: `
      + `took ${verdict.readdirMs}ms against a bound of ${bound}ms (${detail})`);
  });
});

describe('lib/dir-scanner-child — serialisation helpers', () => {
  // `_plainDirent` used to be tested here. It went with the `readdir` op in
  // chunk 2 — no handler returns a `Dirent` any more, the walks consume them
  // inside the child — and a unit test kept giving a dead function the look of a
  // covered contract while `boundary-patterns.md` still listed it as a
  // load-bearing property of the IPC surface. The property it described is real
  // and still holds; it is now stated as "only plain data crosses" and enforced
  // by the round-trip tests above, which assert real walk results arriving
  // intact rather than a helper nothing calls.

  test('_plainError keeps the code, which callers branch on', () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
    assert.deepEqual(_plainError(err),
      { message: 'nope', code: 'ENOENT', tcTruncated: undefined });
  });

  test('_plainError carries tcTruncated but never lets the child claim tcTimedOut', () => {
    // The distinction is the difference between "your folder is big and your
    // disk is slow" and "grant Full Disk Access". A walk that ran out of budget
    // may say the first; only the supervisor's own deadline may say the second,
    // so a child that sets `tcTimedOut` must not be believed.
    const truncated = Object.assign(new Error('gave up'), { tcTruncated: true });
    assert.equal(_plainError(truncated).tcTruncated, true);

    const impostor = Object.assign(new Error('not yours to declare'), { tcTimedOut: true });
    assert.equal(_plainError(impostor).tcTimedOut, undefined,
      'only the supervisor may declare a path unresponsive');
  });

  test('_plainError survives something that is not an Error', () => {
    assert.deepEqual(_plainError('just a string'),
      { message: 'just a string', code: undefined, tcTruncated: undefined });
  });
});

describe('dir-scanner — the child\'s diagnostics reach the server\'s log (#884)', () => {
  const { setConsoleStream, setLevel, getLevel } = require('../lib/logger');
  const STDERR_CHILD = path.join(__dirname, '_dir-scanner-stderr-child.js');

  /**
   * Run `fn` with the logger's output captured, at the given level.
   *
   * The logger writes to a pinned stream when one is set, which is the only
   * seam that observes what an operator would actually see — asserting on the
   * child's stderr instead would re-test the half `dir-scanner-child.test.js`
   * already covers and miss the supervisor entirely.
   *
   * @param {string} level - Level to run at, restored afterwards.
   * @param {Function} fn - Async body.
   * @returns {Promise<string>} Everything the logger wrote.
   */
  async function captured(level, fn) {
    let out = '';
    const previous = getLevel();
    setConsoleStream({ write: (s) => { out += s; } });
    setLevel(level);
    try {
      await fn();
    } finally {
      setLevel(previous);
      setConsoleStream(null);
    }
    return out;
  }

  test('re-emits complete lines, joining one the pipe split in half', async () => {
    // THE MUTATION THIS CATCHES: deleting the supervisor's re-emission loop.
    // The child-side guard passes without it — the warning still leaves the
    // child — while reproducing exactly the defect that loop exists to fix: a
    // warning that reaches no sink an operator reads. That gap is why this
    // test is at the supervisor level and reads the LOG, not the pipe.
    const scanner = dirScanner.createScanner({ childPath: STDERR_CHILD, timeoutMs: 8000 });
    try {
      const out = await captured('debug', () => scanner.request('talk', {}, { what: 'talking' }));

      assert.match(out, /cache write failed/, 'a child warning must reach the server log');
      assert.match(out, /split across two chunks/,
        'a line the pipe split must be joined before it is emitted, not emitted as halves');
      assert.ok(!/split $/m.test(out), 'and the first half must never be emitted on its own');
      assert.match(out, /Something the runtime printed by itself/,
        'output in no known format is the crash detail worth keeping — it must not be dropped');
    } finally {
      await scanner.shutdown();
    }
  });

  test('preserves the child\'s level, so `logLevel: warn` does not drop its warnings', async () => {
    // THE MUTATION THIS CATCHES: re-emitting everything at `log.info`. That
    // reads as harmless — the lines are all there at the default level — and
    // silently reinstates the whole defect for anyone running the server at
    // `warn`, which is a supported setting. The failure is invisible until you
    // change a config nobody thinks to test.
    const scanner = dirScanner.createScanner({ childPath: STDERR_CHILD, timeoutMs: 8000 });
    try {
      const out = await captured('warn', () => scanner.request('talk', {}, { what: 'talking' }));

      assert.match(out, /cache write failed/,
        'a WARN from the child must survive a server running at warn');
      assert.ok(!/routine detail/.test(out),
        'and its DEBUG must not — the level is read from the line, not assumed');
    } finally {
      await scanner.shutdown();
    }
  });

  test('the death buffer keeps what the child said LAST, not what it said first', async () => {
    // THE MUTATION THIS CATCHES: `.slice(-4096)` back to `.slice(0, 4096)` — the
    // head-bounded form this replaced. It passes every other test in the suite,
    // because nothing else drives a nonzero exit, and it reinstates exactly what
    // the inversion was for: this stream now carries routine child warnings as
    // well as crash output, so a head-bounded buffer fills up with healthy
    // notices during a long life and has no room left for the output that
    // explains the death. The operator then reads `Scanner child exited
    // unexpectedly` with `versionFilePath` chatter attached and nothing about
    // the exit.
    //
    // Asserted on the LOG LINE the operator actually sees, for the same reason
    // the tests above are: `detail.stderr` has no other observer.
    const scanner = dirScanner.createScanner({ childPath: STDERR_CHILD, timeoutMs: 8000 });
    try {
      const out = await captured('warn', async () => {
        // The request is expected to fail — the child exits mid-flight, by design.
        await scanner.request('flood-then-die', {}, { what: 'flooding' }).catch(() => {});
        // The `exit` event and its log line race the rejection.
        await new Promise((r) => setTimeout(r, 300));
      });

      // NOT `split('\n').find(...)`: the attached `stderr` detail is itself
      // multi-line, so splitting on newlines returns the entry's first physical
      // line and silently discards the very thing under test. The entry runs
      // from its header to the end of the capture.
      const at = out.indexOf('exited unexpectedly');
      const exitLine = at === -1 ? null : out.slice(at);
      assert.ok(exitLine, 'an unexpected exit must be logged with whatever the child managed to say');
      assert.ok(/filler-0[45]\d/.test(exitLine),
        'the death detail must carry the LATE output, which is what explains the exit');
      assert.ok(!/filler-00\d/.test(exitLine),
        'and must have dropped the oldest chatter — a head-bounded buffer keeps exactly this '
        + 'and discards the end instead');
    } finally {
      await scanner.shutdown();
    }
  });
});
