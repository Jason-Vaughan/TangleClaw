'use strict';

/**
 * `scripts/test-stage.js`: the stage runner (#2498 W4-02).
 *
 * Pinned here: `all` hands node the declared `test_command`, argument for
 * argument; stages 3, 4 and 5 together are exactly `test/*.test.js`; a
 * guarded tier carries its guard and the measured timeout; Stage 2 runs the
 * selection each tier under its guard, and on escalation runs Stage 3 whole
 * and says so; Stage 1 runs its seven steps on this repository; and a real
 * run on a fixture repository ends in the reconciliation, which turns a
 * describe body that threw (node exits 0) into a red stage.
 *
 * Also covers `scripts/pre-push-gate.js` (#2595, standalone half — A473-A1
 * serializes wiring it into `lib/control-hooks.js` to W2-B): it chains
 * Stage 1 then Stage 2 through this file's own `main`, blocking on either.
 */

const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const stage = require('../scripts/test-stage');
const tiers = require('../scripts/test-tiers');
const graphLib = require('../scripts/_require-graph');
const results = require('../lib/test-results');
const prePushGate = require('../scripts/pre-push-gate');

const REPO = path.join(__dirname, '..');

/** A stdout sink that keeps what was written. */
function sink() {
  let text = '';
  return { write: (s) => { text += s; return true; }, text: () => text };
}

/**
 * The suite command `all` runs, argument for argument. Pinned here as text
 * so a change to it is a visible diff, not a silent drift. This is the RAW
 * command: whether `.prawduct/project-state.yaml` declares it directly or
 * through the `scripts/suite-evidence.js` wrapper (#2371 Step 3) is
 * `test/record-test-run.test.js`'s contract, not this file's — that file
 * pins what a governed checkout's `test_command` must read, which moved
 * there once it stopped being this same string.
 */
const DECLARED_TEST_COMMAND = 'node --test --test-reporter=junit --test-reporter-destination={junit_xml} test/*.test.js'.split(' ');

describe('parseArgs', () => {
  it('accepts each stage and the three options, --base for stage 2 only', () => {
    assert.deepEqual(stage.parseArgs(['1']), { stage: '1', junitPath: null, specPath: null, base: null });
    assert.deepEqual(stage.parseArgs(['all', '--junit', 'out/j.xml', '--spec', 'stdout']), { stage: 'all', junitPath: path.resolve('out/j.xml'), specPath: 'stdout', base: null });
    assert.equal(stage.parseArgs(['3', '--spec', 'out/s.log']).specPath, path.resolve('out/s.log'));
    assert.equal(stage.parseArgs(['2', '--base', 'main']).base, 'main');
    assert.throws(() => stage.parseArgs(['3', '--base', 'main']), /unknown or incomplete argument: --base/);
  });

  it('refuses an unknown stage, an unknown flag and a flag without a value', () => {
    assert.throws(() => stage.parseArgs(['6']), /usage: test-stage\.js <1\|2\|3\|4\|5\|all>/);
    assert.throws(() => stage.parseArgs([]), /usage/);
    assert.throws(() => stage.parseArgs(['1', '--fast']), /unknown or incomplete argument: --fast/);
    assert.throws(() => stage.parseArgs(['1', '--junit']), /unknown or incomplete argument: --junit/);
  });

  it('exits 2 from main on a usage error', () => {
    const out = sink();
    assert.equal(stage.main(['nope'], { stdout: out }), 2);
    assert.match(out.text(), /^usage/);
  });
});

describe('all: the declared test_command, argument for argument', () => {
  it('is byte-identical to test_command with {junit_xml} filled in', () => {
    assert.deepEqual(['node', ...stage.allArgv('{junit_xml}')], DECLARED_TEST_COMMAND);
    assert.deepEqual(stage.allArgv('/tmp/j.xml'), ['--test', '--test-reporter=junit', '--test-reporter-destination=/tmp/j.xml', 'test/*.test.js']);
  });

  it('appends the spec reporter before the glob only when asked', () => {
    assert.deepEqual(stage.allArgv('/tmp/j.xml', 'stdout'), [
      '--test', '--test-reporter=junit', '--test-reporter-destination=/tmp/j.xml', '--test-reporter=spec', '--test-reporter-destination=stdout', 'test/*.test.js'
    ]);
  });
});

describe('stages 3, 4 and 5: the ledger\'s tiers, guarded where the tier promises something', () => {
  it('together are exactly test/*.test.js', () => {
    const ledger = tiers.loadLedger(path.join(REPO, 'test', 'tiers.json'));
    const union = [...ledger.small, ...ledger.medium, ...ledger.large].sort();
    const glob = fs.readdirSync(path.join(REPO, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => `test/${f}`).sort();
    assert.deepEqual(union, glob);
    assert.deepEqual(stage.TIER_OF_STAGE, { 3: 'small', 4: 'medium', 5: 'large' });
  });

  it('runs a guarded tier with its spawn/exec guard, and every tier (including Large, bare) with the measured timeout (#2691)', () => {
    assert.deepEqual(stage.tierArgv('small', ['test/a.test.js'], '/tmp/j.xml', 'stdout'), [
      '--test', '--require', './test/helpers/preload-small.js', `--test-timeout=${stage.GUARDED_TIMEOUT_MS}`,
      '--test-reporter=junit', '--test-reporter-destination=/tmp/j.xml', '--test-reporter=spec', '--test-reporter-destination=stdout', 'test/a.test.js'
    ]);
    assert.deepEqual(stage.tierArgv('medium', ['test/a.test.js'], '/tmp/j.xml'), [
      '--test', '--require', './test/helpers/preload-medium.js', `--test-timeout=${stage.GUARDED_TIMEOUT_MS}`,
      '--test-reporter=junit', '--test-reporter-destination=/tmp/j.xml', 'test/a.test.js'
    ]);
    assert.deepEqual(stage.tierArgv('large', ['test/a.test.js', 'test/b.test.js'], '/tmp/j.xml'), [
      '--test', `--test-timeout=${stage.LARGE_TIMEOUT_MS}`,
      '--test-reporter=junit', '--test-reporter-destination=/tmp/j.xml', 'test/a.test.js', 'test/b.test.js'
    ]);
    assert.equal(stage.GUARDED_TIMEOUT_MS, 300000, 'the value measured when the ledger was written; re-measure before lowering');
    // test/soak-guest.test.js measured ~804s alone before a fix to two real
    // slowness causes, ~270s alone after — all 208 tests green both times.
    // LARGE_TIMEOUT_MS must clear even the pre-fix figure with real margin,
    // not just match GUARDED_TIMEOUT_MS (which would cancel it as a false
    // failure), since the margin is a placeholder against unmeasured
    // shared-host slowdown, not a tight fit to the current fixed timing.
    assert.ok(stage.LARGE_TIMEOUT_MS > stage.GUARDED_TIMEOUT_MS, 'the Large tier needs a more generous budget than Medium');
    assert.ok(stage.LARGE_TIMEOUT_MS > 804000, 'must clear the slowest known Large file pre-fix (test/soak-guest.test.js, ~804s alone) with margin');
    for (const guard of Object.values(stage.GUARD_OF_TIER)) assert.ok(fs.existsSync(path.join(REPO, guard)), guard);
  });
});

describe('stage 2: the selection, each tier under its guard, through the seam', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-test-stage-2-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'test', 'helpers'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  for (const tier of ['small', 'medium']) {
    fs.writeFileSync(path.join(root, 'test', 'helpers', `preload-${tier}.js`), `require(${JSON.stringify(path.join(REPO, 'test', 'helpers', `preload-${tier}.js`))});\n`);
  }
  fs.writeFileSync(path.join(root, 'lib', 'x.js'), 'module.exports = { x: 1 };\n');
  fs.writeFileSync(path.join(root, 'lib', 'y.js'), 'module.exports = { y: 2 };\n');
  fs.writeFileSync(path.join(root, 'test', 'x.test.js'), `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { x } = require('../lib/x');
test('x', () => assert.equal(x, 1));
`);
  fs.writeFileSync(path.join(root, 'test', 'y.test.js'), `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { y } = require('../lib/y');
test('y', () => assert.equal(y, 2));
`);
  fs.writeFileSync(path.join(root, 'test', 'tiers.json'), `${JSON.stringify({ small: ['test/x.test.js'], medium: ['test/y.test.js'], large: [] }, null, 2)}\n`);
  const tests = ['test/x.test.js', 'test/y.test.js'].map((t) => path.join(root, t));
  const touchedIo = (files) => ({ changed: () => ({ mergeBase: 'fixture0', files }), tests: () => tests, graphIo: { ...graphLib.FS_IO, root }, ring: [] });

  it('runs only the tier the selection needs, under its guard, and reconciles it', () => {
    const out = sink();
    const junitPath = path.join(root, 'stage2');
    const code = stage.main(['2', '--junit', junitPath], { stdout: out, root, touchedIo: touchedIo(['lib/y.js']) });
    assert.equal(code, 0, out.text());
    assert.match(out.text(), /^ {2}lib\/y\.js -> 1 test file\(s\)$/m);
    assert.match(out.text(), /^selected: 1 test file\(s\) \+ 0 static ring = 1 \(small 0, medium 1, large 0\)$/m);
    assert.match(out.text(), /^stage 2 \(touched\): selection \d+ ms, trusted$/m);
    assert.match(out.text(), /^stage 2 \(medium, 1 files\): node --test --require \.\/test\/helpers\/preload-medium\.js --test-timeout=300000 --test-reporter=junit --test-reporter-destination=\S+\.medium\.xml --test-reporter=spec --test-reporter-destination=stdout test\/y\.test\.js$/m);
    assert.match(out.text(), /^canonical count 1 \(the runner's tests\); 1 testcase leaves in the report; green$/m);
    assert.equal(fs.existsSync(`${junitPath}.medium.xml`), true);
    assert.equal(fs.existsSync(`${junitPath}.small.xml`), false, 'the small tier was not selected, so it did not run');
  });

  it('on escalation runs stage 3 whole instead, says so, and exits with that run', () => {
    const out = sink();
    const junitPath = path.join(root, 'stage2-esc');
    const code = stage.main(['2', '--junit', junitPath], { stdout: out, root, touchedIo: touchedIo(['test/tiers.json']) });
    assert.equal(code, 0, out.text());
    assert.match(out.text(), /^ {2}test\/tiers\.json -> not-javascript: /m);
    assert.match(out.text(), /^ESCALATE: run stage 3$/m);
    assert.match(out.text(), /^stage 2 \(touched\): running stage 3 whole instead$/m);
    assert.match(out.text(), /^stage 3 \(small, 1 files, guard \.\/test\/helpers\/preload-small\.js, --test-timeout=300000\): /m);
    assert.equal(fs.existsSync(`${junitPath}.small.xml`), true);
  });

  it('a red selected test is a red stage', () => {
    fs.writeFileSync(path.join(root, 'test', 'x.test.js'), `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { x } = require('../lib/x');
test('x', () => assert.equal(x, 2));
`);
    const out = sink();
    const code = stage.main(['2', '--junit', path.join(root, 'stage2-red')], { stdout: out, root, touchedIo: touchedIo(['lib/x.js']) });
    assert.equal(code, 1);
    assert.match(out.text(), /^stage 2 \(small, 1 files\): \d+ ms, node exit 1$/m);
  });
});

describe('stage 1: the static ring, in-process where it can be', () => {
  it('syntaxCheck parses classic scripts and names the file that does not', () => {
    const files = { 'a.js': 'const x = 1;\n', 'b.js': 'const = ;\n', 'c.js': 'function f() { return 1 }\n' };
    const io = { readFile: (f) => files[f] };
    assert.deepEqual(stage.syntaxCheck(['a.js', 'c.js'], io), { ok: true, output: '2 tracked .js files parse' });
    const bad = stage.syntaxCheck(['a.js', 'b.js'], io);
    assert.equal(bad.ok, false);
    assert.match(bad.output, /^b\.js: Unexpected token/);
  });

  it('refuses a root other than this repository rather than silently checking this one', () => {
    const out = sink();
    assert.equal(stage.main(['1'], { stdout: out, root: path.join(os.tmpdir(), 'elsewhere') }), 2);
    assert.equal(out.text(), 'stage 1 runs only against this repository and cannot be pointed at another checkout\n');
  });

  it('names the three static-ring tests the lane rules name', () => {
    assert.deepEqual(stage.STATIC_RING, ['test/auto-merge-callers.test.js', 'test/tmux-session-names.test.js', 'test/wrap-indicator-card.test.js']);
    assert.deepEqual(stage.staticSteps().map((s) => s.name), ['syntax', 'conflict markers', 'strict assertions', 'CLAUDE.md block', 'tiers ledger', 'dead exports', 'static ring']);
  });

  // Its wall time is a measurement for the pull request, not a contract this
  // file pins: under `all` this Large file shares the host with the whole suite.
  it('is green on this repository, every step named', () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'test-stage.js'), '1'], { cwd: REPO, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    for (const name of ['syntax', 'conflict markers', 'strict assertions', 'CLAUDE.md block', 'tiers ledger', 'dead exports', 'static ring']) {
      assert.match(r.stdout, new RegExp(`^  ok   ${name} \\(\\d+ ms\\)$`, 'm'));
    }
    assert.match(r.stdout, /^stage 1 \(static\): \d+ ms, green$/m);
  });
});

describe('a real run on a fixture repository ends in the reconciliation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-test-stage-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'test', 'helpers'), { recursive: true });
  // The guard shims load the repository's real guards, so the fixture's
  // `--require ./test/helpers/preload-<tier>.js` resolves from its own root.
  for (const tier of ['small', 'medium']) {
    fs.writeFileSync(path.join(root, 'test', 'helpers', `preload-${tier}.js`), `require(${JSON.stringify(path.join(REPO, 'test', 'helpers', `preload-${tier}.js`))});\n`);
  }
  // Small: a test with subtests (a test to the runner, a suite to the report)
  // and a describe skipped by option (a suite to the runner, a skipped
  // testcase to the report), both from the real reporter.
  fs.writeFileSync(path.join(root, 'test', 'a.test.js'), `'use strict';
const { test, describe, it } = require('node:test');
const assert = require('node:assert/strict');
test('parent', async (t) => { await t.test('one', () => assert.equal(1, 1)); await t.test('two', () => {}); });
test('plain', () => {});
describe('skipped describe', { skip: 'not on this host' }, () => { it('never', () => {}); });
`);
  // Large: a describe whose body throws, which node reports with fail 0 and exit 0.
  fs.writeFileSync(path.join(root, 'test', 'b.test.js'), `'use strict';
const { describe, it } = require('node:test');
describe('throws at describe time', () => { throw new Error('boom'); });
describe('fine', () => { it('passes', () => {}); });
`);
  fs.writeFileSync(path.join(root, 'test', 'tiers.json'), `${JSON.stringify({ small: ['test/a.test.js'], medium: [], large: ['test/b.test.js'] }, null, 2)}\n`);

  it('stage 3 is green, prints the canonical count beside the leaf count, and names the junit', () => {
    const out = sink();
    const junitPath = path.join(root, 'stage3.xml');
    const specPath = path.join(root, 'stage3.spec');
    const code = stage.main(['3', '--junit', junitPath, '--spec', specPath], { stdout: out, root });
    assert.equal(code, 0, out.text());
    assert.match(out.text(), /^stage 3 \(small, 1 files, guard \.\/test\/helpers\/preload-small\.js, --test-timeout=300000\): node --test --require \.\/test\/helpers\/preload-small\.js --test-timeout=300000 --test-reporter=junit --test-reporter-destination=\S+ --test-reporter=spec --test-reporter-destination=\S+ <1 files: test\/tiers\.json small>$/m);
    assert.match(out.text(), /^stage 3 \(small, 1 files, .*\): \d+ ms, node exit 0$/m);
    // The parent test is a test to the runner (4 with its two subtests and the
    // plain one) and a testsuite to the report; the skipped describe is a
    // suite to the runner, not in its `skipped`, and a skipped testcase to the
    // report. Report: 4 leaves + 1 suite; runner: 4 tests + 1 suite.
    assert.match(out.text(), /^runner summary: tests 4, pass 4, fail 0, cancelled 0, skipped 0, todo 0, suites 1$/m);
    assert.match(out.text(), /^junit report: {3}testcases 4, testsuites 1, failure elements 0, skipped elements 1$/m);
    assert.match(out.text(), /^nodes: 4 \+ 1 = 5 in the report, 4 \+ 1 = 5 in the summary \(the same run\)$/m);
    assert.match(out.text(), /^canonical count 4 \(the runner's tests\); 4 testcase leaves in the report; green$/m);
    assert.match(out.text(), new RegExp(`^junit: ${junitPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    // The spec log and the report's trailer are the same summary.
    assert.deepEqual(results.summaryOf(fs.readFileSync(specPath, 'utf8')), results.summaryOf(fs.readFileSync(junitPath, 'utf8')));
  });

  it('stage 5 is red on a describe body that threw, although node exited 0', () => {
    const out = sink();
    const junitPath = path.join(root, 'stage5.xml');
    const code = stage.main(['5', '--junit', junitPath, '--spec', path.join(root, 'stage5.spec')], { stdout: out, root });
    assert.equal(code, 1);
    assert.match(out.text(), new RegExp(`^stage 5 \\(large, 1 files, no spawn/exec guard, --test-timeout=${stage.LARGE_TIMEOUT_MS}\\): \\d+ ms, node exit 0$`, 'm'));
    assert.match(out.text(), /^RED: the report carries 1 failure element\(s\) the summary does not count/m);
  });

  it('all runs the glob as the declared command and reconciles the whole run', () => {
    const out = sink();
    const junitPath = path.join(root, 'all.xml');
    const code = stage.main(['all', '--junit', junitPath], { stdout: out, root });
    assert.equal(code, 1, 'b.test.js makes the fixture suite red');
    assert.match(out.text(), new RegExp(`^all \\(the declared suite\\): node --test --test-reporter=junit --test-reporter-destination=${junitPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} test/\\*\\.test\\.js$`, 'm'));
    // a.test.js: 4 tests, 1 suite (4 leaves + 1 suite); b.test.js: 1 test,
    // 2 suites (2 leaves, one of them the describe that threw, + 1 suite).
    assert.match(out.text(), /^runner summary: tests 5, pass 5, fail 0, cancelled 0, skipped 0, todo 0, suites 3$/m);
    assert.match(out.text(), /^junit report: {3}testcases 6, testsuites 2, failure elements 1, skipped elements 1$/m);
    assert.match(out.text(), /^nodes: 6 \+ 2 = 8 in the report, 5 \+ 3 = 8 in the summary \(the same run\)$/m);
    assert.match(out.text(), /^RED: the report carries 1 failure element/m);
  });

  it('runs nothing for an empty tier rather than letting node discover its own files', () => {
    const out = sink();
    const code = stage.main(['4', '--junit', path.join(root, 'stage4.xml')], { stdout: out, root });
    assert.equal(code, 0);
    assert.equal(out.text(), 'stage 4 (medium): the ledger lists no files; nothing to run\n');
    assert.equal(fs.existsSync(path.join(root, 'stage4.xml')), false);
  });

  it('refuses when the run left no report, whatever node\'s exit code was', () => {
    const out = sink();
    const junitPath = path.join(root, 'never.xml');
    const code = stage.runSuite('a run that writes nothing', ['-e', '0'], { root, junitPath, specPath: null, out });
    assert.equal(code, 1);
    assert.match(out.text(), /^a run that writes nothing: \d+ ms, node exit 0$/m);
    assert.match(out.text(), /^REFUSED: no junit report at .*never\.xml: the run certified nothing$/m);
  });
});

describe('pre-push-gate: chaining stage 1 then stage 2', () => {
  const originalMain = stage.main;
  afterEach(() => { stage.main = originalMain; });

  it('runs stage 2 only when stage 1 is green, and reports green overall', () => {
    const calls = [];
    stage.main = (argv) => { calls.push(argv); return 0; };
    const out = sink();
    const code = prePushGate.runGate('origin/main', { stdout: out });
    assert.equal(code, 0);
    assert.deepEqual(calls, [['1'], ['2', '--base', 'origin/main']]);
    assert.match(out.text(), /stage 1 and stage 2 are green; push allowed/);
  });

  it('blocks on stage 1 red without ever calling stage 2', () => {
    const calls = [];
    stage.main = (argv) => { calls.push(argv); return 1; };
    const out = sink();
    const code = prePushGate.runGate('origin/main', { stdout: out });
    assert.equal(code, 1);
    assert.deepEqual(calls, [['1']], 'stage 2 must not run after a red stage 1');
    assert.match(out.text(), /stage 1 failed; push blocked/);
  });

  it('blocks on stage 2 red after a green stage 1', () => {
    stage.main = (argv) => (argv[0] === '1' ? 0 : 1);
    const out = sink();
    const code = prePushGate.runGate('origin/main', { stdout: out });
    assert.equal(code, 1);
    assert.match(out.text(), /stage 2 failed; push blocked/);
  });

  it('passes --base through to stage 2', () => {
    const calls = [];
    stage.main = (argv) => { calls.push(argv); return 0; };
    prePushGate.runGate('some-other-branch', { stdout: sink() });
    assert.deepEqual(calls[1], ['2', '--base', 'some-other-branch']);
  });
});

describe('pre-push-gate: parseArgs', () => {
  it('defaults base to origin/main', () => {
    assert.deepEqual(prePushGate.parseArgs([]), { base: 'origin/main' });
  });

  it('accepts --base', () => {
    assert.deepEqual(prePushGate.parseArgs(['--base', 'main']), { base: 'main' });
  });

  it('refuses an unknown or incomplete argument', () => {
    assert.throws(() => prePushGate.parseArgs(['--nope']), /unknown or incomplete argument: --nope/);
    assert.throws(() => prePushGate.parseArgs(['--base']), /unknown or incomplete argument: --base/);
  });
});

describe('pre-push-gate: main', () => {
  it('runs the gate', () => {
    const originalMain = stage.main;
    try {
      stage.main = () => 0;
      const out = sink();
      assert.equal(prePushGate.main([], { stdout: out }), 0);
      assert.match(out.text(), /stage 1 and stage 2 are green/);
    } finally {
      stage.main = originalMain;
    }
  });

  it('a parse error returns 1 and prints the usage', () => {
    const out = sink();
    assert.equal(prePushGate.main(['--nope'], { stdout: out }), 1);
    assert.match(out.text(), /unknown or incomplete argument: --nope/);
  });
});
