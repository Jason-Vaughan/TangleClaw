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
const { setLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const commitStep = require('../lib/wrap-steps/commit');
const store = require('../lib/store');

const PR_URL = 'https://github.com/example/sandbox/pull/12';

describe('wrap-step commit — auto-PR close-loop (#467)', () => {
  let tmpDir;
  let storeDir;
  let projectPath;
  let projectId;
  let originals;
  let calls;
  let realExec;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-autopr-'));
    // A real store, so the #867 activity row is asserted against the same
    // insert path production uses rather than a stub. The project is created
    // for real because `activity_log.project_id` references `projects(id)` —
    // a fabricated id would be rejected and `store.activity.log` swallows the
    // failure, which would read as "the code never logged".
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-autopr-store-'));
    store._setBasePath(storeDir);
    store.init();
    originals = { ...commitStep._internal };
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  /**
   * The `wrap.auto_pr` rows this case produced. `store.activity.query`
   * already deserializes `detail`, so these read as plain objects. Scoped to
   * the per-case project id so one case cannot see another's rows.
   * @returns {object[]}
   */
  function autoPrRows() {
    return store.activity.query({ projectId, eventType: 'wrap.auto_pr', limit: 50 });
  }

  /**
   * Run `fn` with log output captured at `level`, restoring the quiet
   * error-level default afterwards so one case cannot make another noisy.
   * @param {string} level - Minimum level to capture
   * @param {Function} fn - Async body to run
   * @returns {Promise<string>} Everything written to the console stream
   */
  async function captureLogs(level, fn) {
    let out = '';
    setConsoleStream({ write: (s) => { out += s; } });
    setLevel(level);
    try {
      await fn();
    } finally {
      setLevel('error');
      setConsoleStream(null);
    }
    return out;
  }

  beforeEach(() => {
    Object.assign(commitStep._internal, originals);
    realExec = originals.exec;
    calls = [];
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    // One project record per case. `projects.name`/`path` are UNIQUE and the
    // store outlives the whole file, so a shared id would let each case see
    // the previous cases' activity rows and the counts below would drift.
    projectId = store.projects.create({
      name: `sandbox-${path.basename(projectPath)}`,
      path: projectPath
    }).id;
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
      project: { name: 'sandbox', path: projectPath, id: projectId },
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

  /*
   * #867 — the outcome must survive the log.
   *
   * A wrap pushed its branch, never opened a PR, and sat undiscovered for five
   * days; by the time it was found the server log covering it had rotated, so
   * which gate failed can never be known. The log line was the only record.
   * These cases pin the durable one: a queryable `wrap.auto_pr` row naming the
   * branch, written on every auto-branched wrap — and a warn, not an info, when
   * the branch is on the remote with no PR behind it.
   */
  describe('#867 — durable record of the auto-PR outcome', () => {
    it('records a wrap.auto_pr row naming the branch and the PR on full success', async () => {
      interceptExec();
      const result = await commitStep.run(buildContext());

      const rows = autoPrRows();
      assert.equal(rows.length, 1, 'one row per auto-branched wrap');
      assert.deepEqual(rows[0].detail, {
        branch: result.output.branch,
        pushed: true,
        prUrl: PR_URL,
        autoMergeArmed: true,
        stranded: false,
        skippedReason: null,
        error: null
      });
      assert.match(rows[0].detail.branch, /^wrap\//,
        'the branch name is the join key back to the stranded branch');
    });

    it('records the stranded case — pushed with no PR — which is the #867 signature', async () => {
      interceptExec({ 'gh-version': { exitCode: 127, stdout: '', stderr: 'command not found: gh\n' } });
      await commitStep.run(buildContext());

      const rows = autoPrRows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].detail.pushed, true);
      assert.equal(rows[0].detail.prUrl, null,
        'pushed with no prUrl is exactly the state that went undiscovered');
      assert.match(rows[0].detail.skippedReason, /gh CLI not available/);
    });

    it('records the error text when gh pr create fails, so the cause outlives the log', async () => {
      interceptExec({ 'gh-create': { exitCode: 1, stdout: '', stderr: 'GraphQL: something broke\n' } });
      await commitStep.run(buildContext());

      const rows = autoPrRows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].detail.pushed, true);
      assert.equal(rows[0].detail.prUrl, null);
      assert.match(rows[0].detail.error, /gh pr create failed/);
      assert.match(rows[0].detail.error, /something broke/,
        'the underlying gh stderr is what makes the failure attributable later');
    });

    it('records the pre-push refusals too, so "no row" never has to be interpreted', async () => {
      interceptExec({ remote: { exitCode: 2, stdout: '', stderr: 'error: No such remote' } });
      await commitStep.run(buildContext());

      const rows = autoPrRows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].detail.pushed, false);
      assert.match(rows[0].detail.skippedReason, /no origin remote/);
    });

    it('attributes the row to the session, so a stranded wrap names who left it', async () => {
      interceptExec({ 'gh-version': { exitCode: 127, stdout: '', stderr: 'command not found: gh\n' } });
      const ctx = buildContext();
      const sessionId = store.sessions.start({ projectId, engineId: 'claude' }).id;
      ctx.session = { id: sessionId };
      await commitStep.run(ctx);

      assert.equal(autoPrRows()[0].sessionId, sessionId,
        'the row must point back at the session that stranded the branch');
    });

    it('writes no row when the wrap did not auto-branch (nothing can dangle)', async () => {
      execSync('git checkout -b feat/regular --quiet', { cwd: projectPath });
      interceptExec();
      const result = await commitStep.run(buildContext());

      assert.equal(result.output.autoBranched, false);
      assert.equal(autoPrRows().length, 0,
        'a feature-branch wrap leaves no branch behind, so it has nothing to record');
    });

    it('a stranded wrap logs at warn — it used to log at info and read as success', async () => {
      const out = await captureLogs('info', async () => {
        interceptExec({ 'gh-version': { exitCode: 127, stdout: '', stderr: 'command not found: gh\n' } });
        await commitStep.run(buildContext());
      });

      const line = out.split('\n').find((l) => l.includes('auto-PR close-loop'));
      assert.ok(line, 'the close-loop must log its outcome');
      assert.match(line, /\[WARN\]/,
        'a pushed branch with no PR is not a success — info hid this for five days');
      assert.match(line, /degraded/);
    });

    it('a fully successful close-loop still logs at info, not warn', async () => {
      const out = await captureLogs('info', async () => {
        interceptExec();
        await commitStep.run(buildContext());
      });

      const line = out.split('\n').find((l) => l.includes('auto-PR close-loop'));
      assert.ok(line);
      assert.match(line, /\[INFO\]/, 'success must not be warned about — that trains the warning away');
      assert.match(line, /finished/);
    });

    it('an armed PR whose URL could not be parsed is NOT stranded — it will land', async () => {
      // `gh pr create` succeeds but prints nothing matching the URL pattern, so
      // `prUrl` is null. The arm step then falls back to the branch name and
      // still arms auto-merge, so the PR exists and merges. Calling that
      // stranded would cry wolf on the one shape that resolves itself.
      interceptExec({ 'gh-create': { exitCode: 0, stdout: 'Warning: something\n', stderr: '' } });
      await commitStep.run(buildContext());

      const rows = autoPrRows();
      assert.equal(rows[0].detail.prUrl, null);
      assert.equal(rows[0].detail.autoMergeArmed, true);
      assert.equal(rows[0].detail.stranded, false,
        'auto-merge armed means the PR exists and will land — not stranded');
    });

    it('bounds the persisted error the way the sibling push site bounds it', () => {
      const long = 'x'.repeat(500);
      assert.equal(commitStep._truncateForRecord(long).length, 201, '200 chars plus the ellipsis');
      assert.match(commitStep._truncateForRecord(long), /…$/);
      assert.equal(commitStep._truncateForRecord('short'), 'short');
      assert.equal(commitStep._truncateForRecord(null), null);
    });

    it('strips a credential embedded in a remote URL before persisting it', () => {
      // A failed `git push` echoes the remote. These rows are served over
      // GET /api/activity, and a bare `user:password@` matches none of
      // secret-scan's patterns — so truncation alone would have stored it.
      const out = commitStep._truncateForRecord(
        "fatal: could not read from 'https://jason:hunter2@github.com/x/y.git'"
      );
      assert.doesNotMatch(out, /hunter2/, 'the password must not reach the database');
      assert.match(out, /\/\/\*\*\*@github\.com/);
      assert.match(out, /could not read from/, 'the diagnostic value must survive redaction');
    });

    it('strips the password-LESS token form GitHub actually tells people to use', () => {
      // `https://<token>@host` carries no colon. A strip that required one
      // missed the single most likely credential in a push error, and
      // secret-scan only knows ghp_/github_pat_ — not gho_/ghs_/ghu_/ghr_,
      // and nothing at all for GitLab, Bitbucket or self-hosted forges.
      const out = commitStep._truncateForRecord(
        "remote: error\nfatal: unable to access 'https://gho_notarealtoken@gitlab.example.com/x/y.git/'"
      );
      assert.doesNotMatch(out, /gho_notarealtoken/, 'the token must not reach the database');
      assert.match(out, /\/\/\*\*\*@gitlab\.example\.com/);
    });

    it('leaves a credential-free URL alone — the strip cannot over-match', () => {
      const url = "fatal: could not read from 'https://github.com/x/y.git'";
      assert.equal(commitStep._truncateForRecord(url), url);
    });

    it('replaces — never truncates — text still matching a known secret pattern', () => {
      const out = commitStep._truncateForRecord(`remote: rejected, token ghp_${'a'.repeat(36)}`);
      assert.match(out, /^\[redacted — github-token detected/,
        'a truncated secret is still a secret, so the text is replaced wholesale');
      assert.doesNotMatch(out, /ghp_/);
    });

    it('the opt-out logs at info: it pushes nothing, so nothing is stranded', async () => {
      const cfg = store.projectConfig.load(projectPath);
      cfg.wrapAutoPrEnabled = false;
      store.projectConfig.save(projectPath, cfg);

      const out = await captureLogs('info', async () => {
        interceptExec();
        await commitStep.run(buildContext());
      });

      const line = out.split('\n').find((l) => l.includes('auto-PR close-loop'));
      assert.ok(line);
      assert.match(line, /\[INFO\]/,
        'a deliberate opt-out must not warn, or the warning stops meaning anything');
    });
  });
});
