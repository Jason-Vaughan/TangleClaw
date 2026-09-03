#!/usr/bin/env node
'use strict';

/**
 * Audit what a test run did NOT execute.
 *
 * "CI green" reads as "the suite passed". It actually means "every test that
 * ran on this host passed" — and the tests that skip on the merge-gating
 * runner are disproportionately the ones that touch the real world: an
 * installed engine CLI, a non-UTC timezone, the host's PTY pool (#844). Nothing
 * hides them; every skip prints its reason. But nobody reads a green run's
 * log, so the gap is invisible at exactly the point the merge decision is made.
 *
 * This script reads the junit report node:test writes (`--test-reporter=junit`)
 * and does two things:
 *
 *   1. States plainly what the run certified — "N of M ran; K skipped" — on
 *      stdout and, when `GITHUB_STEP_SUMMARY` is set, on the run's summary page
 *      where the person deciding whether to merge actually looks.
 *   2. Compares every skipped test against a committed ledger
 *      (`test/skip-ledger.json`). A skip the ledger does not name FAILS the
 *      audit. That is the guard: a new environment-gated test cannot quietly
 *      join the not-run set. Joining it is allowed — it takes a ledger entry
 *      that says why the test cannot run here and where it does run.
 *
 * Matching is by the test's full path (`suite > suite > test`), not by count.
 * A pinned count would go stale on every engine-profile change and would not
 * say WHICH test went missing; a path ledger names the tier and the reason.
 *
 * Usage: node scripts/test-skip-audit.js [--ledger <path>] <junit.xml> [...]
 * Exit 0 when every skip is on the ledger; 1 when one is not, or when the
 * report certified nothing (no test cases at all — an empty or missing report
 * must never read as "nothing skipped").
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LEDGER = path.join(__dirname, '..', 'test', 'skip-ledger.json');

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
 * Validate the ledger's shape and compile its patterns.
 *
 * Throws rather than tolerating a malformed entry: a ledger that half-loads is
 * a guard that half-checks, and the failure would look like a spurious
 * "unexpected skip" on someone else's PR.
 *
 * @param {object} ledger - Parsed `skip-ledger.json`
 * @returns {Array<{id: string, match: RegExp, why: string, runsWhere: string}>}
 */
function compileLedger(ledger) {
  if (!ledger || !Array.isArray(ledger.entries)) {
    throw new Error('skip ledger must be an object with an `entries` array');
  }
  const seen = new Set();
  return ledger.entries.map((e, i) => {
    for (const key of ['id', 'match', 'why', 'runsWhere']) {
      if (typeof e[key] !== 'string' || e[key].trim() === '') {
        throw new Error(`skip ledger entry ${i} is missing a non-empty \`${key}\``);
      }
    }
    if (seen.has(e.id)) throw new Error(`skip ledger has two entries with id "${e.id}"`);
    seen.add(e.id);
    return { id: e.id, match: new RegExp(e.match), why: e.why, runsWhere: e.runsWhere };
  });
}

/**
 * Decide whether a run's skips are all accounted for.
 *
 * @param {{total: number, skipped: Array<{path: string, kind: string, message: string}>}} run
 *   Output of `parseJunit`
 * @param {Array<{id: string, match: RegExp, why: string, runsWhere: string}>} entries
 *   Output of `compileLedger`
 * @returns {{ok: boolean, total: number, ran: number, expected: Map<string, Array<object>>, unknown: Array<object>}}
 *   `expected` groups matched skips by ledger id (every entry present, possibly
 *   empty); `unknown` lists skips no entry matched. `ok` is false when any
 *   skip is unknown or when `total` is zero.
 */
function audit(run, entries) {
  const expected = new Map(entries.map((e) => [e.id, []]));
  const unknown = [];
  for (const s of run.skipped) {
    const hit = entries.find((e) => e.match.test(s.path));
    if (hit) expected.get(hit.id).push(s);
    else unknown.push(s);
  }
  return {
    ok: run.total > 0 && unknown.length === 0,
    total: run.total,
    ran: run.total - run.skipped.length,
    expected,
    unknown
  };
}

/**
 * Render the audit as Markdown — readable as plain text on stdout and as
 * rich text on the GitHub step summary, so one rendering serves both.
 *
 * @param {ReturnType<typeof audit>} result - The verdict
 * @param {Array<{id: string, why: string, runsWhere: string}>} entries - The ledger
 * @returns {string} Markdown
 */
function formatReport(result, entries) {
  const lines = [];
  const skippedCount = result.total - result.ran;
  lines.push(`## Test run certified ${result.ran} of ${result.total} tests`);
  lines.push('');
  if (result.total === 0) {
    lines.push('**No test cases found in the report — nothing was certified.**');
    lines.push('');
  }
  if (skippedCount === 0) {
    lines.push('Every test ran. Nothing was skipped.');
  } else {
    lines.push(`${skippedCount} did not run here. Those on the ledger, by tier:`);
    lines.push('');
    for (const e of entries) {
      const hits = result.expected.get(e.id);
      if (hits.length === 0) continue;
      lines.push(`- **${e.id}** — ${hits.length} skipped. ${e.why} Runs: ${e.runsWhere}`);
      for (const h of hits) lines.push(`  - ${h.path}${h.message ? ` — _${h.message}_` : ''}`);
    }
  }
  if (result.unknown.length > 0) {
    lines.push('');
    lines.push(`### ${result.unknown.length} skipped test(s) NOT on the ledger — this fails the audit`);
    lines.push('');
    lines.push('A test that cannot run on this host needs an entry in `test/skip-ledger.json`');
    lines.push('saying why, and where it does run. That is the whole guard: nothing joins the');
    lines.push('not-run set unannounced.');
    lines.push('');
    for (const u of result.unknown) {
      lines.push(`- ${u.path} (${u.kind})${u.message ? ` — _${u.message}_` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parse argv into the ledger path and the report paths.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{ledgerPath: string, reports: string[]}}
 */
function parseArgs(argv) {
  let ledgerPath = DEFAULT_LEDGER;
  const reports = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ledger') {
      ledgerPath = argv[++i];
      if (!ledgerPath) throw new Error('--ledger needs a path');
    } else {
      reports.push(argv[i]);
    }
  }
  if (reports.length === 0) throw new Error('usage: test-skip-audit.js [--ledger <path>] <junit.xml> [...]');
  return { ledgerPath, reports };
}

/**
 * Run the audit end to end and return the process exit code.
 *
 * Writes the report to `stdout` and, when `env.GITHUB_STEP_SUMMARY` names a
 * file, appends it there too. Injected `env`/`stdout` keep this testable
 * without spawning.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {{env?: object, stdout?: {write: function(string): any}}} [io] - Injection seam
 * @returns {number} 0 when the audit passes, 1 otherwise
 */
function main(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    out.write(`${err.message}\n`);
    return 1;
  }
  const entries = compileLedger(JSON.parse(fs.readFileSync(parsed.ledgerPath, 'utf8')));
  const merged = { total: 0, skipped: [] };
  for (const r of parsed.reports) {
    if (!fs.existsSync(r)) {
      out.write(`report not found: ${r} — the suite wrote no junit output, so nothing was certified\n`);
      return 1;
    }
    const one = parseJunit(fs.readFileSync(r, 'utf8'));
    merged.total += one.total;
    merged.skipped.push(...one.skipped);
  }
  const result = audit(merged, entries);
  const report = formatReport(result, entries);
  out.write(report);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, report);
  return result.ok ? 0 : 1;
}

module.exports = { parseJunit, compileLedger, audit, formatReport, parseArgs, main, DEFAULT_LEDGER };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
