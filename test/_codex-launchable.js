'use strict';

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

module.exports = { standInCodex };
