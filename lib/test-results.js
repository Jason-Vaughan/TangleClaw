'use strict';

/*
 * The one reader of what a `node --test` run reported (#2498).
 *
 * A run leaves two records of itself: the runner's own summary (the `ℹ tests`
 * lines the spec reporter prints, the `# tests` lines of the TAP reporter,
 * and the `<!-- tests N -->` comments the junit reporter writes at the end of
 * its report) and the junit document's tree of `<testsuite>` and `<testcase>`
 * elements. They count the same run in two shapes, and reading either one
 * carelessly gives a number nothing else agrees with: summing the nested
 * `tests=""` attributes overcounts (a parent suite's attribute already holds
 * its children), and counting `<testcase>` leaves alone is a few short of the
 * runner's total, because a `test()` with subtests is a test to the runner and
 * a `<testsuite>` to the reporter.
 *
 * This module pins the relationship exactly, measured on Node 22 rather than
 * assumed:
 *
 *   testcases + testsuites in the report  ==  tests + suites in the summary
 *
 * Every node of the run is rendered once (as a testcase or a testsuite) and
 * counted once (as a test or a suite); only the label moves. A `test()` with
 * subtests, a `describe` whose body threw before its tests ran, and a skipped
 * `describe` are each one node that the two sides label differently, and each
 * moves both sides of the identity by the same one. A report that breaks the
 * identity is not the report of the run the summary describes (truncated, or
 * from another run), and `reconcile` refuses it.
 *
 * The canonical count of a run is the runner's `tests`. The report's leaf count
 * is printed beside it, never instead of it.
 *
 * One more thing the identity makes visible: a `describe` whose body throws is
 * rendered as a `<testcase>` with a `<failure>` but counted by the runner as a
 * suite, with `fail 0`, and the process exits 0. The report carries a failure
 * the summary does not count. `reconcile` reads that as red.
 *
 * `parseJunit`, `decodeXml` and `attr` moved here from
 * `scripts/test-skip-audit.js`, which re-exports `parseJunit` so its readers are
 * unchanged.
 */

/**
 * Decode the five XML entities plus numeric character references.
 *
 * `&amp;` is decoded FIRST, which is backwards for well-formed XML and right
 * for this producer: node:test's junit reporter escapes `"` to `&quot;` and
 * then escapes the `&` of that, so a quoted launch mode arrives as
 * `&amp;quot;auto&amp;quot;` while `<` arrives singly as `&lt;` (measured on
 * Node 22, not assumed). Decoding `&amp;` first recovers both shapes. The cost
 * is that a test name containing the literal text `&lt;` would decode one step
 * too far; no test is named that way, and the ledger matches by path so a
 * wrong decode would surface as an unknown skip, never as a silent pass.
 *
 * @param {string} s - Attribute text as it appears in the XML
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
 * @returns {string|null} Decoded value, or null when absent
 */
function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]) : null;
}

/**
 * Walk a junit document and collect every test case, noting the skipped ones.
 *
 * A hand-rolled walker rather than an XML parser because the report has one
 * shape — `testsuites > testsuite* > testcase > skipped?` — and node:test is the
 * only producer. Quoted attribute values are consumed whole, so a value that
 * spans lines (long test names do) or carries a bare `>` (the reporter escapes
 * `<` and not `>`) does not end the tag early.
 *
 * @param {string} xml - The junit report text
 * @returns {{total: number, skipped: Array<{path: string, kind: string, message: string}>}}
 *   `total` counts every `<testcase>`; `skipped` lists those carrying a
 *   `<skipped>` child, with `kind` = the element's `type` (`skipped` | `todo`).
 */
function parseJunit(xml) {
  const stack = [];
  const skipped = [];
  let total = 0;
  let open = null;
  // Attribute values are read as quoted units: the reporter escapes `<` but
  // not `>`, so a name like `wrap/<ts>-<slug>` arrives as `wrap/&lt;ts>-&lt;slug>`
  // and a `[^>]*` attribute scan would end the tag inside the name.
  const tagRe = /<(\/?)(testsuite|testcase|skipped)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    const [, closing, tag, attrs, selfClosing] = m;
    if (tag === 'testsuite') {
      if (closing) stack.pop();
      else if (!selfClosing) stack.push(attr(attrs, 'name') || '');
      continue;
    }
    if (tag === 'testcase') {
      if (closing) { open = null; continue; }
      total++;
      const full = [...stack, attr(attrs, 'name') || ''].join(' > ');
      open = selfClosing ? null : { path: full };
      continue;
    }
    // tag === 'skipped'
    if (open && !closing) {
      skipped.push({
        path: open.path,
        kind: attr(attrs, 'type') || 'skipped',
        message: attr(attrs, 'message') || ''
      });
    }
  }
  return { total, skipped };
}

/**
 * Count the elements of a junit report, one tally per element kind.
 *
 * Counts opening tags only, so a `<testsuite>` with children and a
 * self-closing `<testcase/>` each count once. `skipped` and `todo` split the
 * `<skipped>` elements by their `type`, the way the runner's summary splits
 * them. The nested `tests=""` attributes are deliberately not read: a parent
 * suite's attribute already includes its children, so their sum is not a count
 * of anything.
 *
 * @param {string} xml - The junit report text
 * @returns {{testcases: number, testsuites: number, failures: number, skipped: number, todo: number}}
 */
function tallyJunit(xml) {
  const tally = { testcases: 0, testsuites: 0, failures: 0, skipped: 0, todo: 0 };
  const tagRe = /<(\/?)(testsuite|testcase|skipped|failure)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    const [, closing, tag, attrs] = m;
    if (closing) continue;
    if (tag === 'testsuite') tally.testsuites++;
    else if (tag === 'testcase') tally.testcases++;
    else if (tag === 'failure') tally.failures++;
    else if (attr(attrs, 'type') === 'todo') tally.todo++;
    else tally.skipped++;
  }
  return tally;
}

/** The counters a runner summary must carry for `reconcile` to read it. */
const SUMMARY_KEYS = Object.freeze(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']);

/**
 * Read the runner's own summary out of a run's text.
 *
 * Accepts the three spellings node writes for the same eight lines: the spec
 * reporter's `ℹ tests 9`, the TAP reporter's `# tests 9`, and the junit
 * reporter's trailing `<!-- tests 9 -->` comments. The last value seen wins
 * for each key, so a log that holds an earlier aborted attempt reads as its
 * final run. `duration_ms` is kept when present and never required.
 *
 * @param {string} text - A spec log, a TAP log, or the junit report itself
 * @returns {{tests: number, suites: number, pass: number, fail: number, cancelled: number, skipped: number, todo: number, duration_ms?: number}|null}
 *   The summary, or null when any of the seven counters is absent: a summary
 *   with a counter missing describes no run, and a reader that defaulted it to
 *   zero would be inventing a green.
 */
function summaryOf(text) {
  const lineRe = /^[ \t]*(?:ℹ|#|<!--)[ \t]*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)[ \t]+(\d+(?:\.\d+)?)[ \t]*(?:-->)?[ \t]*$/gm;
  const found = {};
  let m;
  while ((m = lineRe.exec(text)) !== null) found[m[1]] = Number(m[2]);
  if (!SUMMARY_KEYS.every((k) => Number.isInteger(found[k]))) return null;
  const summary = {};
  for (const k of SUMMARY_KEYS) summary[k] = found[k];
  if (typeof found.duration_ms === 'number') summary.duration_ms = found.duration_ms;
  return summary;
}

/**
 * Hold a report and a summary to the same run, and say whether the run is green.
 *
 * Refuses (`problems`) when the two cannot be the same run: no summary, a
 * summary whose outcome counters do not add up to its `tests`, or a report
 * whose node count (testcases + testsuites) differs from the summary's
 * (tests + suites). Reads red (`red`) when the summary counts a failure or a
 * cancellation, or when the report carries a `<failure>` element the summary
 * does not count, which is what a suite body that threw before its tests ran
 * looks like: the runner exits 0 for it.
 *
 * @param {ReturnType<typeof tallyJunit>} tally - The report's element counts
 * @param {ReturnType<typeof summaryOf>} summary - The runner's summary, or null
 * @returns {{ok: boolean, problems: string[], red: string[], canonical: number|null, leaf: number, tally: object, summary: object|null}}
 *   `canonical` is the summary's `tests` (the suite total); `leaf` is the
 *   report's testcase count, printed beside it and never in its place. `ok`
 *   is true only with no problem and nothing red.
 */
function reconcile(tally, summary) {
  const problems = [];
  const red = [];
  if (!summary) {
    problems.push('no runner summary found: the run left no `tests/suites/pass/fail/cancelled/skipped/todo` lines, so nothing says what it certified');
  } else {
    const outcomes = summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo;
    if (outcomes !== summary.tests) {
      problems.push(`the summary does not add up: pass ${summary.pass} + fail ${summary.fail} + cancelled ${summary.cancelled} + skipped ${summary.skipped} + todo ${summary.todo} = ${outcomes}, not tests ${summary.tests}`);
    }
    const reportNodes = tally.testcases + tally.testsuites;
    const runNodes = summary.tests + summary.suites;
    if (reportNodes !== runNodes) {
      problems.push(`the report is not the run the summary describes: ${tally.testcases} testcases + ${tally.testsuites} testsuites = ${reportNodes} nodes in the report, ${summary.tests} tests + ${summary.suites} suites = ${runNodes} in the summary`);
    }
    if (summary.fail + summary.cancelled > 0) {
      red.push(`the summary counts ${summary.fail} failed and ${summary.cancelled} cancelled`);
    }
  }
  if (tally.failures > 0 && (!summary || summary.fail + summary.cancelled === 0)) {
    red.push(`the report carries ${tally.failures} failure element(s) the summary does not count: a suite body threw before its tests ran, which the runner reports as fail 0 and exits 0 for`);
  }
  return {
    ok: problems.length === 0 && red.length === 0,
    problems,
    red,
    canonical: summary ? summary.tests : null,
    leaf: tally.testcases,
    tally,
    summary
  };
}

/**
 * Reconcile a run from its text: the junit report, and the summary's text when
 * it was written somewhere else (a spec or TAP log). With one argument the
 * summary is read from the report's own trailing comments.
 *
 * @param {string} junitXml - The junit report text
 * @param {string} [summaryText=junitXml] - Where the runner's summary lines are
 * @returns {ReturnType<typeof reconcile>}
 */
function reconcileText(junitXml, summaryText = junitXml) {
  return reconcile(tallyJunit(junitXml), summaryOf(summaryText));
}

/**
 * Render a reconciliation as the lines a run prints at its end: the runner's
 * summary, the report's tally beside it, then the verdict with every problem
 * and every red reason named.
 *
 * @param {ReturnType<typeof reconcile>} result - From {@link reconcile}
 * @returns {string} Lines joined by newlines, no trailing newline
 */
function formatReconciliation(result) {
  const { tally, summary } = result;
  const lines = [];
  if (summary) {
    lines.push(`runner summary: tests ${summary.tests}, pass ${summary.pass}, fail ${summary.fail}, cancelled ${summary.cancelled}, skipped ${summary.skipped}, todo ${summary.todo}, suites ${summary.suites}`);
  } else {
    lines.push('runner summary: none');
  }
  lines.push(`junit report:   testcases ${tally.testcases}, testsuites ${tally.testsuites}, failure elements ${tally.failures}, skipped elements ${tally.skipped + tally.todo}`);
  if (summary) {
    const reportNodes = tally.testcases + tally.testsuites;
    const runNodes = summary.tests + summary.suites;
    lines.push(`nodes: ${tally.testcases} + ${tally.testsuites} = ${reportNodes} in the report, ${summary.tests} + ${summary.suites} = ${runNodes} in the summary (${reportNodes === runNodes ? 'the same run' : 'NOT the same run'})`);
  }
  if (result.ok) {
    lines.push(`canonical count ${result.canonical} (the runner's tests); ${result.leaf} testcase leaves in the report; green`);
  } else {
    for (const p of result.problems) lines.push(`REFUSED: ${p}`);
    for (const r of result.red) lines.push(`RED: ${r}`);
  }
  return lines.join('\n');
}

/*
 * Handing a report to Prawduct (#2521).
 *
 * Prawduct's recorder (`prawduct-hook test-evidence record`, measured on 3.6.1,
 * `bin/prawduct-hook` near line 4437) counts only the `<testcase>`s beneath a
 * TOP-LEVEL `<testsuite>`: `root.findall("testsuite")`, then each one's leaves.
 * node:test's junit reporter also writes cases directly under the root, and in
 * a full run it can open one top-level `<undefined name="root">` element that
 * holds thousands of cases and the runner's own summary. Prawduct never reads
 * those, so a red case there records as green. `prawductView` models that
 * reading; `hoistToTopLevelSuites` rewrites a report so the reading sees every
 * leaf, and refuses any report whose shape it does not recognise.
 */

/** One token of a junit document: a tag, a comment or the XML declaration. */
const TOKEN_RE = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"]|"[^"]*")*?)(\/?)>/g;

/** What the hoist wraps a run of bare top-level cases in. */
const TOP_LEVEL_SUITE_NAME = '(top-level tests)';

/**
 * An error naming why a report's shape was refused.
 *
 * @param {string} message - What was found and where
 * @returns {Error} With `code` 'JUNIT_SHAPE'
 */
function shapeError(message) {
  const err = new Error(`junit report refused: ${message}`);
  err.code = 'JUNIT_SHAPE';
  return err;
}

/**
 * Split a junit document into its tokens, checking that it is one balanced
 * `<testsuites>` root and that no text sits outside an element below it.
 *
 * Each token carries `depth`, the number of elements around it, so an element
 * and its closing tag share a depth: the root is depth 0 and its children are
 * depth 1. Text deeper down (a failure's stack trace) is left alone; a raw `<`
 * in it would surface here as a tag that does not balance, and is refused.
 *
 * @param {string} xml - The junit report text
 * @returns {Array<{kind: 'open'|'close'|'self'|'comment'|'decl', name: string|null, attrs: string, start: number, end: number, depth: number}>}
 * @throws {Error} code 'JUNIT_SHAPE' on any structure it does not recognise
 */
function scanJunit(xml) {
  if (!/<[A-Za-z_]/.test(xml)) throw shapeError('no <testsuites> root');
  const tokens = [];
  const stack = [];
  let rootSeen = false;
  let last = 0;
  const checkText = (text, at) => {
    if (/^\s*$/.test(text)) return;
    if (stack.length === 0) throw shapeError(rootSeen ? `text after the <testsuites> root at offset ${at}` : `text before the root at offset ${at}`);
    if (stack.length === 1) throw shapeError(`text at the top level at offset ${at}: ${JSON.stringify(text.trim().slice(0, 40))}`);
  };
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(xml)) !== null) {
    checkText(xml.slice(last, m.index), last);
    last = TOKEN_RE.lastIndex;
    const base = { attrs: '', start: m.index, end: TOKEN_RE.lastIndex };
    if (m[0].startsWith('<!--')) { tokens.push({ ...base, kind: 'comment', name: null, depth: stack.length }); continue; }
    if (m[0].startsWith('<?')) {
      if (rootSeen || stack.length) throw shapeError(`a processing instruction inside the document at offset ${m.index}`);
      tokens.push({ ...base, kind: 'decl', name: null, depth: 0 });
      continue;
    }
    const [, closing, name, attrs, selfClosing] = m;
    if (closing) {
      const open = stack.pop();
      if (open !== name) throw shapeError(open ? `</${name}> closes <${open}> at offset ${m.index}` : `</${name}> closes nothing at offset ${m.index}`);
      tokens.push({ ...base, kind: 'close', name, depth: stack.length });
      continue;
    }
    if (stack.length === 0) {
      if (rootSeen) throw shapeError(`<${name}> after the <testsuites> root at offset ${m.index}`);
      if (name !== 'testsuites') throw shapeError(`the root is <${name}>, not <testsuites>`);
      rootSeen = true;
    }
    tokens.push({ ...base, attrs, kind: selfClosing ? 'self' : 'open', name, depth: stack.length });
    if (!selfClosing) stack.push(name);
  }
  checkText(xml.slice(last), last);
  if (stack.length) throw shapeError(`<${stack[stack.length - 1]}> left open at the end of the report`);
  if (!rootSeen) throw shapeError('no <testsuites> root');
  return tokens;
}

/**
 * Count leaves the way Prawduct classifies them: each `<testcase>` once, as an
 * error if it has an `<error>` child, else a failure if it has a `<failure>`,
 * else skipped if it has a `<skipped>` (todo included), else passed.
 *
 * @param {ReturnType<typeof scanJunit>} tokens - From {@link scanJunit}
 * @param {boolean} topLevelSuitesOnly - Count only leaves beneath a top-level
 *   `<testsuite>`, reading a leafless one by its count attributes, as Prawduct does
 * @returns {{testcases: number, failures: number, errors: number, skipped: number}}
 */
function leafCounts(tokens, topLevelSuitesOnly) {
  const counts = { testcases: 0, failures: 0, errors: 0, skipped: 0 };
  let suite = null;
  let leaf = null;
  const classify = (flags) => {
    counts.testcases++;
    if (flags.error) counts.errors++;
    else if (flags.failure) counts.failures++;
    else if (flags.skipped) counts.skipped++;
  };
  const fromAttrs = (attrs) => {
    for (const [key, name] of [['testcases', 'tests'], ['failures', 'failures'], ['errors', 'errors'], ['skipped', 'skipped']]) {
      counts[key] += Number(attr(attrs, name) || 0);
    }
  };
  for (const t of tokens) {
    if (t.kind === 'comment' || t.kind === 'decl') continue;
    if (topLevelSuitesOnly && t.depth === 1) {
      if (t.name === 'testsuite' && t.kind === 'self') { fromAttrs(t.attrs); continue; }
      if (t.name === 'testsuite' && t.kind === 'open') { suite = { attrs: t.attrs, leaves: 0 }; continue; }
      if (t.name === 'testsuite' && t.kind === 'close' && suite) {
        if (suite.leaves === 0) fromAttrs(suite.attrs);
        suite = null;
        continue;
      }
    }
    if (topLevelSuitesOnly && !suite) continue;
    if (t.name === 'testcase') {
      if (t.kind === 'self') { classify({}); if (suite) suite.leaves++; }
      else if (t.kind === 'open') leaf = {};
      else if (leaf) { classify(leaf); if (suite) suite.leaves++; leaf = null; }
      continue;
    }
    if (leaf && t.kind !== 'close' && (t.name === 'error' || t.name === 'failure' || t.name === 'skipped')) leaf[t.name] = true;
  }
  return counts;
}

/**
 * What Prawduct's recorder would count in a report: only the leaves beneath a
 * top-level `<testsuite>`. This models Prawduct 3.6.1's reading; it is not this
 * module's view of a run, which is {@link tallyJunit} and {@link reconcile}.
 *
 * @param {string} xml - The junit report text
 * @returns {{testcases: number, failures: number, errors: number, skipped: number}}
 * @throws {Error} code 'JUNIT_SHAPE' when the report's structure is not recognised
 */
function prawductView(xml) {
  return leafCounts(scanJunit(xml), true);
}

/**
 * Rewrite a report so every leaf sits beneath a top-level `<testsuite>`, which
 * is what Prawduct's recorder reads.
 *
 * Two edits and nothing else: each top-level `<undefined>` element becomes a
 * `<testsuite>`, and each run of bare top-level `<testcase>`s is wrapped in one
 * `<testsuite name="(top-level tests)">` carrying no count attributes, so no
 * count is invented. Comments, the runner's summary among them, stay where they
 * are. A top-level element of any other kind, text at the top level, or an
 * unbalanced tag refuses the report rather than guessing at it.
 *
 * The result is checked before it is returned: Prawduct's reading of it must
 * equal the full leaf count of the input (cases, failures, errors and skips),
 * and the hoisted report must hold exactly `added` more `<testsuite>`s and the
 * same everything else. The hoisted report breaks the identity
 * {@link reconcile} holds a run to by `added`, so a run is judged on the raw
 * report, never on this one.
 *
 * @param {string} xml - The junit report text, as the runner wrote it
 * @returns {{xml: string, added: number}} The rewritten report, and how many
 *   elements became or were wrapped in a `<testsuite>`
 * @throws {Error} code 'JUNIT_SHAPE' on an unrecognised shape or a count the
 *   rewrite did not conserve
 */
function hoistToTopLevelSuites(xml) {
  const tokens = scanJunit(xml);
  const edits = [];
  let added = 0;
  let run = null;
  const endRun = () => {
    if (!run) return;
    edits.push({ start: run.start, end: run.start, text: `<testsuite name="${TOP_LEVEL_SUITE_NAME}">` });
    edits.push({ start: run.end, end: run.end, text: '</testsuite>' });
    added++;
    run = null;
  };
  for (const t of tokens) {
    if (t.depth !== 1) continue;
    if (t.kind === 'comment') { endRun(); continue; }
    if (t.name === 'testcase') {
      if (t.kind !== 'close' && !run) run = { start: t.start, end: t.end };
      if (t.kind !== 'open') run.end = t.end;
      continue;
    }
    endRun();
    if (t.name === 'testsuite') continue;
    if (t.name === 'undefined') {
      const from = t.start + (t.kind === 'close' ? 2 : 1);
      edits.push({ start: from, end: from + 'undefined'.length, text: 'testsuite' });
      if (t.kind !== 'close') added++;
      continue;
    }
    throw shapeError(`unexpected top-level element <${t.name}> at offset ${t.start}`);
  }
  endRun();
  let out = xml;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  const want = leafCounts(tokens, false);
  const got = prawductView(out);
  const before = tallyJunit(xml);
  const after = tallyJunit(out);
  const kept = Object.keys(want).every((k) => want[k] === got[k])
    && after.testsuites === before.testsuites + added
    && ['testcases', 'failures', 'skipped', 'todo'].every((k) => after[k] === before[k]);
  if (!kept) {
    throw shapeError(`the rewrite did not conserve the report: leaves ${JSON.stringify(want)} in, ${JSON.stringify(got)} as Prawduct reads the result; testsuites ${before.testsuites} + ${added} expected, ${after.testsuites} written`);
  }
  return { xml: out, added };
}

module.exports = {
  decodeXml, attr, parseJunit, tallyJunit, summaryOf, reconcile, reconcileText, formatReconciliation, SUMMARY_KEYS,
  prawductView, hoistToTopLevelSuites
};
