#!/usr/bin/env node
'use strict';

/**
 * One entry point for the five stages of the test pyramid, and for the whole
 * suite (#2498).
 *
 *   1    static: every tracked `.js` parses, no conflict markers, no bare
 *        `node:assert`, the CLAUDE.md block is in sync, the tier ledger is
 *        total, and the three static-ring tests pass. In-process where the
 *        check is a function; under ten seconds.
 *   2    touched: the tests a diff reaches. Not built yet (W4-04); says so and
 *        exits non-zero, because "ran nothing" must never read as green.
 *   3    small: the Small tier under its guard
 *   4    medium: the Medium tier under its guard
 *   5    large: the Large tier, no guard
 *   all  the suite as the declared `test_command` runs it: one `node --test`
 *        over `test/*.test.js`, the same arguments in the same order, so what
 *        this runs and what the gate records are one command.
 *
 * A guarded tier runs with `--test-timeout`: a refused spawn is a throw, and
 * product code waiting for the process it never got can wait forever; the
 * timeout turns that into a cancelled test that names the file. The value is
 * the one measured when the ledger was first written (the slowest honest
 * Medium file is past 120 s with its tier sharing the host); re-measure before
 * lowering it.
 *
 * Every run that executes tests writes a junit report and ends by reconciling
 * it with the runner's own summary (`lib/test-results.js`): the canonical count
 * is the runner's `tests`, the report's leaf count is printed beside it, and a
 * report that is not the run the summary describes, or that carries a failure
 * the summary does not count, exits 1 whatever node's exit code was.
 *
 * Usage: node scripts/test-stage.js <1|2|3|4|5|all> [--junit <path>] [--spec <path|stdout>]
 *   --junit  where the junit report goes (default: a file under the OS temp dir, printed)
 *   --spec   also write the spec reporter there; `stdout` streams it. Stages 3-5
 *            default to `stdout` so a person sees the failing test; `all`
 *            defaults to none, which keeps its arguments identical to `test_command`.
 * Exit 0 when the stage is green, 1 on any red, 2 on a usage error.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');

const tiers = require('./test-tiers');
const conflictMarkers = require('./conflict-marker-scan');
const assertStrict = require('./assert-strict-guard');
const results = require('../lib/test-results');

const ROOT = path.join(__dirname, '..');

/** The three static-ring tests, as the lane rules name them. */
const STATIC_RING = Object.freeze([
  'test/auto-merge-callers.test.js',
  'test/tmux-session-names.test.js',
  'test/wrap-indicator-card.test.js'
]);

/**
 * `--test-timeout` for a guarded tier, in milliseconds. Measured when the
 * ledger was first written: `test/check-watch-monitor.test.js` is 10 s alone
 * and past 120 s with the Medium tier sharing the host.
 */
const GUARDED_TIMEOUT_MS = 300000;

/** The tier each tier stage runs, and the guard each tier runs under. */
const TIER_OF_STAGE = Object.freeze({ 3: 'small', 4: 'medium', 5: 'large' });
const GUARD_OF_TIER = Object.freeze({
  small: './test/helpers/preload-small.js',
  medium: './test/helpers/preload-medium.js'
});

/** What `test_command` declares, split the way the recorder splits it. */
const DECLARED_SUITE = Object.freeze(['--test', '--test-reporter=junit', '--test-reporter-destination={junit_xml}', 'test/*.test.js']);

/** The stages `main` accepts, in the order the pyramid lists them. */
const STAGES = Object.freeze(['1', '2', '3', '4', '5', 'all']);

/**
 * The arguments `all` hands node: the declared `test_command` with
 * `{junit_xml}` filled in and, only when asked, the spec reporter appended
 * before the glob.
 *
 * @param {string} junitPath - Where the junit report goes
 * @param {string|null} [specPath] - Where the spec reporter goes, or null for none
 * @returns {string[]} Arguments after `node`
 */
function allArgv(junitPath, specPath = null) {
  const argv = DECLARED_SUITE.map((a) => a.replace('{junit_xml}', junitPath));
  if (specPath) argv.splice(argv.length - 1, 0, '--test-reporter=spec', `--test-reporter-destination=${specPath}`);
  return argv;
}

/**
 * The arguments a tier stage hands node: the guard and the timeout for a
 * guarded tier, the reporters, then the tier's files from the ledger.
 *
 * @param {string} tier - `small` | `medium` | `large`
 * @param {string[]} files - The tier's files, repo-relative
 * @param {string} junitPath - Where the junit report goes
 * @param {string|null} [specPath] - Where the spec reporter goes, or null for none
 * @returns {string[]} Arguments after `node`
 */
function tierArgv(tier, files, junitPath, specPath = null) {
  const argv = ['--test'];
  if (GUARD_OF_TIER[tier]) argv.push('--require', GUARD_OF_TIER[tier], `--test-timeout=${GUARDED_TIMEOUT_MS}`);
  argv.push('--test-reporter=junit', `--test-reporter-destination=${junitPath}`);
  if (specPath) argv.push('--test-reporter=spec', `--test-reporter-destination=${specPath}`);
  argv.push(...files);
  return argv;
}

/**
 * Parse every tracked `.js` file in-process, without running any of it.
 *
 * `vm.Script` compiles the text as a classic script, which is what every
 * tracked file here is (CommonJS modules and browser scripts); a syntax error
 * is thrown with the file name. One process for the whole tree: a `node
 * --check` per file would be a thousand spawns.
 *
 * @param {string[]} files - Repo-relative paths
 * @param {{readFile?: function(string): string}} [io] - Injection seam
 * @returns {{ok: boolean, output: string}}
 */
function syntaxCheck(files, io = {}) {
  const readFile = io.readFile || ((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const bad = [];
  for (const f of files) {
    try {
      new vm.Script(readFile(f), { filename: f });
    } catch (err) {
      bad.push(`${f}: ${err.message}`);
    }
  }
  return {
    ok: bad.length === 0,
    output: bad.length === 0 ? `${files.length} tracked .js files parse` : bad.join('\n')
  };
}

/**
 * Every tracked `.js` file, as git lists it.
 *
 * @param {string} root - The repository
 * @returns {string[]} Repo-relative paths
 */
function trackedJs(root) {
  return execFileSync('git', ['ls-files', '-z', '--', '*.js'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

/**
 * A console-shaped sink that keeps what a step writes, so the stage prints it
 * only when the step failed.
 *
 * @returns {{log: function(string): void, error: function(string): void, write: function(string): any, text: function(): string}}
 */
function sink() {
  const lines = [];
  return {
    log: (s) => lines.push(String(s)),
    error: (s) => lines.push(String(s)),
    write: (s) => { lines.push(String(s).replace(/\n$/, '')); return true; },
    text: () => lines.join('\n')
  };
}

/**
 * The steps of Stage 1. Bound to this repository, not to a `root` a caller
 * passes: the syntax step reads the files git tracks here, and the ledger
 * step is `test-tiers --check`, which measures the suite under this
 * repository's `test/` whatever ledger path it is handed. A stage that could
 * be pointed at another checkout and silently check this one instead would
 * be worse than one that cannot be pointed at all.
 *
 * @returns {Array<{name: string, run: function(): {ok: boolean, output: string}}>}
 */
function staticSteps() {
  const root = ROOT;
  return [
    { name: 'syntax', run: () => syntaxCheck(trackedJs(root)) },
    {
      name: 'conflict markers',
      run: () => { const out = sink(); const code = conflictMarkers.main([root], out); return { ok: code === 0, output: out.text() }; }
    },
    {
      name: 'strict assertions',
      run: () => { const r = assertStrict.scan(path.join(root, 'test'), root); return { ok: r.offenders.length === 0, output: assertStrict.report(r) }; }
    },
    {
      name: 'CLAUDE.md block',
      run: () => {
        // Required here, not at the top: it loads the store, which Stage 2
        // onward never needs.
        const sync = require('./sync-claude-md-block');
        const out = sink();
        const code = sync.main(['--file', path.join(root, 'CLAUDE.md')], out);
        return { ok: code === 0, output: out.text() };
      }
    },
    {
      name: 'tiers ledger',
      run: () => { const out = sink(); const code = tiers.main(['--check'], { stdout: out, ledgerPath: path.join(root, 'test', 'tiers.json') }); return { ok: code === 0, output: out.text() }; }
    },
    {
      name: 'static ring',
      run: () => {
        const r = runNode(['--test', ...STATIC_RING], root, 'pipe');
        return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
      }
    }
  ];
}

/**
 * Run node with the given arguments in the repository, as a top-level runner
 * rather than a subtest of whatever test is running this script.
 *
 * @param {string[]} argv - Arguments after `node`
 * @param {string} root - Working directory
 * @param {'inherit'|'pipe'} stdio - Whether the child's output streams through or is captured
 * @returns {{status: number|null, stdout?: string, stderr?: string}}
 */
function runNode(argv, root, stdio) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, argv, { cwd: root, env, stdio: ['ignore', stdio, stdio], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Run Stage 1 against this repository and print one line per step.
 *
 * @param {{write: function(string): any}} out - Where the lines go
 * @returns {number} 0 when every step passed, 1 otherwise
 */
function runStatic(out) {
  const t0 = Date.now();
  let failed = 0;
  for (const step of staticSteps()) {
    const s0 = Date.now();
    let r;
    try {
      r = step.run();
    } catch (err) {
      r = { ok: false, output: err.stack || String(err) };
    }
    out.write(`  ${r.ok ? 'ok  ' : 'FAIL'} ${step.name} (${Date.now() - s0} ms)\n`);
    if (!r.ok) {
      failed++;
      out.write(`${r.output.replace(/^/gm, '       ')}\n`);
    }
  }
  out.write(`stage 1 (static): ${Date.now() - t0} ms, ${failed === 0 ? 'green' : `${failed} step(s) red`}\n`);
  return failed === 0 ? 0 : 1;
}

/**
 * Run a `node --test` stage, then reconcile its report with the runner's
 * summary and print both.
 *
 * @param {string} label - What the stage is, for the lines it prints
 * @param {string[]} argv - Arguments after `node`
 * @param {{root: string, junitPath: string, specPath: string|null, out: {write: function(string): any}, shown?: string}} io
 *   `shown` is the command line to print in place of the full argv, for a
 *   tier whose hundreds of file names are already the ledger's
 * @returns {number} 0 when node exited 0 and the reconciliation is green, 1 otherwise
 */
function runSuite(label, argv, io) {
  io.out.write(`${label}: node ${io.shown || argv.join(' ')}\n`);
  const t0 = Date.now();
  const r = runNode(argv, io.root, 'inherit');
  const ms = Date.now() - t0;
  io.out.write(`${label}: ${ms} ms, node exit ${r.status}\n`);
  if (!fs.existsSync(io.junitPath)) {
    io.out.write(`REFUSED: no junit report at ${io.junitPath}: the run certified nothing\n`);
    return 1;
  }
  const junitXml = fs.readFileSync(io.junitPath, 'utf8');
  const summaryText = io.specPath && io.specPath !== 'stdout' ? fs.readFileSync(io.specPath, 'utf8') : junitXml;
  const verdict = results.reconcileText(junitXml, summaryText);
  io.out.write(`${results.formatReconciliation(verdict)}\n`);
  io.out.write(`junit: ${io.junitPath}\n`);
  return r.status === 0 && verdict.ok ? 0 : 1;
}

/**
 * Parse argv into the stage and its options.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{stage: string, junitPath: string|null, specPath: string|null}}
 */
function parseArgs(argv) {
  const [stage, ...rest] = argv;
  if (!STAGES.includes(stage)) throw new Error('usage: test-stage.js <1|2|3|4|5|all> [--junit <path>] [--spec <path|stdout>]');
  const parsed = { stage, junitPath: null, specPath: null };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (flag === '--junit' && value) parsed.junitPath = path.resolve(value);
    else if (flag === '--spec' && value) parsed.specPath = value === 'stdout' ? 'stdout' : path.resolve(value);
    else throw new Error(`unknown or incomplete argument: ${flag}`);
  }
  return parsed;
}

/**
 * Run one stage and return the process exit code.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {{stdout?: {write: function(string): any}, root?: string}} [io] - Injection seam: `root` runs
 *   the test-running stages (3, 4, 5, `all`) against another checkout, which is how the runner is
 *   proved on a fixture repository; Stage 1 is bound to this repository (see `staticSteps`)
 * @returns {number} 0 green, 1 red, 2 usage
 */
function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const root = io.root || ROOT;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    out.write(`${err.message}\n`);
    return 2;
  }
  if (parsed.stage === '1') return runStatic(out);
  if (parsed.stage === '2') {
    out.write('stage 2 (touched) is not built yet (#2498 W4-04): nothing ran; run stage 3\n');
    return 1;
  }
  const junitPath = parsed.junitPath || path.join(os.tmpdir(), `tc-test-stage-${parsed.stage}-${process.pid}.xml`);
  if (parsed.stage === 'all') {
    return runSuite('all (the declared suite)', allArgv(junitPath, parsed.specPath), { root, junitPath, specPath: parsed.specPath, out });
  }
  const tier = TIER_OF_STAGE[parsed.stage];
  const files = tiers.loadLedger(path.join(root, 'test', 'tiers.json'))[tier];
  if (files.length === 0) {
    // Never hand node an empty file list: with no files it discovers its own,
    // which is the whole suite, not this tier.
    out.write(`stage ${parsed.stage} (${tier}): the ledger lists no files; nothing to run\n`);
    return 0;
  }
  const specPath = parsed.specPath === null ? 'stdout' : parsed.specPath;
  const guard = GUARD_OF_TIER[tier] ? `, guard ${GUARD_OF_TIER[tier]}, --test-timeout=${GUARDED_TIMEOUT_MS}` : ', no guard';
  const nodeArgv = tierArgv(tier, files, junitPath, specPath);
  const shown = `${nodeArgv.slice(0, nodeArgv.length - files.length).join(' ')} <${files.length} files: test/tiers.json ${tier}>`;
  return runSuite(`stage ${parsed.stage} (${tier}, ${files.length} files${guard})`, nodeArgv, { root, junitPath, specPath, out, shown });
}

module.exports = {
  STATIC_RING, GUARDED_TIMEOUT_MS, TIER_OF_STAGE, GUARD_OF_TIER, DECLARED_SUITE, STAGES,
  allArgv, tierArgv, syntaxCheck, trackedJs, staticSteps, runStatic, runSuite, parseArgs, main
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
