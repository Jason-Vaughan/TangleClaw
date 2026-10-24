#!/usr/bin/env node
'use strict';

/**
 * For the commit checked out here, read what CI says, run what CI does not,
 * and write both down as one file, or refuse and say which fact failed.
 *
 * A green `test` check and a green local complement together cover the suite:
 * the check certifies every test the runner can run, the complement the tests
 * `test/skip-ledger.json` lets it skip. This command binds the two to one
 * exact commit and tree, so a reader of the file need trust nobody's word for
 * either half.
 *
 * Nothing a caller types supplies a fact. The commit is HEAD, the repository
 * is the remote's, the check is CI's required one, the ledger is the tracked
 * one, and the complement's verdict is taken as a value from the run this
 * command makes itself, between two reads of the tree. `--base` names the
 * branch the commit is headed for, which the command cannot always derive; a
 * wrong one can only make it refuse, or bind the file to a base its reader can
 * see. It is for before the merge: once a pull request is merged GitHub no
 * longer names it on its run, and the command refuses.
 *
 * The file changes nothing a gate accepts. No rule lets it stand in for the
 * full local suite: see docs/lane-ci-evidence.md.
 *
 * It runs the complement, so it is a wide run: do not start it while a full
 * suite is running on the same host.
 *
 * Usage: node scripts/ci-evidence.js [--base <branch>]
 *   --base <branch>  the branch this commit is headed for; the remote's
 *                    default branch when absent
 * Exit 0 only when the file was written.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readCheck, ACTIONS_APP } = require('../lib/github-checks');
const { execFileArgs, describeFailure } = require('../lib/exec');
const { compileLedger, DEFAULT_LEDGER } = require('./test-skip-audit');
const { runComplement, formatRun } = require('./ci-complement');

const ROOT = path.join(__dirname, '..');

/** Where the file goes. Git ignores the folder, so the file is never committed. */
const EVIDENCE_DIR = path.join(ROOT, '.prawduct', 'lane-evidence');

/** The check branch protection requires: the one job of `.github/workflows/test.yml`. */
const CHECK_NAME = 'test';

/** One git call's time budget; the fetch is the slow one. */
const GIT_TIMEOUT_MS = 120000;

/** One gh call's time budget. */
const GH_TIMEOUT_MS = 10000;

const SHA_SHAPE = /^[0-9a-f]{40}$/;
const ID_SHAPE = /^[1-9][0-9]{0,18}$/;
const BRANCH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** A GitHub remote's URL, in the three spellings git writes one; the repository is the capture. */
const GITHUB_REMOTE = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/;

/** Seams for tests. */
const _internal = {
  exec: (args) => execFileArgs('gh', args, { timeoutMs: GH_TIMEOUT_MS, maxBufferBytes: 64 * 1024 })
};

/** A fact that did not hold. Carrying one out of a step is how the command refuses. */
class Refusal extends Error {}

/**
 * A function that runs git in one working folder.
 *
 * @param {string} cwd - The folder git runs in
 * @returns {function(string[]): {status: (number|null), stdout: string}} Takes git's arguments;
 *   `status` is null when git could not run or was killed
 */
function gitIn(cwd) {
  return (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    return { status: r.error ? null : r.status, stdout: r.stdout || '' };
  };
}

/**
 * One line of git's answer, or a refusal.
 *
 * @param {function(string[]): {status: (number|null), stdout: string}} git - The git seam
 * @param {string[]} args - git's arguments
 * @param {string} fact - What to say when git does not answer with exactly one non-empty line
 * @returns {string} The line
 */
function gitLine(git, args, fact) {
  const r = git(args);
  const line = r.stdout.trim();
  if (r.status !== 0 || !line || line.includes('\n')) throw new Refusal(fact);
  return line;
}

/**
 * Read one object from the GitHub API through `gh`.
 *
 * @param {string} apiPath - The path after `api`
 * @param {string} projection - A jq filter keeping the fields read and no others
 * @returns {Promise<{ok: true, value: *}|{ok: false, reason: string}>}
 */
async function ghRead(apiPath, projection) {
  const r = await _internal.exec(['api', apiPath, '--jq', projection]);
  if (r.exitCode !== 0) return { ok: false, reason: describeFailure(r, 'gh api') };
  try {
    return { ok: true, value: JSON.parse(r.stdout) };
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false, reason: 'gh answered with something that is not JSON' };
  }
}

/**
 * Read the GitHub Actions job a check run claims to be. GitHub answers this
 * for a workflow's own job and with 404 for a check run that is none.
 *
 * @param {string} repo - `owner/name`
 * @param {string} checkRunId - The check run's id, which a job's check run shares with its job
 * @returns {Promise<{ok: true, value: object}|{ok: false, reason: string}>}
 */
function readJob(repo, checkRunId) {
  return ghRead(`repos/${repo}/actions/jobs/${checkRunId}`,
    '{id: .id, run_id: .run_id, head_sha: .head_sha, workflow_name: .workflow_name}');
}

/**
 * Read the workflow run a job belongs to: what started it, on which commit,
 * and for a pull request's run, the pull requests GitHub says it was for.
 *
 * @param {string} repo - `owner/name`
 * @param {string} workflowRunId - The workflow run's id
 * @returns {Promise<{ok: true, value: object}|{ok: false, reason: string}>}
 */
function readRun(repo, workflowRunId) {
  return ghRead(`repos/${repo}/actions/runs/${workflowRunId}`,
    '{id: .id, event: .event, head_sha: .head_sha, pull_requests: [.pull_requests[] | {head_sha: .head.sha, base_ref: .base.ref}]}');
}

/**
 * Read the commit a branch points at on GitHub.
 *
 * @param {string} repo - `owner/name`
 * @param {string} branch - The branch's name
 * @returns {Promise<{ok: true, value: object}|{ok: false, reason: string}>}
 */
function readBaseTip(repo, branch) {
  return ghRead(`repos/${repo}/branches/${branch.split('/').map(encodeURIComponent).join('/')}`, '{name: .name, sha: .commit.sha}');
}

/**
 * The tree as it stands: clean, and at a commit.
 *
 * @param {function} git - The git seam
 * @returns {{head: string, tree: string}} The full ids of HEAD and of its tree
 */
function readTree(git) {
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  if (status.status !== 0) throw new Refusal('git could not read the working tree');
  if (status.stdout !== '') {
    throw new Refusal('the working tree is not clean: `git status --porcelain --untracked-files=all` must print nothing');
  }
  const head = gitLine(git, ['rev-parse', '--verify', 'HEAD^{commit}'], 'HEAD is not a commit');
  const tree = gitLine(git, ['rev-parse', '--verify', 'HEAD^{tree}'], 'HEAD has no tree git can name');
  if (!SHA_SHAPE.test(head) || !SHA_SHAPE.test(tree)) throw new Refusal('git named HEAD or its tree with something that is not a full sha');
  return { head, tree };
}

/**
 * Check that HEAD is on the remote: after a fetch, the branch's upstream is
 * exactly HEAD.
 *
 * @param {function} git - The git seam
 * @param {string} head - HEAD's full id
 * @returns {string} The name of the remote the branch tracks
 */
function readRemote(git, head) {
  const ref = gitLine(git, ['symbolic-ref', '-q', 'HEAD'], 'HEAD is not on a branch, so it has no upstream to be read');
  const remote = gitLine(git, ['for-each-ref', '--format=%(upstream:remotename)', ref],
    'the branch has no upstream on a remote: push it first');
  if (remote === '.') throw new Refusal('the branch tracks a local branch, not a remote: push it first');
  if (git(['fetch', '--quiet', remote]).status !== 0) throw new Refusal(`git could not fetch ${remote}, so what is on the remote is not known`);
  // The upstream's own ref is asked for by name: `<ref>@{upstream}` takes a short branch name, not the full ref HEAD gives.
  const upstreamRef = gitLine(git, ['for-each-ref', '--format=%(upstream)', ref], 'git could not name the branch\'s upstream');
  const upstream = gitLine(git, ['rev-parse', '--verify', `${upstreamRef}^{commit}`], 'the branch\'s upstream names no commit after the fetch');
  if (upstream !== head) {
    throw new Refusal(`HEAD is not on the remote: the branch's upstream is ${upstream} and HEAD is ${head}`);
  }
  return remote;
}

/**
 * The repository, read from the remote's URL.
 *
 * The URL is never printed: one that carries a credential would put it on the screen.
 *
 * @param {function} git - The git seam
 * @param {string} remote - The remote's name
 * @returns {string} `owner/name`
 */
function readRepository(git, remote) {
  const url = gitLine(git, ['remote', 'get-url', remote], `git could not read the URL of the remote ${remote}`);
  const m = GITHUB_REMOTE.exec(url);
  if (!m) throw new Refusal(`the URL of the remote ${remote} does not name a GitHub repository`);
  return m[1];
}

/**
 * The base branch: the one named, or the remote's default.
 *
 * @param {function} git - The git seam
 * @param {string} remote - The remote's name
 * @param {string|null} named - What `--base` gave, if anything
 * @returns {string} The branch's name
 */
function readBaseBranch(git, remote, named) {
  const prefix = `${remote}/`;
  const branch = named || gitLine(git, ['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`],
    `the default branch of ${remote} is not recorded in this clone: name the base with --base`).slice(prefix.length);
  if (!BRANCH_SHAPE.test(branch)) throw new Refusal('the base branch\'s name is not one this command reads');
  return branch;
}

/**
 * Hold CI's reading to what the file may state: the check concluded with
 * success, and every field the file records was read.
 *
 * @param {object} check - An answer of `readCheck`
 * @param {string} head - HEAD's full id
 * @returns {{name: string, runId: string, workflowRunId: string, app: string, conclusion: string, completedAt: string}}
 */
function requireCheck(check, head) {
  const at = `the \`${CHECK_NAME}\` check on ${head}`;
  if (!check || check.status === 'unavailable') {
    throw new Refusal(`${at} could not be read: ${check && check.reason ? check.reason : 'no answer'}`);
  }
  if (check.status === 'not-found') throw new Refusal(`${at} does not exist: CI has not run on this commit`);
  if (check.status === 'running') throw new Refusal(`${at} has not finished`);
  if (check.status !== 'concluded') throw new Refusal(`${at} was read as something this command does not know`);
  if (check.conclusion !== 'success') throw new Refusal(`${at} concluded ${String(check.conclusion)}, not success`);
  if (typeof check.runId !== 'string' || !ID_SHAPE.test(check.runId) || typeof check.app !== 'string' || !check.app
    || typeof check.completedAt !== 'string' || !Number.isFinite(Date.parse(check.completedAt))) {
    throw new Refusal(`${at} was read without its run id, its app or its completion time`);
  }
  if (check.app !== ACTIONS_APP) {
    throw new Refusal(`${at} was made by the app ${check.app}, not by ${ACTIONS_APP}: a check of the same name from another app is not CI`);
  }
  if (typeof check.workflowRunId !== 'string' || !ID_SHAPE.test(check.workflowRunId)) {
    throw new Refusal(`${at} does not link to a workflow run in this repository as its own job`);
  }
  return {
    name: CHECK_NAME, runId: check.runId, workflowRunId: check.workflowRunId, app: check.app,
    conclusion: check.conclusion, completedAt: check.completedAt
  };
}

/**
 * Hold the job GitHub answered for the check run to the commit and to the
 * workflow run the check run's link named.
 *
 * The app's slug and the link are written by whoever made the check run, and
 * a workflow step may post one of its own under the Actions app. The job is
 * GitHub's own record, so this is where the check run is shown to be a
 * workflow's job on this commit.
 *
 * @param {{ok: boolean, value?: object, reason?: string}} read - An answer of `readJob`
 * @param {{runId: string, workflowRunId: string}} check - Output of `requireCheck`
 * @param {string} head - HEAD's full id
 * @returns {string} The name of the workflow the job belongs to
 */
function requireJob(read, check, head) {
  const at = `check run ${check.runId}`;
  if (!read || !read.ok) {
    throw new Refusal(`${at} could not be read as a GitHub Actions job: ${read && read.reason ? read.reason : 'no answer'}`);
  }
  const job = read.value;
  if (!job || typeof job !== 'object' || String(job.id) !== check.runId) throw new Refusal(`${at} is not the job GitHub answered with`);
  if (job.head_sha !== head) throw new Refusal(`${at} is a job of another commit (${String(job.head_sha)}), not of HEAD`);
  if (String(job.run_id) !== check.workflowRunId) {
    throw new Refusal(`${at} is a job of workflow run ${String(job.run_id)}, not of the run its link names (${check.workflowRunId})`);
  }
  if (typeof job.workflow_name !== 'string' || !job.workflow_name) throw new Refusal(`${at} was read without its workflow's name`);
  return job.workflow_name;
}

/**
 * Hold the workflow run to having tested HEAD against the base the file
 * binds, and answer with the event that started it.
 *
 * A pull request's run tests the head merged into the pull request's own base
 * branch. So the base named here says nothing about what CI tested unless the
 * run itself is of a pull request into that branch. A push run merges nothing:
 * it tested the commit's own tree. Every other event, and a pull request's run
 * that names no pull request of HEAD into this base, refuses. GitHub leaves
 * that list empty once the pull request is merged and for one from a fork.
 *
 * This is one of two checks on the base and neither replaces the other:
 * `requireBase` shows the merge a pull request's run tested has HEAD's own tree.
 *
 * @param {{ok: boolean, value?: object, reason?: string}} read - An answer of `readRun`
 * @param {{workflowRunId: string}} check - Output of `requireCheck`
 * @param {string} branch - The base branch's name
 * @param {string} head - HEAD's full id
 * @returns {string} `push` or `pull_request`
 */
function requireRun(read, check, branch, head) {
  const at = `workflow run ${check.workflowRunId}`;
  if (!read || !read.ok) throw new Refusal(`${at} could not be read: ${read && read.reason ? read.reason : 'no answer'}`);
  const run = read.value;
  if (!run || typeof run !== 'object' || String(run.id) !== check.workflowRunId || !Array.isArray(run.pull_requests)) {
    throw new Refusal(`${at} is not the run GitHub answered with`);
  }
  if (run.head_sha !== head) throw new Refusal(`${at} is a run of another commit (${String(run.head_sha)}), not of HEAD`);
  if (run.event === 'push') return run.event;
  if (run.event !== 'pull_request') {
    throw new Refusal(`${at} was started by the event ${String(run.event)}, and only a push or a pull request's run is read as CI's test of a commit`);
  }
  if (!run.pull_requests.some((pr) => pr && pr.head_sha === head && pr.base_ref === branch)) {
    throw new Refusal(`${at} names no pull request of HEAD into ${branch}: CI did not test this commit against that base, `
      + 'or the pull request is merged or comes from a fork');
  }
  return run.event;
}

/**
 * Hold the base branch's tip, as GitHub gives it, to being inside HEAD.
 *
 * With the base's tip inside the head, the merge a pull request's run tested
 * has the head's own tree whatever the base was when the run started, so no
 * time is compared; a base that moved after the run is simply not inside HEAD.
 * Which base the run merged is `requireRun`'s to show.
 *
 * @param {{ok: boolean, value?: object, reason?: string}} read - An answer of `readBaseTip`
 * @param {string} branch - The base branch's name
 * @param {string} head - HEAD's full id
 * @param {function} git - The git seam
 * @returns {{branch: string, tip: string}}
 */
function requireBase(read, branch, head, git) {
  if (!read || !read.ok) {
    throw new Refusal(`the tip of the base branch ${branch} could not be read from GitHub: ${read && read.reason ? read.reason : 'no answer'}`);
  }
  const tip = read.value && read.value.sha;
  if (!read.value || read.value.name !== branch || typeof tip !== 'string' || !SHA_SHAPE.test(tip)) {
    throw new Refusal(`GitHub answered for the base branch ${branch} with something that names no commit of it`);
  }
  const inside = git(['merge-base', '--is-ancestor', tip, head]).status;
  if (inside === 1) throw new Refusal(`the base branch ${branch} is at ${tip}, which is not inside HEAD: bring the base in and let CI run on the result`);
  if (inside !== 0) throw new Refusal(`the base branch ${branch} is at ${tip}, which git could not compare with HEAD`);
  return { branch, tip };
}

/**
 * Read the ledger: it must compile, and its digest is of the file's own bytes.
 *
 * @param {string} ledgerPath - The ledger file
 * @returns {string} The sha-256 of the file, in hex
 */
function readLedger(ledgerPath) {
  let bytes;
  try {
    bytes = fs.readFileSync(ledgerPath);
    compileLedger(JSON.parse(bytes.toString('utf8')));
  } catch (err) {
    throw new Refusal(`the skip ledger cannot be read: ${err.message}`);
  }
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * What the host measured for one requirement, in a form the file can hold.
 *
 * @param {*} answer - A value of the complement's host map
 * @returns {boolean|Object<string, boolean>} The yes or no, or for the per-test value each engine and whether it is installed
 */
function measured(answer) {
  if (!(answer instanceof Map)) return answer;
  return Object.fromEntries([...answer].map(([id, engine]) => [id, engine.installed]));
}

/**
 * Hold the complement's verdict to green and put it in the file's form.
 *
 * @param {ReturnType<typeof runComplement>} run - The verdict of the run this command made
 * @param {{write: function(string): any}} out - Where a red run's lines go
 * @returns {{ok: true, entriesRan: number, entriesTotal: number, entries: Array<object>}}
 */
function requireComplement(run, out) {
  if (!run || !Array.isArray(run.problems) || !Array.isArray(run.results)) throw new Refusal('the complement answered with no verdict');
  for (const problem of run.problems) out.write(`${problem}\n`);
  if (run.problems.length > 0) throw new Refusal('the complement did not run to a verdict');
  if (run.ok !== true) {
    out.write(formatRun(run));
    throw new Refusal('the complement is red');
  }
  return {
    ok: true,
    entriesRan: run.results.filter((r) => r.ran).length,
    entriesTotal: run.results.length,
    entries: run.results.map((r, i) => ({
      id: r.id,
      verdict: r.verdict,
      detail: r.detail,
      requires: Object.fromEntries(run.entries[i].requires.map((value) => [value, measured(run.host.get(value))]))
    }))
  };
}

/**
 * Parse argv.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{base: string|null}}
 */
function parseArgs(argv) {
  const parsed = { base: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--base' || !argv[i + 1]) {
      throw new Refusal(`${argv[i] === '--base' ? '--base needs a branch' : `unknown argument "${argv[i]}"`}\n`
        + 'usage: ci-evidence.js [--base <branch>]\n'
        + 'the commit, the repository, the check, the ledger and the complement\'s result are read, never typed');
    }
    parsed.base = argv[++i];
  }
  return parsed;
}

/**
 * Read every fact, in order, and answer with the file's contents. The first
 * fact that does not hold is thrown as a `Refusal`.
 *
 * @param {{base: string|null}} parsed - Output of `parseArgs`
 * @param {object} seams - The resolved seams of `main`
 * @returns {Promise<object>} The evidence
 */
async function gather(parsed, seams) {
  const { git, out, ledgerPath } = seams;
  const before = readTree(git);
  const remote = readRemote(git, before.head);
  const repository = readRepository(git, remote);
  const check = requireCheck(await seams.readCheck(repository, before.head, CHECK_NAME), before.head);
  const workflowName = requireJob(await seams.readJob(repository, check.runId), check, before.head);
  const branch = readBaseBranch(git, remote, parsed.base);
  const event = requireRun(await seams.readRun(repository, check.workflowRunId), check, branch, before.head);
  const base = requireBase(await seams.readBaseTip(repository, branch), branch, before.head, git);
  const sha256 = readLedger(ledgerPath);

  out.write('running the complement: the tests CI is allowed to skip, on this machine\n');
  const complement = requireComplement(seams.runComplement({ ledgerPath }), out);

  // The run is bound to the tree only if the tree is the same on both sides of it.
  const after = readTree(git);
  if (after.head !== before.head || after.tree !== before.tree) throw new Refusal('HEAD moved while the complement ran');
  if (readLedger(ledgerPath) !== sha256) throw new Refusal('the skip ledger changed while the complement ran');

  return {
    repository,
    check: { ...check, workflowName, event },
    head: before.head,
    tree: before.tree,
    base,
    ledger: { path: path.relative(ROOT, ledgerPath), sha256 },
    complement,
    readAt: seams.now().toISOString()
  };
}

/**
 * Write the evidence where a reader looks for a commit's: whole, or not at all.
 *
 * @param {string} dir - The evidence folder
 * @param {object} evidence - Output of `gather`
 * @returns {string} The file's path
 */
function writeEvidence(dir, evidence) {
  const file = path.join(dir, `ci-${evidence.head}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

/**
 * Run the command end to end and return the process exit code.
 *
 * The seams exist for the tests: a caller on the command line reaches none of
 * them, so nothing typed can change what is read or what is run.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {object} [io] - Injection seams
 * @param {{write: function(string): any}} [io.stdout] - Where the lines go
 * @param {function(string[]): {status: (number|null), stdout: string}} [io.git] - Runs git in the repository
 * @param {function(string, string, string): Promise<object>} [io.readCheck] - Reads the named check on a commit
 * @param {function(string, string): Promise<object>} [io.readJob] - Reads the job a check run claims to be
 * @param {function(string, string): Promise<object>} [io.readRun] - Reads the workflow run a job belongs to
 * @param {function(string, string): Promise<object>} [io.readBaseTip] - Reads a branch's tip from GitHub
 * @param {function(object): object} [io.runComplement] - Runs the complement and answers with its verdict
 * @param {function(): Date} [io.now] - The clock
 * @param {string} [io.ledgerPath] - The ledger to read
 * @param {string} [io.evidenceDir] - Where the file goes
 * @returns {Promise<number>} 0 when the file was written, 1 otherwise
 */
async function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const seams = {
    out,
    git: io.git || gitIn(ROOT),
    readCheck: io.readCheck || readCheck,
    readJob: io.readJob || readJob,
    readRun: io.readRun || readRun,
    readBaseTip: io.readBaseTip || readBaseTip,
    runComplement: io.runComplement || runComplement,
    now: io.now || (() => new Date()),
    ledgerPath: io.ledgerPath || DEFAULT_LEDGER
  };
  let evidence;
  try {
    evidence = await gather(parseArgs(argv), seams);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    out.write(`REFUSED: ${err.message}\nno evidence was written\n`);
    return 1;
  }
  const file = writeEvidence(io.evidenceDir || EVIDENCE_DIR, evidence);
  const { check, base, complement } = evidence;
  out.write(`CI evidence written: ${file}\n`
    + `  the \`${check.name}\` check (run ${check.runId}, workflow "${check.workflowName}", ${check.event} run ${check.workflowRunId}) concluded ${check.conclusion} on ${evidence.head}\n`
    + `  the base branch ${base.branch} is at ${base.tip}, which is inside HEAD\n`
    + `  the complement is green: ${complement.entriesRan} of ${complement.entriesTotal} ledger entries ran here\n`
    + 'This file is evidence for one commit. Under A439-R5/v5.37.0 P1.1, scripts/suite-evidence.js (with TANGLECLAW_SUITE_EVIDENCE=ci) reads it as part of the merged report the gate records.\n');
  return 0;
}

module.exports = {
  Refusal, CHECK_NAME, EVIDENCE_DIR, GITHUB_REMOTE, gitIn,
  readTree, readRemote, readRepository, readBaseBranch, requireCheck, requireJob, requireRun, requireBase, readLedger,
  requireComplement, parseArgs, gather, writeEvidence, readJob, readRun, readBaseTip, main, _internal
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
