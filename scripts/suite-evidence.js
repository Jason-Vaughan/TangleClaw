#!/usr/bin/env node
'use strict';

/**
 * The suite command a gate could be pointed at (#2371, proposed; #2498 W4-03).
 *
 * Declared nowhere today. `.prawduct/project-state.yaml` still names
 * `node --test …` as `test_command`, and a test pins that it does. This file
 * is written so that it COULD be declared instead, at an Operator-held cutover
 * described in the activation packet, and so that declaring it changes nothing
 * until the environment says otherwise:
 *
 *   local mode (the default, with no `TANGLECLAW_SUITE_EVIDENCE` set): runs
 *   exactly today's command, `node --test --test-reporter=junit
 *   --test-reporter-destination=<junit> test/*.test.js`, argument for argument,
 *   and exits with its code. The gate records what it records today.
 *
 *   ci mode (`TANGLECLAW_SUITE_EVIDENCE=ci`): the green CI run on the exact
 *   head commit is the suite, and this command is what establishes it. Every
 *   one of the ten facts `scripts/ci-evidence.js` reads must hold for HEAD (a
 *   clean tree; HEAD on the remote; the remote's repository; the `test` check
 *   SUCCESS on the exact head; a GitHub Actions job of that commit; a push or a
 *   pull request's run of HEAD into the base; the base's tip inside HEAD; the
 *   skip ledger compiles; the complement run by this command is green; nothing
 *   moved while it ran) AND CI's real junit report for that run must exist as
 *   the workflow's uploaded artifact and be downloaded here. The two reports,
 *   CI's and the complement's, are merged into <junit> with the binding facts
 *   as `<property>` elements, and the command exits 0.
 *
 * It fails closed. Any fact that does not hold, and an artifact that does not
 * exist, which is the state of every run until the Operator lands the
 * workflow step the packet carries, is a named refusal: nothing is written at
 * <junit>, and the gate reads red. There is no synthetic report in any path: a
 * report whose structure is invented is not evidence.
 *
 * `--explain` says which mode would run and why, running nothing: in ci mode
 * it reads the facts it can read without a run and names the first that
 * refuses.
 *
 * Usage: node scripts/suite-evidence.js [--junit <path>] [--base <branch>] [--explain]
 *   --junit <path>   where the junit report goes (the gate passes {junit_xml});
 *                    a file under the OS temp dir, printed, when absent
 *   --base <branch>  ci mode only: the branch HEAD is headed for, as
 *                    ci-evidence.js takes it; the remote's default when absent
 *   --explain        print the mode and, in ci mode, each fact; run nothing
 * Exit 0 in local mode when the suite passed; in ci mode only when the merged
 * report was written; always for --explain, whose answer is its text.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { execFileArgs, describeFailure } = require('../lib/exec');
const { readCheck } = require('../lib/github-checks');
const results = require('../lib/test-results');
const evidence = require('./ci-evidence');
const { allArgv } = require('./test-stage');
const { DEFAULT_LEDGER } = require('./test-skip-audit');
const { runComplement } = require('./ci-complement');

const ROOT = path.join(__dirname, '..');

/** The environment variable that selects the mode, and the one value that selects ci mode. */
const MODE_ENV = 'TANGLECLAW_SUITE_EVIDENCE';
const CI_MODE = 'ci';

/** The artifact the packet's workflow step uploads, and the file inside it. */
const ARTIFACT_NAME = 'test-results';
const ARTIFACT_FILE = 'test-results.xml';

/** The name of the testsuite that carries the binding facts in the merged report. */
const BINDING_SUITE = 'suite-evidence: binding';

/** A download's time budget: the report of a full run is a few megabytes. */
const DOWNLOAD_TIMEOUT_MS = 120000;

const ID_SHAPE = /^[1-9][0-9]{0,18}$/;

/** The ten facts of ci-evidence.js, numbered as docs/lane-ci-evidence.md numbers them, then the artifact. */
const FACTS = Object.freeze([
  [1, 'the working tree is clean and HEAD is a commit'],
  [2, 'HEAD is on the remote'],
  [3, 'the repository is the remote\'s'],
  [4, 'the `test` check on HEAD concluded with success'],
  [5, 'the check run is a GitHub Actions job of HEAD'],
  [6, 'the workflow run tested HEAD against the base branch'],
  [7, 'the base branch\'s tip, read from GitHub, is inside HEAD'],
  [8, 'the ledger compiles'],
  ['artifact', `CI's junit report exists as the run's \`${ARTIFACT_NAME}\` artifact and was downloaded`],
  [9, 'the complement, run by this command, is green'],
  [10, 'nothing moved while it ran']
]);

const { Refusal } = evidence;

/** Seams for tests. */
const _internal = {
  exec: (args, timeoutMs) => execFileArgs('gh', args, { timeoutMs, maxBufferBytes: 64 * 1024 })
};

/**
 * Which mode the environment selects.
 *
 * @param {Object<string, string|undefined>} env - The process environment
 * @returns {'local'|'ci'} The mode
 */
function modeOf(env) {
  const value = env[MODE_ENV];
  if (value === undefined || value === '') return 'local';
  if (value === CI_MODE) return CI_MODE;
  throw new Refusal(`${MODE_ENV} is "${value}", which selects no mode: unset it for the local suite, or set it to "${CI_MODE}"`);
}

/**
 * Parse argv.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{junitPath: string|null, base: string|null, explain: boolean}}
 */
function parseArgs(argv) {
  const parsed = { junitPath: null, base: null, explain: false };
  const usage = 'usage: suite-evidence.js [--junit <path>] [--base <branch>] [--explain]';
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--explain') { parsed.explain = true; continue; }
    if ((flag === '--junit' || flag === '--base') && argv[i + 1]) {
      if (flag === '--junit') parsed.junitPath = path.resolve(argv[++i]);
      else parsed.base = argv[++i];
      continue;
    }
    throw new Refusal(`${flag === '--junit' || flag === '--base' ? `${flag} needs a value` : `unknown argument "${flag}"`}\n${usage}\n`
      + 'the mode comes from the environment, and every fact of ci mode is read, never typed');
  }
  return parsed;
}

/**
 * Read one object from the GitHub API through `gh`.
 *
 * @param {string} apiPath - The path after `api`
 * @param {string} projection - A jq filter keeping the fields read and no others
 * @returns {Promise<{ok: true, value: *}|{ok: false, reason: string}>}
 */
async function ghRead(apiPath, projection) {
  const r = await _internal.exec(['api', apiPath, '--jq', projection], 10000);
  if (r.exitCode !== 0) return { ok: false, reason: describeFailure(r, 'gh api') };
  try {
    return { ok: true, value: JSON.parse(r.stdout) };
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false, reason: 'gh answered with something that is not JSON' };
  }
}

/**
 * Read the artifacts of a workflow run from GitHub.
 *
 * @param {string} repo - `owner/name`
 * @param {string} workflowRunId - The workflow run's id
 * @returns {Promise<{ok: true, value: object}|{ok: false, reason: string}>}
 */
function readArtifacts(repo, workflowRunId) {
  return ghRead(
    `repos/${repo}/actions/runs/${workflowRunId}/artifacts`,
    '{total_count: .total_count, artifacts: [.artifacts[] | {id: .id, name: .name, expired: .expired, size_in_bytes: .size_in_bytes, '
      + 'workflow_run: {id: .workflow_run.id, head_sha: .workflow_run.head_sha}}]}'
  );
}

/**
 * Download one artifact of a workflow run into a folder, through `gh`, which
 * unpacks it.
 *
 * @param {string} repo - `owner/name`
 * @param {string} workflowRunId - The workflow run's id
 * @param {string} name - The artifact's name
 * @param {string} dir - The folder to unpack into
 * @returns {Promise<{ok: true}|{ok: false, reason: string}>}
 */
async function downloadArtifact(repo, workflowRunId, name, dir) {
  const r = await _internal.exec(['run', 'download', workflowRunId, '-R', repo, '-n', name, '-D', dir], DOWNLOAD_TIMEOUT_MS);
  if (r.exitCode !== 0) return { ok: false, reason: describeFailure(r, 'gh run download') };
  return { ok: true };
}

/**
 * Hold the run's artifacts to carrying CI's report: exactly one artifact of
 * the name the workflow step uploads, of this workflow run and this commit,
 * not expired, not empty.
 *
 * @param {{ok: boolean, value?: object, reason?: string}} read - An answer of `readArtifacts`
 * @param {{workflowRunId: string}} check - Output of `evidence.requireCheck`
 * @param {string} head - HEAD's full id
 * @returns {{id: string, name: string, sizeInBytes: number}}
 */
function requireArtifact(read, check, head) {
  const at = `workflow run ${check.workflowRunId}`;
  if (!read || !read.ok) throw new Refusal(`the artifacts of ${at} could not be read: ${read && read.reason ? read.reason : 'no answer'}`);
  const list = read.value;
  if (!list || typeof list !== 'object' || !Array.isArray(list.artifacts)) throw new Refusal(`GitHub answered for the artifacts of ${at} with something that lists none`);
  const named = list.artifacts.filter((a) => a && a.name === ARTIFACT_NAME);
  if (named.length === 0) {
    throw new Refusal(`no artifact named \`${ARTIFACT_NAME}\` on ${at}: the workflow uploads none until the Operator lands the packet's upload step, `
      + 'so CI\'s report cannot be read and nothing stands in for it');
  }
  if (named.length > 1) throw new Refusal(`${named.length} artifacts named \`${ARTIFACT_NAME}\` on ${at}: which is CI's report is not decidable`);
  const [artifact] = named;
  if (artifact.expired === true) throw new Refusal(`the \`${ARTIFACT_NAME}\` artifact of ${at} has expired: GitHub no longer holds CI's report`);
  if (!artifact.workflow_run || String(artifact.workflow_run.id) !== check.workflowRunId) {
    throw new Refusal(`the \`${ARTIFACT_NAME}\` artifact answered belongs to another workflow run than ${at}`);
  }
  if (artifact.workflow_run.head_sha !== head) {
    throw new Refusal(`the \`${ARTIFACT_NAME}\` artifact of ${at} is of another commit (${String(artifact.workflow_run.head_sha)}), not of HEAD`);
  }
  if (!Number.isInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0) throw new Refusal(`the \`${ARTIFACT_NAME}\` artifact of ${at} is empty`);
  if (!ID_SHAPE.test(String(artifact.id))) throw new Refusal(`the \`${ARTIFACT_NAME}\` artifact of ${at} was read without an id`);
  return { id: String(artifact.id), name: ARTIFACT_NAME, sizeInBytes: artifact.size_in_bytes };
}

/**
 * Hold a junit report to being the whole, green report of one run: it carries
 * the runner's own summary, the summary adds up, the report is the run the
 * summary describes (the identity `lib/test-results.js` pins), and nothing in
 * it is red.
 *
 * @param {string} xml - The report's text
 * @param {string} what - Whose report, for the refusal
 * @returns {ReturnType<typeof results.reconcile>} The reconciliation, ok
 */
function requireGreenReport(xml, what) {
  const verdict = results.reconcileText(xml);
  if (!verdict.ok) {
    throw new Refusal(`${what} is not the whole green report of one run:\n${results.formatReconciliation(verdict)}`);
  }
  return verdict;
}

/**
 * The inner markup of a junit report: what sits between `<testsuites>` and
 * `</testsuites>`, minus the runner's trailing summary comments, which the
 * merged report writes once for the whole.
 *
 * @param {string} xml - The report's text
 * @param {string} what - Whose report, for the refusal
 * @returns {string} The children, verbatim
 */
function childrenOf(xml, what) {
  const open = /<testsuites\b[^>]*>/.exec(xml);
  const close = xml.lastIndexOf('</testsuites>');
  if (!open || close === -1 || close < open.index) throw new Refusal(`${what} is not a junit document: no <testsuites> root`);
  return xml.slice(open.index + open[0].length, close)
    .split('\n')
    .filter((line) => !/^[ \t]*<!--[ \t]*(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)[ \t]+\d+(?:\.\d+)?[ \t]*-->[ \t]*$/.test(line))
    .join('\n');
}

/**
 * Escape text for an XML attribute value.
 *
 * @param {string} s - Raw text
 * @returns {string} Escaped text
 */
function xmlAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Merge CI's report and the complement's into one junit document: both sets
 * of suites verbatim, one more suite carrying the binding facts as
 * `<property>` elements, and one trailing summary that is the sum of the two
 * runs' plus that suite, so the merged document obeys the same identity each
 * part does (testcases + testsuites == tests + suites) and `reconcileText`
 * reads it as one green run.
 *
 * @param {{xml: string, summary: object}} ci - CI's report and its reconciled summary
 * @param {{xml: string, summary: object}} complement - The complement's report and its reconciled summary
 * @param {Object<string, string>} binding - The facts, by property name
 * @returns {string} The merged document
 */
function mergeReports(ci, complement, binding) {
  const summary = {};
  for (const k of results.SUMMARY_KEYS) summary[k] = ci.summary[k] + complement.summary[k];
  summary.suites += 1;
  if (typeof ci.summary.duration_ms === 'number' && typeof complement.summary.duration_ms === 'number') {
    summary.duration_ms = ci.summary.duration_ms + complement.summary.duration_ms;
  }
  const properties = Object.entries(binding)
    .map(([name, value]) => `\t\t\t<property name="${xmlAttr(name)}" value="${xmlAttr(value)}"/>`)
    .join('\n');
  const trailer = Object.entries(summary).map(([k, v]) => `\t<!-- ${k} ${v} -->`).join('\n');
  return '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<testsuites>\n'
    + `\t<!-- suite-evidence: CI's report (artifact ${xmlAttr(binding.artifact_name)} of workflow run ${xmlAttr(binding.workflow_run_id)}) `
    + `followed by the complement's, then the suite "${BINDING_SUITE}" holding the facts that bind them to commit ${xmlAttr(binding.head)} -->\n`
    + `${childrenOf(ci.xml, 'CI\'s report').replace(/^\n+|\n+$/g, '')}\n`
    + `${childrenOf(complement.xml, 'the complement\'s report').replace(/^\n+|\n+$/g, '')}\n`
    + `\t<testsuite name="${xmlAttr(BINDING_SUITE)}" time="0" disabled="0" errors="0" tests="0" failures="0" skipped="0">\n`
    + '\t\t<properties>\n'
    + `${properties}\n`
    + '\t\t</properties>\n'
    + '\t</testsuite>\n'
    + `${trailer}\n`
    + '</testsuites>\n';
}

/**
 * Read the facts that need no run: 1 to 8, then the artifact. The first that
 * does not hold is thrown as a `Refusal`; the facts read before it are in
 * `held`.
 *
 * @param {{base: string|null}} parsed - Output of `parseArgs`
 * @param {object} seams - The resolved seams of `main`
 * @param {Array<[number|string, string, string]>} held - Filled with `[fact, 'holds', detail]` as each holds
 * @returns {Promise<object>} What was read: head, tree, remote, repository, check, workflowName, branch, event, base, ledgerSha256, artifact
 */
async function readFacts(parsed, seams, held) {
  const { git, ledgerPath } = seams;
  const read = {};
  const hold = (fact, detail) => held.push([fact, 'holds', detail]);
  Object.assign(read, evidence.readTree(git));
  hold(1, `HEAD ${read.head}`);
  read.remote = evidence.readRemote(git, read.head);
  hold(2, `the branch's upstream on ${read.remote} is HEAD`);
  read.repository = evidence.readRepository(git, read.remote);
  hold(3, read.repository);
  read.check = evidence.requireCheck(await seams.readCheck(read.repository, read.head, evidence.CHECK_NAME), read.head);
  hold(4, `check run ${read.check.runId} concluded ${read.check.conclusion} at ${read.check.completedAt}`);
  read.workflowName = evidence.requireJob(await seams.readJob(read.repository, read.check.runId), read.check, read.head);
  hold(5, `a job of workflow "${read.workflowName}", run ${read.check.workflowRunId}`);
  read.branch = evidence.readBaseBranch(git, read.remote, parsed.base);
  read.event = evidence.requireRun(await seams.readRun(read.repository, read.check.workflowRunId), read.check, read.branch, read.head);
  hold(6, `a ${read.event} run${read.event === 'pull_request' ? ` of HEAD into ${read.branch}` : ''}`);
  read.base = evidence.requireBase(await seams.readBaseTip(read.repository, read.branch), read.branch, read.head, git);
  hold(7, `${read.base.branch} is at ${read.base.tip}`);
  read.ledgerSha256 = evidence.readLedger(ledgerPath);
  hold(8, `sha256 ${read.ledgerSha256}`);
  read.artifact = requireArtifact(await seams.readArtifacts(read.repository, read.check.workflowRunId), read.check, read.head);
  hold('artifact', `listed: artifact ${read.artifact.id}, ${read.artifact.sizeInBytes} bytes`);
  return read;
}

/**
 * Run ci mode end to end: every fact, the download, the complement, the
 * second read of the tree, the merge, the write. Throws a `Refusal` at the
 * first fact that does not hold; nothing is written before the last line.
 *
 * @param {{base: string|null, junitPath: string}} parsed - Output of `parseArgs`, the junit path resolved
 * @param {object} seams - The resolved seams of `main`
 * @returns {Promise<{read: object, merged: ReturnType<typeof results.reconcile>}>}
 */
async function runCi(parsed, seams) {
  const { git, out, ledgerPath } = seams;
  const held = [];
  const read = await readFacts(parsed, seams, held);
  for (const [fact, , detail] of held) out.write(`fact ${fact} holds: ${detail}\n`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-suite-evidence-'));
  try {
    const downloaded = await seams.downloadArtifact(read.repository, read.check.workflowRunId, read.artifact.name, dir);
    if (!downloaded || !downloaded.ok) {
      throw new Refusal(`the \`${ARTIFACT_NAME}\` artifact of workflow run ${read.check.workflowRunId} could not be downloaded: ${downloaded && downloaded.reason ? downloaded.reason : 'no answer'}`);
    }
    const ciFile = path.join(dir, ARTIFACT_FILE);
    if (!fs.existsSync(ciFile)) throw new Refusal(`the \`${ARTIFACT_NAME}\` artifact unpacked no \`${ARTIFACT_FILE}\`: it is not the report the workflow step uploads`);
    const ciXml = fs.readFileSync(ciFile, 'utf8');
    const ciVerdict = requireGreenReport(ciXml, 'CI\'s report');
    out.write(`downloaded: CI's report, ${ciVerdict.canonical} tests (the runner's count), ${ciVerdict.leaf} testcase leaves, green\n`);

    out.write('running the complement: the tests CI is allowed to skip, on this machine\n');
    const complementJunit = path.join(dir, 'complement.xml');
    const complement = evidence.requireComplement(seams.runComplement({ ledgerPath, junitPath: complementJunit }), out);
    const complementXml = fs.readFileSync(complementJunit, 'utf8');
    const complementVerdict = requireGreenReport(complementXml, 'the complement\'s report');
    out.write(`fact 9 holds: ${complement.entriesRan} of ${complement.entriesTotal} ledger entries ran here; ${complementVerdict.canonical} tests in its report, green\n`);

    const after = evidence.readTree(git);
    if (after.head !== read.head || after.tree !== read.tree) throw new Refusal('HEAD moved while the complement ran');
    if (evidence.readLedger(ledgerPath) !== read.ledgerSha256) throw new Refusal('the skip ledger changed while the complement ran');
    out.write('fact 10 holds: the tree and the ledger are as they were\n');

    const binding = {
      repository: read.repository,
      head: read.head,
      tree: read.tree,
      check_name: read.check.name,
      check_run_id: read.check.runId,
      check_app: read.check.app,
      check_completed_at: read.check.completedAt,
      workflow_name: read.workflowName,
      workflow_run_id: read.check.workflowRunId,
      workflow_event: read.event,
      base_branch: read.base.branch,
      base_tip: read.base.tip,
      ledger_path: path.relative(ROOT, ledgerPath),
      ledger_sha256: read.ledgerSha256,
      artifact_id: read.artifact.id,
      artifact_name: read.artifact.name,
      complement_entries_ran: String(complement.entriesRan),
      complement_entries_total: String(complement.entriesTotal),
      read_at: seams.now().toISOString()
    };
    const mergedXml = mergeReports({ xml: ciXml, summary: ciVerdict.summary }, { xml: complementXml, summary: complementVerdict.summary }, binding);
    const merged = requireGreenReport(mergedXml, 'the merged report');

    // Whole or not at all: a reader never meets a half-written report.
    fs.mkdirSync(path.dirname(parsed.junitPath), { recursive: true });
    fs.writeFileSync(`${parsed.junitPath}.tmp`, mergedXml);
    fs.renameSync(`${parsed.junitPath}.tmp`, parsed.junitPath);
    return { read, merged };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Explain ci mode without running anything: read facts 1 to 8 and the
 * artifact, print each as it holds or refuses, say that 9 and 10 need the run,
 * and end with the verdict the run would reach.
 *
 * @param {{base: string|null}} parsed - Output of `parseArgs`
 * @param {object} seams - The resolved seams of `main`
 * @returns {Promise<void>}
 */
async function explainCi(parsed, seams) {
  const { out } = seams;
  const held = [];
  let refused = null;
  try {
    await readFacts(parsed, seams, held);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    refused = err.message;
  }
  // Facts are read in FACTS order, so the first fact that neither held nor
  // needs the run is the one that refused; everything after it was not reached.
  const holds = new Map(held.map(([fact, , detail]) => [String(fact), detail]));
  let attributed = refused === null;
  for (const [fact, name] of FACTS) {
    let state;
    if (holds.has(String(fact))) state = `holds: ${holds.get(String(fact))}`;
    else if (fact === 9 || fact === 10) state = 'not read: --explain runs nothing, and this fact is read from the run';
    else if (!attributed) { state = `REFUSED: ${refused}`; attributed = true; }
    else state = 'not read: it depends on the fact that refused';
    out.write(`fact ${fact}, ${name}: ${state}\n`);
  }
  out.write(refused === null
    ? 'verdict: every fact that can be read without a run holds; the run would download the artifact, run the complement, read facts 9 and 10, and merge the two reports\n'
    : 'verdict: the run would refuse, so nothing would be written and the gate would read red\n');
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
 * @param {Object<string, string|undefined>} [io.env] - The environment read for the mode
 * @param {function(string[]): {status: (number|null)}} [io.runSuite] - Runs node with the suite's arguments in local mode
 * @param {function(string[]): {status: (number|null), stdout: string}} [io.git] - Runs git in the repository
 * @param {function(string, string, string): Promise<object>} [io.readCheck] - Reads the named check on a commit
 * @param {function(string, string): Promise<object>} [io.readJob] - Reads the job a check run claims to be
 * @param {function(string, string): Promise<object>} [io.readRun] - Reads the workflow run a job belongs to
 * @param {function(string, string): Promise<object>} [io.readBaseTip] - Reads a branch's tip from GitHub
 * @param {function(string, string): Promise<object>} [io.readArtifacts] - Reads a workflow run's artifacts
 * @param {function(string, string, string, string): Promise<object>} [io.downloadArtifact] - Downloads one artifact into a folder
 * @param {function(object): object} [io.runComplement] - Runs the complement and answers with its verdict
 * @param {function(): Date} [io.now] - The clock
 * @param {string} [io.ledgerPath] - The ledger to read
 * @returns {Promise<number>} The exit code
 */
async function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const seams = {
    out,
    git: io.git || evidence.gitIn(ROOT),
    readCheck: io.readCheck || readCheck,
    readJob: io.readJob || evidence.readJob,
    readRun: io.readRun || evidence.readRun,
    readBaseTip: io.readBaseTip || evidence.readBaseTip,
    readArtifacts: io.readArtifacts || readArtifacts,
    downloadArtifact: io.downloadArtifact || downloadArtifact,
    runComplement: io.runComplement || runComplement,
    now: io.now || (() => new Date()),
    ledgerPath: io.ledgerPath || DEFAULT_LEDGER
  };
  const runSuite = io.runSuite || ((args) => spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }));
  let parsed;
  let mode;
  try {
    parsed = parseArgs(argv);
    mode = modeOf(io.env || process.env);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    out.write(`REFUSED: ${err.message}\nnothing was run and no report was written\n`);
    return 1;
  }
  const junitPath = parsed.junitPath || path.join(os.tmpdir(), `tc-suite-evidence-${process.pid}.xml`);

  if (mode === 'local') {
    const args = allArgv(junitPath);
    out.write(`mode: local (${MODE_ENV} is not set): the declared suite, node ${args.join(' ')}\n`);
    if (parsed.explain) return 0;
    const r = runSuite(args);
    out.write(`junit: ${junitPath}\n`);
    return r.status === 0 ? 0 : 1;
  }

  out.write(`mode: ci (${MODE_ENV}=${CI_MODE}): CI's run on the exact head is the suite if every fact holds\n`);
  if (parsed.explain) {
    await explainCi(parsed, seams);
    return 0;
  }
  let outcome;
  try {
    outcome = await runCi({ ...parsed, junitPath }, seams);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    out.write(`REFUSED: ${err.message}\nno report was written: there is no synthetic report, so the gate reads red\n`);
    return 1;
  }
  const { read, merged } = outcome;
  out.write(`suite evidence written: ${junitPath}\n`
    + `  CI's \`${read.check.name}\` check (run ${read.check.runId}, workflow "${read.workflowName}", ${read.event} run ${read.check.workflowRunId}) concluded ${read.check.conclusion} on ${read.head}\n`
    + `  the base branch ${read.base.branch} is at ${read.base.tip}, which is inside HEAD\n`
    + `  merged: ${merged.canonical} tests (the runner's count), ${merged.leaf} testcase leaves, green\n`);
  return 0;
}

module.exports = {
  MODE_ENV, CI_MODE, ARTIFACT_NAME, ARTIFACT_FILE, BINDING_SUITE, FACTS,
  modeOf, parseArgs, readArtifacts, downloadArtifact, requireArtifact, requireGreenReport, childrenOf, mergeReports,
  readFacts, runCi, explainCi, main, _internal
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
