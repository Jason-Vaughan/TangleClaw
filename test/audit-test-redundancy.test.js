'use strict';

/**
 * `scripts/audit-test-redundancy.js`: the per-file coverage redundancy matrix
 * (#2498 W4-05).
 *
 * The lcov parse is pinned on a report shaped the way node 22's lcov reporter
 * writes one (`TN:`, `SF:`, `FN:`, `FNDA:`, `DA:`, `BRDA:`, the summaries,
 * `end_of_record`): only lines with a hit count above zero are executed, a
 * checksum after the count is tolerated, a file named twice is merged, and a
 * malformed or misplaced record is refused with its line. Product lines are
 * `server.js`, `lib/`, `public/`, `bin/` and `scripts/`, never the test or
 * its helpers. The matrix names what each file adds, the files that add
 * nothing, one set of them retirable together, and the files that execute no
 * product line. The runs are injected, so nothing here starts a process: a
 * failed, silent or unparseable run is named and left out, runs that all
 * succeed with no product line among them (paths it cannot read) are
 * refused, at most `jobs` run at once, and each file runs under its own tier.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const audit = require('../scripts/audit-test-redundancy');

/** A report the way node 22's lcov reporter writes it (paths relative to the run's directory). */
const LCOV = [
  'TN:',
  'SF:lib/a.js',
  'FN:1,alpha',
  'FNDA:1,alpha',
  'FNF:1',
  'FNH:1',
  'BRDA:1,0,0,1',
  'BRF:1',
  'BRH:1',
  'DA:1,1',
  'DA:2,0',
  'DA:3,7',
  'DA:4,2,abc123',
  'LH:3',
  'LF:4',
  'end_of_record',
  'TN:',
  'SF:test/a.test.js',
  'DA:1,1',
  'end_of_record',
  'TN:',
  'SF:lib/a.js',
  'DA:9,1',
  'end_of_record',
  ''
].join('\n');

/** A stdout sink. */
function sink() {
  let text = '';
  return { write: (s) => { text += s; return true; }, text: () => text };
}

/** A ledger in the shape `test/tiers.json` has. */
const LEDGER = { small: ['test/s1.test.js', 'test/s2.test.js'], medium: ['test/m1.test.js'], large: ['test/l1.test.js'] };

/**
 * An injected run: each file's report from a table, recording what it was asked.
 *
 * @param {Object<string, {status?: number, lcov: string|null, stderr?: string}>} table
 * @returns {{runFile: function, calls: Array<{file: string, tier: string}>}}
 */
function fakeRuns(table) {
  const calls = [];
  return {
    calls,
    runFile: async (file, ctx) => {
      calls.push({ file, tier: ctx.tier });
      const r = table[file];
      return { status: r.status === undefined ? 0 : r.status, lcov: r.lcov, stderr: r.stderr || '' };
    }
  };
}

/**
 * A report whose `lib/x.js` record executes the given lines.
 *
 * @param {number[]} lines
 * @returns {string}
 */
function lcovOf(lines) {
  return ['SF:lib/x.js', ...lines.map((n) => `DA:${n},1`), 'end_of_record', ''].join('\n');
}

describe('parseLcov', () => {
  it('keeps the lines with a hit count above zero per file, tolerates a checksum, merges a file named twice and skips every other record', () => {
    const m = audit.parseLcov(LCOV);
    assert.deepEqual([...m.keys()], ['lib/a.js', 'test/a.test.js']);
    assert.deepEqual([...m.get('lib/a.js')].sort((a, b) => a - b), [1, 3, 4, 9]);
    assert.deepEqual([...m.get('test/a.test.js')], [1]);
  });

  it('an empty report is an empty map', () => {
    assert.equal(audit.parseLcov('').size, 0);
  });

  for (const [why, text, message] of [
    ['a DA outside a record', 'DA:1,1\n', /lcov line 1: DA outside a file record/],
    ['a malformed DA', 'SF:lib/a.js\nDA:x,1\nend_of_record\n', /lcov line 2: malformed DA record: DA:x,1/],
    ['a record opened inside another', 'SF:lib/a.js\nSF:lib/b.js\n', /lcov line 2: SF opened inside the record of lib\/a\.js/],
    ['a record never closed', 'SF:lib/a.js\nDA:1,1\n', /the record of lib\/a\.js is never closed/],
    ['an end_of_record with none open', 'end_of_record\n', /lcov line 1: end_of_record with no open record/]
  ]) {
    it(`refuses ${why}, naming the line`, () => {
      assert.throws(() => audit.parseLcov(text), message);
    });
  }
});

describe('productLines', () => {
  it('keeps server.js, lib/, public/, bin/ and scripts/ lines and drops the tests, their helpers and look-alikes', () => {
    const m = new Map([
      ['server.js', new Set([1])],
      ['lib/a.js', new Set([2, 3])],
      ['public/app.js', new Set([4])],
      ['bin/tc', new Set([5])],
      ['scripts/s.js', new Set([6])],
      ['test/a.test.js', new Set([7])],
      ['test/helpers/preload-small.js', new Set([8])],
      ['server.json', new Set([9])],
      ['libx/a.js', new Set([10])]
    ]);
    assert.deepEqual([...audit.productLines(m)].sort(), ['bin/tc:5', 'lib/a.js:2', 'lib/a.js:3', 'public/app.js:4', 'scripts/s.js:6', 'server.js:1']);
  });
});

describe('matrix', () => {
  const perFile = new Map([
    ['test/big.test.js', new Set(['l:1', 'l:2', 'l:3', 'l:4'])],
    ['test/twin-a.test.js', new Set(['l:5'])],
    ['test/twin-b.test.js', new Set(['l:5'])],
    ['test/inside.test.js', new Set(['l:1', 'l:2'])],
    ['test/text.test.js', new Set()]
  ]);

  it('says what each file adds, smallest first, and how many lines the run executed in all', () => {
    const m = audit.matrix(perFile);
    assert.equal(m.union, 5);
    assert.deepEqual(m.rows, [
      { file: 'test/inside.test.js', covered: 2, adds: 0 },
      { file: 'test/text.test.js', covered: 0, adds: 0 },
      { file: 'test/twin-a.test.js', covered: 1, adds: 0 },
      { file: 'test/twin-b.test.js', covered: 1, adds: 0 },
      { file: 'test/big.test.js', covered: 4, adds: 2 }
    ]);
  });

  it('a candidate adds nothing; twins are both candidates but only one is removable with the rest, and a file executing nothing is apart', () => {
    const m = audit.matrix(perFile);
    assert.deepEqual(m.candidates, ['test/inside.test.js', 'test/twin-a.test.js', 'test/twin-b.test.js']);
    assert.deepEqual(m.removable, ['test/inside.test.js', 'test/twin-a.test.js']);
    assert.deepEqual(m.noProductLine, ['test/text.test.js']);
  });

  it('retiring the removable set loses no line: what is left still executes the whole union', () => {
    const m = audit.matrix(perFile);
    const left = new Set();
    for (const [f, keys] of perFile) if (!m.removable.includes(f)) for (const k of keys) left.add(k);
    assert.equal(left.size, m.union);
  });
});

describe('runArgv', () => {
  it('a guarded tier runs under its stage guard and timeout; the file comes last', () => {
    assert.deepEqual(audit.runArgv('small', 'test/s1.test.js', '/tmp/x.lcov'), [
      '--test', '--experimental-test-coverage', '--test-reporter=lcov', '--test-reporter-destination=/tmp/x.lcov',
      '--require', './test/helpers/preload-small.js', '--test-timeout=300000', 'test/s1.test.js'
    ]);
    assert.deepEqual(audit.runArgv('medium', 'test/m1.test.js', '/tmp/x.lcov').slice(4, 7), ['--require', './test/helpers/preload-medium.js', '--test-timeout=300000']);
  });

  it('the large tier has no guard', () => {
    assert.deepEqual(audit.runArgv('large', 'test/l1.test.js', '/tmp/x.lcov'), [
      '--test', '--experimental-test-coverage', '--test-reporter=lcov', '--test-reporter-destination=/tmp/x.lcov', 'test/l1.test.js'
    ]);
  });
});

describe('collect', () => {
  it('keeps the product lines of each good run and names a failed, silent or unparseable run, leaving it out', async () => {
    const runs = fakeRuns({
      'test/ok.test.js': { lcov: lcovOf([1, 2]) },
      'test/red.test.js': { status: 1, lcov: lcovOf([3]), stderr: 'noise\nAssertionError: boom\n' },
      'test/silent.test.js': { lcov: null },
      'test/garbled.test.js': { lcov: 'DA:1,1\n' }
    });
    const work = ['test/ok.test.js', 'test/red.test.js', 'test/silent.test.js', 'test/garbled.test.js'].map((file) => ({ file, tier: 'small' }));
    const r = await audit.collect(work, { jobs: 2, root: '/r', runFile: runs.runFile });
    assert.deepEqual([...r.perFile.keys()], ['test/ok.test.js']);
    assert.deepEqual([...r.perFile.get('test/ok.test.js')].sort(), ['lib/x.js:1', 'lib/x.js:2']);
    assert.deepEqual(r.failed, [
      { file: 'test/garbled.test.js', reason: 'lcov line 1: DA outside a file record' },
      { file: 'test/red.test.js', reason: 'exit 1: AssertionError: boom' },
      { file: 'test/silent.test.js', reason: 'no coverage report written' }
    ]);
  });

  it('runs at most `jobs` files at once', async () => {
    let live = 0;
    let most = 0;
    const runFile = async () => {
      live++;
      most = Math.max(most, live);
      await new Promise((resolve) => setImmediate(resolve));
      live--;
      return { status: 0, lcov: lcovOf([1]), stderr: '' };
    };
    const work = Array.from({ length: 7 }, (_, i) => ({ file: `test/f${i}.test.js`, tier: 'small' }));
    const r = await audit.collect(work, { jobs: 3, root: '/r', runFile });
    assert.equal(r.perFile.size, 7);
    assert.equal(most, 3);
  });
});

describe('parseArgs', () => {
  it('reads a tier, a file list and a job count', () => {
    assert.deepEqual(audit.parseArgs(['--tier', 'small', '--jobs', '4']), { tier: 'small', files: [], jobs: 4 });
    assert.deepEqual(audit.parseArgs(['test/a.test.js', 'test/b.test.js']), { tier: null, files: ['test/a.test.js', 'test/b.test.js'], jobs: null });
  });

  for (const [argv, error] of [
    [[], 'name a tier or a list of test files, not both'],
    [['--tier', 'small', 'test/a.test.js'], 'name a tier or a list of test files, not both'],
    [['--tier', 'tiny'], 'unknown tier: tiny'],
    [['--tier'], '--tier needs a value'],
    [['--jobs', '0', '--tier', 'small'], '--jobs must be a positive whole number: 0'],
    [['--fast'], 'unknown flag: --fast']
  ]) {
    it(`refuses ${JSON.stringify(argv)}`, () => {
      assert.deepEqual(audit.parseArgs(argv), { error });
    });
  }
});

describe('main', () => {
  it('runs every file of a tier under that tier and prints the matrix, exit 0', async () => {
    const runs = fakeRuns({ 'test/s1.test.js': { lcov: lcovOf([1, 2]) }, 'test/s2.test.js': { lcov: lcovOf([1]) } });
    const out = sink();
    let t = 1000;
    const code = await audit.main(['--tier', 'small', '--jobs', '1'], { stdout: out, ledger: LEDGER, runFile: runs.runFile, now: () => (t += 1500) });
    assert.equal(code, 0);
    assert.deepEqual(runs.calls, [{ file: 'test/s1.test.js', tier: 'small' }, { file: 'test/s2.test.js', tier: 'small' }]);
    const text = out.text();
    assert.match(text, /^coverage redundancy matrix: tier small, 2 file\(s\) run, 0 failed, 1 at a time, 1\.5 s; 2 product line\(s\) executed in all$/m);
    assert.match(text, /^exact-subset candidates .*: 1\n {2}test\/s2\.test\.js$/m);
    assert.match(text, /^ {7}1 \/ 2 {6}test\/s1\.test\.js$/m);
  });

  it('runs named files each under its own tier from the ledger', async () => {
    const runs = fakeRuns({ 'test/m1.test.js': { lcov: lcovOf([1]) }, 'test/l1.test.js': { lcov: lcovOf([2]) } });
    const code = await audit.main(['test/m1.test.js', 'test/l1.test.js'], { stdout: sink(), ledger: LEDGER, runFile: runs.runFile, jobs: 1 });
    assert.equal(code, 0);
    assert.deepEqual(runs.calls, [{ file: 'test/m1.test.js', tier: 'medium' }, { file: 'test/l1.test.js', tier: 'large' }]);
  });

  it('exits 1 when any run failed, after printing the matrix of the rest', async () => {
    const runs = fakeRuns({ 'test/s1.test.js': { lcov: lcovOf([1]) }, 'test/s2.test.js': { status: 1, lcov: null } });
    const out = sink();
    const code = await audit.main(['--tier', 'small'], { stdout: out, ledger: LEDGER, runFile: runs.runFile, jobs: 2 });
    assert.equal(code, 1);
    assert.match(out.text(), /1 failed/);
    assert.match(out.text(), /failed \(left out of the matrix\): test\/s2\.test\.js: exit 1/);
  });

  it('refuses, exit 1, when runs succeed and none executed a product line: a report whose paths it cannot read is not a tier that proves nothing', async () => {
    const absolute = ['SF:/home/runner/work/repo/lib/x.js', 'DA:1,1', 'end_of_record', ''].join('\n');
    const runs = fakeRuns({ 'test/s1.test.js': { lcov: absolute }, 'test/s2.test.js': { lcov: absolute } });
    const out = sink();
    assert.equal(await audit.main(['--tier', 'small'], { stdout: out, ledger: LEDGER, runFile: runs.runFile, jobs: 1 }), 1);
    assert.match(out.text(), /^refused: 2 run\(s\) succeeded and none executed a product line; the lcov SF: paths are probably not repo-relative/m);
  });

  it('refuses a named file the ledger does not list, and a usage error, exit 1 with the usage', async () => {
    const out = sink();
    assert.equal(await audit.main(['test/nowhere.test.js'], { stdout: out, ledger: LEDGER, runFile: fakeRuns({}).runFile }), 1);
    assert.match(out.text(), /not in test\/tiers\.json .*: test\/nowhere\.test\.js\nusage:/);
    const out2 = sink();
    assert.equal(await audit.main(['--tier', 'tiny'], { stdout: out2, ledger: LEDGER }), 1);
    assert.equal(out2.text(), `unknown tier: tiny\n${audit.USAGE}`);
  });
});
