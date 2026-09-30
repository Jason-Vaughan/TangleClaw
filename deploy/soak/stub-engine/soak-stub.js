#!/usr/bin/env node
'use strict';

/**
 * The soak's stub engine (#2020): a deterministic, network-free stand-in for
 * an AI engine CLI, so the 72-hour soak can keep TangleClaw's session, PTY and
 * command-injection paths under continuous load inside a guest with no egress
 * and no vendor credentials.
 *
 * What it proves is limited on purpose. It exercises TangleClaw's side of a
 * session (launch, tmux, ttyd, command injection, kill), never a real
 * vendor's engine. Real-engine behaviour is outside the soak.
 *
 * Protocol: print a ready line, then a prompt. For each input line, answer
 * `ack <n> <first 12 hex chars of sha256(line)>` and prompt again. `/exit` or
 * end of input exits 0. The same input always gives the same output.
 *
 * Installed in the guest as `soak-stub` on PATH, with `soak-stub.json` in
 * `~/.tangleclaw/engines/`.
 *
 * @module deploy/soak/stub-engine/soak-stub
 */

const crypto = require('node:crypto');
const readline = require('node:readline');

const PROMPT = 'stub> ';

/**
 * The answer to one input line.
 * @param {number} n - 1-based line number
 * @param {string} line - The line, without its newline
 * @returns {string} The answer
 */
function answer(n, line) {
  return `ack ${n} ${crypto.createHash('sha256').update(line).digest('hex').slice(0, 12)}`;
}

/**
 * Run the stub against a pair of streams.
 * @param {NodeJS.ReadableStream} input - Where commands arrive
 * @param {NodeJS.WritableStream} output - Where answers go
 * @returns {Promise<void>} Resolves when input ends or `/exit` arrives
 */
function run(input, output) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, terminal: false });
    let n = 0;
    let exited = false;
    output.write(`soak-stub ready\n${PROMPT}`);
    rl.on('line', (line) => {
      // readline still delivers lines it had already buffered after close(),
      // so without this flag input sent after /exit would be answered.
      if (exited) return;
      if (line.trim() === '/exit') {
        exited = true;
        rl.close();
        return;
      }
      n++;
      output.write(`${answer(n, line)}\n${PROMPT}`);
    });
    rl.on('close', resolve);
  });
}

if (require.main === module) {
  run(process.stdin, process.stdout).then(() => process.exit(0));
}

module.exports = { answer, run, PROMPT };
