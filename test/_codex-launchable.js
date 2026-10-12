'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Where the stand-in Codex is "installed". Nothing exists there; the version probe is answered by a seam. */
const STAND_IN_CODEX_PATH = '/opt/fake/bin/codex';

/**
 * A stand-in Codex install for tests that launch a Codex session and are not
 * about Codex.
 *
 * A Codex launch starts only when TangleClaw can show it is kept off Codex's
 * shared background process (#2233), which needs a version probe that answers.
 * A test that stubs engine detection to a made-up path gets no answer from
 * that path, so its launch is refused. This answers the probe as an install
 * would, with a version that launches on the legacy `--no-daemon` path and is
 * NOT verified for the native channel, so no app-server is ever started; an
 * attempt to start or signal one is a loud failure, not a leaked process.
 *
 * @param {object} codexAdapter - `require('../lib/startup-control-codex')`.
 * @param {string} [version='0.157.1'] - What `codex --version` reports.
 * @returns {() => void} Restores the adapter's real seams and version cache.
 */
function standInCodex(codexAdapter, version = '0.157.1') {
  const realSeams = { ...codexAdapter._seams };
  const realVersion = { ...codexAdapter._internal._version };
  const output = `codex-cli ${version}\n`;
  codexAdapter._seams.execFileSync = () => output;
  codexAdapter._seams.execFile = (cmd, args, opts, cb) => cb(null, output);
  codexAdapter._seams.spawn = () => { throw new Error('booby trap: a test tried to start a real app-server'); };
  codexAdapter._seams.kill = () => { throw new Error('booby trap: a test tried to signal a real process'); };
  codexAdapter._internal._version.version = null;
  return () => {
    Object.assign(codexAdapter._seams, realSeams);
    Object.assign(codexAdapter._internal._version, realVersion);
  };
}

/**
 * An engine-detection stub for tests that launch several engines on made-up
 * installs. Codex resolves to an executable named `codex`, because a launch
 * identified as Codex whose executable has another name is refused as a
 * wrapper (#2233); every other engine resolves to `otherPath`.
 * @param {string} otherPath - The path every non-Codex engine resolves to.
 * @returns {(profile: object) => {available: boolean, path: string}}
 */
function detectWithCodex(otherPath) {
  return (profile) => ({ available: true, path: profile && profile.id === 'codex' ? STAND_IN_CODEX_PATH : otherPath });
}

/**
 * Two Codex installs on disk, for the case where the one TangleClaw detects is
 * not the one a shell finds first: a pane's rc files rebuild PATH, so a launch
 * that names `codex` instead of the path it checked can start another Codex
 * than the one whose version it read (#2230).
 *
 * Each install is a shell script named `codex` that prints its own version
 * whatever it is asked, so nothing here needs a Codex on the machine.
 *
 * @param {string} dir - An existing folder of the test's own; two folders are made in it.
 * @param {{detected: string, earlier: string}} versions - What each install's `--version` prints.
 * @returns {{detectedPath: string, earlierPath: string, panePath: string,
 *   probe: (bin: string, args: string[], opts: object) => string,
 *   versionThePaneRuns: (paneCommand: string) => string}}
 *   `probe` stands in for the adapter's `execFileSync` seam and really runs what
 *   it is given, resolving a bare name on the pane's PATH as the pane would.
 *   `versionThePaneRuns` runs the launch at the end of a pane command under
 *   that PATH and returns the version of the install that answered.
 */
function twoCodexInstalls(dir, versions) {
  const install = (folder, version) => {
    const bin = path.join(dir, folder, 'codex');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
    return bin;
  };
  const detectedPath = install('detected', versions.detected);
  const earlierPath = install('earlier-on-path', versions.earlier);
  const panePath = [path.dirname(earlierPath), path.dirname(detectedPath), '/usr/bin', '/bin'].join(':');
  const env = { PATH: panePath };
  return {
    detectedPath,
    earlierPath,
    panePath,
    probe: (bin, args, opts) => execFileSync(bin, args, { ...opts, env }),
    versionThePaneRuns: (paneCommand) => {
      // The launch is the last command of the pane's line; what precedes it
      // (the PATH floor, a credential reader) is not what this asks about.
      const launch = paneCommand.split('; ').pop();
      const out = execFileSync('/bin/sh', ['-c', launch], { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return out.trim().replace(/^codex-cli /, '');
    }
  };
}

module.exports = { standInCodex, detectWithCodex, twoCodexInstalls, STAND_IN_CODEX_PATH };
