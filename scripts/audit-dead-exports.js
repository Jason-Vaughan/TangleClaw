#!/usr/bin/env node
'use strict';

/**
 * The dead-export audit: which exports of `lib/` nothing reads (#2498 W4-04).
 *
 * The require graph is walked from every entry point of the repository:
 * `server.js`, the three `bin/` commands, every `scripts/*.js`, and every
 * `test/*.test.js` (`hooks/*` are shell and load no module). For each name
 * a `lib/` module exports, the readers are the files that require the module
 * and use that name (`scripts/_require-graph.js` says how a use is read). A
 * name with no reader outside its own file is DEAD. A name whose only readers
 * are tests is TEST-ONLY, and a test that is the sole reader of such a name
 * is an orphan candidate: it proves something the product does not use.
 *
 * The report is a report (D4: no deletion in this wave). `--check` is the
 * Stage 1 use, and it is a ratchet against the tracked baseline
 * `test/dead-exports-baseline.json`: it exits 1 on a dead export the baseline
 * does not list (new dead code), and on a baseline entry that is no longer
 * dead or no longer exists (a stale baseline, which must shrink with the
 * code it describes), so the list only ever goes down. `--write-baseline`
 * rewrites the baseline from the current audit, for the commit that retires
 * a batch.
 *
 * Usage: node scripts/audit-dead-exports.js            the report
 *        node scripts/audit-dead-exports.js --check    exit 1 on growth or a stale baseline
 *        node scripts/audit-dead-exports.js --write-baseline
 */

const fs = require('node:fs');
const path = require('node:path');

const graphLib = require('./_require-graph');

const ROOT = graphLib.ROOT;

/** The tracked baseline the ratchet reads. */
const BASELINE = path.join(ROOT, 'test', 'dead-exports-baseline.json');

/** What the baseline file says at its top. */
const BASELINE_COMMENT = Object.freeze([
  'Exports of lib/ that nothing reads, as `node scripts/audit-dead-exports.js` found them (#2498 W4-04).',
  'A ratchet: `--check` (Stage 1) fails on a dead export this list does not name, and on an entry',
  'that is no longer dead or no longer exists. Retiring a batch (D4: each needs Architect',
  'acceptance) shrinks it with `--write-baseline`; nothing adds to it by hand.'
]);

/**
 * The audit's roots, absolute: the entry points, and every module under
 * `lib/` as well, so a module no entry point reaches is still audited (every
 * export of it is dead) rather than silently absent. Being a root makes a
 * file scanned, not a reader.
 *
 * @param {string} root - The repository
 * @param {{isFile: function(string): boolean}} io
 * @returns {string[]}
 */
function defaultRoots(root, io) {
  const list = (dir, keep) => {
    try { return fs.readdirSync(path.join(root, dir)).filter(keep).map((f) => path.join(root, dir, f)); } catch { return []; }
  };
  return [
    path.join(root, 'server.js'),
    ...list('bin', () => true),
    ...list('scripts', (f) => f.endsWith('.js')),
    ...list('test', (f) => f.endsWith('.test.js')),
    ...fs.readdirSync(path.join(root, 'lib'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'lib', f)).sort()
  ].filter((f) => io.isFile(f));
}

/**
 * Audit the exports of `lib/` reachable from the roots.
 *
 * @param {{root: string, roots: string[], graphIo: object}} ctx
 * @returns {{
 *   modules: number, names: number, opaque: string[],
 *   dead: Array<{file: string, name: string}>,
 *   testOnly: Array<{file: string, name: string, readers: string[]}>
 * }} Paths repo-relative, each list sorted
 */
function audit(ctx) {
  const root = ctx.root;
  const rel = (abs) => path.relative(root, abs);
  const graph = graphLib.buildGraph(ctx.roots, ctx.graphIo);
  const libDir = path.join(root, 'lib') + path.sep;
  const testDir = path.join(root, 'test') + path.sep;
  const readersOf = new Map();
  for (const scan of graph.values()) {
    for (const r of scan.requires) {
      if (!r.resolved || r.resolved === scan.file) continue;
      if (!readersOf.has(r.resolved)) readersOf.set(r.resolved, new Set());
      readersOf.get(r.resolved).add(scan.file);
    }
  }
  // A dynamic require bounded to a directory could read anything under it,
  // so no export of a module there can be called dead: those modules are
  // reported as shadowed, not audited. One with no bound at all shadows every
  // module, and that is an uncertainty the check refuses.
  const shadows = [];
  const unbounded = [];
  for (const scan of graph.values()) {
    for (const r of scan.requires) {
      if (r.kind !== 'dynamic' && (r.kind === 'bare' || r.resolved)) continue;
      const where = `${rel(scan.file)}:${r.line} ${r.request}`;
      if (r.prefix) shadows.push({ prefix: r.prefix + path.sep, where }); else unbounded.push(where);
    }
  }
  const result = { modules: 0, names: 0, opaque: [], shadowed: [], unbounded: unbounded.sort(), dead: [], testOnly: [] };
  for (const file of [...graph.keys()].sort()) {
    if (!file.startsWith(libDir)) continue;
    const scan = graph.get(file);
    if (scan.exports.kind === 'none') continue;
    result.modules++;
    if (scan.exports.kind === 'opaque') { result.opaque.push(rel(file)); continue; }
    const shadow = shadows.find((s) => file.startsWith(s.prefix));
    if (shadow) { result.shadowed.push(`${rel(file)} (by ${shadow.where})`); continue; }
    const names = scan.exports.kind === 'value' ? ['(module)'] : scan.exports.names;
    result.names += names.length;
    const readers = [...(readersOf.get(file) || [])].map((f) => graph.get(f));
    for (const name of names) {
      const by = readers.filter((r) => { const u = graphLib.usesOf(r, file); return name === '(module)' || u.all || u.names.has(name); }).map((r) => r.file);
      if (by.length === 0) result.dead.push({ file: rel(file), name });
      else if (by.every((f) => f.startsWith(testDir))) result.testOnly.push({ file: rel(file), name, readers: by.map(rel).sort() });
    }
  }
  const byKey = (a, b) => (`${a.file}:${a.name}` < `${b.file}:${b.name}` ? -1 : 1);
  result.dead.sort(byKey);
  result.testOnly.sort(byKey);
  return result;
}

/**
 * The orphan candidates: each test that is the sole reader of a test-only
 * export, with the exports it alone reads.
 *
 * @param {ReturnType<typeof audit>} result
 * @returns {Array<{test: string, exports: string[]}>} Sorted by test
 */
function orphanCandidates(result) {
  const byTest = new Map();
  for (const e of result.testOnly) {
    if (e.readers.length !== 1) continue;
    if (!byTest.has(e.readers[0])) byTest.set(e.readers[0], []);
    byTest.get(e.readers[0]).push(`${e.file}:${e.name}`);
  }
  return [...byTest.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([test, exports]) => ({ test, exports }));
}

/**
 * Print the report.
 *
 * @param {ReturnType<typeof audit>} result
 * @param {{write: function(string): any}} out
 */
function report(result, out) {
  const w = (s) => out.write(`${s}\n`);
  w(`dead-export audit: ${result.modules} lib/ modules, ${result.names} exported names audited, ${result.opaque.length} opaque (spread or computed exports), ${result.shadowed.length} shadowed by a dynamic require, ${result.unbounded.length} unbounded dynamic require(s)`);
  for (const f of result.opaque) w(`  opaque: ${f}`);
  for (const f of result.shadowed) w(`  shadowed: ${f}`);
  for (const f of result.unbounded) w(`  unbounded dynamic require: ${f}`);
  w(`dead (no reader at all, tests included): ${result.dead.length}`);
  for (const e of result.dead) w(`  ${e.file}:${e.name}`);
  w(`test-only (read by tests and by nothing in the product): ${result.testOnly.length}`);
  for (const e of result.testOnly) w(`  ${e.file}:${e.name} <- ${e.readers.join(', ')}`);
  const orphans = orphanCandidates(result);
  w(`orphan candidates (a test that is the sole reader of a test-only export): ${orphans.length}`);
  for (const o of orphans) w(`  ${o.test}: ${o.exports.join(', ')}`);
}

/**
 * Read the baseline. A malformed one is an error the check reports, not a
 * throw: a file that cannot be read is a red check, named.
 *
 * @param {string} file - The baseline's path
 * @returns {{entries: string[]|null, problems: string[]}} `entries` null when there is no baseline;
 *   `problems` names a malformed shape, an entry that is not `file:name`, a duplicate, or an unsorted list
 */
function readBaseline(file) {
  if (!fs.existsSync(file)) return { entries: null, problems: [`no baseline: ${path.basename(file)} is missing (write it with --write-baseline on a reviewed tree)`] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { entries: [], problems: [`malformed baseline: ${err.message}`] };
  }
  if (!raw || !Array.isArray(raw.dead)) return { entries: [], problems: ['malformed baseline: "dead" must be an array of "file:name" strings'] };
  const problems = [];
  const seen = new Set();
  for (const e of raw.dead) {
    if (typeof e !== 'string' || !/^lib\/[^:]+\.js:[^:\s]+$/.test(e)) { problems.push(`malformed baseline entry (not "lib/<file>.js:<name>"): ${JSON.stringify(e)}`); continue; }
    if (seen.has(e)) problems.push(`duplicate baseline entry: ${e}`);
    seen.add(e);
  }
  const sorted = [...seen].sort();
  if (problems.length === 0 && sorted.some((e, i) => e !== raw.dead[i])) problems.push('baseline is not sorted');
  return { entries: [...seen], problems };
}

/**
 * The ratchet: the current dead list against the baseline. Red on a dead
 * export the baseline does not list, a baseline entry no longer dead or no
 * longer there, a baseline that is malformed, duplicated or unsorted, and on
 * graph uncertainty (an opaque module, or a dynamic require with no bound),
 * each named.
 *
 * @param {ReturnType<typeof audit>} result
 * @param {{entries: string[]|null, problems: string[]}} baseline - From `readBaseline`
 * @returns {{ok: boolean, output: string}}
 */
function check(result, baseline) {
  const lines = [...baseline.problems];
  for (const f of result.opaque) lines.push(`graph uncertainty: ${f} exports by spread or computed key, so its names cannot be audited`);
  for (const w of result.unbounded) lines.push(`graph uncertainty: a dynamic require with no literal prefix could read any module: ${w}`);
  const listed = new Set(baseline.entries || []);
  const now = new Set(result.dead.map((e) => `${e.file}:${e.name}`));
  const grown = baseline.entries === null ? [] : [...now].filter((e) => !listed.has(e)).sort();
  const stale = [...listed].filter((e) => !now.has(e)).sort();
  for (const e of grown) lines.push(`new dead export (not in the baseline): ${e}`);
  for (const e of stale) lines.push(`stale baseline entry (read now, or gone): ${e}`);
  if (lines.length === 0) return { ok: true, output: `dead exports: ${listed.size} in the baseline, 0 new, 0 stale${result.shadowed.length ? `; ${result.shadowed.length} module(s) shadowed by a bounded dynamic require, not audited` : ''}` };
  lines.push(`dead exports: ${grown.length} new, ${stale.length} stale, ${baseline.problems.length} baseline problem(s), ${result.opaque.length + result.unbounded.length} uncertainty(ies) against a baseline of ${listed.size}`);
  return { ok: false, output: lines.join('\n') };
}

/**
 * Serialize a baseline the way the tracked file is written.
 *
 * @param {ReturnType<typeof audit>} result
 * @returns {string}
 */
function formatBaseline(result) {
  return `${JSON.stringify({ _comment: BASELINE_COMMENT, dead: result.dead.map((e) => `${e.file}:${e.name}`).sort() }, null, 2)}\n`;
}

/**
 * The command line, and Stage 1's step.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {{stdout?: {write: function(string): any}, root?: string, graphIo?: object, roots?: string[], baselinePath?: string}} [io] - Injection seam
 * @returns {number} 0 on a report or a green check, 1 on a red check or a usage error
 */
function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const root = io.root || ROOT;
  const graphIo = io.graphIo || { ...graphLib.FS_IO, root };
  const baselinePath = io.baselinePath || BASELINE;
  const [flag, ...rest] = argv;
  if (rest.length > 0 || (flag !== undefined && flag !== '--check' && flag !== '--write-baseline')) {
    out.write('usage: audit-dead-exports.js [--check | --write-baseline]\n');
    return 1;
  }
  const result = audit({ root, roots: io.roots || defaultRoots(root, graphIo), graphIo });
  if (flag === '--write-baseline') {
    fs.writeFileSync(baselinePath, formatBaseline(result));
    const shown = baselinePath.startsWith(root + path.sep) ? path.relative(root, baselinePath) : baselinePath;
    out.write(`wrote ${shown}: ${result.dead.length} dead export(s)\n`);
    return 0;
  }
  if (flag === '--check') {
    const r = check(result, readBaseline(baselinePath));
    out.write(`${r.output}\n`);
    return r.ok ? 0 : 1;
  }
  report(result, out);
  return 0;
}

module.exports = { BASELINE, BASELINE_COMMENT, defaultRoots, audit, orphanCandidates, report, readBaseline, check, formatBaseline, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
