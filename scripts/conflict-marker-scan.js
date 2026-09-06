#!/usr/bin/env node
'use strict';

/**
 * Fail a run when a tracked file carries raw git conflict markers.
 *
 * A merge resolved by committing the conflict verbatim — all three marker lines
 * kept, both sides bracketed — produced a syntactically corrupt
 * `.prawduct/change-log.md` that sat on `main` across three sessions with nothing
 * noticing (#882). That file is the release flow's input: entries that do not
 * parse are entries the release cannot see. The suite ran thousands of tests over
 * it and none of them asked the cheapest possible question.
 *
 * The whole detector is one `git grep`. It costs well under a second, it covers
 * every tracked file rather than the one that happened to break, and it needs no
 * install step — CI already exists.
 *
 * **Scope is the tracked working tree**, which is a property of the repository
 * rather than of the machine running the scan, so a green here means the same
 * thing on a contributor's laptop and on a `--depth 1` CI checkout. `git grep`
 * with no revision reads the working tree and skips untracked and ignored files,
 * which is correct: an uncommitted marker is a conflict still being resolved.
 *
 * Usage: node scripts/conflict-marker-scan.js [<repo path>]
 * Exit 0 when the tree is clean, 1 when a marker is found or git cannot answer.
 */

const { spawnSync } = require('node:child_process');

/**
 * Every line `git merge` writes into a conflicted file. Four forms, not three:
 * the default `merge.conflictStyle` writes the opening, separator and closing
 * markers, and `diff3`/`zdiff3` (git >= 2.35, a common operator setting) adds
 * `||||||| <label>` to open the base section. Each is matched ALONE, because the
 * case worth catching is a half-resolved file — a resolution that deleted the
 * bracketing lines and left the base marker is corrupt in the way that buries an
 * entry rather than brackets two.
 *
 * Anchored at the start of the line and closed by a space or the line end, which
 * is the shape git emits: the labelled markers carry a label, the separator and
 * base markers stand alone. A marker cannot be indented and prose does not start
 * a line this way, so this needs no exclusion list — with one known collision,
 * named in the failure output: a markdown setext underline of exactly seven `=`
 * matches the separator branch. Deliberately not fixed by requiring the full set;
 * the lone separator is exactly what #882 was.
 */
const MARKER_PATTERN = '^(<{7}|\\|{7}|={7}|>{7})( |$)';

/** How long the scan may take before it is treated as unanswered. */
const SCAN_TIMEOUT_MS = 60 * 1000;

/**
 * Output cap for the scan. Well above any plausible number of marker lines, and
 * raised past the default so a tree with many hits reports THE HITS rather than
 * an `ENOBUFS` the operator would read as a broken scan.
 */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Scan a repository's tracked working tree for conflict markers.
 *
 * @param {string} cwd - Absolute path to the repository to scan.
 * @param {Function} [spawn=spawnSync] - `spawnSync` replacement, for tests.
 * @returns {{ok:boolean, hits:string[], error:(string|null)}} `ok` is true only
 *   when git answered AND found nothing. `hits` carries one `file:line:text` per
 *   match. `error` names why git could not answer, and is null on a real answer —
 *   an unanswerable scan is a failure, never a clean tree.
 */
function scan(cwd, spawn = spawnSync) {
  const res = spawn('git', ['grep', '-nE', MARKER_PATTERN], {
    cwd,
    encoding: 'utf8',
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES
  });

  if (res.error) return { ok: false, hits: [], error: res.error.message };
  // `git grep` exits 0 with matches, 1 with none, and >1 on a real failure.
  if (res.status === 1) return { ok: true, hits: [], error: null };
  if (res.status !== 0) {
    const detail = String(res.stderr || '').trim() || `git grep exited ${res.status}`;
    return { ok: false, hits: [], error: detail };
  }

  const hits = String(res.stdout || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return { ok: hits.length === 0, hits, error: null };
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @param {{log:Function, error:Function}} [out=console] - Output sink, for tests.
 * @returns {number} Process exit code.
 */
function main(argv, out = console) {
  const cwd = argv[0] || process.cwd();
  const result = scan(cwd);

  if (result.error) {
    out.error(`conflict-marker scan could not run: ${result.error}`);
    return 1;
  }
  if (result.ok) {
    out.log('No conflict markers in tracked files.');
    return 0;
  }

  out.error('Conflict markers found in tracked files:');
  for (const hit of result.hits) out.error(`  ${hit}`);
  out.error('');
  out.error('Resolve the merge properly and commit the result — keeping both sides where');
  out.error('the conflict was two distinct additions rather than a real disagreement.');
  out.error('');
  out.error('One known false positive: a markdown setext underline of exactly seven "="');
  out.error('under a seven-character heading. If that is what this is, change the underline');
  out.error('length or use a "#" heading — the separator match is deliberate and stays.');
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { scan, main, MARKER_PATTERN, SCAN_TIMEOUT_MS, MAX_OUTPUT_BYTES };
