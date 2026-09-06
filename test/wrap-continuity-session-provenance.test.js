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
      previousWrapSha: sha.session1Work,
      previousWrapShaRead: 'recorded'
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
      previousWrapSha: sha.session1Work,
      previousWrapShaRead: 'recorded'
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
      previousWrapSha: sha.session1Work,
      previousWrapShaRead: 'recorded'
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
      previousWrapSha: sha.session1Work,
      previousWrapShaRead: 'recorded'
    }));
    assert.ok(recordedFiles().includes('.tangleclaw/memories/MEMORY.md'));
  });

  it('still indexes only source files into the Map', async () => {
    await step.run(ctx({
      commitSha: sha.session2Wrap,
      branch: 'feat/long-lived',
      previousWrapSha: sha.session1Work,
      previousWrapShaRead: 'recorded'
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
      previousWrapSha: sha.session1Work,
      previousWrapShaRead: 'recorded'
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
      previousWrapSha: null,
      previousWrapShaRead: 'absent'
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
      previousWrapSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      previousWrapShaRead: 'recorded'
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
        previousWrapSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        previousWrapShaRead: 'recorded'
      }));
    } finally {
      setConsoleStream(null);
      setLevel(prior);
    }
    const withheld = lines.find((l) => /range could not be established/.test(l));
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
        previousWrapSha: sha.session1Work,
        previousWrapShaRead: 'recorded'
      }));
    } finally {
      setConsoleStream(null);
      setLevel(prior);
    }
    assert.ok(!lines.some((l) => /range could not be established/.test(l)),
      'a warning on the healthy path teaches operators to ignore it');
  });

  it('still maintains the Map when the files: stamp is withheld', async () => {
    // Withholding the stamp is about what the record CLAIMS. The Map accretes
    // stubs an operator later describes and re-stubbing is idempotent, so a
    // wider range costs it nothing and starving it would lose real entries.
    await step.run(ctx({
      commitSha: sha.session2Wrap,
      branch: 'feat/long-lived',
      previousWrapSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      previousWrapShaRead: 'recorded'
    }));
    const map = continuity.parseIndex(fs.readFileSync(continuity.indexPath(repo), 'utf8')).map;
    assert.match(map, /lib\/two\.js/);
  });

  it('measures the range as usual when the commit step skipped — a wrap that committed nothing is not a session that changed nothing', async () => {
    // The commit step skips on a clean tree, which a session that committed BY
    // HAND reaches with real work behind it. `commitSha: null` is also what the
    // committed path returns when `git rev-parse HEAD` fails after the commit
    // landed. Publishing the empty set on either would drop real work from a
    // provenance record — #797's own second half — so every path goes through
    // `_stampDecision` and the range answers.
    const res = await step.run(ctx({
      reason: 'no changes to commit',
      flushed: [],
      commitSha: null,
      previousWrapSha: sha.session2Work,
      previousWrapShaRead: 'recorded'
    }, 3));
    assert.equal(res.ok, true);

    // No anchor, so the tip is HEAD — the branch tip in this fixture.
    const expected = git('diff', '--name-only', `${sha.session2Work}..HEAD`)
      .split('\n').filter(Boolean);
    assert.deepEqual(recordedFiles(3).sort(), expected.sort(),
      'the range since the boundary, not a fabricated empty set');
    assert.ok(expected.length > 0, 'the fixture must reach a non-empty range, or this proves nothing');
  });

  it('names a stopped probe rather than asserting a cause it cannot know', async () => {
    // A killed `merge-base --is-ancestor` produces the same `kind: 'branch'` as a
    // genuine negative, and the withheld-stamp warning would otherwise send the
    // operator to check a boundary that is perfectly fine.
    const realExec = step._internal.exec;
    step._internal.exec = async (file, args, opts) => {
      if (args.includes('--is-ancestor')) {
        return { exitCode: 124, stdout: '', stderr: '', error: 'timed out', timedOut: true };
      }
      return realExec(file, args, opts);
    };
    const lines = [];
    const prior = getLevel();
    setLevel('warn');
    setConsoleStream({ write: (t) => lines.push(t) });
    try {
      await step.run(ctx({
        commitSha: sha.session2Wrap,
        branch: 'feat/long-lived',
        previousWrapSha: sha.session1Work,
        previousWrapShaRead: 'recorded'
      }, 8));
    } finally {
      setConsoleStream(null);
      setLevel(prior);
      step._internal.exec = realExec;
    }
    assert.deepEqual(recordedFiles(8), [], 'an unknown answer publishes nothing');
    const withheld = lines.find((l) => /range could not be established/.test(l));
    assert.ok(withheld, `no withheld line: ${lines.join(' | ')}`);
    assert.match(withheld, /stopped before it answered/,
      'the reason must say the negative may be an unknown answer, not a fact');
    assert.match(withheld, /is-ancestor/, 'and name which probe');
  });

  it('says a resolved range whose diff would not answer is exactly that', async () => {
    // Three conditions used to arrive as one `kind: null` and be reported as
    // "this is not a repository, or it has no trunk branch" — sending the
    // operator to hunt a trunk branch that is sitting right there.
    const realExec = step._internal.exec;
    step._internal.exec = async (file, args, opts) => {
      if (args.includes('--name-status')) {
        return { exitCode: 128, stdout: '', stderr: 'fatal: bad object\n', error: null, timedOut: false };
      }
      return realExec(file, args, opts);
    };
    const lines = [];
    const prior = getLevel();
    setLevel('warn');
    setConsoleStream({ write: (t) => lines.push(t) });
    try {
      await step.run(ctx({
        commitSha: sha.session2Wrap,
        branch: 'feat/long-lived',
        previousWrapSha: sha.session1Work,
        previousWrapShaRead: 'recorded'
      }, 9));
    } finally {
      setConsoleStream(null);
      setLevel(prior);
      step._internal.exec = realExec;
    }
    assert.deepEqual(recordedFiles(9), []);
    assert.ok(lines.some((l) => /session delta was refused/.test(l)),
      'the refusal gets its own line — it previously had none at any level');
    const withheld = lines.find((l) => /range could not be established/.test(l));
    assert.ok(withheld, `no withheld line: ${lines.join(' | ')}`);
    assert.match(withheld, /diff did not answer/, 'and the cause is the diff, not a missing trunk');
    assert.doesNotMatch(withheld, /not a repository/);
  });

  it('withholds the stamp when the config could not be read', async () => {
    // `store.projectConfig.load` returns defaults for a malformed config rather
    // than throwing, so a null boundary there is not "never wrapped" — a real
    // boundary is probably on disk, unread, while the branch behind this wrap
    // carries earlier sessions.
    await step.run(ctx({
      commitSha: sha.session2Wrap,
      branch: 'feat/long-lived',
      previousWrapSha: null,
      previousWrapShaRead: 'unreadable'
    }));
    assert.deepEqual(recordedFiles(), []);
  });

  it('withholds the stamp when no commit step reported at all', async () => {
    // `blocker` is operator-overridable, so a BLOCKED commit can reach this step,
    // and its output carries no `commitSha` key. The absence of a report is not
    // the absence of a boundary — reading it as one republishes the whole branch.
    const res = await step.run({
      project: { id: 1, name: 'demo', path: repo },
      session: { id: 7, engineId: 'claude' },
      step: {},
      staged: {},
      options: {},
      previousResults: [
        { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: 's', nextSteps: 'n' } } },
        { stepId: 'commit', status: 'blocked', output: { remediation: 'nothing was committed' } }
      ]
    });
    assert.equal(res.ok, true);
    assert.deepEqual(recordedFiles(7), []);
  });

  it('_stampDecision publishes only on an established range, and names every refusal', () => {
    const d = (kind, boundaryRead, commitStepReported = true) =>
      step._stampDecision({ kind, commitStepReported, boundaryRead });

    assert.equal(d('session', 'recorded').publish, true);
    assert.equal(d('branch', 'absent').publish, true, 'no wrap has ever stamped — the branch IS all there is');

    // The three nulls that are not interchangeable, plus a range that resolved to
    // nothing. Each refuses, and each says something different about why.
    const refusals = [
      d('branch', 'recorded'),
      d('branch', 'unreadable'),
      d('session', 'unreadable'),
      d('branch', null, false),
      d(null, 'recorded')
    ];
    for (const r of refusals) {
      assert.equal(r.publish, false);
      assert.ok(r.why && r.why.length > 0, 'a refusal that cannot say why is not a refusal');
    }
    assert.equal(new Set(refusals.map((r) => r.why)).size, 4,
      'the distinct causes get distinct explanations');
    assert.match(d('diff-failed', 'recorded').why, /diff did not answer/);
    assert.match(
      step._stampDecision({ kind: 'branch', commitStepReported: true, boundaryRead: 'recorded', stopped: ['git merge-base --is-ancestor a b'] }).why,
      /stopped before it answered/,
      'a negative taken on an unknown answer says so');
    assert.equal(d('session', 'recorded').why, null, 'nothing to explain when it publishes');
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

describe('commit → continuity-write — the two steps agree on the boundary (#797)', () => {
  // The cases above hand-write the commit step's output, which proves what
  // `continuity-write` does with a shape but not that the shape is the one
  // `commit` produces. This drives the real producer into the real consumer:
  // rename the field on either side and this goes red where the others stay
  // green.
  let root;
  let repo;
  let origToday;
  let origClaudeHome;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-prov2-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(root, 'repo-'));
    initRepo(repo, ['-b', 'main']);
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'README.md'), 'root\n');
    git('add', '-A');
    git('commit', '-qm', 'trunk');

    origToday = step._internal.today;
    origClaudeHome = transcript._internal.claudeHome;
    step._internal.today = () => '2026-06-15';
    transcript._internal.claudeHome = () => path.join(root, 'no-claude-home');
  });

  afterEach(() => {
    step._internal.today = origToday;
    transcript._internal.claudeHome = origClaudeHome;
  });

  it('a second session records its own files, not the first session\'s', async () => {
    const commitStep = require('../lib/wrap-steps/commit');
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const project = { id: 1, name: 'demo', path: repo };

    /**
     * Run the commit step, then feed its real result to continuity-write.
     * @param {number} sid - Session id.
     * @returns {Promise<object>} The commit step's result.
     */
    async function wrap(sid) {
      const commitRes = await commitStep.run({
        project, session: { id: sid, engineId: 'claude' }, step: {}, staged: {}, options: {}
      });
      await step.run({
        project,
        session: { id: sid, engineId: 'claude' },
        step: {},
        staged: {},
        options: {},
        previousResults: [
          { stepId: 'memory-update', status: 'done', output: { parsedFields: { summary: `s${sid}`, nextSteps: 'n' } } },
          { stepId: 'commit', status: commitRes.status, output: commitRes.output }
        ]
      });
      return commitRes;
    }

    // `commit` runs `git add -A` on whatever the working tree holds, and
    // auto-branches off a protected branch, so the sessions run on a branch.
    git('checkout', '-q', '-b', 'feat/two-sessions');

    fs.writeFileSync(path.join(repo, 'first.js'), 'one\n');
    const first = await wrap(1);
    assert.equal(first.ok, true);
    assert.ok(first.output.commitSha, 'session 1 committed');
    const stampedBySession1 = require('../lib/store').projectConfig.load(repo).lastWrapSha;
    assert.ok(stampedBySession1, 'session 1 left a boundary behind');

    fs.writeFileSync(path.join(repo, 'second.js'), 'two\n');
    const second = await wrap(2);
    assert.equal(second.ok, true);
    assert.equal(second.output.previousWrapSha, stampedBySession1,
      'the boundary session 2 reports is the one session 1 stamped — the handoff itself');

    const files2 = continuity.readWrapSummary(repo, 2).meta.files.split(',').map((f) => f.trim());
    assert.ok(files2.includes('second.js'), 'session 2 records its own work');

    // The record is the boundary handoff's range, verbatim — asserted against
    // git rather than against a list, so it stays true as the boundary's own
    // semantics evolve.
    const expected = execFileSync('git',
      ['diff', '--name-only', `${stampedBySession1}..${second.output.commitSha}`],
      { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    assert.deepEqual(files2.sort(), expected.sort());

    // And the boundary's reach, named rather than assumed: `lastWrapSha` records
    // the wrap commit's PARENT so it survives squash-merge (#664), so a session
    // whose only commit IS its wrap commit leaves a boundary that precedes its
    // own work. Session 1 is that shape here, so `first.js` is in range. The
    // field means "changed since the previous wrap's recorded boundary" — the
    // same range every other wrap step measures — not "changed by exactly this
    // session's commits", and #797 is fixed by making it the former instead of
    // the whole branch.
    assert.ok(files2.includes('first.js'),
      'the boundary precedes session 1\'s wrap commit, so its work is in range');
  });
});
