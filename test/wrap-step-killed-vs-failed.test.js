'use strict';

/**
 * A wrap step that was KILLED must not be reported as one that FAILED (#897).
 *
 * #894 fixed that distinction in `test` and `lint` — two handlers the shipped
 * fourteen-step pipeline never runs. The four steps covered here DO run on every
 * wrap (`open-pr-check`, `commit`, `continuity-write`, `apply-pr-resolutions`),
 * and two of them take outward actions: a `git commit` or a `gh pr merge` killed
 * at its timeout used to arrive as a plain `exit 1` with empty output, so the
 * operator was told the commit "was rejected — read the hook output above" for a
 * commit that may in fact have landed.
 *
 * Every timeout case below runs a REAL process against a REAL kill, through the
 * production wrapper. Three hand-written models of these error shapes were wrong
 * in #894, which is the entire reason this file does not inject error objects.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { execShell, execFileArgs, TIMEOUT_EXIT_CODE } = require('../lib/wrap-steps/_exec-shell');
const commitStep = require('../lib/wrap-steps/commit');
const prMergeStep = require('../lib/wrap-steps/pr-merge');
const prCheckStep = require('../lib/wrap-steps/pr-check');
const continuityStep = require('../lib/wrap-steps/continuity-write');

/** Short enough to keep the suite fast, long enough not to race the spawn. */
const SHORT_TIMEOUT_MS = 300;

describe('_exec-shell.execFileArgs — the argv-style runner (#897)', () => {
  it('maps a real timeout to the timeout exit code and timedOut', async () => {
    const result = await execFileArgs('sleep', ['30'], {
      cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS, maxBufferBytes: 1024 * 1024
    });

    assert.equal(result.timedOut, true, 'a killed command must be flagged as killed');
    assert.equal(result.exitCode, TIMEOUT_EXIT_CODE);
    assert.match(result.error, /timed out/);
    // The pre-fix behaviour, pinned so a regression is unmistakable: it resolved
    // exitCode 1 with error null, which no caller could tell from a real failure.
    assert.notEqual(result.exitCode, 1);
    assert.notEqual(result.error, null);
  });

  it('leaves an ordinary non-zero exit alone', async () => {
    const result = await execFileArgs('sh', ['-c', 'exit 3'], {
      cwd: os.tmpdir(), timeoutMs: 30_000, maxBufferBytes: 1024 * 1024
    });

    assert.equal(result.timedOut, false, 'a command that answered is not a timeout');
    assert.equal(result.exitCode, 3);
    assert.equal(result.error, null, 'an exit code IS the answer — there is no exec error');
  });

  it('names a missing executable instead of flattening it to exit 1', async () => {
    // The argv form has no shell to exit 127 on its behalf, so a missing binary
    // arrives as a non-numeric `ENOENT` — the same slot as an output overflow.
    // It must be named, and it must NOT be mistaken for a timeout: the child is
    // never spawned, so nothing is killed.
    const result = await execFileArgs('tangleclaw-no-such-binary', [], {
      cwd: os.tmpdir(), timeoutMs: 30_000, maxBufferBytes: 1024 * 1024
    });

    assert.equal(result.timedOut, false, 'a binary that never spawned was not killed');
    assert.match(result.error, /ENOENT/, 'the operator must be told what actually happened');
  });

  it('does not report an output overflow as a timeout', async () => {
    // The near-miss for the timeout predicate: the child IS killed here, but
    // `killed` is left unset and no signal is reported.
    const result = await execShell('yes hello | head -c 200000', {
      cwd: os.tmpdir(), timeoutMs: 30_000, maxBufferBytes: 1024
    });

    assert.equal(result.timedOut, false, 'an overflow is not a timeout');
    assert.match(result.error, /maxBuffer/);
  });
});

describe('the four pipeline steps whose runner could not tell killed from failed (#897)', () => {
  // Each step's production wrapper, driven against a real stalling process. The
  // test seam supplies only the caps — the wrapper, the predicate, and the
  // mapping under test are all production code.
  const argvRunners = [
    ['commit', () => commitStep._internal.exec('sleep', ['30'], {
      cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS
    })],
    ['pr-merge', () => prMergeStep._internal.exec('sleep', ['30'], {
      cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS
    })],
    ['continuity-write', () => continuityStep._internal.exec('sleep', ['30'], {
      cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS
    })]
  ];
  const shellRunners = [
    ['pr-check', () => prCheckStep._internal.exec('sleep 30', {
      cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS
    })],
    ['pr-merge (shell form)', () => prMergeStep._internal.execShell('sleep 30', {
      cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS
    })]
  ];

  for (const [label, run] of [...argvRunners, ...shellRunners]) {
    it(`${label}: a real kill resolves timedOut, not a bare exit 1`, async () => {
      const result = await run();

      assert.equal(result.timedOut, true, `${label} must flag a killed command as killed`);
      assert.equal(result.exitCode, TIMEOUT_EXIT_CODE);
      assert.notEqual(result.exitCode, 1, 'exit 1 is what a command that RAN and failed returns');
    });
  }

  for (const [label, step, args] of [
    ['commit', commitStep, ['sh', ['-c', 'exit 3']]],
    ['pr-merge', prMergeStep, ['sh', ['-c', 'exit 3']]],
    ['continuity-write', continuityStep, ['sh', ['-c', 'exit 3']]]
  ]) {
    it(`${label}: an ordinary non-zero exit is still an ordinary non-zero exit`, async () => {
      const result = await step._internal.exec(args[0], args[1], { cwd: os.tmpdir() });

      assert.equal(result.timedOut, false);
      assert.equal(result.exitCode, 3);
    });
  }
});

describe('what the operator is told when a wrap command is killed (#897)', () => {
  // Each case below scripts the step's git runner, but the KILLED result it
  // returns is produced by a real `sleep` kill through the production wrapper —
  // never a hand-built error object. That is the part three authors got wrong
  // in #894, so it is the part no double is allowed to model.

  /** An exec result for a command that RAN and succeeded. */
  const ok = (stdout = '') => ({
    exitCode: 0, stdout, stderr: '', error: null, timedOut: false
  });

  it('commit: a killed `git commit` is not called a rejection, and does not claim the commit failed', async () => {
    const realKill = await execFileArgs('sleep', ['30'], {
      cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS, maxBufferBytes: 1024
    });
    const saved = commitStep._internal.exec;
    try {
      commitStep._internal.exec = async (file, args) => {
        const cmd = `${file} ${args.join(' ')}`;
        if (cmd.startsWith('git commit')) return realKill;
        if (cmd === 'git status --porcelain') return ok('M lib/thing.js\n');
        if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok('fix/some-branch\n');
        if (cmd === 'git add -A') return ok();
        return ok();
      };

      const result = await commitStep.run({
        project: { name: 'p', path: os.tmpdir() },
        step: { id: 'commit' },
        staged: {},
        options: {}
      });

      assert.equal(result.status, 'blocked');
      // The blocker names a stop, not a failure.
      assert.match(result.blockers[0], /was stopped/);
      assert.doesNotMatch(result.blockers[0], /git commit failed/,
        'a killed commit must not be reported as a failed one');
      // And the remediation must not send the operator to read hook output that
      // does not exist, nor assert that nothing was committed.
      assert.match(result.output.remediation, /git log -1/,
        'the operator must be told how to find out whether the commit landed');
      assert.doesNotMatch(result.output.remediation, /was rejected/,
        'nothing rejected this commit — it was stopped');
    } finally {
      commitStep._internal.exec = saved;
    }
  });

  it('commit: an ordinary rejected commit keeps its pre-commit-hook remediation', async () => {
    const saved = commitStep._internal.exec;
    try {
      commitStep._internal.exec = async (file, args) => {
        const cmd = `${file} ${args.join(' ')}`;
        if (cmd.startsWith('git commit')) {
          return { exitCode: 1, stdout: '', stderr: 'husky: lint failed', error: null, timedOut: false };
        }
        if (cmd === 'git status --porcelain') return ok('M lib/thing.js\n');
        if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok('fix/some-branch\n');
        return ok();
      };

      const result = await commitStep.run({
        project: { name: 'p', path: os.tmpdir() },
        step: { id: 'commit' },
        staged: {},
        options: {}
      });

      assert.equal(result.status, 'blocked');
      assert.match(result.blockers[0], /git commit failed \(exit 1\)/,
        'the non-timeout wording is a contract other tests and the drawer read');
      assert.match(result.output.remediation, /was rejected/);
      assert.doesNotMatch(result.output.remediation, /git log -1/,
        'a rejected commit definitely did not land — do not muddy it with a check');
    } finally {
      commitStep._internal.exec = saved;
    }
  });

  it('pr-merge: a killed `gh pr merge` says auto-merge state is unknown, not that it was refused', async () => {
    const realKill = await execShell('sleep 30', {
      cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS, maxBufferBytes: 1024
    });
    const saved = prMergeStep._internal.execShell;
    try {
      prMergeStep._internal.execShell = async () => realKill;

      const r = await prMergeStep._internal.enqueueAutoMerge(os.tmpdir(), 42);

      assert.equal(r.ok, false, 'a stopped request must not be reported as an armed merge');
      assert.match(r.reason, /stopped before it answered/);
      assert.match(r.reason, /may or may not have been armed/,
        'the outward action leaves ambiguous state and the operator must be told');
      assert.doesNotMatch(r.reason, /^exit 1$/,
        'the pre-fix rendering, which read as GitHub refusing the request');
    } finally {
      prMergeStep._internal.execShell = saved;
    }
  });

  it('pr-check: a killed `gh pr list` does not read as gh refusing', async () => {
    const realKill = await execShell('sleep 30', {
      cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS, maxBufferBytes: 1024
    });
    const saved = prCheckStep._internal.exec;
    try {
      prCheckStep._internal.exec = async () => realKill;

      const r = await prCheckStep._internal.listOpenPrs(os.tmpdir());

      assert.equal(r.ok, false);
      assert.match(r.reason, /was stopped/);
      assert.doesNotMatch(r.reason, /^exit 1$/,
        'the pre-fix rendering — indistinguishable from "gh is not authenticated"');
    } finally {
      prCheckStep._internal.exec = saved;
    }
  });
});
