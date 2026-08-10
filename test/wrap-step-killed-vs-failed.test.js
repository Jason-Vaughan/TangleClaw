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

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { execShell, execFileArgs, TIMEOUT_EXIT_CODE } = require('../lib/wrap-steps/_exec-shell');
const commitStep = require('../lib/wrap-steps/commit');
const prMergeStep = require('../lib/wrap-steps/pr-merge');
const prCheckStep = require('../lib/wrap-steps/pr-check');
const continuityStep = require('../lib/wrap-steps/continuity-write');
const { setLevel, getLevel, setConsoleStream } = require('../lib/logger');

/** Short enough to keep the suite fast, long enough not to race the spawn. */
const SHORT_TIMEOUT_MS = 300;

/**
 * Run `fn` with the logger raised to `warn` and its console stream captured.
 *
 * Several sites in this sweep are best-effort by contract — they degrade to an
 * empty value and let the wrap continue, which is correct. That makes the log
 * line the ONLY place a kill is distinguishable from a definite negative
 * answer, so it is the thing worth asserting on.
 *
 * @param {() => Promise<void>} fn - The work to run while capturing.
 * @returns {Promise<string[]>} The captured log lines.
 */
async function captureWarnings(fn) {
  const lines = [];
  const priorLevel = getLevel();
  setLevel('warn');
  setConsoleStream({ write: (s) => lines.push(s) });
  try {
    await fn();
  } finally {
    setConsoleStream(null);
    setLevel(priorLevel);
  }
  return lines;
}

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

describe('every operator-facing timeout branch in the swept steps (#897)', () => {
  // The first pass of this branch guarded the shared runners and four handler
  // messages, and the plan then claimed a mutation check "per new branch" —
  // which was not true of the branches with no guard at all. These are those
  // branches. Same discipline as above: the killed result each seam returns is
  // produced by a real kill through the production wrapper, never hand-built.

  /** A real killed argv-style result, reused across the cases below. */
  let argvKill;
  /** A real killed shell-form result. */
  let shellKill;

  before(async () => {
    argvKill = await execFileArgs('sleep', ['30'], {
      cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS, maxBufferBytes: 1024
    });
    shellKill = await execShell('sleep 30', {
      cwd: os.tmpdir(), timeoutMs: SHORT_TIMEOUT_MS, maxBufferBytes: 1024
    });
    assert.equal(argvKill.timedOut, true, 'the fixture must actually be a kill');
    assert.equal(shellKill.timedOut, true, 'the fixture must actually be a kill');
  });

  /** An exec result for a command that RAN and succeeded. */
  const ok = (stdout = '') => ({
    exitCode: 0, stdout, stderr: '', error: null, timedOut: false
  });
  /** An exec result for a command that RAN and refused. */
  const refused = (code = 1, stderr = '') => ({
    exitCode: code, stdout: '', stderr, error: null, timedOut: false
  });

  /**
   * Run `commit.run` with `_internal.exec` scripted by a command-string matcher.
   *
   * @param {(cmd:string) => object|undefined} script - Returns a result, or
   *   undefined to fall through to a generic success.
   * @param {object} [options] - `context.options`.
   * @returns {Promise<object>} The step result.
   */
  async function runCommit(script, options = {}) {
    const saved = commitStep._internal.exec;
    try {
      commitStep._internal.exec = async (file, args) => {
        const cmd = `${file} ${args.join(' ')}`;
        const scripted = script(cmd);
        if (scripted) return scripted;
        if (cmd === 'git status --porcelain') return ok('M lib/thing.js\n');
        if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok('fix/some-branch\n');
        return ok('deadbee\n');
      };
      return await commitStep.run({
        project: { name: 'p', path: os.tmpdir() },
        step: { id: 'commit' },
        staged: {},
        options
      });
    } finally {
      commitStep._internal.exec = saved;
    }
  }

  describe('commit — the blockers before anything is committed', () => {
    it('a killed `git status` does not claim the working tree is untouched', async () => {
      const r = await runCommit((cmd) => (cmd === 'git status --porcelain' ? argvKill : undefined));

      assert.equal(r.status, 'blocked');
      assert.match(r.blockers[0], /was stopped/);
      assert.doesNotMatch(r.blockers[0], /git status failed/);
      // The clause this replaced was flatly wrong: `_flushStagedWrites` runs
      // BEFORE this probe, so earlier steps' artifacts are already on disk.
      assert.doesNotMatch(r.output.remediation, /exactly as you left it/,
        'staged writes from earlier steps have already landed by this point');
      assert.match(r.output.remediation, /already written to disk/);
    });

    it('a killed `git add -A` says the index may be partly staged', async () => {
      const r = await runCommit((cmd) => (cmd === 'git add -A' ? argvKill : undefined));

      assert.equal(r.status, 'blocked');
      assert.match(r.blockers[0], /was stopped/);
      assert.match(r.output.remediation, /partway/);
      assert.match(r.output.remediation, /git status/);
    });

    it('a killed auto-branch says the branch may or may not exist', async () => {
      const r = await runCommit(
        (cmd) => {
          if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok('main\n');
          if (cmd.startsWith('git checkout -b')) return argvKill;
          return undefined;
        }
      );

      assert.equal(r.status, 'blocked');
      assert.match(r.blockers[0], /Auto-branch did not finish/);
      assert.match(r.output.remediation, /may or may not exist/);
      assert.match(r.output.remediation, /git branch --list/);
    });

    it('an ordinary auto-branch failure keeps its pre-existing wording', async () => {
      const r = await runCommit((cmd) => {
        if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok('main\n');
        if (cmd.startsWith('git checkout -b')) return refused(128, 'fatal: already exists');
        return undefined;
      });

      assert.match(r.blockers[0], /Auto-branch failed \(exit 128\)/,
        'the non-timeout wording is what existing assertions pin');
      assert.equal(r.output.remediation, undefined,
        'a definite failure needs no ambiguity caveat');
    });
  });

  describe('commit — the killed branch probe changes what the wrap DOES', () => {
    // This is the one probe in the step where reading a stop as a negative
    // answer alters behaviour rather than wording: a null branch switches the
    // #264 auto-branch guard off, so a wrap fired on `main` would commit
    // straight to `main` — silently, which is what that guard exists to stop.

    it('halts rather than committing to a branch nobody identified', async () => {
      const r = await runCommit(
        (cmd) => (cmd === 'git rev-parse --abbrev-ref HEAD' ? argvKill : undefined)
      );

      assert.equal(r.status, 'blocked',
        'an unanswered branch probe must not be read as "not on a protected branch"');
      assert.match(r.blockers[0], /protected-branch check could not be made/);
      assert.match(r.output.remediation, /direct-to-main/);
    });

    it('does not commit when the branch probe was killed', async () => {
      // The behavioural half: the guard above is only worth anything if no
      // commit is attempted. Asserted on the commands actually issued.
      const issued = [];
      const saved = commitStep._internal.exec;
      try {
        commitStep._internal.exec = async (file, args) => {
          const cmd = `${file} ${args.join(' ')}`;
          issued.push(cmd);
          if (cmd === 'git status --porcelain') return ok('M lib/thing.js\n');
          if (cmd === 'git rev-parse --abbrev-ref HEAD') return argvKill;
          return ok();
        };
        await commitStep.run({
          project: { name: 'p', path: os.tmpdir() },
          step: { id: 'commit' },
          staged: {},
          options: {}
        });
      } finally {
        commitStep._internal.exec = saved;
      }

      assert.ok(!issued.some((c) => c.startsWith('git commit')),
        'nothing may be committed when we cannot tell which branch we are on');
      assert.ok(!issued.some((c) => c === 'git add -A'),
        'and nothing may be staged either');
    });

    it('still honours an explicit direct-to-main opt-in', async () => {
      // An operator who has already said "commit wherever I am" is not
      // protected by this check and must not be stopped by it.
      const r = await runCommit(
        (cmd) => (cmd === 'git rev-parse --abbrev-ref HEAD' ? argvKill : undefined),
        { allowDirectToMain: true }
      );

      assert.notEqual(r.status, 'blocked',
        'the escape hatch must still bypass');
    });
  });

  describe('commit — the auto-PR loop, where the kill is outward-facing', () => {
    /**
     * Drive the auto-PR close-loop by wrapping the whole step: the loop runs
     * after a successful commit on an auto-created wrap branch.
     *
     * @param {(cmd:string) => object|undefined} script
     * @returns {Promise<object>} `output.autoPr`
     */
    async function runAutoPr(script) {
      const r = await runCommit((cmd) => {
        if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok('main\n');
        return script(cmd);
      });
      return r.output && r.output.autoPr;
    }

    it('a killed `git push` does not assert the push failed', async () => {
      const ap = await runAutoPr((cmd) => (cmd.startsWith('git push') ? argvKill : undefined));

      assert.match(ap.error, /was stopped/);
      assert.doesNotMatch(ap.error, /git push failed/);
      assert.match(ap.remediation, /may or may not have reached origin/);
    });

    it('a killed `gh pr create` says a PR may already exist', async () => {
      const ap = await runAutoPr((cmd) => (cmd.startsWith('gh pr create') ? argvKill : undefined));

      assert.match(ap.error, /was stopped/);
      assert.match(ap.remediation, /gh pr list --head/,
        'sending them straight to `gh pr create` would hand them a duplicate-PR error');
    });

    it('a killed `gh pr merge` does not assert auto-merge was not armed', async () => {
      const ap = await runAutoPr((cmd) => (cmd.startsWith('gh pr merge') ? argvKill : undefined));

      assert.match(ap.error, /was stopped/);
      assert.doesNotMatch(ap.remediation, /^The PR is open but auto-merge could not be armed/);
      assert.match(ap.remediation, /unknown whether auto-merge was armed/);
    });

    it('a killed origin probe does not claim there is no origin remote', async () => {
      const ap = await runAutoPr((cmd) => (cmd === 'git remote get-url origin' ? argvKill : undefined));

      assert.match(ap.skippedReason, /stopped before it answered/);
      assert.doesNotMatch(ap.skippedReason, /^no origin remote/,
        'that sends the operator to configure a remote they may already have');
    });

    it('a killed gh probe does not claim the gh CLI is missing', async () => {
      const ap = await runAutoPr((cmd) => (cmd === 'gh --version' ? argvKill : undefined));

      assert.match(ap.skippedReason, /stopped before it answered/);
      assert.doesNotMatch(ap.skippedReason, /^gh CLI not available/);
    });

    it('a genuinely absent origin keeps its original wording', async () => {
      const ap = await runAutoPr(
        (cmd) => (cmd === 'git remote get-url origin' ? refused(128) : undefined)
      );

      assert.match(ap.skippedReason, /^no origin remote/);
    });
  });

  describe('pr-merge — _ensurePushed', () => {
    it('a killed branch probe does not claim HEAD is detached', async () => {
      const saved = prMergeStep._internal.exec;
      try {
        prMergeStep._internal.exec = async () => argvKill;
        const r = await prMergeStep._ensurePushed(os.tmpdir());

        assert.equal(r.ok, false, 'declining on an uncertain answer is still right');
        assert.match(r.reason, /stopped before it answered/);
        assert.doesNotMatch(r.reason, /HEAD is detached/,
          'that sends the operator to check out a branch they are probably on');
      } finally {
        prMergeStep._internal.exec = saved;
      }
    });

    it('a killed push says origin may or may not have the wrap commit', async () => {
      const saved = prMergeStep._internal.exec;
      try {
        prMergeStep._internal.exec = async (file, args) => {
          const cmd = `${file} ${args.join(' ')}`;
          if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok('wrap/x\n');
          if (cmd.startsWith('git rev-list')) return ok('2\n');
          if (cmd.startsWith('git push')) return argvKill;
          return ok();
        };
        const r = await prMergeStep._ensurePushed(os.tmpdir());

        assert.equal(r.ok, false);
        assert.match(r.reason, /stopped before it answered/);
        assert.match(r.reason, /may or may not have the wrap commit/);
        assert.doesNotMatch(r.reason, /^exit 1$/, 'the pre-fix rendering');
      } finally {
        prMergeStep._internal.exec = saved;
      }
    });

    it('a genuinely detached HEAD keeps its original wording', async () => {
      const saved = prMergeStep._internal.exec;
      try {
        prMergeStep._internal.exec = async () => ok('HEAD\n');
        const r = await prMergeStep._ensurePushed(os.tmpdir());

        assert.match(r.reason, /HEAD is detached/);
      } finally {
        prMergeStep._internal.exec = saved;
      }
    });
  });

  describe('pr-check — the two probes whose kill silently widens or empties the list', () => {
    it('logs when the gh probe was stopped rather than answering', async () => {
      const lines = await captureWarnings(async () => {
        const saved = prCheckStep._internal.exec;
        try {
          prCheckStep._internal.exec = async () => shellKill;
          const available = await prCheckStep._internal.isGhAvailable(os.tmpdir());
          assert.equal(available, false, 'the step still cannot proceed without gh');
        } finally {
          prCheckStep._internal.exec = saved;
        }
      });

      assert.ok(lines.some((l) => /gh availability probe was stopped/.test(l)),
        'the skip reason can only say "unavailable" — the log is where the distinction survives');
    });

    it('logs when the branch probe was stopped, because the PR list silently widens', async () => {
      const lines = await captureWarnings(async () => {
        const saved = prCheckStep._internal.exec;
        try {
          prCheckStep._internal.exec = async () => shellKill;
          const branch = await prCheckStep._internal.getCurrentBranch(os.tmpdir());
          assert.equal(branch, null);
        } finally {
          prCheckStep._internal.exec = saved;
        }
      });

      assert.ok(lines.some((l) => /branch probe was stopped/.test(l)),
        'null widens the step from this session to every open PR — that needs a trace');
    });

    it('does NOT log for an ordinary non-zero exit', async () => {
      // The falsifying half: if the log fired on every failure it would say
      // nothing about whether the probe answered.
      const lines = await captureWarnings(async () => {
        const saved = prCheckStep._internal.exec;
        try {
          prCheckStep._internal.exec = async () => refused(1, 'not a git repository');
          await prCheckStep._internal.getCurrentBranch(os.tmpdir());
        } finally {
          prCheckStep._internal.exec = saved;
        }
      });

      assert.ok(!lines.some((l) => /was stopped/.test(l)),
        'a command that answered is not a stopped probe');
    });
  });

  describe('continuity-write — best-effort by contract, so the log is the only trace', () => {
    it('logs when the map-delta diff was stopped', async () => {
      const lines = await captureWarnings(async () => {
        const saved = continuityStep._internal.exec;
        try {
          continuityStep._internal.exec = async (file, args) => {
            const cmd = `${file} ${args.join(' ')}`;
            if (cmd.startsWith('git rev-parse --verify --quiet main')) return ok('abc\n');
            if (cmd.startsWith('git diff --name-status')) return argvKill;
            return ok();
          };
          const delta = await continuityStep._mapDelta(os.tmpdir());
          assert.deepEqual(delta, { touched: [], deleted: [] },
            'the safe degrade is unchanged — the Map is left alone');
        } finally {
          continuityStep._internal.exec = saved;
        }
      });

      assert.ok(lines.some((l) => /git probe was stopped/.test(l)),
        'a Map left untouched must not look the same as a session that touched nothing');
    });

    it('logs when the base-branch probe was stopped', async () => {
      const lines = await captureWarnings(async () => {
        const saved = continuityStep._internal.exec;
        try {
          continuityStep._internal.exec = async () => argvKill;
          const base = await continuityStep._resolveBase(os.tmpdir());
          assert.equal(base, null);
        } finally {
          continuityStep._internal.exec = saved;
        }
      });

      assert.ok(lines.some((l) => /git probe was stopped/.test(l)));
    });

    it('does NOT log when a probe genuinely answers no', async () => {
      const lines = await captureWarnings(async () => {
        const saved = continuityStep._internal.exec;
        try {
          continuityStep._internal.exec = async () => refused(1);
          await continuityStep._resolveBase(os.tmpdir());
        } finally {
          continuityStep._internal.exec = saved;
        }
      });

      assert.ok(!lines.some((l) => /was stopped/.test(l)));
    });
  });
});
