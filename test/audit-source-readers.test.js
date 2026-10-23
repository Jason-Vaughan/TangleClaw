'use strict';

/**
 * `scripts/audit-source-readers.js`: which tests read product source as
 * text, in which class, and with what runtime proof (#2498 W4-05).
 *
 * Pinned on an in-memory tree, one test file per case: a read by literal,
 * by a joined root constant and by a constant naming a file; a read on a
 * renamed `node:fs` binding, on `node:fs/promises`, on an inline
 * `require('node:fs')` of an inline `require('node:path').join`, and of a
 * `require.resolve`; a helper reading a directory by a literal file name,
 * and by names built at run time (a sweep); a read from the root that names
 * no source (not a source read); a read whose path is a variable, and one on
 * a receiver that is not the file system (both opaque, never classified); a
 * read inside a comment (not a read). Classes: LIFT for a lift-helper user, REGEX for a
 * named code file (`.js`, or a `bin/` command), GUARD otherwise. Runtime
 * proof: SELF when the test loads what it reads (through a script it spawns
 * too), OTHER when another test does, NONE when no test does, and `public/`
 * is never counted as loaded.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const audit = require('../scripts/audit-source-readers');

const ROOT = path.resolve('/virtual');

const HEAD = "const fs = require('node:fs');\nconst path = require('node:path');\n";

const FILES = {
  'lib/a.js': 'module.exports = { a: 1 };',
  'lib/b.js': 'module.exports = { b: 1 };',
  'lib/c.js': 'module.exports = { c: 1 };',
  'public/app.js': 'function esc() {}',
  'public/style.css': '.x { color: red; }',
  'scripts/s.js': "require('../lib/b');",
  'bin/tc': "#!/usr/bin/env node\nrequire('../lib/c');",
  'docs/x.md': '# x',
  'test/helpers/lift.js': 'module.exports = {};',
  'test/self.test.js': `${HEAD}require('../lib/a');\nconst src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.js'), 'utf8');`,
  'test/other.test.js': `${HEAD}const ROOT = path.join(__dirname, '..');\nconst A = path.join(ROOT, 'lib', 'a.js');\nfs.readFileSync(A, 'utf8');`,
  'test/none.test.js': `${HEAD}const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');\npub('app.js');`,
  'test/css.test.js': `${HEAD}fs.readFileSync('public/style.css', 'utf8');`,
  'test/sweep.test.js': `${HEAD}const LIB = path.join(__dirname, '..', 'lib');\nfor (const f of fs.readdirSync(LIB)) fs.readFileSync(path.join(LIB, f), 'utf8');`,
  'test/lift.test.js': `${HEAD}const { liftFunction } = require('./helpers/lift');\nliftFunction('app.js', 'function esc(');`,
  'test/spawn.test.js': `${HEAD}const { spawnSync } = require('node:child_process');\nconst ROOT = path.join(__dirname, '..');\nspawnSync(process.execPath, [path.join(ROOT, 'scripts', 's.js')]);\nfs.readFileSync(path.join(ROOT, 'lib', 'b.js'), 'utf8');`,
  'test/bin.test.js': `${HEAD}fs.readFileSync('bin/tc', 'utf8');`,
  'test/rootdoc.test.js': `${HEAD}const ROOT = path.join(__dirname, '..');\nconst read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');\nread('docs/x.md');`,
  'test/opaque.test.js': `${HEAD}const cfgPath = makeTemp();\nfs.readFileSync(cfgPath, 'utf8');`,
  'test/comment.test.js': `${HEAD}// fs.readFileSync('lib/a.js')\nconst s = "fs.readFileSync('lib/b.js')";`,
  'server.js': "require('./lib/a');",
  'test/renamed.test.js': "const fsMod = require('node:fs');\nconst path = require('node:path');\nfsMod.readFileSync(path.join(__dirname, '..', 'lib', 'c.js'), 'utf8');",
  'test/inline.test.js': "const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');",
  'test/resolve.test.js': `${HEAD}fs.readFileSync(require.resolve('../lib/a.js'), 'utf8');`,
  'test/promises.test.js': "const fsp = require('node:fs/promises');\nfsp.readFile('lib/b.js', 'utf8');",
  'test/stranger.test.js': "const store = makeStore();\nstore.readFile('lib/a.js');"
};

/**
 * An in-memory repository: the walker's seam and the test files, absolute.
 *
 * @returns {{root: string, tests: string[], graphIo: object}}
 */
function repo() {
  const abs = new Map(Object.entries(FILES).map(([r, t]) => [path.join(ROOT, r), t]));
  const dirs = new Set([ROOT]);
  for (const f of abs.keys()) { let d = path.dirname(f); while (d !== ROOT) { dirs.add(d); d = path.dirname(d); } }
  const graphIo = { root: ROOT, readFile: (f) => abs.get(f), isFile: (f) => abs.has(f), isDir: (f) => dirs.has(f) };
  const tests = [...abs.keys()].filter((f) => f.endsWith('.test.js')).sort();
  return { root: ROOT, tests, graphIo };
}

/** A stdout sink. */
function sink() {
  let text = '';
  return { write: (s) => { text += s; return true; }, text: () => text };
}

/**
 * The triage of the in-memory tree, by test file.
 *
 * @returns {{byFile: Map<string, object>, result: object}}
 */
function run() {
  const tierOf = new Map([['test/self.test.js', 'medium'], ['test/spawn.test.js', 'large']]);
  const result = audit.triage({ ...repo(), tierOf });
  return { byFile: new Map(result.readers.map((r) => [r.file, r])), result };
}

describe('triage', () => {
  it('finds the readers and only the readers: the root doc read, the opaque read and the commented read are none of them', () => {
    const { byFile } = run();
    assert.deepEqual([...byFile.keys()], [
      'test/bin.test.js', 'test/css.test.js', 'test/inline.test.js', 'test/lift.test.js', 'test/none.test.js',
      'test/other.test.js', 'test/promises.test.js', 'test/renamed.test.js', 'test/resolve.test.js',
      'test/self.test.js', 'test/spawn.test.js', 'test/sweep.test.js'
    ]);
  });

  it('a read on a name the test binds to node:fs is a read: here of a module no test loads, so NONE', () => {
    const r = run().byFile.get('test/renamed.test.js');
    assert.deepEqual([r.cls, r.proof, r.reads, r.unloaded], ['regex', 'none', ['lib/c.js'], ['lib/c.js']]);
  });

  it('an inline require(\'node:fs\') reading an inline require(\'node:path\').join is a read', () => {
    const r = run().byFile.get('test/inline.test.js');
    assert.deepEqual([r.cls, r.proof, r.reads], ['regex', 'none', ['server.js']]);
  });

  it('a read of require.resolve(\'../lib/a.js\') reads that file: OTHER, since self.test loads it', () => {
    const r = run().byFile.get('test/resolve.test.js');
    assert.deepEqual([r.cls, r.proof, r.reads], ['regex', 'other', ['lib/a.js']]);
  });

  it('a read on a node:fs/promises binding is a read: OTHER, since a script spawn.test runs loads lib/b.js', () => {
    const r = run().byFile.get('test/promises.test.js');
    assert.deepEqual([r.cls, r.proof, r.reads], ['regex', 'other', ['lib/b.js']]);
  });

  it('a test that loads the module it reads is REGEX, SELF', () => {
    const r = run().byFile.get('test/self.test.js');
    assert.deepEqual([r.cls, r.proof, r.reads, r.tier], ['regex', 'self', ['lib/a.js'], 'medium']);
  });

  it('a read through a constant naming the file, of a module another test loads, is REGEX, OTHER', () => {
    const r = run().byFile.get('test/other.test.js');
    assert.deepEqual([r.cls, r.proof, r.reads, r.tier], ['regex', 'other', ['lib/a.js'], null]);
  });

  it('a helper reading public/ by a literal file name is REGEX, NONE: public/ is never counted as loaded', () => {
    const r = run().byFile.get('test/none.test.js');
    assert.deepEqual([r.cls, r.proof, r.reads, r.unloaded], ['regex', 'none', ['public/app.js'], ['public/app.js']]);
  });

  it('a bin/ command is code: reading it with nothing that runs it is REGEX, NONE', () => {
    const r = run().byFile.get('test/bin.test.js');
    assert.deepEqual([r.cls, r.proof, r.reads], ['regex', 'none', ['bin/tc']]);
  });

  it('a module loaded through a script the test spawns is the test\'s own load: SELF', () => {
    const r = run().byFile.get('test/spawn.test.js');
    assert.deepEqual([r.cls, r.proof, r.reads, r.tier], ['regex', 'self', ['lib/b.js'], 'large']);
  });

  it('reading only a non-code file is GUARD', () => {
    const r = run().byFile.get('test/css.test.js');
    assert.deepEqual([r.cls, r.proof, r.reads, r.sweeps], ['guard', null, ['public/style.css'], []]);
  });

  it('reading a directory by names built at run time is a sweep, and GUARD', () => {
    const r = run().byFile.get('test/sweep.test.js');
    assert.deepEqual([r.cls, r.reads, r.sweeps], ['guard', [], ['lib/']]);
  });

  it('a lift-helper user is LIFT, whatever else it reads', () => {
    const r = run().byFile.get('test/lift.test.js');
    assert.deepEqual([r.cls, r.proof], ['lift', null]);
  });

  it('an opaque read is listed with its file and line, never classified: a path it cannot resolve, and a read on a receiver that is not the file system', () => {
    assert.deepEqual(run().result.opaque, [
      { file: 'test/opaque.test.js', line: 4, arg: 'cfgPath' },
      { file: 'test/stranger.test.js', line: 2, arg: 'store.readFile(…)' }
    ]);
  });
});

describe('isSource / isCode', () => {
  it('the root and the five source roots are source; a look-alike and docs are not', () => {
    for (const p of ['', 'server.js', 'lib/a.js', 'public/x.css', 'bin/tc', 'scripts/s.js']) assert.equal(audit.isSource(path.join(ROOT, p), ROOT), true, p);
    for (const p of ['docs/x.md', 'libx/a.js', 'server.json']) assert.equal(audit.isSource(path.join(ROOT, p), ROOT), false, p);
  });

  it('a .js file and a bin/ command are code; a stylesheet is not', () => {
    assert.equal(audit.isCode(path.join(ROOT, 'lib/a.js'), ROOT), true);
    assert.equal(audit.isCode(path.join(ROOT, 'bin/tc'), ROOT), true);
    assert.equal(audit.isCode(path.join(ROOT, 'public/style.css'), ROOT), false);
  });
});

describe('main', () => {
  it('prints every class with its per-tier counts and the opaque reads per file, exit 0', () => {
    const out = sink();
    const ledger = { small: [], medium: ['test/self.test.js'], large: ['test/spawn.test.js'] };
    assert.equal(audit.main([], { stdout: out, ...repo(), ledger }), 0);
    const text = out.text();
    assert.match(text, /^source-reader triage: 12 test file\(s\) .* \(small 0, medium 1, large 1, not in the ledger 10\); 2 read\(s\) in 2 file\(s\) are opaque/m);
    assert.match(text, /^guard .*: 2 \(/m);
    assert.match(text, /^lift .*: 1 \(/m);
    assert.match(text, /^regex-of-behaviour .*: 9 \(/m);
    assert.match(text, /^ {2}self: .*: 2 \(small 0, medium 1, large 1\)$/m);
    assert.match(text, /^ {2}test\/sweep\.test\.js: lib\/ \(sweep\)$/m);
    assert.match(text, /^ {4}test\/none\.test\.js: public\/app\.js \[unloaded: public\/app\.js\]$/m);
    assert.match(text, /^ {2}test\/opaque\.test\.js: 1 \(line 4\)$/m);
  });

  it('refuses any argument, exit 1', () => {
    const out = sink();
    assert.equal(audit.main(['--check'], { stdout: out }), 1);
    assert.equal(out.text(), 'usage: audit-source-readers.js\n');
  });
});
