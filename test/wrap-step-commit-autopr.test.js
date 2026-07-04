'use strict';

/*
 * Tests for the commit step's auto-PR close-loop (#467).
 *
 * When the wrap commit auto-branches off a protected branch (#264), the
 * commit previously dangled on the `wrap/<ts>-<slug>` branch — nothing
 * landed it on main, so version bumps, CHANGELOG promotions, and
 * self-healed index files evaporated for the next session (the
 * #447/#450/#453 class; TangleBrain's every-wrap self-heal loop).
 *
 * The close-loop: push the wrap branch, open a PR back to the original
 * branch via `gh`, arm auto-merge, and return the checkout to the
 * original branch. Every sub-step is NON-FATAL — the commit already
 * landed; failures degrade to `output.autoPr.{error,remediation}`.
 *
 * Harness mirrors the #139 Chunk 9 commit-handler tests: real git
 * sandbox repos + targeted `_internal.exec` interception for the
 * network-touching calls (`git remote`, `git push`, `gh *`). All other
 * git commands hit the real sandbox repo.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const commitStep = require('../lib/wrap-steps/commit');
const store = require('../lib/store');

const PR_URL = 'https://github.com/example/sandbox/pull/12';

describe('wrap-step commit — auto-PR close-loop (#467)', () => {
  let tmpDir;
  let projectPath;
  let originals;
  let calls;
  let realExec;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-autopr-'));
    originals = { ...commitStep._internal };
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    Object.assign(commitStep._internal, originals);
    realExec = originals.exec;
    calls = [];
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    execSync('git init --quiet', { cwd: projectPath });
    execSync('git config user.email t@example.com && git config user.name Test',
      { cwd: projectPath, shell: '/bin/sh' });
    fs.writeFileSync(path.join(projectPath, 'README.md'), 'init\n');
    execSync('git add README.md && git commit --quiet -m init',
      { cwd: projectPath, shell: '/bin/sh' });
    execSync('git branch -M main', { cwd: projectPath });
    // Dirty the tree so the commit step has something to commit.
    fs.writeFileSync(path.join(projectPath, 'work.txt'), 'work\n');
  });

  /** Build a minimal context for the commit handler. */
  function buildContext() {
    return {
      project: { name: 'sandbox', path: projectPath, id: 1 },
      session: null,
      step: { id: 'commit', kind: 'commit', blocker: true },
      previousResults: [],
      staged: {},
      options: {}
    };
  }

  /**
   * Intercept the network-touching exec calls; pass everything else to
   * the real sandbox git. `overrides` maps a match key to a result (or
   * a function producing one). Keys:
   *   'remote'  — `git remote get-url origin`
   *   'push'    — `git push …`
   *   'gh-version' / 'gh-create' / 'gh-edit' / 'gh-merge'
   * Unlisted network calls default to success shapes.
   * @param {Record<string, object|Function>} overrides
   */
  function interceptExec(overrides = {}) {
    const defaults = {
      remote: { exitCode: 0, stdout: 'https://github.com/example/sandbox.git\n', stderr: '' },
      push: { exitCode: 0, stdout: '', stderr: '' },
      'gh-version': { exitCode: 0, stdout: 'gh version 2.60.0\n', stderr: '' },
      'gh-create': { exitCode: 0, stdout: `${PR_URL}\n`, stderr: '' },
      'gh-edit': { exitCode: 0, stdout: '', stderr: '' },
      'gh-merge': { exitCode: 0, stdout: '', stderr: '' }
    };
    const table = { ...defaults, ...overrides };
    commitStep._internal.exec = async (file, args, opts) => {
      let key = null;
      if (file === 'git' && args[0] === 'remote') key = 'remote';
      else if (file === 'git' && args[0] === 'push') key = 'push';
      else if (file === 'gh' && args[0] === '--version') key = 'gh-version';
      else if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') key = 'gh-create';
      else if (file === 'gh' && args[0] === 'pr' && args[1] === 'edit') key = 'gh-edit';
      else if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') key = 'gh-merge';
      if (key) {
        calls.push({ key, file, args });
        const entry = table[key];
        return typeof entry === 'function' ? entry(file, args) : entry;
      }
      calls.push({ key: null, file, args });
      return realExec(file, args, opts);
    };
  }

  function currentBranch() {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectPath }).toString().trim();
  }

  it('full success: pushes, opens PR, arms auto-merge, returns to the original branch', async () => {
    interceptExec();
    const result = await commitStep.run(buildContext());
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.equal(result.output.autoBranched, true);

    const ap = result.output.autoPr;
    assert.ok(ap, 'auto-branched commit must carry output.autoPr');
    assert.equal(ap.attempted, true);
    assert.equal(ap.pushed, true);
    assert.equal(ap.prUrl, PR_URL);
    assert.equal(ap.autoMergeArmed, true);
    assert.equal(ap.returnedToBranch, true);
    assert.equal(ap.error, null);

    // Push targeted the wrap branch with upstream tracking.
    const push = calls.find((c) => c.key === 'push');
    assert.deepEqual(push.args.slice(0, 3), ['push', '-u', 'origin']);
    assert.match(push.args[3], /^wrap\/\d{14}-sandbox$/);

    // PR created against the original branch with the wrap branch as head.
    const create = calls.find((c) => c.key === 'gh-create');
    const baseIdx = create.args.indexOf('--base');
    assert.equal(create.args[baseIdx + 1], 'main');
    const headIdx = create.args.indexOf('--head');
    assert.match(create.args[headIdx + 1], /^wrap\//);

    // Auto-merge armed with the house-rule flags.
    const merge = calls.find((c) => c.key === 'gh-merge');
    for (const flag of ['--auto', '--squash', '--delete-branch']) {
      assert.ok(merge.args.includes(flag), `merge must pass ${flag}`);
    }

    // Checkout returned to the original branch.
    assert.equal(currentBranch(), 'main');
  });

  it('PR body carries the wrap commit body lines and the What/Why sections', async () => {
    interceptExec();
    const ctx = buildContext();
    ctx.staged = {
      'version-bump:version-json': { oldVersion: '1.0.0', newVersion: '1.1.0', bumpLevel: 'minor' }
    };
    const result = await commitStep.run(ctx);
    assert.equal(result.output.autoPr.prUrl, PR_URL);
    const create = calls.find((c) => c.key === 'gh-create');
    const bodyIdx = create.args.indexOf('--body');
    const body = create.args[bodyIdx + 1];
    assert.match(body, /## What/);
    assert.match(body, /## Why/);
    assert.match(body, /- Bumped 1\.0\.0 → 1\.1\.0 \(minor\)/,
      'PR body must include the wrap commit body lines');
  });

  it('wrapAutoPrEnabled:false skips the close-loop entirely (no push attempted)', async () => {
    const cfg = store.projectConfig.load(projectPath);
    cfg.wrapAutoPrEnabled = false;
    store.projectConfig.save(projectPath, cfg);

    interceptExec();
    const result = await commitStep.run(buildContext());
    assert.equal(result.ok, true);
    const ap = result.output.autoPr;
    assert.equal(ap.attempted, false);
    assert.match(ap.skippedReason, /wrapAutoPrEnabled/);
    assert.equal(calls.some((c) => c.key === 'push'), false, 'must not push when opted out');
    assert.match(currentBranch(), /^wrap\//, 'opt-out keeps HEAD on the wrap branch (pre-#467 behavior)');
  });

  it('skips with reason when the repo has no origin remote', async () => {
    // No interception of `git remote` — the sandbox genuinely has no origin.
    interceptExec({ remote: { exitCode: 2, stdout: '', stderr: 'error: No such remote' } });
    const result = await commitStep.run(buildContext());
    assert.equal(result.ok, true);
    const ap = result.output.autoPr;
    assert.equal(ap.attempted, false);
    assert.match(ap.skippedReason, /no origin remote/);
    assert.equal(calls.some((c) => c.key === 'push'), false);
  });

  it('push failure is non-fatal: commit stays done, error + remediation surfaced, HEAD stays on wrap branch', async () => {
    interceptExec({ push: { exitCode: 128, stdout: '', stderr: 'fatal: could not read from remote\n' } });
    const result = await commitStep.run(buildContext());
    assert.equal(result.ok, true, 'the commit already landed — push failure must never block the wrap');
    const ap = result.output.autoPr;
    assert.equal(ap.attempted, true);
    assert.equal(ap.pushed, false);
    assert.match(ap.error, /git push failed/);
    assert.match(ap.error, /could not read from remote/);
    assert.equal(typeof ap.remediation, 'string');
    assert.match(currentBranch(), /^wrap\//, 'failed push keeps HEAD on the wrap branch for manual rescue');
  });

  it('gh unavailable: branch still pushed, PR skipped with remediation naming the manual command', async () => {
    interceptExec({ 'gh-version': { exitCode: 127, stdout: '', stderr: 'command not found: gh\n' } });
    const result = await commitStep.run(buildContext());
    const ap = result.output.autoPr;
    assert.equal(ap.pushed, true, 'push must happen even without gh — it preserves the branch remotely');
    assert.equal(ap.prUrl, null);
    assert.match(ap.skippedReason, /gh CLI not available/);
    assert.match(ap.remediation, /gh pr create/);
    assert.match(currentBranch(), /^wrap\//);
  });

  it('PR-create failure is non-fatal with error + remediation', async () => {
    interceptExec({ 'gh-create': { exitCode: 1, stdout: '', stderr: 'GraphQL: something broke\n' } });
    const result = await commitStep.run(buildContext());
    const ap = result.output.autoPr;
    assert.equal(ap.pushed, true);
    assert.equal(ap.prUrl, null);
    assert.match(ap.error, /gh pr create failed/);
    assert.match(ap.error, /something broke/);
    assert.equal(typeof ap.remediation, 'string');
    assert.match(currentBranch(), /^wrap\//);
  });

  it('auto-merge arm failure keeps the PR URL and points at repo auto-merge settings', async () => {
    interceptExec({ 'gh-merge': { exitCode: 1, stdout: '', stderr: 'auto-merge is not allowed on this repository\n' } });
    const result = await commitStep.run(buildContext());
    const ap = result.output.autoPr;
    assert.equal(ap.prUrl, PR_URL, 'PR was created — its URL must survive the merge-arm failure');
    assert.equal(ap.autoMergeArmed, false);
    assert.match(ap.error, /auto-merge/);
    assert.match(ap.remediation, /auto-merge|merge the PR manually/i);
    assert.match(currentBranch(), /^wrap\//,
      'un-armed PR keeps HEAD on the wrap branch — the operator resolves it');
  });

  it('label add is best-effort: a failing gh pr edit does not affect the outcome', async () => {
    interceptExec({ 'gh-edit': { exitCode: 1, stdout: '', stderr: 'label not found\n' } });
    const result = await commitStep.run(buildContext());
    const ap = result.output.autoPr;
    assert.equal(ap.autoMergeArmed, true);
    assert.equal(ap.error, null, 'label failure must not register as an error');
  });

  it('an exec throw inside the close-loop degrades to autoPr.error, never blocks the wrap', async () => {
    interceptExec({
      push: () => { throw new Error('spawn EPERM'); }
    });
    const result = await commitStep.run(buildContext());
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.ok(result.output.commitSha);
    const ap = result.output.autoPr;
    assert.match(ap.error, /EPERM/);
  });

  it('feature-branch wraps (not auto-branched) carry autoPr:null — no push, no PR', async () => {
    execSync('git checkout -b feat/regular --quiet', { cwd: projectPath });
    interceptExec();
    const result = await commitStep.run(buildContext());
    assert.equal(result.output.autoBranched, false);
    assert.equal(result.output.autoPr, null);
    assert.equal(calls.some((c) => c.key === 'push'), false);
  });

  it('allowDirectToMain wraps carry autoPr:null (nothing dangles — the commit is on main)', async () => {
    interceptExec();
    const ctx = buildContext();
    ctx.options = { allowDirectToMain: true };
    const result = await commitStep.run(ctx);
    assert.equal(result.output.autoBranched, false);
    assert.equal(result.output.autoPr, null);
  });

  it('DEFAULT_PROJECT_CONFIG pins wrapAutoPrEnabled:true (close-loop is the default)', () => {
    assert.equal(store.DEFAULT_PROJECT_CONFIG.wrapAutoPrEnabled, true);
  });
});
