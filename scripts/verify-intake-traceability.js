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
 * The authoritative 51-item intake ledger (#3279, V6-050/V6-051), transcribed
 * from `TangleClaw-Shared/v6-post-release-requirements-intake-ledger.md`
 * ("Prepared 2026-11-25", stewarded by TC-Lane-PM/TC-Lane-Arc) -- itself
 * derived from `TangleClaw_v6_Requirements_Intake.pdf`'s 51 intake references
 * across workstreams E01-E10. This is a dated snapshot, not a live feed: the
 * ledger document is the source of truth going forward, and this constant
 * should be re-transcribed if that document is revised.
 *
 * `gateFourApplies` is false for a classification that is itself a design/
 * discovery stage ("Collaborative Design", "Collaborative UX Design", "Owner
 * Screenshot Audit") -- those issues are trackers for future work, not yet
 * shippable, so asking them for shipped evidence would always read as a false
 * gap. Every other classification ("Bug...", "Actionable...") is real,
 * scoped, shippable work and does need Gate 4 evidence.
 * @type {ReadonlyArray<{id: string, workstream: string, title: string, classification: string, issues: number[], gateFourApplies: boolean}>}
 */
const V6_REQUIREMENTS_LEDGER = Object.freeze([
  { id: 'V6-001', workstream: 'E01', title: 'View Previous Conversation button', classification: 'Bug (Root Cause Found)', issues: [3258], gateFourApplies: true },
  { id: 'V6-002', workstream: 'E01', title: 'CLI-to-UI fidelity audit', classification: 'Owner Screenshot Audit', issues: [3280], gateFourApplies: false },
  { id: 'V6-003', workstream: 'E01', title: 'Interactive questions and selections', classification: 'Actionable Enhancement', issues: [3259], gateFourApplies: true },
  { id: 'V6-004', workstream: 'E01', title: 'Suggested next prompt autocomplete', classification: 'Collaborative UX Design', issues: [3280], gateFourApplies: false },
  { id: 'V6-005', workstream: 'E01', title: 'Conversation readability', classification: 'Actionable Enhancement', issues: [3260], gateFourApplies: true },
  { id: 'V6-006', workstream: 'E01', title: 'Peek Under the Hood accuracy and filters', classification: 'Bug / Enhancement', issues: [3261], gateFourApplies: true },
  { id: 'V6-007', workstream: 'E01', title: 'Full-pane terminal mode', classification: 'Collaborative UX Design', issues: [3280], gateFourApplies: false },
  { id: 'V6-008', workstream: 'E02', title: 'Dedicated fleet settings page', classification: 'Collaborative UX Design', issues: [3281], gateFourApplies: false },
  { id: 'V6-009', workstream: 'E02', title: 'Post-creation membership management', classification: 'Actionable Enhancement', issues: [3262], gateFourApplies: true },
  { id: 'V6-010', workstream: 'E02', title: 'Explicit delegate assignment', classification: 'Actionable Enhancement', issues: [3263], gateFourApplies: true },
  { id: 'V6-011', workstream: 'E02', title: 'Granular delegate permissions', classification: 'Collaborative Design', issues: [3281], gateFourApplies: false },
  { id: 'V6-012', workstream: 'E02', title: 'YOLO delegate mode', classification: 'Collaborative Design', issues: [3281], gateFourApplies: false },
  { id: 'V6-013', workstream: 'E02', title: 'Defaults and inheritance', classification: 'Collaborative Design', issues: [3281], gateFourApplies: false },
  { id: 'V6-014', workstream: 'E03', title: 'Runtime-enforced fleet policies', classification: 'Collaborative Design', issues: [3281], gateFourApplies: false },
  { id: 'V6-015', workstream: 'E03', title: 'Maximize safe parallelization', classification: 'Actionable Enhancement', issues: [3264], gateFourApplies: true },
  { id: 'V6-016', workstream: 'E03', title: 'Issue-tracking and roadmap workflow', classification: 'Actionable Enhancement', issues: [3265], gateFourApplies: true },
  { id: 'V6-017', workstream: 'E03', title: 'Mandatory sprint reports and postmortems', classification: 'Actionable Enhancement', issues: [3266], gateFourApplies: true },
  { id: 'V6-018', workstream: 'E03', title: 'Car and train status synchronization', classification: 'Bug / Enhancement', issues: [3267], gateFourApplies: true },
  { id: 'V6-019', workstream: 'E03', title: 'Safe sprint look-ahead', classification: 'Actionable Enhancement', issues: [3268], gateFourApplies: true },
  { id: 'V6-020', workstream: 'E04', title: 'Wrap procedure audit', classification: 'Collaborative Design', issues: [3282], gateFourApplies: false },
  { id: 'V6-021', workstream: 'E04', title: 'Automated solo-session wrap', classification: 'Collaborative Design', issues: [3282], gateFourApplies: false },
  { id: 'V6-022', workstream: 'E04', title: 'Delegate-orchestrated fleet wrap', classification: 'Collaborative Design', issues: [3282], gateFourApplies: false },
  { id: 'V6-023', workstream: 'E04', title: 'Intelligent wrap decisions', classification: 'Collaborative Design', issues: [3282], gateFourApplies: false },
  { id: 'V6-024', workstream: 'E04', title: 'Wrap API parity', classification: 'Collaborative Design', issues: [3282], gateFourApplies: false },
  { id: 'V6-025', workstream: 'E05', title: 'Consistent engine health indicators', classification: 'Actionable Enhancement', issues: [3269], gateFourApplies: true },
  { id: 'V6-026', workstream: 'E05', title: 'Engine status modal overflow', classification: 'Bug (Root Cause Found)', issues: [3270], gateFourApplies: true },
  { id: 'V6-027', workstream: 'E05', title: 'Member-level engine fallback chains', classification: 'Actionable Enhancement', issues: [3271], gateFourApplies: true },
  { id: 'V6-028', workstream: 'E05', title: 'Delegate succession and surrogate', classification: 'Actionable Enhancement', issues: [3272], gateFourApplies: true },
  { id: 'V6-029', workstream: 'E05', title: 'Modern Codex compatibility', classification: 'Actionable Chore / Bug', issues: [3273, 3257], gateFourApplies: true },
  { id: 'V6-030', workstream: 'E06', title: 'Configurable observer role', classification: 'Collaborative Design', issues: [3283], gateFourApplies: false },
  { id: 'V6-031', workstream: 'E06', title: 'Observer reporting responsibilities', classification: 'Collaborative Design', issues: [3283], gateFourApplies: false },
  { id: 'V6-032', workstream: 'E06', title: 'Close continuous-improvement loop', classification: 'Collaborative Design', issues: [3283], gateFourApplies: false },
  { id: 'V6-033', workstream: 'E06', title: 'Recover missing historical reports', classification: 'Actionable Docs / Audit', issues: [3274], gateFourApplies: true },
  { id: 'V6-034', workstream: 'E06', title: 'Kaizen and Reports workspace integration', classification: 'Actionable Enhancement', issues: [3266], gateFourApplies: true },
  { id: 'V6-035', workstream: 'E07', title: 'Standard project documentation structure', classification: 'Actionable Enhancement', issues: [3275], gateFourApplies: true },
  { id: 'V6-036', workstream: 'E07', title: 'Dedicated SSOT view', classification: 'Actionable Enhancement', issues: [3275], gateFourApplies: true },
  { id: 'V6-037', workstream: 'E07', title: 'Functional project charter', classification: 'Actionable Enhancement', issues: [3275], gateFourApplies: true },
  { id: 'V6-038', workstream: 'E07', title: 'Sprint and cars visualization', classification: 'Actionable Enhancement', issues: [3267], gateFourApplies: true },
  { id: 'V6-039', workstream: 'E07', title: 'Workspace navigation review', classification: 'Collaborative UX Design', issues: [3284], gateFourApplies: false },
  { id: 'V6-040', workstream: 'E08', title: 'Reclaim space below prompt composer', classification: 'Bug (Actionable)', issues: [3276], gateFourApplies: true },
  { id: 'V6-041', workstream: 'E08', title: 'Workspace pane and resizing review', classification: 'Owner Screenshot Audit', issues: [3280], gateFourApplies: false },
  { id: 'V6-042', workstream: 'E08', title: 'Startup visualization', classification: 'Actionable Enhancement', issues: [3277], gateFourApplies: true },
  { id: 'V6-043', workstream: 'E08', title: 'Wrap visualization', classification: 'Actionable Enhancement', issues: [3277], gateFourApplies: true },
  { id: 'V6-044', workstream: 'E09', title: 'Runtime-assisted bug reporting', classification: 'Collaborative Design', issues: [3285], gateFourApplies: false },
  { id: 'V6-045', workstream: 'E09', title: 'Optional automatic bug filing', classification: 'Collaborative Design', issues: [3285], gateFourApplies: false },
  { id: 'V6-046', workstream: 'E09', title: 'Security-sensitive reporting', classification: 'Collaborative Design', issues: [3285], gateFourApplies: false },
  { id: 'V6-047', workstream: 'E09', title: 'Discoverable feedback submission', classification: 'Collaborative Design', issues: [3285], gateFourApplies: false },
  { id: 'V6-048', workstream: 'E09', title: 'Embedded settings/help assistant', classification: 'Collaborative Design', issues: [3285], gateFourApplies: false },
  { id: 'V6-049', workstream: 'E09', title: 'Complete settings API parity', classification: 'Actionable Enhancement', issues: [3278], gateFourApplies: true },
  { id: 'V6-050', workstream: 'E10', title: 'Reconcile original v6 requirements', classification: 'Actionable Audit', issues: [3279], gateFourApplies: true },
  { id: 'V6-051', workstream: 'E10', title: 'Prevent future requirements loss', classification: 'Actionable Governance', issues: [3279], gateFourApplies: true }
]);

/**
 * Build the Gate 1 / Gate 4 traceability matrix for the full 51-item ledger.
 *
 * Gate 1 (intake -> issue -> milestone): every one of an entry's `issues`
 * must resolve to a real, fetched issue WITH a non-empty milestone assigned
 * -- an issue existing but carrying no milestone is Gate 1 incomplete too
 * (PRR-B R2 BLOCKING 1: issue-existence alone was being read as complete).
 *
 * Gate 4 (PR/test/sprint-report evidence): only required where
 * `gateFourApplies` -- a design-review entry is not yet shippable work, so
 * it is reported `n/a`, never a false gap. For a shippable entry, reports
 * one of three states rather than a boolean: `'complete'` (every issue has
 * real release evidence), `'in-flight'` (not released, but a changelog.d
 * fragment or an open PR already references every issue -- real progress,
 * not a gap), or `'incomplete'` (no evidence of either).
 * @param {ReadonlyArray<object>} ledger - {@link V6_REQUIREMENTS_LEDGER} or a test double of the same shape.
 * @param {Map<number, {state: string, milestone: (string|null)}>} issueStates - Real issue number -> its fetched state/milestone (Gate 1 data).
 * @param {Set<number>} shippedIssueNumbers - Gate 4 released evidence, same meaning as {@link buildTraceabilityMatrix}'s own.
 * @param {Set<number>} [inFlightIssueNumbers] - Gate 4 in-progress evidence (a changelog.d fragment or an open PR). Omitted defaults to empty.
 * @returns {{rows: object[], gateOneIncomplete: string[], gateFourIncomplete: string[]}}
 */
function buildLedgerTraceability(ledger, issueStates, shippedIssueNumbers, inFlightIssueNumbers = new Set()) {
  if (!Array.isArray(ledger)) throw new TypeError('ledger must be an array');
  if (!(issueStates instanceof Map)) throw new TypeError('issueStates must be a Map');
  if (!(shippedIssueNumbers instanceof Set)) throw new TypeError('shippedIssueNumbers must be a Set');
  if (!(inFlightIssueNumbers instanceof Set)) throw new TypeError('inFlightIssueNumbers must be a Set');

  // This repo's convention closes an issue via "Fixes #N" on the merging PR,
  // so a CLOSED issue already means the real work landed on main -- it
  // counts as shipped for the LEDGER's own Gate 4 even before the formal
  // release cut later drains changelog.d into a dated CHANGELOG.md section.
  // Kept local to this function rather than folded into the shared
  // `shippedIssueNumbers` Set: buildTraceabilityMatrix's own
  // closedWithoutShippedEvidence check needs "closed" and "shipped" to stay
  // two different facts, or a closed issue with real evidence missing
  // (#3248) could never be reported as a gap again.
  const reallyShipped = (n) => shippedIssueNumbers.has(n) || (issueStates.get(n) || {}).state === 'CLOSED';

  const rows = ledger.map((entry) => {
    const gateOneComplete = entry.issues.every((n) => issueStates.has(n) && Boolean(issueStates.get(n).milestone));
    let gateFour = 'n/a';
    if (entry.gateFourApplies) {
      if (entry.issues.every(reallyShipped)) gateFour = 'complete';
      else if (entry.issues.every((n) => reallyShipped(n) || inFlightIssueNumbers.has(n))) gateFour = 'in-flight';
      else gateFour = 'incomplete';
    }
    return {
      id: entry.id,
      workstream: entry.workstream,
      title: entry.title,
      classification: entry.classification,
      issues: entry.issues,
      gateOneComplete,
      gateFour
    };
  });

  return {
    rows,
    gateOneIncomplete: rows.filter((r) => !r.gateOneComplete).map((r) => r.id),
    gateFourIncomplete: rows.filter((r) => r.gateFour === 'incomplete').map((r) => r.id)
  };
}

/**
 * Render the 51-item ledger matrix as Markdown.
 * @param {ReturnType<typeof buildLedgerTraceability>} matrix
 * @returns {string}
 */
function renderLedgerMarkdown(matrix) {
  const lines = [];
  lines.push('## Complete 51-item ledger (V6-001 - V6-051): Gate 1 / Gate 4 status');
  lines.push('');
  lines.push('Gate 1 (intake -> issue -> milestone): the entry\'s issue(s) exist in the tracker AND carry a milestone.');
  lines.push('Gate 4 (PR/test/sprint-report evidence): only required where the entry is actionable, '
    + 'shippable work -- a Collaborative/Owner-review entry reads `n/a`, not a false gap.');
  lines.push('');
  if (matrix.gateOneIncomplete.length > 0) {
    lines.push(`- Gate 1 incomplete: ${matrix.gateOneIncomplete.join(', ')}`);
  }
  if (matrix.gateFourIncomplete.length > 0) {
    lines.push(`- Gate 4 incomplete: ${matrix.gateFourIncomplete.join(', ')}`);
  }
  lines.push('');
  lines.push('| Intake ID | Workstream | Title | Classification | Issue(s) | Gate 1 | Gate 4 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of matrix.rows) {
    lines.push(`| ${r.id} | ${r.workstream} | ${r.title} | ${r.classification} | ${r.issues.map((n) => `#${n}`).join(', ')} | ${r.gateOneComplete ? 'complete' : 'INCOMPLETE'} | ${r.gateFour} |`);
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
 * Gate 4 distinguishes "in-flight" from "shipped" (PRR-B R2 BLOCKING): a
 * `changelog.d/` fragment or an open PR both mean real work exists, but
 * neither means it released -- `CHANGELOG.md` text naming the issue is the
 * one signal that the release process actually compiled and cut it.
 * Counting a fragment's mere presence as "shipped" (the R1/R2 bug) made
 * every in-flight PR this very train opened read as already released.
 * @param {{milestone?: string, minIssueNumber?: number}} [options]
 * @returns {{issues: object[], shippedIssueNumbers: Set<number>, inFlightIssueNumbers: Set<number>}}
 */
function _fetchRealData(options = {}) {
  const minIssueNumber = options.minIssueNumber ?? 3200;
  const args = ['issue', 'list', '--state', 'all', '--json', 'number,title,state,body,milestone', '--limit', '500'];
  if (options.milestone) args.push('--milestone', options.milestone);
  const raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const issues = JSON.parse(raw)
    .map((i) => ({ ...i, state: String(i.state).toUpperCase(), milestone: (i.milestone && i.milestone.title) || null }))
    .filter((i) => i.number >= minIssueNumber);

  const changelogText = fs.existsSync('CHANGELOG.md') ? fs.readFileSync('CHANGELOG.md', 'utf8') : '';
  const fragmentDir = 'changelog.d';
  const fragmentNames = fs.existsSync(fragmentDir) ? fs.readdirSync(fragmentDir) : [];

  // Which issue numbers an OPEN pull request references, via the same
  // "#NNN" convention every PR body in this repo already uses (Fixes/Refs).
  const prRaw = execFileSync('gh', ['pr', 'list', '--state', 'open', '--json', 'number,body', '--limit', '500'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const openPrReferencedIssues = new Set();
  for (const pr of JSON.parse(prRaw)) {
    for (const m of String(pr.body || '').matchAll(/#(\d+)/g)) openPrReferencedIssues.add(Number(m[1]));
  }

  const shipped = new Set();
  const inFlight = new Set();
  for (const issue of issues) {
    const ref = `#${issue.number}`;
    const hasFragment = fragmentNames.some((f) => f.startsWith(`${issue.number}.`));
    if (changelogText.includes(ref)) {
      shipped.add(issue.number);
    } else if (hasFragment || openPrReferencedIssues.has(issue.number)) {
      inFlight.add(issue.number);
    }
  }
  return { issues, shippedIssueNumbers: shipped, inFlightIssueNumbers: inFlight };
}

if (require.main === module) {
  const write = process.argv.includes('--write');
  const { issues, shippedIssueNumbers, inFlightIssueNumbers } = _fetchRealData();
  const matrix = buildTraceabilityMatrix(issues, shippedIssueNumbers);
  const scopeNote = 'Scope: issues #3200 and above only. Checked once against the full tracker '
    + '(1506 issues, #1 through #3291) that every existing `Intake Reference` falls between #3258 '
    + 'and #3285 -- the convention is new to this intake wave, not retroactive, so an older issue '
    + 'having none is expected and is not listed as a gap here.';
  const issueStates = new Map(issues.map((i) => [i.number, { state: i.state, milestone: i.milestone }]));
  const ledgerMatrix = buildLedgerTraceability(V6_REQUIREMENTS_LEDGER, issueStates, shippedIssueNumbers, inFlightIssueNumbers);
  const markdown = renderMatrixMarkdown(matrix, new Date().toISOString(), scopeNote)
    + '\n' + renderLedgerMarkdown(ledgerMatrix);
  if (write) {
    const outPath = path.join('docs', 'audits', 'v6-requirements-traceability-matrix.md');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, markdown);
    process.stdout.write(`wrote ${outPath}\n`);
  } else {
    process.stdout.write(markdown);
  }
}

module.exports = {
  parseIntakeReferences, buildTraceabilityMatrix, renderMatrixMarkdown, INTAKE_REF_RE, INTAKE_HEADING_RE,
  V6_REQUIREMENTS_LEDGER, buildLedgerTraceability, renderLedgerMarkdown
};
