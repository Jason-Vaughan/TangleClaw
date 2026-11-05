#!/usr/bin/env node
'use strict';

/**
 * CLI for #2877: in-repo mounting of `lib/roadmap-admission.js` +
 * `lib/roadmap-sync.js` via `lib/tc-docs-scorecard-merge-wiring.js`'s
 * `roadmapCheckTrainAdmission`/`roadmapRunSyncCycle`, for the external
 * `Shared/TangleClaw-Shared/roadmap-board/sync-board.sh` and PM
 * train-dispatch preflight to invoke without touching any file outside
 * this repository (`A504-W1A-R2`).
 *
 * Two subcommands:
 *
 *   node scripts/roadmap-sync-check.js sync --state <file> --issues <n,n,...> [--repo <path>] [--since <iso>]
 *     Fetches live issue summaries for `--issues`, runs one incremental sync
 *     cycle against `--state`, and prints `{published, changed, state}` as
 *     JSON. This script does NOT render real roadmap HTML -- that lives in
 *     `Shared/TangleClaw-Shared/roadmap-board`, outside this repo, and is
 *     explicitly not this car's concern. `published` here means "the
 *     changed-issue set differs from the prior run", exactly the signal the
 *     external renderer needs to decide whether a real re-render is worth
 *     doing at all.
 *
 *   node scripts/roadmap-sync-check.js admission --candidate <file> --facts <file> [--receipt <file>] [--manifest <file>]
 *     Runs `roadmapCheckTrainAdmission` against caller-supplied
 *     candidate/facts/receipt/manifest JSON and prints
 *     `{classification, reasons, manifest, admission}` as JSON. This script
 *     does not itself gather "facts" (live issue/PR state for a candidate's
 *     prerequisites) -- that is the PM train-dispatch preflight's own job,
 *     same division of labor `roadmapCheckTrainAdmission` itself documents.
 *     Exits 2 on a `RoadmapAdmissionError` refusal.
 *
 * Exit codes: 0 answered · 1 usage error · 2 refused or unavailable.
 */

const fs = require('node:fs');
const path = require('node:path');

const wiring = require(path.join(__dirname, '..', 'lib', 'tc-docs-scorecard-merge-wiring.js'));
const roadmapSync = require(path.join(__dirname, '..', 'lib', 'roadmap-sync.js'));
const roadmapAdmission = require(path.join(__dirname, '..', 'lib', 'roadmap-admission.js'));

/**
 * Read and parse one JSON file, for a caller-supplied input the CLI itself
 * does not validate beyond "is this readable JSON".
 * @param {string} file
 * @returns {*}
 */
function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * A minimal `--flag value` parser: every flag in `known` takes exactly one
 * value, order is free, and anything else is refused by name rather than
 * silently ignored.
 * @param {string[]} argv
 * @param {string[]} known
 * @returns {{flags: Record<string,string>}|{unexpected: string}}
 */
function parseFlags(argv, known) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!known.includes(a)) return { unexpected: a };
    flags[a] = argv[i + 1];
    i++;
  }
  return { flags };
}

/**
 * `sync` subcommand. See module docstring.
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
async function runSync(argv) {
  const parsed = parseFlags(argv, ['--repo', '--state', '--issues', '--since']);
  if (parsed.unexpected !== undefined) {
    process.stderr.write(`roadmap-sync-check sync: unexpected flag "${parsed.unexpected}"\n`);
    return 1;
  }
  const { flags } = parsed;
  if (!flags['--state'] || !flags['--issues']) {
    process.stderr.write('roadmap-sync-check sync: --state and --issues are required\n');
    return 1;
  }
  const repo = flags['--repo'] || process.cwd();
  const numbers = flags['--issues'].split(',').map((s) => s.trim()).filter(Boolean);
  const live = await roadmapSync.fetchIssueSummaries(repo, numbers, flags['--since'] ? { since: flags['--since'] } : {});
  if (!live.available) {
    process.stderr.write(`roadmap-sync-check sync: issue list unavailable -- ${live.reason}\n`);
    return 2;
  }
  // Not the real roadmap HTML (see module docstring) -- a stable,
  // content-addressed proxy so `shouldPublishRoadmap` compares something
  // that actually changes when the issue set does, and nothing else. The
  // "nothing happened" baseline is a fixed constant, not read from
  // `prevState`: `computeChangedSince`'s own three arrays are already
  // relative-to-last-snapshot diffs, so "this run found nothing new" is
  // exactly "all three are empty", independent of what any PRIOR run
  // found (I-Gate R1 BLOCKING 1, #issuecomment on PR #2908: the original
  // version called `changed.map(...)` -- computeChangedSince returns
  // `{changedIssueIds, newlyLinkedPrIssueIds, skippableClosedIssueIds}`,
  // not an array, so every real sync call threw TypeError).
  const EMPTY_DIFF_PROXY = JSON.stringify({ changed: [], newlyLinked: [], skippableClosed: [] });
  const result = await wiring.roadmapRunSyncCycle({
    file: flags['--state'],
    liveSummaries: live.summaries,
    renderRoadmap: (prevState, changed, now) => {
      const nextHtml = JSON.stringify({
        changed: [...changed.changedIssueIds].sort(),
        newlyLinked: [...changed.newlyLinkedPrIssueIds].sort(),
        skippableClosed: [...changed.skippableClosedIssueIds].sort()
      });
      // Persist what was actually fetched this run, so the NEXT run's own
      // computeChangedSince has real prior state to diff against instead
      // of treating every issue as newly changed every time (the second
      // half of BLOCKING 1: the original version never wrote `issues` into
      // `nextState` at all).
      const issues = { ...((prevState && prevState.issues) || {}) };
      for (const s of live.summaries) {
        issues[s.id] = { updatedAt: s.updatedAt, closed: s.closed };
      }
      const nextState = { ...prevState, issues, lastRunAt: new Date(now).toISOString() };
      return { prevHtml: EMPTY_DIFF_PROXY, nextHtml, nextState };
    }
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

/**
 * `admission` subcommand. See module docstring.
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
async function runAdmission(argv) {
  const parsed = parseFlags(argv, ['--candidate', '--facts', '--receipt', '--manifest']);
  if (parsed.unexpected !== undefined) {
    process.stderr.write(`roadmap-sync-check admission: unexpected flag "${parsed.unexpected}"\n`);
    return 1;
  }
  const { flags } = parsed;
  if (!flags['--candidate'] || !flags['--facts']) {
    process.stderr.write('roadmap-sync-check admission: --candidate and --facts are required\n');
    return 1;
  }
  const candidate = readJsonFile(flags['--candidate']);
  const facts = readJsonFile(flags['--facts']);
  const receipt = flags['--receipt'] ? readJsonFile(flags['--receipt']) : undefined;
  const manifest = flags['--manifest'] ? readJsonFile(flags['--manifest']) : undefined;
  try {
    const result = wiring.roadmapCheckTrainAdmission({ candidate, facts, receipt, manifest });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof roadmapAdmission.RoadmapAdmissionError) {
      process.stderr.write(`roadmap-sync-check admission: refused -- ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === 'sync') { process.exitCode = await runSync(rest); return; }
  if (sub === 'admission') { process.exitCode = await runAdmission(rest); return; }
  process.stderr.write(
    'usage: roadmap-sync-check sync --state <file> --issues <n,n,...> [--repo <path>] [--since <iso>]\n'
    + '       roadmap-sync-check admission --candidate <file> --facts <file> [--receipt <file>] [--manifest <file>]\n'
  );
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`roadmap-sync-check: unexpected failure -- ${err.message}\n`);
  process.exitCode = 2;
});
