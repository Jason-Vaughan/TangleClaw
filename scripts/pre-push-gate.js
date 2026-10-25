#!/usr/bin/env node
'use strict';

/**
 * The repository's own pre-push verification gate (#2595, standalone half —
 * A473-A1 serializes the other half to W2-B).
 *
 * v5.37.0's post-mortem (A472): three first-pass CI failures happened
 * because a Builder ran narrow `node --test <file>` before pushing instead
 * of `node scripts/test-stage.js 1 && node scripts/test-stage.js 2 --base
 * origin/main` — the command every lane rule already requires before `git
 * push`. This file is that command as one gate, meant to be wired into a
 * `pre-push` hook so forgetting it blocks the push instead of reaching CI.
 *
 * It does not install itself. `lib/control-hooks.js` (#1861) already owns
 * `.git/hooks/pre-push` for this repository — chaining, foreign-hook
 * preservation, fingerprinting — and is W1-C's exclusive file in this wave
 * (A473 B2). Writing a second, competing installer here would collide with
 * it. Per the Integrator/PM ruling on the W1-B/W1-C file-scope conflict
 * (A473-A1), W1-B ships this gate standalone; W2-B wires it into
 * `lib/control-hooks.js`'s dispatcher after W1-C merges, closing #2595.
 *
 * Stage 1 (static: dead-export ratchet, tier ledger, syntax, conflict
 * markers, the static ring) runs first; Stage 2 (the diff's touched tests,
 * each tier under its guard) runs only if Stage 1 is green, against
 * `--base` (default `origin/main`). Either stage red blocks the push.
 *
 * Usage: node scripts/pre-push-gate.js [--base <ref>]
 *   --base <ref>  passed to Stage 2 (default `origin/main`)
 * Exit 0 when both stages are green; 1 otherwise.
 */

const testStage = require('./test-stage');

/**
 * Parse argv.
 *
 * @param {string[]} argv - Arguments after the script name
 * @returns {{base: string}}
 */
function parseArgs(argv) {
  const parsed = { base: 'origin/main' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--base' && argv[i + 1]) { parsed.base = argv[++i]; continue; }
    throw new Error(`unknown or incomplete argument: ${flag}\nusage: pre-push-gate.js [--base <ref>]`);
  }
  return parsed;
}

/**
 * Run Stage 1, then (only if green) Stage 2 against `base`.
 *
 * @param {string} base - The ref Stage 2 diffs against
 * @param {{stdout?: {write: function(string): any}, root?: string, touchedIo?: object}} [io] - Seams, passed through to `scripts/test-stage.js`
 * @returns {number} 0 when both stages are green, 1 when either is red
 */
function runGate(base, io = {}) {
  const out = io.stdout || process.stdout;
  out.write('pre-push gate: stage 1 (static)\n');
  const stage1 = testStage.main(['1'], { stdout: out, root: io.root });
  if (stage1 !== 0) {
    out.write('pre-push gate: stage 1 failed; push blocked\n');
    return 1;
  }
  out.write(`pre-push gate: stage 2 (touched, base ${base})\n`);
  const stage2 = testStage.main(['2', '--base', base], { stdout: out, root: io.root, touchedIo: io.touchedIo });
  if (stage2 !== 0) {
    out.write('pre-push gate: stage 2 failed; push blocked\n');
    return 1;
  }
  out.write('pre-push gate: stage 1 and stage 2 are green; push allowed\n');
  return 0;
}

/**
 * Run the command end to end and return the process exit code.
 *
 * @param {string[]} argv - Arguments after the script name
 * @param {{stdout?: {write: function(string): any}, root?: string, touchedIo?: object}} [io] - Injection seams
 * @returns {number} The exit code
 */
function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    out.write(`${err.message}\n`);
    return 1;
  }
  return runGate(parsed.base, io);
}

module.exports = { parseArgs, runGate, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
