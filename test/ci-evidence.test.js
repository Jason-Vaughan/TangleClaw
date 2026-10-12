'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const evidence = require('../scripts/ci-evidence');

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BASE_TIP = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const REPO = 'Jason-Vaughan/TangleClaw';
const REF = 'refs/heads/feat/x';
const NOW = '2026-10-12T13:00:00.000Z';

const LEDGER = JSON.stringify({
  entries: [
    { id: 'pty', match: '^watcher > reads the real ps output$', why: 'linux runner', runsWhere: 'macOS', requires: ['platform:darwin'] },
    { id: 'flags', match: '^launch flags > .*$', why: 'no engine CLI', runsWhere: 'a host with one', requires: ['engine-cli:each'] }
  ]
});

/** CI's reading of a green `test` check that is a workflow's own job. */
const GREEN = Object.freeze({
  status: 'concluded', conclusion: 'success', runId: '114790000001', completedAt: '2026-10-12T12:10:00.000Z',
  app: 'github-actions', workflowRunId: '38245150001'
});

/** The job GitHub answers for that check run. */
const JOB = Object.freeze({ id: 114790000001, run_id: 38245150001, head_sha: HEAD, workflow_name: 'Tests' });

/**
 * A green complement verdict over the two entries of `LEDGER`, as `runComplement` returns one.
 *
 * @returns {object}
 */
function greenRun() {
  return {
    ok: true,
    problems: [],
    stopped: null,
    junitPath: '/tmp/complement.xml',
    strayFailures: [],
    entries: [{ id: 'pty', requires: ['platform:darwin'] }, { id: 'flags', requires: ['engine-cli:each'] }],
    host: new Map([
      ['platform:darwin', true],
      ['engine-cli:each', new Map([['claude', { installed: true, declaresFlags: true }], ['codex', { installed: false, declaresFlags: true }]])]
    ]),
    results: [
      { id: 'pty', verdict: 'passed', ok: true, ran: true, detail: '1 test' },
      { id: 'flags', verdict: 'passed', ok: true, ran: true, detail: '3 tests' }
    ]
  };
}

/**
 * A git seam answering as a clean, pushed clone does, then the overrides.
 *
 * @param {Object<string, {status: (number|null), stdout: string}|function(): object>} [overrides] - By the arguments joined with a space
 * @returns {{git: function(string[]): object, calls: string[]}}
 */
function fakeGit(overrides = {}) {
  const answers = {
    'status --porcelain --untracked-files=all': { status: 0, stdout: '' },
    'rev-parse --verify HEAD^{commit}': { status: 0, stdout: `${HEAD}\n` },
    'rev-parse --verify HEAD^{tree}': { status: 0, stdout: `${TREE}\n` },
    'symbolic-ref -q HEAD': { status: 0, stdout: `${REF}\n` },
    [`for-each-ref --format=%(upstream:remotename) ${REF}`]: { status: 0, stdout: 'origin\n' },
    'fetch --quiet origin': { status: 0, stdout: '' },
    [`rev-parse --verify ${REF}@{upstream}^{commit}`]: { status: 0, stdout: `${HEAD}\n` },
    'remote get-url origin': { status: 0, stdout: `https://github.com/${REPO}.git\n` },
    'symbolic-ref --short -q refs/remotes/origin/HEAD': { status: 0, stdout: 'origin/main\n' },
    [`merge-base --is-ancestor ${BASE_TIP} ${HEAD}`]: { status: 0, stdout: '' },
    ...overrides
  };
  const calls = [];
  const git = (args) => {
    const key = args.join(' ');
    calls.push(key);
    const answer = Object.hasOwn(answers, key) ? answers[key] : { status: 128, stdout: '' };
    return typeof answer === 'function' ? answer() : answer;
  };
  return { git, calls };
}

/**
 * Run the command against a temporary ledger and evidence folder, every seam faked.
 *
 * @param {import('node:test').TestContext} t - The test, for cleanup
 * @param {object} [opts]
 * @param {string[]} [opts.argv] - Arguments
 * @param {Object<string, object|function>} [opts.git] - Overrides for the git seam
 * @param {object} [opts.check] - What `readCheck` answers
 * @param {object} [opts.job] - What `readJob` answers
 * @param {object} [opts.baseTip] - What `readBaseTip` answers
 * @param {function(object, string): object} [opts.complement] - The complement seam; handed its io and the folder
 * @param {string|null} [opts.ledger] - The ledger's text, or null for no file
 * @param {string} [opts.existing] - Bytes already at the evidence file's path
 * @returns {Promise<{code: number, out: string, file: string, dir: string, ledgerPath: string, seen: object, gitCalls: string[]}>}
 */
async function run(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ci-evidence-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = path.join(dir, 'skip-ledger.json');
  const ledger = opts.ledger === undefined ? LEDGER : opts.ledger;
  if (ledger !== null) fs.writeFileSync(ledgerPath, ledger);
  const evidenceDir = path.join(dir, 'lane-evidence');
  const file = path.join(evidenceDir, `ci-${HEAD}.json`);
  if (opts.existing !== undefined) {
    fs.mkdirSync(evidenceDir);
    fs.writeFileSync(file, opts.existing);
  }
  const { git, calls: gitCalls } = fakeGit(opts.git);
  const seen = { check: [], job: [], baseTip: [], complement: [] };
  let out = '';
  const code = await evidence.main(opts.argv || [], {
    stdout: { write: (s) => { out += s; } },
    git,
    ledgerPath,
    evidenceDir,
    now: () => new Date(NOW),
    readCheck: async (...args) => { seen.check.push(args); return opts.check || GREEN; },
    readJob: async (...args) => { seen.job.push(args); return opts.job || { ok: true, value: JOB }; },
    readBaseTip: async (...args) => { seen.baseTip.push(args); return opts.baseTip || { ok: true, value: { name: args[1], sha: BASE_TIP } }; },
    runComplement: (io) => { seen.complement.push(io); return (opts.complement || greenRun)(io, dir); }
  });
  return { code, out, file, dir, ledgerPath, seen, gitCalls };
}

/**
 * Assert a run refused: exit 1, the fact named, and no file.
 *
 * @param {Awaited<ReturnType<typeof run>>} r - The run
 * @param {RegExp} fact - What the refusal must say
 */
function assertRefused(r, fact) {
  assert.equal(r.code, 1);
  assert.match(r.out, /^REFUSED: /m);
  assert.match(r.out, fact);
  assert.match(r.out, /no evidence was written\n$/);
  assert.equal(fs.existsSync(r.file), false, 'a refusal must write no file');
}

describe('ci-evidence — the file a green run writes', () => {
  it('writes every field, each with the value this run read', async (t) => {
    const r = await run(t);
    assert.equal(r.code, 0, r.out);
    const written = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    assert.deepEqual(written, {
      repository: REPO,
      check: {
        name: 'test', runId: '114790000001', workflowRunId: '38245150001', app: 'github-actions',
        conclusion: 'success', completedAt: '2026-10-12T12:10:00.000Z', workflowName: 'Tests'
      },
      head: HEAD,
      tree: TREE,
      base: { branch: 'main', tip: BASE_TIP },
      ledger: {
        path: path.relative(path.join(__dirname, '..'), r.ledgerPath),
        sha256: crypto.createHash('sha256').update(LEDGER).digest('hex')
      },
      complement: {
        ok: true,
        entriesRan: 2,
        entriesTotal: 2,
        entries: [
          { id: 'pty', verdict: 'passed', detail: '1 test', requires: { 'platform:darwin': true } },
          { id: 'flags', verdict: 'passed', detail: '3 tests', requires: { 'engine-cli:each': { claude: true, codex: false } } }
        ]
      },
      readAt: NOW
    });
  });

  it('asks GitHub about exactly HEAD in the remote\'s repository, and for the job that is the check run', async (t) => {
    const r = await run(t);
    assert.deepEqual(r.seen.check, [[REPO, HEAD, 'test']]);
    assert.deepEqual(r.seen.job, [[REPO, '114790000001']]);
    assert.deepEqual(r.seen.baseTip, [[REPO, 'main']]);
  });

  it('runs the complement itself, once, on the same ledger, and hands it nothing else', async (t) => {
    const r = await run(t);
    assert.deepEqual(r.seen.complement, [{ ledgerPath: r.ledgerPath }]);
  });

  it('reads the tree again after the complement ran', async (t) => {
    const r = await run(t);
    assert.equal(r.gitCalls.filter((c) => c === 'status --porcelain --untracked-files=all').length, 2);
    assert.equal(r.gitCalls.filter((c) => c === 'rev-parse --verify HEAD^{tree}').length, 2);
  });

  it('says where the file is, and that it changes nothing a gate accepts', async (t) => {
    const r = await run(t);
    assert.match(r.out, new RegExp(`^CI evidence written: ${r.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(r.out, /the complement is green: 2 of 2 ledger entries ran here/);
    assert.match(r.out, /changes nothing a gate accepts: no rule in force/);
  });

  it('records an entry that was not expected here with the measurement that says why', async (t) => {
    const r = await run(t, {
      complement: () => {
        const v = greenRun();
        v.host.set('platform:darwin', false);
        v.results[0] = { id: 'pty', verdict: 'not-expected', ok: true, ran: false, detail: 'platform:darwin is false' };
        return v;
      }
    });
    assert.equal(r.code, 0, r.out);
    const { complement } = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    assert.equal(complement.entriesRan, 1);
    assert.equal(complement.entriesTotal, 2);
    assert.deepEqual(complement.entries[0], {
      id: 'pty', verdict: 'not-expected', detail: 'platform:darwin is false', requires: { 'platform:darwin': false }
    });
  });

  it('binds to the base named with --base, and reads that branch\'s tip', async (t) => {
    const r = await run(t, { argv: ['--base', 'release/5.33'] });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.seen.baseTip, [[REPO, 'release/5.33']]);
    assert.deepEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).base, { branch: 'release/5.33', tip: BASE_TIP });
    assert.equal(r.gitCalls.includes('symbolic-ref --short -q refs/remotes/origin/HEAD'), false);
  });

  it('reads the repository from each spelling of a GitHub remote', () => {
    for (const url of [
      `https://github.com/${REPO}.git`, `https://github.com/${REPO}`, `https://x-access-token:secret@github.com/${REPO}.git`,
      `git@github.com:${REPO}.git`, `ssh://git@github.com/${REPO}.git`
    ]) {
      const { git } = fakeGit({ 'remote get-url origin': { status: 0, stdout: `${url}\n` } });
      assert.equal(evidence.readRepository(git, 'origin'), REPO, url);
    }
  });
});

describe('ci-evidence — each refusal alone writes no file and names its fact', () => {
  it('the working tree is not clean', async (t) => {
    const r = await run(t, { git: { 'status --porcelain --untracked-files=all': { status: 0, stdout: '?? scratch.txt\n' } } });
    assertRefused(r, /the working tree is not clean/);
    assert.deepEqual(r.seen.check, [], 'GitHub is not asked about a tree that is not clean');
    assert.deepEqual(r.seen.complement, []);
  });

  it('git cannot read the working tree', async (t) => {
    assertRefused(await run(t, { git: { 'status --porcelain --untracked-files=all': { status: null, stdout: '' } } }),
      /git could not read the working tree/);
  });

  it('HEAD is not a commit', async (t) => {
    assertRefused(await run(t, { git: { 'rev-parse --verify HEAD^{commit}': { status: 128, stdout: '' } } }), /HEAD is not a commit/);
  });

  it('HEAD is detached, so it has no upstream', async (t) => {
    assertRefused(await run(t, { git: { 'symbolic-ref -q HEAD': { status: 1, stdout: '' } } }), /HEAD is not on a branch/);
  });

  it('the branch was never pushed', async (t) => {
    assertRefused(await run(t, { git: { [`for-each-ref --format=%(upstream:remotename) ${REF}`]: { status: 0, stdout: '\n' } } }),
      /no upstream on a remote: push it first/);
  });

  it('the branch tracks a local branch', async (t) => {
    assertRefused(await run(t, { git: { [`for-each-ref --format=%(upstream:remotename) ${REF}`]: { status: 0, stdout: '.\n' } } }),
      /tracks a local branch/);
  });

  it('the remote cannot be fetched', async (t) => {
    const r = await run(t, { git: { 'fetch --quiet origin': { status: 128, stdout: '' } } });
    assertRefused(r, /could not fetch origin/);
    assert.deepEqual(r.seen.check, []);
  });

  it('HEAD is not pushed: the upstream is another commit', async (t) => {
    const r = await run(t, { git: { [`rev-parse --verify ${REF}@{upstream}^{commit}`]: { status: 0, stdout: `${OTHER}\n` } } });
    assertRefused(r, new RegExp(`HEAD is not on the remote: the branch's upstream is ${OTHER} and HEAD is ${HEAD}`));
    assert.deepEqual(r.seen.check, []);
  });

  it('the remote\'s URL is unreadable', async (t) => {
    assertRefused(await run(t, { git: { 'remote get-url origin': { status: 2, stdout: '' } } }), /could not read the URL of the remote origin/);
  });

  it('the remote is not a GitHub repository, and its URL is not printed', async (t) => {
    const r = await run(t, { git: { 'remote get-url origin': { status: 0, stdout: 'https://user:hunter2@example.com/a/b.git\n' } } });
    assertRefused(r, /does not name a GitHub repository/);
    assert.doesNotMatch(r.out, /hunter2|example\.com/);
  });

  it('the check is unavailable', async (t) => {
    const r = await run(t, { check: { status: 'unavailable', reason: 'gh api timed out' } });
    assertRefused(r, /could not be read: gh api timed out/);
    assert.deepEqual(r.seen.complement, [], 'the complement is not run for a check that was not read');
  });

  it('the check is not found', async (t) => {
    assertRefused(await run(t, { check: { status: 'not-found' } }), /does not exist: CI has not run on this commit/);
  });

  it('the check is still running', async (t) => {
    assertRefused(await run(t, { check: { status: 'running', runId: '1', app: 'github-actions' } }), /has not finished/);
  });

  it('the check concluded, but not with success', async (t) => {
    for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) {
      assertRefused(await run(t, { check: { ...GREEN, conclusion } }), new RegExp(`concluded ${conclusion}, not success`));
    }
  });

  it('a check of the same name made by another app', async (t) => {
    const r = await run(t, { check: { ...GREEN, app: 'some-bot', workflowRunId: undefined } });
    assertRefused(r, /made by the app some-bot, not by github-actions/);
    assert.deepEqual(r.seen.job, []);
  });

  it('a reading without its run id, its app or its completion time', async (t) => {
    for (const missing of ['runId', 'app', 'completedAt']) {
      const check = { ...GREEN };
      delete check[missing];
      assertRefused(await run(t, { check }), /read without its run id, its app or its completion time/);
    }
  });

  it('an Actions check run whose link names no workflow run as its own job', async (t) => {
    const check = { ...GREEN };
    delete check.workflowRunId;
    const r = await run(t, { check });
    assertRefused(r, /does not link to a workflow run in this repository as its own job/);
    assert.deepEqual(r.seen.job, []);
  });

  it('the job cannot be read: a check run that is no job answers 404', async (t) => {
    const r = await run(t, { job: { ok: false, reason: 'gh api failed: gh: Not Found (HTTP 404)' } });
    assertRefused(r, /check run 114790000001 could not be read as a GitHub Actions job: gh api failed: gh: Not Found/);
    assert.deepEqual(r.seen.complement, []);
  });

  it('the job answered is another job', async (t) => {
    assertRefused(await run(t, { job: { ok: true, value: { ...JOB, id: 5 } } }), /is not the job GitHub answered with/);
  });

  it('the job is of another commit', async (t) => {
    assertRefused(await run(t, { job: { ok: true, value: { ...JOB, head_sha: OTHER } } }),
      new RegExp(`is a job of another commit \\(${OTHER}\\), not of HEAD`));
  });

  it('the job belongs to another workflow run than the link names', async (t) => {
    assertRefused(await run(t, { job: { ok: true, value: { ...JOB, run_id: 777 } } }),
      /is a job of workflow run 777, not of the run its link names \(38245150001\)/);
  });

  it('the job does not name its workflow', async (t) => {
    assertRefused(await run(t, { job: { ok: true, value: { ...JOB, workflow_name: null } } }), /read without its workflow's name/);
  });

  it('the remote\'s default branch is not recorded and no base is named', async (t) => {
    assertRefused(await run(t, { git: { 'symbolic-ref --short -q refs/remotes/origin/HEAD': { status: 1, stdout: '' } } }),
      /name the base with --base/);
  });

  it('a base name that is not a branch name', async (t) => {
    const r = await run(t, { argv: ['--base', '../../users/someone'] });
    assertRefused(r, /base branch's name is not one this command reads/);
    assert.deepEqual(r.seen.baseTip, []);
  });

  it('the base tip is unreadable', async (t) => {
    assertRefused(await run(t, { baseTip: { ok: false, reason: 'gh api timed out' } }),
      /tip of the base branch main could not be read from GitHub: gh api timed out/);
  });

  it('GitHub answers for the base with no commit, or with another branch', async (t) => {
    assertRefused(await run(t, { baseTip: { ok: true, value: { name: 'main', sha: 'abc' } } }), /names no commit of it/);
    assertRefused(await run(t, { baseTip: { ok: true, value: { name: 'other', sha: BASE_TIP } } }), /names no commit of it/);
  });

  it('the base tip is not inside HEAD', async (t) => {
    const r = await run(t, { git: { [`merge-base --is-ancestor ${BASE_TIP} ${HEAD}`]: { status: 1, stdout: '' } } });
    assertRefused(r, new RegExp(`the base branch main is at ${BASE_TIP}, which is not inside HEAD`));
    assert.deepEqual(r.seen.complement, []);
  });

  it('the base tip is a commit this clone cannot compare', async (t) => {
    assertRefused(await run(t, { git: { [`merge-base --is-ancestor ${BASE_TIP} ${HEAD}`]: { status: 128, stdout: '' } } }),
      /which git could not compare with HEAD/);
  });

  it('the ledger is missing, is not JSON, or does not compile', async (t) => {
    const noRequires = JSON.stringify({ entries: [{ id: 'a', match: '^a$', why: 'w', runsWhere: 'r' }] });
    for (const ledger of [null, '{ not json', noRequires]) {
      const r = await run(t, { ledger });
      assertRefused(r, /the skip ledger cannot be read: /);
      assert.deepEqual(r.seen.complement, []);
    }
  });

  it('the complement is red, and its lines are printed', async (t) => {
    const r = await run(t, {
      complement: () => {
        const v = greenRun();
        v.ok = false;
        v.results[0] = { id: 'pty', verdict: 'skipped', ok: false, ran: false, detail: 'watcher > reads the real ps output (not on this host)' };
        return v;
      }
    });
    assertRefused(r, /REFUSED: the complement is red/);
    assert.match(r.out, /^expected here and SKIPPED: pty \(watcher > reads the real ps output \(not on this host\)\)$/m);
    assert.match(r.out, /^COMPLEMENT RED: 1 of 2 ledger entries ran here/m);
  });

  it('the complement could not start', async (t) => {
    const r = await run(t, {
      complement: () => ({
        ...greenRun(), ok: false, results: [], stopped: 'the test run could not start: spawn ENOENT',
        problems: ['the test run could not start: spawn ENOENT', 'report not found: /tmp/x.xml. The run wrote no junit output, so nothing was certified']
      })
    });
    assertRefused(r, /REFUSED: the complement did not run to a verdict/);
    assert.match(r.out, /^the test run could not start: spawn ENOENT$/m);
  });

  it('a complement that reports a problem is never read as green, whatever else it says', async (t) => {
    assertRefused(await run(t, { complement: () => ({ ...greenRun(), problems: ['no test cases in /tmp/x.xml: nothing was certified'] }) }),
      /did not run to a verdict/);
  });

  it('a complement that answers with no verdict', async (t) => {
    assertRefused(await run(t, { complement: () => undefined }), /answered with no verdict/);
  });

  it('the tree changed during the run: a file was left behind', async (t) => {
    let reads = 0;
    const r = await run(t, {
      git: { 'status --porcelain --untracked-files=all': () => ({ status: 0, stdout: ++reads === 1 ? '' : '?? left-behind.txt\n' }) }
    });
    assertRefused(r, /the working tree is not clean/);
    assert.equal(r.seen.complement.length, 1, 'the refusal is the second read\'s, after the run');
  });

  it('the tree changed during the run: HEAD moved', async (t) => {
    let reads = 0;
    const r = await run(t, {
      git: { 'rev-parse --verify HEAD^{commit}': () => ({ status: 0, stdout: `${++reads === 1 ? HEAD : OTHER}\n` }) }
    });
    assertRefused(r, /HEAD moved while the complement ran/);
  });

  it('the ledger changed during the run', async (t) => {
    const r = await run(t, {
      complement: (io) => {
        fs.writeFileSync(io.ledgerPath, LEDGER.replace('linux runner', 'another reason'));
        return greenRun();
      }
    });
    assertRefused(r, /the skip ledger changed while the complement ran/);
  });
});

describe('ci-evidence — nothing typed supplies a fact', () => {
  it('refuses an argument naming a commit, a repository, a check, a ledger or a result', async (t) => {
    for (const argv of [
      [HEAD], ['--sha', HEAD], ['--head', HEAD], ['--repo', REPO], ['--check', 'test'], ['--ledger', 'other.json'],
      ['--complement', 'green'], ['--junit', 'report.xml'], ['--result', 'ok'], ['--base', 'main', HEAD]
    ]) {
      const r = await run(t, { argv });
      assertRefused(r, /unknown argument/);
      assert.match(r.out, /are read, never typed/);
      assert.deepEqual(r.gitCalls, [], `${argv.join(' ')}: nothing is read once an argument is refused`);
    }
  });

  it('refuses --base without a branch', async (t) => {
    assertRefused(await run(t, { argv: ['--base'] }), /--base needs a branch/);
  });
});

describe('ci-evidence — a file already at the path', () => {
  const STALE = 'not json: an earlier run\'s file, or something a person placed\n';

  it('is replaced by a success without being read', async (t) => {
    const r = await run(t, { existing: STALE });
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(fs.readFileSync(r.file, 'utf8')).head, HEAD);
    assert.deepEqual(fs.readdirSync(path.dirname(r.file)), [`ci-${HEAD}.json`], 'no temporary file is left beside it');
  });

  it('is left exactly as it was by a refusal', async (t) => {
    const r = await run(t, { existing: STALE, check: { status: 'not-found' } });
    assert.equal(r.code, 1);
    assert.match(r.out, /no evidence was written/);
    assert.equal(fs.readFileSync(r.file, 'utf8'), STALE);
  });
});

describe('ci-evidence — reading GitHub', () => {
  /**
   * Replace the gh seam for one test.
   *
   * @param {import('node:test').TestContext} t - The test, for restoring the seam
   * @param {object} result - What the fake `gh` resolves with
   * @returns {Array<string[]>} The argument lists `gh` was called with
   */
  function fakeGh(t, result) {
    const original = evidence._internal.exec;
    const calls = [];
    evidence._internal.exec = async (args) => { calls.push(args); return result; };
    t.after(() => { evidence._internal.exec = original; });
    return calls;
  }

  const answered = (stdout) => ({ exitCode: 0, stdout, stderr: '', error: null, errorCode: null, signal: null, timedOut: false });

  it('reads a job by the check run\'s id, keeping the four fields it judges', async (t) => {
    const calls = fakeGh(t, answered(JSON.stringify(JOB)));
    assert.deepEqual(await evidence.readJob(REPO, '114790000001'), { ok: true, value: JOB });
    assert.equal(calls[0][0], 'api');
    assert.equal(calls[0][1], `repos/${REPO}/actions/jobs/114790000001`);
    assert.match(calls[0][3], /id: \.id, run_id: \.run_id, head_sha: \.head_sha, workflow_name: \.workflow_name/);
  });

  it('reads a branch\'s tip, a slash in the name kept as a path', async (t) => {
    const calls = fakeGh(t, answered(JSON.stringify({ name: 'release/5.33', sha: BASE_TIP })));
    assert.deepEqual(await evidence.readBaseTip(REPO, 'release/5.33'), { ok: true, value: { name: 'release/5.33', sha: BASE_TIP } });
    assert.equal(calls[0][1], `repos/${REPO}/branches/release/5.33`);
  });

  it('answers not-ok with the reason when gh fails, as it does for a check run that is no job', async (t) => {
    fakeGh(t, { ...answered(''), exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' });
    const r = await evidence.readJob(REPO, '5');
    assert.equal(r.ok, false);
    assert.match(r.reason, /gh api failed: gh: Not Found \(HTTP 404\)/);
  });

  it('answers not-ok when gh answers with something that is not JSON', async (t) => {
    fakeGh(t, answered('<html>'));
    assert.deepEqual(await evidence.readBaseTip(REPO, 'main'), { ok: false, reason: 'gh answered with something that is not JSON' });
  });
});

describe('ci-evidence — what the documents must keep saying', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'docs', 'lane-ci-evidence.md'), 'utf8');
  const feedback = fs.readFileSync(path.join(__dirname, '..', 'docs', 'prawduct-feedback.md'), 'utf8');

  it('the proposed rule\'s heading says it is not in force', () => {
    assert.match(page, /^## PROPOSED, NOT IN FORCE: it needs the Operator's approval and a Prawduct that accepts this evidence$/m);
  });

  it('the page still opens by saying no rule is in force', () => {
    const opening = page.split('\n## ')[0].replace(/\s+/g, ' ');
    assert.match(opening, /No rule lets a CI run stand in for the full local suite/);
  });

  it('the proposed rule keeps every case that still needs the full local suite', () => {
    // The rule is a block quote: its markers go before the line breaks do.
    const rule = page.slice(page.indexOf('## PROPOSED, NOT IN FORCE')).replace(/^> ?/gm, '').replace(/\s+/g, ' ');
    for (const kept of [
      'any edit to `test/skip-ledger.json`', 'the test runner, the audit or evidence machinery or its configuration', 'schema',
      '`lib/store.js`', '`server.js`', 'shared test helpers', 'the last chunk of an issue', 'once before a deploy',
      'current-base exact-head evidence cannot be established'
    ]) {
      assert.ok(rule.includes(kept), `the proposed rule no longer says: ${kept}`);
    }
  });

  it('the upstream report\'s draft is marked not sent', () => {
    const at = feedback.indexOf('CI evidence');
    assert.notEqual(at, -1, 'the draft is in docs/prawduct-feedback.md');
    assert.match(feedback.slice(feedback.lastIndexOf('\n## ', at)), /\*\*NOT SENT\.\*\*/);
  });
});
