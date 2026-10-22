'use strict';

/**
 * `scripts/suite-evidence.js`: the suite command a gate could be pointed at
 * (#2371, proposed; #2498 W4-03).
 *
 * Pinned here: the mode comes from the environment and nothing else; local
 * mode hands node the declared `test_command` argument for argument; the
 * declaration itself still names `node --test …`, so a cutover cannot ride in
 * unnoticed; ci mode refuses, by name and writing nothing, on each of the ten
 * facts of `ci-evidence.js` and on every way the artifact can be missing,
 * which is the state of every run today; and on fixtures of real node junit
 * the merge holds both reports whole, binds them with the facts, and obeys the
 * identity `lib/test-results.js` reads.
 *
 * Every seam is faked: nothing here reaches git, GitHub or a test runner.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const suite = require('../scripts/suite-evidence');
const evidence = require('../scripts/ci-evidence');
const results = require('../lib/test-results');

const REPO_ROOT = path.join(__dirname, '..');

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BASE_TIP = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const REPO = 'Jason-Vaughan/TangleClaw';
const REF = 'refs/heads/feat/x';
const UPSTREAM_REF = 'refs/remotes/origin/feat/x';
const NOW = '2026-10-22T20:00:00.000Z';

/**
 * The `test_command` the project declares today, split on spaces, pinned as
 * text so a clone without a project state (CI's) holds the same words.
 */
const DECLARED_TEST_COMMAND = Object.freeze(['node', '--test', '--test-reporter=junit', '--test-reporter-destination={junit_xml}', 'test/*.test.js']);

const LEDGER = JSON.stringify({
  entries: [
    { id: 'pty', match: '^watcher > reads the real ps output$', why: 'linux runner', runsWhere: 'macOS', requires: ['platform:darwin'] }
  ]
});

/** CI's reading of a green `test` check that is a workflow's own job. */
const GREEN = Object.freeze({
  status: 'concluded', conclusion: 'success', runId: '114790000001', completedAt: '2026-10-22T19:57:00.000Z',
  app: 'github-actions', workflowRunId: '39842690823'
});
const JOB = Object.freeze({ id: 114790000001, run_id: 39842690823, head_sha: HEAD, workflow_name: 'Tests' });
const RUN = Object.freeze({ id: 39842690823, event: 'pull_request', head_sha: HEAD, pull_requests: [{ head_sha: HEAD, base_ref: 'main' }] });
const ARTIFACTS = Object.freeze({
  total_count: 1,
  artifacts: [{ id: 5001, name: 'test-results', expired: false, size_in_bytes: 4096, workflow_run: { id: 39842690823, head_sha: HEAD } }]
});

/**
 * Render the trailing comments node's junit reporter writes from a summary.
 *
 * @param {object} summary - Counter values by name
 * @returns {string}
 */
function trailer(summary) {
  return Object.entries(summary).map(([k, v]) => `\t<!-- ${k} ${v} -->`).join('\n');
}

/**
 * A junit document in the shape node:test's reporter emits, with the runner's
 * summary as its trailing comments inside the `<undefined name="root">`
 * element the reporter writes them in (measured on Node 22).
 *
 * @param {string} body - Inner markup
 * @param {object} [summary] - The summary to write as comments; omitted for a report with none
 * @returns {string}
 */
function junit(body, summary) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${body}\n\t<undefined name="root">\n${summary ? `${trailer(summary)}\n` : ''}\t</undefined>\n</testsuites>\n`;
}

const SUITE = (name, tests, failures, inner) => `\t<testsuite name="${name}" time="0.001" disabled="0" errors="0" tests="${tests}" failures="${failures}" skipped="0" hostname="h">\n${inner}\n\t</testsuite>`;
const CASE = (name) => `\t\t<testcase name="${name}" time="0.0001" classname="test"/>`;
const FAILED_CASE = (name) => `\t\t<testcase name="${name}" time="0.0001" classname="test" failure="boom">\n\t\t\t<failure type="testCodeFailure" message="boom">\nError: boom\n\t\t\t</failure>\n\t\t</testcase>`;

/** CI's report: two suites, four tests, green. */
const CI_SUMMARY = { tests: 4, suites: 2, pass: 4, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 1234.5 };
const CI_XML = junit([SUITE('alpha', 2, 0, [CASE('a1'), CASE('a2')].join('\n')), SUITE('beta', 2, 0, [CASE('b1'), CASE('b2 &lt;quoted>')].join('\n'))].join('\n'), CI_SUMMARY);

/** The complement's report: one suite, one test, green. */
const COMPLEMENT_SUMMARY = { tests: 1, suites: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 50 };
const COMPLEMENT_XML = junit(SUITE('watcher', 1, 0, CASE('reads the real ps output')), COMPLEMENT_SUMMARY);

/**
 * A green complement verdict over the one entry of `LEDGER`, as `runComplement` returns one.
 *
 * @returns {object}
 */
function greenRun() {
  return {
    ok: true, problems: [], stopped: null, junitPath: null, strayFailures: [],
    entries: [{ id: 'pty', requires: ['platform:darwin'] }],
    host: new Map([['platform:darwin', true]]),
    results: [{ id: 'pty', verdict: 'passed', ok: true, ran: true, detail: '1 test' }]
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
    [`for-each-ref --format=%(upstream) ${REF}`]: { status: 0, stdout: `${UPSTREAM_REF}\n` },
    [`rev-parse --verify ${UPSTREAM_REF}^{commit}`]: { status: 0, stdout: `${HEAD}\n` },
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
 * Run the command with every seam faked, a temporary ledger and a temporary junit path.
 *
 * @param {import('node:test').TestContext} t - The test, for cleanup
 * @param {object} [opts]
 * @param {string[]} [opts.argv] - Arguments; `--junit <temp path>` is added unless `opts.noJunitArg`
 * @param {boolean} [opts.noJunitArg] - Leave `--junit` off
 * @param {Object<string, string>} [opts.env] - The environment; `{}` for local mode
 * @param {Object<string, object|function>} [opts.git] - Overrides for the git seam
 * @param {object} [opts.check] - What `readCheck` answers
 * @param {object} [opts.job] - What `readJob` answers
 * @param {object} [opts.workflowRun] - What `readRun` answers
 * @param {object} [opts.baseTip] - What `readBaseTip` answers
 * @param {object} [opts.artifacts] - The artifact list `readArtifacts` answers with
 * @param {object} [opts.artifactsRead] - The whole answer of `readArtifacts`, for a read that fails
 * @param {string|null|function} [opts.ciXml] - What the download leaves as test-results.xml; null for no file; a function for a failed download
 * @param {string} [opts.complementXml] - What the complement writes at its junit path
 * @param {function(object): object} [opts.complement] - The complement seam
 * @param {string|null} [opts.ledger] - The ledger's text, or null for no file
 * @returns {Promise<{code: number, out: string, junitPath: string, dir: string, seen: object}>}
 */
async function run(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-suite-evidence-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = path.join(dir, 'skip-ledger.json');
  const ledger = opts.ledger === undefined ? LEDGER : opts.ledger;
  if (ledger !== null) fs.writeFileSync(ledgerPath, ledger);
  const junitPath = path.join(dir, 'out', 'suite.xml');
  const seen = { suiteArgs: null, complement: null, downloads: [] };
  const complementXml = opts.complementXml === undefined ? COMPLEMENT_XML : opts.complementXml;
  const argv = opts.noJunitArg ? (opts.argv || []) : [...(opts.argv || []), '--junit', junitPath];
  let text = '';
  const code = await suite.main(argv, {
    stdout: { write: (s) => { text += s; } },
    env: opts.env === undefined ? { TANGLECLAW_SUITE_EVIDENCE: 'ci' } : opts.env,
    runSuite: (args) => { seen.suiteArgs = args; return { status: 0 }; },
    git: fakeGit(opts.git).git,
    readCheck: async () => (opts.check === undefined ? GREEN : opts.check),
    readJob: async () => ({ ok: true, value: opts.job === undefined ? JOB : opts.job }),
    readRun: async () => ({ ok: true, value: opts.workflowRun === undefined ? RUN : opts.workflowRun }),
    readBaseTip: async () => ({ ok: true, value: opts.baseTip === undefined ? { name: 'main', sha: BASE_TIP } : opts.baseTip }),
    readArtifacts: async () => opts.artifactsRead || ({ ok: true, value: opts.artifacts === undefined ? ARTIFACTS : opts.artifacts }),
    downloadArtifact: async (repo, runId, name, into) => {
      seen.downloads.push({ repo, runId, name });
      if (typeof opts.ciXml === 'function') return opts.ciXml();
      if (opts.ciXml !== null) fs.writeFileSync(path.join(into, 'test-results.xml'), opts.ciXml === undefined ? CI_XML : opts.ciXml);
      return { ok: true };
    },
    runComplement: (io) => {
      seen.complement = io;
      if (opts.complement) return opts.complement(io);
      fs.writeFileSync(io.junitPath, complementXml);
      return greenRun();
    },
    now: () => new Date(NOW),
    ledgerPath
  });
  return { code, out: text, junitPath, dir, seen };
}

/**
 * Assert a run refused by name, ran nothing, and wrote no report.
 *
 * @param {{code: number, out: string, junitPath: string, seen: object}} r - A run's result
 * @param {RegExp} fact - What the refusal must name
 */
function refused(r, fact) {
  assert.equal(r.code, 1);
  assert.match(r.out, /^REFUSED: /m);
  assert.match(r.out, fact);
  assert.match(r.out, /no report was written: there is no synthetic report/);
  assert.equal(fs.existsSync(r.junitPath), false, 'nothing at the junit path');
  assert.equal(fs.existsSync(`${r.junitPath}.tmp`), false, 'no half-written report either');
  assert.equal(r.seen.suiteArgs, null, 'the local suite did not run');
}

describe('suite-evidence — the mode comes from the environment', () => {
  it('local when the variable is unset or empty, ci when it is "ci", a refusal for anything else', () => {
    assert.equal(suite.modeOf({}), 'local');
    assert.equal(suite.modeOf({ TANGLECLAW_SUITE_EVIDENCE: '' }), 'local');
    assert.equal(suite.modeOf({ TANGLECLAW_SUITE_EVIDENCE: 'ci' }), 'ci');
    for (const bad of ['CI', 'yes', '1', 'local', 'ci ']) {
      assert.throws(() => suite.modeOf({ TANGLECLAW_SUITE_EVIDENCE: bad }), (err) => err instanceof evidence.Refusal && err.message.includes(`"${bad}"`));
    }
  });

  it('an unknown value runs nothing and exits 1, naming the value', async (t) => {
    const r = await run(t, { env: { TANGLECLAW_SUITE_EVIDENCE: 'yes' } });
    assert.equal(r.code, 1);
    assert.match(r.out, /^REFUSED: TANGLECLAW_SUITE_EVIDENCE is "yes", which selects no mode/m);
    assert.match(r.out, /nothing was run and no report was written/);
    assert.equal(r.seen.suiteArgs, null);
    assert.equal(r.seen.complement, null);
    assert.equal(fs.existsSync(r.junitPath), false);
  });

  it('nothing typed selects the mode: there is no flag for it, and an unknown argument refuses', async (t) => {
    for (const argv of [['--ci'], ['--mode', 'ci'], ['--local'], ['ci'], ['--junit']]) {
      const r = await run(t, { argv, env: {} });
      assert.equal(r.code, 1, argv.join(' '));
      assert.match(r.out, /^REFUSED: (unknown argument|--junit needs a value)/m);
      assert.match(r.out, /the mode comes from the environment/);
      assert.equal(r.seen.suiteArgs, null);
    }
  });
});

describe('suite-evidence — local mode is today\'s command, argument for argument', () => {
  it('hands node the declared test_command with {junit_xml} filled in, and exits with the suite\'s code', async (t) => {
    const r = await run(t, { env: {} });
    assert.equal(r.code, 0);
    assert.deepEqual(['node', ...r.seen.suiteArgs], DECLARED_TEST_COMMAND.map((a) => a.replace('{junit_xml}', r.junitPath)));
    assert.match(r.out, /^mode: local \(TANGLECLAW_SUITE_EVIDENCE is not set\): the declared suite, node --test /m);
    assert.match(r.out, new RegExp(`^junit: ${r.junitPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.equal(r.seen.complement, null, 'ci mode\'s machinery is not touched');
    assert.equal(r.seen.downloads.length, 0);
  });

  it('exits 1 when the suite does, and reaches none of ci mode', async (t) => {
    let text = '';
    const code = await suite.main(['--junit', path.join(os.tmpdir(), 'never-written.xml')], {
      stdout: { write: (s) => { text += s; } }, env: {},
      runSuite: () => ({ status: 1 }),
      git: () => { throw new Error('git must not be asked in local mode'); },
      readCheck: async () => { throw new Error('GitHub must not be asked in local mode'); }
    });
    assert.equal(code, 1);
    assert.match(text, /^mode: local/m);
  });

  it('without --junit the report goes to a file under the OS temp dir, and the path is printed', async (t) => {
    const r = await run(t, { env: {}, noJunitArg: true });
    assert.equal(r.code, 0);
    const destination = r.seen.suiteArgs.find((a) => a.startsWith('--test-reporter-destination=')).slice('--test-reporter-destination='.length);
    assert.ok(destination.startsWith(os.tmpdir()), destination);
    assert.ok(r.out.includes(`junit: ${destination}\n`));
  });

  it('--explain prints the mode and the command, and runs nothing', async (t) => {
    const r = await run(t, { env: {}, argv: ['--explain'] });
    assert.equal(r.code, 0);
    assert.match(r.out, /^mode: local/m);
    assert.equal(r.seen.suiteArgs, null);
    assert.equal(fs.existsSync(r.junitPath), false);
  });
});

describe('suite-evidence — the declaration is still today\'s command, so a cutover cannot ride in unnoticed', () => {
  it('the pinned test_command names node --test, not this command', () => {
    assert.equal(DECLARED_TEST_COMMAND[0], 'node');
    assert.equal(DECLARED_TEST_COMMAND[1], '--test');
    assert.ok(!DECLARED_TEST_COMMAND.some((a) => a.includes('suite-evidence')), 'the declaration does not name scripts/suite-evidence.js');
  });

  it('this checkout\'s project state, where it has one, declares exactly the pinned command', () => {
    const file = path.join(REPO_ROOT, '.prawduct', 'project-state.yaml');
    if (!fs.existsSync(file)) return;
    const m = /^test_command:\s*"([^"]+)"\s*$/m.exec(fs.readFileSync(file, 'utf8'));
    assert.ok(m, 'the project state declares a test_command');
    assert.deepEqual(m[1].split(' '), DECLARED_TEST_COMMAND);
  });

  it('the workflow still runs node --test itself and uploads no artifact: the packet\'s step has not landed', () => {
    const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
    assert.match(workflow, /run: node --test .* 'test\/\*\.test\.js'/);
    assert.ok(!workflow.includes('upload-artifact'), 'no upload step in the workflow this wave never edits');
    assert.ok(!workflow.includes('suite-evidence'), 'CI does not run this command');
  });
});

describe('suite-evidence — ci mode writes the merged report when every fact holds', () => {
  it('writes both reports whole, bound by the facts, obeying the identity the reader pins', async (t) => {
    const r = await run(t);
    assert.equal(r.code, 0, r.out);
    assert.ok(fs.existsSync(r.junitPath));
    assert.equal(fs.existsSync(`${r.junitPath}.tmp`), false);
    const merged = fs.readFileSync(r.junitPath, 'utf8');

    // Every testcase of each report, verbatim, including the escaped name.
    for (const name of ['a1', 'a2', 'b1', 'b2 &lt;quoted>', 'reads the real ps output']) {
      assert.ok(merged.includes(`<testcase name="${name}"`), `merged report carries ${name}`);
    }
    // The binding facts, as properties of their own suite.
    assert.ok(merged.includes(`<testsuite name="${suite.BINDING_SUITE}"`));
    for (const [name, value] of [
      ['repository', REPO], ['head', HEAD], ['tree', TREE], ['check_name', 'test'], ['check_run_id', GREEN.runId], ['check_app', 'github-actions'],
      ['check_completed_at', GREEN.completedAt], ['workflow_name', 'Tests'], ['workflow_run_id', GREEN.workflowRunId], ['workflow_event', 'pull_request'],
      ['base_branch', 'main'], ['base_tip', BASE_TIP], ['ledger_sha256', evidence.readLedger(path.join(r.dir, 'skip-ledger.json'))],
      ['artifact_id', '5001'], ['artifact_name', 'test-results'], ['complement_entries_ran', '1'], ['complement_entries_total', '1'], ['read_at', NOW]
    ]) {
      assert.ok(merged.includes(`<property name="${name}" value="${value}"/>`), `property ${name}=${value}`);
    }
    // One summary for the whole, and the identity holds on it: the reader reads the merged file as one green run.
    assert.equal((merged.match(/<!-- tests \d+ -->/g) || []).length, 1, 'the sources\' own trailers are not repeated');
    const verdict = results.reconcileText(merged);
    assert.equal(verdict.ok, true, results.formatReconciliation(verdict));
    assert.equal(verdict.canonical, CI_SUMMARY.tests + COMPLEMENT_SUMMARY.tests);
    assert.equal(verdict.leaf, 5);
    assert.deepEqual(verdict.tally, { testcases: 5, testsuites: 4, failures: 0, skipped: 0, todo: 0 });
    assert.equal(verdict.summary.suites, CI_SUMMARY.suites + COMPLEMENT_SUMMARY.suites + 1, 'the binding suite is counted as the node it is');
    assert.equal(verdict.summary.duration_ms, CI_SUMMARY.duration_ms + COMPLEMENT_SUMMARY.duration_ms);
    // The skip audit's walker reads the same cases.
    assert.equal(results.parseJunit(merged).total, 5);
  });

  it('says what it did: each fact as it held, the download, the complement, and where the report is', async (t) => {
    const r = await run(t);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) assert.match(r.out, new RegExp(`^fact ${n} holds: `, 'm'), `fact ${n}`);
    assert.match(r.out, /^fact artifact holds: listed: artifact 5001, 4096 bytes$/m);
    assert.match(r.out, /^downloaded: CI's report, 4 tests \(the runner's count\), 4 testcase leaves, green$/m);
    assert.match(r.out, /^running the complement: /m);
    assert.match(r.out, new RegExp(`^suite evidence written: ${r.junitPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(r.out, /^  merged: 5 tests \(the runner's count\), 5 testcase leaves, green$/m);
    assert.equal(r.seen.suiteArgs, null, 'the local suite did not run');
  });

  it('downloads exactly the run\'s artifact, by the names the facts read, and runs the complement once on the ledger', async (t) => {
    const r = await run(t);
    assert.deepEqual(r.seen.downloads, [{ repo: REPO, runId: GREEN.workflowRunId, name: 'test-results' }]);
    assert.equal(r.seen.complement.ledgerPath, path.join(r.dir, 'skip-ledger.json'));
    assert.ok(r.seen.complement.junitPath.endsWith('complement.xml'));
  });

  it('a push run of HEAD is accepted and recorded as the event', async (t) => {
    const r = await run(t, { workflowRun: { id: 39842690823, event: 'push', head_sha: HEAD, pull_requests: [] } });
    assert.equal(r.code, 0, r.out);
    assert.ok(fs.readFileSync(r.junitPath, 'utf8').includes('<property name="workflow_event" value="push"/>'));
  });

  it('reads the base named with --base', async (t) => {
    const r = await run(t, {
      argv: ['--base', 'release/next'],
      workflowRun: { id: 39842690823, event: 'pull_request', head_sha: HEAD, pull_requests: [{ head_sha: HEAD, base_ref: 'release/next' }] },
      baseTip: { name: 'release/next', sha: BASE_TIP }
    });
    assert.equal(r.code, 0, r.out);
    assert.ok(fs.readFileSync(r.junitPath, 'utf8').includes('<property name="base_branch" value="release/next"/>'));
  });

  it('leaves no unpacked artifact behind', async (t) => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tc-suite-evidence-') && !n.startsWith('tc-suite-evidence-test-'));
    await run(t);
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tc-suite-evidence-') && !n.startsWith('tc-suite-evidence-test-'));
    assert.deepEqual(after, before);
  });
});

describe('suite-evidence — each of the ten facts refuses alone, writing nothing', () => {
  it('1: the working tree is not clean', async (t) => {
    refused(await run(t, { git: { 'status --porcelain --untracked-files=all': { status: 0, stdout: ' M x.js\n' } } }), /the working tree is not clean/);
  });

  it('2: HEAD is not on the remote', async (t) => {
    refused(await run(t, { git: { [`rev-parse --verify ${UPSTREAM_REF}^{commit}`]: { status: 0, stdout: `${OTHER}\n` } } }), /HEAD is not on the remote/);
  });

  it('3: the remote is not a GitHub repository', async (t) => {
    refused(await run(t, { git: { 'remote get-url origin': { status: 0, stdout: 'https://gitlab.example/x/y.git\n' } } }), /does not name a GitHub repository/);
  });

  it('4: the check does not exist, is running, or did not succeed', async (t) => {
    refused(await run(t, { check: { status: 'not-found' } }), /does not exist: CI has not run on this commit/);
    refused(await run(t, { check: { status: 'running' } }), /has not finished/);
    refused(await run(t, { check: { ...GREEN, conclusion: 'failure' } }), /concluded failure, not success/);
  });

  it('5: the check run is not a job of HEAD', async (t) => {
    refused(await run(t, { job: { ...JOB, head_sha: OTHER } }), /is a job of another commit/);
  });

  it('6: the run is not a push or a pull request of HEAD into the base', async (t) => {
    refused(await run(t, { workflowRun: { ...RUN, event: 'workflow_dispatch' } }), /only a push or a pull request's run/);
    refused(await run(t, { workflowRun: { ...RUN, pull_requests: [{ head_sha: HEAD, base_ref: 'other' }] } }), /names no pull request of HEAD into main/);
  });

  it('7: the base tip is not inside HEAD', async (t) => {
    refused(await run(t, { git: { [`merge-base --is-ancestor ${BASE_TIP} ${HEAD}`]: { status: 1, stdout: '' } } }), /is not inside HEAD/);
  });

  it('8: the ledger is missing or does not compile', async (t) => {
    refused(await run(t, { ledger: null }), /the skip ledger cannot be read/);
    refused(await run(t, { ledger: '{"entries": [{"id": "x"}]}' }), /the skip ledger cannot be read/);
  });

  it('9: the complement is red, or did not run to a verdict', async (t) => {
    const red = await run(t, { complement: () => ({ ...greenRun(), ok: false, results: [{ id: 'pty', verdict: 'failed', ok: false, ran: true, detail: 'x' }] }) });
    refused(red, /the complement is red/);
    const stopped = await run(t, { complement: () => ({ ...greenRun(), ok: false, problems: ['report not found: /x'] }) });
    refused(stopped, /the complement did not run to a verdict/);
    assert.match(stopped.out, /^report not found: \/x$/m, 'the complement\'s own line is printed');
  });

  it('10: HEAD moved, or the ledger changed, while the complement ran', async (t) => {
    let reads = 0;
    const moved = await run(t, {
      git: { 'rev-parse --verify HEAD^{commit}': () => ({ status: 0, stdout: `${reads++ === 0 ? HEAD : OTHER}\n` }) }
    });
    refused(moved, /HEAD moved while the complement ran/);
    const changed = await run(t, {
      complement: (io) => {
        fs.writeFileSync(io.junitPath, COMPLEMENT_XML);
        fs.writeFileSync(io.ledgerPath, `${LEDGER}\n`);
        return greenRun();
      }
    });
    refused(changed, /the skip ledger changed while the complement ran/);
  });

  it('the facts are read in order, so a later fact is never asked about when an earlier one refused', async (t) => {
    let asked = false;
    let text = '';
    const code = await suite.main(['--junit', path.join(os.tmpdir(), 'never.xml')], {
      stdout: { write: (s) => { text += s; } }, env: { TANGLECLAW_SUITE_EVIDENCE: 'ci' },
      git: fakeGit({ 'status --porcelain --untracked-files=all': { status: 0, stdout: '?? y\n' } }).git,
      readCheck: async () => { asked = true; return GREEN; },
      readArtifacts: async () => { asked = true; return { ok: true, value: ARTIFACTS }; },
      runComplement: () => { asked = true; return greenRun(); }
    });
    assert.equal(code, 1);
    assert.equal(asked, false, 'GitHub and the complement were not reached');
    assert.match(text, /the working tree is not clean/);
  });
});

describe('suite-evidence — the artifact: every way CI\'s report can be missing refuses', () => {
  it('no artifact of the name on the run, which is every run until the workflow step lands', async (t) => {
    const r = await run(t, { artifacts: { total_count: 0, artifacts: [] } });
    refused(r, /no artifact named `test-results` on workflow run 39842690823: the workflow uploads none until the Operator lands the packet's upload step/);
    assert.equal(r.seen.complement, null, 'the complement, a wide run, is not started for a report that cannot exist');
    assert.equal(r.seen.downloads.length, 0);
  });

  it('an artifact of another name only', async (t) => {
    refused(await run(t, { artifacts: { total_count: 1, artifacts: [{ ...ARTIFACTS.artifacts[0], name: 'coverage' }] } }), /no artifact named `test-results`/);
  });

  it('two artifacts of the name', async (t) => {
    refused(await run(t, { artifacts: { total_count: 2, artifacts: [ARTIFACTS.artifacts[0], { ...ARTIFACTS.artifacts[0], id: 5002 }] } }), /2 artifacts named `test-results`/);
  });

  it('an expired artifact', async (t) => {
    refused(await run(t, { artifacts: { total_count: 1, artifacts: [{ ...ARTIFACTS.artifacts[0], expired: true }] } }), /has expired/);
  });

  it('an artifact of another run or another commit', async (t) => {
    refused(await run(t, { artifacts: { total_count: 1, artifacts: [{ ...ARTIFACTS.artifacts[0], workflow_run: { id: 1, head_sha: HEAD } }] } }), /belongs to another workflow run/);
    refused(await run(t, { artifacts: { total_count: 1, artifacts: [{ ...ARTIFACTS.artifacts[0], workflow_run: { id: 39842690823, head_sha: OTHER } }] } }), /is of another commit/);
  });

  it('an empty artifact, or one without an id', async (t) => {
    refused(await run(t, { artifacts: { total_count: 1, artifacts: [{ ...ARTIFACTS.artifacts[0], size_in_bytes: 0 }] } }), /is empty/);
    refused(await run(t, { artifacts: { total_count: 1, artifacts: [{ ...ARTIFACTS.artifacts[0], id: 'x' }] } }), /was read without an id/);
  });

  it('the artifacts cannot be read, or the answer lists none', async (t) => {
    refused(await run(t, { artifactsRead: { ok: false, reason: 'gh api timed out' } }), /the artifacts of workflow run 39842690823 could not be read: gh api timed out/);
    refused(await run(t, { artifacts: { total_count: 1 } }), /lists none/);
  });

  it('the download fails, or unpacks no test-results.xml', async (t) => {
    refused(await run(t, { ciXml: () => ({ ok: false, reason: 'gh run download exited 1' }) }), /could not be downloaded: gh run download exited 1/);
    refused(await run(t, { ciXml: null }), /unpacked no `test-results.xml`/);
  });

  it('CI\'s report is not the whole green report of one run: no summary, a broken identity, a failure', async (t) => {
    refused(await run(t, { ciXml: junit(SUITE('alpha', 1, 0, CASE('a1'))) }), /CI's report is not the whole green report of one run:[\s\S]*no runner summary found/);
    refused(await run(t, { ciXml: junit(SUITE('alpha', 1, 0, CASE('a1')), CI_SUMMARY) }), /CI's report is not the whole green report[\s\S]*not the run the summary describes/);
    const redSummary = { ...CI_SUMMARY, tests: 2, suites: 1, pass: 1, fail: 1 };
    refused(await run(t, { ciXml: junit(SUITE('alpha', 2, 1, [CASE('a1'), FAILED_CASE('a2')].join('\n')), redSummary) }), /CI's report is not the whole green report[\s\S]*RED: the summary counts 1 failed/);
  });

  it('the complement\'s report is not the whole green report of its run', async (t) => {
    refused(await run(t, { complementXml: junit(SUITE('watcher', 1, 0, CASE('reads the real ps output'))) }), /the complement's report is not the whole green report of one run/);
  });

});

describe('suite-evidence — --explain in ci mode reads what it can and runs nothing', () => {
  it('names each fact as it holds, the artifact refusal, 9 and 10 as needing the run, and the verdict', async (t) => {
    const r = await run(t, { argv: ['--explain'], artifacts: { total_count: 0, artifacts: [] } });
    assert.equal(r.code, 0);
    assert.match(r.out, /^mode: ci \(TANGLECLAW_SUITE_EVIDENCE=ci\)/m);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.match(r.out, new RegExp(`^fact ${n}, .*: holds: `, 'm'), `fact ${n}`);
    assert.match(r.out, /^fact artifact, .*: REFUSED: no artifact named `test-results` on workflow run 39842690823/m);
    assert.match(r.out, /^fact 9, .*: not read: --explain runs nothing/m);
    assert.match(r.out, /^fact 10, .*: not read: --explain runs nothing/m);
    assert.match(r.out, /^verdict: the run would refuse, so nothing would be written and the gate would read red$/m);
    assert.equal(r.seen.complement, null);
    assert.equal(r.seen.downloads.length, 0);
    assert.equal(r.seen.suiteArgs, null);
    assert.equal(fs.existsSync(r.junitPath), false);
  });

  it('when every readable fact holds, says so and still runs nothing', async (t) => {
    const r = await run(t, { argv: ['--explain'] });
    assert.equal(r.code, 0);
    assert.match(r.out, /^fact artifact, .*: holds: listed: artifact 5001, 4096 bytes$/m);
    assert.match(r.out, /^verdict: every fact that can be read without a run holds/m);
    assert.equal(r.seen.complement, null);
    assert.equal(r.seen.downloads.length, 0, 'the download is part of the run, not of --explain');
    assert.equal(fs.existsSync(r.junitPath), false);
  });

  it('an early refusal marks the facts after it as not read', async (t) => {
    const r = await run(t, { argv: ['--explain'], check: { status: 'not-found' } });
    assert.match(r.out, /^fact 4, .*: REFUSED: .*does not exist/m);
    for (const n of [5, 6, 7, 8, 'artifact']) assert.match(r.out, new RegExp(`^fact ${n}, .*: not read: it depends on the fact that refused`, 'm'), `fact ${n}`);
    assert.match(r.out, /^verdict: the run would refuse/m);
  });
});

describe('suite-evidence — the merge on fixtures', () => {
  it('keeps each report\'s children verbatim and drops only their trailing summary comments', () => {
    const children = suite.childrenOf(CI_XML, 'x');
    assert.ok(children.includes('<testsuite name="alpha"'));
    assert.ok(children.includes('<undefined name="root">'), 'the reporter\'s wrapper element is kept as it was');
    assert.ok(!/<!-- tests \d+ -->/.test(children));
    assert.throws(() => suite.childrenOf('<not-junit/>', 'x'), /is not a junit document/);
  });

  it('sums the two summaries, counts the binding suite, and escapes the facts', () => {
    const merged = suite.mergeReports({ xml: CI_XML, summary: CI_SUMMARY }, { xml: COMPLEMENT_XML, summary: COMPLEMENT_SUMMARY },
      { head: HEAD, artifact_name: 'test-results', workflow_run_id: '1', odd: 'a "b" <c> & d' });
    const verdict = results.reconcileText(merged);
    assert.equal(verdict.ok, true, results.formatReconciliation(verdict));
    assert.deepEqual(verdict.summary, { tests: 5, suites: 4, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 1284.5 });
    assert.ok(merged.includes('<property name="odd" value="a &quot;b&quot; &lt;c&gt; &amp; d"/>'));
  });

  it('refuses a report that is not green, naming whose it is', () => {
    assert.throws(() => suite.requireGreenReport(junit(SUITE('a', 1, 0, CASE('x'))), 'CI\'s report'), /CI's report is not the whole green report of one run/);
    const green = suite.requireGreenReport(COMPLEMENT_XML, 'x');
    assert.equal(green.canonical, 1);
  });
});

describe('suite-evidence — ci-evidence.js is reused, not copied, and its command is unchanged', () => {
  it('the facts are read through ci-evidence.js\'s own step functions', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'suite-evidence.js'), 'utf8');
    for (const step of ['readTree', 'readRemote', 'readRepository', 'requireCheck', 'requireJob', 'readBaseBranch', 'requireRun', 'requireBase', 'readLedger', 'requireComplement']) {
      assert.ok(source.includes(`evidence.${step}(`), `uses evidence.${step}`);
      assert.ok(!new RegExp(`^function ${step}\\b`, 'm').test(source), `does not redefine ${step}`);
    }
    assert.equal(typeof evidence.gather, 'function', 'ci-evidence.js keeps its own command');
    assert.deepEqual(evidence.parseArgs([]), { base: null });
  });
});

describe('suite-evidence — reading GitHub', () => {
  it('lists a run\'s artifacts by its id, keeping the fields it judges', async (t) => {
    const calls = [];
    const original = suite._internal.exec;
    suite._internal.exec = async (args) => { calls.push(args); return { exitCode: 0, stdout: JSON.stringify({ total_count: 0, artifacts: [] }) }; };
    t.after(() => { suite._internal.exec = original; });
    const read = await suite.readArtifacts(REPO, '39842690823');
    assert.deepEqual(read, { ok: true, value: { total_count: 0, artifacts: [] } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ['api', `repos/${REPO}/actions/runs/39842690823/artifacts`]);
    assert.ok(calls[0][3].includes('head_sha: .workflow_run.head_sha'));
  });

  it('downloads one artifact of one run into the folder, through gh, and answers not-ok with the reason when gh fails', async (t) => {
    const calls = [];
    const original = suite._internal.exec;
    suite._internal.exec = async (args) => { calls.push(args); return { exitCode: 1, stdout: '', stderr: 'no artifact matches' }; };
    t.after(() => { suite._internal.exec = original; });
    const r = await suite.downloadArtifact(REPO, '39842690823', 'test-results', '/tmp/x');
    assert.equal(r.ok, false);
    assert.match(r.reason, /gh run download/);
    assert.deepEqual(calls[0], ['run', 'download', '39842690823', '-R', REPO, '-n', 'test-results', '-D', '/tmp/x']);
  });

  it('answers not-ok when gh answers with something that is not JSON', async (t) => {
    const original = suite._internal.exec;
    suite._internal.exec = async () => ({ exitCode: 0, stdout: 'not json' });
    t.after(() => { suite._internal.exec = original; });
    const read = await suite.readArtifacts(REPO, '1');
    assert.deepEqual(read, { ok: false, reason: 'gh answered with something that is not JSON' });
  });
});
