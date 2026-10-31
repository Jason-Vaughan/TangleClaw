#!/usr/bin/env node
'use strict';

/**
 * One entry point for the five stages of the test pyramid, and for the whole
 * suite (#2498).
 *
 *   1    static: every tracked `.js` parses, no conflict markers, no bare
 *        `node:assert`, the CLAUDE.md block is in sync, the tier ledger is
 *        total, no `lib/` export went dead past the tracked baseline, and the
 *        three static-ring tests pass. In-process where the check is a
 *        function; its wall time is printed, and the pull request that
 *        changes it carries the measurement.
 *   2    touched: the tests a diff reaches (`scripts/test-touched.js`), each
 *        tier under its guard. It fails closed: when the selection cannot be
 *        trusted it says why, runs Stage 3 whole instead, and says so.
 *   3    small: the Small tier under its guard
 *   4    medium: the Medium tier under its guard
 *   5    large: the Large tier, no spawn/exec guard, but still `--test-timeout`-bounded (#2691)
 *   all  the suite as the declared `test_command` runs it: one `node --test`
 *        over `test/*.test.js`, the same arguments in the same order, so what
 *        this runs and what the gate records are one command.
 *
 * Every tier runs with `--test-timeout`. In a guarded tier (Small, Medium) a
 * refused spawn is a throw, and product code waiting for the process it
 * never got can wait forever; the timeout turns that into a cancelled test
 * that names the file. The Large tier has no such guard — it is allowed to
 * spawn and open real resources — so the same timeout is the only thing
 * standing between one hung large file and the whole stage blocking
 * indefinitely with no recovery (#2691). The value is the one measured when
 * the ledger was first written (the slowest honest Medium file is past 120 s
 * with its tier sharing the host); re-measure before lowering it.
 *
 * Every run that executes tests writes a junit report and ends by reconciling
 * it with the runner's own summary (`lib/test-results.js`): the canonical count
 * is the runner's `tests`, the report's leaf count is printed beside it, and a
 * report that is not the run the summary describes, or that carries a failure
 * the summary does not count, exits 1 whatever node's exit code was.
 *
 * Stages 3-5 try the Testament pool first (#2733): probe, then run the tier's
 * manifest suite there, falling through to the local run above whenever
 * offload is bypassed (`TANGLECLAW_NO_TESTAMENT=1`, `CI`, a synthetic fixture
 * root with no `io.testament` seam) or the pool answers that it can't take
 * the run (no coordinator, the project not yet allowed, or any other
 * `--probe`/`--no-fallback` exit other than a clean pass or fail). A pool run
 * never writes a junit report — it is a quick pass/fail, not a `test_command`
 * run the evidence recorder can ingest.
 *
 * Usage: node scripts/test-stage.js <1|2|3|4|5|all> [--junit <path>] [--spec <path|stdout>] [--base <ref>]
 *   --junit  where the junit report goes (default: a file under the OS temp dir, printed);
 *            Stage 2 writes one per tier beside it, `<path>.<tier>.xml`
 *   --spec   also write the spec reporter there; `stdout` streams it. Stages 3-5
 *            default to `stdout` so a person sees the failing test; `all`
 *            defaults to none, which keeps its arguments identical to `test_command`.
 *   --base   Stage 2 only: the ref the diff is against (default `origin/main`)
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
const deadExports = require('./audit-dead-exports');
const touched = require('./test-touched');
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

/**
 * `--test-timeout` for the Large tier (#2691), in milliseconds. The Large
 * tier is allowed real subprocesses and real I/O, so its own slowest file
 * runs far longer than Medium's: `test/soak-guest.test.js` measured ~804 s
 * ALONE before a fix to two real slowness causes (a deferred-cleanup bug in
 * `deploy/soak/guest/guest-setup.sh`'s `bounded()` watchdog, and a fresh
 * macOS Gatekeeper/syspolicyd scan on every one of the dozens of brand-new
 * fake-command executables the test created per run); fixed, it measures
 * ~270 s ALONE, 208/208 passing both times — slow by design (deliberate
 * probe-hang simulations), never actually stuck. `GUARDED_TIMEOUT_MS` is
 * calibrated for Medium and would still cancel this file as a false
 * failure even post-fix.
 *
 * Measured for real under full Stage 5 contention (#2706, this repository at
 * this chunk's own head, a laptop): a full 312-file Large run, 12,286 tests,
 * green, 635,777 ms total; `test/soak-guest.test.js`'s own eight top-level
 * describes (which run sequentially within the file's one process — no
 * `concurrency` is declared) summed to ~486.9 s, a ~1.8x slowdown from its
 * ~270 s alone — far gentler than the ~12x alone-to-shared swing the Medium
 * tier's calibration saw, since this file is I/O/subprocess-bound rather
 * than CPU-bound against 300+ sibling processes. `GUARDED_TIMEOUT_MS` above
 * applies ~2.5x headroom over ITS OWN measured-shared number (120 s → 300 s);
 * the same ratio over 486.9 s would be ~1,217 s, so 1,500,000 ms (25 min,
 * ~3.1x headroom) is comfortably above that while still cutting the previous
 * unmeasured 60-minute placeholder by more than half. Re-measure if a new
 * slowest file emerges or this one changes materially; it is still a
 * *bound*, not an unbound run — a file that is genuinely stuck (as opposed
 * to merely slow) is cancelled and named instead of blocking the whole stage
 * forever with no recovery.
 */
const LARGE_TIMEOUT_MS = 1500000;

/** The tier each tier stage runs, and the guard each tier runs under. */
const TIER_OF_STAGE = Object.freeze({ 3: 'small', 4: 'medium', 5: 'large' });
const GUARD_OF_TIER = Object.freeze({
  small: './test/helpers/preload-small.js',
  medium: './test/helpers/preload-medium.js'
});

/** `--test-timeout` for each tier (#2691: every tier is now bounded, not just the guarded ones). */
const TIMEOUT_OF_TIER = Object.freeze({
  small: GUARDED_TIMEOUT_MS,
  medium: GUARDED_TIMEOUT_MS,
  large: LARGE_TIMEOUT_MS
});

/**
 * Client-side ceiling for one `testament run` of a tier (#2733): double the
 * manifest's own per-batch bound, covering queueing on the pool plus the run
 * itself. The pool enforces the batch bound on each runner; this is only a
 * guard against a `testament` CLI invocation that never returns at all.
 */
const TESTAMENT_RUN_TIMEOUT_MS = 2 * tiers.TESTAMENT_BATCH_TIMEOUT_S * 1000;

/**
 * Why a tier must run locally rather than through the Testament pool: an
 * explicit opt-out, CI (which has its own evidence path and no business
 * depending on an external pool), or a synthetic fixture repo under test
 * (unless the test supplies its own `io.testament` seam, in which case the
 * fixture root is exactly what it means to exercise).
 *
 * @param {string} root
 * @param {{testament?: object}} io
 * @returns {string|null} The reason, or null when offload is allowed
 */
function testamentBypassReason(root, io) {
  if (process.env.TANGLECLAW_NO_TESTAMENT === '1') return 'TANGLECLAW_NO_TESTAMENT=1';
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') return 'CI';
  if (path.resolve(root) !== ROOT && !io.testament) return `root ${root} is not this repository`;
  return null;
}

/**
 * The `testament` binary: `testament` on `PATH`, else `~/.local/bin/testament`.
 *
 * @returns {string|null} An absolute path, or null when neither exists
 */
function resolveTestamentBin() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, 'testament');
    if (fs.existsSync(candidate)) return candidate;
  }
  const home = path.join(os.homedir(), '.local', 'bin', 'testament');
  return fs.existsSync(home) ? home : null;
}

/**
 * Run `testament` with the given arguments and parse its `--json` output.
 * Never throws: a missing binary, a spawn error, a timeout or unparseable
 * output are all reported as `ok: false` / `parsed: null` for the caller to
 * treat as "fall back to a local run".
 *
 * @param {string[]} argv - Arguments after `testament`
 * @param {number} timeoutMs
 * @param {{bin?: string|null, spawnSync?: function(string, string[], object): object}} [seam] - Injection seam
 * @returns {{ok: boolean, exitCode: number|null, parsed: object|null}}
 */
function runTestament(argv, timeoutMs, seam = {}) {
  const bin = 'bin' in seam ? seam.bin : resolveTestamentBin();
  if (!bin) return { ok: false, exitCode: null, parsed: null };
  const spawn = seam.spawnSync || spawnSync;
  const r = spawn(bin, argv, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || typeof r.status !== 'number') return { ok: false, exitCode: r.status ?? null, parsed: null };
  let parsed = null;
  try { parsed = JSON.parse(r.stdout || ''); } catch { /* unparseable: caller falls back */ }
  return { ok: true, exitCode: r.status, parsed };
}

/**
 * Try to run a tier on the Testament pool (#2733): probe, then
 * `--no-fallback --suite <tier>`. Null means "fall through to the existing
 * local run" — either offload is bypassed (`testamentBypassReason`), the pool
 * answered that it can't take the run right now, or the envelope is treated
 * as malformed rather than trusted blind: the process's own exit code
 * (`run.exitCode`) and the envelope's self-reported `exit_code` must agree
 * (per `client.py`'s `Outcome.envelope()`, the two are the same value by
 * construction, so a mismatch means something corrupted the pipe between
 * them), and a pass needs a `report.counts` object while a fail needs a
 * non-empty `report.items` array — an empty `{}` on pass or an empty
 * `items` on fail is treated the same as a missing `report`, never trusted
 * as a vacuous success/failure. Non-null means Testament ran the tier and
 * this is its verdict.
 *
 * Progress and fallback-diagnostic lines go to `io.err` (stderr), per the
 * sprint plan's own spec ("Log to stderr" for the offload notice, "log the
 * pool error code on stderr and fall back") and matching Testament's own
 * CLI philosophy (`cli.py`'s `_run`: "stdout carries the envelope alone...
 * progress is for whoever watches the run, and stderr is where that goes").
 * The actual pass/fail verdict stays on `io.out` (stdout), alongside every
 * other result this file prints.
 *
 * @param {string} tier
 * @param {{root: string, out: {write: function(string): any}, err: {write: function(string): any}, testament?: object}} io
 * @returns {number|null} 0 or 1 when Testament ran the tier; null to fall through
 */
function offloadTier(tier, io) {
  const bypass = testamentBypassReason(io.root, io);
  if (bypass) return null;
  const seam = io.testament || {};
  io.err.write(`testament: probing the pool for ${tier}...\n`);
  const probe = runTestament(['run', '--probe', '--json'], 5000, seam);
  if (!probe.ok || probe.exitCode !== 0 || probe.parsed?.status !== 'ok') {
    io.err.write(`testament: pool unavailable for ${tier} (${probe.parsed?.error?.code || 'probe failed'}); running locally\n`);
    return null;
  }
  io.err.write(`testament: running ${tier} on the pool (this blocks until the batch finishes)...\n`);
  const run = runTestament(['run', '--no-fallback', '--suite', tier, '--json=summary'], TESTAMENT_RUN_TIMEOUT_MS, seam);
  if (!run.ok || run.parsed === null) {
    io.err.write(`testament: pool run for ${tier} produced no usable report; running locally\n`);
    return null;
  }
  if (run.exitCode === 0 && run.parsed.exit_code === 0) {
    if (!run.parsed.report || typeof run.parsed.report !== 'object' || !run.parsed.report.counts || typeof run.parsed.report.counts !== 'object') {
      io.err.write(`testament: pool run for ${tier} reported pass but the envelope carries no usable report; running locally\n`);
      return null;
    }
    io.out.write(`testament: ${tier} passed on the pool (${JSON.stringify(run.parsed.report.counts)})\n`);
    return 0;
  }
  if (run.exitCode === 1 && run.parsed.exit_code === 1) {
    if (!run.parsed.report || !Array.isArray(run.parsed.report.items) || run.parsed.report.items.length === 0) {
      io.err.write(`testament: pool run for ${tier} reported failure but the envelope carries no usable report; running locally\n`);
      return null;
    }
    const items = run.parsed.report.items.map((it) => `  ${it.id || JSON.stringify(it)}`).join('\n');
    io.out.write(`testament: ${tier} failed on the pool:\n${items}\n`);
    return 1;
  }
  io.err.write(`testament: pool run for ${tier} exited ${run.exitCode} (${run.parsed?.error?.code || 'unknown'}); running locally\n`);
  return null;
}

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
  if (GUARD_OF_TIER[tier]) argv.push('--require', GUARD_OF_TIER[tier]);
  argv.push(`--test-timeout=${TIMEOUT_OF_TIER[tier]}`);
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
      name: 'dead exports',
      run: () => { const out = sink(); const code = deadExports.main(['--check'], { stdout: out }); return { ok: code === 0, output: out.text() }; }
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
 * @returns {{stage: string, junitPath: string|null, specPath: string|null, base: string|null}}
 */
function parseArgs(argv) {
  const [stage, ...rest] = argv;
  if (!STAGES.includes(stage)) throw new Error('usage: test-stage.js <1|2|3|4|5|all> [--junit <path>] [--spec <path|stdout>] [--base <ref>]');
  const parsed = { stage, junitPath: null, specPath: null, base: null };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (flag === '--junit' && value) parsed.junitPath = path.resolve(value);
    else if (flag === '--spec' && value) parsed.specPath = value === 'stdout' ? 'stdout' : path.resolve(value);
    else if (flag === '--base' && value && stage === '2') parsed.base = value;
    else throw new Error(`unknown or incomplete argument: ${flag}`);
  }
  return parsed;
}

/**
 * Run one stage and return the process exit code.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {{stdout?: {write: function(string): any}, stderr?: {write: function(string): any}, root?: string, touchedIo?: object, testament?: object}} [io] - Injection seam: `root` runs
 *   the test-running stages (2, 3, 4, 5, `all`) against another checkout, which is how the runner is
 *   proved on a fixture repository; `touchedIo` replaces Stage 2's git and file system (`test-touched.repoIo`);
 *   `stderr` is where stages 3-5 route Testament offload progress/fallback diagnostics (`offloadTier`);
 *   Stage 1 is bound to this repository (see `staticSteps`)
 * @returns {number} 0 green, 1 red, 2 usage
 */
function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const errOut = io.stderr || process.stderr;
  const root = io.root || ROOT;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    out.write(`${err.message}\n`);
    return 2;
  }
  if (parsed.stage === '1') {
    if (path.resolve(root) !== ROOT) {
      out.write('stage 1 runs only against this repository and cannot be pointed at another checkout\n');
      return 2;
    }
    return runStatic(out);
  }
  if (parsed.stage === '2') {
    return touched.stage2({ base: parsed.base || 'origin/main', run: true, explain: false, junitPath: parsed.junitPath }, { stdout: out, root, io: io.touchedIo });
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
  const offloaded = offloadTier(tier, { root, out, err: errOut, testament: io.testament });
  if (offloaded !== null) return offloaded;
  const specPath = parsed.specPath === null ? 'stdout' : parsed.specPath;
  const guard = GUARD_OF_TIER[tier]
    ? `, guard ${GUARD_OF_TIER[tier]}, --test-timeout=${TIMEOUT_OF_TIER[tier]}`
    : `, no spawn/exec guard, --test-timeout=${TIMEOUT_OF_TIER[tier]}`;
  const nodeArgv = tierArgv(tier, files, junitPath, specPath);
  const shown = `${nodeArgv.slice(0, nodeArgv.length - files.length).join(' ')} <${files.length} files: test/tiers.json ${tier}>`;
  return runSuite(`stage ${parsed.stage} (${tier}, ${files.length} files${guard})`, nodeArgv, { root, junitPath, specPath, out, shown });
}

module.exports = {
  STATIC_RING, GUARDED_TIMEOUT_MS, LARGE_TIMEOUT_MS, TIMEOUT_OF_TIER, TIER_OF_STAGE, GUARD_OF_TIER, DECLARED_SUITE, STAGES,
  TESTAMENT_RUN_TIMEOUT_MS,
  allArgv, tierArgv, syntaxCheck, trackedJs, staticSteps, runStatic, runSuite, parseArgs, main,
  testamentBypassReason, resolveTestamentBin, runTestament, offloadTier
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
