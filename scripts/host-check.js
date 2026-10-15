#!/usr/bin/env node
'use strict';

/**
 * The read-only host check: what this machine's names, Caddyfile,
 * certificates, serve routes and local trust say, compared, with nothing
 * changed (#1380, #2142). The rows and their states are in `lib/host-check.js`.
 *
 *   node scripts/host-check.js [--reveal]
 *
 * Reads TangleClaw's base directory (`TANGLECLAW_HOME`, else `~/.tangleclaw`).
 * Output is redacted unless `--reveal` is given; `--reveal` is for the
 * operator's own terminal and never shows credentials or key material.
 *
 * Exit codes: 0 every row ok or observed; 3 any drift or ambiguous; 4 any
 * row not measurable, or the check itself failing; 2 a usage error.
 *
 * @module scripts/host-check
 */

const logger = require('../lib/logger');
const hostCheck = require('../lib/host-check');

const USAGE = 'Usage: node scripts/host-check.js [--reveal]\n';

/**
 * Parse the command line.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{reveal: boolean, help: boolean}|null} Options, or null on a usage error.
 */
function parseArgs(argv) {
  const opts = { reveal: false, help: false };
  for (const arg of argv) {
    if (arg === '--reveal') opts.reveal = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else return null;
  }
  return opts;
}

/**
 * Run the check and print the report.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {Promise<number>} Exit code.
 */
async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts) {
    process.stderr.write(USAGE);
    return hostCheck.EXIT_USAGE;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return hostCheck.EXIT_OK;
  }
  // Silenced here, in this standalone process only, before any helper runs:
  // library log lines can carry raw paths, which would defeat redaction. The
  // diagnostics are not lost: each row carries a reason code, and a row that
  // throws keeps its message for `--reveal`.
  logger.setConsoleStream({ write() {} });
  const result = await hostCheck.runHostCheck();
  process.stdout.write(hostCheck.formatReport(result, { reveal: opts.reveal }));
  return result.exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    // Exit explicitly: a row abandoned at the budget may still hold a timer or
    // a child process, and the budget is a promise to the operator.
    process.exit(code);
  }, (err) => {
    // A failure outside every row: nothing was measured. Only the error's code
    // is printed, because its message can carry paths the report would redact.
    process.stderr.write(`host-check failed: ${err && typeof err.code === 'string' ? err.code : 'internal-error'}\n`);
    process.exit(hostCheck.EXIT_UNKNOWN);
  });
}

module.exports = { parseArgs, main };
