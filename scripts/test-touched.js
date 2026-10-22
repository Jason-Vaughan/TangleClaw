#!/usr/bin/env node
'use strict';

/**
 * Stage 2 of the test pyramid: the test files a diff reaches (#2498 W4-04).
 *
 * The changed files are `git diff --name-only <base>...HEAD` plus whatever
 * the working tree holds uncommitted or untracked. A test file is selected
 * when its require graph, or a product path its text names, reaches a
 * changed file (`scripts/_require-graph.js` says what counts); a changed test
 * file selects itself; the three static-ring tests are always in.
 *
 * It FAILS CLOSED. When the selection cannot be trusted it exits 1, names
 * every reason, and prints `ESCALATE: run stage 3`, because a selection that
 * might have missed the test that would have failed is worse than no
 * selection. The reasons, each one a line:
 *
 *   dynamic-require   a changed file lies where a dynamic `require` on some
 *                     test's graph could reach (under the literal prefix the
 *                     require carries, or anywhere, when it carries none)
 *   not-javascript    a changed file is not `.js`: configuration, a ledger,
 *                     JSON or YAML a test may read, a document, `.prawduct/`
 *                     state. The text graph cannot say who reads it.
 *   shared-helper     a changed file is a shared test helper or fixture
 *                     (`test/_*.js`, `test/helpers/*`, `test/fixtures/*`),
 *                     whose readers the graph cannot enumerate from text
 *   unreached         a changed file is reached by no test at all (a deleted
 *                     file is one of these)
 *
 * There is no flag to accept a partial selection.
 *
 * Usage: node scripts/test-touched.js [--base <ref>] [--run] [--explain] [--junit <path>]
 *   --base     the ref the diff is against (default `origin/main`; the
 *              merge-base with HEAD is what is diffed)
 *   --run      run the selection, each tier under its guard as Stage 3/4/5
 *              would; on escalation run Stage 3 whole instead, and say so
 *   --explain  list the selected tests per changed file, the dynamic requires
 *              and opaque reads on their graphs
 *   --junit    with --run: the junit path; each tier's report is written
 *              beside it as `<path>.<tier>.xml` (default: under the OS temp dir)
 * Exit 0 on a trusted selection (or, with --run, a green run), 1 on
 * escalation or a red run, 2 on a usage error.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const graphLib = require('./_require-graph');
const tiers = require('./test-tiers');

const ROOT = graphLib.ROOT;

/** A changed file that is a shared test helper or fixture. */
const SHARED_HELPER = /^test\/(?:_[^/]+\.js|helpers\/|fixtures\/)/;

/** A changed file that is a test the suite runs. */
const TEST_FILE = /^test\/[^/]+\.test\.js$/;

/**
 * The repository's default io for the selector: git and the file system.
 *
 * @param {string} root - The repository
 * @returns {{changed: function(string): {mergeBase: string, files: string[]}, tests: function(): string[], graphIo: object}}
 */
function repoIo(root) {
  return {
    changed: (base) => changedFiles(base, root),
    tests: () => tiers.suiteFiles().map((rel) => path.join(root, rel)),
    graphIo: { ...graphLib.FS_IO, root }
  };
}

/**
 * The files a diff against `base` changes, plus the working tree's own
 * changes, as repo-relative paths, sorted and unique.
 *
 * @param {string} base - A ref
 * @param {string} root - The repository
 * @returns {{mergeBase: string, files: string[]}}
 */
function changedFiles(base, root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  const files = new Set(git(['diff', '--name-only', '--no-renames', mergeBase, 'HEAD']).split('\n').filter(Boolean));
  for (const line of git(['status', '--porcelain', '--untracked-files=all', '--no-renames']).split('\n')) {
    if (line.length > 3) files.add(line.slice(3));
  }
  return { mergeBase, files: [...files].sort() };
}

/**
 * Select the tests a set of changed files reaches, or the reasons the
 * selection cannot be trusted.
 *
 * @param {string[]} changed - Repo-relative paths
 * @param {{root: string, tests: string[], graphIo: object, ring?: string[]}} ctx -
 *   `tests` are the suite's files, absolute; `ring` the always-run tests (the static ring by default)
 * @returns {{
 *   changed: Array<{file: string, tests: string[], reason: string|null, detail: string}>,
 *   selected: string[], ring: string[], escalations: string[],
 *   dynamic: Array<{test: string, from: string, line: number, request: string}>, opaque: number
 * }} `selected` and `ring` are repo-relative; `escalations` is empty when the selection holds
 */
function select(changed, ctx) {
  const root = ctx.root;
  const rel = (abs) => path.relative(root, abs);
  const graph = graphLib.buildGraph(ctx.tests, ctx.graphIo);
  const reach = new Map(ctx.tests.map((t) => [t, graphLib.reachOf(t, graph)]));
  const ring = ctx.ring || require('./test-stage').STATIC_RING;
  const selected = new Set();
  const rows = [];
  const escalations = [];
  for (const file of changed) {
    const abs = path.join(root, file);
    const row = { file, tests: [], reason: null, detail: '' };
    rows.push(row);
    if (TEST_FILE.test(file)) {
      if (ctx.graphIo.isFile(abs)) { selected.add(file); row.tests = [file]; row.detail = 'itself'; } else row.detail = 'deleted; nothing to run';
      continue;
    }
    if (SHARED_HELPER.test(file)) { row.reason = 'shared-helper'; row.detail = 'a shared test helper or fixture: its readers cannot be enumerated from text'; escalations.push(row); continue; }
    if (!file.endsWith('.js')) { row.reason = 'not-javascript'; row.detail = 'not JavaScript: the text graph cannot say who reads it'; escalations.push(row); continue; }
    const risky = [];
    for (const t of ctx.tests) {
      for (const d of reach.get(t).dynamic) {
        if (d.prefix === null || abs.startsWith(d.prefix + path.sep)) risky.push(`${rel(t)} via ${rel(d.from)}:${d.line} ${d.request}${d.prefix ? ` (bounded to ${rel(d.prefix)}/)` : ' (unbounded)'}`);
      }
    }
    if (risky.length > 0) { row.reason = 'dynamic-require'; row.detail = `a dynamic require could reach it: ${risky.join('; ')}`; escalations.push(row); continue; }
    const reached = ctx.tests.filter((t) => graphLib.reaches(reach.get(t), abs)).map(rel);
    if (reached.length === 0) { row.reason = 'unreached'; row.detail = ctx.graphIo.isFile(abs) ? 'reached by no test' : 'deleted, and reached by no test'; escalations.push(row); continue; }
    row.tests = reached;
    row.detail = `${reached.length} test file(s)`;
    for (const t of reached) selected.add(t);
  }
  const selectedList = [...selected].sort();
  const dynamic = [];
  let opaque = 0;
  for (const t of selectedList) {
    const r = reach.get(path.join(root, t));
    if (!r) continue;
    for (const d of r.dynamic) dynamic.push({ test: t, from: rel(d.from), line: d.line, request: d.request });
    opaque += r.opaque.length;
  }
  return { changed: rows, selected: selectedList, ring: [...ring], escalations: escalations.map((r) => `${r.file}: ${r.reason}: ${r.detail}`), dynamic, opaque };
}

/**
 * The selected files grouped by the ledger's tier, the ring included. A
 * selected file the ledger does not declare runs as `large` (no guard), and
 * is named, because Stage 1's ledger check is what refuses it.
 *
 * @param {{selected: string[], ring: string[]}} selection - From `select`
 * @param {{small: string[], medium: string[], large: string[]}} ledger - From `test-tiers`
 * @returns {{small: string[], medium: string[], large: string[], undeclared: string[]}}
 */
function byTier(selection, ledger) {
  const tierOf = new Map();
  for (const tier of tiers.TIERS) for (const f of ledger[tier]) tierOf.set(f, tier);
  const groups = { small: [], medium: [], large: [], undeclared: [] };
  for (const f of [...new Set([...selection.selected, ...selection.ring])].sort()) {
    const tier = tierOf.get(f);
    if (tier) groups[tier].push(f);
    else { groups.large.push(f); groups.undeclared.push(f); }
  }
  return groups;
}

/**
 * Print a selection: one line per changed file, the totals, and on
 * escalation every reason and the `ESCALATE` line.
 *
 * @param {ReturnType<typeof select>} selection
 * @param {{out: {write: function(string): any}, explain: boolean, ledger?: object, base?: string, mergeBase?: string}} io
 * @returns {boolean} Whether the selection holds (no escalation)
 */
function report(selection, io) {
  const w = (s) => io.out.write(`${s}\n`);
  const base = io.base ? ` base ${io.base}${io.mergeBase ? ` (merge-base ${io.mergeBase.slice(0, 8)})` : ''},` : '';
  w(`touched:${base} ${selection.changed.length} changed file(s)`);
  for (const row of selection.changed) {
    w(`  ${row.file} -> ${row.reason ? `${row.reason}: ` : ''}${row.detail}`);
    if (io.explain && row.tests.length > 0 && row.detail !== 'itself') for (const t of row.tests) w(`      ${t}`);
  }
  if (selection.escalations.length > 0) {
    w(`REFUSED: ${selection.escalations.length} changed file(s) the selection cannot answer for`);
    w('ESCALATE: run stage 3');
    return false;
  }
  const groups = io.ledger ? byTier(selection, io.ledger) : null;
  const total = new Set([...selection.selected, ...selection.ring]).size;
  w(`selected: ${selection.selected.length} test file(s) + ${selection.ring.length} static ring = ${total}${groups ? ` (small ${groups.small.length}, medium ${groups.medium.length}, large ${groups.large.length}${groups.undeclared.length ? `, undeclared in the ledger: ${groups.undeclared.join(', ')}` : ''})` : ''}`);
  if (io.explain) {
    for (const t of selection.selected) w(`  ${t}`);
    for (const r of selection.ring) if (!selection.selected.includes(r)) w(`  ${r} (static ring)`);
    w(`dynamic requires on the selected graphs: ${selection.dynamic.length}${selection.dynamic.map((d) => `\n  ${d.test} via ${d.from}:${d.line} ${d.request}`).join('')}`);
    w(`opaque reads on the selected graphs (paths built at run time, outside the walker's sight): ${selection.opaque}`);
  }
  return true;
}

/**
 * Run a selection, each tier under its guard, and reconcile each run.
 *
 * @param {ReturnType<typeof select>} selection
 * @param {{root: string, out: {write: function(string): any}, ledger: object, junitPath: string}} io
 * @returns {number} 0 when every tier ran green, 1 otherwise
 */
function runSelection(selection, io) {
  const stage = require('./test-stage');
  const groups = byTier(selection, io.ledger);
  let code = 0;
  for (const tier of tiers.TIERS) {
    const files = groups[tier];
    if (files.length === 0) continue;
    const junitPath = `${io.junitPath}.${tier}.xml`;
    const argv = stage.tierArgv(tier, files, junitPath, 'stdout');
    const shown = `${argv.slice(0, argv.length - files.length).join(' ')} ${files.join(' ')}`;
    const r = stage.runSuite(`stage 2 (${tier}, ${files.length} files)`, argv, { root: io.root, junitPath, specPath: 'stdout', out: io.out, shown });
    if (r !== 0) code = 1;
  }
  return code;
}

/**
 * Parse argv.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{base: string, run: boolean, explain: boolean, junitPath: string|null}}
 */
function parseArgs(argv) {
  const parsed = { base: 'origin/main', run: false, explain: false, junitPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') parsed.run = true;
    else if (a === '--explain') parsed.explain = true;
    else if (a === '--base' && argv[i + 1]) parsed.base = argv[++i];
    else if (a === '--junit' && argv[i + 1]) parsed.junitPath = path.resolve(argv[++i]);
    else throw new Error('usage: test-touched.js [--base <ref>] [--run] [--explain] [--junit <path>]');
  }
  return parsed;
}

/**
 * Select, report, and with `run` execute: Stage 2 as the runner and the
 * command line both call it.
 *
 * @param {{base: string, run: boolean, explain: boolean, junitPath: string|null}} parsed - From `parseArgs`
 * @param {{stdout?: {write: function(string): any}, root?: string, io?: object, ledgerPath?: string}} [seams] -
 *   `io` replaces git and the file system (`repoIo` by default), and may carry `ring`, the always-run
 *   tests of that environment (the static ring by default); `root` the repository
 * @returns {number} 0 trusted (and green when run), 1 escalated or red
 */
function stage2(parsed, seams = {}) {
  const out = seams.stdout || process.stdout;
  const root = seams.root || ROOT;
  const io = seams.io || repoIo(root);
  const ledger = tiers.loadLedger(seams.ledgerPath || path.join(root, 'test', 'tiers.json'));
  const t0 = Date.now();
  const { mergeBase, files } = io.changed(parsed.base);
  const selection = select(files, { root, tests: io.tests(), graphIo: io.graphIo, ring: io.ring });
  const trusted = report(selection, { out, explain: parsed.explain, ledger, base: parsed.base, mergeBase });
  out.write(`stage 2 (touched): selection ${Date.now() - t0} ms, ${trusted ? 'trusted' : 'escalated'}\n`);
  if (!parsed.run) return trusted ? 0 : 1;
  const stage = require('./test-stage');
  const junitPath = parsed.junitPath || path.join(os.tmpdir(), `tc-test-stage-2-${process.pid}`);
  if (!trusted) {
    out.write('stage 2 (touched): running stage 3 whole instead\n');
    return stage.main(['3', '--junit', `${junitPath}.small.xml`], { stdout: out, root });
  }
  return runSelection(selection, { root, out, ledger, junitPath });
}

/**
 * The command line.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {object} [seams] - As `stage2` takes
 * @returns {number} 0, 1, or 2 on a usage error
 */
function main(argv, seams = {}) {
  const out = seams.stdout || process.stdout;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    out.write(`${err.message}\n`);
    return 2;
  }
  return stage2(parsed, seams);
}

module.exports = { SHARED_HELPER, TEST_FILE, repoIo, changedFiles, select, byTier, report, runSelection, parseArgs, stage2, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
