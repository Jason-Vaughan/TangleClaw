'use strict';

/**
 * `lib/test-results.js`: the one reader of what a `node --test` run reported
 * (#2498 W4-02).
 *
 * The fixtures below are the shapes node 22's junit reporter and summary were
 * MEASURED to produce, one per way the two sides label a node differently: a
 * `test()` with subtests (a test to the runner, a `<testsuite>` to the
 * reporter), a `describe` whose body threw (a suite to the runner with `fail
 * 0` and exit 0, a `<testcase>` with a `<failure>` to the reporter), a skipped
 * `describe` (a suite to the runner, a skipped `<testcase>` to the reporter),
 * a cancelled test, a parent failing through its child, and a file that threw
 * at load. The identity they all obey, testcases + testsuites == tests +
 * suites, is what `reconcile` holds a report to.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const results = require('../lib/test-results');
const skipAudit = require('../scripts/test-skip-audit');

/**
 * Render the trailing comments the junit reporter writes from a summary.
 *
 * @param {object} summary - Counter values by name
 * @returns {string}
 */
function trailer(summary) {
  return Object.entries(summary).map(([k, v]) => `\t<!-- ${k} ${v} -->`).join('\n');
}

/**
 * Build a junit document in the shape node:test's reporter emits, with the
 * runner's summary as its trailing comments.
 *
 * @param {string} body - Inner markup
 * @param {object} [summary] - The summary to write as comments; omitted for a report with none
 * @returns {string}
 */
function junit(body, summary) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${body}\n${summary ? `${trailer(summary)}\n` : ''}</testsuites>\n`;
}

/** The lines the spec reporter prints for the same summary. */
function specLines(summary) {
  return Object.entries(summary).map(([k, v]) => `ℹ ${k} ${v}`).join('\n');
}

const SUITE = (name, tests, failures, skipped, inner) => `\t<testsuite name="${name}" time="0.001" disabled="0" errors="0" tests="${tests}" failures="${failures}" skipped="${skipped}" hostname="h">\n${inner}\n\t</testsuite>`;
const CASE = (name) => `\t\t<testcase name="${name}" time="0.0001" classname="test"/>`;
const SKIPPED_CASE = (name, type, message) => `\t\t<testcase name="${name}" time="0.0001" classname="test">\n\t\t\t<skipped type="${type}" message="${message}"/>\n\t\t</testcase>`;
const FAILED_CASE = (name, type, message) => `\t\t<testcase name="${name}" time="0.0001" classname="test" failure="${message}">\n\t\t\t<failure type="${type}" message="${message}">\nError: ${message}\n    at Object.&lt;anonymous> (/x/y.test.js:2:1)\n\t\t\t</failure>\n\t\t</testcase>`;

// A `test()` with two subtests, a describe with a skip, a dynamic skip and a
// todo, a top-level skipped test, a plain test. Runner: 9 tests (the parent
// counts), 1 suite (the describe only). Report: 8 testcases, 2 testsuites.
const SUBTESTS_SUMMARY = { tests: 9, suites: 1, pass: 5, fail: 0, cancelled: 0, skipped: 3, todo: 1, duration_ms: 86.973708 };
const SUBTESTS_BODY = [
  SUITE('parent with subtests', 2, 0, 0, [CASE('child a'), CASE('child b')].join('\n')),
  SUITE('suite', 4, 0, 3, [CASE('one'), SKIPPED_CASE('two skipped', 'skipped', 'true'), SKIPPED_CASE('dynamic skip', 'skipped', 'because'), SKIPPED_CASE('todo one', 'todo', 'true')].join('\n')),
  SKIPPED_CASE('top-level skipped', 'skipped', 'true').replace(/^\t\t/gm, '\t'),
  CASE('plain').replace(/^\t\t/, '\t')
].join('\n');
const SUBTESTS = junit(SUBTESTS_BODY, SUBTESTS_SUMMARY);

// A describe whose body threw before its tests ran. Runner: 1 test, 2 suites,
// fail 0, and the process exits 0. Report: a top-level <testcase> carrying a
// <failure>, plus the suite that ran.
const DESCRIBE_THREW_SUMMARY = { tests: 1, suites: 2, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
const DESCRIBE_THREW = junit([
  FAILED_CASE('throws at describe time', 'testCodeFailure', 'boom at describe').replace(/^\t\t/gm, '\t'),
  SUITE('ok after', 1, 0, 0, CASE('fine'))
].join('\n'), DESCRIBE_THREW_SUMMARY);

// A file that threw at load: one testcase named for the file, counted as a
// failed test by the runner.
const LOAD_THREW = junit(FAILED_CASE('c-load-throws.test.js', 'testCodeFailure', 'test failed').replace(/^\t\t/gm, '\t'),
  { tests: 1, suites: 0, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0 });

// A before hook that threw: both tests cancelled by their parent.
const CANCELLED = junit(SUITE('before hook throws', 2, 2, 0, [
  FAILED_CASE('never runs 1', 'cancelledByParent', 'test did not finish before its parent and was cancelled'),
  FAILED_CASE('never runs 2', 'cancelledByParent', 'test did not finish before its parent and was cancelled')
].join('\n')), { tests: 2, suites: 1, pass: 0, fail: 0, cancelled: 2, skipped: 0, todo: 0 });

// A parent test failing because a child failed: the runner counts the parent
// and the child as failed (fail 2 of 3 tests); the report has one <failure>.
const PARENT_FAILED = junit(SUITE('parent whose child fails', 2, 1, 0, [
  CASE('child ok'), FAILED_CASE('child fails', 'testCodeFailure', 'Expected values to be strictly equal')
].join('\n')), { tests: 3, suites: 0, pass: 1, fail: 2, cancelled: 0, skipped: 0, todo: 0 });

// Three skipped describes (skipped at describe time by an option): suites to
// the runner, skipped <testcase>s to the reporter, and not in the runner's
// `skipped` at all.
const SKIPPED_DESCRIBES = junit([
  SUITE('ran', 1, 0, 0, CASE('one')),
  SKIPPED_CASE('resolve — a', 'skipped', 'host').replace(/^\t\t/gm, '\t'),
  SKIPPED_CASE('resolve — b', 'skipped', 'host').replace(/^\t\t/gm, '\t'),
  SKIPPED_CASE('resolve — c', 'skipped', 'host').replace(/^\t\t/gm, '\t')
].join('\n'), { tests: 1, suites: 4, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });

describe('tallyJunit: one count per element kind, nested attributes ignored', () => {
  it('counts testcases, testsuites, failures, skipped and todo elements once each', () => {
    assert.deepEqual(results.tallyJunit(SUBTESTS), { testcases: 8, testsuites: 2, failures: 0, skipped: 3, todo: 1 });
    assert.deepEqual(results.tallyJunit(CANCELLED), { testcases: 2, testsuites: 1, failures: 2, skipped: 0, todo: 0 });
  });

  it('never reads the nested tests="" attributes, whose sum counts parents twice', () => {
    const nested = junit(SUITE('outer', 3, 0, 0, [CASE('a'), SUITE('inner', 2, 0, 0, [CASE('b'), CASE('c')].join('\n')).replace(/^\t/gm, '\t\t')].join('\n')));
    assert.equal(results.tallyJunit(nested).testcases, 3);
    assert.equal(results.tallyJunit(nested).testsuites, 2);
  });

  it('reads a name carrying a bare > as one attribute, not the end of the tag', () => {
    const xml = junit(SUITE('s', 1, 0, 0, '\t\t<testcase name="wrap/&lt;ts>-&lt;slug>" time="0.1" classname="test"/>'));
    assert.deepEqual(results.tallyJunit(xml), { testcases: 1, testsuites: 1, failures: 0, skipped: 0, todo: 0 });
  });

  it('counts nothing in an empty report', () => {
    assert.deepEqual(results.tallyJunit(junit('')), { testcases: 0, testsuites: 0, failures: 0, skipped: 0, todo: 0 });
  });
});

describe('summaryOf: the runner\'s own eight lines, in any of their three spellings', () => {
  it('reads the junit trailer comments', () => {
    assert.deepEqual(results.summaryOf(SUBTESTS), SUBTESTS_SUMMARY);
  });

  it('reads the spec reporter\'s ℹ lines and the TAP reporter\'s # lines', () => {
    const spec = `✔ plain (0.1ms)\n${specLines(SUBTESTS_SUMMARY)}\n`;
    assert.deepEqual(results.summaryOf(spec), SUBTESTS_SUMMARY);
    const tap = `ok 1 - plain\n1..1\n${Object.entries(SUBTESTS_SUMMARY).map(([k, v]) => `# ${k} ${v}`).join('\n')}\n`;
    assert.deepEqual(results.summaryOf(tap), SUBTESTS_SUMMARY);
  });

  it('keeps the last value seen for a key, so a log holding an aborted attempt reads as its final run', () => {
    const twice = `${specLines({ ...SUBTESTS_SUMMARY, tests: 3, pass: 1, skipped: 1, todo: 0, suites: 0 })}\n${specLines(SUBTESTS_SUMMARY)}\n`;
    assert.deepEqual(results.summaryOf(twice), SUBTESTS_SUMMARY);
  });

  it('is null when a counter is missing, never a zero nobody wrote', () => {
    const { todo, ...missing } = SUBTESTS_SUMMARY;
    assert.equal(results.summaryOf(specLines(missing)), null);
    assert.equal(results.summaryOf(junit('')), null);
    assert.equal(results.summaryOf(''), null);
  });

  it('does not require duration_ms', () => {
    const { duration_ms, ...rest } = SUBTESTS_SUMMARY;
    assert.deepEqual(results.summaryOf(specLines(rest)), rest);
  });
});

describe('reconcile: testcases + testsuites == tests + suites, and red is red', () => {
  it('accepts a test with subtests, which the runner counts and the reporter nests', () => {
    const r = results.reconcileText(SUBTESTS);
    assert.deepEqual({ ok: r.ok, problems: r.problems, red: r.red, canonical: r.canonical, leaf: r.leaf }, { ok: true, problems: [], red: [], canonical: 9, leaf: 8 });
  });

  it('accepts skipped describes, which the runner counts as suites and the reporter writes as skipped testcases', () => {
    const r = results.reconcileText(SKIPPED_DESCRIBES);
    assert.equal(r.ok, true, r.problems.concat(r.red).join('; '));
    assert.equal(r.canonical, 1);
    assert.equal(r.leaf, 4);
  });

  it('reads a describe body that threw as red, although the runner says fail 0', () => {
    const r = results.reconcileText(DESCRIBE_THREW);
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, []);
    assert.equal(r.red.length, 1);
    assert.match(r.red[0], /1 failure element\(s\) the summary does not count/);
  });

  it('reads a failed, a cancelled and a parent-failed run as red from the summary', () => {
    for (const xml of [LOAD_THREW, CANCELLED, PARENT_FAILED]) {
      const r = results.reconcileText(xml);
      assert.equal(r.ok, false);
      assert.deepEqual(r.problems, [], 'the identity still holds on a red run');
      assert.match(r.red[0], /the summary counts \d+ failed and \d+ cancelled/);
    }
  });

  it('refuses a report that is not the run the summary describes', () => {
    const truncated = SUBTESTS.replace(CASE('plain').replace(/^\t\t/, '\t'), '');
    const r = results.reconcileText(truncated);
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /7 testcases \+ 2 testsuites = 9 nodes in the report, 9 tests \+ 1 suites = 10 in the summary/);
  });

  it('refuses a report with no summary', () => {
    const r = results.reconcileText(junit(SUBTESTS_BODY));
    assert.equal(r.ok, false);
    assert.equal(r.canonical, null);
    assert.match(r.problems[0], /no runner summary found/);
  });

  it('refuses a summary whose outcomes do not add up to its tests', () => {
    const r = results.reconcileText(junit(SUBTESTS_BODY, { ...SUBTESTS_SUMMARY, pass: 4 }));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /does not add up: pass 4 \+ fail 0 \+ cancelled 0 \+ skipped 3 \+ todo 1 = 8, not tests 9/);
  });

  it('reads the summary from a separate log when given one', () => {
    const r = results.reconcileText(junit(SUBTESTS_BODY), specLines(SUBTESTS_SUMMARY));
    assert.equal(r.ok, true);
    assert.equal(r.canonical, 9);
  });
});

describe('formatReconciliation: both counts side by side, then the verdict', () => {
  it('prints the canonical count and the leaf count on a green run', () => {
    const text = results.formatReconciliation(results.reconcileText(SUBTESTS));
    assert.match(text, /^runner summary: tests 9, pass 5, fail 0, cancelled 0, skipped 3, todo 1, suites 1$/m);
    assert.match(text, /^junit report: {3}testcases 8, testsuites 2, failure elements 0, skipped elements 4$/m);
    assert.match(text, /^nodes: 8 \+ 2 = 10 in the report, 9 \+ 1 = 10 in the summary \(the same run\)$/m);
    assert.match(text, /^canonical count 9 \(the runner's tests\); 8 testcase leaves in the report; green$/m);
  });

  it('names every refusal and every red reason otherwise', () => {
    assert.match(results.formatReconciliation(results.reconcileText(DESCRIBE_THREW)), /^RED: the report carries 1 failure element/m);
    assert.match(results.formatReconciliation(results.reconcileText(junit(SUBTESTS_BODY))), /^runner summary: none\n/);
    assert.match(results.formatReconciliation(results.reconcileText(junit(SUBTESTS_BODY))), /^REFUSED: no runner summary/m);
  });
});

describe('parseJunit moved here whole; the skip audit re-exports it', () => {
  it('is the same function from both modules', () => {
    assert.equal(skipAudit.parseJunit, results.parseJunit);
  });

  it('still counts every testcase and paths the skipped ones', () => {
    const run = results.parseJunit(SUBTESTS);
    assert.equal(run.total, 8);
    assert.deepEqual(run.skipped.map((s) => `${s.kind}:${s.path}`), [
      'skipped:suite > two skipped', 'skipped:suite > dynamic skip', 'todo:suite > todo one', 'skipped:top-level skipped'
    ]);
  });

  it('decodes the reporter\'s double-escaped quotes and single-escaped angle brackets', () => {
    assert.equal(results.decodeXml('&amp;quot;auto&amp;quot; &lt;x> &#8594;'), '"auto" <x> →');
    assert.equal(results.attr(' name="a &amp; b" type="todo"', 'name'), 'a & b');
    assert.equal(results.attr(' name="a"', 'type'), null);
  });
});

// The shape that hid #2521's red, as measured in a full-suite report on node
// 22: a case written at the top level just before the reporter opens one
// `<undefined name="root">` element, which then holds testcases, testsuites and
// the runner's own trailing summary. Runner: 5 tests, 2 suites; report: 5
// testcases, 2 testsuites (`<undefined>` is no node of the run).
const UNDEFINED_ROOT = '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n'
  + `${SUITE('first', 1, 0, 0, CASE('a'))}\n`
  + '\t\t\t<testcase name="stray" time="0.0001" classname="test"/>\n'
  + '\t<undefined name="root">\n'
  + `${CASE('refusals')}\n`
  + `${SUITE('create', 2, 1, 0, [CASE('c1'), FAILED_CASE('c2 fails', 'testCodeFailure', 'boom')].join('\n'))}\n`
  + `${trailer({ tests: 5, suites: 2, pass: 4, fail: 1, cancelled: 0, skipped: 0, todo: 0 })}\n`
  + '\t</undefined>\n</testsuites>\n';

describe('prawductView: only the leaves beneath a top-level <testsuite>, which is all Prawduct 3.6.1 reads', () => {
  it('does not see a bare top-level testcase or anything inside <undefined>', () => {
    assert.deepEqual(results.prawductView(UNDEFINED_ROOT), { testcases: 1, failures: 0, errors: 0, skipped: 0 });
  });

  it('reads the describe-threw failure as green, the false green of #2521', () => {
    assert.equal(results.reconcileText(DESCRIBE_THREW).ok, false);
    assert.deepEqual(results.prawductView(DESCRIBE_THREW), { testcases: 1, failures: 0, errors: 0, skipped: 0 });
  });

  it('counts todo as skipped and leaves under nested suites once each', () => {
    // SUBTESTS: 6 leaves under its two suites (3 skipped incl. the todo); its 2 bare top-level cases are not seen.
    assert.deepEqual(results.prawductView(SUBTESTS), { testcases: 6, failures: 0, errors: 0, skipped: 3 });
  });

  it('classifies each leaf once, error before failure before skipped', () => {
    const xml = junit(SUITE('s', 3, 0, 0, [
      '\t\t<testcase name="e"><error message="x"/><failure message="y"/></testcase>',
      '\t\t<testcase name="f"><failure message="y"/><skipped/></testcase>',
      '\t\t<testcase name="k"><skipped type="todo"/></testcase>'
    ].join('\n')));
    assert.deepEqual(results.prawductView(xml), { testcases: 3, failures: 1, errors: 1, skipped: 1 });
  });

  it('reads a leafless top-level suite by its count attributes', () => {
    const xml = junit('\t<testsuite name="summary only" tests="4" failures="1" errors="1" skipped="2"/>');
    assert.deepEqual(results.prawductView(xml), { testcases: 4, failures: 1, errors: 1, skipped: 2 });
  });
});

describe('hoistToTopLevelSuites: every leaf beneath a top-level <testsuite>, nothing gained or lost', () => {
  it('lets Prawduct\'s reading see every leaf and the red that #2521 missed', () => {
    const out = results.hoistToTopLevelSuites(UNDEFINED_ROOT);
    assert.deepEqual(results.prawductView(out.xml), { testcases: 5, failures: 1, errors: 0, skipped: 0 });
    assert.deepEqual(results.prawductView(results.hoistToTopLevelSuites(DESCRIBE_THREW).xml), { testcases: 2, failures: 1, errors: 0, skipped: 0 });
    assert.deepEqual(results.prawductView(results.hoistToTopLevelSuites(SUBTESTS).xml), { testcases: 8, failures: 0, errors: 0, skipped: 4 });
  });

  it('renames each top-level <undefined> and wraps each run of bare top-level cases, counting both', () => {
    const out = results.hoistToTopLevelSuites(UNDEFINED_ROOT);
    assert.equal(out.added, 2);
    assert.doesNotMatch(out.xml, /<\/?undefined\b/);
    assert.match(out.xml, /<testsuite name="\(top-level tests\)">\s*<testcase name="stray"[^>]*\/>\s*<\/testsuite>/);
    const before = results.tallyJunit(UNDEFINED_ROOT);
    const after = results.tallyJunit(out.xml);
    assert.deepEqual({ ...after, testsuites: after.testsuites - out.added }, before);
  });

  it('wraps consecutive bare cases as one run, and a suite between them starts a new one', () => {
    // SUBTESTS ends with two adjacent bare cases; SKIPPED_DESCRIBES has three after a suite.
    assert.equal(results.hoistToTopLevelSuites(SUBTESTS).added, 1);
    assert.equal(results.hoistToTopLevelSuites(SKIPPED_DESCRIBES).added, 1);
    assert.equal(results.hoistToTopLevelSuites(DESCRIBE_THREW).added, 1);
  });

  it('keeps the runner\'s summary readable where it was', () => {
    assert.deepEqual(results.summaryOf(results.hoistToTopLevelSuites(UNDEFINED_ROOT).xml), results.summaryOf(UNDEFINED_ROOT));
    assert.deepEqual(results.summaryOf(results.hoistToTopLevelSuites(SUBTESTS).xml), results.summaryOf(SUBTESTS));
  });

  it('changes nothing in a report whose leaves are all beneath top-level suites already', () => {
    assert.deepEqual(results.hoistToTopLevelSuites(CANCELLED), { xml: CANCELLED, added: 0 });
  });

  it('leaves the raw report as the one the identity is judged on', () => {
    // The raw report obeys testcases + testsuites == tests + suites; the hoisted
    // one has `added` more suites, which is why reconcile reads the raw report.
    const raw = results.reconcileText(UNDEFINED_ROOT);
    assert.deepEqual(raw.problems, []);
    assert.deepEqual(raw.red, ['the summary counts 1 failed and 0 cancelled']);
    assert.notDeepEqual(results.reconcileText(results.hoistToTopLevelSuites(UNDEFINED_ROOT).xml).problems, []);
  });

  it('fails closed on a top-level element it does not know', () => {
    assert.throws(() => results.hoistToTopLevelSuites(junit('\t<properties><property name="a" value="b"/></properties>')),
      { code: 'JUNIT_SHAPE', message: /unexpected top-level element <properties>/ });
  });

  it('fails closed on text at the top level', () => {
    assert.throws(() => results.hoistToTopLevelSuites(junit(`${SUITE('s', 1, 0, 0, CASE('a'))}\nstray words`)),
      { code: 'JUNIT_SHAPE', message: /text at the top level/ });
  });

  it('fails closed on a closing tag that does not match', () => {
    assert.throws(() => results.hoistToTopLevelSuites(junit('\t<testsuite name="s">\n\t\t<testcase name="a">\n\t</testsuite>')),
      { code: 'JUNIT_SHAPE', message: /<\/testsuite> closes <testcase>/ });
  });

  it('fails closed on an element left open', () => {
    assert.throws(() => results.hoistToTopLevelSuites('<testsuites>\n\t<testsuite name="s">\n'),
      { code: 'JUNIT_SHAPE', message: /left open/ });
  });

  it('fails closed on a document whose root is not <testsuites>', () => {
    assert.throws(() => results.hoistToTopLevelSuites('<?xml version="1.0"?>\n<testsuite name="s"></testsuite>\n'),
      { code: 'JUNIT_SHAPE', message: /root is <testsuite>, not <testsuites>/ });
    assert.throws(() => results.hoistToTopLevelSuites('nothing here'), { code: 'JUNIT_SHAPE', message: /no <testsuites> root/ });
  });

  it('fails closed on anything after the root', () => {
    assert.throws(() => results.hoistToTopLevelSuites(`${CANCELLED}<testsuites></testsuites>\n`),
      { code: 'JUNIT_SHAPE', message: /after the <testsuites> root/ });
  });

  it('reads a failure body\'s escaped < and bare > as text, not tags', () => {
    // FAILED_CASE carries `Object.&lt;anonymous> (/x/y.test.js:2:1)` in its body.
    assert.equal(results.hoistToTopLevelSuites(PARENT_FAILED).added, 0);
    assert.deepEqual(results.prawductView(PARENT_FAILED), { testcases: 2, failures: 1, errors: 0, skipped: 0 });
  });
});
