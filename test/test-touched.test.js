'use strict';

/**
 * `scripts/test-touched.js`: Stage 2's selector (#2498 W4-04).
 *
 * Pinned on an in-memory tree, with git replaced by a seam: a one-file
 * `lib/` change lists its readers and the static ring and nothing from an
 * untouched area; a changed test selects itself; and each of the four
 * fail-closed reasons exits 1 with its reason named and the `ESCALATE: run
 * stage 3` line. There is no flag that accepts a partial selection, and the
 * argument parser says so. The diff this chunk itself lands with touches
 * `docs/test-pyramid.md`, so that shape is pinned here as the expected
 * escalation.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const touched = require('../scripts/test-touched');
const stage = require('../scripts/test-stage');

const ROOT = path.resolve('/virtual');
const RING = ['test/ring-a.test.js', 'test/ring-b.test.js'];

/**
 * An in-memory repository: files by repo-relative path, the test files among
 * them as the suite, the changed list as git would report it.
 *
 * @param {Object<string, string>} files
 * @returns {{ctx: object, io: object}} `ctx` for `select`, `io` for `stage2`
 */
function repo(files) {
  const abs = new Map(Object.entries(files).map(([r, t]) => [path.join(ROOT, r), t]));
  const dirs = new Set([ROOT]);
  for (const f of abs.keys()) { let d = path.dirname(f); while (d !== ROOT) { dirs.add(d); d = path.dirname(d); } }
  const graphIo = { root: ROOT, readFile: (f) => abs.get(f), isFile: (f) => abs.has(f), isDir: (f) => dirs.has(f) };
  const tests = [...abs.keys()].filter((f) => /\/test\/[^/]+\.test\.js$/.test(f)).sort();
  return { ctx: { root: ROOT, tests, graphIo, ring: RING }, graphIo, tests };
}

const FILES = {
  'lib/a.js': "const b = require('./b');\nmodule.exports = { a: () => b.b() };",
  'lib/b.js': 'module.exports = { b: () => 1 };',
  'lib/far.js': 'module.exports = { far: 1 };',
  'lib/steps/one.js': 'module.exports = { one: 1 };',
  'scripts/tool.js': "const path = require('node:path'); const REPO = path.resolve(__dirname, '..'); const far = require(path.join(REPO, 'lib', 'far'));",
  'test/_shared.js': '',
  'test/helpers/h.js': '',
  'test/a.test.js': "const a = require('../lib/a');",
  'test/b.test.js': "const b = require('../lib/b');",
  'test/far.test.js': "const tool = require('../scripts/tool');",
  'test/text.test.js': "const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'lib', 'far.js'), 'utf8');",
  'test/dyn.test.js': "const k = 'one'; const s = require(`../lib/steps/${k}`);",
  'test/ring-a.test.js': '',
  'test/ring-b.test.js': '',
  'docs/test-pyramid.md': '# the page'
};

/** A stdout sink. */
function sink() {
  let text = '';
  return { write: (s) => { text += s; return true; }, text: () => text };
}

describe('select: a trusted selection', () => {
  it('a one-file lib change lists its readers through the graph and through text, plus the ring, and nothing from an untouched area', () => {
    const { ctx } = repo(FILES);
    const s = touched.select(['lib/b.js'], ctx);
    assert.deepEqual(s.escalations, []);
    assert.deepEqual(s.selected, ['test/a.test.js', 'test/b.test.js']);
    assert.deepEqual(s.ring, RING);
    const far = touched.select(['lib/far.js'], ctx);
    assert.deepEqual(far.selected, ['test/far.test.js', 'test/text.test.js'], 'a rooted require in a script and a readFileSync in a test both reach it');
    assert.deepEqual(far.changed[0].tests, ['test/far.test.js', 'test/text.test.js']);
  });

  it('a changed test file selects itself; a deleted one is nothing to run', () => {
    const { ctx } = repo(FILES);
    const s = touched.select(['test/b.test.js', 'test/gone.test.js'], ctx);
    assert.deepEqual(s.escalations, []);
    assert.deepEqual(s.selected, ['test/b.test.js']);
    assert.deepEqual(s.changed.map((c) => c.detail), ['itself', 'deleted; nothing to run']);
  });

  it('an empty diff selects only the ring', () => {
    const { ctx } = repo(FILES);
    const s = touched.select([], ctx);
    assert.deepEqual([s.selected, s.ring, s.escalations], [[], RING, []]);
  });
});

describe('select: every fail-closed reason, named, and nothing partial', () => {
  const reasons = {
    'dynamic-require': ['lib/steps/one.js', /test\/dyn\.test\.js via test\/dyn\.test\.js:1 `\.\.\/lib\/steps\/\$\{k\}` \(bounded to lib\/steps\/\)/],
    'not-javascript': ['docs/test-pyramid.md', /not JavaScript/],
    'shared-helper': ['test/_shared.js', /shared test helper or fixture/],
    unreached: ['lib/nobody.js', /deleted, and reached by no test/]
  };
  for (const [reason, [file, detail]] of Object.entries(reasons)) {
    it(`${reason}: exits 1, names the reason, prints ESCALATE`, () => {
      const { ctx } = repo(FILES); // lib/nobody.js is not on disk: a deleted file, reached by nothing
      const s = touched.select([file, 'lib/b.js'], ctx);
      assert.equal(s.escalations.length, 1);
      assert.match(s.escalations[0], new RegExp(`^${file.replace(/[.$]/g, '\\$&')}: ${reason}: `));
      assert.match(s.escalations[0], detail);
      const out = sink();
      assert.equal(touched.report(s, { out, explain: false }), false);
      assert.match(out.text(), /^REFUSED: 1 changed file\(s\) the selection cannot answer for$/m);
      assert.match(out.text(), /^ESCALATE: run stage 3$/m);
      assert.doesNotMatch(out.text(), /^selected:/m, 'no partial selection is printed');
    });
  }

  it('a helper under test/helpers and a fixture escalate as shared helpers; an unreached file that exists says so', () => {
    const { ctx } = repo({ ...FILES, 'lib/alone.js': '' });
    assert.match(touched.select(['test/helpers/h.js'], ctx).escalations[0], /^test\/helpers\/h\.js: shared-helper/);
    assert.match(touched.select(['test/fixtures/f.json'], ctx).escalations[0], /^test\/fixtures\/f\.json: shared-helper/);
    assert.match(touched.select(['lib/alone.js'], ctx).escalations[0], /^lib\/alone\.js: unreached: reached by no test$/);
  });

  it('an unbounded dynamic require escalates any changed JavaScript file', () => {
    const { ctx } = repo({ ...FILES, 'test/any.test.js': "const k = process.env.K; require(k);" });
    const s = touched.select(['lib/b.js'], ctx);
    assert.match(s.escalations[0], /^lib\/b\.js: dynamic-require: .*test\/any\.test\.js via test\/any\.test\.js:1 k \(unbounded\)/);
  });

  it('this chunk\'s own diff shape, docs/test-pyramid.md among JavaScript, is the escalation', () => {
    const { ctx } = repo(FILES);
    const s = touched.select(['docs/test-pyramid.md', 'lib/b.js', 'scripts/tool.js'], ctx);
    assert.deepEqual(s.escalations.map((e) => e.split(':')[0]), ['docs/test-pyramid.md']);
  });

  it('parseArgs accepts the four options and nothing else, so no flag accepts a partial selection', () => {
    assert.deepEqual(touched.parseArgs([]), { base: 'origin/main', run: false, explain: false, junitPath: null });
    assert.deepEqual(touched.parseArgs(['--base', 'main', '--run', '--explain', '--junit', 'j']), { base: 'main', run: true, explain: true, junitPath: path.resolve('j') });
    assert.throws(() => touched.parseArgs(['--partial']), /usage: test-touched\.js/);
    assert.throws(() => touched.parseArgs(['--base']), /usage/);
    const out = sink();
    assert.equal(touched.main(['--accept-partial'], { stdout: out }), 2);
  });
});

describe('report and byTier', () => {
  it('prints one line per changed file, the totals by tier, and with --explain the tests, the dynamic requires and the opaque count', () => {
    const { ctx } = repo(FILES);
    const s = touched.select(['lib/b.js'], ctx);
    const ledger = { small: ['test/a.test.js', 'test/ring-a.test.js'], medium: ['test/b.test.js'], large: [] };
    const out = sink();
    assert.equal(touched.report(s, { out, explain: true, ledger, base: 'origin/main', mergeBase: 'abcdef0123' }), true);
    assert.match(out.text(), /^touched: base origin\/main \(merge-base abcdef01\), 1 changed file\(s\)$/m);
    assert.match(out.text(), /^ {2}lib\/b\.js -> 2 test file\(s\)$/m);
    assert.match(out.text(), /^ {6}test\/a\.test\.js$/m);
    assert.match(out.text(), /^selected: 2 test file\(s\) \+ 2 static ring = 4 \(small 2, medium 1, large 1, undeclared in the ledger: test\/ring-b\.test\.js\)$/m);
    assert.match(out.text(), /^ {2}test\/ring-a\.test\.js \(static ring\)$/m);
    assert.match(out.text(), /^dynamic requires on the selected graphs: 0$/m);
    assert.match(out.text(), /^opaque reads on the selected graphs .*: 0$/m);
    assert.deepEqual(touched.byTier(s, ledger), { small: ['test/a.test.js', 'test/ring-a.test.js'], medium: ['test/b.test.js'], large: ['test/ring-b.test.js'], undeclared: ['test/ring-b.test.js'] });
  });
});

describe('stage2 through the seam, without running', () => {
  it('reports a trusted selection and exits 0; an escalation exits 1 without running anything', () => {
    const { tests, graphIo } = repo(FILES);
    const io = (files) => ({ changed: () => ({ mergeBase: 'abc', files }), tests: () => tests, graphIo });
    const ledger = { small: tests.map((t) => path.relative(ROOT, t)), medium: [], large: [] };
    const ledgerPath = path.join(require('node:os').tmpdir(), `tc-touched-ledger-${process.pid}.json`);
    require('node:fs').writeFileSync(ledgerPath, JSON.stringify(ledger));
    try {
      const ok = sink();
      assert.equal(touched.stage2({ base: 'origin/main', run: false, explain: false, junitPath: null }, { stdout: ok, root: ROOT, io: io(['lib/b.js']), ledgerPath }), 0);
      assert.match(ok.text(), /^stage 2 \(touched\): selection \d+ ms, trusted$/m);
      assert.match(ok.text(), /^selected: 2 test file\(s\) \+ 3 static ring = 5/m, 'the real static ring when no ring is injected');
      const red = sink();
      assert.equal(touched.stage2({ base: 'origin/main', run: false, explain: false, junitPath: null }, { stdout: red, root: ROOT, io: io(['docs/test-pyramid.md']), ledgerPath }), 1);
      assert.match(red.text(), /^ESCALATE: run stage 3$/m);
      assert.match(red.text(), /^stage 2 \(touched\): selection \d+ ms, escalated$/m);
      assert.doesNotMatch(red.text(), /running stage 3 whole/);
    } finally {
      require('node:fs').rmSync(ledgerPath, { force: true });
    }
  });

  it('the ring the runner owns is what the selector adds', () => {
    assert.deepEqual(stage.STATIC_RING.length, 3);
  });
});
