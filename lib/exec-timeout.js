'use strict';

/**
 * Whether a child-process error means OUR OWN timeout killed the command.
 *
 * This exists as a shared module rather than a local helper because the repo had
 * THREE hand-written versions of it and all three were dead code (#894). Node
 * reports the same event two different ways depending on which API ran, and each
 * author modelled one of them wrongly:
 *
 *   `execSync` / `execFileSync` — throws with `code: 'ETIMEDOUT'`,
 *     `signal: 'SIGTERM'`, and **no `killed`**. That flag belongs to
 *     `spawnSync`'s RESULT object, not to the error being thrown. `lib/tmux.js`
 *     read `err.killed`, so its "tmux command timed out" branch had never once
 *     executed.
 *
 *   `exec` / `execFile` (async) — the callback error DOES carry `killed: true`,
 *     but its `code` is **`null`, not `undefined`**. Both wrap steps tested
 *     `err.code === undefined && err.killed` and died on the first clause, so a
 *     hung test run was reported as an ordinary test failure and the operator was
 *     told to go fix tests that had never run.
 *
 * The lesson worth keeping: both branches read correctly, compiled, and were
 * never once true. Drive any change here with a REAL stalling process — a stub
 * asserts your model of these shapes, which is exactly what was broken.
 *
 * @param {Error|null|undefined} err - Error thrown by, or handed to, a
 *   `child_process` call.
 * @returns {boolean} True when a timeout we set killed the command.
 */
function wasTimedOut(err) {
  if (!err) return false;
  // The synchronous throw. DELIBERATELY REDUNDANT: `execSync` sets both this and
  // `signal: 'SIGTERM'`, so the fallback below already covers it and deleting
  // this line breaks no test. Kept because the two come from different layers —
  // this is the documented contract, the signal is an artifact of how the kill
  // is delivered — and a predicate this repo got wrong three times should state
  // what it means rather than rely on a side effect. Anyone auditing coverage:
  // the overlap is known, not an untested branch.
  if (err.code === 'ETIMEDOUT') return true;
  // The asynchronous callback. Strict `true`: an ordinary non-zero exit sets
  // `killed: false`, which must not read as a timeout.
  if (err.killed === true) return true;
  // Shared fallback for shapes neither clause names, and the only clause that
  // can be wrong: a human `kill` mid-command would land here. Accepted, because
  // at every call site the sole sender of these signals is our own timeout, and
  // calling a manual kill a timeout is far better than the behaviour this
  // replaces — calling a timeout an ordinary failure and remediating it as one.
  return err.signal === 'SIGTERM' || err.signal === 'SIGKILL';
}

module.exports = { wasTimedOut };
