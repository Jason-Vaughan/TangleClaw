'use strict';

/*
 * Trust facts for tests that exercise the Codex loopback profile (#1957).
 *
 * The Codex adapter gathers its facts from the config and the installed ttyd
 * launchd job in the user's home. A test must never depend on this machine's
 * real job, so each test that reaches `loopbackLaunchCommand` states the facts
 * it means: `grantingFacts()` for an install where the profile may be applied,
 * or a variation of it that withholds.
 */

const codex = require('../lib/startup-control-codex');

const SOCKET = '/tmp/tc-test/run/ttyd.sock';

/**
 * Facts under which the guard grants the profile.
 * @returns {object}
 */
function grantingFacts() {
  return {
    config: { ingressMode: 'caddy', serviceTokenEnabled: true, serviceToken: 'tcsk_test' },
    ttydArgs: ['/opt/ttyd', '--writable', '--interface', SOCKET, '--port', '3100'],
    ttydSocketPath: SOCKET,
    machineClientRequiresServiceToken: true
  };
}

/**
 * Make the Codex adapter read these facts until the returned restore runs.
 * @param {object|(() => object)} facts - Facts, or a function returning them.
 * @returns {() => void} Restores the adapter's own fact source.
 */
function useTrustFacts(facts) {
  const source = codex._internal._trustSource;
  const real = source.facts;
  source.facts = typeof facts === 'function' ? facts : () => facts;
  return () => { source.facts = real; };
}

module.exports = { SOCKET, grantingFacts, useTrustFacts };
