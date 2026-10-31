'use strict';

/**
 * The tier ledger, its guards and the Testament manifest it generates (#2498).
 *
 * Four contracts, each pinned here because every later stage of the test
 * pyramid stands on them:
 *
 *   1. The ledger is total: every `test/*.test.js` is in it exactly once, and
 *      `--check` names a file that is missing, listed twice, gone, or
 *      declared faster than its text allows.
 *   2. The scan follows requires of other files under `test/`, so a helper
 *      that spawns makes its callers Large, and never follows into `lib/`.
 *   3. The guards refuse the ACT, never the require, in a real `node --test`
 *      child process: each of the seven `child_process` spawners, opening a
 *      `node:sqlite` database and a socket listen under the Small guard, the
 *      seven spawners alone under the Medium guard; loading either module
 *      without calling is allowed; and a refusal the caller swallows still
 *      fails the file.
 *   4. The Testament manifest is the ledger, suite for suite, with the stage
 *      runner's own command line for each tier, and `--check` refuses one
 *      that is anything other than what `--testament` writes.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tiers = require('../scripts/test-tiers');
const stage = require('../scripts/test-stage');

const REPO = path.join(__dirname, '..');
const SMALL_GUARD = path.join(__dirname, 'helpers', 'preload-small.js');
const MEDIUM_GUARD = path.join(__dirname, 'helpers', 'preload-medium.js');

/**
 * Run one fixture file under `node --test --require <guard>` and return what
 * the runner reported. The child's `NODE_TEST_CONTEXT` is dropped so the run
 * is a top-level runner, not a subtest of this one.
 *
 * @param {string} guard - The preload's absolute path
 * @param {string} source - The fixture's text
 * @returns {{status: number, output: string}}
 */
function runUnderGuard(guard, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tier-guard-'));
  try {
    const fixture = path.join(dir, 'fixture.test.js');
    fs.writeFileSync(fixture, source);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    let status = 0;
    let output = '';
    try {
      output = execFileSync(process.execPath, [
        '--test', '--require', guard, '--test-reporter=spec', '--test-reporter-destination=stdout', fixture
      ], { stdio: 'pipe', env, encoding: 'utf8' });
    } catch (err) {
      status = err.status;
      output = `${err.stdout || ''}${err.stderr || ''}`;
    }
    return { status, output };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PASSES = `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('pure', () => { assert.equal(1 + 1, 2); });
`;

describe('classifyText: the fastest tier a text allows', () => {
  it('is small for pure in-process code', () => {
    assert.equal(tiers.classifyText(PASSES), 'small');
  });

  it('is large only when child_process is bound AND a spawner is called', () => {
    assert.equal(tiers.classifyText("const cp = require('child_process');"), 'small');
    assert.equal(tiers.classifyText("const { execFileSync } = require('node:child_process');"), 'small');
    assert.equal(tiers.classifyText("const { spawnSync } = require('node:child_process');\nspawnSync(process.execPath, []);"), 'large');
    assert.equal(tiers.classifyText("const cp = require('child_process');\ncp.execFile('git', ['status']);"), 'large');
  });

  it('does not read RegExp.prototype.exec or SQLite db.exec as a spawn', () => {
    assert.equal(tiers.classifyText("const m = /x/.exec(text);\nre.exec(FEATURES);"), 'small');
    assert.equal(tiers.classifyText("const { DatabaseSync } = require('node:sqlite');\nconst db = new DatabaseSync(':memory:');\ndb.exec('create table t (x)');"), 'medium');
    assert.equal(tiers.classifyText("spawnSync(process.execPath, []);"), 'small', 'a bare call with no child_process binding is not a spawn the scan can see');
  });

  it('is medium for a database opened, the store, the server, a listen, a server, a fetch', () => {
    for (const text of [
      'new DatabaseSync(":memory:")',
      "require('../lib/store')",
      "require('../lib/store/sessions')",
      "require('../server')",
      "require('node:http')",
      'server.listen(0)',
      'http.createServer(handler)',
      "await fetch('http://x')"
    ]) assert.equal(tiers.classifyText(text), 'medium', text);
  });

  it('ignores comments, so a sentence about child_process is not a spawn', () => {
    assert.equal(tiers.classifyText('// no child_process here\n/* spawn( is not called */\nconst x = 1;'), 'small');
    assert.equal(tiers.classifyText("const u = 'http://host'; // listen( in a comment\n"), 'small');
  });
});

describe('classifyFile: the scan follows helpers under test/ and stops at lib/', () => {
  const files = {
    '/repo/test/a.test.js': "const h = require('./_helper');\nrequire('../lib/anything');\n",
    '/repo/test/_helper.js': "const { spawnSync } = require('node:child_process');\nspawnSync('true');\n",
    '/repo/test/b.test.js': "require('./helpers/pure');\n",
    '/repo/test/helpers/pure.js': 'module.exports = 1;\n',
    '/repo/test/c.test.js': "require('./_cycle-x');\n",
    '/repo/test/_cycle-x.js': "require('./_cycle-y');\n",
    '/repo/test/_cycle-y.js': "require('./_cycle-x'); server.listen(0);\n"
  };
  // The resolver reads the real disk, so the fixtures live in a temp copy of
  // the layout under a directory named `test/`: the only shape it follows.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tier-scan-'));
  const testDir = path.join(dir, 'test');
  fs.mkdirSync(path.join(testDir, 'helpers'), { recursive: true });
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f.replace('/repo/', '')), text);
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('counts a spawning helper against its caller', () => {
    const io = { readFile: (f) => fs.readFileSync(f, 'utf8'), testDir };
    assert.equal(tiers.classifyFile(path.join(testDir, 'a.test.js'), io), 'large');
  });

  it('stays small through a pure helper and never opens lib/', () => {
    const io = { readFile: (f) => fs.readFileSync(f, 'utf8'), testDir };
    assert.equal(tiers.classifyFile(path.join(testDir, 'b.test.js'), io), 'small');
  });

  it('survives a require cycle and still sees the listen inside it', () => {
    const io = { readFile: (f) => fs.readFileSync(f, 'utf8'), testDir };
    assert.equal(tiers.classifyFile(path.join(testDir, 'c.test.js'), io), 'medium');
  });
});

describe('checkLedger: totality and honesty', () => {
  const files = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'];
  const classify = (rel) => ({ 'test/a.test.js': 'small', 'test/b.test.js': 'medium', 'test/c.test.js': 'large' })[rel];

  it('accepts a ledger that lists every file once at or below its allowed speed', () => {
    const ledger = { small: ['test/a.test.js'], medium: ['test/b.test.js'], large: ['test/c.test.js'] };
    assert.deepEqual(tiers.checkLedger(ledger, { files, classify }), { ok: true, failures: [] });
  });

  it('accepts a demotion: a file declared slower than the scan allows', () => {
    const ledger = { small: [], medium: ['test/a.test.js'], large: ['test/b.test.js', 'test/c.test.js'] };
    assert.equal(tiers.checkLedger(ledger, { files, classify }).ok, true);
  });

  it('names a missing file, a duplicate and a gone file, each once', () => {
    const ledger = {
      small: ['test/b.test.js', 'test/gone.test.js'],
      medium: ['test/b.test.js'],
      large: []
    };
    const { ok, failures } = tiers.checkLedger(ledger, { files, classify });
    assert.equal(ok, false);
    assert.deepEqual(failures, [
      'listed twice: test/b.test.js (small and medium)',
      'not in the ledger: test/a.test.js',
      'not in the ledger: test/c.test.js',
      'in the ledger but not in the suite: test/gone.test.js (small)'
    ]);
  });

  it('names a file declared faster than its text allows', () => {
    const ledger = { small: ['test/a.test.js', 'test/c.test.js'], medium: ['test/b.test.js'], large: [] };
    const { ok, failures } = tiers.checkLedger(ledger, { files, classify });
    assert.equal(ok, false);
    assert.deepEqual(failures, ['declared small but its text allows no faster than large: test/c.test.js']);
  });

  it('names an unsorted tier', () => {
    const ledger = { small: ['test/b.test.js', 'test/a.test.js'], medium: [], large: ['test/c.test.js'] };
    const { failures } = tiers.checkLedger(ledger, { files, classify: () => 'small' });
    assert.deepEqual(failures, ['"small" is not sorted']);
  });
});

describe('buildLedger: the scan plus earned demotions', () => {
  it('places every file at its scanned tier and keeps an existing slower declaration', () => {
    const files = ['test/a.test.js', 'test/b.test.js'];
    const classify = () => 'small';
    const existing = { small: ['test/b.test.js'], medium: ['test/a.test.js'], large: [] };
    assert.deepEqual(tiers.buildLedger(existing, { files, classify }), {
      small: ['test/b.test.js'], medium: ['test/a.test.js'], large: []
    });
  });

  it('never keeps a faster declaration than the scan allows', () => {
    const files = ['test/a.test.js'];
    const existing = { small: ['test/a.test.js'], medium: [], large: [] };
    assert.deepEqual(tiers.buildLedger(existing, { files, classify: () => 'large' }), {
      small: [], medium: [], large: ['test/a.test.js']
    });
  });

  it('round-trips through formatLedger and loadLedger', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tier-ledger-'));
    try {
      const file = path.join(dir, 'tiers.json');
      const ledger = { small: ['test/a.test.js'], medium: [], large: ['test/z.test.js'] };
      fs.writeFileSync(file, tiers.formatLedger(ledger));
      assert.deepEqual(tiers.loadLedger(file), ledger);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8'))._comment, tiers.LEDGER_COMMENT);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the tracked ledger (test/tiers.json)', () => {
  it('passes --check: every test file once, nothing gone, nothing declared faster than its text allows', () => {
    const out = [];
    const code = tiers.main(['--check'], { stdout: { write: (s) => out.push(s) } });
    assert.equal(code, 0, out.join(''));
  });

  it('is exactly the suite: the three tiers concatenated and sorted equal test/*.test.js', () => {
    const ledger = tiers.loadLedger();
    const union = [...ledger.small, ...ledger.medium, ...ledger.large].sort();
    assert.deepEqual(union, tiers.suiteFiles());
    assert.equal(new Set(union).size, union.length);
  });

  it('lists a tier sorted and one path per line', () => {
    const out = [];
    assert.equal(tiers.main(['--list', 'large'], { stdout: { write: (s) => out.push(s) } }), 0);
    const lines = out.join('').trimEnd().split('\n');
    assert.deepEqual(lines, tiers.loadLedger().large);
    assert.ok(lines.every((l) => l.startsWith('test/') && l.endsWith('.test.js')));
  });

  it('proposes one line per file as <tier><TAB><path>, in the order given', () => {
    const out = [];
    const files = ['test/test-tiers.test.js', 'test/lift-helper.test.js'];
    assert.equal(tiers.main(['--propose', ...files], { stdout: { write: (s) => out.push(s) } }), 0);
    const lines = out.join('').trimEnd().split('\n');
    assert.equal(lines.length, 2);
    lines.forEach((line, i) => {
      const [tier, file] = line.split('\t');
      assert.ok(tiers.TIERS.includes(tier), line);
      assert.equal(file, files[i]);
    });
    assert.equal(lines[0].split('\t')[0], 'large', 'this file spawns node --test children');
  });

  it('refuses a usage error with the usage line', () => {
    const out = [];
    assert.equal(tiers.main(['--list', 'huge'], { stdout: { write: (s) => out.push(s) } }), 1);
    assert.match(out.join(''), /^usage: test-tiers\.js/);
  });
});

describe('the Small guard, in a real node --test child', () => {
  it('lets a pure test pass', () => {
    const run = runUnderGuard(SMALL_GUARD, PASSES);
    assert.equal(run.status, 0, run.output);
  });

  it('lets child_process and node:sqlite LOAD: the act is refused, not the require', () => {
    const run = runUnderGuard(SMALL_GUARD, `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
test('loaded but unused', () => { assert.equal(typeof cp.spawn, 'function'); assert.equal(typeof DatabaseSync, 'function'); });
`);
    assert.equal(run.status, 0, run.output);
  });

  it('refuses a spawn at the call and names the caller', () => {
    const run = runUnderGuard(SMALL_GUARD, `'use strict';
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
test('spawns', () => { execFileSync('true'); });
`);
    assert.notEqual(run.status, 0);
    assert.match(run.output, /small tier: child_process\.execFileSync is forbidden here \(called from .*fixture\.test\.js:4 in .*fixture\.test\.js\)/);
  });

  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    it(`refuses child_process.${name} by name`, () => {
      const run = runUnderGuard(SMALL_GUARD, `'use strict';
const { test } = require('node:test');
const cp = require('node:child_process');
test('calls ${name}', () => { cp.${name}('true', []); });
`);
      assert.notEqual(run.status, 0);
      assert.match(run.output, new RegExp(`small tier: child_process\\.${name} is forbidden here \\(called from .*fixture\\.test\\.js:4 in`));
    });
  }

  it('refuses opening a node:sqlite database', () => {
    const run = runUnderGuard(SMALL_GUARD, `'use strict';
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
test('opens', () => { new DatabaseSync(':memory:'); });
`);
    assert.notEqual(run.status, 0);
    assert.match(run.output, /small tier: opening a node:sqlite database is forbidden here/);
  });

  it('fails the file on a refusal the caller swallowed, and says so on stderr', () => {
    const run = runUnderGuard(SMALL_GUARD, `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
test('degrades like product code does', () => {
  let out = 'not running';
  try { out = execFileSync('true'); } catch { /* the product's own catch */ }
  assert.equal(out, 'not running');
});
`);
    assert.notEqual(run.status, 0, 'a swallowed refusal must still fail the file');
    assert.match(run.output, /\[tier-guard\] small tier: child_process\.execFileSync is forbidden here \(called from .*fixture\.test\.js:7 in .*fixture\.test\.js\)/);
    assert.match(run.output, /\[tier-guard\] 1 refusal\(s\) in .*fixture\.test\.js: the file is not small/);
  });

  it('hands back the same guarded module on every require', () => {
    const run = runUnderGuard(SMALL_GUARD, `'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('one object', () => { assert.equal(require('child_process'), require('node:child_process')); });
`);
    assert.equal(run.status, 0, run.output);
  });

  it('refuses a socket listen, whichever server kind asks', () => {
    const run = runUnderGuard(SMALL_GUARD, `'use strict';
const { test } = require('node:test');
const http = require('node:http');
test('listens', () => { http.createServer(() => {}).listen(0); });
`);
    assert.notEqual(run.status, 0);
    assert.match(run.output, /small tier: listening on a socket is forbidden here/);
  });
});

describe('the Medium guard, in a real node --test child', () => {
  it('lets a database open and a server listen', () => {
    const run = runUnderGuard(MEDIUM_GUARD, `'use strict';
const { test } = require('node:test');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
test('opens, listens, closes', (t, done) => {
  new DatabaseSync(':memory:').close();
  const s = http.createServer(() => {}).listen(0, () => s.close(done));
});
`);
    assert.equal(run.status, 0, run.output);
  });

  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    it(`refuses child_process.${name} by name and names the caller`, () => {
      const run = runUnderGuard(MEDIUM_GUARD, `'use strict';
const { test } = require('node:test');
const cp = require('child_process');
test('calls ${name}', () => { cp.${name}('true', []); });
`);
      assert.notEqual(run.status, 0);
      assert.match(run.output, new RegExp(`medium tier: child_process\\.${name} is forbidden here \\(called from .*fixture\\.test\\.js:4 in .*fixture\\.test\\.js\\)`));
      assert.match(run.output, /\[tier-guard\] 1 refusal\(s\) in .*fixture\.test\.js: the file is not medium/);
    });
  }

  it('fails the file on a refusal the caller swallowed', () => {
    const run = runUnderGuard(MEDIUM_GUARD, `'use strict';
const { test } = require('node:test');
const { execSync } = require('node:child_process');
test('degrades', () => { try { execSync('true'); } catch { /* the product's own catch */ } });
`);
    assert.notEqual(run.status, 0, 'a swallowed refusal must still fail the file');
    assert.match(run.output, /\[tier-guard\] 1 refusal\(s\) in .*fixture\.test\.js: the file is not medium/);
  });
});

describe('the guards are what the ledger promises', () => {
  it('names each file under test/helpers the stage runner will --require', () => {
    assert.ok(fs.existsSync(path.join(REPO, 'test', 'helpers', 'preload-small.js')));
    assert.ok(fs.existsSync(path.join(REPO, 'test', 'helpers', 'preload-medium.js')));
  });
});

/**
 * Read the TOML the manifest generator writes, and nothing more: `#`
 * comments, `[table]` and `[a.b]` headers, and `key = value` where the value
 * is a basic string, an integer, `true`/`false`, or an array of those, which
 * may span lines and end in a trailing comma. Anything else throws, so a
 * generator that starts writing more TOML than this fails here first.
 *
 * @param {string} text - The manifest's text
 * @returns {object} The document as plain objects
 */
function readToml(text) {
  const doc = {};
  let table = doc;
  let i = 0;
  const fail = (what) => { throw new Error(`toml subset: ${what} at offset ${i}: ${JSON.stringify(text.slice(i, i + 30))}`); };
  const skipSpace = (newlines) => {
    for (;;) {
      if (text[i] === ' ' || text[i] === '\t' || (newlines && text[i] === '\n')) i += 1;
      else if (newlines && text[i] === '#') while (i < text.length && text[i] !== '\n') i += 1;
      else return;
    }
  };
  const value = () => {
    const rest = text.slice(i);
    const str = /^"(?:[^"\\\n]|\\.)*"/.exec(rest);
    if (str) { i += str[0].length; return JSON.parse(str[0]); }
    const int = /^-?\d+(?![\w.])/.exec(rest);
    if (int) { i += int[0].length; return Number(int[0]); }
    const bool = /^(?:true|false)(?!\w)/.exec(rest);
    if (bool) { i += bool[0].length; return bool[0] === 'true'; }
    if (text[i] !== '[') fail('unsupported value');
    i += 1;
    const items = [];
    for (;;) {
      skipSpace(true);
      if (text[i] === ']') { i += 1; return items; }
      items.push(value());
      skipSpace(true);
      if (text[i] === ',') i += 1;
      else if (text[i] !== ']') fail('expected , or ]');
    }
  };
  while (i < text.length) {
    skipSpace(true);
    if (i >= text.length) break;
    const header = /^\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\][ \t]*(?:\n|$)/.exec(text.slice(i));
    if (header) {
      table = doc;
      for (const part of header[1].split('.')) {
        if (!Object.hasOwn(table, part)) table[part] = {};
        table = table[part];
      }
      i += header[0].length;
      continue;
    }
    const key = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*/.exec(text.slice(i));
    if (!key) fail('expected a key or a table');
    if (Object.hasOwn(table, key[1])) fail(`duplicate key ${key[1]}`);
    i += key[0].length;
    table[key[1]] = value();
    skipSpace(false);
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i += 1;
    if (i < text.length && text[i] !== '\n') fail('expected the end of the line');
  }
  return doc;
}

describe('readToml: the subset the manifest generator writes', () => {
  it('reads tables, strings, integers, booleans and multi-line arrays with comments', () => {
    assert.deepEqual(readToml('# top\na = "x\\"y" # trailing\nn = 1800\n[s.t]\nb = true\nl = [\n  "p",\n  "q",\n]\ne = []\n'), {
      a: 'x"y', n: 1800, s: { t: { b: true, l: ['p', 'q'], e: [] } }
    });
  });

  it('refuses what it does not read, rather than guessing', () => {
    assert.throws(() => readToml('a = 1.5\n'), /unsupported value/);
    assert.throws(() => readToml('a = 1\na = 2\n'), /duplicate key a/);
    assert.throws(() => readToml('a = { b = 1 }\n'), /unsupported value/);
  });
});

describe('formatTestament: one files suite per tier, from the ledger', () => {
  const ledger = { small: ['test/a.test.js'], medium: ['test/b "q".test.js'], large: ['test/c.test.js', 'test/d.test.js'] };
  const command = (tier) => ['node', '--test', `--${tier}`, '{files}'];

  it('writes the environment once and each tier as a suite, in tier order', () => {
    const doc = readToml(tiers.formatTestament(ledger, { command }));
    assert.deepEqual(Object.keys(doc.suites), tiers.TIERS);
    assert.equal(doc.manifest_version, 3);
    assert.equal(doc.name, 'tangleclaw');
    assert.equal(doc.executor, 'container');
    assert.deepEqual(doc.env_inputs, ['.devcontainer/Dockerfile', '.node-version']);
    assert.equal(doc.batch_timeout_s, tiers.TESTAMENT_BATCH_TIMEOUT_S);
    assert.deepEqual(doc.image, { dockerfile: '.devcontainer/Dockerfile', inputs: ['.devcontainer/Dockerfile'] });
    assert.deepEqual(doc.setup, { steps: [] });
    for (const tier of tiers.TIERS) {
      assert.deepEqual(doc.suites[tier], {
        adapter: 'files', cwd: '.', files: ledger[tier], command: command(tier), one_file_per_process: true
      }, tier);
    }
  });

  it('refuses an empty tier by name: Testament refuses a files suite with no files', () => {
    assert.throws(() => tiers.formatTestament({ ...ledger, medium: [] }, { command }), /the "medium" tier is empty/);
  });

  it('builds each tier command from the stage runner, one file at a time, with the placeholders once each', () => {
    for (const tier of tiers.TIERS) {
      const cmd = tiers.testamentCommand(tier);
      assert.deepEqual(cmd, ['node', '--test', '--test-concurrency=1', ...stage.tierArgv(tier, ['{files}'], '{junit}').slice(1)], tier);
      assert.equal(cmd.filter((a) => a === '{files}').length, 1, tier);
      assert.equal(cmd.filter((a) => a.includes('{files}')).length, 1, tier);
      assert.equal(cmd.join('\n').split('{junit}').length - 1, 1, tier);
      assert.equal(cmd.at(-1), '{files}', 'node --test reads everything after the first file as more files');
    }
    assert.ok(tiers.testamentCommand('small').includes('./test/helpers/preload-small.js'));
    assert.ok(tiers.testamentCommand('medium').includes('./test/helpers/preload-medium.js'));
    assert.ok(!tiers.testamentCommand('large').includes('--require'));
  });

  it('bounds a batch well above the per-test timeout of a guarded tier', () => {
    assert.ok(tiers.TESTAMENT_BATCH_TIMEOUT_S * 1000 >= 6 * stage.GUARDED_TIMEOUT_MS);
  });
});

describe('checkManifest: the manifest is exactly what the ledger generates', () => {
  const ledger = { small: ['test/a.test.js'], medium: ['test/b.test.js'], large: ['test/c.test.js'] };
  const command = () => ['node', '{files}', '{junit}'];

  it('passes the generated text', () => {
    assert.deepEqual(tiers.checkManifest(ledger, tiers.formatTestament(ledger, { command }), { command }), []);
  });

  it('names a missing manifest, a changed one and an empty tier, each with the fix', () => {
    assert.deepEqual(tiers.checkManifest(ledger, null, { command }), ['.testament.toml is missing: run `node scripts/test-tiers.js --testament`']);
    const edited = tiers.formatTestament(ledger, { command }).replace('one_file_per_process = true', 'one_file_per_process = false');
    assert.deepEqual(tiers.checkManifest(ledger, edited, { command }), ['.testament.toml is not what test/tiers.json generates: run `node scripts/test-tiers.js --testament`']);
    assert.match(tiers.checkManifest({ ...ledger, large: [] }, '', { command })[0], /the "large" tier is empty/);
  });
});

describe('the tracked manifest (.testament.toml)', () => {
  const manifest = readToml(fs.readFileSync(tiers.DEFAULT_MANIFEST, 'utf8'));

  it('declares every tier as a suite whose files are the ledger\'s, so the suites together are the suite', () => {
    const ledger = tiers.loadLedger();
    assert.deepEqual(Object.keys(manifest.suites), tiers.TIERS);
    for (const tier of tiers.TIERS) assert.deepEqual(manifest.suites[tier].files, ledger[tier], tier);
    const union = tiers.TIERS.flatMap((t) => manifest.suites[t].files).sort();
    assert.deepEqual(union, tiers.suiteFiles());
    assert.equal(new Set(union).size, union.length);
  });

  it('runs each tier the way its stage does, and names an env input that exists', () => {
    for (const tier of tiers.TIERS) assert.deepEqual(manifest.suites[tier].command, tiers.testamentCommand(tier), tier);
    for (const input of manifest.env_inputs) assert.ok(fs.existsSync(path.join(REPO, input)), input);
  });

  it('is refused by --check when edited, and rewritten by --testament', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tier-manifest-'));
    try {
      const manifestPath = path.join(dir, '.testament.toml');
      const out = [];
      const io = { stdout: { write: (s) => out.push(s) }, manifestPath };
      assert.equal(tiers.main(['--check'], io), 1);
      assert.match(out.join(''), /\.testament\.toml is missing/);
      assert.equal(tiers.main(['--testament'], io), 0);
      assert.equal(fs.readFileSync(manifestPath, 'utf8'), fs.readFileSync(tiers.DEFAULT_MANIFEST, 'utf8'));
      out.length = 0;
      assert.equal(tiers.main(['--check'], io), 0, out.join(''));
      assert.match(out.join(''), /\.testament\.toml current/);
      fs.appendFileSync(manifestPath, '# an edit by hand\n');
      out.length = 0;
      assert.equal(tiers.main(['--check'], io), 1);
      assert.match(out.join(''), /\.testament\.toml is not what test\/tiers\.json generates/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes no argument after --testament', () => {
    const out = [];
    assert.equal(tiers.main(['--testament', 'x'], { stdout: { write: (s) => out.push(s) } }), 1);
    assert.match(out.join(''), /\| --testament$/m);
  });
});
