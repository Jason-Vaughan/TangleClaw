'use strict';

/**
 * `scripts/audit-dead-exports.js`: which exports of `lib/` nothing reads, and
 * the ratchet Stage 1 runs (#2498 W4-04).
 *
 * Pinned on an in-memory tree: an export read by the product is alive; one
 * read only by tests is test-only, and the test that alone reads it is an
 * orphan candidate; one read by nothing is dead; a namespace used whole
 * reads everything; a module reached by no root is still audited when it is
 * under `lib/`; an opaque module and an unbounded dynamic require are
 * uncertainties; a bounded dynamic require shadows the modules under its
 * prefix. The comparator is red on a new dead export, a stale entry, a
 * missing, malformed, duplicated or unsorted baseline, and on uncertainty,
 * each named, and green with the counts otherwise. The baseline is written
 * sorted and unique.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audit = require('../scripts/audit-dead-exports');

const ROOT = path.resolve('/virtual');

/**
 * An in-memory repository for the audit.
 *
 * @param {Object<string, string>} files
 * @returns {{root: string, roots: string[], graphIo: object}}
 */
function repo(files) {
  const abs = new Map(Object.entries(files).map(([r, t]) => [path.join(ROOT, r), t]));
  const dirs = new Set([ROOT]);
  for (const f of abs.keys()) { let d = path.dirname(f); while (d !== ROOT) { dirs.add(d); d = path.dirname(d); } }
  const graphIo = { root: ROOT, readFile: (f) => abs.get(f), isFile: (f) => abs.has(f), isDir: (f) => dirs.has(f) };
  const roots = [...abs.keys()].filter((f) => /\/(server\.js|scripts\/[^/]+\.js|test\/[^/]+\.test\.js|bin\/[^/]+|lib\/.+\.js)$/.test(f)).sort();
  return { root: ROOT, roots, graphIo };
}

const FILES = {
  'server.js': "const a = require('./lib/a');\na.alive();",
  'lib/a.js': 'module.exports = { alive, testOnly, dead, sharedTestOnly };',
  'lib/b.js': "const a = require('./a');\nmodule.exports = { wholeUse: a.alive, bee };",
  'lib/unrooted.js': 'module.exports = { nobody };',
  'scripts/s.js': "const b = require('../lib/b'); run(b);",
  'test/a.test.js': "const { testOnly, sharedTestOnly } = require('../lib/a');",
  'test/a2.test.js': "const a = require('../lib/a'); a.sharedTestOnly();",
  'bin/tc': "require('../lib/unrooted');"
};

/** A stdout sink. */
function sink() {
  let text = '';
  return { write: (s) => { text += s; return true; }, text: () => text };
}

describe('audit', () => {
  it('classifies every export: alive, test-only with its readers, dead; a namespace used whole reads everything', () => {
    const r = audit.audit(repo(FILES));
    assert.deepEqual([r.modules, r.names, r.opaque, r.shadowed, r.unbounded], [3, 7, [], [], []]);
    assert.deepEqual(r.dead, [{ file: 'lib/a.js', name: 'dead' }]);
    assert.deepEqual(r.testOnly, [
      { file: 'lib/a.js', name: 'sharedTestOnly', readers: ['test/a.test.js', 'test/a2.test.js'] },
      { file: 'lib/a.js', name: 'testOnly', readers: ['test/a.test.js'] }
    ]);
    assert.deepEqual(audit.orphanCandidates(r), [{ test: 'test/a.test.js', exports: ['lib/a.js:testOnly'] }]);
  });

  it('a lib module under a bin root with a bare side-effect require is read whole, so nothing of it is dead', () => {
    const r = audit.audit(repo(FILES));
    assert.equal(r.dead.some((e) => e.file === 'lib/unrooted.js'), false);
  });

  it('a lib module no entry point reaches is still audited, and every export of it is dead', () => {
    const r = audit.audit(repo({ ...FILES, 'lib/island.js': 'module.exports = { x };' }));
    assert.equal(r.modules, 4);
    assert.ok(r.dead.some((e) => e.file === 'lib/island.js' && e.name === 'x'));
  });

  it('an opaque module and an unbounded dynamic require are uncertainties; a bounded one shadows its directory', () => {
    const r = audit.audit(repo({
      ...FILES,
      'lib/o.js': "module.exports = { ...require('./a') };",
      'lib/steps/one.js': 'module.exports = { one };',
      'scripts/d.js': "const k = 'one'; require(`../lib/steps/${k}`); require('../lib/o');",
      'scripts/u.js': 'require(process.argv[2]);'
    }));
    assert.deepEqual(r.opaque, ['lib/o.js']);
    assert.deepEqual(r.unbounded, ['scripts/u.js:1 process.argv[2]']);
    assert.deepEqual(r.shadowed, ['lib/steps/one.js (by scripts/d.js:1 `../lib/steps/${k}`)']);
    assert.equal(r.dead.some((e) => e.file === 'lib/steps/one.js'), false, 'a shadowed module is never called dead');
  });

  it('report prints the counts, the dead list, the test-only readers and the orphan candidates', () => {
    const out = sink();
    audit.report(audit.audit(repo(FILES)), out);
    assert.match(out.text(), /^dead-export audit: 3 lib\/ modules, 7 exported names audited, 0 opaque \(spread or computed exports\), 0 shadowed by a dynamic require, 0 unbounded dynamic require\(s\)$/m);
    assert.match(out.text(), /^dead \(no reader at all, tests included\): 1\n {2}lib\/a\.js:dead$/m);
    assert.match(out.text(), /^test-only \(read by tests and by nothing in the product\): 2\n {2}lib\/a\.js:sharedTestOnly <- test\/a\.test\.js, test\/a2\.test\.js\n {2}lib\/a\.js:testOnly <- test\/a\.test\.js$/m);
    assert.match(out.text(), /^orphan candidates \(a test that is the sole reader of a test-only export\): 1\n {2}test\/a\.test\.js: lib\/a\.js:testOnly$/m);
  });
});

describe('check: the ratchet', () => {
  const result = audit.audit(repo(FILES));
  const clean = (dead) => ({ ...result, dead, opaque: [], unbounded: [] });

  it('is green with the counts when the dead list equals the baseline', () => {
    assert.deepEqual(audit.check(result, { entries: ['lib/a.js:dead'], problems: [] }), { ok: true, output: 'dead exports: 1 in the baseline, 0 new, 0 stale' });
    const shadowed = { ...result, shadowed: ['lib/s.js (by x)'] };
    assert.match(audit.check(shadowed, { entries: ['lib/a.js:dead'], problems: [] }).output, /; 1 module\(s\) shadowed by a bounded dynamic require, not audited$/);
  });

  it('is red on a new dead export, naming it', () => {
    const r = audit.check(clean([{ file: 'lib/a.js', name: 'dead' }, { file: 'lib/b.js', name: 'bee' }]), { entries: ['lib/a.js:dead'], problems: [] });
    assert.equal(r.ok, false);
    assert.equal(r.output, 'new dead export (not in the baseline): lib/b.js:bee\ndead exports: 1 new, 0 stale, 0 baseline problem(s), 0 uncertainty(ies) against a baseline of 1');
  });

  it('is red on a stale entry, read now or gone', () => {
    const r = audit.check(clean([]), { entries: ['lib/a.js:dead', 'lib/zz.js:gone'], problems: [] });
    assert.equal(r.ok, false);
    assert.match(r.output, /^stale baseline entry \(read now, or gone\): lib\/a\.js:dead\nstale baseline entry \(read now, or gone\): lib\/zz\.js:gone\n/);
  });

  it('is red on graph uncertainty, naming the opaque module and the unbounded require', () => {
    const r = audit.check({ ...result, opaque: ['lib/o.js'], unbounded: ['scripts/u.js:1 k'] }, { entries: ['lib/a.js:dead'], problems: [] });
    assert.equal(r.ok, false);
    assert.match(r.output, /^graph uncertainty: lib\/o\.js exports by spread or computed key, so its names cannot be audited\ngraph uncertainty: a dynamic require with no literal prefix could read any module: scripts\/u\.js:1 k\n/);
    assert.match(r.output, /2 uncertainty\(ies\)/);
  });

  it('is red on a missing baseline, and reports no growth it cannot measure', () => {
    const r = audit.check(result, audit.readBaseline(path.join(os.tmpdir(), 'tc-no-such-baseline.json')));
    assert.equal(r.ok, false);
    assert.match(r.output, /^no baseline: tc-no-such-baseline\.json is missing/);
    assert.match(r.output, /0 new, 0 stale, 1 baseline problem\(s\)/);
  });

  it('readBaseline names a malformed file, a malformed entry, a duplicate and an unsorted list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dead-baseline-'));
    try {
      const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
      assert.match(audit.readBaseline(write('bad.json', '{')).problems[0], /^malformed baseline: /);
      assert.deepEqual(audit.readBaseline(write('shape.json', '{"dead": "x"}')).problems, ['malformed baseline: "dead" must be an array of "file:name" strings']);
      assert.deepEqual(audit.readBaseline(write('entry.json', '{"dead": ["lib/a.js:dead", "a.js:x", 3]}')).problems, [
        'malformed baseline entry (not "lib/<file>.js:<name>"): "a.js:x"', 'malformed baseline entry (not "lib/<file>.js:<name>"): 3'
      ]);
      assert.deepEqual(audit.readBaseline(write('dup.json', '{"dead": ["lib/a.js:dead", "lib/a.js:dead"]}')).problems, ['duplicate baseline entry: lib/a.js:dead']);
      assert.deepEqual(audit.readBaseline(write('order.json', '{"dead": ["lib/b.js:x", "lib/a.js:x"]}')).problems, ['baseline is not sorted']);
      const good = audit.readBaseline(write('good.json', '{"dead": ["lib/a.js:x", "lib/b.js:x"]}'));
      assert.deepEqual(good, { entries: ['lib/a.js:x', 'lib/b.js:x'], problems: [] });
      // Unreadable is not "malformed": a directory where the file should be propagates.
      assert.throws(() => audit.readBaseline(dir), /EISDIR/);
      const dup = audit.check(clean([{ file: 'lib/a.js', name: 'dead' }]), audit.readBaseline(write('dup2.json', '{"dead": ["lib/a.js:dead", "lib/a.js:dead"]}')));
      assert.equal(dup.ok, false);
      assert.match(dup.output, /^duplicate baseline entry: lib\/a\.js:dead\n/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formatBaseline writes the entries sorted and unique, under the comment', () => {
    const text = audit.formatBaseline(clean([{ file: 'lib/b.js', name: 'y' }, { file: 'lib/a.js', name: 'x' }]));
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed.dead, ['lib/a.js:x', 'lib/b.js:y']);
    assert.deepEqual(parsed._comment, audit.BASELINE_COMMENT);
    assert.ok(text.endsWith('\n'));
  });
});

describe('main', () => {
  it('runs the report, the check and the write through the seams, and refuses any other flag', () => {
    const ctx = repo(FILES);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dead-main-'));
    try {
      const baselinePath = path.join(dir, 'baseline.json');
      const seams = { root: ROOT, roots: ctx.roots, graphIo: ctx.graphIo, baselinePath };
      const w = sink();
      assert.equal(audit.main(['--write-baseline'], { ...seams, stdout: w }), 0);
      assert.equal(w.text(), `wrote ${baselinePath}: 1 dead export(s)\n`);
      const c = sink();
      assert.equal(audit.main(['--check'], { ...seams, stdout: c }), 0);
      assert.equal(c.text(), 'dead exports: 1 in the baseline, 0 new, 0 stale\n');
      const r = sink();
      assert.equal(audit.main([], { ...seams, stdout: r }), 0);
      assert.match(r.text(), /^dead-export audit: /);
      const u = sink();
      assert.equal(audit.main(['--fix'], { ...seams, stdout: u }), 1);
      assert.match(u.text(), /^usage: audit-dead-exports\.js/);
      fs.writeFileSync(baselinePath, '{"dead": []}');
      const red = sink();
      assert.equal(audit.main(['--check'], { ...seams, stdout: red }), 1);
      assert.match(red.text(), /^new dead export \(not in the baseline\): lib\/a\.js:dead$/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaultRoots reads a tree without an entry-point directory as having no roots there, and propagates any other failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dead-roots-'));
    try {
      fs.mkdirSync(path.join(dir, 'lib'));
      fs.writeFileSync(path.join(dir, 'lib', 'a.js'), '');
      const real = require('../scripts/_require-graph');
      assert.deepEqual(audit.defaultRoots(dir, real.FS_IO).map((f) => path.relative(dir, f)), ['lib/a.js'], 'no server.js, bin/, scripts/ or test/: only the lib module');
      fs.writeFileSync(path.join(dir, 'scripts'), 'a file where the directory should be');
      assert.throws(() => audit.defaultRoots(dir, real.FS_IO), /ENOTDIR/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the default roots are this repository\'s entry points: server.js, every bin/ command, scripts/*.js and test/*.test.js', () => {
    const real = require('../scripts/_require-graph');
    const roots = audit.defaultRoots(real.ROOT, real.FS_IO).map((f) => path.relative(real.ROOT, f));
    assert.ok(roots.includes('server.js'));
    for (const b of ['bin/tc', 'bin/tc-bridge-helper', 'bin/tc-bridge-receive']) assert.ok(roots.includes(b), b);
    assert.ok(roots.includes('scripts/audit-dead-exports.js'));
    assert.ok(roots.includes('test/audit-dead-exports.test.js'));
    assert.ok(roots.includes('lib/test-results.js') && roots.includes('lib/routes/_kernel.js'), 'every lib module, nested too, so none is silently absent');
    assert.equal(roots.some((r) => r.startsWith('hooks/')), false, 'hooks are shell and load no module');
  });
});
