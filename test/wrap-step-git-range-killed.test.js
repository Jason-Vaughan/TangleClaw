'use strict';

/**
 * The SYNCHRONOUS half of "a killed command is not a failed one" (#897).
 *
 * `_git-range`, `features-toc` and `changelog-coverage` all reach git through
 * `execSync`, and all three answer their question by catching a non-zero exit.
 * That makes a command our own timeout killed indistinguishable from a
 * confident negative answer — and every negative answer here widens what the
 * wrap measures or blocks on:
 *
 *   - a stopped `merge-base --is-ancestor` reads as "the recorded SHA is
 *     orphaned" and abandons `<sha>..HEAD` for the whole trunk divergence;
 *   - a stopped `rev-parse --verify main` reads as "this repo has no main",
 *     which is reported to the operator as a fact;
 *   - a stopped `git log` makes `changelog-coverage` return `unavailable`,
 *     which the ai-content gate maps to the mutation-check fallback — so the
 *     operator is blocked with "CHANGELOG.md is unchanged" by a predicate that
 *     never ran.
 *
 * `execSync` reports a timeout as `code: 'ETIMEDOUT'` with `signal: 'SIGTERM'`
 * and — unlike the async APIs — **no `killed` flag at all**, because that flag
 * belongs to `spawnSync`'s result object rather than to the error it throws.
 * Three authors modelled that wrongly in #894. So the errors driven through
 * these seams are never hand-built: `realTimeoutError()` produces one by
 * actually killing a real process.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const os = require('node:os');

const { wasTimedOut } = require('../lib/exec-timeout');
const gitRange = require('../lib/wrap-steps/_git-range');
const changelogCoverage = require('../lib/wrap-steps/changelog-coverage');

/**
 * Produce a genuine `execSync` timeout error by killing a real process.
 *
 * The subject of these guards is a failure MODE, so it is spawned rather than
 * described — a hand-written `{code: 'ETIMEDOUT'}` would assert this file's
 * model of the shape, which is precisely what was broken. The one concession is
 * that the error is then REUSED through the injected `exec` seam: these
 * functions build their own git command strings, so a stalling command cannot
 * be passed in from outside. The object is still one a real kill produced.
 *
 * @returns {Error} The error a real killed `execSync` threw.
 */
function realTimeoutError() {
  try {
    execSync('sleep 30', { timeout: 300, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    return err;
  }
  throw new Error('sleep 30 was not killed by a 300ms timeout — the fixture is not producing a kill');
}

describe('a real execSync kill is recognised as a kill (#897)', () => {
  it('carries no `killed` flag, which is why three hand-written checks were dead', () => {
    const err = realTimeoutError();

    assert.equal(err.killed, undefined,
      'if this ever becomes true, the shape changed and the comments explaining #894 are stale');
    assert.equal(err.code, 'ETIMEDOUT');
    assert.equal(wasTimedOut(err), true, 'the shared predicate must recognise the real shape');
  });

  it('an ordinary non-zero exit is not a timeout', () => {
    let err;
    try {
      execSync('exit 3', { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { err = e; }

    assert.equal(wasTimedOut(err), false, 'exit 3 answered — it was not killed');
  });
});

describe('_git-range reports a stopped probe instead of a negative answer (#897)', () => {
  const killed = () => { throw realTimeoutError(); };
  const succeeds = () => Buffer.from('');

  it('isAncestorOfHead still answers false, but names the probe as stopped', () => {
    const stopped = [];
    const answer = gitRange.isAncestorOfHead('/tmp', 'abc1234', killed, (c) => stopped.push(c));

    assert.equal(answer, false, 'falling back on an unknown answer is still the safe move');
    assert.equal(stopped.length, 1, 'but the caller must be able to tell unknown from negative');
    assert.match(stopped[0], /merge-base --is-ancestor/);
  });

  it('isResolvableCommit reports a stopped probe', () => {
    const stopped = [];
    const answer = gitRange.isResolvableCommit('/tmp', 'abc1234', killed, (c) => stopped.push(c));

    assert.equal(answer, false);
    assert.match(stopped[0], /rev-parse --verify/);
  });

  it('resolveBaseBranch reports a stopped probe per candidate it could not read', () => {
    const stopped = [];
    const answer = gitRange.resolveBaseBranch('/tmp', killed, (c) => stopped.push(c));

    assert.equal(answer, null);
    assert.equal(stopped.length, 2, 'both main and master were probed and neither answered');
  });

  it('a probe that genuinely says no is NOT reported as stopped', () => {
    // The falsifying half: if `_noteIfStopped` fired on every catch, the field
    // would be meaningless. An ordinary non-zero exit must leave it empty.
    const stopped = [];
    const refuses = () => {
      const err = new Error('Command failed');
      err.status = 1;
      throw err;
    };
    const answer = gitRange.isAncestorOfHead('/tmp', 'abc1234', refuses, (c) => stopped.push(c));

    assert.equal(answer, false);
    assert.deepEqual(stopped, [], 'a real negative answer is not a stopped probe');
  });

  it('resolveSessionRange surfaces the stopped probes alongside the range it fell back to', () => {
    // The costly case: the SHA is well-formed and resolvable, but the ancestry
    // probe is killed — so the session range silently widens from
    // `<sha>..HEAD` to the whole trunk divergence.
    let call = 0;
    const exec = (command) => {
      call += 1;
      // 1st: rev-parse --verify <sha>^{commit} → resolves.
      if (call === 1) return Buffer.from('');
      // 2nd: merge-base --is-ancestor → killed.
      if (call === 2) throw realTimeoutError();
      // 3rd: rev-parse --verify main → resolves, giving the fallback range.
      return Buffer.from('');
    };

    const resolved = gitRange.resolveSessionRange('/tmp', 'abcdef1234567', { dots: 'two', exec });

    assert.equal(resolved.kind, 'branch', 'it fell back, as it should on an unknown answer');
    assert.equal(resolved.range, 'main..HEAD');
    assert.equal(resolved.stopped.length, 1,
      'the fallback was taken on an UNKNOWN answer and the result must say so');
    assert.match(resolved.stopped[0], /merge-base --is-ancestor/);
  });

  it('a range resolved with no stopped probes reports an empty list', () => {
    const resolved = gitRange.resolveSessionRange('/tmp', 'abcdef1234567', {
      dots: 'two', exec: () => Buffer.from('')
    });

    assert.equal(resolved.kind, 'session');
    assert.deepEqual(resolved.stopped, []);
  });
});

describe('changelog-coverage explains an unavailable verdict honestly (#897)', () => {
  // `unavailable` is not inert — `ai-content.js#_satisfactionPredicateGate` maps
  // it to the mutation-check fallback, which BLOCKS a wrap whose changelog is
  // untouched this turn. So these reason strings are read by a blocked operator.

  it('a killed `git log` says the commits are unknown, not that the range failed', () => {
    const savedExec = changelogCoverage._internal.execSync;
    const savedCfg = changelogCoverage._internal.loadProjectConfig;
    try {
      changelogCoverage._internal.loadProjectConfig = () => ({ lastWrapSha: null });
      let call = 0;
      changelogCoverage._internal.execSync = (command) => {
        call += 1;
        // The range resolves off `main`; the `git log` that follows is killed.
        if (String(command).startsWith('git log')) throw realTimeoutError();
        return Buffer.from('');
      };

      const r = changelogCoverage.evaluate('/tmp', ['CHANGELOG.md'], []);

      assert.equal(r.verdict, changelogCoverage.VERDICTS.UNAVAILABLE);
      assert.match(r.reason, /was stopped/);
      assert.match(r.reason, /unknown/,
        'the operator must not read this as "there are no commits"');
      assert.ok(call > 1, 'the git log call was actually reached');
    } finally {
      changelogCoverage._internal.execSync = savedExec;
      changelogCoverage._internal.loadProjectConfig = savedCfg;
    }
  });

  it('a killed working-tree read says the uncommitted files are unknown', () => {
    const savedExec = changelogCoverage._internal.execSync;
    const savedCfg = changelogCoverage._internal.loadProjectConfig;
    try {
      changelogCoverage._internal.loadProjectConfig = () => ({ lastWrapSha: null });
      changelogCoverage._internal.execSync = (command) => {
        const cmd = String(command);
        if (cmd.startsWith('git diff --name-only --relative HEAD')) throw realTimeoutError();
        if (cmd.startsWith('git log')) return Buffer.from('');
        return Buffer.from('');
      };

      const r = changelogCoverage.evaluate('/tmp', ['CHANGELOG.md'], []);

      assert.equal(r.verdict, changelogCoverage.VERDICTS.UNAVAILABLE);
      assert.match(r.reason, /was stopped/);
      assert.match(r.reason, /uncommitted files are unknown/);
    } finally {
      changelogCoverage._internal.execSync = savedExec;
      changelogCoverage._internal.loadProjectConfig = savedCfg;
    }
  });

  it('a killed range probe does not claim the repo has no main or master', () => {
    const savedExec = changelogCoverage._internal.execSync;
    const savedCfg = changelogCoverage._internal.loadProjectConfig;
    try {
      changelogCoverage._internal.loadProjectConfig = () => ({ lastWrapSha: null });
      changelogCoverage._internal.execSync = () => { throw realTimeoutError(); };

      const r = changelogCoverage.evaluate('/tmp', ['CHANGELOG.md'], []);

      assert.equal(r.verdict, changelogCoverage.VERDICTS.UNAVAILABLE);
      assert.match(r.reason, /stopped before answering/);
      assert.doesNotMatch(r.reason, /no main\/master base branch/,
        'a stopped probe is no evidence about which branches this repo has');
    } finally {
      changelogCoverage._internal.execSync = savedExec;
      changelogCoverage._internal.loadProjectConfig = savedCfg;
    }
  });

  it('a genuinely missing trunk branch keeps its original wording', () => {
    // The other direction — the new message must not swallow the real case.
    const savedExec = changelogCoverage._internal.execSync;
    const savedCfg = changelogCoverage._internal.loadProjectConfig;
    try {
      changelogCoverage._internal.loadProjectConfig = () => ({ lastWrapSha: null });
      changelogCoverage._internal.execSync = () => {
        const err = new Error('Command failed');
        err.status = 1;
        throw err;
      };

      const r = changelogCoverage.evaluate('/tmp', ['CHANGELOG.md'], []);

      assert.equal(r.verdict, changelogCoverage.VERDICTS.UNAVAILABLE);
      assert.match(r.reason, /no main\/master base branch/);
    } finally {
      changelogCoverage._internal.execSync = savedExec;
      changelogCoverage._internal.loadProjectConfig = savedCfg;
    }
  });
});

describe('features-toc names a stopped probe rather than a fact (#897)', () => {
  const featuresToc = require('../lib/wrap-steps/features-toc');
  const store = require('../lib/store');
  const fs = require('node:fs');
  const path = require('node:path');

  let tmpDir;
  let projectPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-897-features-toc-'));
    projectPath = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'FEATURES.md'), '# Feature Index\n');
  });

  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /**
   * Run the handler with the project config and `execSync` both scripted.
   *
   * @param {object} projConfig - What `store.projectConfig.load` returns.
   * @param {(command:string) => Buffer} exec - The scripted `execSync`.
   * @returns {Promise<object>} The step result.
   */
  async function runWith(projConfig, exec) {
    const savedExec = featuresToc._internal.execSync;
    const savedLoad = store.projectConfig.load;
    try {
      store.projectConfig.load = () => projConfig;
      featuresToc._internal.execSync = exec;
      return await featuresToc.run({
        project: { name: 'p', path: projectPath },
        step: { id: 'features-toc' },
        staged: {}
      });
    } finally {
      featuresToc._internal.execSync = savedExec;
      store.projectConfig.load = savedLoad;
    }
  }

  it('a killed `git diff` is not reported as a diff that failed', async () => {
    const r = await runWith({ featureIndexEnabled: true, lastWrapSha: null }, (command) => {
      if (String(command).startsWith('git diff')) throw realTimeoutError();
      return Buffer.from('');
    });

    assert.equal(r.status, 'skipped');
    assert.match(r.output.reason, /was stopped/);
    assert.doesNotMatch(r.output.reason, /git diff failed/,
      'the old wording said "failed" about a command that never answered');
    assert.match(r.output.reason, /unknown/);
  });

  it('an ordinary `git diff` failure keeps its original wording', async () => {
    const r = await runWith({ featureIndexEnabled: true, lastWrapSha: null }, (command) => {
      if (String(command).startsWith('git diff')) {
        const err = new Error('Command failed: git diff');
        err.status = 128;
        throw err;
      }
      return Buffer.from('');
    });

    assert.match(r.output.reason, /git diff failed/);
  });

  it('a killed range probe does not claim the repo has no main or master', async () => {
    const r = await runWith(
      { featureIndexEnabled: true, lastWrapSha: null },
      () => { throw realTimeoutError(); }
    );

    assert.equal(r.status, 'skipped');
    assert.match(r.output.reason, /stopped before answering/);
    assert.doesNotMatch(r.output.reason, /no main\/master base branch/);
  });

  it('a genuinely trunk-less repo keeps its original skip reason', async () => {
    const r = await runWith({ featureIndexEnabled: true, lastWrapSha: null }, () => {
      const err = new Error('Command failed');
      err.status = 1;
      throw err;
    });

    assert.match(r.output.reason, /no main\/master base branch/);
  });

  it('a resolved-but-WIDENED range says so — the case with the highest cost', async () => {
    // The costliest stopped-probe case does NOT reach the no-range branch: a
    // killed `merge-base --is-ancestor` still resolves a range (the trunk
    // fallback), so the step reports an entirely ordinary outcome computed over
    // a range that was silently widened.
    const SHA = 'abcdef1234567';
    const r = await runWith({ featureIndexEnabled: true, lastWrapSha: SHA }, (command) => {
      const cmd = String(command);
      if (cmd.includes('merge-base --is-ancestor')) throw realTimeoutError();
      // Everything else resolves; the diff is empty.
      return Buffer.from('');
    });

    assert.equal(r.status, 'skipped');
    assert.match(r.output.reason, /no files touched in main\.\.\.HEAD/,
      'the fallback range is still used — that part is correct');
    assert.match(r.output.reason, /stopped before answering/,
      '"no files touched" must not read as a fact about the session');
    assert.match(r.output.reason, /unknown answer/);
  });

  it('an undegraded empty range keeps the plain wording', async () => {
    const SHA = 'abcdef1234567';
    const r = await runWith(
      { featureIndexEnabled: true, lastWrapSha: SHA },
      () => Buffer.from('')
    );

    assert.match(r.output.reason, /^no files touched in abcdef1234567\.\.HEAD$/,
      'no caveat when every probe answered');
  });
});

describe('a widened range reaches the operator who is blocked by it (#897)', () => {
  const aiContent = require('../lib/wrap-steps/ai-content');

  it('changelog-coverage flags an uncovered verdict computed over a guessed range', () => {
    const savedExec = changelogCoverage._internal.execSync;
    const savedCfg = changelogCoverage._internal.loadProjectConfig;
    try {
      changelogCoverage._internal.loadProjectConfig = () => ({ lastWrapSha: 'abcdef1234567' });
      changelogCoverage._internal.execSync = (command) => {
        const cmd = String(command);
        if (cmd.includes('merge-base --is-ancestor')) throw realTimeoutError();
        if (cmd.startsWith('git log')) {
          // One judged commit that never touched the changelog.
          return Buffer.from('\x1eabc123\x1fp1\x1fAdd a thing\nlib/thing.js\n');
        }
        return Buffer.from('');
      };

      const r = changelogCoverage.evaluate('/tmp', ['CHANGELOG.md'], []);

      assert.equal(r.verdict, changelogCoverage.VERDICTS.UNCOVERED);
      assert.match(r.reason, /stopped before answering/,
        'the commit list may reach past this session and the operator must be told');
      assert.match(r.reason, /may reach further back than this session/);
    } finally {
      changelogCoverage._internal.execSync = savedExec;
      changelogCoverage._internal.loadProjectConfig = savedCfg;
    }
  });

  it('an uncovered verdict over a confirmed range carries no caveat', () => {
    const savedExec = changelogCoverage._internal.execSync;
    const savedCfg = changelogCoverage._internal.loadProjectConfig;
    try {
      changelogCoverage._internal.loadProjectConfig = () => ({ lastWrapSha: 'abcdef1234567' });
      changelogCoverage._internal.execSync = (command) => {
        if (String(command).startsWith('git log')) {
          return Buffer.from('\x1eabc123\x1fp1\x1fAdd a thing\nlib/thing.js\n');
        }
        return Buffer.from('');
      };

      const r = changelogCoverage.evaluate('/tmp', ['CHANGELOG.md'], []);

      assert.equal(r.verdict, changelogCoverage.VERDICTS.UNCOVERED);
      assert.equal(r.reason, null, 'nothing to caveat when every probe answered');
    } finally {
      changelogCoverage._internal.execSync = savedExec;
      changelogCoverage._internal.loadProjectConfig = savedCfg;
    }
  });

  it('the ai-content gate renders the caveat into the block the operator reads', () => {
    // Without this the field would be one more unconsumed payload key — the
    // exact anti-pattern this branch cites when deleting lint's `output.timedOut`.
    const saved = aiContent._internal.changelogCoverage;
    try {
      aiContent._internal.changelogCoverage = () => ({
        verdict: 'uncovered',
        uncovered: [{ sha: 'abc1234def', subject: 'Add a thing' }],
        uncommittedWork: [],
        checkedCount: 1,
        range: 'main..HEAD',
        reason: '1 git probe(s) were stopped before answering (git merge-base --is-ancestor abc HEAD), so this range is a fallback taken on an unknown answer and may reach further back than this session'
      });

      // Driven through the real gate rather than the private predicate: the
      // snapshot is unchanged, which is exactly the condition that routes an
      // ai-content step into the coverage predicate on a live wrap.
      const block = aiContent._verifyChangedGate(
        '/tmp',
        { id: 'changelog-update', verifySatisfiedBy: 'changelog-coverage' },
        { 'CHANGELOG.md': null }
      );

      assert.ok(block, 'the block still stands — the changelog was not maintained');
      assert.match(block.remediation, /stopped before answering/);
      assert.match(block.remediation, /belong to this session before writing entries/);
    } finally {
      aiContent._internal.changelogCoverage = saved;
    }
  });

  it('an ordinary uncovered block is unchanged', () => {
    const saved = aiContent._internal.changelogCoverage;
    try {
      aiContent._internal.changelogCoverage = () => ({
        verdict: 'uncovered',
        uncovered: [{ sha: 'abc1234def', subject: 'Add a thing' }],
        uncommittedWork: [],
        checkedCount: 1,
        range: 'main..HEAD',
        reason: null
      });

      const block = aiContent._verifyChangedGate(
        '/tmp',
        { id: 'changelog-update', verifySatisfiedBy: 'changelog-coverage' },
        { 'CHANGELOG.md': null }
      );

      assert.ok(block);
      assert.doesNotMatch(block.remediation, /Note:/,
        'no caveat when the range was confirmed');
    } finally {
      aiContent._internal.changelogCoverage = saved;
    }
  });
});
