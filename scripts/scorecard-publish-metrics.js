#!/usr/bin/env node
'use strict';

/**
 * Publish this host's local scorecard cache to the `origin/metrics` branch
 * (#2883) — the thin CLI around
 * `lib/tc-docs-scorecard-merge-wiring.js#publishScorecardToMetricsBranch`.
 *
 *   node scripts/scorecard-publish-metrics.js [--base <dir>] [--repo <dir>] [--branch <name>] [--path <repo-path>]
 *
 * `--base` is the TangleClaw base directory the cache is read from
 * (`<base>/scorecard/v1.json`, the same file `scripts/scorecard-produce.js`
 * writes); `--repo` is a checkout of this repository, for `git` to push
 * from. Both default to the current working directory. Refuses to publish
 * a cache that is not currently fresh (`status !== 'ok'`: missing, stale,
 * or otherwise unusable) — running `scorecard-produce.js` first is the
 * caller's job, the same split #2144 already draws for that script.
 *
 * Exit codes: 0 published, 1 the cache was not fresh or the push failed, 2 usage error.
 *
 * @module scripts/scorecard-publish-metrics
 */

const scorecardCache = require('../lib/scorecard-cache');
const wiring = require('../lib/tc-docs-scorecard-merge-wiring');

/**
 * Parse `--base`, `--repo`, `--branch`, `--path`.
 * @param {string[]} argv
 * @returns {{base: string, repo: string, branch: (string|undefined), path: (string|undefined)}|null} Options, or null on a usage error.
 */
function parseArgs(argv) {
  const opts = { base: process.cwd(), repo: process.cwd(), branch: undefined, path: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) return null;
    if (flag === '--base') opts.base = value;
    else if (flag === '--repo') opts.repo = value;
    else if (flag === '--branch') opts.branch = value;
    else if (flag === '--path') opts.path = value;
    else return null;
  }
  return opts;
}

/**
 * Read the local cache and publish it, refusing a cache that is not fresh.
 * @param {string[]} argv
 * @param {object} [io] - `{stdout, stderr, now, readScorecardCache, publish}` seams for tests.
 * @returns {Promise<number>} Exit code.
 */
async function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (!opts) {
    err.write('usage: scorecard-publish-metrics [--base <dir>] [--repo <dir>] [--branch <name>] [--path <repo-path>]\n');
    return 2;
  }
  const read = io.readScorecardCache || scorecardCache.readScorecardCache;
  const publish = io.publish || wiring.publishScorecardToMetricsBranch;
  const now = typeof io.now === 'number' ? io.now : Date.now();

  const file = scorecardCache.cachePath(opts.base);
  const cached = read(file, { now });
  if (cached.status !== scorecardCache.STATUS.OK) {
    err.write(`scorecard cache is not fresh (status: ${cached.status}${cached.reason ? `, ${cached.reason}` : ''}) -- run scorecard-produce.js first\n`);
    return 1;
  }

  const result = await publish({
    repoDir: opts.repo, document: cached.doc, enabled: true, branch: opts.branch, path: opts.path
  });
  if (!result.published) {
    err.write(`could not publish scorecard: ${result.reason}${result.detail ? ` (${result.detail})` : ''}\n`);
    return 1;
  }
  out.write(`${JSON.stringify({ branch: result.branch, commit: result.commit })}\n`);
  return 0;
}

module.exports = { main, parseArgs };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exitCode = 1;
  });
}
