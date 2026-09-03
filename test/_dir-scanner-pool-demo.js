'use strict';

/**
 * Demonstrate, in a throwaway process, what abandoning a blocked filesystem call
 * costs — and that routing the same work through the scanner costs nothing.
 *
 * WHY THIS IS A SEPARATE PROCESS. The `leak` mode deliberately destroys its own
 * libuv threadpool. A process that has done that cannot perform another async
 * filesystem call for as long as it lives, so running it inside the test process
 * would take every later test in the file down with it. The damage has to be
 * contained by exiting.
 *
 * WHY THE LEAKING HELPER LIVES HERE NOW. `leak` mode used to call
 * `projects._withTimeout`, the real shipped helper, so the demonstration could not
 * be dismissed as a strawman. Chunk 2 moved every operator-path read into the
 * scanner child and that helper became dead code, so keeping it in `lib/` purely
 * to be a fixture would misrepresent the product to anyone reading it. It is
 * reproduced below instead, verbatim — `git log -S_withTimeout -- lib/projects.js`
 * shows the original, and `4b44b2e^` is the last commit where the product used it.
 *
 * Usage: node _dir-scanner-pool-demo.js <leak|scanner> <fifoDir>
 * Prints one line of JSON:
 *   {"mode":…,"rejections":N,"baselineMs":N,"readdirMs":N|null,"readdirStuck":bool}
 *
 * `baselineMs` is the same ordinary readdir timed BEFORE the workload, in the
 * same process, under whatever load the machine is carrying right now. The
 * after-probe is judged against it rather than against a fixed number of
 * milliseconds: an absolute bound measured the OS scheduler and every other
 * process on the box, and failed on exactly the runs where a developer was
 * doing something else at the same time (#957). What the scanner is
 * responsible for is the DELTA — a healthy pool answers the after-probe about
 * as fast as it answered the before-probe; a wounded one does not.
 *
 * `UV_THREADPOOL_SIZE` is expected to be set small by the caller; the number of
 * blocking calls issued is read from it, so the demo scales with the pool rather
 * than hard-coding a size that a future runtime could change underneath it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs').promises;
const { execFileSync } = require('node:child_process');

const MODE = process.argv[2];
const FIFO_DIR = process.argv[3];

// One more blocking call than the pool has threads: the point of the exercise is
// to cross the cliff, not to approach it.
const POOL_SIZE = Number(process.env.UV_THREADPOOL_SIZE) || 4;
const HUNG_CALLS = POOL_SIZE + 1;

// Long enough that a healthy call would obviously have finished, short enough
// that the demo is not the slowest thing in the suite.
const DEADLINE_MS = 300;

// The floor on how long an ordinary readdir is given before it is declared
// stuck. Timers do not use the threadpool, so this still fires with the pool
// destroyed — which is the whole reason the stuck case is observable at all.
// The actual budget scales with the measured baseline (see `probeBudgetMs`) so
// a loaded machine, where even a healthy readdir is slow, does not read as a
// destroyed pool.
const PROBE_FLOOR_MS = 1500;

// Cap on that scaling. A permanently stuck readdir exceeds any finite budget,
// so a larger one only slows the leak demonstration; this bounds the wait.
const PROBE_CEILING_MS = 10000;

// Headroom multiplier: the after-probe may take this many times the baseline
// before it counts as stuck.
const PROBE_HEADROOM = 30;

// How many baseline samples to take; the median is used so one scheduler
// hiccup does not set the budget.
const BASELINE_SAMPLES = 3;

/**
 * Make a FIFO whose `open` for reading will block, because nothing will ever
 * write to it.
 *
 * @param {number} i - Distinguishes one FIFO from the next.
 * @returns {string} Absolute path to the new FIFO.
 */
function makeFifo(i) {
  const p = path.join(FIFO_DIR, `pipe-${i}`);
  execFileSync('mkfifo', [p]);
  return p;
}

/**
 * Time one ordinary directory read on a path unrelated to the blocked ones.
 *
 * @returns {Promise<number>} Milliseconds taken. Awaited, not bounded: callers
 *   use this only while the pool is known to be healthy.
 */
async function timeOrdinaryReaddir() {
  const started = Date.now();
  await fsp.readdir(os.tmpdir()).then(() => {}, () => {});
  return Date.now() - started;
}

/**
 * Measure how fast this machine answers an ordinary readdir right now, before
 * any workload has touched the pool.
 *
 * @returns {Promise<number>} Median of `BASELINE_SAMPLES` readings, in ms.
 */
async function measureBaseline() {
  const samples = [];
  for (let i = 0; i < BASELINE_SAMPLES; i++) samples.push(await timeOrdinaryReaddir());
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/**
 * How long the after-probe may take before it is declared stuck, given the
 * baseline: `PROBE_HEADROOM` times the baseline, never below the floor, never
 * above the ceiling.
 *
 * @param {number} baselineMs - Output of `measureBaseline`
 * @returns {number} Budget in ms
 */
function probeBudgetMs(baselineMs) {
  return Math.min(PROBE_CEILING_MS, Math.max(PROBE_FLOOR_MS, baselineMs * PROBE_HEADROOM));
}

/**
 * Time an ordinary directory read that has nothing to do with the blocked paths.
 *
 * This is the measurement that matters: whether unrelated filesystem work in
 * THIS process still completes. With the pool exhausted it never will, so the
 * result is bounded rather than awaited.
 *
 * @param {number} budgetMs - How long to wait before declaring it stuck
 * @returns {Promise<{readdirMs: number|null, readdirStuck: boolean}>}
 */
async function probeOrdinaryReaddir(budgetMs) {
  const started = Date.now();
  const outcome = await Promise.race([
    fsp.readdir(os.tmpdir()).then(() => 'ok', () => 'ok'),
    new Promise((res) => setTimeout(() => res('stuck'), budgetMs))
  ]);
  return outcome === 'stuck'
    ? { readdirMs: null, readdirStuck: true }
    : { readdirMs: Date.now() - started, readdirStuck: false };
}

/**
 * The shape that ships today: race a blocking call against a timer and walk away
 * from the loser. The rejection arrives on time; the syscall keeps its thread.
 *
 * @returns {Promise<number>} How many calls rejected as expected.
 */
async function runLeak() {
  let rejections = 0;

  const races = [];
  for (let i = 0; i < HUNG_CALLS; i++) {
    const fifo = makeFifo(i);
    races.push(
      _withTimeoutAsItShipped(fsp.readFile(fifo), DEADLINE_MS, `reading ${fifo}`)
        .then(() => {}, () => { rejections++; })
    );
  }
  await Promise.all(races);
  return rejections;
}

/**
 * `projects._withTimeout` as it shipped before this branch, reproduced verbatim.
 *
 * The rejection carries `tcTimedOut` so a caller could tell "this path is not
 * answering" from an ordinary filesystem error. The underlying operation is NOT
 * cancellable — it keeps occupying its threadpool slot — so this bounds the
 * REQUEST, not the syscall. That limit is the whole of #883, and this function
 * exists so the limit can be demonstrated rather than asserted.
 *
 * @param {Promise<any>} promise - Work to bound.
 * @param {number} ms - Milliseconds to wait.
 * @param {string} what - Short description used in the timeout message.
 * @returns {Promise<any>}
 */
function _withTimeoutAsItShipped(promise, ms, what) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timed out after ${ms}ms ${what}`);
      err.tcTimedOut = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The same workload through the scanner: the blocked threads belong to a child
 * process, and the deadline kills it rather than abandoning it.
 *
 * @returns {Promise<number>} How many requests rejected as expected.
 */
async function runScanner() {
  const dirScanner = require('../lib/dir-scanner');
  const scanner = dirScanner.createScanner({
    childPath: path.join(__dirname, '_dir-scanner-hang-child.js'),
    timeoutMs: DEADLINE_MS,
    exitGraceMs: 0
  });

  let rejections = 0;
  // Sequential on purpose. Concurrent requests would share one child and die
  // together in the first kill, which would prove the collateral rule rather
  // than the one under test — that N separate hangs, each with its own child,
  // still leave this process's threadpool untouched.
  for (let i = 0; i < HUNG_CALLS; i++) {
    const fifo = makeFifo(i);
    try {
      await scanner.request('hang', { fifo }, { what: `reading ${fifo}` });
    } catch {
      rejections++;
    }
  }

  await scanner.shutdown();
  return rejections;
}

(async () => {
  fs.mkdirSync(FIFO_DIR, { recursive: true });
  const baselineMs = await measureBaseline();
  const rejections = MODE === 'leak' ? await runLeak() : await runScanner();
  const probe = await probeOrdinaryReaddir(probeBudgetMs(baselineMs));
  process.stdout.write(JSON.stringify({ mode: MODE, rejections, baselineMs, ...probe }) + '\n');
  // Hard exit: in `leak` mode the abandoned reads still hold their threads, so
  // waiting for a clean drain would wait forever.
  process.exit(0);
})();
