'use strict';

/**
 * The require graph of this repository, read from text (#2498 W4-04).
 *
 * One walker for two tools: `scripts/test-touched.js` asks which test files
 * reach a changed file, and `scripts/audit-dead-exports.js` asks which exports
 * of `lib/` nothing reads. Both are text readers with no dependency, so what
 * they can and cannot see is said here once.
 *
 * A file's edges are read from its code, with strings and comments masked
 * first (a shell snippet inside a template string is not a `require`):
 *
 *   - `require('./x')` is resolved the way node resolves a relative request:
 *     `x`, `x.js`, `x/index.js`, `x.json`. A bare specifier (`node:fs`,
 *     `path`) is not an edge.
 *   - `require(path.join(ROOT, 'lib', 'x'))`, where `ROOT` is a constant this
 *     file defines as `path.join(__dirname, …)` or `path.resolve(__dirname,
 *     …)` with literal segments, is resolved the same way: every segment is
 *     a literal, so the request is one. That is how this repository's scripts
 *     load `lib/`.
 *   - a `require` whose argument is anything else is DYNAMIC. It is reported
 *     with the directory its literal prefix names when it has one (a template
 *     `../lib/wrap-steps/${kind}` names `lib/wrap-steps/`), and with no bound
 *     at all otherwise. The selector escalates on these rather than guess.
 *   - a product path NAMED in the text is a dependency on it, require or not:
 *     `path.join(__dirname, '..', 'lib', 'x.js')` in a test that reads the
 *     source, `path.join(REPO, 'scripts', 'x.js')` in one that spawns it, and
 *     a plain `'scripts/x.js'` literal that exists on disk. A join whose last
 *     segments are built at run time names the directory its literal
 *     segments reach, and the dependency is on everything under it. A read
 *     whose path carries no literal segment at all is OPAQUE: counted and
 *     reported, and beyond this walker's sight.
 *
 * Exports are read from `module.exports = { … }` (shorthand, `name: value`,
 * and `…spread`, which makes the module OPAQUE because its names come from
 * elsewhere), `module.exports = value` (one unnamed export) and
 * `module.exports.x =` / `exports.x =`. What a reader uses of a module is read
 * from the shape of its require: `const { a, b: c } = require(…)` reads
 * `a` and `b`; `const m = require(…)` followed by `m.a` reads `a`, and any
 * other use of `m` (passed whole, spread, indexed) reads everything;
 * `require(…).a` reads `a`; `require(…)` anywhere else reads everything.
 *
 * Every function takes an `io` seam (`readFile`, `isFile`, `isDir`) so the
 * tests prove the walker on an in-memory tree without touching this one.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** The directories a bare path literal may name, from the repository root. */
const PRODUCT_DIRS = Object.freeze(['server.js', 'lib', 'scripts', 'bin', 'public', 'data', 'hooks', 'docs', 'test']);

/** A bare path literal: a product directory, then `/` segments of file-name characters. */
const BARE_PATH = /^(?:server\.js|lib|scripts|bin|public|data|hooks|docs|test)(?:\/[\w.@-]+)*$/;

/** The default io: this file system. */
const FS_IO = Object.freeze({
  readFile: (f) => fs.readFileSync(f, 'utf8'),
  isFile: (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } },
  isDir: (f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } }
});

/**
 * The same text with every string body, template body, comment and regex
 * literal replaced by spaces, so that `require(` and `path.join(` are found
 * only in code and braces are balanced by code alone. Quote characters and
 * the backticks stay, so a literal's extent is still visible; its contents
 * are read from the original text at the same offsets.
 *
 * @param {string} text - A JavaScript source
 * @returns {string} The masked text, the same length
 */
function mask(text) {
  const out = text.split('');
  let i = 0;
  let lastCode = ''; // the last non-space character of code, for the regex heuristic
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  const skipString = (quote) => {
    const start = i + 1;
    i++;
    while (i < text.length && text[i] !== quote && text[i] !== '\n') {
      if (text[i] === '\\') i++;
      i++;
    }
    blank(start, i);
    i++;
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '\'' || c === '"') {
      skipString(c);
      lastCode = c;
    } else if (c === '`') {
      // A template body is blanked whole, `${…}` included: an expression
      // inside one is not a require this walker reads.
      const start = i + 1;
      i++;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') i++;
        i++;
      }
      blank(start, i);
      i++;
      lastCode = '`';
    } else if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]/.test(lastCode || '(') && !/[\w$)\]]/.test(lastCode)) {
      // A regex literal: `/` where an operand is expected. Its body is blanked.
      const start = i + 1;
      i++;
      let inClass = false;
      while (i < text.length && text[i] !== '\n' && (inClass || text[i] !== '/')) {
        if (text[i] === '\\') i++;
        else if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        i++;
      }
      blank(start, i);
      i++;
      lastCode = '/';
    } else {
      if (!/\s/.test(c)) lastCode = c;
      i++;
    }
  }
  return out.join('');
}

/**
 * Split the arguments of a call whose opening parenthesis is at `open`.
 *
 * @param {string} masked - The masked text (strings blanked, so commas inside them do not split)
 * @param {string} text - The original text, which the pieces are cut from
 * @param {number} open - Index of `(`
 * @returns {{args: string[], end: number}} Each argument trimmed, and the index of the closing `)`
 */
function splitArgs(masked, text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  let i = open;
  for (; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) break;
    } else if (c === ',' && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start, i).trim();
  if (last !== '' || args.length > 0) args.push(last);
  return { args, end: i };
}

/**
 * The string a literal argument carries, or null when it is not one.
 *
 * @param {string} arg - One argument's source text
 * @returns {string|null}
 */
function literalOf(arg) {
  const m = /^(['"])((?:\\.|(?!\1).)*)\1$/s.exec(arg);
  return m ? m[2] : null;
}

/**
 * The offsets at which each line starts, for `lineOf`.
 *
 * @param {string} text - The source
 * @returns {number[]} `starts[k]` is the offset of line `k + 1`
 */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/**
 * The line number of an offset, 1-based, by binary search over the line
 * starts (a scan asks this for every call site of every file).
 *
 * @param {number[]} starts - From `lineStarts`
 * @param {number} offset - A character index
 * @returns {number}
 */
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * The constants a file defines as a path under `__dirname` with literal
 * segments, each resolved to an absolute path. A constant defined from
 * another such constant (`const LIB = path.join(ROOT, 'lib')`) resolves too.
 *
 * @param {string} text - The original source
 * @param {string} masked - Its mask
 * @param {string} file - The file's absolute path
 * @returns {Map<string, string>} identifier → absolute path
 */
function rootConstants(text, masked, file) {
  const dir = path.dirname(file);
  const found = new Map([['__dirname', dir]]);
  const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.(?:join|resolve)\(/g;
  const decls = [];
  let m;
  while ((m = decl.exec(masked)) !== null) decls.push({ name: m[1], open: m.index + m[0].length - 1 });
  for (let pass = 0; pass < 3; pass++) {
    for (const d of decls) {
      if (found.has(d.name)) continue;
      const { args } = splitArgs(masked, text, d.open);
      if (args.length === 0 || !found.has(args[0])) continue;
      const rest = args.slice(1).map(literalOf);
      if (rest.some((s) => s === null)) continue;
      found.set(d.name, path.resolve(found.get(args[0]), ...rest));
    }
  }
  found.delete('__dirname');
  return found;
}

/**
 * Resolve a `path.join(...)` / `path.resolve(...)` argument list against the
 * constants a file knows: every segment literal gives a path; a run-time
 * segment after literal ones gives the directory the literals reach.
 *
 * @param {string[]} args - The call's arguments, as source text
 * @param {Map<string, string>} roots - From `rootConstants`, plus `__dirname`
 * @returns {{resolved: string, bounded: boolean}|null} The path (a directory when `bounded` is false), or null when the first argument is unknown
 */
function resolveJoin(args, roots) {
  if (args.length === 0 || !roots.has(args[0])) return null;
  const segments = [];
  let bounded = true;
  for (const arg of args.slice(1)) {
    const lit = literalOf(arg);
    if (lit === null) { bounded = false; break; }
    segments.push(lit);
  }
  return { resolved: path.resolve(roots.get(args[0]), ...segments), bounded };
}

/**
 * Resolve a request to a file the way node would, from a directory.
 *
 * @param {string} base - The absolute path the request names before extensions
 * @param {{isFile: function(string): boolean}} io
 * @returns {string|null}
 */
function resolveFile(base, io) {
  for (const c of [base, `${base}.js`, path.join(base, 'index.js'), `${base}.json`]) {
    if (io.isFile(c)) return c;
  }
  return null;
}

/**
 * Read one file's edges and exports.
 *
 * @param {string} file - Absolute path
 * @param {{readFile: function(string): string, isFile: function(string): boolean, isDir: function(string): boolean, root?: string}} [io]
 *   `root` is the repository root bare path literals resolve against (this repository by default)
 * @returns {{
 *   file: string,
 *   requires: Array<{line: number, request: string, resolved: string|null, kind: 'literal'|'rooted'|'bare'|'dynamic', prefix: string|null}>,
 *   paths: Array<{line: number, resolved: string, bounded: boolean}>,
 *   opaqueReads: Array<{line: number}>,
 *   exports: {kind: 'none'|'names'|'value'|'opaque', names: string[]},
 *   text: string, masked: string
 * }}
 */
function scanFile(file, io = FS_IO) {
  const root = io.root || ROOT;
  const text = io.readFile(file);
  const masked = mask(text);
  const dir = path.dirname(file);
  const roots = rootConstants(text, masked, file);
  roots.set('__dirname', dir);
  const starts = lineStarts(text);
  const requires = [];
  const paths = [];
  const opaqueReads = [];
  const seenJoin = new Set();
  const spans = []; // [open, end] of every require and path call: literals inside are theirs

  const call = /(?<![\w$.])(require|path\.(?:join|resolve)|(?:fs\.|fsp\.|fs\.promises\.)?(?:readFileSync|readFile|statSync|existsSync|readdirSync))\s*\(/g;
  let m;
  while ((m = call.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const { args, end } = splitArgs(masked, text, open);
    const line = lineOf(starts, m.index);
    if (m[1] === 'require' || m[1].startsWith('path.')) spans.push([open, end]);
    if (m[1] === 'require') {
      if (args.length !== 1) continue;
      const binding = bindingOf(masked, m.index, end);
      const lit = literalOf(args[0]);
      if (lit !== null) {
        if (!/^\.\.?\//.test(lit) && !path.isAbsolute(lit)) {
          requires.push({ line, request: lit, resolved: null, kind: 'bare', prefix: null, binding });
        } else {
          const resolved = resolveFile(path.resolve(dir, lit), io);
          requires.push({ line, request: lit, resolved, kind: 'literal', prefix: resolved ? null : path.dirname(path.resolve(dir, lit)), binding });
        }
        continue;
      }
      const join = /^path\.(?:join|resolve)\(/.exec(args[0]);
      if (join) {
        const inner = splitArgs(mask(args[0]), args[0], join[0].length - 1);
        const r = resolveJoin(inner.args, roots);
        if (r && r.bounded) {
          const resolved = resolveFile(r.resolved, io);
          requires.push({ line, request: args[0], resolved, kind: 'rooted', prefix: resolved ? null : path.dirname(r.resolved), binding });
        } else {
          requires.push({ line, request: args[0], resolved: null, kind: 'dynamic', prefix: r ? r.resolved : null, binding });
        }
        continue;
      }
      const tpl = /^`([^`$]*)\$\{/.exec(args[0]);
      if (tpl && /^\.\.?\//.test(tpl[1])) {
        requires.push({ line, request: args[0], resolved: null, kind: 'dynamic', prefix: path.resolve(dir, tpl[1]), binding });
        continue;
      }
      requires.push({ line, request: args[0], resolved: null, kind: 'dynamic', prefix: null, binding });
    } else if (m[1].startsWith('path.')) {
      const r = resolveJoin(args, roots);
      if (!r) continue;
      // A path that resolves to the root or above it is the definition of a
      // root constant, not a dependency on the whole repository.
      if (!r.resolved.startsWith(root + path.sep)) continue;
      const key = `${r.resolved}|${r.bounded}`;
      if (seenJoin.has(key)) continue;
      seenJoin.add(key);
      if (r.bounded) {
        const resolved = resolveFile(r.resolved, io) || (io.isDir(r.resolved) ? r.resolved : null);
        if (resolved) paths.push({ line, resolved, bounded: !io.isDir(resolved) });
      } else if (io.isDir(r.resolved)) {
        paths.push({ line, resolved: r.resolved, bounded: false });
      }
    } else {
      // A file-system read whose first argument is neither a literal nor a
      // join this walker could read is opaque.
      if (args.length === 0) continue;
      const a = args[0];
      if (literalOf(a) !== null || /^path\.(?:join|resolve)\(/.test(a) || roots.has(a)) continue;
      opaqueReads.push({ line });
    }
  }

  // Bare path literals that exist on disk: `'scripts/x.js'` in a spawn. A
  // literal inside a require or path call was read above as that call's
  // segment, and a single word (`'lib'`, `'data'`) names a directory too
  // ambiguously to count: `server.js` is the one single-segment file.
  const str = /(['"])((?:\\.|(?!\1).)*)\1/g;
  while ((m = str.exec(text)) !== null) {
    if (masked[m.index] !== m[1]) continue; // a quote inside a comment or another literal
    if (spans.some(([a, b]) => m.index > a && m.index < b)) continue;
    const lit = m[2];
    if (!BARE_PATH.test(lit) || (!lit.includes('/') && lit !== 'server.js')) continue;
    const abs = path.join(root, lit);
    const bounded = io.isFile(abs) ? true : io.isDir(abs) ? false : null;
    if (bounded === null) continue;
    const key = `${abs}|${bounded}`;
    if (seenJoin.has(key)) continue;
    seenJoin.add(key);
    paths.push({ line: lineOf(starts, m.index), resolved: abs, bounded });
  }

  return { file, requires, paths, opaqueReads, exports: readExports(masked), masked, memberUses: new Map() };
}

/**
 * The shape of the binding a `require(...)` call sits in, read from the
 * code around it: what the reader can use of the module.
 *
 * @param {string} masked - The masked source
 * @param {number} at - Offset of `require`
 * @param {number} end - Offset of the call's closing `)`
 * @returns {{kind: 'inline'|'destructure'|'namespace'|'whole', names: string[], id: string|null}}
 *   `inline` is `require(…).name`; `destructure` is `const { … } = require(…)` with its names
 *   (a `...rest` makes it `whole`); `namespace` is `const id = require(…)`; `whole` is any other use
 */
function bindingOf(masked, at, end) {
  const after = masked.slice(end + 1, end + 80);
  const inline = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(after);
  if (inline) return { kind: 'inline', names: [inline[1]], id: null };
  const before = masked.slice(Math.max(0, at - 400), at);
  const destructure = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*$/.exec(before);
  if (destructure) {
    const names = [];
    for (const part of destructure[1].split(',')) {
      if (part.trim() === '') continue;
      if (part.trim().startsWith('...')) return { kind: 'whole', names: [], id: null };
      const key = /^\s*([A-Za-z_$][\w$]*)/.exec(part);
      if (key) names.push(key[1]);
    }
    return { kind: 'destructure', names, id: null };
  }
  const namespace = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before);
  if (namespace) return { kind: 'namespace', names: [], id: namespace[1] };
  return { kind: 'whole', names: [], id: null };
}

/**
 * The member names a file reads off one identifier (`id.name`), or `all`
 * when the identifier is used any other way: passed whole, spread, indexed.
 * Cached on the scan, because the audit asks this once per module a reader
 * requires.
 *
 * @param {{masked: string, memberUses: Map<string, {all: boolean, names: Set<string>}>}} scan - A scanned file
 * @param {string} id - The identifier a `require` was bound to
 * @returns {{all: boolean, names: Set<string>}}
 */
function memberUsesOf(scan, id) {
  if (scan.memberUses.has(id)) return scan.memberUses.get(id);
  const names = new Set();
  let all = false;
  const decl = new RegExp(`(?:const|let|var)\\s+${id.replace(/\$/g, '\\$')}\\s*=`);
  const use = new RegExp(`(?<![\\w$.])${id.replace(/\$/g, '\\$')}(?![\\w$])\\s*(\\??\\.\\s*([A-Za-z_$][\\w$]*))?`, 'g');
  let u;
  while ((u = use.exec(scan.masked)) !== null) {
    if (decl.test(scan.masked.slice(Math.max(0, u.index - 8), u.index + u[0].length + 2))) continue; // the declaration
    if (u[2]) names.add(u[2]);
    else all = true;
  }
  const result = { all, names };
  scan.memberUses.set(id, result);
  return result;
}

/**
 * The names a file exports.
 *
 * @param {string} masked - The masked source (names are identifiers, which the mask keeps)
 * @returns {{kind: 'none'|'names'|'value'|'opaque', names: string[]}}
 */
function readExports(masked) {
  const names = new Set();
  let kind = 'none';
  const assign = /(?<![\w$.])module\.exports\s*=\s*/g;
  let m;
  while ((m = assign.exec(masked)) !== null) {
    const at = m.index + m[0].length;
    if (masked[at] !== '{') {
      kind = kind === 'none' ? 'value' : kind;
      continue;
    }
    const { args, end } = splitArgs(masked, masked, at);
    if (end === masked.length) return { kind: 'opaque', names: [] };
    if (kind === 'none' || kind === 'value') kind = 'names';
    for (const entry of args) {
      if (entry === '') continue;
      if (entry.startsWith('...') || entry.startsWith('[')) return { kind: 'opaque', names: [] };
      const key = /^(?:async\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*)/.exec(entry);
      if (!key) return { kind: 'opaque', names: [] };
      names.add(key[1]);
    }
  }
  const member = /(?<![\w$.])(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=[^=]/g;
  while ((m = member.exec(masked)) !== null) {
    names.add(m[1]);
    if (kind === 'none') kind = 'names';
  }
  return { kind, names: [...names] };
}

/**
 * What a reader uses of one module it requires: the names it reads, or
 * `all` when it uses the module whole.
 *
 * @param {ReturnType<typeof scanFile>} reader - A scanned file
 * @param {string} target - The required module's absolute path
 * @returns {{all: boolean, names: Set<string>}}
 */
function usesOf(reader, target) {
  const names = new Set();
  let all = false;
  for (const r of reader.requires) {
    if (r.resolved !== target) continue;
    const b = r.binding;
    if (b.kind === 'whole') all = true;
    else if (b.kind === 'namespace') {
      const u = memberUsesOf(reader, b.id);
      if (u.all) all = true;
      for (const n of u.names) names.add(n);
    } else for (const n of b.names) names.add(n);
  }
  return { all, names };
}

/**
 * Scan every file reachable from the roots through resolved requires, once
 * each.
 *
 * @param {string[]} roots - Absolute paths
 * @param {object} [io] - The seam `scanFile` takes
 * @returns {Map<string, ReturnType<typeof scanFile>>} absolute path → scan
 */
function buildGraph(roots, io = FS_IO) {
  const graph = new Map();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift();
    if (graph.has(file) || !io.isFile(file)) continue;
    const scan = scanFile(file, io);
    graph.set(file, scan);
    for (const r of scan.requires) if (r.resolved && !graph.has(r.resolved)) queue.push(r.resolved);
  }
  return graph;
}

/**
 * Everything one root reaches: the files on its require closure, the files
 * and directories any of them names, the dynamic requires on the way (each
 * with its bound, or none), and the opaque reads.
 *
 * @param {string} root - Absolute path of a file in the graph
 * @param {Map<string, ReturnType<typeof scanFile>>} graph - From `buildGraph`
 * @returns {{files: Set<string>, dirs: Set<string>, dynamic: Array<{from: string, line: number, request: string, prefix: string|null}>, opaque: Array<{from: string, line: number}>}}
 */
function reachOf(root, graph) {
  const files = new Set();
  const dirs = new Set();
  const dynamic = [];
  const opaque = [];
  const stack = [root];
  while (stack.length > 0) {
    const f = stack.pop();
    if (files.has(f)) continue;
    files.add(f);
    const scan = graph.get(f);
    if (!scan) continue;
    for (const r of scan.requires) {
      if (r.resolved) stack.push(r.resolved);
      else if (r.kind === 'dynamic' || (r.kind !== 'bare' && !r.resolved)) dynamic.push({ from: f, line: r.line, request: r.request, prefix: r.prefix });
    }
    for (const p of scan.paths) {
      if (p.bounded) { files.add(p.resolved); if (graph.has(p.resolved)) stack.push(p.resolved); } else dirs.add(p.resolved);
    }
    for (const o of scan.opaqueReads) opaque.push({ from: f, line: o.line });
  }
  return { files, dirs, dynamic, opaque };
}

/**
 * Whether a reach covers a file: named directly, or under a directory it names.
 *
 * @param {{files: Set<string>, dirs: Set<string>}} reach - From `reachOf`
 * @param {string} file - Absolute path
 * @returns {boolean}
 */
function reaches(reach, file) {
  if (reach.files.has(file)) return true;
  for (const d of reach.dirs) if (file.startsWith(d + path.sep)) return true;
  return false;
}

module.exports = {
  ROOT, PRODUCT_DIRS, FS_IO, mask, splitArgs, literalOf, lineStarts, lineOf, rootConstants, resolveJoin, resolveFile,
  scanFile, bindingOf, memberUsesOf, readExports, usesOf, buildGraph, reachOf, reaches
};
