#!/usr/bin/env node
'use strict';

/**
 * Record the suite as Prawduct's evidence without letting Prawduct under-count
 * it (#2521).
 *
 * Prawduct's recorder counts only the `<testcase>`s beneath a top-level
 * `<testsuite>`, and node:test's junit reporter puts cases elsewhere too (see
 * `lib/test-results.js`, "Handing a report to Prawduct"). A full-suite record
 * made the ordinary way can therefore read green over a deterministic red.
 * This command is the path that cannot: it runs the suite, judges the report
 * itself, hands Prawduct a report it reads whole, and checks what Prawduct
 * wrote. Five steps, in order, and the first that does not hold refuses:
 *
 *   1. run       `scripts/suite-evidence.js --junit <raw>`, so the mode is
 *                whatever `TANGLECLAW_SUITE_EVIDENCE` selects (local: the
 *                declared suite; ci: CI's exact-head report merged with the
 *                complement). This command runs no suite of its own.
 *   2. reconcile the raw report with `lib/test-results.js`: it must be the run
 *                its summary describes, and green.
 *   3. hoist     every leaf beneath a top-level `<testsuite>`, conserving
 *                leaves, failures and skips.
 *   4. ingest    `prawduct-hook test-evidence record --from-junit <hoisted>`.
 *   5. verify    `.prawduct/.test-evidence.json`: Prawduct's passed + failed +
 *                skipped equal the report's leaves, failed is 0, and skipped
 *                equals the report's skipped elements.
 *
 * Prawduct is reached only at step 4, so a refusal before it records nothing,
 * and the gate keeps reading whatever it read before (stale for a new tree).
 * A refusal at step 5 cannot withdraw Prawduct's record; the receipt says it is
 * wrong and the command exits 1.
 *
 * Both reports are kept beside each other, named by the head commit, so what
 * was recorded can be re-read: `<keep>/<head>.raw.junit.xml` as the runner or
 * suite-evidence wrote it, and `<keep>/<head>.prawduct.junit.xml` as handed to
 * Prawduct. The raw report of the same head is removed before the run, so a
 * report left by an earlier attempt can never be read as this run's.
 *
 * Every outcome writes the receipt `.tangleclaw/test-recorder.json`: the head
 * and its tree, the mode, the runner's summary and the report's tally, both
 * reports with their sha256, what Prawduct recorded, and the verdict or the
 * refusal with its step. `.tangleclaw/*` is gitignored, so the receipt and the
 * kept reports stay on the host.
 *
 * Usage: node scripts/record-test-run.js [--keep <dir>] [--base <branch>]
 *   --keep <dir>     where the two reports go (default `.tangleclaw/test-runs`)
 *   --base <branch>  passed to suite-evidence.js; read in ci mode only
 * Exit 0 when Prawduct's record was verified; 1 on any refusal.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const results = require('../lib/test-results');
const { modeOf } = require('./suite-evidence');

const ROOT = path.join(__dirname, '..');
const SUITE_EVIDENCE = path.join(__dirname, 'suite-evidence.js');

/** The receipt, the kept reports and Prawduct's record, relative to the repository root. */
const PATHS = Object.freeze({
  keep: path.join('.tangleclaw', 'test-runs'),
  receipt: path.join('.tangleclaw', 'test-recorder.json'),
  evidence: path.join('.prawduct', '.test-evidence.json')
});

/** The steps, in the order they run; a refusal names one. */
const STEPS = Object.freeze(['run', 'reconcile', 'hoist', 'ingest', 'verify']);

/** A step that did not hold. */
class Refusal extends Error {
  /**
   * @param {string} step - One of {@link STEPS}, or 'args'
   * @param {string} message - Why
   */
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

/**
 * Parse argv.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{keep: string|null, base: string|null}}
 * @throws {Refusal} On an unknown argument or a flag with no value
 */
function parseArgs(argv) {
  const parsed = { keep: null, base: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if ((flag === '--keep' || flag === '--base') && argv[i + 1]) {
      parsed[flag.slice(2)] = argv[++i];
      continue;
    }
    throw new Refusal('args', `${flag === '--keep' || flag === '--base' ? `${flag} needs a value` : `unknown argument "${flag}"`}\n`
      + 'usage: record-test-run.js [--keep <dir>] [--base <branch>]');
  }
  return parsed;
}

/**
 * The sha256 of a file's bytes, or null when it cannot be read.
 *
 * @param {string} file - Path to the file
 * @returns {string|null}
 */
function sha256Of(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Read one line of git output.
 *
 * @param {function(string[]): {status: (number|null), stdout: string}} git - Runs git in the repository
 * @param {string[]} args - git arguments
 * @returns {string|null} The trimmed output, or null when git failed
 */
function gitLine(git, args) {
  const r = git(args);
  return r.status === 0 ? String(r.stdout).trim() : null;
}

/**
 * Hold Prawduct's record to the report it was given.
 *
 * @param {{passed: number, failed: number, skipped: number}} recorded - From `.test-evidence.json`
 * @param {{testcases: number, failures: number, skipped: number, todo: number}} tally - The raw report's tally
 * @returns {string[]} Every disagreement, empty when the record is the report's
 */
function disagreements(recorded, tally) {
  const out = [];
  const leaves = recorded.passed + recorded.failed + recorded.skipped;
  if (![recorded.passed, recorded.failed, recorded.skipped].every(Number.isInteger)) {
    return [`the record's counts are not integers: passed ${recorded.passed}, failed ${recorded.failed}, skipped ${recorded.skipped}`];
  }
  if (leaves !== tally.testcases) out.push(`Prawduct recorded ${leaves} leaves (passed ${recorded.passed} + failed ${recorded.failed} + skipped ${recorded.skipped}); the report holds ${tally.testcases}`);
  if (recorded.failed !== 0) out.push(`Prawduct recorded failed ${recorded.failed} on a report this command read as green`);
  if (recorded.skipped !== tally.skipped + tally.todo) out.push(`Prawduct recorded skipped ${recorded.skipped}; the report holds ${tally.skipped + tally.todo} skipped elements`);
  return out;
}

/**
 * Run the five steps and write the receipt.
 *
 * The seams exist for the tests; a caller on the command line reaches none of
 * them.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {object} [io] - Injection seams
 * @param {{write: function(string): any}} [io.stdout] - Where the lines go
 * @param {Object<string, string|undefined>} [io.env] - The environment, passed to suite-evidence.js
 * @param {string} [io.root] - The repository root the paths are under
 * @param {function(string[]): {status: (number|null), stdout: string}} [io.git] - Runs git in the repository
 * @param {function(string[], Object<string, string|undefined>): {status: (number|null), error?: Error}} [io.runSuiteEvidence] - Runs suite-evidence.js with these arguments
 * @param {function(string[]): {status: (number|null), stdout?: string, stderr?: string, error?: Error}} [io.runPrawduct] - Runs prawduct-hook with these arguments
 * @param {function(): Date} [io.now] - The clock
 * @returns {number} The exit code
 */
function recordTestRun(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const env = io.env || process.env;
  const root = io.root || ROOT;
  const git = io.git || ((args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }));
  const runSuiteEvidence = io.runSuiteEvidence
    || ((args, childEnv) => spawnSync(process.execPath, [SUITE_EVIDENCE, ...args], { cwd: root, env: childEnv, stdio: 'inherit' }));
  const runPrawduct = io.runPrawduct
    || ((args) => spawnSync('prawduct-hook', args, { cwd: root, encoding: 'utf8' }));
  const now = io.now || (() => new Date());

  const receipt = {
    head: null, tree: null, dirty: null, mode: null, summary: null, tally: null,
    raw: null, hoisted: null, prawduct: null, verdict: 'refused', refusal: null, written_at: null
  };
  const receiptPath = path.join(root, PATHS.receipt);
  const finish = (code) => {
    receipt.written_at = now().toISOString();
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    out.write(`receipt: ${receiptPath}\n`);
    return code;
  };

  try {
    const parsed = parseArgs(argv);
    receipt.head = gitLine(git, ['rev-parse', 'HEAD']);
    receipt.tree = gitLine(git, ['rev-parse', 'HEAD^{tree}']);
    const status = git(['status', '--porcelain', '--untracked-files=all']);
    receipt.dirty = status.status === 0 ? String(status.stdout).trim() !== '' : null;
    if (!receipt.head || !receipt.tree) throw new Refusal('run', 'git could not read HEAD and its tree');

    // 1. run
    try {
      receipt.mode = modeOf(env);
    } catch (err) {
      throw new Refusal('run', err.message);
    }
    const keep = path.resolve(root, parsed.keep || PATHS.keep);
    fs.mkdirSync(keep, { recursive: true });
    const rawPath = path.join(keep, `${receipt.head}.raw.junit.xml`);
    const hoistedPath = path.join(keep, `${receipt.head}.prawduct.junit.xml`);
    fs.rmSync(rawPath, { force: true });
    fs.rmSync(hoistedPath, { force: true });
    out.write(`step 1 run: suite-evidence.js in ${receipt.mode} mode on ${receipt.head}${receipt.dirty ? ' (working tree has changes)' : ''}\n`);
    const args = ['--junit', rawPath, ...(parsed.base ? ['--base', parsed.base] : [])];
    const run = runSuiteEvidence(args, env);
    if (run.error) throw new Refusal('run', `suite-evidence.js could not be started: ${run.error.message}`);
    receipt.raw = { path: rawPath, sha256: sha256Of(rawPath) };
    if (!receipt.raw.sha256) throw new Refusal('run', `suite-evidence.js wrote no report at ${rawPath} (exit ${run.status})`);

    // 2. reconcile
    const rawXml = fs.readFileSync(rawPath, 'utf8');
    const judged = results.reconcileText(rawXml);
    receipt.summary = judged.summary;
    receipt.tally = judged.tally;
    out.write(`step 2 reconcile:\n${results.formatReconciliation(judged)}\n`);
    if (!judged.ok) throw new Refusal('reconcile', [...judged.problems, ...judged.red].join('; '));
    if (run.status !== 0) throw new Refusal('run', `suite-evidence.js exited ${run.status} although its report reads green`);

    // 3. hoist
    let hoisted;
    try {
      hoisted = results.hoistToTopLevelSuites(rawXml);
    } catch (err) {
      if (err.code !== 'JUNIT_SHAPE') throw err;
      throw new Refusal('hoist', err.message);
    }
    fs.writeFileSync(hoistedPath, hoisted.xml);
    receipt.hoisted = { path: hoistedPath, sha256: sha256Of(hoistedPath), added: hoisted.added };
    out.write(`step 3 hoist: ${hoisted.added} element(s) became or were wrapped in a top-level <testsuite>; Prawduct will read ${judged.tally.testcases} leaves (it would have read ${results.prawductView(rawXml).testcases} of the raw report)\n`);

    // 4. ingest
    const ingest = runPrawduct(['test-evidence', 'record', '--from-junit', hoistedPath]);
    if (ingest.error) throw new Refusal('ingest', `prawduct-hook could not be started: ${ingest.error.message}`);
    if (ingest.status !== 0) throw new Refusal('ingest', `prawduct-hook test-evidence record exited ${ingest.status}: ${String(ingest.stderr || ingest.stdout || '').trim()}`);
    out.write('step 4 ingest: prawduct-hook test-evidence record --from-junit accepted the report\n');

    // 5. verify
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(root, PATHS.evidence), 'utf8'));
    } catch (err) {
      throw new Refusal('verify', `${PATHS.evidence} could not be read back: ${err.message}`);
    }
    receipt.prawduct = { passed: record.passed, failed: record.failed, skipped: record.skipped, command: record.command };
    if (typeof record.command !== 'string' || !record.command.includes(hoistedPath)) {
      throw new Refusal('verify', `${PATHS.evidence} is not the record of ${hoistedPath} (its command is ${JSON.stringify(record.command)})`);
    }
    const wrong = disagreements(record, judged.tally);
    if (wrong.length) throw new Refusal('verify', wrong.join('; '));
    receipt.verdict = 'recorded';
    out.write(`step 5 verify: Prawduct recorded passed ${record.passed}, failed ${record.failed}, skipped ${record.skipped}: the report's ${judged.tally.testcases} leaves, all of them\n`);
    return finish(0);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    receipt.refusal = { step: err.step, reason: err.message };
    out.write(`REFUSED at step ${err.step}: ${err.message}\n`
      + `${STEPS.indexOf(err.step) < STEPS.indexOf('ingest') ? 'nothing was recorded' : 'the receipt marks Prawduct\'s record wrong'}\n`);
    return finish(1);
  }
}

module.exports = { PATHS, STEPS, Refusal, parseArgs, disagreements, recordTestRun };

if (require.main === module) {
  process.exitCode = recordTestRun(process.argv.slice(2));
}
