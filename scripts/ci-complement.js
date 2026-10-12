#!/usr/bin/env node
'use strict';

/**
 * Run, on this machine, the tests CI's runner is allowed to skip.
 *
 * A green `test` check never claims the tests `test/skip-ledger.json` names:
 * they need an engine CLI, Caddy, macOS, a non-UTC clock. This script is the
 * other half. It runs exactly those tests here and fails unless every ledger
 * entry this host is expected to run did run and did pass.
 *
 * Nothing a caller types decides what is run or what is expected. Which tests
 * are selected comes from each entry's `match`; whether an entry is expected
 * here comes from its `requires`, measured on this host below. There is no
 * flag to leave an entry out, because "this one does not count on my machine"
 * is the claim the measurements exist to check.
 *
 * It fails closed. A requirement that cannot be measured, an entry whose
 * pattern selects no test, a test expected here that skipped, a report that is
 * missing or empty: each fails the run and is named.
 *
 * Usage: node scripts/ci-complement.js [--list] [--junit <path>]
 *   --list          print each entry, what it requires and what this host
 *                   measures, and run nothing
 *   --junit <path>  where the junit report of the run is written
 * Exit 0 only when every expected entry ran and passed and nothing was
 * unmeasurable.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { compileLedger, DEFAULT_LEDGER, LEDGER_REQUIREMENTS } = require('./test-skip-audit');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const ENGINES_DIR = path.join(ROOT, 'data', 'engines');

/** The answer of a measurement that could not reach a verdict. Never read as true. */
const UNMEASURABLE = 'unmeasurable';

/** The one requirement read per test: the engine is the one the test's own path names. */
const PER_TEST_ENGINE = 'engine-cli:each';

/**
 * Whether a file name that differs only in case is a different file here.
 *
 * @returns {boolean|string} true, false, or UNMEASURABLE when the probe file cannot be made
 */
function measureCaseSensitiveFs() {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-complement-case-'));
    fs.writeFileSync(path.join(dir, 'a'), '');
    return !fs.existsSync(path.join(dir, 'A'));
  } catch {
    return UNMEASURABLE;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether a folder set to mode 000 refuses this process.
 *
 * The same probe as `test/_eacces.js#canForceRefusal`, repeated here because a
 * script does not import a test helper. The two must agree: that helper decides
 * whether the refusal tier skips, and this decides whether a skip is accepted.
 * Unlike the helper, a read that fails some other way is not counted as a
 * refusal.
 *
 * @returns {boolean|string} true on EACCES, false when the read succeeds, else UNMEASURABLE
 */
function measureModeBitsEnforced() {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-complement-eacces-'));
    fs.chmodSync(dir, 0o000);
  } catch {
    return UNMEASURABLE;
  }
  try {
    fs.readdirSync(dir);
    return false;
  } catch (err) {
    return err.code === 'EACCES' ? true : UNMEASURABLE;
  } finally {
    try {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // The probe folder is disposable; leaving it behind changes no answer.
    }
  }
}

/**
 * Whether `expect` is on the PATH, asked the way the runbook test asks.
 *
 * @returns {boolean|string} true, false, or UNMEASURABLE when `sh` cannot be run
 */
function measureExpect() {
  const r = spawnSync('sh', ['-c', 'command -v expect']);
  if (r.error || r.status === null) return UNMEASURABLE;
  return r.status === 0;
}

/**
 * Whether the Prawduct plugin's marketplace checkout is under this user's home.
 * The folder is the one `crossCheckUpstream` in `test/c1-plugin-migration.test.js` is aimed at.
 *
 * @returns {boolean|string} true, false, or UNMEASURABLE when the home folder is unknown
 */
function measurePrawductCheckout() {
  const home = os.homedir();
  if (!home) return UNMEASURABLE;
  return fs.existsSync(path.join(home, '.claude', 'plugins', 'marketplaces', 'prawduct'));
}

/**
 * Which engines are installed here, by the rule `test/engine-launch-flags.test.js`
 * uses to decide whether a launch-flags test runs: the profile's detection
 * target, resolved with `which`. An engine detected some other way has no CLI
 * to probe and reads as not installed; one that declares no launch args has no
 * test in the tier.
 *
 * @returns {Map<string, {installed: boolean, declaresFlags: boolean}>} By engine id
 */
function readEngines() {
  const engines = new Map();
  for (const file of fs.readdirSync(ENGINES_DIR).filter((f) => f.endsWith('.json'))) {
    const profile = JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, file), 'utf8'));
    const command = (profile.detection && profile.detection.strategy === 'which') ? profile.detection.target : null;
    const base = (profile.launch && profile.launch.args) || [];
    const declaresFlags = Object.values(profile.launchModes || {})
      .some((mode) => base.length + ((mode && mode.args) || []).length > 0);
    const installed = Boolean(command) && spawnSync('which', [command], { timeout: 5000 }).status === 0;
    engines.set(profile.id, { installed, declaresFlags });
  }
  return engines;
}

/**
 * How each value on the audit's closed list is measured on this host. A
 * measurement answers true, false or UNMEASURABLE; one that throws is
 * unmeasurable too (`measureHost`).
 *
 * `engine-cli:each` answers with the engines themselves, because it is judged
 * per test and not per entry.
 */
const MEASUREMENTS = Object.freeze({
  'platform:darwin': () => process.platform === 'darwin',
  // The tests' own condition, so the two cannot disagree about a zone whose offset is zero today.
  'timezone:non-utc': () => new Date().getTimezoneOffset() !== 0,
  'filesystem:case-sensitive': measureCaseSensitiveFs,
  'user:mode-bits-enforced': measureModeBitsEnforced,
  // Required here, not at the top: `lib/caddy.js` loads the store, which `--list` on a broken install should survive.
  'command:caddy': () => require('../lib/caddy').detectCaddy().available === true,
  'command:expect': measureExpect,
  'path:/bin/zsh': () => fs.existsSync('/bin/zsh'),
  'caddyfile:live': () => fs.existsSync(require('../lib/caddy').getCaddyfilePath()),
  'prawduct:marketplace-checkout': measurePrawductCheckout,
  'engine-cli:any': () => [...readEngines().values()].some((e) => e.installed && e.declaresFlags),
  [PER_TEST_ENGINE]: () => readEngines()
});

/**
 * Measure this host against every value the ledger may use.
 *
 * Driven by the audit's list, not by this file's table: a value that is listed
 * but has no measurement here is unmeasurable, never true, so the two files
 * cannot drift into an entry that is waved through.
 *
 * @param {Object<string, function(): *>} [measurements] - Seam: value → measurement
 * @param {readonly string[]} [values] - Seam: the closed list
 * @returns {Map<string, *>} value → true, false, UNMEASURABLE, or the engine map for `engine-cli:each`
 */
function measureHost(measurements = MEASUREMENTS, values = LEDGER_REQUIREMENTS) {
  const host = new Map();
  for (const value of values) {
    const measure = Object.hasOwn(measurements, value) ? measurements[value] : null;
    let answer = UNMEASURABLE;
    if (typeof measure === 'function') {
      try {
        answer = measure();
      } catch {
        answer = UNMEASURABLE;
      }
    }
    // The per-test value answers with the engines; every other value with a yes or a no.
    const usable = value === PER_TEST_ENGINE ? answer instanceof Map : (answer === true || answer === false);
    host.set(value, usable ? answer : UNMEASURABLE);
  }
  return host;
}

/**
 * The name pattern that selects an entry's tests: the last ` > ` segment of its
 * `match`. node:test filters by a test's own name, and the ledger matches a
 * full path, so the last segment is the part the runner can be asked for. The
 * report is then checked against the whole `match` (`belongsTo`).
 *
 * @param {{match: RegExp}} entry - A compiled ledger entry
 * @returns {string} A regular expression source for `--test-name-pattern`
 */
function namePattern(entry) {
  return entry.match.source.split(' > ').pop();
}

/**
 * Decode the XML entities node:test's junit reporter writes. `&amp;` first, for
 * the reason `scripts/test-skip-audit.js#decodeXml` gives: the reporter escapes
 * a quote and then escapes that escape.
 *
 * @param {string} s - Attribute text as it appears in the report
 * @returns {string} Decoded text
 */
function decodeXml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'');
}

/**
 * Read one attribute off a tag's attribute text.
 *
 * @param {string} attrs - Everything between the tag name and `>`
 * @param {string} name - Attribute name
 * @returns {string} Decoded value, or '' when absent
 */
function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]) : '';
}

/**
 * Read every test case out of a junit report, with what became of it.
 *
 * The audit's `parseJunit` keeps only the skipped cases, which is all it needs.
 * The complement has to tell passed from failed too, and has to know which
 * suites enclose a case, so it reads the report itself. Same producer, same
 * shape, same care with quoted attribute values.
 *
 * @param {string} xml - The junit report text
 * @returns {Array<{suites: string[], name: string, path: string, status: string, message: string}>}
 *   `status` is `passed`, `failed` or `skipped`; `message` is the skip's or the failure's own.
 */
function parseCases(xml) {
  const stack = [];
  const cases = [];
  let open = null;
  const tagRe = /<(\/?)(testsuite|testcase|skipped|failure|error)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    const [, closing, tag, attrs, selfClosing] = m;
    if (tag === 'testsuite') {
      if (closing) stack.pop();
      else if (!selfClosing) stack.push(attr(attrs, 'name'));
      continue;
    }
    if (tag === 'testcase') {
      if (closing) { open = null; continue; }
      const name = attr(attrs, 'name');
      const one = { suites: [...stack], name, path: [...stack, name].join(' > '), status: 'passed', message: '' };
      cases.push(one);
      open = selfClosing ? null : one;
      continue;
    }
    if (open && !closing) {
      // A failure outranks a skip: a case carrying both did not pass.
      if (tag === 'skipped' && open.status === 'passed') open.status = 'skipped';
      if (tag !== 'skipped') open.status = 'failed';
      open.message = attr(attrs, 'message') || open.message;
    }
  }
  return cases;
}

/**
 * Whether a test case belongs to a ledger entry.
 *
 * An entry's `match` names what CI's report shows when the tier is skipped.
 * Some tiers are skipped as one whole suite, and where such a suite runs the
 * report holds its tests under it. So a case belongs to an entry when the
 * pattern matches the case's own path or the path of a suite enclosing it.
 *
 * @param {{match: RegExp}} entry - A compiled ledger entry
 * @param {{suites: string[], path: string}} testCase - One case from `parseCases`
 * @returns {boolean}
 */
function belongsTo(entry, testCase) {
  if (entry.match.test(testCase.path)) return true;
  for (let depth = testCase.suites.length; depth > 0; depth--) {
    if (entry.match.test(testCase.suites.slice(0, depth).join(' > '))) return true;
  }
  return false;
}

/**
 * The engine a launch-flags test is about: the suite directly under the tier's
 * own, which is how `test/engine-launch-flags.test.js` nests them.
 *
 * @param {{suites: string[]}} testCase - One case from `parseCases`
 * @returns {string|null} The engine id, or null when the path names none
 */
function engineOf(testCase) {
  return testCase.suites.length >= 2 ? testCase.suites[1] : null;
}

/**
 * Judge one ledger entry against what this host measures and what the run did.
 *
 * @param {{id: string, match: RegExp, requires: string[]}} entry - A compiled ledger entry
 * @param {Map<string, *>} host - Output of `measureHost`
 * @param {Array<object>} cases - Output of `parseCases`
 * @returns {{id: string, verdict: string, ok: boolean, ran: boolean, detail: string}}
 *   `verdict` is one of `passed`, `failed`, `skipped`, `matched-nothing`,
 *   `not-expected`, `unmeasurable`. `ok` is false when the entry fails the run;
 *   `ran` is true only when at least one of its tests ran and none failed or
 *   was wrongly skipped.
 */
function judgeEntry(entry, host, cases) {
  const mine = cases.filter((c) => belongsTo(entry, c));
  const fail = (verdict, detail) => ({ id: entry.id, verdict, ok: false, ran: false, detail });

  const unmeasurable = entry.requires.filter((v) => !host.has(v) || host.get(v) === UNMEASURABLE);
  if (unmeasurable.length > 0) return fail('unmeasurable', unmeasurable.join(', '));

  const failed = mine.filter((c) => c.status === 'failed');
  if (failed.length > 0) return fail('failed', failed.map((c) => c.path).join('; '));

  const isFalse = entry.requires.filter((v) => host.get(v) === false);
  if (isFalse.length > 0) {
    return { id: entry.id, verdict: 'not-expected', ok: true, ran: false, detail: `${isFalse.join(', ')} is false` };
  }

  let skipped = mine.filter((c) => c.status === 'skipped');
  if (entry.requires.includes(PER_TEST_ENGINE)) {
    const engines = host.get(PER_TEST_ENGINE);
    const unnamed = mine.filter((c) => !engines.has(engineOf(c)));
    if (unnamed.length > 0) {
      return fail('unmeasurable', `${PER_TEST_ENGINE}: no known engine is named in ${unnamed.map((c) => c.path).join('; ')}`);
    }
    // A skip is accepted only for an engine measured absent.
    skipped = skipped.filter((c) => engines.get(engineOf(c)).installed);
  }
  if (skipped.length > 0) {
    return fail('skipped', skipped.map((c) => `${c.path}${c.message ? ` (${c.message})` : ''}`).join('; '));
  }
  if (mine.length === 0) return fail('matched-nothing', `no test in the run matches ${entry.match.source}`);

  const passed = mine.filter((c) => c.status === 'passed').length;
  if (passed === 0) {
    return { id: entry.id, verdict: 'not-expected', ok: true, ran: false, detail: `${PER_TEST_ENGINE}: no engine its tests name is installed` };
  }
  return { id: entry.id, verdict: 'passed', ok: true, ran: true, detail: `${passed} test${passed === 1 ? '' : 's'}` };
}

/**
 * Judge a whole run.
 *
 * A failed case that belongs to no entry fails the run too: the name patterns
 * can select a test the ledger does not name, and a red test in this run is
 * never a pass.
 *
 * @param {Array<object>} entries - Output of `compileLedger`
 * @param {Map<string, *>} host - Output of `measureHost`
 * @param {Array<object>} cases - Output of `parseCases`
 * @returns {{ok: boolean, results: Array<object>, strayFailures: Array<object>}}
 */
function judgeRun(entries, host, cases) {
  const results = entries.map((e) => judgeEntry(e, host, cases));
  const strayFailures = cases.filter((c) => c.status === 'failed' && !entries.some((e) => belongsTo(e, c)));
  return {
    ok: entries.length > 0 && cases.length > 0 && strayFailures.length === 0 && results.every((r) => r.ok),
    results,
    strayFailures
  };
}

/** How each verdict reads on its line. */
const VERDICT_TEXT = Object.freeze({
  passed: 'ran and passed',
  failed: 'ran and FAILED',
  skipped: 'expected here and SKIPPED',
  'matched-nothing': 'MATCHED NOTHING',
  'not-expected': 'not expected here',
  unmeasurable: 'UNMEASURABLE'
});

/**
 * Render a judged run: one line per entry, then one last line that says how
 * many entries ran here and names each that did not, with why.
 *
 * @param {ReturnType<typeof judgeRun>} run - The verdict
 * @returns {string} The lines, newline-terminated
 */
function formatRun(run) {
  const lines = run.results.map((r) => `${VERDICT_TEXT[r.verdict]}: ${r.id} (${r.detail})`);
  for (const c of run.strayFailures) lines.push(`ran and FAILED, on no ledger entry: ${c.path}`);
  const ran = run.results.filter((r) => r.ran).length;
  const notRun = run.results.filter((r) => !r.ran).map((r) => `${r.id} (${VERDICT_TEXT[r.verdict]}: ${r.detail})`);
  lines.push(
    `${run.ok ? 'COMPLEMENT GREEN' : 'COMPLEMENT RED'}: ${ran} of ${run.results.length} ledger entries ran here`
    + (notRun.length > 0 ? `; did not: ${notRun.join('; ')}` : '')
  );
  return `${lines.join('\n')}\n`;
}

/**
 * Render what `--list` prints: each entry, what it requires and what this host
 * measures for each value.
 *
 * @param {Array<{id: string, requires: string[]}>} entries - Output of `compileLedger`
 * @param {Map<string, *>} host - Output of `measureHost`
 * @returns {string} The lines, newline-terminated
 */
function formatList(entries, host) {
  const show = (value) => {
    const answer = host.has(value) ? host.get(value) : UNMEASURABLE;
    if (!(answer instanceof Map)) return `${value} is ${answer}`;
    const installed = [...answer].filter(([, e]) => e.installed).map(([id]) => id);
    return `${value}: installed here: ${installed.length > 0 ? installed.join(', ') : 'none'}`;
  };
  return `${entries.map((e) => `${e.id}: ${e.requires.map(show).join('; ')}`).join('\n')}\n`;
}

/**
 * Run the suite's files with the entries' name patterns and write a junit report.
 *
 * Every test file is handed to the runner, because the report names no file
 * for a test and the ledger names none either; the patterns do the selecting.
 *
 * @param {string[]} patterns - One `--test-name-pattern` source per entry
 * @param {string} junitPath - Where the report goes
 * @returns {void}
 */
function runTests(patterns, junitPath) {
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js')).sort()
    .map((f) => path.join('test', f));
  spawnSync(process.execPath, [
    '--test',
    ...patterns.map((p) => `--test-name-pattern=${p}`),
    '--test-reporter=junit',
    `--test-reporter-destination=${junitPath}`,
    ...files
  ], { cwd: ROOT, stdio: 'ignore' });
}

/**
 * Parse argv.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{list: boolean, junitPath: string|null}}
 */
function parseArgs(argv) {
  const parsed = { list: false, junitPath: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') {
      parsed.list = true;
    } else if (argv[i] === '--junit') {
      parsed.junitPath = argv[++i];
      if (!parsed.junitPath) throw new Error('--junit needs a path');
    } else {
      throw new Error(`unknown argument "${argv[i]}"\nusage: ci-complement.js [--list] [--junit <path>]`);
    }
  }
  return parsed;
}

/**
 * Run the complement end to end and return the process exit code.
 *
 * The seams exist for the tests: a caller on the command line reaches none of
 * them, so nothing typed can change the ledger, the measurements or the run.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {object} [io] - Injection seams
 * @param {{write: function(string): any}} [io.stdout] - Where the lines go
 * @param {string} [io.ledgerPath] - The ledger to read
 * @param {Object<string, function(): *>} [io.measurements] - value → measurement
 * @param {function(string[], string): void} [io.run] - Runs the tests and writes the report
 * @returns {number} 0 when the complement is green, 1 otherwise
 */
function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const run = io.run || runTests;
  let parsed;
  let entries;
  try {
    parsed = parseArgs(argv);
    entries = compileLedger(JSON.parse(fs.readFileSync(io.ledgerPath || DEFAULT_LEDGER, 'utf8')));
  } catch (err) {
    out.write(`${err.message}\n`);
    return 1;
  }
  if (entries.length === 0) {
    out.write('the skip ledger has no entries, so there is nothing to run and nothing was certified\n');
    return 1;
  }
  const host = measureHost(io.measurements || MEASUREMENTS);
  if (parsed.list) {
    out.write(formatList(entries, host));
    return 0;
  }

  const junitPath = parsed.junitPath
    || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ci-complement-')), 'ci-complement.xml');
  // A report left by an earlier run must never be read as this one's.
  fs.rmSync(junitPath, { force: true });
  run(entries.map(namePattern), junitPath);
  if (!fs.existsSync(junitPath)) {
    out.write(`report not found: ${junitPath}. The run wrote no junit output, so nothing was certified\n`);
    return 1;
  }
  const cases = parseCases(fs.readFileSync(junitPath, 'utf8'));
  if (cases.length === 0) {
    out.write(`no test cases in ${junitPath}: nothing was certified\n`);
    return 1;
  }
  const verdict = judgeRun(entries, host, cases);
  // The report's path first: the summary is the run's last line.
  out.write(`junit report: ${junitPath}\n`);
  out.write(formatRun(verdict));
  return verdict.ok ? 0 : 1;
}

module.exports = {
  UNMEASURABLE, PER_TEST_ENGINE, MEASUREMENTS,
  measureHost, readEngines, namePattern, parseCases, belongsTo, judgeEntry, judgeRun,
  formatRun, formatList, parseArgs, main
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
