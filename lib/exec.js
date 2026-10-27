'use strict';

/**
 * The child-process runners shared by every module that runs a command and
 * wants a structured answer rather than a throw: the wrap steps, and the git/gh
 * readers outside them (#1561).
 *
 * Every child gets `NO_PROMPT_ENV`. The server has no terminal, so a `git` or
 * `gh` that reaches a credential prompt can never be answered; without these it
 * waits out its whole timeout instead of failing at once.
 *
 * The shell form lived as a byte-identical copy in `test.js` and `lint.js`. Both
 * copies carried the same dead timeout branch (#894) and both had to be fixed
 * separately, which is the argument for one copy — a defect in a duplicated
 * function is a defect per duplicate, and the one that gets missed is the one
 * nobody was looking at. Five more copies then turned up in `commit.js`,
 * `pr-merge.js`, `pr-check.js` and `continuity-write.js`, each with the same
 * missing distinction, which is why both forms now live here.
 *
 * Conventional shell exit code for a command killed by a timeout, so the caller
 * can tell it apart from any code the command itself could have produced.
 */
const TIMEOUT_EXIT_CODE = 124;

/**
 * The environment that makes git and gh fail instead of prompting.
 * @type {Readonly<{GIT_TERMINAL_PROMPT: string, GH_PROMPT_DISABLED: string}>}
 */
const NO_PROMPT_ENV = Object.freeze({ GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });

const { spawn } = require('node:child_process');
const { wasTimedOut } = require('./exec-timeout');
const { redactRemoteOutput, REDACTED_PREFIX } = require('./remote-output');

/**
 * `exec`/`execFile`'s own `maxBuffer` default (1MB) when a caller doesn't set
 * one — kept here because this module now builds on `spawn`, which has no
 * such default of its own, and every existing caller's expectations were set
 * against `exec`'s/`execFile`'s.
 */
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Turn one `child_process` callback into the structured result both runners
 * resolve to. Shared so the killed-vs-failed distinction is decided in exactly
 * one place: the whole of #894 and #897 is that distinction having been made
 * independently — and wrongly — at each site.
 *
 * @param {Error|null} err - Callback error.
 * @param {string|Buffer} stdout
 * @param {string|Buffer} stderr
 * @param {number} timeoutMs - The wall clock that was set, for the message.
 * @param {boolean} [groupKillConfirmed] - For the timeout path only: whether
 *   the process group was CONFIRMED gone (not merely signalled) before this
 *   was called — see {@link _killProcessGroupUntilGone}. Defaults to `true`
 *   (confirmed, or no group kill was attempted at all), in which case the
 *   result carries no `groupKillConfirmed` key: an ordinary, fully-confirmed
 *   timeout adds no new noise to a shape every existing caller already
 *   reads. The key appears ONLY on `false` — a kill that could not be
 *   verified is the exceptional case, and this repo's convention (also used
 *   for `lib/wrap-steps/handoff-stage.js`'s `worktree.unestablished`) is to
 *   name an exception rather than carry a boolean on every result.
 * @param {boolean} [timeoutFired] - Whether OUR OWN timeout is the reason the
 *   command stopped — read from {@link _armGroupKillTimeout}'s `fired()`,
 *   independent of `err`. `wasTimedOut(err)` alone is not enough: it infers a
 *   timeout from the SIGNAL the child died by, but a child that TRAPS the
 *   `SIGTERM` this sends and calls its own `exit()` in response (0 or
 *   otherwise) produces `code`/`signal` indistinguishable from one that was
 *   never signalled at all — by the time `err` is built, the fact that a
 *   signal was ever delivered is gone. `timeoutFired` is what still catches
 *   that case: once our own timeout has fired, EVERY exit after it is a
 *   stop, whatever shape the child's own exit took.
 * @returns {{exitCode:number, stdout:string, stderr:string, error:string|null,
 *   errorCode:string|null, signal:string|null, timedOut:boolean,
 *   groupKillConfirmed?:false}}
 */
function _toResult(err, stdout, stderr, timeoutMs, groupKillConfirmed, timeoutFired) {
  const out = (stdout || '').toString();
  const errOut = (stderr || '').toString();
  const confirmed = groupKillConfirmed !== false;
  // `wasTimedOut`, not `err.code === undefined && err.killed`: async `exec` and
  // `execFile` DO set `killed`, but their `code` is `null` rather than
  // `undefined`, so that branch died on its first clause and a killed command
  // fell through as an ordinary non-zero exit — reported to the operator as a
  // failure that never happened (#894). `timeoutFired ||`, not `wasTimedOut`
  // alone: see the parameter doc above — a trapped `SIGTERM` answered with
  // the child's own `exit()` leaves no signal for `wasTimedOut` to read.
  if (timeoutFired || wasTimedOut(err)) {
    return {
      exitCode: TIMEOUT_EXIT_CODE,
      stdout: out,
      stderr: errOut,
      // Said in the text too, not only the field: a reader of just `error`
      // (`describeFailure`, a log line, an operator) must not see an
      // ordinary-sounding "timed out" for a kill this could not actually
      // verify finished — #1503's own bar is the whole tree gone BEFORE this
      // resolves, and reporting a plain clean stop when that bar was missed
      // is exactly the thing being fixed here.
      error: confirmed
        ? `timed out after ${timeoutMs}ms`
        : `timed out after ${timeoutMs}ms; its process group could not be confirmed terminated`,
      errorCode: null,
      signal: null,
      timedOut: true,
      ...(confirmed ? {} : { groupKillConfirmed: false })
    };
  }
  return {
    exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
    stdout: out,
    stderr: errOut,
    // A NUMERIC code means the command ran and exited, and that code IS the
    // answer. Anything else is the run itself failing, and the old
    // `=== undefined` test caught none of them — most reachably an output
    // overflow (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), which arrived as a bare
    // exit 1 with no explanation for a suite that simply printed too much.
    // A MISSING executable differs by form: through a shell it is the shell
    // exiting 127 (numeric, already reported correctly), while argv-style it is
    // `ENOENT` — non-numeric, so it lands here and is named rather than
    // flattened into "exit 1".
    error: err && typeof err.code !== 'number' ? err.message : null,
    // The same non-numeric code, kept as a value callers can branch on without
    // parsing `error`. `ENOENT` is a missing executable OR a missing working
    // directory: Node reports both the same way, so a caller that must tell
    // them apart asks again without the directory (`lib/stranded-check.js`).
    errorCode: err && typeof err.code === 'string' ? err.code : null,
    // A signal that was not our timeout (a crash, or a kill from outside). The
    // child produced no exit code, so its output is not an answer either.
    signal: err && err.signal ? err.signal : null,
    timedOut: false
  };
}

/**
 * The environment a child runs with: the caller's (or this process's), with
 * prompts disabled on top. A copy, so the caller's object is never changed.
 * @param {object|undefined} env
 * @returns {object}
 */
function _childEnv(env) {
  return { ...(env || process.env), ...NO_PROMPT_ENV };
}

/**
 * How long a timed-out command's process group gets after `SIGTERM` before
 * `SIGKILL`. Long enough for a command that traps the signal to clean up
 * (close a connection, flush a log); short enough that an ignored or hung
 * signal does not leave the step waiting anywhere near the original timeout
 * again.
 */
const GROUP_KILL_GRACE_MS = 500;

/** How often to poll whether a timed-out command's process group has fully exited. */
const GROUP_KILL_POLL_MS = 20;

/**
 * How long to keep polling past `SIGKILL` before giving up on confirming the
 * group is gone. A bound exists so a process `SIGKILL` genuinely cannot touch
 * (stuck in uninterruptible I/O, say) does not hang the step forever — past
 * this, resolution proceeds anyway rather than wait on a signal that was
 * already the strongest one there is.
 */
const GROUP_KILL_CONFIRM_TIMEOUT_MS = 2000;

/**
 * Whether `pid`'s process GROUP still has any member alive. Signal `0` to a
 * negative pid is the standard existence probe for exactly this: the kernel
 * answers `ESRCH` only once nothing with that process-group id remains,
 * zombies included (a zombie still carries its pgid until reaped).
 * @param {number} pid
 * @returns {boolean}
 */
function _groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Kill a timed-out command's whole process group and resolve only once it is
 * CONFIRMED gone — not merely signalled.
 *
 * `exec`'s own `timeout` option, like `child.kill()` in general, signals only
 * the direct child (the `/bin/sh` wrapper); a command that starts other
 * processes (`npm test`, `a && b`, a script that forks workers) can leave
 * them running after the step has already reported the command as stopped.
 * That is #1503's own wording: the whole tree must be gone BEFORE `execShell`
 * resolves. Resolving the instant the one tracked child exits is not that —
 * a descendant that ignores `SIGTERM` (or merely closes its inherited pipes
 * without actually exiting) can still be alive at that exact moment, which is
 * precisely the gap between the direct child's `close` event and the rest of
 * its process group's actual death.
 *
 * `SIGTERM` first; `SIGKILL` after {@link GROUP_KILL_GRACE_MS} if the group is
 * still around, so a command that ignores the first signal does not get to
 * outlive the timeout a second time. Polls for the group's actual death
 * throughout (not just after sending each signal), up to
 * {@link GROUP_KILL_CONFIRM_TIMEOUT_MS} past the `SIGKILL`.
 *
 * Falls back to signalling just the one child when the negative-pid form is
 * refused outright (no process-group semantics to use, e.g. Windows) rather
 * than when the group is simply already gone — `ESRCH` there means there is
 * nothing left to signal, not that the attempt was wrong; either way this
 * resolves once there is nothing further it can do.
 *
 * @param {number} pid - The detached child's pid (also its process-group id).
 * @returns {Promise<boolean>} `true` once the group is CONFIRMED gone.
 *   `false` means the confirm timeout was reached with the group still
 *   alive — a signal was sent (`SIGKILL`, the strongest available), but this
 *   function could not verify it worked, and says so rather than reporting
 *   the same as a confirmed kill.
 */
function _killProcessGroupUntilGone(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid)) { resolve(true); return; }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (err) {
      if (err.code !== 'ESRCH') {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      resolve(true);
      return;
    }

    const startedAt = Date.now();
    let killedHard = false;

    const poll = () => {
      if (!_groupAlive(pid)) { resolve(true); return; }
      const elapsed = Date.now() - startedAt;
      if (!killedHard && elapsed >= GROUP_KILL_GRACE_MS) {
        killedHard = true;
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      if (killedHard && elapsed >= GROUP_KILL_GRACE_MS + GROUP_KILL_CONFIRM_TIMEOUT_MS) { resolve(false); return; }
      // Deliberately NOT unref'd: once the one child Node holds a handle to
      // has exited, that handle stops keeping the event loop alive on its
      // own, and every other process left in the group is just a bare OS pid
      // Node has never heard of. An unref'd poll here would let the event
      // loop — and the whole process, in a short-lived caller with nothing
      // else running — exit while this confirmation is still pending, which
      // is precisely the gap this function exists to close. Bounded by
      // {@link GROUP_KILL_CONFIRM_TIMEOUT_MS} above, so this can never hang
      // indefinitely.
      setTimeout(poll, GROUP_KILL_POLL_MS);
    };
    poll();
  });
}

/**
 * Arm the timeout that starts confirming `child`'s whole process group is
 * gone (#1503).
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number|undefined} timeoutMs - No timer is armed when this is not a
 *   positive number: `undefined`/`0` means "no timeout", same as before.
 * @returns {{cancel: () => void, confirmed: () => Promise<boolean>, fired: () => boolean}}
 *   `cancel` stops the timer before it fires — for a command that answers on
 *   its own first, whose (already-gone) process group must not be signalled
 *   anyway. `confirmed` is what the caller awaits before resolving: a no-op
 *   `Promise.resolve(true)` if the timer never fired (nothing needed
 *   confirming), or {@link _killProcessGroupUntilGone}'s own `true`/`false`
 *   once it has. `fired` is whether THIS timeout is the reason the command
 *   stopped — read synchronously, independent of `confirmed`'s result and of
 *   whatever exit shape the child ends up producing. See `_collectResult`:
 *   a child that traps the `SIGTERM` this sends and calls its own `exit()`
 *   (0 or otherwise) in response produces an exit that, on its own, is
 *   indistinguishable from one that was never signalled at all — `fired` is
 *   what still says this was a kill, not an answer.
 */
function _armGroupKillTimeout(child, timeoutMs) {
  if (!(timeoutMs > 0)) {
    return { cancel: () => {}, confirmed: () => Promise.resolve(true), fired: () => false };
  }
  let confirmedPromise = null;
  let hasFired = false;
  const timer = setTimeout(() => {
    hasFired = true;
    confirmedPromise = _killProcessGroupUntilGone(child.pid);
  }, timeoutMs);
  timer.unref();
  return {
    cancel: () => clearTimeout(timer),
    confirmed: () => confirmedPromise || Promise.resolve(true),
    fired: () => hasFired
  };
}

/**
 * Build the failure `err` `_toResult` expects for a child that exited (by
 * code or by signal) on its own, worded the way `exec`/`execFile` themselves
 * word it — `describeFailure` and `test/_exec-results.js`'s `killedBy` double
 * both read this message, so it is part of the contract, not incidental.
 *
 * @param {string} cmdDetails - The command as `exec`/`execFile` would name it:
 *   the shell string for `execShell`, `"file arg1 arg2"` for `execFileArgs`.
 * @param {number|null} code
 * @param {string|null} signal
 * @param {string} stderr
 * @returns {Error}
 */
function _failureError(cmdDetails, code, signal, stderr) {
  const err = new Error(`Command failed: ${cmdDetails}\n${stderr}`);
  err.code = signal !== null ? null : code;
  err.signal = signal;
  return err;
}

/**
 * Run `child` to completion and resolve the `_toResult` shape every caller of
 * `execShell`/`execFileArgs` already depends on — `maxBufferBytes` enforced
 * by hand (mirroring `exec`'s/`execFile`'s own default and behaviour) and
 * `timeoutMs` armed via {@link _armGroupKillTimeout}.
 *
 * Built on `spawn` rather than `exec`/`execFile`: neither forwards `detached`
 * to the underlying spawn call (confirmed empirically — a process started
 * through either keeps the PARENT's process group), so `exec`'s own `timeout`
 * can only ever reach the one child it holds a handle to. That gap is #1503.
 *
 * Resolution itself waits on {@link _armGroupKillTimeout}'s `confirmed()`
 * before resolving, whatever triggered it (the child's own `close`, or an
 * `error`): the direct child exiting is not proof the rest of its process
 * group has — only `confirmed()` is that proof, and resolving on anything
 * less is the exact gap #1503 names.
 *
 * @param {import('node:child_process').ChildProcess} child - Already spawned
 *   with `detached: true`.
 * @param {object} options - See {@link execShell}.
 * @param {string} cmdDetails - See {@link _failureError}.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string,
 *   error: string|null, errorCode: string|null, signal: string|null, timedOut: boolean}>}
 */
function _collectResult(child, options, cmdDetails) {
  return new Promise((resolve) => {
    const maxBufferBytes = Number.isFinite(options.maxBufferBytes) ? options.maxBufferBytes : DEFAULT_MAX_BUFFER_BYTES;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let overflowErr = null;
    let settled = false;
    const groupKill = _armGroupKillTimeout(child, options.timeoutMs);

    function finish(err) {
      if (settled) return;
      settled = true;
      groupKill.cancel();
      const timeoutFired = groupKill.fired();
      const effectiveErr = overflowErr || err;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      // Awaited even when no timeout ever fired: `confirmed()` is then just
      // an already-resolved no-op, so this adds no delay to the ordinary
      // path — only to the one #1503 is about. Its `false` is what makes a
      // kill that could not be verified distinguishable from an ordinary
      // confirmed one, rather than both reporting the same plain `timedOut`.
      groupKill.confirmed().then((groupKillConfirmed) => {
        resolve(_toResult(effectiveErr, stdout, stderr, options.timeoutMs, groupKillConfirmed, timeoutFired));
      });
    }

    // Enforces `maxBufferBytes` per stream, same as `exec`/`execFile`: the
    // chunk that would push either stream over the cap is dropped (not kept
    // truncated), and the whole group is killed — not just the direct
    // child — since a chatty GRANDCHILD can share the other stdio pipe (the
    // one that has not overflowed yet) and keep writing to it, or simply
    // keep running, after the direct child is gone. Not awaited before
    // resolving: an overflow is a chatty command, not a stuck one, so
    // #1503's "wait for confirmed death" guarantee is for the timeout path —
    // this cleanup is free to finish after the result is reported.
    function track(stream, chunks, which, getLen, setLen) {
      if (!stream) return;
      stream.on('data', (chunk) => {
        if (overflowErr) return;
        const len = getLen() + chunk.length;
        setLen(len);
        if (len > maxBufferBytes) {
          overflowErr = Object.assign(new Error(`${which} maxBuffer length exceeded`), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          });
          stream.destroy();
          if (Number.isInteger(child.pid)) {
            _killProcessGroupUntilGone(child.pid);
          } else {
            try { child.kill(); } catch { /* already gone */ }
          }
        } else {
          chunks.push(chunk);
        }
      });
    }

    track(child.stdout, stdoutChunks, 'stdout', () => stdoutLen, (n) => { stdoutLen = n; });
    track(child.stderr, stderrChunks, 'stderr', () => stderrLen, (n) => { stderrLen = n; });

    if (options.closeStdin === true && child.stdin) {
      // A spawn that fails asynchronously (a missing interpreter behind a
      // `#!` line — which an X_OK check on the script cannot see) emits
      // `'error'` on this stream. With no listener that is an unhandled
      // stream error taking down the process, instead of the resolved
      // failure result every caller here is written to receive. The `close`/
      // `error` handlers below still report the failure; this only stops the
      // stream half of it escaping.
      child.stdin.on('error', () => {});
      child.stdin.end();
    }

    child.on('error', (err) => finish(err));
    child.on('close', (code, signal) => {
      if (code === 0 && signal === null && !overflowErr) { finish(null); return; }
      finish(_failureError(cmdDetails, code, signal, Buffer.concat(stderrChunks).toString('utf8')));
    });
  });
}

/**
 * Run a shell command and resolve to a structured result.
 *
 * Never throws, and never rejects: a non-zero exit is an ordinary outcome here
 * (it is the whole point of a test or lint step), so the exit code is data
 * rather than an error.
 *
 * @param {string} command - Shell command string (e.g. `"npm test"`).
 * @param {object} options - Run options.
 * @param {string} options.cwd - Working directory.
 * @param {number} options.timeoutMs - Wall clock before the command is killed.
 * @param {number} options.maxBufferBytes - Output cap before the child is killed.
 * @param {object} [options.env] - Child environment; defaults to this process's.
 *   `NO_PROMPT_ENV` is always applied on top.
 *   A caller that must pin a variable the child reads (the preflight step sets
 *   `CLAUDE_PROJECT_DIR` so prawduct resolves the project it is asked about,
 *   not whichever one this process was launched from) passes a copy with it set.
 * @param {boolean} [options.closeStdin] - End the child's stdin at once. The
 *   child's stdin is a pipe that nothing writes to and — measured — nothing
 *   closes either, so a child that reads stdin to EOF (prawduct's Stop hook
 *   reads its harness payload that way) hangs to the timeout and is reported
 *   as killed. Off by default: no existing caller's child reads stdin, and a
 *   flag keeps the change visible at the one site that needs it.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string,
 *   error: string|null, errorCode: string|null, signal: string|null, timedOut: boolean}>} `timedOut` distinguishes a command
 *   that was KILLED from one that ran and failed — callers branch on it to pick
 *   what they tell the operator, so it is part of the contract, not a hint.
 *   Anything constructing this shape by hand (a test double, say) must set it.
 */
function execShell(command, options) {
  const child = spawn(command, {
    shell: true,
    cwd: options.cwd,
    env: _childEnv(options.env),
    detached: true
  });
  return _collectResult(child, options, command);
}

/**
 * Run a command argv-style — no shell — and resolve to the same structured
 * result as {@link execShell}.
 *
 * This is a separate entry point rather than a flag because the absence of a
 * shell is the reason callers pick it: `commit.js` passes a multi-line commit
 * message to `git commit -m`, where every quote, newline and backtick must reach
 * the child's `argv[]` byte-intact. Routing that through a shell to save one
 * function would reintroduce the quoting bug the argv form exists to avoid.
 *
 * @param {string} file - Executable name (e.g. `'git'`).
 * @param {string[]} args - Arguments, each passed as its own `argv[]` entry.
 * @param {object} options - Run options.
 * @param {string} options.cwd - Working directory.
 * @param {number} options.timeoutMs - Wall clock before the command is killed.
 * @param {number} options.maxBufferBytes - Output cap before the child is killed.
 * @param {object} [options.env] - Child environment; see {@link execShell}.
 * @param {boolean} [options.closeStdin] - End the child's stdin at once; see
 *   {@link execShell}.
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string,
 *   error: string|null, errorCode: string|null, signal: string|null, timedOut: boolean}>} Same contract as {@link execShell},
 *   `timedOut` included — a hand-built double must set it.
 */
function execFileArgs(file, args, options) {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: _childEnv(options.env),
    detached: true
  });
  return _collectResult(child, options, `${file} ${args.join(' ')}`);
}

/**
 * Whether a result is a run that never produced an answer: killed by our
 * timeout or a signal, or never started. A non-zero exit is NOT one of these —
 * that is the command answering.
 * @param {{timedOut: boolean, errorCode: (string|null), signal: (string|null)}} r
 * @returns {boolean}
 */
function didNotRun(r) {
  return !!(r && (r.timedOut || r.errorCode || r.signal));
}

/**
 * One line saying why a command did not succeed, redacted, for a reason an
 * operator reads. Shared so every caller names a missing program, a timeout and
 * a kill the same way.
 *
 * `ENOENT` is named as a missing program. A caller whose working directory may
 * be the missing thing asks first (`lib/stranded-check.js#spawnFailure`).
 *
 * @param {{exitCode: number, stdout: string, stderr: string, error: (string|null),
 *   errorCode: (string|null), signal: (string|null), timedOut: boolean}} r - A result from this module
 * @param {string} what - The command as the operator would name it, e.g. `gh pr list`
 * @returns {string}
 */
function describeFailure(r, what) {
  const bin = what.split(' ')[0];
  if (r.errorCode === 'ENOENT') return `${bin} is not installed`;
  if (r.timedOut) return `${what} ${r.error || 'timed out'}`;
  if (r.signal) return `${what} was stopped by ${r.signal}`;
  if (r.errorCode) return `${what} could not run (${r.errorCode})`;
  const line = `${r.stderr || ''}\n${r.stdout || ''}`.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  // These commands reach remotes, so their output can echo a tokenised URL.
  const safe = redactRemoteOutput(line);
  // A wholesale replacement drops the command's own words; the exit code is not
  // a credential, so it is named beside it.
  if (safe && safe.startsWith(REDACTED_PREFIX)) return `${what} failed (exit ${r.exitCode}): ${safe}`;
  return safe ? `${what} failed: ${safe}` : `${what} failed (exit ${r.exitCode})`;
}

module.exports = {
  execShell, execFileArgs, didNotRun, describeFailure, NO_PROMPT_ENV, TIMEOUT_EXIT_CODE,
  // Test-only: the confirm-deadline-expired branch needs a target that
  // outlives `SIGKILL`, which cannot be produced with a real process — only
  // simulated by stubbing `process.kill`'s existence probe for a real pid.
  _killProcessGroupUntilGone, GROUP_KILL_GRACE_MS, GROUP_KILL_CONFIRM_TIMEOUT_MS
};
