'use strict';

/**
 * Answer PortHub's single-port listener probe from a fixture set instead of
 * this machine's lsof.
 *
 * `checkPort`, `nextFreePort` and `registerPort` ask the machine about a port
 * before answering (#814). A suite that creates OpenClaw connections or leases
 * fixture ports would otherwise pass or fail depending on what the developer's
 * host is running — the fixture ranges overlap real services. Installing this
 * makes every port read as free except the ones the suite adds to the returned
 * set, which read as held by `command`.
 *
 * `portScanner._reset()` restores the real runner; each test file runs in its
 * own process, so a file that installs this once at load time needs no teardown.
 *
 * @param {string} [command='postgres'] - Process name a busy port reports
 * @returns {Set<number>} Ports the probe reports as listening; mutate it per test
 */
function probeAnswersFromFixture(command = 'postgres') {
  const portScanner = require('../lib/port-scanner');
  const busy = new Set();
  portScanner._setExec((cmd) => {
    const port = Number(/-iTCP:(\d+) /.exec(cmd)[1]);
    if (busy.has(port)) {
      return `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n${command} 812 me 7u IPv4 0x1 0t0 TCP *:${port} (LISTEN)`;
    }
    const err = new Error('no listener');
    err.status = 1;
    err.stdout = '';
    err.stderr = '';
    throw err;
  });
  return busy;
}

module.exports = { probeAnswersFromFixture };
