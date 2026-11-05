#!/usr/bin/env node
'use strict';

/**
 * Produce the local project scorecard, `<base>/scorecard/v1.json` (#2144,
 * part of #1949's Train 30 umbrella) — the thin CLI around
 * `lib/scorecard-producer.js`'s figure computation and GitHub reading.
 *
 *   node scripts/scorecard-produce.js [--base <dir>] [--repo <dir>] [--window-days N] [--fresh-hours N]
 *
 * `--base` is the TangleClaw base directory the cache is written under
 * (`<base>/scorecard/v1.json`); `--repo` is a checkout of this repository,
 * for `gh` to resolve the owner/name and credentials from. Both default to
 * the current working directory. See `docs/runbooks/release-certification.md`
 * for what this produces, its known limitations, and how to schedule it —
 * #2144 itself leaves "who runs this and how often" an open question this
 * script does not decide.
 *
 * Exit codes: 0 written, 1 the figures could not be gathered or the
 * computed document was refused, 2 usage error.
 *
 * @module scripts/scorecard-produce
 */

const producer = require('../lib/scorecard-producer');
const scorecardCache = require('../lib/scorecard-cache');

/**
 * Parse `--base`, `--repo`, `--window-days`, `--fresh-hours`.
 * @param {string[]} argv
 * @returns {{base: string, repo: string, windowDays: (number|undefined), freshHours: (number|undefined)}|null} Options, or null on a usage error.
 */
function parseArgs(argv) {
  const opts = { base: process.cwd(), repo: process.cwd(), windowDays: undefined, freshHours: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) return null;
    if (flag === '--base') opts.base = value;
    else if (flag === '--repo') opts.repo = value;
    else if (flag === '--window-days') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) return null;
      opts.windowDays = n;
    } else if (flag === '--fresh-hours') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) return null;
      opts.freshHours = n;
    } else return null;
  }
  return opts;
}

/**
 * Produce and write the scorecard cache.
 * @param {string[]} argv
 * @param {object} [io] - `{stdout, stderr, now, produce, write}` seams for tests.
 * @returns {Promise<number>} Exit code.
 */
async function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (!opts) {
    err.write('usage: scorecard-produce [--base <dir>] [--repo <dir>] [--window-days N] [--fresh-hours N]\n');
    return 2;
  }
  const now = typeof io.now === 'number' ? io.now : Date.now();
  const produce = io.produce || producer.produceScorecardDocument;
  const write = io.write || scorecardCache.writeScorecardCache;

  const result = await produce(opts.repo, {
    now,
    windowDays: opts.windowDays,
    freshForMs: opts.freshHours ? opts.freshHours * 60 * 60 * 1000 : undefined
  });
  if (!result.available) {
    err.write(`could not gather scorecard figures: ${result.reason}\n`);
    return 1;
  }
  const file = scorecardCache.cachePath(opts.base);
  try {
    write(file, result.document);
  } catch (e) {
    err.write(`scorecard refused: ${e.message}\n`);
    return 1;
  }
  out.write(`${JSON.stringify({ file, generatedAt: result.document.generatedAt, freshUntil: result.document.freshUntil })}\n`);
  return 0;
}

module.exports = { main, parseArgs };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exitCode = 1;
  });
}
