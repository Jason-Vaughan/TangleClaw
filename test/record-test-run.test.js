'use strict';

/**
 * `scripts/record-test-run.js`: the suite recorded as Prawduct's evidence
 * without Prawduct under-counting it (#2521).
 *
 * Every seam is injected: suite-evidence.js is replaced by a function that
 * writes a fixture report where it was told to, and prawduct-hook by one that
 * writes `.prawduct/.test-evidence.json` the way Prawduct 3.6.1 counts (only
 * beneath top-level suites, modelled by `prawductView`). Each test works in its
 * own temporary root, so the receipt and the kept reports are real files.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const recorder = require('../scripts/record-test-run');
const results = require('../lib/test-results');

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

/**
 * A junit document with the runner's summary as trailing comments placed
 * inside the `<undefined name="root">` element, the shape that hid #2521's red.
 *
 * @param {{fail?: boolean}} [opts] - Make the case inside `<undefined>` fail
 * @returns {string}
 */
function report({ fail = false } = {}) {
  const inner = fail
    ? '\t\t<testcase name="c2"><failure message="boom">Error: boom</failure></testcase>'
    : '\t\t<testcase name="c2"/>';
  return '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n'
    + '\t<testsuite name="first">\n\t\t<testcase name="a"/>\n\t\t<testcase name="s"><skipped type="skipped" message="host"/></testcase>\n\t</testsuite>\n'
    + '\t<testcase name="stray"/>\n'
    + '\t<undefined name="root">\n'
    + `\t\t<testcase name="c1"/>\n${inner}\n`
    + `\t<!-- tests 5 -->\n\t<!-- suites 1 -->\n\t<!-- pass ${fail ? 3 : 4} -->\n\t<!-- fail ${fail ? 1 : 0} -->\n`
    + '\t<!-- cancelled 0 -->\n\t<!-- skipped 1 -->\n\t<!-- todo 0 -->\n'
    + '\t</undefined>\n</testsuites>\n';
}

/**
 * Prawduct's recorder as measured: counts the hoisted report's leaves beneath
 * top-level suites and writes its record.
 *
 * @param {string} root - The repository root
 * @param {object} [override] - Fields to write instead of the counted ones
 * @returns {function(string[]): {status: number}}
 */
function fakePrawduct(root, override = {}) {
  return (args) => {
    const file = args[args.indexOf('--from-junit') + 1];
    const v = results.prawductView(fs.readFileSync(file, 'utf8'));
    const failed = v.failures + v.errors;
    const record = {
      command: `--from-junit ${file}`,
      evidence_tree: TREE,
      passed: v.testcases - failed - v.skipped, failed, skipped: v.skipped, ...override
    };
    fs.mkdirSync(path.join(root, '.prawduct'), { recursive: true });
    fs.writeFileSync(path.join(root, '.prawduct', '.test-evidence.json'), JSON.stringify(record));
    return { status: 0 };
  };
}

let root;
let lines;
let calls;

/**
 * The seams for one run, every one recorded in `calls`.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.xml] - What suite-evidence writes; null writes nothing
 * @param {number} [opts.status] - suite-evidence's exit code
 * @param {object} [opts.env] - The environment
 * @param {function} [opts.prawduct] - The prawduct-hook seam
 * @param {function(number): {head: string, tree: string, status: string}} [opts.checkout] - What git answers on its
 *   Nth reading of the checkout (0 before the run); a clean HEAD/TREE every time by default
 * @returns {object}
 */
function seams({ xml = report(), status = 0, env = {}, prawduct, checkout = () => ({ head: HEAD, tree: TREE, status: '' }) } = {}) {
  let reading = -1;
  return {
    root,
    env,
    stdout: { write: (s) => lines.push(s) },
    now: () => new Date('2026-10-23T18:00:00Z'),
    git: (args) => {
      // readCheckout asks status first, then HEAD, then HEAD^{tree}: status starts a new reading.
      if (args[0] === 'status') reading++;
      const c = checkout(reading);
      calls.git.push(args.join(' '));
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${args[1] === 'HEAD' ? c.head : c.tree}\n` };
      return { status: 0, stdout: c.status };
    },
    runSuiteEvidence: (args, childEnv) => {
      calls.suite.push({ args, env: childEnv });
      if (xml !== null) fs.writeFileSync(args[args.indexOf('--junit') + 1], xml);
      return { status };
    },
    runPrawduct: (args) => {
      calls.prawduct.push(args);
      return (prawduct || fakePrawduct(root))(args);
    }
  };
}

/** @returns {object} The receipt the run wrote */
function receipt() {
  return JSON.parse(fs.readFileSync(path.join(root, '.tangleclaw', 'test-recorder.json'), 'utf8'));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-test-run-'));
  lines = [];
  calls = { suite: [], prawduct: [], git: [] };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('record-test-run: a green run, recorded whole', () => {
  it('hands Prawduct the hoisted report and verifies it recorded every leaf', () => {
    assert.equal(recorder.recordTestRun([], seams()), 0);
    const r = receipt();
    assert.equal(r.verdict, 'recorded');
    assert.equal(r.refusal, null);
    assert.deepEqual({ passed: r.prawduct.passed, failed: r.prawduct.failed, skipped: r.prawduct.skipped }, { passed: 4, failed: 0, skipped: 1 });
    assert.deepEqual(calls.prawduct, [['test-evidence', 'record', '--from-junit', r.hoisted.path]]);
    assert.match(lines.join(''), /it would have read 2 of the raw report/);
  });

  it('keeps both reports, named by the head, with their digests in the receipt', () => {
    recorder.recordTestRun([], seams());
    const r = receipt();
    assert.equal(r.raw.path, path.join(root, '.tangleclaw', 'test-runs', `${HEAD}.raw.junit.xml`));
    assert.equal(r.hoisted.path, path.join(root, '.tangleclaw', 'test-runs', `${HEAD}.prawduct.junit.xml`));
    assert.equal(fs.readFileSync(r.raw.path, 'utf8'), report());
    assert.match(r.raw.sha256, /^[0-9a-f]{64}$/);
    assert.match(r.hoisted.sha256, /^[0-9a-f]{64}$/);
    assert.equal(r.hoisted.added, 2);
    assert.deepEqual([r.head, r.tree, r.dirty, r.mode, r.written_at], [HEAD, TREE, false, 'local', '2026-10-23T18:00:00.000Z']);
    assert.equal(r.prawduct.evidence_tree, TREE);
    assert.equal(r.summary.tests, 5);
    assert.equal(r.tally.testcases, 5);
  });

  it('keeps the reports where --keep says', () => {
    recorder.recordTestRun(['--keep', 'elsewhere'], seams());
    assert.equal(receipt().raw.path, path.join(root, 'elsewhere', `${HEAD}.raw.junit.xml`));
  });

  it('runs suite-evidence.js with the environment and --base passed through, never a suite of its own', () => {
    const env = { TANGLECLAW_SUITE_EVIDENCE: 'ci', PATH: '/x' };
    recorder.recordTestRun(['--base', 'main'], seams({ env }));
    assert.equal(calls.suite.length, 1);
    assert.deepEqual(calls.suite[0].args.slice(2), ['--base', 'main']);
    assert.equal(calls.suite[0].env, env);
    assert.equal(receipt().mode, 'ci');
  });
});

describe('record-test-run: each step refuses, and nothing reaches Prawduct before step 4', () => {
  it('refuses at run when suite-evidence wrote no report (a ci-mode refusal)', () => {
    assert.equal(recorder.recordTestRun([], seams({ xml: null, status: 1 })), 1);
    assert.deepEqual(receipt().refusal, { step: 'run', reason: `suite-evidence.js wrote no report at ${path.join(root, '.tangleclaw', 'test-runs', `${HEAD}.raw.junit.xml`)} (exit 1)` });
    assert.equal(calls.prawduct.length, 0);
    assert.match(lines.join(''), /nothing was recorded/);
  });

  it('never reads a report an earlier attempt left for the same head', () => {
    const keep = path.join(root, '.tangleclaw', 'test-runs');
    fs.mkdirSync(keep, { recursive: true });
    fs.writeFileSync(path.join(keep, `${HEAD}.raw.junit.xml`), report());
    assert.equal(recorder.recordTestRun([], seams({ xml: null })), 1);
    assert.equal(receipt().refusal.step, 'run');
    assert.equal(calls.prawduct.length, 0);
  });

  it('refuses at run on a mode the environment does not name, running nothing', () => {
    assert.equal(recorder.recordTestRun([], seams({ env: { TANGLECLAW_SUITE_EVIDENCE: 'cl' } })), 1);
    assert.equal(receipt().refusal.step, 'run');
    assert.match(receipt().refusal.reason, /selects no mode/);
    assert.equal(calls.suite.length, 0);
  });

  it('refuses at reconcile on a red report, the red #2521 recorded as green', () => {
    assert.equal(recorder.recordTestRun([], seams({ xml: report({ fail: true }), status: 1 })), 1);
    assert.equal(receipt().refusal.step, 'reconcile');
    assert.match(receipt().refusal.reason, /counts 1 failed/);
    assert.equal(calls.prawduct.length, 0);
  });

  it('refuses at run when the suite exited non-zero over a green report', () => {
    assert.equal(recorder.recordTestRun([], seams({ status: 3 })), 1);
    assert.deepEqual(receipt().refusal, { step: 'run', reason: 'suite-evidence.js exited 3 although its report reads green' });
    assert.equal(calls.prawduct.length, 0);
  });

  it('refuses at hoist on a report shape it does not recognise', () => {
    const xml = report().replace('\t<testcase name="stray"/>\n', '\t<properties/>\n\t<testcase name="stray"/>\n');
    assert.equal(recorder.recordTestRun([], seams({ xml })), 1);
    assert.equal(receipt().refusal.step, 'hoist');
    assert.match(receipt().refusal.reason, /unexpected top-level element <properties>/);
    assert.equal(calls.prawduct.length, 0);
  });

  it('refuses at ingest when prawduct-hook does, without claiming a record it may not have made', () => {
    const prawduct = () => ({ status: 2, stderr: 'error: refusing to record' });
    assert.equal(recorder.recordTestRun([], seams({ prawduct })), 1);
    assert.deepEqual(receipt().refusal, { step: 'ingest', reason: 'prawduct-hook test-evidence record exited 2: error: refusing to record' });
    assert.match(lines.join(''), /its record is whatever it was before, not this run's/);
    assert.doesNotMatch(lines.join(''), /marks Prawduct's record wrong/);
  });

  it('writes a refused receipt for an unexpected error, then lets the error through', () => {
    // An earlier run's receipt must not survive beside this head reading "recorded".
    fs.mkdirSync(path.join(root, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tangleclaw', 'test-recorder.json'), JSON.stringify({ verdict: 'recorded' }));
    const io = seams();
    io.runPrawduct = () => { throw new Error('disk on fire'); };
    assert.throws(() => recorder.recordTestRun([], io), /disk on fire/);
    assert.equal(receipt().verdict, 'refused');
    assert.deepEqual(receipt().refusal, { step: 'error', reason: 'disk on fire' });
  });

  it('refuses at ingest when prawduct-hook cannot be started', () => {
    const prawduct = () => ({ status: null, error: new Error('spawn prawduct-hook ENOENT') });
    assert.equal(recorder.recordTestRun([], seams({ prawduct })), 1);
    assert.match(receipt().refusal.reason, /could not be started: spawn prawduct-hook ENOENT/);
  });

  it('refuses at verify when Prawduct recorded fewer leaves than the report holds', () => {
    // What 3.6.1 records for the raw report: 2 leaves beneath top-level suites.
    const prawduct = fakePrawduct(root, { passed: 1, failed: 0, skipped: 1 });
    assert.equal(recorder.recordTestRun([], seams({ prawduct })), 1);
    const r = receipt();
    assert.equal(r.refusal.step, 'verify');
    assert.match(r.refusal.reason, /Prawduct recorded 2 leaves \(passed 1 \+ failed 0 \+ skipped 1\); the report holds 5/);
    assert.match(lines.join(''), /the receipt marks Prawduct's record wrong/);
  });

  it('refuses at verify when the record is not the one this run asked for', () => {
    const prawduct = fakePrawduct(root, { command: '--from-junit /tmp/someone-else.xml' });
    assert.equal(recorder.recordTestRun([], seams({ prawduct })), 1);
    assert.match(receipt().refusal.reason, /is not the record of/);
  });

  it('refuses at verify when the record cannot be read back', () => {
    assert.equal(recorder.recordTestRun([], seams({ prawduct: () => ({ status: 0 }) })), 1);
    assert.match(receipt().refusal.reason, /could not be read back/);
  });
});

describe('record-test-run: the record names the one clean commit that ran', () => {
  it('refuses a dirty checkout before running anything', () => {
    const checkout = () => ({ head: HEAD, tree: TREE, status: ' M lib/x.js\n?? scratch.txt' });
    assert.equal(recorder.recordTestRun([], seams({ checkout })), 1);
    const r = receipt();
    assert.equal(r.refusal.step, 'run');
    assert.match(r.refusal.reason, /not clean before the run: M lib\/x\.js; \?\? scratch\.txt/);
    assert.equal(r.dirty, true);
    assert.equal(calls.suite.length, 0);
    assert.equal(calls.prawduct.length, 0);
  });

  it('refuses when HEAD moved while the suite ran, recording nothing', () => {
    const moved = 'c'.repeat(40);
    const checkout = (n) => (n === 0 ? { head: HEAD, tree: TREE, status: '' } : { head: moved, tree: 'd'.repeat(40), status: '' });
    assert.equal(recorder.recordTestRun([], seams({ checkout })), 1);
    assert.match(receipt().refusal.reason, new RegExp(`HEAD moved after the suite: the run began on ${HEAD}.*now ${moved}`));
    assert.equal(calls.suite.length, 1);
    assert.equal(calls.prawduct.length, 0);
  });

  it('refuses when the checkout went dirty during the suite', () => {
    const checkout = (n) => ({ head: HEAD, tree: TREE, status: n === 0 ? '' : ' M scripts/record-test-run.js' });
    assert.equal(recorder.recordTestRun([], seams({ checkout })), 1);
    assert.match(receipt().refusal.reason, /not clean after the suite: M scripts\/record-test-run\.js/);
    assert.equal(calls.prawduct.length, 0);
  });

  it('checks the checkout again just before the ingest', () => {
    // Readings: 0 at start, 1 after the suite, 2 before the ingest.
    const checkout = (n) => ({ head: HEAD, tree: TREE, status: n === 2 ? '?? late.txt' : '' });
    assert.equal(recorder.recordTestRun([], seams({ checkout })), 1);
    assert.match(receipt().refusal.reason, /not clean before the ingest: \?\? late\.txt/);
    assert.equal(calls.prawduct.length, 0);
  });

  it('refuses at verify when Prawduct captured a different tree than the one that ran', () => {
    const prawduct = fakePrawduct(root, { evidence_tree: 'e'.repeat(40) });
    assert.equal(recorder.recordTestRun([], seams({ prawduct })), 1);
    const r = receipt();
    assert.equal(r.refusal.step, 'verify');
    assert.equal(r.refusal.reason, `Prawduct captured tree ${'e'.repeat(40)} at ingest; the run was of ${HEAD}'s tree ${TREE}`);
  });

  it('refuses at verify when Prawduct\'s record carries no evidence_tree', () => {
    const prawduct = fakePrawduct(root, { evidence_tree: undefined });
    assert.equal(recorder.recordTestRun([], seams({ prawduct })), 1);
    assert.match(receipt().refusal.reason, /carries no evidence_tree/);
  });
});

describe('record-test-run: arguments and the comparison', () => {
  it('refuses an unknown argument and a flag with no value, and still writes the receipt', () => {
    assert.equal(recorder.recordTestRun(['--junit', 'x'], seams()), 1);
    assert.match(receipt().refusal.reason, /unknown argument "--junit"/);
    assert.throws(() => recorder.parseArgs(['--keep']), /--keep needs a value/);
    assert.deepEqual(recorder.parseArgs(['--keep', 'k', '--base', 'b']), { keep: 'k', base: 'b' });
  });

  it('names every disagreement between a record and the report', () => {
    const tally = { testcases: 5, testsuites: 1, failures: 0, skipped: 1, todo: 1 };
    assert.deepEqual(recorder.disagreements({ passed: 3, failed: 0, skipped: 2 }, tally), []);
    assert.deepEqual(recorder.disagreements({ passed: 1, failed: 1, skipped: 1 }, tally), [
      'Prawduct recorded 3 leaves (passed 1 + failed 1 + skipped 1); the report holds 5',
      'Prawduct recorded failed 1 on a report this command read as green',
      'Prawduct recorded skipped 1; the report holds 2 skipped elements'
    ]);
    assert.match(recorder.disagreements({ passed: '3', failed: 0, skipped: 2 }, tally)[0], /not integers/);
  });

  it('runs the suite through suite-evidence.js, the script beside it', () => {
    assert.equal(recorder.SUITE_EVIDENCE, path.join(__dirname, '..', 'scripts', 'suite-evidence.js'));
    assert.ok(fs.existsSync(recorder.SUITE_EVIDENCE));
  });
});
