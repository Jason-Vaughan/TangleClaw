'use strict';

/**
 * The wrap's `files:` stamp records THIS SESSION's changed set (#797).
 *
 * The reported defect was a set disjoint from the wrap's own commit: the step
 * diffed `<trunk>...<tip>` — every commit on the branch, across every session
 * that built it — and then filtered the result through the Feature Index's
 * source-file allowlist, which drops the `.tangleclaw/` paths a wrap commit is
 * almost entirely made of. Two independent errors landing on one field.
 *
 * These cases run against a REAL git repository with a real multi-session
 * history. A stubbed `git diff` proves the parser, not the range, and the range
 * is the defect: the assertion that matters is set equality against
 * `git diff --name-only` over the session's own commits, which only real history
 * can produce. (Also why the run here is the disjoint-set proof inverted — the
 * predecessor session's paths must be ABSENT.)
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { initRepo } = require('./_temp-repo');
const { setLevel, getLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const step = require('../lib/wrap-steps/continuity-write');
const continuity = require('../lib/continuity');
const transcript = require('../lib/transcript');

describe('continuity-write — the files: stamp is the session\'s own set (#797)', () => {
  let root;
  let repo;
  let origToday;
  let origClaudeHome;
  /** Commit shas from the fixture history, by label. */
  let sha;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-prov-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * Run git in the fixture repo.
   * @param {...string} args - Argv after `git`.
   * @returns {string} stdout, trimmed.
   */
  function git(...args) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  }

  /**
   * Write files and commit them.
   * @param {string} message - Commit subject.
   * @param {Record<string,string>} files - Relative path → contents.
   * @returns {string} The new commit's full sha.
   */
  function commit(message, files) {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(repo, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(root, 'repo-'));
    initRepo(repo, ['-b', 'main']);
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');

    sha = {};
    // Trunk, then a long-lived feature branch carrying two sessions of work —
    // the shape #797 was observed on (RentalClaw's `feat/airbnb-gateway-skill`).
    sha.trunk = commit('trunk', { 'README.md': 'root\n' });
    git('checkout', '-q', '-b', 'feat/long-lived');
    sha.session1Work = commit('session 1 work', {
      'skills/gateway/SKILL.md': 'one\n',
      'package.json': '{}\n'
    });
    sha.session1Wrap = commit('Session wrap 1', {
      '.tangleclaw/memories/MEMORY.md': 'session 1\n'
    });
    sha.session2Work = commit('session 2 work', { 'lib/two.js': "'use strict';\n" });
    sha.session2Wrap = commit('Session wrap 2', {
      '.tangleclaw/memories/wrap-log.md': 'session 2\n',
      '.tangleclaw/project-version.txt': '1.2.3\n'
    });

    origToday = step._internal.today;
    origClaudeHome = transcript._internal.claudeHome;
    step._internal.today = () => '2026-06-15';
    transcript._internal.claudeHome = () => path.join(root, 'no-claude-home');
  });

  afterEach(() => {
    step._internal.today = origToday;
    transcript._internal.claudeHome = origClaudeHome;
  });

  /**
   * A runner context whose commit-step result matches what `commit.js` reports.
   * @param {object} commitOutput - The commit step's output fields.
   * @param {number} [sid=2] - Session id.
   * @returns {object} Pipeline context.
   */
  function ctx(commitOutput, sid = 2) {
    return {
      project: { id: 1, name: 'demo', path: repo },
      session: { id: sid, engineId: 'claude' },
      step: {},
      staged: {},
      options: {},
      previousResults: [
        { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 'did work', nextSteps: 'next' } } },
        { stepId: 'commit', status: 'done', output: commitOutput }
      ]
    };
  }

  /** @returns {string[]} The `files:` list recorded for session `sid`. */
  function recordedFiles(sid = 2) {
    const meta = continuity.readWrapSummary(repo, sid).meta;
    return meta.files ? meta.files.split(',').map((s) => s.trim()).filter(Boolean) : [];
  }

  it('equals `git diff --name-only` over the session\'s own range', async () => {
    // What `commit.js` reports on session 2's wrap: the boundary it replaced is
    // session 1's stamp — that wrap commit's parent (#664).
    const res = await step.run(ctx({
      commitSha: sha.session2Wrap,
      branch: 'feat/long-lived',
      previousWrapSha: sha.session1Work
    }));
    assert.equal(res.ok, true);

    const expected = git('diff', '--name-only', `${sha.session1Work}..${sha.session2Wrap}`)
      .split('\n').filter(Boolean);
    assert.deepEqual(recordedFiles().sort(), expected.sort(),
      'the record is the session range verbatim, not a subset of it');
  });

  it('excludes the predecessor session\'s paths — the disjoint-set proof inverted', async () => {
    await step.run(ctx({
      commitSha: sha.session2Wrap,
      branch: 'feat/long-lived',
      previousWrapSha: sha.session1Work
    }));
    const files = recordedFiles();

    // These are exactly the paths #797 saw recorded for a session that never
    // touched them: earlier branch work, carried forward by the trunk-wide diff.
    assert.ok(!files.includes('skills/gateway/SKILL.md'),
      'a path from an earlier session must not appear in this session\'s record');
    assert.ok(!files.includes('package.json'));
    assert.ok(!files.includes('README.md'), 'trunk content is not this session\'s work');
  });

  it('keeps the .tangleclaw/ paths the wrap commit actually contains', async () => {
    await step.run(ctx({
      commitSha: sha.session2Wrap,
      branch: 'feat/long-lived',
      previousWrapSha: sha.session1Work
    }));
    const files = recordedFiles();

    // The other half of #797: every path in the wrap's own commit was filtered
    // out by the Feature Index allowlist, so the record omitted the commit.
    assert.ok(files.includes('.tangleclaw/memories/wrap-log.md'));
    assert.ok(files.includes('.tangleclaw/project-version.txt'));
    assert.ok(files.includes('lib/two.js'), 'and the session\'s source work is still there');
  });

  it('records the predecessor\'s wrap commit, which the durable boundary includes', async () => {
    // Not a defect to fix here: `lastWrapSha` records the wrap commit's PARENT
    // because the wrap commit itself is orphaned by squash-merge (#664), so a
    // session's range necessarily opens with the previous wrap's commit. Pinned
    // so the over-report is a known property rather than a surprise.
    await step.run(ctx({
      commitSha: sha.session2Wrap,
      branch: 'feat/long-lived',
      previousWrapSha: sha.session1Work
    }));
    assert.ok(recordedFiles().includes('.tangleclaw/memories/MEMORY.md'));
  });

  it('still indexes only source files into the Map', async () => {
    await step.run(ctx({
      commitSha: sha.session2Wrap,
      branch: 'feat/long-lived',
      previousWrapSha: sha.session1Work
    }));
    const map = continuity.parseIndex(fs.readFileSync(continuity.indexPath(repo), 'utf8')).map;
    assert.match(map, /lib\/two\.js/, 'the Map stubs source files');
    assert.doesNotMatch(map, /project-version\.txt/,
      'the allowlist still guards the Map — it is the files: stamp that drops it');
  });

  it('measures to the wrap commit, not HEAD, after the close-loop moves the checkout', async () => {
    // #467: the commit step may return the checkout to the original branch
    // before this step runs. HEAD is then trunk and a HEAD-anchored range is
    // empty — the session would record nothing at all.
    git('checkout', '-q', 'main');
    await step.run(ctx({
      commitSha: sha.session2Wrap,
      branch: 'feat/long-lived',
      previousWrapSha: sha.session1Work
    }));
    assert.ok(recordedFiles().includes('lib/two.js'),
      'the range ends at the wrap commit the step was handed');
  });

  it('records the branch\'s divergence on a project that has never wrapped', async () => {
    // No boundary recorded means no earlier session, so the branch's divergence
    // from trunk IS this session's work — an established read, not a default.
    await step.run(ctx({
      commitSha: sha.session2Wrap,
      branch: 'feat/long-lived',
      previousWrapSha: null
    }));
    const expected = git('diff', '--name-only', `main...${sha.session2Wrap}`)
      .split('\n').filter(Boolean);
    assert.deepEqual(recordedFiles().sort(), expected.sort());
  });

  it('records NO files when a recorded boundary will not resolve', async () => {
    // The boundary exists but is orphaned (rebased away, or a fresh clone). The
    // trunk fallback would answer a different question — every path the BRANCH
    // changed — and publishing that as the session's set is the #797 shape. The
    // wrap says nothing instead.
    const res = await step.run(ctx({
      commitSha: sha.session2Wrap,
      branch: 'feat/long-lived',
      previousWrapSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    }));
    assert.equal(res.ok, true, 'an unestablished read never halts a wrap');
    assert.deepEqual(recordedFiles(), []);

    const changelog = fs.readFileSync(continuity.changelogPath(repo), 'utf8');
    assert.doesNotMatch(changelog, /files:/, 'no line at all, rather than an empty one');
  });

  it('says out loud that the stamp was withheld, and why', async () => {
    // Withholding is only defensible if it is visible. This step is best-effort
    // by contract — it writes an index either way and returns ok — so the log
    // line is the ONLY place the difference between "changed nothing" and
    // "could not tell" survives.
    const lines = [];
    const prior = getLevel();
    setLevel('warn');
    setConsoleStream({ write: (t) => lines.push(t) });
    try {
      await step.run(ctx({
        commitSha: sha.session2Wrap,
        branch: 'feat/long-lived',
        previousWrapSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
      }));
    } finally {
      setConsoleStream(null);
      setLevel(prior);
    }
    const withheld = lines.find((l) => /records no files: stamp/.test(l));
    assert.ok(withheld, `no line named the withheld stamp: ${lines.join(' | ')}`);
    assert.match(withheld, /not an ancestor/, 'the line says WHY, not just that it happened');
    assert.match(withheld, /remediation/, 'and what the operator can do about it');
  });

  it('says nothing when the stamp is written normally', async () => {
    const lines = [];
    const prior = getLevel();
    setLevel('warn');
    setConsoleStream({ write: (t) => lines.push(t) });
    try {
      await step.run(ctx({
        commitSha: sha.session2Wrap,
        branch: 'feat/long-lived',
        previousWrapSha: sha.session1Work
      }));
    } finally {
      setConsoleStream(null);
      setLevel(prior);
    }
    assert.ok(!lines.some((l) => /records no files: stamp/.test(l)),
      'a warning on the healthy path teaches operators to ignore it');
  });

  it('still maintains the Map when the files: stamp is withheld', async () => {
    // Withholding the stamp is about what the record CLAIMS. The Map accretes
    // stubs an operator later describes and re-stubbing is idempotent, so a
    // wider range costs it nothing and starving it would lose real entries.
    await step.run(ctx({
      commitSha: sha.session2Wrap,
      branch: 'feat/long-lived',
      previousWrapSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    }));
    const map = continuity.parseIndex(fs.readFileSync(continuity.indexPath(repo), 'utf8')).map;
    assert.match(map, /lib\/two\.js/);
  });

  it('records nothing for a clean session, whose commit step skipped', async () => {
    const res = await step.run(ctx({
      reason: 'no changes to commit',
      flushed: [],
      commitSha: null,
      previousWrapSha: sha.session2Wrap
    }, 3));
    assert.equal(res.ok, true);
    assert.deepEqual(recordedFiles(3), [],
      'nothing was committed, so the session changed nothing');
  });

  it('_rangeIsSessionScoped only trusts a session range, or a branch range with no boundary', () => {
    assert.equal(step._rangeIsSessionScoped('session', 'abc1234'), true);
    assert.equal(step._rangeIsSessionScoped('session', null), true);
    assert.equal(step._rangeIsSessionScoped('branch', null), true, 'first wrap');
    assert.equal(step._rangeIsSessionScoped('branch', 'abc1234'), false, 'orphaned boundary');
    assert.equal(step._rangeIsSessionScoped(null, null), false, 'no range resolved at all');
  });

  it('_resolveCommitOutput finds the skip path\'s output, where the anchor is null', () => {
    const skipped = { reason: 'no changes to commit', commitSha: null, previousWrapSha: 'abc1234' };
    const results = [{ stepId: 'commit', status: 'skipped', output: skipped }];
    assert.equal(step._resolveCommitOutput(results), skipped,
      'a null commitSha still identifies the commit step — the boundary rides on it');
    assert.equal(step._resolveCommitAnchor(results), null, 'but there is no anchor to measure to');
    assert.equal(step._resolveCommitOutput([{ stepId: 'lint', output: { ok: true } }]), null);
    assert.equal(step._resolveCommitOutput(null), null);
  });
});
