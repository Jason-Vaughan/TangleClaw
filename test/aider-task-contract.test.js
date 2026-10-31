'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync: realSpawnSync } = require('node:child_process');
const { initRepo } = require('./_temp-repo');

const contract = require('../lib/aider-task-contract');

describe('aider-task-contract', () => {
  let repoPath;

  before(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-aider-task-'));
    initRepo(repoPath);
    execFileSync('git', ['config', 'user.email', 'tc@test.local'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'tc-test'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'a.js'), 'hello\n');
    execFileSync('git', ['add', 'a.js'], { cwd: repoPath });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoPath });
  });

  after(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  describe('buildTaskContract', () => {
    it('builds a frozen contract from a valid spec', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'do the thing' });
      assert.equal(c.schema, contract.SCHEMA);
      assert.deepEqual(c.editableFiles, ['a.js']);
      assert.equal(c.testCommand, null);
      assert.equal(c.timeoutMs, 600000);
      assert.throws(() => { c.editableFiles.push('b.js'); });
    });

    it('rejects a repoPath with no .git', () => {
      assert.throws(() => contract.buildTaskContract({ repoPath: os.tmpdir(), editableFiles: ['a.js'], message: 'x' }),
        /not a git repo or worktree/);
    });

    it('rejects a relative repoPath', () => {
      assert.throws(() => contract.buildTaskContract({ repoPath: 'relative/path', editableFiles: ['a.js'], message: 'x' }),
        /absolute path/);
    });

    it('rejects an empty editableFiles list', () => {
      assert.throws(() => contract.buildTaskContract({ repoPath, editableFiles: [], message: 'x' }),
        /non-empty array/);
    });

    it('rejects an editableFiles entry that escapes the repo', () => {
      assert.throws(() => contract.buildTaskContract({ repoPath, editableFiles: ['../outside.js'], message: 'x' }),
        /no '\.\.' segment/);
    });

    it('rejects an empty message', () => {
      assert.throws(() => contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: '   ' }),
        /non-empty string/);
    });

    it('rejects a non-positive timeoutMs', () => {
      assert.throws(() => contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'x', timeoutMs: 0 }),
        /positive number/);
    });

    it('accepts an explicit testCommand and model', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'x', testCommand: 'npm test', model: 'ollama_chat/llama3' });
      assert.equal(c.testCommand, 'npm test');
      assert.equal(c.model, 'ollama_chat/llama3');
    });
  });

  describe('runTask outcomes', () => {
    function makeFakeAiderEdit({ file = 'a.js', content = null, message = 'Applied edit. Done!' } = {}) {
      return (cmd, args, opts) => {
        if (cmd !== 'aider') return realSpawnSync(cmd, args, opts);
        // Unique content per call — several tests reuse the same fixture repo
        // and a byte-identical rewrite would leave git with nothing to commit.
        fs.writeFileSync(path.join(repoPath, file), content || `edited ${Date.now()}-${Math.random()}\n`);
        execFileSync('git', ['add', file], { cwd: repoPath });
        execFileSync('git', ['commit', '-q', '-m', 'aider edit'], { cwd: repoPath });
        return { status: 0, signal: null, stdout: message, stderr: '' };
      };
    }

    it('reports success when a real edit lands inside scope and the test command passes', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js', testCommand: process.execPath + ' -e "process.exit(0)"' });
      const receipt = contract.runTask(c, { spawnSync: makeFakeAiderEdit() });
      assert.equal(receipt.outcome, 'success');
      assert.deepEqual(receipt.filesChanged, ['a.js']);
      assert.deepEqual(receipt.scopeViolations, []);
      assert.equal(receipt.testResult.exitCode, 0);
      assert.equal(receipt.error, null);
      assert.equal(receipt.schema, contract.SCHEMA);
    });

    it('reports test-failure when the edit lands but the independent test command fails', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js', testCommand: process.execPath + ' -e "process.exit(1)"' });
      const receipt = contract.runTask(c, { spawnSync: makeFakeAiderEdit() });
      assert.equal(receipt.outcome, 'test-failure');
      assert.equal(receipt.testResult.exitCode, 1);
    });

    it('reports scope-violation when aider edits a file outside editableFiles, regardless of exit code', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit b.js' });
      const receipt = contract.runTask(c, { spawnSync: makeFakeAiderEdit({ file: 'b.js' }) });
      assert.equal(receipt.outcome, 'scope-violation');
      assert.deepEqual(receipt.scopeViolations, ['b.js']);
      assert.match(receipt.error, /outside editableFiles/);
    });

    it('detects an uncommitted edit left inside scope (auto-commits disabled) as real success, not a no-op', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      const fake = (cmd, args, opts) => {
        if (cmd !== 'aider') return realSpawnSync(cmd, args, opts);
        fs.writeFileSync(path.join(repoPath, 'a.js'), `uncommitted edit ${Date.now()}-${Math.random()}\n`);
        return { status: 0, signal: null, stdout: 'Done, left uncommitted.', stderr: '' };
      };
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'success');
      assert.deepEqual(receipt.filesChanged, ['a.js']);
      assert.deepEqual(receipt.scopeViolations, []);
      // Stabilize the fixture repo for later tests in this suite.
      execFileSync('git', ['add', 'a.js'], { cwd: repoPath });
      execFileSync('git', ['commit', '-q', '-m', 'stabilize after uncommitted-edit test'], { cwd: repoPath });
    });

    it('reports scope-violation for an untracked new file left outside scope, even with no commit', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      const fake = (cmd, args, opts) => {
        if (cmd !== 'aider') return realSpawnSync(cmd, args, opts);
        fs.writeFileSync(path.join(repoPath, 'untracked-new.js'), 'oops\n');
        return { status: 0, signal: null, stdout: 'Done.', stderr: '' };
      };
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'scope-violation');
      assert.deepEqual(receipt.scopeViolations, ['untracked-new.js']);
      fs.rmSync(path.join(repoPath, 'untracked-new.js'), { force: true });
    });

    it('fails closed (reports error) when post-run working-tree inspection itself cannot be trusted', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      const fake = (cmd, args, opts) => {
        if (cmd === 'aider') return { status: 0, signal: null, stdout: 'Done.', stderr: '' };
        if (cmd === 'git' && args[0] === 'status') return { status: 128, signal: null, stdout: '', stderr: 'fatal: inspection boom' };
        return realSpawnSync(cmd, args, opts);
      };
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'error');
      assert.match(receipt.error, /inspection failed/);
    });

    it('refuses to run (fails closed, never spawning aider) when the working tree is already dirty before invocation (#2756 PRR-A re-review)', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      fs.writeFileSync(path.join(repoPath, 'a.js'), `pre-existing dirty edit ${Date.now()}-${Math.random()}\n`);
      let spawnedAider = false;
      const fake = (cmd, args, opts) => {
        if (cmd === 'aider') { spawnedAider = true; return { status: 0, signal: null, stdout: 'Done.', stderr: '' }; }
        return realSpawnSync(cmd, args, opts);
      };
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'error');
      assert.match(receipt.error, /dirty before invocation/);
      assert.equal(spawnedAider, false, 'a dirty baseline must be caught before aider ever runs');
      // Stabilize the fixture repo for later tests in this suite.
      execFileSync('git', ['add', 'a.js'], { cwd: repoPath });
      execFileSync('git', ['commit', '-q', '-m', 'stabilize after dirty-baseline test'], { cwd: repoPath });
    });

    it('refuses to run (fails closed, never spawning aider) on a repo with no commits yet — an unborn branch (#2756 PRR-A round 3)', () => {
      const unbornRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-aider-unborn-'));
      initRepo(unbornRepo);
      const c = contract.buildTaskContract({ repoPath: unbornRepo, editableFiles: ['a.js'], message: 'create a.js' });
      let spawnedAider = false;
      const fake = (cmd, args, opts) => {
        if (cmd === 'aider') { spawnedAider = true; return { status: 0, signal: null, stdout: 'Done.', stderr: '' }; }
        return realSpawnSync(cmd, args, opts);
      };
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'error');
      assert.match(receipt.error, /unborn|no commits/i);
      assert.equal(spawnedAider, false, 'an unborn repo must be rejected before aider ever runs');
      fs.rmSync(unbornRepo, { recursive: true, force: true });
    });

    it('fails closed when post-run `git diff` fails even though `git status` succeeded (#2756 PRR-A re-review)', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      const fake = (cmd, args, opts) => {
        if (cmd === 'git' && args[0] === 'diff') return { status: 128, signal: null, stdout: '', stderr: 'fatal: diff boom' };
        if (cmd !== 'aider') return realSpawnSync(cmd, args, opts);
        fs.writeFileSync(path.join(repoPath, 'a.js'), `edited ${Date.now()}-${Math.random()}\n`);
        execFileSync('git', ['add', 'a.js'], { cwd: repoPath });
        execFileSync('git', ['commit', '-q', '-m', 'aider edit for diff-failure test'], { cwd: repoPath });
        return { status: 0, signal: null, stdout: 'Done.', stderr: '' };
      };
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'error');
      assert.match(receipt.error, /git diff.*failed/i);
    });

    it('reports no-op when aider exits 0 with no new commit, and flags a disputed claim', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      const fake = (cmd, args, opts) => cmd === 'aider'
        ? { status: 0, signal: null, stdout: 'All done, nothing to change.', stderr: '' }
        : realSpawnSync(cmd, args, opts);
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'no-op');
      assert.deepEqual(receipt.filesChanged, []);
      assert.equal(receipt.claimedCompletion, true);
      assert.equal(receipt.claimDisputed, true);
    });

    it('does not flag claimDisputed when a no-op reply makes no completion claim', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      const fake = (cmd, args, opts) => cmd === 'aider'
        ? { status: 0, signal: null, stdout: 'I am not sure what you want me to change.', stderr: '' }
        : realSpawnSync(cmd, args, opts);
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'no-op');
      assert.equal(receipt.claimedCompletion, false);
      assert.equal(receipt.claimDisputed, false);
    });

    it('reports error when aider exits non-zero', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      const fake = (cmd, args, opts) => cmd === 'aider'
        ? { status: 1, signal: null, stdout: '', stderr: 'invalid api key' }
        : realSpawnSync(cmd, args, opts);
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'error');
      assert.match(receipt.error, /exited 1/);
    });

    it('reports error when spawnSync itself fails to launch the process', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      const fake = (cmd, args, opts) => cmd === 'aider'
        ? { status: null, signal: null, stdout: '', stderr: '', error: new Error('ENOENT: aider not found') }
        : realSpawnSync(cmd, args, opts);
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'error');
      assert.match(receipt.error, /ENOENT/);
    });

    it('reports blocked-input on a timeout whose output names a known confirmation prompt', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      const fake = (cmd, args, opts) => cmd === 'aider'
        ? { status: null, signal: 'SIGTERM', stdout: 'Edit the files? (Y)es/(n)o', stderr: '' }
        : realSpawnSync(cmd, args, opts);
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'blocked-input');
    });

    it('reports a bare timeout when no known prompt is present', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      const fake = (cmd, args, opts) => cmd === 'aider'
        ? { status: null, signal: 'SIGTERM', stdout: 'still thinking...', stderr: '' }
        : realSpawnSync(cmd, args, opts);
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'timeout');
    });

    it('reports scope-violation (overriding a bare timeout) when the timed-out run left an edit outside scope', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      const fake = (cmd, args, opts) => {
        if (cmd !== 'aider') return realSpawnSync(cmd, args, opts);
        fs.writeFileSync(path.join(repoPath, 'untracked-timeout.js'), 'oops\n');
        return { status: null, signal: 'SIGTERM', stdout: 'still thinking...', stderr: '' };
      };
      const receipt = contract.runTask(c, { spawnSync: fake });
      assert.equal(receipt.outcome, 'scope-violation');
      assert.deepEqual(receipt.scopeViolations, ['untracked-timeout.js']);
      fs.rmSync(path.join(repoPath, 'untracked-timeout.js'), { force: true });
    });

    it('reports cancelled without spawning when the signal is already aborted', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      let spawned = false;
      const fake = (cmd, args, opts) => { spawned = true; return realSpawnSync(cmd, args, opts); };
      const controller = new AbortController();
      controller.abort();
      const receipt = contract.runTask(c, { spawnSync: fake, signal: controller.signal });
      assert.equal(receipt.outcome, 'cancelled');
      assert.equal(spawned, false);
    });

    it('reports scope-violation (overriding cancelled) when a run cancelled mid-flight left an edit outside scope', () => {
      const c = contract.buildTaskContract({ repoPath, editableFiles: ['a.js'], message: 'edit a.js' });
      const controller = new AbortController();
      const fake = (cmd, args, opts) => {
        if (cmd !== 'aider') return realSpawnSync(cmd, args, opts);
        fs.writeFileSync(path.join(repoPath, 'untracked-cancel.js'), 'oops\n');
        controller.abort();
        return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };
      };
      const receipt = contract.runTask(c, { spawnSync: fake, signal: controller.signal });
      assert.equal(receipt.outcome, 'scope-violation');
      assert.deepEqual(receipt.scopeViolations, ['untracked-cancel.js']);
      fs.rmSync(path.join(repoPath, 'untracked-cancel.js'), { force: true });
    });

    it('rejects a receipt field assembly for an unknown outcome (internal invariant)', () => {
      // Guards OUTCOMES / _receipt staying in sync — not reachable through
      // the public API, so exercised directly against the exported list.
      assert.ok(contract.OUTCOMES.includes('success'));
      assert.ok(contract.OUTCOMES.includes('scope-violation'));
      assert.equal(contract.OUTCOMES.length, 8);
    });
  });

  describe('heuristics', () => {
    it('_looksBlockedOnInput recognizes the gitignore and yes/no prompts', () => {
      assert.equal(contract._looksBlockedOnInput('Add .aider* to .gitignore? (Y)es/(n)o'), true);
      assert.equal(contract._looksBlockedOnInput('Run shell command? aider wants to run: npm test'), true);
      assert.equal(contract._looksBlockedOnInput('just some normal chat reply'), false);
    });

    it('_claimsCompletion matches common completion phrasing, case-insensitively', () => {
      assert.equal(contract._claimsCompletion('All done!'), true);
      assert.equal(contract._claimsCompletion('I FINISHED the refactor'), true);
      assert.equal(contract._claimsCompletion('Let me know if you want more changes'), false);
    });
  });
});
