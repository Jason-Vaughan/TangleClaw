#!/usr/bin/env node
'use strict';

/**
 * The per-file coverage redundancy matrix: which test files execute no product
 * line that the other files of the same run do not also execute (#2498 W4-05).
 *
 * Each test file runs alone, under its tier's guard and timeout exactly as
 * its stage runs it, with node's own coverage (`--experimental-test-coverage
 * --test-reporter=lcov`; zero dependencies, so no `c8`). From each run the
 * audit keeps the set of product lines executed, a product line being a line
 * of `server.js`, `lib/`, `public/`, `bin/` or `scripts/` with a hit count
 * above zero. A test file's own lines and its helpers' are not product lines:
 * every file covers itself, so counting them would make every file unique.
 *
 * For every file the matrix says how many product lines it executes and how
 * many of those no other file of the run executes (what it adds). A file that
 * adds nothing is an EXACT-SUBSET CANDIDATE: everything it executes, the rest
 * executes too. Candidates are not jointly removable (two files that execute
 * the same lines are each a candidate, and retiring both loses those lines),
 * so the report also gives one removable set, chosen greedily from the
 * smallest candidate up, in which retiring every file together still loses no
 * line. A file that executes no product line at all is listed apart: it
 * proves what it proves by reading text or by testing a helper, and line
 * coverage says nothing about it.
 *
 * What line coverage cannot see, said once: loading a module executes its
 * top-level lines, so a file that only requires a module still "covers" them;
 * two files that execute the same line may assert different things about it;
 * and branches are not compared. The matrix is a candidate list for a
 * consolidation wave to read, never a deletion list (D4: retiring a test is a
 * contract change, accepted per batch).
 *
 * Slow by nature (one process per file), so it runs on request and never in
 * a stage. `--tier small` is the documented first use.
 *
 * Usage: node scripts/audit-test-redundancy.js --tier small|medium|large [--jobs N]
 *        node scripts/audit-test-redundancy.js [--jobs N] test/a.test.js test/b.test.js …
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tiers = require('./test-tiers');
const stage = require('./test-stage');

const ROOT = path.join(__dirname, '..');

/** A product source path, repo-relative: the files a test exists to prove. */
const PRODUCT_PATH = /^(?:server\.js$|lib\/|public\/|bin\/|scripts\/)/;

/**
 * Read an lcov report into the lines each source file executed.
 *
 * Only `SF:`, `DA:` and `end_of_record` carry what the matrix needs; every
 * other record (`TN:`, `FN:`, `FNDA:`, `BRDA:`, the summaries) is skipped. A
 * `DA:` line may carry a checksum after its count. A malformed `DA:`, a `DA:`
 * outside a file's record, a record opened inside another, or a record never
 * closed is an error, named with its line: a report this parser misreads
 * would turn into a wrong matrix silently.
 *
 * @param {string} text - The report
 * @returns {Map<string, Set<number>>} Source path as written in `SF:` → the line numbers with a hit count above zero
 */
function parseLcov(text) {
  const executed = new Map();
  let current = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('SF:')) {
      if (current !== null) throw new Error(`lcov line ${i + 1}: SF opened inside the record of ${current}`);
      current = line.slice(3);
      if (!executed.has(current)) executed.set(current, new Set());
    } else if (line.startsWith('DA:')) {
      const m = /^DA:(\d+),(\d+)(?:,[^,]*)?$/.exec(line);
      if (!m) throw new Error(`lcov line ${i + 1}: malformed DA record: ${line}`);
      if (current === null) throw new Error(`lcov line ${i + 1}: DA outside a file record`);
      if (Number(m[2]) > 0) executed.get(current).add(Number(m[1]));
    } else if (line === 'end_of_record') {
      if (current === null) throw new Error(`lcov line ${i + 1}: end_of_record with no open record`);
      current = null;
    }
  }
  if (current !== null) throw new Error(`lcov: the record of ${current} is never closed`);
  return executed;
}

/**
 * The product lines one run executed, as `file:line` keys.
 *
 * @param {Map<string, Set<number>>} executed - From `parseLcov`
 * @returns {Set<string>}
 */
function productLines(executed) {
  const keys = new Set();
  for (const [file, lines] of executed) {
    if (!PRODUCT_PATH.test(file)) continue;
    for (const n of lines) keys.add(`${file}:${n}`);
  }
  return keys;
}

/**
 * Build the matrix from each file's product lines.
 *
 * @param {Map<string, Set<string>>} perFile - Test file → the product lines it executed
 * @returns {{
 *   rows: Array<{file: string, covered: number, adds: number}>,
 *   candidates: string[], removable: string[], noProductLine: string[], union: number
 * }} `rows` sorted by what each file adds, smallest first, then by name;
 *   `candidates` the files that add nothing; `removable` a set of them that
 *   can be retired together; `noProductLine` the files that execute none
 */
function matrix(perFile) {
  const count = new Map();
  for (const keys of perFile.values()) for (const k of keys) count.set(k, (count.get(k) || 0) + 1);
  const rows = [];
  for (const [file, keys] of perFile) {
    let adds = 0;
    for (const k of keys) if (count.get(k) === 1) adds++;
    rows.push({ file, covered: keys.size, adds });
  }
  rows.sort((a, b) => a.adds - b.adds || (a.file < b.file ? -1 : 1));
  const noProductLine = rows.filter((r) => r.covered === 0).map((r) => r.file).sort();
  const candidateRows = rows.filter((r) => r.covered > 0 && r.adds === 0);
  // Retiring a file only lowers counts, so only a candidate can ever become
  // removable; walking them smallest first keeps the larger files, which
  // are the consolidation targets the smaller ones fold into.
  const remaining = new Map(count);
  const removable = [];
  for (const r of [...candidateRows].sort((a, b) => a.covered - b.covered || (a.file < b.file ? -1 : 1))) {
    const keys = perFile.get(r.file);
    let safe = true;
    for (const k of keys) if (remaining.get(k) < 2) { safe = false; break; }
    if (!safe) continue;
    for (const k of keys) remaining.set(k, remaining.get(k) - 1);
    removable.push(r.file);
  }
  return { rows, candidates: candidateRows.map((r) => r.file).sort(), removable: removable.sort(), noProductLine, union: count.size };
}

/**
 * The arguments one file's coverage run hands node: coverage on, the lcov
 * reporter to `dest`, and the tier's guard and timeout as its stage uses them.
 *
 * @param {string} tier - `small` | `medium` | `large`
 * @param {string} file - Repo-relative test file
 * @param {string} dest - Where the lcov report goes
 * @returns {string[]} Arguments after `node`
 */
function runArgv(tier, file, dest) {
  const argv = ['--test', '--experimental-test-coverage', '--test-reporter=lcov', `--test-reporter-destination=${dest}`];
  if (stage.GUARD_OF_TIER[tier]) argv.push('--require', stage.GUARD_OF_TIER[tier], `--test-timeout=${stage.GUARDED_TIMEOUT_MS}`);
  argv.push(file);
  return argv;
}

/**
 * Run one test file with coverage in its own process and return its report.
 * `NODE_TEST_CONTEXT` is dropped so a run started from inside a test is a
 * test run of its own, as the stage runner's are.
 *
 * @param {string} file - Repo-relative test file
 * @param {{tier: string, root: string}} ctx
 * @returns {Promise<{status: number|null, lcov: string|null, stderr: string}>}
 */
function runFile(file, ctx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-redundancy-'));
  const dest = path.join(dir, 'coverage.lcov');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, runArgv(ctx.tier, file, dest), { cwd: ctx.root, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('error', reject);
    child.on('close', (status) => {
      let lcov = null;
      try {
        lcov = fs.readFileSync(dest, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') { reject(err); return; } // no report is a failed run, named below; anything else is an error
      }
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ status, lcov, stderr });
    });
  });
}

/**
 * Run every file, at most `jobs` at a time, and keep each one's product lines.
 * A run that exits non-zero, writes no report, or writes one that does not
 * parse is a failure, named and left out of the matrix: leaving it out can
 * only make other files look less redundant, never more.
 *
 * @param {Array<{file: string, tier: string}>} work
 * @param {{jobs: number, root: string, runFile: typeof runFile}} ctx
 * @returns {Promise<{perFile: Map<string, Set<string>>, failed: Array<{file: string, reason: string}>}>}
 */
async function collect(work, ctx) {
  const perFile = new Map();
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < work.length) {
      const { file, tier } = work[next++];
      const r = await ctx.runFile(file, { tier, root: ctx.root });
      if (r.status !== 0) { failed.push({ file, reason: `exit ${r.status}${r.stderr ? `: ${r.stderr.trim().split('\n').pop()}` : ''}` }); continue; }
      if (r.lcov === null) { failed.push({ file, reason: 'no coverage report written' }); continue; }
      try {
        perFile.set(file, productLines(parseLcov(r.lcov)));
      } catch (err) {
        if (!err.message.startsWith('lcov')) throw err; // only a parse refusal is the file's failure
        failed.push({ file, reason: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(ctx.jobs, work.length)) }, worker));
  failed.sort((a, b) => (a.file < b.file ? -1 : 1));
  return { perFile, failed };
}

/**
 * Print the report.
 *
 * @param {ReturnType<typeof matrix>} m
 * @param {{files: number, failed: Array<{file: string, reason: string}>, label: string, jobs: number, seconds: number}} run
 * @param {{write: function(string): any}} out
 */
function report(m, run, out) {
  const w = (s) => out.write(`${s}\n`);
  w(`coverage redundancy matrix: ${run.label}, ${run.files} file(s) run, ${run.failed.length} failed, ${run.jobs} at a time, ${run.seconds.toFixed(1)} s; ${m.union} product line(s) executed in all`);
  for (const f of run.failed) w(`  failed (left out of the matrix): ${f.file}: ${f.reason}`);
  w(`exact-subset candidates (every product line they execute, another file executes too): ${m.candidates.length}`);
  for (const f of m.candidates) w(`  ${f}`);
  w(`removable together (one greedy set of candidates, smallest first, that loses no line when all are retired): ${m.removable.length}`);
  for (const f of m.removable) w(`  ${f}`);
  w(`no product line executed (reads text or tests a helper; line coverage says nothing): ${m.noProductLine.length}`);
  for (const f of m.noProductLine) w(`  ${f}`);
  w('matrix (adds / executes  file), smallest addition first:');
  for (const r of m.rows) if (r.covered > 0) w(`  ${String(r.adds).padStart(6)} / ${String(r.covered).padEnd(6)} ${r.file}`);
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{tier: string|null, files: string[], jobs: number|null}|{error: string}}
 */
function parseArgs(argv) {
  const out = { tier: null, files: [], jobs: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tier' || a === '--jobs') {
      const v = argv[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      if (a === '--tier') {
        if (!tiers.TIERS.includes(v)) return { error: `unknown tier: ${v}` };
        out.tier = v;
      } else {
        if (!/^[1-9]\d*$/.test(v)) return { error: `--jobs must be a positive whole number: ${v}` };
        out.jobs = Number(v);
      }
    } else if (a.startsWith('--')) {
      return { error: `unknown flag: ${a}` };
    } else {
      out.files.push(a);
    }
  }
  if ((out.tier === null) === (out.files.length === 0)) return { error: 'name a tier or a list of test files, not both' };
  return out;
}

/** What the usage error prints. */
const USAGE = 'usage: audit-test-redundancy.js --tier small|medium|large [--jobs N]\n       audit-test-redundancy.js [--jobs N] test/<file>.test.js …\n';

/**
 * The command line.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {{stdout?: {write: function(string): any}, root?: string, ledger?: object,
 *   runFile?: typeof runFile, now?: function(): number, jobs?: number}} [io] - Injection seam
 * @returns {Promise<number>} 0 on a report; 1 on a usage error, when any run failed, or when the
 *   runs that succeeded executed no product line at all (an unreadable report, refused by name)
 */
async function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const parsed = parseArgs(argv);
  if (parsed.error) { out.write(`${parsed.error}\n${USAGE}`); return 1; }
  const ledger = io.ledger || tiers.loadLedger();
  const tierOf = new Map();
  for (const t of tiers.TIERS) for (const f of ledger[t]) tierOf.set(f, t);
  let work;
  if (parsed.tier) {
    work = ledger[parsed.tier].map((file) => ({ file, tier: parsed.tier }));
  } else {
    const unknown = parsed.files.filter((f) => !tierOf.has(f));
    if (unknown.length > 0) { out.write(`not in test/tiers.json (a file runs under its tier's guard, so it must have one): ${unknown.join(', ')}\n${USAGE}`); return 1; }
    work = parsed.files.map((file) => ({ file, tier: tierOf.get(file) }));
  }
  const jobs = parsed.jobs || io.jobs || Math.max(1, Math.floor(os.availableParallelism() / 2));
  const now = io.now || Date.now;
  const started = now();
  const { perFile, failed } = await collect(work, { jobs, root: io.root || ROOT, runFile: io.runFile || runFile });
  const label = parsed.tier ? `tier ${parsed.tier}` : 'named files';
  const m = matrix(perFile);
  report(m, { files: work.length, failed, label, jobs, seconds: (now() - started) / 1000 }, out);
  // Every run green and not one product line among them is not a suite with
  // nothing to prove: it is a report this audit cannot read (paths written
  // in a form `PRODUCT_PATH` does not match), and a matrix of empty sets
  // would call every file "executes no product line".
  if (perFile.size > 0 && m.union === 0) {
    out.write(`refused: ${perFile.size} run(s) succeeded and none executed a product line; the lcov SF: paths are probably not repo-relative (server.js, lib/, public/, bin/, scripts/), so this matrix cannot be read\n`);
    return 1;
  }
  return failed.length === 0 ? 0 : 1;
}

module.exports = { PRODUCT_PATH, USAGE, parseLcov, productLines, matrix, runArgv, runFile, collect, report, parseArgs, main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
