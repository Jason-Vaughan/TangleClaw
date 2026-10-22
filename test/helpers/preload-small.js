'use strict';

/**
 * The Small tier's guard: loaded with `node --test --require` ahead of every
 * test file in the tier, in the runner's child processes too.
 *
 * A Small test is pure in-process JavaScript: it starts no subprocess, opens
 * no database and listens on no socket. This file makes that a fact rather
 * than a description. It refuses the ACT, not the require: a product module
 * may load `child_process` or `node:sqlite` at its top, as `lib/exec.js` and
 * `lib/store/_db.js` do, and a test that never asks it to spawn or open is
 * still Small. The moment one of those calls happens the test fails with a
 * message naming the caller, so a demotion in `test/tiers.json` cites a
 * reason the ledger can keep.
 *
 * It refuses at the seam, never by reading text: a product module that
 * spawns three requires down is caught the same as a test that spawns
 * directly, which is what the static scan in `scripts/test-tiers.js` cannot
 * see.
 */

const Module = require('node:module');
const net = require('node:net');

/** The `child_process` functions that start a process. */
const SPAWNERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

const guarded = new WeakMap();
const originalLoad = Module._load;

/** The test file this process runs: the runner starts one process per file. */
const TEST_FILE = process.argv[1] || '(unknown file)';

/** How many times this process asked for something the tier forbids. */
let refusals = 0;

// A refusal that product code catches and degrades from (a failed `git` or
// `ps` read as "not available") leaves every test passing, which would make a
// file Small for the wrong reason: it passes only because the guard said no.
// So a refusal is a failure of the file, swallowed or not, and the runner
// reports a process that exits non-zero as a failed file.
process.on('exit', () => {
  if (refusals > 0) {
    process.stderr.write(`[tier-guard] ${refusals} refusal(s) in ${TEST_FILE}: the file is not small; declare it medium or large in test/tiers.json\n`);
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
 * @param {string} declareAs - The tiers a file doing this may be declared
 * @returns {function(): never}
 */
function refuse(act, declareAs) {
  return function tierGuardRefusal() {
    const message = `small tier: ${act} is forbidden here (called from ${caller()} in ${TEST_FILE}); declare the file ${declareAs} in test/tiers.json`;
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
    for (const name of SPAWNERS) wrapped[name] = refuse(`child_process.${name}`, 'medium or large');
    guarded.set(mod, wrapped);
  }
  return guarded.get(mod);
}

/**
 * `node:sqlite` with `DatabaseSync` replaced by a constructor that refuses.
 *
 * @param {object} mod - The real module
 * @returns {object}
 */
function guardedSqlite(mod) {
  if (!guarded.has(mod)) {
    guarded.set(mod, { ...mod, DatabaseSync: refuse('opening a node:sqlite database', 'medium or large') });
  }
  return guarded.get(mod);
}

/**
 * Load every module as node would, handing back a guarded copy of the two
 * that can leave the process.
 *
 * @param {string} request - The require argument
 * @returns {any}
 */
Module._load = function tierGuardedLoad(request) {
  const mod = originalLoad.apply(this, arguments);
  if (request === 'child_process' || request === 'node:child_process') return guardedChildProcess(mod);
  if (request === 'node:sqlite') return guardedSqlite(mod);
  return mod;
};

/**
 * Refuse to open a listening socket. `http.createServer` and friends return a
 * `net.Server`, so this one seam covers every server kind.
 */
net.Server.prototype.listen = refuse('listening on a socket', 'medium or large');
