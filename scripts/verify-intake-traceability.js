#!/usr/bin/env node
'use strict';

/**
 * End-to-end intake-to-release traceability (#3279, V6-050/V6-051).
 *
 * The original v6 requirements dump cites each planned unit of work as an
 * `Intake Reference: V6-NNN` (every issue filed from it carries this in its
 * body — see any issue this session touched, e.g. #3270, #3276, #3265,
 * #3278). This script's job is narrower than "reconcile the entire dump":
 * it is the repeatable CHECK that a GitHub issue citing an intake reference
 * actually got one, and that a closed issue has real shipped evidence
 * (a changelog fragment or a `CHANGELOG.md` line naming it) rather than
 * being closed with nothing to show for it. The reconciliation itself (is
 * V6-NNN's own text still accurate, does every dump entry have an issue at
 * all) is a one-time editorial pass over the dump, not a thing this script
 * can determine from the repo alone — it checks what IS traceable, and
 * names what it cannot see.
 *
 * Pure logic lives in exported functions, tested in
 * `test/verify-intake-traceability.test.js` against fake issue data — no
 * network call in the test. The CLI entry point (gated by
 * `require.main === module`, the same convention `scripts/test-tiers.js`
 * and `scripts/with-scratch-server.js` use) does the real `gh`/`git` I/O.
 *
 * Usage: node scripts/verify-intake-traceability.js [--write]
 *   --write   Also update docs/audits/v6-requirements-traceability-matrix.md.
 *             Without it, the report prints to stdout only.
 *
 * @module scripts/verify-intake-traceability
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Matches a backtick-fenced `V6-NNN` anywhere in an "Intake Reference(s):"
 * heading line — singular with one reference (`` `V6-026` ``) or plural with
 * several joined by `&` (`` `V6-050` & `V6-051` ``, issue #3279's own shape).
 * Global, so every reference on that line is found, not just the first.
 */
const INTAKE_REF_RE = /`(V6-\d+)`/g;
/** Confirms the line itself is an intake-reference heading, before scanning it for ids. */
const INTAKE_HEADING_RE = /Intake Reference[s]?:/;

/**
 * Extract every intake reference an issue body's heading line declares.
 * @param {string} body - The issue body text.
 * @returns {string[]} e.g. `["V6-026"]` or `["V6-050", "V6-051"]`; empty if none declared.
 */
function parseIntakeReferences(body) {
  if (typeof body !== 'string') return [];
  const headingLine = body.split('\n').find((line) => INTAKE_HEADING_RE.test(line));
  if (!headingLine) return [];
  return [...headingLine.matchAll(INTAKE_REF_RE)].map((m) => m[1]);
}

/**
 * Build the traceability matrix for a set of already-fetched issues.
 * @param {{number: number, title: string, state: string, body: string}[]} issues
 * @param {Set<number>} shippedIssueNumbers - Issue numbers a changelog
 *   fragment or `CHANGELOG.md` already names as shipped (the caller
 *   determines this however it likes — this function never reads either).
 * @returns {{
 *   rows: {issueNumber: number, title: string, state: string, intakeRefs: string[], shipped: boolean}[],
 *   missingIntakeRef: number[],
 *   closedWithoutShippedEvidence: number[],
 *   summary: {total: number, withIntakeRef: number, shipped: number}
 * }}
 */
function buildTraceabilityMatrix(issues, shippedIssueNumbers) {
  if (!Array.isArray(issues)) throw new TypeError('issues must be an array');
  if (!(shippedIssueNumbers instanceof Set)) throw new TypeError('shippedIssueNumbers must be a Set');

  const rows = issues.map((issue) => {
    const intakeRefs = parseIntakeReferences(issue.body);
    const shipped = shippedIssueNumbers.has(issue.number);
    return { issueNumber: issue.number, title: issue.title, state: issue.state, intakeRefs, shipped };
  });

  const missingIntakeRef = rows.filter((r) => r.intakeRefs.length === 0).map((r) => r.issueNumber);
  const closedWithoutShippedEvidence = rows
    .filter((r) => r.state === 'CLOSED' && !r.shipped)
    .map((r) => r.issueNumber);

  return {
    rows,
    missingIntakeRef,
    closedWithoutShippedEvidence,
    summary: {
      total: rows.length,
      withIntakeRef: rows.length - missingIntakeRef.length,
      shipped: rows.filter((r) => r.shipped).length
    }
  };
}

/**
 * Render the matrix as a Markdown report.
 * @param {ReturnType<typeof buildTraceabilityMatrix>} matrix
 * @param {string} generatedAt - An ISO timestamp, so the report states when it ran.
 * @returns {string}
 */
function renderMatrixMarkdown(matrix, generatedAt, scopeNote) {
  const lines = [];
  lines.push('# V6 Requirements Traceability Matrix');
  lines.push('');
  lines.push(`Generated ${generatedAt} by \`scripts/verify-intake-traceability.js\`. This checks what is`);
  lines.push('traceable from the issues this scan saw; it does not independently verify the original');
  lines.push('v6 requirements dump itself still matches each cited `V6-NNN`.');
  if (scopeNote) {
    lines.push('');
    lines.push(scopeNote);
  }
  lines.push('');
  lines.push(`- ${matrix.summary.total} issue(s) scanned, ${matrix.summary.withIntakeRef} with an \`Intake Reference\`, ${matrix.summary.shipped} with shipped evidence.`);
  if (matrix.missingIntakeRef.length > 0) {
    lines.push(`- Missing an \`Intake Reference\`: ${matrix.missingIntakeRef.map((n) => `#${n}`).join(', ')}`);
  }
  if (matrix.closedWithoutShippedEvidence.length > 0) {
    lines.push(`- Closed with no shipped evidence found (changelog fragment or \`CHANGELOG.md\` line): ${matrix.closedWithoutShippedEvidence.map((n) => `#${n}`).join(', ')}`);
  }
  lines.push('');
  lines.push('| Issue | Intake Ref | State | Shipped | Title |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of matrix.rows) {
    lines.push(`| #${r.issueNumber} | ${r.intakeRefs.length > 0 ? r.intakeRefs.join(', ') : '—'} | ${r.state} | ${r.shipped ? 'yes' : 'no'} | ${r.title.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Real I/O: fetch issues via `gh`, and shipped evidence via `CHANGELOG.md` +
 * `changelog.d/*`'s own issue-number convention. Not called by the test file.
 *
 * `minIssueNumber` scopes the scan to the current intake dump rather than
 * the repo's full history: as of this writing every `Intake Reference`
 * anywhere in the tracker falls between #3258 and #3285 (checked by scanning
 * all 1506 issues once, not assumed) -- the convention is new, not
 * retroactive, so an older issue having none is expected, not a gap. The
 * floor is a fixed constant, not re-derived at runtime, because that scan is
 * exactly the kind of one-time cost this script exists to avoid repeating.
 * @param {{milestone?: string, minIssueNumber?: number}} [options]
 * @returns {{issues: object[], shippedIssueNumbers: Set<number>}}
 */
function _fetchRealData(options = {}) {
  const minIssueNumber = options.minIssueNumber ?? 3200;
  const args = ['issue', 'list', '--state', 'all', '--json', 'number,title,state,body', '--limit', '500'];
  if (options.milestone) args.push('--milestone', options.milestone);
  const raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const issues = JSON.parse(raw)
    .map((i) => ({ ...i, state: String(i.state).toUpperCase() }))
    .filter((i) => i.number >= minIssueNumber);

  const shipped = new Set();
  const changelogText = fs.existsSync('CHANGELOG.md') ? fs.readFileSync('CHANGELOG.md', 'utf8') : '';
  const fragmentDir = 'changelog.d';
  const fragmentNames = fs.existsSync(fragmentDir) ? fs.readdirSync(fragmentDir) : [];
  for (const issue of issues) {
    const ref = `#${issue.number}`;
    if (changelogText.includes(ref) || fragmentNames.some((f) => f.startsWith(`${issue.number}.`))) {
      shipped.add(issue.number);
    }
  }
  return { issues, shippedIssueNumbers: shipped };
}

if (require.main === module) {
  const write = process.argv.includes('--write');
  const { issues, shippedIssueNumbers } = _fetchRealData();
  const matrix = buildTraceabilityMatrix(issues, shippedIssueNumbers);
  const scopeNote = 'Scope: issues #3200 and above only. Checked once against the full tracker '
    + '(1506 issues, #1 through #3291) that every existing `Intake Reference` falls between #3258 '
    + 'and #3285 -- the convention is new to this intake wave, not retroactive, so an older issue '
    + 'having none is expected and is not listed as a gap here.';
  const markdown = renderMatrixMarkdown(matrix, new Date().toISOString(), scopeNote);
  if (write) {
    const outPath = path.join('docs', 'audits', 'v6-requirements-traceability-matrix.md');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, markdown);
    process.stdout.write(`wrote ${outPath}\n`);
  } else {
    process.stdout.write(markdown);
  }
}

module.exports = { parseIntakeReferences, buildTraceabilityMatrix, renderMatrixMarkdown, INTAKE_REF_RE, INTAKE_HEADING_RE };
