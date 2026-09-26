#!/usr/bin/env node
'use strict';

// Remove the legacy TangleClaw sections a plugin-governed CLAUDE.md still
// carries above its Prawduct anchor, which the managed block below now
// duplicates (#1911). Nothing is removed without the operator's say-so.
//
//   node scripts/repair-governed-claude-md.js <project-path>                   preview; changes nothing
//   node scripts/repair-governed-claude-md.js <project-path> --apply <digest>  apply that exact preview
//   add --json for machine-readable output
//
// The preview lists every removal and whether each section's body matches the
// managed copy, since a matching heading does not prove the body was never
// edited. `--apply` takes the digest the preview printed: if the file, or the
// plan it yields, has changed since, the repair is refused and nothing is
// written. The file is replaced atomically, and a second run finds nothing to
// do. The Core, Extension and Global rules copies are never touched.

const fs = require('node:fs');
const path = require('node:path');

const REPO_DIR = path.resolve(__dirname, '..');
const legacy = require(path.join(REPO_DIR, 'lib', 'legacy-claude-md'));
const engines = require(path.join(REPO_DIR, 'lib', 'engines'));
const { isPluginGoverned } = require(path.join(REPO_DIR, 'lib', 'governance-state'));

const EXIT = Object.freeze({ OK: 0, REFUSED: 1, USAGE: 2 });
const CARRIER = 'CLAUDE.md';

/**
 * Parse the command line.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{projectPath: (string|null), digest: (string|null), json: boolean, error: (string|null)}}
 */
function parseArgs(argv) {
  const out = { projectPath: null, digest: null, json: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--apply') {
      out.digest = argv[++i] || null;
      if (!out.digest) out.error = '--apply needs the digest the preview printed';
    } else if (a.startsWith('--')) out.error = `unknown option ${a}`;
    else if (!out.projectPath) out.projectPath = path.resolve(a);
    else out.error = `unexpected argument ${a}`;
  }
  if (!out.error && !out.projectPath) out.error = 'a project path is required';
  return out;
}

/**
 * Human-readable preview of an analysis.
 * @param {string} file
 * @param {object} analysis - `analyzeLegacyCarrier` result.
 * @returns {string[]}
 */
function previewLines(file, analysis) {
  const lines = [`${file}`];
  if (analysis.refused) return [...lines, `  REFUSED: ${analysis.refused}`, '  Nothing can be removed until that is resolved by hand.'];
  if (!legacy.hasRepairWork(analysis)) return [...lines, `  Nothing to repair${analysis.reason ? `: ${analysis.reason}` : '.'}`];
  for (const c of analysis.candidates) {
    const what = c.kind === 'section' ? c.heading : 'bootstrap bullet';
    const match = c.matchesManagedCopy ? 'identical to the managed copy' : 'DIFFERS from the managed copy — check it for your own edits';
    lines.push(`  remove lines ${c.startLine}-${c.endLine} (${c.bytes} bytes): ${what} — ${match}`);
  }
  lines.push(analysis.header.replaceable
    ? `  replace header "${analysis.header.line}" with "${legacy.NEUTRAL_HEADER}"`
    : `  keep header "${analysis.header.line}" (not the generated form)`);
  lines.push('  Kept: everything else, including the Core, Extension and Global rules copies and all content from the Prawduct anchor on.');
  lines.push(`  To apply exactly this: ${legacy.repairCommand(path.dirname(file), analysis.digest)}`);
  return lines;
}

/**
 * Run the tool.
 * @param {string[]} argv
 * @returns {number} Exit code.
 */
function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`${args.error}\nusage: node scripts/repair-governed-claude-md.js <project-path> [--apply <digest>] [--json]\n`);
    return EXIT.USAGE;
  }
  const file = path.join(args.projectPath, CARRIER);
  const emit = (payload, text) => process.stdout.write(args.json ? `${JSON.stringify(payload)}\n` : `${text.join('\n')}\n`);
  if (!isPluginGoverned(args.projectPath)) {
    emit({ status: 'refused', reason: 'project is not plugin-governed' }, [`${args.projectPath} is not plugin-governed — nothing to do.`]);
    return EXIT.REFUSED;
  }
  const ctx = engines.legacyCarrierContext('markdown');
  if (!args.digest) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      emit({ status: 'refused', reason: err.message }, [`could not read ${file}: ${err.message}`]);
      return EXIT.REFUSED;
    }
    const analysis = legacy.analyzeLegacyCarrier(text, ctx);
    emit({ status: 'preview', file, ...analysis }, previewLines(file, analysis));
    return analysis.refused ? EXIT.REFUSED : EXIT.OK;
  }
  const result = legacy.applyLegacyRepair(file, args.digest, ctx);
  const text = result.status === 'applied'
    ? [`${file}: repaired, ${result.removedBytes} bytes removed.`]
    : result.status === 'noop'
      ? [`${file}: nothing to repair (${result.reason}). Unchanged.`]
      : [`${file}: REFUSED — ${result.reason}. Unchanged.`];
  emit({ status: result.status, file, reason: result.reason, removedBytes: result.removedBytes }, text);
  return result.status === 'refused' ? EXIT.REFUSED : EXIT.OK;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseArgs, previewLines, main, EXIT };
