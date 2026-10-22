'use strict';

/**
 * `scripts/_require-graph.js`: the text walker Stage 2 and the dead-export
 * audit stand on (#2498 W4-04).
 *
 * Pinned on an in-memory tree: a relative require resolves as node does
 * (`x`, `x.js`, `x/index.js`); a `require(path.join(ROOT, 'lib', 'x'))` with
 * a root constant resolves as a literal; a template require is dynamic and
 * bounded to its literal prefix; an opaque require is dynamic and unbounded;
 * a product path named in the text is a dependency, a run-time segment makes
 * it a directory, and a path built from nothing literal is an opaque read;
 * strings, comments and regex bodies hide no requires; exports read in each
 * shape; a reader's use of a module is read from its binding; and the reach
 * of a root closes over all of it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const g = require('../scripts/_require-graph');

const ROOT = path.resolve('/virtual');

/**
 * An in-memory tree: a map of repo-relative paths to text, and the
 * directories those paths imply.
 *
 * @param {Object<string, string>} files
 * @returns {object} The io seam `scanFile` takes
 */
function tree(files) {
  const abs = new Map(Object.entries(files).map(([rel, text]) => [path.join(ROOT, rel), text]));
  const dirs = new Set([ROOT]);
  for (const f of abs.keys()) { let d = path.dirname(f); while (d !== ROOT && d !== path.dirname(d)) { dirs.add(d); d = path.dirname(d); } }
  return {
    root: ROOT,
    readFile: (f) => { if (!abs.has(f)) throw new Error(`ENOENT ${f}`); return abs.get(f); },
    isFile: (f) => abs.has(f),
    isDir: (f) => dirs.has(f)
  };
}

const rel = (abs) => path.relative(ROOT, abs);

describe('mask', () => {
  it('blanks string bodies, template bodies, comments and regex bodies, keeping length and quotes', () => {
    const pieces = [
      ['const a = require("', ''], ['./x', 'blank'], ['"); ', ''], ['// require("./no")', 'blank'], ['\n', ''],
      ['/* require("./nor") */', 'blank'], [' const r = /', ''], ['require\\("\\/x"\\)', 'blank'], ['/; const t = `', ''],
      ['require("./t")', 'blank'], ['`; const d = 1 / 2;', '']
    ];
    const src = pieces.map(([p]) => p).join('');
    const expected = pieces.map(([p, how]) => (how === 'blank' ? ' '.repeat(p.length) : p)).join('');
    assert.equal(g.mask(src), expected);
  });
});

describe('scanFile: requires', () => {
  const io = tree({
    'lib/a.js': 'module.exports = { one, two };\n',
    'lib/b/index.js': 'module.exports = { three };\n',
    'lib/c.json': '{}',
    'scripts/s.js': "const path = require('node:path');\nconst REPO = path.resolve(__dirname, '..');\nconst LIB = path.join(REPO, 'lib');\nconst a = require(path.join(REPO, 'lib', 'a'));\nconst b = require(path.join(LIB, 'b'));\nconst c = require('./nope');\n",
    'test/t.test.js': "const a = require('../lib/a');\nconst b = require('../lib/b');\nconst j = require('../lib/c.json');\nconst fs = require('node:fs');\nconst k = 'x';\nconst d = require(`../lib/${k}`);\nconst e = require(k);\n"
  });

  it('resolves relative requires as node does, and a bare specifier is not an edge', () => {
    const s = g.scanFile(path.join(ROOT, 'test/t.test.js'), io);
    const by = Object.fromEntries(s.requires.map((r) => [r.request, r]));
    assert.equal(rel(by['../lib/a'].resolved), 'lib/a.js');
    assert.equal(rel(by['../lib/b'].resolved), 'lib/b/index.js');
    assert.equal(rel(by['../lib/c.json'].resolved), 'lib/c.json');
    assert.deepEqual([by['node:fs'].kind, by['node:fs'].resolved], ['bare', null]);
  });

  it('reads a template require as dynamic, bounded to its literal prefix, and an identifier as unbounded', () => {
    const s = g.scanFile(path.join(ROOT, 'test/t.test.js'), io);
    const dyn = s.requires.filter((r) => r.kind === 'dynamic');
    assert.equal(dyn.length, 2);
    assert.deepEqual([dyn[0].line, rel(dyn[0].prefix)], [6, 'lib']);
    assert.deepEqual([dyn[1].line, dyn[1].prefix], [7, null]);
  });

  it('resolves a rooted join through a root constant, one level or two, and names an unresolvable literal', () => {
    const s = g.scanFile(path.join(ROOT, 'scripts/s.js'), io);
    const rooted = s.requires.filter((r) => r.kind === 'rooted');
    assert.deepEqual(rooted.map((r) => rel(r.resolved)), ['lib/a.js', 'lib/b/index.js']);
    const nope = s.requires.find((r) => r.request === './nope');
    assert.deepEqual([nope.kind, nope.resolved, rel(nope.prefix)], ['literal', null, 'scripts']);
    assert.equal(s.requires.some((r) => r.kind === 'dynamic'), false, 'a join of literals is not dynamic');
  });

  it('does not read a require inside a string, a comment or a regex', () => {
    const io2 = tree({ 'lib/z.js': "const s = 'require(\"./a\")'; // require('./b')\n/* require('./c') */ const re = /require\\('.\\/d'\\)/;\nconst t = `node -e \"require(process.argv[1])\"`;\n", 'lib/a.js': '' });
    const s = g.scanFile(path.join(ROOT, 'lib/z.js'), io2);
    assert.deepEqual(s.requires, []);
  });
});

describe('scanFile: named paths and reads', () => {
  const io = tree({
    'lib/a.js': 'module.exports = { one };\n',
    'lib/q/r.js': '',
    'scripts/x.js': '',
    'public/p.js': '',
    'test/t.test.js': [
      "const fs = require('node:fs'); const path = require('node:path');",
      "const REPO = path.join(__dirname, '..');",
      "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.js'), 'utf8');",
      "const script = path.join(REPO, 'scripts', 'x.js');",
      "const some = fs.readFileSync(path.join(REPO, 'lib', 'q', name), 'utf8');",
      "const bare = spawn('node', ['scripts/x.js', 'lib/q']);",
      "const tmp = fs.readFileSync(file, 'utf8');",
      "const where = path.join(tmpDir, 'lib', 'a.js');",
      "const word = ['lib', 'data'];"
    ].join('\n')
  });

  it('names a file through __dirname, through a root constant, and as a bare literal; a run-time segment names the directory', () => {
    const s = g.scanFile(path.join(ROOT, 'test/t.test.js'), io);
    const seen = s.paths.map((p) => `${rel(p.resolved)}${p.bounded ? '' : '/'}`).sort();
    assert.deepEqual(seen, ['lib/a.js', 'lib/q/', 'scripts/x.js']);
  });

  it('counts a read whose path has nothing literal as opaque, and ignores a join from an unknown base', () => {
    const s = g.scanFile(path.join(ROOT, 'test/t.test.js'), io);
    assert.deepEqual(s.opaqueReads.map((o) => o.line), [7]);
    assert.equal(s.paths.some((p) => rel(p.resolved) === 'lib' && !p.bounded), false, "'lib' as a word, or under tmpDir, is not a dependency on lib/");
  });

  it('does not take the root constant itself, or anything above the root, as a dependency', () => {
    const io2 = tree({ 'test/t.test.js': "const REPO = path.join(__dirname, '..'); const UP = path.join(__dirname, '..', '..');\n" });
    assert.deepEqual(g.scanFile(path.join(ROOT, 'test/t.test.js'), io2).paths, []);
  });
});

describe('readExports', () => {
  const read = (src) => g.readExports(g.mask(src));

  it('reads an object literal, shorthand and renamed, across lines', () => {
    assert.deepEqual(read('function a() {}\nmodule.exports = {\n  a, b: _b,\n  c: () => 1, async d() {}\n};\n'), { kind: 'names', names: ['a', 'b', 'c', 'd'] });
  });

  it('reads member assignments, a single value, and nothing', () => {
    assert.deepEqual(read('exports.x = 1; module.exports.y = 2; const z = (a == b);'), { kind: 'names', names: ['x', 'y'] });
    assert.deepEqual(read('module.exports = function f() {};'), { kind: 'value', names: [] });
    assert.deepEqual(read('const a = 1;'), { kind: 'none', names: [] });
  });

  it('calls a spread or a computed key opaque, because the names come from elsewhere', () => {
    assert.equal(read("module.exports = { ...require('./a'), b };").kind, 'opaque');
    assert.equal(read("module.exports = { ['x' + 1]: 1 };").kind, 'opaque');
  });

  it('is not fooled by a brace inside a string in the object', () => {
    assert.deepEqual(read("module.exports = { a: '}', b };"), { kind: 'names', names: ['a', 'b'] });
  });
});

describe('usesOf: what a reader reads of a module', () => {
  const target = path.join(ROOT, 'lib/m.js');
  const uses = (src) => { const io = tree({ 'lib/m.js': 'module.exports = { a, b, c };', 'test/r.test.js': src }); return g.usesOf(g.scanFile(path.join(ROOT, 'test/r.test.js'), io), target); };

  it('destructuring reads the names it binds', () => {
    const u = uses("const { a, b: bee } = require('../lib/m');\nbee();");
    assert.deepEqual([u.all, [...u.names].sort()], [false, ['a', 'b']]);
  });

  it('a namespace binding reads the members it is followed by, and the whole module when used any other way', () => {
    const u = uses("const m = require('../lib/m');\nm.a(); m?.b;\nconst x = m.c.d;");
    assert.deepEqual([u.all, [...u.names].sort()], [false, ['a', 'b', 'c']]);
    const whole = uses("const m = require('../lib/m');\nm.a(); run(m);");
    assert.equal(whole.all, true);
    const keys = uses("const m = require('../lib/m');\nObject.keys(m);");
    assert.equal(keys.all, true);
  });

  it('an inline member reads that name; a bare require, a spread rest, or a require in an expression reads everything', () => {
    assert.deepEqual([...uses("require('../lib/m').a();").names], ['a']);
    assert.equal(uses("require('../lib/m');").all, true);
    assert.equal(uses("const { a, ...rest } = require('../lib/m');").all, true);
    assert.equal(uses("f(require('../lib/m'));").all, true);
  });

  it('reads nothing of a module the reader does not require', () => {
    const u = uses("const o = require('../lib/other'); o.a();");
    assert.deepEqual([u.all, u.names.size], [false, 0]);
  });
});

describe('buildGraph and reachOf', () => {
  const io = tree({
    'lib/a.js': "const b = require('./b');\nmodule.exports = { a: () => b.b() };",
    'lib/b.js': 'module.exports = { b: () => 1 };',
    'lib/c.js': 'module.exports = { c: 1 };',
    'lib/w/one.js': 'module.exports = { one: 1 };',
    'scripts/x.js': '',
    'test/t.test.js': "const a = require('../lib/a');\nconst src = require('node:fs').readFileSync(path.join(__dirname, '..', 'scripts', 'x.js'), 'utf8');\nconst k = 'one'; const w = require(`../lib/w/${k}`);\nconst any = require(k);\n"
  });

  it('closes over requires and named paths, and carries the dynamic requires on the way', () => {
    const root = path.join(ROOT, 'test/t.test.js');
    const graph = g.buildGraph([root], io);
    assert.deepEqual([...graph.keys()].map(rel).sort(), ['lib/a.js', 'lib/b.js', 'test/t.test.js']);
    const r = g.reachOf(root, graph);
    assert.deepEqual([...r.files].map(rel).sort(), ['lib/a.js', 'lib/b.js', 'scripts/x.js', 'test/t.test.js']);
    assert.equal(g.reaches(r, path.join(ROOT, 'lib/b.js')), true);
    assert.equal(g.reaches(r, path.join(ROOT, 'lib/c.js')), false);
    assert.deepEqual(r.dynamic.map((d) => [d.line, d.prefix && rel(d.prefix)]), [[3, 'lib/w'], [4, null]]);
  });

  it('reaches a file under a directory the text names', () => {
    const io2 = tree({ 'lib/w/one.js': '', 'test/t.test.js': "const f = path.join(__dirname, '..', 'lib', 'w', name);" });
    const root = path.join(ROOT, 'test/t.test.js');
    const r = g.reachOf(root, g.buildGraph([root], io2));
    assert.deepEqual([...r.dirs].map(rel), ['lib/w']);
    assert.equal(g.reaches(r, path.join(ROOT, 'lib/w/one.js')), true);
    assert.equal(g.reaches(r, path.join(ROOT, 'lib/wx.js')), false, 'a directory bound is the directory, not a prefix of its name');
  });
});
