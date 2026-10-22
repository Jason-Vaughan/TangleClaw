'use strict';

/**
 * The Medium tier's guard: loaded with `node --test --require` ahead of every
 * test file in the tier, in the runner's child processes too.
 *
 * A Medium test may open a temp database and an in-process server, but it
 * never starts a subprocess: that is what makes the tier portable across
 * runners and free of the timing flakes tmux and child daemons bring. It
 * refuses the ACT, not the require: a product module may load
 * `child_process` at its top, as `lib/exec.js` does; the moment a test asks
 * it to spawn, the test fails with a message naming the caller, however many
 * product requires down the call sits.
 */

const Module = require('node:module');

/** The `child_process` functions that start a process. */
const SPAWNERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

const guarded = new WeakMap();
const originalLoad = Module._load;

/** The test file this process runs: the runner starts one process per file. */
const TEST_FILE = process.argv[1] || '(unknown file)';

/** How many times this process asked for something the tier forbids. */
let refusals = 0;

// A refusal that product code catches and degrades from leaves every test
// passing, which would make a file Medium for the wrong reason: it passes
// only because the guard said no. So a refusal is a failure of the file,
// swallowed or not, and the runner reports a process that exits non-zero as
// a failed file.
process.on('exit', () => {
  if (refusals > 0) {
    process.stderr.write(`[tier-guard] ${refusals} refusal(s) in ${TEST_FILE}: the file is not medium; declare it large in test/tiers.json\n`);
    process.exitCode = 1;
  }
});

/**
 * The first stack frame outside this file: the code that asked.
 *
 * @returns {string} `path:line`, or `(unknown)`
 */
function caller() {
  const lines = (new Error().stack || '').split('\n').slice(1);
  for (const line of lines) {
    const m = line.match(/\(?([^\s()]+):(\d+):\d+\)?$/);
    if (m && m[1] !== __filename) return `${m[1]}:${m[2]}`;
  }
  return '(unknown)';
}

/**
 * A function that refuses in the tier's words.
 *
 * @param {string} act - What was attempted, e.g. `child_process.spawn`
 * @returns {function(): never}
 */
function refuse(act) {
  return function tierGuardRefusal() {
    const message = `medium tier: ${act} is forbidden here (called from ${caller()} in ${TEST_FILE}); declare the file large in test/tiers.json`;
    // Announced as well as thrown, and counted for the exit handler above:
    // the throw alone can vanish into a product module's catch.
    refusals += 1;
    process.stderr.write(`[tier-guard] ${message}\n`);
    throw new Error(message);
  };
}

/**
 * `child_process` with every spawner replaced by a refusal. One wrapped
 * object per real module, so repeated requires return the same thing.
 *
 * @param {object} mod - The real module
 * @returns {object}
 */
function guardedChildProcess(mod) {
  if (!guarded.has(mod)) {
    const wrapped = { ...mod };
    for (const name of SPAWNERS) wrapped[name] = refuse(`child_process.${name}`);
    guarded.set(mod, wrapped);
  }
  return guarded.get(mod);
}

/**
 * Load every module as node would, handing back a guarded copy of the one
 * that can start a process.
 *
 * @param {string} request - The require argument
 * @returns {any}
 */
Module._load = function tierGuardedLoad(request) {
  const mod = originalLoad.apply(this, arguments);
  if (request === 'child_process' || request === 'node:child_process') return guardedChildProcess(mod);
  return mod;
};
