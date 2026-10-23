#!/usr/bin/env node
'use strict';

/**
 * The source-reader triage: which test files read product source as text,
 * and which of those duplicate what a runtime test already loads (#2498 W4-05).
 *
 * A SOURCE READ is a `readFileSync` / `readFile` call on the file system
 * (bare, as a destructured name; on any name the test binds to `fs`,
 * `node:fs` or their `promises`, `.promises` included; or on an inline
 * `require('node:fs')`) whose first argument names a path under `server.js`,
 * `lib/`, `public/`, `bin/` or `scripts/`, read with the walker's own
 * resolution (`scripts/_require-graph.js`): a literal, a `path.join` /
 * `path.resolve` (or an inline `require('node:path').join`) of a root
 * constant and literal segments, a `require.resolve('./…')`, or a constant
 * the file defines that way. A read call on any other receiver is opaque. A read whose path ends in a run-time segment
 * (`path.join(LIB, name)`, or a helper `pub(f)` joining a directory with its
 * argument) reads from a DIRECTORY; its targets are the product files the
 * same test names under that directory, by a path or by a string literal
 * that is a file name there (`pub('app.js')`), and when it names none, the
 * read is a SWEEP of the directory (the root itself is not source: a read
 * from it that names no source file is not a source read). A read the walker cannot resolve (a
 * variable, a call) is OPAQUE: counted per file, never classified. Most are
 * temporary files and fixtures; any could be a source read.
 *
 * Every reader falls in one class, first match wins:
 *   - LIFT: it requires `test/helpers/lift.js`, which runs a shipped browser
 *     function from its text. Kept: it is how `public/` is tested in node.
 *   - REGEX-OF-BEHAVIOUR: it reads at least one named product code file (a
 *     `.js` file, or a `bin/` command, which is node with no extension).
 *     Split by RUNTIME PROOF, read from the require graph of every test file
 *     (and every `bin/` or `scripts/` entry a test names but does not read,
 *     which it spawns): SELF when the test itself loads every code file it
 *     reads, OTHER when some test loads each of them, NONE when some file it
 *     reads no test loads. SELF and OTHER are the candidates whose text
 *     assertions may duplicate a runtime test; NONE is a candidate for a
 *     runtime test (a require, or a lift for `public/`). A `public/` file is
 *     never counted as loaded: node runs it only through the lift helper,
 *     whose file argument this audit does not resolve.
 *   - GUARD: everything else, its reads all sweeps or non-JavaScript files
 *     (markup, styles, shell). It asserts a property of the text itself, which
 *     no runtime test can. Kept.
 *
 * Loading a module is not proving the behaviour a regex asserts about it, so
 * every class is a candidate list for a consolidation wave to read, never a
 * verdict (D4: no test is retired without its batch's acceptance).
 *
 * Usage: node scripts/audit-source-readers.js
 */

const path = require('node:path');

const graphLib = require('./_require-graph');
const tiers = require('./test-tiers');

const ROOT = graphLib.ROOT;

/** The product directories (and one file) whose text a source read reads. */
const SOURCE_ROOTS = Object.freeze(['server.js', 'lib', 'public', 'bin', 'scripts']);

/** A read call, on any receiver or none; the walker's mask keeps it from matching inside a string or comment. */
const READ_CALL = /(?<![\w$])(?:readFileSync|readFile)\s*\(/g;

/** The module names that are the file system (a binding to one of them is a reader's `fs`). */
const FS_MODULES = Object.freeze(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

/**
 * The receiver a read call is made on, read backwards from the method name:
 * none (`readFileSync(…)`, destructured), an identifier (`fs.`, `fsMod.`,
 * `fsp.`, each optionally `.promises.`), or an inline `require('…').`.
 *
 * @param {string} masked - The masked source
 * @param {string} text - The original source
 * @param {number} at - Offset of the method name
 * @returns {{kind: 'none'}|{kind: 'id', id: string}|{kind: 'require', request: string}|{kind: 'other'}}
 */
function receiverOf(masked, text, at) {
  const before = masked.slice(Math.max(0, at - 200), at);
  if (!/\.\s*$/.test(before)) return { kind: 'none' };
  const req = /require\(\s*(['"])[^'"]*\1\s*\)(?:\s*\.\s*promises)?\s*\.\s*$/.exec(before);
  if (req) {
    const start = at - before.length + req.index;
    const lit = /require\(\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(text.slice(start, at));
    return { kind: 'require', request: lit ? lit[2] : '' };
  }
  const id = /(?<![\w$.])([A-Za-z_$][\w$]*)(?:\s*\.\s*promises)?\s*\.\s*$/.exec(before);
  return id ? { kind: 'id', id: id[1] } : { kind: 'other' };
}

/**
 * A read's path argument with the inline spellings of `path` normalized, so
 * the walker's join resolution reads `require('node:path').join(…)` too.
 *
 * @param {string} arg - The argument's source text
 * @returns {string}
 */
function normalizePathCall(arg) {
  return arg.replace(/^require\(\s*(['"])(?:node:)?path\1\s*\)\s*\.\s*(join|resolve)\s*\(/, 'path.$2(');
}

/**
 * Whether an absolute path is product source, or the repository root itself
 * (a helper joining the root with a relative path reads from all of it).
 *
 * @param {string} abs
 * @param {string} root
 * @returns {boolean}
 */
function isSource(abs, root) {
  if (abs === root) return true;
  return SOURCE_ROOTS.some((s) => { const p = path.join(root, s); return abs === p || abs.startsWith(p + path.sep); });
}

/**
 * Whether a source file is code node runs: a `.js` file, or a `bin/` command
 * (node scripts with no extension).
 *
 * @param {string} abs
 * @param {string} root
 * @returns {boolean}
 */
function isCode(abs, root) {
  return abs.endsWith('.js') || abs.startsWith(path.join(root, 'bin') + path.sep);
}

/**
 * The source reads in one test file.
 *
 * @param {ReturnType<typeof graphLib.scanFile>} scan - The walker's scan of the file
 * @param {{readFile: function(string): string, isFile: function(string): boolean, isDir: function(string): boolean, root?: string}} io - The walker's seam
 * @returns {{
 *   files: Array<{line: number, path: string}>, sweeps: Array<{line: number, dir: string}>,
 *   opaque: Array<{line: number, arg: string}>
 * }} Absolute paths; `files` unique by path
 */
function readsOf(scan, io) {
  const root = io.root || ROOT;
  const text = io.readFile(scan.file);
  const masked = scan.masked;
  const roots = graphLib.rootConstants(text, masked, scan.file);
  roots.set('__dirname', path.dirname(scan.file));
  const starts = graphLib.lineStarts(text);
  const files = new Map();
  const dirs = [];
  const opaque = [];
  // The names this file gives the file-system module: a read on any other
  // receiver may be a read, but this audit cannot say, so it is opaque.
  const fsNames = new Set(scan.requires.filter((q) => q.kind === 'bare' && FS_MODULES.includes(q.request) && q.binding && q.binding.kind === 'namespace').map((q) => q.binding.id));
  const shown = (a) => (a.length > 60 ? `${a.slice(0, 57)}...` : a);
  let m;
  READ_CALL.lastIndex = 0;
  while ((m = READ_CALL.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const { args } = graphLib.splitArgs(masked, text, open);
    if (args.length === 0) continue;
    const line = graphLib.lineOf(starts, m.index);
    const recv = receiverOf(masked, text, m.index);
    const onFs = recv.kind === 'none' || (recv.kind === 'id' && fsNames.has(recv.id)) || (recv.kind === 'require' && FS_MODULES.includes(recv.request));
    if (!onFs) { opaque.push({ line, arg: `${recv.kind === 'id' ? recv.id : '(expression)'}.${m[0].replace(/\s*\($/, '')}(…)` }); continue; }
    const a = normalizePathCall(args[0]);
    let r = null;
    const lit = graphLib.literalOf(a);
    const join = /^path\.(?:join|resolve)\(/.exec(a);
    const resolveReq = /^require\.resolve\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)$/.exec(a);
    if (lit !== null) {
      r = { resolved: path.resolve(root, lit), bounded: true }; // tests run from the root, so a relative read is root-relative
    } else if (join) {
      r = graphLib.resolveJoin(graphLib.splitArgs(graphLib.mask(a), a, join[0].length - 1).args, roots);
    } else if (resolveReq && /^\.\.?\//.test(resolveReq[2])) {
      const f = graphLib.resolveFile(path.resolve(path.dirname(scan.file), resolveReq[2]), io);
      if (f) r = { resolved: f, bounded: true };
    } else if (roots.has(a)) {
      r = { resolved: roots.get(a), bounded: !io.isDir(roots.get(a)) };
    }
    if (!r) { opaque.push({ line, arg: shown(args[0]) }); continue; }
    if (!isSource(r.resolved, root)) continue;
    if (r.bounded) { if (!files.has(r.resolved)) files.set(r.resolved, { line, path: r.resolved }); } else dirs.push({ line, dir: r.resolved });
  }
  // A directory read takes its targets from the product files this test names
  // under that directory: by a path the walker resolved, or by a string
  // literal that is a file name under it (`pub('app.js')` for a helper
  // joining `public/` with its argument). A test that names none reads the
  // directory by names built at run time, which is a sweep.
  const required = new Set(scan.requires.map((q) => q.resolved).filter(Boolean));
  const literals = new Map();
  const str = /(['"])((?:\\.|(?!\1).)*)\1/g;
  while ((m = str.exec(text)) !== null) {
    if (masked[m.index] !== m[1] || !/^[\w@-][\w.@/-]*\.\w+$/.test(m[2])) continue; // a quote inside a comment or another literal; or not a file name
    if (!literals.has(m[2])) literals.set(m[2], graphLib.lineOf(starts, m.index));
  }
  const sweeps = [];
  for (const d of dirs) {
    const named = scan.paths.filter((p) => p.bounded && p.resolved.startsWith(d.dir + path.sep) && isSource(p.resolved, root) && !required.has(p.resolved));
    for (const [lit, line] of literals) {
      const abs = path.join(d.dir, lit);
      if (abs.startsWith(d.dir + path.sep) && isSource(abs, root) && io.isFile(abs) && !required.has(abs)) named.push({ line, resolved: abs });
    }
    if (named.length === 0) {
      // The root is not source, only the directories under it: a read from
      // it that names no source file reads something else (a doc, the log).
      if (d.dir !== root) sweeps.push(d);
      continue;
    }
    for (const p of named) if (!files.has(p.resolved)) files.set(p.resolved, { line: p.line, path: p.resolved });
  }
  return { files: [...files.values()].sort((x, y) => (x.path < y.path ? -1 : 1)), sweeps, opaque };
}

/**
 * The files some test loads at run time: the require closure of every test
 * file, plus the closure of every `bin/` or `scripts/` file a test names by
 * path without reading it (it is spawned). A `public/` file is never in it.
 *
 * @param {Map<string, ReturnType<typeof graphLib.scanFile>>} graph - From `buildGraph`
 * @param {string[]} tests - Absolute test paths
 * @param {Map<string, Set<string>>} readBy - Test → the files it reads as text
 * @param {string} root
 * @returns {{all: Set<string>, byTest: Map<string, Set<string>>}} `byTest` each test's own closure
 */
function runtimeLoads(graph, tests, readBy, root) {
  const closure = (start) => {
    const seen = new Set();
    const stack = [...start];
    while (stack.length > 0) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      const scan = graph.get(f);
      if (scan) for (const r of scan.requires) if (r.resolved) stack.push(r.resolved);
    }
    return seen;
  };
  const entry = new RegExp(`^${escapeRegExp(path.join(root, 'bin'))}/|^${escapeRegExp(path.join(root, 'scripts'))}/[^/]+\\.js$`);
  const all = new Set();
  const byTest = new Map();
  for (const t of tests) {
    const scan = graph.get(t);
    const reads = readBy.get(t) || new Set();
    const spawned = scan ? scan.paths.filter((p) => p.bounded && entry.test(p.resolved) && !reads.has(p.resolved)).map((p) => p.resolved) : [];
    const own = closure([t, ...spawned]);
    byTest.set(t, own);
    for (const f of own) all.add(f);
  }
  const publicDir = path.join(root, 'public') + path.sep;
  for (const set of [all, ...byTest.values()]) for (const f of [...set]) if (f.startsWith(publicDir)) set.delete(f);
  return { all, byTest };
}

/**
 * Escape a string for a regular expression.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Triage every test file.
 *
 * @param {{root: string, tests: string[], graphIo: object, tierOf?: Map<string, string>}} ctx -
 *   `tests` absolute; `tierOf` repo-relative test → tier, for the per-tier counts
 * @returns {{
 *   readers: Array<{file: string, tier: string|null, cls: 'lift'|'regex'|'guard', proof: 'self'|'other'|'none'|null,
 *     reads: string[], unloaded: string[], sweeps: string[]}>,
 *   opaque: Array<{file: string, line: number, arg: string}>
 * }} Paths repo-relative, sorted
 */
function triage(ctx) {
  const root = ctx.root;
  const rel = (abs) => path.relative(root, abs) || '.';
  const graph = graphLib.buildGraph(ctx.tests, ctx.graphIo);
  const lift = path.join(root, 'test', 'helpers', 'lift.js');
  const found = new Map();
  const readBy = new Map();
  const opaque = [];
  for (const t of ctx.tests) {
    const scan = graph.get(t);
    if (!scan) continue;
    const r = readsOf(scan, ctx.graphIo);
    found.set(t, r);
    readBy.set(t, new Set(r.files.map((f) => f.path)));
    for (const o of r.opaque) opaque.push({ file: rel(t), line: o.line, arg: o.arg });
  }
  const loads = runtimeLoads(graph, ctx.tests, readBy, root);
  const readers = [];
  for (const t of ctx.tests) {
    const r = found.get(t);
    if (!r) continue;
    const lifts = graph.get(t).requires.some((q) => q.resolved === lift);
    if (!lifts && r.files.length === 0 && r.sweeps.length === 0) continue;
    const js = r.files.map((f) => f.path).filter((p) => isCode(p, root));
    const cls = lifts ? 'lift' : js.length > 0 ? 'regex' : 'guard';
    let proof = null;
    const unloaded = js.filter((p) => !loads.all.has(p));
    if (cls === 'regex') {
      const own = loads.byTest.get(t);
      proof = unloaded.length > 0 ? 'none' : js.every((p) => own.has(p)) ? 'self' : 'other';
    }
    readers.push({
      file: rel(t),
      tier: ctx.tierOf ? ctx.tierOf.get(rel(t)) || null : null,
      cls,
      proof,
      reads: r.files.map((f) => rel(f.path)),
      unloaded: cls === 'regex' ? unloaded.map(rel) : [],
      sweeps: [...new Set(r.sweeps.map((s) => `${rel(s.dir)}/`))].sort()
    });
  }
  readers.sort((a, b) => (a.file < b.file ? -1 : 1));
  opaque.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return { readers, opaque };
}

/**
 * Print the report.
 *
 * @param {ReturnType<typeof triage>} result
 * @param {{write: function(string): any}} out
 */
function report(result, out) {
  const w = (s) => out.write(`${s}\n`);
  const { readers } = result;
  const of = (pred) => readers.filter(pred);
  const tierCounts = (list) => {
    const c = { small: 0, medium: 0, large: 0, unledgered: 0 };
    for (const r of list) c[r.tier || 'unledgered']++;
    return `small ${c.small}, medium ${c.medium}, large ${c.large}${c.unledgered ? `, not in the ledger ${c.unledgered}` : ''}`;
  };
  const opaqueFiles = new Set(result.opaque.map((o) => o.file)).size;
  w(`source-reader triage: ${readers.length} test file(s) read product source as text or lift it (${tierCounts(readers)}); ${result.opaque.length} read(s) in ${opaqueFiles} file(s) are opaque and not classified`);
  const what = (r) => [...r.reads, ...r.sweeps.map((s) => `${s} (sweep)`)].join(', ');
  const section = (title, list, line) => {
    w(`${title}: ${list.length} (${tierCounts(list)})`);
    for (const r of list) w(`  ${line(r)}`);
  };
  section('guard (asserts a property of the text no runtime test can; kept)', of((r) => r.cls === 'guard'), (r) => `${r.file}: ${what(r)}`);
  section('lift (runs a shipped browser function from its text; kept)', of((r) => r.cls === 'lift'), (r) => `${r.file}${r.reads.length || r.sweeps.length ? `: also reads ${what(r)}` : ''}`);
  const regex = of((r) => r.cls === 'regex');
  w(`regex-of-behaviour (reads a named product code file): ${regex.length} (${tierCounts(regex)})`);
  section('  self: the test also loads every file it reads (candidate: may duplicate its own runtime assertions)', of((r) => r.proof === 'self'), (r) => `  ${r.file}: ${what(r)}`);
  section('  other: another test loads every file it reads (candidate: may duplicate a runtime test)', of((r) => r.proof === 'other'), (r) => `  ${r.file}: ${what(r)}`);
  section('  none: no test loads a file it reads (candidate for a runtime test)', of((r) => r.proof === 'none'), (r) => `  ${r.file}: ${what(r)} [unloaded: ${r.unloaded.join(', ')}]`);
  w(`opaque reads (a path this audit cannot resolve, mostly temporary files and fixtures; not classified): ${result.opaque.length} in ${opaqueFiles} file(s)`);
  const byFile = new Map();
  for (const o of result.opaque) { if (!byFile.has(o.file)) byFile.set(o.file, []); byFile.get(o.file).push(o.line); }
  for (const [file, lines] of byFile) w(`  ${file}: ${lines.length} (line ${lines.join(', ')})`);
}

/**
 * The command line.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {{stdout?: {write: function(string): any}, root?: string, graphIo?: object, tests?: string[], ledger?: object}} [io] - Injection seam
 * @returns {number} 0 on a report, 1 on a usage error
 */
function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  if (argv.length > 0) { out.write('usage: audit-source-readers.js\n'); return 1; }
  const root = io.root || ROOT;
  const graphIo = io.graphIo || { ...graphLib.FS_IO, root };
  const tests = io.tests || tiers.suiteFiles().map((f) => path.join(root, f));
  const ledger = io.ledger || tiers.loadLedger();
  const tierOf = new Map();
  for (const t of tiers.TIERS) for (const f of ledger[t]) tierOf.set(f, t);
  report(triage({ root, tests, graphIo, tierOf }), out);
  return 0;
}

module.exports = { SOURCE_ROOTS, FS_MODULES, isSource, isCode, receiverOf, normalizePathCall, readsOf, runtimeLoads, triage, report, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
