'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const complement = require('../scripts/ci-complement');
const skipAudit = require('../scripts/test-skip-audit');

const { UNMEASURABLE, PER_TEST_ENGINE } = complement;

/**
 * Build a junit document in the shape node:test's reporter emits.
 *
 * @param {string} body - Inner `<testsuite>` and `<testcase>` markup
 * @returns {string} A complete report
 */
function junit(body) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${body}\n</testsuites>\n`;
}

/**
 * One `<testcase>`, passed unless a child says otherwise.
 *
 * @param {string} name - The test's own name
 * @param {string} [child] - `<skipped .../>` or `<failure .../>` markup
 * @returns {string}
 */
function testcase(name, child) {
  return child
    ? `<testcase name="${name}" time="0.1" classname="test">${child}</testcase>`
    : `<testcase name="${name}" time="0.1" classname="test"/>`;
}

/**
 * One `<testsuite>` around some markup.
 *
 * @param {string} name - The suite's name
 * @param {string} inner - What it encloses
 * @returns {string}
 */
function suite(name, inner) {
  return `<testsuite name="${name}">${inner}</testsuite>`;
}

const SKIPPED = '<skipped type="skipped" message="not on this host"/>';
const FAILED = '<failure type="testCodeFailure" message="boom">stack</failure>';

/**
 * A ledger entry as `compileLedger` returns it.
 *
 * @param {string} id - Entry id
 * @param {string} match - Pattern source over the full path
 * @param {string[]} requires - Host requirements
 * @returns {{id: string, match: RegExp, requires: string[]}}
 */
function entry(id, match, requires) {
  return { id, match: new RegExp(match), requires };
}

/**
 * A measured host: every value on the closed list true, then the overrides.
 *
 * @param {Object<string, *>} [overrides] - value → answer
 * @returns {Map<string, *>}
 */
function hostWith(overrides = {}) {
  const host = new Map(skipAudit.LEDGER_REQUIREMENTS.map((v) => [v, true]));
  host.set(PER_TEST_ENGINE, new Map());
  for (const [value, answer] of Object.entries(overrides)) host.set(value, answer);
  return host;
}

/**
 * An engine map for `engine-cli:each`.
 *
 * @param {Object<string, boolean>} installed - engine id → installed here
 * @returns {Map<string, {installed: boolean, declaresFlags: boolean}>}
 */
function engines(installed) {
  return new Map(Object.entries(installed).map(([id, yes]) => [id, { installed: yes, declaresFlags: true }]));
}

const DARWIN = entry('pty', '^watcher > reads the real ps output$', ['platform:darwin']);
const ONE_PASSED = junit(suite('watcher', testcase('reads the real ps output')));

describe('ci-complement — reading the report', () => {
  it('reads every case with its enclosing suites and what became of it', () => {
    const cases = complement.parseCases(junit(
      suite('outer', [
        testcase('passes'),
        testcase('skips', SKIPPED),
        suite('inner', testcase('fails', FAILED))
      ].join(''))
    ));
    assert.deepEqual(cases.map((c) => [c.path, c.status]), [
      ['outer > passes', 'passed'],
      ['outer > skips', 'skipped'],
      ['outer > inner > fails', 'failed']
    ]);
    assert.deepEqual(cases[2].suites, ['outer', 'inner']);
    assert.equal(cases[1].message, 'not on this host');
    assert.equal(cases[2].message, 'boom');
  });

  it('reads an <error> child as a failure, not a pass', () => {
    const [one] = complement.parseCases(junit(testcase('loads', '<error type="x" message="could not load"/>')));
    assert.equal(one.status, 'failed');
  });

  it('keeps a name whose value carries a bare > or spans the reporter\'s double escape', () => {
    const [one] = complement.parseCases(junit(testcase('launch mode &amp;quot;auto&amp;quot; in wrap/&lt;ts>-&lt;slug>')));
    assert.equal(one.name, 'launch mode "auto" in wrap/<ts>-<slug>');
    assert.equal(one.status, 'passed');
  });
});

describe('ci-complement — which tests an entry selects and owns', () => {
  it('asks the runner for the last segment of the entry\'s match', () => {
    assert.equal(
      complement.namePattern(entry('x', '^projects > updateProject > .* > allows a case-only self-rename .*$', ['platform:darwin'])),
      'allows a case-only self-rename .*$'
    );
    assert.equal(complement.namePattern(entry('y', '^offbox guard — against real caddy$', ['command:caddy'])), '^offbox guard — against real caddy$');
  });

  it('builds a pattern for every entry of the tracked ledger that node accepts as a regular expression', () => {
    const tracked = skipAudit.compileLedger(JSON.parse(fs.readFileSync(skipAudit.DEFAULT_LEDGER, 'utf8')));
    for (const e of tracked) assert.doesNotThrow(() => new RegExp(complement.namePattern(e)), e.id);
  });

  it('counts a case under a suite the entry matches', () => {
    const e = entry('caddy', '^offbox guard — against real caddy$', ['command:caddy']);
    const [inSuite] = complement.parseCases(junit(suite('offbox guard — against real caddy', testcase('guards a real file'))));
    assert.equal(complement.belongsTo(e, inSuite), true);
  });

  it('counts a case under a matching suite that is itself nested', () => {
    const e = entry('gate', '^the fallback marker > against real caddy$', ['command:caddy']);
    const [deep] = complement.parseCases(junit(
      suite('the fallback marker', suite('against real caddy', suite('armed', testcase('refuses'))))
    ));
    assert.equal(complement.belongsTo(e, deep), true);
  });

  it('does not count a case whose path merely contains the suite\'s text elsewhere', () => {
    const e = entry('caddy', '^offbox guard — against real caddy$', ['command:caddy']);
    const cases = complement.parseCases(junit([
      // The text is the test's own name, under a different suite.
      suite('notes', testcase('offbox guard — against real caddy')),
      // The text is one suite name of two that only read alike when joined.
      suite('offbox guard — against real caddy > extra', testcase('a test')),
      // The text is an inner suite, not the top-level one the anchored pattern names.
      suite('wrapper', suite('offbox guard — against real caddy', testcase('a test')))
    ].join('')));
    assert.deepEqual(cases.map((c) => complement.belongsTo(e, c)), [false, false, false]);
  });
});

describe('ci-complement — judging one entry', () => {
  it('an entry whose test ran and passed ran here', () => {
    const r = complement.judgeEntry(DARWIN, hostWith(), complement.parseCases(ONE_PASSED));
    assert.deepEqual([r.verdict, r.ok, r.ran, r.detail], ['passed', true, true, '1 test']);
  });

  it('an entry whose test failed fails the run', () => {
    const cases = complement.parseCases(junit(suite('watcher', testcase('reads the real ps output', FAILED))));
    const r = complement.judgeEntry(DARWIN, hostWith(), cases);
    assert.deepEqual([r.verdict, r.ok, r.ran], ['failed', false, false]);
    assert.match(r.detail, /watcher > reads the real ps output/);
  });

  it('an entry expected here whose test skipped is not a pass, and carries the test\'s own reason', () => {
    const cases = complement.parseCases(junit(suite('watcher', testcase('reads the real ps output', SKIPPED))));
    const r = complement.judgeEntry(DARWIN, hostWith(), cases);
    assert.deepEqual([r.verdict, r.ok, r.ran], ['skipped', false, false]);
    assert.match(r.detail, /not on this host/);
  });

  it('an entry whose pattern matches no test is not a pass, and is named', () => {
    const r = complement.judgeEntry(DARWIN, hostWith(), complement.parseCases(junit(suite('other', testcase('unrelated')))));
    assert.deepEqual([r.verdict, r.ok, r.ran], ['matched-nothing', false, false]);
    assert.match(r.detail, /reads the real ps output/);
  });

  it('an entry with a requirement measured false is not expected here and does not fail the run', () => {
    const cases = complement.parseCases(junit(suite('watcher', testcase('reads the real ps output', SKIPPED))));
    const r = complement.judgeEntry(DARWIN, hostWith({ 'platform:darwin': false }), cases);
    assert.deepEqual([r.verdict, r.ok, r.ran, r.detail], ['not-expected', true, false, 'platform:darwin is false']);
  });

  it('an entry not expected here whose test ran anyway and failed still fails the run', () => {
    const cases = complement.parseCases(junit(suite('watcher', testcase('reads the real ps output', FAILED))));
    const r = complement.judgeEntry(DARWIN, hostWith({ 'platform:darwin': false }), cases);
    assert.deepEqual([r.verdict, r.ok], ['failed', false]);
  });

  it('an unmeasurable requirement fails the run and is named, even when the test passed', () => {
    const r = complement.judgeEntry(DARWIN, hostWith({ 'platform:darwin': UNMEASURABLE }), complement.parseCases(ONE_PASSED));
    assert.deepEqual([r.verdict, r.ok, r.ran, r.detail], ['unmeasurable', false, false, 'platform:darwin']);
  });

  it('a requirement the host was never measured for is unmeasurable, not true', () => {
    const host = hostWith();
    host.delete('platform:darwin');
    assert.equal(complement.judgeEntry(DARWIN, host, complement.parseCases(ONE_PASSED)).verdict, 'unmeasurable');
  });

  it('needs every requirement to hold: one false among several is not expected here', () => {
    const e = entry('runbook', '^runbooks > typed into zsh$', ['platform:darwin', 'path:/bin/zsh', 'command:expect']);
    const cases = complement.parseCases(junit(suite('runbooks', testcase('typed into zsh', SKIPPED))));
    const r = complement.judgeEntry(e, hostWith({ 'command:expect': false }), cases);
    assert.deepEqual([r.verdict, r.detail], ['not-expected', 'command:expect is false']);
  });
});

describe('ci-complement — the case-only rename tier', () => {
  const tracked = skipAudit.compileLedger(JSON.parse(fs.readFileSync(skipAudit.DEFAULT_LEDGER, 'utf8')));
  const caseOnly = tracked.find((e) => e.id === 'case-insensitive-fs');
  const skippedHere = complement.parseCases(junit(
    suite('projects', suite('updateProject', suite('rename — case-insensitive collision handling (#221, sibling to #188)',
      testcase('allows a case-only self-rename at the DB-validator level (foo-1 → Foo-1)', SKIPPED))))
  ));

  it('is not expected on a case-insensitive filesystem, and its skip does not fail the run', () => {
    const r = complement.judgeEntry(caseOnly, hostWith({ 'filesystem:case-sensitive': false }), skippedHere);
    assert.deepEqual([r.verdict, r.ok, r.detail], ['not-expected', true, 'filesystem:case-sensitive is false']);
  });

  it('fails the run when the filesystem is case-sensitive and the test skipped', () => {
    const r = complement.judgeEntry(caseOnly, hostWith({ 'filesystem:case-sensitive': true }), skippedHere);
    assert.deepEqual([r.verdict, r.ok], ['skipped', false]);
  });
});

describe('ci-complement — engine-cli:each, judged per test', () => {
  const flags = entry('flags', '^engine launch flags > [a-z0-9-]+ > launch mode "[^"]+" is accepted$', [PER_TEST_ENGINE]);
  const run = (claude, codex) => complement.parseCases(junit(suite('engine launch flags', [
    suite('claude', testcase('launch mode &amp;quot;auto&amp;quot; is accepted', claude)),
    suite('codex', testcase('launch mode &amp;quot;auto&amp;quot; is accepted', codex))
  ].join(''))));

  it('accepts a skip for an engine measured absent, and the entry ran on the one that is here', () => {
    const host = hostWith({ [PER_TEST_ENGINE]: engines({ claude: true, codex: false }) });
    const r = complement.judgeEntry(flags, host, run(undefined, SKIPPED));
    assert.deepEqual([r.verdict, r.ok, r.ran, r.detail], ['passed', true, true, '1 test']);
  });

  it('fails on a skip for an engine measured present', () => {
    const host = hostWith({ [PER_TEST_ENGINE]: engines({ claude: true, codex: true }) });
    const r = complement.judgeEntry(flags, host, run(undefined, SKIPPED));
    assert.deepEqual([r.verdict, r.ok], ['skipped', false]);
    assert.match(r.detail, /engine launch flags > codex > /);
  });

  it('did not run here when every engine its tests name is absent, and that is not a failure', () => {
    const host = hostWith({ [PER_TEST_ENGINE]: engines({ claude: false, codex: false }) });
    const r = complement.judgeEntry(flags, host, run(SKIPPED, SKIPPED));
    assert.deepEqual([r.verdict, r.ok, r.ran], ['not-expected', true, false]);
  });

  it('is unmeasurable when a test names an engine no profile knows', () => {
    const host = hostWith({ [PER_TEST_ENGINE]: engines({ claude: true }) });
    const r = complement.judgeEntry(flags, host, run(undefined, SKIPPED));
    assert.deepEqual([r.verdict, r.ok], ['unmeasurable', false]);
    assert.match(r.detail, /codex/);
  });

  it('is unmeasurable when the profiles could not be read', () => {
    const r = complement.judgeEntry(flags, hostWith({ [PER_TEST_ENGINE]: UNMEASURABLE }), run(undefined, undefined));
    assert.deepEqual([r.verdict, r.ok], ['unmeasurable', false]);
  });
});

describe('ci-complement — measuring the host', () => {
  it('has a measurement for every value on the audit\'s closed list', () => {
    assert.deepEqual(Object.keys(complement.MEASUREMENTS).sort(), [...skipAudit.LEDGER_REQUIREMENTS].sort());
  });

  it('reads a listed value with no measurement as unmeasurable, never true', () => {
    const host = complement.measureHost({ 'platform:darwin': () => true }, ['platform:darwin', 'a:new-value']);
    assert.equal(host.get('platform:darwin'), true);
    assert.equal(host.get('a:new-value'), UNMEASURABLE);
  });

  it('reads a measurement that throws, or answers something that is not yes or no, as unmeasurable', () => {
    const host = complement.measureHost({
      'platform:darwin': () => { throw new Error('cannot tell'); },
      'command:caddy': () => 'yes',
      'command:expect': () => undefined,
      [PER_TEST_ENGINE]: () => true
    }, ['platform:darwin', 'command:caddy', 'command:expect', PER_TEST_ENGINE]);
    assert.deepEqual([...host.values()], [UNMEASURABLE, UNMEASURABLE, UNMEASURABLE, UNMEASURABLE]);
  });

  it('measures this host to a yes or a no for the values that can always be read', () => {
    const host = complement.measureHost();
    for (const value of ['platform:darwin', 'timezone:non-utc', 'path:/bin/zsh']) {
      assert.equal(typeof host.get(value), 'boolean', value);
    }
    assert.equal(host.get('platform:darwin'), process.platform === 'darwin');
  });

  it('reads the shipped engine profiles, each with whether it is installed and declares flags', () => {
    const shipped = complement.readEngines();
    assert.ok(shipped.size > 0);
    for (const [id, e] of shipped) {
      assert.equal(typeof e.installed, 'boolean', id);
      assert.equal(typeof e.declaresFlags, 'boolean', id);
    }
    // The launch-flags tier has a test for claude, so the profile must read as declaring flags.
    assert.equal(shipped.get('claude').declaresFlags, true);
  });
});

describe('ci-complement — the run, end to end through its seams', () => {
  /**
   * Run `main` against a temporary ledger with a fake test run.
   *
   * @param {object} opts
   * @param {Array<object>|string|null} opts.entries - Ledger entries, raw ledger text, or null for no file
   * @param {string|null} [opts.report] - What the fake run writes, or null to write nothing
   * @param {Object<string, function>} [opts.measurements] - value → measurement
   * @param {string[]} [opts.argv] - Arguments
   * @param {string|null} [opts.stopped] - What the fake run answers: why it stopped early, or null
   * @returns {{code: number, out: string, runs: Array<{patterns: string[], junitPath: string}>, dir: string}}
   */
  function runMain({ entries, report = ONE_PASSED, measurements, argv = [], stopped = null }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-complement-test-'));
    const ledgerPath = path.join(dir, 'ledger.json');
    if (typeof entries === 'string') fs.writeFileSync(ledgerPath, entries);
    else if (entries) fs.writeFileSync(ledgerPath, JSON.stringify({ entries }));
    const runs = [];
    let out = '';
    const code = complement.main(argv, {
      ledgerPath,
      measurements: measurements || { 'platform:darwin': () => true, 'filesystem:case-sensitive': () => false },
      stdout: { write: (s) => { out += s; } },
      run: (patterns, junitPath) => {
        runs.push({ patterns, junitPath });
        if (report !== null) fs.writeFileSync(junitPath, report);
        return stopped;
      }
    });
    return { code, out, runs, dir };
  }

  const PTY = {
    id: 'pty', match: '^watcher > reads the real ps output$', why: 'linux runner', runsWhere: 'macOS', requires: ['platform:darwin']
  };
  const CASE = {
    id: 'case-only', match: '^projects > case-only rename$', why: 'APFS', runsWhere: 'the runner', requires: ['filesystem:case-sensitive']
  };

  it('is green when the expected entry ran and passed, and the last line counts what ran and names what did not', (t) => {
    const r = runMain({ entries: [PTY, CASE] });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    assert.equal(r.code, 0);
    assert.deepEqual(r.runs[0].patterns, ['reads the real ps output$', 'case-only rename$']);
    const lines = r.out.trimEnd().split('\n');
    assert.ok(lines.includes('ran and passed: pty (1 test)'));
    assert.ok(lines.includes('not expected here: case-only (filesystem:case-sensitive is false)'));
    assert.equal(
      lines.at(-1),
      'COMPLEMENT GREEN: 1 of 2 ledger entries ran here; did not: case-only (not expected here: filesystem:case-sensitive is false)'
    );
  });

  it('is red when an expected test skipped, and says so on the last line', (t) => {
    const r = runMain({ entries: [PTY], report: junit(suite('watcher', testcase('reads the real ps output', SKIPPED))) });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    assert.equal(r.code, 1);
    assert.match(r.out.trimEnd().split('\n').at(-1), /^COMPLEMENT RED: 0 of 1 ledger entries ran here; did not: pty \(expected here and SKIPPED: /);
  });

  it('is red when a selected test on no ledger entry failed', (t) => {
    const report = junit(suite('watcher', testcase('reads the real ps output') + testcase('a neighbour the pattern also selected', FAILED)));
    const r = runMain({ entries: [PTY], report });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    assert.equal(r.code, 1);
    assert.match(r.out, /ran and FAILED, on no ledger entry: watcher > a neighbour the pattern also selected/);
  });

  it('is red when a requirement is unmeasurable, though the test passed', (t) => {
    const r = runMain({ entries: [PTY], measurements: { 'platform:darwin': () => { throw new Error('no'); } } });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    assert.equal(r.code, 1);
    assert.match(r.out, /^UNMEASURABLE: pty \(platform:darwin\)$/m);
  });

  it('fails on a ledger with no entries, and runs nothing', (t) => {
    const r = runMain({ entries: [] });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    assert.equal(r.code, 1);
    assert.equal(r.runs.length, 0);
    assert.match(r.out, /nothing was certified/);
  });

  it('fails on an unreadable ledger: missing, not JSON, or an entry without requires', (t) => {
    const noRequires = { ...PTY };
    delete noRequires.requires;
    const tried = [runMain({ entries: null }), runMain({ entries: '{ not json' }), runMain({ entries: [noRequires] })];
    t.after(() => tried.forEach((r) => fs.rmSync(r.dir, { recursive: true, force: true })));
    for (const r of tried) {
      assert.equal(r.code, 1);
      assert.equal(r.runs.length, 0);
      assert.notEqual(r.out, '');
    }
    assert.match(tried[2].out, /missing `requires`/);
  });

  it('fails when the run wrote no report', (t) => {
    const r = runMain({ entries: [PTY], report: null });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    assert.equal(r.code, 1);
    assert.match(r.out, /report not found: .*nothing was certified/);
  });

  it('fails when the report holds no test case', (t) => {
    const r = runMain({ entries: [PTY], report: junit('') });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    assert.equal(r.code, 1);
    assert.match(r.out, /no test cases in .*nothing was certified/);
  });

  it('never reads a report an earlier run left at the same path', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-complement-stale-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stale = path.join(dir, 'old.xml');
    fs.writeFileSync(stale, ONE_PASSED);
    const r = runMain({ entries: [PTY], report: null, argv: ['--junit', stale] });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    assert.equal(r.code, 1);
    assert.match(r.out, /report not found/);
  });

  it('writes the report where --junit says', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-complement-junit-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const wanted = path.join(dir, 'complement.xml');
    const r = runMain({ entries: [PTY], argv: ['--junit', wanted] });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    assert.equal(r.code, 0);
    assert.equal(r.runs[0].junitPath, wanted);
    assert.ok(r.out.includes(`junit report: ${wanted}\n`));
  });

  it('hands the run an absolute report path when --junit is relative, and reads the report from the same place', (t) => {
    const r = runMain({ entries: [PTY], argv: ['--junit', path.join('some', 'where', 'complement.xml')], report: null });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    const handed = r.runs[0].junitPath;
    assert.equal(path.isAbsolute(handed), true);
    assert.equal(handed, path.resolve('some', 'where', 'complement.xml'));
    assert.ok(r.out.includes(`report not found: ${handed}.`));
  });

  it('is red when the run could not start, and says why beside the missing report', (t) => {
    const r = runMain({ entries: [PTY], report: null, stopped: 'the test run could not start: spawn ENOENT' });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    assert.equal(r.code, 1);
    assert.match(r.out, /^the test run could not start: spawn ENOENT\nreport not found: /);
  });

  it('is red when the run was killed, even though a report with a passing test was written', (t) => {
    const r = runMain({ entries: [PTY], stopped: 'the test run was killed by SIGTERM' });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    assert.equal(r.code, 1);
    assert.match(r.out, /killed by SIGTERM/);
    assert.match(r.out, /not a whole report and nothing was certified/);
    assert.doesNotMatch(r.out, /COMPLEMENT GREEN/);
  });

  /**
   * Run `runComplement` and `main` against the same ledger and the same fake run.
   *
   * @param {import('node:test').TestContext} t - The test, for cleanup
   * @param {Array<object>|string} entries - Ledger entries, or raw ledger text
   * @param {string|null} report - What the fake run writes, or null to write nothing
   * @param {string|null} [stopped] - What the fake run answers
   * @returns {{verdict: object, printed: {code: number, out: string}}}
   */
  function bothWays(t, entries, report, stopped = null) {
    const printed = runMain({ entries, report, stopped });
    t.after(() => fs.rmSync(printed.dir, { recursive: true, force: true }));
    const verdict = complement.runComplement({
      ledgerPath: path.join(printed.dir, 'ledger.json'),
      measurements: { 'platform:darwin': () => true, 'filesystem:case-sensitive': () => false },
      junitPath: path.join(printed.dir, 'value.xml'),
      run: (_patterns, junitPath) => {
        if (report !== null) fs.writeFileSync(junitPath, report);
        return stopped;
      }
    });
    return { verdict, printed };
  }

  it('runComplement answers with the verdict main prints: green, with each entry and what the host measured', (t) => {
    const { verdict, printed } = bothWays(t, [PTY, CASE], ONE_PASSED);
    assert.equal(printed.code, 0);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.problems, []);
    assert.equal(verdict.stopped, null);
    assert.deepEqual(verdict.strayFailures, []);
    assert.deepEqual(verdict.results.map((r) => [r.id, r.verdict, r.ran]), [['pty', 'passed', true], ['case-only', 'not-expected', false]]);
    assert.deepEqual(verdict.entries.map((e) => [e.id, e.requires]), [['pty', ['platform:darwin']], ['case-only', ['filesystem:case-sensitive']]]);
    assert.equal(verdict.host.get('platform:darwin'), true);
    assert.equal(verdict.host.get('filesystem:case-sensitive'), false);
    assert.equal(verdict.junitPath, path.join(printed.dir, 'value.xml'));
    assert.ok(printed.out.endsWith(complement.formatRun(verdict)), 'main prints the same verdict');
  });

  it('runComplement answers red when main is red, with the same lines', (t) => {
    const { verdict, printed } = bothWays(t, [PTY], junit(suite('watcher', testcase('reads the real ps output', SKIPPED))));
    assert.equal(printed.code, 1);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.problems, []);
    assert.equal(verdict.results[0].verdict, 'skipped');
    assert.ok(printed.out.endsWith(complement.formatRun(verdict)));
  });

  it('runComplement is never ok when nothing was judged, and says why in the words main prints', (t) => {
    for (const [entries, report, stopped] of [
      ['{ not json', ONE_PASSED, null],
      [[], ONE_PASSED, null],
      [[PTY], null, null],
      [[PTY], junit(''), null],
      [[PTY], null, 'the test run could not start: spawn ENOENT'],
      [[PTY], ONE_PASSED, 'the test run was killed by SIGTERM']
    ]) {
      const { verdict, printed } = bothWays(t, entries, report, stopped);
      assert.equal(printed.code, 1);
      assert.equal(verdict.ok, false);
      assert.deepEqual(verdict.results, []);
      assert.ok(verdict.problems.length > 0);
      // The report's path differs between the two runs; every other word is the same.
      const words = (text, file) => text.split(file).join('<report>');
      assert.equal(
        words(`${verdict.problems.join('\n')}\n`, verdict.junitPath || ''),
        words(printed.out, printed.runs[0] ? printed.runs[0].junitPath : '')
      );
    }
  });

  it('--list prints each entry with what it requires and what this host measures, and runs nothing', (t) => {
    const r = runMain({ entries: [PTY, CASE], argv: ['--list'] });
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    assert.equal(r.code, 0);
    assert.equal(r.runs.length, 0);
    assert.equal(r.out, 'pty: platform:darwin is true\ncase-only: filesystem:case-sensitive is false\n');
  });

  it('--list names the engines installed here for the per-test value', () => {
    const out = complement.formatList(
      [entry('flags', '^x$', [PER_TEST_ENGINE])],
      hostWith({ [PER_TEST_ENGINE]: engines({ claude: true, codex: false }) })
    );
    assert.equal(out, 'flags: engine-cli:each: installed here: claude\n');
  });

  it('takes no argument that could leave an entry out or point at another ledger', (t) => {
    for (const argv of [['--not-here', 'pty'], ['--ledger', 'x.json'], ['--skip', 'pty'], ['pty'], ['--junit']]) {
      const r = runMain({ entries: [PTY], argv });
      t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
      assert.equal(r.code, 1, argv.join(' '));
      assert.equal(r.runs.length, 0, argv.join(' '));
    }
  });
});
