'use strict';

/*
 * The shared child-process runner (#1561): the error classification every
 * caller reads, and the prompt-free environment every child gets. Each case
 * runs a real child process, because hand-written models of child_process error
 * shapes were wrong three times in this repo (#894).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { execShell, execFileArgs, didNotRun, describeFailure, NO_PROMPT_ENV } = require('../lib/exec');
const doubles = require('./_exec-results');

const OPTS = { cwd: os.tmpdir(), timeoutMs: 10000, maxBufferBytes: 1024 * 1024 };
const PRINT_ENV = 'process.stdout.write(JSON.stringify({g: process.env.GIT_TERMINAL_PROMPT, h: process.env.GH_PROMPT_DISABLED, k: process.env.TC_EXEC_TEST_KEEP || null}))';

describe('lib/exec — shared runner (#1561)', () => {
  describe('errorCode', () => {
    it('names a missing executable as ENOENT and reports it as a run failure', async () => {
      const r = await execFileArgs('tc-no-such-binary-1561', [], OPTS);
      assert.equal(r.errorCode, 'ENOENT');
      assert.equal(r.timedOut, false);
      assert.notEqual(r.exitCode, 0);
      assert.match(r.error, /ENOENT/);
    });

    it('names a missing working directory as ENOENT too', async () => {
      const r = await execFileArgs(process.execPath, ['-e', '0'], { ...OPTS, cwd: '/nonexistent/tc-1561' });
      assert.equal(r.errorCode, 'ENOENT');
    });

    it('is null for a command that ran and exited non-zero, which is an answer', async () => {
      const r = await execFileArgs(process.execPath, ['-e', 'process.exit(3)'], OPTS);
      assert.equal(r.exitCode, 3);
      assert.equal(r.errorCode, null);
      assert.equal(r.error, null);
    });

    it('is null for a success', async () => {
      const r = await execShell('true', OPTS);
      assert.deepEqual([r.exitCode, r.errorCode, r.timedOut], [0, null, false]);
    });

    it('is null for a timeout, which timedOut answers', async () => {
      const r = await execFileArgs(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { ...OPTS, timeoutMs: 300 });
      assert.equal(r.timedOut, true);
      assert.equal(r.errorCode, null);
    });

    it('records a signal that was not our timeout, and is not an answer', async () => {
      const r = await execFileArgs(process.execPath, ['-e', 'process.kill(process.pid, "SIGABRT")'], OPTS);
      assert.equal(r.signal, 'SIGABRT');
      assert.equal(r.timedOut, false);
      assert.equal(didNotRun(r), true);
    });

    it('names an output overflow', async () => {
      const r = await execFileArgs(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], { ...OPTS, maxBufferBytes: 100 });
      assert.equal(r.errorCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    });
  });

  describe('didNotRun and describeFailure', () => {
    const d = doubles;
    it('treats only a run without an answer as not run', () => {
      assert.equal(didNotRun(d.exited('no', 2)), false);
      for (const r of [d.notFound('git'), d.stopped(), d.spawnFailed('git', 'EACCES'), d.killedBy('git x')]) {
        assert.equal(didNotRun(r), true, JSON.stringify(r));
      }
    });

    const cases = [
      ['a missing program', d.notFound('gh'), 'gh is not installed'],
      ['a timeout, with the timeout that applied', d.stopped(300), 'gh pr list timed out after 300ms'],
      ['a signal', d.killedBy('gh pr list', 'SIGKILL'), 'gh pr list was stopped by SIGKILL'],
      ['another spawn failure', d.spawnFailed('gh', 'EACCES'), 'gh pr list could not run (EACCES)'],
      ['the first line gh printed', d.exited('\n  HTTP 401: Bad credentials\nmore\n', 1), 'gh pr list failed: HTTP 401: Bad credentials'],
      ['stdout when stderr is empty', { ...d.exited('', 4), stdout: 'from stdout\n' }, 'gh pr list failed: from stdout'],
      ['the exit code when nothing was printed', d.exited('', 3), 'gh pr list failed (exit 3)']
    ];
    for (const [label, r, want] of cases) {
      it(`words ${label}`, () => assert.equal(describeFailure(r, 'gh pr list'), want));
    }

    it('redacts a token, and keeps the exit code when the whole line is replaced', () => {
      const withUrl = describeFailure(d.exited("fatal: unable to access 'https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r/'", 128), 'git ls-remote');
      assert.doesNotMatch(withUrl, /ghp_/);
      const bare = describeFailure(d.exited('ghp_abcdefghijklmnopqrstuvwxyz0123456789', 1), 'git ls-remote');
      assert.doesNotMatch(bare, /ghp_/);
      assert.match(bare, /^git ls-remote failed \(exit 1\): \[redacted/);
    });
  });

  describe('callers', () => {
    // Each caller's REAL default runner, not a stub: a module that drifted back
    // to its own execFile wrapper would lose the prompt settings silently.
    const callers = [
      ['lib/stranded-check.js', () => require('../lib/stranded-check')._internal.exec],
      ['lib/stranded-check.js#exec', () => require('../lib/stranded-check').exec],
      ['lib/ci-status.js', () => require('../lib/ci-status')._internal.exec],
      ['lib/gh-issue-state.js', () => require('../lib/gh-issue-state')._internal.exec],
      ['lib/wrap-pr-status.js', () => require('../lib/wrap-pr-status')._internal.exec]
    ];
    for (const [name, get] of callers) {
      it(`${name} runs children with prompts disabled and the shared result shape`, async () => {
        const r = await get()(process.execPath, ['-e', PRINT_ENV], { cwd: os.tmpdir() });
        assert.deepEqual(JSON.parse(r.stdout), { g: '0', h: '1', k: null });
        assert.equal(r.timedOut, false);
        assert.equal(r.errorCode, null);
        const missing = await get()('tc-no-such-binary-1561', [], { cwd: os.tmpdir() });
        assert.equal(missing.errorCode, 'ENOENT');
      });
    }

    const optionSeams = [
      ['the background update check', () => require('../lib/update-checker')._lsRemoteOptions()],
      ['the update check\'s synchronous git calls', () => require('../lib/update-checker')._syncGitOptions(2000)],
      ['the update applier\'s git calls', () => require('../lib/update-applier')._gitOptions()]
    ];
    for (const [name, get] of optionSeams) {
      it(`${name} run git with prompts disabled`, () => {
        const opts = get();
        assert.equal(opts.env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(opts.env.GH_PROMPT_DISABLED, '1');
        assert.equal(opts.env.PATH, process.env.PATH, 'the rest of the environment is kept');
      });
    }
  });

  describe('git calls outside the runner, run for real', () => {
    // A git alias that prints the two variables, so the check reads what git
    // itself was started with.
    const ALIAS = ['-c', 'alias.tcenv=!printf %s:%s "$GIT_TERMINAL_PROMPT" "$GH_PROMPT_DISABLED"', 'tcenv'];

    it('the update applier\'s git seam', () => {
      assert.equal(String(require('../lib/update-applier')._internal.git(ALIAS)).trim(), '0:1');
    });

    it('the update check\'s synchronous git runner', () => {
      const cmd = `-c 'alias.tcenv=!printf %s:%s "$GIT_TERMINAL_PROMPT" "$GH_PROMPT_DISABLED"' tcenv`;
      assert.equal(String(require('../lib/update-checker')._syncGit(cmd, 5000)).trim(), '0:1');
    });

    it('the update check\'s synchronous calls go through that runner', () => {
      const checker = require('../lib/update-checker');
      const src = checker._internal.lsRemoteSync.toString() + checker._internal.gitRemote.toString();
      assert.doesNotMatch(src, /execSync/, 'both use _syncGit rather than their own execSync options');
    });
  });

  describe('the test doubles in test/_exec-results.js', () => {
    it('match a real missing executable', async () => {
      const r = await execFileArgs('tc-no-such-binary-1561', [], OPTS);
      assert.deepEqual(doubles.notFound('tc-no-such-binary-1561'), r);
    });

    it('match a real timeout', async () => {
      const r = await execFileArgs(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { ...OPTS, timeoutMs: 300 });
      assert.deepEqual(doubles.stopped(300), r);
    });

    it('match a real non-zero exit', async () => {
      const r = await execFileArgs(process.execPath, ['-e', 'process.stderr.write("no"); process.exit(2)'], OPTS);
      assert.deepEqual(doubles.exited('no', 2), r);
    });

    it('match a real signal kill', async () => {
      const args = ['-e', 'process.kill(process.pid, "SIGABRT")'];
      const r = await execFileArgs(process.execPath, args, OPTS);
      assert.deepEqual(doubles.killedBy(`${process.execPath} ${args.join(' ')}`), { ...r, error: r.error.trim() });
    });

    it('match a real spawn failure other than ENOENT', async () => {
      const fs = require('node:fs');
      const path = require('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-exec-'));
      const file = path.join(dir, 'not-executable');
      fs.writeFileSync(file, '#!/bin/sh\n');
      fs.chmodSync(file, 0o644);
      try {
        const r = await execFileArgs(file, [], OPTS);
        assert.deepEqual(doubles.spawnFailed(file, 'EACCES'), r);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('no prompts', () => {
    it('exports the two variables it sets', () => {
      assert.deepEqual({ ...NO_PROMPT_ENV }, { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });
      assert.ok(Object.isFrozen(NO_PROMPT_ENV));
    });

    it('reaches an argv-form child', async () => {
      const r = await execFileArgs(process.execPath, ['-e', PRINT_ENV], OPTS);
      assert.deepEqual(JSON.parse(r.stdout), { g: '0', h: '1', k: null });
    });

    it('reaches a shell-form child', async () => {
      const r = await execShell(`"${process.execPath}" -e '${PRINT_ENV}'`, OPTS);
      assert.deepEqual(JSON.parse(r.stdout), { g: '0', h: '1', k: null });
    });

    it('is layered over a caller\'s own env, keeping its variables and overriding a prompt setting', async () => {
      const env = { ...process.env, TC_EXEC_TEST_KEEP: 'kept', GIT_TERMINAL_PROMPT: '1' };
      const r = await execFileArgs(process.execPath, ['-e', PRINT_ENV], { ...OPTS, env });
      assert.deepEqual(JSON.parse(r.stdout), { g: '0', h: '1', k: 'kept' });
      assert.equal(env.GIT_TERMINAL_PROMPT, '1', 'the caller\'s object is not modified');
    });
  });
});
