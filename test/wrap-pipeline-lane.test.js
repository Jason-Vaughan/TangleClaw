'use strict';

/*
 * #2320 — a wrap in a project that works under a coordinator, driven through
 * the real pipeline runner with the real `priming-roll`, `commit`, `pr-check`
 * and `pr-merge` steps against a real git repository.
 *
 * The per-step suites prove each guard alone. This file proves what a wrap does
 * as a whole: the tracked priming file is left byte-identical, nothing arms
 * GitHub auto-merge at either place that can, and both reasons reach the rows a
 * person reads. Every lane case is paired with the same project naming no
 * coordinator, which must roll the file and arm, so a case here can never pass
 * because its fixture was unable to roll or arm in the first place.
 *
 * Nothing leaves the machine: `gh` is never run (every `gh` call is recorded
 * and answered here), pushes go to a local bare repository, and the repository
 * carries a proxy setting that makes any other network access fail locally.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { initRepo } = require('./_temp-repo');
const { setLevel, getLevel } = require('../lib/logger');

const store = require('../lib/store');
const wrapPipeline = require('../lib/wrap-pipeline');
const primingRoll = require('../lib/wrap-steps/priming-roll');
const commitStep = require('../lib/wrap-steps/commit');
const prCheck = require('../lib/wrap-steps/pr-check');
const prMerge = require('../lib/wrap-steps/pr-merge');
const drawer = require('../public/wrap-drawer.js');

/** The steps under proof; every other step is replaced by a no-op. */
const REAL_KINDS = ['priming-roll', 'commit', 'pr-check', 'pr-merge'];

const REMOTE = 'https://github.com/acme/widgets.git';
const PR_URL = 'https://github.com/acme/widgets/pull/7';
const PRIMING_REL = '.tangleclaw/priming/build-session.md';
const PRIMING = '# Build session priming\n\nShared text every lane reads.\n';
const PLAN = '# Lane plan\n\n### Chunk 1: First thing ✅\n\n### Chunk 2: Second thing\n\n### Chunk 3: Third thing\n';
const COORDINATOR = 'lane-pipeline-int';

describe('wrap pipeline — a project that works under a coordinator (#2320)', () => {
  let tmpDir, logLevel, restoreSteps, originals, ghCalls, counter;

  before(() => {
    logLevel = getLevel();
    setLevel('error');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-pipeline-lane-'));
    store._setBasePath(path.join(tmpDir, 'home'));
    store.init();
    counter = 0;
    originals = {
      commit: { ...commitStep._internal },
      prCheck: { ...prCheck._internal },
      prMerge: { ...prMerge._internal },
      priming: { ...primingRoll._internal }
    };
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setLevel(logLevel);
  });

  beforeEach(() => {
    ghCalls = [];
    const noop = { run: async () => ({ ok: true, status: 'done', output: null, blockers: [] }) };
    const replaced = {};
    for (const kind of Object.keys(wrapPipeline.STEP_DISPATCH)) {
      if (REAL_KINDS.includes(kind)) continue;
      replaced[kind] = wrapPipeline.STEP_DISPATCH[kind];
      wrapPipeline.STEP_DISPATCH[kind] = noop;
    }
    restoreSteps = () => Object.assign(wrapPipeline.STEP_DISPATCH, replaced);

    // `gh` is answered here and never run; git runs for real.
    commitStep._internal.exec = (file, args, options) => (file === 'gh'
      ? answerGh(args)
      : originals.commit.exec(file, args, options));
    prMerge._internal.exec = (file, args, options) => (file === 'gh'
      ? answerGh(args)
      : originals.prMerge.exec(file, args, options));
    prMerge._internal.execShell = async (command) => {
      assert.match(command, /^gh /, `pr-merge shelled out to something that is not gh: ${command}`);
      return answerGh(command.split(' ').slice(1));
    };
    prCheck._internal.isGhAvailable = async () => true;
    prCheck._internal.listOpenPrs = async () => ({ ok: true, prs: [], reason: null });
    // No issue lookup: the plan cites no issue, and a lookup would be a real gh.
    primingRoll._internal.lookupIssueStates = async () => { throw new Error('no issue lookup is expected'); };
  });

  afterEach(() => {
    restoreSteps();
    Object.assign(commitStep._internal, originals.commit);
    Object.assign(prCheck._internal, originals.prCheck);
    Object.assign(prMerge._internal, originals.prMerge);
    Object.assign(primingRoll._internal, originals.priming);
  });

  /**
   * Record a `gh` call and answer it the way GitHub's CLI would on success.
   * @param {string[]} args - The arguments after `gh`
   * @returns {Promise<{exitCode: number, stdout: string, stderr: string, error: null, timedOut: boolean}>}
   */
  async function answerGh(args) {
    ghCalls.push(args.join(' '));
    const stdout = args[0] === 'pr' && args[1] === 'create' ? `${PR_URL}\n` : '';
    return { exitCode: 0, stdout, stderr: '', error: null, timedOut: false };
  }

  /**
   * The `gh` calls that arm auto-merge.
   * @returns {string[]}
   */
  function armingCalls() {
    return ghCalls.filter((call) => /^pr merge\b/.test(call) && /--auto\b/.test(call));
  }

  /**
   * Make a registered project in its own repository, with a tracked priming
   * file, an in-progress plan, a pushed `main` and one active session that has
   * changed a tracked file.
   * @param {object} [shape] - What the project is like
   * @param {string|null} [shape.coordinator] - The coordinator its settings name, or null for none
   * @param {boolean} [shape.plan=true] - Whether it keeps a build plan
   * @returns {{project: object, dir: string, bare: string, git: Function}}
   */
  function makeProject({ coordinator = null, plan = true } = {}) {
    counter += 1;
    const name = `lane-pipeline-${counter}`;
    const dir = path.join(tmpDir, name);
    const bare = path.join(tmpDir, `${name}.git`);
    fs.mkdirSync(bare, { recursive: true });
    initRepo(bare, ['--bare', '--initial-branch=main']);
    fs.mkdirSync(path.join(dir, '.tangleclaw', 'priming'), { recursive: true });
    initRepo(dir, ['--initial-branch=main']);
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('config', 'user.email', 'lane@example.invalid');
    git('config', 'user.name', 'Lane');
    git('config', 'commit.gpgsign', 'false');
    git('remote', 'add', 'origin', REMOTE);
    // The remote reads as a github.com repository, which is what the merge
    // authority is keyed on; pushes land in the bare folder beside it.
    git('config', `url.${bare}.pushInsteadOf`, REMOTE);
    git('config', 'http.proxy', 'http://127.0.0.1:9');
    fs.writeFileSync(path.join(dir, '.tangleclaw', 'project.json'),
      JSON.stringify(coordinator ? { workloadNudge: { coordinatorProject: coordinator } } : {}));
    fs.writeFileSync(path.join(dir, PRIMING_REL), PRIMING);
    if (plan) {
      fs.mkdirSync(path.join(dir, '.tangleclaw', 'plans'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.tangleclaw', 'plans', 'lane-plan.md'), PLAN);
    }
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'first\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'Base');
    git('push', '-q', '-u', 'origin', 'main');

    const project = store.projects.create({ name, path: dir, engine: 'claude' });
    store.sessions.start({ projectId: project.id, engineId: 'claude' });
    return { project, dir, bare, git };
  }

  /**
   * The session's own work: one tracked file edited after the session began.
   * @param {string} dir - The project's folder
   * @returns {void}
   */
  function sessionEdits(dir) {
    fs.appendFileSync(path.join(dir, 'notes.txt'), 'changed during the session\n');
  }

  /**
   * One step's result out of a pipeline result.
   * @param {object} result - What `runWrapPipeline` returned
   * @param {string} stepId - The step's id
   * @returns {object}
   */
  function stepOf(result, stepId) {
    const found = result.results.find((r) => r.stepId === stepId);
    assert.ok(found, `the pipeline reported no "${stepId}" step`);
    return found;
  }

  /**
   * The row the wrap drawer builds for a step, which is what a person reads.
   * @param {object} step - One entry of the pipeline's `results`
   * @returns {object}
   */
  function rowOf(step) {
    return drawer.buildStepRow(step, {});
  }

  /**
   * The files the commit at `ref` changed.
   * @param {Function} git - The project's git runner
   * @param {string} ref - A commit
   * @returns {string[]}
   */
  function filesIn(git, ref) {
    return git('show', '--name-only', '--format=', ref).split('\n').filter(Boolean);
  }

  describe('a wrap fired from the protected branch', () => {
    it('leaves the priming file alone, opens its pull request unarmed, and says both reasons on the rows a person reads', async () => {
      const { project, dir, bare, git } = makeProject({ coordinator: COORDINATOR });
      sessionEdits(dir);

      const result = await wrapPipeline.runWrapPipeline(project.name);
      assert.equal(result.ok, true, `the wrap must finish: ${JSON.stringify(result.results.filter((r) => r.blockers.length))}`);

      // The priming guard.
      const priming = stepOf(result, 'next-session-prime');
      assert.equal(priming.status, 'skipped');
      assert.equal(priming.output.mergeAuthority.authority, 'integrator');
      assert.equal(fs.readFileSync(path.join(dir, PRIMING_REL), 'utf8'), PRIMING, 'the tracked priming file is byte-identical');
      assert.equal(git('status', '--porcelain', '--', PRIMING_REL), '', 'nothing is staged or changed for it');
      assert.equal(git('diff', '--name-only', 'main', 'HEAD', '--', PRIMING_REL), '', 'the wrap commit does not carry it');
      assert.ok(!filesIn(git, 'HEAD').includes(PRIMING_REL));
      const primingRow = rowOf(priming);
      assert.match(primingRow.detail, new RegExp(`this project works under ${COORDINATOR}`));
      assert.match(primingRow.detail, /the shared priming file is not rewritten/);

      // The arming guard, at the wrap's own pull request.
      const commit = stepOf(result, 'commit');
      assert.equal(commit.status, 'done', 'the session\'s work is still committed');
      assert.deepEqual(filesIn(git, 'HEAD'), ['notes.txt']);
      assert.match(git('rev-parse', '--abbrev-ref', 'HEAD'), /^wrap\//);
      assert.equal(commit.output.autoPr.pushed, true);
      assert.equal(commit.output.autoPr.prUrl, PR_URL);
      assert.equal(commit.output.autoPr.autoMergeArmed, false);
      assert.ok(ghCalls.some((call) => call.startsWith('pr create ')), 'the pull request is opened');
      assert.deepEqual(armingCalls(), [], 'no command arms auto-merge');
      const bareRefs = execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: bare, encoding: 'utf8' });
      assert.match(bareRefs, /refs\/heads\/wrap\//, 'the work is preserved on the remote');
      const commitRow = rowOf(commit);
      assert.match(commitRow.remediation, /auto-merge was deliberately not armed/);
      assert.match(commitRow.remediation, new RegExp(`${COORDINATOR} merges this pull request`));

      // One answer, stated on both rows.
      assert.deepEqual(
        { authority: priming.output.mergeAuthority.authority, integrator: priming.output.mergeAuthority.integrator },
        { authority: commit.output.autoPr.mergeAuthority.authority, integrator: commit.output.autoPr.mergeAuthority.integrator }
      );
    });

    it('rolls the priming file and arms auto-merge for the same project with no coordinator', async () => {
      const { project, dir, git } = makeProject({ coordinator: null });
      sessionEdits(dir);

      const result = await wrapPipeline.runWrapPipeline(project.name);
      assert.equal(result.ok, true, `the wrap must finish: ${JSON.stringify(result.results.filter((r) => r.blockers.length))}`);

      const priming = stepOf(result, 'next-session-prime');
      assert.equal(priming.status, 'done');
      assert.equal(priming.output.changed, true);
      const commit = stepOf(result, 'commit');
      const wrapSha = commit.output.commitSha;
      assert.ok(filesIn(git, wrapSha).includes(PRIMING_REL), 'the roll is in the wrap commit');
      assert.match(git('show', `${wrapSha}:${PRIMING_REL}`), /\*\*Active:\*\* Chunk 2 — Second thing/);
      assert.equal(commit.output.autoPr.autoMergeArmed, true);
      assert.deepEqual(armingCalls(), [`pr merge ${PR_URL} --auto --squash --delete-branch`]);
      assert.equal(commit.output.autoPr.mergeAuthority, null);
      assert.equal(rowOf(commit).remediation, null);
    });

    it('arms nothing in a lane project that keeps no plan at all', async () => {
      const { project, dir } = makeProject({ coordinator: COORDINATOR, plan: false });
      sessionEdits(dir);

      const result = await wrapPipeline.runWrapPipeline(project.name);
      assert.equal(result.ok, true);
      assert.equal(stepOf(result, 'next-session-prime').status, 'skipped');
      assert.equal(fs.readFileSync(path.join(dir, PRIMING_REL), 'utf8'), PRIMING);
      assert.equal(stepOf(result, 'commit').output.autoPr.autoMergeArmed, false);
      assert.deepEqual(armingCalls(), []);
    });
  });

  describe('a wrap fired from a branch that has an open pull request the operator chose to merge', () => {
    /**
     * Put the project on a pushed feature branch with an open pull request.
     * @param {{dir: string, git: Function}} made - From `makeProject`
     * @returns {string} The branch's pushed head
     */
    function onBranchWithOpenPr({ git }) {
      git('checkout', '-q', '-b', 'feat/thing');
      git('commit', '-q', '--allow-empty', '-m', 'Work');
      git('push', '-q', '-u', 'origin', 'feat/thing');
      prCheck._internal.listOpenPrs = async () => ({
        ok: true,
        reason: null,
        prs: [{
          number: 7, title: 'Thing', headRefName: 'feat/thing', baseRefName: 'main', url: PR_URL,
          createdAt: '2026-01-01T00:00:00Z', isDraft: false, author: { login: 'lane' }
        }]
      });
      return git('rev-parse', 'HEAD');
    }

    /**
     * The remote's head of the feature branch.
     * @param {string} bare - The bare repository
     * @returns {string}
     */
    function remoteHead(bare) {
      return execFileSync('git', ['rev-parse', 'refs/heads/feat/thing'], { cwd: bare, encoding: 'utf8' }).trim();
    }

    it('neither pushes nor enqueues the merge in a project that names a coordinator, and leaves the priming file alone', async () => {
      const made = makeProject({ coordinator: COORDINATOR });
      const pushedHead = onBranchWithOpenPr(made);
      sessionEdits(made.dir);

      const result = await wrapPipeline.runWrapPipeline(made.project.name, { prHandling: 'merge' });
      assert.equal(result.ok, true, `the wrap must finish: ${JSON.stringify(result.results.filter((r) => r.blockers.length))}`);

      assert.equal(stepOf(result, 'next-session-prime').status, 'skipped');
      assert.equal(fs.readFileSync(path.join(made.dir, PRIMING_REL), 'utf8'), PRIMING);
      assert.equal(made.git('diff', '--name-only', pushedHead, 'HEAD', '--', PRIMING_REL), '');

      const merge = stepOf(result, 'apply-pr-resolutions');
      assert.equal(merge.status, 'skipped');
      assert.match(rowOf(merge).detail, new RegExp(`${COORDINATOR} merges this pull request`));
      assert.deepEqual(armingCalls(), [], 'no command arms auto-merge');
      assert.equal(remoteHead(made.bare), pushedHead, 'the pull request\'s head on the remote is not moved');
      assert.notEqual(made.git('rev-parse', 'HEAD'), pushedHead, 'the wrap commit exists locally');
    });

    it('pushes and enqueues the merge for the same project with no coordinator', async () => {
      const made = makeProject({ coordinator: null });
      const pushedHead = onBranchWithOpenPr(made);
      sessionEdits(made.dir);

      const result = await wrapPipeline.runWrapPipeline(made.project.name, { prHandling: 'merge' });
      assert.equal(result.ok, true, `the wrap must finish: ${JSON.stringify(result.results.filter((r) => r.blockers.length))}`);

      assert.equal(stepOf(result, 'next-session-prime').status, 'done');
      assert.equal(stepOf(result, 'apply-pr-resolutions').status, 'done');
      assert.deepEqual(armingCalls(), ['pr merge 7 --auto --squash --delete-branch']);
      assert.notEqual(remoteHead(made.bare), pushedHead, 'the wrap commit was pushed to the pull request\'s branch');
      assert.equal(remoteHead(made.bare), made.git('rev-parse', 'HEAD'));
    });
  });
});
